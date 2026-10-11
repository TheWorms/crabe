'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { config } = require('../config');

let db = null;
/** Migrations appliquées lors du dernier open() — affichées au démarrage. */
let lastMigrations = { applied: [], current: 0 };

/**
 * Ouvre (ou crée) la base, applique le schéma puis les migrations.
 * @param {string} [file] chemin du fichier SQLite ; ':memory:' pour les tests
 */
function open(file = config.dbFile) {
  if (db) return db;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Chargement tardif : migrations.js dépend de modules qui dépendent d'ici.
  lastMigrations = require('./migrations').apply(db);

  seedSingletons();

  return db;
}

/** Insère les lignes singleton et les rôles intégrés attendus par le reste du code. */
function seedSingletons() {
  db.prepare('INSERT OR IGNORE INTO security_policy (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO app_settings (id) VALUES (1)').run();
  // ⚠ UNE seule destination est créée ici, et c'est voulu depuis le lot 25.
  //
  // Jusqu'au lot 24, cette boucle parcourait le catalogue des destinations et
  // créait une ligne pour chacune : six lignes sur une installation neuve, dont
  // cinq que personne n'avait demandées et qui remplissaient l'écran Stockage
  // de fournisseurs à configurer. Les clouds sont désormais créés par
  // l'utilisateur, un par un, avec le nom qu'il leur donne — l'amorçage n'a
  // plus rien à décider pour lui.
  //
  // Le stockage local reste amorcé ici parce qu'il n'est pas un choix : c'est le
  // stockage local de crabe, la copie de référence, et son absence rendrait
  // toute récupération impossible dès le premier démarrage.
  db.prepare(
    "INSERT OR IGNORE INTO destinations_config (dest_id, enabled) VALUES ('local', 1)"
  ).run();
  // Un chemin par défaut si vide. Le défaut est le point de montage
  // (/mnt/local), pas un dossier sous dataDir : voir config.localPath et
  // la migration 8.
  //
  // ⚠ `enabled = 1` ne s'applique QU'À UN STOCKAGE LOCAL NON SUPPRIMÉ (lot 26).
  // Depuis qu'il se supprime comme un cloud, cet amorçage le rallumait à chaque
  // démarrage : la suppression tenait tant que le service tournait, et se
  // défaisait à la première mise à jour. `deleted_at` continuait de faire foi
  // ailleurs, mais laisser en base un état incohérent — supprimé ET activé —
  // est exactement le genre de contradiction qu'on finit par lire du mauvais
  // côté. Remettre en service reste un geste, dans l'écran Stockage.
  db.prepare(
    `UPDATE destinations_config
        SET path = COALESCE(NULLIF(path, ''), ?),
            protocol = COALESCE(NULLIF(protocol, ''), 'local'),
            enabled = CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
      WHERE dest_id = 'local'`
  ).run(config.localPath);

  // Idempotent : garantit aussi que le rôle « admin » reçoit les permissions
  // ajoutées par une nouvelle version de crabe.
  require('../permissions').seedBuiltinRoles(db);

  // Idem pour les modèles d'e-mail : une nouvelle version peut en ajouter,
  // sans jamais écraser un modèle déjà personnalisé (INSERT OR IGNORE).
  require('../email-templates').seedDefaults(db);
}

function get() {
  if (!db) throw new Error('La base n\'est pas ouverte (appeler db.open()).');
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Exécute `fn` dans une transaction. */
function transaction(fn) {
  return get().transaction(fn);
}

/** Taille du fichier de base (WAL inclus), pour la page « Système ». */
function fileSizeBytes() {
  if (!config.dbFile || config.dbFile === ':memory:') return 0;
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${config.dbFile}${suffix}`).size;
    } catch {
      /* fichier absent : rien à compter */
    }
  }
  return total;
}

module.exports = {
  open,
  get,
  close,
  transaction,
  fileSizeBytes,
  get migrations() {
    return lastMigrations;
  },
};
