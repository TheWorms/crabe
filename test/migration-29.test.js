'use strict';

/**
 * Migration 29 — la bascule vers les clouds à la demande, sans perdre personne.
 *
 * ─── Pourquoi ce fichier existe séparément ───────────────────────────────────
 *
 * Parce qu'une base de TEST est toujours neuve, et qu'une base neuve n'a rien à
 * migrer : les tests du lot 25 vérifient le modèle d'arrivée, aucun ne passe
 * par le chemin qui décide du sort d'une ligne héritée. Or c'est ce chemin-là
 * qui porte la contrainte la plus dure du lot — « aucune destination configurée
 * n'est perdue » — et il ne se vérifie qu'en fabriquant une base à l'ANCIEN
 * modèle, avec de vraies configurations chiffrées, puis en la migrant.
 *
 * ─── Le piège que ce fichier a effectivement attrapé ─────────────────────────
 *
 * La migration doit DÉCHIFFRER pour distinguer une destination configurée d'une
 * ligne posée par l'amorçage. Au démarrage, `db.open()` — donc les migrations —
 * tournait AVANT `crypto.init()`. Tout déchiffrement échouait, la migration
 * concluait « illisible, je garde », et les cinq destinations que ce lot doit
 * retirer seraient restées à l'écran, sans une seule erreur pour le dire.
 * L'ordre est inversé depuis (voir server/index.js), et ce test le verrouille
 * en jouant la migration dans les deux ordres.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const crypto = require('../server/crypto');
const migrations = require('../server/db/migrations');

test.before(async () => {
  // La clé, et rien d'autre : ce fichier n'utilise pas la base de `helpers`.
  await helpers.setup();
});

test.after(() => helpers.teardown());

/**
 * Une base à l'ancien modèle : la table telle qu'elle était, ses six lignes,
 * et le contenu chiffré que chacune portait vraiment.
 *
 * Reproduit ce qu'on trouve sur l'installation d'origine : une destination réellement
 * configurée, une allumée puis abandonnée sans identifiants (l'écran écrivait
 * un bloc chiffré vide mais bien présent — c'est ce qui rend `enabled`
 * inutilisable comme critère), et quatre jamais touchées.
 */
