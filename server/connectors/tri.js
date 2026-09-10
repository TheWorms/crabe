'use strict';

/**
 * L'ordre alphabétique des services, tenu à UN seul endroit.
 *
 * ─── Pourquoi le classement d'origine ne convenait pas ───────────────────────
 *
 * `registry.load()` parcourt les dossiers du disque : l'ordre des connecteurs
 * était donc celui de leurs NOMS DE DOSSIER, qui sont techniques et ne
 * ressemblent pas toujours à ce qui s'affiche.
 *
 *     dossier                   nom affiché
 *     ile-aux-epices        →   L'Île aux Épices
 *     atelier-du-portable   →   L'Atelier du Portable
 *     impots                →   Impots.gouv.fr
 *     free-mobile           →   Free Mobile
 *
 * Dans une liste de quatre-vingts services, « L'Île aux Épices » se retrouvait
 * entre « Hetzner » et « Impots.gouv.fr », et personne ne pouvait le prévoir.
 *
 * ─── Pourquoi pas une simple comparaison de chaînes ──────────────────────────
 *
 * Parce qu'en JavaScript, `'École' < 'Edf'` est **faux** : la comparaison brute
 * se fait sur les points de code, et `É` (U+00C9) vaut plus que n'importe quelle
 * lettre non accentuée. Tous les services à accent seraient donc relégués après
 * Z. `localeCompare` en français les range là où on les cherche.
 *
 * ─── Les options, et ce que chacune corrige ──────────────────────────────────
 *
 *   - `sensitivity: 'base'` — « École » et « ecole » sont la même chose pour le
 *     classement. Sans elle, la casse départage encore, et deux services dont
 *     les noms ne diffèrent que par une majuscule changent de place selon celui
 *     qui a été écrit en premier ;
 *   - `numeric: true` — « Free 2 » avant « Free 10 », et non l'inverse. Sans
 *     elle, un chiffre se compare caractère par caractère, donc « 10 » passe
 *     avant « 2 ».
 *
 * ─── Ce que ce module ne trie PAS ────────────────────────────────────────────
 *
 * Tout ce qui est chronologique par nature : journaux d'exécution, journaux
 * applicatifs, historique des connexions, liste des documents récents. Un
 * journal rangé par ordre alphabétique n'est plus un journal.
 */

/** Les options, écrites une fois pour que serveur et écran s'accordent. */
const OPTIONS = { sensitivity: 'base', numeric: true };

/** La langue du classement. Le français range É avec E, ce qu'on veut. */
const LANGUE = 'fr';

/**
 * Compare deux noms affichés.
 *
 * Un nom absent part à la fin plutôt qu'au début : une entrée sans nom est une
 * anomalie, et l'anomalie n'a pas à ouvrir la liste.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function comparerNoms(a, b) {
  const gauche = String(a ?? '').trim();
  const droite = String(b ?? '').trim();
  if (!gauche) return droite ? 1 : 0;
  if (!droite) return -1;
  return gauche.localeCompare(droite, LANGUE, OPTIONS);
}

/**
 * Trie une liste d'objets par leur nom affiché.
 *
 * Rend une COPIE : trier sur place une liste qu'on n'a pas fabriquée est le
 * genre d'effet de bord qu'on découvre trois écrans plus loin.
 *
 * @param {Array<object>} items
 * @param {(item: object) => string} [nomDe] par défaut, la propriété `name`
 * @returns {Array<object>}
 */
function parNom(items, nomDe = (item) => item?.name) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) =>
    comparerNoms(nomDe(a), nomDe(b))
  );
}

