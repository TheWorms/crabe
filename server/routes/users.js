'use strict';

/**
 * Gestion des comptes.
 *
 * Deux sections :
 *   - /me/…  : ce que l'utilisateur peut faire sur son propre compte
 *              (demander sa suppression, l'annuler) ;
 *   - le reste : administration, réservé à role = 'admin'.
 */

const express = require('express');
const fs = require('node:fs');
const db = require('../db/db');
const password = require('../auth/password');
const deletion = require('../deletion');
const sessionStore = require('../auth/session');
const permissions = require('../permissions');
const preferences = require('../preferences');
const notifications = require('../notifications');
const applog = require('../applog');
const { publicUser, policy } = require('./auth');
const { requireAuth, requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();

// ---------------------------------------------------------------------------
// Compte courant
// ---------------------------------------------------------------------------

/** État de la demande de suppression du compte courant. */
router.get('/me/deletion', requireAuth, (req, res) => {
  const request = deletion.getRequestForUser(req.user.id);
  res.json({
    request: request
      ? {
          wantsExport: !!request.wants_export,
          exportSent: !!request.export_sent,
          revoked: !!request.revoked,
          requestedAt: request.requested_at,
          scheduledDeleteAt: request.scheduled_delete_at,
        }
      : null,
    retentionDays: deletion.RETENTION_DAYS,
  });
});

router.post(
  '/me/deletion',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'admin' && permissions.isLastActiveAdmin(req.user.id)) {
      return res.status(400).json({
        error: 'Vous êtes le dernier administrateur actif — impossible de supprimer ce compte.',
      });
    }

    const request = deletion.requestDeletion(req.user.id, !!req.body?.wantsExport);
    res.json({
      ok: true,
      request: {
        wantsExport: !!request.wants_export,
        revoked: !!request.revoked,
        scheduledDeleteAt: request.scheduled_delete_at,
      },
    });
  })
);

router.delete('/me/deletion', requireAuth, (req, res) => {
  const request = deletion.getRequestForUser(req.user.id);
  if (request?.revoked) {
    return res
      .status(400)
      .json({ error: 'L\'accès a déjà été révoqué — contactez l\'administrateur.' });
  }
  res.json({ ok: deletion.cancelRequest(req.user.id) });
});

/**
 * Préférences d'interface du compte courant (filtres d'écran mémorisés).
 *
 * Côté serveur et non dans le navigateur : « mémorisé par administrateur »
 * doit vouloir dire « par compte », pas « par machine ».
 */
router.get('/me/preferences', requireAuth, (req, res) => {
  res.json({ preferences: preferences.all(req.user.id) });
});

/**
 * Enregistre des préférences.
 *
 * Tout est vérifié AVANT la première écriture, jamais au fil de la boucle : un
 * envoi de deux réglages dont le second est refusé ne doit pas laisser le
 * premier écrit et le second non — l'utilisateur se retrouverait avec une
 * moitié de son geste appliquée, sans savoir laquelle.
 *
 * Une liste fermée est défendue ICI, et pas seulement proposée par un menu
 * déroulant : le menu est une commodité d'affichage, il ne protège de rien.
 */
router.put('/me/preferences', requireAuth, (req, res) => {
  const entries = Object.entries(req.body?.preferences || {});
  if (!entries.length) return res.status(400).json({ error: 'Aucune préférence fournie.' });

  for (const [key, value] of entries) {
    if (!preferences.isKnown(key)) {
      return res.status(400).json({ error: `Préférence inconnue : ${key}` });
    }
    const motif = preferences.refus(key, value);
    if (motif) return res.status(400).json({ error: motif });
  }
  for (const [key, value] of entries) preferences.set(req.user.id, key, value);

  res.json({ ok: true, preferences: preferences.all(req.user.id) });
});

// ---------------------------------------------------------------------------
// Fichiers : la convention de nommage et l'harmonisation (lot 56)
//
// Toujours sur SON propre compte : le réglage est par compte, et les documents
// renommés sont ceux du compte qui clique. La convention elle-même s'écrit par
// /me/preferences (clé `fichiers.convention`) — ces routes-ci portent la
// mesure, le lancement et l'annulation.
// ---------------------------------------------------------------------------

