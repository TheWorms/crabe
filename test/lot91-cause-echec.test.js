'use strict';

/**
 * Lot 91 — la cause d'un échec : session expirée (orange), connexion refusée
 * (rouge), autre échec (rouge). Une seule règle, côté serveur, servie telle
 * quelle par toutes les routes.
 *
 * ─── Ce que ces essais rejouent ──────────────────────────────────────────────
 *
 *   D1 — la règle, cas par cas, sur le VRAI chemin : de vraies récupérations
 *        par `scheduler.runForUser`, des sondes qui échouent comme les socles
 *        (`profil-marchand`), de vrais enregistrements de connexion par
 *        `registry.saveConfig`. Le temps est décalé dans la base de test.
 *   D2 — une seule source : la même cause sort de toutes les routes.
 *   D6 — les lignes d'avant le lot : classées au mieux, jamais réécrites.
 *   D7 — R11 : ouvrir la fenêtre puis l'abandonner ne sort pas du défaut.
 *   B3 — la migration 59 ajoute sans rien modifier, et une seule fois.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const causeEchec = require('../server/connectors/cause-echec');
const messagesEchec = require('../server/connectors/messages-echec');
const migrations = require('../server/db/migrations');
const db = require('../server/db/db');

const PROFIL_MARCHAND = path.resolve(__dirname, '..', 'server', 'connectors', 'profil-marchand.js');

/**
 * La sonde : son mode se lit dans `globalThis.__lot91[id]` — jamais dans sa
 * configuration, qu'il faudrait réenregistrer (et ce serait une connexion).
 */
const SOURCE_SONDE = `'use strict';
const profilMarchand = require(${JSON.stringify(PROFIL_MARCHAND)});
function echec(mode, nom) {
  if (mode === 'renvoi') return profilMarchand.erreurRenvoiVersAuthentification(nom, 'essai lot 91');
  if (mode === 'expire') {
    const err = new Error('Votre connexion à ' + nom + ' a expiré. Rouvrez-la depuis la fiche du service.');
    err.sessionExpired = true;
    return err;
  }
  if (mode === 'identifiants') {
    const err = new Error('Adresse électronique ou mot de passe incorrect. Corrigez-les sur la fiche du service, puis relancez.');
    err.sessionExpired = true;
    err.situation = 'identifiants-refuses';
    return err;
  }
  return new Error('Le site du fournisseur ne répond pas.');
}
module.exports = {
  async test(config, ctx) {
    const mode = (globalThis.__lot91 || {})[ctx.connectorId] || 'ok';
    if (mode !== 'ok') throw echec(mode, ctx.manifest?.name || 'Sonde');
    return { ok: true, message: 'Connexion valide (sonde).' };
  },
  async fetchInvoices(config, ctx) {
    const mode = (globalThis.__lot91 || {})[ctx.connectorId] || 'ok';
    if (mode !== 'ok') throw echec(mode, ctx.manifest?.name || 'Sonde');
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    return { accountId: 'sonde', invoices: [] };
  },
};
`;

/** Une sonde « à fenêtre » (champ session) ou « à identifiants » (mot de passe). */
function manifeste(id, nom, mode = 'fenetre') {
  return {
    id,
    name: nom,
    category: 'energie',
    color: '#456789',
    letters: 'S9',
    description: 'Sonde de test du lot 91 : elle réussit ou échoue sur commande.',
    ...(mode === 'fenetre' ? { remoteLogin: { url: 'https://sonde.invalid/connexion', marker: '' } } : {}),
    fields: mode === 'fenetre'
      ? [
          { key: 'session', label: 'Connexion', type: 'session', required: false },
          { key: 'email', label: 'Adresse', type: 'text', required: false },
          { key: 'historique', label: 'Historique', type: 'history', default: 'depuis' },
        ]
      : [
          { key: 'username', label: 'Identifiant', type: 'text' },
          { key: 'motDePasse', label: 'Mot de passe', type: 'password' },
          { key: 'historique', label: 'Historique', type: 'history', default: 'depuis' },
        ],
    permissions: [
      { key: 'factures', scope: 'read-write', description: 'Sonde de test : aucune facture réelle n\'est touchée.' },
    ],
  };
}

