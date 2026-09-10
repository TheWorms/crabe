'use strict';

/**
 * Bascule Cartes / Liste et tri des tableaux — mémorisés par COMPTE.
 *
 * ─── Pourquoi un module partagé ──────────────────────────────────────────────
 *
 * Le lot 10 ajoute la bascule à six écrans de plus et le tri à une dizaine de
 * tableaux. Écrite écran par écran, la même logique aurait été recopiée seize
 * fois — et aurait divergé seize fois : un écran qui trie sur la donnée, un
 * autre sur le texte affiché ; un écran qui retient son choix, un autre non.
 *
 * ─── Trier sur la DONNÉE, jamais sur son affichage ───────────────────────────
 *
 * C'est la seule règle qui compte vraiment ici. Une date écrite « il y a 3 h »
 * se trie chronologiquement, pas alphabétiquement — sinon « il y a 3 h » passe
 * avant « il y a 2 j », ce qui est faux. Une taille écrite « 99,3 Ko » se trie
 * numériquement — sinon « 9 Mo » passe avant « 99,3 Ko ». Chaque colonne
 * déclare donc un `accès` qui rend la valeur brute, et le tri ne voit jamais la
 * chaîne affichée.
 *
 * ─── Mémorisation ────────────────────────────────────────────────────────────
 *
 * Par compte, en base (`user_preferences`), et non dans `localStorage` : un
 * administrateur retrouve son classement d'un poste à l'autre. Les écritures
 * sont différées et « best effort » — un réseau coupé ne doit pas empêcher de
 * trier, seulement de s'en souvenir.
 *
 * Chargé par `<script>` dans app.html, et `require()` par la suite de tests :
 * les fonctions de tri sont pures, aucun accès au DOM au chargement.
 */

/** Modes d'affichage, dans l'ordre des deux boutons de la bascule. */
const MODES_VUE = ['cards', 'list'];

// ---------------------------------------------------------------------------
// Comparaison — la partie pure, celle qui se teste
// ---------------------------------------------------------------------------

/**
 * Compare deux valeurs de tri.
 *
 * Trois familles seulement, et l'ordre de décision compte :
 *
 *   1. **absent** (`null`, `undefined`, `''`) — toujours en DERNIER, quel que
 *      soit le sens. Un connecteur jamais exécuté ne doit pas venir se placer
 *      en tête quand on trie par date décroissante ;
 *   2. **nombre** — comparaison numérique. Les dates arrivent ici, converties
 *      en millisecondes par leur accès ;
 *   3. **texte** — comparaison française (`localeCompare`), pour que « École »
 *      se range avec les E et non après les Z.
 */
function comparer(a, b) {
  const absent = (v) => v === null || v === undefined || v === '';
  if (absent(a) && absent(b)) return 0;
  if (absent(a)) return 1;
  if (absent(b)) return -1;

  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (b ? 1 : 0) - (a ? 1 : 0);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;

  return String(a).localeCompare(String(b), 'fr', { numeric: true, sensitivity: 'base' });
}

/**
 * Trie une liste selon une colonne, sans modifier la liste d'origine.
 *
 * `absent` reste en dernier même en ordre décroissant : c'est pour cela que
 * l'inversion porte sur le résultat de `comparer()` seulement quand les deux
 * valeurs existent.
 *
 * @param {Array} rows
 * @param {{key: string, dir: 'asc'|'desc'}} tri
 * @param {Record<string, (row: any) => any>} acces  une fonction par colonne
 * @param {(row: any) => any} [depart]  départage deux valeurs égales
 */
function trier(rows, tri, acces, depart = null) {
  const liste = [...(rows || [])];
  const lire = acces?.[tri?.key];
  if (!lire) return liste;

  const sens = tri.dir === 'desc' ? -1 : 1;
  const absent = (v) => v === null || v === undefined || v === '';

  return liste.sort((x, y) => {
    const a = lire(x);
    const b = lire(y);
    // Les valeurs absentes ne suivent pas le sens : elles finissent en bas.
    if (absent(a) || absent(b)) return comparer(a, b);

    const ecart = comparer(a, b) * sens;
    if (ecart !== 0 || !depart) return ecart;
    return comparer(depart(x), depart(y));
  });
}

/** « nom:asc » → `{ key: 'nom', dir: 'asc' }`, ou le défaut de l'écran. */
function lireTri(valeur, defaut = null) {
  const [key, dir] = String(valeur || '').split(':');
  if (!key || !['asc', 'desc'].includes(dir)) return defaut;
  return { key, dir };
}

/** L'inverse : ce qu'on enregistre. */
function ecrireTri(tri) {
  return tri?.key && tri?.dir ? `${tri.key}:${tri.dir}` : '';
}

/**
 * Le tri après un clic sur un en-tête.
 *
 * Cliquer une AUTRE colonne la trie dans son sens naturel — croissant pour un
 * texte, décroissant pour une date ou un nombre, parce que « le plus récent
 * d'abord » et « le plus gros d'abord » sont ce qu'on cherche neuf fois sur
 * dix. Recliquer la MÊME colonne bascule le sens.
 */
function basculer(tri, key, sensNaturel = 'asc') {
  if (tri?.key === key) return { key, dir: tri.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: sensNaturel === 'desc' ? 'desc' : 'asc' };
}

// ---------------------------------------------------------------------------
// Rendu — l'en-tête cliquable
// ---------------------------------------------------------------------------

/** ▲ / ▼ / rien, selon l'état de la colonne. */
function indicateur(tri, key) {
  if (tri?.key !== key) return '<span class="th-arrow">↕</span>';
  return `<span class="th-arrow active">${tri.dir === 'asc' ? '▲' : '▼'}</span>`;
}

/**
 * Un en-tête de colonne triable.
 *
 * @param {{tri: object, key: string, label: string, onclick: string,
 *          sens?: 'asc'|'desc', attrs?: string}} options
 */
function enTeteTriable({ tri, key, label, onclick, attrs = '' }) {
  const actif = tri?.key === key;
  const sens = actif ? (tri.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th class="th-sort ${actif ? 'active' : ''}" aria-sort="${sens}"
              tabindex="0" role="columnheader" ${attrs}
              onclick="${onclick}"
              onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${onclick}}"
              title="Trier par ${label}">${label}${indicateur(tri, key)}</th>`;
}

// Chargé en `<script>` par le navigateur (où `module` n'existe pas) et par
// `require()` dans la suite de tests.
const uiPrefs = { MODES_VUE, comparer, trier, lireTri, ecrireTri, basculer, indicateur, enTeteTriable };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = uiPrefs;
}
