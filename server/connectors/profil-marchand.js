'use strict';

/**
 * Le profil de navigateur d'une enseigne marchande — ouvrir, vérifier, passer
 * la main.
 *
 * ─── Pourquoi ce module existe (lot 47) ──────────────────────────────────────
 *
 * Sept enseignes arrivent d'un coup (Decathlon, Darty, Boulanger, LDLC,
 * Électro Dépôt, Bricomarché, VistaPrint), toutes sur le même modèle : une
 * session ouverte à la main par l'utilisateur dans la fenêtre « Se
 * connecter », conservée dans un profil de navigateur persistant, rouverte par
 * le connecteur. La mécanique d'ouverture — retrouver le profil, prendre le
 * verrou, lancer Xvfb, ouvrir le Chromium complet, fermer ce qui recouvre —
 * est EXACTEMENT celle que `auth-sncf.js` a mise au point pour SNCF Connect et
 * OUIGO. La recopier sept fois, c'est sept occasions de la corriger six fois.
 *
 * Ce module la porte UNE fois, sans rien savoir des enseignes : ce qui est
 * propre à chacune (l'adresse de la liste, la forme de sa page de connexion,
 * ses murs) reste dans son connecteur.
 *
 * ─── Pourquoi le Chromium complet, visible sous Xvfb ─────────────────────────
 *
 * Deux mesures commandent ce choix, aucune n'est théorique :
 *
 *   - le shell headless de Playwright PURGE les cookies de session à la
 *     fermeture, là où le Chromium complet les garde (mesuré le 19/08/2026,
 *     lot 40 — deux binaires distincts). Or ces connecteurs n'ont QUE la
 *     session : la perdre à chaque passage les tuerait en silence ;
 *   - c'est le mode visible sur profil persistant, avec le drapeau
 *     anti-automatisation, qui fait la différence face aux gardes anti-robot
 *     (recette PrestaShop Addons, lot 30, reprise par auth-sncf au lot 31).
 *
 * ─── La plage d'affichages de CE module ──────────────────────────────────────
 *
 * PrestaShop Addons occupe :109-118, auth-sncf :119-128. Ce module prend
 * :129-138 : partager une plage ferait échouer deux récupérations simultanées.
 */

const fs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const identity = require('./browser-identity');
const profilPersistant = require('./profil-persistant');
const inflight = require('./inflight');

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Les boutiques modernes se peignent après coup : on leur laisse le temps. */
const DELAI_RENDU_MS = 6_000;

const DISPLAY_MIN = 129;
const DISPLAY_MAX = 138;
const XVFB_READY_TIMEOUT_MS = 15_000;
const SCREEN = '1600x900x24';

function requirePlaywright(nom) {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `Le navigateur nécessaire à ${nom} n'est pas installé sur ce serveur. `
        + 'Signalez-le à la personne qui administre crabe.'
    );
  }
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
 * La session EST enregistrée — le profil existe, parfois vérifié quelques
 * minutes plus tôt — mais le site renvoie la lecture automatique vers son
 * écran d'authentification.
 *
 * ─── L'incident qui impose la distinction (lot 50) ───────────────────────────
 *
 * Le 23/08/2026 : session Darty capturée à 09:40:23 (58 cookies, validité
 * vérifiée sur la fenêtre), et à 09:41:16 puis 09:42:08 le connecteur est
 * renvoyé vers l'authentification — le mur du site refuse les cookies dès
 * qu'ils servent hors de la fenêtre. L'écran affichait alors « votre connexion
 * a expiré ou n'a jamais été ouverte : cliquez Se connecter » à quelqu'un qui
 * venait de le faire : un message FAUX, et une boucle sans sortie.
 *
 * D'où deux erreurs distinctes : `erreurSessionExpiree` quand il n'y a PAS de
 * session à honorer (profil absent), celle-ci quand la session est là et que
 * c'est le site qui l'éconduit. On ne sait pas d'ici si elle a expiré ou si le
 * site refuse le passage automatique — le message dit donc les deux issues et
 * le geste de chacune, sans accuser l'utilisateur d'un geste qu'il a fait.
 */
