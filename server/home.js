'use strict';

/**
 * Accueil configurable — le tableau de bord de l'utilisateur.
 *
 * Six blocs, activables et réordonnables, dont les préférences sont
 * enregistrées **en base par compte** (table `user_home_widgets`) et jamais
 * dans le navigateur : la disposition suit l'utilisateur d'un appareil à
 * l'autre.
 *
 * Deux règles de fond, valables partout dans ce fichier :
 *
 *   1. **une destination non activée par l'administrateur n'existe pas** pour
 *      l'utilisateur : ni carte, ni pastille, ni statistique ;
 *   2. **rien n'est affirmé sans mesure** : un espace disque qu'on n'a pas pu
 *      lire est « inconnu », pas zéro ; une copie dont on n'a pas gardé la
 *      trace est « inconnue », pas « OK ».
 */

const db = require('./db/db');
const registry = require('./connectors/registry');
const tri = require('./connectors/tri');
const destinations = require('./destinations');
const invoices = require('./invoices');
const scheduler = require('./scheduler');
const settings = require('./settings');
const preferences = require('./preferences');

/**
 * Catalogue des blocs. L'ordre de ce tableau est l'ordre par défaut, celui de
 * la maquette validée (docs/accueil-reference.html).
 *
 * `span` : largeur du bloc, en colonnes sur une grille de 12.
 *   12 = ligne entière · 6 = ½ · 4 = ⅓ · 3 = ¼
 * C'est la largeur PAR DÉFAUT : chaque utilisateur peut en choisir une autre,
 * enregistrée dans `user_home_widgets.span`.
 */
const WIDGETS = [
  { id: 'connecteurs', title: 'Mes connecteurs', icon: 'grid', span: 12 },
  { id: 'stats', title: 'Statistiques', icon: 'chart', span: 12 },
  { id: 'sync', title: 'Synchronisation', icon: 'sync', span: 6 },
  // ⚠ « Erreurs et alertes » jusqu'au lot 24, et le nom disait ce que le bloc
  // faisait : il ne montrait QUE ce qui allait mal. Une récupération qui se
  // passe bien n'y figurait nulle part — pas même celle qui rapporte zéro
  // document, qui est pourtant l'information la plus rassurante qu'un
  // gestionnaire de factures puisse donner : « ça tourne, tout est à jour ».
  // Le bloc montre désormais les trois natures, d'où son nom.
  { id: 'errors', title: 'Suivi actions', icon: 'alert', span: 6 },
  { id: 'documents', title: 'Derniers documents', icon: 'doc', span: 12 },
  { id: 'destinations', title: 'État des destinations', icon: 'cloud', span: 12 },
];

const WIDGET_IDS = WIDGETS.map((w) => w.id);
const DEFAULT_ORDER = [...WIDGET_IDS];

/**
 * Les graphiques du bloc « Statistiques », et le nom qu'on leur donne.
 *
 * Ce ne sont PAS des blocs d'accueil : ils ne se déplacent pas, ne se
 * redimensionnent pas, et n'existent que sous les compteurs qu'ils détaillent.
 * D'où un réglage interne au bloc plutôt que deux entrées de plus dans
 * `WIDGETS` — un accueil de huit blocs pour six choses à voir.
 *
 * Les identifiants sont ceux de `preferences.STATS_CHARTS` ; le titre est
 * exactement celui écrit au-dessus du graphique, pour que la case à cocher et
 * ce qu'elle affiche portent le même nom.
 */
const STATS_CHARTS = [
  { id: 'mois', title: 'Factures par mois' },
  { id: 'connecteurs', title: 'Répartition par service' },
  // Les trois ajouts du lot 20, décochés par défaut : un accueil ne change pas
  // d'aspect parce que crabe a été mis à jour.
  { id: 'stockage', title: 'Espace occupé par service' },
  { id: 'connecteurs-temps', title: 'Services connectés au fil du temps' },
  { id: 'executions', title: 'Récupérations réussies et échouées' },
];

/** Largeurs proposées, dans l'ordre des boutons du sélecteur. */
const SPANS = [
  { value: 12, label: '1', title: 'Ligne entière' },
  { value: 6, label: '½', title: 'Une demi-ligne' },
  { value: 4, label: '⅓', title: 'Un tiers' },
  { value: 3, label: '¼', title: 'Un quart' },
];

const SPAN_VALUES = SPANS.map((s) => s.value);

/** Nombre de documents affichés par le bloc « Derniers documents ». */
const DOCUMENTS_LIMIT = 10;

/**
 * Combien de PAGES le bloc « Derniers documents » peut feuilleter.
 *
 * La pagination du lot 17 se fait dans le navigateur, sur ce que `/api/home`
 * a déjà envoyé : c'est ce qui la rend instantanée, sans un aller-retour par
 * page. En contrepartie, il faut borner ce qu'on envoie — un compte de 186
 * documents ne doit pas charger 186 lignes pour en montrer dix.
 *
 * Cinq pages, donc, et le bouton « Voir tous mes documents » pour la suite :
 * ce bloc s'appelle « Derniers documents », pas « Tous mes documents ».
 * Au-delà, l'écran dédié fait mieux — il trie, filtre et cherche.
 */
const DOCUMENTS_PAGES_MAX = 5;

