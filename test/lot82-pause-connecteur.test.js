'use strict';

/**
 * Lot 82 — un connecteur se met en pause depuis son profil, et se rallume.
 *
 * ─── Ce que la pause N'EST PAS ──────────────────────────────────────────────
 *
 * Une désinstallation. Celle-ci efface les identifiants chiffrés, la
 * planification et les éléments découverts — dont, parfois, une session ouverte
 * à la main dans la fenêtre du navigateur, qui ne se refait pas d'un clic. La
 * pause, elle, ne touche QU'À `disabled_at`.
 *
 * ─── Pourquoi une date, et pas un statut « disabled » ───────────────────────
 *
 * Parce que `status` répond à « est-ce que ça marche ? » et `disabled_at` à
 * « est-ce que ça doit travailler ? ». Deux questions distinctes : un
 * connecteur en `error` qu'on met de côté le temps de s'en occuper doit
 * retrouver son erreur en revenant — c'est vérifié plus bas, explicitement.
 *
 * ─── Morsures ──────────────────────────────────────────────────────────────
 *
 * Chaque garde de ce lot est mordue par au moins un test : retirer
 * `if (s.disabledAt) continue` de `scheduler.reload`, le refus de
 * `runForUser`, le `disabled_at IS NULL` de `runForAllUsers`, le filtre de
 * `home.installedConnectors`, le `req.user.id` de la route, ou l'interrupteur
 * du front fait chuter le test correspondant. Les comptes avant / après sont
 * consignés dans PROGRESS.md.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const responsive = require('./responsive');
const { nestingErrors } = require('./html-nesting');
const migrations = require('../server/db/migrations');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const schedules = require('../server/schedules');
const home = require('../server/home');
const { config } = require('../server/config');

const WEB = path.resolve(__dirname, '..', 'web');

/** Le service qui sert de cobaye : installé, configuré, et jamais joint. */
const SERVICE = 'edf';

let db;
let titulaire;
let voisine;
let client;

test.before(async () => {
  await helpers.setup();
  db = require('../server/db/db');

  titulaire = await helpers.createUser({ username: 'lot82', plainPassword: 'MotDePasse1', role: 'admin' });
  voisine = await helpers.createUser({ username: 'lot82bis', plainPassword: 'MotDePasse1', role: 'admin' });

  // Les deux comptes installent ET configurent le MÊME service : c'est la
  // seule façon de prouver que la pause de l'un ne touche pas l'autre.
  const champs = Object.fromEntries(
    registry.manifest(SERVICE).fields.map((f) => [f.key, 'valeur-inventee'])
  );
  for (const u of [titulaire, voisine]) {
    registry.install(u.id, SERVICE);
    registry.saveConfig(u.id, SERVICE, champs);
  }

  client = await helpers.startServer();
  await helpers.login(client, 'lot82', 'MotDePasse1');
});

test.after(() => {
  scheduler.stopAll();
  client?.close();
  helpers.teardown();
});

/** Remet les deux installations en marche entre deux tests. */
test.beforeEach(() => {
  db.get().prepare('UPDATE connector_installs SET disabled_at = NULL').run();
});

const installDe = (user) => registry.getInstall(user.id, SERVICE);
const vueDe = (user) => registry.listForUser(user).find((c) => c.id === SERVICE);

// ---------------------------------------------------------------------------
// A1 — la colonne, et sa migration
// ---------------------------------------------------------------------------

