'use strict';

/**
 * Lot 48 — « Enregistrer » cesse d'être muet, et la fenêtre sait renoncer.
 *
 * Le soir du 22/08/2026, l'utilisateur s'est connecté sur sept sites ; une seule
 * session a été enregistrée. Les six autres fenêtres ont ÉCHOUÉ SANS RIEN
 * DIRE : la route `/save` écrasait le verdict par le champ `error` (nul) de
 * la vue publique, l'écran affichait « Erreur 409 » au mieux, et une session
 * Boulanger bloquée a tenu l'affichage dix minutes — jusqu'à des kills à la
 * main. Ces tests MORDENT sur chacun des défauts : retirez le verdict, la
 * consigne, le compteur d'échecs ou le délai de fermeture, et ils tombent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const remoteBrowser = require('../server/remote-browser');
const detection = require('../server/connectors/login-detection');
const applog = require('../server/applog');

// ---------------------------------------------------------------------------
// Doubles de système — la même recette que test/remote-browser.test.js
// ---------------------------------------------------------------------------

function fakeFs({ present = [], contents = {} } = {}) {
  const existants = new Set(present);
  return {
    existants,
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
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => existants.delete(String(p)),
  };
}

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

/** Page Playwright simulée — assez pour la détection et la frappe. */
function fakePage(ecrans) {
  let lectures = 0;
  const courant = () => ecrans[Math.min(lectures, ecrans.length - 1)];
  const page = {
    get lectures() {
      return lectures;
    },
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
    keyboard: {
      type: async (texte) => {
        if (page.champ?.editable) page.champ.longueur += String(texte).length;
      },
    },
  };
  return page;
}

const ECRAN_CONNEXION = {
  url: 'https://exemple.test/connexion',
  [detection.SELECTEUR_MOT_DE_PASSE]: 1,
};

/**
 * Le Playwright de l'ESSAI de session : chaque lancement rend l'écran suivant
 * de `comportements` (le dernier vaut pour tous les suivants). `retenir` donne
 * la main au test PENDANT l'essai — c'est ce qui permet d'annuler au milieu.
 */
function fauxPlaywrightSonde(comportements, { retenir = null } = {}) {
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
            goto: async () => {
              if (retenir) await retenir();
              return c.statut ? { status: () => c.statut } : undefined;
            },
            waitForLoadState: async () => {},
            url: () => c.url,
            locator: (selecteur) => ({ count: async () => c.selecteurs?.[selecteur] || 0 }),
            evaluate: async (fn) => {
              if (c.texteCorps === undefined) throw new Error('pas de corps simulé');
              return fn.call(null);
            },
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

function makeManager({
  ecrans = [ECRAN_CONNEXION],
  contents = {},
  requirePlaywright = null,
  launchBrowser = null,
  closeTimeoutMs = null,
  storageState = {
    cookies: [
      { name: 'a', value: 'x', domain: '.exemple.test', expires: -1 },
      { name: 'b', value: 'y', domain: '.exemple.test', expires: -1 },
    ],
  },
} = {}) {
  const processus = [];
  const journal = [];
  const tues = [];
  const fs = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
    contents,
  });
  const page = fakePage(ecrans);
  let ferme = 0;

  const manager = remoteBrowser.createManager({
    fs,
    os: {
      totalmem: () => 4096 * 1024 * 1024,
      freemem: () => 2600 * 1024 * 1024,
    },
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
    // Le troisième argument est RETENU : c'est lui qui attribue la ligne au
    // connecteur dans « Logs → Connecteurs » (phase 3 du lot 48).
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: launchBrowser || (async () => ({
      page,
      storageState: async () => storageState,
      close: async () => {
        ferme += 1;
      },
    })),
    timeoutMs: 5_000,
    pollMs: 4,
    ...(closeTimeoutMs ? { closeTimeoutMs } : {}),
    ...(requirePlaywright ? { requirePlaywright } : {}),
  });

  return {
    manager,
    fs,
    page,
    processus,
    journal,
    tues,
    get fermetures() {
      return ferme;
    },
  };
}

