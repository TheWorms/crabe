'use strict';

/**
 * Lot 73 — l'espace client vit légitimement sur un AUTRE domaine.
 *
 * Le 09/09/2026, l'utilisateur ne peut pas enregistrer sa session Atma : la page de
 * contrôle (atmakitchenware.fr/account) renvoie un connecté vers
 * shopify.com/<boutique>/account/orders — sa liste de commandes, hébergée sur
 * shopify.com, le système « comptes clients » de Shopify. Le lot 68 juge ce
 * renvoi « vers un autre site » (garde `memeSite`) et REFUSE : juste pour un
 * fournisseur d'identité tiers, faux pour un espace client qui vit
 * légitimement ailleurs.
 *
 * Le traitement est déclaratif : `remoteLogin.domaineEspaceClient` dit où vit
 * l'espace client quand il diffère de la boutique, et un renvoi VERS ce
 * domaine devient la preuve — avec les gardes du lot 68 conservées : un statut
 * ≥ 400 n'est jamais une preuve, un renvoi vers un écran de connexion reste un
 * refus, un départ vers un domaine NON déclaré ne prouve toujours rien.
 *
 * ⚠ Toutes les adresses et valeurs sont INVENTÉES (exemple.test, shopify.com
 * avec un identifiant fictif) — sauf la forme de route Shopify, qui est la
 * mesure publique du renvoi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');
const schema = require('../server/connectors/manifest-schema');
const preuve = require('../server/connectors/preuve-connexion');

// ---------------------------------------------------------------------------
// Phase A — l'aide : surDomaine
// ---------------------------------------------------------------------------

test('surDomaine : le domaine déclaré et ses sous-domaines oui, un suffixe trompeur non', () => {
  assert.equal(preuve.surDomaine('https://shopify.com/12345/account/orders', 'shopify.com'), true);
  assert.equal(preuve.surDomaine('https://account.shopify.com/x', 'shopify.com'), true);
  assert.equal(preuve.surDomaine('https://www.shopify.com/12345/account', 'shopify.com'), true);
  // Le piège du suffixe : « shopify.com.exemple.net » n'a de shopify que le début.
  assert.equal(preuve.surDomaine('https://shopify.com.exemple.net/', 'shopify.com'), false);
  // Et l'inverse d'un suffixe ne compte pas : la boutique n'« est » pas shopify.
  assert.equal(preuve.surDomaine('https://exemple.test/account', 'shopify.com'), false);
  assert.equal(preuve.surDomaine('pas une url', 'shopify.com'), false);
  assert.equal(preuve.surDomaine('https://shopify.com/x', ''), false);
});

// ---------------------------------------------------------------------------
// Phase B — le schéma : une mesure déclarée, jamais une supposition
// ---------------------------------------------------------------------------

function manifesteMinimal(remoteLogin) {
  return {
    id: 'exemple-lot73',
    name: 'Exemple',
    category: 'shopping',
    site: 'exemple.test',
    implementation: 'scraping',
    description: 'Récupère automatiquement vos factures Exemple pour les archiver.',
    remoteLogin: {
      url: 'https://exemple.test/account',
      ...remoteLogin,
    },
    fields: [{ key: 'session', label: 'Connexion', type: 'session', required: false }],
    permissions: [
      { key: 'factures', scope: 'read-write', description: 'Télécharge vos factures Exemple pour les archiver.' },
    ],
  };
}

test('schéma : domaineEspaceClient accepte un nom de domaine, refuse le vide et le non-domaine', () => {
  const bon = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/account',
    domaineEspaceClient: 'shopify.com',
  }));
  assert.equal(bon.ok, true, bon.errors.join(' | '));

  const vide = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/account',
    domaineEspaceClient: '   ',
  }));
  assert.equal(vide.ok, false);
  assert.match(vide.errors.join(' '), /domaineEspaceClient/);

  const pasDomaine = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/account',
    domaineEspaceClient: 'pas un domaine',
  }));
  assert.equal(pasDomaine.ok, false);
  assert.match(pasDomaine.errors.join(' '), /n'est pas un nom de domaine/);
});

test('schéma : domaineEspaceClient sans verifyUrl est refusé — aucune adresse dont juger le renvoi', () => {
  const resultat = schema.validate(manifesteMinimal({ domaineEspaceClient: 'shopify.com' }));
  assert.equal(resultat.ok, false);
  assert.match(resultat.errors.join(' '), /domaineEspaceClient sans remoteLogin\.verifyUrl/);
});

test('schéma : la liste blanche recopie domaineEspaceClient — sans elle, la clé disparaîtrait en silence', () => {
  const charge = schema.normalize(manifesteMinimal({
    verifyUrl: 'https://exemple.test/account',
    domaineEspaceClient: 'shopify.com',
  }));
  assert.equal(charge.remoteLogin.domaineEspaceClient, 'shopify.com');
  // Absent du manifeste : chaîne vide, jamais undefined — comme les autres options.
  const sans = schema.normalize(manifesteMinimal({ verifyUrl: 'https://exemple.test/account' }));
  assert.equal(sans.remoteLogin.domaineEspaceClient, '');
});

test('manifeste réel : Atma déclare domaineEspaceClient=shopify.com et ne code aucun identifiant de boutique', () => {
  const manifeste = require('../server/connectors/available/atma/manifest.json');
  assert.equal(manifeste.remoteLogin.domaineEspaceClient, 'shopify.com');
  assert.ok(manifeste.remoteLogin.verifyUrl, 'pas de renvoi mesurable sans adresse de contrôle');
  // §1bis : l'identifiant numérique de la boutique ne se code pas en dur.
  const texte = JSON.stringify(manifeste);
  assert.equal(/\b\d{8,}\b/.test(texte), false, 'aucun identifiant de boutique en dur dans le manifeste');
});

test('connecteur Atma : le chemin de compte n\'ancre aucun identifiant de boutique (un \\d+ générique)', () => {
  const atma = require('../server/connectors/available/atma/connector.js');
  // La liste des commandes du connecté, sur un identifiant de boutique FICTIF.
  assert.equal(atma.CHEMIN_COMPTE.test('https://shopify.com/99999999/account/orders?locale=fr'), true);
  assert.equal(atma.CHEMIN_COMPTE.test('https://shopify.com/99999999/account'), true);
  assert.equal(atma.CHEMIN_COMPTE.test('https://atmakitchenware.fr/account'), true);
  // /account/login ne doit PAS passer pour l'espace client (leçon electro-depot, lot 52).
  assert.equal(atma.CHEMIN_COMPTE.test('https://atmakitchenware.fr/account/login'), false);
  assert.equal(atma.CHEMIN_COMPTE.test('https://shopify.com/authentication/99999999/login'), false);
  // Et le code source lui-même n'embarque aucun identifiant de boutique.
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../server/connectors/available/atma/connector.js'), 'utf8');
  assert.equal(/\b\d{8,}\b/.test(source), false, 'aucun identifiant de boutique en dur dans le connecteur');
});

// ---------------------------------------------------------------------------
// Doubles de système — recette de test/lot68-preuve-par-renvoi.test.js.
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

function fauxControleHeadless(ecran) {
  const lancements = [];
  return {
    lancements,
    module: {
      chromium: {
        launch: async () => {
          lancements.push(ecran.url);
          const pageControle = {
            setDefaultTimeout: () => {},
            goto: async () => (ecran.statut ? { status: () => ecran.statut } : undefined),
            waitForLoadState: async () => {},
            url: () => ecran.url,
            locator: (selecteur) => ({ count: async () => ecran.selecteurs?.[selecteur] || 0 }),
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
    },
  };
}

function makeManager({ ecranControle, urlFenetre = 'https://exemple.test/account' }) {
  const journal = [];
  const fs = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const sonde = fauxControleHeadless(ecranControle);
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
      page: pageFenetre(urlFenetre),
      storageState: async () => ({
        cookies: [{ name: 'a', value: 'x', domain: '.shopify.com', expires: -1 }],
      }),
      close: async () => {},
    }),
    requirePlaywright: () => sonde.module,
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
    url: 'https://exemple.test/account',
    marker: '',
    ...extra,
  };
}

async function enregistrer(manager) {
  const premier = await manager.saveNow(1, 'exemple');
  assert.equal(premier.ok, false);
  assert.match(premier.error, /Rien n'a encore été saisi/);
  return manager.saveNow(1, 'exemple');
}

// ---------------------------------------------------------------------------
// Phase C — la voie de preuve, et ses gardes
// ---------------------------------------------------------------------------

test('espace client sur un autre domaine : le renvoi vers le domaine DÉCLARÉ est CONFIRMÉ — le cas Atma', async () => {
  // Le connecté qui demande /account de la boutique est renvoyé vers sa liste
  // de commandes sur shopify.com. Ni adresse tenue, ni marqueur générique —
  // seule la voie du domaine d'espace client peut conclure.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://shopify.com/99999999/account/orders?locale=fr',
      statut: 200,
      texteCorps: 'Vos commandes',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/account',
    verifyUrlTient: true,
    domaineEspaceClient: 'shopify.com',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1, 'la session doit être enregistrée');
  const ligne = contexte.journal.find((l) => /connexion confirmée/.test(l.message));
  assert.ok(ligne, 'la preuve doit être journalisée');
  assert.match(ligne.message, /espace client hébergé sur shopify\.com/);
});

test('espace client sur un autre domaine : un renvoi vers l\'ÉCRAN DE CONNEXION du même domaine reste REFUSÉ (lot 68)', async () => {
  // L'anonyme finit sur shopify.com/authentication/<boutique>/login : c'est le
  // bon domaine, mais un écran de connexion — jamais une preuve.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://shopify.com/authentication/99999999/login',
      statut: 200,
      texteCorps: 'Connectez-vous',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/account',
    verifyUrlTient: true,
    domaineEspaceClient: 'shopify.com',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'un écran de connexion ne doit jamais enregistrer');
  assert.equal(resultat.view.verdictCode, 'refus');
});

test('espace client sur un autre domaine : un renvoi vers un domaine NON déclaré ne prouve rien (memeSite non régressé)', async () => {
  // Une page qui répond, non vide, sans formulaire — mais sur un domaine que
  // le connecteur n'a pas déclaré. La porte ouverte par le lot 73 ne doit
  // s'ouvrir que pour le domaine mesuré.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://ailleurs.exemple.net/accueil',
      statut: 200,
      texteCorps: 'Bienvenue ailleurs',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/account',
    verifyUrlTient: true,
    domaineEspaceClient: 'shopify.com',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);
  // verifyUrlTient conclut au refus d'un départ hors tenue non mesuré.
  assert.equal(resultat.view.verdictCode, 'refus');
});

test('espace client sur un autre domaine : un statut ≥ 400 sur le bon domaine n\'est jamais une preuve', async () => {
  // Une session morte reçoit un 403 sur la page d'espace client : la garde de
  // statut du lot 68 prime, la voie du domaine ne s'ouvre pas.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://shopify.com/99999999/account/orders',
      statut: 403,
      texteCorps: 'Just a moment...',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/account',
    verifyUrlTient: true,
    domaineEspaceClient: 'shopify.com',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'un 403 ne doit jamais enregistrer, même sur le bon domaine');
  assert.equal(resultat.view.verdictCode, 'mur');
});