test('la migration 57 ajoute disabled_at, et une seconde passe ne fait rien', () => {
  const migration = migrations.MIGRATIONS.find((m) => m.id === 57);
  assert.ok(migration, 'la migration 57 doit exister');

  // Une table d'installations telle qu'elle est AVANT ce lot.
  const base = new Database(':memory:');
  base.exec(`
    CREATE TABLE connector_installs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      connector_id     TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'needs-config',
      config_encrypted TEXT,
      account_id       TEXT,
      last_error       TEXT,
      last_run_at      TEXT,
      installed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, connector_id)
    );
  `);
  base
    .prepare(
      `INSERT INTO connector_installs (user_id, connector_id, status, config_encrypted, last_error)
       VALUES (1, 'service-invente', 'error', 'chiffre', 'Le site n''a pas répondu.')`
    )
    .run();

  const colonnes = () =>
    base.prepare('PRAGMA table_info(connector_installs)').all().map((c) => c.name);
  assert.equal(colonnes().includes('disabled_at'), false, 'absente avant la migration');

  migration.up(base);
  assert.equal(colonnes().includes('disabled_at'), true);

  const apres = base.prepare('SELECT * FROM connector_installs').get();
  assert.equal(apres.disabled_at, null, 'NULL par défaut : rien ne se met en pause tout seul');
  assert.equal(apres.status, 'error', 'la migration ne touche pas à l\'état de santé');
  assert.equal(apres.config_encrypted, 'chiffre', 'ni aux identifiants');

  // Deuxième passe : vide, sans erreur — c'est ça, l'idempotence.
  assert.doesNotThrow(() => migration.up(base));
  assert.equal(
    colonnes().filter((n) => n === 'disabled_at').length,
    1,
    'une seule colonne disabled_at, même après deux passes'
  );
  base.close();
});

test('le schéma des bases NEUVES porte disabled_at, comme les migrées', () => {
  const colonnes = db
    .get()
    .prepare('PRAGMA table_info(connector_installs)')
    .all()
    .map((c) => c.name);
  assert.ok(colonnes.includes('disabled_at'), 'schema.sql et migrations.js doivent converger');
});

// ---------------------------------------------------------------------------
// A1 / A4 — le modèle : ce qui change, et tout ce qui ne change pas
// ---------------------------------------------------------------------------

test('setActivation pose une date, la retire — et ne touche à RIEN d\'autre', () => {
  const avant = installDe(titulaire);
  assert.equal(avant.disabled_at, null);

  const enPause = registry.setActivation(titulaire.id, SERVICE, false);
  assert.ok(enPause.disabled_at, 'une date est posée');
  assert.match(
    enPause.disabled_at,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'horodatage UTC au format de la base'
  );
  assert.equal(enPause.config_encrypted, avant.config_encrypted, 'les identifiants restent');
  assert.equal(enPause.status, avant.status, 'l\'état de santé reste');
  assert.equal(enPause.account_id, avant.account_id, 'le compte reste');
  assert.equal(enPause.installed_at, avant.installed_at, 'la date d\'installation reste');
  assert.ok(schedules.get(titulaire.id, SERVICE), 'la planification reste enregistrée');

  const rallume = registry.setActivation(titulaire.id, SERVICE, true);
  assert.equal(rallume.disabled_at, null, 'rallumer efface la date');
  assert.equal(rallume.config_encrypted, avant.config_encrypted);
});

test('un connecteur en ERREUR mis en pause retrouve son erreur au rallumage', () => {
  db.get()
    .prepare(
      `UPDATE connector_installs SET status = 'error', last_error = ?
        WHERE user_id = ? AND connector_id = ?`
    )
    .run('Le site n\'a pas répondu.', titulaire.id, SERVICE);

  registry.setActivation(titulaire.id, SERVICE, false);
  assert.equal(installDe(titulaire).status, 'error', 'la pause n\'efface pas la panne');

  registry.setActivation(titulaire.id, SERVICE, true);
  const revenu = installDe(titulaire);
  assert.equal(revenu.status, 'error', 'le rallumage ne repart PAS d\'un état neuf');
  assert.equal(revenu.last_error, 'Le site n\'a pas répondu.', 'le message d\'origine aussi');

  db.get()
    .prepare(
      `UPDATE connector_installs SET status = 'installed', last_error = NULL
        WHERE user_id = ? AND connector_id = ?`
    )
    .run(titulaire.id, SERVICE);
});

test('la pause est PAR INSTALLATION : celle de l\'un ne touche pas l\'autre', () => {
  registry.setActivation(titulaire.id, SERVICE, false);
  assert.ok(installDe(titulaire).disabled_at, 'le premier compte est en pause');
  assert.equal(installDe(voisine).disabled_at, null, 'le second n\'a pas bougé');
  assert.equal(vueDe(voisine).disabledAt, null);
  assert.ok(vueDe(titulaire).disabledAt);
});