/** Tout l'écran « Fichiers » en un appel : conventions, mesures, chantier. */
router.get('/me/fichiers', requireAuth, (req, res) => {
  const harmonisation = require('../harmonisation');
  const conventionNoms = require('../convention-noms');
  const convention = preferences.get(req.user.id, 'fichiers.convention');

  // Les chiffres de CHAQUE bloc sont mesurés sur les documents du compte —
  // jamais estimés : le choix doit se comprendre sur ce qu'il ferait vraiment.
  const mesures = {};
  for (const c of conventionNoms.CONVENTIONS) {
    mesures[c.id] = harmonisation.mesurerConvention(req.user.id, c.id);
  }

  // Le détail du plan vers la convention ACTIVE : les cas douteux et les
  // collisions se montrent AVANT le clic, pas au moment du refus.
  const plan = harmonisation.construirePlan(req.user.id, convention);

  res.json({
    convention,
    conventions: conventionNoms.CONVENTIONS,
    mesures,
    plan: {
      aRenommer: plan.entrees.length,
      mouvements: plan.entrees.reduce((n, e) => n + e.mouvements.length, 0),
      douteux: plan.douteux.slice(0, 50),
      collisions: plan.collisions.slice(0, 50),
    },
    harmonisation: harmonisation.progress(),
  });
});

/**
 * Lance l'harmonisation — ou la REPREND après une interruption : même geste,
 * le plan se recalcule et ce qui est fait est reconnu. La réponse rend la main
 * tout de suite ; les préalables (sauvegarde, destinations joignables, zéro
 * cas douteux) se vérifient en tâche de fond et un refus se lit dans l'état.
 */
router.post('/me/fichiers/harmonisation', requireAuth, (req, res) => {
  const harmonisation = require('../harmonisation');
  const lance = harmonisation.demarrer({ userId: req.user.id, username: req.user.username });
  applog.admin(req, 'Renommage des documents existants lancé depuis l\'écran Fichiers.');
  res.json(lance);
});

/** Annule : rejoue le journal du renommage à l'envers, mêmes garde-fous. */
router.post('/me/fichiers/harmonisation/annulation', requireAuth, (req, res) => {
  const harmonisation = require('../harmonisation');
  const lance = harmonisation.annuler({ userId: req.user.id, username: req.user.username });
  applog.admin(req, 'Annulation du renommage des documents lancée depuis l\'écran Fichiers.');
  res.json(lance);
});

/** L'état du chantier seul — l'écran l'interroge pendant qu'il tourne. */
router.get('/me/fichiers/harmonisation', requireAuth, (req, res) => {
  res.json(require('../harmonisation').progress());
});

// ---------------------------------------------------------------------------
// Notifications d'échec de récupération planifiée (lot 26)
//
// Toujours sur SON propre compte : `req.user.id`, jamais un identifiant reçu du
// client. Une notification dit quel service est en panne chez quelqu'un — ce
// n'est l'affaire de personne d'autre, administrateur compris.
// ---------------------------------------------------------------------------

/** Ce que ce compte n'a pas encore vu. Vide est la réponse normale. */
router.get('/me/notifications', requireAuth, (req, res) => {
  res.json({
    notifications: notifications.nonLues(req.user.id),
    reglage: notifications.reglage(req.user.id),
  });
});

/**
 * Acquitte des notifications.
 *
 * Sans `ids`, tout est acquitté : c'est le geste « j'ai vu », qui doit rester
 * atteignable même quand la liste a changé entre-temps.
 */
router.post('/me/notifications/seen', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isInteger)
    : null;
  res.json({ ok: true, marquees: notifications.marquerVues(req.user.id, ids) });
});

// ---------------------------------------------------------------------------
// Administration — permission « Gérer les utilisateurs »
// ---------------------------------------------------------------------------

router.use(requirePermission('users.manage'));

