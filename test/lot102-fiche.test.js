'use strict';

/**
 * Lot 102 — l'Eau d'Île-de-France quitte les annonces : sa fiche (R7), sa
 * migration (D8), la page des connecteurs (R9), le seul connecteur qui naît
 * (R10), la sentinelle des domaines (D7), et la connexion prouvée DANS la
 * fenêtre, sur la page des factures (R1).
 *
 * ⚠ Aucune donnée réelle ici : des adresses de forme, des numéros inventés.
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
const preuve = require('../server/connectors/preuve-connexion');
const remoteBrowser = require('../server/remote-browser');
const faux = require('./lot102-faux-site');

const RACINE = path.join(__dirname, '..');
const CONNECTEURS = path.join(RACINE, 'server', 'connectors');
const ID = 'eau-ile-de-france';

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot102admin', role: 'admin' });
  await helpers.createUser({ username: 'lot102user', role: 'user' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot102admin', 'MotDePasse1');
});

test.after(async () => {
  await client?.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// R7 — la fiche
// ---------------------------------------------------------------------------

test('R7 — la fiche : nom, domaine, catégorie des services d\'eau et d\'énergie, en attente, réserve, connexion par la fenêtre', () => {
  const m = registry.manifest(ID);
  const vue = schema.publicView(m);
  const categories = new Set(['edf', 'engie', 'atlanticeau'].map((id) => registry.manifest(id).category));
  assert.deepEqual([...categories], ['energie'], 'EDF, Engie et Atlantic\'eau sont en « energie »');
  assert.equal(m.category, 'energie');
  assert.equal(vue.name, 'Eau d\'Île-de-France');
  assert.equal(vue.site, 'connexion.leaudiledefrance.fr');
  assert.equal(m.initialStatus, 'pending', 'jamais exercé contre un compte réel');
  assert.equal(m.implementation, 'scraping');
  assert.equal(m.letters, 'EI', 'la pastille à initiales par défaut');
  assert.equal(m.color, schema.couleurParDefaut(ID), 'la couleur par défaut, stable');
  assert.equal(vue.technicalNote, undefined, 'la note technique reste à l\'administration');
  assert.match(m.technicalNote, /JAMAIS EXERCÉ CONTRE UN COMPTE RÉEL/);
  assert.match(m.technicalNote, /UN SEUL CLIC, UN SEUL GESTE/);
  // La réserve : en français simple, la connexion par la fenêtre, le seul contrat affiché.
  assert.match(vue.caveat, /vous vous connectez vous-même, dans une fenêtre/i);
  assert.match(vue.caveat, /seulement celles du contrat affiché/);
  assert.ok(vue.caveat.length <= 220, `${vue.caveat.length} caractères`);
  // Comme les « En cours » après le lot 101 : la réserve ne dit pas « pas encore
  // essayé » — la fiche d'un connecteur en attente le dit déjà, et l'essai du
  // lot 101 l'interdirait le jour où il passe « Fonctionnel ».
  assert.doesNotMatch(vue.caveat, /pas encore (?:été )?essayé|jamais (?:été )?essayé|essayé sur aucun compte/i);
  assert.equal(vue.description, 'Récupère automatiquement vos factures d\'eau de l\'Eau d\'Île-de-France.');
  assert.equal(m.informationConfiguration, undefined);
  assert.deepEqual(vue.fields.map((f) => f.key), ['session', 'historique']);
  for (const champ of vue.fields) assert.ok(champ.help, `aide du champ ${champ.key}`);
  assert.equal(m.fields.find((f) => f.key === 'session').required, false, 'le champ de session n\'est jamais requis');
  assert.equal(vue.discovery, false, 'aucune étape de choix');
  assert.deepEqual(m.permissions.map((p) => p.key), ['factures', 'identifiants']);
  // R1 : la fenêtre s'ouvre sur la page des factures, la preuve s'y lit.
  const url = 'https://connexion.leaudiledefrance.fr/espace-particuliers/s/factures';
  assert.equal(vue.remoteLogin.url, url, 'on arrive par l\'adresse de la page des factures');
  assert.equal(m.remoteLogin.verifyUrl, url);
  assert.equal(m.remoteLogin.preuveSurFenetre, true);
  assert.deepEqual(m.remoteLogin.marqueursFenetre, [{ selecteur: 'c-icl-contrat-factures-histo', texte: '' }]);
  assert.equal(m.remoteLogin.persistent, false, 'la session se rejoue sans écran');
  assert.equal(m.remoteLogin.verifyUrlTient, false, 'rien n\'est mesuré du renvoi des anonymes');
  assert.match(vue.remoteLogin.hint, /Quand la page de vos factures s'affiche, cliquez sur Enregistrer/);
  const { ok, errors } = schema.validate(JSON.parse(fs.readFileSync(path.join(CONNECTEURS, 'available', ID, 'manifest.json'), 'utf8')), ID);
  assert.ok(ok, errors.join('\n'));
});

test('R7 — l\'administrateur voit la fiche dans l\'ajout de connecteur, en attente, avec de quoi se connecter ; un compte ordinaire ne la voit pas', async () => {
  const res = await client.get('/api/connectors');
  assert.equal(res.status, 200);
  const fiche = (res.body.connectors || []).find((c) => c.id === ID);
  assert.ok(fiche, 'la fiche apparaît pour l\'administrateur');
  assert.equal(fiche.planned, false, 'ce n\'est plus une annonce');
  assert.equal(fiche.catalogStatus, 'pending', 'en attente d\'un essai réel');
  assert.ok(fiche.remoteLogin && fiche.remoteLogin.url, 'le bouton « Se connecter à … » naît de remoteLogin');
  const autre = await helpers.startServer();
  try {
    await helpers.login(autre, 'lot102user', 'MotDePasse1');
    const vue = await autre.get('/api/connectors');
    assert.equal(vue.status, 200);
    assert.equal((vue.body.connectors || []).some((c) => c.id === ID), false, 'invisible à un compte ordinaire');
  } finally {
    await autre.close();
  }
});

// ---------------------------------------------------------------------------
// L'annonce n'existe plus — les quatre gestes, et R10
// ---------------------------------------------------------------------------

test('R7 — l\'annonce n\'existe plus : dossier planned/ retiré, gen-planned.js purgé, ligne de catalogue en attente', () => {
  assert.equal(fs.existsSync(path.join(CONNECTEURS, 'planned', ID)), false);
  const gen = fs.readFileSync(path.join(RACINE, 'scripts', 'gen-planned.js'), 'utf8');
  assert.equal(/id:\s*'eau-ile-de-france'/.test(gen), false, 'relancer gen-planned.js ne doit pas ressusciter l\'annonce');
  assert.equal(registry.isPlanned(ID), false);
  const db = require('../server/db/db');
  assert.deepEqual(db.get().prepare('SELECT category, status FROM connector_catalog WHERE connector_id = ?').get(ID),
    { category: 'energie', status: 'pending' });
});

test('R10 — un seul connecteur naît : 60 chargés, 29 annoncés (28 depuis le lot 103), aucune erreur de chargement', () => {
  const r = registry.load();
  assert.deepEqual(r.errors, []);
  // Lot 103 : l'annonce BetterMe est supprimée — une annonce de moins. Lot
  // 104 : Battle.net, Alma et Private Sport Shop quittent les annonces.
  assert.equal(r.loaded, 63);
  assert.equal(r.planned, 25);
  assert.equal(registry.has(ID), true);
});

// ---------------------------------------------------------------------------
// D8 — la migration 61
// ---------------------------------------------------------------------------

test('D8 — la migration 61 remet en attente la ligne « available » héritée de l\'annonce, jamais une ligne publiée ; une seconde application ne change rien', () => {
  const { MIGRATIONS } = require('../server/db/migrations');
  const m61 = MIGRATIONS.find((m) => m.id === 61);
  assert.ok(m61, 'la migration 61 existe');
  assert.match(m61.name, /Eau d'Île-de-France/);
  // La dernière jusqu'au lot 103, dont la migration 62 retire BetterMe.
  assert.ok(Math.max(...MIGRATIONS.map((m) => m.id)) >= 61, 'elle reste dans la liste');
  const Database = require('better-sqlite3');
  const base = new Database(':memory:');
  try {
    base.exec(`CREATE TABLE connector_catalog (connector_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', published_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const ajouter = base.prepare('INSERT INTO connector_catalog (connector_id, category, status, published_at) VALUES (?, ?, ?, ?)');
    ajouter.run(ID, 'energie', 'available', null);
    ajouter.run('saur', 'energie', 'available', null);
    m61.up(base);
    const statut = (id) => base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get(id).status;
    assert.equal(statut(ID), 'pending');
    assert.equal(statut('saur'), 'available', 'aucune autre ligne ne bouge');
    m61.up(base);
    assert.equal(statut(ID), 'pending', 'idempotente');
    base.prepare('UPDATE connector_catalog SET status = \'available\', published_at = datetime(\'now\') WHERE connector_id = ?').run(ID);
    m61.up(base);
    assert.equal(statut(ID), 'available', 'une approbation humaine n\'est jamais reprise');
  } finally {
    base.close();
  }
});

test('D8 — par le chemin réel : une base d\'avant ce lot (migration 60) où l\'annonce porte « available » passe en attente ; relancer n\'applique rien', () => {
  const migrations = require('../server/db/migrations');
  const Database = require('better-sqlite3');
  const base = new Database(':memory:');
  try {
    // Le schéma et les migrations, comme `db.open` les pose…
    base.exec(fs.readFileSync(path.join(RACINE, 'server', 'db', 'schema.sql'), 'utf8'));
    migrations.apply(base);
    // … puis la base ramenée à l'état d'avant le lot 102 : la migration 61
    // jamais passée, la ligne héritée de l'annonce en « available », non publiée.
    base.prepare('DELETE FROM schema_migrations WHERE id = 61').run();
    base.prepare('INSERT OR REPLACE INTO connector_catalog (connector_id, category, status, published_at) VALUES (?, ?, ?, ?)')
      .run(ID, 'energie', 'available', null);
    const avant = base.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;
    const appliquees = migrations.apply(base);
    assert.deepEqual(appliquees.applied.map((m) => m.id), [61], `appliquées : ${JSON.stringify(appliquees)}`);
    // `current` est la dernière migration de la liste : 61 au lot 102, 62 depuis le lot 103.
    assert.equal(appliquees.current, Math.max(...migrations.MIGRATIONS.map((m) => m.id)));
    assert.equal(base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get(ID).status, 'pending');
    assert.equal(base.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n, avant, 'aucune ligne créée ni retirée');
    assert.deepEqual(migrations.apply(base).applied, [], 'une seconde application ne fait rien');
    assert.equal(base.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    base.close();
  }
});

// ---------------------------------------------------------------------------
// R9 — la page des connecteurs, régénérée par son générateur
// ---------------------------------------------------------------------------

function groupe(nom) {
  const ids = [];
  let dedans = false;
  for (const ligne of fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8').split('\n')) {
    if (/^## /.test(ligne)) {
      dedans = new RegExp(`^## ${nom} \\(\\d+\\)$`).test(ligne);
      continue;
    }
    const icone = dedans && /^\| <img src="icones\/([a-z0-9-]+)\.png"/.exec(ligne);
    if (icone) ids.push(icone[1]);
  }
  return ids;
}

// Lot 105 — par décision du compte observé, l'Eau d'Île-de-France passe « Fonctionnels »
// (elle a récupéré ses factures sur l'installation de qui l'a essayée) : cet
// essai la suit. Ce qu'il gardait — plus « Proposés », son icône — tient.
test('R9 — la page des connecteurs : l\'Eau d\'Île-de-France est « Fonctionnels » (lot 105, décision du compte observé), plus « Proposés »', () => {
  assert.ok(groupe('Fonctionnels').includes(ID));
  assert.equal(groupe('En cours').includes(ID), false);
  assert.equal(groupe('Proposés').includes(ID), false);
  assert.ok(fs.existsSync(path.join(RACINE, 'docs', 'icones', `${ID}.png`)), 'son icône reste celle du lot 97');
});

// ---------------------------------------------------------------------------
// D7 — la sentinelle du lot 99 couvre les domaines du site
// ---------------------------------------------------------------------------

test('D7 — la sentinelle de la suite couvre leaudiledefrance.fr et les domaines Salesforce : une requête servie par un banc y est « vue », sans fuite', faux.SANS_NAVIGATEUR, () => {
  const releve = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lot102-garde-')), 'releve.txt');
  const hotes = ['connexion.leaudiledefrance.fr', 'rock-vedif.my.site.com', 'rock-vedif.my.salesforce.com',
    'rock-vedif.file.force.com', 'rock-vedif--c.visualforce.com'];
  // Un processus à part, sentinelle chargée comme pour la suite : un vrai
  // Chromium dont TOUTES les requêtes sont servies par une route — rien ne sort.
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
  for (const h of hotes) assert.ok(lignes.some((l) => l.endsWith(` ${h}`) && l.startsWith('vue ')), `${h} est surveillé : ${lignes.join(' | ')}`);
  assert.equal(lignes.filter((l) => l.startsWith('FUITE')).length, 0, 'aucune réponse venue du réseau');
  fs.rmSync(path.dirname(releve), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// L'ombre synthétique imitée : la page ne se lit pas par le document
// ---------------------------------------------------------------------------

test('le banc imite l\'ombre synthétique : dans la page, `document.querySelectorAll` ne voit ni l\'historique ni ses icônes ; le moteur de Playwright voit tout', faux.SANS_NAVIGATEUR, async () => {
  const { page, fermer } = await faux.ouvrirLaPage(faux.compteEau());
  try {
    await page.goto(`https://${faux.HOTE}${faux.CHEMIN_FACTURES}`);
    await page.locator('c-icl-contrat-factures-histo .slds-grid div.download').first().waitFor();
    const dansLaPage = await page.evaluate(() => ({
      historiques: document.querySelectorAll('c-icl-contrat-factures-histo').length,
      icones: document.querySelectorAll('div.download').length,
      parLeCorps: document.body.querySelectorAll('div.download').length,
      parId: document.getElementById('historique'),
      lignes: document.getElementsByClassName('slds-p-around_medium').length,
    }));
    assert.deepEqual(dansLaPage, { historiques: 0, icones: 0, parLeCorps: 0, parId: null, lignes: 0 },
      'une lecture par le document de la page ne verrait rien');
    assert.equal(await page.locator('c-icl-contrat-factures-histo').count(), 1);
    assert.equal(await page.locator('c-icl-contrat-factures-histo div.download').count(), 4, 'trois lignes et l\'icône au numéro non lu');
    assert.equal(await page.locator('div.download').count(), 5, 'et celle hors de l\'historique');
  } finally {
    await fermer();
  }
});

// ---------------------------------------------------------------------------
// R1 — la connexion prouvée DANS la fenêtre, sur la page des factures
// ---------------------------------------------------------------------------

/**
 * Le gestionnaire de la fenêtre de connexion, le VRAI (`createManager`), dont
 * seuls les processus système sont simulés (la recette du lot 49) — et dont la
 * fenêtre est une vraie page Chromium sur le faux site.
 */
