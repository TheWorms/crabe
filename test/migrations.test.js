'use strict';

/**
 * Migrations de schéma : vérifiées sur une copie représentative de la base de
 * production (schéma d'avant la refonte, avec un admin, un connecteur
 * configuré, des factures et un ticket déjà répondu).
 *
 * Ce que le test garantit : aucune donnée perdue, aucun droit perdu, et une
 * seconde ouverture ne rejoue rien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

require('./helpers'); // pose les variables d'environnement de test
const db = require('../server/db/db');
const permissions = require('../server/permissions');

/** Schéma tel qu'il était livré avant cette mission (extrait utile). */
const OLD_SCHEMA = `
CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  email          TEXT,
  phone          TEXT,
  password_hash  TEXT    NOT NULL,
  totp_secret    TEXT,
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  role           TEXT    NOT NULL DEFAULT 'user'   CHECK (role   IN ('admin','user')),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  landing_page   TEXT    NOT NULL DEFAULT 'apps'   CHECK (landing_page IN ('apps','local','papiers')),
  avatar_color   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at  TEXT,
  password_changed_at TEXT
);
CREATE TABLE connector_catalog (
  connector_id  TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  maintenance   INTEGER NOT NULL DEFAULT 0,
  allowed_users TEXT NOT NULL DEFAULT '"all"',
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','pending')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE connector_installs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id     TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'needs-config'
                     CHECK (status IN ('needs-config','installed','error')),
  config_encrypted TEXT,
  last_error       TEXT,
  last_run_at      TEXT,
  installed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, connector_id)
);
CREATE TABLE destinations_config (
  dest_id          TEXT PRIMARY KEY CHECK (dest_id IN ('local','proton','pcloud')),
  enabled          INTEGER NOT NULL DEFAULT 0,
  path             TEXT,
  protocol         TEXT,
  config_encrypted TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE destination_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  dest_id TEXT NOT NULL,
  user_id INTEGER,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL,
  message TEXT
);
CREATE TABLE invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id  TEXT    NOT NULL,
  filename      TEXT    NOT NULL,
  remote_id     TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  issued_on     TEXT,
  fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  destinations  TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (user_id, connector_id, filename)
);
CREATE TABLE run_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id  TEXT    NOT NULL,
  user_id       INTEGER,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  success       INTEGER NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT    NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','cron','test')),
  message       TEXT
);
CREATE TABLE connection_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER,
  username TEXT,
  date     TEXT NOT NULL DEFAULT (datetime('now')),
  os       TEXT,
  browser  TEXT,
  ip       TEXT,
  success  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject        TEXT    NOT NULL,
  message        TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'recu'
                   CHECK (status IN ('recu','en-cours','repondu','ferme')),
  reply          TEXT    NOT NULL DEFAULT '',
  hidden_by_user INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE deletion_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  wants_export       INTEGER NOT NULL DEFAULT 0,
  export_sent        INTEGER NOT NULL DEFAULT 0,
  export_path        TEXT,
  revoked            INTEGER NOT NULL DEFAULT 0,
  requested_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at         TEXT,
  scheduled_delete_at TEXT   NOT NULL
);
CREATE TABLE security_policy (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  require_2fa         INTEGER NOT NULL DEFAULT 1,
  password_complexity TEXT    NOT NULL DEFAULT 'medium'
                        CHECK (password_complexity IN ('low','medium','high')),
  log_retention_days  INTEGER NOT NULL DEFAULT 365,
  smtp_host           TEXT,
  smtp_port           INTEGER,
  smtp_user           TEXT,
  smtp_pass_encrypted TEXT,
  smtp_from           TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE connector_schedules (
  connector_id TEXT PRIMARY KEY,
  frequency    TEXT    NOT NULL DEFAULT 'monthly'
                 CHECK (frequency IN ('daily','weekly','monthly','disabled')),
  time_of_day  TEXT    NOT NULL DEFAULT '03:00',
  day_of_week  INTEGER NOT NULL DEFAULT 1,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

/** Point de montage visé par la migration 8, comme sur le LXC. */
const MOUNT_POINT = '/mnt/local';

let dir;
let file;

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-migr-'));
  file = path.join(dir, 'crabe.db');

  const legacy = new Database(file);
  legacy.exec(OLD_SCHEMA);

  // Une base de production : un admin (2FA « activée » par le bootstrap sans
  // qu'aucun QR n'ait été scanné), un utilisateur, des connecteurs, un ticket.
  legacy
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, role, totp_enabled, totp_secret)
       VALUES (1, 'camille', 'camille@example.test', 'hash-argon2', 'admin', 1, 'v1.secret-fantome')`
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO users (id, username, password_hash, role) VALUES (2, 'invite', 'hash', 'user')`
    )
    .run();
  legacy.prepare("INSERT INTO security_policy (id, require_2fa) VALUES (1, 1)").run();
  legacy
    .prepare("INSERT INTO connector_catalog (connector_id, category) VALUES ('ovh', 'hebergement')")
    .run();
  legacy
    .prepare(
      `INSERT INTO connector_installs (user_id, connector_id, status, config_encrypted)
       VALUES (1, 'ovh', 'installed', 'v1.chiffre')`
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, size_bytes)
       VALUES (1, 'ovh', 'ovh_2026-06_FR1.pdf', 'FR1', 1234)`
    )
    .run();
  // Facture au format d'AVANT le lot 3 : un succès sans état ni horodatage.
  legacy
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, size_bytes, destinations)
       VALUES (1, 'ovh', 'ovh_2026-07_FR2.pdf', 'FR2', 2345, ?)`
    )
    .run(JSON.stringify({ local: { ok: true, path: '/mnt/local/camille/OVH/x/ovh_2026-07_FR2.pdf' } }));
  // Planification GLOBALE héritée du lot 1 : elle doit devenir la
  // planification du couple (camille, ovh), sans être perdue.
  legacy
    .prepare(
      `INSERT INTO connector_schedules (connector_id, frequency, time_of_day, day_of_week, day_of_month, enabled)
       VALUES ('ovh', 'monthly', '04:30', 2, 12, 1)`
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO tickets (id, user_id, subject, message, status, reply)
       VALUES (1, 2, 'Question', 'Bonjour, une question.', 'repondu', 'Bonjour, voici la réponse.')`
    )
    .run();
  // Destination locale telle que la production l'avait : sur l'ancien défaut
  // <dataDir>/local, un dossier qui n'existe pas (voir migration 8).
  legacy
    .prepare(
      `INSERT INTO destinations_config (dest_id, enabled, path, protocol)
       VALUES ('local', 1, ?, 'local')`
    )
    .run(path.join(require('../server/config').config.dataDir, 'local'));
  legacy.close();

  // En production, le point de montage diffère de l'ancien défaut : c'est
  // TOUT le sujet de la migration 8. Les tests, eux, ramènent le stockage local dans
  // leur répertoire temporaire — on rétablit ici l'écart réel pour que la
  // migration ait quelque chose à corriger.
  require('../server/config').config.localPath = MOUNT_POINT;
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('les migrations s\'appliquent sur une base existante sans rien perdre', () => {
  const database = db.open(file);

  assert.ok(db.migrations.applied.length >= 7, 'toutes les migrations doivent passer');

  // Données intactes.
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(
    database.prepare('SELECT config_encrypted FROM connector_installs WHERE user_id = 1').get()
      .config_encrypted,
    'v1.chiffre',
    'la configuration chiffrée doit être conservée telle quelle'
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, 2);
  assert.equal(database.prepare('SELECT subject FROM tickets WHERE id = 1').get().subject, 'Question');
});

