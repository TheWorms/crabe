'use strict';

/**
 * Lot 103 — les annonces NON FAISABLES dans crabe.
 *
 * Huit annonces portent un empêchement mesuré (`unfeasible`, lot 36). Jusqu'au
 * lot 103, le Store les rangeait parmi les autres, chacune dans sa catégorie,
 * leur raison coupée à trois lignes (mesuré au vrai Chromium : coupée sur les
 * huit) et comptée parmi les services « à venir » ; le serveur les refusait
 * en promettant « une prochaine version ». Ce fichier verrouille ce qui a
 * changé :
 *
 *   1. le rendu (le vrai web/app.js, dans un bac à sable) : un bloc « Non
 *      faisables » après toutes les catégories, qui porte les annonces
 *      empêchées et elles seules, chacune avec sa raison, sans bouton ni clic ;
 *      le sous-titre les compte à part ;
 *   2. au VRAI Chromium, sur une instance neuve — un compte ordinaire et un
 *      administrateur, aux deux tailles d'écran : le groupe, ses huit tuiles,
 *      la raison lisible EN ENTIER, aucun bouton, et un clic qui n'ouvre rien
 *      et n'appelle rien ;
 *   3. le serveur : chaque route d'action refuse chacune des huit (409), en
 *      disant sa raison, et rien n'est créé en chemin ; `GET /api/connectors`
 *      les compte.
 *
 * (crabe n'a pas de route de « demande » d'un service : il n'y a rien d'autre
 * à refuser.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');

const RACINE = path.join(__dirname, '..');
const WEB = path.join(RACINE, 'web');
const ANNONCES = path.join(RACINE, 'server', 'connectors', 'planned');

/** Les annonces livrées, par identifiant, avec leur manifeste. */
function annoncesDuDisque() {
  return fs.readdirSync(ANNONCES)
    .filter((id) => fs.existsSync(path.join(ANNONCES, id, 'manifest.json')))
    .map((id) => JSON.parse(fs.readFileSync(path.join(ANNONCES, id, 'manifest.json'), 'utf8')));
}

const EMPECHEES = annoncesDuDisque().filter((m) => String(m.unfeasible || '').trim());

// ---------------------------------------------------------------------------
// 1. Le rendu — le vrai web/app.js, dans un bac à sable
// ---------------------------------------------------------------------------

/** Le Store rendu par le vrai web/app.js, sur un catalogue d'essai. */
function leStore(connecteurs, counts, reglages = '') {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', checked: false, textContent: '', innerHTML: '', style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        getAttribute: () => null, setAttribute() {}, addEventListener() {}, focus() {},
        querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return elements.get(id);
  };
  const bac = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    document: {
      getElementById: element, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => element('créé'), body: element('body'),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/', hash: '', search: '' },
    navigator: { userAgent: 'essai' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => {
      throw new Error('aucun appel réseau ne doit sortir du bac à sable');
    },
    __donnees: JSON.parse(JSON.stringify({ connecteurs, counts })),
  };
  bac.window = bac;
  bac.globalThis = bac;
  const contexte = vm.createContext(bac);
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js', 'admin.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), contexte, { filename: fichier });
  }
  vm.runInContext(`
    state.connectors = __donnees.connecteurs;
    state.categories = [
      { id: 'telecom', label: 'Mobile & Internet' },
      { id: 'banque', label: 'Banque & paiement' },
      { id: 'divertissement', label: 'Divertissement' },
    ];
    state.storeCounts = __donnees.counts;
    state.currentCat = 'all';
    state.storeAvailableOnly = false;
    ${reglages}
    renderStoreGrid();`, contexte, { filename: 'essai' });
  return { grille: element('store-grid').innerHTML, compte: element('store-count').textContent };
}

const DISPONIBLE = (id, name, category) => ({
  id, name, category, color: '#123456', letters: 'XX', planned: false, status: 'available',
  installed: false, catalogStatus: 'available', health: null,
});
const PROMISE = (id, name, category) => ({
  id, name, category, color: '#123456', letters: 'XX', planned: true, status: 'planned',
  installed: false, description: `Récupère automatiquement les documents ${name}.`,
});
const EMPECHEE = (id, name, category, raison) => ({ ...PROMISE(id, name, category), unfeasible: raison });

