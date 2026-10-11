'use strict';

/**
 * Lot 20 — les sept connecteurs écrits mais pas encore testés.
 *
 * ─── Le blocage que ce lot lève ──────────────────────────────────────────────
 *
 * Les lots 16 à 19 exigeaient une facture réelle avant de sortir un connecteur
 * de `planned/`. Règle saine, mais circulaire : un connecteur annoncé n'est pas
 * chargé, donc pas installable, donc jamais testable, donc jamais écrit. Sept
 * services sont restés bloqués là, page de connexion parfaitement relevée et
 * rien derrière.
 *
 * Ils vivent désormais dans `available/`, avec `initialStatus: pending`. Le
 * garde-fou n'a pas disparu, il a changé de forme : le code est chargé et
 * installable par l'administrateur, mais le service n'est proposé à PERSONNE
 * d'autre tant qu'aucune facture réelle n'a été récupérée.
 *
 * ─── Ce que ce fichier vérifie ───────────────────────────────────────────────
 *
 * Que la promesse tient, exactement, dans les deux sens : ces connecteurs sont
 * installables par l'administrateur (sans quoi le blocage n'aurait pas bougé),
 * et invisibles pour tout le monde d'autre (sans quoi le garde-fou n'existerait
 * plus). Et qu'aucun d'eux ne PRÉTEND fonctionner : la note technique le dit,
 * la réserve le dit, l'interface le dit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const migrations = require('../server/db/migrations');

/**
 * Les sept du lot 20 — c'est cette liste-là que la migration 23 vise.
 *
 * ⚠ Ils ne sont plus que quatre, et les trois départs disent chacun une chose
 * différente. Invoice Ninja a été RETIRÉ du catalogue au lot 22 (migration 25).
 * Envato Market est REDEVENU un service annoncé au lot 23 (migration 26) : ni
 * la piste account.envato.com ni la piste themeforest.net n'ont abouti, et son
 * code est retiré plutôt que laissé installable. Bitstamp, lui, est SORTI par
 * le haut : quatre factures réelles récupérées le 13/08/2026, il est publié
 * (migration 27).
 *
 * Les migrations 23 et 25 les nomment toujours, et c'est volontaire — elles
 * décrivent ce qui s'est passé sur une base qui existait alors, et une
 * migration déjà appliquée ne se réécrit pas. Ici, en revanche, on énumère ce
 * que le catalogue porte AUJOURD'HUI.
 */
const SEPT = ['mistral', 'paypal', 'anthropic', 'hetzner'];

/** Les deux services ajoutés au lot 21, qui n'ont jamais été annoncés avant. */
const LOT_21 = ['infomaniak', 'proxmox'];

/** Tous ceux qui attendent leur premier essai réel. */
const EN_ATTENTE = [...SEPT, ...LOT_21];

/**
 * Ce que chacun doit demander à l'utilisateur, et rien d'autre.
 *
 * ⚠ Mistral a changé de méthode au lot 21, et ses champs avec : le compte se
 * connecte par Google, il ne demande donc plus de mot de passe — en réclamer un
 * serait réclamer une valeur qui ne servirait jamais.
 */
const CHAMPS_ATTENDUS = {
  mistral: ['session', 'historique'],
  paypal: ['clientId', 'clientSecret', 'historique'],
  anthropic: ['session', 'historique'],
  hetzner: ['session', 'historique'],
  // Lot 25 : Infomaniak découvre ses organisations, comme Free Mobile ses
  // lignes. Le champ n'est pas rempli par l'utilisateur — il est proposé
  // après connexion, et l'écran ne s'affiche que s'il y a un choix.
  infomaniak: ['session', 'organisations', 'historique'],
  proxmox: ['email', 'password', 'historique'],
};

let ordinaire;
let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot20', role: 'admin' });
  ordinaire = await helpers.createUser({ username: 'lot20-simple' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot20', 'MotDePasse1');
});

