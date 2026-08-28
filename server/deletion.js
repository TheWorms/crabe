'use strict';

/**
 * Suppression de compte et export RGPD.
 *
 * Déroulé (identique à la maquette) :
 *   1. l'utilisateur demande la suppression, avec ou sans export .zip ;
 *   2. l'administrateur envoie l'archive si elle a été demandée ;
 *   3. l'administrateur révoque l'accès — le compte passe inactif, ses
 *      sessions sont détruites et ses connecteurs cessent de tourner ;
 *   4. 30 jours plus tard (ou manuellement), le compte et ses données sont
 *      effacés définitivement, y compris les fichiers sur les destinations.
 */

const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');
const db = require('./db/db');
const destinations = require('./destinations');
const paths = require('./destinations/paths');
const sessionStore = require('./auth/session');
const { config } = require('./config');

const RETENTION_DAYS = 30;

function userById(userId) {
  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// ---------------------------------------------------------------------------
// Export RGPD
// ---------------------------------------------------------------------------

/**
 * Construit une archive .zip contenant les factures de l'utilisateur et un
 * export JSON de ses données personnelles.
 *
 * @param {number} userId
 * @returns {Promise<{path: string, bytes: number, files: number}>}
 */
async function buildExport(userId) {
  const user = userById(userId);
  if (!user) throw new Error(`Utilisateur ${userId} introuvable.`);

  fs.mkdirSync(config.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(
    config.exportsDir,
    `crabe-export-${paths.safeSegment(user.username)}-${stamp}.zip`
  );

  const invoices = db
    .get()
    .prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY fetched_at')
    .all(userId);

  const personal = {
    exporte_le: new Date().toISOString(),
    compte: {
      identifiant: user.username,
      email: user.email,
      telephone: user.phone,
      role: user.role,
      statut: user.status,
      page_accueil: user.landing_page,
      cree_le: user.created_at,
      derniere_connexion: user.last_login_at,
      double_authentification: !!user.totp_enabled,
    },
    connecteurs_installes: db
      .get()
      .prepare(
        `SELECT connector_id, status, installed_at, last_run_at
           FROM connector_installs WHERE user_id = ?`
      )
      .all(userId),
    factures: invoices.map((i) => ({
      connecteur: i.connector_id,
      compte: i.account_id || null,
      fichier: i.filename,
      emise_le: i.issued_on,
      recuperee_le: i.fetched_at,
      taille_octets: i.size_bytes,
    })),
    journal_connexions: db
      .get()
      .prepare('SELECT date, os, browser, ip, success FROM connection_logs WHERE user_id = ?')
      .all(userId),
    demandes_support: db
      .get()
      .prepare('SELECT subject, message, status, reply, created_at FROM tickets WHERE user_id = ?')
      .all(userId),
  };

  let filesAdded = 0;

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
    archive.pipe(output);

    archive.append(JSON.stringify(personal, null, 2), { name: 'donnees-personnelles.json' });
    archive.append(
      [
        'Export de compte crabe',
        '',
        `Compte    : ${user.username}`,
        `Généré le : ${new Date().toLocaleString('fr-FR')}`,
        `Factures  : ${invoices.length}`,
        '',
        'Le dossier factures/ contient une copie de vos documents tels que',
        'récupérés par crabe, classés par connecteur.',
        '',
      ].join('\n'),
      { name: 'LISEZ-MOI.txt' }
    );

    for (const invoice of invoices) {
      const source = destinations.invoicePath(invoice, user.username);
      if (source && fs.existsSync(source)) {
        archive.file(source, {
          name: `factures/${invoice.connector_id}/${invoice.account_id || 'defaut'}/${invoice.filename}`,
        });
        filesAdded++;
      }
    }

    archive.finalize();
  });

  return { path: outFile, bytes: fs.statSync(outFile).size, files: filesAdded };
}

// ---------------------------------------------------------------------------
// Demandes de suppression
// ---------------------------------------------------------------------------

function getRequestForUser(userId) {
  return db.get().prepare('SELECT * FROM deletion_requests WHERE user_id = ?').get(userId);
}

/** Crée la demande. Idempotent : une demande en cours est renvoyée telle quelle. */
function requestDeletion(userId, wantsExport = false) {
  const existing = getRequestForUser(userId);
  if (existing) return existing;

  const scheduled = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  db.get()
    .prepare(
      `INSERT INTO deletion_requests (user_id, wants_export, scheduled_delete_at)
       VALUES (?, ?, ?)`
    )
    .run(userId, wantsExport ? 1 : 0, scheduled);

  return getRequestForUser(userId);
}

/** Annule une demande (l'utilisateur ou l'admin change d'avis). */
function cancelRequest(userId) {
  const res = db.get().prepare('DELETE FROM deletion_requests WHERE user_id = ?').run(userId);
  return res.changes > 0;
}