/** Les douze derniers mois du graphique « factures par mois ». */
const GRAPHIQUE_MOIS = 12;

/** Largeur retenue : celle demandée si elle existe, sinon celle du bloc. */
function normalizeSpan(value, fallback) {
  const span = Number(value);
  return SPAN_VALUES.includes(span) ? span : fallback;
}

// ---------------------------------------------------------------------------
// Verrouillage de l'accueil
//
// Deux verrous, à ne jamais confondre :
//
//   - `home_locked`       — « Figer mon accueil », posé par l'utilisateur pour
//     éviter les déplacements accidentels (surtout au doigt). Il le retire
//     quand il veut.
//   - `home_customizable` — autorisation de l'administrateur, par compte.
//     Retirée, l'utilisateur ne peut plus rien changer NI se réautoriser.
//
// Les routes appliquent réellement ces deux règles (403) : masquer les
// boutons ne protège de rien.
// ---------------------------------------------------------------------------

/**
 * @param {{home_customizable?: number, home_locked?: number}} user
 * @returns {{adminAllowed: boolean, personalLock: boolean, canCustomize: boolean}}
 */
function accessFor(user) {
  // `undefined` sur une base non migrée : on n'invente pas un verrou.
  const adminAllowed = user?.home_customizable === undefined ? true : !!user.home_customizable;
  const personalLock = !!user?.home_locked;
  return { adminAllowed, personalLock, canCustomize: adminAllowed && !personalLock };
}

/**
 * Motif de refus d'une modification, ou null si elle est permise.
 * @param {object} user
 * @returns {string|null}
 */
function customizationRefusal(user) {
  const access = accessFor(user);
  if (!access.adminAllowed) {
    return 'La personnalisation de l\'accueil est désactivée par l\'administrateur.';
  }
  if (access.personalLock) {
    return 'Votre accueil est figé. Retirez « Figer mon accueil » dans le panneau « Personnaliser l\'accueil » pour le modifier.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Préférences de blocs
// ---------------------------------------------------------------------------

/**
 * Disposition d'un compte : ordre + activation + largeur, complétée par les
 * défauts.
 *
 * Un bloc ajouté par une future version apparaît automatiquement à la fin,
 * activé : personne n'a besoin de rouvrir le panneau pour le découvrir.
 *
 * **Chaque bloc apparaît exactement une fois.** La liste est construite depuis
 * `WIDGETS`, jamais depuis les lignes lues en base : une ligne en double (ou
 * une ligne orpheline d'une ancienne version) ne peut pas faire apparaître un
 * bloc deux fois sur l'accueil.
 *
 * @param {number} userId
 * @returns {Array<{id: string, title: string, icon: string, span: number,
 *                  defaultSpan: number, enabled: boolean}>}
 */
function preferencesFor(userId) {
  const rows = db
    .get()
    .prepare('SELECT widget_id, position, enabled, span FROM user_home_widgets WHERE user_id = ?')
    .all(userId);

  const stored = new Map();
  for (const row of rows) if (!stored.has(row.widget_id)) stored.set(row.widget_id, row);

  const known = WIDGETS.filter((w) => stored.has(w.id)).sort(
    (a, b) => stored.get(a.id).position - stored.get(b.id).position
  );
  const unknown = WIDGETS.filter((w) => !stored.has(w.id));

  return [...known, ...unknown].map((widget) => {
    const row = stored.get(widget.id);
    return {
      ...widget,
      defaultSpan: widget.span,
      // NULL en base = « largeur par défaut du bloc » : c'est ce qui rend la
      // migration 13 indolore pour les comptes déjà rangés.
      span: row ? normalizeSpan(row.span, widget.span) : widget.span,
      enabled: row ? !!row.enabled : true,
    };
  });
}

/**
 * Enregistre la disposition d'un compte.
 *
 * Les identifiants inconnus sont ignorés, les blocs oubliés sont replacés à la
 * fin dans leur ordre par défaut : une requête malformée ne peut pas faire
 * disparaître un bloc de l'interface.
 *
 * @param {number} userId
 * @param {Array<{id: string, enabled?: boolean, span?: number}>} widgets dans l'ordre voulu
 */
function savePreferences(userId, widgets) {
  const list = Array.isArray(widgets) ? widgets : [];
  const catalog = new Map(WIDGETS.map((w) => [w.id, w]));
  const seen = new Set();
  const ordered = [];

  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!catalog.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push({
      id,
      enabled: typeof entry === 'string' ? true : entry.enabled !== false,
      span: typeof entry === 'string' ? catalog.get(id).span : normalizeSpan(entry.span, catalog.get(id).span),
    });
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) ordered.push({ id, enabled: true, span: catalog.get(id).span });
  }

  const database = db.get();
  const upsert = database.prepare(
    `INSERT INTO user_home_widgets (user_id, widget_id, position, enabled, span, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, widget_id) DO UPDATE SET
       position   = excluded.position,
       enabled    = excluded.enabled,
       span       = excluded.span,
       updated_at = datetime('now')`
  );

  database.transaction(() => {
    ordered.forEach((widget, index) => {
      upsert.run(userId, widget.id, index, widget.enabled ? 1 : 0, widget.span);
    });
  })();

  return preferencesFor(userId);
}

