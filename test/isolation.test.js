'use strict';

/**
 * Isolation multi-utilisateur — APPLICATIVE.
 *
 * Le partage du stockage local est monté en NFS all_squash vers uid 1000 : tous les
 * fichiers appartiennent au même compte Unix. L'isolation ne peut donc PAS
 * reposer sur les permissions du système de fichiers ; elle est entièrement
 * portée par le filtrage `user_id` des routes et des requêtes SQL.
 *
 * Ce fichier vérifie qu'un utilisateur A n'atteint ni les factures, ni les
 * logs, ni les tickets, ni les fichiers de l'utilisateur B — y compris en
 * devinant des identifiants.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const tickets = require('../server/tickets');

let alix;
let bruno;
let alixInvoice;
let brunoInvoice;
let alixTicket;
let brunoTicket;

test.before(async () => {
  await helpers.setup();

  alix = await helpers.createUser({ username: 'alix', plainPassword: 'MotDePasse1' });
  bruno = await helpers.createUser({ username: 'bruno', plainPassword: 'MotDePasse1' });

  for (const [user, account] of [
    [alix, 'compte-alix'],
    [bruno, 'compte-bruno'],
  ]) {
    registry.install(user.id, 'edf');
    registry.saveConfig(user.id, 'edf', { username: account, password: 'secret' });

    let run;
    for (let i = 0; i < 10; i++) {
      run = await scheduler.runForUser(user.id, 'edf', 'manual');
      if (run.ok && run.count > 0) break;
    }
    assert.ok(run.ok && run.count > 0, `préalable : factures de ${user.username} (${run.message})`);
  }

  const invoiceOf = (userId) =>
    helpers.db
      .get()
      .prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY id LIMIT 1')
      .get(userId);
  alixInvoice = invoiceOf(alix.id);
  brunoInvoice = invoiceOf(bruno.id);

  alixTicket = tickets.create(alix.id, 'Souci Alix', 'Message privé d\'Alix.');
  brunoTicket = tickets.create(bruno.id, 'Souci Bruno', 'Message privé de Bruno.');
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Factures
// ---------------------------------------------------------------------------

test('les factures listées sont uniquement celles du compte courant', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  const mine = await client.get('/api/connectors/me/invoices');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.invoices.length > 0);

  const ids = mine.body.invoices.map((i) => i.id);
  assert.equal(ids.includes(brunoInvoice.id), false, 'aucune facture de Bruno');

  // Le détail d'un connecteur ne montre que ses propres documents.
  const detail = await client.get('/api/connectors/edf');
  assert.equal(detail.status, 200);
  const names = detail.body.invoices.map((i) => i.filename);
  assert.equal(
    names.every((n) => mine.body.invoices.some((i) => i.filename === n)),
    true
  );
});

test('un identifiant de facture deviné ne donne accès à rien', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  // Le fichier d'Alix existe bien...
  const own = await client.get(`/api/connectors/me/invoices/${alixInvoice.id}/file`);
  assert.equal(own.status, 200);

  // ... mais celui de Bruno est introuvable, sans révéler son existence.
  const stolen = await client.get(`/api/connectors/me/invoices/${brunoInvoice.id}/file`);
  assert.equal(stolen.status, 404);
  assert.match(stolen.body.error, /introuvable/);

  // Et le fichier de Bruno est bel et bien là sur le disque : c'est bien
  // l'application qui protège, pas le système de fichiers.
  const brunoPath = JSON.parse(brunoInvoice.destinations).local.path;
  assert.equal(fs.existsSync(brunoPath), true);
});

test('aucun paramètre de requête ne peut faire sortir du dossier de l\'utilisateur', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  for (const attempt of [
    '../../etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    `${alixInvoice.id};id=${brunoInvoice.id}`,
    'null',
  ]) {
    const res = await client.get(
      `/api/connectors/me/invoices/${encodeURIComponent(attempt)}/file`
    );
    assert.equal(res.status, 404, `tentative « ${attempt} » : attendu 404`);
  }
});

test('les statistiques de stockage du profil sont bornées au compte courant', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'alix', 'MotDePasse1');
  const alixUsage = await client.get('/api/connectors/me/storage');

  client.clearCookies();
  await helpers.login(client, 'bruno', 'MotDePasse1');
  const brunoUsage = await client.get('/api/connectors/me/storage');

  const total = helpers.db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM invoices')
    .get().n;

  assert.ok(alixUsage.body.files > 0 && brunoUsage.body.files > 0);
  assert.ok(
    alixUsage.body.files < total,
    'le total du profil ne doit pas agréger les autres comptes'
  );
});

// ---------------------------------------------------------------------------
// Journaux
// ---------------------------------------------------------------------------

test('les journaux d\'exécution ne sont pas exposés à un non-administrateur', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  for (const route of [
    '/api/admin/logs/runs',
    '/api/admin/logs/connections',
    '/api/admin/logs/app',
  ]) {
    const res = await client.get(route);
    assert.equal(res.status, 403, `${route} devrait être refusé`);
  }
});

test('le dernier run visible dans le détail est celui du compte courant', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'bruno', 'MotDePasse1');

  const detail = await client.get('/api/connectors/edf');
  const lastRun = detail.body.lastRun;
  assert.ok(lastRun);

  const owner = helpers.db
    .get()
    .prepare('SELECT user_id FROM run_logs WHERE started_at = ? ORDER BY id DESC LIMIT 1')
    .get(lastRun.started_at);
  assert.equal(owner.user_id, bruno.id);
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

test('un utilisateur ne voit que ses propres demandes de support', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  const mine = await client.get('/api/tickets/mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.tickets.length, 1);
  assert.equal(mine.body.tickets[0].id, alixTicket.id);

  // Le détail et la liste complète sont réservés au support.
  assert.equal((await client.get(`/api/tickets/${brunoTicket.id}`)).status, 403);
  assert.equal((await client.get('/api/tickets')).status, 403);

  // Masquer le ticket d'un autre est sans effet.
  const hijack = await client.del(`/api/tickets/${brunoTicket.id}/mine`);
  assert.equal(hijack.status, 404);
  assert.equal(
    helpers.db.get().prepare('SELECT hidden_by_user FROM tickets WHERE id = ?').get(brunoTicket.id)
      .hidden_by_user,
    0
  );
});

// ---------------------------------------------------------------------------
// Connecteurs
// ---------------------------------------------------------------------------

test('un compte ne peut pas déclencher ni configurer le connecteur d\'un autre', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  // Les routes sont bornées à req.user : lancer « edf » lance SON edf.
  const run = await client.post('/api/connectors/edf/run');
  assert.equal(run.status, 200);

  const last = helpers.db
    .get()
    .prepare('SELECT user_id FROM run_logs ORDER BY id DESC LIMIT 1')
    .get();
  assert.equal(last.user_id, alix.id, 'l\'exécution est bien attribuée à Alix');

  // La configuration de Bruno reste illisible.
  assert.throws(() => registry.readConfig(alix.id, 'free'), /non installé/);
  const brunoConfig = registry.readConfig(bruno.id, 'edf');
  assert.equal(brunoConfig.username, 'compte-bruno');
  const alixConfig = registry.readConfig(alix.id, 'edf');
  assert.equal(alixConfig.username, 'compte-alix');
});

test('les routes d\'administration des applications restent fermées', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  assert.equal((await client.get('/api/admin/connectors')).status, 403);
  assert.equal((await client.post('/api/admin/connectors/edf/run-all')).status, 403);
  assert.equal((await client.get('/api/users')).status, 403);
  assert.equal((await client.get(`/api/users/${bruno.id}/export`)).status, 403);
});