/**
 * Les ordres proposés sur les listes de services, et ce qu'ils lisent.
 *
 * ─── Pourquoi quatre, et pas plus ────────────────────────────────────────────
 *
 * Le lot 24 a posé l'ordre alphabétique partout, et c'est le bon défaut : on
 * cherche un service par son nom. Mais deux autres questions se posent
 * réellement devant une liste de vingt-cinq services — « qu'est-ce que je
 * viens d'ajouter ? » et « qu'est-ce qui a tourné en dernier ? » —, et une
 * troisième devant une liste qui a vécu : « qu'est-ce qui me rapporte le
 * plus ? ». Au-delà, on ajoute des lignes à un menu que personne n'ouvrira.
 *
 * `label` est ce que l'utilisateur lit ; il n'y a pas de jargon à traduire.
 */
const ORDRES = [
  { id: 'nom', label: 'Ordre alphabétique' },
  { id: 'ajout', label: 'Ajout le plus récent' },
  { id: 'synchro', label: 'Dernière synchronisation' },
  { id: 'documents', label: 'Nombre de documents' },
];

const ORDRE_PAR_DEFAUT = 'nom';
const ORDRE_IDS = ORDRES.map((o) => o.id);

/**
 * Compare deux dates, la plus RÉCENTE d'abord.
 *
 * Une date absente part à la fin, quel que soit le sens : « jamais synchronisé »
 * n'est pas « synchronisé il y a très longtemps », et le faire remonter en tête
 * d'un tri par fraîcheur serait faux.
 */
function comparerDatesRecentes(a, b) {
  const gauche = a ? Date.parse(a) : NaN;
  const droite = b ? Date.parse(b) : NaN;
  const gaucheOk = Number.isFinite(gauche);
  const droiteOk = Number.isFinite(droite);
  if (!gaucheOk && !droiteOk) return 0;
  if (!gaucheOk) return 1;
  if (!droiteOk) return -1;
  return droite - gauche;
}

/**
 * Trie une liste de services dans l'ordre demandé.
 *
 * ⚠ Le NOM départage toujours les ex æquo, et ce n'est pas un détail : sans
 * lui, deux services ajoutés la même seconde — ce qui arrive à l'installation
 * — ou vingt services à zéro document changeraient de place à chaque
 * rafraîchissement, sans que rien ne l'explique.
 *
 * Un ordre inconnu retombe sur l'alphabétique plutôt que de lever : cette
 * fonction est appelée pour dessiner un écran, et un écran vide serait une
 * réponse bien pire qu'un écran rangé autrement que demandé. Le refus, lui, se
 * fait à l'ENREGISTREMENT de la préférence (voir preferences.refus).
 *
 * @param {Array<object>} items
 * @param {string} ordre un identifiant de `ORDRES`
 * @param {{nom?: Function, ajout?: Function, synchro?: Function, documents?: Function}} [acces]
 * @returns {Array<object>} une copie triée
 */
function parOrdre(items, ordre, acces = {}) {
  const lire = {
    nom: acces.nom || ((i) => i?.name),
    ajout: acces.ajout || ((i) => i?.installedAt),
    synchro: acces.synchro || ((i) => i?.lastRunAt),
    documents: acces.documents || ((i) => i?.documentCount),
  };
  const liste = [...(Array.isArray(items) ? items : [])];
  const parNomEnsuite = (a, b) => comparerNoms(lire.nom(a), lire.nom(b));

  switch (ordre) {
    case 'ajout':
      return liste.sort((a, b) => comparerDatesRecentes(lire.ajout(a), lire.ajout(b)) || parNomEnsuite(a, b));
    case 'synchro':
      return liste.sort((a, b) => comparerDatesRecentes(lire.synchro(a), lire.synchro(b)) || parNomEnsuite(a, b));
    case 'documents':
      return liste.sort(
        (a, b) => (Number(lire.documents(b)) || 0) - (Number(lire.documents(a)) || 0) || parNomEnsuite(a, b)
      );
    default:
      return liste.sort(parNomEnsuite);
  }
}

module.exports = {
  OPTIONS,
  LANGUE,
  ORDRES,
  ORDRE_IDS,
  ORDRE_PAR_DEFAUT,
  comparerNoms,
  comparerDatesRecentes,
  parNom,
  parOrdre,
};