/** Revient à la disposition par défaut : on efface, on ne réécrit pas. */
function resetPreferences(userId) {
  db.get().prepare('DELETE FROM user_home_widgets WHERE user_id = ?').run(userId);
  return preferencesFor(userId);
}

/**
 * Recopie la disposition d'un compte sur tous les autres.
 *
 * Sert à imposer un accueil homogène après avoir retiré l'autorisation de
 * personnaliser. Les comptes supprimés ou inactifs sont inclus : la
 * disposition les attend s'ils sont réactivés.
 *
 * @param {number} sourceUserId
 * @returns {{applied: number, widgets: Array}} nombre de comptes touchés
 */
function applyLayoutToEveryone(sourceUserId) {
  const layout = preferencesFor(sourceUserId).map((w) => ({
    id: w.id,
    enabled: w.enabled,
    span: w.span,
  }));

  const targets = db
    .get()
    .prepare('SELECT id FROM users WHERE id != ?')
    .all(sourceUserId)
    .map((r) => r.id);

  for (const id of targets) savePreferences(id, layout);
  return { applied: targets.length, widgets: preferencesFor(sourceUserId) };
}

// ---------------------------------------------------------------------------
// Contenu des blocs
// ---------------------------------------------------------------------------

/**
 * Connecteurs installés par l'utilisateur, dans l'ordre alphabétique.
 *
 * Alimente « Mes connecteurs » ET « Synchronisation » : les deux blocs de
 * l'accueil qui listent des services partent d'ici, donc d'un seul tri.
 *
 * Le tri passe par `connectors/tri.js` depuis le lot 24 — un `localeCompare`
 * français nu rangeait déjà les accents correctement, mais laissait la casse
 * départager : deux services dont les noms ne diffèrent que par une majuscule
 * changeaient de place selon celui qui avait été écrit en premier.
 */
function installedConnectors(user) {
  return tri.parNom(registry.listForUser(user).filter((c) => c.installed));
}

/**
 * Bloc « Mes connecteurs ».
 *
 * Chaque vignette porte l'état ET l'action qui le résout : un connecteur jamais
 * configuré ne propose pas « Synchroniser », qui échouerait à coup sûr (voir
 * connectors/health.js).
 */
function connectorTiles(user) {
  const documents = documentsParConnecteur(user.id);
  return tri
    .parOrdre(installedConnectors(user), preferences.get(user.id, 'home.connecteurs.tri'), {
      documents: (c) => documents.get(c.id) || 0,
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      letters: c.letters,
      logo: c.logo || null,
      status: c.status,
      health: c.health,
      alert: !c.health.connected,
      // Les trois valeurs qui rendent les ordres possibles. Elles descendent
      // avec chaque tuile parce que l'écran RETRIE ce qu'il filtre : sans
      // elles, taper une recherche ferait retomber la liste dans l'ordre
      // alphabétique, et l'ordre choisi paraîtrait ne pas tenir.
      installedAt: c.installedAt || null,
      lastRunAt: c.lastRunAt || null,
      documentCount: documents.get(c.id) || 0,
    }));
}

/**
 * Combien de documents chaque connecteur a rapporté à ce compte.
 *
 * Une seule requête groupée plutôt qu'un compte par connecteur : sur
 * vingt-cinq services, la seconde forme ferait vingt-cinq allers-retours pour
 * dessiner un écran d'accueil.
 */
function documentsParConnecteur(userId) {
  const rows = db
    .get()
    .prepare('SELECT connector_id, COUNT(*) AS n FROM invoices WHERE user_id = ? GROUP BY connector_id')
    .all(userId);
  return new Map(rows.map((r) => [r.connector_id, r.n]));
}

function stats(user) {
  const row = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(size_bytes), 0) AS bytes
         FROM invoices WHERE user_id = ?`
    )
    .get(user.id);

  const thisMonth = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS n FROM invoices
        WHERE user_id = ? AND strftime('%Y-%m', fetched_at) = strftime('%Y-%m', 'now')`
    )
    .get(user.id).n;

  const lastSuccess = db
    .get()
    .prepare(
      `SELECT started_at FROM run_logs
        WHERE user_id = ? AND success = 1 AND trigger != 'test'
        ORDER BY started_at DESC, id DESC LIMIT 1`
    )
    .get(user.id);

  const active = installedConnectors(user).filter((c) => c.status === 'installed').length;

  return {
    invoicesThisMonth: thisMonth,
    invoicesTotal: row.total,
    bytes: row.bytes,
    activeConnectors: active,
    lastSuccessAt: lastSuccess?.started_at || null,
    parMois: facturesParMois(user),
    parConnecteur: facturesParConnecteur(user),
    // Les trois séries du lot 20. Elles sont calculées même si le compte n'a
    // coché aucun des trois graphiques : elles coûtent trois requêtes agrégées
    // sur des tables déjà indexées, et les conditionner à une préférence
    // obligerait à recharger tout l'accueil au premier clic sur une case.
    stockageParConnecteur: stockageParConnecteur(user),
    connecteursDansLeTemps: connecteursDansLeTemps(user),
    executionsParMois: executionsParMois(user),
  };
}

