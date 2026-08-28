'use strict';

/**
 * Navigateur distant — cycle de vie complet, SANS navigateur.
 *
 * Aucun Xvfb, aucun x11vnc, aucun Chromium n'est lancé ici, et c'est le point :
 * `server/remote-browser.js` emprunte tout ce qui touche au système à un
 * « runtime » injectable (`spawn`, `fs`, `os`, `now`, `kill`, `launchBrowser`).
 * On lui en fournit un simulé, et on vérifie ce qui ne se voit pas à l'écran :
 * l'allocation d'affichage, le verrou d'unicité, l'extinction après délai, le
 * nettoyage des orphelins, le refus d'un jeton d'un autre compte, et la
 * dégradation quand les paquets système manquent.
 *
 * C'était une exigence explicite de la mission du lot 6 : la suite doit rester
 * exécutable en intégration, sur une machine qui n'a ni serveur X ni paquet
 * VNC — exactement le cas de la machine de développement.
 *
 * ⚠️ Ce que ces tests NE prouvent PAS : qu'un pixel arrive à l'écran. Le flux
 * VNC, le client noVNC et la mise à l'échelle ne s'observent qu'à l'œil, sur
 * une instance réelle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const remoteBrowser = require('../server/remote-browser');
const detection = require('../server/connectors/login-detection');
const schema = require('../server/connectors/manifest-schema');
const remoteLoginRoute = require('../server/routes/remote-login');

// ---------------------------------------------------------------------------
// Doubles de système
// ---------------------------------------------------------------------------

/**
 * Système de fichiers simulé : un ensemble de chemins existants, un dictionnaire
 * de contenus, et la trace de tout ce qui a été écrit ou effacé.
 */
