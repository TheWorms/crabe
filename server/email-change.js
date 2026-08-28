'use strict';

/**
 * Changement d'adresse e-mail, validé par e-mail.
 *
 * Une nouvelle adresse n'est jamais appliquée immédiatement :
 *   1. la demande est mise en attente, avec un jeton à usage unique valable
 *      24 h dont seule l'empreinte SHA-256 est stockée ;
 *   2. un lien de confirmation part vers la NOUVELLE adresse ;
 *   3. l'ANCIENNE adresse est prévenue de la demande (sécurité) ;
 *   4. le changement n'a lieu qu'au clic sur le lien.
 *
 * Cas dégradé imposé : si le SMTP n'est pas configuré (il ne l'a jamais été en
 * conditions réelles à ce jour), le parcours reste utilisable. L'appelant
 * reçoit une erreur explicite, et un administrateur peut toujours appliquer le
 * changement à la main depuis Paramètres → Utilisateurs. L'adresse e-mail ne
 * devient JAMAIS immuable à cause d'un SMTP absent.
 */

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const db = require('./db/db');
const mailer = require('./mailer');
const templates = require('./email-templates');
const applog = require('./applog');

const TTL_HOURS = 24;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Demande en attente d'un compte, ou null. */
function pendingFor(userId) {
  const row = db
    .get()
    .prepare(
      `SELECT * FROM email_change_requests
        WHERE user_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
        ORDER BY id DESC LIMIT 1`
    )
    .get(userId);
  if (!row) return null;
  return {
    id: row.id,
    email: row.new_email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Vue exposée au front (jamais le jeton). */
function publicPending(userId) {
  const pending = pendingFor(userId);
  return pending ? { email: pending.email, expiresAt: pending.expiresAt } : null;
}

function expiryStamp() {
  return new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/**
 * Crée (ou remplace) la demande et envoie les e-mails.
 *
 * @param {object} user ligne `users` complète
 * @param {string} newEmail
 * @param {{baseUrl: string}} context pour construire le lien de confirmation
 * @returns {Promise<{pending: object, notifiedOld: boolean}>}
 */
async function request(user, newEmail, { baseUrl }) {
  const email = normalizeEmail(newEmail);

  if (!EMAIL_RE.test(email)) {
    const err = new Error('Adresse e-mail invalide.');
    err.statusCode = 400;
    throw err;
  }
  if (email === normalizeEmail(user.email)) {
    const err = new Error('Cette adresse est déjà celle de votre compte.');
    err.statusCode = 400;
    throw err;
  }
  const taken = db
    .get()
    .prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?')
    .get(email, user.id);
  if (taken) {
    const err = new Error('Cette adresse est déjà utilisée par un autre compte.');
    err.statusCode = 409;
    throw err;
  }

  // Sans SMTP, on refuse AVANT d'écrire quoi que ce soit : pas de demande
  // fantôme impossible à confirmer.
  if (!mailer.isConfigured()) {
    const err = new Error(
      'Changement impossible : serveur SMTP non configuré, contactez l\'administrateur. ' +
        'Un administrateur peut appliquer le changement depuis Paramètres → Utilisateurs.'
    );
    err.statusCode = 503;
    err.code = 'SMTP_NOT_CONFIGURED';
    err.expose = true;
    throw err;
  }

  const token = randomBytes(32).toString('hex');

  db.transaction(() => {
    // Une seule demande en cours par compte.
    db.get()
      .prepare('DELETE FROM email_change_requests WHERE user_id = ? AND consumed_at IS NULL')
      .run(user.id);
    db.get()
      .prepare(
        `INSERT INTO email_change_requests (user_id, new_email, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(user.id, email, hashToken(token), expiryStamp());
  })();

  const link = `${String(baseUrl || '').replace(/\/+$/, '')}/confirm-email?token=${token}`;

  // Objet et corps viennent du modèle « email-change-confirm », modifiable
  // depuis Paramètres → SMTP (server/email-templates.js).
  const confirmation = templates.render('email-change-confirm', {
    utilisateur: user.username,
    adresse: email,
    lien: link,
    heures: TTL_HOURS,
    date: new Date().toISOString(),
  });

  try {
    await mailer.send({
      to: email,
      subject: confirmation.subject,
      text: confirmation.text,
    });
  } catch (err) {
    // L'envoi a échoué : on ne laisse pas une demande inutilisable derrière.
    db.get().prepare('DELETE FROM email_change_requests WHERE user_id = ? AND consumed_at IS NULL').run(user.id);
    throw err;
  }

  // Notification de l'ancienne adresse : utile mais secondaire, son échec ne
  // doit pas casser le parcours.
  let notifiedOld = false;
  if (user.email) {
    const warning = templates.render('email-change-notice', {
      utilisateur: user.username,
      adresse: email,
      date: new Date().toISOString(),
    });
    const notice = await mailer.trySend({
      to: user.email,
      subject: warning.subject,
      text: warning.text,
    });
    notifiedOld = notice.ok;
  }

  applog.info('auth', `Demande de changement d'e-mail vers ${email}.`, {
    userId: user.id,
    username: user.username,
  });

  return { pending: publicPending(user.id), notifiedOld };
}

/** Renvoie l'e-mail de confirmation (nouveau jeton, même adresse cible). */
async function resend(user, context) {
  const pending = pendingFor(user.id);
  if (!pending) {
    const err = new Error('Aucune demande de changement d\'adresse en cours.');
    err.statusCode = 404;
    throw err;
  }
  return request(user, pending.email, context);
}

function cancel(userId) {
  const res = db
    .get()
    .prepare('DELETE FROM email_change_requests WHERE user_id = ? AND consumed_at IS NULL')
    .run(userId);
  return res.changes > 0;
}

/**
 * Applique le changement à partir du jeton reçu par e-mail.
 * @returns {{ok: boolean, email?: string, username?: string, error?: string}}
 */
function confirm(token) {
  const provided = String(token || '');
  if (!/^[0-9a-f]{64}$/i.test(provided)) {
    return { ok: false, error: 'Lien de confirmation invalide.' };
  }

  const digest = hashToken(provided);
  const row = db
    .get()
    .prepare('SELECT * FROM email_change_requests WHERE token_hash = ? AND consumed_at IS NULL')
    .get(digest);

  if (!row) return { ok: false, error: 'Lien déjà utilisé ou inconnu.' };

  // Comparaison à temps constant, par principe : le jeton est un secret.
  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: 'Lien de confirmation invalide.' };
  }

  const stillValid = db
    .get()
    .prepare("SELECT 1 AS ok FROM email_change_requests WHERE id = ? AND expires_at > datetime('now')")
    .get(row.id);
  if (!stillValid) {
    return { ok: false, error: 'Ce lien a expiré — refaites la demande depuis votre profil.' };
  }

  const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return { ok: false, error: 'Compte introuvable.' };

  db.transaction(() => {
    db.get().prepare('UPDATE users SET email = ? WHERE id = ?').run(row.new_email, user.id);
    db.get()
      .prepare("UPDATE email_change_requests SET consumed_at = datetime('now') WHERE id = ?")
      .run(row.id);
  })();

  applog.info('auth', `Adresse e-mail confirmée et appliquée : ${row.new_email}.`, {
    userId: user.id,
    username: user.username,
  });

  return { ok: true, email: row.new_email, username: user.username };
}

/** Purge des demandes expirées (entretien). */
function purgeExpired() {
  return db
    .get()
    .prepare("DELETE FROM email_change_requests WHERE expires_at < datetime('now', '-7 days')")
    .run().changes;
}

module.exports = {
  TTL_HOURS,
  EMAIL_RE,
  normalizeEmail,
  pendingFor,
  publicPending,
  request,
  resend,
  cancel,
  confirm,
  purgeExpired,
};
