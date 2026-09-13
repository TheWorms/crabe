'use strict';

/**
 * Lot 71 — la frappe distante ne vise plus un onglet que personne ne regarde.
 *
 * ─── Le défaut mesuré (Boulanger, 08/09/2026, 19:35) ─────────────────────────
 *
 * Le site a ouvert un DOUBLON de sa page de connexion : deux onglets « Me
 * connecter », identiques. « Texte saisi dans la fenêtre — 23 caractères »
 * deux fois, sans effet visible : la saisie visait « le dernier onglet non
 * vide » (lot 70), l'utilisateur regardait l'autre.
 *
 * ─── La mesure qui commande la règle (sonde CT, 08/09/2026) ──────────────────
 *
 * Sous les drapeaux d'automatisation, AUCUN signal ne dit quel onglet est au
 * premier plan : `document.visibilityState` rend « visible » et `hasFocus()`
 * rend vrai sur les DEUX onglets d'une même fenêtre (Playwright désactive la
 * mise en sommeil d'arrière-plan), et `Browser.getWindowForTarget` rend le
 * même identifiant. Puisque le premier plan ne se lit pas :
 *
 *   1. un onglet qui DUPLIQUE la page d'un onglet plus ancien est refermé
 *      passé le même sursis que les onglets vides — l'ambiguïté disparaît ;
 *   2. tant qu'un doublon coexiste, la frappe le DIT au journal et ramène
 *      l'onglet visé au premier plan : ce que l'utilisateur voit est l'endroit
 *      où le texte arrive (et son clic suivant part au même onglet — la
 *      consigne « cliquez d'abord dans le champ » redevient suivable).
 *
 * Toutes les valeurs sont INVENTÉES (exemple.test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');

// ---------------------------------------------------------------------------
// La reconnaissance d'un doublon
// ---------------------------------------------------------------------------

test('memeAdresseOnglet : même page aux paramètres près, jamais un autre chemin', () => {
  assert.equal(remoteBrowser.memeAdresseOnglet(
    'https://boutique.exemple.test/connexion',
    'https://boutique.exemple.test/connexion?retour=%2Fcompte'
  ), true, 'la requête ne fait pas une autre page');
  assert.equal(remoteBrowser.memeAdresseOnglet(
    'https://boutique.exemple.test/connexion',
    'https://boutique.exemple.test/connexion/'
  ), true, 'la barre finale non plus');
  assert.equal(remoteBrowser.memeAdresseOnglet(
    'https://boutique.exemple.test/connexion',
    'https://boutique.exemple.test/cgv'
  ), false, 'un autre chemin est une autre page');
  assert.equal(remoteBrowser.memeAdresseOnglet(
    'https://boutique.exemple.test/connexion',
    'https://idp.exemple.net/connexion'
  ), false, 'un autre site n\'est jamais un doublon');
  assert.equal(remoteBrowser.memeAdresseOnglet('', 'https://exemple.test/'), false);
  assert.equal(remoteBrowser.memeAdresseOnglet('about:blank', 'about:blank'), false,
    'les onglets vides ont leur propre règle (lot 70)');
});

// ---------------------------------------------------------------------------
// Doubles de système — la recette de test/lot70-en-tete-onglets-preuve.test.js
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

function fakeSpawn(fsDouble) {
  return (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fsDouble.existants.add(`/tmp/.X11-unix/X${display}`);
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
 * Une page pilotable : adresse mutable, fermeture comptée, premier plan
 * compté, et un champ actif simulé dont la longueur monte à la frappe.
 */
function pagePilotable(url, { champ = false } = {}) {
  let adresse = url;
  let fermee = false;
  const etat = { avantPlan: 0, longueur: 0 };
  return {
    etat,
    url: () => adresse,
    changerAdresse: (u) => {
      adresse = u;
    },
    isClosed: () => fermee,
    close: async () => {
      fermee = true;
    },
    bringToFront: async () => {
      etat.avantPlan += 1;
    },
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      count: async () => 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: {
      type: async (texte) => {
        etat.longueur += String(texte).length;
      },
      insertText: async (texte) => {
        etat.longueur += String(texte).length;
      },
    },
    evaluate: async () =>
      (champ ? { editable: true, tag: 'input', longueur: etat.longueur } : null),
  };
}