function fakeFs({ present = [], contents = {} } = {}) {
  const existants = new Set(present);
  const ecrits = new Map();
  const effaces = [];

  return {
    existants,
    ecrits,
    effaces,
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => {
      if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`);
    },
    readdirSync: (dir) => {
      const entries = contents[String(dir)];
      if (!entries) throw new Error(`ENOENT ${dir}`);
      return entries;
    },
    readFileSync: (p) => {
      const value = contents[String(p)];
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    },
    writeFileSync: (p, data) => {
      existants.add(String(p));
      ecrits.set(String(p), String(data));
    },
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => {
      existants.delete(String(p));
      effaces.push(String(p));
    },
  };
}

/** Processus simulé : il retient son nom, ses arguments et ses signaux. */
function fakeSpawn(journal, { onSpawn = () => {} } = {}) {
  return (command, args) => {
    const child = {
      command,
      args: args.map(String),
      signals: [],
      stdout: { resume: () => {} },
      stderr: { resume: () => {} },
      on: () => {},
      kill: (signal) => child.signals.push(signal),
    };
    journal.push(child);
    onSpawn(child);
    return child;
  };
}

/**
 * Page Playwright simulée.
 *
 * `ecrans` est la suite des écrans que la page traverse ; chaque lecture par
 * `login-detection.inspect()` fait avancer d'un cran, et le dernier écran vaut
 * pour toutes les lectures suivantes. C'est ce qui permet d'écrire « au
 * troisième coup d'œil, l'utilisateur est connecté » sans horloge ni minuterie.
 */
function fakePage(ecrans) {
  let lectures = 0;
  const courant = () => ecrans[Math.min(lectures, ecrans.length - 1)];

  const page = {
    get lectures() {
      return lectures;
    },
    /**
     * Le champ actif simulé.
     *
     * ─── Pourquoi ce champ existe (lot 13) ─────────────────────────────────
     *
     * `typeText()` vérifie désormais qu'un champ modifiable a le focus AVANT
     * de frapper, et que sa longueur a AUGMENTÉ après. C'est ce contrôle qui
     * manquait : jusqu'au lot 12, le double posait un `keyboard.type()` qui ne
     * faisait rien, le test constatait qu'il n'avait pas levé d'exception, et
     * concluait au succès — soit exactement le mensonge que l'interface
     * servait à l'utilisateur.
     *
     * Un double qui ne peut pas échouer ne prouve rien. Celui-ci compte.
     */
    champ: { editable: true, tag: 'input', longueur: 0 },
    url: () => {
      lectures += 1;
      return courant().url;
    },
    locator: (selecteur) => ({
      count: async () => courant()[selecteur] || 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => (courant().marqueur ? 1 : 0) }),
    evaluate: async () => (page.champ ? { ...page.champ } : null),
    // Un clavier qui écrit vraiment quelque part : c'est le minimum pour que
    // le contrôle d'arrivée du texte ait un sens.
    keyboard: {
      type: async (texte) => {
        if (page.champ?.editable) page.champ.longueur += String(texte).length;
      },
    },
  };

  return page;
}

const ECRAN_CONNEXION = {
  url: 'https://mobile.free.fr/account/v2/login',
  [detection.SELECTEUR_MOT_DE_PASSE]: 1,
};
const ECRAN_CODE = {
  // Piège du lot 5 : ni « otp » dans l'URL, ni champ « password » à l'écran.
  url: 'https://mobile.free.fr/account/v2/validation',
  [detection.SELECTEUR_CHAMP_CODE]: 6,
};
const ECRAN_CONNECTE = {
  // Piège inverse : « login » y est un paramètre de ligne, pas une page de
  // connexion. Chercher le mot dans l'URL entière ferait attendre pour rien.
  url: 'https://mobile.free.fr/account/v2?login=94994336',
  marqueur: true,
};

/** Un gestionnaire complet, avec son système simulé. */
function makeManager({
  ecrans = [ECRAN_CONNEXION, ECRAN_CONNEXION, ECRAN_CONNECTE],
  binaires = ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify'],
  novnc = true,
  totalMb = 4096,
  freeMb = 2600,
  contents = {},
  timeoutMs = 5_000,
  storageState = { cookies: [{ name: 'sess', value: 'x', domain: '.free.fr', expires: -1 }] },
  // Le Playwright de l'ESSAI de session (lot 32) : injecté pour que la sonde
  // et le contrôle d'enregistrement s'exécutent sans navigateur réel.
  requirePlaywright = null,
  // Le délai du second rideau SIGKILL (lot 35) : court dans les tests qui le
  // prouvent, valeur de production (2 s) partout ailleurs.
  escalationMs = null,
  // Lot 43 — remplacer le lanceur simulé, pour jouer un Chromium qui meurt
  // sur le verrou de SON profil (« ProcessSingleton »).
  launchBrowser = null,
} = {}) {
  const processus = [];
  const journal = [];
  const tues = [];
  const fs = fakeFs({
    present: [
      ...binaires,
      ...(novnc ? ['/usr/share/novnc/core/rfb.js'] : []),
    ],
    contents,
  });
  const page = fakePage(ecrans);
  const lancements = [];
  let ferme = 0;

  const manager = remoteBrowser.createManager({
    fs,
    os: {
      totalmem: () => totalMb * 1024 * 1024,
      freemem: () => freeMb * 1024 * 1024,
    },
    // Xvfb pose sa socket : sans ça, `waitForDisplay()` attendrait quinze
    // secondes puis refuserait, exactement comme sans le paquet xvfb.
    spawn: fakeSpawn(processus, {
      onSpawn: (child) => {
        if (child.command !== 'Xvfb') return;
        const display = /^:(\d+)$/.exec(child.args[0])?.[1];
        if (display) fs.existants.add(`/tmp/.X11-unix/X${display}`);
      },
    }),
    kill: (pid, signal) => tues.push({ pid, signal }),
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message) => journal.push({ level, message }),
    // Les vraies attentes rendraient la suite interminable : on garde un vrai
    // passage par la boucle d'événements (les minuteries doivent pouvoir se
    // déclencher), mais borné à quelques millisecondes.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    // On retient CE QUI EST DEMANDÉ au navigateur, pas seulement le fait qu'il
    // ait été lancé : c'est dans ces options que se cachait le défaut qui a
    // rendu le lot 6 inutilisable en production (HOME absent).
    launchBrowser: launchBrowser || (async (options) => {
      lancements.push(options);
      return {
        page,
        storageState: async () => storageState,
        close: async () => {
          ferme += 1;
        },
      };
    }),
    timeoutMs,
    pollMs: 4,
    ...(escalationMs ? { escalationMs } : {}),
    ...(requirePlaywright ? { requirePlaywright } : {}),
  });

  return {
    manager,
    fs,
    page,
    processus,
    journal,
    tues,
    lancements,
    get fermetures() {
      return ferme;
    },
  };
}

/** Attend qu'une condition devienne vraie, ou renonce. */
async function attendre(condition, { limiteMs = 4000 } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

/** Options d'ouverture minimales. */
function ouverture(extra = {}) {
  return {
    userId: 1,
    connectorId: 'free-mobile',
    connectorName: 'Free Mobile',
    url: 'https://mobile.free.fr/account/v2/login',
    marker: 'Mes factures',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Prérequis système
// ---------------------------------------------------------------------------

test('prérequis absents : refus expliqué, avec le remède et le repli', () => {
  const { manager } = makeManager({ binaires: [], novnc: false });
  const check = manager.checkPrerequisites();

  assert.equal(check.ok, false);
  assert.deepEqual(
    check.missing.map((m) => m.id).sort(),
    ['Xvfb', 'novnc', 'websockify', 'x11vnc']
  );
  for (const manque of check.missing) {
    assert.ok(manque.remedy.startsWith('apt install'), `${manque.id} : remède attendu`);
    assert.ok(manque.detail.length > 20, `${manque.id} : dire à quoi il sert`);
  }
  // La phrase affichée sous le bouton grisé doit nommer le repli : un bouton
  // qui ne marche pas sans dire quoi faire est pire que pas de bouton.
  assert.match(check.reason, /fichier de session/);
});

test('prérequis absents : la session est refusée AVANT d\'allouer quoi que ce soit', async () => {
  const contexte = makeManager({ binaires: [], novnc: false });

  await assert.rejects(() => contexte.manager.start(ouverture()), (err) => {
    assert.equal(err.statusCode, 503);
    assert.equal(err.expose, true);
    assert.match(err.message, /fichier de session/);
    return true;
  });

  assert.equal(contexte.processus.length, 0, 'aucun processus ne doit avoir été lancé');
  assert.deepEqual(contexte.manager.reservedDisplays, [], 'aucun affichage ne doit rester pris');
});

test('mémoire insuffisante : le refus le dit, plutôt que de laisser Chromium mourir', async () => {
  const contexte = makeManager({ freeMb: 300 });

  await assert.rejects(() => contexte.manager.start(ouverture()), (err) => {
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /300 Mo libres/);
    assert.match(err.message, /fichier de session/);
    return true;
  });
  assert.equal(contexte.processus.length, 0);
});

test('conteneur trop petit : la mémoire totale figure dans les manques', () => {
  const { manager } = makeManager({ totalMb: 1024 });
  const check = manager.checkPrerequisites();

  const memoire = check.missing.find((m) => m.id === 'memoire');
  assert.ok(memoire, 'un conteneur de 1 Go doit être signalé');
  assert.match(memoire.remedy, /4 Go|4096/);
});

// ---------------------------------------------------------------------------
// Affichages
// ---------------------------------------------------------------------------

test('allocation d\'affichage : le premier libre, puis le suivant, puis la libération', () => {
  const { manager } = makeManager();

  assert.equal(manager.allocateDisplay(), remoteBrowser.DISPLAY_MIN);
  assert.equal(manager.allocateDisplay(), remoteBrowser.DISPLAY_MIN + 1);
  assert.deepEqual(manager.reservedDisplays, [
    remoteBrowser.DISPLAY_MIN,
    remoteBrowser.DISPLAY_MIN + 1,
  ]);

  manager.releaseDisplay(remoteBrowser.DISPLAY_MIN);
  assert.deepEqual(manager.reservedDisplays, [remoteBrowser.DISPLAY_MIN + 1]);
  // Rendu, il est repris en premier : la plage ne dérive pas à chaque session.
  assert.equal(manager.allocateDisplay(), remoteBrowser.DISPLAY_MIN);
});

test('un affichage dont la socket X traîne est sauté, pas écrasé', () => {
  const contexte = makeManager();
  contexte.fs.existants.add(`/tmp/.X11-unix/X${remoteBrowser.DISPLAY_MIN}`);

  assert.equal(contexte.manager.isDisplayFree(remoteBrowser.DISPLAY_MIN), false);
  assert.equal(contexte.manager.allocateDisplay(), remoteBrowser.DISPLAY_MIN + 1);
});

test('plage saturée : le refus dit quoi faire, il ne se contente pas d\'échouer', () => {
  const contexte = makeManager();
  for (let d = remoteBrowser.DISPLAY_MIN; d <= remoteBrowser.DISPLAY_MAX; d++) {
    contexte.fs.existants.add(`/tmp/.X11-unix/X${d}`);
  }

  assert.throws(() => contexte.manager.allocateDisplay(), (err) => {
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /Redémarrez le service crabe/);
    return true;
  });
});

test('libérer un affichage efface la socket et le verrou laissés par le serveur X', () => {
  const contexte = makeManager();
  contexte.fs.existants.add('/tmp/.X11-unix/X99');
  contexte.fs.existants.add('/tmp/.X99-lock');

  contexte.manager.releaseDisplay(99);

  assert.ok(contexte.fs.effaces.includes('/tmp/.X11-unix/X99'));
  assert.ok(contexte.fs.effaces.includes('/tmp/.X99-lock'));
});

// ---------------------------------------------------------------------------
// Répertoire personnel du navigateur (correctif du lot 7)
//
// C'est LE défaut qui a rendu le lot 6 inutilisable en production alors que
// les 408 tests étaient au vert : le compte système `crabe` est créé avec
// --no-create-home, son HOME (/home/crabe) n'existe pas, et Chromium visible
// meurt en tentant d'y écrire la base de son gestionnaire de plantage.
//
// Le genre de défaut qui ne se voit qu'en production — donc exactement celui
// qu'il faut border ici.
// ---------------------------------------------------------------------------

const nodeFsReel = require('node:fs');
const nodeOsReel = require('node:os');
const nodePathReel = require('node:path');

test('le navigateur reçoit un dossier personnel, créé s\'il manque', async () => {
  const contexte = makeManager();

  // Le dossier n'existe pas au départ : c'est bien le cas de production.
  assert.equal(contexte.fs.existsSync('/tmp/crabe-run/navigateur'), false);

  await contexte.manager.start(ouverture());

  assert.equal(contexte.lancements.length, 1, 'un seul navigateur lancé');
  assert.equal(
    contexte.lancements[0].home,
    '/tmp/crabe-run/navigateur',
    'le dossier personnel doit être sous le répertoire de données de crabe'
  );
  assert.ok(
    contexte.fs.existsSync('/tmp/crabe-run/navigateur'),
    'il doit avoir été créé avant le lancement'
  );

  await contexte.manager.stop(1, 'free-mobile');
});

test('dossier personnel impossible à écrire : refus lisible, pas un SIGTRAP', async () => {
  const contexte = makeManager();
  // Un système de fichiers qui refuse la création : partition pleine, chemin
  // hors ReadWritePaths, propriétaire incorrect — tous donnent ceci.
  contexte.fs.mkdirSync = () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  };

  await assert.rejects(
    () => contexte.manager.start(ouverture()),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.expose, true);
      assert.match(err.message, /navigateur/i);
      assert.match(err.message, /ReadWritePaths/, 'le message doit dire quoi vérifier');
      return true;
    }
  );

  // Et surtout : rien ne reste réservé derrière un lancement refusé.
  assert.deepEqual(contexte.manager.reservedDisplays, []);
  assert.equal(contexte.manager.current, null);
});

test('l\'environnement transmis au navigateur porte un HOME existant et inscriptible', () => {
  // Ici on ne simule rien : un VRAI répertoire, sur le VRAI système de
  // fichiers. Un HOME « présent dans l'objet env » ne prouve rien — c'est
  // exactement le piège dans lequel la production est tombée.
  const home = nodeFsReel.mkdtempSync(nodePathReel.join(nodeOsReel.tmpdir(), 'crabe-home-'));

  const options = remoteBrowser.browserLaunchOptions({
    display: 99,
    screen: remoteBrowser.SCREEN,
    home,
    env: { PATH: '/usr/bin', HOME: '/home/crabe' },
  });

  assert.equal(options.headless, false, 'le mode visible est tout l\'intérêt du module');
  assert.equal(options.env.DISPLAY, ':99');
  assert.equal(options.env.HOME, home, 'le HOME du service ne doit PAS être conservé');

  // Les deux vérifications qui comptent vraiment.
  assert.ok(nodeFsReel.existsSync(options.env.HOME), 'le HOME transmis doit exister');
  assert.doesNotThrow(
    () => nodeFsReel.accessSync(options.env.HOME, nodeFsReel.constants.W_OK),
    'le HOME transmis doit être accessible en écriture'
  );

  // Le gestionnaire de plantage, dont crabe n'a aucun usage, est neutralisé.
  assert.ok(options.args.includes('--disable-crashpad'));
  assert.ok(options.args.includes('--disable-crash-reporter'));
  // Non-régression du lot 6 : le conteneur reste un conteneur.
  assert.ok(options.args.includes('--no-sandbox'));
  assert.ok(options.args.includes('--disable-dev-shm-usage'));

  nodeFsReel.rmSync(home, { recursive: true, force: true });
});

test('le bac à sable de Chromium reste rétablissable par variable d\'environnement', () => {
  const options = remoteBrowser.browserLaunchOptions({
    display: 99,
    screen: remoteBrowser.SCREEN,
    home: '/opt/crabe/data/navigateur',
    env: { CRABE_REMOTE_BROWSER_SANDBOX: '1' },
  });
  assert.equal(options.args.includes('--no-sandbox'), false);
  // Le correctif du HOME, lui, n'est jamais optionnel.
  assert.equal(options.env.HOME, '/opt/crabe/data/navigateur');
});

test('l\'image Docker livrée pose un HOME sous le répertoire de données', () => {
  // Une installation neuve doit être correcte SANS que le code ait à rattraper
  // quoi que ce soit : Chromium exige un HOME inscriptible, et le seul endroit
  // inscriptible qui survit aux redémarrages est le volume de données.
  const dockerfile = nodeFsReel.readFileSync(
    nodePathReel.resolve(__dirname, '..', 'Dockerfile'),
    'utf8'
  );
  const home = /^\s*HOME=(\S+?)\s*\\?$/m.exec(dockerfile)?.[1];
  const dataDir = /^\s*CRABE_DATA_DIR=(\S+?)\s*\\?$/m.exec(dockerfile)?.[1];

  assert.ok(home, 'le Dockerfile doit poser ENV HOME');
  assert.ok(dataDir, 'le Dockerfile doit poser ENV CRABE_DATA_DIR');
  assert.equal(home, `${dataDir}/${remoteBrowser.BROWSER_HOME_DIRNAME}`);
});

// ---------------------------------------------------------------------------
// Le marqueur d'automatisation (lot 22)
//
// Ce que ces deux tests protègent tient en une phrase : **un drapeau vital que
// seul un lanceur porte est un drapeau que les autres n'ont pas.**
//
// Le lot 11 a ajouté `--disable-blink-features=AutomationControlled` au lanceur
// à profil persistant, écrit contre Cloudflare, en le concaténant APRÈS les
// options communes. Le lanceur ordinaire — celui de tous les connecteurs à
// session capturée — ne l'a jamais eu, et rien ne pouvait le montrer : Free
// Mobile, seul à l'emprunter, ne passe pas par une garde qui le remarque.
//
// Le lot 21 en a amené trois d'un coup qui passent par Google (Mistral,
// Anthropic, Envato). Google lit `navigator.webdriver` et refuse d'afficher son
// formulaire quand il le voit — l'utilisateur n'atteignait même pas la saisie,
// et `run_logs` restait vide puisque le connecteur n'était jamais appelé.
// ---------------------------------------------------------------------------

test('les options de lancement portent le drapeau anti-détection, bac à sable ou non', () => {
  const commun = {
    display: 99,
    screen: remoteBrowser.SCREEN,
    home: '/opt/crabe/data/navigateur',
  };
  const drapeau = '--disable-blink-features=AutomationControlled';

  for (const env of [{ PATH: '/usr/bin' }, { CRABE_REMOTE_BROWSER_SANDBOX: '1' }]) {
    const options = remoteBrowser.browserLaunchOptions({ ...commun, env });
    assert.ok(
      options.args.includes(drapeau),
      `sans ${drapeau}, Google affiche « ce navigateur peut ne pas être sécurisé » `
        + 'et la connexion s\'arrête avant la première saisie'
    );
  }
});

test('tout lanceur de remote-browser.js porte le même drapeau anti-détection', () => {
  // Sur le modèle du garde-fou du lot 12 (test/browser-identity.test.js) : on
  // lit le SOURCE, parce qu'un lanceur écrit demain ne serait sinon couvert par
  // aucun test tant que personne n'y penserait.
  const source = nodeFsReel.readFileSync(
    nodePathReel.resolve(__dirname, '..', 'server', 'remote-browser.js'),
    'utf8'
  );

  // Les fonctions dont le nom finit par « Launcher », corps compris. Leur
  // accolade fermante est en colonne 0 : ce sont des fonctions de premier
  // niveau, et c'est ce qui rend la découpe fiable.
  const lanceurs = [...source.matchAll(/(?:async )?function (\w*Launcher)\(([\s\S]*?)\n}/g)]
    .map(([, nom, corps]) => ({ nom, corps }));

  assert.ok(lanceurs.length >= 2, `${lanceurs.length} lanceur(s) trouvé(s), c'est trop peu`);

  for (const { nom, corps } of lanceurs) {
    // Un lanceur qui n'ouvre rien lui-même (il délègue) n'a rien à porter.
    if (!/chromium\.launch/.test(corps)) continue;

    // 1. Ses options viennent de la fabrique commune, jamais d'une liste à lui.
    assert.match(
      corps,
      /browserLaunchOptions\(/,
      `${nom} construit ses options lui-même : il repartirait sans le drapeau `
        + 'anti-détection, et Google refuserait la connexion sans rien expliquer'
    );

    // 2. Et il ne rallonge pas la liste d'arguments après coup. C'est exactement
    //    ce qui avait fait diverger les deux lanceurs pendant dix lots.
    assert.doesNotMatch(
      corps,
      /args:\s*\[/,
      `${nom} rallonge la liste d'arguments après coup : ce qu'il y ajoute `
        + 'manquera à tous les autres lanceurs, sans que rien ne le signale'
    );
  }
});

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

test('cycle complet : trois processus, un navigateur, une session enregistrée, tout éteint', async () => {
  const contexte = makeManager();
  const captures = [];

  const vue = await contexte.manager.start(
    ouverture({
      onDetected: async (etat) => {
        captures.push(etat);
        return { fieldKey: 'session', summary: { cookieCount: etat.cookies.length } };
      },
    })
  );

  // La vue rendue au client porte de quoi brancher l'écran, et rien de plus.
  assert.equal(vue.state, 'running');
  assert.ok(vue.token, 'un jeton d\'attachement doit être fourni');
  assert.ok(vue.vncPassword, 'noVNC a besoin du mot de passe de cette session');
  assert.equal(vue.sessionId.length > 0, true);
  assert.equal(vue.connectorName, 'Free Mobile');

  // Les trois auxiliaires, dans l'ordre, et sur la boucle locale seulement.
  assert.deepEqual(contexte.processus.map((p) => p.command), ['Xvfb', 'x11vnc', 'websockify']);
  const [xvfb, x11vnc, websockify] = contexte.processus;
  assert.equal(xvfb.args[0], ':99');
  assert.ok(xvfb.args.includes('-nolisten') && xvfb.args.includes('tcp'));
  assert.ok(x11vnc.args.includes('-localhost'), 'x11vnc doit rester sur 127.0.0.1');
  assert.deepEqual(
    x11vnc.args.slice(x11vnc.args.indexOf('-listen'), x11vnc.args.indexOf('-listen') + 2),
    ['-listen', '127.0.0.1']
  );
  for (const adresse of websockify.args) {
    assert.match(adresse, /^127\.0\.0\.1:\d+$/, 'websockify n\'écoute que sur la boucle locale');
  }

  // Le mot de passe VNC part dans un fichier, jamais sur une ligne de commande.
  const fichierMdp = [...contexte.fs.ecrits.keys()].find((f) => f.includes('.vnc-'));
  assert.ok(fichierMdp, 'le mot de passe VNC doit être écrit dans un fichier');
  assert.ok(x11vnc.args.includes(fichierMdp));
  assert.equal(
    x11vnc.args.some((a) => a === vue.vncPassword),
    false,
    'le mot de passe ne doit jamais figurer dans les arguments (ps le montrerait)'
  );

  // Puis la connexion est détectée — mais sans page de contrôle, elle n'est
  // PLUS enregistrée d'office (hotfix du 18/08/2026 au soir : 12 cookies
  // anonymes « capturés » 5 secondes après l'ouverture). La fenêtre attend
  // le geste de l'utilisateur, et le message le dit.
  assert.ok(
    await attendre(() => contexte.manager.status(1, 'free-mobile')?.attenteManuelle === true),
    'la session aurait dû attendre le clic « Enregistrer »'
  );
  const enAttente = contexte.manager.status(1, 'free-mobile');
  assert.equal(enAttente.state, 'running');
  assert.match(enAttente.message, /ne peut pas être vérifiée automatiquement/);
  assert.equal(captures.length, 0, 'rien ne doit être enregistré avant le clic');

  // « Enregistrer » — la parole de l'utilisateur remplace le contrôle absent.
  // Sans aucune saisie dans la fenêtre (hotfix du 19/08/2026 : 21 cookies
  // anonymes enregistrés sur un clic réflexe à 7 secondes), le PREMIER clic
  // est retenu avec un message de confirmation ; le second passe.
  const premierClic = await contexte.manager.saveNow(1, 'free-mobile');
  assert.equal(premierClic.ok, false, 'le premier clic sans saisie doit être retenu');
  assert.match(premierClic.error, /Rien n'a encore été saisi/);
  const clic = await contexte.manager.saveNow(1, 'free-mobile');
  assert.equal(clic.ok, true, clic.error || '');
  assert.ok(await attendre(() => captures.length > 0), 'le clic aurait dû enregistrer la session');

  const finale = contexte.manager.status(1, 'free-mobile');
  assert.equal(finale.state, 'saved');
  assert.equal(finale.done, true);
  assert.equal(finale.result.summary.cookieCount, 1);
  assert.equal(finale.vncPassword, null, 'plus de mot de passe une fois la session finie');

  // Extinction : navigateur fermé, trois processus arrêtés, affichage rendu.
  assert.equal(contexte.fermetures, 1);
  for (const child of contexte.processus) {
    assert.deepEqual(child.signals, ['SIGTERM'], `${child.command} doit être arrêté`);
  }
  assert.deepEqual(contexte.manager.reservedDisplays, []);
  assert.equal(contexte.fs.effaces.includes(fichierMdp), true, 'le fichier de mot de passe doit disparaître');
  assert.equal(contexte.manager.current, null, 'le verrou doit être rendu');
});

test('la détection n\'accepte pas un écran de code de validation', async () => {
  const contexte = makeManager({
    // Le parcours complet : mot de passe, puis code SMS, puis le compte.
    ecrans: [ECRAN_CONNEXION, ECRAN_CODE, ECRAN_CODE, ECRAN_CONNECTE],
  });
  const captures = [];

  await contexte.manager.start(ouverture({ onDetected: async (etat) => void captures.push(etat) }));
  // La détection conclut, la session attend le clic (hotfix du 18/08/2026),
  // et c'est « Enregistrer » qui enregistre — comme un utilisateur réel.
  assert.ok(
    await attendre(() => contexte.manager.status(1, 'free-mobile')?.attenteManuelle === true)
  );
  // Premier clic sans saisie retenu (hotfix du 19/08/2026), le second passe.
  await contexte.manager.saveNow(1, 'free-mobile');
  await contexte.manager.saveNow(1, 'free-mobile');
  assert.ok(await attendre(() => captures.length > 0));

  // Quatre lectures au moins : deux écrans refusés, puis la confirmation en
  // deux temps. Si la grille de code avait été prise pour une connexion, la
  // capture serait tombée bien plus tôt.
  assert.ok(contexte.page.lectures >= 4, `lectures : ${contexte.page.lectures}`);
});

test('verrou d\'unicité : une seule session sur toute l\'instance', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  await contexte.manager.start(ouverture());

  // Le même compte : on le renvoie vers SA session, il n'a rien perdu.
  await assert.rejects(() => contexte.manager.start(ouverture()), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /déjà ouverte pour votre compte/);
    return true;
  });

  // Un autre compte : on ne lui dit pas à qui, seulement qu'il faut attendre.
  await assert.rejects(() => contexte.manager.start(ouverture({ userId: 2 })), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Un seul navigateur peut tourner à la fois/);
    assert.equal(/compte|utilisateur \d/.test(err.message), false, 'ne pas désigner l\'occupant');
    return true;
  });

  assert.equal(contexte.processus.length, 3, 'aucun second jeu de processus');
  await contexte.manager.stopAll();
});

