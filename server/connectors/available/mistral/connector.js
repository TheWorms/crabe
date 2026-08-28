'use strict';

/**
 * Connecteur Mistral — session capturée, rejouée headless.
 *
 * ─── Pourquoi ce connecteur a changé de méthode au lot 21 ────────────────────
 *
 * Le lot 20 l'avait écrit en connexion scriptée : adresse électronique sur un
 * premier écran, mot de passe sur un second (le flux Ory « identifier_first »,
 * relevé sur la page réelle au lot 19). Le contrat de formulaire était juste.
 * L'hypothèse qui le portait ne l'était pas : elle supposait que le compte ait
 * un mot de passe MISTRAL.
 *
 * Le compte réel n'en a pas. Il se connecte par « Se connecter avec Google ».
 * Aucun mot de passe à stocker, donc, et rien qu'un connecteur puisse saisir
 * tout seul — un identifiant Google se saisit chez Google, derrière les
 * protections de Google, qui existent précisément pour empêcher ça. Un lot
 * entier a déjà été perdu sur ce genre de terrain (`addons-prestashop`) : on
 * n'y retourne pas.
 *
 * La session capturée règle les deux cas d'un coup — mot de passe Mistral ou
 * bouton Google, l'utilisateur se connecte comme il en a l'habitude, dans une
 * fenêtre, et c'est le résultat qui est rejoué. Même mécanisme que Free Mobile,
 * pour une raison différente.
 *
 * ─── Ce que la reconnaissance a montré, et ce qu'elle ne montre pas ──────────
 *
 * Écran de connexion, le 13/08/2026, dans un vrai Chromium : `console.mistral.ai`
 * mène à `v2.auth.mistral.ai/login?flow=<uuid>`, titre « Connexion - Mistral
 * AI », un seul champ visible (`email`), aucun captcha monté, aucun interstitiel
 * — Cloudflare sert le site mais ne garde pas la porte. AUCUN bouton tiers n'est
 * visible à ce stade : la voie Google n'apparaît qu'APRÈS la saisie de
 * l'adresse. C'est pour ça qu'aucune reconnaissance ne pouvait la prévoir, et
 * c'est pour ça qu'on ne scripte plus rien ici.
 *
 * ─── L'adresse de facturation, corrigée au lot 24 (13/08/2026) ──────────────
 *
 * Les lots 20 et 21 cherchaient sur `console.mistral.ai/admin/billing` et
 * `console.mistral.ai/billing/invoices`. Les deux étaient fausses, et la
 * reconnaissance ne pouvait pas le voir : hors session, TOUT redirige vers la
 * connexion chez Mistral, `/nawak-inexistant` compris. La redirection est posée
 * avant le routage et ne prouve l'existence d'aucune page — c'était déjà écrit
 * ici, et c'est exactement ce qui est arrivé.
 *
 * Mesuré SESSION OUVERTE, ce qui tranche là où la redirection ne disait rien :
 *
 *   console.mistral.ai/admin/billing                → HTTP 404 « This page
 *                                                     could not be found »
 *   admin.mistral.ai/nawak-inexistant-temoin        → HTTP 404 (le témoin)
 *   admin.mistral.ai/organization/billing           → HTTP 200, titre
 *                                                     « Facturation - Admin -
 *                                                     Mistral AI »
 *
 * La facturation a donc changé de domaine : `admin.mistral.ai`, pas
 * `console.mistral.ai`. La session capturée y sert telle quelle — le cookie de
 * Mistral est posé sur `.mistral.ai`, il couvre les deux sous-domaines, et
 * `keepDomains: ["mistral.ai"]` le gardait déjà.
 *
 * Ce que la page contient : un bloc « Factures » qui liste les factures avec
 * leur numéro et leur date, chacune avec un bouton « Télécharger » pointant sur
 * `api.eu.getlago.com/rails/active_storage/blobs/redirect/<jeton>/<numéro>.pdf`.
 * Mistral sous-traite sa facturation à Lago : les adresses de document sont
 * donc pré-signées et vivent sur un autre domaine que la page — c'est normal,
 * et c'est pour ça que le téléchargement ne filtre pas sur le domaine.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');
const factureStripe = require('../../facture-stripe');

const ID = 'mistral';
const NOM = 'Mistral';

const CONSOLE = 'https://console.mistral.ai';
/** L'espace d'administration, où vivent les factures depuis le lot 24. */
const ADMIN = 'https://admin.mistral.ai';

/**
 * La page de facturation. Une seule, et elle est PROUVÉE — voir l'en-tête :
 * 200 avec le titre « Facturation », là où une route inventée rend un 404.
 *
 * L'ancienne liste en essayait deux au hasard ; les deux répondaient 404 une
 * fois la session ouverte, et le connecteur annonçait tranquillement « aucune
 * nouvelle facture » à chaque exécution.
 */
const URLS_DOCUMENTS = [`${ADMIN}/organization/billing`];

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

const CHAMP_SESSION = 'session';

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

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
  'Votre connexion à Mistral a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Mistral » — reprenez le même chemin que d\'habitude, bouton Google '
  + 'compris si c\'est ainsi que vous ouvrez votre compte.';