function gestionnaire(fenetre) {
  const existants = new Set(['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify', '/usr/share/novnc/core/rfb.js']);
  const fsSimule = {
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => { if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`); },
    readdirSync: () => { throw new Error('ENOENT'); },
    readFileSync: () => { throw new Error('ENOENT'); },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => { existants.add(String(p)); return String(p); },
    rmSync: (p) => existants.delete(String(p)),
  };
  const journal = [];
  const lancementsHeadless = [];
  const manager = remoteBrowser.createManager({
    fs: fsSimule,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: (command, args) => {
      if (command === 'Xvfb') {
        const affichage = /^:(\d+)$/.exec(String(args[0]))?.[1];
        if (affichage) existants.add(`/tmp/.X11-unix/X${affichage}`);
      }
      return { command, args: args.map(String), stdout: { resume: () => {} }, stderr: { resume: () => {} }, on: () => {}, kill: () => {} };
    },
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    launchBrowser: async ({ url }) => {
      await fenetre.page.goto(url);
      return {
        page: fenetre.page,
        context: fenetre.contexte,
        storageState: () => fenetre.contexte.storageState(),
        close: async () => {},
      };
    },
    requirePlaywright: () => ({
      chromium: {
        launch: async () => {
          lancementsHeadless.push('headless');
          throw new Error('aucun contrôle headless ne doit se lancer : la preuve se lit dans la fenêtre');
        },
      },
    }),
    timeoutMs: 120_000,
    pollMs: 200,
  });
  return { manager, journal, lancementsHeadless };
}

async function ouvrirLaFenetre(g, captures) {
  const m = registry.manifest(ID);
  await g.manager.start({
    userId: 1,
    connectorId: ID,
    connectorName: m.name,
    url: m.remoteLogin.url,
    marker: '',
    verifyUrl: m.remoteLogin.verifyUrl,
    preuveSurFenetre: m.remoteLogin.preuveSurFenetre,
    marqueursFenetre: m.remoteLogin.marqueursFenetre,
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  });
}

async function enregistrer(manager) {
  let r = await manager.saveNow(1, ID);
  if (!r.ok && /Rien n'a encore été saisi/.test(r.error || '')) r = await manager.saveNow(1, ID);
  // Lot 104 : sous la charge de la suite entière, l'essai pouvait demander
  // l'enregistrement avant que la fenêtre soit prête (tombé une fois à l'entrée
  // du lot 104, « La fenêtre n'est pas prête — patientez un instant. ») —
  // comme un utilisateur, il patiente un instant (dix secondes au plus).
  for (let i = 0; i < 20 && !r.ok && /pas prête/.test(r.error || ''); i++) {
    await new Promise((fin) => setTimeout(fin, 500));
    r = await manager.saveNow(1, ID);
  }
  return r;
}

test('R1 — dans la fenêtre, sur la page des factures dessinée : la connexion est prouvée par l\'adresse et `c-icl-contrat-factures-histo`, sans aucun contrôle sans écran', faux.SANS_NAVIGATEUR, async () => {
  const fenetre = await faux.ouvrirLaPage(faux.compteEau());
  const g = gestionnaire(fenetre);
  const captures = [];
  try {
    await ouvrirLaFenetre(g, captures);
    await fenetre.page.locator('c-icl-contrat-factures-histo .slds-grid div.download').first().waitFor();
    // La page de la fenêtre imite l'ombre synthétique : une requête du document
    // n'y voit pas l'historique ; le marqueur, compté par le moteur de
    // Playwright, si.
    assert.equal(await fenetre.page.evaluate(() => document.querySelector('c-icl-contrat-factures-histo')), null);
    assert.equal(preuve.adresseTenue(fenetre.page.url(), registry.manifest(ID).remoteLogin.verifyUrl), true);
    const r = captures.length ? { ok: true } : await enregistrer(g.manager);
    assert.equal(r.ok, true, `attendu : enregistré — reçu : ${r.error || 'ok'}`);
    assert.equal(captures.length, 1);
    assert.equal(g.lancementsHeadless.length, 0, 'aucun contrôle par rejeu sans écran');
    const ligne = g.journal.find((l) => /marqueur mesuré/.test(l.message));
    assert.ok(ligne, `la preuve par marqueur est journalisée : ${g.journal.map((l) => l.message).join(' | ')}`);
    assert.match(ligne.message, /\(c-icl-contrat-factures-histo\), lu sans requête supplémentaire/);
    assert.deepEqual(fenetre.journal.clics, [], 'la fenêtre n\'a rien cliqué');
  } finally {
    await g.manager.stop(1, ID).catch(() => {});
    await fenetre.fermer();
  }
});

test('R1 — dans la fenêtre, la page de connexion : rien ne s\'enregistre', faux.SANS_NAVIGATEUR, async () => {
  const fenetre = await faux.ouvrirLaPage(faux.compteEau({ connecte: false }), { session: false });
  const g = gestionnaire(fenetre);
  const captures = [];
  try {
    await ouvrirLaFenetre(g, captures);
    await fenetre.page.waitForURL(/\/espace-particuliers\/s\/login\//);
    const r = await enregistrer(g.manager);
    assert.equal(r.ok, false);
    assert.equal(captures.length, 0, 'une page de connexion ne prouve rien');
    assert.equal(g.lancementsHeadless.length, 0);
  } finally {
    await g.manager.stop(1, ID).catch(() => {});
    await fenetre.fermer();
  }
});
