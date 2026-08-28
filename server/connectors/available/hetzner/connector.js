'use strict';

/**
 * Connecteur Hetzner — session capturée, rejouée headless, derrière « HeRay ».
 *
 * ─── La garde, et pourquoi elle n'arrête plus ce connecteur ──────────────────
 *
 * `accounts.hetzner.com/login` redirige vers `/_ray/pow` — HeRay, la garde
 * anti-robot maison de Hetzner : une preuve de travail. Le lot 18 y avait vu un
 * mur, et il avait de bonnes raisons : dans un Chromium réel mais HEADLESS, la
 * navigation bouclait et finissait sur « Request on Hold — Potential unusual
 * behavior — Please wait 61s ».
 *
 * Le lot 19 a mesuré deux choses, sur le conteneur, sans consommer une seule
 * connexion :
 *
 *   1. dans une fenêtre VISIBLE, la garde tombe TOUTE SEULE — 302 /login →
 *      200 /_ray/pow → 302 → 200 /login, formulaire atteint, aucune
 *      intervention humaine ;
 *   2. le même état rejoué HEADLESS donne 200 /login directement, sans repasser
 *      par `/_ray/pow`. La levée de garde est transportable.
 *
 * Ce qui rend l'affaire possible : **HeRay juge le CLIENT, pas l'identité**. La
 * session capturée par l'utilisateur dans la fenêtre visible du navigateur
 * distant emporte donc la levée de garde avec elle, et le planificateur — qui
 * tourne headless — la rejoue sans la redéclencher.
 *
 * ⚠ Ce qui n'est pas prouvé : qu'une session AUTHENTIFIÉE y survive elle aussi.
 * C'est probable, puisque la levée de garde y survit déjà ; mais une double
 * authentification peut lier une session à son navigateur, et personne ne l'a
 * vérifié. Si ça devait échouer, le symptôme serait un retour de `/_ray/pow` —
 * que ce connecteur détecte et NOMME, au lieu de laisser tomber un délai
 * dépassé que personne ne saurait interpréter.
 *
 * ─── La page de facturation, enfin vue (lot 24, 13/08/2026) ─────────────────
 *
 * Elle ne l'avait jamais été : le connecteur relevait les liens à l'aveugle
 * avec `connectors/documents-de-page.js`, qui retient tout lien portant le mot
 * `invoice`. Sur cette page-là, ça ramasse cinq choses qui n'en sont pas —
 * le sélecteur de langue et l'entrée de menu (tous deux vers `/invoice`),
 * les onglets `/invoice/transactions` et `/invoice/credit`, et la pagination
 * `?page=2,3,4`. La première de la liste s'appelait `hetzner-doc1` (repli
 * d'identifiant, parce que `invoice` est un mot trop commun pour en faire une
 * référence), et téléchargeait 78 850 octets de HTML. Le connecteur mourait
 * dessus AVANT d'atteindre la moindre facture.
 *
 * Ce que la page contient réellement, mesuré session ouverte :
 *
 *   - 24 factures par page, chacune sur une ligne portant date, numéro,
 *     montant et statut ;
 *   - un lien « PDF » par ligne, vers `/invoice/<numéro>/pdf` — content-type
 *     `application/pdf`, entre 49 ko et 70 ko, `%PDF-1.4` ;
 *   - un lien « CSV » à côté, vers `/invoice/<numéro>/csv` — 367 octets de
 *     tableur, que `referenceDepuisLien()` numérotait comme son PDF ;
 *   - une pagination `?page=N`, au moins 4 pages.
 *
 * D'où les trois décisions de ce connecteur :
 *
 *   1. il DÉCLARE sa route (`ROUTE_PDF`) au lieu de deviner. C'est exactement
 *      ce que `documents-de-page.js` demande qu'on fasse « le jour où
 *      quelqu'un voit la vraie page » ;
 *   2. il SUIT la pagination — sans quoi, même corrigé du reste, il n'aurait
 *      jamais vu que le quart de l'historique ;
 *   3. il n'essaie plus `/invoice/archive`, qui rend un franc 404 « Page not
 *      found » et dont les liens de menu étaient eux aussi pris pour des
 *      documents.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'hetzner';
const NOM = 'Hetzner';

const URL_FACTURATION = 'https://accounts.hetzner.com/invoice';

/**
 * La seule adresse à ouvrir.
 *
 * `/invoice/archive` a été retirée au lot 24 : elle rend un 404 « Page not
 * found ». Elle avait été inscrite au lot 20 par prudence, sans avoir été
 * essayée — et une adresse qui n'existe pas ne coûte pas qu'un aller-retour :
 * les liens de menu de sa page d'erreur étaient eux aussi relevés comme des
 * documents candidats.
 */
