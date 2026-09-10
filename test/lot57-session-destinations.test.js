'use strict';

/**
 * Lot 57 — une session morte ne prend plus le dessus.
 *
 * ─── L'incident mesuré du 25/08/2026 ─────────────────────────────────────────
 *
 * La session durable Proton Drive, révoquée côté service, restait rangée dans
 * la configuration — et comme une session présente remplace mot de passe ET
 * code 2FA au moment de jouer le bloc rclone (comportement mesuré au lot 34),
 * TROIS réenregistrements avec des identifiants corrects sont restés sans
 * effet : la séquence « 401 Invalid access token » → « 400 Invalid refresh
 * token (Code=10013) » → « 422 Code=8002 sur /auth/v4/2fa » se rejouait à
 * l'identique. Et le chemin qui tuait la session : la mesure d'espace, qui
 * jouait le bloc SANS le relevé des secrets réécrits — chaque rotation du
 * refresh token pendant un `rclone about` jetait le jeton neuf avec le
 * fichier temporaire.
 *
 * Les règles vérifiées ici :
 *   1. une saisie neuve (mot de passe, second mot de passe, code, clé) écarte
 *      la session conservée — elle ne survit que si rien de neuf n'arrive ;
 *   2. une session refusée par le service est marquée morte, et n'est plus
 *      JAMAIS rejouée ; la carte le dit ;
 *   3. les messages distinguent les causes : session révoquée ≠ mot de passe
 *      refusé ≠ second facteur ≠ second mot de passe manquant ;
 *   4. tout chemin qui joue une configuration persiste les jetons rafraîchis
 *      — la mesure d'espace comprise ;
 *   5. « repartir de zéro » oublie session et valeurs, jamais la destination.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Le faux rclone AVANT tout require de crabe : backends.js lit le chemin du
// binaire à l'initialisation. Même recette que destinations-secrets — et
// l'écriture passe par fs.writeSync en boucle (process.stdout.write se
// tronque sur un tube). `about` a deux humeurs, choisies par CRABE_FAUX_MODE :
//   - « rotation » : il tourne la session dans SON fichier de configuration,
//     comme le vrai rclone face à un jeton à rafraîchir ;
//   - « refus-session » : il refuse comme Proton a refusé le 25/08/2026.
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot57-'));
const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

fs.writeFileSync(
  FAUX_RCLONE,
  '#!/usr/bin/env node\n'
    + 'const fs = require("node:fs");\n'
    + 'const ecrire = (s) => { const b = Buffer.from(s); let n = 0;'
    + ' while (n < b.length) n += fs.writeSync(1, b, n, b.length - n); };\n'
    + `const TYPES = ${JSON.stringify(CATALOGUE)};\n`
    + 'const argv = process.argv.slice(2);\n'
    + 'const i = argv.indexOf("--config");\n'
    + 'const confFile = i >= 0 ? argv[i + 1] : null;\n'
    + 'const args = i >= 0 ? argv.filter((_, j) => j !== i && j !== i + 1) : argv;\n'
    + 'if (args.includes("providers")) { ecrire(JSON.stringify(TYPES)); process.exit(0); }\n'
    + 'if (args[0] === "version") { ecrire("rclone v1.75.0-faux\\n"); process.exit(0); }\n'
    + 'if (args[0] === "obscure") { ecrire("OBSCURCI\\n"); process.exit(0); }\n'
    + 'if (args[0] === "about") {\n'
    + '  if (process.env.CRABE_FAUX_MODE === "refus-session") {\n'
    + '    process.stderr.write("Failed to about: 401 POST https://exemple.invalid: Invalid access token (Code=401)\\n");\n'
    + '    process.exit(1);\n'
    + '  }\n'
    + '  const conf = fs.readFileSync(confFile, "utf8");\n'
    + '  fs.writeFileSync(confFile, conf\n'
    + '    .replace(/^client_access_token = .*$/m, "client_access_token = ACCES-NEUF")\n'
    + '    .replace(/^client_refresh_token = .*$/m, "client_refresh_token = REFRESH-NEUF"));\n'
    + '  ecrire(JSON.stringify({ total: 1000, free: 900, used: 100 }));\n'
    + '  process.exit(0);\n'
    + '}\n'
    + 'process.exit(0);\n',
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const backends = require('../server/destinations/backends');
const destinations = require('../server/destinations');
const erreurs = require('../server/destinations/erreurs-rclone');
const crypto = require('../server/crypto');
const db = require('../server/db/db');

let client;
let proton;

/** La configuration déchiffrée telle qu'elle vit en base. */
function confStockee(destId) {
  const ligne = db
    .get()
    .prepare('SELECT config_encrypted FROM destinations_config WHERE dest_id = ?')
    .get(destId);
  return crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
}

