'use strict';

/**
 * Connecteur Proxmox — la boutique de licences, pas l'hyperviseur.
 *
 * ⚠ À ne pas confondre : ce connecteur ne parle PAS à un serveur Proxmox VE. Il
 * ouvre `shop.proxmox.com`, la boutique où l'on achète les abonnements de
 * support, et il y récupère les factures. Un hyperviseur n'émet aucune facture.
 *
 * ─── Ce que la reconnaissance a montré (13/08/2026) ──────────────────────────
 *
 * La boutique tourne sur WHMCS, et ce n'est pas une supposition tirée du chemin
 * `clientarea.php` : le serveur pose lui-même un cookie `WHMCSvVl9CFfEzwuY` dès
 * la première réponse. `Server: Apache`, aucun Cloudflare, aucun DataDome.
 *
 * Le formulaire de connexion, relevé dans un vrai Chromium :
 *
 *   POST /index.php?rp=/login
 *   token    (champ caché, jeton anti-rejeu régénéré à chaque affichage)
 *   username (type email)
 *   password
 *
 * AUCUN CAPTCHA MONTÉ. Le modèle WHMCS de la boutique déclare bien une clé
 * reCAPTCHA dans son JavaScript, mais en `render=explicit` : le widget n'est
 * instancié que si un conteneur le demande, et la page de connexion n'en pose
 * aucun (0 `.g-recaptcha`, 0 `[data-sitekey]`, 0 iframe reCAPTCHA). C'est la
 * différence entre « le site sait afficher un captcha » et « le site en affiche
 * un ici » — et elle décide de la méthode.
 *
 * D'où le choix d'une connexion par identifiants stockés plutôt que par session
 * capturée : rien à franchir à la main, et rien à renouveler tous les mois.
 *
 * ─── Le formulaire est REMPLI, pas fabriqué ──────────────────────────────────
 *
 * Le champ `token` est un jeton anti-rejeu que le serveur régénère à chaque
 * affichage de la page. Fabriquer la requête à la main obligerait à le relire
 * avant chaque envoi, et à recommencer ce travail à chaque mise à jour de
 * WHMCS. Le remplir dans le navigateur l'emporte tout seul. Même raison
 * qu'Invoice Ninja, même solution.
 *
 * ─── Les factures ────────────────────────────────────────────────────────────
 *
 * Elles vivent sur `clientarea.php?action=invoices`, et chaque ligne mène à
 * `viewinvoice.php?id=<n>`. Le PDF, lui, s'obtient par `dl.php?type=i&id=<n>`.
 *
 * ─── `type=i`, et la leçon du lot 22 ────────────────────────────────────────
 *
 * Le lot 21 écrivait `dl.php?type=invoice&id=<n>` et l'appelait « la route
 * standard de WHMCS ». Elle ne l'est pas, et le nom complet ne veut rien dire
 * pour ce site : mesuré derrière une vraie session le 13/08/2026, `type=invoice`
 * rend **200, `text/html`, 22 721 octets — la page d'accueil de l'espace
 * client**. Pas une erreur, pas une redirection visible : la page d'accueil,
 * avec un code de succès. Et pour TOUTES les factures, pas seulement pour
 * celle qui avait été signalée.
 *
 * La vraie route ne se devine pas non plus : elle se LIT sur la page de la
 * facture, où le bouton « Télécharger » pointe `dl.php?type=i&id=<n>`. Elle
 * rend `application/pdf`, un `content-disposition` en « Facture-<n>.pdf », et
 * quatre-vingt-dix kilo-octets qui commencent par `%PDF-`.
 *
 * Ce que ça coûtait : le lot 21 avait vu juste en refusant d'écrire que la
 * route servait un PDF (« CE QUI N'EST PAS VÉRIFIÉ, faute de compte »), et le
 * contrôle « est-ce bien un PDF ? » a fait exactement son travail — il a
 * empêché de déposer dix pages d'accueil sous des noms en « .pdf ». Le compte
 * rendu, lui, désignait une facture (« la facture 23366 ») là où c'était la
 * route qui était fausse : la 23366 n'avait rien de particulier, c'était
 * simplement la PREMIÈRE de la liste, et la boucle s'arrêtait sur elle.
 *
 * ─── Une facture illisible n'emporte plus les autres ────────────────────────
 *
 * Corollaire du même incident : une seule erreur de téléchargement faisait
 * échouer la récupération ENTIÈRE, et les neuf documents suivants n'étaient
 * même pas tentés. Ils le sont désormais, et ce qui n'a pas pu être récupéré
 * est dit, facture par facture. La récupération n'échoue que si rien n'a pu
 * l'être — auquel cas c'est bien le service qui a un problème, pas un document.
 *
 * ⚠ Ce que le compte réel mesuré porte, et qui se garde tel quel : une facture
 * ANNULÉE (« C-23365 »). Son PDF existe, la boutique le sert comme les autres,
 * et c'est une pièce comptable à part entière — rien à écarter.
 */

