'use strict';

/**
 * Lot 78 — Ameli passe à la session et propose deux services au choix,
 * Bricomarché reconstitue un reçu quand la commande n'a pas de facture,
 * CAF est remis en « prochainement ».
 *
 * ⚠ Données personnelles (§1bis) : aucun numéro, aucune date de naissance,
 * aucun paiement réel ici — uniquement des FORMES (mois en toutes lettres,
 * numéros de commande inventés, montants de fixture).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

require('./helpers');

const ameli = require('../server/connectors/available/ameli/connector');
const ameliManifest = require('../server/connectors/available/ameli/manifest.json');
const bricomarche = require('../server/connectors/available/bricomarche/connector');
const releve = require('../server/connectors/releve-reconstitue');
const { MIGRATIONS } = require('../server/db/migrations');
const schema = require('../server/connectors/manifest-schema');

// ---------------------------------------------------------------------------
// Ameli — le mois d'une carte, et les ancres
// ---------------------------------------------------------------------------

test('Ameli : un libellé de mois français devient « AAAA-MM », le reste rien', () => {
  assert.equal(ameli.moisDepuisLibelle('Relevé de août 2026'), '2026-08');
  assert.equal(ameli.moisDepuisLibelle('aout 2026'), '2026-08');
  assert.equal(ameli.moisDepuisLibelle('Février 2025'), '2025-02');
  assert.equal(ameli.moisDepuisLibelle('décembre 2024'), '2024-12');
  // Pas de mois : pas d'ancre inventée.
  assert.equal(ameli.moisDepuisLibelle('Aucun paiement'), null);
  assert.equal(ameli.moisDepuisLibelle(''), null);
  assert.equal(ameli.moisDepuisLibelle(null), null);
});

test('Ameli : les cartes se dédoublonnent par mois, « Aucun paiement » gagne', () => {
  const cartes = ameli.analyserCartes([
    { libelle: 'Août 2026', aucunPaiement: false },
    { libelle: 'août 2026', aucunPaiement: true }, // second nœud du même mois
    { libelle: 'Juillet 2026', aucunPaiement: false },
    { libelle: 'sans mois', aucunPaiement: true }, // écartée, pas d'ancre
  ]);
  assert.deepEqual(cartes, [
    { mois: '2026-08', aucunPaiement: true },
    { mois: '2026-07', aucunPaiement: false },
  ]);
});

test('Ameli : les ancres désignent le mois — jamais une empreinte de fichier', () => {
  assert.equal(ameli.remoteIdReleve('2026-08'), 'ameli-releve-2026-08');
  // Deux récupérations le même mois portent la MÊME ancre d'attestation :
  // c'est elle qui garantit « au plus un document par mois » (le second
  // passage ne clique même pas).
  const t1 = new Date('2026-09-02T08:00:00Z');
  const t2 = new Date('2026-09-28T22:00:00Z');
  assert.equal(
    ameli.remoteIdAttestation(ameli.moisCourant(t1)),
    ameli.remoteIdAttestation(ameli.moisCourant(t2))
  );
  // Le mois suivant, l'ancre change : une attestation neuve est attendue.
  assert.notEqual(
    ameli.remoteIdAttestation(ameli.moisCourant(t1)),
    ameli.remoteIdAttestation(ameli.moisCourant(new Date('2026-10-01T00:00:00Z')))
  );
});

test('Ameli : l\'authentification se reconnaît à son hôte et à oauth2/authorize', () => {
  assert.equal(ameli.estPageAuthentification('https://ameliconnect.ameli.fr/oauth2/authorize?client_id=x'), true);
  assert.equal(ameli.estPageAuthentification('https://assure.ameli.fr/oauth2/authorize'), true);
  assert.equal(ameli.estPageAuthentification(ameli.RELEVES_URL), false);
  assert.equal(ameli.estPageAuthentification(ameli.ATTESTATION_URL), false);
  assert.equal(ameli.estPageAuthentification('pas une url'), false);
});

test('Ameli : le choix des services — tous par défaut, la sélection filtre', async () => {
  assert.equal(ameli.servicesChoisis(undefined).length, 2);
  assert.deepEqual(
    ameli.servicesChoisis({ services: ['attestation-droits'] }).map((s) => s.id),
    ['attestation-droits']
  );
  // Une sélection qui ne correspond à rien ne coupe pas tout : tous.
  assert.equal(ameli.servicesChoisis({ services: ['inconnu'] }).length, 2);

  const journal = [];
  const decouverte = await ameli.discover({}, { log: (m) => journal.push(m) });
  assert.equal(decouverte.items.length, 2);
  assert.ok(decouverte.items.every((i) => i.preselected === true));
  assert.deepEqual(decouverte.items.map((i) => i.id), ['releves-mensuels', 'attestation-droits']);
});

test('Ameli : le manifeste porte la session par la fenêtre et le multiselect', () => {
  const { ok, errors } = schema.validate(ameliManifest, 'ameli', { planned: false });
  assert.ok(ok, errors.join('\n'));
  const cles = ameliManifest.fields.map((f) => f.key);
  assert.deepEqual(cles, ['session', 'services', 'historique']);
  // Plus AUCUN champ d'identifiant : la connexion passe par la fenêtre (OTP).
  assert.ok(!cles.includes('username') && !cles.includes('password'));
  const services = ameliManifest.fields.find((f) => f.key === 'services');
  assert.equal(services.type, 'multiselect');
  assert.equal(services.source, 'discover');
  // La preuve par le renvoi, MESURÉE le 09/09/2026 avant d'être déclarée.
  assert.equal(ameliManifest.remoteLogin.renvoiAnonyme, 'connexion');
  assert.equal(ameliManifest.remoteLogin.verifyUrlTient, true);
  assert.equal(ameliManifest.remoteLogin.persistent, true);
  // Jamais exercé contre une session réelle : en attente.
  assert.equal(ameliManifest.initialStatus, 'pending');
});

// ---------------------------------------------------------------------------
// Bricomarché — les lignes du tableau, et le reçu reconstitué
// ---------------------------------------------------------------------------

test('Bricomarché : les lignes se lisent par l\'en-tête, pas par une position devinée', () => {
  // L'ordre des colonnes vient de l'EN-TÊTE : un tableau réordonné se lit
  // quand même (la forme relevée par l'utilisateur n'engage pas l'ordre à vie).
  const commandes = bricomarche.analyserLignes([
    ['Date', 'N° de commande', 'Montant TTC', 'Statut'],
    ['12 août 2026', '00123456', '45,90 €', 'Livrée'],
    ['3 février 2026', '00123457', '12,00 €', 'Livrée'],
    ['', 'Filtres et pieds de tableau sans numéro', '', ''],
  ]);
  assert.deepEqual(commandes, [
    { numero: '00123456', date: '12 août 2026', statut: 'Livrée', montant: '45,90 €' },
    { numero: '00123457', date: '3 février 2026', statut: 'Livrée', montant: '12,00 €' },
  ]);
});

test('Bricomarché : sans en-tête reconnue, l\'ordre relevé à la mesure sert de repli', () => {
  const commandes = bricomarche.analyserLignes([
    ['00987654', '1 septembre 2026', 'En préparation', '99,00 €'],
  ]);
  assert.deepEqual(commandes, [
    { numero: '00987654', date: '1 septembre 2026', statut: 'En préparation', montant: '99,00 €' },
  ]);
});

test('Bricomarché : l\'ancre désigne la commande, espaces retirés', () => {
  assert.equal(bricomarche.remoteIdCommande('00 123 456'), 'bricomarche-commande-00123456');
  // La même ancre désignera une vraie facture si elle apparaît un jour : le
  // remplacement sera un geste de code, pas une collision (modèle Atma).
  assert.equal(bricomarche.remoteIdCommande('00123456'), 'bricomarche-commande-00123456');
});

test('Bricomarché : le reçu reconstitué se dit reconstitué, en toutes lettres', () => {
  const buffer = bricomarche.construireRecu({
    numero: '00123456',
    date: '12 août 2026',
    statut: 'Livrée',
    lignes: ['Article de fixture 12,00 €', 'Frais de livraison 4,90 €', 'Total TTC 45,90 €'],
    genereLe: new Date('2026-09-09T12:00:00Z'),
  });
  const texte = buffer.toString('latin1');
  assert.ok(texte.startsWith('%PDF-'));
  // Le bandeau du gabarit commun, nature « recu » : la phrase est vérifiable
  // octet par octet — c'est toute la raison du PDF écrit à la main (lot 74).
  assert.ok(texte.includes(releve.versWinAnsi(releve.bandeau('Bricomarché', 'recu'))));
  assert.ok(texte.includes(releve.versWinAnsi('Commande n° 00123456')));
  // Les lignes sont RECOPIÉES telles qu'affichées, rien de calculé.
  assert.ok(texte.includes(releve.versWinAnsi('Total TTC 45,90')));
});

// ---------------------------------------------------------------------------
// CAF — remis en « prochainement », et le cron désarmé
// ---------------------------------------------------------------------------

test('CAF : la fiche est une annonce valide, avec sa raison pour l\'utilisateur', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const racine = path.join(__dirname, '..', 'server', 'connectors');
  assert.ok(!fs.existsSync(path.join(racine, 'available', 'caf')), 'available/caf doit avoir disparu');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(racine, 'planned', 'caf', 'manifest.json'), 'utf8')
  );
  const { ok, errors } = schema.validate(manifest, 'caf', { planned: true });
  assert.ok(ok, errors.join('\n'));
  // Pas d'« unfeasible » : la décision du compte observé est « prochainement »
  // (« Bientôt disponible »), pas « Pas possible aujourd'hui » — la raison
  // mesurée vit dans le caveat, que la tuile affiche.
  assert.equal(manifest.unfeasible, undefined);
  assert.match(manifest.caveat, /a changé/);
});

test('migration 55 : la planification CAF est désarmée, rien n\'est supprimé', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE connector_installs (
      user_id INTEGER NOT NULL, connector_id TEXT NOT NULL,
      config_encrypted TEXT, UNIQUE (user_id, connector_id)
    );
    CREATE TABLE user_connector_schedules (
      user_id INTEGER NOT NULL, connector_id TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly', time_of_day TEXT NOT NULL DEFAULT '03:00',
      day_of_week INTEGER NOT NULL DEFAULT 1, day_of_month INTEGER NOT NULL DEFAULT 1,
      last_day_of_month INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      anchor_month INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, connector_id)
    );
  `);
  // Deux installations : l'une SANS ligne de planification (les défauts du
  // planificateur l'armeraient quand même — c'est tout le piège), l'autre AVEC
  // une ligne active dont les réglages doivent survivre.
  database.prepare('INSERT INTO connector_installs (user_id, connector_id, config_encrypted) VALUES (1, ?, ?)')
    .run('caf', 'x');
  database.prepare('INSERT INTO connector_installs (user_id, connector_id, config_encrypted) VALUES (2, ?, ?)')
    .run('caf', 'x');
  database.prepare(
    `INSERT INTO user_connector_schedules (user_id, connector_id, frequency, time_of_day, enabled)
     VALUES (2, 'caf', 'weekly', '05:30', 1)`
  ).run();
  // Témoin : un autre connecteur ne doit pas être touché.
  database.prepare('INSERT INTO connector_installs (user_id, connector_id, config_encrypted) VALUES (1, ?, ?)')
    .run('temoin', 'x');

  MIGRATIONS.find((m) => m.id === 55).up(database);

  const lignes = database
    .prepare('SELECT user_id, frequency, time_of_day, enabled FROM user_connector_schedules WHERE connector_id = ? ORDER BY user_id')
    .all('caf');
  assert.equal(lignes.length, 2, 'chaque installation CAF doit avoir sa ligne désarmée');
  assert.ok(lignes.every((l) => l.enabled === 0), 'toutes désarmées');
  // Les réglages existants survivent : seule l'activation tombe.
  assert.deepEqual(lignes[1], { user_id: 2, frequency: 'weekly', time_of_day: '05:30', enabled: 0 });
  // L'installation elle-même n'est PAS supprimée (rien ne se supprime).
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM connector_installs WHERE connector_id = ?').get('caf').n,
    2
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM user_connector_schedules WHERE connector_id = ?').get('temoin').n,
    0, 'le témoin n\'est pas touché'
  );
  database.close();
});

test('migration 54 : Ameli repart en attente — sauf s\'il a déjà été publié', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE connector_catalog (
      connector_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'available',
      published_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  database.prepare("INSERT INTO connector_catalog (connector_id, status) VALUES ('ameli', 'available')").run();
  MIGRATIONS.find((m) => m.id === 54).up(database);
  assert.equal(
    database.prepare("SELECT status FROM connector_catalog WHERE connector_id = 'ameli'").get().status,
    'pending'
  );
  database.close();
});
