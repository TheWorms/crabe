'use strict';

/**
 * Lot 92 — les pages RECONSTITUÉES de Decathlon et de Bricomarché, servies à
 * un vrai Chromium sans que rien ne sorte de la machine.
 *
 * ─── D'où viennent ces pages, et ce qu'elles prouvent ────────────────────────
 *
 * Aucune mission n'a vu les vraies : il faut une session, et le lot n'en ouvre
 * aucune. Elles sont écrites d'après les captures décrites par l'utilisateur le
 * 05/10/2026 (historique et détail d'un achat Decathlon, « Mes achats » de
 * Bricomarché) et d'après les relevés du lot 52 sur la liste Decathlon
 * (`article.my-purchase`, `aria-labelledby="wef-account-order-<n°>"`, lien de
 * détail `/account/orderTracking?…&type=oneom|store`). Ce qu'aucune capture ne
 * montre est INVENTÉ et dit comme tel ici : la mécanique du bouton de facture
 * (téléchargement, onglet, formulaire), la forme d'un achat en magasin chez
 * Bricomarché, la page d'une commande Bricomarché.
 *
 * Une page reconstituée prouve que le connecteur LIT cette forme. Elle ne
 * prouve rien du vrai site.
 *
 * ─── La mécanique ────────────────────────────────────────────────────────────
 *
 * `context.route('**\/*')` sert les adresses des deux sites depuis la mémoire ;
 * toute autre requête est AVORTÉE : un essai ne sort jamais sur le réseau.
 * Chaque clic de la page est rapporté par une liaison exposée (`__crabeClic`),
 * chaque saisie aussi (`__crabeSaisie`), et chaque requête qui n'est pas une
 * lecture (`POST`…) est inscrite : les compter, c'est ne pas les supposer.
 *
 * ⚠ Toutes les valeurs sont inventées et visiblement fausses : numéros en
 * « ZZ… » ou « 0000-… », montants à « 0,00 € », article « d'essai ».
 */

const profilMarchand = require('../server/connectors/profil-marchand');
const identity = require('../server/connectors/browser-identity');

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT
    ? false
    : 'Playwright n\'est pas installé : les pages reconstituées ne sont pas éprouvées au vrai Chromium sur cette machine.',
};

const DECATHLON = 'https://www.decathlon.fr';
const BRICOMARCHE = 'https://www.bricomarche.com';

/** Un PDF minimal, propre à un document : sa mention le distingue des autres. */
function pdfInvente(mention) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${mention}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1'
  );
}

