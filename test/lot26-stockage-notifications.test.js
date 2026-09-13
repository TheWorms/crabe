'use strict';

/**
 * Phase C du lot 26 — le stockage se supprime, et l'échec se dit.
 *
 * Trois promesses, et une seule d'entre elles est facile à tenir :
 *
 *   1. **un espace de stockage se supprime, tous sans exception.** le stockage local
 *      était refusé au motif d'être « le stockage principal » — ce qui
 *      confondait « copie de référence » et « imposé à qui n'en veut pas » ;
 *   2. **sans aucune destination, plus rien n'est récupéré.** Ce n'est pas une
 *      dégradation acceptable : télécharger des factures pour les jeter
 *      solliciterait le site d'un fournisseur, rejouerait une session, et
 *      annoncerait « 12 factures récupérées » alors qu'il n'y a rien nulle
 *      part ;
 *   3. **un échec planifié prévient une fois, pas dix.** Les planifications
 *      tombent en grappe et la cause la plus fréquente leur est commune : une
 *      panne de réseau de trois minutes envoyait dix courriels identiques, ce
 *      qui est le meilleur moyen de faire ignorer le seul qui comptait.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const notifications = require('../server/notifications');
const preferences = require('../server/preferences');
const scheduler = require('../server/scheduler');
const registry = require('../server/connectors/registry');
const db = require('../server/db/db');

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'phase-c', role: 'admin' });
  registry.load();
  registry.syncCatalog();
});

test.after(() => {
  notifications.stop();
  helpers.teardown();
});

/** Remet un stockage actif entre deux tests : la base est partagée. */
function stockageEnService() {
  destinations.restoreLocal();
}

/**
 * Atteint l'état « plus aucun stockage » SANS le geste qui y menait : depuis
 * le lot 38, retirer ou éteindre la dernière destination active est refusé.
 * L'état, lui, reste représentable (base écrite par une version antérieure,
 * panne partielle) — et c'est lui que l'alerte et le blocage ci-dessous
 * doivent continuer de raconter.
 */
function plusAucunStockage() {
  db.get()
    .prepare(
      `UPDATE destinations_config
          SET enabled = 0, deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE dest_id = 'local'`
    )
    .run();
  destinations.oublierPilotes();
}

// ---------------------------------------------------------------------------
// 1. La suppression d'une destination
// ---------------------------------------------------------------------------

test('un cloud se supprime, et ses documents déjà copiés gardent son nom', () => {
  stockageEnService();
  const cloud = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud perso' });

  const supprime = destinations.deleteCloud(cloud.id);
  assert.equal(supprime.name, 'pCloud perso');
  assert.ok(supprime.restant >= 1, 'Le stockage local reste : la suppression ne bloque rien');

  // Le cloud disparaît des écrans…
  assert.equal(destinations.listPublic().some((d) => d.id === cloud.id), false);
  // …mais son NOM survit, pour les factures qui y sont parties. Une pastille
  // qui deviendrait « cloud-3f8a » ferait douter d'une copie qui a bien eu lieu.
  const catalogue = require('../server/destinations/catalogue');
  catalogue.oublier();
  assert.equal(catalogue.brand(cloud.id).name, 'pCloud perso');
});

test('supprimer le dernier stockage est refusé, et la phrase dit quoi faire', () => {
  // Le contrat du lot 26 (« la suppression aboutit et l'écran l'annonce ») est
  // remplacé au lot 38 : on ne propose plus le geste qui laisse crabe sans
  // nulle part où écrire — on le refuse AVANT, avec le geste qui débloque.
  stockageEnService();
  assert.throws(
    () => destinations.deleteCloud('local'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /dernier espace de stockage actif/);
      assert.match(err.message, /Paramètres → Stockage/);
      return true;
    }
  );
  assert.equal(destinations.localActif(), true, 'le refus n\'a rien débranché');
});

