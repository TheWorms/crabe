'use strict';

/**
 * Dérivation du nom cible d'un document déjà déposé — dette n°8, lot 55.
 *
 * Depuis le lot 56, la dérivation vit dans `server/convention-noms.js` : le
 * nom des fichiers est devenu un réglage de l'application (deux conventions,
 * choisies par compte), et le dépôt d'un document neuf comme le renommage d'un
 * document existant doivent appliquer exactement les mêmes règles — elles ne
 * pouvaient donc pas rester dans un script.
 *
 * Ce fichier reste le point d'entrée du script manuel du lot 55
 * (`harmoniser-noms-deposes.js`) et de ses tests : même signature qu'avant,
 * convention « avec le service » par défaut — celle que le lot 55 visait.
 */

const { deriverNomCible, propre } = require('../server/convention-noms');

module.exports = { deriverNomCible, propre };
