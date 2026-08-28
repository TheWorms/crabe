'use strict';

/**
 * « Mes documents » — voir ce que crabe a rangé, et le récupérer.
 *
 * ─── Pourquoi cet écran revient ──────────────────────────────────────────────
 *
 * Le lot 3 a retiré la vue « Stockage local » en même temps que « Mes Papiers », au
 * motif qu'elle devenait inatteignable depuis la nouvelle navigation. C'était
 * une erreur, et elle a duré quatre lots : l'utilisateur n'avait plus AUCUN
 * moyen de voir ses documents depuis crabe. Un logiciel qui récupère des
 * factures et ne sait pas les montrer n'a fait que la moitié du travail.
 *
 * ─── Ce que cet écran est, et n'est pas ──────────────────────────────────────
 *
 * C'est un écran de CONSULTATION. Aucune suppression, aucun renommage, aucun
 * déplacement : crabe est producteur de ces fichiers, pas gestionnaire. Ce qui
 * est déposé sur une destination appartient à son propriétaire, qui le gère
 * avec les outils de cette destination.
 *
 * ─── L'arborescence, telle qu'elle est sur le stockage ───────────────────────
 *
 *   <connecteur> → <compte> → <documents>
 *
 * C'est exactement ce que `destinations/paths.js` écrit, moins le premier
 * segment (le nom d'utilisateur) : chacun ne voit que le sien, et le lui
 * afficher n'apprendrait rien.
 *
 * ─── La destination consultée est un CHOIX ───────────────────────────────────
 *
 * Une facture peut vivre sur le stockage local, Proton Drive et pCloud à la fois. Ce
 * qu'on liste, ce sont les copies RÉELLEMENT DÉPOSÉES sur la destination
 * choisie — pas la table des factures projetée sur une destination. Une copie
 * qui a échoué n'apparaît donc pas dans la destination où elle a échoué, et
 * c'est le comportement attendu : l'écran dit ce qui est là, pas ce qui devrait
 * y être.
 *
 * Quand une destination est injoignable, on le dit simplement et on propose les
 * autres — plutôt qu'une liste vide qui laisserait croire à une perte.
 */

const fs = require('node:fs');

const db = require('./db/db');
const registry = require('./connectors/registry');
const tri = require('./connectors/tri');
const destinations = require('./destinations');
const invoicesLib = require('./invoices');
const local = require('./destinations/local');

/**
 * Pourquoi une destination n'est pas consultable, en français.
 *
 * Les états viennent de `local.quickState()`, qui ne fait que lire — pas de
 * sonde d'écriture, pas de création de dossier : cet écran s'affiche souvent.
 */
const RAISONS_LOCAL = {
  unset: 'Cet espace de stockage n\'a pas encore été réglé par l\'administrateur.',
  missing: 'Cet espace de stockage n\'est pas accessible pour le moment.',
  'not-directory': 'Cet espace de stockage n\'est pas accessible pour le moment.',
  'not-mounted': 'Cet espace de stockage n\'est pas connecté pour le moment.',
  // En lecture seule, la consultation reste parfaitement possible.
  'read-only': null,
  ok: null,
};

/**
 * Destinations proposées en tête d'écran.
 *
 * Le stockage local, quand il est actif, est la principale : c'est la copie de
 * référence, et celle qui répond sans traverser le réseau. Elle est donc en
 * tête et sélectionnée par défaut. Sans lui (« au moins une destination
 * active », lot 38), la première destination active prend le relais.
 *
 * @returns {Array<{id, name, letter, color, primary, available, reason}>}
 */
function listDestinations() {
  const catalogue = require('./destinations/catalogue');
  return destinations.activeDestinations().map((id) => {
    const style = catalogue.brand(id);
    const { available, reason } = destinationAvailability(id);
    return {
      id,
      name: style.name,
      letter: style.letter,
      color: style.color,
      logo: style.logo,
      logoInterne: style.logoInterne,
      primary: id === 'local',
      available,
      reason,
    };
  });
}

/**
 * Une destination répond-elle ?
 *
 * Volontairement BON MARCHÉ : un `stat` pour le stockage local, la présence du binaire
 * et d'une configuration pour les destinations distantes. Interroger réellement
 * Proton Drive prendrait plusieurs secondes à chaque affichage, pour une
 * information que le téléchargement redemandera de toute façon.
 */
