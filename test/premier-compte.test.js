'use strict';

/**
 * Le premier compte — l'écran de création n'existe que tant que la base est
 * vide (routes /api/auth/premier-compte, écran « Bienvenue » de login.html).
 *
 * L'assertion qui compte est la dernière : dès qu'un utilisateur existe, le
 * POST répond 403 et n'écrit RIEN. C'est elle qui interdit à un visiteur de
 * se fabriquer un compte administrateur sur une instance en service — il n'y
 * a pas d'inscription publique dans crabe, seulement une fenêtre de premier
 * démarrage qui se referme pour toujours.
 *
 * L'ordre des tests est significatif : les refus (identifiant, politique de
 * mot de passe) sont mesurés AVANT la création, parce qu'après elle, c'est le
 * 403 qui répond en premier et les autres refus deviennent inobservables.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

function compteUtilisateurs() {
  return helpers.db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

test("base vide : l'écran de création est proposé", async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const res = await client.get('/api/auth/premier-compte');
  assert.equal(res.status, 200);
  assert.equal(res.body.vierge, true);
});

test("un identifiant invalide est refusé, rien n'est écrit", async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const res = await client.post('/api/auth/premier-compte', {
    username: 'a',
    password: 'MotDePasse1',
  });
  assert.equal(res.status, 400);
  assert.equal(compteUtilisateurs(), 0, 'aucun utilisateur ne doit exister');
});

test("un mot de passe sous la politique est refusé, rien n'est écrit", async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const res = await client.post('/api/auth/premier-compte', {
    username: 'proprietaire',
    password: 'abc',
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /mot de passe/i);
  assert.equal(compteUtilisateurs(), 0, 'aucun utilisateur ne doit exister');
});

test('la création : compte admin, session ouverte dans la foulée', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const res = await client.post('/api/auth/premier-compte', {
    username: 'proprietaire',
    password: 'MotDePasse1',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.step, 'done');
  assert.equal(res.body.user.role, 'admin');

  // La session est réellement ouverte : /me répond sans reconnexion. Celui
  // qui vient de créer son compte ne retape pas son mot de passe.
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));

  // Le rôle est LE rôle admin intégré, pas un rôle bricolé sans permissions.
  const row = helpers.db
    .get()
    .prepare('SELECT role, role_id FROM users WHERE username = ?')
    .get('proprietaire');
  assert.equal(row.role, 'admin');
  assert.equal(row.role_id, permissions.roleBySlug('admin').id);
});

test("dès qu'un compte existe, la fenêtre est refermée pour toujours", async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const etat = await client.get('/api/auth/premier-compte');
  assert.equal(etat.status, 200);
  assert.equal(etat.body.vierge, false);

  // LA ligne qui compte : un visiteur d'une instance en service ne peut pas
  // se fabriquer un compte administrateur.
  const res = await client.post('/api/auth/premier-compte', {
    username: 'intrus',
    password: 'MotDePasse1',
  });
  assert.equal(res.status, 403);
  assert.equal(compteUtilisateurs(), 1, 'le compte du propriétaire doit rester seul');
});
