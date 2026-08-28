'use strict';

/**
 * Lot 45 — le repli silencieux de `tryDecryptJson`, côté écritures.
 *
 * ─── Le piège ────────────────────────────────────────────────────────────────
 *
 * `tryDecryptJson(blob, {})` rend `{}` aussi bien quand la configuration est
 * VIDE que quand son déchiffrement ÉCHOUE (phrase secrète absente ou changée).
 * Deux situations opposées, indiscernables — c'est ce qui a transformé un
 * défaut de script en énigme de trois heures le 20/08/2026.
 *
 * En LECTURE, la confusion égare. En ÉCRITURE, elle détruit : fusionner un
 * formulaire avec un « précédent » qui vaut le repli, puis rechiffrer,
 * remplace toute la configuration existante — mots de passe, session capturée,
 * jetons — par le seul formulaire du jour, en silence.
 *
 * ─── Ce que ce fichier prouve ────────────────────────────────────────────────
 *
 * Une configuration rendue indéchiffrable (un octet altéré : même effet qu'une
 * phrase secrète changée) n'est JAMAIS écrasée :
 *
 *   1. `registry.configIllisible()` la distingue d'une configuration absente ;
 *   2. `registry.saveConfig()` refuse, et le blob en base ne bouge pas d'un
 *      octet ;
 *   3. le `reconcile()` d'une récupération ne réécrit pas la sélection
 *      par-dessus — sans quoi il ne resterait QUE la sélection ;
 *   4. `destinations.saveConfig()` refuse de même pour un espace de stockage.
 *
 * Chaque refus est vérifié sur les OCTETS du blob : c'est l'assertion qui
 * mord. Sans la garde, l'écriture « réussit » et le blob change — le test
 * échoue alors sur la comparaison, pas sur une absence d'exception.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const destinations = require('../server/destinations');

const db = helpers.db;

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

/** Rend un blob `v1.nonce.cipher` indéchiffrable en altérant un octet du chiffré. */
function corrompre(blob) {
  const parts = String(blob).split('.');
  const cipher = Buffer.from(parts[2], 'base64');
  cipher[0] ^= 0xff;
  return `${parts[0]}.${parts[1]}.${cipher.toString('base64')}`;
}

function blobConnecteur(userId, connectorId) {
  return db
    .get()
    .prepare('SELECT config_encrypted FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(userId, connectorId).config_encrypted;
}

function blobDestination(destId) {
  return db
    .get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId).config_encrypted;
}

test('connecteur : indéchiffrable n\'est pas « sans configuration », et rien ne l\'écrase', async (t) => {
  const user = await helpers.createUser({ username: 'garde-connecteur' });
  registry.install(user.id, 'edf');

  await t.test('avant toute configuration, rien n\'est illisible', () => {
    assert.equal(registry.configIllisible(user.id, 'edf'), false);
  });

  registry.saveConfig(user.id, 'edf', { username: 'camille@exemple.fr', password: 'p4ss' });
  assert.equal(registry.configIllisible(user.id, 'edf'), false);

  // La phrase secrète « change » : le blob ne se déchiffre plus.
  const corrompu = corrompre(blobConnecteur(user.id, 'edf'));
  db.get()
    .prepare('UPDATE connector_installs SET config_encrypted = ? WHERE user_id = ? AND connector_id = ?')
    .run(corrompu, user.id, 'edf');

  await t.test('la sentinelle distingue les deux situations', () => {
    assert.equal(registry.configIllisible(user.id, 'edf'), true);
  });

  await t.test('saveConfig refuse, et le blob ne bouge pas d\'un octet', () => {
    assert.throws(
      () => registry.saveConfig(user.id, 'edf', { username: 'autre@exemple.fr' }),
      /ne peut plus être déchiffrée/
    );
    assert.equal(blobConnecteur(user.id, 'edf'), corrompu);
  });

  await t.test('reconcile ne réécrit pas la sélection par-dessus l\'illisible', () => {
    const journal = [];
    const reconcile = registry.makeReconciler(user.id, 'edf', (l) => journal.push(l));
    const sortie = reconcile('lignes', [{ id: 'compteur-1', label: 'Compteur 1' }]);

    assert.ok(sortie, 'reconcile répond — la récupération n\'est pas cassée');
    assert.equal(blobConnecteur(user.id, 'edf'), corrompu);
    assert.ok(
      journal.some((l) => /illisible/.test(l)),
      `le journal dit pourquoi rien n'est réécrit — lignes vues : ${journal.join(' | ')}`
    );
  });
});

test('destination : indéchiffrable n\'est pas « sans configuration », et rien ne l\'écrase', async (t) => {
  const destId = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud garde' });
  assert.equal(destinations.configIllisible(destId), false);

  const corrompu = corrompre(blobDestination(destId));
  db.get()
    .prepare('UPDATE destinations_config SET config_encrypted = ? WHERE dest_id = ?')
    .run(corrompu, destId);

  await t.test('la sentinelle distingue les deux situations', () => {
    assert.equal(destinations.configIllisible(destId), true);
  });

  await t.test('saveConfig refuse, et le blob ne bouge pas d\'un octet', () => {
    assert.throws(
      () => destinations.saveConfig(destId, { rcloneConfig: 'type = pcloud' }),
      /ne peut plus être déchiffrée/
    );
    assert.equal(blobDestination(destId), corrompu);
  });
});
