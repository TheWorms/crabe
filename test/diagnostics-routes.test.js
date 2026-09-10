'use strict';

/**
 * §4 du lot 14 — l'archive de diagnostic, réellement produite et ouverte.
 *
 * La preuve exigée par le §11 : « une archive réellement produite, ouverte,
 * contenant les quatre fichiers, sans aucun secret ». Ce fichier la fabrique
 * par la vraie route HTTP, la décompresse, et lit ce qu'il y a dedans.
 *
 * Le second contrôle compte autant que le premier : **un compte ordinaire ne
 * doit rien atteindre**. Ni la liste, ni l'archive, ni l'information qu'il en
 * existe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-diag-routes-'));
process.env.CRABE_DIAGNOSTICS_DIR = RACINE;

const helpers = require('./helpers');
const diagnostics = require('../server/diagnostics');

const CONNECTEUR = 'propolia';
const MOT_DE_PASSE = 'MonMotDePasse!42';
const VALEUR_COOKIE = 'valeur-de-session-ultra-secrete';

let admin;
let client;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({ username: 'camille', role: 'admin', plainPassword: 'MotDePasse1' });
  client = await helpers.startServer();
  await helpers.login(client, 'camille', 'MotDePasse1');

  // Un diagnostic réaliste : le HTML d'un formulaire de connexion PrestaShop,
  // avec tout ce qui ne doit PAS ressortir.
  await diagnostics.enregistrer({
    connectorId: CONNECTEUR,
    etape: 'connexion non confirmée',
    erreur: 'aucun marqueur de compte',
    page: {
      url: () => 'https://propolia.com/fr/connexion?back=history',
      content: async () =>
        '<html><body><form id="login-form">'
        + '<input type="email" name="email" value="camille@example.fr">'
        + `<input type="password" name="passwd" value="${MOT_DE_PASSE}">`
        + '<input type="hidden" name="token" value="7f3a91ccdeadbeef">'
        + '<button name="submitLogin">Se connecter</button>'
        + '</form></body></html>',
      evaluate: async () => [
        'https://propolia.com/fr/historique-commandes',
        'https://propolia.com/fr/mon-compte',
      ],
      screenshot: async ({ path: fichier }) => fs.writeFileSync(fichier, 'PNG-simulé'),
    },
    context: {
      cookies: async () => [
        { name: 'PHPSESSID', value: VALEUR_COOKIE, domain: 'propolia.com' },
        { name: 'didomi_token', value: 'jeton-de-consentement', domain: 'propolia.com' },
      ],
    },
  });
});

test.after(() => {
  client?.close();
  helpers.teardown();
  fs.rmSync(RACINE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// La liste
// ---------------------------------------------------------------------------

test('l\'administration voit les diagnostics du service, et leurs limites', async () => {
  const res = await client.get(`/api/admin/connectors/${CONNECTEUR}/diagnostics`);

  assert.equal(res.status, 200);
  assert.equal(res.body.connector.name, 'Propolia');
  assert.equal(res.body.diagnostics.length, 1);
  assert.deepEqual(res.body.diagnostics[0].fichiers.sort(), [
    'contexte.txt', 'liens.txt', 'page.html', 'page.png',
  ]);
  // Les bornes sont dites une fois, plutôt que répétées à l'écran.
  assert.equal(res.body.limits.maxParConnecteur, 20);
  assert.equal(res.body.limits.maxJours, 30);
});

// ---------------------------------------------------------------------------
// L'archive — la preuve du §11
// ---------------------------------------------------------------------------

test('l\'archive est réellement produite, s\'ouvre, et porte les quatre fichiers', async () => {
  const liste = await client.get(`/api/admin/connectors/${CONNECTEUR}/diagnostics`);
  const id = liste.body.diagnostics[0].id;

  const res = await client.get(
    `/api/admin/connectors/${CONNECTEUR}/diagnostics/${id}/archive`,
    { raw: true }
  );

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /zip/);
  assert.match(res.headers['content-disposition'], /attachment; filename="diagnostic-propolia-/);

  // Écrite sur le disque puis OUVERTE : une archive qu'on ne décompresse pas
  // ne prouve rien — c'est exactement l'erreur que ce lot corrige ailleurs.
  const fichier = path.join(RACINE, 'archive.zip');
  fs.writeFileSync(fichier, res.buffer);
  assert.ok(fs.statSync(fichier).size > 200, 'une archive vide n\'est pas une archive');

  const dedans = path.join(RACINE, 'ouverte');
  fs.mkdirSync(dedans, { recursive: true });
  execFileSync('unzip', ['-o', '-q', fichier, '-d', dedans]);

  const presents = fs.readdirSync(dedans).sort();
  assert.deepEqual(presents, [
    'LISEZ-MOI.txt', 'contexte.txt', 'liens.txt', 'page.html', 'page.png',
  ].sort());

  const lu = (nom) => fs.readFileSync(path.join(dedans, nom), 'utf8');

  // --- contexte.txt : ce qui permet de comprendre l'échec ------------------
  const contexte = lu('contexte.txt');
  assert.match(contexte, /connecteur   : propolia/);
  assert.match(contexte, /étape        : connexion non confirmée/);
  assert.match(contexte, /URL finale   : https:\/\/propolia\.com\/fr\/connexion/);
  assert.match(contexte, /erreur       : aucun marqueur de compte/);
  assert.match(contexte, /PHPSESSID, didomi_token/, 'les NOMS des cookies, pour situer la session');

  // --- liens.txt : un lien par ligne ---------------------------------------
  assert.deepEqual(lu('liens.txt').trim().split('\n'), [
    'https://propolia.com/fr/historique-commandes',
    'https://propolia.com/fr/mon-compte',
  ]);

  // --- page.html : la page, sans les secrets --------------------------------
  const html = lu('page.html');
  assert.match(html, /id="login-form"/, 'la structure du formulaire doit rester lisible');
  assert.match(html, /type="password"/, 'la présence du champ compte, pas sa valeur');
  assert.match(html, /camille@example\.fr/, 'l\'identifiant n\'est pas un secret et diagnostique');

  // --- LE contrôle qui compte : AUCUN secret, nulle part --------------------
  const tout = presents.map((f) => (f === 'page.png' ? '' : lu(f))).join('\n');
  for (const secret of [MOT_DE_PASSE, VALEUR_COOKIE, '7f3a91ccdeadbeef', 'jeton-de-consentement']) {
    assert.equal(
      tout.includes(secret),
      false,
      `« ${secret} » ne doit apparaître dans AUCUN fichier de l'archive`
    );
  }

  // Et le LISEZ-MOI le dit, pour qui reçoit l'archive sans avoir lu le code.
  assert.match(lu('LISEZ-MOI.txt'), /AUCUN mot de passe, AUCUNE valeur de cookie/);
});

test('un diagnostic inventé rend 404, sans révéler ce qui existe', async () => {
  for (const id of ['2020-01-01T00-00-00-000Z', '../../etc/passwd', 'nimporte-quoi']) {
    const res = await client.get(
      `/api/admin/connectors/${CONNECTEUR}/diagnostics/${encodeURIComponent(id)}/archive`
    );
    assert.equal(res.status, 404, id);
  }
});

// ---------------------------------------------------------------------------
// Réservé à l'administration
// ---------------------------------------------------------------------------

test('un compte ordinaire n\'atteint ni la liste, ni l\'archive', async () => {
  await helpers.createUser({ username: 'simple', plainPassword: 'MotDePasse1' });
  const ordinaire = await helpers.startServer();
  try {
    await helpers.login(ordinaire, 'simple', 'MotDePasse1');

    const liste = await ordinaire.get(`/api/admin/connectors/${CONNECTEUR}/diagnostics`);
    assert.equal(liste.status, 403, 'la liste est réservée à l\'administration');

    const archive = await ordinaire.get(
      `/api/admin/connectors/${CONNECTEUR}/diagnostics/x/archive`
    );
    assert.equal(archive.status, 403);

    // Et rien de ce qu'il reçoit ailleurs ne mentionne un diagnostic.
    const fiche = await ordinaire.get(`/api/connectors/${CONNECTEUR}`);
    assert.equal(
      JSON.stringify(fiche.body).toLowerCase().includes('diagnostic'),
      false,
      'un compte ordinaire ne doit pas même savoir qu\'il en existe'
    );
  } finally {
    ordinaire.close();
  }
});

test('« Tout effacer » vide le service, et ne touche qu\'à lui', async () => {
  await diagnostics.enregistrer({ connectorId: 'kubii', etape: 'essai' });
  assert.equal(diagnostics.lister('kubii').length, 1);

  const res = await client.delete(`/api/admin/connectors/${CONNECTEUR}/diagnostics`);
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 1);

  assert.equal(diagnostics.lister(CONNECTEUR).length, 0);
  assert.equal(diagnostics.lister('kubii').length, 1, 'le voisin n\'est pas touché');
});