const SONDES = {
  'sonde91-d1a': 'Sonde Alpha',
  'sonde91-d1b': 'Sonde Bravo',
  'sonde91-d1c': 'Sonde Charlie',
  'sonde91-d1d': 'Sonde Delta',
  'sonde91-d1e': 'Sonde Echo',
  'sonde91-d1f': 'Sonde Foxtrot',
  'sonde91-d1g': 'Sonde Golf',
  'sonde91-d2s': 'Sonde Sierra',
  'sonde91-d2r': 'Sonde Romeo',
  'sonde91-d2e': 'Sonde Echelon',
  'sonde91-d7': 'Sonde Victor',
};
const SONDE_IDENTIFIANTS = 'sonde91-mdp';

let dossier;
let user;
let client;

function mode(id, valeur) {
  globalThis.__lot91[id] = valeur;
}

/** Une session bien formée, au cookie valable un an. */
function sessionInventee(nom) {
  return JSON.stringify({
    cookies: [{
      name: `jeton-${nom}`, value: 'valeur-inventee', domain: 'sonde.invalid', path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 86400, httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    origins: [],
  });
}

/** Enregistre une connexion par la fenêtre, comme `routes/remote-login.js`. */
function seConnecter(id) {
  registry.saveConfig(user.id, id, { session: sessionInventee(id) }, { origine: 'fenetre' });
}

const derniere = (id) =>
  db.get().prepare('SELECT * FROM run_logs WHERE connector_id = ? ORDER BY id DESC LIMIT 1').get(id);

/** Recule une exécution dans le temps (minutes) — la base de test seulement. */
function reculerExecution(runId, minutes) {
  db.get()
    .prepare(
      `UPDATE run_logs SET started_at = datetime(started_at, ?), finished_at = datetime(finished_at, ?)
        WHERE id = ?`
    )
    .run(`-${minutes} minutes`, `-${minutes} minutes`, runId);
}

/** Recule les enregistrements de connexion d'un service (minutes). */
function reculerConnexions(id, minutes) {
  db.get()
    .prepare("UPDATE connexions_enregistrees SET at = datetime(at, ?) WHERE connector_id = ?")
    .run(`-${minutes} minutes`, id);
}

const executer = (id) => scheduler.runForUser(user.id, id, 'manual');
const vue = (id) => registry.listForUser(user).find((c) => c.id === id);

test.before(async () => {
  await helpers.setup();
  globalThis.__lot91 = {};
  user = await helpers.createUser({ username: 'lot91', plainPassword: 'MotDePasse1', role: 'admin' });
  destinations.restoreLocal();

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot91-cause-'));
  const ecrire = (id, nom, type) => {
    fs.mkdirSync(path.join(dossier, id));
    fs.writeFileSync(path.join(dossier, id, 'manifest.json'), JSON.stringify(manifeste(id, nom, type)));
    fs.writeFileSync(path.join(dossier, id, 'connector.js'), SOURCE_SONDE);
  };
  for (const [id, nom] of Object.entries(SONDES)) ecrire(id, nom, 'fenetre');
  ecrire(SONDE_IDENTIFIANTS, 'Sonde Mike', 'identifiants');
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  for (const id of [...Object.keys(SONDES), SONDE_IDENTIFIANTS]) registry.install(user.id, id);

  client = await helpers.startServer();
  await helpers.login(client, 'lot91', 'MotDePasse1');
});

test.after(() => {
  scheduler.stopAll();
  client?.close();
  delete globalThis.__lot91;
  fs.rmSync(dossier, { recursive: true, force: true });
  registry.load();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// D1 — la règle, pure
// ---------------------------------------------------------------------------

test('D1 — la règle pure : rouge seulement pour la récupération qui SUIT un enregistrement, dans le seuil', () => {
  const C = '2026-10-05 17:27:01';
  const apres = (secondes) => new Date(Date.parse(`${C.replace(' ', 'T')}Z`) + secondes * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const refus = { debut: apres(0), echecConnexion: true };

  assert.equal(causeEchec.decider({ echecConnexion: false, connexionLe: C }), 'echec', 'pas d\'authentification : autre échec');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: null }), 'session-expiree', 'heure inconnue : orange');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: C, premiere: refus }), 'connexion-refusee', 'même seconde');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: C, premiere: { debut: apres(15 * 60), echecConnexion: true } }), 'connexion-refusee', 'quinze minutes pile');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: C, premiere: { debut: apres(15 * 60 + 1), echecConnexion: true } }), 'session-expiree', 'au-delà du seuil');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: C, reussiteDepuis: true, premiere: refus }), 'session-expiree', 'une réussite depuis');
  assert.equal(causeEchec.decider({ echecConnexion: true, connexionLe: C, premiere: { debut: apres(5), echecConnexion: false } }), 'session-expiree', 'la première a échoué AUTREMENT');
  assert.equal(causeEchec.SEUIL_CONNEXION_FRAICHE_MS, 15 * 60 * 1000, 'le seuil est de quinze minutes, sous la plus courte session mesurée (30 min)');
});

