'use strict';

/**
 * Lot 61 — MEGA cesse de promettre un « réessayez » impossible.
 *
 * ─── L'incident mesuré du 26/08/2026 au matin ────────────────────────────────
 *
 * 09:16 — la création de l'espace MEGA réussit (« le dossier de crabe vient
 * d'être créé, et l'accès en écriture est vérifié ») ; 09:17 — chaque dépôt
 * échoue sur « couldn't login: The upload target URL you are trying to access
 * has expired. Please request a fresh one », et le message servi commence par
 * « Réessayez ». Trois documents ont produit trois tentatives chacun, deux
 * synchronisations de suite — dix-huit connexions en trois minutes — et 744
 * documents restaient en file.
 *
 * La cause est documentée hors de crabe : quand la validation en deux étapes
 * est active sur le compte, la bibliothèque MEGA de l'outil de copie refait
 * une connexion multifacteur à chaque appel en rejouant un jeton déjà expiré.
 * Aucun réglage de crabe n'y remédie — « réessayez » est une promesse fausse.
 *
 * Ce que ce fichier verrouille, sur un DOUBLE complet (base jetable, stockage local
 * jetable, un « MEGA » servi par un faux rclone à échecs pilotés) :
 *
 *   1. l'erreur mesurée produit le message honnête — jamais « Réessayez » ;
 *   2. le premier refus RETIENT le fait (`megaDeuxEtapesLe`), et le dépôt qui
 *      l'a essuyé s'arrête sans rejouer deux essais de plus contre le service ;
 *   3. les gestes suivants — dépôt, mesure d'espace, « Tester » — s'arrêtent
 *      AVANT de solliciter le service : plus aucune rafale ;
 *   4. la carte de la destination porte le même message, en avertissement ;
 *   5. la marque survit aux enregistrements qui ne changent rien, et se lève
 *      par une saisie neuve du mot de passe — crabe revérifie alors, et
 *      re-marque si rien n'a changé chez MEGA.
 *
 * Toutes les valeurs sont INVENTÉES : aucun identifiant, aucun chemin réels.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CRABE_COPIE_DELAI_MS = '0';

// Le faux rclone se pose AVANT tout require de crabe (config.js lit le chemin
// du binaire au chargement).
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot61-'));
const ETAT_FAUX = path.join(RACINE_FAUX, 'etat-faux-rclone.json');
const JOURNAL_FAUX = path.join(RACINE_FAUX, 'journal-faux-rclone.log');
process.env.CRABE_FAUX_ETAT = ETAT_FAUX;
process.env.CRABE_FAUX_JOURNAL = JOURNAL_FAUX;

const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

/**
 * Le faux rclone : un « MEGA » qui travaille sur des dossiers locaux (les
 * adresses `crabe:/chemin` perdent leur préfixe). L'état (JSON) le pilote :
 * `echouerLogin: true` fait échouer TOUTE commande de données sur la signature
 * mesurée le 26/08/2026 — comme le vrai, dont chaque invocation rejoue la
 * connexion multifacteur cassée. Chaque commande de données laisse une ligne
 * au journal du faux : c'est lui qui PROUVE qu'aucune connexion n'est tentée
 * quand crabe doit s'arrêter avant le service.
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
if (i >= 0) argv = argv.filter((_, j) => j !== i && j !== i + 1);
if (argv.includes('providers')) { ecrire(JSON.stringify(TYPES)); process.exit(0); }
const cmd = argv[0];
if (cmd === 'version') { ecrire('rclone v1.75.0-faux\\n'); process.exit(0); }
if (cmd === 'obscure') { ecrire('OBSCURCI\\n'); process.exit(0); }

const args = [];
for (let j = 1; j < argv.length; j++) {
  if (argv[j] === '--max-depth') { j++; continue; }
  if (argv[j].startsWith('-')) continue;
  args.push(argv[j]);
}
const local = (p) => String(p).replace(/^[A-Za-z0-9_-]+:/, '');

// Chaque commande de données est une sollicitation du service : au journal.
journal(cmd);
const etat = JSON.parse(fs.readFileSync(process.env.CRABE_FAUX_ETAT, 'utf8'));
if (etat.echouerLogin) {
  // La signature mesurée en production le 26/08/2026, mot pour mot.
  process.stderr.write('Failed to ' + cmd + ': couldn\\'t login: The upload target URL you are trying to access has expired. Please request a fresh one\\n');
  process.exit(1);
}

try {
  if (cmd === 'lsd') {
    if (!fs.existsSync(local(args[0]))) { process.stderr.write('directory not found\\n'); process.exit(1); }
  } else if (cmd === 'mkdir') {
    fs.mkdirSync(local(args[0]), { recursive: true });
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

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const erreurs = require('../server/destinations/erreurs-rclone');
const crypto = require('../server/crypto');

/** Ce que le vrai rclone a écrit le 26/08/2026, préfixe de chemin compris. */
const ERREUR_MESUREE =
  'Failed to copyto: couldn\'t login: The upload target URL you are trying to access '
  + 'has expired. Please request a fresh one';

