'use strict';

/**
 * Conversion clavier → keysym X11, pour la fenêtre du navigateur distant.
 *
 * ─── Le défaut que ce fichier corrige ────────────────────────────────────────
 *
 * En production, dans la fenêtre du navigateur distant, **les touches du pavé
 * numérique ne produisaient rien**. Bloquant : un code de validation SMS à six
 * chiffres se saisit au pavé, personne ne va le chercher sur la rangée du haut.
 *
 * La cause tient à un état, pas à un code manquant. noVNC convertit bien les
 * touches du pavé — il envoie les keysyms `XK_KP_0` … `XK_KP_9`. Mais un
 * keysym de pavé n'a de sens QUE si le serveur X distant a le verrou numérique
 * actif : sans lui, `KP_0` vaut « Inser », `KP_1` vaut « Fin », `KP_2` vaut
 * « Bas »… Or crabe lance un `Xvfb` neuf à chaque session, et un Xvfb neuf
 * démarre **verrou numérique éteint**. Les chiffres du pavé arrivaient donc
 * bien jusqu'au serveur, où ils étaient interprétés comme des déplacements de
 * curseur. D'où « rien ne se passe », qui est le pire des symptômes : ni
 * erreur, ni journal, ni indice.
 *
 * ─── La règle retenue ────────────────────────────────────────────────────────
 *
 * **On n'envoie jamais un keysym de pavé.** Une touche du pavé est convertie
 * en son ÉQUIVALENT ORDINAIRE — le `4` du pavé part comme le `4` de la rangée
 * du haut (`0x0034`), le `+` comme `XK_plus`, `Entrée` comme `XK_Return`. Ces
 * keysyms-là ne dépendent d'aucun modificateur : ils sont dans la table du
 * clavier distant quel que soit l'état du verrou numérique, et `x11vnc` sait
 * de toute façon remapper un keysym absent.
 *
 * Verrou numérique **éteint** côté poste, le navigateur annonce lui-même
 * « Inser », « Fin », « Bas » dans `event.key` : on envoie alors la touche de
 * navigation correspondante, ce qui est exactement ce que l'utilisateur a
 * demandé. Les deux états sont donc couverts, et par le même chemin.
 *
 * ─── Ce que ce fichier NE fait pas ───────────────────────────────────────────
 *
 * Il ne remplace pas le clavier de noVNC. Les lettres, la ponctuation, les
 * accents, `Tab`, `Retour arrière`, les flèches de la zone d'édition : tout
 * cela passe par noVNC et **fonctionne déjà** en production (la connexion Free
 * Mobile aboutit, identifiant et mot de passe compris). On ne détourne que ce
 * qui est cassé — le pavé — parce qu'intercepter un clavier qui marche est le
 * meilleur moyen de le casser.
 *
 * Les tables des autres touches sont néanmoins écrites et vérifiées ici
 * (`KEYSYMS_NOMMES`, `keysymPourCaractere`) : elles servent à la frappe
 * caractère par caractère du collage de mot de passe, et elles documentent la
 * valeur attendue de chaque touche indispensable à une saisie.
 *
 * Chargé par `<script>` dans app.html, et `require()` par la suite de tests :
 * fonctions pures, aucun accès au DOM au chargement.
 */

// ---------------------------------------------------------------------------
// Keysyms nommés (keysymdef.h)
// ---------------------------------------------------------------------------

/**
 * Les touches sans caractère imprimable, indispensables à une saisie.
 *
 * Clé : la valeur de `KeyboardEvent.key` telle que la produisent les
 * navigateurs. Valeur : le keysym X11 correspondant.
 */
const KEYSYMS_NOMMES = {
  Enter: 0xff0d,        // XK_Return
  Tab: 0xff09,          // XK_Tab
  Backspace: 0xff08,    // XK_BackSpace
  Delete: 0xffff,       // XK_Delete
  Insert: 0xff63,       // XK_Insert
  Escape: 0xff1b,       // XK_Escape
  Home: 0xff50,         // XK_Home
  End: 0xff57,          // XK_End
  PageUp: 0xff55,       // XK_Prior
  PageDown: 0xff56,     // XK_Next
  ArrowLeft: 0xff51,    // XK_Left
  ArrowUp: 0xff52,      // XK_Up
  ArrowRight: 0xff53,   // XK_Right
  ArrowDown: 0xff54,    // XK_Down
  // « Clear » est ce que les navigateurs annoncent pour le 5 du pavé, verrou
  // numérique éteint. XK_Begin est son équivalent X11 (« centre du pavé »).
  Clear: 0xff0b,        // XK_Clear
  NumLock: 0xff7f,      // XK_Num_Lock
};

/**
 * Ce que vaut chaque touche du pavé quand le navigateur ne dit rien
 * d'exploitable dans `event.key` (`""`, `"Unidentified"`).
 *
 * Repli de dernier recours, et volontairement calé sur le verrou numérique
 * ÉTEINT : c'est l'état d'un Xvfb neuf, donc celui qu'on a le plus de chances
 * de rencontrer. Un navigateur qui renseigne `key` — c'est-à-dire tous ceux
 * d'aujourd'hui — ne passe jamais par ici.
 */
