'use strict';

/**
 * Connexion par navigateur distant — routes HTTP et relais WebSocket.
 *
 * Le module `server/remote-browser.js` fait tourner le navigateur ; ce
 * fichier-ci le rend joignable, et surtout **ne le rend joignable que par son
 * propriétaire**.
 *
 * ─── Le chemin d'un pixel ────────────────────────────────────────────────────
 *
 *   Chromium → Xvfb :99 → x11vnc 127.0.0.1:5999 → websockify 127.0.0.1:6180
 *            → CE RELAIS → navigateur de l'utilisateur (client noVNC)
 *
 * Les deux sockets du milieu n'écoutent que sur la boucle locale : rien ne les
 * atteint depuis le réseau. Le seul pont est ce relais, et il exige trois
 * choses avant d'ouvrir la moindre connexion vers websockify :
 *
 *   1. une session applicative crabe valide (cookie signé, compte actif) ;
 *   2. un jeton à usage unique, consommé au passage ;
 *   3. que ce jeton appartienne bien à CET utilisateur — vérifié côté serveur,
 *      pas seulement dans l'interface.
 *
 * ─── Pourquoi un relais au niveau TCP ────────────────────────────────────────
 *
 * crabe ne parle pas WebSocket et n'a aucune raison d'apprendre : websockify
 * sait déjà le faire. Ce relais recopie donc les octets tels quels, poignée de
 * main comprise, sans dépendance supplémentaire (`ws` n'est pas au dépôt).
 *
 * La requête retransmise est **réécrite** : le chemin devient « / » et le
 * cookie de session est retiré. Sans ça, le jeton d'accès finirait dans le
 * journal de websockify, et le cookie de crabe partirait à un processus qui
 * n'en a que faire.
 */

const express = require('express');
const net = require('node:net');
const crypto = require('node:crypto');

const registry = require('../connectors/registry');
const detection = require('../connectors/login-detection');
const remoteBrowser = require('../remote-browser');
const sessionAuth = require('../auth/session');
const middleware = require('../middleware');
const applog = require('../applog');
const db = require('../db/db');
const { config } = require('../config');
const { requireAuth, asyncHandler } = require('../middleware');

/** Chemin du flux d'affichage. Réservé : aucune autre route ne s'en approche. */
const STREAM_PATH = '/api/connectors/remote-login/stream';

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * De quoi l'interface a besoin pour décider si le bouton est cliquable.
 *
 * Renvoyé même quand tout manque, et surtout dans ce cas-là : c'est ce qui
 * permet de griser le bouton **avec l'explication** au lieu de le laisser
 * échouer sans dire pourquoi.
 */
router.get('/remote-login/capabilities', (req, res) => {
  const check = remoteBrowser.manager().checkPrerequisites();
  res.json({
    available: check.ok,
    reason: check.reason,
    missing: check.missing.map((m) => ({
      id: m.id,
      label: m.label,
      detail: m.detail,
      remedy: m.remedy,
    })),
    memory: check.memory,
    // Une session déjà ouverte par quelqu'un d'autre : le bouton se grise
    // aussi, mais pour une raison qui passera toute seule.
    busy: !!remoteBrowser.manager().current,
  });
});

/** Le connecteur existe, est autorisé, et sait se connecter par navigateur. */
function remoteLoginConfig(req) {
  const connectorId = req.params.id;
  if (!registry.has(connectorId)) {
    const err = new Error('Connecteur inconnu.');
    err.statusCode = 404;
    throw err;
  }
  if (!registry.isAllowedForUser(connectorId, req.user)) {
    const err = new Error('Ce connecteur n\'est pas disponible pour votre compte.');
    err.statusCode = 403;
    throw err;
  }
  // Un service seulement annoncé n'a pas d'adresse de connexion à ouvrir : le
  // navigateur distant partirait vers `undefined`.
  registry.assertInstallable(connectorId, 'connecté');

  const manifest = registry.manifest(connectorId);
  if (!manifest.remoteLogin?.url) {
    const err = new Error(
      `${manifest.name} ne se configure pas par navigateur : renseignez ses identifiants.`
    );
    err.statusCode = 400;
    throw err;
  }
  return { connectorId, manifest, remoteLogin: manifest.remoteLogin };
}

/**
 * Ouvre la session de connexion : Xvfb, x11vnc, websockify, puis le navigateur.
 *
 * Le connecteur est installé au passage si besoin — on ne peut pas enregistrer
 * une session pour un connecteur qui n'existe pas encore côté compte, et
 * demander à l'utilisateur de cliquer « Installer » d'abord serait une étape
 * de plus pour rien.
 */