function managerAOnglets({ onglets, delaiOngletVideMs }) {
  const journal = [];
  const fsDouble = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const manager = remoteBrowser.createManager({
    fs: fsDouble,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: fakeSpawn(fsDouble),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({
      page: onglets[0],
      context: { pages: () => onglets },
      storageState: async () => ({ cookies: [] }),
      close: async () => {},
    }),
    timeoutMs: 5_000,
    pollMs: 4,
    delaiOngletVideMs,
  });
  return { manager, journal };
}

/** Attend qu'une condition devienne vraie, sans jamais dépasser une seconde. */
async function attendre(condition) {
  const limite = Date.now() + 1_000;
  while (!condition() && Date.now() < limite) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

// ---------------------------------------------------------------------------
// 1. La surveillance referme le doublon — le test qui mord du brief
// ---------------------------------------------------------------------------

test('un onglet en double de la même page est refermé — la frappe revient au premier', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion');
  const doublon = pagePilotable('https://boutique.exemple.test/connexion');
  const { manager, journal } = managerAOnglets({
    onglets: [origine, doublon],
    delaiOngletVideMs: 15,
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    assert.equal(
      await attendre(() => doublon.isClosed()),
      true,
      'le doublon doit être refermé après le sursis'
    );
    assert.equal(origine.isClosed(), false, 'l\'onglet d\'origine, lui, ne se referme jamais');
    assert.ok(origine.etat.avantPlan >= 1, 'l\'onglet survivant est ramené au premier plan');
    assert.ok(
      journal.some((l) => /en double.*refermé/.test(l.message)),
      'la fermeture est dite au journal'
    );
    // Et la frappe vise désormais le PREMIER : le doublon n'existe plus.
    assert.equal(
      remoteBrowser.choisirOnglet([origine, doublon]),
      origine,
      'le dernier onglet vivant non vide est l\'onglet d\'origine'
    );
  } finally {
    manager.stop(1, 'exemple');
  }
});

test('un onglet du même site sur un AUTRE chemin n\'est pas touché', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion');
  const cgv = pagePilotable('https://boutique.exemple.test/aide/conditions');
  const { manager } = managerAOnglets({
    onglets: [origine, cgv],
    delaiOngletVideMs: 15,
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(cgv.isClosed(), false, 'une autre page du site n\'est pas un doublon');
  } finally {
    manager.stop(1, 'exemple');
  }
});

test('l\'acquis du lot 70 tient : onglet vide + onglet du site, la frappe va au site', () => {
  const site = pagePilotable('https://boutique.exemple.test/connexion');
  const vide = pagePilotable('about:blank');
  assert.equal(remoteBrowser.choisirOnglet([site, vide]), site);
});

// ---------------------------------------------------------------------------
// 2. La frappe pendant le sursis : dite, et visible
// ---------------------------------------------------------------------------

test('tant qu\'un doublon coexiste, la frappe le dit au journal et ramène l\'onglet visé au premier plan', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion');
  // Le doublon porte le champ actif (autofocus du formulaire) : c'est LUI que
  // « le dernier onglet non vide » désigne — le cas mesuré.
  const doublon = pagePilotable('https://boutique.exemple.test/connexion', { champ: true });
  const { manager, journal } = managerAOnglets({
    onglets: [origine, doublon],
    delaiOngletVideMs: 60_000, // le sursis court encore : le doublon est là
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    const resultat = await manager.typeText(1, 'exemple', 'texte-de-collage');
    assert.equal(resultat.ok, true, 'la saisie aboutit');
    assert.ok(doublon.etat.longueur > 0, 'le texte est bien arrivé dans l\'onglet visé');
    assert.ok(
      doublon.etat.avantPlan >= 1,
      'l\'onglet visé est ramené au premier plan : ce que l\'utilisateur voit est là où le texte arrive'
    );
    assert.ok(
      journal.some((l) => /deux onglets de la même page/.test(l.message)),
      'l\'ambiguïté est dite au journal, jamais une saisie en silence'
    );
  } finally {
    manager.stop(1, 'exemple');
  }
});

test('sans doublon, la frappe ne change pas d\'onglet et le journal reste muet là-dessus', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion', { champ: true });
  const { manager, journal } = managerAOnglets({
    onglets: [origine],
    delaiOngletVideMs: 60_000,
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    const resultat = await manager.typeText(1, 'exemple', 'texte');
    assert.equal(resultat.ok, true);
    assert.equal(origine.etat.avantPlan, 0, 'aucun changement de premier plan imposé');
    assert.equal(
      journal.some((l) => /deux onglets de la même page/.test(l.message)),
      false
    );
  } finally {
    manager.stop(1, 'exemple');
  }
});
