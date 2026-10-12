'use strict';

/**
 * Lot 104 — Battle.net, Alma et Private Sport Shop, RECONSTITUÉS, servis à un
 * vrai Chromium sans que rien ne sorte de la machine.
 *
 * ─── D'où vient leur forme ───────────────────────────────────────────────────
 *
 * Le 11/10/2026, l'utilisateur a enregistré, connecté, le code source des pages des
 * trois sites ; le prompt du lot 104 en a repris la STRUCTURE (§2), sans
 * aucune donnée : repères, `data-testid`, textes des libellés, formes des
 * adresses. Tout le reste est INVENTÉ et dit comme tel :
 *
 *   - le dessin par script et ses délais (les trois sites sont des
 *     applications Vue ou React) ;
 *   - la page de connexion de chacun (un champ de mot de passe) ;
 *   - ce que font « Suivant » (re-dessine le tableau), « Télécharger le reçu »
 *     et le choix d'une facture (un onglet ouvert droit sur le PDF — mesuré au
 *     lot 102 : sans écran, il arrive comme un téléchargement de la page) ;
 *   - les pièges : liens et boutons interdits VISIBLES à côté de ce qui est
 *     permis (payer, panier, retour, déconnexion, abonnement, moyens de
 *     paiement, rééchelonner), une ligne d'échéance non payée, une option
 *     d'un autre type.
 *
 * Une page reconstituée prouve que le connecteur LIT cette forme. Elle ne
 * prouve rien du vrai site.
 *
 * ─── La mécanique : celle des lots 92, 99 et 102 ─────────────────────────────
 *
 * Chaque contexte créé par le connecteur est branché sur le banc par
 * `context.route('**\/*')` : les hôtes déclarés sont servis depuis la mémoire,
 * toute autre requête est AVORTÉE ; aucune réponse n'est une redirection HTTP
 * (les renvois se font par la page) ; deux filets (`fuites`). Chaque clic, chaque
 * choix dans une liste et chaque saisie sont rapportés par la page elle-même.
 *
 * ⚠ Toutes les valeurs sont inventées et visiblement fausses : commandes
 * « ZZ9… », factures « 99… », identifiants « ZZessai… », montants « 0,00 € »,
 * joueur « JoueurEssai#0000 », courriel « essai@exemple.invalid ».
 */

const faux92 = require('./lot92-faux-sites');
const faux99 = require('./lot99-faux-sites');

const { PLAYWRIGHT, SANS_NAVIGATEUR, pdfInvente } = faux92;
const { COOKIE } = faux99;

const BNET = 'account.battle.net';
const ALMA = 'portal.getalma.eu';
const ALMA_API = 'api.getalma.eu';
const PSS = 'www.privatesportshop.fr';
const PSS_API = 'api.sportpursuit.com';
const PSS_PANIER = 'checkout.privatesportshop.fr';
/** Un domaine qui n'est d'aucun des trois sites — inventé, servi par le banc. */
const AILLEURS = 'documents.exemple.invalid';

const JOUEUR = 'JoueurEssai#0000';
const COURRIEL = 'essai@exemple.invalid';

const sessionInventee = (hote) => faux99.sessionInventee(hote);

async function sessionPortee(requete) {
  try {
    const entetes = await requete.allHeaders();
    return String(entetes.cookie || '').split(/;\s*/).includes(`${COOKIE.name}=${COOKIE.value}`);
  } catch {
    return false;
  }
}

