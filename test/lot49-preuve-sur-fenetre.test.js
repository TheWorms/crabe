'use strict';

/**
 * Lot 49 — la preuve de session se lit sur la page affichée, pas sur une
 * seconde requête.
 *
 * Le 23/08/2026 au matin, l'utilisateur avait la page de ses commandes Darty sous les
 * yeux à l'adresse de contrôle exacte — et l'enregistrement échouait : crabe
 * REFAISAIT la requête de son côté, et DataDome bloquait cette seconde requête
 * pendant que la fenêtre affichait la page. Vérifier une session en
 * redemandant la page est fragile par construction sur un site à mur. Ces
 * tests MORDENT sur la nouvelle voie : l'adresse courante a tenu dans la
 * fenêtre ET un marqueur mesuré est dans la page — sans aucune requête
 * supplémentaire. Retirez la lecture des marqueurs, la garde d'URL, la garde
 * de formulaire, la liste blanche du schéma ou la relecture unique de
 * profil-marchand : ils tombent.
 *
 * ⚠ Toutes les valeurs (numéros de commande, adresses) sont INVENTÉES —
 * les motifs se calibrent sur la forme, jamais sur une valeur réelle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');
const schema = require('../server/connectors/manifest-schema');
const profilMarchand = require('../server/connectors/profil-marchand');
const preuveConnexion = require('../server/connectors/preuve-connexion');

// ---------------------------------------------------------------------------
// Doubles de système — la recette de test/lot48-verdict.test.js, plus un
// document simulé : les `page.evaluate` exécutent la VRAIE fonction de
// production sur ce document, jamais une réimplémentation du test.
// ---------------------------------------------------------------------------

function fakeFs({ present = [] } = {}) {
  const existants = new Set(present);
  return {
    existants,
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => {
      if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`);
    },
    readdirSync: () => {
      throw new Error('ENOENT');
    },
    readFileSync: () => {
      throw new Error('ENOENT');
    },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => existants.delete(String(p)),
  };
}

function fakeSpawn(fs) {
  return (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fs.existants.add(`/tmp/.X11-unix/X${display}`);
    }
    return {
      command,
      args: args.map(String),
      stdout: { resume: () => {} },
      stderr: { resume: () => {} },
      on: () => {},
      kill: () => {},
    };
  };
}

/**
 * Un document juste assez vrai pour les fonctions de production : chaque
 * écran déclare son DOM par sélecteur (`dom`), son texte (`texteCorps`).
 */
function documentFactice(ecran) {
  const noeud = (spec) => ({
    innerText: '',
    tagName: 'DIV',
    children: [],
    offsetWidth: 10,
    offsetHeight: 10,
    ...spec,
  });
  return {
    body: { innerText: ecran.texteCorps || '' },
    title: ecran.titre || '',
    querySelectorAll: (sel) => (ecran.dom?.[sel] || []).map(noeud),
  };
}

/**
 * Page Playwright simulée. `goto` avance d'un écran ; `evaluate` exécute la
 * fonction reçue sur le document simulé de l'écran courant.
 */
