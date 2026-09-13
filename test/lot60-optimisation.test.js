'use strict';

/**
 * Lot 60 — l'écran Optimisation : crabe entretient ses réserves.
 *
 * Les preuves qui coûtent cher si elles manquent :
 *
 *   - le nettoyage du cache ne touche JAMAIS un cookie, un stockage local ou
 *     un jeton anti-robot — liste blanche, pas liste noire ;
 *   - un profil vivant (Chromium ouvert) ou occupé (verrou inflight) n'est
 *     pas touché ;
 *   - un profil récemment actif n'est pas supprimé ; un désinstallé l'est,
 *     et le motif est distinct de l'endormi ;
 *   - une sauvegarde n'est JAMAIS supprimée sans geste explicite — même le
 *     volet en automatique ne fait que le point ;
 *   - coquilles cloud et traces d'échec se nettoient ENSEMBLE, et une
 *     coquille encore nommée par une copie réussie reste ;
 *   - le filet au seuil ne fait que le nettoyage sûr (cache), et le dit ;
 *   - tout naît en manuel : l'entretien quotidien ne lance rien tant que
 *     l'administrateur n'a pas choisi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const optimisation = require('../server/optimisation');
const profilPersistant = require('../server/connectors/profil-persistant');
const inflight = require('../server/connectors/inflight');
const operations = require('../server/operations');
const catalogue = require('../server/destinations/catalogue');

let admin;
let simple;

/** Un profil de navigateur plausible : cache reconstructible ET session. */
function creerProfil(userId, connectorId) {
  const dossier = profilPersistant.chemin(userId, connectorId);
  fs.mkdirSync(path.join(dossier, 'Default', 'Code Cache'), { recursive: true });
  fs.mkdirSync(path.join(dossier, 'Default', 'Cache'), { recursive: true });
  fs.mkdirSync(path.join(dossier, 'Default', 'Local Storage'), { recursive: true });
  fs.mkdirSync(path.join(dossier, 'GPUPersistentCache'), { recursive: true });
  fs.writeFileSync(path.join(dossier, 'Default', 'Code Cache', 'bloc.bin'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dossier, 'Default', 'Cache', 'entree.bin'), Buffer.alloc(1024, 1));
  // Ce qui vaut cher : cookies, stockage local, jeton anti-robot, sessions.
  fs.writeFileSync(path.join(dossier, 'Default', 'Cookies'), 'datadome=precieux; cf_clearance=irremplacable');
  fs.writeFileSync(path.join(dossier, 'Default', 'Local Storage', 'site.ldb'), 'session-marchande');
  fs.writeFileSync(path.join(dossier, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(dossier, 'BrowserMetrics-spare.pma'), Buffer.alloc(512, 1));
  return dossier;
}

function installer(userId, connectorId, { installedAt = null } = {}) {
  helpers.db.get()
    .prepare(
      `INSERT OR IGNORE INTO connector_installs (user_id, connector_id, status, installed_at)
       VALUES (?, ?, 'installed', COALESCE(?, datetime('now')))`
    )
    .run(userId, connectorId, installedAt);
}

function derniereReussite(userId, connectorId, quandSql) {
  helpers.db.get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message)
       VALUES (?, ?, ?, ?, 1, 'cron', 'ok')`
    )
    .run(connectorId, userId, quandSql, quandSql);
}

/** Remplace une fonction le temps d'un test, puis la remet. */
function patch(t, module_, prop, valeur) {
  const original = module_[prop];
  module_[prop] = valeur;
  t.after(() => {
    module_[prop] = original;
  });
}

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({ username: 'optimisation', plainPassword: 'MotDePasse1', role: 'admin' });
  simple = await helpers.createUser({ username: 'optimisation-bis', plainPassword: 'MotDePasse1' });
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

test('tout naît en manuel : aucun volet automatique, récurrence sans effet', () => {
  const vue = optimisation.reglages();
  for (const volet of optimisation.VOLETS) {
    assert.equal(vue[volet].mode, 'manuel', `${volet} doit naître en manuel`);
    assert.equal(vue[volet].dernierPassage, null);
  }
});

test('un réglage hors des choix proposés est refusé', () => {
  assert.throws(() => optimisation.reglerVolet('cache', { mode: 'furtif', recurrenceMois: 6 }), /Mode inconnu/);
  assert.throws(() => optimisation.reglerVolet('cache', { mode: 'manuel', recurrenceMois: 2 }), /Récurrence inconnue/);
  assert.throws(() => optimisation.reglerVolet('disque', { mode: 'manuel', recurrenceMois: 6 }), /Volet inconnu/);

  const regle = optimisation.reglerVolet('cache', { mode: 'automatique', recurrenceMois: 3 });
  assert.equal(regle.mode, 'automatique');
  assert.equal(regle.recurrenceMois, 3);
  optimisation.reglerVolet('cache', { mode: 'manuel', recurrenceMois: 6 });
});

// ---------------------------------------------------------------------------
// Volet cache : la liste blanche, et rien d'autre
// ---------------------------------------------------------------------------

test('le nettoyage du cache ne touche ni cookies, ni stockage local, ni jeton anti-robot', () => {
  const dossier = creerProfil(admin.id, 'marchand-cache');
  installer(admin.id, 'marchand-cache');
  derniereReussite(admin.id, 'marchand-cache', new Date().toISOString());

  const mesure = optimisation.mesurer();
  const duProfil = mesure.cache.profils.find((p) => p.connectorId === 'marchand-cache');
  assert.ok(duProfil.octets >= 2048 + 1024, 'la mesure compte le cache réel');

  const resultat = optimisation.lancer('cache');
  assert.equal(resultat.echec, false);

  // Le cache est parti…
  assert.equal(fs.existsSync(path.join(dossier, 'Default', 'Code Cache')), false);
  assert.equal(fs.existsSync(path.join(dossier, 'Default', 'Cache')), false);
  assert.equal(fs.existsSync(path.join(dossier, 'GPUPersistentCache')), false);
  assert.equal(fs.existsSync(path.join(dossier, 'BrowserMetrics-spare.pma')), false);
  // …et TOUT ce qui porte une session est intact, au contenu près.
  assert.equal(
    fs.readFileSync(path.join(dossier, 'Default', 'Cookies'), 'utf8'),
    'datadome=precieux; cf_clearance=irremplacable',
    'les cookies et jetons anti-robot ne sont JAMAIS touchés'
  );
  assert.equal(fs.readFileSync(path.join(dossier, 'Default', 'Local Storage', 'site.ldb'), 'utf8'), 'session-marchande');
  assert.ok(fs.existsSync(path.join(dossier, 'Default', 'Preferences')));
});

test('un profil dont un navigateur vit n\'est pas touché, et l\'empêchement est dit', (t) => {
  const dossier = creerProfil(admin.id, 'marchand-vivant');
  installer(admin.id, 'marchand-vivant');

  const original = profilPersistant.navigateurVivant;
  patch(t, profilPersistant, 'navigateurVivant', (d) => (d === dossier ? true : original(d)));

  const resultat = optimisation.lancer('cache');
  assert.ok(fs.existsSync(path.join(dossier, 'Default', 'Code Cache')), 'le cache du profil vivant reste');
  assert.match(resultat.message, /marchand-vivant \(navigateur ouvert\)/, 'l\'empêchement est écrit');
});

test('un profil occupé par une opération (verrou inflight) n\'est pas touché', async () => {
  const dossier = creerProfil(admin.id, 'marchand-occupe');
  installer(admin.id, 'marchand-occupe');

  let liberer;
  const occupation = new Promise((resolve) => { liberer = resolve; });
  const enCours = inflight.profil.run(
    inflight.profilKey(admin.id, 'marchand-occupe'),
    () => occupation,
    'test',
    inflight.PORTEUR_RECUPERATION
  );

  const resultat = optimisation.lancer('cache');
  assert.ok(fs.existsSync(path.join(dossier, 'Default', 'Code Cache')), 'le cache du profil occupé reste');
  assert.match(resultat.message, /marchand-occupe \(opération en cours\)/);

  liberer();
  await enCours;
});

// ---------------------------------------------------------------------------
// Volet profils : des faits datés, jamais une intuition
// ---------------------------------------------------------------------------

test('un profil récemment actif n\'est jamais supprimé ; désinstallé et endormi le sont, chacun son motif', () => {
  const actif = creerProfil(admin.id, 'marchand-actif');
  installer(admin.id, 'marchand-actif');
  derniereReussite(admin.id, 'marchand-actif', new Date().toISOString());

  const endormi = creerProfil(admin.id, 'marchand-endormi');
  installer(admin.id, 'marchand-endormi', { installedAt: '2024-01-05 10:00:00' });
  derniereReussite(admin.id, 'marchand-endormi', '2024-06-01 10:00:00');

  const orphelin = creerProfil(admin.id, 'marchand-desinstalle'); // aucune ligne d'installation

  const mesure = optimisation.mesurer();
  const candidats = new Map(mesure.profils.candidats.map((p) => [p.connectorId, p]));
  assert.equal(candidats.has('marchand-actif'), false, 'un profil actif n\'est pas candidat');
  assert.match(candidats.get('marchand-endormi').motif, /aucune activité depuis plus de 12 mois/);
  assert.equal(candidats.get('marchand-desinstalle').motif, 'connecteur désinstallé', 'le cas désinstallé est distinct');

  const resultat = optimisation.lancer('profils');
  assert.ok(fs.existsSync(actif), 'le profil actif est toujours là');
  assert.equal(fs.existsSync(endormi), false, 'le profil endormi de plus de 12 mois est parti');
  assert.equal(fs.existsSync(orphelin), false, 'le profil du connecteur désinstallé est parti');
  assert.match(resultat.message, /2 profil\(s\) supprimé\(s\)/);

  // Chaque suppression est journalisée, avec poids et sommeil.
  const lignes = helpers.db.get()
    .prepare("SELECT message FROM app_logs WHERE source = 'optimisation' AND message LIKE 'Profil %'")
    .all()
    .map((l) => l.message);
  assert.ok(lignes.some((m) => /marchand-endormi.*endormi depuis \d+ jour/.test(m)));
  assert.ok(lignes.some((m) => /marchand-desinstalle.*connecteur désinstallé/.test(m)));
});

test('un chemin qui sort de sa racine est refusé, jamais corrigé', () => {
  assert.throws(
    () => optimisation.supprimerSous(profilPersistant.racine(), '/etc/passwd'),
    /hors de la racine attendue/
  );
});

// ---------------------------------------------------------------------------
// Volet cloud : coquilles et traces, ensemble ou pas du tout
// ---------------------------------------------------------------------------

test('coquilles et traces se nettoient ensemble — et une copie réussie protège sa coquille', () => {
  const db = helpers.db.get();
  const insererConfig = db.prepare(
    `INSERT INTO destinations_config (dest_id, provider, display_name, enabled, deleted_at)
     VALUES (?, ?, ?, 0, datetime('now'))`
  );
  insererConfig.run('cloud-mort-echecs', 'pcloud', 'pCloud de Camille');
  insererConfig.run('cloud-mort-copie', 'proton', 'Proton de Camille');
  catalogue.oublier();

  const insererFacture = db.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, size_bytes, destinations, fetched_at)
     VALUES (?, 'free', ?, 100, ?, datetime('now'))`
  );
  const avecEchec = insererFacture.run(
    admin.id, 'trace-echec.pdf',
    JSON.stringify({ local: { ok: true }, 'cloud-mort-echecs': { ok: false, message: 'refusé' } })
  ).lastInsertRowid;
  const avecCopie = insererFacture.run(
    admin.id, 'trace-copie.pdf',
    JSON.stringify({ local: { ok: true }, 'cloud-mort-copie': { ok: true } })
  ).lastInsertRowid;

  // Avant : la coquille nomme la pastille (c'est le piège mesuré au lot 60).
  assert.equal(catalogue.style('cloud-mort-echecs').name, 'pCloud de Camille');

  const resultat = optimisation.lancer('cloud');
  assert.match(resultat.message, /1 configuration\(s\) supprimée\(s\) et 1 trace\(s\)/);

  // La trace d'échec et sa coquille sont parties ENSEMBLE : plus rien ne
  // demande son nom, l'écran n'affiche donc jamais d'identifiant nu.
  const apresEchec = JSON.parse(db.prepare('SELECT destinations FROM invoices WHERE id = ?').get(avecEchec).destinations);
  assert.equal('cloud-mort-echecs' in apresEchec, false, 'la trace d\'échec est retirée');
  assert.equal(apresEchec.local.ok, true, 'les autres traces sont intactes');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM destinations_config WHERE dest_id = ?').get('cloud-mort-echecs').n,
    0,
    'la coquille que plus rien ne référence est supprimée'
  );

  // La copie RÉUSSIE, elle, protège sa coquille : le fichier déposé chez le
  // tiers est bien réel, sa pastille garde son nom.
  const apresCopie = JSON.parse(db.prepare('SELECT destinations FROM invoices WHERE id = ?').get(avecCopie).destinations);
  assert.equal(apresCopie['cloud-mort-copie'].ok, true, 'la trace de copie réussie reste');
  assert.equal(catalogue.style('cloud-mort-copie').name, 'Proton de Camille', 'et sa coquille la nomme toujours');

  db.prepare('DELETE FROM invoices WHERE id IN (?, ?)').run(avecEchec, avecCopie);
});