function gabarit(titre, corps, script = '') {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title></head>
<body>${corps}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const VIGNETTE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

// ---------------------------------------------------------------------------
// Decathlon — l'historique et le détail d'un achat
// ---------------------------------------------------------------------------

/** Le menu de gauche de l'espace client, tel que la capture du 05/10 le montre. */
function menuDecathlon() {
  return `<nav aria-label="Mon compte"><ul>
    <li><a href="/account/dashboard">Mon compte</a></li>
    <li><a href="/account/myPurchase">Mon historique d'achats</a></li>
    <li><a href="/account/returns">Retours</a></li>
    <li><a href="/account/returns/create">Créer un retour</a></li>
    <li><a href="/account/addresses">Carnet d'adresses</a></li>
    <li><a href="/logout">Me déconnecter</a></li>
  </ul></nav>`;
}

/**
 * L'historique, PEINT en JavaScript après coup comme le vrai (lot 52) : la
 * coquille arrive vide, la liste se monte 300 ms plus tard.
 */
function historiqueDecathlon(achats) {
  const cartes = achats.map((a) => `
    <article class="my-purchase" aria-labelledby="wef-account-order-${a.numero}">
      <span class="statut" aria-label="Statut de la commande : Terminée">Terminée</span>
      <h3 id="wef-account-order-${a.numero}">Numéro de commande : ${a.numero}</h3>
      <span class="date">${a.dateAffichee}</span>
      <div class="vignettes"><img alt="" src="${VIGNETTE}"></div>
      <p>${a.colis.length} produit(s)</p>
      <p class="montant">0,00 €</p>
      <a class="voir" href="${adresseDetailDecathlon(a)}">Voir les détails</a>
    </article>`).join('');
  const liste = `<h1>Historique de vos achats</h1>
    <section class="encart"><h2>Achats en magasin</h2>
      <button type="button">Ajouter un ticket de caisse</button></section>
    <p role="status">${achats.length} résultat(s)</p>${cartes}`;
  return gabarit('Historique de vos achats', `${menuDecathlon()}<main id="app"></main>`,
    `setTimeout(() => { document.getElementById('app').innerHTML = ${JSON.stringify(liste)}; }, 300);`);
}

function adresseDetailDecathlon(achat) {
  return achat.nature === 'store'
    ? `/account/orderTracking?transactionId=ffffffff-0000-0000-0000-${achat.numero.replace(/\D/g, '').padStart(12, '0')}&type=store`
    : `/account/orderTracking?orderId=${achat.numero}&type=oneom`;
}

const ICONE_TELECHARGEMENT = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M8 1v9M4 7l4 4 4-4M2 14h12"/></svg>';

/**
 * Le bouton de facture d'un colis, selon la variante que l'essai demande. La
 * mécanique de chaque variante est INVENTÉE : personne n'a mesuré ce que fait
 * le vrai bouton (téléchargement ? onglet ? appel ?) — d'où plusieurs.
 */
function boutonFactureDecathlon(achat, rang, variante) {
  const cle = `${achat.numero}-${rang}`;
  switch (variante) {
    case 'telechargement':
      return `<button type="button" class="facture" onclick="location.href='/account/invoice/${cle}.pdf'">${ICONE_TELECHARGEMENT} Télécharger ma facture</button>`;
    case 'onglet':
      return `<button type="button" class="facture" onclick="window.open('/account/invoice/view/${cle}.pdf')">${ICONE_TELECHARGEMENT} Télécharger ma facture</button>`;
    case 'formulaire':
      // Ce que le lot 52 a vu sur un achat en magasin : « Informations
      // client » à valider. Le formulaire s'ouvre dans la page, au clic.
      return `<button type="button" class="facture" onclick="ouvrirFormulaire()">${ICONE_TELECHARGEMENT} Télécharger ma facture</button>`;
    case 'non-pdf':
      return `<button type="button" class="facture" onclick="location.href='/account/invoice/broken/${cle}.pdf'">${ICONE_TELECHARGEMENT} Télécharger ma facture</button>`;
    case 'demander':
      // Le lot 52 : le clic DÉPOSE la demande (« Nous recevons votre facture »).
      return `<button type="button" class="facture" onclick="demanderFacture()">Demander ma facture</button>`;
    case 'grise':
      return `<button type="button" class="facture" disabled>${ICONE_TELECHARGEMENT} Télécharger ma facture</button>`;
    case 'voisin':
      // Un libellé APPROCHANT : il n'est pas le bon, il ne se clique pas.
      return `<button type="button" class="facture" onclick="location.href='/account/invoice/${cle}.pdf'">Télécharger ma facture rectificative</button>`;
    case 'absent':
    default:
      return '';
  }
}

function detailDecathlon(achat) {
  const colis = achat.colis.map((variante, i) => `
    <section class="colis"><h2>Colis ${i + 1}</h2>
      <div class="actions">${boutonFactureDecathlon(achat, i + 1, variante)}
        <button type="button" class="retour" onclick="document.body.dataset.retour = 'oui'">Faire un retour</button>
      </div>
    </section>`).join('');
  const corps = `
    <a href="/account/myPurchase">Retour à l'historique de mes achats</a>
    <h1>Commandé le ${achat.dateAffichee}</h1>
    <p class="numero">Commande n° ${achat.numero}</p>
    ${achat.nature === 'store' ? '<p class="nature">Achat en magasin</p>' : ''}
    ${colis}`;
  const script = `
    function ouvrirFormulaire() {
      const boite = document.createElement('div');
      boite.setAttribute('role', 'dialog');
      boite.setAttribute('aria-modal', 'true');
      boite.innerHTML = '<h2>Informations client</h2><form method="post" action="/account/api/invoice-customer">'
        + '<label>Nom <input name="nom"></label><label>Prénom <input name="prenom"></label>'
        + '<label>Adresse <input name="adresse"></label><button type="submit">Valider</button></form>'
        + '<button type="button">Fermer</button>';
      document.body.appendChild(boite);
    }
    function demanderFacture() {
      fetch('/account/api/invoice-request', { method: 'POST' });
      const boite = document.createElement('div');
      boite.setAttribute('role', 'dialog');
      boite.innerHTML = '<p>Nous recevons votre facture</p><button type="button">Fermer</button>';
      document.body.appendChild(boite);
    }
    setTimeout(() => { document.getElementById('app').innerHTML = ${JSON.stringify(corps)}; }, 300);`;
  return gabarit('Suivi de commande', `${menuDecathlon()}<main id="app"></main>`, script);
}

/**
 * Le faux Decathlon. `achats` : `[{ numero, nature: 'oneom'|'store',
 * dateAffichee, colis: [variante, …], renvoi? }]`.
 */
function siteDecathlon(achats) {
  return async (url, requete) => {
    if (url.pathname === '/account/myPurchase') return { html: historiqueDecathlon(achats) };
    if (url.pathname === '/account/orderTracking') {
      const achat = achats.find((a) => (a.nature === 'store'
        ? adresseDetailDecathlon(a).includes(url.searchParams.get('transactionId') || '§')
        : a.numero === url.searchParams.get('orderId')));
      if (!achat) return { statut: 404, html: gabarit('Introuvable', '<h1>Page introuvable</h1>') };
      // `renvoi` : la session tombe en route — le détail renvoie à la connexion.
      return { html: achat.renvoi ? renvoi('/login') : detailDecathlon(achat) };
    }
    if (url.pathname === '/login') {
      return { html: gabarit('Connexion', '<h1>Connectez-vous</h1><input type="password" name="mdp">') };
    }
    let m = /^\/account\/invoice\/(view\/|broken\/)?([A-Za-z0-9-]+)\.pdf$/.exec(url.pathname);
    if (m) {
      if (m[1] === 'broken/') {
        return {
          corps: Buffer.from('<!doctype html><html><body>Une erreur est survenue</body></html>', 'latin1'),
          entetes: { 'content-type': 'text/html', 'content-disposition': `attachment; filename="facture-${m[2]}.pdf"` },
        };
      }
      return {
        corps: pdfInvente(`facture inventee ${m[2]}`),
        entetes: m[1] === 'view/'
          ? { 'content-type': 'application/pdf' }
          : { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="facture-${m[2]}.pdf"` },
      };
    }
    if (requete.method() !== 'GET') return { statut: 204, html: '' };
    return { statut: 404, html: gabarit('Introuvable', '<h1>Page introuvable</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Bricomarché — « Mes achats », ses deux onglets, la page d'une commande
// ---------------------------------------------------------------------------

/** Le menu de gauche de la capture du 05/10 ; `renomme` change UN signe. */
function menuBricomarche({ renomme = false } = {}) {
  return `<aside class="menu-compte"><nav aria-label="Mon compte"><ul>
      <li><a href="/my-account/orders?choiceOrder=0&historyOrderFilter=all" aria-current="page">${renomme ? 'Mes commandes' : 'Mes achats'}</a></li>
      <li><a href="/my-account/brico-plus">Mon Brico +</a></li>
      <li><a href="/my-account/profile">Mes informations personnelles</a></li>
      <li><a href="/my-account/addresses">Mes adresses</a></li>
      <li><a href="/my-account/communication">Mes préférences de communication</a></li>
    </ul></nav>
    <div class="aide"><h3>Aide &amp; support</h3><a href="/aide-et-contact">Aide &amp; contact</a></div>
    <a href="/logout">Me déconnecter</a></aside>`;
}

/** L'en-tête du site, que le journal du 09/09 a relevé tel quel. */
const ENTETE_BRICOMARCHE = `<header><a href="#contenu">Aller au contenu</a>
  <a href="/fidelite">Ma fidélité</a> <a href="/aide-et-contact">Aide &amp; contact</a>
  <a href="/my-account">Mon compte</a> <a href="/panier">0 Panier</a>
  <a href="/produits">PRODUITS</a> <a href="/bons-plans">BONS PLANS</a></header>`;

/** Une carte de commande en ligne, telle que la capture du 05/10 la décrit. */
function carteEnLigne(c) {
  return `<div class="carte-commande">
      <div class="tete"><span>Commande</span> <a href="/my-account/orders/${c.numero}">${c.numero}</a>
        <span class="etat">Livrée</span><span class="montant">0,00 €</span></div>
      <p>Commande passée en ligne le ${c.dateAffichee}</p>
      <p>Vendue par Bricomarché</p>
      <img alt="" src="${VIGNETTE}">
      <a class="chevron" href="/my-account/orders/${c.numero}" aria-label="Voir le détail de la commande"><span aria-hidden="true">›</span></a>
    </div>`;
}

/**
 * Un achat en magasin — FORME INVENTÉE : aucune capture ne montre l'onglet
 * « En magasin ». On lui donne la forme d'une commande en ligne, avec sa
 * propre phrase de date.
 */
function carteEnMagasin(c) {
  return `<div class="carte-commande">
      <div class="tete"><span>Commande</span> <a href="/my-account/orders/${c.numero}">${c.numero}</a>
        <span class="montant">0,00 €</span></div>
      <p>Achat en magasin le ${c.dateAffichee}</p>
    </div>`;
}

function panneauBricomarche(commandes, nature) {
  if (!commandes.length) {
    return nature === 'magasin'
      ? '<p class="vide">Vous n\'avez aucun achat en magasin pour le moment.</p>'
      : '<p class="vide">Vous n\'avez passé aucune commande en ligne.</p>';
  }
  const parMois = new Map();
  for (const c of commandes) {
    if (!parMois.has(c.mois)) parMois.set(c.mois, []);
    parMois.get(c.mois).push(c);
  }
  return [...parMois].map(([mois, liste]) => `<h3 class="mois">${mois}</h3>`
    + liste.map(nature === 'magasin' ? carteEnMagasin : carteEnLigne).join('')).join('');
}

/**
 * « Mes achats ». `onglets` : `liens` (chaque onglet porte son adresse) ou
 * `boutons` (l'onglet « En magasin » se peint en JavaScript, sans adresse).
 * L'adresse de l'onglet « En magasin » (`choiceOrder=1`) est INVENTÉE : le
 * connecteur la lit dans la page, il ne la devine pas.
 */
function mesAchatsBricomarche(etat, url) {
  const magasin = url.searchParams.get('choiceOrder') === '1';
  // `filtreFige` : le menu reste sur « De 2026 » quoi que dise l'adresse.
  const filtre = etat.filtreFige ? '2026' : (url.searchParams.get('historyOrderFilter') || '2026');
  const titre = etat.titreChange ? 'Historique de mes commandes' : 'Mes achats';
  const lien = (choix) => `/my-account/orders?choiceOrder=${choix}&historyOrderFilter=${filtre}`;
  const onglets = etat.onglets === 'renommes'
    ? `<div role="tablist">
        <a role="tab" href="${lien(0)}" aria-selected="true">Commandes web</a>
        <a role="tab" href="${lien(1)}" aria-selected="false">Achats boutique</a>
      </div>`
    : etat.onglets === 'boutons'
    ? `<div role="tablist">
        <button type="button" role="tab" id="onglet-ligne" aria-selected="true">En ligne</button>
        <button type="button" role="tab" id="onglet-magasin" aria-selected="false" onclick="montrerMagasin()">En magasin</button>
      </div>`
    : `<div role="tablist">
        <a role="tab" href="${lien(0)}" aria-selected="${magasin ? 'false' : 'true'}">En ligne</a>
        <a role="tab" href="${lien(1)}" aria-selected="${magasin ? 'true' : 'false'}">En magasin</a>
      </div>`;
  const select = `<label for="filtre">Afficher</label>
    <select id="filtre" name="historyOrderFilter" onchange="location.search='?choiceOrder=${magasin ? 1 : 0}&historyOrderFilter='+this.value">
      <option value="all"${filtre === 'all' ? ' selected' : ''}>Toutes mes commandes</option>
      <option value="2026"${filtre === '2026' ? ' selected' : ''}>De 2026</option>
      <option value="2025"${filtre === '2025' ? ' selected' : ''}>De 2025</option>
    </select>`;
  // Le filtre « De 2026 » ne montre que l'année en cours : sans « Toutes mes
  // commandes », une commande plus ancienne disparaîtrait de la liste.
  const visibles = (liste) => (filtre === 'all' ? liste : liste.filter((c) => c.dateAffichee.endsWith(filtre)));
  const panneau = panneauBricomarche(visibles(magasin ? etat.enMagasin : etat.enLigne), magasin ? 'magasin' : 'ligne');
  const corps = `${ENTETE_BRICOMARCHE}${menuBricomarche({ renomme: etat.menuRenomme })}
    <main id="contenu"><h1>${titre}</h1>${onglets}${select}
      <section id="panneau" role="tabpanel">${panneau}</section></main>`;
  const script = etat.onglets === 'boutons'
    ? `function montrerMagasin() {
        document.getElementById('onglet-ligne').setAttribute('aria-selected', 'false');
        document.getElementById('onglet-magasin').setAttribute('aria-selected', 'true');
        setTimeout(() => { document.getElementById('panneau').innerHTML = ${JSON.stringify(panneauBricomarche(visibles(etat.enMagasin), 'magasin'))}; }, 200);
      }`
    : '';
  return gabarit(`${titre} | Bricomarché`, corps, script);
}

/** La page d'une commande — FORME INVENTÉE, aucune capture ne la montre. */
function commandeBricomarche(etat, numero) {
  const facture = {
    aucune: '',
    bouton: '<button type="button" class="facture" onclick="document.body.dataset.facture = \'cliquee\'">Télécharger la facture</button>',
    lien: `<a class="facture" href="/my-account/orders/${numero}/invoice.pdf" download>Facture (PDF)</a>`,
  }[etat.factureSurCommande || 'aucune'];
  return gabarit(`Commande ${numero} | Bricomarché`, `${ENTETE_BRICOMARCHE}${menuBricomarche()}
    <main id="contenu"><a href="/my-account/orders?choiceOrder=0&historyOrderFilter=all">Retour à mes achats</a>
      <h1>Commande ${numero}</h1><span class="etat">Livrée</span>
      <table><tr><td>Article d'essai</td><td>× 1</td><td>0,00 €</td></tr>
        <tr><td>Frais de livraison</td><td></td><td>0,00 €</td></tr>
        <tr><td>Total TTC</td><td></td><td>0,00 €</td></tr></table>
      ${facture}</main>`);
}

/**
 * Un renvoi vers `chemin`, fait par la PAGE et pas par une réponse 302.
 *
 * ⚠ Mesuré à l'écriture de ce banc (05/10/2026) : Playwright ne rappelle pas
 * la route pour la suite d'une redirection HTTP servie par `route.fulfill` —
 * la requête suivante part sur le VRAI réseau. Un 302 ici a fait sortir deux
 * lectures anonymes vers le vrai bricomarche.com. Un renvoi par la page crée
 * une navigation nouvelle, que la route attrape ; `fuites` le vérifie.
 */
function renvoi(chemin) {
  return gabarit('Redirection', '', `location.replace(${JSON.stringify(chemin)});`);
}

/** La page de connexion — formulaire Spring Security, relevé au lot 77. */
function connexionBricomarche() {
  return gabarit('S\'Identifier | Bricomarché', `${ENTETE_BRICOMARCHE}<main>
    <h1>S'identifier</h1><form method="post" action="/j_spring_security_check">
      <label>E-mail <input name="j_username" type="email"></label>
      <label>Mot de passe <input name="j_password" type="password"></label>
      <button type="submit">Se connecter</button></form></main>`);
}

/**
 * Le faux Bricomarché. `etat` : `{ enLigne: [...], enMagasin: [...],
 * onglets: 'liens'|'boutons'|'renommes', menuRenomme, titreChange,
 * filtreFige, page: 'achats'|'connexion'|'illisible', factureSurCommande:
 * 'aucune'|'bouton'|'lien' }`.
 */
function siteBricomarche(etat) {
  return async (url, requete) => {
    if (requete.method() !== 'GET') return { statut: 204, html: '' };
    if (url.pathname === '/login') return { html: connexionBricomarche() };
    if (etat.page === 'connexion' && url.pathname.startsWith('/my-account')) {
      return { html: renvoi('/login') };
    }
    // Mesuré le 05/10/2026 (journal de production) : /my-account aboutit désormais
    // sur la liste, avec le seul paramètre `choiceOrder=0`.
    if (url.pathname === '/my-account' || url.pathname === '/my-account/') {
      return { html: renvoi('/my-account/orders?choiceOrder=0') };
    }
    if (url.pathname === '/my-account/orders') {
      if (etat.page === 'illisible') {
        return {
          html: gabarit('Bricomarché', `${ENTETE_BRICOMARCHE}${menuBricomarche()}
            <main id="contenu"><h1>Nouvel espace client</h1><p>Votre espace évolue. Revenez bientôt.</p></main>`),
        };
      }
      return { html: mesAchatsBricomarche(etat, url) };
    }
    const m = /^\/my-account\/orders\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (m) return { html: commandeBricomarche(etat, m[1]) };
    return { statut: 404, html: gabarit('Page non trouvée', '<h1>La page demandée n\'existe pas</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Le navigateur, ses compteurs, et la porte du socle
// ---------------------------------------------------------------------------

/**
 * Ouvre un vrai Chromium dont TOUTES les requêtes passent par `servir` (hôte
 * `www.decathlon.fr` ou `www.bricomarche.com`) ; le reste est avorté.
 *
 * @returns {Promise<{page, contexte, journal: {clics: string[], saisies:
 *   string[], ecritures: string[], avortees: string[], visites: string[],
 *   fuites: string[]},
 *   fermer: () => Promise<void>}>}
 */
async function ouvrirFauxSite(hote, servir) {
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  const contexte = await navigateur.newContext(identity.optionsContexte({ acceptDownloads: true }));
  const journal = { clics: [], saisies: [], ecritures: [], avortees: [], visites: [], fuites: [] };
  // Toute requête qui continue une redirection n'est PAS passée par la route
  // (voir `renvoi`) : elle serait partie sur le vrai réseau. Le banc n'en
  // produit plus ; chaque essai vérifie que cette liste reste vide.
  contexte.on('request', (requete) => {
    if (requete.redirectedFrom()) journal.fuites.push(requete.url());
  });
  // Et le second filet : une réponse servie par la route n'a pas d'adresse de
  // serveur. Une réponse qui en a une est venue du vrai réseau.
  contexte.on('response', async (reponse) => {
    const serveur = await reponse.serverAddr().catch(() => null);
    if (serveur) journal.fuites.push(reponse.url());
  });

  await contexte.exposeBinding('__crabeClic', (_source, libelle) => { journal.clics.push(String(libelle)); });
  await contexte.exposeBinding('__crabeSaisie', (_source, quoi) => { journal.saisies.push(String(quoi)); });
  await contexte.addInitScript(() => {
    const libelle = (el) => String((el && (el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || el.tagName)) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
    document.addEventListener('click', (e) => {
      const cible = (e.target && e.target.closest && e.target.closest('a, button, [role="button"], [role="tab"], input, summary')) || e.target;
      try { window.__crabeClic(libelle(cible)); } catch { /* liaison absente */ }
    }, true);
    for (const type of ['input', 'change']) {
      document.addEventListener(type, (e) => {
        try { window.__crabeSaisie(`${type}:${(e.target && (e.target.name || e.target.tagName)) || '?'}`); } catch { /* */ }
      }, true);
    }
    document.addEventListener('submit', () => { try { window.__crabeSaisie('submit'); } catch { /* */ } }, true);
  });

  await contexte.route('**/*', async (route) => {
    const requete = route.request();
    let url;
    try { url = new URL(requete.url()); } catch { return route.abort(); }
    if (url.host !== hote) {
      journal.avortees.push(url.host);
      return route.abort();
    }
    if (requete.method() !== 'GET') journal.ecritures.push(`${requete.method()} ${url.pathname}`);
    if (requete.resourceType() === 'document') journal.visites.push(`${url.pathname}${url.search}`);
    const r = await servir(url, requete);
    return route.fulfill({
      status: r.statut || 200,
      headers: r.entetes || { 'content-type': 'text/html; charset=utf-8' },
      body: r.corps !== undefined ? r.corps : (r.html || ''),
    });
  });

  const page = await contexte.newPage();
  page.setDefaultTimeout(15_000);
  return {
    page,
    contexte,
    journal,
    fermer: async () => { await navigateur.close().catch(() => {}); },
  };
}

/**
 * Remplace la porte du socle le temps d'un essai : au lieu d'ouvrir le profil
 * persistant sous Xvfb, le connecteur reçoit la page du faux site, déjà
 * conduite à `urlDepart`. `socle: true` passe par le VRAI `atteindreLaPage`
 * (relecture unique, renvoi vers l'authentification) — il attend
 * `DELAI_RENDU_MS` à chaque lecture, on ne le prend que quand l'essai en a
 * besoin.
 */
async function surLeFauxProfil(site, corps, { socle = false } = {}) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => {
    if (socle) {
      await profilMarchand.atteindreLaPage(site.page, {
        id: options.id,
        nom: options.nom,
        log: options.ctx?.log || (() => {}),
        urlDepart: options.urlDepart,
        estAuthentification: options.estAuthentification,
      });
    } else {
      await site.page.goto(options.urlDepart, { waitUntil: 'domcontentloaded' }).catch(() => {});
      // Un renvoi fait par la page se termine après le premier chargement.
      await site.page.waitForLoadState('networkidle').catch(() => {});
    }
    (options.ctx?.log || (() => {}))(`${options.id} : page atteinte (${site.page.url()}).`);
    return fn(site.page, site.contexte);
  };
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

/** Un contexte d'exécution qui garde le journal et la preuve de liste. */
function contexteEnregistreur(extra = {}) {
  const lignes = [];
  const preuves = [];
  return {
    lignes,
    preuves,
    ctx: {
      userId: 1,
      log: (m) => lignes.push(String(m)),
      preuveDeListe: (p) => preuves.push(p),
      knownRemoteIds: [],
      ...extra,
    },
  };
}

module.exports = {
  PLAYWRIGHT,
  SANS_NAVIGATEUR,
  DECATHLON,
  BRICOMARCHE,
  pdfInvente,
  siteDecathlon,
  siteBricomarche,
  adresseDetailDecathlon,
  ouvrirFauxSite,
  surLeFauxProfil,
  contexteEnregistreur,
};