// ---------------------------------------------------------------------------
// Le verrou de PROFIL (lot 43) — mesuré le 19/08/2026 à 23:39 : une fenêtre
// « Se connecter » ouverte pendant une récupération SNCF mourait sur le
// message brut de Playwright (« browserType.launchPersistentContext: …
// profile is already in use »). Le profil persistant est désormais arbitré
// par le même verrou des deux côtés (connectors/inflight.js).
// ---------------------------------------------------------------------------

test('verrou de profil : la fenêtre le tient pendant la session, et le rend éteinte', async () => {
  const inflight = require('../server/connectors/inflight');
  const cle = inflight.profilKey(1, 'free-mobile');
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  try {
    // Profil LIBRE : l'ouverture est permise.
    const vue = await contexte.manager.start(ouverture({ persistent: true }));
    assert.equal(vue.state, 'running', 'profil libre : la fenêtre s\'ouvre');
    assert.equal(inflight.profil.busy(cle), true, 'le profil est marqué en usage');
    assert.equal(inflight.profil.holder(cle), inflight.PORTEUR_FENETRE);
  } finally {
    await contexte.manager.stopAll();
  }
  assert.equal(inflight.profil.busy(cle), false, 'le verrou est rendu avec la session');
});

test('profil tenu par une récupération : la fenêtre REFUSE, en français, sans rien lancer', async () => {
  const inflight = require('../server/connectors/inflight');
  const cle = inflight.profilKey(7, 'sncf-connect');
  inflight.profil.acquire(cle, inflight.PORTEUR_RECUPERATION);
  const contexte = makeManager();
  try {
    await assert.rejects(
      () => contexte.manager.start(ouverture({
        userId: 7,
        connectorId: 'sncf-connect',
        connectorName: 'SNCF Connect',
        persistent: true,
      })),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /Une récupération SNCF Connect est en cours sur ce serveur/);
        assert.match(err.message, /Attendez qu'elle se termine/);
        // Le message du 19/08/2026 ne doit JAMAIS revenir : ni l'API de
        // Playwright, ni une ligne de commande ou un nom de navigateur.
        assert.doesNotMatch(
          err.message,
          /launchPersistentContext|user-data-dir|chromium|chrome|profile is already in use|browserType/i
        );
        return true;
      }
    );
    assert.equal(contexte.lancements.length, 0, 'aucun navigateur lancé');
    assert.equal(contexte.processus.length, 0, 'ni Xvfb, ni x11vnc, ni websockify');
  } finally {
    inflight.profil.release(cle);
  }
});

test('une fenêtre SANS profil persistant ignore le verrou de profil', async () => {
  const inflight = require('../server/connectors/inflight');
  // Même couple (compte, connecteur) tenu par une récupération : une fenêtre
  // à session CAPTURÉE n'ouvre aucun profil, elle n'a rien à attendre.
  const cle = inflight.profilKey(1, 'free-mobile');
  inflight.profil.acquire(cle, inflight.PORTEUR_RECUPERATION);
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  try {
    const vue = await contexte.manager.start(ouverture());
    assert.equal(vue.state, 'running');
  } finally {
    await contexte.manager.stopAll();
    inflight.profil.release(cle);
  }
});

