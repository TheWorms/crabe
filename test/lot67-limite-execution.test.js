'use strict';

/**
 * Lot 67 — plus aucun connecteur ne tient le verrou sans fin.
 *
 * ─── Ce qui s'est passé ──────────────────────────────────────────────────────
 *
 * Le 26/08/2026, `paybyphone` a tenu son verrou 71 min 20 s en n'écrivant pas
 * une ligne pendant 71 min 16. Rien, dans le socle, ne bornait une exécution :
 * `registry.fetchInvoicesDetailed()` était attendu sans course contre quoi que
 * ce soit. Deux lots ont renoncé à déployer par prudence.
 *
 * ─── Où ces tests mordent ────────────────────────────────────────────────────
 *
 * Une limite de durée se prouve AVEC LE TEMPS QUI PASSE. Ces tests ne simulent
 * pas d'horloge : ils raccourcissent la vraie limite à quelques dizaines de
 * millisecondes (`CRABE_LIMITE_EXECUTION_MS`) et regardent le temps s'écouler
 * pour de bon. Un test qui attendrait les vraies 45 minutes ne serait jamais
 * lancé, et une limite jamais exercée n'est pas une limite.
 *
 * Les quatre morsures demandées, et deux de plus qui comptent autant :
 *
 *   - une exécution qui DÉPASSE la limite est arrêtée et sa ligne refermée ;
 *   - une exécution longue mais LÉGITIME n'est pas interrompue ;
 *   - une ligne fantôme est refermée au démarrage ;
 *   - ce qui a été récupéré avant l'arrêt est conservé ;
 *   - le VERROU est rendu — c'est lui, et non la lenteur, qui a bloqué deux
 *     déploiements ;
 *   - la promesse abandonnée, qui CONTINUE de tourner, ne peut pas revenir
 *     réécrire une ligne déjà refermée ni déposer deux fois le même document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const eteindreNavigateur = require('../server/connectors/eteindre-navigateur');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot67';

/**
 * La sonde : sa lenteur se pilote par la fiche (`attenteMs`), pour que le même
 * connecteur joue « trop long » et « long mais légitime » sans qu'on touche à
 * autre chose que la durée — la seule variable qui nous intéresse.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const attente = Number(config.attenteMs || 0);
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    globalThis.__lot67.rendus = (globalThis.__lot67.rendus || 0) + 1;
    if (config.mode === 'document') {
      return [{
        remoteId: config.remoteId || 'd1',
        filename: (config.remoteId || 'd1') + '.pdf',
        issuedOn: '2026-01-05',
        buffer: Buffer.from('%PDF-1.4 sonde lot 67'),
      }];
    }
    if (config.mode === 'erreur') {
      throw new Error("la sonde a échoué comme un connecteur ordinaire");
    }
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    return { accountId: 'sonde', invoices: [] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 67',
  category: 'energie',
  color: '#123456',
  letters: 'S7',
  description: 'Sonde de test du lot 67 : sa lenteur se règle sur la fiche.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'attenteMs', label: 'Attente', type: 'text', required: false },
    { key: 'mode', label: 'Mode', type: 'text', required: false },
    { key: 'remoteId', label: 'Référence', type: 'text', required: false },
  ],
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

/** Règle la sonde, pose la limite, et lance une récupération. */
async function executer({ attenteMs = 0, limiteMs = null, mode = 'normal', remoteId = 'd1', trigger = 'manual' } = {}) {
  registry.saveConfig(user.id, ID_SONDE, {
    username: 'sonde',
    attenteMs: String(attenteMs),
    mode,
    remoteId,
  });
  if (limiteMs === null) delete process.env.CRABE_LIMITE_EXECUTION_MS;
  else process.env.CRABE_LIMITE_EXECUTION_MS = String(limiteMs);
  try {
    return await scheduler.runForUser(user.id, ID_SONDE, trigger);
  } finally {
    delete process.env.CRABE_LIMITE_EXECUTION_MS;
  }
}