function listRequests() {
  return db
    .get()
    .prepare(
      `SELECT dr.*, u.username, u.email
         FROM deletion_requests dr
         JOIN users u ON u.id = dr.user_id
        ORDER BY dr.requested_at`
    )
    .all();
}

/** Étape 2 : génère et « envoie » l'archive. */
async function sendExport(userId) {
  const request = getRequestForUser(userId);
  if (!request) throw new Error('Aucune demande de suppression pour ce compte.');

  const result = await buildExport(userId);
  db.get()
    .prepare('UPDATE deletion_requests SET export_sent = 1, export_path = ? WHERE user_id = ?')
    .run(result.path, userId);

  return result;
}

/** Étape 3 : révocation immédiate de l'accès. */
function revokeAccess(userId) {
  const request = getRequestForUser(userId);
  if (!request) throw new Error('Aucune demande de suppression pour ce compte.');

  db.transaction(() => {
    db.get().prepare("UPDATE users SET status = 'inactive' WHERE id = ?").run(userId);
    db.get()
      .prepare(
        "UPDATE deletion_requests SET revoked = 1, revoked_at = datetime('now') WHERE user_id = ?"
      )
      .run(userId);
    // Les connecteurs cessent de tourner : la config chiffrée est effacée.
    db.get()
      .prepare("UPDATE connector_installs SET config_encrypted = NULL, status = 'needs-config' WHERE user_id = ?")
      .run(userId);
    // Les éléments découverts partent avec elle : numéros de ligne et noms de
    // titulaires n'ont plus de raison d'être conservés une fois l'accès révoqué.
    db.get().prepare('DELETE FROM connector_discoveries WHERE user_id = ?').run(userId);
  })();

  try {
    sessionStore.store().destroyForUser(userId);
  } catch {
    /* store non initialisé (tests) */
  }

  // Les connecteurs de ce compte ne doivent plus être planifiés : sans ce
  // rechargement, les tâches cron resteraient armées jusqu'au prochain
  // redémarrage du service. Chargement tardif : scheduler.js dépend d'ici.
  require('./scheduler').reload();

  return getRequestForUser(userId);
}

/**
 * Étape 4 : effacement définitif.
 * Supprime les fichiers sur toutes les destinations, puis la ligne `users`
 * (les tables liées suivent par ON DELETE CASCADE).
 */
async function finalizeDeletion(userId) {
  const user = userById(userId);
  if (!user) throw new Error(`Utilisateur ${userId} introuvable.`);

  let purge = {};
  try {
    purge = await destinations.purgeUser(user.username, userId);
  } catch (err) {
    purge = { error: err.message };
  }

  db.transaction(() => {
    // Les tickets sont conservés côté support mais anonymisés (user_id -> NULL).
    db.get().prepare('DELETE FROM deletion_requests WHERE user_id = ?').run(userId);
    db.get().prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();

  try {
    sessionStore.store().destroyForUser(userId);
  } catch {
    /* store non initialisé (tests) */
  }

  // `user_connector_schedules` a suivi la suppression (ON DELETE CASCADE) ;
  // les tâches cron déjà armées, elles, doivent être retirées explicitement.
  require('./scheduler').reload();

  return { username: user.username, purge };
}

/**
 * Suppressions arrivées à échéance (appelé par l'entretien quotidien).
 * Seuls les comptes déjà révoqués sont purgés : une demande non traitée par
 * l'administrateur n'efface jamais un compte toute seule.
 */
function dueDeletions() {
  return db
    .get()
    .prepare(
      `SELECT * FROM deletion_requests
        WHERE revoked = 1 AND scheduled_delete_at <= datetime('now')`
    )
    .all();
}

/**
 * Purge les comptes arrivés à échéance, un par un.
 *
 * Chaque suppression est attendue : sans cela, la fonction rendrait la main
 * avant que les comptes soient réellement effacés, et signalerait comme
 * purgés des comptes encore présents.
 *
 * @returns {Promise<number[]>} identifiants des comptes effectivement supprimés
 */
async function processDueDeletions() {
  const done = [];
  for (const request of dueDeletions()) {
    try {
      await finalizeDeletion(request.user_id);
      done.push(request.user_id);
    } catch (err) {
      // Un échec (purge distante injoignable) laisse la demande en place :
      // elle sera retentée au prochain passage.
      console.error(`[deletion] compte ${request.user_id} :`, err.message);
    }
  }
  return done;
}

module.exports = {
  RETENTION_DAYS,
  buildExport,
  requestDeletion,
  cancelRequest,
  getRequestForUser,
  listRequests,
  sendExport,
  revokeAccess,
  finalizeDeletion,
  dueDeletions,
  processDueDeletions,
};
