'use strict';

/**
 * Copie automatique vers les destinations secondaires (lot 10, §4).
 *
 * Jusqu'ici, un document récupéré atterrissait sur le stockage local et **rien** ne le
 * copiait ailleurs : la donnée existait — la colonne `destinations` de la table
 * `invoices` —, le mécanisme non. D'où les pastilles grises « état inconnu ».
 *
 * Ce que ce fichier verrouille :
 *
 *   1. **la copie part dans la foulée** vers chaque destination secondaire
 *      activée, sans intervention, dans la même arborescence — année comprise ;
 *   2. **trois tentatives, puis on s'arrête.** Un cloud injoignable ne doit ni
 *      bloquer la récupération, ni provoquer un acharnement ;
 *   3. **aucune reprise automatique ensuite.** C'est le point le plus facile à
 *      casser sans s'en apercevoir : une exécution suivante ne doit pas
 *      retenter les copies en échec ;
 *   4. **le forçage manuel**, par destination et global, sans lancement
 *      concurrent, avec son compte rendu ;
 *   5. **l'état par document et par destination**, sans jamais inventer un
 *      succès que personne n'a mesuré.
 *
 * Les destinations réelles (Proton Drive, pCloud) n'ont jamais été configurées
 * sur l'installation : le pilote est donc remplacé par un double, ce qui permet
 * de vérifier le COMPORTEMENT de crabe — le nombre de tentatives, l'absence de
 * reprise — sans dépendre de rclone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Les trois secondes d'attente entre deux tentatives feraient durer ce fichier
// une minute pour rien : le délai est réglable, et il vaut zéro ici.
process.env.CRABE_COPIE_DELAI_MS = '0';

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const sync = require('../server/destinations/sync');
const invoicesLib = require('../server/invoices');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');

/**
 * L'identifiant du cloud de test, connu seulement à l'exécution.
 *
 * ⚠ Il était écrit `'pcloud'` en dur jusqu'au lot 24, quand les destinations
 * étaient six constantes du code. Depuis le lot 25 elles sont des lignes créées
 * à la demande, avec un identifiant tiré au sort : le test crée la sienne et
 * garde ce que la création lui rend. C'est aussi ce que fait un utilisateur.
 */
let PCLOUD;

/** Le vrai pilote du cloud de test, remis en place après chaque manipulation. */
let VRAI_PCLOUD;

let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'copies' });

  // Un cloud activé et « configuré » : c'est ce que regarde activeDestinations().
  PCLOUD = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud' });
  VRAI_PCLOUD = destinations.driverFor(PCLOUD);
});

test.after(() => {
  destinations.DRIVERS[PCLOUD] = VRAI_PCLOUD;
  helpers.teardown();
});

/**
 * Remplace le pilote du cloud de test par un double.
 * @param {(target: object, essai: number) => object} reponse
 */
function doublerPcloud(reponse) {
  const appels = [];
  destinations.DRIVERS[PCLOUD] = {
    ...VRAI_PCLOUD,
    async store(conf, target) {
      appels.push({ filename: target.filename, année: target.issuedOn });
      return reponse(target, appels.length);
    },
  };
  return appels;
}

