'use strict';

/**
 * Changement d'adresse e-mail validé par e-mail.
 *
 * Exigence forte : le parcours doit rester utilisable même sans SMTP (il n'a
 * jamais été testé en conditions réelles). L'adresse ne devient jamais
 * immuable — un administrateur peut toujours l'appliquer à la main.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const mailer = require('../server/mailer');
const emailChange = require('../server/email-change');
const permissions = require('../server/permissions');

/** E-mails « envoyés » pendant les tests. */
const outbox = [];
const realMailer = { ...mailer };

function stubSmtp() {
  mailer.isConfigured = () => true;
  mailer.send = async (message) => {
    outbox.push(message);
    return { ok: true };
  };
  mailer.trySend = async (message) => {
    outbox.push(message);
    return { ok: true };
  };
}

function restoreMailer() {
  Object.assign(mailer, realMailer);
}

function tokenFrom(message) {
  const match = /confirm-email\?token=([0-9a-f]{64})/.exec(message.text);
  return match ? match[1] : null;
}

function userRow(username) {
  return helpers.db.get().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

let admin;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'mailuser', plainPassword: 'MotDePasse1' });
  admin = await helpers.createUser({
    username: 'mailadmin',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});

test.after(() => {
  restoreMailer();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Cas dégradé : pas de SMTP
// ---------------------------------------------------------------------------

test('sans SMTP, le refus est explicite et rien n\'est écrit', async (t) => {
  restoreMailer();
  assert.equal(mailer.isConfigured(), false, 'préalable : aucun SMTP configuré');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  const res = await client.post('/api/auth/email-change', { email: 'nouvelle@test.local' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /SMTP non configuré/);
  assert.match(res.body.error, /administrateur/);

  assert.equal(userRow('mailuser').email, 'mailuser@test.local', 'adresse inchangée');
  assert.equal(
    helpers.db.get().prepare('SELECT COUNT(*) AS n FROM email_change_requests').get().n,
    0,
    'aucune demande fantôme impossible à confirmer'
  );
});

test('un administrateur peut toujours appliquer le changement à la main', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailadmin', 'MotDePasse1');

  const target = userRow('mailuser');
  const res = await client.patch(`/api/users/${target.id}`, { email: 'pose-a-la-main@test.local' });
  assert.equal(res.status, 200);
  assert.equal(userRow('mailuser').email, 'pose-a-la-main@test.local');
});

// ---------------------------------------------------------------------------
// Parcours normal
// ---------------------------------------------------------------------------

test('la demande est mise en attente, l\'adresse actuelle reste active', async (t) => {
  stubSmtp();
  outbox.length = 0;

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  const res = await client.post('/api/auth/email-change', { email: 'Confirmee@Test.Local' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pending.email, 'confirmee@test.local', 'adresse normalisée');
  assert.match(res.body.message, /24 h/);

  // Rien n'est appliqué avant le clic.
  assert.equal(userRow('mailuser').email, 'pose-a-la-main@test.local');

  // Un e-mail vers la NOUVELLE adresse, un vers l'ANCIENNE.
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].to, 'confirmee@test.local');
  assert.match(outbox[0].subject, /confirmez/i);
  assert.equal(outbox[1].to, 'pose-a-la-main@test.local');
  assert.match(outbox[1].subject, /demande de changement/i);

  // Le jeton n'est jamais stocké en clair.
  const token = tokenFrom(outbox[0]);
  assert.ok(token, 'le lien de confirmation doit porter un jeton');
  const row = helpers.db
    .get()
    .prepare('SELECT * FROM email_change_requests ORDER BY id DESC LIMIT 1')
    .get();
  assert.equal(row.token_hash.includes(token), false);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);

  // L'interface sait qu'une confirmation est en attente.
  const me = await client.get('/api/auth/me');
  assert.equal(me.body.pendingEmailChange.email, 'confirmee@test.local');
});

test('un lien invalide, inconnu ou rejoué est refusé', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const bad = await client.get('/confirm-email?token=pas-un-jeton');
  assert.equal(bad.status, 400);
  assert.match(bad.body, /invalide/i);

  const unknown = await client.get(`/confirm-email?token=${'a'.repeat(64)}`);
  assert.equal(unknown.status, 400);
  assert.match(unknown.body, /utilisé ou inconnu/i);
});

test('le clic sur le lien applique le changement, une seule fois', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const token = tokenFrom(outbox[0]);
  const confirmed = await client.get(`/confirm-email?token=${token}`);
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.body, /confirmee@test\.local/);

  assert.equal(userRow('mailuser').email, 'confirmee@test.local', 'adresse appliquée');

  // Usage unique.
  const replay = await client.get(`/confirm-email?token=${token}`);
  assert.equal(replay.status, 400);
  assert.match(replay.body, /utilisé/i);
});

test('un jeton expiré est refusé et le dit', async (t) => {
  stubSmtp();
  outbox.length = 0;

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  await client.post('/api/auth/email-change', { email: 'expiree@test.local' });
  const token = tokenFrom(outbox[0]);

  helpers.db
    .get()
    .prepare("UPDATE email_change_requests SET expires_at = datetime('now', '-1 hour') WHERE consumed_at IS NULL")
    .run();

  const res = await client.get(`/confirm-email?token=${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /expiré/);
  assert.equal(userRow('mailuser').email, 'confirmee@test.local', 'adresse inchangée');
});

test('la demande peut être annulée et le lien renvoyé', async (t) => {
  stubSmtp();
  outbox.length = 0;

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  await client.post('/api/auth/email-change', { email: 'annulee@test.local' });
  assert.ok(emailChange.pendingFor(userRow('mailuser').id));

  const resent = await client.post('/api/auth/email-change/resend');
  assert.equal(resent.status, 200);
  assert.equal(resent.body.pending.email, 'annulee@test.local');

  const cancelled = await client.del('/api/auth/email-change');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.pending, null);
  assert.equal(emailChange.pendingFor(userRow('mailuser').id), null);

  const nothingToResend = await client.post('/api/auth/email-change/resend');
  assert.equal(nothingToResend.status, 404);
});

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------

test('adresses invalides, identiques ou déjà prises sont refusées', async (t) => {
  stubSmtp();
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  const invalid = await client.post('/api/auth/email-change', { email: 'pas-une-adresse' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /invalide/);

  const same = await client.post('/api/auth/email-change', { email: 'confirmee@test.local' });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /déjà celle de votre compte/);

  const taken = await client.post('/api/auth/email-change', { email: 'mailadmin@test.local' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /déjà utilisée/);
});

test('PATCH /auth/profile renvoie vers le parcours de confirmation', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'mailuser', 'MotDePasse1');

  const res = await client.patch('/api/auth/profile', { email: 'contournement@test.local' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /confirmation/);
  assert.equal(userRow('mailuser').email, 'confirmee@test.local');

  // Les autres champs du profil restent modifiables normalement.
  const phone = await client.patch('/api/auth/profile', { phone: '+33600000000' });
  assert.equal(phone.status, 200);
  assert.equal(phone.body.user.phone, '+33600000000');
});