// ---------------------------------------------------------------------------
// A2 — un connecteur en pause ne travaille plus
// ---------------------------------------------------------------------------

test('la récurrence saute un connecteur en pause, et le reprend au rallumage', (t) => {
  // Les tests tournent scheduler coupé : on le rallume le temps de compter ce
  // qui serait RÉELLEMENT armé (même patron qu'au lot 3).
  const initial = config.schedulerDisabled;
  config.schedulerDisabled = false;
  t.after(() => {
    scheduler.stopAll();
    config.schedulerDisabled = initial;
  });

  const arme = () => scheduler.reload().scheduled;
  assert.equal(arme(), 2, 'deux comptes configurés, deux tâches');

  registry.setActivation(titulaire.id, SERVICE, false);
  assert.equal(arme(), 1, 'la tâche du compte en pause n\'est PAS armée');
  assert.ok(schedules.get(titulaire.id, SERVICE).enabled, 'sa planification reste activée en base');

  registry.setActivation(titulaire.id, SERVICE, true);
  assert.equal(arme(), 2, 'elle repart telle quelle au rallumage, sans rien reconstruire');
});

test('la prochaine exécution d\'un connecteur en pause n\'est pas annoncée', () => {
  registry.setActivation(titulaire.id, SERVICE, false);
  const parCompte = new Map(scheduler.listSchedules().map((s) => [s.username, s]));
  assert.equal(parCompte.get('lot82').nextRunAt, null, 'aucune date promise pour rien');
  assert.ok(parCompte.get('lot82').disabledAt, 'l\'écran sait pourquoi');
  assert.ok(parCompte.get('lot82bis').nextRunAt, 'le voisin garde la sienne');
});

test('runForUser refuse un connecteur en pause — sans rien écrire au journal', async () => {
  const lignes = () =>
    db.get().prepare('SELECT COUNT(*) AS n FROM run_logs WHERE user_id = ?').get(titulaire.id).n;

  registry.setActivation(titulaire.id, SERVICE, false);
  const avant = lignes();

  await assert.rejects(
    () => scheduler.runForUser(titulaire.id, SERVICE, 'manual'),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.enPause, true);
      assert.match(err.message, /en pause/);
      assert.match(err.message, /profil/, 'le refus dit où rallumer');
      return true;
    }
  );

  assert.equal(lignes(), avant, 'une pause n\'est pas un incident : aucune ligne de journal');
});

test('runForAllUsers ne descend pas chez le compte en pause', async () => {
  registry.setActivation(titulaire.id, SERVICE, false);
  const resultats = await scheduler.runForAllUsers(SERVICE, 'cron');
  assert.deepEqual(
    resultats.map((r) => r.userId),
    [voisine.id],
    'seul le compte actif est visité'
  );
});

// ---------------------------------------------------------------------------
// A3 / B4 — l'accueil ne montre plus un connecteur en pause
// ---------------------------------------------------------------------------

test('l\'accueil : ni vignette, ni ligne de synchronisation, ni geste à faire', async () => {
  const actif = await home.dashboard(titulaire);
  assert.ok(actif.connectors.some((c) => c.id === SERVICE), 'présent tant qu\'il travaille');
  const compteAvant = actif.stats.activeConnectors;

  registry.setActivation(titulaire.id, SERVICE, false);
  const enPause = await home.dashboard(titulaire);

  assert.equal(enPause.connectors.some((c) => c.id === SERVICE), false, 'plus de vignette');
  assert.equal(enPause.sync.some((r) => r.id === SERVICE), false, 'plus de ligne de synchro');
  assert.equal(
    enPause.pendingActions.some((a) => a.connectorId === SERVICE),
    false,
    'plus de geste réclamé pour un service mis de côté'
  );
  assert.equal(
    enPause.stats.activeConnectors,
    compteAvant - 1,
    'le décompte « N connecteur(s) actif(s) » le retire'
  );
});

