'use strict';

/**
 * Authentification : connexion, 2FA TOTP, session, profil personnel.
 *
 * La 2FA est **entièrement optionnelle et jamais enfermante** :
 *   - un compte neuf n'a ni secret, ni 2FA active ;
 *   - si le compte n'a pas la 2FA, aucun écran de code n'apparaît ;
 *   - l'activation exige un premier code valide AVANT d'être persistée, donc
 *     personne ne peut se retrouver dehors avec un secret jamais scanné ;
 *   - même quand l'administrateur l'exige, l'écran d'enrôlement garde une
 *     porte de sortie (« Plus tard »).
 */

const express = require('express');
const db = require('../db/db');
const crypto = require('../crypto');
const password = require('../auth/password');
const totp = require('../auth/totp');
const settings = require('../settings');
const permissions = require('../permissions');
const applog = require('../applog');
const emailChange = require('../email-change');
const mailer = require('../mailer');
const {
  requireAuth,
  logConnection,
  parseUserAgent,
  clientIp,
  asyncHandler,
} = require('../middleware');

const router = express.Router();

const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 10 * 60 * 1000;
/** @type {Map<string, {count: number, until: number}>} */
const attempts = new Map();

/**
 * Clé d'anti-force-brute : IP réelle du client (et non celle du reverse proxy)
 * + identifiant visé, pour qu'un blocage n'affecte pas tout le LAN.
 */
function attemptKey(req, username) {
  return `${clientIp(req)}|${String(username || '').toLowerCase()}`;
}

function isLockedOut(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = attempts.get(key) || { count: 0, until: 0 };
  entry.count++;
  entry.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, entry);
}

function clearFailures(key) {
  attempts.delete(key);
}

/** Politique de sécurité (réutilisée par les autres routeurs). */
function policy() {
  return settings.securityPolicy();
}

