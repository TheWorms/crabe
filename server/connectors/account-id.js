'use strict';

/**
 * Identifiant de compte chez le fournisseur.
 *
 * C'est le niveau d'arborescence qui permet de changer d'abonnement sans
 * mélanger l'historique :
 *
 *   /mnt/local/camille/Free Internet/fbx11111111/202507_free.pdf
 *   /mnt/local/camille/Free Internet/fbx22222222/202605_free.pdf
 *
 * ─── Contrat de connecteur ────────────────────────────────────────────────
 *
 * Un connecteur peut remonter son identifiant de compte de deux façons, dans
 * cet ordre de priorité :
 *
 *   1. `test(config, ctx)` renvoie `{ ok, message, accountId? }` ;
 *   2. `fetchInvoices(config, ctx)` renvoie soit un tableau de factures dont
 *      les éléments peuvent porter `accountId`, soit
 *      `{ accountId, invoices: [...] }`.
 *
 * À défaut, crabe le déduit de la configuration saisie : le premier champ du
 * manifest de type `text` ou `email` (jamais un `password`, jamais un `select`)
 * est considéré comme l'identifiant du compte — identifiant d'abonné Free,
 * numéro fiscal, identifiant d'organisation Scaleway, adresse de connexion…
 * Un manifest peut désigner explicitement le champ avec `"accountIdField"`.
 *
 * Si rien n'est déterminable (OVH avant le premier appel réussi, par exemple),
 * on retombe sur le dossier `defaut` — jamais sur un échec.
 *
 * Les connecteurs de scraping n'ont RIEN à changer pour en bénéficier : la
 * déduction depuis la configuration s'applique à eux telle quelle.
 */

const paths = require('../destinations/paths');

const DEFAULT_ACCOUNT_ID = 'defaut';

/** Types de champs utilisables comme identifiant (jamais un secret). */
const USABLE_FIELD_TYPES = ['text', 'email'];

/**
 * Normalise une valeur en segment de chemin, ou renvoie null.
 * @param {*} value
 * @returns {string|null}
 */
function normalize(value) {
  if (value === undefined || value === null) return null;
  const clean = paths.safeSegment(String(value).trim(), '');
  return clean || null;
}

/**
 * Déduit l'identifiant depuis la configuration saisie par l'utilisateur.
 * @param {object} manifest manifest normalisé du connecteur
 * @param {object} config identifiants en clair
 * @returns {string|null}
 */
function fromConfig(manifest, config) {
  if (!manifest || !config) return null;

  // `accountIdField: false` : ce manifeste REFUSE la déduction. PayPal (lot
  // 38) : son premier champ texte est le Client ID d'application — 80
  // caractères illisibles qui finissaient libellé de compte et nom de dossier.
  // Le connecteur remonte son propre identifiant, lisible ; à défaut, le
  // dossier « defaut » vaut mieux qu'un jeton technique exposé.
  if (manifest.accountIdField === false) return null;

  const declared = manifest.accountIdField;
  if (declared && config[declared]) return normalize(config[declared]);

  for (const field of manifest.fields || []) {
    if (!USABLE_FIELD_TYPES.includes(field.type)) continue;
    const value = config[field.key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    return normalize(value);
  }
  return null;
}

/**
 * Identifiant retenu pour un dépôt.
 *
 * @param {{manifest?: object, config?: object, reported?: *, stored?: *}} input
 *   `reported` : ce que le connecteur vient de remonter (priorité absolue) ;
 *   `stored`   : ce qui est déjà en base pour cette installation.
 * @returns {string} jamais vide
 */
function resolve({ manifest, config, reported, stored } = {}) {
  return (
    normalize(reported) ||
    fromConfig(manifest, config) ||
    normalize(stored) ||
    DEFAULT_ACCOUNT_ID
  );
}

/** Identifiant remonté par un lot de factures, s'il y en a un. */
function fromInvoices(invoices) {
  if (!Array.isArray(invoices)) return null;
  for (const invoice of invoices) {
    const found = normalize(invoice?.accountId);
    if (found) return found;
  }
  return null;
}

module.exports = {
  DEFAULT_ACCOUNT_ID,
  USABLE_FIELD_TYPES,
  normalize,
  fromConfig,
  fromInvoices,
  resolve,
};