/**
 * L'espace occupé par service, du plus lourd au plus léger.
 *
 * ─── Pourquoi celle-ci, et pas « le montant total par mois » ─────────────────
 *
 * Parce que la donnée existe. `invoices.size_bytes` est renseigné pour chaque
 * document déposé, sans exception. Le montant, lui, n'est stocké NULLE PART :
 * les connecteurs en rendent un, la table `invoices` n'a pas de colonne pour
 * l'accueillir, et le graphique aurait donc été vide pour tout le monde — et
 * vide pour toujours sur les documents déjà récupérés, qu'aucune reprise ne
 * peut redater.
 *
 * Le catalogue entier sert de référence, connecteurs désinstallés compris :
 * les fichiers d'un service retiré occupent toujours la place qu'ils occupent,
 * et les faire disparaître ferait mentir le total affiché juste au-dessus.
 */
function stockageParConnecteur(user) {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));

  return db
    .get()
    .prepare(
      `SELECT connector_id, COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n
         FROM invoices WHERE user_id = ?
        GROUP BY connector_id
        ORDER BY bytes DESC`
    )
    .all(user.id)
    .map((r) => {
      const connector = catalog.get(r.connector_id);
      return {
        id: r.connector_id,
        name: connector?.name || r.connector_id,
        color: connector?.color || '#63666e',
        bytes: r.bytes,
        count: r.n,
      };
    });
}

/**
 * Combien de services étaient connectés, mois après mois — CUMULÉ.
 *
 * ⚠ Cumulé, et pas « installés ce mois-ci ». Quelqu'un qui a tout branché le
 * même week-end verrait une barre unique et onze mois vides : exact, et
 * parfaitement inutile. Ce qu'on veut lire ici, c'est « où j'en suis », pas
 * « qu'est-ce que j'ai fait en mars ».
 *
 * ⚠ La courbe ne peut que MONTER, même quand un service est désinstallé : une
 * désinstallation efface la ligne d'installation, et il n'existe aucune trace
 * de la date à laquelle elle a eu lieu. Redescendre la courbe demanderait une
 * donnée que crabe n'a pas — ce qui est dit à l'écran plutôt que deviné.
 */
function connecteursDansLeTemps(user, mois = GRAPHIQUE_MOIS) {
  const rows = db
    .get()
    .prepare(
      `SELECT strftime('%Y-%m', installed_at) AS periode, COUNT(*) AS n
         FROM connector_installs WHERE user_id = ?
        GROUP BY periode`
    )
    .all(user.id);

  const parMois = new Map(rows.map((r) => [r.periode, r.n]));
  const maintenant = new Date();
  const premier = new Date(
    Date.UTC(maintenant.getFullYear(), maintenant.getMonth() - (mois - 1), 1)
  ).toISOString().slice(0, 7);

  // Tout ce qui a été installé AVANT la fenêtre compte déjà : sans ce report,
  // une installation de l'an dernier disparaîtrait et la courbe partirait de
  // zéro alors que les services étaient là.
  let cumul = rows
    .filter((r) => r.periode && r.periode < premier)
    .reduce((n, r) => n + r.n, 0);

  const series = [];
  for (let i = mois - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(maintenant.getFullYear(), maintenant.getMonth() - i, 1));
    const periode = d.toISOString().slice(0, 7);
    cumul += parMois.get(periode) || 0;
    series.push({ periode, count: cumul });
  }
  return series;
}

/**
 * Récupérations réussies et échouées, mois par mois.
 *
 * La question à laquelle ce graphique répond : « est-ce que ça marche ? ».
 * Aucun autre écran n'y répond dans la durée — « Erreurs et alertes » montre
 * l'instant, les journaux montrent le détail, et il faut les lire un par un
 * pour voir une tendance.
 *
 * Les exécutions de TEST sont exclues : un test raté pendant une configuration
 * est un geste normal, pas une panne, et les compter ferait passer une
 * installation soignée pour un service défaillant.
 */
function executionsParMois(user, mois = GRAPHIQUE_MOIS) {
  const rows = db
    .get()
    .prepare(
      `SELECT strftime('%Y-%m', started_at) AS periode,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END) AS ko
         FROM run_logs
        WHERE user_id = ? AND trigger != 'test'
          -- Une exécution EN COURS n'est ni réussie ni échouée : sans ce
          -- filtre, elle comptait en « échouée » le temps de tourner.
          AND finished_at IS NOT NULL
          AND started_at >= date('now', 'start of month', ?)
        GROUP BY periode`
    )
    .all(user.id, `-${mois - 1} months`);

  const parMois = new Map(rows.map((r) => [r.periode, r]));
  const maintenant = new Date();
  const series = [];
  for (let i = mois - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(maintenant.getFullYear(), maintenant.getMonth() - i, 1));
    const periode = d.toISOString().slice(0, 7);
    const ligne = parMois.get(periode);
    series.push({ periode, ok: ligne?.ok || 0, ko: ligne?.ko || 0 });
  }
  return series;
}

/**
 * Les douze derniers mois, et combien de factures chacun porte.
 *
 * ─── Quelle date ? ───────────────────────────────────────────────────────────
 *
 * La date d'ÉMISSION (`issued_on`), pas celle du téléchargement. Un premier
 * passage rapatrie cinq ans de factures le même jour : compté sur
 * `fetched_at`, le graphique montrerait une seule barre gigantesque sur le
 * mois en cours et douze mois vides — un dessin exact et parfaitement
 * trompeur. Le repli sur `fetched_at` ne sert qu'aux documents non datés.
 *
 * Les douze mois sont TOUS rendus, y compris ceux à zéro : un mois sans
 * facture est une information, et un axe à trous ne se lit pas.
 */
