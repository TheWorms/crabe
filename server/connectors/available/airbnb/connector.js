'use strict';

/**
 * Connecteur Airbnb — session capturée, rejouée headless, reçus de séjours.
 *
 * ─── Le parcours, mesuré sur un compte réel (lot 71, 08/09/2026) ─────────────
 *
 * La page des paiements (`account-settings/payments/your-payments`), visée par
 * l'écriture initiale du lot 35, ne liste que les paiements RÉCENTS : sur un
 * compte à quatre séjours, elle n'en montrait qu'un. La bonne source est la
 * page des voyages, `/trips` — celle-là même qui sert de preuve de session
 * depuis le lot 70 :
 *
 *   1. `/trips` liste TOUS les séjours passés (section `past-trips-section`),
 *      chacun derrière un lien `/trips/v1/<identifiant de séjour>` dont la
 *      carte porte la ville et les dates du séjour, année comprise ;
 *   2. chaque détail de séjour porte UN lien de réservation (`…/ro/…`) ;
 *   3. la page de réservation porte — quand le site le propose encore — un
 *      lien « Voir le reçu » vers `receipt-on-demand?bill_token=…`, qui rend
 *      le PDF DIRECTEMENT (mesuré : 200, `application/pdf`, `%PDF-`).
 *
 *   ⚠ Mesuré aussi, et c'est un FAIT, pas une panne : les séjours anciens
 *   (2019, 2020 sur le compte de mesure) n'ont PLUS de lien de reçu — pas même
 *   le mot dans la page. Le connecteur le compte et le dit tel quel.
 *
 * ─── L'identifiant de reçu : le séjour, jamais le lien ───────────────────────
 *
 * Le lien `receipt-on-demand` porte `bill_token`, `tender_token`, `product_id`
 * et `user_id` — et `referenceDepuisLien` en tirait le DERNIER paramètre :
 * `user_id`, identique pour tous les reçus du compte (mesuré lot 71, booléens).
 * L'ancien schéma ne pouvait donc jamais tenir qu'UN reçu par compte : le
 * dédoublonnage écrasait tous les autres. Le `remoteId` s'ancre désormais sur
 * l'identifiant de séjour lu dans l'adresse `/trips/v1/<id>` — stable, propre
 * au séjour, jamais l'empreinte du PDF (contenu regénéré à chaque demande).
 *
 * Un reçu déposé sous l'ancien schéma (`airbnb-<user_id>`) est RECONNU, pas
 * redéposé : comme l'ancien parcours ne pouvait tenir qu'un reçu — celui du
 * paiement le plus récent —, sa présence en base vaut « le reçu du séjour le
 * plus récent est déjà là » (voir `indexRecuHerite`).
 *
 * ─── L'obstacle, et il n'est pas chez Airbnb : Google ────────────────────────
 *
 * Le compte peut être lié à Google, et **Google bloque net un navigateur
 * piloté** sur sa page de connexion — mesuré, adresse bidon : le « Suivant »
 * renvoie vers `/v3/signin/rejected`. Ce blocage ne se contourne pas. D'où la
 * CONDITION portée par le manifeste : la connexion doit être NATIVE (mot de
 * passe Airbnb), pas « par Google ».
 *
 * ─── Pourquoi une session, et pas un mot de passe ────────────────────────────
 *
 * La connexion peut traverser un fournisseur d'identité tiers, et un code par
 * e-mail ou une double authentification peuvent s'intercaler — rien qu'un
 * connecteur puisse saisir seul. La session capturée dans la fenêtre visible
 * couvre tous les cas. `remoteLogin.keepDomains` restreint la photo de fin de
 * parcours à `airbnb.fr`/`airbnb.com`.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'airbnb';
const NOM = 'Airbnb';

/**
 * La page des voyages : elle liste TOUS les séjours passés — c'est aussi la
 * preuve de session du lot 70 (`verifyUrl`). La page des paiements, elle, ne
 * montre que le récent (mesuré lot 71) : elle n'est plus la source.
 */
const URL_VOYAGES = 'https://www.airbnb.fr/trips';

/** Un lien de détail de séjour, et l'identifiant de séjour qu'il porte. */
const LIEN_SEJOUR = /\/trips\/v\d+\/(\d+)/;

/** Le lien de réservation qu'un détail de séjour porte (mesuré lot 71). */
const LIEN_RESERVATION = /\/ro\//;

/**
 * La route EXACTE des reçus : le lien « Voir le reçu » de la page de
 * réservation porte les jetons de facturation. La déclarer (plutôt que de s'en
 * remettre aux indices génériques de `documents-de-page`) évite de ramasser un
 * lien de navigation qui porterait par hasard le mot « reçu ».
 */