function pageFactice(ecrans) {
  let index = 0;
  const courant = () => ecrans[Math.min(index, ecrans.length - 1)];
  const gotos = [];
  return {
    gotos,
    url: () => courant().url,
    goto: async (url) => {
      gotos.push(url);
      if (index < ecrans.length - 1) index += 1;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    locator: (selecteur) => ({
      count: async () => courant().selecteurs?.[selecteur] || 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async (fn, arg) => {
      global.document = documentFactice(courant());
      global.location = { href: courant().url };
      try {
        return fn(arg);
      } finally {
        delete global.document;
        delete global.location;
      }
    },
  };
}

function makeManager({ page }) {
  const journal = [];
  const fs = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const sonde = { lancements: [] };
  const manager = remoteBrowser.createManager({
    fs,
    os: {
      totalmem: () => 4096 * 1024 * 1024,
      freemem: () => 2600 * 1024 * 1024,
    },
    spawn: fakeSpawn(fs),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({
      page,
      storageState: async () => ({
        cookies: [{ name: 'a', value: 'x', domain: '.exemple.test', expires: -1 }],
      }),
      close: async () => {},
    }),
    // Si la preuve sur fenêtre relançait un contrôle headless, ce double le
    // compterait — et le test tomberait : c'est le défaut que ce lot corrige.
    requirePlaywright: () => ({
      chromium: {
        launch: async () => {
          sonde.lancements.push('headless');
          throw new Error('aucun contrôle headless ne doit se lancer ici');
        },
      },
    }),
    timeoutMs: 5_000,
    pollMs: 4,
  });
  return { manager, journal, sonde };
}

function ouverture(extra = {}) {
  return {
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://exemple.test/connexion',
    marker: '',
    ...extra,
  };
}

/** Deux clics « Enregistrer » : le premier confirme l'absence de saisie. */
async function enregistrer(manager) {
  const premier = await manager.saveNow(1, 'exemple');
  assert.equal(premier.ok, false);
  assert.match(premier.error, /Rien n'a encore été saisi/);
  return manager.saveNow(1, 'exemple');
}

// ---------------------------------------------------------------------------
// La preuve lue sur la page affichée — le cas Darty
// ---------------------------------------------------------------------------

test('marqueur mesuré + adresse tenue dans la fenêtre : enregistré sans aucune requête', async () => {
  // La fenêtre affiche la page des commandes (l'adresse de contrôle), avec des
  // blocs de commandes mesurés — mais AUCUN lien de déconnexion : la preuve
  // forte générique ne peut rien, seule la lecture des marqueurs conclut.
  const page = pageFactice([{
    url: 'https://exemple.test/espace/mes-commandes',
    selecteurs: { '[data-testid="order"]': 2 },
  }]);
  const contexte = makeManager({ page });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/espace/mes-commandes',
    preuveSurFenetre: true,
    marqueursFenetre: [{ selecteur: '[data-testid="order"]' }],
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1);
  assert.equal(contexte.sonde.lancements.length, 0,
    'AUCUNE requête de contrôle : la preuve vient du DOM déjà affiché');
  // Le journal dit la preuve : l'adresse a tenu, le marqueur est lu.
  const ligne = contexte.journal.find((l) => /marqueur mesuré/.test(l.message));
  assert.ok(ligne, 'la preuve par marqueur doit être journalisée');
  assert.match(ligne.message, /sans requête supplémentaire/);
});

test('marqueur textuel de FORME (« N° F » + chiffres dans un h3) : la vraie fonction lit le document', async () => {
  // Le cas Boulanger : pas de lien de déconnexion dans le document, mais des
  // <h3> qui portent « N° F » suivi de chiffres — numéro INVENTÉ ici.
  const page = pageFactice([{
    url: 'https://exemple.test/account/my-orders/finished',
    dom: { h3: [{ innerText: 'Commande N° F00112233' }] },
  }]);
  const contexte = makeManager({ page });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/account/my-orders/finished',
    preuveSurFenetre: true,
    marqueursFenetre: [
      { selecteur: '.order' },
      { selecteur: 'h3', texte: 'n[°o]\\s*F\\d+' },
    ],
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: 1 } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1);
  assert.equal(contexte.sonde.lancements.length, 0);
});

test('adresse tenue mais AUCUN marqueur : rien ne s\'enregistre — l\'URL seule ne prouve rien', async () => {
  const page = pageFactice([{ url: 'https://exemple.test/espace/mes-commandes' }]);
  const contexte = makeManager({ page });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/espace/mes-commandes',
    preuveSurFenetre: true,
    marqueursFenetre: [{ selecteur: '[data-testid="order"]' }],
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'l\'adresse tenue sans marqueur ne conclut JAMAIS');
  assert.equal(resultat.view.verdictCode, 'sans-preuve-fenetre');

  await contexte.manager.stop(1, 'exemple');
});

test('marqueur présent mais sur une URL d\'authentification : refus — un formulaire reste un formulaire', async () => {
  // Une page de connexion qui afficherait par ailleurs le motif ne doit
  // jamais passer : c'est la garde `surFormulaire`, héritée du lot 14.
  const page = pageFactice([{
    url: 'https://exemple.test/connexion',
    selecteurs: { '[data-testid="order"]': 1 },
  }]);
  const contexte = makeManager({ page });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/connexion',
    preuveSurFenetre: true,
    marqueursFenetre: [{ selecteur: '[data-testid="order"]' }],
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);

  await contexte.manager.stop(1, 'exemple');
});

