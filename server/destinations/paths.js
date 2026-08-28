'use strict';

/**
 * Construction des chemins de destination.
 *
 * Arborescence cible, identique sur le stockage local, Proton Drive et pCloud :
 *
 *   <utilisateur>/<Nom du connecteur>/<identifiant de compte>/<année>/<fichier>.pdf
 *
 * Exemples réels :
 *   camille/Free Internet/fbx22222222/2026/2026-08_1111111111.pdf
 *   camille/Free Mobile/0628000000/2026/2026-07_2222222222.pdf
 *   camille/Amazon/compte/2025/2025-11_406-0000000-0000000.pdf
 *
 * ─── Pourquoi l'année, et pourquoi APRÈS le compte ───────────────────────────
 *
 * Avec dix à quinze années d'historique par connecteur (lot 9 : Amazon en
 * expose quinze, les impôts dix), une liste à plat devient inexploitable — et
 * un explorateur de fichiers y rame autant qu'un humain.
 *
 * L'année vient **après** l'identifiant de compte, jamais avant : l'historique
 * d'une ligne, d'un abonnement, d'un foyer fiscal doit rester groupé sous SON
 * dossier. Ranger par année d'abord éparpillerait chaque abonnement dans dix
 * dossiers différents, et rendrait impossible la question la plus fréquente —
 * « qu'est-ce que j'ai pour cette ligne-là ? ».
 *
 * L'année est celle du DOCUMENT (période de facturation), pas celle de la
 * récupération : une facture de décembre émise en janvier se range en
 * décembre. Quand elle ne peut pas être déterminée, le document va dans
 * `inconnu/` — jamais à la racine du compte, où il redeviendrait invisible.
 *
 * Trois règles absolues :
 *   - la racine du stockage local est DÉJÀ un emplacement dédié à crabe côté
 *     serveur de fichiers : on n'ajoute jamais de dossier « crabe » supplémentaire ;
 *   - il n'y a JAMAIS de dossier « invoices » dans l'arborescence ;
 *   - l'année est un niveau à part entière, pour TOUS les connecteurs,
 *     présents et à venir (voir le contrat de connecteur dans le README).
 *
 * Les segments restent lisibles par un humain — espaces et accents conservés,
 * « Free Internet » et non « free-internet » — mais ne peuvent pas faire sortir
 * du répertoire de destination.
 */

const path = require('node:path');

/** Longueur max d'un segment : large, mais borne les noms venant d'une API. */
const MAX_SEGMENT = 128;

/** Dossier des documents dont l'année n'a pas pu être déterminée. */
const ANNEE_INCONNUE = 'inconnu';

/**
 * Assainit un segment de chemin.
 *
 * Neutralisé : séparateurs (`/`, `\`), remontées (`..`), caractères de
 * contrôle, et les caractères qu'un partage SMB refuse (`: * ? " < > |`).
 * Conservé : lettres accentuées, chiffres, espaces, `- _ . ( ) + ' @ &`.
 *
 * @param {string} value
 * @param {string} [fallback] utilisé si le résultat est vide
 */
function safeSegment(value, fallback = 'inconnu') {
  let clean = String(value ?? '')
    // Caractères de contrôle, y compris NUL.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // Séparateurs de chemin et caractères interdits sur SMB.
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // Aucune séquence de points multiples ne subsiste (« .. » de remontée), et un
  // segment ne commence jamais par un point (fichier caché involontaire).
  clean = clean.replace(/\.{2,}/g, '.').replace(/^\.+/, '').trim();
  // Windows et certains partages n'aiment pas les points/espaces finaux.
  clean = clean.replace(/[. ]+$/, '');

  if (clean.length > MAX_SEGMENT) clean = clean.slice(0, MAX_SEGMENT).trim();

  return clean || fallback;
}

/**
 * Une année plausible, ou `inconnu`.
 *
 * Bornée à 1900-2099 : au-delà, ce n'est pas une année de facture mais un
 * nombre pris pour telle, et un dossier « 9999 » ne rend service à personne.
 *
 * @param {string|number|null|undefined} value
 * @returns {string} quatre chiffres, ou `inconnu`
 */
function normalizeYear(value) {
  const text = String(value ?? '').trim();
  return /^(19|20)\d{2}$/.test(text) ? text : ANNEE_INCONNUE;
}

/**
 * L'année d'un document, déduite de ce qu'on sait de lui.
 *
 * Deux sources, dans cet ordre :
 *
 *   1. `issuedOn` — la date d'émission relevée par le connecteur. C'est la
 *      source de vérité quand elle existe ;
 *   2. le nom de fichier, que tous les connecteurs préfixent de la période :
 *      `2026-08_1111111111.pdf`, `202507_free.pdf`, `2026_Avis_d_impot….pdf`.
 *
 * Rien d'exploitable → `null`, et l'appelant range dans `inconnu/`. On ne
 * retombe **jamais** sur l'année courante : ce serait affirmer une date que
 * personne n'a mesurée, et déplacer le document d'année en année au fil des
 * migrations.
 *
 * @param {{issuedOn?: string|null, filename?: string|null}} document
 * @returns {string|null} quatre chiffres, ou null
 */
