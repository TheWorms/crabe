'use strict';

/**
 * Socle commun aux tests.
 *
 * Chaque fichier de test tourne dans son propre processus (`node --test`), on
 * peut donc utiliser un répertoire de données temporaire et une base en
 * mémoire par fichier, sans risque d'interférence.
 *
 * IMPORTANT : les variables d'environnement doivent être posées AVANT le
 * premier `require` de server/config.js, qui les lit au chargement.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-test-'));

process.env.NODE_ENV = 'test';
process.env.CRABE_DATA_DIR = dataDir;
process.env.CRABE_MASTER_PASSPHRASE = 'passphrase-de-test-crabe-0123456789';
process.env.CRABE_SESSION_SECRET = 'secret-de-session-de-test';
process.env.CRABE_DISABLE_SCHEDULER = '1';
// Aucun test n'ouvre un navigateur vers un site de fournisseur : les recettes
// de scraping retombent sur leur mode simulé, comme quand Playwright n'était
// pas installé sur la machine de développement (voir server/config.js).
process.env.CRABE_DISABLE_SCRAPING = '1';
process.env.CRABE_ADMIN_PASSWORD = '';
// La destination locale vise /mnt/local en production : les tests qui
// écrivent réellement des factures la ramènent dans leur répertoire temporaire.
process.env.CRABE_LOCAL_PATH ??= path.join(dataDir, 'local');
// Réglages qu'un fichier de test peut vouloir imposer avant de nous charger
// (ex. proxy de confiance, filtrage CIDR) : on ne les écrase pas.
process.env.CRABE_ALLOWED_CIDRS ??= '';
process.env.CRABE_TRUST_PROXY ??= '0';

const db = require('../server/db/db');
const crypto = require('../server/crypto');
const password = require('../server/auth/password');
const registry = require('../server/connectors/registry');

/**
 * La préparation en cours, ou terminée.
 *
 * ⚠ Une PROMESSE, et pas un booléen « c'est fait ». Le drapeau ne se posait
 * qu'à la toute fin, si bien que deux appels rapprochés préparaient tout deux
 * fois. Ça ne se voyait pas tant que `setup()` ouvrait la base avant son
 * premier `await` — un second appel trouvait la base déjà là. Le lot 25 met la
 * dérivation de la clé en tête (comme au démarrage réel), donc `setup()` rend
 * la main AVANT d'ouvrir la base, et un fichier qui déclare deux `before`
 * racine voyait le second démarrer sur une base fermée.
 *
 * Mémoriser la promesse règle les deux cas : le second appel attend le premier
 * au lieu de le doubler.
 */
let preparation = null;

/** Ouvre une base en mémoire, initialise la crypto et charge les connecteurs. */
function setup() {
  if (preparation) return preparation;
  preparation = (async () => {
    // Même ordre qu'au démarrage réel (server/index.js) : la clé d'abord, la
    // base ensuite. Les migrations qui déchiffrent — la 29 en particulier — ne
    // peuvent pas être vérifiées dans un ordre que la production n'emploie pas.
    await crypto.init();
    db.open(':memory:');
    await password.ready();
    registry.load();
    registry.syncCatalog();
  })();
  return preparation;
}

function teardown() {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/** Crée un utilisateur directement en base. */
async function createUser({
  username,
  plainPassword = 'MotDePasse1',
  role = 'user',
  status = 'active',
}) {
  const id = db
    .get()
    .prepare(
      `INSERT INTO users (username, email, password_hash, role, status, password_changed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      username,
      `${username}@test.local`,
      await password.hash(plainPassword),
      role,
      status
    ).lastInsertRowid;

  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Démarre l'application sur un port éphémère et renvoie un petit client HTTP
 * qui conserve les cookies de session.
 */
async function startServer() {
  const { createApp } = require('../server/index');
  const app = createApp();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';

  /**
   * @param {object} [options] `binary` rend la réponse en Buffer plutôt qu'en
   *   texte : indispensable pour une archive .zip, qu'un décodage UTF-8
   *   abîmerait silencieusement avant même qu'on essaie de l'ouvrir.
   */
  async function request(method, urlPath, body, extraHeaders = {}, options = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    const setCookie = res.headers.getSetCookie?.() || [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      if (pair.startsWith('crabe.sid=')) cookie = pair;
    }

    const entetes = Object.fromEntries(res.headers.entries());

    if (options.binary) {
      return {
        status: res.status,
        buffer: Buffer.from(await res.arrayBuffer()),
        headers: entetes,
        setCookie,
      };
    }

    let payload = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      payload = await res.json();
    } else {
      payload = await res.text();
    }

    return { status: res.status, body: payload, headers: entetes, setCookie };
  }

  return {
    base,
    request,
    get: (p, options = {}) =>
      // Deux formes acceptées : `get(chemin, { raw: true })` pour une réponse
      // binaire, et `get(chemin, enTetes)` pour la forme historique.
      (options && options.raw
        ? request('GET', p, undefined, {}, { binary: true })
        : request('GET', p, undefined, options)),
    post: (p, body, headers) => request('POST', p, body, headers),
    put: (p, body) => request('PUT', p, body),
    patch: (p, body) => request('PATCH', p, body),
    del: (p, body) => request('DELETE', p, body),
    delete: (p, body) => request('DELETE', p, body),
    clearCookies: () => {
      cookie = '';
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Connexion complète d'un utilisateur : identifiants, puis enrôlement 2FA
 * ou vérification du code selon l'état du compte.
 */
async function login(client, username, plainPassword) {
  const totp = require('../server/auth/totp');
  const step = await client.post('/api/auth/login', { username, password: plainPassword });
  if (step.status !== 200) return step;

  if (step.body.step === 'done') return step;

  if (step.body.step === '2fa-setup') {
    const setup = await client.post('/api/auth/2fa/setup');
    return client.post('/api/auth/2fa/confirm', {
      code: totp.currentToken(setup.body.secret),
    });
  }

  if (step.body.step === '2fa') {
    const row = db.get().prepare('SELECT totp_secret FROM users WHERE username = ?').get(username);
    const secret = crypto.decrypt(row.totp_secret);
    return client.post('/api/auth/2fa', { code: totp.currentToken(secret) });
  }

  return step;
}

/**
 * Crée un cloud de test, configuré et activé, et rend son identifiant.
 *
 * Depuis le lot 25, aucune destination cloud n'existe sur une installation
 * neuve : elles sont créées par l'utilisateur, avec un identifiant tiré au sort
 * (`cloud-xxxxxxxx`). Les tests ne peuvent donc plus écrire `'pcloud'` en dur —
 * ils demandent un cloud et gardent l'identifiant rendu.
 *
 * `rcloneConfig` est un bloc en trompe-l'œil : il ne sert qu'à faire dire
 * « configurée » à `activeDestinations()`. Aucun test ne joint un vrai remote.
 *
 * @param {{provider?: string, displayName?: string, enabled?: boolean,
 *          rcloneConfig?: string}} [options]
 * @returns {string} l'identifiant du cloud créé
 */
function creerCloud({
  provider = 'pcloud',
  displayName = 'pCloud',
  enabled = true,
  rcloneConfig = 'type = pcloud',
} = {}) {
  const destinations = require('../server/destinations');
  const cree = destinations.createCloud({ provider, displayName });
  destinations.saveConfig(cree.id, {
    enabled,
    remoteName: provider,
    basePath: 'crabe',
    rcloneConfig,
  });
  return cree.id;
}

module.exports = {
  dataDir,
  setup,
  teardown,
  createUser,
  creerCloud,
  startServer,
  login,
  db,
  crypto,
};
