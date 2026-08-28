'use strict';

/**
 * Journaux — administration.
 *
 * Trois familles, correspondant aux onglets du menu « Logs » :
 *   - connecteurs (`run_logs`)      : une ligne par exécution ;
 *   - application (`app_logs`)      : démarrages, migrations, erreurs, tâches
 *                                     planifiées, opérations d'administration ;
 *   - stockage (`destination_logs`) : dépôts et purges vers le stockage local, Proton
 *                                     Drive et pCloud.
 *
 * Les journaux de CONNEXION ne sont plus dans ce menu : ils s'affichent dans
 * « Sécurité », avec la politique de rétention. Les routes /connections sont
 * conservées ici, au même endroit que les autres journaux.
 *
 * Lecture : permission « Consulter les logs ». Purge et rétention :
 * « Configurer la sécurité » — ce sont des réglages, pas de la consultation.
 */

const express = require('express');
const db = require('../db/db');
const registry = require('../connectors/registry');
const scheduler = require('../scheduler');
const applog = require('../applog');
const destinations = require('../destinations');
const destinationCatalogue = require('../destinations/catalogue');
const tri = require('../connectors/tri');
const { requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requirePermission('logs.read'));
const requireSecurity = requirePermission('security.manage');

const RETENTION_OPTIONS = [
  { days: 30, label: '30 jours' },
  { days: 60, label: '60 jours' },
  { days: 90, label: '90 jours' },
  { days: 180, label: '6 mois' },
  { days: 365, label: '1 an' },
  { days: 730, label: '2 ans' },
];

function retentionDays() {
  return db.get().prepare('SELECT log_retention_days FROM security_policy WHERE id = 1').get()
    .log_retention_days;
}

function limitOf(query, fallback = 200) {
  return Math.min(Number(query.limit) || fallback, 1000);
}

// ---------------------------------------------------------------------------
// Connexions (affichées dans « Sécurité »)
// ---------------------------------------------------------------------------

router.get('/connections', (req, res) => {
  const clauses = [];
  const params = [];

  // Filtres : par utilisateur, par période, par résultat.
  if (req.query.user && req.query.user !== 'all') {
    clauses.push('(c.user_id = ? OR c.username = ?)');
    params.push(Number(req.query.user) || 0, String(req.query.user));
  }
  const days = Number(req.query.days);
  if (Number.isInteger(days) && days > 0) {
    clauses.push("c.date >= datetime('now', ?)");
    params.push(`-${days} days`);
  }
  if (req.query.result === 'success') clauses.push('c.success = 1');
  if (req.query.result === 'failure') clauses.push('c.success = 0');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limitOf(req.query));

  const logs = db
    .get()
    .prepare(
      `SELECT c.id, c.user_id, c.date, c.os, c.browser, c.ip, c.success,
              COALESCE(u.username, c.username, '(compte supprimé)') AS username
         FROM connection_logs c
         LEFT JOIN users u ON u.id = c.user_id
        ${where}
        ORDER BY c.date DESC, c.id DESC LIMIT ?`
    )
    .all(...params);

  res.json({
    logs,
    retentionDays: retentionDays(),
    retentionOptions: RETENTION_OPTIONS,
    // Comptes ayant au moins une trace, pour le filtre.
    users: db
      .get()
      .prepare(
        `SELECT DISTINCT COALESCE(u.username, c.username) AS username, c.user_id AS id
           FROM connection_logs c LEFT JOIN users u ON u.id = c.user_id
          WHERE COALESCE(u.username, c.username) IS NOT NULL
          ORDER BY username`
      )
      .all(),
    total: db.get().prepare('SELECT COUNT(*) AS n FROM connection_logs').get().n,
  });
});

router.delete('/connections', requireSecurity, (req, res) => {
  const result = db.get().prepare('DELETE FROM connection_logs').run();
  applog.admin(req, `Journal des connexions purgé (${result.changes} ligne(s)).`, 'warn');
  res.json({ ok: true, deleted: result.changes });
});

