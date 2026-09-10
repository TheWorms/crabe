'use strict';

/**
 * Connecteur Materiel.net — matériel informatique.
 *
 * **ÉCRIT MAIS JAMAIS EXÉCUTÉ CONTRE UN VRAI COMPTE** (lot 30, 14/08/2026).
 * Tout ce qui est écrit ici a été mesuré sur les pages PUBLIQUES du site, sans
 * aucun identifiant et sans jamais tenter de connexion ; ce qui vient après le
 * formulaire est déduit de l'aide officielle et signalé comme tel, à chaque
 * fois. D'où `initialStatus: pending` dans le manifeste : installable par l'administrateur
 * seul, invisible pour les autres, jusqu'à ce qu'une vraie facture soit
 * descendue.
 *
 * ─── L'adresse n'est pas celle qu'on devine ──────────────────────────────────
 *
 * `www.materiel.net/client/connexion/` renvoie une redirection permanente vers
 * l'accueil ; `/client/` et `/login/` rendent 404. C'est un sous-domaine
 * distinct qui porte l'espace client :
 *
 *   connexion : https://secure.materiel.net/Login/Login?returnUrl=%2FOrders
 *   commandes : https://secure.materiel.net/Orders
 *
 * Ces deux routes-là existent réellement (302 vers le formulaire quand on n'est
 * pas connecté), et la sonde qui l'a établi DISCRIMINE : `/Orders/Details`,
 * `/Orders/Invoice`, `/Invoice`, `/Facture` et douze autres rendent 404, tout
 * comme le témoin `/Orders/ceci-nexiste-pas-42`.
 *
 * ─── Se connecter le moins souvent possible ──────────────────────────────────
 *
 * C'est le principe qui gouverne tout ce fichier, et il tient à une ligne du
 * formulaire :
 *
 *   <form data-captcha-url="/Login/PartialCaptchaByIpOrEmail" …>
 *
 * Le site sait afficher un captcha et décide de le faire **selon l'adresse IP
 * ou l'adresse électronique**. Il ne s'est pas déclenché le 13/08/2026 (le
 * fragment rend 200 avec un corps vide, en GET comme en POST), mais un
 * connecteur qui resoumettrait le formulaire à chaque passage finirait par le
 * réveiller. Trois précautions, donc :
 *
 *   1. **un profil de navigateur persistant** — la session survit d'une
 *      exécution à l'autre (connectors/profil-persistant.js) ;
 *   2. **la page des commandes tentée AVANT toute connexion** — si elle est
 *      servie, le formulaire n'est même pas ouvert ;
 *   3. **la case « Rester connecté » cochée** — elle allonge la session côté
 *      serveur, donc espace d'autant les soumissions.
 *
 * En régime établi, ce connecteur ne se connecte donc presque jamais.
 *
 * ─── Le piège du bouton ──────────────────────────────────────────────────────
 *
 * La page porte DEUX boutons, et le mauvais est écrit en premier :
 *
 *   <button type="button" class="toggle-password">   ← l'œil « afficher le mot de passe »
 *   <button type="submit" class="button o-btn …">    ← « Connexion »
 *
 * Un sélecteur de bouton mal ajusté clique l'œil et n'envoie rien — c'est
 * exactement la panne qui a immobilisé L'Atelier du Portable pendant un lot.
 * D'où la soumission par la touche **Entrée** depuis le champ mot de passe :
 * elle soumet le formulaire qui contient le champ, sans désigner quoi que ce
 * soit.
 *
 * ─── La facture se LIT, elle ne se construit pas ─────────────────────────────
 *
 * Contrairement à L'Atelier du Portable, dont l'adresse de facture suit un
 * schéma fixe, ici **rien n'est devinable** : seize noms de route ont été
 * tentés, tous en 404. L'adresse vit donc dans la page des commandes, et le
 * connecteur la cherche dans le DOM. C'est le seul choix honnête tant qu'aucun
 * compte n'a permis de voir cette page.
 *
 * ─── Ce qui n'est JAMAIS fait ────────────────────────────────────────────────
 *
 * **Aucune deuxième tentative de connexion.** Des identifiants refusés
 * arrêtent le connecteur : insister sur un formulaire peut faire bloquer le
 * compte, et déclencherait à coup sûr le captcha conditionnel.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const identity = require('../../browser-identity');
const history = require('../../history');
const profilPersistant = require('../../profil-persistant');
const preuveConnexion = require('../../preuve-connexion');
const pageDocs = require('../../documents-de-page');

/** L'identifiant du connecteur — il nomme aussi son répertoire de profil. */
const ID = 'materiel-net';

const URL_CONNEXION = 'https://secure.materiel.net/Login/Login?returnUrl=%2FOrders';
const URL_COMMANDES = 'https://secure.materiel.net/Orders';

const VIEWPORT = { width: 1500, height: 950 };
const NAV_TIMEOUT_MS = 45_000;
const PAUSE_DOCUMENT_MS = 350;

const CHAMP_EMAIL = 'email';
const CHAMP_MOT_DE_PASSE = 'motDePasse';
const CHAMP_HISTORIQUE = 'historique';

/**
 * Le formulaire de connexion, désigné par ce qu'il est le seul à contenir.
 *
 * Jamais par sa position : la page porte aussi un formulaire de recherche, et
 * viser « le premier formulaire » soumettrait une recherche vide au lieu de se
 * connecter.
 */
const FORMULAIRE_CONNEXION = 'form:has(input[type="password"])';

/**
 * Le conteneur où le captcha conditionnel se rendrait.
 *
 * Il est présent et VIDE dans le formulaire servi aujourd'hui
 * (`<div class="captcha-placeholder"></div>`). S'il se remplit, c'est que le
 * site a décidé d'en demander un — et il n'y a rien à faire d'autre que le
 * dire à l'utilisateur.
 */
const CONTENEUR_CAPTCHA = '.captcha-placeholder';

/** Le conteneur que le site remplit lui-même quand il refuse les identifiants. */
const MESSAGE_ERREUR_SITE = '[data-valmsg-for="LoginError"]';

/** Compte sans adresse lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/**
 * Une commande dans la page — l'ancien motif TEXTE, gardé en repli.
 *
 * ⚠ Écrit à l'aveugle au lot 30, quand la page n'avait jamais été vue. La
 * page réelle (relevée le 14/08/2026, session ouverte) n'écrit pas « commande
 * n° » : elle range chaque commande dans une structure `#completedOrdersHeader`
 * → `.historic-table` → `.historic-cell--ref` (« Nº 6053014301785C »), lue
 * par `commandesDepuisLignes`. Ce motif ne sert plus qu'en dernier recours si
 * cette structure disparaissait — et le journal dit alors lequel des deux
 * lecteurs a trouvé quelque chose.
 */
