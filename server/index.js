'use strict';

/**
 * Point d'entrée de crabe.
 *
 * Ordre de démarrage : configuration -> base -> clé maîtresse -> connecteurs
 * -> compte administrateur initial -> serveur HTTP -> scheduler.
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const { config, validate } = require('./config');
const db = require('./db/db');
const crypto = require('./crypto');
const registry = require('./connectors/registry');
const remoteBrowser = require('./remote-browser');
const scheduler = require('./scheduler');
const passwordHelper = require('./auth/password');
const sessionAuth = require('./auth/session');
const middleware = require('./middleware');
const permissions = require('./permissions');
const applog = require('./applog');
const version = require('./version');

const WEB_DIR = path.join(__dirname, '..', 'web');

/**
 * Crée le premier administrateur si la base est vide.
 *
 * Le compte est créé SANS 2FA : ni secret, ni activation. Le bootstrap
 * générait auparavant un secret TOTP et l'activait sans qu'aucun QR code
 * n'ait été scanné — le compte se retrouvait enfermé dehors, et il fallait un
 * UPDATE en base pour rentrer. La 2FA est désormais strictement opt-in, depuis
 * le profil.
 *
 * @returns {{created: boolean, username?: string, warning?: string}}
 */
async function bootstrapAdmin() {
  const count = db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return { created: false };

  const { username, password: plain, email } = config.bootstrapAdmin;
  if (!plain) {
    return {
      created: false,
      warning:
        'Aucun utilisateur en base et CRABE_ADMIN_PASSWORD est vide : ' +
        'renseignez-le dans .env puis redémarrez pour créer le compte administrateur.',
    };
  }

  db.get()
    .prepare(
      `INSERT INTO users (username, email, password_hash, role, role_id, totp_secret, totp_enabled,
                          password_changed_at)
       VALUES (?, ?, ?, 'admin', ?, NULL, 0, datetime('now'))`
    )
    .run(
      username,
      email || '',
      await passwordHelper.hash(plain),
      permissions.defaultRoleIdFor('admin')
    );

  return { created: true, username };
}

/** Échappe le HTML injecté dans la page de confirmation. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Page servie au clic sur le lien de confirmation d'adresse e-mail. */
function confirmEmailPage(result) {
  const title = result.ok ? 'Adresse e-mail confirmée' : 'Confirmation impossible';
  const body = result.ok
    ? `<p class="auth-sub">L'adresse <strong>${escapeHtml(result.email)}</strong> est désormais ` +
      `celle du compte <strong>${escapeHtml(result.username)}</strong>.</p>`
    : `<div class="auth-error show">${escapeHtml(result.error)}</div>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crabe — ${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/crabe.svg" type="image/svg+xml">
</head>
<body>
<div class="auth-wrap">
  <div class="auth-card">
    <div class="auth-logo">
      <svg class="crab-mark" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="22" r="12" fill="#e0693a"/><path d="M8 18 L2 12 M8 14 L1 20" stroke="#e0693a" stroke-width="2.5" stroke-linecap="round"/><path d="M32 18 L38 12 M32 14 L39 20" stroke="#e0693a" stroke-width="2.5" stroke-linecap="round"/><circle cx="15" cy="19" r="1.6" fill="#14161a"/><circle cx="25" cy="19" r="1.6" fill="#14161a"/></svg>
      <span>Crabe</span>
    </div>
    <div class="auth-title">${escapeHtml(title)}</div>
    ${body}
    <a class="btn-primary" href="/" style="display:block;text-align:center;text-decoration:none;padding:11px;">Revenir à crabe</a>
  </div>
</div>
</body>
</html>`;
}