test('la suppression du stockage local survit à un redémarrage', () => {
  // L'amorçage de la base rallumait le stockage local à chaque ouverture (`enabled = 1`
  // inconditionnel) : la suppression tenait tant que le service tournait, et se
  // défaisait à la première mise à jour.
  stockageEnService();
  // Un relais actif : depuis le lot 38, le stockage local ne part pas s'il est seul.
  const relais = destinations.createCloud({ provider: 'pcloud', displayName: 'Relais' });
  destinations.saveConfig(relais.id, { enabled: true, valeurs: { token: 'jeton' } });
  destinations.deleteCloud('local');

  const database = db.get();
  database
    .prepare(
      `UPDATE destinations_config
          SET path = COALESCE(NULLIF(path, ''), '/tmp/x'),
              enabled = CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
        WHERE dest_id = 'local'`
    )
    .run();

  assert.equal(destinations.localActif(), false, 'un redémarrage ne ressuscite pas un stockage supprimé');
  stockageEnService();
  assert.equal(destinations.localActif(), true);
  destinations.deleteCloud(relais.id);
});

// ---------------------------------------------------------------------------
// 2. Plus aucun stockage : l'alerte, et le blocage
// ---------------------------------------------------------------------------

test('sans destination, l\'alerte dit quoi faire — et rien d\'autre ne la déclenche', () => {
  stockageEnService();
  assert.deepEqual(destinations.aucunStockageActif(), { bloque: false, message: null });

  plusAucunStockage();
  const alerte = destinations.aucunStockageActif();
  assert.equal(alerte.bloque, true);
  assert.match(alerte.message, /Paramètres → Stockage/, 'l\'alerte nomme l\'écran qui répare');
  assert.match(alerte.message, /nulle part où déposer/);

  stockageEnService();
  assert.equal(destinations.aucunStockageActif().bloque, false);
});

test('sans destination, une récupération est REFUSÉE, et le journal le porte', async () => {
  stockageEnService();
  registry.install(compte.id, 'free');
  registry.saveConfig(compte.id, 'free', { username: 'x', password: 'y' });

  plusAucunStockage();

  await assert.rejects(
    () => scheduler.runForUser(compte.id, 'free', 'cron'),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.aucunStockage, true);
      assert.match(err.message, /nulle part où déposer/);
      return true;
    },
    'récupérer sans destination sollicite un fournisseur pour rien'
  );

  // La trace reste : sans elle, l'utilisateur verrait une planification qui ne
  // s'exécute jamais, sans jamais savoir pourquoi.
  const trace = db
    .get()
    .prepare('SELECT success, message FROM run_logs WHERE connector_id = ? ORDER BY id DESC LIMIT 1')
    .get('free');
  assert.equal(trace.success, 0);
  assert.match(trace.message, /nulle part où déposer/);

  stockageEnService();
  registry.uninstall(compte.id, 'free');
});

test('l\'accueil porte l\'alerte, pas seulement l\'écran de Stockage', async () => {
  // L'écran de Stockage est réservé aux administrateurs : un compte ordinaire
  // verrait ses récupérations s'arrêter sans qu'aucun écran de son périmètre ne
  // lui en donne la raison.
  const home = require('../server/home');
  stockageEnService();
  const avant = await home.dashboard(compte);
  assert.equal(avant.stockageAlerte.bloque, false);

  plusAucunStockage();
  const pendant = await home.dashboard(compte);
  assert.equal(pendant.stockageAlerte.bloque, true);
  assert.match(pendant.stockageAlerte.message, /Aucun espace de stockage/);

  stockageEnService();
});

// ---------------------------------------------------------------------------
// 3. Les notifications d'échec planifié
// ---------------------------------------------------------------------------

