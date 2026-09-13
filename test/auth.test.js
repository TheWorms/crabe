'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const password = require('../server/auth/password');
const totp = require('../server/auth/totp');
const middleware = require('../server/middleware');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Mots de passe
// ---------------------------------------------------------------------------

test('le hachage produit de l\'Argon2id et vérifie correctement', async () => {
  const hash = await password.hash('MotDePasse1');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await password.verify(hash, 'MotDePasse1'), true);
  assert.equal(await password.verify(hash, 'MotDePasse2'), false);
});

test('deux hachages du même mot de passe diffèrent (sel aléatoire)', async () => {
  const a = await password.hash('MotDePasse1');
  const b = await password.hash('MotDePasse1');
  assert.notEqual(a, b);
});

test('verify() renvoie false sur un hash illisible plutôt que de lever', async () => {
  assert.equal(await password.verify('pas-un-hash', 'MotDePasse1'), false);
  assert.equal(await password.verify(null, 'MotDePasse1'), false);
});

test('la politique de complexité applique bien chaque niveau', () => {
  assert.equal(password.check('abcdef', 'low').ok, true);
  assert.equal(password.check('abcde', 'low').ok, false);

  assert.equal(password.check('motdepasse1', 'medium').ok, true);
  assert.equal(password.check('motdepasse', 'medium').ok, false, 'chiffre requis');
  assert.equal(password.check('mdp1', 'medium').ok, false, 'longueur requise');

  assert.equal(password.check('MotDePasse1!', 'high').ok, true);
  assert.equal(password.check('motdepasse1!', 'high').ok, false, 'majuscule requise');
  assert.equal(password.check('MotDePasse1', 'high').ok, false, 'symbole requis');
  assert.equal(password.check('MotDeP1!', 'high').ok, false, '12 caractères requis');
});

test('un niveau inconnu retombe sur « medium »', () => {
  assert.deepEqual(password.check('motdepasse1', 'inexistant'), password.check('motdepasse1', 'medium'));
});

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

test('un code TOTP courant est accepté, un code erroné rejeté', () => {
  const secret = totp.generateSecret();
  assert.equal(totp.verify(totp.currentToken(secret), secret), true);
  assert.equal(totp.verify('000000', secret), false);
  assert.equal(totp.verify('abc', secret), false);
  assert.equal(totp.verify('', secret), false);
});

test('l\'URI otpauth porte l\'émetteur crabe', () => {
  const uri = totp.keyUri('camille', totp.generateSecret());
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=crabe/);
});

test('le QR code de setup est une image PNG en data URI', async () => {
  const qr = await totp.qrDataUrl('camille', totp.generateSecret());
  assert.match(qr, /^data:image\/png;base64,/);
});

// ---------------------------------------------------------------------------
// Restriction réseau
// ---------------------------------------------------------------------------

test('le filtrage CIDR accepte le LAN et refuse le reste', () => {
  assert.equal(middleware.inCidr('10.0.0.42', '10.0.0.0/24'), true);
  assert.equal(middleware.inCidr('10.0.1.42', '10.0.0.0/24'), false);
  assert.equal(middleware.inCidr('127.0.0.1', '127.0.0.1/32'), true);
  assert.equal(middleware.inCidr('10.0.0.1', '0.0.0.0/0'), true);
  assert.equal(middleware.inCidr('pas-une-ip', '10.0.0.0/24'), false);
});

test('les IPv4 encapsulées en IPv6 sont normalisées', () => {
  assert.equal(middleware.normalizeIp('::ffff:10.0.0.5'), '10.0.0.5');
});

test('l\'user-agent est décodé en OS et navigateur', () => {
  const parsed = middleware.parseUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0'
  );
  assert.equal(parsed.os, 'Linux x86_64');
  assert.equal(parsed.browser, 'Firefox 154');
});

// ---------------------------------------------------------------------------
// Parcours de connexion complet
// ---------------------------------------------------------------------------

