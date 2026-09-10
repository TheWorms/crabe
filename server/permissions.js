'use strict';

/**
 * Rôles et permissions.
 *
 * Les permissions sont atomiques et nommées explicitement ; elles sont
 * vérifiées CÔTÉ SERVEUR sur chaque route d'administration (middleware
 * `requirePermission`), l'interface ne fait que masquer ce qui est déjà
 * refusé par l'API.
 *
 * Deux rôles sont intégrés :
 *   - `admin` — toutes les permissions, non supprimable, non renommable ;
 *   - `user`  — aucune permission d'administration, non supprimable.
 *
 * Un rôle personnalisé porte un sous-ensemble libre de permissions. Le champ
 * `users.role` ('admin' | 'user') reste la NATURE du compte : il porte le
 * garde-fou « il doit rester au moins un administrateur actif ». Seul le rôle
 * de slug `admin` donne `users.role = 'admin'`.
 */

const db = require('./db/db');

/** Catalogue des permissions, dans l'ordre d'affichage de la matrice. */
const PERMISSIONS = [
  { id: 'users.manage', label: 'Gérer les utilisateurs' },
  { id: 'roles.manage', label: 'Gérer les rôles' },
  { id: 'apps.manage', label: 'Gérer les applications' },
  { id: 'storage.manage', label: 'Configurer le stockage' },
  { id: 'logs.read', label: 'Consulter les logs' },
  { id: 'support.reply', label: 'Répondre au support' },
  { id: 'security.manage', label: 'Configurer la sécurité' },
  { id: 'schedules.manage', label: 'Planifier les tâches' },
];

const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);

const ADMIN_SLUG = 'admin';
const USER_SLUG = 'user';

/** Rôles intégrés, créés à l'ouverture de la base. */
const BUILTIN_ROLES = [
  { slug: ADMIN_SLUG, name: 'Administrateur', permissions: PERMISSION_IDS },
  { slug: USER_SLUG, name: 'Utilisateur', permissions: [] },
];

function isValidPermission(id) {
  return PERMISSION_IDS.includes(id);
}

/** Crée les rôles intégrés s'ils manquent et (re)pose leurs permissions. */
function seedBuiltinRoles(database = db.get()) {
  const insertRole = database.prepare(
    'INSERT INTO roles (slug, name, builtin) VALUES (?, ?, 1) ON CONFLICT(slug) DO NOTHING'
  );
  const markBuiltin = database.prepare('UPDATE roles SET builtin = 1 WHERE slug = ?');
  const insertPerm = database.prepare(
    'INSERT INTO role_permissions (role_id, permission) VALUES (?, ?) ON CONFLICT DO NOTHING'
  );

  for (const role of BUILTIN_ROLES) {
    insertRole.run(role.slug, role.name);
    markBuiltin.run(role.slug);
    const row = database.prepare('SELECT id FROM roles WHERE slug = ?').get(role.slug);
    // L'administrateur reçoit toujours l'intégralité des permissions, y
    // compris celles ajoutées par une version ultérieure de crabe.
    for (const permission of role.permissions) insertPerm.run(row.id, permission);
  }
}

function roleBySlug(slug) {
  return db.get().prepare('SELECT * FROM roles WHERE slug = ?').get(slug);
}

function roleById(id) {
  return db.get().prepare('SELECT * FROM roles WHERE id = ?').get(Number(id));
}

/** Permissions d'un rôle donné. */
function permissionsForRole(roleId) {
  if (!roleId) return [];
  return db
    .get()
    .prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission')
    .all(Number(roleId))
    .map((r) => r.permission)
    .filter(isValidPermission);
}

/**
 * Permissions effectives d'un compte.
 * Le rôle intégré `admin` a tout, quoi qu'il y ait en base.
 */
function permissionsForUser(user) {
  if (!user) return [];
  if (user.role === 'admin') return [...PERMISSION_IDS];
  return permissionsForRole(user.role_id);
}

function userHas(user, permission) {
  if (!user || user.status === 'inactive') return false;
  if (user.role === 'admin') return true;
  return permissionsForUser(user).includes(permission);
}

/** Un compte a-t-il au moins une permission d'administration ? */
function hasAnyAdminPermission(user) {
  return permissionsForUser(user).length > 0;
}

/** Vue complète des rôles pour l'écran « Permissions ». */
function listRoles() {
  const counts = new Map(
    db
      .get()
      .prepare('SELECT role_id, COUNT(*) AS n FROM users WHERE role_id IS NOT NULL GROUP BY role_id')
      .all()
      .map((r) => [r.role_id, r.n])
  );

  return db
    .get()
    .prepare('SELECT * FROM roles ORDER BY builtin DESC, name')
    .all()
    .map((role) => ({
      id: role.id,
      slug: role.slug,
      name: role.name,
      builtin: !!role.builtin,
      // `admin` garde toutes ses permissions même si la table est incomplète.
      permissions: role.slug === ADMIN_SLUG ? [...PERMISSION_IDS] : permissionsForRole(role.id),
      userCount: counts.get(role.id) || 0,
      deletable: !role.builtin,
    }));
}

/** Crée un rôle personnalisé. */
function createRole(name, permissions = []) {
  const clean = String(name || '').trim();
  if (clean.length < 2 || clean.length > 40) {
    const err = new Error('Le nom du rôle doit faire entre 2 et 40 caractères.');
    err.statusCode = 400;
    throw err;
  }

  const slug = slugify(clean);
  if (slug === ADMIN_SLUG || slug === USER_SLUG || roleBySlug(slug)) {
    const err = new Error('Un rôle porte déjà ce nom.');
    err.statusCode = 409;
    throw err;
  }

  const id = db
    .get()
    .prepare('INSERT INTO roles (slug, name, builtin) VALUES (?, ?, 0)')
    .run(slug, clean).lastInsertRowid;

  setRolePermissions(id, permissions);
  return listRoles().find((r) => r.id === id);
}