/** Politique de rétention, commune à tous les journaux. */
router.put('/retention', requireSecurity, (req, res) => {
  const days = Number(req.body?.days);
  if (!RETENTION_OPTIONS.some((o) => o.days === days)) {
    return res.status(400).json({ error: 'Durée de conservation non prise en charge.' });
  }
  db.get()
    .prepare("UPDATE security_policy SET log_retention_days = ?, updated_at = datetime('now') WHERE id = 1")
    .run(days);

  const purged = scheduler.purgeOldLogs();
  applog.admin(
    req,
    `Conservation des journaux réglée à ${days} jours (${purged.total} ligne(s) purgée(s)).`
  );
  res.json({ ok: true, retentionDays: days, purged: purged.total, detail: purged });
});

// ---------------------------------------------------------------------------
// Onglet « Connecteurs » — exécutions
// ---------------------------------------------------------------------------

router.get('/runs', (req, res) => {
  const connectorId = req.query.connector;
  const clauses = [];
  const params = [];

  if (connectorId && connectorId !== 'all') {
    clauses.push('r.connector_id = ?');
    params.push(connectorId);
  }
  if (req.query.result === 'success') clauses.push('r.success = 1');
  // « Échecs » ne doit pas attraper les exécutions EN COURS : leur ligne naît
  // avec success = 0 et ne reçoit son vrai résultat qu'à la fin. Le journal
  // complet, lui, continue de les montrer — étiquetées « En cours » à
  // l'affichage, pas « Échec » (14/08/2026, soyoustart).
  if (req.query.result === 'failure') clauses.push('r.success = 0 AND r.finished_at IS NOT NULL');
  const search = String(req.query.q || '').trim();
  if (search) {
    clauses.push('(r.message LIKE ? OR u.username LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limitOf(req.query));

  const rows = db
    .get()
    .prepare(
      `SELECT r.id, r.connector_id, r.started_at, r.finished_at, r.success,
              r.invoice_count, r.trigger, r.message,
              COALESCE(u.username, '(compte supprimé)') AS username
         FROM run_logs r
         LEFT JOIN users u ON u.id = r.user_id
        ${where}
        ORDER BY r.started_at DESC, r.id DESC LIMIT ?`
    )
    .all(...params);

  // Le journal détaillé des connecteurs (lot 41) : ce qu'un connecteur écrit
  // EN PLEIN travail (source `connector:<id>` d'app_logs), entremêlé aux
  // exécutions à l'affichage. Sans lui, l'écran disait « Aucune nouvelle
  // facture » sans jamais dire pourquoi — le 19/08/2026, tout le détail
  // dormait dans journalctl. Le filtre « Succès/Échecs » porte sur des
  // RÉSULTATS d'exécution : le journal, qui n'en est pas un, s'efface alors.
  const prefixe = `${applog.SOURCE_CONNECTEUR}:`;
  // Lot 48 : la fenêtre « Se connecter » écrit sous `remote-browser:<id>`.
  // Sans elle, la soirée du 22/08/2026 s'est diagnostiquée à l'aveugle : tout
  // ce que la fenêtre disait dormait dans « Logs → Application », pendant que
  // cet écran-ci restait vide.
  const prefixeFenetre = 'remote-browser:';
  const journalClauses = ['(a.source LIKE ? OR a.source LIKE ?)'];
  const journalParams = [`${prefixe}%`, `${prefixeFenetre}%`];
  if (connectorId && connectorId !== 'all') {
    journalClauses.push('a.source IN (?, ?)');
    journalParams.push(`${prefixe}${connectorId}`, `${prefixeFenetre}${connectorId}`);
  }
  if (search) {
    journalClauses.push('a.message LIKE ?');
    journalParams.push(`%${search}%`);
  }
  journalParams.push(limitOf(req.query));
  const journal =
    req.query.result === 'success' || req.query.result === 'failure'
      ? []
      : db
          .get()
          .prepare(
            `SELECT a.id, a.at, a.level, a.source, a.message, u.username
               FROM app_logs a
               LEFT JOIN users u ON u.id = a.user_id
              WHERE ${journalClauses.join(' AND ')}
              ORDER BY a.at DESC, a.id DESC LIMIT ?`
          )
          .all(...journalParams);

  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));
  const decor = (id) => ({
    connectorName: catalog.get(id)?.name || id,
    color: catalog.get(id)?.color || '#63666e',
    letters: catalog.get(id)?.letters || '?',
    logo: catalog.get(id)?.logo || null,
  });

  res.json({
    logs: rows.map((r) => ({ ...r, kind: 'run', ...decor(r.connector_id) })),
    // `started_at` reprend l'horodatage de la ligne : les deux familles se
    // trient et s'affichent par la même colonne de date.
    journal: journal.map((j) => {
      const id = j.source.startsWith(prefixe)
        ? j.source.slice(prefixe.length)
        : j.source.slice(prefixeFenetre.length);
      return {
        kind: 'journal',
        id: j.id,
        connector_id: id,
        started_at: j.at,
        level: j.level,
        message: j.message,
        username: j.username,
        ...decor(id),
      };
    }),
    // Filtres : uniquement les connecteurs qui ont réellement tourné — une
    // ligne d'exécution, ou une ligne de journal (les deux familles de l'écran).
    filters: [
      ...new Set(
        db
          .get()
          .prepare(
            `SELECT DISTINCT connector_id FROM run_logs
              UNION
             SELECT DISTINCT substr(source, ?) FROM app_logs WHERE source LIKE ?
              UNION
             SELECT DISTINCT substr(source, ?) FROM app_logs WHERE source LIKE ?`
          )
          .all(prefixe.length + 1, `${prefixe}%`, prefixeFenetre.length + 1, `${prefixeFenetre}%`)
          .map((r) => r.connector_id)
      ),
    ]
      .map((id) => ({ id, name: catalog.get(id)?.name || id }))
      // Le FILTRE est une liste de services, donc alphabétique ; le journal
      // qu'il filtre reste, lui, chronologique. Les deux ne se trient pas
      // pareil, et c'est voulu.
      .sort((a, b) => tri.comparerNoms(a.name, b.name)),
    retentionDays: retentionDays(),
  });
});