function facturesParMois(user, mois = GRAPHIQUE_MOIS) {
  const comptes = new Map(
    db
      .get()
      .prepare(
        `SELECT strftime('%Y-%m', COALESCE(issued_on, fetched_at)) AS periode,
                COUNT(*) AS n
           FROM invoices
          WHERE user_id = ?
            AND COALESCE(issued_on, fetched_at) >= date('now', 'start of month', ?)
          GROUP BY periode`
      )
      .all(user.id, `-${mois - 1} months`)
      .map((r) => [r.periode, r.n])
  );

  const maintenant = new Date();
  const series = [];
  for (let i = mois - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(maintenant.getFullYear(), maintenant.getMonth() - i, 1));
    const periode = d.toISOString().slice(0, 7);
    series.push({ periode, count: comptes.get(periode) || 0 });
  }
  return series;
}

/**
 * Combien de factures par connecteur, du plus fourni au moins fourni.
 *
 * Le catalogue ENTIER sert de référence, connecteurs désinstallés compris :
 * les factures d'un service retiré restent des documents de l'utilisateur, et
 * les faire disparaître du graphique ferait mentir un total qui, lui, les
 * compte toujours.
 */
function facturesParConnecteur(user) {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));

  return db
    .get()
    .prepare(
      `SELECT connector_id, COUNT(*) AS n
         FROM invoices WHERE user_id = ?
        GROUP BY connector_id
        ORDER BY n DESC, connector_id`
    )
    .all(user.id)
    .map((row) => {
      const connector = catalog.get(row.connector_id);
      return {
        connectorId: row.connector_id,
        name: connector?.name || row.connector_id,
        color: connector?.color || '#63666e',
        letters: connector?.letters || '?',
        count: row.n,
      };
    });
}

/**
 * Bloc « Synchronisation » : une ligne par connecteur configuré.
 *
 * `health` accompagne la ligne pour que le bouton dise vrai : « Synchroniser »
 * n'est proposé que là où une synchronisation a une chance d'aboutir.
 */
function syncRows(user) {
  const documents = documentsParConnecteur(user.id);
  // ⚠ Son propre ordre, sous sa propre clé. Ce bloc et « Mes connecteurs » ne
  // répondent pas à la même question — l'un sert à retrouver un service, l'autre
  // à voir ce qui a tourné —, et beaucoup voudront « dernière synchronisation »
  // ici et l'alphabétique là-bas. Une clé commune ferait régler l'un en
  // déréglant l'autre (même raison qu'au lot 20 pour la pagination).
  return tri
    .parOrdre(
      installedConnectors(user).filter((c) => c.status !== 'needs-config'),
      preferences.get(user.id, 'home.sync.tri'),
      { documents: (c) => documents.get(c.id) || 0 }
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      letters: c.letters,
      logo: c.logo || null,
      lastRunAt: c.lastRunAt,
      installedAt: c.installedAt || null,
      documentCount: documents.get(c.id) || 0,
      running: scheduler.isRunning(user.id, c.id),
      health: c.health,
    }));
}

/**
 * Bloc « Erreurs et alertes » : dernières exécutions en échec, par connecteur.
 *
 * Chaque ligne porte l'action qui RÉSOUT son échec, pas un bouton générique :
 * « Votre connexion a expiré → Se reconnecter » plutôt que « Synchroniser »,
 * qui rejouerait une session morte et ramènerait à la même ligne d'erreur.
 */