function erreurRenvoiVersAuthentification(nomService, precision = '') {
  const err = new Error(
    `Votre connexion à ${nomService} est bien enregistrée, mais le site a renvoyé la lecture `
    + 'automatique vers sa page d\'authentification au lieu de servir votre espace client. '
    + 'Si cette connexion date de plusieurs semaines, elle a probablement expiré : rouvrez-la '
    + 'depuis la fiche du service. Si vous venez de l\'ouvrir, inutile de recommencer — '
    + 'c\'est le site qui refuse ce passage automatique : réessayez dans quelques heures, '
    + 'et signalez-le si cela se répète.'
  );
  err.sessionExpired = true;
  err.precision = precision;
  return err;
}

/**
 * Une page de connexion, reconnue par son CHEMIN — jamais par sa query :
 * `/compte?retour=%2Fconnexion` est une page de compte, la déclarer expirée
 * ferait redemander une connexion à chaque exécution (leçon airbnb, lot 35).
 *
 * Le motif par défaut couvre les formes vues sur les sept enseignes du lot 47
 * (`/connexion`, `/login`, `/signin`, `/identification`…) ; un connecteur dont
 * le site fait autrement passe le sien.
 */
const MOTIF_AUTHENTIFICATION_DEFAUT =
  /\/(connexion|login|log-in|signin|sign-in|signup|sign-up|authentication|authentification|identification|auth)(\/|$)/i;