test('l\'accueil : plus d\'alerte rouge non plus, et elle revient au rallumage', async () => {
  db.get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message)
       VALUES (?, ?, datetime('now'), datetime('now'), 0, 'cron', ?)`
    )
    .run(SERVICE, titulaire.id, 'Le site n\'a pas répondu.');

  const avant = await home.dashboard(titulaire);
  assert.ok(avant.errors.some((e) => e.connectorId === SERVICE), 'l\'échec est bien là');

  registry.setActivation(titulaire.id, SERVICE, false);
  const pendant = await home.dashboard(titulaire);
  assert.equal(
    pendant.errors.some((e) => e.connectorId === SERVICE),
    false,
    'on ne réclame pas de réparer un service qu\'on vient de mettre de côté'
  );

  registry.setActivation(titulaire.id, SERVICE, true);
  const apres = await home.dashboard(titulaire);
  assert.ok(apres.errors.some((e) => e.connectorId === SERVICE), 'et l\'alerte revient intacte');

  db.get().prepare('DELETE FROM run_logs WHERE user_id = ?').run(titulaire.id);
});

/**
 * Le bandeau d'opérations — mesuré, puis verrouillé tel quel.
 *
 * Il ne compte AUCUN connecteur : il annonce des opérations réellement
 * survenues (une récupération en cours, une qui vient de finir). Un service en
 * pause n'en produit plus aucune — la garde de `runForUser` s'en assure — donc
 * il n'y apparaît plus.
 *
 * ⚠ Une exception, voulue et mesurée le 10/09/2026 : une récupération TERMINÉE
 * juste avant la pause reste annoncée le temps de sa fenêtre (deux minutes
 * pour un succès). C'est le compte rendu d'un fait qui a eu lieu, au même
 * titre qu'une ligne de journal : l'effacer reviendrait à nier une
 * récupération qui a bel et bien déposé des documents.
 */
test('le bandeau d\'opérations : plus rien de neuf, mais ce qui a eu lieu reste dit', () => {
  const operations = require('../server/operations');

  registry.setActivation(titulaire.id, SERVICE, false);
  assert.deepEqual(operations.operationsPour(titulaire), [], 'aucune opération pour un service en pause');

  db.get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message, invoice_count)
       VALUES (?, ?, datetime('now','-90 seconds'), datetime('now','-60 seconds'), 1, 'cron', ?, 3)`
    )
    .run(SERVICE, titulaire.id, '3 documents récupérés.');

  const apres = operations.operationsPour(titulaire);
  assert.equal(apres.length, 1, 'la récupération qui a eu lieu AVANT la pause est toujours dite');
  assert.equal(apres[0].etat, 'succes');

  db.get().prepare('DELETE FROM run_logs WHERE user_id = ?').run(titulaire.id);
});

test('l\'accueil du VOISIN ne change pas quand l\'autre met en pause', async () => {
  registry.setActivation(titulaire.id, SERVICE, false);
  const voisin = await home.dashboard(voisine);
  assert.ok(voisin.connectors.some((c) => c.id === SERVICE), 'sa vignette est toujours là');
  assert.ok(voisin.sync.some((r) => r.id === SERVICE));
});

// ---------------------------------------------------------------------------
// B3 / B5 — la carte reste sur Profil, et le Store ne bouge pas
// ---------------------------------------------------------------------------

test('la carte reste sur Profil — c\'est le seul endroit d\'où on rallume', () => {
  registry.setActivation(titulaire.id, SERVICE, false);
  const vue = vueDe(titulaire);
  assert.ok(vue, 'le connecteur est toujours dans le catalogue de l\'utilisateur');
  assert.equal(vue.installed, true, 'et toujours installé : le Store dit vrai');
  assert.ok(vue.disabledAt, 'avec de quoi dessiner l\'interrupteur du bon côté');
  assert.ok(vue.health, 'et son état de santé, inchangé');
});

// ---------------------------------------------------------------------------
// La route — corps explicite, cloisonnement, réponse utile
// ---------------------------------------------------------------------------