/** La dernière ligne de run_logs de la sonde. */
function derniereLigne() {
  return db
    .get()
    .prepare(
      `SELECT id, started_at, finished_at, success, invoice_count, message
         FROM run_logs WHERE connector_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE, user.id);
}

function documentsDeLaSonde() {
  return db
    .get()
    .prepare('SELECT remote_id FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id')
    .all(user.id, ID_SONDE)
    .map((r) => r.remote_id);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot67', role: 'admin' });
  globalThis.__lot67 = {};
  destinations.restoreLocal();

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot67-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  delete process.env.CRABE_LIMITE_EXECUTION_MS;
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot67;
  registry.load();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. La limite elle-même
// ---------------------------------------------------------------------------

test('une exécution qui dépasse la limite est ARRÊTÉE, et sa ligne run_logs est REFERMÉE', async () => {
  const resultat = await executer({ attenteMs: 4000, limiteMs: 80 });

  assert.equal(resultat.ok, false, 'une exécution abandonnée est un échec, pas un succès muet');

  const ligne = derniereLigne();
  assert.ok(ligne.finished_at, 'LA morsure du lot : la ligne ne doit PAS rester ouverte');
  assert.equal(ligne.success, 0);
  assert.match(
    ligne.message,
    /arrêtée/i,
    'la cause doit être lisible dans le journal, pas devinée'
  );
  assert.match(ligne.message, /Rien n'a été perdu/i, 'et elle doit rassurer sur les documents');
});

test('une exécution longue mais LÉGITIME n\'est pas interrompue', async () => {
  // 300 ms de travail sous une limite de 3 s : c'est le rapport qu'ont, en
  // vrai, une exécution de 30 min sous une limite de 45. Si ce test tombe, la
  // limite est trop serrée et casse du travail réel.
  const resultat = await executer({ attenteMs: 300, limiteMs: 3000 });

  assert.equal(resultat.ok, true, resultat.message);
  const ligne = derniereLigne();
  assert.ok(ligne.finished_at);
  assert.equal(ligne.success, 1);
  assert.doesNotMatch(String(ligne.message), /arrêtée/i);
});

test('le VERROU est rendu : on peut relancer immédiatement après un abandon', async () => {
  await executer({ attenteMs: 4000, limiteMs: 80 });

  assert.equal(
    scheduler.isRunning(user.id, ID_SONDE),
    false,
    'c\'est le verrou, et non la lenteur, qui a bloqué deux déploiements'
  );

  // Et il est réellement reprenable : une seconde exécution part sans se faire
  // refuser par « une synchronisation est déjà en cours ».
  const suivante = await executer({ attenteMs: 0, limiteMs: 3000 });
  assert.equal(suivante.ok, true, suivante.message);
});

test('ce qui a été récupéré AVANT l\'arrêt est conservé', async () => {
  const depot = await executer({ attenteMs: 0, limiteMs: 3000, mode: 'document', remoteId: 'lot67-a' });
  assert.equal(depot.ok, true, depot.message);
  assert.ok(documentsDeLaSonde().includes('lot67-a'), 'le document de départ doit être déposé');

  await executer({ attenteMs: 4000, limiteMs: 80, mode: 'document', remoteId: 'lot67-b' });

  assert.ok(
    documentsDeLaSonde().includes('lot67-a'),
    'un abandon ne doit RIEN retirer de ce qui était déjà là'
  );
});

test('la promesse abandonnée ne revient pas réécrire une ligne déjà refermée', async () => {
  globalThis.__lot67.rendus = 0;
  const avantDocs = documentsDeLaSonde().length;

  await executer({ attenteMs: 700, limiteMs: 80, mode: 'document', remoteId: 'lot67-fantome' });
  const ligne = derniereLigne();
  assert.ok(ligne.finished_at, 'refermée tout de suite');
  assert.match(ligne.message, /arrêtée/i);

  // On laisse la promesse abandonnée aller jusqu'à son terme, pour de vrai.
  await dormir(1200);
  assert.equal(globalThis.__lot67.rendus, 1, 'la sonde a bien fini son travail dans le vide');

  const relue = db
    .get()
    .prepare('SELECT finished_at, success, invoice_count, message FROM run_logs WHERE id = ?')
    .get(ligne.id);
  assert.equal(relue.finished_at, ligne.finished_at, 'la ligne refermée ne doit pas bouger');
  assert.equal(relue.success, 0);
  assert.match(relue.message, /arrêtée/i);
  assert.equal(
    documentsDeLaSonde().length,
    avantDocs,
    'et surtout : le document que la promesse tenait ne doit PAS être déposé après coup'
  );
  assert.ok(!documentsDeLaSonde().includes('lot67-fantome'));
});

test('l\'abandon appelle VRAIMENT l\'extinction, avec le profil du couple', async () => {
  // Le socle peut poser une limite parfaite et laisser un Chromium vivant : ce
  // test vérifie le BRANCHEMENT, pas le module (celui-ci est éprouvé plus bas
  // avec un faux /proc). C'est la même leçon qu'au lot 66 — un service
  // impeccable que personne n'appelle passe tous les tests sans rien faire.
  const profilPersistant = require('../server/connectors/profil-persistant');
  const vraiEteindre = eteindreNavigateur.eteindre;
  const appels = [];
  eteindreNavigateur.eteindre = (quoi) => {
    appels.push(quoi);
    return { tues: [], epargnes: 0 };
  };
  try {
    await executer({ attenteMs: 4000, limiteMs: 80 });
  } finally {
    eteindreNavigateur.eteindre = vraiEteindre;
  }

  assert.equal(appels.length, 1, 'un abandon doit éteindre le navigateur de l\'exécution');
  assert.equal(appels[0].profil, profilPersistant.chemin(user.id, ID_SONDE));
  assert.equal(appels[0].seul, true, 'aucune autre exécution ne tournait');
});

test('une erreur ORDINAIRE n\'éteint rien : le connecteur ferme déjà son navigateur', async () => {
  const vraiEteindre = eteindreNavigateur.eteindre;
  const appels = [];
  eteindreNavigateur.eteindre = (quoi) => {
    appels.push(quoi);
    return { tues: [], epargnes: 0 };
  };
  let resultat;
  try {
    // ⚠ Une erreur LEVÉE par le connecteur, et pas « compte inactif » : celui-ci
    // RETOURNE au lieu de lever, ne traverse donc jamais le catch, et ce test
    // ne mordait pas (trouvé par le protocole de morsure du lot).
    resultat = await executer({ mode: 'erreur', limiteMs: 3000 });
  } finally {
    eteindreNavigateur.eteindre = vraiEteindre;
  }
  assert.equal(resultat.ok, false, 'la sonde doit bien avoir échoué');
  assert.doesNotMatch(String(derniereLigne().message), /arrêtée/i, 'et pas par dépassement');
  assert.equal(appels.length, 0, 'tuer un navigateur sain ferait échouer du travail correct');
});

test('un abandon planifié est NOTIFIABLE comme n\'importe quel échec', async () => {
  const notifications = require('../server/notifications');
  notifications.viderTout();
  assert.equal(notifications.enAttenteSize, 0);

  const resultat = await executer({ attenteMs: 4000, limiteMs: 80, trigger: 'cron' });

  // On exige que ce soit bien l'ABANDON qui notifie, et pas n'importe quel
  // échec : sans cette seconde assertion, le test passait encore quand la
  // limite était retirée, parce qu'un autre échec remplissait la file.
  assert.match(resultat.message, /arrêtée/i, 'c\'est le dépassement qui doit notifier');
  assert.equal(
    notifications.enAttenteSize,
    1,
    'l\'abandon passe par le chemin d\'échec ordinaire : il hérite des notifications du lot 66'
  );
  notifications.viderTout();
});

test('la limite par défaut est de 45 minutes, et laisse passer la plus longue exécution mesurée', () => {
  assert.equal(scheduler.LIMITE_EXECUTION_MS, 45 * 60 * 1000);

  // La plus longue exécution jamais mesurée sur l'installation réelle :
  // 1805 s (impots, 30 min). La plus longue RÉUSSIE : 600 s (amazon,
  // 149 documents). Et les paybyphone à arrêter : 4280 s.
  assert.ok(scheduler.LIMITE_EXECUTION_MS > 1805 * 1000, 'ne doit pas casser du travail réel');
  assert.ok(scheduler.LIMITE_EXECUTION_MS < 4279 * 1000, 'doit mordre les 71 minutes de paybyphone');

  delete process.env.CRABE_LIMITE_EXECUTION_MS;
  assert.equal(scheduler.limiteExecutionMs(), scheduler.LIMITE_EXECUTION_MS);
  process.env.CRABE_LIMITE_EXECUTION_MS = '250';
  assert.equal(scheduler.limiteExecutionMs(), 250);
  process.env.CRABE_LIMITE_EXECUTION_MS = 'pas-un-nombre';
  assert.equal(scheduler.limiteExecutionMs(), scheduler.LIMITE_EXECUTION_MS, 'une valeur illisible ne désarme pas la limite');
  process.env.CRABE_LIMITE_EXECUTION_MS = '0';
  assert.equal(scheduler.limiteExecutionMs(), scheduler.LIMITE_EXECUTION_MS, 'zéro non plus');
  delete process.env.CRABE_LIMITE_EXECUTION_MS;
});

// ---------------------------------------------------------------------------
// 2. La ligne fantôme, refermée au démarrage (§2c)
// ---------------------------------------------------------------------------

test('une ligne restée ouverte par un arrêt brutal est refermée au démarrage', () => {
  const id = db
    .get()
    .prepare('INSERT INTO run_logs (connector_id, user_id, trigger) VALUES (?, ?, ?)')
    .run(ID_SONDE, user.id, 'manual').lastInsertRowid;

  const avant = db.get().prepare('SELECT finished_at FROM run_logs WHERE id = ?').get(id);
  assert.equal(avant.finished_at, null, 'la ligne part bien ouverte');

  const closes = scheduler.cloreLesExecutionsInterrompues();
  assert.ok(closes >= 1);

  const apres = db
    .get()
    .prepare('SELECT finished_at, success, message FROM run_logs WHERE id = ?')
    .get(id);
  assert.ok(apres.finished_at, 'sinon elle bloque les déploiements, exactement comme le 26/08');
  assert.equal(apres.success, 0);
  assert.ok(String(apres.message || '').trim().length > 0, 'un échec sans message est interdit');
});

test('une ligne DÉJÀ terminée n\'est pas réécrite au démarrage', () => {
  const id = db
    .get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, trigger, finished_at, success, message)
       VALUES (?, ?, 'manual', '2026-08-01 10:00:00', 1, '3 factures récupérées')`
    )
    .run(ID_SONDE, user.id).lastInsertRowid;

  scheduler.cloreLesExecutionsInterrompues();

  const apres = db
    .get()
    .prepare('SELECT finished_at, success, message FROM run_logs WHERE id = ?')
    .get(id);
  assert.equal(apres.finished_at, '2026-08-01 10:00:00');
  assert.equal(apres.success, 1);
  assert.equal(apres.message, '3 factures récupérées');
});

