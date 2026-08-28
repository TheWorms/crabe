'use strict';

/**
 * La version installée, et la vérification de mise à jour.
 *
 * Deux règles gouvernent ce module :
 *
 *   1. **Jamais de mise à jour automatique.** crabe constate qu'une version
 *      plus récente existe et l'affiche ; le geste (`docker compose pull &&
 *      docker compose up -d`) appartient à l'administrateur.
 *
 *   2. **Un échec réseau est un silence total.** Une installation coupée
 *      d'internet, un GitHub indisponible, un quota d'API dépassé : rien de
 *      tout ça n'est une panne de crabe, et rien ne doit s'afficher ni
 *      s'écrire au journal des erreurs. La bannière n'existe que quand une
 *      version plus récente est POSITIVEMENT connue.
 *
 * La vérification interroge `https://api.github.com/repos/<repo>/releases/latest`
 * au plus une fois par jour, et seulement si `CRABE_UPDATE_REPO` est renseigné —
 * vide par défaut, donc coupé par défaut : une installation neuve ne parle à
 * personne tant qu'on ne le lui a pas demandé.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Un jour : l'intervalle minimal entre deux interrogations de GitHub. */
const UN_JOUR_MS = 24 * 60 * 60 * 1000;

/** Délai maximal accordé à GitHub avant d'abandonner en silence. */
const DELAI_REQUETE_MS = 10_000;

/**
 * La version embarquée : le fichier `VERSION` à la racine du dépôt, écrit au
 * build de l'image. Introuvable ou illisible → `0.0.0`, jamais une erreur :
 * la version est une information, pas une condition de démarrage.
 */
function versionInstallee() {
  try {
    const brut = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
    return brut || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = versionInstallee();

/**
 * Compare deux versions `X.Y.Z`, segment par segment, NUMÉRIQUEMENT.
 *
 * C'est le piège classique de la comparaison lexicale : « 1.10.0 » est plus
 * récente que « 1.2.0 », alors que la chaîne « 1.10.0 » est plus « petite »
 * que « 1.2.0 ». D'où des segments convertis en nombres, jamais comparés en
 * tant que texte. Un préfixe `v` est toléré (les tags GitHub en portent un),
 * un segment manquant vaut 0, un segment illisible vaut 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} négatif si a < b, 0 si égales, positif si a > b
 */
function comparerVersions(a, b) {
  const segments = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((s) => {
        const n = Number.parseInt(s, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      });

  const sa = segments(a);
  const sb = segments(b);
  const longueur = Math.max(sa.length, sb.length);
  for (let i = 0; i < longueur; i += 1) {
    const da = sa[i] ?? 0;
    const db = sb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * L'état mémorisé de la dernière vérification : la réponse (ou son absence)
 * vaut pour la journée. Un échec aussi — inutile de marteler GitHub toutes
 * les minutes quand le réseau est coupé.
 */
let derniereVerification = { quand: 0, resultat: null };

/**
 * La dernière version publiée sur GitHub, ou null.
 *
 * @param {{fetchImpl?: typeof fetch, maintenant?: number, repo?: string}} [options]
 *   points d'injection pour les tests : jamais utilisés en production.
 * @returns {Promise<{version: string} | null>} null = pas de mise à jour à
 *   afficher (vérification coupée, réseau muet, ou déjà à jour).
 */
async function verifierMiseAJour({ fetchImpl = fetch, maintenant = Date.now(), repo } = {}) {
  const depot = repo ?? (process.env.CRABE_UPDATE_REPO || '').trim();
  if (!depot) return null;

  if (maintenant - derniereVerification.quand < UN_JOUR_MS) {
    return derniereVerification.resultat;
  }
  // L'horodatage est posé AVANT l'appel : une requête qui échoue compte comme
  // la vérification du jour, elle ne sera pas retentée en boucle.
  derniereVerification = { quand: maintenant, resultat: null };

  try {
    const reponse = await fetchImpl(
      `https://api.github.com/repos/${depot}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `crabe/${VERSION}` },
        signal: AbortSignal.timeout(DELAI_REQUETE_MS),
      }
    );
    if (!reponse.ok) return null;

    const corps = await reponse.json();
    const publiee = String(corps?.tag_name || '').trim();
    if (!publiee) return null;

    if (comparerVersions(publiee, VERSION) > 0) {
      derniereVerification.resultat = { version: publiee.replace(/^v/i, '') };
    }
    return derniereVerification.resultat;
  } catch {
    // Silence : voir la règle 2 en tête de fichier.
    return null;
  }
}

/** Remet l'état à zéro — pour les tests uniquement. */
function oublierVerification() {
  derniereVerification = { quand: 0, resultat: null };
}

module.exports = { VERSION, comparerVersions, verifierMiseAJour, oublierVerification };