function destinationAvailability(id) {
  const conf = destinations.readConfig(id);
  if (!conf) return { available: false, reason: 'Cet espace de stockage n\'est pas configuré.' };

  if (id === 'local') {
    const etat = local.quickState(conf);
    // `in`, et non `??` : les états consultables ont pour valeur `null`, que
    // `??` remplacerait par le motif d'indisponibilité — et l'écran dirait
    // « pas accessible » d'un stockage parfaitement accessible.
    const raison = etat in RAISONS_LOCAL ? RAISONS_LOCAL[etat] : RAISONS_LOCAL.missing;
    return { available: !raison, reason: raison };
  }

  if (destinations.configIllisible(id)) {
    return {
      available: false,
      reason:
        'Impossible de lire la configuration de cet espace de stockage — signalez-le à votre administrateur.',
    };
  }
  // Le MÊME critère que le contrôle de santé (`driver.test`) : la configuration
  // NORMALISÉE. Le bloc rclone est calculé depuis les champs saisis quand il
  // n'est pas collé tel quel ; lire le champ brut disait « pas configuré »
  // d'espaces dont le contrôle de santé venait de réussir (mesuré le
  // 18/08/2026, pCloud et Proton configurés par formulaire).
  const driver = destinations.driverFor(id);
  const normalise = driver?.normalizeConf ? driver.normalizeConf(conf) : conf;
  if (!normalise?.rcloneConfig) {
    return { available: false, reason: 'Cet espace de stockage n\'est pas configuré.' };
  }
  return { available: true, reason: null };
}

/** La destination demandée, ou la principale à défaut. */
function resolveDestination(wanted) {
  const actives = destinations.activeDestinations();
  if (wanted && actives.includes(wanted)) return wanted;
  return actives.includes('local') ? 'local' : actives[0] || null;
}

/**
 * Documents d'un compte présents sur une destination donnée.
 *
 * @param {object} user
 * @param {string} destId
 * @returns {Array<object>}
 */
function documentsOn(user, destId) {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));
  const racine = destId === 'local' ? destinations.readConfig('local')?.path : null;

  return db
    .get()
    .prepare(
      `SELECT id, connector_id, filename, remote_id, account_id, issued_on, fetched_at,
              size_bytes, destinations
         FROM invoices WHERE user_id = ?
        ORDER BY fetched_at DESC, id DESC`
    )
    .all(user.id)
    .map((row) => {
      const deposees = invoicesLib.parseDestinations(row.destinations);
      // Clé ABSENTE = copie jamais tentée sur cette destination (activée après
      // coup, par exemple). À ne pas confondre avec une clé présente sans état,
      // qui est une copie réussie d'avant le suivi détaillé — celle-là existe
      // bel et bien sur le stockage.
      const connue = Object.prototype.hasOwnProperty.call(deposees, destId);
      const depot = connue ? invoicesLib.normalizeOutcome(deposees[destId]) : null;
      return { row, depot };
    })
    // Ce qui est RÉELLEMENT là : une copie en échec ou jamais tentée n'existe
    // pas sur cette destination, et une liste qui la montrerait mentirait.
    .filter(({ depot }) => depot && (depot.state === 'ok' || depot.state === 'unknown'))
    .map(({ row, depot }) => {
      const connector = catalog.get(row.connector_id);
      // Sur le stockage local, on peut vérifier — et c'est le seul endroit où « telle
      // qu'elle existe sur le stockage » se contrôle sans coût.
      const chemin = racine ? destinations.invoicePath(row, user.username) : null;
      const absent = !!racine && (!chemin || !fs.existsSync(chemin));

      return {
        id: row.id,
        connectorId: row.connector_id,
        connectorName: connector?.name || row.connector_id,
        color: connector?.color || '#63666e',
        letters: connector?.letters || '?',
        logo: connector?.logo || null,
        accountId: row.account_id || '',
        filename: row.filename,
        period: invoicesLib.periodOf(row),
        reference: invoicesLib.referenceOf(row),
        sizeBytes: row.size_bytes,
        fetchedAt: row.fetched_at,
        copiedAt: depot.at || null,
        // Le fichier a été effacé sur le stockage depuis son dépôt : on le dit,
        // plutôt que de proposer un téléchargement qui répondrait 404.
        missing: absent,
      };
    });
}

