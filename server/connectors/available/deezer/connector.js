'use strict';

/**
 * Connecteur Deezer — session capturée, rejouée headless, historique des
 * paiements.
 *
 * ─── Ce que la MESURE du 18/08/2026 a établi (session réelle, en production) ────────
 *
 * Le lot 36 partait de `/fr/account` et cherchait un LIEN « Historique des
 * paiements » : il n'existe pas. Le chemin réel, mesuré clic par clic :
 *
 *   1. `www.deezer.com/fr/account` — la page du compte. Une fenêtre
 *      d'incitation « Deezer Premium » (chakra-portal) peut recouvrir la page
 *      et intercepter tous les clics : on la ferme par sa croix d'abord.
 *   2. Le BOUTON « Gérer mon abonnement » (pas un lien) ouvre un NOUVEL
 *      ONGLET vers `payment.deezer.com/?…` avec un jeton de passage — l'accès
 *      direct à `payment.deezer.com/` sans jeton renvoie à l'accueil par
 *      `payment/back.php` (mesuré), il ne sert donc à rien de coder cette
 *      adresse en dur.
 *   3. La page atteinte porte `#page_subscription` et `#subscription_invoices`
 *      (« Payment history ») : **21 lignes** `div[data-payment-history-
 *      listitem]` mesurées sur un compte réel (de 2013 à 2026), dont **18 en
 *      `aria-hidden="true"`** — le repli « voir plus » n'en montre que 3.
 *      TOUTES les lignes du DOM sont prises, masquées comprises : un relevé
 *      du rendu visible verrait 3 paiements sur 21.
 *
 * La page est servie EN ANGLAIS malgré la locale française : aucun sélecteur
 * ne dépend du texte quand un attribut existe — prix par
 * `span[data-testid="payment_history_price"]`, lien par
 * `a[data-testid="link-to-invoice"]`, date par sa forme JJ/MM/AAAA.
 *
 * ─── Le reçu : une page HTML, pas un PDF — et crabe l'IMPRIME (lot 41) ───────
 *
 * `a[data-testid="link-to-invoice"]` mène à `payment.deezer.com/?cip=<jeton>`.
 * Réponse mesurée : **Content-Type text/html**, un reçu OFFICIEL complet à
 * l'écran — logo, e-mail, « Numéro de reçu » `GGL_I_…`, date, abonnement,
 * Total HT / TVA / Total TTC, Deezer S.A., RCS Paris, n° de TVA
 * FR41898969852, et un bouton « Imprimer ». AUCUN lien PDF dedans : le site
 * n'en sert pas. Depuis le lot 41, crabe fait ce que le bouton « Imprimer »
 * ferait : il rend la page en PDF (`page.pdf()`, A4, fonds compris) — aucun
 * contenu n'est fabriqué, c'est le reçu du site tel qu'il se peint.
 *
 * ⚠ La page arrive souvent en ANGLAIS (mesuré le 19/08/2026). Le français
 * s'obtient par le `<select id="footer-lang-select">` du pied de page : chaque
 * option porte une adresse `cip=` différente, l'option française se reconnaît
 * à son texte « Français ». C'est la version FRANÇAISE qu'on archive — et la
 * preuve d'impression exige que la SOURCE ait porté le numéro de reçu et le
 * mot « Total TTC » avant le rendu (un PDF de Chromium encode le texte en
 * glyphes : il ne se relit pas, voir connectors/releve-reconstitue.js).
 *
 * Le type est re-mesuré à chaque exécution sur un reçu : si Deezer fournit un
 * jour du PDF direct, le journal le dira au lieu de le rater. Le `cip=` est
 * un JETON : jamais dans un nom de fichier, un journal ou un message.
 *
 * ─── Le piège de l'alerte bancaire ───────────────────────────────────────────
 *
 * La page contient en permanence `div[role="alert"]#payment-alert` (« An error
 * occurred with your bank details… ») — MASQUÉ, avec un parent
 * `data-has-error="false"` (mesuré sur une page saine). La présence du texte
 * ne vaut rien : seul `data-has-error="true"` signale un incident réel.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'deezer';
const NOM = 'Deezer';

/** Le point de départ mesuré : la page du compte, seule adresse stable. */
const URL_COMPTE = 'https://www.deezer.com/fr/account';

