'use strict';

/**
 * Les secrets des destinations : contrôle de forme, effacement explicite,
 * avertissements, et erreurs rclone en français (lot 33, phase D).
 *
 * ─── Les deux pannes mesurées le 14/08/2026 ──────────────────────────────────
 *
 * En production, chaque document rangé échouait sur ses copies secondaires :
 *
 *     pCloud       : « empty token - please run rclone config reconnect »
 *                    — la configuration était VIDE, aucun jeton n'avait
 *                    jamais été enregistré, et rien à l'écran ne le disait ;
 *     Proton Drive : « couldn't generate 2FA code: Decoding of secret as
 *                    base32 failed » — la « Clé de votre application
 *                    d'authentification » contenait un code à six chiffres
 *                    (l'alphabet base32 n'a ni 0, ni 1, ni 8, ni 9).
 *
 * Quatre règles en sortent : la forme d'un champ se refuse À LA SAISIE avec
 * un message qui dit quoi faire ; un secret enregistré doit pouvoir être
 * EFFACÉ (vide = « garde celui d'avant », donc il faut un geste dédié) ; une
 * configuration qui condamne les prochains dépôts est dite au moment
 * d'enregistrer ; et un message d'rclone ne s'affiche jamais en anglais.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Le faux rclone AVANT tout require de crabe : backends.js lit le chemin du
// binaire à l'initialisation. Même recette que lot29-champs-avances — le
// catalogue est celui relevé en production, et l'écriture passe par
// fs.writeSync en boucle (process.stdout.write se tronque sur un tube).
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot33d-'));
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
    + 'const args = i >= 0 ? argv.filter((_, j) => j !== i && j !== i + 1) : argv;\n'
    + 'if (args.includes("providers")) { ecrire(JSON.stringify(TYPES)); process.exit(0); }\n'
    + 'if (args[0] === "version") { ecrire("rclone v1.75.0-faux\\n"); process.exit(0); }\n'
    + 'if (args[0] === "obscure") { ecrire("OBSCURCI\\n"); process.exit(0); }\n'
    + 'process.exit(0);\n',
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const backends = require('../server/destinations/backends');
const presets = require('../server/destinations/presets');
const destinations = require('../server/destinations');
const erreurs = require('../server/destinations/erreurs-rclone');

let client;
let proton;
let pcloud;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({
    username: 'lot33d',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  client = await helpers.startServer();
  await helpers.login(client, 'lot33d', 'MotDePasse1');
  backends.oublier();

  proton = destinations.createCloud({ provider: 'proton' });
  pcloud = destinations.createCloud({ provider: 'pcloud' });
});

test.after(() => {
  client?.close();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Contrôle de forme à la saisie
// ---------------------------------------------------------------------------

test('le champ du code Proton n\'accepte que six chiffres, et le refus dit quoi faire', async () => {
  const mauvais = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { '2fa': 'ABC123' },
  });
  assert.equal(mauvais.status, 400);
  assert.match(mauvais.body.error, /six chiffres/);
  assert.match(mauvais.body.error, /application d'authentification/, 'le message dit où trouver le code');

  // Six chiffres avec des espaces : accepté, normalisé.
  const bon = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { '2fa': '123 456' },
  });
  assert.equal(bon.status, 200, JSON.stringify(bon.body));
});

test('le champ de la clé Proton refuse un code à six chiffres, et nomme la confusion', async () => {
  // LE défaut mesuré : le code saisi à la place de la clé. Le refus doit
  // expliquer la différence, pas répéter « valeur invalide ».
  const code = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { otp_secret_key: '807305' },
  });
  assert.equal(code.status, 400);
  assert.match(code.body.error, /code à six chiffres, pas à la clé/);

  // Des caractères hors alphabet base32 (0, 1, 8, 9 mêlés à des lettres).
  const illisible = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { otp_secret_key: 'ABC189XYZ' },
  });
  assert.equal(illisible.status, 400);
  assert.match(illisible.body.error, /chiffres de 2 à 7/);

  // La vraie forme, avec les espaces de présentation : acceptée.
  const cle = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { otp_secret_key: 'jbsw y3dp ehpk 3pxp' },
  });
  assert.equal(cle.status, 200, JSON.stringify(cle.body));
});

// ---------------------------------------------------------------------------
// Un secret se voit, et s'efface
// ---------------------------------------------------------------------------

test('la carte dit QUELS secrets ont une valeur, et l\'effacement explicite les retire', async () => {
  // La clé vient d'être enregistrée par le test précédent.
  const avant = await client.get('/api/admin/destinations');
  const carteAvant = avant.body.destinations.find((d) => d.id === proton.id);
  assert.ok(
    carteAvant.secretsRenseignes.includes('otp_secret_key'),
    `secretsRenseignes: ${JSON.stringify(carteAvant.secretsRenseignes)}`
  );
  // Les valeurs des secrets, elles, ne redescendent JAMAIS.
  assert.equal(carteAvant.valeurs.otp_secret_key, undefined);

  // Enregistrer AVEC LA CASE VIDE conserve le secret — c'est la règle établie,
  // désormais mesurée par un test plutôt que découverte en production.
  await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { otp_secret_key: '' },
  });
  const conserve = await client.get('/api/admin/destinations');
  assert.ok(
    conserve.body.destinations.find((d) => d.id === proton.id).secretsRenseignes
      .includes('otp_secret_key'),
    'vide = « garde celui d\'avant », le secret doit survivre'
  );

  // L'effacement EXPLICITE, lui, retire la valeur.
  await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: {},
    effacer: ['otp_secret_key'],
  });
  const apres = await client.get('/api/admin/destinations');
  assert.equal(
    apres.body.destinations.find((d) => d.id === proton.id).secretsRenseignes
      .includes('otp_secret_key'),
    false,
    'le secret explicitement effacé ne doit plus exister'
  );
});

// ---------------------------------------------------------------------------
// Les avertissements au moment d'enregistrer
// ---------------------------------------------------------------------------

test('un code à usage unique sans clé condamne la planification, et l\'enregistrement le dit', async () => {
  // Après l'effacement du test précédent, la destination n'a plus que le code.
  const rendu = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { '2fa': '654321' },
  });
  assert.equal(rendu.status, 200);
  assert.equal(rendu.body.avertissements.length, 1, JSON.stringify(rendu.body.avertissements));
  assert.match(rendu.body.avertissements[0], /trentaine de secondes/);
  assert.match(rendu.body.avertissements[0], /échouera/);

  // La clé enregistrée à son tour, l'avertissement disparaît.
  const complet = await client.put(`/api/admin/destinations/${proton.id}`, {
    enabled: false,
    valeurs: { otp_secret_key: 'JBSWY3DPEHPK3PXP' },
  });
  assert.deepEqual(complet.body.avertissements, []);
});

test('pCloud sans jeton : l\'avertissement est là, sur la réponse et sur la carte', async () => {
  const rendu = await client.put(`/api/admin/destinations/${pcloud.id}`, {
    enabled: false,
    valeurs: {},
  });
  assert.equal(rendu.status, 200);
  assert.match(rendu.body.avertissements[0], /jeton d'accès/i);
  assert.match(rendu.body.avertissements[0], /échoueront/);

  const liste = await client.get('/api/admin/destinations');
  const carte = liste.body.destinations.find((d) => d.id === pcloud.id);
  assert.match(carte.avertissements[0], /jeton d'accès/i);

  // ⚠ Mis à jour au lot 34. Le lot 33 avait remonté le champ du jeton hors
  // des réglages avancés — personne ne pouvait deviner qu'il était
  // indispensable. Le lot 34 va au bout du chemin : le jeton s'obtient par le
  // bouton « Se connecter à pCloud » (l'autorisation menée par crabe, dans sa
  // fenêtre visible), et le champ à coller REDESCEND dans les réglages
  // avancés — il reste là pour qui a déjà un jeton rclone, mais plus personne
  // n'a à le remplir à la main. Ce qui ne change pas : secret, en français,
  // et JAMAIS obscurci (rclone l'attend en clair).
  const jeton = carte.champs.find((c) => c.key === 'token');
  assert.ok(jeton, 'le champ token doit exister');
  assert.equal(jeton.avance, true, 'la voie normale est le bouton — le champ est un secours');
  assert.equal(jeton.type, 'password', 'secret : jamais réaffiché');
  assert.match(jeton.label, /Jeton d'accès pCloud/);
  assert.match(jeton.help, /rclone authorize/);
  // Et la voie normale est bien déclarée à la carte : le bouton s'affichera.
  assert.equal(carte.autorisation?.possible, true, 'pCloud passe par « Se connecter »');
  // La région, elle, est la question VISIBLE du formulaire (mesuré : sans
  // elle, un compte européen répond « Invalid access_token (2094) »).
  const region = carte.champs.find((c) => c.key === 'hostname');
  assert.equal(region?.avance, false, 'la région est demandée d\'emblée, en français');
  assert.match(region?.label || '', /Où est hébergé votre compte pCloud/);
});

test('le jeton pCloud enregistré est rangé EN CLAIR pour rclone, et l\'avertissement tombe', async () => {
  const rendu = await client.put(`/api/admin/destinations/${pcloud.id}`, {
    enabled: false,
    valeurs: { token: '{"access_token":"jeton-de-test"}' },
  });
  assert.equal(rendu.status, 200);
  // ⚠ Mis à jour au lot 34 : l'avertissement du JETON tombe, celui de la
  // RÉGION prend sa place — un jeton sans région, c'est le cas exact de la
  // production du 14/08/2026 (compte européen → « Invalid 'access_token'
  // (2094) » à chaque copie, alors que le jeton était bon).
  assert.equal(rendu.body.avertissements.length, 1);
  assert.match(rendu.body.avertissements[0], /région/);
  assert.equal(rendu.body.avertissements.some((a) => /jeton d'accès/i.test(a)), false,
    'l\'avertissement du jeton, lui, est bien tombé');

  // La région choisie : plus rien à signaler.
  const complet = await client.put(`/api/admin/destinations/${pcloud.id}`, {
    enabled: false,
    valeurs: { hostname: 'eapi.pcloud.com' },
  });
  assert.deepEqual(complet.body.avertissements, []);

  // Jamais passé par `rclone obscure` : le faux binaire rendrait « OBSCURCI »,
  // et un jeton obscurci est un jeton mort.
  const conf = destinations.readConfig(pcloud.id);
  assert.equal(conf.valeurs.token, '{"access_token":"jeton-de-test"}');

  // Et il ne redescend pas au navigateur.
  const liste = await client.get('/api/admin/destinations');
  const carte = liste.body.destinations.find((d) => d.id === pcloud.id);
  assert.equal(carte.valeurs.token, undefined);
  assert.ok(carte.secretsRenseignes.includes('token'));
});

test('reveal() défait l\'obscurcissement d\'rclone — vérifié contre le vrai binaire', () => {
  const rclone = require('../server/destinations/rclone');
  // La paire a été produite par le rclone v1.75 de la production le 14/08/2026 :
  // c'est le binaire de production qui atteste la clé et le format.
  assert.equal(rclone.reveal('ks7O7fNGiclDniOu-aR5L9l0Hd8bJnqa'), 'jbswy3dp');
  assert.equal(rclone.reveal(''), '');
  assert.throws(() => rclone.reveal('OBSCURCI'), /illisible/);
});

test('la clé obscurcie enregistrée est examinée quand même — la panne réelle se voit sur la carte', async () => {
  // En production, la valeur fautive n'est pas rangée en clair : elle est
  // passée par `rclone obscure` à l'enregistrement. L'examen doit voir À
  // TRAVERS — c'est exactement l'état du compte réel mesuré le 14/08.
  const nodeCrypto = require('node:crypto');
  const CLE = Buffer.from([
    0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
    0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
    0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
    0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
  ]);
  const iv = nodeCrypto.randomBytes(16);
  const chiffreur = nodeCrypto.createCipheriv('aes-256-ctr', CLE, iv);
  const obscurci = Buffer.concat([iv, chiffreur.update('807305'), chiffreur.final()])
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const champs = await destinations.champsDe(proton.id);
  destinations.saveConfig(proton.id, { valeurs: { otp_secret_key: obscurci } }, champs);

  const carte = await destinations.publicConfigComplet(proton.id);
  assert.ok(
    carte.avertissements.some((a) => /ressemble à un code à six chiffres/.test(a)),
    JSON.stringify(carte.avertissements)
  );

  // Remise en état : la clé fautive est effacée pour les tests suivants.
  destinations.saveConfig(proton.id, { valeurs: {}, effacer: ['otp_secret_key'] }, champs);
});

test('une clé DÉJÀ enregistrée qui ressemble à un code est dénoncée sur la carte', () => {
  // La panne du 14/08 exactement : la valeur a été posée AVANT le contrôle de
  // saisie. La forme est examinée côté serveur — jamais modifiée ni affichée.
  const avis = presets.avertissements('protondrive', { valeurs: { otp_secret_key: '807305' } });
  assert.equal(avis.length, 1, JSON.stringify(avis));
  assert.match(avis[0], /ressemble à un code à six chiffres/);
  assert.match(avis[0], /Effacez-la/);

  // Une vraie clé ne déclenche rien.
  assert.deepEqual(
    presets.avertissements('protondrive', { valeurs: { otp_secret_key: 'JBSWY3DPEHPK3PXP' } }),
    []
  );

  // Même vigilance sur un bloc rclone collé à la main.
  const duBloc = presets.avertissements('protondrive', {
    rcloneConfig: 'type = protondrive\notp_secret_key = 807305',
  });
  assert.match(duBloc[0], /ressemble à un code/);
});

// ---------------------------------------------------------------------------
// Les erreurs rclone parlent français
// ---------------------------------------------------------------------------

test('les messages rclone mesurés en production sont traduits, avec le geste qui répare', () => {
  // pCloud, tel quel.
  const jeton = erreurs.traduire('empty token - please run rclone config reconnect');
  assert.doesNotMatch(jeton, /rclone config reconnect/);
  assert.match(jeton, /Jeton d'accès/);

  // Proton Drive, tel quel — y compris enrobé du CRITICAL d'rclone.
  const base32 = erreurs.traduire(
    'CRITICAL: Failed to create file system for "crabe:crabe": protondrive: '
      + "couldn't generate 2FA code: Decoding of secret as base32 failed"
  );
  assert.doesNotMatch(base32, /base32|CRITICAL|Failed/);
  assert.match(base32, /code à six chiffres/);
  assert.match(base32, /CLÉ/);

  // Le second mot de passe Proton, forme connue d'rclone.
  assert.match(erreurs.traduire('this account requires a mailbox password'), /Second mot de passe/);

  // Une erreur inconnue reste dite en français, le détail technique en annexe.
  const inconnue = erreurs.traduire('some very obscure failure nobody has met yet');
  assert.match(inconnue, /La copie vers cette destination a échoué/);
  assert.match(inconnue, /some very obscure failure/);

  // Et jamais une chaîne vide.
  assert.ok(erreurs.traduire('').length > 0);
});