/** Vue publique d'un utilisateur (jamais de hash ni de secret TOTP). */
function publicUser(user) {
  const role = user.role_id ? permissions.roleById(user.role_id) : null;
  const mode = settings.twoFactorMode();

  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    phone: user.phone || '',
    role: user.role,
    roleId: user.role_id || null,
    roleName: role ? role.name : user.role === 'admin' ? 'Administrateur' : 'Utilisateur',
    roleSlug: role ? role.slug : user.role,
    permissions: permissions.permissionsForUser(user),
    status: user.status,
    landingPage: user.landing_page,
    avatarColor: user.avatar_color || null,
    initials: user.username.slice(0, 2).toUpperCase(),
    // null quand l'administrateur n'autorise pas Gravatar : aucune URL tierce
    // ne part alors vers le navigateur.
    gravatarUrl: settings.gravatarUrl(user.email),
    totpEnabled: !!user.totp_enabled,
    // Verrous de l'accueil : `adminAllowed` vient de l'administrateur,
    // `personalLock` de l'utilisateur lui-même (voir server/home.js).
    home: require('../home').accessFor(user),
    twoFactor: {
      enabled: !!user.totp_enabled,
      mode,
      // Grisé côté profil quand l'administrateur a désactivé la 2FA.
      canEnable: mode !== 'disabled',
      required: mode === 'required',
    },
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Premier compte — un ecran de creation qui n'existe que base vide
// ---------------------------------------------------------------------------

/** Vrai tant qu'AUCUN utilisateur n'existe : la fenetre du premier demarrage. */
function baseVierge() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

/** L'ecran de connexion demande s'il doit proposer la creation du premier compte. */
router.get('/premier-compte', (req, res) => {
  res.json({ vierge: baseVierge() });
});

/**
 * Cree le premier administrateur, puis ouvre sa session dans la foulee.
 *
 * Le vide de la base est verifie DEUX fois : a l'entree, et juste avant
 * d'ecrire — le hachage Argon2id est long a dessein, et entre deux visiteurs
 * simultanes d'une instance neuve, le premier arrive gagne, le second recoit
 * un refus. Des qu'un compte existe, cette route ne cree plus jamais rien :
 * il n'y a pas d'inscription publique dans crabe.
 */
router.post(
  '/premier-compte',
  asyncHandler(async (req, res) => {
    if (!baseVierge()) {
      return res.status(403).json({ error: 'Un compte existe deja. Connectez-vous.' });
    }

    const { username, password: plain } = req.body || {};
    const clean = String(username || '').trim();

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(clean)) {
      return res.status(400).json({
        error: 'Identifiant invalide (3 a 32 caracteres : lettres, chiffres, . _ -).',
      });
    }

    const check = password.check(String(plain || ''), policy().password_complexity);
    if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });

    const hash = await password.hash(String(plain));

    if (!baseVierge()) {
      return res.status(403).json({ error: 'Un compte existe deja. Connectez-vous.' });
    }

    db.get()
      .prepare(
        `INSERT INTO users (username, email, password_hash, role, role_id, totp_secret, totp_enabled,
                            password_changed_at)
         VALUES (?, '', ?, 'admin', ?, NULL, 0, datetime('now'))`
      )
      .run(clean, hash, permissions.defaultRoleIdFor('admin'));

    const user = db.get().prepare('SELECT * FROM users WHERE username = ?').get(clean);
    return finalizeLogin(req, res, user);
  })
);

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password: plain } = req.body || {};
    const key = attemptKey(req, username);

    if (isLockedOut(key)) {
      return res.status(429).json({
        error: 'Trop de tentatives échouées. Réessayez dans quelques minutes.',
      });
    }

    const user = db.get().prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
    const ok = user ? await password.verify(user.password_hash, String(plain || '')) : false;

    if (!ok || !user) {
      recordFailure(key);
      logConnection(req, { userId: user?.id, username, success: false });
      // Message volontairement identique dans les deux cas.
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    if (user.status !== 'active') {
      logConnection(req, { userId: user.id, username: user.username, success: false });
      return res.status(403).json({ error: 'Ce compte est désactivé.' });
    }

    clearFailures(key);

    // Le compte n'est pas encore authentifié : on retient juste qui tente
    // d'entrer, le temps de la seconde étape.
    req.session.pendingUserId = user.id;
    req.session.authenticated = false;

    // Le compte a sa propre 2FA : on la demande, quelle que soit la politique
    // globale — désactiver la 2FA globalement n'affaiblit pas un compte qui
    // s'en sert déjà (l'admin dispose d'une réinitialisation pour dépanner).
    if (user.totp_enabled && user.totp_secret) {
      return res.json({ step: '2fa', username: user.username });
    }

    // La 2FA est exigée mais ce compte n'en a pas : on l'invite, sans jamais
    // l'enfermer dehors (voir /2fa/skip).
    if (settings.twoFactorMode() === 'required') {
      return res.json({ step: '2fa-setup', username: user.username, canSkip: true });
    }

    return finalizeLogin(req, res, user);
  })
);

/** Ouvre réellement la session. */
function finalizeLogin(req, res, user) {
  req.session.userId = user.id;
  req.session.authenticated = true;
  delete req.session.pendingUserId;
  delete req.session.enrollSecret;
  delete req.session.enrollUserId;

  db.get().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  logConnection(req, { userId: user.id, username: user.username, success: true });

  const fresh = db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return res.json({ step: 'done', user: publicUser(fresh) });
}