test('le compte administrateur conserve ses droits après migration', () => {
  const admin = db.get().prepare('SELECT * FROM users WHERE username = ?').get('camille');
  assert.equal(admin.role, 'admin');
  assert.ok(admin.role_id, 'un rôle doit avoir été attribué');
  assert.equal(permissions.roleById(admin.role_id).slug, 'admin');
  assert.deepEqual(
    permissions.permissionsForUser(admin).sort(),
    [...permissions.PERMISSION_IDS].sort()
  );

  const guest = db.get().prepare('SELECT * FROM users WHERE username = ?').get('invite');
  assert.equal(permissions.roleById(guest.role_id).slug, 'user');
  assert.deepEqual(permissions.permissionsForUser(guest), []);
});

test('la 2FA fantôme du bootstrap est neutralisée, pas rendue obligatoire', () => {
  const policy = db.get().prepare('SELECT * FROM security_policy WHERE id = 1').get();
  assert.equal(policy.require_2fa, 0, 'la 2FA ne doit plus être exigée');
  assert.equal(policy.allow_2fa, 1, 'un compte avait un secret : la 2FA reste autorisée');

  // Le compte gardait un secret jamais confirmé côté application : il reste
  // en place puisque totp_enabled valait 1 (l'admin peut le réinitialiser).
  const admin = db.get().prepare('SELECT totp_enabled FROM users WHERE username = ?').get('camille');
  assert.equal(admin.totp_enabled, 1);
});

