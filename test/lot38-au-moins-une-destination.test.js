'use strict';

/**
 * Lot 38, phase B — « au moins une destination active » remplace « le stockage local
 * obligatoire ».
 *
 * Mesuré avant d'écrire la règle (18/08/2026) :
 *
 *   - la LECTURE sait déjà passer par rclone : « Mes documents » liste depuis
 *     la base et rapatrie les fichiers d'un cloud par `rclone copyto` ;
 *   - le PREMIER dépôt écrit depuis la mémoire vers chaque destination active
 *     dans la même passe — aucune écriture locale préalable ;
 *   - les deux seuls verrous étaient `storeInvoice`, qui exigeait l'écriture
 *     sur le stockage local inconditionnellement, et l'absence de garde-fou sur le dernier
 *     espace actif.
 *
 * Ce que ce fichier verrouille :
 *
 *   1. une facture est valide dès qu'une destination l'a réellement reçue,
 *      quand le stockage local n'est pas dans la passe ;
 *   2. l'échec de TOUTES les destinations reste un échec, motivé ;
 *   3. Le stockage local ACTIF reste la copie de référence : son échec fait échouer la
 *      facture entière — c'est depuis lui que « Synchroniser » répare ;
 *   4. éteindre ou supprimer la dernière destination active est refusé, en
 *      français, avec le geste qui débloque ;
 *   5. une écriture interne (relevé d'un secret réécrit par rclone) ne touche
 *      pas l'interrupteur d'activation ;
 *   6. sans le stockage local, la consultation retombe sur la première destination
 *      active au lieu de rendre un écran vide.
 */

// Les trois secondes entre deux tentatives de copie valent zéro ici.
process.env.CRABE_COPIE_DELAI_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const documents = require('../server/documents');
const db = require('../server/db/db');

let user;
let CLOUD;
let VRAI;
let racine;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot38b' });

  racine = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crabe-lot38b-'));
  destinations.saveConfig('local', { path: racine, protocol: 'local' });

  CLOUD = helpers.creerCloud({ provider: 'pcloud', displayName: 'Cloud 38' });
  VRAI = destinations.driverFor(CLOUD);
});

test.after(() => {
  destinations.DRIVERS[CLOUD] = VRAI;
  fs.rmSync(racine, { recursive: true, force: true });
  helpers.teardown();
});

/** Remplace le dépôt du cloud de test par un double. */
function doubler(reponse) {
  destinations.DRIVERS[CLOUD] = { ...VRAI, store: async (conf, target) => reponse(target) };
}

/**
 * Éteint le stockage local PAR LA BASE : le geste d'interface est désormais refusé
 * quand il est le dernier actif, et c'est précisément ce que ces tests
 * vérifient — l'état, lui, doit rester racontable.
 */
function sansLocal() {
  db.get()
    .prepare(
      `UPDATE destinations_config SET enabled = 0, deleted_at = datetime('now')
        WHERE dest_id = 'local'`
    )
    .run();
  destinations.oublierPilotes();
}

function facture(destinationIds) {
  return destinations.storeInvoice({
    username: user.username,
    userId: user.id,
    connectorId: 'free',
    connectorName: 'Free Internet',
    accountId: 'c1',
    filename: 'facture.pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
    destinationIds,
  });
}

// ---------------------------------------------------------------------------
// storeInvoice : « au moins une », et la copie de référence
// ---------------------------------------------------------------------------

test('sans le stockage local dans la passe, une destination qui accepte suffit', async () => {
  doubler(() => ({ ok: true, path: 'crabe:crabe/x/facture.pdf' }));
  const results = await facture([CLOUD]);
  assert.equal(results[CLOUD].ok, true);
  assert.equal('local' in results, false, 'Le stockage local n\'a pas été tenté : il n\'était pas demandé');
});

test('l\'échec de toutes les destinations reste un échec, et il est motivé', async () => {
  doubler(() => ({ ok: false, message: 'quota plein' }));
  await assert.rejects(
    () => facture([CLOUD]),
    /Aucun espace de stockage n'a accepté ce document — quota plein/
  );
});

test('Le stockage local actif et en échec fait toujours échouer la facture entière', async () => {
  // La copie de référence n'est pas négociable QUAND elle est active : c'est
  // depuis elle que « Synchroniser » répare les clouds. Un chemin impossible
  // suffit à mesurer le refus.
  const conf = destinations.readConfig('local');
  destinations.saveConfig('local', { path: '/dev/null/impossible', protocol: 'local' });
  doubler(() => ({ ok: true, path: 'crabe:crabe/x/facture.pdf' }));
  try {
    await assert.rejects(
      () => facture(['local', CLOUD]),
      /Écriture sur le stockage local impossible/,
      'le succès du cloud ne rachète pas l\'échec de la copie de référence'
    );
  } finally {
    destinations.saveConfig('local', { path: conf.path, protocol: conf.protocol });
  }
});

// ---------------------------------------------------------------------------
// Le garde-fou du dernier espace actif
// ---------------------------------------------------------------------------

test('éteindre ou supprimer la dernière destination active est refusé', () => {
  sansLocal();
  try {
    assert.deepEqual(destinations.activeDestinations(), [CLOUD]);

    const enFrancais = (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /dernier espace de stockage actif/);
      assert.match(err.message, /Paramètres → Stockage/);
      return true;
    };
    assert.throws(() => destinations.saveConfig(CLOUD, { enabled: false }), enFrancais);
    assert.throws(() => destinations.deleteCloud(CLOUD), enFrancais);

    assert.deepEqual(destinations.activeDestinations(), [CLOUD], 'le refus n\'a rien débranché');
  } finally {
    destinations.restoreLocal();
  }
});

test('une écriture interne sans `enabled` ne touche pas l\'interrupteur', () => {
  assert.ok(destinations.activeDestinations().includes(CLOUD));
  // Le relevé des secrets qu'rclone réécrit (`onSecretsRafraichis`) passe par
  // `saveConfig` sans jamais parler d'activation : avant le lot 38, ce simple
  // rafraîchissement éteignait la destination en silence.
  destinations.saveConfig(CLOUD, { valeurs: { token: 'jeton-rafraichi' } }, [
    { key: 'token', type: 'password' },
  ]);
  assert.ok(
    destinations.activeDestinations().includes(CLOUD),
    'un rafraîchissement de jeton ne doit pas sortir la destination des copies'
  );
});

// ---------------------------------------------------------------------------
// La consultation sans le stockage local
// ---------------------------------------------------------------------------

test('sans le stockage local, la consultation retombe sur la première destination active', () => {
  db.get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'free', '2026-07_cloud.pdf', NULL, 'c1', 2048, '2026-07-05', ?)`
    )
    .run(
      user.id,
      JSON.stringify({ [CLOUD]: { state: 'ok', ok: true, at: '2026-07-06T10:00:00.000Z' } })
    );

  sansLocal();
  try {
    const vue = documents.browse(user, {});
    assert.equal(vue.destination.id, CLOUD, 'la première destination active prend le relais');
    assert.equal(vue.available, true);
    const noms = vue.tree.flatMap((b) => b.accounts.flatMap((c) => c.documents.map((d) => d.filename)));
    assert.ok(noms.includes('2026-07_cloud.pdf'), 'les documents déposés sur le cloud restent visibles');
  } finally {
    destinations.restoreLocal();
  }
});
