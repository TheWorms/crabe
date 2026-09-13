'use strict';

/**
 * Lot 29 — Proton Drive, le second mot de passe, et les 688 champs perdus.
 *
 * ─── Le défaut, tel qu'il s'est manifesté ────────────────────────────────────
 *
 * Formulaire Proton Drive rempli, bouton « Tester la connexion » :
 *
 *     CRITICAL: Failed to create file system for "crabe:crabe": couldn't
 *     initialize a new proton drive instance: this account requires a mailbox
 *     password
 *
 * Les comptes Proton en mode « deux mots de passe » en ont un SECOND, distinct
 * de celui de connexion, qui déchiffre le contenu. rclone le demande sous le
 * nom `mailbox_password`. Il n'y avait aucune case pour le saisir, et il n'y
 * en avait aucune pour une raison qui dépasse largement Proton Drive : rclone
 * classe cette option parmi ses « avancées », et crabe jetait purement et
 * simplement toutes les options avancées.
 *
 * Mesuré sur le catalogue réel du serveur : **688 options avancées sur 968**,
 * réparties sur les 69 types. Sept champs sur dix inatteignables — dont le
 * jeton d'autorisation de pCloud, de Dropbox, de Google Drive, qui explique à
 * lui seul le « pCloud reste bloqué, et c'est structurel » du lot 28.
 *
 * ─── Ce que ce fichier mesure ────────────────────────────────────────────────
 *
 *   1. la règle générale — aucun champ déclaré par rclone n'est perdu, pour
 *      aucun type, et c'est vérifié par comparaison directe avec le catalogue ;
 *   2. l'exception qui la rend sûre — les champs qu'rclone masque lui-même du
 *      fichier de configuration ne sont PAS proposés ;
 *   3. le cas Proton Drive — `mailbox_password` saisissable, remonté parmi les
 *      champs principaux, écrit sous ce nom exact dans le fichier rclone ;
 *   4. l'écran — les champs avancés dans le repli, les courants dehors.
 *
 * ─── Pourquoi un faux rclone alimenté par le vrai catalogue ──────────────────
 *
 * La liste des types vient du binaire installé : elle est vide sur la machine
 * de développement, où rclone n'existe pas. Le faux binaire de ce fichier rend
 * donc le catalogue RELEVÉ SUR LE CONTENEUR (voir `fixtures-rclone-production.js`),
 * et il est branché par le vrai chemin — `CRABE_RCLONE_BIN`, exécuté comme le
 * serait l'autre. Il note en passant le fichier de configuration qu'on lui
 * donne : c'est ce qui permet de prouver ce que crabe écrit vraiment, plutôt
 * que ce qu'il prétend écrire.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠ AVANT tout `require` de crabe : `config.rcloneBin` est lu au chargement du
// module, pas à chaque appel.
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot29-'));
const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const TRACE_CONF = path.join(RACINE_FAUX, 'confs-vues.txt');

const CATALOGUE = require('./fixtures-rclone-production');

fs.writeFileSync(
  FAUX_RCLONE,
  '#!/usr/bin/env node\n'
    + 'const fs = require("node:fs");\n'
    // ⚠ `fs.writeSync` en boucle, et surtout PAS `process.stdout.write`. Sur un
    // tube, cette dernière est asynchrone : le `process.exit()` qui la suit
    // coupe ce qui n'est pas encore parti. Mesuré ici même — `rclone obscure`
    // rendait une chaîne VIDE, donc un mot de passe jamais rangé, donc un bloc
    // rclone sans sa ligne, et trois tests qui accusaient le produit alors que
    // le menteur était la sonde.
    + 'const ecrire = (s) => { const b = Buffer.from(s); let n = 0;'
    + ' while (n < b.length) n += fs.writeSync(1, b, n, b.length - n); };\n'
    + `const TYPES = ${JSON.stringify(CATALOGUE)};\n`
    + `const TRACE = ${JSON.stringify(TRACE_CONF)};\n`
    + 'const argv = process.argv.slice(2);\n'
    + 'const i = argv.indexOf("--config");\n'
    + 'const conf = i >= 0 ? argv[i + 1] : null;\n'
    // ⚠ `i >= 0` obligatoire. Sans lui, `indexOf` rendant -1 quand `--config`
    // est absent, le filtre `j !== i + 1` retirait l'argument d'indice 0 :
    // `["obscure", "-"]` devenait `["-"]`, le faux binaire ne se reconnaissait
    // plus, et rendait une chaîne vide. Un mot de passe jamais rangé, un bloc
    // rclone amputé — et une demi-heure passée à soupçonner le produit.
    + 'const args = i >= 0 ? argv.filter((_, j) => j !== i && j !== i + 1) : argv;\n'
    + 'if (args.includes("providers")) { ecrire(JSON.stringify(TYPES)); process.exit(0); }\n'
    + 'if (args[0] === "version") { ecrire("rclone v1.75.0-faux\\n"); process.exit(0); }\n'
    // Le vrai `rclone obscure` chiffre ; celui-ci rend un marqueur reconnaissable.
    // Ce qui compte pour le test, c'est que la valeur RANGÉE ne soit jamais celle
    // qui a été tapée — donc qu'elle soit passée par ici.
    + 'if (args[0] === "obscure") { ecrire("OBSCURCI\\n"); process.exit(0); }\n'
    // Toute commande qui travaille sur un remote reçoit un rclone.conf : on le
    // recopie pour pouvoir vérifier, plus bas, ce que crabe y a mis.
    + 'if (conf) fs.appendFileSync(TRACE, "=== " + args[0] + "\\n" + fs.readFileSync(conf, "utf8"));\n'
    + 'process.exit(0);\n',
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const helpers = require('./helpers');
const backends = require('../server/destinations/backends');
const presets = require('../server/destinations/presets');
const destinations = require('../server/destinations');
const { blocDepuisChamps } = require('../server/destinations/remote-rclone');

const WEB = path.resolve(__dirname, '..', 'web');

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({
    username: 'lot29',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  client = await helpers.startServer();
  await helpers.login(client, 'lot29', 'MotDePasse1');
  // Le cache d'une heure garderait la mesure d'un autre fichier de tests.
  backends.oublier();
});

test.after(() => {
  if (client) client.close();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

/**
 * Ce qui est VRAIMENT rangé en base pour cette destination, déchiffré.
 *
 * Lu dans la table, pas dans la réponse de l'API : un secret ne redescend
 * jamais au navigateur, et c'est justement ce qu'on veut pouvoir vérifier des
 * deux côtés.
 */