function yearFor({ issuedOn, filename } = {}) {
  const emise = /^((?:19|20)\d{2})-\d{2}/.exec(String(issuedOn ?? '').trim());
  if (emise) return emise[1];

  const nom = String(filename ?? '').trim();
  // Ancrées au début : c'est là que vit la période dans tous les noms produits
  // par crabe, et un numéro de facture ne peut pas s'y glisser.
  const debut =
    /^((?:19|20)\d{2})[-_](\d{2})(?:\D|$)/.exec(nom) // 2026-08_… / 2026_08_…
    || /^((?:19|20)\d{2})(\d{2})(?:\D|$)/.exec(nom) // 202507_free.pdf
    || /^((?:19|20)\d{2})(?:\D|$)/.exec(nom) // 2026_Avis_d_impot….pdf
    // Depuis le lot 56, la convention « avec le service » place le service
    // AVANT la période : `impots_2026_Avis….pdf`. Sans ce motif, une année
    // seule derrière un préfixe ne serait pas lue, et le document tomberait
    // dans « inconnu/ » dès que la date d'émission manque.
    || /^[A-Za-z0-9-]+_((?:19|20)\d{2})(?:-\d{2})?(?:\D|$)/.exec(nom);
  if (debut) return debut[1];

  // Dernier recours : une période « AAAA-MM » n'importe où dans le nom, comme
  // le fait déjà `invoices.periodOf()`.
  const ailleurs = /(?:^|\D)((?:19|20)\d{2})-(?:0[1-9]|1[0-2])(?:\D|$)/.exec(nom);
  return ailleurs ? ailleurs[1] : null;
}

/** Profondeur maximale d'un sous-chemin fourni par un connecteur. */
const SOUS_CHEMIN_MAX = 8;

/**
 * Les segments d'un rangement fourni par le CONNECTEUR, assainis un à un.
 *
 * eDocPerso (lot 38) range ses documents selon les dossiers du coffre de
 * l'utilisateur (« Mes Employeurs/EMPLOYEUR-UN ») à la place du niveau d'année.
 * La valeur vient d'une API distante : chaque segment passe par `safeSegment`
 * (pas de `..`, pas de séparateur, pas de caractère de contrôle), un segment
 * vidé par l'assainissement disparaît, et la profondeur est bornée. Un
 * sous-chemin qui ne laisse rien d'exploitable rend un tableau vide — et
 * l'appelant retombe sur le rangement par année.
 *
 * @param {string[]|string|null|undefined} sousChemin
 * @returns {string[]}
 */
function sousCheminSegments(sousChemin) {
  const bruts = Array.isArray(sousChemin)
    ? sousChemin
    : String(sousChemin ?? '').split('/');
  return bruts
    .map((segment) => safeSegment(segment, ''))
    .filter(Boolean)
    .slice(0, SOUS_CHEMIN_MAX);
}

/**
 * Segments relatifs d'une facture, dans l'ordre.
 *
 * `year` est facultatif : à défaut, il est déduit du nom du fichier. Un appelant
 * qui connaît la date d'émission a toujours intérêt à la passer — c'est plus
 * sûr qu'un nom de fichier —, mais aucun chemin ne peut se retrouver sans
 * niveau d'année pour l'avoir oublié.
 *
 * `sousChemin` (lot 38) remplace le niveau d'année quand le connecteur fournit
 * un rangement plus fidèle — les dossiers du coffre eDocPerso. Assaini ici,
 * jamais par l'appelant.
 *
 * @param {{username: string, connectorName: string, accountId?: string,
 *          year?: string|number, issuedOn?: string, filename: string,
 *          sousChemin?: string[]|string|null}} parts
 * @returns {string[]}
 */
function relativeParts({ username, connectorName, accountId, year, issuedOn, filename, sousChemin }) {
  const rangement = sousCheminSegments(sousChemin);
  const annee = normalizeYear(year ?? yearFor({ issuedOn, filename }));

  return [
    safeSegment(username, 'inconnu'),
    safeSegment(connectorName, 'connecteur'),
    // Pas d'identifiant déterminable : un dossier « defaut » plutôt qu'un échec.
    safeSegment(accountId, 'defaut'),
    // L'année vient APRÈS le compte : l'historique de chaque ligne reste groupé.
    // Le sous-chemin du connecteur, quand il existe, prend la place de l'année.
    ...(rangement.length ? rangement : [safeSegment(annee, ANNEE_INCONNUE)]),
    safeSegment(filename, 'facture.pdf'),
  ];
}

/**
 * Les mêmes segments, SANS le niveau d'année.
 *
 * L'arborescence d'avant le lot 10, conservée pour une seule raison : retrouver
 * un fichier qui n'a pas encore été migré (voir destinations/migration-annees.js
 * et `invoicePath()`). Aucun dépôt neuf ne passe plus par là.
 */
function legacyRelativeParts({ username, connectorName, accountId, filename }) {
  return [
    safeSegment(username, 'inconnu'),
    safeSegment(connectorName, 'connecteur'),
    safeSegment(accountId, 'defaut'),
    safeSegment(filename, 'facture.pdf'),
  ];
}

/** Chemin relatif avec des séparateurs `/` (remotes rclone). */
function relativePath(parts) {
  return relativeParts(parts).join('/');
}

/** Chemin absolu sur un système de fichiers local (le stockage local). */
function localPath(root, parts) {
  return path.join(root, ...relativeParts(parts));
}

/** Chemin absolu d'avant le lot 10, sans niveau d'année. */
function legacyLocalPath(root, parts) {
  return path.join(root, ...legacyRelativeParts(parts));
}

/**
 * Un chemin absolu reste-t-il sous la racine attendue ?
 * Utilisé avant de servir un fichier : aucune traversée de répertoire, même si
 * la valeur vient de la base.
 */
function isInside(root, candidate) {
  if (!root || !candidate) return false;
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

module.exports = {
  MAX_SEGMENT,
  ANNEE_INCONNUE,
  SOUS_CHEMIN_MAX,
  sousCheminSegments,
  safeSegment,
  normalizeYear,
  yearFor,
  relativeParts,
  relativePath,
  legacyRelativeParts,
  localPath,
  legacyLocalPath,
  isInside,
};
