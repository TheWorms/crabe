'use strict';

/**
 * Shell applicatif de crabe — écrans utilisateur.
 *
 * Reprend la charte de docs/design-reference.html (variables CSS, thème
 * clair/sombre, accent corail), branchée sur les vraies routes de l'API.
 * Aucun framework, aucune étape de build : du DOM et des `fetch`.
 *
 * Les écrans d'administration vivent dans admin.js ; le formatage des dates,
 * des tailles et des avatars dans fmt.js.
 */

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** Appel API. Lève une Error portant le message renvoyé par le serveur. */
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    location.href = '/';
    throw new Error('Session expirée.');
  }

  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* réponse sans corps */
  }
  if (!res.ok) {
    const err = new Error(payload.error || `Erreur ${res.status}`);
    // Le code de statut porte une information que le message n'a pas : un 409
    // ou un 503 sont des refus ÉCRITS POUR L'UTILISATEUR (« une connexion est
    // déjà en cours »), un 500 est un incident dont le détail n'a rien à faire
    // devant lui. Sans cette distinction, on affiche soit du jargon, soit une
    // phrase creuse là où une consigne existait.
    err.status = res.status;
    throw err;
  }
  return payload;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function statusDot(status) {
  if (status === 'installed') return 'green';
  if (status === 'needs-config' || status === 'pending') return 'amber';
  if (status === 'error') return 'red';
  return 'gray';
}

function statusLabel(status) {
  if (status === 'installed') return 'Actif';
  if (status === 'needs-config') return 'Configuration requise';
  if (status === 'error') return 'Erreur de connexion';
  if (status === 'pending') return 'En attente de test';
  return 'Disponible';
}

/** Date en relatif, avec la date exacte au survol. */
function relativeCell(value, fallback = '—') {
  if (!value) return `<span class="text-faint">${esc(fallback)}</span>`;
  return `<span title="${esc(fmt.exact(value))}">${esc(fmt.relative(value))}</span>`;
}

// ---------------------------------------------------------------------------
// Actions longues
//
// Une action qui dure plus de deux secondes doit tenir trois promesses, et
// c'est ce que ces quelques fonctions rendent systématique :
//
//   1. le bouton qui l'a lancée est GRISÉ et ne peut pas être recliqué. Sans
//      ça, un utilisateur qui trouve que « ça ne répond pas » reclique — et
//      lance une seconde recherche, une seconde synchronisation, un second
//      navigateur ;
//   2. un texte qui AVANCE dit où on en est. Un rond qui tourne ne distingue
//      pas « ça travaille » de « c'est bloqué », et c'est exactement la
//      question que se pose celui qui attend ;
//   3. un échec laisse un bouton, jamais un écran figé.
//
// Le verrou de l'interface ne remplace pas celui du serveur : un deuxième
// onglet ou un appel direct passeraient à travers (voir
// server/connectors/inflight.js). Il le rend visible, c'est tout.
// ---------------------------------------------------------------------------

/** Rythme auquel le texte d'attente est réévalué. */
const ATTENTE_TIC_MS = 700;

/**
 * Fait avancer un texte d'attente d'étape en étape.
 *
 * Les seuils sont donnés en millisecondes écoulées depuis le début. Le dernier
 * texte est volontairement rassurant plutôt que muet : passé le temps annoncé,
 * ce n'est pas encore un échec, mais ça mérite d'être dit.
 *
 * @param {Array<{apres: number, texte: string}>} etapes
 * @param {(texte: string) => void} afficher
 * @returns {() => void} à appeler pour arrêter
 */
function jalonnerAttente(etapes, afficher) {
  const debut = Date.now();
  const montrer = () => {
    const ecoule = Date.now() - debut;
    const etape = [...etapes].reverse().find((e) => ecoule >= e.apres);
    if (etape) afficher(etape.texte);
  };

  montrer();
  const minuteur = setInterval(montrer, ATTENTE_TIC_MS);
  return () => clearInterval(minuteur);
}

/**
 * Grise un bouton le temps d'une action, et le rend tel qu'il était ensuite.
 *
 * @param {object|null} bouton
 * @param {string} [texte]
 * @returns {() => void} à appeler pour le rendre
 */
function occuperBouton(bouton, texte = 'En cours…') {
  if (!bouton) return () => {};
  const avant = { disabled: !!bouton.disabled, html: bouton.innerHTML };
  bouton.disabled = true;
  bouton.innerHTML = `<span class="spinner"></span> ${esc(texte)}`;
  return () => {
    bouton.disabled = avant.disabled;
    bouton.innerHTML = avant.html;
  };
}

/**
 * Exécute une action longue en tenant les trois promesses ci-dessus.
 *
 * @param {{bouton?: object|null, libelle?: string,
 *          etapes?: Array<{apres: number, texte: string}>,
 *          afficher?: (texte: string) => void,
 *          executer: () => Promise<*>}} options
 */