// ---------------------------------------------------------------------------
// D1 — la règle, sur le vrai chemin
// ---------------------------------------------------------------------------

test('D1 — une réussite depuis la connexion, puis un refus d\'authentification : session expirée', async () => {
  const id = 'sonde91-d1a';
  seConnecter(id);
  reculerConnexions(id, 2 * 24 * 60);
  mode(id, 'ok');
  assert.equal((await executer(id)).ok, true);
  reculerExecution(derniere(id).id, 24 * 60);

  mode(id, 'renvoi');
  const r = await executer(id);
  assert.equal(r.ok, false);
  assert.equal(r.cause, 'session-expiree');
  assert.equal(derniere(id).cause, 'session-expiree', 'la cause est rangée avec la ligne');
  assert.match(derniere(id).message, /^Votre session a expiré \(dernière réussite le \d{2}\/\d{2}\)\. Reconnectez-vous/,
    'le message B ne fait plus deviner : session expirée, datée, le geste');
  assert.equal(vue(id).health.code, 'session-expired');
  assert.equal(vue(id).health.tone, 'amber');
});

test('D1 — la récupération qui suit l\'enregistrement est refusée : connexion refusée, en rouge', async () => {
  const id = 'sonde91-d1b';
  mode(id, 'renvoi');
  seConnecter(id);
  const r = await executer(id);
  assert.equal(r.cause, 'connexion-refusee');
  assert.equal(derniere(id).cause, 'connexion-refusee');
  assert.equal(derniere(id).message, messagesEchec.messageConnexionRefusee(),
    'le texte rouge : inutile de recommencer tout de suite, quand réessayer, le signaler si ça se répète');
  assert.equal(vue(id).health.code, 'connexion-refusee');
  assert.equal(vue(id).health.tone, 'red');
});

test('D1 — la même, mais partie après le seuil : session expirée (dans le doute, orange)', async () => {
  const id = 'sonde91-d1c';
  mode(id, 'renvoi');
  seConnecter(id);
  reculerConnexions(id, 20);
  const r = await executer(id);
  assert.equal(r.cause, 'session-expiree', 'vingt minutes entre l\'enregistrement et le vrai départ');
});

test('D1 — une connexion ancienne jamais essayée : session expirée', async () => {
  const id = 'sonde91-d1d';
  mode(id, 'expire');
  seConnecter(id);
  reculerConnexions(id, 8 * 24 * 60);
  const r = await executer(id);
  assert.equal(r.cause, 'session-expiree');
  assert.match(derniere(id).message, /^Votre session a expiré \(connexion enregistrée le \d{2}\/\d{2}\)/);
});