test('si Chromium meurt quand même sur SON verrou de profil, le message est réécrit en français', async () => {
  // Le filet sous le verrou : un Chromium survivant qui tient le profil sans
  // être passé par inflight. Le lanceur meurt comme Playwright le 19/08/2026.
  const contexte = makeManager({
    launchBrowser: async () => {
      throw new Error(
        'browserType.launchPersistentContext: Opening in existing browser session. This usually '
          + 'means that the profile is already in use by another instance of Chromium.'
      );
    },
  });
  await assert.rejects(
    () => contexte.manager.start(ouverture({
      connectorId: 'sncf-connect',
      connectorName: 'SNCF Connect',
      persistent: true,
    })),
    (err) => {
      assert.match(err.message, /navigateur enregistré de SNCF Connect est déjà ouvert/);
      assert.match(err.message, /Attendez qu'elle se termine/);
      assert.doesNotMatch(err.message, /launchPersistentContext|browserType|profile is already in use/i);
      return true;
    }
  );
  // Et le verrou pris à l'ouverture est rendu : la panne ne bloque pas 15 min.
  const inflight = require('../server/connectors/inflight');
  assert.equal(inflight.profil.busy(inflight.profilKey(1, 'sncf-connect')), false);
});

test('délai dépassé : extinction d\'office, et rien n\'est enregistré', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION], timeoutMs: 120 });
  let enregistrements = 0;

  await contexte.manager.start(ouverture({ onDetected: async () => void (enregistrements += 1) }));

  assert.ok(
    await attendre(() => contexte.manager.status(1, 'free-mobile')?.state === 'timeout'),
    'la session aurait dû expirer'
  );

  const vue = contexte.manager.status(1, 'free-mobile');
  assert.match(vue.message, /dix minutes/);
  assert.equal(enregistrements, 0, 'une session inaboutie ne s\'enregistre pas');
  assert.equal(contexte.fermetures, 1, 'le navigateur doit être fermé');
  for (const child of contexte.processus) assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual(contexte.manager.reservedDisplays, []);
  assert.equal(contexte.manager.current, null);
});

test('un auxiliaire qui ignore SIGTERM reçoit SIGKILL — plus jamais deux websockify sur un port (lot 35)', async () => {
  const contexte = makeManager({ escalationMs: 20 });
  await contexte.manager.start(ouverture());

  // Les trois auxiliaires tournent. Deux « meurent » proprement au SIGTERM
  // (ils posent leur signalCode, comme un vrai processus) ; websockify, lui,
  // l'ignore — l'état exact du survivant du 15/08/2026, qui a fini par
  // partager son port 6180 avec le websockify de la session suivante.
  const [xvfb, x11vnc, websockify] = contexte.processus;
  assert.equal(websockify.command, 'websockify', 'l\'ordre de lancement fait foi');
  for (const docile of [xvfb, x11vnc]) {
    docile.kill = (signal) => {
      docile.signals.push(signal);
      docile.signalCode = signal;
    };
  }

  await contexte.manager.stop(1, 'free-mobile');
  assert.deepEqual(websockify.signals, ['SIGTERM'], 'la demande polie part d\'abord');

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(websockify.signals, ['SIGTERM', 'SIGKILL'],
    'le survivant est tué pour de bon — le port sera vraiment libre');
  assert.deepEqual(xvfb.signals, ['SIGTERM'], 'un processus déjà mort n\'est pas re-signalé');
  assert.deepEqual(x11vnc.signals, ['SIGTERM']);
});

test('abandon : le navigateur s\'éteint, la place est rendue tout de suite', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  await contexte.manager.start(ouverture());

  const vue = await contexte.manager.stop(1, 'free-mobile');
  assert.equal(vue.state, 'cancelled');
  assert.equal(contexte.manager.current, null);
  assert.deepEqual(contexte.manager.reservedDisplays, []);

  // La place est libre : une nouvelle session part immédiatement.
  const suivante = await contexte.manager.start(ouverture());
  assert.equal(suivante.state, 'running');
  await contexte.manager.stopAll();
});

test('le mot de passe VNC n\'apparaît dans aucune ligne de journal', async () => {
  const contexte = makeManager();
  const vue = await contexte.manager.start(ouverture());
  await attendre(() => contexte.manager.status(1, 'free-mobile')?.done);

  assert.ok(contexte.journal.length > 0, 'la session doit être tracée');
  for (const ligne of contexte.journal) {
    assert.equal(
      ligne.message.includes(vue.vncPassword),
      false,
      `mot de passe VNC dans le journal : ${ligne.message}`
    );
    assert.equal(ligne.message.includes(vue.token), false, 'jeton dans le journal');
  }
  // Et la mémoire, elle, est bien journalisée : c'est ce qui permet de
  // comprendre un Chromium qui meurt.
  assert.ok(contexte.journal.some((l) => /Mo libres/.test(l.message)));
});

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

test('un jeton d\'un autre compte est refusé, et n\'est pas consommé au passage', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const vue = await contexte.manager.start(ouverture({ userId: 7 }));

  const vol = contexte.manager.consumeTicket(vue.token, 8);
  assert.equal(vol.ok, false);
  assert.equal(vol.session, null);
  // Message volontairement identique à celui d'un jeton inconnu : ne pas
  // confirmer à un tiers qu'un jeton existe.
  assert.match(vol.error, /inconnu ou déjà utilisé/);

  // Le propriétaire, lui, s'attache normalement : la tentative n'a rien cassé.
  const legitime = contexte.manager.consumeTicket(vue.token, 7);
  assert.equal(legitime.ok, true);
  assert.equal(legitime.session.connectorId, 'free-mobile');

  // Et il est à usage unique : le second passage échoue.
  assert.equal(contexte.manager.consumeTicket(vue.token, 7).ok, false);
  await contexte.manager.stopAll();
});

test('un jeton ne survit pas à l\'extinction de sa session', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const vue = await contexte.manager.start(ouverture());

  await contexte.manager.stop(1, 'free-mobile');
  assert.equal(contexte.manager.consumeTicket(vue.token, 1).ok, false);
});

test('un compte ne voit jamais la session d\'un autre, pas même son existence', async () => {
  const contexte = makeManager({ ecrans: [ECRAN_CONNEXION] });
  await contexte.manager.start(ouverture({ userId: 7 }));

  assert.equal(contexte.manager.status(8, 'free-mobile'), null);
  assert.equal(contexte.manager.status(8), null);
  assert.equal(await contexte.manager.stop(8, 'free-mobile'), null);
  // La session de l'autre est intacte : un tiers ne peut pas l'éteindre.
  assert.equal(contexte.manager.status(7, 'free-mobile').state, 'running');
  await contexte.manager.stopAll();
});

// ---------------------------------------------------------------------------
// Nettoyage des orphelins
// ---------------------------------------------------------------------------

test('nettoyage au démarrage : nos orphelins meurent, ceux des autres sont épargnés', () => {
  const nul = '\0';
  const contexte = makeManager({
    contents: {
      '/proc': ['1', '412', '413', '414', '415', '900', '901', '902', 'self', 'uptime'],
      // Les nôtres : le jeu complet sur :99, plus un Xvfb resté sur :100 —
      // deux redémarrages successifs laissent exactement ça derrière eux.
      '/proc/412/cmdline': `Xvfb${nul}:99${nul}-screen${nul}0${nul}1280x800x24${nul}`,
      '/proc/413/cmdline': `/usr/bin/x11vnc${nul}-display${nul}:99${nul}-rfbport${nul}5999${nul}`,
      '/proc/414/cmdline': `websockify${nul}127.0.0.1:6180${nul}127.0.0.1:5999${nul}`,
      '/proc/415/cmdline': `Xvfb${nul}:100${nul}-screen${nul}0${nul}1280x800x24${nul}`,
      // Ceux de quelqu'un d'autre : l'écran réel, un VNC de bureau, un serveur.
      '/proc/1/cmdline': `/sbin/init${nul}`,
      '/proc/900/cmdline': `Xvfb${nul}:0${nul}-screen${nul}0${nul}1920x1080x24${nul}`,
      '/proc/901/cmdline': `x11vnc${nul}-display${nul}:0${nul}-rfbport${nul}5900${nul}`,
      '/proc/902/cmdline': `websockify${nul}0.0.0.0:8080${nul}127.0.0.1:5900${nul}`,
    },
  });
  contexte.fs.existants.add('/tmp/.X11-unix/X99');
  contexte.fs.existants.add('/tmp/.X99-lock');

  const bilan = contexte.manager.cleanupOrphans();

  assert.deepEqual(bilan.killed.map((k) => k.pid).sort((a, b) => a - b), [412, 413, 414, 415]);
  assert.deepEqual(contexte.tues.map((t) => t.pid).sort((a, b) => a - b), [412, 413, 414, 415]);
  assert.ok(contexte.tues.every((t) => t.signal === 'SIGTERM'));
  assert.deepEqual(bilan.displays, [99, 100]);

  // Les affichages sont rendus : le prochain « Se connecter » ne se heurte pas
  // à une socket fantôme.
  assert.ok(contexte.fs.effaces.includes('/tmp/.X11-unix/X99'));
  assert.ok(contexte.fs.effaces.includes('/tmp/.X99-lock'));
  assert.ok(contexte.journal.some((l) => l.level === 'warn' && /orphelin/i.test(l.message)));
});

test('nettoyage sans /proc : le service démarre quand même', () => {
  const contexte = makeManager();
  const bilan = contexte.manager.cleanupOrphans();

  assert.deepEqual(bilan, { killed: [], displays: [], errors: [] });
  assert.deepEqual(contexte.tues, []);
});

test('reconnaissance d\'un orphelin : ni trop large, ni trop étroite', () => {
  const { manager } = makeManager();

  assert.equal(manager.orphanDisplay('Xvfb', ['Xvfb', ':99', '-screen']), 99);
  assert.equal(manager.orphanDisplay('Xvfb', ['Xvfb', ':108']), 108);
  assert.equal(manager.orphanDisplay('Xvfb', ['Xvfb', ':0']), null);
  assert.equal(manager.orphanDisplay('Xvfb', ['Xvfb', ':109']), null);
  assert.equal(manager.orphanDisplay('x11vnc', ['x11vnc', '-display', ':100']), 100);
  assert.equal(manager.orphanDisplay('x11vnc', ['x11vnc', '-rfbport', '5999']), 99);
  assert.equal(manager.orphanDisplay('x11vnc', ['x11vnc', '-display', ':1']), null);
  assert.equal(
    manager.orphanDisplay('websockify', ['websockify', '127.0.0.1:6181', '127.0.0.1:6000']),
    100
  );
  // Un websockify de quelqu'un d'autre, sur un port hors plage : intouchable.
  assert.equal(
    manager.orphanDisplay('websockify', ['websockify', '127.0.0.1:8080', '127.0.0.1:5900']),
    null
  );
  assert.equal(manager.orphanDisplay('node', ['node', 'server/index.js']), null);
});

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

/** Manifeste minimal valide, auquel les tests ajoutent leur bloc. */
function manifesteDeBase(extra = {}) {
  return {
    id: 'essai',
    name: 'Essai',
    category: 'telecom',
    color: '#c8102e',
    letters: 'ES',
    // Lot 8 : une phrase, et une seule, sur ce que le service fait.
    description: 'Récupère automatiquement vos factures d\'essai.',
    fields: [{ key: 'session', label: 'Session', type: 'session' }],
    permissions: [
      {
        key: 'identifiants',
        scope: 'read',
        description:
          'La session de navigateur capturée pour ce portail d\'essai, chiffrée au repos '
          + 'et rejouée uniquement pour ouvrir l\'espace abonné.',
      },
    ],
    ...extra,
  };
}

