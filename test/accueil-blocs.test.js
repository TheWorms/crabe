'use strict';

/**
 * Lot 20 — l'accueil : deux blocs autonomes, et trois statistiques de plus.
 *
 * ─── Ce que ce fichier protège ───────────────────────────────────────────────
 *
 * Deux choses, et la première est la plus facile à casser sans s'en apercevoir.
 *
 * **La reprise du réglage partagé.** Le lot 18 avait posé UNE taille de page
 * pour les deux blocs de l'accueil (`home.pageSize`). Ce lot en pose deux. Un
 * compte qui avait choisi 30 lignes doit les retrouver SUR LES DEUX BLOCS —
 * repartir du défaut serait une régression silencieuse : l'accueil change
 * d'aspect après une mise à jour, et le réglage a l'air de ne pas tenir.
 *
 * **Les trois statistiques ajoutées.** Chacune ne se calcule qu'à partir d'une
 * donnée que crabe possède déjà. Le candidat « montant total par mois » a été
 * écarté pour cette raison précise, et ce fichier le constate : la table
 * `invoices` n'a aucune colonne de montant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const migrations = require('../server/db/migrations');
const preferences = require('../server/preferences');
const home = require('../server/home');

let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot20-accueil', role: 'admin' });
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. La migration 24 — un réglage qui existait ne doit pas disparaître
// ---------------------------------------------------------------------------

/** La migration 24, isolée : les autres supposent un schéma complet. */
function migration24() {
  const trouvee = migrations.MIGRATIONS.find((m) => m.id === 24);
  assert.ok(trouvee, 'la migration 24 doit exister');
  return trouvee;
}

function tableDePreferences() {
  const base = new Database(':memory:');
  base.exec(`
    CREATE TABLE user_preferences (
      user_id    INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );
  `);
  return base;
}

test('un compte réglé avant ce lot retrouve sa valeur SUR LES DEUX BLOCS', () => {
  const base = tableDePreferences();
  base.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?)')
    .run(7, 'home.pageSize', '30');
  // Un second compte, réglé autrement : la reprise est par COMPTE, elle ne
  // doit pas aplatir tout le monde sur la même valeur.
  base.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?)')
    .run(9, 'home.pageSize', '15');

  migration24().up(base);

  const lire = (id, cle) =>
    base.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(id, cle);

  assert.equal(lire(7, 'home.sync.pageSize').value, '30');
  assert.equal(lire(7, 'home.documents.pageSize').value, '30');
  assert.equal(lire(9, 'home.sync.pageSize').value, '15');
  assert.equal(lire(9, 'home.documents.pageSize').value, '15');
  base.close();
});

test('l\'ancienne clé est effacée — pas de seconde vérité qui traîne', () => {
  // Décision documentée du lot : plus aucun code ne lit `home.pageSize`, et
  // `preferences.js` refuse désormais cette clé. La laisser en base poserait
  // une valeur que rien n'applique mais qu'un lecteur futur croirait
  // déterminante.
  const base = tableDePreferences();
  base.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?)')
    .run(7, 'home.pageSize', '30');

  migration24().up(base);

  assert.equal(
    base.prepare("SELECT COUNT(*) AS n FROM user_preferences WHERE key = 'home.pageSize'").get().n,
    0
  );
  assert.equal(preferences.isKnown('home.pageSize'), false, 'et le serveur la refuse');
  base.close();
});

test('une valeur déjà posée sur une nouvelle clé n\'est pas écrasée', () => {
  // Base rejouée, réglage posé entre-temps : une migration ne repasse jamais
  // devant un choix explicite.
  const base = tableDePreferences();
  const poser = base.prepare('INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?)');
  poser.run(7, 'home.pageSize', '30');
  poser.run(7, 'home.sync.pageSize', '50');

  migration24().up(base);

  const lire = (cle) =>
    base.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(7, cle);
  assert.equal(lire('home.sync.pageSize').value, '50', 'le choix explicite tient');
  assert.equal(lire('home.documents.pageSize').value, '30', 'et l\'autre reprend l\'ancienne');
  base.close();
});

test('un compte qui n\'avait rien réglé garde le défaut, sans ligne inutile', () => {
  const base = tableDePreferences();
  migration24().up(base);
  assert.equal(base.prepare('SELECT COUNT(*) AS n FROM user_preferences').get().n, 0);
  base.close();
});

test('la migration 24 ne casse rien sur une base sans table de préférences', () => {
  const base = new Database(':memory:');
  assert.doesNotThrow(() => migration24().up(base));
  base.close();
});

