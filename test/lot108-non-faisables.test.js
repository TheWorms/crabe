'use strict';

/**
 * Lot 108, R6 — les connecteurs « Non faisables » quittent le logiciel.
 *
 * Décision du 12/10/2026 : les dix-huit services qui portent `unfeasible`
 * (huit annonces du lot 103, dix connecteurs écrits du lot 106) restent dans
 * le dépôt et sur la page publique, mais crabe ne les montre plus nulle part :
 * ni le Store (groupe, tuile, recherche, compte, sous-titre), ni la fiche, ni
 * le catalogue d'administration, ni les logos, ni le compte de Système, ni les
 * traces de l'accueil. Le filtre est CÔTÉ SERVEUR : le navigateur ne les reçoit
 * plus. Seule exception : celui qu'un compte a installé avant reste visible
 * pour CE compte, dans « Mes connecteurs ». Les gardes du lot 106 restent :
 * installation refusée, avec la raison.
 *
 * Aucune donnée réelle : comptes nommés par leur rôle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const registry = require('../server/connectors/registry');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

const PAGE = path.join(__dirname, '..', 'docs', 'CONNECTEURS.md');
/** L'empreinte de la page publique relevée AVANT le lot (`5c7882b`) : elle ne bouge pas. */
const EMPREINTE_PAGE = '4e30635ab0afe797bd981527a21f8bb5288661c6c29ddd16929c2160a097800a';
/** Le service non faisable qu'un compte a installé avant (l'exception). */
const INSTALLE = 'engie';

const empeche = (c) => !!String(c?.unfeasible || '').trim();
let NON_FAISABLES = [];
let titulaire;
let voisine;
/** Le serveur d'essai de l'essai au navigateur. */
let serveur = null;
const client0 = () => serveur;

test.before(async () => {
  await helpers.setup();
  NON_FAISABLES = registry.listAll().filter(empeche);
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });
  // Une installation d'AVANT (le lot 106 refuse d'en créer) : posée en base.
  helpers.db.get().prepare("INSERT INTO connector_installs (user_id, connector_id, status) VALUES (?, ?, 'installed')")
    .run(titulaire.id, INSTALLE);
  serveur = await helpers.startServer();
});

test.after(async () => {
  await fermerNavigateur();
  await serveur?.close();
  helpers.teardown();
});

test('R6 — dix-huit non faisables mesurés : huit annonces, dix connecteurs écrits ; le dépôt les garde', () => {
  assert.equal(NON_FAISABLES.length, 18);
  assert.equal(NON_FAISABLES.filter((c) => c.planned).length, 8);
  assert.equal(NON_FAISABLES.filter((c) => !c.planned).length, 10);
  for (const c of NON_FAISABLES) {
    const dossier = path.join(__dirname, '..', 'server', 'connectors', c.planned ? 'planned' : 'available', c.id);
    assert.ok(fs.existsSync(path.join(dossier, 'manifest.json')), `${c.id} : le manifeste reste`);
    if (!c.planned) assert.ok(fs.existsSync(path.join(dossier, 'connector.js')), `${c.id} : le code reste`);
  }
});

test('R6 — GET /api/connectors ne les envoie plus, ni leur compte ; leur fiche n\'existe plus', async (t) => {
  for (const compte of ['gerante', 'voisine']) {
    const client = await helpers.startServer();
    t.after(() => client.close());
    await helpers.login(client, compte, 'MotDePasse1');
    const { body } = await client.get('/api/connectors');
    assert.deepEqual(body.connectors.filter(empeche).map((c) => c.id), [], compte);
    assert.equal('unfeasible' in body.counts, false, `${compte} : plus de compte`);
    assert.equal(body.counts.aVenir, body.connectors.filter((c) => c.planned).length);
    assert.equal(JSON.stringify(body).includes('Pas possible'), false);
    for (const c of NON_FAISABLES) {
      const fiche = await client.get(`/api/connectors/${c.id}`);
      // 404 ; 403 pour un compte ordinaire et un service encore « en attente
      // de test », qu'il ne pouvait déjà pas voir.
      assert.ok(fiche.status === 404 || (compte === 'voisine' && fiche.status === 403 && c.catalogStatus === 'pending'),
        `${compte} — ${c.id} : aucune fiche (${fiche.status})`);
      assert.equal(fiche.body.connector, undefined);
    }
  }
});

test('R6 — l\'exception : un non faisable installé avant reste pour son compte seul, hors des comptes du Store', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  const { body } = await client.get('/api/connectors');
  const recus = body.connectors.filter(empeche);
  assert.deepEqual(recus.map((c) => c.id), [INSTALLE], 'le sien, et lui seul');
  assert.equal(recus[0].installed, true);
  assert.equal(recus[0].unfeasible, registry.manifest(INSTALLE).unfeasible, 'avec sa raison');
  const store = body.connectors.filter((c) => !empeche(c));
  assert.equal(body.counts.available, store.filter((c) => !c.planned && c.catalogStatus !== 'pending').length, 'pas compté dans le Store');
  assert.equal(body.counts.available + body.counts.pending + body.counts.planned, store.length);
  assert.equal((await client.get(`/api/connectors/${INSTALLE}`)).status, 200, 'sa fiche, pour lui');

  // La voisine ne le reçoit pas.
  const autre = await helpers.startServer();
  t.after(() => autre.close());
  await helpers.login(autre, 'voisine', 'MotDePasse1');
  assert.equal((await autre.get('/api/connectors')).body.connectors.some((c) => c.id === INSTALLE), false);
  assert.equal((await autre.get(`/api/connectors/${INSTALLE}`)).status, 404);
});

