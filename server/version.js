'use strict';

/**
 * La version installée, et la vérification de mise à jour.
 *
 * Deux règles gouvernent ce module :
 *
 *   1. **Jamais de mise à jour automatique.** crabe constate qu'une version
 *      plus récente existe et l'affiche ; le geste de mise à jour appartient
 *      à l'administrateur.
 *
 *   2. **Un échec réseau est un silence total.** Une installation coupée
 *      d'internet, un GitHub indisponible, un quota d'API dépassé : rien de
 *      tout ça n'est une panne de crabe, et rien ne doit s'afficher ni
 *      s'écrire au journal des erreurs. La bannière n'existe que quand une
 *      version plus récente est POSITIVEMENT connue.
 *
 * La vérification interroge `https://api.github.com/repos/<repo>/tags`
 * au plus une fois par jour, et seulement si `CRABE_UPDATE_REPO` est renseigné —
 * vide par défaut, donc coupé par défaut : une installation neuve ne parle à
 * personne tant qu'on ne le lui a pas demandé.
 *
 * Pourquoi les tags et pas `/releases/latest` : la publication de crabe pose
 * des tags (`v0.1.3`), jamais de Release GitHub. Sur un dépôt sans Release,
 * `/releases/latest` répond 404 à perpétuité — un canal qui ne verrait
 * jamais rien. Mesuré le 13/09/2026 sur le dépôt public. Les tags couvrent
 * les deux cas : une Release GitHub porte toujours un tag.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Un jour : l'intervalle minimal entre deux interrogations de GitHub. */
const UN_JOUR_MS = 24 * 60 * 60 * 1000;

/** Délai maximal accordé à GitHub avant d'abandonner en silence. */
const DELAI_REQUETE_MS = 10_000;

/**
 * Un dépôt GitHub, exactement : `PROPRIETAIRE/DEPOT`. Le propriétaire : des
 * lettres, des chiffres et des tirets, ni au début ni à la fin, 39 caractères
 * au plus (la règle de GitHub) ; le dépôt : lettres, chiffres, `.`, `_`, `-`,
 * 100 caractères au plus, jamais `.` ni `..`. Rien d'autre — ni espace, ni
 * barre de plus, ni `?`, `#`, `:`, guillemet ou chevron.
 */
const FORME_DEPOT = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;

/**
 * Les deux pages qu'une mise à jour disponible montre (lot 109) : « Comment
 * mettre à jour » (`docs/MISE-A-JOUR.md`) et les nouveautés (`CHANGELOG.md`),
 * sur la branche `main` du dépôt interrogé — `CRABE_UPDATE_REPO`, la même
 * valeur que la vérification. Une valeur qui n'a pas exactement la forme d'un
 * dépôt GitHub (`FORME_DEPOT`) ne donne AUCUN lien : rien de ce qu'elle
 * contiendrait d'autre n'entre dans une adresse. Pure, sans appel.
 *
 * Remplace le lien « Voir la version sur GitHub » du lot 108, qui n'existait
 * que pour le dépôt public et menait à une page de versions sans notes.
 *
 * @param {string} depot le dépôt interrogé (`CRABE_UPDATE_REPO`)
 * @returns {{commentFaire: string, nouveautes: string}|null}
 */
function liensDeMiseAJour(depot) {
  const lu = FORME_DEPOT.exec(String(depot ?? '').trim());
  if (!lu || lu[2] === '.' || lu[2] === '..') return null;
  const racine = `https://github.com/${lu[1]}/${lu[2]}/blob/main`;
  return {
    commentFaire: `${racine}/docs/MISE-A-JOUR.md`,
    nouveautes: `${racine}/CHANGELOG.md`,
  };
}

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
 * Un tag est-il un numéro de version ? `v1.2.3` et `1.2.3` oui ; `beta`,
 * `v1.2.3-rc1` et autres jalons de travail non — une pré-version n'est
 * jamais annoncée comme mise à jour.
 */
function estUnTagDeVersion(nom) {
  return /^v?\d+(\.\d+){0,2}$/i.test(nom);
}

/**
 * L'état mémorisé de la dernière vérification : la réponse (ou son absence)
 * vaut pour la journée. Un échec aussi — inutile de marteler GitHub toutes
 * les minutes quand le réseau est coupé.
 *
 * Depuis le lot 107, c'est le DÉTAIL qui est gardé (voir `verifierEnDetail`) :
 * la bannière n'en lit que « une version plus récente est connue ».
 */