function configRangee(destId) {
  const ligne = helpers.db
    .get()
    .prepare('SELECT * FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return helpers.crypto.tryDecryptJson(ligne.config_encrypted, {});
}

/** Le bloc rclone que crabe écrira pour cette destination. */
function blocRange(destId) {
  return destinations.driverFor(destId).normalizeConf(configRangee(destId)).rcloneConfig;
}

/** Les options du catalogue, telles qu'rclone les déclare. */
function optionsDeclarees(type) {
  const brut = CATALOGUE.find((b) => b.Name === type);
  assert.ok(brut, `${type} absent de la fixture`);
  return brut.Options;
}

/** Celles qu'rclone accepte dans un fichier de configuration (bit 2 de `Hide`). */
function optionsSaisissables(type) {
  return optionsDeclarees(type).filter((o) => !(Number(o.Hide || 0) & 2));
}

// ---------------------------------------------------------------------------
// 1. La règle générale : aucun champ perdu, pour aucun type
// ---------------------------------------------------------------------------

test('le faux rclone est bien celui que crabe interroge', async () => {
  const res = await client.get('/api/admin/destinations/backends');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, 'sans cela, tout ce fichier ne mesurerait qu\'un échec');
});

test('aucun champ d\'un backend rclone n\'est perdu en route', async () => {
  // Le trou ne se découvre qu'au moment où quelqu'un a précisément besoin du
  // champ manquant — c'est exactement ce qui est arrivé avec Proton Drive. La
  // comparaison est donc faite type par type, sur la liste complète.
  for (const type of ['protondrive', 'pcloud', 'webdav', 's3', 'dropbox', 'mega']) {
    const res = await client.get(`/api/admin/destinations/backends?type=${type}`);
    assert.equal(res.status, 200);

    const rendus = new Set(res.body.champs.map((c) => c.key));
    const manquants = optionsSaisissables(type)
      .map((o) => o.Name)
      .filter((nom) => !rendus.has(nom));

    assert.deepEqual(
      manquants,
      [],
      `${type} : ${manquants.length} champ(s) impossible(s) à saisir dans crabe`
    );
  }
});

