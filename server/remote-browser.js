'use strict';

/**
 * Navigateur distant — se connecter à un fournisseur sans manipuler de fichier.
 *
 * ─── Ce que ça remplace ──────────────────────────────────────────────────────
 *
 * Le lot 5 livrait la capture de session sous forme de fichier : lancer
 * `tools/capture-session.js` sur son poste, se connecter dans la fenêtre qui
 * s'ouvre, récupérer un JSON, le téléverser dans crabe. Ça marche, mais ce
 * n'est pas le parcours attendu. Ce module offre celui d'une connexion par
 * fournisseur d'identité : on clique « Se connecter », une fenêtre s'ouvre, on
 * s'authentifie, on revient dans crabe connecté.
 *
 * La fenêtre en question est un vrai Chromium, qui tourne SUR LE SERVEUR et
 * s'affiche dans l'onglet de l'utilisateur. Quatre processus l'y amènent :
 *
 *     Xvfb :99                    un écran X sans écran, en mémoire
 *       └── chromium (Playwright) headless:false, DISPLAY=:99
 *     x11vnc  → 127.0.0.1:5999    filme cet écran en RFB
 *     websockify → 127.0.0.1:6180 emballe le RFB dans un WebSocket
 *       └── relayé par crabe, après vérification de la session applicative,
 *           jusqu'au client noVNC de la page (voir routes/remote-login.js)
 *
 * C'est générique : Free Mobile s'en sert aujourd'hui, Amazon et tout futur
 * connecteur à double authentification s'en serviront demain. Un connecteur
 * déclare simplement un bloc `remoteLogin` dans son manifeste (URL de départ,
 * marqueur de réussite, conseil affiché).
 *
 * ─── Sécurité : lire avant de toucher ────────────────────────────────────────
 *
 * Ce flux affiche un navigateur RÉELLEMENT CONNECTÉ aux comptes de
 * l'utilisateur. Quiconque atteint le flux VNC atteint ses comptes. D'où, sans
 * exception :
 *
 *   - `x11vnc` et `websockify` écoutent EXCLUSIVEMENT sur 127.0.0.1. Jamais
 *     0.0.0.0, jamais un port ouvert sur le réseau. Personne d'autre que crabe
 *     lui-même ne peut les joindre ;
 *   - le seul chemin d'accès est le relais de crabe, qui vérifie la session
 *     applicative AVANT d'ouvrir la moindre socket ;
 *   - un jeton à USAGE UNIQUE, lié au couple (utilisateur, connecteur), est
 *     exigé à chaque attachement, et meurt avec la session ;
 *   - le mot de passe VNC est tiré au hasard à chaque session, écrit dans un
 *     fichier en 0600, effacé à l'extinction, et n'apparaît dans AUCUN
 *     journal — ni celui de crabe, ni celui de systemd ;
 *   - aucune capture d'écran, aucun enregistrement du flux, à aucun moment.
 *
 * ─── Robustesse ──────────────────────────────────────────────────────────────
 *
 *   - **une seule session à la fois** sur toute l'instance. Chromium plus Xvfb
 *     pèsent près d'un gigaoctet ; deux en parallèle mettraient le conteneur à
 *     genoux ;
 *   - **dix minutes maximum**, puis extinction d'office. Un onglet fermé ne
 *     doit pas laisser un navigateur tourner jusqu'au prochain redémarrage ;
 *   - **extinction systématique** : succès, échec, abandon, délai dépassé,
 *     fermeture de l'onglet, arrêt du service. Tout passe par `terminate()`,
 *     qui ne lève jamais ;
 *   - **nettoyage au démarrage** : un crabe qui redémarre pendant une session
 *     laisse des orphelins derrière lui. On les tue et on libère les
 *     affichages avant d'accepter quoi que ce soit.
 *
 * ─── Testabilité ─────────────────────────────────────────────────────────────
 *
 * Tout ce qui touche au système passe par un « runtime » injectable : `spawn`,
 * `fs`, `launchBrowser`, `now`. La suite de tests fabrique donc des processus
 * et un navigateur simulés, et vérifie le cycle de vie complet — allocation
 * d'affichage, verrou, délai, extinction — sans qu'aucun Xvfb ni Chromium ne
 * soit lancé. C'est ce qui rend ce module vérifiable en intégration.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');
const nodeCrypto = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

const detection = require('./connectors/login-detection');
const identity = require('./connectors/browser-identity');
const cookieBanner = require('./connectors/obstructions');
// La MÊME preuve de connexion que celle du connecteur PrestaShop : deux
// réponses différentes à « est-on connecté ? » seraient deux occasions de se
// tromper (voir connectors/preuve-connexion.js).
const preuve = require('./connectors/preuve-connexion');
const messagesEchec = require('./connectors/messages-echec');
const sessionState = require('./connectors/session-state');
// Le chemin du profil persistant vient du MODULE PARTAGÉ : le connecteur
// rouvrira exactement ce répertoire (voir connectors/profil-persistant.js).
const profilPersistant = require('./connectors/profil-persistant');
// Le verrou de profil aussi : un profil persistant ne supporte qu'UN Chromium
// à la fois, et la récupération (auth-sncf.js) prend le même verrou. Sans lui,
// « Se connecter » pendant une récupération mourait sur le message brut de
// Playwright (« profile is already in use » — mesuré le 19/08/2026 à 23:39).
const inflight = require('./connectors/inflight');

// ---------------------------------------------------------------------------
// Constantes d'exploitation
// ---------------------------------------------------------------------------

/**
 * Affichages X réservés à crabe.
 *
 * Le verrou n'en laisse utiliser qu'un à la fois ; la plage donne de la marge
 * pour repartir proprement quand un affichage n'a pas été libéré (processus
 * tué à coups de SIGKILL, conteneur redémarré à chaud).
 */
const DISPLAY_MIN = 99;
const DISPLAY_MAX = 108;

/** Port RFB d'un affichage : la convention X (5900 + numéro d'écran). */
const VNC_PORT_BASE = 5900;
/** Port WebSocket de websockify, hors de la plage RFB pour rester lisible. */
const WS_PORT_BASE = 6180;

/** Dix minutes pour se connecter — largement suffisant, même avec un SMS. */
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
/** Rythme de surveillance de la page. */
const POLL_MS = 700;
/** Attente maximale de l'apparition de la socket X après le lancement d'Xvfb. */
const XVFB_READY_TIMEOUT_MS = 15_000;
/** Combien de temps une session terminée reste lisible par le client. */
const LINGER_MS = 90_000;

/**
 * Patience du contrôle de session (§6 du lot 14), joué dans un Chromium à part.
 *
 * Court : ce n'est pas un parcours, c'est une page à charger et deux
 * sélecteurs à compter. Un portail qui n'a pas répondu en quinze secondes n'en
 * dira pas plus à la trentième, et l'utilisateur attend devant sa fenêtre.
 */
const CONTROLE_SESSION_TIMEOUT_MS = 15_000;

/**
 * Sursis accordé à une session dont le flux vient de tomber.
 *
 * Un onglet fermé ne doit pas retenir un Chromium pendant dix minutes ; une
 * coupure de réseau d'une seconde ne doit pas faire tout recommencer. Une
 * minute tranche entre les deux : le client se rebranche avec un jeton neuf,
 * ou la session s'éteint.
 */
const DETACH_GRACE_MS = 60_000;

/**
 * Patience accordée à `browser.close()` avant de passer en force (lot 48).
 *
 * Le soir du 22/08/2026, l'utilisateur a dû tuer des processus Chromium à la main pour
 * libérer le verrou de profil partagé. Or `shutdown()` ATTENDAIT `close()`
 * sans limite : un Chromium coincé (page lourde, garde anti-robot, processus
 * zombie) suspendait toute l'extinction — auxiliaires jamais arrêtés,
 * affichage jamais rendu, session jamais close. Passé ce délai, l'extinction
 * continue sans lui, et les Chromium restés sur l'affichage reçoivent SIGKILL.
 */
const BROWSER_CLOSE_TIMEOUT_MS = 8_000;

/**
 * Délai avant le SIGKILL des auxiliaires qui ont ignoré le SIGTERM (lot 35).
 *
 * Mesuré le 15/08/2026 : DEUX websockify écoutaient le port 6180 — l'un avait
 * survécu au SIGTERM d'une session précédente, et comme l'affichage (donc le
 * port) est rendu sans attendre la mort réelle, la session suivante a relancé
 * le sien par-dessus. Un SIGTERM n'est qu'une demande polie ; deux secondes
 * plus tard, ce qui vit encore est tué pour de bon.
 */
const KILL_ESCALATION_MS = 2_000;

/** Résolution de l'écran virtuel. Assez large pour un formulaire confortable. */
const SCREEN = { width: 1280, height: 800, depth: 24 };

/**
 * Délai entre deux caractères frappés dans la fenêtre distante.
 *
 * Une frappe instantanée fait perdre des caractères aux formulaires qui
 * écoutent chaque touche — masques de saisie, jauges de force de mot de passe.
 * Douze millisecondes restent imperceptibles (moins d'une seconde pour un mot
 * de passe de soixante caractères) et suffisent partout.
 */
const DELAI_FRAPPE_MS = 12;

/**
 * Longueur maximale d'un texte saisi d'un coup.
 *
 * Un mot de passe, un identifiant ou un code : jamais plus de quelques
 * dizaines de caractères. La borne est large, elle sert à empêcher qu'une
 * requête ne fasse frapper un mégaoctet pendant dix minutes.
 */
const SAISIE_MAX_CARACTERES = 4096;

/**
 * Mémoire à disposer pour lancer Chromium sans risque.
 *
 * Le conteneur a été porté à 4 Go pour ce lot. En dessous d'un gigaoctet et
 * demi de libre, Chromium meurt en cours de route sans rien dire — et c'est
 * exactement ce qu'il ne faut pas laisser arriver en silence.
 */
const MEMOIRE_LIBRE_MINIMALE_MO = 1200;
const MEMOIRE_TOTALE_MINIMALE_MO = 3000;

/** Emplacements possibles du client noVNC, dans l'ordre d'essai. */
const NOVNC_CANDIDATS = ['/usr/share/novnc', '/usr/local/share/novnc', '/usr/share/webapps/novnc'];

/**
 * Répertoire personnel imposé au navigateur, sous `CRABE_DATA_DIR`.
 *
 * ─── Pourquoi ce répertoire existe ───────────────────────────────────────────
 *
 * Le compte système `crabe` est créé avec `--no-create-home` : son `HOME` vaut
 * `/home/crabe`, **qui n'existe pas**. En mode invisible, Chromium s'en
 * accommode. En mode VISIBLE — le seul qui nous intéresse ici — il y installe
 * la base de son gestionnaire de plantage, l'écriture échoue, et le navigateur
 * meurt au lancement sans rien dire d'exploitable :
 *
 *     chrome_crashpad_handler: --database is required
 *     <process did exit: exitCode=null, signal=SIGTRAP>
 *
 * Côté utilisateur, ça donnait « Erreur interne du serveur » à chaque tentative
 * — c'est-à-dire le lot 6 entier inutilisable en production, alors que la suite
 * de tests était au vert et que le connecteur `free` (invisible) fonctionnait.
 *
 * La correction ne dépend donc d'AUCUNE configuration système : le navigateur
 * reçoit un `HOME` que crabe possède, sous `dataDir`, donc couvert par le
 * `ReadWritePaths` de l'unité systemd. `deploy/crabe.service` pose la même
 * valeur en `Environment=HOME=…` pour qu'une installation neuve soit correcte
 * d'emblée, mais le code n'en dépend pas.
 */
const BROWSER_HOME_DIRNAME = 'navigateur';

/**
 * Les noms sous lesquels Chromium apparaît dans /proc (lot 48).
 *
 * Le paquet Playwright livre `chrome` ; les distributions `chromium` ou
 * `chromium-browser` ; le shell headless `headless_shell`. La reconnaissance
 * sert au nettoyage — elle est TOUJOURS croisée avec l'affichage (variable
 * DISPLAY), jamais utilisée seule.
 */
const MOTIF_NOM_CHROMIUM = /^(chrome|chromium|chromium-browser|headless_shell)$/;

/** Binaires système, avec le paquet Debian qui les apporte. */
const BINAIRES = [
  { bin: 'Xvfb', paquet: 'xvfb', role: 'l\'écran X en mémoire' },
  { bin: 'x11vnc', paquet: 'x11vnc', role: 'la diffusion de cet écran en VNC' },
  { bin: 'websockify', paquet: 'websockify', role: 'l\'emballage du VNC en WebSocket' },
];

// ---------------------------------------------------------------------------
// Runtime injectable
// ---------------------------------------------------------------------------

/**
 * Tout ce que ce module emprunte au système. Remplacé en test par des doubles.
 * @returns {object}
 */
function defaultRuntime() {
  return {
    fs: nodeFs,
    os: nodeOs,
    spawn: nodeSpawn,
    /**
     * Envoi d'un signal à un processus qui n'est pas notre enfant.
     *
     * Injectable, et pas seulement par souci de symétrie : le nettoyage des
     * orphelins lit `/proc` puis tue ce qu'il y trouve. Un test qui simule
     * `/proc` avec des numéros inventés enverrait, sans ce point d'injection,
     * de vrais SIGTERM à de vrais processus de la machine.
     */
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    randomBytes: (n) => nodeCrypto.randomBytes(n),
    /** Chemins scrutés pour trouver un binaire (le PATH du service). */
    pathDirs: () => String(process.env.PATH || '').split(nodePath.delimiter).filter(Boolean),
    /** Répertoire de travail des fichiers éphémères (mot de passe VNC). */
    runDir: () => require('./config').config.dataDir,
    /**
     * Répertoire personnel du navigateur. `null` = déduit de `runDir()`.
     * Point d'injection réservé aux tests : la valeur de production est
     * volontairement liée à `dataDir`, seul emplacement inscriptible.
     */
    browserHomeDir: null,
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => [process.env.CRABE_NOVNC_DIR, ...NOVNC_CANDIDATS].filter(Boolean),
    /** Lance un navigateur Playwright. Absent des tests, remplacé par un double. */
    launchBrowser: null,
    /**
     * Journal. Volontairement injectable : rien ne doit fuir en test.
     *
     * Le troisième argument attribue la ligne à un connecteur : la source
     * devient `remote-browser:<id>`, que l'écran « Logs → Connecteurs »
     * affiche avec le journal du connecteur (lot 48). Le soir du 22/08/2026,
     * tout ce que la fenêtre disait dormait sous la source globale
     * `remote-browser`, visible seulement dans « Logs → Application » — et la
     * soirée s'est diagnostiquée à l'aveugle.
     */
    log: (level, message, connectorId = null) => require('./applog')[level](
      connectorId ? `remote-browser:${connectorId}` : 'remote-browser',
      message
    ),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  };
}

// ---------------------------------------------------------------------------
// Prérequis système
// ---------------------------------------------------------------------------

/** Le binaire est-il présent et exécutable quelque part dans le PATH ? */
function findBinary(runtime, name) {
  for (const dir of runtime.pathDirs()) {
    const candidate = nodePath.join(dir, name);
    try {
      runtime.fs.accessSync(candidate, nodeFs.constants.X_OK);
      return candidate;
    } catch {
      /* pas ici */
    }
  }
  return null;
}

/** Répertoire du client noVNC, reconnu à la présence de son cœur. */
function findNovnc(runtime) {
  for (const dir of runtime.novncDirs()) {
    try {
      if (runtime.fs.existsSync(nodePath.join(dir, 'core', 'rfb.js'))) return dir;
    } catch {
      /* chemin illisible */
    }
  }
  return null;
}