test('« Enregistrer » conduit la fenêtre sur l\'adresse de contrôle quand la preuve n\'est pas là', async () => {
  // L'utilisateur est resté sur l'accueil après sa connexion : le clic
  // « Enregistrer » (et lui seul) déplace la page vers l'adresse déclarée,
  // où les marqueurs concluent.
  const page = pageFactice([
    { url: 'https://exemple.test/accueil' },
    {
      url: 'https://exemple.test/espace/mes-commandes',
      selecteurs: { '[data-testid="order"]': 3 },
    },
  ]);
  const contexte = makeManager({ page });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/espace/mes-commandes',
    preuveSurFenetre: true,
    marqueursFenetre: [{ selecteur: '[data-testid="order"]' }],
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: 1 } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.ok(page.gotos.includes('https://exemple.test/espace/mes-commandes'),
    'la fenêtre est conduite sur l\'adresse de contrôle');
  assert.equal(captures.length, 1);
});

// ---------------------------------------------------------------------------
// Le schéma : les marqueurs se déclarent, la liste blanche les garde
// ---------------------------------------------------------------------------

function manifesteBoulanger() {
  return structuredClone(require('../server/connectors/available/boulanger/manifest.json'));
}

test('marqueursFenetre sans preuveSurFenetre : manifeste refusé — ils ne seraient jamais lus', () => {
  const manifeste = manifesteBoulanger();
  delete manifeste.remoteLogin.preuveSurFenetre;
  const resultat = schema.validate(manifeste);
  assert.equal(resultat.ok, false);
  assert.ok(resultat.errors.some((e) => /ne seraient jamais lus/.test(e)), resultat.errors.join(' | '));
});

test('marqueursFenetre sans verifyUrl : manifeste refusé — aucune adresse dont juger la tenue', () => {
  const manifeste = manifesteBoulanger();
  delete manifeste.remoteLogin.verifyUrl;
  const resultat = schema.validate(manifeste);
  assert.equal(resultat.ok, false);
  assert.ok(resultat.errors.some((e) => /aucune adresse dont juger la tenue/.test(e)), resultat.errors.join(' | '));
});

test('un motif invalide ou un marqueur vide sont refusés à la déclaration', () => {
  const manifeste = manifesteBoulanger();
  manifeste.remoteLogin.marqueursFenetre = [{ selecteur: 'h3', texte: '(' }];
  const invalide = schema.validate(manifeste);
  assert.equal(invalide.ok, false);
  assert.ok(invalide.errors.some((e) => /n'est pas une expression valide/.test(e)));

  manifeste.remoteLogin.marqueursFenetre = [{}];
  const vide = schema.validate(manifeste);
  assert.equal(vide.ok, false);
  assert.ok(vide.errors.some((e) => /« selecteur » \(CSS\) et\/ou « texte »/.test(e)));
});

test('la normalisation GARDE marqueursFenetre — le piège de la liste blanche', () => {
  // `normalize` est une liste blanche : tout ce qu'elle ne recopie pas
  // disparaît du manifeste chargé. C'est ainsi qu'un premier `persistent` a
  // été jeté en silence le 12/08/2026 — ce test interdit la récidive.
  const normalise = schema.normalize(manifesteBoulanger());
  assert.deepEqual(normalise.remoteLogin.marqueursFenetre, [
    { selecteur: '.order', texte: '' },
    { selecteur: 'h3', texte: 'n[°o]\\s*F\\d+' },
  ]);
});

// ---------------------------------------------------------------------------
// profil-marchand : la relecture unique, et la précision au journal
// ---------------------------------------------------------------------------

test('un renvoi TRANSITOIRE vers l\'authentification est relu une fois, et passe', async () => {
  // Le cas Bricomarché du 23/08/2026 à 07:38:42 : la récupération lancée à la
  // seconde où la fenêtre s'éteignait a été renvoyée vers /login, pendant que
  // la même session, rejouée plus tard, tenait. Une relecture départage.
  const page = pageFactice([
    // L'écran d'avant toute navigation, puis ce que chaque goto obtient :
    // d'abord le renvoi vers /login, puis la page qui tient.
    { url: 'about:blank' },
    { url: 'https://exemple.test/login' },
    { url: 'https://exemple.test/my-account' },
  ]);
  const journal = [];
  await profilMarchand.atteindreLaPage(page, {
    id: 'exemple',
    nom: 'Exemple',
    log: (m) => journal.push(m),
    urlDepart: 'https://exemple.test/my-account',
  });
  assert.equal(page.url(), 'https://exemple.test/my-account');
  assert.equal(journal.filter((m) => /renvoyé vers/.test(m)).length, 1,
    'le premier renvoi est journalisé avec son adresse');
});

test('un renvoi qui PERSISTE reste une session expirée — et le journal dit vers où', async () => {
  const page = pageFactice([{ url: 'https://exemple.test/login' }]);
  const journal = [];
  await assert.rejects(
    () => profilMarchand.atteindreLaPage(page, {
      id: 'exemple',
      nom: 'Exemple',
      log: (m) => journal.push(m),
      urlDepart: 'https://exemple.test/my-account',
    }),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.precision, /redirection vers https:\/\/exemple\.test\/login/);
      return true;
    }
  );
  assert.equal(journal.filter((m) => /renvoyé vers https:\/\/exemple\.test\/login/.test(m)).length, 2,
    'chaque lecture est journalisée : le diagnostic ne se perd plus');
});