// ---------------------------------------------------------------------------
// 2. Les deux réglages sont bien deux — et distincts de « Mes documents »
// ---------------------------------------------------------------------------

test('chaque bloc a sa clé de pagination et sa clé de présentation', () => {
  for (const cle of [
    'home.sync.pageSize',
    'home.documents.pageSize',
    'view.home-sync',
    'view.home-documents',
  ]) {
    assert.equal(preferences.isKnown(cle), true, `${cle} : clé attendue`);
  }

  // ⚠ La clé de l'écran « Mes documents » reste à part : les blocs de
  // l'accueil et cet écran montrent des choses différentes, et partager une
  // clé ferait basculer l'un en réglant l'autre.
  preferences.set(user.id, 'view.home-documents', 'list');
  assert.equal(preferences.get(user.id, 'view.documents'), 'cards');
  preferences.set(user.id, 'view.home-documents', 'cards');
});

test('régler la pagination d\'un bloc ne touche pas celle de l\'autre', () => {
  preferences.set(user.id, 'home.sync.pageSize', 15);
  preferences.set(user.id, 'home.documents.pageSize', 50);
  preferences.set(user.id, 'home.sync.pageSize', 25);

  assert.equal(preferences.get(user.id, 'home.sync.pageSize'), 25);
  assert.equal(preferences.get(user.id, 'home.documents.pageSize'), 50);
});

test('une taille hors liste est REFUSÉE, jamais rangée en douce sur autre chose', () => {
  for (const cle of ['home.sync.pageSize', 'home.documents.pageSize']) {
    assert.match(preferences.refus(cle, 7), /10, 15, 20, 25, 30 ou 50/);
    assert.equal(preferences.refus(cle, 30), null);
  }
});

test('une forme de graphique hors liste est refusée, et le message la nomme', () => {
  assert.equal(preferences.refus('home.stats.type.mois', 'courbe'), null);
  assert.match(preferences.refus('home.stats.type.mois', 'anneau'), /Barres ou Courbe/);
  assert.match(preferences.refus('home.stats.type.connecteurs', 'courbe'), /Barres ou Anneau/);
});

test('une forme abîmée en base retombe sur le dessin d\'origine', () => {
  // `coerce()` protège la LECTURE : une valeur écrite par une version
  // antérieure ne doit pas rendre un bloc vide.
  assert.equal(preferences.coerce('home.stats.type.mois', 'camembert'), 'barres');
  assert.equal(preferences.coerce('home.stats.type.connecteurs', 'anneau'), 'anneau');
});

// ---------------------------------------------------------------------------
// 3. Les trois statistiques — et celle qu'on a écartée
// ---------------------------------------------------------------------------

test('le montant n\'est stocké NULLE PART : « montant par mois » était impossible', () => {
  // C'est le constat qui a écarté ce candidat, et il se vérifie plutôt que de
  // se raconter. Les connecteurs rendent bien un montant ; la table qui reçoit
  // les documents n'a aucune colonne pour l'accueillir, et aucune reprise ne
  // pourrait redater les documents déjà récupérés.
  const colonnes = helpers.db.get().prepare('PRAGMA table_info(invoices)').all()
    .map((c) => c.name);
  assert.equal(
    colonnes.some((nom) => /amount|montant|price|prix/i.test(nom)),
    false,
    `colonnes de invoices : ${colonnes.join(', ')}`
  );
});