/** Attend la fin de la synchronisation lancée en fond. */
async function attendreSync() {
  for (let i = 0; i < 200 && sync.isRunning(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sync.isRunning(), false, 'la synchronisation doit se terminer');
  return sync.progress();
}

/** Une facture déposée sur le stockage local, et sa ligne en base. */
function deposer({ filename, issuedOn, destinationsJson = '{"local":{"state":"ok","ok":true}}' }) {
  const root = destinations.readConfig('local').path;
  const cible = path.join(
    root,
    'copies',
    'EDF',
    'client',
    String(issuedOn).slice(0, 4),
    filename
  );
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, '%PDF-1.4 faux document');

  const dests = JSON.parse(destinationsJson);
  dests.local = { ...(dests.local || {}), path: cible };

  return helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'edf', ?, ?, 'client', 22, ?, ?)`
    )
    .run(user.id, filename, `edf-${filename}`, issuedOn, JSON.stringify(dests)).lastInsertRowid;
}

function relire(id) {
  return helpers.db.get().prepare('SELECT * FROM invoices WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// 1. La copie part dans la foulée
// ---------------------------------------------------------------------------

test('un document récupéré est copié vers la destination secondaire activée', async () => {
  const appels = doublerPcloud(() => ({ ok: true, path: 'pcloud:crabe/x.pdf' }));

  const results = await destinations.storeInvoice({
    username: 'copies',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-03-05',
    filename: '2026-03_edf.pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });

  assert.equal(results.local.ok, true);
  assert.equal(results[PCLOUD].ok, true, 'la copie secondaire est partie toute seule');
  assert.equal(appels.length, 1, 'une seule tentative quand elle réussit');
});

test('la destination secondaire reçoit la MÊME arborescence, année comprise', async () => {
  let chemin = null;
  destinations.DRIVERS[PCLOUD] = {
    ...VRAI_PCLOUD,
    async store(conf, target) {
      const paths = require('../server/destinations/paths');
      chemin = paths.relativePath(target);
      return { ok: true, path: chemin };
    },
  };

  await destinations.storeInvoice({
    username: 'copies',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2025-11-05',
    filename: '2025-11_edf.pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });

  // Un miroir, pas un rangement différent.
  assert.equal(chemin, 'copies/EDF/client/2025/2025-11_edf.pdf');
});

// ---------------------------------------------------------------------------
// 2. Trois tentatives, puis abandon
// ---------------------------------------------------------------------------

test('une destination injoignable est tentée trois fois, puis abandonnée', async () => {
  const appels = doublerPcloud(() => ({ ok: false, message: 'pCloud : connexion refusée' }));

  const results = await destinations.storeInvoice({
    username: 'copies',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-04-05',
    filename: '2026-04_edf.pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });

  assert.equal(appels.length, 3, 'trois tentatives, pas une de plus');
  assert.equal(results[PCLOUD].ok, false);
  assert.match(results[PCLOUD].message, /connexion refusée/);

  // Le stockage local est obligatoire et local : une seule tentative, et la facture
  // reste évidemment valide — un échec secondaire n'est jamais une perte.
  assert.equal(results.local.ok, true);
});

test('la troisième tentative qui réussit suffit', async () => {
  const appels = doublerPcloud((target, essai) =>
    essai < 3 ? { ok: false, message: 'temporaire' } : { ok: true, path: 'pcloud:x' }
  );

  const results = await destinations.storeInvoice({
    username: 'copies',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-05-05',
    filename: '2026-05_edf.pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });

  assert.equal(appels.length, 3);
  assert.equal(results[PCLOUD].ok, true);
});

// ---------------------------------------------------------------------------
// 3. Aucune reprise automatique
// ---------------------------------------------------------------------------

test('une exécution suivante ne retente PAS les copies en échec', async () => {
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: 'client@test.local', password: 'x' });

  // Premier passage : pCloud refuse tout.
  let appels = doublerPcloud(() => ({ ok: false, message: 'cloud éteint' }));
  let run;
  for (let i = 0; i < 8; i++) {
    run = await scheduler.runForUser(user.id, 'edf', 'manual');
    if (run.ok && run.count > 0) break;
  }
  assert.equal(run.ok, true, run.message);
  assert.ok(appels.length > 0, 'des copies ont été tentées');

  const enEchec = helpers.db
    .get()
    .prepare('SELECT destinations FROM invoices WHERE user_id = ? AND connector_id = ?')
    .all(user.id, 'edf')
    .filter((r) => invoicesLib.hasFailure(r.destinations, ['local', PCLOUD]));
  assert.ok(enEchec.length > 0, 'les échecs sont enregistrés, pas oubliés');

  // Second passage, cloud toujours éteint : rien ne doit être retenté. Les
  // documents sont déjà connus, et un échec de copie ne se rejoue pas tout
  // seul — c'est le bouton « Synchroniser » qui décide.
  // La recette simulée échoue une fois sur sept environ : on rejoue jusqu'à
  // une exécution aboutie, ce qui ne change rien à ce qui est mesuré — aucune
  // de ces exécutions ne doit toucher à pCloud.
  appels = doublerPcloud(() => ({ ok: false, message: 'cloud éteint' }));
  let second;
  for (let i = 0; i < 8; i++) {
    second = await scheduler.runForUser(user.id, 'edf', 'manual');
    if (second.ok) break;
  }
  assert.equal(second.ok, true, second.message);
  assert.equal(second.count, 0, 'aucun nouveau document');
  assert.equal(appels.length, 0, 'AUCUNE reprise automatique');
});

// ---------------------------------------------------------------------------
// 4. Forçage manuel
// ---------------------------------------------------------------------------

test('« Synchroniser » envoie ce qui manque, et rend compte', async () => {
  sync.reset();
  const id = deposer({ filename: '2024-02_a-copier.pdf', issuedOn: '2024-02-01' });

  const appels = doublerPcloud(() => ({ ok: true, path: 'pcloud:crabe/x.pdf' }));
  assert.ok(sync.pendingCount(PCLOUD, user.id) > 0, 'le document est en attente');

  sync.start({ destinationIds: [PCLOUD], userId: user.id });
  const etat = await attendreSync();

  assert.ok(etat.copied >= 1, etat.message);
  assert.match(etat.message, /copié/);
  assert.ok(appels.some((a) => a.filename === '2024-02_a-copier.pdf'));

  // L'état du document dit désormais « copié », avec sa date.
  const apres = invoicesLib.statesFor(relire(id).destinations, ['local', PCLOUD]);
  const pcloud = apres.find((d) => d.id === PCLOUD);
  assert.equal(pcloud.state, 'ok');
  assert.ok(pcloud.at, 'une copie réussie est datée');
});

test('un document déjà copié n\'est pas renvoyé une seconde fois', async () => {
  sync.reset();
  const appels = doublerPcloud(() => ({ ok: true }));

  sync.start({ destinationIds: [PCLOUD], userId: user.id });
  const premier = await attendreSync();

  sync.reset();
  const seconds = doublerPcloud(() => ({ ok: true }));
  sync.start({ destinationIds: [PCLOUD], userId: user.id });
  const second = await attendreSync();

  assert.ok(premier.done >= second.done);
  assert.equal(seconds.length, 0, 'plus rien ne manque');
  assert.match(second.message, /Rien à synchroniser/);
  assert.ok(appels.length >= 0);
});

test('deux synchronisations ne peuvent pas tourner en même temps', async () => {
  sync.reset();
  deposer({ filename: '2023-06_concurrent.pdf', issuedOn: '2023-06-01' });
  doublerPcloud(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { ok: true };
  });

  sync.start({ destinationIds: [PCLOUD], userId: user.id });
  assert.throws(
    () => sync.start({ destinationIds: [PCLOUD], userId: user.id }),
    /déjà en cours/
  );
  await attendreSync();
});

test('le disjoncteur arrête d\'insister après trois échecs consécutifs', async () => {
  sync.reset();
  for (let i = 0; i < 8; i++) {
    deposer({ filename: `2022-0${i + 1}_mur.pdf`, issuedOn: `2022-0${i + 1}-01` });
  }

  const appels = doublerPcloud(() => ({ ok: false, message: 'cloud éteint' }));
  sync.start({ destinationIds: [PCLOUD], userId: user.id });
  const etat = await attendreSync();

  // Trois documents tentés, trois tentatives chacun : neuf appels, et on
  // s'arrête. Sans disjoncteur, huit documents × trois tentatives × trois
  // secondes feraient plus d'une minute pour la même erreur répétée.
  assert.equal(etat.failed, sync.ECHECS_AVANT_ARRET);
  assert.equal(appels.length, sync.ECHECS_AVANT_ARRET * 3);
  assert.ok(
    etat.errors.some((e) => /échecs consécutifs/.test(e.message)),
    'le compte rendu dit pourquoi on s\'est arrêté'
  );
});

test('sans destination secondaire activée, le bouton le dit', () => {
  sync.reset();
  assert.throws(
    () => sync.start({ destinationIds: ['local'], userId: user.id }),
    /rien à synchroniser/i
  );
});

// ---------------------------------------------------------------------------
// 5. État par document et par destination
// ---------------------------------------------------------------------------

test('un document sur le stockage local mais pas sur pCloud est immédiatement identifiable', () => {
  const id = deposer({
    filename: '2021-09_moitie.pdf',
    issuedOn: '2021-09-01',
    destinationsJson: JSON.stringify({
      local: { state: 'ok', ok: true, at: '2026-08-10T10:00:00Z' },
      [PCLOUD]: { state: 'error', ok: false, at: '2026-08-10T10:00:00Z', message: 'quota dépassé' },
    }),
  });

  const etats = invoicesLib.statesFor(relire(id).destinations, ['local', PCLOUD]);
  assert.equal(etats.find((d) => d.id === 'local').state, 'ok');

  const pcloud = etats.find((d) => d.id === PCLOUD);
  assert.equal(pcloud.state, 'error');
  assert.match(pcloud.tooltip, /quota dépassé/);
  assert.equal(invoicesLib.hasFailure(relire(id).destinations, ['local', PCLOUD]), true);
});

test('les documents antérieurs restent « inconnus », pas « copiés »', () => {
  const id = deposer({
    filename: '2020-01_ancien.pdf',
    issuedOn: '2020-01-01',
    destinationsJson: JSON.stringify({ local: { ok: true } }),
  });

  const etats = invoicesLib.statesFor(relire(id).destinations, ['local', PCLOUD]);
  // Le stockage local : succès sans état explicite → « inconnu », jamais un « ok »
  // inventé. pCloud : jamais tenté → « en attente ».
  assert.equal(etats.find((d) => d.id === 'local').state, 'unknown');
  assert.equal(etats.find((d) => d.id === PCLOUD).state, 'pending');

  // Et c'est le bouton de forçage qui les traitera.
  assert.ok(
    sync.pendingFor(PCLOUD, user.id).some((r) => r.filename === '2020-01_ancien.pdf')
  );
});

test('le bloc « Erreurs et alertes » signale les copies en échec', () => {
  const home = require('../server/home');
  const compte = helpers.db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  const echecs = home.copyFailures(compte, ['local', PCLOUD]);
  const pcloud = echecs.find((e) => e.destinationId === PCLOUD);
  assert.ok(pcloud, 'une ligne par destination en échec');
  assert.ok(pcloud.count >= 1);
  assert.equal(pcloud.name, 'pCloud');
});