router.post(
  '/:id/remote-login',
  asyncHandler(async (req, res) => {
    const { connectorId, manifest, remoteLogin } = remoteLoginConfig(req);
    registry.install(req.user.id, connectorId);

    const field = sessionFieldOf(manifest);
    if (!field) {
      return res.status(400).json({
        error: `${manifest.name} n'a pas de champ de session à remplir.`,
      });
    }

    const view = await remoteBrowser.manager().start({
      userId: req.user.id,
      connectorId,
      connectorName: manifest.name,
      url: remoteLogin.url,
      marker: remoteLogin.marker || '',
      // Sites dont la protection juge le navigateur et pas seulement les
      // cookies : la fenêtre s'ouvre sur un profil persistant, que le
      // connecteur rouvrira tel quel.
      persistent: !!remoteLogin.persistent,
      hint: remoteLogin.hint || '',
      // §3 — l'identifiant déjà saisi dans crabe est frappé dans le formulaire
      // du site à l'ouverture. Jamais le mot de passe : `identifiantConfigure`
      // n'inspecte que les champs déclarés, en écartant `password` et `session`.
      identifiant: identifiantConfigure(req.user.id, connectorId, manifest),
      // §6 du lot 14 — la page à ESSAYER avec les cookies capturés avant de
      // les enregistrer. Sans elle, crabe enregistrait des sessions qui
      // n'avaient jamais été valides : « capturée — 8 cookie(s) » à 03:07:16,
      // « votre connexion a expiré » à 03:07:19.
      verifyUrl: remoteLogin.verifyUrl || '',
      // Lot 40 — sur la page d'essai, RESTER est la preuve : le site en
      // redirige les anonymes. Déclaré par le manifeste (OUIGO en tête).
      verifyUrlTient: !!remoteLogin.verifyUrlTient,
      // Lot 68 — le renvoi des anonymes, mesuré : quand le site renvoie tout
      // anonyme de la page de contrôle vers son formulaire de connexion, ne
      // pas y être renvoyé est la preuve — même si l'application a réécrit
      // l'adresse en gardant la cible en fragment (claude.ai, 28/08/2026).
      renvoiAnonyme: remoteLogin.renvoiAnonyme || '',
      // Lot 48 — la preuve de session se lit dans la fenêtre VISIBLE, jamais
      // dans un contrôle headless : pour les sites dont la garde anti-robot
      // juge le navigateur (Boulanger : Akamai rendait 404 au contrôle
      // headless, cookies de session compris — mesuré le 22/08/2026).
      preuveSurFenetre: !!remoteLogin.preuveSurFenetre,
      // Lot 49 — les marqueurs MESURÉS du service, lus sur le DOM déjà
      // affiché : l'adresse de contrôle a tenu ET l'un d'eux est dans la
      // page, sans aucune requête supplémentaire (Darty : 403 DataDome à la
      // seconde requête pendant que la page était affichée, 23/08/2026).
      marqueursFenetre: Array.isArray(remoteLogin.marqueursFenetre)
        ? remoteLogin.marqueursFenetre
        : [],
      // Lot 32 — les adresses du site qui ne prouvent rien (vérification
      // anti-robot de Hetzner en tête) : la détection y attend au lieu de
      // conclure, et la sonde de session ne s'y déclenche pas pour rien.
      attendreUrls: Array.isArray(remoteLogin.attendreUrls) ? remoteLogin.attendreUrls : [],
      // Lot 21 — les services qui passent par « Se connecter avec Google » font
      // traverser au navigateur des domaines qui ne sont pas les leurs. Le
      // connecteur dit lesquels le concernent ; tout le reste est écarté avant
      // le chiffrement, et n'est donc jamais stocké.
      keepDomains: Array.isArray(remoteLogin.keepDomains) ? remoteLogin.keepDomains : [],
      // §7.3a — les identifiants enregistrés, pour le bouton « Saisir mes
      // identifiants ». Le mot de passe ne repart JAMAIS vers le client : il
      // est confié au gestionnaire de navigateur, qui l'écrit dans le champ du
      // site et rien d'autre.
      identifiants: identifiantsConfigures(req.user.id, connectorId, manifest),
      // C'est ici, et nulle part ailleurs, que l'état capturé devient une
      // configuration : même chemin exactement qu'un fichier téléversé —
      // contrôle de forme, chiffrement, résumé. Le navigateur distant ne
      // court-circuite aucun garde-fou.
      onDetected: async (state) => {
        registry.saveConfig(req.user.id, connectorId, { [field.key]: JSON.stringify(state) });
        const summary = registry.configSummary(req.user.id, connectorId);
        return {
          fieldKey: field.key,
          summary: summary?.sessions?.[field.key] || null,
          discovery: registry.hasDiscovery(connectorId),
        };
      },
    });

    applog.info(
      `remote-browser:${connectorId}`,
      `Connexion par navigateur ouverte pour ${manifest.name}.`,
      { userId: req.user.id, username: req.user.username }
    );

    res.json({ ...view, streamPath: STREAM_PATH });
  })
);

