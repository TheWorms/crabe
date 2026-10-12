'use strict';

/**
 * Lot 104 — ce qui vaut pour les trois connecteurs neufs : les mots refusés
 * (règle 5), les fiches (R4), la migration 63 (D7), la page des connecteurs
 * (R6, R7), la sentinelle et la garde des essais (règle 6), et le Store sur
 * téléphone (R8), au vrai Chromium.
 *
 * ⚠ Aucune donnée réelle ici : des adresses de forme, des valeurs inventées.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const refusees = require('../server/connectors/adresses-refusees');
const interdites99 = require('../server/connectors/adresses-interdites');
const bnet = require('../server/connectors/available/battle-net/connector');
const alma = require('../server/connectors/available/alma/connector');
const pss = require('../server/connectors/available/private-sport-shop/connector');
const faux = require('./lot104-faux-sites');

const RACINE = path.join(__dirname, '..');
const CONNECTEURS = path.join(RACINE, 'server', 'connectors');
const IDS = ['battle-net', 'alma', 'private-sport-shop'];

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot104admin', role: 'admin' });
  await helpers.createUser({ username: 'lot104user', role: 'user' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot104admin', 'MotDePasse1');
});

test.after(async () => {
  await client?.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Règle 5 — les mots refusés
// ---------------------------------------------------------------------------

test('règle 5 — les mots refusés : la liste du lot 99 entière, plus checkout, ProductReturn, billing_agreement, reschedule, logout, et « pay » seul', () => {
  assert.deepEqual([...refusees.MOTS_DU_LOT_99], [...interdites99.MOTS_INTERDITS], 'la liste du lot 99, recopiée telle quelle');
  assert.deepEqual([...refusees.MOTS_DU_LOT_104], ['checkout', 'ProductReturn', 'billing_agreement', 'reschedule', 'logout']);
  assert.deepEqual([...refusees.MOTS_SEULS], ['pay']);
  for (const liste of [refusees.MOTS_DU_LOT_99, refusees.MOTS_DU_LOT_104, refusees.MOTS_SEULS, refusees.MOTS_REFUSES]) {
    assert.ok(Object.isFrozen(liste));
  }
  for (const mot of [...refusees.MOTS_DU_LOT_99, ...refusees.MOTS_DU_LOT_104]) {
    assert.ok(refusees.motRefuse(`https://exemple.invalid/a/${mot}/b`), mot);
    assert.ok(refusees.motRefuse(`https://exemple.invalid/a?x=${mot.toUpperCase()}`), `${mot} en capitales`);
    assert.ok(refusees.motRefuse(`https://exemple.invalid/${encodeURIComponent(mot).replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`)}`), `${mot} encodé`);
  }
  for (const pay of ['https://exemple.invalid/pay', 'https://exemple.invalid/pay/1', 'https://exemple.invalid/x?pay=1', 'https://exemple.invalid/x/PAY']) {
    assert.equal(refusees.motRefuse(pay), 'pay', pay);
  }
  for (const ok of [bnet.URL_LISTE, 'https://account.battle.net/transactions/ZZ900000001/9900000001', alma.URL_PORTAIL,
    `${alma.DEBUT_COMPTE}ZZessai`, 'https://portal.getalma.eu/payment_ZZessaiAchat01', pss.URL_HISTORIQUE, pss.URL_RECENTES,
    'https://www.privatesportshop.fr/historical/orders/90000001', 'https://www.paypal.com/x',
    ...IDS.map((id) => registry.manifest(id).remoteLogin.url), ...IDS.map((id) => registry.manifest(id).remoteLogin.verifyUrl)]) {
    assert.equal(refusees.motRefuse(ok), null, ok);
  }
});

test('règle 5 — chaque connecteur refuse chaque mot, glissé dans une adresse qu\'il lirait', () => {
  for (const mot of refusees.MOTS_REFUSES) {
    assert.ok(bnet.adresseDuDetail(`/transactions/ZZ900000001/${mot}`).refus || bnet.adresseDuDetail(`/${mot}/ZZ900000001/1234`).refus, `battle-net : ${mot}`);
    assert.ok(pss.adresseDuDetail(`/historical/orders/1/${mot}`).refus, `private-sport-shop : ${mot}`);
    if (/^[A-Za-z]+$/.test(mot)) {
      // Un identifiant d'achat a la forme `payment_<lettres et chiffres>` : « pay » n'y est jamais seul.
      const id = `payment_ZZessai${mot}`;
      assert.equal(alma.adresseDeLAchat(id), mot === 'pay' ? `https://portal.getalma.eu/${id}` : null, `alma : ${mot}`);
    }
  }
});

test('le module des mots refusés n\'est employé que par les trois connecteurs du lot 104 ; celui du lot 99 n\'a pas bougé d\'employeurs', () => {
  const employeurs = (motif) => {
    const trouves = [];
    const parcourir = (dossier) => {
      for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
        const chemin = path.join(dossier, e.name);
        if (e.isDirectory()) parcourir(chemin);
        else if (e.name.endsWith('.js') && motif.test(fs.readFileSync(chemin, 'utf8'))) trouves.push(path.relative(path.join(RACINE, 'server'), chemin));
      }
    };
    parcourir(path.join(RACINE, 'server'));
    return trouves.sort();
  };
  assert.deepEqual(employeurs(/adresses-refusees/), IDS.map((id) => `connectors/available/${id}/connector.js`).sort());
  assert.deepEqual(employeurs(/adresses-interdites/), ['connectors/available/alfaliquid/connector.js',
    'connectors/available/e-liquide-fr/connector.js', 'connectors/available/le-petit-vapoteur/connector.js']);
});

// ---------------------------------------------------------------------------
// R4 — les fiches ; trois connecteurs naissent
// ---------------------------------------------------------------------------

const ATTENDU = {
  'battle-net': { name: 'Battle.net', site: 'account.battle.net', categorie: 'deezer', letters: 'BA',
    reserve: /le site ne fournit pas de facture : crabe enregistre en PDF la page de détail de chaque achat/i },
  alma: { name: 'Alma', site: 'portal.getalma.eu', categorie: 'paypal', letters: 'AL', reserve: /un reçu par échéance payée/i },
  'private-sport-shop': { name: 'Private Sport Shop', site: 'www.privatesportshop.fr', categorie: 'decathlon', letters: 'PS', reserve: /factures/ },
};

test('R4 — les trois fiches : catégorie de Deezer, de PayPal, des boutiques ; en attente ; réserve en français simple ; connexion par la fenêtre ; note technique hors de la vue publique', () => {
  for (const id of IDS) {
    const m = registry.manifest(id);
    const vue = schema.publicView(m);
    const a = ATTENDU[id];
    assert.equal(vue.name, a.name);
    assert.equal(vue.site, a.site);
    assert.equal(m.category, registry.manifest(a.categorie).category, `${id} : la catégorie de ${a.categorie}`);
    assert.equal(m.initialStatus, 'pending');
    assert.equal(m.implementation, 'scraping');
    assert.equal(m.letters, a.letters);
    assert.match(vue.caveat, /^Vous vous connectez vous-même, dans une fenêtre\./);
    assert.match(vue.caveat, a.reserve);
    assert.ok(vue.caveat.length <= 220);
    assert.equal(vue.technicalNote, undefined);
    assert.match(m.technicalNote, /JAMAIS EXERCÉ CONTRE UN COMPTE RÉEL/);
    assert.deepEqual(vue.fields.map((f) => f.key), ['session', 'historique']);
    assert.equal(vue.fields[0].required, false);
    assert.deepEqual(m.permissions.map((p) => p.key), ['factures', 'identifiants']);
    assert.equal(m.remoteLogin.preuveSurFenetre, true);
    assert.equal(m.remoteLogin.persistent, false, 'rejouée sans écran');
    assert.match(vue.remoteLogin.hint, /cliquez sur Enregistrer/);
    assert.equal(m.remoteLogin.marqueursFenetre.length, 1);
    assert.equal(fs.existsSync(path.join(CONNECTEURS, 'planned', id)), false, `${id} : le dossier planned/ est retiré`);
    const gen = fs.readFileSync(path.join(RACINE, 'scripts', 'gen-planned.js'), 'utf8');
    assert.equal(new RegExp(`id:\\s*'${id}'`).test(gen), false, `${id} : gen-planned.js ne la ressuscite pas`);
    assert.equal(registry.isPlanned(id), false);
  }
  assert.equal(registry.manifest('battle-net').remoteLogin.marqueursFenetre[0].selecteur, 'blz-nav-battlenet[authenticated]');
  assert.equal(registry.manifest('alma').remoteLogin.marqueursFenetre[0].selecteur, '[data-testid="account-logged-in-button"]');
  assert.deepEqual(registry.manifest('private-sport-shop').remoteLogin.marqueursFenetre[0],
    { selecteur: 'h1[data-selector-orders-title]', texte: 'Historique des commandes' });
});

test('R4 — l\'administrateur voit les trois fiches, en attente ; un compte ordinaire ne les voit pas ; les lignes de catalogue sont en attente', async () => {
  const res = await client.get('/api/connectors');
  for (const id of IDS) {
    const fiche = (res.body.connectors || []).find((c) => c.id === id);
    assert.ok(fiche, id);
    assert.equal(fiche.planned, false);
    assert.equal(fiche.catalogStatus, 'pending');
    assert.ok(fiche.remoteLogin?.url);
  }
  const autre = await helpers.startServer();
  try {
    await helpers.login(autre, 'lot104user', 'MotDePasse1');
    const vue = await autre.get('/api/connectors');
    for (const id of IDS) assert.equal((vue.body.connectors || []).some((c) => c.id === id), false, id);
  } finally {
    await autre.close();
  }
  const db = require('../server/db/db');
  for (const id of IDS) {
    assert.equal(db.get().prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get(id).status, 'pending', id);
  }
});

test('B2 — trois connecteurs naissent : 63 chargés, 25 annoncés, aucune erreur', () => {
  const r = registry.load();
  assert.deepEqual(r.errors, []);
  assert.equal(r.loaded, 63);
  assert.equal(r.planned, 25);
  for (const id of IDS) assert.equal(registry.has(id), true, id);
});

test('règle 6 — la garde des essais : par le registre, aucun navigateur ne s\'ouvre pour les trois (CRABE_DISABLE_SCRAPING)', async () => {
  assert.equal(require('../server/config').config.scrapingDisabled, true);
  for (const id of IDS) {
    const instance = registry.get(id).module;
    const lancer = instance.ouverture.lancer;
    let lance = 0;
    instance.ouverture.lancer = () => { lance++; throw new Error('essai : lancement interdit'); };
    try {
      await assert.rejects(registry.fetchInvoicesDetailed(id, { session: '{}' }, { userId: 1 }), /Le scraping est désactivé/);
      assert.equal((await registry.test(id, { session: '{}' }, { userId: 1 })).ok, false);
      assert.equal(lance, 0, id);
    } finally {
      instance.ouverture.lancer = lancer;
    }
  }
});

// ---------------------------------------------------------------------------
// D7 — la migration 63
// ---------------------------------------------------------------------------

test('D7 — la migration 63 : trois annonces « available » deviennent connecteurs en attente ; une ligne publiée n\'est pas touchée ; idempotente', () => {
  const { MIGRATIONS } = require('../server/db/migrations');
  const m63 = MIGRATIONS.find((m) => m.id === 63);
  assert.ok(m63);
  assert.match(m63.name, /Battle\.net, Alma, Private Sport Shop/);
  const Database = require('better-sqlite3');
  const base = new Database(':memory:');
  try {
    base.exec(`CREATE TABLE connector_catalog (connector_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', published_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const ins = base.prepare('INSERT INTO connector_catalog (connector_id, category, status, published_at) VALUES (?, ?, ?, ?)');
    ins.run('battle-net', 'divertissement', 'available', null);
    ins.run('alma', 'banque', 'available', null);
    ins.run('private-sport-shop', 'shopping', 'available', '2026-10-11 10:00:00');
    ins.run('deezer', 'divertissement', 'available', null);
    m63.up(base);
    const etat = () => Object.fromEntries(base.prepare('SELECT connector_id, status FROM connector_catalog').all().map((l) => [l.connector_id, l.status]));
    assert.deepEqual(etat(), { 'battle-net': 'pending', alma: 'pending', 'private-sport-shop': 'available', deezer: 'available' },
      'une ligne publiée par un administrateur, et les autres services, ne sont pas touchés');
    m63.up(base);
    assert.deepEqual(etat(), { 'battle-net': 'pending', alma: 'pending', 'private-sport-shop': 'available', deezer: 'available' });
  } finally {
    base.close();
  }
});

test('D7 — par le chemin réel : une base d\'avant ce lot (migration 62), les trois annonces en « available » ; seule la 63 s\'applique, puis rien', () => {
  const migrations = require('../server/db/migrations');
  const Database = require('better-sqlite3');
  const base = new Database(':memory:');
  try {
    base.exec(fs.readFileSync(path.join(RACINE, 'server', 'db', 'schema.sql'), 'utf8'));
    migrations.apply(base);
    base.prepare('DELETE FROM schema_migrations WHERE id = 63').run();
    for (const [id, cat] of [['battle-net', 'divertissement'], ['alma', 'banque'], ['private-sport-shop', 'shopping']]) {
      base.prepare('INSERT OR REPLACE INTO connector_catalog (connector_id, category, status, published_at) VALUES (?, ?, ?, ?)').run(id, cat, 'available', null);
    }
    const avant = base.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;
    const r = migrations.apply(base);
    assert.deepEqual(r.applied.map((m) => m.id), [63]);
    // Lot 106, par décision : la migration 64 existe désormais (l'interface de
    // « Mes documents ») ; seule la 63 est rejouée ici, la dernière est la 64.
    assert.equal(r.current, 64);
    for (const id of IDS) assert.equal(base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get(id).status, 'pending');
    assert.equal(base.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n, avant);
    assert.deepEqual(migrations.apply(base).applied, []);
    assert.equal(base.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    base.close();
  }
});

// ---------------------------------------------------------------------------
// R6, R7 — la page des connecteurs
// ---------------------------------------------------------------------------

function groupes() {
  const g = {};
  let nom = null;
  for (const ligne of fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8').split('\n')) {
    const t = /^## (.+) \((\d+)\)$/.exec(ligne);
    if (t) {
      nom = t[1];
      g[nom] = { annonce: Number(t[2]), ids: [] };
      continue;
    }
    const icone = nom && /^\| <img src="icones\/([a-z0-9-]+)\.png"/.exec(ligne);
    if (icone) g[nom].ids.push(icone[1]);
  }
  return g;
}

// Lot 105 : Private Sport Shop (trois documents en production) et l'Eau
// d'Île-de-France (décision du compte observé) passent « Fonctionnels » ; Battle.net et
// Alma restent « En cours ». Cet essai suit, par décision.
test('R7 — la page : Fonctionnels 48, En cours 3, En attente 2, Non faisables 18 (lot 106), Proposés 17 — 88 ; Battle.net et Alma en cours, Private Sport Shop et l\'Eau d\'Île-de-France fonctionnels (lot 105)', () => {
  const g = groupes();
  const comptes = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.ids.length]));
  // Lot 106, par décision : dix connecteurs écrits passent « Non faisables ».
  assert.deepEqual(comptes, { Fonctionnels: 48, 'En cours': 3, 'En attente': 2, 'Non faisables': 18, Proposés: 17 });
  for (const [k, v] of Object.entries(g)) assert.equal(v.annonce, v.ids.length, k);
  assert.deepEqual(g['En cours'].ids, ['alma', 'battle-net', 'paybyphone']);
  for (const id of IDS) assert.equal(g.Proposés.ids.includes(id), false, id);
  assert.equal(g.Fonctionnels.ids.includes('eau-ile-de-france'), true);
  assert.equal(g.Fonctionnels.ids.includes('private-sport-shop'), true);
  const page = fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8');
  assert.match(page, /\| Battle\.net \| Le détail de chacun de vos achats Battle\.net, enregistré en PDF — Battle\.net ne fournit pas de facture\. \|/);
  for (const id of IDS) assert.ok(fs.existsSync(path.join(RACINE, 'docs', 'icones', `${id}.png`)), `${id} : son icône reste celle du lot 97`);
});

// ---------------------------------------------------------------------------
// Règle 6 — la sentinelle couvre les domaines des trois sites
// ---------------------------------------------------------------------------

test('règle 6 — la sentinelle de la suite couvre battle.net, blizzard.com, akamaized.net, getalma.eu, almapay.com, privatesportshop.fr, sportpursuit.com, sportscape.group : « vus », sans fuite', faux.SANS_NAVIGATEUR, () => {
  const releve = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lot104-garde-')), 'releve.txt');
  const hotes = ['account.battle.net', 'www.blizzard.com', 'bnetaccount.akamaized.net', 'portal.getalma.eu', 'api.getalma.eu',
    'help.almapay.com', 'www.privatesportshop.fr', 'checkout.privatesportshop.fr', 'api.sportpursuit.com', 'cdn.sportscape.group'];
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const b = await chromium.launch({ headless: true });
      const c = await b.newContext();
      await c.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>banc</p>' }));
      const p = await c.newPage();
      for (const h of ${JSON.stringify(hotes)}) await p.goto('https://' + h + '/');
      await b.close();
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: RACINE,
    env: { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, 'lot99-garde-domaines.js')}`, CRABE_GARDE_DOMAINES: releve,
      CRABE_GARDE_DOMAINES_MOTIF: '' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const lignes = fs.readFileSync(releve, 'utf8').trim().split('\n');
  for (const h of hotes) assert.ok(lignes.some((l) => l.startsWith('vue ') && l.endsWith(` ${h}`)), `${h} est surveillé`);
  assert.equal(lignes.filter((l) => l.startsWith('FUITE')).length, 0);
  fs.rmSync(path.dirname(releve), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R8 — le Store sur téléphone, au vrai Chromium
// ---------------------------------------------------------------------------

test('R8 — les règles neuves du Store vivent toutes sous « max-width:639px » : le dessin sur ordinateur ne peut pas changer', () => {
  const css = fs.readFileSync(path.join(RACINE, 'web', 'style.css'), 'utf8');
  const debut = css.indexOf('@media (max-width:639px){\n  /* Lot 104');
  assert.ok(debut >= 0, 'le bloc téléphone porte la retouche du lot 104');
  const bloc = css.slice(debut, css.indexOf('\n}\n', debut));
  for (const regle of ['.grid{grid-template-columns:minmax(0,1fr);}', '.card .badge-logo{flex-shrink:0;}', '.card.planned{flex-wrap:wrap;}',
    '.card.planned .card-desc{flex:1 1 100%;min-width:0;}', '.card.planned .planned-badge{max-width:100%;white-space:normal;}']) {
    assert.ok(bloc.includes(regle), regle);
  }
  assert.equal(css.split('.card.planned{flex-wrap:wrap;}').length, 2, 'nulle part ailleurs');
});

test('R8 — au vrai Chromium : à 390 px, la page ne déborde plus, aucune tuile ne sort de l\'écran, chaque pastille garde 44 px ; à 1280 px, inchangé',
  { skip: faux.PLAYWRIGHT ? false : 'Playwright absent', timeout: 180_000 },
  async (t) => {
    await helpers.createUser({ username: 'lot104store', plainPassword: 'MotDePasse1' });
    const navigateur = await faux.PLAYWRIGHT.chromium.launch({ headless: true });
    t.after(() => navigateur.close());
    const reponse = await fetch(`${client.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lot104store', password: 'MotDePasse1' }),
    });
    const cookie = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid=')).split(';')[0];
    for (const [largeur, hauteur] of [[390, 844], [1280, 900]]) {
      const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur } });
      await contexte.addCookies([{ name: 'crabe.sid', value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
      const page = await contexte.newPage();
      await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => showView('store'));
      await page.waitForSelector('#store-grid .card.planned');
      const m = await page.evaluate(() => {
        const W = window.innerWidth;
        const cartes = [...document.querySelectorAll('#store-grid .card')];
        return {
          largeurPage: document.documentElement.scrollWidth,
          W,
          cartes: cartes.length,
          dehors: cartes.filter((c) => { const b = c.getBoundingClientRect(); return b.right > W + 0.5 || b.left < -0.5; }).length,
          pastilles: [...document.querySelectorAll('#store-grid .card .badge-logo')].map((p) => [p.getBoundingClientRect().width, p.getBoundingClientRect().height]),
          badgesDehors: [...document.querySelectorAll('#store-grid .planned-badge')].filter((b) => b.getBoundingClientRect().right > W + 0.5).length,
          sens: getComputedStyle(cartes[0]).flexDirection,
        };
      });
      const vue = `${largeur} px`;
      // Lot 108 (modifié par décision) : les dix-huit non faisables ont quitté
      // le Store — un compte ordinaire y voit 35 tuiles (18 + 17 à venir).
      assert.ok(m.cartes >= 30, vue);
      assert.equal(m.largeurPage, m.W, `${vue} : la page ne déborde pas`);
      assert.equal(m.dehors, 0, `${vue} : aucune tuile hors de l'écran`);
      assert.equal(m.badgesDehors, 0, `${vue} : aucun badge hors de l'écran`);
      for (const [l, h] of m.pastilles) assert.ok(Math.abs(l - 44) < 0.5 && Math.abs(h - 44) < 0.5, `${vue} : pastille ${l}×${h}`);
      assert.equal(m.sens, largeur === 390 ? 'row' : 'column', `${vue} : la tuile garde son sens`);
      await contexte.close();
    }
  });
