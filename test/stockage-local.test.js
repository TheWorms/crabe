'use strict';

/**
 * Destination locale : résolution du chemin par défaut et diagnostic.
 *
 * Contexte : en production, la destination avait été initialisée avec
 * `<dataDir>/local` (/opt/crabe/data/local), un dossier qui n'existe pas,
 * alors que le point de montage réel est /mnt/local. L'interface affichait
 * un « écriture impossible » générique qui ne disait pas quoi corriger.
 *
 * Ce fichier verrouille les deux corrections : le chemin par défaut (et sa
 * migration) d'un côté, la précision du diagnostic de l'autre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const { config } = require('../server/config');
const local = require('../server/destinations/local');
const migrations = require('../server/db/migrations');

/** Répertoire de travail jetable, nettoyé à la fin du fichier. */
function tempDir(prefix = 'crabe-local-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Chemin par défaut et migration
// ---------------------------------------------------------------------------

test('le chemin du stockage local est configurable par l\'environnement', () => {
  // helpers.js pose CRABE_LOCAL_PATH sur le répertoire temporaire du test :
  // c'est exactement le mécanisme attendu en production avec /mnt/local.
  assert.equal(config.localPath, path.join(config.dataDir, 'local'));
  assert.notEqual(config.localPath, '', 'un défaut doit toujours exister');
});

test('sans variable d\'environnement, le défaut est le point de montage /mnt/local', () => {
  // config.js lit process.env au chargement : on recharge le module dans un
  // processus neuf, sans CRABE_LOCAL_PATH, pour vérifier le vrai défaut.
  const env = { ...process.env };
  delete env.CRABE_LOCAL_PATH;
  delete env.CRABE_DATA_DIR;

  const out = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("./server/config").config.localPath)'],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }
  );
  assert.equal(out, '/mnt/local');
});