const identity = require('../../browser-identity');
const cookieBanner = require('../../obstructions');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'proxmox';
const NOM = 'Proxmox';

const BASE = 'https://shop.proxmox.com';
const URL_CONNEXION = `${BASE}/index.php?rp=/login`;
const URL_FACTURES = `${BASE}/clientarea.php?action=invoices`;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_CONNEXION_MS = 30_000;
const DELAI_TELECHARGEMENT_MS = 60_000;

const CHAMP_EMAIL = 'email';
const CHAMP_MOT_DE_PASSE = 'password';

/** Relevés sur la page réelle, nommément — jamais par position. */
const SELECTEUR_EMAIL = 'input[name="username"], input#inputEmail';
const SELECTEUR_MOT_DE_PASSE = 'input[name="password"], input#inputPassword';
const SELECTEUR_ENVOI = 'input#login[type="submit"], form.login-form [type="submit"], button[type="submit"]';

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

/**
 * L'adresse courante est-elle celle de la connexion ?
 *
 * WHMCS renvoie vers `index.php?rp=/login` dès que la session tombe — et c'est
 * une PARAMÈTRE, pas un chemin. C'est l'exception qui oblige à regarder la
 * requête ici, contrairement à la règle générale : `rp` (return path) porte
 * l'étape, `index.php` ne dit rien à lui seul.
 */
function estPageAuthentification(url) {
  try {
    const analysee = new URL(String(url));
    if (/\/(login|logout)\.php$/i.test(analysee.pathname)) return true;
    return /^\/?(login|register|password)/i.test(String(analysee.searchParams.get('rp') || ''));
  } catch {
    return false;
  }
}

/** Le message d'un refus d'identifiants, ou `null` — familles FR et EN. */
function messageDeRefus(texteDeLaPage) {
  const texte = String(texteDeLaPage || '').replace(/\s+/g, ' ');
  const motifs = [
    /(?:login|email|password) (?:details|address)? ?(?:you entered )?(?:is|are|was)? ?(?:incorrect|invalid)/i,
    /invalid (?:login|email|password|credentials)/i,
    /no account (?:was )?found/i,
    /identifiants? (?:invalides?|incorrects?)/i,
    /(?:mot de passe|adresse) (?:invalide|incorrect)/i,
  ];
  for (const motif of motifs) {
    const trouve = motif.exec(texte);
    if (trouve) return trouve[0];
  }
  return null;
}

