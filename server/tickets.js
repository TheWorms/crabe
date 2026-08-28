'use strict';

/**
 * Support (ex-SAV) : demandes des utilisateurs et réponses de l'administration.
 *
 * Deux notions distinctes, volontairement :
 *   - le STATUT (reçu → en cours → répondu → clôturé), piloté par l'admin ;
 *   - le fait d'être LU ou NON LU (`read_at`), qui basculle dès qu'un admin
 *     ouvre la demande. Un ticket fraîchement soumis est donc « non lu », même
 *     si son statut est déjà « reçu ».
 *
 * La conversation est un fil (`ticket_messages`) : message initial puis
 * réponses successives horodatées, jamais un champ de réponse écrasable.
 * `tickets.reply` continue d'être renseigné avec la dernière réponse, pour
 * compatibilité (export RGPD, anciennes vues).
 *
 * Règle importante : « supprimer » côté utilisateur ne fait que masquer le
 * ticket dans son historique (`hidden_by_user`). L'administration continue de
 * voir la demande et son fil complet.
 */

const db = require('./db/db');

const STATUSES = ['recu', 'en-cours', 'repondu', 'ferme'];

const STATUS_LABELS = {
  recu: 'Reçu',
  'en-cours': 'En cours',
  repondu: 'Répondu',
  ferme: 'Clôturé',
};

/** Libellé affiché : « Non lu » tant qu'aucun admin n'a ouvert la demande. */
function displayLabel(row) {
  if (!row.read_at && row.status === 'recu') return 'Non lu';
  return STATUS_LABELS[row.status] || row.status;
}

function shape(row, messages = null) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    subject: row.subject,
    message: row.message,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    displayLabel: displayLabel(row),
    unread: !row.read_at,
    readAt: row.read_at || null,
    reply: row.reply || '',
    replyCount: row.reply_count ?? undefined,
    hiddenByUser: !!row.hidden_by_user,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messages || undefined,
  };
}

const SELECT_BASE = `SELECT t.*, u.username,
                            (SELECT COUNT(*) FROM ticket_messages m
                              WHERE m.ticket_id = t.id AND m.author = 'admin') AS reply_count
                       FROM tickets t
                       LEFT JOIN users u ON u.id = t.user_id`;

/** Crée une demande, avec son premier message dans le fil. */
function create(userId, subject, message) {
  const cleanSubject = String(subject || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanSubject || !cleanMessage) {
    const err = new Error('Le sujet et le message sont obligatoires.');
    err.statusCode = 400;
    throw err;
  }

  const author = db.get().prepare('SELECT username FROM users WHERE id = ?').get(userId);

  const id = db.transaction(() => {
    const ticketId = db
      .get()
      .prepare('INSERT INTO tickets (user_id, subject, message) VALUES (?, ?, ?)')
      .run(userId, cleanSubject.slice(0, 200), cleanMessage.slice(0, 5000)).lastInsertRowid;

    db.get()
      .prepare(
        `INSERT INTO ticket_messages (ticket_id, author, user_id, username, body)
         VALUES (?, 'user', ?, ?, ?)`
      )
      .run(ticketId, userId, author?.username || null, cleanMessage.slice(0, 5000));

    return ticketId;
  })();

  return getById(id);
}

/** Fil de conversation complet d'une demande. */
function messagesFor(ticketId) {
  return db
    .get()
    .prepare(
      `SELECT id, author, username, body, created_at
         FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at, id`
    )
    .all(ticketId)
    .map((m) => ({
      id: m.id,
      author: m.author,
      username: m.username,
      body: m.body,
      createdAt: m.created_at,
    }));
}

function getById(id, withMessages = true) {
  const row = db.get().prepare(`${SELECT_BASE} WHERE t.id = ?`).get(id);
  if (!row) return null;
  return shape(row, withMessages ? messagesFor(row.id) : null);
}

/** Historique visible par l'utilisateur (les masqués sont retirés). */
function listForUser(userId) {
  return db
    .get()
    .prepare(`${SELECT_BASE} WHERE t.user_id = ? AND t.hidden_by_user = 0 ORDER BY t.created_at DESC`)
    .all(userId)
    .map((row) => shape(row, messagesFor(row.id)));
}

/**
 * Vue administration : tout, y compris les tickets masqués côté utilisateur.
 * @param {'all'|'unread'|'recu'|'en-cours'|'repondu'|'ferme'} filter
 */
function listAll(filter = 'all') {
  let where = '';
  const params = [];

  if (filter === 'unread') {
    where = 'WHERE t.read_at IS NULL';
  } else if (filter && filter !== 'all') {
    where = 'WHERE t.status = ?';
    params.push(filter);
  }

  return db
    .get()
    .prepare(`${SELECT_BASE} ${where} ORDER BY t.read_at IS NULL DESC, t.created_at DESC`)
    .all(...params)
    .map((row) => shape(row));
}

