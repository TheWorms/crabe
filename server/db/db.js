'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { config } = require('../config');
const { refusDeDemarrage } = require('../refus-demarrage');

let db = null;
/** Migrations appliquées lors du dernier open() — affichées au démarrage. */
let lastMigrations = { applied: [], current: 0 };

/**
 * Ouvre (ou crée) la base, applique le schéma puis les migrations.
 * @param {string} [file] chemin du fichier SQLite ; ':memory:' pour les tests
 * @param {{avantEcriture?: (base: import('better-sqlite3').Database) => void}} [options]
 *   `avantEcriture` est appelé la base ouverte, avant toute écriture ; une
 *   exception y ferme la base et remonte telle quelle.
 */
function open(file = config.dbFile, { avantEcriture = null } = {}) {
  if (db) return db;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');

  // Chargement tardif : migrations.js dépend de modules qui dépendent d'ici.
  const migrations = require('./migrations');

  // ─── Avant de toucher au schéma (bilan de santé du 25/10/2026) ────────────
  //
  // Jusqu'ici les migrations passaient à chaque ouverture, sans copie, et une
  // version PLUS ANCIENNE du code démarrait sans un mot sur une base migrée par
  // une plus récente (retour arrière après une mise à jour ratée) : elle y
  // écrivait selon des règles d'avant. Désormais :
  //   - une base en avance sur le code est refusée, sans rien écrire ;
  //   - une base existante qui va être migrée est d'abord copiée et vérifiée,
  //     sinon refusée — une mise à jour sans point de retour n'a pas lieu.
  const etat = migrations.etatDeLaBase(db);
  if (etat.enAvance.length) {
    fermerSansEcrire();
    const pluriel = etat.enAvance.length > 1 ? 's' : '';
    throw refusDeDemarrage(
      `Cette base a été mise à jour par une version plus récente de crabe (migration${pluriel} `
        + `${etat.enAvance.join(', ')}), que ce code ne connaît pas (sa dernière est la ${etat.derniere}). `
        + 'crabe s\'arrête sans rien écrire. Remettez la version de crabe qui a fait cette mise à jour, '
        + 'ou restaurez la base sauvegardée juste avant elle (data/crabe.db.avant-migration-…).'
    );
  }
  // Le contrôle de la clé (server/cle-temoin.js), passé par le démarrage :
  // lui aussi avant toute écriture, sauvegarde comprise.
  if (avantEcriture) {
    try {
      avantEcriture(db);
    } catch (err) {
      fermerSansEcrire();
      throw err;
    }
  }
  let sauvegarde = null;
  if (!etat.neuve && etat.enAttente.length && file !== ':memory:') {
    try {
      sauvegarde = sauvegarderAvantMigration(file, migrations);
    } catch (err) {
      fermerSansEcrire();
      throw refusDeDemarrage(
        `La base doit être mise à jour (${etat.enAttente.length} migration(s) en attente), mais sa `
          + `sauvegarde préalable n'a pas pu être écrite ni vérifiée : ${err.message}. crabe s'arrête `
          + `sans rien modifier. Libérez de la place dans ${path.dirname(file)}, puis redémarrez.`
      );
    }
  }

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  lastMigrations = { ...migrations.apply(db), sauvegarde };

  seedSingletons();

  // La sauvegarde neuve est là : seules les dernières du même motif sont
  // gardées, comme pour l'harmonisation. Meilleur effort, après les
  // migrations — le journal applicatif écrit en base.
  if (sauvegarde) {
    try {
      require('../optimisation').limiterSauvegardes('migration');
    } catch { /* la sauvegarde neuve est là, c'est elle qui compte */ }
  }

  return db;
}

/** Ferme la base ouverte par `open` sans y avoir rien écrit. */
function fermerSansEcrire() {
  const ouverte = db;
  db = null;
  try {
    ouverte.close();
  } catch { /* déjà fermée */ }
}

/**
 * Copie la base à côté d'elle, avant ses migrations : `VACUUM INTO`, une copie
 * cohérente et synchrone (l'ouverture l'est aussi), puis RELUE — intègre, et
 * avec les mêmes migrations enregistrées. Le nom suit la convention des
 * sauvegardes de l'application (`crabe.db.avant-<motif>-<horodatage>`), que
 * l'écran Optimisation liste.
 *
 * @returns {string} le chemin de la sauvegarde vérifiée
 * @throws si la copie échoue ou ne se relit pas (elle est alors retirée)
 */
function sauvegarderAvantMigration(file, migrations) {
  const horodatage = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const cible = path.join(path.dirname(file), `crabe.db.avant-migration-${horodatage}`);
  const compter = (base) => (migrations.hasTable(base, 'schema_migrations')
    ? base.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n
    : 0);
  // Un fichier de ce nom qui n'est pas le nôtre n'est jamais effacé.
  if (fs.existsSync(cible)) throw new Error(`${path.basename(cible)} existe déjà`);
  try {
    db.prepare('VACUUM INTO ?').run(cible);
    // La copie porte les identifiants chiffrés et les données des comptes :
    // lisible par le seul compte de crabe, comme le sel et la phrase (mesuré
    // sur le serveur de production le 25/10 : `VACUUM INTO` la laissait en 644).
    fs.chmodSync(cible, 0o600);
    const copie = new Database(cible, { readonly: true, fileMustExist: true });
    try {
      const integre = Object.values(copie.prepare('PRAGMA quick_check').get())[0] === 'ok';
      if (!integre || compter(copie) !== compter(db)) {
        throw new Error('la copie relue ne correspond pas à la base');
      }
    } finally {
      copie.close();
    }
    return cible;
  } catch (err) {
    fs.rmSync(cible, { force: true });
    throw err;
  }
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