test('D1 — un échec sans rapport avec la connexion : autre échec', async () => {
  const id = 'sonde91-d1e';
  mode(id, 'panne');
  seConnecter(id);
  const r = await executer(id);
  assert.equal(r.cause, 'echec', 'même juste après une connexion : ce n\'est pas un refus');
  assert.match(derniere(id).message, /^Échec — Le site du fournisseur ne répond pas\./);
  assert.equal(vue(id).health.code, 'error');
});

test('D1 — l\'état reste rouge jusqu\'à une réussite, puis la réussite remet à zéro', async () => {
  const id = 'sonde91-d1f';
  mode(id, 'renvoi');
  seConnecter(id);
  assert.equal((await executer(id)).cause, 'connexion-refusee');
  // Un second essai, sans nouvel enregistrement ni réussite : toujours rouge.
  assert.equal((await executer(id)).cause, 'connexion-refusee', 'la première après l\'enregistrement décide');

  mode(id, 'ok');
  assert.equal((await executer(id)).ok, true);
  assert.equal(vue(id).defaut, null, 'une réussite efface le défaut');
  mode(id, 'renvoi');
  assert.equal((await executer(id)).cause, 'session-expiree', 'après une réussite : la session a vécu');
});

test('D1 — un nouvel enregistrement remet à zéro, et sa propre récupération est jugée seule', async () => {
  const id = 'sonde91-d1g';
  mode(id, 'renvoi');
  seConnecter(id);
  reculerConnexions(id, 3 * 24 * 60);
  assert.equal((await executer(id)).cause, 'session-expiree', 'connexion ancienne : orange');
  assert.equal(vue(id).health.code, 'session-expired');

  // L'utilisateur se reconnecte une minute plus tard. (Dans la MÊME seconde
  // que la fin de l'échec, l'ordre des deux est indécidable : le défaut reste
  // affiché — c'est voulu, l'inverse effacerait un refus qui échoue en une
  // seconde juste après l'enregistrement.)
  reculerExecution(derniere(id).id, 1);
  seConnecter(id);
  assert.equal(vue(id).defaut, null, 'une connexion enregistrée après l\'échec sort du défaut');
  assert.equal(registry.getInstall(user.id, id).status, 'installed');
  assert.equal((await executer(id)).cause, 'connexion-refusee', 'la récupération qui la suit est refusée : rouge');
});

test('D1 — un test qui suit l\'enregistrement d\'identifiants et se fait refuser : connexion refusée, phrase du site gardée', async () => {
  const id = SONDE_IDENTIFIANTS;
  mode(id, 'identifiants');
  registry.saveConfig(user.id, id, { username: 'compte-invente', motDePasse: 'mot-de-passe-invente' });
  const avant = db.get().prepare('SELECT COUNT(*) n FROM connexions_enregistrees WHERE connector_id = ?').get(id).n;
  assert.equal(avant, 1, 'des identifiants saisis sont une connexion enregistrée (origine formulaire)');
  const r = await registry.testForUser(user.id, id);
  assert.equal(r.ok, false);
  assert.equal(r.cause, 'connexion-refusee');
  assert.equal(derniere(id).trigger, 'test');
  assert.equal(derniere(id).cause, 'connexion-refusee');
  assert.match(derniere(id).message, /^Adresse électronique ou mot de passe incorrect/,
    'le site a DIT que les identifiants sont faux : sa phrase, qui dit quoi corriger, reste');

  // Réenregistrer le même identifiant sans mot de passe n'est pas une connexion.
  registry.saveConfig(user.id, id, { username: 'compte-invente', historique: 'depuis' });
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM connexions_enregistrees WHERE connector_id = ?').get(id).n, 1);
});

// ---------------------------------------------------------------------------
// D2 — une seule source : la même cause sort de toutes les routes
// ---------------------------------------------------------------------------