/** Masque un ticket dans l'historique de son auteur. */
function hideForUser(ticketId, userId) {
  const res = db
    .get()
    .prepare('UPDATE tickets SET hidden_by_user = 1 WHERE id = ? AND user_id = ?')
    .run(ticketId, userId);
  return res.changes > 0;
}

/**
 * Marque une demande comme lue (un admin vient de l'ouvrir).
 * Le statut « reçu » passe alors à « en cours » : la demande est prise en
 * charge, ce que l'utilisateur voit de son côté.
 */
function markRead(ticketId) {
  const ticket = db.get().prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) {
    const err = new Error('Demande introuvable.');
    err.statusCode = 404;
    throw err;
  }
  if (ticket.read_at) return getById(ticketId);

  db.get()
    .prepare(
      `UPDATE tickets
          SET read_at = datetime('now'),
              status = CASE WHEN status = 'recu' THEN 'en-cours' ELSE status END,
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(ticketId);

  return getById(ticketId);
}

/**
 * Ajoute une réponse au fil.
 * @param {number} ticketId
 * @param {string} body
 * @param {{author?: 'admin'|'user', userId?: number, username?: string, status?: string}} by
 */
function reply(ticketId, body, by = {}) {
  const ticket = db.get().prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) {
    const err = new Error('Demande introuvable.');
    err.statusCode = 404;
    throw err;
  }

  const text = String(body || '').trim();
  if (!text) {
    const err = new Error('Le message est vide.');
    err.statusCode = 400;
    throw err;
  }

  const author = by.author === 'user' ? 'user' : 'admin';
  const nextStatus =
    by.status && STATUSES.includes(by.status)
      ? by.status
      : author === 'admin'
        ? 'repondu'
        : ticket.status === 'ferme'
          ? 'en-cours'
          : ticket.status;

  db.transaction(() => {
    db.get()
      .prepare(
        `INSERT INTO ticket_messages (ticket_id, author, user_id, username, body)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(ticketId, author, by.userId ?? null, by.username || null, text.slice(0, 5000));

    // `reply` garde la dernière réponse de l'administration.
    if (author === 'admin') {
      db.get()
        .prepare(
          `UPDATE tickets
              SET reply = ?, status = ?, read_at = COALESCE(read_at, datetime('now')),
                  updated_at = datetime('now')
            WHERE id = ?`
        )
        .run(text.slice(0, 5000), nextStatus, ticketId);
    } else {
      // Une relance de l'utilisateur remet la demande en non lu.
      db.get()
        .prepare(
          "UPDATE tickets SET status = ?, read_at = NULL, updated_at = datetime('now') WHERE id = ?"
        )
        .run(nextStatus, ticketId);
    }
  })();

  return getById(ticketId);
}

/**
 * Met à jour le statut, et la réponse quand elle est fournie.
 * Conservé pour la compatibilité : une réponse fournie ici alimente aussi le
 * fil de conversation.
 *
 * @param {number} ticketId
 * @param {'recu'|'en-cours'|'repondu'|'ferme'} status
 * @param {string} [replyBody]
 */
function updateStatus(ticketId, status, replyBody) {
  if (!STATUSES.includes(status)) {
    const err = new Error(`Statut inconnu : ${status}`);
    err.statusCode = 400;
    throw err;
  }
  if (!db.get().prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId)) {
    const err = new Error('Demande introuvable.');
    err.statusCode = 404;
    throw err;
  }

  if (replyBody !== undefined && replyBody !== null && String(replyBody).trim()) {
    return reply(ticketId, replyBody, { author: 'admin', status });
  }

  db.get()
    .prepare(
      `UPDATE tickets
          SET status = ?, read_at = COALESCE(read_at, datetime('now')), updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(status, ticketId);

  return getById(ticketId);
}

/** Compteurs pour les cartes de statistiques de l'écran Support. */
function counts() {
  const rows = db.get().prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
  const out = { all: 0, unread: 0 };
  for (const s of STATUSES) out[s] = 0;
  for (const r of rows) {
    out[r.status] = r.n;
    out.all += r.n;
  }
  out.unread = db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE read_at IS NULL')
    .get().n;
  // « En cours » au sens large : tout ce qui n'est ni clôturé, ni non lu.
  out.open = out.all - out.ferme;
  return out;
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  create,
  getById,
  messagesFor,
  listForUser,
  listAll,
  hideForUser,
  markRead,
  reply,
  updateStatus,
  counts,
};