let derniereVerification = { quand: 0, detail: null };

/** Le détail d'une vérification qui n'a rien pu établir. */
const impossible = () => ({ etat: 'impossible', installee: VERSION });

/**
 * La vérification, EN DÉTAIL (lot 107) : ce que la fenêtre « Vérifier les
 * mises à jour » doit pouvoir dire, et que `null` confondait — « à jour »,
 * « réseau muet », « coupée ».
 *
 * La même interrogation que toujours : la même adresse, la même durée
 * maximale (10 s), la même cadence (une fois par jour, un échec compris), le
 * même silence (rien au journal, aucune erreur levée). Les pages à montrer
 * pour une version disponible ne viennent pas d'ici : elles se déduisent du
 * dépôt, sans appel (`liensDeMiseAJour`, lot 109).
 *
 * @param {{fetchImpl?: typeof fetch, maintenant?: number, repo?: string}} [options]
 *   points d'injection pour les tests : jamais utilisés en production.
 * @returns {Promise<{etat: 'coupee'|'impossible'|'a-jour'|'disponible',
 *   installee: string, trouvee?: string}>}
 */
async function verifierEnDetail({ fetchImpl = fetch, maintenant = Date.now(), repo } = {}) {
  const depot = repo ?? (process.env.CRABE_UPDATE_REPO || '').trim();
  if (!depot) return { etat: 'coupee', installee: VERSION };

  if (maintenant - derniereVerification.quand < UN_JOUR_MS && derniereVerification.detail) {
    return derniereVerification.detail;
  }
  // L'horodatage est posé AVANT l'appel : une requête qui échoue compte comme
  // la vérification du jour, elle ne sera pas retentée en boucle.
  derniereVerification = { quand: maintenant, detail: impossible() };

  try {
    const reponse = await fetchImpl(
      `https://api.github.com/repos/${depot}/tags?per_page=100`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `crabe/${VERSION}` },
        signal: AbortSignal.timeout(DELAI_REQUETE_MS),
      }
    );
    if (!reponse.ok) return derniereVerification.detail;

    // GitHub ne garantit aucun ordre utile sur les tags : la plus récente se
    // CALCULE, par la même comparaison numérique qui décide de la bannière.
    const corps = await reponse.json();
    let publiee = '';
    for (const tag of Array.isArray(corps) ? corps : []) {
      const nom = String(tag?.name || '').trim();
      if (!estUnTagDeVersion(nom)) continue;
      if (!publiee || comparerVersions(nom, publiee) > 0) publiee = nom;
    }
    // Aucune version publiée lisible : rien n'est établi — ni « à jour », ni
    // « en retard ».
    if (!publiee) return derniereVerification.detail;

    const trouvee = publiee.replace(/^v/i, '');
    derniereVerification.detail = comparerVersions(publiee, VERSION) > 0
      ? { etat: 'disponible', installee: VERSION, trouvee }
      : { etat: 'a-jour', installee: VERSION, trouvee };
    return derniereVerification.detail;
  } catch {
    // Silence : voir la règle 2 en tête de fichier.
    return derniereVerification.detail || impossible();
  }
}

/**
 * La dernière version publiée sur GitHub, ou null — la lecture que fait la
 * bannière de `verifierEnDetail` (même appel, même cadence).
 *
 * @param {{fetchImpl?: typeof fetch, maintenant?: number, repo?: string}} [options]
 *   points d'injection pour les tests : jamais utilisés en production.
 * @returns {Promise<{version: string} | null>} null = pas de mise à jour à
 *   afficher (vérification coupée, réseau muet, ou déjà à jour).
 */
async function verifierMiseAJour(options = {}) {
  const detail = await verifierEnDetail(options);
  return detail.etat === 'disponible' ? { version: detail.trouvee } : null;
}

/**
 * Remet l'état à zéro — pour les tests, et pour le clic d'un administrateur
 * (« Vérifier les mises à jour » court-circuite la cadence quotidienne).
 */
function oublierVerification() {
  derniereVerification = { quand: 0, detail: null };
}

module.exports = {
  VERSION,
  comparerVersions,
  liensDeMiseAJour,
  verifierEnDetail,
  verifierMiseAJour,
  oublierVerification,
};
