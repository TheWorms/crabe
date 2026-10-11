'use strict';

/**
 * Lot 99 — les pages RECONSTITUÉES d'Alfaliquid, du Petit Vapoteur et
 * d'e-liquide-fr, servies à un vrai Chromium sans que rien ne sorte de la
 * machine.
 *
 * ─── D'où vient leur forme ───────────────────────────────────────────────────
 *
 * Le 11/10/2026, l'utilisateur a enregistré, connecté, le code source de la page « mes
 * commandes » de chaque boutique et d'une facture e-liquide-fr. Le prompt du
 * lot 99 en a repris la STRUCTURE, sans aucune donnée : balises, classes,
 * identifiants, forme des adresses, champs du formulaire Oxatis. C'est cette
 * structure que les pages ci-dessous reproduisent.
 *
 * Ce qu'aucune page enregistrée ne montre est INVENTÉ, et dit comme tel au
 * point où il l'est : la réponse du Petit Vapoteur à son adresse de facture mal
 * formée (trois variantes, faute de mesure), la pagination d'e-liquide-fr (la
 * règle du R4, la seule hypothèse), les pages de connexion au-delà d'un champ de
 * mot de passe.
 *
 * Lot 100 : la page « Mon compte » d'e-liquide-fr en lecture directe — la page
 * d'ARRIVÉE — n'est plus inventée. Le lot 99 lui avait prêté le formulaire de la
 * page « Suivi des commandes » ; l'utilisateur a enregistré la vraie le 11/10/2026, et
 * `arriveeOxatis` en reprend la structure (§2.2 du lot 100).
 *
 * Une page reconstituée prouve que le connecteur LIT cette forme. Elle ne
 * prouve rien du vrai site.
 *
 * ─── La mécanique : celle des lots 92 et 93 ──────────────────────────────────
 *
 * `lanceurFaux` du lot 93 : le vrai Chromium, dont chaque contexte — créé par
 * le connecteur, avec sa session — est branché sur le banc. Les hôtes déclarés
 * sont servis depuis la mémoire, toute autre requête est AVORTÉE ; aucune
 * réponse n'est une redirection HTTP (les renvois se font par la page) ; deux
 * filets à chaque passage (`fuites`) : une requête qui continue une
 * redirection, une réponse qui porte une adresse de serveur. Clics et saisies
 * sont rapportés par la page elle-même.
 *
 * Le banc ne sert une page de compte qu'à la SESSION du banc : chaque requête
 * doit porter le cookie de la session inventée (`sessionInventee`) — c'est ce
 * qui prouve que le connecteur rejoue la connexion capturée, et que chaque PDF
 * est suivi dans la session.
 *
 * Les fonctions `javascript:` de la page Oxatis (`WNDAPIOpenWindow`,
 * `SelectItem`) existent sur la page reconstituée et SIGNALENT tout appel au
 * banc (`/__banc/js`) : un `javascript:` exécuté se compterait.
 *
 * ⚠ Toutes les valeurs sont inventées et visiblement fausses : références en
 * « ZZ… », numéros à 9 000 000 et plus, montants à « 0,00 € », client
 * « Client d'essai ».
 */

const faux93 = require('./lot93-faux-sites');

const { PLAYWRIGHT, SANS_NAVIGATEUR, pdfInvente, lanceurFaux } = faux93;

const ALFALIQUID = 'www.alfaliquid.com';
const PETIT_VAPOTEUR = 'www.lepetitvapoteur.com';
const E_LIQUIDE = 'www.e-liquide-fr.com';
const HOTES = [ALFALIQUID, PETIT_VAPOTEUR, E_LIQUIDE];

/** Le cookie de la session du banc — inventé ; seule une requête qui le porte voit un compte. */
const COOKIE = { name: 'session-du-banc', value: 'valeur-inventee' };