/**
 * Le numéro d'une facture, d'après un lien du tableau.
 *
 * Les deux formes que WHMCS pose : `viewinvoice.php?id=42` (la facture à
 * l'écran) et `dl.php?type=i&id=42` (son PDF). Les deux portent le même numéro,
 * et c'est lui qui compte : il donne à la fois l'identifiant stable du document
 * et l'adresse de son PDF.
 *
 * ⚠ Le `type` compte autant que l'identifiant. `dl.php` sert aussi les devis
 * (`type=q`) et les fichiers joints (`type=f`) : prendre le numéro sans
 * regarder le type ferait passer un devis pour une facture. Et `type=invoice`
 * — écrit par le lot 21, jamais servi par la boutique — est toléré à la lecture
 * seulement : s'il ressort d'une page un jour, il désigne bien une facture.
 *
 * @returns {string|null}
 */
function numeroDeFacture(href) {
  const texte = String(href || '');
  if (!/(?:viewinvoice\.php|dl\.php)/i.test(texte)) return null;
  if (/dl\.php/i.test(texte) && !/[?&]type=i(?:nvoice)?(?:&|$)/i.test(texte)) return null;
  const trouve = /[?&]id=(\d{1,12})(?:&|$)/i.exec(texte);
  return trouve ? trouve[1] : null;
}

/**
 * L'adresse du PDF d'une facture.
 *
 * `type=i`, et pas `type=invoice` : c'est ce que porte le bouton
 * « Télécharger » de la boutique, relevé sur la page d'une vraie facture. Le
 * nom complet est accepté par le serveur — il rend 200 — mais il rend la page
 * d'accueil de l'espace client, pas le document. Voir l'en-tête du fichier.
 */
function urlPdf(numero) {
  return `${BASE}/dl.php?type=i&id=${encodeURIComponent(numero)}`;
}

/**
 * Les factures d'une page de tableau WHMCS.
 *
 * Dédoublonnées par numéro : une même facture apparaît souvent deux fois sur la
 * ligne, une fois pour la consulter et une fois pour la télécharger. La date et
 * le montant sont lus dans la LIGNE, pas dans le texte du lien — qui ne dit
 * généralement que « Télécharger ».
 *
 * @param {Array<{href: string, texte?: string, ligne?: string}>} liens
 */
