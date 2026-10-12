'use strict';

/**
 * Lot 103 — l'annonce BetterMe est supprimée, et ne revient pas.
 *
 * Supprimer le dossier `planned/betterme/` retire l'annonce du registre ; sa
 * ligne de catalogue, elle, vit dans la base de chaque installation. La
 * migration 62 la retire avec son logo et l'échec de son logo — les trois
 * ensemble : `syncCatalog()` part des lignes de catalogue, une ligne de logo
 * laissée seule ne serait plus jamais nettoyée (c'est arrivé après la
 * migration 25).
 *
 *   1. le registre ne la charge plus : 60 connecteurs, 28 annonces ;
 *   2. la migration 62, sur une table en mémoire : les trois lignes partent,
 *      celles d'un autre service restent, une seconde application ne change
 *      rien ;
 *   3. par le chemin réel (`schema.sql` + `migrations.apply`) sur une base
 *      d'avant ce lot : seule la 62 s'applique, une seconde passe n'applique
 *      rien, l'intégrité tient ;
 *   4. au démarrage — `db.open`, puis le registre et son catalogue, comme
 *      `server/index.js` — sur une base d'avant ce lot : BetterMe n'y est
 *      plus, ni au premier démarrage, ni au suivant.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const RACINE = path.join(__dirname, '..');
const ID = 'betterme';
const SCHEMA = fs.readFileSync(path.join(RACINE, 'server', 'db', 'schema.sql'), 'utf8');

/** Les lignes de BetterMe dans les trois tables du catalogue. */
function sesLignes(base) {
  return Object.fromEntries(['connector_catalog', 'connector_logos', 'logo_failures'].map((table) => [
    table, base.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = ?`).get(ID).n,
  ]));
}

/** Une base « d'avant ce lot » : tout migré sauf la 62, et BetterMe avec ses trois lignes. */
function baseDAvant(base) {
  const migrations = require('../server/db/migrations');
  base.exec(SCHEMA);
  migrations.apply(base);
  base.prepare('DELETE FROM schema_migrations WHERE id = 62').run();
  base.prepare('INSERT INTO connector_catalog (connector_id, category, status) VALUES (?, ?, ?)')
    .run(ID, 'sante', 'available');
  base.prepare('INSERT INTO connector_logos (connector_id, extension, source, bytes) VALUES (?, ?, ?, ?)')
    .run(ID, 'png', 'fetched', 1234);
  base.prepare('INSERT INTO logo_failures (connector_id, reason) VALUES (?, ?)').run(ID, 'essai');
  // Un autre service, avec sa ligne et son logo : ils doivent rester.
  base.prepare('INSERT OR IGNORE INTO connector_catalog (connector_id, category, status) VALUES (?, ?, ?)')
    .run('olivier-assurance', 'sante', 'available');
  base.prepare('INSERT INTO connector_logos (connector_id, extension, source, bytes) VALUES (?, ?, ?, ?)')
    .run('olivier-assurance', 'png', 'fetched', 4321);
}

test('R5 — le registre ne charge plus BetterMe : 60 connecteurs, 28 annonces, aucune erreur', () => {
  const registry = require('../server/connectors/registry');
  const r = registry.load();
  assert.deepEqual(r.errors, []);
  // Lot 104 : trois annonces deviennent connecteurs (63 chargés, 25 annoncés).
  assert.equal(r.loaded, 63);
  assert.equal(r.planned, 25);
  assert.equal(registry.has(ID), false);
  assert.equal(fs.existsSync(path.join(RACINE, 'server', 'connectors', 'planned', ID)), false);
});

test('D2 — la migration 62 retire la ligne de catalogue, le logo et l\'échec de logo de BetterMe, et rien d\'autre ; une seconde application ne change rien', () => {
  const { MIGRATIONS } = require('../server/db/migrations');
  const m62 = MIGRATIONS.find((m) => m.id === 62);
  assert.ok(m62, 'la migration 62 existe');
  assert.match(m62.name, /BetterMe/);
  const base = new Database(':memory:');
  try {
    base.exec(`CREATE TABLE connector_catalog (connector_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', published_at TEXT);
      CREATE TABLE connector_logos (connector_id TEXT PRIMARY KEY, extension TEXT NOT NULL);
      CREATE TABLE logo_failures (connector_id TEXT PRIMARY KEY, reason TEXT NOT NULL);`);
    for (const id of [ID, 'olivier-assurance']) {
      base.prepare('INSERT INTO connector_catalog (connector_id, category) VALUES (?, ?)').run(id, 'sante');
      base.prepare('INSERT INTO connector_logos (connector_id, extension) VALUES (?, ?)').run(id, 'png');
      base.prepare('INSERT INTO logo_failures (connector_id, reason) VALUES (?, ?)').run(id, 'essai');
    }
    m62.up(base);
    assert.deepEqual(sesLignes(base), { connector_catalog: 0, connector_logos: 0, logo_failures: 0 });
    for (const table of ['connector_catalog', 'connector_logos', 'logo_failures']) {
      assert.equal(base.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = 'olivier-assurance'`).get().n, 1,
        `${table} : l'autre service reste`);
    }
    m62.up(base);
    assert.deepEqual(sesLignes(base), { connector_catalog: 0, connector_logos: 0, logo_failures: 0 }, 'idempotente');
  } finally {
    base.close();
  }
  // Sur une base qui n'a pas (encore) ces tables : rien, et pas d'erreur.
  const vide = new Database(':memory:');
  try {
    assert.doesNotThrow(() => m62.up(vide));
  } finally {
    vide.close();
  }
});

