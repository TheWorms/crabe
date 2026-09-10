'use strict';

/**
 * Lot 74 — deux faits mesurés sur les destinations, et leurs remèdes.
 *
 * 1. **Le détail technique d'un échec gardait l'avertissement et mangeait
 *    l'erreur.** Mesuré le 09/09/2026 : trois dépôts Proton Drive en échec,
 *    et pour tout détail les 160 PREMIERS caractères de la sortie — c'est-à-
 *    dire l'avertissement « Forced to upload files to set modification
 *    times… », l'erreur réelle venant après. `detailUtile` garde désormais la
 *    DERNIÈRE ligne marquée ERROR/CRITICAL/Failed, ou à défaut la FIN du
 *    texte.
 *
 * 2. **Une destination WebDAV sans adresse s'enregistrait sans un mot.**
 *    Mesuré le 07/09/2026 : une carte kDrive enregistrée avec e-mail et mot
 *    de passe mais SANS numéro — puis quatre copies échouées sur « Propfind
 *    "/crabe": unsupported protocol scheme "" ». Le refus arrive désormais à
 *    l'ENREGISTREMENT, avec le champ à remplir.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES (§1bis).
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db/db');
const destinations = require('../server/destinations');
const presets = require('../server/destinations/presets');
const erreurs = require('../server/destinations/erreurs-rclone');

test.before(async () => {
  await helpers.setup();
});

test.beforeEach(() => {
  db.get().prepare("DELETE FROM destinations_config WHERE dest_id != 'local'").run();
  destinations.oublierPilotes();
});

// ---------------------------------------------------------------------------
// 1. Le détail technique garde l'ERREUR, pas l'avertissement
// ---------------------------------------------------------------------------

/**
 * La forme RÉELLE de la sortie qui a mangé l'erreur (chemins et fichiers
 * réécrits) : un avertissement d'abord, l'erreur ensuite.
 */
const SORTIE_PROTON = [
  "2026/09/09 08:54:41 NOTICE: proton drive root link ID 'crabe/camille/Exemple/defaut/2025': "
    + 'Forced to upload files to set modification times on this backend.',
  '2026/09/09 08:54:43 ERROR : 2025-12_000000000000.pdf: Failed to copy: '
    + 'réponse 422 du service (brouillon de téléversement refusé)',
].join('\n');

test('le détail technique est l\'erreur finale — l\'avertissement qui la précède ne la mange plus', () => {
  const phrase = erreurs.traduire(SORTIE_PROTON);
  assert.match(phrase, /détail technique/);
  assert.ok(phrase.includes('réponse 422 du service (brouillon de téléversement refusé)'),
    `l'erreur réelle doit être dans le détail — reçu : ${phrase}`);
  assert.equal(phrase.includes('Forced to upload'), false,
    'l\'avertissement rclone n\'est pas le détail : c\'est lui qui a caché trois échecs le 09/09/2026');
});

test('sans ligne marquée, le détail garde la FIN du texte — la conclusion d\'une sortie d\'outil est à la fin', () => {
  const bavardage = `${'préambule sans intérêt '.repeat(20)}la cause utile est ici, tout au bout`;
  const detail = erreurs.detailUtile(bavardage);
  assert.ok(detail.includes('la cause utile est ici, tout au bout'), `reçu : ${detail}`);
  assert.ok(detail.startsWith('…'), 'la coupe en tête se dit — le lecteur sait qu\'il manque un début');
  assert.ok(detail.length <= 161, 'le détail reste court : il sert au diagnostic, pas à la lecture');
});

test('les pannes RECONNUES gardent leur phrase : le détail ne sert qu\'aux inconnues', () => {
  const connue = erreurs.traduire('quelque chose\n2026/09/09 ERROR : 401 unauthorized');
  assert.match(connue, /a refusé les identifiants/);
});