// ---------------------------------------------------------------------------
// 3. Éteindre le navigateur — sans jamais toucher celui du voisin
// ---------------------------------------------------------------------------

const PROFIL_CONNECTEUR = '/donnees/profils-navigateur/1/paybyphone';
const PROFIL_JETABLE = '/tmp/playwright_chromiumdev_profile-aBcDeF';

/**
 * Un faux `/proc`, calqué sur ce qui a été MESURÉ le 27/08/2026 : le navigateur
 * de premier rang a pour parent node et porte `--user-data-dir` ; ses moteurs
 * de rendu ont pour parent le navigateur et ne le portent pas.
 */
function faussesEntrailles(processus, { moi = 4242, morts = [] } = {}) {
  const fichiers = new Map();
  for (const p of processus) {
    fichiers.set(`/proc/${p.pid}/comm`, `${p.comm}\n`);
    fichiers.set(`/proc/${p.pid}/cmdline`, `${p.argv.join('\0')}\0`);
    fichiers.set(`/proc/${p.pid}/status`, `Name:\t${p.comm}\nPPid:\t${p.ppid}\n`);
  }
  const tues = [];
  const journal = [];
  return {
    tues,
    journal,
    runtime: {
      fs: {
        readdirSync: () => processus.map((p) => String(p.pid)),
        readFileSync: (chemin) => {
          if (!fichiers.has(chemin)) {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            throw err;
          }
          return fichiers.get(chemin);
        },
        existsSync: (chemin) => {
          const pid = Number(/\/proc\/(\d+)$/.exec(chemin)?.[1]);
          return processus.some((p) => p.pid === pid) && !morts.includes(pid);
        },
      },
      procDir: () => '/proc',
      monPid: () => moi,
      kill: (pid, signal) => tues.push({ pid, signal }),
      differer: (fn) => fn(), // le second rideau tombe tout de suite, ici
      log: (niveau, texte) => journal.push(`${niveau} ${texte}`),
    },
  };
}