/** Le bouton mesuré le 18/08/2026 (page servie en français sur /fr/account). */
const SELECTEUR_BOUTON_ABONNEMENT =
  'button:has-text("Gérer mon abonnement"), button:has-text("Manage my subscription")';

/** La croix de la fenêtre d'incitation « Deezer Premium » (chakra-portal). */
const SELECTEUR_CROIX_INCITATION =
  '.chakra-modal__close-btn, button[aria-label*="lose" i], button[aria-label*="ermer" i]';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_NOUVEL_ONGLET_MS = 15_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

/** L'application se peint après coup : lire trop tôt = « 0 paiement » à tort. */
const DELAI_RENDU_MS = 6_000;

/** La page de reçu est plus simple que l'application : elle se peint plus vite. */
const DELAI_RENDU_RECU_MS = 3_000;

/**
 * En dessous de ce poids, le rendu est tenu pour BLANC et c'est un échec :
 * une page A4 vide sort de Chromium autour de 3-4 Ko, un reçu réel — logo,
 * polices incorporées, tableau de TVA — pèse largement plus. Le contenu du
 * PDF ne se relit pas (glyphes) : le poids et la lecture de la SOURCE avant
 * rendu sont les deux preuves qui restent.
 */
const SEUIL_PDF_OCTETS = 10_000;

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
  'Votre connexion à Deezer a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Deezer » — connectez-vous avec votre adresse e-mail et votre mot de '
  + 'passe Deezer.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte. Deezer loge sa connexion sous `/login/` et renvoie
 * aussi l'anonyme vers `/signup/` (mesuré sur payment.deezer.com) : les deux
 * sont des pages d'authentification.
 */
function estPageAuthentification(url) {
  try {
    return /\/(login|signup|signin|sign-in|authenticate|verify)(\/|$)/i
      .test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

/** Une adresse montrable : jamais la requête, qui peut porter un jeton. */
function adresseSansJeton(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || '');
  }
}

/** « 20/02/2026 » → « 2026-02-20 ». Une date illisible rend null, sans lever. */
function dateSlashEnIso(texte) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(texte || ''));
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucun paiement » de « aucun paiement RECONNU ». */
function messageReleveVide(pagesVisitees) {
  return (
    'Connexion à Deezer valide, mais aucun paiement n\'a été reconnu sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre compte n\'a aucun paiement fait directement à Deezer, soit crabe ne '
    + 'reconnaît plus la présentation de la page. Si vous voyez bien un historique de '
    + 'paiements dans « Gérer mon abonnement », signalez-le — le connecteur doit être adapté.'
  );
}

/** Le bouton d'entrée n'a pas été reconnu : dire où on était, sans jargon. */
function messageBoutonIntrouvable() {
  return (
    'crabe a bien ouvert votre compte Deezer, mais le bouton « Gérer mon abonnement » '
    + 'n\'a pas été reconnu sur la page. La présentation du site a peut-être changé : '
    + 'signalez-le, le connecteur doit être adapté.'
  );
}