test('manifeste : un remoteLogin en clair est refusé au chargement', () => {
  const { ok, errors } = schema.validate(
    manifesteDeBase({ remoteLogin: { url: 'http://exemple.fr/login', marker: 'Factures' } }),
    'essai'
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /HTTPS/.test(e)), errors.join(' | '));
});

test('manifeste : un remoteLogin sans champ de session est refusé', () => {
  const { ok, errors } = schema.validate(
    manifesteDeBase({
      fields: [{ key: 'login', label: 'Identifiant', type: 'text' }],
      remoteLogin: { url: 'https://exemple.fr/login', marker: 'Factures' },
    }),
    'essai'
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /nulle part où être enregistrée/.test(e)), errors.join(' | '));
});

test('manifeste : un remoteLogin complet passe, et arrive normalisé au front', () => {
  const brut = manifesteDeBase({
    remoteLogin: {
      url: ' https://exemple.fr/login ',
      marker: 'Mes factures',
      hint: 'Cochez la case.',
    },
  });
  assert.equal(schema.validate(brut, 'essai').ok, true);

  const vue = schema.publicView(schema.normalize(brut));
  assert.deepEqual(vue.remoteLogin, {
    url: 'https://exemple.fr/login',
    marker: 'Mes factures',
    hint: 'Cochez la case.',
    // Lot 14, §6 : la page sur laquelle la session capturée est ESSAYÉE avant
    // d'être enregistrée. Vide ici — ce manifeste n'en déclare pas — mais
    // toujours présente, pour que le front n'ait pas à distinguer « non
    // déclaré » de « absent de cette version ». Depuis le lot 37, le contrôle
    // est strict pour tout le monde : `verifyStrict` a disparu du manifeste
    // normalisé, la liste blanche l'efface même s'il est encore déclaré.
    verifyUrl: '',
    // Lot 40 : « rester sur la page de contrôle prouve la session ». Même
    // logique de présence systématique que verifyUrl.
    verifyUrlTient: false,
    persistent: false,
    // Lot 48 : la preuve lue dans la fenêtre visible (Boulanger). Même logique
    // de présence systématique.
    preuveSurFenetre: false,
    // Lot 49 : les marqueurs mesurés, lus sur le DOM déjà affiché (Darty).
    // Toujours présents — vides quand le manifeste n'en déclare pas.
    marqueursFenetre: [],
  });
});

test('manifeste : remoteLogin.verifyUrlTient survit à la normalisation, et exige verifyUrl', () => {
  // Même piège de liste blanche que `persistent` (12/08/2026) : une clé non
  // recopiée disparaît en silence, et le contrôle retombe sur les marqueurs
  // génériques — qui ne captent rien sur les sites qui redirigent les
  // anonymes (OUIGO, mesure du 14/08/2026).
  const brut = manifesteDeBase({
    remoteLogin: {
      url: 'https://exemple.fr/login',
      verifyUrl: 'https://exemple.fr/reservations',
      verifyUrlTient: true,
    },
  });
  assert.equal(schema.validate(brut, 'essai').ok, true);
  assert.equal(schema.publicView(schema.normalize(brut)).remoteLogin.verifyUrlTient, true);

  // Sans verifyUrl, il n'y a pas d'adresse dont juger la tenue : refus.
  const orphelin = manifesteDeBase({
    remoteLogin: { url: 'https://exemple.fr/login', verifyUrlTient: true },
  });
  const controle = schema.validate(orphelin, 'essai');
  assert.equal(controle.ok, false);
  assert.ok(
    controle.errors.some((e) => /verifyUrlTient sans remoteLogin\.verifyUrl/.test(e)),
    controle.errors.join(' | ')
  );

  // Un verifyUrlTient non booléen refuse le manifeste au chargement.
  const tordu = manifesteDeBase({
    remoteLogin: {
      url: 'https://exemple.fr/login',
      verifyUrl: 'https://exemple.fr/reservations',
      verifyUrlTient: 'oui',
    },
  });
  const mauvaisType = schema.validate(tordu, 'essai');
  assert.equal(mauvaisType.ok, false);
  assert.ok(
    mauvaisType.errors.some((e) => /verifyUrlTient doit être un booléen/.test(e)),
    mauvaisType.errors.join(' | ')
  );
});
test('manifeste : remoteLogin.persistent survit a la normalisation', () => {
  // 12/08/2026 : la normalisation (liste blanche) jetait la cle en silence,
  // la fenetre s'ouvrait sans profil ni drapeau anti-detection, et le
  // challenge Cloudflare bouclait. Ce test fige la survie de bout en bout.
  const brut = manifesteDeBase({
    remoteLogin: { url: 'https://exemple.fr/login', persistent: true },
  });
  assert.equal(schema.validate(brut, 'essai').ok, true);
  assert.equal(schema.publicView(schema.normalize(brut)).remoteLogin.persistent, true);

  // Un persistent non booleen refuse le manifeste au chargement.
  const tordu = manifesteDeBase({
    remoteLogin: { url: 'https://exemple.fr/login', persistent: 'oui' },
  });
  const controle = schema.validate(tordu, 'essai');
  assert.equal(controle.ok, false);
  assert.ok(
    controle.errors.some((e) => /persistent doit .tre un bool.en/.test(e)),
    controle.errors.join(' | ')
  );
});

test('manifeste : sans remoteLogin, rien ne change pour le connecteur', () => {
  const vue = schema.publicView(schema.normalize(manifesteDeBase()));
  assert.equal(vue.remoteLogin, null);
});

test('Free Mobile déclare sa connexion par navigateur, la Freebox non', async () => {
  await helpers.setup();
  const registry = require('../server/connectors/registry');

  const mobile = registry.manifest('free-mobile');
  assert.equal(mobile.remoteLogin.url, 'https://mobile.free.fr/account/v2/login');
  assert.equal(mobile.remoteLogin.marker, 'Mes factures');
  assert.match(mobile.remoteLogin.hint, /Se souvenir de cet appareil/);

  // Le connecteur Freebox se configure par mot de passe et sa session n'est pas
  // réutilisable : lui ajouter un bouton « Se connecter » serait un mensonge.
  assert.equal(registry.manifest('free').remoteLogin, null);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('les routes du navigateur distant sont fermées aux visiteurs', async () => {
  await helpers.setup();
  const client = await helpers.startServer();

  try {
    assert.equal((await client.get('/api/connectors/remote-login/capabilities')).status, 401);
    assert.equal((await client.post('/api/connectors/free-mobile/remote-login')).status, 401);
    assert.equal((await client.get('/api/connectors/free-mobile/remote-login')).status, 401);
  } finally {
    await client.close();
  }
});

test('capabilities dit ce qui manque, et POST refuse proprement — pas d\'échec muet', async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'navigatrice' });
  const client = await helpers.startServer();

  try {
    await helpers.login(client, 'navigatrice', 'MotDePasse1');

    // La machine de test n'a ni xvfb, ni x11vnc, ni websockify, ni novnc :
    // c'est exactement le cas de dégradation que la mission demande de couvrir.
    const caps = await client.get('/api/connectors/remote-login/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.body.available, false);
    assert.ok(caps.body.missing.length > 0);
    assert.ok(caps.body.missing.every((m) => m.remedy), 'chaque manque porte son remède');
    assert.match(caps.body.reason, /fichier de session/);
    assert.equal(caps.body.busy, false);

    const lance = await client.post('/api/connectors/free-mobile/remote-login');
    assert.equal(lance.status, 503);
    assert.match(lance.body.error, /fichier de session/);

    // Aucune session n'a été ouverte : rien à interroger, rien à annuler.
    assert.equal((await client.get('/api/connectors/free-mobile/remote-login')).status, 404);
    assert.equal((await client.del('/api/connectors/free-mobile/remote-login')).status, 404);
  } finally {
    await client.close();
  }
});

