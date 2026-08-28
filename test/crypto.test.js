'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const helpers = require('./helpers');
const crypto = require('../server/crypto');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

test('un aller-retour chiffrement/déchiffrement conserve la valeur', () => {
  const secret = 'mot-de-passe-ovh-très-secret';
  const blob = crypto.encrypt(secret);
  assert.match(blob, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.equal(blob.includes(secret), false, 'le clair ne doit pas apparaître');
  assert.equal(crypto.decrypt(blob), secret);
});

test('les objets sont sérialisés en JSON de façon transparente', () => {
  const config = { username: 'camille', password: 'p4ssw0rd', endpoint: 'ovh-eu' };
  assert.deepEqual(crypto.decryptJson(crypto.encrypt(config)), config);
});

test('deux chiffrements du même clair diffèrent (nonce aléatoire)', () => {
  const a = crypto.encrypt('identique');
  const b = crypto.encrypt('identique');
  assert.notEqual(a, b);
  assert.equal(crypto.decrypt(a), crypto.decrypt(b));
});

test('null et undefined traversent sans erreur', () => {
  assert.equal(crypto.encrypt(null), null);
  assert.equal(crypto.encrypt(undefined), null);
  assert.equal(crypto.decrypt(null), null);
  assert.equal(crypto.decrypt(''), null);
});

test('un chiffré altéré est rejeté, pas silencieusement accepté', () => {
  const blob = crypto.encrypt('données sensibles');
  const parts = blob.split('.');

  // On modifie un octet du texte chiffré.
  const cipher = Buffer.from(parts[2], 'base64');
  cipher[0] ^= 0xff;
  const tampered = `${parts[0]}.${parts[1]}.${cipher.toString('base64')}`;

  assert.throws(() => crypto.decrypt(tampered), /Déchiffrement impossible/);
});

test('un format invalide est refusé', () => {
  assert.throws(() => crypto.decrypt('pas-un-blob'), /Format de secret chiffré invalide/);
  assert.throws(() => crypto.decrypt('v2.aaa.bbb'), /Format de secret chiffré invalide/);
});

test('tryDecryptJson() renvoie le repli au lieu de lever', () => {
  assert.deepEqual(crypto.tryDecryptJson('corrompu', { defaut: true }), { defaut: true });
  assert.equal(crypto.tryDecryptJson('corrompu'), null);
});

test('une passphrase différente ne déchiffre pas les secrets', async () => {
  const blob = crypto.encrypt('secret partagé');

  // On rejoue la dérivation dans un module neuf, avec le même sel mais une
  // autre passphrase : le déchiffrement doit échouer.
  delete require.cache[require.resolve('../server/crypto')];
  const other = require('../server/crypto');
  const saltFile = path.join(helpers.dataDir, 'master.salt');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-salt-'));
  fs.copyFileSync(saltFile, path.join(tmp, 'master.salt'));

  await other.init({ passphrase: 'une-tout-autre-passphrase-9876', dataDir: tmp });
  assert.throws(() => other.decrypt(blob), /Déchiffrement impossible/);

  fs.rmSync(tmp, { recursive: true, force: true });

  // On restaure le module partagé pour les tests suivants.
  delete require.cache[require.resolve('../server/crypto')];
  const restored = require('../server/crypto');
  await restored.init();
  assert.equal(restored.decrypt(blob), 'secret partagé');
});

test('le sel maître est persisté avec des droits restreints', () => {
  const saltFile = path.join(helpers.dataDir, 'master.salt');
  assert.equal(fs.existsSync(saltFile), true);
  const mode = fs.statSync(saltFile).mode & 0o777;
  assert.equal(mode, 0o600, `droits attendus 600, obtenus ${mode.toString(8)}`);
});

test('randomToken() produit des jetons hexadécimaux uniques', () => {
  const a = crypto.randomToken(16);
  const b = crypto.randomToken(16);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('timingSafeEqual() compare correctement', () => {
  assert.equal(crypto.timingSafeEqual('abc', 'abc'), true);
  assert.equal(crypto.timingSafeEqual('abc', 'abd'), false);
  assert.equal(crypto.timingSafeEqual('abc', 'abcd'), false);
});
