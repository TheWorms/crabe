'use strict';

/**
 * Lot 102 — la page des factures de l'Eau d'Île-de-France, RECONSTITUÉE, servie
 * à un vrai Chromium sans que rien ne sorte de la machine.
 *
 * ─── §1. D'où vient sa forme ─────────────────────────────────────────────────
 *
 * Le 11/10/2026, l'utilisateur a enregistré, connecté, le code source de la page « Mes
 * Factures » et en a fait une capture. Le prompt du lot 102 en a repris la
 * STRUCTURE, sans aucune donnée (§2) : `body.comm-page-custom-factures`,
 * `#auraLoadingBox` et ses « loadingBall », `#auraErrorMask`, le menu en
 * `li[data-menu-item-label]` et liens `javascript:void(0);`, « Mon contrat »
 * (`c-icl-contrat-details2`) et ses deux boutons, les onglets (`c-icl-tabset`),
 * les coordonnées bancaires, le solde et « PAYER MA FACTURE », et l'historique
 * `c-icl-contrat-factures-histo` : une ligne d'en-tête, puis une ligne
 * `div.slds-grid.slds-p-around_medium` par facture — `lightning-formatted-date-time`,
 * le numéro en texte (24 chiffres), `lightning-formatted-number`,
 * `span.circle_green` et « Payée », `div.download` (`data-url`, `data-numfacture`)
 * qui contient un `lightning-icon` `utility:download`. La barre d'extension du
 * navigateur du compte observé (« Remboursements Koala ») n'est PAS reconstituée : elle
 * ne vient pas du site.
 *
 * Ce qu'aucune page enregistrée ne montre est INVENTÉ, et dit comme tel :
 *
 *   - ce que fait le clic sur `div.download` (non mesuré) — une variante par
 *     voie et par issue, voir `scriptDuClic` ;
 *   - les classes de la ligne d'en-tête (pire cas : celles d'une ligne) ;
 *   - le délai du dessin (le contenu arrive par script, après un délai) ;
 *   - la page de connexion, l'historique vide, le chargement sans fin ;
 *   - les pièges : « PAYER MA FACTURE » ACTIF (désactivé chez l'utilisateur), un
 *     `div.download` hors de l'historique qui porte le numéro d'une vraie
 *     facture, un `div.download` dans l'historique au numéro qu'aucune ligne
 *     ne porte.
 *
 * Une page reconstituée prouve que le connecteur LIT cette forme. Elle ne
 * prouve rien du vrai site.
 *
 * ─── §2. L'ombre synthétique de LWC, imitée ──────────────────────────────────
 *
 * Les composants du vrai site sont des Lightning Web Components à ombre
 * SYNTHÉTIQUE. Le polyfill de Salesforce filtre, dans le monde de la page,
 * `document.querySelector(All)`, `getElementsBy…` et les requêtes du `body` :
 * ce qui est rendu À L'INTÉRIEUR d'un composant n'y apparaît pas (comportement
 * public de LWC — salesforce/lwc, PR 1195 —, non mesuré sur ce site). Le banc
 * l'imite par défaut (`etat.ombre = 'synthetique'`) : un élément qui a pour
 * ancêtre un composant (`c-…`, `lightning-…`) est invisible aux requêtes du
 * document, du `body` et d'un élément hors de son composant. Un connecteur qui
 * lirait par `document.querySelectorAll` dans la page ne verrait plus rien ;
 * le moteur de Playwright, qui travaille dans un monde isolé, voit tout.
 *
 * ─── §3. La mécanique : celle des lots 92-93 ─────────────────────────────────
 *
 * Le vrai Chromium, dont chaque contexte — créé par le connecteur, avec sa
 * session — est branché sur le banc par `context.route('**\/*')` : les hôtes
 * déclarés sont servis depuis la mémoire, toute autre requête est AVORTÉE ;
 * aucune réponse n'est une redirection HTTP (les renvois se font par la page,
 * leçon du lot 92) ; deux filets (`fuites`) : une requête qui continue une
 * redirection, une réponse qui porte une adresse de serveur. Chaque clic est
 * rapporté par la page elle-même, avec ce qu'il a touché : une icône de
 * l'historique (son numéro), une icône ailleurs, ou autre chose (son libellé).
 *
 * ⚠ Toutes les valeurs sont inventées et visiblement fausses : numéros de
 * facture « 99000… », montants « 0,00 € », client « Client d'essai », contrat
 * « ZZ-CONTRAT-ESSAI », IBAN fait de zéros, jetons « jeton-invente-… ».
 */