const CATALOGUE = [
  DISPONIBLE('operateur', 'Opérateur', 'telecom'),
  EMPECHEE('banque-a', 'Banque A', 'banque', 'La banque A exige un geste que seul son titulaire peut faire : crabe ne peut pas se connecter à votre place.'),
  PROMISE('paiement', 'Paiement', 'banque'),
  EMPECHEE('banque-b', 'Banque B', 'banque', 'La banque B exige un geste que seul son titulaire peut faire : crabe ne peut pas se connecter à votre place.'),
  DISPONIBLE('compte', 'Compte', 'banque'),
  EMPECHEE('forfait', 'Forfait', 'telecom', 'Ce service ne montre ses factures que dans son application : crabe n\'a nulle part où aller les chercher.'),
  PROMISE('jeu', 'Jeu', 'divertissement'),
];
const COMPTES = { available: 2, pending: 0, planned: 5, unfeasible: 3 };

/** Les blocs de la grille : titre (tel qu'il s'affiche), et le HTML de chaque tuile. */
function blocs(grille) {
  return grille.split('<div class="cat-block">').slice(1).map((bloc) => ({
    titre: /<div class="cat-title">([^<]*)<\/div>/.exec(bloc)?.[1].replace(/&amp;/g, '&'),
    tuiles: bloc.split(/<div class="card(?=["\s])/).slice(1),
  }));
}

// Lot 108 (modifié par décision, 12/10/2026) : les non faisables ont quitté
// le logiciel. Le bloc « Non faisables » que ces quatre essais verrouillaient
// n'existe plus ; ils verrouillent désormais son absence — même si un serveur
// en envoyait un (celui qu'un compte a installé avant : il n'est que dans
// « Mes connecteurs »), le Store ne le montre pas.