function recentErrors(user, limit = 5) {
  // Le catalogue ENTIER, pas seulement les connecteurs installés : un échec
  // laissé par un connecteur désinstallé depuis reste une trace à montrer, et
  // c'est le comportement établi depuis le lot 3.
  const catalog = new Map(registry.listForUser(user).map((c) => [c.id, c]));

  // ⚠ `finished_at IS NOT NULL` dans la sous-requête : une ligne de run_logs
  // naît au DÉMARRAGE de l'exécution avec success = 0 et sans message. Sans ce
  // filtre, une récupération en cours devenait la « dernière exécution » de
  // son connecteur et s'affichait ici en échec sans message (14/08/2026,
  // soyoustart, pendant les 2 min 45 de son rattrapage). Pendant une
  // exécution, ce bloc doit montrer l'état d'AVANT ; le bloc
  // « Synchronisation » dit déjà « en cours… », lui.
  return db
    .get()
    .prepare(
      `SELECT r.connector_id, r.started_at, r.message
         FROM run_logs r
         JOIN (SELECT connector_id, MAX(id) AS last_id
                 FROM run_logs
                WHERE user_id = ? AND trigger != 'test' AND finished_at IS NOT NULL
                GROUP BY connector_id) last
           ON last.last_id = r.id
        WHERE r.success = 0
        ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(user.id, limit)
    .filter((row) => catalog.has(row.connector_id))
    .map((row) => {
      const connector = catalog.get(row.connector_id);
      return {
        connectorId: row.connector_id,
        name: connector.name,
        color: connector.color,
        letters: connector.letters,
        logo: connector.logo || null,
        at: row.started_at,
        message: row.message || 'Échec sans message — voir les journaux.',
        health: connector.health,
      };
    });
}

/**
 * Connecteurs qui demandent un geste, qu'ils aient échoué ou non.
 *
 * Un connecteur JAMAIS configuré n'a aucune exécution en échec — il n'a jamais
 * tourné : il n'apparaissait donc nulle part dans « Erreurs et alertes », et
 * l'utilisateur n'avait aucun moyen de savoir qu'il attendait quelque chose.
 */
function pendingActions(user) {
  return installedConnectors(user)
    .filter((c) => !c.health.connected)
    .map((c) => ({
      connectorId: c.id,
      name: c.name,
      color: c.color,
      letters: c.letters,
      logo: c.logo || null,
      health: c.health,
    }));
}

/**
 * Récupérations réussies, la dernière par connecteur.
 *
 * ─── Pourquoi zéro document est un SUCCÈS ───────────────────────────────────
 *
 * C'est le point de tout ce bloc. « Aucune nouvelle facture » veut dire que
 * crabe est allé voir, qu'il a été reçu, et qu'il n'y avait rien de neuf — pas
 * qu'il a échoué, ni même qu'il faut s'en inquiéter. Sur une installation qui
 * tourne bien, c'est la réponse la plus fréquente, et jusqu'au lot 24 elle
 * n'apparaissait NULLE PART sur l'accueil : l'utilisateur voyait un bloc vide
 * et devait deviner si c'était bon signe ou si rien ne s'était lancé.
 *
 * On ne garde que la DERNIÈRE exécution de chaque connecteur, et seulement si
 * elle a réussi : un connecteur qui a échoué depuis appartient aux lignes
 * rouges, et le montrer deux fois avec deux couleurs contraires serait pire
 * que de ne rien montrer.
 *
 * Les exécutions de test sont écartées : cliquer « Tester la connexion » n'est
 * pas une récupération, et laisser une ligne verte derrière chaque test ferait
 * passer un essai pour un résultat.
 */
function recentSuccesses(user, limit = 6) {
  const catalog = new Map(registry.listForUser(user).map((c) => [c.id, c]));

  // Même filtre `finished_at IS NOT NULL` que recentErrors, pour la raison
  // symétrique : sans lui, la ligne « en cours » (success = 0) évinçait le
  // dernier succès du connecteur pendant toute la durée d'une exécution — le
  // connecteur disparaissait d'ici et surgissait dans « Erreurs et alertes ».
  return db
    .get()
    .prepare(
      `SELECT r.connector_id, r.started_at, r.invoice_count, r.message
         FROM run_logs r
         JOIN (SELECT connector_id, MAX(id) AS last_id
                 FROM run_logs
                WHERE user_id = ? AND trigger != 'test' AND finished_at IS NOT NULL
                GROUP BY connector_id) last
           ON last.last_id = r.id
        WHERE r.success = 1
        ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(user.id, limit)
    .filter((row) => catalog.has(row.connector_id))
    .map((row) => {
      const connector = catalog.get(row.connector_id);
      const nombre = row.invoice_count || 0;
      return {
        connectorId: row.connector_id,
        name: connector.name,
        color: connector.color,
        letters: connector.letters,
        logo: connector.logo || null,
        at: row.started_at,
        count: nombre,
        // La phrase est écrite ici et non dans l'écran : c'est le serveur qui
        // sait ce qui s'est passé, et une phrase assemblée dans le navigateur
        // à partir d'un compteur finit toujours par dire « 0 facture
        // récupérée », ce qui sonne comme un échec.
        message: nombre
          ? `${nombre} nouveau(x) document(s) récupéré(s).`
          : 'Aucune nouvelle facture — vous êtes à jour.',
      };
    });
}

/**
 * Copies vers une destination secondaire restées en échec, par destination.
 *
 * Un échec de copie n'apparaissait nulle part sur l'accueil : la récupération,
 * elle, avait réussi — le document est bien sur le stockage local — et le bloc
 * « Erreurs et alertes » ne regarde que les exécutions de connecteurs. Il
 * fallait ouvrir « Mes documents » et repérer une pastille rouge parmi dix.
 *
 * Comme il n'y a **aucune reprise automatique** après trois tentatives, un
 * échec silencieux le serait pour toujours : c'est exactement ce que ce bloc
 * doit rendre impossible.
 *
 * @returns {Array<{destinationId, name, count, sample: string|null}>}
 */
function copyFailures(user, enabledIds) {
  const catalogue = require('./destinations/catalogue');
  const rows = db
    .get()
    .prepare('SELECT filename, destinations FROM invoices WHERE user_id = ?')
    .all(user.id);

  const parDestination = new Map();
  for (const row of rows) {
    for (const state of invoices.statesFor(row.destinations, enabledIds)) {
      if (state.state !== 'error') continue;
      const entree = parDestination.get(state.id) || { count: 0, sample: null, message: null };
      entree.count += 1;
      if (!entree.sample) {
        entree.sample = row.filename;
        entree.message = state.message || null;
      }
      parDestination.set(state.id, entree);
    }
  }

  return [...parDestination.entries()].map(([id, entree]) => ({
    destinationId: id,
    name: catalogue.brand(id).name,
    color: catalogue.brand(id).color,
    letter: catalogue.brand(id).letter,
    logo: catalogue.brand(id).logo,
    logoInterne: catalogue.brand(id).logoInterne,
    count: entree.count,
    sample: entree.sample,
    message: entree.message,
  }));
}

/**
 * Bloc « Derniers documents » : les dix derniers, avec leur état de transfert
 * destination par destination.
 */
function recentDocuments(user, enabledIds, limit = DOCUMENTS_LIMIT) {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));

  const rows = db
    .get()
    .prepare(
      `SELECT id, connector_id, filename, remote_id, account_id, issued_on, fetched_at,
              size_bytes, destinations
         FROM invoices WHERE user_id = ?
        ORDER BY fetched_at DESC, id DESC LIMIT ?`
    )
    .all(user.id, limit);

  return rows.map((row) => {
    const connector = catalog.get(row.connector_id);
    const states = invoices.statesFor(row.destinations, enabledIds);
    return {
      id: row.id,
      connectorId: row.connector_id,
      connectorName: connector?.name || row.connector_id,
      color: connector?.color || '#63666e',
      letters: connector?.letters || '?',
      logo: connector?.logo || null,
      filename: row.filename,
      period: invoices.periodOf(row),
      reference: invoices.referenceOf(row),
      sizeBytes: row.size_bytes,
      fetchedAt: row.fetched_at,
      destinations: states,
      hasError: states.some((d) => d.state === 'error'),
    };
  });
}