// ---------------------------------------------------------------------------
// Les repères comptés sur le sélecteur MESURÉ, le motif en filet
// ---------------------------------------------------------------------------

test('photographier compte les commandes sur le sélecteur relevé quand il en trouve', async () => {
  const page = pageFactice([{
    url: 'https://exemple.test/espace/mes-commandes',
    dom: {
      '.order': [{}, {}, {}],
      '*': [{ innerText: 'N° F00112233' }],
    },
  }]);
  const vue = await profilMarchand.photographier(page, /n[°o]\s*F\d+/i, '.order');
  assert.equal(vue.reperes, 3, 'le sélecteur mesuré prime sur le motif de texte');
});

test('photographier retombe sur le motif de forme quand le sélecteur ne trouve rien', async () => {
  const page = pageFactice([{
    url: 'https://exemple.test/espace/mes-commandes',
    dom: { '*': [{ innerText: 'Commande N° F44556677' }] },
  }]);
  const vue = await profilMarchand.photographier(page, /n[°o]\s*F\d+/i, '.order');
  assert.equal(vue.reperes, 1, 'le motif reste le filet du sélecteur');
});

// ---------------------------------------------------------------------------
// jugerLaListe : le marqueur mesuré vaut preuve là où l'adresse ne prouve rien
// ---------------------------------------------------------------------------

test('sans redirection d\'anonymes mesurée, un marqueur mesuré atteste la liste', async () => {
  // Boulanger : la coquille est servie à tout le monde, rester ne prouve
  // rien ; mais des blocs de commandes « .order » ne sont servis qu'à un
  // compte connecté — et il n'y a AUCUN lien de déconnexion dans le document.
  const page = pageFactice([{
    url: 'https://exemple.test/account/my-orders/finished',
    selecteurs: { '.order': 2 },
    dom: { '.order': [{}, {}] },
  }]);
  const { etat } = await profilMarchand.jugerLaListe(page, {
    cheminListe: /\/account\/my-orders\/finished/i,
    redirigeLesAnonymes: false,
    marqueursMesures: [{ selecteur: '.order' }],
    selecteurRepere: '.order',
  });
  assert.equal(etat.servie, true);
  assert.match(etat.raison, /marqueur mesuré/);
  assert.equal(etat.reperes, 2);
});

test('ni marqueur mesuré ni lien de déconnexion : la liste n\'est PAS attestée', async () => {
  const page = pageFactice([{ url: 'https://exemple.test/account/my-orders/finished' }]);
  const { etat } = await profilMarchand.jugerLaListe(page, {
    cheminListe: /\/account\/my-orders\/finished/i,
    redirigeLesAnonymes: false,
    marqueursMesures: [{ selecteur: '.order' }],
  });
  assert.equal(etat.servie, false);
  assert.equal(etat.sessionAbsente, true);
  assert.match(etat.raison, /ni marqueur mesuré ni preuve forte/);
});

