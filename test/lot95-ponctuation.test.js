'use strict';

/**
 * Lot 95 (R5) — la ligne de validité d'une connexion ne finit plus par « ).). ».
 *
 * Mesuré le 06/10/2026 au journal de production : la capture de Gandi a écrit
 * « … validité vérifiée (Gandi : connexion confirmée — l'adresse de contrôle
 * https://admin.gandi.net/billing a tenu, or le site en redirige les anonymes
 * (9 cookie(s)).). ». Le défaut naît dans l'enveloppe COMMUNE de
 * `remote-browser.js` : chaque phrase de preuve d'une connexion confirmée
 * finit déjà par un point, et l'enveloppe l'entourait de « (…). ». Toutes les
 * lignes de validité en production en portaient la trace : 104 lignes, dont
 * celles de 19 connecteurs nommés (docs/reconnaissance-lot95.md).
 *
 * La correction tient dans l'enveloppe (`ligneDeValidite`) : le point final de
 * la preuve est retiré avant de refermer la parenthèse. Ces essais prouvent
 * que SEUL ce point change, pour les cinq formes de preuve, et la ligne de
 * Gandi mot pour mot par le vrai chemin de la capture (doubles de système du
 * lot 68 : aucun navigateur, aucun réseau).
 *
 * ⚠ Valeurs inventées (hôtes `exemple.test`), sauf l'adresse de contrôle de
 * Gandi, publique, celle de son manifeste.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');
const preuve = require('../server/connectors/preuve-connexion');

/** L'enveloppe d'avant le lot 95, telle qu'elle s'écrivait. */
const ancienne = (p) => `validité vérifiée (${p}).`;

/** Les cinq formes de preuve d'une connexion confirmée (remote-browser.js, `essayerSession`). */
const FORMES = {
  'adresse tenue (Gandi, Ameli, Bricomarché…)': 'Gandi : connexion confirmée — l\'adresse de contrôle '
    + 'https://admin.gandi.net/billing a tenu, or le site en redirige les anonymes (9 cookie(s)).',
  'espace client hébergé ailleurs (Atma)': 'Exemple : connexion confirmée — la page de contrôle a renvoyé vers '
    + 'l\'espace client hébergé sur exemple.test (URL finale https://exemple.test/compte), hors écran de connexion, '
    + 'or ce domaine ne sert une page de compte qu\'à une session établie (8 cookie(s)).',
  'marqueur de compte (Darty, Hetzner, impots…)': preuve.ligneConfirmee('Exemple', {
    url: 'https://exemple.test/compte', preuvesFortes: ['a[href*="logout"]'], cookies: 2,
  }),
  'renvoi mesuré (Airbnb, Amazon, Anthropic)': 'Exemple : connexion confirmée — la page est restée sur le site '
    + '(URL finale https://exemple.test/voyages) sans renvoi vers la connexion, or c\'est ainsi que ce site éconduit '
    + 'les visiteurs sans session — comportement mesuré (35 cookie(s)).',
  'preuve lue dans la fenêtre (Boulanger)': 'Exemple : connexion confirmée — la fenêtre affiche '
    + 'https://exemple.test/compte (l\'adresse de contrôle a tenu) et son marqueur mesuré (.commande), lu sans requête supplémentaire.',
};

test('R5 — les cinq formes de preuve : la ligne ne finit plus par « ).). », et seul ce point change', () => {
  for (const [nom, p] of Object.entries(FORMES)) {
    assert.ok(p.endsWith('.'), `${nom} : la preuve finit bien par un point (c'est la cause)`);
    assert.ok(ancienne(p).endsWith('.).'), `${nom} : l'ancienne enveloppe doublait la ponctuation`);
    const ligne = remoteBrowser.ligneDeValidite(p);
    assert.doesNotMatch(ligne, /\.\)\.$/, nom);
    assert.equal(ligne, `validité vérifiée (${p.slice(0, -1)}).`, `${nom} : le point final de la preuve, et rien d'autre`);
    assert.equal(ligne.length, ancienne(p).length - 1, `${nom} : un seul caractère de moins`);
  }
  // La ligne de Gandi, mot pour mot.
  assert.equal(remoteBrowser.ligneDeValidite(FORMES['adresse tenue (Gandi, Ameli, Bricomarché…)']),
    'validité vérifiée (Gandi : connexion confirmée — l\'adresse de contrôle https://admin.gandi.net/billing a tenu, '
    + 'or le site en redirige les anonymes (9 cookie(s))).');
  // Une preuve qui ne finirait pas par un point garde l'enveloppe d'avant, à l'octet.
  assert.equal(remoteBrowser.ligneDeValidite('preuve sans point final'), ancienne('preuve sans point final'));
});

// ---------------------------------------------------------------------------
// Le vrai chemin de la capture — doubles de système du lot 68
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

/** La page de la FENÊTRE — juste assez pour la détection. */
function pageFenetre(url) {
  return {
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    isClosed: () => false,
    locator: () => ({
      count: async () => 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async () => null,
  };
}

/** Le contrôle HEADLESS : un écran, décrit par son adresse finale, son statut et son texte. */
function fauxControleHeadless(ecran) {
  return {
    chromium: {
      launch: async () => {
        const pageControle = {
          setDefaultTimeout: () => {},
          goto: async () => ({ status: () => ecran.statut }),
          waitForLoadState: async () => {},
          url: () => ecran.url,
          locator: () => ({ count: async () => 0 }),
          evaluate: async (fn, arg) => {
            global.document = { body: { innerText: ecran.texteCorps || '' } };
            try {
              return fn(arg);
            } finally {
              delete global.document;
            }
          },
        };
        return {
          newContext: async () => ({ newPage: async () => pageControle }),
          close: async () => {},
        };
      },
    },
  };
}

test('R5 — par le vrai chemin de la capture : la ligne de validité de Gandi, mot pour mot', async () => {
  const journal = [];
  const fs = fakeFs({ present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify', '/usr/share/novnc/core/rfb.js'] });
  const cookies = Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, value: 'x', domain: '.gandi.net', expires: -1 }));
  const manager = remoteBrowser.createManager({
    fs,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
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
      page: pageFenetre('https://admin.gandi.net/billing/organisation-inventee/organizations'),
      storageState: async () => ({ cookies }),
      close: async () => {},
    }),
    requirePlaywright: () => fauxControleHeadless({
      url: 'https://admin.gandi.net/billing', statut: 200, texteCorps: 'Facturation',
    }),
    timeoutMs: 5_000,
    pollMs: 4,
  });
  await manager.start({
    userId: 1,
    connectorId: 'gandi',
    connectorName: 'Gandi',
    url: 'https://id.gandi.net/fr/login',
    marker: '',
    verifyUrl: 'https://admin.gandi.net/billing',
    verifyUrlTient: true,
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => ({ fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } }),
  });
  const premier = await manager.saveNow(1, 'gandi');
  assert.equal(premier.ok, false);
  const resultat = await manager.saveNow(1, 'gandi');
  assert.equal(resultat.ok, true, resultat.error);
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.ok(ligne, 'la capture est journalisée');
  assert.equal(ligne.message,
    'Session Gandi capturée par navigateur distant pour le compte 1 — 9 cookie(s), validité vérifiée (Gandi : '
    // Lot 105 (R6) : l'adresse de contrôle au journal — l'hôte et le chemin, sans « https:// ».
    + 'connexion confirmée — l\'adresse de contrôle admin.gandi.net/billing a tenu, or le site en redirige les '
    + 'anonymes (9 cookie(s))).');
  assert.doesNotMatch(ligne.message, /\.\)\.$/);
});
