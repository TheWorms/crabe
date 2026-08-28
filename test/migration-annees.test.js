'use strict';

/**
 * Migration des documents déjà déposés vers l'arborescence par année (lot 10).
 *
 * L'arborescence factice reproduit exactement ce que la production contient au
 * 10/08/2026 : des factures Free Internet à plat dans `fbx22222222/`, des
 * documents déjà rangés sous leur année, et un fichier dont l'année n'est pas
 * déterminable.
 *
 * Ce qui est vérifié ici, et qui ne doit jamais régresser :
 *
 *   - le fichier est DÉPLACÉ, jamais copié — le compte de fichiers ne bouge pas ;
 *   - le chemin enregistré dans `invoices` suit le fichier, sinon crabe croirait
 *     le document disparu et le retéléchargerait ;
 *   - rejouer la migration ne fait rien de plus (idempotence) ;
 *   - une année indéterminable va dans `inconnu/`, jamais à la racine du compte ;
 *   - destination injoignable : rien n'est déplacé, rien n'est marqué.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const migration = require('../server/destinations/migration-annees');
const destinations = require('../server/destinations');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

/** Répertoire jetable, nettoyé à la fin du fichier. */
function tempDir(prefix = 'crabe-migr-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ecrire(fichier, contenu = 'PDF') {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, contenu);
  return fichier;
}

/** Tous les fichiers sous une racine, chemins relatifs, triés. */
function arborescence(racine) {
  const sortie = [];
  const descendre = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) descendre(complet);
      else sortie.push(path.relative(racine, complet));
    }
  };
  descendre(racine);
  return sortie.sort();
}