const faux92 = require('./lot92-faux-sites');
const faux99 = require('./lot99-faux-sites');

const { PLAYWRIGHT, SANS_NAVIGATEUR, pdfInvente } = faux92;

const HOTE = 'connexion.leaudiledefrance.fr';
/** Deux domaines du site (§2.1) où les variantes « onglet » servent leur document. */
const VISUALFORCE = 'rock-vedif--c.visualforce.com';
const FICHIERS = 'rock-vedif.file.force.com';
/** Un domaine qui n'est PAS du site — inventé, servi par le banc, jamais réel. */
const AILLEURS = 'documents.exemple.invalid';
const HOTES = [HOTE, VISUALFORCE, FICHIERS, AILLEURS];

const CHEMIN_FACTURES = '/espace-particuliers/s/factures';
const CHEMIN_CONNEXION = '/espace-particuliers/s/login/';

/** La session du banc : le cookie inventé du lot 99, sur le domaine du site. */
const sessionInventee = () => faux99.sessionInventee(HOTE);
const { COOKIE } = faux99;

async function sessionPortee(requete) {
  try {
    const entetes = await requete.allHeaders();
    return String(entetes.cookie || '').split(/;\s*/).includes(`${COOKIE.name}=${COOKIE.value}`);
  } catch {
    return false;
  }
}

/** Un numéro de facture inventé : 24 chiffres, « 99 » puis des zéros, puis le rang. */
function numeroInvente(rang) {
  return `99${String(rang).padStart(22, '0')}`;
}

/** Un jeton inventé, à l'allure d'une chaîne base64 encodée en pourcentage. */
function jetonInvente(numero) {
  return encodeURIComponent(Buffer.from(`jeton-invente-pour-essai-${numero.slice(-4)}==`).toString('base64'));
}

/** Le numéro d'un jeton du banc, ou `null`. */
function numeroDuJeton(jeton, etat) {
  const f = (etat.factures || []).find((x) => jetonInvente(x.numero) === jeton
    || decodeURIComponent(jetonInvente(x.numero)) === jeton);
  return f ? f.numero : null;
}

/**
 * Trois factures d'essai, des plus récentes aux plus anciennes. `extra`
 * remplace ce qu'il nomme : `variante` (ce que fait le clic, voir
 * `scriptDuClic`), `ombre`, `historique` ('lignes' | 'vide'), `chargement`
 * ('normal' | 'sans-fin'), `erreurAuChargement`, `pieges`, `delais`…
 */
function compteEau(extra = {}) {
  return {
    connecte: true,
    ombre: 'synthetique',
    variante: 'telechargement',
    historique: 'lignes',
    chargement: 'normal',
    pieges: true,
    // Le dessin : l'attente d'Aura, puis l'historique (en-tête et indicateur),
    // puis ses lignes — INVENTÉ, faute de mesure.
    delaiChargementMs: 300,
    delaiLignesMs: 400,
    factures: [
      { numero: numeroInvente(1), date: '12/09/2026' },
      { numero: numeroInvente(2), date: '14/03/2026' },
      { numero: numeroInvente(3), date: '10/09/2025' },
    ],
    ...extra,
  };
}