function pendingUser(req) {
  const id = req.session?.pendingUserId;
  if (!id) return null;
  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// 2FA — vérification à la connexion
// ---------------------------------------------------------------------------

router.post(
  '/2fa',
  asyncHandler(async (req, res) => {
    const user = pendingUser(req);
    if (!user) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    if (!user.totp_enabled || !user.totp_secret) {
      return res
        .status(400)
        .json({ error: 'La double authentification n\'est pas active sur ce compte.' });
    }

    const key = attemptKey(req, user.username);
    if (isLockedOut(key)) {
      return res.status(429).json({ error: 'Trop de codes erronés. Réessayez plus tard.' });
    }

    const secret = crypto.decrypt(user.totp_secret);
    if (!totp.verify(req.body?.code, secret)) {
      recordFailure(key);
      logConnection(req, { userId: user.id, username: user.username, success: false });
      return res.status(401).json({ error: 'Code de vérification invalide.' });
    }

    clearFailures(key);
    return finalizeLogin(req, res, user);
  })
);

/**
 * Porte de sortie de l'enrôlement obligatoire.
 *
 * L'administrateur peut exiger la 2FA, mais un compte ne doit jamais rester
 * bloqué devant un QR code (téléphone perdu, application non installée). Le
 * passage en force est tracé dans le journal applicatif.
 */
router.post('/2fa/skip', (req, res) => {
  const user = pendingUser(req);
  if (!user) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  if (user.totp_enabled && user.totp_secret) {
    return res
      .status(400)
      .json({ error: 'La double authentification est déjà active sur ce compte.' });
  }

  applog.warn(
    'auth',
    `${user.username} s'est connecté sans configurer la 2FA alors que la politique l'exige.`,
    { userId: user.id, username: user.username }
  );
  return finalizeLogin(req, res, user);
});

// ---------------------------------------------------------------------------
// 2FA — activation / désactivation par l'utilisateur
// ---------------------------------------------------------------------------

/**
 * Génère un secret PROVISOIRE + QR code.
 * Rien n'est écrit en base à ce stade : sans code valide, la 2FA reste
 * inactive — c'est exactement ce qui avait enfermé le compte admin dehors.
 */
router.post(
  '/2fa/setup',
  asyncHandler(async (req, res) => {
    // Deux cas : enrôlement proposé pendant la connexion, ou activation
    // volontaire depuis le profil.
    const user = req.user || pendingUser(req);
    if (!user) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });

    if (!settings.twoFactorSelfServiceAllowed()) {
      return res.status(403).json({
        error: 'La double authentification a été désactivée par l\'administrateur.',
      });
    }

    const secret = totp.generateSecret();
    req.session.enrollSecret = secret;
    req.session.enrollUserId = user.id;

    res.json({
      secret,
      qr: await totp.qrDataUrl(user.username, secret),
      issuer: totp.ISSUER,
      account: user.username,
    });
  })
);

/** Valide le code saisi, et seulement alors active la 2FA. */
router.post(
  '/2fa/confirm',
  asyncHandler(async (req, res) => {
    const secret = req.session?.enrollSecret;
    const userId = req.session?.enrollUserId;
    if (!secret || !userId) {
      return res.status(400).json({ error: 'Aucun enrôlement 2FA en cours.' });
    }

    if (!totp.verify(req.body?.code, secret)) {
      return res.status(401).json({ error: 'Code invalide — vérifiez l\'heure de votre appareil.' });
    }

    db.get()
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
      .run(crypto.encrypt(secret), userId);

    delete req.session.enrollSecret;
    delete req.session.enrollUserId;

    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    applog.info('auth', `${user.username} a activé la double authentification.`, {
      userId: user.id,
      username: user.username,
    });

    // Enrôlement pendant la connexion : la session s'ouvre dans la foulée.
    if (!req.user && req.session.pendingUserId === userId) {
      return finalizeLogin(req, res, user);
    }

    res.json({ ok: true, user: publicUser(user) });
  })
);

/** Désactivation par l'utilisateur, confirmée par son mot de passe. */
router.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await password.verify(row.password_hash, String(req.body?.password || '')))) {
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }

    db.get()
      .prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?')
      .run(req.user.id);

    applog.info('auth', `${req.user.username} a désactivé la double authentification.`, {
      userId: req.user.id,
      username: req.user.username,
    });

    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user: publicUser(user) });
  })
);