/** Insère une facture en base, avec le chemin du stockage local qu'elle porte vraiment. */
function inscrire(userId, { connectorId, accountId, filename, issuedOn, chemin }) {
  return helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices
         (user_id, connector_id, filename, remote_id, account_id, size_bytes, issued_on, destinations)
       VALUES (?, ?, ?, ?, ?, 4, ?, ?)`
    )
    .run(
      userId,
      connectorId,
      filename,
      `${connectorId}-${filename}`,
      accountId,
      issuedOn || null,
      JSON.stringify({ local: { state: 'ok', ok: true, at: '2026-08-01T00:00:00Z', path: chemin } })
    ).lastInsertRowid;
}

function cheminEnBase(invoiceId) {
  const row = helpers.db.get().prepare('SELECT destinations FROM invoices WHERE id = ?').get(invoiceId);
  return JSON.parse(row.destinations).local.path;
}

// ---------------------------------------------------------------------------
// Le cas de la production
// ---------------------------------------------------------------------------

test('les factures à plat rejoignent leur année, base et fichiers d\'un même geste', async () => {
  const racine = tempDir();
  const user = await helpers.createUser({ username: 'migr' });

  // Trois factures Free Internet à plat, comme en production.
  const aPlat = ['2026-08_1111111111.pdf', '2026-07_1494758522.pdf', '2025-12_1494758400.pdf'];
  const ids = aPlat.map((nom) => {
    const chemin = ecrire(path.join(racine, 'migr', 'Free Internet', 'fbx22222222', nom));
    return inscrire(user.id, {
      connectorId: 'free',
      accountId: 'fbx22222222',
      filename: nom,
      issuedOn: `${nom.slice(0, 7)}-01`,
      chemin,
    });
  });

  // Une facture DÉJÀ rangée : elle ne doit pas bouger.
  const dejaRangee = ecrire(
    path.join(racine, 'migr', 'Free Internet', 'fbx22222222', '2025', '2025-11_1494758300.pdf')
  );
  const idRangee = inscrire(user.id, {
    connectorId: 'free',
    accountId: 'fbx22222222',
    filename: '2025-11_1494758300.pdf',
    issuedOn: '2025-11-01',
    chemin: dejaRangee,
  });

  // Un document dont l'année n'est pas déterminable.
  const sansAnnee = ecrire(path.join(racine, 'migr', 'Amazon', 'compte', 'facture-sans-date.pdf'));
  const idSansAnnee = inscrire(user.id, {
    connectorId: 'amazon',
    accountId: 'compte',
    filename: 'facture-sans-date.pdf',
    issuedOn: null,
    chemin: sansAnnee,
  });

  const avant = arborescence(racine);
  const bilan = migration.migrer({ root: racine, force: true });

  assert.equal(bilan.ok, true, bilan.message);
  assert.equal(bilan.failed, 0);
  assert.equal(bilan.moved, 4, '3 factures à plat + le document sans année');
  assert.equal(bilan.skipped, 1, 'la facture déjà rangée est ignorée');

  // Déplacement, jamais copie : autant de fichiers avant qu'après.
  const apres = arborescence(racine);
  assert.equal(apres.length, avant.length, 'aucun doublon, aucune perte');

  assert.deepEqual(apres, [
    path.join('migr', 'Amazon', 'compte', 'inconnu', 'facture-sans-date.pdf'),
    path.join('migr', 'Free Internet', 'fbx22222222', '2025', '2025-11_1494758300.pdf'),
    path.join('migr', 'Free Internet', 'fbx22222222', '2025', '2025-12_1494758400.pdf'),
    path.join('migr', 'Free Internet', 'fbx22222222', '2026', '2026-07_1494758522.pdf'),
    path.join('migr', 'Free Internet', 'fbx22222222', '2026', '2026-08_1111111111.pdf'),
  ].sort());

  // La base suit : sans cela, crabe croirait les documents disparus.
  for (const id of ids) {
    const chemin = cheminEnBase(id);
    assert.equal(fs.existsSync(chemin), true, `chemin en base introuvable : ${chemin}`);
    assert.match(path.basename(path.dirname(chemin)), /^(19|20)\d{2}$/);
  }
  assert.equal(cheminEnBase(idRangee), dejaRangee, 'la facture déjà rangée garde son chemin');
  assert.equal(path.basename(path.dirname(cheminEnBase(idSansAnnee))), 'inconnu');
});

test('rejouer la migration ne déplace plus rien', () => {
  const racine = tempDir();
  ecrire(path.join(racine, 'u', 'Free Internet', 'fbx1', '2026-08_a.pdf'));

  const premier = migration.migrer({ root: racine, force: true });
  assert.equal(premier.moved, 1);

  const second = migration.migrer({ root: racine, force: true });
  assert.equal(second.moved, 0, 'rien ne bouge une seconde fois');
  assert.equal(second.failed, 0);
  assert.equal(
    fs.existsSync(path.join(racine, 'u', 'Free Internet', 'fbx1', '2026', '2026-08_a.pdf')),
    true
  );
});

test('un fichier sans ligne en base est rangé lui aussi', () => {
  const racine = tempDir();
  ecrire(path.join(racine, 'inconnu-en-base', 'EDF', 'client', '2024-03_x.pdf'));

  const bilan = migration.migrer({ root: racine, force: true });
  assert.equal(bilan.orphans, 1);
  assert.equal(
    fs.existsSync(path.join(racine, 'inconnu-en-base', 'EDF', 'client', '2024', '2024-03_x.pdf')),
    true
  );
});

test('un fichier déjà sous son année n\'est jamais redéplacé', () => {
  const racine = tempDir();
  const range = ecrire(path.join(racine, 'u', 'EDF', 'client', '2024', '2024-03_x.pdf'));

  const bilan = migration.migrer({ root: racine, force: true });
  assert.equal(bilan.moved, 0);
  assert.equal(fs.existsSync(range), true);
});

// ---------------------------------------------------------------------------
// Destination injoignable
// ---------------------------------------------------------------------------

test('destination injoignable : rien n\'est déplacé et rien n\'est marqué', () => {
  const absente = path.join(tempDir(), 'partage-non-monte');

  const bilan = migration.migrer({ root: absente, force: true });
  assert.equal(bilan.ok, false);
  assert.equal(bilan.ran, false);
  assert.equal(bilan.moved, 0);
  assert.match(bilan.message, /rien n'a été déplacé/);
  assert.match(bilan.message, /prochain démarrage/);
});

test('la marque en base empêche une seconde exécution inutile', () => {
  const racine = tempDir();
  ecrire(path.join(racine, 'u', 'EDF', 'client', '2024-03_x.pdf'));

  migration.marquer({ moved: 7, skipped: 2, failed: 0, orphans: 0 });
  assert.equal(migration.estFaite(), true);

  const bilan = migration.migrer({ root: racine });
  assert.equal(bilan.ran, false);
  assert.equal(bilan.message, 'déjà faite');
  // Le fichier est resté à plat : la migration ne l'a même pas regardé.
  assert.equal(fs.existsSync(path.join(racine, 'u', 'EDF', 'client', '2024-03_x.pdf')), true);
});

// ---------------------------------------------------------------------------
// Téléchargement pendant l'intervalle
// ---------------------------------------------------------------------------

test('un document pas encore migré reste téléchargeable', async () => {
  const racine = destinations.readConfig('local').path;
  const user = await helpers.createUser({ username: 'intervalle' });

  // Déposé à l'ancienne, sans année, et la base ne porte aucun chemin.
  const ancien = ecrire(path.join(racine, 'intervalle', 'EDF', 'client', '2023-05_vieux.pdf'));
  helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, account_id, issued_on, destinations)
       VALUES (?, 'edf', '2023-05_vieux.pdf', 'client', '2023-05-01', '{}')`
    )
    .run(user.id);

  const invoice = helpers.db
    .get()
    .prepare('SELECT * FROM invoices WHERE user_id = ?')
    .get(user.id);

  assert.equal(
    destinations.invoicePath(invoice, 'intervalle'),
    ancien,
    'le chemin d\'avant le lot 10 est retrouvé tant que le fichier y est'
  );
});