const URLS_DOCUMENTS = [URL_FACTURATION];

/**
 * La route d'une facture, telle qu'elle a été MESURÉE sur la page réelle.
 *
 * `/invoice/<numéro>/pdf`, et rien d'autre. Le `/csv` voisin est exclu par
 * construction : c'est un export tableur de 367 octets, qui portait jusqu'ici
 * le même identifiant distant que son PDF.
 */
const ROUTE_PDF = /^https:\/\/accounts\.hetzner\.com\/invoice\/[^/?#]+\/pdf(?:[?#]|$)/i;

/**
 * Combien de pages de liste au plus.
 *
 * Une borne, pas une limite attendue : la pagination est lue dans la page, on
 * s'arrête quand elle n'annonce plus rien. Ce nombre n'existe que pour qu'un
 * jour où Hetzner servirait une pagination circulaire, crabe s'arrête au lieu
 * de tourner sans fin. Trente pages, c'est plus de 700 factures.
 */
const PAGES_MAX = 30;

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

const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à Hetzner a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Hetzner ».';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle la garde anti-robot de Hetzner ?
 *
 * C'est un cas à part, distinct d'une session expirée : les identifiants sont
 * peut-être parfaitement valides, c'est le NAVIGATEUR que Hetzner refuse. Dire
 * « votre connexion a expiré » enverrait l'utilisateur en rouvrir une qui
 * échouerait pour la même raison.
 */
function estGardeHeRay(url) {
  try {
    return /\/_ray\//i.test(new URL(String(url)).pathname);
  } catch {
    return /\/_ray\//i.test(String(url || ''));
  }
}

/**
 * L'adresse courante est-elle une page d'authentification ? Le chemin seul.
 *
 * ⚠ `2fa` en fait partie depuis le 14/08/2026 : une session à moitié capturée
 * (mot de passe passé, code jamais saisi) dépose `/invoice` sur
 * `accounts.hetzner.com/2fa`, et sans cette reconnaissance le connecteur
 * concluait « connexion valide, mais aucune facture reconnue » — un message
 * qui accusait la présentation de la page au lieu de dire de se reconnecter
 * (trois échecs le 14/08 à 14:46-47).
 */
function estPageAuthentification(url) {
  if (estGardeHeRay(url)) return false;
  try {
    return /\/(login|logout|signin|password|2fa|otp|mfa|two-factor)(\/|$)/i.test(
      `${new URL(String(url)).pathname}/`
    );
  } catch {
    return false;
  }
}

/** Le message d'un retour de la garde, qui dit ce qu'il faut essayer. */
const MESSAGE_GARDE =
  'Hetzner a présenté sa vérification de sécurité (« HeRay ») au lieu de votre espace de '
  + 'facturation. Cette vérification juge le navigateur, pas votre compte : vos identifiants '
  + 'n\'y sont pour rien. Rouvrez la connexion depuis la fiche du service — la fenêtre visible '
  + 'de crabe sait la franchir — puis relancez la récupération.';

function erreurGarde(precision = '') {
  const err = new Error(MESSAGE_GARDE + (precision ? ` (${precision})` : ''));
  // Traitée comme une session à rouvrir : c'est bien le geste qui la corrige.
  err.sessionExpired = true;
  return err;
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucune facture » de « aucune facture RECONNUE ». */
function messageReleveVide(pagesVisitees) {
  return (
    `Connexion à ${NOM} valide, mais aucune facture n'a été reconnue sur `
    + `${pagesVisitees.join(', ')}. crabe y cherche les liens « PDF » de la liste des factures. `
    + 'Si vous en voyez bien sur cette page, signalez-le : Hetzner a changé la présentation de '
    + 'son espace de facturation, et le connecteur doit être adapté.'
  );
}

function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function surLeCompte(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  // Headless, mais AVEC le drapeau anti-automatisation (lot 34). Mesuré sur le
  // CT : sans lui, un navigateur headless reste bloqué sur la preuve de travail
  // HeRay (/_ray/pow) au-delà de 60 s ; avec lui, il la franchit en 1 s. C'est
  // ce qui manquait — la levée capturée par la fenêtre visible (qui, elle,
  // porte le drapeau) expire côté serveur en quelques heures (lots 32-33), et
  // le connecteur ne pouvait pas en refaire une lui-même. Il le peut désormais,
  // à chaque exécution, sans dépendre de la durée de vie d'une levée. Voir
  // browser-identity.optionsLancement pour la mesure complète.
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
 * Les adresses des pages SUIVANTES annoncées par la pagination de la liste.
 *
 * Écrit ici plutôt que dans le connecteur générique : la pagination de Hetzner
 * est un simple `?page=N` sur la page de liste, et c'est tout ce qu'on sait.
 * Rendre les adresses telles quelles — et non des numéros — évite d'avoir à
 * reconstruire une URL et de se tromper de forme.
 *
 * @param {string[]} liens les `href` bruts relevés dans la page
 * @param {string} base l'adresse de la liste
 * @returns {string[]} adresses distinctes, ordonnées par numéro de page
 */
function pagesSuivantes(liens, base) {
  const trouvees = new Map();
  for (const href of Array.isArray(liens) ? liens : []) {
    if (!pageDocs.memePage(href, base)) continue;
    let numero = null;
    try {
      numero = Number.parseInt(new URL(String(href)).searchParams.get('page'), 10);
    } catch {
      continue;
    }
    // La page 1 est celle qu'on lit déjà : la suivre serait une boucle.
    if (!Number.isFinite(numero) || numero < 2) continue;
    if (!trouvees.has(numero)) trouvees.set(numero, String(href));
  }
  return [...trouvees.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url);
}

/**
 * Relève les factures de la liste, pagination comprise.
 *
 * @returns {Promise<{documents: object[], pagesVisitees: string[]}>}
 */
async function relever(page, log = () => {}) {
  const pagesVisitees = [];
  const documents = [];
  const vus = new Set();

  // La file commence à la liste ; la pagination l'allonge au fur et à mesure
  // qu'on la découvre. Une page déjà visitée n'y rentre jamais deux fois : la
  // pagination de Hetzner affiche « 1 2 3 4 » sur CHAQUE page, donc chaque
  // page annonce toutes les autres.
  const aVisiter = [...URLS_DOCUMENTS];

  while (aVisiter.length && pagesVisitees.length < PAGES_MAX) {
    const url = aVisiter.shift();
    if (pagesVisitees.includes(url)) continue;

    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    pagesVisitees.push(url);

    // La garde AVANT la session expirée : les deux se ressemblent à l'écran, et
    // seul le chemin `/_ray/` les distingue.
    if (estGardeHeRay(page.url())) throw erreurGarde(`redirection vers ${page.url()}`);
    if (estPageAuthentification(page.url())) {
      throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${url}`);
    }

    const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
    const avant = documents.length;
    for (const doc of pageDocs.documentsDepuisLiens(liens, {
      prefixe: `${ID}-`,
      // La route mesurée, pas les indices génériques : c'est elle qui empêche
      // de reprendre la page de liste pour une facture.
      route: ROUTE_PDF,
    })) {
      if (vus.has(doc.remoteId)) continue;
      vus.add(doc.remoteId);
      documents.push(doc);
    }

    for (const suivante of pagesSuivantes(liens.map((l) => l.href), URL_FACTURATION)) {
      if (!pagesVisitees.includes(suivante) && !aVisiter.includes(suivante)) {
        aVisiter.push(suivante);
      }
    }

    log(
      `${ID} : ${documents.length - avant} facture(s) sur ${url}`
      + ` — ${documents.length} au total, ${aVisiter.length} page(s) restante(s)`
    );
  }

  if (pagesVisitees.length >= PAGES_MAX && aVisiter.length) {
    // Une borne atteinte se DIT : « 720 factures » sans un mot laisserait
    // croire que c'est tout ce que le compte contient.
    log(
      `${ID} : arrêt à ${PAGES_MAX} pages de liste, ${aVisiter.length} page(s) non visitée(s). `
      + 'Signalez-le : la limite de sécurité du connecteur est trop basse pour ce compte.'
    );
  }

  return { documents, pagesVisitees };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(document.url, { timeout: DELAI_TELECHARGEMENT_MS });
  // Identifiant TRONQUÉ dans les messages (règle du projet, lot 31) : un
  // identifiant de document entier n'a rien à faire dans un journal.
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
        + `(${buffer.length} octets reçus) : crabe a probablement pris un lien de l'espace `
        + `${NOM} pour une facture. Signalez-le.`
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLeCompte(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    // ⚠ Le nombre de PAGES fait partie du compte rendu, et pas par goût du
    // détail. La pagination de cet espace ne se vérifie pas depuis crabe : la
    // garde HeRay refuse tout navigateur piloté qui n'a pas été « déverrouillé »
    // par une fenêtre visible, et un essai automatique se fait renvoyer sur
    // « Security Check » (mesuré le 13/08/2026). La seule façon honnête de
    // répondre à « est-ce que crabe a bien tout vu ? » est donc de faire dire
    // au connecteur ce qu'il a réellement parcouru, et de le montrer à celui
    // qui, lui, est passé par la fenêtre.
    const pages = pagesVisitees.length > 1
      ? ` sur ${pagesVisitees.length} pages de liste`
      : ' sur une seule page de liste';

    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} document(s) trouvé(s)${pages} de votre espace ${NOM}`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLeCompte(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro document reconnu, aucun marqueur positif de session : conclure
      // « aucune nouvelle facture » serait le faux « OK » que le lot 31
      // interdit. Le message dit déjà les deux explications et quoi faire.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des documents de facturation reconnus dans
    // l'espace client n'existent que pour une session ouverte — c'est le
    // marqueur ET la liste. Déposée avant le tri des déjà-connus.
    ctx.preuveDeListe?.({
      session: `${documents.length} document(s) de facturation affiché(s) dans l'espace client`,
      liste: pagesVisitees.join(', '),
      elements: documents.length,
    });

    const invoices = [];
    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) continue;
      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier(doc),
        issuedOn: doc.issuedOn,
        amount: doc.amount,
        buffer: await telecharger(context, doc),
      });
    }
    log(
      `${ID} : ${invoices.length} facture(s) récupérée(s) sur ${documents.length} listée(s), `
      + `${pagesVisitees.length} page(s) de liste parcourue(s)`
    );
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estGardeHeRay,
  estPageAuthentification,
  erreurSessionExpiree,
  erreurGarde,
  messageReleveVide,
  nomFichier,
  lireSession,
  pagesSuivantes,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_GARDE,
  URL_FACTURATION,
  URLS_DOCUMENTS,
  ROUTE_PDF,
  PAGES_MAX,
};