// ---------------------------------------------------------------------------
// 2. Une destination WebDAV active sans adresse est refusée à l'enregistrement
// ---------------------------------------------------------------------------

test('la carte kDrive sans numéro est refusée en enregistrant — plus jamais « unsupported protocol scheme » quatre copies plus tard', () => {
  const cree = destinations.createCloud({ provider: 'kdrive', displayName: 'kDrive' });
  assert.throws(
    () => destinations.saveConfig(
      cree.id,
      // Exactement le geste mesuré le 07/09/2026 : e-mail et mot de passe,
      // pas de numéro.
      { enabled: true, valeurs: { user: 'camille@exemple.test', pass: 'obscurci' } },
      presets.of('kdrive').champs
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Numéro de votre kDrive/);
      return true;
    }
  );
  // Rien n'a été écrit : la configuration reste vierge.
  assert.equal(destinations.readConfig(cree.id).valeurs?.user, undefined);
});

test('désactivée, la même destination s\'enregistre — le refus ne bloque que ce qui va copier', () => {
  const cree = destinations.createCloud({ provider: 'kdrive', displayName: 'kDrive' });
  destinations.saveConfig(
    cree.id,
    { enabled: false, valeurs: { user: 'camille@exemple.test', pass: 'obscurci' } },
    presets.of('kdrive').champs
  );
  assert.equal(destinations.readConfig(cree.id).valeurs.user, 'camille@exemple.test');
  // La réactiver SANS numéro retombe sur le refus, avec la même phrase.
  assert.throws(
    () => destinations.saveConfig(cree.id, { enabled: true }, presets.of('kdrive').champs),
    /Numéro de votre kDrive/
  );
  // Le numéro renseigné, tout passe — et l'adresse composée est la forme
  // mesurée dans la documentation Infomaniak (hôte seul, aucun chemin).
  destinations.saveConfig(
    cree.id,
    { enabled: true, valeurs: { kdriveId: '123456' } },
    presets.of('kdrive').champs
  );
  assert.equal(
    destinations.adresseWebdavEffective('kdrive', destinations.readConfig(cree.id)),
    'https://123456.connect.kdrive.infomaniak.com'
  );
});

test('un WebDAV générique sans adresse, ou sans son début, est refusé avec la phrase qui dit quoi remplir', () => {
  const cree = destinations.createCloud({ provider: 'autre', displayName: 'Mon serveur' });
  // Aucune adresse du tout — ni champ, ni bloc.
  assert.throws(
    () => destinations.saveConfig(cree.id, {
      enabled: true, type: 'webdav', valeurs: { user: 'camille' },
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /adresse du serveur WebDAV n'est pas renseignée/);
      return true;
    }
  );
  // Une adresse sans schéma : le manque est nommé, avec la forme attendue.
  assert.throws(
    () => destinations.saveConfig(cree.id, {
      enabled: true, type: 'webdav', valeurs: { url: 'serveur.exemple.test/dav' },
    }),
    /commencer par https:\/\//
  );
  // L'adresse complète passe — y compris posée par un bloc collé.
  destinations.saveConfig(cree.id, {
    enabled: true,
    type: 'webdav',
    rcloneConfig: 'type = webdav\nurl = https://serveur.exemple.test/dav\nvendor = other',
  });
  assert.equal(
    destinations.adresseWebdavEffective('autre', destinations.readConfig(cree.id)),
    'https://serveur.exemple.test/dav'
  );
});

test('les autres types ne sont pas inquiétés : le refus est celui du WebDAV sans adresse, pas une règle générale', () => {
  const cree = destinations.createCloud({ provider: 'mega', displayName: 'MEGA' });
  destinations.saveConfig(
    cree.id,
    { enabled: true, valeurs: { user: 'camille@exemple.test', pass: 'obscurci' } },
    presets.of('mega').champs
  );
  assert.equal(destinations.readConfig(cree.id).valeurs.user, 'camille@exemple.test');
});
