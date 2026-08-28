'use strict';

/**
 * Écrans d'administration (menu « Paramètres »), dans l'ordre :
 *
 *   Utilisateurs · Applications · Permissions · Automatisation · Stockage
 *   Sécurité (avec les logs de connexion) · Logs · Support · Système
 *
 * Chaque entrée de menu est masquée si le compte n'a pas la permission
 * correspondante — mais c'est le serveur qui refuse réellement (403) : voir
 * server/middleware.js:requirePermission.
 */

const admin = {
  users: [],
  apps: [],
  appUsers: [],
  categories: [],
  roles: [],
  permissions: [],
  matrixUsers: [],
  schedules: [],
  weekdays: [],
  /** Filtre « masquer les applications non actives », mémorisé par compte. */
  appsHideInactive: false,
  /** Onglet de la page Applications : « catalogue » ou « logos ». */
  appsTab: 'catalogue',
  /** Logos connus, tels que le serveur les décrit. */
  logos: [],
  /** Connecteur dont on est en train de choisir une image à la main. */
  logoUploadId: null,
  /** Connecteur dont la modale de dépannage est ouverte. */
  sessionModalId: null,
  /** Champ de connexion enregistrée de ce connecteur, tel que le serveur le décrit. */
  sessionField: null,
  /**
   * Destinations de stockage, telles que le serveur vient de les décrire.
   *
   * Gardées ici pour que les boutons de la carte n'aient à transporter QUE
   * l'identifiant : tout le reste — le nom affiché, la nature de la
   * destination — se relit dans cette liste. Voir `supprimerDestination`.
   */
  destinations: [],
  cronSelection: new Set(),
  logsTab: 'connecteurs',
  rolesTab: 'roles',
  usersTab: 'comptes',
  securityTab: 'connexion',
  templates: [],
  templateKey: null,
  supportFilter: 'all',
  /** Demandes chargées, pour retrier sans redemander au serveur. */
  tickets: [],
  supportCounts: {},
  accessModalId: null,
  supportSelected: null,
  currentPage: null,
};

/**
 * Les rythmes proposés, du plus fréquent au plus rare.
 *
 * « Tous les 3 mois » et « Tous les 6 mois » sont arrivés au lot 14 : beaucoup
 * de factures ne tombent pas tous les mois, et ouvrir un navigateur douze fois
 * par an pour zéro document est du bruit — chez le fournisseur comme dans les
 * journaux. Ils s'ancrent sur le mois de la première exécution, et le rythme
 * affiché nomme les mois retenus.
 *
 * « Désactivée » reste en dernier : c'est une suspension, pas un rythme.
 */
const FREQUENCIES = [
  ['daily', 'Quotidien'],
  ['weekly', 'Hebdomadaire'],
  ['monthly', 'Mensuel'],
  ['quarterly', 'Tous les 3 mois'],
  ['half-yearly', 'Tous les 6 mois'],
  ['disabled', 'Désactivée'],
];

/** Les fréquences qui se règlent par un jour du mois. */
const FREQUENCES_MENSUELLES = ['monthly', 'quarterly', 'half-yearly'];

// ⚠ Il y avait ici un `DEST_STYLE` : la couleur et la lettre des six
// destinations, écrites en dur, par identifiant. Depuis le lot 25 les clouds
// sont créés par l'utilisateur avec un identifiant tiré au sort — cette table
// n'aurait rien trouvé pour aucun d'eux. La couleur, la lettre et le logo
// descendent donc du serveur, avec chaque destination (`catalogue.brand()`).

/**
 * Les types de stockage que le rclone de CE serveur sait utiliser.
 *
 * Chargé une fois par affichage de l'écran Stockage, jamais écrit en dur : la
 * liste vient de `rclone config providers`, elle change avec le binaire.
 */
let ETAT_BACKENDS = { ok: false, types: [], erreur: null };

/** Les champs du type choisi dans « Autre stockage », par destination. */
const CHAMPS_TYPE = {};

/**
 * Les fournisseurs que « Ajouter un cloud » propose, tels que le SERVEUR les
 * décrit — libellé, couleur, et surtout : disponible ou non sur ce rclone-ci.
 * Jamais écrits ici : cette liste dépend du binaire installé, pas de crabe.
 */
let ETAT_FOURNISSEURS = [];

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/** Masque les entrées inaccessibles et affiche l'icône Paramètres si besoin. */
function prepareAdminMenu() {
  const items = [...document.querySelectorAll('#admin-sidebar .settings-nav-item')];
  let visible = 0;

  for (const item of items) {
    const permission = item.dataset.perm;
    // « Système » n'a pas de permission dédiée : visible dès qu'on a un accès.
    const allowed = permission ? can(permission) : state.me.permissions.length > 0;
    item.style.display = allowed ? '' : 'none';
    if (allowed) visible++;
  }

  if (visible) {
    $('tb-admin').style.display = 'flex';
    // Le menu mobile reprend les mêmes droits que la barre du haut.
    $('tb-mobile-admin').style.display = '';
  }
  refreshSupportBadge();
}

/** Ouvre la première page accessible du menu. */
function openAdmin() {
  const first = [...document.querySelectorAll('#admin-sidebar .settings-nav-item')].find(
    (item) => item.style.display !== 'none'
  );
  if (!first) return void showToast('Aucun écran d\'administration accessible avec votre rôle.');
  showAdminPage(first.dataset.apage, first);
}

function showAdminPage(name, el) {
  document.querySelectorAll('#view-admin .settings-nav-item[data-apage]').forEach((i) => i.classList.remove('active'));
  if (el) el.classList.add('active');
  // Sous 1024 px, le menu est un panneau glissant : il se referme dès qu'un
  // écran est choisi, et le bouton rappelle lequel.
  closeSettingsMenu();
  setSettingsMenuLabel('admin', navItemLabel(el));
  document.querySelectorAll('#view-admin .settings-page').forEach((p) => p.classList.remove('active'));
  $(`apage-${name}`).classList.add('active');
  admin.currentPage = name;

  const renderers = {
    users: renderUsersPage,
    apps: renderApps,
    roles: renderRoles,
    cron: loadCron,
    storage: renderAdminStorage,
    optimisation: renderOptimisation,
    securite: renderSecurityPage,
    smtp: renderSmtpPage,
    logs: renderLogs,
    support: renderSupport,
    systeme: renderSysteme,
  };

  Promise.resolve(renderers[name]?.()).catch((err) => showToast(err.message));
}

/** Pastille « demandes non lues » sur le menu Support et l'icône Paramètres. */
async function refreshSupportBadge() {
  if (!can('support.reply')) return;
  try {
    const { counts } = await api('/tickets?status=unread');
    admin.supportCounts = counts;
    const badge = $('nav-support-count');
    badge.textContent = counts.unread;
    badge.style.display = counts.unread ? 'inline-flex' : 'none';
    $('tb-admin-dot').style.display = counts.unread ? 'block' : 'none';
  } catch {
    /* pas de droit ou réseau : la pastille reste muette */
  }
}

/** Menu d'actions compact (remplace une rangée de six boutons). */
function actionsMenu(items) {
  return `<details class="row-menu">
    <summary title="Actions">···</summary>
    <div class="row-menu-items">
      ${items
        .filter(Boolean)
        .map(
          (item) =>
            `<button class="row-menu-item ${item.danger ? 'danger' : ''}"
                     ${item.disabled ? 'disabled title="' + esc(item.disabledReason || '') + '"' : ''}
                     onclick="${item.disabled ? '' : item.onClick}">${esc(item.label)}</button>`
        )
        .join('')}
    </div>
  </details>`;
}

/** Referme les menus ouverts quand on clique ailleurs. */
document.addEventListener('click', (event) => {
  document.querySelectorAll('details.row-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.removeAttribute('open');
  });
});

// ===========================================================================
// Utilisateurs (onglets : comptes · demandes de suppression · avatars)
// ===========================================================================

const USERS_TABS = ['comptes', 'suppressions', 'avatars'];

/** Entrée de la page : charge les trois onglets, affiche celui en cours. */
async function renderUsersPage() {
  // L'onglet Avatars écrit un réglage global : sans « Configurer la sécurité »,
  // il n'a rien à proposer.
  const avatarsAllowed = can('security.manage');
  $('users-tab-avatars-pill').style.display = avatarsAllowed ? '' : 'none';
  if (!avatarsAllowed && admin.usersTab === 'avatars') admin.usersTab = 'comptes';

  showUsersTab(admin.usersTab);
  await renderUsers();
  await renderDeletionRequests();
  if (avatarsAllowed) await renderAvatarSettings();
}

/** Affiche un onglet sans rien recharger (les trois sont déjà rendus). */
function showUsersTab(tab) {
  admin.usersTab = USERS_TABS.includes(tab) ? tab : 'comptes';
  for (const name of USERS_TABS) {
    $(`users-tab-${name}`).style.display = name === admin.usersTab ? '' : 'none';
  }
  document.querySelectorAll('#users-subnav .pill').forEach((pill, index) => {
    pill.classList.toggle('active', USERS_TABS[index] === admin.usersTab);
  });
}

function setUsersTab(tab, el) {
  showUsersTab(tab);
  if (el) {
    document.querySelectorAll('#users-subnav .pill').forEach((p) => p.classList.remove('active'));
    el.classList.add('active');
  }
}

async function renderUsers() {
  const { users } = await api('/users');
  admin.users = users;
  renderUsersList();
}

/** L'ordre alphabétique des identifiants : c'est ainsi qu'on cherche un compte. */
const USERS_TRI_DEFAUT = { key: 'username', dir: 'asc' };

/**
 * Le tri porte sur la DONNÉE, jamais sur son affichage.
 *
 * « Dernière connexion » se compare en millisecondes même écrite « il y a
 * 3 h » : trier la chaîne mettrait « il y a 3 h » avant « il y a 2 j », ce qui
 * est faux. Un compte jamais connecté n'a pas de date : il finit en bas, quel
 * que soit le sens (voir web/ui-prefs.js).
 */
const USERS_ACCES = {
  username: (u) => u.username,
  email: (u) => u.email || '',
  role: (u) => u.roleName || '',
  status: (u) => u.status,
  lastLogin: (u) => fmt.parse(u.lastLoginAt)?.getTime() || null,
  invoices: (u) => u.invoiceCount,
  connectors: (u) => u.connectorCount,
};

function usersSort() {
  return sortOf('users', USERS_TRI_DEFAUT);
}

function sortUsers(key) {
  const naturel = ['lastLogin', 'invoices', 'connectors'].includes(key) ? 'desc' : 'asc';
  setSort('users', uiPrefs.basculer(usersSort(), key, naturel));
  renderUsersList();
}

function setUsersView(mode) {
  setViewMode('users', mode);
  renderUsersList();
}

function renderUsersList() {
  renderViewToggle('users-view-switch', 'users', 'setUsersView');

  const query = ($('users-search').value || '').trim().toLowerCase();
  const tri = usersSort();
  // Le sélecteur de la barre d'outils et les en-têtes du tableau disent la
  // même chose : ils ne peuvent pas diverger.
  if ($('users-sort')) $('users-sort').value = tri.key;

  const rows = uiPrefs.trier(
    admin.users.filter(
      (u) =>
        !query ||
        u.username.toLowerCase().includes(query) ||
        (u.email || '').toLowerCase().includes(query) ||
        (u.roleName || '').toLowerCase().includes(query)
    ),
    tri,
    USERS_ACCES,
    (u) => u.username
  );

  const lastAdmin =
    admin.users.filter((u) => u.role === 'admin' && u.status === 'active').length <= 1;
  /** Le dernier administrateur actif ne doit pas pouvoir se saborder. */
  const seul = (u) => u.role === 'admin' && u.status === 'active' && lastAdmin;

  if (!rows.length) {
    $('users-list').innerHTML =
      '<div class="empty-state">Aucun compte ne correspond à cette recherche.</div>';
    return;
  }

  $('users-list').innerHTML =
    viewMode('users') === 'cards'
      ? `<div class="card-grid">${rows.map((u) => userCard(u, seul(u))).join('')}</div>`
      : usersTable(rows, seul);
}

/** Les badges d'état d'un compte, identiques en carte et en ligne. */
function userBadges(u) {
  return `
    <span class="badge-pill ${u.role === 'admin' ? 'blue' : 'gray'}">${esc(u.roleName)}</span>
    ${u.status === 'active'
      ? '<span class="badge-pill green">Actif</span>'
      : '<span class="badge-pill red">Désactivé</span>'}
    ${u.twoFactor?.enabled ? '<span class="badge-pill green">2FA</span>' : ''}
    ${u.home?.adminAllowed === false
      ? '<span class="badge-pill gray" title="Ce compte ne peut plus modifier la disposition de son accueil.">Accueil verrouillé</span>'
      : ''}`;
}

/** Les mêmes gestes en carte et en ligne : un seul endroit à corriger. */
function userActions(u, isLastAdmin) {
  return actionsMenu([
    { label: 'Éditer', onClick: `openEditUserModal(${u.id})` },
    {
      label: u.home?.adminAllowed
        ? 'Interdire la personnalisation de l\'accueil'
        : 'Autoriser la personnalisation de l\'accueil',
      onClick: `toggleHomeCustomization(${u.id})`,
    },
    {
      label: u.status === 'active' ? 'Désactiver' : 'Réactiver',
      onClick: `toggleUserStatus(${u.id})`,
      disabled: isLastAdmin,
      disabledReason: 'Dernier administrateur actif',
    },
    {
      label: 'Révoquer les sessions',
      onClick: `revokeUser(${u.id})`,
      disabled: isLastAdmin,
      disabledReason: 'Dernier administrateur actif',
    },
    { label: 'Réinitialiser la 2FA', onClick: `resetUser2fa(${u.id})` },
    { label: 'Export RGPD', onClick: `exportUser(${u.id})` },
    {
      label: 'Supprimer',
      onClick: `deleteUser(${u.id})`,
      danger: true,
      disabled: isLastAdmin,
      disabledReason: 'Dernier administrateur actif',
    },
  ]);
}

function userCard(u, isLastAdmin) {
  return `
  <div class="app-card user-card">
    <div class="app-card-head">
      ${avatarHtml(u, { size: 42 })}
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(u.username)}</div>
        <div class="app-card-sub">${esc(u.email || 'aucune adresse')}</div>
      </div>
      ${userActions(u, isLastAdmin)}
    </div>
    <div class="user-card-badges">${userBadges(u)}</div>
    <div class="app-card-facts">
      <div><span class="fact-label">Connecteurs</span>
        <span class="fact-value">${u.connectorCount}</span></div>
      <div><span class="fact-label">Factures</span>
        <span class="fact-value">${u.invoiceCount}</span></div>
      <div><span class="fact-label">Dernière connexion</span>
        <span class="fact-value">${relativeCell(u.lastLoginAt, 'jamais connecté')}</span></div>
    </div>
  </div>`;
}

function usersTable(rows, seul) {
  const tri = usersSort();
  const th = (key, label) =>
    uiPrefs.enTeteTriable({ tri, key, label, onclick: `sortUsers('${key}')` });

  return `<table class="data-table wide">
    <thead><tr>
      ${th('username', 'Identifiant')}${th('email', 'Adresse')}${th('role', 'Rôle')}
      ${th('status', 'Statut')}${th('connectors', 'Connecteurs')}${th('invoices', 'Factures')}
      ${th('lastLogin', 'Dernière connexion')}<th></th>
    </tr></thead>
    <tbody>
    ${rows
      .map(
        (u) => `
      <tr>
        <td data-label="Identifiant" style="color:var(--text);">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            ${avatarHtml(u, { size: 26 })}
            <span class="cell-ellipsis">${esc(u.username)}</span>
          </div>
        </td>
        <td data-label="Adresse"><span class="cell-ellipsis">${esc(u.email || 'aucune adresse')}</span></td>
        <td data-label="Rôle"><span class="badge-pill ${u.role === 'admin' ? 'blue' : 'gray'}">${esc(u.roleName)}</span></td>
        <td data-label="Statut">
          ${u.status === 'active'
            ? '<span class="badge-pill green">Actif</span>'
            : '<span class="badge-pill red">Désactivé</span>'}
          ${u.twoFactor?.enabled ? '<span class="badge-pill green">2FA</span>' : ''}
        </td>
        <td data-label="Connecteurs">${u.connectorCount}</td>
        <td data-label="Factures">${u.invoiceCount}</td>
        <td data-label="Dernière connexion">${relativeCell(u.lastLoginAt, 'jamais connecté')}</td>
        <td class="actions">${userActions(u, seul(u))}</td>
      </tr>`
      )
      .join('')}
    </tbody>
  </table>`;
}

/**
 * Verrou administrateur de l'accueil, compte par compte.
 *
 * Retiré, l'utilisateur ne peut plus rien modifier NI se réautoriser : c'est
 * la différence avec « Figer mon accueil », que l'utilisateur pose et retire
 * lui-même depuis son profil. Le serveur applique réellement le refus (403).
 */