/** Pose une session durable, comme rclone le fait après une connexion réussie. */
function etablirSession(destId, suffixe = '1') {
  destinations.driverFor(destId).normalizeConf(confStockee(destId)).onSecretsRafraichis({
    client_uid: `UID-${suffixe}`,
    client_access_token: `ACCES-${suffixe}`,
    client_refresh_token: `REFRESH-${suffixe}`,
    client_salted_key_pass: `SEL-${suffixe}`,
  });
}

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot57', plainPassword: 'MotDePasse1', role: 'admin' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot57', 'MotDePasse1');
  backends.oublier();

  proton = destinations.createCloud({ provider: 'proton' });
  const saisie = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: {
      username: 'camille@exemple.fr',
      password: 'AncienMotDePasse',
      mailbox_password: 'AncienSecond',
      '2fa': '111111',
    },
  });
  assert.equal(saisie.status, 200, JSON.stringify(saisie.body));
});

test.after(() => {
  client?.close();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Le code à usage unique part avec l'établissement de la session
// ---------------------------------------------------------------------------

test('la session établie emporte le code à usage unique, qui a péri par construction', () => {
  assert.equal(confStockee(proton.id).valeurs['2fa'], '111111', 'le code attend la connexion');
  etablirSession(proton.id, 'VIVANTE');

  const conf = confStockee(proton.id);
  assert.equal(conf.valeurs.client_access_token, 'ACCES-VIVANTE', 'la session est rangée');
  // Le rejeu de ce code figé est le « 422 Code=8002 » mesuré le 25/08/2026 :
  // un code ne sert qu'une fois, le conserver garantit ce refus.
  assert.equal('2fa' in conf.valeurs, false, 'le code consommé ne reste pas');
});

// ---------------------------------------------------------------------------
// Une saisie neuve écarte la session conservée
// ---------------------------------------------------------------------------

test('une ressaisie complète remplace la session morte — le défaut des trois réenregistrements', async () => {
  // L'état de l'incident : session enregistrée (morte côté service, mais crabe
  // ne le sait pas encore), et l'utilisateur ressaisit TOUT, correctement.
  const rendu = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: {
      username: 'camille@exemple.fr',
      password: 'MotDePasseNeuf',
      mailbox_password: 'SecondNeuf',
      '2fa': '222222',
    },
  });
  assert.equal(rendu.status, 200, JSON.stringify(rendu.body));

  const conf = confStockee(proton.id);
  assert.deepEqual(
    Object.keys(conf.valeurs).filter((cle) => cle.startsWith('client_')),
    [],
    'plus aucune clé de session dans la configuration stockée'
  );
  const normalise = destinations.driverFor(proton.id).normalizeConf(conf);
  assert.equal(
    /client_access_token/.test(normalise.rcloneConfig),
    false,
    'le bloc joué repart sur les saisies, jamais sur la session écartée'
  );
  assert.match(normalise.rcloneConfig, /^2fa = 222222$/m, 'le code neuf, lui, est joué');
});

test('un seul champ neuf suffit — le code frais écarte la session, le reste est conservé', async () => {
  etablirSession(proton.id, 'MORTE');
  const rendu = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { '2fa': '333333' },
  });
  assert.equal(rendu.status, 200, JSON.stringify(rendu.body));

  const conf = confStockee(proton.id);
  assert.equal('client_access_token' in conf.valeurs, false, 'session écartée');
  assert.equal(conf.valeurs.password, 'OBSCURCI', 'le mot de passe enregistré reste (vide = garde)');
});

test('sans rien de neuf, la session survit — renommer une carte ne déconnecte personne', async () => {
  etablirSession(proton.id, 'GARDEE');
  const rendu = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    displayName: 'Proton de Camille',
  });
  assert.equal(rendu.status, 200, JSON.stringify(rendu.body));
  assert.equal(
    confStockee(proton.id).valeurs.client_access_token,
    'ACCES-GARDEE',
    'aucune saisie de connexion : la session reste'
  );
});

// ---------------------------------------------------------------------------
// Une session refusée est marquée morte, et n'est plus jamais rejouée
// ---------------------------------------------------------------------------