function row(id) {
  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

router.get('/', (req, res) => {
  const users = db
    .get()
    .prepare('SELECT * FROM users ORDER BY id')
    .all()
    .map((u) => ({
      ...publicUser(u),
      connectorCount: db
        .get()
        .prepare('SELECT COUNT(*) AS n FROM connector_installs WHERE user_id = ?')
        .get(u.id).n,
      invoiceCount: db
        .get()
        .prepare('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ?')
        .get(u.id).n,
    }));
  res.json({ users });
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { username, email, phone, role, password: plain } = req.body || {};
    const clean = String(username || '').trim();

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(clean)) {
      return res.status(400).json({
        error: 'Identifiant invalide (3 à 32 caractères : lettres, chiffres, . _ -).',
      });
    }
    if (db.get().prepare('SELECT id FROM users WHERE username = ?').get(clean)) {
      return res.status(409).json({ error: 'Cet identifiant est déjà utilisé.' });
    }

    const check = password.check(String(plain || ''), policy().password_complexity);
    if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });

    const id = db
      .get()
      .prepare(
        `INSERT INTO users (username, email, phone, password_hash, role, password_changed_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        clean,
        String(email || '').trim(),
        String(phone || '').trim(),
        await password.hash(String(plain)),
        role === 'admin' ? 'admin' : 'user'
      ).lastInsertRowid;

    // Rôle explicite si fourni, sinon le rôle intégré correspondant.
    const roleId = req.body?.roleId
      ? Number(req.body.roleId)
      : permissions.defaultRoleIdFor(role === 'admin' ? 'admin' : 'user');
    if (roleId) permissions.assignRole(id, roleId);

    applog.admin(req, `Compte « ${clean} » créé.`);
    res.status(201).json({ user: publicUser(row(id)) });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = row(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const { email, phone, role, status, landingPage, homeCustomizable, password: plain } =
      req.body || {};
    const fields = [];
    const values = [];

    if (email !== undefined) { fields.push('email = ?'); values.push(String(email).trim()); }
    // « Autoriser la personnalisation de l'accueil ». Retirée, l'utilisateur
    // ne peut plus rien changer NI se réautoriser : c'est le seul verrou des
    // deux que le compte concerné ne peut pas lever (voir server/home.js).
    if (homeCustomizable !== undefined) {
      fields.push('home_customizable = ?');
      values.push(homeCustomizable ? 1 : 0);
    }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(String(phone).trim()); }
    if (landingPage !== undefined && ['apps', 'local', 'papiers'].includes(landingPage)) {
      fields.push('landing_page = ?');
      values.push(landingPage);
    }

    // Le rôle peut arriver sous forme de nature ('admin' | 'user') ou d'un
    // roleId précis (rôle personnalisé). Dans les deux cas, users.role et
    // users.role_id restent cohérents.
    let targetRoleId = null;
    if (req.body?.roleId !== undefined) {
      const wanted = permissions.roleById(req.body.roleId);
      if (!wanted) return res.status(404).json({ error: 'Rôle introuvable.' });
      targetRoleId = wanted.id;
      if (user.role === 'admin' && wanted.slug !== 'admin' && isLastAdmin(user.id)) {
        return res.status(400).json({ error: 'Impossible de rétrograder le dernier administrateur.' });
      }
    } else if (role !== undefined && ['admin', 'user'].includes(role)) {
      if (user.role === 'admin' && role !== 'admin' && isLastAdmin(user.id)) {
        return res.status(400).json({ error: 'Impossible de rétrograder le dernier administrateur.' });
      }
      targetRoleId = permissions.defaultRoleIdFor(role);
    }

    if (status !== undefined && ['active', 'inactive'].includes(status)) {
      if (status === 'inactive' && user.role === 'admin' && isLastAdmin(user.id)) {
        return res.status(400).json({ error: 'Impossible de désactiver le dernier administrateur.' });
      }
      fields.push('status = ?');
      values.push(status);
    }

    if (plain) {
      const check = password.check(String(plain), policy().password_complexity);
      if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });
      fields.push('password_hash = ?', "password_changed_at = datetime('now')");
      values.push(await password.hash(String(plain)));
    }

    if (!fields.length && !targetRoleId) {
      return res.status(400).json({ error: 'Aucune modification fournie.' });
    }

    if (fields.length) {
      values.push(user.id);
      db.get().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
    if (targetRoleId) permissions.assignRole(user.id, targetRoleId);

    // Une désactivation coupe les sessions ouvertes sans attendre.
    if (status === 'inactive') sessionStore.store().destroyForUser(user.id);

    applog.admin(req, `Compte « ${user.username} » modifié.`);
    res.json({ user: publicUser(row(user.id)) });
  })
);

const isLastAdmin = permissions.isLastActiveAdmin;

/**
 * « Appliquer cette disposition à tous les utilisateurs ».
 *
 * Recopie l'accueil du compte demandeur (ou d'un compte désigné) sur tous les
 * autres. Utile juste après avoir retiré l'autorisation de personnaliser :
 * sans ça, chacun resterait figé sur SA disposition, et « homogène » ne
 * voudrait rien dire.
 */
router.post('/home-layout/apply-to-all', (req, res) => {
  const home = require('../home');
  const sourceId = req.body?.sourceUserId === undefined ? req.user.id : Number(req.body.sourceUserId);
  const source = row(sourceId);
  if (!source) return res.status(404).json({ error: 'Compte source introuvable.' });

  const result = home.applyLayoutToEveryone(source.id);
  applog.admin(
    req,
    `Disposition de l'accueil de « ${source.username} » appliquée à ${result.applied} compte(s).`,
    'warn'
  );
  res.json({
    ok: true,
    applied: result.applied,
    source: source.username,
    widgets: result.widgets,
  });
});

