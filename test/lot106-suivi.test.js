'use strict';

/**
 * Lot 106, R5 — la page « Suivi d'actions ».
 *
 * Les mêmes données que le bloc de l'accueil (les mêmes fonctions), pour le
 * SEUL compte connecté ; quatre filtres avec leur compte ; le filtre par
 * service, porté par l'adresse (`/suivi?service=`) ; les gestes existants. Le
 * titre du bloc de l'accueil y mène. Données inventées.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const applog = require('../server/applog');
const { AVEC_NAVIGATEUR, ouvrirCrabe, contraste, couleursDe, debordement, fermerNavigateur } = require('./lot106-commun');

let titulaire;
let voisine;

function installer(userId, id) {
  registry.install(userId, id);
  helpers.db.get().prepare(
    `UPDATE connector_installs SET status = 'installed', config_encrypted = ?, last_run_at = datetime('now', '-1 day')
      WHERE user_id = ? AND connector_id = ?`
  ).run(helpers.crypto.encrypt(JSON.stringify({ historique: 'depuis' })), userId, id);
}

function passage(userId, id, { succes, cause = null, documents = 0, il = '-1 hour' }) {
  helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, invoice_count, trigger, message, cause)
     VALUES (?, ?, datetime('now', ?), datetime('now', ?), ?, ?, 'cron', ?, ?)`
  ).run(id, userId, il, il, succes ? 1 : 0, documents, succes ? 'ok' : 'Échec inventé pour l\'essai', cause);
}

test.before(async () => {
  await helpers.setup();
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });

  // La titulaire : une réussite, une session expirée, une connexion refusée,
  // un échec, un service jamais configuré.
  for (const id of ['kubii', 'aagaard', 'fantazia', 'coco-papaya']) installer(titulaire.id, id);
  registry.install(titulaire.id, 'free');
  passage(titulaire.id, 'kubii', { succes: true, documents: 2, il: '-3 hours' });
  passage(titulaire.id, 'aagaard', { succes: false, cause: 'session-expiree', il: '-2 hours' });
  passage(titulaire.id, 'fantazia', { succes: false, cause: 'connexion-refusee', il: '-90 minutes' });
  passage(titulaire.id, 'coco-papaya', { succes: false, cause: 'echec', il: '-1 hour' });

  // La voisine : ses événements ne doivent JAMAIS paraître chez la titulaire.
  for (const id of ['amazon', 'ile-aux-epices']) installer(voisine.id, id);
  passage(voisine.id, 'amazon', { succes: false, cause: 'echec' });
  passage(voisine.id, 'ile-aux-epices', { succes: true, documents: 5 });

  // Un journal applicatif au nom de la titulaire : la page ne le lit pas.
  applog.error('scheduler', 'MARQUEUR-JOURNAL-APPLICATIF titulaire : ligne interne');
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

test('R5 — la route sert les données du bloc, pour le seul compte connecté ; rien du journal applicatif', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  assert.equal((await client.get('/api/home/suivi')).status, 401, 'il faut être connecté');
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  const r = await client.get('/api/home/suivi');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['copyFailures', 'errors', 'pendingActions', 'successes']);
  const ids = (cle) => r.body[cle].map((l) => l.connectorId).sort();
  assert.deepEqual(ids('errors'), ['aagaard', 'coco-papaya', 'fantazia']);
  assert.deepEqual(ids('pendingActions'), ['free']);
  assert.deepEqual(ids('successes'), ['kubii']);
  const brut = JSON.stringify(r.body);
  for (const autre of ['amazon', 'ile-aux-epices', 'voisine']) assert.equal(brut.includes(autre), false, `${autre} n'est pas chez la titulaire`);
  assert.equal(brut.includes('MARQUEUR-JOURNAL-APPLICATIF'), false);

  // Les mêmes lignes que le bloc de l'accueil (mêmes fonctions).
  const accueil = await client.get('/api/home');
  assert.deepEqual(r.body.errors, accueil.body.errors);
  assert.deepEqual(r.body.pendingActions, accueil.body.pendingActions);
  assert.deepEqual(r.body.successes.map((x) => x.connectorId), accueil.body.aJour);

  // Et la voisine ne voit que les siens.
  const autre = await helpers.startServer();
  t.after(() => autre.close());
  await helpers.login(autre, 'voisine', 'MotDePasse1');
  const rv = await autre.get('/api/home/suivi');
  assert.deepEqual(rv.body.errors.map((l) => l.connectorId), ['amazon']);
  assert.deepEqual(rv.body.successes.map((l) => l.connectorId), ['ile-aux-epices']);
  assert.equal(JSON.stringify(rv.body).includes('kubii'), false);
});

test('R5 — le bloc de l\'accueil s\'appelle « Suivi d\'actions »', () => {
  const home = require('../server/home');
  assert.equal(home.WIDGETS.find((w) => w.id === 'errors').title, 'Suivi d\'actions');
});

test('R5 — l\'adresse /suivi : la coque pour un compte connecté, l\'écran de connexion sinon', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const anonyme = await fetch(`${client.base}/suivi`, { redirect: 'manual' });
  assert.equal(anonyme.status, 302);
  assert.equal(anonyme.headers.get('location'), '/');
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  const r = await client.get('/suivi?service=kubii');
  assert.equal(r.status, 200);
  assert.match(typeof r.body === 'string' ? r.body : String(r.text || r.raw || ''), /id="view-suivi"/);
});

test('R5 — au vrai Chromium : le titre de l\'accueil y mène, quatre filtres comptés, le filtre par service dans l\'adresse, les gestes existants', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);

  // Le titre du bloc : « Suivi d'actions → », un vrai lien.
  const lien = page.locator('[data-widget="errors"] a.w-title-lien');
  assert.equal(await lien.getAttribute('href'), '/suivi');
  assert.equal((await lien.textContent()).replace(/\s+/g, ' ').trim(), 'Suivi d\'actions →');
  await lien.click();
  await page.waitForSelector('#view-suivi.active #suivi-liste .err-item');
  assert.equal(new URL(page.url()).pathname, '/suivi');

  const filtres = () => page.$$eval('#suivi-filtres button', (l) => l.map((b) => [b.innerText.trim(), b.getAttribute('aria-pressed')]));
  assert.deepEqual(await filtres(), [['Tout (5)', 'true'], ['Échecs (2)', 'false'], ['Sessions expirées (1)', 'false'], ['À jour (1)', 'false']]);
  const lignes = () => page.$$eval('#suivi-liste .err-item', (l) => l.map((e) => `${e.className.replace('err-item ', '')}:${e.querySelector('.err-name').textContent}`));
  assert.deepEqual(await lignes(), ['refus:Fantazia', 'erreur:Coco Papaya', 'session:Aagaard', 'configurer:Free Internet', 'succes:Kubii']);

  await page.click('#suivi-filtres button:nth-child(2)');
  assert.deepEqual(await lignes(), ['refus:Fantazia', 'erreur:Coco Papaya']);
  await page.click('#suivi-filtres button:nth-child(3)');
  assert.deepEqual(await lignes(), ['session:Aagaard']);
  assert.match(await page.innerText('#suivi-liste'), /Se reconnecter/);
  await page.click('#suivi-filtres button:nth-child(4)');
  assert.deepEqual(await lignes(), ['succes:Kubii']);
  assert.match(await page.innerText('#suivi-liste'), /2 nouveau\(x\) document\(s\) récupéré\(s\)\./);

  // Le filtre par service, dans l'adresse.
  await page.click('#suivi-filtres button:nth-child(1)');
  await page.selectOption('#suivi-service', 'coco-papaya');
  assert.equal(new URL(page.url()).search, '?service=coco-papaya');
  assert.deepEqual(await lignes(), ['erreur:Coco Papaya']);
  assert.match(await page.innerText('#suivi-liste'), /Réessayer/);
  assert.equal((await page.innerText('#suivi-filtre-actif')).replace(/\s+/g, ' ').trim(), 'Filtré sur Coco Papaya ✕');
  assert.deepEqual(await filtres(), [['Tout (1)', 'true'], ['Échecs (1)', 'false'], ['Sessions expirées (0)', 'false'], ['À jour (0)', 'false']]);
  await page.click('#suivi-filtre-actif button[aria-label="Retirer le filtre"]');
  assert.equal(new URL(page.url()).search, '');
  assert.equal((await lignes()).length, 5);

  // Les services de la voisine ne sont nulle part.
  const options = await page.$$eval('#suivi-service option', (l) => l.map((o) => o.textContent));
  assert.deepEqual(options, ['Tous les services', 'Aagaard', 'Coco Papaya', 'Fantazia', 'Free Internet', 'Kubii']);
  assert.doesNotMatch(await page.innerText('#view-suivi'), /Amazon|Île aux Épices/);

  // Quitter la page rend l'adresse de la coque.
  await page.click('.tb-logo');
  assert.equal(new URL(page.url()).pathname, '/');
  assert.deepEqual(erreursJs, []);
});

test('R5 — par l\'adresse directe, filtre compris ; une valeur de filtre douteuse est ignorée', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const direct = await ouvrirCrabe(client, 'titulaire', { chemin: '/suivi?service=aagaard' });
  t.after(direct.fermer);
  await direct.page.waitForSelector('#view-suivi.active #suivi-liste .err-item');
  assert.equal(await direct.page.$eval('#suivi-service', (s) => s.value), 'aagaard');
  assert.deepEqual(await direct.page.$$eval('#suivi-liste .err-name', (l) => l.map((e) => e.textContent)), ['Aagaard']);

  const douteux = await ouvrirCrabe(client, 'titulaire', { chemin: '/suivi?service=%3Cscript%3E' });
  t.after(douteux.fermer);
  await douteux.page.waitForSelector('#view-suivi.active #suivi-liste .err-item');
  assert.equal(await douteux.page.$eval('#suivi-service', (s) => s.value), '');
  assert.equal(await douteux.page.$$eval('#suivi-liste .err-item', (l) => l.length), 5);
  assert.equal(new URL(douteux.page.url()).search, '');
  assert.deepEqual(direct.erreursJs.concat(douteux.erreursJs), []);
});

for (const clair of [false, true]) {
  test(`R6 — la page sur téléphone (390 px), thème ${clair ? 'clair' : 'sombre'} : rien ne déborde, tout se lit`, AVEC_NAVIGATEUR, async (t) => {
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 390, hauteur: 844, clair, chemin: '/suivi' });
    t.after(fermer);
    await page.waitForSelector('#view-suivi.active #suivi-liste .err-item');
    const d = await debordement(page);
    assert.ok(d.scroll <= d.largeur, `aucun débordement : ${d.fautifs.join(' ; ')}`);
    for (const sel of ['.err-item.refus .err-msg', '.err-item.session .err-msg', '.err-item.succes .err-msg', '.err-item.succes .err-date', '.err-item .err-name', '#suivi-filtres button:nth-child(2)', '#suivi-filtres button.active']) {
      const { texte, fond } = await couleursDe(page, sel);
      assert.ok(contraste(texte, fond) >= 4.5, `${sel} : ${contraste(texte, fond).toFixed(2)}`);
    }
    assert.deepEqual(erreursJs, []);
  });
}