/** Champ de type `session` du manifeste — celui que la capture vient remplir. */
function sessionFieldOf(manifest) {
  return (manifest.fields || []).find((f) => f.type === 'session') || null;
}

/**
 * L'identifiant déjà connu de crabe, à pré-remplir dans la fenêtre.
 *
 * Renvoie une chaîne vide dans tous les cas douteux — connecteur pas encore
 * configuré (le cas le plus courant : on ouvre justement la fenêtre pour le
 * configurer), champ absent, configuration illisible. Un confort qui échoue ne
 * doit jamais empêcher une fenêtre de s'ouvrir.
 */
function identifiantConfigure(userId, connectorId, manifest) {
  try {
    const config = registry.readConfig(userId, connectorId);
    return detection.identifiantDeConfig(manifest, config) || '';
  } catch {
    return '';
  }
}

/**
 * Le couple identifiant + mot de passe enregistré, pour « Saisir mes
 * identifiants » (§7.3a).
 *
 * ⚠ **Cette valeur ne repart jamais vers le client.** Elle est passée au
 * gestionnaire de navigateur, qui l'écrit dans le formulaire du site et
 * l'oublie avec la session. Rien de ce qui sort de cette fonction n'apparaît
 * dans une réponse HTTP, un journal ou un diagnostic.
 *
 * Renvoie `null` dès qu'il manque un mot de passe : le bouton sera alors
 * inactif, avec sa raison — un bouton mort sans explication est pire que pas
 * de bouton du tout.
 *
 * @returns {{identifiant: string, motDePasse: string}|null}
 */
function identifiantsConfigures(userId, connectorId, manifest) {
  try {
    const config = registry.readConfig(userId, connectorId);
    // Le champ de mot de passe est cherché par son TYPE déclaré, jamais par
    // son nom : une clé nommée « motDePasse » dans un bloc technique ne doit
    // pas finir tapée dans un formulaire, et un champ de type `password` doit
    // l'être quel que soit son nom.
    const champ = (manifest.fields || []).find((f) => f.type === 'password');
    const motDePasse = champ ? String(config?.[champ.key] ?? '') : '';
    if (!motDePasse) return null;

    return {
      identifiant: detection.identifiantDeConfig(manifest, config) || '',
      motDePasse,
    };
  } catch {
    // Connecteur pas encore configuré : c'est le cas le plus courant, on ouvre
    // justement la fenêtre pour le configurer.
    return null;
  }
}

/**
 * Où en est la connexion ?
 *
 * Interrogé toutes les secondes par l'interface : c'est ce qui fait avancer le
 * compte à rebours, afficher « code de validation attendu » et refermer la
 * modale d'elle-même une fois la session enregistrée.
 */
router.get(
  '/:id/remote-login',
  asyncHandler(async (req, res) => {
    const view = remoteBrowser.manager().status(req.user.id, req.params.id);
    if (!view) return res.status(404).json({ error: 'Aucune connexion en cours.' });
    res.json({ ...view, streamPath: STREAM_PATH });
  })
);

/**
 * Un jeton neuf pour rebrancher un flux tombé.
 *
 * Les jetons sont à usage unique : le relais consomme celui de l'ouverture.
 * Un client qui perd sa connexion en redemande un — ce qu'il ne peut faire
 * qu'authentifié, et que pour SA session.
 */
router.post(
  '/:id/remote-login/ticket',
  asyncHandler(async (req, res) => {
    const view = remoteBrowser.manager().status(req.user.id, req.params.id, { withTicket: true });
    if (!view) return res.status(404).json({ error: 'Aucune connexion en cours.' });
    if (!view.token) {
      return res.status(409).json({ error: 'Cette connexion est terminée.', ...view });
    }
    res.json({ ...view, streamPath: STREAM_PATH });
  })
);

