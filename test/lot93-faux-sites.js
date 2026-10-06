'use strict';

/**
 * Lot 93 — des pages RECONSTITUÉES, fidèles cette fois à la structure du code
 * source réel, servies à un vrai Chromium sans que rien ne sorte de la machine.
 *
 * ─── D'où vient leur forme ───────────────────────────────────────────────────
 *
 * Le 06/10/2026, l'utilisateur a enregistré dans son navigateur le code source de deux
 * pages de Bricomarché (« Mes achats », onglet « En ligne » puis onglet « En
 * magasin ») et de deux pages de Gandi (la liste des organisations, les
 * factures d'une organisation). Le prompt du lot 93 en a repris la STRUCTURE,
 * sans aucune donnée : balises, `data-testid`, identifiants, attributs ARIA,
 * forme des adresses. C'est cette structure que les pages ci-dessous
 * reproduisent — là où le lot 92 avait dû inventer d'après la description
 * d'une capture (commandes en lien, onglets en lien avec `aria-selected`).
 *
 * Ce qu'aucune page enregistrée ne montre est INVENTÉ, et dit comme tel au
 * point où il l'est : le volet déplié d'une commande Bricomarché (la page a
 * été enregistrée repliée), la mécanique exacte du changement d'onglet (le
 * contenu se repeint, d'où il vient n'est pas connu), la page de connexion
 * de Gandi au-delà de ce qu'un anonyme en voit (A7).
 *
 * Lot 94 : « Voir mon ticket » TÉLÉCHARGE un PDF (annoncé par l'utilisateur le 06/10) —
 * c'est désormais l'effet de son clic sur cette page. La MÉCANIQUE est
 * inventée (un `fetch`, puis un lien de téléchargement hors de la page) : la
 * vraie n'a été vue par personne. Les autres issues (`etat.ticket`, ou
 * `ticket` sur un achat : une fenêtre, un formulaire, une autre page, rien, un
 * document qui n'est pas un PDF…) sont inventées pour éprouver l'arrêt.
 *
 * Lot 95 : le lien « PDF » d'une facture Gandi n'est PAS le PDF. Ce banc le
 * servait comme tel, d'après la même phrase que le code du lot 93 (« un lien
 * direct vers le PDF », tirée d'une page enregistrée) : aucun essai ne pouvait
 * voir le défaut, que le passage n° 708 de la production a montré le 06/10.
 * Mesuré ensuite par l'utilisateur dans son navigateur : le lien sert une page de
 * l'application (HTML, ≈ 83 Ko selon le lien), et le fichier vient de l'API
 * de facturation. Le banc sert désormais les deux comme le vrai site (voir
 * `siteGandi`).
 *
 * Une page reconstituée prouve que le connecteur LIT cette forme. Elle ne
 * prouve rien du vrai site.
 *
 * ─── La mécanique ────────────────────────────────────────────────────────────
 *
 * `context.route('**\/*')` sert les hôtes déclarés depuis la mémoire ; toute
 * autre requête est AVORTÉE. Aucune réponse n'est une redirection HTTP : le
 * lot 92 a mesuré que Playwright ne rappelle pas la route pour la suite d'une
 * redirection servie par `route.fulfill`, et deux lectures sont alors parties
 * vers le vrai bricomarche.com. Les renvois se font par la page
 * (`location.replace`), et deux filets le vérifient à chaque essai :
 * `request.redirectedFrom()` non nul, et une réponse qui porte une adresse
 * de serveur (une réponse servie par la route n'en a pas).
 *
 * Chaque clic est rapporté par la page elle-même (`__crabeClic`), avec le
 * `data-testid` de l'élément cliqué : les compter, c'est ne pas les supposer.
 * Chaque saisie aussi, et chaque requête qui n'est pas une lecture.
 *
 * ⚠ Toutes les valeurs sont inventées et visiblement fausses : numéros en
 * « ZZ… », montants à « 0,00 € », organisations « Organisation d'essai … »,
 * identifiants faits de zéros.
 */

const faux92 = require('./lot92-faux-sites');
const identity = require('../server/connectors/browser-identity');

const { PLAYWRIGHT, SANS_NAVIGATEUR, pdfInvente, surLeFauxProfil, contexteEnregistreur } = faux92;

const BRICOMARCHE = 'www.bricomarche.com';
const GANDI_ADMIN = 'admin.gandi.net';
const GANDI_ID = 'id.gandi.net';