/**
 * Bloc « État des destinations ».
 *
 * Ne renvoie QUE les destinations activées ; les autres sont listées à part,
 * pour la note discrète du bas de bloc — informative, non actionnable.
 *
 * Deux chiffres cohabitent sur une carte, et ils ne mesurent pas la même
 * chose : l'espace occupé est celui du VOLUME (une barre de remplissage sans
 * dénominateur ne veut rien dire), tandis que les documents comptés sont ceux
 * de CET utilisateur — c'est sa page, et c'est sur ses documents qu'agit le
 * bouton « Synchroniser ».
 */
async function destinationCards(user, enabledIds) {
  const usage = destinations.usageByDestination();
  const mine = destinations.usageForUserByDestination(user.id);
  const sync = require('./destinations/sync');

  const catalogue = require('./destinations/catalogue');
  const cards = [];
  for (const id of enabledIds) {
    const style = catalogue.brand(id);
    const test = destinations.lastTest(id);
    // Le stockage local est la SOURCE des copies : la synchroniser vers elle-même n'a
    // pas de sens, sa carte ne porte donc pas le bouton.
    const secondaire = id !== 'local';
    cards.push({
      id,
      name: style.name,
      letter: style.letter,
      color: style.color,
      logo: style.logo,
      logoInterne: style.logoInterne,
      usedBytes: usage.find((u) => u.id === id)?.bytes || 0,
      files: usage.find((u) => u.id === id)?.files || 0,
      yourFiles: mine[id]?.files || 0,
      // Documents de ce compte que cette destination n'a pas reçus : jamais
      // copiés, en échec, ou d'état inconnu.
      pending: secondaire ? sync.pendingCount(id, user.id) : 0,
      canSync: secondaire,
      space: await destinations.spaceFor(id),
      lastTestAt: test?.at || null,
      lastTestOk: test ? test.ok : null,
    });
  }

  // ⚠ « Masquée » veut dire « que l'ADMINISTRATION n'a pas activée », et la
  // phrase qui l'accompagne le dit en toutes lettres. Une destination que le
  // COMPTE a refusée dans son écran de Stockage n'a rien à faire ici : elle
  // n'apparaît simplement pas, et accuser l'administrateur d'un choix que
  // l'utilisateur a fait lui-même l'enverrait se plaindre pour rien.
  const activesAdmin = destinations.activeDestinations();
  const hidden = destinations
    .ordre()
    .filter((id) => !activesAdmin.includes(id))
    .map((id) => ({ id, name: catalogue.style(id).name }));

  return { cards, hidden };
}