function facturesDepuisLiens(liens) {
  const vues = new Set();
  const sortie = [];

  for (const lien of Array.isArray(liens) ? liens : []) {
    const numero = numeroDeFacture(lien?.href);
    if (!numero || vues.has(numero)) continue;
    vues.add(numero);

    const contexte = `${lien.ligne ?? ''} ${lien.texte ?? ''}`.trim();
    sortie.push({
      remoteId: `${ID}-facture-${numero}`,
      url: urlPdf(numero),
      issuedOn: pageDocs.dateDepuisTexte(contexte),
      amount: pageDocs.montantDepuisTexte(contexte),
      libelle: `Facture ${numero}`,
    });
  }

  return sortie;
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucune facture » de « aucune facture RECONNUE ». */
function messageReleveVide(pagesVisitees) {
  return (
    `Connexion à la boutique ${NOM} réussie, mais aucune facture n'a été reconnue sur `
    + `${pagesVisitees.join(', ')}. Ce service vient d'être ajouté à crabe et n'a encore été `
    + 'essayé sur aucun compte réel : si vous voyez bien des factures sur cette page, '
    + 'signalez-le, le connecteur doit être adapté à leur présentation.'
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function exigerIdentifiants(config) {
  const manquants = [CHAMP_EMAIL, CHAMP_MOT_DE_PASSE].filter((k) => !config?.[k]);
  if (manquants.length) {
    throw new Error(
      `Identifiants de la boutique ${NOM} manquants : ${manquants
        .map((k) => (k === CHAMP_EMAIL ? 'adresse électronique' : 'mot de passe'))
        .join(', ')}.`
    );
  }
}

/** Remplit le formulaire de la boutique et vérifie qu'on en est sorti. */
async function seConnecter(page, config, log = () => {}) {
  await page.goto(URL_CONNEXION, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await cookieBanner.fermer(page, { cible: SELECTEUR_ENVOI, log, prefixe: ID });

  const champEmail = page.locator(SELECTEUR_EMAIL).first();
  await champEmail.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS }).catch(() => {
    throw new Error(
      `La boutique ${NOM} n'a pas présenté de champ d'adresse électronique. `
        + 'Le site a peut-être changé : signalez-le, ce service doit être adapté.'
    );
  });
  await champEmail.fill(config[CHAMP_EMAIL]);
  await page.locator(SELECTEUR_MOT_DE_PASSE).first().fill(config[CHAMP_MOT_DE_PASSE]);

  try {
    await page.locator(SELECTEUR_ENVOI).first().click({ timeout: 10_000 });
  } catch (err) {
    if (cookieBanner.estClicIntercepte(err)) {
      throw new Error(
        `Une fenêtre de la boutique ${NOM} empêche la connexion. Signalez-le, ce service doit `
          + 'être adapté.'
      );
    }
    throw err;
  }

  const sortie = await page
    .waitForURL((url) => !estPageAuthentification(String(url)), { timeout: DELAI_CONNEXION_MS })
    .then(() => true)
    .catch(() => false);

  if (!sortie) {
    const texte = await texteDeLaPage(page);
    // La boutique n'affichait aucun captcha à la reconnaissance, mais WHMCS
    // sait en poser après plusieurs échecs. Le taire donnerait « identifiants
    // refusés » sur des identifiants parfaitement bons.
    if (/captcha|vérification de sécurité|security check/i.test(texte)) {
      throw new Error(
        `La boutique ${NOM} demande une vérification anti-robot que crabe ne peut pas franchir. `
          + 'Cela arrive après plusieurs tentatives ratées : connectez-vous une fois à la main '
          + 'sur shop.proxmox.com, puis réessayez. Si cela persiste, signalez-le.'
      );
    }
    if (/two[- ]factor|verification code|code de vérification|authenticator/i.test(texte)) {
      throw new Error(
        `La boutique ${NOM} demande un code de double authentification. crabe ne peut pas le `
          + 'recevoir à votre place : ce service devra être adapté pour fonctionner avec une '
          + 'connexion ouverte à la main. Signalez-le.'
      );
    }
    const refus = messageDeRefus(texte);
    throw new Error(
      `La boutique ${NOM} a refusé ces identifiants${refus ? ` (« ${refus} »)` : ''}. Ce sont `
        + 'ceux de shop.proxmox.com, la boutique de licences — pas ceux d\'un serveur Proxmox, '
        + 'ni ceux du forum.'
    );
  }
  log(`${ID} : session de la boutique ouverte`);
}

async function texteDeLaPage(page) {
  return page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '');
}

async function surLaBoutique(config, ctx, fn) {
  exigerIdentifiants(config);
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(
      identity.optionsContexte({ viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    await seConnecter(page, config, ctx?.log);
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  await page.goto(URL_FACTURES, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw new Error(
      `La boutique ${NOM} a renvoyé vers la page de connexion en ouvrant la liste des `
        + 'factures : la session n\'a pas tenu.'
    );
  }

  const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
  const documents = facturesDepuisLiens(liens);
  log(`${ID} : ${documents.length} facture(s) reconnue(s) sur la liste`);

  if (!documents.length) {
    // Repli : la présentation du tableau a peut-être changé. Le lecteur
    // générique ramasse tout lien de document plutôt que de rendre une liste
    // vide qui ressemblerait à « vous n'avez aucune facture ».
    const generiques = pageDocs.documentsDepuisLiens(liens, { prefixe: `${ID}-` });
    if (generiques.length) {
      log(
        `${ID} : aucun lien de facture WHMCS reconnu, mais ${generiques.length} document(s) `
          + 'trouvé(s) autrement — la présentation de la boutique a peut-être changé'
      );
      return { documents: generiques, pagesVisitees: [URL_FACTURES] };
    }
  }

  return { documents, pagesVisitees: [URL_FACTURES] };
}

async function telecharger(context, document) {
  const reponse = await context.request.get(document.url, { timeout: DELAI_TELECHARGEMENT_MS });
  if (!reponse.ok()) {
    // Identifiant TRONQUÉ (règle du projet, lot 31) : jamais entier au journal.
    throw new Error(
      `Téléchargement de la facture ${pageDocs.idPourJournal(document.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  if (!identity.estPdf(buffer)) {
    // WHMCS répond 200 avec une PAGE quand la session est tombée, quand la
    // facture n'appartient pas au compte — ou quand la route est mal formée,
    // ce qui a coûté tout le lot 21 ici. Déposer ça sous un nom en « .pdf »
    // donnerait un fichier illisible, des mois durant, sans que rien ne l'ait
    // signalé. On dit donc CE QUI est arrivé à la place, pas seulement que ce
    // n'était pas un PDF.
    const page = /^\s*<(?:!doctype|html)/i.test(buffer.toString('latin1', 0, 64));
    throw new Error(
      `la boutique n'a pas rendu de PDF pour cette facture — ${buffer.length} octets `
        + `de ${page ? 'page web' : 'contenu inattendu'} reçus à la place`
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaBoutique(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion réussie — ${documents.length} facture(s) trouvée(s) dans votre espace client`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaBoutique(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro document reconnu, aucun marqueur positif de session : conclure
      // « aucune nouvelle facture » serait le faux « OK » que le lot 31
      // interdit. Le message dit déjà les deux explications et quoi faire.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des factures reconnues dans l'espace client
    // n'existent que pour une session ouverte — c'est le marqueur ET la
    // liste. Déposée avant le tri des déjà-connus.
    ctx.preuveDeListe?.({
      session: `${documents.length} facture(s) affichée(s) dans l'espace client`,
      liste: pagesVisitees.join(', '),
      elements: documents.length,
    });

    const invoices = [];
    const ecartees = [];
    let candidates = 0;

    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) continue;
      candidates += 1;

      // ⚠ Un document par un document. Jusqu'au lot 22, la première erreur de
      // téléchargement faisait échouer la récupération entière : dix factures
      // listées, la première illisible, et les neuf autres jamais tentées — le
      // compte rendu accusait alors UNE facture d'une panne qui les concernait
      // toutes. On continue, et on dit ce qui n'est pas passé.
      let buffer;
      try {
        buffer = await telecharger(context, doc);
      } catch (err) {
        ecartees.push(`${doc.libelle} : ${err.message}`);
        log(`${ID} : ${pageDocs.idPourJournal(doc.remoteId)} écartée — ${err.message}`);
        continue;
      }

      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier(doc),
        issuedOn: doc.issuedOn,
        amount: doc.amount,
        buffer,
      });
    }

    // Rien n'est passé alors qu'il y avait à prendre : ce n'est plus un
    // document en défaut, c'est le service. Une récupération « réussie » à zéro
    // document serait le pire compte rendu possible — elle laisserait croire
    // qu'il n'y avait rien à récupérer.
    if (candidates && !invoices.length) {
      throw new Error(
        `Aucune des ${candidates} facture(s) de la boutique ${NOM} n'a pu être récupérée. `
          + `Première raison : ${ecartees[0]}. Signalez-le : ce service doit être adapté.`
      );
    }

    if (ecartees.length) {
      log(
        `${ID} : ${ecartees.length} facture(s) non récupérée(s) — ${ecartees.join(' ; ')}. `
          + 'Les autres ont bien été déposées.'
      );
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${documents.length} listée(s)`);
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  messageDeRefus,
  messageReleveVide,
  numeroDeFacture,
  facturesDepuisLiens,
  urlPdf,
  nomFichier,
  BASE,
  URL_CONNEXION,
  URL_FACTURES,
  SELECTEUR_EMAIL,
  SELECTEUR_MOT_DE_PASSE,
  SELECTEUR_ENVOI,
};
