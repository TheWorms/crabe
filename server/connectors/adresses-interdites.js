'use strict';

/**
 * Les adresses qu'aucun connecteur de boutique ne suit, n'envoie ni n'appelle
 * (lot 99) — la liste, et la seule fonction qui la consulte.
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Les pages « mes commandes » d'Alfaliquid, du Petit Vapoteur et
 * d'e-liquide-fr (structure lue dans le code source enregistré par l'utilisateur le
 * 11/10/2026) portent, à côté de chaque facture, des liens qui AGISSENT :
 * « Commander à nouveau » (`commande?submitReorder=1&id_order=…`), « Acheter à
 * nouveau » (`#reOrder`), « Recharger » (`/PBShoppingCart.asp?ReloadOrderID=…`),
 * et, plus loin sur ces boutiques, le panier, le retour d'un produit, le suivi
 * d'une réclamation. Un clic, une navigation, ou même une simple lecture d'une
 * de ces adresses peut remplir un panier ou ouvrir une démarche au nom de
 * l'utilisateur.
 *
 * Les trois connecteurs ne cliquent rien et ne suivent que des adresses lues
 * dans la page. Chacune passe ICI avant toute navigation, toute lecture de
 * document et tout envoi de formulaire : un mot de la liste, et rien ne part.
 * Le refus est fait par construction, pas par vigilance — une adresse
 * interdite glissée dans un lien de facture ou dans l'appel `WNDAPIOpenWindow`
 * d'Oxatis est refusée comme les autres (essai D5 du lot 99).
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * Un mot de la liste présent dans l'adresse, en majuscules ou en minuscules,
 * telle quelle ou décodée (`%72eturn` est « return »). Volontairement large :
 * une adresse légitime refusée se voit au journal, une adresse d'action suivie
 * ne se rattrape pas.
 *
 * Module pur : aucune page, aucun réseau. Seuls les trois connecteurs du
 * lot 99 l'emploient — un essai le vérifie.
 */

/** Les mots du §1 du lot 99, règle 5. Gelés : la liste ne s'allonge que dans ce fichier. */
const MOTS_INTERDITS = Object.freeze([
  'submitReorder',
  'ReloadOrderID',
  'PBShoppingCart',
  'reOrder',
  'panier',
  'cart',
  'order-follow',
  'return',
]);

/** L'adresse décodée, si elle se décode — sinon telle quelle. */
function decodee(texte) {
  try {
    return decodeURIComponent(texte);
  } catch {
    return texte;
  }
}

/**
 * Le premier mot interdit que porte une adresse, ou `null`.
 *
 * Une adresse vide ou qui n'est pas une chaîne n'est pas « permise » : elle
 * ne peut pas être suivie, et l'appelant la refuse pour cette raison-là. Pure.
 *
 * @param {string} adresse
 * @returns {string|null}
 */
function motInterdit(adresse) {
  const brute = String(adresse ?? '');
  const formes = [brute.toLowerCase(), decodee(brute).toLowerCase()];
  for (const mot of MOTS_INTERDITS) {
    const cherche = mot.toLowerCase();
    if (formes.some((f) => f.includes(cherche))) return mot;
  }
  return null;
}

module.exports = {
  MOTS_INTERDITS,
  motInterdit,
};
