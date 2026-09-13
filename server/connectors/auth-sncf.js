'use strict';

/**
 * Mon Identifiant SNCF — l'authentification PARTAGÉE de SNCF Connect et OUIGO.
 *
 * ─── Ce qui a été mesuré le 14/08/2026, sans identifiants ────────────────────
 *
 * Le bouton « Se connecter » de ventes.ouigo.com mène à
 * `auth.monidentifiant.sncf/u/login/identifier` — l'écran d'identifiant du
 * service « Mon Identifiant SNCF », que SNCF Connect utilise aussi (relevé
 * d'écran réel). L'enchaînement, mesuré au navigateur réel avec une adresse
 * inexistante :
 *
 *   1. `/u/login/identifier` : l'adresse e-mail, bouton « Se connecter » ;
 *   2. `/u/login/password`  : le mot de passe, sur un DEUXIÈME écran (l'adresse
 *      inexistante y passe sans rien révéler du compte).
 *
 * Aucun captcha vu sur ces deux écrans. Une validation supplémentaire (code
 * par e-mail ou SMS) après le mot de passe n'est PAS mesurable sans compte :
 * si elle existe, la fenêtre de connexion visible la laisse franchir à la
 * main — c'est pour ça que la connexion passe par elle, jamais par un
 * formulaire soumis en aveugle.
 *
 * ─── Pourquoi un PROFIL PERSISTANT par service ───────────────────────────────
 *
 * www.sncf-connect.com est gardé par une vérification anti-robot qui juge le
 * NAVIGATEUR : au curl comme au Chromium sans profil, la page rend un
 * interstitiel (`ct.captcha-delivery.com`, objet `dd={…}`) et pas une ligne de
 * contenu. Le précédent de PrestaShop Addons (lot 30) montre la voie qui
 * marche : l'utilisateur se connecte LUI-MÊME dans une fenêtre visible ouverte
 * sur un profil de navigateur persistant, la levée de la garde voyage avec ce
 * profil, et les récupérations suivantes le rouvrent sans se reconnecter.
 *
 * Chaque service garde SON profil (`profils-navigateur/<userId>/<service>`)
 * même si l'identité est commune : la session d'application (cookies
 * ouigo.com, cookies sncf-connect.com, jeton anti-robot) est propre à chacun.
 * Ce que l'identité partagée apporte : le profil qui détient déjà une session
 * « Mon Identifiant SNCF » ressort de l'écran de connexion sans redemander le
 * mot de passe — mais c'est un confort, pas un couplage, et rien ici ne
 * suppose qu'une session de l'un vaille pour l'autre.
 *
 * ─── Ce que ce module fournit ────────────────────────────────────────────────
 *
 * La détection de l'écran d'authentification, la détection du mur anti-robot,
 * les messages publics qui disent quoi faire, la fermeture du bandeau de
 * cookies d'OUIGO (qui se re-monte après fermeture — mesuré), et
 * `surLeProfil()` : ouvrir le profil du couple (utilisateur, service) sous
 * Xvfb en mode visible — la recette qui fait la différence face aux gardes
 * anti-robot, reprise de PrestaShop Addons — puis passer la main.
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const identity = require('./browser-identity');
const profilPersistant = require('./profil-persistant');
// Le verrou de profil est PARTAGÉ avec la fenêtre de connexion
// (remote-browser.js) : un profil persistant ne supporte qu'un Chromium à la
// fois, et le 19/08/2026 à 23:39 une fenêtre « Se connecter » s'est heurtée
// au profil qu'une récupération tenait — message Playwright brut à l'écran.
const inflight = require('./inflight');

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** L'application se peint après coup : on lui laisse le temps d'exister. */
const DELAI_RENDU_MS = 6_000;

/**
 * Plage d'affichages RÉSERVÉE à ce module : PrestaShop Addons occupe 109-118,
 * partager la même plage ferait échouer deux récupérations simultanées.
 */
const DISPLAY_MIN = 119;
const DISPLAY_MAX = 128;
const XVFB_READY_TIMEOUT_MS = 15_000;
const SCREEN = '1600x900x24';

/**
 * L'écran d'authentification « Mon Identifiant SNCF », par son adresse.
 *
 * Le domaine `monidentifiant.sncf` est examiné en entier (auth., www.) : c'est
 * un domaine DÉDIÉ à l'identification, il n'y a rien d'autre à y faire. Le
 * chemin `/u/login/` attrape le même écran s'il se servait un jour depuis un
 * autre hôte.
 */