function echapper(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/**
 * L'imitation du polyfill d'ombre synthétique (§2), posée AVANT tout rendu.
 * Les fonctions natives sont gardées pour le script du banc lui-même.
 */
const SCRIPT_OMBRE = `
  (function () {
    const estHote = (el) => !!el && el.nodeType === 1 && /^(c|lightning)-/i.test(el.localName || '');
    const hoteDe = (el) => { for (let e = el && el.parentElement; e; e = e.parentElement) if (estHote(e)) return e; return null; };
    const filtrer = (liste, garder) => Array.prototype.filter.call(liste, garder);
    const D = Document.prototype, E = Element.prototype;
    const nat = { dQSA: D.querySelectorAll, dQS: D.querySelector, dTag: D.getElementsByTagName, dCls: D.getElementsByClassName,
      dId: D.getElementById, eQSA: E.querySelectorAll, eQS: E.querySelector };
    window.__natif = nat;
    D.querySelectorAll = function (s) { return filtrer(nat.dQSA.call(this, s), (el) => !hoteDe(el)); };
    D.querySelector = function (s) { return filtrer(nat.dQSA.call(this, s), (el) => !hoteDe(el))[0] || null; };
    D.getElementsByTagName = function (s) { return filtrer(nat.dTag.call(this, s), (el) => !hoteDe(el)); };
    D.getElementsByClassName = function (s) { return filtrer(nat.dCls.call(this, s), (el) => !hoteDe(el)); };
    D.getElementById = function (s) { const el = nat.dId.call(this, s); return el && !hoteDe(el) ? el : null; };
    // Depuis un élément : seuls les éléments de SON arbre (même composant
    // propriétaire) ; depuis un composant, rien de son intérieur.
    E.querySelectorAll = function (s) {
      const proprietaire = estHote(this) ? this : hoteDe(this);
      return filtrer(nat.eQSA.call(this, s), (el) => hoteDe(el) === (estHote(this) ? hoteDe(this) : proprietaire));
    };
    E.querySelector = function (s) { return this.querySelectorAll(s)[0] || null; };
  })();`;

/** Le cadre de la page : menu, « Mon contrat », onglets, coordonnées, solde, bulle — et les pièges. */
function cadre(etat) {
  const premier = etat.factures[0]?.numero || numeroInvente(1);
  const menu = ['Accueil', 'Contrat actif', 'Consommation', 'Alertes de consommation', 'Factures & Paiements',
    'Tous mes contrats', 'Échanges & RDV', 'Aide & Contact', 'Mon profil', 'Déconnexion']
    .map((libelle) => `<li data-menu-item-label="${echapper(libelle)}"><a href="javascript:void(0);" data-piege="menu ${echapper(libelle)}">${echapper(libelle)}</a></li>`)
    .join('');
  // Le piège hors de l'historique porte le numéro de la PREMIÈRE facture : un
  // repère relâché le trouverait (morsure du D2).
  const horsHistorique = etat.pieges
    ? `<div class="download" data-piege="icône hors de l'historique" data-url="${jetonInvente(premier)}" data-numfacture="${premier}">
         <lightning-icon icon-name="utility:download"><span class="slds-icon_container"><svg class="slds-icon" width="16" height="16"><rect width="16" height="16"></rect></svg></span></lightning-icon></div>`
    : '';
  return `
  <div id="auraLoadingBox" class="auraLoadingBox" style="position:fixed;inset:0;background:#fff;z-index:100">
    <div class="loadingBall" style="display:inline-block;width:12px;height:12px;border-radius:6px;background:#0070d2"></div>
    <div class="loadingBall" style="display:inline-block;width:12px;height:12px;border-radius:6px;background:#0070d2"></div>
    <div class="loadingBall" style="display:inline-block;width:12px;height:12px;border-radius:6px;background:#0070d2"></div></div>
  <div id="auraErrorMask" style="display:none"><div id="auraErrorMessage"></div></div>
  <nav class="menu-lateral"><ul>${menu}</ul></nav>
  <main id="contenu" style="display:none">
    <c-icl-contrat-details2>
      <h2>Mon contrat</h2>
      <p>Contrat n° ZZ-CONTRAT-ESSAI — solde 0,00 €</p>
      <p>Adresse de consommation : 1 rue de l'Exemple, 00000 Ville-d'Essai</p>
      <p>Adresse de correspondance : 1 rue de l'Exemple, 00000 Ville-d'Essai</p>
      <button type="button" class="slds-button" data-piege="attestation">Télécharger une attestation de contrat</button>
      <button type="button" class="slds-button" data-piege="signaler">Signaler un changement</button>
      ${horsHistorique}
    </c-icl-contrat-details2>
    <c-icl-tabset>
      <ul class="slds-tabs_default__nav" role="tablist">
        <li role="presentation"><a role="tab" href="javascript:void(0);" data-piege="onglet Consommation">Consommation</a></li>
        <li role="presentation" class="slds-is-active"><a role="tab" href="javascript:void(0);" aria-selected="true" data-piege="onglet Factures">Factures &amp; Paiements</a></li>
      </ul>
      <div class="slds-tabs_default__content">
        <section><h3>Mes coordonnées bancaires</h3><p>Titulaire : Client d'essai — IBAN FR76 **** **** **** **** **** 000</p>
          <button type="button" class="slds-button" data-piege="coordonnées">Modifier mes coordonnées</button></section>
        <section><h3>Modalités de paiement</h3><p>Prélèvement d'essai</p></section>
        <section><h3>Mon solde actuel</h3><p>0,00 €</p><p>Dernière facture du 12/09/2026</p>
          <p>Prochaine facture émise vers le 12/03/2027</p>
          <button type="button" class="slds-button slds-button_brand" data-piege="payer">PAYER MA FACTURE</button>
          <a href="javascript:void(0);" data-piege="comprendre">Comprendre mon solde</a>
          <a href="javascript:void(0);" data-piege="déménage">J'emménage / Je déménage</a></section>
        <c-icl-contrat-factures-histo id="historique"></c-icl-contrat-factures-histo>
      </div>
    </c-icl-tabset>
  </main>
  <div class="embeddedServiceHelpButton"><button type="button" class="helpButtonEnabled" data-piege="bulle">Discuter avec nous</button></div>`;
}

/** Une ligne de facture, telle que l'annonce la décrit. */
function ligneFacture(f) {
  const numeroIcone = f.numeroIcone ?? f.numero;
  const icone = f.sansIcone ? '' : `
        <div class="slds-col slds-size_1-of-5"><div class="download" data-url="${jetonInvente(f.numero)}" data-numfacture="${numeroIcone}">
          <lightning-icon icon-name="utility:download" class="slds-icon-utility-download"><span class="slds-icon_container">
            <svg class="slds-icon slds-icon_x-small" width="16" height="16" aria-hidden="true"><rect width="16" height="16"></rect></svg>
          </span></lightning-icon></div></div>`;
  return `
      <div class="slds-grid slds-p-around_medium" lwc-2zzzzzzzzzz>
        <div class="slds-col slds-size_1-of-5"><lightning-formatted-date-time>${f.date}</lightning-formatted-date-time></div>
        <div class="slds-col slds-size_1-of-5">${f.numeroTexte ?? f.numero}</div>
        <div class="slds-col slds-size_1-of-5"><lightning-formatted-number>0,00 €</lightning-formatted-number></div>
        <div class="slds-col slds-size_1-of-5"><span class="circle_green"></span>Payée</div>${icone}
      </div>`;
}

/** L'historique dessiné : titre, en-tête (aux classes d'une ligne), lignes, et le piège au numéro non lu. */
function historiqueDessine(etat, { lignes = true } = {}) {
  const entete = `
      <div class="slds-grid slds-p-around_medium entete">
        <div class="slds-col">Date</div><div class="slds-col">Numéro de facture</div><div class="slds-col">Montant</div>
        <div class="slds-col">Statut</div><div class="slds-col">Téléchargement</div>
      </div>`;
  const corps = lignes && etat.historique !== 'vide' ? etat.factures.map(ligneFacture).join('') : '';
  // Dans l'historique, mais sur aucune ligne : une icône dont le numéro
  // n'est lu nulle part.
  const nonLu = etat.pieges
    ? `<div class="pied">Récapitulatif <div class="download" data-piege="icône au numéro non lu" data-url="${jetonInvente(numeroInvente(999))}" data-numfacture="${numeroInvente(999)}">
         <lightning-icon icon-name="utility:download"><span class="slds-icon_container"><svg width="16" height="16"><rect width="16" height="16"></rect></svg></span></lightning-icon></div></div>`
    : '';
  const attente = lignes ? '' : '<lightning-spinner alternative-text="Chargement"><div class="slds-spinner" role="status" style="width:20px;height:20px"></div></lightning-spinner>';
  return `<h2>HISTORIQUE DE MES FACTURES</h2><div class="slds-scrollable_y" style="max-height:400px">${entete}${corps}</div>${attente}${nonLu}`;
}

/**
 * Le script de la page : l'imitation de l'ombre (§2), le dessin après délai,
 * les pièges qui se signalent, et l'effet du clic sur une icône.
 *
 * L'effet du clic — MÉCANIQUE INVENTÉE, la vraie n'est pas mesurée — selon la
 * variante (`f.variante`, sinon `etat.variante`) :
 *   - `telechargement` : un appel au serveur (POST, comme un appel Aura) rend
 *     le PDF en base64, la page en fait un fichier et le télécharge par un
 *     lien `download` hors du document ;
 *   - `onglet` : un onglet sur une page Visualforce (domaine du site), une
 *     visionneuse qui va chercher le PDF et le lit en `arrayBuffer` ;
 *   - `onglet-blob` : la même visionneuse, qui lit le PDF en `blob` — mesuré
 *     le 11/10/2026 sur le banc ET sur un vrai serveur local : le corps d'une
 *     réponse lue en `blob` revient VIDE à Playwright ; le socle ne peut pas
 *     le prendre dans un onglet (limite nommée, l'arrêt est dit) ;
 *   - `onglet-pdf` : un onglet ouvert droit sur le PDF (domaine du site) —
 *     mesuré : sans écran, il arrive comme un téléchargement de la page ;
 *   - `reponse` : un appel au serveur rend le PDF, que la page lit en
 *     `arrayBuffer` et garde ;
 *   - `reponse-blob` : le même, lu en `blob` — le socle redemande alors le
 *     document dans la page (deux demandes au serveur) ;
 *   - `non-pdf` : le « document » téléchargé est une page d'erreur ;
 *   - `erreur-aura` : le message d'erreur de Salesforce (`#auraErrorMask`) ;
 *   - `toast-erreur` : un bandeau d'erreur ;
 *   - `fenetre` : une fenêtre modale de Salesforce, avec ses boutons ;
 *   - `native` : une boîte de confirmation du navigateur ;
 *   - `page` : la page part vers une autre page du site ;
 *   - `connexion` : la page part vers la page de connexion ;
 *   - `onglet-ailleurs` : un onglet sur un AUTRE domaine, qui sert un PDF ;
 *   - `onglet-ailleurs-html` : un onglet sur un autre domaine, une page ;
 *   - `rien` : rien.
 */
function scriptDePage(etat) {
  const factures = etat.factures.map((f) => ({ numero: f.numero, jeton: jetonInvente(f.numero), variante: f.variante || etat.variante }));
  return `
    ${etat.ombre === 'synthetique' ? SCRIPT_OMBRE : 'window.__natif = null;'}
    (function () {
      const FACTURES = ${JSON.stringify(factures)};
      const VISUALFORCE = ${JSON.stringify(VISUALFORCE)};
      const FICHIERS = ${JSON.stringify(FICHIERS)};
      const AILLEURS = ${JSON.stringify(AILLEURS)};
      const tous = (racine, s) => (window.__natif ? window.__natif.eQSA.call(racine, s) : racine.querySelectorAll(s));
      const parId = (id) => (window.__natif ? window.__natif.dId.call(document, id) : document.getElementById(id));
      const signaler = (quoi) => fetch('/__banc/piege?quoi=' + encodeURIComponent(quoi)).catch(() => {});
      for (const el of tous(document.body, '[data-piege]')) {
        el.addEventListener('click', () => signaler(el.getAttribute('data-piege')));
      }
      function telechargerBlob(blob, nom) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nom;
        a.click();
      }
      function depuisBase64(b64, type) {
        const binaire = atob(b64);
        const octets = new Uint8Array(binaire.length);
        for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
        return new Blob([octets], { type });
      }
      function appelAura(jeton, casse) {
        return fetch('/espace-particuliers/s/sfsites/aura?r=1&other.IclFactures.telecharger=1' + (casse ? '&casse=1' : ''), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jeton }),
        }).then((r) => r.json());
      }
      function auClic(facture) {
        const jeton = facture.jeton;
        switch (facture.variante) {
          case 'telechargement':
            appelAura(jeton).then((r) => telechargerBlob(depuisBase64(r.returnValue, 'application/pdf'), 'Facture.pdf'));
            break;
          case 'non-pdf':
            appelAura(jeton, true).then((r) => telechargerBlob(depuisBase64(r.returnValue, 'application/pdf'), 'Facture.pdf'));
            break;
          case 'onglet': window.open('https://' + VISUALFORCE + '/apex/IclFactureVue?jeton=' + jeton); break;
          case 'onglet-blob': window.open('https://' + VISUALFORCE + '/apex/IclFactureVue?lecture=blob&jeton=' + jeton); break;
          case 'onglet-pdf': window.open('https://' + FICHIERS + '/sfc/servlet.shepherd/document/download/ZZESSAI?jeton=' + jeton); break;
          case 'reponse':
            fetch('/espace-particuliers/s/sfsites/c/IclFacture?jeton=' + jeton).then((r) => r.arrayBuffer()).then((b) => { window.__facture = b; });
            break;
          case 'reponse-blob':
            fetch('/espace-particuliers/s/sfsites/c/IclFacture?jeton=' + jeton).then((r) => r.blob()).then((b) => { window.__facture = b; });
            break;
          case 'erreur-aura': {
            const masque = parId('auraErrorMask');
            parId('auraErrorMessage').textContent = 'Une erreur inattendue est survenue (essai).';
            masque.style.display = 'block';
            break;
          }
          case 'toast-erreur': {
            const t = document.createElement('div');
            t.className = 'slds-notify slds-notify_toast slds-theme_error';
            t.setAttribute('role', 'alert');
            t.textContent = 'Le document est indisponible (essai).';
            document.body.appendChild(t);
            break;
          }
          case 'fenetre': {
            const s = document.createElement('section');
            s.className = 'slds-modal slds-fade-in-open';
            s.setAttribute('role', 'dialog');
            s.setAttribute('aria-modal', 'true');
            s.innerHTML = '<div class="slds-modal__container"><h2>Votre facture</h2><p>Recevoir la facture par courrier ?</p>'
              + '<button type="button" data-piege="fenêtre Envoyer">Envoyer</button><button type="button" data-piege="fenêtre Fermer">Fermer</button></div>';
            for (const b of tous(s, '[data-piege]')) b.addEventListener('click', () => signaler(b.getAttribute('data-piege')));
            document.body.appendChild(s);
            break;
          }
          case 'native': document.body.dataset.confirme = String(confirm('Télécharger la facture ? (essai)')); break;
          case 'page': location.assign('/espace-particuliers/s/document-indisponible'); break;
          case 'connexion': location.assign('/espace-particuliers/s/login/?startURL=%2Fespace-particuliers%2Fs%2Ffactures'); break;
          case 'onglet-ailleurs': window.open('https://' + AILLEURS + '/facture.pdf?jeton=' + jeton); break;
          case 'onglet-ailleurs-html': window.open('https://' + AILLEURS + '/visionneuse?jeton=' + jeton); break;
          default: break;
        }
      }
      function dessinerLignes() {
        const h = parId('historique');
        h.innerHTML = ${JSON.stringify(historiqueDessine(etat, { lignes: true }))};
        for (const el of tous(h, '[data-piege]')) el.addEventListener('click', () => signaler(el.getAttribute('data-piege')));
        for (const icone of tous(h, '.slds-grid div.download')) {
          const facture = FACTURES.find((f) => f.jeton === icone.getAttribute('data-url'));
          if (facture) icone.addEventListener('click', () => auClic(facture));
        }
      }
      setTimeout(() => {
        ${etat.chargement === 'sans-fin' ? 'return;' : ''}
        parId('auraLoadingBox').style.display = 'none';
        ${etat.erreurAuChargement ? `parId('auraErrorMask').style.display = 'block'; parId('auraErrorMessage').textContent = 'Erreur (essai)'; return;` : ''}
        parId('contenu').style.display = 'block';
        parId('historique').innerHTML = ${JSON.stringify(historiqueDessine(etat, { lignes: false }))};
        setTimeout(dessinerLignes, ${Number(etat.delaiLignesMs) || 0});
      }, ${Number(etat.delaiChargementMs) || 0});
    })();`;
}

function gabarit(titre, corps, { script = '', body = '' } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title></head>
<body${body}>${corps}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** Un renvoi fait par la PAGE, jamais par une réponse 3xx (lot 92). */
function renvoi(adresse) {
  return gabarit('Redirection', '', { script: `location.replace(${JSON.stringify(adresse)});` });
}

function pageFactures(etat) {
  return gabarit('Mes Factures', cadre(etat), { script: scriptDePage(etat), body: ' class="comm-page-custom-factures"' });
}

/** La page de connexion — INVENTÉE (non mesurée) : un formulaire dans un composant. */
function pageConnexion() {
  return gabarit('Connexion', `
    <c-icl-login><h1>Connectez-vous à votre espace</h1>
      <form method="post" action="/espace-particuliers/s/sfsites/login"><label>Identifiant <input type="email" name="identifiant"></label>
        <label>Mot de passe <input type="password" name="motdepasse"></label><button type="submit">Se connecter</button></form>
    </c-icl-login>`, { body: ' class="comm-page-login"' });
}

/**
 * Le faux site. `etat` : voir `compteEau`. Il compte, dans `etat.compteurs` :
 * `listes` (pages des factures servies), `appels` (appels « Aura » et leur
 * numéro), `pdf` (PDF servis, par numéro), `pieges` (pièges signalés par la
 * page), `ailleurs` (requêtes vers le domaine étranger), `sansSession`.
 * `etat.surPdf(n)` est appelé à chaque PDF servi (horloge des essais).
 */
function siteEau(etat) {
  etat.compteurs = { listes: 0, appels: [], pdf: [], pieges: [], ailleurs: [], sansSession: 0, connexions: 0 };
  let servis = 0;
  const servirPdf = (numero) => {
    servis += 1;
    etat.surPdf?.(servis);
    etat.compteurs.pdf.push(numero);
    return pdfInvente(`facture inventee eau ${numero}`);
  };
  return async (url, requete) => {
    const vivante = etat.connecte && await sessionPortee(requete)
      && !(Number.isFinite(etat.sessionMeurtApresPdf) && servis >= etat.sessionMeurtApresPdf);
    if (url.host === AILLEURS) {
      etat.compteurs.ailleurs.push(url.pathname);
      if (url.pathname === '/facture.pdf') {
        return { corps: pdfInvente('document d\'un autre domaine'), entetes: { 'content-type': 'application/pdf' } };
      }
      return { html: gabarit('Visionneuse', '<h1>Un autre site</h1>') };
    }
    if (url.host === VISUALFORCE) {
      const numero = numeroDuJeton(url.searchParams.get('jeton'), etat);
      if (url.pathname === '/apex/IclFactureVue') {
        const lecture = url.searchParams.get('lecture') === 'blob' ? 'r.blob()' : 'r.arrayBuffer()';
        return {
          html: gabarit('Facture', '<p>Chargement de votre facture…</p>', {
            script: `fetch('/apex/IclFactureFlux?jeton=${encodeURIComponent(url.searchParams.get('jeton') || '')}')`
              + `.then((r) => ${lecture}).then((b) => { document.body.dataset.recu = String(b.size || b.byteLength); });`,
          }),
        };
      }
      if (url.pathname === '/apex/IclFactureFlux' && numero) {
        return { corps: servirPdf(numero), entetes: { 'content-type': 'application/pdf' } };
      }
      return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
    }
    if (url.host === FICHIERS) {
      const numero = numeroDuJeton(url.searchParams.get('jeton'), etat);
      if (numero) return { corps: servirPdf(numero), entetes: { 'content-type': 'application/pdf' } };
      return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
    }
    // Le site lui-même.
    if (url.pathname === '/__banc/piege') {
      etat.compteurs.pieges.push(url.searchParams.get('quoi'));
      return { statut: 204, html: '' };
    }
    if (url.pathname === CHEMIN_FACTURES) {
      etat.compteurs.listes += 1;
      if (!vivante) {
        etat.compteurs.sansSession += 1;
        return { html: renvoi(`${CHEMIN_CONNEXION}?startURL=%2Fespace-particuliers%2Fs%2Ffactures`) };
      }
      return { html: pageFactures(etat) };
    }
    if (url.pathname === CHEMIN_CONNEXION) {
      etat.compteurs.connexions += 1;
      return { html: pageConnexion() };
    }
    if (url.pathname === '/espace-particuliers/s/document-indisponible') {
      return { html: gabarit('Document indisponible', '<h1>Ce document n\'est pas disponible</h1>', { body: ' class="comm-page-custom-erreur"' }) };
    }
    if (url.pathname === '/espace-particuliers/s/sfsites/aura' && requete.method() === 'POST') {
      let jeton = null;
      try { jeton = JSON.parse(requete.postData() || '{}').jeton; } catch { jeton = null; }
      const numero = numeroDuJeton(jeton, etat);
      etat.compteurs.appels.push(numero || '?');
      if (!vivante || !numero) return { corps: Buffer.from('{"error":"essai"}'), entetes: { 'content-type': 'application/json' } };
      const contenu = url.searchParams.get('casse')
        ? Buffer.from('<!doctype html><html><body>Une erreur est survenue (essai)</body></html>', 'latin1')
        : servirPdf(numero);
      return { corps: Buffer.from(JSON.stringify({ returnValue: contenu.toString('base64') })), entetes: { 'content-type': 'application/json' } };
    }
    if (url.pathname === '/espace-particuliers/s/sfsites/c/IclFacture') {
      const numero = numeroDuJeton(url.searchParams.get('jeton'), etat);
      if (!vivante || !numero) return { statut: 403, html: '' };
      return { corps: servirPdf(numero), entetes: { 'content-type': 'application/pdf' } };
    }
    return { statut: 404, html: gabarit('Introuvable', '<h1>Introuvable</h1>') };
  };
}

// ---------------------------------------------------------------------------
// Le navigateur, ses compteurs, ses filets
// ---------------------------------------------------------------------------

function journalVide() {
  return { clics: [], saisies: [], ecritures: [], avortees: [], visites: [], requetes: [], fuites: [], onglets: 0 };
}

/**
 * Branche le banc sur un contexte : TOUTES ses requêtes passent par `servir`
 * pour les hôtes de `hotes`, le reste est avorté ; clics, saisies, écritures,
 * visites et fuites sont comptés dans `journal`.
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

  await contexte.exposeBinding('__crabeClic102', (source, quoi) => {
    journal.clics.push({
      zone: String(quoi?.zone || ''),
      numero: String(quoi?.numero || ''),
      libelle: String(quoi?.libelle || ''),
      // Les pages ouvertes au moment du clic : un onglet du clic précédent
      // resté ouvert se verrait ici.
      pages: source?.context?.pages?.().length ?? null,
    });
  });
  await contexte.exposeBinding('__crabeSaisie102', (_source, quoi) => { journal.saisies.push(String(quoi)); });
  await contexte.addInitScript(() => {
    document.addEventListener('click', (e) => {
      const cible = e.target;
      const icone = cible && cible.closest ? cible.closest('div.download') : null;
      const actif = cible && cible.closest
        ? cible.closest('a, button, [role="button"], [role="tab"], li[data-menu-item-label], input, select, summary')
        : null;
      const zone = icone ? (icone.closest('c-icl-contrat-factures-histo') ? 'historique' : 'ailleurs') : 'autre';
      try {
        window.__crabeClic102({
          zone,
          numero: icone ? (icone.getAttribute('data-numfacture') || '') : '',
          libelle: String((actif && (actif.innerText || actif.getAttribute('data-piege'))) || (cible && cible.localName) || '')
            .replace(/\s+/g, ' ').trim().slice(0, 80),
        });
      } catch { /* liaison absente */ }
    }, true);
    for (const type of ['input', 'change']) {
      document.addEventListener(type, (e) => {
        try { window.__crabeSaisie102(`${type}:${(e.target && (e.target.name || e.target.id || e.target.tagName)) || '?'}`); } catch { /* */ }
      }, true);
    }
    document.addEventListener('submit', () => { try { window.__crabeSaisie102('submit'); } catch { /* */ } }, true);
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
    journal.requetes.push(`${requete.resourceType()} ${url.host}${url.pathname}`);
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
 * contexte — créé par le connecteur, avec sa session — est branché sur le
 * banc. Tout le chemin du connecteur est éprouvé ; seul le réseau est remplacé.
 */
