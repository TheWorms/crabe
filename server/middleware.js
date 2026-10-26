'use strict';

/**
 * Middlewares transverses : restriction réseau, garde d'authentification,
 * garde d'administration, et petits utilitaires de journalisation.
 */

const net = require('node:net');
const proxyaddr = require('proxy-addr');
const db = require('./db/db');
const { config, TOUTES_LES_ADRESSES } = require('./config');

// ---------------------------------------------------------------------------
// Restriction réseau (LAN)
// ---------------------------------------------------------------------------

/** Normalise une IP : retire le préfixe IPv4-mapped des sockets IPv6. */
function normalizeIp(raw) {
  if (!raw) return '';
  const ip = String(raw).trim();
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** L'IP appartient-elle au CIDR IPv4 donné ? */
function inCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** Les plages IPv6 déjà compilées (une liste de blocage de Node par plage). */
const plagesIpv6 = new Map();

/**
 * Lot 112 — l'IP appartient-elle à la plage IPv6 donnée (ou est-elle cette
 * adresse, sans `/`) ? Jusqu'à la 0.1.9, une plage IPv6 d'une liste explicite
 * ne correspondait jamais à rien.
 */
function inCidr6(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!net.isIPv6(ip) || !net.isIPv6(range) || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    return false;
  }
  let plage = plagesIpv6.get(cidr);
  if (!plage) {
    plage = new net.BlockList();
    plage.addSubnet(range, bits, 'ipv6');
    plagesIpv6.set(cidr, plage);
  }
  return plage.check(ip, 'ipv6');
}

/**
 * IP réelle du client.
 *
 * Express calcule déjà `req.ip` depuis X-Forwarded-For quand
 * `trust proxy` est réglé (CRABE_TRUST_PROXY) : derrière Caddy, on obtient
 * l'IP du poste, pas celle du proxy. Sans proxy de confiance, c'est l'adresse de
 * la socket. Cette fonction ne fait que normaliser le résultat — elle est le
 * seul point d'entrée utilisé par le filtrage CIDR et par le journal des
 * connexions, pour qu'ils ne puissent pas diverger.
 *
 * Lot 112 : une requête qui n'est pas passée par Express — la mise à niveau
 * WebSocket du flux d'affichage de la fenêtre de connexion — n'a pas de
 * `req.ip`. Son adresse est calculée par le module même d'Express
 * (`proxy-addr`), avec le même nombre de relais de confiance : X-Forwarded-For
 * se lit depuis la DROITE. Sa gauche est écrite par le client lui-même, elle
 * ne décide jamais.
 */
function clientIp(req) {
  if (typeof req?.ip === 'string' || !req?.headers || !req.socket) return normalizeIp(req?.ip);
  return normalizeIp(proxyaddr(req, (adresse, rang) => rang < config.trustProxy));
}

/** Le bouclage : la machine elle-même (sondes locales, healthcheck du conteneur). */
function estBouclage(ip) {
  return ip === '::1' || inCidr(ip, '127.0.0.0/8');
}

function isAllowedIp(ip) {
  // L'éventuelle zone d'une adresse de lien local (« fe80::1%eth0 ») ne dit
  // rien de son réseau.
  const clean = normalizeIp(ip).split('%')[0];
  // Lot 112 : le bouclage passe toujours, quelle que soit la liste.
  if (estBouclage(clean)) return true;
  return config.allowedCidrs.some((cidr) => {
    if (cidr === TOUTES_LES_ADRESSES) return true;
    if (cidr.includes(':')) return inCidr6(clean, cidr);
    return cidr.includes('/') ? inCidr(clean, cidr) : clean === cidr;
  });
}