function estPageAuthentification(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)monidentifiant\.sncf$/i.test(u.hostname)) return true;
    return /^\/u\/(login|signup|mfa)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Le mur anti-robot de sncf-connect.com est-il à l'écran ?
 *
 * Mesuré au curl le 14/08/2026 : HTTP 403, 779 octets, un script
 * `ct.captcha-delivery.com/i.js` et un objet `dd={'rt':'i',…}` — et au
 * navigateur réel sans profil, une page au titre « sncf-connect.com » dont le
 * corps reste VIDE. Les trois signatures sont cherchées.
 */
async function estMurAntiRobot(page) {
  return page.evaluate(() => {
    if ([...document.querySelectorAll('script[src]')].some((s) =>
      /captcha-delivery\.com/i.test(s.src))) return true;
    if (typeof window.dd === 'object' && window.dd && window.dd.rt) return true;
    const texte = (document.body?.innerText || '').trim();
    return /please enable js|enable javascript and disable any ad blocker/i.test(texte);
  }).catch(() => false);
}

/** Le message public du mur : il dit le geste, pas la technologie. */
function messageMur(nomService) {
  return (
    `${nomService} a présenté sa vérification de sécurité au lieu de vos voyages. Cette `
    + 'vérification juge le navigateur, pas votre compte : vos identifiants n\'y sont pour '
    + 'rien. Rouvrez la connexion depuis la fiche du service — la fenêtre visible de crabe '
    + 'sait la franchir — puis relancez la récupération.'
  );
}

/** Une session absente ou tombée : le geste est le même, on le dit pareil. */
function erreurSessionExpiree(nomService, precision = '') {
  const err = new Error(
    `Votre connexion à ${nomService} a expiré ou n'a jamais été ouverte. Ouvrez la fiche du `
    + 'service et cliquez « Se connecter », puis relancez la récupération.'
  );
  err.sessionExpired = true;
  err.precision = precision;
  return err;
}

/**
 * Ferme le bandeau de cookies d'OUIGO — et il se REMONTE après fermeture.
 *
 * Mesuré le 14/08/2026 : « Bienvenue chez OUIGO ! », boutons « Accepter &
 * Fermer » / « Continuer sans accepter → », le clic Playwright est intercepté
 * et la boîte réapparaît après une première fermeture. D'où : plusieurs
 * passages, clic déclenché DANS la page, et l'on vérifie à la fin qu'il ne
 * reste rien. On clique « Continuer sans accepter » — le strict nécessaire
 * pour dégager l'écran, sans accepter de pistage.
 */
async function fermerBandeauCookies(page, log = () => {}) {
  for (let passage = 0; passage < 4; passage++) {
    const clique = await page.evaluate(() => {
      const bouton = [...document.querySelectorAll('button')].find((b) =>
        /continuer sans accepter|tout refuser/i.test(b.innerText || ''));
      if (bouton) {
        bouton.click();
        return true;
      }
      return false;
    }).catch(() => false);
    if (!clique) return;
    await page.waitForTimeout(1_500);
    log('auth-sncf : bandeau de cookies fermé (sans accepter).');
  }
}

/** Un dossier HOME inscriptible, sans lequel Chromium meurt sur un SIGTRAP. */
function maisonNavigateur() {
  const dossier = nodePath.join(require('../config').config.dataDir, 'navigateur');
  fs.mkdirSync(dossier, { recursive: true });
  return dossier;
}

/** Le premier affichage libre de NOTRE plage. */
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
 * Lance un Xvfb et attend sa socket — la recette de PrestaShop Addons (lot
 * 30), reprise telle quelle : c'est le mode visible sur profil persistant qui
 * fait la différence face aux gardes anti-robot.
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

function requirePlaywright(nomService) {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `La récupération ${nomService} demande un navigateur, et Playwright n'est pas installé `
        + 'sur ce serveur. Signalez-le à la personne qui administre crabe.'
    );
  }
}

/**
 * Ouvre le profil persistant du couple (utilisateur, service) dans un
 * Chromium VISIBLE sur Xvfb, va à la page demandée, ferme les bandeaux,
 * vérifie qu'on n'est ni sur l'écran d'identification ni devant le mur
 * anti-robot, puis passe la main à `fn(page, context)`.
 *
 * @param {object} options
 * @param {string} options.id           l'identifiant du connecteur (le profil)
 * @param {string} options.nom          le nom montré dans les messages
 * @param {object} options.ctx          le contexte d'exécution (userId, log)
 * @param {string} options.urlDepart    la page à atteindre
 */