test('le refus du service marque la session ; le bloc joué ne la contient plus ; la carte le dit', async () => {
  // La session est en place, et le service la refuse pendant une mesure
  // d'espace — le chemin réel de l'incident.
  process.env.CRABE_FAUX_MODE = 'refus-session';
  destinations.oublierMesureEspace(proton.id);
  const mesure = await destinations.spaceFor(proton.id);
  delete process.env.CRABE_FAUX_MODE;

  assert.equal(mesure.known, false, 'la mesure échoue, et le dit');

  const conf = confStockee(proton.id);
  assert.ok(conf.sessionMorteLe, 'la marque est posée, avec sa date');

  // Plus jamais rejouée : ni la session, ni le code à usage unique périmé.
  const normalise = destinations.driverFor(proton.id).normalizeConf(conf);
  assert.equal(/client_/.test(normalise.rcloneConfig), false, 'la session morte ne joue plus');
  assert.equal(/^2fa =/m.test(normalise.rcloneConfig), false, 'le code figé non plus');
  assert.match(normalise.rcloneConfig, /^password = /m, 'le mot de passe, lui, se rejoue');

  // La carte : plus de badge vert mensonger, la date du refus et le geste.
  const carte = await destinations.publicConfigComplet(proton.id);
  assert.ok(carte.sessionMorteLe, 'la carte porte la date du refus');

  // Une saisie neuve lève la marque et repart propre.
  const rendu = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { password: 'EncorePlusNeuf', '2fa': '444444' },
  });
  assert.equal(rendu.status, 200);
  assert.equal(confStockee(proton.id).sessionMorteLe, undefined, 'la ressaisie lève la marque');
});

test('un mot de passe faux ne marque JAMAIS la session — la signature est celle du service', () => {
  etablirSession(proton.id, 'INNOCENTE');
  assert.equal(
    destinations.marquerSessionMorte(proton.id, '401 Unauthorized: incorrect password'),
    false,
    'un refus d\'identifiants n\'est pas une mort de session'
  );
  assert.equal(confStockee(proton.id).sessionMorteLe, undefined);

  assert.equal(
    destinations.marquerSessionMorte(proton.id, '400 POST /auth/v4: Invalid refresh token (Code=10013)'),
    true,
    'la signature mesurée du 25/08/2026, elle, marque'
  );
  assert.ok(confStockee(proton.id).sessionMorteLe);
});

test('sans session enregistrée, rien à marquer — le refus vient d\'ailleurs', async () => {
  // La session vient d'être marquée puis écartée par le test précédent : on
  // repart d'une configuration sans session.
  await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { password: 'SansSession', '2fa': '555555' },
  });
  assert.equal(
    destinations.marquerSessionMorte(proton.id, '401 Invalid access token'),
    false,
    'aucune session enregistrée : la marque n\'a pas d\'objet'
  );
});

// ---------------------------------------------------------------------------
// Les jetons rafraîchis sont persistés sur TOUS les chemins
// ---------------------------------------------------------------------------

test('la mesure d\'espace persiste la rotation des jetons — le chemin qui tuait la session', async () => {
  etablirSession(proton.id, 'ANCIENNE');

  destinations.oublierMesureEspace(proton.id);
  const mesure = await destinations.spaceFor(proton.id);
  assert.equal(mesure.known, true, JSON.stringify(mesure));

  const conf = confStockee(proton.id);
  assert.equal(
    conf.valeurs.client_refresh_token,
    'REFRESH-NEUF',
    'le jeton tourné pendant « rclone about » est rangé — il ne part plus avec le fichier temporaire'
  );
  assert.equal(conf.valeurs.client_access_token, 'ACCES-NEUF');
});

// ---------------------------------------------------------------------------
// Les messages distinguent les causes
// ---------------------------------------------------------------------------

test('session révoquée ≠ mot de passe refusé ≠ second facteur ≠ second mot de passe', () => {
  // La séquence mesurée du 25/08/2026, phrase par phrase.
  const revoquee = erreurs.traduire('Failed to about: 401 POST https://exemple.invalid: Invalid access token (Code=401)');
  assert.match(revoquee, /session enregistrée .* fermée ou a expiré/);
  assert.match(revoquee, /identifiants n'y sont pour rien/, 'on n\'accuse plus le mot de passe');

  const refresh = erreurs.traduire('400 POST /auth/v4: Invalid refresh token (Code=10013)');
  assert.match(refresh, /session enregistrée/);

  const facteur = erreurs.traduire('422 POST /auth/v4/2fa: Incorrect login credentials (Code=8002)');
  assert.match(facteur, /code de validation/, 'le second facteur est nommé');
  assert.match(facteur, /EN CE MOMENT/, 'et le geste est dit : un code frais');

  const second = erreurs.traduire('protondrive: this account requires a mailbox password');
  assert.match(second, /Second mot de passe \(déchiffrement\)/, 'la phrase nomme le champ du formulaire');

  const motDePasse = erreurs.traduire('couldn\'t login: incorrect password');
  assert.match(motDePasse, /Vérifiez l'adresse et le mot de passe/, 'le refus d\'identifiants reste dit tel quel');
  assert.doesNotMatch(motDePasse, /session/, 'et ne parle pas de session');
});