/** Un navigateur de premier rang, et deux moteurs de rendu à lui. */
function navigateurAvecSesMoteurs(pidNav, profil, moi = 4242) {
  return [
    { pid: pidNav, comm: 'chrome-headless', ppid: moi, argv: ['/chrome', `--user-data-dir=${profil}`] },
    { pid: pidNav + 1, comm: 'chrome-headless', ppid: pidNav, argv: ['/chrome', '--type=renderer'] },
    { pid: pidNav + 2, comm: 'chrome-headless', ppid: pidNav, argv: ['/chrome', '--type=zygote'] },
  ];
}

test('seul le navigateur de PREMIER RANG est reconnu — jamais un moteur de rendu', () => {
  const { runtime } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(500, PROFIL_CONNECTEUR),
    { pid: 900, comm: 'node', ppid: 1, argv: ['/usr/bin/node', 'index.js'] },
    // Un moteur de rendu qui porterait quand même un profil : seule la
    // filiation le distingue alors du navigateur.
    { pid: 560, comm: 'chrome-headless', ppid: 500, argv: ['/chrome', '--type=renderer', `--user-data-dir=${PROFIL_CONNECTEUR}`] },
  ]);

  const vus = eteindreNavigateur.navigateursDeCeProcessus(runtime);
  assert.equal(vus.length, 1, 'un SIGTERM sur le premier rang emporte déjà toute sa descendance');
  assert.equal(vus[0].pid, 500);
  assert.equal(vus[0].profil, PROFIL_CONNECTEUR);
});