const PAVE_SANS_VERROU = {
  Numpad0: 0xff63,        // Inser
  Numpad1: 0xff57,        // Fin
  Numpad2: 0xff54,        // Bas
  Numpad3: 0xff56,        // Page suivante
  Numpad4: 0xff51,        // Gauche
  Numpad5: 0xff0b,        // Centre
  Numpad6: 0xff53,        // Droite
  Numpad7: 0xff50,        // Début
  Numpad8: 0xff52,        // Haut
  Numpad9: 0xff55,        // Page précédente
  NumpadDecimal: 0xffff,  // Suppr
  // Les opérateurs et Entrée ne dépendent pas du verrou : même valeur des deux
  // côtés, ce qui est précisément ce qu'on veut.
  NumpadEnter: 0xff0d,
  NumpadAdd: 0x002b,
  NumpadSubtract: 0x002d,
  NumpadMultiply: 0x002a,
  NumpadDivide: 0x002f,
  NumpadEqual: 0x003d,
  NumpadComma: 0x002c,
  NumLock: 0xff7f,
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Keysym X11 d'un caractère imprimable.
 *
 * Le Latin-1 vaut son propre point de code (« é » → 0x00e9), au-delà c'est
 * `0x01000000 + point de code` : la convention du protocole RFB, qui évite
 * d'avoir à raisonner en touches et en modificateurs — le serveur X distant
 * s'en charge.
 *
 * @param {string} caractere un seul caractère (paires de substitution comprises)
 * @returns {number|null}
 */
function keysymPourCaractere(caractere) {
  const texte = String(caractere ?? '');
  if (!texte) return null;
  const point = texte.codePointAt(0);
  if (point === undefined) return null;
  return point < 0x100 ? point : 0x01000000 + point;
}

/** L'événement vient-il du pavé numérique ? */
function estDuPave(evenement) {
  const code = String(evenement?.code || '');
  // `location === 3` est DOM_KEY_LOCATION_NUMPAD. Le `code` suffit presque
  // toujours ; la position sert de filet pour les dispositions exotiques.
  //
  // « NumLock » est volontairement exclu : le verrou est un état LOCAL, celui
  // du poste. Le transmettre inverserait celui du serveur X et rendrait faux
  // tout ce que ce fichier corrige — le navigateur nous dit déjà, dans
  // `event.key`, ce que la touche vaut ici et maintenant.
  if (code === 'NumLock') return false;
  return code.startsWith('Numpad') || Number(evenement?.location) === 3;
}

/**
 * Keysym à envoyer pour une touche du pavé numérique — ou `null` si
 * l'événement ne vient pas du pavé, auquel cas noVNC garde la main.
 *
 * Ordre de décision :
 *
 *   1. la touche produit un caractère (`« 7 »`, `« , »`, `« + »`) → on envoie
 *      ce caractère, tel qu'il serait tapé sur la rangée du haut. C'est le cas
 *      normal, verrou numérique actif ;
 *   2. la touche porte un nom (`« Entrée »`, `« Fin »`, `« Bas »`) → le keysym
 *      nommé correspondant. C'est le cas verrou éteint ;
 *   3. le navigateur ne dit rien d'exploitable → la table de repli, calée sur
 *      le verrou éteint.
 *
 * @param {{code?: string, key?: string, location?: number}} evenement
 * @returns {number|null}
 */
function keysymDuPave(evenement) {
  if (!estDuPave(evenement)) return null;

  const touche = String(evenement?.key ?? '');

  // Un caractère imprimable, et un seul : « 7 », « . », « , », « + », « - »,
  // « * », « / », « = ». `[...touche].length` plutôt que `.length` pour ne pas
  // couper une paire de substitution en deux — aucun pavé n'en produit, mais
  // la règle doit rester juste partout où elle est lue.
  if (touche && [...touche].length === 1 && touche !== ' ') {
    return keysymPourCaractere(touche);
  }

  if (touche === ' ') return 0x0020;
  if (Object.prototype.hasOwnProperty.call(KEYSYMS_NOMMES, touche)) {
    return KEYSYMS_NOMMES[touche];
  }

  const code = String(evenement?.code || '');
  return Object.prototype.hasOwnProperty.call(PAVE_SANS_VERROU, code)
    ? PAVE_SANS_VERROU[code]
    : null;
}

/**
 * Keysym d'une touche quelconque — pavé, touche nommée ou caractère.
 *
 * N'est PAS branchée sur le clavier de la fenêtre distante : noVNC s'en occupe
 * déjà et le fait bien. Elle sert de référence vérifiable pour les touches
 * indispensables à une saisie (`Tab`, `Retour arrière`, `Suppr`, flèches,
 * `Début`, `Fin`, caractères accentués) et de point d'entrée unique si une
 * autre touche devait un jour rejoindre le pavé au rayon des cas détournés.
 *
 * @param {{code?: string, key?: string, location?: number}} evenement
 * @returns {number|null}
 */
function keysymDeTouche(evenement) {
  const duPave = keysymDuPave(evenement);
  if (duPave !== null) return duPave;

  const touche = String(evenement?.key ?? '');
  if (Object.prototype.hasOwnProperty.call(KEYSYMS_NOMMES, touche)) {
    return KEYSYMS_NOMMES[touche];
  }
  if (touche && [...touche].length === 1) return keysymPourCaractere(touche);
  return null;
}

// Chargé en `<script>` par le navigateur (où `module` n'existe pas) et par
// `require()` dans la suite de tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KEYSYMS_NOMMES,
    PAVE_SANS_VERROU,
    keysymPourCaractere,
    keysymDuPave,
    keysymDeTouche,
    estDuPave,
  };
}
