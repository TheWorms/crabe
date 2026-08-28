'use strict';

/**
 * Sessions serveur : cookie httpOnly signé + store SQLite.
 *
 * Le store est volontairement minimaliste (une table `sessions`) plutôt
 * qu'une dépendance supplémentaire : crabe tourne sur un seul LXC et la
 * base est déjà là.
 */

const session = require('express-session');
const db = require('../db/db');
const { config } = require('../config');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h

class SqliteStore extends session.Store {
  constructor() {
    super();
    // Purge des sessions expirées toutes les heures.
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  cleanup() {
    try {
      db.get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    } catch {
      /* la base peut être fermée pendant l'arrêt du service */
    }
  }

  get(sid, cb) {
    try {
      const row = db
        .get()
        .prepare('SELECT data, expires_at FROM sessions WHERE sid = ?')
        .get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge ?? MAX_AGE_MS;
      const expires = Date.now() + maxAge;
      db.get()
        .prepare(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
        )
        .run(sid, JSON.stringify(sess), expires);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    return this.set(sid, sess, cb);
  }

  /** Supprime toutes les sessions d'un utilisateur (révocation immédiate). */
  destroyForUser(userId) {
    const rows = db.get().prepare('SELECT sid, data FROM sessions').all();
    const toKill = rows.filter((r) => {
      try {
        return JSON.parse(r.data)?.userId === userId;
      } catch {
        return false;
      }
    });
    const stmt = db.get().prepare('DELETE FROM sessions WHERE sid = ?');
    for (const r of toKill) stmt.run(r.sid);
    return toKill.length;
  }
}

let storeInstance = null;

function store() {
  if (!storeInstance) storeInstance = new SqliteStore();
  return storeInstance;
}

/**
 * Options du cookie de session.
 *
 * `secure` dépend de la SEULE variable CRABE_COOKIE_SECURE (défaut 0). Il ne
 * dépend surtout pas de CRABE_TRUST_PROXY : faire confiance à
 * X-Forwarded-For pour connaître l'IP du client n'a rien à voir avec le fait
 * d'être servi en HTTPS. Les lier avait pour effet, derrière Caddy en HTTP
 * (http://crabe.local), de poser un cookie « Secure » que le navigateur ne
 * renvoyait jamais : la connexion renvoyait indéfiniment au formulaire.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: MAX_AGE_MS,
  };
}

/** Middleware express-session prêt à l'emploi. */
function middleware() {
  return session({
    name: 'crabe.sid',
    secret: config.sessionSecret,
    store: store(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: cookieOptions(),
  });
}

module.exports = { middleware, cookieOptions, store, SqliteStore, ONE_DAY_MS, MAX_AGE_MS };
