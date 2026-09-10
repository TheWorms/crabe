'use strict';

/**
 * Connecteur Mint Énergie — ÉBAUCHE du lot 73, SANS parcours.
 *
 * l'utilisateur n'a PAS de compte : seule la reconnaissance ANONYME a été faite
 * (reconnaissance du lot 73, 09/09/2026). L'espace client connecté n'a
 * jamais été vu. La fiche existe pour qu'une connexion puisse être ouverte et
 * gardée ; LE PARCOURS DES FACTURES N'EST PAS ÉCRIT.
 *
 * ─── Ce que la reconnaissance ANONYME a mesuré (09/09/2026) ──────────────────
 *
 *   - `client.mint-energie.com` est une application ASP.NET WebForms
 *     (cookie `ASP.NET_SessionId`, champs cachés `__VIEWSTATE`), SANS
 *     Cloudflare ni captcha ;
 *   - `/Pages/Connexion/connexion.aspx` sert l'écran de connexion : un
 *     identifiant, un mot de passe, un bouton « Se connecter », et HUIT champs
 *     cachés dont `__VIEWSTATE`. ⚠ Leçon PayByPhone (lot 67) : ne viser JAMAIS
 *     que les champs VISIBLES — `__VIEWSTATE` et consorts sont l'état interne
 *     du serveur, pas des champs de saisie. Ici la connexion passe de toute
 *     façon par la fenêtre visible (l'utilisateur tape), pas en programme ;
 *   - ce site DISCRIMINE (contrairement à SEPIG et Atlantic'eau) : le témoin
 *     `/Pages/Connexion/nawak-inexistant-lot73.aspx` rend un VRAI 404 (302 vers
 *     `/404.aspx`). Mais les pages de factures supposées (`/Pages/Factures/
 *     factures.aspx`) rendent AUSSI 404 : l'adresse de la liste n'a pas été
 *     trouvée en anonyme, et `/Default.aspx` renvoie vers la souscription. Donc
 *     AUCUN renvoi d'anonyme vers la connexion n'a été mesuré : pas de
 *     `verifyUrl` (contrôle de session impossible — « sans-controle »).
 *
 * À RELEVER À LA PREMIÈRE CONNEXION d'un compte réel : l'adresse de la liste
 * des factures, la forme d'une ligne et son identifiant stable, la nature du
 * document. Rien n'est deviné ici.
 */

const ID = 'mint-energie';
const NOM = 'Mint Énergie';

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
    + 'reconnaissance anonyme n\'a pas pu relever l\'adresse de la liste connectée '
    + '(application ASP.NET : les pages de factures supposées rendent 404 en anonyme). '
    + 'Rien n\'a été récupéré.');
  throw new Error(messageEbauche());
}

module.exports = { test, fetchInvoices };
