'use strict';

/**
 * La mémoire, lue et réglée depuis l'administration (0.2.26, migration 76).
 *
 * Deux réserves tiennent crabe à distance de son plafond : celle de la fenêtre
 * de connexion (refusée en dessous — `remote-browser`) et celle des
 * récupérations (la file attend que la mémoire revienne —
 * `scheduler.attendreLaMemoire`). Jusqu'à la 0.2.25 c'étaient des constantes du
 * code — 1 200 Mo, 600 Mo, trois minutes d'attente —, justes pour un conteneur
 * de 4 Go et pour lui seul. Elles se règlent désormais dans Administration ›
 * Système, où la mémoire se lit aussi en direct : ce qui reste à crabe, ce qui
 * l'occupe.
 *
 * Une colonne vide (NULL) vaut la valeur par défaut : une installation qui n'a
 * rien réglé suit les valeurs du code, y compris le jour où elles changent.
 */

const nodeOs = require('node:os');

const DEFAUTS = Object.freeze({ fenetreMo: 1200, recuperationMo: 600, attenteS: 180 });

/**
 * Bornes admises, incluses. Les planchers écartent une faute de frappe, pas un
 * choix : sous quelques centaines de mégaoctets un Chromium meurt en route
 * sans rien dire. Une attente de 0 : la file ne s'arrête jamais sur la mémoire.
 */
const BORNES = Object.freeze({
  fenetreMo: Object.freeze([400, 64000]),
  recuperationMo: Object.freeze([200, 64000]),
  attenteS: Object.freeze([0, 900]),
});

const COLONNES = Object.freeze({
  fenetreMo: 'memoire_fenetre_mo',
  recuperationMo: 'memoire_recuperation_mo',
  attenteS: 'memoire_attente_s',
});

const LIBELLES = Object.freeze({
  fenetreMo: 'La réserve de la fenêtre de connexion',
  recuperationMo: 'La réserve des récupérations',
  attenteS: 'L\'attente de la file',
});

const UNITES = Object.freeze({ fenetreMo: 'Mo', recuperationMo: 'Mo', attenteS: 's' });

function admis(cle, valeur) {
  const [min, max] = BORNES[cle];
  return Number.isInteger(valeur) && valeur >= min && valeur <= max;
}

function refus(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Les réglages en vigueur : la valeur rangée quand elle est admise, la valeur
 * par défaut sinon (colonne vide, base d'avant la migration 76, base fermée).
 * Ne lève jamais : la fenêtre et la file la lisent en plein travail.
 *
 * @param {object} [row] la ligne de `app_settings` ; lue en base à défaut
 * @returns {{fenetreMo: number, recuperationMo: number, attenteS: number}}
 */
function reglages(row) {
  let ligne = row;
  if (ligne === undefined) {
    try {
      ligne = require('./settings').appSettings();
    } catch {
      ligne = null;
    }
  }
  const lus = {};
  for (const cle of Object.keys(DEFAUTS)) {
    const valeur = ligne ? ligne[COLONNES[cle]] : null;
    lus[cle] = admis(cle, valeur) ? valeur : DEFAUTS[cle];
  }
  return lus;
}

/**
 * Enregistre des réglages ; `null` rend la valeur par défaut.
 *
 * @param {{fenetreMo?: number|null, recuperationMo?: number|null, attenteS?: number|null}} patch
 * @param {{capaciteMo?: number|null}} [options] la mémoire dont crabe dispose
 *   au plus : une réserve au-delà ne serait jamais atteinte — la fenêtre ne
 *   s'ouvrirait plus, la file attendrait à chaque départ.
 */
function regler(patch, { capaciteMo = null } = {}) {
  const cles = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
  if (!cles.length || cles.some((cle) => !Object.hasOwn(DEFAUTS, cle))) {
    throw refus(`Réglage de mémoire inconnu : ${Object.keys(DEFAUTS).join(', ')}.`);
  }
  for (const cle of cles) {
    const valeur = patch[cle];
    if (valeur === null) continue;
    if (!admis(cle, valeur)) {
      const [min, max] = BORNES[cle];
      throw refus(`${LIBELLES[cle]} se règle entre ${min} et ${max} ${UNITES[cle]}, en nombre entier.`);
    }
    if (UNITES[cle] === 'Mo' && Number.isFinite(capaciteMo) && capaciteMo > 0 && valeur > capaciteMo) {
      throw refus(
        `${LIBELLES[cle]} (${valeur} Mo) dépasse la mémoire dont crabe dispose (${capaciteMo} Mo) : `
          + 'elle ne serait jamais atteinte.'
      );
    }
  }
  const db = require('./db/db');
  db.get()
    .prepare(`UPDATE app_settings SET ${cles.map((cle) => `${COLONNES[cle]} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`)
    .run(...cles.map((cle) => patch[cle]));
  return reglages();
}

const enMo = (octets) => Math.round(octets / (1024 * 1024));

/**
 * La mémoire à l'instant. `libreMo` est la mesure même que lisent la fenêtre
 * et la file (`remote-browser.memorySnapshot`) : ce que crabe peut encore
 * prendre, plafond du service compris, cache libérable non compté.
 *
 * @param {{os?: object, cgroupe?: () => object|null, rss?: () => number, libreMo?: () => number}} [sondes] (essais)
 * @returns {{libreMo: number, capaciteMo: number, machine: {totalMo: number, libreMo: number},
 *           service: {plafondMo: number, occupeMo: number, cacheMo: number}|null, crabeMo: number}}
 */
function etat(sondes = {}) {
  const os = sondes.os || nodeOs;
  const remoteBrowser = () => require('./remote-browser');
  const machine = { totalMo: enMo(os.totalmem()), libreMo: enMo(os.freemem()) };

  let service = null;
  try {
    const cgroupe = (sondes.cgroupe || (() => remoteBrowser().memoireDuCgroupe()))();
    if (cgroupe) {
      service = {
        plafondMo: enMo(cgroupe.plafond),
        occupeMo: enMo(cgroupe.occupe),
        cacheMo: enMo(cgroupe.cacheInactif),
      };
    }
  } catch {
    service = null;
  }

  let libreMo;
  try {
    libreMo = (sondes.libreMo || (() => remoteBrowser().memorySnapshot({ os: nodeOs }).freeMb))();
  } catch {
    libreMo = machine.libreMo;
  }

  return {
    libreMo,
    capaciteMo: service ? Math.min(service.plafondMo, machine.totalMo) : machine.totalMo,
    machine,
    service,
    crabeMo: enMo((sondes.rss || (() => process.memoryUsage().rss))()),
  };
}

module.exports = {
  DEFAUTS,
  BORNES,
  COLONNES,
  reglages,
  regler,
  etat,
};
