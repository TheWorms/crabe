'use strict';

/**
 * Lot 53 — la mesure d'espace des destinations ne ment plus.
 *
 * Le défaut mesuré le 24/08/2026 en production : `spaceFor()` passait le champ
 * `rcloneConfig` BRUT à la mesure d'espace. Pour une destination configurée
 * par FORMULAIRE (type + valeurs), ce champ est vide — le bloc est calculé par
 * `driver.normalizeConf()` — et l'accueil comme la page Stockage disaient
 * « espace restant inconnu — configuration absente » d'espaces dont les dépôts
 * réussissaient. Le même défaut avait été corrigé le 18/08/2026 dans
 * `documents.js` (destinationAvailability), pas dans `spaceFor`.
 *
 * Et le garde-fou inverse (« ne pas remplacer un mensonge par l'autre ») :
 * une destination VRAIMENT injoignable doit le dire, avec sa cause.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const space = require('../server/destinations/space');
const rclone = require('../server/destinations/rclone');

let admin;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'espace',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
});

test.after(() => helpers.teardown());

test('un espace configuré par formulaire est mesuré avec le bloc calculé, jamais le champ brut', async (t) => {
  // Configuré comme l'écran Stockage le fait : des CHAMPS, aucun bloc collé.
  // C'est la forme exacte des destinations de production du 24/08/2026.
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud de Camille' }).id;
  destinations.saveConfig(id, {
    enabled: true,
    valeurs: { username: 'camille@exemple.test', password: 'FausseValeur1' },
  });

  const brut = destinations.readConfig(id);
  assert.equal(brut.rcloneConfig || '', '', 'prémisse : le champ brut est vide pour une saisie par formulaire');

  let recu = null;
  const original = space.remoteSpace;
  space.remoteSpace = async (conf) => {
    recu = conf;
    return { known: true, totalBytes: 100, freeBytes: 50, usedBytes: 50 };
  };
  t.after(() => { space.remoteSpace = original; });

  const mesure = await destinations.spaceFor(id);
  assert.equal(mesure.known, true);
  assert.ok(recu, 'la mesure distante a bien été appelée');
  // Le bloc calculé porte le type et les champs saisis : c'est LUI qui devait
  // partir à la mesure. Le champ brut vide aurait fait dire « configuration
  // absente » d'un espace configuré.
  assert.match(recu.rcloneConfig || '', /^type = pcloud$/m, 'le bloc calculé porte le type');
  assert.match(recu.rcloneConfig || '', /^username = /m, 'le bloc calculé porte les champs saisis');
});

test('un espace vraiment injoignable le dit, avec sa cause — jamais un zéro', async (t) => {
  const id = destinations.createCloud({ provider: 'proton', displayName: 'Proton de Camille' }).id;
  destinations.saveConfig(id, {
    enabled: true,
    valeurs: { username: 'camille@exemple.test', password: 'FausseValeur1' },
  });

  // La vraie chaîne de mesure, avec un rclone qui échoue comme face à un
  // service injoignable : la panne doit REMONTER en toutes lettres.
  const disponible = rclone.isAvailable;
  const executer = rclone.run;
  rclone.isAvailable = async () => true;
  rclone.run = async () => { throw new Error('le service distant a refusé la connexion'); };
  t.after(() => { rclone.isAvailable = disponible; rclone.run = executer; });

  const mesure = await destinations.spaceFor(id);
  assert.equal(mesure.known, false, 'aucune capacité inventée');
  assert.equal(mesure.totalBytes, null);
  assert.match(mesure.reason, /n'a pas répondu à la mesure/, 'la panne est dite');
  assert.match(mesure.reason, /refusé la connexion/, 'avec sa cause');

  // Et la carte de l'écran Stockage la porte jusqu'à l'utilisateur — depuis le
  // lot 59, c'est la seule échelle où l'espace s'affiche : sur la destination.
  const vue = await destinations.storageOverviewForUser(admin.id);
  const carte = vue.destinations.find((d) => d.id === id);
  assert.ok(carte, 'la destination injoignable garde sa carte');
  assert.equal(carte.space.known, false, 'aucune capacité inventée');
  assert.match(carte.space.reason, /refusé la connexion/, 'avec la même cause');
});

test('un espace jamais configuré le dit sans accuser une panne', async () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud vide' }).id;

  const mesure = await destinations.spaceFor(id);
  assert.equal(mesure.known, false);
  assert.match(mesure.reason, /n'a pas encore été enregistrée/, 'la phrase dit ce qui manque');
});
