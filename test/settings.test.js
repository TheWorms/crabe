'use strict';

/**
 * Réglages d'affichage (fuseau, formats de date et d'heure) et Gravatar.
 *
 * Gravatar est le seul point de crabe qui parle à un service tiers : il doit
 * rester désactivé par défaut, et ne produire AUCUNE URL sortante tant que
 * l'administrateur ne l'a pas autorisé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const helpers = require('./helpers');
const settings = require('../server/settings');
const permissions = require('../server/permissions');

let admin;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'usagere', plainPassword: 'MotDePasse1' });
  admin = await helpers.createUser({
    username: 'reglages',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Valeurs par défaut
// ---------------------------------------------------------------------------

test('les défauts sont ceux demandés : Europe/Paris, 24 h, JJ/MM/AAAA', () => {
  const current = settings.publicSettings();
  assert.equal(current.timezone, 'Europe/Paris');
  assert.equal(current.timeFormat, '24');
  assert.equal(current.dateFormat, 'DD/MM/YYYY');
  assert.equal(current.gravatarEnabled, false);
});

test('les valeurs inconnues sont refusées', () => {
  assert.throws(() => settings.updateAppSettings({ timezone: 'Mars/Olympus_Mons' }), /Fuseau/);
  assert.throws(() => settings.updateAppSettings({ timeFormat: '36' }), /heure/);
  assert.throws(() => settings.updateAppSettings({ dateFormat: 'JJ-MM' }), /date/);
  assert.throws(() => settings.updateAppSettings({}), /Aucune modification/);
});

test('la liste des fuseaux contient les fuseaux utiles', () => {
  const zones = settings.timezones();
  assert.ok(zones.includes('Europe/Paris'));
  assert.ok(zones.length > 5);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('tout compte authentifié lit les réglages (pour formater les dates)', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'usagere', 'MotDePasse1');

  const res = await client.get('/api/system/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.timezone, 'Europe/Paris');
  assert.equal(res.body.timeFormats.length, 2);
  assert.equal(res.body.dateFormats.length, 3);
  assert.equal(res.body.timezones, undefined, 'la liste IANA reste côté administration');

  // Mais il ne peut pas les changer.
  assert.equal((await client.put('/api/system/settings', { timeFormat: '12' })).status, 403);
});

test('l\'administration change les réglages et le journal en garde la trace', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'reglages', 'MotDePasse1');

  const before = await client.get('/api/system/settings');
  assert.ok(Array.isArray(before.body.timezones), 'la liste IANA est fournie à l\'admin');

  const res = await client.put('/api/system/settings', {
    timezone: 'Europe/Brussels',
    timeFormat: '12',
    dateFormat: 'YYYY-MM-DD',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.timezone, 'Europe/Brussels');
  assert.equal(res.body.settings.timeFormat, '12');
  assert.equal(res.body.settings.dateFormat, 'YYYY-MM-DD');

  const trace = require('../server/applog').list({ q: 'Réglages d\'affichage' });
  assert.ok(trace.length >= 1);
  assert.equal(trace[0].username, 'reglages');

  // Remise en état pour les tests suivants.
  await client.put('/api/system/settings', {
    timezone: 'Europe/Paris',
    timeFormat: '24',
    dateFormat: 'DD/MM/YYYY',
  });
});

// ---------------------------------------------------------------------------
// Gravatar
// ---------------------------------------------------------------------------

test('Gravatar désactivé : aucune URL tierce ne sort du serveur', async (t) => {
  assert.equal(settings.gravatarAllowed(), false);
  assert.equal(settings.gravatarUrl('camille@example.test'), null);

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'usagere', 'MotDePasse1');

  const me = await client.get('/api/auth/me');
  assert.equal(me.body.user.gravatarUrl, null);
  assert.equal(me.body.settings.gravatarEnabled, false);
});

test('Gravatar autorisé : l\'URL porte l\'empreinte de l\'adresse normalisée', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'reglages', 'MotDePasse1');

  const security = await client.get('/api/system/security');
  assert.equal(security.body.gravatarEnabled, false);
  assert.match(security.body.gravatarNotice, /service tiers/);

  const enabled = await client.put('/api/system/security', { gravatarEnabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.gravatarEnabled, true);

  const expected = createHash('sha256').update('usagere@test.local').digest('hex');
  const url = settings.gravatarUrl('  UsagerE@Test.Local  ');
  assert.ok(url.includes(expected), 'adresse normalisée avant empreinte');
  assert.match(url, /^https:\/\/www\.gravatar\.com\/avatar\//);
  assert.match(url, /d=404/, 'repli possible sur les initiales si aucun avatar');
  assert.equal(url.includes('usagere@test.local'), false, 'jamais l\'adresse en clair');

  // Une adresse absente ou invalide ne produit rien.
  assert.equal(settings.gravatarUrl(''), null);
  assert.equal(settings.gravatarUrl('pas-une-adresse'), null);

  // Retour à l'état par défaut.
  await client.put('/api/system/security', { gravatarEnabled: false });
  assert.equal(settings.gravatarAllowed(), false);
});

test('l\'onglet Avatars règle Gravatar via /system/settings, justification incluse', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'reglages', 'MotDePasse1');

  // L'écran lit tout ce dont il a besoin sur cette seule route.
  const before = await client.get('/api/system/settings');
  assert.equal(before.status, 200);
  assert.equal(before.body.settings.gravatarEnabled, false);
  assert.match(before.body.gravatarNotice, /service tiers/);
  assert.match(before.body.gravatarNotice, /gravatar\.com/);

  const enabled = await client.put('/api/system/settings', { gravatarEnabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.settings.gravatarEnabled, true);
  assert.equal(settings.gravatarAllowed(), true);

  // Les autres réglages d'affichage ne bougent pas au passage.
  assert.equal(enabled.body.settings.timezone, 'Europe/Paris');

  const disabled = await client.put('/api/system/settings', { gravatarEnabled: false });
  assert.equal(disabled.body.settings.gravatarEnabled, false);
  assert.equal(settings.gravatarAllowed(), false);
});

// ---------------------------------------------------------------------------
// Informations d'exploitation
// ---------------------------------------------------------------------------

test('la page Système remonte de quoi exploiter le LXC', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'reglages', 'MotDePasse1');

  const res = await client.get('/api/system');
  assert.equal(res.status, 200);

  assert.equal(res.body.node, process.version);
  assert.ok(res.body.uptimeSeconds >= 0);
  assert.ok(res.body.hostname);
  assert.equal(typeof res.body.runtime.dbSizeBytes, 'number');
  assert.equal(res.body.runtime.timezone, 'Europe/Paris');
  assert.ok(res.body.runtime.serverTime);
  assert.equal(typeof res.body.local.mounted, 'boolean');
  assert.equal(typeof res.body.local.writable, 'boolean');
  assert.ok(res.body.schemaVersion >= 7, 'version de schéma appliquée');
  assert.equal(res.body.smtpConfigured, false);
  assert.equal('lastCronAt' in res.body.scheduler, true);
  assert.equal('lastMaintenanceAt' in res.body.scheduler, true);

  const rclone = await client.get('/api/system/rclone');
  assert.equal(rclone.status, 200);
  assert.equal(typeof rclone.body.available, 'boolean');
});
