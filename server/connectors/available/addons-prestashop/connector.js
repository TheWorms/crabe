'use strict';

/**
 * Connecteur PrestaShop Addons — factures d'achats de modules et thèmes.
 *
 * ─── Pourquoi un PROFIL PERSISTANT et un navigateur VISIBLE ─────────────────
 *
 * La marketplace est protégée par Cloudflare à deux niveaux : challenge pleine
 * page à l'entrée, Turnstile dans le formulaire (authv2.prestashop.com). Les
 * deux jugent le NAVIGATEUR, pas les cookies. Vérifié le 11-12/08/2026 :
 *
 *   - storageState rejoué dans un contexte neuf → « Performing security
 *     verification », en boucle ;
 *   - profil persistant + headless:true          → bloqué aussi ;
 *   - profil persistant + headless:false (Xvfb)  → passe.
 *
 * Le connecteur lance donc SON PROPRE Xvfb, sur une plage d'affichages
 * distincte de celle du navigateur distant (:109-:118 contre :99-:108 —
 * jamais de collision possible), et rouvre le profil que l'utilisateur a
 * rempli par « Se connecter » (remoteLogin.persistent, voir le manifeste et
 * connectors/profil-persistant.js). Le champ `session` de la configuration
 * n'est PAS rejoué : il n'est que l'attestation « connecté » de l'interface.
 *
 * ─── Langue ─────────────────────────────────────────────────────────────────
 *
 * La langue du PDF suit la langue de la SESSION SERVEUR, pas l'URL visitée.
 * Toutes les navigations restent en /fr/ : un seul passage par /en/ rebascule
 * la session en anglais, et les factures avec.
 *
 * ─── La page d'historique ───────────────────────────────────────────────────
 *
 * /fr/historique-des-commandes — application Vue.js, tableau <tr>, 25 lignes
 * par page. Chaque ligne porte `.order-action-invoice[orderid]`. Le clic
 * déclenche un TÉLÉCHARGEMENT depuis une URL S3 signée temporaire dont
 * l'identifiant n'a AUCUN rapport avec orderid — pas de raccourci par
 * construction d'URL, chaque facture exige un clic. Un onglet about:blank
 * s'ouvre en parallèle (porteur du téléchargement) : même schéma que le
 * connecteur impots, même écoute download + page, le premier arrivé gagne.
 *
 * Pagination puik sans changement d'URL : boutons `aria-label="Go to page N"`,
 * relevés dynamiquement — rien n'est codé à deux pages.
 *
 * L'API interne (/request3/clientaccount/orders/) rend 401 hors de l'app Vue :
 * abandonnée, on passe par le DOM.
 *
 * ─── Déduplication et nommage ───────────────────────────────────────────────
 *
 * remoteId = orderid, stable et porté par le DOM. Le nom S3
 * (prestashop-billing_invoice_<opaque>.pdf) ne vaut rien : le fichier est
 * nommé <année>_commande_<orderid>.pdf, l'année venant de la date lue dans la
 * ligne du tableau.
 */

