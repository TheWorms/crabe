'use strict';

/**
 * Synthèse de stockage de l'écran « Stockage ».
 *
 * L'écran tient en deux lignes : une bande de statistiques, puis les trois
 * destinations côte à côte. La bande a besoin de totaux DÉDOUBLONNÉS (une
 * facture copiée sur deux destinations reste une facture), ce que la somme par
 * destination ne donne pas — d'où les champs `files`, `users` et `uniqueBytes`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const permissions = require('../server/permissions');

let admin;

/** L'identifiant du cloud de test — tiré au sort à la création (lot 25). */
let PCLOUD;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'stockage',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  const autre = await helpers.createUser({ username: 'stockage-bis', plainPassword: 'MotDePasse1' });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);

  // Le cloud de test, créé comme un utilisateur le ferait depuis l'écran
  // Stockage : depuis le lot 25, aucune destination cloud n'existe d'office, et
  // son identifiant n'est connu qu'à l'exécution.
  PCLOUD = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud' });

  // Deux factures pour deux comptes ; la première est copiée sur deux
  // destinations, la seconde n'a réussi que sur le stockage local.
  const insert = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, size_bytes, destinations, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  insert.run(
    admin.id,
    'free',
    'facture-1.pdf',
    1000,
    JSON.stringify({ local: { ok: true }, [PCLOUD]: { ok: true } })
  );
  insert.run(
    autre.id,
    'free',
    'facture-2.pdf',
    500,
    JSON.stringify({ local: { ok: true }, [PCLOUD]: { ok: false, message: 'refusé' } })
  );
});

test.after(() => helpers.teardown());

test('les totaux dédoublonnés comptent une facture une seule fois', () => {
  const global = destinations.globalUsage();
  assert.equal(global.files, 2);
  assert.equal(global.users, 2);
  assert.equal(global.bytes, 1500);

  // La somme par destination, elle, compte bien les copies : 1500 sur le stockage local
  // + 1000 sur pCloud (la copie en échec ne compte pas).
  const perDest = destinations.usageByDestination();
  assert.equal(perDest.find((d) => d.id === 'local').bytes, 1500);
  assert.equal(perDest.find((d) => d.id === PCLOUD).bytes, 1000);
  // Un cloud qui n'existe pas n'a pas de ligne du tout — et non une ligne à
  // zéro : le lot 25 a supprimé les destinations que personne n'a créées.
  assert.equal(perDest.length, 2, 'Le stockage local et le seul cloud existant');
});

test('la bande de statistiques reçoit tout ce qu\'elle affiche', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'stockage', 'MotDePasse1');

  const res = await client.get('/api/admin/destinations');
  assert.equal(res.status, 200);

  const { summary } = res.body;
  assert.equal(summary.files, 2, 'nombre de fichiers');
  assert.equal(summary.users, 2, 'nombre de comptes');
  assert.equal(summary.uniqueBytes, 1500);
  assert.equal(summary.totalBytes, 2500, 'espace occupé, copies comprises');
  assert.equal(Array.isArray(summary.breakdown), true, 'répartition par destination');

  // Toutes les destinations EXISTANTES sont renvoyées, activées ou non : c'est
  // cet écran qui sert à les configurer, et une destination qu'on ne voit pas
  // est une destination qu'on ne peut pas allumer.
  //
  // ⚠ Elles ne sont plus six : jusqu'au lot 24, cette liste était celle du
  // code, et une installation neuve affichait cinq fournisseurs que personne
  // n'avait demandés. Il n'y a désormais que le stockage local, plus ce que l'utilisateur
  // a ajouté.
  assert.deepEqual(res.body.destinations.map((d) => d.id), ['local', PCLOUD]);

  // Et le bouton « Ajouter un cloud » reçoit de quoi proposer un choix.
  assert.ok(res.body.providers.some((p) => p.id === 'pcloud'), 'pCloud proposé');
  // ⚠ Lot 28 — plus de carte « Autre stockage » : ce n'était pas un service
  // mais une porte vers une seconde liste, où pCloud figurait une deuxième
  // fois. Chaque type d'rclone porte désormais son propre nom dans cette
  // liste-ci, et les quatre vedettes l'ouvrent.
  assert.equal(res.body.providers.some((p) => p.id === 'autre'), false, 'plus de sous-menu');
  assert.deepEqual(
    res.body.providers.filter((p) => p.vedette).map((p) => p.id),
    // Six depuis le lot 62 : les deux MEGA (compte gratuit / stockage objet)
    // et le socle « Stockage compatible S3 ».
    ['kdrive', 'mega', 'megas4', 'pcloud', 'proton', 's3'],
    'les vedettes ouvrent la liste, par ordre alphabétique'
  );
});