/** Construit l'application Express (sans l'écouter — utile pour les tests). */
function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Trois en-têtes de précaution, sur toutes les réponses : le navigateur ne
  // devine pas le type d'un fichier, la page ne s'encadre pas depuis un autre
  // site, et l'adresse d'une page reste chez crabe quand on clique vers
  // l'extérieur. Rien ici ne dépend de la configuration.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // crabe n'est joignable que depuis le LAN.
  app.use(middleware.networkGuard);

  // La santé et la version : publiques, sans session — c'est cette route que
  // le HEALTHCHECK du conteneur sonde, et elle porte aussi la bannière de mise
  // à jour. Rien de secret ne s'y lit : « le service répond », la version
  // installée, et — si la vérification est armée ET qu'une version plus
  // récente est positivement connue — laquelle.
  app.get('/api/sante', async (req, res) => {
    const maj = await version.verifierMiseAJour();
    res.json({ ok: true, version: version.VERSION, miseAJour: maj });
  });

  app.use(sessionAuth.middleware());
  app.use(middleware.loadUser);

  // --- API ---
  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api/home', require('./routes/home').router);
  app.use('/api/operations', require('./routes/operations').router);
  app.use('/api/documents', require('./routes/documents').router);
  // Monté AVANT le routeur des connecteurs : ses chemins sont plus spécifiques
  // (« /:id/remote-login »), et ce qu'il ne reconnaît pas retombe naturellement
  // sur le routeur suivant.
  app.use('/api/connectors', require('./routes/remote-login').router);
  app.use('/api/connectors', require('./routes/connectors').router);
  app.use('/api/admin/connectors', require('./routes/connectors').adminRouter);
  app.use('/api/admin/schedules', require('./routes/connectors').scheduleRouter);
  app.use('/api/admin/destinations', require('./routes/destinations').router);
  app.use('/api/admin/optimisation', require('./routes/optimisation').router);
  app.use('/api/users', require('./routes/users').router);
  app.use('/api/admin/roles', require('./routes/roles').router);
  app.use('/api/tickets', require('./routes/tickets').router);
  app.use('/api/admin/logs', require('./routes/logs').router);
  app.use('/api/system', require('./routes/system').router);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // --- Confirmation de changement d'e-mail ---
  // Volontairement hors API et sans authentification : le jeton reçu par
  // e-mail est la preuve. La page reprend la charte (style.css).
  app.get('/confirm-email', (req, res) => {
    const result = require('./email-change').confirm(req.query.token);
    res.status(result.ok ? 200 : 400).type('html').send(confirmEmailPage(result));
  });

  // --- Client noVNC ---
  //
  // Servi depuis le paquet système `novnc` (/usr/share/novnc), jamais copié au
  // dépôt : c'est un logiciel tiers, mis à jour par apt. Absent de la machine
  // de développement, d'où le montage conditionnel — la connexion par
  // navigateur se grise alors toute seule, avec l'explication (voir
  // routes/remote-login.js, « capabilities »).
  //
  // Derrière `requireAuth` : rien de secret là-dedans, mais crabe ne sert pas
  // de fichiers à qui n'est pas connecté.
  const novncDir = remoteBrowser.findNovnc(remoteBrowser.defaultRuntime());
  if (novncDir) {
    app.use(
      '/novnc',
      middleware.requireAuth,
      express.static(novncDir, { index: false, maxAge: config.env === 'production' ? '1h' : 0 })
    );
  }

  // --- Frontend ---
  app.use(express.static(WEB_DIR, { index: false, maxAge: config.env === 'production' ? '1h' : 0 }));

  // Le shell applicatif n'est servi qu'à un compte authentifié ; sinon on
  // renvoie l'écran de connexion.
  app.get('/', (req, res) => {
    res.sendFile(path.join(WEB_DIR, req.user ? 'app.html' : 'login.html'));
  });
  app.get('/app', (req, res) => {
    if (!req.user) return res.redirect('/');
    res.sendFile(path.join(WEB_DIR, 'app.html'));
  });

  app.use((req, res) => res.status(404).sendFile(path.join(WEB_DIR, 'login.html')));

  app.use(middleware.errorHandler);
  return app;
}

