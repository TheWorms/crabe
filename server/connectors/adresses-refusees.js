'use strict';

/**
 * Les adresses que les connecteurs À GESTES du lot 104 (Battle.net, Alma,
 * Private Sport Shop) ne suivent jamais — la liste, et la seule fonction qui
 * la consulte.
 *
 * ─── Pourquoi un module à part ───────────────────────────────────────────────
 *
 * Le lot 99 a gelé, pour ses trois boutiques, une liste de mots d'adresse qui
 * agissent (« Commander à nouveau », panier, retour…) ; un essai vérifie que
 * son module n'est employé que par elles. Le lot 104 reprend CETTE liste, mot
 * pour mot, et l'augmente de ce que ses trois sites montrent à côté des
 * documents : le panier de Private Sport Shop (`checkout.privatesportshop.fr`),
 * ses retours (`/ProductReturn/…`), ses moyens de paiement
 * (`/sales/billing_agreement/`), le paiement, le rééchelonnement d'Alma, et la
 * déconnexion. La liste du lot 99 n'est pas touchée : ses trois connecteurs ne
 * changent pas. Un essai vérifie que celle-ci la contient entière.
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * Comme au lot 99 : un mot présent dans l'adresse, en majuscules ou en
 * minuscules, telle quelle ou décodée. Une exception, écrite : `pay` est un
 * mot COURT, présent dans `payment_…` — l'adresse même de la page d'un achat
 * Alma, que crabe doit lire — et dans « PayPal ». Il n'est donc refusé que
 * seul, entre deux caractères qui ne sont pas des lettres (`/pay`, `?pay=`,
 * `/pay/…`). Module pur : aucune page, aucun réseau.
 */

/** La liste du lot 99, recopiée telle quelle (un essai la compare à l'original). */
const MOTS_DU_LOT_99 = Object.freeze([
  'submitReorder',
  'ReloadOrderID',
  'PBShoppingCart',
  'reOrder',
  'panier',
  'cart',
  'order-follow',
  'return',
]);

/** Ce que le lot 104 ajoute, cherché comme au lot 99 (partout dans l'adresse). */
const MOTS_DU_LOT_104 = Object.freeze([
  'checkout',
  'ProductReturn',
  'billing_agreement',
  'reschedule',
  'logout',
]);

/** Les mots cherchés seuls, entre deux caractères qui ne sont pas des lettres. */
const MOTS_SEULS = Object.freeze(['pay']);

/** Tous les mots refusés, dans l'ordre où ils sont cherchés. */
const MOTS_REFUSES = Object.freeze([...MOTS_DU_LOT_99, ...MOTS_DU_LOT_104, ...MOTS_SEULS]);

function decodee(texte) {
  try {
    return decodeURIComponent(texte);
  } catch {
    return texte;
  }
}

/**
 * Le premier mot refusé que porte une adresse, ou `null`. Pure.
 *
 * @param {string} adresse
 * @returns {string|null}
 */
function motRefuse(adresse) {
  const brute = String(adresse ?? '');
  const formes = [brute.toLowerCase(), decodee(brute).toLowerCase()];
  for (const mot of [...MOTS_DU_LOT_99, ...MOTS_DU_LOT_104]) {
    const cherche = mot.toLowerCase();
    if (formes.some((f) => f.includes(cherche))) return mot;
  }
  for (const mot of MOTS_SEULS) {
    const seul = new RegExp(`(^|[^a-z])${mot}([^a-z]|$)`);
    if (formes.some((f) => seul.test(f))) return mot;
  }
  return null;
}

module.exports = {
  MOTS_DU_LOT_99,
  MOTS_DU_LOT_104,
  MOTS_SEULS,
  MOTS_REFUSES,
  motRefuse,
};
