'use strict';

/**
 * Lot 106, R2 — la préférence « Interface » de « Mes documents ».
 *
 * Un réglage PAR COMPTE (`users.documents_ui`, migration 64) : 'base' par
 * défaut, 'explorer' possible, rien d'autre. Il se lit par `GET /api/auth/me`
 * et s'écrit par `PATCH /api/auth/profile`, sur le seul compte connecté.
 * Les deux valeurs sont éprouvées ici, même si l'écran ne propose pas encore
 * la seconde (elle arrive avec l'explorateur, au lot 107).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const migrations = require('../server/db/migrations');
const { INTERFACES_DOCUMENTS } = require('../server/routes/auth');

let titulaire;
let voisine;
let gerante;

test.before(async () => {
  await helpers.setup();
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });
  gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, gerante.id);
});

test.after(() => helpers.teardown());

const valeur = (id) =>
  helpers.db.get().prepare('SELECT documents_ui FROM users WHERE id = ?').get(id).documents_ui;

async function connecte(username) {
  const client = await helpers.startServer();
  const r = await helpers.login(client, username, 'MotDePasse1');
  assert.equal(r.status, 200, `connexion de ${username}`);
  return client;
}

test('R2 — la liste fermée : deux valeurs, celles du CHECK de la colonne', () => {
  assert.deepEqual([...INTERFACES_DOCUMENTS], ['base', 'explorer']);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /documents_ui\s+TEXT\s+NOT NULL DEFAULT 'base'\s+CHECK \(documents_ui IN \('base','explorer'\)\)/);
});

test('R2 — un compte neuf est en « base », lu par GET /api/auth/me', async (t) => {
  const client = await connecte('titulaire');
  t.after(() => client.close());
  assert.equal(valeur(titulaire.id), 'base');
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.documentsUi, 'base');
});

test('R2 — écriture des deux valeurs par PATCH /api/auth/profile, relue en base et dans la réponse', async (t) => {
  const client = await connecte('titulaire');
  t.after(async () => {
    helpers.db.get().prepare("UPDATE users SET documents_ui = 'base' WHERE id = ?").run(titulaire.id);
    await client.close();
  });

  const vers = await client.patch('/api/auth/profile', { documentsUi: 'explorer' });
  assert.equal(vers.status, 200);
  assert.equal(vers.body.user.documentsUi, 'explorer');
  assert.equal(valeur(titulaire.id), 'explorer');
  assert.equal((await client.get('/api/auth/me')).body.user.documentsUi, 'explorer');

  const retour = await client.patch('/api/auth/profile', { documentsUi: 'base' });
  assert.equal(retour.status, 200);
  assert.equal(retour.body.user.documentsUi, 'base');
  assert.equal(valeur(titulaire.id), 'base');
});

test('R2 — toute autre valeur est refusée en 400, avec ce qu\'il faut envoyer, et rien n\'est écrit', async (t) => {
  const client = await connecte('titulaire');
  t.after(() => client.close());
  for (const mauvaise of ['arbre', 'Explorer', '', null, 0, ['base'], { base: true }, '__proto__', 'base ']) {
    const r = await client.patch('/api/auth/profile', { documentsUi: mauvaise });
    assert.equal(r.status, 400, `« ${JSON.stringify(mauvaise)} » doit être refusée`);
    assert.match(r.body.error, /Interface inconnue : choisissez « base » \(interface de base\) ou « explorer »/);
    assert.equal(valeur(titulaire.id), 'base');
  }
  // Une valeur refusée n'emporte pas le reste du profil avec elle… ni ne
  // l'écrit à moitié : la requête entière est refusée.
  const melange = await client.patch('/api/auth/profile', { phone: '+33600000001', documentsUi: 'arbre' });
  assert.equal(melange.status, 400);
  assert.notEqual(
    helpers.db.get().prepare('SELECT phone FROM users WHERE id = ?').get(titulaire.id).phone,
    '+33600000001'
  );
});

test('R2 — un compte n\'écrit que SON réglage : ni par la route du profil, ni par celle de l\'administration', async (t) => {
  const client = await connecte('voisine');
  const admin = await connecte('gerante');
  t.after(async () => {
    helpers.db.get().prepare("UPDATE users SET documents_ui = 'base'").run();
    await client.close();
    await admin.close();
  });

  // Le corps peut nommer un autre compte : la route ne lit que `req.user`.
  const r = await client.patch('/api/auth/profile', {
    documentsUi: 'explorer',
    id: titulaire.id,
    userId: titulaire.id,
    username: 'titulaire',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'voisine');
  assert.equal(valeur(voisine.id), 'explorer');
  assert.equal(valeur(titulaire.id), 'base', 'le réglage de la titulaire n\'a pas bougé');

  // L'écran d'administration des comptes ne connaît pas ce réglage : il ne
  // l'écrit pour personne, même pour une administratrice.
  await admin.patch(`/api/users/${titulaire.id}`, { documentsUi: 'explorer' });
  assert.equal(valeur(titulaire.id), 'base');
  assert.equal(valeur(gerante.id), 'base');
});

test('R2 — la base refuse elle-même une valeur hors liste (CHECK)', () => {
  assert.throws(
    () => helpers.db.get().prepare("UPDATE users SET documents_ui = 'arbre' WHERE id = ?").run(titulaire.id),
    /CHECK constraint failed/
  );
  assert.equal(valeur(titulaire.id), 'base');
});

test('D3 — migration 64 : additive, un compte existant reste en « base », idempotente (essai sur copie)', () => {
  // Une base « d'avant » : le schéma livré, SANS la colonne — c'est l'état de
  // la production au 12/10/2026 (migration 63).
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8');
  const avant = schema.replace(/^\s*documents_ui\s+TEXT.*$/m, '');
  assert.notEqual(avant, schema, 'la ligne de la colonne est bien retirée pour l\'essai');

  const base = new Database(':memory:');
  try {
    base.exec(avant);
    base.prepare("INSERT INTO users (username, password_hash) VALUES ('ancienne', 'x')").run();
    assert.equal(migrations.hasColumn(base, 'users', 'documents_ui'), false);

    const r = migrations.apply(base);
    assert.ok(r.applied.some((m) => m.id === 64), 'la migration 64 est appliquée');
    assert.equal(r.current, 64);
    assert.equal(migrations.hasColumn(base, 'users', 'documents_ui'), true);
    assert.equal(base.prepare("SELECT documents_ui FROM users WHERE username = 'ancienne'").get().documents_ui, 'base');
    assert.equal(base.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'aucune ligne ajoutée ni perdue');

    // Deux fois : rien de plus.
    assert.deepEqual(migrations.apply(base).applied, []);
    const m64 = migrations.MIGRATIONS.find((m) => m.id === 64);
    m64.up(base);
    assert.equal(base.prepare("SELECT documents_ui FROM users WHERE username = 'ancienne'").get().documents_ui, 'base');
    assert.equal(base.pragma('integrity_check', { simple: true }), 'ok');
    assert.throws(
      () => base.prepare("UPDATE users SET documents_ui = 'autre' WHERE username = 'ancienne'").run(),
      /CHECK constraint failed/
    );
  } finally {
    base.close();
  }
});

test('D3 — sur une base neuve (schéma complet), la migration 64 ne fait rien de plus', () => {
  const base = new Database(':memory:');
  try {
    base.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8'));
    migrations.apply(base);
    const colonnes = base.prepare('PRAGMA table_info(users)').all().filter((c) => c.name === 'documents_ui');
    assert.equal(colonnes.length, 1);
    assert.equal(colonnes[0].dflt_value, "'base'");
    assert.equal(colonnes[0].notnull, 1);
  } finally {
    base.close();
  }
});