let MEGA;
let user;

/** La configuration déchiffrée telle qu'elle vit en base. */
function confStockee(destId) {
  const ligne = helpers.db.get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
}

const lireJournalFaux = () => fs.readFileSync(JOURNAL_FAUX, 'utf8').split('\n').filter(Boolean);
const viderJournaux = () => {
  fs.writeFileSync(JOURNAL_FAUX, '');
  helpers.db.get().prepare('DELETE FROM app_logs').run();
};

const lignesApplog = () => helpers.db.get()
  .prepare("SELECT level, message FROM app_logs WHERE source = 'destinations' ORDER BY id")
  .all();

/** Un dépôt complet — stockage local + le MEGA d'essai — d'un document inventé. */
function deposer(filename) {
  return destinations.storeInvoice({
    username: 'lot61',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-08-05',
    filename,
    buffer: Buffer.from('%PDF-1.4 faux document'),
  });
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot61' });
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({ echouerLogin: true }));
  fs.writeFileSync(JOURNAL_FAUX, '');

  // Un MEGA configuré par ses champs, comme depuis le formulaire de la carte :
  // c'est la forme enregistrée en production le 26/08/2026.
  MEGA = destinations.createCloud({ provider: 'mega', displayName: 'MEGA d\'essai' }).id;
  destinations.saveConfig(MEGA, {
    enabled: true,
    remoteName: 'crabe',
    basePath: path.join(RACINE_FAUX, 'cloud'),
    valeurs: { user: 'camille@exemple.fr', pass: 'MotDePasseInvente' },
  });
  require('../server/destinations/backends').oublier();
});