/** La cause qu'exprime un état de santé — une correspondance de codes. */
const CAUSE_DE_SANTE = { 'session-expired': 'session-expiree', 'connexion-refusee': 'connexion-refusee', error: 'echec' };

test('D2 — pour chaque cause, toutes les routes servent la même', async () => {
  const cas = [
    ['sonde91-d2s', 'session-expiree', async (id) => {
      mode(id, 'expire');
      seConnecter(id);
      reculerConnexions(id, 6 * 24 * 60);
    }],
    ['sonde91-d2r', 'connexion-refusee', async (id) => {
      mode(id, 'renvoi');
      seConnecter(id);
    }],
    ['sonde91-d2e', 'echec', async (id) => {
      mode(id, 'panne');
      seConnecter(id);
    }],
  ];

  for (const [id, attendue, preparer] of cas) {
    await preparer(id);
    const lancement = await client.post(`/api/connectors/${id}/run`);
    assert.equal(lancement.status, 200);

    const home = (await client.get('/api/home')).body;
    const connecteurs = (await client.get('/api/connectors')).body.connectors;
    const detail = (await client.get(`/api/connectors/${id}`)).body;
    const operations = (await client.get('/api/operations')).body.operations;
    const logs = (await client.get(`/api/admin/logs/runs?connector=${id}&result=all&q=`)).body.logs;
    const planifs = (await client.get('/api/admin/schedules')).body.schedules;

    const servies = {
      'POST /run (cause)': lancement.body.cause,
      'POST /run (état)': lancement.body.etat?.defaut?.cause,
      '/api/home errors': home.errors.find((e) => e.connectorId === id)?.cause,
      '/api/home sync': home.sync.find((s) => s.id === id)?.defaut?.cause,
      '/api/home connecteurs (santé)': CAUSE_DE_SANTE[home.connectors.find((c) => c.id === id)?.health?.code],
      '/api/connectors (défaut)': connecteurs.find((c) => c.id === id)?.defaut?.cause,
      '/api/connectors (santé)': CAUSE_DE_SANTE[connecteurs.find((c) => c.id === id)?.health?.code],
      '/api/connectors/:id': detail.lastRun?.cause,
      '/api/operations': operations.find((o) => o.connectorId === id)?.cause,
      '/api/admin/logs/runs': logs[0]?.cause,
      '/api/admin/schedules': planifs.find((p) => p.connectorId === id)?.lastRun?.cause,
    };
    for (const [route, cause] of Object.entries(servies)) {
      assert.equal(cause, attendue, `${id} : ${route} sert « ${cause} » au lieu de « ${attendue} »`);
    }
  }
});

test('D2 — le filtre « Résultat » des logs garde une seule cause à la fois', async () => {
  for (const cause of causeEchec.CAUSES) {
    const { body } = await client.get(`/api/admin/logs/runs?connector=all&result=${cause}&q=`);
    assert.ok(body.logs.length > 0, `au moins une ligne « ${cause} »`);
    assert.ok(body.logs.every((l) => l.cause === cause), `filtre ${cause}`);
    assert.equal(body.journal.length, 0, 'le journal détaillé n\'est pas un résultat : il s\'efface');
  }
});

// ---------------------------------------------------------------------------
// D6 — les lignes d'avant le lot : classées au mieux, jamais réécrites
// ---------------------------------------------------------------------------