test('la route : actif est exigé, un corps vide ne décide de rien', async () => {
  const vide = await client.put(`/api/connectors/${SERVICE}/activation`, {});
  assert.equal(vide.status, 400);
  assert.equal(installDe(titulaire).disabled_at, null, 'rien n\'a été écrit');

  const flou = await client.put(`/api/connectors/${SERVICE}/activation`, { actif: 'non' });
  assert.equal(flou.status, 400, 'une chaîne n\'est pas un booléen');
  assert.equal(installDe(titulaire).disabled_at, null);
});

test('la route : met en pause, rallume, et rend l\'état écrit', async () => {
  const pause = await client.put(`/api/connectors/${SERVICE}/activation`, { actif: false });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.actif, false);
  assert.ok(pause.body.disabledAt, 'la réponse porte la date, l\'écran n\'a pas à la deviner');
  assert.ok(installDe(titulaire).disabled_at);

  const reprise = await client.put(`/api/connectors/${SERVICE}/activation`, { actif: true });
  assert.equal(reprise.body.actif, true);
  assert.equal(reprise.body.disabledAt, null);
  assert.equal(installDe(titulaire).disabled_at, null);
});

test('la route : elle n\'écrit QUE sur l\'installation de celui qui appelle', async () => {
  await client.put(`/api/connectors/${SERVICE}/activation`, { actif: false });
  assert.ok(installDe(titulaire).disabled_at, 'la sienne est en pause');
  assert.equal(installDe(voisine).disabled_at, null, 'celle du voisin n\'a pas bougé');
});

test('la route : un connecteur non installé pour ce compte est un 404, pas une écriture', async () => {
  const autre = registry.listAll().find((c) => c.id !== SERVICE && !c.planned);
  const reponse = await client.put(`/api/connectors/${autre.id}/activation`, { actif: false });
  assert.equal(reponse.status, 404);
  assert.equal(
    db.get().prepare('SELECT COUNT(*) AS n FROM connector_installs WHERE connector_id = ?')
      .get(autre.id).n,
    0,
    'aucune installation n\'a été créée au passage'
  );
});

test('la route : elle refuse les visiteurs non connectés', async () => {
  const anonyme = await helpers.startServer();
  try {
    const reponse = await anonyme.put(`/api/connectors/${SERVICE}/activation`, { actif: false });
    assert.equal(reponse.status, 401);
    assert.equal(installDe(titulaire).disabled_at, null);
  } finally {
    anonyme.close();
  }
});

// ---------------------------------------------------------------------------
// C2 — non-régression : disabled_at à NULL ne change rien, nulle part
// ---------------------------------------------------------------------------

test('sans aucune pause, tout se comporte comme avant', async () => {
  const vue = vueDe(titulaire);
  assert.equal(vue.disabledAt, null);
  assert.equal(vue.installed, true);

  const accueil = await home.dashboard(titulaire);
  assert.ok(accueil.connectors.some((c) => c.id === SERVICE));
  assert.ok(accueil.sync.some((r) => r.id === SERVICE));

  const parCompte = new Map(scheduler.listSchedules().map((s) => [s.username, s]));
  assert.ok(parCompte.get('lot82').nextRunAt, 'la prochaine exécution est annoncée');
  assert.equal(parCompte.get('lot82').disabledAt, null);
});

// ---------------------------------------------------------------------------
// B1 / B2 / B6 / B7 — le front, rendu réel hors navigateur
// ---------------------------------------------------------------------------