function estPageAuthentification(url, motif = MOTIF_AUTHENTIFICATION_DEFAUT) {
  try {
    return motif.test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

/**
 * Ferme ce qui recouvre la page, EN REFUSANT, plusieurs passages — les
 * bandeaux se REMONTENT après fermeture (mesuré sur OUIGO le 14/08/2026, et
 * c'est un travers courant des régies françaises). Le clic est déclenché DANS
 * la page : un clic Playwright serait intercepté par l'overlay lui-même.
 */
async function fermerBandeauCookies(page, log = () => {}) {
  for (let passage = 0; passage < 4; passage++) {
    const clique = await page.evaluate(() => {
      const bouton = [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
        .filter((el) => el.offsetWidth || el.offsetHeight)
        .find((el) =>
          /^(continuer sans accepter|tout refuser|refuser tout|refuser|je refuse)/i
            .test((el.innerText || '').replace(/\s+/g, ' ').trim()));
      if (bouton) {
        bouton.click();
        return true;
      }
      return false;
    }).catch(() => false);
    if (!clique) return;
    await page.waitForTimeout(1_500).catch(() => {});
    log('profil-marchand : bandeau de consentement fermé (sans accepter).');
  }
}

/**
 * Un mur anti-robot est-il à l'écran ? Les signatures génériques des trois
 * gardes rencontrées sur les portails français : DataDome (le script
 * `captcha-delivery.com` et l'objet `dd`, mesurés sur sncf-connect.com),
 * Cloudflare (le titre « Just a moment… » de l'interstitiel, l'iframe
 * Turnstile), et la page qui somme d'activer JavaScript.
 */
async function estMurAntiRobot(page) {
  return page.evaluate(() => {
    if ([...document.querySelectorAll('script[src]')].some((s) =>
      /captcha-delivery\.com/i.test(s.src))) return true;
    if (typeof window.dd === 'object' && window.dd && window.dd.rt) return true;
    // Le titre de l'interstitiel Cloudflare, dans ses deux langues mesurées :
    // « Just a moment… » et « Un instant… » (relevé sur bricomarche.com le
    // 22/08/2026, avec le corps « Vérification de sécurité en cours »).
    if (/^(just a moment|un instant)/i.test(document.title || '')) return true;
    if ([...document.querySelectorAll('iframe[src]')].some((f) =>
      /challenges\.cloudflare\.com|geo\.captcha-delivery\.com/i.test(f.src))) return true;
    const texte = (document.body?.innerText || '').trim();
    return /please enable js|enable javascript and disable any ad blocker|v[ée]rification de s[ée]curit[ée] en cours/i.test(texte);
  }).catch(() => false);
}

/** Le message public du mur : il dit le geste, pas la technologie. */
function messageMur(nomService) {
  return (
    `${nomService} a présenté sa vérification de sécurité au lieu de votre espace client. Cette `
    + 'vérification juge le navigateur, pas votre compte : vos identifiants n\'y sont pour '
    + 'rien. Rouvrez la connexion depuis la fiche du service — la fenêtre visible de crabe '
    + 'sait la franchir — puis relancez la récupération.'
  );
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
 * 30), reprise telle quelle par auth-sncf (lot 31), puis ici.
 */
async function lancerXvfb() {
  const display = affichageLibre();
  const processus = spawn(
    'Xvfb',
    [`:${display}`, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-noreset'],
    { stdio: 'ignore' }
  );
  const socket = `/tmp/.X11-unix/X${display}`;
  const fin = Date.now() + XVFB_READY_TIMEOUT_MS;
  while (Date.now() < fin) {
    if (fs.existsSync(socket)) {
      return { display, arreter: () => { try { processus.kill(); } catch { /* déjà mort */ } } };
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  try { processus.kill(); } catch { /* jamais parti */ }
  throw new Error(
    `Le serveur d'affichage n'a pas démarré sur :${display} — vérifiez que le paquet xvfb `
      + 'est installé sur ce serveur.'
  );
}

/**
 * Ouvre le profil persistant du couple (utilisateur, enseigne), atteint
 * `urlDepart`, ferme ce qui recouvre, vérifie qu'on n'est ni sur un écran de
 * connexion ni devant un mur, puis passe la main à `fn(page, context)`.
 *
 * @param {object} options
 * @param {string} options.id          l'identifiant du connecteur (le profil)
 * @param {string} options.nom         le nom montré dans les messages
 * @param {object} options.ctx         le contexte d'exécution (userId, log)
 * @param {string} options.urlDepart   la page à atteindre
 * @param {(url: string) => boolean} [options.estAuthentification] comment
 *   reconnaître SA page de connexion — indispensable quand elle vit sur un
 *   autre hôte (le SSO de Decathlon est `login.decathlon.net`, un chemin ne le
 *   décrit pas) ; à défaut, le motif de chemin par défaut s'applique
 */
async function surLeProfil({ id, nom, ctx, urlDepart, estAuthentification }, fn) {
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
    // La précision part au JOURNAL avant de lever : « connexion expirée » à
    // l'écran couvre deux situations très différentes (profil absent,
    // redirection), et le 23/08/2026 le journal ne permettait pas de les
    // distinguer — le diagnostic Bricomarché a exigé un rejeu complet.
    log(`${id} : aucun profil de navigateur sur ce serveur — la connexion n'a jamais été ouverte, ou a été effacée.`);
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
  return inflight.profil.run(
    cleProfil,
    () => surLeProfilVerrouille({ id, nom, log, userId, urlDepart, estAuthentification }, fn),
    `Une récupération ${nom} est déjà en cours sur ce serveur : elle utilise la même `
      + 'connexion enregistrée. Attendez qu\'elle se termine — quelques minutes — puis réessayez.',
    inflight.PORTEUR_RECUPERATION
  );
}

/** Le corps de `surLeProfil`, une fois le verrou de profil pris. */
async function surLeProfilVerrouille({ id, nom, log, userId, urlDepart, estAuthentification }, fn) {
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

    await atteindreLaPage(page, { id, nom, log, urlDepart, estAuthentification });

    log(`${id} : page atteinte (${page.url()}).`);
    return await fn(page, context);
  } finally {
    await context?.close?.().catch(() => {});
    arreter();
  }
}

/**
 * Conduit la page ouverte jusqu'à `urlDepart`, ou dit pourquoi c'est
 * impossible — mur anti-robot, ou renvoi vers l'authentification.
 *
 * ─── La relecture unique, et d'où elle vient (lot 49) ────────────────────────
 *
 * Le 23/08/2026 à 07:38:42, la récupération Bricomarché — lancée par l'écran
 * à l'instant même où la fenêtre « Se connecter » s'éteignait — a été
 * renvoyée vers la page de connexion, et la session valide s'est retrouvée
 * marquée en erreur. Le MÊME geste, rejoué deux heures plus tard, a tenu
 * `/my-account` avec un lien de déconnexion. Un renvoi vers l'authentification
 * peut donc être TRANSITOIRE ; une seule relecture le départage, chaque
 * passage s'écrit au journal, et un renvoi qui persiste reste ce qu'il est :
 * une session à rouvrir. La cause exacte du renvoi de 07:38:42 n'a pas pu
 * être établie depuis les journaux — c'est aussi pour ça que la redirection
 * est désormais journalisée AVEC son adresse, au lieu de se perdre dans le
 * champ `precision` que personne ne lisait.
 *
 * Exportée pour être prouvée par les tests avec une page simulée : le
 * navigateur, l'affichage et le verrou restent l'affaire de `surLeProfil`.
 */
async function atteindreLaPage(page, { id, nom, log, urlDepart, estAuthentification }) {
  const reconnaitre = estAuthentification || ((url) => estPageAuthentification(url));
  for (let lecture = 1; ; lecture++) {
    await page.goto(urlDepart, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
    await fermerBandeauCookies(page, log);

    if (await estMurAntiRobot(page)) {
      log(`${id} : le mur anti-robot est à l'écran sur ${page.url()}.`);
      throw new Error(messageMur(nom));
    }
    if (!reconnaitre(page.url())) return;

    log(`${id} : renvoyé vers ${page.url()} — lecture ${lecture}.`);
    if (lecture >= 2) {
      // Ici le profil EXISTE (surLeProfil l'a vérifié avant d'ouvrir quoi que
      // ce soit) : « expiré ou jamais ouverte » serait faux — c'est le renvoi
      // malgré session, et le message le dit (lot 50, incident Darty).
      throw erreurRenvoiVersAuthentification(nom, `redirection vers ${page.url()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Le squelette commun des ÉBAUCHES (lot 47)
//
// Les sept connecteurs de ce lot n'ont JAMAIS vu la liste des commandes de
// leur enseigne : la reconnaissance s'est faite en visiteur anonyme, et la
// forme d'une ligne de commande n'est pas mesurable sans session. Ce qu'ils
// savent faire — et c'est tout — tient en trois gestes : atteindre la page des
// commandes, prouver qu'elle est servie AU COMPTE (l'adresse a tenu, alors
// qu'elle redirige les anonymes — c'est la mesure de chaque manifeste), et
// écrire au journal ce qu'ils voient pour que le premier passage réel soit
// diagnosticable. Les trois fonctions ci-dessous portent ces gestes une fois.
// ---------------------------------------------------------------------------

/**
 * Un repère de commande GÉNÉRIQUE, jamais vérifié sur un compte réel.
 *
 * Compté sur le nœud le plus profond qui le porte (la leçon OUIGO du lot 43 :
 * compter des mots dans le texte entier fait matcher le pied de page
 * marketing). Le nombre rendu est un INDICE pour le journal, pas une mesure —
 * chaque connecteur le dit en le journalisant.
 */
const MOTIF_REPERE_COMMANDE =
  /n[°o]\s*(de\s*)?commande|commande\s+n[°o]|commande\s+(du|pass[ée]e)\s|r[ée]f[ée]rence\s*:/i;

/**
 * Ce que la page montre, ramassé en une passe pour `etatDeLaListe`.
 *
 * `selecteurRepere` (lot 49) : quand la vraie page a été RELEVÉE et que chaque
 * commande porte un sélecteur mesuré (`[data-testid="order"]` chez Darty,
 * `.order` chez Boulanger), compter ces éléments vaut mieux que compter un
 * motif de texte générique — c'est la mesure qui remplace l'indice. Le motif
 * reste le filet quand le sélecteur ne trouve rien.
 */
async function photographier(page, motifRepere = MOTIF_REPERE_COMMANDE, selecteurRepere = null) {
  return page.evaluate(({ motif, selecteur }) => {
    const reRepere = new RegExp(motif, 'i');
    const visibles = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => el.offsetWidth || el.offsetHeight);
    return {
      url: location.href,
      boutonSeConnecter: visibles.some((el) =>
        /^\s*(se connecter|connexion|s'identifier|me connecter)\s*$/i
          .test((el.innerText || '').replace(/\s+/g, ' ').trim())),
      // Un repère = le sélecteur MESURÉ quand il en trouve (lot 49), sinon le
      // nœud le plus PROFOND qui porte le motif : chaque commande affiche le
      // sien, les compter c'est les voir. Les scripts sont écartés — l'état
      // embarqué d'une application peut porter le même libellé sans que rien
      // ne soit à l'écran.
      reperes: (selecteur && document.querySelectorAll(selecteur).length)
        || [...document.querySelectorAll('*')].filter((el) =>
          !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
          && reRepere.test(el.innerText || '')
          && ![...el.children].some((enfant) => reRepere.test(enfant.innerText || ''))).length,
      // Les libellés visibles, pour le journal : c'est avec eux que le
      // parcours réel sera écrit au premier compte connecté.
      libelles: visibles
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length <= 60)
        .slice(0, 20),
    };
  }, { motif: motifRepere.source, selecteur: selecteurRepere || '' })
    .catch(() => ({ url: page.url(), boutonSeConnecter: false, reperes: 0, libelles: [] }));
}

/**
 * Décide de l'état de la page des commandes depuis ce qu'elle MONTRE.
 *
 * Pure et testée : c'est elle qui interdit le faux « rien à récupérer ».
 * La preuve de session est celle que chaque manifeste a MESURÉE : hors
 * session, l'adresse des commandes redirige — donc y RESTER, sans bouton
 * « Se connecter », c'est être connecté (le raisonnement `verifyUrlTient`
 * du lot 40, appliqué ici à la récupération).
 *
 * @param {{url: string, boutonSeConnecter: boolean, reperes?: number}} vue
 * @param {{cheminListe: RegExp, estAuthentification?: (url: string) => boolean}} options
 */
function etatDeLaListe(vue, { cheminListe, estAuthentification }) {
  const url = String(vue?.url || '');
  const reconnaitre = estAuthentification || ((u) => estPageAuthentification(u));

  if (!cheminListe.test(url)) {
    if (reconnaitre(url)) {
      return {
        servie: false,
        sessionAbsente: true,
        raison: `renvoyé vers la page de connexion (${url || '(adresse inconnue)'})`,
      };
    }
    if (vue?.boutonSeConnecter) {
      return {
        servie: false,
        sessionAbsente: true,
        raison: `renvoyé vers ${url || '(adresse inconnue)'}, qui propose « Se connecter »`,
      };
    }
    return { servie: false, raison: `l'adresse servie est ${url || '(inconnue)'}` };
  }
  if (vue?.boutonSeConnecter) {
    return { servie: false, sessionAbsente: true, raison: 'la page propose « Se connecter »' };
  }
  const reperes = Number(vue?.reperes) || 0;
  return {
    servie: true,
    reperes,
    raison: 'l\'adresse des commandes a tenu — elle redirige les visiteurs anonymes — '
      + 'et aucun bouton « Se connecter » n\'est affiché',
  };
}

/**
 * Juge la page atteinte, selon ce que la reconnaissance a PU mesurer.
 *
 * Deux régimes, et la différence n'est pas un détail :
 *
 *   - `redirigeLesAnonymes: true` — la reconnaissance a MESURÉ que l'adresse
 *     des commandes éconduit les visiteurs sans session (Decathlon, LDLC…).
 *     Y rester, sans bouton « Se connecter », est alors la preuve — le
 *     raisonnement `verifyUrlTient` du lot 40 ;
 *   - `redirigeLesAnonymes: false` — la mesure n'a PAS pu établir cette
 *     redirection (Boulanger sert la même coquille d'application à tout le
 *     monde, témoin compris ; Darty était derrière son mur). Rester sur
 *     l'adresse ne prouve alors RIEN : on exige une preuve DANS la page —
 *     un marqueur MESURÉ sur le vrai compte (`marqueursMesures`, lot 49 :
 *     les commandes de Boulanger et leurs « N° F… » ne sont servies qu'à un
 *     compte connecté), ou à défaut la preuve forte générique — le lien de
 *     déconnexion, la seule chose qu'une page ne montre qu'à quelqu'un de
 *     connecté (`preuve-connexion`, lot 14).
 *
 * @returns {Promise<{vue: object, etat: object}>}
 */
async function jugerLaListe(page, {
  cheminListe, estAuthentification, redirigeLesAnonymes = true, motifRepere = null,
  selecteurRepere = null, marqueursMesures = null,
}) {
  // Le motif de repère est celui du CONNECTEUR quand il en a mesuré un : le
  // motif générique n'a reconnu AUCUNE commande sur la vraie page LDLC du
  // 22/08/2026, alors qu'une commande était à l'écran (lot 48) — et les motifs
  // se calibrent sur une FORME relevée, jamais sur une valeur réelle (règle du
  // projet sur les données personnelles).
  const vue = await photographier(page, motifRepere || MOTIF_REPERE_COMMANDE, selecteurRepere);
  const etat = etatDeLaListe(vue, { cheminListe, estAuthentification });
  if (!etat.servie || redirigeLesAnonymes) return { vue, etat };

  const preuve = require('./preuve-connexion');
  if (Array.isArray(marqueursMesures) && marqueursMesures.length) {
    const trouves = await preuve.chercherMarqueursMesures(page, marqueursMesures);
    if (trouves.length) {
      return {
        vue,
        etat: {
          ...etat,
          raison: `la page porte un marqueur mesuré de l'espace connecté (${trouves[0]}) — `
            + 'relevé sur le vrai compte, jamais servi aux anonymes',
        },
      };
    }
  }
  const tenue = await preuve.verifier(page, {});
  if (tenue.confirme) {
    return {
      vue,
      etat: {
        ...etat,
        raison: 'la page porte une preuve forte de compte connecté '
          + '(le site sert la même adresse aux anonymes — mesuré —, rester ne prouve rien)',
      },
    };
  }
  return {
    vue,
    etat: {
      servie: false,
      sessionAbsente: true,
      raison: 'la page ne porte ni marqueur mesuré ni preuve forte de compte connecté (lien '
        + 'de déconnexion introuvable) — et ce site sert la même adresse aux visiteurs '
        + 'anonymes, y rester ne prouve rien',
    },
  };
}

/**
 * La phrase servie à l'écran quand l'ébauche s'arrête, à la place du
 * « Aucune nouvelle facture » qu'elle n'a pas le droit de dire : elle n'a
 * rien lu, et elle le dit (champ `aucunDocument`, lot 41).
 */
function messageParcoursNonEcrit(nomService, reperes) {
  const compte = reperes > 0 ? ` — ${reperes} commande(s) semblent affichées` : '';
  return (
    `Votre espace client ${nomService} a bien été ouvert${compte}, mais la lecture des `
    + 'documents n\'est pas encore écrite dans crabe : rien n\'a été récupéré. Cette fiche '
    + 'sert aujourd\'hui à ouvrir et à garder votre connexion ; la récupération viendra '
    + 'dans une prochaine version.'
  );
}

module.exports = {
  VIEWPORT,
  NAV_TIMEOUT_MS,
  DELAI_RENDU_MS,
  DISPLAY_MIN,
  DISPLAY_MAX,
  MOTIF_AUTHENTIFICATION_DEFAUT,
  MOTIF_REPERE_COMMANDE,
  erreurRenvoiVersAuthentification,
  estPageAuthentification,
  fermerBandeauCookies,
  estMurAntiRobot,
  messageMur,
  erreurSessionExpiree,
  surLeProfil,
  atteindreLaPage,
  photographier,
  etatDeLaListe,
  jugerLaListe,
  messageParcoursNonEcrit,
};
