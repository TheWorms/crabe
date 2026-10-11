'use strict';

/**
 * Lot 99 — ce qui vaut pour les trois boutiques : aucun clic, aucune saisie
 * (le code se LIT) ; les adresses interdites ; les fiches (R6) ; Le Petit
 * Vapoteur qui quitte les annonces ; les gardes qui empêchent un vrai
 * navigateur de partir vers les trois boutiques.
 *
 * ⚠ Aucune donnée réelle ici : des adresses de forme, des numéros inventés.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const interdites = require('../server/connectors/adresses-interdites');
const alfaliquid = require('../server/connectors/available/alfaliquid/connector');
const lpv = require('../server/connectors/available/le-petit-vapoteur/connector');
const eliq = require('../server/connectors/available/e-liquide-fr/connector');
const outils = require('./lot99-outils');

const RACINE = path.join(__dirname, '..');
const CONNECTEURS = path.join(RACINE, 'server', 'connectors');
const IDS = ['alfaliquid', 'le-petit-vapoteur', 'e-liquide-fr'];
const source = (id) => path.join(CONNECTEURS, 'available', id, 'connector.js');

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot99admin', role: 'admin' });
  await helpers.createUser({ username: 'lot99user', role: 'user' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot99admin', 'MotDePasse1');
});

test.after(async () => {
  await client?.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// B2 / D5 — par construction : le code des trois connecteurs se LIT
// ---------------------------------------------------------------------------

test('D5 — par construction : aucun des trois fichiers ne porte un clic, une saisie, une touche, ni un client HTTP hors du navigateur', () => {
  for (const id of IDS) {
    const code = outils.codeSansCommentaires(source(id));
    for (const geste of [/\.click\s*\(/, /\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/,
      /\.check\s*\(/, /\.uncheck\s*\(/, /\.selectOption\s*\(/, /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/,
      /\.requestSubmit\s*\(/, /\.tap\s*\(/, /\.hover\s*\(/, /\.focus\s*\(/, /keyboard\./, /mouse\./,
      /touchscreen\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.\$\$?\s*\(/, /\.accept\s*\(/,
      /waitForEvent\s*\(\s*['"]download/, /\beval\s*\(/, /new\s+Function\s*\(/]) {
      assert.doesNotMatch(code, geste, `${id} : aucun geste (${geste})`);
    }
    assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch/,
      `${id} : aucun client HTTP hors du navigateur`);
    assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, `${id} : une seule fonction navigue`);
    assert.match(code, /async function naviguer\(page, adresse\) \{\n(?:.*\n){0,2}\s+const mot = interdites\.motInterdit\(adresse\);/,
      `${id} : la navigation passe d'abord par les adresses interdites`);
  }
});

test('D5 — les envois : AUCUN chez Alfaliquid et Le Petit Vapoteur ; UN chez e-liquide-fr, dans la seule fonction ENVOYER_LE_FORMULAIRE', () => {
  for (const id of ['alfaliquid', 'le-petit-vapoteur']) {
    const code = outils.codeSansCommentaires(source(id));
    assert.doesNotMatch(code, /\.submit\b/, `${id} : aucun envoi de formulaire`);
    assert.doesNotMatch(code, /\.pdf\s*\(/, `${id} : rien n'est imprimé, le PDF vient de la boutique`);
    assert.match(code, /ongletPdf\.fluxDeLaPage\(page, /, `${id} : le PDF se prend dans l'onglet`);
  }
  const code = outils.codeSansCommentaires(source('e-liquide-fr'));
  const envois = [...code.matchAll(/\.submit\b/g)];
  assert.equal(envois.length, 1, 'un seul envoi de formulaire dans tout le fichier');
  const debut = code.indexOf('const ENVOYER_LE_FORMULAIRE = ');
  const fin = code.indexOf('\n};', debut);
  assert.ok(debut >= 0 && fin > debut, 'la fonction d\'envoi existe');
  assert.ok(envois[0].index > debut && envois[0].index < fin, 'et l\'envoi est DANS elle');
  assert.match(code.slice(debut, fin), /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  // Ses contrôles sont tous AVANT l'envoi (indexOf >= 0 : une garde disparue ne passe pas pour « avant »).
  const corps = code.slice(debut, fin);
  const envoi = corps.indexOf('HTMLFormElement.prototype.submit');
  for (const garde of ['adresse !== action', "!== 'post'", "reload[0] !== '0'", 'OrderID non nul', 'JSON.stringify(actuels) !== JSON.stringify(servis)']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < envoi, `la garde « ${garde} » est présente, et avant l'envoi`);
  }
  assert.equal((code.match(/ENVOYER_LE_FORMULAIRE,/g) || []).length, 2, 'appelée par envoyerLeFormulaire seule (et exportée)');
  assert.equal((code.match(/\.pdf\s*\(/g) || []).length, 1, 'une seule impression : celle de la facture');
  assert.doesNotMatch(code, /addStyleTag|addScriptTag|innerHTML\s*=|\.remove\(\)|style\.|setContent/,
    'la page de la facture n\'est jamais modifiée avant l\'impression');
});

test('D5 — aucun javascript: n\'est suivi : le lien « facture » se lit, il ne s\'exécute pas', () => {
  const code = outils.codeSansCommentaires(source('e-liquide-fr'));
  assert.match(code, /if \(\/\^\\s\*javascript\\s\*:\/i\.test\(String\(adresse\)\)\) throw/, 'naviguer refuse tout javascript:');
  assert.match(code, /getAttribute\('href'\)/, 'les liens sont lus comme du texte');
});

// ---------------------------------------------------------------------------
// D5 — la liste des mots interdits, et chaque porte qui la consulte
// ---------------------------------------------------------------------------

test('D5 — les mots interdits : exactement ceux du §1, et chacun refusé par les trois connecteurs, même dans un lien de facture ou un WNDAPIOpenWindow', () => {
  assert.deepEqual([...interdites.MOTS_INTERDITS],
    ['submitReorder', 'ReloadOrderID', 'PBShoppingCart', 'reOrder', 'panier', 'cart', 'order-follow', 'return']);
  assert.ok(Object.isFrozen(interdites.MOTS_INTERDITS), 'la liste ne s\'allonge ni ne raccourcit hors de son fichier');
  for (const mot of interdites.MOTS_INTERDITS) {
    assert.equal(interdites.motInterdit(`https://exemple.invalid/x?${mot}=1`), mot, mot);
    assert.ok(interdites.motInterdit(`https://exemple.invalid/x?${mot.toUpperCase()}=1`), `${mot} en capitales`);
    assert.ok(interdites.motInterdit(`https://exemple.invalid/x?${encodeURIComponent(mot).replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`)}=1`),
      `${mot} encodé`);
    // Alfaliquid : glissé dans un lien de facture.
    assert.ok(alfaliquid.lienDeFacture(`https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=7&x=${mot}`)?.refus,
      `alfaliquid refuse « ${mot} »`);
    // Le Petit Vapoteur : glissé dans la forme mal formée.
    assert.ok(lpv.lienDeFacture(`https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=7&x=${mot}`)?.refus,
      `le-petit-vapoteur refuse « ${mot} »`);
    // e-liquide-fr : glissé dans l'appel WNDAPIOpenWindow du lien « facture ».
    const chemin = eliq.cheminDeLAppel(`javascript:WNDAPIOpenWindow('InvoiceView','Files/1/${mot}/Invoice-2026-01-7.htm',800,600)`);
    assert.ok(eliq.adresseDeFacture(chemin)?.refus, `e-liquide-fr refuse « ${mot} »`);
  }
  // Les adresses légitimes des trois boutiques passent.
  for (const ok of [alfaliquid.URL_LISTE, lpv.URL_LISTE, eliq.URL_COMPTE, eliq.ACTION_ATTENDUE,
    'https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=7',
    'https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=7',
    'https://www.e-liquide-fr.com/Files/1/Orders/2/Invoice-2026-01-7.htm',
    ...IDS.map((id) => registry.manifest(id).remoteLogin.url), ...IDS.map((id) => registry.manifest(id).remoteLogin.verifyUrl)]) {
    assert.equal(interdites.motInterdit(ok), null, ok);
  }
});

test('le module des adresses interdites n\'est employé que par les trois connecteurs du lot 99', () => {
  const employeurs = [];
  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(chemin);
      else if (entree.name.endsWith('.js') && /adresses-interdites/.test(fs.readFileSync(chemin, 'utf8'))) {
        employeurs.push(path.relative(path.join(RACINE, 'server'), chemin));
      }
    }
  };
  parcourir(path.join(RACINE, 'server'));
  assert.deepEqual(employeurs.sort(), [
    'connectors/available/alfaliquid/connector.js',
    'connectors/available/e-liquide-fr/connector.js',
    'connectors/available/le-petit-vapoteur/connector.js',
  ]);
});

// ---------------------------------------------------------------------------
// D8 — les gardes : aucun vrai navigateur vers les trois boutiques
// ---------------------------------------------------------------------------

test('D8 — la garde des essais couvre les trois boutiques : par le registre, aucun navigateur ne s\'ouvre (CRABE_DISABLE_SCRAPING)', async () => {
  assert.equal(require('../server/config').config.scrapingDisabled, true, 'posé par test/helpers.js pour toute la suite');
  for (const id of IDS) {
    const instance = registry.get(id).module;
    const lancer = instance.ouverture.lancer;
    let lance = 0;
    instance.ouverture.lancer = () => { lance++; throw new Error('essai : lancement interdit'); };
    try {
      await assert.rejects(registry.fetchInvoicesDetailed(id, { session: '{}' }, { userId: 1 }),
        /Le scraping est désactivé sur cette installation/, `${id} : refusé avant tout navigateur`);
      const t = await registry.test(id, { session: '{}' }, { userId: 1 });
      assert.equal(t.ok, false);
      assert.equal(lance, 0, `${id} : le lanceur n'a jamais été appelé`);
    } finally {
      instance.ouverture.lancer = lancer;
    }
  }
});

test('D8 — chaque connecteur n\'ouvre de navigateur que par son point remplaçable (ouverture.lancer), et sans écran', () => {
  for (const [id, mod] of [['alfaliquid', alfaliquid], ['le-petit-vapoteur', lpv], ['e-liquide-fr', eliq]]) {
    const code = outils.codeSansCommentaires(source(id));
    assert.equal((code.match(/chromium\.launch\s*\(/g) || []).length, 1, `${id} : un seul lancement`);
    assert.match(code, /lancer: \(\) => requirePlaywright\(\)\.chromium\.launch\(identity\.optionsLancement\(\)\)/);
    assert.doesNotMatch(code, /launchPersistentContext|profilMarchand\.surLeProfil/, `${id} : ni profil persistant, ni Xvfb`);
    assert.equal(typeof mod.ouverture.lancer, 'function');
  }
});

// ---------------------------------------------------------------------------
// R6 — les fiches
// ---------------------------------------------------------------------------

const ATTENDU = {
  alfaliquid: {
    name: 'Alfaliquid', site: 'www.alfaliquid.com', letters: 'AL',
    login: 'https://www.alfaliquid.com/fr/index.php?controller=authentication',
    verify: 'https://www.alfaliquid.com/fr/historique-commandes', marqueur: 'body#history',
  },
  'le-petit-vapoteur': {
    name: 'Le Petit Vapoteur', site: 'www.lepetitvapoteur.com', letters: 'PV',
    login: 'https://www.lepetitvapoteur.com/fr/authentification?back=/fr/',
    verify: 'https://www.lepetitvapoteur.com/fr/historique-des-commandes', marqueur: 'body#history',
  },
  'e-liquide-fr': {
    name: 'e-liquide-fr', site: 'www.e-liquide-fr.com', letters: 'EL',
    login: 'https://www.e-liquide-fr.com/PBUserLogin.asp?CCode=33',
    verify: 'https://www.e-liquide-fr.com/PBUserAccount.asp', marqueur: 'html.is-user-logged',
  },
};

test('R6 — les trois fiches : nom, domaine, pastille générique, catégorie des boutiques, réserve, aide ; la note technique ne sort pas ; aucune fenêtre d\'information', () => {
  const categoriesBoutiques = new Set(['kubii', 'aagaard', 'decathlon', 'bricomarche'].map((id) => registry.manifest(id).category));
  assert.deepEqual([...categoriesBoutiques], ['shopping'], 'les autres boutiques sont en « shopping »');
  for (const id of IDS) {
    const m = registry.manifest(id);
    const vue = schema.publicView(m);
    const a = ATTENDU[id];
    assert.equal(vue.name, a.name);
    assert.equal(vue.site, a.site, `${id} : le domaine de la boutique`);
    assert.equal(vue.category, 'shopping');
    assert.equal(m.letters, a.letters, `${id} : la pastille à initiales par défaut`);
    assert.equal(m.color, schema.couleurParDefaut(id), `${id} : la couleur par défaut, stable`);
    assert.equal(m.initialStatus, 'pending', `${id} : jamais exercé contre un compte réel`);
    assert.equal(m.implementation, 'scraping');
    assert.equal(vue.technicalNote, undefined, `${id} : la note technique reste à l'administration`);
    assert.match(m.technicalNote, /JAMAIS EXERCÉ CONTRE UN COMPTE RÉEL/);
    // Lot 101 : les trois ont rangé des documents sur un vrai compte (mesuré en
    // production) — la réserve ne le nie plus, et garde la connexion par fenêtre.
    assert.doesNotMatch(vue.caveat, /Pas encore essayé/);
    assert.match(vue.caveat, /vous vous connectez vous-même,? dans une fenêtre/i);
    assert.ok(vue.caveat.length <= 220);
    assert.match(vue.description, /^Récupère automatiquement les factures de vos (commandes|achats) /);
    assert.equal(m.informationConfiguration, undefined, `${id} : pas de fenêtre d'information de configuration`);
    assert.deepEqual(vue.fields.map((f) => f.key), ['session', 'historique']);
    for (const champ of vue.fields) assert.ok(champ.help, `${id} : aide du champ ${champ.key}`);
    assert.equal(vue.discovery, false, `${id} : aucune étape de choix`);
    assert.equal(vue.remoteLogin.url, a.login, `${id} : l'adresse de connexion`);
    assert.match(vue.remoteLogin.hint, /cliquez sur Enregistrer/);
    assert.deepEqual(m.permissions.map((p) => p.key), ['factures', 'identifiants']);
    // La vérification à l'enregistrement : lue dans la fenêtre, sur le marqueur mesuré.
    assert.equal(m.remoteLogin.verifyUrl, a.verify);
    assert.equal(m.remoteLogin.preuveSurFenetre, true);
    assert.deepEqual(m.remoteLogin.marqueursFenetre, [{ selecteur: a.marqueur, texte: '' }], 'normalisé par le schéma');
    assert.equal(m.remoteLogin.persistent, false, `${id} : la session se rejoue sans écran — page.pdf n'existe que là`);
    assert.equal(m.remoteLogin.verifyUrlTient, false, `${id} : rien n'est mesuré du renvoi des anonymes`);
    assert.equal(m.remoteLogin.renvoiAnonyme, '');
  }
  assert.equal(registry.manifest('le-petit-vapoteur').remoteLogin.langueNative, true,
    'la fenêtre du Petit Vapoteur, derrière Cloudflare, prend le français sans la langue forcée (lot 91)');
  assert.equal(registry.manifest('alfaliquid').remoteLogin.langueNative, false);
});

test('R6 — l\'administrateur voit les trois fiches dans l\'ajout de connecteur, en attente, avec de quoi se connecter ; un compte ordinaire ne les voit pas', async () => {
  const res = await client.get('/api/connectors');
  assert.equal(res.status, 200);
  for (const id of IDS) {
    const fiche = (res.body.connectors || []).find((c) => c.id === id);
    assert.ok(fiche, `${id} : la fiche apparaît pour l'administrateur`);
    assert.equal(fiche.planned, false, `${id} : ce n'est pas une annonce`);
    assert.equal(fiche.catalogStatus, 'pending', `${id} : en attente d'un essai réel`);
    assert.equal(fiche.name, ATTENDU[id].name);
    assert.ok(fiche.remoteLogin && fiche.remoteLogin.url, `${id} : le bouton « Se connecter à … » naît de remoteLogin`);
  }
  const autre = await helpers.startServer();
  try {
    await helpers.login(autre, 'lot99user', 'MotDePasse1');
    const vue = await autre.get('/api/connectors');
    assert.equal(vue.status, 200);
    for (const id of IDS) {
      assert.equal((vue.body.connectors || []).some((c) => c.id === id), false, `${id} : invisible à un compte ordinaire`);
    }
  } finally {
    await autre.close();
  }
});

// ---------------------------------------------------------------------------
// Le Petit Vapoteur quitte les annonces (les quatre gestes)
// ---------------------------------------------------------------------------

test('Le Petit Vapoteur n\'est plus une annonce : dossier planned/ retiré, gen-planned.js purgé, ligne de catalogue en attente', () => {
  assert.equal(fs.existsSync(path.join(CONNECTEURS, 'planned', 'le-petit-vapoteur')), false);
  const gen = fs.readFileSync(path.join(RACINE, 'scripts', 'gen-planned.js'), 'utf8');
  assert.equal(/id:\s*'le-petit-vapoteur'/.test(gen), false, 'relancer gen-planned.js ne doit pas ressusciter l\'annonce');
  assert.equal(registry.isPlanned('le-petit-vapoteur'), false);
  const db = require('../server/db/db');
  for (const id of IDS) {
    assert.deepEqual(db.get().prepare('SELECT category, status FROM connector_catalog WHERE connector_id = ?').get(id),
      { category: 'shopping', status: 'pending' }, id);
  }
});

test('la migration 60 remet en attente la ligne « available » héritée de l\'annonce, jamais une ligne publiée', () => {
  const { MIGRATIONS } = require('../server/db/migrations');
  const m60 = MIGRATIONS.find((m) => m.id === 60);
  assert.ok(m60, 'la migration 60 existe');
  assert.match(m60.name, /Le Petit Vapoteur/);
  // C'était la dernière au lot 99 ; le lot 102 ajoute la 61 (l'Eau d'Île-de-France).
  assert.ok(Math.max(...MIGRATIONS.map((m) => m.id)) >= 60, 'elle reste dans la liste');
  const Database = require('better-sqlite3');
  const base = new Database(':memory:');
  try {
    base.exec(`CREATE TABLE connector_catalog (connector_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', published_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    base.prepare('INSERT INTO connector_catalog (connector_id, category, status, published_at) VALUES (?, ?, ?, ?)')
      .run('le-petit-vapoteur', 'shopping', 'available', null);
    m60.up(base);
    assert.equal(base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get('le-petit-vapoteur').status, 'pending');
    base.prepare("UPDATE connector_catalog SET status = 'available', published_at = datetime('now')").run();
    m60.up(base);
    assert.equal(base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get('le-petit-vapoteur').status, 'available',
      'une approbation humaine n\'est jamais reprise');
  } finally {
    base.close();
  }
});

test('seuls trois connecteurs naissent : 59 chargés, 30 annoncés au lot 99 (60 et 29 depuis le lot 102), aucune erreur de chargement', () => {
  const r = registry.load();
  assert.deepEqual(r.errors, []);
  // Lot 102 : l'Eau d'Île-de-France quitte les annonces — un chargé de plus,
  // une annonce de moins. Les trois boutiques restent chargées (ci-dessous).
  assert.equal(r.loaded, 60);
  assert.equal(r.planned, 29);
  for (const id of IDS) assert.equal(registry.has(id), true, id);
});
