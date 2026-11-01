'use strict';

/**
 * Connecteur Recraft — session capturée, rejouée headless (0.2.16, lot l7).
 *
 * Écrit SANS COMPTE, d'après la documentation de Recraft (voir la note
 * technique du manifeste) : la connexion est gardée par un Turnstile, que
 * l'utilisateur passe une fois dans la fenêtre ; les factures vivent dans le
 * portail de facturation Stripe, derrière le bouton « Manage billing
 * details » de la page d'abonnement.
 *
 * Le chemin, dans l'ordre :
 *
 *   1. `www.recraft.ai/profile/billing` avec la session (« Manage
 *      subscription ») — un renvoi vers `id.recraft.ai` dit la session morte ;
 *   2. le bouton « Manage billing details » : Recraft crée une session de
 *      portail Stripe et y envoie le navigateur (même onglet, ou nouveau) ;
 *   3. le portail (`billing.stripe.com`) : « Invoice history », déplié par
 *      « View more » tant qu'il y en a ;
 *   4. chaque facture est une page `invoice.stripe.com/i/acct_…/…`, dont le
 *      PDF se déduit (`pay.stripe.com/invoice/…/pdf`) ; numéro et date se
 *      lisent dans le PDF.
 *
 * Ce qui n'est pas mesuré est dit tel quel dans les messages : le libellé du
 * bouton peut différer (langue, refonte) — le connecteur l'écrit au journal et
 * échoue en le disant, jamais par un faux « aucune nouvelle facture ».
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');
const factureStripe = require('../../facture-stripe');

const ID = 'recraft';
const NOM = 'Recraft';

// Mesuré le 01/11/2026 sur le compte du compte observé (relevé de page) : la page
// « Abonnement » est `profile/subscription`, en français.
const ABONNEMENT = 'https://www.recraft.ai/profile/subscription';

const VIEWPORT = { width: 1440, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_PORTAIL_MS = 30_000;
const DELAI_TELECHARGEMENT_MS = 60_000;
/** « View more » dans l'historique : au plus autant de fois (douze ans de mensualités). */
const DEPLIAGES_MAX = 15;

const CHAMP_SESSION = 'session';

/**
 * Les points remplaçables par les essais : le lancement du navigateur et de
 * son contexte, et l'adresse d'où télécharger un PDF (le téléchargement passe
 * par la pile réseau de Node, qui ne suit pas les règles du navigateur).
 */
const ouverture = {
  lancement: () => identity.optionsLancement(),
  contexte: () => ({}),
  adresseDuPdf: (url) => url,
  /** L'attente d'un portail peint (30 s ; réduite par les essais). */
  delaiPeintureMs: 30_000,
};

/**
 * Le bouton qui ouvre le portail Stripe. MESURÉ (01/11/2026) : « Gérer », le
 * bouton qui suit l'intertitre « Informations de facturation » (« Vous allez
 * être redirigé vers Stripe »). En anglais, la documentation dit « Manage
 * billing details ». Le bouton se cherche D'ABORD sous l'intertitre — « Gérer »
 * seul est trop commun pour être pris ailleurs sur la page.
 */
const INTERTITRE_FACTURATION = /informations de facturation|billing (details|information)/i;
const LIBELLE_PORTAIL = /^\s*(g[ée]rer|manage)\s*$|manage billing|billing details/i;

/**
 * Le portail est-il PEINT ? MESURÉ (01/11/2026) : l'intertitre « Historique de
 * facturation » (« Invoice history » en anglais) et le lien « Retour vers
 * Recraft, Inc. » (`data-testid="return-to-business-link"`). Le premier essai
 * réel a relevé le portail trop tôt — aucun lien, pas même celui-là — et
 * concluait « aucune facture » : un faux succès.
 */
const PORTAIL_PEINT = '[data-testid="return-to-business-link"], [data-testid="billing-portal-invoice-row"]';
const INTERTITRE_HISTORIQUE = /historique de facturation|invoice history|billing history/i;