const MOTIF_COMMANDE =
  /(?:commande|n[°o]\s*de\s*commande)\s*n?[°o]?\s*[:.]?\s*([A-Z]{0,4}\d{6,})\b[^\n]{0,80}?(\d{1,2})\/(\d{1,2})\/(\d{4})/gi;

/** Un lien ou un bouton qui parle de facture — en texte comme en adresse. */
const MOTIF_LIEN_FACTURE = /facture|invoice/i;

/**
 * La liste des commandes, telle que la page réelle la construit.
 *
 * ─── Mesuré le 14/08/2026, session ouverte (relevé réel) ──────────────────
 *
 * La page `/Orders` arrive SANS ses commandes : `#completedOrdersHeader` est le
 * conteneur qu'une requête AJAX (`data-history-headers-url` =
 * `/Orders/PartialCompletedOrdersHeader`) remplit APRÈS le rendu initial. Un
 * lecteur qui prend le texte à l'arrivée lit une page sans commandes, sans
 * qu'aucune erreur ne le signale — c'est exactement le faux échec des trois
 * exécutions du 14/08 (« une page qui ne ressemble ni à vos commandes ni à un
 * espace connecté ») : le garde-fou du lot 31 refusait, à raison, de conclure
 * sur une page pas encore remplie.
 *
 * Chaque commande y est une `.historic-table` :
 *
 *   .historic-cell--ref    « Nº 6053014301785C »   ← la référence affichée
 *   .historic-cell--price  « 757€90 TTC »
 *   .historic-cell--date   « 30/05/2026 »
 *   a[data-target^="#collapse-"]  « Détails »       ← charge le détail en POST
 *
 * ⚠ L'adresse du détail porte un `orderId` (« C071801768 ») DIFFÉRENT de la
 * référence affichée : l'un sert à la requête, l'autre à nommer.
 */
const SELECTEUR_LISTE = '#completedOrdersHeader';
const SELECTEUR_LIGNES = '#completedOrdersHeader .historic-table';

/** Combien de temps laisser à la liste pour arriver après le rendu initial. */
const DELAI_LISTE_MS = 20_000;

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Le navigateur nécessaire à Materiel.net n\'est pas installé sur ce serveur. '
        + 'Signalez-le à la personne qui administre crabe.'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'La connexion à Materiel.net n\'a pas pu être rouverte. Vérifiez votre adresse et votre mot de '
  + 'passe sur la fiche du service, puis relancez. crabe ne réessaie jamais tout seul : insister '
  + 'sur un formulaire de connexion peut rendre le site inaccessible même à la main.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * Message d'identifiants refusés : il dit quoi faire, pas ce qui a planté.
 *
 * Et il ne parle de mot de passe QUE parce que c'en est réellement un : le
 * connecteur a atteint le formulaire, l'a rempli, l'a soumis, et le site l'a
 * réaffiché. Accuser les identifiants sur une obstruction ou une page qui
 * tarde enverrait l'utilisateur corriger ce qui n'a rien à se reprocher.
 */
const MESSAGE_IDENTIFIANTS =
  'Adresse électronique ou mot de passe refusé par Materiel.net. Vérifiez-les sur la fiche du '
  + 'service — au besoin, refaites votre mot de passe depuis « Mot de passe oublié » sur le site — '
  + 'puis relancez. crabe ne réessaie jamais tout seul : insister sur un formulaire de connexion '
  + 'peut faire bloquer le compte.';

function erreurIdentifiants(precision = '') {
  const err = new Error(MESSAGE_IDENTIFIANTS + (precision ? ` (${precision})` : ''));
  err.credentialsRejected = true;
  return err;
}

/** Message d'identifiants absents de la fiche. */
function erreurIdentifiantsManquants() {
  return new Error(
    'Renseignez votre adresse électronique et votre mot de passe Materiel.net sur la fiche du '
      + 'service.'
  );
}

/**
 * Message du captcha conditionnel.
 *
 * Il ne se contourne pas, et le lui faire croire serait pire que de s'arrêter :
 * l'utilisateur doit savoir que la balle est dans son camp, et que patienter
 * suffit souvent — la vérification est posée sur une adresse IP, pas sur le
 * compte.
 */
const MESSAGE_CAPTCHA =
  'Materiel.net demande une vérification « je ne suis pas un robot » pour se connecter. crabe ne '
  + 'peut pas y répondre à votre place. Connectez-vous une fois vous-même sur le site depuis ce '
  + 'réseau, puis relancez la récupération : la vérification disparaît en général d\'elle-même au '
  + 'bout de quelques heures.';