/** Erreur reconnaissable par le socle : elle bascule le connecteur en erreur. */
function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Deux familles à reconnaître, mesurées le 13/08/2026 :
 * `auth.mistral.ai/self-service/login/browser` (le point d'entrée Ory) et
 * `v2.auth.mistral.ai/login?flow=<uuid>` (l'écran affiché). Le domaine
 * d'authentification suffit donc à trancher, et il vaut mieux que le chemin :
 * Ory renomme ses étapes plus souvent que ses sous-domaines.
 *
 * ⚠ Seul le CHEMIN est examiné pour le reste : `?return_to=…%2Flogin` serait une
 * page parfaitement authentifiée, et la déclarer expirée ferait redemander une
 * connexion à chaque exécution.
 */
function estPageAuthentification(url) {
  const texte = String(url || '');
  if (/(^|\/\/|\.)auth\.mistral\.ai/i.test(texte)) return true;
  try {
    return /\/(login|signin|sign-in|self-service|verification|recovery)(\/|$)/i.test(
      `${new URL(texte).pathname}/`
    );
  } catch {
    return false;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucune facture » de « aucune facture RECONNUE ». */
function messageReleveVide(pagesVisitees) {
  return (
    `Connexion à ${NOM} valide, mais aucun document n'a été reconnu sur `
    + `${pagesVisitees.join(', ')}. Ce service vient d'être ajouté à crabe et n'a encore été `
    + 'essayé sur aucun compte réel : si vous voyez bien des factures sur cette page, '
    + 'signalez-le, le connecteur doit être adapté à leur présentation.'
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
 *
 * La session est contrôlée AVANT le lancement du navigateur : inutile de payer
 * un démarrage de Chromium pour se faire rediriger vers la page de connexion.
 */
async function surLaConsole(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
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

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  const pagesVisitees = [];
  const documents = [];
  const vus = new Set();

  for (const url of URLS_DOCUMENTS) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    pagesVisitees.push(url);

    if (estPageAuthentification(page.url())) {
      throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${url}`);
    }

    const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
    for (const doc of pageDocs.documentsDepuisLiens(liens, {
      prefixe: `${ID}-`,
      // Sans ça, l'entrée « Facturation » du menu latéral — qui ramène à la
      // page qu'on est en train de lire — était comptée comme un document, et
      // crabe téléchargeait la page elle-même.
      pageActuelle: page.url(),
    })) {
      if (vus.has(doc.remoteId)) continue;
      vus.add(doc.remoteId);
      documents.push(doc);
    }
    log(`${ID} : ${documents.length} document(s) reconnu(s) après ${url}`);
    if (documents.length) break;
  }

  return { documents, pagesVisitees };
}

/**
 * Ce que le PDF téléchargé peut dire de mieux que la page.
 *
 * Deux cas le font lire :
 *
 *   - le lien est une PAGE de facture Stripe (lot 32) : numéro et date ne se
 *     lisent que dans le PDF — jamais dans le jeton de l'adresse, qui change
 *     à chaque rendu ;
 *   - la LIGNE de la page n'a pas livré de date (lot 40) : c'est ainsi qu'une
 *     facture Lago s'est rangée sous « inconnu » le 13/08/2026, alors que le
 *     PDF écrivait « Date d'émission 12 févr. 2026 ». Le PDF est le repli,
 *     jamais le premier mot : quand la ligne a une date, elle fait foi.
 *
 * Les factures Lago datées par la page (`…getlago.com/…/<numéro>.pdf`)
 * portent déjà leur numéro dans l'adresse et ressortent inchangées.
 */
function releveDuPdf(doc, buffer) {
  if (factureStripe.estPageFactureStripe(doc.url) || !doc.issuedOn) {
    return factureStripe.analyserPdf(buffer);
  }
  return { numero: null, dateEmission: null };
}

async function telecharger(context, document) {
  // La console lie la PAGE Stripe de la facture ; le PDF est servi ailleurs
  // (pay.stripe.com) — même panne mesurée chez Anthropic le 14/08 (745 octets
  // de HTML), même console Stripe ici. Voir documents-de-page.urlDeTelechargement.
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401 ou un 403 sur un document n'est pas une panne de téléchargement :
  // c'est la session qui vient de tomber. Le dire autrement enverrait
  // l'utilisateur chercher un défaut qui n'existe pas.
  //
  // L'identifiant est TRONQUÉ dans tous ces messages : celui des factures
  // Stripe est un jeton d'accès, il n'a rien à faire entier dans un journal.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(
      `HTTP ${reponse.status()} sur le document ${pageDocs.idPourJournal(document.remoteId)}`
    );
  }
  if (!reponse.ok()) {
    throw new Error(
      `Téléchargement du document ${pageDocs.idPourJournal(document.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le document ${pageDocs.idPourJournal(document.remoteId)} n'est pas un PDF `
        + `(${buffer.length} octets reçus) : crabe a probablement pris un lien de la console `
        + `${NOM} pour une facture. Signalez-le.`
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaConsole(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} document(s) trouvé(s) sur votre console ${NOM}`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaConsole(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro document reconnu, aucun marqueur positif de session : conclure
      // « aucune nouvelle facture » serait le faux « OK » que le lot 31
      // interdit. On échoue en reprenant le message qui dit déjà quoi faire.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des documents de facturation reconnus sur la
    // console n'existent que pour une session ouverte — c'est le marqueur ET
    // la liste. Déposée avant le tri des déjà-connus, pour qu'un passage sans
    // nouveauté reste un succès honnête.
    ctx.preuveDeListe?.({
      session: `${documents.length} document(s) de facturation affiché(s) sur la console`,
      liste: pagesVisitees.join(', '),
      elements: documents.length,
    });

    const invoices = [];
    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) continue;
      const buffer = await telecharger(context, doc);
      const releve = releveDuPdf(doc, buffer);
      const issuedOn = releve.dateEmission || doc.issuedOn;
      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier({ issuedOn, remoteId: releve.numero || doc.remoteId }),
        issuedOn,
        amount: doc.amount,
        buffer,
      });
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${documents.length} listée(s)`);
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  releveDuPdf,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  MESSAGE_SESSION_EXPIREE,
  CONSOLE,
  ADMIN,
  URLS_DOCUMENTS,
};