async function surLeProfil({ id, nom, ctx, urlDepart }, fn) {
  const log = ctx?.log || (() => {});
  const userId = ctx?.userId;
  if (userId === undefined || userId === null) {
    // Panne de plomberie, pas d'utilisateur : le message vise l'exploitant.
    throw new Error(
      `${id} : le contexte d'exécution ne porte pas l'utilisateur (ctx.userId) — `
        + 'le profil de navigateur ne peut pas être retrouvé.'
    );
  }
  if (!profilPersistant.existe(userId, id)) {
    throw erreurSessionExpiree(nom, 'aucun profil de navigateur — la connexion n\'a jamais été ouverte');
  }

  // Le profil est peut-être déjà OUVERT — par la fenêtre « Se connecter » ou
  // par une autre récupération. Refuser AVANT de préparer quoi que ce soit,
  // en disant quoi attendre ; le verrou est ensuite tenu jusqu'au bout.
  const cleProfil = inflight.profilKey(userId, id);
  if (inflight.profil.busy(cleProfil)) {
    const porteur = inflight.profil.holder(cleProfil);
    throw new Error(
      porteur === inflight.PORTEUR_FENETRE
        ? `La fenêtre « Se connecter à ${nom} » est ouverte sur ce serveur : elle utilise la même `
          + 'connexion enregistrée. Terminez-la ou annulez-la, puis relancez la récupération.'
        : `Une récupération ${nom} est déjà en cours sur ce serveur : elle utilise la même `
          + 'connexion enregistrée. Attendez qu\'elle se termine — quelques minutes — puis réessayez.'
    );
  }
  return inflight.profil.run(cleProfil, () => surLeProfilVerrouille({ id, nom, log, userId, urlDepart }, fn),
    `Une récupération ${nom} est déjà en cours sur ce serveur : elle utilise la même `
      + 'connexion enregistrée. Attendez qu\'elle se termine — quelques minutes — puis réessayez.',
    inflight.PORTEUR_RECUPERATION);
}

/** Le corps de `surLeProfil`, une fois le verrou de profil pris. */
async function surLeProfilVerrouille({ id, nom, log, userId, urlDepart }, fn) {
  const profil = profilPersistant.preparer(userId, id);

  const { chromium } = requirePlaywright(nom);
  const { display, arreter } = await lancerXvfb();
  let context = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profil, {
        // L'identité d'abord ; les options explicites ont le dernier mot.
        ...identity.optionsContexte({ viewport: VIEWPORT, acceptDownloads: true }),
        headless: false,
        env: { ...process.env, DISPLAY: `:${display}`, HOME: maisonNavigateur() },
        args: [
          `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
          '--disable-dev-shm-usage',
          '--disable-crashpad',
          '--disable-crash-reporter',
          '--no-sandbox',
          // C'est CE drapeau, avec le profil persistant et le mode visible,
          // qui fait la différence face aux gardes anti-robot (lot 30).
          '--disable-blink-features=AutomationControlled',
        ],
      });
    } catch (err) {
      if (/Singleton|ProcessSingleton|already running/i.test(String(err?.message))) {
        throw new Error(
          `Le navigateur de ${nom} est déjà ouvert — probablement par une fenêtre `
            + '« Se connecter » en cours. Terminez-la, puis relancez.'
        );
      }
      throw err;
    }

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(urlDepart, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
    await fermerBandeauCookies(page, log);

    if (await estMurAntiRobot(page)) {
      log(`${id} : le mur anti-robot est à l'écran sur ${page.url()}.`);
      throw new Error(messageMur(nom));
    }
    if (estPageAuthentification(page.url())) {
      throw erreurSessionExpiree(nom, `redirection vers ${page.url()}`);
    }

    log(`${id} : page atteinte (${page.url()}).`);
    return await fn(page, context);
  } finally {
    await context?.close?.().catch(() => {});
    arreter();
  }
}

module.exports = {
  estPageAuthentification,
  estMurAntiRobot,
  messageMur,
  erreurSessionExpiree,
  fermerBandeauCookies,
  surLeProfil,
  VIEWPORT,
  NAV_TIMEOUT_MS,
  DELAI_RENDU_MS,
};
