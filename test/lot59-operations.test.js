'use strict';

/**
 * Lot 59 — le bandeau « une tâche est en cours ».
 *
 * La vue `operationsPour()` rassemble les états DÉJÀ exposés par les chantiers
 * (renommage, synchronisation, récupérations) sans rien inventer :
 *
 *   - une opération qui tourne est « en-cours », pour son propriétaire ;
 *   - une fin récente s'annonce en « succes » ou « echec » — le lot 65 a
 *     séparé les deux fenêtres (un succès s'efface vite, un échec attend une
 *     décision), voir test/lot65-bandeau.test.js ;
 *   - une opération arrêtée sur erreur n'est JAMAIS « en-cours » ;
 *   - un refus de démarrage n'est pas une opération : rien à annoncer ;
 *   - une fin trop vieille ne s'affiche plus.
 *
 * Les états sont posés par remplacement des fonctions de lecture des modules
 * (`progress`, `runningPairs`) : la vue les lit au moment de l'appel, comme en
 * production, et aucun vrai chantier n'est monté.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const operations = require('../server/operations');
const harmonisation = require('../server/harmonisation');
const destinationSync = require('../server/destinations/sync');
const scheduler = require('../server/scheduler');

let proprietaire;
let curieux;

/** L'état neutre d'un renommage : rien ne tourne, rien ne vient de finir. */
function renommageAuRepos() {
  return {
    running: false, phase: null, phaseFinie: null, userId: null,
    demarreLe: null, termineLe: null, total: 0, faites: 0,
    message: '', refus: null, arret: null,
  };
}

/** Remplace une fonction de lecture le temps d'un test, puis la remet. */
function patch(t, module_, prop, valeur) {
  const original = module_[prop];
  module_[prop] = valeur;
  t.after(() => {
    module_[prop] = original;
  });
}

test.before(async () => {
  await helpers.setup();
  proprietaire = await helpers.createUser({
    username: 'operations',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  curieux = await helpers.createUser({
    username: 'operations-bis',
    plainPassword: 'MotDePasse1',
  });
});

test.after(() => helpers.teardown());

test('un renommage en cours : bandeau orange pour son propriétaire, rien pour un autre compte', (t) => {
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    running: true,
    phase: 'renommage',
    userId: proprietaire.id,
    demarreLe: '2026-08-26T00:00:00.000Z',
    total: 324,
    faites: 100,
    message: 'Renommage en cours',
  }));

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'renommage');
  assert.ok(op, 'le propriétaire voit son chantier');
  assert.equal(op.etat, 'en-cours');
  assert.equal(op.faites, 100);
  assert.equal(op.total, 324);
  assert.equal(op.ecran, 'profil-fichiers', 'le clic mène à Profil → Fichiers');
  assert.equal(op.titre, 'Renommage des documents');

  const autre = operations
    .operationsPour({ id: curieux.id })
    .find((o) => o.type === 'renommage');
  assert.equal(autre, undefined, 'le chantier d\'un compte ne s\'annonce pas aux autres');
});

test('un renommage qui vient de finir s\'annonce en vert, avec son compte rendu', (t) => {
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: proprietaire.id,
    demarreLe: '2026-08-26T00:00:00.000Z',
    termineLe: new Date().toISOString(),
    message: '324 documents renommés.',
  }));

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'renommage');
  assert.ok(op);
  assert.equal(op.etat, 'succes');
  assert.equal(op.detail, '324 documents renommés.');
});

test('un renommage arrêté sur erreur n\'est JAMAIS « en cours » : il s\'annonce en rouge', (t) => {
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: proprietaire.id,
    demarreLe: '2026-08-26T00:00:00.000Z',
    termineLe: new Date().toISOString(),
    arret: 'La destination pCloud n\'a pas répondu. Rien d\'autre n\'a été touché.',
    message: 'La destination pCloud n\'a pas répondu. Rien d\'autre n\'a été touché.',
  }));

  const ops = operations.operationsPour({ id: proprietaire.id });
  const op = ops.find((o) => o.type === 'renommage');
  assert.ok(op, 'l\'échec s\'annonce — un bloc muet sur un échec serait un mensonge');
  assert.equal(op.etat, 'echec');
  assert.match(op.detail, /pCloud/);
  assert.equal(
    ops.some((o) => o.etat === 'en-cours'),
    false,
    'aucune opération « en cours » : le bandeau ne ment pas'
  );
});

test('un refus de démarrage n\'est pas une opération : rien ne s\'annonce', (t) => {
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    userId: proprietaire.id,
    termineLe: new Date().toISOString(),
    refus: 'Une synchronisation des destinations est en cours.',
    message: 'Une synchronisation des destinations est en cours.',
  }));

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'renommage');
  assert.equal(op, undefined, 'rien n\'a commencé : le refus se lit là où le geste a été fait');
});

