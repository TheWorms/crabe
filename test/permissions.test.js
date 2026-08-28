'use strict';

/**
 * Rôles et permissions.
 *
 * Le point important : le contrôle est appliqué CÔTÉ SERVEUR. Un compte qui
 * n'a pas la permission reçoit un 403 même en appelant l'API directement,
 * sans passer par l'interface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

/** Crée un compte porteur d'un rôle personnalisé aux permissions données. */
async function userWithRole(username, roleName, perms) {
  const user = await helpers.createUser({ username, plainPassword: 'MotDePasse1' });
  const role = permissions.createRole(roleName, perms);
  permissions.assignRole(user.id, role.id);
  return { user, role };
}

// ---------------------------------------------------------------------------
// Rôles intégrés
// ---------------------------------------------------------------------------

test('les rôles intégrés existent et ne sont pas supprimables', () => {
  const roles = permissions.listRoles();
  const admin = roles.find((r) => r.slug === 'admin');
  const user = roles.find((r) => r.slug === 'user');

  assert.ok(admin && user);
  assert.equal(admin.builtin, true);
  assert.equal(user.builtin, true);
  assert.equal(admin.deletable, false);
  assert.equal(user.deletable, false);

  assert.deepEqual(admin.permissions.sort(), [...permissions.PERMISSION_IDS].sort());
  assert.deepEqual(user.permissions, []);

  assert.throws(() => permissions.deleteRole(admin.id), /intégrés/);
  assert.throws(() => permissions.deleteRole(user.id), /intégrés/);
  assert.throws(() => permissions.renameRole(admin.id), /intégré/);
  assert.throws(() => permissions.setRolePermissions(admin.id, []), /toutes les permissions/);
});

test('un rôle personnalisé porte exactement les permissions choisies', () => {
  const role = permissions.createRole('Lecteur de logs', ['logs.read', 'inexistante']);
  assert.deepEqual(role.permissions, ['logs.read'], 'les permissions inconnues sont ignorées');
  assert.equal(role.builtin, false);
  assert.equal(role.deletable, true);

  const renamed = permissions.renameRole(role.id, 'Observateur');
  assert.equal(renamed.name, 'Observateur');

  permissions.deleteRole(role.id);
  assert.equal(permissions.listRoles().some((r) => r.id === role.id), false);
});

test('un rôle encore attribué exige une réaffectation avant suppression', async () => {
  const { user, role } = await userWithRole('portefeuille', 'Support seul', ['support.reply']);

  assert.throws(() => permissions.deleteRole(role.id), /réaffect|remplacement/i);

  const userRole = permissions.roleBySlug('user');
  const result = permissions.deleteRole(role.id, userRole.id);
  assert.equal(result.reassigned, 1);

  const fresh = helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(fresh.role_id, userRole.id);
  assert.equal(fresh.role, 'user');
});

// ---------------------------------------------------------------------------
// Application côté serveur
// ---------------------------------------------------------------------------

test('un rôle partiel n\'ouvre QUE les routes de ses permissions', async (t) => {
  await userWithRole('vigie', 'Vigie des logs', ['logs.read']);
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'vigie', 'MotDePasse1');
  const me = await client.get('/api/auth/me');
  assert.deepEqual(me.body.user.permissions, ['logs.read']);
  assert.equal(me.body.user.role, 'user', 'ce n\'est pas un administrateur');

  // Autorisé.
  assert.equal((await client.get('/api/admin/logs/connections')).status, 200);
  assert.equal((await client.get('/api/admin/logs/runs')).status, 200);
  // Vue d'ensemble système : accessible dès qu'on a une permission d'admin.
  assert.equal((await client.get('/api/system')).status, 200);

  // Refusé, malgré l'absence de menu correspondant dans l'interface.
  for (const route of [
    '/api/users',
    '/api/admin/roles',
    '/api/admin/connectors',
    '/api/admin/destinations',
    '/api/system/security',
    '/api/tickets',
  ]) {
    const res = await client.get(route);
    assert.equal(res.status, 403, `${route} devrait être refusé`);
    assert.match(res.body.error, /Permission|Réservé/);
  }

  // Purge et rétention relèvent de la sécurité, pas de la lecture.
  assert.equal((await client.del('/api/admin/logs/connections')).status, 403);
  assert.equal((await client.put('/api/admin/logs/retention', { days: 30 })).status, 403);
});

