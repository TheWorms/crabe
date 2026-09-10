'use strict';

/**
 * Connecteur SoundCloud — session capturée, rejouée headless, historique des
 * achats.
 *
 * ─── Ce que la MESURE du 18/08/2026 a établi (session réelle, en production) ────────
 *
 * Le lot 36 visait `checkout.soundcloud.com/billing`, qui rend 404 — une page
 * que personne n'avait vue derrière une session. La vraie page, mesurée en
 * session ouverte, est **https://soundcloud.com/you/subscriptions** :
 *
 *   - section `p.subscriptions__sectionTitle` → « Historique des achats » ;
 *   - une ligne par achat : `li.subscriptionOrders__billingRow`, cellules
 *     `.subscriptionOrders__billingCell` (date en français avec abréviations
 *     — « 21 févr. 2023 », « 5 janv. 2019 » —, libellé, prix dans
 *     `.subscriptionOrders__price`) ;
 *   - DEUX formes de reçu, jamais confondues :
 *       1. `a.sc-button[href]` vers `soundcloud.recurly.com/account/invoices/
 *          <REF>.pdf?ht=<JETON>` → vraie facture PDF (observé sur UNE seule ligne
 *          du compte mesuré, un abonnement annuel) ;
 *       2. `button.consumerSubscriptionReceiptModalButton` (« Afficher le
 *          reçu ») → reçu EN MODALE, peint depuis des données déjà chargées
 *          (aucun téléchargement, aucun lien PDF). C'est le cas de la
 *          quasi-totalité des lignes (24 sur 26 mesurées).
 *   - la ligne « Essai gratuit » (la plus ancienne du compte) n'a ni prix ni bouton : ce
 *     n'est PAS un document manquant, jamais un échec ;
 *   - un anonyme sur cette adresse est renvoyé en 401 vers `/signin` — la
 *     session expirée se voit à l'URL.
 *
 * ─── La MODALE, mesurée le 19/08/2026 : un reçu COMPLET, donc imprimé ────────
 *
 * Le lot 37 n'avait jamais ouvert la modale. Mesurée en session réelle :
 * `div.modal__content > div.consumerSubscriptionReceipt` est un reçu officiel
 * complet, titré « Facture » — date, « Facturer à » + nom du compte, « ID de
 * transaction » (32 hexadécimaux), description, durée, mode de paiement,
 * Prix HT, VAT (20.0%), Total, et l'émetteur au pied : SoundCloud Global
 * Limited & Co. KG, Karl-Marx-Strasse 101, 12043 Berlin, USt.-Id DE326379178.
 *
 * Depuis le lot 41, ce reçu s'IMPRIME donc en PDF (`page.pdf()`) — AUCUN
 * contenu n'est fabriqué, c'est le nœud que le site peint, tel quel.
 *
 * Le lot 42 a corrigé le RENDU, sur trois défauts mesurés sur un PDF produit :
 * deux pages identiques, le décor du site en travers, et un reçu non cadré.
 * Le reçu est désormais ISOLÉ (voir `ISOLER_LE_RECU`) et la page du PDF est
 * taillée à sa boîte : une page, le reçu seul, avec ses propres couleurs —
 * le lot 43 a appris qu'écraser son fond rendait son texte invisible, et une
 * garde de contraste (`MESURER_LE_CONTRASTE`) refuse désormais tout rendu
 * dont le texte se confondrait avec le fond.
 *
 * Preuves à chaque impression : la SOURCE isolée porte l'ID de transaction et
 * le Total et ne porte AUCUN libellé du décor, tout cela AVANT le rendu ; les
 * octets commencent par `%PDF-` ; le poids dépasse un seuil (un rendu blanc
 * est un ÉCHEC).
 *
 * L'attestation de couverture compte les LIGNES VUES, pas les documents
 * obtenus. Le `?ht=…` du lien Recurly est un JETON D'ACCÈS (règle du
 * lot 33) : il ne sort jamais — ni nom de fichier, ni journal, ni message.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'soundcloud';
const NOM = 'SoundCloud';

/** La page d'abonnement mesurée le 18/08/2026, section « Historique des achats ». */
const URL_FACTURATION = 'https://soundcloud.com/you/subscriptions';

/** La page 404 de SoundCloud, reconnue à son titre (mesuré le 17/08/2026). */
const MOTIF_PAGE_INTROUVABLE = /page not found|page introuvable|erreur 404|error 404/i;

/** Un déclencheur d'ENVOI D'E-MAIL, à ne jamais actionner (règle lot 33). */
const MOTIF_ENVOI_EMAIL = /e-?mail|courriel|send|envoyer/i;

/** La ligne d'essai gratuit : ni prix, ni reçu — jamais un document manquant. */
const MOTIF_ESSAI_GRATUIT = /essai gratuit|free trial/i;

/** Le bouton de reçu en modale, mesuré les 18 et 19/08/2026. */
const SELECTEUR_BOUTON_MODALE = 'button.consumerSubscriptionReceiptModalButton';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/** L'espace client se peint après coup : lire trop tôt = « aucune ligne » à tort. */
const DELAI_RENDU_MS = 6_000;

/** La modale se peint depuis des données déjà chargées : bref, mais pas nul. */
const DELAI_MODALE_MS = 1_500;