test.after(() => {
  helpers.teardown();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. L'erreur mesurée produit le message honnête
// ---------------------------------------------------------------------------

test('l\'erreur mesurée du 26/08 produit le message honnête, jamais « Réessayez »', () => {
  const message = erreurs.traduire(
    `2026/08/26 07:17:02 CRITICAL: "crabe/exemple/2026/": ${ERREUR_MESUREE}`
  );
  assert.equal(message, erreurs.MESSAGE_MEGA_DEUX_ETAPES);
  assert.equal(/réessayez/i.test(message), false, 'aucune promesse de réessai');
  // Le message dit la cause, l'innocence des identifiants, et les deux voies.
  assert.match(message, /validation en deux étapes/);
  assert.match(message, /identifiants et le réseau n'y sont pour rien/);
  assert.match(message, /compatible S3/);
  assert.match(message, /sans validation en deux étapes/);
});

// ---------------------------------------------------------------------------
// 2. Le premier refus retient le fait, et le dépôt s'arrête sans rafale
// ---------------------------------------------------------------------------

test('le dépôt qui essuie le refus retient le fait et ne rejoue pas deux essais de plus', async () => {
  viderJournaux();

  const results = await deposer('2026-08_100001.pdf');

  assert.equal(results.local.ok, true, 'le document reste valide sur la principale');
  assert.equal(results[MEGA].ok, false);
  assert.match(results[MEGA].message, /validation en deux étapes/);
  assert.equal(/réessayez/i.test(results[MEGA].message), false);

  // UNE seule sollicitation du service : l'essai qui a mesuré le refus. Les
  // essais 2 et 3 d'avant auraient rejoué la même connexion vouée à l'échec.
  assert.deepEqual(lireJournalFaux(), ['copyto'], 'une connexion, pas trois');

  // Le fait est retenu, daté, sur la configuration de la destination.
  assert.ok(confStockee(MEGA).megaDeuxEtapesLe, 'la marque est posée');

  // Le journal de crabe ne promet aucun « nouvel essai », et il dit que plus
  // rien ne sollicitera le service.
  const journal = lignesApplog();
  assert.equal(journal.some((l) => /Nouvel essai/.test(l.message)), false);
  assert.ok(journal.some((l) => /validation en deux étapes/.test(l.message)));
  assert.ok(journal.some((l) => /aucun nouvel essai/.test(l.message)));
});

test('les dépôts suivants s\'arrêtent AVANT de solliciter le service', async () => {
  viderJournaux();

  const results = await deposer('2026-08_100002.pdf');

  assert.equal(results[MEGA].ok, false);
  assert.match(results[MEGA].message, /validation en deux étapes/);
  assert.deepEqual(lireJournalFaux(), [], 'aucune connexion tentée');
});

test('la mesure d\'espace et « Tester la connexion » refusent avant le service, en le disant', async () => {
  viderJournaux();
  destinations.oublierMesureEspace(MEGA);

  const espace = await destinations.spaceFor(MEGA);
  assert.equal(espace.known, false);
  assert.match(String(espace.reason || espace.message || ''), /validation en deux étapes/);

  const essai = await destinations.test(MEGA, user.id);
  assert.equal(essai.ok, false);
  assert.match(essai.message, /validation en deux étapes/);
  assert.equal(/réessayez/i.test(essai.message), false);

  assert.deepEqual(lireJournalFaux(), [], 'aucune connexion tentée par ces deux gestes');
});

// ---------------------------------------------------------------------------
// 3. La carte dit le même fait
// ---------------------------------------------------------------------------

test('la carte de la destination porte le message en avertissement', async () => {
  const fiche = await destinations.publicConfigComplet(MEGA);
  assert.ok(
    (fiche.avertissements || []).some((a) => a === erreurs.MESSAGE_MEGA_DEUX_ETAPES),
    'l\'avertissement de la carte est le message honnête, à l\'identique'
  );
});

// ---------------------------------------------------------------------------
// 4. La marque survit aux enregistrements neutres, se lève par la saisie neuve
// ---------------------------------------------------------------------------

test('un enregistrement qui ne change rien conserve la marque', () => {
  destinations.saveConfig(MEGA, { displayName: 'MEGA renommé' });
  assert.ok(confStockee(MEGA).megaDeuxEtapesLe, 'renommer la carte ne dit rien du compte');
});

test('la saisie neuve du mot de passe lève la marque : crabe revérifie, et re-marque si rien n\'a changé', async () => {
  // L'utilisateur dit « la situation a changé » en ressaisissant le mot de
  // passe — la marque tombe, le service est réinterrogé.
  destinations.saveConfig(MEGA, { valeurs: { pass: 'MotDePasseRessaisi' } });
  assert.equal(confStockee(MEGA).megaDeuxEtapesLe, undefined, 'la marque est levée');

  // Rien n'a changé chez MEGA : UNE connexion mesure le même refus, la marque
  // se repose.
  viderJournaux();
  let results = await deposer('2026-08_100003.pdf');
  assert.equal(results[MEGA].ok, false);
  assert.deepEqual(lireJournalFaux(), ['copyto'], 'une seule connexion de re-vérification');
  assert.ok(confStockee(MEGA).megaDeuxEtapesLe, 'le même refus repose la marque');

  // Cette fois le compte a VRAIMENT changé (validation désactivée chez MEGA) :
  // saisie neuve, et le dépôt aboutit.
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({ echouerLogin: false }));
  destinations.saveConfig(MEGA, { valeurs: { pass: 'MotDePasseSans2FA' } });
  results = await deposer('2026-08_100004.pdf');
  assert.equal(results[MEGA].ok, true, 'le chemin se rouvre entièrement');
  assert.equal(confStockee(MEGA).megaDeuxEtapesLe, undefined);
});