/** Le texte d'un document, pour la recherche par nom. */
function searchable(doc) {
  return `${doc.filename} ${doc.reference} ${doc.connectorName} ${doc.accountId} ${doc.period}`
    .toLowerCase();
}

/**
 * Applique recherche, filtre par connecteur et filtre par période.
 * @param {Array<object>} docs
 * @param {{q?: string, connector?: string, period?: string}} filters
 */
function applyFilters(docs, { q = '', connector = '', period = '' } = {}) {
  const recherche = String(q || '').trim().toLowerCase();
  return docs.filter((doc) => {
    if (connector && doc.connectorId !== connector) return false;
    if (period && doc.period !== period) return false;
    if (recherche && !searchable(doc).includes(recherche)) return false;
    return true;
  });
}

/**
 * Le NOM des comptes déjà découverts, par service : `id → nom lisible`.
 *
 * ─── La panne que ça corrige (lot 26) ────────────────────────────────────────
 *
 * « Le compte n'est pas bon », signalé sur Infomaniak. Le connecteur, lui,
 * remontait le bon identifiant : trois organisations, 854637, 880049 et
 * 2036138, chacune avec ses factures rangées sous son numéro. C'est l'ÉCRAN qui
 * construisait mal son libellé — il affichait le numéro brut, et rien d'autre.
 *
 * Or personne ne connaît ses organisations par leur numéro. Chez Infomaniak
 * elles s'appellent Koody, ES Production et Ouest Anti Nuisibles ; devant
 * « 854637 », il n'y a aucun moyen de savoir laquelle on regarde, ni de vérifier
 * que crabe est bien allé au bon endroit. Un numéro de téléphone Free Mobile se
 * reconnaît tout seul, un numéro d'organisation non.
 *
 * Le nom existait déjà : la découverte le relève et l'enregistre (« Koody »).
 * Il ne franchissait simplement pas la frontière de cet écran-ci. On le lui
 * donne — **sans jamais remplacer l'identifiant**, qui reste ce qui distingue
 * deux comptes et ce qui nomme le dossier sur le stockage.
 *
 * @returns {Map<string, Map<string, string>>} connecteur → (identifiant → nom)
 */
function nomsDeComptesConnus(userId, connectorIds) {
  const discovery = require('./connectors/discovery');
  const registry = require('./connectors/registry');
  const parConnecteur = new Map();

  for (const connectorId of connectorIds) {
    // Un service sans étape de découverte n'a pas de nom à donner : OVHcloud
    // affiche son nichandle, qui est exactement ce que le manager du
    // fournisseur affiche de son côté. C'est un cas normal, pas un manque.
    let champ = null;
    try {
      champ = registry.has(connectorId) ? registry.discoveryField(connectorId) : null;
    } catch {
      champ = null;
    }
    if (!champ) continue;

    const stocke = discovery.read(userId, connectorId, champ.key);
    if (!stocke?.items?.length) continue;

    const noms = new Map();
    for (const item of stocke.items) {
      const nom = String(item?.label || '').trim();
      // `label === id` veut dire « aucun nom relevé » : afficher deux fois le
      // même numéro serait pire que de n'en afficher qu'un.
      if (nom && nom !== String(item.id)) noms.set(String(item.id), nom);
    }
    if (noms.size) parConnecteur.set(connectorId, noms);
  }

  return parConnecteur;
}

/**
 * Range les documents en arborescence connecteur → compte → documents.
 *
 * Les comptes sans identifiant (`account_id` vide) sont regroupés sous un
 * libellé lisible plutôt que sous un dossier « defaut » : le nom technique du
 * dossier de destination n'a rien à faire devant l'utilisateur.
 *
 * `noms` (facultatif) porte les noms d'organisations ou de titulaires relevés à
 * la découverte : « Koody · 854637 » plutôt que « 854637 ». L'identifiant reste
 * toujours affiché — c'est lui qui distingue deux comptes du même nom, et lui
 * qui nomme le dossier sur le stockage.
 */