test.after(async () => {
  await client.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. Ils sont CHARGÉS — c'est tout l'objet du lot
// ---------------------------------------------------------------------------

test('les neuf sont chargés avec leur code, plus seulement annoncés', () => {
  for (const id of EN_ATTENTE) {
    assert.equal(registry.isPlanned(id), false, `${id} : ne doit plus être un simple manifeste`);
    const entree = registry.get(id);
    assert.ok(entree.module, `${id} : connector.js non chargé`);
    assert.equal(typeof entree.module.test, 'function', `${id} : test() manquant`);
    assert.equal(typeof entree.module.fetchInvoices, 'function', `${id} : fetchInvoices() manquant`);
  }
});

test('le chargement du registre ne signale aucune erreur', () => {
  const resultat = registry.load();
  assert.deepEqual(resultat.errors, [], resultat.errors.join(' / '));
});

// ---------------------------------------------------------------------------
// 2. Le garde-fou : pending, et rien d'autre
// ---------------------------------------------------------------------------

test('les neuf déclarent « en attente de test » dans leur manifeste', () => {
  for (const id of EN_ATTENTE) {
    assert.equal(
      registry.manifest(id).initialStatus,
      'pending',
      `${id} : sans initialStatus « pending », il serait proposé à tout le monde`
    );
  }
});

test('leur ligne de catalogue les tient en attente', () => {
  for (const id of EN_ATTENTE) {
    const ligne = helpers.db
      .get()
      .prepare('SELECT status FROM connector_catalog WHERE connector_id = ?')
      .get(id);
    assert.equal(ligne?.status, 'pending', `${id} : ligne de catalogue`);
  }
});

test('aucun compte ordinaire ne les voit', () => {
  const vus = new Set(registry.listForUser(ordinaire).map((c) => c.id));
  for (const id of EN_ATTENTE) {
    assert.equal(vus.has(id), false, `${id} : ne doit pas apparaître dans un Store ordinaire`);
  }
});

test('l\'administrateur, lui, les voit — et peut les installer', async () => {
  const res = await client.get('/api/connectors');
  assert.equal(res.status, 200);

  for (const id of EN_ATTENTE) {
    const tuile = res.body.connectors.find((c) => c.id === id);
    assert.ok(tuile, `${id} : absent du Store de l'administrateur — le blocage n'aurait pas bougé`);
    assert.equal(tuile.catalogStatus, 'pending', `${id} : la tuile doit pouvoir être marquée`);
    assert.equal(tuile.planned, false, `${id} : ce n'est plus une annonce, c'est installable`);
  }
});

test('ils sont comptés à part des services disponibles', async () => {
  const res = await client.get('/api/connectors');
  assert.ok(res.body.counts.pending >= EN_ATTENTE.length);
  const disponibles = res.body.connectors.filter(
    (c) => !c.planned && c.catalogStatus !== 'pending'
  ).length;
  assert.equal(res.body.counts.available, disponibles);
});

test('l\'installation aboutit, et le formulaire s\'affiche', async () => {
  for (const id of EN_ATTENTE) {
    const pose = await client.post(`/api/connectors/${id}/install`);
    assert.equal(pose.status, 200, `${id} : installation refusée — ${JSON.stringify(pose.body)}`);

    const fiche = await client.get(`/api/connectors/${id}`);
    assert.equal(fiche.status, 200, `${id} : fiche inaccessible`);
    assert.deepEqual(
      fiche.body.connector.fields.map((f) => f.key),
      CHAMPS_ATTENDUS[id],
      `${id} : les champs du formulaire ne sont pas ceux attendus`
    );

    await client.delete(`/api/connectors/${id}/install`);
  }
});

test('un compte ordinaire se voit refuser l\'installation, côté serveur', async () => {
  const autre = await helpers.startServer();
  try {
    await helpers.login(autre, 'lot20-simple', 'MotDePasse1');
    const res = await autre.post('/api/connectors/mistral/install');
    assert.equal(res.status, 403, 'le refus vit dans le serveur, pas seulement dans l\'interface');
  } finally {
    await autre.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Aucun ne PRÉTEND fonctionner
// ---------------------------------------------------------------------------

test('la note technique dit, en toutes lettres, qu\'aucun compte réel n\'a été essayé', () => {
  for (const id of EN_ATTENTE) {
    const note = String(registry.manifest(id).technicalNote || '');
    assert.match(
      note,
      /jamais exercé contre un compte réel/i,
      `${id} : la note technique ne doit pas laisser croire que ce connecteur a été validé`
    );
  }
});

test('chacun porte une réserve, lisible par quelqu\'un qui découvre le service', () => {
  for (const id of EN_ATTENTE) {
    const reserve = String(registry.manifest(id).caveat || '');
    assert.ok(reserve, `${id} : réserve manquante`);
    assert.ok(reserve.length <= 220, `${id} : réserve de ${reserve.length} caractères`);
    // La réserve est montrée à l'utilisateur : elle n'a rien à faire d'un
    // sélecteur CSS ni d'un nom de fichier.
    assert.equal(/[<>{}]|\.js\b|input\[/.test(reserve), false, `${id} : jargon dans la réserve`);
  }
});

test('la note technique ne sort jamais vers l\'utilisateur', async () => {
  for (const id of EN_ATTENTE) {
    await client.post(`/api/connectors/${id}/install`);
    const fiche = await client.get(`/api/connectors/${id}`);
    assert.equal(
      JSON.stringify(fiche.body).includes('JAMAIS EXERCÉ'),
      false,
      `${id} : la note technique a fuité dans la réponse`
    );
    await client.delete(`/api/connectors/${id}/install`);
  }
});

// ---------------------------------------------------------------------------
// 4. Les formulaires : chaque champ dit où trouver ce qu'il demande
// ---------------------------------------------------------------------------

test('chaque champ porte une aide, et aucune n\'est vide', () => {
  for (const id of EN_ATTENTE) {
    for (const champ of registry.manifest(id).fields) {
      assert.ok(
        String(champ.help || '').trim(),
        `${id}.${champ.key} : sans aide, personne ne sait où chercher cette valeur`
      );
    }
  }
});

test('les pièges de mise en service sont écrits là où on les lira', () => {
  const aide = (id, cle) =>
    String(registry.manifest(id).fields.find((f) => f.key === cle)?.help || '');

  // PayPal : le compte professionnel est une condition d'entrée, pas un détail.
  // Quelqu'un qui l'apprend après avoir créé une application a perdu sa soirée.
  assert.match(aide('paypal', 'clientId'), /professionnel/i);
  assert.match(aide('paypal', 'clientId'), /Transaction Search/);
  assert.match(aide('paypal', 'clientId'), /neuf heures/i);

  // PayPal, lot 23 : l'échec mesuré n'était pas Sandbox contre Live, c'était
  // une adresse e-mail saisie à la place d'un identifiant d'application. C'est
  // donc la PREMIÈRE ligne qui le dit — la seule qui reste visible sans
  // déplier l'aide (voir la règle de mise en page du lot 22).
  assert.match(
    aide('paypal', 'clientId').split('\n')[0],
    /adresse e-mail/i,
    'la confusion réellement constatée doit être la toute première chose lue'
  );
  assert.match(aide('paypal', 'clientSecret').split('\n')[0], /mot de passe/i);

  // Bitstamp : la clé neuve à activer, et la restriction par IP. Le premier
  // essai réel a montré que ce piège-là n'était pas assez en avant — c'est
  // désormais la toute première chose que le champ dit.
  assert.match(aide('bitstamp', 'apiKey'), /courriel/i);
  assert.match(aide('bitstamp', 'apiKey'), /adresse IP/i);
  assert.match(aide('bitstamp', 'apiKey'), /lecture/i);
  assert.match(
    aide('bitstamp', 'apiKey').split('\n')[0],
    /activ/i,
    'l\'activation par courriel doit être la PREMIÈRE ligne : c\'est l\'oubli constaté'
  );

  // PayPal : l'échec du 12/08/2026. L'avertissement Live/Sandbox était noyé au
  // milieu du texte ; il doit maintenant être annoncé d'emblée, ET répété sur
  // le secret — puisqu'on passe d'un onglet à l'autre pour lire les deux.
  assert.match(aide('paypal', 'clientId').slice(0, 400), /Live|Sandbox/);
  assert.match(aide('paypal', 'clientSecret'), /Live/);

  // Proxmox : trois comptes différents portent souvent la même adresse.
  assert.match(aide('proxmox', 'email'), /shop\.proxmox\.com/);
  assert.match(aide('proxmox', 'email'), /serveur/i);
});

test('chaque connexion ouverte à la main déclare où l\'ouvrir, et où l\'essayer', () => {
  const aSession = EN_ATTENTE.filter((id) =>
    registry.manifest(id).fields.some((f) => f.type === 'session'));

  // Quatre depuis le lot 23 : Anthropic et Hetzner du lot 20, Mistral qui y a
  // basculé au lot 21, et Infomaniak. Envato en faisait partie et n'y est plus
  // — son dossier est reparti dans `planned/`.
  assert.deepEqual(aSession.sort(), ['anthropic', 'hetzner', 'infomaniak', 'mistral']);

  for (const id of aSession) {
    const remote = registry.manifest(id).remoteLogin;
    assert.ok(remote, `${id} : remoteLogin manquant`);
    assert.match(remote.url, /^https:\/\//, `${id} : la page de connexion doit être en HTTPS`);
    assert.match(remote.verifyUrl, /^https:\/\//, `${id} : la page d'essai doit être en HTTPS`);
  }
});

test('aucun manifeste ne stocke de mot de passe là où il n\'y en a pas', () => {
  // Une connexion ouverte à la main ne laisse rien à saisir à un connecteur :
  // réclamer un mot de passe serait réclamer une valeur qui ne servirait
  // jamais — et qu'il faudrait pourtant garder chiffrée.
  for (const id of ['anthropic', 'hetzner', 'mistral', 'infomaniak']) {
    const types = registry.manifest(id).fields.map((f) => f.type);
    assert.equal(types.includes('password'), false, `${id} : champ mot de passe inutile`);
  }
});

// ---------------------------------------------------------------------------
// 5. Passer par Google ne doit pas rapporter la session Google (lot 21)
// ---------------------------------------------------------------------------

test('les connexions qui traversent un tiers ne gardent que leurs propres domaines', () => {
  // Mistral et Anthropic acceptent « Se connecter avec Google ». La photo de fin
  // de parcours emporterait sinon la session du fournisseur d'identité — de quoi
  // ouvrir une boîte de courriel, alors que crabe va chercher une facture.
  // ⚠ `claude.ai` et non `claude.com` depuis le lot 24 : ce connecteur a changé
  // de PRODUIT — il suit l'abonnement Claude, plus la console développeur. Le
  // domaine gardé doit suivre la cible, sinon la session enregistrée serait
  // vidée de ce qui sert et pleine de ce qui ne sert plus.
  const attendus = {
    mistral: ['mistral.ai'],
    anthropic: ['claude.ai', 'anthropic.com'],
  };

  for (const [id, domaines] of Object.entries(attendus)) {
    assert.deepEqual(registry.manifest(id).remoteLogin.keepDomains, domaines, `${id}`);
    for (const domaine of domaines) {
      assert.equal(/google|apple|facebook/i.test(domaine), false, `${id} : ${domaine}`);
    }
  }
});

test('un service sans fournisseur tiers ne restreint rien', () => {
  // Infomaniak et Hetzner se connectent chez eux, de bout en bout. Restreindre
  // sans tiers à écarter ne protégerait rien et risquerait de jeter un cookie
  // utile — une session à moitié capturée n'échoue qu'à la première
  // récupération, des jours plus tard.
  for (const id of ['infomaniak', 'hetzner', 'anthropic']) {
    const keep = registry.manifest(id).remoteLogin.keepDomains;
    assert.ok(Array.isArray(keep), `${id} : keepDomains doit toujours être une liste`);
  }
  assert.deepEqual(registry.manifest('infomaniak').remoteLogin.keepDomains, []);
  assert.deepEqual(registry.manifest('hetzner').remoteLogin.keepDomains, []);
});

// ---------------------------------------------------------------------------
// 5. La migration qui désamorce le piège du catalogue
// ---------------------------------------------------------------------------

/**
 * Le piège, en une phrase : ces sept services avaient DÉJÀ une ligne de
 * catalogue en « available » du temps où ils étaient annoncés, et
 * `syncCatalog()` insère en `ON CONFLICT DO NOTHING` — le nouveau statut
 * « pending » ne serait jamais appliqué, et les sept apparaîtraient d'un coup
 * pour tout le monde.
 */
/** La migration 23, isolée : les autres supposent un schéma complet. */
function migration23() {
  const trouvee = migrations.MIGRATIONS.find((m) => m.id === 23);
  assert.ok(trouvee, 'la migration 23 doit exister');
  return trouvee;
}

/** Un catalogue nu, tel qu'il est au moment où cette migration s'applique. */
function catalogueDeTest() {
  const base = new Database(':memory:');
  base.exec(`
    CREATE TABLE connector_catalog (
      connector_id  TEXT PRIMARY KEY,
      category      TEXT NOT NULL,
      maintenance   INTEGER NOT NULL DEFAULT 0,
      allowed_users TEXT NOT NULL DEFAULT '"all"',
      status        TEXT NOT NULL DEFAULT 'available',
      published_at  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return base;
}

test('la migration 23 remet en attente les lignes posées d\'office', () => {
  const base = catalogueDeTest();
  const poser = base.prepare(
    'INSERT INTO connector_catalog (connector_id, category, status, published_at) VALUES (?,?,?,?)'
  );
  for (const id of SEPT) poser.run(id, 'ia', 'available', null);
  // Un huitième, celui-là APPROUVÉ à la main par un administrateur.
  poser.run('deja-approuve', 'ia', 'available', '2026-08-01 10:00:00');
  // Et un connecteur qui n'a rien à voir avec ce lot.
  poser.run('amazon', 'shopping', 'available', null);

  migration23().up(base);

  const statut = (id) =>
    base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get(id).status;

  for (const id of SEPT) assert.equal(statut(id), 'pending', `${id} : aurait été proposé à tous`);
  assert.equal(
    statut('deja-approuve'),
    'available',
    'une approbation explicite d\'administrateur n\'est jamais reprise'
  );
  assert.equal(statut('amazon'), 'available', 'les autres connecteurs ne bougent pas');

  base.close();
});

test('la migration 23 ne reprend jamais une approbation, même rejouée', () => {
  // Le socle de migrations garantit déjà qu'une migration ne s'applique qu'une
  // fois (schema_migrations). Ce qu'on vérifie ici, c'est le pire cas : qu'elle
  // soit rejouée quand même — reprise de sauvegarde, base recréée — ne doit
  // pas reprendre un service qu'un administrateur a explicitement approuvé
  // entre-temps.
  const base = catalogueDeTest();
  base.prepare('INSERT INTO connector_catalog (connector_id, category) VALUES (?,?)')
    .run('mistral', 'ia');

  migration23().up(base);
  assert.equal(
    base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get('mistral').status,
    'pending'
  );

  base.prepare(
    "UPDATE connector_catalog SET status = 'available', published_at = datetime('now') "
      + 'WHERE connector_id = ?'
  ).run('mistral');

  migration23().up(base);
  assert.equal(
    base.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?').get('mistral').status,
    'available',
    'la décision de l\'administrateur tient'
  );
  base.close();
});

test('la migration 23 ne casse rien sur une base sans catalogue', () => {
  const base = new Database(':memory:');
  assert.doesNotThrow(() => migration23().up(base));
  base.close();
});

// ---------------------------------------------------------------------------
// Migration 25 — Invoice Ninja retiré, et ce qu'il laissait derrière lui
//
// Un connecteur qu'on efface du disque ne s'efface PAS de la base :
// `syncCatalog()` n'insère que, il ne retire jamais. Sans cette migration,
// l'installation d'origine resterait en base avec sa configuration chiffrée —
// mot de passe compris — sans qu'aucun écran ne la montre ni ne permette de la
// supprimer. Le lot 21 a corrigé exactement ce travers sur les clés de
// configuration ; c'est la même règle, un cran au-dessus.
// ---------------------------------------------------------------------------

/** La migration 25, isolée. */
function migration25() {
  const trouvee = migrations.MIGRATIONS.find((m) => m.id === 25);
  assert.ok(trouvee, 'la migration 25 doit exister');
  return trouvee;
}

/** Une base portant tout ce qu'une installation réelle laisse derrière elle. */
function baseAvecInstallation() {
  const base = new Database(':memory:');
  base.exec(`
    CREATE TABLE connector_catalog (
      connector_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', published_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE connector_installs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      connector_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs-config',
      config_encrypted TEXT, last_error TEXT,
      UNIQUE (user_id, connector_id)
    );
    CREATE TABLE user_connector_schedules (
      user_id INTEGER NOT NULL, connector_id TEXT NOT NULL, frequency TEXT
    );
    CREATE TABLE connector_schedules (connector_id TEXT PRIMARY KEY, frequency TEXT);
    CREATE TABLE connector_discoveries (
      user_id INTEGER NOT NULL, connector_id TEXT NOT NULL, items TEXT
    );
    CREATE TABLE run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connector_id TEXT, success INTEGER, message TEXT
    );
  `);

  base.prepare('INSERT INTO connector_catalog (connector_id, category, status) VALUES (?,?,?)')
    .run('invoice-ninja', 'ia', 'pending');
  base.prepare('INSERT INTO connector_catalog (connector_id, category, status) VALUES (?,?,?)')
    .run('proxmox', 'hebergement', 'pending');
  base.prepare(
    'INSERT INTO connector_installs (user_id, connector_id, status, config_encrypted) VALUES (?,?,?,?)'
  ).run(1, 'invoice-ninja', 'error', 'crabe.v1.chiffré-mot-de-passe');
  base.prepare(
    'INSERT INTO connector_installs (user_id, connector_id, status, config_encrypted) VALUES (?,?,?,?)'
  ).run(1, 'proxmox', 'error', 'crabe.v1.autre');
  base.prepare('INSERT INTO user_connector_schedules (user_id, connector_id, frequency) VALUES (?,?,?)')
    .run(1, 'invoice-ninja', 'daily');
  base.prepare('INSERT INTO connector_schedules (connector_id, frequency) VALUES (?,?)')
    .run('invoice-ninja', 'daily');
  base.prepare('INSERT INTO connector_discoveries (user_id, connector_id, items) VALUES (?,?,?)')
    .run(1, 'invoice-ninja', '[]');
  base.prepare('INSERT INTO run_logs (connector_id, success, message) VALUES (?,?,?)')
    .run('invoice-ninja', 0, 'These credentials do not match our records');

  return base;
}

test('la migration 25 n\'abandonne aucun secret d\'Invoice Ninja en base', () => {
  const base = baseAvecInstallation();
  migration25().up(base);

  const compte = (table) =>
    base.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = 'invoice-ninja'`).get().n;

  assert.equal(compte('connector_installs'), 0, 'la configuration chiffrée doit disparaître');
  assert.equal(compte('connector_catalog'), 0, 'la ligne de catalogue n\'a plus d\'objet');
  assert.equal(compte('user_connector_schedules'), 0, 'plus rien à déclencher');
  assert.equal(compte('connector_schedules'), 0);
  assert.equal(compte('connector_discoveries'), 0);

  // Ce qui reste, et doit rester : le journal. Trois lignes d'histoire — ce
  // qui a été tenté, quand, avec quel résultat. Réécrire le passé pour faire
  // propre serait le contraire d'un journal.
  assert.equal(compte('run_logs'), 1, 'l\'histoire des tentatives ne se réécrit pas');

  // Et les autres connecteurs n'ont pas bougé d'un cheveu.
  const proxmox = base
    .prepare("SELECT config_encrypted FROM connector_installs WHERE connector_id = 'proxmox'")
    .get();
  assert.equal(proxmox.config_encrypted, 'crabe.v1.autre');
  base.close();
});

test('la migration 25 ne casse rien sur une base qui n\'a aucune de ces tables', () => {
  const base = new Database(':memory:');
  assert.doesNotThrow(() => migration25().up(base));
  base.close();
});

test('Invoice Ninja a bel et bien quitté le catalogue livré', () => {
  // Le garde-fou du retrait : tant que le dossier existe, le registre le
  // charge, `syncCatalog()` réinscrit sa ligne au démarrage suivant, et la
  // migration ci-dessus ne sert plus à rien.
  assert.equal(registry.has('invoice-ninja'), false, 'le dossier doit avoir disparu du dépôt');
  assert.equal(registry.isPlanned('invoice-ninja'), false, 'et il ne revient pas en « annoncé »');
});