const fs = require('fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const identity = require('../../browser-identity');
const profilPersistant = require('../../profil-persistant');

const ID = 'addons-prestashop';
const URL_HISTORIQUE = 'https://addons.prestashop.com/fr/historique-des-commandes';
const PREFIXE_FR = 'https://addons.prestashop.com/fr/';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attente du téléchargement déclenché par le clic. */
const DELAI_TELECHARGEMENT_MS = 20_000;
/** Pause entre deux factures : la marketplace est un service public, on ne le bouscule pas. */
const PAUSE_FACTURE_MS = 700;
/** Attente du repeuplement du tableau après un changement de page. */
const DELAI_PAGINATION_MS = 8_000;

/** Affichages X du connecteur — DISJOINTS de ceux du navigateur distant (99-108). */
const DISPLAY_MIN = 109;
const DISPLAY_MAX = 118;
const XVFB_READY_TIMEOUT_MS = 15_000;
const SCREEN = '1600x900x24';

const COMPTE_PAR_DEFAUT = 'compte';

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur PrestaShop Addons ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à PrestaShop Addons a expiré. Rouvrez-la depuis la fiche du service, '
  + 'bouton « Se connecter à PrestaShop Addons » — le site protégé par Cloudflare peut '
  + 'demander de cocher une case de vérification.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 * Marqueurs observés : /login, /connexion, et le domaine authv2.prestashop.com.
 */
function estPageAuthentification(url) {
  const texte = String(url || '');
  if (/authv2\.prestashop\.com/i.test(texte)) return true;
  try {
    const analysee = new URL(texte);
    return /\/(login|connexion)\b/i.test(analysee.pathname);
  } catch {
    return /\/(login|connexion)\b/i.test(texte);
  }
}

/** Le texte de la page est-il un challenge Cloudflare plutôt que le site ? */
function estChallengeCloudflare(texte) {
  return /performing security verification|v[ée]rification de s[ée]curit[ée] en cours|cf-challenge/i
    .test(String(texte || ''));
}

/**
 * La date portée par le texte d'une ligne de commande, en ISO, ou null.
 * Format observé sur le site en français : jj/mm/aaaa.
 */
function dateDeLigne(texte) {
  const m = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(String(texte || ''));
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(String(texte || ''));
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

/**
 * Le tampon est-il un PDF ? Le service de facturation d'Addons sert les
 * factures avec un BOM UTF-8 devant l'en-tête — mesuré le 12/08/2026 sur la
 * commande 1709434 : EF BB BF puis un %PDF-1.7 parfaitement valide (85 858
 * octets, la facture entière derrière). Un contrôle strict des cinq premiers
 * octets concluait « session expirée » à tort et stoppait TOUTE la
 * récupération à la première facture. On tolère donc CE cas précis — le BOM,
 * rien d'autre — et on rend le document canonique (l'en-tête en tête de
 * fichier) pour que les lecteurs stricts en aval ne butent pas dessus.
 * @returns {Buffer|null} le PDF débarrassé de son BOM, ou null si pas un PDF
 */
function pdfNormalise(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const sansBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  return sansBom.subarray(0, 5).toString('latin1') === '%PDF-' ? sansBom : null;
}

/**
 * Nom du fichier déposé. JAMAIS le nom S3, opaque et instable :
 * l'année (si connue) puis le numéro de commande.
 */
function nomFichier(orderid, dateIso) {
  const annee = /^\d{4}/.exec(String(dateIso || ''))?.[0];
  return `${annee ? `${annee}_` : ''}commande_${String(orderid).replace(/[^\w-]/g, '_')}.pdf`;
}

/** Les numéros de page portés par la pagination puik, dédoublonnés, croissants. */
function pagesDepuisLibelles(libelles) {
  const vues = new Set();
  for (const libelle of Array.isArray(libelles) ? libelles : []) {
    const m = /go to page (\d+)/i.exec(String(libelle || ''));
    if (m) vues.add(Number.parseInt(m[1], 10));
  }
  return [...vues].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Xvfb — l'écran sans écran du connecteur
// ---------------------------------------------------------------------------

/** Un affichage libre de NOTRE plage : ni socket X, ni fichier de verrou. */
function affichageLibre() {
  for (let d = DISPLAY_MIN; d <= DISPLAY_MAX; d++) {
    if (fs.existsSync(`/tmp/.X11-unix/X${d}`)) continue;
    if (fs.existsSync(`/tmp/.X${d}-lock`)) continue;
    return d;
  }
  throw new Error(
    `Aucun affichage libre entre :${DISPLAY_MIN} et :${DISPLAY_MAX} — des processus Xvfb `
      + 'de récupérations précédentes ont survécu. Redémarrez le service crabe.'
  );
}

/**
 * Lance un Xvfb et attend sa socket. Rend de quoi l'éteindre.
 * @returns {Promise<{display: number, arreter: () => void}>}
 */
async function lancerXvfb() {
  const display = affichageLibre();
  const processus = spawn('Xvfb', [`:${display}`, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-noreset'], {
    stdio: 'ignore',
  });
  processus.on('error', () => {});

  const socket = `/tmp/.X11-unix/X${display}`;
  const limite = Date.now() + XVFB_READY_TIMEOUT_MS;
  while (!fs.existsSync(socket)) {
    if (Date.now() >= limite) {
      try { processus.kill('SIGTERM'); } catch { /* déjà mort */ }
      throw new Error(
        `Le serveur d'affichage n'a pas démarré sur :${display} — vérifiez que le paquet xvfb `
          + 'est installé.'
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const arreter = () => {
    try { processus.kill('SIGTERM'); } catch { /* déjà mort */ }
    for (const f of [socket, `/tmp/.X${display}-lock`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* pas à nous */ }
    }
  };
  return { display, arreter };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * L'identité crabe, MOINS la langue forcée.
 *
 * `locale: 'fr-FR'` se traduit par un en-tête `Accept-Language: fr-FR` sec,
 * injecté par la surcharge CDP à une position inhabituelle. Mesuré le
 * 12/08/2026 contre un écho local : c'était la SEULE différence d'en-têtes
 * entre le navigateur du connecteur et le Chromium qui a créé le profil — et
 * le backend addons déconnectait la session au premier contact
 * (302 → /fr/?logout=&oauth2Callback= → /en/). Le profil transféré porte déjà
 * les préférences de langue du vrai navigateur (fr-FR,fr,en-US,en) : sans
 * surcharge, Chromium envoie « fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7 » — la
 * chaîne exacte de la session d'origine, à la position naturelle.
 */
function sansSurchargeDeLangue(options) {
  const { locale, ...reste } = options;
  return reste;
}

/**
 * Ouvre le profil persistant dans un Chromium VISIBLE sur notre Xvfb, navigue
 * vers l'historique, et passe la main.
 */
async function surLeProfil(config, ctx, fn) {
  const userId = ctx?.userId;
  if (userId === undefined || userId === null) {
    // Panne de plomberie, pas d'utilisateur : le message vise l'exploitant.
    throw new Error(
      'addons-prestashop : le contexte d\'exécution ne porte pas l\'utilisateur (ctx.userId) — '
        + 'le profil de navigateur ne peut pas être retrouvé.'
    );
  }
  if (!profilPersistant.existe(userId, ID)) {
    throw erreurSessionExpiree('aucun profil de navigateur — la connexion n\'a jamais été ouverte');
  }
  const profil = profilPersistant.preparer(userId, ID);

  const { chromium } = requirePlaywright();
  const { display, arreter } = await lancerXvfb();

  // Sans un HOME inscriptible, Chromium visible meurt sur un SIGTRAP (voir
  // remote-browser.js, BROWSER_HOME_DIRNAME — même cause, même remède).
  const home = nodePath.join(require('../../../config').config.dataDir, 'navigateur');
  fs.mkdirSync(home, { recursive: true });

  let context = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profil, {
        // L'identité d'abord : les options explicites ci-dessous ont le
        // dernier mot sur ses valeurs génériques.
        ...sansSurchargeDeLangue(identity.optionsContexte({
          viewport: VIEWPORT,
          acceptDownloads: true,
        })),
        headless: false,
        env: { ...process.env, DISPLAY: `:${display}`, HOME: home },
        args: [
          `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
          '--disable-dev-shm-usage',
          '--disable-crashpad',
          '--disable-crash-reporter',
          '--no-sandbox',
          // C'est CE drapeau, avec le profil persistant et le mode visible,
          // qui fait la différence face à Cloudflare.
          '--disable-blink-features=AutomationControlled',
        ],
      });
    } catch (err) {
      if (/Singleton|ProcessSingleton|already running/i.test(String(err?.message))) {
        throw new Error(
          'Le profil de navigateur PrestaShop Addons est déjà ouvert — probablement par une '
            + 'fenêtre « Se connecter » en cours. Terminez-la, puis relancez la récupération.'
        );
      }
      throw err;
    }

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Trace des navigations du cadre principal — chemins et NOMS de
    // paramètres seulement, jamais les valeurs (les URL oauth portent des
    // jetons). C'est l'absence de cette trace qui a rendu la panne du 12/08
    // muette : le serveur répondait 302 → /fr/?logout=&oauth2Callback= dès la
    // première requête, et rien ne le montrait.
    const log = ctx?.log || (() => {});
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const brute = frame.url();
      if (!/^https?:/i.test(brute)) return;
      try {
        const u = new URL(brute);
        const clefs = [...u.searchParams.keys()];
        log(`addons-prestashop : navigation ${u.origin}${u.pathname}`
          + (clefs.length ? ` (paramètres : ${clefs.join(', ')})` : ''));
      } catch { /* URL illisible : tant pis pour la trace */ }
    });

    await allerHistorique(page);
    return await fn(page, context);
  } finally {
    await context?.close?.().catch(() => {});
    arreter();
  }
}

/** Va sur l'historique et vérifie qu'on y est vraiment. */
async function allerHistorique(page) {
  // Deux passages au plus : l'arrivée normale, puis une reprise après bascule
  // en français. Les contrôles (connexion, Cloudflare) sont refaits À CHAQUE
  // passage : le 12/08, un « ok, 0 commande » a été rendu depuis
  // /fr/login?back=… parce que la re-vérification d'après-bascule ne
  // regardait que le préfixe /fr/ — que la page de connexion du site porte
  // aussi.
  for (let passage = 1; ; passage++) {
    await page.goto(URL_HISTORIQUE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    // L'app Vue peuple le tableau APRÈS le chargement : on lui laisse le temps
    // d'apparaître plutôt que de conclure « zéro commande » sur une page vide.
    await page.waitForSelector('.order-action-invoice', { timeout: 15_000 }).catch(() => {});

    const url = page.url();
    if (estPageAuthentification(url)) {
      throw erreurSessionExpiree('redirection vers la page de connexion');
    }

    const texte = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    if (estChallengeCloudflare(texte)) {
      throw erreurSessionExpiree('la protection Cloudflare redemande une vérification');
    }
    if (url.startsWith(PREFIXE_FR)) return;

    // Un atterrissage hors de /fr/ — session rebasculée en anglais, ou accueil
    // servi en /en/ apres connexion — rebasculerait les PDF en anglais. Avant de
    // renoncer, on tente de corriger nous-memes : le lien « Francais » du pied
    // de page bascule la langue DE LA SESSION (recap du 11/08 : filtrer sur le
    // texte ET le domaine, un selecteur trop large a deja clique un lien vers
    // Welcome to the Jungle).
    if (passage > 1) {
      throw new Error(
        `addons-prestashop : la session reste en anglais malgre la bascule (${url}) — `
          + 'rouvrez la connexion et choisissez « Francais » avant de vous connecter.'
      );
    }
    if (!(await basculerEnFrancais(page))) {
      throw new Error(
        `addons-prestashop : la page servie n'est pas la version francaise (${url}) `
          + 'et la bascule automatique a echoue — rouvrez la connexion et choisissez '
          + '« Francais » avant de vous connecter.'
      );
    }
  }
}

/**
 * Clique le lien « Francais » du pied de page (ou du selecteur de langue).
 * Filtre STRICT : texte portant « Francais » ET href sur addons.prestashop.com
 * — jamais un simple href*=/fr/, deja pris en defaut (lien Welcome to the
 * Jungle clique par erreur lors des tests du 11/08).
 * @returns {Promise<boolean>} vrai si un lien a ete clique
 */
async function basculerEnFrancais(page) {
  try {
    const candidats = await page.evaluate(() => {
      const sortie = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const texte = (a.textContent || '').trim();
        if (!/fran\u00e7ais|french/i.test(texte)) continue;
        const href = a.href || '';
        if (!/addons\.prestashop\.com/i.test(href)) continue;
        a.setAttribute('data-crabe-langue', '1');
        sortie.push({ texte: texte.slice(0, 40), href: href.slice(0, 80) });
      }
      return sortie;
    });
    if (!candidats.length) return false;
    await page.locator('[data-crabe-langue="1"]').first().click({ timeout: 5000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Les commandes de la page courante. Chaque bouton de facture est MARQUÉ dans
 * le DOM (data-crabe-commande=orderid) pour être recliqué précisément.
 */
async function commandesDeLaPage(page) {
  return page.evaluate(() => {
    const sortie = [];
    for (const bouton of document.querySelectorAll('.order-action-invoice[orderid]')) {
      const orderid = bouton.getAttribute('orderid') || '';
      if (!orderid) continue;
      // Une facture désactivée n'a rien à télécharger.
      if ((bouton.getAttribute('disabled') || '').toLowerCase() === 'true') continue;
      bouton.setAttribute('data-crabe-commande', orderid);
      const ligne = bouton.closest('tr');
      sortie.push({
        orderid,
        texteLigne: (ligne?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    }
    return sortie;
  });
}

/** Les numéros de page proposés par la pagination, page 1 comprise. */
async function pagesDisponibles(page) {
  const libelles = await page.evaluate(() =>
    [...document.querySelectorAll('button[aria-label], a[aria-label]')]
      .map((b) => b.getAttribute('aria-label') || '')
  );
  const pages = pagesDepuisLibelles(libelles);
  return pages.length ? [...new Set([1, ...pages])].sort((a, b) => a - b) : [1];
}

/**
 * Passe à la page demandée et attend le repeuplement du tableau.
 * La pagination Vue ne change pas l'URL : la preuve du changement est que les
 * orderid affichés ne sont plus les mêmes.
 */
async function allerPage(page, numero, orderidsAvant) {
  const bouton = page.locator(`[aria-label="Go to page ${numero}"]`).first();
  if (!(await bouton.count())) return false;
  await bouton.click({ timeout: 5000 }).catch(() => {});

  const avant = new Set(orderidsAvant);
  const limite = Date.now() + DELAI_PAGINATION_MS;
  while (Date.now() < limite) {
    await page.waitForTimeout(400);
    const actuels = await page.evaluate(() =>
      [...document.querySelectorAll('.order-action-invoice[orderid]')]
        .map((b) => b.getAttribute('orderid'))
    );
    if (actuels.length && actuels.some((id) => !avant.has(id))) return true;
  }
  return false;
}

/**
 * Clique une facture et rapporte le fichier téléchargé.
 *
 * DEUX voies écoutées en parallèle, posées AVANT le clic, le premier arrivé
 * gagne — le modèle exact du connecteur impots (urlDuDocument) :
 *   - TÉLÉCHARGEMENT : la voie normale, le fichier est sur le disque ;
 *   - PAGE : l'onglet about:blank qui porte le téléchargement — il ne compte
 *     pas comme document, on le referme et on attend le téléchargement.
 *
 * @returns {Promise<{fichier: object}|null>}
 */
async function telechargerFacture(page, context, orderid) {
  const bouton = page.locator(`[data-crabe-commande="${orderid}"]`).first();
  if (!(await bouton.count())) return null;

  const attenteTelechargement = page
    .waitForEvent('download', { timeout: DELAI_TELECHARGEMENT_MS })
    .then((d) => ({ type: 'download', valeur: d }))
    .catch(() => null);
  const attentePage = context
    .waitForEvent('page', { timeout: DELAI_TELECHARGEMENT_MS })
    .then((p) => ({ type: 'page', valeur: p }))
    .catch(() => null);

  await bouton.click({ timeout: 5000 }).catch(() => {});

  const arrive = await Promise.race([attenteTelechargement, attentePage]);

  if (arrive?.type === 'download') return { fichier: arrive.valeur };

  if (arrive?.type === 'page') {
    // L'onglet vide qui porte le téléchargement : on le referme et on attend
    // le téléchargement lui-même, qui suit de peu.
    await arrive.valeur.close().catch(() => {});
    const retard = await attenteTelechargement;
    if (retard?.type === 'download') return { fichier: retard.valeur };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la page d'historique s'ouvre, les commandes se comptent. */
async function test(config, ctx = {}) {
  return surLeProfil(config, ctx, async (page) => {
    const commandes = await commandesDeLaPage(page);
    const pages = await pagesDisponibles(page);
    return {
      ok: true,
      accountId: COMPTE_PAR_DEFAUT,
      invoiceCount: undefined,
      message:
        `Connexion valide — ${commandes.length} commande(s) sur la première page`
        + (pages.length > 1 ? `, ${pages.length} page(s) d'historique` : ''),
    };
  });
}

/**
 * Récupère les factures de toutes les pages de l'historique.
 *
 * **Reprise :** les commandes déjà récupérées (ctx.knownRemoteIds, dédup sur
 * orderid) ne sont pas recliquées. Chaque facture exige un clic et un
 * téléchargement S3 : le premier rattrapage (36 commandes, 2 pages) prend
 * quelques minutes ; ensuite seules les nouveautés coûtent.
 */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeProfil(config, ctx, async (page, context) => {
    const invoices = [];
    const pages = await pagesDisponibles(page);
    log(`addons-prestashop : ${pages.length} page(s) d'historique, `
      + `${connus.size} commande(s) déjà récupérée(s)`);

    let orderidsCourants = [];
    let commandesVues = 0;

    for (const numero of pages) {
      if (numero !== 1) {
        const passe = await allerPage(page, numero, orderidsCourants);
        if (!passe) {
          log(`addons-prestashop : la page ${numero} n'a pas répondu, arrêt du parcours — `
            + 'les commandes restantes seront reprises à la prochaine exécution');
          break;
        }
      }

      const commandes = await commandesDeLaPage(page);
      orderidsCourants = commandes.map((c) => c.orderid);
      commandesVues += commandes.length;
      log(`addons-prestashop : page ${numero} — ${commandes.length} commande(s)`);

      for (const commande of commandes) {
        if (connus.has(commande.orderid)) continue;

        const obtenu = await telechargerFacture(page, context, commande.orderid);
        if (!obtenu) {
          log(`addons-prestashop : commande ${commande.orderid} — aucun téléchargement reçu, `
            + 'ignorée pour cette fois ; elle sera reprise à la prochaine exécution');
          continue;
        }

        const chemin = await obtenu.fichier.path().catch(() => null);
        const buffer = chemin ? await fs.promises.readFile(chemin).catch(() => null) : null;
        if (!buffer) {
          log(`addons-prestashop : commande ${commande.orderid} — fichier téléchargé illisible, `
            + 'ignorée pour cette fois');
          continue;
        }
        const pdf = pdfNormalise(buffer);
        if (!pdf) {
          // Un HTML à la place d'un PDF : la session vient de tomber, inutile
          // de cliquer les commandes suivantes.
          throw erreurSessionExpiree(
            `réponse non-PDF pour la commande ${commande.orderid} (${buffer.length} o)`
          );
        }

        const dateIso = dateDeLigne(commande.texteLigne);
        connus.add(commande.orderid);
        invoices.push({
          accountId: COMPTE_PAR_DEFAUT,
          remoteId: commande.orderid,
          filename: nomFichier(commande.orderid, dateIso),
          issuedOn: dateIso,
          buffer: pdf,
        });

        await page.waitForTimeout(PAUSE_FACTURE_MS);
      }
    }

    // Preuve d'accès (lot 31) : l'historique a été servi en /fr/ sans
    // redirection ni mur Cloudflare (allerHistorique), et ses pages viennent
    // d'être lues ligne à ligne — c'est ce compte de commandes qui atteste que
    // « rien de nouveau » veut dire « tout est déjà récupéré », pas « rien vu ».
    ctx.preuveDeListe?.({
      session: 'historique du compte servi hors formulaire, sur le profil connecté',
      liste: `historique des commandes PrestaShop Addons (${pages.length} page(s))`,
      elements: commandesVues,
    });

    log(`addons-prestashop : ${invoices.length} facture(s) récupérée(s)`);
    return { accountId: COMPTE_PAR_DEFAUT, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  estChallengeCloudflare,
  dateDeLigne,
  nomFichier,
  pdfNormalise,
  pagesDepuisLibelles,
  erreurSessionExpiree,
  MESSAGE_SESSION_EXPIREE,
  URL_HISTORIQUE,
  DISPLAY_MIN,
  DISPLAY_MAX,
  COMPTE_PAR_DEFAUT,
};
