'use strict';

/**
 * Un échec ne peut pas avoir un message vide, et une exécution en cours n'est
 * pas un échec (lot 33, phase A).
 *
 * ─── L'épisode qui a tout déclenché ──────────────────────────────────────────
 *
 * Le 14/08/2026 à 14:52, l'utilisateur lance « Récupérer tout l'historique » sur
 * SoYouStart. Le journal affiche « soyoustart | ÉCHEC | "" » pendant que
 * l'écran dit « aucune nouvelle facture ». En réalité, AUCUN échec n'a eu
 * lieu : la ligne de run_logs naît au démarrage de l'exécution avec
 * `success = 0` et sans message (schema.sql), et pendant les 2 min 45 du
 * rattrapage, tous les lecteurs la présentaient comme un échec au message
 * vide. Le rattrapage a fini par ranger 53 factures.
 *
 * Deux règles de socle en sortent, chacune verrouillée ici :
 *
 *   1. **une ligne sans `finished_at` n'est ni un succès ni un échec** — les
 *      lecteurs l'écartent (accueil, fiches, badge des planifications, filtre
 *      « Échecs ») ou l'étiquettent « En cours » (journal complet) ; au
 *      démarrage de crabe, les lignes inachevées d'un processus mort sont
 *      closes en échec honnête ;
 *   2. **un échec enregistré porte toujours un message** — si le connecteur
 *      n'a rien produit, le socle fabrique une phrase qui dit ce qui était en
 *      cours et quoi faire. La garde vit aux points d'écriture de run_logs,
 *      donc elle couvre tout connecteur, présent ou futur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const home = require('../server/home');
const messagesEchec = require('../server/connectors/messages-echec');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot33';

/**
 * La sonde : son comportement se règle par `globalThis.__lot33.mode`, pour
 * jouer tour à tour le connecteur qui échoue sans un mot (une Error('') —
 * exactement ce qu'un `throw` mal construit produit) et celui qui répond
 * proprement.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    if (globalThis.__lot33.mode === 'test-echec-vide') return { ok: false, message: '' };
    return { ok: true, message: 'sonde en forme' };
  },
  async fetchInvoices(config, ctx) {
    if (globalThis.__lot33.mode === 'erreur-vide') throw new Error('');
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 1 });
    return [];
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 33',
  category: 'energie',
  color: '#332211',
  letters: 'SE',
  description: 'Sonde de test du lot 33 : échec sans message, exécution en cours.',
  fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({
    username: 'lot33',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(require('../server/permissions').roleBySlug('admin').id, user.id);

  globalThis.__lot33 = { mode: 'ok' };
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot33-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot33;
  registry.load();
  helpers.teardown();
});

/** Repart d'un journal vierge pour la sonde : chaque test raconte son cas. */
function purgerJournalSonde() {
  helpers.db.get().prepare('DELETE FROM run_logs WHERE connector_id = ?').run(ID_SONDE);
}

