'use strict';

/**
 * Connecteur Spotify — session capturée, rejouée headless, reçus d'abonnement.
 *
 * ─── Ce que la reconnaissance du 17/08/2026 a établi (aucun identifiant) ──────
 *
 * 1. **Le parcours natif existe, gardé par un reCAPTCHA invisible.**
 *    `accounts.spotify.com/fr/login` rend un champ e-mail et un « Continuer »,
 *    avec les connexions tierces À CÔTÉ. Le reCAPTCHA Enterprise rendu sur
 *    cette page note le navigateur sans challenge par défaut — et il ne garde
 *    que la CONNEXION : le rejeu de session ne repasse pas par lui. C'est
 *    l'humain qui le traverse, une fois, dans la fenêtre visible de crabe.
 *
 * 2. **La page des paiements n'a jamais été vue.** Tout `/account/*` redirige
 *    l'anonyme vers la connexion, témoin compris : son existence vient de la
 *    documentation officielle (« Consulter vos reçus ») — historique des
 *    paiements → paiement → « Visualiser les reçus » → « Télécharger ». Le
 *    relevé passe donc par les indices génériques de `documents-de-page`, et
 *    JOURNALISE ce que la page montre quand il ne reconnaît rien.
 *
 * ─── La limite que ce connecteur refuse de taire : 2 ans ─────────────────────
 *
 * Spotify l'énonce lui-même : « Des reçus sont disponibles pour les
 * transactions des 2 dernières années. » La déclaration de couverture le
 * répète à CHAQUE exécution (`couverture.complete = false`, toujours) : « tout
 * l'historique » ne s'écrira jamais ici, parce que ce n'est jamais vrai
 * (lot 33 — l'attestation de couverture ne se déclare que quand elle est
 * vraie, et ici elle ne peut pas l'être).
 *
 * ─── Ce que la MESURE du 19/08/2026 a établi (session réelle) ────────────────
 *
 * La page des paiements (`/fr/account/payment-history/`, « 1 sur 1 ») ne porte
 * AUCUN lien de reçu : chaque ligne de paiement porte un bouton « Gérer »
 * (`aria-haspopup="menu"`, `data-encore-id="buttonSecondary"`) qui ouvre un
 * MENU, dont l'entrée « Afficher le reçu » mène à
 * `spotify.com/fr/account/payment-history/receipt/<uuid>` — et ce qui descend
 * de cette adresse est un VRAI PDF. Le connecteur clique donc ce menu, ligne
 * par ligne ; le relevé générique par liens reste en premier recours au cas où
 * Spotify servirait un jour des liens directs.
 *
 * `%PDF-` est vérifié sur ce qui descend, jamais le type annoncé — pas de HTML
 * déguisé en reçu. Si le menu n'apparaît pas ou si l'entrée manque, le journal
 * le DIT et le connecteur n'invente rien.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'spotify';
const NOM = 'Spotify';

/**
 * La page documentée par le support (« Consulter vos reçus ») : l'historique
 * des paiements du compte. Adresse donnée par la doc, jamais vue derrière une
 * session — d'où le relevé générique et le journal en cas de page muette.
 */
const URL_PAIEMENTS = 'https://www.spotify.com/fr/account/payment-history/';

/** La limite énoncée par Spotify, répétée dans la couverture et les messages. */
const LIMITE_HISTORIQUE =
  'Spotify ne conserve que les reçus des 2 dernières années';

/** Le bouton de chaque ligne de paiement, tel que mesuré le 19/08/2026. */
const SELECTEUR_BOUTON_GERER =
  'button[aria-haspopup="menu"][data-encore-id="buttonSecondary"]';

/**
 * L'entrée du menu, pour le REPLI où elle n'est pas un lien : on la clique et
 * on lit l'adresse d'arrivée. Français d'abord (la page est servie en /fr/),
 * anglais au cas où le compte serait servi dans cette langue.
 */
const SELECTEUR_ENTREE_RECU =
  '[role="menuitem"]:has-text("Afficher le reçu"), [role="menu"] a:has-text("Afficher le reçu"), '
  + '[role="menuitem"]:has-text("View receipt"), [role="menu"] a:has-text("View receipt")';