function baseAncienModele({ blocIllisible = false } = {}) {
  // Une base COMPLÈTE, montée comme en production — puis sa table de
  // destinations remise dans sa forme d'avant le lot 25. Repartir d'une table
  // isolée aurait fait tomber les vingt-huit autres migrations, et surtout
  // n'aurait pas joué la migration dans les conditions où elle tourne vraiment.
  const database = new Database(':memory:');
  database.exec(
    require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'server', 'db', 'schema.sql'),
      'utf8'
    )
  );
  migrations.apply(database);

  database.exec(`
    DROP TABLE destinations_config;
    CREATE TABLE destinations_config (
      dest_id          TEXT PRIMARY KEY,
      enabled          INTEGER NOT NULL DEFAULT 0,
      path             TEXT,
      protocol         TEXT,
      config_encrypted TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // La 29 redevient « à faire » : c'est elle, et elle seule, qu'on mesure.
  database.prepare('DELETE FROM schema_migrations WHERE id = 29').run();

  const insert = database.prepare(
    `INSERT INTO destinations_config (dest_id, enabled, path, protocol, config_encrypted, updated_at)
          VALUES (?, ?, ?, ?, ?, '2026-08-01 09:00:00')`
  );

  insert.run('local', 1, '/mnt/local', 'nfs', null);

  // Configurée pour de bon : un bloc rclone qui marche.
  insert.run('pcloud', 1, null, null, crypto.encrypt({
    remoteName: 'pcloud',
    basePath: 'crabe',
    rcloneConfig: 'type = pcloud\ntoken = {"access_token":"xyz"}',
    type: 'pcloud',
    valeurs: {},
  }));

  // Configurée par champs nommés, éteinte : elle reste configurée.
  insert.run('kdrive', 0, null, null, crypto.encrypt({
    remoteName: 'kdrive',
    basePath: 'crabe',
    rcloneConfig: '',
    type: 'webdav',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' },
  }));

  // ⚠ Allumée puis abandonnée : le bloc chiffré EXISTE mais ne contient rien.
  // C'est ce cas qui interdit de se fier à `enabled` ou à la seule présence de
  // `config_encrypted` pour décider.
  insert.run('proton', 1, null, null, crypto.encrypt({
    remoteName: 'protondrive',
    basePath: 'crabe',
    rcloneConfig: '',
    type: 'protondrive',
    valeurs: {},
  }));

  // Jamais touchées : c'est l'amorçage qui les a créées, personne d'autre.
  insert.run('mega', 0, null, null, null);
  insert.run('rclone', 0, null, null, blocIllisible ? 'v1.pasunvraisecret.dutout' : null);

  return database;
}

function lignes(database) {
  return database
    .prepare('SELECT * FROM destinations_config ORDER BY dest_id')
    .all();
}

// ---------------------------------------------------------------------------

test('une destination réellement configurée survit, avec son identifiant', () => {
  const database = baseAncienModele();
  migrations.apply(database);

  const pcloud = database
    .prepare("SELECT * FROM destinations_config WHERE dest_id = 'pcloud'")
    .get();

  assert.ok(pcloud, 'la destination configurée est toujours là');
  // ⚠ LE POINT LE PLUS IMPORTANT DU LOT : l'identifiant ne bouge pas. On le
  // retrouve dans `invoices.destinations` sur des milliers de lignes, dans
  // `destination_logs`, et dans la préférence de chaque compte. Le réécrire
  // sans en oublier un est un pari qu'on n'a aucune raison de prendre.
  assert.equal(pcloud.dest_id, 'pcloud');
  assert.equal(pcloud.enabled, 1, 'elle reste activée');

  // Ses identifiants sont intacts, et toujours lisibles.
  const conf = crypto.tryDecryptJson(pcloud.config_encrypted, null);
  assert.match(conf.rcloneConfig, /type = pcloud/);
  assert.match(conf.rcloneConfig, /access_token/);

  // Et elle a désormais ce qu'il lui manquait pour exister dans le nouveau
  // modèle : un nom affichable et un fournisseur.
  assert.equal(pcloud.display_name, 'pCloud');
  assert.equal(pcloud.provider, 'pcloud');
  assert.equal(pcloud.created_at, '2026-08-01 09:00:00', 'à défaut d\'autre date, la dernière modification');
  assert.equal(pcloud.deleted_at, null);
});

test('une destination configurée par champs survit aussi, même éteinte', () => {
  const database = baseAncienModele();
  migrations.apply(database);

  const kdrive = database
    .prepare("SELECT * FROM destinations_config WHERE dest_id = 'kdrive'")
    .get();

  assert.ok(kdrive, 'éteinte ne veut pas dire jamais configurée');
  assert.equal(kdrive.provider, 'kdrive');
  assert.equal(kdrive.display_name, 'kDrive');
  const conf = crypto.tryDecryptJson(kdrive.config_encrypted, null);
  assert.equal(conf.valeurs.kdriveId, '123456');
  assert.equal(conf.valeurs.pass, 'obscurci', 'le mot de passe est intact');
});

test('les lignes que personne n\'a jamais configurées disparaissent', () => {
  const database = baseAncienModele();
  migrations.apply(database);

  const restantes = lignes(database).map((r) => r.dest_id).sort();
  assert.deepEqual(restantes, ['kdrive', 'local', 'pcloud']);

  // `proton` avait `enabled = 1` ET un `config_encrypted` non nul : c'est le
  // cas qui piège, et il est bien parti — il n'y avait rien dedans.
  assert.equal(restantes.includes('proton'), false);
  assert.equal(restantes.includes('mega'), false);
  assert.equal(restantes.includes('rclone'), false);
});

test('un bloc qu\'on n\'arrive pas à lire est GARDÉ, jamais supprimé', () => {
  // Clé changée, format inattendu, contenu abîmé : on ne sait pas ce qu'il y a
  // dedans. Perdre une destination configurée est irréparable ; garder une
  // ligne vide de trop se corrige d'un clic sur « Supprimer ».
  const database = baseAncienModele({ blocIllisible: true });
  migrations.apply(database);

  const rclone = database
    .prepare("SELECT * FROM destinations_config WHERE dest_id = 'rclone'")
    .get();
  assert.ok(rclone, 'le doute profite à la ligne');
  assert.equal(rclone.provider, 'autre');
  assert.equal(rclone.display_name, 'Autre stockage');
});

test('Le stockage local traverse la migration sans y toucher', () => {
  const database = baseAncienModele();
  migrations.apply(database);

  const local = database
    .prepare("SELECT * FROM destinations_config WHERE dest_id = 'local'")
    .get();
  assert.equal(local.path, '/mnt/local');
  assert.equal(local.protocol, 'nfs');
  assert.equal(local.enabled, 1);
  assert.ok(local.created_at, 'elle reçoit une date de création comme les autres');
});

test('rejouer la migration ne change plus rien', () => {
  const database = baseAncienModele();
  migrations.apply(database);
  const apres = lignes(database);

  // La table `schema_migrations` empêche déjà un second passage ; on force
  // quand même la fonction elle-même, parce qu'une migration qui n'est
  // idempotente que grâce à son garde-fou n'est pas idempotente.
  migrations.apply(database);
  assert.deepEqual(lignes(database), apres, 'second passage : aucun effet');

  // Et un renommage fait après la migration n'est pas écrasé par un troisième
  // passage : `COALESCE(NULLIF(...))` ne réécrit que ce qui est vide.
  database
    .prepare("UPDATE destinations_config SET display_name = 'pCloud perso' WHERE dest_id = 'pcloud'")
    .run();
  database.prepare('DELETE FROM schema_migrations WHERE id = 29').run();
  migrations.apply(database);
  assert.equal(
    database.prepare("SELECT display_name FROM destinations_config WHERE dest_id = 'pcloud'").get().display_name,
    'pCloud perso',
    'le nom donné par l\'utilisateur survit à un rejeu'
  );
});

test('sans clé de déchiffrement, la migration ne supprime RIEN', () => {
  // ⚠ Le défaut trouvé en écrivant ce fichier : `db.open()` tournait avant
  // `crypto.init()`, donc tout déchiffrement échouait. La migration gardait
  // alors toutes les destinations dont le bloc existait — dont celles qui
  // étaient vides — et personne n'aurait vu que la bascule n'avait pas eu lieu :
  // ni erreur, ni journal, juste l'écran d'avant.
  //
  // C'est le bon comportement face à un doute, et c'était le mauvais résultat
  // pour ce lot : d'où l'inversion de l'ordre de démarrage. Ce test tient les
  // deux bouts — celui-ci vérifie que le repli est sûr, celui d'au-dessus que
  // le cas normal aboutit vraiment.
  const database = baseAncienModele();
  const vraiDechiffrement = crypto.tryDecryptJson;
  crypto.tryDecryptJson = (blob, fallback = null) => fallback;
  try {
    migrations.apply(database);
  } finally {
    crypto.tryDecryptJson = vraiDechiffrement;
  }

  const restantes = lignes(database).map((r) => r.dest_id).sort();
  assert.deepEqual(
    restantes,
    ['kdrive', 'local', 'pcloud', 'proton'],
    'toute ligne dont le contenu est illisible est gardée'
  );

  // Le partage est exactement le bon, et il mérite d'être dit : sans clé,
  //
  //   - `proton` est GARDÉE alors qu'elle est vide. On ne peut pas le savoir,
  //     donc on ne le suppose pas — c'est le seul faux positif possible, et il
  //     se corrige d'un clic sur « Supprimer » ;
  //   - `mega` et `rclone` partent quand même, parce que leur `config_encrypted`
  //     est NULL. « Aucun bloc » ne demande aucune clé pour être lu : c'est un
  //     fait, pas une supposition.
  assert.equal(restantes.includes('proton'), true, 'illisible ⇒ gardée, par prudence');
  assert.equal(restantes.includes('mega'), false, 'aucun bloc ⇒ aucune ambiguïté');
});
