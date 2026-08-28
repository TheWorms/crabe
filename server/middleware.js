'use strict';

/**
 * Middlewares transverses : restriction réseau, garde d'authentification,
 * garde d'administration, et petits utilitaires de journalisation.
 */

const db = require('./db/db');
const { config } = require('./config');

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

/**
 * IP réelle du client.
 *
 * Express calcule déjà `req.ip` depuis X-Forwarded-For quand
 * `trust proxy` est réglé (CRABE_TRUST_PROXY) : derrière Caddy, on obtient
 * l'IP du poste, pas celle du proxy. Sans proxy de confiance, c'est l'adresse de
 * la socket. Cette fonction ne fait que normaliser le résultat — elle est le
 * seul point d'entrée utilisé par le filtrage CIDR et par le journal des
 * connexions, pour qu'ils ne puissent pas diverger.
 */
function clientIp(req) {
  return normalizeIp(req?.ip);
}

function isAllowedIp(ip) {
  if (!config.allowedCidrs.length) return true;
  const clean = normalizeIp(ip);
  // Le loopback IPv6 est toujours accepté (sondes locales, healthcheck).
  if (clean === '::1') return true;
  return config.allowedCidrs.some((cidr) =>
    cidr.includes('/') ? inCidr(clean, cidr) : clean === cidr
  );
}

/** Bloque tout ce qui n'est pas sur le réseau autorisé. */
function networkGuard(req, res, next) {
  if (isAllowedIp(clientIp(req))) return next();
  res.status(403).json({
    error: 'Accès refusé — crabe n\'est joignable que depuis le réseau local.',
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
              home_locked, home_customizable,
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
  isAllowedIp,
  networkGuard,
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