async function main() {
  const errors = validate();
  if (errors.length) {
    console.error('Démarrage impossible :');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\nVoir .env.example pour la liste des variables attendues.');
    process.exit(1);
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.exportsDir, { recursive: true });

  // ⚠ La crypto s'initialise AVANT la base, et l'ordre inverse a failli coûter
  // une migration silencieusement inopérante.
  //
  // `db.open()` applique les migrations. La migration 29 doit DÉCHIFFRER la
  // configuration des anciennes destinations pour savoir laquelle a réellement
  // été configurée et laquelle n'était qu'une ligne posée par l'amorçage. Avec
  // l'ordre d'avant — base d'abord, clé ensuite —, tout déchiffrement échouait,
  // la migration concluait « je ne sais pas lire, je garde », et les cinq
  // destinations que ce lot doit retirer seraient restées à l'écran sans qu'une
  // seule erreur ne le signale.
  //
  // `crypto.init()` ne lit rien en base : il lui faut la passphrase et le sel,
  // tous deux sur le disque. Rien ne s'oppose donc à ce qu'il passe devant.
  await crypto.init();
  db.open();
  await passwordHelper.ready();

  for (const migration of db.migrations.applied) {
    applog.info('migrations', `Migration ${migration.id} appliquée — ${migration.name}.`);
  }

  const loaded = registry.load();
  registry.syncCatalog();
  if (loaded.errors.length) {
    console.warn('Connecteurs ignorés :');
    for (const e of loaded.errors) console.warn(`  - ${e}`);
  }

  // Arborescence par année (lot 10) : les documents déposés à plat rejoignent
  // leur dossier d'année, base et disque mis d'accord d'un même geste. Une
  // seule fois, marquée en base — mais retentée au démarrage suivant si le
  // partage n'était pas monté. Le registre doit être chargé avant : c'est lui
  // qui donne le nom lisible du connecteur, donc le nom du dossier.
  const rangement = require('./destinations/migration-annees').migrer();
  if (rangement.ran) console.log(`  rangement  : ${rangement.message}`);

  // Un crabe redémarré pendant une connexion par navigateur laisse derrière
  // lui un Xvfb, un x11vnc, un websockify — et un Chromium AUTHENTIFIÉ que
  // plus personne ne surveille. On les arrête avant d'accepter quoi que ce
  // soit, sinon le prochain « Se connecter » échoue faute d'affichage libre.
  remoteBrowser.manager().cleanupOrphans();

  // Le navigateur visible a besoin d'un HOME qui existe : le compte système
  // `crabe` est créé sans répertoire personnel, et Chromium meurt sur un
  // SIGTRAP en tentant d'y installer son gestionnaire de plantage. On le crée
  // ici, sous dataDir, pour que la première connexion n'ait rien à découvrir.
  try {
    applog.info(
      'remote-browser',
      `Dossier de travail du navigateur : ${remoteBrowser.manager().ensureBrowserHome()}.`
    );
  } catch (err) {
    // Non bloquant : tout le reste de crabe fonctionne sans navigateur distant,
    // et le refus sera de toute façon explicite au premier « Se connecter ».
    applog.warn('remote-browser', err.message);
  }

  const bootstrap = await bootstrapAdmin();
  if (bootstrap.created) {
    applog.info(
      'bootstrap',
      `Compte administrateur « ${bootstrap.username} » créé, sans double authentification (à activer depuis le profil).`
    );
  } else if (bootstrap.warning) {
    applog.warn('bootstrap', bootstrap.warning);
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    applog.info(
      'system',
      `crabe v${config.version} démarré sur ${config.host}:${config.port} (Node ${process.version}, `
        + `${loaded.loaded} connecteurs, ${loaded.planned} annoncés).`
    );
    console.log(`crabe v${config.version} écoute sur http://${config.host}:${config.port}`);
    console.log(`  base       : ${config.dbFile}`);
    // Les deux nombres, séparés : c'est le contrôle le plus direct d'un
    // déploiement — un « annoncés: 0 » inattendu dit que le dossier planned/
    // n'est pas arrivé sur la machine.
    console.log(`  connecteurs: ${loaded.loaded} disponible(s), ${loaded.planned} annoncé(s)`);
    console.log(
      `  réseau     : ${config.allowedCidrs.length ? config.allowedCidrs.join(', ') : 'aucune restriction applicative'}`
    );
    const navigateur = remoteBrowser.manager().checkPrerequisites();
    console.log(
      `  navigateur : ${navigateur.ok ? 'connexion par navigateur distant disponible' : navigateur.reason}`
    );
    if (!navigateur.ok) {
      applog.warn(
        'remote-browser',
        `${navigateur.reason} Manquant : `
          + `${navigateur.missing.map((m) => `${m.label} (${m.remedy})`).join(' ; ')}.`
      );
    }
  });

  // Le flux d'affichage passe par une mise à niveau WebSocket, qui court-circuite
  // Express : le relais se branche donc sur le serveur HTTP lui-même.
  require('./routes/remote-login').attach(server);

  // Le détail plutôt qu'un compte brut : « 1 planification — free (camille,
  // mensuel, jour 5 à 03:00, prochaine le 05/08/2026) ». Un chiffre seul avait
  // masqué en production le fait que les 13 connecteurs du catalogue étaient
  // planifiés au lieu de la seule installation réelle.
  const sched = scheduler.start();
  const summary = scheduler.summarize(sched);
  console.log(`  scheduler  : ${summary}`);
  applog.info('scheduler', `Planification au démarrage : ${summary}`);

  const shutdown = (signal) => {
    console.log(`\n${signal} reçu — arrêt de crabe.`);
    applog.info('system', `Arrêt de crabe (${signal}).`);
    scheduler.stop();
    // Rien ne doit survivre au processus : un navigateur connecté à un compte
    // fournisseur, encore moins que le reste.
    remoteBrowser.manager().stopAll().catch(() => {});
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Filet de sécurité si des connexions traînent.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Échec du démarrage :', err);
    process.exit(1);
  });
}

module.exports = { createApp, bootstrapAdmin, main };