test('le compte y est, et il est gros — la mesure vaut mieux qu\'une impression', async () => {
  // 78 options pour s3, dont 64 avancées : c'est le cas qui justifie le repli
  // plutôt qu'un formulaire déplié d'office.
  const res = await client.get('/api/admin/destinations/backends?type=s3');
  assert.equal(res.body.champs.length, optionsSaisissables('s3').length);
  assert.equal(res.body.champs.filter((c) => c.avance).length > 50, true);
  // 13 et non 14 depuis le lot 62 : `env_auth` est reclassé en avancé par une
  // décision ÉCRITE (PRESENTATION_S3) — lire les clés dans l'environnement du
  // serveur est un cas d'hébergeur, pas d'utilisateur.
  assert.equal(res.body.champs.filter((c) => !c.avance).length, 13, 'le formulaire reste court');
  assert.equal(res.body.champs.find((c) => c.key === 'env_auth').avance, true);
});

test('les champs qu\'rclone masque du fichier de configuration ne sont pas proposés', async () => {
  // Les quatre `client_*` de Proton Drive portent `Hide: 3` et l'annotation
  // « internal use only » : rclone les écrit lui-même APRÈS une connexion
  // réussie. Les demander, ce serait demander de deviner le résultat d'une
  // opération qui n'a pas encore eu lieu.
  const res = await client.get('/api/admin/destinations/backends?type=protondrive');
  const rendus = res.body.champs.map((c) => c.key);
  for (const interne of ['client_uid', 'client_access_token', 'client_refresh_token',
    'client_salted_key_pass']) {
    assert.equal(rendus.includes(interne), false, `${interne} n'a rien à faire dans un formulaire`);
  }
  assert.equal(rendus.length, 11, 'les onze autres sont bien là');
});