function lanceurFaux(servir, hotes = HOTES) {
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

/**
 * Une page du faux site ouverte directement (sans le connecteur), pour les
 * essais qui regardent la page elle-même — imitation de l'ombre, fenêtre de
 * connexion.
 */
async function ouvrirLaPage(etat, { session = true } = {}) {
  const servir = siteEau(etat);
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  const contexte = await navigateur.newContext({
    acceptDownloads: true,
    ...(session ? { storageState: JSON.parse(sessionInventee()) } : {}),
  });
  const journal = journalVide();
  await brancherBanc(contexte, HOTES, servir, journal);
  const page = await contexte.newPage();
  page.setDefaultTimeout(15_000);
  return {
    navigateur,
    contexte,
    page,
    journal,
    fermer: async () => { await navigateur.close().catch(() => {}); },
  };
}

module.exports = {
  PLAYWRIGHT,
  SANS_NAVIGATEUR,
  HOTE,
  VISUALFORCE,
  FICHIERS,
  AILLEURS,
  HOTES,
  CHEMIN_FACTURES,
  CHEMIN_CONNEXION,
  COOKIE,
  numeroInvente,
  jetonInvente,
  sessionInventee,
  compteEau,
  siteEau,
  pageFactures,
  lanceurFaux,
  ouvrirLaPage,
};