function gabarit(titre, corps, { script = '', tete = '' } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title>${tete}</head>
<body>${corps}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** Un renvoi fait par la PAGE, jamais par une réponse 3xx (voir l'en-tête). */
function renvoi(adresse) {
  return gabarit('Redirection', '', { script: `location.replace(${JSON.stringify(adresse)});` });
}

const VIGNETTE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const CHEVRON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>';

// ---------------------------------------------------------------------------
// Bricomarché — « Mes achats », tel que le code source du 06/10 le structure
// ---------------------------------------------------------------------------

/**
 * Les `data-testid` relevés dans le code source. `etat.testids` peut en
 * renommer une partie, pour prouver que la page reste LUE par ses textes
 * quand un repère change (D3) — et que rien ne se clique alors.
 */
function testidsBricomarche(etat) {
  const base = {
    ongletEnLigne: 'account_filtered-orders_tab-web',
    ongletEnMagasin: 'account_filtered-orders_tab-instore',
    deplier: 'account_web-order-item_toggle-details',
    ticket: 'account_purchase-history_view-ticket',
    menuAchats: 'account_menu_/my-account/orders',
    deconnexion: 'account_menu_logout',
  };
  const renommes = etat.testids === 'tous-renommes' ? Object.keys(base)
    : etat.testids === 'onglet-magasin-renomme' ? ['ongletEnMagasin']
    : etat.testids === 'ticket-renomme' ? ['ticket']
    : [];
  for (const cle of renommes) base[cle] = `${base[cle]}-v2`;
  return base;
}

/** L'en-tête du site (hors de l'espace client). */
const ENTETE_BRICOMARCHE = `<header class="site-header"><a href="#contenu">Aller au contenu</a>
  <a href="/">Bricomarché</a> <a href="/magasins">Mon magasin</a>
  <a href="/my-account">Mon compte</a> <a href="/panier">Panier</a></header>`;

/** Le menu de gauche : des liens `account_menu_<chemin>`, et la déconnexion. */
function menuBricomarche(t, { renomme = false } = {}) {
  const entree = (chemin, texte) => `<li><a href="${chemin}" data-testid="account_menu_${chemin}">${texte}</a></li>`;
  return `<aside class="account-menu"><nav aria-label="Mon compte"><ul>
      <li><a href="/my-account/orders" data-testid="${t.menuAchats}" class="font-bold">${renomme ? 'Mes commandes' : 'Mes achats'}</a></li>
      ${entree('/my-account/brico-plus', 'Mon Brico +')}
      ${entree('/my-account/profile', 'Mes informations personnelles')}
      ${entree('/my-account/addresses', 'Mes adresses')}
      ${entree('/my-account/communication', 'Mes préférences de communication')}
      <li><a href="/logout" data-testid="${t.deconnexion}">Me déconnecter</a></li>
    </ul></nav>
    <section class="aide"><h2>Aide &amp; support</h2><a href="/aide-et-contact">Aide &amp; contact</a></section></aside>`;
}

/** Une commande en ligne : `li > section > header (…) + chevron`. */
function commandeEnLigne(c, t) {
  return `<li>
      <section class="order-card">
        <header>
          <h2>Commande <span>${c.numero}</span></h2>
          <p aria-label="Prix du produit: 0,00 €">0,00 €</p>
          <div role="status">${c.etat || 'Livrée'}</div>
          <time datetime="${c.iso}"><p>Commande passée en ligne le ${c.dateAffichee}</p></time>
          <p>Vendue par <span>${c.vendeur || 'Bricomarché'}</span></p>
          <ul aria-label="Produits de la commande"><li><img alt="Article d'essai" src="${VIGNETTE}"></li></ul>
        </header>
        <button type="button" data-testid="${t.deplier}" aria-expanded="false" aria-controls="order-details-${c.numero}">${CHEVRON}</button>
      </section>
    </li>`;
}

/** Un achat en magasin : date, montant, « Voir mon ticket ». Pas de numéro visible. */
function achatEnMagasin(a, t) {
  const montant = a.montant || '0,00 €';
  return `<li class="purchase">
      <p>${a.dateAffichee}</p>
      <p aria-label="Prix du produit: ${montant}">${montant}</p>
      <button type="button" data-testid="${t.ticket}" class="btn" onclick="document.body.dataset.ticket = String(Number(document.body.dataset.ticket || 0) + 1)"><span class="btn-label">Voir mon ticket</span></button>
    </li>`;
}

/** L'ordre dans lequel `panneau` montre une liste : groupée par mois, dans l'ordre d'apparition. */
function ordreDuPanneau(liste) {
  const parMois = new Map();
  for (const e of liste) {
    if (!parMois.has(e.mois)) parMois.set(e.mois, []);
    parMois.get(e.mois).push(e);
  }
  return [...parMois.values()].flat();
}

/**
 * La clé inventée du ticket d'un achat (`a.cle`, sinon « ZZT » et son rang
 * dans l'état) et ce que fait son clic (`a.ticket`, sinon `etat.ticket`,
 * sinon un téléchargement).
 */
function ticketDe(etat, a) {
  const rang = (etat.enMagasin || []).indexOf(a);
  return { cle: a.cle || `ZZT${String(rang + 1).padStart(4, '0')}`, variante: a.ticket || etat.ticket || 'telechargement' };
}

/**
 * Le script du ticket (lot 94) — MÉCANIQUE INVENTÉE. Le clic d'un bouton au
 * repère du ticket, dans le panneau, fait ce que `variante` dit :
 *   - `telechargement` (défaut) : `fetch` du PDF, puis un lien `download` créé
 *     HORS de la page et cliqué par le script du site (le banc ne le compte
 *     pas : il n'est pas dans le document) ;
 *   - `navigation` : la page part vers le PDF, servi en pièce jointe ;
 *   - `onglet` : le PDF s'ouvre dans un nouvel onglet ;
 *   - `non-pdf` : le « ticket » téléchargé est une page d'erreur ;
 *   - `fenetre` : une fenêtre (`role="dialog"`) montre le ticket, avec ses
 *     propres boutons ;
 *   - `formulaire` : un formulaire « recevoir par e-mail » s'affiche ;
 *   - `native` : une boîte de confirmation du navigateur ;
 *   - `page` : la page part vers une autre page ;
 *   - `bascule` : l'onglet « En ligne » se réaffiche, puis le PDF arrive ;
 *   - `rien` : rien.
 */
function scriptTickets(t, tickets) {
  return `
    const TICKETS = ${JSON.stringify(tickets)};
    const REPERE_TICKET = ${JSON.stringify(t.ticket)};
    function telecharger(adresse, nom) {
      fetch(adresse).then((r) => r.blob()).then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = nom;
        a.click();
      });
    }
    function fenetre(html) {
      const boite = document.createElement('div');
      boite.setAttribute('role', 'dialog');
      boite.setAttribute('aria-modal', 'true');
      boite.innerHTML = html;
      document.body.appendChild(boite);
    }
    document.addEventListener('click', (e) => {
      const bouton = e.target.closest && e.target.closest('[data-testid]');
      if (!bouton || bouton.getAttribute('data-testid') !== REPERE_TICKET) return;
      const tous = [...document.querySelectorAll('#panneau [data-testid]')]
        .filter((b) => b.getAttribute('data-testid') === REPERE_TICKET);
      const ticket = TICKETS[tous.indexOf(bouton)];
      if (!ticket) return;
      const adresse = '/my-account/purchase-history/ticket/' + encodeURIComponent(ticket.cle);
      switch (ticket.variante) {
        case 'telechargement': telecharger(adresse, 'ticket-' + ticket.cle + '.pdf'); break;
        case 'navigation': location.href = adresse + '?telecharger=1'; break;
        case 'onglet': window.open(adresse + '?voir=1'); break;
        case 'non-pdf': telecharger(adresse + '?casse=1', 'ticket.pdf'); break;
        case 'fenetre':
          fenetre('<h2>Votre ticket de caisse</h2><p>Article d&#39;essai — 0,00 €</p>'
            + '<button type="button" onclick="document.body.dataset.fenetre = 1">Télécharger le PDF</button>'
            + '<button type="button" onclick="document.body.dataset.fenetre = 2">Fermer</button>');
          break;
        case 'formulaire':
          fenetre('<form method="post" action="/my-account/purchase-history/ticket/envoi"><label>Recevoir mon ticket par e-mail '
            + '<input type="email" name="email"></label><button type="submit">Envoyer</button></form>');
          break;
        case 'native': document.body.dataset.confirme = String(confirm('Télécharger votre ticket ?')); break;
        case 'page': location.href = '/my-account/orders/ticket-introuvable'; break;
        case 'bascule':
          // L'onglet « En ligne » redevient l'affiché AVANT que le PDF n'arrive.
          document.getElementById('onglet-web').className = ACTIF;
          document.getElementById('onglet-magasin').className = INACTIF;
          document.getElementById('panneau').innerHTML = PANNEAUX.web;
          telecharger(adresse, 'ticket-' + ticket.cle + '.pdf');
          break;
        default: break;
      }
    });`;
}

/** Une section par mois : `p.heading-s` puis la liste. */
function panneau(liste, rendre, t, phraseVide) {
  if (!liste.length) return `<p class="empty">${phraseVide}</p>`;
  const parMois = new Map();
  for (const e of liste) {
    if (!parMois.has(e.mois)) parMois.set(e.mois, []);
    parMois.get(e.mois).push(e);
  }
  return [...parMois].map(([mois, elements]) => `<section>
      <p class="heading-s">${mois}</p>
      <ul>${elements.map((e) => rendre(e, t)).join('')}</ul>
    </section>`).join('');
}

/**
 * Le volet déplié d'une commande — FORME INVENTÉE : la page a été enregistrée
 * repliée, personne ne sait ce qu'il contient. `etat.volet` y pose (ou non) un
 * élément qui évoque une facture.
 */
function voletBricomarche(etat, numero) {
  const facture = {
    aucune: '',
    bouton: '<button type="button" class="invoice" onclick="document.body.dataset.facture = \'cliquee\'">Télécharger ma facture</button>',
    lien: `<a class="invoice" href="/my-account/orders/${numero}/invoice.pdf" download>Facture (PDF)</a>`,
  }[etat.volet || 'aucune'];
  return `<div id="order-details-${numero}" class="order-details">
      <table><tr><td>Article d'essai</td><td>× 1</td><td>0,00 €</td></tr>
        <tr><td>Frais de livraison</td><td></td><td>0,00 €</td></tr>
        <tr><td>Total TTC</td><td></td><td>0,00 €</td></tr></table>
      <button type="button" class="return" onclick="document.body.dataset.retour = 'oui'">Retourner un article</button>
      ${facture}
    </div>`;
}

/**
 * « Mes achats ». `etat` :
 *   - `enLigne`, `enMagasin` : les commandes et les achats (valeurs inventées) ;
 *   - `onglet` : l'onglet actif à l'arrivée (`web` par défaut) ;
 *   - `testids` : `tous-renommes` | `onglet-magasin-renomme` (D3) ;
 *   - `ongletInerte` : le clic sur « En magasin » ne fait rien ;
 *   - `classesFigees` : le contenu change, l'onglet ne devient pas l'actif ;
 *   - `contenuFige` : l'onglet devient l'actif, le contenu ne change pas ;
 *   - `titreChange`, `menuRenomme`, `filtreFige` : un signe qui change ;
 *   - `volet` : `aucune` | `bouton` | `lien` (le volet déplié, inventé) ;
 *   - `voletAbsent` : le chevron ne déplie rien.
 */
function mesAchatsBricomarche(etat, url) {
  const t = testidsBricomarche(etat);
  const filtre = etat.filtreFige ? 'default' : (url.searchParams.get('historyOrderFilter') || 'default');
  // Hors « Toutes mes commandes », seule l'année en cours est montrée : une
  // commande plus ancienne disparaîtrait.
  const visibles = (liste) => (filtre === 'all' ? liste : liste.filter((e) => e.dateAffichee.endsWith('2026')));
  const web = panneau(visibles(etat.enLigne || []), commandeEnLigne, t, 'Vous n\'avez pas encore passé de commande en ligne.');
  const magasin = panneau(visibles(etat.enMagasin || []), achatEnMagasin, t, 'Vous n\'avez pas encore d\'achat en magasin.');
  const actif = etat.onglet === 'magasin' ? 'magasin' : 'web';
  const classes = (oui) => (oui ? 'btn btn-tab font-bold btn-tab-selected' : 'btn btn-tab font-normal');
  const options = [['default', 'Les 6 derniers mois'], ['2026', '2026'], ['2025', '2025'], ['all', 'Toutes mes commandes']]
    .map(([v, l]) => `<option value="${v}"${v === filtre ? ' selected' : ''}>${l}</option>`).join('');
  const tickets = ordreDuPanneau(visibles(etat.enMagasin || [])).map((a) => ticketDe(etat, a));
  const corps = `${ENTETE_BRICOMARCHE}<div class="account-layout">${menuBricomarche(t, { renomme: etat.menuRenomme })}
    <main id="contenu">
      <h3 class="heading-l">${etat.titreChange ? 'Historique de mes commandes' : 'Mes achats'}</h3>
      <div class="flex gap-2">
        <button type="button" id="onglet-web" data-testid="${t.ongletEnLigne}" class="${classes(actif === 'web')}"><span class="btn-label">En ligne</span></button>
        <button type="button" id="onglet-magasin" data-testid="${t.ongletEnMagasin}" class="${classes(actif === 'magasin')}"><span class="btn-label">En magasin</span></button>
      </div>
      <div class="select-wrapper"><select id="historyOrderFilter-select" name="historyOrderFilter">${options}</select></div>
      <div id="panneau">${actif === 'web' ? web : magasin}</div>
    </main></div>`;
  const script = `
    const PANNEAUX = { web: ${JSON.stringify(web)}, magasin: ${JSON.stringify(magasin)} };
    const VOLETS = ${JSON.stringify(Object.fromEntries((etat.enLigne || []).map((c) => [c.numero, voletBricomarche(etat, c.numero)])))};
    const ETAT = ${JSON.stringify({ ongletInerte: !!etat.ongletInerte, classesFigees: !!etat.classesFigees, contenuFige: !!etat.contenuFige, voletAbsent: !!etat.voletAbsent })};
    const ACTIF = ${JSON.stringify(classes(true))};
    const INACTIF = ${JSON.stringify(classes(false))};
    function montrer(onglet) {
      if (onglet === 'magasin' && ETAT.ongletInerte) return;
      // Le contenu se repeint après coup, comme une application qui va
      // chercher ses données (d'où elles viennent n'est pas mesuré).
      setTimeout(() => {
        if (!ETAT.classesFigees) {
          document.getElementById('onglet-web').className = onglet === 'web' ? ACTIF : INACTIF;
          document.getElementById('onglet-magasin').className = onglet === 'magasin' ? ACTIF : INACTIF;
        }
        if (!ETAT.contenuFige) document.getElementById('panneau').innerHTML = PANNEAUX[onglet];
      }, 250);
    }
    document.getElementById('onglet-web').addEventListener('click', () => montrer('web'));
    document.getElementById('onglet-magasin').addEventListener('click', () => montrer('magasin'));
    document.addEventListener('click', (e) => {
      const chevron = e.target.closest && e.target.closest('button[aria-controls^="order-details-"]');
      if (!chevron) return;
      const numero = chevron.getAttribute('aria-controls').slice('order-details-'.length);
      if (chevron.getAttribute('aria-expanded') === 'true') {
        chevron.setAttribute('aria-expanded', 'false');
        document.getElementById('order-details-' + numero)?.remove();
        return;
      }
      chevron.setAttribute('aria-expanded', 'true');
      if (ETAT.voletAbsent) return;
      setTimeout(() => { chevron.insertAdjacentHTML('afterend', VOLETS[numero] || ''); }, 150);
    });${scriptTickets(t, tickets)}`;
  return gabarit('Mon compte', corps, {
    script,
    tete: '<link rel="canonical" href="https://www.bricomarche.com/my-account/orders">',
  });
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
 * Le faux Bricomarché. `etat.page` : `achats` (défaut) | `connexion` (toute
 * page de l'espace client renvoie vers `/login`) | `illisible` (connecté, mais
 * rien de « Mes achats »).
 */
function siteBricomarche(etat) {
  // Les tickets servis (lot 94), dans l'ordre : leur clé inventée.
  etat.ticketsServis = [];
  return async (url, requete) => {
    if (requete.method() !== 'GET') return { statut: 204, html: '' };
    if (url.pathname === '/login') return { html: connexionBricomarche() };
    const ticket = /^\/my-account\/purchase-history\/ticket\/([^/]+)$/.exec(url.pathname);
    if (ticket) {
      const cle = decodeURIComponent(ticket[1]);
      etat.ticketsServis.push(cle);
      etat.surTicket?.(etat.ticketsServis.length);
      if (url.searchParams.get('casse')) {
        return { corps: Buffer.from('<!doctype html><html><body>Une erreur est survenue</body></html>', 'latin1'), entetes: { 'content-type': 'text/html; charset=utf-8' } };
      }
      return {
        corps: pdfInvente(`ticket invente ${cle}`),
        entetes: url.searchParams.get('telecharger')
          ? { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="ticket-${cle}.pdf"` }
          : { 'content-type': 'application/pdf' },
      };
    }
    if (etat.page === 'connexion' && url.pathname.startsWith('/my-account')) return { html: renvoi('/login') };
    // Mesuré le 05/10/2026 (journal de production) et revu le 06/10 : /my-account
    // aboutit sur la liste avec le seul paramètre `choiceOrder=0`.
    if (url.pathname === '/my-account' || url.pathname === '/my-account/') {
      return { html: renvoi('/my-account/orders?choiceOrder=0') };
    }
    if (url.pathname === '/my-account/orders') {
      if (etat.page === 'illisible') {
        return {
          html: gabarit('Mon compte', `${ENTETE_BRICOMARCHE}<div class="account-layout">${menuBricomarche(testidsBricomarche(etat))}
            <main id="contenu"><h3>Votre espace évolue</h3><p>Revenez bientôt.</p></main></div>`),
        };
      }
      return { html: mesAchatsBricomarche(etat, url) };
    }
    return { statut: 404, html: gabarit('Page non trouvée', '<h1>La page demandée n\'existe pas</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Gandi — la liste des organisations, les factures, les PDF
// ---------------------------------------------------------------------------

/**
 * Le compte d'essai de Gandi, à la forme du réel (trois organisations, dont
 * « Moi » ; cinq pages de dix factures pour la première) et aux valeurs
 * visiblement fausses. Les identifiants sont faits de zéros, les numéros
 * commencent par « ZZ », les montants valent 0,00 €.
 */
const MOIS_ABREGES = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function idOrganisation(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** `combien` factures inventées, de la plus récente à la plus ancienne. */
function facturesInventees(lettre, combien, { depuis = new Date(Date.UTC(2026, 9, 1)) } = {}) {
  const liste = [];
  for (let i = 0; i < combien; i++) {
    const d = new Date(depuis.getTime());
    d.setUTCMonth(d.getUTCMonth() - i);
    liste.push({
      interne: `00000000-0000-0000-0000-${lettre.charCodeAt(0).toString().padStart(4, '0')}${String(i + 1).padStart(8, '0')}`,
      numero: `ZZ${lettre}${String(9000 - i).padStart(6, '0')}`,
      jour: 1 + (i % 27),
      mois: d.getUTCMonth(),
      annee: d.getUTCFullYear(),
    });
  }
  return liste;
}

function compteGandiDEssai(extra = {}) {
  return {
    connecte: true,
    parPage: 10,
    organisations: [
      { id: idOrganisation(1), nom: 'Organisation d\'essai A', moi: true, factures: facturesInventees('A', 47) },
      { id: idOrganisation(2), nom: 'Organisation d\'essai B', factures: facturesInventees('B', 3) },
      { id: idOrganisation(3), nom: 'Organisation d\'essai C', factures: facturesInventees('C', 12) },
    ],
    ...extra,
  };
}

function dateAffichee(f) {
  return `${f.jour} ${MOIS_ABREGES[f.mois]} ${f.annee}`;
}

/** L'en-tête de l'espace Gandi : le panier et la déconnexion — jamais approchés. */
function enteteGandi() {
  return `<header class="topbar"><a href="https://admin.gandi.net/dashboard">Gandi</a>
    <a href="https://shop.gandi.net/fr/cart">Panier</a>
    <a href="/billing/api/v5/logout">Se déconnecter</a></header>`;
}

/** `/billing` : « Choisir une organisation ». Liens tantôt relatifs, tantôt absolus. */
function listeOrganisations(etat) {
  if (etat.listeIllisible) {
    return faux92gabarit('Tableau de bord - Gandi.net', `${enteteGandi()}<main><h1>Bienvenue</h1><p>Votre espace évolue.</p></main>`);
  }
  const lignes = etat.organisations.map((o, i) => {
    const relatif = `/billing/${o.id}/overview`;
    const absolu = `https://admin.gandi.net/billing/${o.id}/overview`;
    const [lienNom, lienVoir] = i % 2 ? [absolu, relatif] : [relatif, absolu];
    return `<li class="org">
        <a href="${lienNom}">${o.nom}</a>${o.moi ? ' <span class="tag">Moi</span>' : ''}
        <div aria-label="Solde du compte prépayé : 0,00 €">0,00 €</div>
        <a href="${lienVoir}">Voir</a>
      </li>`;
  }).join('');
  return faux92gabarit('Choisir une organisation - Gandi.net', `${enteteGandi()}<main>
      <h1>Facturation</h1>
      <input type="search" aria-label="Rechercher une organisation">
      <ul>${lignes}</ul></main>`);
}

/**
 * `/billing/<organisation>/invoices?page=N` : onglets, « Exporter une
 * période », filtres, tableau (cases, numéro EN LIEN DIRECT vers le PDF,
 * date en mois abrégé, menu « ⋮ »), pagination. Rendu « serveur ».
 */
function pageFactures(etat, org, n) {
  const parPage = etat.parPage || 10;
  const pages = Math.max(1, Math.ceil(org.factures.length / parPage));
  const tranche = org.factures.slice((n - 1) * parPage, n * parPage);
  const onglets = `<nav aria-label="Onglets">
      <a href="/billing/${org.id}/overview">Vue générale</a>
      <a href="/billing/${org.id}/orders">Commandes</a>
      <a href="/billing/${org.id}/invoices" aria-current="page">Factures</a>
      <a href="/billing/${org.id}/prepaid">Historique prépayé</a>
      <a href="/billing/${org.id}/autorenew">Paiements automatiques</a>
      <a href="/billing/${org.id}/settings">Paramètres</a>
    </nav>`;
  const outils = `<button type="button" id="exporter-periode" onclick="document.body.dataset.export = 'oui'">Exporter une période</button>
    <label>Statut <select name="statut" onchange="document.body.dataset.filtre = this.value"><option>Toutes</option><option>Payée</option></select></label>`;
  if (etat.facturesIllisibles?.includes(org.id)) {
    return faux92gabarit(`${org.nom} - Facturation - Gandi.net`, `${enteteGandi()}<main>${onglets}
      <table><thead><tr><th>Domaine</th><th>Échéance</th></tr></thead><tbody><tr><td>exemple.invalid</td><td>—</td></tr></tbody></table></main>`);
  }
  if (!org.factures.length) {
    const corps = etat.sansFactureForme === 'tableau-vide'
      ? `<table><thead><tr><th></th><th>Numéro de facture</th><th>Date</th><th>Montant</th><th>Méthode</th><th>Commande</th><th>Produit</th><th>Statut</th><th></th></tr></thead><tbody></tbody></table>`
      : '<p class="vide">Aucune facture pour le moment.</p>';
    return faux92gabarit(`${org.nom} - Facturation - Gandi.net`, `${enteteGandi()}<main>${onglets}${outils}${corps}</main>`);
  }
  const lignes = tranche.map((f, i) => {
    const chemin = `/billing/${org.id}/invoices/${f.interne}/${f.numero}/pdf`;
    const href = i % 2 ? `https://admin.gandi.net${chemin}` : chemin;
    return `<tr>
        <td><input type="checkbox" aria-label="Sélectionner la facture"></td>
        <td><a href="${href}">${f.numero}</a></td>
        <td>${dateAffichee(f)}</td>
        <td>0,00 €</td><td>Carte</td><td>ZZC-${String(i + 1).padStart(4, '0')}</td><td>Nom de domaine</td><td>Payée</td>
        <td><button type="button" class="menu" aria-label="Actions" onclick="document.body.dataset.menu = 'ouvert'">⋮</button>
          <div role="menu" hidden><button role="menuitem">Exporter en PDF</button><button role="menuitem">Export en CSV</button><button role="menuitem">Export au format Excel</button></div></td>
      </tr>`;
  }).join('');
  // La pagination : un lien par page, sous deux formes (chemin complet, ou
  // `?page=N` seul), et un lien « suivante » qui porte un paramètre de plus.
  const liens = [];
  for (let p = 1; p <= pages; p++) {
    liens.push(p % 2 ? `<a href="/billing/${org.id}/invoices?page=${p}">${p}</a>` : `<a href="?page=${p}">${p}</a>`);
  }
  if (n < pages) liens.push(`<a href="?page=${n + 1}&amp;sort=-date" rel="next">Suivante</a>`);
  return faux92gabarit(`${org.nom} - Facturation - Gandi.net`, `${enteteGandi()}<main>${onglets}${outils}
      <table>
        <thead><tr><th><input type="checkbox" aria-label="Tout sélectionner"></th><th>Numéro de facture</th><th>Date</th><th>Montant</th><th>Méthode</th><th>Commande</th><th>Produit</th><th>Statut</th><th></th></tr></thead>
        <tbody>${lignes}</tbody>
      </table>
      ${pages > 1 ? `<nav aria-label="Pagination">${liens.join(' ')}</nav>` : ''}
    </main>`);
}

/**
 * Lot 95 — la page que sert le LIEN « PDF » d'une facture. Mesuré par l'utilisateur le
 * 06/10/2026 dans son navigateur, sur ce lien : 200, `text/html;
 * charset=utf-8`, 83 203 ou 83 883 octets selon le lien, sans redirection,
 * avec ou sans `Accept` de navigation ; ouverte dans un onglet, c'est
 * l'APPLICATION, qui demande elle-même le fichier à l'API de facturation.
 *
 * INVENTÉ : tout le contenu. Seules la forme (HTML de quelque 83 Ko, dont la
 * taille dépend du lien) et le geste de l'application (demander le PDF à
 * l'API, par `fetch`, avec les trois segments du lien) suivent la mesure. La
 * taille est faite de cinq chiffres, comme en production.
 */
function pageDuLienPdf(url) {
  let graine = 7;
  for (const c of url.pathname) graine = (graine * 31 + c.charCodeAt(0)) >>> 0;
  const cible = 83_000 + (graine % 1000);
  const script = `(function () {
    var m = /^\\/billing\\/([^/]+)\\/invoices\\/([^/]+)\\/([^/]+)\\/pdf$/.exec(location.pathname);
    if (!m) return;
    fetch('/billing/api/v5/billing/invoices/' + m[2] + '/pdf?lang=fr&invoice_num=' + m[3] + '&sharing_id=' + m[1], { credentials: 'include' })
      .then(function (r) { return r.blob(); })
      .then(function (b) { var f = document.createElement('iframe'); f.src = URL.createObjectURL(b); document.body.appendChild(f); })
      .catch(function () {});
  })();`;
  const sans = gabarit('Gandi.net', '<div id="application">Chargement…</div>', { script, tete: '<!--REMPLISSAGE-->' });
  const manque = Math.max(0, cible - Buffer.byteLength(sans, 'utf8') + '<!--REMPLISSAGE-->'.length - '<!---->'.length);
  const html = sans.replace('<!--REMPLISSAGE-->', `<!--${'a'.repeat(manque)}-->`);
  return { corps: Buffer.from(html, 'utf8'), entetes: { 'content-type': 'text/html; charset=utf-8' } };
}

/** Une réponse de l'API qui n'est pas un PDF, de la nature demandée. */
function apiNonPdf(nature) {
  const json = (statut, objet) => ({
    statut,
    corps: Buffer.from(JSON.stringify(objet), 'utf8'),
    entetes: { 'content-type': 'application/json; charset=utf-8' },
  });
  if (nature === '401') return json(401, { code: 401, message: 'Authentification requise (banc)' });
  if (nature === '404') return json(404, { code: 404, message: 'Introuvable (banc)' });
  if (nature === 'json') return json(200, { erreur: 'facture indisponible (banc)' });
  if (nature === 'vide') return { corps: Buffer.alloc(0), entetes: { 'content-type': 'application/pdf' } };
  if (nature === 'autre') return { corps: Buffer.from('GIF89a inventé', 'latin1'), entetes: { 'content-type': 'image/gif' } };
  // 'html' : une page web servie à la place du fichier.
  return {
    corps: Buffer.from(gabarit('Erreur - Gandi.net', '<main><h1>Une erreur est survenue</h1></main>'), 'utf8'),
    entetes: { 'content-type': 'text/html; charset=utf-8' },
  };
}

/** La page de connexion de Gandi ID, telle qu'un anonyme la reçoit (A7). */
function connexionGandi() {
  return faux92gabarit('Connectez-vous ou créez votre compte - Gandi ID', `<main>
    <h1>Connectez-vous ou créez votre compte</h1>
    <form method="post" action="/fr/login"><label>Nom d'utilisateur <input name="auth.username" type="text"></label>
      <label>Mot de passe <input name="auth.password" type="password"></label>
      <label><input name="auth.remember_me" type="checkbox"> Se souvenir de moi</label>
      <button type="submit">Se connecter</button></form></main>`);
}

/**
 * Le faux Gandi, sur ses deux hôtes. `etat` : `{ connecte, organisations,
 * parPage, sessionMeurtApresPdf, listeIllisible, facturesIllisibles: [id],
 * sansFactureForme, pdfHtml: [numéro], apiNonPdf: {numéro|'*': nature},
 * sessionFacturation, surPdf }`.
 *
 *   - `connecte` : la session Gandi ID vit ;
 *   - `sessionFacturation: false` : celle de la facturation n'est pas (encore)
 *     ouverte — la première page passe par `/billing/api/v5/login`, puis par
 *     l'autorisation de Gandi ID, qui revient avec un code (forme mesurée en
 *     anonyme, A7 ; le retour, lui, est INVENTÉ) ;
 *   - `surPdf` : appelé à chaque PDF servi (l'horloge des essais du temps).
 *
 * Lot 95 — comme le vrai site (mesuré par l'utilisateur le 06/10/2026) :
 *
 *   - le LIEN « PDF » d'une facture sert, à TOUTE demande, une page HTML de
 *     l'application (`pageDuLienPdf`) — jamais le fichier ;
 *   - le PDF vient de l'API de facturation,
 *     `/billing/api/v5/billing/invoices/<interne>/pdf?lang=fr&invoice_num=<numéro>&sharing_id=<organisation>`,
 *     et le banc ne le sert qu'avec SA session (Gandi ID et facturation
 *     ouvertes), et seulement quand les trois paramètres — exactement
 *     ceux-là, `lang` valant `fr` — sont égaux aux segments d'un lien
 *     existant ;
 *   - le banc CHOISIT ce que rend toute autre demande d'API, le vrai site
 *     n'étant pas mesuré là : 401 en JSON sans session, 404 en JSON pour
 *     toute autre adresse ou d'autres paramètres ;
 *   - `pdfHtml` (lot 93) vaut désormais pour la réponse de l'API : une page
 *     d'erreur déclarée `application/pdf` ; `apiNonPdf` (lot 95) fait rendre
 *     à l'API, pour un numéro ou pour tous (`'*'`), une réponse qui n'est pas
 *     un PDF : `html`, `json`, `vide`, `autre` ou `401`.
 *
 * La session de facturation, quand elle s'ouvre par la chaîne mesurée, pose
 * aussi un cookie `session` (posé par la page, comme tout ici) : les essais
 * du lot 95 vérifient que la demande à l'API le porte.
 *
 * Il compte ce qu'il sert (`etat.compteurs` : `pdf`, les PDF servis par
 * l'API ; `api`, toutes les demandes d'API ; `liens`, les pages de lien
 * servies). Aucune réponse n'est une redirection HTTP : les renvois se font
 * par la page.
 */
function siteGandi(etat) {
  etat.compteurs = { pdf: [], deconnexion: 0, autorisations: 0, api: 0, liens: 0 };
  let pdfServis = 0;
  const sessionVivante = () => etat.connecte
    && !(Number.isFinite(etat.sessionMeurtApresPdf) && pdfServis >= etat.sessionMeurtApresPdf);
  return async (url, requete) => {
    if (requete.method() !== 'GET') return { statut: 204, html: '' };
    if (url.host === GANDI_ID) {
      if (/^\/[a-z]{2}\/authorize$/.test(url.pathname)) {
        etat.compteurs.autorisations++;
        // Session Gandi ID vivante : retour immédiat vers la facturation.
        return sessionVivante()
          ? { html: renvoi(`https://admin.gandi.net/billing/api/v5/login?code=code-invente&state=${url.searchParams.get('state') || ''}`) }
          : { html: renvoi(`/fr/login?redirect=${encodeURIComponent(url.href)}`) };
      }
      if (/^\/[a-z]{2}\/login$/.test(url.pathname)) return { html: connexionGandi() };
      return { statut: 404, html: faux92gabarit('Introuvable', '<h1>Introuvable</h1>') };
    }
    // admin.gandi.net
    if (url.pathname === '/billing/api/v5/logout') {
      etat.compteurs.deconnexion++;
      return { html: faux92gabarit('Déconnecté', '<h1>Vous êtes déconnecté</h1>') };
    }
    if (url.pathname === '/billing/api/v5/login') {
      if (url.searchParams.get('code')) {
        etat.sessionFacturation = true;
        const retour = etat.retour || '/billing';
        etat.retour = null;
        // Lot 95 : le cookie de la session de facturation (valeur inventée),
        // posé par la page — le banc n'émet aucun en-tête de redirection.
        return {
          html: gabarit('Redirection', '', {
            script: `document.cookie = "session=session-du-banc; path=/; Secure"; location.replace(${JSON.stringify(retour)});`,
          }),
        };
      }
      etat.retour = url.searchParams.get('redirect') || null;
      return { html: renvoi('https://id.gandi.net/fr/authorize?client_id=client-invente&response_type=code&state=etat-invente') };
    }
    // Lot 95 — l'API de facturation : le SEUL endroit d'où sort un PDF.
    if (url.pathname.startsWith('/billing/api/v5/billing/')) {
      etat.compteurs.api++;
      if (!sessionVivante() || etat.sessionFacturation === false) return apiNonPdf('401');
      const api = /^\/billing\/api\/v5\/billing\/invoices\/([^/]+)\/pdf$/.exec(url.pathname);
      const cles = [...url.searchParams.keys()];
      const parametresExacts = cles.length === 3
        && ['lang', 'invoice_num', 'sharing_id'].every((c) => url.searchParams.getAll(c).length === 1)
        && url.searchParams.get('lang') === 'fr';
      if (!api || !parametresExacts) return apiNonPdf('404');
      const org = etat.organisations.find((o) => o.id === url.searchParams.get('sharing_id'));
      const f = org && org.factures.find((x) => x.interne === decodeURIComponent(api[1])
        && x.numero === url.searchParams.get('invoice_num'));
      if (!f) return apiNonPdf('404');
      pdfServis++;
      etat.surPdf?.(pdfServis);
      etat.compteurs.pdf.push(`${org.id}/${f.numero}`);
      if (etat.pdfHtml?.includes(f.numero)) {
        return { corps: Buffer.from('<!doctype html><html><body>Une erreur est survenue</body></html>', 'latin1'), entetes: { 'content-type': 'application/pdf' } };
      }
      const nature = etat.apiNonPdf?.[f.numero] || etat.apiNonPdf?.['*'];
      if (nature) return apiNonPdf(nature);
      return {
        corps: pdfInvente(`facture inventee ${f.numero}`),
        entetes: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="facture-${f.numero}.pdf"` },
      };
    }
    // Lot 95 — le LIEN « PDF » : une page de l'application, à toute demande.
    if (/^\/billing\/[^/]+\/invoices\/[^/]+\/[^/]+\/pdf$/.test(url.pathname)) {
      etat.compteurs.liens++;
      return pageDuLienPdf(url);
    }
    if (!url.pathname.startsWith('/billing')) {
      return { statut: 404, html: faux92gabarit('Introuvable', '<h1>Introuvable</h1>') };
    }
    if (!sessionVivante() || etat.sessionFacturation === false) {
      const cible = `/billing/api/v5/login?redirect=${encodeURIComponent(url.href)}`;
      return { html: renvoi(cible) };
    }
    if (url.pathname === '/billing' || url.pathname === '/billing/') return { html: listeOrganisations(etat) };
    let m = /^\/billing\/([^/]+)\/invoices$/.exec(url.pathname);
    if (m) {
      const org = etat.organisations.find((o) => o.id === m[1]);
      if (!org) return { html: renvoi('/billing') };
      const n = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      return { html: pageFactures(etat, org, n) };
    }
    m = /^\/billing\/([^/]+)\/(overview|orders|prepaid|autorenew|settings)$/.exec(url.pathname);
    if (m) return { html: faux92gabarit('Facturation - Gandi.net', `${enteteGandi()}<main><h1>${m[2]}</h1></main>`) };
    return { statut: 404, html: faux92gabarit('Introuvable', '<h1>Introuvable</h1>') };
  };
}

function faux92gabarit(titre, corps, options) {
  return gabarit(titre, corps, options);
}

// ---------------------------------------------------------------------------
// Le navigateur, ses compteurs, ses filets
// ---------------------------------------------------------------------------

/**
 * Branche le banc sur un contexte : TOUTES ses requêtes passent par `servir`
 * pour les hôtes de `hotes`, le reste est avorté ; clics, saisies, écritures,
 * visites et fuites sont comptés dans `journal`.
 */
async function brancherBanc(contexte, hotes, servir, journal) {
  const permis = new Set([].concat(hotes));
  contexte.on('request', (requete) => {
    if (requete.redirectedFrom()) journal.fuites.push(requete.url());
  });
  contexte.on('response', async (reponse) => {
    const serveur = await reponse.serverAddr().catch(() => null);
    if (serveur) journal.fuites.push(reponse.url());
  });

  await contexte.exposeBinding('__crabeClic', (_source, quoi) => {
    const { testid = '', libelle = '' } = quoi || {};
    journal.clics.push({ testid: String(testid), libelle: String(libelle) });
  });
  await contexte.exposeBinding('__crabeSaisie', (_source, quoi) => { journal.saisies.push(String(quoi)); });
  await contexte.addInitScript(() => {
    const texte = (el) => String((el && (el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '')) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
    document.addEventListener('click', (e) => {
      const cible = (e.target && e.target.closest && e.target.closest('a, button, [role="button"], [role="tab"], input, select, summary')) || e.target;
      try {
        window.__crabeClic({ testid: (cible && cible.getAttribute && cible.getAttribute('data-testid')) || '', libelle: texte(cible) });
      } catch { /* liaison absente */ }
    }, true);
    for (const type of ['input', 'change']) {
      document.addEventListener(type, (e) => {
        try { window.__crabeSaisie(`${type}:${(e.target && (e.target.name || e.target.id || e.target.tagName)) || '?'}`); } catch { /* */ }
      }, true);
    }
    document.addEventListener('submit', () => { try { window.__crabeSaisie('submit'); } catch { /* */ } }, true);
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
    if (requete.resourceType() === 'document') journal.visites.push(`${url.host}${url.pathname}${url.search}`);
    journal.requetes.push(`${requete.resourceType()} ${url.host}${url.pathname}${url.search}`);
    const r = await servir(url, requete);
    return route.fulfill({
      status: r.statut || 200,
      headers: r.entetes || { 'content-type': 'text/html; charset=utf-8' },
      body: r.corps !== undefined ? r.corps : (r.html || ''),
    });
  });
}

function journalVide() {
  return { clics: [], saisies: [], ecritures: [], avortees: [], visites: [], requetes: [], fuites: [] };
}

/**
 * Ouvre un vrai Chromium dont TOUTES les requêtes passent par `servir` pour
 * les hôtes de `hotes` ; le reste est avorté.
 *
 * @returns {Promise<{page, contexte, journal, fermer: () => Promise<void>}>}
 */
async function ouvrirFauxSite(hotes, servir) {
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  const contexte = await navigateur.newContext(identity.optionsContexte({ acceptDownloads: true }));
  const journal = journalVide();
  await brancherBanc(contexte, hotes, servir, journal);
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
 * Un LANCEUR de navigateur pour un connecteur qui ouvre le sien (Gandi) : le
 * vrai Chromium, dont chaque contexte — créé par le connecteur, avec sa
 * session — est branché sur le banc. Tout le chemin du connecteur est
 * éprouvé ; seul le réseau est remplacé.
 */
function lanceurFaux(hotes, servir) {
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
    // Combien de fois CE lanceur a servi : un passage qui ne l'a pas appelé a
    // ouvert un autre navigateur — peut-être un vrai, vers le vrai site.
    lancements: () => ouverts.length,
    // Les navigateurs encore ouverts — 0 attendu : le connecteur ferme le sien.
    ouverts: () => ouverts.filter((n) => n.isConnected()).length,
    fermer: async () => { for (const n of ouverts) await n.close().catch(() => {}); },
  };
}

/** Une session d'essai, valide pour `session-state` (cookie inventé, pas expiré). */
function sessionInventee() {
  return JSON.stringify({
    cookies: [{
      name: 'jeton-invente', value: 'valeur-inventee', domain: 'id.gandi.net', path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    origins: [],
  });
}

module.exports = {
  PLAYWRIGHT,
  SANS_NAVIGATEUR,
  BRICOMARCHE,
  GANDI_ADMIN,
  GANDI_ID,
  MOIS_ABREGES,
  pdfInvente,
  gabarit,
  renvoi,
  siteBricomarche,
  testidsBricomarche,
  ordreDuPanneau,
  siteGandi,
  pageDuLienPdf,
  apiNonPdf,
  compteGandiDEssai,
  facturesInventees,
  idOrganisation,
  dateAffichee,
  ouvrirFauxSite,
  lanceurFaux,
  sessionInventee,
  surLeFauxProfil,
  contexteEnregistreur,
};
