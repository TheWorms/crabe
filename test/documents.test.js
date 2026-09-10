'use strict';

/**
 * « Mes documents » — la vue de consultation rétablie au lot 7.
 *
 * Ce qui est vérifié ici, et qui n'est pas anodin :
 *
 *   - on liste ce qui est RÉELLEMENT sur la destination consultée, pas la table
 *     des factures projetée dessus. Une copie en échec n'apparaît pas dans la
 *     destination où elle a échoué ;
 *   - un fichier effacé du stockage depuis son dépôt est signalé, pas proposé
 *     au téléchargement ;
 *   - une destination injoignable le DIT et propose les autres, au lieu de
 *     rendre une liste vide qui laisserait croire à une perte ;
 *   - l'isolation : jamais un document d'un autre compte, jamais un
 *     téléchargement en devinant un identifiant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const documents = require('../server/documents');
const destinations = require('../server/destinations');

let alix;
let bruno;
let racine;

test.before(async () => {
  await helpers.setup();
  alix = await helpers.createUser({ username: 'alix', plainPassword: 'MotDePasse1' });
  bruno = await helpers.createUser({ username: 'bruno', plainPassword: 'MotDePasse1' });

  racine = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crabe-docs-'));
  destinations.saveConfig('local', { path: racine, protocol: 'local' });
});

test.after(() => {
  fs.rmSync(racine, { recursive: true, force: true });
  helpers.teardown();
});

/**
 * Insère une facture ET écrit son fichier, pour que « telle qu'elle existe sur
 * le stockage » veuille dire quelque chose.
 */