test('la destination locale porte son état, sans effet de bord', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'stockage', 'MotDePasse1');

  const res = await client.get('/api/admin/destinations');
  const local = res.body.destinations.find((d) => d.id === 'local');

  assert.equal(local.required, true);
  assert.ok(local.path, 'le chemin est renseigné');
  assert.equal(typeof local.mounted, 'boolean');
  assert.ok(
    ['unset', 'missing', 'not-directory', 'not-mounted', 'read-only', 'ok'].includes(local.state),
    `état inattendu : ${local.state}`
  );
});

// ---------------------------------------------------------------------------
// Lot 4 — page « Stockage » du profil : espace utilisé, capacité, répartition
// ---------------------------------------------------------------------------

test('le profil reçoit sa part par destination, sans double comptage du total', async () => {
  const vue = await destinations.storageOverviewForUser(admin.id);

  // Total du compte : une facture, 1000 octets — même si elle est copiée deux
  // fois, l'espace du compte reste celui de ses documents.
  assert.equal(vue.bytes, 1000);
  assert.equal(vue.files, 1);

  // La répartition, elle, montre bien chaque copie réussie.
  const parts = destinations.usageForUserByDestination(admin.id);
  assert.equal(parts.local.bytes, 1000);
  assert.equal(parts[PCLOUD].bytes, 1000);

  // Seules les destinations ACTIVES sont présentées à l'utilisateur.
  assert.deepEqual(
    vue.destinations.map((d) => d.id),
    destinations.activeDestinations()
  );
  for (const carte of vue.destinations) {
    assert.ok(carte.name && carte.letter && carte.color, 'la carte doit être affichable');
    assert.equal(typeof carte.space.known, 'boolean');
  }
});

test('aucun total cumulé : l\'espace ne se dit que destination par destination (lot 59)', async () => {
  const vue = await destinations.storageOverviewForUser(admin.id);

  // Additionner un NAS et des clouds fabriquait un réservoir commun qui
  // n'existe pas : la vue ne porte plus AUCUN agrégat de capacité.
  assert.equal('capacity' in vue, false, 'plus d\'agrégat de capacité dans la vue');

  // L'espace, lui, reste dit là où il est vrai : sur chaque carte, mesuré ou
  // avec sa raison de ne pas l'être.
  for (const carte of vue.destinations) {
    assert.equal(typeof carte.space.known, 'boolean');
    if (!carte.space.known) {
      assert.ok(carte.space.reason, 'une mesure absente porte sa raison');
    } else {
      assert.ok(carte.space.totalBytes > 0);
      assert.ok(carte.space.freeBytes >= 0 && carte.space.freeBytes <= carte.space.totalBytes);
    }
  }
});

test('capacité non mesurable : la raison est dite sur la carte, rien n\'est inventé', async (t) => {
  const space = require('../server/destinations/space');
  const original = space.localSpace;
  space.localSpace = async () => space.unknown('Mesure impossible (ENOENT).');
  t.after(() => {
    space.localSpace = original;
  });

  const vue = await destinations.storageOverviewForUser(admin.id);

  const stockageLocal = vue.destinations.find((d) => d.id === 'local');
  assert.equal(stockageLocal.space.known, false);
  assert.equal(stockageLocal.space.totalBytes, null, 'aucun total inventé');
  assert.match(stockageLocal.space.reason, /Mesure impossible/, 'la raison de l\'échec est transmise');

  // L'espace occupé du compte, lui, reste mesuré : c'est ce qui s'affiche seul.
  assert.equal(vue.bytes, 1000);
});

test('la route du profil renvoie la vue complète', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'stockage', 'MotDePasse1');

  const res = await client.get('/api/connectors/me/storage');
  assert.equal(res.status, 200);
  for (const champ of ['bytes', 'files', 'filesThisMonth', 'destinations']) {
    assert.ok(champ in res.body, `champ « ${champ} » attendu`);
  }
  assert.equal('capacity' in res.body, false, 'l\'agrégat menteur ne part plus au client');
  assert.equal(res.body.bytes, 1000);
});
