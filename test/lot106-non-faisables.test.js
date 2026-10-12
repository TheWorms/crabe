'use strict';

/**
 * Lot 106, R10 — dix connecteurs écrits passent « Non faisables ».
 *
 * EDF, Engie, Mint Énergie, SEPIG, Bouygues Telecom, Orange, SFR, Scaleway,
 * Vinted, Qobuz (décision du 12/10/2026). Le mécanisme est celui du lot 103,
 * le champ `unfeasible`, étendu à leur manifeste seulement : aucun
 * `connector.js` ne change, le code reste — retirer le champ suffit à les
 * ressusciter. Effets : Store (groupe « Non faisables », aucun « Installer »,
 * comptes), refus du serveur par chaque porte, aucun ordonnancement, page
 * publique. Atlantic'eau et Electro Dépôt restent installables.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const schema = require('../server/connectors/manifest-schema');
const { config } = require('../server/config');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

const RACINE = path.join(__dirname, '..');
const DIX = ['edf', 'engie', 'mint-energie', 'sepig', 'bouygues', 'orange', 'sfr', 'scaleway', 'vinted', 'qobuz'];
const TEMOINS = ['atlanticeau', 'electro-depot'];
const RAISON_EDF = 'Le site d\'EDF refuse les connexions faites par un programme (mesuré le 18 août 2026).';
const RAISON = 'Pas exploitable aujourd\'hui : aucun essai sur un vrai compte n\'a abouti. Si cela change, le service reviendra.';
const raisonDe = (id) => (id === 'edf' ? RAISON_EDF : RAISON);
const manifesteSurDisque = (id) =>
  JSON.parse(fs.readFileSync(path.join(RACINE, 'server', 'connectors', 'available', id, 'manifest.json'), 'utf8'));

let gerante;

test.before(async () => {
  await helpers.setup();
  gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, gerante.id);
  await helpers.createUser({ username: 'titulaire' });
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

test('R10 — les dix manifestes portent leur raison, les deux témoins non ; le registre chargé la garde', () => {
  for (const id of DIX) {
    assert.equal(manifesteSurDisque(id).unfeasible, raisonDe(id), `${id} : sur le disque`);
    assert.equal(registry.manifest(id).unfeasible, raisonDe(id), `${id} : chargé`);
    assert.equal(registry.isPlanned(id), false, `${id} : toujours un connecteur écrit`);
    assert.ok(fs.existsSync(path.join(RACINE, 'server', 'connectors', 'available', id, 'connector.js')), `${id} : son code reste`);
    assert.equal(registry.nonFaisable(id), raisonDe(id));
  }
  for (const id of TEMOINS) {
    assert.equal(manifesteSurDisque(id).unfeasible, undefined, id);
    assert.equal(registry.nonFaisable(id), '', id);
  }
  // Une phrase, en français, sans jargon, et pas plus longue que le lot 36 ne
  // le permet ; aucune cause technique inventée.
  for (const raison of [RAISON_EDF, RAISON]) {
    assert.ok(raison.length <= 220);
    assert.doesNotMatch(raison, /DataDome|reCAPTCHA|captcha|DSP2|anti-?robot|Cloudflare|HTTP|API/i);
  }
  // Le validateur l'admet désormais sur un connecteur écrit.
  const { ok, errors } = schema.validate(manifesteSurDisque('edf'), 'edf');
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('R10 — le Store : les dix n\'y sont plus, ni « disponibles » ni « pas encore testés » (lot 108, modifié par décision)', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'gerante', 'MotDePasse1');
  const { body } = await client.get('/api/connectors');
  const par = Object.fromEntries(body.connectors.map((c) => [c.id, c]));
  // Lot 108 : les non faisables ont quitté le logiciel — le serveur ne les
  // envoie plus (aucun n'est installé ici), ni leur compte.
  for (const id of DIX) assert.equal(par[id], undefined, id);
  const empeche = (c) => !!String(c.unfeasible || '').trim();
  assert.equal('unfeasible' in body.counts, false, 'plus de compte des non faisables');
  assert.equal(body.connectors.filter(empeche).length, 0);
  assert.equal(body.counts.aVenir, 17);
  assert.equal(body.counts.available, body.connectors.filter((c) => !c.planned && !empeche(c) && c.catalogStatus !== 'pending').length);
  assert.equal(body.counts.pending, body.connectors.filter((c) => !c.planned && !empeche(c) && c.catalogStatus === 'pending').length);
  for (const id of TEMOINS) assert.equal(empeche(par[id]), false, id);
});

/** Chaque porte d'un connecteur, et le geste que son refus nomme. */
const PORTES = (id) => [
  ['post', `/api/connectors/${id}/install`, 'installé'],
  ['put', `/api/connectors/${id}/config`, 'configuré', { config: {} }],
  ['post', `/api/connectors/${id}/test`, 'testé'],
  ['post', `/api/connectors/${id}/discover`, 'exploré'],
  ['post', `/api/connectors/${id}/run`, 'exécuté'],
  ['post', `/api/connectors/${id}/run-historique-complet`, 'exécuté'],
  ['post', `/api/connectors/${id}/remote-login`, 'connecté'],
  ['post', `/api/admin/connectors/${id}/run-all`, 'exécuté'],
  ['post', `/api/admin/connectors/${id}/test`, 'testé'],
];

