'use strict';

/**
 * Lot 56 — le SOCLE applique la convention du compte au moment du dépôt.
 *
 * La fonction pure (`convention-noms.nomDeDepot`) est prouvée ailleurs ; ce
 * fichier verrouille le BRANCHEMENT : c'est bien le pipeline de récupération
 * (`scheduler.runForUser`) qui normalise le nom produit par un connecteur —
 * en base ET sur le stockage — selon le réglage `fichiers.convention` du
 * compte. Si ce branchement disparaît, un connecteur à nom « en dur » (période
 * en tête sans le service, comme Amazon ou Free) recrée la dette du lot 55 à
 * chaque récupération : c'est exactement ce que ce test fait échouer.
 *
 * Le connecteur est réel (edf), sa récupération est remplacée par une liste
 * inventée : ce qui est mesuré est le socle, pas un site.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const preferences = require('../server/preferences');

let user;
const vraiFetch = registry.fetchInvoicesDetailed;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'camille-depot' });
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: 'client@exemple.invalid', password: 'x' });
});

test.after(() => {
  registry.fetchInvoicesDetailed = vraiFetch;
  helpers.teardown();
});

/** La récupération rend une facture inventée, nommée À L'ANCIENNE. */
function simulerRecuperation(filename) {
  registry.fetchInvoicesDetailed = async () => ({
    invoices: [{
      remoteId: `ref-${filename}`,
      filename,
      issuedOn: '2026-05-05',
      buffer: Buffer.from('%PDF-1.4 faux document'),
    }],
    accountId: 'client',
  });
}

function ligne(filename) {
  return helpers.db
    .get()
    .prepare('SELECT filename, destinations FROM invoices WHERE user_id = ? AND connector_id = ? AND filename = ?')
    .get(user.id, 'edf', filename);
}

test('un nom à l\'ancienne est ramené à la convention du compte au dépôt', async () => {
  simulerRecuperation('2026-05_100042.pdf');
  const run = await scheduler.runForUser(user.id, 'edf', 'manual');
  assert.equal(run.ok, true, run.message);

  // La convention par défaut est « avec le service » : le service s'ajoute.
  const depose = ligne('edf_2026-05_100042.pdf');
  assert.ok(depose, 'la ligne porte le nom à la convention, pas le nom produit par le connecteur');
  assert.equal(ligne('2026-05_100042.pdf'), undefined, 'l\'ancienne forme n\'existe nulle part');

  // Et le FICHIER déposé sur le stockage local porte le même nom que la base.
  const chemin = JSON.parse(depose.destinations).local.path;
  assert.ok(chemin.endsWith('/edf_2026-05_100042.pdf'), chemin);
  assert.ok(fs.existsSync(chemin), 'le fichier existe sous ce nom');
});

test('le réglage « sans le service » vaut pour le dépôt suivant', async () => {
  preferences.set(user.id, 'fichiers.convention', 'sans-service');
  try {
    simulerRecuperation('edf_2026-06_100043.pdf');
    const run = await scheduler.runForUser(user.id, 'edf', 'manual');
    assert.equal(run.ok, true, run.message);

    // Le connecteur produit la forme moderne ; le compte n'en veut pas le
    // service : le socle le retire au dépôt.
    const depose = ligne('2026-06_100043.pdf');
    assert.ok(depose, 'le nom déposé suit le réglage du compte');
    assert.ok(JSON.parse(depose.destinations).local.path.endsWith('/2026-06_100043.pdf'));
  } finally {
    preferences.set(user.id, 'fichiers.convention', 'avec-service');
  }
});
