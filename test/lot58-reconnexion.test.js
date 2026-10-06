'use strict';

/**
 * Lot 58 — une session qui meurt en plein chantier se rouvre toute seule.
 *
 * ─── L'incident mesuré du 25/08/2026 au soir, APRÈS le lot 57 ───────────────
 *
 * « Tester la connexion » réussissait ; « Renommer maintenant », lancé juste
 * après, échouait au démarrage (« 401 Invalid access token » → « 400 Invalid
 * refresh token ») : Proton révoque des sessions, et la session persistée
 * meurt ENTRE deux gestes. Le lot 57 la marque morte au premier refus — le
 * geste SUIVANT repartait proprement, mais le geste qui essuyait le refus,
 * lui, s'arrêtait.
 *
 * Les règles vérifiées ici, sur un DOUBLE complet (base jetable, le stockage local
 * jetable, un cloud « Proton » servi par un faux rclone qui révoque des
 * sessions sur commande) :
 *
 *   1. session tuée en plein chantier → reconnexion immédiate (mot de passe +
 *      code calculé depuis la clé TOTP), le chantier va au bout, aucun
 *      mouvement compté deux fois, la session neuve est persistée, et tout se
 *      journalise (app_logs source `harmonisation` + journal persistant) ;
 *   2. révocation en boucle → arrêt au plafond du chantier, en le disant ;
 *   3. sans clé TOTP sur un compte à second facteur connu → arrêt au premier
 *      refus avec le message qui dit le vrai manque — et AUCUN login n'est
 *      tenté contre le service (le code à usage unique est périmé par
 *      définition) ; jamais « vérifiez votre mot de passe » ;
 *   4. compte dont le second facteur n'était pas encore su → UNE tentative,
 *      le refus mesuré « requires a 2FA code » est retenu (`deuxFacteurs`),
 *      et les gestes suivants s'arrêtent AVANT de solliciter le service ;
 *   5. la mesure d'espace se reconnecte comme les autres chemins ;
 *   6. la carte dit les trois états et suggère la clé TOTP au bon moment.
 *
 * Toutes les valeurs sont INVENTÉES : aucun identifiant, aucun chemin réels.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// L'environnement se pose AVANT tout require de server/config.js, et le faux
// rclone AVANT tout require de crabe (backends.js lit le chemin du binaire).
const RACINE_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot58-'));
process.env.NODE_ENV = 'test';
process.env.CRABE_DATA_DIR = path.join(RACINE_TEST, 'data');
process.env.CRABE_MASTER_PASSPHRASE = 'passphrase-de-test-lot58-0123456789';
process.env.CRABE_HARMONISATION_RELECTURE_DELAI_MS = '0';
process.env.CRABE_COPIE_DELAI_MS = '0';

const ETAT_FAUX = path.join(RACINE_TEST, 'etat-faux-rclone.json');
const JOURNAL_FAUX = path.join(RACINE_TEST, 'journal-faux-rclone.log');
process.env.CRABE_FAUX_ETAT = ETAT_FAUX;
process.env.CRABE_FAUX_JOURNAL = JOURNAL_FAUX;

const FAUX_RCLONE = path.join(RACINE_TEST, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

/**
 * Le faux rclone : un « Proton Drive » qui travaille sur des dossiers locaux
 * (les adresses `crabe:/chemin` perdent leur préfixe) et qui joue la session
 * comme le vrai (comportements mesurés dans la source v1.75.0) :
 *
 *   - une conf AVEC `client_access_token` rejoue la session — refusée si
 *     l'état la révoque (« 401 Invalid access token », la signature du
 *     25/08/2026) ;
 *   - une conf SANS session mais avec `otp_secret_key` réussit son login et
 *     ÉCRIT les quatre clés de session dans son fichier de configuration,
 *     comme l'authHandler du vrai backend ;
 *   - une conf sans session ni clé échoue sur la signature mesurée du bridge
 *     (« this account requires a 2FA code… »).
 *
 * L'état (JSON) pilote les révocations : `revoquerALOperation` (la session
 * jouée à la N-ième opération est révoquée, une fois), `revoquerDesOperation`
 * (toute session est révoquée à partir de la N-ième), `sessionsRevoquees`
 * (liste noire explicite). Chaque invocation laisse une ligne au journal du
 * faux — c'est lui qui PROUVE qu'aucun login n'est tenté quand crabe doit
 * s'arrêter avant le service.
 */