test('un connecteur sans remoteLogin refuse le navigateur, en le disant', async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'freebox' });
  const client = await helpers.startServer();

  try {
    await helpers.login(client, 'freebox', 'MotDePasse1');

    const refus = await client.post('/api/connectors/free/remote-login');
    assert.equal(refus.status, 400);
    assert.match(refus.body.error, /ne se configure pas par navigateur/);

    assert.equal((await client.post('/api/connectors/inexistant/remote-login')).status, 404);
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Coller un texte : le serveur frappe dans la fenêtre (lot 12)
//
// Ctrl+V ne traverse pas jusqu'au navigateur distant, et le chemin noVNC du
// lot 10 — un keysym X11 par caractère — échouait EN SILENCE en production :
// version du paquet novnc du LXC, table de keysyms d'un Xvfb frais, focus de
// la toile. Trois aléas hors de portée, pour un geste sans lequel personne ne
// peut saisir un mot de passe de gestionnaire.
// ---------------------------------------------------------------------------

test('le texte est posé par le clavier du navigateur, d\'un seul geste', async () => {
  const { manager, page } = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const frappes = [];
  // Le double SAISIT vraiment : il retient le texte ET remplit le champ. Un
  // clavier qui ne fait rien laisserait passer une régression silencieuse —
  // c'est ce qui s'est produit trois lots de suite.
  //
  // `insertText` depuis le lot 14 (§7.3b) : c'est le geste d'un collage, et il
  // émet l'événement `input` que les formulaires écoutent. La frappe
  // caractère par caractère reste en repli, et le double l'expose aussi pour
  // que le choix soit vérifiable.
  page.keyboard = {
    insertText: async (texte) => {
      frappes.push({ texte, methode: 'insertText' });
      page.champ.longueur += String(texte).length;
    },
    type: async (texte, options) => {
      frappes.push({ texte, options, methode: 'type' });
      page.champ.longueur += String(texte).length;
    },
  };

  await manager.start(ouverture({ userId: 7 }));

  const rendu = await manager.typeText(7, 'free-mobile', 'M0t-de-Passé!');

  assert.equal(rendu.ok, true, rendu.error);
  assert.equal(frappes.length, 1);
  assert.equal(frappes[0].texte, 'M0t-de-Passé!', 'accents et ponctuation passent tels quels');
  assert.equal(frappes[0].methode, 'insertText', 'un collage, pas une frappe simulée');

  // Et sans champ où écrire, la même frappe est REFUSÉE plutôt qu'annoncée
  // comme réussie : c'est le défaut de fond des lots 8, 10 et 12.
  page.champ = null;
  const sansChamp = await manager.typeText(7, 'free-mobile', 'M0t-de-Passé!');
  assert.equal(sansChamp.ok, false);
  assert.match(sansChamp.error, /Cliquez d'abord dans le champ à remplir/);
  assert.equal(frappes.length, 1, 'rien n\'est frappé quand rien n\'a le focus');

  await manager.stop(7, 'free-mobile');
});

test('le texte frappé n\'apparaît dans AUCUN journal', async () => {
  const { manager, page, journal } = makeManager({ ecrans: [ECRAN_CONNEXION] });

  await manager.start(ouverture({ userId: 7 }));
  const secret = 'S3cr3t-Absolu-Qui-Ne-Doit-Pas-Fuiter';
  await manager.typeText(7, 'free-mobile', secret);

  // Ni extrait, ni le texte lui-même : c'est un mot de passe. Sa LONGUEUR,
  // elle, est journalisée depuis le lot 14 (§7.3b) — c'est ce qui permet de
  // diagnostiquer un collage qui « ne marche pas » sans rien apprendre du
  // secret.
  for (const ligne of journal) {
    assert.ok(!ligne.message.includes(secret), `le texte fuite dans un journal : ${ligne.message}`);
  }
  // Ni dans l'état de la session, que le client relit chaque seconde.
  const vue = manager.status(7, 'free-mobile');
  assert.ok(!JSON.stringify(vue).includes(secret), 'le texte fuite dans la vue publique');

  await manager.stop(7, 'free-mobile');
});

test('la fenêtre d\'un autre compte est intouchable', async () => {
  const { manager, page } = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const frappes = [];
  page.keyboard = {
    type: async (texte) => {
      frappes.push(texte);
      page.champ.longueur += String(texte).length;
    },
  };

  await manager.start(ouverture({ userId: 7 }));

  const refus = await manager.typeText(999, 'free-mobile', 'pas à moi');
  assert.equal(refus.ok, false);
  assert.match(refus.error, /n'est plus ouverte/);
  assert.deepEqual(frappes, [], 'rien ne doit avoir été frappé');

  await manager.stop(7, 'free-mobile');
});

test('sans fenêtre ouverte, la saisie est refusée en le disant', async () => {
  const { manager } = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const refus = await manager.typeText(7, 'free-mobile', 'coucou');
  assert.equal(refus.ok, false);
  assert.match(refus.error, /n'est plus ouverte/);
});

test('un texte vide ou démesuré est refusé avant d\'atteindre le navigateur', async () => {
  const { manager, page } = makeManager({ ecrans: [ECRAN_CONNEXION] });
  const frappes = [];
  page.keyboard = { type: async (texte) => frappes.push(texte) };

  await manager.start(ouverture({ userId: 7 }));

  assert.equal((await manager.typeText(7, 'free-mobile', '')).ok, false);
  assert.equal((await manager.typeText(7, 'free-mobile', null)).ok, false);

  const trop = await manager.typeText(
    7,
    'free-mobile',
    'x'.repeat(remoteBrowser.SAISIE_MAX_CARACTERES + 1)
  );
  assert.equal(trop.ok, false);
  assert.match(trop.error, /trop long/);

  assert.deepEqual(frappes, []);

  await manager.stop(7, 'free-mobile');
});

test('un navigateur qui ne répond plus le dit, plutôt que de mentir', async () => {
  const { manager, page } = makeManager({ ecrans: [ECRAN_CONNEXION] });
  page.keyboard = { type: async () => { throw new Error('Target closed'); } };

  await manager.start(ouverture({ userId: 7 }));
  const rendu = await manager.typeText(7, 'free-mobile', 'mot de passe');

  assert.equal(rendu.ok, false);
  assert.match(rendu.error, /n'a pas abouti/);
  // Le message de Playwright ne remonte pas tel quel : l'utilisateur a besoin
  // de savoir quoi faire, pas de lire « Target closed ».
  assert.ok(!rendu.error.includes('Target closed'));

  await manager.stop(7, 'free-mobile');
});

test('la route de saisie est fermée aux visiteurs, et 409 sans fenêtre', async () => {
  await helpers.setup();
  await helpers.createUser({ username: 'colleuse' });
  const client = await helpers.startServer();

  try {
    assert.equal(
      (await client.post('/api/connectors/free-mobile/remote-login/type', { text: 'x' })).status,
      401
    );

    await helpers.login(client, 'colleuse', 'MotDePasse1');
    const sansFenetre = await client.post(
      '/api/connectors/free-mobile/remote-login/type',
      { text: 'x' }
    );
    assert.equal(sansFenetre.status, 409);
    assert.match(sansFenetre.body.error, /n'est plus ouverte/);
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Relais : authentification du flux
// ---------------------------------------------------------------------------

test('cookie de session : une signature valide passe, une signature bricolée non', () => {
  const nodeCrypto = require('node:crypto');
  const secret = 'secret-de-session-de-test';
  const sid = 'abcdef0123456789';
  const signature = nodeCrypto
    .createHmac('sha256', secret)
    .update(sid)
    .digest('base64')
    .replace(/=+$/, '');

  assert.equal(remoteLoginRoute.unsignCookie(`s:${sid}.${signature}`, secret), sid);
  // Encodé par le navigateur : même résultat.
  assert.equal(
    remoteLoginRoute.unsignCookie(encodeURIComponent(`s:${sid}.${signature}`), secret),
    sid
  );

  assert.equal(remoteLoginRoute.unsignCookie(`s:${sid}.${signature}x`, secret), null);
  assert.equal(remoteLoginRoute.unsignCookie(`s:autre.${signature}`, secret), null);
  assert.equal(remoteLoginRoute.unsignCookie(`s:${sid}.${signature}`, 'autre-secret'), null);
  assert.equal(remoteLoginRoute.unsignCookie(sid, secret), null, 'un cookie non signé ne passe pas');
  assert.equal(remoteLoginRoute.unsignCookie('', secret), null);
});

test('lecture d\'un cookie parmi d\'autres, sans confondre les préfixes', () => {
  const entete = 'theme=light; crabe.sid=s%3Aabc.def; autre=1';
  assert.equal(remoteLoginRoute.readCookie(entete, 'crabe.sid'), 's%3Aabc.def');
  assert.equal(remoteLoginRoute.readCookie(entete, 'crabe'), null);
  assert.equal(remoteLoginRoute.readCookie('', 'crabe.sid'), null);
});

test('mise à niveau WebSocket : tout ce qui n\'est pas le flux est refusé sèchement', async () => {
  const refus = [];
  const socket = {
    destroyed: false,
    writableEnded: false,
    write: (data) => refus.push(String(data)),
    destroy: () => {
      socket.destroyed = true;
    },
    on: () => {},
    pipe: () => {},
    remoteAddress: '127.0.0.1',
  };

  await remoteLoginRoute.handleUpgrade(
    { url: '/api/autre-chose', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    socket,
    null
  );

  assert.equal(refus.length, 1);
  assert.match(refus[0], /^HTTP\/1\.1 404 /);
  assert.equal(socket.destroyed, true, 'la socket doit être fermée, pas laissée ouverte');
});

test('mise à niveau WebSocket : sans session applicative, rien ne passe', async () => {
  const refus = [];
  const socket = {
    destroyed: false,
    writableEnded: false,
    write: (data) => refus.push(String(data)),
    destroy: () => {
      socket.destroyed = true;
    },
    on: () => {},
    pipe: () => {},
    remoteAddress: '127.0.0.1',
  };

  await helpers.setup();
  await remoteLoginRoute.handleUpgrade(
    {
      url: `${remoteLoginRoute.STREAM_PATH}?token=inventé`,
      headers: { cookie: 'crabe.sid=s%3Afaux.signature' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    socket,
    null
  );

  assert.match(refus[0], /^HTTP\/1\.1 401 /);
  assert.equal(socket.destroyed, true);
});

// ---------------------------------------------------------------------------
// La fenêtre se ferme d'elle-même — lot 32, mesuré sur Hetzner
// ---------------------------------------------------------------------------
//
// Deux défauts constatés en production les 13–14/08/2026 :
//
//   1. la page « Security Check » de HeRay (`/_ray/pow`) passait tous les
//      garde-fous génériques — pas de mot d'authentification dans le chemin,
//      pas de champ de mot de passe — et `inspect()` la déclarait connectée ;
//   2. l'authentification de Hetzner dépose l'utilisateur sur une page que la
//      détection ne sait pas juger : la fenêtre restait ouverte jusqu'à ce
//      qu'il aille LUI-MÊME sur la page des factures (quatre cérémonies,
//      toutes conclues seulement après un clic manuel vers /invoice).

/** L'écran HeRay réel : URL propre au sens générique, aucun formulaire. */
const ECRAN_HERAY = { url: 'https://accounts.hetzner.com/_ray/pow' };

/** La page où Hetzner dépose après connexion : injugeable depuis l'écran. */
const ECRAN_DEPOT = { url: 'https://accounts.hetzner.com/login?etape=terminee' };

/**
 * Le Playwright de la sonde : chaque lancement rend une page qui répond aux
 * sélecteurs déclarés. `comportements` est consommé un lancement à la fois,
 * le dernier vaut pour la suite. Un comportement peut porter `statut` : c'est
 * le code HTTP que la navigation rend — le lot 37 exige qu'il soit LU.
 */
function fauxPlaywrightSonde(comportements) {
  const lancements = [];
  return {
    lancements,
    module: {
      chromium: {
        launch: async () => {
          const c = comportements.length > 1 ? comportements.shift() : comportements[0];
          lancements.push(c);
          const pageSonde = {
            setDefaultTimeout: () => {},
            goto: async () => (c.statut ? { status: () => c.statut } : undefined),
            waitForLoadState: async () => {},
            url: () => c.url,
            locator: (selecteur) => ({ count: async () => c.selecteurs?.[selecteur] || 0 }),
          };
          return {
            newContext: async () => ({ newPage: async () => pageSonde }),
            close: async () => {},
          };
        },
      },
    },
  };
}

test('la vérification anti-robot déclarée par le connecteur n\'est jamais prise pour une connexion', async () => {
  const detection2 = require('../server/connectors/login-detection');

  // Le défaut mesuré, tel quel : sans déclaration, l'écran HeRay passe pour
  // « aucun écran d'authentification visible ». C'est CE verdict qui armait
  // une capture de cookies anonymes.
  const pageHeray = {
    url: () => 'https://accounts.hetzner.com/_ray/pow',
    locator: () => ({ count: async () => 0 }),
    getByText: () => ({ count: async () => 0 }),
  };
  const sans = await detection2.inspect(pageHeray, {});
  assert.equal(sans.ok, true, 'le défaut d\'origine : la page HeRay passait');

  // Avec la déclaration du connecteur, la même page est « en cours », et la
  // raison le dit à l'utilisateur sous la fenêtre.
  const avec = await detection2.inspect(pageHeray, { urlsEnCours: ['/_ray/'] });
  assert.equal(avec.ok, false);
  assert.equal(avec.reason, 'vérification du site en cours');

  // Et dans la boucle de surveillance complète : la fenêtre reste ouverte.
  const contexte = makeManager({ ecrans: [ECRAN_HERAY] });
  const captures = [];
  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: '',
    attendreUrls: ['/_ray/'],
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => contexte.page.lectures >= 6), 'la boucle doit tourner');
  assert.equal(captures.length, 0, 'aucune capture sur la page HeRay');
  assert.equal(contexte.manager.status(1, 'hetzner').state, 'running');
  await contexte.manager.stop(1, 'hetzner');
});

test('l\'authentification dépose sur une page injugeable : la sonde prouve la session et ferme seule', async () => {
  // Le scénario réel, à un détail près : ici, personne ne clique jamais
  // vers /invoice. La fenêtre passe de la page de connexion à la page de
  // dépôt (URL d'authentification, donc injugeable), et c'est la SONDE —
  // les cookies capturés, essayés sur la page de contrôle — qui conclut.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  // Le tableau d'écrans est MUTABLE : la page de dépôt n'arrive qu'APRÈS la
  // saisie, comme dans la réalité — depuis le lot 38, la sonde ne s'arme
  // qu'une fois la première saisie faite.
  const ecrans = [ECRAN_CONNEXION];
  const contexte = makeManager({
    ecrans,
    requirePlaywright: () => sonde.module,
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: '',
    verifyUrl: 'https://accounts.hetzner.com/invoice',
    attendreUrls: ['/_ray/'],
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: etat.cookies.length } };
    },
  }));

  assert.equal((await contexte.manager.typeText(1, 'hetzner', 'M0t-de-passe')).ok, true);
  // La boucle doit avoir VU l'écran de connexion avant que l'adresse change :
  // la première adresse vue ne déclenche jamais rien.
  assert.ok(await attendre(() => contexte.page.lectures >= 6));
  ecrans.push(ECRAN_DEPOT);

  assert.ok(await attendre(() => captures.length > 0), 'la session aurait dû s\'enregistrer seule');
  assert.equal(contexte.manager.status(1, 'hetzner').state, 'saved');
  // Deux essais au moins : la sonde (stricte), puis le contrôle d'enregistrement.
  assert.ok(sonde.lancements.length >= 2, `${sonde.lancements.length} essai(s) seulement`);
  assert.equal(contexte.fermetures, 1, 'la fenêtre doit être fermée');
});

test('une sonde qui ne prouve rien laisse la fenêtre ouverte — jamais de fermeture sur un doute', async () => {
  // Même parcours, mais la page de contrôle ne montre AUCUN marqueur de
  // compte : le chemin d'enregistrement l'aurait « acceptée » (tolérance du
  // lot 14) — la sonde automatique, elle, doit s'abstenir. Fermer la fenêtre
  // sur un doute, c'est la fermer au nez d'un utilisateur pas encore connecté.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: {},
  }]);
  const ecrans = [ECRAN_CONNEXION];
  const contexte = makeManager({
    ecrans,
    requirePlaywright: () => sonde.module,
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: '',
    verifyUrl: 'https://accounts.hetzner.com/invoice',
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.equal((await contexte.manager.typeText(1, 'hetzner', 'M0t-de-passe')).ok, true);
  // La boucle doit avoir VU l'écran de connexion avant que l'adresse change :
  // la première adresse vue ne déclenche jamais rien.
  assert.ok(await attendre(() => contexte.page.lectures >= 6));
  ecrans.push(ECRAN_DEPOT);

  assert.ok(await attendre(() => sonde.lancements.length >= 1), 'la sonde doit avoir essayé');
  // On laisse la boucle repasser : rien ne doit s'enregistrer, la sonde ne
  // se relance pas en boucle sur la même adresse.
  assert.ok(await attendre(() => contexte.page.lectures >= 8));
  assert.equal(captures.length, 0);
  assert.equal(contexte.manager.status(1, 'hetzner').state, 'running');
  assert.equal(sonde.lancements.length, 1, 'une sonde par adresse, pas une rafale');
  assert.ok(
    contexte.journal.some((l) => /pas encore établie/.test(l.message)),
    'le journal doit dire que la sonde n\'a pas conclu'
  );
  await contexte.manager.stop(1, 'hetzner');
});

// ---------------------------------------------------------------------------
// Lot 37 — une seule politique de session, la stricte
//
// Le 18/08/2026, la page de contrôle SoundCloud répondait 404, et le contrôle
// a jugé ça « non concluant » puis a ACCEPTÉ la session quand même — pendant
// que Qobuz, écrit dans le même lot, promettait « le 404 jamais confondu avec
// une session ». Ces tests figent la politique unique : « non concluant » ne
// vaut jamais acceptation, et le code de réponse HTTP est lu.
// ---------------------------------------------------------------------------

test('page de contrôle en 404 : verdict non concluant, la session n\'est JAMAIS enregistrée', async () => {
  // La page morte porte même un lien logout : le code de réponse prime sur
  // tout ce que la page affiche — une adresse morte ne prouve rien, dans
  // aucun sens. Si quelqu'un cesse de lire le statut, le lien logout ferait
  // « confirmer » la session et ce test tombe.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://checkout.soundcloud.com/billing',
    statut: 404,
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'soundcloud',
    connectorName: 'SoundCloud',
    verifyUrl: 'https://checkout.soundcloud.com/billing',
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => sonde.lancements.length >= 1), 'le contrôle doit avoir tiré');
  assert.ok(
    await attendre(() => contexte.manager.status(1, 'soundcloud')?.attenteManuelle),
    'l\'essai raté doit rendre la main à l\'utilisateur'
  );
  const statut = contexte.manager.status(1, 'soundcloud');
  assert.equal(captures.length, 0, 'rien ne doit s\'enregistrer sur une page morte');
  assert.equal(statut.state, 'running', 'la fenêtre reste ouverte');
  // Lot 48 : une adresse morte n'est pas un parcours inachevé — le message ne
  // conseille plus de recliquer « Enregistrer » (les quatre refus identiques
  // de Boulanger, 22/08/2026), il dit de signaler.
  assert.equal(statut.message,
    'La page qui sert à vérifier votre connexion n\'existe pas à l\'adresse prévue.');
  assert.match(statut.detail, /signalez-le/);
  assert.doesNotMatch(statut.detail, /cliquez à nouveau sur Enregistrer/);
  assert.equal(statut.verdictCode, 'adresse-morte');
  assert.ok(
    contexte.journal.some((l) => /NON enregistrée.*404/.test(l.message)),
    'le journal nomme la réponse 404'
  );
  assert.ok(
    !contexte.journal.some((l) => /session est acceptée|Session acceptée/i.test(l.message)),
    'plus aucun chemin n\'« accepte » un contrôle non concluant'
  );
  await contexte.manager.stop(1, 'soundcloud');
});

test('page de contrôle en erreur 5xx : même verdict non concluant, même refus d\'enregistrer', async () => {
  const sonde = fauxPlaywrightSonde([{
    url: 'https://exemple.fr/espace-client',
    statut: 503,
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.fr/espace-client',
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => contexte.manager.status(1, 'free-mobile')?.attenteManuelle));
  const statut = contexte.manager.status(1, 'free-mobile');
  assert.equal(captures.length, 0);
  assert.equal(statut.state, 'running');
  // Lot 48 : l'erreur du site est dite pour ce qu'elle est, avec sa consigne.
  assert.equal(statut.message, 'Le site a répondu par une erreur pendant la vérification.');
  assert.match(statut.detail, /Réessayez/);
  assert.equal(statut.verdictCode, 'erreur-site');
  assert.ok(contexte.journal.some((l) => /NON enregistrée.*503/.test(l.message)));
  await contexte.manager.stop(1, 'free-mobile');
});

test('page de contrôle valide sans marqueur : refus — l\'« acceptation avec avertissement » n\'existe plus', async () => {
  // Jusqu'au lot 37, ce cas exact était accepté avec un simple avertissement
  // au journal, sauf `verifyStrict` au manifeste. C'est ce chemin qui a
  // enregistré la session SoundCloud morte du 18/08/2026. Si quelqu'un le
  // réintroduit, la capture s'enregistre et ce test tombe.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://exemple.fr/espace-client',
    statut: 200,
    selecteurs: {},
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.fr/espace-client',
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => contexte.manager.status(1, 'free-mobile')?.attenteManuelle));
  const statut = contexte.manager.status(1, 'free-mobile');
  assert.equal(captures.length, 0, 'la session ne doit pas s\'enregistrer sans preuve');
  assert.equal(statut.state, 'running', 'la fenêtre reste ouverte');
  // Depuis le lot 68, ce cas dit la vérité : la preuve MANQUE — la session
  // n'est pas forcément mauvaise (Anthropic, 28/08/2026 : trois refus d'une
  // session valide). « La connexion n'est pas encore terminée » reste réservé
  // au renvoi vers le formulaire, où elle est vraie.
  assert.equal(statut.message, 'La page ne montre rien qui permette de vérifier votre connexion.');
  assert.equal(statut.verdictCode, 'sans-preuve');
  assert.ok(
    contexte.journal.some((l) => /NON enregistrée/.test(l.message)),
    'le journal dit que la session n\'a pas été enregistrée'
  );
  await contexte.manager.stop(1, 'free-mobile');
});

test('le manifeste refuse une liste d\'attente vide ou mal formée', () => {
  const base = {
    id: 'hetzner',
    name: 'Hetzner',
    remoteLogin: { url: 'https://accounts.hetzner.com/login', attendreUrls: [] },
  };
  const erreurs = schema.validate({ ...base }, { fichier: 'test' }) || [];
  const messages = JSON.stringify(erreurs);
  assert.match(messages, /attendreUrls/);
});

// ---------------------------------------------------------------------------
// Lot 33 — jamais de fermeture pendant qu'un écran attend une saisie
//
// Le 14/08/2026, la sonde du lot 32 a fermé la fenêtre Hetzner pendant que
// L'utilisateur était devant le champ de son code de validation : l'arrivée sur `/2fa`
// est un changement d'adresse, et la demi-session (mot de passe passé, code
// jamais saisi) se prouvait sur la page de contrôle — `/2fa` porte un lien
// logout. La règle : quelle que soit la réponse de la sonde, un écran de
// saisie garde la fenêtre ouverte.
// ---------------------------------------------------------------------------

/** L'écran de validation de Hetzner : UN champ de code, pas une grille. */
const ECRAN_CODE_EN_ATTENTE = {
  url: 'https://accounts.hetzner.com/2fa',
  [detection.SELECTEUR_CHAMP_CODE]: 1,
};

test('un champ de code en attente : ni capture ni fermeture, même si la sonde répondrait « connecté »', async () => {
  // La sonde, si elle tirait, répondrait OUI — le scénario mesuré : /invoice
  // avec la demi-session atterrit sur /2fa, qui porte un lien logout. Le test
  // vérifie qu'elle ne tire JAMAIS : zéro lancement headless.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const ecrans = [ECRAN_CONNEXION];
  const contexte = makeManager({
    ecrans,
    requirePlaywright: () => sonde.module,
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: '',
    verifyUrl: 'https://accounts.hetzner.com/invoice',
    onDetected: async (etat) => void captures.push(etat),
  }));

  // Le mot de passe est saisi (la sonde est armée, lot 38), PUIS l'écran de
  // code arrive : c'est la garde du lot 33 qui doit retenir la sonde ici.
  assert.equal((await contexte.manager.typeText(1, 'hetzner', 'M0t-de-passe')).ok, true);
  assert.ok(await attendre(() => contexte.page.lectures >= 6));
  const lecturesAvant = contexte.page.lectures;
  ecrans.push(ECRAN_CODE_EN_ATTENTE);

  // On laisse la boucle passer plusieurs fois sur l'écran de code.
  assert.ok(await attendre(() => contexte.page.lectures >= lecturesAvant + 8));
  assert.equal(sonde.lancements.length, 0, 'la sonde ne doit même pas être lancée');
  assert.equal(captures.length, 0, 'aucune session capturée');
  assert.equal(contexte.fermetures, 0, 'la fenêtre reste ouverte');
  assert.equal(contexte.manager.status(1, 'hetzner').state, 'running');
  assert.ok(
    contexte.journal.some((l) => /la fenêtre attend l'utilisateur/.test(l.message)),
    'le journal dit pourquoi la sonde s\'est abstenue'
  );
  await contexte.manager.stop(1, 'hetzner');
});

test('le champ de code retient la fenêtre même sur une adresse qui ne ressemble pas à une étape', async () => {
  // Variante sans le secours de l'URL : l'adresse de dépôt n'évoque aucune
  // authentification, mais l'écran montre un champ numérique. Le garde est
  // DOM d'abord — c'est l'écran qui dit que quelqu'un doit taper, pas
  // l'adresse.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const ecrans = [ECRAN_CONNEXION];
  const contexte = makeManager({
    ecrans,
    requirePlaywright: () => sonde.module,
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: 'Invoices',
    verifyUrl: 'https://accounts.hetzner.com/invoice',
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.equal((await contexte.manager.typeText(1, 'hetzner', 'M0t-de-passe')).ok, true);
  assert.ok(await attendre(() => contexte.page.lectures >= 6));
  const lecturesAvant = contexte.page.lectures;
  ecrans.push({
    url: 'https://accounts.hetzner.com/console?etape=validation',
    [detection.SELECTEUR_CHAMP_CODE]: 1,
  });

  assert.ok(await attendre(() => contexte.page.lectures >= lecturesAvant + 8));
  assert.equal(sonde.lancements.length, 0);
  assert.equal(captures.length, 0);
  assert.equal(contexte.fermetures, 0);
  await contexte.manager.stop(1, 'hetzner');
});

test('la page de dépôt sans champ de saisie ferme toujours seule — le correctif du lot 32 tient', async () => {
  // Le scénario que le lot 32 a réparé, inchangé : dépôt sur une page
  // injugeable SANS aucun champ — la sonde prouve la session et conclut. Ce
  // test garde le garde-fou du lot 33 dans son rôle : retenir une saisie,
  // jamais empêcher la fermeture légitime.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const ecrans = [ECRAN_CONNEXION];
  const contexte = makeManager({
    ecrans,
    requirePlaywright: () => sonde.module,
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'hetzner',
    connectorName: 'Hetzner',
    marker: '',
    verifyUrl: 'https://accounts.hetzner.com/invoice',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: etat.cookies.length } };
    },
  }));

  assert.equal((await contexte.manager.typeText(1, 'hetzner', 'M0t-de-passe')).ok, true);
  // La boucle doit avoir VU l'écran de connexion avant que l'adresse change :
  // la première adresse vue ne déclenche jamais rien.
  assert.ok(await attendre(() => contexte.page.lectures >= 6));
  ecrans.push(ECRAN_DEPOT);

  assert.ok(await attendre(() => captures.length > 0), 'la session doit s\'enregistrer seule');
  assert.equal(contexte.manager.status(1, 'hetzner').state, 'saved');
  assert.equal(contexte.fermetures, 1);
});