test('parcours : identifiants -> enrôlement 2FA -> session ouverte', async (t) => {
  await helpers.createUser({ username: 'alice', plainPassword: 'MotDePasse1', role: 'admin' });
  // La 2FA est optionnelle et désactivée par défaut : on exerce ici le cas où
  // l'administrateur l'a explicitement exigée.
  helpers.db
    .get()
    .prepare('UPDATE security_policy SET allow_2fa = 1, require_2fa = 1 WHERE id = 1')
    .run();

  const client = await helpers.startServer();
  t.after(() => client.close());

  const anonymous = await client.get('/api/auth/me');
  assert.equal(anonymous.status, 401);

  const wrong = await client.post('/api/auth/login', { username: 'alice', password: 'faux' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /incorrect/i);

  const step1 = await client.post('/api/auth/login', {
    username: 'alice',
    password: 'MotDePasse1',
  });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.step, '2fa-setup', 'enrôlement proposé car la politique l\'exige');

  // Tant que la 2FA n'est pas confirmée, la session n'est pas ouverte.
  assert.equal((await client.get('/api/auth/me')).status, 401);

  const setup = await client.post('/api/auth/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr, /^data:image\/png;base64,/);

  const badCode = await client.post('/api/auth/2fa/confirm', { code: '000000' });
  assert.equal(badCode.status, 401);

  const confirmed = await client.post('/api/auth/2fa/confirm', {
    code: totp.currentToken(setup.body.secret),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.step, 'done');

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'alice');
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.security.twoFactor, true);
});

test('une deuxième connexion demande le code TOTP, pas un nouvel enrôlement', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const step1 = await client.post('/api/auth/login', {
    username: 'alice',
    password: 'MotDePasse1',
  });
  assert.equal(step1.body.step, '2fa');

  const row = helpers.db
    .get()
    .prepare('SELECT totp_secret FROM users WHERE username = ?')
    .get('alice');
  const secret = helpers.crypto.decrypt(row.totp_secret);

  assert.equal((await client.post('/api/auth/2fa', { code: '111111' })).status, 401);

  const ok = await client.post('/api/auth/2fa', { code: totp.currentToken(secret) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.step, 'done');
});

test('le secret TOTP est chiffré en base, jamais en clair', () => {
  const row = helpers.db
    .get()
    .prepare('SELECT totp_secret FROM users WHERE username = ?')
    .get('alice');
  assert.match(row.totp_secret, /^v1\./, 'préfixe de format chiffré attendu');
  assert.equal(helpers.crypto.decrypt(row.totp_secret).length > 0, true);
});

test('un compte désactivé ne peut pas se connecter', async (t) => {
  await helpers.createUser({ username: 'bob', plainPassword: 'MotDePasse1', status: 'inactive' });
  const client = await helpers.startServer();
  t.after(() => client.close());

  const result = await client.post('/api/auth/login', { username: 'bob', password: 'MotDePasse1' });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /désactivé/);
});

test('un utilisateur simple ne peut pas atteindre les routes d\'administration', async (t) => {
  await helpers.createUser({ username: 'carol', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'carol', 'MotDePasse1');
  assert.equal((await client.get('/api/auth/me')).status, 200);

  for (const route of ['/api/users', '/api/admin/connectors', '/api/admin/destinations', '/api/admin/logs/connections']) {
    const res = await client.get(route);
    assert.equal(res.status, 403, `${route} devrait être refusé`);
  }
});

test('la déconnexion invalide la session', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'carol', 'MotDePasse1');
  assert.equal((await client.get('/api/auth/me')).status, 200);

  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/me')).status, 401);
});

test('le changement de mot de passe exige l\'ancien et respecte la politique', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'carol', 'MotDePasse1');

  const wrongCurrent = await client.post('/api/auth/password', {
    currentPassword: 'faux',
    newPassword: 'NouveauMdp1',
  });
  assert.equal(wrongCurrent.status, 401);

  const tooWeak = await client.post('/api/auth/password', {
    currentPassword: 'MotDePasse1',
    newPassword: 'court',
  });
  assert.equal(tooWeak.status, 400);

  const ok = await client.post('/api/auth/password', {
    currentPassword: 'MotDePasse1',
    newPassword: 'NouveauMdp1',
  });
  assert.equal(ok.status, 200);
  assert.equal(await password.verify(
    helpers.db.get().prepare('SELECT password_hash FROM users WHERE username = ?').get('carol').password_hash,
    'NouveauMdp1'
  ), true);
});
