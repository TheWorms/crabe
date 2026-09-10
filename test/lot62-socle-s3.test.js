'use strict';

/**
 * Lot 62 — Un socle S3, et deux MEGA qui disent chacun ce qu'il sait faire.
 *
 * ─── D'où vient ce lot ───────────────────────────────────────────────────────
 *
 * Le compte MEGA ordinaire échoue structurellement dès que la validation en
 * deux étapes est active (panne mesurée le 26/08/2026, verrouillée au lot 61).
 * La voie de sortie est le stockage objet compatible S3 de MEGA — et un espace
 * S3 se configure toujours pareil, chez MEGA comme chez n'importe qui : une
 * adresse de service, une paire de clés, un bucket. D'où un SOCLE (la vedette
 * « Stockage compatible S3 ») et, dessus, la carte « MEGA (stockage objet,
 * payant) ».
 *
 * Ce que ce fichier verrouille, sur un DOUBLE complet (base jetable, stockage
 * local jetable, un « S3 » servi par un faux rclone sur dossiers locaux) :
 *
 *   1. le choix est clair AVANT de cliquer : les deux MEGA dans la liste,
 *      chacun avec la phrase qui dit à qui il s'adresse ;
 *   2. le bloc rclone produit est conforme aux options MESURÉES sur le binaire
 *      v1.75.0 du serveur : `provider = Mega` posé d'office, pas de `region`,
 *      et le bucket JAMAIS dans le bloc — il vit dans l'adresse ;
 *   3. l'adresse est composée bucket d'abord : dépôt, téléchargement et test
 *      visent `bucket/dossier`, prouvé sur les fichiers écrits ;
 *   4. une clé secrète laissée vide conserve l'ancienne, une clé neuve la
 *      remplace, l'effacement explicite efface (leçon du lot 57) ;
 *   5. la mesure d'espace refusée par le protocole S3 dit la phrase honnête —
 *      « cette mesure n'existe pas chez lui » — jamais une accusation ;
 *   6. les refus S3 (clé inconnue, signature fausse, bucket absent) sortent en
 *      français, avec le champ à corriger.
 *
 * ⚠ La voie MEGA S4 n'a JAMAIS été exercée contre un compte réel : aucun
 * compte de stockage objet n'était disponible pour l'essayer. Ce que ces tests prouvent, c'est le bloc
 * produit, l'adresse composée et les messages — la convention du connecteur
 * Infomaniak (lot 25) s'applique, et la note technique du preset le dit.
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
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot62-'));
const ETAT_FAUX = path.join(RACINE_FAUX, 'etat-faux-rclone.json');
const JOURNAL_FAUX = path.join(RACINE_FAUX, 'journal-faux-rclone.log');
process.env.CRABE_FAUX_ETAT = ETAT_FAUX;
process.env.CRABE_FAUX_JOURNAL = JOURNAL_FAUX;

const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

/**
 * Le faux rclone : un « S3 » qui travaille sur des dossiers locaux (les
 * adresses `crabe:bucket/chemin` deviennent des chemins sous la racine du
 * faux). Deux comportements MESURÉS sur le vrai binaire v1.75.0 de production :
 *
 *   - `about` échoue toujours, mot pour mot comme le vrai (« Failed to about:
 *     S3 root doesn't support about », relevé du 26/08/2026) — le protocole
 *     S3 n'a pas de commande d'espace libre ;
 *   - l'état (JSON) peut faire échouer les commandes de données sur un code
 *     d'erreur S3 standard (`echouerCode`), pour mesurer les traductions.
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
// L'adresse \`crabe:bucket/chemin\` devient un chemin local SOUS LA RACINE du
// faux : c'est ce qui rend le bucket VISIBLE dans les fichiers écrits.
const RACINE = ${JSON.stringify(path.join(RACINE_FAUX, 'stockage'))};
const local = (p) => path.join(RACINE, String(p).replace(/^[A-Za-z0-9_-]+:/, ''));

journal(cmd + ' ' + args.join(' '));

if (cmd === 'about') {
  // Mot pour mot ce que le vrai binaire répond sur un espace S3.
  process.stderr.write('NOTICE: Failed to about: S3 root doesn\\'t support about\\n');
  process.exit(1);
}

const etat = JSON.parse(fs.readFileSync(process.env.CRABE_FAUX_ETAT, 'utf8'));
if (etat.echouerCode) {
  process.stderr.write('Failed to ' + cmd + ': operation error S3: ' + etat.echouerCode + ': status code: 403\\n');
  process.exit(1);
}

try {
  if (cmd === 'lsd') {
    if (!fs.existsSync(local(args[0]))) { process.stderr.write('directory not found\\n'); process.exit(1); }
  } else if (cmd === 'mkdir') {
    fs.mkdirSync(local(args[0]), { recursive: true });
  } else if (cmd === 'copyto') {
    // dépôt : local → remote ; téléchargement : remote → local. Le premier
    // argument qui porte un préfixe \`remote:\` désigne le côté distant.
    const versRemote = /^[A-Za-z0-9_-]+:/.test(args[1]);
    const source = versRemote ? args[0] : local(args[0]);
    const cible = versRemote ? local(args[1]) : args[1];
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.copyFileSync(source, cible);
  } else if (cmd === 'deletefile') {
    fs.rmSync(local(args[0]));
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
const presets = require('../server/destinations/presets');
const erreurs = require('../server/destinations/erreurs-rclone');
const crypto = require('../server/crypto');

let S4; // la destination « MEGA (stockage objet) » d'essai
let SOCLE; // la destination « Stockage compatible S3 » d'essai
let user;

/** La configuration déchiffrée telle qu'elle vit en base. */
function confStockee(destId) {
  const ligne = helpers.db.get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
}