test('le navigateur DISTANT, sur le même profil, n\'est jamais éteint', () => {
  // Le cas qui coûterait le plus cher : la fenêtre « Se connecter à … » ouvre
  // le MÊME répertoire de profil, mais elle est lancée par le gestionnaire de
  // navigateur distant, pas par la récupération. Elle n'est donc pas notre
  // enfant — et la tuer fermerait la fenêtre sous les doigts de quelqu'un qui
  // est en train d'y saisir un code reçu par SMS.
  const { runtime, tues } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(500, PROFIL_CONNECTEUR),
    { pid: 800, comm: 'chrome', ppid: 77, argv: ['/chrome', `--user-data-dir=${PROFIL_CONNECTEUR}`] },
  ]);

  const vus = eteindreNavigateur.navigateursDeCeProcessus(runtime);
  assert.deepEqual(vus.map((v) => v.pid), [500], 'la fenêtre distante n\'est pas à nous');

  eteindreNavigateur.eteindre({ profil: PROFIL_CONNECTEUR, seul: true }, runtime);
  assert.ok(!tues.some((t) => t.pid === 800), 'et elle ne doit recevoir AUCUN signal');
});

test('le navigateur du profil du connecteur est éteint MÊME si une autre exécution tourne', () => {
  const { runtime, tues } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(500, PROFIL_CONNECTEUR),
    ...navigateurAvecSesMoteurs(600, PROFIL_JETABLE),
  ]);

  const bilan = eteindreNavigateur.eteindre(
    { profil: PROFIL_CONNECTEUR, seul: false },
    runtime
  );

  assert.equal(bilan.tues.length, 1);
  assert.equal(bilan.tues[0].pid, 500);
  assert.equal(bilan.epargnes, 1, 'le navigateur du voisin doit être laissé en vie');
  assert.ok(!tues.some((t) => t.pid === 600), 'LA morsure : jamais le navigateur d\'une autre exécution');
});