/** Base minimale portant la seule table qui intéresse la migration 8. */
function legacyDatabase(currentPath, protocol = 'local') {
  const dir = tempDir();
  const database = new Database(path.join(dir, 'legacy.db'));
  database.exec(`
    CREATE TABLE destinations_config (
      dest_id          TEXT PRIMARY KEY,
      enabled          INTEGER NOT NULL DEFAULT 0,
      path             TEXT,
      protocol         TEXT,
      config_encrypted TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  database
    .prepare(
      "INSERT INTO destinations_config (dest_id, enabled, path, protocol) VALUES ('local', 1, ?, ?)"
    )
    .run(currentPath, protocol);
  test.after(() => database.close());
  return database;
}

test('la migration 8 remplace l\'ancien défaut <dataDir>/local', () => {
  const legacy = '/opt/crabe/data/local';
  const database = legacyDatabase(legacy);

  const changed = migrations.fixLegacyLocalPath(database, {
    legacy,
    target: '/mnt/local',
  });

  assert.equal(changed, 1);
  const row = database.prepare("SELECT path FROM destinations_config WHERE dest_id = 'local'").get();
  assert.equal(row.path, '/mnt/local');
});

test('la migration 8 ne touche pas un chemin personnalisé', () => {
  const database = legacyDatabase('/srv/factures-a-moi', 'nfs');

  const changed = migrations.fixLegacyLocalPath(database, {
    legacy: '/opt/crabe/data/local',
    target: '/mnt/local',
  });

  assert.equal(changed, 0);
  const row = database.prepare("SELECT path FROM destinations_config WHERE dest_id = 'local'").get();
  assert.equal(row.path, '/srv/factures-a-moi', 'un chemin choisi par l\'admin est intouchable');
});

test('la migration 8 est rejouable et sans effet si la cible vaut déjà l\'ancien défaut', () => {
  const legacy = '/opt/crabe/data/local';
  const database = legacyDatabase(legacy);

  assert.equal(migrations.fixLegacyLocalPath(database, { legacy, target: legacy }), 0);
  assert.equal(migrations.fixLegacyLocalPath(database, { legacy, target: '/mnt/local' }), 1);
  // Deuxième passage : plus rien ne correspond à l'ancien défaut.
  assert.equal(migrations.fixLegacyLocalPath(database, { legacy, target: '/mnt/local' }), 0);

  const row = database.prepare("SELECT path FROM destinations_config WHERE dest_id = 'local'").get();
  assert.equal(row.path, '/mnt/local');
});

test('la migration 8 est bien enregistrée dans la liste des migrations', () => {
  const migration = migrations.MIGRATIONS.find((m) => m.id === 8);
  assert.ok(migration, 'la migration 8 doit exister');
  assert.match(migration.name, /stockage local/);
});

test('la destination locale de la base de test pointe sur le chemin configuré', async () => {
  await helpers.setup();
  const destinations = require('../server/destinations');
  assert.equal(destinations.readConfig('local').path, config.localPath);
});

// ---------------------------------------------------------------------------
// Diagnostic : quatre situations, quatre messages
// ---------------------------------------------------------------------------

test('aucun chemin configuré : le message dit quoi renseigner', async () => {
  const result = await local.diagnose({ path: '', protocol: 'local' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unset');
  assert.match(result.message, /Aucun chemin configuré/);
  assert.match(result.message, /mnt\/local/);
});

test('partage réseau non monté : « n\'existe pas », pas « écriture impossible »', async () => {
  const dir = tempDir();
  const absent = path.join(dir, 'jamais-monte');

  const result = await local.diagnose({ path: absent, protocol: 'nfs' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'missing');
  assert.match(result.message, /n'est pas monté/);
  assert.equal(fs.existsSync(absent), false, 'un partage réseau ne doit jamais être créé par crabe');
});

test('dossier déclaré NFS mais qui n\'est pas un point de montage', async () => {
  const dir = tempDir();
  const fauxMontage = path.join(dir, 'faux-montage');
  fs.mkdirSync(fauxMontage);

  const result = await local.diagnose({ path: fauxMontage, protocol: 'nfs' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'not-mounted');
  assert.match(result.message, /pas un point de montage/);
  assert.match(result.message, /disque local du conteneur/);
});

test('dossier local absent : crabe le crée et répond OK', async () => {
  const dir = tempDir();
  const target = path.join(dir, 'local-local');

  const result = await local.diagnose({ path: target, protocol: 'local' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ok');
  assert.equal(result.mounted, false);
  assert.match(result.message, /dossier local/);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(path.join(target, '.crabe-write-test')), false, 'la sonde est effacée');
});

test('le chemin existe mais n\'est pas un dossier', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'un-fichier');
  fs.writeFileSync(file, 'pas un dossier');

  const result = await local.diagnose({ path: file, protocol: 'local' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'not-directory');
  assert.match(result.message, /n'est pas un dossier/);
});

test('dossier en lecture seule : le message vise les droits, pas le montage', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    return t.skip('root écrit partout : le cas « écriture refusée » n\'est pas reproductible');
  }
  const dir = tempDir();
  const target = path.join(dir, 'lecture-seule');
  fs.mkdirSync(target);
  fs.chmodSync(target, 0o500);

  try {
    const result = await local.diagnose({ path: target, protocol: 'local' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'read-only');
    assert.match(result.message, /Écriture refusée/);
    assert.match(result.message, /chown crabe:crabe/);
  } finally {
    // Rendu inscriptible avant le nettoyage du répertoire temporaire.
    fs.chmodSync(target, 0o700);
  }
});

test('test() reste l\'API des destinations et renvoie le diagnostic', async () => {
  const dir = tempDir();
  const result = await local.test({ path: path.join(dir, 'via-test'), protocol: 'local' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.message, 'string');
  assert.equal(result.state, 'ok');
});

test('isMountPoint distingue un dossier ordinaire d\'un point de montage', (t) => {
  const dir = tempDir();
  const sub = path.join(dir, 'sous-dossier');
  fs.mkdirSync(sub);
  assert.equal(local.isMountPoint(sub), false);
  assert.equal(local.isMountPoint(path.join(dir, 'inexistant')), false);

  // /proc est un point de montage sur tout Linux : son périphérique diffère
  // de celui de la racine.
  if (!fs.existsSync('/proc/self')) return t.skip('/proc absent sur cette plateforme');
  assert.equal(local.isMountPoint('/proc'), true);
});

test.after(() => helpers.teardown());