test('D6 — une ligne d\'avant le lot est classée par la même règle, et rien n\'est réécrit', async () => {
  const id = 'sonde91-d1d';
  const inserer = db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const connexion = db.get().prepare(
    "INSERT INTO connexions_enregistrees (user_id, connector_id, at, origine) VALUES (?, ?, ?, 'journal')"
  );
  // Un enregistrement repris du journal, la récupération qui l'a suivi deux
  // minutes plus tard, renvoyée vers l'authentification (message B d'avant) :
  connexion.run(user.id, id, '2026-09-17 14:30:00');
  const refus = inserer.run(id, user.id, '2026-09-17 14:32:07', '2026-09-17 14:32:24', 0, 'manual',
    'Votre connexion à Sonde Delta est bien enregistrée, mais le site a renvoyé la lecture automatique vers sa page d\'authentification au lieu de servir votre espace client.').lastInsertRowid;
  // …une réussite, puis le message A d'avant : une expiration.
  inserer.run(id, user.id, '2026-09-18 08:00:00', '2026-09-18 08:01:00', 1, 'manual', 'Aucune nouvelle facture');
  const expire = inserer.run(id, user.id, '2026-09-25 08:00:00', '2026-09-25 08:00:02', 0, 'cron',
    'Votre connexion a expiré (dernière réussite le 18/09) — reconnectez-vous depuis la fiche du service.').lastInsertRowid;
  // …et un autre échec, préfixé comme le planificateur l'écrivait.
  const autre = inserer.run(id, user.id, '2026-09-26 08:00:00', '2026-09-26 08:45:00', 0, 'cron',
    'Échec — La récupération a été arrêtée : elle durait depuis plus de 45 minutes.').lastInsertRowid;

  const avant = db.get().prepare('SELECT id, message, cause FROM run_logs WHERE id IN (?, ?, ?)').all(refus, expire, autre);
  const { body } = await client.get(`/api/admin/logs/runs?connector=${id}&result=all&q=`);
  const servie = (rowId) => body.logs.find((l) => l.id === rowId)?.cause;
  assert.equal(servie(refus), 'connexion-refusee', 'deux minutes après l\'enregistrement, sans réussite');
  assert.equal(servie(expire), 'session-expiree', 'une réussite depuis l\'enregistrement');
  assert.equal(servie(autre), 'echec', 'un autre échec reste « Échec »');

  const apres = db.get().prepare('SELECT id, message, cause FROM run_logs WHERE id IN (?, ?, ?)').all(refus, expire, autre);
  assert.deepEqual(apres, avant, 'classées à la lecture : aucun message, aucune cause réécrits');
  assert.ok(apres.every((l) => l.cause === null));
});

test('D6 — une ligne d\'avant le lot qu\'on ne sait pas classer reste « Échec »', () => {
  for (const message of [
    'Connecteur en maintenance — récupération ignorée.',
    messagesEchec.ECHECS_SANS_MESSAGE.interrompu,
    messagesEchec.MESSAGE_ECRAN_AUTOMATISATION,
    'Échec — Le document n\'est pas un PDF.',
  ]) {
    assert.equal(causeEchec.echecConnexionDepuisLigne({ trigger: 'manual', message }), false, message);
  }
  // Un test d'avant le lot s'écrivait toujours sans préfixe : seules les
  // phrases exactes d'authentification de crabe y valent refus.
  assert.equal(causeEchec.echecConnexionDepuisLigne({ trigger: 'test', message: 'Bitstamp a refusé la clé d\'API.' }), false);
  assert.equal(causeEchec.echecConnexionDepuisLigne({ trigger: 'test', message: 'Adresse électronique ou mot de passe incorrect. Corrigez-les.' }), true);
});

// ---------------------------------------------------------------------------
// D7 — R11 : un défaut ne s'efface pas tout seul
// ---------------------------------------------------------------------------

