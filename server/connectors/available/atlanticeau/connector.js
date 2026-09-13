'use strict';

/**
 * Connecteur Atlantic'eau (opéré par STGS) — ÉBAUCHE du lot 73, SANS parcours.
 *
 * l'utilisateur n'a PAS de compte : seule la reconnaissance ANONYME a été faite
 * (reconnaissance du lot 73, 09/09/2026). L'espace client connecté n'a
 * jamais été vu. La fiche existe pour qu'une connexion puisse être ouverte et
 * gardée ; LE PARCOURS DES FACTURES N'EST PAS ÉCRIT.
 *
 * ─── Ce que la reconnaissance ANONYME a mesuré (09/09/2026) ──────────────────
 *
 *   - `espaceclient-atlanticeau.stgs.fr` est une application JAVA / STRUTS
 *     (cookie `JSESSIONID`, actions en `.action`, serveur Apache), SANS
 *     Cloudflare ni captcha ;
 *   - `/wp/home.action` sert l'écran « Identification — Agence en Ligne » :
 *     « Identifiant (adresse e-mail) », « Mot de passe », « Rester connecté »,
 *     bouton « Connexion » (le formulaire poste vers `encryptionCheck.external`) ;
 *   - toute action inconnue OU visée sert LE MÊME écran de connexion EN PLACE
 *     (sans redirection) : le témoin `/wp/nawak-inexistant-lot73.action` comme
 *     `/wp/facture.action`/`/wp/mesFactures.action` rendent l'écran
 *     d'identification. Le renvoi n'est donc PAS discriminant : aucune adresse
 *     de liste n'est prouvée, aucun `verifyUrl` n'est déclaré (contrôle de
 *     session impossible — « sans-controle »).
 *
 * À RELEVER À LA PREMIÈRE CONNEXION d'un compte réel : l'action qui porte la
 * liste des factures, la forme d'une ligne et son identifiant stable, la
 * nature du document. Rien n'est deviné ici.
 */

const ID = 'atlanticeau';
const NOM = "Atlantic'eau";

function messageEbauche() {
  return (
    `Votre connexion ${NOM} peut être ouverte et gardée, mais la récupération de vos `
    + 'factures n\'est pas encore écrite dans crabe : l\'espace client connecté n\'a pas '
    + 'encore été mesuré (la reconnaissance s\'est faite sans compte). Aucune facture n\'a '
    + 'été récupérée ; la première connexion d\'un compte réel permettra de relever '
    + 'l\'adresse de la liste des factures.'
  );
}

async function test(config, ctx = {}) {
  return {
    ok: true,
    accountId: null,
    invoiceCount: 0,
    message:
      `Fiche en préparation — la connexion ${NOM} peut être enregistrée, mais la `
      + 'récupération des factures n\'est pas encore écrite (espace client jamais mesuré '
      + 'sur un compte réel).',
  };
}

/**
 * Refuse — explicitement, avec son propre message (lot 73-bis).
 *
 * Le socle (lot 31) n'accepte « aucune nouvelle facture » que preuve à
 * l'appui : `ctx.preuveDeListe({ session, liste, elements })`, déposée au
 * point où la liste est réellement lue. Cette ébauche ne lit AUCUNE liste —
 * l'espace client n'a jamais été vu — donc elle ne conclut rien : elle échoue
 * en le disant. Rendre `{ invoices: [] }` sans preuve ferait lever la garde du
 * registre avec son message générique (« relancez la récupération ») — faux
 * ici : relancer ne changera rien tant que le parcours n'est pas écrit.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  log(`${ID} : ébauche (lot 73) — le parcours des factures n'est pas écrit. La `
    + 'reconnaissance anonyme n\'a pas pu relever l\'action qui porte la liste connectée '
    + '(Struts sert le même écran d\'identification pour toute action d\'un anonyme). '
    + 'Rien n\'a été récupéré.');
  throw new Error(messageEbauche());
}

module.exports = { test, fetchInvoices };
