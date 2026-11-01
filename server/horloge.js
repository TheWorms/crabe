'use strict';

/**
 * L'instant présent des comptes qui se font sur une fenêtre de temps : les
 * douze mois des graphiques de l'accueil, les 30 jours des « Exécutions
 * réussies » (Administration › Système).
 *
 * Un objet, et non une fonction exportée seule, pour que les essais d'écran
 * le figent sur l'horloge du navigateur (lot 108) : sans cela, ces fenêtres
 * suivaient la date réelle, et les empreintes de l'accueil et de Système ont
 * changé le 1er novembre 2026 sans que rien ne change à l'écran.
 */
const horloge = { maintenant: () => new Date() };

module.exports = horloge;
