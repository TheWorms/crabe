'use strict';

/**
 * Rôles et permissions — écran « Paramètres → Permissions ».
 *
 * Toutes les routes exigent la permission `roles.manage`, vérifiée côté
 * serveur : ce n'est pas l'interface qui protège l'administration.
 */

const express = require('express');
const db = require('../db/db');
const permissions = require('../permissions');
const applog = require('../applog');
const { publicUser } = require('./auth');
const { requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requirePermission('roles.manage'));

/** Catalogue des permissions + rôles + matrice par utilisateur. */
router.get('/', (req, res) => {
  const users = db
    .get()
    .prepare('SELECT * FROM users ORDER BY username')
    .all()
    .map((u) => {
      const view = publicUser(u);
      return {
        id: view.id,
        username: view.username,
        roleId: view.roleId,
        roleName: view.roleName,
        roleSlug: view.roleSlug,
        status: view.status,
        permissions: view.permissions,
      };
    });

  res.json({
    permissions: permissions.PERMISSIONS,
    roles: permissions.listRoles(),
    users,
    note:
      'Les rôles « Administrateur » et « Utilisateur » sont intégrés à crabe : ' +
      'ni supprimables, ni renommables. Un rôle personnalisé encore attribué ' +
      'exige une réaffectation avant suppression.',
  });
});

/**
 * Attribution d'un rôle à un compte (volet « Permissions par utilisateur »).
 * Refuse toute opération qui viderait le rôle administrateur.
 */
router.put(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const role = permissions.roleById(req.body?.roleId);
    if (!role) return res.status(404).json({ error: 'Rôle introuvable.' });

    // Un gestionnaire délégué ne peut pas hisser un compte au-dessus de lui —
    // rôle administrateur, ou rôle portant des permissions qu'il n'a pas.
    if (!permissions.canGrantRole(req.user, role)) {
      return res.status(403).json({
        error: 'Vous ne pouvez pas attribuer un rôle doté de plus de droits que les vôtres.',
      });
    }

    const losesAdmin = user.role === 'admin' && role.slug !== permissions.ADMIN_SLUG;
    if (losesAdmin && permissions.isLastActiveAdmin(user.id)) {
      return res.status(400).json({
        error: 'Impossible de retirer le rôle administrateur au dernier administrateur actif.',
      });
    }

    permissions.assignRole(user.id, role.id);
    applog.admin(req, `Rôle « ${role.name} » attribué à « ${user.username} ».`);

    const fresh = db.get().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({ ok: true, user: publicUser(fresh) });
  })
);

/** On n'accorde jamais à un rôle une permission qu'on ne détient pas soi-même. */
function refusePermissionsAuDela(req, asked) {
  if (req.user.role === 'admin') return null;
  const mine = new Set(permissions.permissionsForUser(req.user));
  const liste = Array.isArray(asked) ? asked : [];
  if (liste.some((p) => !mine.has(p))) {
    return 'Vous ne pouvez accorder à un rôle que des permissions que vous détenez vous-même.';
  }
  return null;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const motif = refusePermissionsAuDela(req, req.body?.permissions || []);
    if (motif) return res.status(403).json({ error: motif });

    const role = permissions.createRole(req.body?.name, req.body?.permissions || []);
    applog.admin(req, `Rôle « ${role.name} » créé (${role.permissions.length} permission(s)).`);
    res.status(201).json({ role });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = permissions.roleById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rôle introuvable.' });

    let role = permissions.listRoles().find((r) => r.id === existing.id);

    if (req.body?.name !== undefined && !existing.builtin) {
      role = permissions.renameRole(existing.id, req.body.name);
    }
    if (req.body?.permissions !== undefined) {
      // Le rôle intégré « Utilisateur » est celui de TOUS les comptes ordinaires :
      // lui ajouter une permission la donnerait à tout le monde. Réservé au vrai
      // administrateur.
      if (existing.slug === permissions.USER_SLUG && req.user.role !== 'admin') {
        return res.status(403).json({
          error:
            'Les permissions du rôle intégré « Utilisateur » ne peuvent être modifiées que par un administrateur.',
        });
      }
      const motif = refusePermissionsAuDela(req, req.body.permissions);
      if (motif) return res.status(403).json({ error: motif });
      role = permissions.setRolePermissions(existing.id, req.body.permissions);
    }

    applog.admin(req, `Rôle « ${role.name} » modifié.`);
    res.json({ role });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = permissions.roleById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rôle introuvable.' });

    const result = permissions.deleteRole(existing.id, req.body?.reassignToRoleId ?? null);
    applog.admin(
      req,
      `Rôle « ${existing.name} » supprimé${result.reassigned ? ` (${result.reassigned} compte(s) réaffecté(s))` : ''}.`
    );
    res.json({ ok: true, ...result });
  })
);

module.exports = { router };
