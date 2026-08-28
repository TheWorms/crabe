'use strict';

/**
 * Connecteur Airbnb — session capturée, rejouée headless, reçus de séjours.
 *
 * ─── Ce que la reconnaissance du 15/08/2026 a établi (aucun identifiant) ──────
 *
 * 1. **Aucun dispositif anti-robot chez Airbnb.** `www.airbnb.fr/login` répond
 *    200, servi par `nginx`, sans DataDome, sans Cloudflare, sans captcha, sans
 *    aucun script de garde tiers. La page des paiements
 *    (`account-settings/payments/your-payments`), la cible réelle, s'ouvre elle
 *    aussi sans garde. C'est ce qui distingue Airbnb d'Anthropic ou de
 *    PrestaShop Addons : ici, pas de levée de garde à transporter, la session
 *    seule suffit.
 *
 * 2. **Le document est un PDF.** Airbnb génère un reçu téléchargeable
 *    (« Download PDF version »). Sur le compte réel mesuré, relevé le 14/08, chaque
 *    paiement porte un lien `receipt-on-demand` avec `bill_token`,
 *    `tender_token`, `product_id` — d'où la route déclarée plus bas.
 *
 * ─── L'obstacle, et il n'est pas chez Airbnb : Google ──────────────────────────
 *
 * Le compte réel mesuré est lié à Google, et **Google bloque net un navigateur
 * piloté** sur sa page de connexion — mesuré, adresse bidon : le « Suivant »
 * renvoie vers `/v3/signin/rejected`, « Ce navigateur ou cette application ne
 * sont peut-être pas sécurisés ». Ce blocage ne se contourne pas, et le drapeau
 * `AutomationControlled` ne le lève pas (le refus juge le navigateur, après la
 * saisie). D'où la CONDITION portée par le manifeste : la connexion doit être
 * NATIVE (mot de passe Airbnb), pas « par Google ». C'est une décision de l'utilisateur.
 *
 * ─── Pourquoi une session, et pas un mot de passe ────────────────────────────
 *
 * La connexion peut traverser un fournisseur d'identité tiers, et un code par
 * e-mail ou une double authentification peuvent s'intercaler — rien qu'un
 * connecteur puisse saisir seul. La session capturée dans la fenêtre visible
 * couvre tous les cas. `remoteLogin.keepDomains` restreint la photo de fin de
 * parcours à `airbnb.fr`/`airbnb.com` : si la connexion empruntait Google, ses
 * cookies seraient écartés avant tout chiffrement (`session-state`).
 *
 * ─── Ce qui n'est PAS vérifié, et c'est le seul point qui reste ───────────────
 *
 * La réponse réelle du lien `receipt-on-demand` derrière une session : rend-il
 * le PDF directement, ou une page à imprimer avec un bouton « Download PDF » ?
 * Personne ne l'a vu, faute de compte. Le connecteur télécharge le lien,
 * **vérifie `%PDF-`**, et DIT clairement si ce n'est pas un PDF — plutôt que de
 * déposer une page HTML dans le dossier des reçus. C'est la première chose à
 * relire à la première exécution réelle.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'airbnb';
const NOM = 'Airbnb';

/**
 * La page des paiements du compte : c'est elle qui liste, par année, les
 * paiements et leurs liens `receipt-on-demand`. Relevé sur le compte réel mesuré le
 * 14/08/2026.
 */
const URL_PAIEMENTS = 'https://www.airbnb.fr/account-settings/payments/your-payments';

/**
 * La route EXACTE des reçus, connue du relevé réel : le lien
 * `receipt-on-demand` porte les jetons de facturation. La lui déclarer (plutôt
 * que de s'en remettre aux indices génériques de `documents-de-page`) évite de
 * ramasser un lien de navigation qui porterait par hasard le mot « reçu ».
 */
const ROUTE_RECU = /receipt-on-demand|\/receipt(s)?\//i;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/**
 * Airbnb est une application qui se peint après coup : la liste des paiements
 * n'est pas dans le HTML initial. Sans cette pause, on lirait une page à demi
 * montée et on conclurait « aucun reçu » sur une liste pas encore là.
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
  'Votre connexion à Airbnb a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Airbnb » — connectez-vous par e-mail (pas par « Google », qu\'Airbnb '
  + 'refuse à un programme).';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte : `/account-settings/payments?returnTo=%2Flogin` serait
 * une page authentifiée, et la déclarer expirée ferait redemander une connexion
 * à chaque exécution.
 */