/** Le bouton du portail Stripe qui déplie l'historique. */
const LIBELLE_PLUS = /^\s*(view more|voir plus|afficher plus|show more)\s*$/i;

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(`Playwright n'est pas installé : le connecteur ${NOM} ne peut pas fonctionner.`);
  }
}

const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à Recraft a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Recraft » — la vérification anti-robot de Recraft se passe dans la fenêtre.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/** L'écran de connexion Recraft : son Keycloak, ou une page `…/auth/login`. */
function estPageAuthentification(url) {
  const texte = String(url || '');
  if (/(^|\/\/|\.)id\.recraft\.ai/i.test(texte)) return true;
  try {
    return /\/(auth|login|signin|sign-in)(\/|$)/i.test(`${new URL(texte).pathname}/`);
  } catch {
    return false;
  }
}

/** Le portail de facturation Stripe. */
function estPortailStripe(url) {
  try {
    return new URL(String(url || '')).hostname === 'billing.stripe.com';
  } catch {
    return false;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

/** Les documents du portail : les pages de facture Stripe, et elles seules. */
function documentsDuPortail(liens) {
  return pageDocs.documentsDepuisLiens(liens, {
    prefixe: `${ID}-`,
    route: (url) => factureStripe.estPageFactureStripe(url),
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function surLeCompte(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  // Les options de lancement d'une récupération : Recraft est servi par
  // Cloudflare, qui juge aussi le navigateur (voir browser-identity.js).
  const browser = await chromium.launch(ouverture.lancement());
  try {
    const context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, ...ouverture.contexte() })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** La page d'abonnement, puis le portail Stripe : rend la page du portail. */
async function ouvrirLePortail(page, context, log) {
  await page.goto(ABONNEMENT, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('renvoi vers la connexion en ouvrant la page d\'abonnement');
  }

  // Le bouton qui suit l'intertitre de facturation, sinon un libellé explicite.
  const sousIntertitre = page.locator('h1, h2, h3, h4', { hasText: INTERTITRE_FACTURATION }).first()
    .locator('xpath=following::*[self::button or self::a][1]');
  const bouton = (await sousIntertitre.count().catch(() => 0))
    ? sousIntertitre
    : page.getByRole('button', { name: /manage billing|billing details/i }).first();
  if (!(await bouton.count().catch(() => 0))) {
    const boutons = await page.evaluate(() => [...document.querySelectorAll('button, a')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25)).catch(() => []);
    log(`${ID} : bouton du portail introuvable ; boutons vus : ${boutons.join(' | ')}`);
    throw new Error(`Connexion à ${NOM} valide, mais le bouton « Gérer » des informations de facturation n'a pas été trouvé sur la page `
      + 'de votre abonnement. Ce service vient d\'être ajouté à crabe : signalez-le, le connecteur doit être adapté.');
  }

  const nouvelOnglet = context.waitForEvent('page', { timeout: DELAI_PORTAIL_MS }).catch(() => null);
  await bouton.click();
  const portail = await Promise.race([
    page.waitForURL((u) => estPortailStripe(u.toString()), { timeout: DELAI_PORTAIL_MS }).then(() => page).catch(() => null),
    nouvelOnglet,
  ]);
  if (!portail || !estPortailStripe(portail.url())) {
    // L'onglet a pu s'ouvrir avant d'atteindre Stripe.
    if (portail) await portail.waitForURL((u) => estPortailStripe(u.toString()), { timeout: DELAI_PORTAIL_MS }).catch(() => {});
    if (!portail || !estPortailStripe(portail.url())) {
      throw new Error(`Le portail de facturation de ${NOM} ne s'est pas ouvert après « Manage billing details ».`);
    }
  }
  await portail.waitForLoadState('networkidle').catch(() => {});
  log(`${ID} : portail de facturation Stripe ouvert.`);
  return portail;
}

/** Déplie l'historique des factures, puis rend ses documents. */
async function releverLePortail(portail, log) {
  // Attendre que le portail soit peint : « networkidle » arrive tôt quand des
  // ressources de Stripe sont bloquées (filtre DNS, mesuré le 01/11/2026).
  await portail.waitForSelector(PORTAIL_PEINT, { timeout: ouverture.delaiPeintureMs }).catch(() => {});
  const texte = await portail.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  if (!INTERTITRE_HISTORIQUE.test(texte)) {
    throw new Error(`Le portail de facturation de ${NOM} s'est ouvert mais ne s'est pas affiché `
      + `(ni « Historique de facturation », ni la liste des factures, après ${ouverture.delaiPeintureMs / 1000} s) : `
      + 'rien n\'a pu être lu. Relancez la récupération ; si cela se reproduit, signalez-le.');
  }
  // Les lignes de factures, si l'historique en a.
  await portail.waitForSelector('a[data-testid="hip-link"]', { timeout: 5_000 }).catch(() => {});
  for (let i = 0; i < DEPLIAGES_MAX; i++) {
    const plus = portail.getByRole('button', { name: LIBELLE_PLUS }).first();
    if (!(await plus.count().catch(() => 0)) || !(await plus.isVisible().catch(() => false))) break;
    await plus.click().catch(() => {});
    await portail.waitForLoadState('networkidle').catch(() => {});
    await portail.waitForTimeout(800);
  }
  const liens = await portail.evaluate(pageDocs.releverLiens).catch(() => []);
  const documents = documentsDuPortail(liens);
  log(`${ID} : ${documents.length} facture(s) dans l'historique du portail.`);
  return documents;
}

async function telecharger(context, document) {
  const reponse = await context.request.get(ouverture.adresseDuPdf(pageDocs.urlDeTelechargement(document.url)), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  if (!reponse.ok()) {
    throw new Error(`Téléchargement de la facture ${pageDocs.idPourJournal(document.remoteId)} impossible (HTTP ${reponse.status()}).`);
  }
  const buffer = Buffer.from(await reponse.body());
  if (!identity.estPdf(buffer)) {
    throw new Error(`La facture ${pageDocs.idPourJournal(document.remoteId)} n'est pas un PDF (${buffer.length} octets reçus).`);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLeCompte(config, ctx, async (page, context) => {
    const documents = await releverLePortail(await ouvrirLePortail(page, context, ctx.log || (() => {})), ctx.log || (() => {}));
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: `Connexion valide — ${documents.length} facture(s) dans votre portail de facturation ${NOM}`,
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLeCompte(config, ctx, async (page, context) => {
    const portail = await ouvrirLePortail(page, context, log);
    const documents = await releverLePortail(portail, log);

    // Le portail Stripe ne s'ouvre qu'à une session établie : l'atteindre est
    // la preuve, même sans facture (un abonnement neuf n'en a pas encore).
    ctx.preuveDeListe?.({
      session: 'portail de facturation Stripe ouvert depuis la page d\'abonnement',
      liste: 'Invoice history',
      elements: documents.length,
    });

    const invoices = [];
    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      const buffer = await telecharger(context, doc);
      const releve = factureStripe.analyserPdf(buffer);
      const issuedOn = releve.dateEmission || doc.issuedOn;
      if (!scraping.dansLaFenetre(issuedOn, plan)) continue;
      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier({ issuedOn, remoteId: releve.numero || doc.remoteId }),
        issuedOn,
        // Le montant n'est pas relevé : les lignes du portail sont en anglais
        // (« Nov 1, 2026 $12.00 »), que la lecture française des montants
        // découpe mal — mieux vaut rien qu'un montant faux.
        amount: null,
        buffer,
      });
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${documents.length} listée(s).`);
    return sessionState.avecSessionRenouvelee(context, invoices, (t) => log(`${ID} : ${t}`));
  });
}

module.exports = {
  test,
  fetchInvoices,
  ouverture,
  // exportés pour les tests unitaires
  estPageAuthentification,
  estPortailStripe,
  documentsDuPortail,
  erreurSessionExpiree,
  nomFichier,
  lireSession,
  LIBELLE_PORTAIL,
  INTERTITRE_FACTURATION,
  LIBELLE_PLUS,
  ABONNEMENT,
  MESSAGE_SESSION_EXPIREE,
};