test('un changement d\'adresse AVANT toute saisie ne déclenche aucune sonde — après une saisie, si', async () => {
  // Mesuré le 18/08/2026 sur Spotify : ~24 s après l'ouverture, la page
  // d'accueil du site finissait de rediriger — adresse changée, personne
  // n'avait encore rien tapé — et la sonde partait, avec son message. La
  // navigation initiale d'un site n'est pas une connexion : la sonde ne
  // s'arme qu'après la PREMIÈRE saisie (le moteur les compte). La garde du
  // lot 33 (écran de saisie = pas de sonde) reste posée par-dessus.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://accounts.hetzner.com/invoice',
    selecteurs: { 'a[href*="logout"]': 1 },
  }]);
  const ecrans = [ECRAN_CONNEXION, ECRAN_CONNEXION, ECRAN_DEPOT];
  const contexte = makeManager({ ecrans, requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'spotify',
    connectorName: 'Spotify',
    marker: '',
    verifyUrl: 'https://www.spotify.com/fr/account/payment-history/',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: etat.cookies.length } };
    },
  }));

  // L'adresse change (connexion → dépôt) sans qu'aucune saisie n'ait eu lieu :
  // rien ne doit partir, la fenêtre attend.
  assert.ok(await attendre(() => contexte.page.lectures >= 8));
  assert.equal(sonde.lancements.length, 0, 'la navigation initiale ne déclenche rien');
  assert.equal(captures.length, 0);
  assert.equal(contexte.manager.status(1, 'spotify').state, 'running');

  // Une saisie, puis un NOUVEAU changement d'adresse : la sonde reprend son rôle.
  assert.equal((await contexte.manager.typeText(1, 'spotify', 'M0t-de-passe')).ok, true);
  ecrans.push({ url: 'https://accounts.spotify.com/fr/status?etape=confirmee' });
  assert.ok(
    await attendre(() => sonde.lancements.length >= 1),
    'après une saisie, le même changement déclenche la sonde'
  );
});