test('plusieurs échecs du même passage font UN message, pas un par service', async () => {
  notifications.start();
  const user = { id: compte.id, username: compte.username };

  notifications.signalerEchec(user, 'free', 'Free Internet', 'Identifiants refusés');
  notifications.signalerEchec(user, 'amazon', 'Amazon', 'Le site n\'a pas répondu');
  notifications.signalerEchec(user, 'impots', 'Impots.gouv.fr', 'Session expirée');

  assert.equal(notifications.enAttenteSize, 1, 'un seul lot, pour un seul compte');

  const envoi = await notifications.envoyer(compte.id);
  assert.equal(envoi.connecteurs, 3, 'les trois tiennent dans le même message');
  assert.equal(notifications.enAttenteSize, 0);

  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, '3 récupérations ont échoué');
  assert.deepEqual(
    notif.items.map((i) => i.nom),
    ['Free Internet', 'Amazon', 'Impots.gouv.fr'],
    'chaque service est nommé, avec son motif : « 3 échecs » seul n\'aide personne'
  );
  notifications.marquerVues(compte.id);
});

test('le même service deux fois dans un passage ne se répète pas', async () => {
  notifications.start();
  const user = { id: compte.id, username: compte.username };
  notifications.signalerEchec(user, 'free', 'Free Internet', 'Première tentative');
  notifications.signalerEchec(user, 'free', 'Free Internet', 'Deuxième tentative');

  await notifications.envoyer(compte.id);
  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, 'Échec de récupération : Free Internet');
  assert.equal(notif.items.length, 1);
  assert.equal(notif.items[0].message, 'Deuxième tentative', 'le dernier motif fait foi');
  notifications.marquerVues(compte.id);
});

test('la trace reste même quand aucun e-mail ne peut partir', async () => {
  // C'est le cas par défaut d'une installation : pas de SMTP. Sans cette
  // trace, un échec planifié n'aurait strictement AUCUN signal — il fallait
  // penser à ouvrir « Suivi actions » pour découvrir une panne de trois
  // semaines.
  notifications.start();
  notifications.signalerEchec(
    { id: compte.id, username: compte.username },
    'ovh',
    'OVHcloud',
    'Clé refusée'
  );
  const envoi = await notifications.envoyer(compte.id);
  assert.equal(envoi.envoye, false, 'aucun SMTP configuré ici');
  assert.ok(envoi.groupeId, 'la trace est écrite quand même');
  assert.equal(notifications.nonLues(compte.id).length, 1);
  notifications.marquerVues(compte.id);
});

test('le réglage est par compte, e-mail activé et navigateur éteint par défaut', () => {
  assert.deepEqual(notifications.reglage(compte.id), { email: true, navigateur: false });

  preferences.set(compte.id, 'notifications.echecs.email', false);
  preferences.set(compte.id, 'notifications.echecs.navigateur', true);
  assert.deepEqual(notifications.reglage(compte.id), { email: false, navigateur: true });

  // Un compte qui coupe l'e-mail garde sa trace : c'est elle que la
  // notification du navigateur vient relever.
  preferences.set(compte.id, 'notifications.echecs.email', true);
});

test('e-mail coupé : rien ne part, mais la notification existe', async () => {
  notifications.start();
  preferences.set(compte.id, 'notifications.echecs.email', false);

  notifications.signalerEchec(
    { id: compte.id, username: compte.username },
    'hetzner',
    'Hetzner',
    'Vérification de sécurité'
  );
  const envoi = await notifications.envoyer(compte.id);
  assert.equal(envoi.canal, null);
  assert.equal(notifications.nonLues(compte.id).length, 1);

  preferences.set(compte.id, 'notifications.echecs.email', true);
  notifications.marquerVues(compte.id);
});

test('acquitter une notification la retire, sans effacer sa trace', async () => {
  notifications.start();
  notifications.signalerEchec(
    { id: compte.id, username: compte.username },
    'free',
    'Free Internet',
    'Panne'
  );
  await notifications.envoyer(compte.id);

  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notifications.marquerVues(compte.id, [notif.id]), 1);
  assert.equal(notifications.nonLues(compte.id).length, 0);

  const ligne = db.get().prepare('SELECT seen_at FROM notifications WHERE id = ?').get(notif.id);
  assert.ok(ligne.seen_at, 'vue, pas supprimée : la panne peut persister');
});