test('D2 — par le chemin réel : une base d\'avant ce lot (migration 61) ; seule la 62 s\'applique ; relancer n\'applique rien', () => {
  const migrations = require('../server/db/migrations');
  const base = new Database(':memory:');
  try {
    baseDAvant(base);
    const compte = (table) => base.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const avant = { catalogue: compte('connector_catalog'), logos: compte('connector_logos') };
    assert.deepEqual(sesLignes(base), { connector_catalog: 1, connector_logos: 1, logo_failures: 1 });
    const appliquees = migrations.apply(base);
    assert.deepEqual(appliquees.applied.map((m) => m.id), [62], JSON.stringify(appliquees));
    assert.equal(appliquees.current, Math.max(...migrations.MIGRATIONS.map((m) => m.id)));
    assert.deepEqual(sesLignes(base), { connector_catalog: 0, connector_logos: 0, logo_failures: 0 });
    assert.equal(compte('connector_catalog'), avant.catalogue - 1, 'une ligne de catalogue, la sienne');
    assert.equal(compte('connector_logos'), avant.logos - 1, 'un logo, le sien');
    assert.deepEqual(migrations.apply(base).applied, [], 'une seconde application ne fait rien');
    assert.equal(base.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    base.close();
  }
});

test('D2 — au démarrage, sur une base d\'avant ce lot : BetterMe ne revient pas, ni au premier démarrage, ni au suivant', () => {
  const db = require('../server/db/db');
  const registry = require('../server/connectors/registry');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot103-demarrage-'));
  const fichier = path.join(dossier, 'crabe.db');
  try {
    const ancienne = new Database(fichier);
    baseDAvant(ancienne);
    ancienne.close();

    for (const passage of ['premier démarrage', 'démarrage suivant']) {
      // L'ordre de server/index.js : la base (et ses migrations), puis le registre et son catalogue.
      db.open(fichier);
      try {
        registry.load();
        registry.syncCatalog();
        assert.deepEqual(sesLignes(db.get()), { connector_catalog: 0, connector_logos: 0, logo_failures: 0 }, passage);
        assert.equal(registry.listAll().some((c) => c.id === ID), false, `${passage} : absent du catalogue`);
        assert.equal(registry.listPlanned().length, 25, passage); // 28 au lot 103, 25 depuis le lot 104
        assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM connector_catalog WHERE connector_id = ?')
          .get('olivier-assurance').n, 1, `${passage} : les autres annonces restent`);
        assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 62').get().n, 1,
          `${passage} : la migration 62 est enregistrée`);
      } finally {
        db.close();
      }
    }
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