test('un champ de code isolé mais nommé bloque aussi la détection générique', async () => {
  // L'écran de Hetzner n'a qu'un champ — sous le seuil de la grille. S'il se
  // nomme comme un code (otp, 2fa, one-time-code…), il suffit : une page qui
  // le montre n'est jamais « connectée », marqueur présent ou pas.
  const page = fakePage([{
    url: 'https://exemple.fr/espace-client',
    [detection.SELECTEUR_CODE_NOMME]: 1,
    marqueur: true,
  }]);
  const etat = await detection.inspect(page, { marker: 'Mes factures' });
  assert.equal(etat.ok, false);
  assert.equal(etat.reason, 'code de validation attendu');
});

test('attendUneSaisie reconnaît chaque famille de champ, et la prudence sur une page illisible', async () => {
  const cas = [
    [{ url: 'https://exemple.fr/x', [detection.SELECTEUR_MOT_DE_PASSE]: 1 }, /mot de passe/],
    [{ url: 'https://exemple.fr/x', [detection.SELECTEUR_CHAMP_CODE]: 1 }, /champ de code/],
    [{ url: 'https://exemple.fr/x', [detection.SELECTEUR_CODE_NOMME]: 1 }, /champ de code/],
    [{ url: 'https://exemple.fr/x', [detection.SELECTEUR_CHAMP_IDENTIFIANT]: 1 }, /formulaire de connexion/],
  ];
  for (const [ecran, motif] of cas) {
    const verdict = await detection.attendUneSaisie(fakePage([ecran]));
    assert.equal(verdict.attend, true);
    assert.match(verdict.motif, motif);
  }

  // Rien à l'écran : la fenêtre peut se fermer si la session se prouve.
  const libre = await detection.attendUneSaisie(fakePage([{ url: 'https://exemple.fr/x' }]));
  assert.equal(libre.attend, false);

  // Page illisible (navigation en cours) : on retient, on ne devine pas.
  const illisible = await detection.attendUneSaisie({
    locator: () => ({ count: async () => { throw new Error('détachée'); } }),
  });
  assert.equal(illisible.attend, true);
  assert.match(illisible.motif, /chargement/);
});

test('l\'URL de contrôle a tenu : le connecteur qui le déclare voit sa session confirmée', async () => {
  // Aucun marqueur générique à l'écran : seul le verdict « l'URL a tenu »
  // (lot 40) peut conclure. C'est le cas d'OUIGO, mesuré le 14/08/2026 :
  // hors session, la page des réservations redirige vers l'accueil.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://ventes.exemple.fr/fr-FR/user/bookings/past-bookings',
    statut: 200,
    selecteurs: {},
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'ouigo',
    connectorName: 'OUIGO',
    verifyUrl: 'https://ventes.exemple.fr/fr-FR/user/bookings/past-bookings',
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => sonde.lancements.length >= 1), 'le contrôle doit avoir tiré');
  assert.ok(
    await attendre(() => contexte.manager.status(1, 'ouigo')?.state === 'saved'),
    'la session doit s\'enregistrer'
  );
  assert.equal(captures.length, 1, 'l\'état capturé doit être remis au connecteur');
  assert.ok(
    contexte.journal.some((l) => /a tenu.*redirige les anonymes/.test(l.message)),
    'le journal dit ce qui a été jugé : l\'adresse a tenu, or elle redirige les anonymes'
  );
  await contexte.manager.stop(1, 'ouigo');
});

test('l\'URL de contrôle a redirigé vers l\'accueil : session refusée, la fenêtre reste ouverte', async () => {
  // La même déclaration, mais la sonde atterrit sur l'accueil : c'est
  // exactement ce que le site fait aux visiteurs sans session — refus.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://ventes.exemple.fr/fr-FR',
    statut: 200,
    selecteurs: {},
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorId: 'ouigo',
    connectorName: 'OUIGO',
    verifyUrl: 'https://ventes.exemple.fr/fr-FR/user/bookings/past-bookings',
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));

  assert.ok(await attendre(() => sonde.lancements.length >= 1), 'le contrôle doit avoir tiré');
  assert.ok(
    await attendre(() => contexte.manager.status(1, 'ouigo')?.attenteManuelle),
    'l\'essai refusé doit rendre la main à l\'utilisateur'
  );
  const statut = contexte.manager.status(1, 'ouigo');
  assert.equal(captures.length, 0, 'rien ne doit s\'enregistrer sur une redirection d\'anonyme');
  assert.equal(statut.state, 'running', 'la fenêtre reste ouverte');
  assert.ok(
    contexte.journal.some((l) => /NON enregistrée.*renvoyé vers https:\/\/ventes\.exemple\.fr\/fr-FR/.test(l.message)),
    'le journal dit la redirection et sa signification'
  );
  await contexte.manager.stop(1, 'ouigo');
});

test('la fenêtre persistante referme chaque page avant son contexte', async () => {
  const fermees = [];
  const fauxContexte = {
    pages: () => [
      { close: async () => fermees.push('page-1') },
      // Une page qui refuse de se fermer ne bloque ni les suivantes ni le
      // contexte : l'erreur est avalée.
      { close: async () => { throw new Error('déjà fermée'); } },
      { close: async () => fermees.push('page-3') },
    ],
    close: async () => fermees.push('contexte'),
  };

  await remoteBrowser.fermerPagesPuisContexte(fauxContexte);

  // Les trois pages passent avant le contexte, la récalcitrante n'arrête rien.
  assert.deepEqual(fermees, ['page-1', 'page-3', 'contexte']);

  // Et c'est bien ce chemin que la fenêtre persistante emprunte : sans lui, le
  // contexte se fermerait pages ouvertes et Chromium mémoriserait la pile
  // d'onglets que `restore_on_startup` restaure à l'ouverture suivante —
  // constaté le 19/08/2026 en production, ~30 onglets dans la fenêtre de
  // connexion.
  const source = require('node:fs').readFileSync(require.resolve('../server/remote-browser'), 'utf8');
  assert.match(source, /close: \(\) => fermerPagesPuisContexte\(context\)/);
});

test.after(() => helpers.teardown());