test('le tri courant / avancé suit rclone, sauf décision écrite', async () => {
  const res = await client.get('/api/admin/destinations/backends?type=webdav');
  for (const champ of res.body.champs) {
    const declaree = optionsDeclarees('webdav').find((o) => o.Name === champ.key);
    assert.equal(
      champ.avance,
      !!declaree.Advanced,
      `${champ.key} : crabe ne doit pas reclasser une option sans raison`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Proton Drive : le second mot de passe
// ---------------------------------------------------------------------------

test('`mailbox_password` est saisissable, et remonté parmi les champs principaux', async () => {
  const res = await client.get('/api/admin/destinations/backends?type=protondrive');
  const champ = res.body.champs.find((c) => c.key === 'mailbox_password');

  assert.ok(champ, 'le champ sans lequel un compte à deux mots de passe ne marche pas');
  // rclone le classe en « avancé ». Pour ce fournisseur, c'est une décision
  // écrite dans presets.js : un compte de ce type ne peut littéralement rien
  // faire sans lui, et le chercher dans un repli n'aurait aucun sens.
  assert.equal(champ.avance, false, 'remonté exprès, pour ce fournisseur précis');
  assert.equal(
    optionsDeclarees('protondrive').find((o) => o.Name === 'mailbox_password').Advanced,
    true,
    'la remontée est bien une décision de crabe, pas un hasard du catalogue'
  );
  // rclone le déclare `IsPassword` : il passe donc par `rclone obscure` et ne
  // revient jamais au navigateur.
  assert.equal(champ.type, 'password');
  assert.equal(champ.required, false, 'la plupart des comptes n\'en ont qu\'un');
});

test('les libellés Proton Drive sont en français, et l\'aide dit quoi faire', async () => {
  const res = await client.get('/api/admin/destinations/backends?type=protondrive');
  const par = Object.fromEntries(res.body.champs.map((c) => [c.key, c]));

  // Plus une ligne de documentation rclone en anglais sur les cinq champs qui
  // se remplissent à la main.
  for (const cle of ['username', 'password', 'mailbox_password', '2fa', 'otp_secret_key']) {
    assert.equal(par[cle].label, par[cle].key === cle && par[cle].label, cle);
    assert.notEqual(par[cle].label, cle, `${cle} s'affiche encore sous son nom technique`);
    assert.equal(/your proton account|The 2FA code|The OTP secret/i.test(par[cle].help), false,
      `${cle} garde l'aide anglaise d'rclone`);
    assert.ok(par[cle].help.length > 80, `${cle} : une aide qui ne dit rien ne sert à rien`);
  }

  // Le second mot de passe : où le trouver, et que le laisser vide est normal.
  assert.match(par.mailbox_password.label, /second mot de passe/i);
  assert.match(par.mailbox_password.help, /deux/i);
  assert.match(par.mailbox_password.help, /laissez cette case vide/i);
  assert.match(par.mailbox_password.help, /Chiffrement et clés/i);
  // Le message d'erreur réellement reçu, écrit noir sur blanc : c'est ce qui
  // permet de faire le lien entre l'échec et la case à remplir.
  assert.match(par.mailbox_password.help, /requires a mailbox password/);

  // Code à usage unique contre secret qui les fabrique : la nuance a des
  // conséquences, et personne ne la devine seul.
  assert.match(par['2fa'].help, /trentaine de secondes|ne vit qu/i);
  assert.match(par.otp_secret_key.help, /ne périme pas/i);
});

test('le second mot de passe est écrit sous ce nom exact dans la configuration rclone', async () => {
  const cree = destinations.createCloud({ provider: 'proton', displayName: 'Proton d\'essai' });

  // Le vrai chemin d'enregistrement : la route PUT, celle du bouton
  // « Enregistrer ». C'est elle qui décide quoi obscurcir.
  const sauve = await client.put(`/api/admin/destinations/${cree.id}`, {
    enabled: true,
    remoteName: 'crabe',
    basePath: 'crabe',
    valeurs: {
      username: 'essai@exemple.fr',
      password: 'mot-de-passe-de-test',
      mailbox_password: 'second-mot-de-passe-de-test',
      '2fa': '',
      otp_secret_key: '',
    },
  });
  assert.equal(sauve.status, 200);

  // Ce que le navigateur reçoit en retour : surtout pas les secrets.
  const json = JSON.stringify(sauve.body);
  assert.equal(json.includes('second-mot-de-passe-de-test'), false, 'un secret ne redescend jamais');
  assert.equal(json.includes('mot-de-passe-de-test'), false);

  // Ce que crabe écrira dans le fichier rclone.conf. C'est LE piège signalé par
  // le forum rclone : sous un autre nom, l'authentification échoue.
  const bloc = blocRange(cree.id);
  assert.match(bloc, /^mailbox_password = /m, 'ce nom-là, et pas un autre');
  assert.match(bloc, /^type = protondrive$/m);
  // La valeur rangée est passée par `rclone obscure`, jamais celle qui a été
  // tapée : rclone refuse un mot de passe en clair dans sa configuration.
  assert.equal(bloc.includes('second-mot-de-passe-de-test'), false);
  assert.match(bloc, /^mailbox_password = OBSCURCI$/m);
  // Les deux cases laissées vides ne produisent pas de ligne : rclone traite
  // une clé présente et vide autrement qu'une clé absente.
  assert.equal(/^2fa = /m.test(bloc), false);
  assert.equal(/^otp_secret_key = /m.test(bloc), false);

  // Et le fichier réellement passé au binaire porte la même ligne : c'est la
  // seule preuve qui ne repose pas sur ce que crabe raconte de lui-même.
  fs.writeFileSync(TRACE_CONF, '');
  await client.post(`/api/admin/destinations/${cree.id}/test`, {});
  const vu = fs.readFileSync(TRACE_CONF, 'utf8');
  assert.match(vu, /^\[crabe\]$/m);
  assert.match(vu, /^mailbox_password = OBSCURCI$/m);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

test('un champ laissé vide ne remplace pas le mot de passe déjà enregistré', async () => {
  const cree = destinations.createCloud({ provider: 'proton', displayName: 'Proton d\'essai 2' });
  const poser = (valeurs) =>
    client.put(`/api/admin/destinations/${cree.id}`, {
      enabled: true, remoteName: 'crabe', basePath: 'crabe', valeurs,
    });

  await poser({ username: 'essai@exemple.fr', password: 'p', mailbox_password: 'm' });
  // Le geste ordinaire : corriger l'adresse e-mail sans retaper les secrets,
  // exactement ce que l'emplacement « Enregistré — laisser vide pour le
  // conserver » invite à faire.
  await poser({ username: 'autre@exemple.fr', password: '', mailbox_password: '' });

  const bloc = blocRange(cree.id);
  assert.match(bloc, /^username = autre@exemple\.fr$/m, 'la correction est prise');
  assert.match(bloc, /^mailbox_password = OBSCURCI$/m, 'le second mot de passe tient');
  assert.match(bloc, /^password = OBSCURCI$/m);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

test('les soixante cases vides d\'un espace S3 ne sont pas rangées pour autant', async () => {
  const cree = destinations.createCloud({ provider: 'autre', displayName: 'S3 d\'essai' });
  const champs = await destinations.champsDe(cree.id, 's3');
  assert.ok(champs.length > 70, 'le formulaire propose bien tout ce que s3 accepte');

  // Le formulaire renvoie TOUTES ses cases, la plupart vides. Les enregistrer
  // telles quelles remplirait la configuration chiffrée de clés vides qui ne
  // veulent rien dire — et que `blocDepuisChamps` jetterait de toute façon.
  await client.put(`/api/admin/destinations/${cree.id}`, {
    enabled: true, type: 's3', remoteName: 'crabe', basePath: 'crabe',
    valeurs: Object.fromEntries(champs.map((c) => [c.key, c.key === 'provider' ? 'AWS' : ''])),
  });

  assert.deepEqual(Object.keys(configRangee(cree.id).valeurs), ['provider']);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

// ---------------------------------------------------------------------------
// 3. Les presets à formulaire écrit ne perdent rien non plus
// ---------------------------------------------------------------------------

test('MEGA garde son formulaire soigné, et récupère ce qui lui manquait', async () => {
  const cree = destinations.createCloud({ provider: 'mega', displayName: 'MEGA d\'essai' });
  const champs = await destinations.champsDe(cree.id);

  // Les deux champs écrits à la main ouvrent le formulaire, dans l'ordre, avec
  // leurs aides françaises et le piège de la double validation.
  assert.deepEqual(champs.slice(0, 2).map((c) => c.key), ['user', 'pass']);
  assert.match(champs[1].help, /validation en deux étapes/);
  assert.equal(champs[0].avance, undefined, 'un champ soigné reste en tête de carte');

  // Et les huit autres options du backend `mega` cessent d'être hors d'atteinte.
  const rendus = new Set(champs.map((c) => c.key));
  for (const nom of optionsSaisissables('mega').map((o) => o.Name)) {
    assert.ok(rendus.has(nom), `${nom} restait impossible à saisir`);
  }
  assert.equal(champs.slice(2).every((c) => c.avance), true, 'le complément va dans le repli');

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

test('kDrive n\'est PAS complété, et c\'est la bonne décision', async () => {
  const cree = destinations.createCloud({ provider: 'kdrive', displayName: 'kDrive d\'essai' });
  const champs = await destinations.champsDe(cree.id);

  // kDrive FABRIQUE son adresse WebDAV à partir d'un numéro (`versChamps`).
  // Ajouter la case `url` du backend `webdav` afficherait un champ que la
  // transformation écrase juste après : un champ qui ne fait rien est pire
  // qu'un champ absent, parce qu'il se remplit avec confiance.
  assert.deepEqual(champs.map((c) => c.key), ['kdriveId', 'user', 'pass']);
  assert.equal(presets.of('kdrive').versChamps !== undefined, true, 'la raison de l\'exception');

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

// ---------------------------------------------------------------------------
// 4. L'écran : les avancés dans le repli, les courants dehors
// ---------------------------------------------------------------------------

/**
 * Le HTML des champs d'une carte, produit par le vrai `web/admin.js`.
 *
 * Les fonctions sont extraites et exécutées telles quelles : charger tout
 * `admin.js` exigerait un DOM, et ce n'est pas ce qu'on mesure ici.
 */
function champsRendus(destination) {
  const contexte = vm.createContext({ CHAMPS_TYPE: {}, console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  // `champHtml` replie les aides longues par `fieldHelp` (lot 57), qui vit
  // dans app.js — les deux fichiers partagent la même page, ce bac à sable
  // doit donc l'embarquer aussi, avec son seuil.
  const appSource = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  vm.runInContext(appSource.match(/^const AIDE_LONGUE = .+$/m)[0], contexte);
  const debutAide = appSource.indexOf('function fieldHelp(');
  assert.ok(debutAide > 0, 'fieldHelp introuvable dans app.js');
  vm.runInContext(appSource.slice(debutAide, appSource.indexOf('\n}\n', debutAide) + 3), contexte);
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  for (const nom of ['champsDeLaCarte', 'champHtml', 'destChampsHtml', 'destChampsAvancesHtml']) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans admin.js`);
    const fin = source.indexOf('\n}\n', debut);
    vm.runInContext(source.slice(debut, fin + 3), contexte);
  }
  contexte.D = destination;
  return {
    courants: vm.runInContext('destChampsHtml(D)', contexte),
    replies: vm.runInContext('destChampsAvancesHtml(D)', contexte),
  };
}

test('le repli de la carte APPELLE vraiment les champs avancés', () => {
  // ⚠ Le test suivant exécute `destChampsAvancesHtml()` en la nommant : il
  // prouve qu'elle rend le bon HTML, PAS qu'elle est branchée. Sans ce
  // contrôle-ci, la débrancher du gabarit de la carte ne ferait tomber aucun
  // test, et les champs avancés retourneraient au néant sans un bruit — le
  // défaut même que ce lot répare.
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const debut = source.indexOf('<details class="dest-avance">');
  assert.ok(debut > 0, 'le repli « Réglages avancés » a disparu de la carte');
  const repli = source.slice(debut, source.indexOf('</details>', debut));

  assert.match(repli, /\$\{destChampsAvancesHtml\(d\)\}/, 'le repli ne les affiche pas');
  assert.match(repli, /Ou coller une configuration rclone toute faite/, 'et l\'échappatoire reste');
  // Les champs courants, eux, restent hors du repli : les y faire tomber
  // cacherait le formulaire ordinaire derrière un triangle à déplier.
  assert.equal(repli.includes('${destChampsHtml(d)}'), false);
  assert.match(source.slice(0, debut), /\$\{destChampsHtml\(d\)\}/);
});

test('l\'écran Proton Drive : trois cases dehors, le reste dans le repli', async () => {
  const cree = destinations.createCloud({ provider: 'proton', displayName: 'Proton écran' });
  const vue = await destinations.publicConfigComplet(cree.id);
  const { courants, replies } = champsRendus(vue);

  // Le second mot de passe est DEHORS : un compte qui en a besoin ne peut rien
  // faire sans, le chercher dans un repli serait le cacher.
  assert.match(courants, /id="dest-[^"]+-champ-mailbox_password"/);
  assert.match(courants, /Second mot de passe/);
  assert.match(courants, /type="password"/);
  // Et son aide est là, sous la case, pas ailleurs.
  assert.match(courants, /laissez cette case vide/);

  // Les réglages qui n'intéressent personne restent repliés.
  for (const cle of ['encoding', 'app_version', 'enable_caching', 'description']) {
    assert.equal(courants.includes(`champ-${cle}"`), false, `${cle} encombre le formulaire`);
    assert.match(replies, new RegExp(`id="dest-[^"]+-champ-${cle}"`));
  }
  // Ceux qu'rclone masque ne sont nulle part.
  assert.equal((courants + replies).includes('client_access_token'), false);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

test('un secret enregistré ne repart pas au navigateur, même dans le repli', async () => {
  const cree = destinations.createCloud({ provider: 'proton', displayName: 'Proton secret' });
  await client.put(`/api/admin/destinations/${cree.id}`, {
    enabled: true, remoteName: 'crabe', basePath: 'crabe',
    valeurs: { username: 'essai@exemple.fr', password: 'p', mailbox_password: 'secret-du-coffre' },
  });

  const vue = await destinations.publicConfigComplet(cree.id);
  const { courants, replies } = champsRendus(vue);
  assert.equal(JSON.stringify(vue).includes('secret-du-coffre'), false);
  assert.equal((courants + replies).includes('secret-du-coffre'), false);
  // À la place, la phrase qui dit ce que « vide » veut dire — sans elle,
  // corriger une adresse e-mail effacerait le mot de passe d'à côté.
  assert.match(courants, /Enregistré — laisser vide pour le conserver/);
  // L'adresse, elle, se réaffiche : ce n'est pas un secret.
  assert.match(courants, /value="essai@exemple\.fr"/);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

test('un espace S3 ne déplie pas soixante-dix cases à l\'ouverture', async () => {
  const cree = destinations.createCloud({ provider: 'autre', displayName: 'S3 écran' });
  await client.put(`/api/admin/destinations/${cree.id}`, {
    enabled: true, type: 's3', remoteName: 'crabe', basePath: 'crabe', valeurs: {},
  });

  const vue = await destinations.publicConfigComplet(cree.id);
  const { courants, replies } = champsRendus(vue);
  const compter = (html) => (html.match(/data-champ="/g) || []).length;

  // 13 et non 14 : `env_auth` a rejoint le repli au lot 62 (décision écrite,
  // voir PRESENTATION_S3).
  assert.equal(compter(courants), 13, 'le formulaire visible reste celui d\'rclone');
  assert.ok(compter(replies) > 50, 'et rien n\'est perdu pour autant');
  // Le repli est un `<details>` fermé au chargement : la carte s'ouvre courte.
  // Ce que le test peut mesurer ici, c'est que les deux blocs sont distincts.
  assert.equal(courants.includes('data-champ="chunk_size"'), false);
  assert.match(replies, /data-champ="chunk_size"/);
  // Le défaut d'rclone s'affiche en filigrane, jamais recopié dans la case :
  // le figer dans la configuration le figerait à la version d'aujourd'hui.
  assert.match(replies, /placeholder="par défaut : [^"]+"/);

  await client.delete(`/api/admin/destinations/${cree.id}`);
});

// ---------------------------------------------------------------------------
// 5. Les pièces, prises séparément
// ---------------------------------------------------------------------------

test('`habiller` remplace les mots, jamais la liste des champs', () => {
  const bruts = [
    { key: 'username', label: 'username', help: 'The username.', avance: false },
    { key: 'encoding', label: 'encoding', help: 'The encoding.', avance: true },
    { key: 'inconnu_de_crabe', label: 'inconnu_de_crabe', help: 'x', avance: true },
  ];
  const habilles = presets.habiller('protondrive', bruts);

  assert.equal(habilles.length, 3, 'aucun champ n\'est retiré par l\'habillage');
  assert.match(habilles[0].label, /Adresse e-mail/);
  // Un champ qu'aucun libellé français ne couvre garde le sien et reste
  // affiché : rien ne disparaît faute d'avoir été prévu.
  assert.equal(habilles[2].label, 'inconnu_de_crabe');
  assert.equal(habilles[2].avance, true);
  // Un type sans habillage ressort tel quel.
  assert.deepEqual(presets.habiller('s3', bruts), bruts);
});

test('`Hide` est lu comme rclone le lit — un jeu de bits, pas un booléen', () => {
  const champ = (hide) => backends.champDepuisOption({ Name: 'x', Hide: hide });
  // 1 = caché de la ligne de commande seulement : reste valable en fichier de
  // configuration, donc reste saisissable.
  assert.equal(champ(0).masque, false);
  assert.equal(champ(1).masque, false);
  assert.equal(champ(2).masque, true);
  assert.equal(champ(3).masque, true);
  assert.equal(backends.MASQUE_FICHIER_CONF, 2);
});

test('un champ vide ne produit pas de ligne dans le bloc rclone', () => {
  const bloc = blocDepuisChamps('protondrive', {
    username: 'moi@exemple.fr',
    mailbox_password: 'OBSCURCI',
    '2fa': '',
    otp_secret_key: '   ',
  });
  assert.equal(bloc, 'type = protondrive\nusername = moi@exemple.fr\nmailbox_password = OBSCURCI');
});