test('la permission « gérer les applications » suffit à gérer les accès', async (t) => {
  await userWithRole('boutiquier', 'Boutiquier', ['apps.manage']);
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'boutiquier', 'MotDePasse1');

  const apps = await client.get('/api/admin/connectors');
  assert.equal(apps.status, 200);
  assert.ok(Array.isArray(apps.body.users), 'la liste des comptes accompagne le catalogue');
  assert.ok(apps.body.users.length > 0);

  assert.equal((await client.get('/api/users')).status, 403, 'pas de gestion des comptes');
});

test('un administrateur garde tout, y compris les nouvelles permissions', async (t) => {
  await helpers.createUser({ username: 'patronne', plainPassword: 'MotDePasse1', role: 'admin' });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE username = ?')
    .run(permissions.roleBySlug('admin').id, 'patronne');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patronne', 'MotDePasse1');

  for (const route of [
    '/api/users',
    '/api/admin/roles',
    '/api/admin/connectors',
    '/api/admin/destinations',
    '/api/admin/logs/connections',
    '/api/system/security',
    '/api/tickets',
  ]) {
    assert.equal((await client.get(route)).status, 200, route);
  }
});

test('un compte sans permission n\'atteint aucune route d\'administration', async (t) => {
  await helpers.createUser({ username: 'simple', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'simple', 'MotDePasse1');

  for (const route of ['/api/users', '/api/admin/roles', '/api/system', '/api/system/security']) {
    assert.equal((await client.get(route)).status, 403, route);
  }
});

// ---------------------------------------------------------------------------
// Garde-fou « au moins un administrateur »
// ---------------------------------------------------------------------------

test('impossible de vider le rôle administrateur', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patronne', 'MotDePasse1');

  // On ne garde qu'un seul admin actif.
  helpers.db
    .get()
    .prepare("UPDATE users SET status = 'inactive' WHERE role = 'admin' AND username != 'patronne'")
    .run();

  const self = helpers.db.get().prepare('SELECT id FROM users WHERE username = ?').get('patronne');
  const userRole = permissions.roleBySlug('user');

  const demoted = await client.put(`/api/admin/roles/users/${self.id}`, { roleId: userRole.id });
  assert.equal(demoted.status, 400);
  assert.match(demoted.body.error, /dernier administrateur/);

  const viaUsers = await client.patch(`/api/users/${self.id}`, { roleId: userRole.id });
  assert.equal(viaUsers.status, 400);

  const disabled = await client.patch(`/api/users/${self.id}`, { status: 'inactive' });
  assert.equal(disabled.status, 400);

  assert.equal(
    helpers.db.get().prepare('SELECT role FROM users WHERE id = ?').get(self.id).role,
    'admin',
    'le compte doit rester administrateur'
  );

  helpers.db.get().prepare("UPDATE users SET status = 'active' WHERE role = 'admin'").run();
});

test('changer de rôle depuis l\'écran Utilisateurs reste cohérent', async (t) => {
  const target = await helpers.createUser({ username: 'promue', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patronne', 'MotDePasse1');

  const adminRole = permissions.roleBySlug('admin');
  const promoted = await client.patch(`/api/users/${target.id}`, { roleId: adminRole.id });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.user.role, 'admin');
  assert.equal(promoted.body.user.roleSlug, 'admin');

  const row = helpers.db.get().prepare('SELECT role, role_id FROM users WHERE id = ?').get(target.id);
  assert.equal(row.role, 'admin');
  assert.equal(row.role_id, adminRole.id);
});
