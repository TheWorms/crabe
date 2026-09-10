'use strict';

/**
 * Lot 58 — les événements du renommage entrent dans les journaux de l'écran.
 *
 * Demande explicite du 25/08/2026 : un renommage qui s'arrête ne laissait sa
 * trace que dans le bandeau de l'écran Fichiers. Ses événements s'écrivent
 * dans app_logs sous la source `harmonisation` (l'existant du lot 56, complété
 * au lot 58) — et l'onglet « Logs → Stockage » les AFFICHE désormais, fusionnés
 * aux opérations de destination, comme l'onglet Connecteurs fusionne les
 * lignes `connector:` depuis le lot 41. Vérifié ici sur les vraies routes :
 * l'affichage, le filtre, le tri par résultat, et la purge qui emporte ce que
 * l'écran montre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot58', plainPassword: 'MotDePasse1', role: 'admin' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot58', 'MotDePasse1');

  const applog = require('../server/applog');
  const db = require('../server/db/db');

  // Le journal d'un chantier inventé : démarrage, arrêt sur écart, reprise.
  applog.info('harmonisation', 'Renommage lancé : 3 document(s), 6 mouvement(s) vers la convention « avec-service ».', { userId: 1, username: 'lot58' });
  applog.error('harmonisation', 'Renommage arrêté net : le nom cible est déjà occupé — document 2, destination cloud-invente.', { userId: 1, username: 'lot58' });
  applog.info('harmonisation', 'Reprise du renommage : 1 document(s) déjà fait(s) au journal, 2 restant(s) au plan recalculé.', { userId: 1, username: 'lot58' });
  // Et une ligne d'une AUTRE source : elle ne doit pas fuir dans cet onglet.
  applog.error('scheduler', 'Une erreur d\'une autre source, qui reste dans l\'onglet Application.');

  // Une opération de destination classique, pour la fusion.
  db.get()
    .prepare('INSERT INTO destination_logs (dest_id, user_id, success, message) VALUES (?, 1, 1, ?)')
    .run('local', 'facture-inventee.pdf déposée.');
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

test('l\'onglet Stockage fusionne le journal du renommage avec les opérations', async () => {
  const rendu = await client.get('/api/admin/logs/storage?dest=all&result=all');
  assert.equal(rendu.status, 200);

  const messages = rendu.body.logs.map((l) => l.message);
  assert.ok(messages.some((m) => /Renommage lancé : 3 document\(s\), 6 mouvement\(s\)/.test(m)), 'le démarrage est là');
  assert.ok(messages.some((m) => /Renommage arrêté net/.test(m)), 'l\'arrêt sur écart est là');
  assert.ok(messages.some((m) => /Reprise du renommage/.test(m)), 'la reprise est là');
  assert.ok(messages.some((m) => /facture-inventee\.pdf/.test(m)), 'les opérations classiques restent');
  assert.equal(messages.some((m) => /autre source/.test(m)), false, 'les autres sources ne fuient pas ici');

  // Les lignes du renommage portent leur étiquette et leur résultat : une
  // ligne `info` est un succès, un arrêt est un échec — cherchable comme tel.
  const renommage = rendu.body.logs.filter((l) => l.destName === 'Renommage des documents');
  assert.equal(renommage.length, 3);
  assert.ok(renommage.every((l) => l.username === 'lot58'), 'le compte est attribué');
  const arret = renommage.find((l) => /arrêté net/.test(l.message));
  assert.equal(arret.success, 0, 'un arrêt se lit comme un échec');

  // Le filtre par destination propose le renommage, en toutes lettres.
  assert.ok(
    rendu.body.filters.some((f) => f.id === 'harmonisation' && f.name === 'Renommage des documents'),
    'le filtre est offert'
  );
});

test('le filtre « Échecs » retient les erreurs du renommage — la demande exacte de l\'incident', async () => {
  const echecs = await client.get('/api/admin/logs/storage?dest=all&result=failure');
  const messages = echecs.body.logs.map((l) => l.message);
  assert.ok(messages.some((m) => /Renommage arrêté net/.test(m)), 'l\'erreur du renommage se trouve');
  assert.equal(messages.some((m) => /Renommage lancé/.test(m)), false, 'pas les lignes de marche normale');
  assert.equal(messages.some((m) => /facture-inventee/.test(m)), false, 'ni les dépôts réussis');

  const filtre = await client.get('/api/admin/logs/storage?dest=harmonisation&result=all');
  assert.equal(filtre.body.logs.length, 3, 'le filtre « Renommage » isole le chantier');
  assert.ok(filtre.body.logs.every((l) => l.destName === 'Renommage des documents'));
});

test('l\'onglet Application garde tout, et la purge du Stockage emporte ce qu\'il affiche', async () => {
  // Les lignes du renommage restent AUSSI dans l'onglet Application : c'est le
  // même journal applicatif, l'onglet Stockage n'est qu'une seconde fenêtre.
  const application = await client.get('/api/admin/logs/app?level=all&q=harmonisation');
  assert.ok(
    application.body.logs.filter((l) => l.source === 'harmonisation').length >= 3,
    'la source se filtre par la recherche de l\'onglet Application'
  );

  const purge = await client.delete('/api/admin/logs/storage');
  assert.equal(purge.status, 200);
  assert.equal(purge.body.deleted, 4, 'une opération + trois lignes de renommage');

  const apres = await client.get('/api/admin/logs/storage?dest=all&result=all');
  assert.equal(apres.body.logs.length, 0, 'l\'onglet est vide après sa purge');
  // La ligne de l'autre source, elle, n'a pas été touchée.
  const reste = await client.get('/api/admin/logs/app?level=all&q=autre source');
  assert.equal(reste.body.logs.length, 1, 'la purge n\'a pas débordé sur le journal applicatif');
});
