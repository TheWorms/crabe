'use strict';

/**
 * Synchronisation forcée vers une destination secondaire.
 *
 * ─── Pourquoi ce bouton existe ───────────────────────────────────────────────
 *
 * Un document récupéré est copié **dans la foulée** vers chaque destination
 * secondaire activée (voir `destinations.storeInvoice`). Quand cette copie
 * échoue — cloud injoignable, quota plein, rclone mal configuré —, elle est
 * tentée trois fois puis **abandonnée**, et il n'y a **aucune reprise
 * automatique** : un connecteur en panne ne doit pas se transformer en boucle
 * qui martèle un service tiers à chaque exécution planifiée.
 *
 * La reprise est donc un geste, et ce fichier est ce geste. Il traite :
 *
 *   - les documents **en échec** sur cette destination ;
 *   - ceux qui n'ont **jamais été copiés** (destination activée après coup) ;
 *   - ceux dont l'état est **inconnu** — tout ce qui précède le suivi détaillé.
 *     On ne les déclare pas « copiés » sur la foi de rien : on les recopie.
 *
 * ─── Ce qu'il ne fait pas ────────────────────────────────────────────────────
 *
 * **Rien n'est retéléchargé chez le fournisseur.** Le PDF est relu depuis
 * le stockage local — la copie de référence — et redéposé. Une synchronisation peut
 * donc être relancée sans risque, sans réveiller Amazon ni le portail des
 * impôts. Quand le stockage local n'est pas actif (possible depuis le lot 38), il n'y a
 * pas de source à relire : la reprise le dit, document par document, au lieu
 * d'inventer une copie.
 *
 * **Une seule à la fois.** Un second lancement pendant qu'une synchronisation
 * tourne est refusé (409), plutôt que de doubler les transferts.
 *
 * ─── Le disjoncteur ──────────────────────────────────────────────────────────
 *
 * Trois documents d'affilée en échec sur une destination, et on s'arrête là
 * pour elle. Sans cela, un cloud éteint coûterait trois tentatives espacées de
 * trois secondes pour CHAQUE document — près d'un quart d'heure pour cent
 * documents, à seule fin d'obtenir cent fois la même erreur.
 */

const fs = require('node:fs');

const db = require('../db/db');
const applog = require('../applog');
const invoicesLib = require('../invoices');

/** Échecs consécutifs après lesquels on cesse d'insister sur une destination. */
const ECHECS_AVANT_ARRET = 3;

/** Nombre d'erreurs détaillées conservées pour le compte rendu. */
const ERREURS_GARDEES = 10;

/**
 * État de la synchronisation en cours, ou de la dernière terminée.
 *
 * Un simple objet en mémoire suffit : crabe est un unique processus Node, et
 * une synchronisation ne survit pas à un redémarrage — elle se relance.
 */
let etat = repos();

function repos() {
  return {
    running: false,
    destinationIds: [],
    scope: null,
    startedAt: null,
    finishedAt: null,
    total: 0,
    done: 0,
    copied: 0,
    failed: 0,
    errors: [],
    message: '',
  };
}

/** Instantané de l'état, sans référence partagée. */
function progress() {
  return { ...etat, destinationIds: [...etat.destinationIds], errors: [...etat.errors] };
}

function isRunning() {
  return etat.running;
}

// ---------------------------------------------------------------------------
// Ce qui manque
// ---------------------------------------------------------------------------

/**
 * Les factures dont la copie manque sur une destination.
 *
 * @param {string} destId
 * @param {number|null} userId  restreint à un compte, ou tous si `null`
 */
function pendingFor(destId, userId = null) {
  const clause = userId ? 'WHERE i.user_id = ?' : '';
  const params = userId ? [userId] : [];

  return db
    .get()
    .prepare(
      `SELECT i.id, i.user_id, i.connector_id, i.filename, i.account_id, i.issued_on,
              i.destinations, u.username
         FROM invoices i JOIN users u ON u.id = i.user_id
         ${clause}
        ORDER BY i.id`
    )
    .all(...params)
    .filter((row) => invoicesLib.missingDestinations(row.destinations, [destId]).includes(destId));
}

/** Combien de documents attendent encore cette destination. */
function pendingCount(destId, userId = null) {
  return pendingFor(destId, userId).length;
}

// ---------------------------------------------------------------------------
// La synchronisation elle-même
// ---------------------------------------------------------------------------

/**
 * Copie vers une destination tout ce qui lui manque.
 *
 * @returns {Promise<{copied: number, failed: number, stopped: boolean}>}
 */