// ---------------------------------------------------------------------------
// Les adresses et motifs corrigés des connecteurs
// ---------------------------------------------------------------------------

test('Boulanger vise les commandes PASSÉES — l\'adresse « in-progress » était l\'erreur mesurée', () => {
  const boulanger = require('../server/connectors/available/boulanger/connector');
  assert.equal(boulanger.URL_COMMANDES, 'https://www.boulanger.com/account/my-orders/finished');
  assert.ok(boulanger.CHEMIN_LISTE.test('https://www.boulanger.com/account/my-orders/finished'));
  assert.equal(boulanger.CHEMIN_LISTE.test('https://www.boulanger.com/account/my-orders/in-progress'),
    false, 'les commandes en cours ne sont pas la liste des commandes passées');
  // Le motif est une FORME (« N° F » + chiffres), calibrée sur numéro inventé.
  assert.ok(boulanger.MOTIF_REPERE.test('N° F00112233'));
  assert.equal(boulanger.MOTIF_REPERE.test('N° 123456'), false,
    'sans le F, ce n\'est pas un numéro de commande Boulanger');

  const manifeste = manifesteBoulanger();
  assert.equal(manifeste.remoteLogin.verifyUrl, 'https://www.boulanger.com/account/my-orders/finished');
  assert.equal(manifeste.remoteLogin.preuveSurFenetre, true);
  assert.ok(Array.isArray(manifeste.remoteLogin.marqueursFenetre)
    && manifeste.remoteLogin.marqueursFenetre.length >= 2);
  // Les deux pièges mesurés sont CONSIGNÉS pour le lot du parcours.
  assert.match(manifeste.technicalNote, /bl-button/);
  assert.match(manifeste.technicalNote, /sera disponible à la délivrance/);
});

test('Darty : preuve sur fenêtre déclarée, et les repères du parcours consignés', () => {
  const darty = require('../server/connectors/available/darty/connector');
  assert.equal(darty.SELECTEUR_REPERE, '[data-testid="order"]');
  const manifeste = structuredClone(require('../server/connectors/available/darty/manifest.json'));
  assert.equal(manifeste.remoteLogin.preuveSurFenetre, true);
  assert.equal(manifeste.remoteLogin.verifyUrl, 'https://www.darty.com/espace_client/mes-commandes');
  const selecteurs = manifeste.remoteLogin.marqueursFenetre.map((m) => m.selecteur || m.texte);
  assert.deepEqual(selecteurs, ['[data-testid="order"]', '[data-testid="orderHeader"]', 'Mes commandes']);
  // Les repères du détail et de la facture attendent le lot suivant — dans la
  // note technique, jamais dans le code d'un parcours qui n'existe pas.
  assert.match(manifeste.technicalNote, /downloadBillLink/);
  assert.match(manifeste.technicalNote, /Justificatif de vente/);
  assert.match(manifeste.technicalNote, /mes-commandes\/<numéro>\/0/);
});

// ---------------------------------------------------------------------------
// Le chercheur de marqueurs lui-même — aucune requête, jamais d'exception
// ---------------------------------------------------------------------------

test('chercherMarqueursMesures décrit ce qu\'il trouve, et survit à une page en mouvement', async () => {
  const page = pageFactice([{
    url: 'https://exemple.test/liste',
    selecteurs: { '.order': 1 },
    dom: { h3: [{ innerText: 'N° F99887766' }] },
    texteCorps: 'Mes commandes',
  }]);
  const trouves = await preuveConnexion.chercherMarqueursMesures(page, [
    { selecteur: '.order' },
    { selecteur: 'h3', texte: 'n[°o]\\s*F\\d+' },
    { texte: 'Mes commandes' },
    {},
  ]);
  assert.deepEqual(trouves, [
    '.order',
    'h3 portant « n[°o]\\s*F\\d+ »',
    'texte « Mes commandes »',
  ]);

  // Une page qui lève pendant la lecture ne fait pas tomber le contrôle.
  const cassee = {
    locator: () => ({ count: async () => { throw new Error('page fermée'); } }),
    evaluate: async () => { throw new Error('page fermée'); },
  };
  assert.deepEqual(await preuveConnexion.chercherMarqueursMesures(cassee, [
    { selecteur: '.order' },
    { texte: 'Mes commandes' },
  ]), []);
});