/**
 * Saisit un texte dans le champ actif de la fenêtre distante.
 *
 * ─── Le geste que cette route rend possible ──────────────────────────────────
 *
 * `Ctrl+V` dans la fenêtre distante ne colle rien : le raccourci viserait le
 * presse-papiers DU SERVEUR, et sur une instance servie en HTTP simple le
 * navigateur du poste ne laisse de toute façon pas noVNC lire le sien. Or
 * personne ne saisit un mot de passe fort à la main, et le public visé range
 * ses mots de passe dans un gestionnaire : sans cette route, la fenêtre est
 * inutilisable.
 *
 * L'utilisateur colle donc son texte dans un champ de crabe — une page de
 * crabe, où `Ctrl+V` fonctionne nativement — et c'est le SERVEUR qui le frappe
 * dans le navigateur, caractère par caractère.
 *
 * ─── Ce qui n'est jamais journalisé ──────────────────────────────────────────
 *
 * Le corps de cette requête est un mot de passe dans la quasi-totalité des cas.
 * Il n'entre dans aucun journal : ni `applog`, ni `console`, ni le message de
 * la session, ni un compteur de caractères. Il traverse la route, le
 * gestionnaire, et disparaît. C'est aussi pour ça que le contrôle de propriété
 * se fait ici, sans trace : `typeText` ne trouve la session que si elle
 * appartient au demandeur.
 */
router.post(
  '/:id/remote-login/type',
  asyncHandler(async (req, res) => {
    const result = await remoteBrowser
      .manager()
      .typeText(req.user.id, req.params.id, req.body?.text);

    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  })
);

/**
 * « Saisir mes identifiants » — le serveur remplit le formulaire du site.
 *
 * Aucun corps de requête : le client ne fournit rien, et surtout pas un mot de
 * passe. Il demande, le serveur écrit. La réponse ne dit que ce qui a été
 * POSÉ — deux booléens — jamais ce qui a été écrit.
 */
router.post(
  '/:id/remote-login/credentials',
  asyncHandler(async (req, res) => {
    const result = await remoteBrowser
      .manager()
      .saisirIdentifiants(req.user.id, req.params.id);

    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true, identifiant: result.identifiant, motDePasse: result.motDePasse });
  })
);

/**
 * « Enregistrer » — l'utilisateur affirme avoir fini de se connecter.
 *
 * N'a de sens qu'après un essai raté (§6) : la fenêtre est restée ouverte
 * plutôt que d'enregistrer une session invalide. Le contrôle est REFAIT — ce
 * bouton ne le contourne pas, sinon il ramènerait le défaut qu'il corrige.
 */
router.post(
  '/:id/remote-login/save',
  asyncHandler(async (req, res) => {
    const result = await remoteBrowser.manager().saveNow(req.user.id, req.params.id);
    if (!result.ok) {
      // ⚠ L'erreur APRÈS la vue, jamais avant : `publicView` porte un champ
      // `error` (nul tant que la session vit) qui écrasait le verdict — le
      // client recevait `error: null` et affichait « Erreur 409 ». C'est le
      // « Enregistrer ça n'a rien fait » du 22/08/2026, à la lettre.
      return res.status(409).json({ ...(result.view || {}), error: result.error });
    }
    res.json({ ok: true, ...result.view, streamPath: STREAM_PATH });
  })
);

/** Abandon : le navigateur s'éteint, rien n'est enregistré. */
router.delete(
  '/:id/remote-login',
  asyncHandler(async (req, res) => {
    const view = await remoteBrowser.manager().stop(req.user.id, req.params.id);
    if (!view) return res.status(404).json({ error: 'Aucune connexion en cours.' });
    res.json(view);
  })
);

// ---------------------------------------------------------------------------
// Relais WebSocket
// ---------------------------------------------------------------------------

/**
 * Vérifie la signature d'un cookie de session express-session.
 *
 * Réimplémenté en dix lignes plutôt qu'en dépendant de `cookie-signature`, qui
 * n'est au dépôt que par transitivité : c'est un HMAC-SHA256 en base64, sans
 * le remplissage. La comparaison est à temps constant.
 *
 * @param {string} raw valeur du cookie, de la forme « s:<sid>.<signature> »
 * @param {string} secret
 * @returns {string|null} l'identifiant de session, ou null
 */
function unsignCookie(raw, secret) {
  const value = decodeURIComponent(String(raw || ''));
  if (!value.startsWith('s:')) return null;

  const body = value.slice(2);
  const cut = body.lastIndexOf('.');
  if (cut <= 0) return null;

  const sid = body.slice(0, cut);
  const given = Buffer.from(body.slice(cut + 1));
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')
  );

  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? sid : null;
}

/** Valeur d'un cookie dans l'en-tête brut. */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Utilisateur d'une requête de mise à niveau WebSocket.
 *
 * Le flux ne passe pas par la pile de middlewares d'Express : l'événement
 * `upgrade` court-circuite tout. L'authentification est donc refaite ici,
 * intégralement — cookie signé, session en base, compte encore actif.
 *
 * @returns {Promise<object|null>}
 */