const ROUTE_RECU = /receipt-on-demand|\/receipt(s)?\//i;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/**
 * Airbnb est une application qui se peint après coup : ni la liste des
 * séjours, ni la page de réservation ne sont dans le HTML initial. Sans cette
 * pause, on lirait une page à demi montée et on conclurait « aucun séjour »
 * sur une liste pas encore là.
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
 * Seul le CHEMIN compte : `/trips?returnTo=%2Flogin` serait une page
 * authentifiée, et la déclarer expirée ferait redemander une connexion à
 * chaque exécution.
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

/** Distingue « aucun séjour » de « aucun séjour RECONNU ». */
function messageReleveVide() {
  return (
    'Connexion à Airbnb valide, mais aucun séjour n\'a été reconnu sur votre page '
    + `Voyages (${URL_VOYAGES}). Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun séjour passé, soit crabe ne reconnaît pas la présentation '
    + 'de la page. Si vous voyez bien vos séjours sur cette page, signalez-le — c\'est le '
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
// Lecture pure : séjours et reconnaissance de l'ancien schéma
// ---------------------------------------------------------------------------

/**
 * Les séjours d'une page `/trips`, depuis ses liens relevés.
 *
 * La carte d'un séjour EST son lien : son texte porte la ville et les dates
 * (« Ville, 12–15 mars 2026 » sur le compte de mesure) — `dateDepuisTexte` y
 * lit la date de FIN du séjour, qui date le reçu. Dédoublonné par identifiant
 * de séjour, dans l'ordre de la page (le plus récent d'abord).
 *
 * @param {Array<{href: string, texte?: string, ligne?: string}>} liens
 * @returns {Array<{tripId: string, url: string, issuedOn: string|null}>}
 */
function sejoursDepuisLiens(liens) {
  const vus = new Set();
  const sortie = [];
  for (const lien of Array.isArray(liens) ? liens : []) {
    const href = String(lien?.href ?? '');
    const m = LIEN_SEJOUR.exec(href);
    if (!m) continue;
    if (vus.has(m[1])) continue;
    vus.add(m[1]);
    sortie.push({
      tripId: m[1],
      url: href,
      // Le texte du lien d'abord : c'est la carte elle-même. La `ligne` peut
      // agréger plusieurs cartes (conteneur commun) et daterait ce séjour-ci
      // avec les dates de celui-là.
      issuedOn: pageDocs.dateDepuisTexte(lien?.texte) || pageDocs.dateDepuisTexte(lien?.ligne),
    });
  }
  return sortie;
}

/**
 * Le rang du reçu déjà déposé sous l'ANCIEN schéma, ou -1.
 *
 * L'ancien `remoteId` venait de `referenceDepuisLien` sur le lien de reçu :
 * son dernier paramètre, `user_id` — identique pour tous les reçus du compte
 * (mesuré lot 71). L'ancien parcours ne pouvait donc tenir qu'UN reçu : celui
 * du paiement le plus récent, seul listé par la page des paiements. Si un
 * identifiant de cette forme est connu en base, c'est le reçu du séjour le
 * plus récent AVEC reçu qui est déjà là — le premier de la liste.
 *
 * @param {Array<{url: string}>} documents les reçus trouvés, plus récent d'abord
 * @param {Set<string>} connus les `remote_id` déjà en base
 * @returns {number}
 */
function indexRecuHerite(documents, connus) {
  if (!documents.length) return -1;
  for (const doc of documents) {
    const herite = pageDocs.referenceDepuisLien(doc.url);
    if (herite && connus.has(`${ID}-${herite}`)) return 0;
  }
  return -1;
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
async function surLaSession(config, ctx, fn) {
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

/** Ouvre une adresse et laisse l'application se peindre. */
async function ouvrir(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  // L'application se peint après coup : lire tout de suite reviendrait à lire
  // une page à demi montée.
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
}

/** Les séjours listés par la page des voyages. */
async function releverSejours(page) {
  await ouvrir(page, URL_VOYAGES);
  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_VOYAGES}`);
  }
  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  return sejoursDepuisLiens(liens);
}

/**
 * Le lien de reçu d'un séjour, ou `null` quand le site n'en propose plus.
 *
 * Deux pages à traverser : le détail du séjour (qui porte le lien de
 * réservation `/ro/`), puis la réservation (qui porte — ou non — le lien
 * « Voir le reçu »). Un séjour ancien sans reçu est un FAIT du site, pas une
 * panne : l'appelant le compte et le dit.
 */
async function lienDeRecu(page, sejour) {
  await ouvrir(page, sejour.url);
  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('redirection vers la connexion en ouvrant un séjour');
  }
  const liensDetail = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  const reservation = liensDetail.find((l) => LIEN_RESERVATION.test(String(l?.href ?? '')));
  if (!reservation) return null;

  await ouvrir(page, reservation.href);
  const liensRo = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  const recu = liensRo.find((l) => ROUTE_RECU.test(String(l?.href ?? '')));
  return recu ? recu.href : null;
}

