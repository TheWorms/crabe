'use strict';

/**
 * Profondeur de documents conservée.
 *
 * La règle que ces tests protègent tient en une phrase : **jamais
 * rétroactivement sans confirmation explicite**. Choisir « 6 mois » un mardi
 * soir ne doit pas effacer huit ans de factures dans la nuit — et il n'existe
 * aucune sauvegarde de crabe pour revenir en arrière.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const retention = require('../server/retention');
const destinations = require('../server/destinations');
const db = require('../server/db/db');

test.before(() => helpers.setup());
test.after(() => helpers.teardown());

/**
 * Remet le réglage à « tout garder » et vide l'index entre deux tests.
 *
 * La base est partagée par tout le fichier : sans ce nettoyage, les factures
 * d'un test se feraient compter — et supprimer — par le suivant, et « 2
 * documents purgés » deviendrait « 7 » sans qu'on sache lesquels.
 */
function neutre() {
  db.get()
    .prepare(
      `UPDATE security_policy
          SET document_retention_months = 0, document_retention_floor = NULL WHERE id = 1`
    )
    .run();
  db.get().prepare('DELETE FROM invoices').run();
}

/**
 * Dépose une facture : la ligne d'index ET le fichier sur le stockage local.
 *
 * Le fichier compte : la suppression doit l'emporter, et un test qui ne
 * poserait que la ligne ne verrait jamais échouer l'effacement.
 */
