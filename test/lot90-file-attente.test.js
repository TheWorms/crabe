'use strict';

/**
 * Lot 90 — les récupérations passent l'une après l'autre : une file d'attente.
 *
 * ─── Ce qui s'est passé ──────────────────────────────────────────────────────
 *
 * Le 01/10/2026 à 03:00, les 22 récupérations programmées du jour sont parties
 * à la même seconde, en parallèle — le verrou du lot 3 ne couvre qu'un couple
 * (utilisateur, connecteur), et chaque tâche cron appelait `runForUser`
 * directement. Vingt secondes plus tard crabe n'écrivait plus rien ; 38 heures
 * après, le noyau a tué un de ses processus faute de mémoire. Vingt
 * récupérations ont échoué, six autres ne sont jamais parties.
 *
 * ─── Où ces tests mordent ────────────────────────────────────────────────────
 *
 * La sonde COMPTE ses exécutions simultanées pendant qu'elles tournent pour de
 * vrai : le plus grand nombre observé est la mesure, pas une supposition.
 * Avant ce lot, 22 demandes simultanées donnaient 22 exécutions simultanées
 * (mesuré en A6) ; la file doit ramener ce chiffre à 1 sans rien perdre.
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
const db = require('../server/db/db');

/** Nombre de sondes : celui des récupérations parties ensemble le 01/10. */
const NOMBRE_SONDES = 22;
const ID_SONDE = (n) => `sonde-lot90-${String(n).padStart(2, '0')}`;

/**
 * La sonde : elle compte elle-même combien d'exemplaires tournent en même
 * temps, et note son ordre de passage. C'est la mesure du lot — le chiffre
 * vient de ce qui s'exécute, jamais d'une déduction.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const g = globalThis.__lot90;
    g.enCours += 1;
    g.max = Math.max(g.max, g.enCours);
    g.ordre.push(config.marque);
    const attente = Number(config.attenteMs || 20);
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    g.enCours -= 1;
    if (config.mode === 'document') {
      return [{
        remoteId: config.marque + '-d1',
        filename: config.marque + '-d1.pdf',
        issuedOn: '2026-10-05',
        buffer: Buffer.from('%PDF-1.4 sonde lot 90'),
      }];
    }
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    return { accountId: 'sonde', invoices: [] };
  },
};
`;

const manifeste = (id, n) => ({
  id,
  name: `Sonde lot 90 n°${n}`,
  category: 'energie',
  color: '#123456',
  letters: 'S9',
  description: 'Sonde de test du lot 90 : elle compte ses exécutions simultanées.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'marque', label: 'Marque', type: 'text', required: false },
    { key: 'attenteMs', label: 'Attente', type: 'text', required: false },
    { key: 'mode', label: 'Mode', type: 'text', required: false },
  ],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
});

let dossier;
let user;

function remiseAZero() {
  globalThis.__lot90 = { enCours: 0, max: 0, ordre: [] };
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot90', role: 'admin' });
  destinations.restoreLocal();

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot90-'));
  for (let n = 1; n <= NOMBRE_SONDES; n++) {
    const id = ID_SONDE(n);
    fs.mkdirSync(path.join(dossier, id));
    fs.writeFileSync(path.join(dossier, id, 'manifest.json'), JSON.stringify(manifeste(id, n)));
    fs.writeFileSync(path.join(dossier, id, 'connector.js'), SOURCE_SONDE);
  }

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  for (let n = 1; n <= NOMBRE_SONDES; n++) {
    registry.install(user.id, ID_SONDE(n));
    registry.saveConfig(user.id, ID_SONDE(n), { username: 'sonde', marque: ID_SONDE(n) });
  }
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot90;
  registry.load();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// D1 — vingt-deux demandes au même instant, une seule exécution à la fois
// ---------------------------------------------------------------------------

test('22 récupérations demandées au même instant : jamais plus d\'UNE en cours, toutes servies, dans l\'ordre', async () => {
  remiseAZero();

  const ids = [];
  for (let n = 1; n <= NOMBRE_SONDES; n++) ids.push(ID_SONDE(n));
  // Comme le 01/10 : toutes les demandes partent dans le même tour de boucle.
  const resultats = await Promise.all(
    ids.map((id) =>
      scheduler.runForUser(user.id, id, 'cron').catch((err) => ({ ok: false, message: err.message }))
    )
  );

  const g = globalThis.__lot90;
  assert.equal(
    g.max,
    1,
    `LA morsure du lot : ${g.max} récupérations ont tourné en même temps — c'est le 01/10 qui se rejoue`
  );
  assert.equal(g.ordre.length, NOMBRE_SONDES, 'toutes doivent être servies, aucune perdue');
  assert.deepEqual(g.ordre, ids, 'servies dans leur ordre d\'arrivée');
  for (const [i, r] of resultats.entries()) {
    assert.equal(r.ok, true, `${ids[i]} : ${r.message}`);
  }
});

// ---------------------------------------------------------------------------
// D5 — la preuve par run_logs : aucun chevauchement
// ---------------------------------------------------------------------------

/** La requête de clôture : combien de couples de lignes se chevauchent. */
const REQUETE_CHEVAUCHEMENTS = `
  SELECT COUNT(*) AS n
    FROM run_logs a JOIN run_logs b ON a.id < b.id
   WHERE a.finished_at IS NOT NULL AND b.finished_at IS NOT NULL
     AND b.started_at < a.finished_at AND a.started_at < b.finished_at`;