function derniereLigne(trigger = null) {
  return helpers.db
    .get()
    .prepare(
      `SELECT started_at, finished_at, success, message FROM run_logs
        WHERE connector_id = ? ${trigger ? "AND trigger = '" + trigger + "'" : ''}
        ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE);
}

// ---------------------------------------------------------------------------
// Règle 2 — un échec enregistré porte toujours un message
// ---------------------------------------------------------------------------

test('une récupération qui échoue sans un mot reçoit la phrase du socle, à l\'écran comme au journal', async () => {
  purgerJournalSonde();
  globalThis.__lot33.mode = 'erreur-vide';

  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.ok, false);
  assert.ok(resultat.message.trim(), 'le résultat rendu à l\'écran n\'est jamais vide');
  assert.equal(resultat.message, messagesEchec.ECHECS_SANS_MESSAGE.recuperation);

  const ligne = derniereLigne();
  assert.ok(ligne.finished_at, 'l\'exécution est close');
  assert.equal(ligne.success, 0);
  // LA règle du lot : le journal et l'écran racontent la même histoire.
  assert.equal(ligne.message, resultat.message);
  // Et la phrase dit quoi faire, sans jargon.
  assert.match(ligne.message, /Réessayez/);

  const install = helpers.db
    .get()
    .prepare('SELECT last_error FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(user.id, ID_SONDE);
  assert.equal(install.last_error, resultat.message, 'la fiche porte le même texte');
});

test('un test de connexion qui échoue sans un mot reçoit la phrase du geste « test »', async () => {
  purgerJournalSonde();
  globalThis.__lot33.mode = 'test-echec-vide';

  const resultat = await registry.testForUser(user.id, ID_SONDE);
  assert.equal(resultat.ok, false);
  assert.equal(resultat.message, messagesEchec.ECHECS_SANS_MESSAGE.test);
  assert.match(resultat.message, /test de connexion/);

  const ligne = derniereLigne('test');
  assert.equal(ligne.success, 0);
  assert.equal(ligne.message, resultat.message, 'même texte au journal et à l\'écran');
});

test('la garde ne réécrit pas un message d\'échec existant', async () => {
  // La phrase fabriquée est un filet, pas un rouleau compresseur : un échec
  // qui explique déjà quoi faire ressort intact.
  assert.equal(messagesEchec.messageJamaisVide('Session expirée — reconnectez-vous.'), 'Session expirée — reconnectez-vous.');
  assert.equal(messagesEchec.messageJamaisVide('   '), messagesEchec.ECHECS_SANS_MESSAGE.recuperation);
  assert.equal(messagesEchec.messageJamaisVide(null, 'test'), messagesEchec.ECHECS_SANS_MESSAGE.test);
});

test('aucun nouveau point d\'écriture de run_logs ne peut apparaître sans passer par la garde', () => {
  // Balayage du code serveur : les écritures d'exécutions sont exactement
  // celles qui appliquent `messageJamaisVide`. Un contributeur qui en ajoute
  // une verra CE test tomber, et saura qu'un échec sans message est interdit.
  const racine = path.join(__dirname, '..', 'server');
  const fichiers = [];
  (function parcourir(dossierCourant) {
    for (const entree of fs.readdirSync(dossierCourant, { withFileTypes: true })) {
      const chemin = path.join(dossierCourant, entree.name);
      if (entree.isDirectory()) parcourir(chemin);
      else if (entree.name.endsWith('.js')) fichiers.push(chemin);
    }
  })(racine);

  const ecritures = [];
  for (const fichier of fichiers) {
    const source = fs.readFileSync(fichier, 'utf8');
    const occurrences = source.match(/INSERT INTO run_logs|UPDATE run_logs\s+SET/gi) || [];
    for (const _ of occurrences) ecritures.push(path.relative(racine, fichier));
  }

  assert.deepEqual(
    ecritures.sort(),
    [
      'connectors/registry.js', // testForUser — garde « test »
      'scheduler.js', // refus « aucun stockage » — garde « recuperation »
      'scheduler.js', // INSERT de démarrage (ligne « en cours », sans résultat)
      'scheduler.js', // finish() — garde « recuperation »
      'scheduler.js', // clôture des lignes orphelines — garde « interrompu »
    ].sort(),
    'nouvelle écriture de run_logs détectée : appliquer messagesEchec.messageJamaisVide '
      + 'sur tout message d\'échec avant de mettre cette liste à jour'
  );
});

// ---------------------------------------------------------------------------
// Règle 1 — une exécution en cours n'est ni un succès ni un échec
// ---------------------------------------------------------------------------

/** Simule la ligne qu'une exécution laisse pendant qu'elle tourne. */
function insererLigneEnCours() {
  helpers.db
    .get()
    .prepare('INSERT INTO run_logs (connector_id, user_id, trigger) VALUES (?, ?, ?)')
    .run(ID_SONDE, user.id, 'manual');
}

test('une exécution en cours n\'apparaît ni en échec ni en succès sur l\'accueil', async () => {
  purgerJournalSonde();
  // L'état d'avant : un succès terminé.
  globalThis.__lot33.mode = 'ok';
  const succes = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(succes.ok, true, succes.message);

  // Puis une exécution « en cours » (ligne de démarrage, jamais terminée).
  insererLigneEnCours();

  // Le rôle accompagne l'utilisateur, comme sur les vraies routes : la sonde
  // n'est pas dans connector_catalog, seul un admin la voit au catalogue.
  const erreurs = home.recentErrors({ id: user.id, role: 'admin' });
  assert.equal(
    erreurs.some((e) => e.connectorId === ID_SONDE),
    false,
    'la ligne en cours ne devient pas une erreur'
  );

  const reussites = home.recentSuccesses({ id: user.id, role: 'admin' });
  const sonde = reussites.find((s) => s.connectorId === ID_SONDE);
  assert.ok(sonde, 'le dernier succès TERMINÉ reste affiché pendant l\'exécution');

  const dernier = scheduler.lastRunForUser(user.id, ID_SONDE);
  assert.equal(dernier.success, true, 'le « dernier résultat » est celui d\'avant, pas la ligne en cours');
});

test('le filtre « Échecs » du journal ignore les exécutions en cours, le journal complet les montre', async (t) => {
  purgerJournalSonde();
  globalThis.__lot33.mode = 'erreur-vide';
  await scheduler.runForUser(user.id, ID_SONDE, 'manual'); // un vrai échec, terminé
  insererLigneEnCours(); // et une exécution en cours

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'lot33', 'MotDePasse1');

  const echecs = await client.get('/api/admin/logs/runs?connector=all&result=failure&q=');
  assert.equal(echecs.status, 200);
  const lignesEchecs = echecs.body.logs.filter((l) => l.connector_id === ID_SONDE);
  assert.equal(lignesEchecs.length, 1, 'le filtre « Échecs » ne rend que l\'échec terminé');
  assert.ok(lignesEchecs[0].finished_at);
  assert.ok(lignesEchecs[0].message.trim(), 'et cet échec porte un message');

  const tout = await client.get('/api/admin/logs/runs?connector=all&result=all&q=');
  const enCours = tout.body.logs.filter((l) => l.connector_id === ID_SONDE && !l.finished_at);
  assert.equal(enCours.length, 1, 'le journal complet montre la ligne en cours');
});

test('le badge du journal étiquette « En cours » une ligne sans fin, jamais « Échec »', () => {
  // On exécute la VRAIE fonction du front, extraite de web/admin.js : c'est
  // elle qui a affiché « Échec » sur le rattrapage SoYouStart en plein travail.
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.js'), 'utf8');
  const morceau = source.match(/function runStatusBadge\(l\) \{[\s\S]*?\n\}/);
  assert.ok(morceau, 'runStatusBadge introuvable dans web/admin.js');
  const runStatusBadge = new Function(`${morceau[0]}; return runStatusBadge;`)();

  assert.match(runStatusBadge({ finished_at: null, success: 0 }), />En cours</);
  assert.doesNotMatch(runStatusBadge({ finished_at: null, success: 0 }), /Échec/);
  assert.match(runStatusBadge({ finished_at: '2026-08-14 14:55:18', success: 1 }), />Succès</);
  assert.match(runStatusBadge({ finished_at: '2026-08-14 14:55:18', success: 0 }), />Échec</);

  // Et le tableau du journal passe bien par elle — pas par un ternaire local.
  assert.ok(source.includes('runStatusBadge(l)'), 'le tableau des exécutions emploie le badge');
});

test('au démarrage, les lignes laissées « en cours » par un arrêt deviennent des échecs qui disent quoi faire', () => {
  purgerJournalSonde();
  insererLigneEnCours();

  const closes = scheduler.cloreLesExecutionsInterrompues();
  assert.equal(closes, 1);

  const ligne = derniereLigne();
  assert.ok(ligne.finished_at, 'la ligne est close');
  assert.equal(ligne.success, 0);
  assert.equal(ligne.message, messagesEchec.ECHECS_SANS_MESSAGE.interrompu);
  assert.match(ligne.message, /Relancez/);

  // Plus rien à clore : l'appel est sans effet sur un journal sain.
  assert.equal(scheduler.cloreLesExecutionsInterrompues(), 0);
});