test('D7 — ouvrir la fenêtre depuis la fiche puis l\'abandonner : le service reste en défaut', async () => {
  const id = 'sonde91-d7';
  mode(id, 'expire');
  seConnecter(id);
  reculerConnexions(id, 4 * 24 * 60);
  await executer(id);
  assert.equal(registry.getInstall(user.id, id).status, 'error');
  assert.equal(vue(id).health.code, 'session-expired');

  // Le bouton « Se connecter » de la fiche enregistre d'abord les champs
  // visibles (`enregistrerPuisOuvrirConnexion`, web/app.js) — sans la session —
  // puis ouvre la fenêtre, que l'utilisateur abandonne.
  const enregistre = await client.put(`/api/connectors/${id}/config`, {
    config: { email: '', historique: 'depuis' },
  });
  assert.equal(enregistre.status, 200);
  await client.post(`/api/connectors/${id}/remote-login`);
  await client.del(`/api/connectors/${id}/remote-login`);

  const install = registry.getInstall(user.id, id);
  assert.equal(install.status, 'error', 'l\'état n\'est pas remis à « installé »');
  assert.ok(install.last_error, 'l\'erreur n\'est pas effacée');
  assert.equal(vue(id).health.code, 'session-expired', 'la fiche, l\'accueil et la pastille disent toujours « session expirée »');
  assert.equal(
    db.get().prepare("SELECT COUNT(*) n FROM connexions_enregistrees WHERE connector_id = ? AND at > datetime('now', '-1 minute')").get(id).n,
    0,
    'aucune connexion n\'a été enregistrée'
  );

  // Les deux seules portes de sortie : une connexion enregistrée (une minute
  // après l'échec, comme le ferait quelqu'un)…
  reculerExecution(derniere(id).id, 1);
  seConnecter(id);
  assert.equal(vue(id).defaut, null);
  assert.equal(registry.getInstall(user.id, id).status, 'installed');
});

// ---------------------------------------------------------------------------
// B3 — la migration 59
// ---------------------------------------------------------------------------

test('B3 — la migration 59 ajoute la table et la colonne, reprend le journal une fois, et ne touche à rien d\'autre', () => {
  const migration = migrations.MIGRATIONS.find((m) => m.id === 59);
  assert.ok(migration, 'la migration 59 doit exister');

  const base = new Database(':memory:');
  base.exec(`
    CREATE TABLE run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connector_id TEXT NOT NULL, user_id INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
      success INTEGER NOT NULL DEFAULT 0, invoice_count INTEGER NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT 'manual', message TEXT
    );
    CREATE TABLE app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'info', source TEXT NOT NULL, message TEXT NOT NULL,
      user_id INTEGER, username TEXT
    );
  `);
  base.prepare("INSERT INTO run_logs (connector_id, user_id, finished_at, success, message) VALUES ('a', 1, datetime('now'), 0, 'x')").run();
  const journal = base.prepare('INSERT INTO app_logs (at, source, message) VALUES (?, ?, ?)');
  journal.run('2026-10-05 17:27:01', 'remote-browser:darty-invente', 'Session Darty capturée par navigateur distant pour le compte 7 — 60 cookie(s).');
  journal.run('2026-10-05 17:20:00', 'remote-browser:darty-invente', 'Session Darty NON enregistrée : … 8 cookie(s) capturé(s).');
  journal.run('2026-08-13 10:00:00', 'remote-browser', 'Session Darty capturée par navigateur distant pour le compte 7 — 2 cookie(s).');
  const avant = base.prepare('SELECT * FROM run_logs').all();

  migration.up(base);
  assert.ok(migrations.hasColumn(base, 'run_logs', 'cause'));
  assert.deepEqual(base.prepare('SELECT id, connector_id, user_id, started_at, finished_at, success, invoice_count, trigger, message FROM run_logs').all(), avant);
  assert.equal(base.prepare('SELECT cause FROM run_logs').get().cause, null, 'aucune cause écrite dans une ligne existante');
  assert.deepEqual(
    base.prepare('SELECT user_id, connector_id, at, origine FROM connexions_enregistrees').all(),
    [{ user_id: 7, connector_id: 'darty-invente', at: '2026-10-05 17:27:01', origine: 'journal' }],
    'seule la ligne « capturée » à identifiant est reprise'
  );

  // Rejouée (par erreur), elle n'ajoute rien.
  migration.up(base);
  assert.equal(base.prepare('SELECT COUNT(*) n FROM connexions_enregistrees').get().n, 1);
  base.close();
});
