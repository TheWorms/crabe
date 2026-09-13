'use strict';

/**
 * Connecteur Qobuz — session capturée, rejouée headless, reçus d'abonnement et
 * d'achats.
 *
 * ─── Ce que la reconnaissance du 17/08/2026 a établi (aucun identifiant) ──────
 *
 * 1. **Les routes « évidentes » étaient fausses.** `/fr-fr/signin` rend 404,
 *    `/my-profile` rend 404 à l'anonyme. La vraie connexion, révélée par le
 *    clic « Se connecter » de `play.qobuz.com/login`, est
 *    `www.qobuz.com/signin` : formulaire natif (e-mail + mot de passe, jeton
 *    CSRF Symfony), tiers à côté, reCAPTCHA chargé sans challenge visible.
 *
 * 2. **Le document est documenté** (help.qobuz.com, « Puis-je obtenir une
 *    facture ? ») : « Mon profil » → onglet « Mes reçus de paiement » →
 *    télécharger. Les achats d'albums vivent au même endroit.
 *
 * ─── Le piège propre à Qobuz : le 404 applicatif ─────────────────────────────
 *
 * `/my-profile` rend à l'anonyme une page 404 (« Page introuvable — Erreur
 * 404 ») — PAS une redirection vers la connexion. Personne ne sait si cette
 * adresse est la bonne derrière une session. Ce connecteur distingue donc
 * TROIS issues, et ne les confond jamais :
 *
 *   - redirection vers `/signin` → session expirée, on demande de la rouvrir ;
 *   - page 404 rendue → l'ADRESSE est morte : on le dit tel quel (signalez-le,
 *     le connecteur doit être adapté) — redemander une connexion n'y
 *     changerait rien, et c'est le faux diagnostic qu'il faut interdire ;
 *   - page rendue → on rejoint l'onglet des reçus par son libellé et on
 *     relève.
 *
 * ─── Ce qui n'est PAS vérifié ────────────────────────────────────────────────
 *
 * La présentation du profil derrière une session, et le format des reçus
 * téléchargés : `%PDF-` vérifié sur ce qui descend, page journalisée quand
 * rien n'est reconnu.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'qobuz';
const NOM = 'Qobuz';

/**
 * L'adresse du profil donnée par la documentation (« Mon profil »). Rend un
 * 404 applicatif à l'anonyme — jamais vue derrière une session, d'où la
 * détection d'adresse morte ci-dessous.
 */
const URL_PROFIL = 'https://www.qobuz.com/my-profile';

/** L'onglet documenté des reçus, dans les deux langues. */
const MOTIF_RECUS = /re[cç]us de paiement|mes re[cç]us|payment receipts/i;

/**
 * La page 404 de Qobuz, reconnue à son titre (mesuré le 17/08/2026 :
 * « Page introuvable – Erreur 404 »). En anglais au cas où le compte y serait.
 */
const MOTIF_PAGE_INTROUVABLE = /page introuvable|erreur 404|page not found|error 404/i;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/** Le profil se peint après coup : lire trop tôt = « aucun reçu » à tort. */
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
  'Votre connexion à Qobuz a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Qobuz » — connectez-vous avec votre adresse e-mail et votre mot de '
  + 'passe Qobuz.';

/** L'adresse du profil est morte : rouvrir la connexion n'y changerait RIEN. */
const MESSAGE_ADRESSE_MORTE =
  'La page du profil Qobuz n\'existe plus à l\'adresse que crabe connaît '
  + `(${URL_PROFIL} rend « page introuvable »). Ce n'est pas un problème de connexion : `
  + 'inutile de la refaire. Signalez-le — le connecteur doit être adapté à la nouvelle '
  + 'adresse du site.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte (un `?redirect=%2Fsignin` ne compte pas). Qobuz loge
 * sa connexion sous `/signin` (mesuré le 17/08/2026).
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
    'Connexion à Qobuz valide, mais aucun reçu n\'a été reconnu sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun paiement fait directement à Qobuz (un abonnement souscrit '
    + 'via l\'App Store ou Google Play est facturé par cette boutique, pas ici), soit crabe ne '
    + 'reconnaît pas la présentation de la page. Si vous voyez bien des reçus dans « Mes reçus '
    + 'de paiement » sur qobuz.com, signalez-le — c\'est le second cas, et le connecteur doit '
    + 'être adapté.'
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
 * `optionsLancement()` porte le drapeau anti-automatisation (lot 35) : le
 * reCAPTCHA de Qobuz note le navigateur, une session rejouée doit présenter la
 * même identité que celle de sa capture.
 */