/** Enregistre comme la route PUT : mêmes champs résolus, même fusion. */
async function enregistrer(destId, valeurs, effacer = []) {
  const champs = await destinations.champsDe(destId);
  return destinations.saveConfig(destId, { enabled: true, valeurs, effacer }, champs);
}

const lireJournalFaux = () => fs.readFileSync(JOURNAL_FAUX, 'utf8').split('\n').filter(Boolean);
const viderJournalFaux = () => fs.writeFileSync(JOURNAL_FAUX, '');

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot62' });
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({}));
  fs.writeFileSync(JOURNAL_FAUX, '');

  S4 = destinations.createCloud({ provider: 'megas4', displayName: 'MEGA S4 d\'essai' }).id;
  SOCLE = destinations.createCloud({ provider: 's3', displayName: 'S3 d\'essai' }).id;
  require('../server/destinations/backends').oublier();
});

test.after(() => {
  helpers.teardown();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Le choix est clair AVANT de cliquer
// ---------------------------------------------------------------------------

test('les deux MEGA sont deux cartes voisines, et chacune dit à qui elle s\'adresse', () => {
  const liste = presets.liste();
  const ids = liste.map((p) => p.id);
  // Voisines : l'ordre alphabétique des libellés les met côte à côte.
  assert.equal(ids.indexOf('megas4'), ids.indexOf('mega') + 1);

  const compte = presets.of('mega');
  assert.equal(compte.label, 'MEGA (compte gratuit)');
  // La limite se lit sur la carte de choix, pas après trois échecs de dépôt.
  assert.match(compte.resume, /ne fonctionne pas si la validation en deux étapes/);

  const objet = presets.of('megas4');
  assert.equal(objet.label, 'MEGA (stockage objet, payant)');
  assert.match(objet.resume, /payant/);
  assert.match(objet.resume, /ne\s+périment pas/);
  assert.match(objet.resume, /même avec la validation en deux étapes/);

  // Le socle est là pour tous les autres fournisseurs compatibles.
  const socle = presets.of('s3');
  assert.equal(socle.label, 'Stockage compatible S3');
  assert.equal(socle.couvreLeType, true, 'la carte brute du type s3 est remplacée');
  assert.equal(objet.couvreLeType, false, 'MEGA S4 n\'est qu\'un usager du protocole');
});

test('l\'aide du mot de passe MEGA nomme la carte de sortie, avant l\'échec', () => {
  const pass = presets.CHAMPS_MEGA.find((c) => c.key === 'pass');
  assert.match(pass.help, /MEGA \(stockage objet,\s*payant\)/);
});

test('le message du refus structurel MEGA nomme la carte de sortie', () => {
  assert.match(erreurs.MESSAGE_MEGA_DEUX_ETAPES, /MEGA \(stockage objet,\s*payant\)/);
  // Et toujours aucune promesse de réessai (acquis du lot 61, non régressé).
  assert.equal(/réessayez/i.test(erreurs.MESSAGE_MEGA_DEUX_ETAPES), false);
});

// ---------------------------------------------------------------------------
// 2. Le bloc rclone produit est conforme aux options mesurées
// ---------------------------------------------------------------------------

test('MEGA S4 : provider posé d\'office, pas de region, le bucket hors du bloc', async () => {
  await enregistrer(S4, {
    endpoint: 's3.eu-paris.megas4.com',
    access_key_id: 'CLEACCESINVENTEE',
    secret_access_key: 'CLESECRETEINVENTEE',
    bucket: 'mes-documents',
  });

  const normalise = destinations.driverFor(S4).normalizeConf(confStockee(S4));
  assert.equal(
    normalise.rcloneConfig,
    [
      'type = s3',
      'provider = Mega',
      'endpoint = s3.eu-paris.megas4.com',
      'access_key_id = CLEACCESINVENTEE',
      'secret_access_key = CLESECRETEINVENTEE',
    ].join('\n'),
    'exactement les options que le binaire documente pour son provider Mega — rien de plus'
  );
  // Le bucket vit dans l'adresse, jamais dans le bloc.
  assert.equal(/bucket/.test(normalise.rcloneConfig), false);
  assert.equal(normalise.basePath, 'mes-documents/crabe');

  // Les adresses proposées sont celles que le binaire v1.75.0 documente
  // lui-même (relevé du 26/08/2026) : rien d'inventé, et la liste est stricte.
  const endpoint = presets.CHAMPS_MEGA_S4.find((c) => c.key === 'endpoint');
  assert.equal(endpoint.listeStricte, true);
  assert.equal(endpoint.options.length, 11, '7 adresses courantes + 4 anciennes générations');
  assert.ok(endpoint.options.every((o) => /\.megas4\.com$|\.s4\.mega\.io$/.test(o.value)));
});

test('le socle S3 : bloc conforme, et les options avancées d\'rclone restent atteignables', async () => {
  await enregistrer(SOCLE, {
    endpoint: 's3.fournisseur-invente.example',
    region: '',
    access_key_id: 'AUTRECLEACCES',
    secret_access_key: 'AUTRECLESECRETE',
    bucket: 'factures',
  });

  const normalise = destinations.driverFor(SOCLE).normalizeConf(confStockee(SOCLE));
  assert.equal(
    normalise.rcloneConfig,
    [
      'type = s3',
      'endpoint = s3.fournisseur-invente.example',
      'access_key_id = AUTRECLEACCES',
      'secret_access_key = AUTRECLESECRETE',
    ].join('\n'),
    'la région vide est omise, le bucket est hors du bloc'
  );
  assert.equal(normalise.basePath, 'factures/crabe');

  // Le complément d'rclone joue pour le socle (pas de versChamps) : les
  // soixante-dix options avancées du backend restent atteignables, repliées.
  const champs = await destinations.champsDe(SOCLE);
  const parCle = new Map(champs.map((c) => [c.key, c]));
  assert.ok(parCle.get('force_path_style')?.avance, 'les options rares arrivent en avancé');
  assert.ok(parCle.get('provider')?.avance, 'le provider reste choisissable, dans le repli');
  assert.equal(parCle.get('env_auth')?.avance, true, 'décision écrite : cas d\'hébergeur');
  assert.ok(champs.filter((c) => c.avance).length > 50, 'rien n\'est perdu du backend');

  // La clé secrète est un secret aux yeux de crabe, mais JAMAIS obscurcie :
  // le backend s3 la déclare IsPassword=false, rclone l'attend en clair.
  const secret = parCle.get('secret_access_key');
  assert.equal(secret.type, 'password');
  assert.equal(secret.obscurcir, false);
});

// ---------------------------------------------------------------------------
// 3. L'adresse est composée bucket d'abord — dépôt, test, téléchargement
// ---------------------------------------------------------------------------

test('le dépôt écrit dans le bucket, et le téléchargement y relit', async () => {
  const resultats = await destinations.storeInvoice({
    username: 'lot62',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-08-05',
    filename: '2026-08_100001.pdf',
    buffer: Buffer.from('%PDF-1.4 faux document lot 62'),
  });

  assert.equal(resultats[S4].ok, true);
  assert.equal(resultats[S4].path, 'crabe:mes-documents/crabe/lot62/EDF/client/2026/2026-08_100001.pdf');
  // Le fichier existe LÀ où l'adresse le dit : bucket d'abord, dossier ensuite.
  const surDisque = path.join(
    RACINE_FAUX, 'stockage', 'mes-documents', 'crabe', 'lot62', 'EDF', 'client', '2026', '2026-08_100001.pdf'
  );
  assert.ok(fs.existsSync(surDisque), 'la copie vit sous <bucket>/crabe/…');

  // Le téléchargement relit la même adresse — c'est « Mes documents ».
  const relu = await destinations.fetchInvoice(
    S4,
    {
      connector_id: 'edf',
      account_id: 'client',
      issued_on: '2026-08-05',
      filename: '2026-08_100001.pdf',
      destinations: JSON.stringify({ [S4]: { path: resultats[S4].path } }),
    },
    'lot62'
  );
  assert.equal(relu.ok, true);
  assert.equal(fs.readFileSync(relu.file, 'utf8'), '%PDF-1.4 faux document lot 62');
  relu.cleanup();
});

test('« Tester la connexion » vise le bucket, et réussit sur un espace sain', async () => {
  viderJournalFaux();
  const essai = await destinations.test(SOCLE, user.id);
  assert.equal(essai.ok, true, essai.message);
  // Chaque commande du test a visé l'adresse bucket-d'abord.
  const journal = lireJournalFaux();
  assert.ok(journal.length > 0);
  for (const ligne of journal) {
    assert.match(ligne, /crabe:factures\/crabe/, `adresse inattendue : ${ligne}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Les clés : vide conserve, neuve remplace, effacement explicite efface
// ---------------------------------------------------------------------------

test('une clé secrète laissée vide conserve l\'ancienne, une clé neuve la remplace', async () => {
  // Vide = « garde celle d'avant » : corriger l'adresse ne perd pas la clé.
  await enregistrer(SOCLE, { endpoint: 's3.autre-adresse.example', secret_access_key: '' });
  let conf = confStockee(SOCLE);
  assert.equal(conf.valeurs.secret_access_key, 'AUTRECLESECRETE', 'la clé d\'avant est conservée');
  assert.equal(conf.valeurs.endpoint, 's3.autre-adresse.example');

  // Une saisie neuve REMPLACE — jamais l'inverse (leçon du lot 57 : une valeur
  // conservée ne doit pas primer sur ce que l'utilisateur vient de taper).
  await enregistrer(SOCLE, { secret_access_key: 'CLESECRETENEUVE' });
  conf = confStockee(SOCLE);
  assert.equal(conf.valeurs.secret_access_key, 'CLESECRETENEUVE');
  const bloc = destinations.driverFor(SOCLE).normalizeConf(conf).rcloneConfig;
  assert.match(bloc, /^secret_access_key = CLESECRETENEUVE$/m, 'le bloc joue la clé neuve');

  // L'effacement explicite, lui, efface (lot 33).
  await enregistrer(SOCLE, {}, ['secret_access_key']);
  assert.equal(confStockee(SOCLE).valeurs.secret_access_key, undefined);

  // Et on la remet pour les tests suivants.
  await enregistrer(SOCLE, { secret_access_key: 'AUTRECLESECRETE' });
});

test('la clé secrète ne redescend jamais au navigateur', async () => {
  const fiche = await destinations.publicConfigComplet(SOCLE);
  assert.equal(fiche.valeurs.secret_access_key, undefined, 'jamais réaffichée');
  assert.ok(fiche.secretsRenseignes.includes('secret_access_key'), 'mais l\'écran sait qu\'elle est là');
  assert.equal(JSON.stringify(fiche).includes('AUTRECLESECRETE'), false, 'la valeur ne sort pas');
});

// ---------------------------------------------------------------------------
// 5. La mesure d'espace refusée par le protocole dit la phrase honnête
// ---------------------------------------------------------------------------

test('l\'espace d\'un S3 : « cette mesure n\'existe pas chez lui », jamais une accusation', async () => {
  destinations.oublierMesureEspace(SOCLE);
  const espace = await destinations.spaceFor(SOCLE);
  assert.equal(espace.known, false);
  assert.match(espace.reason, /ne sait pas annoncer l'espace restant/);
  assert.match(espace.reason, /n'est pas une panne/);
  // Ni accusation de configuration, ni « n'a pas répondu » : le service a
  // répondu — la commande n'existe simplement pas dans son protocole.
  assert.equal(/n'a pas répondu/.test(espace.reason), false);
  assert.equal(/configuration/.test(espace.reason), false);
});

// ---------------------------------------------------------------------------
// 6. Les refus S3 sortent en français, avec le champ à corriger
// ---------------------------------------------------------------------------

test('clé inconnue, signature fausse, bucket absent : trois refus, trois phrases utiles', async () => {
  // Les codes sont ceux du protocole S3 lui-même — tout fournisseur compatible
  // les renvoie tels quels, c'est même ce qui fait la compatibilité.
  const cleInconnue = erreurs.traduire('operation error S3: InvalidAccessKeyId: status code: 403');
  assert.match(cleInconnue, /ne connaît pas cette clé d'accès/);
  assert.match(cleInconnue, /Clé d'accès \(Access Key ID\)/, 'la phrase nomme le champ');

  const signatureFausse = erreurs.traduire('operation error S3: SignatureDoesNotMatch: status code: 403');
  assert.match(signatureFausse, /clé secrète ne correspond pas/);
  assert.match(signatureFausse, /Clé secrète \(Secret Access Key\)/);

  const bucketAbsent = erreurs.traduire('operation error S3: NoSuchBucket: status code: 404');
  assert.match(bucketAbsent, /bucket n'existe pas/);
  assert.match(bucketAbsent, /Nom du bucket/);

  // Aucun des trois ne tombe dans la famille générique « vérifiez l'adresse et
  // le mot de passe » : c'est une clé précise qui cloche, la phrase le dit.
  for (const message of [cleInconnue, signatureFausse, bucketAbsent]) {
    assert.equal(/Vérifiez l'adresse et le mot de passe/.test(message), false);
  }

  // Et le chemin complet : un dépôt qui essuie ce refus porte la phrase.
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({ echouerCode: 'SignatureDoesNotMatch' }));
  const resultats = await destinations.storeInvoice({
    username: 'lot62',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client',
    issuedOn: '2026-08-06',
    filename: '2026-08_100002.pdf',
    buffer: Buffer.from('%PDF-1.4 faux document'),
  });
  assert.equal(resultats[S4].ok, false);
  assert.match(resultats[S4].message, /clé secrète ne correspond pas/);
  fs.writeFileSync(ETAT_FAUX, JSON.stringify({}));
});

// ---------------------------------------------------------------------------
// 7. Le bucket oublié se dit sur la carte, avant le premier échec
// ---------------------------------------------------------------------------

test('un S3 configuré sans bucket porte l\'avertissement — un bloc collé n\'est pas inquiété', async () => {
  const nu = destinations.createCloud({ provider: 's3', displayName: 'S3 sans bucket' }).id;

  // Une carte neuve, vide : rien à dire.
  let fiche = await destinations.publicConfigComplet(nu);
  assert.equal((fiche.avertissements || []).length, 0, 'une carte vide n\'a pas d\'avertissement');

  // Des clés sans bucket : les copies viseraient un bucket « crabe » inventé.
  await enregistrer(nu, {
    endpoint: 's3.exemple.example',
    access_key_id: 'CLE',
    secret_access_key: 'SECRET',
  });
  fiche = await destinations.publicConfigComplet(nu);
  assert.ok(
    (fiche.avertissements || []).some((a) => /Aucun nom de bucket/.test(a)),
    'l\'avertissement se lit au moment d\'enregistrer, pas au premier échec'
  );

  // Le bucket saisi : l'avertissement tombe.
  await enregistrer(nu, { bucket: 'mon-bucket' });
  fiche = await destinations.publicConfigComplet(nu);
  assert.equal((fiche.avertissements || []).some((a) => /bucket/.test(a)), false);

  // Un bloc collé à la main range le bucket dans le dossier de base : rien à
  // redire non plus.
  const colle = destinations.createCloud({ provider: 's3', displayName: 'S3 bloc collé' }).id;
  destinations.saveConfig(colle, {
    basePath: 'bucket-existant/crabe',
    rcloneConfig: 'type = s3\nendpoint = s3.exemple.example\naccess_key_id = CLE\nsecret_access_key = SECRET',
  });
  fiche = await destinations.publicConfigComplet(colle);
  assert.equal((fiche.avertissements || []).some((a) => /bucket/.test(a)), false);

  destinations.deleteCloud(nu);
  destinations.deleteCloud(colle);
});
