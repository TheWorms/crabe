'use strict';

/**
 * Lot 96 — pCloud avec l'application de l'utilisateur.
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 * Mesuré les 05 et 06/10/2026 : pCloud refuse désormais l'application
 * partagée du logiciel rclone, pour tout le monde (« Invalid 'client_id' »).
 * L'utilisateur renseigne la sienne sur la carte pCloud ; ce fichier prouve,
 * par les VRAIES routes de crabe et un VRAI processus (un faux rclone désigné
 * par `CRABE_RCLONE_BIN`, qui consigne ce qu'il reçoit) :
 *
 *   1. (R2, D1) l'identifiant et le secret atteignent `rclone authorize` par
 *      son ENVIRONNEMENT, jamais par ses arguments — la ligne de commande se
 *      lit par tout processus de la machine (`/proc/<pid>/cmdline`) ;
 *   2. (R3, D1) après l'autorisation, la configuration porte le jeton, la
 *      région ET l'application, chiffrés ; le bloc joué par rclone aussi ;
 *   3. (D1) sans application, la commande d'avant, à l'octet ; avec une
 *      moitié d'application, un refus AVANT rclone, dit en français ;
 *   4. (R1, D2) l'identifiant et le secret ne redescendent jamais au
 *      navigateur ; vide garde, une valeur neuve remplace ;
 *   5. (R4, D5) Dropbox — un autre cloud à jeton — garde sa commande, sa
 *      bannière et son formulaire ;
 *   6. (B3, D6) les valeurs d'essai ne sortent nulle part : réponses de
 *      l'API, journal applicatif, journal des stockages, messages de la
 *      fenêtre, arguments du processus.
 *
 * Aucune requête ne part vers pCloud ; aucun vrai `rclone authorize` n'est
 * lancé. La fenêtre visible est remplacée le temps du fichier (comme au
 * lot 48). Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CRABE_COPIE_DELAI_MS = '0';

// Le faux rclone se pose AVANT tout require de crabe (config.js lit le chemin
// du binaire au chargement).
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot96-app-'));
const ETAT_FAUX = path.join(RACINE_FAUX, 'etat-faux-rclone.json');
const JOURNAL_FAUX = path.join(RACINE_FAUX, 'journal-faux-rclone.jsonl');
process.env.CRABE_FAUX_ETAT = ETAT_FAUX;
process.env.CRABE_FAUX_JOURNAL = JOURNAL_FAUX;

const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

/** Les valeurs d'essai : inventées, et reconnaissables partout. */
const ID_ESSAI = 'ID-APPLI-ESSAI-7Q4Z';
const SECRET_ESSAI = 'SECRET-APPLI-ESSAI-9K2W';
const JETON_ESSAI = '{"access_token":"JETON-PCLOUD-ESSAI-3X8V","token_type":"bearer","expiry":"0001-01-01T00:00:00Z"}';

/**
 * Le faux rclone. `authorize` consigne ce qu'il a reçu — ses arguments, sa
 * ligne de commande telle que les autres processus la lisent
 * (`/proc/self/cmdline`), et les variables qui portent une application —
 * puis joue le scénario de l'état : rendre un jeton (`jeton`), échouer avec
 * une ligne d'erreur (`refus`), ou attendre qu'on le tue (`attendre`).
 * `mkdir` consigne le bloc de configuration qu'on lui a donné : c'est le bloc
 * des dépôts.
 */
