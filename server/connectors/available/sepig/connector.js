'use strict';

/**
 * Connecteur SEPIG (eau) — ÉBAUCHE du lot 73, SANS parcours.
 *
 * l'utilisateur n'a PAS de compte SEPIG : la seule mesure possible a été la
 * reconnaissance ANONYME (reconnaissance du lot 73, 09/09/2026). L'espace
 * client connecté — et donc l'adresse de la liste des factures — n'a jamais
 * été vu. Cette fiche existe pour qu'une connexion puisse être ouverte et
 * gardée (par un utilisateur qui, lui, a un compte) ; LE PARCOURS DES FACTURES
 * N'EST PAS ÉCRIT, et une récupération le dit franchement.
 *
 * ─── Ce que la reconnaissance ANONYME a mesuré (09/09/2026) ──────────────────
 *
 *   - SEPIG EAU (distribution d'eau) ; `mon-espace.sepig.fr` est une
 *     application REACT à page unique, derrière Cloudflare ;
 *   - `/fr/connexion` : un identifiant, un mot de passe, un bouton « Me
 *     connecter », et un reCAPTCHA monté → la connexion ne se soumet pas en
 *     programme : fenêtre visible, profil persistant ;
 *   - le serveur rend la MÊME coquille d'application pour tout `/fr/...` :
 *     le témoin `/fr/nawak-inexistant-lot73` ET les pages visées
 *     (`/fr/factures`, `/fr/mon-espace`) finissent toutes sur `/fr/connexion`
 *     pour un anonyme. Le renvoi n'est donc PAS discriminant : il ne prouve
 *     pas qu'une adresse de liste existe, et aucune n'est déclarée
 *     (`verifyUrl` absent, contrôle de session impossible — « sans-controle »,
 *     dit tel quel dans le manifeste).
 *
 * À RELEVER À LA PREMIÈRE CONNEXION (par un compte réel) : l'adresse de la
 * liste des factures une fois connecté, la forme d'une ligne et son
 * identifiant stable, la nature du document (PDF ?). Rien de tout cela n'est
 * deviné ici.
 */

const ID = 'sepig';
const NOM = 'SEPIG';

function messageEbauche() {
  return (
    `Votre connexion ${NOM} peut être ouverte et gardée, mais la récupération de vos `
    + 'factures n\'est pas encore écrite dans crabe : l\'espace client connecté n\'a pas '
    + 'encore été mesuré (la reconnaissance s\'est faite sans compte). Aucune facture n\'a '
    + 'été récupérée ; la première connexion d\'un compte réel permettra de relever '
    + 'l\'adresse de la liste des factures.'
  );
}

/** Vérification légère : la fiche est en préparation, rien à contrôler encore. */
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
    + 'reconnaissance anonyme n\'a pas pu relever l\'adresse de la liste connectée '
    + '(application React à page unique : toutes les routes anonymes finissent sur la '
    + 'page de connexion). Rien n\'a été récupéré.');
  throw new Error(messageEbauche());
}

module.exports = { test, fetchInvoices };