function deposer(user, { filename, issuedOn, fetchedAt = null, connector = 'free' }) {
  const racine = destinations.publicConfig('local')?.path
    || process.env.CRABE_LOCAL_PATH;
  const fichier = path.join(
    racine,
    user.username,
    'Free Internet',
    'compte',
    String(issuedOn).slice(0, 4),
    filename
  );
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, '%PDF-1.4\nfacture de test\n');

  const info = db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, fetched_at, destinations)
       VALUES (?, ?, ?, ?, 'compte', ?, ?, COALESCE(?, datetime('now')), ?)`
    )
    .run(
      user.id,
      connector,
      filename,
      filename,
      fs.statSync(fichier).size,
      issuedOn,
      fetchedAt,
      JSON.stringify({ local: { state: 'ok', ok: true, path: fichier } })
    );

  return { id: info.lastInsertRowid, fichier };
}

/** Une date ISO située il y a `mois` mois. */
function ilYA(mois) {
  const d = new Date();
  d.setMonth(d.getMonth() - mois);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Le réglage
// ---------------------------------------------------------------------------

test('cinq choix, et « tout garder » par défaut', () => {
  neutre();
  assert.deepEqual(
    retention.OPTIONS.map((o) => o.months),
    [3, 6, 12, 24, 0]
  );
  assert.deepEqual(
    retention.OPTIONS.map((o) => o.label),
    ['3 mois', '6 mois', '1 an', '2 ans', 'Tout garder']
  );

  // Une installation qui se met à jour ne doit rien perdre parce que personne
  // n'a encore ouvert l'écran.
  assert.equal(retention.policy().months, 0);
  assert.equal(retention.policy().floor, null);
  assert.deepEqual(retention.purge(), { months: 0, deleted: 0, failed: 0, freedBytes: 0 });
});

test('une profondeur inconnue est refusée, pas arrondie', () => {
  neutre();
  for (const mauvais of [1, 7, 36, -6, 'six mois', null]) {
    assert.throws(() => retention.setMonths(mauvais), /inconnue/);
  }
  assert.equal(retention.policy().months, 0, 'et rien n\'a bougé');
});

// ---------------------------------------------------------------------------
// Jamais rétroactivement
// ---------------------------------------------------------------------------

test('réduire la profondeur pose un plancher : l\'existant est protégé', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'gardienne' });

  // Huit ans de factures, déjà en place.
  const vieilles = [96, 60, 36, 18].map((mois) =>
    deposer(user, { filename: `ancienne-${mois}.pdf`, issuedOn: ilYA(mois) })
  );

  const rendu = retention.setMonths(6);

  assert.equal(rendu.months, 6);
  assert.ok(rendu.floor, 'un plancher est posé');
  assert.equal(rendu.beyond, 4, 'et il annonce ce qu\'il protège');

  // Le nettoyage de la nuit ne doit RIEN emporter.
  const passe = retention.purge();
  assert.equal(passe.deleted, 0);
  for (const { id, fichier } of vieilles) {
    assert.ok(fs.existsSync(fichier), 'le fichier est toujours là');
    assert.ok(db.get().prepare('SELECT 1 FROM invoices WHERE id = ?').get(id), 'et sa ligne aussi');
  }
});

test('la nouveauté, elle, vieillit selon la profondeur retenue', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'vieillissante' });

  // ─── Ce test a changé de sens au lot 26, et c'est le cœur du correctif ─────
  //
  // Il affirmait l'inverse : une facture de 2024 récupérée APRÈS le réglage
  // « relève de la nouvelle profondeur », donc part. C'était vrai du code, et
  // c'est exactement ce qui a effacé 149 documents la nuit du 13/08/2026 sur
  // l'installation réelle — un simple re-passage de synchronisation suffisait à
  // faire d'une vieille facture déjà protégée « un document à venir ».
  //
  // Le critère n'est plus la date de RÉCUPÉRATION mais l'âge du document AU
  // MOMENT DU RÉGLAGE : ce qui était déjà hors fenêtre ce jour-là est « les
  // précédents », et le reste, quel que soit le nombre de fois où on le
  // retélécharge. Ce qui était dedans vieillit et finit par sortir.
  const ancienne = deposer(user, { filename: 'avant-reglage.pdf', issuedOn: ilYA(24) });
  retention.setMonths(6);

  // Le même rattrapage qu'avant : la facture de 2024 revient, avec une date de
  // récupération toute fraîche. Elle ne doit plus rien déclencher.
  const reprise = deposer(user, {
    filename: 'apres-reglage.pdf',
    issuedOn: ilYA(24),
    fetchedAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(retention.purge().deleted, 0, 'une re-synchronisation n\'efface rien');
  assert.ok(fs.existsSync(reprise.fichier), 'la facture retéléchargée reste');
  assert.ok(fs.existsSync(ancienne.fichier), 'celle d\'avant le réglage aussi');

  // Et le vieillissement, lui, marche toujours : un document qui était DANS la
  // fenêtre au moment du réglage en sort avec le temps. Le temps ne se truque
  // pas ici — on demande la même règle avec un plancher posé il y a un an.
  const recente = deposer(user, { filename: 'etait-dedans.pdf', issuedOn: ilYA(8) });
  const ilYAUnAn = new Date();
  ilYAUnAn.setMonth(ilYAUnAn.getMonth() - 12);

  const sortants = retention.expired({ floor: ilYAUnAn.toISOString() });
  assert.deepEqual(
    sortants.map((r) => r.filename),
    ['etait-dedans.pdf'],
    'huit mois, c\'est au-delà de six : ce document-là doit partir, et lui seul'
  );
  assert.ok(recente, 'la ligne a bien été posée');
});

test('la confirmation explicite retire le plancher, et rien d\'autre ne le retire', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'confirmante' });
  const vieilles = [40, 30].map((mois) =>
    deposer(user, { filename: `a-purger-${mois}.pdf`, issuedOn: ilYA(mois) })
  );
  const recente = deposer(user, { filename: 'recente.pdf', issuedOn: ilYA(1) });

  // Sans confirmation : plancher posé, rien ne part.
  retention.setMonths(12);
  assert.equal(retention.purge().deleted, 0);

  // Avec confirmation : le plancher tombe.
  const rendu = retention.setMonths(12, { applyNow: true });
  assert.equal(rendu.floor, null);

  const passe = retention.purge();
  assert.equal(passe.deleted, 2);
  assert.ok(passe.freedBytes > 0, 'et il dit ce que ça libère');
  for (const { fichier } of vieilles) assert.ok(!fs.existsSync(fichier));
  assert.ok(fs.existsSync(recente.fichier), 'ce qui est dans la fenêtre reste');
});

test('« Tout garder » efface le plancher plutôt que d\'en poser un', async () => {
  neutre();
  retention.setMonths(6);
  assert.ok(retention.policy().floor);

  retention.setMonths(0);
  assert.equal(retention.policy().months, 0);
  assert.equal(retention.policy().floor, null, 'un réglage qui n\'efface rien n\'a rien à protéger');
});

// ---------------------------------------------------------------------------
// Ce qui est supprimé, et ce qui ne l'est pas
// ---------------------------------------------------------------------------

test('la date qui compte est celle d\'ÉMISSION, pas celle du dépôt', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'datee' });

  // Un rattrapage de dix années d'impôts fait entrer AUJOURD'HUI des documents
  // de 2017 : les dater du jour les garderait dix ans de trop.
  const vieille = deposer(user, {
    filename: 'avis-2017.pdf',
    issuedOn: ilYA(100),
    fetchedAt: new Date().toISOString(),
  });
  const jeune = deposer(user, { filename: 'facture-du-mois.pdf', issuedOn: ilYA(1) });

  retention.setMonths(12, { applyNow: true });
  retention.purge();

  assert.ok(!fs.existsSync(vieille.fichier), 'émise il y a huit ans : elle part');
  assert.ok(fs.existsSync(jeune.fichier));
});

test('un document sans date d\'émission est jugé sur sa date de dépôt', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'sansdate' });

  // Le dossier `inconnu/` : certains portails ne datent pas leurs documents.
  const info = deposer(user, { filename: 'sans-date.pdf', issuedOn: ilYA(1) });
  db.get()
    .prepare("UPDATE invoices SET issued_on = '', fetched_at = datetime('now', '-40 months') WHERE id = ?")
    .run(info.id);

  retention.setMonths(12, { applyNow: true });
  assert.equal(retention.purge().deleted, 1, 'faute de mieux, la date de dépôt fait foi');
});

test('les dossiers vides sont élagués, jamais au-delà de trois niveaux', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'elagueuse' });
  const { fichier } = deposer(user, { filename: 'seule.pdf', issuedOn: ilYA(50) });

  const annee = path.dirname(fichier);
  const compte = path.dirname(annee);

  retention.setMonths(12, { applyNow: true });
  retention.purge();

  assert.ok(!fs.existsSync(annee), 'le dossier de l\'année part avec son dernier fichier');
  assert.ok(!fs.existsSync(compte), 'et celui du compte fournisseur, devenu vide');
  // Jamais la racine du stockage local, ni le dossier de l'utilisateur au-delà.
  const racine = process.env.CRABE_LOCAL_PATH;
  assert.ok(fs.existsSync(racine), 'la racine du stockage local ne bouge pas');
});

test('un fichier impossible à effacer garde sa ligne d\'index', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'coincee' });
  const { id, fichier } = deposer(user, { filename: 'coincee.pdf', issuedOn: ilYA(50) });

  // Mieux vaut un document toujours listé et toujours là qu'une ligne perdue
  // pointant sur un fichier orphelin, que plus rien ne saurait retrouver.
  const vrai = fs.rmSync;
  fs.rmSync = () => { throw new Error('EACCES'); };
  try {
    retention.setMonths(12, { applyNow: true });
    const passe = retention.purge();
    assert.equal(passe.deleted, 0);
    assert.equal(passe.failed, 1);
  } finally {
    fs.rmSync = vrai;
  }

  assert.ok(db.get().prepare('SELECT 1 FROM invoices WHERE id = ?').get(id));
  assert.ok(fs.existsSync(fichier));
});

// ---------------------------------------------------------------------------
// Les routes
// ---------------------------------------------------------------------------

test('l\'administration lit et écrit la profondeur, sans jamais purger au passage', async () => {
  neutre();
  const admin = await helpers.createUser({ username: 'chef-retention', role: 'admin' });
  const cible = await helpers.createUser({ username: 'proprietaire' });
  const ancienne = deposer(cible, { filename: 'vieille-route.pdf', issuedOn: ilYA(40) });

  const client = await helpers.startServer();
  try {
    await helpers.login(client, 'chef-retention', 'MotDePasse1');

    const avant = await client.get('/api/system/security');
    assert.equal(avant.status, 200);
    assert.equal(avant.body.documentRetention.months, 0);
    assert.equal(avant.body.documentRetention.options.length, 5);

    // Un enregistrement ordinaire ne supprime RIEN, tout de suite ou plus tard.
    const pose = await client.put('/api/system/security', { documentRetentionMonths: 6 });
    assert.equal(pose.status, 200);
    assert.ok(fs.existsSync(ancienne.fichier));

    const apres = await client.get('/api/system/security');
    assert.equal(apres.body.documentRetention.months, 6);
    assert.ok(apres.body.documentRetention.floor, 'le plancher est annoncé au front');
    assert.equal(apres.body.documentRetention.beyond, 1, 'ainsi que ce qu\'il protège');
    assert.equal(apres.body.documentRetention.due, 0, 'et ce que la nuit emportera : rien');

    // La confirmation explicite est une valeur à part, jamais déduite.
    await client.put('/api/system/security', {
      documentRetentionMonths: 6,
      applyRetentionNow: true,
    });
    const arme = await client.get('/api/system/security');
    assert.equal(arme.body.documentRetention.floor, null);
    assert.equal(arme.body.documentRetention.due, 1);
    assert.ok(fs.existsSync(ancienne.fichier), 'l\'écriture du réglage ne purge toujours pas');

    // Le journal d'administration garde la trace du geste.
    const journal = await client.get('/api/admin/logs/app');
    assert.ok(
      journal.body.logs.some((l) => /Conservation des documents/.test(l.message)),
      'le changement de politique est consigné'
    );
  } finally {
    await client.close();
  }

  assert.ok(admin.id);
});

test('la profondeur n\'est pas réglable sans le droit de configurer la sécurité', async () => {
  neutre();
  await helpers.createUser({ username: 'simple-compte' });
  const client = await helpers.startServer();

  try {
    await helpers.login(client, 'simple-compte', 'MotDePasse1');
    const refus = await client.put('/api/system/security', { documentRetentionMonths: 3 });
    assert.equal(refus.status, 403);
    assert.equal(retention.policy().months, 0);
  } finally {
    await client.close();
  }
});