// ---------------------------------------------------------------------------
// Volet sauvegardes : liste, demande, et jamais seul
// ---------------------------------------------------------------------------

test('le volet sauvegardes ne supprime JAMAIS rien seul — même lancé, même en automatique', () => {
  const chemin = path.join(helpers.dataDir, 'crabe.db.avant-essai-20260801-101010');
  fs.writeFileSync(chemin, Buffer.alloc(4096, 1));
  fs.writeFileSync(`${chemin}-wal`, Buffer.alloc(128, 1));

  optimisation.reglerVolet('sauvegardes', { mode: 'automatique', recurrenceMois: 1 });
  const resultat = optimisation.lancer('sauvegardes');
  optimisation.reglerVolet('sauvegardes', { mode: 'manuel', recurrenceMois: 6 });

  assert.ok(fs.existsSync(chemin), 'la sauvegarde est toujours là');
  assert.ok(fs.existsSync(`${chemin}-wal`), 'son annexe aussi');
  assert.match(resultat.message, /rien n'est supprimé sans votre accord/i);
});

test('la suppression de sauvegardes est un geste explicite, tout ou rien', () => {
  const cible = path.join(helpers.dataDir, 'crabe.db.avant-essai-20260801-101010');
  assert.ok(fs.existsSync(cible), 'préalable : la sauvegarde du test précédent existe');

  // Un nom inconnu fait tout échouer : rien n'est supprimé.
  assert.throws(
    () => optimisation.supprimerSauvegardes(['crabe.db.avant-essai-20260801-101010', 'intruse.db']),
    /Sauvegarde inconnue.*Rien n'a été supprimé/
  );
  assert.ok(fs.existsSync(cible), 'le refus n\'a rien supprimé');

  const resultat = optimisation.supprimerSauvegardes(['crabe.db.avant-essai-20260801-101010']);
  assert.equal(resultat.supprimees, 1);
  assert.equal(fs.existsSync(cible), false, 'la sauvegarde nommée est partie');
  assert.equal(fs.existsSync(`${cible}-wal`), false, 'avec son annexe');
});

test('à la création, seules les dernières sauvegardes d\'un même motif restent', () => {
  const dossier = path.join(helpers.dataDir, 'sauvegardes');
  fs.mkdirSync(dossier, { recursive: true });
  const noms = [
    'crabe.db.avant-harmonisation-20260801-090000',
    'crabe.db.avant-harmonisation-20260802-090000',
    'crabe.db.avant-harmonisation-20260803-090000',
    'crabe.db.avant-harmonisation-20260804-090000',
    'crabe.db.avant-harmonisation-20260805-090000',
  ];
  for (const nom of noms) fs.writeFileSync(path.join(helpers.dataDir, nom), Buffer.alloc(256, 1));
  const autreMotif = path.join(dossier, 'crabe-avant-purge-doublons-20260701-080000.db');
  fs.writeFileSync(autreMotif, Buffer.alloc(256, 1));

  const bilan = optimisation.limiterSauvegardes('harmonisation');
  assert.equal(bilan.supprimees, 2, 'les deux plus anciennes du motif partent');
  assert.equal(fs.existsSync(path.join(helpers.dataDir, noms[0])), false);
  assert.equal(fs.existsSync(path.join(helpers.dataDir, noms[1])), false);
  for (const nom of noms.slice(2)) {
    assert.ok(fs.existsSync(path.join(helpers.dataDir, nom)), `${nom} est gardée`);
  }
  assert.ok(fs.existsSync(autreMotif), 'un autre motif n\'est pas touché');

  for (const nom of noms.slice(2)) fs.rmSync(path.join(helpers.dataDir, nom));
  fs.rmSync(autreMotif);
});

// ---------------------------------------------------------------------------
// L'entretien quotidien : récurrences et filet
// ---------------------------------------------------------------------------

test('en manuel, l\'entretien quotidien ne lance rien', (t) => {
  patch(t, optimisation, 'espaceLibreDonnees', () => ({ libre: 8 * 1024 ** 3, total: 12 * 1024 ** 3 }));
  const bilan = optimisation.entretienQuotidien();
  assert.equal(bilan.filet, false);
  assert.deepEqual(bilan.lances, [], 'tout est en manuel : rien ne part');
});

test('en automatique, un volet dont la récurrence est échue part — et pas avant', (t) => {
  patch(t, optimisation, 'espaceLibreDonnees', () => ({ libre: 8 * 1024 ** 3, total: 12 * 1024 ** 3 }));
  optimisation.reglerVolet('cache', { mode: 'automatique', recurrenceMois: 1 });
  t.after(() => optimisation.reglerVolet('cache', { mode: 'manuel', recurrenceMois: 6 }));

  // Jamais passé : le premier passage est dû.
  helpers.db.get().prepare("UPDATE optimisation_reglages SET dernier_passage = NULL WHERE volet = 'cache'").run();
  assert.deepEqual(optimisation.entretienQuotidien().lances, ['cache']);

  // Passé à l'instant : le suivant attendra la récurrence.
  assert.deepEqual(optimisation.entretienQuotidien().lances, []);

  // Passé il y a quarante jours pour une récurrence d'un mois : dû à nouveau.
  helpers.db.get()
    .prepare("UPDATE optimisation_reglages SET dernier_passage = datetime('now', '-40 days') WHERE volet = 'cache'")
    .run();
  assert.deepEqual(optimisation.entretienQuotidien().lances, ['cache']);
});

test('le filet au seuil : cache seul, même tout en manuel, et il le dit au journal', (t) => {
  const dossier = creerProfil(admin.id, 'marchand-filet');
  installer(admin.id, 'marchand-filet');
  derniereReussite(admin.id, 'marchand-filet', new Date().toISOString());

  patch(t, optimisation, 'espaceLibreDonnees', () => ({ libre: 200 * 1024 * 1024, total: 12 * 1024 ** 3 }));
  const bilan = optimisation.entretienQuotidien();

  assert.equal(bilan.filet, true);
  assert.equal(fs.existsSync(path.join(dossier, 'Default', 'Code Cache')), false, 'le cache est parti');
  assert.equal(
    fs.readFileSync(path.join(dossier, 'Default', 'Cookies'), 'utf8'),
    'datadome=precieux; cf_clearance=irremplacable',
    'le filet ne fait que le nettoyage SÛR : les sessions restent'
  );
  assert.ok(fs.existsSync(dossier), 'le filet ne supprime aucun profil');

  const journal = helpers.db.get()
    .prepare("SELECT message FROM app_logs WHERE source = 'optimisation' AND message LIKE '%sous le seuil%' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(journal, 'le filet s\'écrit au journal');
  assert.match(journal.message, /nettoyage sûr du cache/);
});

// ---------------------------------------------------------------------------
// Le bandeau (lot 59) et la route
// ---------------------------------------------------------------------------

test('l\'optimisation s\'annonce au bandeau — aux seuls comptes qui voient l\'écran', () => {
  optimisation.lancer('cache');

  const opAdmin = operations.operationsPour(admin).find((o) => o.type === 'optimisation');
  assert.ok(opAdmin, 'l\'administrateur voit la fin récente');
  assert.equal(opAdmin.etat, 'succes');
  assert.equal(opAdmin.ecran, 'admin-optimisation');

  const opSimple = operations.operationsPour(simple).find((o) => o.type === 'optimisation');
  assert.equal(opSimple, undefined, 'un compte sans storage.manage ne voit rien');
});

test('un nettoyage refuse de partir pendant un renommage — et réciproquement l\'état le dit', (t) => {
  const harmonisation = require('../server/harmonisation');
  patch(t, harmonisation, 'isRunning', () => true);
  assert.throws(() => optimisation.lancer('cache'), /renommage des documents est en cours/);
});

test('la route : photographie pour storage.manage, 403 sans, et réglage qui ne lance rien', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'optimisation-bis', 'MotDePasse1');
  const refus = await client.get('/api/admin/optimisation');
  assert.equal(refus.status, 403, 'sans permission, l\'écran n\'existe pas');

  const clientAdmin = await helpers.startServer();
  t.after(() => clientAdmin.close());
  await helpers.login(clientAdmin, 'optimisation', 'MotDePasse1');

  const res = await clientAdmin.get('/api/admin/optimisation');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.volets, ['globale', 'cache', 'profils', 'cloud', 'sauvegardes']);
  assert.ok(res.body.mesures.cache, 'la mesure du cache est là');
  assert.ok(Array.isArray(res.body.mesures.sauvegardes.fichiers));
  assert.equal(res.body.reglages.profils.mode, 'manuel');

  const avant = optimisation.reglages().profils.dernierPassage;
  const regle = await clientAdmin.put('/api/admin/optimisation/volets/profils', {
    mode: 'automatique',
    recurrenceMois: 12,
  });
  assert.equal(regle.status, 200);
  assert.equal(optimisation.reglages().profils.mode, 'automatique');
  assert.equal(optimisation.reglages().profils.dernierPassage, avant, 'régler ne lance rien');
  await clientAdmin.put('/api/admin/optimisation/volets/profils', { mode: 'manuel', recurrenceMois: 12 });
});