test('le fil de conversation reprend l\'historique existant', () => {
  const messages = db
    .get()
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = 1 ORDER BY id')
    .all();

  assert.equal(messages.length, 2);
  assert.equal(messages[0].author, 'user');
  assert.equal(messages[0].body, 'Bonjour, une question.');
  assert.equal(messages[1].author, 'admin');
  assert.equal(messages[1].body, 'Bonjour, voici la réponse.');

  const ticket = db.get().prepare('SELECT read_at FROM tickets WHERE id = 1').get();
  assert.ok(ticket.read_at, 'un ticket déjà répondu est marqué comme lu');
});

test('les nouvelles colonnes et tables sont là', () => {
  const migrations = require('../server/db/migrations');
  const database = db.get();

  assert.equal(migrations.hasColumn(database, 'connector_installs', 'account_id'), true);
  assert.equal(migrations.hasColumn(database, 'invoices', 'account_id'), true);
  assert.equal(migrations.hasColumn(database, 'tickets', 'read_at'), true);
  assert.equal(migrations.hasColumn(database, 'security_policy', 'allow_2fa'), true);

  for (const table of ['roles', 'role_permissions', 'app_logs', 'app_settings', 'ticket_messages', 'email_change_requests']) {
    assert.equal(migrations.hasTable(database, table), true, `table ${table}`);
  }

  const settings = database.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  assert.equal(settings.timezone, 'Europe/Paris');
  assert.equal(settings.time_format, '24');
  assert.equal(settings.date_format, 'DD/MM/YYYY');
  assert.equal(settings.gravatar_enabled, 0, 'Gravatar est désactivé par défaut');
});

test('migration 8 : le chemin du stockage local est ramené sur le point de montage', () => {
  const row = db
    .get()
    .prepare("SELECT path, protocol, enabled FROM destinations_config WHERE dest_id = 'local'")
    .get();

  assert.equal(row.path, MOUNT_POINT, 'l\'ancien défaut doit être corrigé');
  assert.equal(row.protocol, 'local', 'le protocole déclaré n\'est pas touché');
  assert.equal(row.enabled, 1, 'Le stockage local reste la destination obligatoire');
});

