'use strict';

/**
 * Lot 31, tâche 4 — une entrée supprimée ne réapparaît pas au redémarrage.
 *
 * Homebox et Sofidial ont été retirés du catalogue le 11/08/2026, mais
 * seulement des fichiers Markdown : le dossier planned/homebox/ vivait
 * toujours (donc sa tuile au Store), scripts/gen-planned.js portait encore les
 * DEUX entrées (prêtes à ressusciter au prochain passage du générateur), et la
 * base de la production gardait leurs lignes connector_catalog — plus un logo et des
 * échecs de logo — parce que `syncCatalog()` ne savait qu'insérer.
 *
 * Même famille que la panne du lot 29 (« l'amorçage de la base ressuscitait un
 * stockage local supprimé au redémarrage »), et même règle générale : les CINQ
 * services retirés le 12/08 (sofidial, ulule, prestashop-plateforme,
 * le-petit-hydroculte, emoa) traînaient tous leur ligne orpheline en base.
 *
 * Trois portes fermées ici :
 *   1. le disque et le générateur ne portent plus aucun des six ;
 *   2. `syncCatalog()` retire les lignes orphelines (catalogue + logos), et un
 *      démarrage ne les recrée pas ;
 *   3. la protection : une ligne dont le manifeste EXISTE sur le disque n'est
 *      jamais retirée, même quand le registre chargé ne la connaît pas — un
 *      manifeste illisible un matin ne doit pas coûter ses réglages
 *      d'administration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const db = require('../server/db/db');

/** Les six retraits décidés les 11-12/08/2026. */
const RETIRES = ['homebox', 'sofidial', 'ulule', 'prestashop', 'le-petit-hydroculte', 'emoa'];

test.before(async () => {
  await helpers.setup();
  registry.load();
  registry.syncCatalog();
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. Le disque et le générateur
// ---------------------------------------------------------------------------

test('aucun des six services retirés n\'a de dossier sur le disque', () => {
  for (const id of RETIRES) {
    assert.equal(
      fs.existsSync(path.join(registry.PLANNED_DIR, id, 'manifest.json')),
      false,
      `planned/${id} existe encore : sa tuile réapparaîtra dans le Store`
    );
    assert.equal(
      fs.existsSync(path.join(registry.AVAILABLE_DIR, id, 'manifest.json')),
      false,
      `available/${id} existe encore`
    );
  }
});

test('le générateur d\'annonces ne peut plus les ressusciter', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'gen-planned.js'),
    'utf8'
  );
  for (const id of RETIRES) {
    assert.equal(
      source.includes(`id: '${id}'`),
      false,
      `gen-planned.js déclare encore « ${id} » : relancer le générateur le recréerait`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. La base — l'orphelin s'en va, et le redémarrage ne le ramène pas
// ---------------------------------------------------------------------------

test('une ligne orpheline (dossier disparu) est retirée au semis, logos compris', () => {
  const database = db.get();
  // L'état de la production le 14/08, reconstitué : la ligne de catalogue, le logo et
  // l'échec de logo d'un service dont le dossier n'existe plus.
  database
    .prepare("INSERT INTO connector_catalog (connector_id, category, status) VALUES (?, 'domicile', 'available')")
    .run('fantome-lot31');
  database
    .prepare("INSERT INTO connector_logos (connector_id, extension, origin) VALUES (?, 'ico', 'https://exemple.invalid/favicon.ico')")
    .run('fantome-lot31');
  database
    .prepare("INSERT INTO logo_failures (connector_id, reason) VALUES (?, 'inatteignable')")
    .run('fantome-lot31');

  const avant = database.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;

  // Le démarrage : chargement du disque puis semis.
  registry.load();
  registry.syncCatalog();

  const compte = (table) =>
    database
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = ?`)
      .get('fantome-lot31').n;

  assert.equal(compte('connector_catalog'), 0, 'la ligne de catalogue devait disparaître');
  assert.equal(compte('connector_logos'), 0, 'le logo orphelin devait disparaître');
  assert.equal(compte('logo_failures'), 0, 'l\'échec de logo orphelin devait disparaître');

  // Et il ne revient pas : un second démarrage n'a rien à ressusciter.
  registry.load();
  registry.syncCatalog();
  assert.equal(compte('connector_catalog'), 0, 'le redémarrage a ressuscité l\'entrée supprimée');

  // Le nettoyage n'a emporté QUE l'orphelin.
  const apres = db.get().prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;
  assert.equal(apres, avant - 1, 'seule la ligne orpheline devait être retirée');
});

test('les six retirés ne sont plus jamais semés en base', () => {
  registry.load();
  registry.syncCatalog();
  for (const id of RETIRES) {
    const ligne = db
      .get()
      .prepare('SELECT connector_id FROM connector_catalog WHERE connector_id = ?')
      .get(id);
    assert.equal(ligne, undefined, `« ${id} » est réapparu dans connector_catalog`);
  }
});

// ---------------------------------------------------------------------------
// 3. La protection — le disque fait foi, pas le registre chargé
// ---------------------------------------------------------------------------

test('un manifeste présent sur le disque protège sa ligne, même non chargé', () => {
  const database = db.get();
  registry.load();
  registry.syncCatalog();
  const livres = database.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;
  assert.ok(livres >= 40, `le semis n'a produit que ${livres} ligne(s) : il ne sème plus`);

  // Un registre réduit à UN connecteur de test : sans la protection par le
  // disque, ce chargement ferait passer tous les services livrés pour des
  // orphelins, et le semis suivant effacerait leurs réglages d'administration.
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot31-cat-'));
  fs.mkdirSync(path.join(dossier, 'seul'));
  fs.writeFileSync(
    path.join(dossier, 'seul', 'manifest.json'),
    JSON.stringify({
      id: 'seul',
      name: 'Seul',
      category: 'energie',
      color: '#123456',
      letters: 'SE',
      description: 'Connecteur de test du nettoyage du catalogue.',
      fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
      permissions: [
        { key: 'factures', scope: 'read-write', description: 'Connecteur de test, rien de réel.' },
      ],
    })
  );
  fs.writeFileSync(
    path.join(dossier, 'seul', 'connector.js'),
    "module.exports = { test: async () => ({ ok: true }), fetchInvoices: async () => [] };"
  );

  try {
    registry.load(dossier);
    registry.syncCatalog();

    const restants = database.prepare('SELECT COUNT(*) AS n FROM connector_catalog').get().n;
    assert.equal(
      restants,
      livres + 1,
      'les lignes des services livrés devaient survivre au chargement d\'un registre de test'
    );
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
    registry.load();
    registry.syncCatalog();
    // La ligne du connecteur de test est devenue orpheline : le semis du
    // « redémarrage » ci-dessus vient de la retirer — c'est le comportement
    // qu'on documente, et il remet la base d'aplomb pour les tests suivants.
    assert.equal(
      database.prepare('SELECT COUNT(*) AS n FROM connector_catalog WHERE connector_id = ?').get('seul').n,
      0
    );
  }
});
