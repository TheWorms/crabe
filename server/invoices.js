'use strict';

/**
 * État de transfert d'une facture, destination par destination.
 *
 * La colonne `invoices.destinations` porte un objet JSON dont chaque clé est
 * une destination et chaque valeur un résultat :
 *
 *   { "local": { "state": "ok",    "ok": true,  "at": "2026-…", "path": "/mnt/…" },
 *     "proton":   { "state": "error", "ok": false, "at": "2026-…", "message": "…" } }
 *
 * Quatre états, et un seul principe : **ne jamais affirmer un succès qui n'a
 * pas été mesuré.**
 *
 *   ok      — copie réussie, horodatée ;
 *   error   — copie tentée et échouée, avec le message d'erreur ;
 *   pending — destination activée, aucune copie tentée pour cette facture
 *             (destination activée après coup) ;
 *   unknown — trace antérieure au suivi détaillé : la copie a bien eu lieu
 *             mais ni sa date ni son résultat n'ont été conservés.
 *
 * Règle d'affichage (lot 3) : **seules les destinations autorisées par
 * l'administrateur sont rendues**. Une destination désactivée n'apparaît ni en
 * carte, ni en pastille grise — elle n'existe pas pour l'utilisateur.
 */

const db = require('./db/db');
const catalogue = require('./destinations/catalogue');

// L'identité visuelle des destinations était réexportée d'ici sous le nom
// `DESTINATION_STYLE`, par compatibilité avec le lot 9. Plus personne ne la
// lisait, et depuis le lot 25 elle ne peut plus être une constante : une
// destination n'existe qu'en base. Tout passe par `catalogue.brand()`.

const STATES = ['ok', 'error', 'pending', 'unknown'];

/** Lit la colonne `destinations` sans jamais lever. */
function parseDestinations(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * Ramène un résultat brut (ancien ou nouveau format) à la forme normalisée.
 * @returns {{state: string, ok: boolean, at: string|null, path?: string, message?: string}}
 */
function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return { state: 'unknown', ok: !!outcome, at: null };
  }
  const state = STATES.includes(outcome.state)
    ? outcome.state
    : outcome.ok
      ? 'unknown' // succès sans état explicite : trace antérieure au lot 3
      : 'error';
  return {
    state,
    ok: !!outcome.ok,
    at: outcome.at || null,
    ...(outcome.path ? { path: outcome.path } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
  };
}

/** Construit le résultat à enregistrer après une tentative de dépôt. */
function outcomeFromStore(result, at = new Date().toISOString()) {
  return {
    state: result?.ok ? 'ok' : 'error',
    ok: !!result?.ok,
    at,
    ...(result?.path ? { path: result.path } : {}),
    ...(result?.message ? { message: result.message } : {}),
  };
}

const TOOLTIPS = {
  ok: (name, at) => (at ? `${name} — copié le ${frenchDate(at)}` : `${name} — copié`),
  error: (name, at, message) =>
    `${name} — échec${at ? ` le ${frenchDate(at)}` : ''}${message ? ` : ${message}` : ''}`,
  pending: (name) => `${name} — en attente de copie`,
  unknown: (name) => `${name} — état inconnu (copie antérieure au suivi détaillé)`,
};

/** Date lisible pour une infobulle serveur ; l'interface reformate si besoin. */
function frenchDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Pastilles à afficher pour une facture, dans l'ordre des destinations
 * autorisées. Une destination non autorisée n'apparaît jamais.
 *
 * @param {string} raw colonne `invoices.destinations`
 * @param {string[]} enabledIds destinations autorisées par l'administrateur
 */
function statesFor(raw, enabledIds) {
  const stored = parseDestinations(raw);
  return enabledIds.map((id) => {
    const style = catalogue.brand(id);
    const outcome = Object.prototype.hasOwnProperty.call(stored, id)
      ? normalizeOutcome(stored[id])
      : { state: 'pending', ok: false, at: null };

    return {
      id,
      name: style.name,
      letter: style.letter,
      color: style.color,
      // La pastille porte DEUX informations : le logo dit quelle destination,
      // l'anneau coloré dit si la copie est passée. L'initiale reste dessous,
      // et reprend sa place si l'image manque.
      logo: style.logo,
      logoInterne: style.logoInterne,
      state: outcome.state,
      at: outcome.at,
      message: outcome.message || null,
      tooltip: TOOLTIPS[outcome.state](style.name, outcome.at, outcome.message),
    };
  });
}

/** Une facture est « en échec » dès qu'une destination autorisée a échoué. */
function hasFailure(raw, enabledIds) {
  return statesFor(raw, enabledIds).some((d) => d.state === 'error');
}

/**
 * Destinations autorisées vers lesquelles il reste quelque chose à faire
 * pour cette facture (échec, en attente, ou état inconnu).
 */
function missingDestinations(raw, enabledIds) {
  return statesFor(raw, enabledIds)
    .filter((d) => d.state !== 'ok')
    .map((d) => d.id);
}

/** Fusionne des résultats de dépôt dans la colonne d'une facture. */
function mergeOutcomes(raw, results, at = new Date().toISOString()) {
  const merged = { ...parseDestinations(raw) };
  for (const [destId, result] of Object.entries(results || {})) {
    merged[destId] = outcomeFromStore(result, at);
  }
  return JSON.stringify(merged);
}

/** Période « AAAA-MM » d'une facture : date d'émission, sinon nom de fichier. */
function periodOf(invoice) {
  const issued = String(invoice.issued_on || '');
  if (/^\d{4}-\d{2}/.test(issued)) return issued.slice(0, 7);
  const fromName = /(\d{4})-(\d{2})/.exec(String(invoice.filename || ''));
  if (fromName) return `${fromName[1]}-${fromName[2]}`;
  const fetched = String(invoice.fetched_at || '');
  return /^\d{4}-\d{2}/.test(fetched) ? fetched.slice(0, 7) : '';
}

/** Référence lisible d'une facture : identifiant fournisseur, sinon fichier. */
function referenceOf(invoice) {
  if (invoice.remote_id) return String(invoice.remote_id);
  return String(invoice.filename || '').replace(/\.pdf$/i, '');
}

/** Écrit la colonne `destinations` d'une facture. */
function saveDestinations(invoiceId, json) {
  db.get().prepare('UPDATE invoices SET destinations = ? WHERE id = ?').run(json, invoiceId);
}

module.exports = {
  STATES,
  parseDestinations,
  normalizeOutcome,
  outcomeFromStore,
  statesFor,
  hasFailure,
  missingDestinations,
  mergeOutcomes,
  periodOf,
  referenceOf,
  saveDestinations,
};