function echapper(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function gabarit(titre, corps, { script = '', body = '' } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title></head>
<body${body}>${corps}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** Un renvoi fait par la PAGE, jamais par une réponse 3xx (lot 92). */
function renvoi(adresse) {
  return gabarit('Redirection', '', { script: `location.replace(${JSON.stringify(adresse)});` });
}

function pageConnexion(titre) {
  return gabarit(titre, `<h1>Connexion</h1><form method="post" action="/login"><label>Adresse e-mail <input type="email" name="email"></label>
    <label>Mot de passe <input type="password" name="password"></label><button type="submit">Se connecter</button></form>`);
}

/** Les pièges se signalent eux-mêmes au banc, quel que soit le site. */
const SIGNALER = `
  const signaler = (quoi) => fetch('/__banc/piege?quoi=' + encodeURIComponent(quoi)).catch(() => {});
  document.addEventListener('click', (e) => {
    const p = e.target && e.target.closest ? e.target.closest('[data-piege]') : null;
    if (p) { e.preventDefault(); signaler(p.getAttribute('data-piege')); }
  }, true);`;

// ---------------------------------------------------------------------------
// Battle.net
// ---------------------------------------------------------------------------

/** Douze achats inventés (deux pages de dix), du plus récent au plus ancien. */
function compteBnet(extra = {}) {
  const dates = ['3 mars 2026', '14 févr. 2026', '2 janv. 2026', '19 déc. 2025', '8 nov. 2025', '21 oct. 2025',
    '30 sept. 2025', '12 août 2025', '1 juil. 2025', '17 juin 2025', '5 mai 2025', '9 avr. 2025'];
  return {
    connecte: true,
    suivant: 'normal', // 'normal' | 'identique' | 'partout' (un lien « Suivant » même sur la dernière page)
    delaiDessinMs: 300,
    achats: dates.map((date, i) => ({
      commande: `ZZ9${String(i + 1).padStart(8, '0')}`,
      facture: `99${String(i + 1).padStart(8, '0')}`,
      date,
      gratuit: i === 4,
    })),
    ...extra,
  };
}

function enteteBnet() {
  // L'attribut `user` porte le BattleTag et le courriel, comme sur le vrai site — inventés ici.
  const user = echapper(JSON.stringify({ battleTag: JOUEUR, email: COURRIEL }));
  return `<header class="header"><blz-nav-battlenet role="navigation" authenticated="" user="${user}">
      <span class="nav-joueur">${JOUEUR}</span>
      <a href="https://shop.battle.net/fr-fr" data-piege="boutique">Boutique</a>
      <a href="/logout" data-piege="déconnexion">Se déconnecter</a></blz-nav-battlenet></header>`;
}

function navigationLateraleBnet() {
  return `<ul class="nav">
      <li><a href="/overview" data-piege="résumé">Résumé du compte</a></li>
      <li><a href="/games" data-piege="abonnements">Jeux et abonnements</a></li>
      <li><a href="/payment" data-piege="moyens de paiement">Moyens de paiement</a></li>
      <li><a class="router-link-active" href="/transactions">Historique des achats</a></li></ul>`;
}

function pageListeBnet(etat) {
  const achats = etat.achats.map((a) => ({ ...a, total: a.gratuit ? '0 ¤' : '0,00 €' }));
  const corps = `${enteteBnet()}
    <main class="main-container"><section class="main-side-navigation-section">${navigationLateraleBnet()}</section>
    <section class="main-content-section"><div class="transactions-overview">
      <div class="title-bar"><h1>Historique des achats</h1></div>
      <div class="meka-tab"><button class="meka-tab__inner meka-tab__inner--selected">Achats</button>
        <button class="meka-tab__inner" data-piege="onglet cadeaux">Cadeaux récupérés</button>
        <button class="meka-tab__inner" data-piege="onglet porte-monnaie">Porte-monnaie virtuel</button></div>
      <form><label for="transaction-table-region-select">Région</label>
        <select id="transaction-table-region-select" data-piege="région"><option value="1">Amériques</option><option value="2" selected>Europe</option><option value="3">Asie</option></select></form>
      <div id="zone"></div>
      <div class="table-states-container" style="display:none">Rien à afficher.</div>
    </div></section></main>
    <div class="loading-overlay"></div>`;
  const script = `${SIGNALER}
    (function () {
      const ACHATS = ${JSON.stringify(achats)};
      // Lot 105 — sur la page 2 (et suivantes), les liens de détail portent
      // une requête (INVENTÉE : sa vraie forme n'est pas mesurée) ; et des
      // lignes d'une autre forme peuvent s'y ajouter.
      const REQUETE = ${JSON.stringify(etat.requetePage2 || '')};
      const AUTRES = ${JSON.stringify(etat.autresLiensPage2 || [])};
      const PAR_PAGE = 10;
      const N = Math.ceil(ACHATS.length / PAR_PAGE);
      let p = 0;
      const zone = document.getElementById('zone');
      const overlay = document.querySelector('.loading-overlay');
      function li(texte, lien, courant) {
        return '<li class="' + (courant ? 'current-page' : '') + '" role="none presentation">'
          + (lien ? '<a role="menuitem" href="#">' + texte + '</a>' : '<span>' + texte + '</span>') + '</li>';
      }
      function dessiner() {
        const lignes = ACHATS.slice(p * PAR_PAGE, (p + 1) * PAR_PAGE).map((a) => '<tr class="hoverable"><td>' + a.date
          + '</td><td><span class="blz-truncate-2">Article d\\'essai</span></td><td>' + a.total + '</td><td><span title="Terminé">Terminé</span></td>'
          + '<td><a class="d-none d-md-block" href="/transactions/' + a.commande + '/' + a.facture + (p > 0 ? REQUETE : '') + '">' + a.commande + '</a></td></tr>').join('')
          + (p > 0 ? AUTRES.map((x) => '<tr class="hoverable"><td>1 avr. 2025</td><td><span class="blz-truncate-2">Article d\\'essai</span></td><td>0,00 €</td>'
            + '<td><span title="Terminé">Terminé</span></td><td><a class="d-none d-md-block" href="' + x.href + '">' + x.texte + '</a></td></tr>').join('') : '');
        let pages = li('«', p > 0) + li('Précédent', p > 0);
        for (let i = 0; i < N; i++) pages += li(String(i + 1), true, i === p);
        const dernier = p >= N - 1;
        pages += li('Suivant', !dernier || ${JSON.stringify(etat.suivant)} === 'partout') + li('»', !dernier);
        zone.innerHTML = '<div class="account-table-container"><div class="transactions-table"><table class="table"><thead><tr>'
          + '<th>Date</th><th>Achat</th><th>Total</th><th>Statut</th><th>Numéro de commande</th></tr></thead><tbody>' + lignes
          + '</tbody></table> <ul role="menubar">' + pages + '</ul></div></div>';
      }
      zone.addEventListener('click', (e) => {
        const a = e.target.closest('a[role="menuitem"]');
        if (!a) return;
        e.preventDefault();
        const t = a.textContent.trim();
        overlay.className = 'loading-overlay';
        setTimeout(() => {
          if (t === 'Suivant' && ${JSON.stringify(etat.suivant)} !== 'identique' && p < N - 1) p += 1;
          else if (/^\\d+$/.test(t)) p = Number(t) - 1;
          else if (t === 'Précédent' || t === '«') p = 0;
          else if (t === '»') p = N - 1;
          dessiner();
          overlay.className = 'loading-overlay hide';
        }, 300);
      });
      setTimeout(() => { dessiner(); overlay.className = 'loading-overlay hide'; }, ${Number(etat.delaiDessinMs) || 0});
    })();`;
  return gabarit('Compte Battle.net', corps, { script });
}

/**
 * Le détail d'un achat. La structure de la carte est celle MESURÉE sur la page
 * enregistrée (lot 105) : `div[data-placeholder-id]` de classe vide une fois
 * dessinée, libellé `div.order-text-label` puis, frère suivant, un `div` qui
 * contient `span.blz-text-capitalize-first` — classe que porte AUSSI la valeur
 * du statut.
 *
 * Lot 105 — deux pièges, INVENTÉS dans leur forme (non mesurée) :
 *   - `etat.detailProvisoireMs` : la carte paraît d'abord PROVISOIRE — titre
 *     « Commande #… » déjà là (il vient de l'adresse), corps en attente
 *     (`placeholder-glow`, valeurs vides en `span.placeholder`) —, puis la
 *     carte réelle après ce délai ;
 *   - `etat.ordreDetail === 'statut-avant'` : la ligne du statut AVANT celle
 *     du numéro, pour qu'un lecteur « par la classe » lise « Terminé » ;
 *   - `etat.factureDecalee` : la carte DESSINÉE montre un autre numéro que
 *     l'adresse (un vrai écart) ; `etat.toujoursProvisoire` : la carte ne
 *     sort jamais de son état provisoire.
 */
function pageDetailBnet(etat, achat) {
  const corps = `${enteteBnet()}
    <main class="main-container"><section class="main-side-navigation-section">${navigationLateraleBnet()}</section>
    <section class="main-content-section" id="contenu"></section></main><div class="loading-overlay"></div>`;
  const ligneFacture = (valeur) => `<div class="row g-1"><div class="col-12 col-md-6"><div class="row g-0 flex-row text-md-end">
      <div class="col-12 col-md-6 offset-md-6 order-text-label idty-body-small">Numéro de facture</div>
      <div class="col-12 col-md-6 order-text-label idty-body-small">${valeur}</div></div></div></div>`;
  const ligneStatut = (valeur) => `<div class="row g-1 justify-content-md-between"><div class="col-12 col-md-6"><div class="row flex-row g-0">
      <div class="col-12 col-md-6 order-text-label idty-body-small">Statut de la commande</div>
      <div class="col-12 col-md-6 order-text-data idty-body-small">${valeur}</div></div></div></div>`;
  const carteDe = (provisoire) => {
    const affichee = etat.factureDecalee ? achat.facture.replace(/^99/, '98') : achat.facture;
    const valeurFacture = provisoire ? '<span class="placeholder col-6"></span>' : `<span class="blz-text-capitalize-first">${affichee}</span>`;
    const valeurStatut = provisoire ? '<span class="placeholder col-4"></span>' : '<span class="blz-text-capitalize-first">Terminé</span>';
    const lignes = etat.ordreDetail === 'statut-avant'
      ? ligneStatut(valeurStatut) + ligneFacture(valeurFacture)
      : ligneFacture(valeurFacture) + ligneStatut(valeurStatut);
    return `<div class="title-bar"><h1>Détails de la commande</h1></div>
    <a href="/transactions">Retour aux transactions du compte</a>
    <div class="blz-card mt-3"><div class="blz-card-header"><div class="header-content"><h2>
      Commande #${achat.commande}
    </h2></div></div>
    <div class="blz-card-body"><div class="${provisoire ? 'placeholder-glow' : ''}" data-placeholder-id="placeholder-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa">
    <div class="row g-1"><div class="col-12 col-md-6"><div class="row g-0 flex-row"><div class="col-12 col-md-6 order-text-label idty-body-small">Date de la commande</div>
      <div class="col-12 col-md-auto order-text-data idty-body-small">${provisoire ? '<span class="placeholder col-5"></span>' : achat.date}</div></div></div></div>
    ${lignes}
    <div>Article d'essai — 0,00 €</div><div>Total 0,00 € — Toutes taxes comprises</div><div>Paiement(s) : moyen d'essai 0,00 €</div>
    <a href="/support/commander" data-piege="commander à nouveau">Commander à nouveau</a></div></div></div>`;
  };
  const provisoireMs = Number(etat.detailProvisoireMs) || 0;
  const script = `${SIGNALER}
    setTimeout(() => {
      const contenu = document.getElementById('contenu');
      ${etat.toujoursProvisoire ? `contenu.innerHTML = ${JSON.stringify(carteDe(true))};
      document.querySelector('.loading-overlay').className = 'loading-overlay hide';`
    : provisoireMs ? `contenu.innerHTML = ${JSON.stringify(carteDe(true))};
      // Le voile de chargement est déjà levé : c'est la carte qui attend (piège).
      document.querySelector('.loading-overlay').className = 'loading-overlay hide';
      setTimeout(() => { contenu.innerHTML = ${JSON.stringify(carteDe(false))}; }, ${provisoireMs});`
    : `contenu.innerHTML = ${JSON.stringify(carteDe(false))};
      document.querySelector('.loading-overlay').className = 'loading-overlay hide';`}
    }, ${Number(etat.delaiDessinMs) || 0});`;
  return gabarit('Compte Battle.net', corps, { script });
}

function siteBnet(etat) {
  etat.compteurs = { listes: 0, details: [], requetesDetail: [], pieges: [], interdits: [], connexions: 0 };
  return async (url, requete) => {
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresDetails) && etat.compteurs.details.length >= etat.sessionMeurtApresDetails);
    if (url.pathname === '/__banc/piege') {
      etat.compteurs.pieges.push(url.searchParams.get('quoi'));
      return { statut: 204, html: '' };
    }
    if (url.pathname === '/transactions') {
      etat.compteurs.listes += 1;
      if (!vivante) return { html: renvoi('/login/fr/?ref=transactions') };
      return { html: pageListeBnet(etat) };
    }
    const m = /^\/transactions\/([A-Z0-9]+)\/(\d+)$/.exec(url.pathname);
    if (m) {
      if (!vivante) return { html: renvoi('/login/fr/?ref=transactions') };
      const achat = etat.achats.find((a) => a.commande === m[1] && a.facture === m[2]);
      if (!achat) return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
      etat.compteurs.details.push(achat.facture);
      etat.compteurs.requetesDetail.push(url.search);
      return { html: pageDetailBnet(etat, etat.detailAutre ? { ...achat, commande: 'ZZ900000099' } : achat) };
    }
    if (/^\/login/.test(url.pathname)) {
      etat.compteurs.connexions += 1;
      return { html: pageConnexion('Connexion Battle.net') };
    }
    etat.compteurs.interdits.push(url.pathname);
    return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Alma
// ---------------------------------------------------------------------------

const COMPTE_ALMA = 'customer_account_ZZessaiCompte01';

/**
 * Deux achats inventés : un EN COURS (trois échéances, deux payées, une à
 * venir), un TERMINÉ à cheval sur deux années (deux échéances payées).
 */
function compteAlma(extra = {}) {
  return {
    connecte: true,
    variante: 'telechargement', // 'telechargement' | 'non-pdf' | 'ailleurs' | 'rien'
    delaiDessinMs: 300,
    achats: [
      {
        id: 'payment_ZZessaiAchat01', liste: 'en cours', dateAchat: '10 mars 2026',
        echeances: [
          { id: 'installment_ZZessaiEch0101', date: '10 mars', paye: true },
          { id: 'installment_ZZessaiEch0102', date: '10 avril', paye: true },
          { id: 'installment_ZZessaiEch0103', date: '10 mai', paye: false },
        ],
      },
      {
        id: 'payment_ZZessaiAchat02', liste: 'terminés', dateAchat: '20 décembre 2025',
        echeances: [
          { id: 'installment_ZZessaiEch0201', date: '20 décembre', paye: true },
          { id: 'installment_ZZessaiEch0202', date: '20 janvier', paye: true },
        ],
      },
    ],
    ...extra,
  };
}

function enteteAlma() {
  return `<header data-testid="header"><div><button data-testid="account-logged-in-button" type="button"><div>E</div><div>Essai</div></button>
    <a href="/logout" data-piege="déconnexion">Se déconnecter</a></div></header>`;
}

function pageCompteAlma(etat) {
  const cartes = etat.achats.map((a) => ({ id: a.id, liste: a.liste }));
  const corps = `<div id="root">${enteteAlma()}<h1>Bonjour Essai</h1>
    <div class="_tabContainer_x"><div class="_singleLabel_x _active_x" role="button" tabindex="0"><div>Achats en cours</div></div>
      <div class="_singleLabel_x" role="button" tabindex="0"><div>Achats terminés</div></div></div>
    <div id="liste"></div>
    <a href="https://help.almapay.com/hc/fr" data-piege="aide">Aide</a></div>`;
  const script = `${SIGNALER}
    (function () {
      const CARTES = ${JSON.stringify(cartes)};
      let actif = 'en cours';
      const liste = document.getElementById('liste');
      function dessiner() {
        const ici = CARTES.filter((c) => c.liste === actif);
        liste.innerHTML = ici.length
          ? ici.map((c) => '<div class="_card_x" data-testid="customer-portal-card-' + c.id + '"><span>Commerçant d\\'essai</span><span>0,00 €</span>'
            + '<span>Terminé le 1 janvier 2026</span></div>').join('')
          : '<img data-testid="customer-portal-no-payments-found" alt="" style="width:10px;height:10px"><span>Vous n’avez aucun achat en cours</span>';
      }
      for (const onglet of document.querySelectorAll('div[role="button"]')) {
        onglet.addEventListener('click', () => {
          actif = onglet.textContent.trim() === 'Achats terminés' ? 'terminés' : 'en cours';
          liste.innerHTML = '';
          setTimeout(dessiner, 200);
        });
      }
      setTimeout(dessiner, ${Number(etat.delaiDessinMs) || 0});
    })();`;
  return gabarit('Payer avec Alma', corps, { script });
}

function pageAchatAlma(etat, achat) {
  const lignes = achat.echeances.map((e) => `<div class="_paymentScheduleLine_x" role="button" tabindex="0" data-testid="payment-schedule-line-${e.id}">
      <div class="_middle_x"><div class="_date_x">${e.date}</div><div>0,00 €</div></div>
      <div class="_right_x"><div class="_badge_x"><span>${e.paye ? 'Payé' : 'À venir'}</span></div></div></div>`).join('');
  const contenu = `<h1>Votre achat en <strong>${achat.echeances.length}x</strong> chez Commerçant d'essai</h1>
    <button type="button" data-piege="payer maintenant">Payer maintenant</button>
    <button type="button" data-piege="rééchelonner">Modifier mes échéances</button>
    <section data-testid="schedule"><h4>Vos prélèvements</h4><div data-testid="schedule-lines-container">${lignes}</div></section>
    <div data-testid="purchase-detail"><h4>Détails de l'achat</h4>
      <span><div><span><span>Commerçant</span></span><div>Commerçant d'essai</div></div></span>
      <span><div><span>Date</span><div><div>${achat.dateAchat}</div></div></div></span>
      <span><div><span>Référence</span><div>ZZREF</div></div></span></div>
    <a href="https://help.almapay.com/hc/fr" data-piege="aide retour">Demander un retour</a>`;
  const echeances = achat.echeances;
  const script = `${SIGNALER}
    (function () {
      const ECHEANCES = ${JSON.stringify(echeances)};
      const VARIANTE = ${JSON.stringify(etat.variante)};
      setTimeout(() => {
        document.getElementById('contenu').innerHTML = ${JSON.stringify(contenu)};
        for (const ligne of document.querySelectorAll('[data-testid^="payment-schedule-line-"]')) {
          ligne.addEventListener('click', () => ouvrir(ECHEANCES.find((e) => 'payment-schedule-line-' + e.id === ligne.getAttribute('data-testid'))));
        }
      }, ${Number(etat.delaiDessinMs) || 0});
      function fermer() { const m = document.getElementById('fenetre'); if (m) m.remove(); document.body.className = ''; }
      function ouvrir(e) {
        setTimeout(() => {
          const m = document.createElement('div');
          m.id = 'fenetre';
          m.className = 'ReactModal__Overlay';
          m.innerHTML = '<div class="ReactModal__Content" role="dialog" data-testid="reactModal" tabindex="-1">'
            + '<button data-testid="modal-close-button" aria-label="Close">×</button>'
            + '<div><span>' + (e.paye ? 'Payé' : 'À venir') + '</span></div>'
            + '<span data-testid="payment-card-next-installment-date">' + e.date + '</span><span>0,00 €</span>'
            + (e.paye
              ? '<div>Nous avons prélevé automatiquement cette somme, vous trouverez votre reçu ci-dessous.</div>'
                + '<button data-testid="download-receipt" type="button"><span><span>Télécharger le reçu</span></span></button>'
                + '<a href="/payment-methods" data-piege="moyens de paiement">Changer de moyen de paiement</a>'
              : '<button type="button" data-piege="payer l\\'échéance">Payer maintenant</button>')
            + '</div>';
          document.body.appendChild(m);
          document.body.className = 'ReactModal__Body--open';
          m.querySelector('[data-testid="modal-close-button"]').addEventListener('click', () => setTimeout(fermer, 150));
          const bouton = m.querySelector('[data-testid="download-receipt"]');
          if (bouton) bouton.addEventListener('click', () => {
            if (VARIANTE === 'telechargement') window.open('https://${ALMA_API}/v1/installments/' + e.id + '/receipt');
            else if (VARIANTE === 'non-pdf') window.open('https://${ALMA_API}/v1/installments/' + e.id + '/receipt?casse=1');
            else if (VARIANTE === 'ailleurs') window.open('https://${AILLEURS}/recu.pdf');
          });
        }, 200);
      }
    })();`;
  return gabarit(`Payer en ${echeances.length} fois avec Alma`, `<div id="root">${enteteAlma()}<main id="contenu"></main></div>`, { script });
}

// ---------------------------------------------------------------------------
// Alma — lot 105 : le choix de la lettre, la session dans le stockage
// ---------------------------------------------------------------------------

/** La clé et la valeur INVENTÉES du stockage de session du portail (lot 105). */
const STOCKAGE_ALMA = Object.freeze({
  name: 'customer-portal-session',
  value: JSON.stringify({ accessToken: 'ZZjetonEssai', customerAccountExternalId: COMPTE_ALMA }),
});

/** Une session inventée PORTANT le stockage de session du portail (lot 105). */
function sessionAvecStockage({ entrees = [STOCKAGE_ALMA] } = {}) {
  const etat = JSON.parse(faux99.sessionInventee(ALMA));
  etat.stockageDeSession = [{ origine: `https://${ALMA}`, entrees: entrees.map((e) => ({ ...e })) }];
  return JSON.stringify(etat);
}

/**
 * La page du choix de la lettre d'information — structure MESURÉE sur la page
 * enregistrée le 12/10/2026 (`h1` « Bienvenue sur votre portail Alma », carte
 * « Restez au courant des bons plans », deux `button[type=button]`, le
 * sélecteur de langue) ; les classes générées et les textes longs sont
 * inventés. « Je m'inscris » et la langue sont des PIÈGES : un clic se compte.
 * « Non merci » renvoie, par la page, vers le compte (inventé : la vraie suite
 * n'est pas mesurée).
 */
function pageChoixLettreAlma(etat) {
  const chargeur = Number(etat.chargeurMs) || 0;
  const corps = `${chargeur ? '<div id="initial-loader" class="initial-loader" style="position:fixed;inset:0;background:#fff;z-index:9"><svg width="10" height="10"></svg></div>' : ''}
    <div id="root"><div class="_container_x"><div class="_container_y"><div><h1 class="_header_y">Bienvenue sur votre portail Alma</h1>
    <div class="_list_y"><div>Décalez vos mensualités</div><div>Payez en avance</div><div>Changez votre méthode de paiement</div></div></div></div>
    <div class="_card_z"><div class="_container_w"><span><h3 class="_title_w">Restez au courant des bons plans</h3>
      <span>Abonnez-vous à notre lettre d'information (texte inventé).</span></span>
      <span><div><span>Pas de spam</span></div><div><span>Modifiable à tout moment</span></div></span>
      <span class="_buttons_w"><button class="_button_v _secondary_v" type="button" id="non-merci"><span>Non merci</span></button>
      <button class="_button_v" type="button" data-piege="je m'inscris"><span>Je m'inscris</span></button></span></div></div>
    <div data-testid="language-selector"><div role="combobox" aria-label="Language selector" data-piege="langue">FR</div></div></div></div>`;
  const script = `${SIGNALER}
    ${chargeur ? `setTimeout(() => { const l = document.getElementById('initial-loader'); if (l) l.remove(); }, ${chargeur});` : ''}
    document.getElementById('non-merci').addEventListener('click', () => {
      fetch('/__banc/choix-lettre?reponse=non').catch(() => {}).then(() => setTimeout(() => location.replace('/account/${COMPTE_ALMA}'), 150));
    });`;
  return gabarit('Payer avec Alma', corps, { script });
}

/** En mode « stockage », chaque page du portail vérifie d'abord le stockage de session (inventé). */
function gardeDuStockage(html) {
  const garde = `<script>if (sessionStorage.getItem(${JSON.stringify(STOCKAGE_ALMA.name)}) !== ${JSON.stringify(STOCKAGE_ALMA.value)}) `
    + '{ document.documentElement.innerHTML = \'\'; location.replace(\'/login\'); }</script>';
  return String(html).replace('<body>', `<body>${garde}`);
}

function siteAlma(etat) {
  etat.compteurs = { comptes: 0, achats: [], recus: [], pieges: [], interdits: [], ailleurs: [], connexions: 0, choix: [] };
  return async (url, requete) => {
    if (url.host === AILLEURS) {
      etat.compteurs.ailleurs.push(url.pathname);
      return { corps: pdfInvente('reçu d\'un autre domaine'), entetes: { 'content-type': 'application/pdf' } };
    }
    if (url.host === ALMA_API) {
      const m = /^\/v1\/installments\/(installment_[A-Za-z0-9]+)\/receipt$/.exec(url.pathname);
      if (!m) return { statut: 404, html: '' };
      etat.compteurs.recus.push(m[1]);
      etat.surPdf?.(etat.compteurs.recus.length);
      if (url.searchParams.get('casse')) {
        return { corps: Buffer.from('erreur inventée, pas un PDF'), entetes: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="recu.pdf"' } };
      }
      return { corps: pdfInvente(`recu invente alma ${m[1]}`), entetes: { 'content-type': 'application/pdf' } };
    }
    // Lot 105 — `sessionDans: 'stockage'` : la session ne vit QUE dans le
    // stockage de session du portail (comme sur le vrai, mesuré) ; le cookie
    // ne compte pas, chaque page vérifie elle-même le stockage.
    const parStockage = etat.sessionDans === 'stockage';
    const vivante = etat.connecte && (parStockage || await sessionPortee(requete))
      && !(Number.isFinite(etat.sessionMeurtApresRecus) && etat.compteurs.recus.length >= etat.sessionMeurtApresRecus);
    const servie = (html) => ({ html: parStockage ? gardeDuStockage(html) : html });
    if (url.pathname === '/__banc/piege') {
      etat.compteurs.pieges.push(url.searchParams.get('quoi'));
      return { statut: 204, html: '' };
    }
    if (url.pathname === '/__banc/choix-lettre') {
      etat.compteurs.choix.push(url.searchParams.get('reponse'));
      return { statut: 204, html: '' };
    }
    if (url.pathname === '/') {
      if (!vivante) return { html: renvoi('/login') };
      // Lot 105 — le choix de la lettre, tant qu'il n'a pas reçu de réponse
      // (ou toujours, `choixRevient`).
      if (etat.choixLettre && (etat.choixRevient || !etat.compteurs.choix.length)) return servie(renvoi('/login/marketing-optin'));
      return servie(renvoi(`/account/${COMPTE_ALMA}`));
    }
    if (url.pathname === '/login/marketing-optin') {
      if (!vivante) return { html: renvoi('/login') };
      return servie(pageChoixLettreAlma(etat));
    }
    if (url.pathname === `/account/${COMPTE_ALMA}`) {
      etat.compteurs.comptes += 1;
      if (!vivante) return { html: renvoi('/login') };
      if (etat.choixLettre && etat.choixRevient) return servie(renvoi('/login/marketing-optin'));
      return servie(pageCompteAlma(etat));
    }
    const achat = etat.achats.find((a) => url.pathname === `/${a.id}`);
    if (achat) {
      etat.compteurs.achats.push(achat.id);
      if (!vivante) return { html: renvoi('/login') };
      return servie(pageAchatAlma(etat, achat));
    }
    if (url.pathname === '/login') {
      etat.compteurs.connexions += 1;
      return { html: pageConnexion('Payer avec Alma') };
    }
    etat.compteurs.interdits.push(url.pathname);
    return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Private Sport Shop
// ---------------------------------------------------------------------------

/** Trois commandes inventées, quatre options dont une d'un autre type. */
function comptePss(extra = {}) {
  return {
    connecte: true,
    variante: 'telechargement', // 'telechargement' | 'non-pdf' | 'ailleurs'
    delaiDessinMs: 300,
    commandes: [
      { numero: '90000001', date: '14 décembre 2025', options: [{ type: 'invoice', id: 99000011 }] },
      { numero: '90000002', date: '9 juin 2024', options: [{ type: 'invoice', id: 99000021 }, { type: 'creditmemo', id: 99000022 }] },
      { numero: '90000003', date: '22 avril 2023', options: [{ type: 'invoice', id: 99000031 }] },
    ],
    ...extra,
  };
}

function cadrePss(contenu) {
  return `<header><div data-selector-account-icon-wrapper><button aria-label="Mon compte" data-selector-header-account>Compte</button>
      <div><div>Bonjour Client d'essai</div><a href="/sales/order/history/">Commandes</a>
        <button data-selector-logout data-piege="déconnexion">Déconnexion</button></div></div>
      <button data-selector-mini-basket data-piege="panier">Panier</button>
      <a href="https://${PSS_PANIER}/" data-piege="commander">Commander</a></header>
    <nav><a href="/sales/order/history/">Historique des commandes</a><a href="/ProductReturn/Front/List/" data-piege="retours">Retours</a>
      <a href="/sales/billing_agreement/" data-piege="modes de paiement">Modes de paiement</a></nav>
    <main id="contenu">${contenu}</main>`;
}

function pageListePss(etat, { recentes = false } = {}) {
  const cartes = recentes ? '' : etat.commandes.map((c) => `<div data-selector-account-card><div data-selector-account-card-header>
      <div><span>Numéro de commande</span><a href="/historical/orders/${c.numero}">#${c.numero}</a></div>
      <div><span>Date</span><span>${c.date}</span></div><div><span>Total</span><span>0,00 €</span></div>
      <div><span>Statut</span><span>Commande expédiée</span></div>
      <a href="/historical/orders/${c.numero}">Voir la commande</a></div></div>`).join('');
  const contenu = recentes
    ? '<h1 data-selector-orders-title>Mes commandes</h1><a href="/historical/orders">Voir les commandes précédentes</a>'
    : `<h1 data-selector-orders-title>Historique des commandes</h1><div>${cartes}</div>`;
  const script = `${SIGNALER} setTimeout(() => { document.getElementById('dessin').innerHTML = ${JSON.stringify(contenu)}; }, ${Number(etat.delaiDessinMs) || 0});`;
  return gabarit(recentes ? 'Mes Commandes' : 'Private Sport Shop', cadrePss('<div id="dessin"></div>'), { script });
}

function pageCommandePss(etat, c) {
  const options = c.options.map((o) => `<option value='${JSON.stringify(o)}'>${o.type === 'invoice' ? 'Facture' : 'Avoir'} Commande #${o.id}</option>`).join('');
  const contenu = `<div><div><h1>Détails de la commande</h1><p>Commande #${c.numero}| Date de commande ${c.date}</p></div>
    ${c.options.length ? `<select id="invoice-download-select" placeholder="Télécharger une facture" data-selector-invoice-download-select title="Télécharger une facture"><option value="">Télécharger une facture</option>${options}</select>` : ''}</div>
    <div>Expédition — Commande expédiée</div><div>Article d'essai — Prix: 0,00 € — Quantité: 1</div>
    <a href="/ProductReturn/Front/Create/${c.numero}" data-piege="retourner">Retourner un article</a>`;
  const script = `${SIGNALER}
    setTimeout(() => {
      document.getElementById('dessin').innerHTML = ${JSON.stringify(contenu)};
      const liste = document.getElementById('invoice-download-select');
      if (liste) liste.addEventListener('change', () => {
        const v = JSON.parse(liste.value || '{}');
        const variante = ${JSON.stringify(etat.variante)};
        if (variante === 'telechargement') window.open('https://${PSS_API}/v1/documents/' + v.type + '/' + v.id + '/pdf');
        else if (variante === 'non-pdf') window.open('https://${PSS_API}/v1/documents/' + v.type + '/' + v.id + '/pdf?casse=1');
        else if (variante === 'ailleurs') window.open('https://${AILLEURS}/facture.pdf');
        setTimeout(() => { liste.value = ''; }, 100);
      });
    }, ${Number(etat.delaiDessinMs) || 0});`;
  return gabarit('Private Sport Shop', cadrePss('<div id="dessin"></div>'), { script });
}

function sitePss(etat) {
  etat.compteurs = { listes: 0, commandes: [], documents: [], pieges: [], interdits: [], ailleurs: [], connexions: 0 };
  return async (url, requete) => {
    if (url.host === AILLEURS) {
      etat.compteurs.ailleurs.push(url.pathname);
      return { corps: pdfInvente('document d\'un autre domaine'), entetes: { 'content-type': 'application/pdf' } };
    }
    if (url.host === PSS_PANIER) {
      etat.compteurs.interdits.push(`${url.host}${url.pathname}`);
      return { html: gabarit('Panier', '<h1>Panier</h1>') };
    }
    if (url.host === PSS_API) {
      const m = /^\/v1\/documents\/([a-z]+)\/(\d+)\/pdf$/.exec(url.pathname);
      if (!m) return { statut: 404, html: '' };
      etat.compteurs.documents.push(`${m[1]}:${m[2]}`);
      etat.surPdf?.(etat.compteurs.documents.length);
      if (url.searchParams.get('casse')) {
        return { corps: Buffer.from('<html>erreur inventée</html>'), entetes: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="facture.pdf"' } };
      }
      return { corps: pdfInvente(`facture inventee pss ${m[1]} ${m[2]}`), entetes: { 'content-type': 'application/pdf' } };
    }
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresDocuments) && etat.compteurs.documents.length >= etat.sessionMeurtApresDocuments);
    if (url.pathname === '/__banc/piege') {
      etat.compteurs.pieges.push(url.searchParams.get('quoi'));
      return { statut: 204, html: '' };
    }
    if (url.pathname === '/historical/orders' || url.pathname === '/sales/order/history/') {
      etat.compteurs.listes += 1;
      if (!vivante) return { html: renvoi('/customer/account/login/') };
      return { html: pageListePss(etat, { recentes: url.pathname !== '/historical/orders' }) };
    }
    const m = /^\/historical\/orders\/(\d+)$/.exec(url.pathname);
    if (m) {
      const c = etat.commandes.find((x) => x.numero === m[1]);
      if (!vivante) return { html: renvoi('/customer/account/login/') };
      if (!c) return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
      etat.compteurs.commandes.push(c.numero);
      return { html: pageCommandePss(etat, c) };
    }
    if (url.pathname === '/customer/account/login/') {
      etat.compteurs.connexions += 1;
      return { html: pageConnexion('Connexion') };
    }
    etat.compteurs.interdits.push(url.pathname);
    return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Le navigateur, ses compteurs, ses filets
// ---------------------------------------------------------------------------

function journalVide() {
  return { gestes: [], choix: [], saisies: [], ecritures: [], avortees: [], visites: [], fuites: [], onglets: 0 };
}

/**
 * Branche le banc sur un contexte : TOUTES ses requêtes passent par `servir`
 * pour les hôtes de `hotes`, le reste est avorté ; gestes, choix, saisies,
 * écritures, visites et fuites sont comptés dans `journal`.
 */
async function brancherBanc(contexte, hotes, servir, journal) {
  const permis = new Set(hotes);
  contexte.on('request', (requete) => {
    if (requete.redirectedFrom()) journal.fuites.push(requete.url());
  });
  contexte.on('response', async (reponse) => {
    const serveur = await reponse.serverAddr().catch(() => null);
    if (serveur) journal.fuites.push(reponse.url());
  });
  contexte.on('page', () => { journal.onglets += 1; });
  await contexte.exposeBinding('__crabeGeste104', (_source, quoi) => {
    const q = quoi || {};
    if (q.genre === 'clic') {
      journal.gestes.push({ testid: String(q.testid || ''), texte: String(q.texte || ''), piege: String(q.piege || ''), hote: String(q.hote || '') });
    } else if (q.genre === 'choix') {
      journal.choix.push({ id: String(q.id || ''), valeur: String(q.valeur || '') });
    } else {
      journal.saisies.push(String(q.quoi || '?'));
    }
  });
  await contexte.addInitScript(() => {
    const envoyer = (q) => { try { window.__crabeGeste104(q); } catch { /* liaison absente */ } };
    document.addEventListener('click', (e) => {
      const c = e.target;
      if (!c || !c.closest) return;
      const actif = c.closest('a, button, [role="button"], [role="menuitem"], select, input, summary');
      const porteur = c.closest('[data-testid]');
      const piege = c.closest('[data-piege]');
      envoyer({
        genre: 'clic',
        testid: porteur ? porteur.getAttribute('data-testid') : '',
        texte: String((actif && (actif.innerText || actif.textContent)) || c.localName || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        piege: piege ? piege.getAttribute('data-piege') : '',
        hote: location.host,
      });
    }, true);
    document.addEventListener('change', (e) => {
      const c = e.target;
      if (c && c.localName === 'select') envoyer({ genre: 'choix', id: c.id || c.name || '?', valeur: c.value });
      else envoyer({ genre: 'saisie', quoi: `change:${(c && (c.name || c.id || c.localName)) || '?'}` });
    }, true);
    document.addEventListener('input', (e) => {
      const c = e.target;
      if (c && c.localName === 'select') return; // un choix, compté par « change »
      envoyer({ genre: 'saisie', quoi: `input:${(c && (c.name || c.id || c.localName)) || '?'}` });
    }, true);
    document.addEventListener('submit', () => envoyer({ genre: 'saisie', quoi: 'submit' }), true);
  });
  await contexte.route('**/*', async (route) => {
    const requete = route.request();
    let url;
    try { url = new URL(requete.url()); } catch { return route.abort(); }
    if (!permis.has(url.host)) {
      journal.avortees.push(url.host);
      return route.abort();
    }
    if (requete.method() !== 'GET') journal.ecritures.push(`${requete.method()} ${url.host}${url.pathname}`);
    if (requete.resourceType() === 'document') journal.visites.push(`${url.host}${url.pathname}`);
    const r = await servir(url, requete);
    return route.fulfill({
      status: r.statut || 200,
      headers: r.entetes || { 'content-type': 'text/html; charset=utf-8' },
      body: r.corps !== undefined ? r.corps : (r.html || ''),
    });
  });
}

/**
 * Un LANCEUR de navigateur pour le connecteur : le vrai Chromium, dont chaque
 * contexte est branché sur le banc. Seul le réseau est remplacé.
 */
function lanceurFaux(servir, hotes) {
  const journal = journalVide();
  const ouverts = [];
  const lancer = async () => {
    const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
    ouverts.push(navigateur);
    const creer = navigateur.newContext.bind(navigateur);
    navigateur.newContext = async (options) => {
      const contexte = await creer(options);
      await brancherBanc(contexte, hotes, servir, journal);
      return contexte;
    };
    return navigateur;
  };
  return {
    lancer,
    journal,
    lancements: () => ouverts.length,
    ouverts: () => ouverts.filter((n) => n.isConnected()).length,
    fermer: async () => { for (const n of ouverts) await n.close().catch(() => {}); },
  };
}

/** Les hôtes que chaque banc sert (le reste est avorté). */
const HOTES = {
  'battle-net': [BNET],
  alma: [ALMA, ALMA_API, AILLEURS],
  'private-sport-shop': [PSS, PSS_API, PSS_PANIER, AILLEURS],
};

/** Le domaine où la session inventée est posée. */
const DOMAINE_SESSION = { 'battle-net': BNET, alma: ALMA, 'private-sport-shop': PSS };

module.exports = {
  PLAYWRIGHT,
  SANS_NAVIGATEUR,
  BNET,
  ALMA,
  ALMA_API,
  PSS,
  PSS_API,
  PSS_PANIER,
  AILLEURS,
  JOUEUR,
  COURRIEL,
  COMPTE_ALMA,
  STOCKAGE_ALMA,
  sessionAvecStockage,
  COOKIE,
  HOTES,
  DOMAINE_SESSION,
  sessionInventee,
  compteBnet,
  siteBnet,
  pageListeBnet,
  compteAlma,
  siteAlma,
  comptePss,
  sitePss,
  lanceurFaux,
};
