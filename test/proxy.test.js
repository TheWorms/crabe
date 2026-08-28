'use strict';

/**
 * crabe derrière un reverse proxy (Caddy, en HTTP).
 *
 * Deux régressions à empêcher définitivement :
 *   1. le cookie de session ne doit PAS devenir « Secure » du simple fait
 *      qu'un proxy de confiance est déclaré — c'est ce qui faisait boucler la
 *      connexion sur http://crabe.local ;
 *   2. le filtrage CIDR et le journal des connexions doivent voir l'IP réelle
 *      du client, pas celle du proxy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Doit être posé AVANT le chargement de helpers (qui charge server/config.js).
process.env.CRABE_TRUST_PROXY = '1';
process.env.CRABE_ALLOWED_CIDRS = '10.0.0.0/8,127.0.0.1/32';

const helpers = require('./helpers');
const { config } = require('../server/config');
const session = require('../server/auth/session');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Cookie de session
// ---------------------------------------------------------------------------

test('un proxy de confiance ne rend pas le cookie « Secure »', () => {
  assert.equal(config.trustProxy, 1, 'préalable : proxy de confiance déclaré');
  assert.equal(config.cookieSecure, false, 'CRABE_COOKIE_SECURE non posé = 0');

  const cookie = session.cookieOptions();
  assert.equal(cookie.secure, false, 'le cookie doit partir sans « Secure » en HTTP');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'lax');
});

test('CRABE_COOKIE_SECURE=1 est la seule chose qui rend le cookie « Secure »', () => {
  const previous = config.cookieSecure;
  try {
    config.cookieSecure = true;
    assert.equal(session.cookieOptions().secure, true);
  } finally {
    config.cookieSecure = previous;
  }
});

test('le cookie posé à la connexion ne porte pas l\'attribut Secure', async (t) => {
  await helpers.createUser({ username: 'proxyuser', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());

  const res = await client.post(
    '/api/auth/login',
    { username: 'proxyuser', password: 'MotDePasse1' },
    { 'x-forwarded-for': '10.1.2.3' }
  );

  assert.equal(res.status, 200);
  const raw = (res.setCookie || []).join(' ');
  assert.match(raw, /crabe\.sid=/, 'un cookie de session doit être posé');
  assert.equal(/;\s*Secure/i.test(raw), false, `cookie inattendu : ${raw}`);
});

// ---------------------------------------------------------------------------
// IP réelle
// ---------------------------------------------------------------------------

test('le filtrage CIDR s\'applique à l\'IP réelle transmise par le proxy', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  // 127.0.0.1 (la socket) est autorisé, mais c'est bien X-Forwarded-For qui
  // décide dès qu'un proxy est de confiance.
  const fromLan = await client.get('/api/system/version', { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(fromLan.status, 200);

  const fromOutside = await client.get('/api/system/version', { 'x-forwarded-for': '203.0.113.7' });
  assert.equal(fromOutside.status, 403);
  assert.match(fromOutside.body.error, /réseau local/);
});

test('le journal des connexions enregistre l\'IP du client, pas celle du proxy', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await client.post(
    '/api/auth/login',
    { username: 'proxyuser', password: 'MotDePasse1' },
    { 'x-forwarded-for': '10.4.5.6' }
  );

  const log = helpers.db
    .get()
    .prepare("SELECT ip FROM connection_logs WHERE username = 'proxyuser' ORDER BY id DESC LIMIT 1")
    .get();

  assert.equal(log.ip, '10.4.5.6');
});
