'use strict';

/**
 * Journal applicatif.
 *
 * Tout ce qui n'est ni une connexion (`connection_logs`), ni une exécution de
 * connecteur (`run_logs`), ni une opération de destination
 * (`destination_logs`) : démarrages et arrêts, migrations de schéma, erreurs,
 * tâches planifiées, opérations d'administration.
 *
 * Les écritures sont volontairement « best effort » : un journal qui échoue ne
 * doit jamais faire échouer l'opération qu'il décrit (base fermée pendant
 * l'arrêt du service, par exemple). Tout part aussi sur la sortie standard,
 * donc dans journalctl -u crabe.
 */

const db = require('./db/db');

const LEVELS = [
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Avertissement' },
  { id: 'error', label: 'Erreur' },
];

const CONSOLE = { info: 'log', warn: 'warn', error: 'error' };

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} source  ex. 'auth', 'scheduler', 'admin', 'destinations'
 * @param {string} message
 * @param {{userId?: number|null, username?: string|null}} [who]
 */
function write(level, source, message, who = {}) {
  const safeLevel = LEVELS.some((l) => l.id === level) ? level : 'info';
  // JAMAIS tronqué (lot 38). Le plafond de 2000 caractères a coûté deux
  // diagnostics à l'aveugle le 18/08/2026 : le corps du 400 PayPal — dont le
  // champ `issue` qui nommait la règle violée — n'est jamais arrivé entier au
  // journal. Le journal technique est précisément l'endroit où le corps
  // complet doit vivre ; c'est l'ÉCRAN qui reçoit le message court.
  const text = String(message ?? '');

  if (process.env.NODE_ENV !== 'test') {
    console[CONSOLE[safeLevel]](`[crabe:${source}] ${text}`);
  }

  try {
    db.get()
      .prepare(
        `INSERT INTO app_logs (level, source, message, user_id, username)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(safeLevel, String(source || 'crabe').slice(0, 64), text, who.userId ?? null, who.username || null);
  } catch {
    /* base fermée ou pas encore ouverte : la sortie standard suffit */
  }
}

const info = (source, message, who) => write('info', source, message, who);
const warn = (source, message, who) => write('warn', source, message, who);
const error = (source, message, who) => write('error', source, message, who);

/**
 * Préfixe de source des lignes qu'un connecteur écrit en plein travail :
 * `connector:<id>`. Le préfixe permet à l'écran « Logs → Connecteurs » de les
 * retrouver et de les attribuer à leur service ; il ne sert qu'à ça.
 */
const SOURCE_CONNECTEUR = 'connector';

/**
 * Journal d'un connecteur en plein travail (lot 41).
 *
 * Ces lignes ne vivaient que sur la sortie standard : le 19/08/2026, une
 * soirée de diagnostic a été perdue faute de pouvoir les relire — ni en base,
 * ni à l'écran, et le run Deezer de 18:09:51 n'a laissé aucune trace nulle
 * part. Elles passent désormais par app_logs, et l'écran
 * « Logs → Connecteurs » les affiche entre les exécutions.
 *
 * La sortie standard reste EXACTEMENT celle d'avant (préfixe `[connector]`,
 * texte intact) : journalctl ne change pas, la base s'ajoute.
 */
function connector(connectorId, message, who = {}) {
  const text = String(message ?? '');
  if (process.env.NODE_ENV !== 'test') console.log('[connector]', text);

  const source = connectorId
    ? `${SOURCE_CONNECTEUR}:${connectorId}`
    : SOURCE_CONNECTEUR;
  try {
    db.get()
      .prepare(
        `INSERT INTO app_logs (level, source, message, user_id, username)
         VALUES ('info', ?, ?, ?, ?)`
      )
      .run(String(source).slice(0, 64), text, who.userId ?? null, who.username || null);
  } catch {
    /* base fermée ou pas encore ouverte : la sortie standard suffit */
  }
}

/** Trace une opération d'administration au nom de son auteur. */
function admin(req, message, level = 'info') {
  write(level, 'admin', message, {
    userId: req?.user?.id ?? null,
    username: req?.user?.username ?? null,
  });
}

/**
 * Lecture filtrée.
 * @param {{level?: string, q?: string, limit?: number}} options
 */
function list({ level = 'all', q = '', limit = 200 } = {}) {
  const clauses = [];
  const params = [];

  if (LEVELS.some((l) => l.id === level)) {
    clauses.push('level = ?');
    params.push(level);
  }
  const search = String(q || '').trim();
  if (search) {
    clauses.push('(message LIKE ? OR source LIKE ? OR username LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 200, 1000));

  return db
    .get()
    .prepare(`SELECT * FROM app_logs ${where} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...params);
}

/** Compteurs par niveau, pour les pastilles de l'onglet « Application ». */
function counts() {
  const rows = db.get().prepare('SELECT level, COUNT(*) AS n FROM app_logs GROUP BY level').all();
  const out = { all: 0 };
  for (const l of LEVELS) out[l.id] = 0;
  for (const row of rows) {
    out[row.level] = row.n;
    out.all += row.n;
  }
  return out;
}

/** Purge selon la rétention configurée (même politique que les autres logs). */
function purge(days) {
  const keep = Number(days) || 365;
  return db
    .get()
    .prepare("DELETE FROM app_logs WHERE at < datetime('now', ?)")
    .run(`-${keep} days`).changes;
}

function clear() {
  return db.get().prepare('DELETE FROM app_logs').run().changes;
}

module.exports = {
  LEVELS,
  SOURCE_CONNECTEUR,
  write,
  info,
  warn,
  error,
  admin,
  connector,
  list,
  counts,
  purge,
  clear,
};