function estPageAuthentification(url) {
  try {
    return /\/(login|signup|signin|sign-in|authenticate|verify)(\/|$)/i
      .test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucun reçu » de « aucun reçu RECONNU ». */
function messageReleveVide(pagesVisitees) {
  return (
    'Connexion à Airbnb valide, mais aucun reçu n\'a été reconnu sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun paiement, soit crabe ne reconnaît pas la présentation de la '
    + 'page. Si vous voyez bien des reçus à télécharger sur cette page, signalez-le — c\'est le '
    + 'second cas, et le connecteur doit être adapté.'
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
 * un démarrage de Chromium pour se faire rediriger vers la connexion, et une
 * session vide ou périmée se voit sans sortir de la machine.
 *
 * `optionsLancement()` porte le drapeau anti-automatisation (lot 35), comme
 * tous les rejeux de session : Airbnb ne le réclame pas aujourd'hui, mais une
 * session rejouée doit présenter la même identité que celle de sa capture.
 */
async function surLePaiements(config, ctx, fn) {
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

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  const pagesVisitees = [URL_PAIEMENTS];

  await page.goto(URL_PAIEMENTS, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  // L'application se peint après coup : lire tout de suite reviendrait à lire
  // une page à demi montée.
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_PAIEMENTS}`);
  }

  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  const documents = [];
  const vus = new Set();
  for (const doc of pageDocs.documentsDepuisLiens(liens, {
    prefixe: `${ID}-`,
    // La route connue prime sur les indices génériques : seuls les liens
    // `receipt-on-demand` sont des reçus, tout le reste est de la navigation.
    route: ROUTE_RECU,
    pageActuelle: page.url(),
  })) {
    if (vus.has(doc.remoteId)) continue;
    vus.add(doc.remoteId);
    documents.push(doc);
  }
  log(`${ID} : ${documents.length} reçu(s) reconnu(s) sur la page des paiements`);
  return { documents, pagesVisitees };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401 ou un 403 sur un reçu n'est pas une panne de téléchargement : c'est
  // la session qui vient de tomber. L'identifiant est TRONQUÉ dans le message —
  // le lien de reçu porte des jetons de facturation qui n'ont rien à faire
  // entier dans un journal.
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
  // le lien `receipt-on-demand` pourrait rendre une page HTML à imprimer plutôt
  // que le PDF. Si c'est le cas, on le DIT, on ne dépose pas du HTML.
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le reçu ${pageDocs.idPourJournal(document.remoteId)} n'est pas arrivé sous forme de PDF `
        + `(${buffer.length} octets reçus). Le lien de reçu d'Airbnb rend peut-être une page à `
        + 'imprimer plutôt qu\'un PDF direct : signalez-le, ce connecteur doit alors être adapté.'
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLePaiements(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} reçu(s) trouvé(s) sur votre page de paiements ${NOM}`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLePaiements(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro reçu reconnu, aucun marqueur positif : conclure « aucune nouvelle
      // facture » serait le faux « OK » que le lot 31 interdit.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des reçus reconnus sur la page des paiements
    // n'existent que pour une session ouverte — c'est le marqueur ET la liste.
    // Déposée avant le tri des déjà-connus, pour qu'un passage sans nouveauté
    // reste un succès honnête.
    ctx.preuveDeListe?.({
      session: `${documents.length} reçu(s) affiché(s) sur la page des paiements`,
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
        filename: nomFichier({ issuedOn: doc.issuedOn, remoteId: doc.remoteId }),
        issuedOn: doc.issuedOn,
        amount: doc.amount,
        buffer,
      });
    }
    log(`${ID} : ${invoices.length} reçu(s) récupéré(s) sur ${documents.length} listé(s)`);
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  relever,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  ROUTE_RECU,
  URL_PAIEMENTS,
  MESSAGE_SESSION_EXPIREE,
};