test('R10, D4 — le serveur refuse chacun des dix par chaque porte, avec sa raison ; rien n\'est créé', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'gerante', 'MotDePasse1');
  for (const id of DIX) {
    const nom = registry.manifest(id).name;
    for (const [methode, chemin, geste, corps] of PORTES(id)) {
      const r = await client[methode](chemin, corps);
      assert.equal(r.status, 409, `${chemin} : refusé (${r.status})`);
      assert.equal(r.body.error, `« ${nom} » ne peut pas être ${geste} : ${raisonDe(id)}`, chemin);
    }
  }
  const marques = DIX.map(() => '?').join(', ');
  for (const table of ['connector_installs', 'user_connector_schedules', 'connector_discoveries', 'run_logs', 'run_queue', 'connexions_enregistrees']) {
    assert.equal(helpers.db.get().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id IN (${marques})`).get(...DIX).n, 0,
      `${table} : rien n'a été créé`);
  }
});

test('R10 — Atlantic\'eau et Electro Dépôt restent installables ; la désinstallation d\'un non faisable reste permise', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'gerante', 'MotDePasse1');
  for (const id of TEMOINS) {
    const pose = await client.post(`/api/connectors/${id}/install`);
    assert.equal(pose.status, 200, `${id} : ${JSON.stringify(pose.body)}`);
    assert.equal((await client.delete(`/api/connectors/${id}`)).status, 200);
  }
  // Une installation d'AVANT la décision (base d'une autre instance) : elle
  // se retire, et ses permissions se lisent ; rien ne la fait travailler.
  registry.install(gerante.id, 'qobuz');
  assert.equal((await client.get('/api/connectors/qobuz/permissions')).status, 200);
  const retrait = await client.delete('/api/connectors/qobuz');
  assert.equal(retrait.status, 200);
  assert.equal(registry.getInstall(gerante.id, 'qobuz') ?? null, null);
});

test('R10 — aucun ordonnancement ne les lance : ni tâche armée, ni « pour tous », ni lancement groupé', async (t) => {
  const initial = config.schedulerDisabled;
  config.schedulerDisabled = false;
  t.after(() => {
    scheduler.stopAll();
    config.schedulerDisabled = initial;
    for (const id of ['orange', 'kubii']) registry.uninstall(gerante.id, id);
  });
  // Une installation configurée d'avant la décision, et un témoin faisable.
  for (const id of ['orange', 'kubii']) {
    registry.install(gerante.id, id);
    helpers.db.get().prepare(
      "UPDATE connector_installs SET status = 'installed', config_encrypted = ? WHERE user_id = ? AND connector_id = ?"
    ).run(helpers.crypto.encrypt(JSON.stringify({ historique: 'depuis' })), gerante.id, id);
  }
  const etat = scheduler.reload();
  assert.equal(etat.scheduled, 1, `seul le témoin est armé : ${etat.details.join(' ; ')}`);
  assert.match(etat.details[0], /^kubii /);
  assert.deepEqual(await scheduler.runForAllUsers('orange', 'cron'), []);

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'gerante', 'MotDePasse1');
  const groupe = await client.post('/api/admin/schedules/run', { targets: [{ userId: gerante.id, connectorId: 'orange' }] });
  assert.equal(groupe.status, 200);
  assert.equal(groupe.body.results[0].ok, false);
  assert.equal(groupe.body.results[0].skipped, true);
  assert.equal(groupe.body.results[0].message, `« Orange » ne peut pas être exécuté : ${RAISON}`);
  assert.equal(helpers.db.get().prepare("SELECT COUNT(*) AS n FROM run_logs WHERE connector_id = 'orange'").get().n, 0);
});

test('R10 — la page publique : les dix parmi les « Non faisables » avec leur raison, deux « En attente », 88 services', () => {
  const page = fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8');
  const section = (titre) => page.split(new RegExp(`^## ${titre} \\(\\d+\\)$`, 'm'))[1].split(/^## /m)[0];
  for (const id of DIX) {
    const nom = registry.manifest(id).name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(section('Non faisables'), new RegExp(`\\| ${nom} \\| [^|]+ \\| ${raisonDe(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`), id);
    assert.doesNotMatch(section('En attente'), new RegExp(`icones/${id}\\.png`), id);
  }
  assert.deepEqual([...section('En attente').matchAll(/icones\/([a-z0-9-]+)\.png/g)].map((m) => m[1]), ['atlanticeau', 'electro-depot']);
  const comptes = Object.fromEntries([...page.matchAll(/^## (.+) \((\d+)\)$/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(comptes, { Fonctionnels: 48, 'En cours': 3, 'En attente': 2, 'Non faisables': 18, Proposés: 17 });
  assert.equal(Object.values(comptes).reduce((a, b) => a + b, 0), 88);
});

test('R10 — au vrai Chromium (administratrice) : les dix ne sont plus dans le Store (lot 108, modifié par décision) ; les témoins s\'installent', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante');
  t.after(fermer);
  await page.evaluate(() => showView('store'));
  await page.waitForSelector('#store-grid .card');
  assert.equal(await page.locator('#store-grid .cat-title', { hasText: /Non faisables/ }).count(), 0);
  const noms = (await page.locator('#store-grid .card-name').allTextContents()).map((n) => n.trim());
  for (const id of DIX) assert.equal(noms.includes(registry.manifest(id).name), false, id);
  for (const id of TEMOINS) {
    const tuile = page.locator('#store-grid .card', { has: page.locator('.card-name', { hasText: registry.manifest(id).name }) });
    assert.equal(await tuile.locator('.install-btn').count(), 1, `${id} : « Installer »`);
  }
  const sousTitre = (await page.textContent('#store-count')).trim();
  assert.match(sousTitre, /, 17 à venir$/);
  // « Seulement les services disponibles » les écarte.
  await page.check('#store-available-only');
  assert.equal(await page.locator('#store-grid .card.unfeasible').count(), 0);
  await page.uncheck('#store-available-only');
  assert.deepEqual(erreursJs, []);
});