test('une fin trop vieille ne s\'annonce plus (fenêtre de fin)', (t) => {
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: proprietaire.id,
    termineLe: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    message: '324 documents renommés.',
  }));

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'renommage');
  assert.equal(op, undefined, 'vingt minutes après, le résultat vit dans les journaux, pas au bandeau');
});

test('la synchronisation en cours se voit de tout compte, comme sur l\'accueil', (t) => {
  patch(t, destinationSync, 'progress', () => ({
    running: true,
    destinationIds: ['cloud-test'],
    scope: 'all',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: null,
    total: 100,
    done: 34,
    copied: 34,
    failed: 0,
    errors: [],
    message: 'Synchronisation en cours…',
  }));

  for (const user of [proprietaire, curieux]) {
    const op = operations
      .operationsPour({ id: user.id })
      .find((o) => o.type === 'synchronisation');
    assert.ok(op, `${user.username} voit la synchronisation`);
    assert.equal(op.etat, 'en-cours');
    assert.equal(op.faites, 34);
    assert.equal(op.total, 100);
    assert.equal(op.ecran, 'home');
  }
});

test('une synchronisation finie avec des échecs s\'annonce en rouge, avec le compte exact', (t) => {
  patch(t, destinationSync, 'progress', () => ({
    running: false,
    destinationIds: ['cloud-test'],
    scope: 'all',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: new Date().toISOString(),
    total: 100,
    done: 100,
    copied: 98,
    failed: 2,
    errors: [],
    message: '98 documents copiés, 2 en échec.',
  }));

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'synchronisation');
  assert.ok(op);
  assert.equal(op.etat, 'echec', 'deux copies en échec ne font pas un succès');
  assert.match(op.detail, /2 en échec/);
});

test('une récupération en cours s\'annonce à son compte, et pas aux autres', (t) => {
  patch(t, scheduler, 'runningPairs', () => [
    { userId: proprietaire.id, connectorId: 'free', startedAt: '2026-08-26T00:00:00.000Z' },
  ]);

  const op = operations
    .operationsPour({ id: proprietaire.id })
    .find((o) => o.type === 'recuperation');
  assert.ok(op);
  assert.equal(op.etat, 'en-cours');
  assert.equal(op.ecran, 'home');
  assert.match(op.titre, /Récupération/);

  const autre = operations
    .operationsPour({ id: curieux.id })
    .find((o) => o.type === 'recuperation');
  assert.equal(autre, undefined);
});

test('une récupération finie se lit dans run_logs : succès et échec, chacun à son compte', (t) => {
  const insert = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, invoice_count, message)
     VALUES (?, ?, datetime('now'), ?, 'manual', ?, ?)`
  );
  const succes = insert.run('free', proprietaire.id, 1, 3, '3 documents récupérés.');
  const echec = insert.run('free', curieux.id, 0, 0, 'Le portail n\'a pas répondu.');
  t.after(() => {
    helpers.db.get().prepare('DELETE FROM run_logs WHERE id IN (?, ?)')
      .run(succes.lastInsertRowid, echec.lastInsertRowid);
  });

  const opsProprio = operations.operationsPour({ id: proprietaire.id });
  const vert = opsProprio.find((o) => o.type === 'recuperation');
  assert.ok(vert);
  assert.equal(vert.etat, 'succes');
  assert.equal(vert.detail, '3 documents récupérés.');
  assert.equal(
    opsProprio.filter((o) => o.type === 'recuperation').length,
    1,
    'la récupération d\'un autre compte ne s\'annonce pas ici'
  );

  const rouge = operations
    .operationsPour({ id: curieux.id })
    .find((o) => o.type === 'recuperation');
  assert.ok(rouge);
  assert.equal(rouge.etat, 'echec');
  assert.equal(rouge.detail, 'Le portail n\'a pas répondu.');
});

test('la route du bandeau répond au compte connecté, et refuse un anonyme', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  const anonyme = await client.get('/api/operations');
  assert.equal(anonyme.status, 401, 'sans session, rien ne se lit');

  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    running: true,
    phase: 'renommage',
    userId: proprietaire.id,
    demarreLe: '2026-08-26T00:00:00.000Z',
    total: 10,
    faites: 4,
  }));

  await helpers.login(client, 'operations', 'MotDePasse1');
  const res = await client.get('/api/operations');
  assert.equal(res.status, 200);
  const op = res.body.operations.find((o) => o.type === 'renommage');
  assert.ok(op, 'le bandeau reçoit le chantier en cours');
  assert.equal(op.etat, 'en-cours');
});