/** La page atteinte après le bouton n'est pas l'historique attendu. */
function messagePageInattendue(url) {
  return (
    'crabe a bien cliqué « Gérer mon abonnement », mais la page servie n\'est pas '
    + `l'historique des paiements (l'adresse servie est ${adresseSansJeton(url)}). `
    + 'La présentation du site a peut-être changé : signalez-le, le connecteur doit '
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
 * `optionsLancement()` porte le drapeau anti-automatisation (lot 35) : Deezer
 * ne montre aucune garde, mais une session rejouée doit présenter la même
 * identité que celle de sa capture.
 */
async function surLeCompte(config, ctx, fn) {
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
 * Exécutée DANS la page de paiement : TOUTES les lignes de l'historique,
 * masquées comprises — le repli « voir plus » cache 18 lignes sur 21 avec
 * `aria-hidden="true"`, et un relevé du rendu visible en verrait 3.
 * Les données brutes remontent telles quelles ; le tri se fait côté
 * connecteur, où c'est testable.
 */
function EXTRAIRE_LIGNES() {
  return [...document.querySelectorAll('div[data-payment-history-listitem]')].map((l) => {
    const prix = l.querySelector('span[data-testid="payment_history_price"]');
    const lien = l.querySelector('a[data-testid="link-to-invoice"]');
    return {
      ariaHidden: l.getAttribute('aria-hidden'),
      texte: (l.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      prix: prix ? (prix.innerText || '').trim() : '',
      lienRecu: lien ? lien.href : null,
      // Le REPLI du lot 41 : si l'icône du reçu cesse d'être un <a href>, sa
      // présence se note quand même — elle se cliquera, et l'adresse d'arrivée
      // fera le lien.
      boutonRecu: !!l.querySelector('[data-testid="link-to-invoice"]'),
    };
  });
}

/**
 * Exécutée DANS la page de REÇU : ce qu'il faut pour prouver et nommer, rien
 * d'autre. Le numéro suit son étiquette (« Numéro de reçu » / « Receipt
 * number ») ; la langue se juge sur « Total TTC », le libellé français mesuré
 * le 19/08/2026 ; l'option « Français » du sélecteur de pied de page porte
 * l'adresse de la version française (résolue en absolu ici, où `location`
 * existe).
 */
function LIRE_RECU() {
  const texte = (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ');
  const numero =
    (/(?:Num[ée]ro de re[çc]u|Receipt number)\s*:?\s*([A-Za-z0-9_.-]+)/i.exec(texte) || [])[1]
    || null;
  const optionFrancais = [...document.querySelectorAll('#footer-lang-select option')]
    .find((o) => /fran[çc]ais/i.test(o.textContent || ''));
  let urlFrancais = null;
  if (optionFrancais && optionFrancais.value) {
    try { urlFrancais = new URL(optionFrancais.value, location.href).href; } catch { /* adresse illisible */ }
  }
  return {
    numero,
    aTotalTTC: /Total TTC/i.test(texte),
    urlFrancais,
  };
}

/**
 * Exécutée DANS la page : l'état réel de l'alerte bancaire. La page porte ce
 * bloc EN PERMANENCE, masqué, avec un parent `data-has-error="false"` — la
 * présence du texte ne signale rien.
 */
function LIRE_ALERTE() {
  const alerte = document.querySelector('#payment-alert');
  if (!alerte) return null;
  const parent = alerte.closest('[data-has-error]');
  return {
    texte: (alerte.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
    dataHasError: parent ? parent.getAttribute('data-has-error') : null,
  };
}

/**
 * Un incident bancaire RÉEL, ou rien. Seul `data-has-error="true"` tranche :
 * conclure sur le texte signalerait un incident inexistant sur chaque page
 * saine (piège mesuré le 18/08/2026).
 *
 * @param {object|null} alerte résultat de LIRE_ALERTE
 * @returns {string|null}
 */
function incidentBancaire(alerte) {
  if (!alerte || alerte.dataHasError !== 'true') return null;
  return (
    'Deezer signale un problème avec votre moyen de paiement. Vérifiez vos '
    + 'coordonnées bancaires sur deezer.com — crabe ne peut pas le faire pour vous.'
  );
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
 * Rejoint l'historique des paiements par le chemin MESURÉ : page du compte →
 * fermer l'incitation qui intercepte les clics → bouton « Gérer mon
 * abonnement » → nouvel onglet payment.deezer.com (jeton de passage dans
 * l'adresse, posé par Deezer lui-même).
 *
 * @returns {Promise<{cible: object, pagesVisitees: string[]}>} la page de
 *   paiement (l'onglet ouvert, ou la page d'origine si le site a navigué sur
 *   place) et les adresses visitées, sans jetons.
 */
async function ouvrirHistoriqueDesPaiements(page, context, log = () => {}) {
  await page.goto(URL_COMPTE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${URL_COMPTE}`);
  }

  // La fenêtre d'incitation recouvre la page et intercepte les clics.
  const croix = page.locator(SELECTEUR_CROIX_INCITATION).first();
  if (await croix.count().catch(() => 0)) {
    await croix.click().catch(() => {});
    await page.waitForTimeout(1_000).catch(() => {});
    log(`${ID} : fenêtre d'incitation à l'abonnement fermée`);
  }

  const bouton = page.locator(SELECTEUR_BOUTON_ABONNEMENT).first();
  if (!(await bouton.count().catch(() => 0))) {
    await journaliserPage(page, log, 'bouton « Gérer mon abonnement » introuvable');
    throw new Error(messageBoutonIntrouvable());
  }

  // Le bouton ouvre un nouvel onglet ; on l'attend, sans exiger qu'il vienne —
  // si Deezer navigue un jour sur place, la page d'origine fera l'affaire.
  const attenteOnglet = context.waitForEvent
    ? context.waitForEvent('page', { timeout: DELAI_NOUVEL_ONGLET_MS }).catch(() => null)
    : Promise.resolve(null);
  await bouton.click();
  const onglet = await attenteOnglet;
  const cible = onglet || page;
  await cible.waitForLoadState('domcontentloaded').catch(() => {});
  await cible.waitForLoadState('networkidle').catch(() => {});
  await cible.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(cible.url())) {
    throw erreurSessionExpiree('renvoi vers la connexion en ouvrant l\'historique des paiements');
  }

  const surPaiements = await cible
    .evaluate(() => Boolean(document.querySelector('#subscription_invoices')))
    .catch(() => false);
  if (!surPaiements) {
    await journaliserPage(cible, log, 'la page atteinte ne porte pas l\'historique des paiements');
    throw new Error(messagePageInattendue(cible.url()));
  }

  return { cible, pagesVisitees: [URL_COMPTE, adresseSansJeton(cible.url())] };
}

/**
 * Lit l'historique des paiements — TOUTES les lignes, masquées comprises —
 * et dit ligne par ligne qu'aucune facture PDF n'existe (mesuré : le reçu est
 * une page HTML « Your receipt », sans PDF ni téléchargement).
 *
 * @returns {Promise<{lignes: object[], paiements: object[],
 *                    incident: string|null, pagesVisitees: string[]}>}
 */
async function relever(page, context, log = () => {}) {
  const { cible, pagesVisitees } = await ouvrirHistoriqueDesPaiements(page, context, log);

  const brut = await cible.evaluate(EXTRAIRE_LIGNES).catch(() => []);
  const lignes = Array.isArray(brut) ? brut : [];
  const masquees = lignes.filter((l) => l.ariaHidden === 'true').length;

  const paiements = lignes.map((ligne, index) => ({
    index,
    date: dateSlashEnIso(ligne.texte),
    dateBrute: (/\d{2}\/\d{2}\/\d{4}/.exec(ligne.texte) || [''])[0],
    prix: ligne.prix,
    // Le prix peut apparaître DEUX fois dans le texte de la ligne (cellule
    // visible + reprise du repli) : toutes les occurrences sortent du libellé.
    libelle: (ligne.prix
      ? ligne.texte.replace(/\d{2}\/\d{2}\/\d{4}/g, '').split(ligne.prix).join('')
      : ligne.texte.replace(/\d{2}\/\d{2}\/\d{4}/g, ''))
      .replace(/\s+/g, ' ').trim() || 'paiement Deezer',
    lienRecu: ligne.lienRecu,
    boutonRecu: ligne.boutonRecu === true,
  }));

  const alerte = await cible.evaluate(LIRE_ALERTE).catch(() => null);
  const incident = incidentBancaire(alerte);
  if (incident) log(`${ID} : ${incident}`);

  if (!lignes.length) {
    await journaliserPage(cible, log, 'aucune ligne de paiement reconnue sur l\'historique');
  }
  log(`${ID} : ${lignes.length} paiement(s) vu(s) (dont ${masquees} replié(s) sous « voir plus ») `
    + '— aucun PDF direct chez Deezer : chaque reçu s\'imprime depuis sa page officielle');
  return { lignes, paiements, incident, pagesVisitees, cible };
}

/**
 * REPLI mesurable (lot 41) : l'icône du reçu n'est plus un lien — on la
 * clique et on lit l'adresse d'arrivée, puis on revient sur l'historique.
 * Rend l'adresse atteinte, ou null si rien n'a navigué.
 */
async function lienParClic(cible, index) {
  const avant = cible.url();
  await cible
    .locator('div[data-payment-history-listitem]')
    .nth(index)
    .locator('[data-testid="link-to-invoice"]')
    .first()
    .click()
    .catch(() => {});
  await cible.waitForLoadState('domcontentloaded').catch(() => {});
  await cible.waitForTimeout(1_500).catch(() => {});
  const apres = cible.url();
  if (apres === avant) return null;
  await cible.goBack().catch(() => {});
  await cible.waitForLoadState('networkidle').catch(() => {});
  await cible.waitForTimeout(1_500).catch(() => {});
  return apres;
}

/**
 * Ouvre la page du reçu, s'assure d'être sur la version FRANÇAISE, et
 * l'imprime en PDF — exactement ce que ferait le bouton « Imprimer » du site,
 * aucun contenu fabriqué.
 *
 * Les preuves, dans l'ordre où elles tombent :
 *   1. la SOURCE porte le numéro de reçu et « Total TTC » (donc le français)
 *      AVANT le rendu — le PDF, en glyphes, ne se relira pas ;
 *   2. les octets rendus commencent par `%PDF-` ;
 *   3. le poids dépasse `SEUIL_PDF_OCTETS` — un rendu blanc est un ÉCHEC.
 *
 * @returns {Promise<{ok: true, numero: string, buffer: Buffer}
 *                   |{ok: false, raison: string}>}
 */
async function imprimerRecu(context, lien, log = () => {}) {
  const pageRecu = await context.newPage();
  try {
    await pageRecu.goto(lien, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await pageRecu.waitForLoadState('networkidle').catch(() => {});
    await pageRecu.waitForTimeout(DELAI_RENDU_RECU_MS).catch(() => {});

    if (estPageAuthentification(pageRecu.url())) {
      throw erreurSessionExpiree('renvoi vers la connexion en ouvrant un reçu');
    }

    let recu = await pageRecu.evaluate(LIRE_RECU).catch(() => null);

    // La page arrive souvent en anglais : l'option « Français » du pied de
    // page porte l'adresse de la version française (un autre `cip=`).
    if (recu && !recu.aTotalTTC && recu.urlFrancais) {
      log(`${ID} : reçu servi dans une autre langue — bascule vers la version française`);
      await pageRecu.goto(recu.urlFrancais, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await pageRecu.waitForLoadState('networkidle').catch(() => {});
      await pageRecu.waitForTimeout(DELAI_RENDU_RECU_MS).catch(() => {});
      recu = await pageRecu.evaluate(LIRE_RECU).catch(() => null);
    }

    if (!recu?.numero) {
      return {
        ok: false,
        raison: 'la page du reçu ne porte pas de « Numéro de reçu » lisible — '
          + 'rien n\'est déposé à sa place ; la présentation du site a peut-être changé, signalez-le',
      };
    }
    if (!recu.aTotalTTC) {
      return {
        ok: false,
        raison: `le reçu ${recu.numero} n'a pas pu être obtenu en français `
          + '(pas de « Total TTC », et le sélecteur de langue n\'a pas offert « Français ») — '
          + 'c\'est la version française qu\'on archive, rien n\'est déposé à sa place',
      };
    }

    const buffer = Buffer.from(await pageRecu.pdf({ format: 'A4', printBackground: true }));
    if (!identity.estPdf(buffer) || buffer.length < SEUIL_PDF_OCTETS) {
      // Un rendu blanc ou tronqué est un ÉCHEC dit à voix haute : déposer un
      // PDF vide serait pire que ne rien déposer.
      throw new Error(
        `L'impression du reçu ${recu.numero} n'a pas produit un PDF exploitable `
          + `(${buffer.length} octets rendus) : rien n'a été déposé. Relancez la récupération ; `
          + 'si le message revient, signalez-le.'
      );
    }
    return { ok: true, numero: recu.numero, buffer };
  } finally {
    await pageRecu.close().catch(() => {});
  }
}

/**
 * Imprime, ligne par ligne, les reçus d'un relevé — le cœur du lot 41, sorti
 * de `fetchInvoices` pour être testable sans navigateur.
 *
 * Ligne par ligne, le journal DIT ce qui s'est passé : imprimé, déjà connu,
 * sans reçu à imprimer, ou la raison du refus. Le tri des déjà-connus se fait
 * APRÈS lecture de la page : le numéro de reçu n'est lisible nulle part
 * ailleurs.
 *
 * @returns {Promise<{invoices: object[], sansLien: number}>}
 */
async function imprimerLesRecus(releve, context, { connus = new Set(), plan = null, log = () => {} } = {}) {
  const invoices = [];
  let sansLien = 0;
  for (const p of releve.paiements) {
    if (!scraping.dansLaFenetre(p.date, plan)) continue;

    // Le lien mesuré d'abord ; le REPLI (icône devenue bouton) ensuite.
    let lien = p.lienRecu;
    if (!lien && p.boutonRecu) {
      lien = await lienParClic(releve.cible, p.index);
      if (lien) log(`${ID} : le reçu du ${p.dateBrute || '(date illisible)'} a été atteint `
        + 'par le clic de son icône (le lien direct a disparu)');
    }
    if (!lien) {
      sansLien++;
      log(`${ID} : le paiement du ${p.dateBrute || '(date illisible)'} `
        + `(${p.libelle}${p.prix ? `, ${p.prix}` : ''}) n'offre aucun reçu à imprimer — `
        + 'rien n\'est déposé à sa place');
      continue;
    }

    const resultat = await imprimerRecu(context, lien, log);
    if (!resultat.ok) {
      log(`${ID} : paiement du ${p.dateBrute || '(date illisible)'} — ${resultat.raison}`);
      continue;
    }
    if (connus.has(resultat.numero)) {
      log(`${ID} : reçu ${resultat.numero} déjà récupéré — rien à refaire`);
      continue;
    }
    invoices.push({
      remoteId: resultat.numero,
      filename: nomFichier({ issuedOn: p.date, remoteId: resultat.numero }),
      issuedOn: p.date,
      amount: p.prix || null,
      buffer: resultat.buffer,
    });
    log(`${ID} : reçu ${resultat.numero} (paiement du ${p.dateBrute || '?'}) imprimé en PDF, `
      + `version française (${resultat.buffer.length} octets)`);
  }
  return { invoices, sansLien };
}

/**
 * Re-mesure à chaque exécution le type RÉEL d'un reçu : si Deezer se met un
 * jour à servir du PDF, le journal le dira au lieu de le rater. Ne dépose
 * rien : c'est une mesure, pas une récupération.
 */
async function mesurerTypeDeRecu(context, lienRecu, log = () => {}) {
  if (!lienRecu) return null;
  try {
    const reponse = await context.request.get(lienRecu, { timeout: DELAI_TELECHARGEMENT_MS });
    const corps = Buffer.from(await reponse.body());
    const type = String(reponse.headers()['content-type'] || '');
    const estPdf = identity.estPdf(corps);
    if (estPdf) {
      log(`${ID} : un reçu vient de descendre en vrai PDF — Deezer a changé ! `
        + 'Signalez-le : le connecteur doit être adapté pour récupérer les factures.');
    }
    return { contentType: type, estPdf, taille: corps.length };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLeCompte(config, ctx, async (page, context) => {
    const releve = await relever(page, context, ctx.log || (() => {}));
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
      invoiceCount: 0,
      accountId: null,
      message:
        `Connexion valide — ${releve.lignes.length} paiement(s) dans votre historique ${NOM}. `
        + 'Deezer ne fournit pas ces reçus en fichier PDF : crabe imprime donc le reçu '
        + 'officiel de chaque paiement (sa page, en français) en PDF, comme le ferait le '
        + 'bouton « Imprimer » du site.',
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLeCompte(config, ctx, async (page, context) => {
    const releve = await relever(page, context, log);
    if (!releve.lignes.length) {
      // Zéro ligne sans marqueur positif : le faux « OK » du lot 31.
      throw new Error(messageReleveVide(releve.pagesVisitees));
    }

    // Preuve d'accès (lot 31). L'attestation compte les LIGNES VUES : chaque
    // reçu déposé est une IMPRESSION de sa page officielle, pas un PDF du site.
    ctx.preuveDeListe?.({
      session: `${releve.lignes.length} paiement(s) affiché(s) sur l'historique — `
        + 'chaque reçu s\'imprime depuis sa page officielle, Deezer ne sert pas de PDF',
      liste: releve.pagesVisitees.join(', '),
      elements: releve.lignes.length,
    });

    // La limite est re-mesurée, pas gravée : un reçu sondé par exécution. Si
    // Deezer sert un jour du PDF direct, le journal le dit — l'impression
    // n'aurait alors plus de raison d'être.
    const premierLien = releve.paiements.find((p) => p.lienRecu)?.lienRecu || null;
    const type = await mesurerTypeDeRecu(context, premierLien, log);
    if (type && !type.estPdf) {
      log(`${ID} : type du reçu re-mesuré — ${type.contentType || 'inconnu'} `
        + `(${type.taille} octets), toujours pas un PDF : impression de la page officielle`);
    }

    const { invoices, sansLien } = await imprimerLesRecus(releve, context, { connus, plan, log });

    log(`${ID} : ${releve.lignes.length} paiement(s) vu(s), ${invoices.length} reçu(s) imprimé(s)`);

    // Aucune ligne n'offre de reçu : le message d'exécution doit le dire en
    // clair (lot 41) — « Aucune nouvelle facture » ferait croire à une panne.
    if (!invoices.length && sansLien === releve.paiements.length) {
      return {
        invoices,
        aucunDocument:
          `Deezer a listé ${releve.paiements.length} paiement(s) mais n'a proposé aucun reçu `
          + 'à imprimer — aucun document téléchargeable sur ce compte.',
      };
    }
    return { invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  relever,
  imprimerRecu,
  imprimerLesRecus,
  lienParClic,
  LIRE_RECU,
  SEUIL_PDF_OCTETS,
  ouvrirHistoriqueDesPaiements,
  estPageAuthentification,
  adresseSansJeton,
  dateSlashEnIso,
  erreurSessionExpiree,
  messageReleveVide,
  messageBoutonIntrouvable,
  messagePageInattendue,
  nomFichier,
  lireSession,
  incidentBancaire,
  mesurerTypeDeRecu,
  EXTRAIRE_LIGNES,
  LIRE_ALERTE,
  SELECTEUR_BOUTON_ABONNEMENT,
  SELECTEUR_CROIX_INCITATION,
  URL_COMPTE,
  MESSAGE_SESSION_EXPIREE,
};
