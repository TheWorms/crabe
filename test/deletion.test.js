'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const deletion = require('../server/deletion');
const registry = require('../server/connectors/registry');
const destinations = require('../server/destinations');
const scheduler = require('../server/scheduler');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

/**
 * Crée un compte avec un connecteur configuré et quelques factures déposées.
 *
 * Les connecteurs simulés échouent volontairement une fois sur ~7 : on relance
 * jusqu'à obtenir une exécution réussie, sinon les tests suivants seraient
 * intermittents.
 */
async function userWithData(username, attempts = 8) {
  const user = await helpers.createUser({ username });
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: `${username}@test.local`, password: 'secret' });

  let run;
  for (let i = 0; i < attempts; i++) {
    run = await scheduler.runForUser(user.id, 'edf', 'manual');
    if (run.ok && run.count > 0) return { user, run };
  }
  throw new Error(`Aucune exécution réussie pour ${username} après ${attempts} essais : ${run?.message}`);
}

// ---------------------------------------------------------------------------
// Pipeline de récupération (préalable au reste)
// ---------------------------------------------------------------------------

test('le pipeline dépose les factures sur le stockage local et les enregistre', async () => {
  const { user, run } = await userWithData('lea');

  assert.equal(run.ok, true, run.message);
  assert.ok(run.count > 0);

  const invoices = helpers.db
    .get()
    .prepare('SELECT * FROM invoices WHERE user_id = ?')
    .all(user.id);
  assert.equal(invoices.length, run.count);

  const localPath = destinations.readConfig('local').path;
  for (const invoice of invoices) {
    const dest = JSON.parse(invoice.destinations);
    assert.equal(dest.local.ok, true);
    assert.equal(fs.existsSync(dest.local.path), true, `fichier absent : ${dest.local.path}`);
    assert.ok(dest.local.path.startsWith(localPath));
  }

  const log = helpers.db
    .get()
    .prepare('SELECT * FROM run_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(user.id);
  assert.equal(log.success, 1);
  assert.equal(log.invoice_count, run.count);
});

test('une exécution sur un compte inactif est refusée et tracée', async () => {
  const user = await helpers.createUser({ username: 'mallory', status: 'inactive' });
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: 'm', password: 's' });

  const run = await scheduler.runForUser(user.id, 'edf', 'cron');
  assert.equal(run.ok, false);
  assert.match(run.message, /inactif/);
});

test('un connecteur en maintenance ne tourne pas', async () => {
  const user = await helpers.createUser({ username: 'niaj' });
  registry.install(user.id, 'free');
  registry.saveConfig(user.id, 'free', { username: 'n', password: 's' });

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET maintenance = 1 WHERE connector_id = ?')
    .run('free');

  const run = await scheduler.runForUser(user.id, 'free', 'cron');
  assert.equal(run.ok, false);
  assert.match(run.message, /maintenance/);

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET maintenance = 0 WHERE connector_id = ?')
    .run('free');
});

// ---------------------------------------------------------------------------
// Export RGPD
// ---------------------------------------------------------------------------

test('l\'export RGPD contient les données personnelles et les factures', async () => {
  const { user } = await userWithData('olivia');

  const result = await deletion.buildExport(user.id);
  assert.equal(fs.existsSync(result.path), true);
  assert.ok(result.bytes > 0);
  assert.ok(result.files > 0, 'au moins une facture doit être jointe');

  // Un zip commence par « PK ».
  const header = fs.readFileSync(result.path).subarray(0, 2).toString();
  assert.equal(header, 'PK');

  fs.rmSync(result.path, { force: true });
});

// ---------------------------------------------------------------------------
// Workflow de suppression de compte
// ---------------------------------------------------------------------------

test('demande de suppression : planifiée à 30 jours, idempotente', async () => {
  const { user } = await userWithData('peggy');

  const request = deletion.requestDeletion(user.id, true);
  assert.equal(request.wants_export, 1);
  assert.equal(request.revoked, 0);

  const scheduled = new Date(`${request.scheduled_delete_at.replace(' ', 'T')}Z`);
  const days = (scheduled.getTime() - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, `échéance attendue à ~30 jours, obtenu ${days.toFixed(1)}`);

  // Une deuxième demande ne crée pas de doublon.
  deletion.requestDeletion(user.id, false);
  const count = helpers.db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM deletion_requests WHERE user_id = ?')
    .get(user.id);
  assert.equal(count.n, 1);
  assert.equal(deletion.getRequestForUser(user.id).wants_export, 1, 'la demande initiale prime');
});

test('une demande peut être annulée tant que l\'accès n\'est pas révoqué', async () => {
  const user = await helpers.createUser({ username: 'quentin' });
  deletion.requestDeletion(user.id, false);
  assert.ok(deletion.getRequestForUser(user.id));

  assert.equal(deletion.cancelRequest(user.id), true);
  assert.equal(deletion.getRequestForUser(user.id), undefined);
});

test('l\'envoi du zip marque la demande sans supprimer le compte', async () => {
  const user = helpers.db.get().prepare('SELECT * FROM users WHERE username = ?').get('peggy');

  const result = await deletion.sendExport(user.id);
  assert.ok(result.bytes > 0);

  const request = deletion.getRequestForUser(user.id);
  assert.equal(request.export_sent, 1);
  assert.ok(request.export_path);

  const stillThere = helpers.db.get().prepare('SELECT status FROM users WHERE id = ?').get(user.id);
  assert.equal(stillThere.status, 'active', 'le compte reste actif à cette étape');

  fs.rmSync(request.export_path, { force: true });
});