function seed(user, {
  connectorId = 'free',
  filename,
  accountId = 'fbx1',
  issuedOn = '2026-07-05',
  etat = { local: { state: 'ok', ok: true, at: '2026-07-06T10:00:00.000Z' } },
  ecrireLeFichier = true,
} = {}) {
  const id = helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, ?, ?, NULL, ?, 2048, ?, ?)`
    )
    .run(user.id, connectorId, filename, accountId, issuedOn, JSON.stringify(etat)).lastInsertRowid;

  if (ecrireLeFichier) {
    const nom = connectorId === 'free' ? 'Free Internet' : 'Free Mobile';
    const dossier = path.join(racine, user.username, nom, accountId);
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, filename), 'PDF');
  }
  return id;
}

// ---------------------------------------------------------------------------
// L'arborescence
// ---------------------------------------------------------------------------

test('l\'arborescence suit celle du stockage : connecteur, compte, documents', () => {
  seed(alix, { filename: '2026-07_free.pdf' });
  seed(alix, { filename: '2026-06_free.pdf', issuedOn: '2026-06-05' });
  seed(alix, { connectorId: 'free-mobile', filename: '2026-07_fm.pdf', accountId: '0628000000' });
  seed(alix, { connectorId: 'free-mobile', filename: '2026-07_fm2.pdf', accountId: '0749000000' });

  const vue = documents.browse(alix, {});

  assert.equal(vue.available, true);
  assert.equal(vue.total, 4);
  assert.deepEqual(vue.tree.map((b) => b.connectorName), ['Free Internet', 'Free Mobile']);

  const free = vue.tree.find((b) => b.connectorId === 'free');
  assert.equal(free.count, 2);
  assert.deepEqual(free.accounts.map((c) => c.accountId), ['fbx1']);
  assert.equal(free.accounts[0].documents.length, 2);

  // Deux lignes mobiles : deux comptes distincts, comme sur le stockage.
  const mobile = vue.tree.find((b) => b.connectorId === 'free-mobile');
  assert.deepEqual(mobile.accounts.map((c) => c.accountId), ['0628000000', '0749000000']);

  // Ce qu'une ligne porte : nom lisible, période, taille, date, et rien de plus.
  const doc = free.accounts[0].documents[0];
  for (const champ of ['filename', 'period', 'sizeBytes', 'fetchedAt', 'connectorName']) {
    assert.ok(champ in doc, `${champ} manquant`);
  }
  assert.match(doc.period, /^\d{4}-\d{2}$/);
  assert.equal(doc.missing, false);
});

test('on ne liste que ce qui est vraiment sur la destination consultée', () => {
  // Copie tentée et échouée sur le stockage local : elle n'y est pas.
  seed(bruno, {
    filename: '2026-05_rate.pdf',
    etat: { local: { state: 'error', ok: false, message: 'disque plein' } },
    ecrireLeFichier: false,
  });
  // Copie jamais tentée (destination activée après coup) : pas davantage.
  seed(bruno, { filename: '2026-04_attente.pdf', etat: {}, ecrireLeFichier: false });
  seed(bruno, { filename: '2026-03_ok.pdf' });

  const vue = documents.browse(bruno, {});
  const noms = vue.tree.flatMap((b) => b.accounts.flatMap((c) => c.documents.map((d) => d.filename)));

  assert.deepEqual(noms, ['2026-03_ok.pdf'], 'seule la copie réussie est listée');
});

test('un fichier effacé du stockage est signalé, pas proposé au téléchargement', () => {
  const carole = { id: alix.id, username: alix.username };
  seed(carole, { filename: '2026-02_disparu.pdf', ecrireLeFichier: false });

  const vue = documents.browse(carole, { q: 'disparu' });
  const doc = vue.tree[0].accounts[0].documents[0];

  assert.equal(doc.filename, '2026-02_disparu.pdf');
  assert.equal(doc.missing, true, 'le fichier n\'est plus là : il faut le dire');
});

// ---------------------------------------------------------------------------
// Recherche et filtres
// ---------------------------------------------------------------------------

test('recherche par nom, filtre par connecteur, filtre par période', () => {
  const tous = documents.documentsOn(alix, 'local');

  // « 2026-07_fm » attraperait aussi « 2026-07_fm2.pdf » : la recherche est une
  // sous-chaîne, pas une égalité.
  assert.equal(documents.applyFilters(tous, { q: '2026-07_fm2' }).length, 1);
  assert.equal(documents.applyFilters(tous, { q: '2026-07_fm' }).length, 2);
  assert.equal(documents.applyFilters(tous, { connector: 'free-mobile' }).length, 2);
  assert.equal(documents.applyFilters(tous, { period: '2026-06' }).length, 1);

  // Les filtres se combinent, ils ne se remplacent pas.
  assert.equal(
    documents.applyFilters(tous, { connector: 'free-mobile', period: '2026-06' }).length,
    0
  );

  // La recherche porte aussi sur le service et le compte, pas seulement sur le
  // nom de fichier : personne ne retient un nom de fichier.
  assert.ok(documents.applyFilters(tous, { q: 'free mobile' }).length >= 2);
  assert.ok(documents.applyFilters(tous, { q: '0628000000' }).length >= 1);
});

test('les listes de filtres restent complètes même quand la recherche ne ramène rien', () => {
  const vue = documents.browse(alix, { q: 'introuvable-nulle-part' });

  assert.equal(vue.shown, 0);
  assert.ok(vue.total > 0, 'la destination n\'est pas vide pour autant');
  // Sinon l'utilisateur se retrouve enfermé dans son propre filtre, sans
  // moyen d'en sortir autrement qu'en effaçant à l'aveugle.
  assert.ok(vue.filters.connectors.length >= 2);
  assert.ok(vue.filters.periods.length >= 2);
});

test('les périodes sont proposées de la plus récente à la plus ancienne', () => {
  const periodes = documents.browse(alix, {}).filters.periods;
  assert.deepEqual(periodes, [...periodes].sort().reverse());
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

test('une seule destination active : c\'est elle, sans rien demander', () => {
  const vue = documents.browse(alix, {});
  assert.equal(vue.destination.id, 'local');
  assert.equal(vue.destination.primary, true);
  assert.deepEqual(vue.destinations.map((d) => d.id), ['local']);
});

test('une destination inconnue retombe sur la principale, sans erreur', () => {
  const vue = documents.browse(alix, { destination: 'chez-moi' });
  assert.equal(vue.destination.id, 'local');
});

test('destination injoignable : on le dit, et on propose les autres', () => {
  // Le partage n'est plus monté : le cas réel qu'il faut savoir raconter.
  const absent = path.join(racine, 'jamais-cree');
  destinations.saveConfig('local', { path: absent, protocol: 'local' });

  try {
    const vue = documents.browse(alix, {});

    assert.equal(vue.available, false);
    assert.ok(vue.reason, 'un motif doit être donné');
    // Sans jargon : ni « ENOENT », ni « mount », ni le chemin du serveur.
    assert.equal(/ENOENT|mount|\/tmp|null/i.test(vue.reason), false, vue.reason);
    assert.match(vue.reason, /stockage/);

    // Et surtout : aucune liste vide qui laisserait croire à une perte.
    assert.deepEqual(vue.tree, []);
    assert.equal(vue.total, 0);
    // Les autres destinations restent proposées — ici il n'y en a pas d'autre,
    // mais la liste est renvoyée pour que l'interface puisse le dire.
    assert.ok(Array.isArray(vue.destinations));
  } finally {
    destinations.saveConfig('local', { path: racine, protocol: 'local' });
  }
});

test('un espace non configuré n\'est jamais annoncé comme consultable', () => {
  const etat = documents.destinationAvailability('proton');
  assert.equal(etat.available, false);
  assert.match(etat.reason, /pas configuré/);
});

test('une destination rclone configurée par champs est jugée disponible', () => {
  // Le cas mesuré le 18/08/2026 : pCloud et Proton configurés par FORMULAIRE
  // (`valeurs`), sans bloc rclone collé. Le contrôle de santé — qui normalise
  // la configuration — passait, et « Mes documents » disait « pas configuré » :
  // deux lecteurs de la même configuration, deux critères. Ce test tombe si
  // `destinationAvailability` rejuge sur le champ `rcloneConfig` brut.
  const cloud = destinations.createCloud({ provider: 'pcloud' });
  try {
    destinations.saveConfig(cloud.id, {
      enabled: true,
      valeurs: { token: '{"access_token":"jeton-de-test"}', hostname: 'eapi.pcloud.com' },
    });
    // La configuration enregistrée n'a PAS de bloc brut : il est calculé.
    assert.equal(destinations.readConfig(cloud.id).rcloneConfig, '');

    const etat = documents.destinationAvailability(cloud.id);
    assert.equal(etat.available, true, etat.reason || '');
    assert.equal(etat.reason, null);
  } finally {
    destinations.deleteCloud(cloud.id);
  }
});

test('une configuration illisible dit « impossible de lire », jamais « pas configuré »', async () => {
  const cloud = destinations.createCloud({ provider: 'pcloud' });
  try {
    destinations.saveConfig(cloud.id, { enabled: true, valeurs: { token: 'jeton' } });
    // Une configuration EXISTE mais ne se déchiffre plus (phrase secrète
    // changée) : le repli de `tryDecryptJson` ressemble à « rien du tout », et
    // « pas configuré » inviterait à reconfigurer par-dessus ce qui existe.
    helpers.db
      .get()
      .prepare('UPDATE destinations_config SET config_encrypted = ? WHERE dest_id = ?')
      .run('pas-un-chiffre-lisible', cloud.id);

    const etat = documents.destinationAvailability(cloud.id);
    assert.equal(etat.available, false);
    assert.match(etat.reason, /[Ii]mpossible de lire/);
    assert.doesNotMatch(etat.reason, /pas configuré/);

    // Même règle pour la consultation : le téléchargement le dit pareil.
    const res = await destinations.fetchInvoice(
      cloud.id,
      { connector_id: 'free', filename: 'f.pdf' },
      'alix'
    );
    assert.equal(res.ok, false);
    assert.match(res.message, /[Ii]mpossible de lire/);
  } finally {
    destinations.deleteCloud(cloud.id);
  }
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('un compte ne voit jamais les documents d\'un autre', () => {
  const vueAlix = documents.browse(alix, {});
  const vueBruno = documents.browse(bruno, {});

  const nomsAlix = vueAlix.tree.flatMap((b) =>
    b.accounts.flatMap((c) => c.documents.map((d) => d.filename))
  );
  const nomsBruno = vueBruno.tree.flatMap((b) =>
    b.accounts.flatMap((c) => c.documents.map((d) => d.filename))
  );

  assert.ok(nomsAlix.length && nomsBruno.length);
  for (const nom of nomsBruno) {
    assert.equal(nomsAlix.includes(nom), false, `${nom} ne doit pas fuir d'un compte à l'autre`);
  }
});

// ---------------------------------------------------------------------------
// Les routes
// ---------------------------------------------------------------------------

test('les routes de « Mes documents » sont fermées aux visiteurs', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  for (const url of ['/api/documents', '/api/documents/local/1/file']) {
    const res = await client.get(url);
    assert.equal(res.status, 401, url);
  }
});

test('téléchargement : le sien passe, celui d\'un autre renvoie 404', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  const vue = await client.get('/api/documents');
  assert.equal(vue.status, 200);
  const doc = vue.body.tree
    .flatMap((b) => b.accounts.flatMap((c) => c.documents))
    .find((d) => !d.missing);
  assert.ok(doc, 'il faut au moins un document lisible pour ce test');

  const ok = await client.get(`/api/documents/local/${doc.id}/file`);
  assert.equal(ok.status, 200);

  // Un document de bruno, dont alix connaîtrait l'identifiant.
  const autre = helpers.db
    .get()
    .prepare('SELECT id FROM invoices WHERE user_id = ? LIMIT 1')
    .get(bruno.id);
  const refus = await client.get(`/api/documents/local/${autre.id}/file`);
  assert.equal(refus.status, 404, 'ni 403 ni 500 : on ne confirme pas son existence');
});

test('téléchargement depuis un espace non activé : refusé sans rien révéler', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  const doc = helpers.db
    .get()
    .prepare('SELECT id FROM invoices WHERE user_id = ? LIMIT 1')
    .get(alix.id);

  const res = await client.get(`/api/documents/proton/${doc.id}/file`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /stockage/i);
});