/** Phrase de la note discrète, ou null s'il n'y a rien à signaler. */
function hiddenDestinationsNote(hidden) {
  if (!hidden.length) return null;
  const names = hidden.map((d) => d.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : names[0];
  return `${list} ${names.length > 1 ? 'ne sont pas activés' : "n'est pas activé"} par l'administrateur.`;
}

/**
 * Tout ce dont l'accueil a besoin, en un appel : la page ne doit pas
 * s'assembler à coups de six requêtes séquentielles sur un téléphone.
 */
async function dashboard(user) {
  // Les destinations de CE compte : celles que l'administration a activées,
  // moins celles que le compte a refusées dans son écran de Stockage (lot 24).
  // Une destination refusée n'apparaît pas dans « Synchronisation » — y laisser
  // sa carte, avec son bouton et son compte de documents en attente, ferait
  // croire qu'elle reçoit encore quelque chose.
  const enabledIds = destinations.destinationsForUser(user.id);
  const { cards, hidden } = await destinationCards(user, enabledIds);
  // Une pagination PAR BLOC depuis le lot 20 : « Synchronisation » liste des
  // services (une dizaine, qu'on veut voir d'un coup), « Derniers documents »
  // liste des factures (des centaines, qu'on feuillette). Le même nombre ne
  // convenait pas aux deux.
  const syncPageSize = preferences.get(user.id, 'home.sync.pageSize');
  const documentsPageSize = preferences.get(user.id, 'home.documents.pageSize');

  return {
    user: {
      id: user.id,
      username: user.username,
      initials: user.username.slice(0, 2).toUpperCase(),
      avatarColor: user.avatar_color || null,
      gravatarUrl: settings.gravatarUrl(user.email),
    },
    // L'interface formate cette date avec les réglages d'administration.
    today: new Date().toISOString(),
    // ─── L'alerte qui prime sur tout le reste (lot 26) ─────────────────────
    //
    // Plus aucun espace de stockage actif : les récupérations sont refusées,
    // planifiées comme manuelles, faute d'endroit où déposer un document.
    //
    // Elle vit en TÊTE DE L'ACCUEIL, et pas seulement dans l'écran Stockage
    // où la décision a été prise. Deux raisons : c'est l'accueil qu'on ouvre
    // en arrivant, et l'écran de Stockage n'est visible que des
    // administrateurs — un compte ordinaire verrait ses récupérations
    // s'arrêter sans qu'aucun écran de son périmètre ne lui dise pourquoi.
    // Le bandeau ne se referme pas : il disparaît quand la cause disparaît.
    stockageAlerte: destinations.aucunStockageActif(),
    widgets: preferencesFor(user.id),
    spans: SPANS,
    access: accessFor(user),
    connectors: connectorTiles(user),
    stats: stats(user),
    sync: syncRows(user),
    errors: recentErrors(user),
    pendingActions: pendingActions(user),
    // Les récupérations qui se sont bien passées — y compris à zéro document.
    successes: recentSuccesses(user),
    // Copies vers un cloud restées en échec : sans reprise automatique, elles
    // le resteraient indéfiniment si personne ne les voyait.
    copyFailures: copyFailures(user, enabledIds),
    // Le bloc feuillette ce qu'il a déjà reçu : on envoie donc de quoi tenir
    // ses cinq pages, à SA taille de page — pas à celle de l'autre bloc.
    documents: recentDocuments(user, enabledIds, documentsPageSize * DOCUMENTS_PAGES_MAX),
    documentsLimit: DOCUMENTS_LIMIT,
    // Chaque bloc a la sienne, réglée dans « Personnaliser l'accueil ».
    syncPageSize,
    documentsPageSize,
    // Chaque bloc a AUSSI sa bascule cartes / liste, sur le patron des
    // Applications (lot 2) et sous sa propre clé : régler l'un ne touche pas
    // l'autre, et aucun des deux ne touche l'écran « Mes documents ».
    syncView: preferences.get(user.id, 'view.home-sync'),
    documentsView: preferences.get(user.id, 'view.home-documents'),
    // L'ordre de chacun des deux blocs qui listent des services, et la liste
    // des ordres possibles. Elle vient du serveur pour la même raison que les
    // tailles de page : c'est lui qui refuse le reste, le menu déroulant ne
    // peut donc pas proposer une valeur que l'enregistrement rejetterait.
    connecteursTri: preferences.get(user.id, 'home.connecteurs.tri'),
    syncTri: preferences.get(user.id, 'home.sync.tri'),
    trisCatalog: tri.ORDRES,
    // Les tailles proposées viennent du serveur, qui est aussi celui qui les
    // refuse : le menu déroulant ne peut donc pas proposer une valeur que
    // l'enregistrement rejetterait.
    pageSizes: preferences.PAGE_SIZES,
    // Quels graphiques le bloc « Statistiques » dessine, et lesquels existent :
    // le panneau de personnalisation coche cette liste, il ne la connaît pas
    // d'avance.
    statsCharts: preferences.get(user.id, 'home.stats.charts'),
    statsChartsCatalog: STATS_CHARTS,
    // Et COMMENT les deux graphiques du lot 18 sont dessinés. Les formes
    // possibles viennent d'ici pour la même raison que les tailles de page :
    // c'est le serveur qui refuse le reste.
    statsChartTypes: {
      mois: preferences.get(user.id, 'home.stats.type.mois'),
      connecteurs: preferences.get(user.id, 'home.stats.type.connecteurs'),
    },
    statsTypeCatalog: preferences.STATS_CHART_TYPES,
    statsTypeLabels: preferences.STATS_TYPE_LABELS,
    destinations: cards,
    hiddenDestinations: hidden,
    hiddenDestinationsNote: hiddenDestinationsNote(hidden),
  };
}

module.exports = {
  WIDGETS,
  WIDGET_IDS,
  DEFAULT_ORDER,
  STATS_CHARTS,
  SPANS,
  SPAN_VALUES,
  DOCUMENTS_LIMIT,
  DOCUMENTS_PAGES_MAX,
  GRAPHIQUE_MOIS,
  facturesParMois,
  facturesParConnecteur,
  normalizeSpan,
  accessFor,
  customizationRefusal,
  preferencesFor,
  savePreferences,
  resetPreferences,
  applyLayoutToEveryone,
  installedConnectors,
  connectorTiles,
  stats,
  syncRows,
  recentErrors,
  pendingActions,
  recentSuccesses,
  copyFailures,
  recentDocuments,
  destinationCards,
  hiddenDestinationsNote,
  dashboard,
};