// ---------------------------------------------------------------------------
// Les formulaires respirent : le rare se range, l'essentiel reste
// ---------------------------------------------------------------------------

test('le rare se range en avancé : client_id/client_secret pCloud, clé TOTP Proton — le second mot de passe reste visible', async () => {
  const champsProton = await destinations.champsDe(proton.id);
  const de = (liste, cle) => liste.find((c) => c.key === cle);

  // Le rangement Proton : la clé TOTP est le cas rare (« ne le faites que si
  // vous en avez vraiment besoin ») — elle descend dans « Réglages avancés ».
  assert.equal(de(champsProton, 'otp_secret_key').avance, true, 'la clé TOTP se range');
  // Le second mot de passe, lui, RESTE au premier niveau : un champ replié
  // que l'utilisateur ne trouve pas reproduirait l'incident (« this account
  // requires a mailbox password »).
  assert.equal(de(champsProton, 'mailbox_password').avance, false, 'le second mot de passe reste visible');
  assert.equal(de(champsProton, 'password').avance, false);
  assert.equal(de(champsProton, '2fa').avance, false);

  const pcloud = destinations.createCloud({ provider: 'pcloud' });
  const champsPcloud = await destinations.champsDe(pcloud.id);
  // rclone classe client_id/client_secret parmi les options courantes
  // (« Leave blank normally ») : elles s'étalaient au premier niveau alors que
  // personne ne les remplit. Rangées, avec leur aide en français.
  assert.equal(de(champsPcloud, 'client_id').avance, true, 'client_id se range');
  assert.equal(de(champsPcloud, 'client_secret').avance, true, 'client_secret aussi');
  assert.match(de(champsPcloud, 'client_id').help, /laisser vide/i, 'et l\'aide dit quoi en faire, en français');
  // La région, elle, reste l'essentiel de la carte.
  assert.equal(de(champsPcloud, 'hostname').avance, false, 'la région reste au premier niveau');
});

// ---------------------------------------------------------------------------
// « Repartir de zéro »
// ---------------------------------------------------------------------------

test('repartir de zéro oublie session et valeurs — jamais la destination ni son nom', async () => {
  etablirSession(proton.id, 'AOUBLIER');
  const rendu = await client.post(`/api/admin/destinations/${proton.id}/reinitialiser`, {});
  assert.equal(rendu.status, 200, JSON.stringify(rendu.body));

  const conf = confStockee(proton.id);
  assert.equal(conf.valeurs, undefined, 'toutes les valeurs sont oubliées');
  assert.equal(conf.rcloneConfig, '', 'le bloc aussi');
  assert.equal(conf.sessionMorteLe, undefined, 'la marque n\'a plus d\'objet');

  const carte = await destinations.publicConfigComplet(proton.id);
  assert.equal(carte.configured, false, 'la carte se rouvre vide');
  assert.equal(carte.displayName, 'Proton de Camille', 'le nom donné reste');
  assert.equal(carte.provider, 'proton', 'le fournisseur aussi');
});

test('repartir de zéro sur la dernière destination active : refusé, comme la suppression', async () => {
  // Le cloud devient la seule destination active…
  const actif = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: true,
    valeurs: { username: 'camille@exemple.fr', password: 'MotDePasse', '2fa': '666666' },
  });
  assert.equal(actif.status, 200, JSON.stringify(actif.body));
  destinations.deleteCloud('local');

  assert.throws(
    () => destinations.repartirDeZero(proton.id),
    (err) => err.statusCode === 400 && /dernier espace de stockage actif/.test(err.message),
    'sans lui, crabe n\'aurait plus nulle part où déposer'
  );

  destinations.restoreLocal();
  const remis = destinations.repartirDeZero(proton.id);
  assert.ok(remis, 'avec un autre espace actif, le geste passe');
});
