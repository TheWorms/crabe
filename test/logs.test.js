'use strict';

/**
 * Journaux : quatre familles, un seul réglage de rétention.
 * Et la planification, dont l'heure de prochaine exécution doit être calculée
 * dans le fuseau applicatif — pas dans celui du conteneur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const applog = require('../server/applog');
const scheduler = require('../server/scheduler');
const settings = require('../server/settings');
const tz = require('../server/timezone');

let admin;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'journaliste',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(require('../server/permissions').roleBySlug('admin').id, admin.id);
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Journal applicatif
// ---------------------------------------------------------------------------

test('le journal applicatif enregistre niveau, source et message', () => {
  applog.info('test', 'Un démarrage.');
  applog.warn('test', 'Un avertissement.');
  applog.error('test', 'Une erreur.', { userId: admin.id, username: admin.username });

  const rows = applog.list({ limit: 10 });
  assert.ok(rows.length >= 3);

  const err = rows.find((r) => r.message === 'Une erreur.');
  assert.equal(err.level, 'error');
  assert.equal(err.source, 'test');
  assert.equal(err.username, 'journaliste');
});

test('le filtre par niveau et la recherche plein texte fonctionnent', () => {
  applog.info('recherche', 'Aiguille dans une botte de foin.');

  const warnings = applog.list({ level: 'warn' });
  assert.equal(
    warnings.every((r) => r.level === 'warn'),
    true
  );

  const found = applog.list({ q: 'Aiguille' });
  assert.equal(found.length, 1);
  assert.equal(found[0].source, 'recherche');

  const counts = applog.counts();
  assert.equal(counts.all, counts.info + counts.warn + counts.error);
});

test('un niveau inconnu retombe sur info plutôt que d\'échouer', () => {
  applog.write('catastrophique', 'test', 'Niveau inventé.');
  const row = applog.list({ q: 'Niveau inventé' })[0];
  assert.equal(row.level, 'info');
});

// ---------------------------------------------------------------------------
// Routes des onglets
// ---------------------------------------------------------------------------

test('les trois onglets de logs répondent, avec leurs filtres', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'journaliste', 'MotDePasse1');

  const runs = await client.get('/api/admin/logs/runs');
  assert.equal(runs.status, 200);
  assert.ok(Array.isArray(runs.body.logs));
  assert.ok(Array.isArray(runs.body.filters));

  const app = await client.get('/api/admin/logs/app?level=error');
  assert.equal(app.status, 200);
  assert.equal(
    app.body.logs.every((l) => l.level === 'error'),
    true
  );
  assert.ok(app.body.counts.all > 0);

  const storage = await client.get('/api/admin/logs/storage');
  assert.equal(storage.status, 200);
  // Le filtre propose TOUTES les destinations du catalogue, pas seulement les
  // activées : un journal d'échec reste consultable après qu'on a éteint la
  // destination qui l'a produit. Six depuis le lot 24.
  assert.deepEqual(
    storage.body.filters.map((f) => f.id).sort(),
    // Depuis le lot 25, le filtre ne propose que les destinations qui
    // EXISTENT : proposer six fournisseurs dont aucun n'est configuré donnait
    // cinq filtres qui ne rendaient jamais rien. Depuis le lot 58, s'y ajoute
    // « Renommage des documents » : le journal du chantier d'harmonisation vit
    // aussi dans cet onglet (demande du 25/08/2026), et son filtre avec.
    ['harmonisation', 'local']
  );

  // Les connexions restent servies ici, mais s'affichent dans « Sécurité ».
  const connections = await client.get('/api/admin/logs/connections?days=30');
  assert.equal(connections.status, 200);
  assert.ok(connections.body.retentionOptions.length === 6);
});

test('la rétention purge les quatre familles de journaux', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'journaliste', 'MotDePasse1');

  // On antidate une ligne de chaque famille.
  const old = "datetime('now', '-400 days')";
  helpers.db.get().exec(`
    INSERT INTO connection_logs (username, date, success) VALUES ('vieux', ${old}, 1);
    INSERT INTO run_logs (connector_id, started_at) VALUES ('edf', ${old});
    INSERT INTO destination_logs (dest_id, at, success) VALUES ('local', ${old}, 1);
    INSERT INTO app_logs (at, level, source, message) VALUES (${old}, 'info', 'vieux', 'Trop vieux.');
  `);

  const result = await client.put('/api/admin/logs/retention', { days: 365 });
  assert.equal(result.status, 200);
  assert.equal(result.body.retentionDays, 365);
  assert.ok(result.body.purged >= 4, `attendu au moins 4 purges, obtenu ${result.body.purged}`);
  assert.ok(result.body.detail.connections >= 1);
  assert.ok(result.body.detail.runs >= 1);
  assert.ok(result.body.detail.storage >= 1);
  assert.ok(result.body.detail.app >= 1);

  assert.equal(
    helpers.db.get().prepare("SELECT COUNT(*) AS n FROM app_logs WHERE source = 'vieux'").get().n,
    0
  );
});

test('les opérations d\'administration laissent une trace', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'journaliste', 'MotDePasse1');

  await client.post('/api/users', {
    username: 'traceable',
    password: 'MotDePasse1',
    role: 'user',
  });

  const trace = applog.list({ q: 'traceable' });
  assert.ok(trace.length >= 1);
  assert.equal(trace[0].source, 'admin');
  assert.equal(trace[0].username, 'journaliste');
});

// ---------------------------------------------------------------------------
// Prochaine exécution et fuseau horaire
// ---------------------------------------------------------------------------

test('la prochaine exécution est calculée dans le fuseau configuré', () => {
  settings.updateAppSettings({ timezone: 'Europe/Paris' });

  const daily = scheduler.nextRunAt(
    { frequency: 'daily', timeOfDay: '03:00', enabled: true },
    new Date('2026-07-30T12:00:00Z')
  );
  // 03:00 à Paris en été = 01:00 UTC, donc le lendemain.
  assert.equal(daily, '2026-07-31T01:00:00.000Z');

  // En hiver, le même 03:00 tombe à 02:00 UTC : le décalage est bien pris en
  // compte, et pas figé.
  const winter = scheduler.nextRunAt(
    { frequency: 'daily', timeOfDay: '03:00', enabled: true },
    new Date('2026-01-15T12:00:00Z')
  );
  assert.equal(winter, '2026-01-16T02:00:00.000Z');

  const monthly = scheduler.nextRunAt(
    { frequency: 'monthly', timeOfDay: '03:00', dayOfMonth: 1, enabled: true },
    new Date('2026-07-30T12:00:00Z')
  );
  assert.equal(monthly, '2026-08-01T01:00:00.000Z');

  assert.equal(scheduler.nextRunAt({ frequency: 'disabled', enabled: true }), null);
  assert.equal(scheduler.nextRunAt({ frequency: 'daily', enabled: false }), null);
});

test('changer de fuseau change réellement l\'heure planifiée', () => {
  settings.updateAppSettings({ timezone: 'UTC' });
  const utc = scheduler.nextRunAt(
    { frequency: 'daily', timeOfDay: '03:00', enabled: true },
    new Date('2026-07-30T12:00:00Z')
  );
  assert.equal(utc, '2026-07-31T03:00:00.000Z');

  settings.updateAppSettings({ timezone: 'Europe/Paris' });
  assert.equal(tz.isValid('Europe/Paris'), true);
  assert.equal(tz.isValid('Mars/Olympus_Mons'), false);
});

test('la planification ne concerne que les connecteurs réellement installés', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'journaliste', 'MotDePasse1');

  // Aucune installation pour ce compte : aucune planification, même si le
  // catalogue en compte quatorze. C'est la correction du lot 3.
  const vide = await client.get('/api/admin/schedules');
  assert.equal(vide.status, 200);
  assert.equal(vide.body.timezone, 'Europe/Paris');
  assert.deepEqual(vide.body.schedules, []);

  await client.post('/api/connectors/edf/install');
  const res = await client.get('/api/admin/schedules');

  assert.equal(res.body.schedules.length, 1);
  const edf = res.body.schedules[0];
  assert.equal(edf.connectorId, 'edf');
  assert.equal(edf.username, 'journaliste');
  assert.equal(edf.id, `${admin.id}:edf`);
  assert.ok(edf.nextRunAt, 'une prochaine exécution doit être calculée');
  assert.equal('lastRun' in edf, true);
  assert.equal(edf.configured, false, 'installé mais pas encore configuré');
});

test('les actions groupées s\'appliquent à toute la sélection', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'journaliste', 'MotDePasse1');

  await client.post('/api/connectors/edf/install');
  await client.post('/api/connectors/free/install');
  const cibles = [`${admin.id}:edf`, `${admin.id}:free`];

  const bulk = await client.put('/api/admin/schedules', {
    targets: cibles,
    frequency: 'weekly',
    timeOfDay: '05:30',
    dayOfWeek: 3,
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.schedules.length, 2);

  for (const schedule of bulk.body.schedules) {
    assert.equal(schedule.frequency, 'weekly');
    assert.equal(schedule.timeOfDay, '05:30');
    assert.equal(schedule.dayOfWeek, 3);
  }

  // Désactiver ne doit pas réécrire la fréquence au passage.
  const disabled = await client.put('/api/admin/schedules', {
    targets: [`${admin.id}:edf`],
    enabled: false,
  });
  assert.equal(disabled.body.schedules[0].enabled, false);
  assert.equal(disabled.body.schedules[0].frequency, 'weekly');
  assert.equal(disabled.body.schedules[0].timeOfDay, '05:30');
  assert.equal(disabled.body.schedules[0].nextRunAt, null);

  const empty = await client.put('/api/admin/schedules', { targets: [] });
  assert.equal(empty.status, 400);

  // Un couple qui n'existe pas n'est pas une cible valide.
  const inconnu = await client.put('/api/admin/schedules', {
    targets: [`${admin.id}:ovh`],
    enabled: false,
  });
  assert.equal(inconnu.status, 400);
});