router.delete(
  '/runs',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const result = db.get().prepare('DELETE FROM run_logs').run();
    // La purge emporte ce que l'écran affiche : les exécutions ET le journal
    // détaillé des connecteurs (lot 41), sinon l'onglet resterait à moitié plein.
    const journal = db
      .get()
      .prepare("DELETE FROM app_logs WHERE source LIKE ? OR source LIKE 'remote-browser:%'")
      .run(`${applog.SOURCE_CONNECTEUR}:%`);
    applog.admin(
      req,
      `Journal des exécutions purgé (${result.changes} exécution(s), `
        + `${journal.changes} ligne(s) de journal de connecteur).`,
      'warn'
    );
    res.json({ ok: true, deleted: result.changes + journal.changes });
  })
);

// ---------------------------------------------------------------------------
// Onglet « Application » — journal applicatif
// ---------------------------------------------------------------------------

router.get('/app', (req, res) => {
  res.json({
    logs: applog.list({
      level: req.query.level || 'all',
      q: req.query.q || '',
      limit: limitOf(req.query),
    }),
    levels: applog.LEVELS,
    counts: applog.counts(),
    retentionDays: retentionDays(),
  });
});

router.delete('/app', requireSecurity, (req, res) => {
  const deleted = applog.clear();
  applog.admin(req, `Journal applicatif purgé (${deleted} ligne(s)).`, 'warn');
  res.json({ ok: true, deleted });
});

// ---------------------------------------------------------------------------
// Onglet « Stockage » — opérations vers les destinations
// ---------------------------------------------------------------------------

/**
 * L'étiquette des lignes du renommage dans l'onglet Stockage (lot 58) — un
 * pseudo-filtre à côté des destinations, jamais un `dest_id` réel.
 */
const FILTRE_RENOMMAGE = 'harmonisation';
const NOM_RENOMMAGE = 'Renommage des documents';