fs.writeFileSync(
  FAUX_RCLONE,
  `#!/usr/bin/env node
const fs = require('node:fs');
const ecrire = (fd, s) => { const b = Buffer.from(s); let n = 0; while (n < b.length) n += fs.writeSync(fd, b, n, b.length - n); };
const TYPES = ${JSON.stringify(CATALOGUE)};
// Les chemins sont écrits EN DUR : crabe lance \`authorize\` avec un
// environnement réduit (PATH, HOME, les réponses préalables), où les
// variables de ce fichier d'essai n'arrivent pas.
const ETAT = ${JSON.stringify(ETAT_FAUX)};
const JOURNAL = ${JSON.stringify(JOURNAL_FAUX)};
const consigner = (o) => fs.appendFileSync(JOURNAL, JSON.stringify(o) + '\\n');
let argv = process.argv.slice(2);
let conf = null;
const i = argv.indexOf('--config');
if (i >= 0) { conf = argv[i + 1]; argv = argv.filter((_, j) => j !== i && j !== i + 1); }
if (argv.includes('providers')) { ecrire(1, JSON.stringify(TYPES)); process.exit(0); }
const cmd = argv[0];
if (cmd === 'version') { ecrire(1, 'rclone v1.75.0-faux\\n'); process.exit(0); }
if (cmd === 'obscure') { ecrire(1, 'OBSCURCI\\n'); process.exit(0); }
const etat = JSON.parse(fs.readFileSync(ETAT, 'utf8'));
if (cmd === 'authorize') {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^RCLONE_/.test(k)) env[k] = process.env[k];
  consigner({
    cmd,
    argv,
    cmdline: fs.readFileSync('/proc/self/cmdline', 'utf8').split('\\0').filter(Boolean),
    cles: Object.keys(process.env).sort(),
    env,
  });
  ecrire(2, '2026/10/06 15:00:00 NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=essai96\\n');
  if (etat.authorize === 'attendre') { setInterval(() => {}, 1000); return; }
  setTimeout(() => {
    if (etat.authorize === 'refus') { ecrire(2, etat.erreur + '\\n'); process.exit(1); }
    ecrire(1, 'Paste the following into your remote machine --->\\n' + etat.jeton + '\\n<---End paste\\n');
    process.exit(0);
  }, 300);
  return;
}
if (cmd === 'mkdir') {
  consigner({ cmd, argv, bloc: conf ? fs.readFileSync(conf, 'utf8') : null });
  process.exit(0);
}
consigner({ cmd, argv });
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const autorisation = require('../server/destinations/autorisation');
const presets = require('../server/destinations/presets');
const remoteBrowser = require('../server/remote-browser');
const crypto = require('../server/crypto');

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const ecrireEtat = (etat) => fs.writeFileSync(ETAT_FAUX, JSON.stringify(etat));
const journalFaux = () => fs.readFileSync(JOURNAL_FAUX, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const viderJournalFaux = () => fs.writeFileSync(JOURNAL_FAUX, '');

/**
 * La fenêtre visible, remplacée le temps du fichier : elle s'« ouvre »
 * aussitôt, voit passer la région européenne dans la redirection (comme la
 * vraie, lot 34), et retient les conclusions.
 */
const fenetre = {
  demarrages: [],
  conclusions: [],
  session: null,
  start: async (opts) => {
    fenetre.demarrages.push(opts);
    fenetre.session = { opts, indiceRegion: 'eapi.pcloud.com' };
    return {
      sessionId: 'essai96',
      connectorId: opts.connectorId,
      connectorName: opts.connectorName,
      state: 'running',
      message: 'Fenêtre ouverte.',
      hint: opts.hint,
      done: false,
    };
  },
  conclure: async (userId, connectorId, resultat) => {
    fenetre.conclusions.push(resultat);
    fenetre.session = null;
  },
  sessionFor: () => fenetre.session,
  status: (userId, connectorId) => (fenetre.session
    ? { connectorId, state: 'running', hint: fenetre.session.opts.hint, message: '' }
    : null),
  stop: async () => {
    const session = fenetre.session;
    fenetre.session = null;
    if (session) await session.opts.onFin('cancelled');
    return { state: 'cancelled', done: true };
  },
};
const VRAI_MANAGER = remoteBrowser.manager;

let client;
const reponses = [];

/** Une requête à l'API, dont la réponse est gardée pour la fouille de B3. */
async function api(methode, chemin, corps) {
  const r = await client.request(methode, chemin, corps);
  reponses.push({ chemin, status: r.status, body: r.body });
  return r;
}

/** La configuration déchiffrée telle qu'elle vit en base. */
function confStockee(destId) {
  const ligne = helpers.db.get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
}

/** Une carte pCloud créée par la vraie route, et enregistrée comme le fait l'écran. */
async function carte(provider, corps = {}) {
  const cree = await api('POST', '/api/admin/destinations', { provider, ...corps.creation });
  assert.equal(cree.status, 200, JSON.stringify(cree.body));
  const id = cree.body.destination.id;
  const enregistre = await api('PUT', `/api/admin/destinations/${id}`, {
    enabled: true,
    remoteName: 'crabe',
    basePath: path.join(RACINE_FAUX, `cloud-${id}`),
    rcloneConfig: '',
    valeurs: corps.valeurs || {},
  });
  assert.equal(enregistre.status, 200, JSON.stringify(enregistre.body));
  return id;
}

/** Attend la conclusion de la fenêtre (ou échoue au bout de 10 s). */
async function conclusion() {
  for (let i = 0; i < 100 && !fenetre.conclusions.length; i++) await attendre(100);
  assert.equal(fenetre.conclusions.length, 1, 'la fenêtre a conclu une fois');
  return fenetre.conclusions[0];
}

function remettreFenetre() {
  fenetre.demarrages.length = 0;
  fenetre.conclusions.length = 0;
  fenetre.session = null;
}

test.before(async () => {
  await helpers.setup();
  remoteBrowser.manager = () => fenetre;
  ecrireEtat({ authorize: 'jeton', jeton: JETON_ESSAI });
  viderJournalFaux();
  require('../server/destinations/backends').oublier();

  const admin = await helpers.createUser({ username: 'lot96admin', plainPassword: 'MotDePasse1', role: 'admin' });
  helpers.db.get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(require('../server/permissions').roleBySlug('admin').id, admin.id);
  client = await helpers.startServer();
  const connexion = await helpers.login(client, 'lot96admin', 'MotDePasse1');
  assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
});

test.after(async () => {
  remoteBrowser.manager = VRAI_MANAGER;
  await client.close();
  helpers.teardown();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R1 — les deux champs de la carte pCloud
// ---------------------------------------------------------------------------

test('R1 — la carte pCloud porte « Identifiant de l\'application » et « Secret de l\'application », au premier niveau, secrets', async () => {
  const id = await carte('pcloud');
  const champs = await destinations.champsDe(id);
  const de = (cle) => champs.find((c) => c.key === cle);

  for (const [cle, libelle] of [['client_id', 'Identifiant de l\'application'], ['client_secret', 'Secret de l\'application']]) {
    assert.equal(de(cle).label, libelle);
    assert.equal(de(cle).avance, false, `${cle} au premier niveau`);
    assert.equal(de(cle).type, 'password', `${cle} est un secret : jamais réaffiché`);
    assert.equal(de(cle).obscurcir, false, `${cle} n'est pas obscurci : rclone le lit en clair`);
    assert.equal(de(cle).required, false, `${cle} reste facultatif pour le formulaire`);
  }
  // L'aide le dit dès sa première ligne : sans eux, pCloud refuse aujourd'hui.
  const premiereLigne = de('client_id').help.split('\n')[0];
  assert.match(premiereLigne, /^Indispensable aujourd'hui : pCloud n'accepte plus l'application partagée/);
  assert.match(premiereLigne, /« Invalid 'client_id' »/);
  // Le chemin, en peu de mots (R7) : la page, la redirection, la recopie, le bouton, l'accès complet.
  const aide = de('client_id').help;
  assert.ok(aide.includes('https://docs.pcloud.com/my_apps/'));
  assert.ok(aide.includes('approuve à la main'));
  assert.ok(aide.includes('http://localhost:53682/'));
  assert.ok(aide.includes('« This \'redirect_uri\' is not autorized. »'));
  assert.ok(aide.includes('« Se connecter à pCloud »'));
  assert.ok(aide.includes('accès complet'));
  // La région reste au premier niveau ; le jeton reste en « Réglages avancés ».
  assert.equal(de('hostname').avance, false);
  assert.equal(de('token').avance, true);
});