function slugify(name) {
  const base = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `role-${Date.now()}`;
}

/** Remplace intégralement les permissions d'un rôle. */
function setRolePermissions(roleId, permissions) {
  const role = roleById(roleId);
  if (!role) {
    const err = new Error('Rôle introuvable.');
    err.statusCode = 404;
    throw err;
  }
  if (role.slug === ADMIN_SLUG) {
    const err = new Error(
      'Le rôle « Administrateur » porte toutes les permissions : elles ne sont pas modifiables.'
    );
    err.statusCode = 400;
    throw err;
  }

  const wanted = (Array.isArray(permissions) ? permissions : []).filter(isValidPermission);

  db.transaction(() => {
    db.get().prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
    const insert = db
      .get()
      .prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const permission of wanted) insert.run(role.id, permission);
  })();

  return listRoles().find((r) => r.id === role.id);
}

/** Renomme un rôle personnalisé (les rôles intégrés gardent leur nom). */
function renameRole(roleId, name) {
  const role = roleById(roleId);
  if (!role) {
    const err = new Error('Rôle introuvable.');
    err.statusCode = 404;
    throw err;
  }
  if (role.builtin) {
    const err = new Error('Un rôle intégré ne peut pas être renommé.');
    err.statusCode = 400;
    throw err;
  }
  const clean = String(name || '').trim();
  if (clean.length < 2 || clean.length > 40) {
    const err = new Error('Le nom du rôle doit faire entre 2 et 40 caractères.');
    err.statusCode = 400;
    throw err;
  }
  db.get().prepare('UPDATE roles SET name = ? WHERE id = ?').run(clean, role.id);
  return listRoles().find((r) => r.id === role.id);
}

/**
 * Supprime un rôle personnalisé.
 * Un rôle encore attribué exige une réaffectation explicite : sans elle, on
 * refuse plutôt que de rétrograder des comptes en silence.
 */
function deleteRole(roleId, reassignToRoleId = null) {
  const role = roleById(roleId);
  if (!role) {
    const err = new Error('Rôle introuvable.');
    err.statusCode = 404;
    throw err;
  }
  if (role.builtin) {
    const err = new Error('Les rôles « Administrateur » et « Utilisateur » sont intégrés à crabe et ne peuvent pas être supprimés.');
    err.statusCode = 400;
    throw err;
  }

  const holders = db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?')
    .get(role.id).n;

  if (holders > 0) {
    const target = reassignToRoleId ? roleById(reassignToRoleId) : null;
    if (!target || target.id === role.id) {
      const err = new Error(
        `Ce rôle est encore attribué à ${holders} compte(s) : choisissez le rôle de remplacement avant de le supprimer.`
      );
      err.statusCode = 409;
      throw err;
    }
    db.transaction(() => {
      assignRoleToUsersOfRole(role.id, target);
      db.get().prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    })();
    return { deleted: true, reassigned: holders, to: target.slug };
  }

  db.get().prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  return { deleted: true, reassigned: 0 };
}

function assignRoleToUsersOfRole(fromRoleId, targetRole) {
  db.get()
    .prepare('UPDATE users SET role_id = ?, role = ? WHERE role_id = ?')
    .run(targetRole.id, targetRole.slug === ADMIN_SLUG ? 'admin' : 'user', fromRoleId);
}

/**
 * Attribue un rôle à un compte, en gardant `users.role` cohérent.
 * @returns {{roleId: number, role: 'admin'|'user', slug: string}}
 */
function assignRole(userId, roleId) {
  const role = roleById(roleId);
  if (!role) {
    const err = new Error('Rôle introuvable.');
    err.statusCode = 404;
    throw err;
  }
  const nature = role.slug === ADMIN_SLUG ? 'admin' : 'user';
  db.get()
    .prepare('UPDATE users SET role_id = ?, role = ? WHERE id = ?')
    .run(role.id, nature, Number(userId));
  return { roleId: role.id, role: nature, slug: role.slug };
}

/**
 * Ce compte est-il le dernier administrateur actif ?
 *
 * Garde-fou central : aucune opération (changement de rôle, désactivation,
 * révocation, suppression, suppression d'un rôle) ne doit pouvoir vider le
 * rôle administrateur — sinon plus personne ne peut administrer crabe.
 */
function isLastActiveAdmin(userId) {
  const others = db
    .get()
    .prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?"
    )
    .get(Number(userId));
  return others.n === 0;
}

/** Rôle par défaut d'un compte selon sa nature ('admin' | 'user'). */
function defaultRoleIdFor(nature) {
  const role = roleBySlug(nature === 'admin' ? ADMIN_SLUG : USER_SLUG);
  return role ? role.id : null;
}

module.exports = {
  PERMISSIONS,
  PERMISSION_IDS,
  BUILTIN_ROLES,
  ADMIN_SLUG,
  USER_SLUG,
  isValidPermission,
  seedBuiltinRoles,
  roleBySlug,
  roleById,
  permissionsForRole,
  permissionsForUser,
  userHas,
  hasAnyAdminPermission,
  listRoles,
  createRole,
  renameRole,
  setRolePermissions,
  deleteRole,
  assignRole,
  isLastActiveAdmin,
  defaultRoleIdFor,
  slugify,
};