test('les trois séries ajoutées se calculent, et à partir de vraies lignes', () => {
  const base = helpers.db.get();
  const mois = new Date().toISOString().slice(0, 7);

  base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, size_bytes, issued_on, fetched_at)
     VALUES (?, 'free', ?, ?, ?, datetime('now'))`
  ).run(user.id, 'facture-a.pdf', 1000, `${mois}-05`);
  base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, size_bytes, issued_on, fetched_at)
     VALUES (?, 'free', ?, ?, ?, datetime('now'))`
  ).run(user.id, 'facture-b.pdf', 2400, `${mois}-06`);
  base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, size_bytes, issued_on, fetched_at)
     VALUES (?, 'amazon', ?, ?, ?, datetime('now'))`
  ).run(user.id, 'facture-c.pdf', 500, `${mois}-07`);

  base.prepare(
    "INSERT INTO connector_installs (user_id, connector_id, status) VALUES (?, 'free', 'installed')"
  ).run(user.id);

  // `finished_at` est posé : une exécution TERMINÉE en a toujours une (c'est
  // finish() qui l'écrit). Une ligne sans fin est une exécution en cours, et
  // le graphique l'ignore — lot 33 : elle n'est ni réussie ni échouée.
  base.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger)
     VALUES ('free', ?, datetime('now'), datetime('now'), 1, 'manual')`
  ).run(user.id);
  base.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger)
     VALUES ('free', ?, datetime('now'), datetime('now'), 0, 'manual')`
  ).run(user.id);
  // Un essai de configuration raté : il ne doit PAS compter comme une panne.
  base.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger)
     VALUES ('free', ?, datetime('now'), datetime('now'), 0, 'test')`
  ).run(user.id);
  // Et une exécution EN COURS : elle ne doit compter nulle part.
  base.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, success, trigger)
     VALUES ('free', ?, datetime('now'), 0, 'manual')`
  ).run(user.id);

  const stats = home.stats(user);

  // ── Espace occupé par service, du plus lourd au plus léger.
  const stockage = stats.stockageParConnecteur;
  assert.equal(stockage[0].id, 'free');
  assert.equal(stockage[0].bytes, 3400, 'les octets sont additionnés, pas les documents');
  assert.equal(stockage[0].count, 2);
  assert.equal(stockage[1].id, 'amazon');
  assert.equal(stockage[1].bytes, 500);

  // ── Services connectés, CUMULÉ : la courbe ne redescend pas.
  const services = stats.connecteursDansLeTemps;
  assert.equal(services.length, 12, 'douze mois, y compris ceux à zéro');
  assert.equal(services.at(-1).count, 1);
  for (let i = 1; i < services.length; i++) {
    assert.ok(
      services[i].count >= services[i - 1].count,
      'un cumul ne peut pas décroître'
    );
  }

  // ── Récupérations réussies et échouées, essais de configuration exclus.
  const executions = stats.executionsParMois;
  assert.equal(executions.length, 12);
  const courant = executions.at(-1);
  assert.equal(courant.ok, 1);
  assert.equal(courant.ko, 1, 'l\'essai de configuration raté ne compte pas comme une panne');
});

test('sans aucune donnée, les trois séries rendent des mois à zéro, pas du vide', () => {
  // Un tableau vide ferait dessiner un axe à trous ; une phrase seule ferait
  // disparaître le cadre. Les douze mois sont toujours là, à zéro.
  const neuf = { id: 999_999 };
  const stats = home.stats(neuf);

  assert.deepEqual(stats.stockageParConnecteur, []);
  assert.equal(stats.connecteursDansLeTemps.length, 12);
  assert.equal(stats.connecteursDansLeTemps.every((p) => p.count === 0), true);
  assert.equal(stats.executionsParMois.length, 12);
  assert.equal(stats.executionsParMois.every((p) => !p.ok && !p.ko), true);
});

test('l\'accueil sert les deux tailles, les deux présentations et les formes', async () => {
  preferences.set(user.id, 'home.sync.pageSize', 15);
  preferences.set(user.id, 'home.documents.pageSize', 30);
  preferences.set(user.id, 'view.home-sync', 'list');
  preferences.set(user.id, 'home.stats.type.mois', 'courbe');

  const data = await home.dashboard(user);

  assert.equal(data.syncPageSize, 15);
  assert.equal(data.documentsPageSize, 30);
  assert.equal(data.syncView, 'list');
  assert.equal(data.documentsView, 'cards');
  assert.equal(data.statsChartTypes.mois, 'courbe');
  assert.equal(data.statsChartTypes.connecteurs, 'barres');
  // Le catalogue vient du serveur : c'est lui qui refuse le reste, un menu qui
  // proposerait autre chose serait un piège à clic.
  assert.deepEqual(data.statsTypeCatalog.mois, ['barres', 'courbe']);
  assert.deepEqual(data.statsTypeCatalog.connecteurs, ['barres', 'anneau']);
  assert.equal(data.pageSize, undefined, 'la clé partagée du lot 18 a disparu');

  // Les trois graphiques ajoutés sont au catalogue, et DÉCOCHÉS par défaut :
  // un accueil ne change pas d'aspect parce que crabe a été mis à jour.
  const catalogue = data.statsChartsCatalog.map((c) => c.id);
  for (const id of ['stockage', 'connecteurs-temps', 'executions']) {
    assert.ok(catalogue.includes(id), `${id} : absent du catalogue`);
    assert.equal(data.statsCharts.includes(id), false, `${id} : ne doit pas être coché d'office`);
  }
});