/**
 * En dessous de ce poids, le rendu est tenu pour BLANC et c'est un échec :
 * une page A4 vide sort de Chromium autour de 3-4 Ko, un reçu réel — logo,
 * polices incorporées, tableau — pèse largement plus. Le PDF ne se relit pas
 * (glyphes) : le poids et la lecture de la SOURCE avant rendu sont les preuves.
 */
const SEUIL_PDF_OCTETS = 10_000;

/**
 * Le décor du site, tel qu'il traversait les PDF du lot 41 : la barre de
 * navigation en haut, le lecteur audio en bas. Si un seul de ces libellés se
 * lit encore dans la page APRÈS isolation, c'est que le reçu n'a pas été
 * isolé — et rien ne s'imprime.
 */
const TERMES_DECOR = ['Fil d\'actualités', 'Uploader', 'Bibliothèque'];

/** Sous ces dimensions, la boîte mesurée n'est pas un reçu : rien n'est rendu. */
const TAILLE_MINIMALE_PX = 100;

/**
 * Sous ce rapport de contraste (échelle WCAG : 1 = indiscernable, 21 = noir
 * sur blanc), le texte du reçu se confond avec son fond et le PDF sortirait
 * illisible. Le défaut du 19/08/2026 au soir — texte blanc sur fond blanchi —
 * mesure 1 sur cette échelle ; un gris clair sur blanc reste sous 2 ; le reçu
 * réel, texte blanc sur fond sombre, dépasse 10.
 */
const CONTRASTE_MINIMAL = 2;

const CHAMP_SESSION = 'session';

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `Playwright n'est pas installé : le connecteur ${NOM} ne peut pas fonctionner. `
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à SoundCloud a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à SoundCloud » — connectez-vous avec votre adresse e-mail et votre mot '
  + 'de passe (« Or with email »), pas par « Google », « Facebook » ni « Apple ».';

/** L'adresse d'historique est morte : rouvrir la connexion n'y changerait rien. */
const MESSAGE_ADRESSE_MORTE =
  'La page d\'historique des achats SoundCloud n\'existe plus à l\'adresse que crabe connaît '
  + `(${URL_FACTURATION} rend « page introuvable »). Ce n'est pas un problème de connexion : `
  + 'inutile de la refaire. Signalez-le — le connecteur doit être adapté à la nouvelle '
  + 'adresse du site.';

/** Le rappel propre à SoundCloud : la facture officielle est dans la boîte e-mail. */
const RAPPEL_EMAIL =
  'À savoir : SoundCloud envoie sa facture par e-mail à chaque paiement — cherchez '
  + '« SoundCloud » dans votre boîte (et son dossier de courrier indésirable).';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte. SoundCloud loge sa connexion sous `/signin` et le
 * formulaire embarqué sous `/web-auth` (mesurés le 17/08/2026) ; un anonyme
 * sur la page d'abonnement y est renvoyé en 401 (mesuré le 18/08/2026).
 */