/** L'adresse d'un reçu, mesurée : …/account/payment-history/receipt/<uuid>. */
const MOTIF_URL_RECU = /\/account\/payment-history\/receipt\/([^/?#]+)/i;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/** Le menu « Gérer » se peint après le clic : lire tout de suite le raterait. */
const DELAI_MENU_MS = 1_200;

/**
 * Le compte Spotify est une application qui se peint après coup : lire tout de
 * suite reviendrait à conclure « aucun reçu » sur une page à demi montée.
 */
const DELAI_RENDU_MS = 6_000;

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
  'Votre connexion à Spotify a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Spotify » — connectez-vous avec votre adresse e-mail (pas par '
  + '« Google », « Facebook » ni « Apple », que cette fenêtre ne sait pas suivre).';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte : `/fr/account/payment-history/?continue=%2Flogin`
 * serait une page authentifiée, et la déclarer expirée ferait redemander une
 * connexion à chaque exécution. Spotify loge sa connexion sous
 * `accounts.spotify.com/fr/login` (mesuré) et ses vérifications sous
 * `/challenge` — les deux sont des pages d'authentification.
 */
function estPageAuthentification(url) {
  try {
    return /\/(login|signup|signin|sign-in|authenticate|verify|challenge)(\/|$)/i
      .test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/**
 * L'uuid d'un reçu, tiré du CHEMIN de son adresse
 * (`…/account/payment-history/receipt/<uuid>`), ou null.
 */
function recuDepuisUrl(url) {
  const m = MOTIF_URL_RECU.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * Exécutée DANS la page : une entrée par bouton « Gérer », avec le texte de sa
 * ligne de paiement — c'est elle qui porte la date, dont le nom de fichier a
 * besoin. Le sélecteur est INLINÉ : cette fonction part telle quelle dans le
 * navigateur, elle ne voit pas les constantes du module
 * (= SELECTEUR_BOUTON_GERER, mesuré le 19/08/2026).
 */
function LIRE_LIGNES_GERER() {
  return [...document.querySelectorAll(
    'button[aria-haspopup="menu"][data-encore-id="buttonSecondary"]'
  )].map((bouton) => {
    // Remonte du bouton vers sa ligne : le premier ancêtre dont le texte dit
    // plus que le libellé du bouton et porte un chiffre (date ou montant).
    let noeud = bouton;
    for (let i = 0; i < 8 && noeud.parentElement; i++) {
      noeud = noeud.parentElement;
      const texte = (noeud.innerText || '').trim();
      if (/\d/.test(texte) && texte.length > 12) break;
    }
    return { texte: (noeud.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) };
  });
}

/**
 * Exécutée DANS la page, le menu ouvert : le lien « Afficher le reçu » s'il en
 * est un (cas mesuré), l'entrée à cliquer sinon (repli), ou les libellés vus
 * pour que le journal DISE ce que le menu proposait à la place.
 */
function LIRE_MENU_RECU() {
  const lien = [...document.querySelectorAll('a[href]')]
    .find((a) => /\/account\/payment-history\/receipt\//i.test(a.href));
  if (lien) return { href: lien.href };
  const entree = [...document.querySelectorAll('[role="menuitem"], [role="menu"] a, [role="menu"] button')]
    .find((el) => /afficher le reçu|view receipt/i.test(el.innerText || ''));
  if (entree) return { cliquer: true };
  return {
    libelles: [...document.querySelectorAll('[role="menuitem"]')]
      .map((el) => (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40))
      .filter(Boolean)
      .slice(0, 12),
  };
}

/**
 * Le chemin MESURÉ le 19/08/2026 : sur chaque ligne de paiement, le bouton
 * « Gérer » ouvre un menu dont « Afficher le reçu » mène au PDF. Ligne par
 * ligne ; quand le menu ou l'entrée manque, le journal le dit et rien n'est
 * inventé à la place.
 *
 * @returns {Promise<object[]>} documents `{remoteId (uuid), url, issuedOn, fileRef}`
 */
async function releverParMenus(page, log = () => {}) {
  const lignes = await page.evaluate(LIRE_LIGNES_GERER).catch(() => []);
  const total = Array.isArray(lignes) ? lignes.length : 0;
  if (!total) {
    log(`${ID} : aucun bouton « Gérer » sur l'historique des paiements — `
      + 'le menu mesuré le 19/08/2026 n\'est plus là, ou le compte n\'a aucun paiement');
    return [];
  }

  const documents = [];
  const boutons = page.locator(SELECTEUR_BOUTON_GERER);
  for (let i = 0; i < total; i++) {
    const ligne = lignes[i] || { texte: '' };
    await boutons.nth(i).click().catch(() => {});
    await page.waitForTimeout(DELAI_MENU_MS).catch(() => {});

    const menu = await page.evaluate(LIRE_MENU_RECU).catch(() => null);
    let url = menu?.href || null;
    if (!url && menu?.cliquer) {
      // Repli : l'entrée n'est pas un lien — on la clique et on lit l'adresse
      // d'arrivée, puis on revient sur l'historique pour la ligne suivante.
      const avant = page.url();
      await page.locator(SELECTEUR_ENTREE_RECU).first().click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(DELAI_MENU_MS).catch(() => {});
      if (MOTIF_URL_RECU.test(page.url())) url = page.url();
      if (page.url() !== avant) {
        await page.goBack().catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(DELAI_MENU_MS).catch(() => {});
      }
    }

    const uuid = recuDepuisUrl(url);
    if (!uuid) {
      log(`${ID} : la ligne « ${ligne.texte || `n°${i + 1}`} » n'offre pas `
        + `« Afficher le reçu » — entrées du menu vues : ${menu?.libelles?.join(' | ') || 'aucune'}. `
        + 'Rien n\'est déposé à sa place ; si le reçu existe sur le site, signalez-le.');
    } else {
      documents.push({
        remoteId: uuid,
        url,
        issuedOn: pageDocs.dateDepuisTexte(ligne.texte),
        amount: null,
        // Le nom de fichier porte les 8 premiers caractères de l'uuid : assez
        // pour reconnaître le reçu, sans transformer le nom en identifiant opaque.
        fileRef: String(uuid).slice(0, 8),
      });
    }
    try { await page.keyboard.press('Escape'); } catch { /* menu déjà refermé */ }
  }
  log(`${ID} : ${documents.length} reçu(s) atteint(s) par le menu « Gérer » sur ${total} ligne(s) de paiement`);
  return documents;
}

/** Distingue « aucun reçu » de « aucun reçu RECONNU ». */
function messageReleveVide(pagesVisitees) {
  return (
    'Connexion à Spotify valide, mais aucun reçu n\'a été reconnu sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun paiement fait directement à Spotify (un abonnement facturé '
    + 'par un opérateur ou l\'App Store n\'apparaît pas ici, et '
    + `${LIMITE_HISTORIQUE}), soit crabe ne reconnaît pas la présentation de la page. `
    + 'Si vous voyez bien des reçus sur votre historique des paiements Spotify, signalez-le — '
    + 'c\'est le second cas, et le connecteur doit être adapté.'
  );
}

/** La déclaration de couverture, identique à chaque exécution — et jamais « complète ». */
function couverture() {
  return {
    complete: false,
    detail: `la page « Historique des paiements » de Spotify (${LIMITE_HISTORIQUE})`,
  };
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
 *
 * La session est contrôlée AVANT le lancement du navigateur, et
 * `optionsLancement()` porte le drapeau anti-automatisation (lot 35) : le
 * reCAPTCHA de Spotify note le navigateur, une session rejouée doit présenter
 * la même identité que celle de sa capture.
 */
async function surLesPaiements(config, ctx, fn) {
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

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  const pagesVisitees = [URL_PAIEMENTS];

  await page.goto(URL_PAIEMENTS, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_PAIEMENTS}`);
  }

  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  // Les indices génériques d'abord : si Spotify sert un jour des liens
  // directs, ils passent devant. `pageActuelle` écarte la navigation qui
  // ramène ici (la panne Hetzner du lot 24 — la pagination `?page=2` comprise).
  const directs = pageDocs.documentsDepuisLiens(liens, {
    prefixe: `${ID}-`,
    pageActuelle: page.url(),
  });

  // Le chemin mesuré le 19/08/2026 : le menu « Gérer » de chaque ligne. Les
  // deux voies sont dédoublonnées par l'adresse du reçu — un même document vu
  // deux fois n'en fait qu'un.
  const parMenus = await releverParMenus(page, log);
  const documents = [...directs];
  for (const doc of parMenus) {
    const uuid = recuDepuisUrl(doc.url);
    if (!documents.some((d) => (recuDepuisUrl(d.url) || d.remoteId) === (uuid || doc.remoteId))) {
      documents.push(doc);
    }
  }

  if (!documents.length) {
    await journaliserPage(page, log, 'aucun reçu atteint sur l\'historique des paiements (ni lien direct, ni menu « Gérer »)');
  }
  log(`${ID} : ${documents.length} reçu(s) reconnu(s) sur la page des paiements`);
  return { documents, pagesVisitees };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401 ou un 403 sur un reçu n'est pas une panne de téléchargement : c'est
  // la session qui vient de tomber. L'identifiant est TRONQUÉ dans le message.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(
      `HTTP ${reponse.status()} sur le reçu ${pageDocs.idPourJournal(document.remoteId)}`
    );
  }
  if (!reponse.ok()) {
    throw new Error(
      `Téléchargement du reçu ${pageDocs.idPourJournal(document.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  // Le contenu fait foi, pas l'en-tête. Le point NON vérifié de ce connecteur :
  // le bouton « Télécharger » de Spotify rend-il un PDF ? Si c'est une page
  // HTML, on le DIT, on ne dépose pas du HTML dans les documents.
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le reçu ${pageDocs.idPourJournal(document.remoteId)} n'est pas arrivé sous forme de PDF `
        + `(${buffer.length} octets reçus). L'historique des paiements de Spotify rend peut-être `
        + 'une page à imprimer plutôt qu\'un PDF direct : signalez-le, ce connecteur doit alors '
        + 'être adapté.'
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLesPaiements(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} reçu(s) trouvé(s) sur votre historique de `
          + `paiements ${NOM}. À savoir : ${LIMITE_HISTORIQUE}.`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLesPaiements(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro reçu reconnu, aucun marqueur positif : conclure « aucune nouvelle
      // facture » serait le faux « OK » que le lot 31 interdit.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des reçus reconnus sur l'historique des
    // paiements n'existent que pour une session ouverte. Déposée avant le tri
    // des déjà-connus, pour qu'un passage sans nouveauté reste un succès.
    ctx.preuveDeListe?.({
      session: `${documents.length} reçu(s) affiché(s) sur l'historique des paiements`,
      liste: pagesVisitees.join(', '),
      elements: documents.length,
    });

    const invoices = [];
    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) continue;
      const buffer = await telecharger(context, doc);
      invoices.push({
        remoteId: doc.remoteId,
        // Les reçus du menu « Gérer » se nomment par les 8 premiers caractères
        // de leur uuid (`spotify_<AAAA-MM>_<uuid8>.pdf`) ; les liens directs
        // gardent leur référence.
        filename: nomFichier({ issuedOn: doc.issuedOn, remoteId: doc.fileRef || doc.remoteId }),
        issuedOn: doc.issuedOn,
        amount: doc.amount,
        buffer,
      });
    }
    log(`${ID} : ${invoices.length} reçu(s) récupéré(s) sur ${documents.length} listé(s)`);

    // La couverture, déclarée à CHAQUE exécution et jamais « complète » :
    // Spotify n'offre que 2 ans, « tout l'historique » serait un mensonge.
    return { invoices, couverture: couverture() };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  relever,
  releverParMenus,
  recuDepuisUrl,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  couverture,
  nomFichier,
  lireSession,
  LIRE_LIGNES_GERER,
  LIRE_MENU_RECU,
  SELECTEUR_BOUTON_GERER,
  SELECTEUR_ENTREE_RECU,
  MOTIF_URL_RECU,
  URL_PAIEMENTS,
  LIMITE_HISTORIQUE,
  MESSAGE_SESSION_EXPIREE,
};