/** Échappe une valeur posée dans la page de refus. */
function echapper(valeur) {
  return String(valeur ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Lot 112 — ce que voit un navigateur refusé : une page, pas du JSON brut,
 * qui dit ce qui se passe et quoi faire. Elle reprend la charte des écrans de
 * connexion (`style.css`, thème sombre, comme eux).
 */
function pageRefusReseau(ip) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crabe — accès refusé depuis cette adresse</title>
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
    <div class="auth-title">Accès refusé depuis cette adresse</div>
    <p class="auth-sub">crabe n'accepte que les appareils de son réseau local&nbsp;: celui de la maison ou du bureau, ou un réseau privé comme Tailscale. Cette connexion vient de l'adresse <strong>${echapper(ip)}</strong>, qui n'en fait pas partie.</p>
    <p class="auth-sub"><strong>Ce que vous pouvez faire</strong>&nbsp;: ouvrez crabe depuis un appareil du réseau local. Si c'est vous qui avez installé crabe et que vous voulez l'ouvrir à cette adresse, réglez la variable <strong>CRABE_ALLOWED_CIDRS</strong> (elle est expliquée dans le fichier .env.example), puis redémarrez crabe.</p>
  </div>
</div>
</body>
</html>`;
}

/**
 * Lot 112 — les deux seuls fichiers servis à une adresse refusée : la feuille
 * de style et l'icône de la page de refus. Publics, identiques au dépôt, ils ne
 * portent aucune donnée ; sans eux, la page s'afficherait sans la charte.
 */
const FICHIERS_DE_LA_PAGE_DE_REFUS = new Set(['/style.css', '/crabe.svg']);

/** Bloque tout ce qui n'est pas sur le réseau autorisé. */
function networkGuard(req, res, next) {
  const ip = clientIp(req);
  if (isAllowedIp(ip)) return next();
  const lecture = req.method === 'GET' || req.method === 'HEAD';
  if (lecture && FICHIERS_DE_LA_PAGE_DE_REFUS.has(req.path)) return next();
  const affiche = String(ip || 'inconnue').slice(0, 64);
  if (lecture && !req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
    return res.status(403).type('html').send(pageRefusReseau(affiche));
  }
  res.status(403).json({
    error:
      `Accès refusé — crabe n'est joignable que depuis le réseau local, et l'adresse ${affiche} `
      + 'n\'en fait pas partie. Ouvrez crabe depuis un appareil du réseau local ; pour autoriser '
      + 'd\'autres adresses, réglez la variable CRABE_ALLOWED_CIDRS (voir .env.example).',
  });
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

/** Charge l'utilisateur de la session dans req.user (ou null). */
function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (!userId || !req.session?.authenticated) return next();

  const user = db
    .get()
    .prepare(
      `SELECT id, username, email, phone, role, role_id, status, landing_page, avatar_color,
              home_locked, home_customizable, documents_ui,
              totp_enabled, created_at, last_login_at, password_changed_at
         FROM users WHERE id = ?`
    )
    .get(userId);

  // Compte supprimé ou désactivé entre-temps : la session ne vaut plus rien.
  if (!user || user.status !== 'active') {
    req.session.destroy(() => {});
    return next();
  }

  req.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Authentification requise.' });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  }
  next();
}

/**
 * Garde par permission atomique — le vrai contrôle d'accès de
 * l'administration. L'interface masque ce qu'un compte ne peut pas faire, mais
 * c'est ICI que le refus se joue : une requête forgée à la main tombe sur un
 * 403, même si le menu correspondant n'était pas affiché.
 *
 * @param {string} permission ex. 'users.manage' (voir server/permissions.js)
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    // Chargement tardif : permissions.js dépend de la base, ouverte plus tard.
    if (require('./permissions').userHas(req.user, permission)) return next();

    const label =
      require('./permissions').PERMISSIONS.find((p) => p.id === permission)?.label || permission;
    return res.status(403).json({
      error: `Permission « ${label} » requise : votre rôle ne l'a pas.`,
    });
  };
}

/** Au moins une permission d'administration (accès à l'écran Paramètres). */
function requireAnyAdminPermission(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (require('./permissions').hasAnyAdminPermission(req.user)) return next();
  res.status(403).json({ error: 'Réservé à l\'administration.' });
}

// ---------------------------------------------------------------------------
// Journal des connexions
// ---------------------------------------------------------------------------

/** Extraction sommaire de l'OS et du navigateur, sans dépendance externe. */
function parseUserAgent(ua = '') {
  const agent = String(ua);

  let os = 'Inconnu';
  if (/Windows NT 10/.test(agent)) os = 'Windows 10/11';
  else if (/Windows/.test(agent)) os = 'Windows';
  else if (/Android/.test(agent)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(agent)) os = 'iOS';
  else if (/Mac OS X/.test(agent)) os = 'macOS';
  else if (/Linux/.test(agent)) os = /x86_64|X11/.test(agent) ? 'Linux x86_64' : 'Linux';

  let browser = 'Inconnu';
  let match;
  if ((match = agent.match(/Firefox\/(\d+)/))) browser = `Firefox ${match[1]}`;
  else if ((match = agent.match(/Edg\/(\d+)/))) browser = `Edge ${match[1]}`;
  else if ((match = agent.match(/OPR\/(\d+)/))) browser = `Opera ${match[1]}`;
  else if ((match = agent.match(/Chrome\/(\d+)/))) browser = `Chrome ${match[1]}`;
  else if ((match = agent.match(/Version\/(\d+).*Safari/))) browser = `Safari ${match[1]}`;

  return { os, browser };
}

function logConnection(req, { userId, username, success }) {
  const { os, browser } = parseUserAgent(req.get('user-agent'));
  db.get()
    .prepare(
      `INSERT INTO connection_logs (user_id, username, os, browser, ip, success)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId ?? null, username || null, os, browser, clientIp(req), success ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

/** Enveloppe un handler async pour router les rejets vers next(). */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Gestionnaire d'erreurs terminal : renvoie du JSON, jamais une stack.
 *
 * Les messages des erreurs 5xx ne sortent pas — sauf si elles portent
 * `expose = true`, réservé aux indisponibilités que l'utilisateur DOIT
 * comprendre (« serveur SMTP non configuré », par exemple).
 *
 * Ce qui ne sort pas vers l'utilisateur doit néanmoins être RETROUVABLE : le
 * détail part au journal d'administration, avec la route et le compte. Sans
 * ça, un « Erreur interne du serveur » à l'écran n'a d'écho nulle part dans
 * l'interface — c'est précisément ce qui a fait chercher longtemps la cause du
 * navigateur distant qui refusait de démarrer (lot 7).
 */
function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  const expose = status < 500 || err.expose === true;

  if (status >= 500 && !expose) {
    console.error('[crabe]', err);
    require('./applog').error(
      'http',
      `${req?.method || '?'} ${req?.originalUrl || req?.url || '?'} — ${err?.message || err}`,
      { userId: req?.user?.id ?? null, username: req?.user?.username || null }
    );
  }

  res.status(status).json({
    error: expose ? err.message : 'Erreur interne du serveur.',
  });
}

module.exports = {
  normalizeIp,
  clientIp,
  inCidr,
  inCidr6,
  isAllowedIp,
  networkGuard,
  pageRefusReseau,
  loadUser,
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyAdminPermission,
  parseUserAgent,
  logConnection,
  asyncHandler,
  errorHandler,
};