test('un profil JETABLE n\'est pas touché quand une autre exécution tourne', () => {
  const { runtime, tues, journal } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(600, PROFIL_JETABLE),
    ...navigateurAvecSesMoteurs(700, '/tmp/playwright_chromiumdev_profile-zZzZ'),
  ]);

  const bilan = eteindreNavigateur.eteindre(
    { profil: '/donnees/profils-navigateur/1/sans-profil', seul: false },
    runtime
  );

  assert.equal(bilan.tues.length, 0, 'rien ne les rattache à CETTE exécution : on ne devine pas');
  assert.equal(tues.length, 0);
  assert.ok(journal.some((l) => /laissé\(s\) en vie/.test(l)), 'et le journal doit le dire');
});

test('un profil JETABLE est éteint quand l\'exécution abandonnée était SEULE', () => {
  const { runtime, tues } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(600, PROFIL_JETABLE),
  ]);

  const bilan = eteindreNavigateur.eteindre({ profil: null, seul: true }, runtime);

  assert.equal(bilan.tues.length, 1);
  assert.equal(bilan.tues[0].pid, 600);
  assert.ok(tues.some((t) => t.pid === 600 && t.signal === 'SIGTERM'));
});

test('un navigateur qui ignore SIGTERM reçoit SIGKILL', () => {
  const { runtime, tues } = faussesEntrailles([
    ...navigateurAvecSesMoteurs(500, PROFIL_CONNECTEUR),
  ]);

  eteindreNavigateur.eteindre({ profil: PROFIL_CONNECTEUR, seul: true }, runtime);

  assert.deepEqual(
    tues,
    [{ pid: 500, signal: 'SIGTERM' }, { pid: 500, signal: 'SIGKILL' }],
    'sans second rideau, un navigateur têtu garderait le profil du compte ouvert'
  );
});

test('un navigateur mort entre les deux rideaux ne reçoit pas de SIGKILL', () => {
  const { runtime, tues } = faussesEntrailles(
    [...navigateurAvecSesMoteurs(500, PROFIL_CONNECTEUR)],
    { morts: [500] }
  );

  eteindreNavigateur.eteindre({ profil: PROFIL_CONNECTEUR, seul: true }, runtime);

  assert.deepEqual(tues, [{ pid: 500, signal: 'SIGTERM' }]);
});

test('sans /proc lisible, l\'extinction ne fait pas échouer l\'abandon', () => {
  const runtime = {
    ...eteindreNavigateur.runtimeParDefaut(),
    fs: {
      readdirSync: () => {
        throw new Error('ENOENT');
      },
    },
  };
  assert.deepEqual(eteindreNavigateur.navigateursDeCeProcessus(runtime), []);
  assert.deepEqual(eteindreNavigateur.eteindre({ profil: null, seul: true }, runtime).tues, []);
});