/** Les fonctions de rendu du VRAI web/app.js, extraites dans un bac à sable. */
function contexteFront() {
  const contexte = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

  // `esc` vient de fmt.js, déjà chargé ci-dessus ; l'état partagé et le logo
  // sont réduits au strict nécessaire — ce n'est pas eux qu'on juge ici.
  vm.runInContext('const state = { connectors: [] }; function logoHtml() { return \'\'; }', contexte);

  const phrase = source.match(/const PAUSE_CONSERVE =[\s\S]*?;\n/);
  assert.ok(phrase, 'PAUSE_CONSERVE introuvable dans app.js');
  vm.runInContext(phrase[0], contexte);

  for (const nom of [
    'statusDot', 'statusLabel', 'installedBadge', 'pauseSwitch', 'pauseBoutons',
    'pauseNote', 'installedActions', 'installedRow', 'libelleComptes', 'installedCard',
  ]) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans app.js`);
    vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  }
  return contexte;
}

/** Un connecteur installé tel que la route /connectors le rend. */
function connecteurVu(disabledAt = null) {
  return {
    id: 'service-invente',
    name: 'Service Inventé',
    color: '#3a6ea5',
    letters: 'SI',
    site: 'service-invente.example',
    status: 'installed',
    installed: true,
    disabledAt,
    lastRunAt: '2026-09-09 06:00:00',
    accounts: [],
    accountId: null,
    health: { title: 'Connecté', connected: true, canSync: true },
  };
}

test('vue Cartes : l\'interrupteur est dans l\'en-tête, et dit son état autrement qu\'en couleur', () => {
  const contexte = contexteFront();

  contexte.ACTIF = connecteurVu();
  const actif = vm.runInContext('installedCard(ACTIF)', contexte);
  assert.match(actif, /role="switch"/, 'un interrupteur, pas un bouton de plus');
  assert.match(actif, /aria-checked="true"/);
  assert.match(actif, /aria-label="Activer ou mettre en pause Service Inventé"/,
    'un nom lisible par un lecteur d\'écran');
  assert.match(actif, /<button type="button" class="toggle on"/,
    'un vrai bouton : focusable et actionnable au clavier');
  assert.match(actif, /basculerConnecteur\('service-invente', false, this\)/,
    'cliquer met en pause');
  assert.equal(actif.includes('pause-note'), false, 'rien à expliquer tant qu\'il travaille');
  assert.match(actif, /onclick="runConnectorNow/, '« Lancer maintenant » est cliquable');

  contexte.PAUSE = connecteurVu('2026-09-10 09:30:00');
  const pause = vm.runInContext('installedCard(PAUSE)', contexte);
  assert.match(pause, /aria-checked="false"/);
  assert.match(pause, /basculerConnecteur\('service-invente', true, this\)/, 'cliquer rallume');
  assert.equal(/class="toggle on"/.test(pause), false, 'l\'interrupteur est du côté « pause »');
  assert.match(pause, /class="app-card en-pause"/);
});

test('vue Cartes : la phrase dit ce qui RESTE, et « Lancer maintenant » est grisé', () => {
  const contexte = contexteFront();
  contexte.PAUSE = connecteurVu('2026-09-10 09:30:00');
  const html = vm.runInContext('installedCard(PAUSE)', contexte);

  assert.match(html, /class="pause-note"/, 'la phrase est à l\'endroit du geste');
  assert.match(html, /En pause \(/);
  assert.match(html, /Rien n&#39;est perdu/);
  assert.match(html, /connexion au site reste enregistrée/, 'la session est conservée');
  assert.match(html, /documents déjà rangés ne bougent pas/, 'les documents aussi');
  assert.match(html, /rattrapera ce qu&#39;il aura manqué/, 'et le retard se rattrape');

  assert.match(html, /<button class="icon-btn" disabled[^>]*>Lancer maintenant<\/button>/,
    'le geste est grisé, pas retiré');
  assert.equal(html.includes('runConnectorNow'), false, 'et il n\'appelle rien');
  assert.match(html, /onclick="reconfigureConnector/, '« Reconfigurer » reste possible');
});

test('vue Liste : deux boutons, celui de l\'état courant grisé, l\'autre cliquable', () => {
  const contexte = contexteFront();

  contexte.ACTIF = connecteurVu();
  const actif = vm.runInContext('installedRow(ACTIF)', contexte);
  assert.match(actif, /class="icon-btn etat-courant" disabled aria-current="true"[^>]*>Activé</,
    '« Activé » est l\'état courant : rien à faire');
  assert.match(actif, /title="C'est l'état actuel de ce service\."/,
    'et il le dit au survol, plutôt que de laisser deviner pourquoi il est gris');
  assert.match(actif, /basculerConnecteur\('service-invente', false, this\)">Désactivé</,
    '« Désactivé » est le geste');

  contexte.PAUSE = connecteurVu('2026-09-10 09:30:00');
  const pause = vm.runInContext('installedRow(PAUSE)', contexte);
  assert.match(pause, /basculerConnecteur\('service-invente', true, this\)">Activé</,
    'les rôles s\'inversent');
  assert.match(pause, /class="icon-btn etat-courant" disabled aria-current="true"[^>]*>Désactivé</);
  assert.match(pause, /class="installed-row en-pause"/);
  assert.match(pause, /class="pause-note"/, 'la phrase suit le geste des deux côtés');
});

/**
 * Les cinq points de rupture du lot 3, comme dans render.test.js : la vue
 * Liste passe de deux boutons à quatre, et un téléphone de 360 px est
 * exactement l'écran où ça se serait vu en dernier.
 */
const BREAKPOINTS = [
  { name: 'téléphone 360', width: 360, gutter: 14 },
  { name: 'grand téléphone 640', width: 640, gutter: 16 },
  { name: 'tablette 768', width: 768, gutter: 28 },
  { name: 'ordinateur 1024', width: 1024, gutter: 28 },
  { name: 'grand écran 1440', width: 1440, gutter: 28 },
];

test('les deux vues tiennent dans l\'écran, en pause comme en marche', () => {
  const contexte = contexteFront();
  const regles = responsive.parseCss(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'));

  contexte.ACTIF = connecteurVu();
  contexte.PAUSE = connecteurVu('2026-09-10 09:30:00');
  for (const rendu of ['installedCard(ACTIF)', 'installedCard(PAUSE)',
                       'installedRow(ACTIF)', 'installedRow(PAUSE)']) {
    const html = vm.runInContext(rendu, contexte);
    assert.deepEqual(nestingErrors(html), [], `${rendu} : balises mal fermées`);
    for (const bp of BREAKPOINTS) {
      const debordements = responsive.findOverflows(html, {
        viewport: bp.width,
        available: bp.width - 2 * bp.gutter,
        rules: regles,
      });
      assert.deepEqual(
        debordements.map((d) => d.reason),
        [],
        `${rendu} — débordement à ${bp.name} px`
      );
    }
  }
});

test('le front sait appeler la route, et la feuille de style tient les deux thèmes', () => {
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  assert.match(source, /\/connectors\/\$\{id\}\/activation`, \{ method: 'PUT', body: \{ actif \} \}/,
    'le geste passe par la route du lot');
  assert.equal(
    /confirm\([^)]*pause/i.test(source),
    false,
    'aucune confirmation : le geste se défait d\'un clic'
  );
  assert.match(source, /en pause — sa connexion et ses documents sont conservés/,
    'le retour est visible, comme au Store');

  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  assert.match(css, /button\.toggle\{padding:0;\}/, 'un <button> ne déforme pas la pastille');
  assert.match(css, /\.toggle:focus-visible\{outline:2px solid var\(--accent\)/,
    'le clavier voit où il est');
  assert.match(css, /\.pause-note\{[^}]*color:var\(--text-dim\)/,
    'la phrase suit les variables de thème — clair comme sombre');
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\n\s*\.toggle,\.toggle \.knob\{transition:none;\}/,
    'l\'animation se coupe pour qui l\'a demandé');

  // ⚠ Mesuré à l'écran le 10/09 : éclaircir AUSSI le texte du bouton courant
  // (`color:var(--text)`) le faisait ressortir plus que le bouton cliquable —
  // l'inverse de ce qu'il dit. Seule la bordure distingue, le texte reste
  // atténué par `button[disabled]`.
  assert.match(css, /\.icon-btn\.etat-courant\{border-color:var\(--accent\);\}/);
  assert.equal(
    /\.icon-btn\.etat-courant\{[^}]*color:var\(--text\)/.test(css),
    false,
    'le bouton de l\'état courant ne doit PAS être éclairci'
  );
});
