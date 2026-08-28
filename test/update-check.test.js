'use strict';

/**
 * Le bouton « Vérifier les mises à jour » (POST /api/system/update-check).
 *
 * La route de la ménagerie promettait un « git pull sur le LXC » — vrai
 * là-bas, absurde ici. Ce test garde la version publique honnête : quand
 * CRABE_UPDATE_REPO est vide, la route DIT que la vérification est coupée
 * et comment l'armer, et la promesse de la ménagerie ne réapparaît jamais.
 *
 * La branche « une version est disponible » n'est pas exercée ici : elle
 * passerait par un vrai appel réseau à api.github.com, ce qu'aucun test ne
 * fait. La mécanique d'interrogation, de comparaison et de cadence est déjà
 * prouvée par test/version.test.js avec un fetch injecté.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');

test.before(async () => {
  await helpers.setup();
  const admin = await helpers.createUser({
    username: 'verif-admin',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});
test.after(() => helpers.teardown());

test('CRABE_UPDATE_REPO vide : la route dit que la vérification est coupée', async (t) => {
  delete process.env.CRABE_UPDATE_REPO;

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'verif-admin', 'MotDePasse1');

  const res = await client.post('/api/system/update-check');
  assert.equal(res.status, 200);
  assert.equal(res.body.upToDate, null, 'coupée n\'est ni « à jour » ni « en retard »');
  assert.match(res.body.message, /CRABE_UPDATE_REPO/, 'le message dit comment armer la vérification');

  // LA ligne qui mord : la promesse de la ménagerie ne doit plus exister ici.
  assert.equal(
    /git pull/.test(res.body.message),
    false,
    'plus jamais « git pull sur le LXC » dans la version publique'
  );
});

test('la route reste une porte d\'administrateur', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  // Aucune connexion : le POST doit être refusé.
  const res = await client.post('/api/system/update-check');
  assert.ok(res.status === 401 || res.status === 403, `refus attendu, reçu ${res.status}`);
});