async function actionLongue({ bouton = null, libelle, etapes = null, afficher = null, executer }) {
  const rendreBouton = occuperBouton(bouton, libelle || 'En cours…');
  const arreter = etapes && afficher ? jalonnerAttente(etapes, afficher) : () => {};
  try {
    return await executer();
  } finally {
    arreter();
    rendreBouton();
  }
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

const state = {
  me: null,
  security: null,
  policy: null,
  settings: null,
  pendingEmailChange: null,
  smtpConfigured: false,
  connectors: [],
  /** Catégories du Store, dans l'ordre décidé par le serveur (lot 11). */
  categories: [],
  /** « 13 services disponibles, 71 à venir », comptés côté serveur. */
  storeCounts: { available: 0, planned: 0 },
  /** Filtre « Seulement les services disponibles », mémorisé sur le compte. */
  storeAvailableOnly: false,
  currentCat: 'all',
  currentConnectorId: null,
  // Fiche ouverte en mode saisie sur un connecteur DÉJÀ connecté : c'est ce que
  // font « Modifier » et « Reconfigurer ». Faux, la fiche se contente de dire
  // ce que crabe a fait.
  modalEdit: false,
  // Étape de sélection en cours : { connectorId, field, items }. Null hors
  // de cette étape (voir « Étape de découverte » plus bas).
  discovery: null,
  /**
   * Connexion par navigateur distant (lot 6).
   *
   * `caps` est chargé avec le catalogue : c'est lui qui décide si le bouton
   * « Se connecter » est cliquable, ou grisé AVEC son explication. Le reste ne
   * vit que le temps d'une session — une seule à la fois, exactement comme
   * côté serveur.
   */
  remoteLogin: {
    caps: null,
    connectorId: null,
    view: null,
    rfb: null,
    poll: null,
    tick: null,
    // Fait avancer le voile d'attente pendant le démarrage (« Ouverture du
    // navigateur… » puis « Chargement du site… ») : un rond qui tourne sans
    // rien dire ne distingue pas « ça avance » de « c'est bloqué ».
    stages: null,
    deadline: 0,
    // Dernier presse-papiers reçu du navigateur distant. Gardé en mémoire quand
    // le poste refuse l'écriture dans son propre presse-papiers (crabe est
    // servi en HTTP simple : `navigator.clipboard` n'y existe pas).
    remoteClipboard: '',
  },
};

/** Le compte courant a-t-il cette permission d'administration ? */
function can(permission) {
  return !!state.me?.permissions?.includes(permission);
}

// ---------------------------------------------------------------------------
// Préférences d'affichage — cartes / liste, et tris
//
// Mémorisées PAR COMPTE, en base, jamais dans le navigateur : un utilisateur
// retrouve sa disposition et ses classements d'un poste à l'autre, ce que
// `localStorage` ne sait pas faire. Elles sont chargées une fois au démarrage,
// puis relues en mémoire — un écran ne doit pas attendre le réseau pour
// s'afficher dans le bon mode.
//
// Les écritures sont « best effort » : un réseau coupé n'empêche pas de trier
// ni de basculer, seulement de s'en souvenir.
// ---------------------------------------------------------------------------

const prefs = {
  /** @type {Record<string, any>} */
  values: {},
  loaded: false,
};

/** Charge toutes les préférences du compte. Sans droit ni réseau : les défauts. */
async function loadPrefs() {
  try {
    const { preferences } = await api('/users/me/preferences');
    prefs.values = preferences || {};
  } catch {
    prefs.values = {};
  }
  prefs.loaded = true;
  return prefs.values;
}

/** Mode d'affichage d'un écran : « cards » (défaut) ou « list ». */
function viewMode(screen) {
  return prefs.values[`view.${screen}`] === 'list' ? 'list' : 'cards';
}

/** Enregistre le mode d'affichage, sans attendre la réponse pour rendre. */
function setViewMode(screen, mode) {
  const valeur = mode === 'list' ? 'list' : 'cards';
  prefs.values[`view.${screen}`] = valeur;
  savePref(`view.${screen}`, valeur);
  return valeur;
}

/** Tri mémorisé d'un écran, ou celui que l'écran juge sensé. */
function sortOf(screen, defaut) {
  return uiPrefs.lireTri(prefs.values[`sort.${screen}`], defaut);
}

function setSort(screen, tri) {
  const valeur = uiPrefs.ecrireTri(tri);
  prefs.values[`sort.${screen}`] = valeur;
  savePref(`sort.${screen}`, valeur);
  return tri;
}

/**
 * Les tailles de page proposées, en repli.
 *
 * La liste qui fait foi est celle du serveur (`/api/home` la renvoie) : c'est
 * lui qui REFUSE tout le reste, et un menu déroulant qui proposerait autre
 * chose que ce qu'il accepte serait un piège à clic. Celle-ci ne sert que
 * lorsque l'accueil n'a pas encore répondu — au premier affichage du profil,
 * par exemple.
 */
const PAGE_SIZES = [10, 15, 20, 25, 30, 50];

/** Les tailles réellement acceptées : celles du serveur dès qu'on les connaît. */
function pageSizes() {
  return home.data?.pageSizes?.length ? home.data.pageSizes : PAGE_SIZES;
}

/**
 * Les deux blocs paginés de l'accueil, et la clé de préférence de chacun.
 *
 * ─── Pourquoi deux, là où le lot 18 n'en avait qu'un ────────────────────────
 *
 * Parce que les deux blocs ne portent pas la même chose. « Synchronisation »
 * liste des services — une dizaine, qu'on veut voir d'un coup. « Derniers
 * documents » liste des factures — des centaines, qu'on feuillette. Le même
 * nombre ne convenait pas aux deux, et régler l'un déréglait l'autre.
 */
const BLOCS_PAGINES = {
  sync: {
    cle: 'home.sync.pageSize',
    champ: 'syncPageSize',
    titre: 'Synchronisation',
    // Le nom d'une fonction GLOBALE, parce que la bascule cartes / liste écrit
    // un `onclick` dans du HTML : une fonction anonyme ou un `.bind()` s'y
    // recopierait tel quel, avec ses guillemets, et casserait l'attribut.
    setter: 'setHomeSyncView',
  },
  documents: {
    cle: 'home.documents.pageSize',
    champ: 'documentsPageSize',
    titre: 'Derniers documents',
    setter: 'setHomeDocumentsView',
  },
};

/** La taille de page en vigueur d'un bloc, quoi qu'il y ait en mémoire. */
function pageSizeCourante(bloc) {
  const config = BLOCS_PAGINES[bloc];
  if (!config) return 10;
  const n = Number(prefs.values[config.cle] ?? home.data?.[config.champ]);
  return pageSizes().includes(n) ? n : 10;
}

/**
 * Change le nombre de lignes par page d'UN bloc de l'accueil.
 *
 * L'accueil est redessiné tout de suite, sans attendre l'aller-retour : le
 * réglage se juge à l'œil, et faire patienter pour montrer le résultat d'un
 * choix qu'on vient de faire est le meilleur moyen d'en faire quatre.
 *
 * Si le serveur refuse malgré tout — un menu déroulant modifié, un onglet resté
 * ouvert pendant une mise à jour —, l'affichage REVIENT à la valeur d'avant et
 * le refus est dit. Garder à l'écran une valeur que le serveur n'a pas retenue
 * serait le pire des deux mondes : elle disparaîtrait au rechargement suivant,
 * sans que personne ait jamais su pourquoi.
 */
function saveHomePageSize(bloc, value) {
  const config = BLOCS_PAGINES[bloc];
  if (!config) return;

  const demande = Number(value);
  const avant = pageSizeCourante(bloc);

  if (!pageSizes().includes(demande)) {
    showToast(
      `Nombre de lignes par page impossible : « ${value} ». ` +
        `Choisissez ${pageSizes().slice(0, -1).join(', ')} ou ${pageSizes().at(-1)}.`
    );
    renderHomePanel();
    return;
  }

  appliquerPageSize(bloc, demande);
  savePref(config.cle, demande, (message) => {
    showToast(message);
    appliquerPageSize(bloc, avant);
    renderHomePanel();
  });
}

/** Pose une taille de page sur un bloc et redessine ce qui en dépend. */
function appliquerPageSize(bloc, taille) {
  const config = BLOCS_PAGINES[bloc];
  prefs.values[config.cle] = taille;
  if (home.data) home.data[config.champ] = taille;
  // La page 4 d'une liste qui n'en a plus que deux : `pageDe()` recale, mais
  // autant repartir du début — c'est le réglage qu'on veut voir, pas la fin
  // de la liste. Seul le bloc réglé revient à sa première page : l'autre n'a
  // aucune raison de perdre l'endroit où on le lisait.
  home.pages[bloc] = 1;
  renderHomeWidgets();
}

/**
 * Change la présentation d'un bloc de l'accueil — cartes ou liste.
 *
 * Clé PROPRE à chaque bloc (`view.home-sync`, `view.home-documents`), et
 * surtout pas `view.documents` : celle-là règle l'écran « Mes documents », qui
 * montre tout autre chose. Les faire partager une clé ferait basculer un écran
 * en réglant un bloc.
 */
function setHomeBlocView(bloc, mode) {
  setViewMode(`home-${bloc}`, mode);
  renderHomeWidgets();
  renderHomePanel();
}

/** Les deux points d'entrée nommés, appelés depuis les boutons de la bascule. */
function setHomeSyncView(mode) {
  setHomeBlocView('sync', mode);
}

function setHomeDocumentsView(mode) {
  setHomeBlocView('documents', mode);
}

/**
 * Écriture différée : rendre d'abord, mémoriser ensuite.
 *
 * Sans `onRefus`, un échec est silencieux — et c'est voulu : un tri perdu par
 * un réseau coupé n'est pas une nouvelle à annoncer, le classement s'applique
 * quand même. Un réglage REFUSÉ, lui, doit se dire : l'écran montrerait sinon
 * un état que le serveur n'a pas.
 */
function savePref(key, value, onRefus = null) {
  api('/users/me/preferences', { method: 'PUT', body: { preferences: { [key]: value } } }).catch(
    (err) => {
      if (onRefus) onRefus(err?.message || 'Réglage non enregistré.');
      // Le classement s'applique quand même : seule sa mémoire est perdue.
    }
  );
}

/**
 * Les deux boutons de la bascule Cartes / Liste.
 *
 * Toujours dans le même ordre, avec les mêmes icônes et les mêmes libellés :
 * six écrans de plus les portent au lot 10, et les découvrir différents à
 * chaque page serait pire que ne pas les avoir.
 */
function viewToggle(screen, onchange) {
  const mode = viewMode(screen);
  const bouton = (valeur, label, titre) =>
    `<button class="pill ${mode === valeur ? 'active' : ''}"
             id="view-${esc(screen)}-${valeur}" title="${esc(titre)}"
             aria-pressed="${mode === valeur}"
             onclick="${onchange}('${valeur}')">${label}</button>`;

  // Mêmes classes que la bascule des Applications et de l'Automatisation, en
  // place depuis le lot 3 : c'est la même chose, elle doit se ressembler.
  return `${bouton('cards', 'Cartes', 'Afficher en cartes')}${bouton('list', 'Liste', 'Afficher en liste')}`;
}

/** Remplit un conteneur de bascule, et rend l'écran dans le mode retenu. */
function renderViewToggle(containerId, screen, onchange) {
  const boite = $(containerId);
  if (boite) boite.innerHTML = viewToggle(screen, onchange);
}

// ---------------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------------

function applyTheme(light) {
  document.body.classList.toggle('light', light);
  $('icon-sun').style.display = light ? 'block' : 'none';
  $('icon-moon').style.display = light ? 'none' : 'block';
}

function toggleTheme() {
  const light = !document.body.classList.contains('light');
  applyTheme(light);
  localStorage.setItem('crabe.theme', light ? 'light' : 'dark');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const view = $(`view-${name}`);
  if (!view) return;
  view.classList.add('active');

  closeMobileMenu();
  document.querySelectorAll('.tb-btn').forEach((b) => b.classList.remove('active'));
  if (name === 'documents') $('tb-documents').classList.add('active');
  if (name === 'store') $('tb-store').classList.add('active');
  if (name === 'admin') $('tb-admin').classList.add('active');
  if (name === 'profil') $('tb-profil').classList.add('active');

  // Une page défilée puis une navigation ne doit pas ouvrir l'écran suivant
  // à mi-hauteur — c'est particulièrement voyant sur téléphone.
  window.scrollTo?.(0, 0);

  if (name === 'home') renderHome();
  if (name === 'documents') renderDocuments();
  if (name === 'store') renderStore();
  if (name === 'profil') showProfilPage('general', document.querySelector('[data-ppage="general"]'));
  if (name === 'admin') openAdmin();
}

// ---------------------------------------------------------------------------
// Menu mobile
//
// Sous 640 px, les cinq icônes de la barre du haut ne tiennent pas côte à
// côte : elles passent dans un panneau latéral. Le logo reste le retour à
// l'accueil.
// ---------------------------------------------------------------------------

function toggleMobileMenu() {
  const open = !$('tb-mobile-menu').classList.contains('open');
  $('tb-mobile-menu').classList.toggle('open', open);
  $('tb-scrim').classList.toggle('open', open);
  $('tb-mobile-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeMobileMenu() {
  $('tb-mobile-menu').classList.remove('open');
  $('tb-scrim').classList.remove('open');
  $('tb-mobile-btn').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// Barres latérales Paramètres et Profil
//
// Sous 1024 px, la colonne de navigation n'a plus la place d'être toujours
// visible : elle devient un panneau glissant, ouvert par un bouton en tête de
// contenu et refermé au clic extérieur ou dès qu'une entrée est choisie.
// Une seule solution, la même sur les deux écrans.
// ---------------------------------------------------------------------------

function toggleSettingsMenu(scope) {
  const sidebar = $(`${scope}-sidebar`);
  if (!sidebar) return;
  const open = !sidebar.classList.contains('open');
  document.querySelectorAll('.settings-sidebar').forEach((s) => s.classList.remove('open'));
  sidebar.classList.toggle('open', open);
  $('settings-scrim').classList.toggle('open', open);
}

function closeSettingsMenu() {
  document.querySelectorAll('.settings-sidebar').forEach((s) => s.classList.remove('open'));
  $('settings-scrim').classList.remove('open');
}

/**
 * Libellé d'une entrée de menu, sans sa pastille de compteur : le nœud texte
 * seul, sinon « Support » deviendrait « Support 3 ».
 */
function navItemLabel(el) {
  if (!el) return null;
  return String(el.firstChild?.nodeValue || el.textContent || '').trim();
}

/** Le bouton rappelle l'écran affiché : sans lui, on ne sait plus où on est. */
function setSettingsMenuLabel(scope, label) {
  const el = $(`${scope}-menu-label`);
  if (el && label) el.textContent = label;
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}

// ---------------------------------------------------------------------------
// Catalogue des connecteurs
//
// Partagé par le Store, l'accueil et le profil : une seule lecture, un seul
// état. `state.connectors` porte la vue de l'utilisateur COURANT — le serveur
// filtre déjà ce à quoi son compte a droit.
// ---------------------------------------------------------------------------

async function loadConnectors() {
  const data = await api('/connectors');
  state.connectors = data.connectors;
  // Catégories et comptes viennent du serveur : une liste écrite en dur ici
  // aurait été à tenir à jour à chaque catégorie ajoutée, et le compte affiché
  // aurait pu diverger de ce que la grille montre réellement.
  state.categories = data.categories || [];
  state.storeCounts = data.counts || { available: 0, planned: 0 };

  // Ce que le serveur peut faire, pas ce qu'on espère qu'il puisse faire : les
  // paquets système du navigateur distant peuvent manquer, le conteneur être à
  // court de mémoire, une autre connexion tourner déjà. C'est cette réponse
  // qui grise le bouton AVEC son explication, plutôt que de le laisser échouer.
  // Son échec n'est pas bloquant : on retombe alors sur le repli par fichier.
  state.remoteLogin.caps = await api('/connectors/remote-login/capabilities').catch(() => ({
    available: false,
    busy: false,
    reason:
      'État du navigateur distant indisponible — utilisez un fichier de session.',
  }));

  return state.connectors;
}

function installedConnectors() {
  return state.connectors.filter((c) => c.installed);
}

// ---------------------------------------------------------------------------
// Accueil — tableau de bord configurable
//
// Structure, libellés et comportements viennent de docs/accueil-reference.html
// (maquette validée). Les deux boutons « Aides à la revue » de la maquette
// n'existent volontairement pas ici : ils n'étaient là que pour la relecture.
// ---------------------------------------------------------------------------

const home = {
  /** Dernière réponse de GET /api/home. */
  data: null,
  /** Blocs, dans l'ordre choisi par l'utilisateur. */
  widgets: [],
  /** Bloc en cours de déplacement (glisser-déposer). */
  dragId: null,
  /**
   * Verrous en vigueur, tels que le serveur les a calculés :
   * `adminAllowed` (autorisation de l'administrateur), `personalLock`
   * (« Figer mon accueil »), `canCustomize` (les deux réunis).
   */
  access: { adminAllowed: true, personalLock: false, canCustomize: true },
  /**
   * Page courante des deux blocs paginés, par identifiant de bloc.
   *
   * Gardée en mémoire et non dans l'URL : c'est un tableau de bord, pas une
   * page qu'on partage par lien. Elle est en revanche RECALÉE à chaque rendu
   * (voir `pageDe`), pour qu'une synchronisation qui vide une liste ne laisse
   * pas l'utilisateur devant une page 4 devenue inexistante.
   */
  pages: { sync: 1, documents: 1 },
};

/** Lignes par page du bloc — chacun le sien, réglé dans « Personnaliser l'accueil ». */
function taillePage(bloc) {
  return pageSizeCourante(bloc);
}

/**
 * La page réellement affichable pour un bloc, et ses bornes.
 *
 * Recale la page demandée dans ce qui existe : trois documents supprimés, et
 * la page 2 n'a plus lieu d'être. Sans ce recalage, le bloc afficherait le
 * vide sans dire pourquoi — et sans donner le moyen d'en sortir.
 */
function pageDe(bloc, total) {
  const parPage = taillePage(bloc);
  const pages = Math.max(1, Math.ceil(total / parPage));
  const page = Math.min(Math.max(1, home.pages[bloc] || 1), pages);
  home.pages[bloc] = page;
  return { page, pages, parPage, debut: (page - 1) * parPage, fin: page * parPage };
}

/** Change de page dans un bloc, puis redessine l'accueil. */
function pagerBloc(bloc, page) {
  home.pages[bloc] = Number(page) || 1;
  renderHomeWidgets();
}

/**
 * Le pied de pagination — rien du tout quand tout tient sur une page.
 *
 * Une pagination qui s'affiche pour une seule page est un bouton mort : elle
 * n'apprend rien et prend la place de ce qu'on est venu voir.
 */
function paginationHtml(bloc, { page, pages }, libelle, total) {
  if (pages <= 1) return '';
  return `<div class="pager">
    <button class="pager-btn" ${page <= 1 ? 'disabled' : ''}
            onclick="pagerBloc('${esc(bloc)}', ${page - 1})" aria-label="Page précédente">‹</button>
    <span class="pager-state">Page ${page} sur ${pages} · ${fmt.number(total)} ${esc(libelle)}</span>
    <button class="pager-btn" ${page >= pages ? 'disabled' : ''}
            onclick="pagerBloc('${esc(bloc)}', ${page + 1})" aria-label="Page suivante">›</button>
  </div>`;
}

/** Largeurs proposées ; le serveur renvoie la même liste dans /api/home. */
const WIDGET_SPANS = [
  { value: 12, label: '1', title: 'Ligne entière' },
  { value: 6, label: '½', title: 'Une demi-ligne' },
  { value: 4, label: '⅓', title: 'Un tiers' },
  { value: 3, label: '¼', title: 'Un quart' },
];

/** Poignée de déplacement : grille de six points, pas deux colonnes de trois. */
const ICON_GRIP =
  '<svg width="13" height="15" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">' +
  '<circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/>' +
  '<circle cx="3" cy="8" r="1.4"/><circle cx="9" cy="8" r="1.4"/>' +
  '<circle cx="3" cy="13" r="1.4"/><circle cx="9" cy="13" r="1.4"/></svg>';

/** Icônes des en-têtes de blocs, reprises de la maquette. */
const WIDGET_ICONS = {
  grid: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  chart: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  sync: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.5-3.4L23 10M1 14l5.1 4.4A9 9 0 0020.5 15"/></svg>',
  alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  doc: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
  cloud: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 116.7-9h.8a4.5 4.5 0 010 9z"/></svg>',
};

const ICON_DOWNLOAD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';

async function loadHome() {
  home.data = await api('/home');
  home.widgets = uniqueWidgets(home.data.widgets);
  home.access = home.data.access || home.access;
  return home.data;
}

/**
 * Un bloc, une fois. Pas deux.
 *
 * Le lot 3 a affiché « Erreurs et alertes » en double sur l'accueil de
 * production. Le serveur ne peut plus produire de doublon (server/home.js
 * construit la liste depuis son catalogue), mais l'interface ne le croit pas
 * sur parole : si un identifiant revient, il est écarté et signalé dans la
 * console plutôt que rendu une seconde fois.
 *
 * @param {Array<{id: string}>} widgets
 */
function uniqueWidgets(widgets) {
  const seen = new Set();
  const kept = [];
  for (const widget of widgets || []) {
    if (!widget || seen.has(widget.id)) {
      console.warn('accueil : bloc en double ignoré', widget?.id);
      continue;
    }
    seen.add(widget.id);
    kept.push(widget);
  }
  return kept;
}

/** Charge puis rend l'accueil. Toute erreur reste lisible dans la page. */
async function renderHome() {
  try {
    await loadHome();
  } catch (err) {
    $('home-widgets').innerHTML = `<div class="empty-state">Accueil indisponible — ${esc(err.message)}</div>`;
    return;
  }
  renderHomeHeader();
  renderAlerteStockage();
  renderHomeWidgets();
  // Les échecs planifiés non vus, relevés à l'ouverture de l'accueil : c'est
  // l'écran qu'on ouvre en arrivant, donc le moment le plus probable où une
  // notification a une chance d'être vue. Jamais bloquant.
  releverNotifications();
  // Une synchronisation déjà en route — lancée avant l'arrivée ici, ou
  // survivante d'un rechargement de page — redevient visible sur les cartes
  // (lot 35). Jamais bloquant non plus.
  surveillerSynchronisation();
}

/**
 * Le bandeau « plus aucun espace de stockage » — au-dessus de tout le reste.
 *
 * ─── Pourquoi ici, et pas dans l'écran Stockage (lot 26) ─────────────────────
 *
 * L'espace de stockage de crabe se supprime désormais comme un cloud. On peut
 * donc se retrouver sans aucune destination — et dans cet état, crabe REFUSE
 * de récupérer quoi que ce soit : télécharger des factures pour les jeter
 * solliciterait le site d'un fournisseur pour rien.
 *
 * Le dire dans l'écran Stockage n'aurait pas suffi. Cet écran est réservé aux
 * administrateurs : un compte ordinaire verrait ses récupérations s'arrêter
 * sans qu'aucun écran de son périmètre ne lui en donne la raison. L'accueil est
 * le seul endroit que tout le monde ouvre.
 *
 * Le bandeau ne se ferme pas d'un clic : il n'y a rien à acquitter, il
 * disparaît quand un stockage redevient actif.
 */
function renderAlerteStockage() {
  const zone = $('home-alert');
  if (!zone) return;
  const alerte = home.data?.stockageAlerte;

  if (!alerte?.bloque) {
    zone.innerHTML = '';
    zone.hidden = true;
    return;
  }

  zone.hidden = false;
  zone.innerHTML = `<div class="home-alert" role="alert">
    <span class="home-alert-icon" aria-hidden="true">⚠</span>
    <div class="home-alert-text">
      <strong>Les récupérations sont suspendues.</strong>
      ${esc(alerte.message)}
    </div>
  </div>`;
}

function renderHomeHeader() {
  $('home-greeting').textContent = `Bonjour, ${home.data.user.username}`;
  // La date suit les réglages d'administration (fuseau, format).
  $('home-date').textContent = fmt.date(home.data.today);
  applyAvatar();
  renderCustomizeButton();
}

/**
 * Bouton « Personnaliser l'accueil » — icône seule.
 *
 * Grisé, mais toujours visible, quand l'administrateur a retiré
 * l'autorisation : même traitement que la 2FA désactivée du lot 1, pour que
 * l'utilisateur comprenne pourquoi il ne peut plus rien changer.
 */
function renderCustomizeButton() {
  const button = $('btn-customize');
  if (!button) return;

  const { adminAllowed, personalLock } = home.access;
  const label = !adminAllowed
    ? 'Personnalisation de l\'accueil — désactivée par l\'administrateur'
    : personalLock
      ? 'Accueil figé — ouvrez ce panneau et retirez « Figer mon accueil »'
      : 'Personnaliser l\'accueil';

  button.disabled = !adminAllowed;
  button.title = label;
  button.setAttribute('aria-label', label);
}

/** Sélecteur de largeur d'un bloc : quatre boutons, 1 · ½ · ⅓ · ¼. */
function spanPicker(widget) {
  const spans = home.data?.spans?.length ? home.data.spans : WIDGET_SPANS;
  return spans
    .map(
      (s) => `<button type="button" class="w-span-btn ${s.value === widget.span ? 'active' : ''}"
        title="${esc(s.title)}" aria-label="${esc(widget.title)} — ${esc(s.title)}"
        onclick="event.stopPropagation(); setHomeWidgetSpan('${esc(widget.id)}', ${s.value})"
      >${esc(s.label)}</button>`
    )
    .join('');
}

/** Réaffiche uniquement les blocs, sans rappeler le serveur. */
function renderHomeWidgets() {
  const editable = home.access.canCustomize;
  const container = $('home-widgets');
  container.classList.toggle('locked', !editable);

  container.innerHTML = uniqueWidgets(home.widgets)
    .filter((w) => w.enabled)
    .map(
      (w) => `
      <div class="widget w-span-${w.span || 12}" data-widget="${esc(w.id)}"
           ${editable
             ? `draggable="true"
           ondragstart="onWidgetDragStart(event, '${esc(w.id)}')"
           ondragover="onWidgetDragOver(event)"
           ondrop="onWidgetDrop(event, '${esc(w.id)}')"
           ondragend="onWidgetDragEnd(event)"`
             : ''}>
        <div class="widget-head">
          ${editable
            ? `<span class="drag-handle" title="Glisser pour réordonner">${ICON_GRIP}</span>`
            : ''}
          <div class="w-icon">${WIDGET_ICONS[w.icon] || ''}</div>
          <div class="w-title">${esc(w.title)}</div>
          ${editable ? `<div class="w-span-picker">${spanPicker(w)}</div>` : ''}
        </div>
        <div class="widget-body">${widgetBody(w.id)}</div>
      </div>`
    )
    .join('');
}

function widgetBody(id) {
  if (id === 'connecteurs') return widgetConnectors();
  if (id === 'stats') return widgetStats();
  if (id === 'sync') return widgetSync();
  if (id === 'errors') return widgetErrors();
  if (id === 'documents') return widgetDocuments();
  if (id === 'destinations') return widgetDestinations();
  return '';
}

// --- a. Mes connecteurs -----------------------------------------------------

/**
 * Le sélecteur d'ordre d'un bloc de l'accueil (lot 25).
 *
 * ─── Où il est posé, et surtout où il ne l'est PAS ───────────────────────────
 *
 * Le lot 24 a posé l'ordre alphabétique sur six écrans. Deux seulement
 * reçoivent ce menu, et le recensement mérite d'être écrit ici plutôt que
 * découvert par quelqu'un qui se demandera pourquoi il manque ailleurs :
 *
 *   - **« Mes connecteurs » et « Synchronisation »** (ici) : ce sont les deux
 *     listes où l'on se demande vraiment « qu'est-ce que je viens d'ajouter ? »
 *     et « qu'est-ce qui a tourné en dernier ? ». Chacun garde SA clé.
 *   - **le Store** : on y vient chercher un service par son nom, dans un
 *     catalogue qu'on ne possède pas. Ni « ajout récent » ni « dernière
 *     synchro » n'y veulent dire quoi que ce soit.
 *   - **« Mes documents »**, **Applications** et **Logos** : ces écrans ont
 *     déjà un tri, par en-tête de colonne, mémorisé lui aussi par compte
 *     (préférences `sort.*`). Un second mécanisme à côté du premier ferait
 *     deux réglages concurrents sur le même écran.
 *   - **l'écran Stockage** : le stockage local d'abord puis les clouds par nom, sur
 *     quelques lignes. Un menu pour trois entrées est du bruit.
 *
 * La liste des ordres vient du SERVEUR (`home.data.trisCatalog`), qui est aussi
 * celui qui refuse les autres : ce menu ne peut donc pas proposer une valeur
 * que l'enregistrement rejetterait.
 */
function triSelect(bloc, valeur, onchange) {
  const ordres = home.data.trisCatalog || [];
  if (ordres.length < 2) return '';
  return `<label class="tri-select">
    <span class="tri-label">Trier par</span>
    <select id="tri-${esc(bloc)}" aria-label="Ordre d'affichage"
            onchange="${onchange}(this.value)">
      ${ordres
        .map(
          (o) => `<option value="${esc(o.id)}" ${o.id === valeur ? 'selected' : ''}>${esc(o.label)}</option>`
        )
        .join('')}
    </select>
  </label>`;
}

/**
 * Change l'ordre d'un bloc : on redessine tout de suite, on enregistre après.
 *
 * L'ordre s'applique même si l'enregistrement échoue — seule sa mémoire serait
 * perdue. L'inverse (attendre le serveur pour redessiner) ferait un menu qui
 * ne réagit pas au clic sur une connexion lente.
 *
 * ⚠ LE NOM DE LA FONCTION DE RENDU, ET D'OÙ VENAIT LE MAUVAIS
 *
 * Cette ligne appelait `renderWidgets()`, qui n'a jamais existé dans le
 * produit — une seule occurrence dans tout `web/`, et c'était cet appel. Le nom
 * vient de `docs/accueil-reference.html`, la maquette autonome de l'accueil, où
 * une fonction de ce nom existe bel et bien : il a été recopié avec le reste au
 * lot 25, dans le même commit que cette fonction. La vraie fonction du produit
 * s'appelle `renderHomeWidgets()` depuis le lot 3.
 *
 * Conséquence pour qui s'en sert : choisir un ordre dans le menu ne réordonnait
 * RIEN, et la ligne suivante n'était même pas atteinte — le réglage n'était donc
 * pas non plus enregistré.
 *
 * `node --check` ne voit pas ce défaut, et ne le verra jamais : un appel vers
 * une fonction absente est une erreur d'EXÉCUTION. C'est pour cela qu'un test
 * balaie désormais tout le front à la recherche des appels sans définition
 * (test/lot27-regressions.test.js).
 */
function changerTri(bloc, cle, valeur) {
  home.data[bloc] = valeur;
  renderHomeWidgets();
  savePref(cle, valeur, (message) => showToast(message));
}

function setConnecteursTri(valeur) {
  // Le tri se refait ICI et pas seulement au serveur : le bloc est redessiné
  // sans recharger /api/home, comme la bascule cartes/liste.
  home.data.connectors = trierServices(home.data.connectors, valeur);
  changerTri('connecteursTri', 'home.connecteurs.tri', valeur);
}

function setSyncTri(valeur) {
  home.data.sync = trierServices(home.data.sync, valeur);
  changerTri('syncTri', 'home.sync.tri', valeur);
}

/**
 * La MÊME règle de classement que le serveur (`server/connectors/tri.js`).
 *
 * Elle vit aux deux endroits parce qu'il le faut — le serveur trie ce qu'il
 * envoie, l'écran retrie sans recharger — et un test les tient d'accord sur le
 * même jeu de données. Deux règles qui divergeraient donneraient deux ordres
 * différents sur le même bloc selon qu'on vient de changer le menu ou de
 * rafraîchir la page (leçon du lot 24 sur l'ordre alphabétique).
 */
function trierServices(items, ordre) {
  const liste = [...(items || [])];
  // `comparerNoms` est une fonction de portée globale de web/fmt.js, comme
  // `trierParNom` et `esc` : elle n'est pas dans l'objet `fmt`.
  const parNom = (a, b) => comparerNoms(a?.name, b?.name);
  // Une date absente part à la fin : « jamais synchronisé » n'est pas
  // « synchronisé il y a très longtemps ».
  const recent = (x, y) => {
    const a = x ? Date.parse(x) : NaN;
    const b = y ? Date.parse(y) : NaN;
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return b - a;
  };

  if (ordre === 'ajout') return liste.sort((a, b) => recent(a.installedAt, b.installedAt) || parNom(a, b));
  if (ordre === 'synchro') return liste.sort((a, b) => recent(a.lastRunAt, b.lastRunAt) || parNom(a, b));
  if (ordre === 'documents') {
    return liste.sort((a, b) => (Number(b.documentCount) || 0) - (Number(a.documentCount) || 0) || parNom(a, b));
  }
  return liste.sort(parNom);
}

function widgetConnectors() {
  const tiles = home.data.connectors
    .map(
      (c) => `
      <div class="conn-item" onclick="openHomeConnector('${esc(c.id)}')" title="${esc(c.name)}">
        <div class="conn-icon" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}${
          c.alert ? '<span class="badge">!</span>' : ''
        }</div>
        <div class="conn-name">${esc(c.name)}</div>
      </div>`
    )
    .join('');

  return `
    <div class="widget-tools">
      ${triSelect('connecteurs', home.data.connecteursTri, 'setConnecteursTri')}
    </div>
    <div class="conn-grid">${tiles}
    <div class="conn-item add" onclick="showView('store')" title="Ajouter un connecteur">
      <div class="conn-icon">+</div>
      <div class="conn-name">Ajouter</div>
    </div>
  </div>`;
}

/**
 * Clic sur une icône de l'accueil.
 *
 * Un connecteur qui attend un geste ouvre la fiche EN MODE SAISIE : le geste
 * qui le débloque est là, tout de suite. Un connecteur en état de marche ouvre
 * l'aperçu de ses documents. Dans les deux cas, ce qui s'ouvre est ce que
 * l'utilisateur venait chercher.
 */
async function openHomeConnector(id) {
  if (!state.connectors.length) await loadConnectors();
  const connector = state.connectors.find((c) => c.id === id);
  if (connector && !connector.health?.connected) return void openModal(id, { edit: true });
  openQuickview(id);
}

// --- b. Statistiques --------------------------------------------------------

function widgetStats() {
  const s = home.data.stats;
  const boxes = [
    [fmt.number(s.invoicesThisMonth), 'factures ce mois-ci'],
    [fmt.number(s.invoicesTotal), 'factures au total'],
    [fmt.bytes(s.bytes), 'espace occupé'],
    [fmt.number(s.activeConnectors), 'connecteur(s) actif(s)'],
  ];

  return `<div class="stats-row">
    ${boxes
      .map(
        ([value, label]) =>
          `<div class="stat-box"><div class="stat-val">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`
      )
      .join('')}
    <div class="stat-box">
      <div class="stat-val small" title="${esc(fmt.exact(s.lastSuccessAt))}">
        ${esc(s.lastSuccessAt ? fmt.relative(s.lastSuccessAt) : 'jamais')}
      </div>
      <div class="stat-label">dernière synchronisation réussie</div>
    </div>
  </div>
  ${graphiques(s)}`;
}

// --- b bis. Les deux graphiques ---------------------------------------------
//
// ─── Pourquoi du SVG écrit à la main ────────────────────────────────────────
//
// Aucune dépendance n'est ajoutée pour dessiner deux graphiques. C'est la même
// décision qu'au lot 6, qui a écrit son relais WebSocket plutôt que d'ajouter
// « ws » : `package-lock.json` n'a pas bougé depuis des lots, et une
// bibliothèque de graphiques pèse plus lourd que tout le reste du front réuni.
//
// ─── Les trois pièges d'un graphique dans un bloc redimensionnable ──────────
//
//   1. **le thème** — une couleur écrite en dur est lisible dans l'un des deux
//      thèmes et invisible dans l'autre. Tout vient donc des variables CSS,
//      qui basculent avec le thème ; `fill="var(--accent)"` fonctionne dans un
//      SVG écrit dans la page, ce qui n'est pas vrai d'un fichier .svg externe.
//   2. **la largeur** — le bloc va du quart de ligne à la ligne entière. Le
//      SVG se met à l'échelle par son `viewBox`… et son texte avec lui : à un
//      quart de ligne, un libellé de 10 px devient illisible. Les libellés
//      sortent donc du SVG et sont posés en HTML sous les barres, dans une
//      grille de même découpe : ils gardent leur taille, quoi qu'il arrive.
//   3. **le vide** — un compte sans facture ne doit pas afficher deux cadres
//      vides et muets, mais une phrase, comme les autres blocs le font déjà.

/** Les initiales des mois, pour les blocs trop étroits pour trois lettres. */
const MOIS_COURTS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin',
  'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Combien de connecteurs le second graphique détaille avant de regrouper. */
const CONNECTEURS_AFFICHES = 8;

/**
 * Catalogue de repli des graphiques — celui qui fait foi vient de `/api/home`.
 *
 * Le titre est EXACTEMENT celui écrit au-dessus du graphique : la case à cocher
 * et ce qu'elle affiche doivent porter le même nom, sinon il faut décocher pour
 * comprendre laquelle des deux on vient d'éteindre.
 */
const STATS_CHARTS = [
  { id: 'mois', title: 'Factures par mois' },
  { id: 'connecteurs', title: 'Répartition par service' },
  { id: 'stockage', title: 'Espace occupé par service' },
  { id: 'connecteurs-temps', title: 'Services connectés au fil du temps' },
  { id: 'executions', title: 'Récupérations réussies et échouées' },
];

/** Formes possibles, en repli : celles du serveur font foi (c'est lui qui refuse). */
const STATS_CHART_TYPES = { mois: ['barres', 'courbe'], connecteurs: ['barres', 'anneau'] };

function statsChartsCatalog() {
  return home.data?.statsChartsCatalog?.length ? home.data.statsChartsCatalog : STATS_CHARTS;
}

function statsTypeCatalog() {
  return home.data?.statsTypeCatalog || STATS_CHART_TYPES;
}

/** La forme retenue pour un graphique, ou la première de sa liste. */
function statsChartType(id) {
  const formes = statsTypeCatalog()[id] || [];
  const memorise = prefs.values[`home.stats.type.${id}`] ?? home.data?.statsChartTypes?.[id];
  return formes.includes(memorise) ? memorise : formes[0] || 'barres';
}

/**
 * Change la forme d'un graphique.
 *
 * Même schéma que la taille de page : on redessine tout de suite — un dessin
 * se juge à l'œil —, et si le serveur refuse, l'affichage REVIENT à la forme
 * d'avant et le refus est dit. Laisser à l'écran une forme que le serveur n'a
 * pas retenue la ferait disparaître au rechargement suivant, sans explication.
 */
function setStatsChartType(id, type) {
  const formes = statsTypeCatalog()[id] || [];
  const avant = statsChartType(id);
  if (!formes.includes(type)) return;

  const poser = (valeur) => {
    prefs.values[`home.stats.type.${id}`] = valeur;
    if (home.data?.statsChartTypes) home.data.statsChartTypes[id] = valeur;
    renderHomeWidgets();
    renderHomePanel();
  };

  poser(type);
  savePref(`home.stats.type.${id}`, type, (message) => {
    showToast(message);
    poser(avant);
  });
}

/**
 * Les graphiques que ce compte a retenus, dans l'ordre du catalogue.
 *
 * L'ordre vient du catalogue et non de ce qui est mémorisé : cocher les deux
 * cases dans un sens ou dans l'autre doit donner le même accueil.
 */
function statsChartsChoisis() {
  const memorise = prefs.values['home.stats.charts'];
  const retenus = Array.isArray(memorise)
    ? memorise
    : home.data?.statsCharts || statsChartsCatalog().map((c) => c.id);
  return statsChartsCatalog()
    .map((c) => c.id)
    .filter((id) => retenus.includes(id));
}

/**
 * Les graphiques du bloc « Statistiques », ou rien du tout.
 *
 * Trois situations, et une seule d'entre elles mérite une phrase :
 *
 *   1. **aucun graphique demandé** — le bloc s'arrête à ses compteurs. Pas de
 *      cadre vide, et surtout pas de phrase pour expliquer une absence que
 *      l'utilisateur vient lui-même de régler : il le sait, il l'a décochée ;
 *   2. **des graphiques demandés, mais pas une seule facture** — là, l'absence
 *      n'est pas voulue, et se taire laisserait croire à une panne. On le dit ;
 *   3. **le cas ordinaire** — on dessine ce qui a été demandé.
 */
function graphiques(s) {
  const choisis = statsChartsChoisis();
  if (!choisis.length) return '';

  // ⚠ Le vide se juge graphique par graphique depuis le lot 20, et plus « y
  // a-t-il des factures ? ». Deux des trois graphiques ajoutés ne parlent pas
  // de factures : quelqu'un qui vient de brancher trois services sans avoir
  // encore rien récupéré doit voir sa courbe de services, pas une phrase qui
  // lui dit d'attendre.
  //
  // La phrase générale ne sort donc que si TOUT ce qui est demandé est vide :
  // sinon on dessine, et un graphique sans donnée dit lui-même pourquoi, dans
  // son propre cadre — jamais un cadre vide et muet.
  if (choisis.every((id) => statistiqueVide(id, s))) {
    return `<div class="empty-state charts-empty">
      Rien à représenter pour l'instant : les graphiques apparaîtront dès la
      première récupération réussie.
    </div>`;
  }

  const dessin = {
    mois: () =>
      statsChartType('mois') === 'courbe'
        ? courbeParMois(s.parMois || [])
        : graphiqueParMois(s.parMois || []),
    connecteurs: () =>
      statsChartType('connecteurs') === 'anneau'
        ? anneauParConnecteur(s.parConnecteur || [], s.invoicesTotal)
        : graphiqueParConnecteur(s.parConnecteur || [], s.invoicesTotal),
    stockage: () => graphiqueStockage(s.stockageParConnecteur || [], s.bytes),
    'connecteurs-temps': () => courbeConnecteurs(s.connecteursDansLeTemps || []),
    executions: () => graphiqueExecutions(s.executionsParMois || []),
  };

  // Un seul graphique reprend toute la largeur : la grille à deux colonnes
  // laisserait sinon une moitié de bloc vide à côté de lui.
  return `<div class="charts${choisis.length === 1 ? ' seul' : ''}">
    ${choisis.map((id) => (dessin[id] ? dessin[id]() : '')).join('')}
  </div>`;
}

/** Ce graphique-là a-t-il quelque chose à montrer ? */
function statistiqueVide(id, s) {
  if (id === 'connecteurs-temps') {
    return !(s.connecteursDansLeTemps || []).some((p) => p.count > 0);
  }
  if (id === 'executions') {
    return !(s.executionsParMois || []).some((p) => p.ok || p.ko);
  }
  // Les trois autres comptent des factures.
  return !s.invoicesTotal;
}

/** Le cadre d'un graphique qui n'a rien à montrer : il DIT pourquoi. */
function chartVide(titre, phrase) {
  return `<div class="chart">
    <div class="chart-title">${esc(titre)}</div>
    <div class="chart-empty">${esc(phrase)}</div>
  </div>`;
}

/** « 2026-03 » → { libelleCourt: 'mar', libelleLong: 'mars 2026' }. */
function moisLisible(periode) {
  const [annee, mois] = String(periode).split('-');
  const index = Number(mois) - 1;
  return {
    court: MOIS_COURTS[index] || '?',
    long: `${MOIS_LONGS[index] || periode} ${annee}`,
  };
}

/**
 * Factures par mois — barres verticales sur les douze derniers mois.
 *
 * L'échelle part de zéro et monte au plus haut mois, jamais à un maximum
 * choisi d'avance : trois factures un mois et quatre le suivant doivent se
 * voir, et une échelle figée les écraserait toutes les deux en bas du cadre.
 */
function graphiqueParMois(series) {
  const H = 120;           // hauteur du dessin, dans le repère du SVG
  const COL = 40;          // largeur d'une colonne (12 colonnes = 480)
  const W = COL * series.length;
  const max = Math.max(1, ...series.map((m) => m.count));

  const barres = series
    .map((m, i) => {
      const hauteur = Math.round((m.count / max) * (H - 10));
      const { long } = moisLisible(m.periode);
      // Un mois à zéro garde un trait de deux pixels : la colonne reste
      // visible et survolable, et l'absence se lit comme une valeur.
      const h = Math.max(m.count ? 4 : 2, hauteur);
      return `<rect x="${i * COL + 9}" y="${H - h}" width="${COL - 18}" height="${h}" rx="3"
        fill="${m.count ? 'var(--accent)' : 'var(--border-strong)'}"
      ><title>${esc(long)} — ${m.count} facture(s)</title></rect>`;
    })
    .join('');

  const libelles = series
    .map((m) => `<span>${esc(moisLisible(m.periode).court)}</span>`)
    .join('');

  return `<div class="chart">
    <div class="chart-title">Factures par mois <span class="chart-max">max ${fmt.number(max)}</span></div>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="Nombre de factures par mois sur les douze derniers mois">
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
      ${barres}
    </svg>
    <div class="chart-labels" style="grid-template-columns:repeat(${series.length},1fr);">
      ${libelles}
    </div>
  </div>`;
}

/**
 * Répartition par connecteur — barres horizontales.
 *
 * Horizontales et non en anneau : un anneau demande une légende à côté, et
 * cette légende ne tient pas dans un bloc au quart de ligne. Une barre porte
 * son nom sur la même ligne qu'elle, à toutes les largeurs.
 *
 * Chaque barre garde la couleur de son service — celle des pastilles partout
 * ailleurs dans l'interface. C'est ce qui rend le graphique reconnaissable
 * sans le lire.
 */
function graphiqueParConnecteur(series, total) {
  const visibles = series.slice(0, CONNECTEURS_AFFICHES);
  const reste = series.slice(CONNECTEURS_AFFICHES);
  const max = Math.max(1, ...visibles.map((c) => c.count));

  const lignes = visibles
    .map((c) => {
      // Le pourcentage se lit par rapport au TOTAL (« ce service pèse un
      // quart de mes documents »), la longueur de la barre par rapport au
      // plus fourni — sans quoi, avec un service à 90 %, les autres seraient
      // des traits invisibles.
      const part = Math.round((c.count / total) * 100);
      const largeur = Math.max(2, Math.round((c.count / max) * 100));
      return `<div class="chart-row" title="${esc(c.name)} — ${c.count} facture(s), ${part} % du total">
        <span class="chart-row-name">${esc(c.name)}</span>
        <svg class="chart-row-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" width="${largeur}" height="10" rx="2" fill="${esc(c.color)}"/>
        </svg>
        <span class="chart-row-val">${fmt.number(c.count)}</span>
      </div>`;
    })
    .join('');

  const note = reste.length
    ? `<div class="chart-note">et ${reste.length} autre(s) service(s), ${fmt.number(
        reste.reduce((n, c) => n + c.count, 0)
      )} document(s)</div>`
    : '';

  return `<div class="chart">
    <div class="chart-title">Répartition par service</div>
    <div class="chart-rows" role="img"
         aria-label="Nombre de factures par service">${lignes}</div>
    ${note}
  </div>`;
}

// --- b ter. Les formes au choix, et les trois graphiques du lot 20 ----------
//
// Mêmes contraintes qu'au lot 18, et elles n'ont pas bougé : SVG écrit à la
// main, aucune dépendance, couleurs prises aux variables CSS (donc justes dans
// les deux thèmes), et libellés posés en HTML SOUS le dessin — un `viewBox`
// mis à l'échelle emporterait le texte avec lui, et à un quart de ligne un
// libellé de 10 px devient illisible.
//
// ⚠ Un piège de plus, propre aux COURBES : `preserveAspectRatio="none"` étire
// le repère, et il étire aussi l'épaisseur du trait — une courbe dans un bloc
// large devient un fil, dans un bloc étroit un boudin. D'où
// `vector-effect="non-scaling-stroke"` sur chaque tracé : l'épaisseur reste
// celle qu'on a écrite, quelle que soit la largeur du bloc.

/** Le tracé d'une série, en coordonnées du repère du SVG. */
function pointsDeCourbe(valeurs, largeur, hauteur, max) {
  const n = valeurs.length;
  if (!n) return '';
  // Un seul point ne fait pas une ligne : on le pose au milieu, et le cercle
  // qui l'accompagne le rend visible malgré tout.
  const pas = n > 1 ? largeur / (n - 1) : 0;
  return valeurs
    .map((v, i) => {
      const x = n > 1 ? i * pas : largeur / 2;
      const y = hauteur - (v / max) * (hauteur - 10);
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

/**
 * Factures par mois, en COURBE.
 *
 * Même série, même échelle et mêmes libellés que la version en barres : seule
 * la forme change. Une courbe se lit mieux quand on cherche une tendance, des
 * barres quand on compare deux mois — c'est exactement pourquoi le choix
 * existe, et pourquoi il ne change rien d'autre.
 */
function courbeParMois(series) {
  if (!series.length) return chartVide('Factures par mois', 'Aucun mois à représenter.');

  const H = 120;
  const W = 480;
  const max = Math.max(1, ...series.map((m) => m.count));
  const points = pointsDeCourbe(series.map((m) => m.count), W, H, max);

  // Les repères sont dessinés APRÈS le tracé pour rester au-dessus, et ils
  // portent l'infobulle : sur une courbe, il n'y a rien d'autre à survoler.
  const reperes = series
    .map((m, i) => {
      const x = series.length > 1 ? (i * W) / (series.length - 1) : W / 2;
      const y = H - (m.count / max) * (H - 10);
      const { long } = moisLisible(m.periode);
      return `<circle cx="${Math.round(x * 100) / 100}" cy="${Math.round(y * 100) / 100}" r="3"
        fill="var(--accent)" vector-effect="non-scaling-stroke"
      ><title>${esc(long)} — ${m.count} facture(s)</title></circle>`;
    })
    .join('');

  const libelles = series
    .map((m) => `<span>${esc(moisLisible(m.periode).court)}</span>`)
    .join('');

  return `<div class="chart">
    <div class="chart-title">Factures par mois <span class="chart-max">max ${fmt.number(max)}</span></div>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="Nombre de factures par mois sur les douze derniers mois">
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--border)" stroke-width="1"
            vector-effect="non-scaling-stroke"/>
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"
                vector-effect="non-scaling-stroke"/>
      ${reperes}
    </svg>
    <div class="chart-labels" style="grid-template-columns:repeat(${series.length},1fr);">
      ${libelles}
    </div>
  </div>`;
}

/** Combien de parts un anneau détaille avant de regrouper le reste. */
const ANNEAU_PARTS = 6;

/**
 * Répartition par service, en ANNEAU.
 *
 * ─── Comment il est dessiné, et pourquoi comme ça ───────────────────────────
 *
 * Par `stroke-dasharray` sur des cercles superposés, pas par des arcs calculés
 * en trigonométrie. Un arc SVG demande de placer deux points sur un cercle et
 * de choisir le bon drapeau de sens — trois occasions de se tromper, dont une
 * qui ne se voit qu'au-delà de 50 % (`large-arc-flag`), c'est-à-dire seulement
 * chez les comptes à service dominant. Le tiret, lui, est une longueur : il ne
 * peut pas se tromper de côté.
 *
 * ⚠ Le `viewBox` est CARRÉ et `preserveAspectRatio` reste par défaut : un
 * anneau étiré devient une ellipse, et une part de 25 % n'a plus l'air d'un
 * quart. C'est le seul graphique de l'accueil qui ne s'étire pas.
 *
 * La légende est en HTML sous l'anneau, et non dans le SVG — c'était la
 * réserve du lot 18 contre l'anneau, et c'est ce qui la lève : posée en HTML,
 * elle garde sa taille et passe à la ligne, y compris dans un bloc au quart de
 * ligne.
 */
function anneauParConnecteur(series, total) {
  if (!series.length || !total) {
    return chartVide('Répartition par service', 'Aucune facture à répartir.');
  }

  const visibles = series.slice(0, ANNEAU_PARTS);
  const reste = series.slice(ANNEAU_PARTS);
  const resteCount = reste.reduce((n, c) => n + c.count, 0);
  const parts = resteCount
    ? [...visibles, { id: '__reste', name: `${reste.length} autre(s) service(s)`, color: 'var(--border-strong)', count: resteCount }]
    : visibles;

  const R = 40;
  const CIRC = 2 * Math.PI * R;
  let parcouru = 0;

  const arcs = parts
    .map((c) => {
      const longueur = (c.count / total) * CIRC;
      // L'offset est CUMULÉ sur les longueurs exactes, jamais sur des
      // pourcentages arrondis : six parts arrondies au point près laisseraient
      // un liseré de fond visible entre la dernière et la première.
      const decalage = -parcouru;
      parcouru += longueur;
      const part = Math.round((c.count / total) * 100);
      return `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${esc(c.color)}"
        stroke-width="16" stroke-dasharray="${longueur.toFixed(3)} ${(CIRC - longueur).toFixed(3)}"
        stroke-dashoffset="${decalage.toFixed(3)}" transform="rotate(-90 50 50)"
      ><title>${esc(c.name)} — ${c.count} facture(s), ${part} % du total</title></circle>`;
    })
    .join('');

  const legende = parts
    .map(
      (c) => `<div class="chart-legend-item" title="${esc(c.name)} — ${c.count} facture(s)">
        <span class="chart-legend-dot" style="background:${esc(c.color)};"></span>
        <span class="chart-legend-name">${esc(c.name)}</span>
        <span class="chart-legend-val">${fmt.number(c.count)}</span>
      </div>`
    )
    .join('');

  return `<div class="chart">
    <div class="chart-title">Répartition par service</div>
    <svg class="chart-donut" viewBox="0 0 100 100" role="img"
         aria-label="Répartition des factures par service">
      ${arcs}
      <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
            font-size="13" font-weight="600" fill="var(--text)">${esc(fmt.number(total))}</text>
    </svg>
    <div class="chart-legend">${legende}</div>
  </div>`;
}

/**
 * Espace occupé par service — barres horizontales, en octets.
 *
 * Le même dessin que la répartition par nombre, et volontairement : ce sont
 * deux lectures du même classement, et les présenter différemment obligerait à
 * réapprendre à les lire. Ce qui change est l'unité — et elle est écrite en
 * clair sur chaque ligne, sans quoi « 1 240 » ne voudrait rien dire.
 */
function graphiqueStockage(series, total) {
  if (!series.length || !total) {
    return chartVide('Espace occupé par service', 'Aucun document stocké pour l\'instant.');
  }

  const visibles = series.slice(0, CONNECTEURS_AFFICHES);
  const reste = series.slice(CONNECTEURS_AFFICHES);
  const max = Math.max(1, ...visibles.map((c) => c.bytes));

  const lignes = visibles
    .map((c) => {
      const part = Math.round((c.bytes / total) * 100);
      const largeur = Math.max(2, Math.round((c.bytes / max) * 100));
      return `<div class="chart-row" title="${esc(c.name)} — ${esc(fmt.bytes(c.bytes))}, ${part} % de l'espace occupé, ${c.count} document(s)">
        <span class="chart-row-name">${esc(c.name)}</span>
        <svg class="chart-row-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" width="${largeur}" height="10" rx="2" fill="${esc(c.color)}"/>
        </svg>
        <span class="chart-row-val">${esc(fmt.bytes(c.bytes))}</span>
      </div>`;
    })
    .join('');

  const note = reste.length
    ? `<div class="chart-note">et ${reste.length} autre(s) service(s), ${esc(
        fmt.bytes(reste.reduce((n, c) => n + c.bytes, 0))
      )}</div>`
    : '';

  return `<div class="chart">
    <div class="chart-title">Espace occupé par service</div>
    <div class="chart-rows" role="img"
         aria-label="Espace occupé par service">${lignes}</div>
    ${note}
  </div>`;
}

/**
 * Services connectés au fil du temps — une courbe cumulée.
 *
 * ⚠ Elle ne peut que MONTER, et la note sous le graphique le dit. Une
 * désinstallation efface la ligne d'installation sans laisser de date : faire
 * redescendre la courbe demanderait une donnée que crabe n'a pas. Le taire
 * laisserait quelqu'un conclure qu'il n'a jamais rien retiré.
 */
function courbeConnecteurs(series) {
  if (!series.some((p) => p.count > 0)) {
    return chartVide(
      'Services connectés au fil du temps',
      'Aucun service connecté pour l\'instant.'
    );
  }

  const H = 120;
  const W = 480;
  const max = Math.max(1, ...series.map((p) => p.count));
  const points = pointsDeCourbe(series.map((p) => p.count), W, H, max);

  const reperes = series
    .map((p, i) => {
      const x = series.length > 1 ? (i * W) / (series.length - 1) : W / 2;
      const y = H - (p.count / max) * (H - 10);
      const { long } = moisLisible(p.periode);
      return `<circle cx="${Math.round(x * 100) / 100}" cy="${Math.round(y * 100) / 100}" r="3"
        fill="var(--accent)"
      ><title>${esc(long)} — ${p.count} service(s) connecté(s)</title></circle>`;
    })
    .join('');

  const libelles = series
    .map((p) => `<span>${esc(moisLisible(p.periode).court)}</span>`)
    .join('');

  return `<div class="chart">
    <div class="chart-title">Services connectés
      <span class="chart-max">${fmt.number(max)} au total</span></div>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="Nombre de services connectés au fil des douze derniers mois">
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--border)" stroke-width="1"
            vector-effect="non-scaling-stroke"/>
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"
                vector-effect="non-scaling-stroke"/>
      ${reperes}
    </svg>
    <div class="chart-labels" style="grid-template-columns:repeat(${series.length},1fr);">
      ${libelles}
    </div>
    <div class="chart-note">Ce compte ne redescend pas : crabe ne garde pas la date
      à laquelle un service a été retiré.</div>
  </div>`;
}

/**
 * Récupérations réussies et échouées, mois par mois — deux barres par mois.
 *
 * Deux barres côte à côte, et non empilées : empilées, la hauteur totale se lit
 * d'abord et donne « beaucoup de récupérations », alors que la question posée
 * est « combien ont raté ». Côte à côte, la comparaison est immédiate.
 *
 * Les essais de configuration ne sont pas comptés (voir home.executionsParMois) :
 * un test raté pendant une installation est un geste normal, pas une panne.
 */
function graphiqueExecutions(series) {
  if (!series.some((p) => p.ok || p.ko)) {
    return chartVide(
      'Récupérations réussies et échouées',
      'Aucune récupération lancée pour l\'instant.'
    );
  }

  const H = 120;
  const COL = 40;
  const W = COL * series.length;
  const max = Math.max(1, ...series.map((p) => Math.max(p.ok, p.ko)));

  const barres = series
    .map((p, i) => {
      const { long } = moisLisible(p.periode);
      const dessiner = (valeur, decalage, couleur, mot) => {
        const h = Math.max(valeur ? 4 : 2, Math.round((valeur / max) * (H - 10)));
        return `<rect x="${i * COL + decalage}" y="${H - h}" width="13" height="${h}" rx="3"
          fill="${valeur ? couleur : 'var(--border-strong)'}"
        ><title>${esc(long)} — ${valeur} ${mot}</title></rect>`;
      };
      return dessiner(p.ok, 7, 'var(--green)', 'réussie(s)')
        + dessiner(p.ko, 21, 'var(--red)', 'en échec');
    })
    .join('');

  const libelles = series
    .map((p) => `<span>${esc(moisLisible(p.periode).court)}</span>`)
    .join('');

  const totalOk = series.reduce((n, p) => n + p.ok, 0);
  const totalKo = series.reduce((n, p) => n + p.ko, 0);

  return `<div class="chart">
    <div class="chart-title">Récupérations
      <span class="chart-max">${fmt.number(totalOk)} réussies · ${fmt.number(totalKo)} en échec</span></div>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         role="img" aria-label="Récupérations réussies et en échec, mois par mois">
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--border)" stroke-width="1"
            vector-effect="non-scaling-stroke"/>
      ${barres}
    </svg>
    <div class="chart-labels" style="grid-template-columns:repeat(${series.length},1fr);">
      ${libelles}
    </div>
    <div class="chart-legend inline">
      <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--green);"></span>
        <span class="chart-legend-name">réussies</span></div>
      <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--red);"></span>
        <span class="chart-legend-name">en échec</span></div>
    </div>
  </div>`;
}

// --- c. Synchronisation -----------------------------------------------------

function widgetSync() {
  if (!home.data.sync.length) {
    return `<div class="empty-state">
      Aucun connecteur configuré. Installez-en un depuis le Store pour lancer une
      première récupération.
    </div>`;
  }

  // « Tout synchroniser » agit sur TOUS les connecteurs, pas sur la page
  // affichée : la pagination est un confort de lecture, elle ne doit pas
  // changer ce que fait un bouton.
  const bornes = pageDe('sync', home.data.sync.length);
  const page = home.data.sync.slice(bornes.debut, bornes.fin);
  const cartes = viewMode('home-sync') === 'cards';

  return `
    <div class="widget-tools">
      <button class="sync-all-btn" id="sync-all-btn" onclick="syncAll()">
        ${WIDGET_ICONS.sync} Tout synchroniser
      </button>
      ${triSelect('sync', home.data.syncTri, 'setSyncTri')}
    </div>
    <div class="${cartes ? 'sync-cards' : 'sync-list'}">
      ${page.map((c) => (cartes ? syncCard(c) : syncRow(c))).join('')}
    </div>
    ${paginationHtml('sync', bornes, 'connecteur(s)', home.data.sync.length)}`;
}

/**
 * L'état d'un service et le bouton qui va avec.
 *
 * Écrit une seule fois pour les deux présentations : la ligne et la carte
 * doivent porter exactement la même information et le même geste. Les écrire
 * deux fois, c'est en corriger une seule le jour où le libellé change.
 *
 * ⚠ Les identifiants d'éléments (`sync-status-…`, `sync-btn-…`) sont ceux que
 * `runHomeSync()` va chercher pour montrer l'avancement sans redessiner le
 * bloc. Ils doivent donc rester les MÊMES dans les deux présentations : la
 * bascule cartes / liste ne change pas ce que le bouton sait retrouver.
 */
function syncEtat(c) {
  return `<div class="sync-status" id="sync-status-${esc(c.id)}">${syncEtatCorps(c)}</div>`;
}

/**
 * Au-delà de cette longueur, un compte rendu se replie dans sa carte.
 *
 * Ce seuil décide du REPLI, pas de la hauteur : la ligne visible est de toute
 * façon ramenée à une seule ligne par la feuille de style. Il évite qu'un
 * message d'une phrase et demie parte derrière un « Tout lire » qu'il ne
 * mérite pas.
 */
const SYNC_MESSAGE_LONG = 90;

/**
 * Le contenu de la ligne d'état d'un service — en cours, compte rendu, ou
 * dernière synchronisation.
 *
 * Un seul rendu pour les deux moments : le dessin initial du bloc et le retour
 * d'une récupération lancée depuis l'accueil. Deux rendus divergeraient le jour
 * où l'un des deux changerait.
 */
function syncEtatCorps(c) {
  if (c.running) return '<span class="spinner"></span> en cours…';
  if (c.lastMessage) return syncMessageHtml(c.lastMessage, { echec: c.lastOk === false });
  return `<span class="sync-ligne">${esc(c.lastRunAt ? fmt.relative(c.lastRunAt) : 'jamais synchronisé')}</span>`;
}

/**
 * Le début d'un message : sa première phrase, coupée au mot si elle est
 * elle-même trop longue. Même règle que `phraseCourte` côté serveur.
 */
function syncDebut(brut) {
  const fin = brut.indexOf('. ');
  const premiere = fin === -1 ? brut : brut.slice(0, fin + 1);
  if (premiere.length <= SYNC_MESSAGE_LONG) return premiere;

  const tronque = premiere.slice(0, SYNC_MESSAGE_LONG);
  const espace = tronque.lastIndexOf(' ');
  const mots = espace > SYNC_MESSAGE_LONG / 3 ? tronque.slice(0, espace) : tronque;
  return `${mots.replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * Un compte rendu de service, sur UNE ligne, dépliable s'il est long (lot 65).
 *
 * ─── Ce que ça répare ────────────────────────────────────────────────────────
 *
 * Le 26/08/2026, la carte Decathlon faisait TROIS FOIS la hauteur des autres et
 * celle d'Électro Dépôt le double : elles affichaient leur explication entière
 * (565 et 428 caractères). Les cartes ne s'alignaient plus, le bloc était
 * déséquilibré.
 *
 * ─── La règle, valable pour TOUS les connecteurs ─────────────────────────────
 *
 * La carte montre une ligne ; le message entier se déplie d'un clic et se
 * replie du suivant. `<details>` natif, comme `fieldHelp` (lot 57) : c'est le
 * navigateur qui s'en charge, au clavier comme à la souris. Replié, tout le
 * monde a la même hauteur — c'est le but.
 *
 * ⚠ **Un échec reste lisible SANS déplier.** « Échec » ouvre la ligne, suivi du
 * début de l'explication : personne ne doit avoir à cliquer pour découvrir
 * qu'une récupération a échoué. Certains connecteurs le disent déjà en tête de
 * leur message — on ne l'écrit pas deux fois.
 */
function syncMessageHtml(texte, { echec = false } = {}) {
  const brut = String(texte == null ? '' : texte).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!brut) return '';

  const marque = echec && !/^échec\b/i.test(brut) ? '<b class="sync-echec">Échec</b> — ' : '';

  if (brut.length <= SYNC_MESSAGE_LONG) {
    return `<span class="sync-ligne">${marque}${esc(brut)}</span>`;
  }

  return `<details class="sync-plus">
    <summary class="sync-ligne"><span class="sync-resume">${marque}${esc(syncDebut(brut))}</span></summary>
    <div class="sync-plus-corps">${esc(brut)}</div>
  </details>`;
}

/** Le compte rendu d'une récupération, écrit sur la carte du service. */
function majEtatSync(id, message, ok) {
  const c = home.data?.sync?.find((s) => s.id === id);
  if (c) {
    c.running = false;
    c.lastMessage = message;
    c.lastOk = ok !== false;
  }
  const zone = $(`sync-status-${id}`);
  if (!zone) return;
  zone.innerHTML = c ? syncEtatCorps(c) : syncMessageHtml(message, { echec: ok === false });
}

function syncAction(c) {
  return c.health && !c.health.canSync
    ? `<button class="sync-btn fix" onclick="reconfigureFromHome('${esc(c.id)}')">
         ${esc(c.health.action?.label || 'Configurer')}
       </button>`
    : `<button class="sync-btn" id="sync-btn-${esc(c.id)}" onclick="runHomeSync('${esc(c.id)}')"
          ${c.running ? 'disabled' : ''}>Synchroniser</button>`;
}

/** Une ligne de synchronisation — l'affichage d'origine, inchangé. */
function syncRow(c) {
  return `<div class="sync-row" id="sync-row-${esc(c.id)}">
    <div class="conn-icon small" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
    <div class="sync-name">${esc(c.name)}</div>
    ${syncEtat(c)}
    ${syncAction(c)}
  </div>`;
}

/**
 * Une carte de synchronisation.
 *
 * Elle porte ce que porte la ligne — logo, nom, état, dernière exécution,
 * action — mais disposée pour être balayée du regard plutôt que lue de gauche
 * à droite. Rien de plus : une carte qui montrerait autre chose que la ligne
 * ferait de la bascule un changement de contenu, alors que c'est une bascule
 * de présentation.
 */
function syncCard(c) {
  return `<div class="sync-card" id="sync-row-${esc(c.id)}">
    <div class="sync-card-head">
      <div class="conn-icon small" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
      <div class="sync-card-name">${esc(c.name)}</div>
    </div>
    <div class="sync-card-state">${syncEtat(c)}</div>
    <div class="sync-card-actions">${syncAction(c)}</div>
  </div>`;
}

/**
 * Lance la récupération d'un connecteur depuis l'accueil.
 *
 * Le serveur refuse (409) une seconde exécution sur le même connecteur : on
 * grise le bouton en plus, pour que la situation soit lisible avant même
 * l'aller-retour.
 *
 * @returns {Promise<boolean>} vrai si la récupération a réussi
 */
async function runHomeSync(id, { silent = false } = {}) {
  const status = $(`sync-status-${id}`);
  const button = $(`sync-btn-${id}`);
  if (button) button.disabled = true;
  if (status) status.innerHTML = '<span class="spinner"></span> en cours…';

  try {
    const result = await api(`/connectors/${id}/run`, { method: 'POST' });
    // Le compte rendu passe par le rendu commun : long, il se replie et la
    // carte garde sa hauteur ; en échec, il le dit sans qu'on ait à déplier.
    majEtatSync(id, result.message, result.ok);
    if (!silent) showToast(`${connectorLabel(id)} — ${result.message}`);
    return result.ok;
  } catch (err) {
    majEtatSync(id, err.message, false);
    if (!silent) showToast(`${connectorLabel(id)} — ${err.message}`);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function connectorLabel(id) {
  return home.data?.sync.find((c) => c.id === id)?.name || id;
}

/** « Tout synchroniser » : un connecteur après l'autre, jamais en parallèle. */
async function syncAll() {
  const button = $('sync-all-btn');
  if (button) button.disabled = true;

  let succeeded = 0;
  const rows = [...(home.data?.sync || [])];
  for (const connector of rows) {
    if (await runHomeSync(connector.id, { silent: true })) succeeded++;
  }

  showToast(`Synchronisation terminée — ${succeeded}/${rows.length} connecteur(s) en succès`);
  if (button) button.disabled = false;
  await renderHome();
}

// --- d. Suivi actions -------------------------------------------------------
//
// Chaque ligne porte L'ACTION QUI RÉSOUT SON PROBLÈME, et pas un « Réessayer »
// systématique. Jusqu'au lot 6, un connecteur jamais configuré, une connexion
// expirée et des identifiants refusés proposaient tous « Réessayer » — un
// bouton qui ramenait à la même erreur, à chaque fois. C'est l'unique raison
// pour laquelle `health` existe côté serveur.
//
// ─── Ce que le lot 25 change, et pourquoi ────────────────────────────────────
//
// Le bloc s'appelait « Erreurs et alertes », et il tenait exactement cette
// promesse : il ne montrait que ce qui allait mal. Une récupération réussie n'y
// figurait pas — pas même celle qui rapporte ZÉRO document, qui est pourtant la
// plus rassurante des réponses : crabe est allé voir, il a été reçu, il n'y
// avait rien de neuf. « Aucune nouvelle facture » n'est pas un avertissement,
// c'est « tout est à jour ».
//
// Trois natures, trois couleurs, et l'ordre n'est pas décoratif : ce qui
// demande un geste vient d'abord, ce qui rassure vient après.
//
//   rouge — une récupération a échoué, ou une copie n'est pas partie
//   jaune — attention requise, rien n'est cassé (un service à configurer,
//           une connexion à rouvrir)
//   vert  — c'est passé, y compris à zéro document

/** Les trois natures, dans l'ordre où le bloc les empile. */
const NATURES = [
  { cle: 'erreur', mot: 'en échec' },
  { cle: 'alerte', mot: 'en attente' },
  { cle: 'succes', mot: 'à jour' },
];

function widgetErrors() {
  const echecs = (home.data.errors || []).map((e) => ({ ...e, nature: 'erreur' }));
  const vus = new Set(echecs.map((e) => e.connectorId));

  // Un service en échec n'est PAS montré une seconde fois en jaune : il a déjà
  // sa ligne rouge, et deux lignes de couleurs contraires pour le même service
  // seraient pires que pas de ligne du tout.
  const attentes = (home.data.pendingActions || [])
    .filter((p) => !vus.has(p.connectorId))
    .map((p) => ({ ...p, nature: 'alerte' }));
  for (const a of attentes) vus.add(a.connectorId);

  // Même règle pour le vert : la dernière exécution d'un service ne peut pas
  // être à la fois réussie et en échec.
  const reussites = (home.data.successes || [])
    .filter((r) => !vus.has(r.connectorId))
    .map((r) => ({ ...r, nature: 'succes' }));

  const copies = (home.data.copyFailures || []).map(copyFailureRow).join('');
  const lignes = [...echecs, ...attentes, ...reussites];

  if (!lignes.length && !copies) {
    return `<div class="err-empty">
      <div class="chk">✓</div>
      Rien à signaler pour l'instant — aucune récupération n'a encore eu lieu.
    </div>`;
  }

  return bilanSuivi(lignes, home.data.copyFailures || [])
    + lignes.map((e) => errorRow(e)).join('')
    + copies;
}

/**
 * Le compte rendu en une ligne, au-dessus du détail.
 *
 * Il répond à la seule question qu'on se pose en arrivant sur l'accueil — « y
 * a-t-il quelque chose à faire ? » — sans avoir à lire les lignes une par une.
 * Une nature absente ne s'affiche pas : « 0 en échec » attire l'œil sur un
 * chiffre qui ne veut rien dire.
 */
function bilanSuivi(lignes, copies) {
  const compte = {
    erreur: lignes.filter((l) => l.nature === 'erreur').length + copies.length,
    alerte: lignes.filter((l) => l.nature === 'alerte').length,
    succes: lignes.filter((l) => l.nature === 'succes').length,
  };
  const parts = NATURES.filter((n) => compte[n.cle]).map(
    (n) => `<span class="b-${n.cle}"><i></i>${compte[n.cle]} ${esc(n.mot)}</span>`
  );
  return parts.length ? `<div class="err-bilan">${parts.join('')}</div>` : '';
}

/**
 * Une copie vers un cloud restée en échec.
 *
 * Elle ne sera **jamais** reprise toute seule : après trois tentatives, crabe
 * s'arrête et attend un geste. Sans cette ligne, l'échec serait invisible — la
 * récupération, elle, a réussi, et le document est bien sur le stockage local.
 */
function copyFailureRow(f) {
  const detail = f.message ? ` — ${f.message}` : '';
  return `
    <div class="err-item erreur">
      <div class="err-top">
        <div class="conn-icon tiny" style="background:${esc(f.color)};">${esc(f.letter)}${logoHtml(f)}</div>
        <div class="err-name">${esc(f.name)}</div>
        <span class="err-etat"></span>
      </div>
      <div class="err-msg">
        ${f.count} document(s) n'ont pas pu être copiés vers ${esc(f.name)}${esc(detail)}.
        Ils restent en sécurité sur le stockage local ; aucune reprise n'a lieu toute seule.
      </div>
      <div class="err-actions">
        <button class="err-retry" onclick="syncDestinationFromHome('${esc(f.destinationId)}', this)">
          Synchroniser
        </button>
      </div>
    </div>`;
}

/**
 * Une ligne du bloc, quelle que soit sa nature.
 *
 * Un succès n'a pas de `health` et n'a besoin d'aucun bouton : il ne demande
 * rien. C'est la seule différence de traitement — tout le reste, pastille,
 * nom, message, date, est identique, parce que ces lignes se lisent en colonne
 * et qu'une mise en forme par nature les rendrait illisibles.
 */
function errorRow(e) {
  const etat = e.health || {};
  const nature = e.nature || 'erreur';
  // Ce qu'on montre, c'est la phrase de `health` — écrite pour un humain — et
  // non le message brut du fournisseur, qui reste dans les journaux.
  const message = etat.detail || e.message || 'Échec sans message.';

  const boutons = [];
  if (etat.canSync) {
    boutons.push(
      `<button class="err-retry" onclick="retryFromHome('${esc(e.connectorId)}', this)">
         ${esc(etat.action?.id === 'sync' ? etat.action.label : 'Réessayer')}
       </button>`
    );
  }
  if (etat.canReconfigure) {
    boutons.push(
      `<button class="err-fix" onclick="reconfigureFromHome('${esc(e.connectorId)}')">
         ${esc(etat.canSync ? 'Reconfigurer' : etat.action?.label || 'Configurer')}
       </button>`
    );
  }

  return `
    <div class="err-item ${esc(nature)}">
      <div class="err-top">
        <div class="conn-icon tiny" style="background:${esc(e.color)};">${esc(e.letters)}${logoHtml(e)}</div>
        <div class="err-name">${esc(e.name)}</div>
        <span class="err-etat"></span>
        <div class="err-msg" title="${esc(message)}">${esc(message)}</div>
        <div class="err-actions">${boutons.join('')}</div>
        ${e.at ? `<div class="err-date" title="${esc(fmt.exact(e.at))}">${esc(fmt.relative(e.at))}</div>` : ''}
      </div>
    </div>`;
}

/** Ouvre la fiche du connecteur en mode saisie, depuis l'accueil. */
async function reconfigureFromHome(id) {
  if (!state.connectors.length) await loadConnectors();
  openModal(id, { edit: true });
}

async function retryFromHome(id, button) {
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> en cours…';
  try {
    const result = await api(`/connectors/${id}/run`, { method: 'POST' });
    showToast(result.message);
  } catch (err) {
    showToast(err.message);
  }
  await renderHome();
}

// --- e. Derniers documents --------------------------------------------------

function widgetDocuments() {
  const documents = home.data.documents;

  if (!documents.length) {
    return `<div class="empty-state">
      Aucun document pour l'instant. Installez un connecteur depuis le
      <button class="link-btn" onclick="showView('store')">Store</button>
      pour récupérer vos premières factures.
    </div>`;
  }

  const bornes = pageDe('documents', documents.length);
  const page = documents.slice(bornes.debut, bornes.fin);
  const cartes = viewMode('home-documents') === 'cards';

  const corps = cartes
    ? `<div class="home-doc-cards">${page.map(homeDocCard).join('')}</div>`
    // Nombre impair : la dernière ligne occupe la largeur entière, plutôt que
    // de laisser une case vide en deuxième colonne. Se calcule sur la PAGE
    // affichée, pas sur le total — c'est la dernière visible qui s'étend.
    : `<div class="docs-grid">${page
        .map((d, i) => homeDocRow(d, page.length % 2 === 1 && i === page.length - 1))
        .join('')}</div>`;

  return `${corps}
    ${paginationHtml('documents', bornes, 'document(s)', documents.length)}
    <div class="docs-foot">
      <span>${fmt.number(documents.length)} document(s) les plus récents</span>
      <button class="link-btn" onclick="showView('documents')">Voir tous mes documents</button>
    </div>`;
}

/** Les pastilles d'état de transfert d'un document, une par destination. */
function homeDocDests(d) {
  return d.destinations
    .map(
      (dest) =>
        `<span class="dest-pill ${esc(dest.state)}" title="${esc(dest.tooltip)}">${esc(dest.letter)}${logoHtml(dest)}</span>`
    )
    .join('');
}

/** Le renvoi et le téléchargement — les deux mêmes gestes dans les deux vues. */
function homeDocActions(d) {
  return `${
    d.hasError
      ? `<button class="doc-resend" onclick="resendDocument(${d.id}, this)">Renvoyer</button>`
      : ''
  }<a class="doc-dl" href="/api/connectors/me/invoices/${d.id}/file" download
       title="Télécharger ${esc(d.filename)}">${ICON_DOWNLOAD}</a>`;
}

/** Une ligne de document — l'affichage d'origine, inchangé. */
function homeDocRow(d, pleineLargeur) {
  return `
    <div class="doc-row${pleineLargeur ? ' full' : ''}">
      <div class="doc-icon" style="background:${esc(d.color)};">${esc(d.letters)}${logoHtml(d)}</div>
      <div class="doc-main">
        <div class="doc-name">${esc(d.connectorName)}${d.period ? ` · ${esc(d.period)}` : ''}</div>
        <div class="doc-sub">réf. ${esc(d.reference)} · ${esc(fmt.bytes(d.sizeBytes))}</div>
      </div>
      <div class="doc-dests">${homeDocDests(d)}</div>
      ${homeDocActions(d)}
    </div>`;
}

/**
 * Une carte de document de l'accueil.
 *
 * Elle porte exactement ce que porte la ligne — service, période, référence,
 * taille, état de transfert, renvoi et téléchargement —, disposée en hauteur.
 *
 * ⚠ Mécanisme DISTINCT de celui de l'écran « Mes documents » : cette carte-ci
 * montre un document récent, celle de l'écran montre un fichier rangé dans son
 * arborescence. Elles se ressemblent, elles ne disent pas la même chose, et
 * elles se règlent séparément (`view.home-documents` contre `view.documents`).
 */
function homeDocCard(d) {
  return `<div class="home-doc-card">
    <div class="home-doc-card-head">
      <div class="doc-icon" style="background:${esc(d.color)};">${esc(d.letters)}${logoHtml(d)}</div>
      <div class="home-doc-card-titles">
        <div class="doc-name">${esc(d.connectorName)}</div>
        <div class="doc-sub">${d.period ? esc(d.period) : 'période inconnue'}</div>
      </div>
    </div>
    <div class="home-doc-card-facts">
      <div><span class="fact-label">Référence</span>
        <span class="fact-value" title="${esc(d.filename)}">${esc(d.reference)}</span></div>
      <div><span class="fact-label">Taille</span>
        <span class="fact-value">${esc(fmt.bytes(d.sizeBytes))}</span></div>
    </div>
    <div class="home-doc-card-foot">
      <div class="doc-dests">${homeDocDests(d)}</div>
      <div class="home-doc-card-actions">${homeDocActions(d)}</div>
    </div>
  </div>`;
}

/** Recopie un document vers les destinations manquantes, sans retéléchargement. */
async function resendDocument(invoiceId, button) {
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const result = await api(`/connectors/me/invoices/${invoiceId}/resend`, { method: 'POST' });
    showToast(result.message);
  } catch (err) {
    showToast(err.message);
  }
  await renderHome();
}

// --- f. État des destinations -----------------------------------------------

function widgetDestinations() {
  const cards = home.data.destinations
    .map((d) => {
      const space = d.space || { known: false };
      // Barre : occupation RÉELLE du volume, pas la part de crabe — sur un
      // partage de 550 Go, 0,58 Mo donnerait une barre vide et trompeuse.
      const pct = space.known && space.totalBytes
        ? Math.min(100, Math.round(((space.totalBytes - space.freeBytes) / space.totalBytes) * 100))
        : 0;

      // La mesure d'espace est gardée quelques minutes (lot 54) : l'écran dit
      // de quand elle date au lieu de la présenter comme instantanée.
      const datee = space.measuredAt
        ? ` <span class="text-faint" title="${esc(fmt.exact(space.measuredAt))}">(mesuré ${esc(fmt.relative(space.measuredAt))})</span>`
        : '';
      const remaining = space.known
        ? `<strong>${esc(fmt.bytes(space.freeBytes))} restants</strong>${datee}`
        : `<span class="text-faint" title="${esc(space.reason || '')}">espace restant inconnu</span>${datee}`;

      // « 12 documents · 3 en attente » : ce sont les documents de CE compte,
      // pas ceux de l'installation — c'est sur eux qu'agit « Synchroniser ».
      const attente = d.pending
        ? ` · <span class="dest-pending">${d.pending} en attente</span>`
        : '';

      return `
      <div class="dest-card-home">
        <div class="dest-card-top">
          <div class="dest-card-icon" style="background:${esc(d.color)};">${esc(d.letter)}${logoHtml(d)}</div>
          <div class="dest-card-name">${esc(d.name)}</div>
          <span class="badge-pill green">actif</span>
        </div>
        <div class="dest-space-bar" title="${esc(space.known ? `Volume occupé à ${pct} %` : 'Occupation du volume inconnue')}">
          <div class="dest-space-fill" style="width:${space.known ? Math.max(pct, 1) : 0}%;"></div>
        </div>
        <div class="dest-card-meta">${esc(fmt.bytes(d.usedBytes))} utilisés par crabe · ${remaining}</div>
        <div class="dest-card-meta">${d.yourFiles} document(s) à vous${attente}</div>
        <div class="dest-card-meta">
          ${d.lastTestAt
            ? `testé <span title="${esc(fmt.exact(d.lastTestAt))}">${esc(fmt.relative(d.lastTestAt))}</span> — ${d.lastTestOk ? 'succès' : 'échec'}`
            : 'jamais testé'}
        </div>
        <div class="dest-card-meta dest-sync-live" id="dest-sync-live-${esc(d.id)}" hidden></div>
        <div class="dest-card-actions">
          ${destSyncButton(d)}
          <button class="dest-test" onclick="testDestinationFromHome('${esc(d.id)}', this)">Tester</button>
        </div>
      </div>`;
    })
    .join('');

  const note = home.data.hiddenDestinationsNote
    ? `<div class="dest-hidden-note">${esc(home.data.hiddenDestinationsNote)}</div>`
    : '';

  return `${destSyncAll()}<div class="dests-grid">${cards}</div>${note}`;
}

/**
 * « Synchroniser » sur la carte d'une destination — sur TOUTES les cartes.
 *
 * ─── Ce que le lot 12 corrige ────────────────────────────────────────────────
 *
 * Jusqu'ici le bouton n'existait que sur les destinations secondaires. Sur une
 * installation où seul le stockage local est activé — le cas par défaut — l'accueil
 * n'en portait donc AUCUN, et le bloc ne disait pas pourquoi. Un bouton absent
 * ne s'explique pas : on le cherche, on ne le trouve pas, et on conclut que la
 * fonction n'existe pas.
 *
 * Chaque destination active porte donc le sien. Sur le stockage local il est grisé,
 * avec sa raison : le stockage local est la copie de RÉFÉRENCE, celle d'où partent
 * toutes les autres. La synchroniser vers elle-même n'aurait aucun sens — et
 * un document qui y manquerait ne se rattraperait pas par une copie, mais par
 * une nouvelle récupération chez le fournisseur.
 */
function destSyncButton(d) {
  if (d.canSync) {
    const quoi = d.pending
      ? `Envoyer vers ${d.name} les ${d.pending} document(s) qui lui manquent`
      : `${d.name} a déjà tout reçu — relancer ne fera rien de mal`;
    return `<button class="dest-sync" id="dest-sync-${esc(d.id)}" title="${esc(quoi)}"
                    onclick="syncDestinationFromHome('${esc(d.id)}', this)">Synchroniser</button>`;
  }

  return `<button class="dest-sync" id="dest-sync-${esc(d.id)}" disabled
                  title="${esc(RAISON_LOCAL)}">Synchroniser</button>`;
}

/** Pourquoi la copie de référence ne se synchronise pas vers elle-même. */
const RAISON_LOCAL =
  'Le stockage local est la copie de référence : c\'est d\'elle que partent toutes les autres. '
  + 'Il n\'y a rien à lui envoyer.';

/**
 * « Tout synchroniser vers les clouds » — visible en permanence.
 *
 * Grisé, avec l'explication et le chemin à suivre, quand aucun cloud n'est
 * activé. Le faire disparaître laissait croire que le bouton n'existait pas,
 * alors qu'il ne manquait qu'un réglage à deux écrans de là.
 */
function destSyncAll() {
  const secondaires = home.data.destinations.filter((d) => d.canSync);
  const attente = secondaires.reduce((n, d) => n + (d.pending || 0), 0);

  const note = secondaires.length
    ? attente
      ? `${attente} document(s) en attente de copie.`
      : 'Tout est déjà en place.'
    // ⚠ Cette phrase nommait « Proton Drive ou pCloud » jusqu'au lot 24, quand
    // les destinations étaient six constantes du code. Elles n'existent plus
    // d'office : nommer deux fournisseurs enverrait chercher sur l'écran
    // Stockage deux cartes qui n'y sont pas.
    : 'Aucun espace en ligne pour l\'instant — Paramètres → Stockage, puis « Ajouter un cloud ».';

  return `<div class="dests-head">
    <button class="dest-sync-all" id="dest-sync-all"${secondaires.length ? '' : ' disabled'}
            title="${esc(secondaires.length
              ? 'Envoyer à chaque cloud ce qui lui manque'
              : 'Il n\'y a aucun cloud vers lequel copier vos documents.')}"
            onclick="syncAllDestinations(this)">
      Tout synchroniser vers les clouds
    </button>
    <span class="dest-sync-note" id="dest-sync-note">${esc(note)}</span>
  </div>`;
}

/**
 * Suit une synchronisation jusqu'à son terme, et rend compte.
 *
 * Le serveur rend la main tout de suite — un rattrapage de cent documents vers
 * un cloud ne tient pas dans une requête HTTP — et publie son avancement. On
 * interroge chaque seconde, bouton grisé, jusqu'à ce qu'il ait fini.
 *
 * @param {(texte: string) => void} afficher
 * @returns {Promise<object>} l'état final
 */
async function suivreSynchronisation(afficher) {
  for (;;) {
    const etat = await api('/home/destinations/sync');
    if (!etat.running) return etat;
    afficher(
      etat.total
        ? `${etat.done}/${etat.total} document(s)…`
        : 'synchronisation…'
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * L'avancement de la synchronisation, écrit SUR les cartes (lot 35).
 *
 * ─── Ce que ça répare ────────────────────────────────────────────────────────
 *
 * Le 15/08/2026, une synchronisation de 632 documents vers pCloud tournait —
 * et rien à l'écran ne le disait : le bouton qui l'avait lancée affichait bien
 * son compteur, mais un rechargement de page le perdait, et le bloc de la
 * destination restait figé. La seule preuve de vie était le compte de fichiers
 * qui finissait par changer.
 *
 * ─── Le canal : le sondage périodique, pas le relais WebSocket ───────────────
 *
 * Le serveur publie déjà son avancement (`/home/destinations/sync`, un objet
 * en mémoire — voir destinations/sync.js) et ce fichier l'interrogeait déjà en
 * boucle pour le bouton. Le relais WebSocket de crabe, lui, est écrit pour les
 * flux noVNC des fenêtres visibles : y brancher un compteur demanderait de lui
 * apprendre un second protocole, pour gagner au mieux deux secondes de latence
 * sur un transfert qui en dure des centaines. Un sondage toutes les deux
 * secondes, actif SEULEMENT pendant qu'une synchronisation tourne, suffit.
 *
 * Le compte affiché vient de ce que la synchronisation a RÉELLEMENT fait
 * (`copied`/`failed`, incrémentés copie par copie) — jamais une estimation.
 */
let syncVeille = null;

/** Écrit l'avancement sur les cartes visées ; efface les autres. */
function majProgressionSync(etat) {
  for (const d of home.data?.destinations || []) {
    const ligne = document.getElementById(`dest-sync-live-${d.id}`);
    if (!ligne) continue;
    if (etat.running && (etat.destinationIds || []).includes(d.id)) {
      const bouts = [`synchronisation en cours — ${etat.copied} document(s) copié(s) sur ${etat.total}`];
      if (etat.failed) bouts.push(`${etat.failed} en échec`);
      ligne.textContent = bouts.join(', ');
      ligne.hidden = false;
    } else {
      ligne.textContent = '';
      ligne.hidden = true;
    }
  }
}

/**
 * Suit une synchronisation en cours — y compris une synchronisation lancée
 * AVANT l'arrivée sur la page, ou depuis un autre écran. À la fin : les
 * lignes s'effacent, le résultat s'écrit en toutes lettres dans la note du
 * bloc (pas seulement dans un toast qui disparaît), et l'accueil se recharge
 * pour remettre les compteurs à jour. Un échec en route est dit pareil —
 * jamais un bloc muet sur un échec (famille des lots 31 et 33).
 */
async function surveillerSynchronisation() {
  if (syncVeille) return; // une seule veille à la fois
  let etat;
  try {
    etat = await api('/home/destinations/sync');
  } catch {
    return; // l'accueil vient d'être rendu : ne rien casser pour un sondage
  }
  if (!etat.running) return;
  majProgressionSync(etat);

  syncVeille = setInterval(async () => {
    let suivant;
    try {
      suivant = await api('/home/destinations/sync');
    } catch {
      return; // réseau momentanément muet : on retentera au prochain tic
    }
    if (suivant.running) {
      majProgressionSync(suivant);
      return;
    }
    clearInterval(syncVeille);
    syncVeille = null;
    if (suivant.message) showToast(suivant.message);
    await renderHome();
    // Après le re-rendu : le compte rendu reste lisible dans la note du bloc.
    const note = document.getElementById('dest-sync-note');
    if (note && suivant.message) note.textContent = suivant.message;
  }, 2000);
}

/** Lance une synchronisation et attend son compte rendu. */
async function lancerSynchronisation({ bouton, destinationId = null, libelle }) {
  if (bouton?.disabled) return; // déjà en cours : pas de second lancement
  const rendu = bouton ? bouton.innerHTML : '';
  if (bouton) {
    bouton.disabled = true;
    bouton.innerHTML = '<span class="spinner"></span> démarrage…';
  }

  try {
    await api('/home/destinations/sync', {
      method: 'POST',
      body: destinationId ? { destinationId } : {},
    });
    // Les cartes suivent aussi, pas seulement le bouton : un rechargement de
    // page en cours de route ne perd plus l'avancement.
    surveillerSynchronisation();
    const etat = await suivreSynchronisation((texte) => {
      if (bouton) bouton.innerHTML = `<span class="spinner"></span> ${esc(texte)}`;
    });
    showToast(`${libelle} — ${etat.message}`);
  } catch (err) {
    showToast(err.message);
  } finally {
    if (bouton) {
      bouton.disabled = false;
      bouton.innerHTML = rendu;
    }
  }
  await renderHome();
}

/** « Synchroniser » sur la carte d'une destination. */
async function syncDestinationFromHome(id, bouton) {
  const carte = home.data.destinations.find((d) => d.id === id);
  await lancerSynchronisation({ bouton, destinationId: id, libelle: carte?.name || id });
}

/** « Tout synchroniser vers les clouds ». */
async function syncAllDestinations(bouton) {
  await lancerSynchronisation({ bouton, libelle: 'Toutes les destinations' });
}

/** Étapes d'un test de destination : un montage réseau peut mettre du temps. */
const ETAPES_DESTINATION = [
  { apres: 0, texte: 'test…' },
  { apres: 5000, texte: 'l\'espace ne répond pas encore…' },
];

async function testDestinationFromHome(id, button) {
  await actionLongue({
    bouton: button,
    etapes: ETAPES_DESTINATION,
    afficher: (texte) => {
      if (button) button.innerHTML = `<span class="spinner"></span> ${esc(texte)}`;
    },
    executer: async () => {
      try {
        const result = await api(`/home/destinations/${id}/test`, { method: 'POST' });
        showToast(result.message);
      } catch (err) {
        showToast(err.message);
      }
    },
  });
  await renderHome();
}

// ---------------------------------------------------------------------------
// Personnalisation : panneau, glisser-déposer, ordre
// ---------------------------------------------------------------------------

function openHomePanel() {
  // Verrou administrateur : le panneau ne s'ouvre pas du tout, il n'y aurait
  // rien à y faire. Le bouton est déjà grisé, ceci couvre l'appel direct.
  if (!home.access.adminAllowed) {
    showToast('La personnalisation de l\'accueil est désactivée par l\'administrateur.');
    return;
  }
  renderHomePanel();
  $('home-panel').classList.add('open');
  $('home-panel-overlay').classList.add('open');
}

function closeHomePanel() {
  $('home-panel').classList.remove('open');
  $('home-panel-overlay').classList.remove('open');
}

/**
 * « Figer mon accueil », dans le panneau qui sert à le réorganiser (lot 26).
 *
 * Ce réglage vivait dans Profil → Général. Il y était pourtant le seul de son
 * espèce : tout ce qui décide de la DISPOSITION de l'accueil — quels blocs,
 * dans quel ordre, sur quelle largeur, combien par page — se règle dans ce
 * panneau-ci. Figer, c'est décider qu'on n'y touche plus ; le chercher dans un
 * autre écran obligeait à faire l'aller-retour au moment précis où l'on vient
 * de comprendre qu'on est bloqué.
 *
 * Il est placé EN TÊTE, avant la liste des blocs, parce qu'il commande tout ce
 * qui suit : quand il est posé, les cases et les flèches en dessous sont
 * inertes, et il faut pouvoir le voir sans faire défiler.
 *
 * Le verrou de l'ADMINISTRATEUR, lui, ne se lève pas d'ici : l'interrupteur est
 * alors grisé et la note du dessus l'explique.
 */
function verrouAccueilHtml() {
  const { adminAllowed, personalLock } = home.access;

  return `<div class="panel-lock">
    <div class="panel-lock-head">
      <span class="panel-lock-title">Figer mon accueil</span>
      <span class="badge-pill ${personalLock ? 'amber' : 'gray'}">
        ${personalLock ? 'Accueil figé' : 'Accueil modifiable'}
      </span>
      <div class="toggle ${personalLock ? 'on' : ''} ${adminAllowed ? '' : 'disabled'}"
           role="switch" aria-checked="${personalLock ? 'true' : 'false'}"
           aria-label="Figer mon accueil"
           ${adminAllowed ? 'onclick="toggleHomeLock()"' : ''}><div class="knob"></div></div>
    </div>
    <div class="panel-lock-desc">${
      personalLock
        ? 'Les blocs ne peuvent plus être déplacés ni redimensionnés — pratique pour éviter '
          + 'un déplacement au doigt. Retirez ce verrou pour réorganiser votre accueil.'
        : 'Figez la disposition pour éviter de déplacer un bloc par mégarde, notamment sur '
          + 'écran tactile. Vous pouvez la défiger à tout moment.'
    }</div>
  </div>`;
}

function renderHomePanel() {
  const editable = home.access.canCustomize;

  const note = !home.access.adminAllowed
    ? '<div class="panel-lock-note">La personnalisation de l\'accueil est désactivée par ' +
      'l\'administrateur. La disposition ci-dessous reste celle qui s\'applique, mais elle ' +
      'ne peut plus être modifiée depuis ce compte.</div>'
    : home.access.personalLock
      ? '<div class="panel-lock-note">Votre accueil est figé. Retirez le verrou ci-dessous ' +
        'pour le réorganiser à nouveau.</div>'
      : '';

  $('home-panel-list').innerHTML =
    note + verrouAccueilHtml() +
    uniqueWidgets(home.widgets)
      .map((w, index, list) => {
        // Le réglage interne passe à la ligne sous sa rangée : `with-sub` est
        // ce qui autorise le retour à la ligne, sans quoi il viendrait se
        // serrer entre le titre du bloc et les flèches de déplacement.
        const reglage = reglageInterne(w, editable);
        return `
    <div class="panel-item ${editable ? '' : 'readonly'}${reglage ? ' with-sub' : ''}"
         data-widget="${esc(w.id)}"
         ${editable
           ? `draggable="true"
         ondragstart="onWidgetDragStart(event, '${esc(w.id)}')"
         ondragover="onWidgetDragOver(event)"
         ondrop="onWidgetDrop(event, '${esc(w.id)}')"
         ondragend="onWidgetDragEnd(event)"`
           : ''}>
      ${editable ? `<span class="panel-drag" title="Glisser pour réordonner">${ICON_GRIP}</span>` : ''}
      <label class="panel-item-title">
        <input type="checkbox" ${w.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}
               onchange="toggleHomeWidget('${esc(w.id)}', this.checked)">
        ${esc(w.title)}
      </label>
      ${editable ? `<div class="w-span-picker">${spanPicker(w)}</div>` : ''}
      <span class="panel-move">
        <button class="panel-move-btn" onclick="moveHomeWidget('${esc(w.id)}', -1)"
                ${index === 0 || !editable ? 'disabled' : ''} aria-label="Monter ${esc(w.title)}">↑</button>
        <button class="panel-move-btn" onclick="moveHomeWidget('${esc(w.id)}', 1)"
                ${index === list.length - 1 || !editable ? 'disabled' : ''} aria-label="Descendre ${esc(w.title)}">↓</button>
      </span>
      ${reglage}
    </div>`;
      })
      .join('');

  $('home-panel-reset').disabled = !editable;
}

/**
 * Le réglage propre à un bloc, sous sa ligne — aujourd'hui le seul est celui
 * des Statistiques.
 *
 * Il vit ICI, dans le panneau qui règle déjà l'accueil, et pas dans un second
 * écran de réglages : quelqu'un qui vient choisir ce que montre son accueil ne
 * doit pas avoir deux endroits à connaître.
 *
 * Un bloc DÉSACTIVÉ garde son réglage affiché, en grisé : le masquer ferait
 * disparaître le choix en même temps que le bloc, et il faudrait réactiver
 * celui-ci pour se rappeler ce qu'on y avait mis.
 */
function reglageInterne(widget, editable) {
  if (BLOCS_PAGINES[widget.id]) return reglageBlocListe(widget);
  if (widget.id !== 'stats') return '';

  const choisis = statsChartsChoisis();
  const cases = statsChartsCatalog()
    .map(
      (c) => `<label class="panel-sub-item">
        <input type="checkbox" ${choisis.includes(c.id) ? 'checked' : ''}
               ${editable && widget.enabled ? '' : 'disabled'}
               onchange="toggleStatsChart('${esc(c.id)}', this.checked)">
        ${esc(c.title)}
      </label>${formeDeGraphique(c.id, choisis.includes(c.id), editable && widget.enabled)}`
    )
    .join('');

  return `<div class="panel-sub">
    <div class="panel-sub-title">Graphiques affichés</div>
    ${cases}
    <div class="panel-sub-note">
      Sans aucun graphique, le bloc garde ses chiffres : factures du mois, total,
      espace occupé, connecteurs actifs et dernière synchronisation.
    </div>
  </div>`;
}

/**
 * Le choix de forme d'un graphique — barres, courbe, anneau.
 *
 * Il n'apparaît QUE sous un graphique coché, et seulement si ce graphique a
 * plusieurs formes possibles. Proposer la forme d'un graphique éteint
 * demanderait de se rappeler ce qu'on règle ; et proposer un « choix » à une
 * seule entrée est un menu qui ne sert à rien.
 */
function formeDeGraphique(id, affiche, actif) {
  const formes = statsTypeCatalog()[id];
  if (!affiche || !formes || formes.length < 2) return '';

  const libelles = home.data?.statsTypeLabels || {};
  const courant = statsChartType(id);
  const options = formes
    .map(
      (t) => `<option value="${esc(t)}"${t === courant ? ' selected' : ''}>
        ${esc(libelles[t] || t)}</option>`
    )
    .join('');

  return `<div class="panel-sub-form">
    <select aria-label="Forme du graphique" ${actif ? '' : 'disabled'}
            onchange="setStatsChartType('${esc(id)}', this.value)">${options}</select>
  </div>`;
}

/**
 * Le réglage d'un bloc paginé : combien de lignes, et comment les présenter.
 *
 * ─── Pourquoi ces deux-là ne sont PAS grisés quand l'accueil est figé ───────
 *
 * « Figer mon accueil » protège la DISPOSITION — quels blocs, dans quel ordre,
 * sur quelle largeur —, pour qu'un accueil réglé ne bouge plus par accident.
 * Le nombre de lignes par page et la présentation en cartes ou en liste ne
 * changent pas la disposition : ce sont des réglages de LECTURE, exactement
 * comme la bascule de l'écran Applications, qui n'a jamais été verrouillée.
 *
 * Les geler ici retirerait à quelqu'un qui fige son accueil un réglage dont il
 * disposait avant ce lot — il vivait dans le profil, où aucun verrou ne
 * s'applique. Une protection ne doit pas coûter une capacité.
 */
function reglageBlocListe(widget) {
  const config = BLOCS_PAGINES[widget.id];
  const courant = pageSizeCourante(widget.id);
  const options = pageSizes()
    .map((n) => `<option value="${n}"${n === courant ? ' selected' : ''}>${n} lignes</option>`)
    .join('');

  return `<div class="panel-sub">
    <div class="panel-sub-title">Affichage du bloc</div>
    <div class="panel-sub-form">
      <select aria-label="Lignes par page — ${esc(config.titre)}"
              onchange="saveHomePageSize('${esc(widget.id)}', this.value)">${options}</select>
      <span class="view-switch panel-sub-switch">
        ${viewToggle(`home-${widget.id}`, config.setter)}
      </span>
    </div>
    <div class="panel-sub-note">
      Chaque bloc a son propre réglage : celui-ci ne touche pas l'autre.
    </div>
  </div>`;
}

/**
 * Affiche ou retire un graphique du bloc « Statistiques ».
 *
 * Même garde que les autres gestes de l'accueil : un accueil figé ou une
 * personnalisation retirée par l'administrateur refuse aussi celui-ci — ce
 * réglage fait partie de la disposition, pas d'un réglage de confort à part.
 */
function toggleStatsChart(id, affiche) {
  if (!homeEditable()) return;

  const connus = statsChartsCatalog().map((c) => c.id);
  if (!connus.includes(id)) return;

  const courant = new Set(statsChartsChoisis());
  if (affiche) courant.add(id);
  else courant.delete(id);

  const suivant = connus.filter((x) => courant.has(x));
  prefs.values['home.stats.charts'] = suivant;
  if (home.data) home.data.statsCharts = suivant;

  renderHomeWidgets();
  renderHomePanel();
  savePref('home.stats.charts', suivant);
}

/**
 * Garde unique de toutes les modifications de l'accueil côté interface.
 * Le serveur refuse de toute façon (403) : ceci évite l'aller-retour et dit
 * pourquoi.
 */
function homeEditable() {
  if (home.access.canCustomize) return true;
  showToast(
    home.access.adminAllowed
      ? 'Accueil figé — retirez « Figer mon accueil » dans « Personnaliser l\'accueil ».'
      : 'La personnalisation de l\'accueil est désactivée par l\'administrateur.'
  );
  return false;
}

function toggleHomeWidget(id, enabled) {
  if (!homeEditable()) return;
  const widget = home.widgets.find((w) => w.id === id);
  if (!widget) return;
  widget.enabled = enabled;
  renderHomeWidgets();
  renderHomePanel();
  saveHomeWidgets();
}

/** Change la largeur d'un bloc : ligne entière, ½, ⅓ ou ¼. */
function setHomeWidgetSpan(id, span) {
  if (!homeEditable()) return;
  const widget = home.widgets.find((w) => w.id === id);
  if (!widget || widget.span === span) return;
  widget.span = span;
  renderHomeWidgets();
  renderHomePanel();
  saveHomeWidgets();
}

/**
 * Déplace un bloc d'un cran. C'est la solution tactile : le glisser-déposer
 * HTML5 ne fonctionne pas sur téléphone, ces deux flèches oui, partout.
 */
function moveHomeWidget(id, delta) {
  if (!homeEditable()) return;
  const from = home.widgets.findIndex((w) => w.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= home.widgets.length) return;
  const [moved] = home.widgets.splice(from, 1);
  home.widgets.splice(to, 0, moved);
  renderHomeWidgets();
  renderHomePanel();
  saveHomeWidgets();
}

function onWidgetDragStart(event, id) {
  home.dragId = id;
  event.currentTarget.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuse de démarrer un glisser sans donnée associée.
    event.dataTransfer.setData('text/plain', id);
  }
}

function onWidgetDragOver(event) {
  event.preventDefault();
}

function onWidgetDrop(event, targetId) {
  event.preventDefault();
  if (!homeEditable()) return;
  const from = home.widgets.findIndex((w) => w.id === home.dragId);
  const to = home.widgets.findIndex((w) => w.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = home.widgets.splice(from, 1);
  home.widgets.splice(to, 0, moved);
  renderHomeWidgets();
  renderHomePanel();
  saveHomeWidgets();
}

function onWidgetDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  home.dragId = null;
}

/** Enregistre la disposition en base — jamais dans localStorage. */
async function saveHomeWidgets() {
  try {
    const { widgets, access } = await api('/home/widgets', {
      method: 'PUT',
      body: {
        widgets: home.widgets.map((w) => ({ id: w.id, enabled: w.enabled, span: w.span })),
      },
    });
    home.widgets = uniqueWidgets(widgets);
    if (access) home.access = access;
  } catch (err) {
    showToast(`Disposition non enregistrée — ${err.message}`);
  }
}

async function resetHomeWidgets() {
  if (!homeEditable()) return;
  try {
    const { widgets, access } = await api('/home/widgets/reset', { method: 'POST' });
    home.widgets = uniqueWidgets(widgets);
    if (access) home.access = access;
    renderHomeWidgets();
    renderHomePanel();
    showToast('Disposition par défaut restaurée');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Aperçu rapide
// ---------------------------------------------------------------------------

async function openQuickview(id) {
  state.currentConnectorId = id;
  const { connector, invoices, lastRun } = await api(`/connectors/${id}`);

  applyLogo($('qv-logo'), connector);
  $('qv-name').textContent = connector.name;
  $('qv-account').textContent = connectorSubtitle(connector);
  $('qv-site').textContent = connector.site || '—';
  $('qv-site-row').onclick = connector.site
    ? () => window.open(`https://${connector.site}`, '_blank', 'noopener')
    : null;

  // « Voir dans le Store » : sur CE connecteur, pas sur l'accueil du Store.
  // Le `onclick` figé du HTML basculait de vue sans rien dire de la cible, et
  // l'utilisateur devait retrouver son connecteur à la main.
  $('qv-store-row').onclick = () => {
    closeQuickview();
    showView('store');
    openModal(id);
  };

  // Le bandeau d'erreur s'affiche pour TOUT état qui demande un geste, pas
  // seulement pour un échec d'exécution : une connexion expirée ou un
  // connecteur jamais configuré n'ont aucune exécution en échec, et restaient
  // donc muets ici.
  const etat = connector.health || {};
  const aBesoin = !etat.connected || etat.code === 'error';
  $('qv-error-block').style.display = aBesoin ? 'block' : 'none';
  if (aBesoin) {
    $('qv-error-time').textContent = etat.title || 'À vérifier';
    // ⚠ Jamais le message brut du fournisseur (lot 14, §2.2). Il est stocké
    // par connecteur, mais son TEXTE pouvait nommer un autre service — « crabe
    // ne réessaiera pas tout seul sur Propolia » s'est affiché sur la fiche
    // d'Aagaard. `health.detail` est écrit par le serveur à partir du
    // connecteur affiché : il ne peut pas se tromper de nom.
    $('qv-error-text').textContent =
      etat.detail || 'Une erreur est survenue lors de la dernière récupération.';
    $('qv-error-actions').innerHTML = quickviewActions(connector, etat);
  }

  $('qv-docs').innerHTML = invoices.length
    ? invoices
        .map(
          (doc) => `
      <div class="qv-doc">
        <div class="qv-doc-icon">PDF</div>
        <div class="qv-doc-main">
          <div class="qv-doc-name">${esc(doc.filename)}</div>
          <div class="qv-doc-date">Importé le ${esc(fmt.date(doc.fetched_at))} · ${esc(fmt.bytes(doc.size_bytes))}</div>
        </div>
        <a class="doc-dl" href="/api/connectors/me/invoices/${doc.id}/file" download
           title="Télécharger ${esc(doc.filename)}">${ICON_DOWNLOAD}</a>
      </div>`
        )
        .join('')
    : '<div class="empty-state">Aucun document récupéré pour l\'instant.</div>';

  $('qv-overlay').classList.add('show');
}

/**
 * Les gestes proposés sur l'écran d'erreur d'un connecteur.
 *
 * « Synchroniser » n'apparaît que là où une synchronisation aboutirait ;
 * « Reconfigurer » est toujours accessible, comme sur la fiche et sur
 * l'accueil (voir server/connectors/health.js).
 */
function quickviewActions(connector, etat) {
  const boutons = [];
  if (etat.canSync) boutons.push('<button class="qv-sync-link" onclick="retrySync()">Synchroniser</button>');
  if (etat.canReconfigure) {
    boutons.push(
      `<button class="qv-fix-link" onclick="closeQuickview(); reconfigureConnector('${esc(connector.id)}')">
         ${esc(etat.canSync ? 'Reconfigurer' : etat.action?.label || 'Configurer')}
       </button>`
    );
  }
  return boutons.join('');
}

function closeQuickview() {
  $('qv-overlay').classList.remove('show');
}

async function retrySync() {
  const id = state.currentConnectorId;
  const errorText = $('qv-error-text');
  errorText.textContent = 'Nouvelle tentative en cours…';
  try {
    const result = await api(`/connectors/${id}/run`, { method: 'POST' });
    await loadConnectors();
    closeQuickview();
    renderHome();
    showToast(result.ok ? `Synchronisation réussie — ${result.message}` : result.message);
  } catch (err) {
    errorText.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * ─── Le Store ne signale plus les logos manquants (lot 13) ───────────────────
 *
 * Le lot 12 posait un badge « logo manquant » et un cadre rouge sur les tuiles
 * du Store, pour les administrateurs seulement. C'était encore de trop : le
 * Store est l'écran où l'on vient CHERCHER un service, pas celui où l'on
 * administre l'application. Un cadre rouge y annonce une panne là où il n'y en
 * a aucune — une pastille à initiales est un état parfaitement normal —, et il
 * la montre à l'administrateur au moment précis où il fait autre chose.
 *
 * Le signalement vit désormais à un seul endroit, celui où il sert :
 * **Paramètres → Applications → Logos**, avec le bouton « Récupérer » à côté.
 * Voir `logoRaisonManque()` dans admin.js.
 */

/**
 * Le Store, en deux temps : `renderStore()` recharge le catalogue,
 * `renderStoreGrid()` réaffiche à partir de ce qui est déjà en mémoire.
 *
 * La distinction compte : taper dans la recherche redessine la grille à chaque
 * frappe, et refaire un aller-retour au serveur à chaque lettre pour
 * quatre-vingts tuiles serait absurde.
 */
async function renderStore() {
  await loadConnectors();
  // Le filtre mémorisé sur le compte est reposé sur la case AVANT le premier
  // rendu : le retrouver décoché alors qu'il est enregistré serait pire que
  // de ne pas le mémoriser du tout.
  state.storeAvailableOnly = !!prefs.values['store.availableOnly'];
  const champ = $('store-available-only');
  if (champ) champ.checked = state.storeAvailableOnly;
  renderStoreGrid();
}

/**
 * Les pastilles de catégories.
 *
 * L'ordre et les libellés viennent du SERVEUR (`/api/connectors`), plus d'une
 * liste écrite en dur ici : elle serait à tenir à jour à chaque catégorie
 * ajoutée, et le lot 11 en a ajouté neuf d'un coup.
 *
 * **Une catégorie vide ne s'affiche pas.** Elle est calculée sur ce que la
 * recherche et le filtre laissent passer : chercher « spotify » ne doit pas
 * laisser treize pastilles qui ne mènent nulle part.
 */
function storeCategories(visibles) {
  const presentes = new Set(visibles.map((c) => c.category));
  return [
    { id: 'all', label: 'Toutes' },
    ...(state.categories || []).filter((cat) => presentes.has(cat.id)),
  ];
}

/** Ce que la recherche et le filtre « disponibles » laissent passer. */
function storeVisibles() {
  const recherche = ($('store-search')?.value || '').trim().toLowerCase();

  return state.connectors.filter((c) => {
    if (state.storeAvailableOnly && c.planned) return false;
    if (!recherche) return true;
    // Le nom d'abord, mais aussi la description et le site : quelqu'un qui
    // cherche « électricité » ou « sncf-connect.com » doit trouver.
    return [c.name, c.description, c.site, c.categoryLabel]
      .some((champ) => String(champ || '').toLowerCase().includes(recherche));
  });
}

function renderStoreGrid() {
  const visibles = storeVisibles();
  const categories = storeCategories(visibles);

  // Une catégorie qui vient de disparaître ne doit pas rester sélectionnée :
  // la grille serait vide sans qu'on comprenne pourquoi.
  if (!categories.some((cat) => cat.id === state.currentCat)) state.currentCat = 'all';

  $('store-count').textContent = storeCountLabel();
  $('store-pills').innerHTML = categories
    .map(
      (cat) =>
        `<button class="pill ${state.currentCat === cat.id ? 'active' : ''}" `
        + `onclick="filterCat('${esc(cat.id)}')">${esc(cat.label)}</button>`
    )
    .join('');

  const retenus = visibles.filter(
    (c) => state.currentCat === 'all' || c.category === state.currentCat
  );

  let html = '';
  for (const cat of categories) {
    if (cat.id === 'all') continue;
    const items = retenus.filter((c) => c.category === cat.id);
    if (!items.length) continue;
    html += `<div class="cat-block"><div class="cat-title">${esc(cat.label)}</div>`
      + `<div class="grid">${items.map(storeCard).join('')}</div></div>`;
  }

  $('store-grid').innerHTML = html || storeEmptyState();
}

/**
 * « 13 services disponibles, 71 à venir ».
 *
 * Le compte vient du serveur, sur le périmètre de CE compte : un service
 * réservé à quelqu'un d'autre ne doit pas gonfler un nombre affiché à tous.
 */
function storeCountLabel() {
  const counts = state.storeCounts || { available: 0, planned: 0, pending: 0 };
  const disponibles = `${counts.available} service${counts.available > 1 ? 's' : ''} disponible${counts.available > 1 ? 's' : ''}`;
  // Les services « pas encore testés » ne sont visibles que d'un
  // administrateur, et ils sont dits à part : les additionner aux disponibles
  // ferait annoncer un catalogue plus large qu'il ne l'est vraiment.
  const attente = counts.pending
    ? `, ${counts.pending} pas encore testé${counts.pending > 1 ? 's' : ''}`
    : '';
  if (!counts.planned) {
    return attente
      ? `${disponibles}${attente}`
      : `${disponibles} — installez et configurez les sources de vos factures`;
  }
  return `${disponibles}${attente}, ${counts.planned} à venir`;
}

/** Rien à afficher : dire pourquoi, et proposer le geste qui débloque. */
function storeEmptyState() {
  const recherche = ($('store-search')?.value || '').trim();
  if (recherche && state.storeAvailableOnly) {
    return '<div class="empty-state">Aucun service disponible ne correspond à votre recherche. '
      + 'Décochez « Seulement les services disponibles » pour voir aussi ce qui est à venir.</div>';
  }
  if (recherche) {
    return `<div class="empty-state">Aucun service ne correspond à « ${esc(recherche)} ».</div>`;
  }
  if (state.storeAvailableOnly) {
    return '<div class="empty-state">Aucun service disponible dans cette catégorie — '
      + 'décochez « Seulement les services disponibles » pour voir ce qui est à venir.</div>';
  }
  return '<div class="empty-state">Aucun service dans cette catégorie.</div>';
}

/**
 * Une tuile du Store.
 *
 * Deux formes, et une seule différence : le bouton « Installer » d'un service
 * disponible devient un **badge grisé** pour un service annoncé. Un badge, et
 * pas un bouton désactivé : un bouton invite à cliquer, et un clic qui ne
 * produit rien de perceptible laisse croire à une panne. Rien ne se passe donc
 * au clic — ni fenêtre, ni message —, y compris sur la carte entière.
 *
 * La description n'apparaît QUE sur les tuiles annoncées : elles n'ont ni état
 * ni action à afficher, la place est libre, et c'est là que se lit la réserve
 * des quatre banques — « sa disponibilité n'est pas garantie » n'a aucun
 * intérêt caché dans une infobulle.
 */
function storeCard(c) {
  // Une entrée sans logo affiche simplement sa pastille à initiales : ni
  // mention, ni bordure. Voir le bloc « Le Store ne signale plus les logos
  // manquants » ci-dessus.
  const pastille = `<div class="badge-logo" style="background:${esc(c.color)};">`
    + `${esc(c.letters)}${logoHtml(c)}</div>`;

  if (c.planned) {
    // L'empêchement mesuré (lot 36) : « Bientôt disponible » est une promesse,
    // et pour un service dont la reconnaissance a prouvé qu'aucune ligne de
    // code ne la tiendra (mur anti-robot, connexion réservée aux humains,
    // document absent du web), la tenir affichée serait un mensonge. La tuile
    // dit alors « Pas possible aujourd'hui », et la raison prend la place de
    // la description — c'est elle que l'utilisateur doit lire.
    const empeche = (c.unfeasible || '').trim();
    return `
      <div class="card planned">
        ${pastille}
        <div class="card-name">${esc(c.name)}</div>
        <div class="card-desc">${esc(empeche || c.caveat || c.description || '')}</div>
        <span class="planned-badge${empeche ? ' unfeasible' : ''}">${
          empeche ? 'Pas possible aujourd\'hui' : 'Bientôt disponible'}</span>
      </div>`;
  }

  // ⚠ « En attente de test » n'est PAS une disponibilité déguisée : ce service
  // est écrit mais n'a encore été essayé sur aucun compte réel. Seul un
  // administrateur voit cette tuile (voir registry.voitLesEnAttente) — et il
  // doit le savoir avant de cliquer, pas après une première récupération ratée.
  const enAttente = c.catalogStatus === 'pending';

  return `
    <div class="card" onclick="openModal('${esc(c.id)}')">
      ${pastille}
      <div class="card-name">${esc(c.name)}</div>
      <div class="card-status">
        <span class="status-dot ${c.maintenance ? 'red' : enAttente ? 'amber' : statusDot(c.status)}"></span>
        ${c.maintenance ? 'En maintenance' : enAttente ? 'Pas encore testé' : esc(statusLabel(c.status))}
      </div>
      <button class="install-btn ${c.installed ? 'installed' : ''}"
              onclick="event.stopPropagation(); ${c.installed ? `uninstallFromCard('${esc(c.id)}')` : `installFromCard('${esc(c.id)}')`}">
        ${c.installed
          ? `<span class="install-etat">Installé</span>
             <span class="install-action">Désinstaller</span>`
          : 'Installer'}
      </button>
    </div>`;
}

function filterCat(category) {
  state.currentCat = category;
  renderStoreGrid();
}

/**
 * « Seulement les services disponibles » — pour qui vient installer plutôt que
 * parcourir.
 *
 * Mémorisé sur le COMPTE, comme les tris et le filtre du catalogue
 * d'administration : le retrouver décoché d'un poste à l'autre serait une
 * petite trahison à chaque visite. Un échec d'enregistrement ne bloque rien —
 * le filtre s'applique tout de suite, on prévient seulement qu'il ne sera pas
 * retenu.
 */
function setStoreAvailableOnly(seulement) {
  state.storeAvailableOnly = !!seulement;
  prefs.values['store.availableOnly'] = state.storeAvailableOnly;
  const champ = $('store-available-only');
  if (champ) champ.checked = state.storeAvailableOnly;
  renderStoreGrid();
  savePref('store.availableOnly', state.storeAvailableOnly);
}

async function installFromCard(id) {
  const connector = state.connectors.find((c) => c.id === id);
  await api(`/connectors/${id}/install`, { method: 'POST' });
  await renderStore();
  showToast(`${connector.name} installé — configuration requise`);
  openModal(id);
}

async function uninstallFromCard(id) {
  const connector = state.connectors.find((c) => c.id === id);
  if (!confirm(`Désinstaller ${connector.name} ? Ses identifiants enregistrés seront effacés.`)) return;
  await api(`/connectors/${id}`, { method: 'DELETE' });
  await renderStore();
  showToast(`${connector.name} désinstallé`);
}

// ---------------------------------------------------------------------------
// Mes documents
//
// Rétabli au lot 7. Le lot 3 avait retiré la vue « Stockage local » en même temps que
// « Mes Papiers », au motif qu'elle devenait inatteignable — et l'utilisateur
// s'est retrouvé quatre lots durant sans aucun moyen de VOIR ses documents
// depuis crabe.
//
// Écran de CONSULTATION : on regarde, on cherche, on télécharge. Aucune
// suppression, aucun renommage. crabe produit ces fichiers, il ne les gère pas.
// ---------------------------------------------------------------------------

const docs = {
  /** Dernière réponse de GET /api/documents. */
  data: null,
  /** Filtres en cours, envoyés au serveur. */
  query: { destination: '', q: '', connector: '', period: '' },
  // Les comptes REPLIÉS ne vivent plus ici : ils sont mémorisés sur le compte
  // (préférence « documents.collapsed »), donc conservés d'une visite et d'un
  // poste à l'autre. Voir docsCollapsed().
};

async function renderDocuments() {
  const zone = $('docs-content');
  zone.innerHTML = '<div class="empty-state">Lecture de vos documents…</div>';

  try {
    docs.data = await api(`/documents${docsQueryString()}`);
  } catch (err) {
    zone.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    return;
  }

  docs.query.destination = docs.data.destination?.id || '';
  zone.innerHTML = `${docsHeader()}${docsBody()}`;
}

function docsQueryString() {
  const params = Object.entries(docs.query)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return params.length ? `?${params.join('&')}` : '';
}

/**
 * Tête d'écran : où l'on regarde, et ce qu'on y cherche.
 *
 * Le sélecteur d'espace n'apparaît QUE s'il y a un choix à faire. Une
 * installation qui n'a que le stockage local — le cas courant — n'a pas à porter une
 * liste déroulante à une seule entrée.
 */
function docsHeader() {
  const d = docs.data;

  const espaces = d.destinations.length > 1
    ? `<div class="docs-dests">
         ${d.destinations
           .map(
             (dest) => `<button class="pill ${dest.id === d.destination?.id ? 'active' : ''}"
               onclick="setDocsDestination('${esc(dest.id)}')" title="${esc(dest.name)}">
               <span class="dest-mark" style="background:${esc(dest.color)};">${esc(dest.letter)}${logoHtml(dest)}</span>
               ${esc(dest.name)}${dest.available ? '' : ' — indisponible'}
             </button>`
           )
           .join('')}
       </div>`
    : '';

  const connecteurs = (d.filters.connectors || [])
    .map(
      (c) => `<option value="${esc(c.id)}"${docs.query.connector === c.id ? ' selected' : ''}>
        ${esc(c.name)}</option>`
    )
    .join('');

  const periodes = (d.filters.periods || [])
    .map(
      (p) => `<option value="${esc(p)}"${docs.query.period === p ? ' selected' : ''}>
        ${esc(p)}</option>`
    )
    .join('');

  const tri = docsSort();
  const option = (valeur, label) =>
    `<option value="${valeur}"${tri.key === valeur ? ' selected' : ''}>${label}</option>`;

  return `${espaces}
    <div class="docs-filters">
      <input type="search" id="docs-search" class="docs-search" placeholder="Rechercher un document…"
             value="${esc(docs.query.q)}" oninput="onDocsSearch(this.value)">
      <select id="docs-connector" onchange="setDocsFilter('connector', this.value)">
        <option value="">Tous les services</option>${connecteurs}
      </select>
      <select id="docs-period" onchange="setDocsFilter('period', this.value)">
        <option value="">Toutes les périodes</option>${periodes}
      </select>
      <select id="docs-sort" onchange="sortDocuments(this.value)" aria-label="Trier les documents">
        ${option('fetchedAt', 'Le plus récent d\'abord')}
        ${option('period', 'Par période')}
        ${option('filename', 'Par nom de fichier')}
        ${option('sizeBytes', 'Par taille')}
      </select>
      ${docsFoldAll()}
      <div class="view-switch">${viewToggle('documents', 'setDocsView')}</div>
    </div>`;
}

/**
 * Cartes ou liste — comme les Applications, et mémorisé comme elles.
 *
 * L'écran se redessine sans rappeler le serveur : les documents sont déjà là,
 * seule leur mise en forme change. Faire un aller-retour pour ça donnerait
 * l'impression que la bascule recharge quelque chose.
 */
function setDocsView(mode) {
  setViewMode('documents', mode);
  $('docs-content').innerHTML = `${docsHeader()}${docsBody()}`;
}

/**
 * « Tout replier » / « Tout déplier ».
 *
 * Un seul bouton, qui dit ce qu'il va faire : replier tant qu'il reste un
 * compte ouvert, tout rouvrir ensuite. Deux boutons côte à côte demanderaient
 * de lire les deux pour choisir.
 */
function docsFoldAll() {
  const toutes = (docs.data?.tree || []).flatMap((branche) =>
    branche.accounts.map((compte) => `${branche.connectorId}/${compte.accountId}`)
  );
  if (toutes.length < 2) return '';

  const replies = docsCollapsed();
  const resteOuvert = toutes.some((cle) => !replies.includes(cle));

  return `<button class="btn-mini docs-fold" id="docs-fold"
                  onclick="setAllDocsAccounts(${resteOuvert})">
    ${resteOuvert ? 'Tout replier' : 'Tout déplier'}
  </button>`;
}

/**
 * Le plus récent d'abord : c'est ce qu'on vient chercher dans « Mes documents ».
 */
const DOCS_TRI_DEFAUT = { key: 'fetchedAt', dir: 'desc' };

/**
 * Le tri porte sur la DONNÉE, jamais sur son affichage : une taille écrite
 * « 99,3 Ko » se compare en octets — sinon « 9 Mo » passerait avant —, et une
 * date écrite « il y a 3 h » se compare en millisecondes.
 */
const DOCS_ACCES = {
  filename: (d) => d.filename,
  period: (d) => d.period || '',
  sizeBytes: (d) => d.sizeBytes || 0,
  fetchedAt: (d) => fmt.parse(d.fetchedAt)?.getTime() || null,
};

function docsSort() {
  return sortOf('documents', DOCS_TRI_DEFAUT);
}

function sortDocuments(key) {
  // Une date ou une taille se lit du plus grand au plus petit ; un nom, dans
  // l'ordre alphabétique.
  const naturel = ['fetchedAt', 'sizeBytes', 'period'].includes(key) ? 'desc' : 'asc';
  setSort('documents', uiPrefs.basculer(docsSort(), key, naturel));
  renderDocuments();
}

/** Le corps : l'arborescence, ou ce qui l'empêche. */
function docsBody() {
  const d = docs.data;

  if (!d.available) {
    const autres = d.destinations.filter((x) => x.available && x.id !== d.destination?.id);
    return `<div class="docs-unavailable">
      <div class="docs-unavailable-text">${esc(d.reason || 'Cet espace de stockage n\'est pas accessible pour le moment.')}</div>
      ${autres.length
        ? `<div class="docs-unavailable-alt">Vos documents restent consultables ici :
             ${autres
               .map(
                 (x) => `<button class="btn-mini" onclick="setDocsDestination('${esc(x.id)}')">
                   ${esc(x.name)}</button>`
               )
               .join(' ')}
           </div>`
        : '<div class="docs-unavailable-alt">Aucun autre espace n\'est disponible pour l\'instant.</div>'}
    </div>`;
  }

  if (!d.total) {
    return `<div class="empty-state">
      Aucun document pour l'instant. Connectez un service depuis le Store : crabe ira
      chercher vos factures et les rangera ici.
    </div>`;
  }

  if (!d.shown) {
    return `<div class="empty-state">
      Aucun document ne correspond à votre recherche.
      <button class="btn-mini" onclick="resetDocsFilters()">Tout afficher</button>
    </div>`;
  }

  // ─── Cartes : UNE CARTE PAR SERVICE ────────────────────────────────────
  //
  // Le lot 18 avait posé la bascule au mauvais niveau de l'arborescence : la
  // vue « Cartes » rendait bien des cartes, mais des cartes de DOCUMENTS, à
  // l'intérieur de la même liste hiérarchique service → compte → documents. On
  // obtenait donc la liste ET les cartes, c'est-à-dire ni l'une ni l'autre.
  //
  // Cet écran montre d'abord des SERVICES. En cartes, on montre donc les
  // services : une carte par connecteur, avec son logo, son nom, son nombre de
  // documents et ses comptes. Le détail s'ouvre en entrant dans le service —
  // ce qui revient à poser le filtre qui existe déjà, celui du menu déroulant
  // au-dessus.
  const cartes = viewMode('documents') === 'cards';
  if (cartes && !docs.query.connector && d.tree.length) {
    return `<div class="docs-conn-cards">${d.tree.map(docsConnectorCard).join('')}</div>`;
  }

  return `${cartes && docs.query.connector ? docsRetourServices() : ''}
    <div class="docs-tree">${d.tree.map((branche) => docsBranch(branche)).join('')}</div>`;
}

/**
 * Une carte de service : ce qu'il y a dedans, avant d'y entrer.
 *
 * Les comptes sont listés avec leur nombre de documents — c'est la seule chose
 * qu'on ait besoin de savoir pour choisir où aller. Au-delà de quatre, on
 * annonce le reste plutôt que d'allonger la carte : une carte qui déborde
 * n'est plus une carte, c'est une liste.
 */
const DOCS_COMPTES_PAR_CARTE = 4;

function docsConnectorCard(branche) {
  const comptes = branche.accounts.slice(0, DOCS_COMPTES_PAR_CARTE);
  const reste = branche.accounts.length - comptes.length;

  const lignes = comptes
    .map(
      (compte) => `<div class="docs-conn-account">
        <span class="docs-conn-account-name" title="${esc(compte.label)}">${esc(compte.label)}</span>
        <span class="docs-conn-account-count">${compte.documents.length}</span>
      </div>`
    )
    .join('');

  return `<button class="docs-conn-card" onclick="enterDocsConnector('${esc(branche.connectorId)}')"
          title="Voir les documents de ${esc(branche.connectorName)}">
    <div class="docs-conn-card-head">
      <div class="conn-icon" style="background:${esc(branche.color)};">${esc(branche.letters)}${logoHtml(branche)}</div>
      <div class="docs-conn-card-titles">
        <div class="docs-conn-card-name">${esc(branche.connectorName)}</div>
        <div class="docs-conn-card-count">${branche.count} document${branche.count > 1 ? 's' : ''}</div>
      </div>
    </div>
    <div class="docs-conn-accounts">
      ${lignes}
      ${reste > 0 ? `<div class="docs-conn-more">et ${reste} autre(s) compte(s)</div>` : ''}
    </div>
  </button>`;
}

/** Le retour, quand on est entré dans un service depuis une carte. */
function docsRetourServices() {
  return `<button class="btn-mini docs-back" onclick="setDocsFilter('connector', '')">
    ‹ Tous les services
  </button>`;
}

/**
 * Entre dans un service : c'est le filtre du menu déroulant, posé par un clic
 * sur la carte. Un seul mécanisme pour les deux gestes — un second chemin
 * d'affichage aurait pu diverger du premier.
 */
function enterDocsConnector(id) {
  // La promesse est RENDUE, pas avalée : l'écran se recharge, et un appelant
  // qui enchaîne — un test, un futur bouton — doit pouvoir attendre la fin.
  return setDocsFilter('connector', id);
}

/** Un connecteur, et ses comptes. */
function docsBranch(branche) {
  return `<div class="docs-branch">
    <div class="docs-branch-head">
      <div class="conn-icon small" style="background:${esc(branche.color)};">${esc(branche.letters)}${logoHtml(branche)}</div>
      <div class="docs-branch-name">${esc(branche.connectorName)}</div>
      <div class="docs-branch-count">${branche.count} document${branche.count > 1 ? 's' : ''}</div>
    </div>
    ${branche.accounts.map((compte) => docsAccount(branche, compte)).join('')}
  </div>`;
}

/**
 * Un compte, et ses documents.
 *
 * ─── Ce que le lot 12 corrige ────────────────────────────────────────────────
 *
 * Le repli existait, mais un compte SEUL dans son connecteur était déplié
 * d'office et ne pouvait pas se refermer. Or c'est le cas de figure ordinaire :
 * un abonnement Free, un compte Amazon, un numéro fiscal. Avec 186 documents et
 * quatre connecteurs, l'écran devenait une liste ininterrompue qu'il fallait
 * parcourir en entier pour atteindre le connecteur suivant.
 *
 * **Tout compte se replie donc**, seul ou non. Le premier affichage reste
 * déplié — on ne cache pas ce que l'utilisateur vient chercher — et c'est le
 * repli, une fois demandé, qui est mémorisé sur le compte (préférence
 * « documents.collapsed », donc d'un poste à l'autre).
 */
function docsAccount(branche, compte) {
  const cle = `${branche.connectorId}/${compte.accountId}`;
  const ouvert = !docsCollapsed().includes(cle);

  return `<div class="docs-account">
    <button class="docs-account-head" onclick="toggleDocsAccount('${esc(cle)}')"
            aria-expanded="${ouvert ? 'true' : 'false'}"
            title="${ouvert ? 'Replier' : 'Déplier'} ${esc(compte.label)}">
      <span class="docs-chevron">${ouvert ? '▾' : '▸'}</span>
      <span class="docs-account-name">${esc(compte.label)}</span>
      <span class="docs-account-count">${compte.documents.length}</span>
    </button>
    ${docsFiles(branche, compte, ouvert)}
  </div>`;
}

/**
 * Les documents d'un compte, en cartes ou en lignes.
 *
 * Le TRI est fait une seule fois, ici, et les deux affichages le reçoivent
 * déjà appliqué : sans cela, basculer de vue rebattrait l'ordre, et l'écran
 * mentirait sur ce que le sélecteur de tri annonce.
 *
 * Le repli, lui, ne dépend pas de la vue : un compte fermé le reste en cartes.
 */
function docsFiles(branche, compte, ouvert) {
  const tries = uiPrefs.trier(compte.documents, docsSort(), DOCS_ACCES, (doc) => doc.filename);
  const cartes = viewMode('documents') === 'cards';

  return `<div class="${cartes ? 'docs-cards' : 'docs-files'}"${ouvert ? '' : ' style="display:none;"'}>
    ${tries.map((doc) => (cartes ? docsCard(doc, branche) : docsFile(doc))).join('')}
  </div>`;
}

/** Les comptes repliés, tels que le compte les a mémorisés. */
function docsCollapsed() {
  const valeur = prefs.values['documents.collapsed'];
  return Array.isArray(valeur) ? valeur : [];
}

/** Une ligne de document : ce qu'il est, et de quoi le récupérer. */
function docsFile(doc) {
  const details = [
    doc.period ? esc(doc.period) : '',
    esc(fmt.bytes(doc.sizeBytes)),
    `récupéré ${esc(fmt.relative(doc.fetchedAt))}`,
  ].filter(Boolean);

  return `<div class="docs-file${doc.missing ? ' missing' : ''}">
    <div class="docs-file-main">
      <div class="docs-file-name">${esc(doc.filename)}</div>
      <div class="docs-file-meta">${details.join(' · ')}</div>
      ${doc.missing
        ? '<div class="docs-file-warn">Ce fichier n\'est plus présent sur cet espace de stockage.</div>'
        : ''}
    </div>
    ${docsTelecharger(doc)}
  </div>`;
}

/**
 * Le bouton de téléchargement — ou rien.
 *
 * Un fichier qui a disparu de l'espace de stockage depuis son dépôt n'a PAS de
 * bouton : le proposer quand même mènerait à une erreur 404 sans explication.
 * L'écran le signale à la place, en cartes comme en lignes. C'est la règle de
 * l'écran depuis le lot 7, et les deux affichages doivent la tenir.
 */
function docsTelecharger(doc) {
  if (doc.missing) return '';
  return `<a class="docs-dl" title="Télécharger ${esc(doc.filename)}"
       href="/api/documents/${esc(docs.query.destination)}/${esc(doc.id)}/file">
       ${ICON_DOWNLOAD}<span>Télécharger</span>
     </a>`;
}

/**
 * Une carte de document.
 *
 * Elle porte exactement ce que porte la ligne — logo du service, nom de
 * fichier, période, taille, date de récupération, téléchargement —, mais
 * disposée pour être balayée du regard plutôt que lue ligne à ligne.
 *
 * Le logo vient de la BRANCHE : une carte est lue isolément, au milieu d'une
 * grille, et sans lui il faudrait remonter à l'en-tête du connecteur pour
 * savoir de quel service vient la facture qu'on regarde.
 */
function docsCard(doc, branche) {
  return `<div class="doc-card${doc.missing ? ' missing' : ''}">
    <div class="doc-card-head">
      <div class="conn-icon small" style="background:${esc(branche.color)};">${esc(branche.letters)}${logoHtml(branche)}</div>
      <div class="doc-card-titles">
        <div class="doc-card-name" title="${esc(doc.filename)}">${esc(doc.filename)}</div>
        <div class="doc-card-sub">${esc(branche.connectorName)}</div>
      </div>
    </div>
    <div class="doc-card-facts">
      <div><span class="fact-label">Période</span>
        <span class="fact-value">${esc(doc.period || '—')}</span></div>
      <div><span class="fact-label">Taille</span>
        <span class="fact-value">${esc(fmt.bytes(doc.sizeBytes))}</span></div>
      <div><span class="fact-label">Récupéré</span>
        <span class="fact-value" title="${esc(fmt.exact(doc.fetchedAt))}">${esc(fmt.relative(doc.fetchedAt))}</span></div>
    </div>
    ${doc.missing
      ? '<div class="docs-file-warn">Ce fichier n\'est plus présent sur cet espace de stockage.</div>'
      : ''}
    <div class="doc-card-actions">${docsTelecharger(doc)}</div>
  </div>`;
}

/**
 * Replie ou déplie un compte, et s'en souvient.
 *
 * L'écran se redessine tout de suite ; la mémorisation part ensuite, sans
 * qu'on l'attende — un réseau lent ne doit pas retarder un chevron.
 */
function toggleDocsAccount(cle) {
  const replies = docsCollapsed();
  const suivant = replies.includes(cle)
    ? replies.filter((k) => k !== cle)
    : [...replies, cle];

  prefs.values['documents.collapsed'] = suivant;
  savePref('documents.collapsed', suivant);
  $('docs-content').innerHTML = `${docsHeader()}${docsBody()}`;
}

/** « Tout déplier » / « Tout replier » : un geste pour l'écran entier. */
function setAllDocsAccounts(replier) {
  const toutes = (docs.data?.tree || []).flatMap((branche) =>
    branche.accounts.map((compte) => `${branche.connectorId}/${compte.accountId}`)
  );
  const suivant = replier ? toutes : [];

  prefs.values['documents.collapsed'] = suivant;
  savePref('documents.collapsed', suivant);
  $('docs-content').innerHTML = `${docsHeader()}${docsBody()}`;
}

async function setDocsDestination(id) {
  docs.query.destination = id;
  await renderDocuments();
}

async function setDocsFilter(key, value) {
  docs.query[key] = value;
  await renderDocuments();
}

/** Recherche : on attend que la frappe se calme avant d'interroger le serveur. */
function onDocsSearch(value) {
  docs.query.q = value;
  clearTimeout(onDocsSearch.timer);
  onDocsSearch.timer = setTimeout(() => renderDocuments(), 250);
}

async function resetDocsFilters() {
  docs.query = { destination: docs.query.destination, q: '', connector: '', period: '' };
  await renderDocuments();
}

// ---------------------------------------------------------------------------
// Fiche d'un connecteur
//
// ─── Ce que le lot 7 a retiré, et pourquoi ───────────────────────────────────
//
// La fiche affichait d'emblée : un cadre « Session capturée » avec deux
// boutons, un paragraphe expliquant comment produire un fichier JSON en ligne
// de commande, un cadre « Lignes à récupérer » vide, « Tester la connexion »,
// « Enregistrer » et « Désinstaller ». Six décisions sur un écran, pour un
// public qui n'en attend qu'une.
//
// La règle appliquée ici : **un écran, une décision.** Avant connexion, une
// phrase et un bouton. Après connexion, ce qui a été fait et deux gestes. Le
// reste — échéance de la connexion, « Se reconnecter », choix des éléments
// suivis, désinstallation — vit sous « Options avancées », replié.
//
// Le lot 9 a vidé ce repli de ce qui n'aurait jamais dû s'y trouver : le dépôt
// d'un fichier de session et la ligne de commande qui l'accompagnait sont
// passés dans l'administration, où ils sont un outil de dépannage et non une
// option offerte à quelqu'un qui n'a jamais ouvert un terminal.
// ---------------------------------------------------------------------------

/**
 * Ouvre la fiche d'un connecteur.
 *
 * @param {string} id
 * @param {{edit?: boolean}} [options] `edit` force le mode saisie sur un
 *   connecteur déjà connecté — c'est ce que font « Modifier » et
 *   « Reconfigurer ».
 */
function openModal(id, { edit = false } = {}) {
  const connector = state.connectors.find((c) => c.id === id);
  if (!connector) return;
  state.currentConnectorId = id;
  state.discovery = null;
  state.modalEdit = edit;

  applyLogo($('modal-logo'), connector);
  $('modal-name').textContent = connector.name;
  $('modal-cat').textContent = connectorSubtitle(connector);

  $('modal-fields').innerHTML = connectorSheet(connector);
  $('modal-actions').innerHTML = connectorActions(connector);
  // La fiche repart des boutons, jamais d'un indicateur d'attente resté en
  // place après une recherche précédente.
  $('modal-actions').dataset.attente = '0';
  $('modal-test-result').className = 'test-result';
  $('modal-test-result').textContent = '';
  showDiscoveryStep(false);
  $('modal-overlay').classList.add('show');
}

/** Rouvre la fiche en mode saisie : « Modifier », « Reconfigurer ». */
function reconfigureConnector(id) {
  closeQuickview?.();
  openModal(id, { edit: true });
}

/** L'état du connecteur, tel qu'il s'écrit sous son nom. */
function connectorSubtitle(connector) {
  const etat = connector.health;
  if (!etat) return connector.categoryLabel;
  return etat.followedLabel ? `${etat.title} · ${etat.followedLabel}` : etat.title;
}

/**
 * Le corps de la fiche.
 *
 * Deux états, et un seul s'affiche : on se connecte, ou on est connecté.
 */
function connectorSheet(connector) {
  const etat = connector.health || {};
  const saisie = state.modalEdit || !etat.connected;

  const phrase = connector.description
    ? `<div class="sheet-lead">${esc(connector.description)}</div>`
    : '';

  return `${phrase}${sheetEnAttente(connector)}`
    + `${saisie ? sheetConnect(connector) : sheetConnected(connector)}${sheetAdvanced(connector)}`;
}

/**
 * L'avertissement d'un service EN ATTENTE DE TEST.
 *
 * Il s'affiche AVANT les champs, pas après : quelqu'un qui vient de saisir ses
 * identifiants et découvre ensuite que le service n'a jamais été essayé a
 * raison de se sentir pris au dépourvu. Et il dit ce qui est attendu de lui —
 * signaler ce qui se passe — parce que c'est précisément ce qui fera sortir ce
 * service de cet état.
 *
 * La réserve du manifeste (`caveat`) s'ajoute quand elle existe : elle porte ce
 * que ce service-là a de particulier, que la phrase générique ne peut pas dire.
 */
function sheetEnAttente(connector) {
  if (connector.catalogStatus !== 'pending') return '';
  const reserve = connector.caveat ? ` ${esc(connector.caveat)}` : '';
  return '<div class="discovery-notice">Ce service vient d\'être ajouté à crabe et '
    + "n'a encore été essayé sur aucun compte réel. Vous pouvez le configurer : "
    + "dites ce qui se passe, que ça marche ou non." + reserve + '</div>';
}

/**
 * Avant connexion : ce qu'il faut saisir, et rien d'autre.
 *
 * Un connecteur qui se connecte par navigateur n'a RIEN à saisir : le bouton
 * fait tout. Un connecteur à mot de passe montre ses champs — identifiant, mot
 * de passe — et pas un de plus : la session et la sélection découverte n'ont
 * rien à faire ici, elles n'existent pas encore.
 */
function sheetConnect(connector) {
  const champs = essentialFields(connector);
  if (!champs.length) return '';
  return `<div class="sheet-form">
    ${champs.map((field) => connectorField(connector, field)).join('')}
  </div>`;
}

/** Les champs qu'un humain remplit lui-même. */
function essentialFields(connector) {
  return (connector.fields || []).filter((f) => !CHAMPS_AVANCES.includes(f.type));
}

/**
 * Les champs qui vivent sous « Options avancées ».
 *
 * Trois familles, et une seule raison : ce ne sont pas des choses à SAISIR.
 * Une connexion enregistrée s'obtient en cliquant, le choix des éléments suivis
 * n'existe qu'après connexion, et la profondeur d'historique a un défaut qui
 * convient à tout le monde.
 */
const CHAMPS_AVANCES = ['session', 'multiselect', 'history'];

/**
 * Après connexion : ce que crabe a fait pour vous.
 *
 * Deux lignes, factuelles. Pas de date d'échéance de session, pas de compte de
 * cookies : ce qui compte est que ça tourne et depuis quand.
 */
function sheetConnected(connector) {
  const lignes = [];

  lignes.push(
    connector.lastRunAt
      ? `Dernière récupération : ${esc(fmt.relative(connector.lastRunAt))}`
      : 'Aucune récupération pour l\'instant.'
  );
  if (connector.invoiceCount) {
    lignes.push(`${connector.invoiceCount} facture${connector.invoiceCount > 1 ? 's' : ''} récupérée${connector.invoiceCount > 1 ? 's' : ''}`);
  }

  const alerte = connector.health?.code === 'error'
    ? `<div class="sheet-alert">${esc(connector.health.detail)}</div>`
    : '';

  return `${alerte}<div class="sheet-facts">
    ${lignes.map((l) => `<div>${l}</div>`).join('')}
  </div>`;
}

/**
 * Options avancées — replié par défaut, et volontairement pauvre.
 *
 * ─── Quatre choses, et rien d'autre ──────────────────────────────────────────
 *
 *   1. la date de validité de la connexion enregistrée ;
 *   2. un bouton « Se reconnecter » ;
 *   3. le choix des éléments suivis, quand le connecteur en découvre ;
 *   4. la désinstallation.
 *
 * ─── Ce qui en a été retiré au lot 9 ────────────────────────────────────────
 *
 * Le dépôt d'un fichier de session, la zone de collage, la ligne de commande
 * qui les accompagnait — partis dans l'administration — et le bouton « Tester
 * la connexion ». Ce dernier faisait double emploi : l'état de la connexion est
 * déjà écrit en haut de la fiche, calculé par le serveur, et « Récupérer
 * maintenant » est le geste qui compte vraiment.
 *
 * Les champs d'un connecteur à mot de passe ne se dupliquent plus ici non plus :
 * « Se reconnecter » repasse la fiche en saisie, ce qui est le même geste en
 * plus clair.
 *
 * Un utilisateur qui n'ouvre JAMAIS ce bloc doit pouvoir utiliser crabe de bout
 * en bout. C'était déjà vrai ; ça l'est davantage maintenant qu'il n'y a plus
 * rien d'indispensable dedans.
 */
function sheetAdvanced(connector) {
  const blocs = (connector.fields || [])
    .filter((f) => CHAMPS_AVANCES.includes(f.type))
    .map((field) => connectorField(connector, field))
    .join('');

  const desinstaller = connector.installed
    ? `<button type="button" class="btn-danger adv-danger" onclick="uninstallConnector()"
         id="modal-uninstall">Désinstaller ${esc(connector.name)}</button>`
    : '';

  return `<div class="adv">
    <button type="button" class="adv-toggle" id="adv-toggle" onclick="toggleAdvanced()"
            aria-expanded="false" aria-controls="adv-body">
      Options avancées <span class="adv-chevron">▾</span>
    </button>
    <div class="adv-body" id="adv-body" style="display:none;">
      ${blocs}${desinstaller}
    </div>
  </div>`;
}

/** Déplie ou replie les options avancées. */
function toggleAdvanced() {
  const zone = $('adv-body');
  if (!zone) return;
  const ouvert = zone.style.display !== 'none';
  zone.style.display = ouvert ? 'none' : 'block';
  $('adv-toggle')?.setAttribute?.('aria-expanded', ouvert ? 'false' : 'true');
}

/**
 * Les boutons du bas de fiche.
 *
 * Un seul avant connexion. Deux après — récupérer, ou modifier. Jamais
 * « Synchroniser » sur un connecteur qui n'est pas en état de synchroniser :
 * c'est tout l'objet de `health` côté serveur.
 */
function connectorActions(connector) {
  const etat = connector.health || {};
  const saisie = state.modalEdit || !etat.connected;

  // Le bouton « Enregistrer » vit sous les options d'historique, pas ici : c'est
  // là que se trouve le réglage qu'on vient de changer, et il concerne tous les
  // connecteurs, pas seulement ceux à navigateur distant.
  if (saisie) return `<button class="btn-remote" ${connectPrimaryAttributes(connector)}>
      ${esc(connectPrimaryLabel(connector))}
    </button>${connectPrimaryNote(connector)}`;

  const secondaire = etat.code === 'ready' ? 'Modifier' : 'Reconfigurer';
  return `
    ${etat.canSync
      ? `<button class="btn-secondary" onclick="runConnectorNow('${esc(connector.id)}', this)">
           ${esc(etat.action.id === 'sync' ? etat.action.label : 'Récupérer maintenant')}
         </button>
         <button class="btn-ghost" onclick="runConnectorHistorique('${esc(connector.id)}', this)">
           Récupérer tout l'historique
         </button>`
      : ''}
    <button class="btn-ghost" onclick="reconfigureConnector('${esc(connector.id)}')">
      ${secondaire}
    </button>`;
}

/** « Se connecter à Free Mobile » — le geste, nommé par son fournisseur. */
function connectPrimaryLabel(connector) {
  return `Se connecter à ${connector.name}`;
}

/**
 * Ce que fait le bouton principal, et s'il est cliquable.
 *
 * Par navigateur : il ENREGISTRE ce qui vient d'être saisi, puis il ouvre la
 * fenêtre — sauf si les paquets manquent ou si une connexion tourne déjà,
 * auquel cas il est grisé AVEC son explication et le repli par fichier prend le
 * relais dans les options avancées.
 * Par mot de passe : il enregistre ce qui vient d'être saisi et enchaîne.
 *
 * L'enregistrement dans les DEUX cas n'est pas un détail : un connecteur à
 * navigateur distant peut déclarer des champs classiques à côté de son champ de
 * session. L'Atelier du Portable déclare `email` et `motDePasse` ; sans cet
 * enregistrement, l'identifiant tapé sur la fiche disparaissait à chaque
 * fermeture.
 */
function connectPrimaryAttributes(connector) {
  if (!connector.remoteLogin?.url) return 'onclick="saveConnector()"';
  const caps = rb().caps || { available: false, reason: '' };
  if (!caps.available || caps.busy) return 'disabled';
  return `onclick="enregistrerPuisOuvrirConnexion('${esc(connector.id)}')"`;
}

/** Pourquoi le bouton est grisé. Jamais un bouton mort sans explication. */
function connectPrimaryNote(connector) {
  if (!connector.remoteLogin?.url) return '';
  const caps = rb().caps || { available: false, reason: '' };
  if (caps.available && !caps.busy) return '';

  // ⚠ Jamais de phrase vide ici (lot 26). `caps.reason` peut manquer — l'état du
  // navigateur distant n'a pas encore été reçu, ou le serveur a répondu sans
  // motif —, et la note se rendait alors comme un bloc vide sous un bouton
  // grisé. « Le bouton de connexion est grisé », sans un mot de plus : c'est le
  // seul cas où crabe laissait quelqu'un devant une porte close sans rien lui
  // dire. Un repli existe toujours, et il est nommé.
  const pourquoi = caps.busy
    ? 'Une connexion par navigateur est déjà en cours sur ce serveur — un seul '
      + 'navigateur peut tourner à la fois. Réessayez dans quelques minutes.'
    : caps.reason
      || 'crabe n\'arrive pas à savoir si ce serveur peut ouvrir une fenêtre de '
        + 'connexion. Rechargez la page ; si le bouton reste grisé, vous pouvez '
        + 'déposer un fichier de session dans les options avancées.';
  return `<div class="rb-note">${esc(pourquoi)}</div>`;
}

/**
 * Au-delà de combien de caractères une aide se replie.
 *
 * Mesuré sur le catalogue du 13/08/2026 : 88 aides, médiane 142 caractères,
 * quatorze au-dessus de 300 — et toutes les quatorze tiennent sur plusieurs
 * lignes. Le seuil ne coupe donc jamais une aide d'un seul tenant, et laisse
 * les trois quarts du catalogue rigoureusement inchangés.
 */
const AIDE_LONGUE = 300;

/**
 * L'aide d'un champ — entière si elle est courte, repliée si elle est longue.
 *
 * ─── La panne que ça corrige (lot 22) ────────────────────────────────────────
 *
 * Fiche PayPal, vrai navigateur, fenêtre de 1280 × 900, mesuré : 1 124 px de
 * contenu dans une modale de 774. L'aide du premier champ fait 1 360 caractères
 * — la plus longue du catalogue — et s'intercale entre les deux champs. Le
 * second champ, « Secret d'application », et le SEUL bouton de la fiche
 * tombaient tous les deux sous la pliure. Rapporté ainsi : « les champs ne sont
 * pas visibles, je n'ai jamais pu ne serait-ce que tenter ». Le manifeste était
 * correct et le formulaire les rendait bien : ils étaient hors de l'écran.
 *
 * Ce qui reste VISIBLE est la première ligne, et ce n'est pas un hasard : ces
 * aides-là commencent par l'avertissement qui compte (« ⚠ DEUX CHOSES À SAVOIR
 * AVANT DE COMMENCER… », « ⚠ Votre clé doit d'abord être activée… »). Le mode
 * d'emploi complet, lui, se déplie quand on en a besoin.
 *
 * `<details>` plutôt qu'un basculement en JavaScript : c'est le navigateur qui
 * s'en charge, au clavier comme à la souris, et une aide dépliée le reste même
 * si la fiche se redessine.
 */
function fieldHelp(help) {
  const texte = String(help || '');
  if (!texte) return '';

  if (texte.length <= AIDE_LONGUE) {
    return `<div class="field-help">${esc(texte)}</div>`;
  }
  // La coupure naturelle est le premier saut de ligne. Une aide longue écrite
  // d'un seul tenant (celles d'rclone, souvent) se coupe à la fin de sa
  // première phrase — sans quoi elle restait un mur de texte au motif qu'elle
  // ne contenait pas de retour à la ligne (lot 57).
  let coupure = texte.indexOf('\n');
  if (coupure === -1) {
    const phrase = texte.indexOf('. ');
    if (phrase === -1) return `<div class="field-help">${esc(texte)}</div>`;
    coupure = phrase + 1;
  }

  const premiere = texte.slice(0, coupure);
  const suite = texte.slice(coupure + 1).trim();
  return `<div class="field-help">${esc(premiere)}
    <details>
      <summary>Tout lire</summary>
      <div class="field-help-suite">${esc(suite)}</div>
    </details>
  </div>`;
}

/** Un champ du formulaire de configuration, selon son type. */
function connectorField(connector, field) {
  const help = fieldHelp(field.help);

  if (field.type === 'select') {
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <select data-key="${esc(field.key)}">
        ${(field.options || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
      </select>${help}
    </div>`;
  }

  if (field.type === 'session') return sessionField(connector, field, help);
  if (field.type === 'multiselect') return multiselectField(connector, field, help);
  if (field.type === 'history') return historyField(connector, field, help);

  // ─── Le mot de passe : vide, avec sa consigne (lot 14, §8) ────────────────
  //
  // Il n'est JAMAIS renvoyé par le serveur, et le champ reste donc vide. La
  // mention dit ce que ça implique — laisser vide conserve le mot de passe
  // actuel — au lieu de laisser croire qu'il faut le ressaisir à chaque fois.
  if (field.type === 'password') {
    const consigne = connector.installed
      ? '<div class="field-help">Laissez vide pour conserver le mot de passe actuel.</div>'
      : '';
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <input type="password" data-key="${esc(field.key)}"
             placeholder="${esc(connector.installed ? '•••••••• (inchangé)' : field.placeholder || '')}"
             autocomplete="new-password">${help}${consigne}
    </div>`;
  }

  // ─── Les champs non secrets : relus tels quels (lot 14, §8) ───────────────
  //
  // En rouvrant la fiche d'un service déjà configuré, le champ d'identification
  // revenait vide. Rien ne disait quel compte était enregistré, et il fallait
  // croire qu'on devait tout ressaisir. Ces valeurs viennent de
  // `configSummary.values`, où le serveur ne met que les types non secrets.
  //
  // ─── Le type de champ ne se décide plus ici (lot 15) ──────────────────────
  //
  // Cette ligne ramenait tout champ d'adresse à un `type="text"`, et le libellé
  // affiché était celui que le manifeste écrivait à la main : L'Atelier du
  // Portable réclamait donc une « Adresse électronique » là où son site demande
  // un identifiant. Libellé, aide et type viennent maintenant de la NATURE
  // déclarée par le manifeste (voir server/connectors/identification.js) — le
  // formulaire les écrit, il ne les invente plus.
  const valeur = connector.configSummary?.values?.[field.key] || '';
  return `<div class="field">
    <label>${esc(field.label)}</label>
    <input type="${esc(field.inputType || field.type)}"
           data-key="${esc(field.key)}" value="${esc(valeur)}"
           placeholder="${esc(field.placeholder || '')}"
           autocomplete="off">${help}
  </div>`;
}

/**
 * Connexion enregistrée — sa validité, et de quoi la refaire. Rien d'autre.
 *
 * ─── Ce qui a été retiré au lot 9, et pourquoi ───────────────────────────────
 *
 * Ce bloc portait un « Choisir un fichier… », une zone de collage, et cette
 * phrase, sous « Options avancées » :
 *
 *   « Le repli reste possible avec « node tools/capture-session.js free-mobile
 *     https://mobile.free.fr/account/v2/login "Mes factures" », qui produit un
 *     fichier à déposer ici. »
 *
 * crabe s'adresse à des gens qui n'ont jamais ouvert un terminal. Une ligne de
 * commande dans une interface n'est pas une option de repli : c'est un mur, et
 * un mur qui donne à croire qu'on n'est pas le public visé. Le fait qu'elle soit
 * repliée sous « Options avancées » n'y change rien — on finit toujours par
 * ouvrir le repli quand on cherche.
 *
 * Le dépôt d'un fichier de session n'a pas disparu du produit : il est passé
 * dans l'administration, Paramètres → Applications → Dépannage. C'est un outil
 * d'administrateur pour une session qu'on ne peut pas rouvrir autrement, pas
 * une option offerte à l'utilisateur.
 *
 * Reste donc ici ce qui répond aux deux seules questions qu'on se pose :
 * jusqu'à quand ça marche, et comment refaire si c'est fini.
 */
function sessionField(connector, field, help) {
  const saved = connector.configSummary?.sessions?.[field.key] || null;
  let etat = '<span class="session-state">Aucune connexion enregistrée.</span>';
  if (saved) {
    const posee = saved.savedAt
      ? `Connexion enregistrée le ${esc(fmt.date(saved.savedAt))}`
      : 'Connexion enregistrée';
    const jusque = saved.expiresAt
      ? `, valable jusqu'au ${esc(fmt.date(saved.expiresAt))}`
      : ' — échéance inconnue';
    etat = saved.expired
      ? `<span class="session-state expired">${posee}${jusque} — expirée, reconnectez-vous.</span>`
      : `<span class="session-state ok">${posee}${jusque}.</span>`;
  }

  return `<div class="field">
    <label>${esc(field.label)}</label>
    <div class="session-box">
      ${etat}
      <div class="session-actions">
        <button type="button" class="btn-mini" ${reconnectAttributes(connector)}>
          Se reconnecter
        </button>
      </div>
    </div>${help}
  </div>`;
}

/**
 * « Se reconnecter » : le même geste que le bouton principal d'une fiche non
 * connectée, offert depuis une fiche qui l'est déjà.
 *
 * Par navigateur, il rouvre la fenêtre ; par mot de passe, il repasse la fiche
 * en saisie. Grisé quand un navigateur tourne déjà sur ce serveur — un seul à
 * la fois — et jamais sans son explication (voir `connectPrimaryNote`).
 */
function reconnectAttributes(connector) {
  if (!connector.remoteLogin?.url) {
    return `onclick="reconfigureConnector('${esc(connector.id)}')"`;
  }
  const caps = rb().caps || { available: false, reason: '' };
  if (!caps.available || caps.busy) return 'disabled';
  return `onclick="openRemoteLogin('${esc(connector.id)}')"`;
}

/**
 * Free, Amazon et d'autres n'admettent qu'une session ouverte à la fois.
 *
 * C'est la cause la plus probable d'une session qui expire avant terme, et
 * elle n'a rien d'évident : d'où cet avertissement, affiché avant le clic et
 * répété dans la modale.
 */
const AVERTISSEMENT_SESSION_UNIQUE =
  'Free, Amazon et d\'autres n\'autorisent qu\'une session active à la fois. Vous '
  + 'connecter ici déconnectera peut-être votre navigateur habituel, et vous '
  + 'reconnecter ailleurs invalidera cette session.';

/**
 * Champ à choix multiple alimenté par la découverte.
 *
 * Tant que rien n'a été découvert, il n'y a pas d'options à afficher : on le
 * dit, plutôt que de montrer une liste vide qui laisserait croire à un compte
 * sans ligne. `data-ready="0"` fait que la clé n'est PAS envoyée à
 * l'enregistrement — sinon une sélection vide écraserait celle déjà en base.
 */
function multiselectField(connector, field, help) {
  const known = connector.configSummary?.discoveries?.[field.key] || null;
  const items = known?.items || [];
  const selection = known?.selection;

  if (!items.length) {
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <div class="multi-box empty" data-key="${esc(field.key)}" data-field-type="multiselect" data-ready="0">
        La liste sera établie à la connexion : crabe se connecte, relève ce que porte
        votre compte, et vous laisse choisir.
      </div>${help}
    </div>`;
  }

  return `<div class="field">
    <label>${esc(field.label)}</label>
    ${multiselectBox(field, items, selection)}
    <div class="session-actions">
      <button type="button" class="btn-mini" onclick="rediscover()">Relancer la découverte</button>
    </div>${help}
  </div>`;
}

/**
 * Les cases à cocher elles-mêmes — partagées avec l'écran de sélection.
 *
 * ─── Ce qui identifie une ligne, et ce qui la complète ───────────────────────
 *
 * Jusqu'au lot 8, le nom du titulaire était en gros et le numéro en petit
 * dessous. C'est l'inverse qu'il faut : quatre lignes d'un même compte portent
 * le même nom — « Camille Dupont », quatre fois — et rien ne les distingue
 * alors les unes des autres. Le numéro, lui, ne désigne qu'une ligne.
 *
 *   0628000000                    principale
 *   Camille Dupont · 12 factures
 *
 * L'identifiant en évidence, le reste en dessous et en retrait. La règle vaut
 * pour tout élément découvert, quel que soit le connecteur : c'est toujours
 * l'identifiant qui distingue, jamais le libellé.
 */
function multiselectBox(field, items, selection) {
  const retenu = (item) => (Array.isArray(selection) ? selection.includes(item.id) : item.preselected);
  // Un élément sans nom de titulaire ne doit pas laisser un « · » orphelin.
  const complement = (item) => [item.label === item.id ? '' : item.label, item.detail]
    .filter(Boolean)
    .map(esc)
    .join(' · ');

  return `<div class="multi-box" data-key="${esc(field.key)}" data-field-type="multiselect" data-ready="1">
    ${items
      .map(
        (item) => `<label class="multi-item">
      <input type="checkbox" value="${esc(item.id)}"${retenu(item) ? ' checked' : ''}>
      <span class="multi-text">
        <span class="multi-head">
          <span class="multi-label">${esc(item.id)}</span>
          ${item.badge ? `<span class="badge-pill ${badgeTone(item.badge)}">${esc(item.badge)}</span>` : ''}
        </span>
        ${complement(item) ? `<span class="multi-sub">${complement(item)}</span>` : ''}
      </span>
    </label>`
      )
      .join('')}
  </div>`;
}

/**
 * Profondeur d'historique — quatre choix, et une seule décision.
 *
 * ─── Pourquoi ce réglage existe ──────────────────────────────────────────────
 *
 * Amazon expose quinze années de commandes. Les parcourir toutes prend une
 * demi-heure et sollicite lourdement le site : ça vaut le coup une fois, pas
 * tous les jours. Le réglage est **générique** — tout connecteur qui déclare un
 * champ de type `history` l'obtient, avec les mêmes mots.
 *
 * ─── Les libellés viennent du serveur ────────────────────────────────────────
 *
 * `field.choices` est envoyé par `connectors/history.js`. Ce sont les mots qui
 * engagent le comportement du serveur : les réécrire ici les ferait diverger le
 * jour où l'un des deux change.
 *
 * ─── « Les [ 2 ▾ ] dernières années » ────────────────────────────────────────
 *
 * Le sélecteur de nombre vit DANS son libellé, à sa place dans la phrase.
 * Bouger la liste déroulante hors de la ligne obligerait à lire deux endroits
 * pour comprendre un seul choix.
 */
function historyField(connector, field, help) {
  const courant = historyValue(connector, field);
  const choix = field.choices || [];
  const bornes = field.yearRange || { min: 1, max: 15 };

  const annees = [];
  for (let n = bornes.min; n <= bornes.max; n++) {
    annees.push(`<option value="${n}"${n === courant.annees ? ' selected' : ''}>${n}</option>`);
  }

  const ligne = (c) => {
    const selectionne = c.mode === courant.mode ? ' checked' : '';
    const libelle = c.mode === 'dernieres'
      ? esc(c.label).replace(
          '{n}',
          `<select class="history-years" data-years="1"
                   onchange="onHistoryYears('${esc(field.key)}')">${annees.join('')}</select>`
        )
      : esc(c.label);
    return `<label class="history-item">
      <input type="radio" name="history-${esc(field.key)}" value="${esc(c.mode)}"${selectionne}>
      <span class="history-text">${libelle}</span>
      ${c.note ? `<span class="history-note">${esc(c.note)}</span>` : ''}
    </label>`;
  };

  // Enregistrer CE réglage, sans relancer une récupération.
  //
  // Le bouton principal de la fiche enregistre, teste la connexion et récupère
  // dans la foulée. Changer l'historique — « toutes les années » vers « depuis
  // la dernière » — n'appelle rien de tout ça : c'est un réglage, pas une
  // reconfiguration.
  const enregistrer = `<button type="button" class="btn-ghost history-save"
      onclick="saveConnectorOnly()">Enregistrer</button>`;

  return `<div class="field">
    <label>${esc(field.label)}</label>
    <div class="history-box" data-key="${esc(field.key)}" data-field-type="history">
      ${choix.map(ligne).join('')}
    </div>${help}
    ${enregistrer}
  </div>`;
}

/**
 * Enregistre la configuration, et RIEN d'autre.
 *
 * Pas de test de connexion, pas d'ouverture de fenêtre, pas de récupération :
 * c'est tout l'intérêt de ce bouton. La fiche se ferme, et la liste est
 * rechargée pour que le réglage s'affiche à jour.
 *
 * ⚠ Le champ de SESSION n'est jamais soumis : il est rempli par la capture du
 * navigateur distant, et l'envoyer vide écraserait une connexion valable.
 */
async function saveConnectorOnly() {
  const id = state.currentConnectorId;
  const connector = state.connectors.find((c) => c.id === id);
  const champs = document.querySelectorAll('#modal-fields [data-key]');
  const box = $('modal-test-result');
  if (!connector || !champs.length) return;

  const config = readModalFields();
  for (const el of champs) {
    if (el.dataset.fieldType === 'session') delete config[el.dataset.key];
  }

  if (box) {
    box.className = 'test-result show loading';
    box.textContent = 'Enregistrement…';
  }

  try {
    if (!connector.installed) await api(`/connectors/${id}/install`, { method: 'POST' });
    await api(`/connectors/${id}/config`, { method: 'PUT', body: { config } });
    closeModal();
    await loadConnectors();
    showToast('Configuration enregistrée.');
  } catch (err) {
    if (box) {
      box.className = 'test-result show fail';
      box.textContent = err?.message || "La configuration n'a pas pu être enregistrée.";
    }
  }
}

/** Le choix enregistré pour ce compte, ou le défaut du champ. */
function historyValue(connector, field) {
  const brut = connector.configSummary?.settings?.[field.key] || field.default || 'depuis';
  const [mode, n] = String(brut).split(':');
  const annees = Number.parseInt(n, 10);
  return { mode, annees: Number.isFinite(annees) ? annees : 2 };
}

/**
 * Changer le nombre d'années revient à choisir cette ligne.
 *
 * Sans ça, on peut régler « 5 » en laissant coché « Année en cours seulement »
 * et repartir en croyant avoir demandé cinq ans.
 */
function onHistoryYears(key) {
  const boite = document.querySelector(`[data-key="${key}"][data-field-type="history"]`);
  const radio = boite?.querySelector('input[type="radio"][value="dernieres"]');
  if (radio) radio.checked = true;
}

/**
 * Couleur de pastille d'un badge de découverte.
 *
 * Deux mots, deux couleurs : le principal se voit, le reste s'efface. Le badge
 * vient de l'index de découverte (server/connectors/discovery.js) et ne peut
 * donc valoir que « principale » ou « secondaire » — une découverte enregistrée
 * avant le lot 9 peut encore porter « résiliée », qui tombe du bon côté.
 */
function badgeTone(badge) {
  return /principal/i.test(String(badge || '')) ? 'green' : 'gray';
}

function closeModal() {
  $('modal-overlay').classList.remove('show');
  showDiscoveryStep(false);
  state.discovery = null;
  state.modalEdit = false;
}

/**
 * Valeurs saisies dans le formulaire.
 *
 * Trois formes selon le type de champ : une chaîne, le contenu d'un fichier de
 * session, ou un tableau d'identifiants cochés. Un champ à choix multiple qui
 * n'a pas encore d'options n'est PAS envoyé — une sélection vide effacerait
 * celle déjà enregistrée.
 */
function readModalFields() {
  const config = {};
  for (const el of document.querySelectorAll('#modal-fields [data-key]')) {
    if (el.dataset.fieldType === 'history') {
      const choisi = el.querySelector('input[type="radio"]:checked');
      const mode = choisi ? choisi.value : 'depuis';
      const annees = el.querySelector('.history-years')?.value || '';
      config[el.dataset.key] = mode === 'dernieres' ? `dernieres:${annees}` : mode;
      continue;
    }

    if (el.dataset.fieldType === 'multiselect') {
      if (el.dataset.ready !== '1') continue;
      config[el.dataset.key] = [...el.querySelectorAll('input[type="checkbox"]')]
        .filter((box) => box.checked)
        .map((box) => box.value);
      continue;
    }
    config[el.dataset.key] = el.value;
  }
  return config;
}

/**
 * Enregistrer d'abord, ouvrir ensuite — connecteurs à navigateur distant.
 *
 * `openRemoteLogin` n'appelle QUE la route d'ouverture. Rien de ce qui a été
 * saisi sur la fiche n'est écrit en base. Sur L'Atelier du Portable, dont le
 * manifeste déclare `email` et `motDePasse` à côté du champ de session,
 * l'identifiant tapé disparaissait donc à chaque fermeture — et le bouton
 * « Saisir mes identifiants » de la fenêtre restait grisé sur « Aucun
 * identifiant enregistré pour ce service », alors que l'utilisateur venait
 * précisément de le renseigner.
 *
 * Le chemin d'enregistrement n'est pas réinventé : c'est celui de
 * `saveConnector`, installation comprise.
 *
 * ⚠ La configuration n'est envoyée que si la fiche est réellement ouverte sur
 * CE connecteur et qu'elle porte des champs. `readModalFields()` lit
 * `#modal-fields` : hors de la fiche, il rend un objet vide, dont l'envoi
 * EFFACERAIT la configuration au lieu de l'enregistrer. Les appels venus
 * d'ailleurs — la liste des erreurs, par exemple — passent donc toujours
 * directement par `openRemoteLogin`.
 */
async function enregistrerPuisOuvrirConnexion(connectorId) {
  const connector = state.connectors.find((c) => c.id === connectorId);
  const champs = document.querySelectorAll('#modal-fields [data-key]');
  const surLaFiche = state.currentConnectorId === connectorId && champs.length > 0;

  if (connector && surLaFiche) {
    const config = readModalFields();
    // Le champ de session est rempli par la CAPTURE, jamais par la fiche : le
    // renvoyer vide écraserait une connexion encore valable.
    for (const el of champs) {
      if (el.dataset.fieldType === 'session') delete config[el.dataset.key];
    }

    if (Object.keys(config).length) {
      try {
        if (!connector.installed) {
          await api(`/connectors/${connectorId}/install`, { method: 'POST' });
        }
        await api(`/connectors/${connectorId}/config`, { method: 'PUT', body: { config } });
      } catch (err) {
        // On n'ouvre pas la fenêtre sur une configuration qu'on n'a pas pu
        // enregistrer : l'utilisateur se connecterait pour rien.
        const box = $('modal-test-result');
        if (box) {
          box.className = 'test-result show fail';
          box.textContent = err?.message
            || "La configuration n'a pas pu être enregistrée. Réessayez.";
        }
        return;
      }
    }
  }

  await openRemoteLogin(connectorId);
}

/**
 * Enregistre la configuration, puis enchaîne test de connexion et PREMIÈRE
 * RÉCUPÉRATION, sans attendre la planification.
 *
 * En cas de succès, l'utilisateur est renvoyé sur l'accueil : son nouveau
 * connecteur y est visible et ses documents apparaissent dans « Derniers
 * documents ». En cas d'échec, on **reste sur la fiche du connecteur** avec le
 * message de l'échec — le renvoyer vers un accueil qui ne lui montrerait rien
 * ne l'aiderait pas à comprendre ce qui s'est passé.
 */
async function saveConnector() {
  const id = state.currentConnectorId;
  const connector = state.connectors.find((c) => c.id === id);
  const box = $('modal-test-result');
  // Le geste principal vit dans `modal-actions` : c'est lui qu'on grise pendant
  // l'enregistrement, et il peut être absent (fiche rendue autrement).
  const button = document.querySelector('#modal-actions button') || { disabled: false };
  const progress = (message) => {
    box.className = 'test-result show loading';
    box.textContent = message;
  };
  const failure = (message) => {
    box.className = 'test-result show fail';
    box.textContent = message;
  };

  button.disabled = true;
  try {
    progress('Enregistrement de la configuration…');
    if (!connector.installed) await api(`/connectors/${id}/install`, { method: 'POST' });
    await api(`/connectors/${id}/config`, { method: 'PUT', body: { config: readModalFields() } });

    progress('Test de connexion…');
    const test = await api(`/connectors/${id}/test`, { method: 'POST', body: { config: {} } });
    // Le message du serveur est AFFICHÉ TEL QUEL, et rien ne s'y ajoute.
    //
    // Il vient de `connectors/messages-echec.js`, où chaque cause porte déjà
    // l'action qui lui correspond : « corrigez-les » pour des identifiants
    // refusés, « signalez-le » pour une obstruction, « réessayez plus tard »
    // pour un site muet. Y accoler une phrase d'action fixe la rendait fausse
    // quatre fois sur cinq — « Une fenêtre du site empêche la connexion […]
    // — corrigez vos identifiants » accusait un mot de passe que la phrase
    // précédente venait d'innocenter. Même raison qu'au 409 de `runDiscovery`
    // plus bas : un message rédigé pour l'utilisateur ne se préfixe ni ne se
    // suffixe.
    if (!test.ok) return void failure(test.message);

    // Connecteur à découverte : on ne récupère rien avant que l'utilisateur
    // ait choisi. C'est le seul moment où il verra ses lignes résiliées, et
    // Free ne garde que les douze dernières factures.
    if (connector.discovery) return void (await runDiscovery(id, { progress, failure }));

    // Pas de découverte : c'est déjà « c'est fait ». Même écran de fin, même
    // phrase, même retour à l'accueil que pour un connecteur à plusieurs
    // lignes — un seul chemin de sortie.
    await finishDiscovery(id, { progress, failure });
  } catch (err) {
    failure(err.message);
  } finally {
    button.disabled = false;
  }
}

async function uninstallConnector() {
  const id = state.currentConnectorId;
  const connector = state.connectors.find((c) => c.id === id);
  if (!confirm(`Désinstaller ${connector.name} ? Ses identifiants enregistrés seront effacés.`)) return;
  await api(`/connectors/${id}`, { method: 'DELETE' });
  closeModal();
  await renderStore();
  showToast(`${connector.name} désinstallé`);
}

// ---------------------------------------------------------------------------
// Étape de découverte — choisir ce que crabe récupère
//
// Certains comptes portent plusieurs abonnements : quatre lignes chez Free
// Mobile, plusieurs points de livraison chez EDF. La liste n'est connue
// qu'APRÈS connexion, et l'établir prend 20 à 60 secondes — un formulaire qui
// semblerait figé pendant ce temps serait déroutant, d'où l'attente explicite.
// ---------------------------------------------------------------------------

/** Bascule entre la fiche et l'écran de sélection. */
function showDiscoveryStep(on) {
  $('modal-actions').style.display = on ? 'none' : 'flex';
  $('modal-discovery-actions').style.display = on ? 'flex' : 'none';
}

/**
 * Le nom, au pluriel, de ce que le connecteur va chercher : « lignes »,
 * « contrats », « comptes ». Sert à écrire « Recherche de vos lignes… »
 * plutôt que « Recherche en cours… ».
 */
function uniteDecouverte(connector) {
  const champ = (connector?.fields || []).find(
    (f) => f.type === 'multiselect' && (f.source || 'discover') === 'discover'
  );
  return champ?.unit ? `${champ.unit}s` : 'éléments';
}

/**
 * Ce que dit l'écran pendant la recherche.
 *
 * Les seuils collent à la durée réelle : la connexion est déjà acquise quand on
 * arrive ici, la recherche proprement dite prend 20 à 60 secondes chez Free
 * Mobile — un navigateur bascule sur chaque ligne pour compter ses factures.
 */
function etapesDecouverte(connector) {
  const quoi = uniteDecouverte(connector);
  return [
    { apres: 0, texte: 'Connexion réussie.' },
    { apres: 1800, texte: `Recherche de vos ${quoi}…` },
    { apres: 25_000, texte: 'Presque fini…' },
    {
      apres: 75_000,
      texte: 'C\'est plus long que d\'habitude, mais ça avance — encore un instant…',
    },
  ];
}

/**
 * Lance la découverte, puis affiche l'écran de choix — **s'il y a un choix**.
 *
 * Un compte qui ne porte qu'une seule ligne n'a rien à choisir : lui présenter
 * une case à cocher unique, déjà cochée, avec un bouton « Continuer », c'est
 * lui demander de valider une évidence. On enchaîne directement sur la
 * récupération. C'est le cas le plus fréquent, et c'est un écran de moins.
 *
 * Pendant toute la recherche, le bouton « Se connecter » laisse la place à un
 * indicateur de progression : il restait cliquable jusqu'ici, et un
 * utilisateur qui trouvait que « ça ne répond pas » lançait une seconde
 * connexion. Le serveur refuse de toute façon la seconde (voir
 * server/connectors/inflight.js) — mais un bouton qui ne doit pas être cliqué
 * ne doit pas avoir l'air cliquable.
 */
async function runDiscovery(id, { progress, failure }) {
  const connector = state.connectors.find((c) => c.id === id);

  return actionLongue({
    etapes: etapesDecouverte(connector),
    afficher: (texte) => attendreDansFiche(texte),
    executer: async () => {
      try {
        const found = await api(`/connectors/${id}/discover`, { method: 'POST' });
        state.discovery = { connectorId: id, field: found.field, items: found.items || [] };

        if ((found.items || []).length <= 1) {
          await finishDiscovery(id, { progress, failure });
          return true;
        }

        renderDiscovery(found);
        return true;
      } catch (err) {
        // Jamais un écran figé : le message dit ce qui s'est passé, et le
        // bouton dit quoi faire ensuite.
        // Un 409 est un refus RÉDIGÉ POUR L'UTILISATEUR (« une recherche est
        // déjà en cours sur votre compte ») : le préfixer d'un « la recherche a
        // échoué » le rendrait faux. Voir api(), qui conserve le code.
        echecDansFiche(
          err.status === 409
            ? err.message
            : `Connexion réussie, mais la recherche a échoué : ${err.message}`,
          id
        );
        failure(err.message);
        return false;
      }
    },
  });
}

/**
 * Remplace les boutons de la fiche par l'indicateur de progression.
 *
 * Remplacer plutôt que griser : un bouton grisé reste un bouton, et laisse
 * croire qu'on a raté quelque chose. Ici la fiche dit ce qu'elle fait, et il
 * n'y a rien d'autre à faire que d'attendre.
 */
function attendreDansFiche(texte) {
  const zone = $('modal-actions');
  if (!zone) return;
  const ligne = $('attente-texte');
  // Déjà en place : on ne réécrit que le texte, pour ne pas relancer
  // l'animation de la barre à chaque tic.
  if (ligne && zone.dataset.attente === '1') {
    ligne.textContent = texte;
    return;
  }
  zone.dataset.attente = '1';
  zone.style.display = 'flex';
  zone.innerHTML = `<div class="attente" role="status" aria-live="polite">
    <div class="attente-barre"><div class="attente-jauge"></div></div>
    <div class="attente-texte" id="attente-texte">${esc(texte)}</div>
  </div>`;
}

/** Un échec d'action longue : ce qui s'est passé, et un bouton pour réessayer. */
function echecDansFiche(message, connectorId) {
  const zone = $('modal-actions');
  if (!zone) return;
  zone.dataset.attente = '0';
  zone.style.display = 'flex';
  zone.innerHTML = `<div class="attente-echec" role="alert">${esc(message)}</div>
    <button class="btn-remote" onclick="relancerDecouverte('${esc(connectorId)}')">Réessayer</button>
    <button class="btn-ghost" onclick="closeModal()">Fermer</button>`;
}

/** « Réessayer » après un échec de recherche. */
async function relancerDecouverte(id) {
  const box = $('modal-test-result');
  await runDiscovery(id, {
    progress: (message) => {
      box.className = 'test-result show loading';
      box.textContent = message;
    },
    failure: (message) => {
      box.className = 'test-result show fail';
      box.textContent = message;
    },
  });
}

/**
 * Écran de sélection : ce que porte le compte, à cocher.
 *
 * La question est posée dans la langue du fournisseur — « Quelles lignes
 * voulez-vous suivre ? » — parce que « Sélectionnez les éléments découverts »
 * ne veut rien dire pour qui vient chercher ses factures.
 */
function renderDiscovery(found) {
  const items = found.items || [];
  const unite = found.field?.unit || 'élément';

  $('modal-fields').innerHTML = `
    <div class="discovery-head">
      <div class="discovery-title">Quelles ${esc(unite)}s voulez-vous suivre ?</div>
    </div>
    ${found.field.notice ? `<div class="discovery-notice">${esc(found.field.notice)}</div>` : ''}
    ${multiselectBox(found.field, items, found.selection)}`;

  $('modal-test-result').className = 'test-result';
  $('modal-test-result').textContent = '';
  showDiscoveryStep(true);
}

/** « Continuer » : la sélection cochée, puis la première récupération. */
async function confirmDiscovery() {
  const id = state.currentConnectorId;
  const box = $('modal-test-result');
  const button = $('modal-discovery-confirm');

  button.disabled = true;
  try {
    await finishDiscovery(id, {
      progress: (message) => {
        box.className = 'test-result show loading';
        box.textContent = message;
      },
      failure: (message) => {
        box.className = 'test-result show fail';
        box.textContent = message;
      },
      selection: readModalFields(),
    });
  } finally {
    button.disabled = false;
  }
}

/**
 * Le dernier écran : « c'est fait ».
 *
 * Enregistre la sélection (ou l'absence de choix quand il n'y en avait qu'un),
 * annonce que c'est connecté, lance la première récupération et rend la main à
 * l'accueil. La récupération n'est PAS attendue en silence : le message part
 * avant, parce que quelques dizaines de secondes de fenêtre figée ressemblent
 * à une panne.
 */
async function finishDiscovery(id, { progress, failure, selection = null }) {
  const connector = state.connectors.find((c) => c.id === id);
  const nom = connector ? connector.name : 'Le connecteur';

  try {
    if (selection) {
      progress('Enregistrement de votre choix…');
      await api(`/connectors/${id}/config`, { method: 'PUT', body: { config: selection } });
    }

    closeModal();
    showToast(`${nom} est connecté, récupération de vos factures en cours…`);
    showView('home');

    const run = await api(`/connectors/${id}/run`, { method: 'POST' });
    await loadConnectors();
    await renderHome().catch(() => {});
    showToast(run.ok ? `${nom} — ${run.message}` : `${nom} : ${run.message}`);
    return run.ok;
  } catch (err) {
    failure(err.message);
    return false;
  }
}

/** Retour à la fiche, sans rien enregistrer de plus. */
function cancelDiscovery() {
  state.discovery = null;
  openModal(state.currentConnectorId, { edit: true });
}

// ---------------------------------------------------------------------------
// Connexion par navigateur distant
//
// crabe ouvre un vrai Chromium SUR SON SERVEUR, sur un écran X en mémoire, et
// nous l'affiche ici par noVNC. L'utilisateur s'y connecte comme sur le site ;
// dès que le marqueur du connecteur apparaît, le serveur photographie la
// session, la chiffre, et éteint tout.
//
// Cette moitié-ci ne fait donc que trois choses : brancher l'écran, montrer le
// temps qui reste, et interroger l'état. Toute la logique — détection,
// enregistrement, extinction — vit côté serveur (server/remote-browser.js), là
// où elle survit à un onglet fermé.
// ---------------------------------------------------------------------------

/**
 * Raccourci de lecture sur `state.remoteLogin` — l'état du flux en cours.
 * Un seul à la fois, exactement comme côté serveur.
 */
function rb() {
  return state.remoteLogin;
}

/**
 * Les adresses de la session en cours (lot 34).
 *
 * La MÊME modale sert deux parcours : la connexion d'un connecteur
 * (`/connectors/:id/remote-login`) et l'autorisation d'un espace de stockage
 * (`/destinations/:id/autorisation`). Tout ce qui parle au serveur passe par
 * ici — un seul endroit à changer, aucun risque qu'un bouton vise l'ancien
 * parcours pendant que le reste vise le nouveau.
 */
function rbBase() {
  if (rb().base) return rb().base;
  return rb().connectorId ? `/connectors/${rb().connectorId}/remote-login` : null;
}

/** Le client noVNC, chargé à la demande depuis le paquet système. */
async function loadNovnc() {
  const module = await import('/novnc/core/rfb.js');
  return module.default || module.RFB;
}

/**
 * Ce que dit le voile pendant que le serveur monte la fenêtre.
 *
 * Un rond qui tourne indéfiniment ne dit pas si ça avance ou si c'est bloqué.
 * Les étapes ci-dessous durent réellement ce qui est annoncé : Xvfb et
 * Chromium démarrent en quelques secondes, la page du fournisseur met le reste.
 * Le dernier message est volontairement rassurant plutôt que muet — passé
 * vingt secondes, ce n'est pas encore un échec, mais ça mérite d'être dit.
 */
const RB_ETAPES = [
  { apres: 0, texte: 'Ouverture du navigateur…' },
  { apres: 4000, texte: 'Chargement du site…' },
  { apres: 20000, texte: 'Le site met du temps à répondre — encore un instant…' },
];

/** Fait avancer le voile d'étape en étape tant que le serveur n'a pas répondu. */
function startRemoteStages() {
  stopRemoteStages();
  const debut = Date.now();
  showRemoteVeil(RB_ETAPES[0].texte);
  rb().stages = setInterval(() => {
    const ecoule = Date.now() - debut;
    const etape = [...RB_ETAPES].reverse().find((e) => ecoule >= e.apres);
    if (etape) showRemoteVeil(etape.texte);
  }, 1000);
}

function stopRemoteStages() {
  if (rb().stages) clearInterval(rb().stages);
  rb().stages = null;
}

/**
 * Ouvre la modale et lance la session de connexion.
 *
 * L'ordre compte : la modale s'affiche AVANT que le serveur n'ait fini de
 * lancer Xvfb et Chromium (cinq à dix secondes), avec son voile d'attente.
 * Lancer d'abord et n'afficher qu'ensuite donnerait un bouton qui ne fait rien
 * pendant dix secondes.
 */
async function openRemoteLogin(connectorId) {
  const connector = state.connectors.find((c) => c.id === connectorId);
  if (!connector) return;

  rb().connectorId = connectorId;
  rb().mode = 'connector';
  rb().base = `/connectors/${connectorId}/remote-login`;
  // Symétrique d'openAutorisationStockage, qui nettoie `connectorId` : un
  // reste de parcours stockage (fenêtre en échec jamais refermée) ne doit pas
  // cohabiter avec le parcours connecteur — trois fonctions décident sur ces
  // champs (collage, relance, bouton « Réessayer »), un état mixte les
  // ferait viser le mauvais parcours (revue du lot 35).
  rb().stockageId = null;
  rb().stockageInfos = null;
  $('rb-fill').style.display = '';
  applyLogo($('rb-logo'), connector);
  $('rb-name').textContent = `Se connecter à ${connector.name}`;
  $('rb-state').textContent = 'Préparation…';
  // UN SEUL bandeau (lot 14, §7.4) : il y en avait deux, qui disaient la même
  // chose en des termes à peine différents. Celui-ci porte l'information
  // utile — la fenêtre se ferme seule, la connexion vaut environ un an — et le
  // `hint` du manifeste quand il ajoute quelque chose de propre au service.
  $('rb-banner').textContent = bandeauConnexion(connector);
  $('rb-result').className = 'test-result';
  $('rb-result').textContent = '';
  // « Fermer / Abandonner » est disponible dès l'ouverture et à tout moment
  // (lot 48) : la fenêtre doit toujours savoir renoncer — le soir du
  // 22/08/2026, une session Boulanger bloquée a tenu l'affichage dix minutes.
  $('rb-cancel').textContent = 'Fermer / Abandonner';
  $('rb-retry').style.display = 'none';
  $('rb-save-row').style.display = 'none';
  $('rb-renoncer-row').style.display = 'none';
  resetRemotePaste();
  resetRemoteFill();
  startRemoteStages();
  $('rb-overlay').classList.add('show', 'rb-open');

  try {
    const view = await api(`/connectors/${connectorId}/remote-login`, { method: 'POST' });
    stopRemoteStages();
    rb().view = view;
    applyRemoteView(view);
    await attachRemoteScreen(view);
    startRemotePolling();
  } catch (err) {
    stopRemoteStages();
    failRemoteLogin(err);
  }
}

/** « Réessayer » après un échec d'ouverture : on relance le même parcours. */
async function retryRemoteLogin() {
  // La session précédente n'a peut-être rien laissé, mais si elle a laissé
  // quelque chose, la relance échouerait sur le verrou d'unicité.
  if (rb().mode === 'stockage') {
    const id = rb().stockageId;
    const infos = rb().stockageInfos;
    if (!id) return void closeRemoteLogin();
    await api(`/admin/destinations/${id}/autorisation`, { method: 'DELETE' }).catch(() => {});
    return void openAutorisationStockage(id, infos || {});
  }
  const id = rb().connectorId;
  if (!id) return void closeRemoteLogin();
  await api(`/connectors/${id}/remote-login`, { method: 'DELETE' }).catch(() => {});
  await openRemoteLogin(id);
}

/**
 * « Se connecter à <service> » depuis l'écran Stockage (lot 34).
 *
 * Même fenêtre, même flux noVNC, autre serveur de vérité : c'est
 * `rclone authorize`, lancé par crabe, qui conclut — pas une capture de
 * session. L'utilisateur s'identifie chez le fournisseur et autorise ;
 * le jeton file de la commande à la configuration chiffrée sans jamais
 * passer par cet écran.
 *
 * @param {string} destId
 * @param {{nom?: string, color?: string, letters?: string}} infos l'habillage
 *   de la carte (admin.js les tient de la liste des destinations)
 */
async function openAutorisationStockage(destId, infos = {}) {
  rb().mode = 'stockage';
  rb().stockageId = destId;
  rb().stockageInfos = infos;
  rb().connectorId = null;
  rb().base = `/admin/destinations/${destId}/autorisation`;

  const nom = infos.nom || 'votre espace de stockage';
  applyLogo($('rb-logo'), { color: infos.color || 'var(--teal)', letters: infos.letters || '' });
  $('rb-name').textContent = `Se connecter à ${nom}`;
  $('rb-state').textContent = 'Préparation…';
  $('rb-banner').textContent = `Connectez-vous à ${nom} dans cette fenêtre, puis autorisez `
    + 'l\'accès. La fenêtre se fermera toute seule — la clé d\'accès est rangée chiffrée, '
    + 'elle ne s\'affiche jamais.';
  $('rb-result').className = 'test-result';
  $('rb-result').textContent = '';
  $('rb-cancel').textContent = 'Fermer / Abandonner';
  $('rb-retry').style.display = 'none';
  $('rb-save-row').style.display = 'none';
  $('rb-renoncer-row').style.display = 'none';
  // « Saisir mes identifiants » n'existe pas ici : crabe ne connaît pas le mot
  // de passe du fournisseur de stockage, et n'a pas à le connaître.
  $('rb-fill').style.display = 'none';
  $('rb-fill-note').textContent = '';
  resetRemotePaste();
  startRemoteStages();
  $('rb-overlay').classList.add('show', 'rb-open');

  try {
    const view = await api(rb().base, { method: 'POST' });
    stopRemoteStages();
    rb().view = view;
    if (view.hint) $('rb-banner').textContent = view.hint;
    applyRemoteView(view);
    await attachRemoteScreen(view);
    startRemotePolling();
  } catch (err) {
    stopRemoteStages();
    failRemoteLogin(err);
  }
}

/** Voile d'attente par-dessus l'écran : démarrage, enregistrement, échec. */
function showRemoteVeil(texte) {
  $('rb-veil-text').textContent = texte;
  $('rb-veil').className = 'rb-veil';
}

function hideRemoteVeil() {
  $('rb-veil').className = 'rb-veil hidden';
}

/**
 * Branche l'écran distant.
 *
 * Le flux passe par crabe, jamais en direct : `streamPath` pointe sur le
 * relais, qui vérifie la session applicative et consomme le jeton avant
 * d'ouvrir quoi que ce soit vers websockify. Le jeton est à usage unique — une
 * reconnexion en redemande un (voir `reattachRemoteScreen`).
 */
async function attachRemoteScreen(view) {
  const RFB = await loadNovnc();
  const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocole}://${location.host}${view.streamPath}`
    + `?token=${encodeURIComponent(view.token)}`
    + `&connector=${encodeURIComponent(view.connectorId)}`;

  const rfb = new RFB($('rb-screen'), url, {
    credentials: { password: view.vncPassword || '' },
  });
  // L'écran distant fait 1280×800 ; la boîte qui le porte a exactement le même
  // rapport (voir .rb-screen) : la mise à l'échelle la remplit au pixel près,
  // sans bande noire ni rognage.
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;

  rfb.addEventListener('connect', () => {
    hideRemoteVeil();
    // Le clavier doit répondre TOUT DE SUITE. Sans ça, on tape son identifiant
    // dans le vide et il faut deviner qu'il fallait d'abord cliquer dans la
    // fenêtre — personne ne devine ça.
    try {
      rfb.focus();
    } catch {
      /* selon la version de noVNC, le focus vient déjà du clic */
    }
  });
  rfb.addEventListener('disconnect', () => {
    // Le serveur ferme le navigateur dès la connexion détectée : une
    // déconnexion pendant « saving » est normale, pas un incident.
    if (rb().view?.state === 'running') {
      showRemoteVeil('Affichage interrompu — tentative de reconnexion…');
      reattachRemoteScreen().catch(() => {});
    }
  });

  // Presse-papiers distant → poste. Sur une instance servie en HTTP simple,
  // `navigator.clipboard` n'existe pas (contexte non sécurisé) : on garde alors
  // le texte sous la main dans le champ de collage, plutôt que de le perdre.
  rfb.addEventListener('clipboard', (event) => {
    const texte = event?.detail?.text;
    if (!texte) return;
    rb().remoteClipboard = texte;
    try {
      navigator.clipboard?.writeText?.(texte)?.catch?.(() => {});
    } catch {
      /* refusé par le navigateur : sans conséquence, on l'a gardé */
    }
  });

  rb().rfb = rfb;
  bindRemoteClipboard();
  bindRemoteKeyboard();
}

/**
 * Le pavé numérique, qui n'arrivait pas jusqu'au site.
 *
 * noVNC convertit bien les touches du pavé — il envoie `XK_KP_0` … `XK_KP_9`.
 * Mais un keysym de pavé ne vaut un chiffre QUE si le verrou numérique est
 * actif sur le serveur X distant, et le `Xvfb` que crabe lance à chaque
 * session démarre verrou éteint : `KP_0` y vaut « Inser », `KP_1` « Fin »,
 * `KP_2` « Bas ». Les frappes arrivaient donc bien, et ne produisaient rien.
 * Un code SMS à six chiffres était intapable au pavé — c'est-à-dire à l'endroit
 * où tout le monde le tape.
 *
 * On intercepte donc le pavé, et lui seul, pour envoyer l'équivalent ordinaire
 * de chaque touche (voir web/keysym.js). Le reste du clavier continue de
 * passer par noVNC, qui s'en acquitte : la connexion Free Mobile aboutit en
 * production, identifiant et mot de passe compris.
 *
 * En capture sur `document` : l'écouteur doit passer AVANT celui que noVNC
 * pose sur sa toile, sinon la touche part deux fois.
 */
function bindRemoteKeyboard() {
  if (bindRemoteKeyboard.done) return;
  bindRemoteKeyboard.done = true;

  document.addEventListener('keydown', (event) => relayerPave(event, true), true);
  // Le relâchement est avalé lui aussi : `sendKey` a déjà envoyé l'appui ET le
  // relâchement, et laisser passer celui-ci ferait relâcher côté serveur une
  // touche que noVNC n'a jamais vue s'enfoncer.
  document.addEventListener('keyup', (event) => relayerPave(event, false), true);
}

/**
 * Cette frappe est-elle destinée à la fenêtre distante ?
 *
 * Le champ « Coller un mot de passe » vit dans la même modale : y saisir des
 * chiffres au pavé doit rester possible. On ne détourne donc rien de ce qui
 * arrive sur un champ de formulaire de crabe.
 */
function fenetreDistanteActive(event) {
  if (!rb().rfb) return false;
  if (!$('rb-overlay').classList.contains('show')) return false;
  const balise = String(event?.target?.tagName || '').toLowerCase();
  return !['input', 'textarea', 'select'].includes(balise);
}

/** Envoie une touche du pavé sous sa forme ordinaire, et coupe court. */
function relayerPave(event, appui) {
  if (!fenetreDistanteActive(event)) return;

  // Une COMBINAISON n'est jamais détournée : Ctrl+A, Ctrl+C, Ctrl+X — et leurs
  // équivalents au pavé — doivent partir avec leur modificateur. Or `sendKey`
  // n'envoie qu'un keysym nu : renvoyer « 4 » à la place de « Ctrl+4 » perdrait
  // le raccourci en silence. noVNC, lui, sait transmettre les modificateurs.
  if (event?.ctrlKey || event?.altKey || event?.metaKey) return;

  const keysym = keysymDuPave(event);
  if (keysym === null) return;

  event.preventDefault?.();
  // `stopImmediatePropagation` et pas `stopPropagation` : noVNC pose son
  // écouteur plus bas dans l'arbre, mais rien ne garantit qu'un jour il ne le
  // posera pas sur le même nœud que nous.
  event.stopImmediatePropagation?.();
  if (!appui) return;

  try {
    rb().rfb.sendKey(keysym, null);
  } catch {
    /* flux tombé entre-temps : la reconnexion s'en charge */
  }
}

/**
 * Pousse un texte dans le presse-papiers du navigateur distant.
 *
 * **En complément seulement.** Le nom de la méthode a changé selon les versions
 * de noVNC (`clipboardPasteFrom` en 1.x, `clipboardPaste` sur les branches plus
 * récentes) et le paquet installé sur le LXC n'est pas celui du dépôt : on
 * essaie les deux, et l'absence des deux n'est pas un incident. Ce qui saisit
 * réellement le texte, c'est la frappe (voir `typeIntoRemote`).
 *
 * @returns {boolean} vrai si une des méthodes a répondu
 */
function pousserPressePapiersDistant(texte) {
  const rfb = rb().rfb;
  if (!rfb || !texte) return false;
  for (const nom of ['clipboardPasteFrom', 'clipboardPaste']) {
    try {
      if (typeof rfb[nom] === 'function') {
        rfb[nom](texte);
        return true;
      }
    } catch {
      /* version qui refuse : on essaie la suivante */
    }
  }
  return false;
}

/**
 * Presse-papiers du poste → navigateur distant, quand le navigateur le permet.
 *
 * Un Ctrl+V dans la fenêtre distante colle le presse-papiers DU SERVEUR, pas
 * celui du poste. On écoute donc le collage local pour pousser le texte de
 * l'autre côté — mais **ce chemin n'est pas fiable** : noVNC annule la frappe
 * sur sa toile, et l'événement `paste` n'arrive alors jamais. C'est pour cela
 * que le champ « Coller un texte » est visible en permanence : lui fonctionne
 * partout, parce qu'il vit dans une page de crabe.
 *
 * L'écouteur est posé une seule fois pour la vie de la page ; il ne fait rien
 * tant qu'aucune session n'est ouverte.
 */
function bindRemoteClipboard() {
  if (bindRemoteClipboard.done) return;
  bindRemoteClipboard.done = true;

  document.addEventListener('paste', (event) => {
    if (!rb().rfb) return;
    // Un collage DANS le champ de crabe reste un collage local : le pousser
    // au serveur ne servirait à rien, et le bouton « Envoyer » s'en charge.
    const balise = String(event?.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(balise)) return;

    const texte = event.clipboardData?.getData?.('text');
    if (!texte) return;
    pousserPressePapiersDistant(texte);
  });
}

/** Entrée valide la saisie : personne ne cherche le bouton après avoir collé. */
function onRemotePasteKey(event) {
  if (event?.key !== 'Enter') return;
  event.preventDefault?.();
  pasteIntoRemote();
}

/**
 * Vide le champ et remet sa consigne.
 *
 * Le bloc, lui, reste VISIBLE : c'est la voie principale pour saisir un mot de
 * passe dans la fenêtre distante, pas une option à découvrir.
 */
function resetRemotePaste() {
  const champ = $('rb-paste-input');
  champ.value = '';
  champ.disabled = false;
  $('rb-paste-send').disabled = false;
  $('rb-paste-note').textContent =
    'Cliquez d\'abord dans le champ voulu de la fenêtre ci-dessus. Collez ici '
    + '(Ctrl+V), puis cliquez « Envoyer » pour le saisir dans le site.';
  clearTimeout(pasteIntoRemote.minuteur);
}

/**
 * Saisit le contenu du champ dans le champ actif du navigateur distant.
 *
 * L'ordre compte, et il a changé au lot 10 : la **frappe d'abord**, le
 * presse-papiers distant ensuite et seulement en complément. C'est la frappe
 * qui fonctionne partout — elle ne dépend ni du presse-papiers du poste, ni de
 * la politique du navigateur, ni d'un raccourci que l'utilisateur devrait
 * connaître.
 *
 * Le texte n'est **jamais journalisé** — ni `console`, ni toast, ni requête —
 * et le champ est vidé aussitôt après.
 */
async function pasteIntoRemote() {
  const champ = $('rb-paste-input');
  const bouton = $('rb-paste-send');
  const texte = String(champ.value || '');
  const note = $('rb-paste-note');

  if (!texte) {
    note.textContent = 'Collez d\'abord votre texte dans le champ ci-dessus.';
    return;
  }
  // Le connecteur, pas le flux d'affichage : c'est le SERVEUR qui frappe. Un
  // écran qui n'a pas fini de se brancher ne doit pas empêcher une saisie qui
  // ne passe pas par lui — c'est ce que le lot 12 interdisait sans raison.
  if (!rb().connectorId && !rb().stockageId) {
    note.textContent = 'La fenêtre n\'est pas ouverte.';
    return;
  }

  note.textContent = 'Saisie en cours…';
  bouton.disabled = true;
  champ.disabled = true;

  const frappe = await typeIntoRemote(texte);

  // Complément : si le presse-papiers distant répond, un Ctrl+V dans la fenêtre
  // marchera aussi. S'il ne répond pas, la frappe a déjà fait le travail.
  pousserPressePapiersDistant(texte);

  champ.disabled = false;
  bouton.disabled = false;

  if (!frappe.ok) {
    // Le serveur dit QUOI FAIRE — « cliquez d'abord dans le champ du site » —
    // et pas ce qui a échoué techniquement. On le répète tel quel, et on garde
    // le texte : le refaire coller serait une punition pour un geste manquant.
    note.textContent = frappe.error;
    return;
  }

  // Le texte a fini son voyage : ni dans le champ, ni dans une variable.
  note.textContent = 'Texte saisi.';
  clearTimeout(pasteIntoRemote.minuteur);
  pasteIntoRemote.minuteur = setTimeout(() => {
    champ.value = '';
    resetRemotePaste();
  }, 2000);
}

/**
 * Frappe un texte dans la fenêtre distante.
 *
 * ─── Deux chemins, et le bon d'abord (lot 12) ────────────────────────────────
 *
 * **Le serveur, d'abord.** `POST …/remote-login/type` fait frapper le texte par
 * Playwright, qui parle directement au navigateur. Ce chemin ne dépend ni de la
 * version de noVNC installée sur le LXC, ni de la table de keysyms du serveur X
 * — un Xvfb frais n'a ni verrou numérique ni disposition complète —, ni du fait
 * que la toile ait bien le focus. Les accents, la ponctuation et les caractères
 * spéciaux d'un mot de passe fort passent tels quels.
 *
 * **Les keysyms, ensuite, et seulement en repli.** C'est le chemin du lot 10 :
 * un keysym X11 par caractère à travers le flux noVNC. Quand il échoue, il
 * échoue SANS RIEN DIRE — les frappes partent, rien n'apparaît, et l'interface
 * annonçait quand même « Saisi dans la fenêtre ». C'est ce silence qui rendait
 * le champ inutilisable en production, pas son absence.
 *
 * La conversion en keysym vit dans web/keysym.js, avec celle du pavé numérique.
 *
 * ─── Ce que le lot 13 change : on ne ment plus sur le résultat ───────────────
 *
 * Jusqu'ici, TOUTE erreur du serveur faisait basculer sur les keysyms, et le
 * chemin par keysyms renvoyait « vrai » du moment que `sendKey` n'avait pas
 * levé — c'est-à-dire quasiment toujours, y compris quand rien n'arrivait à
 * l'écran. L'interface annonçait alors « Saisi dans la fenêtre » sur une
 * saisie qui n'avait pas eu lieu : le pire des comptes rendus, et la raison
 * pour laquelle ce champ était réputé « ne pas fonctionner » depuis trois lots.
 *
 * Désormais : le serveur vérifie que le champ a bien changé et dit ce qui
 * manque, son refus est REPRIS TEL QUEL, et le repli par keysyms n'est tenté
 * que si la route est absente (serveur d'une version antérieure).
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function typeIntoRemote(texte) {
  const base = rbBase();
  if (!base) return { ok: false, error: 'La fenêtre n\'est pas ouverte.' };

  try {
    // Le texte part dans le corps de la requête, jamais dans l'URL : une URL
    // se retrouve dans les journaux d'accès, un corps de POST non.
    await api(`${base}/type`, {
      method: 'POST',
      body: { text: String(texte) },
    });
    return { ok: true };
  } catch (err) {
    // 404 : la route n'existe pas — serveur d'une version antérieure. C'est le
    // seul cas où le chemin historique a encore un sens.
    if (err.status === 404) {
      const parKeysyms = await typeIntoRemoteParKeysyms(texte);
      return parKeysyms
        ? { ok: true }
        : { ok: false, error: 'La saisie n\'a pas abouti. Réessayez.' };
    }
    // 409 : le serveur sait POURQUOI et l'a écrit pour l'utilisateur.
    return {
      ok: false,
      error: err.message || 'La saisie n\'a pas abouti — réessayez dans un instant.',
    };
  }
}

/**
 * Repli : un keysym X11 par caractère, à travers le flux noVNC.
 *
 * Gardé parce qu'il ne coûte rien et qu'il a déjà servi — mais il n'est plus la
 * voie principale : voir `typeIntoRemote`.
 */
async function typeIntoRemoteParKeysyms(texte) {
  const rfb = rb().rfb;
  if (!rfb) return false;

  for (const caractere of String(texte)) {
    const keysym = keysymPourCaractere(caractere);
    try {
      rfb.sendKey(keysym, null);
    } catch {
      return false;
    }
    // Une frappe instantanée fait perdre des caractères aux formulaires qui
    // écoutent chaque touche (masques de saisie, mesure de force du mot de
    // passe). Huit millisecondes suffisent et restent imperceptibles.
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  return true;
}

/** Rebranche l'écran avec un jeton neuf, après une coupure. */
async function reattachRemoteScreen() {
  if (!rbBase()) return;
  detachRemoteScreen();
  const fresh = await api(`${rbBase()}/ticket`, { method: 'POST' });
  if (fresh.token) await attachRemoteScreen(fresh);
}

/** Coupe le flux sans toucher à la session côté serveur. */
function detachRemoteScreen() {
  try {
    rb().rfb?.disconnect();
  } catch {
    /* déjà fermé */
  }
  rb().rfb = null;
}

/**
 * Interroge l'état chaque seconde, et fait avancer le compte à rebours.
 *
 * Aucun paramètre : l'adresse vient de `rbBase()`, la seule source qui
 * connaisse le parcours en cours. La fonction acceptait un `connectorId`
 * qu'elle ignorait — un paramètre qui laisse croire que le sondage est propre
 * aux connecteurs est exactement le genre de piste fausse qui a produit les
 * trois fautes du 15/08 (revue du lot 35).
 */
function startRemotePolling() {
  stopRemoteTimers();
  const base = rbBase();
  rb().poll = setInterval(async () => {
    try {
      const view = await api(base);
      rb().view = view;
      applyRemoteView(view);
      if (view.done) await finishRemoteLogin(view);
    } catch (err) {
      // 404 : la session a disparu côté serveur (redémarrage du service).
      failRemoteLogin(err.message);
    }
  }, 1000);
  rb().tick = setInterval(tickRemoteCountdown, 1000);
  tickRemoteCountdown();
}

function stopRemoteTimers() {
  for (const key of ['poll', 'tick']) {
    if (rb()[key]) clearInterval(rb()[key]);
    rb()[key] = null;
  }
}

/**
 * Reporte l'état du serveur à l'écran : phrase d'état, voile, échéance.
 *
 * `remainingMs` est converti en ÉCHÉANCE absolue dès sa réception : le compte
 * à rebours s'affiche à la seconde mais l'état n'arrive qu'à la seconde, et
 * décrémenter un compteur à chaque réponse le ferait sautiller.
 */
function applyRemoteView(view) {
  $('rb-state').textContent = view.detail ? `${view.message} — ${view.detail}` : view.message;
  if (view.state === 'saving') showRemoteVeil('Vérification de la connexion…');
  rb().deadline = Date.now() + (view.remainingMs || 0);

  // §6.3 — un essai a montré que la session n'était pas encore valable. La
  // fenêtre reste ouverte, et « Enregistrer » apparaît : c'est à l'utilisateur
  // de dire quand il a fini. Le contrôle sera refait à l'identique.
  $('rb-save-row').style.display = view.attenteManuelle ? 'flex' : 'none';

  // Lot 48 — après TROIS vérifications restées sans preuve, l'écran propose
  // explicitement de renoncer. Recliquer « Enregistrer » sans fin était le
  // piège du 22/08/2026 : quatre refus identiques sur Boulanger, puis dix
  // minutes d'attente forcée. Renoncer ferme la fenêtre, libère l'affichage,
  // et n'enregistre rien — on peut revenir plus tard.
  $('rb-renoncer-row').style.display =
    view.attenteManuelle && (view.echecsVerification || 0) >= 3 ? 'flex' : 'none';

  // Le bouton « Saisir mes identifiants » n'est cliquable que s'il y a
  // quelque chose à saisir — et il dit pourquoi quand ce n'est pas le cas.
  const bouton = $('rb-fill');
  if (bouton && view.identifiantsDisponibles !== undefined) {
    bouton.disabled = !view.identifiantsDisponibles;
    $('rb-fill-note').textContent = view.identifiantsDisponibles
      ? 'crabe remplit l\'identifiant et le mot de passe dans le formulaire du site.'
      : 'Aucun identifiant enregistré pour ce service.';
  }
}

/**
 * Le texte du bandeau unique de la fenêtre de connexion.
 *
 * L'information qui compte tient en deux phrases : la fenêtre se ferme seule,
 * et la connexion enregistrée dure. Le `hint` du manifeste ne s'y ajoute que
 * s'il apporte autre chose — beaucoup se contentaient de redire « connectez-
 * vous comme d'habitude », ce que le premier bandeau disait déjà.
 */
function bandeauConnexion(connector) {
  const base = 'Connectez-vous comme sur le site : la fenêtre se fermera d\'elle-même une fois '
    + 'la connexion vérifiée, et la connexion enregistrée reste valable environ un an.';
  const propre = String(connector?.remoteLogin?.hint || '').trim();
  // Un indice qui ne fait que répéter la consigne n'ajoute rien à l'écran.
  const redondant = /connectez-vous comme|la fen[êe]tre se fermera|valable/i.test(propre);
  return propre && !redondant ? `${base} ${propre}` : base;
}

/** Le bouton de saisie repart inactif : l'état réel vient du serveur. */
function resetRemoteFill() {
  const bouton = $('rb-fill');
  if (!bouton) return;
  bouton.disabled = true;
  $('rb-fill-note').textContent = '';
}

/**
 * « Saisir mes identifiants » — le serveur écrit dans le formulaire du site.
 *
 * Rien n'est envoyé : le client DEMANDE, le serveur écrit. Le mot de passe ne
 * transite par aucune requête, et la réponse ne dit que ce qui a été posé.
 */
async function fillRemoteCredentials() {
  const bouton = $('rb-fill');
  const note = $('rb-fill-note');
  const rendu = bouton.textContent;

  // Les identifiants enregistrés sont un concept de CONNECTEUR : crabe ne
  // connaît aucun mot de passe de fournisseur de stockage (le bouton est
  // d'ailleurs masqué sur ce parcours). Sans cette garde, un appel résiduel
  // viserait `/connectors/null/…` — la famille exacte des trois fautes
  // corrigées à la main le 15/08 (revue du lot 35).
  if (!rb().connectorId) {
    note.textContent = 'Ce parcours n\'a pas d\'identifiants enregistrés à saisir.';
    return;
  }

  bouton.disabled = true;
  bouton.textContent = 'Saisie…';
  try {
    const res = await api(`/connectors/${rb().connectorId}/remote-login/credentials`, {
      method: 'POST',
    });
    note.textContent = res.motDePasse
      ? 'Identifiant et mot de passe saisis dans le formulaire du site.'
      : 'Identifiant saisi. Le champ de mot de passe n\'a pas été trouvé sur cette page.';
  } catch (err) {
    note.textContent = err.message;
  } finally {
    bouton.textContent = rendu;
    bouton.disabled = false;
  }
}

/** « Enregistrer » après un essai de session resté sans preuve (§6.3). */
async function saveRemoteSession() {
  // « Enregistrer la session » n'existe que pour un CONNECTEUR : une
  // autorisation de stockage conclut par la sortie d'rclone, jamais par ce
  // bouton (le serveur ne pose pas `attenteManuelle` sur ce parcours, la
  // rangée reste donc masquée). Sans la garde, un appel résiduel viserait
  // `/connectors/null/remote-login/save` (revue du lot 35).
  if (!rb().connectorId) return;

  const bouton = $('rb-save');
  const rendu = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = 'Vérification…';

  try {
    const view = await api(`/connectors/${rb().connectorId}/remote-login/save`, { method: 'POST' });
    rb().view = view;
    applyRemoteView(view);
    if (view.done) await finishRemoteLogin(view);
  } catch (err) {
    // 409 : le contrôle a de nouveau échoué. Ce n'est pas une panne, c'est un
    // parcours de connexion qui n'est pas terminé — on le dit tel quel. Et si
    // le serveur n'a rien dit (coupure, réponse sans corps), on dit QUAND MÊME
    // quelque chose : un bouton qui ne répond rien est le défaut d'origine de
    // ce lot (lot 48, soirée du 22/08/2026).
    $('rb-result').className = 'test-result show fail';
    $('rb-result').textContent = err.message && err.message !== `Erreur ${err.status}`
      ? err.message
      : 'La vérification n\'a pas abouti et le serveur n\'a pas dit pourquoi. '
        + 'Réessayez, ou fermez la fenêtre : rien ne sera enregistré.';
    // L'état du serveur a pu changer (compteur d'échecs, consigne) : on le
    // relit tout de suite plutôt que d'attendre la prochaine seconde.
    const base = rbBase();
    if (base) {
      api(base).then((etat) => {
        rb().view = etat;
        applyRemoteView(etat);
      }).catch(() => {});
    }
  } finally {
    bouton.textContent = rendu;
    bouton.disabled = false;
  }
}

/** « 7:42 » — et de l'ambre sous une minute. */
function tickRemoteCountdown() {
  const box = $('rb-countdown');
  if (!rb().deadline || rb().view?.done) return void (box.textContent = '');

  const reste = Math.max(0, rb().deadline - Date.now());
  const minutes = Math.floor(reste / 60000);
  const secondes = Math.floor((reste % 60000) / 1000);
  box.textContent = `${minutes}:${String(secondes).padStart(2, '0')}`;
  box.className = reste <= 60000 ? 'rb-countdown urgent' : 'rb-countdown';
}

/**
 * Fin de parcours.
 *
 * Succès : la modale se referme et on enchaîne exactement sur le parcours du
 * lot 5 — découverte, puis sélection des lignes. C'est là tout l'intérêt : la
 * connexion n'est plus une étape à part, elle est le début du parcours.
 */
async function finishRemoteLogin(view) {
  stopRemoteTimers();
  detachRemoteScreen();

  if (view.state !== 'saved') {
    return void failRemoteLogin(view.error || view.message, { fatal: true });
  }

  // L'autorisation d'un espace de stockage (lot 34) : pas de découverte à
  // enchaîner, pas de fiche de connecteur à rouvrir. On dit que c'est fait,
  // et l'écran Stockage se redessine avec la carte à jour (« connecté »).
  if (rb().mode === 'stockage') {
    closeRemoteLogin();
    showToast(view.message || 'Autorisation enregistrée.');
    if (typeof renderAdminStorage === 'function') {
      Promise.resolve(renderAdminStorage()).catch(() => {});
    }
    return;
  }

  closeRemoteLogin();
  // Le verdict de réussite est AFFICHÉ, pas seulement déduit de la fermeture :
  // le message du serveur porte le nombre de cookies gardés (lot 48).
  showToast(view.message || 'Session enregistrée.');
  await loadConnectors();

  // La fiche se rouvre sur l'étape suivante : choisir ce que crabe récupère —
  // et SEULEMENT s'il y a quelque chose à choisir (voir runDiscovery). Sinon
  // on enchaîne d'un trait sur « c'est fait ».
  openModal(view.connectorId, { edit: true });
  const box = $('modal-test-result');
  const etapes = {
    progress: (message) => {
      box.className = 'test-result show loading';
      box.textContent = message;
    },
    failure: (message) => {
      box.className = 'test-result show fail';
      box.textContent = message;
    },
  };

  if (view.result?.discovery) return void (await runDiscovery(view.connectorId, etapes));
  await finishDiscovery(view.connectorId, etapes);
}

/**
 * Ce qu'on affiche quand la fenêtre ne s'ouvre pas.
 *
 * Un refus ÉCRIT POUR L'UTILISATEUR — « une autre connexion est en cours »,
 * « mémoire insuffisante », « il manque tel paquet » — porte une consigne : on
 * le montre tel quel, ce serait absurde de le remplacer par une phrase creuse.
 * Un incident (5xx) n'en porte aucune : on dit ce qu'il faut faire, et le
 * détail technique part au journal d'administration, où il est retrouvable.
 *
 * @param {Error|string} cause
 * @returns {string}
 */
const RB_ECHEC_GENERIQUE =
  'La fenêtre de connexion n\'a pas pu s\'ouvrir. Réessayez dans un instant.';

function remoteFailureText(cause) {
  const status = typeof cause === 'string' ? 0 : Number(cause?.status || 0);
  const message = typeof cause === 'string' ? cause : String(cause?.message || '');
  // 409 (une connexion déjà ouverte) et 503 (mémoire, paquets manquants) sont
  // les seuls refus que le serveur rédige à l'intention de l'utilisateur.
  const actionnable = status === 409 || status === 503;
  return actionnable && message ? message : RB_ECHEC_GENERIQUE;
}

/** Échec : on reste sur place, on dit quoi faire, et « Réessayer » apparaît. */
function failRemoteLogin(cause, { fatal = false } = {}) {
  stopRemoteTimers();
  stopRemoteStages();
  detachRemoteScreen();

  const texte = remoteFailureText(cause);
  showRemoteVeil(texte);
  $('rb-result').className = 'test-result show fail';
  $('rb-result').textContent = texte;
  $('rb-cancel').textContent = 'Fermer';
  $('rb-retry').style.display = (rb().connectorId || rb().stockageId) ? 'block' : 'none';
  $('rb-countdown').textContent = '';
  if (fatal) rb().view = null;
}

/**
 * Annulation : le navigateur s'éteint côté serveur, rien n'est enregistré.
 *
 * L'appel au serveur est en « best effort » — si la session a déjà disparu, la
 * modale se referme quand même. Laisser l'utilisateur enfermé dans une modale
 * parce qu'un DELETE a répondu 404 serait absurde.
 */
async function cancelRemoteLogin() {
  const base = rbBase();
  const mode = rb().mode;
  stopRemoteTimers();
  stopRemoteStages();
  detachRemoteScreen();
  closeRemoteLogin();
  if (base) {
    await api(base, { method: 'DELETE' }).catch(() => {});
    if (mode === 'stockage') {
      if (typeof renderAdminStorage === 'function') {
        Promise.resolve(renderAdminStorage()).catch(() => {});
      }
    } else {
      await loadConnectors().catch(() => {});
    }
  }
}

function closeRemoteLogin() {
  $('rb-overlay').classList.remove('show', 'rb-open');
  $('rb-screen').innerHTML =
    '<div class="rb-veil" id="rb-veil"><div class="rb-spinner"></div>'
    + '<div id="rb-veil-text">Ouverture du navigateur…</div></div>';
  $('rb-retry').style.display = 'none';
  $('rb-save-row').style.display = 'none';
  $('rb-renoncer-row').style.display = 'none';
  resetRemotePaste();
  rb().connectorId = null;
  rb().mode = null;
  rb().base = null;
  rb().stockageId = null;
  rb().stockageInfos = null;
  rb().view = null;
  rb().deadline = 0;
  rb().remoteClipboard = '';
}

/** Refaire une découverte depuis la fiche : une ligne ouverte depuis, par exemple. */
async function rediscover() {
  const box = $('modal-test-result');
  await runDiscovery(state.currentConnectorId, {
    progress: (message) => {
      box.className = 'test-result show loading';
      box.textContent = message;
    },
    failure: (message) => {
      box.className = 'test-result show fail';
      box.textContent = message;
    },
  });
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

function showProfilPage(name, el) {
  document.querySelectorAll('#view-profil .settings-nav-item[data-ppage]').forEach((i) => i.classList.remove('active'));
  if (el) el.classList.add('active');
  closeSettingsMenu();
  setSettingsMenuLabel('profil', navItemLabel(el));
  document.querySelectorAll('#view-profil .settings-page').forEach((p) => p.classList.remove('active'));
  $(`ppage-${name}`).classList.add('active');

  if (name === 'general') renderProfilGeneral();
  if (name === 'stockage') renderProfilStorage();
  if (name === 'fichiers') renderProfilFichiers();
  if (name === 'connecteurs') renderProfilConnList();
  if (name === 'permissions') { closePermDetail(); renderPermList(); }
  if (name === 'compte') renderDeletionZone();
  if (name === 'contact') renderMyTickets();
}

/** Bloc « Double authentification » du profil, cohérent avec la politique. */
function renderOwn2fa() {
  const twoFactor = state.me.twoFactor || { enabled: false, mode: 'disabled', canEnable: false };
  const badge = $('profil-2fa-badge');
  const toggle = $('profil-2fa-toggle');
  const desc = $('profil-2fa-desc');

  toggle.classList.toggle('on', twoFactor.enabled);
  // Grisé et non cliquable si l'administrateur a désactivé la 2FA — mais
  // toujours visible, pour que l'utilisateur comprenne pourquoi.
  const locked = !twoFactor.canEnable && !twoFactor.enabled;
  toggle.classList.toggle('disabled', locked);

  if (twoFactor.enabled) {
    badge.className = 'badge-pill green';
    badge.textContent = 'Activée';
    desc.textContent =
      'Application TOTP configurée. La désactiver demande votre mot de passe actuel.';
  } else if (locked) {
    badge.className = 'badge-pill gray';
    badge.textContent = 'Désactivé par l\'administrateur';
    desc.textContent =
      'La double authentification n\'est pas autorisée sur cette instance de crabe. ' +
      'Contactez l\'administrateur si vous souhaitez l\'utiliser.';
  } else {
    badge.className = 'badge-pill amber';
    badge.textContent = twoFactor.required ? 'Exigée — non configurée' : 'Désactivée';
    desc.textContent = twoFactor.required
      ? 'L\'administrateur exige la double authentification : activez-la pour sécuriser votre compte. ' +
        'Vous restez libre de vous connecter sans, mais l\'invitation reviendra.'
      : 'Ajoutez un code à usage unique en plus de votre mot de passe. ' +
        'Un premier code valide est exigé avant activation : impossible de vous enfermer dehors.';
  }
}

/**
 * Ce qui reste de « Figer mon accueil » dans le profil : le bouton d'accès.
 *
 * L'interrupteur lui-même a rejoint le panneau « Personnaliser l'accueil » au
 * lot 26 — c'est un réglage de disposition, il vit avec les autres. Le profil
 * garde le bouton qui y mène, et le grise quand l'administrateur a retiré la
 * personnalisation : sinon on ouvrirait un panneau qui ne sert plus à rien.
 */
function renderHomeLock() {
  const access = state.me.home || { adminAllowed: true, personalLock: false };
  const bouton = $('profil-home-open');
  if (bouton) {
    bouton.disabled = !access.adminAllowed;
    bouton.title = access.adminAllowed
      ? 'Blocs, disposition, et le verrou qui fige le tout'
      : 'La personnalisation de l\'accueil est désactivée par l\'administrateur';
  }
}

/**
 * Pose ou retire « Figer mon accueil », et REDESSINE ce qui en dépend.
 *
 * ─── Le défaut du lot 26, et ce qui le rendait invisible à la relecture ──────
 *
 * Poser la variable ne suffit pas : il faut relancer les rendus qui la lisent.
 * `home.access.canCustomize` commande deux choses, et deux seulement — les
 * poignées de déplacement et les sélecteurs de largeur de la GRILLE
 * (`renderHomeWidgets`), et les cases, les flèches et la note du PANNEAU
 * (`renderHomePanel`). Aucun des deux ne se relançait ici.
 *
 * Tant que l'interrupteur vivait dans Profil → Général, personne ne le voyait :
 * on quittait le profil pour revenir à l'accueil, et ce retour redessinait tout.
 * Le lot 26 a déplacé l'interrupteur DANS le panneau — on ne quitte plus rien,
 * et l'accueil restait donc modifiable après avoir été figé, jusqu'à ce qu'on
 * ferme puis rouvre le panneau.
 *
 * Mesuré dans un vrai navigateur : après le clic, les six blocs restaient
 * déplaçables, l'interrupteur ne basculait même pas et le badge affichait
 * toujours « Accueil modifiable ». Seul le message de confirmation apparaissait
 * — et le serveur, lui, avait bien enregistré le verrou dès le premier clic.
 * L'écran mentait, pas la base.
 *
 * `home.data` peut être nul : ce panneau appartient à l'accueil, mais rien
 * n'interdit d'arriver ici avant le premier chargement de `/api/home`.
 */
async function toggleHomeLock() {
  const access = state.me.home || {};
  if (!access.adminAllowed) {
    return void showToast('La personnalisation de l\'accueil est désactivée par l\'administrateur.');
  }
  try {
    const { user } = await api('/auth/profile', {
      method: 'PATCH',
      body: { homeLocked: !access.personalLock },
    });
    state.me = user;
    home.access = user.home;
    renderHomeLock();
    renderCustomizeButton();
    if (home.data) {
      renderHomeWidgets();
      renderHomePanel();
    }
    showToast(user.home.personalLock ? 'Accueil figé' : 'Accueil de nouveau modifiable');
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * Être prévenu quand crabe a quelque chose à dire (lot 26, refondu au lot 66).
 *
 * ─── Pourquoi cet écran a été refait ─────────────────────────────────────────
 *
 * Il promettait « votre navigateur vous demandera l'autorisation la première
 * fois », et le navigateur n'a jamais rien demandé. Mesuré au lot 66 dans
 * Firefox 153 et Chromium 151 : sur une adresse en `http://`, `isSecureContext`
 * vaut faux et `Notification.permission` vaut **« refusée » dès le premier
 * instant**. L'ancien code ne demandait l'autorisation que si la permission
 * valait « jamais demandée » — condition qui n'était jamais vraie. Personne
 * n'était en faute : la question ne pouvait tout simplement pas être posée.
 *
 * Un écran qui promet ce qu'il ne peut pas tenir est pire qu'un écran muet :
 * on attend, et on n'apprend rien. Celui-ci dit donc l'état RÉEL de chaque
 * canal, et ce qu'il faudrait faire pour le lever — y compris quand le geste
 * n'appartient pas à crabe.
 *
 * ─── Ce que chaque canal vaut vraiment, dit sans détour ──────────────────────
 *
 * L'e-mail est la voie fiable : c'est la seule qui atteigne quelqu'un qui n'a
 * pas crabe ouvert. Il est activé par défaut, parce qu'un connecteur peut
 * tomber en panne et le rester des mois sans que personne ne s'en aperçoive.
 *
 * La notification du navigateur est un COMPLÉMENT : crabe n'a pas de
 * notification poussée, elle ne peut donc apparaître que si une page de crabe
 * est ouverte au moment où l'échec est relevé. La présenter comme une
 * surveillance serait un mensonge — quelqu'un pourrait s'y fier et rater
 * exactement ce qu'il voulait savoir.
 */

/**
 * L'état réel de la permission du navigateur — mesuré, jamais supposé.
 *
 * Quatre états, et un seul d'entre eux se rattrape depuis crabe :
 *
 *   - `absente`     : ce navigateur ne connaît pas les notifications ;
 *   - `non-securise`: l'adresse n'est pas un contexte sûr. Les navigateurs
 *     réservent les notifications à `https://` et à `localhost` ; sur `http://`
 *     ils refusent AVANT de poser la question. Rien dans crabe ne peut le
 *     lever ;
 *   - `a-demander`  : jamais demandée. C'est le seul cas où un bouton sert ;
 *   - `accordee` / `refusee` : la personne a déjà répondu. Un refus ne se
 *     redemande pas — les navigateurs l'interdisent, il faut passer par leurs
 *     réglages.
 *
 * @returns {'absente'|'non-securise'|'a-demander'|'accordee'|'refusee'}
 */
function etatPermissionNavigateur() {
  if (typeof Notification === 'undefined') return 'absente';
  // L'ordre compte : sur une origine non sûre la permission vaut déjà
  // « refusée », et conclure au refus ferait accuser les réglages du
  // navigateur pour un problème d'adresse.
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'non-securise';
  if (Notification.permission === 'granted') return 'accordee';
  if (Notification.permission === 'denied') return 'refusee';
  return 'a-demander';
}

/** Ce canal peut-il réellement délivrer quelque chose, ici et maintenant ? */
function canauxUtilisables() {
  const reglages = prefs.values || {};
  const emailVoulu = reglages['notifications.echecs.email'] !== false;
  const navigateurVoulu = reglages['notifications.echecs.navigateur'] === true;
  const permission = etatPermissionNavigateur();
  return {
    emailVoulu,
    navigateurVoulu,
    permission,
    emailPossible: emailVoulu && !!state.smtpConfigured && !!state.me?.email,
    navigateurPossible: navigateurVoulu && permission === 'accordee',
  };
}

function renderNotificationsReglage() {
  const zone = $('profil-notifications');
  if (!zone) return;
  const c = canauxUtilisables();

  // ─── La phrase la plus utile de l'écran ──────────────────────────────────
  // Deux interrupteurs allumés ne prouvent rien : ce qui compte est de savoir
  // si quelque chose peut ARRIVER. Quand la réponse est non, elle se dit en
  // premier, et elle dit lequel des deux canaux rattraper.
  let verdict = '';
  if (!c.emailPossible && !c.navigateurPossible) {
    const cause = !c.emailVoulu
      ? 'l\'envoi par e-mail est éteint ci-dessous'
      : !state.smtpConfigured
        ? 'aucun serveur d\'envoi n\'est configuré sur cette installation'
        : !state.me?.email
          ? 'aucune adresse e-mail n\'est renseignée sur ce compte'
          : 'l\'envoi par e-mail est indisponible';
    verdict = `
      <div class="notif-verdict notif-verdict-ko" role="status">
        <strong>Aujourd'hui, aucune notification ne peut vous parvenir.</strong>
        Par e-mail : ${cause}. Par notification du navigateur :
        ${phrasePermissionCourte(c.permission)}
      </div>`;
  } else {
    const voies = [];
    if (c.emailPossible) voies.push(`par e-mail à ${esc(state.me.email)}`);
    if (c.navigateurPossible) voies.push('par notification du navigateur');
    verdict = `
      <div class="notif-verdict notif-verdict-ok" role="status">
        Vous serez prévenu ${voies.join(' et ')}.
      </div>`;
  }

  zone.innerHTML = `
    <div class="profil-label">Être prévenu quand crabe a quelque chose à dire</div>
    <div class="profil-desc">
      Trois moments, pas trente : une récupération <strong>automatique</strong> qui échoue,
      une série de récupérations lancée à la main qui se termine, et un renommage des
      documents qui se termine. Rien pour une récupération réussie lancée depuis cet
      écran — son résultat est déjà sous vos yeux. Si plusieurs services échouent au même
      passage, vous recevez un seul message avec la liste.
    </div>
    ${verdict}
    <div class="notif-canal">
      <span class="notif-canal-label">Par e-mail</span>
      <div class="toggle ${c.emailVoulu ? 'on' : ''}" role="switch"
           aria-checked="${c.emailVoulu ? 'true' : 'false'}" aria-label="Être prévenu par e-mail"
           onclick="basculerNotification('email', ${!c.emailVoulu})"><div class="knob"></div></div>
    </div>
    <div class="profil-desc">${etatEmailHtml(c)}</div>
    <div class="notif-canal">
      <span class="notif-canal-label">Par notification du navigateur</span>
      <div class="toggle ${c.navigateurVoulu ? 'on' : ''}" role="switch"
           aria-checked="${c.navigateurVoulu ? 'true' : 'false'}"
           aria-label="Être prévenu par notification du navigateur"
           onclick="basculerNotification('navigateur', ${!c.navigateurVoulu})"><div class="knob"></div></div>
    </div>
    <div class="profil-desc">${etatNavigateurHtml(c)}</div>`;
}

/** L'état du canal e-mail, en une phrase qui dit quoi faire. */
function etatEmailHtml(c) {
  if (!c.emailVoulu) {
    return 'Éteint : aucun message ne partira. C\'est pourtant la seule voie qui vous '
      + 'atteigne quand crabe n\'est pas ouvert.';
  }
  if (!state.smtpConfigured) {
    return '<strong>Aucun serveur d\'envoi n\'est configuré sur cette installation</strong> : '
      + 'rien ne peut partir. Demandez-le à votre administrateur — cela se règle dans '
      + 'Paramètres → SMTP.';
  }
  if (!state.me?.email) {
    return '<strong>Aucune adresse e-mail n\'est renseignée sur ce compte</strong> : '
      + 'renseignez-la ci-dessus, sinon rien ne peut partir.';
  }
  return `Les messages partiront à ${esc(state.me.email)}.`;
}

/** Le refus, en quelques mots, pour le verdict d'en-tête. */
function phrasePermissionCourte(permission) {
  return {
    absente: 'ce navigateur ne sait pas les afficher',
    'non-securise': 'impossible sur une adresse en http://',
    'a-demander': 'l\'autorisation n\'a pas encore été demandée',
    refusee: 'votre navigateur les a refusées',
    accordee: 'l\'interrupteur ci-dessous est éteint',
  }[permission] || 'indisponible';
}

/**
 * L'état du canal navigateur, en toutes lettres — et le bouton QUAND il sert.
 *
 * L'autorisation ne se demande jamais au chargement de la page : les
 * navigateurs modernes refusent une demande qui ne suit pas un geste, et une
 * question surgie toute seule est de toute façon une question à laquelle on
 * répond « non ». D'où un bouton, et seulement dans le cas où il peut aboutir.
 */
function etatNavigateurHtml(c) {
  const commun = 'En complément de l\'e-mail, jamais à sa place : cette notification ne peut '
    + 'apparaître que si crabe est ouvert dans un onglet au moment où l\'événement est '
    + 'constaté.';

  if (c.permission === 'non-securise') {
    return `${commun}<br>
      <strong>Sur cette adresse, elles ne peuvent pas fonctionner.</strong>
      Vous ouvrez crabe en <code>http://</code>, et les navigateurs réservent les
      notifications aux adresses sécurisées (<code>https://</code>) ainsi qu'à
      <code>localhost</code> : votre navigateur refuse <em>avant même</em> de vous poser la
      question — c'est pourquoi il ne vous a jamais rien demandé. Ce n'est pas un défaut de
      crabe, et rien dans crabe ne peut le lever : il faudrait que l'adresse de crabe soit
      servie en <code>https://</code>, ce qui se règle sur la passerelle qui la publie.
      En attendant, l'e-mail reste la voie qui fonctionne.`;
  }
  if (c.permission === 'absente') {
    return `${commun}<br><strong>Ce navigateur ne sait pas afficher de notifications</strong> :
      l'interrupteur ci-dessus restera sans effet.`;
  }
  if (c.permission === 'refusee') {
    return `${commun}<br>
      <strong>Votre navigateur a refusé les notifications pour ce site.</strong>
      crabe ne peut plus vous le redemander — les navigateurs l'interdisent une fois qu'on a
      répondu. Pour revenir dessus : ouvrez les réglages du site dans votre navigateur
      (le cadenas ou l'icône à gauche de l'adresse), remettez « Notifications » sur
      « Demander », puis revenez ici.`;
  }
  if (c.permission === 'accordee') {
    return `${commun}<br>Autorisation <strong>accordée</strong> pour ce site.${
      c.navigateurVoulu ? '' : ' Allumez l\'interrupteur ci-dessus pour vous en servir.'
    }`;
  }
  // 'a-demander' : le seul cas où un bouton peut aboutir.
  return `${commun}<br>
    L'autorisation <strong>n'a jamais été demandée</strong> à votre navigateur.
    <button class="profil-btn" style="margin-top:8px;"
            onclick="demanderAutorisationNotifications(this)">Autoriser les notifications</button>`;
}

/**
 * Demande l'autorisation au navigateur — sur un geste, et sur un geste seul.
 *
 * Ne touche à aucun réglage : allumer l'interrupteur reste un choix distinct.
 * Quelle que soit la réponse, l'écran est redessiné pour dire l'état réel.
 */
async function demanderAutorisationNotifications(bouton) {
  if (etatPermissionNavigateur() !== 'a-demander') return void renderNotificationsReglage();
  if (bouton) bouton.disabled = true;
  try {
    await Notification.requestPermission();
  } catch {
    // Un navigateur qui refuse jusqu'à la question : l'état relu ci-dessous
    // dira ce qu'il en est, sans que crabe ait à le deviner.
  }
  renderNotificationsReglage();
  const etat = etatPermissionNavigateur();
  showToast(
    etat === 'accordee'
      ? 'Notifications autorisées par votre navigateur.'
      : etat === 'refusee'
        ? 'Votre navigateur a refusé. Rouvrez l\'autorisation dans ses réglages de site.'
        : 'Aucune réponse du navigateur.'
  );
}

/** Change un canal de notification, et le confirme. */
async function basculerNotification(canal, valeur) {
  const cle = canal === 'email' ? 'notifications.echecs.email' : 'notifications.echecs.navigateur';

  // L'autorisation se demande AVANT d'enregistrer, et le clic sur
  // l'interrupteur EST le geste que les navigateurs exigent. On ne la demande
  // que si elle peut aboutir : sur une adresse non sûre, `requestPermission()`
  // rend « refusée » sans rien afficher, et l'interrupteur resterait allumé
  // sur rien du tout — ce que l'aide dit désormais en toutes lettres.
  if (canal === 'navigateur' && valeur && etatPermissionNavigateur() === 'a-demander') {
    try {
      await Notification.requestPermission();
    } catch {
      // L'aide sous l'interrupteur expliquera pourquoi rien n'apparaît.
    }
  }

  try {
    const res = await api('/users/me/preferences', {
      method: 'PUT',
      body: { preferences: { [cle]: valeur } },
    });
    prefs.values = res.preferences || prefs.values;
    renderNotificationsReglage();
    showToast(valeur ? 'Notification activée.' : 'Notification désactivée.');
  } catch (err) {
    showToast(err.message);
  }
}

/**
 * Relève les échecs planifiés non vus, et les montre si le compte l'a demandé.
 *
 * ⚠ Le relevé se fait à l'ouverture d'un écran, pas en boucle : crabe n'a pas
 * de notification poussée, et interroger le serveur toutes les dix secondes
 * pour un événement qui survient une fois par nuit serait payer cher un
 * décalage de quelques minutes. C'est la limite du canal, elle est écrite dans
 * son aide.
 */
async function releverNotifications() {
  if (prefs.values?.['notifications.echecs.navigateur'] !== true) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    const { notifications: liste } = await api('/users/me/notifications');
    if (!liste?.length) return;

    for (const n of liste) {
      const detail = (n.items || []).map((i) => `${i.nom} — ${i.message}`).join('\n');
      // `tag` : deux relevés successifs de la même notification remplacent
      // l'ancienne au lieu d'en empiler une deuxième.
      new Notification(n.title, { body: detail.slice(0, 400), tag: `crabe-${n.id}` });
    }
    await api('/users/me/notifications/seen', {
      method: 'POST',
      body: { ids: liste.map((n) => n.id) },
    });
  } catch {
    // Une notification qui ne s'affiche pas ne doit jamais empêcher un écran
    // de se dessiner : on passe, la trace reste en base et « Suivi actions »
    // sur l'accueil montre le même échec.
  }
}

function renderProfilGeneral() {
  const { me, security, policy } = state;
  $('profil-username').textContent = me.username;
  $('profil-role').textContent = me.roleName;
  $('profil-email').textContent = me.email || 'Aucune adresse renseignée';
  $('profil-phone').value = me.phone || '';
  $('profil-password-rule').textContent = policy.passwordRules;
  applyAvatar();
  renderOwn2fa();
  renderHomeLock();
  renderNotificationsReglage();
  // Le nombre de lignes par page a quitté cet écran au lot 20 : il est devenu
  // un réglage PAR BLOC, et sa place est là où l'on règle déjà les blocs —
  // dans « Personnaliser l'accueil ». Deux endroits pour régler la même page,
  // c'est un de trop.
  renderEmailPending();

  $('profil-avatar-note').textContent = fmt.settings.gravatarEnabled
    ? 'Gravatar est autorisé par l\'administrateur : si votre adresse e-mail a un avatar, il est utilisé. Sinon, vos initiales colorées.'
    : 'Gravatar est désactivé par l\'administrateur : vos initiales colorées sont utilisées, aucune requête ne sort du réseau local.';

  const items = [
    {
      icon: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
      green: security.twoFactor,
      label: 'Double authentification',
      value: security.twoFactor
        ? 'Activée'
        : security.twoFactorMode === 'disabled'
          ? 'Désactivée par l\'administrateur'
          : 'Désactivée',
    },
    {
      icon: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
      green: true,
      label: 'Politique de mot de passe',
      value: policy.passwordComplexity === 'high' ? 'Forte' : policy.passwordComplexity === 'medium' ? 'Moyenne' : 'Faible',
    },
    {
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      green: false,
      label: 'Dernière connexion',
      value: security.lastLogin
        ? `${fmt.relative(security.lastLogin.date)} · ${security.lastLogin.ip}`
        : 'Première connexion',
    },
    {
      icon: '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M9 21h6"/>',
      green: false,
      label: 'Appareil actuel',
      value: security.currentDevice,
    },
  ];

  $('security-block').innerHTML = items
    .map(
      (item) => `
    <div class="sec-item">
      <div class="sec-item-icon ${item.green ? 'green' : ''}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${item.icon}</svg>
      </div>
      <div class="sec-item-body">
        <div class="sec-item-label">${esc(item.label)}</div>
        <div class="sec-item-val">${esc(item.value)}</div>
      </div>
    </div>`
    )
    .join('');
}

async function saveProfilField(field, value) {
  try {
    const { user } = await api('/auth/profile', { method: 'PATCH', body: { [field]: value } });
    state.me = user;
    showToast('Profil mis à jour');
  } catch (err) {
    showToast(err.message);
  }
}

function openAvatarPicker() {
  const palette = ['#e0693a', '#4caf7d', '#5b9bd8', '#6c5ce7', '#e0a83a', '#c8102e', '#00a0af'];
  openGenericModal({
    title: "Couleur de l'avatar",
    sub: fmt.settings.gravatarEnabled
      ? 'Gravatar prime s\'il existe pour votre adresse ; sinon, ces initiales colorées.'
      : 'Les initiales de votre identifiant sont utilisées comme image.',
    body: `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 4px;">
      ${palette
        .map(
          (color) =>
            `<button type="button" data-color="${color}" class="avatar-swatch"
               style="width:38px;height:38px;border-radius:50%;border:2px solid var(--border-strong);background:${color};"></button>`
        )
        .join('')}
    </div>`,
    actions: [{ label: 'Fermer', class: 'btn-secondary', onClick: closeGenericModal }],
  });

  document.querySelectorAll('.avatar-swatch').forEach((swatch) => {
    swatch.onclick = async () => {
      await saveProfilField('avatarColor', swatch.dataset.color);
      applyAvatar();
      closeGenericModal();
    };
  });
}

/**
 * Pose l'avatar (Gravatar ou initiales) partout où il apparaît.
 * Chaque conteneur est réécrit entièrement : aucune fonction ne doit dépendre
 * d'un élément interne, il n'existe plus après le premier appel.
 */
function applyAvatar() {
  const { me } = state;
  for (const [id, size] of [
    ['tb-avatar', 34],
    ['home-avatar', 52],
    ['profil-avatar', 64],
  ]) {
    const el = $(id);
    if (el) el.innerHTML = avatarHtml(me, { size });
  }
}

/**
 * Page « Stockage » du profil.
 *
 * Grand chiffre = ce que les documents du compte pèsent — une seule valeur,
 * parce que chaque destination en reçoit une copie complète et identique.
 * L'espace disponible ne s'affiche que là où il est vrai : destination par
 * destination, mesuré et daté. Jusqu'au lot 59 cette page additionnait les
 * capacités d'un NAS et de deux clouds en un faux total commun (« sur
 * 4.89 To », « 31.4 % occupé ») : plus aucun cumul, plus aucun pourcentage
 * global — moins de chiffres, plus de sens.
 */
async function renderProfilStorage() {
  const usage = await api('/connectors/me/storage');
  $('my-storage-quota').innerHTML = quotaCard(usage) + quotaSplit(usage) + choixDestinations(usage);
  $('my-storage-rows').innerHTML = `
    <div class="storage-row"><div class="storage-row-name">Factures récupérées ce mois-ci</div><div class="storage-row-val">${usage.filesThisMonth} document(s)</div></div>
    <div class="storage-row"><div class="storage-row-name">Total de factures stockées</div><div class="storage-row-val">${usage.files} document(s)</div></div>
    <div class="storage-row"><div class="storage-row-name">Dernière synchronisation</div><div class="storage-row-val">${esc(fmt.relative(usage.lastFetchAt))}</div></div>`;
}

/**
 * Page « Fichiers » du profil (lot 56).
 *
 * Le nom des documents déposés est un RÉGLAGE : deux conventions, deux blocs,
 * et le choix se comprend sans documentation — chaque bloc montre un exemple
 * et des chiffres MESURÉS sur les documents du compte, jamais estimés.
 *
 * Changer de convention ne renomme rien tout seul : le réglage décrit ce que
 * crabe produira pour les PROCHAINS documents. L'harmonisation de l'existant
 * est un geste séparé, plus bas sur la même page — et tant qu'il n'est pas
 * fait, la page dit le mélange plutôt que de le laisser découvrir sur le
 * stockage.
 */
async function renderProfilFichiers() {
  const data = await api('/users/me/fichiers');
  const active = data.convention;
  const h = data.harmonisation || {};

  $('fichiers-conventions').innerHTML = `
    <div class="convention-grid">
      ${data.conventions
        .map((c) => {
          const mesure = data.mesures[c.id] || { total: 0, conformes: 0, aRenommer: 0 };
          const estActive = c.id === active;
          return `
      <div class="convention-card ${estActive ? 'active' : ''}">
        <div class="convention-head">
          <div class="convention-title">${esc(c.titre)}</div>
          ${estActive ? '<span class="badge-pill green">Activé</span>' : ''}
        </div>
        <div class="convention-exemple"><code>${esc(c.exemple)}</code></div>
        <div class="convention-desc">${esc(c.description)}</div>
        <div class="convention-mesure">
          ${fmt.number(mesure.conformes)} de vos ${fmt.number(mesure.total)} documents déposés
          portent déjà cette forme${mesure.aRenommer
            ? ` · ${fmt.number(mesure.aRenommer)} seraient à renommer`
            : ''}.
        </div>
        <button class="btn-primary" ${estActive || h.running ? 'disabled' : ''}
                onclick="choisirConvention('${esc(c.id)}', '${esc(c.titre)}')">Appliquer</button>
      </div>`;
        })
        .join('')}
    </div>
    <div class="sec-note" style="margin-top:14px;">
      Changer de convention ne renomme pas les documents déjà déposés : elle vaut pour les
      prochains. Pour aligner l'existant, lancez le renommage ci-dessous — sinon, les deux
      formes cohabiteront dans vos dossiers.
    </div>`;

  $('fichiers-harmonisation').innerHTML = blocHarmonisation(data);

  // Pendant qu'un chantier tourne, la page se rafraîchit toute seule — mais
  // seulement tant qu'elle est encore celle qu'on regarde.
  if (h.running) {
    setTimeout(() => {
      if ($('ppage-fichiers').classList.contains('active')) renderProfilFichiers().catch(() => {});
    }, 2500);
  }
}

/** Le bloc « Renommer les documents déjà déposés » : état, refus, progression. */
function blocHarmonisation(data) {
  const h = data.harmonisation || {};
  const journal = h.journal || {};
  const plan = data.plan || { aRenommer: 0, mouvements: 0, douteux: [], collisions: [] };
  const bloquants = plan.douteux.length + plan.collisions.length;

  let etatHtml = '';
  if (h.running) {
    const ou = h.total ? ` — ${fmt.number(h.faites)} sur ${fmt.number(h.total)}` : '';
    etatHtml = `
      <div class="sec-note" style="margin-top:12px;">
        <b>${h.phase === 'annulation' ? 'Annulation en cours' : 'Renommage en cours'}${ou}.</b><br>
        ${esc(h.message || '')}
        ${h.ligneEnCours ? `<br>Document en cours : <code>${esc(h.ligneEnCours)}</code>` : ''}
        ${h.ecartees ? `<br>${fmt.number(h.ecartees)} document(s) écarté(s) : ils ont changé pendant l'opération et seront re-mesurés au prochain lancement.` : ''}
      </div>`;
  } else if (h.refus) {
    etatHtml = `<div class="sec-note" style="margin-top:12px;color:var(--amber);">Le renommage n'a pas démarré : ${esc(h.refus)}</div>`;
  } else if (h.arret) {
    etatHtml = `<div class="sec-note" style="margin-top:12px;color:var(--red);">${esc(h.arret)}</div>`;
  } else if (journal.interrompu) {
    etatHtml = `
      <div class="sec-note" style="margin-top:12px;color:var(--amber);">
        Un renommage a été interrompu (${fmt.number(journal.lignesFinies)} document(s) déjà
        renommés, notés au journal). Rien n'est perdu : « Renommer maintenant » reprend où il
        en était, « Tout annuler » remet chaque document sous son ancien nom.
      </div>`;
  } else if (h.message && h.termineLe) {
    etatHtml = `<div class="sec-note" style="margin-top:12px;">${esc(h.message)}</div>`;
  }

  const casHtml = bloquants
    ? `
      <div class="sec-note" style="margin-top:12px;color:var(--amber);">
        ${plan.douteux.length ? `${fmt.number(plan.douteux.length)} document(s) dont le nom ne se laisse pas dériver — ils ne seront jamais renommés automatiquement :` : ''}
        ${plan.douteux.slice(0, 10).map((d) => `<br><code>${esc(d.filename)}</code> — ${esc(d.motif)}`).join('')}
        ${plan.douteux.length > 10 ? `<br>… et ${fmt.number(plan.douteux.length - 10)} autre(s).` : ''}
        ${plan.collisions.length ? `<br>${fmt.number(plan.collisions.length)} collision(s) : deux documents aboutiraient au même nom dans le même dossier.` : ''}
        <br>Le renommage ne démarrera pas tant qu'il en reste un seul.
      </div>`
    : '';

  return `
    <div class="block-head" style="margin-top:26px;">
      <div>
        <div class="block-title">Renommer les documents déjà déposés</div>
        <div class="block-sub">Aligne l'existant sur la convention choisie — sur chaque destination, puis dans crabe</div>
      </div>
    </div>
    <div class="sec-note">
      ${plan.aRenommer
        ? `${fmt.number(plan.aRenommer)} document(s) seraient renommés, soit ${fmt.number(plan.mouvements)} mouvement(s) de fichiers
           sur vos destinations. Avant de commencer, crabe fait une sauvegarde de sa base et vérifie que chaque
           destination répond ; le moindre imprévu arrête tout net, et l'opération se reprend là où elle en était.`
        : 'Tous vos documents portent déjà la convention choisie — il n\'y a rien à renommer.'}
    </div>
    ${casHtml}
    ${etatHtml}
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn-primary" style="width:auto;padding:11px 18px;"
              ${h.running || bloquants || (!plan.aRenommer && !journal.interrompu) ? 'disabled' : ''}
              onclick="lancerHarmonisation(${plan.aRenommer}, ${plan.mouvements})">Renommer maintenant</button>
      ${journal.annulable && !h.running
        ? `<button class="btn-mini danger" style="padding:11px 18px;font-size:13px;"
                   onclick="annulerHarmonisation(${journal.gestes})">Tout annuler — remettre les anciens noms</button>`
        : ''}
    </div>`;
}

/** « Appliquer » sur l'autre convention : confirmation explicite, puis réglage. */
async function choisirConvention(id, titre) {
  if (!confirm(
    `Nommer les prochains documents « ${titre.toLowerCase()} » ?\n\n`
    + 'Les documents déjà déposés gardent leur nom actuel : pour les aligner, il faudra '
    + 'lancer le renommage depuis cette page.'
  )) return;
  try {
    await api('/users/me/preferences', {
      method: 'PUT',
      body: { preferences: { 'fichiers.convention': id } },
    });
    showToast(`Convention appliquée : les prochains documents seront nommés ${titre.toLowerCase()}.`);
  } catch (err) {
    showToast(err.message);
  }
  renderProfilFichiers().catch(() => {});
}

/** Lance (ou reprend) le renommage de l'existant — après confirmation. */
async function lancerHarmonisation(aRenommer, mouvements) {
  if (!confirm(
    `Renommer ${aRenommer} document(s) déjà déposés (${mouvements} mouvement(s) de fichiers sur vos destinations) ?\n\n`
    + 'crabe sauvegarde d\'abord sa base et vérifie que chaque destination répond. '
    + 'L\'opération peut être annulée ensuite depuis cette page.'
  )) return;
  try {
    await api('/users/me/fichiers/harmonisation', { method: 'POST' });
  } catch (err) {
    showToast(err.message);
  }
  renderProfilFichiers().catch(() => {});
}

/** Rejoue le journal à l'envers : chaque document retrouve son ancien nom. */
async function annulerHarmonisation(gestes) {
  if (!confirm(
    `Annuler le renommage : rejouer ${gestes} geste(s) à l'envers pour remettre chaque `
    + 'document sous son ancien nom ?'
  )) return;
  try {
    await api('/users/me/fichiers/harmonisation/annulation', { method: 'POST' });
  } catch (err) {
    showToast(err.message);
  }
  renderProfilFichiers().catch(() => {});
}

/**
 * Chiffres du haut : le poids des documents du compte, et rien d'autre.
 *
 * Pas de « sur X To » ni de « % occupé au total » : les destinations sont des
 * espaces séparés (un NAS, des clouds) qui reçoivent chacun la MÊME copie —
 * les additionner fabriquait un réservoir commun qui n'existe pas. L'espace
 * encore libre, lui, est vrai destination par destination : c'est la
 * répartition juste en dessous qui le porte, mesuré et daté.
 */
function quotaCard(usage) {
  const nb = (usage.destinations || []).length;
  const copie = nb > 1
    ? `Chacune de vos ${nb} destinations en garde une copie complète — l'espace encore libre de chacune est indiqué ci-dessous.`
    : 'Votre destination en garde la copie complète — son espace encore libre est indiqué ci-dessous.';

  return `
    <div class="quota-head">
      <div class="quota-used">${esc(fmt.bytes(usage.bytes))}</div>
      <div class="quota-of">${usage.files > 1 ? `vos ${fmt.number(usage.files)} documents` : 'vos documents'}</div>
    </div>
    <div class="quota-note">${esc(copie)}</div>`;
}

/** Répartition par destination active : une ligne, une part. */
function quotaSplit(usage) {
  const cards = usage.destinations || [];
  if (!cards.length) return '';

  return `
    <div class="quota-split">
      <div class="quota-split-title">Répartition par destination active</div>
      ${cards
        .map((d) => {
          const part = usage.bytes > 0 ? Math.round((d.bytes / usage.bytes) * 100) : 0;
          // « (mesuré il y a 3 min) » : la valeur est gardée quelques minutes
          // (lot 54), l'écran le dit plutôt que de la présenter comme
          // instantanée.
          const datee = d.space?.measuredAt ? ` (mesuré ${fmt.relative(d.space.measuredAt)})` : '';
          const libre = d.space?.known
            ? `${fmt.bytes(d.space.freeBytes)} disponibles${datee}`
            : `capacité inconnue — ${d.space?.reason || 'mesure indisponible'}${datee}`;
          return `
        <div class="quota-dest">
          <div class="quota-dest-icon" style="background:${esc(d.color)};">${esc(d.letter)}${logoHtml(d)}</div>
          <div class="quota-dest-main">
            <div class="quota-dest-name">${esc(d.name)}</div>
            <div class="quota-dest-sub">${d.files} document(s) · ${esc(libre)}</div>
          </div>
          <div class="quota-dest-val">${esc(fmt.bytes(d.bytes))}${
            usage.bytes > 0 ? ` · ${part} %` : ''
          }</div>
        </div>`;
        })
        .join('')}
    </div>`;
}

/**
 * « Où vont vos documents » — le choix des destinations, par compte (lot 24).
 *
 * ─── Ce que cet écran doit dire, et qu'aucun interrupteur ne dit seul ────────
 *
 * Jusqu'ici, chaque document partait vers TOUTES les destinations activées, et
 * personne n'avait son mot à dire. Ce bloc rend le choix — mais un choix mal
 * expliqué serait pire que pas de choix du tout, parce qu'il fait disparaître
 * des copies sans qu'on s'en aperçoive. Trois choses sont donc écrites :
 *
 *   - la destination principale ne se refuse pas, et pourquoi ;
 *   - décocher n'efface RIEN de ce qui est déjà là-bas ;
 *   - ce qui ne partira plus, ce sont les documents à venir.
 *
 * Ce qui n'apparaît pas ici : les destinations que l'administrateur n'a pas
 * activées. Elles n'existent pour personne, et proposer de choisir parmi elles
 * ferait espérer un rangement qui n'arrivera jamais.
 */
function choixDestinations(usage) {
  const cards = usage.destinations || [];
  const optionnelles = cards.filter((d) => !d.obligatoire);
  if (!optionnelles.length) return '';

  const ligne = (d) => `
    <label class="dest-choice ${d.obligatoire ? 'fixed' : ''}">
      <input type="checkbox" ${d.choisie ? 'checked' : ''} ${d.obligatoire ? 'disabled' : ''}
             onchange="basculerDestination('${esc(d.id)}', this.checked)">
      <span class="dest-choice-icon" style="background:${esc(d.color)};">${esc(d.letter)}${logoHtml(d)}</span>
      <span class="dest-choice-main">
        <span class="dest-choice-name">${esc(d.name)}</span>
        <span class="dest-choice-sub">${
          d.obligatoire
            ? 'Destination principale — elle reçoit toujours vos documents.'
            : d.choisie
              ? 'Reçoit une copie de chaque nouveau document.'
              : 'Ne reçoit plus rien de nouveau. Ce qui y est déjà y reste.'
        }</span>
      </span>
    </label>`;

  return `
    <div class="quota-split">
      <div class="quota-split-title">Où vont vos documents</div>
      <div class="field-help" style="margin-bottom:10px;">
        Chaque nouveau document est copié sur les destinations cochées ici. Décocher
        n'efface rien : les documents déjà déposés restent en place, seuls les
        suivants cessent d'y aller. Vous pouvez recocher à tout moment, puis utiliser
        « Synchroniser » pour rattraper ce qui manque.
      </div>
      ${cards.filter((d) => d.obligatoire).map(ligne).join('')}
      ${optionnelles.map(ligne).join('')}
    </div>`;
}

/** Coche ou décoche une destination pour ce compte, et redessine. */
async function basculerDestination(id, choisie) {
  // La liste vit dans les préférences du compte, comme tous les réglages
  // mémorisés ; on la relit avant d'y toucher plutôt que d'en garder une copie
  // qui pourrait dater d'un autre onglet.
  const refusees = (prefs.values['destinations.desactivees'] || []).filter((x) => x !== id);
  const suivant = choisie ? refusees : [...refusees, id];
  prefs.values['destinations.desactivees'] = suivant;
  savePref('destinations.desactivees', suivant, (message) => showToast(message));
  await renderProfilStorage();
}

async function renderProfilConnList() {
  await loadConnectors();
  renderViewToggle('profil-connecteurs-view-switch', 'profil-connecteurs', 'setProfilConnView');
  const items = installedConnectors();
  const list = $('profil-conn-list');

  if (!items.length) {
    list.innerHTML = '<div class="empty-state">Aucun connecteur installé.</div>';
    return;
  }

  list.innerHTML =
    viewMode('profil-connecteurs') === 'cards'
      ? `<div class="card-grid">${items.map(installedCard).join('')}</div>`
      : items.map(installedRow).join('');
}

function setProfilConnView(mode) {
  setViewMode('profil-connecteurs', mode);
  renderProfilConnList();
}

/** La pastille d'état d'un connecteur installé, en carte comme en ligne. */
function installedBadge(c) {
  const dot = statusDot(c.status);
  const ton = dot === 'green' ? 'green' : dot === 'amber' ? 'amber' : 'red';
  return `<span class="badge-pill ${ton}">${esc(c.health?.title || statusLabel(c.status))}</span>`;
}

/** Les mêmes gestes des deux côtés : un seul endroit à corriger. */
function installedActions(c) {
  return `
    <button class="icon-btn" onclick="reconfigureConnector('${esc(c.id)}')">Reconfigurer</button>
    ${c.health?.canSync !== false
      ? `<button class="icon-btn" onclick="runConnectorNow('${esc(c.id)}', this)">Lancer maintenant</button>`
      : ''}`;
}

function installedRow(c) {
  return `
      <div class="installed-row">
        <div class="badge-logo" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
        <div class="ir-main">
          <div class="ir-name">${esc(c.name)}</div>
          <div class="ir-meta">Dernière exécution : ${esc(fmt.relative(c.lastRunAt))}</div>
        </div>
        ${installedBadge(c)}
        <div class="ir-actions">${installedActions(c)}</div>
      </div>`;
}

/**
 * Le ou les comptes d'un service, nommés.
 *
 * ─── La panne que ça corrige (lot 26) ────────────────────────────────────────
 *
 * Cette ligne affichait « — » pour TOUS les services, depuis toujours :
 * l'identifiant de compte n'était simplement jamais envoyé au client. Signalé
 * comme « le compte n'est pas bon » — et il ne l'était pas, il n'était pas là.
 *
 * Un service peut en porter plusieurs : Infomaniak en a trois, avec des
 * factures distinctes, et n'en montrer qu'un revenait à cacher les deux autres.
 * Le nom passe devant (« Koody »), l'identifiant suit (« 854637 ») : le premier
 * se reconnaît, le second tranche entre deux comptes qui se ressemblent et
 * nomme le dossier sur le stockage.
 *
 * `complet` rend la liste entière, pour l'infobulle : la carte, elle, s'arrête
 * à deux comptes et compte le reste, sinon la ligne déborderait.
 */
function libelleComptes(c, complet = false) {
  const comptes = (c.accounts || []).filter((a) => a.id && a.id !== 'defaut');
  if (!comptes.length) {
    // Aucun document rangé pour l'instant : on montre le compte enregistré à la
    // configuration, qui est déjà une réponse utile — ou rien, franchement.
    return c.accountId && c.accountId !== 'defaut' ? c.accountId : '—';
  }

  const nommer = (a) => (a.name ? `${a.name} · ${a.id}` : a.id);
  if (complet || comptes.length <= 2) return comptes.map(nommer).join(', ');
  return `${comptes.slice(0, 2).map(nommer).join(', ')} +${comptes.length - 2}`;
}

function installedCard(c) {
  return `
  <div class="app-card">
    <div class="app-card-head">
      <div class="badge-logo" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(c.name)}</div>
        <div class="app-card-sub">${esc(c.site || 'aucun site')}</div>
      </div>
      ${installedBadge(c)}
    </div>
    <div class="app-card-facts">
      <div><span class="fact-label">Dernière exécution</span>
        <span class="fact-value" title="${esc(fmt.exact(c.lastRunAt))}">${esc(fmt.relative(c.lastRunAt))}</span></div>
      <div><span class="fact-label">${c.accounts?.length > 1 ? 'Comptes' : 'Compte'}</span>
        <span class="fact-value" title="${esc(libelleComptes(c, true))}">${esc(libelleComptes(c))}</span></div>
    </div>
    <div class="app-card-actions">${installedActions(c)}</div>
  </div>`;
}

/**
 * Étapes d'une récupération : elle télécharge des PDF et les dépose sur chaque
 * destination, ce qui dure bien plus que deux secondes.
 */
const ETAPES_RECUPERATION = [
  { apres: 0, texte: 'Récupération…' },
  { apres: 5000, texte: 'Téléchargement…' },
  { apres: 20_000, texte: 'Presque fini…' },
];

async function runConnectorNow(id, button) {
  await actionLongue({
    bouton: button,
    etapes: ETAPES_RECUPERATION,
    afficher: (texte) => {
      if (button) button.innerHTML = `<span class="spinner"></span> ${esc(texte)}`;
    },
    executer: async () => {
      try {
        const result = await api(`/connectors/${id}/run`, { method: 'POST' });
        showToast(result.message);
        await renderProfilConnList();
      } catch (err) {
        showToast(err.message);
      }
    },
  });
}

/**
 * « Récupérer tout l'historique » — le rattrapage, en un geste (lot 32).
 *
 * Avant lui, rattraper un historique supposait de changer le réglage
 * « Historique » en « Toutes les années disponibles », lancer, puis remettre
 * le réglage : trois gestes techniques pour un public qui n'a pas à les
 * connaître. Ici : une confirmation qui dit ce qui va se passer, une
 * exécution, et le réglage n'est jamais touché.
 */
async function runConnectorHistorique(id, button) {
  const connector = state.connectors?.find?.((c) => c.id === id);
  const nom = connector?.name || 'ce service';

  const accepte = confirm(
    `Récupérer tout l'historique de ${nom} ?\n\n`
      + 'crabe va redemander au service tous les documents disponibles, pas seulement la '
      + 'période récente. Ce qui est déjà rangé n\'est pas re-téléchargé, rien n\'est '
      + 'supprimé, et votre réglage « Historique » reste tel quel.\n\n'
      + 'Selon l\'ancienneté de votre compte, cela peut représenter des dizaines de '
      + 'documents et prendre plusieurs minutes.'
  );
  if (!accepte) return;

  await actionLongue({
    bouton: button,
    etapes: ETAPES_RECUPERATION,
    afficher: (texte) => {
      if (button) button.innerHTML = `<span class="spinner"></span> ${esc(texte)}`;
    },
    executer: async () => {
      try {
        const result = await api(`/connectors/${id}/run-historique-complet`, { method: 'POST' });
        showToast(result.message);
        await renderProfilConnList();
      } catch (err) {
        showToast(err.message);
      }
    },
  });
}

function renderPermList() {
  renderViewToggle('profil-permissions-view-switch', 'profil-permissions', 'setProfilPermView');
  const items = installedConnectors();
  const el = $('perm-list');
  el.style.display = 'block';

  if (!items.length) {
    el.innerHTML = '<div class="empty-state">Aucun connecteur installé.</div>';
    return;
  }

  el.innerHTML =
    viewMode('profil-permissions') === 'cards'
      ? `<div class="card-grid">${items.map(permCard).join('')}</div>`
      : items.map(permRow).join('');
}

function setProfilPermView(mode) {
  setViewMode('profil-permissions', mode);
  renderPermList();
}

function permRow(c) {
  return `
    <div class="perm-row" onclick="openPermDetail('${esc(c.id)}')">
      <div class="badge-logo" style="width:34px;height:34px;font-size:12px;background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
      <div>
        <div class="perm-name">${esc(c.name)}</div>
        <div class="perm-count">${(c.permissions || []).length} permissions</div>
      </div>
      <svg class="perm-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </div>`;
}

function permCard(c) {
  return `
  <div class="app-card perm-card" onclick="openPermDetail('${esc(c.id)}')">
    <div class="app-card-head">
      <div class="badge-logo" style="background:${esc(c.color)};">${esc(c.letters)}${logoHtml(c)}</div>
      <div style="flex:1;min-width:0;">
        <div class="app-card-name">${esc(c.name)}</div>
        <div class="app-card-sub">${(c.permissions || []).length} permission(s)</div>
      </div>
      <svg class="perm-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </div>
  </div>`;
}

/**
 * Détail des permissions d'un connecteur.
 *
 * Bandeau d'abord (ce qui sort de crabe, et ce qui n'en sort pas), puis une
 * ligne par donnée : icône, nom, portée, et un dépliant qui dit concrètement
 * ce que CE connecteur fait de cette donnée. Les `<details>` natifs suffisent
 * — pas de JavaScript d'ouverture, et ça reste accessible au clavier.
 */
async function openPermDetail(id) {
  const { connector, permissions, note } = await api(`/connectors/${id}/permissions`);
  $('perm-list').style.display = 'none';
  const detail = $('perm-detail');
  detail.style.display = 'block';
  detail.innerHTML = `
    <div class="perm-back" onclick="closePermDetail()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      Permissions
    </div>
    <div class="perm-detail-head">
      <div class="badge-logo" style="background:${esc(connector.color)};">${esc(connector.letters)}${logoHtml(connector)}</div>
      <div style="font-size:17px;font-weight:500;">${esc(connector.name)}</div>
    </div>
    <div class="perm-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      <div><strong>Droit d'accès limité</strong><br>${esc(note)}</div>
    </div>
    ${permissions.map(permissionRow).join('')}`;
}

/** Une permission : ligne repliée, explication dépliable. */
function permissionRow(p) {
  return `
  <details class="perm-item">
    <summary class="perm-item-head">
      <span class="perm-item-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${p.icon || ''}</svg>
      </span>
      <span class="perm-item-body">
        <span class="perm-item-name">${esc(p.name)}</span>
        <span class="perm-item-scope">${esc(p.scopeLabel || p.scope)}</span>
      </span>
      <svg class="perm-item-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </summary>
    <div class="perm-item-detail">${esc(p.description || '')}</div>
  </details>`;
}

function closePermDetail() {
  $('perm-detail').style.display = 'none';
  $('perm-list').style.display = 'block';
}

// --- Compte : suppression ---------------------------------------------------

async function renderDeletionZone() {
  const { request, retentionDays } = await api('/users/me/deletion');
  const active = $('danger-zone-active');
  const pending = $('danger-zone-pending');

  $('danger-zone-desc').textContent =
    "Cette action envoie une demande à l'administrateur. Vos connecteurs sont désactivés dès traitement, " +
    `puis votre compte et vos données sont effacés définitivement ${retentionDays} jours après.`;

  active.style.display = request ? 'none' : 'block';
  pending.style.display = request ? 'block' : 'none';
  if (!request) return;

  const deadline = fmt.date(request.scheduledDeleteAt);
  $('danger-zone-status-text').textContent = request.revoked
    ? `Votre accès a été révoqué. Suppression définitive prévue le ${deadline}.`
    : request.wantsExport
      ? `Demande envoyée à l'administrateur, avec demande d'export de vos données. Votre accès sera révoqué puis votre compte supprimé définitivement le ${deadline}.`
      : `Demande envoyée à l'administrateur. Suppression définitive prévue le ${deadline}.`;

  $('cancel-deletion-btn').style.display = request.revoked ? 'none' : 'inline-block';
}

async function requestAccountDeletion() {
  if (!confirm('Confirmer la demande de suppression de votre compte ?')) return;
  try {
    await api('/users/me/deletion', {
      method: 'POST',
      body: { wantsExport: $('want-export').checked },
    });
    await renderDeletionZone();
    showToast("Demande de suppression envoyée à l'administrateur");
  } catch (err) {
    showToast(err.message);
  }
}

async function cancelAccountDeletion() {
  try {
    await api('/users/me/deletion', { method: 'DELETE' });
    await renderDeletionZone();
    showToast('Demande annulée');
  } catch (err) {
    showToast(err.message);
  }
}

// --- Nous contacter : support ----------------------------------------------

/** Badge d'un ticket : « Non lu » l'emporte sur le statut. */
function ticketBadge(ticket) {
  const map = {
    recu: 'gray',
    'en-cours': 'amber',
    repondu: 'green',
    ferme: 'gray',
  };
  const cls = ticket.unread ? 'blue' : map[ticket.status] || 'gray';
  return `<span class="badge-pill ${cls}">${esc(ticket.displayLabel || ticket.statusLabel)}</span>`;
}

/** Fil de conversation, réutilisé côté utilisateur et côté administration. */
function threadHtml(messages = []) {
  if (!messages.length) return '';
  return `<div class="thread">
    ${messages
      .map(
        (m) => `
      <div class="thread-msg ${m.author === 'admin' ? 'from-admin' : 'from-user'}">
        <div class="thread-meta">
          <strong>${esc(m.author === 'admin' ? m.username || 'Administration' : m.username || 'Vous')}</strong>
          <span title="${esc(fmt.exact(m.createdAt))}">${esc(fmt.dateTime(m.createdAt))}</span>
        </div>
        <div class="thread-body">${esc(m.body)}</div>
      </div>`
      )
      .join('')}
  </div>`;
}

async function submitTicket() {
  const subject = $('ticket-subject').value.trim();
  const message = $('ticket-message').value.trim();
  if (!subject || !message) return void showToast('Merci de remplir le sujet et le message');

  try {
    await api('/tickets', { method: 'POST', body: { subject, message } });
    $('ticket-subject').value = '';
    $('ticket-message').value = '';
    await renderMyTickets();
    showToast("Demande envoyée à l'administrateur");
  } catch (err) {
    showToast(err.message);
  }
}

async function renderMyTickets() {
  const { tickets } = await api('/tickets/mine');
  const el = $('my-tickets');

  el.innerHTML = tickets.length
    ? tickets
        .map(
          (t) => `
      <div class="ticket-item" style="cursor:default;">
        <div class="ticket-item-top">
          <div class="ticket-subject">${esc(t.subject)}</div>
          ${ticketBadge(t)}
          <button class="btn-mini danger" onclick="hideMyTicket(${t.id}, event)"
                  title="Retire la demande de votre historique ; l'administration en conserve la trace">
            Supprimer
          </button>
        </div>
        <div class="ticket-meta">
          Ouverte ${esc(fmt.relative(t.createdAt))}
          <span title="${esc(fmt.exact(t.createdAt))}">· ${esc(fmt.dateTime(t.createdAt))}</span>
        </div>
        ${threadHtml(t.messages)}
        <div class="thread-reply">
          <textarea id="reply-${t.id}" placeholder="Ajouter un message à cette demande…"></textarea>
          <button class="btn-mini" onclick="replyToMyTicket(${t.id})">Envoyer</button>
        </div>
      </div>`
        )
        .join('')
    : '<div class="empty-state">Aucune demande envoyée.</div>';
}

async function replyToMyTicket(id) {
  const field = $(`reply-${id}`);
  const message = field.value.trim();
  if (!message) return void showToast('Le message est vide');
  try {
    await api(`/tickets/${id}/messages`, { method: 'POST', body: { message } });
    await renderMyTickets();
    showToast('Message ajouté à la demande');
  } catch (err) {
    showToast(err.message);
  }
}

async function hideMyTicket(id, event) {
  event.stopPropagation();
  if (
    !confirm(
      'Retirer cette demande de votre historique ?\n\n' +
        "Ce n'est pas une suppression définitive : l'administration conserve la demande et son fil."
    )
  ) {
    return;
  }
  const result = await api(`/tickets/${id}/mine`, { method: 'DELETE' });
  await renderMyTickets();
  showToast(result.message || 'Demande retirée de votre historique');
}

// --- Mot de passe, 2FA, e-mail ---------------------------------------------

function openPasswordModal() {
  openGenericModal({
    title: 'Modifier le mot de passe',
    sub: state.policy.passwordRules,
    body: `
      <div class="field"><label>Mot de passe actuel</label><input type="password" id="pw-current" autocomplete="current-password"></div>
      <div class="field"><label>Nouveau mot de passe</label><input type="password" id="pw-new" autocomplete="new-password"></div>
      <div class="field"><label>Confirmer</label><input type="password" id="pw-confirm" autocomplete="new-password"></div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Enregistrer',
        class: 'btn-test',
        onClick: async () => {
          const next = $('pw-new').value;
          if (next !== $('pw-confirm').value) return void genericResult(false, 'Les deux mots de passe diffèrent.');
          try {
            const result = await api('/auth/password', {
              method: 'POST',
              body: { currentPassword: $('pw-current').value, newPassword: next },
            });
            closeGenericModal();
            showToast(`Mot de passe modifié — force : ${result.strength}`);
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

/** Bascule la 2FA de son propre compte. */
function toggleOwn2fa() {
  const twoFactor = state.me.twoFactor || {};
  if (!twoFactor.enabled && !twoFactor.canEnable) {
    return void showToast('La double authentification a été désactivée par l\'administrateur.');
  }
  if (twoFactor.enabled) return void openDisable2faModal();
  openEnable2faModal();
}

async function openEnable2faModal() {
  let setup;
  try {
    setup = await api('/auth/2fa/setup', { method: 'POST' });
  } catch (err) {
    return void showToast(err.message);
  }

  openGenericModal({
    title: 'Activer la double authentification',
    sub: 'Scannez ce QR code, puis saisissez le code affiché par votre application.',
    body: `
      <div class="qr-box">
        <img src="${setup.qr}" alt="QR code TOTP" width="220" height="220">
        <div class="qr-secret">${esc(setup.secret)}</div>
      </div>
      <div class="field-help" style="margin-bottom:12px;">
        Rien n'est enregistré tant qu'un code valide n'a pas été saisi : vous ne pouvez pas
        vous retrouver enfermé dehors.
      </div>
      <div class="field"><label>Code de vérification</label><input type="text" id="totp-code" inputmode="numeric" maxlength="6" placeholder="123456"></div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Activer',
        class: 'btn-test',
        onClick: async () => {
          try {
            const result = await api('/auth/2fa/confirm', {
              method: 'POST',
              body: { code: $('totp-code').value.replace(/\s/g, '') },
            });
            if (result.user) state.me = result.user;
            state.security.twoFactor = true;
            closeGenericModal();
            renderProfilGeneral();
            showToast('Double authentification activée');
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

function openDisable2faModal() {
  openGenericModal({
    title: 'Désactiver la double authentification',
    sub: 'Votre mot de passe actuel est demandé en confirmation.',
    body: `
      <div class="field-help" style="margin-bottom:12px;">
        Votre compte ne sera plus protégé que par son mot de passe. Vous pourrez la
        réactiver à tout moment.
      </div>
      <div class="field"><label>Mot de passe actuel</label><input type="password" id="disable-2fa-password" autocomplete="current-password"></div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Désactiver',
        class: 'btn-danger',
        onClick: async () => {
          try {
            const result = await api('/auth/2fa/disable', {
              method: 'POST',
              body: { password: $('disable-2fa-password').value },
            });
            state.me = result.user;
            state.security.twoFactor = false;
            closeGenericModal();
            renderProfilGeneral();
            showToast('Double authentification désactivée');
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

function renderEmailPending() {
  const box = $('email-pending');
  const pending = state.pendingEmailChange;

  if (!pending) {
    box.innerHTML = state.smtpConfigured
      ? ''
      : `<div class="inline-note">
           Aucun serveur SMTP n'est configuré : le changement d'adresse par e-mail est
           indisponible. Un administrateur peut modifier votre adresse depuis
           Paramètres → Utilisateurs.
         </div>`;
    return;
  }

  box.innerHTML = `
    <div class="inline-note">
      <strong>En attente de confirmation :</strong> ${esc(pending.email)}<br>
      Un lien a été envoyé à cette adresse ; il expire
      <span title="${esc(fmt.exact(pending.expiresAt))}">${esc(fmt.relative(pending.expiresAt))}</span>.
      Votre adresse actuelle reste active jusqu'à la confirmation.
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-mini" onclick="resendEmailChange()">Renvoyer l'e-mail</button>
        <button class="btn-mini danger" onclick="cancelEmailChange()">Annuler la demande</button>
      </div>
    </div>`;
}

function openEmailModal() {
  openGenericModal({
    title: 'Modifier l\'adresse e-mail',
    sub: 'La nouvelle adresse doit être confirmée avant d\'être appliquée.',
    body: `
      <div class="field-help" style="margin-bottom:12px;">
        Un lien de confirmation, valable 24 h et à usage unique, part vers la nouvelle
        adresse. L'ancienne est prévenue de la demande. Rien ne change avant le clic.
      </div>
      <div class="field">
        <label>Nouvelle adresse e-mail</label>
        <input type="text" id="new-email" placeholder="vous@exemple.fr" autocomplete="off">
      </div>`,
    actions: [
      { label: 'Annuler', class: 'btn-secondary', onClick: closeGenericModal },
      {
        label: 'Envoyer le lien',
        class: 'btn-test',
        onClick: async () => {
          try {
            const result = await api('/auth/email-change', {
              method: 'POST',
              body: { email: $('new-email').value.trim() },
            });
            state.pendingEmailChange = result.pending;
            closeGenericModal();
            renderEmailPending();
            showToast(result.message);
          } catch (err) {
            genericResult(false, err.message);
          }
        },
      },
    ],
  });
}

async function resendEmailChange() {
  try {
    const result = await api('/auth/email-change/resend', { method: 'POST' });
    state.pendingEmailChange = result.pending;
    renderEmailPending();
    showToast(result.message);
  } catch (err) {
    showToast(err.message);
  }
}

async function cancelEmailChange() {
  try {
    await api('/auth/email-change', { method: 'DELETE' });
    state.pendingEmailChange = null;
    renderEmailPending();
    showToast('Demande de changement d\'adresse annulée');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Modale générique
// ---------------------------------------------------------------------------

function openGenericModal({ title, sub, body, actions }) {
  $('generic-title').textContent = title;
  $('generic-sub').textContent = sub || '';
  $('generic-body').innerHTML = body;
  $('generic-result').className = 'test-result';
  $('generic-actions').innerHTML = '';

  actions.forEach((action, index) => {
    const button = document.createElement('button');
    button.className = action.class || 'btn-secondary';
    button.textContent = action.label;
    button.style.flex = '1';
    button.style.margin = '0';
    button.style.width = 'auto';
    button.onclick = action.onClick;
    button.id = `generic-action-${index}`;
    $('generic-actions').appendChild(button);
  });

  $('generic-overlay').classList.add('show');
}

function closeGenericModal() {
  $('generic-overlay').classList.remove('show');
}

function genericResult(ok, message) {
  const box = $('generic-result');
  box.className = `test-result show ${ok ? 'ok' : 'fail'}`;
  box.textContent = message;
}

// ---------------------------------------------------------------------------
// Bandeau des opérations (lot 59, refondu au lot 65)
//
// Quand une opération longue tourne — renommage des documents, synchronisation
// vers les destinations, récupération, optimisation —, UN bandeau, centré dans
// l'en-tête, le dit sur TOUTES les pages : quoi, où ça en est, et le clic mène
// à l'écran de l'opération. Trois états, lisibles à la couleur ET au texte (la
// couleur double le texte, elle ne le remplace jamais) :
//
//   - orange : l'opération vit toujours ;
//   - vert : elle vient de se terminer avec succès ;
//   - rouge : elle s'est arrêtée sur un échec.
//
// ─── Ce que le lot 65 répare ────────────────────────────────────────────────
//
// Le 26/08/2026 à 12:10, six récupérations lancées ensemble ont donné SIX
// bandeaux pleine largeur empilés, qui repoussaient l'accueil vers le bas.
// L'un d'eux déversait quatre lignes d'explication déjà présentes, mot pour
// mot, dans la carte du connecteur juste en dessous. Un autre affichait
// « Récupération Darty : en cours — en cours ».
//
// Trois règles en réponse :
//
//   1. **Un seul bandeau.** Plusieurs opérations donnent UNE ligne agrégée —
//      combien, et l'état dominant — que le clic déplie pour montrer le
//      détail, une ligne par opération, chacune menant à son écran. Une seule
//      opération dit directement laquelle, sans dépliage inutile.
//
//   2. **L'ordre d'importance, pas l'ordre d'arrivée.** Un échec passe devant
//      une opération en cours, qui passe devant une opération terminée. C'est
//      le serveur qui classe (`RANG_ETAT`, server/operations.js) et cet écran
//      lit dans l'ordre reçu : la règle vit à UN seul endroit, et l'état
//      dominant est donc toujours `visibles[0]`.
//
//   3. **Une phrase, jamais un mode d'emploi.** Le détail est raccourci par le
//      serveur (`phraseCourte`) : le bandeau dit ce qui s'est passé, la carte
//      du connecteur dit le détail.
//
// ─── Quand il s'efface, quand il reste ──────────────────────────────────────
//
// Un SUCCÈS s'efface tout seul quinze secondes après sa fin. Un ÉCHEC ne
// s'efface JAMAIS de lui-même : il attire l'œil par une pulsation lente
// (1,5 s par cycle, jamais un clignotement — au-delà de trois flashs par
// seconde, c'est un risque réel pour les personnes photosensibles ; et
// `prefers-reduced-motion` la coupe, la couleur et le texte suffisent alors)
// et il attend une décision : la croix, ou l'ouverture de l'écran concerné.
// Le mélange se tranche par l'importance : une opération en erreur et une
// autre terminée, le bandeau reste — l'erreur commande.
//
// Le bandeau ne ment jamais : une opération arrêtée n'est plus « en cours », et
// un état que le serveur ne peut pas établir ne s'affiche pas.
//
// ─── Coût de la veille ───────────────────────────────────────────────────────
//
// GET /api/operations ne lit que la mémoire du processus et la base locale —
// AUCUNE sonde vers un service distant (leçon des lots 53-bis et 57 : un écran
// qui sondait un cloud à chaque affichage a tué une session Proton). La
// cadence s'adapte : toutes les 4 secondes tant que quelque chose tourne ou
// vient de finir, toutes les 45 secondes au repos — assez pour attraper une
// récupération planifiée qui démarre, pour un coût d'affichage.
// ---------------------------------------------------------------------------

const opsBandeau = {
  /** Dernière réponse de GET /api/operations. */
  operations: [],
  timer: null,
  /** Clés des fins fermées à la croix — relues de sessionStorage, une fois. */
  fermees: null,
  /** Le détail est-il déplié ? Survit aux redessins de la veille. */
  deplie: false,
  /** Dernier HTML posé — pour ne pas redessiner à l'identique (voir plus bas). */
  dernierHtml: null,
  /** Minuterie du prochain effacement d'un succès. */
  effacement: null,
};

/** Un succès s'efface tout seul au bout de ce délai, compté depuis sa fin. */
const OPS_DELAI_SUCCES_MS = 15000;

/**
 * Les mots de chaque état. La couleur DOUBLE ces mots, elle ne les remplace
 * jamais : un bandeau lu en noir et blanc dit exactement la même chose.
 */
const OPS_ETATS = {
  echec: { classe: 'echec', un: 'en échec', plusieurs: 'en échec' },
  'en-cours': { classe: 'encours', un: 'en cours', plusieurs: 'en cours' },
  succes: { classe: 'succes', un: 'terminée', plusieurs: 'terminées' },
};

/** Cadences de la veille, en millisecondes. */
const OPS_CADENCE_ACTIVE = 4000;
const OPS_CADENCE_REPOS = 45000;

/** Les fins déjà fermées, mémorisées pour la session du navigateur. */
function opsFermees() {
  if (opsBandeau.fermees) return opsBandeau.fermees;
  let lues = [];
  try {
    lues = JSON.parse(sessionStorage.getItem('crabe.ops.fermees') || '[]');
  } catch { /* stockage indisponible : la croix ne vaudra que pour la page */ }
  opsBandeau.fermees = new Set(Array.isArray(lues) ? lues : []);
  return opsBandeau.fermees;
}

/** Interroge le serveur, redessine, et se re-planifie à la bonne cadence. */
async function veilleOperations() {
  clearTimeout(opsBandeau.timer);
  try {
    const data = await api('/operations');
    opsBandeau.operations = data.operations || [];
    majBandeauOperations();
  } catch { /* session expirée ou réseau : le bandeau garde son dernier état */ }

  const active = opsBandeau.operations.length > 0;
  opsBandeau.timer = setTimeout(
    () => veilleOperations().catch(() => {}),
    active ? OPS_CADENCE_ACTIVE : OPS_CADENCE_REPOS
  );
}

/**
 * La phrase d'une opération : son état EN TOUTES LETTRES, puis le détail.
 *
 * Le tiret n'apparaît que s'il y a quelque chose après. Une récupération qui
 * tourne n'a rien de plus à dire que « en cours » — et le lot 64 l'écrivait
 * deux fois, une par couche, d'où le « en cours — en cours » mesuré. La cause
 * est corrigée côté serveur (le détail vaut désormais `null`) ; ici, on cesse
 * simplement de coller un tiret devant du vide.
 */
function opPhrase(op) {
  const mots = OPS_ETATS[op.etat];
  const etat = op.etat === 'echec' ? 'arrêtée sur un échec' : mots.un;
  const suite = op.etat === 'en-cours' && op.total
    ? `${fmt.number(op.faites)} sur ${fmt.number(op.total)}`
    : op.detail;
  return suite ? `${etat} — ${suite}` : etat;
}

/** L'instant de fin d'une opération, en millisecondes — UTC des deux formats. */
function opsInstantFin(op) {
  if (!op.termineLe) return NaN;
  return Date.parse(String(op.termineLe).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
}

/**
 * Les opérations à montrer, dans l'ordre d'importance reçu du serveur.
 *
 * Filtrer ne réordonne pas : `visibles[0]` reste donc l'opération la plus
 * importante, et c'est elle qui donne son état — et sa couleur — au bandeau.
 */
function opsVisibles() {
  const fermees = opsFermees();
  const maintenant = Date.now();
  return opsBandeau.operations.filter((op) => {
    // Tant que ça tourne, le bandeau reste : c'est le signal que l'opération
    // vit toujours. Ni la croix ni le temps ne l'effacent.
    if (op.etat === 'en-cours') return true;
    if (fermees.has(op.cle)) return false;
    // Un échec attend une décision : il ne part jamais de lui-même.
    if (op.etat === 'echec') return true;
    const fin = opsInstantFin(op);
    // Un succès s'efface quinze secondes après sa fin. Une fin dont l'instant
    // est illisible ne s'efface pas toute seule : mieux vaut un compte rendu
    // qui s'attarde qu'un compte rendu parti sans avoir été lu.
    return !Number.isFinite(fin) || maintenant - fin < OPS_DELAI_SUCCES_MS;
  });
}

/** La ligne agrégée : combien d'opérations, et l'état dominant. */
function opsResume(visibles) {
  const dominant = visibles[0].etat;
  const combien = visibles.filter((op) => op.etat === dominant).length;
  const mots = OPS_ETATS[dominant];
  return `${visibles.length} opérations — ${combien} ${combien > 1 ? mots.plusieurs : mots.un}`;
}

/** La croix : elle ne ferme que ce qui est FINI, et ne navigue pas. */
function opsCroix(visibles) {
  if (!visibles.some((op) => op.etat !== 'en-cours')) return '';
  return `<button class="op-close" onclick="fermerOperationsFinies(event)"
            title="Masquer ce compte rendu" aria-label="Masquer ce compte rendu">✕</button>`;
}

/** Une ligne du détail déplié : l'opération, son état, et son écran au clic. */
function opsLigneDetail(op) {
  return `<button class="op-item ${OPS_ETATS[op.etat].classe}"
            onclick="ouvrirEcranOperation('${esc(op.ecran)}', '${esc(op.cle)}', event)"
            title="Ouvrir l'écran de cette opération">
    <span class="op-dot" aria-hidden="true"></span>
    <span class="op-text"><b>${esc(op.titre)}</b> : ${esc(opPhrase(op))}</span>
  </button>`;
}

/** Le bandeau entier, à partir des opérations visibles (au moins une). */
function bandeauHtml(visibles) {
  const dominant = visibles[0];
  const classe = OPS_ETATS[dominant.etat].classe;
  // Un échec interrompt la lecture, un état en cours ne doit pas : `alert`
  // pour l'un, `status` pour l'autre.
  const role = dominant.etat === 'echec' ? 'alert' : 'status';

  // Une seule opération : la ligne dit laquelle. Rien à déplier.
  if (visibles.length === 1) {
    return `<div class="op-box ${classe}" role="${role}">
      <span class="op-dot" aria-hidden="true"></span>
      <button class="op-ligne"
              onclick="ouvrirEcranOperation('${esc(dominant.ecran)}', '${esc(dominant.cle)}', event)"
              title="Ouvrir l'écran de cette opération">
        <b>${esc(dominant.titre)}</b> : ${esc(opPhrase(dominant))}
      </button>
      ${opsCroix(visibles)}
    </div>`;
  }

  // Plusieurs : UNE ligne agrégée, que le clic déplie. `<details>` natif — le
  // navigateur s'en charge, au clavier comme à la souris (idiome du lot 57).
  return `<div class="op-box ${classe}" role="${role}">
    <span class="op-dot" aria-hidden="true"></span>
    <details class="op-detail"${opsBandeau.deplie ? ' open' : ''} ontoggle="opsDepliage(this)">
      <summary class="op-ligne" title="Voir le détail de chaque opération">${esc(opsResume(visibles))}</summary>
      <div class="op-liste">${visibles.map(opsLigneDetail).join('')}</div>
    </details>
    ${opsCroix(visibles)}
  </div>`;
}

/** Mémorise l'état du dépliage, pour qu'un redessin ne le referme pas. */
function opsDepliage(element) {
  opsBandeau.deplie = !!element.open;
}

/**
 * Programme le prochain effacement automatique.
 *
 * La veille interroge le serveur toutes les 4 secondes : sans cette minuterie,
 * un succès resterait jusqu'à 4 secondes de trop à l'écran. On vise l'échéance
 * la plus proche, et le redessin fait le reste.
 */
function planifierEffacement(visibles) {
  clearTimeout(opsBandeau.effacement);
  opsBandeau.effacement = null;

  const echeances = visibles
    .filter((op) => op.etat === 'succes')
    .map((op) => OPS_DELAI_SUCCES_MS - (Date.now() - opsInstantFin(op)))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!echeances.length) return;

  opsBandeau.effacement = setTimeout(majBandeauOperations, Math.min(...echeances) + 50);
}

/** Redessine le bandeau depuis `opsBandeau.operations`. */
function majBandeauOperations() {
  const zone = $('op-banner');
  if (!zone) return;

  const visibles = opsVisibles();
  const html = visibles.length ? bandeauHtml(visibles) : '';

  // Redessiner à l'identique toutes les quatre secondes replierait le détail
  // sous les doigts de qui vient de l'ouvrir, et lui reprendrait le focus.
  if (html !== opsBandeau.dernierHtml) {
    zone.innerHTML = html;
    opsBandeau.dernierHtml = html;
  }

  planifierEffacement(visibles);
}

/** Les fins fermées, retenues pour la session du navigateur. */
function opsMemoriserFermees() {
  try {
    sessionStorage.setItem('crabe.ops.fermees', JSON.stringify([...opsFermees()]));
  } catch { /* stockage indisponible : la fermeture vaut pour la page */ }
}

/** La croix : toutes les fins affichées sont acquittées, sans naviguer. */
function fermerOperationsFinies(event) {
  event?.stopPropagation?.();
  for (const op of opsVisibles()) {
    if (op.etat !== 'en-cours') opsFermees().add(op.cle);
  }
  opsMemoriserFermees();
  majBandeauOperations();
}

/**
 * Le clic sur une ligne mène à l'écran où l'opération se suit — et acquitte
 * cette opération-là : ouvrir l'écran concerné vaut décision (lot 65). Une
 * opération qui TOURNE n'est pas acquittée : elle vit toujours.
 */
function ouvrirEcranOperation(ecran, cle, event) {
  event?.stopPropagation?.();
  if (cle) {
    const op = opsBandeau.operations.find((o) => o.cle === cle);
    if (op && op.etat !== 'en-cours') {
      opsFermees().add(cle);
      opsMemoriserFermees();
      majBandeauOperations();
    }
  }
  if (ecran === 'profil-fichiers') {
    showView('profil');
    showProfilPage('fichiers', document.querySelector('[data-ppage="fichiers"]'));
    return;
  }
  if (ecran === 'admin-optimisation') {
    showView('admin');
    const item = document.querySelector('#admin-sidebar .settings-nav-item[data-apage="optimisation"]');
    if (item) showAdminPage('optimisation', item);
    return;
  }
  // Synchronisation et récupérations se suivent sur l'accueil : leurs cartes
  // y portent l'avancement et le dernier résultat.
  showView('home');
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const id of ['modal-overlay', 'qv-overlay', 'access-overlay', 'generic-overlay']) {
    $(id).classList.remove('show');
  }
  closeHomePanel();
  closeMobileMenu();
});

document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.classList.remove('show');
  });
});

async function boot() {
  applyTheme(localStorage.getItem('crabe.theme') === 'light');

  const session = await api('/auth/me');
  state.me = session.user;
  state.security = session.security;
  state.policy = session.policy;
  state.settings = session.settings;
  state.pendingEmailChange = session.pendingEmailChange;
  state.smtpConfigured = !!session.smtpConfigured;

  // Toutes les dates de l'interface passeront par ces réglages.
  fmt.configure(session.settings);

  applyAvatar();
  prepareAdminMenu();

  // Cartes ou liste, et les tris : chargés AVANT le premier écran, sinon il
  // s'afficherait dans le mode par défaut puis sauterait dans le bon.
  await loadPrefs();

  await loadConnectors();

  // Il n'existe plus qu'un accueil : le tableau de bord configurable.
  // `users.landing_page` reste en base (migration non destructive) mais
  // n'est plus lue par l'interface.
  showView('home');

  // La veille du bandeau des opérations démarre une fois la session posée,
  // et vit ensuite au rythme décrit plus haut.
  veilleOperations().catch(() => {});

  // Après l'écran, jamais avant : la bannière de mise à jour n'a pas le droit
  // de retarder l'accueil, et son absence (réseau muet, vérification coupée)
  // est un silence total.
  afficherBandeauMiseAJour().catch(() => {});
}

/**
 * La bannière discrète de mise à jour.
 *
 * Elle n'apparaît que si le serveur connaît POSITIVEMENT une version plus
 * récente (voir server/version.js : vérification coupée par défaut, une
 * interrogation par jour au plus, échec réseau = silence). Le geste affiché
 * est celui de l'administrateur — crabe ne se met jamais à jour tout seul.
 * « Plus tard » retient la version écartée : la bannière ne reviendra que
 * pour une version plus récente encore.
 */
async function afficherBandeauMiseAJour() {
  const sante = await api('/sante');
  const maj = sante && sante.miseAJour;
  if (!maj || !maj.version) return;
  if (localStorage.getItem('crabe.update.ignoree') === maj.version) return;

  const bandeau = document.createElement('div');
  bandeau.className = 'update-banner';

  const texte = document.createElement('span');
  texte.textContent = `Une mise à jour est disponible (v${maj.version}) — `;
  const geste = document.createElement('code');
  geste.textContent = 'docker compose pull && docker compose up -d';
  texte.appendChild(geste);

  const fermer = document.createElement('button');
  fermer.type = 'button';
  fermer.className = 'update-banner-close';
  fermer.textContent = 'Plus tard';
  fermer.addEventListener('click', () => {
    localStorage.setItem('crabe.update.ignoree', maj.version);
    bandeau.remove();
  });

  bandeau.appendChild(texte);
  bandeau.appendChild(fermer);
  document.body.insertBefore(bandeau, document.body.firstChild);
}