// ---------------------------------------------------------------------------
// R2, R3 — l'autorisation avec l'application, par la vraie route
// ---------------------------------------------------------------------------

test('D1 — par la vraie route : l\'application part dans l\'ENVIRONNEMENT d\'rclone, jamais dans ses arguments, et la configuration la garde', async () => {
  remettreFenetre();
  viderJournalFaux();
  ecrireEtat({ authorize: 'jeton', jeton: JETON_ESSAI });
  const id = await carte('pcloud', {
    valeurs: { client_id: ID_ESSAI, client_secret: SECRET_ESSAI, hostname: 'eapi.pcloud.com' },
  });

  const ouverte = await api('POST', `/api/admin/destinations/${id}/autorisation`);
  assert.equal(ouverte.status, 200, JSON.stringify(ouverte.body));
  const etatPendant = await api('GET', `/api/admin/destinations/${id}/autorisation`);
  const fin = await conclusion();
  assert.equal(fin.ok, true, fin.message);
  assert.equal(fin.message, 'pCloud est connecté : le dossier de crabe est créé, l\'accès en écriture '
    + 'est vérifié. La clé d\'accès est rangée, chiffrée — vous pouvez fermer.');

  const lance = journalFaux().find((l) => l.cmd === 'authorize');
  assert.ok(lance, 'le faux rclone a été lancé');
  // La commande : celle d'avant, à l'octet — l'application n'y est pas.
  assert.deepEqual(lance.argv, ['authorize', 'pcloud', '--auth-no-open-browser']);
  assert.equal(lance.cmdline.join(' ').includes(ID_ESSAI), false, 'l\'identifiant n\'est pas lisible dans /proc/<pid>/cmdline');
  assert.equal(lance.cmdline.join(' ').includes(SECRET_ESSAI), false, 'le secret non plus');
  // L'environnement : exactement l'identifiant et le secret d'essai, sous les
  // noms que la documentation d'rclone donne (mesurés en A4), et la région.
  assert.equal(lance.env.RCLONE_PCLOUD_CLIENT_ID, ID_ESSAI);
  assert.equal(lance.env.RCLONE_PCLOUD_CLIENT_SECRET, SECRET_ESSAI);
  assert.equal(lance.env.RCLONE_PCLOUD_HOSTNAME, 'eapi.pcloud.com');
  assert.deepEqual(Object.keys(lance.env).sort(),
    ['RCLONE_PCLOUD_CLIENT_ID', 'RCLONE_PCLOUD_CLIENT_SECRET', 'RCLONE_PCLOUD_HOSTNAME']);
  // La bannière de la fenêtre dit les deux erreurs que crabe ne voit pas.
  assert.equal(fenetre.demarrages[0].hint,
    'Connectez-vous à pCloud dans cette fenêtre, puis autorisez l\'accès. La fenêtre se fermera '
    + 'toute seule — la clé d\'accès est rangée chiffrée, elle ne s\'affiche jamais.'
    + autorisation.BANNIERE_PCLOUD);

  // R3 — la configuration rangée porte le jeton, la région et l'application…
  const conf = confStockee(id);
  assert.equal(conf.valeurs.token, JETON_ESSAI);
  assert.equal(conf.valeurs.hostname, 'eapi.pcloud.com');
  assert.equal(conf.valeurs.client_id, ID_ESSAI);
  assert.equal(conf.valeurs.client_secret, SECRET_ESSAI);
  // … chiffrés au repos : la colonne lue en base ne les porte pas en clair.
  const brut = helpers.db.get().prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?').get(id).config_encrypted;
  assert.match(brut, /^v1\./);
  for (const valeur of [ID_ESSAI, SECRET_ESSAI, 'JETON-PCLOUD-ESSAI-3X8V', 'eapi.pcloud.com']) {
    assert.equal(brut.includes(valeur), false, `« ${valeur} » n'est pas en clair en base`);
  }
  // … et le bloc que rclone joue ensuite (le mkdir du dossier de crabe, le
  // même que les dépôts) porte les quatre.
  const mkdir = journalFaux().find((l) => l.cmd === 'mkdir');
  assert.ok(mkdir, 'le dossier de crabe a été créé dans la foulée');
  assert.match(mkdir.bloc, new RegExp(`^client_id = ${ID_ESSAI}$`, 'm'));
  assert.match(mkdir.bloc, new RegExp(`^client_secret = ${SECRET_ESSAI}$`, 'm'));
  assert.match(mkdir.bloc, /^hostname = eapi\.pcloud\.com$/m);
  assert.match(mkdir.bloc, /^token = \{"access_token":"JETON-PCLOUD-ESSAI-3X8V"/m);
  // L'état de la fenêtre a été lu pendant l'autorisation (fouillé en B3).
  assert.ok([200, 404].includes(etatPendant.status));
});

test('D1 — sans les deux champs : la commande et l\'environnement d\'avant, à l\'octet', async () => {
  remettreFenetre();
  viderJournalFaux();
  ecrireEtat({ authorize: 'jeton', jeton: JETON_ESSAI });
  const id = await carte('pcloud', { valeurs: { hostname: 'eapi.pcloud.com' } });

  const ouverte = await api('POST', `/api/admin/destinations/${id}/autorisation`);
  assert.equal(ouverte.status, 200, JSON.stringify(ouverte.body));
  await conclusion();

  const lance = journalFaux().find((l) => l.cmd === 'authorize');
  assert.deepEqual(lance.argv, ['authorize', 'pcloud', '--auth-no-open-browser']);
  assert.deepEqual(lance.env, { RCLONE_PCLOUD_HOSTNAME: 'eapi.pcloud.com' },
    'aucune variable d\'application : rclone emploie la sienne, comme avant');
  // Le strict nécessaire d'avant ce lot (PATH, HOME) et la région — rien d'autre.
  const nonSysteme = lance.cles.filter((k) => !['PATH', 'HOME'].includes(k) && !/^(_|PWD|SHLVL|NODE_|OLDPWD)/.test(k));
  assert.deepEqual(nonSysteme, ['RCLONE_PCLOUD_HOSTNAME']);
});

test('D1 — avec un seul des deux : refusé AVANT de lancer rclone, et dit à l\'utilisateur', async () => {
  for (const [valeurs, manque] of [
    [{ client_id: ID_ESSAI }, 'le « Secret de l\'application » n\'est pas renseigné'],
    [{ client_secret: SECRET_ESSAI }, 'l\'« Identifiant de l\'application » n\'est pas renseigné'],
  ]) {
    remettreFenetre();
    viderJournalFaux();
    const id = await carte('pcloud', { valeurs });
    const refus = await api('POST', `/api/admin/destinations/${id}/autorisation`);
    assert.equal(refus.status, 400, JSON.stringify(refus.body));
    assert.equal(refus.body.error,
      'Pour se connecter à pCloud avec votre propre application pCloud, crabe a besoin de son '
      + `identifiant ET de son secret : ${manque}. Recopiez-le depuis la page de votre `
      + 'application chez pCloud (https://docs.pcloud.com/my_apps/) sur la carte de ce stockage, '
      + 'puis relancez la connexion. Rien n\'a été lancé.');
    assert.equal(journalFaux().filter((l) => l.cmd === 'authorize').length, 0, 'rclone n\'a pas été lancé');
    assert.equal(fenetre.demarrages.length, 0, 'aucune fenêtre ouverte');
    assert.equal(autorisation.enCours(), null);
  }
});

test('R3 — un bloc collé reçoit l\'application recopiée dans les champs, sans écraser ses propres lignes', () => {
  const id = destinations.createCloud({ provider: 'pcloud' }).id;
  destinations.saveConfig(id, {
    enabled: true,
    rcloneConfig: 'type = pcloud\nhostname = eapi.pcloud.com',
    valeurs: { client_id: ID_ESSAI, client_secret: SECRET_ESSAI },
  }, [{ key: 'client_id', type: 'password' }, { key: 'client_secret', type: 'password' }]);

  // L'autorisation lit l'application là où elle est : le bloc d'abord, les champs sinon.
  const fiche = destinations.pourAutorisation(id);
  assert.equal(fiche.valeurs.client_id, ID_ESSAI);
  assert.equal(fiche.valeurs.client_secret, SECRET_ESSAI);

  destinations.enregistrerJeton(id, JETON_ESSAI, 'eapi.pcloud.com');
  const bloc = confStockee(id).rcloneConfig;
  assert.match(bloc, new RegExp(`^client_id = ${ID_ESSAI}$`, 'm'));
  assert.match(bloc, new RegExp(`^client_secret = ${SECRET_ESSAI}$`, 'm'));
  assert.match(bloc, /^token = /m);

  // Une ligne déjà dans le bloc n'est jamais remplacée par les champs.
  const autre = destinations.createCloud({ provider: 'pcloud' }).id;
  destinations.saveConfig(autre, {
    enabled: true,
    rcloneConfig: 'type = pcloud\nclient_id = ID-DU-BLOC-ESSAI\nclient_secret = SECRET-DU-BLOC-ESSAI',
    valeurs: { client_id: ID_ESSAI, client_secret: SECRET_ESSAI },
  }, [{ key: 'client_id', type: 'password' }, { key: 'client_secret', type: 'password' }]);
  assert.equal(destinations.pourAutorisation(autre).valeurs.client_id, 'ID-DU-BLOC-ESSAI');
  destinations.enregistrerJeton(autre, JETON_ESSAI, null);
  const blocAutre = confStockee(autre).rcloneConfig;
  assert.equal((blocAutre.match(/^client_id =/gm) || []).length, 1);
  assert.match(blocAutre, /^client_id = ID-DU-BLOC-ESSAI$/m);
});

// ---------------------------------------------------------------------------
// D2 — le secret, par l'API de crabe
// ---------------------------------------------------------------------------

test('D2 — jamais réaffichés ; vide garde la valeur ; une valeur neuve la remplace ; « Effacer » efface', async () => {
  const id = await carte('pcloud', { valeurs: { client_id: ID_ESSAI, client_secret: SECRET_ESSAI } });

  const lecture = await api('GET', '/api/admin/destinations');
  const vue = lecture.body.destinations.find((d) => d.id === id);
  assert.equal('client_id' in vue.valeurs, false, 'l\'identifiant ne redescend pas');
  assert.equal('client_secret' in vue.valeurs, false, 'le secret non plus');
  assert.ok(vue.secretsRenseignes.includes('client_id'), 'la carte sait qu\'une valeur est là');
  assert.ok(vue.secretsRenseignes.includes('client_secret'));
  assert.equal(JSON.stringify(lecture.body).includes(ID_ESSAI), false);
  assert.equal(JSON.stringify(lecture.body).includes(SECRET_ESSAI), false);

  // Vide = « garde celui d'avant ».
  await api('PUT', `/api/admin/destinations/${id}`, {
    enabled: true, remoteName: 'crabe', basePath: 'crabe', rcloneConfig: '',
    valeurs: { client_id: '', client_secret: '', hostname: 'eapi.pcloud.com' },
  });
  assert.equal(confStockee(id).valeurs.client_id, ID_ESSAI);
  assert.equal(confStockee(id).valeurs.client_secret, SECRET_ESSAI);

  // Une valeur neuve remplace.
  await api('PUT', `/api/admin/destinations/${id}`, {
    enabled: true, remoteName: 'crabe', basePath: 'crabe', rcloneConfig: '',
    valeurs: { client_id: '', client_secret: 'SECRET-NEUF-ESSAI-5T1R' },
  });
  assert.equal(confStockee(id).valeurs.client_id, ID_ESSAI, 'l\'identifiant laissé vide est gardé');
  assert.equal(confStockee(id).valeurs.client_secret, 'SECRET-NEUF-ESSAI-5T1R');

  // « Effacer la valeur enregistrée » efface.
  await api('PUT', `/api/admin/destinations/${id}`, {
    enabled: true, remoteName: 'crabe', basePath: 'crabe', rcloneConfig: '',
    valeurs: {}, effacer: ['client_secret'],
  });
  assert.equal(confStockee(id).valeurs.client_secret, undefined);
  assert.equal(confStockee(id).valeurs.client_id, ID_ESSAI);
});

// ---------------------------------------------------------------------------
// R4, D5 — Dropbox, un autre cloud à jeton : rien ne change
// ---------------------------------------------------------------------------

test('D5 — Dropbox : même commande, même environnement, même bannière, même formulaire qu\'avant', async () => {
  remettreFenetre();
  viderJournalFaux();
  ecrireEtat({ authorize: 'jeton', jeton: '{"access_token":"JETON-DROPBOX-ESSAI","refresh_token":"R"}' });
  const id = await carte('autre', {
    creation: { type: 'dropbox' },
    valeurs: { client_id: 'ID-DROPBOX-ESSAI', client_secret: 'SECRET-DROPBOX-ESSAI' },
  });

  const ouverte = await api('POST', `/api/admin/destinations/${id}/autorisation`);
  assert.equal(ouverte.status, 200, JSON.stringify(ouverte.body));
  await conclusion();

  const lance = journalFaux().find((l) => l.cmd === 'authorize');
  assert.deepEqual(lance.argv, ['authorize', 'dropbox', '--auth-no-open-browser']);
  assert.deepEqual(lance.env, {}, 'rien de neuf dans l\'environnement : la machinerie OAuth reste écartée');
  assert.equal(fenetre.demarrages[0].hint,
    'Connectez-vous à Dropbox dans cette fenêtre, puis autorisez l\'accès. La fenêtre se fermera '
    + 'toute seule — la clé d\'accès est rangée chiffrée, elle ne s\'affiche jamais.',
    'la bannière d\'avant, à l\'octet');

  // Le formulaire de Dropbox : les champs d'rclone, sans habillage.
  const champs = await destinations.champsDe(id);
  for (const cle of ['client_id', 'client_secret']) {
    const c = champs.find((x) => x.key === cle);
    assert.equal(c.label, cle, 'le libellé d\'rclone, pas celui de pCloud');
    assert.equal(c.type, 'text');
  }
  assert.equal(champs.some((c) => /de l'application/.test(c.label)), false,
    'les deux champs de pCloud n\'y apparaissent pas');
  assert.equal(presets.habiller('dropbox', [{ key: 'client_id', label: 'client_id' }])[0].label, 'client_id');
});

test('D5 — la bannière de pCloud dit les deux erreurs de la fenêtre ; celle des autres ne change pas', () => {
  assert.equal(autorisation.BANNIERE_PCLOUD,
    ' Si la page de pCloud affiche « Invalid \'client_id\' », renseignez votre propre application '
    + 'pCloud sur la carte de ce stockage ; si elle affiche « This \'redirect_uri\' is not '
    + 'autorized. », déclarez http://localhost:53682/ dans les réglages de votre application. '
    + 'Fermez alors cette fenêtre (« Fermer / Abandonner »).');
  assert.deepEqual([...autorisation.TYPES_A_APPLICATION], ['pcloud'], 'pCloud seul : le seul mesuré');
  assert.deepEqual(autorisation.applicationDe('dropbox', { client_id: 'X', client_secret: 'Y' }), { etat: 'sans-objet' });
  assert.deepEqual(autorisation.applicationDe('zoho', { client_id: 'X', client_secret: 'Y' }), { etat: 'sans-objet' });
  assert.deepEqual(autorisation.variablesApplication('dropbox', { etat: 'sans-objet' }), {});
});

// ---------------------------------------------------------------------------
// B3, D6 — les valeurs d'essai ne sortent nulle part
// ---------------------------------------------------------------------------

test('D6 — un échec d\'autorisation qui CITE le secret : la phrase et le journal le masquent', async () => {
  remettreFenetre();
  viderJournalFaux();
  // Le pire cas : rclone recopierait l'application dans son erreur.
  ecrireEtat({
    authorize: 'refus',
    erreur: `2026/10/06 15:00:01 Error: failed to get token: oauth2: cannot fetch token: client_id=${ID_ESSAI}&client_secret=${SECRET_ESSAI}`,
  });
  const id = await carte('pcloud', { valeurs: { client_id: ID_ESSAI, client_secret: SECRET_ESSAI } });
  const ouverte = await api('POST', `/api/admin/destinations/${id}/autorisation`);
  assert.equal(ouverte.status, 200, JSON.stringify(ouverte.body));
  const fin = await conclusion();
  assert.equal(fin.ok, false);
  assert.match(fin.message, /^La connexion à pCloud n'a pas abouti \(failed to get token: oauth2: cannot fetch token: client_id=\[masqué\]&client_secret=\[masqué\]\)\./);
  assert.equal(fin.message.includes(ID_ESSAI), false);
  assert.equal(fin.message.includes(SECRET_ESSAI), false);
});

test('B3 — rien ne porte l\'identifiant ni le secret d\'essai : API, journaux, fenêtre, arguments', async () => {
  // Une erreur rendue à l'écran pendant la fouille : la moitié d'application.
  const id = await carte('pcloud', { valeurs: { client_id: ID_ESSAI } });
  await api('POST', `/api/admin/destinations/${id}/autorisation`);
  // La lecture de la fiche, après tout ce qui précède.
  await api('GET', '/api/admin/destinations');

  const fouille = {
    api: reponses,
    applog: helpers.db.get().prepare('SELECT * FROM app_logs').all(),
    stockage: helpers.db.get().prepare('SELECT * FROM destination_logs').all(),
    fenetre: { demarrages: fenetre.demarrages.map((o) => ({ ...o, onFin: undefined })), conclusions: fenetre.conclusions },
    arguments: journalFaux().map((l) => ({ argv: l.argv, cmdline: l.cmdline })),
  };
  const texte = JSON.stringify(fouille);
  assert.ok(reponses.length >= 15, `la fouille porte sur ${reponses.length} réponses de l'API`);
  assert.ok(fouille.applog.length > 0, 'le journal applicatif n\'est pas vide');
  for (const valeur of [ID_ESSAI, SECRET_ESSAI, 'SECRET-NEUF-ESSAI-5T1R', 'JETON-PCLOUD-ESSAI-3X8V']) {
    assert.equal(texte.includes(valeur), false, `« ${valeur} » est sorti`);
  }
});