async function syncDestination(destId, { userId = null, actor = null } = {}) {
  const destinations = require('./index');
  const registry = require('../connectors/registry');

  const attente = pendingFor(destId, userId);
  let copied = 0;
  let failed = 0;
  let consecutifs = 0;

  for (const row of attente) {
    if (consecutifs >= ECHECS_AVANT_ARRET) {
      const restants = attente.length - copied - failed;
      noter(
        destId,
        null,
        `arrêt après ${ECHECS_AVANT_ARRET} échecs consécutifs — ${restants} document(s) `
          + 'non tentés. Corrigez la destination puis relancez.'
      );
      applog.warn(
        'destinations',
        `Synchronisation de ${destId} interrompue après ${ECHECS_AVANT_ARRET} échecs `
          + `consécutifs : ${restants} document(s) n'ont pas été tentés.`,
        actor || {}
      );
      return { copied, failed, stopped: true };
    }

    const source = destinations.invoicePath(row, row.username);
    if (!source || !fs.existsSync(source)) {
      // Sans la copie de référence, il n'y a rien à recopier : c'est une
      // récupération chez le fournisseur qu'il faut, pas un transfert.
      failed++;
      consecutifs = 0; // ce n'est pas la destination qui est en cause
      etat.done++;
      etat.failed++;
      noter(destId, row.filename, 'introuvable sur le stockage local — relancez une récupération.');
      continue;
    }

    const connectorName = registry.has(row.connector_id)
      ? registry.manifest(row.connector_id).name
      : row.connector_id;

    const results = await destinations.copyToDestinations({
      destinationIds: [destId],
      userId: row.user_id,
      username: row.username,
      target: {
        username: row.username,
        connectorName,
        accountId: row.account_id,
        issuedOn: row.issued_on,
        filename: row.filename,
        buffer: fs.readFileSync(source),
        // Le miroir copie le rangement RÉEL de la copie de référence (lot 38) :
        // un document du coffre eDocPerso reste sous ses dossiers, pas sous une
        // année recalculée.
        cheminRelatif: destinations.cheminRelatifDepuisLocal(source),
      },
    });

    invoicesLib.saveDestinations(row.id, invoicesLib.mergeOutcomes(row.destinations, results));

    etat.done++;
    if (results[destId]?.ok) {
      copied++;
      etat.copied++;
      consecutifs = 0;
    } else {
      failed++;
      etat.failed++;
      consecutifs++;
      noter(destId, row.filename, results[destId]?.message || 'échec sans message');
    }
  }

  return { copied, failed, stopped: false };
}

/** Range une erreur dans le compte rendu, sans le laisser enfler. */
function noter(destId, filename, message) {
  if (etat.errors.length >= ERREURS_GARDEES) return;
  etat.errors.push({ destId, filename, message });
}

/**
 * Lance une synchronisation.
 *
 * L'appel **rend la main tout de suite** : le transfert se poursuit en fond, et
 * l'interface suit `progress()`. Un rattrapage de cent documents vers un cloud
 * ne tient pas dans une requête HTTP.
 *
 * @param {{destinationIds: string[], userId?: number|null,
 *          actor?: {userId?: number, username?: string}}} options
 * @returns {object} l'instantané de départ
 * @throws {Error} 409 si une synchronisation est déjà en cours
 */
function start({ destinationIds, userId = null, actor = null }) {
  if (etat.running) {
    const err = new Error(
      'Une synchronisation est déjà en cours — attendez qu\'elle se termine.'
    );
    err.statusCode = 409;
    throw err;
  }

  // Un renommage des documents (lot 56) déplace les fichiers que cette
  // synchronisation copierait sous leur nom en base : les deux en même temps
  // fabriqueraient un stockage et une base en désaccord. Chacun refuse tant
  // que l'autre tourne.
  if (require('../harmonisation').isRunning()) {
    const err = new Error(
      'Un renommage des documents est en cours — attendez qu\'il se termine avant de synchroniser.'
    );
    err.statusCode = 409;
    throw err;
  }

  const destinations = require('./index');
  const actives = destinations.activeDestinations();
  // Le stockage local est la SOURCE : la synchroniser vers elle-même n'a pas de sens.
  const cibles = (destinationIds || []).filter(
    (id) => id !== 'local' && actives.includes(id)
  );

  if (!cibles.length) {
    const err = new Error(
      'Aucune destination secondaire activée et configurée : il n\'y a rien à synchroniser. '
        + 'Activez Proton Drive ou pCloud dans Paramètres → Stockage.'
    );
    err.statusCode = 400;
    throw err;
  }

  const total = cibles.reduce((n, id) => n + pendingCount(id, userId), 0);

  etat = {
    ...repos(),
    running: true,
    destinationIds: cibles,
    scope: userId ? `user:${userId}` : 'all',
    startedAt: new Date().toISOString(),
    total,
    message: total ? 'Synchronisation en cours…' : 'Rien à synchroniser.',
  };

  // Détaché : la requête HTTP ne l'attend pas.
  (async () => {
    try {
      for (const destId of cibles) {
        await syncDestination(destId, { userId, actor });
      }
      etat.message = resume(etat);
      applog[etat.failed ? 'warn' : 'info'](
        'destinations',
        `Synchronisation forcée (${cibles.join(', ')}) : ${etat.message}`,
        actor || {}
      );
    } catch (err) {
      etat.message = `Synchronisation interrompue — ${err.message}`;
      applog.error('destinations', etat.message, actor || {});
    } finally {
      etat.running = false;
      etat.finishedAt = new Date().toISOString();
    }
  })();

  return progress();
}

/** « 14 documents copiés, 2 en échec ». */
function resume({ copied, failed }) {
  if (!copied && !failed) return 'Rien à synchroniser — tout était déjà en place.';
  const pluriel = (n) => (n > 1 ? 's' : '');
  const parts = [`${copied} document${pluriel(copied)} copié${pluriel(copied)}`];
  if (failed) parts.push(`${failed} en échec`);
  return `${parts.join(', ')}.`;
}

/** Remet l'état au repos — réservé aux tests. */
function reset() {
  etat = repos();
}

module.exports = {
  ECHECS_AVANT_ARRET,
  progress,
  isRunning,
  pendingFor,
  pendingCount,
  syncDestination,
  start,
  resume,
  reset,
};