test('migration 9 : SMTP enrichi et modèles d\'e-mail installés', () => {
  const migrations = require('../server/db/migrations');
  const templates = require('../server/email-templates');
  const database = db.get();

  assert.equal(migrations.hasColumn(database, 'security_policy', 'smtp_secure'), true);
  assert.equal(migrations.hasColumn(database, 'security_policy', 'smtp_from_name'), true);
  assert.equal(migrations.hasTable(database, 'email_templates'), true);

  const rows = database.prepare('SELECT key, subject, body FROM email_templates ORDER BY key').all();
  assert.equal(rows.length, templates.KEYS.length, 'les modèles par défaut sont insérés');
  for (const row of rows) {
    assert.ok(templates.definition(row.key), `modèle inconnu en base : ${row.key}`);
    assert.ok(row.subject.trim() && row.body.trim());
  }

  // La configuration SMTP existante n'est pas perturbée : sans choix explicite,
  // le mode reste déduit du port, exactement comme avant.
  const policy = database.prepare('SELECT * FROM security_policy WHERE id = 1').get();
  assert.equal(policy.smtp_secure, null);
  assert.equal(require('../server/mailer').secureMode(policy), 'starttls');
});

test('migration 10 : la disposition de l\'accueil est prête, et vide', () => {
  const migrations = require('../server/db/migrations');
  const database = db.get();

  assert.equal(migrations.hasTable(database, 'user_home_widgets'), true);
  // Aucune ligne créée : un compte sans préférence reçoit la disposition par
  // défaut, il n'y a rien à reprendre d'une base existante.
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM user_home_widgets').get().n, 0);

  const home = require('../server/home');
  assert.deepEqual(home.preferencesFor(1).map((w) => w.id), home.DEFAULT_ORDER);
});

test('migration 11 : la planification globale devient celle de l\'installation', () => {
  const database = db.get();

  const lignes = database.prepare('SELECT * FROM user_connector_schedules').all();
  assert.equal(lignes.length, 1, 'une ligne par installation réelle, pas par connecteur');

  const [ligne] = lignes;
  assert.equal(ligne.user_id, 1);
  assert.equal(ligne.connector_id, 'ovh');
  // Les réglages de l'administrateur sont repris tels quels.
  assert.equal(ligne.frequency, 'monthly');
  assert.equal(ligne.time_of_day, '04:30');
  assert.equal(ligne.day_of_month, 12);
  assert.equal(ligne.last_day_of_month, 0);

  // L'ancienne table est CONSERVÉE : elle devient le gabarit des prochaines
  // installations. Rien n'est supprimé.
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connector_schedules').get().n, 1);
});

test('migration 12 : les factures existantes passent en « inconnu », jamais en « OK »', () => {
  const database = db.get();
  const invoices = require('../server/invoices');

  const row = database
    .prepare("SELECT destinations FROM invoices WHERE filename = 'ovh_2026-07_FR2.pdf'")
    .get();
  const stored = JSON.parse(row.destinations);

  assert.equal(stored.local.state, 'unknown', 'aucun succès inventé');
  assert.equal(stored.local.at, null, 'aucune date inventée');
  // Ce qui était connu est conservé : la comptabilité de stockage et le
  // chemin de téléchargement continuent de fonctionner.
  assert.equal(stored.local.ok, true);
  assert.match(stored.local.path, /ovh_2026-07_FR2\.pdf$/);

  const [pastille] = invoices.statesFor(row.destinations, ['local']);
  assert.equal(pastille.state, 'unknown');
  assert.match(pastille.tooltip, /état inconnu/);

  // Une facture sans aucune trace reste « en attente », pas « copiée ».
  const vierge = database
    .prepare("SELECT destinations FROM invoices WHERE filename = 'ovh_2026-06_FR1.pdf'")
    .get();
  assert.equal(invoices.statesFor(vierge.destinations, ['local'])[0].state, 'pending');
});

test('une seconde ouverture ne rejoue aucune migration', () => {
  const applied = db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;

  db.close();
  db.open(file);

  assert.deepEqual(db.migrations.applied, [], 'rien à rejouer');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, applied);
  assert.equal(
    db.get().prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = 1').get().n,
    2,
    'le fil ne doit pas être dupliqué'
  );
});