// ---------------------------------------------------------------------------
// Session courante
// ---------------------------------------------------------------------------

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Non authentifié.' });

  const { os, browser } = parseUserAgent(req.get('user-agent'));
  const lastLogin = db
    .get()
    .prepare(
      `SELECT date, ip, os, browser FROM connection_logs
        WHERE user_id = ? AND success = 1
        ORDER BY date DESC LIMIT 1 OFFSET 1`
    )
    .get(req.user.id);

  const securityPolicy = policy();

  res.json({
    user: publicUser(req.user),
    security: {
      twoFactor: !!req.user.totp_enabled,
      twoFactorMode: settings.twoFactorMode(securityPolicy),
      passwordChangedAt: req.user.password_changed_at,
      lastLogin: lastLogin || null,
      currentDevice: `${os} · ${browser}`,
    },
    policy: {
      twoFactorMode: settings.twoFactorMode(securityPolicy),
      passwordComplexity: securityPolicy.password_complexity,
      passwordRules: password.POLICIES[securityPolicy.password_complexity].label,
    },
    settings: settings.publicSettings(),
    pendingEmailChange: emailChange.publicPending(req.user.id),
    smtpConfigured: mailer.isConfigured(),
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('crabe.sid');
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Profil personnel
// ---------------------------------------------------------------------------

router.patch(
  '/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { phone, landingPage, avatarColor } = req.body || {};
    const fields = [];
    const values = [];

    // L'e-mail ne se change plus ici : il exige une confirmation par e-mail
    // (POST /auth/email-change).
    if (req.body?.email !== undefined) {
      return res.status(400).json({
        error:
          'Le changement d\'adresse e-mail demande une confirmation : utilisez « Modifier l\'e-mail ».',
      });
    }

    if (phone !== undefined) {
      fields.push('phone = ?');
      values.push(String(phone).trim().slice(0, 32));
    }
    if (landingPage !== undefined) {
      if (!['apps', 'local', 'papiers'].includes(landingPage)) {
        return res.status(400).json({ error: 'Page d\'accueil inconnue.' });
      }
      fields.push('landing_page = ?');
      values.push(landingPage);
    }
    if (avatarColor !== undefined) {
      fields.push('avatar_color = ?');
      values.push(String(avatarColor).slice(0, 32));
    }
    // « Figer mon accueil » : verrou personnel, que l'utilisateur pose et
    // retire lui-même. Il ne touche pas au verrou de l'administrateur et ne
    // permet donc pas de le contourner.
    if (req.body?.homeLocked !== undefined) {
      fields.push('home_locked = ?');
      values.push(req.body.homeLocked ? 1 : 0);
    }

    if (!fields.length) return res.status(400).json({ error: 'Aucune modification fournie.' });

    values.push(req.user.id);
    db.get().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  })
);

// ---------------------------------------------------------------------------
// Changement d'adresse e-mail (validé par e-mail)
// ---------------------------------------------------------------------------

/** URL publique de crabe, telle que vue par le navigateur du client. */
function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/email-change', requireAuth, (req, res) => {
  res.json({
    pending: emailChange.publicPending(req.user.id),
    smtpConfigured: mailer.isConfigured(),
    ttlHours: emailChange.TTL_HOURS,
  });
});

router.post(
  '/email-change',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await emailChange.request(req.user, req.body?.email, {
      baseUrl: baseUrlOf(req),
    });
    res.json({
      ok: true,
      pending: result.pending,
      notifiedOld: result.notifiedOld,
      message:
        `Un lien de confirmation a été envoyé à ${result.pending.email}. ` +
        `Il est valable ${emailChange.TTL_HOURS} h ; votre adresse actuelle reste active d'ici là.`,
    });
  })
);

router.post(
  '/email-change/resend',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await emailChange.resend(req.user, { baseUrl: baseUrlOf(req) });
    res.json({ ok: true, pending: result.pending, message: 'Lien de confirmation renvoyé.' });
  })
);

router.delete('/email-change', requireAuth, (req, res) => {
  const cancelled = emailChange.cancel(req.user.id);
  res.json({ ok: cancelled, pending: null });
});

router.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const row = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);

    if (!(await password.verify(row.password_hash, String(currentPassword || '')))) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }

    const level = policy().password_complexity;
    const check = password.check(String(newPassword || ''), level);
    if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });

    db.get()
      .prepare(
        "UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?"
      )
      .run(await password.hash(String(newPassword)), req.user.id);

    res.json({ ok: true, strength: password.strength(String(newPassword)) });
  })
);

module.exports = { router, publicUser, policy };