function estPageAuthentification(url) {
  try {
    return /\/(login|signup|signin|sign-in|authenticate|verify|web-auth)(\/|$)/i
      .test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

/**
 * « 21 févr. 2023 » → « 2023-02-21 ».
 *
 * SoundCloud écrit ses dates en français, avec les abréviations de
 * l'Imprimerie nationale (janv., févr., juil., sept., déc. — mais mars, mai,
 * juin, août en toutes lettres). Toutes mesurées le 18/08/2026.
 *
 * @returns {string|null} jamais une exception : une date illisible rend null,
 *   et l'appelant garde la ligne avec sa date brute pour le journal.
 */
const MOIS_FRANCAIS = {
  janv: '01', janvier: '01',
  fevr: '02', 'févr': '02', fevrier: '02', 'février': '02',
  mars: '03',
  avr: '04', avril: '04',
  mai: '05',
  juin: '06',
  juil: '07', juillet: '07',
  aout: '08', 'août': '08',
  sept: '09', septembre: '09',
  oct: '10', octobre: '10',
  nov: '11', novembre: '11',
  dec: '12', 'déc': '12', decembre: '12', 'décembre': '12',
};

function dateFrancaiseEnIso(texte) {
  const m = /^(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})$/u.exec(String(texte || '').trim());
  if (!m) return null;
  const mois = MOIS_FRANCAIS[m[2].toLowerCase()];
  if (!mois) return null;
  return `${m[3]}-${mois}-${m[1].padStart(2, '0')}`;
}

/**
 * La référence de la facture, tirée du CHEMIN du lien Recurly — jamais de sa
 * requête, qui porte le jeton : `…/invoices/FR26322.pdf?ht=<JETON>` → FR26322.
 */
function referenceDuLien(href) {
  try {
    const chemin = new URL(String(href)).pathname;
    const fin = chemin.split('/').filter(Boolean).pop() || '';
    return fin.replace(/\.pdf$/i, '') || null;
  } catch {
    return null;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucune ligne » de « aucune ligne RECONNUE ». */
function messageReleveVide(pagesVisitees) {
  return (
    'Connexion à SoundCloud valide, mais aucune ligne d\'achat n\'a été reconnue sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun paiement fait directement à SoundCloud, soit crabe ne '
    + 'reconnaît plus la présentation de la page. Si vous voyez bien un « Historique des '
    + `achats » sur votre page d'abonnement SoundCloud, signalez-le. ${RAPPEL_EMAIL}`
  );
}

/** Contrôle du fichier de session avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la session enregistrée et passe la main.
 * `optionsLancement()` porte le drapeau anti-automatisation (lot 35) : aucune
 * garde mesurée chez SoundCloud, mais une session rejouée doit présenter la
 * même identité que celle de sa capture.
 */
async function surLaFacturation(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch(identity.optionsLancement());
  try {
    const context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Exécutée DANS la page : les lignes de l'historique des achats, telles que
 * mesurées le 18/08/2026. Rendue sous forme de données brutes — le tri, les
 * dates et la retenue des jetons se font côté connecteur, où c'est testable.
 */
function EXTRAIRE_LIGNES() {
  return [...document.querySelectorAll('li.subscriptionOrders__billingRow')].map((li) => {
    const cellules = [...li.querySelectorAll('.subscriptionOrders__billingCell')]
      .map((c) => (c.innerText || '').trim().replace(/\s+/g, ' '));
    const prix = li.querySelector('.subscriptionOrders__price');
    const lien = li.querySelector('a.sc-button[href]');
    return {
      date: cellules[0] || '',
      libelle: cellules[1] || '',
      prix: prix ? (prix.innerText || '').trim() : '',
      texte: (li.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      lienRecu: lien ? lien.getAttribute('href') : null,
      texteLien: lien ? (lien.innerText || '').trim() : '',
      boutonModale: !!li.querySelector('button.consumerSubscriptionReceiptModalButton'),
    };
  });
}

/**
 * Écrit au journal ce que la page offrait quand on n'y a pas trouvé son
 * compte — libellés d'interface uniquement, jamais le contenu du compte.
 */
async function journaliserPage(page, log, pourquoi) {
  const vue = await page.evaluate(() => {
    const court = (t) => (t || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return {
      titre: document.title,
      boutons: [...document.querySelectorAll('button, [role="tab"], [role="button"], a')]
        .map((b) => court(b.innerText)).filter(Boolean).slice(0, 20),
    };
  }).catch(() => ({ titre: '?', boutons: [] }));
  log(`${ID} : ${pourquoi}. Page « ${vue.titre} ».`);
  log(`${ID} :   libellés vus — ${vue.boutons.join(' | ') || 'aucun'}`);
}

/**
 * Lit l'historique des achats et trie les lignes en trois familles :
 * facture PDF (lien direct), reçu à l'écran seulement (bouton de modale),
 * essai gratuit (rien à récupérer, et ce n'est pas un échec).
 *
 * @returns {Promise<{lignes: object[], documents: object[],
 *                    sansPdf: object[], gratuits: object[],
 *                    pagesVisitees: string[]}>}
 */
async function relever(page, log = () => {}) {
  const pagesVisitees = [URL_FACTURATION];

  await page.goto(URL_FACTURATION, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_FACTURATION}`);
  }

  // Le 404 applicatif : l'adresse est morte, PAS la session (piège Qobuz).
  const titre = await page.title().catch(() => '');
  if (MOTIF_PAGE_INTROUVABLE.test(titre)) {
    throw new Error(MESSAGE_ADRESSE_MORTE);
  }

  const brut = await page.evaluate(EXTRAIRE_LIGNES).catch(() => []);
  const lignes = Array.isArray(brut) ? brut : [];

  const documents = [];
  const modales = [];
  const sansRecu = [];
  const gratuits = [];
  lignes.forEach((ligne, index) => {
    // L'essai gratuit mesuré : ni prix ni reçu. Jamais un document manquant.
    if (!ligne.prix && MOTIF_ESSAI_GRATUIT.test(ligne.texte)) {
      gratuits.push(ligne);
      log(`${ID} : la ligne du ${ligne.date || '(date illisible)'} est un essai gratuit — `
        + 'rien à récupérer, ce n\'est pas un échec');
      return;
    }
    // Un lien qui enverrait un e-mail n'est jamais actionné (règle lot 33).
    const lienUtilisable = ligne.lienRecu && !MOTIF_ENVOI_EMAIL.test(ligne.texteLien);
    if (lienUtilisable) {
      const reference = referenceDuLien(ligne.lienRecu);
      documents.push({
        remoteId: `${ID}-${reference || `${dateFrancaiseEnIso(ligne.date) || ligne.date}-${ligne.prix}`}`,
        url: ligne.lienRecu,
        issuedOn: dateFrancaiseEnIso(ligne.date),
        amount: ligne.prix || null,
        libelle: ligne.libelle,
      });
      return;
    }
    // Le reçu en modale (mesuré complet le 19/08/2026) : il s'imprimera.
    if (ligne.boutonModale) {
      modales.push({ ...ligne, index });
      return;
    }
    sansRecu.push(ligne);
    log(`${ID} : l'achat du ${ligne.date || '(date illisible)'} (${ligne.libelle || 'libellé inconnu'}`
      + `${ligne.prix ? `, ${ligne.prix}` : ''}) n'offre ni facture PDF ni reçu en modale — `
      + 'rien n\'est déposé à sa place');
  });

  if (!lignes.length) {
    await journaliserPage(page, log, 'aucune ligne d\'achat reconnue sur l\'historique');
  }
  log(`${ID} : ${lignes.length} ligne(s) d'achat vue(s) — ${documents.length} avec facture PDF, `
    + `${modales.length} avec reçu en modale (imprimable), ${gratuits.length} essai(s) gratuit(s)`
    + `${sansRecu.length ? `, ${sansRecu.length} sans aucun reçu` : ''}`);
  return { lignes, documents, modales, sansRecu, gratuits, pagesVisitees };
}

/**
 * Exécutée DANS la page, une modale ouverte : ce qu'il faut pour prouver et
 * nommer. La racine `consumerSubscriptionReceipt` au texte le plus long (les
 * enfants portent la même racine de classe), remontée à sa fenêtre modale.
 */
function LIRE_MODALE_RECU() {
  const recu = [...document.querySelectorAll('[class*="consumerSubscriptionReceipt"]')]
    .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
  const noeud = recu ? (recu.closest('[class*="modal"]') || recu) : null;
  if (!noeud) return null;
  const texte = (noeud.innerText || '').replace(/\s+/g, ' ');
  return {
    idTransaction:
      (/(?:ID de transaction|Transaction ID)\s*:?\s*([a-f0-9]{16,})/i.exec(texte) || [])[1] || null,
    aTotal: /Total/i.test(texte),
    apercu: texte.slice(0, 160),
  };
}

/**
 * Exécutée DANS la page : ISOLE le reçu pour que `page.pdf()` n'imprime que
 * lui — le geste « imprimer cet élément », et rien d'autre.
 *
 * Le lot 41 masquait le reste de la page par VISIBILITÉ. Trois défauts mesurés
 * le 19/08/2026 sur un PDF produit (`soundcloud_2017-12_44fccc70…`) :
 *   - la place des nœuds masqués restait OCCUPÉE, donc le document dépassait
 *     une page A4 et le PDF sortait à 2 pages ;
 *   - la modale est en `position: fixed`, or Chromium REPEINT les éléments
 *     fixes sur CHAQUE page imprimée : le reçu apparaissait deux fois ;
 *   - la barre de navigation, le lecteur audio et le fond gris traversaient
 *     (`visibility: hidden` ne s'applique pas aux fonds hérités du document),
 *     et le reçu, non recadré, tenait la moitié gauche d'un A4.
 *
 * Le geste retenu, mesuré sur un vrai Chromium (voir le test « le reçu isolé
 * s'imprime sur UNE page ») :
 *   1. tout ce qui n'est pas sur le chemin du reçu passe en `display: none` —
 *      sa place disparaît de la mise en page, pas seulement son encre ;
 *   2. le chemin lui-même cesse d'être fixe et borné en hauteur ;
 *   3. le reçu se pose en haut à gauche du document, à la largeur que le site
 *      lui donnait.
 * La page du PDF est ensuite taillée à la boîte mesurée : une page, pile.
 *
 * L'isolation ne touche QUE la mise en page : position, marges, dimensions,
 * masquage des frères. JAMAIS `color`, `background`, `border` ni aucune autre
 * décoration du reçu, de ses descendants ou de son chemin. Le lot 42 posait
 * `background: #fff` sur le reçu lui-même : son fond sombre disparaissait et
 * son texte blanc restait — sur blanc. Mesuré le 19/08/2026 au soir sur un compte réel
 * (`soundcloud_2018-11_e47c1f….pdf`) : seuls les libellés gris se lisaient,
 * les valeurs étaient dans le fichier mais invisibles. C'est aussi pour cela
 * que le reçu reste EN FLUX (`static`, jamais absolu) : sorti du flux, les
 * fonds de ses ancêtres se replieraient à hauteur nulle et ne peindraient
 * plus rien derrière lui. `MESURER_LE_CONTRASTE` garde désormais la porte.
 *
 * Le nœud n'est JAMAIS déplacé dans l'arbre : le site pilote sa modale, et un
 * reparentage l'inviterait à la repeindre sous nos pieds. Chaque style touché
 * est mémorisé dans `data-crabe-style-avant` (JSON, donc `null` se distingue
 * de la chaîne vide) et `RETABLIR_LE_RECU` le repose à l'identique.
 *
 * @returns {{largeur: number, hauteur: number, source: string}|null}
 *   `source` = le texte que la page porte APRÈS isolation : c'est LUI qui
 *   prouve, avant tout rendu, que le décor est parti et que le reçu est là
 *   (le PDF, lui, encode son texte en glyphes et ne se relit pas).
 */
function ISOLER_LE_RECU() {
  const recu = [...document.querySelectorAll('[class*="consumerSubscriptionReceipt"]')]
    .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
  if (!recu) return null;

  // La largeur que le site donne au reçu, mesurée AVANT toute retouche : le
  // reçu doit se lire comme à l'écran, pas se réajuster à son contenu.
  const largeurDOrigine = Math.ceil(recu.getBoundingClientRect().width);

  const retenir = (n) => {
    if (!n.hasAttribute('data-crabe-style-avant')) {
      n.setAttribute('data-crabe-style-avant', JSON.stringify(n.getAttribute('style')));
    }
  };
  const poser = (n, styles) => {
    retenir(n);
    for (const [propriete, valeur] of styles) n.style.setProperty(propriete, valeur, 'important');
  };

  // 1. hors du chemin du reçu : plus de place occupée du tout.
  let noeud = recu;
  while (noeud && noeud !== document.documentElement && noeud.parentElement) {
    for (const frere of [...noeud.parentElement.children]) {
      if (frere !== noeud && frere.style) poser(frere, [['display', 'none']]);
    }
    noeud = noeud.parentElement;
  }

  // 2. le chemin : ni fixe, ni borné — mais ses couleurs, fonds et bordures
  //    restent SIENS : le fond sombre du reçu peut venir d'ici.
  noeud = recu.parentElement;
  while (noeud && noeud !== document.documentElement) {
    poser(noeud, [
      ['position', 'static'], ['transform', 'none'], ['margin', '0'], ['padding', '0'],
      ['max-height', 'none'], ['height', 'auto'], ['width', 'auto'], ['overflow', 'visible'],
      ['inset', 'auto'], ['display', 'block'],
    ]);
    noeud = noeud.parentElement;
  }

  // 3. le reçu, en haut à gauche, à sa largeur, EN FLUX (static : sorti du
  //    flux, les fonds de ses ancêtres ne peindraient plus rien derrière lui)
  //    et avec ses propres couleurs.
  poser(recu, [
    ['position', 'static'], ['margin', '0'],
    ['max-height', 'none'], ['height', 'auto'], ['width', `${largeurDOrigine}px`],
    ['overflow', 'visible'],
  ]);
  // Le papier autour du reçu, lui, est blanc : ce n'est pas le reçu, c'est la
  // feuille — la page du PDF est de toute façon taillée à la boîte du reçu.
  poser(document.documentElement, [['background', '#fff'], ['margin', '0'], ['padding', '0']]);

  const boite = recu.getBoundingClientRect();
  return {
    largeur: Math.ceil(Math.max(boite.width, recu.scrollWidth)),
    hauteur: Math.ceil(Math.max(boite.height, recu.scrollHeight)),
    source: (document.body.innerText || '').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Exécutée DANS la page : repose les styles qu'ISOLER a touchés.
 *
 * Un nœud qui n'avait aucun attribut `style` en ressort avec un `style=""` :
 * Chromium garde l'attribut, vide, dès que la déclaration a été touchée une
 * fois — `removeAttribute` n'y change rien (mesuré le 19/08/2026). C'est sans
 * effet sur le rendu : la déclaration est vide, la page se calcule comme
 * avant, et c'est ce que le test vérifie (styles CALCULÉS, pas attributs).
 */
function RETABLIR_LE_RECU() {
  document.querySelectorAll('[data-crabe-style-avant]').forEach((n) => {
    let avant = null;
    try { avant = JSON.parse(n.getAttribute('data-crabe-style-avant')); } catch { avant = null; }
    if (avant === null) { n.style.cssText = ''; n.removeAttribute('style'); }
    else n.setAttribute('style', avant);
    n.removeAttribute('data-crabe-style-avant');
  });
}

/**
 * Exécutée DANS la page, APRÈS isolation et AVANT tout rendu : la couleur
 * calculée du texte du reçu se lit-elle sur le fond effectif derrière lui ?
 *
 * Ce contrôle existe parce que le 19/08/2026 au soir, l'isolation du lot 42
 * blanchissait le fond du reçu : le texte blanc restait, sur blanc, et 24 PDF
 * illisibles sont partis en dépôt sans qu'aucune garde ne bronche — la source
 * portait bien le texte, le poids était bon, mais l'encre avait la couleur du
 * papier.
 *
 * Le « texte principal » est la feuille qui porte l'ID de transaction — la
 * valeur précisément invisible ce soir-là — ou, à défaut, la feuille la plus
 * longue. Le fond effectif se calcule en composant la pile des fonds (nœud
 * puis ancêtres, du plus lointain au plus proche) sur le blanc du papier.
 * Aucun contenu du reçu ne sort d'ici : des couleurs et des comptes, rien
 * d'autre.
 *
 * @returns {{texte: string, fond: string, ratio: number,
 *   caracteres: {lisibles: number, illisibles: number}}|null}
 */
function MESURER_LE_CONTRASTE() {
  const recu = [...document.querySelectorAll('[class*="consumerSubscriptionReceipt"]')]
    .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
  if (!recu) return null;

  const composantes = (chaine) => {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/
      .exec(chaine || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  // Le fond EFFECTIF derrière un nœud : sa propre pile de fonds et celle de
  // ses ancêtres, composée du plus lointain au plus proche, sur le blanc du
  // papier (c'est une page qui part à l'impression).
  const fondDerriere = (element) => {
    const couches = [];
    for (let n = element; n; n = n.parentElement) {
      const c = composantes(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { couches.push(c); if (c.a >= 1) break; }
    }
    let fond = { r: 255, g: 255, b: 255 };
    for (const couche of couches.reverse()) {
      fond = {
        r: couche.r * couche.a + fond.r * (1 - couche.a),
        g: couche.g * couche.a + fond.g * (1 - couche.a),
        b: couche.b * couche.a + fond.b * (1 - couche.a),
      };
    }
    return fond;
  };
  const luminance = ({ r, g, b }) => {
    const lineaire = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lineaire(r) + 0.7152 * lineaire(g) + 0.0722 * lineaire(b);
  };
  const rapport = (encre, fond) => {
    const [clair, sombre] = [luminance(encre), luminance(fond)].sort((x, y) => y - x);
    return (clair + 0.05) / (sombre + 0.05);
  };
  const rgb = ({ r, g, b }) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

  // Les feuilles de texte : chaque nœud du reçu qui porte du texte EN PROPRE.
  const feuilles = [recu, ...recu.querySelectorAll('*')].filter((n) =>
    [...n.childNodes].some((t) => t.nodeType === Node.TEXT_NODE && t.textContent.trim().length >= 2));
  if (!feuilles.length) return null;

  const mesures = feuilles.map((n) => {
    const texteDirect = [...n.childNodes]
      .filter((t) => t.nodeType === Node.TEXT_NODE)
      .map((t) => t.textContent).join('').trim();
    const encre = composantes(getComputedStyle(n).color) || { r: 0, g: 0, b: 0, a: 1 };
    const fond = fondDerriere(n);
    return { texteDirect, encre, fond, ratio: rapport(encre, fond) };
  });

  let lisibles = 0;
  let illisibles = 0;
  for (const mesure of mesures) {
    // 2 = le CONTRASTE_MINIMAL du module ; cette fonction part seule dans la
    // page et ne peut pas fermer sur lui.
    if (mesure.ratio < 2) illisibles += mesure.texteDirect.length;
    else lisibles += mesure.texteDirect.length;
  }
  const principal = mesures.find((m) => /[a-f0-9]{16,}/i.test(m.texteDirect))
    || [...mesures].sort((a, b) => b.texteDirect.length - a.texteDirect.length)[0];
  return {
    texte: rgb(principal.encre),
    fond: rgb(principal.fond),
    ratio: Math.round(principal.ratio * 100) / 100,
    caracteres: { lisibles, illisibles },
  };
}

/**
 * Le verdict sur la mesure de contraste : `null` si le reçu se lit, sinon le
 * grief — dit avec les couleurs mesurées, jamais avec le contenu du reçu.
 *
 * @param {ReturnType<typeof MESURER_LE_CONTRASTE>} contraste
 * @returns {string|null}
 */
function controlerContraste(contraste) {
  if (!contraste) {
    return 'la lisibilité du texte n\'a pas pu être mesurée sur la page isolée';
  }
  if (contraste.ratio < CONTRASTE_MINIMAL) {
    return `le texte principal du reçu (${contraste.texte}) est indiscernable du fond `
      + `derrière lui (${contraste.fond}) — il serait invisible à l'impression`;
  }
  const { lisibles = 0, illisibles = 0 } = contraste.caracteres || {};
  if (illisibles > lisibles) {
    return `la plus grande partie du texte du reçu (${illisibles} caractères sur `
      + `${lisibles + illisibles}) se confond avec le fond derrière elle`;
  }
  return null;
}

/**
 * Ce que la SOURCE isolée prouve, avant qu'un seul octet de PDF soit produit.
 *
 * Le PDF ne se relit pas — Chromium y encode le texte en glyphes (voir
 * l'en-tête de `connectors/releve-reconstitue.js`). Le seul moment où le
 * contenu du reçu est lisible en clair est donc celui-ci : la page isolée,
 * juste avant le rendu.
 *
 * @param {string} source texte de la page après isolation
 * @returns {{decor: string[], aRecu: boolean, aTotal: boolean, aEmetteur: boolean}}
 */
function controlerSourceIsolee(source) {
  const texte = String(source || '');
  const minuscules = texte.toLowerCase();
  return {
    decor: TERMES_DECOR.filter((terme) => minuscules.includes(terme.toLowerCase())),
    aRecu: /ID de transaction|Transaction ID/i.test(texte),
    aTotal: /Total/i.test(texte),
    aEmetteur: /SoundCloud Global Limited/i.test(texte),
  };
}

/** Referme la modale courante (Échap — le site n'a pas besoin de plus). */
async function fermerModale(page) {
  try { await page.keyboard.press('Escape'); } catch { /* pas de clavier simulé */ }
  await page.waitForTimeout(500).catch(() => {});
}

/**
 * Imprime, ligne par ligne, les reçus en modale — le pendant SoundCloud de
 * l'impression Deezer (lot 41), sorti de `fetchInvoices` pour être testable
 * sans navigateur.
 *
 * Chaque ligne a son destin au journal : imprimée, déjà connue, ou une modale
 * qui n'est pas un reçu complet (l'aperçu est alors DIT, rien n'est déposé).
 * `offertes` compte les modales qui étaient bien des reçus : c'est elle qui
 * distingue « rien à télécharger » de « tout était déjà récupéré ».
 *
 * @returns {Promise<{invoices: object[], offertes: number, horsPeriode: number}>}
 */
async function imprimerLesModales(page, releve, { connus = new Set(), plan = null, log = () => {} } = {}) {
  const invoices = [];
  const vus = new Set();
  let offertes = 0;
  let horsPeriode = 0;
  const boutons = page.locator(SELECTEUR_BOUTON_MODALE);
  // Le n-ième bouton de la page appartient à la n-ième ligne à modale : les
  // autres lignes (lien Recurly, essai gratuit) n'en portent pas.
  for (let i = 0; i < releve.modales.length; i++) {
    const ligne = releve.modales[i];
    const issuedOn = dateFrancaiseEnIso(ligne.date);
    // Un reçu écarté par la période demandée est COMPTÉ : c'est lui qui
    // permettra de dire « ils existent, ils sont juste plus vieux » (lot 42)
    // au lieu du « Aucune nouvelle facture » qui faisait croire à une panne.
    if (!scraping.dansLaFenetre(issuedOn, plan)) { horsPeriode++; continue; }

    await boutons.nth(i).click().catch(() => {});
    await page.waitForTimeout(DELAI_MODALE_MS).catch(() => {});
    const modale = await page.evaluate(LIRE_MODALE_RECU).catch(() => null);

    if (!modale?.idTransaction || !modale.aTotal) {
      // La modale n'est pas le reçu complet mesuré le 19/08/2026 : le journal
      // DIT ce qu'elle contenait, et rien n'est déposé à sa place.
      log(`${ID} : la modale de l'achat du ${ligne.date || '(date illisible)'} n'est pas un `
        + `reçu complet — ${modale ? `contenu vu : « ${modale.apercu} »` : 'aucune modale détectée'}. `
        + 'Rien n\'est déposé à sa place ; signalez-le si le reçu s\'affiche sur le site.');
      await fermerModale(page);
      continue;
    }
    if (vus.has(modale.idTransaction)) {
      // La même modale relue deux fois = un clic qui n'a pas ouvert la bonne
      // ligne. Dit, jamais déposé en double.
      log(`${ID} : la modale de l'achat du ${ligne.date || '(date illisible)'} a rendu un reçu `
        + `déjà lu pendant ce passage (${modale.idTransaction}) — ligne sautée, rien en double`);
      await fermerModale(page);
      continue;
    }
    vus.add(modale.idTransaction);
    offertes++;

    const remoteId = `${ID}-${modale.idTransaction}`;
    if (connus.has(remoteId)) {
      log(`${ID} : reçu ${modale.idTransaction} déjà récupéré — rien à refaire`);
      await fermerModale(page);
      continue;
    }

    // Le reçu s'imprime SEUL : isolé, cadré à sa boîte, sur fond blanc. La
    // page est rétablie quoi qu'il arrive — y compris quand le rendu est
    // refusé (« finally »), sans quoi la ligne suivante lirait une page
    // amputée de son décor.
    let buffer;
    let controle = null;
    const isole = await page.evaluate(ISOLER_LE_RECU).catch(() => null);
    try {
      if (!isole) {
        throw new Error(
          `Le reçu ${modale.idTransaction} n'a pas pu être isolé de la page SoundCloud : `
            + 'rien n\'a été déposé. Signalez-le — la présentation du site a peut-être changé.'
        );
      }
      controle = controlerSourceIsolee(isole.source);
      if (controle.decor.length) {
        throw new Error(
          `L'impression du reçu ${modale.idTransaction} a été refusée : le décor du site `
            + `(${controle.decor.join(', ')}) n'avait pas quitté la page, le PDF aurait porté `
            + 'autre chose que le reçu. Rien n\'a été déposé ; signalez-le.'
        );
      }
      if (!controle.aRecu || !controle.aTotal) {
        throw new Error(
          `L'impression du reçu ${modale.idTransaction} a été refusée : la page isolée ne `
            + 'portait plus le reçu lui-même (ni « ID de transaction », ni « Total »). '
            + 'Rien n\'a été déposé ; signalez-le.'
        );
      }
      if (isole.largeur < TAILLE_MINIMALE_PX || isole.hauteur < TAILLE_MINIMALE_PX) {
        throw new Error(
          `L'impression du reçu ${modale.idTransaction} a été refusée : le reçu isolé mesure `
            + `${isole.largeur}×${isole.hauteur} points, ce qui ne peut pas être une facture. `
            + 'Rien n\'a été déposé ; signalez-le.'
        );
      }
      // La garde du 19/08/2026 au soir : un texte qui a la couleur de son fond
      // passerait toutes les gardes de contenu (il est bien DANS la page) et
      // sortirait pourtant invisible. Mesuré avant de rendre le moindre octet.
      const contraste = await page.evaluate(MESURER_LE_CONTRASTE).catch(() => null);
      const griefContraste = controlerContraste(contraste);
      if (griefContraste) {
        throw new Error(
          `L'impression du reçu ${modale.idTransaction} a été refusée : ${griefContraste}. `
            + 'Rien n\'a été déposé ; signalez-le.'
        );
      }
      buffer = Buffer.from(await page.pdf({
        // Une page taillée au contenu : plus de seconde page vide, et plus de
        // reçu repeint deux fois par la règle des éléments fixes.
        width: `${isole.largeur + 2}px`,
        height: `${isole.hauteur + 2}px`,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true,
      }));
    } finally {
      await page.evaluate(RETABLIR_LE_RECU).catch(() => {});
    }
    if (!controle.aEmetteur) {
      log(`${ID} : le reçu ${modale.idTransaction} ne porte pas la mention de l'émetteur `
        + '(SoundCloud Global Limited) — il est imprimé tel que le site le montre');
    }
    if (!identity.estPdf(buffer) || buffer.length < SEUIL_PDF_OCTETS) {
      // Un rendu blanc est un ÉCHEC dit à voix haute, jamais un dépôt.
      throw new Error(
        `L'impression du reçu ${modale.idTransaction} n'a pas produit un PDF exploitable `
          + `(${buffer.length} octets rendus) : rien n'a été déposé. Relancez la récupération ; `
          + 'si le message revient, signalez-le.'
      );
    }

    invoices.push({
      remoteId,
      filename: nomFichier({ issuedOn, remoteId }),
      issuedOn,
      amount: ligne.prix || null,
      buffer,
    });
    log(`${ID} : reçu ${modale.idTransaction} (achat du ${ligne.date || '?'}) imprimé en PDF `
      + `depuis sa modale (${buffer.length} octets)`);
    await fermerModale(page);
  }
  return { invoices, offertes, horsPeriode };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401/403 sur une facture est la session qui tombe. Identifiant TRONQUÉ.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(
      `HTTP ${reponse.status()} sur la facture ${pageDocs.idPourJournal(document.remoteId)}`
    );
  }
  if (!reponse.ok()) {
    throw new Error(
      `Téléchargement de la facture ${pageDocs.idPourJournal(document.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  // Le contenu fait foi. Un lien de facture qui ne descend pas en PDF n'est
  // JAMAIS remplacé par autre chose : rien n'est déposé, et le message le dit.
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `La facture ${pageDocs.idPourJournal(document.remoteId)} n'est pas arrivée sous forme `
        + `de PDF (${buffer.length} octets reçus) : rien n'a été déposé à sa place. `
        + 'Signalez-le — la présentation du site a peut-être changé.'
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaFacturation(config, ctx, async (page) => {
    const releve = await relever(page, ctx.log || (() => {}));
    if (!releve.lignes.length) {
      return {
        ok: true,
        invoiceCount: 0,
        accountId: null,
        message: messageReleveVide(releve.pagesVisitees),
      };
    }
    return {
      ok: true,
      invoiceCount: releve.documents.length + releve.modales.length,
      accountId: null,
      message:
        `Connexion valide — ${releve.lignes.length} achat(s) dans votre historique ${NOM} : `
        + `${releve.documents.length} avec une vraie facture PDF, ${releve.modales.length} avec `
        + `un reçu affiché en fenêtre que crabe imprime en PDF. ${RAPPEL_EMAIL}`,
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaFacturation(config, ctx, async (page, context) => {
    const releve = await relever(page, log);
    if (!releve.lignes.length) {
      // Zéro ligne sans marqueur positif : le faux « OK » du lot 31.
      throw new Error(messageReleveVide(releve.pagesVisitees));
    }

    // Preuve d'accès (lot 31). L'attestation compte les LIGNES VUES : elle ne
    // dit jamais « complet » en laissant croire que chaque ligne a son PDF.
    ctx.preuveDeListe?.({
      session: `${releve.lignes.length} ligne(s) d'achat affichée(s) sur l'historique, `
        + `dont ${releve.documents.length} avec facture PDF et ${releve.modales.length} `
        + 'avec reçu en modale',
      liste: releve.pagesVisitees.join(', '),
      elements: releve.lignes.length,
    });

    const invoices = [];
    let liensHorsPeriode = 0;
    let liensDansPeriode = 0;
    for (const doc of releve.documents) {
      // L'ordre compte : une facture DÉJÀ récupérée n'est pas « hors période »,
      // elle est simplement faite. Seules les inconnues alimentent le compte.
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) { liensHorsPeriode++; continue; }
      liensDansPeriode++;
      const buffer = await telecharger(context, doc);
      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier({ issuedOn: doc.issuedOn, remoteId: doc.remoteId }),
        issuedOn: doc.issuedOn,
        amount: doc.amount,
        buffer,
      });
    }

    // Les reçus en modale, imprimés ligne par ligne (lot 41).
    const modales = await imprimerLesModales(page, releve, { connus, plan, log });
    invoices.push(...modales.invoices);

    const horsPeriode = liensHorsPeriode + modales.horsPeriode;
    log(`${ID} : ${releve.lignes.length} ligne(s) vue(s), ${releve.documents.length} facture(s) `
      + `PDF existante(s), ${modales.offertes} reçu(s) en modale, `
      + `${invoices.length} document(s) récupéré(s)`
      + (horsPeriode ? `, ${horsPeriode} hors de la période demandée` : ''));

    // Trois silences, trois phrases. Ils s'excluent, et l'ordre les départage.
    //
    // 1. Rien n'était téléchargeable NI imprimable (lot 41) : « Aucune nouvelle
    //    facture » ferait croire à une panne.
    if (!invoices.length && !releve.documents.length && !modales.offertes && !horsPeriode) {
      return {
        invoices,
        aucunDocument:
          `SoundCloud a listé ${releve.lignes.length} achat(s) mais n'a proposé aucun document `
          + `téléchargeable ni reçu imprimable. ${RAPPEL_EMAIL}`,
      };
    }
    // 2. Des reçus existent, et TOUS sont plus vieux que la période demandée
    //    (lot 42) : le 19/08/2026, 24 reçus attendaient pendant que l'écran
    //    affichait « Aucune nouvelle facture ». Le geste à faire est dans la
    //    phrase — élargir l'historique, pas rouvrir la connexion.
    if (!invoices.length && horsPeriode && !liensDansPeriode && !modales.offertes) {
      return { invoices, horsPeriode: scraping.phraseHorsPeriode(horsPeriode, 'reçu') };
    }
    // 3. Sinon, des documents étaient bien proposés dans la période : le
    //    message générique « tout était déjà récupéré » est le bon.
    return { invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  relever,
  imprimerLesModales,
  LIRE_MODALE_RECU,
  ISOLER_LE_RECU,
  RETABLIR_LE_RECU,
  MESURER_LE_CONTRASTE,
  controlerContraste,
  CONTRASTE_MINIMAL,
  controlerSourceIsolee,
  SELECTEUR_BOUTON_MODALE,
  SEUIL_PDF_OCTETS,
  TERMES_DECOR,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  dateFrancaiseEnIso,
  referenceDuLien,
  EXTRAIRE_LIGNES,
  MOTIF_PAGE_INTROUVABLE,
  MOTIF_ENVOI_EMAIL,
  MOTIF_ESSAI_GRATUIT,
  URL_FACTURATION,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_ADRESSE_MORTE,
  RAPPEL_EMAIL,
};