router.get('/storage', (req, res) => {
  const clauses = [];
  const params = [];

  if (req.query.dest && req.query.dest !== 'all') {
    clauses.push('d.dest_id = ?');
    params.push(String(req.query.dest));
  }
  if (req.query.result === 'success') clauses.push('d.success = 1');
  if (req.query.result === 'failure') clauses.push('d.success = 0');
  const search = String(req.query.q || '').trim();
  if (search) {
    clauses.push('(d.message LIKE ? OR u.username LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limitOf(req.query));

  const logs = db
    .get()
    .prepare(
      `SELECT d.id, d.dest_id, d.at, d.success, d.message, u.username
         FROM destination_logs d
         LEFT JOIN users u ON u.id = d.user_id
        ${where}
        ORDER BY d.at DESC, d.id DESC LIMIT ?`
    )
    .all(...params)
    // Par le catalogue et non par le pilote : un journal porte aussi les
    // opérations d'un cloud supprimé depuis, qui n'a plus de pilote mais garde
    // son nom. Afficher « cloud-3f8a2b91 » sur ces lignes rendrait le journal
    // illisible exactement là où on vient chercher ce qui s'est passé.
    .map((row) => ({
      ...row,
      destName: destinationCatalogue.brand(row.dest_id).name,
    }));

  // ─── Le journal du renommage vit AUSSI ici (lot 58) ────────────────────────
  //
  // Demande explicite du 25/08/2026 : un renommage qui s'arrête ne laissait sa
  // trace que dans le bandeau de l'écran Fichiers. Ses événements (démarrage,
  // arrêt sur écart, reconnexions, reprise, bilan) s'écrivent dans app_logs
  // sous la source `harmonisation` — même mécanisme que les connecteurs
  // (lot 41), même fusion à l'affichage que l'onglet Connecteurs. Le
  // « Résultat » suit le niveau : seule une ligne `info` est un succès — un
  // refus ou un arrêt se cherchent avec le filtre « Échecs ».
  const renommageVisible = !req.query.dest || ['all', FILTRE_RENOMMAGE].includes(req.query.dest);
  const journalClauses = ['a.source = ?'];
  const journalParams = [FILTRE_RENOMMAGE];
  if (req.query.result === 'success') journalClauses.push("a.level = 'info'");
  if (req.query.result === 'failure') journalClauses.push("a.level != 'info'");
  if (search) {
    journalClauses.push('(a.message LIKE ? OR u.username LIKE ?)');
    journalParams.push(`%${search}%`, `%${search}%`);
  }
  journalParams.push(limitOf(req.query));
  const journal = !renommageVisible
    ? []
    : db
        .get()
        .prepare(
          `SELECT a.id, a.at, a.level, a.message, u.username
             FROM app_logs a
             LEFT JOIN users u ON u.id = a.user_id
            WHERE ${journalClauses.join(' AND ')}
            ORDER BY a.at DESC, a.id DESC LIMIT ?`
        )
        .all(...journalParams)
        .map((j) => ({
          id: j.id,
          dest_id: FILTRE_RENOMMAGE,
          at: j.at,
          success: j.level === 'info' ? 1 : 0,
          message: j.message,
          username: j.username,
          destName: NOM_RENOMMAGE,
        }));

  // Les deux familles fusionnées se partagent la même limite, les plus
  // récentes d'abord — comme si elles venaient d'une seule table.
  const fusion = [...logs, ...journal]
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : y.id - x.id))
    .slice(0, limitOf(req.query));

  res.json({
    logs: fusion,
    filters: [
      ...destinations.ordre().map((id) => ({
        id,
        name: destinationCatalogue.brand(id).name,
      })),
      { id: FILTRE_RENOMMAGE, name: NOM_RENOMMAGE },
    ],
    retentionDays: retentionDays(),
  });
});

router.delete('/storage', requireSecurity, (req, res) => {
  const result = db.get().prepare('DELETE FROM destination_logs').run();
  // La purge emporte ce que l'écran affiche — le journal du renommage compris
  // (même règle que l'onglet Connecteurs et ses lignes `connector:` du lot 41).
  const journal = db.get().prepare('DELETE FROM app_logs WHERE source = ?').run(FILTRE_RENOMMAGE);
  applog.admin(
    req,
    `Journal de stockage purgé (${result.changes} opération(s), ${journal.changes} ligne(s) de renommage).`,
    'warn'
  );
  res.json({ ok: true, deleted: result.changes + journal.changes });
});

module.exports = { router, RETENTION_OPTIONS };
