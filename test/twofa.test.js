'use strict';

/**
 * Double authentification : optionnelle, opt-in, et jamais enfermante.
 *
 * Régression à empêcher : en production, le bootstrap avait généré un secret
 * TOTP et l'avait activé sans qu'aucun QR code n'ait été scanné. Le compte
 * administrateur s'est retrouvé dehors, et il a fallu un UPDATE SQLite à la
 * main pour rentrer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const totp = require('../server/auth/totp');
const settings = require('../server/settings');
const { config } = require('../server/config');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

function userRow(username) {
  return helpers.db.get().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// ---------------------------------------------------------------------------
// Bootstrap — doit tourner en premier, sur une base encore vide
// ---------------------------------------------------------------------------

test('le bootstrap crée un admin SANS 2FA et sans secret', async () => {
  const { bootstrapAdmin } = require('../server/index');

  const previous = { ...config.bootstrapAdmin };
  config.bootstrapAdmin.username = 'bootadmin';
  config.bootstrapAdmin.password = 'MotDePasse1';
  config.bootstrapAdmin.email = 'boot@test.local';

  try {
    const result = await bootstrapAdmin();
    assert.equal(result.created, true);
  } finally {
    Object.assign(config.bootstrapAdmin, previous);
  }

  const admin = userRow('bootadmin');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.totp_enabled, 0, 'aucune 2FA activée d\'office');
  assert.equal(admin.totp_secret, null, 'aucun secret généré d\'office');
  assert.ok(admin.role_id, 'le rôle admin est attribué');
});

test('la politique par défaut n\'autorise même pas la 2FA', () => {
  assert.equal(settings.twoFactorMode(), 'disabled');
});

// ---------------------------------------------------------------------------
// Connexion sans 2FA
// ---------------------------------------------------------------------------

test('sans 2FA sur le compte, aucun écran de code n\'apparaît', async (t) => {
  await helpers.createUser({ username: 'sansdeuxfa', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());

  const result = await client.post('/api/auth/login', {
    username: 'sansdeuxfa',
    password: 'MotDePasse1',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.step, 'done', 'la session doit s\'ouvrir directement');
  assert.equal(result.body.user.twoFactor.enabled, false);
  assert.equal(result.body.user.twoFactor.canEnable, false, '2FA désactivée par l\'administrateur');
});

// ---------------------------------------------------------------------------
// Activation depuis le profil
// ---------------------------------------------------------------------------

test('2FA refusée à l\'activation quand l\'administrateur l\'a désactivée', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'sansdeuxfa', 'MotDePasse1');

  const setup = await client.post('/api/auth/2fa/setup');
  assert.equal(setup.status, 403);
  assert.match(setup.body.error, /désactivée par l'administrateur/);
});

test('activation : rien n\'est persisté avant un premier code valide', async (t) => {
  settings.setTwoFactorMode('allowed');
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'sansdeuxfa', 'MotDePasse1');

  const setup = await client.post('/api/auth/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr, /^data:image\/png;base64,/);

  // Un QR affiché mais pas validé ne doit RIEN changer en base.
  let row = userRow('sansdeuxfa');
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);

  const wrong = await client.post('/api/auth/2fa/confirm', { code: '000000' });
  assert.equal(wrong.status, 401);
  row = userRow('sansdeuxfa');
  assert.equal(row.totp_enabled, 0, 'un code erroné ne doit pas activer la 2FA');
  assert.equal(row.totp_secret, null, 'et surtout ne doit pas enregistrer le secret');

  const ok = await client.post('/api/auth/2fa/confirm', {
    code: totp.currentToken(setup.body.secret),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.twoFactor.enabled, true);

  row = userRow('sansdeuxfa');
  assert.equal(row.totp_enabled, 1);
  assert.match(row.totp_secret, /^v1\./, 'secret chiffré au repos');
});

test('la connexion demande alors le code, et l\'accepte', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const step1 = await client.post('/api/auth/login', {
    username: 'sansdeuxfa',
    password: 'MotDePasse1',
  });
  assert.equal(step1.body.step, '2fa');

  const secret = helpers.crypto.decrypt(userRow('sansdeuxfa').totp_secret);
  const done = await client.post('/api/auth/2fa', { code: totp.currentToken(secret) });
  assert.equal(done.status, 200);
  assert.equal(done.body.step, 'done');
});

// ---------------------------------------------------------------------------
// Désactivation par l'utilisateur
// ---------------------------------------------------------------------------

test('la désactivation exige le mot de passe courant', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'sansdeuxfa', 'MotDePasse1');

  const wrong = await client.post('/api/auth/2fa/disable', { password: 'pas-le-bon' });
  assert.equal(wrong.status, 401);
  assert.equal(userRow('sansdeuxfa').totp_enabled, 1, 'toujours active');

  const ok = await client.post('/api/auth/2fa/disable', { password: 'MotDePasse1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.twoFactor.enabled, false);

  const row = userRow('sansdeuxfa');
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null, 'le secret est effacé, pas seulement désactivé');
});

// ---------------------------------------------------------------------------
// Politique « exigée » — invitation, jamais un mur
// ---------------------------------------------------------------------------

test('2FA exigée : le compte est invité mais garde une porte de sortie', async (t) => {
  settings.setTwoFactorMode('required');
  t.after(() => settings.setTwoFactorMode('allowed'));

  const client = await helpers.startServer();
  t.after(() => client.close());

  const step1 = await client.post('/api/auth/login', {
    username: 'sansdeuxfa',
    password: 'MotDePasse1',
  });
  assert.equal(step1.body.step, '2fa-setup');
  assert.equal(step1.body.canSkip, true, 'toujours une porte de sortie');

  const skipped = await client.post('/api/auth/2fa/skip');
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.step, 'done');
  assert.equal(userRow('sansdeuxfa').totp_enabled, 0, 'rien n\'a été activé de force');

  const trace = helpers.db
    .get()
    .prepare("SELECT * FROM app_logs WHERE source = 'auth' AND level = 'warn' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(trace.message, /sans configurer la 2FA/);
});

// ---------------------------------------------------------------------------
// Dépannage par l'administrateur
// ---------------------------------------------------------------------------

test('l\'admin peut réinitialiser la 2FA d\'un compte enfermé dehors', async (t) => {
  const locked = await helpers.createUser({ username: 'enferme', plainPassword: 'MotDePasse1' });
  await helpers.createUser({ username: 'admin2fa', plainPassword: 'MotDePasse1', role: 'admin' });

  // On simule l'état problématique : 2FA active avec un secret inutilisable.
  helpers.db
    .get()
    .prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?')
    .run(helpers.crypto.encrypt(totp.generateSecret()), locked.id);

  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'admin2fa', 'MotDePasse1');
  const reset = await client.post(`/api/users/${locked.id}/2fa/reset`);
  assert.equal(reset.status, 200);
  assert.match(reset.body.message, /peut se reconnecter/);

  const row = userRow('enferme');
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);

  // Le compte se reconnecte avec son seul mot de passe.
  client.clearCookies();
  const login = await client.post('/api/auth/login', {
    username: 'enferme',
    password: 'MotDePasse1',
  });
  assert.equal(login.body.step, 'done');
});

test('un compte gardant sa 2FA n\'est pas affaibli si l\'admin la désactive globalement', async (t) => {
  const user = await helpers.createUser({ username: 'protege', plainPassword: 'MotDePasse1' });
  const secret = totp.generateSecret();
  helpers.db
    .get()
    .prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?')
    .run(helpers.crypto.encrypt(secret), user.id);

  settings.setTwoFactorMode('disabled');
  t.after(() => settings.setTwoFactorMode('allowed'));

  const client = await helpers.startServer();
  t.after(() => client.close());

  const step1 = await client.post('/api/auth/login', {
    username: 'protege',
    password: 'MotDePasse1',
  });
  assert.equal(step1.body.step, '2fa', 'le code reste demandé');

  const done = await client.post('/api/auth/2fa', { code: totp.currentToken(secret) });
  assert.equal(done.status, 200);
  assert.equal(done.body.step, 'done');
});