function userFromUpgrade(req) {
  return new Promise((resolve) => {
    const sid = unsignCookie(readCookie(req.headers.cookie, 'crabe.sid'), config.sessionSecret);
    if (!sid) return resolve(null);

    sessionAuth.store().get(sid, (err, data) => {
      if (err || !data?.userId || !data?.authenticated) return resolve(null);
      let user = null;
      try {
        user = db
          .get()
          .prepare('SELECT id, username, role, status FROM users WHERE id = ?')
          .get(data.userId);
      } catch {
        return resolve(null);
      }
      // Compte supprimé ou désactivé depuis l'ouverture de la session.
      resolve(user && user.status === 'active' ? user : null);
    });
  });
}

/** Refus poli, en HTTP : le client noVNC affiche un échec de connexion. */
function refuse(socket, code, message) {
  try {
    socket.write(
      `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  } catch {
    /* socket déjà partie */
  }
  socket.destroy();
}

/**
 * Point d'entrée des mises à niveau WebSocket du serveur HTTP.
 *
 * Branché dans `server/index.js` sur l'événement `upgrade`. Tout ce qui n'est
 * pas notre chemin de flux est refusé sèchement : crabe n'a pas d'autre
 * WebSocket, et n'en aura pas par accident.
 */
async function handleUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());

  let target;
  try {
    target = new URL(req.url, 'http://crabe.local');
  } catch {
    return refuse(socket, 400, 'Bad Request');
  }
  if (target.pathname !== STREAM_PATH) return refuse(socket, 404, 'Not Found');

  // Même barrière réseau que le reste de crabe : le LAN, et rien d'autre.
  const ip = middleware.normalizeIp(
    config.trustProxy > 0
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress
  );
  if (!middleware.isAllowedIp(ip)) return refuse(socket, 403, 'Forbidden');

  const user = await userFromUpgrade(req);
  if (!user) return refuse(socket, 401, 'Unauthorized');

  const manager = remoteBrowser.manager();
  const claim = manager.consumeTicket(target.searchParams.get('token'), user.id);
  if (!claim.ok) {
    applog.warn(
      'remote-browser',
      `Flux de connexion refusé pour ${user.username} : ${claim.error}`,
      { userId: user.id, username: user.username }
    );
    return refuse(socket, 403, 'Forbidden');
  }

  const session = claim.session;

  // Défense en profondeur : le jeton dit déjà à qui appartient la session, on
  // vérifie quand même que le client parle du bon connecteur.
  const wanted = target.searchParams.get('connector');
  if (wanted && wanted !== session.connectorId) {
    return refuse(socket, 403, 'Forbidden');
  }

  pipeToWebsockify(req, socket, head, session, () => manager.noteDetach(session));
}

/**
 * Recopie la connexion vers websockify, poignée de main comprise.
 *
 * L'en-tête retransmis est une liste blanche : ce qui n'est pas nécessaire à
 * la négociation WebSocket ne sort pas de crabe. Le cookie de session, en
 * particulier, s'arrête ici.
 */
function pipeToWebsockify(req, socket, head, session, onClose) {
  const upstream = net.connect(session.wsPort, '127.0.0.1');
  let closed = false;

  const shut = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    upstream.destroy();
    onClose();
  };

  upstream.on('error', (err) => {
    if (!socket.destroyed && !socket.writableEnded) {
      refuse(socket, 502, 'Bad Gateway');
    }
    applog.warn('remote-browser', `Flux d'affichage interrompu : ${err.message}`);
    shut();
  });

  upstream.on('connect', () => {
    const forward = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
      'sec-websocket-protocol'];

    const lines = [
      // Chemin réécrit : le jeton d'accès n'a rien à faire dans le journal de
      // websockify, qui trace l'URL de chaque connexion.
      'GET / HTTP/1.1',
      `Host: 127.0.0.1:${session.wsPort}`,
    ];
    for (const name of forward) {
      const value = req.headers[name];
      if (value) lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  socket.on('close', shut);
  socket.on('error', shut);
  upstream.on('close', shut);
}

/**
 * Branche le relais sur un serveur HTTP.
 * Appelé par `main()` et par le socle de tests, jamais ailleurs.
 */
function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch(() => refuse(socket, 500, 'Internal Server Error'));
  });
  return server;
}

module.exports = {
  router,
  STREAM_PATH,
  attach,
  handleUpgrade,
  unsignCookie,
  readCookie,
  userFromUpgrade,
  identifiantConfigure,
};
