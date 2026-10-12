'use strict';

/**
 * Lot 106, R4 — « Ouvrir le dossier ».
 *
 * Mesuré au lot 106 : aucune destination n'a d'adresse web de dossier
 * déductible de façon sûre — le bouton copie donc le chemin partout, et le
 * dit (« Copier le chemin », puis « Chemin copié »). La racine (réglage de
 * l'administration) n'est montrée qu'à qui gère le stockage ; aucun secret
 * n'entre dans un chemin ; aucune adresse n'est inventée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const registry = require('../server/connectors/registry');
const destinations = require('../server/destinations');
const dossier = require('../server/destinations/dossier');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

// Le stockage local des essais, nommé en un seul endroit (comme au lot 98).
const LOCAL = 'local';
const RACINE_LOCALE = process.env.CRABE_LOCAL_PATH;
const JETON = 'JETON-INVENTE-0000-AAAA';
let titulaire;
let gerante;
let cloud;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(RACINE_LOCALE, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, gerante.id);
  gerante = helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(gerante.id);
  // Un cloud dont le bloc porte un « secret » inventé : il ne doit apparaître
  // dans aucun chemin, aucune réponse.
  cloud = helpers.creerCloud({ rcloneConfig: `type = pcloud\ntoken = ${JETON}` });
  registry.install(titulaire.id, 'free');
  const ins = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, destinations)
     VALUES (?, 'free', ?, 'defaut', 1024, '2026-09-01', ?)`
  );
  ins.run(titulaire.id, 'essai-1.pdf', JSON.stringify({ [LOCAL]: { state: 'ok' }, [cloud]: { state: 'ok' } }));
  ins.run(titulaire.id, 'essai-2.pdf', JSON.stringify({ [LOCAL]: { state: 'ok' }, [cloud]: { state: 'error', message: 'refusé' } }));
  ins.run(titulaire.id, 'essai-3.pdf', JSON.stringify({ [LOCAL]: { state: 'ok' } }));
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

test('R4 — le chemin : depuis le dossier de crabe pour un compte ordinaire, depuis la racine pour qui gère le stockage', () => {
  assert.equal(dossier.voitLaRacine(titulaire), false);
  assert.equal(dossier.voitLaRacine(gerante), true);

  assert.deepEqual(dossier.dossierDe(LOCAL, { user: titulaire }), { chemin: 'titulaire', depuisLaRacine: false, adresse: null });
  assert.deepEqual(dossier.dossierDe(LOCAL, { user: titulaire, connectorName: 'Free Mobile' }),
    { chemin: 'titulaire/Free Mobile', depuisLaRacine: false, adresse: null });
  assert.deepEqual(dossier.dossierDe(cloud, { user: titulaire, connectorName: 'Free' }),
    { chemin: 'titulaire/Free', depuisLaRacine: false, adresse: null });

  assert.deepEqual(dossier.dossierDe(LOCAL, { user: gerante, connectorName: 'Free' }),
    { chemin: `${RACINE_LOCALE.replace(/\/+$/, '')}/gerante/Free`, depuisLaRacine: true, adresse: null });
  assert.deepEqual(dossier.dossierDe(cloud, { user: gerante }), { chemin: 'crabe/gerante', depuisLaRacine: true, adresse: null });

  // Un nom de service ou de compte ne fait jamais sortir du dossier.
  assert.equal(dossier.dossierDe(LOCAL, { user: { ...titulaire, username: '../x' }, connectorName: 'a/../b' }).chemin.includes('..'), false);
});

test('R4 — aucune adresse n\'est inventée, pour aucun type de destination ; aucun secret dans un chemin', () => {
  const crees = ['pcloud', 'proton', 'mega', 'kdrive', 's3', 'autre'].map((provider) => {
    try {
      return destinations.createCloud({ provider, displayName: `Essai ${provider}` }).id;
    } catch {
      return null;
    }
  }).filter(Boolean);
  assert.ok(crees.length >= 2, `au moins deux types créés (${crees.length})`);
  for (const id of [LOCAL, cloud, ...crees]) {
    for (const user of [titulaire, gerante]) {
      const d = dossier.dossierDe(id, { user, connectorName: 'Free' });
      assert.equal(d.adresse, null, `${id} : pas d'adresse`);
      assert.doesNotMatch(d.chemin, new RegExp(JETON));
      assert.doesNotMatch(d.chemin, /:\/\//, 'jamais une adresse déguisée en chemin');
    }
  }
  for (const id of crees) destinations.deleteCloud(id);
});

test('R4 — l\'accueil sert le dossier de chaque destination ; un compte ordinaire n\'y lit jamais la racine', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  const r = await client.get('/api/home');
  assert.equal(r.status, 200);
  const cartes = r.body.destinations;
  assert.ok(cartes.length >= 2);
  for (const c of cartes) assert.deepEqual(c.dossier, { chemin: 'titulaire', depuisLaRacine: false, adresse: null });
  const brut = JSON.stringify(r.body);
  assert.equal(brut.includes(RACINE_LOCALE), false, 'la racine du serveur ne descend pas à un compte ordinaire');
  assert.equal(brut.includes(JETON), false);

  const admin = await helpers.startServer();
  t.after(() => admin.close());
  await helpers.login(admin, 'gerante', 'MotDePasse1');
  const ra = await admin.get('/api/home');
  const locale = ra.body.destinations.find((c) => c.id === LOCAL);
  assert.equal(locale.dossier.chemin, `${RACINE_LOCALE.replace(/\/+$/, '')}/gerante`);
  assert.equal(locale.dossier.depuisLaRacine, true);
});

test('R4 — la fiche d\'un service installé sert ses destinations : dossier du service et état des copies', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  const r = await client.get('/api/connectors/free');
  assert.equal(r.status, 200);
  const parId = Object.fromEntries(r.body.destinations.map((d) => [d.id, d]));
  assert.deepEqual(
    { chemin: parId[LOCAL].dossier.chemin, documents: parId[LOCAL].documents, copies: parId[LOCAL].copies, enAttente: parId[LOCAL].enAttente, enEchec: parId[LOCAL].enEchec },
    { chemin: 'titulaire/Free Internet', documents: 3, copies: 3, enAttente: 0, enEchec: 0 }
  );
  assert.deepEqual(
    { copies: parId[cloud].copies, enAttente: parId[cloud].enAttente, enEchec: parId[cloud].enEchec },
    { copies: 1, enAttente: 1, enEchec: 1 }
  );
  assert.equal(JSON.stringify(r.body).includes(JETON), false);
  // Un service non installé n'a pas de destinations à montrer.
  const autre = await client.get('/api/connectors/kubii');
  assert.deepEqual(autre.body.destinations, []);
});

for (const sur of [true, false]) {
  test(`R4 — au vrai Chromium, ${sur ? 'contexte sûr (presse-papiers du navigateur)' : 'HTTP simple (repli par sélection)'} : « Copier le chemin » copie, et le dit`, AVEC_NAVIGATEUR, async (t) => {
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
    t.after(fermer);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: client.base });
    if (!sur) {
      // Une instance servie en HTTP simple (sans certificat) : le navigateur
      // n'y offre pas `navigator.clipboard` en écriture. On le reproduit.
      await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }));
    }
    await page.waitForSelector('.dest-card-home .btn-dossier');
    const libelles = await page.$$eval('.dest-card-home .btn-dossier', (l) => l.map((b) => [b.tagName, b.innerText.trim()]));
    assert.ok(libelles.length >= 2);
    for (const [balise, texte] of libelles) assert.deepEqual([balise, texte], ['BUTTON', 'Copier le chemin']);

    await page.evaluate(() => navigator.clipboard.writeText('rien'));
    const bouton = page.locator('.dest-card-home .btn-dossier').first();
    await bouton.click();
    await page.waitForFunction(() => /^Chemin copié \(depuis le dossier de crabe sur .+\) : titulaire$/.test(document.getElementById('toast').textContent));
    assert.equal((await bouton.innerText()).trim(), 'Chemin copié');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'titulaire');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('btn-dossier')), true, 'le focus reste sur le bouton');
    assert.deepEqual(erreursJs, []);
  });
}

test('R4 — une adresse https ouvrirait le dossier dans un nouvel onglet, sans référent ; toute autre adresse est ignorée', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  const rendu = (adresse) => page.evaluate((a) => boutonDossier({ id: 'essai', name: 'Essai', dossier: { chemin: 'titulaire', depuisLaRacine: false, adresse: a } }), adresse);
  assert.match(await rendu('https://exemple.invalid/dossier'),
    /^<a class="dest-test btn-dossier" href="https:\/\/exemple\.invalid\/dossier" target="_blank" rel="noopener noreferrer">.*Ouvrir le dossier<\/a>$/s);
  for (const autre of ['javascript:alert(1)', 'file:///mnt', 'http://exemple.invalid', null]) {
    assert.match(await rendu(autre), /^<button type="button" class="dest-test btn-dossier"[\s\S]*Copier le chemin<\/button>$/);
  }
});

for (const clair of [false, true]) {
  test(`R6 — le bouton du dossier se lit, thème ${clair ? 'clair' : 'sombre'}, et ne fait rien déborder à 390 px`, AVEC_NAVIGATEUR, async (t) => {
    const { contraste, couleursDe, debordement } = require('./lot106-commun');
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 390, hauteur: 844, clair });
    t.after(fermer);
    await page.waitForSelector('.dest-card-home .btn-dossier');
    const { texte, fond } = await couleursDe(page, '.dest-card-home .btn-dossier');
    assert.ok(contraste(texte, fond) >= 4.5, `contraste ${contraste(texte, fond).toFixed(2)}`);
    const d = await debordement(page);
    assert.ok(d.scroll <= d.largeur, d.fautifs.join(' ; '));
  });
}