function erreurCaptcha() {
  const err = new Error(MESSAGE_CAPTCHA);
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle celle d'une page de connexion ?
 *
 * Seuls le CHEMIN et la requête sont examinés. Le domaine `secure.materiel.net`
 * ne contient aucun de ces mots, mais un futur sous-domaine « connexion.… » ne
 * doit pas déclencher de faux positif.
 */
function estPageConnexion(url) {
  const texte = String(url || '');
  let cible;
  try {
    const analysee = new URL(texte);
    cible = `${analysee.pathname}${analysee.search}`;
  } catch {
    cible = texte;
  }
  return /\/login|connexion|authentification/i.test(cible);
}

/**
 * Les commandes lues dans le texte de la page.
 *
 * Le TEXTE plutôt que le DOM, pour la même raison que chez L'Atelier du
 * Portable : une page de commandes mêle en général plusieurs mises en page
 * (en cours, expédiées, annulées) qui écrivent toutes la même phrase.
 *
 * @param {string} texte `document.body.innerText`
 * @returns {Array<{numero: string, issuedOn: string|null}>}
 */
function commandesDepuisTexte(texte) {
  const propre = String(texte || '').replace(/[ \t]+/g, ' ');
  const vues = new Set();
  const sortie = [];

  // `matchAll` sur une COPIE de l'expression : une expression globale porte son
  // propre curseur, et la réutiliser d'un appel à l'autre sauterait une
  // commande sur deux (`lastIndex` conservé).
  const motif = new RegExp(MOTIF_COMMANDE.source, 'gi');

  for (const trouve of propre.matchAll(motif)) {
    const numero = trouve[1].toUpperCase();
    if (vues.has(numero)) continue;
    vues.add(numero);
    sortie.push({
      numero,
      issuedOn: `${trouve[4]}-${trouve[3].padStart(2, '0')}-${trouve[2].padStart(2, '0')}`,
    });
  }

  return sortie;
}

/**
 * Les commandes, depuis les lignes STRUCTURÉES de la liste.
 *
 * Reçoit ce que le navigateur a extrait de chaque `.historic-table` :
 * `{ ref, date, prix, detailHref }`. Fonction pure, pour être testée sur la
 * structure réelle relevée le 14/08/2026 sans navigateur.
 *
 * @param {Array<{ref?: string, date?: string, prix?: string, detailHref?: string}>} lignes
 * @returns {Array<{numero: string, issuedOn: string|null, montant: string|null,
 *   orderId: string|null, detailHref: string|null}>}
 */
function commandesDepuisLignes(lignes) {
  const vues = new Set();
  const sortie = [];

  for (const ligne of Array.isArray(lignes) ? lignes : []) {
    // « Nº 6053014301785C » : le « Nº » saute, la référence reste — lettres
    // comprises, la vraie référence se termine par une lettre.
    const ref = /(?:n[ºo°]\s*)?([A-Z0-9]{6,})\s*$/i.exec(String(ligne?.ref || '').trim());
    if (!ref) continue;
    const numero = ref[1].toUpperCase();
    if (vues.has(numero)) continue;
    vues.add(numero);

    // « 30/05/2026 », jour d'abord — la règle commune du projet
    // (documents-de-page.dateDepuisTexte), pas une variante locale.
    const issuedOn = pageDocs.dateDepuisTexte(String(ligne?.date || ''));

    // L'orderId de la requête de détail — DIFFÉRENT de la référence affichée.
    const detailHref = String(ligne?.detailHref || '').trim() || null;
    const orderId = detailHref
      ? (/[?&]orderId=([^&#]+)/i.exec(detailHref)?.[1] ?? null)
      : null;

    sortie.push({
      numero,
      issuedOn,
      montant: pageDocs.montantDepuisTexte(String(ligne?.prix || '')) || null,
      orderId: orderId ? decodeURIComponent(orderId) : null,
      detailHref,
    });
  }

  return sortie;
}

/**
 * Les liens de facture d'un DÉTAIL de commande (le fragment HTML du POST).
 *
 * Le détail n'a jamais été vu — seule sa porte d'entrée l'a été. On ratisse
 * donc tous les attributs porteurs d'adresse (`href`, `data-href`,
 * `formaction`) dont l'adresse ou le voisinage immédiat parle de facture, et
 * c'est le CONTENU téléchargé qui tranchera (`%PDF-`), jamais la provenance.
 *
 * @param {string} html le fragment renvoyé par `/Orders/PartialCompletedOrderContent`
 * @param {string} base l'origine qui rend les adresses absolues
 * @returns {string[]} adresses absolues, dédoublonnées
 */
function liensDeFactureDansHtml(html, base) {
  const texte = String(html || '');
  const vus = new Set();
  const sortie = [];

  // Élément par élément, et jamais par « voisinage » : chercher le mot
  // « facture » à N caractères autour d'une adresse attrape le libellé du
  // bouton D'À CÔTÉ, et un lien de navigation devient une facture. Seuls
  // comptent l'adresse, les attributs et le texte DE l'élément qui la porte.
  for (const el of texte.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attributs = el[2];
    const contenu = el[3].replace(/<[^>]+>/g, ' ');
    const brut = /(?:href|data-href|formaction)\s*=\s*["']([^"']+)["']/i.exec(attributs)?.[1];
    if (!brut) continue;
    if (!MOTIF_LIEN_FACTURE.test(brut) && !MOTIF_LIEN_FACTURE.test(contenu)) continue;

    // Un `href="javascript:…"` peut porter la vraie adresse dans `data-href` :
    // elle est alors préférée, sinon l'élément est écarté.
    const adresse = /^javascript:/i.test(brut)
      ? /data-href\s*=\s*["']([^"']+)["']/i.exec(attributs)?.[1]
      : brut;
    if (!adresse || /^javascript:/i.test(adresse)) continue;

    let absolu;
    try {
      absolu = new URL(adresse, base).href;
    } catch {
      continue;
    }
    if (vus.has(absolu)) continue;
    vus.add(absolu);
    sortie.push(absolu);
  }

  return sortie;
}

/**
 * Le numéro de commande porté par une adresse de facture, s'il y en a un.
 *
 * Sert à rattacher un lien à sa commande quand la page ne les met pas
 * visiblement en regard. Rend `null` plutôt que d'inventer : un lien qu'on ne
 * sait pas rattacher est traité pour lui-même, pas collé à la mauvaise date.
 */
function numeroDepuisUrl(url) {
  const trouve = /(?:^|[/?&=_-])([A-Z]{0,4}\d{6,})(?:$|[/?&_-])/i.exec(String(url || ''));
  return trouve ? trouve[1].toUpperCase() : null;
}

/** La référence stable d'une commande. */
function remoteIdPour(numero) {
  return `commande-${String(numero || '').toUpperCase()}`;
}

/** Nom du fichier déposé : `AAAA-MM_<numéro de commande>.pdf`. */
function nomFichier(issuedOn, numero) {
  const mois = /^(\d{4})-(\d{2})/.exec(String(issuedOn || ''));
  const prefixe = mois ? `${mois[1]}-${mois[2]}` : 'inconnu';
  return `${prefixe}_${String(numero || 'commande').replace(/[^\w.-]/g, '_')}.pdf`;
}

/**
 * L'adresse électronique du compte, qui nomme son dossier.
 *
 * Celle de la fiche d'abord : c'est celle que l'utilisateur a écrite, donc
 * celle qu'il reconnaîtra dans l'arborescence de ses documents. La page ne sert
 * que de repli.
 */
function compteDepuisTexte(texte, config = {}) {
  const declare = String(config?.[CHAMP_EMAIL] || '').trim().toLowerCase();
  if (declare.includes('@')) return declare;

  const trouve = /\b([\w.+-]+@[\w-]+\.[\w.-]+)\b/.exec(String(texte || ''));
  return trouve ? trouve[1].toLowerCase() : COMPTE_PAR_DEFAUT;
}

/** Une adresse est-elle celle d'une facture ? Texte du lien ET adresse. */
function estLienDeFacture({ texte, url }) {
  return MOTIF_LIEN_FACTURE.test(String(texte || '')) || MOTIF_LIEN_FACTURE.test(String(url || ''));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Le premier élément qui existe, sélecteur par sélecteur, dans l'ordre.
 *
 * ⚠ Surtout pas `page.locator(union).first()` : Playwright y rend le premier
 * élément dans l'ORDRE DU DOM, pas le premier sélecteur qui correspond. La
 * priorité écrite ne serait alors qu'un commentaire décoratif — et sur cette
 * page, l'ordre du DOM donnerait l'œil du mot de passe.
 */
async function premierPresent(page, selecteurs) {
  for (const selecteur of selecteurs) {
    try {
      const candidat = page.locator(selecteur).first();
      if (await candidat.count()) return candidat;
    } catch {
      /* sélecteur inutilisable ici (page en cours de navigation, `:has()` refusé) */
    }
  }
  return null;
}

/**
 * Ferme le bandeau de cookies s'il y en a un.
 *
 * Il n'est PAS dans le HTML servi — un script le pose après coup —, donc aucun
 * identifiant stable n'a pu être relevé : on vise le texte des boutons, tels
 * qu'ils ont été lus dans un vrai navigateur le 13/08/2026 (« J'accepte »,
 * « Paramétrer », « Refuser », « Enregistrer mes choix »).
 *
 * « Refuser » d'abord : c'est le strict nécessaire pour dégager la page, sans
 * accepter de pistage au nom de l'utilisateur. Son absence n'est pas une
 * erreur — un bandeau déjà refusé une fois ne revient pas, le profil persistant
 * gardant le cookie `cookiespreferences`.
 */
async function fermerBandeauCookies(page, log) {
  const boutons = [
    'button:has-text("Refuser")',
    'button:has-text("Tout refuser")',
    '#tarteaucitronAllDenied2',
    'button:has-text("Enregistrer mes choix")',
    'button:has-text("J\'accepte")',
  ];
  for (const selecteur of boutons) {
    const bouton = page.locator(selecteur).first();
    if (!(await bouton.count().catch(() => 0))) continue;
    if (!(await bouton.isVisible().catch(() => false))) continue;
    await bouton.click({ timeout: 5000 }).catch(() => {});
    log(`materiel-net : bandeau de cookies fermé (${selecteur}).`);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/**
 * Le captcha conditionnel s'est-il rendu ?
 *
 * On regarde le conteneur que la page réserve pour lui — vide aujourd'hui — et
 * les deux formes qu'il pourrait prendre, la politique de sécurité de la page
 * autorisant aussi bien Google que Cloudflare.
 */
async function captchaPresent(page) {
  return page.evaluate((selecteur) => {
    const conteneur = document.querySelector(selecteur);
    if (conteneur && conteneur.children.length > 0) return true;
    if (document.querySelector('.g-recaptcha,#g-recaptcha,.cf-turnstile')) return true;
    return [...document.querySelectorAll('iframe')].some((f) =>
      /recaptcha|challenges\.cloudflare\.com|hcaptcha/i.test(f.src || ''));
  }, CONTENEUR_CAPTCHA).catch(() => false);
}

/**
 * Se connecte avec l'adresse et le mot de passe enregistrés.
 *
 * Appelée UNIQUEMENT quand la page des commandes n'a pas été servie : en
 * régime établi, le profil persistant rend cette fonction inutile.
 */
async function seConnecter(page, email, motDePasse, log) {
  await page.goto(URL_CONNEXION, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await fermerBandeauCookies(page, log);

  // Le captcha est examiné AVANT de saisir quoi que ce soit : remplir un
  // formulaire qu'on ne pourra pas soumettre ne fait qu'exposer le mot de passe
  // à une page qu'on va quitter.
  if (await captchaPresent(page)) {
    log('materiel-net : une vérification anti-robot est affichée sur le formulaire de connexion.');
    throw erreurCaptcha();
  }

  // Champs relevés sur le site le 13/08/2026. Les identifiants propres au site
  // viennent en tête ; les replis génériques ne servent qu'au jour où la page
  // changerait.
  const champEmail = await premierPresent(page, [
    '#Email',
    'input[name="Email"]',
    `${FORMULAIRE_CONNEXION} input[type="email"]`,
  ]);
  const champMotDePasse = await premierPresent(page, [
    '#Password',
    'input[name="Password"]',
    'input[type="password"]',
  ]);

  if (!champEmail || !champMotDePasse) {
    throw new Error(
      'Le formulaire de connexion de Materiel.net est introuvable. Le site a peut-être changé : '
        + 'signalez-le à la personne qui administre crabe.'
    );
  }

  // `fill` et non `type` : aucun champ caché n'est touché — le jeton
  // `__RequestVerificationToken` que la page y a écrit part avec le formulaire
  // tel quel. Le reconstruire à la main le perdrait, et le site refuserait sans
  // rien expliquer.
  await champEmail.fill(email);
  await champMotDePasse.fill(motDePasse);

  // « Rester connecté » : cochée volontairement. Elle allonge la session côté
  // serveur, donc espace les soumissions du formulaire, donc éloigne le captcha
  // conditionnel. Son absence n'empêche rien.
  const resterConnecte = page.locator('#LongAuthenticationDuration').first();
  if (await resterConnecte.count().catch(() => 0)) {
    await resterConnecte.check({ timeout: 5000 }).catch(() => {});
  }

  // ⚠ Soumission par la touche Entrée, jamais par un clic.
  //
  // La page porte un <button type="button" class="toggle-password"> — l'œil qui
  // montre le mot de passe — écrit AVANT le <button type="submit">. Un
  // sélecteur de bouton mal ajusté cliquerait l'œil et n'enverrait rien : c'est
  // la panne qui a immobilisé L'Atelier du Portable. Entrée depuis le champ mot
  // de passe soumet le formulaire qui le contient, sans désigner personne.
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    champMotDePasse.press('Enter'),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Toujours sur le formulaire : le site a refusé. On distingue les deux causes
  // possibles, parce qu'elles n'appellent pas le même geste de l'utilisateur.
  if (estPageConnexion(page.url())) {
    if (await captchaPresent(page)) throw erreurCaptcha();

    const grief = await page.locator(MESSAGE_ERREUR_SITE).first().innerText()
      .then((t) => t.trim())
      .catch(() => '');
    throw erreurIdentifiants(grief || `URL finale ${page.url()}`);
  }

  log(`materiel-net : connexion établie (URL finale ${page.url()}).`);
}

/** Va sur une page et vérifie qu'on n'a pas été renvoyé à la connexion. */
async function aller(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (estPageConnexion(page.url())) return null;
  return page.evaluate(() => document.body?.innerText?.slice(0, 40000) || '');
}

/**
 * ATTEND la liste des commandes, puis la lit — jamais l'inverse.
 *
 * La liste est chargée en AJAX après le rendu initial (voir SELECTEUR_LIGNES) :
 * lire la page à l'arrivée rend zéro commande sans qu'aucune erreur ne le
 * signale, et c'est le garde-fou du lot 31 qui échouait à sa place — trois
 * fois le 14/08/2026. L'attente est bornée : une liste qui n'arrive jamais
 * rend simplement zéro ligne, et le garde-fou reprend son rôle.
 */
async function lireLesCommandes(page, log = () => {}) {
  const arrivee = await page
    .waitForSelector(SELECTEUR_LIGNES, { timeout: DELAI_LISTE_MS })
    .then(() => true)
    .catch(() => false);
  if (!arrivee) {
    log(
      `materiel-net : la liste des commandes (${SELECTEUR_LIGNES}) n'est pas apparue en `
        + `${Math.round(DELAI_LISTE_MS / 1000)} s.`
    );
  }

  const lignes = await page.evaluate((selecteur) => {
    return [...document.querySelectorAll(selecteur)].map((table) => ({
      ref: table.querySelector('.historic-cell--ref')?.textContent?.trim() || '',
      date: table.querySelector('.historic-cell--date')?.textContent?.trim() || '',
      prix: table.querySelector('.historic-cell--price')?.textContent?.trim() || '',
      detailHref:
        table.querySelector('a[data-target^="#collapse-"]')?.getAttribute('href')
        || table.querySelector('a[href*="PartialCompletedOrderContent"]')?.getAttribute('href')
        || '',
    }));
  }, SELECTEUR_LIGNES).catch(() => []);

  return commandesDepuisLignes(lignes);
}

/**
 * Le sélecteur de période, ENFIN branché (lot 33) — la mécanique mesurée.
 *
 * Le `<select>` servi dans la page ne porte QU'UNE option (« Depuis les 6
 * derniers mois ») : les autres périodes n'existent pas dans le DOM initial.
 * C'est le JS du site (`site-orders.js`, fonction `orderHistory`) qui fait
 * tout, et il a été lu plutôt que deviné :
 *
 *   - à l'ouverture du menu : `POST /Orders/CompletedOrdersPeriodSelection`
 *     (corps vide) → un tableau JSON de périodes, mesuré le 14/08/2026 sur le
 *     compte réel : `[{"duration":"Year","value":2026},{"duration":"Year",
 *     "value":2021}, …2020, 2019, 2018]`. ⚠ La liste n'est PAS continue —
 *     2022 à 2025 manquent : le site ne propose que les années où ce compte a
 *     commandé. On parcourt CE que le site propose, jamais des années
 *     inventées, et on ne s'arrête pas à un trou ;
 *   - au choix d'une période : `POST /Orders/PartialCompletedOrdersHeader`
 *     avec l'objet période en paramètres de formulaire → le HTML de la liste,
 *     que le site injecte dans `#completedOrdersHeader`. Mêmes lignes, mêmes
 *     classes que la liste par défaut.
 */
const URL_PERIODES = 'https://secure.materiel.net/Orders/CompletedOrdersPeriodSelection';
const URL_LISTE_PERIODE = 'https://secure.materiel.net/Orders/PartialCompletedOrdersHeader';

/** Les lignes d'un FRAGMENT de liste — sans le conteneur, absent du fragment. */
const SELECTEUR_LIGNES_FRAGMENT = '.historic-table';

/**
 * Valide ce que rend `/Orders/CompletedOrdersPeriodSelection`.
 *
 * On ne garde que les périodes bien formées (durée textuelle, valeur
 * numérique) : le site est le seul maître de sa liste, mais un JSON abîmé ne
 * doit pas devenir une boucle sur `undefined`.
 */
function periodesDepuisJson(brut) {
  if (!Array.isArray(brut)) return [];
  const vues = new Set();
  const sortie = [];
  for (const entree of brut) {
    const duration = String(entree?.duration || '').trim();
    const value = Number(entree?.value);
    if (!duration || !Number.isFinite(value)) continue;
    const cle = `${duration}:${value}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    sortie.push({ duration, value });
  }
  return sortie;
}

/**
 * Les périodes à ouvrir, parmi celles que le site propose.
 *
 * Le plan d'historique décide (« tout », fenêtre d'années…) mais ne peut PAS
 * ajouter une période : un connecteur qui boucle de l'année courante à 2018
 * taperait quatre années fantômes (2022-2025 absentes du menu), et un qui
 * s'arrête à la première année vide raterait tout l'ancien.
 */
function periodesAParcourir(periodes, plan) {
  const annees = new Set((plan?.annees || []).map(Number));
  return (Array.isArray(periodes) ? periodes : []).filter((p) => annees.has(Number(p.value)));
}

/**
 * Le bilan de couverture, pour que le journal ne puisse pas mentir (lot 33).
 *
 * « Tout l'historique disponible a été parcouru » ne s'écrit que si TOUTES
 * les périodes proposées par le site ont été ouvertes, sans un seul échec.
 * Sinon, le détail dit ce qui a été vu et ce qui reste hors de portée — le
 * 14/08/2026, le rattrapage disait « tout parcouru » après n'avoir lu que les
 * six derniers mois.
 *
 * @param {Array<{duration, value}>} proposees ce que le site a proposé
 * @param {Array<{value: number, commandes: number}>} parcourues ce qui a été lu
 * @param {number[]} echecs les périodes dont la liste n'a pas répondu
 * @returns {{complete: boolean, detail: string}}
 */
function couverturePour(proposees, parcourues, echecs = []) {
  const vues = new Set(parcourues.map((p) => Number(p.value)));
  const manquees = proposees
    .map((p) => Number(p.value))
    .filter((annee) => !vues.has(annee));

  const morceaux = ['les 6 derniers mois'];
  if (parcourues.length) {
    morceaux.push(
      `les périodes ${parcourues
        .map((p) => `${p.value} (${p.commandes} commande${p.commandes > 1 ? 's' : ''})`)
        .join(', ')}`
    );
  }
  let detail = morceaux.join(' et ');
  if (manquees.length) {
    detail += ` ; hors de portée cette fois : ${manquees.join(', ')}`;
  }
  if (echecs.length) {
    detail += ` ; la liste n'a pas répondu pour : ${echecs.join(', ')}`;
  }

  return {
    complete: proposees.length > 0 && manquees.length === 0 && echecs.length === 0,
    detail,
  };
}

/**
 * Demande au site les périodes qu'il propose. Rendu vide si la route ne
 * répond pas — l'appelant continue alors sur la liste par défaut, et la
 * couverture le dira.
 */
async function releverPeriodesProposees(context, log = () => {}) {
  const reponse = await context.request.post(URL_PERIODES, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    timeout: NAV_TIMEOUT_MS,
  }).catch(() => null);
  if (!reponse || !reponse.ok()) {
    log(
      `materiel-net : le sélecteur de période n'a pas répondu (HTTP `
        + `${reponse ? reponse.status() : 'sans réponse'}) — seule la liste par défaut sera lue.`
    );
    return [];
  }
  let corps = null;
  try {
    corps = JSON.parse(await reponse.text());
  } catch {
    log('materiel-net : la liste des périodes est illisible — seule la liste par défaut sera lue.');
    return [];
  }
  const periodes = periodesDepuisJson(corps);
  log(
    `materiel-net : ${periodes.length} période(s) proposée(s) par le site — `
      + `${periodes.map((p) => p.value).join(' · ')}.`
  );
  return periodes;
}

/**
 * La liste des commandes d'UNE période, par la route que la page emploie.
 *
 * Le fragment reçu est lu dans un élément DÉTACHÉ, avec les mêmes sélecteurs
 * que la liste par défaut : la page réelle n'est jamais modifiée, la session
 * visible reste telle quelle.
 *
 * @returns {Promise<object[]|null>} les commandes, ou null si la route n'a
 *   pas répondu — distinct d'une période légitimement vide.
 */
async function lireCommandesDePeriode(page, context, periode) {
  const reponse = await context.request.post(URL_LISTE_PERIODE, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    form: { duration: String(periode.duration), value: String(periode.value) },
    timeout: NAV_TIMEOUT_MS,
  }).catch(() => null);
  if (!reponse || !reponse.ok()) return null;
  const html = await reponse.text().catch(() => null);
  if (html === null) return null;

  const lignes = await page.evaluate(({ fragment, selecteur }) => {
    const detache = document.createElement('div');
    detache.innerHTML = fragment;
    // La même lecture que `lireLesCommandes`, sur le fragment : si le site
    // change ses classes, les deux listes cassent ensemble et le même
    // correctif les répare ensemble.
    return [...detache.querySelectorAll(selecteur)].map((table) => ({
      ref: table.querySelector('.historic-cell--ref')?.textContent?.trim() || '',
      date: table.querySelector('.historic-cell--date')?.textContent?.trim() || '',
      prix: table.querySelector('.historic-cell--price')?.textContent?.trim() || '',
      detailHref:
        table.querySelector('a[data-target^="#collapse-"]')?.getAttribute('href')
        || table.querySelector('a[href*="PartialCompletedOrderContent"]')?.getAttribute('href')
        || '',
    }));
  }, { fragment: html, selecteur: SELECTEUR_LIGNES_FRAGMENT }).catch(() => null);

  return lignes === null ? null : commandesDepuisLignes(lignes);
}

/**
 * Le répertoire où Chromium écrit ses fichiers temporaires.
 *
 * Sans un HOME inscriptible, un Chromium lancé par un service systemd meurt sur
 * un SIGTRAP — même cause et même remède que dans le navigateur distant.
 */
function maisonNavigateur() {
  const dossier = nodePath.join(require('../../../config').config.dataDir, 'navigateur');
  nodeFs.mkdirSync(dossier, { recursive: true });
  return dossier;
}

/**
 * Ouvre le profil persistant, atteint les commandes, et passe la main.
 *
 * **L'ordre compte** : on tente d'abord la page des commandes avec la session
 * que porte le profil. Si elle est servie, aucun formulaire n'est ouvert et
 * aucun mot de passe n'est saisi — c'est le cas normal en régime établi, et
 * c'est ce qui tient le captcha conditionnel à distance.
 */
async function surLeCompte(config, ctx, fn) {
  const email = String(config?.[CHAMP_EMAIL] || '').trim();
  const motDePasse = String(config?.[CHAMP_MOT_DE_PASSE] || '');
  if (!email || !motDePasse) throw erreurIdentifiantsManquants();

  const log = ctx?.log || (() => {});
  const userId = ctx?.userId;
  if (userId === undefined || userId === null) {
    // Panne de plomberie, pas d'utilisateur : le message vise l'exploitant.
    throw new Error(
      'materiel-net : le contexte d\'exécution ne porte pas l\'utilisateur (ctx.userId) — '
        + 'le profil de navigateur ne peut pas être retrouvé.'
    );
  }

  const profil = profilPersistant.preparer(userId, ID);
  const { chromium } = requirePlaywright();

  let context = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profil, {
        // L'identité d'abord ; les options explicites ont le dernier mot.
        ...identity.optionsContexte({ viewport: VIEWPORT, acceptDownloads: true }),
        headless: true,
        env: { ...process.env, HOME: maisonNavigateur() },
        args: [
          '--disable-dev-shm-usage',
          '--disable-crashpad',
          '--disable-crash-reporter',
          '--no-sandbox',
        ],
      });
    } catch (err) {
      if (/Singleton|ProcessSingleton|already running/i.test(String(err?.message))) {
        throw new Error(
          'Le navigateur de Materiel.net est déjà ouvert par une autre récupération. '
            + 'Attendez qu\'elle se termine, puis relancez.'
        );
      }
      throw err;
    }

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Premier essai : la session du profil suffit-elle ?
    let arrivee = await aller(page, URL_COMMANDES);

    if (arrivee === null) {
      log('materiel-net : la session enregistrée a expiré, connexion par le formulaire.');
      await seConnecter(page, email, motDePasse, log);
      arrivee = await aller(page, URL_COMMANDES);
      if (arrivee === null) {
        // Connexion acceptée mais commandes refusées : ce n'est pas un mot de
        // passe à corriger, et le dire ainsi éviterait de le faire changer pour
        // rien.
        throw erreurSessionExpiree('la page des commandes renvoie au formulaire après connexion');
      }
    } else {
      log('materiel-net : session encore valable, aucune connexion nécessaire.');
    }

    await fermerBandeauCookies(page, log);

    // ─── D'abord ATTENDRE la liste, ensuite juger (lot 32) ────────────────
    //
    // Les commandes arrivent en AJAX après le rendu : les lire trop tôt
    // faisait échouer le garde-fou du lot 31 sur une page pourtant
    // parfaitement connectée (trois exécutions du 14/08). L'attente est dans
    // `lireLesCommandes`, et c'est SA liste qui sert de marqueur.
    const commandes = await lireLesCommandes(page, log);
    const texte = await page.evaluate(() => document.body?.innerText?.slice(0, 40000) || '')
      .catch(() => '');

    // ─── Marqueur POSITIF obligatoire (lot 31) ────────────────────────────
    //
    // « L'URL atteinte n'est pas celle du formulaire » n'a jamais prouvé une
    // session : le 14/08/2026 à 00:01:51, une page interstitielle a passé ce
    // filtre, zéro commande y a été lue, et la récupération a conclu « OK —
    // Aucune nouvelle facture » en neuf secondes sans avoir rien ouvert.
    // Le garde-fou reste : soit des commandes sont affichées (elles
    // n'existent que connecté), soit la page porte un lien de déconnexion.
    // Sinon on refuse de conclure, explicitement.
    let marqueur;
    if (commandes.length > 0) {
      marqueur = `${commandes.length} commande(s) affichée(s) dans l'espace client`;
    } else {
      const preuve = await preuveConnexion.verifier(page);
      if (!preuve.confirme) {
        log(preuveConnexion.ligneNonConfirmee('materiel-net', preuve));
        throw new Error(
          'Materiel.net a affiché une page qui ne ressemble ni à vos commandes ni à un '
            + 'espace connecté : impossible de confirmer que la connexion a fonctionné. '
            + 'Réessayez plus tard ; si le message revient, ouvrez la fiche du connecteur '
            + 'et refaites la connexion.'
        );
      }
      marqueur = preuveConnexion.decrireMarqueur(preuve.preuvesFortes[0]);
    }

    log(`materiel-net : page des commandes atteinte (${page.url()}, ${marqueur}).`);
    return await fn(page, context, { commandes, texte, marqueur });
  } finally {
    await context?.close?.().catch(() => {});
  }
}

/**
 * Les liens de facture présents dans la page, tels qu'elle les écrit.
 *
 * ⚠ **La partie la moins vérifiée du connecteur** : la page des commandes n'a
 * jamais été vue. On ratisse donc large — liens `<a>` et boutons portant une
 * adresse — et on retient ceux dont le TEXTE ou l'ADRESSE parlent de facture.
 * Ce qui est descendu est ensuite validé sur son contenu, pas sur sa
 * provenance : un lien mal attrapé donne un document ignoré, pas un faux PDF
 * rangé dans les factures.
 */
async function liensDeFacture(page) {
  const bruts = await page.evaluate(() => {
    const sortie = [];
    for (const el of document.querySelectorAll('a[href], [data-href], button[formaction]')) {
      const url = el.getAttribute('href') || el.getAttribute('data-href')
        || el.getAttribute('formaction');
      if (!url) continue;
      sortie.push({ url: new URL(url, location.href).href, texte: (el.innerText || '').trim() });
    }
    return sortie;
  }).catch(() => []);

  const vus = new Set();
  return bruts.filter((lien) => {
    if (!estLienDeFacture(lien)) return false;
    if (vus.has(lien.url)) return false;
    vus.add(lien.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la connexion tient-elle, et voit-on des commandes ?
 *
 * Léger, donc AUCUN détail de commande n'est ouvert : le lien de facture vit
 * dans le détail (un POST par commande), et un simple test de connexion n'a
 * pas à déclencher une requête par commande.
 */
async function test(config, ctx = {}) {
  return surLeCompte(config, ctx, async (page, context, { commandes, texte }) => {
    const compte = compteDepuisTexte(texte, config);

    ctx.log?.(`materiel-net : ${commandes.length} commande(s) affichée(s).`);

    return {
      ok: true,
      accountId: compte,
      invoiceCount: commandes.length,
      message:
        'Connexion valide'
        + (compte !== COMPTE_PAR_DEFAUT ? ` — ${compte}` : '')
        + ` · ${commandes.length} commande(s) affichée(s) ; les factures se lisent dans le`
        + ' détail de chaque commande au moment de la récupération.',
    };
  });
}

/**
 * Récupère les factures des commandes qui en ont une.
 *
 * ─── Le lien de facture n'est PAS dans la liste (lot 32) ─────────────────────
 *
 * Il vit dans le DÉTAIL de chaque commande, chargé par une requête séparée —
 * le lien « Détails » de la liste est un POST vers
 * `/Orders/PartialCompletedOrderContent?orderId=…&orderDate=…&orderType=…`
 * (relevé le 14/08/2026). Il faut donc OUVRIR chaque commande retenue. Les
 * commandes déjà rangées sont écartées AVANT ce POST : en régime établi, le
 * connecteur ne rouvre aucun détail.
 *
 * L'aide officielle du site (lot 30) précise : la facture est disponible dix
 * ans, et les commandes Marketplace portent la facture du vendeur-partenaire —
 * qui peut ne pas être servie ici. Un détail sans lien de facture, ou dont le
 * téléchargement ne rend pas un PDF, est donc IGNORÉ et journalisé, jamais
 * rangé : le contenu (`%PDF-`) fait foi, pas la provenance.
 */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeCompte(config, ctx, async (page, context, { commandes, texte, marqueur }) => {
    const compte = compteDepuisTexte(texte, config);

    // La preuve exigée par le socle (lot 31) : la session est attestée par le
    // marqueur relevé dans `surLeCompte`, et la liste des commandes vient
    // d'être lue — ATTENDUE, désormais, pas espérée. Sans ce dépôt, conclure
    // « aucune nouvelle facture » serait refusé, et c'est voulu.
    ctx.preuveDeListe?.({
      session: marqueur,
      liste: `liste des commandes (${SELECTEUR_LISTE})`,
      elements: commandes.length,
    });

    if (!commandes.length) {
      log(
        'materiel-net : aucune commande dans la liste. Soit ce compte n\'a rien commandé '
          + 'sur la période affichée par le site, soit la page a changé de forme.'
      );
      return { accountId: compte, invoices: [] };
    }

    // ─── La profondeur au-delà des 6 mois (lot 33) ────────────────────────
    //
    // Le site ne sert par défaut que les six derniers mois : les années
    // disponibles viennent du SÉLECTEUR DE PÉRIODE, pas des commandes
    // affichées — le 14/08/2026, un rattrapage « tout l'historique » a conclu
    // en n'ayant vu que la période par défaut, et l'a dit en des termes
    // rassurants et faux.
    const periodes = await releverPeriodesProposees(context, log);

    const disponibles = [
      ...new Set([
        ...periodes.map((p) => Number(p.value)),
        ...commandes.map((c) => Number(String(c.issuedOn || '').slice(0, 4))),
      ].filter(Boolean)),
    ].sort((a, b) => b - a);

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles,
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      // Le plafond de conservation posé par le socle : inutile de descendre des
      // documents que l'entretien de la nuit effacerait.
      plafondMois: ctx?.conservationMois || 0,
    });

    log(
      `materiel-net : ${commandes.length} commande(s) affichée(s) — `
        + `historique « ${plan.mode} », ${plan.raison}`
    );

    // Chaque période retenue par le plan est OUVERTE, même si la précédente
    // était vide : un trou dans la liste (2022-2025 absents sur le compte mesuré) est un
    // trou, pas une fin. Les commandes de toutes les périodes rejoignent la
    // liste par défaut, dédoublonnées par référence.
    const parNumero = new Map(commandes.map((c) => [c.numero, c]));
    const parcourues = [];
    const echecs = [];
    for (const periode of periodesAParcourir(periodes, plan)) {
      const dePeriode = await lireCommandesDePeriode(page, context, periode);
      if (dePeriode === null) {
        echecs.push(periode.value);
        log(
          `materiel-net : la liste de la période ${periode.value} n'a pas répondu — `
            + 'elle sera retentée à la prochaine récupération.'
        );
        continue;
      }
      parcourues.push({ value: periode.value, commandes: dePeriode.length });
      log(`materiel-net : période ${periode.value} — ${dePeriode.length} commande(s).`);
      for (const commande of dePeriode) {
        if (!parNumero.has(commande.numero)) parNumero.set(commande.numero, commande);
      }
    }
    const toutes = [...parNumero.values()];
    log(
      `materiel-net : ${parcourues.length} période(s) parcourue(s) en plus des 6 derniers `
        + `mois, ${toutes.length} commande(s) distincte(s) au total.`
    );

    // Le bilan honnête : c'est LUI qui autorise (ou non) le socle à écrire
    // « tout l'historique disponible a été parcouru ».
    const couverture = couverturePour(periodes, parcourues, echecs);

    const invoices = [];
    let sansFacture = 0;

    for (const commande of toutes) {
      const remoteId = remoteIdPour(commande.numero);
      if (connus.has(remoteId)) continue;
      // Une commande sans date lisible est tentée quand même : l'écarter sur
      // une date qu'on n'a pas su lire perdrait un document bien réel.
      if (commande.issuedOn && plan.annees.length
          && !plan.annees.includes(Number(commande.issuedOn.slice(0, 4)))) {
        continue;
      }

      if (!commande.detailHref) {
        log(
          `materiel-net : commande ${commande.numero} sans lien « Détails » — impossible `
            + 'd\'atteindre sa facture, signalez-le si ça se répète.'
        );
        continue;
      }

      // Le détail se charge par POST — c'est ce que déclare le lien de la page
      // (`data-ajax-method="POST"`), fragment retiré : lui ne part jamais au
      // serveur. L'en-tête XMLHttpRequest reproduit l'appel que la page se
      // fait à elle-même.
      const urlDetail = new URL(commande.detailHref, URL_COMMANDES);
      urlDetail.hash = '';
      const detail = await context.request.post(urlDetail.href, {
        timeout: NAV_TIMEOUT_MS,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      }).catch(() => null);

      if (!detail || !detail.ok()) {
        log(
          `materiel-net : détail de la commande ${commande.numero} — HTTP `
            + `${detail ? detail.status() : 'sans réponse'}, commande passée pour cette fois.`
        );
        continue;
      }

      const liens = liensDeFactureDansHtml(await detail.text(), urlDetail.origin);
      if (!liens.length) {
        sansFacture++;
        log(
          `materiel-net : commande ${commande.numero} — aucun lien de facture dans son `
            + 'détail. Pas encore facturée, ou facture du vendeur-partenaire (Marketplace) '
            + 'non servie ici.'
        );
        continue;
      }

      // Une commande n'a qu'une facture : le premier lien qui rend un vrai PDF
      // gagne, les suivants sont des doublons d'affichage.
      let deposee = false;
      for (const lien of liens) {
        const res = await context.request.get(lien, { timeout: NAV_TIMEOUT_MS }).catch(() => null);
        if (!res || !res.ok()) continue;
        const buffer = Buffer.from(await res.body());

        // Le CONTENU fait foi, jamais l'en-tête : une session qui vient
        // d'expirer rend une page de connexion avec un type parfaitement
        // propre — s'y fier déposerait du HTML dans les factures (la panne qui
        // a coûté deux lots chez Anthropic).
        if (!identity.estPdf(buffer)) {
          log(
            `materiel-net : commande ${commande.numero} — le document reçu n'est pas un PDF `
              + `(${buffer.length} o, type annoncé « ${res.headers()['content-type'] || 'inconnu'} »), `
              + 'lien suivant.'
          );
          continue;
        }

        connus.add(remoteId);
        invoices.push({
          accountId: compte,
          remoteId,
          filename: nomFichier(commande.issuedOn, commande.numero),
          issuedOn: commande.issuedOn,
          amount: commande.montant,
          reference: commande.numero,
          buffer,
        });
        deposee = true;
        break;
      }
      if (!deposee && liens.length) sansFacture++;

      await page.waitForTimeout(PAUSE_DOCUMENT_MS);
    }

    log(
      `materiel-net : ${invoices.length} facture(s) téléchargée(s) sur ${toutes.length} `
        + `commande(s) distincte(s)`
        + (sansFacture ? `, ${sansFacture} sans facture disponible` : '')
        + '.'
    );

    return { accountId: compte, invoices, couverture };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  ID,
  estPageConnexion,
  commandesDepuisTexte,
  commandesDepuisLignes,
  liensDeFactureDansHtml,
  lireLesCommandes,
  periodesDepuisJson,
  periodesAParcourir,
  couverturePour,
  releverPeriodesProposees,
  lireCommandesDePeriode,
  URL_PERIODES,
  URL_LISTE_PERIODE,
  SELECTEUR_LIGNES_FRAGMENT,
  SELECTEUR_LISTE,
  SELECTEUR_LIGNES,
  DELAI_LISTE_MS,
  numeroDepuisUrl,
  remoteIdPour,
  nomFichier,
  compteDepuisTexte,
  estLienDeFacture,
  premierPresent,
  fermerBandeauCookies,
  captchaPresent,
  seConnecter,
  liensDeFacture,
  erreurSessionExpiree,
  erreurIdentifiants,
  erreurCaptcha,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_IDENTIFIANTS,
  MESSAGE_CAPTCHA,
  FORMULAIRE_CONNEXION,
  CONTENEUR_CAPTCHA,
  MESSAGE_ERREUR_SITE,
  URL_CONNEXION,
  URL_COMMANDES,
  COMPTE_PAR_DEFAUT,
};