/** Playwright est-il réellement installable en mémoire ? */
function findPlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ce qui manque pour ouvrir un navigateur distant, et comment y remédier.
 *
 * Appelé au démarrage du service ET à chaque affichage de fiche de connecteur :
 * c'est cette réponse qui grise le bouton « Se connecter » avec une
 * explication, plutôt que de le laisser échouer sans dire pourquoi.
 *
 * @param {object} [runtime]
 * @returns {{ok: boolean, missing: Array<object>, memory: object, novncDir: string|null,
 *            playwright: boolean, reason: string|null}}
 */
function checkPrerequisites(runtime = defaultRuntime()) {
  const missing = [];

  const binaries = {};
  for (const { bin, paquet, role } of BINAIRES) {
    const found = findBinary(runtime, bin);
    binaries[bin] = found;
    if (!found) {
      missing.push({
        id: bin,
        label: bin,
        detail: `${bin} assure ${role}.`,
        remedy: `apt install ${paquet}`,
      });
    }
  }

  const novncDir = findNovnc(runtime);
  if (!novncDir) {
    missing.push({
      id: 'novnc',
      label: 'noVNC',
      detail: 'noVNC est le client qui affiche le navigateur dans votre onglet.',
      remedy: 'apt install novnc',
    });
  }

  const playwright = findPlaywright();
  if (!playwright) {
    missing.push({
      id: 'playwright',
      label: 'Playwright',
      detail: 'Playwright pilote le navigateur qui s\'ouvre sur le portail.',
      remedy: 'npm install playwright && npx playwright install chromium',
    });
  }

  const memory = memorySnapshot(runtime);
  if (memory.totalMb < MEMOIRE_TOTALE_MINIMALE_MO) {
    missing.push({
      id: 'memoire',
      label: 'Mémoire',
      detail:
        `Le conteneur dispose de ${memory.totalMb} Mo au total : Chromium et Xvfb en `
        + 'demandent près de 1 Go à eux deux.',
      remedy: 'Porter la mémoire du conteneur à 4 Go (pct set 710 -memory 4096).',
    });
  }

  return {
    ok: missing.length === 0,
    missing,
    memory,
    novncDir,
    playwright,
    binaries,
    reason: missing.length ? describeMissing(missing) : null,
  };
}

/** Phrase affichée sous un bouton grisé : ce qui manque, et quoi faire. */
function describeMissing(missing) {
  const noms = missing.map((m) => m.label).join(', ');
  return (
    `Connexion par navigateur indisponible — il manque : ${noms}. `
    + 'Vous pouvez continuer avec un fichier de session.'
  );
}

/** Mémoire du conteneur, en mégaoctets. */
function memorySnapshot(runtime) {
  const toMb = (bytes) => Math.round(bytes / (1024 * 1024));
  const totalMb = toMb(runtime.os.totalmem());
  const freeMb = toMb(runtime.os.freemem());
  return { totalMb, freeMb, enough: freeMb >= MEMOIRE_LIBRE_MINIMALE_MO };
}

// ---------------------------------------------------------------------------
// Affichages
// ---------------------------------------------------------------------------

const vncPortFor = (display) => VNC_PORT_BASE + display;
const wsPortFor = (display) => WS_PORT_BASE + (display - DISPLAY_MIN);

/**
 * Le gestionnaire proprement dit.
 *
 * Une instance par processus (voir le singleton en bas de fichier), mais la
 * fabrique reste exportée : chaque test peut avoir la sienne, avec son propre
 * runtime simulé, sans interférer avec les autres.
 */