test('la révocation désactive le compte et efface les identifiants de connecteurs', async () => {
  const user = helpers.db.get().prepare('SELECT * FROM users WHERE username = ?').get('peggy');

  const before = registry.getInstall(user.id, 'edf');
  assert.ok(before.config_encrypted, 'préalable : le connecteur est configuré');

  deletion.revokeAccess(user.id);

  const after = helpers.db.get().prepare('SELECT status FROM users WHERE id = ?').get(user.id);
  assert.equal(after.status, 'inactive');

  const install = registry.getInstall(user.id, 'edf');
  assert.equal(install.config_encrypted, null, 'les identifiants doivent être effacés');
  assert.equal(install.status, 'needs-config');

  const request = deletion.getRequestForUser(user.id);
  assert.equal(request.revoked, 1);
  assert.ok(request.revoked_at);
});

test('un compte révoqué ne peut plus se connecter', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const result = await client.post('/api/auth/login', { username: 'peggy', password: 'MotDePasse1' });
  assert.equal(result.status, 403);
});

test('révoquer sans demande préalable est refusé', async () => {
  const user = await helpers.createUser({ username: 'rupert' });
  assert.throws(() => deletion.revokeAccess(user.id), /Aucune demande/);
});

test('la suppression définitive efface le compte, ses données et ses fichiers', async () => {
  const user = helpers.db.get().prepare('SELECT * FROM users WHERE username = ?').get('peggy');
  const localPath = destinations.readConfig('local').path;
  const userDir = `${localPath}/peggy`;
  assert.equal(fs.existsSync(userDir), true, 'préalable : les fichiers existent');

  const result = await deletion.finalizeDeletion(user.id);
  assert.equal(result.username, 'peggy');

  assert.equal(helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id), undefined);
  // ON DELETE CASCADE doit avoir nettoyé les tables liées.
  for (const table of ['connector_installs', 'invoices', 'deletion_requests']) {
    const rest = helpers.db
      .get()
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
      .get(user.id);
    assert.equal(rest.n, 0, `${table} devrait être vide`);
  }

  assert.equal(fs.existsSync(userDir), false, 'les fichiers du stockage local doivent être supprimés');
});

test('les suppressions à échéance ne concernent que les comptes révoqués', async () => {
  const revoked = await helpers.createUser({ username: 'sybil' });
  const pending = await helpers.createUser({ username: 'trent' });

  deletion.requestDeletion(revoked.id, false);
  deletion.requestDeletion(pending.id, false);
  deletion.revokeAccess(revoked.id);

  // Rien n'est encore dû : l'échéance est à 30 jours.
  assert.equal(deletion.dueDeletions().length, 0);

  // On antidate l'échéance du compte révoqué.
  helpers.db
    .get()
    .prepare("UPDATE deletion_requests SET scheduled_delete_at = datetime('now', '-1 day') WHERE user_id = ?")
    .run(revoked.id);
  // ... et celle du compte non révoqué, qui ne doit pas partir pour autant.
  helpers.db
    .get()
    .prepare("UPDATE deletion_requests SET scheduled_delete_at = datetime('now', '-1 day') WHERE user_id = ?")
    .run(pending.id);

  const due = deletion.dueDeletions();
  assert.equal(due.length, 1);
  assert.equal(due[0].user_id, revoked.id);

  const done = await deletion.processDueDeletions();
  assert.deepEqual(done, [revoked.id]);
  assert.equal(helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(revoked.id), undefined);
  assert.ok(
    helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(pending.id),
    'un compte non révoqué ne doit jamais être supprimé automatiquement'
  );
});

// ---------------------------------------------------------------------------
// Parcours HTTP
// ---------------------------------------------------------------------------

test('parcours complet via l\'API : demande utilisateur puis traitement admin', async (t) => {
  const admin = await helpers.createUser({ username: 'adminsupp', role: 'admin' });
  const { user } = await userWithData('victor');

  const client = await helpers.startServer();
  t.after(() => client.close());

  // 1. L'utilisateur demande sa suppression avec export.
  await helpers.login(client, 'victor', 'MotDePasse1');
  const asked = await client.post('/api/users/me/deletion', { wantsExport: true });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.request.wantsExport, true);

  const mine = await client.get('/api/users/me/deletion');
  assert.equal(mine.body.request.revoked, false);
  assert.equal(mine.body.retentionDays, 30);

  // 2. L'administrateur voit la demande.
  client.clearCookies();
  await helpers.login(client, 'adminsupp', 'MotDePasse1');

  const list = await client.get('/api/users/deletion/requests');
  assert.equal(list.status, 200);
  const entry = list.body.requests.find((r) => r.username === 'victor');
  assert.ok(entry, 'la demande doit apparaître côté admin');
  assert.equal(entry.wantsExport, true);

  // 3. Génération du zip.
  const exported = await client.post(`/api/users/deletion/requests/${user.id}/export`);
  assert.equal(exported.status, 200);
  assert.ok(exported.body.bytes > 0);
  fs.rmSync(exported.body.path, { force: true });

  // 4. Révocation.
  const revoked = await client.post(`/api/users/deletion/requests/${user.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(
    helpers.db.get().prepare('SELECT status FROM users WHERE id = ?').get(user.id).status,
    'inactive'
  );

  // 5. Suppression définitive.
  const finalized = await client.post(`/api/users/deletion/requests/${user.id}/finalize`);
  assert.equal(finalized.status, 200);
  assert.equal(helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id), undefined);

  assert.ok(admin.id);
});

test('le dernier administrateur actif ne peut pas demander sa suppression', async (t) => {
  // On désactive tous les autres administrateurs.
  helpers.db
    .get()
    .prepare("UPDATE users SET status = 'inactive' WHERE role = 'admin' AND username != 'adminsupp'")
    .run();

  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'adminsupp', 'MotDePasse1');
  const result = await client.post('/api/users/me/deletion', { wantsExport: false });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /dernier administrateur/);
});