function ouverture(extra = {}) {
  return {
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://exemple.test/connexion',
    marker: 'Mes factures',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — le verdict, dans les trois cas
// ---------------------------------------------------------------------------

test('adresse de contrôle morte (404) : le verdict dit quoi faire, jamais un simple code', async () => {
  const sonde = fauxPlaywrightSonde([{ url: 'https://exemple.test/compte', statut: 404 }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte',
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');

  // Le verdict est un TEXTE POUR L'UTILISATEUR : ce que la page affiche. S'il
  // redevenait un code ou une phrase technique, ce test tombe — c'est le
  // « Enregistrer ça n'a rien fait » du 22/08/2026.
  assert.equal(resultat.ok, false);
  assert.match(resultat.error, /n'existe pas à l'adresse prévue/);
  assert.match(resultat.error, /signalez-le/);
  assert.equal(/404|refus|verdict/i.test(resultat.error), false,
    'pas de jargon : la consigne suffit');
  // Et surtout PAS le conseil de recliquer « Enregistrer » : quatre refus
  // identiques sur Boulanger le 22/08 venaient de ce conseil impossible.
  assert.equal(/cliquez (à nouveau )?sur Enregistrer/i.test(resultat.error), false);

  assert.equal(captures.length, 0, 'rien ne doit être enregistré');
  assert.equal(resultat.view.attenteManuelle, true);
  assert.equal(resultat.view.echecsVerification, 1);
  assert.equal(resultat.view.verdictCode, 'adresse-morte');

  // Le journal du connecteur porte l'échec, attribué au service.
  const echec = contexte.journal.find((l) => /NON enregistrée/.test(l.message));
  assert.ok(echec, 'l\'échec doit être journalisé');
  assert.equal(echec.connectorId, 'exemple');

  await contexte.manager.stop(1, 'exemple');
});

test('trois vérifications infructueuses : le compteur monte — c\'est lui qui arme « renoncer »', async () => {
  const sonde = fauxPlaywrightSonde([{ url: 'https://exemple.test/compte', statut: 404 }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte',
    onDetected: async () => ({}),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  for (let i = 1; i <= 3; i++) {
    const resultat = await contexte.manager.saveNow(1, 'exemple');
    assert.equal(resultat.ok, false);
    assert.equal(resultat.view.echecsVerification, i, `échec n° ${i} compté`);
  }
  assert.equal(contexte.manager.status(1, 'exemple').echecsVerification, 3);

  await contexte.manager.stop(1, 'exemple');
});

test('réussite : le verdict porte le nombre de cookies gardés', async () => {
  // Pas de page de contrôle : c'est la parole de l'utilisateur qui conclut
  // (« Enregistrer » après confirmation) — le chemin le plus court vers un
  // enregistrement, et le verdict doit quand même dire un FAIT.
  const contexte = makeManager();

  await contexte.manager.start(ouverture({
    verifyUrl: '',
    onDetected: async (etat) => ({
      fieldKey: 'session',
      summary: { cookieCount: (etat.cookies || []).length },
    }),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, true);
  assert.equal(resultat.view.state, 'saved');
  assert.match(resultat.view.message, /2 cookie\(s\) gardé\(s\)/,
    'le verdict de réussite est un fait dicible : combien de cookies');
});

test('mur anti-robot (403 sans preuve) : verdict indéterminé qui propose la sortie, jamais une confirmation', async () => {
  // Le piège Darty : le mur garde l'adresse et rend 403 avec une page
  // d'excuse. « L'URL a tenu » ne doit JAMAIS conclure là-dessus, même avec
  // verifyUrlTient — sinon une session anonyme s'enregistrerait derrière le mur.
  const sonde = fauxPlaywrightSonde([{
    url: 'https://exemple.test/compte',
    statut: 403,
    selecteurs: {},
  }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte',
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'un 403 qui garde l\'adresse ne prouve RIEN');
  assert.equal(resultat.view.verdictCode, 'mur');
  assert.match(resultat.error, /fermez la fenêtre|Réessayez/i,
    'l\'indéterminé propose de réessayer ou de renoncer');

  await contexte.manager.stop(1, 'exemple');
});

test('erreur du site (500) : verdict indéterminé, dit en clair', async () => {
  const sonde = fauxPlaywrightSonde([{ url: 'https://exemple.test/compte', statut: 500 }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte',
    onDetected: async () => ({}),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, false);
  assert.equal(resultat.view.verdictCode, 'erreur-site');
  assert.match(resultat.error, /répondu par une erreur/);
  assert.match(resultat.error, /Réessayez/);

  await contexte.manager.stop(1, 'exemple');
});

// ---------------------------------------------------------------------------
// Phase 2 — la fenêtre sait renoncer
// ---------------------------------------------------------------------------

test('annuler PENDANT la vérification : rien n\'est enregistré, l\'état reste « annulé »', async () => {
  // L'essai est RETENU par le test : la sonde ne répond que quand on la
  // libère. Entre-temps, l'utilisateur clique « Fermer / Abandonner ».
  let liberer;
  const barriere = new Promise((resolve) => {
    liberer = resolve;
  });
  const sonde = fauxPlaywrightSonde(
    [{ url: 'https://exemple.test/compte', selecteurs: { 'a[href*="logout"]': 1 } }],
    { retenir: () => barriere }
  );
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte',
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const enregistrement = contexte.manager.saveNow(1, 'exemple');
  // L'essai est en cours (goto retenu) : l'utilisateur renonce.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await contexte.manager.stop(1, 'exemple');
  // La sonde répond ENFIN — et répondrait « connecté » : trop tard, la
  // fenêtre est fermée, rien ne doit s'enregistrer par-dessus l'abandon.
  liberer();
  await enregistrement;

  assert.equal(captures.length, 0, 'aucune session enregistrée après l\'abandon');
  assert.equal(contexte.manager.status(1, 'exemple').state, 'cancelled');
});

test('un navigateur qui refuse de se fermer ne retient plus l\'extinction', async () => {
  // `close()` ne rend JAMAIS la main — le Chromium coincé du 22/08/2026.
  const contents = {
    '/proc': ['4242'],
    '/proc/4242/cmdline': 'chrome\0--type=browser',
    '/proc/4242/environ': 'DISPLAY=:99\0HOME=/opt/crabe/data/navigateur',
  };
  const contexte = makeManager({
    contents,
    closeTimeoutMs: 20,
    launchBrowser: async () => ({
      page: fakePage([ECRAN_CONNEXION]),
      storageState: async () => ({ cookies: [] }),
      close: () => new Promise(() => {}),
    }),
  });

  await contexte.manager.start(ouverture({ onDetected: async () => ({}) }));
  await contexte.manager.stop(1, 'exemple');

  // L'extinction est allée au bout : état terminal, affichage rendu, et le
  // Chromium resté sur :99 a reçu SIGKILL. Sans le délai du lot 48, ce test
  // ne se termine pas — `stop()` attendrait `close()` pour toujours.
  assert.equal(contexte.manager.status(1, 'exemple').state, 'cancelled');
  assert.deepEqual(contexte.manager.reservedDisplays, [], 'l\'affichage est rendu');
  assert.ok(
    contexte.tues.some((t) => t.pid === 4242 && t.signal === 'SIGKILL'),
    'le Chromium coincé reçoit SIGKILL'
  );
  assert.ok(
    contexte.processus.every((p) => p.signals.includes('SIGTERM')),
    'les auxiliaires sont arrêtés malgré le navigateur coincé'
  );
});

test('le nettoyage au démarrage reconnaît un Chromium orphelin par son environnement', () => {
  const contents = {
    '/proc': ['31', '77'],
    '/proc/31/cmdline': 'chrome\0--type=browser',
    '/proc/31/environ': 'DISPLAY=:101\0HOME=/opt/crabe/data/navigateur',
    // Un Chromium d'un AUTRE écran (le poste de quelqu'un) : jamais touché.
    '/proc/77/cmdline': 'chromium\0',
    '/proc/77/environ': 'DISPLAY=:0\0',
  };
  const contexte = makeManager({ contents });

  const bilan = contexte.manager.cleanupOrphans();

  assert.ok(
    bilan.killed.some((k) => k.pid === 31 && k.display === 101),
    'le Chromium de l\'affichage :101 est reconnu et arrêté'
  );
  assert.equal(
    bilan.killed.some((k) => k.pid === 77),
    false,
    'un Chromium hors de la plage de crabe n\'est jamais touché'
  );
});

// ---------------------------------------------------------------------------
// Phase 4 — la preuve lue dans la fenêtre (Boulanger)
// ---------------------------------------------------------------------------

test('preuveSurFenetre : la preuve se lit dans la fenêtre VISIBLE, aucun contrôle headless', async () => {
  // Si un headless se lançait, ce double le compterait — et chez Boulanger il
  // rendrait 404 (mesuré le 22/08/2026) : le test tombe si ce chemin revient.
  const sonde = fauxPlaywrightSonde([{ url: 'https://exemple.test/compte', statut: 404 }]);
  // La fenêtre montre un espace connecté : un lien de déconnexion est là.
  const ecrans = [{
    url: 'https://exemple.test/client',
    'a[href*="logout"]': 1,
  }];
  const contexte = makeManager({ ecrans, requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    marker: '',
    verifyUrl: 'https://exemple.test/client',
    preuveSurFenetre: true,
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1);
  assert.equal(sonde.lancements.length, 0,
    'AUCUN navigateur headless : la preuve vient de la fenêtre elle-même');
});

test('preuveSurFenetre sans preuve à l\'écran : verdict honnête, pas d\'enregistrement', async () => {
  const ecrans = [{ url: 'https://exemple.test/client' }];
  const contexte = makeManager({ ecrans });
  const captures = [];

  await contexte.manager.start(ouverture({
    marker: '',
    verifyUrl: '',
    preuveSurFenetre: true,
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);
  assert.match(resultat.error, /ne montre pas encore un compte connecté/);
  assert.equal(resultat.view.verdictCode, 'sans-preuve-fenetre');

  await contexte.manager.stop(1, 'exemple');
});

// ---------------------------------------------------------------------------
// Phase 3 — le journal en base, attribué au connecteur
// ---------------------------------------------------------------------------

test('le journal par défaut écrit en base sous remote-browser:<id>', async () => {
  await helpers.setup();

  const runtime = remoteBrowser.defaultRuntime();
  runtime.log('info', 'Ligne attribuée au connecteur (essai lot 48).', 'ldlc');
  runtime.log('warn', 'Ligne globale du gestionnaire (essai lot 48).');

  const attribuee = applog.list({ q: 'attribuée au connecteur (essai lot 48)' })[0];
  assert.ok(attribuee, 'la ligne attribuée doit être en base');
  assert.equal(attribuee.source, 'remote-browser:ldlc');

  const globale = applog.list({ q: 'globale du gestionnaire (essai lot 48)' })[0];
  assert.ok(globale, 'la ligne globale doit être en base');
  assert.equal(globale.source, 'remote-browser');
});

// ---------------------------------------------------------------------------
// Lot 67 — Free Mobile ne reconnaissait plus son propre espace client
//
// Ces tests vivent ICI, et non dans un fichier « lot67 », parce que c'est ce
// fichier qui porte les doubles du verdict (`fauxPlaywrightSonde`,
// `makeManager`). Les recopier ailleurs aurait fait deux harnais à maintenir.
//
// Le fait : le 27/08/2026 à 08:54, une connexion faite À LA MAIN a été refusée
// deux fois — « URL finale https://mobile.free.fr/account/v2, aucun marqueur
// de compte ». L'espace abonné est une application React sans lien de
// déconnexion dans le document : la preuve forte de `preuve-connexion` ne peut
// pas s'y trouver. Les deux adresses ci-dessous sont celles MESURÉES le même
// jour, en visiteur anonyme, sans ouvrir la moindre session.
// ---------------------------------------------------------------------------

/** L'espace abonné servi à un compte CONNECTÉ : l'adresse tient, aucun logout. */
const FREE_CONNECTE = 'https://mobile.free.fr/account/v2';

/** Ce qu'un ANONYME reçoit à la même adresse — mesuré : renvoyé au formulaire. */
const FREE_ANONYME =
  'https://mobile.free.fr/account/v2/login?redirect=http%3A%2F%2Fmobile.free.fr%2Faccount%2Fv2';

test('Free Mobile : sans verifyUrlTient, la session pourtant valide est REFUSÉE (le défaut du 27/08)', async () => {
  const sonde = fauxPlaywrightSonde([{ url: FREE_CONNECTE, statut: 200, selecteurs: {} }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorName: 'Free Mobile',
    verifyUrl: FREE_CONNECTE,
    // verifyUrlTient volontairement ABSENT : c'est l'état d'avant le lot 67.
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, false, 'c\'est très exactement le refus observé deux fois');
  assert.equal(captures.length, 0);

  await contexte.manager.stop(1, 'exemple');
});

test('Free Mobile : avec verifyUrlTient, la même page CONFIRME la session', async () => {
  const sonde = fauxPlaywrightSonde([{ url: FREE_CONNECTE, statut: 200, selecteurs: {} }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorName: 'Free Mobile',
    verifyUrl: FREE_CONNECTE,
    verifyUrlTient: true,
    onDetected: async (etat) => ({ fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } }),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, true, 'l\'adresse de contrôle a tenu, or le site en redirige les anonymes');
  assert.equal(resultat.view.state, 'saved');

  await contexte.manager.stop(1, 'exemple');
  void captures;
});

test('Free Mobile : une page servie à un ANONYME ne passe pas pour une session valide', async () => {
  // LA morsure de sûreté. verifyUrlTient ne doit pas devenir un passe-droit :
  // l'adresse de connexion de Free vit SOUS la page de contrôle
  // (/account/v2/login), donc `startsWith` ne la distingue pas. C'est
  // `estUrlAuthentification` qui doit trancher — et si un jour elle cessait de
  // reconnaître « /login », une session anonyme s'enregistrerait.
  const sonde = fauxPlaywrightSonde([{ url: FREE_ANONYME, statut: 200, selecteurs: {} }]);
  const contexte = makeManager({ requirePlaywright: () => sonde.module });
  const captures = [];

  await contexte.manager.start(ouverture({
    connectorName: 'Free Mobile',
    verifyUrl: FREE_CONNECTE,
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));
  assert.equal((await contexte.manager.typeText(1, 'exemple', 'M0t-de-passe')).ok, true);

  const resultat = await contexte.manager.saveNow(1, 'exemple');
  assert.equal(resultat.ok, false, 'un anonyme ne doit JAMAIS être enregistré comme une session');
  assert.equal(captures.length, 0, 'et rien ne doit être capturé');
  assert.ok(
    FREE_ANONYME.startsWith(FREE_CONNECTE),
    'le piège est bien réel : l\'adresse anonyme commence par la page de contrôle'
  );

  await contexte.manager.stop(1, 'exemple');
});