async function toggleHomeCustomization(id) {
  const user = admin.users.find((u) => u.id === id);
  if (!user) return;
  const allow = !(user.home?.adminAllowed ?? true);
  try {
    await api(`/users/${id}`, { method: 'PATCH', body: { homeCustomizable: allow } });
    showToast(
      allow
        ? `${user.username} peut de nouveau personnaliser son accueil`
        : `${user.username} ne peut plus modifier son accueil`
    );
    await renderUsers();
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * « Appliquer cette disposition à tous les utilisateurs » : recopie l'accueil
 * de l'administrateur connecté sur tous les autres comptes. Complément
 * naturel du verrou — sans lui, chacun resterait figé sur SA disposition.
 */
async function applyHomeLayoutToAll() {
  if (
    !confirm(
      'Appliquer VOTRE disposition d\'accueil (ordre, blocs affichés, largeurs) à tous les ' +
        'autres comptes ? Leur disposition actuelle sera remplacée.'
    )
  ) {
    return;
  }
  try {
    const result = await api('/users/home-layout/apply-to-all', { method: 'POST' });
    showToast(`Disposition appliquée à ${result.applied} compte(s)`);
  } catch (err) {
    showToast(err.message);
  }
}

async function toggleUserStatus(id) {
  const user = admin.users.find((u) => u.id === id);
  try {
    await api(`/users/${id}`, {
      method: 'PATCH',
      body: { status: user.status === 'active' ? 'inactive' : 'active' },
    });
    showToast(`${user.username} ${user.status === 'active' ? 'désactivé' : 'réactivé'}`);
    await renderUsers();
  } catch (err) {
    showToast(err.message);
  }
}

async function revokeUser(id) {
  const user = admin.users.find((u) => u.id === id);
  if (!confirm(`Révoquer l'accès de ${user.username} ? Ses sessions seront fermées immédiatement.`)) return;
  try {
    const result = await api(`/users/${id}/revoke`, { method: 'POST' });
    showToast(`${user.username} révoqué — ${result.sessionsClosed} session(s) fermée(s)`);
    await renderUsers();
  } catch (err) {
    showToast(err.message);
  }
}

async function resetUser2fa(id) {
  const user = admin.users.find((u) => u.id === id);
  if (
    !confirm(
      `Réinitialiser la double authentification de ${user.username} ?\n\n` +
        'Le compte pourra se reconnecter avec son seul mot de passe. À utiliser pour ' +
        'dépanner un utilisateur enfermé dehors (téléphone perdu).'
    )
  ) {
    return;
  }
  try {
    const result = await api(`/users/${id}/2fa/reset`, { method: 'POST' });
    showToast(result.message);
    await renderUsers();
  } catch (err) {
    showToast(err.message);
  }
}

function exportUser(id) {
  const user = admin.users.find((u) => u.id === id);
  showToast(`Génération de l'export RGPD de ${user.username}…`);
  window.location.href = `/api/users/${id}/export`;
}

async function deleteUser(id) {
  const user = admin.users.find((u) => u.id === id);
  if (!confirm(`Supprimer définitivement ${user.username} et toutes ses données ? Cette action est irréversible.`)) return;
  try {
    await api(`/users/${id}`, { method: 'DELETE' });
    await renderUsers();
    await renderDeletionRequests();
    showToast(`${user.username} supprimé`);
  } catch (err) {
    showToast(err.message);
  }
}

function roleOptions(selectedId) {
  return admin.roles.length
    ? admin.roles
        .map(
          (r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${esc(r.name)}</option>`
        )
        .join('')
    : '<option value="">(rôles indisponibles)</option>';
}

async function ensureRoles() {
  if (admin.roles.length || !can('roles.manage')) return;
  const data = await api('/admin/roles');
  admin.roles = data.roles;
  admin.permissions = data.permissions;
  admin.matrixUsers = data.users;
}

async function openNewUserModal() {
  await ensureRoles().catch(() => {});
  openGenericModal({
    title: 'Ajouter un utilisateur',
    sub: state.policy.passwordRules,
    body: `
      <div class="field"><label>Identifiant</label><input type="text" id="nu-username" autocomplete="off"></div>
      <div class="field"><label>E-mail</label><input type="text" id="nu-email" autocomplete="off"></div>
      <div class="field"><label>Téléphone</label><input type="text" id="nu-phone" autocomplete="off"></div>
      <div class="field"><label>Rôle</label>
        ${
          admin.roles.length
            ? `<select id="nu-role-id">${roleOptions(admin.roles.find((r) => r.slug === 'user')?.id)}</select>`
            : `<select id="nu-role"><option value="user">Utilisateur</option><option value="admin">Administrateur</option></select>`
        }
      </div>
      <div class="field"><label>Mot de passe</label><input type="password" id="nu-password" autocomplete="new-password"></div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Créer',
        class: 'btn-test',
        onClick: async () => {
          const body = {
            username: $('nu-username').value.trim(),
            email: $('nu-email').value.trim(),
            phone: $('nu-phone').value.trim(),
            password: $('nu-password').value,
          };
          if ($('nu-role-id')) body.roleId = Number($('nu-role-id').value);
          else body.role = $('nu-role').value;

          try {
            await api('/users', { method: 'POST', body });
            closeGenericModal();
            await renderUsers();
            showToast('Utilisateur créé');
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

async function openEditUserModal(id) {
  const user = admin.users.find((u) => u.id === id);
  await ensureRoles().catch(() => {});

  openGenericModal({
    title: `Éditer ${user.username}`,
    sub: 'Laisser le mot de passe vide pour ne pas le changer.',
    body: `
      <div class="field">
        <label>E-mail</label>
        <input type="text" id="eu-email" value="${esc(user.email)}">
        <div class="field-help">
          Modifier l'adresse ici l'applique immédiatement, sans confirmation : c'est la
          porte de secours quand le SMTP n'est pas disponible.
        </div>
      </div>
      <div class="field"><label>Téléphone</label><input type="text" id="eu-phone" value="${esc(user.phone)}"></div>
      <div class="field"><label>Rôle</label>
        ${
          admin.roles.length
            ? `<select id="eu-role-id">${roleOptions(user.roleId)}</select>`
            : `<select id="eu-role">
                 <option value="user" ${user.role === 'user' ? 'selected' : ''}>Utilisateur</option>
                 <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrateur</option>
               </select>`
        }
      </div>
      <div class="field"><label>Nouveau mot de passe</label><input type="password" id="eu-password" autocomplete="new-password"></div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Enregistrer',
        class: 'btn-test',
        onClick: async () => {
          const body = {
            email: $('eu-email').value.trim(),
            phone: $('eu-phone').value.trim(),
          };
          if ($('eu-role-id')) body.roleId = Number($('eu-role-id').value);
          else body.role = $('eu-role').value;
          if ($('eu-password').value) body.password = $('eu-password').value;

          try {
            await api(`/users/${id}`, { method: 'PATCH', body });
            closeGenericModal();
            await renderUsers();
            showToast('Utilisateur mis à jour');
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

async function renderDeletionRequests() {
  const { requests } = await api('/users/deletion/requests');
  const el = $('deletion-requests');

  // Pastille sur l'onglet : une demande de suppression ne doit pas dormir dans
  // un onglet qu'on n'ouvre jamais.
  const badge = $('users-deletion-count');
  badge.textContent = requests.length;
  badge.style.display = requests.length ? 'inline-flex' : 'none';

  if (!requests.length) {
    el.innerHTML = '<div class="empty-state">Aucune demande en cours.</div>';
    return;
  }

  el.innerHTML = requests
    .map(
      (r) => `
    <div class="installed-row">
      <div class="ir-main">
        <div class="ir-name">${esc(r.username)}</div>
        <div class="ir-meta">
          Demande du ${esc(fmt.date(r.requestedAt))} · export ${r.wantsExport ? 'demandé' : 'non demandé'}${r.exportSent ? ' · zip généré' : ''}${
            r.revoked ? ` · accès révoqué · suppression définitive le ${esc(fmt.date(r.scheduledDeleteAt))}` : ''
          }
        </div>
      </div>
      <div class="ir-actions">
        ${r.wantsExport && !r.exportSent ? `<button class="icon-btn" onclick="sendExportZip(${r.userId})">Envoyer le zip</button>` : ''}
        ${
          !r.revoked
            ? `<button class="icon-btn" onclick="revokeForDeletion(${r.userId})">Révoquer l'accès</button>`
            : `<button class="icon-btn" onclick="finalizeDeletion(${r.userId})">Supprimer définitivement</button>`
        }
      </div>
    </div>`
    )
    .join('');
}

async function sendExportZip(userId) {
  try {
    const result = await api(`/users/deletion/requests/${userId}/export`, { method: 'POST' });
    await renderDeletionRequests();
    showToast(`Archive générée : ${result.files} fichier(s), ${fmt.bytes(result.bytes)}`);
  } catch (err) {
    showToast(err.message);
  }
}

async function revokeForDeletion(userId) {
  if (!confirm("Révoquer l'accès de ce compte ? Ses connecteurs seront désactivés immédiatement.")) return;
  try {
    const result = await api(`/users/deletion/requests/${userId}/revoke`, { method: 'POST' });
    await renderDeletionRequests();
    await renderUsers();
    showToast(`Accès révoqué — suppression définitive le ${fmt.date(result.scheduledDeleteAt)}`);
  } catch (err) {
    showToast(err.message);
  }
}

async function finalizeDeletion(userId) {
  if (!confirm('Supprimer définitivement ce compte et toutes ses données ?')) return;
  try {
    const result = await api(`/users/deletion/requests/${userId}/finalize`, { method: 'POST' });
    await renderDeletionRequests();
    await renderUsers();
    showToast(`${result.username} définitivement supprimé`);
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Onglet « Avatars » — Gravatar
//
// Le réglage vivait dans Sécurité ; il concerne l'affichage des comptes, sa
// place est ici. La justification reste affichée en toutes lettres : c'est le
// seul point de crabe qui parle à un service tiers.
// ---------------------------------------------------------------------------

async function renderAvatarSettings() {
  const data = await api('/system/settings');
  const enabled = !!data.settings.gravatarEnabled;

  $('users-avatars-content').innerHTML = `
    <div class="sec-section">
      <div class="sec-section-title">
        Autoriser Gravatar
        <div class="toggle ${enabled ? 'on' : ''}" style="margin-left:auto;"
             onclick="toggleGravatar(${!enabled})"><div class="knob"></div></div>
      </div>
      <div class="sec-section-sub">${esc(data.gravatarNotice)}</div>
      <div class="inline-note" style="max-width:660px;">
        ${
          enabled
            ? 'Activé : le navigateur de chaque utilisateur demande l\'image à gravatar.com. ' +
              'Le serveur crabe, lui, ne sort jamais du LAN.'
            : 'Désactivé (défaut) : les comptes sont illustrés par leurs initiales sur un ' +
              'fond coloré, et aucune requête ne quitte le réseau local.'
        }
      </div>
    </div>`;
}

async function toggleGravatar(enabled) {
  try {
    await api('/system/settings', { method: 'PUT', body: { gravatarEnabled: enabled } });
  } catch (err) {
    return void showToast(err.message);
  }
  // Le réglage change l'affichage des avatars : on recharge la session.
  const session = await api('/auth/me');
  state.me = session.user;
  fmt.configure(session.settings);
  applyAvatar();
  await renderAvatarSettings();
  showToast(enabled ? 'Gravatar autorisé' : 'Gravatar désactivé — aucune requête sortante');
}

// ===========================================================================
// Applications
// ===========================================================================

async function renderApps() {
  const data = await api('/admin/connectors');
  admin.apps = data.connectors;
  admin.appUsers = data.users || [];
  admin.categories = data.categories;

  // Le filtre est mémorisé sur le COMPTE, pas dans le navigateur : un
  // administrateur le retrouve d'un poste à l'autre.
  try {
    const { preferences } = await api('/users/me/preferences');
    admin.appsHideInactive = !!preferences['apps.hideInactive'];
  } catch {
    /* préférence indisponible : le filtre part simplement décoché */
  }
  $('apps-hide-inactive').checked = admin.appsHideInactive;

  const attente = data.pendingCount
    ? `${data.pendingCount} candidature(s) en attente de test avant mise à disposition dans le Store.`
    : 'Aucune candidature en attente. Toutes les applications testées sont disponibles dans le Store.';
  // Les services annoncés se comptent à part : ce ne sont pas des candidatures
  // qui attendent un test, mais des fiches qui attendent un connecteur.
  $('apps-pending-note').textContent = data.plannedCount
    ? `${attente} ${data.plannedCount} service(s) annoncé(s) attendent leur connecteur : `
      + 'ils apparaissent dans le Store, mais ne s\'installent pas.'
    : attente;

  const select = $('apps-category');
  if (select.options.length <= 1) {
    select.innerHTML =
      '<option value="all">Toutes</option>' +
      data.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  }

  marquerBascule('apps');
  renderAppsList();
}

/**
 * Bascule cartes / liste.
 *
 * Depuis le lot 10, la préférence vit sur le COMPTE et non plus dans
 * `localStorage` : un administrateur retrouve son mode d'un poste à l'autre,
 * comme tous les autres écrans à bascule.
 */
function setAppsView(view) {
  setViewMode('apps', view);
  marquerBascule('apps');
  renderAppsList();
}

/** Allume le bon bouton d'une bascule dont le HTML est écrit dans app.html. */
function marquerBascule(screen) {
  const mode = viewMode(screen);
  $(`${screen}-view-cards`)?.classList.toggle('active', mode === 'cards');
  $(`${screen}-view-list`)?.classList.toggle('active', mode === 'list');
}

/**
 * Applications retenues par la recherche et les filtres.
 *
 * Le filtre « masquer les applications non actives » S'AJOUTE aux autres, il
 * ne les remplace pas : recherche, catégorie et statut continuent de
 * s'appliquer par-dessus.
 *
 * « Active » vient du serveur : installée par au moins un compte, ou mise à
 * disposition explicitement dans le Store. Les treize connecteurs livrés avec
 * crabe ne le sont pas d'office — c'est bien le but.
 */
function filteredApps() {
  const query = ($('apps-search').value || '').trim().toLowerCase();
  const category = $('apps-category').value || 'all';
  const status = $('apps-status').value || 'all';

  return admin.apps.filter((c) => {
    if (admin.appsHideInactive && !c.active) return false;
    if (query && !c.name.toLowerCase().includes(query) && !c.id.includes(query)) return false;
    if (category !== 'all' && c.category !== category) return false;
    if (status === 'available' && (c.planned || c.maintenance || c.catalogStatus === 'pending')) {
      return false;
    }
    if (status === 'maintenance' && !c.maintenance) return false;
    if (status === 'pending' && c.catalogStatus !== 'pending') return false;
    if (status === 'planned' && !c.planned) return false;
    return true;
  });
}

/** Ce que le filtre « non actives » écarte, à lui seul. */
function hiddenInactiveCount() {
  if (!admin.appsHideInactive) return 0;
  return admin.apps.filter((c) => !c.active).length;
}

/** Active ou désactive le filtre, et le mémorise sur le compte. */
async function setAppsHideInactive(hide) {
  admin.appsHideInactive = !!hide;
  $('apps-hide-inactive').checked = admin.appsHideInactive;
  renderAppsList();
  try {
    await api('/users/me/preferences', {
      method: 'PUT',
      body: { preferences: { 'apps.hideInactive': admin.appsHideInactive } },
    });
  } catch (err) {
    showToast(`Filtre non mémorisé — ${err.message}`);
  }
}

/** Raccourci du compteur : réafficher tout le catalogue. */
function showAllApps() {
  setAppsHideInactive(false);
}

function appStatusBadge(c) {
  // Annoncé d'abord : c'est l'état le plus fort. Un service sans connecteur
  // n'est ni « disponible » ni « en maintenance » — il n'existe pas encore.
  // Et une annonce dont l'empêchement est mesuré (lot 36) ne promet plus.
  if (c.planned && (c.unfeasible || '').trim()) {
    return '<span class="badge-pill red">Pas possible aujourd\'hui</span>';
  }
  if (c.planned) return '<span class="badge-pill gray">Bientôt disponible</span>';
  if (c.catalogStatus === 'pending') return '<span class="badge-pill amber">En attente de test</span>';
  if (c.maintenance) return '<span class="badge-pill red">Maintenance</span>';
  return '<span class="badge-pill green">Disponible</span>';
}

function appCategorySelect(c) {
  return `<select onchange="moveAppCategory('${esc(c.id)}', this.value)">
    ${admin.categories
      .map(
        (cat) =>
          `<option value="${esc(cat.id)}" ${c.category === cat.id ? 'selected' : ''}>${esc(cat.label)}</option>`
      )
      .join('')}
  </select>`;
}

function appAccessLabel(c) {
  return c.allowedUsers === 'all'
    ? 'Tous les utilisateurs'
    : `${c.allowedUsers.length} utilisateur(s)`;
}

/** Actions communes aux deux vues : même ordre, mêmes libellés. */
function appActions(c) {
  // Un service annoncé n'a pas de code : rien à tester, rien à dépanner, et
  // aucune candidature à approuver ou rejeter. Reste ce qui porte sur la
  // FICHE — sa catégorie, et à qui elle est montrée.
  if (c.planned) {
    return `<button class="btn-mini" onclick="openAccessModal('${esc(c.id)}')">Gérer l'accès</button>`;
  }

  return `
    <button class="btn-mini" onclick="testApp('${esc(c.id)}', this)">Tester</button>
    <button class="btn-mini" onclick="openAccessModal('${esc(c.id)}')">Gérer l'accès</button>
    ${usesSession(c) ? `<button class="btn-mini" onclick="openSessionModal('${esc(c.id)}')">Dépannage</button>` : ''}
    ${
      c.catalogStatus === 'pending'
        ? `<button class="btn-mini" onclick="approveApp('${esc(c.id)}')">Approuver</button>
           <button class="btn-mini danger" onclick="rejectApp('${esc(c.id)}')">Rejeter</button>`
        : `<button class="btn-mini danger" onclick="rejectApp('${esc(c.id)}')">Retirer du Store</button>`
    }`;
}

function renderAppsList() {
  const items = uiPrefs.trier(filteredApps(), appsSort(), APPS_ACCES, (c) => c.name);
  const masquees = hiddenInactiveCount();

  // Compteur discret : ce qui est caché doit rester dicible, et réversible en
  // un clic. Un filtre silencieux se fait oublier et on croit à un bug.
  const note = masquees
    ? `<div class="toolbar-note" style="margin-bottom:12px;">
         ${masquees} application(s) non active(s) masquée(s) —
         <button class="link-btn" onclick="showAllApps()">tout afficher</button>
       </div>`
    : '';

  if (!items.length) {
    $('apps-list').innerHTML =
      note + '<div class="empty-state">Aucune application ne correspond à ces filtres.</div>';
    return;
  }

  $('apps-list').innerHTML =
    note +
    (viewMode('apps') === 'list'
      ? appsTable(items)
      : `<div class="card-grid">${items.map(appCard).join('')}</div>`);
}

/**
 * ─── Le signalement d'un logo absent a quitté cet écran (lot 14, §10) ────────
 *
 * Le lot 10 posait ici un liseré rouge et un badge « logo manquant ». Le lot 13
 * les a retirés du Store ; ils sont restés sur CET écran-là, et ils y étaient
 * encore en production sur OVH, Scaleway, Aagaard et Propolia.
 *
 * Un liseré rouge annonce une panne. Une application sans logo n'en est pas
 * une : elle affiche ses initiales, ce qui est un état parfaitement normal, et
 * cet écran-ci sert à gérer les catégories, les accès et la maintenance — pas
 * les images. Le signalement vit désormais à un seul endroit, celui où il sert
 * et où le bouton « Récupérer » est juste à côté : **Paramètres → Applications
 * → Logos** (voir `logoRaisonManque` plus bas).
 */
function appCard(c) {
  return `
  <div class="app-card">
    <div class="app-card-head">
      <div class="badge-logo" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(c.name)}</div>
        <div class="app-card-sub">${esc(c.planned ? 'annoncé' : c.implementation)} · ${esc(c.site || 'aucun site')}</div>
      </div>
      ${appStatusBadge(c)}
    </div>

    ${appDescription(c)}

    <div class="app-card-facts">
      <div><span class="fact-label">Catégorie</span>${appCategorySelect(c)}</div>
      <div><span class="fact-label">Accès</span>
        <span class="fact-value">${esc(appAccessLabel(c))}</span>
      </div>
      <div><span class="fact-label">Installations</span>
        <span class="fact-value">${c.installCount} compte(s)</span>
      </div>
      <div><span class="fact-label">Maintenance</span>
        <div class="toggle ${c.maintenance ? 'on' : ''}" onclick="toggleMaintenance('${esc(c.id)}')"><div class="knob"></div></div>
      </div>
    </div>

    <div class="app-card-actions">${appActions(c)}</div>
  </div>`;
}

/**
 * Les deux textes d'un connecteur, et la frontière entre eux.
 *
 * `description` est la phrase que voit l'utilisateur, une et une seule.
 * `technicalNote` porte tout le reste — méthode d'accès, particularité du
 * portail, date de validation du parcours, état d'avancement — et **ne sort
 * jamais d'ici** : le serveur la retire de tout ce qu'il envoie à un compte
 * ordinaire (voir manifest-schema.publicView).
 *
 * C'est cet écran, et lui seul, qui a besoin de savoir comment ça marche.
 */
function appDescription(c) {
  const phrase = c.description
    ? `<div class="app-card-desc">${esc(c.description)}</div>`
    : '';
  const technique = c.technicalNote
    ? `<details class="app-tech">
         <summary>Note technique</summary>
         <div class="app-tech-body">${esc(c.technicalNote)}</div>
       </details>`
    : '';
  return phrase || technique ? `<div class="app-card-texts">${phrase}${technique}</div>` : '';
}

/** Un catalogue : l'ordre alphabétique, comme on le cherche. */
const APPS_TRI_DEFAUT = { key: 'name', dir: 'asc' };

/** Le tri porte sur la donnée : `installCount` est un nombre, pas « 3 compte(s) ». */
const APPS_ACCES = {
  name: (c) => c.name,
  category: (c) => c.categoryLabel || c.category || '',
  status: (c) => (c.planned ? 'd' : c.catalogStatus === 'pending' ? 'b' : c.maintenance ? 'c' : 'a'),
  access: (c) => (c.allowedUsers === 'all' ? -1 : c.allowedUsers.length),
  installCount: (c) => c.installCount,
  maintenance: (c) => !!c.maintenance,
};

function appsSort() {
  return sortOf('apps', APPS_TRI_DEFAUT);
}

function sortApps(key) {
  const naturel = ['installCount'].includes(key) ? 'desc' : 'asc';
  setSort('apps', uiPrefs.basculer(appsSort(), key, naturel));
  renderAppsList();
}

function appsTable(items) {
  const tri = appsSort();
  const th = (key, label) =>
    uiPrefs.enTeteTriable({ tri, key, label, onclick: `sortApps('${key}')` });

  // `data-label` sur chaque cellule : sous 768 px, le tableau devient une
  // pile de cartes « libellé : valeur » (voir style.css, lot 3).
  return `<table class="data-table wide">
    <thead>
      <tr>
        ${th('name', 'Application')}${th('category', 'Catégorie')}${th('status', 'Statut')}
        ${th('access', 'Accès')}${th('installCount', 'Installations')}
        ${th('maintenance', 'Maintenance')}<th></th>
      </tr>
    </thead>
    <tbody>
    ${items
      .map(
        (c) => `
      <tr>
        <td data-label="Application" style="color:var(--text);">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span class="badge-logo" style="width:22px;height:22px;font-size:8px;flex-shrink:0;background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</span>
            <span class="cell-ellipsis" title="${esc(c.description || c.site || 'aucun site')}">${esc(c.name)}</span>
          </div>
        </td>
        <td data-label="Catégorie">${appCategorySelect(c)}</td>
        <td data-label="Statut">${appStatusBadge(c)}</td>
        <td data-label="Accès">${esc(appAccessLabel(c))}</td>
        <td data-label="Installations">${c.installCount} compte(s)</td>
        <td data-label="Maintenance">
          <div class="toggle ${c.maintenance ? 'on' : ''}" onclick="toggleMaintenance('${esc(c.id)}')"><div class="knob"></div></div>
        </td>
        <td class="actions">${appActions(c)}</td>
      </tr>`
      )
      .join('')}
    </tbody>
  </table>`;
}

// ===========================================================================
// Applications → Logos
//
// Les vrais logos des services, à la place des pastilles à initiales. Trois
// règles gouvernent cet écran, et elles sont toutes défensives :
//
//   - le logo vient du SITE DU FOURNISSEUR, jamais d'un agrégateur. Demander à
//     un tiers le logo d'EDF, c'est lui annoncer que l'utilisateur a un compte
//     EDF — et, service après service, lui livrer la maison entière ;
//   - **aucune récupération automatique** : ni au démarrage, ni à
//     l'installation d'un connecteur, ni à l'affichage d'un écran. Tout part
//     d'un clic, ici ;
//   - une image envoyée à la main n'est JAMAIS écrasée par une
//     resynchronisation. C'est le dernier mot de quelqu'un qui a regardé le
//     résultat, et une cascade n'a pas à revenir dessus.
//
// La progression d'une récupération groupée est bâtie ici, connecteur par
// connecteur : plus simple qu'un flux d'événements côté serveur, ça donne une
// raison lisible par échec, et ça permet d'arrêter net.
// ===========================================================================

function setAppsTab(tab) {
  admin.appsTab = tab;
  for (const nom of ['catalogue', 'logos', 'diagnostic']) {
    $(`apps-tab-${nom}`)?.classList.toggle('active', tab === nom);
    const pane = $(`apps-pane-${nom}`);
    if (pane) pane.style.display = tab === nom ? 'block' : 'none';
  }
  if (tab === 'logos') renderLogos();
  if (tab === 'diagnostic') renderDiagnosticPane();
}

// ===========================================================================
// Diagnostic (lot 14, §4)
//
// ─── Ce que cet écran remplace ──────────────────────────────────────────────
//
// Un aller-retour complet avec l'utilisateur à chaque échec, pour deviner ce que voyait
// le navigateur : « qu'est-ce qui s'affiche ? », « peux-tu copier la page ? »,
// « y a-t-il un lien Facture ? ». Le lot 13 a passé une session entière à ça.
//
// Désormais, chaque échec garde la page. Cet écran la rend téléchargeable, et
// il est le SEUL endroit d'où elle sort — un compte ordinaire n'y accède pas.
//
// ─── Pourquoi on peut la transmettre sans la relire ─────────────────────────
//
// Les mots de passe et les jetons sont masqués dans le HTML avant écriture, et
// le contexte ne porte que les NOMS des cookies (voir server/diagnostics.js).
// Une archive qu'il faudrait relire ligne à ligne avant de l'envoyer ne serait
// pas envoyée.
// ===========================================================================

/** Le sélecteur de service, puis la liste du service choisi. */
async function renderDiagnosticPane() {
  const select = $('diag-connector');
  if (!select) return;

  // Le catalogue est déjà en mémoire : on ne redemande rien au serveur pour
  // remplir un menu déroulant.
  const services = trierParNom((admin.apps || []).filter((c) => !c.planned));

  const choisi = select.value || services[0]?.id || '';
  select.innerHTML = services
    .map((c) => `<option value="${esc(c.id)}" ${c.id === choisi ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');

  await renderDiagnostics();
}

async function renderDiagnostics() {
  const id = $('diag-connector')?.value;
  const zone = $('diag-list');
  if (!id || !zone) return;

  zone.innerHTML = '<div class="empty-state">Lecture…</div>';
  let data;
  try {
    data = await api(`/admin/connectors/${id}/diagnostics`);
  } catch (err) {
    zone.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    return;
  }

  $('diag-note').textContent =
    'crabe enregistre la page à chaque échec : connexion non confirmée, fenêtre du site qui '
    + 'recouvre le formulaire, ou commandes visibles sans aucune facture reconnue. '
    + `Les ${data.limits.maxParConnecteur} derniers par service sont conservés, `
    + `${data.limits.maxJours} jours au plus. Aucun mot de passe, aucune valeur de cookie et `
    + 'aucun jeton n\'y figurent : ces archives peuvent être transmises telles quelles.';

  if (!data.diagnostics.length) {
    zone.innerHTML =
      `<div class="empty-state">Aucun diagnostic pour ${esc(data.connector.name)} — `
      + 'ce service n\'a pas échoué depuis la mise à jour.</div>';
    return;
  }

  zone.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px;">
      <button class="btn-ghost" onclick="clearDiagnostics('${esc(id)}')">
        Effacer les ${data.diagnostics.length} diagnostic(s) de ${esc(data.connector.name)}
      </button>
    </div>
    ${data.diagnostics.map((d) => diagnosticRow(id, d, data.fichiers)).join('')}`;
}

function diagnosticRow(connectorId, d, attendus) {
  // Les fichiers ABSENTS sont dits, pas tus : une page morte ne rend ni
  // capture ni HTML, et c'est déjà une information sur ce qui s'est passé.
  const manquants = attendus.filter((f) => !d.fichiers.includes(f));

  return `
  <div class="app-card">
    <div class="app-card-head">
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(d.at ? fmt.exact(d.at) : d.id)}</div>
        <div class="app-card-sub">
          ${d.fichiers.length} fichier(s) · ${esc(fmt.bytes(d.octets))}
          ${manquants.length ? ` · non capturé(s) : ${esc(manquants.join(', '))}` : ''}
        </div>
      </div>
      <a class="btn-secondary"
         href="/api/admin/connectors/${esc(connectorId)}/diagnostics/${esc(d.id)}/archive"
         download>Télécharger l'archive</a>
    </div>
  </div>`;
}

async function clearDiagnostics(connectorId) {
  if (!confirm('Effacer tous les diagnostics de ce service ?')) return;
  try {
    const res = await api(`/admin/connectors/${connectorId}/diagnostics`, { method: 'DELETE' });
    showToast(`${res.removed} diagnostic(s) effacé(s)`);
    await renderDiagnostics();
  } catch (err) {
    showToast(err.message);
  }
}

async function renderLogos() {
  const data = await api('/admin/connectors/logos');
  admin.logos = data.connectors;

  const manquants = admin.logos.filter((c) => !c.logo).length;
  $('logos-note').textContent =
    `${admin.logos.length - manquants} logo(s) en place, ${manquants} manquant(s). `
    + 'Applications et destinations de stockage suivent le même chemin. '
    + 'Chaque logo est récupéré sur le site du fournisseur lui-même, jamais chez un tiers, '
    + `puis servi par crabe : ${data.limits.maxBytes / 1024} Ko au plus, formats PNG, JPEG, `
    + 'SVG, ICO ou WebP. Au moindre doute, la pastille à initiales est conservée.';

  renderLogosList();
}

/**
 * Deux groupes sur le même écran : les applications, puis les destinations.
 *
 * Le lot 9 ajoute les destinations de stockage — le stockage local, et depuis le lot 25
 * les clouds que l'utilisateur a créés — au même mécanisme et au même écran.
 * Ce sont des services comme les autres, avec un nom et une identité visuelle ;
 * les mêler aux connecteurs dans une liste unique ferait chercher plus longtemps.
 *
 * Le stockage local n'a pas de site : son bouton « Récupérer » est grisé avec sa raison,
 * exactement comme un connecteur sans site, et son icône interne s'affiche déjà.
 */
function renderLogosList() {
  renderViewToggle('logos-view-switch', 'logos', 'setLogosView');
  renderLogosFilter();

  const cartes = viewMode('logos') === 'cards';
  const retenus = admin.logos.filter(logoRetenu);
  const groupe = (kind) => trierLogos(retenus.filter((c) => (c.kind || 'connector') === kind));
  const bloc = (titre, items) => {
    if (!items.length) return '';
    const corps = cartes
      ? `<div class="card-grid">${items.map(logoCard).join('')}</div>`
      : `<div class="logo-rows">${items.map(logoRow).join('')}</div>`;
    return `<div class="logo-group-title">${esc(titre)}</div>${corps}`;
  };

  $('logos-list').innerHTML = retenus.length
    ? (cartes ? '' : logosTableHead())
      + bloc('Applications', groupe('connector'))
      + bloc('Destinations de stockage', groupe('destination'))
    : logosVide();
}

// --- Filtre : avec logo / sans logo / tous ----------------------------------
//
// Le compteur annonçait « 8 en place, 6 manquants » sans permettre d'isoler les
// six. Sur quatre-vingts services étalés sur deux groupes, les retrouver à
// l'œil est un travail — et c'est exactement le travail qu'on vient faire ici,
// puisqu'on n'ouvre cet écran que pour combler des manques.
//
// Le choix est mémorisé sur le compte, comme le tri et le mode d'affichage :
// un administrateur qui rattrape des logos y revient plusieurs fois.

const LOGOS_FILTRES = [
  { id: 'tous', label: 'Tous', titre: 'Tous les services' },
  { id: 'sans', label: 'Sans logo', titre: 'Seulement ceux dont le logo manque' },
  { id: 'avec', label: 'Avec logo', titre: 'Seulement ceux qui ont déjà un logo' },
];

/** Le filtre en cours. « tous » tant que rien n'a été choisi. */
function logosFiltre() {
  const valeur = prefs.values['logos.filter'];
  return LOGOS_FILTRES.some((f) => f.id === valeur) ? valeur : 'tous';
}

/**
 * Ce service passe-t-il le filtre ?
 *
 * « Sans logo » ne retient QUE les vrais manques : le stockage local porte une icône
 * livrée avec crabe, elle s'affiche, elle ne manque pas — c'est déjà la règle
 * du liseré rouge, et les deux doivent dire la même chose.
 */
function logoRetenu(c) {
  const filtre = logosFiltre();
  if (filtre === 'tous') return true;
  const manque = logoManquant(c);
  return filtre === 'sans' ? manque : !manque;
}

function renderLogosFilter() {
  const boite = $('logos-filter');
  if (!boite) return;

  const courant = logosFiltre();
  const compte = (id) => admin.logos.filter((c) => {
    if (id === 'tous') return true;
    return id === 'sans' ? logoManquant(c) : !logoManquant(c);
  }).length;

  boite.innerHTML = LOGOS_FILTRES.map(
    (f) => `<button class="pill ${courant === f.id ? 'active' : ''}" id="logos-filter-${f.id}"
                    title="${esc(f.titre)}" aria-pressed="${courant === f.id}"
                    onclick="setLogosFilter('${f.id}')">${esc(f.label)} (${compte(f.id)})</button>`
  ).join('');
}

function setLogosFilter(valeur) {
  const retenu = LOGOS_FILTRES.some((f) => f.id === valeur) ? valeur : 'tous';
  prefs.values['logos.filter'] = retenu;
  savePref('logos.filter', retenu);
  renderLogosList();
}

/** Ce que dit l'écran quand le filtre ne laisse rien passer. */
function logosVide() {
  return `<div class="empty-state">
    ${logosFiltre() === 'sans'
      ? 'Aucun logo ne manque — tous les services en ont un.'
      : 'Aucun service n\'a encore de logo.'}
    <button class="btn-mini" onclick="setLogosFilter('tous')">Tout afficher</button>
  </div>`;
}

function setLogosView(mode) {
  setViewMode('logos', mode);
  renderLogosList();
}

// --- Tri --------------------------------------------------------------------

/**
 * Le tri par défaut du gestionnaire de logos : l'ordre alphabétique.
 *
 * C'est un catalogue, et on y cherche un service par son nom. Le tri retenu par
 * l'administrateur, lui, est mémorisé sur son compte.
 */
const LOGOS_TRI_DEFAUT = { key: 'name', dir: 'asc' };

/**
 * Ce sur quoi porte réellement le tri.
 *
 * **Jamais l'affichage** : `fetchedAt` se trie en millisecondes même écrit
 * « il y a 3 h », `bytes` en octets même écrit « 99,3 Ko ». C'est la règle du
 * lot 10, et elle vaut pour tous les tableaux.
 */
const LOGOS_ACCES = {
  name: (c) => c.name,
  state: (c) => (c.logo ? (c.source === 'manual' ? 'a-manuel' : 'b-recupere') : 'c-manquant'),
  source: (c) => c.source || '',
  bytes: (c) => c.bytes || 0,
  fetchedAt: (c) => fmt.parse(c.fetchedAt)?.getTime() || null,
  site: (c) => c.site || '',
};

function trierLogos(items) {
  return uiPrefs.trier(items, sortOf('logos', LOGOS_TRI_DEFAUT), LOGOS_ACCES, (c) => c.name);
}

function sortLogos(key) {
  const naturel = ['bytes', 'fetchedAt'].includes(key) ? 'desc' : 'asc';
  setSort('logos', uiPrefs.basculer(sortOf('logos', LOGOS_TRI_DEFAUT), key, naturel));
  renderLogosList();
}

/** L'en-tête du tableau, rendu une fois au-dessus des deux groupes. */
function logosTableHead() {
  const tri = sortOf('logos', LOGOS_TRI_DEFAUT);
  const th = (key, label) =>
    uiPrefs.enTeteTriable({ tri, key, label, onclick: `sortLogos('${key}')` });

  return `<table class="data-table wide logos-head"><thead><tr>
    ${th('name', 'Service')}${th('state', 'État')}${th('bytes', 'Taille')}
    ${th('fetchedAt', 'Récupéré')}${th('site', 'Site')}<th></th>
  </tr></thead></table>`;
}

// --- Un logo manquant se voit --------------------------------------------

/**
 * Ce logo manque-t-il vraiment ?
 *
 * L'icône interne du stockage local n'est pas un manque : elle est livrée avec crabe,
 * elle s'affiche, et aucun site ne pourrait en fournir une autre. Le liseré
 * rouge ne doit signaler qu'un VRAI manque — sinon il ne signale plus rien.
 */
function logoManquant(c) {
  return !c.logo && c.source !== 'internal';
}

/**
 * Pourquoi ce logo manque, en une phrase.
 *
 * Trois cas, et ils appellent trois gestes différents : un service sans site
 * ne pourra jamais rien récupérer, un échec enregistré dit ce qui a résisté, et
 * un logo jamais tenté attend simplement un clic.
 */
function logoRaisonManque(c) {
  if (!c.site) return 'Ce service ne déclare aucun site : le logo ne peut venir que d\'un envoi manuel.';
  if (c.lastError) {
    return `Dernière tentative ${fmt.relative(c.lastErrorAt)} : ${c.lastError}.`;
  }
  return 'Jamais récupéré — cliquez sur « Récupérer ».';
}

/** L'aperçu d'un logo : l'image si elle existe, la pastille de repli sinon. */
function logoPreview(c) {
  return `<div class="badge-logo logo-preview" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>`;
}

/**
 * Une carte de logo.
 *
 * Le manque se voit au premier regard — liseré rouge, libellé « logo
 * manquant », et « Récupérer » mis en avant plutôt que noyé parmi trois boutons
 * de même poids. Quand tous les logos sont là, aucun liseré : le rouge ne doit
 * signaler qu'un vrai manque.
 */
function logoCard(c) {
  const manquant = logoManquant(c);
  const interne = c.source === 'internal';
  const raison = manquant ? logoRaisonManque(c) : '';

  const etat = manquant
    ? `<span class="logo-missing-tag" title="${esc(raison)}">logo manquant</span>`
    : `<span class="badge-pill green">${interne ? 'icône interne' : c.source === 'manual' ? 'envoyé à la main' : 'récupéré'}</span>`;

  const detail = manquant
    ? esc(raison)
    : interne
      ? 'Livrée avec crabe : aucun site n\'est jamais sollicité pour ce service.'
      : `${c.width && c.height ? `${c.width}×${c.height} · ` : ''}${esc(fmt.bytes(c.bytes))}`
        + ` · ${esc(fmt.relative(c.fetchedAt))}`;

  return `<div class="logo-card ${manquant ? 'missing' : ''}" id="logo-row-${esc(c.id)}"
               ${manquant ? `title="${esc(raison)}"` : ''}>
    <div class="logo-card-head">
      ${logoPreview(c)}
      <div style="flex:1;min-width:0;">
        <div class="logo-name">${esc(c.name)}</div>
        <div class="logo-card-state">${etat}</div>
      </div>
    </div>
    <div class="logo-sub">${detail}</div>
    <div class="logo-result" id="logo-result-${esc(c.id)}"></div>
    <div class="logo-actions">
      <button class="${manquant ? 'btn-secondary' : 'btn-mini'}"
              onclick="fetchOneLogo('${esc(c.id)}', this)"
              ${c.site ? '' : 'disabled'}
              title="${c.site ? `Récupérer sur ${esc(c.site)}` : 'Ce service ne déclare aucun site'}">
        Récupérer
      </button>
      <button class="btn-mini" onclick="chooseLogoFile('${esc(c.id)}')">Envoyer une image</button>
      ${c.logo && !interne ? `<button class="btn-mini danger" onclick="deleteLogo('${esc(c.id)}')">Supprimer</button>` : ''}
    </div>
  </div>`;
}

function logoRow(c) {
  const manuel = c.source === 'manual';
  // Le stockage local : une icône livrée avec crabe, qui ne vient d'aucun site et que
  // rien ne remplace tant que personne n'en envoie une à la main.
  const interne = c.source === 'internal';
  const manquant = logoManquant(c);

  let etat = `<span class="logo-missing-tag" title="${esc(logoRaisonManque(c))}">logo manquant</span>`;
  if (interne) etat = '<span class="logo-state">Icône interne</span>';
  else if (c.logo) {
    etat = `<span class="logo-state">${manuel ? 'Envoyé à la main' : 'Récupéré'} ${esc(fmt.relative(c.fetchedAt))}</span>`;
  }

  let detail = manquant ? esc(logoRaisonManque(c)) : esc(c.site || 'aucun site déclaré');
  if (interne) detail = 'aucun site : rien n\'est jamais récupéré pour ce service';
  else if (c.logo) {
    detail = `${c.width && c.height ? `${c.width}×${c.height} · ` : ''}${fmt.bytes(c.bytes)}`
      + (c.origin ? ` · ${esc(new URL(c.origin).hostname)}` : '');
  }

  return `<div class="logo-row ${manquant ? 'missing' : ''}" id="logo-row-${esc(c.id)}"
               ${manquant ? `title="${esc(logoRaisonManque(c))}"` : ''}>
    ${logoPreview(c)}
    <div class="logo-main">
      <div class="logo-name">${esc(c.name)}${manuel ? ' <span class="badge-pill gray">manuel</span>' : ''}</div>
      <div class="logo-sub">${etat} · ${detail}</div>
      <div class="logo-result" id="logo-result-${esc(c.id)}"></div>
    </div>
    <div class="logo-actions">
      <button class="btn-mini" onclick="fetchOneLogo('${esc(c.id)}', this)"
              ${c.site ? '' : 'disabled'}
              title="${c.site ? `Récupérer sur ${esc(c.site)}` : 'Ce service ne déclare aucun site'}">
        Récupérer
      </button>
      <button class="btn-mini" onclick="chooseLogoFile('${esc(c.id)}')">Envoyer une image</button>
      ${c.logo && !interne ? `<button class="btn-mini danger" onclick="deleteLogo('${esc(c.id)}')">Supprimer</button>` : ''}
    </div>
  </div>`;
}

/** Écrit le résultat d'une action sur la ligne concernée, et nulle part ailleurs. */
function noteLogo(id, message, ok = true) {
  const box = $(`logo-result-${id}`);
  if (!box) return;
  box.className = `logo-result ${ok ? 'ok' : 'fail'}`;
  box.textContent = message;
}

/**
 * Récupère le logo d'un connecteur.
 *
 * `force` distingue les deux boutons groupés : « manquants » ne touche pas à ce
 * qui est déjà là, « tout resynchroniser » reprend l'existant. Le serveur
 * refuse dans les deux cas d'écraser une image envoyée à la main.
 */
async function fetchLogo(id, { force = false } = {}) {
  try {
    const resultat = await api(`/admin/connectors/${id}/logo`, {
      method: 'POST',
      body: { force },
    });
    if (resultat.skipped) return { id, ok: true, skipped: true, message: resultat.message };
    if (!resultat.ok) return { id, ok: false, message: resultat.message };
    return { id, ok: true, message: 'Logo récupéré.' };
  } catch (err) {
    // 409 : un logo manuel, que rien n'écrase. Ce n'est pas un échec.
    if (err.status === 409) return { id, ok: true, skipped: true, message: err.message };
    return { id, ok: false, message: err.message };
  }
}

async function fetchOneLogo(id, button) {
  await actionLongue({
    bouton: button,
    libelle: 'Récupération…',
    executer: async () => {
      const resultat = await fetchLogo(id, { force: true });
      noteLogo(id, resultat.message, resultat.ok);
      if (resultat.ok && !resultat.skipped) await renderLogos();
    },
  });
}

/**
 * Durée approximative d'une récupération groupée, en français.
 *
 * Volontairement pessimiste : une seconde de pause plus deux à trois secondes
 * de réponse par site. Annoncer trop court serait pire que ne rien annoncer.
 */
function dureeApproximative(nombre) {
  const secondes = nombre * 4;
  if (secondes < 90) return `${Math.max(1, Math.round(secondes))} secondes`;
  return `${Math.round(secondes / 60)} minutes`;
}

/** « Récupérer tous les logos manquants » — ne touche pas à ceux déjà présents. */
async function fetchMissingLogos() {
  const cibles = admin.logos.filter((c) => !c.logo && c.site);
  if (!cibles.length) return void showToast('Tous les logos sont déjà en place.');
  if (
    cibles.length > 10
    && !confirm(
      `Récupérer ${cibles.length} logos manquants ? Comptez au moins `
      + `${dureeApproximative(cibles.length)} — vous pourrez arrêter en cours de route.`
    )
  ) {
    return;
  }
  await recupererEnSerie(cibles, { force: false });
}

/**
 * « Tout resynchroniser » — reprend tout, y compris l'existant.
 *
 * Avec confirmation, puisque ça écrase : un logo satisfaisant peut être
 * remplacé par un moins bon si le fournisseur a changé sa page. Les images
 * envoyées à la main, elles, sont laissées telles quelles.
 */
async function refetchAllLogos() {
  const cibles = admin.logos.filter((c) => c.site);
  const manuels = admin.logos.filter((c) => c.source === 'manual').length;
  const avertissement =
    `Reprendre les ${cibles.length} logos, y compris ceux déjà en place ? `
    + 'Les logos actuels seront remplacés par ce que renvoie le site de chaque fournisseur. '
    // La durée est dite AVANT de lancer : une seconde entre chaque requête,
    // plus le temps de réponse de chaque site — sur quatre-vingts services,
    // c'est plusieurs minutes, et personne ne doit le découvrir en attendant.
    + `Comptez au moins ${dureeApproximative(cibles.length)}.`
    + (manuels ? ` Les ${manuels} image(s) envoyée(s) à la main ne seront pas touchées.` : '');
  if (!confirm(avertissement)) return;
  await recupererEnSerie(cibles, { force: true });
}

/**
 * Une seconde entre deux requêtes.
 *
 * Le lot 8 enchaînait quatorze appels sans pause, et c'était sans conséquence.
 * Le lot 11 en aligne quatre-vingt-cinq : quatre-vingt-cinq requêtes en rafale
 * depuis une seule adresse, ça finit par être mal reçu — un pare-feu qui coupe,
 * un site qui répond 429, et une moitié de la récupération perdue pour une
 * raison qui n'a rien à voir avec les logos.
 */
const LOGOS_PAUSE_MS = 1000;

/**
 * Récupération groupée en cours : son état, le moyen de l'arrêter, et la pause.
 *
 * `pauseMs` est là pour être remplacée — les tests de rendu exercent la boucle
 * complète, et leur faire attendre une seconde par sujet ne prouverait rien de
 * plus que la lecture du code.
 */
const logosEnCours = { actif: false, arret: false, pauseMs: LOGOS_PAUSE_MS };

/** « Arrêter » : la boucle finit la requête entamée, puis rend la main. */
function stopLogoFetch() {
  if (!logosEnCours.actif) return;
  logosEnCours.arret = true;
  $('logos-progress-text').textContent = 'Arrêt demandé — la requête en cours se termine…';
}

const patienter = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Récupère une liste de logos, un par un, avec sa progression.
 *
 * En série et jamais en parallèle : quatre-vingt-cinq requêtes simultanées vers
 * autant de fournisseurs, depuis un conteneur derrière une seule ligne, c'est le
 * meilleur moyen de les faire toutes échouer en délai dépassé.
 *
 * **L'interface n'est pas bloquée pendant ce temps** : l'attente est un `await`,
 * pas une boucle qui tourne. Seuls les deux boutons de lancement sont grisés —
 * on peut changer d'onglet, consulter autre chose, et revenir.
 */
async function recupererEnSerie(cibles, { force }) {
  const boutons = [$('logos-fetch-missing'), $('logos-refetch-all')];
  for (const bouton of boutons) if (bouton) bouton.disabled = true;
  $('logos-progress').style.display = 'block';
  $('logos-report').innerHTML = '';
  logosEnCours.actif = true;
  logosEnCours.arret = false;

  const resultats = [];
  let arrete = false;
  try {
    for (const [index, cible] of cibles.entries()) {
      if (logosEnCours.arret) {
        arrete = true;
        break;
      }
      $('logos-progress-text').textContent =
        `${index + 1} sur ${cibles.length}… (${cible.name})`;
      resultats.push({ ...(await fetchLogo(cible.id, { force })), name: cible.name });
      // Pas de pause après le dernier : elle ne ferait qu'allonger l'attente
      // avant le compte rendu.
      if (index < cibles.length - 1 && !logosEnCours.arret) await patienter(logosEnCours.pauseMs);
    }
  } finally {
    logosEnCours.actif = false;
    $('logos-progress').style.display = 'none';
    for (const bouton of boutons) if (bouton) bouton.disabled = false;
  }

  renderLogosReport(resultats, { arrete, total: cibles.length });
  await renderLogos();
}

/**
 * Le compte rendu final.
 *
 * Chaque échec porte SA raison, en français : « site injoignable », « aucune
 * image utilisable trouvée sur le site ». Un « 3 échecs » sans motif
 * n'apprendrait rien à personne et ne dirait pas quoi faire.
 */
function renderLogosReport(resultats, { arrete = false, total = resultats.length } = {}) {
  const reussis = resultats.filter((r) => r.ok && !r.skipped);
  const ignores = resultats.filter((r) => r.skipped);
  const echecs = resultats.filter((r) => !r.ok);

  const lignes = echecs
    .map((r) => `<li><strong>${esc(r.name)}</strong> — ${esc(r.message)}</li>`)
    .join('');

  // Un arrêt en cours de route se DIT : sans ça, « 12 récupérés » sur
  // quatre-vingt-cinq se lirait comme soixante-treize échecs silencieux.
  const interrompu = arrete
    ? `<div class="logos-report-head">Arrêté à la demande — ${resultats.length} sur ${total} `
      + 'traité(s). Relancer reprendra les logos encore manquants.</div>'
    : '';

  $('logos-report').innerHTML = `<div class="logos-report ${echecs.length ? 'partiel' : 'ok'}">
    ${interrompu}
    <div class="logos-report-head">
      ${reussis.length} logo(s) récupéré(s)${ignores.length ? `, ${ignores.length} conservé(s) tel(s) quel(s)` : ''}${echecs.length ? `, ${echecs.length} en échec` : ''}.
    </div>
    ${lignes ? `<ul class="logos-report-list">${lignes}</ul>` : ''}
  </div>`;
}

/** Ouvre le sélecteur de fichier pour un connecteur précis. */
function chooseLogoFile(id) {
  admin.logoUploadId = id;
  const champ = $('logo-upload');
  if (!champ) return;
  champ.value = '';
  champ.click?.();
}

/**
 * Envoi manuel d'une image.
 *
 * Elle prime sur toute récupération automatique. Le fichier est lu en base 64
 * côté navigateur : aucune dépendance de téléversement à ajouter pour une
 * image de moins de 500 Ko, et le serveur applique EXACTEMENT les mêmes
 * contrôles que sur une image récupérée — un fichier choisi à la main peut
 * aussi être une bannière de trois mégaoctets.
 */
function uploadLogoFile(event) {
  const id = admin.logoUploadId;
  const fichier = event?.target?.files?.[0];
  if (!id || !fichier) return;

  const lecteur = new FileReader();
  lecteur.onload = async () => {
    try {
      await api(`/admin/connectors/${id}/logo`, {
        method: 'PUT',
        body: { dataUrl: String(lecteur.result || '') },
      });
      await renderLogos();
      showToast('Logo enregistré — il ne sera pas écrasé par une resynchronisation.');
    } catch (err) {
      noteLogo(id, err.message, false);
      showToast(err.message);
    }
  };
  lecteur.onerror = () => showToast('Ce fichier n\'a pas pu être lu.');
  lecteur.readAsDataURL(fichier);
}

/** Supprime un logo : la pastille à initiales reprend sa place. */
async function deleteLogo(id) {
  const cible = admin.logos.find((c) => c.id === id);
  if (!confirm(`Supprimer le logo de ${cible ? cible.name : 'ce service'} ? La pastille à initiales reprendra sa place.`)) {
    return;
  }
  await api(`/admin/connectors/${id}/logo`, { method: 'DELETE' });
  await renderLogos();
  showToast('Logo supprimé.');
}

async function moveAppCategory(id, category) {
  const result = await api(`/admin/connectors/${id}/category`, { method: 'PUT', body: { category } });
  await renderApps();
  showToast(`Application déplacée vers ${result.label}`);
}

async function toggleMaintenance(id) {
  const connector = admin.apps.find((c) => c.id === id);
  const result = await api(`/admin/connectors/${id}/maintenance`, {
    method: 'PUT',
    body: { maintenance: !connector.maintenance },
  });
  await renderApps();
  showToast(`${connector.name} ${result.maintenance ? 'mis en maintenance' : 'remis en service'}`);
}

async function testApp(id, button) {
  const connector = admin.apps.find((c) => c.id === id);
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const result = await api(`/admin/connectors/${id}/test`, { method: 'POST' });
    showToast(`${connector.name} : ${result.message}`);
  } catch (err) {
    showToast(`${connector.name} : ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Tester';
  }
}

async function approveApp(id) {
  await api(`/admin/connectors/${id}/approve`, { method: 'POST' });
  await renderApps();
  showToast('Application approuvée — visible dans le Store');
}

async function rejectApp(id) {
  const connector = admin.apps.find((c) => c.id === id);
  if (!confirm(`Retirer ${connector.name} du Store ? Les installations existantes seront supprimées.`)) return;
  await api(`/admin/connectors/${id}/reject`, { method: 'POST' });
  await renderApps();
  showToast(`${connector.name} retiré du Store`);
}

function openAccessModal(id) {
  admin.accessModalId = id;
  const connector = admin.apps.find((c) => c.id === id);

  applyLogo($('access-logo'), connector);
  $('access-name').textContent = connector.name;

  const allowed = connector.allowedUsers;
  $('access-list').innerHTML = admin.appUsers
    .map(
      (u) => `
    <label class="access-row">
      <input type="checkbox" data-uid="${u.id}" ${allowed === 'all' || allowed.includes(u.id) ? 'checked' : ''}>
      ${esc(u.username)} <span style="color:var(--text-faint);font-size:11.5px;">(${u.role === 'admin' ? 'Administrateur' : 'Utilisateur'})</span>
    </label>`
    )
    .join('');

  $('access-overlay').classList.add('show');
}

function closeAccessModal() {
  $('access-overlay').classList.remove('show');
}

async function saveAccess() {
  const checked = [...document.querySelectorAll('#access-list input:checked')].map((i) => Number(i.dataset.uid));
  await api(`/admin/connectors/${admin.accessModalId}/access`, {
    method: 'PUT',
    body: { allowedUsers: checked },
  });
  closeAccessModal();
  await renderApps();
  showToast('Accès mis à jour');
}


// ===========================================================================
// Dépannage — déposer une connexion enregistrée pour un compte
//
// Ce geste vivait dans la fiche de l'utilisateur, sous « Options avancées »,
// accompagné de la ligne de commande qui produit le fichier. crabe s'adresse à
// des gens qui n'ont jamais ouvert un terminal : ce n'était pas un repli,
// c'était un mur. Il reste POSSIBLE — il sauve les cas où le navigateur distant
// ne peut pas s'ouvrir — mais il est passé du côté de l'administration.
// ===========================================================================

/** Le connecteur se connecte-t-il par connexion enregistrée ? */
function usesSession(connector) {
  return (connector?.fields || []).some((f) => f.type === 'session');
}

async function openSessionModal(id) {
  admin.sessionModalId = id;
  const connector = admin.apps.find((c) => c.id === id);
  applyLogo($('session-logo'), connector);
  $('session-name').textContent = connector.name;
  $('session-paste').value = '';
  $('session-chosen').textContent = '';
  $('session-chosen').className = 'session-chosen';
  $('session-overlay').classList.add('show');

  const data = await api(`/admin/connectors/${id}/sessions`);
  admin.sessionField = data.field;
  $('session-file').setAttribute('accept', data.field.accept);

  $('session-intro').textContent = data.accounts.length
    ? `Un compte se connecte normalement lui-même, depuis sa fiche. Ne déposez une `
      + `connexion ici que si la fenêtre de navigateur ne peut pas s'ouvrir. Le contenu `
      + `vaut les identifiants du compte : il est chiffré, et jamais réaffiché.`
    : 'Aucun compte n\'a installé ce service : il n\'y a rien à dépanner.';

  $('session-account').innerHTML = data.accounts
    .map((a) => `<option value="${a.userId}">${esc(a.username)} — ${esc(sessionLabel(a.session))}</option>`)
    .join('');
  $('session-save').disabled = !data.accounts.length;
}

/** Ce qu'on sait de la connexion d'un compte, sans jamais en montrer le contenu. */
function sessionLabel(session) {
  if (!session) return 'aucune connexion enregistrée';
  if (session.expired) return 'connexion expirée';
  return session.expiresAt
    ? `valable jusqu'au ${fmt.date(session.expiresAt)}`
    : 'connexion enregistrée, échéance inconnue';
}

function closeSessionModal() {
  $('session-overlay').classList.remove('show');
  admin.sessionModalId = null;
}

/**
 * Lit le fichier choisi et le pose dans la zone de texte.
 *
 * Le contrôle de fond — cookies présents, au moins un encore valable — est fait
 * par le serveur : c'est lui qui détient la règle, et c'est lui qui chiffre.
 * Ici, on vérifie seulement que c'est du JSON, pour éviter un aller-retour.
 */
function readAdminSessionFile(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const contenu = String(reader.result || '');
    try {
      JSON.parse(contenu);
    } catch {
      return void noteAdminSession(`${file.name} n'est pas un fichier JSON valide.`, false);
    }
    $('session-paste').value = contenu;
    noteAdminSession(`${file.name} retenu — il sera chiffré au dépôt.`);
  };
  reader.onerror = () => noteAdminSession(`Lecture de ${file.name} impossible.`, false);
  reader.readAsText(file);
}

function noteAdminSession(message, ok = true) {
  const note = $('session-chosen');
  if (!note) return;
  note.className = `session-chosen ${ok ? 'ok' : 'fail'}`;
  note.textContent = message;
}

async function saveAdminSession() {
  const valeur = String($('session-paste').value || '').trim();
  if (!valeur) return void noteAdminSession('Choisissez un fichier, ou collez son contenu.', false);

  const userId = $('session-account').value;
  try {
    const resultat = await api(`/admin/connectors/${admin.sessionModalId}/sessions/${userId}`, {
      method: 'PUT',
      body: { value: valeur },
    });
    closeSessionModal();
    showToast(`Connexion déposée — ${sessionLabel(resultat.session)}`);
  } catch (err) {
    noteAdminSession(err.message, false);
  }
}

// ===========================================================================
// Permissions (rôles + matrice)
// ===========================================================================

function setRolesTab(tab, el) {
  admin.rolesTab = tab;
  document.querySelectorAll('#roles-subnav .pill').forEach((p) => p.classList.remove('active'));
  if (el) el.classList.add('active');
  $('roles-tab-roles').style.display = tab === 'roles' ? 'block' : 'none';
  $('roles-tab-matrix').style.display = tab === 'matrix' ? 'block' : 'none';
}

async function renderRoles() {
  const data = await api('/admin/roles');
  admin.roles = data.roles;
  admin.permissions = data.permissions;
  admin.matrixUsers = data.users;
  $('roles-note').textContent = data.note;

  renderRolesList();
  renderPermissionMatrix();
}

/** Les rôles intégrés d'abord, puis l'ordre alphabétique. */
const ROLES_TRI_DEFAUT = { key: 'name', dir: 'asc' };

/** Le tri porte sur la donnée : `userCount` est un nombre, pas « 3 compte(s) ». */
const ROLES_ACCES = {
  name: (r) => r.name,
  builtin: (r) => !!r.builtin,
  userCount: (r) => r.userCount,
  permissions: (r) => r.permissions.length,
};

function rolesSort() {
  return sortOf('roles', ROLES_TRI_DEFAUT);
}

function sortRoles(key) {
  const naturel = ['userCount', 'permissions'].includes(key) ? 'desc' : 'asc';
  setSort('roles', uiPrefs.basculer(rolesSort(), key, naturel));
  renderRolesList();
}

function setRolesView(mode) {
  setViewMode('roles', mode);
  renderRolesList();
}

/** Les permissions d'un rôle, en toutes lettres, ou la phrase qui dit qu'il n'en a pas. */
function roleLibelles(role) {
  return role.permissions.length
    ? role.permissions
        .map((p) => admin.permissions.find((x) => x.id === p)?.label || p)
        .join(' · ')
    : 'Aucune permission d\'administration';
}

/** Les deux gestes d'un rôle, identiques en carte et en ligne. */
function roleActions(role) {
  return `
    <button class="btn-mini" onclick="openRoleModal(${role.id})"
            ${role.slug === 'admin' ? 'disabled title="Le rôle Administrateur porte toutes les permissions"' : ''}>
      Éditer
    </button>
    <button class="btn-mini danger" onclick="deleteRole(${role.id})"
            ${role.builtin ? 'disabled title="Rôle intégré à crabe : non supprimable"' : ''}>
      Supprimer
    </button>`;
}

function roleCard(role) {
  return `
  <div class="app-card">
    <div class="app-card-head">
      <div class="role-mark ${role.builtin ? 'builtin' : ''}">${esc(role.name.slice(0, 2).toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(role.name)}</div>
        <div class="app-card-sub">${role.userCount} compte(s) · ${role.permissions.length} permission(s)</div>
      </div>
      ${role.builtin ? '<span class="badge-pill blue">Intégré</span>' : ''}
    </div>
    <div class="app-card-texts"><div class="app-card-desc">${esc(roleLibelles(role))}</div></div>
    <div class="app-card-actions">${roleActions(role)}</div>
  </div>`;
}

function rolesTable(roles) {
  const tri = rolesSort();
  const th = (key, label) =>
    uiPrefs.enTeteTriable({ tri, key, label, onclick: `sortRoles('${key}')` });

  return `<table class="data-table wide">
    <thead><tr>
      ${th('name', 'Rôle')}${th('builtin', 'Origine')}${th('userCount', 'Comptes')}
      ${th('permissions', 'Permissions')}<th></th>
    </tr></thead>
    <tbody>
    ${roles
      .map(
        (role) => `
      <tr>
        <td data-label="Rôle" style="color:var(--text);">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span class="role-mark ${role.builtin ? 'builtin' : ''}">${esc(role.name.slice(0, 2).toUpperCase())}</span>
            <span class="cell-ellipsis">${esc(role.name)}</span>
          </div>
        </td>
        <td data-label="Origine">${role.builtin ? '<span class="badge-pill blue">Intégré</span>' : '<span class="badge-pill gray">Créé ici</span>'}</td>
        <td data-label="Comptes">${role.userCount}</td>
        <td class="cell-grow" data-label="Permissions">
          <div class="cell-ellipsis cell-expand" title="${esc(roleLibelles(role))}" onclick="toggleCell(this)">${esc(roleLibelles(role))}</div>
        </td>
        <td class="actions">${roleActions(role)}</td>
      </tr>`
      )
      .join('')}
    </tbody>
  </table>`;
}

function renderRolesList() {
  const roles = uiPrefs.trier(admin.roles, rolesSort(), ROLES_ACCES, (r) => r.name);

  $('roles-tab-roles').innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">Rôles</div>
        <div class="block-sub">Un rôle porte un ensemble de permissions, appliquées côté serveur</div>
      </div>
      <div class="view-switch">${viewToggle('roles', 'setRolesView')}</div>
      <button class="profil-btn" onclick="openRoleModal()">+ Créer un rôle</button>
    </div>
    ${
      viewMode('roles') === 'cards'
        ? `<div class="card-grid">${roles.map(roleCard).join('')}</div>`
        : rolesTable(roles)
    }`;
}

function permissionCheckboxes(selected = []) {
  return `<div class="perm-grid">
    ${admin.permissions
      .map(
        (p) => `
      <label class="perm-check">
        <input type="checkbox" value="${esc(p.id)}" ${selected.includes(p.id) ? 'checked' : ''}>
        <span>${esc(p.label)}</span>
      </label>`
      )
      .join('')}
  </div>`;
}

function openRoleModal(roleId = null) {
  const role = roleId ? admin.roles.find((r) => r.id === roleId) : null;
  if (role?.slug === 'admin') return;

  openGenericModal({
    title: role ? `Éditer le rôle « ${role.name} »` : 'Créer un rôle',
    sub: role?.builtin
      ? 'Rôle intégré : son nom n\'est pas modifiable.'
      : 'Choisissez les permissions accordées à ce rôle.',
    body: `
      <div class="field">
        <label>Nom du rôle</label>
        <input type="text" id="role-name" value="${esc(role?.name || '')}" ${role?.builtin ? 'disabled' : ''}>
      </div>
      ${permissionCheckboxes(role?.permissions || [])}`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: role ? 'Enregistrer' : 'Créer',
        class: 'btn-test',
        onClick: async () => {
          const permissions = [...document.querySelectorAll('#generic-body .perm-check input:checked')].map(
            (i) => i.value
          );
          try {
            if (role) {
              const body = { permissions };
              if (!role.builtin) body.name = $('role-name').value.trim();
              await api(`/admin/roles/${role.id}`, { method: 'PATCH', body });
            } else {
              await api('/admin/roles', {
                method: 'POST',
                body: { name: $('role-name').value.trim(), permissions },
              });
            }
            closeGenericModal();
            await renderRoles();
            showToast(role ? 'Rôle mis à jour' : 'Rôle créé');
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

async function deleteRole(roleId) {
  const role = admin.roles.find((r) => r.id === roleId);
  if (role.builtin) return;

  if (role.userCount > 0) {
    // Réaffectation obligatoire : on la demande plutôt que de rétrograder
    // silencieusement les comptes concernés.
    const others = admin.roles.filter((r) => r.id !== role.id);
    openGenericModal({
      title: `Supprimer « ${role.name} »`,
      sub: `${role.userCount} compte(s) portent ce rôle : choisissez leur nouveau rôle.`,
      body: `<div class="field"><label>Réaffecter à</label>
        <select id="reassign-role">${others.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
      </div>`,
      actions: [
        { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
        {
          label: 'Réaffecter et supprimer',
          class: 'btn-danger',
          onClick: async () => {
            try {
              const result = await api(`/admin/roles/${role.id}`, {
                method: 'DELETE',
                body: { reassignToRoleId: Number($('reassign-role').value) },
              });
              closeGenericModal();
              await renderRoles();
              showToast(`Rôle supprimé — ${result.reassigned} compte(s) réaffecté(s)`);
            } catch (err) {
              genericResult(false, err.message);
            }
          },
        },
      ],
    });
    return;
  }

  if (!confirm(`Supprimer le rôle « ${role.name} » ?`)) return;
  try {
    await api(`/admin/roles/${role.id}`, { method: 'DELETE' });
    await renderRoles();
    showToast('Rôle supprimé');
  } catch (err) {
    showToast(err.message);
  }
}

function renderPermissionMatrix() {
  $('roles-tab-matrix').innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">Permissions par utilisateur</div>
        <div class="block-sub">
          Le rôle détermine les permissions. Une case cochée signifie que le compte
          peut réellement appeler les routes correspondantes.
        </div>
      </div>
    </div>
    <div class="matrix-wrap">
      <table class="data-table matrix">
        <tr>
          <th>Compte</th>
          <th>Rôle</th>
          ${admin.permissions.map((p) => `<th class="matrix-head"><span>${esc(p.label)}</span></th>`).join('')}
        </tr>
        ${admin.matrixUsers
          .map(
            (u) => `
          <tr>
            <td style="color:var(--text);font-weight:500;">
              ${esc(u.username)}
              ${u.status === 'inactive' ? '<span class="badge-pill red">Désactivé</span>' : ''}
            </td>
            <td>
              <select onchange="assignRole(${u.id}, this.value)">
                ${roleOptions(u.roleId)}
              </select>
            </td>
            ${admin.permissions
              .map(
                (p) =>
                  `<td class="matrix-cell">${
                    u.permissions.includes(p.id)
                      ? '<span class="matrix-yes" title="Autorisé">●</span>'
                      : '<span class="matrix-no" title="Refusé">·</span>'
                  }</td>`
              )
              .join('')}
          </tr>`
          )
          .join('')}
      </table>
    </div>`;
}

async function assignRole(userId, roleId) {
  try {
    await api(`/admin/roles/users/${userId}`, { method: 'PUT', body: { roleId: Number(roleId) } });
    await renderRoles();
    showToast('Rôle attribué');
  } catch (err) {
    showToast(err.message);
    await renderRoles();
  }
}

// ===========================================================================
// Automatisation
// ===========================================================================

async function loadCron() {
  const data = await api('/admin/schedules');
  // Une planification sans couple (compte, connecteur) exploitable ne peut
  // rien piloter : elle est écartée à la source plutôt que rendue avec des
  // contrôles qui enverraient des requêtes vides.
  admin.schedules = (data.schedules || []).filter((s) => {
    const ok = s && Number.isInteger(Number(s.userId)) && Number(s.userId) > 0 && !!s.connectorId && !!s.id;
    if (!ok) console.warn('planification ignorée : identifiants incomplets', s);
    return ok;
  });
  admin.weekdays = data.weekdays;

  // La sélection ne doit pas survivre à une planification disparue.
  admin.cronSelection = new Set(
    [...admin.cronSelection].filter((id) => data.schedules.some((s) => s.id === id))
  );

  $('cron-banner').innerHTML = data.disabled
    ? '<div class="sec-note" style="max-width:680px;margin-bottom:14px;color:var(--amber);">' +
      'Le scheduler est désactivé (CRABE_DISABLE_SCHEDULER=1) : les planifications sont ' +
      'enregistrées mais ne se déclenchent pas.</div>'
    : `<div class="inline-note" style="max-width:680px;">
         ${data.activeTasks} tâche(s) active(s) · fuseau ${esc(data.timezone)} —
         les heures ci-dessous sont exprimées dans ce fuseau. Une planification existe
         par couple <strong>compte × connecteur installé</strong> : jamais pour un
         connecteur que personne n'utilise.
       </div>`;

  marquerBascule('cron');
  renderCron();
  renderBulkDay();
}

function setCronView(view) {
  setViewMode('cron', view);
  marquerBascule('cron');
  renderCron();
}

/** Par nom de connecteur : c'est ce qu'on lit en premier sur chaque ligne. */
const CRON_TRI_DEFAUT = { key: 'name', dir: 'asc' };

/**
 * Le tri porte sur la donnée : « prochaine exécution » se compare en
 * millisecondes, pas sur « dans 3 h ». Une planification suspendue n'a pas de
 * prochaine exécution : elle finit en bas, quel que soit le sens.
 */
const CRON_ACCES = {
  name: (s) => s.name,
  user: (s) => s.username,
  frequency: (s) => s.frequency,
  day: (s) => (s.frequency === 'weekly' ? s.dayOfWeek : s.lastDayOfMonth ? 99 : s.dayOfMonth),
  time: (s) => s.timeOfDay,
  next: (s) => fmt.parse(s.nextRunAt)?.getTime() || null,
  last: (s) => fmt.parse(s.lastRun?.at)?.getTime() || null,
};

function cronSort() {
  return sortOf('cron', CRON_TRI_DEFAUT);
}

function sortCron(key) {
  const naturel = key === 'last' ? 'desc' : 'asc';
  setSort('cron', uiPrefs.basculer(cronSort(), key, naturel));
  renderCron();
}

function sortedSchedules() {
  const tri = cronSort();
  // Le sélecteur de la barre d'outils et les en-têtes disent la même chose.
  if ($('cron-sort') && CRON_ACCES[tri.key]) $('cron-sort').value = tri.key;
  return uiPrefs.trier(admin.schedules, tri, CRON_ACCES, (s) => `${s.name} ${s.username}`);
}

function lastRunBadge(schedule) {
  if (!schedule.lastRun) return '<span class="badge-pill gray">Jamais exécuté</span>';
  const { success, at, message } = schedule.lastRun;
  return `<span class="badge-pill ${success ? 'green' : 'red'}" title="${esc(message || '')}">
    ${success ? 'Succès' : 'Échec'} · ${esc(fmt.relative(at))}
  </span>`;
}

const WEEKDAYS_FALLBACK = [
  { id: 0, label: 'dimanche' }, { id: 1, label: 'lundi' }, { id: 2, label: 'mardi' },
  { id: 3, label: 'mercredi' }, { id: 4, label: 'jeudi' }, { id: 5, label: 'vendredi' },
  { id: 6, label: 'samedi' },
];

function weekdayOptions(selected) {
  return (admin.weekdays || WEEKDAYS_FALLBACK)
    .map((d) => `<option value="${d.id}" ${Number(selected) === d.id ? 'selected' : ''}>${esc(d.label)}</option>`)
    .join('');
}

/**
 * Jours du mois proposés : 1 à 28, plus « dernier jour du mois ».
 * Au-delà de 28, une planification sauterait février — le choix explicite
 * « dernier jour » couvre le besoin sans ce piège.
 */
function monthDayOptions(selected, lastDay) {
  const days = Array.from({ length: 28 }, (_, i) => i + 1)
    .map((d) => `<option value="${d}" ${!lastDay && Number(selected) === d ? 'selected' : ''}>${d}</option>`)
    .join('');
  return `${days}<option value="last" ${lastDay ? 'selected' : ''}>dernier jour du mois</option>`;
}

/** Sélecteur de jour adapté à la fréquence, ou rien si elle n'en demande pas. */
function daySelect(s, idPrefix) {
  const id = `${idPrefix}-${esc(s.id)}`;
  if (s.frequency === 'weekly') {
    return `<select id="${id}" onchange="saveSchedule('${esc(s.id)}')">${weekdayOptions(s.dayOfWeek)}</select>`;
  }
  if (FREQUENCES_MENSUELLES.includes(s.frequency)) {
    return `<select id="${id}" onchange="saveSchedule('${esc(s.id)}')">${monthDayOptions(s.dayOfMonth, s.lastDayOfMonth)}</select>`;
  }
  return '<span class="fact-value text-faint">sans objet</span>';
}

function scheduleStateBadge(s) {
  if (!s.configured) return '<span class="badge-pill amber">configuration requise</span>';
  if (!s.userActive) return '<span class="badge-pill gray">compte désactivé</span>';
  if (s.maintenance) return '<span class="badge-pill red">connecteur en maintenance</span>';
  if (!s.enabled || s.frequency === 'disabled') return '<span class="badge-pill gray">suspendu</span>';
  return '<span class="badge-pill green">planifié</span>';
}

function nextRunText(s) {
  if (!s.nextRunAt) return 'aucune — planification suspendue';
  return `${fmt.dateTime(s.nextRunAt)} (${fmt.relative(s.nextRunAt)})`;
}

function renderCron() {
  const schedules = sortedSchedules();
  const el = $('cron-list');

  if (!schedules.length) {
    el.innerHTML = `<div class="empty-state">
      Aucune planification : aucun connecteur n'est installé. Une planification naît
      à l'installation d'un connecteur par un compte, et disparaît à sa désinstallation.
    </div>`;
    updateCronSelectionUi();
    return;
  }

  el.innerHTML =
    viewMode('cron') === 'cards'
      ? `<div class="card-grid">${schedules.map(cronCard).join('')}</div>`
      : cronTable(schedules);

  updateCronSelectionUi();
}

function cronCard(s) {
  const selected = admin.cronSelection.has(s.id);
  return `
  <div class="cron-card ${selected ? 'selected' : ''}">
    <div class="cron-card-head">
      <label class="cron-check">
        <input type="checkbox" ${selected ? 'checked' : ''} onchange="toggleCronSelection('${esc(s.id)}', this.checked)">
      </label>
      <div class="badge-logo" style="width:34px;height:34px;font-size:12px;background:${esc(s.color)};">${esc(s.letters)}${logoHtml(s)}</div>
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(s.name)}</div>
        <div class="app-card-sub">${esc(s.username)} · ${scheduleStateBadge(s)}</div>
      </div>
      <div class="toggle ${s.enabled && s.frequency !== 'disabled' ? 'on' : ''}"
           onclick="toggleSchedule('${esc(s.id)}')"><div class="knob"></div></div>
    </div>

    <div class="cron-card-facts">
      <div><span class="fact-label">Fréquence</span>
        <select id="cron-freq-${esc(s.id)}" onchange="saveSchedule('${esc(s.id)}')">
          ${FREQUENCIES.map(([v, l]) => `<option value="${v}" ${s.frequency === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div><span class="fact-label">Jour</span>${daySelect(s, 'cron-day')}</div>
      <div><span class="fact-label">Heure</span>
        <input type="time" id="cron-time-${esc(s.id)}" value="${esc(s.timeOfDay)}"
               onchange="saveSchedule('${esc(s.id)}')">
      </div>
      <div><span class="fact-label">Prochaine exécution</span>
        <span class="fact-value" title="${esc(fmt.exact(s.nextRunAt))}">${esc(nextRunText(s))}</span>
      </div>
      <div><span class="fact-label">Dernier résultat</span>${lastRunBadge(s)}</div>
    </div>

    <div class="app-card-actions">
      <button class="btn-mini" onclick="runScheduleNow('${esc(s.id)}', this)"
              ${s.running ? 'disabled title="Récupération déjà en cours"' : ''}>
        ${s.running ? 'En cours…' : 'Lancer maintenant'}
      </button>
    </div>
  </div>`;
}

function cronTable(schedules) {
  // « wide » : les lignes occupent toute la zone de contenu, sans colonne de
  // droite vide (voir style.css, table.data-table.wide). Sous 768 px, chaque
  // ligne devient une carte grâce aux attributs data-label.
  const tri = cronSort();
  const th = (key, label) =>
    uiPrefs.enTeteTriable({ tri, key, label, onclick: `sortCron('${key}')` });

  return `<table class="data-table wide">
    <thead>
      <tr>
        <th style="width:34px;"></th>${th('name', 'Connecteur')}${th('user', 'Compte')}
        ${th('frequency', 'Fréquence')}${th('day', 'Jour')}${th('time', 'Heure')}
        ${th('next', 'Prochaine exécution')}${th('last', 'Dernier résultat')}<th></th>
      </tr>
    </thead>
    <tbody>
    ${schedules
      .map(
        (s) => `
      <tr class="${admin.cronSelection.has(s.id) ? 'row-selected' : ''}">
        <td data-label="Sélection"><input type="checkbox" ${admin.cronSelection.has(s.id) ? 'checked' : ''}
                   onchange="toggleCronSelection('${esc(s.id)}', this.checked)"></td>
        <td data-label="Connecteur" style="color:var(--text);">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge-logo" style="width:22px;height:22px;font-size:8px;background:${esc(s.color)};">${esc(s.letters)}${logoHtml(s)}</span>
            ${esc(s.name)}
          </div>
        </td>
        <td data-label="Compte">${esc(s.username)} ${scheduleStateBadge(s)}</td>
        <td data-label="Fréquence">
          <select id="cron-freq-${esc(s.id)}" onchange="saveSchedule('${esc(s.id)}')">
            ${FREQUENCIES.map(([v, l]) => `<option value="${v}" ${s.frequency === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </td>
        <td data-label="Jour">${daySelect(s, 'cron-day')}</td>
        <td data-label="Heure"><input type="time" id="cron-time-${esc(s.id)}" value="${esc(s.timeOfDay)}"
                   onchange="saveSchedule('${esc(s.id)}')"></td>
        <td data-label="Prochaine exécution" title="${esc(fmt.exact(s.nextRunAt))}">${s.nextRunAt ? esc(fmt.dateTime(s.nextRunAt)) : '—'}</td>
        <td data-label="Dernier résultat">${lastRunBadge(s)}</td>
        <td class="actions"><button class="btn-mini" onclick="runScheduleNow('${esc(s.id)}', this)"
              ${s.running ? 'disabled' : ''}>${s.running ? 'En cours…' : 'Lancer'}</button></td>
      </tr>`
      )
      .join('')}
    </tbody>
  </table>`;
}

function toggleCronSelection(id, checked) {
  if (checked) admin.cronSelection.add(id);
  else admin.cronSelection.delete(id);
  updateCronSelectionUi();
}

function toggleAllCron(checked) {
  admin.cronSelection = checked ? new Set(admin.schedules.map((s) => s.id)) : new Set();
  renderCron();
}

function updateCronSelectionUi() {
  const count = admin.cronSelection.size;
  $('cron-bulk').style.display = count ? 'flex' : 'none';
  $('cron-bulk-count').textContent = `${count} sélectionné${count > 1 ? 's' : ''}`;
  $('cron-select-all').checked = count > 0 && count === admin.schedules.length;
}

/** Lit le sélecteur de jour d'une ligne et le traduit pour l'API. */
function readDay(id, frequency) {
  const el = $(`cron-day-${id}`);
  if (!el) return {};
  if (frequency === 'weekly') return { dayOfWeek: Number(el.value) };
  if (FREQUENCES_MENSUELLES.includes(frequency)) {
    return el.value === 'last'
      ? { lastDayOfMonth: true }
      : { dayOfMonth: Number(el.value), lastDayOfMonth: false };
  }
  return {};
}

/**
 * Couple (compte, connecteur) d'une planification.
 *
 * La source de vérité est `admin.schedules`, pas la chaîne « 3:free » lue dans
 * un attribut du DOM. Deux bugs de production venaient de là : `esc(undefined)`
 * rend une chaîne VIDE, et l'ancien découpage sur `indexOf(':')` ne signalait
 * pas l'absence de séparateur — d'où les `PUT /api/admin/schedules//` en
 * rafale, qui tombaient sur la route d'action groupée et répondaient 400.
 *
 * @returns {{userId: number, connectorId: string}|null} null si inexploitable
 */
function scheduleTarget(id) {
  const schedule = admin.schedules.find((s) => s.id === id);
  const userId = Number(schedule?.userId);
  const connectorId = schedule?.connectorId;

  if (!Number.isInteger(userId) || userId <= 0 || !connectorId) {
    // Journalisé côté client : une anomalie muette est une anomalie qui dure.
    console.warn('planification sans identifiants exploitables, requête abandonnée', {
      id,
      schedule,
    });
    showToast('Planification introuvable — rechargez l\'écran Automatisation.');
    return null;
  }
  return { userId, connectorId };
}

/** Requêtes déjà en vol, pour ne pas marteler la même planification. */
const cronInFlight = new Set();

async function saveSchedule(id) {
  const target = scheduleTarget(id);
  if (!target) return;

  const frequencyEl = $(`cron-freq-${id}`);
  const timeEl = $(`cron-time-${id}`);
  if (!frequencyEl || !timeEl) {
    console.warn('planification : contrôles absents du DOM, requête abandonnée', id);
    return;
  }

  // Une sauvegarde relance loadCron(), qui reconstruit les contrôles : sans ce
  // verrou, un enchaînement d'événements pourrait rejouer la même requête en
  // boucle.
  if (cronInFlight.has(id)) return;
  cronInFlight.add(id);

  const frequency = frequencyEl.value;
  try {
    const result = await api(`/admin/schedules/${target.userId}/${target.connectorId}`, {
      method: 'PUT',
      body: {
        frequency,
        timeOfDay: timeEl.value,
        ...readDay(id, frequency),
      },
    });
    await loadCron();
    showToast(
      result.schedule.cron
        ? `Planification enregistrée — ${result.schedule.rhythm}`
        : 'Planification suspendue'
    );
  } catch (err) {
    showToast(err.message);
  } finally {
    cronInFlight.delete(id);
  }
}

async function toggleSchedule(id) {
  const target = scheduleTarget(id);
  if (!target) return;
  if (cronInFlight.has(id)) return;
  cronInFlight.add(id);

  const schedule = admin.schedules.find((s) => s.id === id);
  try {
    await api(`/admin/schedules/${target.userId}/${target.connectorId}`, {
      method: 'PUT',
      body: { enabled: !schedule.enabled },
    });
    await loadCron();
    showToast(`${schedule.name} (${schedule.username}) ${schedule.enabled ? 'suspendu' : 'réactivé'}`);
  } catch (err) {
    showToast(err.message);
  } finally {
    cronInFlight.delete(id);
  }
}

async function bulkCron(patch) {
  const targets = [...admin.cronSelection];
  if (!targets.length) return;
  try {
    const result = await api('/admin/schedules', { method: 'PUT', body: { targets, ...patch } });
    await loadCron();
    showToast(`${result.schedules.length} planification(s) mise(s) à jour`);
  } catch (err) {
    showToast(err.message);
  }
}

/** Le sélecteur de jour de l'action groupée suit la fréquence choisie. */
function renderBulkDay() {
  const select = $('cron-bulk-day');
  if (!select) return;
  const frequency = $('cron-bulk-frequency').value;

  if (frequency === 'weekly') {
    select.innerHTML = `<option value="">Jour inchangé</option>${weekdayOptions(null)}`;
    select.disabled = false;
  } else if (FREQUENCES_MENSUELLES.includes(frequency)) {
    select.innerHTML = `<option value="">Jour inchangé</option>${monthDayOptions(null, false)}`;
    select.disabled = false;
  } else {
    select.innerHTML = '<option value="">Jour sans objet</option>';
    select.disabled = true;
  }
}

/**
 * Applique la même planification à toute la sélection, d'un coup :
 * fréquence, jour et heure ensemble — seuls les champs renseignés sont
 * envoyés, les autres gardent leur valeur.
 */
async function applyBulkSchedule() {
  const frequency = $('cron-bulk-frequency').value;
  const day = $('cron-bulk-day').value;
  const time = $('cron-bulk-time').value;

  const patch = {};
  if (frequency) patch.frequency = frequency;
  if (time) patch.timeOfDay = time;
  if (day && frequency === 'weekly') patch.dayOfWeek = Number(day);
  if (day && FREQUENCES_MENSUELLES.includes(frequency)) {
    if (day === 'last') patch.lastDayOfMonth = true;
    else Object.assign(patch, { dayOfMonth: Number(day), lastDayOfMonth: false });
  }

  if (!Object.keys(patch).length) {
    return void showToast('Choisissez au moins une fréquence, un jour ou une heure');
  }
  await bulkCron(patch);
}

async function bulkRunNow() {
  const targets = [...admin.cronSelection];
  if (!targets.length) return;
  if (!confirm(`Lancer maintenant ${targets.length} récupération(s) ?`)) return;

  showToast('Récupération lancée…');
  try {
    const result = await api('/admin/schedules/run', { method: 'POST', body: { targets } });
    await loadCron();
    showToast(
      `${result.succeeded}/${result.runs} exécution(s) réussie(s)` +
        (result.skipped ? ` — ${result.skipped} déjà en cours` : '')
    );
  } catch (err) {
    showToast(err.message);
  }
}

async function runScheduleNow(id, button) {
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const result = await api('/admin/schedules/run', { method: 'POST', body: { targets: [id] } });
    const run = result.results[0];
    showToast(run ? run.message : 'Aucune exécution');
    await loadCron();
  } catch (err) {
    showToast(err.message);
    button.disabled = false;
    button.textContent = 'Lancer';
  }
}

// ===========================================================================
// Stockage
// ===========================================================================

/**
 * État d'une destination, en une pastille.
 * Pour le stockage local, l'état vient du driver (chemin absent, partage non monté,
 * écriture refusée) : le détail complet reste derrière « Tester la connexion ».
 */
const LOCAL_STATES = {
  ok: ['green', 'accessible en écriture'],
  unset: ['amber', 'aucun chemin configuré'],
  missing: ['red', 'chemin inexistant'],
  'not-directory': ['red', 'le chemin n\'est pas un dossier'],
  'not-mounted': ['red', 'partage non monté'],
  'read-only': ['red', 'écriture refusée'],
};

function destStateBadge(d) {
  if (d.id === 'local') {
    const [tone, label] = LOCAL_STATES[d.state] || ['gray', 'état inconnu'];
    const mounted = d.mounted ? 'point de montage' : 'dossier local';
    return `<span class="badge-pill ${tone}" title="${esc(d.path || '')} — ${mounted}">${esc(label)}</span>`;
  }
  // ⚠ Écrit pour quelqu'un qui découvre crabe. « bloc rclone manquant » était
  // la phrase d'avant : elle nomme un outil que l'utilisateur n'a jamais vu, et
  // ne dit pas ce qu'il doit faire.
  if (!d.configured) return '<span class="badge-pill amber">identifiants à renseigner</span>';
  if (!d.enabled) return '<span class="badge-pill gray">ne reçoit plus rien</span>';
  return '<span class="badge-pill green">prêt</span>';
}

async function renderAdminStorage() {
  const data = await api('/admin/destinations');
  // La source de vérité des boutons de cet écran (voir `supprimerDestination`).
  admin.destinations = data.destinations || [];
  // La liste des types de stockage, demandée à rclone. Elle sert au formulaire
  // « Autre stockage » ; son échec n'empêche pas le reste de l'écran de
  // s'afficher — les destinations nommées, elles, n'en ont pas besoin.
  ETAT_BACKENDS = await api('/admin/destinations/backends').catch(() => ({
    ok: false,
    types: [],
    erreur: 'liste indisponible',
  }));
  ETAT_FOURNISSEURS = data.providers || [];
  const parts = data.summary.breakdown.filter((p) => p.enabled);
  const total = parts.reduce((sum, p) => sum + p.bytes, 0) || 1;
  const summary = data.summary;

  // Ligne 1 — une bande horizontale compacte plutôt qu'une grosse carte
  // centrée : espace total, répartition, fichiers, comptes.
  $('admin-storage-summary').innerHTML = `
    <div class="storage-strip">
      <div class="storage-strip-item">
        <div class="storage-strip-label">Espace total</div>
        <div class="storage-strip-val">${esc(fmt.bytes(summary.totalBytes))}</div>
        <div class="storage-strip-sub">toutes destinations confondues</div>
      </div>
      <div class="storage-strip-sep"></div>
      <div class="storage-strip-item storage-strip-split">
        <div class="storage-strip-label">Répartition par destination</div>
        <div class="storage-bar-bg">
          ${parts
            .map(
              (p) =>
                `<div class="storage-bar-seg" title="${esc(p.name)} — ${esc(fmt.bytes(p.bytes))}"
                      style="width:${((p.bytes / total) * 100).toFixed(1)}%;background:${esc(p.color)};"></div>`
            )
            .join('')}
        </div>
        <div class="storage-strip-legend">
          ${parts
            .map(
              (p) =>
                `<div class="storage-legend-item"><span class="storage-dot" style="background:${esc(p.color)};"></span>${esc(p.name)} — ${esc(fmt.bytes(p.bytes))}</div>`
            )
            .join('')}
        </div>
      </div>
      <div class="storage-strip-sep"></div>
      <div class="storage-strip-item">
        <div class="storage-strip-label">Fichiers</div>
        <div class="storage-strip-val">${esc(fmt.number(summary.files))}</div>
        <div class="storage-strip-sub">${esc(fmt.bytes(summary.uniqueBytes))} sans les copies</div>
      </div>
      <div class="storage-strip-sep"></div>
      <div class="storage-strip-item">
        <div class="storage-strip-label">Comptes</div>
        <div class="storage-strip-val">${summary.users}</div>
        <div class="storage-strip-sub">avec au moins une facture</div>
      </div>
    </div>`;

  $('admin-storage-warning').innerHTML = !data.rcloneAvailable
    ? '<div class="sec-note" style="margin-bottom:14px;color:var(--amber);">' +
      'Le logiciel rclone est introuvable sur ce serveur : toutes les destinations autres ' +
      'que le stockage local resteront inutilisables tant qu\'il n\'est pas installé ' +
      '(apt install rclone).</div>'
    : '';

  // Ligne 2 — le stockage local, puis les clouds ajoutés (voir .dest-grid).
  $('admin-storage-list').innerHTML =
    data.destinations
      .map((d) => {
        const isLocal = d.id === 'local';
        return `
      <div class="dest-card" id="dest-card-${esc(d.id)}">
        <div class="dest-head">
          <div class="dest-icon" style="background:${esc(d.color)};">${esc(d.letter)}${logoHtml(d)}</div>
          <div style="flex:1;min-width:0;">
            <div class="dest-title">${esc(d.name)} ${
              d.supprime
                ? '<span class="dest-tag">supprimé</span>'
                : d.required
                  ? '<span class="dest-tag">espace de crabe</span>'
                  : `<span class="dest-tag">${esc(d.providerLabel)}</span>`
            }</div>
            <div class="dest-sub">${d.usage.users} utilisateur(s) · ${d.usage.files} fichier(s) · ${esc(fmt.bytes(d.usage.bytes))}</div>
            <div style="margin-top:6px;">${destStateBadge(d)}</div>
          </div>
          ${
            d.required
              ? `<div class="toggle ${d.enabled ? 'on' : ''} disabled"
                      title="${d.enabled
                        ? 'L\'espace de stockage de crabe reçoit tous les documents'
                        : 'Supprimé — remettez-le en service pour qu\'il reçoive à nouveau'}"><div class="knob"></div></div>`
              : `<div class="toggle ${d.enabled ? 'on' : ''}"
                      title="Copier automatiquement les nouveaux documents"
                      onclick="toggleDestination('${esc(d.id)}', ${!d.enabled})"><div class="knob"></div></div>`
          }
        </div>
        ${destAutoCopyRow(d)}
        ${(d.avertissements || [])
          .map(
            (a) => `<div class="sec-note" style="margin:8px 0;color:var(--amber);">⚠ ${esc(a)}</div>`
          )
          .join('')}
        <div class="dest-body">
          ${
            isLocal
              ? `<div class="dest-fields">
                   <div class="field"><label>Chemin réseau</label><input type="text" id="dest-local-path" value="${esc(d.path)}"></div>
                   <div class="field"><label>Protocole</label>
                     <select id="dest-local-protocol">
                       ${['local', 'smb', 'nfs'].map((p) => `<option value="${p}" ${d.protocol === p ? 'selected' : ''}>${p.toUpperCase()}</option>`).join('')}
                     </select>
                   </div>
                 </div>
                 <div class="field-help" style="margin-bottom:12px;">
                   Le partage SMB/NFS doit être monté par l'hôte : crabe écrit dans le point de montage.
                   Les factures y sont rangées en
                   <code>&lt;utilisateur&gt;/&lt;Nom du connecteur&gt;/&lt;identifiant de compte&gt;/&lt;année&gt;/</code>,
                   sans dossier supplémentaire. Les destinations secondaires reçoivent
                   exactement la même arborescence.
                 </div>`
              : `<div class="field">
                   <label>Nom de cet espace</label>
                   <input type="text" id="dest-${esc(d.id)}-nom" value="${esc(d.displayName)}" maxlength="60">
                   <div class="field-help">Le nom que vous lui donnez, pour le reconnaître dans vos
                     écrans. Vous pouvez en avoir plusieurs chez le même fournisseur — « pCloud perso »
                     et « pCloud boulot », par exemple.</div>
                 </div>
                 ${destTypeRow(d)}
                 ${destAutorisationHtml(d)}
                 ${destSessionDurableHtml(d)}
                 ${destChampsHtml(d)}
                 <details class="dest-avance">
                   <summary>Réglages avancés</summary>
                   ${destChampsAvancesHtml(d)}
                   <div class="dest-fields">
                     <div class="field"><label>Nom du remote rclone</label><input type="text" id="dest-${esc(d.id)}-remote" value="${esc(d.remoteName)}"></div>
                     <div class="field"><label>Dossier de base</label><input type="text" id="dest-${esc(d.id)}-base" value="${esc(d.basePath)}"></div>
                   </div>
                   <div class="field">
                     <label>Ou coller une configuration rclone toute faite</label>
                     <textarea id="dest-${esc(d.id)}-conf" placeholder="${d.configured ? 'Configuration enregistrée — laisser vide pour la conserver' : 'type = ' + esc(d.backend || 'nom-du-type')}"></textarea>
                     <div class="field-help">Réservé à qui sait déjà se servir de <code>rclone config</code> :
                       le bloc collé ici remplace les champs ci-dessus. Stocké chiffré, jamais renvoyé au navigateur.</div>
                   </div>
                 </details>`
          }
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${d.supprime ? '' : `
            <button class="btn-mini" onclick="saveDestination('${esc(d.id)}')">Enregistrer</button>
            <button class="btn-mini" onclick="testDestination('${esc(d.id)}', this)">Tester la connexion</button>`}
            ${
              isLocal
                // ⚠ L'espace de stockage de crabe se supprime comme un cloud
                // depuis le lot 26 — il n'est plus « obligatoire ». Ce qui le
                // distingue encore : il se REMET en service d'un seul geste,
                // son chemin n'ayant jamais été effacé, là où un cloud se
                // recrée parce que ses identifiants, eux, sont partis.
                ? d.supprime
                  ? `<button class="btn-mini" onclick="remettreLocal()">Remettre en service</button>`
                  : `<button class="btn-mini danger" onclick="supprimerDestination('${esc(d.id)}')">Supprimer</button>`
                : `<button class="btn-mini" id="admin-sync-${esc(d.id)}"
                           onclick="syncDestinationFromAdmin('${esc(d.id)}', this)">Synchroniser</button>
                   ${d.configured && !d.supprime
                     ? `<button class="btn-mini" onclick="repartirDeZeroDestination('${esc(d.id)}')">Repartir de zéro</button>`
                     : ''}
                   <button class="btn-mini danger" onclick="supprimerDestination('${esc(d.id)}')">Supprimer</button>`
            }
          </div>
          <div class="test-result" id="result-${esc(d.id)}"></div>
        </div>
      </div>`;
      })
      .join('');

  // Au-dessus des cartes : le bouton d'ajout, TOUJOURS visible, et le bouton de
  // synchronisation globale, qui n'a de sens que s'il y a un cloud à servir.
  //
  // ⚠ Le premier ne peut pas être conditionnel. Sur une installation neuve il
  // n'y a plus que le stockage local, et rien sur cet écran ne disait comment ajouter
  // autre chose — les fournisseurs étaient déjà là, déjà listés, il ne restait
  // qu'à les remplir. Maintenant qu'il n'y en a aucun, ce bouton est la seule
  // porte d'entrée.
  const clouds = data.destinations.filter((d) => !d.required);
  $('admin-storage-sync').innerHTML = `
    <div class="dests-head">
      <button class="dest-add" onclick="ouvrirChoixFournisseur()">+ Ajouter un cloud</button>
      <span class="dest-sync-note">
        Un espace de stockage en ligne où crabe recopiera vos documents, en plus
        de sa copie principale. Vous pouvez en ajouter autant que vous voulez, y
        compris plusieurs chez le même fournisseur.
      </span>
    </div>
    ${
      clouds.length
        ? `<div class="dests-head">
             <button class="dest-sync-all" id="admin-sync-all" onclick="syncAllFromAdmin(this)">
               Tout synchroniser vers les clouds
             </button>
             <span class="dest-sync-note">
               Envoie vers chaque destination activée tout ce qui lui manque, pour
               <strong>tous les comptes</strong> — documents jamais copiés et documents en échec.
               Les PDF sont relus depuis le stockage local : aucun fournisseur n'est sollicité.
             </span>
           </div>`
        : ''
    }`;
}

/**
 * Le choix du service, avant toute saisie d'identifiants.
 *
 * ─── UNE liste, et une seule (lot 28) ────────────────────────────────────────
 *
 * Il y en avait deux : les quatre fournisseurs habillés, puis un bouton
 * « Autre stockage » qui ouvrait la liste complète des types d'rclone — où
 * pCloud se retrouvait une seconde fois, sous son nom technique. Le même
 * service, deux fois, sous deux noms : impossible de deviner qu'il s'agit du
 * même, ni lequel choisir.
 *
 * Le serveur ne renvoie plus qu'une liste, déjà dans l'ordre : les vedettes,
 * puis tout ce que ce rclone-ci sait faire, par ordre alphabétique et sans
 * jamais répéter une vedette. Cet écran ne fait que la dessiner.
 *
 * ─── Ce qui ne marchera pas ici est dit AVANT ────────────────────────────────
 *
 * Un fournisseur vedette dont le type manque au binaire installé reste affiché,
 * grisé, avec la phrase qui dit quoi faire — le retirer laisserait croire que
 * crabe ne sait pas lui parler.
 *
 * ─── Le clic ne transporte qu'un rang ────────────────────────────────────────
 *
 * Pas le nom du service : les types d'rclone s'appellent « google cloud
 * storage » ou « amazon cloud drive », avec des espaces, et l'un d'eux
 * porterait un jour une apostrophe. Un attribut `onclick` refermé trop tôt, et
 * le bouton ne fait plus rien du tout — c'est le défaut du lot 27, sur cet
 * écran-là précisément. Ce qu'il faut pour agir se relit donc dans
 * `ETAT_FOURNISSEURS`, l'état du client, jamais dans le HTML.
 */
function htmlChoixFournisseur(fournisseurs) {
  const liste = fournisseurs || [];
  const cartes = liste
    .map(
      (f, rang) => `
      <button class="prov-card${f.disponible ? '' : ' indispo'}"
              data-prov-cle="${esc(motsDeRecherche(f))}"
              ${f.disponible ? `onclick="choisirFournisseur(${rang})"` : 'disabled'}>
        <span class="prov-icon" style="background:${esc(f.color)};">${esc(f.letter)}</span>
        <span class="prov-texte">
          <span class="prov-nom">${esc(f.label)}</span>
          <span class="prov-resume">${esc(f.disponible ? f.resume : f.indisponibleParce)}</span>
        </span>
      </button>`
    )
    .join('');

  // Le champ de recherche n'est pas un ornement : le binaire à jour annonce une
  // soixantaine de services, et les faire défiler un par un pour trouver le
  // sien serait pire que les deux listes qu'on vient de fusionner.
  return `
      <div class="field">
        <label for="prov-filtre">Chez qui&nbsp;?</label>
        <input type="text" id="prov-filtre" autocomplete="off" oninput="filtrerFournisseurs()"
               placeholder="Tapez le nom d'un service pour le retrouver">
        <div class="field-help">Les services les plus courants sont en tête, avec leur logo ;
          viennent ensuite tous les autres que ce serveur sait utiliser, par ordre alphabétique.</div>
      </div>
      <div class="prov-grid" id="prov-grid">${cartes}</div>
      <div class="field-help" id="prov-aucun" style="display:none;">
        Aucun service de ce nom. crabe ne propose que ce que le logiciel rclone installé sur ce
        serveur sait utiliser — si le vôtre manque, c'est une mise à jour de rclone qu'il faut.
      </div>`;
}

/** Ce sur quoi la recherche porte : le nom affiché, le résumé, le nom technique. */
function motsDeRecherche(f) {
  return [f.label, f.resume, f.type, f.backend, f.id].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Filtre les cartes à la frappe. Aucune requête : tout est déjà là.
 *
 * Les cartes grisées restent visibles quand elles correspondent — quelqu'un qui
 * cherche « mega » doit lire pourquoi ça ne marchera pas, pas croire que crabe
 * ne connaît pas MEGA.
 */
function filtrerFournisseurs() {
  const cherche = ($('prov-filtre')?.value || '').trim().toLowerCase();
  const grille = $('prov-grid');
  if (!grille) return;
  let visibles = 0;
  for (const carte of grille.querySelectorAll('.prov-card')) {
    const garde = !cherche || (carte.getAttribute('data-prov-cle') || '').includes(cherche);
    carte.style.display = garde ? '' : 'none';
    if (garde) visibles += 1;
  }
  const rien = $('prov-aucun');
  if (rien) rien.style.display = visibles ? 'none' : '';
}

function ouvrirChoixFournisseur() {
  openGenericModal({
    title: 'Ajouter un cloud',
    sub: 'Un espace en ligne de plus, où crabe recopiera vos documents.',
    body: htmlChoixFournisseur(ETAT_FOURNISSEURS),
    actions: [{ label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal }],
  });
}

/**
 * Crée l'espace choisi, ferme la fenêtre, et amène devant son formulaire.
 *
 * ⚠ Le NOM n'est plus demandé ici (lot 28). Cet écran le réclamait avant même
 * de savoir chez qui — « Comment voulez-vous l'appeler ? » au-dessus d'une
 * liste de services qu'on n'a pas encore lue. Il vaut par défaut le nom du
 * service, et la carte qui s'ouvre juste après porte le champ « Nom de cet
 * espace », au bon moment celui-là.
 *
 * @param {number} rang la position de la carte dans `ETAT_FOURNISSEURS`
 */
async function choisirFournisseur(rang) {
  const choix = ETAT_FOURNISSEURS[rang];
  if (!choix) {
    // Un écran resté ouvert pendant qu'un autre administrateur rechargeait la
    // liste : le dire, plutôt que d'envoyer une création au hasard.
    genericResult(false, 'Cette liste n\'est plus à jour — refermez et rouvrez la fenêtre.');
    return;
  }
  try {
    const cree = await api('/admin/destinations', {
      method: 'POST',
      body: { provider: choix.provider, type: choix.type || '' },
    });
    closeGenericModal();
    await renderAdminStorage();
    // Sans ce recadrage, la carte apparaît en bas de l'écran et rien ne dit
    // qu'il reste à la remplir.
    const carte = document.getElementById(`dest-card-${cree.destination.id}`);
    if (carte) carte.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`« ${cree.destination.displayName} » ajouté — renseignez vos identifiants.`);
  } catch (err) {
    genericResult(false, err.message);
  }
}

/**
 * Supprime une destination, après une confirmation qui dit ce qui part et ce
 * qui reste.
 *
 * Ce qui reste doit être écrit noir sur blanc : les documents déjà copiés
 * là-bas ne sont PAS effacés. crabe n'a aucune raison de vider l'espace de
 * quelqu'un d'autre, et le dire vaut mieux que de laisser le doute.
 *
 * ─── POURQUOI CE BOUTON NE RÉPONDAIT PLUS DU TOUT (lot 27) ───────────────────
 *
 * Le nom de la destination était passé au bouton par `JSON.stringify()`, qui
 * rend une chaîne AVEC ses guillemets doubles. Au milieu d'un attribut
 * `onclick="…"` — délimité, lui aussi, par des guillemets doubles — le premier
 * caractère du nom refermait donc l'attribut :
 *
 *     onclick="supprimerDestination('local', "Stockage local", true)"
 *                                              ↑ l'attribut s'arrête ICI
 *
 * Le navigateur retenait `supprimerDestination('local', ` comme gestionnaire
 * de clic : un fragment de code qui ne compile pas. Cliquer ne faisait
 * STRICTEMENT rien — pas de message, pas de confirmation, pas d'appel au
 * serveur, rien qu'une erreur dans une console que personne n'ouvre. Le serveur,
 * lui, n'a jamais eu de défaut : c'est pourquoi la vérification du lot 26 a pu
 * conclure « ça existe et ça marche » en toute bonne foi.
 *
 * La correction reprend la leçon du lot 4 sur les planifications : ce qu'il
 * faut pour agir se lit dans l'ÉTAT DU CLIENT (`admin.destinations`), jamais
 * dans un attribut HTML reconstruit. Le bouton ne transporte plus qu'un
 * identifiant, qui n'a ni espace, ni accent, ni guillemet.
 */
async function supprimerDestination(id) {
  const dest = (admin.destinations || []).find((d) => String(d.id) === String(id));
  if (!dest) {
    // Un écran resté ouvert pendant qu'un autre administrateur supprimait la
    // même destination : le dire, plutôt que d'envoyer une requête au hasard.
    showToast('Cet espace de stockage n\'est plus dans la liste — rechargez l\'écran.');
    return;
  }
  const nom = dest.displayName || dest.name || id;
  const estLocal = String(dest.id) === 'local';
  // L'espace de stockage de crabe n'appelle pas le même avertissement qu'un
  // cloud : il ne perd pas d'identifiants, il ne se recrée pas — il se remet —,
  // et c'est LUI que la synchronisation relit pour servir les autres. Le dire
  // ici, au moment du geste, plutôt que de le laisser découvrir après coup.
  const avertissement = estLocal
    ? `Supprimer « ${nom} » ?\n\n`
      + "crabe cessera d'y déposer vos documents. Les fichiers déjà rangés là-bas ne sont "
      + 'PAS effacés, et le chemin est conservé : vous pourrez le remettre en service d\'un '
      + 'seul clic, sans rien ressaisir.\n\n'
      + 'À savoir : c\'est depuis cet espace que crabe relit vos documents pour les copier '
      + 'vers vos clouds. Sans lui, la synchronisation vers les clouds n\'a plus de source.\n\n'
      + 'Et s\'il ne reste aucun espace de stockage actif, les récupérations sont suspendues : '
      + "crabe n'ira pas chercher des documents qu'il n'a nulle part où déposer."
    : `Supprimer « ${nom} » ?\n\n`
      + "Les identifiants de cet espace seront effacés, et crabe cessera d'y copier vos "
      + 'documents.\n\n'
      + 'Les documents déjà déposés là-bas y restent : crabe ne les supprime pas. Vos copies '
      + "principales, sur l'espace de stockage de crabe, ne sont pas touchées.";
  if (!confirm(avertissement)) return;

  try {
    const res = await api(`/admin/destinations/${id}`, { method: 'DELETE' });
    await renderAdminStorage();
    showToast(
      res?.restant === 0
        ? `« ${nom} » supprimé — plus aucun espace de stockage actif, les récupérations sont suspendues.`
        : `« ${nom} » supprimé.`
    );
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * « Repartir de zéro » : oublier la session et les valeurs conservées d'une
 * destination, sans la supprimer ni toucher à son historique (lot 57).
 *
 * Le geste qui manquait pendant l'incident du 25/08/2026 : une session
 * conservée primait sur les saisies, et rien ne permettait de s'en défaire
 * sans supprimer la destination entière. La confirmation dit ce qui part et
 * ce qui reste — même règle d'honnêteté que pour la suppression.
 */
async function repartirDeZeroDestination(id) {
  const dest = (admin.destinations || []).find((d) => String(d.id) === String(id));
  if (!dest) {
    showToast('Cet espace de stockage n\'est plus dans la liste — rechargez l\'écran.');
    return;
  }
  const nom = dest.displayName || dest.name || id;
  const avertissement =
    `Repartir de zéro pour « ${nom} » ?\n\n`
    + 'Tout ce qui est enregistré pour cet espace est oublié : identifiants, session, '
    + 'réglages saisis. Vous ressaisirez tout, comme au premier jour.\n\n'
    + 'La destination elle-même reste, avec son nom et son historique : les documents déjà '
    + 'copiés là-bas ne sont pas touchés, et leurs pastilles continuent de dire où ils sont.';
  if (!confirm(avertissement)) return;
  try {
    await api(`/admin/destinations/${id}/reinitialiser`, { method: 'POST' });
    await renderAdminStorage();
    showToast(`« ${nom} » remis à zéro — ressaisissez vos identifiants sur sa carte.`);
  } catch (err) {
    showToast(err.message);
  }
}

/** Remet en service l'espace de stockage de crabe. Rien à ressaisir. */
async function remettreLocal() {
  try {
    await api('/admin/destinations/local/restore', { method: 'POST' });
    await renderAdminStorage();
    showToast('Espace de stockage de crabe remis en service.');
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * Le sélecteur de TYPE d'une destination sans fournisseur nommé.
 *
 * La liste n'est pas écrite dans crabe : elle vient de `rclone config
 * providers`, c'est-à-dire du binaire installé sur CE serveur. Deux
 * conséquences qui valent d'être connues — elle suit toute mise à jour
 * d'rclone sans qu'on touche à crabe, et elle ne propose jamais un type que ce
 * serveur ne saurait pas utiliser.
 *
 * Les champs du type choisi arrivent ensuite, du même endroit : c'est rclone
 * qui dit ce qu'il lui faut, pas nous qui le devinons.
 *
 * ⚠ Depuis le lot 28, le type est déjà choisi à l'arrivée : il vient de la
 * liste d'ajout, où chaque service porte son propre nom. Ce sélecteur ne sert
 * donc plus à choisir, mais à CORRIGER — s'être trompé de service ne doit pas
 * obliger à supprimer la destination et à tout recommencer.
 */
function destTypeRow(d) {
  // Seul un cloud sans fournisseur nommé laisse choisir le type : ailleurs il
  // est celui du fournisseur, et le montrer inviterait à le changer pour rien.
  if (!d.typeLibre) return '';
  const liste = ETAT_BACKENDS.types || [];
  // Le type déjà enregistré, quand la liste ne le porte pas : c'est le cas d'une
  // destination créée avant ce lot avec un type qu'un fournisseur vedette
  // remplace désormais (`pcloud`). Sans cette ligne, le sélecteur s'afficherait
  // sur « — choisissez — » et le premier enregistrement effacerait un type qui
  // marchait, sans que rien ne le dise.
  const options = liste.some((t) => t.name === d.type) || !d.type
    ? liste
    : [...liste, { name: d.type, description: 'type enregistré pour cet espace' }];
  return `<div class="field">
    <label>Type de stockage</label>
    <select id="dest-${esc(d.id)}-type" onchange="chargerChampsType('${esc(d.id)}')">
      <option value="">— choisissez —</option>
      ${options
        .map(
          (t) => `<option value="${esc(t.name)}" ${d.type === t.name ? 'selected' : ''}>
                    ${esc(t.name)} — ${esc(t.description)}</option>`
        )
        .join('')}
    </select>
    <div class="field-help">${
      ETAT_BACKENDS.ok
        ? 'Le service auquel cet espace se connecte, tel que vous l\'avez choisi en l\'ajoutant. '
          + 'Vous pouvez en changer ici si vous vous êtes trompé — les champs ci-dessous suivront.'
        : 'La liste des services n\'a pas pu être lue — rclone n\'a pas répondu. '
          + 'Vous pouvez tout de même coller une configuration toute faite plus bas.'
    }</div>
  </div>`;
}

/**
 * Les champs d'une destination, tels que son pilote (ou rclone) les déclare.
 *
 * ⚠ Un champ SECRET n'est jamais rempli d'avance, même configuré : sa valeur
 * ne quitte pas le serveur. Le laisser vide veut dire « garde celui d'avant » —
 * c'est écrit dans son emplacement, sinon corriger une adresse e-mail
 * effacerait le mot de passe d'à côté sans prévenir.
 */
function champsDeLaCarte(d) {
  // `|| []` et pas `d.champs` tout court : un serveur antérieur à ce lot ne
  // renvoie pas cette clé, et un écran d'administration qui plante est bien
  // pire qu'un formulaire auquel il manque des champs.
  // ⚠ `CHAMPS_TYPE[d.id]` n'existe QUE le temps d'une saisie : l'utilisateur
  // vient de choisir un type dans la liste, rien n'est encore enregistré, et le
  // serveur ne peut pas deviner lequel. Partout ailleurs, les champs
  // descendent avec la destination — y compris pour pCloud ou Proton Drive,
  // dont le fournisseur n'écrit aucun formulaire et qui les tiennent d'rclone.
  return CHAMPS_TYPE[d.id] || d.champs || [];
}

/** Un champ, avec son emplacement de saisie et son aide. */
function champHtml(d, c) {
  const valeur = c.type === 'password' ? '' : (d.valeurs?.[c.key] ?? '');
  // Par CHAMP, plus par carte (lot 33) : `d.configured` faisait écrire
  // « Enregistré » sous des secrets jamais remplis, et rien ne distinguait un
  // mot de passe posé d'une case restée vide. Le repli sur `d.configured`
  // couvre un serveur antérieur, qui n'envoie pas `secretsRenseignes`.
  const secretPose = c.type === 'password'
    && (d.secretsRenseignes ? d.secretsRenseignes.includes(c.key) : d.configured);
  const commun = `id="dest-${esc(d.id)}-champ-${esc(c.key)}" data-champ="${esc(c.key)}"`;
  // Le défaut d'rclone s'affiche en filigrane, jamais dans la case : le recopier
  // pour de bon rangerait dans la configuration une valeur qu'rclone applique
  // déjà tout seul, et la figerait à la version d'aujourd'hui.
  const filigrane = secretPose
    ? 'Enregistré — laisser vide pour le conserver'
    : (c.defaut && !valeur ? `par défaut : ${c.defaut}` : '');
  const saisie = c.options?.length
    ? `<select ${commun}>
         ${c.listeStricte ? '' : '<option value=""></option>'}
         ${c.options.map((o) => `<option value="${esc(o.value)}" ${valeur === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
       </select>`
    : `<input type="${c.type === 'password' ? 'password' : 'text'}" ${commun}
              value="${esc(valeur)}"
              placeholder="${esc(filigrane)}">`;
  // L'effacement EXPLICITE d'un secret enregistré (lot 33) : la case vide
  // veut dire « garde celui d'avant », donc sans ce geste dédié un secret
  // était ineffaçable — et rien ne disait qu'enregistrer à vide conservait.
  const effacement = secretPose
    ? `<div class="field-help">Une valeur est enregistrée pour ce champ — la laisser vide la conserve.
         <a href="#" id="dest-${esc(d.id)}-effacer-${esc(c.key)}"
            onclick="basculerEffacementSecret('${esc(d.id)}', '${esc(c.key)}'); return false;">Effacer la valeur enregistrée</a></div>`
    : '';
  // L'aide se REPLIE, elle ne se coupe pas (lot 57) : la première ligne reste
  // visible, le paragraphe complet se déplie — même mécanisme que les fiches
  // de connecteur (`fieldHelp`, web/app.js). Les cartes de destination
  // étaient devenues des murs de texte : chaque champ portait son paragraphe
  // entier, au même niveau que la case à remplir.
  return `<div class="field">
    <label>${esc(c.label)}${c.required ? '' : ' <span class="field-opt">(facultatif)</span>'}</label>
    ${saisie}
    ${effacement}
    ${fieldHelp(c.help)}
  </div>`;
}

/**
 * Marque un secret pour effacement au prochain enregistrement — et permet de
 * changer d'avis tant que rien n'est parti au serveur. La case est neutralisée
 * pendant que la marque tient : saisir une nouvelle valeur et demander
 * l'effacement en même temps n'a pas de sens lisible.
 */
function basculerEffacementSecret(destId, cle) {
  const champ = $(`dest-${destId}-champ-${cle}`);
  const lien = $(`dest-${destId}-effacer-${cle}`);
  if (!champ || !lien) return;
  const marque = champ.dataset.effacer === '1';
  champ.dataset.effacer = marque ? '' : '1';
  champ.disabled = !marque;
  if (!marque) champ.value = '';
  champ.placeholder = marque
    ? 'Enregistré — laisser vide pour le conserver'
    : 'Sera effacé au prochain enregistrement';
  lien.textContent = marque
    ? 'Effacer la valeur enregistrée'
    : 'Annuler l\'effacement';
}

function destChampsHtml(d) {
  const champs = champsDeLaCarte(d);
  if (!champs.length) {
    return d.typeLibre
      ? '<div class="field-help">Choisissez d\'abord un type de stockage ci-dessus.</div>'
      : `<div class="field-help">Le logiciel rclone de ce serveur n'a pas su dire ce que
           ${esc(d.providerLabel)} demande. Vous pouvez tout de même coller une configuration
           toute faite dans « Réglages avancés ».</div>`;
  }
  // Seuls les champs courants sont ici. Les autres descendent dans le repli —
  // voir `destChampsAvancesHtml`.
  const courants = champs.filter((c) => !c.avance);
  if (!courants.length) return '';
  return `<div class="dest-champs">${courants.map((c) => champHtml(d, c)).join('')}</div>`;
}

/**
 * Les réglages que le service accepte mais que presque personne ne touche.
 *
 * ─── Pourquoi ils apparaissent enfin (lot 29) ────────────────────────────────
 *
 * rclone classe ses options en deux tas, « courantes » et « avancées ». crabe
 * jetait le second purement et simplement : sept options sur dix, sur les
 * soixante-neuf services de ce serveur. Le tri d'rclone est raisonnable pour
 * qui règle des tailles de blocs — il l'est beaucoup moins quand le champ
 * indispensable s'y trouve, et c'est arrivé : le second mot de passe d'un
 * compte Proton Drive, le jeton d'autorisation de pCloud ou de Dropbox.
 * Résultat, une destination qu'aucun compte au monde n'aurait rendue
 * fonctionnelle, et pas une ligne à l'écran pour le dire.
 *
 * Ils sont donc tous là, repliés : celui qui n'en a pas besoin ne les voit
 * pas, celui qui en a besoin les trouve. Le repli reste FERMÉ au chargement —
 * l'ouvrir d'office ferait passer un formulaire de trois cases à soixante-dix
 * pour un espace S3, ce qui est une autre façon de rendre l'écran inutilisable.
 */
function destChampsAvancesHtml(d) {
  const avances = champsDeLaCarte(d).filter((c) => c.avance);
  if (!avances.length) return '';
  return `<div class="field-help" style="margin-bottom:10px;">
      Ces réglages ont tous une valeur par défaut qui convient dans la plupart des cas :
      laissez-les vides si rien ne vous demande d'y toucher.
    </div>
    <div class="dest-champs">${avances.map((c) => champHtml(d, c)).join('')}</div>`;
}

/**
 * La ligne « Copier automatiquement les nouveaux documents ».
 *
 * Elle dit deux choses que l'interrupteur seul ne dit pas : ce qu'il fait, et
 * surtout ce qu'il ne fait **pas** — l'activer ne rattrape pas l'historique.
 * C'est le rôle de « Synchroniser », et ne pas l'écrire laisserait croire que
 * les anciens documents partent tout seuls.
 */
function destAutoCopyRow(d) {
  if (d.required) {
    return `<div class="dest-autocopy">
      <span class="dest-autocopy-label">Destination principale — elle reçoit toujours les nouveaux documents.</span>
    </div>`;
  }

  const attente = d.pending
    ? `<span class="dest-pending">${d.pending} document(s) en attente</span> — `
    : '';

  return `<div class="dest-autocopy">
    <span class="dest-autocopy-label">
      ${d.enabled ? '☑' : '☐'} Copier automatiquement les nouveaux documents
    </span>
    <span class="dest-autocopy-help">
      ${attente}${
        d.enabled
          ? 'Activer cet interrupteur ne rattrape pas l\'historique : utilisez « Synchroniser ».'
          : 'Désactivée, cette destination reste consultable mais ne reçoit plus rien de nouveau.'
      }
    </span>
  </div>`;
}

/** Suit une synchronisation lancée depuis l'administration. */
async function suivreSyncAdmin(bouton, libelle) {
  if (bouton?.disabled) return;
  const rendu = bouton ? bouton.innerHTML : '';
  if (bouton) {
    bouton.disabled = true;
    bouton.innerHTML = '<span class="spinner"></span> démarrage…';
  }

  try {
    for (;;) {
      const etat = await api('/admin/destinations/sync/state');
      if (!etat.running) {
        showToast(`${libelle} — ${etat.message}`);
        break;
      }
      if (bouton) {
        bouton.innerHTML = `<span class="spinner"></span> ${
          etat.total ? `${etat.done}/${etat.total}` : 'en cours'
        }…`;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    if (bouton) {
      bouton.disabled = false;
      bouton.innerHTML = rendu;
    }
  }
  await renderAdminStorage();
}

async function syncDestinationFromAdmin(id, bouton) {
  try {
    await api(`/admin/destinations/${id}/sync`, { method: 'POST' });
  } catch (err) {
    return void showToast(err.message);
  }
  await suivreSyncAdmin(bouton, id);
}

async function syncAllFromAdmin(bouton) {
  try {
    await api('/admin/destinations/sync', { method: 'POST' });
  } catch (err) {
    return void showToast(err.message);
  }
  await suivreSyncAdmin(bouton, 'Toutes les destinations');
}

async function toggleDestination(id, enabled) {
  await api(`/admin/destinations/${id}`, { method: 'PUT', body: { enabled } });
  await renderAdminStorage();
  showToast(enabled ? 'Destination activée' : 'Destination désactivée');
}

async function saveDestination(id) {
  const body =
    id === 'local'
      ? { path: $('dest-local-path').value.trim(), protocol: $('dest-local-protocol').value }
      : {
          enabled: true,
          displayName: $(`dest-${id}-nom`)?.value.trim() || undefined,
          remoteName: $(`dest-${id}-remote`).value.trim(),
          basePath: $(`dest-${id}-base`).value.trim(),
          rcloneConfig: $(`dest-${id}-conf`)?.value.trim() || '',
          type: $(`dest-${id}-type`)?.value || undefined,
          // Les champs sont relevés dans le DOM plutôt que par une liste tenue
          // ici : c'est le serveur qui décide lesquels existent, et le front
          // qui les recopie. Deux listes à tenir d'accord finiraient par
          // diverger, et la divergence serait un champ perdu en silence.
          valeurs: Object.fromEntries(
            [...document.querySelectorAll(`[id^="dest-${id}-champ-"]`)]
              .filter((el) => el.dataset.effacer !== '1')
              .map((el) => [el.dataset.champ, el.value])
          ),
          // Les secrets marqués « à effacer » (lot 33) : leur clé part dans
          // cette liste, jamais dans `valeurs` — vide y voudrait dire « garde ».
          effacer: [...document.querySelectorAll(`[id^="dest-${id}-champ-"]`)]
            .filter((el) => el.dataset.effacer === '1')
            .map((el) => el.dataset.champ),
        };
  try {
    const rendu = await api(`/admin/destinations/${id}`, { method: 'PUT', body });
    await renderAdminStorage();
    // L'avertissement du serveur PRIME sur le petit mot rassurant : « la
    // prochaine copie échouera » doit se lire maintenant, pas au prochain
    // passage du planificateur (lot 33). Il reste ensuite affiché sur la carte.
    const avertissement = rendu?.avertissements?.[0];
    showToast(avertissement ? `Enregistré, mais attention : ${avertissement}` : 'Destination enregistrée');
    // Le bouton « Se connecter » enchaîne sur cet enregistrement (lot 34) : il
    // a besoin de savoir s'il peut continuer, pas seulement d'un toast.
    return rendu;
  } catch (err) {
    showToast(err.message);
    return null;
  }
}

/**
 * « Se connecter à <fournisseur> » — l'autorisation menée par crabe (lot 34).
 *
 * L'ordre est la moitié du correctif : le formulaire est ENREGISTRÉ d'abord,
 * pour que les réponses préalables soient en base quand la commande part —
 * sans sa région, `rclone authorize zoho` meurt avant d'afficher quoi que ce
 * soit, et le `hostname` pCloud ne voyage pas dans le jeton. Un
 * enregistrement refusé (contrôle de forme) arrête tout : pas de fenêtre
 * par-dessus un formulaire faux.
 */
async function autoriserDestination(destId) {
  const enregistre = await saveDestination(destId);
  if (!enregistre) return;
  const d = admin.destinations.find((x) => x.id === destId);
  openAutorisationStockage(destId, {
    nom: d?.name || d?.displayName || 'votre espace de stockage',
    color: d?.color,
    letters: d?.letter || '',
  });
}

/**
 * L'état de l'autorisation sur la carte, en français et sans jargon (lot 34).
 *
 * Trois familles d'états : c'est bon (« connecté »), il faut un geste
 * (« jamais autorisé », « expirée », « à refaire »), et l'entre-deux qui
 * prévient AVANT la panne (« expire bientôt »). Le bouton porte le geste ;
 * quand la configuration est illisible (phrase secrète du serveur), on
 * l'écrit plutôt que d'offrir un bouton qui échouera.
 */
function destAutorisationHtml(d) {
  const a = d.autorisation;
  if (!a?.possible || d.supprime || d.required) return '';

  const fournisseur = d.providerLabel || d.name || 'ce service';
  const dateEcheance = a.echeance ? new Date(a.echeance).toLocaleDateString('fr-FR') : '';

  const ETATS = {
    connecte: ['green', 'Connecté', ''],
    jamais: ['amber', 'Jamais autorisé',
      `crabe ouvre la page de ${fournisseur} dans une fenêtre sécurisée : vous vous y `
      + 'connectez, vous autorisez, et c\'est tout — aucun code à recopier.'],
    echeance: ['amber', `Expire bientôt${dateEcheance ? ` (le ${dateEcheance})` : ''}`,
      'Renouvelez l\'autorisation dès maintenant pour que les copies ne s\'interrompent pas.'],
    expiree: ['red', 'Autorisation expirée',
      'Les copies échoueront tant que l\'autorisation n\'est pas refaite — un clic suffit.'],
    invalide: ['red', 'Autorisation à refaire',
      'Ce qui est enregistré n\'a pas la forme d\'une autorisation valable. Refaites-la — '
      + 'un clic suffit.'],
    indeterminee: ['gray', 'État illisible', ''],
  };
  const [ton, etiquette, phrase] = ETATS[a.etat] || ETATS.indeterminee;

  if (a.etat === 'indeterminee') {
    return `<div class="field">
      <label>Autorisation</label>
      <div><span class="badge-pill gray">état illisible</span></div>
      <div class="field-help">La configuration enregistrée ne peut pas être relue (phrase
        secrète du serveur absente ou changée). Tant que ce n'est pas réparé, refaire
        l'autorisation écraserait ce qui est enregistré.</div>
    </div>`;
  }

  const bouton = a.etat === 'jamais'
    ? `Se connecter à ${fournisseur}`
    : (a.etat === 'connecte' || a.etat === 'echeance')
      ? 'Renouveler l\'autorisation'
      : 'Refaire l\'autorisation';

  return `<div class="field">
    <label>Autorisation</label>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="badge-pill ${ton}">${esc(etiquette)}</span>
      <button class="btn-mini" onclick="autoriserDestination('${esc(d.id)}')">${esc(bouton)}</button>
    </div>
    ${phrase ? `<div class="field-help">${esc(phrase)}</div>` : ''}
  </div>`;
}

/**
 * L'état de la session Proton Drive, dit sur la carte — des faits, pas des
 * espoirs (lots 34, 57, 58).
 *
 * Trois états lisibles depuis le lot 58 : session VALIDE (avec la date de la
 * dernière connexion réussie), session REFUSÉE par le service (avec la date du
 * refus, et ce que crabe fera — se reconnecter tout seul si la clé TOTP est
 * enregistrée, sinon le geste attendu), et JAMAIS CONNECTÉE. Ce dernier état
 * s'affiche depuis l'incident du 25/08/2026 : l'absence d'état laissait
 * deviner, et deviner s'est payé en réenregistrements à l'aveugle.
 *
 * Quand une reconnexion automatique a échoué faute de clé, la carte suggère
 * LA sortie du cycle « code périmé » : une ligne, et le champ (que le serveur
 * a remonté au premier niveau) — jamais un paragraphe.
 */
function destSessionDurableHtml(d) {
  if (d.supprime) return '';
  const suggestion = d.suggererCleTotp
    ? `<div class="field-help" style="color:var(--amber);">⚠ Pour que crabe se reconnecte
        tout seul la prochaine fois : renseignez la « Clé de votre application
        d'authentification », ci-dessous — il calculera lui-même un code frais à chaque
        connexion.</div>`
    : '';
  const dateDe = (iso) => {
    const quand = new Date(iso);
    return Number.isNaN(quand.getTime()) ? '' : quand.toLocaleDateString('fr-FR');
  };
  // ─── La session refusée par le service prime sur le badge vert (lot 57) ────
  //
  // L'incident du 25/08/2026 : la session était morte chez le service, la
  // carte affichait toujours « Session durable enregistrée », et rien ne
  // disait que les copies rejouaient une session refusée. La date du refus
  // vient du serveur ; le geste dépend de ce qui est enregistré (lot 58).
  if (d.sessionMorteLe) {
    const date = dateDe(d.sessionMorteLe) ? ` (le ${dateDe(d.sessionMorteLe)})` : '';
    const geste = d.reconnexionAuto
      ? 'crabe se reconnectera tout seul à la prochaine opération : le mot de passe et la '
        + 'clé de votre application d\'authentification sont enregistrés — il n\'y a rien à faire.'
      : 'Pour vous reconnecter : saisissez votre mot de passe (et un code de validation '
        + 'frais si votre compte en demande un), puis cliquez « Tester la connexion ».';
    return `<div class="field">
      <label>Connexion</label>
      <div><span class="badge-pill red">Session refusée par le service${esc(date)}</span></div>
      <div class="field-help">Le service ne reconnaît plus la session enregistrée — vos
        identifiants n'y sont pour rien. Elle ne sera plus rejouée. ${esc(geste)}</div>
      ${suggestion}
    </div>`;
  }
  if (d.sessionDurable === true) {
    const derniere = d.sessionEtablieLe
      ? ` Dernière connexion réussie le ${dateDe(d.sessionEtablieLe)}.`
      : '';
    return `<div class="field">
      <label>Connexion</label>
      <div><span class="badge-pill green">Session durable enregistrée</span></div>
      <div class="field-help">crabe se reconnecte tout seul, sans votre mot de passe ni code de
        validation.${esc(derniere)} Vous pouvez révoquer cette session à tout moment depuis
        votre compte Proton (Sécurité → Sessions) — crabe vous redemandera alors de vous
        connecter.</div>
      ${suggestion}
    </div>`;
  }
  // Jamais connectée — seulement pour une carte configurée d'un fournisseur à
  // session (`sessionDurable` vaut alors `false`, jamais `undefined`).
  if (d.sessionDurable === false && d.configured) {
    return `<div class="field">
      <label>Connexion</label>
      <div><span class="badge-pill gray">Jamais connectée</span></div>
      <div class="field-help">Aucune session n'est encore enregistrée. La première connexion
        réussie — « Tester la connexion » — en établira une, durable : crabe n'aura ensuite
        plus besoin ni de votre mot de passe ni d'un code pour les copies.</div>
      ${suggestion}
    </div>`;
  }
  return '';
}

/**
 * Les champs du type choisi, demandés à rclone, puis redessinés.
 *
 * On ne les devine pas et on ne les met pas en cache côté serveur pour la
 * durée d'une session : `rclone config providers` est la seule source, et elle
 * est déjà mise en cache là où c'est utile (server/destinations/backends.js).
 */
async function chargerChampsType(id) {
  const type = $(`dest-${id}-type`)?.value || '';
  if (!type) {
    CHAMPS_TYPE[id] = [];
    return void (await renderAdminStorage());
  }
  try {
    const rendu = await api(`/admin/destinations/backends?type=${encodeURIComponent(type)}`);
    CHAMPS_TYPE[id] = rendu.champs || [];
  } catch (err) {
    CHAMPS_TYPE[id] = [];
    showToast(err.message);
  }
  await renderAdminStorage();
}

/**
 * Test d'une destination : bouton grisé, texte qui avance.
 *
 * Un montage NFS injoignable met plusieurs secondes à le dire, et un remote
 * rclone davantage. Le même principe que partout ailleurs — voir
 * « Actions longues » dans web/app.js.
 */
async function testDestination(id, button) {
  const box = $(`result-${id}`);
  await actionLongue({
    bouton: button,
    libelle: 'Test…',
    etapes: [
      { apres: 0, texte: 'Connexion en cours…' },
      { apres: 5000, texte: 'L\'espace de stockage ne répond pas encore — encore un instant…' },
    ],
    afficher: (texte) => {
      box.className = 'test-result show loading';
      box.textContent = texte;
    },
    executer: async () => {
      try {
        const result = await api(`/admin/destinations/${id}/test`, { method: 'POST' });
        box.className = `test-result show ${result.ok ? 'ok' : 'fail'}`;
        box.textContent = result.message;
      } catch (err) {
        box.className = 'test-result show fail';
        box.textContent = err.message;
      }
    },
  });
}

// ===========================================================================
// Sécurité (onglets : connexion · logs de connexion)
//
// Gravatar est parti dans Utilisateurs → Avatars, le SMTP dans son propre
// menu : il ne reste ici que ce qui gouverne l'accès aux comptes.
// ===========================================================================

const SECURITY_TABS = ['connexion', 'logs'];

async function renderSecurityPage() {
  admin.security = await api('/system/security');
  await renderSecurityTab();
}

function setSecurityTab(tab, el) {
  admin.securityTab = SECURITY_TABS.includes(tab) ? tab : 'connexion';
  document.querySelectorAll('#security-subnav .pill').forEach((p) => p.classList.remove('active'));
  if (el) el.classList.add('active');
  renderSecurityTab().catch((err) => showToast(err.message));
}

async function renderSecurityTab() {
  if (admin.securityTab === 'logs') return renderConnectionLogsTab();

  const security = admin.security;
  $('security-content').innerHTML = `
    <div class="sec-section">
      <div class="sec-section-title">Complexité du mot de passe</div>
      <div class="sec-section-sub">Exigences appliquées à la création et au changement de mot de passe</div>
      <div class="inline-form">
        <select id="password-complexity">
          ${security.passwordLevels
            .map((l) => `<option value="${esc(l.id)}" ${security.passwordComplexity === l.id ? 'selected' : ''}>${esc(l.label)}</option>`)
            .join('')}
        </select>
        <button class="btn-mini" onclick="savePasswordComplexity()">Enregistrer</button>
      </div>
    </div>

    <div class="sec-section">
      <div class="sec-section-title">Double authentification</div>
      <div class="sec-section-sub">
        Politique appliquée à tous les comptes. Un compte qui a déjà activé la 2FA la
        conserve, même si elle est désactivée globalement — l'administration peut la
        réinitialiser depuis l'écran Utilisateurs.
      </div>
      <div class="radio-pill-row" style="max-width:640px;">
        ${security.twoFactorModes
          .map(
            (mode) => `
          <div class="radio-pill ${security.twoFactorMode === mode.id ? 'active' : ''}"
               onclick="setTwoFactorMode('${mode.id}')" title="${esc(mode.help)}">
            ${esc(mode.label)}
          </div>`
          )
          .join('')}
      </div>
      <div class="field-help" style="max-width:640px;">
        ${esc(security.twoFactorModes.find((m) => m.id === security.twoFactorMode)?.help || '')}
      </div>
    </div>

    ${documentRetentionSection(security.documentRetention)}`;
}

/**
 * « Conservation des documents » — la profondeur gardée par crabe.
 *
 * ─── Pourquoi la case de reprise n'est pas cochée d'avance ───────────────────
 *
 * Choisir « 6 mois » un mardi soir ne doit pas effacer huit ans de factures
 * dans la nuit. Le réglage protège donc tout ce qui a DÉJÀ été récupéré, et ne
 * s'applique qu'aux documents à venir — sauf si l'administrateur demande
 * explicitement le contraire, en connaissant le nombre exact de documents que
 * ça emporterait. C'est le sens du « jamais rétroactivement sans confirmation »
 * de la mission, et le serveur applique la même règle (server/retention.js).
 */
function documentRetentionSection(retention) {
  if (!retention) return '';

  const choix = retention.options
    .map(
      (o) => `<div class="radio-pill ${retention.months === o.months ? 'active' : ''}"
                   id="docret-${o.months}" onclick="chooseDocumentRetention(${o.months})">
        ${esc(o.label)}</div>`
    )
    .join('');

  return `<div class="sec-section">
    <div class="sec-section-title">Conservation des documents</div>
    <div class="sec-section-sub">
      Au-delà de cette profondeur, crabe efface les factures de son espace de stockage
      pendant l'entretien de nuit. <strong>Les copies déjà déposées sur vos clouds ne sont
      jamais touchées</strong> : ce sont vos comptes, chez des tiers.
    </div>
    <div class="radio-pill-row" style="max-width:640px;">${choix}</div>
    <div class="field-help" id="docret-state" style="max-width:640px;">
      ${esc(documentRetentionState(retention))}
    </div>
    ${retention.beyond && retention.floor
      ? `<label class="check-line" style="max-width:640px;margin-top:10px;">
           <input type="checkbox" id="docret-apply">
           <span>Appliquer aussi aux ${retention.beyond} document(s) déjà récupérés qui
                 dépassent cette profondeur — <strong>cette suppression est
                 définitive</strong>.</span>
         </label>
         <button class="btn-mini danger" style="margin-top:10px;"
                 onclick="applyDocumentRetentionNow(${retention.months})">
           Appliquer à l'existant
         </button>`
      : ''}
  </div>`;
}

/**
 * Ce que le réglage fait aujourd'hui.
 *
 * ⚠ La phrase d'avant le lot 24 disait « les documents récupérés avant le
 * réglage sont conservés ». C'était exact et trompeur : elle parlait de la date
 * de RÉCUPÉRATION, et se lisait comme une promesse sur la date d'ÉMISSION. Un
 * compte a récupéré le 12/08/2026 cent dix-huit factures anciennes (OVH,
 * SoYouStart, jusqu'à 2020) et les a vues effacées la nuit suivante : elles
 * étaient arrivées APRÈS le réglage, donc elles n'étaient pas « les
 * précédentes ». Ce texte dit maintenant les deux moitiés de la règle.
 *
 * ─── Deux corrections du lot 64, l'une et l'autre mesurées ───────────────────
 *
 * 1. **La phrase de plafond ne s'écrivait pas dans la bonne branche.** « Vos
 *    services ne descendront pas plus bas que cette profondeur » était servie
 *    AUSSI quand un plancher est posé — c'est-à-dire dans le cas ordinaire,
 *    celui de tout le monde. Or `retention.fetchCapMonths()` rend `0`, aucun
 *    plafond, PRÉCISÉMENT quand un plancher existe : le nettoyage épargnant
 *    l'ancien, la récupération n'a aucune raison de s'en priver (décision du
 *    lot 26, tenue par `test/lot26-conservation.test.js`). L'écran promettait
 *    donc le contraire de ce que le serveur fait, et c'est cette promesse qui
 *    rendait le résultat illisible : crabe est allé chercher Hetzner jusqu'en
 *    2019 — bien « plus bas que cette profondeur » — puis en a effacé une.
 *
 * 2. **Le nombre de partants était caché là où il compte le plus.** Seule la
 *    branche SANS plancher annonçait « N document(s) partiront au prochain
 *    entretien ». Avec un plancher, le chiffre existe pourtant (`view()` le
 *    calcule toujours) et il n'est pas nul : le bord haut de la fenêtre avance
 *    d'un jour par jour, et emporte les documents un par un à mesure qu'ils
 *    passent l'anniversaire. Le 26/08/2026, une facture récupérée à 10:07
 *    partait à l'entretien de la nuit même, sans que rien ne l'annonce.
 *
 * S'y ajoute la phrase qui manquait dans les deux branches : ce que devient un
 * document effacé. Sa copie cloud SURVIT — c'est écrit juste au-dessus — mais
 * crabe cesse de la répertorier. Sans cette précision, un fichier retrouvé sur
 * un cloud et absent de « Mes documents » n'a aucune explication (c'est
 * exactement le fichier qui a ouvert ce lot).
 */
function documentRetentionState(retention) {
  if (!retention.months) {
    return 'Rien n\'est supprimé : crabe garde tous vos documents, indéfiniment.';
  }
  const base = `Les documents de plus de ${retention.label.toLowerCase()} seront supprimés.`;
  const partants = `${retention.due} document(s) partiront au prochain entretien.`;
  const apres = 'Leur copie sur vos clouds reste en place, mais crabe cesse de la répertorier : '
    + 'vous la retrouverez depuis le cloud lui-même, plus depuis « Mes documents ».';
  if (retention.floor) {
    return `${base} Les ${retention.beyond} document(s) déjà récupérés sont conservés, quelle `
      + 'que soit leur date : le nettoyage ne revient jamais en arrière tout seul. '
      + `${partants} ${apres} Vos services, eux, continuent de remonter aussi loin que leur `
      + 'propre réglage d\'historique le demande : ce que le nettoyage épargne, crabe n\'a '
      + 'aucune raison de ne pas aller le chercher.';
  }
  return `${base} ${partants} ${apres} Vos services ne descendront pas plus bas que cette `
    + 'profondeur en cherchant vos factures : crabe ne télécharge pas ce qu\'il effacerait '
    + 'ensuite.';
}

/** Change la profondeur. Sans reprise de l'existant : c'est un autre geste. */
async function chooseDocumentRetention(months) {
  await saveDocumentRetention(months, false);
}

/** « Appliquer à l'existant » : le geste explicite, et sa confirmation. */
async function applyDocumentRetentionNow(months) {
  if (!$('docret-apply')?.checked) {
    return void showToast('Cochez la case avant d\'appliquer à l\'existant.');
  }
  const combien = admin.security?.documentRetention?.beyond || 0;
  if (!confirm(
    `Supprimer définitivement ${combien} document(s) déjà récupérés ? `
    + 'Les copies déposées sur vos clouds ne seront pas touchées.'
  )) return;

  await saveDocumentRetention(months, true);
}

async function saveDocumentRetention(months, applyNow) {
  try {
    await api('/system/security', {
      method: 'PUT',
      body: { documentRetentionMonths: months, applyRetentionNow: applyNow },
    });
    await renderSecurityPage();
    showToast(
      applyNow
        ? 'Conservation appliquée, y compris aux documents déjà récupérés.'
        : 'Conservation enregistrée — les documents déjà récupérés sont conservés.'
    );
  } catch (err) {
    showToast(err.message);
  }
}

/** Onglet « Logs de connexion » : tableau, filtres, purge et rétention. */
async function renderConnectionLogsTab() {
  $('security-content').innerHTML = `
    <div class="sec-section" style="border-top:none;padding-top:0;">
      <div class="sec-section-title">Journal des connexions</div>
      <div class="sec-section-sub">Qui s'est connecté, depuis quel appareil et quelle IP réelle</div>
      <div class="toolbar">
        <label class="toolbar-field">Utilisateur
          <select id="conn-user" onchange="renderConnectionLogs()"><option value="all">Tous</option></select>
        </label>
        <label class="toolbar-field">Période
          <select id="conn-days" onchange="renderConnectionLogs()">
            <option value="1">24 heures</option>
            <option value="7">7 jours</option>
            <option value="30" selected>30 jours</option>
            <option value="90">90 jours</option>
            <option value="0">Tout l'historique</option>
          </select>
        </label>
        <label class="toolbar-field">Résultat
          <select id="conn-result" onchange="renderConnectionLogs()">
            <option value="all">Tous</option>
            <option value="success">Succès</option>
            <option value="failure">Échecs</option>
          </select>
        </label>
        <label class="toolbar-field">Conservation
          <select id="retention-select"></select>
        </label>
        <button class="btn-mini" onclick="saveRetention()">Enregistrer la conservation</button>
        <button class="btn-mini danger" onclick="clearConnectionLogs()">Purger le journal</button>
      </div>
      <table class="data-table wide" id="connexions-table"></table>
    </div>`;

  await renderConnectionLogs(true);
}

async function setTwoFactorMode(mode) {
  try {
    await api('/system/security', { method: 'PUT', body: { twoFactorMode: mode } });
    await renderSecurityPage();
    showToast(
      mode === 'disabled'
        ? '2FA désactivée pour tous les comptes'
        : mode === 'required'
          ? '2FA exigée — les comptes seront invités à la configurer'
          : '2FA autorisée : chaque utilisateur décide'
    );
  } catch (err) {
    showToast(err.message);
  }
}

async function savePasswordComplexity() {
  await api('/system/security', {
    method: 'PUT',
    body: { passwordComplexity: $('password-complexity').value },
  });
  showToast('Politique de mot de passe enregistrée');
}

// ===========================================================================
// SMTP — configuration à gauche, modèles d'e-mail à droite
//
// Le SMTP n'a jamais tourné en conditions réelles : chaque action dit ce qui a
// échoué (DNS, refus, authentification, délai, certificat) plutôt que de
// laisser l'écran muet.
// ===========================================================================

async function renderSmtpPage() {
  const data = await api('/system/smtp');
  admin.smtp = data.smtp;
  admin.secureModes = data.secureModes;
  admin.templates = data.templates;

  if (!admin.templates.some((t) => t.key === admin.templateKey)) {
    admin.templateKey = admin.templates[0]?.key || null;
  }

  renderSmtpConfig();
  renderSmtpTemplates();
}

function renderSmtpConfig() {
  const s = admin.smtp;

  $('smtp-config').innerHTML = `
    <div class="col-head">Configuration du serveur</div>
    <div class="col-sub">
      ${
        s.ready
          ? 'Utilisé pour les confirmations de changement d\'adresse et les notifications.'
          : '<strong>Aucun serveur configuré :</strong> crabe fonctionne, mais tout ce qui ' +
            'passe par e-mail reste indisponible et le dit explicitement.'
      }
    </div>

    <div class="dest-fields">
      <div class="field"><label>Hôte</label>
        <input type="text" id="smtp-host" value="${esc(s.host)}" placeholder="smtp.exemple.fr">
      </div>
      <div class="field"><label>Port</label>
        <input type="text" id="smtp-port" value="${esc(s.port || '')}" placeholder="587">
      </div>
    </div>

    <div class="field">
      <label>Chiffrement</label>
      <select id="smtp-secure" onchange="onSmtpSecureChange()">
        ${admin.secureModes
          .map((m) => `<option value="${esc(m.id)}" ${s.secure === m.id ? 'selected' : ''}>${esc(m.label)}</option>`)
          .join('')}
      </select>
      <div class="field-help" id="smtp-secure-help">
        ${esc(admin.secureModes.find((m) => m.id === s.secure)?.help || '')}
      </div>
    </div>

    <div class="dest-fields">
      <div class="field"><label>Utilisateur</label>
        <input type="text" id="smtp-user" value="${esc(s.user)}" placeholder="laisser vide si pas d'authentification">
      </div>
      <div class="field"><label>Mot de passe</label>
        <input type="password" id="smtp-pass" placeholder="${s.configured ? '•••••••• (inchangé)' : '••••••••'}">
      </div>
    </div>

    <div class="dest-fields">
      <div class="field"><label>Adresse d'expédition</label>
        <input type="text" id="smtp-from" value="${esc(s.from)}" placeholder="crabe@exemple.fr">
      </div>
      <div class="field"><label>Nom d'expéditeur</label>
        <input type="text" id="smtp-from-name" value="${esc(s.fromName)}" placeholder="crabe">
      </div>
    </div>

    <div class="inline-form" style="margin-bottom:16px;">
      <button class="btn-mini" onclick="saveSmtp()">Enregistrer</button>
    </div>

    <div class="sec-section">
      <div class="sec-section-title">Tester l'envoi</div>
      <div class="sec-section-sub">
        Un message de test part vers l'adresse saisie. En cas d'échec, le motif exact
        est affiché : nom d'hôte introuvable, connexion refusée, authentification
        rejetée, délai dépassé ou problème de certificat.
      </div>
      <div class="inline-form">
        <input type="text" id="smtp-test-to" placeholder="destinataire@exemple.fr"
               style="flex:1;min-width:200px;background:var(--bg-elev-2);border:1px solid var(--border-strong);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;">
        <button class="btn-mini" onclick="testSmtp()">Tester l'envoi</button>
      </div>
      <div class="test-result" id="result-smtp"></div>
    </div>`;
}

/** Aide contextuelle du mode de chiffrement, sans recharger la page. */
function onSmtpSecureChange() {
  const mode = $('smtp-secure').value;
  $('smtp-secure-help').textContent =
    admin.secureModes.find((m) => m.id === mode)?.help || '';
}

async function saveSmtp() {
  try {
    const result = await api('/system/smtp', {
      method: 'PUT',
      body: {
        host: $('smtp-host').value.trim(),
        port: $('smtp-port').value.trim(),
        user: $('smtp-user').value.trim(),
        from: $('smtp-from').value.trim(),
        fromName: $('smtp-from-name').value.trim(),
        secure: $('smtp-secure').value,
        password: $('smtp-pass').value,
      },
    });
    admin.smtp = result.smtp;
    renderSmtpConfig();
    showToast('Configuration SMTP enregistrée');
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * Envoi de l'e-mail de test.
 *
 * Un serveur SMTP qui ne répond pas se fait attendre jusqu'au délai de la
 * bibliothèque : sans texte qui avance, l'écran a l'air figé.
 */
async function testSmtp() {
  const box = $('result-smtp');
  await actionLongue({
    etapes: [
      { apres: 0, texte: 'Envoi en cours…' },
      { apres: 5000, texte: 'Le serveur d\'envoi met du temps à répondre — encore un instant…' },
    ],
    afficher: (texte) => {
      box.className = 'test-result show loading';
      box.textContent = texte;
    },
    executer: async () => {
      try {
        const result = await api('/system/smtp/test', {
          method: 'POST',
          body: { to: $('smtp-test-to').value.trim() },
        });
        box.className = `test-result show ${result.ok ? 'ok' : 'fail'}`;
        box.textContent = result.message;
      } catch (err) {
        box.className = 'test-result show fail';
        box.textContent = err.message;
      }
    },
  });
}

// --- Modèles d'e-mail ------------------------------------------------------

function currentTemplate() {
  return admin.templates.find((t) => t.key === admin.templateKey) || null;
}

/** Conserve la saisie en cours avant de changer de modèle. */
function captureTemplateDraft() {
  const template = currentTemplate();
  if (!template || !$('template-subject')) return;
  template.subject = $('template-subject').value;
  template.body = $('template-body').value;
}

function selectTemplate(key) {
  captureTemplateDraft();
  admin.templateKey = key;
  renderSmtpTemplates();
}

function renderSmtpTemplates() {
  const template = currentTemplate();
  if (!template) {
    $('smtp-templates').innerHTML = '<div class="empty-state">Aucun modèle d\'e-mail.</div>';
    return;
  }

  $('smtp-templates').innerHTML = `
    <div class="col-head">Modèles d'e-mail</div>
    <div class="col-sub">
      Objet et corps sont stockés en base : les modifier ici change tous les envois à venir.
    </div>

    <div class="field">
      <label>Modèle à éditer</label>
      <select id="template-select" onchange="selectTemplate(this.value)">
        ${admin.templates
          .map(
            (t) =>
              `<option value="${esc(t.key)}" ${t.key === admin.templateKey ? 'selected' : ''}>${esc(t.label)}${t.customized ? ' (personnalisé)' : ''}</option>`
          )
          .join('')}
      </select>
      <div class="field-help">${esc(template.description)}</div>
    </div>

    <div class="field">
      <label>Objet</label>
      <input type="text" id="template-subject" value="${esc(template.subject)}">
    </div>

    <div class="field">
      <label>Corps du message</label>
      <textarea id="template-body" rows="12" style="min-height:220px;">${esc(template.body)}</textarea>
      <div class="field-help">
        Variables disponibles pour ce modèle — cliquez pour insérer :
      </div>
      <div class="var-list">
        ${template.variables
          .map(
            (v) =>
              `<button class="var-chip" title="${esc(v.help)} — exemple : ${esc(v.sample)}"
                       onclick="insertTemplateVariable('${esc(v.name)}')">{{${esc(v.name)}}}</button>`
          )
          .join('')}
      </div>
      <div class="field-help">
        Un marqueur inconnu n'est pas remplacé : il reste visible tel quel dans l'aperçu.
      </div>
    </div>

    <div class="inline-form">
      <button class="btn-mini" onclick="saveTemplate()">Enregistrer</button>
      <button class="btn-mini" onclick="previewTemplate()">Aperçu</button>
      <button class="btn-mini" onclick="sendTemplateTest()">Envoyer un test</button>
      <button class="btn-mini danger" onclick="resetTemplate()">Réinitialiser au modèle par défaut</button>
      ${template.customized ? '<span class="template-dirty">modèle personnalisé</span>' : ''}
    </div>

    <div class="mail-preview" id="template-preview"></div>
    <div class="test-result" id="result-template"></div>`;
}

/** Insère `{{variable}}` à l'endroit du curseur, dans le corps du message. */
function insertTemplateVariable(name) {
  const field = $('template-body');
  const marker = `{{${name}}}`;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + marker + field.value.slice(end);
  field.focus();
  field.selectionStart = field.selectionEnd = start + marker.length;
}

async function saveTemplate() {
  try {
    const result = await api(`/system/email-templates/${admin.templateKey}`, {
      method: 'PUT',
      body: { subject: $('template-subject').value, body: $('template-body').value },
    });
    replaceTemplate(result.template);
    renderSmtpTemplates();
    showToast('Modèle enregistré');
  } catch (err) {
    showToast(err.message);
  }
}

async function resetTemplate() {
  const template = currentTemplate();
  if (!confirm(`Réinitialiser « ${template.label} » au modèle livré avec crabe ?`)) return;
  try {
    const result = await api(`/system/email-templates/${admin.templateKey}/reset`, {
      method: 'POST',
    });
    replaceTemplate(result.template);
    renderSmtpTemplates();
    showToast('Modèle réinitialisé');
  } catch (err) {
    showToast(err.message);
  }
}

function replaceTemplate(updated) {
  const index = admin.templates.findIndex((t) => t.key === updated.key);
  if (index >= 0) admin.templates[index] = updated;
}

/** Aperçu du texte À L'ÉCRAN, avant enregistrement, avec valeurs d'exemple. */
async function previewTemplate() {
  const box = $('template-preview');
  try {
    const result = await api(`/system/email-templates/${admin.templateKey}/preview`, {
      method: 'POST',
      body: { subject: $('template-subject').value, body: $('template-body').value },
    });
    box.className = 'mail-preview show';
    box.innerHTML = `
      <div class="mail-preview-subject">${esc(result.preview.subject)}</div>
      <div class="mail-preview-body">${esc(result.preview.body)}</div>`;
  } catch (err) {
    box.className = 'mail-preview show';
    box.textContent = err.message;
  }
}

/** Envoie le modèle sélectionné, rempli de valeurs d'exemple. */
async function sendTemplateTest() {
  const to = ($('smtp-test-to')?.value || '').trim();
  const box = $('result-template');
  if (!to) {
    box.className = 'test-result show fail';
    box.textContent =
      'Saisissez d\'abord une adresse de destination dans « Tester l\'envoi », à gauche.';
    return;
  }

  box.className = 'test-result show loading';
  box.textContent = 'Envoi en cours…';
  try {
    const result = await api('/system/smtp/test', {
      method: 'POST',
      body: { to, template: admin.templateKey },
    });
    box.className = `test-result show ${result.ok ? 'ok' : 'fail'}`;
    box.textContent = result.message;
  } catch (err) {
    box.className = 'test-result show fail';
    box.textContent = err.message;
  }
}

async function renderConnectionLogs(first = false) {
  const days = $('conn-days').value;
  const params = new URLSearchParams({
    user: $('conn-user').value || 'all',
    result: $('conn-result').value || 'all',
  });
  if (days && days !== '0') params.set('days', days);

  const data = await api(`/admin/logs/connections?${params}`);

  if (first) {
    $('conn-user').innerHTML =
      '<option value="all">Tous</option>' +
      data.users.map((u) => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join('');
    $('retention-select').innerHTML = data.retentionOptions
      .map((o) => `<option value="${o.days}" ${o.days === data.retentionDays ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('');
  }

  $('connexions-table').innerHTML =
    `<thead><tr>${thLogs('logs-connexions', 'user', 'Utilisateur')}${thLogs('logs-connexions', 'date', 'Date')}
       ${thLogs('logs-connexions', 'os', 'OS')}${thLogs('logs-connexions', 'browser', 'Navigateur')}
       ${thLogs('logs-connexions', 'ip', 'IP')}${thLogs('logs-connexions', 'status', 'Résultat')}
     </tr></thead><tbody>` +
    (data.logs.length
      ? trierLogs('logs-connexions', data.logs, (l) => fmt.parse(l.date)?.getTime() || 0)
          .map(
            (l) => `
      <tr>
        <td data-label="Utilisateur" style="color:var(--text);">${esc(l.username)}</td>
        <td data-label="Date" title="${esc(fmt.exact(l.date))}">${esc(fmt.dateTime(l.date))}</td>
        <td data-label="OS">${esc(l.os)}</td>
        <td data-label="Navigateur">${esc(l.browser)}</td>
        <td data-label="IP">${esc(l.ip)}</td>
        <td data-label="Résultat">${l.success ? '<span class="badge-pill green">Succès</span>' : '<span class="badge-pill red">Échec</span>'}</td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="empty-state">Aucune connexion sur cette période.</td></tr>') +
    '</tbody>';
}

async function clearConnectionLogs() {
  if (!confirm('Vider tout le journal des connexions ?')) return;
  const result = await api('/admin/logs/connections', { method: 'DELETE' });
  await renderSecurityPage();
  showToast(`${result.deleted} ligne(s) supprimée(s)`);
}

async function saveRetention() {
  const result = await api('/admin/logs/retention', {
    method: 'PUT',
    body: { days: Number($('retention-select').value) },
  });
  showToast(
    `Conservation réglée à ${result.retentionDays} jours` +
      (result.purged ? ` — ${result.purged} ligne(s) purgée(s)` : '')
  );
  await renderSecurityPage();
}

// ===========================================================================
// Logs (onglets)
// ===========================================================================

function setLogsTab(tab, el) {
  admin.logsTab = tab;
  document.querySelectorAll('#logs-subnav .pill').forEach((p) => p.classList.remove('active'));
  if (el) el.classList.add('active');
  renderLogs();
}

function renderLogs() {
  if (admin.logsTab === 'application') return renderAppLogs();
  if (admin.logsTab === 'stockage') return renderStorageLogs();
  return renderRunLogs();
}

/**
 * Cellule de message : tronquée sur une ligne, dépliée au clic.
 * Le texte complet reste accessible au survol (title) comme au clic, sans
 * jamais forcer la largeur du tableau.
 */
function messageCell(text, label = 'Détail') {
  const value = String(text || '');
  if (!value) return `<td class="cell-grow" data-label="${esc(label)}"></td>`;
  return `<td class="cell-grow" data-label="${esc(label)}">
    <div class="cell-ellipsis cell-expand" title="${esc(value)}" onclick="toggleCell(this)">${esc(value)}</div>
  </td>`;
}

function toggleCell(el) {
  el.classList.toggle('open');
}

/**
 * Tris des journaux (lot 10).
 *
 * Un journal se lit du plus récent au plus ancien : c'est le défaut des quatre
 * onglets, et il est SENSÉ — un journal trié alphabétiquement ne se lit pas.
 *
 * Chaque colonne déclare l'accès à sa donnée : une date part en millisecondes
 * (`fmt.parse`), un compte de factures en nombre. Le tri ne voit jamais la
 * chaîne affichée — « il y a 3 h » se rangerait avant « il y a 2 j ».
 */
const LOGS_TRIS = {
  'logs-runs': {
    defaut: { key: 'date', dir: 'desc' },
    acces: {
      connector: (l) => l.connectorName,
      user: (l) => l.username,
      date: (l) => fmt.parse(l.started_at)?.getTime() || null,
      trigger: (l) => l.trigger,
      count: (l) => l.invoice_count,
      status: (l) => !!l.success,
      message: (l) => l.message || '',
    },
  },
  'logs-app': {
    defaut: { key: 'date', dir: 'desc' },
    acces: {
      // « erreur » d'abord quand on trie par niveau : c'est ce qu'on cherche.
      level: (l) => ({ error: 'a', warn: 'b', info: 'c' }[l.level] || 'd'),
      date: (l) => fmt.parse(l.at)?.getTime() || null,
      source: (l) => l.source,
      message: (l) => l.message || '',
      user: (l) => l.username || '',
    },
  },
  'logs-storage': {
    defaut: { key: 'date', dir: 'desc' },
    acces: {
      dest: (l) => l.destName,
      date: (l) => fmt.parse(l.at)?.getTime() || null,
      user: (l) => l.username || '',
      status: (l) => !!l.success,
      message: (l) => l.message || '',
    },
  },
  'logs-connexions': {
    defaut: { key: 'date', dir: 'desc' },
    acces: {
      user: (l) => l.username,
      date: (l) => fmt.parse(l.date)?.getTime() || null,
      os: (l) => l.os,
      browser: (l) => l.browser,
      ip: (l) => l.ip,
      status: (l) => !!l.success,
    },
  },
};

/** Le tri retenu pour un journal, ou celui que l'écran juge sensé. */
function logsSort(screen) {
  return sortOf(screen, LOGS_TRIS[screen].defaut);
}

/**
 * Trie les lignes d'un journal.
 *
 * Le départage se fait sur la date : deux lignes de même niveau doivent rester
 * dans l'ordre chronologique, sinon un journal trié par source devient
 * illisible.
 */
function trierLogs(screen, logs, date) {
  return uiPrefs.trier(logs, logsSort(screen), LOGS_TRIS[screen].acces, date);
}

/** En-tête triable d'un journal : même forme partout. */
function thLogs(screen, key, label) {
  return uiPrefs.enTeteTriable({
    tri: logsSort(screen),
    key,
    label,
    onclick: `sortLogs('${screen}', '${key}')`,
  });
}

function sortLogs(screen, key) {
  // Une date ou un compte se lit du plus grand au plus petit ; un texte, dans
  // l'ordre alphabétique.
  const naturel = ['date', 'count'].includes(key) ? 'desc' : 'asc';
  setSort(screen, uiPrefs.basculer(logsSort(screen), key, naturel));
  if (screen === 'logs-connexions') return void renderConnectionLogs();
  renderLogs();
}

/**
 * Le statut d'une ligne d'exécution, SANS confondre « en cours » et « échec ».
 *
 * Une ligne de run_logs naît au démarrage de l'exécution : tant que
 * `finished_at` est vide, `success = 0` ne dit rien du résultat. Le 14/08/2026,
 * ce badge affichait « Échec » (détail vide) sur un rattrapage SoYouStart en
 * plein travail — qui a fini par ranger 53 factures.
 */
function runStatusBadge(l) {
  // Une ligne de JOURNAL n'est pas un résultat : c'est ce que le connecteur
  // écrivait en plein travail (lot 41). Ni succès, ni échec, ni en cours.
  if (l.kind === 'journal') return '<span class="badge-pill gray">Journal</span>';
  if (!l.finished_at) return '<span class="badge-pill blue">En cours</span>';
  return l.success
    ? '<span class="badge-pill green">Succès</span>'
    : '<span class="badge-pill red">Échec</span>';
}

async function renderRunLogs() {
  const filter = admin.runFilter || 'all';
  const result = admin.runResult || 'all';
  const search = admin.runSearch || '';
  const data = await api(
    `/admin/logs/runs?connector=${encodeURIComponent(filter)}&result=${result}&q=${encodeURIComponent(search)}`
  );

  $('logs-content').innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="runs-search" placeholder="Rechercher dans les messages" value="${esc(search)}"
               oninput="admin.runSearch = this.value; debounceLogs()">
      </div>
      <label class="toolbar-field">Connecteur
        <select onchange="admin.runFilter = this.value; renderRunLogs()">
          ${[{ id: 'all', name: 'Tous' }]
            .concat(data.filters)
            .map((f) => `<option value="${esc(f.id)}" ${filter === f.id ? 'selected' : ''}>${esc(f.name)}</option>`)
            .join('')}
        </select>
      </label>
      <label class="toolbar-field">Résultat
        <select onchange="admin.runResult = this.value; renderRunLogs()">
          <option value="all" ${result === 'all' ? 'selected' : ''}>Tous</option>
          <option value="success" ${result === 'success' ? 'selected' : ''}>Succès</option>
          <option value="failure" ${result === 'failure' ? 'selected' : ''}>Échecs</option>
        </select>
      </label>
      <span class="toolbar-note">Conservation : ${data.retentionDays} jours (réglable dans Sécurité)</span>
      <button class="btn-mini danger" onclick="purgeLogs('runs')">Purger</button>
    </div>
    <table class="data-table wide">
      <thead>
        <tr>${thLogs('logs-runs', 'connector', 'Connecteur')}${thLogs('logs-runs', 'user', 'Utilisateur')}
            ${thLogs('logs-runs', 'date', 'Date')}${thLogs('logs-runs', 'trigger', 'Déclencheur')}
            ${thLogs('logs-runs', 'count', 'Factures')}${thLogs('logs-runs', 'status', 'Statut')}
            ${thLogs('logs-runs', 'message', 'Détail')}</tr>
      </thead>
      <tbody>
      ${(() => {
        // Les exécutions ET le journal détaillé des connecteurs (lot 41),
        // entremêlés par la date : sous chaque exécution, ce que le connecteur
        // a écrit en la menant. C'est ce journal qui manquait le 19/08/2026
        // pour comprendre un « Aucune nouvelle facture ».
        const lignes = data.logs.concat(data.journal || []);
        if (!lignes.length) {
          return '<tr><td colspan="7" class="empty-state">Aucune exécution enregistrée.</td></tr>';
        }
        return trierLogs('logs-runs', lignes, (l) => fmt.parse(l.started_at)?.getTime() || 0)
          .map(
            (l) => `
        <tr${l.kind === 'journal' ? ' style="opacity:.78;"' : ''}>
          <td data-label="Connecteur" style="color:var(--text);">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="badge-logo" style="width:22px;height:22px;font-size:8px;background:${esc(l.color)};">${esc(l.letters)}${logoHtml(l)}</span>
              ${esc(l.connectorName)}
            </div>
          </td>
          <td data-label="Utilisateur">${esc(l.username || '—')}</td>
          <td data-label="Date" title="${esc(fmt.exact(l.started_at))}">${esc(fmt.dateTime(l.started_at))}</td>
          <td data-label="Déclencheur">${l.kind === 'journal' ? '—' : esc(l.trigger)}</td>
          <td data-label="Factures">${l.kind === 'journal' || !l.finished_at ? '—' : l.invoice_count}</td>
          <td data-label="Statut">${runStatusBadge(l)}</td>
          ${messageCell(l.message)}
        </tr>`
          )
          .join('');
      })()}
      </tbody>
    </table>`;
}

let logsDebounce = null;
function debounceLogs() {
  clearTimeout(logsDebounce);
  logsDebounce = setTimeout(() => renderLogs(), 250);
}

async function renderAppLogs() {
  const level = admin.appLevel || 'all';
  const search = admin.appSearch || '';
  const data = await api(`/admin/logs/app?level=${level}&q=${encodeURIComponent(search)}`);

  $('logs-content').innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="app-search" placeholder="Rechercher (message, source, compte)" value="${esc(search)}"
               oninput="admin.appSearch = this.value; debounceLogs()">
      </div>
      <label class="toolbar-field">Niveau
        <select onchange="admin.appLevel = this.value; renderAppLogs()">
          <option value="all" ${level === 'all' ? 'selected' : ''}>Tous (${data.counts.all})</option>
          ${data.levels
            .map(
              (l) => `<option value="${esc(l.id)}" ${level === l.id ? 'selected' : ''}>${esc(l.label)} (${data.counts[l.id]})</option>`
            )
            .join('')}
        </select>
      </label>
      <span class="toolbar-note">Conservation : ${data.retentionDays} jours</span>
      <button class="btn-mini danger" onclick="purgeLogs('app')">Purger</button>
    </div>
    <table class="data-table wide">
      <thead>
        <tr>${thLogs('logs-app', 'level', 'Niveau')}${thLogs('logs-app', 'date', 'Date')}
            ${thLogs('logs-app', 'source', 'Source')}${thLogs('logs-app', 'message', 'Message')}
            ${thLogs('logs-app', 'user', 'Compte')}</tr>
      </thead>
      <tbody>
      ${
        data.logs.length
          ? trierLogs('logs-app', data.logs, (l) => fmt.parse(l.at)?.getTime() || 0)
              .map(
                (l) => `
        <tr>
          <td data-label="Niveau"><span class="badge-pill ${l.level === 'error' ? 'red' : l.level === 'warn' ? 'amber' : 'gray'}">${esc(l.level)}</span></td>
          <td data-label="Date" title="${esc(fmt.exact(l.at))}">${esc(fmt.dateTime(l.at))}</td>
          <td data-label="Source">${esc(l.source)}</td>
          ${messageCell(l.message, 'Message')}
          <td data-label="Compte">${esc(l.username || '—')}</td>
        </tr>`
              )
              .join('')
          : '<tr><td colspan="5" class="empty-state">Aucun événement applicatif enregistré.</td></tr>'
      }
      </tbody>
    </table>`;
}

async function renderStorageLogs() {
  const dest = admin.destFilter || 'all';
  const result = admin.destResult || 'all';
  const data = await api(`/admin/logs/storage?dest=${dest}&result=${result}`);

  $('logs-content').innerHTML = `
    <div class="toolbar">
      <label class="toolbar-field">Destination
        <select onchange="admin.destFilter = this.value; renderStorageLogs()">
          ${[{ id: 'all', name: 'Toutes' }]
            .concat(data.filters)
            .map((f) => `<option value="${esc(f.id)}" ${dest === f.id ? 'selected' : ''}>${esc(f.name)}</option>`)
            .join('')}
        </select>
      </label>
      <label class="toolbar-field">Résultat
        <select onchange="admin.destResult = this.value; renderStorageLogs()">
          <option value="all" ${result === 'all' ? 'selected' : ''}>Tous</option>
          <option value="success" ${result === 'success' ? 'selected' : ''}>Succès</option>
          <option value="failure" ${result === 'failure' ? 'selected' : ''}>Échecs</option>
        </select>
      </label>
      <span class="toolbar-note">Conservation : ${data.retentionDays} jours</span>
      <button class="btn-mini danger" onclick="purgeLogs('storage')">Purger</button>
    </div>
    <table class="data-table wide">
      <thead>
        <tr>${thLogs('logs-storage', 'dest', 'Destination')}${thLogs('logs-storage', 'date', 'Date')}
            ${thLogs('logs-storage', 'user', 'Compte')}${thLogs('logs-storage', 'status', 'Résultat')}
            ${thLogs('logs-storage', 'message', 'Détail')}</tr>
      </thead>
      <tbody>
      ${
        data.logs.length
          ? trierLogs('logs-storage', data.logs, (l) => fmt.parse(l.at)?.getTime() || 0)
              .map(
                (l) => `
        <tr>
          <td data-label="Destination" style="color:var(--text);">${esc(l.destName)}</td>
          <td data-label="Date" title="${esc(fmt.exact(l.at))}">${esc(fmt.dateTime(l.at))}</td>
          <td data-label="Compte">${esc(l.username || '—')}</td>
          <td data-label="Résultat">${l.success ? '<span class="badge-pill green">OK</span>' : '<span class="badge-pill red">Échec</span>'}</td>
          ${messageCell(l.message)}
        </tr>`
              )
              .join('')
          : '<tr><td colspan="5" class="empty-state">Aucune opération de stockage enregistrée.</td></tr>'
      }
      </tbody>
    </table>`;
}

async function purgeLogs(kind) {
  const labels = { runs: 'des exécutions', app: 'applicatif', storage: 'de stockage' };
  if (!confirm(`Vider le journal ${labels[kind]} ?`)) return;
  try {
    const result = await api(`/admin/logs/${kind}`, { method: 'DELETE' });
    await renderLogs();
    showToast(`${result.deleted} ligne(s) supprimée(s)`);
  } catch (err) {
    showToast(err.message);
  }
}

// ===========================================================================
// Support
// ===========================================================================

async function renderSupport() {
  const data = await api(`/tickets?status=${encodeURIComponent(admin.supportFilter)}`);
  admin.supportCounts = data.counts;

  const cards = [
    { key: 'unread', label: 'Non lues', value: data.counts.unread, tone: 'blue' },
    { key: 'en-cours', label: 'En cours', value: data.counts['en-cours'], tone: 'amber' },
    { key: 'repondu', label: 'Répondues', value: data.counts.repondu, tone: 'green' },
    { key: 'ferme', label: 'Clôturées', value: data.counts.ferme, tone: 'gray' },
    { key: 'all', label: 'Total', value: data.counts.all, tone: 'plain' },
  ];

  $('support-stats').innerHTML = cards
    .map(
      (c) => `
    <button class="stat-card ${c.tone} ${admin.supportFilter === c.key ? 'active' : ''}"
            onclick="setSupportFilter('${c.key}')">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${esc(c.label)}</div>
    </button>`
    )
    .join('');

  // La colonne de droite ne reste jamais vide sans explication.
  if (!data.tickets.some((t) => t.id === admin.supportSelected)) {
    admin.supportSelected = null;
    showSupportPlaceholder();
  }

  admin.tickets = data.tickets;
  renderSupportList();
  refreshSupportBadge();
}

/**
 * Les non-lues d'abord : c'est ce qu'on vient faire sur cet écran.
 *
 * À égalité, la plus récente en tête — une demande arrivée ce matin passe
 * devant celle d'il y a trois semaines.
 */
const SUPPORT_TRI_DEFAUT = { key: 'unread', dir: 'asc' };

/** Le tri porte sur la donnée : `createdAt` en millisecondes, jamais « il y a 3 h ». */
const SUPPORT_ACCES = {
  unread: (t) => (t.unread ? 'a' : 'b'),
  date: (t) => fmt.parse(t.createdAt)?.getTime() || null,
  subject: (t) => t.subject,
  user: (t) => t.username || '',
  status: (t) => t.status,
  replies: (t) => t.replyCount || 0,
};

function supportSort() {
  return sortOf('support', SUPPORT_TRI_DEFAUT);
}

function sortSupport(key) {
  const naturel = ['date', 'replies'].includes(key) ? 'desc' : 'asc';
  setSort('support', uiPrefs.basculer(supportSort(), key, naturel));
  renderSupportList();
}

function setSupportView(mode) {
  setViewMode('support', mode);
  renderSupportList();
}

function renderSupportList() {
  renderViewToggle('support-view-switch', 'support', 'setSupportView');
  const tri = supportSort();
  if ($('support-sort')) $('support-sort').value = tri.key;

  // Départage sur la date, décroissante : deux demandes non lues se rangent de
  // la plus récente à la plus ancienne.
  const tickets = uiPrefs.trier(
    admin.tickets || [],
    tri,
    SUPPORT_ACCES,
    (t) => -(fmt.parse(t.createdAt)?.getTime() || 0)
  );

  if (!tickets.length) {
    $('support-list').innerHTML =
      '<div class="empty-state">Aucune demande dans cette catégorie.</div>';
    return;
  }

  $('support-list').innerHTML =
    viewMode('support') === 'cards'
      ? `<div class="card-grid">${tickets.map(ticketCard).join('')}</div>`
      : tickets.map(ticketRow).join('');
}

function ticketRow(t) {
  return `
      <div class="ticket-item ${t.unread ? 'unread' : ''} ${t.id === admin.supportSelected ? 'selected' : ''}"
           onclick="openSupportDetail(${t.id})">
        <div class="ticket-item-top">
          <div class="ticket-subject">${esc(t.subject)}</div>
          ${ticketBadge(t)}
          ${t.replyCount ? `<span class="badge-pill gray">${t.replyCount} réponse(s)</span>` : ''}
        </div>
        <div class="ticket-meta">
          ${esc(t.username || 'compte supprimé')} ·
          <span title="${esc(fmt.exact(t.createdAt))}">${esc(fmt.relative(t.createdAt))}</span>
          ${t.hiddenByUser ? ' · retiré côté utilisateur (conservé ici)' : ''}
        </div>
      </div>`;
}

function ticketCard(t) {
  return `
  <div class="app-card ticket-card ${t.unread ? 'unread' : ''} ${t.id === admin.supportSelected ? 'selected' : ''}"
       onclick="openSupportDetail(${t.id})">
    <div class="app-card-head">
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(t.subject)}</div>
        <div class="app-card-sub">${esc(t.username || 'compte supprimé')}</div>
      </div>
      ${ticketBadge(t)}
    </div>
    <div class="app-card-facts">
      <div><span class="fact-label">Ouverte</span>
        <span class="fact-value" title="${esc(fmt.exact(t.createdAt))}">${esc(fmt.relative(t.createdAt))}</span></div>
      <div><span class="fact-label">Réponses</span>
        <span class="fact-value">${t.replyCount || 0}</span></div>
    </div>
    ${t.hiddenByUser ? '<div class="app-card-sub">retiré côté utilisateur, conservé ici</div>' : ''}
  </div>`;
}

function setSupportFilter(key) {
  admin.supportFilter = key;
  renderSupport();
}

/** Colonne de droite quand aucune demande n'est sélectionnée. */
function showSupportPlaceholder() {
  $('support-detail').innerHTML = `
    <div class="col-placeholder">
      Sélectionnez une demande à gauche pour lire le fil de conversation
      et y répondre.
    </div>`;
}

async function openSupportDetail(id) {
  const { ticket } = await api(`/tickets/${id}`);
  admin.supportSelected = id;
  document.querySelectorAll('#support-list .ticket-item').forEach((item) => {
    item.classList.toggle('selected', item.getAttribute('onclick') === `openSupportDetail(${id})`);
  });

  $('support-detail').innerHTML = `
    <div class="ticket-detail">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div style="font-size:15px;font-weight:500;flex:1;">${esc(ticket.subject)}</div>
        ${ticketBadge(ticket)}
      </div>
      <div class="ticket-meta" style="margin-bottom:14px;">
        ${esc(ticket.username || 'compte supprimé')} ·
        ouverte <span title="${esc(fmt.exact(ticket.createdAt))}">${esc(fmt.relative(ticket.createdAt))}</span>
        ${ticket.readAt ? ` · lue ${esc(fmt.relative(ticket.readAt))}` : ''}
        ${ticket.hiddenByUser ? ' · masquée côté utilisateur, conservée ici' : ''}
      </div>

      ${threadHtml(ticket.messages)}

      <div class="field" style="margin-top:16px;">
        <label>Réponse</label>
        <textarea id="support-reply" placeholder="Écrire une réponse…"></textarea>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn-mini" onclick="sendSupportReply(${ticket.id})">Envoyer la réponse</button>
        <button class="btn-mini" onclick="setTicketStatus(${ticket.id},'en-cours')">Marquer en cours</button>
        <button class="btn-mini" onclick="setTicketStatus(${ticket.id},'ferme')">Clôturer</button>
      </div>
    </div>`;

  // Ouvrir marque comme lu côté serveur : les compteurs bougent.
  await renderSupportCountsOnly();
}

async function renderSupportCountsOnly() {
  const data = await api(`/tickets?status=${encodeURIComponent(admin.supportFilter)}`);
  admin.supportCounts = data.counts;
  const values = {
    unread: data.counts.unread,
    'en-cours': data.counts['en-cours'],
    repondu: data.counts.repondu,
    ferme: data.counts.ferme,
    all: data.counts.all,
  };
  document.querySelectorAll('#support-stats .stat-card').forEach((card, index) => {
    const key = ['unread', 'en-cours', 'repondu', 'ferme', 'all'][index];
    card.querySelector('.stat-value').textContent = values[key];
  });
  refreshSupportBadge();
}

async function sendSupportReply(id) {
  const message = $('support-reply').value.trim();
  if (!message) return void showToast('La réponse est vide');
  try {
    await api(`/tickets/${id}/reply`, { method: 'POST', body: { message } });
    await renderSupport();
    await openSupportDetail(id);
    showToast('Réponse envoyée');
  } catch (err) {
    showToast(err.message);
  }
}

async function setTicketStatus(id, status) {
  try {
    await api(`/tickets/${id}`, { method: 'PATCH', body: { status } });
    await renderSupport();
    await openSupportDetail(id);
    showToast('Demande mise à jour');
  } catch (err) {
    showToast(err.message);
  }
}

// ===========================================================================
// Système
// ===========================================================================

/** Une ligne « libellé / valeur » des deux colonnes de la page Système. */
function sysRow(name, value) {
  return `<div class="storage-row">
    <div class="storage-row-name">${esc(name)}</div>
    <div class="storage-row-val">${value}</div>
  </div>`;
}

/** État du montage du stockage local, en une pastille et une phrase. */
function localRowValue(local) {
  const states = {
    ok: ['green', 'accessible en écriture'],
    unset: ['amber', 'aucun chemin configuré'],
    missing: ['red', 'absent — rien à ce chemin'],
    'not-directory': ['red', 'le chemin n\'est pas un dossier'],
    'not-mounted': ['red', 'non monté — dossier local du conteneur'],
    'read-only': ['red', 'monté mais non inscriptible'],
  };
  const [tone, label] = states[local.state] || ['gray', 'état inconnu'];
  return `
    <span class="badge-pill ${tone}">${esc(label)}</span>
    ${esc(local.path || 'non configurée')} (${esc(local.protocol)}${local.mounted ? ', point de montage' : ''})`;
}

async function renderSysteme() {
  const data = await api('/system');
  const s = data.stats;
  const runtime = data.runtime;
  const canConfigure = can('security.manage');

  const timezoneMismatch = runtime.systemTimezone && runtime.systemTimezone !== runtime.timezone;

  $('systeme-content').innerHTML = `
    <div class="split-2">
      <div>
        <div class="col-head">Logiciel</div>
        <div class="col-sub">Ce qui tourne, et depuis quand</div>
        <div class="storage-rows">
          ${sysRow('Version de crabe', `v${esc(data.version)} <button class="btn-mini" style="margin-left:10px;" onclick="checkUpdates()">Vérifier les mises à jour</button>`)}
          ${sysRow('Build', `schéma v${data.schemaVersion} · ${esc(data.env)}`)}
          ${sysRow('Node.js', `${esc(data.node)} <span class="text-faint">sur ${esc(data.hostname)}</span>`)}
          ${sysRow(
            'Uptime du service',
            `${esc(fmt.duration(data.uptimeSeconds))} <span class="text-faint">· hôte : ${esc(fmt.duration(data.hostUptimeSeconds))}</span>`
          )}
          ${sysRow(
            'Scheduler',
            `${data.scheduler.disabled ? '<span class="badge-pill amber">désactivé</span>' : `${data.scheduler.activeTasks} tâche(s)`}
             <br><span class="text-faint">dernier passage : ${esc(fmt.relative(data.scheduler.lastCronAt, 'aucun depuis le démarrage'))}
             · dernier entretien : ${esc(fmt.relative(data.scheduler.lastMaintenanceAt, 'aucun depuis le démarrage'))}</span>`
          )}
          ${sysRow('Exécutions réussies (30 j)', `${s.reliability30d} %`)}
          ${sysRow(
            'Heure du serveur',
            `${esc(fmt.dateTime(runtime.serverTime))} <span class="text-faint">· fuseau ${esc(runtime.timezone)}</span>
             ${
               timezoneMismatch
                 ? `<span class="badge-pill amber" title="Le conteneur est en ${esc(runtime.systemTimezone)}">système : ${esc(runtime.systemTimezone)}</span>`
                 : ''
             }
             ${canConfigure ? `<button class="btn-mini" style="margin-left:10px;" onclick="openDatetimeModal()">Configurer</button>` : ''}`
          )}
        </div>
      </div>

      <div>
        <div class="col-head">Infrastructure</div>
        <div class="col-sub">Ce dont crabe dépend sur le serveur, et ce qu'il consomme</div>
        <div class="storage-rows">
          ${sysRow(
            'Base SQLite',
            `${esc(fmt.bytes(runtime.dbSizeBytes))} <span class="text-faint">· ${esc(runtime.dbFile)}</span>`
          )}
          ${sysRow(
            'Disque restant',
            `${runtime.diskFreeBytes === null ? 'inconnu' : esc(fmt.bytes(runtime.diskFreeBytes))}
             <span class="text-faint">· ${esc(runtime.dataDir)}</span>`
          )}
          ${sysRow('Montage du stockage local', localRowValue(data.local))}
          ${sysRow('Binaire rclone', '<span id="sys-rclone">vérification…</span>')}
          ${sysRow(
            'Playwright',
            data.playwright.available
              ? '<span class="badge-pill green">disponible</span> les connecteurs de scraping peuvent tourner'
              : '<span class="badge-pill amber">absent</span> les connecteurs de scraping restent en mode simulé'
          )}
          ${sysRow(
            'Serveur SMTP',
            data.smtpConfigured
              ? '<span class="badge-pill green">configuré</span>'
              : '<span class="badge-pill amber">non configuré</span> le changement d\'e-mail par confirmation est indisponible'
          )}
          ${sysRow('Utilisateurs actifs', `${s.usersActive} / ${s.usersTotal}`)}
          ${sysRow(
            'Connecteurs installés',
            `${s.connectorsInstalled} <span class="text-faint">· ${s.connectorsAvailable} disponibles</span>`
          )}
          ${sysRow('Factures récupérées', esc(fmt.number(s.invoicesTotal)))}
          ${sysRow('Espace utilisé', esc(fmt.bytes(s.storageBytes)))}
          ${sysRow(
            'Cookie de session',
            `${runtime.cookieSecure ? 'Secure exigé (HTTPS)' : 'Secure désactivé (HTTP sur le LAN)'}
             <span class="text-faint">· ${runtime.trustProxy} proxy(s) de confiance</span>`
          )}
        </div>
      </div>
    </div>


    ${
      data.connectorLoadErrors.length
        ? `<div class="sec-note" style="margin-top:18px;color:var(--red);">
             <strong>Connecteurs ignorés au démarrage :</strong><br>${data.connectorLoadErrors.map(esc).join('<br>')}
           </div>`
        : ''
    }`;

  loadRcloneStatus();
}

/** Ouvre la modale Date et heure, listes remplies au moment de l'ouverture. */
async function openDatetimeModal() {
  await fillDisplaySettings();
  $('datetime-overlay').classList.add('show');
}

function closeDatetimeModal() {
  $('datetime-overlay').classList.remove('show');
}

async function fillDisplaySettings() {
  const data = await api('/system/settings');
  const current = data.settings;

  $('set-timezone').innerHTML = (data.timezones || [current.timezone])
    .map((tz) => `<option value="${esc(tz)}" ${tz === current.timezone ? 'selected' : ''}>${esc(tz)}</option>`)
    .join('');
  $('set-time-format').innerHTML = data.timeFormats
    .map((f) => `<option value="${esc(f.id)}" ${f.id === current.timeFormat ? 'selected' : ''}>${esc(f.label)}</option>`)
    .join('');
  $('set-date-format').innerHTML = data.dateFormats
    .map((f) => `<option value="${esc(f.id)}" ${f.id === current.dateFormat ? 'selected' : ''}>${esc(f.label)}</option>`)
    .join('');
}

async function saveDisplaySettings() {
  try {
    const result = await api('/system/settings', {
      method: 'PUT',
      body: {
        timezone: $('set-timezone').value,
        timeFormat: $('set-time-format').value,
        dateFormat: $('set-date-format').value,
      },
    });
    fmt.configure(result.settings);
    closeDatetimeModal();
    await renderSysteme();
    showToast('Réglages de date et heure enregistrés');
  } catch (err) {
    showToast(err.message);
  }
}

async function loadRcloneStatus() {
  const el = $('sys-rclone');
  if (!el) return;
  try {
    const data = await api('/system/rclone');
    el.innerHTML = data.available
      ? `<span class="badge-pill green">disponible</span> ${esc(data.version)}`
      // Nommer deux fournisseurs n'a plus de sens depuis le lot 25 : ce qui est
      // inutilisable sans rclone, c'est TOUT espace en ligne, quel qu'il soit.
      : `<span class="badge-pill amber">absent</span> ${esc(data.binary)} — aucun espace de stockage en ligne ne peut fonctionner`;
  } catch {
    el.textContent = 'indisponible';
  }
}

async function checkUpdates() {
  const result = await api('/system/update-check', { method: 'POST' });
  showToast(result.message);
}

// ---------------------------------------------------------------------------
// Optimisation (lot 60)
//
// Cinq volets d'entretien de la machine. Ce que chaque volet libérerait est
// MESURÉ par le serveur à l'affichage (parcours du disque local et de la
// base — aucun service distant sollicité) ; rien ne se déclenche sans geste,
// et tout naît en manuel. Le volet Sauvegardes ne supprime JAMAIS rien seul :
// il liste, et attend une sélection puis une confirmation.
//
// « Globale » est un LANCEMENT GROUPÉ des quatre autres, pas un réglage qui
// les pilote : chaque volet garde ses propres mode et récurrence, la globale
// les exécute tels quels, dans l'ordre sûr — l'écran le dit pour qu'aucune
// ambiguïté ne subsiste sur un écran qui supprime des fichiers.
// ---------------------------------------------------------------------------

/** Dernière réponse de GET /admin/optimisation, pour les gestes de l'écran. */
let ETAT_OPTIMISATION = null;

/** Les libellés des récurrences, dans l'ordre du serveur. */
const RECURRENCE_LABELS = { 1: '1 mois', 3: '3 mois', 6: '6 mois', 12: '1 an', 24: '2 ans' };

async function renderOptimisation() {
  const data = await api('/admin/optimisation');
  ETAT_OPTIMISATION = data;
  const { mesures, reglages, enCours } = data;

  const disque = mesures.disque?.libre != null
    ? `<div class="sec-note">Espace libre sur le volume de données :
         <b>${esc(fmt.bytes(mesures.disque.libre))}</b> sur ${esc(fmt.bytes(mesures.disque.total))}.
         Sous ${esc(fmt.bytes(mesures.disque.seuil))}, crabe fait de lui-même le nettoyage sûr
         (cache seul) et l'écrit au journal — ce filet évite la panne sèche, il ne remplace pas
         l'entretien régulier.</div>`
    : '';

  // ─── La mise en blocs (lot 61) ─────────────────────────────────────────────
  //
  // Le gabarit est celui des cartes de destination de l'écran Stockage :
  // chaque volet dans son cadre, côte à côte, l'état dit AVANT le contenu.
  // La globale n'est pas une cinquième carte — c'est un lancement groupé, elle
  // garde un cadre à part au-dessus de la grille. Le bandeau d'espace libre
  // reste en tête : c'est lui qui donne le contexte de tout l'écran.
  $('optimisation-content').innerHTML = `
    ${encartOptimisationEnCours(enCours)}
    ${disque}
    ${carteGlobale(reglages.globale)}
    <div class="opt-grid">
    ${voletCard('cache', reglages.cache, {
      titre: 'Cache des navigateurs',
      sousTitre: 'Le cache reconstructible des profils — jamais les cookies, sessions ou jetons anti-robot',
      etat: etatVolet('cache', mesures),
      corps: corpsCache(mesures.cache),
      bouton: 'Vider le cache maintenant',
    })}
    ${voletCard('profils', reglages.profils, {
      titre: 'Profils non utilisés',
      sousTitre: `Connecteur désinstallé, ou sans activité mesurée depuis plus de ${mesures.profils.sommeilMois} mois`,
      etat: etatVolet('profils', mesures),
      corps: corpsProfils(mesures.profils),
      bouton: 'Supprimer ces profils maintenant',
    })}
    ${voletCard('cloud', reglages.cloud, {
      titre: 'Cloud non utilisé',
      sousTitre: 'Les configurations supprimées et les traces d\'échec qui pointent encore vers elles',
      etat: etatVolet('cloud', mesures),
      corps: corpsCloud(mesures.cloud),
      bouton: 'Nettoyer maintenant',
    })}
    ${voletCard('sauvegardes', reglages.sauvegardes, {
      titre: 'Sauvegardes de la base',
      sousTitre: 'Ce volet liste et demande — il ne supprime jamais rien sans votre accord',
      etat: etatVolet('sauvegardes', mesures),
      corps: corpsSauvegardes(mesures.sauvegardes),
      bouton: 'Faire le point maintenant',
    })}
    </div>`;
}

/**
 * L'état d'une carte, dit avant de la lire (lot 61) : quelque chose à libérer
 * (avec le volume mesuré), rien à faire, ou — Sauvegardes — un volet qui ne
 * supprime jamais seul. Les couleurs sont celles du bandeau (lot 59) : la
 * couleur double le texte, elle ne le remplace jamais.
 */
function etatVolet(volet, mesures) {
  if (volet === 'cache') {
    return mesures.cache.octets
      ? { tone: 'amber', texte: `${fmt.bytes(mesures.cache.octets)} à libérer` }
      : { tone: 'green', texte: 'rien à faire' };
  }
  if (volet === 'profils') {
    return mesures.profils.candidats.length
      ? { tone: 'amber', texte: `${mesures.profils.candidats.length} profil(s) — ${fmt.bytes(mesures.profils.octets)} à libérer` }
      : { tone: 'green', texte: 'rien à faire' };
  }
  if (volet === 'cloud') {
    return mesures.cloud.nettoyables
      ? { tone: 'amber', texte: `${mesures.cloud.nettoyables} configuration(s) à retirer` }
      : { tone: 'green', texte: 'rien à faire' };
  }
  // Sauvegardes : même en automatique ce volet fait le point et attend — son
  // état le dit, en bleu : ni « à libérer » (rien ne partira seul), ni « rien
  // à faire » (il y a bien quelque chose à décider).
  return mesures.sauvegardes.fichiers.length
    ? {
        tone: 'blue',
        texte: `${mesures.sauvegardes.fichiers.length} sauvegarde(s), `
          + `${fmt.bytes(mesures.sauvegardes.octets)} — votre geste décide`,
      }
    : { tone: 'green', texte: 'rien à faire' };
}

/** Le badge de mode, identique sur la globale et chaque carte. */
function badgeModeOptimisation(reglage) {
  return `<span class="badge-pill ${reglage.mode === 'automatique' ? 'green' : ''}">${reglage.mode === 'automatique' ? 'Automatique' : 'Manuel'}</span>`;
}

/**
 * Une explication longue se replie, jamais ne se supprime — le mécanisme
 * `fieldHelp` du lot 57 (`<details>`, au navigateur), appliqué à un corps qui
 * contient déjà du HTML : la première phrase reste visible, la suite attend
 * « Tout lire ».
 */
function repliOptimisation(visibleHtml, suiteHtml) {
  return `<div class="field-help">${visibleHtml}
    <details>
      <summary>Tout lire</summary>
      <div class="field-help-suite">${suiteHtml}</div>
    </details>
  </div>`;
}

/**
 * La globale, dans un cadre qui dit son rôle : un lancement groupé des quatre
 * volets, pas un cinquième volet de même nature — elle ne se mêle donc pas à
 * leur grille.
 */
function carteGlobale(reglage) {
  return `
  <div class="opt-globale">
    <div class="block-head" style="margin-bottom:10px;">
      <div>
        <div class="block-title">Optimisation globale</div>
        <div class="block-sub">Lance les quatre volets ci-dessous d'un seul geste, chacun avec ses garde-fous</div>
      </div>
      ${badgeModeOptimisation(reglage)}
    </div>
    ${repliOptimisation(
      'Un raccourci, pas un réglage au-dessus des autres.',
      `Chaque volet garde son propre mode et sa propre récurrence, la globale les exécute
       tels quels — et le volet Sauvegardes, même lancé par la globale, se contente de
       faire le point sans rien supprimer.`
    )}
    ${ligneReglagesOptimisation('globale', reglage, 'Tout lancer maintenant')}
  </div>`;
}

/** Mode, récurrence, bouton et dernier passage — la même ligne partout. */
function ligneReglagesOptimisation(volet, reglage, bouton) {
  const passe = reglage.dernierPassage
    ? `dernier passage <span title="${esc(fmt.exact(reglage.dernierPassage))}">${esc(fmt.relative(reglage.dernierPassage))}</span>`
    : 'jamais passé';
  return `
    <div class="opt-controls">
      <select id="opt-mode-${volet}" onchange="reglerVoletOptimisation('${volet}')">
        <option value="manuel" ${reglage.mode === 'manuel' ? 'selected' : ''}>Manuel — seulement quand je le lance</option>
        <option value="automatique" ${reglage.mode === 'automatique' ? 'selected' : ''}>Automatique — à la récurrence choisie</option>
      </select>
      <select id="opt-rec-${volet}" onchange="reglerVoletOptimisation('${volet}')"
              title="La récurrence ne vaut qu'en mode automatique">
        ${[1, 3, 6, 12, 24].map((m) => `<option value="${m}" ${reglage.recurrenceMois === m ? 'selected' : ''}>Tous les ${RECURRENCE_LABELS[m]}</option>`).join('')}
      </select>
      <button class="btn-mini" style="padding:9px 14px;" onclick="lancerVoletOptimisation('${volet}')">${esc(bouton)}</button>
      <span class="text-faint" style="font-size:12px;">${passe}</span>
    </div>`;
}

/** L'encart d'état, aux mêmes trois couleurs que le bandeau (lot 59). */
function encartOptimisationEnCours(enCours) {
  if (!enCours || (!enCours.running && !enCours.termineLe)) return '';
  const classe = enCours.running ? 'encours' : enCours.echec ? 'echec' : 'succes';
  const phrase = enCours.running
    ? `Nettoyage en cours — ${enCours.faites} volet(s) sur ${enCours.total}.`
    : `${enCours.echec ? 'Nettoyage arrêté sur un échec' : 'Dernier nettoyage terminé'}
       <span title="${esc(fmt.exact(enCours.termineLe))}">${esc(fmt.relative(enCours.termineLe))}</span> —
       ${esc(enCours.message)}`;
  return `<div class="op-item ${classe}" style="border-radius:10px;margin-bottom:14px;cursor:default;">
    <span class="op-dot" aria-hidden="true"></span><span class="op-text">${phrase}</span>
  </div>`;
}

/**
 * La carte d'un volet, au gabarit des cartes de destination (lot 61) : l'état
 * en tête — badge d'état à gauche, mode à droite —, puis titre, sous-titre,
 * corps mesuré, et la ligne de réglages au pied. Rien n'a été retiré du volet
 * d'avant : mode, récurrence, bouton, volume mesuré et dernier passage sont
 * tous là, seulement rangés.
 */
function voletCard(volet, reglage, { titre, sousTitre, corps, bouton, etat }) {
  return `
  <div class="dest-card opt-card" id="opt-card-${volet}">
    <div class="opt-etat-row">
      <span class="badge-pill ${etat.tone}">${esc(etat.texte)}</span>
      ${badgeModeOptimisation(reglage)}
    </div>
    <div class="block-title">${esc(titre)}</div>
    <div class="block-sub" style="margin-bottom:10px;">${esc(sousTitre)}</div>
    ${corps}
    ${ligneReglagesOptimisation(volet, reglage, bouton)}
  </div>`;
}

function corpsCache(cache) {
  const empeches = cache.profils.filter((p) => p.empeche);
  return `
    <div class="sec-note">
      ${cache.octets
        ? `Libérerait <b>${esc(fmt.bytes(cache.octets))}</b>, mesurés à l'instant sur ${cache.profils.filter((p) => !p.empeche && p.octets).length} profil(s).`
        : 'Rien à libérer pour l\'instant.'}
      ${empeches.length
        ? `<br>Non compté : ${empeches.map((p) => `${esc(p.connectorId)} (${esc(p.empeche)})`).join(', ')} — un profil ouvert ou occupé n'est jamais touché.`
        : ''}
    </div>`;
}

function corpsProfils(profils) {
  if (!profils.candidats.length) {
    return '<div class="sec-note">Rien à supprimer : tous les profils présents servent encore, ou ont dormi moins que le seuil.</div>';
  }
  return `
    <div class="sec-note">
      Libérerait <b>${esc(fmt.bytes(profils.octets))}</b> :
      ${profils.candidats.map((p) => `<br>· <code>${esc(p.connectorId)}</code> — ${esc(fmt.bytes(p.octets))},
        ${p.installe ? `dernier signe de vie ${esc(fmt.relative(p.dernierSigne))}` : 'connecteur désinstallé'}`).join('')}
      <br>Chaque suppression est journalisée (poids, durée de sommeil).
    </div>`;
}

function corpsCloud(cloud) {
  if (!cloud.coquilles.length) {
    return '<div class="sec-note">Rien à nettoyer : aucune configuration supprimée ne traîne en base.</div>';
  }
  const gardees = cloud.coquilles.filter((c) => c.copiesReussies);
  return `
    <div class="sec-note">
      ${cloud.nettoyables} configuration(s) supprimée(s) encore en base, et ${cloud.traces} trace(s)
      d'échec qui pointent vers elles dans l'historique des documents.
      ${gardees.length
        ? `<br>${gardees.length} configuration(s) resteront : des copies réussies portent encore leur nom
           (${gardees.map((c) => esc(c.nom)).join(', ')}).`
        : ''}
    </div>
    ${repliOptimisation(
      'Les deux se nettoient ensemble.',
      `Les configurations servent à NOMMER ces traces sur les pastilles des documents :
       les retirer séparément afficherait un identifiant nu à la place d'un nom.`
    )}`;
}

function corpsSauvegardes(sauvegardes) {
  if (!sauvegardes.fichiers.length) {
    return '<div class="sec-note">Aucune sauvegarde de base sur le disque.</div>';
  }
  return `
    <div class="sec-note">
      ${sauvegardes.fichiers.length} sauvegarde(s), <b>${esc(fmt.bytes(sauvegardes.octets))}</b>.
      Cochez ce qui peut partir, puis confirmez : rien n'est supprimé sans votre accord —
      même le mode automatique se contente de refaire ce point.
    </div>
    <div style="margin-top:8px;">
      ${sauvegardes.fichiers.map((s) => `
        <label style="display:flex;gap:9px;align-items:center;padding:5px 0;font-size:12.5px;">
          <input type="checkbox" class="opt-sauvegarde" value="${esc(s.nom)}" data-octets="${s.octets}">
          <code style="overflow-wrap:anywhere;">${esc(s.nom)}</code>
          <span class="text-faint">— ${esc(s.motif)}, ${esc(fmt.bytes(s.octets))},
            <span title="${esc(fmt.exact(s.modifieLe))}">${esc(fmt.relative(s.modifieLe))}</span></span>
        </label>`).join('')}
    </div>
    <button class="btn-mini danger" style="margin-top:8px;padding:9px 14px;"
            onclick="supprimerSauvegardesChoisies()">Supprimer la sélection…</button>`;
}

/** Mode ou récurrence changés : un réglage, jamais un déclenchement. */
async function reglerVoletOptimisation(volet) {
  try {
    await api(`/admin/optimisation/volets/${volet}`, {
      method: 'PUT',
      body: {
        mode: $(`opt-mode-${volet}`).value,
        recurrenceMois: Number($(`opt-rec-${volet}`).value),
      },
    });
    showToast('Réglage enregistré — rien n\'est lancé.');
  } catch (err) {
    showToast(err.message);
  }
  renderOptimisation().catch(() => {});
}

/** « Lancer maintenant » : confirmation quand des sessions sont en jeu. */
async function lancerVoletOptimisation(volet) {
  const risque = {
    profils: () => {
      const m = ETAT_OPTIMISATION?.mesures;
      if (!m?.profils?.candidats?.length) return null;
      return `Supprimer ${m.profils.candidats.length} profil(s) de navigateur (${fmt.bytes(m.profils.octets)}) ?\n\n`
        + 'Les sessions qu\'ils contiennent seront perdues : à la prochaine récupération, il faudra se reconnecter au service.';
    },
    globale: () => {
      const m = ETAT_OPTIMISATION?.mesures;
      return 'Lancer les quatre volets maintenant ?\n\n'
        + `Cache : ${fmt.bytes(m?.cache?.octets || 0)} · profils : ${m?.profils?.candidats?.length || 0} candidat(s) `
        + `(${fmt.bytes(m?.profils?.octets || 0)}) · cloud : ${m?.cloud?.nettoyables || 0} configuration(s). `
        + 'Les sauvegardes ne seront pas touchées : leur volet fait le point et attend votre geste.';
    },
  }[volet];
  const question = risque?.();
  if (question && !confirm(question)) return;

  try {
    const resultat = await api(`/admin/optimisation/volets/${volet}/lancer`, { method: 'POST' });
    showToast(resultat.echec ? resultat.message : 'Terminé — le détail est sur l\'écran et au journal.');
  } catch (err) {
    showToast(err.message);
  }
  veilleOperations().catch(() => {});
  renderOptimisation().catch(() => {});
}

/** Le geste explicite sur les sauvegardes cochées. */
async function supprimerSauvegardesChoisies() {
  const coches = [...document.querySelectorAll('.opt-sauvegarde:checked')];
  if (!coches.length) return void showToast('Cochez d\'abord les sauvegardes à supprimer.');
  const octets = coches.reduce((n, c) => n + Number(c.dataset.octets || 0), 0);
  if (!confirm(
    `Supprimer ${coches.length} sauvegarde(s) de base (${fmt.bytes(octets)}) ?\n\n`
    + 'Elles ne serviront plus à aucune restauration. Les documents et la base actuelle ne sont pas touchés.'
  )) return;

  try {
    const resultat = await api('/admin/optimisation/sauvegardes/suppression', {
      method: 'POST',
      body: { noms: coches.map((c) => c.value) },
    });
    showToast(`${resultat.supprimees} sauvegarde(s) supprimée(s), ${fmt.bytes(resultat.octets)} libérés.`);
  } catch (err) {
    showToast(err.message);
  }
  renderOptimisation().catch(() => {});
}