fs.writeFileSync(
  FAUX_RCLONE,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const ecrire = (s) => { const b = Buffer.from(s); let n = 0; while (n < b.length) n += fs.writeSync(1, b, n, b.length - n); };
const TYPES = ${JSON.stringify(CATALOGUE)};
const journal = (ligne) => fs.appendFileSync(process.env.CRABE_FAUX_JOURNAL, ligne + '\\n');

let argv = process.argv.slice(2);
const i = argv.indexOf('--config');
const confFile = i >= 0 ? argv[i + 1] : null;
if (i >= 0) argv = argv.filter((_, j) => j !== i && j !== i + 1);
if (argv.includes('providers')) { ecrire(JSON.stringify(TYPES)); process.exit(0); }
const cmd = argv[0];
if (cmd === 'version') { ecrire('rclone v1.75.0-faux\\n'); process.exit(0); }
if (cmd === 'obscure') { ecrire('OBSCURCI\\n'); process.exit(0); }

// Les arguments « donnée » : les drapeaux (et la valeur de --max-depth) en moins.
const args = [];
for (let j = 1; j < argv.length; j++) {
  if (argv[j] === '--max-depth') { j++; continue; }
  if (argv[j].startsWith('-')) continue;
  args.push(argv[j]);
}
const local = (p) => String(p).replace(/^[A-Za-z0-9_-]+:/, '');

// ─── Le portier : session ou login, selon la conf et l'état ─────────────────
const etat = JSON.parse(fs.readFileSync(process.env.CRABE_FAUX_ETAT, 'utf8'));
etat.ops = (etat.ops || 0) + 1;
const conf = confFile ? fs.readFileSync(confFile, 'utf8') : '';
const session = (conf.match(/^client_access_token = (.+)$/m) || [])[1] || null;
const refus = (code) => {
  fs.writeFileSync(process.env.CRABE_FAUX_ETAT, JSON.stringify(etat));
  process.stderr.write('Failed to ' + cmd + ': 401 POST https://exemple.invalid/auth: Invalid access token (Code=401)\\n');
  process.exit(1);
};
if (session) {
  const revoquee = (etat.sessionsRevoquees || []).includes(session)
    || (etat.revoquerALOperation && etat.ops === etat.revoquerALOperation)
    || (etat.revoquerDesOperation && etat.ops >= etat.revoquerDesOperation);
  if (revoquee) {
    etat.sessionsRevoquees = [...new Set([...(etat.sessionsRevoquees || []), session])];
    journal('refus-session ' + cmd);
    refus();
  }
  journal('op-session ' + cmd);
} else {
  if (!/^otp_secret_key = \\S/m.test(conf)) {
    journal('login-sans-cle ' + cmd);
    fs.writeFileSync(process.env.CRABE_FAUX_ETAT, JSON.stringify(etat));
    process.stderr.write("couldn't initialize a new proton drive instance: this account requires a 2FA code. Can be provided with --protondrive-2fa=000000\\n");
    process.exit(1);
  }
  etat.sessions = (etat.sessions || 0) + 1;
  const neuve = 'SESSION-NEUVE-' + etat.sessions;
  fs.appendFileSync(confFile,
    '\\nclient_uid = UID-' + etat.sessions
    + '\\nclient_access_token = ' + neuve
    + '\\nclient_refresh_token = REFRESH-' + etat.sessions
    + '\\nclient_salted_key_pass = SEL-' + etat.sessions + '\\n');
  journal('login-reussi ' + cmd);
}
fs.writeFileSync(process.env.CRABE_FAUX_ETAT, JSON.stringify(etat));

// ─── L'opération elle-même, sur le système de fichiers local ────────────────
try {
  if (cmd === 'lsd') {
    if (!fs.existsSync(local(args[0]))) { process.stderr.write('directory not found\\n'); process.exit(1); }
  } else if (cmd === 'mkdir') {
    fs.mkdirSync(local(args[0]), { recursive: true });
  } else if (cmd === 'lsf') {
    const dossier = local(args[0]);
    if (!fs.existsSync(dossier)) { process.stderr.write('directory not found\\n'); process.exit(1); }
    ecrire(fs.readdirSync(dossier, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).join('\\n') + '\\n');
  } else if (cmd === 'moveto') {
    fs.mkdirSync(path.dirname(local(args[1])), { recursive: true });
    fs.renameSync(local(args[0]), local(args[1]));
  } else if (cmd === 'copyto') {
    fs.mkdirSync(path.dirname(local(args[1])), { recursive: true });
    fs.copyFileSync(local(args[0]), local(args[1]));
  } else if (cmd === 'deletefile') {
    fs.rmSync(local(args[0]));
  } else if (cmd === 'about') {
    ecrire(JSON.stringify({ total: 1000, free: 900, used: 100 }));
  }
} catch (err) {
  process.stderr.write(String(err.message) + '\\n');
  process.exit(1);
}
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const crypto = require('../server/crypto');
const dbServeur = require('../server/db/db');

const DEST = 'cloud-proton-essai';
const DEST_NU = 'cloud-proton-nu';

/** Trois documents à renommer dans le MÊME dossier, un déjà conforme. */
function lignesDouble() {
  return [
    { connecteur: 'fournisseur-exemple', nom: '2026-01_100001.pdf' },
    { connecteur: 'fournisseur-exemple', nom: '2026-02_100002.pdf' },
    { connecteur: 'fournisseur-exemple', nom: '2026-03_100003.pdf' },
    { connecteur: 'fournisseur-exemple', nom: 'fournisseur-exemple_2026-09_100099.pdf' },
  ];
}

let racine;
let local;
let cloud;

/** La configuration déchiffrée telle qu'elle vit en base. */
function confStockee(destId) {
  const ligne = dbServeur.get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
}

/** La configuration du cloud d'essai : session enregistrée, clé TOTP au choix. */
function poserConf(destId, { session = 'SESSION-INITIALE', cle = true, deuxFacteurs = false } = {}) {
  const valeurs = {
    username: 'camille@exemple.fr',
    password: 'MotDePasseInvente',
    ...(cle ? { otp_secret_key: 'ABCDEFGH234567' } : {}),
    ...(session
      ? {
          client_uid: 'UID-INITIAL',
          client_access_token: session,
          client_refresh_token: 'REFRESH-INITIAL',
          client_salted_key_pass: 'SEL-INITIAL',
        }
      : {}),
  };
  dbServeur.get()
    .prepare("UPDATE destinations_config SET config_encrypted = ? WHERE dest_id = ?")
    .run(
      crypto.encrypt({
        type: 'protondrive',
        basePath: cloud,
        valeurs,
        ...(deuxFacteurs ? { deuxFacteurs: true } : {}),
      }),
      destId
    );
  const destinations = require('../server/destinations');
  destinations.oublierPilotes();
  destinations.oublierMesureEspace();
}

/** Remet le double à neuf : lignes, fichiers, conf, journaux, état du faux. */
function poserScenario(etatFaux = {}) {
  const d = dbServeur.get();
  d.prepare('DELETE FROM invoices').run();
  fs.rmSync(path.join(local, 'camille'), { recursive: true, force: true });
  fs.rmSync(path.join(cloud, 'camille'), { recursive: true, force: true });

  const inserer = d.prepare(
    'INSERT INTO invoices (id, user_id, connector_id, filename, remote_id, destinations) VALUES (?, 1, ?, ?, ?, ?)'
  );
  let id = 0;
  for (const l of lignesDouble()) {
    id++;
    const relatif = `camille/${l.connecteur}/compte/2026/${l.nom}`;
    const chemins = {
      local: { ok: true, path: path.join(local, relatif) },
      [DEST]: { ok: true, path: `crabe:${cloud}/${relatif}` },
    };
    for (const base of [local, cloud]) {
      const complet = path.join(base, relatif);
      fs.mkdirSync(path.dirname(complet), { recursive: true });
      fs.writeFileSync(complet, `document invente ${id}\n`);
    }
    inserer.run(id, l.connecteur, l.nom, `${l.connecteur}-ref-${id}`, JSON.stringify(chemins));
  }

  poserConf(DEST);
  for (const f of fs.readdirSync(process.env.CRABE_DATA_DIR)) {
    if (f.startsWith('harmonisation-noms-journal')) {
      fs.rmSync(path.join(process.env.CRABE_DATA_DIR, f), { force: true });
    }
  }
  fs.writeFileSync(ETAT_FAUX, JSON.stringify(etatFaux));
  fs.writeFileSync(JOURNAL_FAUX, '');
  require('../server/harmonisation').reset();
}

const lireJournalChantier = () => fs
  .readFileSync(path.join(process.env.CRABE_DATA_DIR, 'harmonisation-noms-journal.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const lireJournalFaux = () => fs.readFileSync(JOURNAL_FAUX, 'utf8').split('\n').filter(Boolean);

const lignesApplog = (motif) => dbServeur.get()
  .prepare("SELECT level, message FROM app_logs WHERE source = 'harmonisation' ORDER BY id")
  .all()
  .filter((l) => motif.test(l.message));

/** Attend la fin de la tâche détachée du moteur — jamais plus de 60 s. */
async function attendreFin(harmonisation) {
  const limite = Date.now() + 60_000;
  while (harmonisation.progress().running) {
    if (Date.now() > limite) throw new Error('le chantier ne se termine pas');
    await new Promise((r) => setTimeout(r, 60));
  }
  return harmonisation.progress();
}

test.before(async () => {
  racine = path.join(RACINE_TEST, 'double');
  local = path.join(racine, 'local');
  cloud = path.join(racine, 'cloud');
  for (const d of [local, cloud]) fs.mkdirSync(d, { recursive: true });

  if (!crypto.isReady) await crypto.init();
  dbServeur.open();

  const d = dbServeur.get();
  d.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'camille', 'hachage-invente')").run();
  d.prepare("INSERT OR REPLACE INTO destinations_config (dest_id, enabled, path, protocol) VALUES ('local', 1, ?, 'local')").run(local);
  const poserCloud = d.prepare(
    "INSERT INTO destinations_config (dest_id, enabled, provider, display_name, config_encrypted) VALUES (?, ?, 'proton', ?, ?)"
  );
  poserCloud.run(DEST, 1, 'Proton d\'essai', crypto.encrypt({}));
  // Le second cloud reste ÉTEINT : il ne participe à aucun chantier, il sert
  // les scénarios « compte dont le second facteur n'était pas encore su ».
  poserCloud.run(DEST_NU, 0, 'Proton sans clé', crypto.encrypt({}));

  require('../server/destinations/backends').oublier();
});

test.after(() => {
  fs.rmSync(RACINE_TEST, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. La session meurt en plein chantier → reconnexion, et le chantier va au bout
// ---------------------------------------------------------------------------

test('session tuée en plein chantier : reconnexion immédiate, chantier au bout, rien compté deux fois', async () => {
  // La 7e opération du faux est le moveto du 2e document — la session jouée à
  // cet instant est révoquée, comme Proton l'a fait le 25/08/2026 entre
  // « Tester » et « Renommer maintenant ».
  poserScenario({ revoquerALOperation: 7 });

  const harmonisation = require('../server/harmonisation');
  harmonisation.demarrer({ userId: 1, username: 'camille' });
  const fin = await attendreFin(harmonisation);

  assert.ok(!fin.refus && !fin.arret, `le chantier va au bout : ${fin.message}`);
  assert.equal(fin.faites, 3, 'les trois documents sont renommés');

  // Le stockage ET la base portent les noms cibles.
  const d = dbServeur.get();
  for (const l of d.prepare("SELECT filename, destinations FROM invoices WHERE id <= 3").all()) {
    assert.match(l.filename, /^fournisseur-exemple_2026-0[123]_10000[123]\.pdf$/);
    const chemins = JSON.parse(l.destinations);
    assert.ok(fs.existsSync(chemins.local.path), 'le fichier le stockage local suit');
    assert.ok(fs.existsSync(chemins[DEST].path.replace(/^crabe:/, '')), 'le fichier cloud suit');
  }

  // Aucun mouvement compté deux fois : une ligne de journal par (document,
  // destination), une écriture en base par document.
  const journal = lireJournalChantier();
  const mouvements = journal.filter((e) => e.type === 'mouvement');
  const cles = mouvements.map((e) => `${e.id}|${e.dest}`);
  assert.equal(new Set(cles).size, cles.length, 'aucun mouvement en double');
  assert.equal(journal.filter((e) => e.type === 'base').length, 3);

  // La reconnexion s'est journalisée — au journal du chantier ET dans app_logs.
  const reconnexions = journal.filter((e) => e.type === 'reconnexion');
  assert.deepEqual(reconnexions.map((e) => e.issue), ['tentee', 'reussie']);
  assert.equal(lignesApplog(/reconnexion immédiate/).length, 1, 'la tentative est dans les logs');
  assert.equal(lignesApplog(/reconnexion réussie/).length, 1, 'la réussite aussi');

  // La session NEUVE est persistée (mécanisme du lot 57), la marque est levée,
  // et la date de la dernière connexion réussie est retenue.
  const conf = confStockee(DEST);
  assert.match(conf.valeurs.client_access_token, /^SESSION-NEUVE-/, 'la session neuve remplace la morte');
  assert.equal(conf.sessionMorteLe, undefined, 'la marque n\'a plus d\'objet');
  assert.ok(conf.sessionEtablieLe, 'la connexion réussie est datée');

  // Le faux a vu exactement UN refus et UN login — une tentative par refus.
  assert.equal(lireJournalFaux().filter((l) => l.startsWith('refus-session')).length, 1);
  assert.equal(lireJournalFaux().filter((l) => l.startsWith('login-reussi')).length, 1);

  // Et le démarrage a été journalisé avec ses chiffres.
  assert.equal(lignesApplog(/Renommage lancé : 3 document\(s\), 6 mouvement\(s\)/).length, 1);
});

// ---------------------------------------------------------------------------
// 2. Révocation en boucle → arrêt au plafond, en le disant
// ---------------------------------------------------------------------------

test('un service qui révoque en boucle : arrêt au plafond du chantier, jamais une rafale', async () => {
  // À partir de la 4e opération (le chantier, après les préalables), TOUTE
  // session est révoquée dès qu'elle se présente.
  poserScenario({ revoquerDesOperation: 4 });

  const harmonisation = require('../server/harmonisation');
  const destinations = require('../server/destinations');
  harmonisation.demarrer({ userId: 1, username: 'camille' });
  const fin = await attendreFin(harmonisation);

  assert.ok(fin.arret, 'le chantier s\'arrête net');
  assert.match(fin.arret, /se reconnecter en boucle/, 'et il dit pourquoi');
  assert.match(fin.arret, /reprend où il en était/, 'et que la reprise est le même geste');

  // Le plafond a été respecté À L'UNITÉ : autant de logins que le budget,
  // pas un de plus.
  assert.equal(
    lireJournalFaux().filter((l) => l.startsWith('login-reussi')).length,
    destinations.RECONNEXIONS_PAR_CHANTIER,
    'le budget borne les reconnexions'
  );
  // Deux lignes disent le plafond : l'événement de reconnexion refusée, puis
  // l'arrêt du chantier qui reprend la phrase — les deux comptent.
  assert.equal(lignesApplog(/révoqué .* sessions pendant ce/).length, 2, 'le plafond est dans les logs');
  assert.equal(lignesApplog(/Renommage arrêté net/).length, 1, 'l\'arrêt du chantier aussi');

  // Le journal dit un chantier interrompu, à reprendre.
  const bilan = harmonisation.progress().journal;
  assert.equal(bilan.interrompu, true);
});

// ---------------------------------------------------------------------------
// 3. Second facteur connu, pas de clé → arrêt au premier refus, service épargné
// ---------------------------------------------------------------------------

test('sans clé TOTP, l\'arrêt est immédiat avec le bon message — et aucun login n\'est tenté', async () => {
  poserScenario({ revoquerALOperation: 5 });
  // Le compte est CONNU à second facteur (un code a été saisi un jour), la
  // clé n'est pas enregistrée : la reconnexion est impossible par
  // construction — le code à usage unique est périmé par définition.
  poserConf(DEST, { cle: false, deuxFacteurs: true });

  const harmonisation = require('../server/harmonisation');
  harmonisation.demarrer({ userId: 1, username: 'camille' });
  const fin = await attendreFin(harmonisation);

  assert.ok(fin.arret, 'le chantier s\'arrête au premier refus');
  assert.match(fin.arret, /Clé de votre application d'authentification/, 'la sortie est nommée');
  assert.match(fin.arret, /crabe ne peut pas la rouvrir tout seul/, 'et le manque est dit');
  assert.match(fin.arret, /reprend où il en était/, 'et la reprise promise');
  assert.doesNotMatch(fin.arret, /[Vv]érifiez.*mot de passe/, 'jamais « vérifiez votre mot de passe »');

  // Le service n'a essuyé AUCUNE tentative de login : un seul refus de
  // session, zéro ligne de login au journal du faux.
  const faux = lireJournalFaux();
  assert.equal(faux.filter((l) => l.startsWith('refus-session')).length, 1);
  assert.equal(faux.filter((l) => l.startsWith('login-')).length, 0, 'le service est épargné');

  // L'échec de reconnexion est retenu : c'est lui qui déclenchera la
  // suggestion de la clé sur la carte.
  assert.ok(confStockee(DEST).reconnexionEchoueeLe, 'l\'échec est daté');
});

// ---------------------------------------------------------------------------
// 4. Second facteur pas encore su : une tentative, le refus mesuré est retenu
// ---------------------------------------------------------------------------

test('compte à 2FA sans marque ni clé : une seule tentative, puis les gestes s\'arrêtent avant le service', async () => {
  const destinations = require('../server/destinations');
  poserConf(DEST_NU, { session: 'SESSION-NUE', cle: false });
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({ sessionsRevoquees: ['SESSION-NUE'] }));
  fs.writeFileSync(JOURNAL_FAUX, '');

  // Premier geste : le service refuse la session, crabe tente UNE reconnexion
  // (rien ne dit encore que le compte demande un second facteur), et le
  // service répond la signature mesurée « requires a 2FA code ».
  const premier = await destinations.test(DEST_NU);
  assert.equal(premier.ok, false);
  assert.match(premier.message, /Clé de votre application d'authentification/);
  assert.doesNotMatch(premier.message, /[Vv]érifiez.*mot de passe/);
  assert.equal(lireJournalFaux().filter((l) => l.startsWith('login-sans-cle')).length, 1, 'une tentative, une seule');

  // Le refus du service est RETENU : le compte est marqué à second facteur,
  // l'échec de reconnexion est daté.
  const conf = confStockee(DEST_NU);
  assert.equal(conf.deuxFacteurs, true, 'le fait est appris du service');
  assert.ok(conf.reconnexionEchoueeLe);

  // Second geste : plus AUCUNE sollicitation du service — le refus vient
  // avant, avec la même phrase.
  const traces = lireJournalFaux().length;
  const second = await destinations.test(DEST_NU);
  assert.equal(second.ok, false);
  assert.match(second.message, /Clé de votre application d'authentification/);
  assert.equal(lireJournalFaux().length, traces, 'le faux rclone n\'a plus été invoqué');
});

// ---------------------------------------------------------------------------
// 5. La mesure d'espace se reconnecte comme les autres chemins
// ---------------------------------------------------------------------------

test('la mesure d\'espace : session refusée en pleine mesure → reconnexion, mesure rendue', async () => {
  const destinations = require('../server/destinations');
  poserConf(DEST, { session: 'SESSION-A-REVOQUER' });
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({ sessionsRevoquees: ['SESSION-A-REVOQUER'] }));
  fs.writeFileSync(JOURNAL_FAUX, '');

  destinations.oublierMesureEspace(DEST);
  const mesure = await destinations.spaceFor(DEST);
  assert.equal(mesure.known, true, JSON.stringify(mesure));
  assert.equal(mesure.totalBytes, 1000);

  const conf = confStockee(DEST);
  assert.match(conf.valeurs.client_access_token, /^SESSION-NEUVE-/, 'la session neuve est persistée');
  assert.equal(conf.sessionMorteLe, undefined);
});

// ---------------------------------------------------------------------------
// 6. La carte : trois états, et la clé suggérée au bon moment — pas ailleurs
// ---------------------------------------------------------------------------

test('la carte dit des faits : session valide datée, reconnexion auto, suggestion de clé au bon moment', async () => {
  const destinations = require('../server/destinations');

  // Session vivante + clé enregistrée : valide, datée, reconnexion automatique
  // possible — et AUCUNE suggestion (la clé est déjà là).
  const vivante = await destinations.publicConfigComplet(DEST);
  assert.equal(vivante.sessionDurable, true);
  assert.ok(vivante.sessionEtablieLe, 'la dernière connexion réussie est datée');
  assert.equal(vivante.reconnexionAuto, true, 'mot de passe + clé : crabe se reconnecte seul');
  assert.equal(vivante.suggererCleTotp, false, 'la clé est là, rien à suggérer');

  // Le compte à second facteur qui a raté sa reconnexion faute de clé : la
  // suggestion est LÀ, et le champ remonte des « Réglages avancés ».
  const enPanne = await destinations.publicConfigComplet(DEST_NU);
  assert.ok(enPanne.sessionMorteLe, 'la session refusée est dite');
  assert.equal(enPanne.reconnexionAuto, false);
  assert.equal(enPanne.suggererCleTotp, true, 'le moment est le bon');
  const champCle = enPanne.champs.find((c) => c.key === 'otp_secret_key');
  assert.equal(champCle.avance, false, 'le champ remonte au premier niveau');

  // Jamais connectée : configurée, aucune session, aucune marque.
  poserConf(DEST, { session: null });
  const jamais = await destinations.publicConfigComplet(DEST);
  assert.equal(jamais.sessionDurable, false, 'l\'écran saura dire « jamais connectée »');
  assert.equal(jamais.sessionMorteLe, undefined);
  // Et le champ clé reste rangé en avancé quand rien ne le réclame.
  const champRange = jamais.champs.find((c) => c.key === 'otp_secret_key');
  assert.equal(champRange.avance, true, 'la suggestion ne s\'affiche pas ailleurs');
});