/**
 * Le relevé complet : les séjours de `/trips`, et pour chacun son reçu quand
 * le site en propose encore un.
 *
 * @returns {Promise<{sejours: object[], documents: object[], sansRecu: number}>}
 */
async function relever(page, log = () => {}) {
  const sejours = await releverSejours(page);
  const documents = [];
  let sansRecu = 0;
  for (const sejour of sejours) {
    const lien = await lienDeRecu(page, sejour);
    if (!lien) {
      sansRecu += 1;
      continue;
    }
    documents.push({
      remoteId: `${ID}-${sejour.tripId}`,
      url: lien,
      issuedOn: sejour.issuedOn,
      amount: null,
      libelle: 'Voir le reçu',
    });
  }
  // Le compte se lit d'une phrase, sans enquête (lot 72) : combien de séjours
  // la page montre, combien ont un reçu, et pourquoi l'écart éventuel avec vos
  // réservations n'est pas une panne. Mesuré le 08/09/2026 sur le compte
  // réel : /trips n'a ni pagination, ni « Afficher plus », ni chargement au
  // défilement — ce que la page montre EST la liste entière.
  log(
    `${ID} : ${sejours.length} séjour(s) vus sur la page Voyages — ${documents.length} avec reçu, `
      + `${sansRecu} sans reçu proposé par Airbnb. Cette page est la liste entière (rien n'est `
      + 'caché derrière un bouton ou un défilement — mesuré le 08/09/2026) : si vous avez '
      + 'd\'autres réservations, c\'est Airbnb qui ne les affiche plus ici.'
  );
  return { sejours, documents, sansRecu };
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
  // Le contenu fait foi, pas l'en-tête. Mesuré au lot 71 : `receipt-on-demand`
  // rend bien le PDF directement — mais si Airbnb changeait pour une page à
  // imprimer, on le DIRAIT, on ne déposerait pas du HTML.
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le reçu ${pageDocs.idPourJournal(document.remoteId)} n'est pas arrivé sous forme de PDF `
        + `(${buffer.length} octets reçus). Le lien de reçu d'Airbnb rend peut-être désormais une `
        + 'page à imprimer plutôt qu\'un PDF direct : signalez-le, ce connecteur doit alors être adapté.'
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Le test s'arrête à la liste des séjours : traverser les quatre pages de
 * chaque séjour prendrait plusieurs minutes pour un simple contrôle de
 * connexion, et la liste suffit à prouver la session (lot 70 : `/trips`
 * renvoie les anonymes vers la connexion).
 */
async function test(config, ctx = {}) {
  return surLaSession(config, ctx, async (page) => {
    const sejours = await releverSejours(page);
    return {
      ok: true,
      invoiceCount: sejours.length,
      accountId: null,
      message: sejours.length
        ? `Connexion valide — ${sejours.length} séjour(s) sur votre page Voyages ${NOM}`
        : messageReleveVide(),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaSession(config, ctx, async (page, context) => {
    const { sejours, documents } = await relever(page, log);
    if (!sejours.length) {
      // Zéro séjour reconnu, aucun marqueur positif : conclure « aucune
      // nouvelle facture » serait le faux « OK » que le lot 31 interdit.
      throw new Error(messageReleveVide());
    }

    // Preuve d'accès (lot 31) : des séjours listés sur la page Voyages
    // n'existent que pour une session ouverte (lot 70 : les anonymes sont
    // renvoyés vers la connexion) — c'est le marqueur ET la liste. Déposée
    // avant le tri des déjà-connus, pour qu'un passage sans nouveauté reste un
    // succès honnête — y compris quand AUCUN séjour n'a plus de reçu : c'est
    // un fait du site, pas une panne.
    ctx.preuveDeListe?.({
      session: `${sejours.length} séjour(s) affiché(s) sur la page Voyages`,
      liste: URL_VOYAGES,
      elements: documents.length,
    });

    // Le reçu déposé sous l'ancien schéma (`airbnb-<user_id>`) : reconnu, pas
    // redéposé. C'est celui du séjour le plus récent avec reçu.
    const rangHerite = indexRecuHerite(documents, connus);
    if (rangHerite >= 0) {
      log(`${ID} : le reçu le plus récent est déjà déposé sous son ancien identifiant — reconnu`);
    }

    const invoices = [];
    for (const [rang, doc] of documents.entries()) {
      if (rang === rangHerite) continue;
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
    log(`${ID} : ${invoices.length} reçu(s) récupéré(s) sur ${documents.length} proposé(s)`);
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  relever,
  releverSejours,
  lienDeRecu,
  sejoursDepuisLiens,
  indexRecuHerite,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  LIEN_SEJOUR,
  LIEN_RESERVATION,
  ROUTE_RECU,
  URL_VOYAGES,
  MESSAGE_SESSION_EXPIREE,
};