function createManager(overrides = {}) {
  const runtime = { ...defaultRuntime(), ...overrides };
  const timeoutMs = overrides.timeoutMs || SESSION_TIMEOUT_MS;
  const pollMs = overrides.pollMs || POLL_MS;
  // Réglable par les tests : attendre deux vraies secondes pour voir un
  // SIGKILL rendrait la preuve du second rideau interminable.
  const escalationMs = overrides.escalationMs || KILL_ESCALATION_MS;
  // Même raison : la preuve du navigateur qui refuse de se fermer se joue en
  // millisecondes simulées, pas en huit vraies secondes.
  const closeTimeoutMs = overrides.closeTimeoutMs || BROWSER_CLOSE_TIMEOUT_MS;

  /** Affichages pris par CE processus. */
  const reserved = new Set();
  /** La session en cours, ou null. C'est le verrou d'unicité. */
  let current = null;
  /** La dernière session terminée, gardée le temps que le client la relise. */
  let finished = null;

  // -------------------------------------------------------------------------
  // Allocation d'affichage
  // -------------------------------------------------------------------------

  /**
   * Un affichage est libre si crabe ne l'a pas déjà pris ET si le serveur X
   * n'a pas laissé sa socket derrière lui.
   */
  function isDisplayFree(display) {
    if (reserved.has(display)) return false;
    try {
      return !runtime.fs.existsSync(nodePath.join(runtime.x11SocketDir(), `X${display}`));
    } catch {
      // Répertoire absent : aucun serveur X n'a jamais tourné, tout est libre.
      return true;
    }
  }

  /**
   * Réserve le premier affichage libre de la plage.
   * @returns {number}
   * @throws {Error} si les dix sont pris — le signe qu'un nettoyage a échoué
   */
  function allocateDisplay() {
    for (let display = DISPLAY_MIN; display <= DISPLAY_MAX; display++) {
      if (!isDisplayFree(display)) continue;
      reserved.add(display);
      return display;
    }
    const err = new Error(
      `Aucun affichage libre entre :${DISPLAY_MIN} et :${DISPLAY_MAX} — des processus `
        + 'Xvfb ont survécu à une session précédente. Redémarrez le service crabe.'
    );
    err.statusCode = 503;
    err.expose = true;
    throw err;
  }

  /** Rend l'affichage et efface les fichiers que le serveur X a laissés. */
  function releaseDisplay(display) {
    reserved.delete(display);
    for (const file of [
      nodePath.join(runtime.x11SocketDir(), `X${display}`),
      `/tmp/.X${display}-lock`,
    ]) {
      try {
        runtime.fs.rmSync(file, { force: true });
      } catch {
        /* déjà parti, ou pas à nous : sans conséquence */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Nettoyage des orphelins
  // -------------------------------------------------------------------------

  /**
   * Tue les Xvfb, x11vnc et websockify laissés par une session interrompue.
   *
   * Appelé au démarrage du service. Sans lui, un crabe redémarré pendant une
   * connexion laisse un Chromium authentifié tourner indéfiniment sur un
   * affichage que plus personne ne surveille — et le prochain « Se
   * connecter » échoue faute d'affichage libre.
   *
   * La reconnaissance est volontairement stricte : on ne tue QUE des processus
   * dont le nom est l'un des trois attendus ET dont la ligne de commande porte
   * un numéro d'affichage ou un port de la plage réservée à crabe. Un x11vnc
   * lancé par quelqu'un d'autre sur :0 n'est jamais touché.
   *
   * @returns {{killed: Array<object>, displays: number[], errors: string[]}}
   */
  function cleanupOrphans() {
    const killed = [];
    const errors = [];
    const displays = new Set();

    let pids;
    try {
      pids = runtime.fs.readdirSync(runtime.procDir()).filter((n) => /^\d+$/.test(n));
    } catch {
      // Pas de /proc (macOS, test sans double) : rien à nettoyer, et surtout
      // pas de quoi empêcher le service de démarrer.
      return { killed: [], displays: [], errors: [] };
    }

    for (const pid of pids) {
      let argv;
      try {
        argv = String(runtime.fs.readFileSync(nodePath.join(runtime.procDir(), pid, 'cmdline')))
          .split('\0')
          .filter(Boolean);
      } catch {
        continue; // processus disparu entre le listing et la lecture
      }
      if (!argv.length) continue;

      const nom = nodePath.basename(argv[0]);
      let claim = orphanDisplay(nom, argv);
      // Chromium ne dit pas son affichage dans sa ligne de commande : c'est la
      // variable DISPLAY de son environnement qui le porte (lot 48). Le soir
      // du 22/08/2026, des Chromium survivants ont dû être tués à la main —
      // le nettoyage au démarrage ne les reconnaissait pas.
      if (claim === null && MOTIF_NOM_CHROMIUM.test(nom)) {
        claim = displayDeLEnviron(pid);
      }
      if (claim === null) continue;

      displays.add(claim);
      try {
        runtime.kill(Number(pid), 'SIGTERM');
        killed.push({ pid: Number(pid), name: nom, display: claim });
      } catch (err) {
        // ESRCH : il vient de mourir tout seul, tant mieux.
        if (err.code !== 'ESRCH') errors.push(`${nom} (pid ${pid}) : ${err.message}`);
      }
    }

    for (const display of displays) releaseDisplay(display);

    if (killed.length) {
      runtime.log(
        'warn',
        `Nettoyage au démarrage : ${killed.length} processus orphelin(s) de session de connexion `
          + `arrêté(s) — ${killed.map((k) => `${k.name}(:${k.display})`).join(', ')}.`
      );
      // Second rideau, comme à l'extinction d'une session (lot 35) : un
      // orphelin qui ignore SIGTERM garderait son port, et le premier
      // « Se connecter » du service fraîchement redémarré le retrouverait.
      const rideau = setTimeout(() => {
        for (const k of killed) {
          try {
            if (!runtime.fs.existsSync(nodePath.join(runtime.procDir(), String(k.pid)))) continue;
            runtime.kill(k.pid, 'SIGKILL');
            runtime.log('warn', `Orphelin ${k.name} (pid ${k.pid}) : SIGTERM ignoré — SIGKILL envoyé.`);
          } catch {
            /* mort entre-temps : tant mieux */
          }
        }
      }, escalationMs);
      rideau.unref?.();
    }
    for (const message of errors) runtime.log('warn', `Orphelin non arrêté — ${message}`);

    return { killed, displays: [...displays].sort((a, b) => a - b), errors };
  }

  /**
   * Ce processus est-il l'un des nôtres, et sur quel affichage ?
   * @returns {number|null} le numéro d'affichage, ou null si ce n'est pas à nous
   */
  function orphanDisplay(nom, argv) {
    const ligne = argv.join(' ');

    if (nom === 'Xvfb') {
      return displayInRange(/(?:^|\s):(\d+)\b/.exec(ligne)?.[1]);
    }
    if (nom === 'x11vnc') {
      return (
        displayInRange(/-display\s+:(\d+)/.exec(ligne)?.[1])
        ?? portInRange(/-rfbport\s+(\d+)/.exec(ligne)?.[1], VNC_PORT_BASE + DISPLAY_MIN, VNC_PORT_BASE + DISPLAY_MAX, VNC_PORT_BASE)
      );
    }
    if (nom === 'websockify' || (nom === 'python3' && /websockify/.test(ligne))) {
      // websockify 127.0.0.1:6180 127.0.0.1:5999 — le port d'écoute suffit.
      const port = /127\.0\.0\.1:(\d+)/.exec(ligne)?.[1];
      const fromWs = portInRange(port, WS_PORT_BASE, WS_PORT_BASE + (DISPLAY_MAX - DISPLAY_MIN), WS_PORT_BASE - DISPLAY_MIN);
      if (fromWs !== null) return fromWs;
      return portInRange(port, VNC_PORT_BASE + DISPLAY_MIN, VNC_PORT_BASE + DISPLAY_MAX, VNC_PORT_BASE);
    }
    return null;
  }

  /**
   * L'affichage d'un processus, lu dans son environnement.
   *
   * Réservé aux Chromium : eux seuls ne portent pas leur affichage en argument.
   * `environ` n'est lisible que pour les processus du même utilisateur — ceux
   * de crabe, précisément ceux qu'on cherche. Un environnement illisible rend
   * null : on ne tue jamais sur un doute.
   */
  function displayDeLEnviron(pid) {
    try {
      const environ = String(
        runtime.fs.readFileSync(nodePath.join(runtime.procDir(), String(pid), 'environ'))
      ).split('\0');
      for (const variable of environ) {
        const m = /^DISPLAY=:(\d+)/.exec(variable);
        if (m) return displayInRange(m[1]);
      }
    } catch {
      /* processus disparu, ou environnement d'un autre utilisateur */
    }
    return null;
  }

  /**
   * SIGKILL de ce qui reste de Chromium sur UN affichage de crabe (lot 48).
   *
   * Appelé quand `browser.close()` n'a pas rendu la main dans les temps : le
   * navigateur ne s'éteindra pas poliment, et le laisser courir garderait le
   * profil verrouillé — c'est exactement ce qui a forcé les kills à la main
   * du 22/08/2026. La reconnaissance est stricte : un nom de Chromium ET la
   * variable DISPLAY de l'affichage demandé. Un navigateur d'un autre écran
   * n'est jamais touché.
   */
  function tuerChromiumsSurAffichage(display) {
    let pids = [];
    try {
      pids = runtime.fs.readdirSync(runtime.procDir()).filter((n) => /^\d+$/.test(n));
    } catch {
      return [];
    }
    const tues = [];
    for (const pid of pids) {
      try {
        const argv = String(
          runtime.fs.readFileSync(nodePath.join(runtime.procDir(), pid, 'cmdline'))
        ).split('\0').filter(Boolean);
        if (!argv.length || !MOTIF_NOM_CHROMIUM.test(nodePath.basename(argv[0]))) continue;
        if (displayDeLEnviron(pid) !== display) continue;
        runtime.kill(Number(pid), 'SIGKILL');
        tues.push(Number(pid));
      } catch {
        /* disparu entre le listing et le signal : c'est le but */
      }
    }
    if (tues.length) {
      runtime.log(
        'warn',
        `${tues.length} processus Chromium tué(s) de force sur l'affichage :${display} `
          + `(pid ${tues.join(', ')}).`
      );
    }
    return tues;
  }

  /** « 99 » → 99 si l'affichage est dans la plage de crabe, sinon null. */
  function displayInRange(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= DISPLAY_MIN && n <= DISPLAY_MAX ? n : null;
  }

  /** Un port de la plage réservée, ramené au numéro d'affichage. */
  function portInRange(raw, min, max, base) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n - base : null;
  }

  // -------------------------------------------------------------------------
  // Jetons
  // -------------------------------------------------------------------------

  /**
   * Un jeton neuf, à usage unique, pour attacher un flux à la session.
   *
   * À usage unique VRAIMENT : le relais le consomme et l'efface. Un client qui
   * perd sa connexion en redemande un — ce qu'il ne peut faire qu'en étant
   * authentifié comme le propriétaire de la session. Un jeton intercepté ne
   * vaut donc rien dès qu'il a servi, et rien du tout après l'extinction.
   */
  function mintTicket(session) {
    const token = runtime.randomBytes(32).toString('base64url');
    session.tickets.add(token);
    return token;
  }

  /**
   * Consomme un jeton et rend la session, si et seulement si elle appartient
   * bien à cet utilisateur.
   *
   * Le contrôle de propriété est ICI, côté serveur, et pas seulement dans
   * l'interface : un jeton deviné ou volé ne suffit pas, il faut être connecté
   * en tant que son propriétaire.
   *
   * @param {string} token
   * @param {number} userId
   * @returns {{ok: boolean, session: object|null, error: string|null}}
   */
  function consumeTicket(token, userId) {
    const session = current;
    if (!token || !session || !session.tickets.has(token)) {
      return { ok: false, session: null, error: 'Jeton de connexion inconnu ou déjà utilisé.' };
    }
    if (Number(session.userId) !== Number(userId)) {
      // Volontairement le même message : ne pas confirmer qu'un jeton existe.
      return { ok: false, session: null, error: 'Jeton de connexion inconnu ou déjà utilisé.' };
    }
    session.tickets.delete(token);
    session.attachments += 1;
    // Un flux est de retour : le sursis accordé au précédent n'a plus lieu d'être.
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    return { ok: true, session, error: null };
  }

  /**
   * Le flux d'affichage vient de se fermer.
   *
   * Onglet fermé, navigateur quitté, Wi-Fi coupé : de l'extérieur, ces trois
   * cas se ressemblent. On accorde donc une minute — le temps qu'un client
   * revenu se rebranche avec un jeton neuf — puis on éteint. Sans ce sursis,
   * un onglet fermé laisserait un Chromium authentifié tourner jusqu'au bout
   * des dix minutes.
   */
  function noteDetach(session) {
    if (!session || session !== current || session.stopped) return;
    session.attachments = Math.max(0, session.attachments - 1);
    if (session.attachments > 0 || session.graceTimer) return;

    session.graceTimer = setTimeout(() => {
      session.graceTimer = null;
      if (session !== current || session.stopped || session.attachments > 0) return;
      terminate(
        session,
        'cancelled',
        'Fenêtre fermée — le navigateur a été arrêté et rien n\'a été enregistré.'
      );
    }, DETACH_GRACE_MS);
    session.graceTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Processus
  // -------------------------------------------------------------------------

  /** Lance un processus enfant et le range dans la session pour l'extinction. */
  function launch(session, name, command, args, options = {}) {
    const child = runtime.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    session.processes.push({ name, child });

    // Les sorties des trois auxiliaires ne vont NULLE PART : websockify
    // journalise l'URL de chaque connexion, et x11vnc son argumentaire
    // complet — mot de passe compris sur certaines versions. On les lit pour
    // ne pas remplir le tampon du tube, et on les jette.
    child.stdout?.resume?.();
    child.stderr?.resume?.();

    child.on?.('error', (err) => {
      session.processErrors.push(`${name} : ${err.message}`);
    });
    return child;
  }

  /** Attend que le serveur X ait posé sa socket — sinon Chromium ne trouve rien. */
  async function waitForDisplay(display) {
    const socket = nodePath.join(runtime.x11SocketDir(), `X${display}`);
    const limite = runtime.now() + XVFB_READY_TIMEOUT_MS;
    for (;;) {
      try {
        if (runtime.fs.existsSync(socket)) return true;
      } catch {
        /* répertoire absent : on réessaie */
      }
      if (runtime.now() >= limite) return false;
      await runtime.sleep(200);
    }
  }

  /**
   * Répertoire personnel du navigateur, créé s'il manque.
   *
   * Appelé au démarrage du service ET juste avant chaque lancement : un
   * répertoire effacé entre deux (nettoyage de disque, restauration de
   * sauvegarde) ne doit pas casser la connexion suivante.
   *
   * Lève une erreur d'exploitation LISIBLE plutôt que de laisser Chromium
   * mourir sur un `SIGTRAP` — c'est exactement ce qui rendait le lot 6
   * inutilisable en production sans qu'on puisse le voir dans les journaux.
   *
   * @returns {string} le chemin, existant et accessible en écriture
   */
  function ensureBrowserHome() {
    const dir = runtime.browserHomeDir?.() ?? nodePath.join(runtime.runDir(), BROWSER_HOME_DIRNAME);
    try {
      runtime.fs.mkdirSync(dir, { recursive: true });
      runtime.fs.accessSync(dir, nodeFs.constants.W_OK);
    } catch (err) {
      throw fail(
        `Le dossier de travail du navigateur (${dir}) n'est pas accessible en écriture `
          + `(${err.code || err.message}). Vérifiez que ce chemin appartient à l'utilisateur `
          + 'crabe et qu\'il figure en ReadWritePaths dans l\'unité systemd.',
        503
      );
    }
    return dir;
  }

  /** Fichier de mot de passe VNC, en 0600, hors de tout journal. */
  function writeVncPassword(session) {
    const file = nodePath.join(runtime.runDir(), `.vnc-${session.id}`);
    runtime.fs.writeFileSync(file, `${session.vncPassword}\n`, { mode: 0o600 });
    session.vncPasswordFile = file;
    return file;
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  /**
   * Ouvre une session de connexion par navigateur distant.
   *
   * @param {object} options
   * @param {number} options.userId          propriétaire — seul lui pourra s'y attacher
   * @param {string} options.connectorId
   * @param {string} options.connectorName   affiché à l'écran
   * @param {string} options.url             page de connexion du fournisseur
   * @param {string} [options.marker]        texte présent une fois connecté
   * @param {string} [options.hint]          conseil affiché sous le navigateur
   * @param {string} [options.identifiant]   pré-rempli dans le formulaire du
   *        site à l'ouverture. **Jamais un mot de passe** : voir
   *        `login-detection.preremplirIdentifiant`.
   * @param {(state: object) => Promise<object>} options.onDetected
   *        appelé avec l'état de session capturé ; c'est lui qui le chiffre et
   *        l'enregistre. Ce qu'il renvoie est remonté au client tel quel.
   * @returns {Promise<object>} vue publique de la session, jeton compris
   */
  async function start({
    userId,
    connectorId,
    connectorName = connectorId,
    url,
    marker = '',
    hint = '',
    identifiant = '',
    // §6 du lot 14 : la page à ESSAYER avec la session capturée avant de
    // l'enregistrer. Déclarée par le manifeste (`remoteLogin.verifyUrl`).
    // Depuis le lot 37, le contrôle est strict pour tout le monde : l'option
    // `verifyStrict` n'existe plus.
    verifyUrl = '',
    // Lot 40 — sur la page d'essai, RESTER est la preuve. Pour les sites
    // sans marqueur générique de compte mais qui redirigent les anonymes
    // hors de la page de contrôle (`remoteLogin.verifyUrlTient`).
    verifyUrlTient = false,
    // Lot 32 — les adresses du site qui ne prouvent RIEN : vérification
    // anti-robot, page d'attente. Sur elles, la détection dit « en cours » au
    // lieu de conclure (`remoteLogin.attendreUrls`, fragments de chemin).
    attendreUrls = [],
    // Lot 21 — les domaines dont la session vaut la peine d'être gardée
    // (`remoteLogin.keepDomains`). Vide = tout est conservé, comme avant ce lot.
    keepDomains = [],
    // Les identifiants enregistrés, saisis dans le formulaire du site sur
    // demande explicite (§7.3a). Le mot de passe ne sort JAMAIS d'ici : ni
    // dans une réponse HTTP, ni dans un journal, ni dans un diagnostic.
    identifiants = null,
    // Profil PERSISTANT plutôt que session capturée. Déclaré par le manifeste
    // (`remoteLogin.persistent`) pour les sites dont la protection juge le
    // NAVIGATEUR et pas seulement les cookies — Cloudflare en tête. Voir
    // `persistentLauncher`.
    persistent = false,
    // Lot 48 — la preuve de session se lit dans la FENÊTRE visible, jamais
    // dans un contrôle headless (`remoteLogin.preuveSurFenetre`). Pour les
    // sites dont la garde anti-robot juge le navigateur : Boulanger (Akamai)
    // rendait 404 à tout contrôle headless, cookies de session compris —
    // mesuré le 22/08/2026. Voir `essayerSurLaFenetre`.
    preuveSurFenetre = false,
    // Lot 49 — les marqueurs MESURÉS du service, lus sur le DOM déjà affiché
    // (`remoteLogin.marqueursFenetre`) : l'adresse de contrôle a tenu ET l'un
    // d'eux est dans la page, sans aucune requête supplémentaire. Pour les
    // sites dont la garde peut refuser la seconde requête pendant que la
    // fenêtre affiche la page (Darty, 403 DataDome — mesuré le 23/08/2026).
    marqueursFenetre = [],
    // Lot 68 — le renvoi des anonymes, MESURÉ (`remoteLogin.renvoiAnonyme`).
    // Les applications modernes n'ont pas de lien de déconnexion dans leur
    // page, et peuvent réécrire l'adresse demandée (claude.ai ramène
    // `/settings/billing` vers `/new#settings/billing` — mesuré le
    // 28/08/2026, trois refus d'une session pourtant valide). Quand le
    // manifeste atteste que le site renvoie tout anonyme vers son formulaire
    // de connexion (valeur « connexion »), NE PAS y être renvoyé, en restant
    // sur le site, est la preuve — le principe du lot 67 (Free Mobile),
    // rendu déclaratif.
    renvoiAnonyme = '',
    // Lot 34 — fenêtre SANS capture. L'autorisation OAuth d'une destination
    // n'a rien à photographier : la conclusion vient d'un processus extérieur
    // (`rclone authorize` rend son jeton, ou meurt), jamais de l'écran. La
    // fenêtre n'est alors qu'une vitre : pas de détection, pas de sonde, pas
    // de `save()` — et surtout pas de session du FOURNISSEUR enregistrée :
    // l'utilisateur se connecte chez Google ou pCloud dans cette fenêtre, et
    // cette session-là ne regarde pas crabe. Celui qui a ouvert la fenêtre la
    // conclut par `conclure()`.
    capture = true,
    // Prévenu à la toute fin, quel que soit le chemin de sortie (succès,
    // annulation, délai, onglet fermé, arrêt du service). C'est ce qui permet
    // à l'autorisation de TUER son processus rclone plutôt que de le laisser
    // garder le port 53682 ouvert.
    onFin = null,
    onDetected = async () => ({}),
  }) {
    if (current) {
      const err = new Error(
        current.userId === userId
          ? 'Une connexion par navigateur est déjà ouverte pour votre compte — terminez-la ou annulez-la.'
          : 'Une autre connexion par navigateur est en cours sur ce serveur. '
            + 'Un seul navigateur peut tourner à la fois : réessayez dans quelques minutes.'
      );
      err.statusCode = 409;
      err.expose = true;
      throw err;
    }

    const prerequisites = checkPrerequisites(runtime);
    if (!prerequisites.ok) {
      const err = new Error(prerequisites.reason);
      err.statusCode = 503;
      err.expose = true;
      err.missing = prerequisites.missing;
      throw err;
    }

    // La mémoire se juge à l'instant du lancement, pas au démarrage du
    // service : un Chromium qui meurt à mi-parcours ne dit jamais pourquoi.
    const memory = memorySnapshot(runtime);
    if (!memory.enough) {
      const err = new Error(
        `Mémoire insuffisante pour ouvrir un navigateur : ${memory.freeMb} Mo libres sur `
          + `${memory.totalMb} Mo, il en faut au moins ${MEMOIRE_LIBRE_MINIMALE_MO}. `
          + 'Attendez la fin des récupérations en cours, ou utilisez un fichier de session.'
      );
      err.statusCode = 503;
      err.expose = true;
      throw err;
    }

    // Le profil persistant est peut-être DÉJÀ OUVERT par une récupération en
    // cours (elles partagent la même connexion enregistrée). Refuser ICI,
    // avant d'allouer quoi que ce soit, avec une phrase qui dit quoi attendre
    // — jamais le message brut de Chromium sur son profil.
    const verrouProfil = persistent ? inflight.profilKey(userId, connectorId) : null;
    if (verrouProfil) {
      inflight.profil.acquire(
        verrouProfil,
        inflight.PORTEUR_FENETRE,
        `Une récupération ${connectorName} est en cours sur ce serveur : elle utilise la même `
          + 'connexion enregistrée. Attendez qu\'elle se termine — quelques minutes — puis réessayez.',
        {
          // La fenêtre vit le temps d'un geste humain, qui ne se borne pas au
          // chronomètre (mesuré le 23/08/2026 : plus de vingt minutes sur un
          // mot de passe) : passé le sursis, le verrou ne se reprend que si
          // le Chromium du profil est MORT — y compris tué au `kill`, le
          // `SingletonLock` restant avec un PID mort.
          preuveDeVie: () => profilPersistant.navigateurVivant(
            profilPersistant.chemin(userId, connectorId)
          ),
        }
      );
    }

    let display;
    try {
      display = allocateDisplay();
    } catch (err) {
      // Le verrou vient d'être pris et `terminate` ne le rendra jamais : pas
      // de session. Rendu ici, sans quoi le profil resterait bloqué 15 minutes.
      if (verrouProfil) inflight.profil.release(verrouProfil);
      throw err;
    }
    const session = {
      id: runtime.randomBytes(9).toString('base64url'),
      userId,
      connectorId,
      connectorName,
      persistent,
      // Calculé ici, une fois : le lanceur et le connecteur doivent viser
      // EXACTEMENT le même répertoire, sans quoi la session ouverte à la main
      // ne servirait à rien.
      profil: persistent ? profilPersistant.chemin(userId, connectorId) : null,
      // La clé du verrou de profil pris ci-dessus, rendue par `terminate` —
      // le point de sortie unique, quel que soit le chemin (succès, délai,
      // annulation, erreur de lancement).
      verrouProfil,
      url,
      marker,
      hint,
      // Un identifiant, jamais un mot de passe. Il ne sort de cet objet que
      // pour être frappé dans le formulaire du site (voir `preparerPage`).
      identifiant: String(identifiant || ''),
      verifyUrl: String(verifyUrl || ''),
      verifyUrlTient: !!verifyUrlTient,
      preuveSurFenetre: !!preuveSurFenetre,
      marqueursFenetre: Array.isArray(marqueursFenetre)
        ? marqueursFenetre.filter((m) => m && (m.selecteur || m.texte))
        : [],
      // Lot 68 — seule la valeur mesurée « connexion » est comprise ; tout le
      // reste vaut « rien de déclaré », comme pour les autres options.
      renvoiAnonyme: renvoiAnonyme === 'connexion' ? 'connexion' : '',
      // Vérifications de session restées sans preuve (lot 48) : au troisième
      // échec, l'écran propose explicitement de renoncer.
      echecsVerification: 0,
      verdictCode: null,
      attendreUrls: Array.isArray(attendreUrls) ? attendreUrls.map(String) : [],
      keepDomains: Array.isArray(keepDomains) ? keepDomains.map(String) : [],
      // ⚠ Le seul endroit de crabe où un mot de passe déchiffré séjourne en
      // mémoire hors d'un connecteur. Il n'est lu que par `saisirIdentifiants`,
      // n'apparaît dans AUCUNE vue publique (voir `publicView`), et disparaît
      // avec la session.
      identifiants: identifiants && identifiants.motDePasse
        ? { identifiant: String(identifiants.identifiant || ''), motDePasse: String(identifiants.motDePasse) }
        : null,
      capture: capture !== false,
      onFin: typeof onFin === 'function' ? onFin : null,
      display,
      vncPort: vncPortFor(display),
      wsPort: wsPortFor(display),
      vncPassword: runtime.randomBytes(12).toString('base64url').slice(0, 16),
      vncPasswordFile: null,
      tickets: new Set(),
      attachments: 0,
      processes: [],
      processErrors: [],
      browser: null,
      state: 'starting',
      message: 'Préparation du navigateur…',
      detail: '',
      result: null,
      error: null,
      startedAt: runtime.now(),
      expiresAt: runtime.now() + timeoutMs,
      memory,
      onDetected,
      timer: null,
      graceTimer: null,
      watching: false,
    };
    current = session;
    finished = null;

    try {
      await bringUp(session);
    } catch (err) {
      await terminate(session, 'error', err.message);
      throw err;
    }

    // Le compte à rebours démarre APRÈS le lancement : les quelques secondes
    // de mise en route ne doivent pas être prises sur le temps de l'utilisateur.
    session.expiresAt = runtime.now() + timeoutMs;
    session.timer = setTimeout(() => {
      terminate(session, 'timeout', 'Délai de dix minutes dépassé — le navigateur a été fermé.');
    }, timeoutMs);
    session.timer.unref?.();

    watch(session).catch((err) => {
      terminate(session, 'error', err.message);
    });

    runtime.log(
      'info',
      `Session de connexion ouverte pour ${connectorName} (compte ${userId}) sur l'affichage `
        + `:${display} — ${memory.freeMb} Mo libres sur ${memory.totalMb}.`,
      connectorId
    );

    return { ...publicView(session), token: mintTicket(session) };
  }

  /** Lance Xvfb, x11vnc, websockify, puis le navigateur. Dans cet ordre. */
  async function bringUp(session) {
    const { display } = session;

    launch(session, 'Xvfb', 'Xvfb', [
      `:${display}`,
      '-screen', '0', `${SCREEN.width}x${SCREEN.height}x${SCREEN.depth}`,
      // Aucun port TCP : le serveur X n'est joignable que par sa socket Unix.
      '-nolisten', 'tcp',
      '-noreset',
    ]);

    if (!(await waitForDisplay(display))) {
      throw fail(
        `Le serveur d'affichage n'a pas démarré sur :${display} en `
          + `${XVFB_READY_TIMEOUT_MS / 1000} secondes`
          + (session.processErrors.length ? ` (${session.processErrors.join(' ; ')})` : '')
          + '. Vérifiez que le paquet xvfb est installé.'
      );
    }

    writeVncPassword(session);
    launch(session, 'x11vnc', 'x11vnc', [
      '-display', `:${display}`,
      '-rfbport', String(session.vncPort),
      // Deux façons de dire la même chose, et c'est volontaire : cette socket
      // ne doit JAMAIS être joignable depuis le réseau.
      '-localhost',
      '-listen', '127.0.0.1',
      // Mot de passe tiré au hasard pour cette session : il ne protège pas de
      // grand-chose face à crabe lui-même, mais il ferme la porte à tout autre
      // processus du conteneur qui viendrait frapper sur 127.0.0.1.
      '-passwdfile', session.vncPasswordFile,
      // Survit à la déconnexion du client : un flux qui tombe ne doit pas
      // emporter la session de connexion en cours.
      '-forever',
      // Le contrôle d'accès est celui de crabe (jeton à usage unique), pas
      // celui de x11vnc : sans « -shared », une reconnexion après une socket
      // à demi fermée serait refusée et l'utilisateur resterait bloqué.
      '-shared',
      '-noxdamage',
      '-quiet',
    ]);

    launch(session, 'websockify', 'websockify', [
      `127.0.0.1:${session.wsPort}`,
      `127.0.0.1:${session.vncPort}`,
    ]);

    session.browser = await openBrowser(session);
    session.state = 'running';
    session.message = 'Connectez-vous dans la fenêtre ci-dessous.';
  }

  /** Ouvre Chromium sur l'affichage alloué, à la page de connexion. */
  async function openBrowser(session) {
    const launcher = runtime.launchBrowser || defaultLauncher;
    let browser;
    try {
      browser = await launcher({
        display: session.display,
        url: session.url,
        screen: SCREEN,
        // Sans un HOME inscriptible, Chromium visible meurt sur un SIGTRAP.
        // Voir BROWSER_HOME_DIRNAME, en tête de fichier.
        home: ensureBrowserHome(),
        // Non nul → `defaultLauncher` bascule sur `launchPersistentContext`.
        profil: session.profil || null,
      });
    } catch (err) {
      // Filet sous le verrou de profil : si un Chromium tient ENCORE le
      // profil (récupération qui ne prend pas le verrou, processus survivant),
      // Chromium meurt sur son « ProcessSingleton ». Ce message technique brut
      // ne doit jamais atteindre l'écran — mesuré le 19/08/2026 à 23:39.
      if (session.profil
        && /Singleton|already running|already in use|existing browser session/i.test(String(err?.message))) {
        throw fail(
          `Le navigateur enregistré de ${session.connectorName} est déjà ouvert sur ce serveur — `
            + 'probablement par une récupération en cours, qui utilise la même connexion. '
            + 'Attendez qu\'elle se termine — quelques minutes — puis réessayez.',
          409
        );
      }
      throw err;
    }
    if (!browser?.page) throw fail('Le navigateur n\'a pas pu être lancé.');
    return browser;
  }

  /**
   * Surveille la page jusqu'à la connexion, puis enregistre.
   *
   * L'écran d'attente est recadré à chaque changement de formulaire : les
   * portails à validation en deux temps enchaînent plusieurs écrans, et sans
   * ça la fenêtre s'ouvre sur la bannière plutôt que sur les champs.
   *
   * ─── La sonde sur changement d'adresse (lot 32) ──────────────────────────
   *
   * Chez Hetzner, l'authentification DÉPOSE l'utilisateur sur une page que la
   * détection ne peut pas juger connectée — et la fenêtre restait ouverte
   * jusqu'à ce qu'il aille lui-même sur la page des factures (constaté quatre
   * fois les 13–14/08/2026 : chaque cérémonie ne s'est conclue qu'une fois
   * `/invoice` atteinte à la main). Or crabe SAIT vérifier une session sans
   * rien demander à l'écran : c'est exactement ce que fait `essayerSession`
   * sur la page de contrôle du manifeste.
   *
   * Donc : à chaque fois que l'adresse de la fenêtre CHANGE alors que la
   * détection ne conclut pas, on essaie la session capturée sur `verifyUrl`,
   * en STRICT — seule une preuve positive (marqueur de compte connecté) vaut
   * enregistrement ; un essai muet ou impossible laisse la fenêtre ouverte,
   * il ne prouve rien. Une navigation est rare (un envoi de formulaire, une
   * redirection), la sonde ne coûte donc que quelques lancements headless par
   * connexion — et jamais pendant que l'utilisateur tape : taper ne change
   * pas l'adresse.
   */
  async function watch(session) {
    session.watching = true;
    const { page } = session.browser;
    let derniereSignature = '';
    let derniereUrl = null;
    let derniereUrlSondee = null;

    await preparerPage(session, page);

    // ─── Fenêtre sans capture (lot 34) ───────────────────────────────────────
    //
    // Rien à détecter, rien à photographier : la conclusion vient de
    // l'extérieur (`conclure()`), jamais de l'écran. On garde UNE seule
    // attention : recadrer le champ actif quand le formulaire change, pour que
    // la saisie parte au bon endroit — les pages d'autorisation enchaînent
    // identifiant, mot de passe, parfois un code. Aucune sonde, aucun
    // `save()` : la garde du lot 33 est respectée par construction, puisque
    // rien ici ne peut fermer la fenêtre.
    if (!session.capture) {
      while (session === current && session.state === 'running') {
        // L'indice de région (lot 34, pCloud) : la redirection de retour vers
        // le serveur local d'rclone porte `hostname=eapi.pcloud.com` pour un
        // compte européen — une information que le jeton imprimé ne porte pas
        // et que seule cette fenêtre voit passer. On ne retient QUE ce
        // paramètre : le reste de l'URL porte le code d'autorisation, qui ne
        // doit exister nulle part.
        try {
          const adresse = page.url();
          if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/\?/.test(adresse)) {
            const indice = new URL(adresse).searchParams.get('hostname');
            if (indice) session.indiceRegion = String(indice);
          }
        } catch {
          /* une page en cours de navigation n'a pas toujours d'URL lisible */
        }

        const signature = await detection.fieldSignature(page).catch(() => '');
        if (signature && signature !== derniereSignature) {
          derniereSignature = signature;
          await detection.focusForm(page).catch(() => {});
        }
        await runtime.sleep(pollMs);
      }
      return;
    }

    while (session === current && session.state === 'running') {
      // Un essai de session a déjà échoué : on n'en relance pas un tous les
      // 700 ms. L'utilisateur finit de se connecter et clique « Enregistrer »
      // — sans quoi on rouvrirait un Chromium en boucle pendant dix minutes.
      if (session.attenteManuelle) {
        await runtime.sleep(pollMs);
        continue;
      }

      const etat = await detection.confirm(page, {
        marker: session.marker,
        urlsEnCours: session.attendreUrls,
        pause: (ms) => runtime.sleep(ms),
      });

      if (etat.ok) return void (await save(session));

      // Le détail dit à l'utilisateur où il en est : « code de validation
      // attendu » vaut mieux qu'un compte à rebours muet.
      session.detail = etat.reason;

      // L'adresse a changé : le site vient de déposer l'utilisateur quelque
      // part. Si la session se prouve sur la page de contrôle, elle est
      // établie — inutile d'attendre un geste que le logiciel sait faire.
      // La première adresse vue (la page de connexion à l'ouverture) ne
      // déclenche rien : personne ne s'y est encore connecté.
      //
      // ─── Et rien avant la PREMIÈRE saisie (lot 38) ───────────────────────
      //
      // Mesuré le 18/08/2026 sur Spotify : la sonde s'est déclenchée ~24 s
      // après l'ouverture, AVANT le mot de passe — la page d'accueil du site
      // avait simplement fini de rediriger. La garde du lot 33 a tenu (la
      // fenêtre est restée ouverte), mais le déclenchement et son message
      // étaient le défaut : un changement d'adresse avant toute saisie est la
      // navigation initiale du site, pas une connexion. Le moteur sait
      // compter les saisies (`session.saisies`, le journal écrit « Texte
      // saisi… N caractère(s) ») : la sonde ne s'arme qu'après la première.
      if (
        etat.url
        && derniereUrl !== null
        && etat.url !== derniereUrl
        && etat.url !== derniereUrlSondee
        && session.verifyUrl
        && (session.saisies || 0) > 0
      ) {
        // ─── Jamais de sonde pendant qu'un écran attend une saisie (lot 33) ──
        //
        // Le 14/08/2026, la sonde a fermé la fenêtre Hetzner devant le champ du
        // code de validation : l'arrivée sur `/2fa` EST un changement
        // d'adresse, et la demi-session (mot de passe passé, code jamais
        // saisi) se prouvait sur la page de contrôle — `/2fa` porte un lien
        // logout. La règle vaut pour tout connecteur : ce que le site répond
        // AILLEURS ne dit rien de ce que l'utilisateur est en train de taper
        // ICI. Quelle que soit la réponse de la sonde, un écran de saisie
        // garde la fenêtre ouverte.
        const saisie = await detection.attendUneSaisie(page);
        if (session !== current || session.state !== 'running') return;
        if (saisie.attend) {
          runtime.log(
            'info',
            `Session ${session.connectorName} : l'adresse a changé mais ${saisie.motif} — `
              + 'pas de sonde, la fenêtre attend l\'utilisateur.',
            session.connectorId
          );
        } else {
          derniereUrlSondee = etat.url;
          const sonde = await sonderSession(session);
          if (session !== current || session.state !== 'running') return;
          if (sonde.ok) return void (await save(session));
          runtime.log(
            'info',
            `Session ${session.connectorName} : l'adresse a changé (${etat.reason}), essai de la `
              + `session sur la page de contrôle — pas encore établie (${sonde.raison}). `
              + 'La fenêtre reste ouverte.',
            session.connectorId
          );
        }
      }
      if (etat.url) derniereUrl = etat.url;

      const signature = await detection.fieldSignature(page);
      if (signature && signature !== derniereSignature) {
        derniereSignature = signature;
        await detection.focusForm(page);
      }

      await runtime.sleep(pollMs);
    }
  }

  /**
   * La session actuelle se prouve-t-elle, TELLE QUELLE, sur la page de
   * contrôle ? Capture l'état du navigateur visible et le rejoue en strict :
   * seul un marqueur de compte connecté conclut. Ne modifie rien — c'est
   * `save()` qui, sur un oui, refait le chemin complet et enregistre.
   */
  async function sonderSession(session) {
    try {
      // Les cookies tardifs (lot 12) : la redirection qui vient d'avoir lieu
      // peut encore en écrire pendant deux secondes et demie.
      await runtime.sleep(detection.DELAI_COOKIES_TARDIFS_MS);
      // Second regard sur l'écran APRÈS l'attente : au moment du changement
      // d'adresse, la page de validation peut ne pas avoir fini de se rendre —
      // ses champs n'existent pas encore, le premier contrôle de watch() passe
      // à vide. Deux secondes et demie plus tard, ils sont là. Sans ce second
      // regard, la course rejouerait la fermeture du 14/08/2026.
      const saisie = await detection.attendUneSaisie(session.browser.page);
      if (saisie.attend) {
        return { ok: false, raison: `${saisie.motif} — la fenêtre attend l'utilisateur` };
      }
      const capture = await session.browser.storageState();
      const tri = sessionState.limiterAuxDomaines(capture, session.keepDomains);
      if (!(tri.state.cookies || []).length) {
        return { ok: false, raison: 'aucun cookie à essayer' };
      }
      // SEULE une preuve positive conclut : sur un refus, un doute ou une
      // absence de contrôle, la sonde s'abstient — fermer la fenêtre serait
      // la fermer au nez d'un utilisateur pas encore connecté.
      const essai = await essayerSession(session, tri.state);
      if (essai.verdict === 'confirmee') return { ok: true, preuve: essai.preuve };
      return { ok: false, raison: essai.raison || 'la session ne se prouve pas encore' };
    } catch (err) {
      return { ok: false, raison: `sonde impossible (${err.message})` };
    }
  }

  /**
   * Ce qui est fait dans la fenêtre AVANT de rendre la main à l'utilisateur.
   *
   * Trois gestes, dans cet ordre, et chacun pour une raison précise :
   *
   *   1. **fermer le bandeau de cookies** — la fenêtre s'ouvrait souvent sur un
   *      voile qui cachait le formulaire, et l'utilisateur devait le fermer
   *      lui-même dans un navigateur distant peu réactif. C'est aussi ce qui
   *      empêchait les deux gestes suivants d'atteindre quoi que ce soit ;
   *   2. **pré-remplir l'identifiant** — §3 du lot 13 : quelqu'un qui l'a saisi
   *      dans crabe n'a pas à le retaper ici. Jamais de mot de passe ;
   *   3. **cadrer le formulaire** — seulement si le pré-remplissage n'a pas
   *      déjà placé le curseur, sinon on le déplacerait juste après l'avoir mis
   *      au bon endroit.
   *
   * Aucun des trois ne peut faire échouer l'ouverture : ce sont des conforts.
   */
  async function preparerPage(session, page) {
    await cookieBanner
      .fermer(page, {
        cible: 'input[type="password"], form, button',
        log: (message) => runtime.log('info', message, session.connectorId),
        prefixe: session.connectorName,
      })
      .catch(() => ({ ferme: false }));

    let prerempli = { rempli: false, motDePasseVise: false };
    if (session.identifiant) {
      prerempli = await detection
        .preremplirIdentifiant(page, session.identifiant, { delaiFrappeMs: DELAI_FRAPPE_MS })
        .catch(() => ({ rempli: false, motDePasseVise: false }));

      // L'identifiant lui-même n'est PAS journalisé : c'est une donnée
      // personnelle, et le fait qu'il ait été posé suffit au diagnostic.
      runtime.log(
        'info',
        prerempli.rempli
          ? `Identifiant pré-rempli dans le formulaire de ${session.connectorName}.`
          : `Aucun champ d'identifiant reconnu sur ${session.connectorName} : `
            + 'l\'utilisateur le saisira à la main.',
        session.connectorId
      );
    }

    if (!prerempli.motDePasseVise) await detection.focusForm(page);
  }

  /**
   * Récupère l'état de session, **l'essaie**, puis l'enregistre.
   *
   * ─── Pourquoi l'essai (lot 14, §6) ────────────────────────────────────────
   *
   * En production, le 11/08/2026 :
   *
   *     03:07:16  Session L'Atelier du Portable capturée — 8 cookie(s).
   *     03:07:19  Votre connexion à L'Atelier du Portable a expiré.
   *
   * Trois secondes. La session enregistrée n'était pas valide **au moment où
   * elle a été enregistrée** — même défaut que les 12 cookies au lieu de 15 du
   * lot 12, mais que la pause `DELAI_COOKIES_TARDIFS_MS` ne suffit pas à
   * couvrir : ici, le parcours de connexion n'était tout simplement pas fini.
   *
   * On ne peut pas le savoir en regardant la page : `detection.confirm` juge
   * ce qui est à l'écran, et un connecteur dont le manifeste ne déclare pas de
   * marqueur (`marker: ""`, le cas de L'Atelier du Portable) se contente de
   * « aucun écran d'authentification visible ». La seule preuve qui vaille est
   * d'ALLER VOIR : rejouer les cookies capturés sur la page des commandes, et
   * y chercher un marqueur de compte.
   *
   * Si l'essai échoue, **on n'enregistre pas** et la fenêtre reste ouverte : à
   * l'utilisateur de finir de se connecter. Un « votre connexion a expiré »
   * dans les secondes qui suivent une capture est le pire compte rendu
   * possible — il accuse le site alors que rien n'a été capturé de valide.
   */
  async function save(session, { manuel = false } = {}) {
    session.state = 'saving';
    session.message = 'Vérification de la connexion…';
    session.detail = '';

    try {
      // Laisse les cookies de fin de parcours s'écrire avant la photo.
      // 700 ms jusqu'au lot 12, où l'exploration des boutiques a montré qu'une
      // photo trop rapide perd des cookies posés juste après la redirection —
      // 12 au lieu de 15, puis 403 au téléchargement, sans rien pour le dire.
      // Pas de rechargement ici, contrairement à l'outil en ligne de commande :
      // la page affichée appartient à l'utilisateur, qui la regarde.
      await runtime.sleep(detection.DELAI_COOKIES_TARDIFS_MS);
      const capture = await session.browser.storageState();

      // Lot 21 — on ne garde que les domaines du service, quand le connecteur
      // les déclare. Les premiers services à passer par « Se connecter avec
      // Google » arrivent ici : sans ce tri, la photo emporterait la session
      // Google de l'utilisateur, dont crabe n'a aucun usage. Le tri a lieu
      // AVANT l'essai ci-dessous, pour que ce qui est vérifié soit exactement
      // ce qui sera enregistré — sinon on validerait un état, et on en
      // stockerait un autre.
      const tri = sessionState.limiterAuxDomaines(capture, session.keepDomains);
      const state = tri.state;
      if (tri.retires) {
        runtime.log(
          'info',
          `Session ${session.connectorName} : ${tri.gardes} cookie(s) conservé(s), `
            + `${tri.retires} écarté(s) — hors des domaines déclarés par le connecteur.`,
          session.connectorId
        );
      }

      const essai = await essayerSession(session, state, { naviguer: manuel });
      // La fenêtre a pu être FERMÉE pendant l'essai — abandon de l'utilisateur,
      // arrêt du service (lot 48). Plus rien à enregistrer, et surtout pas un
      // état terminal à écraser : `terminate` a déjà dit le sien.
      if (session.stopped) return;
      // Hotfix 18/08/2026 (soir) — « sans-controle » ne vaut plus acceptation
      // silencieuse. À 20:18, une session SNCF Connect de 12 cookies anonymes
      // a été « capturée » 5 secondes après l'ouverture : marqueur vide dans
      // le manifeste (la détection concluait sur n'importe quelle page sans
      // champ mot de passe), pas de page de contrôle, et cette porte laissait
      // passer. Sans contrôle possible, seule la parole de l'utilisateur
      // (« Enregistrer ») vaut : c'est lui qui affirme avoir fini.
      const sansControleAccepte = essai.verdict === 'sans-controle' && manuel;
      if (essai.verdict !== 'confirmee' && !sansControleAccepte) {
        // On REVIENT à l'état « running » : la fenêtre reste ouverte, le flux
        // continue, et l'utilisateur voit la consigne sous la fenêtre.
        //
        // Chaque verdict a son message, et chaque message dit QUOI FAIRE
        // (lot 48) : le soir du 22/08/2026, « la page de contrôle n'existe pas
        // (404) » invitait à recliquer « Enregistrer » — un conseil qui ne
        // pouvait mener qu'au même refus, quatre fois de suite sur Boulanger.
        // Une adresse morte n'est pas un parcours inachevé : elle se signale,
        // elle ne se réessaie pas.
        session.state = 'running';
        session.echecsVerification = (session.echecsVerification || 0) + 1;
        session.verdictCode = essai.code || essai.verdict;
        if (essai.code === 'sans-preuve') {
          // ⚠ Pas « votre session a expiré », pas « finissez de vous
          // connecter » : dans ce cas précis la connexion a pu parfaitement
          // aboutir — c'est crabe qui ne sait pas le prouver sur ce site
          // (Anthropic, 28/08/2026 : trois refus d'une session valide). Dire
          // « expiré » enverrait se reconnecter en boucle — le piège corrigé
          // pour Darty au lot 51. La phrase distingue honnêtement les deux
          // situations possibles, et dit quoi faire dans chacune.
          session.message =
            'La page ne montre rien qui permette de vérifier votre connexion.';
          session.detail =
            'Si le site affiche bien votre compte dans la fenêtre, ce n\'est pas un problème '
            + 'd\'identifiants : crabe ne sait pas encore vérifier la connexion sur ce site — '
            + 'signalez-le à la personne qui administre crabe. Sinon, finissez de vous '
            + 'connecter, puis cliquez sur Enregistrer.';
        } else if (essai.verdict === 'refusee') {
          session.message = 'La connexion n\'est pas encore terminée.';
          session.detail =
            'Finissez de vous connecter sur le site, puis cliquez sur Enregistrer.';
        } else if (essai.verdict === 'sans-controle') {
          session.message = 'La connexion ne peut pas être vérifiée automatiquement.';
          session.detail =
            'Connectez-vous d\'abord dans la fenêtre ci-dessous. Quand votre '
            + 'compte s\'affiche sur le site, cliquez alors sur Enregistrer.';
        } else if (essai.code === 'adresse-morte') {
          session.message =
            'La page qui sert à vérifier votre connexion n\'existe pas à l\'adresse prévue.';
          session.detail =
            'Ce service a besoin d\'être corrigé — signalez-le à la personne qui '
            + 'administre crabe. Vous pouvez fermer la fenêtre : rien ne sera enregistré.';
        } else if (essai.code === 'erreur-site') {
          session.message = 'Le site a répondu par une erreur pendant la vérification.';
          session.detail =
            'Impossible de dire si votre connexion a été prise en compte. Réessayez '
            + 'dans un instant, ou fermez la fenêtre et revenez plus tard.';
        } else if (essai.code === 'mur') {
          session.message =
            'Le site a masqué la page de vérification (contrôle de sécurité).';
          session.detail =
            'Impossible de dire si votre connexion a été prise en compte. Réessayez '
            + 'dans un instant, ou fermez la fenêtre : rien ne sera enregistré.';
        } else if (essai.code === 'sans-preuve-fenetre') {
          session.message = 'La fenêtre ne montre pas encore un compte connecté.';
          session.detail =
            'Affichez votre espace client dans la fenêtre (votre nom, vos commandes), '
            + 'puis cliquez à nouveau sur Enregistrer.';
        } else {
          session.message = 'La connexion n\'a pas pu être vérifiée.';
          session.detail =
            'Impossible de dire si votre connexion a été prise en compte. Vérifiez '
            + 'dans la fenêtre que vous êtes bien connecté puis réessayez — ou fermez '
            + 'la fenêtre : rien ne sera enregistré.';
        }
        // La boucle de surveillance cesse de tenter d'elle-même : sans ça,
        // elle relancerait un Chromium de contrôle toutes les 700 ms pendant
        // dix minutes. C'est « Enregistrer » qui reprendra la main.
        session.attenteManuelle = true;
        runtime.log(
          'warn',
          `Session ${session.connectorName} NON enregistrée : ${essai.raison}. `
            + `${(state.cookies || []).length} cookie(s) capturé(s). La fenêtre reste ouverte `
            + `(${session.echecsVerification} vérification(s) infructueuse(s)).`,
          session.connectorId
        );
        return;
      }

      const result = await session.onDetected(state);
      if (session.stopped) return;

      session.result = result || {};
      session.state = 'saved';
      // Le verdict de réussite est un FAIT dicible : combien de cookies sont
      // gardés. C'est ce que l'écran affiche avant de se fermer (lot 48).
      const gardes = result?.summary?.cookieCount ?? (state.cookies || []).length;
      session.message = `Session enregistrée — ${gardes} cookie(s) gardé(s).`;
      runtime.log(
        'info',
        `Session ${session.connectorName} capturée par navigateur distant pour le compte `
          + `${session.userId} — ${result?.summary?.cookieCount ?? '?'} cookie(s), `
          + (essai.verdict === 'sans-controle'
            ? 'enregistrée sur votre confirmation — aucun contrôle possible pour ce site.'
            : `validité vérifiée (${essai.preuve}).`),
        session.connectorId
      );
    } catch (err) {
      // Fenêtre fermée pendant l'essai : l'erreur vient de l'extinction
      // elle-même (« browser closed »), pas d'une panne à raconter.
      if (session.stopped) return;
      session.state = 'error';
      session.error = err.message;
      // Rien de brut à l'écran (lot 37) : une erreur d'automatisation est
      // traduite ; le texte complet part au journal juste en dessous.
      session.message = 'Enregistrement impossible : '
        + (messagesEchec.sansJargon(err.message) || 'le navigateur s\'est arrêté avant la fin.');
      runtime.log('error', `Enregistrement de session impossible — ${err.message}`,
        session.connectorId);
    }

    // Le navigateur s'éteint dans tous les cas SAUF l'essai raté : là, la
    // fenêtre doit rester ouverte pour que l'utilisateur puisse finir.
    if (session.state !== 'running') await shutdown(session);
  }

  /**
   * Essaie la session capturée, dans un contexte NEUF.
   *
   * Neuf, et pas celui de l'utilisateur : rejouer les cookies dans un contexte
   * vierge est exactement ce que fera le connecteur au premier passage. Un
   * essai fait dans le contexte d'origine profiterait de son `sessionStorage`,
   * de ses en-têtes et de son historique — et réussirait là où le connecteur
   * échouera.
   *
   * Sans `verifyUrl` déclarée par le manifeste, il n'y a rien à essayer : on
   * laisse passer plutôt que de bloquer une connexion sur une vérification
   * qu'on ne sait pas faire. Le manifeste d'un connecteur à session sérieux en
   * déclare une.
   *
   * ─── Une seule politique : la stricte (lot 37) ───────────────────────────
   *
   * Le contrôle rend l'un de TROIS verdicts, et un seul comportement par
   * verdict :
   *
   *   - `confirmee`       un marqueur de compte connecté est sur la page —
   *                       la session s'enregistre ;
   *   - `refusee`         renvoi vers le formulaire, ou page valide sans
   *                       aucun marqueur — pas d'enregistrement, la fenêtre
   *                       reste ouverte ;
   *   - `non-concluante`  la page ne permet pas de trancher (erreur réseau,
   *                       404, 5xx, page vide) — pas d'enregistrement, la
   *                       fenêtre reste ouverte, le message dit quoi faire.
   *
   * « Non concluant » ne vaut JAMAIS acceptation. Le 18/08/2026, la page de
   * contrôle SoundCloud répondait 404 — une adresse morte — et le contrôle
   * d'alors a « accepté » la session faute de formulaire à l'écran, pendant
   * que le connecteur Qobuz du même lot promettait « le 404 jamais confondu
   * avec une session ». Deux politiques opposées, deux occasions de se
   * tromper : il n'en reste qu'une, la stricte. L'option `verifyStrict` des
   * manifestes n'existe plus — il n'y a plus rien à choisir.
   *
   * Un quatrième cas, `sans-controle`, couvre l'absence de page de contrôle
   * déclarée : il n'y a alors PAS eu de contrôle — ce n'est pas un contrôle
   * non concluant, c'est l'absence d'outil pour le faire. L'enregistrement
   * passe, comme depuis le lot 14 ; la sonde automatique, elle, ne conclut
   * jamais sans preuve positive (voir `sonderSession`).
   *
   * @returns {Promise<{verdict: 'confirmee'|'refusee'|'non-concluante'|'sans-controle',
   *                    raison?: string, preuve?: string}>}
   */
  async function essayerSession(session, state, { naviguer = false } = {}) {
    // ─── La preuve lue dans la FENÊTRE (lot 48) ──────────────────────────────
    //
    // Pour les sites dont la garde anti-robot juge le NAVIGATEUR, rejouer les
    // cookies dans un contexte headless neuf ne peut PAS prouver la session :
    // le mur tombe sur le contrôleur, jamais sur la fenêtre. Mesuré le
    // 22/08/2026 au soir sur Boulanger — la page de contrôle répondait 404 au
    // contrôle headless alors que l'utilisateur était connecté sous ses propres yeux,
    // et la session n'a jamais pu être enregistrée. La preuve forte (lien de
    // déconnexion, preuve-connexion) se lit alors là où la session vit : dans
    // le Chromium visible, sur le profil persistant que le connecteur
    // rouvrira tel quel.
    if (session.preuveSurFenetre) {
      return essayerSurLaFenetre(session, { naviguer });
    }

    if (!session.verifyUrl) {
      return {
        verdict: 'sans-controle',
        code: 'sans-controle',
        raison: 'aucune page de contrôle déclarée par le connecteur',
        preuve: 'aucune page de contrôle déclarée par le connecteur',
      };
    }

    // ⚠ `findPlaywright()` rend un BOOLÉEN — test de présence écrit pour
    // `checkPrerequisites`, pas un chargeur de module. `true?.chromium` vaut
    // `undefined`, la condition passait, et le contrôle se sautait. À chaque
    // fois : `runtime.requirePlaywright` n'est défini nulle part, la branche de
    // gauche n'était jamais prise. Conséquence : aucune session capturée n'a
    // jamais été essayée avant d'être enregistrée — exactement la panne que ce
    // contrôle devait empêcher (huit cookies à 03:07:16, session morte à
    // 03:07:19, lot 12).
    let playwright = null;
    try {
      playwright = runtime.requirePlaywright ? runtime.requirePlaywright() : require('playwright');
    } catch {
      // Playwright réellement absent : le navigateur distant n'aurait pas pu
      // s'ouvrir, on n'en serait pas là. On laisse passer plutôt que de perdre
      // une connexion que l'utilisateur vient d'établir à la main.
      playwright = null;
    }
    if (!playwright?.chromium) {
      return {
        verdict: 'sans-controle',
        code: 'sans-controle',
        raison: 'l\'outil de contrôle est indisponible, rien ne peut être prouvé',
        preuve: 'outil de contrôle indisponible, contrôle sauté',
      };
    }

    let navigateur = null;
    try {
      navigateur = await playwright.chromium.launch({ headless: true });
      const contexte = await navigateur.newContext(
        identity.optionsContexte({ storageState: state })
      );
      const page = await contexte.newPage();
      page.setDefaultTimeout(CONTROLE_SESSION_TIMEOUT_MS);

      const reponse = await page.goto(session.verifyUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // ─── Le code de réponse est lu (lot 37) ──────────────────────────────
      //
      // L'erreur du 18/08/2026, à la lettre : la page de contrôle SoundCloud
      // répondait 404, et le contrôle — qui ne regardait que le contenu —
      // concluait « la page répond et n'est pas un formulaire de connexion ».
      // Une adresse morte ou un site en panne ne disent RIEN de la session :
      // verdict non concluant, jamais acceptation.
      const statut = typeof reponse?.status === 'function' ? reponse.status() : null;
      if (statut === 404 || (typeof statut === 'number' && statut >= 500)) {
        return {
          verdict: 'non-concluante',
          code: statut === 404 ? 'adresse-morte' : 'erreur-site',
          raison: statut === 404
            ? 'la page de contrôle n\'existe pas à cette adresse (réponse 404) — '
              + 'rien ne peut être conclu sur la session'
            : `le site a répondu par une erreur (réponse ${statut}) — `
              + 'rien ne peut être conclu sur la session',
        };
      }

      // ─── L'URL a tenu (lot 40) ───────────────────────────────────────────
      //
      // Certains sites n'affichent aucun marqueur générique de compte mais
      // REDIRIGENT les anonymes hors de la page de contrôle : y rester est
      // alors LE signe de session. Mesuré le 14/08/2026 sur OUIGO — hors
      // session, la page des réservations passées renvoie à l'accueil. Le
      // connecteur le déclare (`verifyUrlTient`), et le jugement reste
      // prudent : une page vide ou un formulaire de connexion resté sur
      // place ne prouvent rien — ces cas retombent sur le contrôle générique
      // ci-dessous, qui les refuse ou ne conclut pas.
      // Un 403 qui GARDE l'adresse n'est pas une page qui « tient » : c'est la
      // signature des murs anti-robot qui habillent leur refus en page
      // d'excuse sans rediriger (Darty, « FNAC DARTY - Maintenance », mesuré
      // au lot 47). Le raccourci « l'URL a tenu » exige une vraie réponse.
      if (session.verifyUrlTient && (statut === null || statut < 400)) {
        const urlFinale = String(page.url() || '');
        // La tenue se juge SANS le fragment de l'adresse finale (lot 68) : un
        // fragment n'est pas un chemin. Voir `preuve.adresseTenue`.
        if (!preuve.adresseTenue(urlFinale, session.verifyUrl)) {
          // Être ramené AILLEURS SUR LE SITE n'est pas être éconduit quand le
          // manifeste atteste que le site éconduit vers sa page de connexion :
          // le renvoi mesuré tranche plus bas, pas la tenue (lot 68).
          if (session.renvoiAnonyme !== 'connexion') {
            return {
              verdict: 'refusee',
              code: 'refus',
              raison: `la page de contrôle a renvoyé vers ${urlFinale} — c'est ainsi que `
                + 'le site éconduit les visiteurs sans session : session non établie',
            };
          }
        } else {
          let corpsVide = false;
          try {
            corpsVide = Boolean(await page.evaluate(
              () => !document.body || !document.body.innerText.trim()
            ));
          } catch {
            corpsVide = false; // illisible n'est pas vide : on ne conclut pas ici
          }
          const tenue = await preuve.verifier(page, { cookies: (state.cookies || []).length });
          if (!corpsVide && !tenue.surFormulaire) {
            return {
              verdict: 'confirmee',
              preuve: `${session.connectorName} : connexion confirmée — l'adresse de contrôle `
                + `${session.verifyUrl} a tenu, or le site en redirige les anonymes `
                + `(${(state.cookies || []).length} cookie(s)).`,
            };
          }
        }
      }

      const resultat = await preuve.verifier(page, { cookies: (state.cookies || []).length });
      if (resultat.confirme) {
        return {
          verdict: 'confirmee',
          preuve: preuve.ligneConfirmee(session.connectorName, resultat),
        };
      }

      // ─── Le refus certain : la page renvoie au formulaire ────────────────
      //
      // C'est EXACTEMENT ce qui s'est passé le 11/08/2026 — le connecteur a
      // signalé « redirection vers la page de connexion » trois secondes après
      // la capture. Aucun doute possible : la session ne vaut rien.
      if (resultat.surFormulaire) {
        return {
          verdict: 'refusee',
          code: 'refus',
          raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
        };
      }

      // ─── La page vide : rien à juger ─────────────────────────────────────
      //
      // Une page sans le moindre texte n'est ni un espace connecté ni un
      // formulaire : le site n'a rien montré, on ne conclut rien. Une page
      // illisible (navigation en cours) n'est pas déclarée vide pour autant.
      let pageVide = false;
      try {
        pageVide = Boolean(await page.evaluate(
          () => !document.body || !document.body.innerText.trim()
        ));
      } catch {
        pageVide = false;
      }
      if (pageVide) {
        return {
          verdict: 'non-concluante',
          code: 'page-vide',
          raison: 'la page de contrôle s\'est affichée vide — rien ne permet de trancher',
        };
      }

      // ─── Le 403 sans preuve ni formulaire : un mur, pas un verdict ─────────
      //
      // Le site a répondu, mais en refusant : c'est presque toujours une garde
      // anti-robot qui juge le contrôleur headless, pas la session. Conclure
      // « refusée » accuserait l'utilisateur ; conclure « confirmée » (le cas
      // verifyUrlTient, écarté plus haut) enregistrerait n'importe quoi. On ne
      // sait pas, et on le dit.
      if (statut === 403) {
        return {
          verdict: 'non-concluante',
          code: 'mur',
          raison: 'le site a refusé de montrer la page de contrôle (réponse 403, '
            + 'probablement une vérification de sécurité) — rien ne peut être conclu',
        };
      }

      // ─── Le renvoi des anonymes est la preuve (lot 68) ───────────────────
      //
      // Arrivé ici, la page a répondu (< 400), n'est ni vide, ni un formulaire,
      // ni un mur — et ne porte aucun marqueur générique. Quand le manifeste
      // ATTESTE que le site renvoie tout anonyme vers sa page de connexion
      // (`renvoiAnonyme: "connexion"`, mesuré — claude.ai : hors session,
      // `/settings/billing` renvoie vers `/login?from=logout`, relevé le
      // 13/08/2026 et revu dans les journaux du 28/08/2026), rester sur le
      // site sans y être renvoyé EST la preuve — même quand l'application a
      // réécrit le chemin en gardant la cible en fragment. Le principe du
      // lot 67 (Free Mobile), déclaré au manifeste au lieu d'être recodé
      // connecteur par connecteur. Un départ vers un AUTRE site, lui, ne
      // prouve rien : `memeSite` ferme cette porte.
      if (session.renvoiAnonyme === 'connexion'
        && (statut === null || statut < 400)
        && preuve.memeSite(page.url(), session.verifyUrl)) {
        return {
          verdict: 'confirmee',
          preuve: `${session.connectorName} : connexion confirmée — la page est restée sur le `
            + `site (URL finale ${resultat.url}) sans renvoi vers la connexion, or c'est ainsi `
            + `que ce site éconduit les visiteurs sans session — comportement mesuré `
            + `(${(state.cookies || []).length} cookie(s)).`,
        };
      }

      // ─── Page valide, aucun marqueur : la preuve MANQUE ──────────────────
      //
      // Jusqu'au lot 37, ce cas n'était un refus que si le manifeste déclarait
      // `verifyStrict` ; sinon la session était « acceptée » avec un simple
      // avertissement au journal. C'est ce chemin qui a enregistré la session
      // SoundCloud morte du 18/08/2026. Il n'existe plus : une page qui répond
      // sans montrer de compte connecté ne prouve pas la session.
      //
      // Mais depuis le lot 68, ce cas porte son propre code : `sans-preuve`.
      // La session n'est PAS forcément mauvaise — Anthropic, 28/08/2026 :
      // trois refus d'une session valide, et un message qui invitait à
      // « finir de se connecter » alors qu'il n'y avait rien à finir. Dire
      // « session non établie » ici serait une supposition, pas une mesure :
      // on dit que la preuve manque, et le message de `save()` dit quoi faire.
      return {
        verdict: 'refusee',
        code: 'sans-preuve',
        raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
      };
    } catch (err) {
      // Un contrôle qui ne peut pas s'exécuter ne conclut RIEN : ni
      // acceptation (l'erreur du 18/08/2026), ni refus net (la session est
      // peut-être bonne). La fenêtre reste ouverte, et le détail technique va
      // au journal — jamais à l'écran.
      runtime.log(
        'warn',
        `Contrôle de session ${session.connectorName} : détail technique — ${err.message}`,
        session.connectorId
      );
      return {
        verdict: 'non-concluante',
        code: 'interrompu',
        raison: 'le contrôle n\'a pas pu s\'exécuter jusqu\'au bout '
          + '(le site n\'a pas répondu, ou la vérification s\'est interrompue)',
      };
    } finally {
      await navigateur?.close?.().catch(() => {});
    }
  }

  /**
   * La preuve, lue dans la fenêtre visible (lot 48, généralisée au lot 49).
   *
   * Déclarée par le manifeste (`remoteLogin.preuveSurFenetre`) pour les sites
   * dont la garde anti-robot juge le navigateur : Akamai chez Boulanger rend
   * 404 à tout contrôle headless, cookies de session compris — mesuré le
   * 22/08/2026 au soir, quatre refus pendant que l'utilisateur était connecté
   * à l'écran. Ici, on lit la preuve dans le Chromium VISIBLE, sur le profil
   * persistant — exactement le navigateur que le connecteur rouvrira.
   *
   * Deux preuves valent, dans cet ordre (`lireLaPreuveSurLaFenetre`) :
   *
   *   - la preuve forte générique — le lien de déconnexion ;
   *   - les marqueurs MESURÉS du service (lot 49) : l'adresse de contrôle a
   *     tenu dans la fenêtre ET un marqueur déclaré est dans la page. C'est
   *     la voie normale des services à mur : le 23/08/2026, Darty affichait
   *     la page des commandes pendant que DataDome rendait 403 à la seconde
   *     requête du contrôle — vérifier en redemandant la page est fragile
   *     par construction, la preuve se lit sur le DOM déjà affiché, sans
   *     aucune requête supplémentaire.
   *
   * `naviguer` n'est vrai que sur un clic « Enregistrer » : si la page
   * courante ne porte pas la preuve, la fenêtre est conduite sur la page de
   * compte déclarée (`verifyUrl`) et relue. La sonde automatique, elle, ne
   * déplace JAMAIS la page sous les yeux de l'utilisateur.
   */
  async function essayerSurLaFenetre(session, { naviguer = false } = {}) {
    try {
      const page = pageActive(session);
      if (!page) {
        return {
          verdict: 'non-concluante',
          code: 'interrompu',
          raison: 'la fenêtre ne répond plus — rien ne peut être lu',
        };
      }

      let { fait, resultat } = await lireLaPreuveSurLaFenetre(session, page);
      if (fait) return fait;

      if (naviguer && session.verifyUrl
        && !preuve.adresseTenue(String(resultat.url || ''), session.verifyUrl)) {
        await page.goto(session.verifyUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState?.('networkidle')?.catch?.(() => {});
        // Les boutiques modernes peignent leur en-tête — donc le lien de
        // déconnexion — après coup : le même délai que pour les cookies tardifs.
        await runtime.sleep(detection.DELAI_COOKIES_TARDIFS_MS);
        ({ fait, resultat } = await lireLaPreuveSurLaFenetre(session, page));
        if (fait) return fait;
      }

      if (resultat.surFormulaire) {
        return {
          verdict: 'refusee',
          code: 'refus',
          raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
        };
      }
      return {
        verdict: 'non-concluante',
        code: 'sans-preuve-fenetre',
        raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
      };
    } catch (err) {
      return {
        verdict: 'non-concluante',
        code: 'interrompu',
        raison: `la lecture de la fenêtre a échoué (${err.message})`,
      };
    }
  }

  /**
   * Une lecture de la preuve sur la page affichée — jamais de navigation ici.
   *
   * Rend `{fait, resultat}` : `fait` est le verdict confirmé s'il y en a un,
   * `resultat` la lecture générique (`preuve.verifier`) dont l'appelant tire
   * le refus ou l'indécision. Les deux preuves acceptées :
   *
   *   - le lien de déconnexion (preuve forte générique, lot 48) ;
   *   - un marqueur MESURÉ du manifeste, si l'adresse de contrôle a tenu dans
   *     la fenêtre et que la page n'est pas un formulaire (lot 49). Tout se
   *     lit dans le document déjà affiché : c'est le point — la seconde
   *     requête, elle, peut être refusée par la garde du site pendant que la
   *     fenêtre montre la page (Darty, 403 DataDome, 23/08/2026).
   */
  async function lireLaPreuveSurLaFenetre(session, page) {
    const resultat = await preuve.verifier(page, {});
    if (resultat.confirme) {
      return {
        fait: { verdict: 'confirmee', preuve: preuve.ligneConfirmee(session.connectorName, resultat) },
        resultat,
      };
    }
    // La tenue dans la fenêtre se juge comme au contrôle headless : sans le
    // fragment de l'adresse affichée (lot 68) — un fragment n'est pas un chemin.
    if (session.marqueursFenetre?.length && session.verifyUrl && !resultat.surFormulaire
      && preuve.adresseTenue(String(resultat.url || ''), session.verifyUrl)) {
      const trouves = await preuve.chercherMarqueursMesures(page, session.marqueursFenetre);
      if (trouves.length) {
        return {
          fait: {
            verdict: 'confirmee',
            preuve: `${session.connectorName} : connexion confirmée — la fenêtre affiche `
              + `${resultat.url} (l'adresse de contrôle a tenu) et son marqueur mesuré `
              + `(${trouves[0]}), lu sans requête supplémentaire.`,
          },
          resultat,
        };
      }
    }
    return { fait: null, resultat };
  }

  /**
   * Éteint tout : navigateur, websockify, x11vnc, Xvfb, affichage, jetons.
   *
   * Ne lève jamais. C'est le seul chemin de sortie, emprunté par le succès,
   * l'erreur, l'abandon, le délai dépassé et l'arrêt du service.
   *
   * @param {object} session
   * @param {string} [state] état terminal à poser (sinon celui déjà atteint)
   * @param {string} [message]
   */
  async function terminate(session, state = null, message = null) {
    if (!session) return null;
    if (state) {
      session.state = state;
      session.message = message || session.message;
      if (state === 'error') session.error = message;
    }
    await shutdown(session);

    // Le dernier mot, sur TOUS les chemins de sortie — succès, annulation,
    // délai, onglet fermé, arrêt du service. Une seule fois : `shutdown()`
    // protège déjà l'extinction, on protège ici la notification. Ce rappel ne
    // doit jamais faire échouer une extinction qui, elle, a réussi.
    if (session.onFin && !session.onFinAppele) {
      session.onFinAppele = true;
      try {
        await session.onFin(session.state);
      } catch (err) {
        runtime.log('warn', `Rappel de fin de session ${session.connectorName} : ${err.message}`);
      }
    }
    return publicView(session);
  }

  /**
   * Conclut de l'EXTÉRIEUR une fenêtre sans capture (lot 34).
   *
   * C'est le pendant de `save()` pour les sessions dont la réussite ne se lit
   * pas à l'écran : l'autorisation OAuth se conclut quand `rclone authorize`
   * rend son jeton — un événement que la fenêtre ne voit pas. L'appelant est
   * le même module qui a lancé la commande ; personne d'autre n'a de raison
   * d'appeler ceci.
   */
  async function conclure(userId, connectorId, { ok, message }) {
    const session = sessionFor(userId, connectorId);
    if (!session || session.stopped) return null;
    return terminate(session, ok ? 'saved' : 'error', message);
  }

  /** L'extinction proprement dite, sans toucher à l'état affiché. */
  async function shutdown(session) {
    if (session.stopped) return;
    session.stopped = true;

    for (const key of ['timer', 'graceTimer']) {
      if (session[key]) {
        clearTimeout(session[key]);
        session[key] = null;
      }
    }

    // Plus aucun attachement possible, y compris pendant l'extinction.
    session.tickets.clear();

    // Le navigateur d'abord — mais JAMAIS à n'importe quel prix (lot 48). Le
    // soir du 22/08/2026, l'utilisateur a dû tuer des Chromium à la main : un
    // navigateur coincé suspendait `close()` sans limite, et avec lui toute
    // l'extinction — auxiliaires jamais arrêtés, affichage jamais rendu,
    // verrou de profil jamais relâché. Passé le délai, on continue sans lui,
    // et ce qui reste sur CET affichage reçoit SIGKILL.
    let navigateurFerme = true;
    try {
      const fermeture = session.browser?.close?.();
      if (fermeture && typeof fermeture.then === 'function') {
        navigateurFerme = await Promise.race([
          fermeture.then(
            () => true,
            (err) => {
              runtime.log('warn', `Fermeture du navigateur : ${err.message}`, session.connectorId);
              return true;
            }
          ),
          runtime.sleep(closeTimeoutMs).then(() => false),
        ]);
      }
    } catch (err) {
      runtime.log('warn', `Fermeture du navigateur : ${err.message}`, session.connectorId);
    }
    if (!navigateurFerme) {
      runtime.log(
        'warn',
        `Le navigateur de ${session.connectorName} ne s'est pas fermé en `
          + `${Math.round(closeTimeoutMs / 1000)} s — l'extinction continue sans lui, `
          + 'ses processus sont tués sur l\'affichage.',
        session.connectorId
      );
      tuerChromiumsSurAffichage(session.display);
    }

    // Ordre inverse du lancement : le client avant la source, sinon x11vnc
    // passe ses dernières secondes à filmer un écran qui n'existe plus.
    const enfants = [...session.processes].reverse();
    for (const { name, child } of enfants) {
      try {
        child.kill?.('SIGTERM');
      } catch (err) {
        runtime.log('warn', `Arrêt de ${name} : ${err.message}`);
      }
    }
    session.processes = [];

    // ─── Le second rideau (lot 35) ────────────────────────────────────────────
    //
    // Le SIGTERM ci-dessus n'était jamais vérifié : un auxiliaire qui
    // l'ignorait survivait indéfiniment, et comme l'affichage — donc les ports
    // — est rendu juste après, la session suivante relançait un websockify
    // par-dessus le survivant (les deux websockify du port 6180, 15/08/2026).
    // Un vrai ChildProcess encore vivant a `exitCode` ET `signalCode` nuls ;
    // ce qui vit encore après le délai reçoit SIGKILL, et c'est journalisé —
    // un auxiliaire qui ignore SIGTERM est une anomalie qu'on veut voir.
    const rideau = setTimeout(() => {
      for (const { name, child } of enfants) {
        if (child.exitCode != null || child.signalCode != null) continue;
        try {
          child.kill?.('SIGKILL');
          runtime.log('warn',
            `${name} a ignoré SIGTERM pendant ${KILL_ESCALATION_MS / 1000} s — SIGKILL envoyé `
            + `(session ${session.connectorName}).`);
        } catch {
          /* mort entre la vérification et le signal : c'est le but */
        }
      }
    }, escalationMs);
    rideau.unref?.();

    if (session.vncPasswordFile) {
      try {
        runtime.fs.rmSync(session.vncPasswordFile, { force: true });
      } catch {
        /* déjà parti */
      }
      session.vncPasswordFile = null;
    }

    releaseDisplay(session.display);

    if (session.verrouProfil) {
      // Le profil redevient ouvrable — par une récupération comme par une
      // nouvelle fenêtre. Idempotent : rendre un verrou déjà rendu est sans effet.
      inflight.profil.release(session.verrouProfil);
      session.verrouProfil = null;
    }

    if (current === session) {
      current = null;
      finished = session;
      session.finishedAt = runtime.now();
    }

    runtime.log(
      'info',
      `Session de connexion ${session.connectorName} terminée (${session.state}) — `
        + `affichage :${session.display} libéré.`,
      session.connectorId
    );
  }

  /**
   * Saisit un texte dans le champ actif de la fenêtre distante.
   *
   * ─── Pourquoi côté serveur ───────────────────────────────────────────────
   *
   * Le champ « Coller un texte » de la modale existait déjà, et il frappait le
   * texte en envoyant un keysym X11 par caractère à travers le flux noVNC.
   * Ce chemin dépend de trois choses hors de notre portée : la version de
   * noVNC installée sur le LXC (celle du paquet Debian, pas celle du dépôt),
   * la table de keysyms du serveur X — un Xvfb frais n'a ni verrou numérique
   * ni disposition complète —, et le fait que la toile ait bien le focus.
   * Quand l'un des trois manque, la frappe part dans le vide et l'interface
   * annonce quand même « Saisi dans la fenêtre » : le pire des comptes rendus.
   *
   * `page.keyboard.type()` parle directement au navigateur, par le protocole
   * de Playwright. Aucun des trois aléas ci-dessus ne s'applique : les
   * accents, les caractères spéciaux et la ponctuation d'un mot de passe fort
   * passent tels quels, et l'échec, s'il y en a un, est une exception qu'on
   * peut dire.
   *
   * ─── Ce qui n'est jamais fait ────────────────────────────────────────────
   *
   * **Le texte n'est écrit nulle part.** Ni journal applicatif, ni
   * `console.log`, ni message de session, ni longueur : c'est un mot de passe
   * dans la quasi-totalité des cas. Il traverse ce module et disparaît.
   *
   * @param {number} userId
   * @param {string|null} connectorId
   * @param {string} texte
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function typeText(userId, connectorId, texte) {
    const contenu = String(texte ?? '');
    if (!contenu) return { ok: false, error: 'Aucun texte à saisir.' };
    if (contenu.length > SAISIE_MAX_CARACTERES) {
      return {
        ok: false,
        error: `Texte trop long (${SAISIE_MAX_CARACTERES} caractères au plus).`,
      };
    }

    const session = sessionFor(userId, connectorId);
    if (!session || session !== current || session.stopped) {
      return { ok: false, error: 'La fenêtre de connexion n\'est plus ouverte.' };
    }
    if (session.state !== 'running') {
      return { ok: false, error: 'La fenêtre n\'est pas prête — patientez un instant.' };
    }

    const page = pageActive(session);
    if (typeof page?.keyboard?.insertText !== 'function'
      && typeof page?.keyboard?.type !== 'function') {
      return { ok: false, error: 'Le navigateur ne répond pas. Fermez la fenêtre et recommencez.' };
    }

    // ─── Y a-t-il seulement un champ où écrire ? ────────────────────────────
    //
    // C'est LA cause du silence des lots 8, 10 et 12 : sans champ actif, les
    // frappes partent dans le vide, rien n'apparaît, et l'interface annonçait
    // quand même « Saisi dans la fenêtre ». Le contrôle préalable transforme un
    // échec muet en une consigne que l'utilisateur peut suivre.
    const avant = await detection.champActif(page);
    if (!avant) {
      return {
        ok: false,
        error: 'Cliquez d\'abord dans le champ à remplir, dans la fenêtre ci-dessous.',
      };
    }
    if (!avant.editable) {
      return {
        ok: false,
        error:
          'L\'endroit sélectionné dans la fenêtre n\'accepte pas de texte. '
          + 'Cliquez dans le champ à remplir, dans la fenêtre ci-dessous.',
      };
    }

    try {
      // ─── `insertText` plutôt que `type` (lot 14, §7.3b) ─────────────────
      //
      // `insertText` pose le texte d'un coup dans l'élément qui a le focus, en
      // émettant les événements `input` que les formulaires écoutent. C'est
      // exactement le geste d'un collage, et c'est ce que le §7.3b demande.
      //
      // La frappe caractère par caractère reste le repli : elle est plus lente
      // et sensible aux masques de saisie, mais elle existe sur toutes les
      // versions de Playwright. Un dixième de seconde de plus vaut mieux qu'un
      // champ qui reste vide sur une version qu'on n'avait pas prévue.
      if (typeof page.keyboard.insertText === 'function') {
        await page.keyboard.insertText(contenu);
      } else {
        await page.keyboard.type(contenu, { delay: DELAI_FRAPPE_MS });
      }
    } catch {
      // Le message d'erreur de Playwright ne contient pas le texte frappé, mais
      // on ne le remonte pas pour autant : on dit quoi faire.
      runtime.log('warn', 'Saisie dans la fenêtre distante impossible : le navigateur a refusé.',
        session.connectorId);
      return {
        ok: false,
        error: 'La saisie n\'a pas abouti — la fenêtre s\'est peut-être fermée. Réessayez.',
      };
    }

    // ─── Et le texte est-il vraiment arrivé ? ───────────────────────────────
    //
    // On compare des LONGUEURS, jamais des contenus : rien de ce qui transite
    // par ce champ ne doit sortir du navigateur distant, y compris vers crabe.
    const apres = await detection.champActif(page);
    if (!apres?.editable || apres.longueur <= avant.longueur) {
      runtime.log(
        'warn',
        'Saisie dans la fenêtre distante : le champ n\'a pas changé après la frappe. '
          + 'Le site a peut-être repris la main sur le champ.',
        session.connectorId
      );
      return {
        ok: false,
        error:
          'Le texte ne s\'est pas inscrit dans le champ. Cliquez dedans dans la fenêtre '
          + 'ci-dessous, vérifiez que le curseur y clignote, puis réessayez.',
      };
    }

    // ⚠ La LONGUEUR, et rien d'autre (§7.3b). Le contenu est un mot de passe
    // dans la quasi-totalité des cas ; sa longueur, elle, dit si la saisie est
    // partie entière — c'est la seule chose qu'on ait jamais eu besoin de
    // savoir pour diagnostiquer un collage qui « ne marche pas ».
    runtime.log(
      'info',
      `Texte saisi dans la fenêtre de ${session.connectorName} — ${contenu.length} caractère(s).`,
      session.connectorId
    );
    // Le compteur qui arme la sonde (lot 38) : avant la PREMIÈRE saisie, un
    // changement d'adresse est la navigation initiale du site, pas une
    // connexion — la sonde n'a rien à y vérifier.
    session.saisies = (session.saisies || 0) + 1;
    return { ok: true };
  }

  /**
   * La page qui a la main dans la fenêtre distante.
   *
   * Un portail qui ouvre son formulaire dans un onglet — ou une fenêtre
   * surgissante de fournisseur d'identité — fait naître une seconde page dans
   * le même contexte. Frapper dans la première laisserait l'utilisateur devant
   * un champ qui ne se remplit pas, sans rien pour le comprendre.
   */
  function pageActive(session) {
    try {
      const pages = session.browser?.context?.pages?.() || [];
      const vivantes = pages.filter((p) => !p?.isClosed?.());
      if (vivantes.length) return vivantes[vivantes.length - 1];
    } catch {
      /* contexte fermé : on retombe sur la page d'origine */
    }
    return session.browser?.page || null;
  }

  /**
   * « Saisir mes identifiants » — le serveur remplit le formulaire du site.
   *
   * ─── Pourquoi ce bouton existe (lot 14, §7.3a) ────────────────────────────
   *
   * Le presse-papiers est un cul-de-sac, dans les deux sens :
   *
   *   - **côté crabe**, `navigator.clipboard.readText()` n'existe qu'en
   *     contexte sécurisé. crabe est servi en HTTP sur `http://crabe.local` :
   *     toute lecture du presse-papiers depuis la page échoue EN SILENCE ;
   *   - **côté navigateur distant**, le « Coller » du menu contextuel lit le
   *     presse-papiers X de l'affichage `:99`, que rien ne remplit.
   *
   * Les deux verrous sont indépendants et aucun ne se contourne proprement.
   * On supprime donc le besoin : le navigateur distant est piloté par
   * Playwright, crabe peut écrire directement dans les champs de la page.
   *
   * ─── Le mot de passe ne quitte jamais le serveur ──────────────────────────
   *
   * Il est déchiffré à l'ouverture de la fenêtre, gardé dans l'objet session,
   * et écrit par `fill()`. Il n'apparaît dans aucune réponse HTTP (voir
   * `publicView`), dans aucun journal, et dans aucun diagnostic du §4. Ce que
   * cette fonction rend, ce sont deux booléens.
   *
   * @returns {Promise<{ok: boolean, error?: string, identifiant?: boolean,
   *                    motDePasse?: boolean}>}
   */
  async function saisirIdentifiants(userId, connectorId = null) {
    const session = sessionFor(userId, connectorId);
    if (!session || session !== current || session.stopped) {
      return { ok: false, error: 'La fenêtre de connexion n\'est plus ouverte.' };
    }
    if (session.state !== 'running') {
      return { ok: false, error: 'La fenêtre n\'est pas prête — patientez un instant.' };
    }
    if (!session.identifiants) {
      return { ok: false, error: 'Aucun identifiant enregistré pour ce service.' };
    }

    const page = pageActive(session);
    if (!page?.locator) {
      return { ok: false, error: 'Le navigateur ne répond pas. Fermez la fenêtre et recommencez.' };
    }

    // Un voile promotionnel recouvre aussi bien un champ qu'un bouton : le
    // même module que partout ailleurs, avant toute interaction.
    await cookieBanner
      .fermer(page, {
        cible: 'input[type="password"], form, button',
        log: (message) => runtime.log('info', message, session.connectorId),
        prefixe: session.connectorName,
      })
      .catch(() => ({ ferme: false }));

    let identifiantPose = false;
    let motDePassePose = false;

    try {
      for (const selecteur of detection.SELECTEURS_IDENTIFIANT) {
        const champ = page.locator(selecteur).first();
        if (!(await champ.count())) continue;
        if (typeof champ.isVisible === 'function' && !(await champ.isVisible())) continue;
        // `fill` et non `type` : c'est le geste demandé au §7.3a, et il ne
        // risque pas de valider le formulaire au milieu de la saisie.
        await champ.fill(session.identifiants.identifiant || '');
        identifiantPose = true;
        break;
      }

      const motDePasse = page.locator('input[type="password"]').first();
      if (await motDePasse.count()) {
        await motDePasse.fill(session.identifiants.motDePasse);
        motDePassePose = true;
      }
    } catch (err) {
      // ⚠ Le message d'erreur de Playwright peut citer la valeur d'un champ.
      // Il ne remonte donc pas : on dit quoi faire.
      runtime.log('warn', `Saisie des identifiants impossible sur ${session.connectorName}.`,
        session.connectorId);
      return {
        ok: false,
        error: 'La saisie n\'a pas abouti — la page a peut-être changé. Réessayez.',
      };
    }

    if (!identifiantPose && !motDePassePose) {
      return {
        ok: false,
        error: 'Aucun champ à remplir n\'a été trouvé sur cette page. '
          + 'Allez sur le formulaire de connexion du site, puis réessayez.',
      };
    }

    // Ce qui a été POSÉ, jamais ce qui a été écrit.
    runtime.log(
      'info',
      `Identifiants saisis dans la fenêtre de ${session.connectorName} — `
        + `identifiant ${identifiantPose ? 'posé' : 'non trouvé'}, `
        + `mot de passe ${motDePassePose ? 'posé' : 'non trouvé'}.`,
      session.connectorId
    );
    return { ok: true, identifiant: identifiantPose, motDePasse: motDePassePose };
  }

  /**
   * « Enregistrer » — l'utilisateur affirme avoir fini de se connecter.
   *
   * N'existe que pour le cas du §6 : un premier essai a montré que la session
   * n'était pas encore valable, et la fenêtre est restée ouverte. Le contrôle
   * est REFAIT à l'identique — cliquer « Enregistrer » ne le contourne pas,
   * sinon il ne servirait à rien.
   */
  async function saveNow(userId, connectorId = null) {
    const session = sessionFor(userId, connectorId);
    // CHAQUE appui sur « Enregistrer » laisse une trace, y compris les refus
    // précoces (lot 48) : le soir du 22/08/2026, les clics restés sans effet
    // n'existaient nulle part, et la soirée s'est diagnostiquée à l'aveugle.
    if (!session || session !== current || session.stopped) {
      runtime.log('info',
        '« Enregistrer » cliqué alors qu\'aucune fenêtre de connexion n\'est ouverte.',
        connectorId);
      return { ok: false, error: 'La fenêtre de connexion n\'est plus ouverte.' };
    }
    if (session.state !== 'running') {
      runtime.log('info',
        `« Enregistrer » cliqué pendant l'état « ${session.state} » — refusé, `
          + 'la fenêtre n\'est pas prête.',
        session.connectorId);
      return { ok: false, error: 'La fenêtre n\'est pas prête — patientez un instant.' };
    }

    // 19/08/2026 : un clic « Enregistrer » 7 secondes après l'ouverture a
    // enregistré 21 cookies anonymes (OUIGO). Si RIEN n'a été saisi dans la
    // fenêtre, le premier clic demande confirmation ; le second passe — cas
    // légitime d'un profil persistant déjà connecté, sans frappe nécessaire.
    if (!(session.saisies > 0) && !session.confirmationSansSaisie) {
      session.confirmationSansSaisie = true;
      runtime.log('info',
        `« Enregistrer » cliqué sans aucune saisie dans la fenêtre ${session.connectorName} `
          + '— confirmation demandée avant tout enregistrement.',
        session.connectorId);
      return {
        ok: false,
        error:
          'Rien n\'a encore été saisi dans la fenêtre — connectez-vous d\'abord. '
          + 'Si vous étiez déjà connecté (session précédente), cliquez à '
          + 'nouveau sur Enregistrer pour confirmer.',
        view: publicView(session),
      };
    }
    runtime.log('info',
      `« Enregistrer » cliqué pour ${session.connectorName} — vérification de la session.`,
      session.connectorId);
    session.attenteManuelle = false;
    await save(session, { manuel: true });

    // `save` a remis l'état à « running » si le contrôle a de nouveau échoué.
    // Le message ET la consigne partent ensemble : c'est le verdict que
    // l'écran affiche, il doit dire quoi faire, pas seulement que ça a raté.
    if (session.state === 'running') {
      return {
        ok: false,
        error: [session.message, session.detail].filter(Boolean).join(' '),
        view: publicView(session),
      };
    }
    return { ok: true, view: publicView(session) };
  }

  /** Abandon demandé par l'utilisateur. Vérifie la propriété. */
  async function cancel(userId, connectorId = null) {
    const session = sessionFor(userId, connectorId);
    if (!session) return null;
    return terminate(session, 'cancelled', 'Connexion annulée.');
  }

  /** Arrêt du service : plus rien ne doit survivre au processus. */
  async function stopAll() {
    if (current) await terminate(current, 'cancelled', 'Arrêt du service crabe.');
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  /**
   * La session d'un utilisateur — en cours, ou tout juste terminée.
   *
   * Un utilisateur ne voit JAMAIS la session d'un autre : ni son état, ni son
   * existence. C'est le même contrôle que pour les jetons, au même endroit.
   */
  function sessionFor(userId, connectorId = null) {
    for (const candidate of [current, finished]) {
      if (!candidate) continue;
      if (Number(candidate.userId) !== Number(userId)) continue;
      if (connectorId && candidate.connectorId !== connectorId) continue;
      if (candidate === finished && runtime.now() - (candidate.finishedAt || 0) > LINGER_MS) {
        continue;
      }
      return candidate;
    }
    return null;
  }

  /** Ce que le client a le droit de savoir. Ni jeton, ni mot de passe VNC. */
  function publicView(session) {
    if (!session) return null;
    return {
      sessionId: session.id,
      connectorId: session.connectorId,
      connectorName: session.connectorName,
      state: session.state,
      message: session.message,
      detail: session.detail || '',
      error: session.error || null,
      hint: session.hint || '',
      // Le mot de passe VNC part avec la vue : noVNC en a besoin pour ouvrir
      // le flux, et le canal qui le porte est déjà celui de la session
      // applicative de son propriétaire. Il n'est écrit dans aucun journal.
      vncPassword: session.state === 'running' || session.state === 'starting'
        ? session.vncPassword
        : null,
      screen: { width: SCREEN.width, height: SCREEN.height },
      remainingMs: Math.max(0, session.expiresAt - runtime.now()),
      startedAt: new Date(session.startedAt).toISOString(),
      result: session.result || null,
      // Un essai de session a échoué : la fenêtre reste ouverte, et l'interface
      // doit offrir « Enregistrer » plutôt que d'attendre une fermeture qui
      // ne viendra pas d'elle-même (lot 14, §6.3).
      attenteManuelle: !!session.attenteManuelle,
      // Lot 48 : combien de vérifications sont restées sans preuve, et la
      // nature du dernier verdict. Au troisième échec, l'écran propose
      // explicitement de renoncer plutôt que de laisser recliquer sans fin.
      echecsVerification: session.echecsVerification || 0,
      verdictCode: session.verdictCode || null,
      // Y a-t-il des identifiants enregistrés pour ce couple ? Un booléen, et
      // rien d'autre : ni l'identifiant, ni a fortiori le mot de passe.
      identifiantsDisponibles: !!session.identifiants,
      done: ['saved', 'error', 'cancelled', 'timeout'].includes(session.state),
    };
  }

  /** Vue publique + un jeton neuf, pour (re)brancher un flux. */
  function status(userId, connectorId = null, { withTicket = false } = {}) {
    const session = sessionFor(userId, connectorId);
    if (!session) return null;
    const view = publicView(session);
    if (withTicket && session === current && !session.stopped) {
      view.token = mintTicket(session);
    }
    return view;
  }

  return {
    // cycle de vie
    start,
    stop: (userId, connectorId) => cancel(userId, connectorId),
    conclure,
    stopAll,
    typeText,
    saisirIdentifiants,
    saveNow,
    cleanupOrphans,
    // lecture
    status,
    sessionFor,
    publicView,
    consumeTicket,
    noteDetach,
    checkPrerequisites: () => checkPrerequisites(runtime),
    ensureBrowserHome,
    // exposés pour les tests
    allocateDisplay,
    releaseDisplay,
    isDisplayFree,
    orphanDisplay,
    tuerChromiumsSurAffichage,
    mintTicket,
    runtime,
    get current() {
      return current;
    },
    get reservedDisplays() {
      return [...reserved];
    },
  };
}

/** Erreur d'exploitation : lisible par l'utilisateur, jamais une trace. */
function fail(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

/**
 * Lancement réel du navigateur — la seule partie que les tests ne couvrent pas.
 *
 * `headless: false` est le point entier de ce module : c'est ce qui fait
 * exister une vraie fenêtre sur l'affichage X, donc quelque chose à filmer.
 *
 * `--no-sandbox` mérite une explication. Dans un conteneur LXC non privilégié,
 * le bac à sable de Chromium s'appuie sur des espaces de noms utilisateur
 * imbriqués qui ne sont pas disponibles : sans ce drapeau, le navigateur ne
 * démarre pas du tout. Le compromis est assumé et documenté dans le README —
 * le navigateur tourne sous l'utilisateur système `crabe`, sans droits, pour
 * une session de dix minutes au plus. `CRABE_REMOTE_BROWSER_SANDBOX=1` le
 * rétablit sur une installation qui peut se le permettre.
 */
/**
 * Options de lancement de Chromium, isolées pour être vérifiables.
 *
 * Séparé de `defaultLauncher()` parce que le défaut qui a rendu le lot 6
 * inutilisable en production tenait ENTIÈREMENT à ces options : un `HOME`
 * absent de l'environnement transmis. Une fonction pure se teste ; un appel à
 * `chromium.launch()` non.
 *
 * @param {{display: number, screen: object, home: string, env?: object}} options
 */
function browserLaunchOptions({ display, screen, home, env = process.env }) {
  const sandbox = /^(1|true|yes)$/i.test(String(env.CRABE_REMOTE_BROWSER_SANDBOX || '0'));

  return {
    headless: false,
    env: {
      ...env,
      DISPLAY: `:${display}`,
      // Le point entier du correctif du lot 7. Voir BROWSER_HOME_DIRNAME.
      HOME: home,
    },
    args: [
      `--window-size=${screen.width},${screen.height}`,
      '--window-position=0,0',
      '--start-maximized',
      // /dev/shm est minuscule dans un conteneur : Chromium y meurt sinon.
      '--disable-dev-shm-usage',
      // Ceinture et bretelles avec le HOME ci-dessus : crabe n'a AUCUN usage du
      // gestionnaire de plantage de Chromium, et c'est lui qui refusait de
      // démarrer faute de pouvoir écrire sa base.
      '--disable-crashpad',
      '--disable-crash-reporter',
      // ─── Le drapeau qui décide si Google laisse entrer (lot 22) ───────────
      //
      // Il retire `navigator.webdriver`, le marqueur que Chromium expose de
      // lui-même quand il est piloté par automatisation. Google le lit, et
      // quand il le voit il n'affiche même pas le formulaire : « Ce navigateur
      // ou cette application peut ne pas être sécurisé(e) ».
      //
      // Ce drapeau existait dans ce fichier depuis le lot 11, mais AJOUTÉ APRÈS
      // COUP par le seul lanceur à profil persistant — celui d'addons.prestashop,
      // écrit contre Cloudflare. Les connecteurs à session ordinaire ne
      // l'avaient pas, et personne ne pouvait s'en apercevoir : Free Mobile,
      // seul à emprunter ce chemin, ne passe pas par Google.
      //
      // Au lot 21, trois services y sont passés d'un coup (Mistral, Anthropic,
      // Envato) et les trois se sont arrêtés à cet écran, AVANT la moindre
      // saisie — d'où un journal de récupérations vide : le connecteur n'était
      // jamais appelé. Le drapeau est donc ici, dans les options COMMUNES, et
      // plus dans un seul lanceur. Un test le vérifie sur tous (voir
      // test/remote-browser.test.js, « tout lanceur porte le drapeau »).
      '--disable-blink-features=AutomationControlled',
      ...(sandbox ? [] : ['--no-sandbox']),
    ],
  };
}

/**
 * Ouvre la fenêtre de connexion sur un PROFIL PERSISTANT.
 *
 * ─── Pourquoi ce mode existe ──────────────────────────────────────────────
 *
 * Certains sites — addons.prestashop.com en tête — sont protégés par
 * Cloudflare à deux niveaux : un challenge pleine page, et un Turnstile dans
 * le formulaire. Les deux jugent le NAVIGATEUR, pas seulement les cookies.
 *
 * Vérifié le 11/08/2026 : un contexte neuf nourri d'une session capturée est
 * bloqué (« Performing security verification », en boucle), alors que le même
 * site s'ouvre normalement sur un profil persistant — y compris depuis le LXC,
 * dans son Xvfb.
 *
 * Un `storageState` ne transporte que des cookies. Un profil transporte l'état
 * complet : stockage local, base indexée, préférences, et les jetons que
 * Cloudflare y dépose après un challenge résolu.
 *
 * ─── Ce que ça coûte ──────────────────────────────────────────────────────
 *
 * Le profil vit EN CLAIR sur le disque, contrairement aux sessions chiffrées
 * en base. D'où les droits 0700, et un dossier par couple utilisateur/service.
 * C'est un compromis assumé : sans lui, ces sites sont hors de portée.
 *
 * Il pèse quelques mégaoctets, contre quelques kilo-octets pour une session.
 */
async function persistentLauncher({ display, url, screen, home, profil }) {
  const { chromium } = require('playwright');

  // 0700, et créé avant le lancement : Chromium ne crée pas l'arborescence.
  nodeFs.mkdirSync(profil, { recursive: true, mode: 0o700 });
  try { nodeFs.chmodSync(profil, 0o700); } catch { /* déjà correct */ }

  // ⚠ Les options viennent d'UN SEUL endroit, `browserLaunchOptions()`, et ce
  // lanceur n'en ajoute plus aucune. C'est lui qui portait à lui seul
  // `--disable-blink-features=AutomationControlled` — celui qui, avec le profil
  // persistant, fait la différence face à Cloudflare, et sans lequel Google
  // refuse d'afficher son formulaire. Un drapeau vital détenu par un seul
  // lanceur est un drapeau que les autres n'ont pas : il est remonté dans les
  // options communes au lot 22, et tout ce qui s'ouvre ici le porte.
  const options = browserLaunchOptions({ display, screen, home });
  const context = await chromium.launchPersistentContext(profil, {
    ...options,
    ...identity.optionsContexte({ viewport: null }),
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

  return {
    page,
    context,
    // Rien à capturer : le profil EST la session, et il est déjà sur disque.
    // On rend quand même l'état pour les appelants qui l'attendent — il sert
    // au contrôle de validité, pas à l'enregistrement.
    storageState: () => context.storageState(),
    persistent: true,
    profil,
    close: () => fermerPagesPuisContexte(context),
  };
}

/**
 * Ferme chaque page AVANT le contexte, au mieux.
 *
 * Un contexte persistant fermé pages ouvertes laisse Chromium mémoriser la
 * pile d'onglets (`Default/Sessions/`), que `restore_on_startup = 1` — posé
 * pour garder les cookies de session, mesure du 12/08/2026 — restaure à
 * l'ouverture suivante : constaté le 19/08/2026 en production, une fenêtre de
 * connexion ouverte sur ~30 onglets. Fermer les pages d'abord laisse une pile
 * vide. Une page qui refuse de se fermer n'empêche rien : l'erreur est avalée,
 * dite au journal, et le contexte se ferme quand même.
 */
async function fermerPagesPuisContexte(context) {
  for (const page of context.pages()) {
    try {
      await page.close();
    } catch (err) {
      try {
        require('./applog').info(
          'remote-browser',
          `Une page n'a pas pu être refermée avant la fermeture du navigateur : ${err?.message || err}`
        );
      } catch {
        /* le journal lui-même est en panne : rien à faire de mieux */
      }
    }
  }
  await context.close();
}

async function defaultLauncher({ display, url, screen, home, profil }) {
  // Un connecteur qui déclare `remoteLogin.persistent` passe par le profil
  // persistant : sa session ne survivrait pas autrement.
  if (profil) return persistentLauncher({ display, url, screen, home, profil });

  const { chromium } = require('playwright');
  const browser = await chromium.launch(browserLaunchOptions({ display, screen, home }));

  // Même identité que les connecteurs, et pour la même raison : le navigateur
  // distant sert à ouvrir une session sur le portail que le connecteur ira
  // ensuite rejouer. Deux agents différents pour un même compte, c'est
  // exactement le genre d'écart qu'un pare-feu applicatif relève.
  // Ici le mode est VISIBLE, donc pas de « HeadlessChrome » à corriger — mais
  // la session capturée doit ressembler à celle que le connecteur rejouera.
  const context = await browser.newContext(
    identity.optionsContexte({ viewport: null }) // la fenêtre fait la loi
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  return {
    page,
    context,
    storageState: () => context.storageState(),
    close: () => browser.close(),
  };
}

// ---------------------------------------------------------------------------
// Singleton du service
// ---------------------------------------------------------------------------

let instance = null;

/** Le gestionnaire du processus. Créé à la première demande. */
function manager() {
  if (!instance) instance = createManager();
  return instance;
}

module.exports = {
  persistentLauncher,
  fermerPagesPuisContexte,
  DISPLAY_MIN,
  DISPLAY_MAX,
  SESSION_TIMEOUT_MS,
  DELAI_FRAPPE_MS,
  SAISIE_MAX_CARACTERES,
  MEMOIRE_LIBRE_MINIMALE_MO,
  MEMOIRE_TOTALE_MINIMALE_MO,
  SCREEN,
  BINAIRES,
  NOVNC_CANDIDATS,
  BROWSER_HOME_DIRNAME,
  createManager,
  defaultRuntime,
  defaultLauncher,
  browserLaunchOptions,
  checkPrerequisites,
  findNovnc,
  vncPortFor,
  wsPortFor,
  manager,
};
