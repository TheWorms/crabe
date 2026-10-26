'use strict';

/**
 * Le témoin de la clé maîtresse (bilan de santé du 25/10/2026, constat 2).
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * La clé qui chiffre les secrets est dérivée de `CRABE_MASTER_PASSPHRASE` et de
 * `data/master.salt` (server/crypto.js). Rien ne vérifiait qu'elle soit la
 * bonne : une phrase mal recopiée, un sel perdu — que crypto.js recrée alors
 * sans un mot —, ou une base restaurée sur une installation déjà démarrée une
 * fois, et crabe démarrait « normalement ». Toutes les récupérations échouaient
 * à leur heure, les comptes avec 2FA recevaient une erreur 500, et tout ce qui
 * était ressaisi entre-temps se chiffrait avec la mauvaise clé : deux clés dans
 * la même base, et ces lignes-là perdues à leur tour quand la bonne phrase
 * revenait (mesuré par un script jetable).
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * Une ligne unique (`cle_temoin`, migration 66) porte un texte connu, chiffré
 * avec la clé de la base. Au démarrage, la base à peine ouverte et avant toute
 * écriture (`controler`, appelé par `db.open`) :
 *
 *   - le témoin existe : il doit se relire, sinon crabe refuse de démarrer ;
 *   - il n'existe pas encore (première ouverture depuis ce correctif, ou base
 *     neuve) : s'il y a des secrets en base, AU MOINS UN doit se relire — sinon
 *     refus —, puis le témoin est posé une fois le schéma en place (`poser`).
 *     « Au moins un » et non « tous » : une
 *     mauvaise clé n'en relit aucun (chiffrement authentifié), alors qu'une
 *     base saine peut porter une vieille configuration déjà illisible, que
 *     l'interface signale et ne réécrit jamais (registry.js).
 *
 * Un refus n'écrit rien. Le sel neuf d'un démarrage refusé est retiré par
 * l'appelant (server/index.js), pour que la situation reste celle d'avant.
 */

const crypto = require('./crypto');
const { refusDeDemarrage } = require('./refus-demarrage');

/** Le texte connu. Il ne change jamais : un autre texte, et tout témoin serait refusé. */
const TEXTE_DU_TEMOIN = 'crabe : témoin de la clé maîtresse';

/** Les cinq colonnes chiffrées de la base, et rien d'autre. */
const COLONNES_CHIFFREES = Object.freeze([
  ['connector_installs', 'config_encrypted'],
  ['destinations_config', 'config_encrypted'],
  ['connector_discoveries', 'items_encrypted'],
  ['security_policy', 'smtp_pass_encrypted'],
  ['users', 'totp_secret'],
]);

/** Échantillons gardés par colonne : assez pour qu'une ligne illisible isolée ne décide pas. */
const ECHANTILLONS_PAR_COLONNE = 5;

const MESSAGE_MAUVAISE_CLE =
  'La phrase secrète (CRABE_MASTER_PASSPHRASE) ou le fichier master.salt ne correspondent pas '
  + 'à cette base : les identifiants qu\'elle garde ne peuvent pas être relus. crabe s\'arrête sans '
  + 'rien écrire, pour ne pas mélanger deux clés dans la même base. Remettez la phrase et le fichier '
  + 'master.salt d\'origine — ceux de la sauvegarde d\'où vient cette base —, puis redémarrez.';

const SUITE_SEL_NEUF =
  ' Le fichier master.salt manquait : celui que ce démarrage venait de créer a été retiré.';

/**
 * Quelques secrets chiffrés de la base, colonne par colonne. Seules les valeurs
 * chiffrées sont lues, jamais les lignes entières.
 * @param {import('better-sqlite3').Database} database
 * @returns {string[]}
 */
function echantillonsChiffres(database) {
  const blocs = [];
  for (const [table, colonne] of COLONNES_CHIFFREES) {
    try {
      const lignes = database
        .prepare(
          `SELECT ${colonne} AS bloc FROM ${table}
            WHERE ${colonne} IS NOT NULL AND ${colonne} != '' LIMIT ?`
        )
        .all(ECHANTILLONS_PAR_COLONNE);
      for (const l of lignes) blocs.push(l.bloc);
    } catch {
      /* table absente d'une très vieille base : rien à lire ici */
    }
  }
  return blocs;
}

function relisible(bloc) {
  try {
    crypto.decrypt(bloc);
    return true;
  } catch {
    return false;
  }
}

/** Le témoin de la base, ou `null` (table absente avant la migration 66, ou ligne pas encore posée). */
function lireTemoin(database) {
  try {
    return database.prepare('SELECT temoin FROM cle_temoin WHERE id = 1').get()?.temoin || null;
  } catch {
    return null;
  }
}

/**
 * Contrôle la clé contre la base, EN LECTURE SEULE. Appelé par `db.open` avant
 * toute écriture — sauvegarde, schéma, migrations : un refus laisse la base et
 * le disque tels qu'ils étaient.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.database la base ouverte
 * @param {boolean} [options.selCree] le sel vient d'être créé par ce démarrage
 * @returns {{temoin: boolean, echantillons: number, illisibles: number}}
 * @throws {Error} un refus de démarrer (`refusDeDemarrage`), si la clé ne va pas
 */
function controler({ database, selCree = false }) {
  const message = MESSAGE_MAUVAISE_CLE + (selCree ? SUITE_SEL_NEUF : '');
  const temoin = lireTemoin(database);
  if (temoin) {
    let texte = null;
    try {
      texte = crypto.decrypt(temoin);
    } catch {
      texte = null;
    }
    if (texte !== TEXTE_DU_TEMOIN) throw refusDeDemarrage(message);
    return { temoin: true, echantillons: 0, illisibles: 0 };
  }

  const blocs = echantillonsChiffres(database);
  const lus = blocs.filter(relisible).length;
  if (blocs.length && lus === 0) throw refusDeDemarrage(message);
  return { temoin: false, echantillons: blocs.length, illisibles: blocs.length - lus };
}

/**
 * Pose le témoin s'il manque, avec la clé courante — une fois `controler`
 * passé et le schéma en place.
 * @param {{database: import('better-sqlite3').Database}} options
 * @returns {boolean} vrai s'il vient d'être posé
 */
function poser({ database }) {
  if (lireTemoin(database)) return false;
  database
    .prepare('INSERT OR IGNORE INTO cle_temoin (id, temoin) VALUES (1, ?)')
    .run(crypto.encrypt(TEXTE_DU_TEMOIN));
  return true;
}

module.exports = { TEXTE_DU_TEMOIN, COLONNES_CHIFFREES, controler, poser, echantillonsChiffres };