function sessionInventee(domaine) {
  return JSON.stringify({
    cookies: [{
      name: COOKIE.name, value: COOKIE.value, domain: domaine, path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    origins: [],
  });
}

/** La requête porte-t-elle la session du banc ? */
async function sessionPortee(requete) {
  try {
    const entetes = await requete.allHeaders();
    return String(entetes.cookie || '').split(/;\s*/).includes(`${COOKIE.name}=${COOKIE.value}`);
  } catch {
    return false;
  }
}

function gabarit(titre, corps, { script = '', tete = '', html = '', body = '' } = {}) {
  return `<!doctype html><html lang="fr"${html}><head><meta charset="utf-8"><title>${titre}</title>${tete}</head>
<body${body}>${corps}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** Un renvoi fait par la PAGE, jamais par une réponse 3xx (lot 92). */
function renvoi(adresse) {
  return gabarit('Redirection', '', { script: `location.replace(${JSON.stringify(adresse)});` });
}

const introuvable = () => ({ statut: 404, html: gabarit('Page introuvable', '<h1>Page introuvable</h1>') });

// ---------------------------------------------------------------------------
// Alfaliquid — PrestaShop, thème classique
// ---------------------------------------------------------------------------

/** Trois commandes d'essai : deux avec facture, une sans. */
function compteAlfaliquid(extra = {}) {
  return {
    connecte: true,
    commandes: [
      { reference: 'ZZESSAIAA', date: '11/07/2026', idOrder: '9000001', facture: true },
      { reference: 'ZZESSAIBB', date: '02/06/2026', idOrder: '9000002', facture: false },
      { reference: 'ZZESSAICC', date: '15/01/2025', idOrder: '9000003', facture: true },
    ],
    ...extra,
  };
}

function lienFactureAlfaliquid(c) {
  return c.lienFacture || `https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=${c.idOrder}`;
}

function historiqueAlfaliquid(etat) {
  const lignes = etat.commandes.map((c) => `
      <tr>
        <th scope="row">${c.reference}</th>
        <td>${c.date}</td>
        <td class="text-xs-right">0,00 €</td>
        <td class="hidden-md-down">Carte d'essai</td>
        <td><span class="label label-pill bright">Livré</span></td>
        <td class="text-sm-center hidden-md-down">${c.facture
    ? `<a href="${lienFactureAlfaliquid(c)}"><i class="material-icons">&#xE415;</i></a>` : '-'}</td>
        <td class="text-sm-center order-actions">
          <a href="https://www.alfaliquid.com/fr/index.php?controller=order-detail&id_order=${c.idOrder}" data-link-action="view-order-details">Détails</a>
          <a href="https://www.alfaliquid.com/fr/commande?submitReorder=1&id_order=${c.idOrder}">Commander à nouveau</a>
        </td>
      </tr>`).join('');
  // La copie pour petits écrans — lien de facture compris, le pire cas : la
  // lire ferait compter chaque commande deux fois.
  const copie = etat.commandes.map((c) => `
      <div class="order"><div class="row">
        <div class="col-xs-10">
          <a href="https://www.alfaliquid.com/fr/index.php?controller=order-detail&id_order=${c.idOrder}"><h3>${c.reference}</h3></a>
          <div class="date">${c.date}</div><div class="total">0,00 €</div>
          <div class="status"><span class="label label-pill bright">Livré</span></div>
        </div>
        <div class="col-xs-2 text-xs-right">
          ${c.facture ? `<div><a href="${lienFactureAlfaliquid(c)}" title="Facture"><i class="material-icons">&#xE415;</i></a></div>` : ''}
          <div><a href="https://www.alfaliquid.com/fr/index.php?controller=order-detail&id_order=${c.idOrder}" data-link-action="view-order-details" title="Détails">+</a></div>
          <div><a href="https://www.alfaliquid.com/fr/commande?submitReorder=1&id_order=${c.idOrder}" title="Commander à nouveau">↻</a></div>
        </div>
      </div></div>`).join('');
  const tableau = etat.commandes.length ? `
    <table class="table table-striped table-bordered table-labeled table-history hidden-sm-down">
      <thead class="thead-default"><tr>
        <th>Référence de commande</th><th>Date</th><th>Prix total</th>
        <th class="hidden-md-down">Paiement</th><th class="hidden-md-down">État</th><th>Facture</th><th>&nbsp;</th>
      </tr></thead>
      <tbody>${lignes}</tbody>
    </table>
    <div class="orders table-replace-resp hidden-md-up">${copie}</div>`
    : '<p class="alert alert-info">Vous n\'avez pas encore passé de commande.</p>';
  return gabarit('Historique de vos commandes', `
    <header id="header"><a href="https://www.alfaliquid.com/fr/mon-compte" title="Voir mon compte client">Client d'essai</a>
      <a class="logout hidden-sm-down" href="https://www.alfaliquid.com/fr/?mylogout=">Déconnexion</a>
      <a href="https://www.alfaliquid.com/fr/panier?action=show">Panier (0)</a></header>
    <section id="main"><header class="page-header"><h1>Historique de vos commandes</h1></header>
      <section id="content" class="page-content"><h6>Voici les commandes que vous avez passées depuis la création de votre compte.</h6>
      ${tableau}</section></section>`, { body: ' id="history" class="lang-fr country-fr"' });
}

function connexionAlfaliquid() {
  return gabarit('Connexion', `<section id="main"><h1>Connectez-vous à votre compte</h1>
    <form id="login-form" method="post" action="https://www.alfaliquid.com/fr/connexion">
      <input type="email" name="email"><input type="password" name="password">
      <button id="submit-login" type="submit" name="submitLogin">Connexion</button></form></section>`,
  { body: ' id="authentication"' });
}

/**
 * Le faux Alfaliquid. `etat` : `{ connecte, commandes: [{ reference, date,
 * idOrder, facture, lienFacture? }], nonPdf?: [idOrder…],
 * sessionMeurtApresPdf?, surPdf? }`. Il compte ce qu'il sert dans
 * `etat.compteurs`.
 */
function siteAlfaliquid(etat) {
  etat.compteurs = { pdf: [], listes: 0, interdits: [], sansSession: 0 };
  let pdfServis = 0;
  return async (url, requete) => {
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresPdf) && pdfServis >= etat.sessionMeurtApresPdf);
    if (requete.method() !== 'GET') return { statut: 405, html: '' };
    if (/submitReorder|mylogout|panier|cart/i.test(url.href)) {
      etat.compteurs.interdits.push(url.pathname);
      return { html: gabarit('Panier', '<h1>Panier</h1>') };
    }
    if (url.pathname === '/fr/historique-commandes') {
      etat.compteurs.listes++;
      if (!vivante) {
        etat.compteurs.sansSession++;
        return { html: renvoi('/fr/connexion?back=historique-commandes') };
      }
      return { html: historiqueAlfaliquid(etat) };
    }
    if (url.pathname === '/fr/connexion') return { html: connexionAlfaliquid() };
    if (url.pathname === '/fr/index.php' && url.searchParams.get('controller') === 'pdf-invoice') {
      if (!vivante) return { html: connexionAlfaliquid() };
      const c = etat.commandes.find((x) => x.idOrder === url.searchParams.get('id_order') && x.facture);
      if (!c) return { html: gabarit('Erreur', '<h1>Facture introuvable</h1>') };
      pdfServis++;
      etat.surPdf?.(pdfServis);
      etat.compteurs.pdf.push(c.idOrder);
      if ((etat.nonPdf || []).includes(c.idOrder)) {
        return { corps: Buffer.from('<!doctype html><html><body>Une erreur est survenue</body></html>', 'latin1'), entetes: { 'content-type': 'text/html' } };
      }
      return {
        corps: pdfInvente(`facture inventee alfaliquid ${c.idOrder}`),
        entetes: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="facture.pdf"' },
      };
    }
    return introuvable();
  };
}

// ---------------------------------------------------------------------------
// Le Petit Vapoteur — PrestaShop, thème maison
// ---------------------------------------------------------------------------

/** Cinq commandes d'essai, quatre factures — les liens à l'adresse MAL FORMÉE, comme la vraie page. */
function comptePetitVapoteur(extra = {}) {
  return {
    connecte: true,
    // Ce que fait le site de l'adresse mal formée — INVENTÉ, faute de mesure :
    //   'donnee'   : elle sert le PDF (la forme corrigée aussi) ;
    //   'corrigee' : elle ne le sert pas, la forme corrigée oui ;
    //   'aucune'   : ni l'une ni l'autre.
    variante: 'donnee',
    commandes: [
      { numero: 'ZZ9100001', date: '03/09/2026', idOrder: '9100001', facture: true },
      { numero: 'ZZ9100002', date: '21/08/2026', idOrder: '9100002', facture: true },
      { numero: 'ZZ9100003', date: '14/05/2026', idOrder: '9100003', facture: false },
      { numero: 'ZZ9100004', date: '30/12/2025', idOrder: '9100004', facture: true },
      { numero: 'ZZ9100005', date: '08/02/2025', idOrder: '9100005', facture: true },
    ],
    ...extra,
  };
}

function lienFacturePetitVapoteur(c) {
  return c.lienFacture || `https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=${c.idOrder}`;
}

function historiquePetitVapoteur(etat) {
  const blocs = etat.commandes.map((c, i) => `
    <div class="item-cmd">
      <div class="item-cmd-head">
        <span class="cmd-state-${4 + (i % 2)}">Livrée</span>
        <span class="cmd-date">Commande du ${c.date}</span>
        <span class="cmd-num">N° de commande <span class="cmd-number">${c.numero}</span></span>
        <span class="cmd-price">0,00 €</span>
        <span class="cmd-points">0 point de fidélité</span>
      </div>
      <div class="item-cmd-content"><div class="product">Liquide d'essai × 1</div></div>
      <div class="item-cmd-content_actions">
        ${c.facture ? `<div class="invoice"><a class="invoice-link pdf" title="Télécharger votre facture au format PDF" href="${lienFacturePetitVapoteur(c)}">Télécharger la facture</a></div>` : ''}
        <a id="showOrder" href="https://www.lepetitvapoteur.com/fr/index.php?controller=order-detail&id_order=${c.idOrder}">Voir la commande</a>
        <a id="reOrder" href="https://www.lepetitvapoteur.com/fr/commande?submitReorder=&id_order=${c.idOrder}">Acheter à nouveau</a>
      </div>
    </div>`).join('');
  return gabarit('Historique des commandes', `
    <header><a href="https://www.lepetitvapoteur.com/fr/mon-compte">Mon compte</a>
      <a href="/?mylogout" title="Déconnexion">Déconnexion</a> <a href="/fr/panier">Panier</a></header>
    <main><h1>Historique des commandes</h1>${blocs || '<p>Vous n\'avez passé aucune commande.</p>'}</main>`,
  { body: ' id="history" class="logged lang-fr"' });
}

function connexionPetitVapoteur() {
  return gabarit('Authentification', `<main><h1>Identifiez-vous</h1>
    <form method="post" action="/fr/authentification"><input type="email" name="email">
      <input type="password" name="passwd"><button type="submit" name="SubmitLogin">Se connecter</button></form></main>`,
  { body: ' id="authentication"' });
}

/**
 * Le faux Petit Vapoteur. `etat` : `{ connecte, variante, commandes,
 * nonPdf?, sessionMeurtApresPdf?, sessionMeurtApresListe?, surPdf? }`. Il compte, par forme
 * d'adresse, les demandes de PDF (`etat.compteurs.donnee` / `.corrigee`).
 */
function sitePetitVapoteur(etat) {
  etat.compteurs = { donnee: [], corrigee: [], pdf: [], listes: 0, interdits: [] };
  let pdfServis = 0;
  return async (url, requete) => {
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresPdf) && pdfServis >= etat.sessionMeurtApresPdf);
    if (requete.method() !== 'GET') return { statut: 405, html: '' };
    if (/submitReorder|mylogout|panier|cart/i.test(url.href)) {
      etat.compteurs.interdits.push(url.pathname);
      return { html: gabarit('Panier', '<h1>Panier</h1>') };
    }
    if (url.pathname === '/fr/historique-des-commandes') {
      etat.compteurs.listes++;
      if (!vivante) return { html: renvoi('/fr/authentification?back=/fr/historique-des-commandes') };
      // `sessionMeurtApresListe` : la liste est servie, puis la session tombe.
      if (etat.sessionMeurtApresListe) etat.connecte = false;
      return { html: historiquePetitVapoteur(etat) };
    }
    if (url.pathname === '/fr/authentification') return { html: connexionPetitVapoteur() };
    if (url.pathname === '/fr/index.php') {
      const controleur = url.searchParams.get('controller') || '';
      const malFormee = /^pdf-invoice\?id_order=(\d+)$/.exec(controleur);
      const bienFormee = controleur === 'pdf-invoice' ? url.searchParams.get('id_order') : null;
      const idOrder = malFormee ? malFormee[1] : bienFormee;
      if (!idOrder) return introuvable();
      (malFormee ? etat.compteurs.donnee : etat.compteurs.corrigee).push(idOrder);
      if (!vivante) return { html: connexionPetitVapoteur() };
      const sert = malFormee ? etat.variante === 'donnee' : etat.variante !== 'aucune';
      // Ce que le site ferait d'une adresse qu'il ne comprend pas — inventé :
      // sa page d'accueil, en HTML.
      if (!sert) return { html: gabarit('Le Petit Vapoteur', '<h1>Bienvenue</h1>', { body: ' id="index"' }) };
      const c = etat.commandes.find((x) => x.idOrder === idOrder && x.facture);
      if (!c) return { html: gabarit('Erreur', '<h1>Facture introuvable</h1>') };
      pdfServis++;
      etat.surPdf?.(pdfServis);
      etat.compteurs.pdf.push(idOrder);
      if ((etat.nonPdf || []).includes(idOrder)) {
        return { corps: Buffer.from('<!doctype html><html><body>Une erreur est survenue</body></html>', 'latin1'), entetes: { 'content-type': 'text/html' } };
      }
      return { corps: pdfInvente(`facture inventee petit vapoteur ${idOrder}`), entetes: { 'content-type': 'application/pdf' } };
    }
    return introuvable();
  };
}

// ---------------------------------------------------------------------------
// e-liquide-fr — Oxatis
// ---------------------------------------------------------------------------

const MOIS_ABREGES = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/**
 * `n` commandes d'essai, des plus récentes aux plus anciennes, chacune avec sa
 * facture (sauf `sansFacture`). Numéros à partir de 9 200 001.
 */
function commandesELiquide(n, { sansFacture = [] } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const numero = String(9200001 + i);
    // De septembre 2026 en remontant, un mois par commande.
    const rang = 8 - i;
    const mois = ((rang % 12) + 12) % 12;
    const annee = 2026 + Math.floor(rang / 12);
    const mm = String(mois + 1).padStart(2, '0');
    return {
      numero,
      date: `${(i % 27) + 1} ${MOIS_ABREGES[mois]} ${annee}`,
      facture: !sansFacture.includes(i),
      fichier: `Files/99999/Orders/${numero}/Invoice-${annee}-${mm}-${numero}.htm`,
    };
  });
}

function compteELiquide(extra = {}) {
  return {
    connecte: true,
    commandes: commandesELiquide(12),
    // La pagination — INVENTÉE, faute de mesure (règle du R4) :
    //   'index'   : OrdersPageIdx choisit la page ;
    //   'ignoree' : le site renvoie toujours la première ;
    //   'infinie' : chaque page est pleine et neuve, sans fin.
    pagination: 'index',
    lignesParPage: 5,
    // Les champs de MForm ; un essai peut en changer un (`formulaire`) ou en
    // ajouter (`champsEnPlus`) — sur les DEUX pages (lot 100) : un champ de
    // `formulaire` absent de la page d'arrivée y est ajouté, caché.
    formulaire: {},
    action: 'PBUserAccount.asp',
    // Lot 100 — la page d'ARRIVÉE seule : `coupon` (la valeur servie de
    // DiscountCoupon), `champsEnPlus` (ajoutés à son seul MForm), `classes`
    // (celles de `#maincontainer`, mesurées : « useraccount userdashboard »).
    arrivee: {},
    // Lot 100 — la page des commandes seule : `formulaire` (champs changés ;
    // `null` retire le champ), `champsEnPlus`.
    liste: {},
    // Lot 100 — ce que rend l'envoi `ActionID=8` parti de la page d'arrivée.
    // INVENTÉ pour le R3 (ce que `SubmitAction` ajoute est non mesuré) :
    //   'liste'  : la page des commandes (l'hypothèse retenue) ;
    //   'compte' : encore la page d'arrivée, sans tableau.
    reponseSuivi: 'liste',
    ...extra,
  };
}

/** Des champs cachés, dans l'ordre ; `null` retire le champ. */
function champsCaches(champs) {
  return Object.entries(champs).filter(([, valeur]) => valeur !== null)
    .map(([nom, valeur]) => `<input type="hidden" name="${nom}" value="${valeur}">`).join('\n      ');
}

/** Les champs de MForm sur la page « Suivi des commandes » (mesurés au lot 99). */
function champsMForm(etat, pageIdx, actionId) {
  const champs = {
    ActionID: actionId,
    OrderID: '',
    OrdersPageIdx: String(pageIdx),
    ReloadMode: '0',
    PagingAPIRowCount: String(etat.lignesParPage),
    PagingAPIHashCode: 'hash-invente-0000',
    ...etat.formulaire,
    ...(etat.liste?.formulaire || {}),
  };
  return champsCaches(champs) + (etat.champsEnPlus || '') + (etat.liste?.champsEnPlus || '');
}

const SCRIPT_OXATIS = `
  window.WNDAPIOpenWindow = function (nom) { fetch('/__banc/js?f=WNDAPIOpenWindow&n=' + encodeURIComponent(nom)); };
  window.SelectItem = function () { fetch('/__banc/js?f=SelectItem'); };
  window.SubmitAction = function (n) { fetch('/__banc/js?f=SubmitAction&n=' + encodeURIComponent(n)); };`;

function pageOxatis(etat, { titre, corps, pageIdx = 1, actionId = '0', connecte = true }) {
  const form = `<form name="MForm" method="POST" action="${etat.action}"${etat.cible ? ` target="${etat.cible}"` : ''}>
      ${champsMForm(etat, pageIdx, actionId)}
    </form>`;
  return gabarit(titre, `
    <div id="header"><a href="/">e-liquide-fr (essai)</a> <a href="/PBShoppingCart.asp">Panier</a>
      ${connecte ? '<button type="button" ng-click="logout()">Déconnexion</button>' : '<a href="/PBUserLogin.asp?CCode=33">Se connecter</a>'}</div>
    ${form}
    <a href="javascript:document.MForm.ActionID.value=8;document.MForm.submit();">Suivi des commandes</a>
    ${corps}`, {
    html: connecte ? ' class="is-user-logged"' : '',
    tete: '<meta name="generator" content="Oxatis (www.oxatis.com)">',
    script: `${SCRIPT_OXATIS}${etat.scriptPage || ''}`,
  });
}

/**
 * Lot 100 — la page d'ARRIVÉE « Mon compte », telle que `PBUserAccount.asp` la
 * sert en lecture directe (mesuré : code source enregistré connecté par l'utilisateur,
 * adresse tapée directement ; structure reprise, données inventées). Titre
 * « Mon Compte », `html.is-user-logged`, ISO-8859-1, `#maincontainer` de
 * classes `useraccount userdashboard`. Son `MForm` ne porte QUE `ActionID`
 * (caché, 0) et `DiscountCoupon` (texte, vide) : ni ReloadMode, ni OrderID, ni
 * champ de pagination — le lot 99 lui avait prêté le formulaire de la page
 * « Suivi des commandes », la seule qu'il connaissait. Le menu `ul.menulist`
 * porte des `javascript:SubmitAction(N,null,0,null,1)` (8 « Suivre vos
 * commandes », 10 « Recharger… », 2, 20, 6, 5, 18, 1) et le bouton « Mettre à
 * jour » du code promotionnel (11) ; dans l'en-tête, « Mes Commandes »
 * (`cs-redirect`, `params="::{ActionID: 8}"`). Le nom et le courriel du client,
 * que porte la vraie page, sont inventés ici.
 */
function arriveeOxatis(etat) {
  const a = etat.arrivee || {};
  const menu = [
    ['ViewOrders', 8, 'Suivre vos commandes'],
    ['ReloadOrder', 10, 'Recharger une commande ou un devis dans le panier d\'achat'],
    ['EditProp', 2, 'Modifier vos informations personnelles'],
    ['EditMail', 20, 'Modifier votre adresse e-mail'],
    ['EditPW', 6, 'Modifier votre mot de passe'],
    ['ViewFiles', 5, 'Vos fichiers'],
    ['EditMeansOfPayment', 18, 'Vos moyens de paiement'],
    ['LogOut', 1, 'Se déconnecter'],
  ].map(([cle, n, libelle]) => `<li class="${cle}"><a href="javascript:SubmitAction(${n},null,0,null,1)">${libelle}</a></li>`)
    .join('\n        ');
  const html = `<!doctype html><html lang="fr" class="is-user-logged"><head>
<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><title>Mon Compte</title>
<meta name="generator" content="Oxatis (www.oxatis.com)"></head>
<body>
  <div id="header"><a href="/">e-liquide-fr (essai)</a>
    <a class="cs-redirect" url="PBUserAccount.asp" params="::{ActionID: 8}">Mes Commandes</a>
    <a href="/PBShoppingCart.asp">Panier</a>
    <button type="button" ng-click="logout()">Déconnexion</button></div>
  <div id="maincontainer" class="${a.classes ?? 'useraccount userdashboard'}">
    <form name="MForm" method="POST" action="${etat.action}"${etat.cible ? ` target="${etat.cible}"` : ''}>
      ${champsCaches({ ActionID: '0', ...etat.formulaire })}
      <h1>Mon compte</h1>
      <p>Bonjour Client d'essai (client@exemple.invalid)</p>
      <ul class="menulist">
        ${menu}
      </ul>
      <div class="discountcoupon"><label for="DiscountCoupon">Code promotionnel</label>
        <input type="text" id="DiscountCoupon" name="DiscountCoupon" value="${a.coupon || ''}">
        <button type="button" onclick="SubmitAction(11,null,0,null,1)">Mettre à jour</button></div>
      ${etat.champsEnPlus || ''}${a.champsEnPlus || ''}
    </form>
  </div>
  <script>${SCRIPT_OXATIS}${etat.scriptPage || ''}</script>
</body></html>`;
  return { corps: Buffer.from(html, 'latin1'), entetes: { 'content-type': 'text/html; charset=ISO-8859-1' } };
}

/** Les lignes de la page `n` selon la pagination du banc. */
function lignesDeLaPage(etat, n) {
  const par = etat.lignesParPage;
  if (etat.pagination === 'ignoree') return etat.commandes.slice(0, par);
  if (etat.pagination === 'infinie') {
    // Des commandes neuves à chaque page, sans facture : seule la lecture des
    // pages est éprouvée.
    return commandesELiquide(par).map((c, i) => ({ ...c, numero: String(9300000 + (n - 1) * par + i), facture: false }));
  }
  return etat.commandes.slice((n - 1) * par, n * par);
}

function lienFactureELiquide(c) {
  return c.appelFacture
    || `javascript:WNDAPIOpenWindow('InvoiceView','${c.fichier}',800,600)`;
}

function listeOxatis(etat, n) {
  const lignes = lignesDeLaPage(etat, n).map((c) => `
      <tr>
        <td><span class="PBNumber">${c.numero}</span></td>
        <td><span class="PBDate">${c.date}</span></td>
        <td class="PBCurrency">0,00 €</td>
        <td>Expédiée</td>
        <td>
          <a href="javascript:WNDAPIOpenWindow('InvoiceWnd','PBRenderInvoice.asp?PBLangID=0&OrderID=${c.numero}',800,600)">détail</a>
          <a href="javascript:SelectItem(${c.numero},9)">historique</a>
          ${c.facture ? `<a href="${lienFactureELiquide(c)}"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="SCShowInvoice"> facture</a>` : ''}
          <a href="/PBShoppingCart.asp?ReloadOrderID=${c.numero}">Recharger</a>
        </td>
      </tr>`).join('');
  return pageOxatis(etat, {
    titre: 'Mon compte',
    pageIdx: n,
    actionId: '8',
    corps: `<h1>Suivi des commandes</h1>
    <table class="PBTable">
      <tr><th>Numéro</th><th>Date</th><th>Montant TTC</th><th>Etat</th><th></th></tr>${lignes}
    </table>`,
  });
}

function connexionOxatis(etat) {
  return gabarit('Identification', `<h1>Identifiez-vous</h1>
    <form name="LoginForm" method="POST" action="PBUserLogin.asp"><input type="text" name="Email">
      <input type="password" name="Password"><input type="submit" value="Valider"></form>`, {
    tete: '<meta name="generator" content="Oxatis (www.oxatis.com)">',
    script: SCRIPT_OXATIS,
  });
}

/**
 * Une facture Oxatis — PAGE HTML en `windows-1252` (mesuré), encodée ici à la
 * main : « € » est l'octet 0x80, « é » 0xE9. Données inventées, et le client
 * aussi (« Client d'essai »).
 */
const WINDOWS_1252 = {
  '€': 0x80, '’': 0x92, '—': 0x97, '°': 0xb0, 'É': 0xc9, 'à': 0xe0, 'â': 0xe2, 'ç': 0xe7, 'è': 0xe8, 'é': 0xe9,
  'ê': 0xea, 'ë': 0xeb, 'î': 0xee, 'ï': 0xef, 'ô': 0xf4, 'ù': 0xf9, 'û': 0xfb,
};
function enWindows1252(texte) {
  return Buffer.from([...texte].map((c) => {
    if (WINDOWS_1252[c] !== undefined) return WINDOWS_1252[c];
    const code = c.charCodeAt(0);
    if (code > 0x7f) throw new Error(`caractère hors de la table d'essai : ${c}`);
    return code;
  }));
}

function factureOxatis(c, { titre = 'Facture' } = {}) {
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>${titre}</title></head>
<body>
<h1>Facture ZZ-${c.numero}</h1>
<p>Date de facture : ${c.date}</p>
<table id="InvoiceAddress"><tr><td>Client d'essai<br>1 rue de l'Exemple<br>00000 Ville-d'Essai</td></tr></table>
<table id="InvoiceOrder"><tr><td>Commande n° ZZ${c.numero}</td><td>Date de commande : ${c.date}</td><td>Date de facture : ${c.date}</td>
<td>Paiement : carte d'essai</td><td>Livraison : point relais d'essai</td></tr></table>
<table id="InvoiceBody">
<tr><th>Désignation</th><th>Quantité</th><th>Prix unitaire TTC</th><th>Total TTC</th></tr>
<tr><td>Liquide d'essai à la pêche</td><td>1</td><td>0,00 €</td><td>0,00 €</td></tr>
<tr><td colspan="3">TVA 20 %</td><td>0,00 €</td></tr>
<tr><td colspan="3">Total TTC</td><td>0,00 €</td></tr>
</table>
<p>Boutique d'essai — société d'essai au capital de 0 € — RCS Ville-d'Essai 000 000 000</p>
</body></html>`;
  return enWindows1252(html);
}

function corpsFormulaire(requete) {
  const brut = requete.postData() || '';
  return [...new URLSearchParams(brut).entries()];
}

/**
 * Le faux e-liquide-fr. `etat` : `{ connecte, commandes, pagination,
 * lignesParPage, formulaire, champsEnPlus, action, cible, scriptPage,
 * arrivee, liste, reponseSuivi, pasUneFacture?: [numero…],
 * factureExigeSession?, sessionMeurtApresFacture?, surFacture?,
 * enteteFacture? }`. Il compte : `envois` (chaque POST, ses champs dans
 * l'ordre), `factures` (les pages .htm servies), `appelsJs` (dont
 * `SubmitAction`, lot 100), et les adresses interdites demandées.
 */
function siteELiquide(etat) {
  etat.compteurs = { envois: [], factures: [], appelsJs: [], interdits: [], comptes: 0 };
  let facturesServies = 0;
  return async (url, requete) => {
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresFacture) && facturesServies >= etat.sessionMeurtApresFacture);
    if (url.pathname === '/__banc/js') {
      etat.compteurs.appelsJs.push(url.searchParams.get('f'));
      return { statut: 204, html: '' };
    }
    if (/PBShoppingCart|ReloadOrderID/i.test(url.href)) {
      etat.compteurs.interdits.push(`${requete.method()} ${url.pathname}`);
      return { html: gabarit('Panier', '<h1>Panier</h1>') };
    }
    if (url.pathname === '/PBUserLogin.asp') return { html: connexionOxatis(etat) };
    if (url.pathname === '/PBUserAccount.asp') {
      if (requete.method() === 'POST') {
        const champs = corpsFormulaire(requete);
        etat.compteurs.envois.push(champs);
        if (!vivante) return { html: connexionOxatis(etat) };
        const valeur = (nom) => (champs.find(([k]) => k === nom) || [])[1];
        if (valeur('ActionID') !== '8') return arriveeOxatis(etat);
        // Parti de la page d'arrivée (aucun champ de pagination) : ce que rend
        // le site est la seule inconnue du R3 (`reponseSuivi`).
        if (valeur('OrdersPageIdx') === undefined && etat.reponseSuivi === 'compte') return arriveeOxatis(etat);
        const n = Math.max(1, Number.parseInt(valeur('OrdersPageIdx') || '1', 10) || 1);
        return { html: listeOxatis(etat, n) };
      }
      etat.compteurs.comptes++;
      if (!vivante) return { html: renvoi('/PBUserLogin.asp?CCode=33') };
      return arriveeOxatis(etat);
    }
    if (url.pathname.startsWith('/Files/')) {
      const c = etat.commandes.find((x) => `/${x.fichier}` === url.pathname);
      if (!c) return introuvable();
      if (etat.factureExigeSession !== false && !vivante) return { html: renvoi('/PBUserLogin.asp?CCode=33') };
      facturesServies++;
      etat.surFacture?.(facturesServies);
      etat.compteurs.factures.push(c.numero);
      if ((etat.pasUneFacture || []).includes(c.numero)) {
        return { corps: enWindows1252('<html><head><title>Erreur</title></head><body><h1>Le document demandé n’est plus disponible</h1></body></html>'), entetes: { 'content-type': 'text/html' } };
      }
      return { corps: factureOxatis(c), entetes: { 'content-type': etat.enteteFacture || 'text/html' } };
    }
    if (url.pathname === '/') return { html: gabarit('e-liquide-fr', '<h1>Accueil</h1>') };
    return introuvable();
  };
}

module.exports = {
  PLAYWRIGHT,
  SANS_NAVIGATEUR,
  ALFALIQUID,
  PETIT_VAPOTEUR,
  E_LIQUIDE,
  HOTES,
  COOKIE,
  MOIS_ABREGES,
  lanceurFaux,
  pdfInvente,
  sessionInventee,
  gabarit,
  renvoi,
  compteAlfaliquid,
  siteAlfaliquid,
  historiqueAlfaliquid,
  comptePetitVapoteur,
  sitePetitVapoteur,
  historiquePetitVapoteur,
  commandesELiquide,
  compteELiquide,
  siteELiquide,
  factureOxatis,
  enWindows1252,
};