test('run_logs ne porte aucun chevauchement — et la requête sait en voir un', () => {
  // D'abord la morsure de la requête elle-même : deux lignes synthétiques qui
  // se chevauchent pour de bon doivent être comptées — sans quoi « 0 trouvé »
  // ne prouverait rien.
  const inseree = db
    .get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, trigger, started_at, finished_at, success, message)
       VALUES (?, ?, 'manual', '2026-10-01 01:00:00', '2026-10-01 02:00:00', 0, 'chevauchement factice')`
    );
  const a = inseree.run(ID_SONDE(1), user.id).lastInsertRowid;
  const b = inseree.run(ID_SONDE(2), user.id).lastInsertRowid;
  assert.equal(
    db.get().prepare(REQUETE_CHEVAUCHEMENTS).get().n,
    1,
    'la requête doit détecter un chevauchement réel, sinon elle ne prouve rien'
  );
  db.get().prepare('DELETE FROM run_logs WHERE id IN (?, ?)').run(a, b);

  // Puis la preuve : après les 22 exécutions de D1, zéro chevauchement.
  assert.equal(db.get().prepare(REQUETE_CHEVAUCHEMENTS).get().n, 0);
});

// ---------------------------------------------------------------------------
// D2 — la priorité d'une demande faite par une personne, et le refus de doublon
// ---------------------------------------------------------------------------

test('une demande à la main passe devant les programmées qui attendent, sans interrompre celle qui tourne', async () => {
  remiseAZero();
  registry.saveConfig(user.id, ID_SONDE(1), { username: 'sonde', marque: ID_SONDE(1), attenteMs: '250' });

  // La programmée n°1 démarre tout de suite ; 2 et 3 s'alignent derrière.
  const p1 = scheduler.runForUser(user.id, ID_SONDE(1), 'cron');
  const p2 = scheduler.runForUser(user.id, ID_SONDE(2), 'cron');
  const p3 = scheduler.runForUser(user.id, ID_SONDE(3), 'cron');
  // La demande d'une personne arrive APRÈS : elle doit doubler 2 et 3, pas 1.
  const p4 = scheduler.runForUser(user.id, ID_SONDE(4), 'manual');

  const attente = scheduler.attentePour(user.id, ID_SONDE(4));
  assert.ok(attente, 'la demande manuelle attend bien son tour');
  assert.equal(attente.devant, 1, 'devant elle : la seule qui tourne — jamais les programmées en file');

  const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
  for (const r of [r1, r2, r3, r4]) assert.equal(r.ok, true, r.message);

  const g = globalThis.__lot90;
  assert.equal(g.max, 1);
  assert.deepEqual(
    g.ordre,
    [ID_SONDE(1), ID_SONDE(4), ID_SONDE(2), ID_SONDE(3)],
    'la morsure : sans priorité, l\'ordre serait 1, 2, 3, 4 — et la session fraîche de la personne mourrait en file'
  );

  registry.saveConfig(user.id, ID_SONDE(1), { username: 'sonde', marque: ID_SONDE(1), attenteMs: '20' });
});

test('une même paire ne figure qu\'UNE fois : la redemander répond qu\'elle y est déjà', async () => {
  remiseAZero();
  registry.saveConfig(user.id, ID_SONDE(1), { username: 'sonde', marque: ID_SONDE(1), attenteMs: '250' });

  const p1 = scheduler.runForUser(user.id, ID_SONDE(1), 'cron');
  const p2 = scheduler.runForUser(user.id, ID_SONDE(2), 'cron');

  // Redemander celle qui TOURNE : le refus historique, inchangé.
  await assert.rejects(
    () => scheduler.runForUser(user.id, ID_SONDE(1), 'manual'),
    (err) => err.alreadyRunning === true && err.statusCode === 409
  );

  // Redemander celle qui ATTEND : elle n'est pas ajoutée, et la réponse le dit.
  const enFileAvant = scheduler.enAttente;
  await assert.rejects(
    () => scheduler.runForUser(user.id, ID_SONDE(2), 'manual'),
    (err) =>
      err.enFile === true
      && err.statusCode === 409
      && /déjà en attente/.test(err.message)
      && /à son tour/.test(err.message)
  );
  assert.equal(scheduler.enAttente, enFileAvant, 'pas une entrée de plus');

  // Et pendant qu'elle attend, l'écran a de quoi le dire : l'attente est
  // exposée partout où « en cours » l'était.
  const attente = scheduler.attentePour(user.id, ID_SONDE(2));
  assert.ok(attente && attente.devant >= 1);
  const paires = scheduler.pairesEnAttente();
  assert.equal(paires.length, 1);
  assert.equal(paires[0].connectorId, ID_SONDE(2));
  const operations = require('../server/operations');
  const ops = operations.operationsPour(user);
  const opAttente = ops.find((o) => o.etat === 'en-attente');
  assert.ok(opAttente, 'le bandeau des opérations doit montrer l\'attente');
  assert.match(opAttente.detail, /passe avant elle/, 'en toutes lettres, sans vocabulaire technique');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true, r1.message);
  assert.equal(r2.ok, true, r2.message);
  registry.saveConfig(user.id, ID_SONDE(1), { username: 'sonde', marque: ID_SONDE(1), attenteMs: '20' });
});

// ---------------------------------------------------------------------------
// D3 — la limite compte depuis le VRAI départ, et libère la file
// ---------------------------------------------------------------------------

test('une exécution qui dépasse la limite est close, et la SUIVANTE part', async () => {
  remiseAZero();
  registry.saveConfig(user.id, ID_SONDE(5), { username: 'sonde', marque: ID_SONDE(5), attenteMs: '4000' });
  process.env.CRABE_LIMITE_EXECUTION_MS = '80';
  try {
    const p5 = scheduler.runForUser(user.id, ID_SONDE(5), 'cron');
    const p6 = scheduler.runForUser(user.id, ID_SONDE(6), 'cron');
    const [r5, r6] = await Promise.all([p5, p6]);

    assert.equal(r5.ok, false);
    assert.match(r5.message, /arrêtée/i, 'la ligne est close avec le message existant du lot 67');
    assert.equal(r6.ok, true, `la file est libérée : ${r6.message}`);
  } finally {
    delete process.env.CRABE_LIMITE_EXECUTION_MS;
    registry.saveConfig(user.id, ID_SONDE(5), { username: 'sonde', marque: ID_SONDE(5), attenteMs: '20' });
  }
});

test('attendre son tour PLUS LONGTEMPS que la limite ne fait pas échouer une récupération', async () => {
  remiseAZero();
  // Limite de 150 ms, et cinq exécutions de 100 ms devant : la dernière attend
  // ~400 ms en file — bien plus que la limite — puis travaille 100 ms. Si la
  // limite comptait depuis l'entrée en file, elle serait tuée : c'est LA
  // morsure du « vrai départ ».
  process.env.CRABE_LIMITE_EXECUTION_MS = '150';
  try {
    for (const n of [7, 8, 9, 10, 11]) {
      registry.saveConfig(user.id, ID_SONDE(n), { username: 'sonde', marque: ID_SONDE(n), attenteMs: '100' });
    }
    const resultats = await Promise.all(
      [7, 8, 9, 10, 11].map((n) => scheduler.runForUser(user.id, ID_SONDE(n), 'cron'))
    );
    for (const [i, r] of resultats.entries()) {
      assert.equal(r.ok, true, `sonde n°${[7, 8, 9, 10, 11][i]} : ${r.message}`);
      assert.doesNotMatch(String(r.message), /arrêtée/i);
    }
    assert.equal(globalThis.__lot90.max, 1);
  } finally {
    delete process.env.CRABE_LIMITE_EXECUTION_MS;
    for (const n of [7, 8, 9, 10, 11]) {
      registry.saveConfig(user.id, ID_SONDE(n), { username: 'sonde', marque: ID_SONDE(n), attenteMs: '20' });
    }
  }
});

// ---------------------------------------------------------------------------
// D4 — l'arrêt et la reprise : ce qui attendait repart, UNE fois, dans l'ordre
// ---------------------------------------------------------------------------

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attend que la file soit vide et que plus rien ne tourne. */
async function attendreLaFileVide() {
  for (let i = 0; i < 100; i++) {
    const occupe = scheduler.enAttente > 0 || scheduler.runningPairs().length > 0;
    if (!occupe) return;
    await dormir(50);
  }
  assert.fail('la file ne s\'est jamais vidée');
}

test('ce qui ATTENDAIT repart au démarrage, dans l\'ordre ; ce qui TOURNAIT est en échec et ne repart pas', async () => {
  remiseAZero();

  // L'état qu'un arrêt brutal laisse derrière lui : trois demandes encore dans
  // run_queue (elles attendaient), et une ligne de run_logs restée ouverte
  // (celle qui tournait — elle, est déjà sortie de la table au départ).
  const insererAttente = db
    .get()
    .prepare('INSERT INTO run_queue (user_id, connector_id, trigger, priorite) VALUES (?, ?, ?, ?)');
  insererAttente.run(user.id, ID_SONDE(12), 'cron', 0);
  insererAttente.run(user.id, ID_SONDE(13), 'cron', 0);
  insererAttente.run(user.id, ID_SONDE(14), 'manual', 1);
  const ligneOuverte = db
    .get()
    .prepare('INSERT INTO run_logs (connector_id, user_id, trigger) VALUES (?, ?, ?)')
    .run(ID_SONDE(15), user.id, 'cron').lastInsertRowid;

  // Le démarrage : d'abord la clôture des interrompues, puis la reprise.
  scheduler.cloreLesExecutionsInterrompues();
  const reprises = scheduler.reprendreLaFile();
  assert.equal(reprises, 3);
  await attendreLaFileVide();

  const g = globalThis.__lot90;
  assert.deepEqual(
    g.ordre,
    [ID_SONDE(14), ID_SONDE(12), ID_SONDE(13)],
    'reprises une fois, priorité puis ordre d\'arrivée — et JAMAIS celle qui tournait'
  );
  assert.ok(!g.ordre.includes(ID_SONDE(15)), 'relancer celle qui a peut-être fait tomber crabe referait la boucle');

  const interrompue = db
    .get()
    .prepare('SELECT finished_at, success, message FROM run_logs WHERE id = ?')
    .get(ligneOuverte);
  assert.ok(interrompue.finished_at, 'celle qui tournait est close…');
  assert.equal(interrompue.success, 0, '…en échec, comme avant ce lot');

  // La morsure « une seule fois » : la table est vide, un second démarrage ne
  // lance rien — et un démarrage sans file non plus.
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM run_queue').get().n, 0);
  remiseAZero();
  assert.equal(scheduler.reprendreLaFile(), 0);
  await dormir(100);
  assert.deepEqual(globalThis.__lot90.ordre, [], 'un démarrage sans file ne lance RIEN');
});

// ---------------------------------------------------------------------------
// Le filet de la file : une exécution qui ne rend JAMAIS la main ne bloque pas
// les suivantes
// ---------------------------------------------------------------------------

test('le filet : une exécution muette au-delà de la limite et de sa marge libère la file', async () => {
  remiseAZero();
  // La limite du lot 67 borne le fetch — mais pas les DÉPÔTS. Un stockage qui
  // ne répond plus jamais est le seul chemin réel vers une exécution sans fin :
  // on le fabrique tel quel.
  const vraiStore = destinations.storeInvoice;
  destinations.storeInvoice = () => new Promise(() => {});
  process.env.CRABE_FILET_FILE_MS = '150';
  registry.saveConfig(user.id, ID_SONDE(21), {
    username: 'sonde', marque: ID_SONDE(21), attenteMs: '0', mode: 'document',
  });
  try {
    const p21 = scheduler.runForUser(user.id, ID_SONDE(21), 'cron');
    const p22 = scheduler.runForUser(user.id, ID_SONDE(22), 'cron');

    await assert.rejects(p21, (err) => err.filetDeFile === true && /ne répond plus/.test(err.message));
    const r22 = await p22;
    assert.equal(r22.ok, true, `la file continue sans l'exécution muette : ${r22.message}`);

    // Le verrou du couple muet reste tenu tant que l'exécution vit : rien ne
    // peut repartir sur le même profil de navigateur.
    assert.equal(scheduler.isRunning(user.id, ID_SONDE(21)), true);
  } finally {
    delete process.env.CRABE_FILET_FILE_MS;
    destinations.storeInvoice = vraiStore;
  }
});