async function surLeProfil(config, ctx, fn) {
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

/**
 * Ouvre le profil et tranche entre les trois issues (connexion / 404 / rendu),
 * puis rejoint l'onglet « Mes reçus de paiement » par son libellé — lien
 * d'abord, clic d'onglet ensuite, comme Deezer.
 *
 * @returns {Promise<string[]>} les adresses visitées, pour les messages
 */
async function ouvrirLesRecus(page, log) {
  const pagesVisitees = [URL_PROFIL];

  await page.goto(URL_PROFIL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_PROFIL}`);
  }

  // Le 404 applicatif : l'adresse est morte, PAS la session. Confondre les
  // deux ferait rouvrir des connexions pour rien, à chaque exécution.
  const titre = await page.title().catch(() => '');
  if (MOTIF_PAGE_INTROUVABLE.test(titre)) {
    throw new Error(MESSAGE_ADRESSE_MORTE);
  }

  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  const lienRecus = (Array.isArray(liens) ? liens : [])
    .find((l) => MOTIF_RECUS.test(`${l?.texte ?? ''}`));

  if (lienRecus) {
    await page.goto(lienRecus.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
  } else {
    const clique = await page.evaluate((motif) => {
      const re = new RegExp(motif, 'i');
      const candidats = [...document.querySelectorAll('button, [role="tab"], [role="button"]')];
      const cible = candidats.find((el) => re.test((el.innerText || '').trim()));
      if (!cible) return false;
      cible.click();
      return true;
    }, MOTIF_RECUS.source).catch(() => false);
    if (clique) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
    } else {
      await journaliserPage(page, log, 'ni lien ni onglet « Mes reçus de paiement » reconnu');
    }
  }

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('redirection vers la connexion en ouvrant les reçus de paiement');
  }

  if (!pageDocs.memePage(page.url(), URL_PROFIL)) pagesVisitees.push(page.url());
  return pagesVisitees;
}

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  const pagesVisitees = await ouvrirLesRecus(page, log);

  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  // Pas de route déclarée : personne n'a vu l'onglet des reçus derrière une
  // session. Indices génériques + `pageActuelle` (la panne Hetzner).
  const documents = pageDocs.documentsDepuisLiens(liens, {
    prefixe: `${ID}-`,
    pageActuelle: page.url(),
  });

  if (!documents.length) {
    await journaliserPage(page, log, 'aucun lien de reçu reconnu sur la page');
  }
  log(`${ID} : ${documents.length} reçu(s) reconnu(s) sur ${pagesVisitees[pagesVisitees.length - 1]}`);
  return { documents, pagesVisitees };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401/403 sur un reçu est la session qui tombe, pas une panne réseau.
  // L'identifiant est TRONQUÉ dans le message.
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
  // Le contenu fait foi, pas l'en-tête : jamais de HTML déguisé en reçu.
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le reçu ${pageDocs.idPourJournal(document.remoteId)} n'est pas arrivé sous forme de PDF `
        + `(${buffer.length} octets reçus). La page des reçus de Qobuz rend peut-être une page `
        + 'à imprimer plutôt qu\'un PDF direct : signalez-le, ce connecteur doit alors être '
        + 'adapté.'
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLeProfil(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} reçu(s) trouvé(s) dans « Mes reçus de paiement » ${NOM}`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLeProfil(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro reçu reconnu sans marqueur positif : le faux « OK » du lot 31.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31), déposée avant le tri des déjà-connus.
    ctx.preuveDeListe?.({
      session: `${documents.length} reçu(s) affiché(s) dans « Mes reçus de paiement »`,
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
  ouvrirLesRecus,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  MOTIF_RECUS,
  MOTIF_PAGE_INTROUVABLE,
  URL_PROFIL,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_ADRESSE_MORTE,
};