test('rendu — plus de bloc « Non faisables » : les empêchées n\'apparaissent nulle part dans le Store (lot 108)', () => {
  const { grille } = leStore(CATALOGUE, COMPTES);
  const lus = blocs(grille);
  assert.deepEqual(lus.map((b) => b.titre), ['Mobile & Internet', 'Banque & paiement', 'Divertissement']);
  for (const bloc of lus) {
    assert.equal(bloc.tuiles.some((t) => /Pas possible aujourd'hui|unfeasible/.test(t)), false, `${bloc.titre} : aucune empêchée`);
  }
  for (const nom of ['Banque A', 'Banque B', 'Forfait']) assert.equal(grille.includes(nom), false, nom);
  // Les autres annonces restent dans leur catégorie, « Bientôt disponible ».
  assert.match(lus[1].tuiles.join(''), /Paiement[\s\S]*Bientôt disponible/);
  assert.match(lus[2].tuiles.join(''), /Jeu[\s\S]*Bientôt disponible/);
});

test('rendu — une catégorie n\'affiche que ses services faisables (lot 108)', () => {
  const banque = blocs(leStore(CATALOGUE, COMPTES, 'state.currentCat = \'banque\';').grille);
  assert.deepEqual(banque.map((b) => b.titre), ['Banque & paiement']);
  assert.equal(banque[0].tuiles.length, 2, 'Paiement et Compte');
});

test('rendu — ni le filtre ni la recherche ne font revenir une empêchée (lot 108)', () => {
  const titres = (grille) => blocs(grille).map((b) => b.titre);
  assert.equal(titres(leStore(CATALOGUE, COMPTES, 'state.storeAvailableOnly = true;').grille).includes('Non faisables'), false);
  // Une recherche qui ne trouverait qu'une empêchée ne trouve rien.
  const forfait = leStore(CATALOGUE, COMPTES, '$("store-search").value = "forfait";').grille;
  assert.deepEqual(blocs(forfait), []);
  assert.match(forfait, /Aucun service ne correspond à « forfait »/);
});

test('rendu — le sous-titre ne compte plus de non faisables (lot 108)', () => {
  assert.equal(leStore(CATALOGUE, { available: 2, pending: 0, planned: 2, aVenir: 2 }).compte, '2 services disponibles, 2 à venir');
  assert.equal(leStore(CATALOGUE, { available: 2, pending: 4, planned: 2, aVenir: 2 }).compte,
    '2 services disponibles, 4 pas encore testés, 2 à venir');
  // Un compte « unfeasible » d'un serveur d'avant n'est plus lu.
  assert.equal(leStore(CATALOGUE, COMPTES).compte, '2 services disponibles, 5 à venir');
  assert.equal(leStore(CATALOGUE, { available: 3, planned: 0 }).compte,
    '3 services disponibles — installez et configurez les sources de vos factures');
});

// ---------------------------------------------------------------------------
// 2. Au vrai Chromium, sur une instance neuve
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();

test('au vrai Chromium — le Store ne montre plus aucun non faisable : ni groupe, ni tuile, ni recherche, ni compte (lot 108, modifié par décision)',
  { skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.', timeout: 180_000 },
  async (t) => {
    assert.equal(EMPECHEES.length, 8, 'huit annonces empêchées sur le disque');
    await helpers.setup();
    const registry = require('../server/connectors/registry');
    // Les dix connecteurs écrits du lot 106, lus dans le registre.
    const ECRITS = registry.listAvailable().filter((c) => String(c.unfeasible || '').trim());
    assert.equal(ECRITS.length, 10);
    const NOMS = [...EMPECHEES, ...ECRITS].map((m) => m.name);
    await helpers.createUser({ username: 'lot103ordinaire', plainPassword: 'MotDePasse1' });
    await helpers.createUser({ username: 'lot103admin', plainPassword: 'MotDePasse1', role: 'admin' });
    const client = await helpers.startServer();
    t.after(() => client.close());
    const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
    t.after(() => navigateur.close());

    for (const compte of ['lot103ordinaire', 'lot103admin']) {
      const reponse = await fetch(`${client.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: compte, password: 'MotDePasse1' }),
      });
      const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
      assert.ok(brut, `${compte} : cookie de session absent`);
      const cookie = brut.split(';')[0];
      const { counts, connectors } = await (await fetch(`${client.base}/api/connectors`, { headers: { cookie } })).json();
      // Le serveur ne les envoie plus (aucun n'est installé ici).
      assert.equal(connectors.filter((c) => String(c.unfeasible || '').trim()).length, 0, `${compte} : aucun reçu`);
      assert.equal('unfeasible' in counts, false, `${compte} : plus de compte des non faisables`);

      for (const [largeur, hauteur] of [[1280, 900], [390, 844]]) {
        const vue = `${compte} ${largeur}×${hauteur}`;
        const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur } });
        await contexte.addCookies([{ name: 'crabe.sid', value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
        const page = await contexte.newPage();
        const erreursJs = [];
        page.on('pageerror', (e) => erreursJs.push(String(e)));
        await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
        await page.evaluate(() => showView('store'));
        await page.waitForSelector('#store-grid .card');

        assert.equal(await page.locator('#store-grid .cat-title', { hasText: /Non faisables/ }).count(), 0, vue);
        assert.equal(await page.locator('#store-grid .card.unfeasible').count(), 0, vue);
        assert.equal(await page.locator('#store-grid .planned-badge', { hasText: 'Pas possible aujourd\'hui' }).count(), 0, vue);
        const noms = (await page.locator('#store-grid .card-name').allTextContents()).map((n) => n.trim());
        for (const nom of NOMS) assert.equal(noms.includes(nom), false, `${vue} : ${nom} absent`);
        // Les annonces à venir : dans leur catégorie, « Bientôt disponible ».
        const promises = page.locator('#store-grid .card.planned');
        assert.equal(await promises.count(), annoncesDuDisque().length - 8, vue);
        for (const badge of await promises.locator('.planned-badge').allTextContents()) {
          assert.equal(badge.trim(), 'Bientôt disponible', vue);
        }
        // Le sous-titre : aucun « non faisable ».
        const sousTitre = (await page.textContent('#store-count')).trim();
        t.diagnostic(`${vue} — sous-titre : ${sousTitre}`);
        assert.doesNotMatch(sousTitre, /faisable/i, sousTitre);
        assert.ok(sousTitre.endsWith(`, ${counts.aVenir} à venir`), sousTitre);
        // La recherche ne les trouve pas.
        for (const nom of ['Hello bank!', 'FDJ', 'EDF', 'Vinted']) {
          await page.fill('#store-search', nom);
          await page.waitForTimeout(50);
          const trouves = (await page.locator('#store-grid .card-name').allTextContents()).map((n) => n.trim());
          for (const n of NOMS) assert.equal(trouves.includes(n), false, `${vue} — « ${nom} » : ${n} introuvable`);
        }
        await page.fill('#store-search', '');
        assert.deepEqual(erreursJs, [], `${vue} : aucune erreur JavaScript`);
        await contexte.close();
      }
    }
  });

// ---------------------------------------------------------------------------
// 3. Le serveur
// ---------------------------------------------------------------------------

/** Chaque route d'action d'un connecteur, et le geste que son refus nomme. */
const ROUTES = (id) => [
  ['post', `/api/connectors/${id}/install`, 'installé'],
  ['put', `/api/connectors/${id}/config`, 'configuré', { config: {} }],
  ['post', `/api/connectors/${id}/test`, 'testé'],
  ['post', `/api/connectors/${id}/discover`, 'exploré'],
  ['post', `/api/connectors/${id}/run`, 'exécuté'],
  ['post', `/api/connectors/${id}/run-historique-complet`, 'exécuté'],
  ['get', `/api/connectors/${id}/permissions`, 'consulté en détail'],
  ['delete', `/api/connectors/${id}`, 'désinstallé'],
  ['post', `/api/connectors/${id}/remote-login`, 'connecté'],
];

test('le serveur refuse chacune des huit, par chaque route d\'action, avec sa raison — et rien n\'est créé', async (t) => {
  await helpers.setup();
  const db = require('../server/db/db');
  await helpers.createUser({ username: 'lot103routes', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'lot103routes', 'MotDePasse1');

  assert.equal(EMPECHEES.length, 8);
  for (const annonce of EMPECHEES) {
    for (const [methode, chemin, geste, corps] of ROUTES(annonce.id)) {
      const res = await client[methode](chemin, corps);
      assert.equal(res.status, 409, `${chemin} : refusé`);
      assert.equal(res.body.error, `« ${annonce.name} » ne peut pas être ${geste} : ${annonce.unfeasible.trim()}`,
        `${chemin} : le refus dit la raison, sans promettre de prochaine version`);
    }
  }
  const ids = EMPECHEES.map((m) => m.id);
  const marques = ids.map(() => '?').join(', ');
  for (const table of ['connector_installs', 'user_connector_schedules', 'connector_discoveries', 'run_logs', 'run_queue']) {
    assert.equal(db.get().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id IN (${marques})`).get(...ids).n, 0,
      `${table} : rien n'a été créé en chemin`);
  }
});

test('une annonce à venir garde son refus d\'avant : « … sa connexion arrivera dans une prochaine version de crabe »', async () => {
  await helpers.setup();
  const registry = require('../server/connectors/registry');
  const promise = registry.listPlanned().find((c) => !String(c.unfeasible || '').trim());
  assert.throws(() => registry.assertInstallable(promise.id),
    (err) => err.statusCode === 409 && err.message === `« ${promise.name} » ne peut pas encore être installé : `
      + 'ce service est annoncé, sa connexion arrivera dans une prochaine version de crabe.');
});

test('GET /api/connectors n\'envoie plus aucun non faisable, ni leur compte (lot 108, modifié par décision)', async (t) => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot103compte', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'lot103compte', 'MotDePasse1');
  const res = await client.get('/api/connectors');
  assert.equal(res.status, 200);
  const annonces = res.body.connectors.filter((c) => c.planned);
  assert.equal(res.body.counts.planned, annonces.length);
  assert.equal(res.body.counts.aVenir, annonces.length);
  assert.equal(res.body.connectors.filter((c) => String(c.unfeasible || '').trim()).length, 0);
  assert.equal('unfeasible' in res.body.counts, false);
  for (const m of EMPECHEES) assert.equal(res.body.connectors.some((c) => c.id === m.id), false, `${m.id} : absent`);
  assert.equal(annonces.length, annoncesDuDisque().length - 8);
});