/**
 * Réinitialisation de la 2FA par l'administrateur.
 *
 * C'est la porte de secours pour un compte enfermé dehors (téléphone perdu,
 * secret jamais scanné) : elle évite d'avoir à passer par un UPDATE SQLite à
 * la main, comme il a fallu le faire en production.
 */
router.post('/:id/2fa/reset', (req, res) => {
  const user = row(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  db.get()
    .prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?')
    .run(user.id);

  applog.admin(req, `Double authentification réinitialisée pour « ${user.username} ».`, 'warn');
  res.json({
    ok: true,
    user: publicUser(row(user.id)),
    message: `La double authentification de ${user.username} est réinitialisée : le compte peut se reconnecter avec son seul mot de passe.`,
  });
});

/** Révocation immédiate : compte inactif + sessions détruites. */
router.post('/:id/revoke', (req, res) => {
  const user = row(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (user.role === 'admin' && isLastAdmin(user.id)) {
    return res.status(400).json({ error: 'Impossible de révoquer le dernier administrateur.' });
  }

  db.get().prepare("UPDATE users SET status = 'inactive' WHERE id = ?").run(user.id);
  const killed = sessionStore.store().destroyForUser(user.id);
  applog.admin(req, `Accès de « ${user.username} » révoqué (${killed} session(s) fermée(s)).`, 'warn');
  res.json({ ok: true, sessionsClosed: killed, user: publicUser(row(user.id)) });
});

/** Export RGPD téléchargeable. */
router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const user = row(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const result = await deletion.buildExport(user.id);
    res.download(result.path, `crabe-export-${user.username}.zip`, (err) => {
      if (err && !res.headersSent) res.status(500).end();
      fs.rm(result.path, { force: true }, () => {});
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = row(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (user.role === 'admin' && isLastAdmin(user.id)) {
      return res.status(400).json({ error: 'Impossible de supprimer le dernier administrateur.' });
    }
    const result = await deletion.finalizeDeletion(user.id);
    applog.admin(req, `Compte « ${user.username} » supprimé définitivement.`, 'warn');
    res.json({ ok: true, ...result });
  })
);

// --- Demandes de suppression -----------------------------------------------

router.get('/deletion/requests', (req, res) => {
  res.json({
    requests: deletion.listRequests().map((r) => ({
      userId: r.user_id,
      username: r.username,
      email: r.email,
      wantsExport: !!r.wants_export,
      exportSent: !!r.export_sent,
      revoked: !!r.revoked,
      requestedAt: r.requested_at,
      scheduledDeleteAt: r.scheduled_delete_at,
    })),
    retentionDays: deletion.RETENTION_DAYS,
  });
});

router.post(
  '/deletion/requests/:id/export',
  asyncHandler(async (req, res) => {
    const result = await deletion.sendExport(Number(req.params.id));
    res.json({ ok: true, bytes: result.bytes, files: result.files, path: result.path });
  })
);

router.post('/deletion/requests/:id/revoke', (req, res) => {
  const request = deletion.revokeAccess(Number(req.params.id));
  res.json({ ok: true, scheduledDeleteAt: request.scheduled_delete_at });
});

router.post(
  '/deletion/requests/:id/finalize',
  asyncHandler(async (req, res) => {
    const result = await deletion.finalizeDeletion(Number(req.params.id));
    res.json({ ok: true, ...result });
  })
);

module.exports = { router };