function toTree(docs, noms = new Map()) {
  const parConnecteur = new Map();

  for (const doc of docs) {
    if (!parConnecteur.has(doc.connectorId)) {
      parConnecteur.set(doc.connectorId, {
        connectorId: doc.connectorId,
        connectorName: doc.connectorName,
        color: doc.color,
        letters: doc.letters,
        logo: doc.logo || null,
        count: 0,
        accounts: new Map(),
      });
    }
    const branche = parConnecteur.get(doc.connectorId);
    branche.count += 1;

    const cle = doc.accountId || '';
    if (!branche.accounts.has(cle)) {
      const nom = noms.get(doc.connectorId)?.get(cle) || null;
      branche.accounts.set(cle, {
        accountId: cle,
        // Le nom D'ABORD, l'identifiant ensuite : c'est le nom qu'on cherche
        // des yeux, et l'identifiant qui lève le doute quand deux comptes se
        // ressemblent. Sans nom relevé, l'identifiant seul, comme avant.
        label: nom ? `${nom} · ${cle}` : cle || 'Votre compte',
        accountName: nom,
        documents: [],
      });
    }
    branche.accounts.get(cle).documents.push(doc);
  }

  return [...parConnecteur.values()]
    .map((branche) => ({
      ...branche,
      // Les comptes d'un même service, puis les services entre eux : les deux
      // par la même règle (connectors/tri.js), sinon l'écran serait trié de
      // deux façons différentes selon le niveau où l'on regarde.
      accounts: tri.parNom([...branche.accounts.values()], (c) => c.label),
    }))
    .sort((a, b) => tri.comparerNoms(a.connectorName, b.connectorName));
}

/** Les valeurs proposées aux filtres, tirées de ce qui existe vraiment. */
function filterOptions(docs) {
  const connecteurs = new Map();
  const periodes = new Set();
  for (const doc of docs) {
    connecteurs.set(doc.connectorId, doc.connectorName);
    if (doc.period) periodes.add(doc.period);
  }
  return {
    connectors: tri.parNom([...connecteurs].map(([id, name]) => ({ id, name }))),
    // Du plus récent au plus ancien : on cherche presque toujours une facture
    // récente.
    periods: [...periodes].sort().reverse(),
  };
}

/**
 * Tout l'écran, en un appel.
 *
 * @param {object} user
 * @param {{destination?: string, q?: string, connector?: string, period?: string}} query
 */
function browse(user, query = {}) {
  const liste = listDestinations();
  const destId = resolveDestination(query.destination);

  if (!destId) {
    return {
      destinations: liste,
      destination: null,
      available: false,
      reason: 'Aucun espace de stockage n\'est activé par l\'administrateur.',
      tree: [],
      filters: { connectors: [], periods: [] },
      total: 0,
      shown: 0,
    };
  }

  const destination = liste.find((d) => d.id === destId);

  // Injoignable : on le dit, on ne renvoie pas une liste vide qui laisserait
  // croire à une perte. Les autres destinations restent proposées.
  if (!destination.available) {
    return {
      destinations: liste,
      destination,
      available: false,
      reason: destination.reason,
      tree: [],
      filters: { connectors: [], periods: [] },
      total: 0,
      shown: 0,
    };
  }

  const tous = documentsOn(user, destId);
  const retenus = applyFilters(tous, query);

  return {
    destinations: liste,
    destination,
    available: true,
    reason: null,
    tree: toTree(retenus, nomsDeComptesConnus(user.id, [...new Set(retenus.map((d) => d.connectorId))])),
    // Les filtres portent sur TOUT ce que contient la destination : une
    // recherche qui ne ramène rien ne doit pas vider les listes déroulantes et
    // enfermer l'utilisateur dans son propre filtre.
    filters: filterOptions(tous),
    total: tous.length,
    shown: retenus.length,
  };
}

module.exports = {
  RAISONS_LOCAL,
  listDestinations,
  destinationAvailability,
  resolveDestination,
  documentsOn,
  applyFilters,
  toTree,
  nomsDeComptesConnus,
  filterOptions,
  browse,
};