test('R6 — l\'Administration non plus : ni les Applications, ni les Logos, ni le compte de Système', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'gerante', 'MotDePasse1');
  const ids = new Set(NON_FAISABLES.map((c) => c.id));

  const apps = (await client.get('/api/admin/connectors')).body;
  assert.deepEqual(apps.connectors.filter((c) => ids.has(c.id)).map((c) => c.id), []);
  assert.equal(apps.plannedCount, registry.listPlanned().filter((c) => !empeche(c)).length);

  const logos = (await client.get('/api/admin/connectors/logos')).body;
  assert.deepEqual(logos.connectors.filter((c) => ids.has(c.id)).map((c) => c.id), []);
  assert.ok(logos.connectors.some((c) => c.kind === 'destination'), 'les destinations restent');

  const systeme = (await client.get('/api/system')).body;
  assert.equal(systeme.stats.connectorsAvailable, registry.size - 10);
});

test('R6 — la garde du lot 106 reste : chacun des dix-huit refusé à l\'installation, avec sa raison ; rien n\'est créé', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  // L'administratrice : elle voit les services en attente de test, la garde
  // du non faisable est donc la seule qui réponde.
  await helpers.login(client, 'gerante', 'MotDePasse1');
  const gerante = helpers.db.get().prepare("SELECT id FROM users WHERE username = 'gerante'").pluck().get();
  for (const c of NON_FAISABLES) {
    const r = await client.post(`/api/connectors/${c.id}/install`);
    assert.equal(r.status, 409, c.id);
    assert.equal(r.body.error, `« ${c.name} » ne peut pas être installé : ${c.unfeasible.trim()}`, c.id);
  }
  const marques = NON_FAISABLES.map(() => '?').join(', ');
  assert.equal(helpers.db.get().prepare(`SELECT COUNT(*) FROM connector_installs WHERE user_id = ? AND connector_id IN (${marques})`)
    .pluck().get(gerante, ...NON_FAISABLES.map((c) => c.id)), 0);
});

test('R6 — l\'accueil : la trace d\'un non faisable désinstallé n\'y revient pas ; l\'installé, si', () => {
  const home = require('../server/home');
  const journal = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message)
     VALUES (?, ?, datetime('now', '-1 hour'), datetime('now', '-59 minutes'), ?, 'manual', ?)`
  );
  // La voisine : une vieille exécution d'EDF (désinstallé), en échec puis réussie ailleurs.
  journal.run('edf', voisine.id, 0, 'Échec inventé');
  journal.run('vinted', voisine.id, 1, 'Réussite inventée');
  assert.equal(home.recentErrors({ id: voisine.id }).some((e) => e.connectorId === 'edf'), false);
  assert.equal(home.recentSuccesses({ id: voisine.id }).some((e) => e.connectorId === 'vinted'), false);
  // La titulaire : son service installé reste, avec son échec.
  journal.run(INSTALLE, titulaire.id, 0, 'Échec inventé');
  assert.equal(home.recentErrors({ id: titulaire.id }).some((e) => e.connectorId === INSTALLE), true);
});

test('R6 — la page publique ne change pas d\'un octet ; ses dix-huit « Non faisables » y sont', () => {
  const texte = fs.readFileSync(PAGE);
  assert.equal(crypto.createHash('sha256').update(texte).digest('hex'), EMPREINTE_PAGE);
  assert.match(texte.toString('utf8'), /^## Non faisables \(18\)$/m);
  for (const c of NON_FAISABLES) assert.ok(texte.toString('utf8').includes(`| ${c.name} |`), c.id);
});

test('R6 — au vrai Chromium : ni le Store, ni sa recherche, ni l\'Administration ; « Mes connecteurs » garde l\'installé de son compte', AVEC_NAVIGATEUR, async (t) => {
  const noms = NON_FAISABLES.map((c) => c.name);
  // La titulaire : son Engie dans « Mes connecteurs », nulle part dans le Store.
  {
    const { page, erreursJs, fermer } = await ouvrirCrabe(client0(), 'titulaire');
    t.after(fermer);
    await page.waitForFunction(() => document.getElementById('home-widgets')?.innerText.length > 0);
    assert.match(await page.innerText('#home-widgets'), new RegExp(registry.manifest(INSTALLE).name));
    await page.evaluate(() => showView('store'));
    await page.waitForSelector('#store-grid .card');
    const tuiles = (await page.locator('#store-grid .card-name').allTextContents()).map((n) => n.trim());
    for (const nom of noms) assert.equal(tuiles.includes(nom), false, nom);
    await page.fill('#store-search', registry.manifest(INSTALLE).name);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#store-grid .card').count(), 0, 'la recherche ne le trouve pas');
    assert.doesNotMatch(await page.innerText('#store-count'), /faisable/i);
    assert.deepEqual(erreursJs, []);
  }
  // L'administratrice : ni Applications (catalogue, recherche), ni Logos.
  {
    const { page, erreursJs, fermer } = await ouvrirCrabe(client0(), 'gerante', { chemin: '/administration/applications' });
    t.after(fermer);
    await page.waitForSelector('#apps-list .app-card, #apps-list tr');
    const texte = await page.innerText('#apps-list');
    for (const nom of noms) assert.equal(new RegExp(`(^|\\n)${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`).test(texte), false, `Applications : ${nom}`);
    await page.evaluate(() => setAppsTab('logos'));
    await page.waitForFunction(() => document.getElementById('logos-list')?.innerText.length > 200);
    const logos = await page.innerText('#logos-list');
    for (const nom of noms) assert.equal(new RegExp(`(^|\\n)${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`).test(logos), false, `Logos : ${nom}`);
    assert.doesNotMatch(await page.innerText('#view-admin'), /Non faisable|Pas possible aujourd'hui/);
    assert.deepEqual(erreursJs, []);
  }
});

