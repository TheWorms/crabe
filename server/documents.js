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
const accountIds = require('./connectors/account-id');
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
 * Le titre des dossiers d'UN service — jamais l'identifiant entier (lot 96).
 *
 * ─── Ce que l'utilisateur a vu le 06/10/2026 ──────────────────────────────────────────
 *
 * Sous Gandi, chaque dossier s'affichait « Nom de l'organisation ·
 * identifiant » — un UUID de 36 caractères. Mesuré en production le même
 * jour, par forme : 3 services en « nom · identifiant », 19 en identifiant
 * seul — dont le numéro de sécurité sociale d'Ameli, le numéro fiscal, onze
 * adresses e-mail —, et 21 en « defaut », le nom technique du dossier de
 * repli. L'identifiant est ce qui NOMME le dossier sur le stockage ; il n'a
 * rien à faire devant l'utilisateur.
 *
 * ─── Les règles, dans l'ordre ────────────────────────────────────────────────
 *
 *   1. Un nom connu (découverte) : le nom seul.
 *   2. Deux dossiers ou plus du même nom (trois lignes Free Mobile d'un même
 *      titulaire, mesuré) : le nom suivi de la FIN de l'identifiant,
 *      « Nom (…5678) » — ce qu'on lit d'un numéro de ligne ou de contrat.
 *   3. Pas de nom, un vrai identifiant : seul dossier du service, « Votre
 *      compte » ; sinon « Compte …5678 ».
 *   4. Pas d'identifiant (vide, ou « defaut ») : « Votre compte » s'il est
 *      seul, « Compte non identifié » à côté d'autres.
 *
 * La fin d'identifiant : ses quatre derniers caractères, seulement s'il en
 * compte au moins huit (jamais la moitié d'un identifiant court, encore moins
 * l'identifiant entier) et si elles distinguent tout le groupe. Sinon, un
 * numéro dans l'ordre du service : « Nom (compte 1) », « Compte 2 ».
 *
 * `comptes` arrive DANS L'ORDRE du service (voir `toTree`) : c'est lui qui
 * numérote. Rend une `Map` identifiant → titre.
 */
const FIN_LONGUEUR = 4;
const FIN_IDENTIFIANT_MIN = 8;

/**
 * Le nom d'un compte, s'il en est un (lot 97).
 *
 * Un « nom » qui CONTIENT l'identifiant entier n'en est pas un : Infomaniak
 * nomme une organisation sans nom « Organisation 854637 », et l'afficher
 * remettrait l'identifiant devant l'utilisateur par la porte du nom. Il est
 * alors traité comme absent — la règle 3 ci-dessus prend le relais. Aucun cas
 * en production au 06/10/2026 (mesuré) : c'est une garde, pas un correctif.
 * Un identifiant de moins de quatre caractères ne dit rien de personnel.
 */
function nomAffichable(compte) {
  const nom = String(compte?.nom ?? '').trim();
  const cle = String(compte?.cle ?? '');
  if (!nom) return null;
  if (cle.length >= FIN_LONGUEUR && nom.includes(cle)) return null;
  return nom;
}

function finsDistinctives(identifiants) {
  if (!identifiants.every((id) => String(id).length >= FIN_IDENTIFIANT_MIN)) return null;
  const fins = identifiants.map((id) => String(id).slice(-FIN_LONGUEUR));
  return new Set(fins).size === fins.length ? fins : null;
}

function titresDesDossiers(comptes) {
  const titres = new Map();
  const seul = comptes.length === 1;
  const sansIdentifiant = (cle) => !cle || cle === accountIds.DEFAULT_ACCOUNT_ID;

  const parNom = new Map();
  for (const compte of comptes) {
    const nom = nomAffichable(compte);
    if (!nom) continue;
    if (!parNom.has(nom)) parNom.set(nom, []);
    parNom.get(nom).push(compte);
  }
  for (const [nom, groupe] of parNom) {
    if (groupe.length === 1) {
      titres.set(groupe[0].cle, nom);
      continue;
    }
    const fins = finsDistinctives(groupe.map((c) => c.cle));
    groupe.forEach((c, i) => titres.set(c.cle, fins ? `${nom} (…${fins[i]})` : `${nom} (compte ${i + 1})`));
  }

  const anonymes = comptes.filter((c) => !nomAffichable(c) && !sansIdentifiant(c.cle));
  if (seul && anonymes.length === 1) {
    titres.set(anonymes[0].cle, 'Votre compte');
  } else if (anonymes.length) {
    const fins = finsDistinctives(anonymes.map((c) => c.cle));
    anonymes.forEach((c, i) => titres.set(c.cle, fins ? `Compte …${fins[i]}` : `Compte ${i + 1}`));
  }

  for (const compte of comptes) {
    if (!nomAffichable(compte) && sansIdentifiant(compte.cle)) {
      titres.set(compte.cle, seul ? 'Votre compte' : 'Compte non identifié');
    }
  }
  return titres;
}

/**
 * L'ordre des comptes d'un service (lot 89), sur l'ancien libellé — le nom
 * puis l'identifiant, ou l'identifiant seul — qui ne sort plus d'ici.
 */
function libelleDOrdre(cle, nom) {
  return nom ? `${nom} · ${cle}` : cle || 'Votre compte';
}

/**
 * Les titres des comptes d'un service, dans l'ordre de « Mes documents ».
 *
 * Le lot 97 applique la règle de `titresDesDossiers` hors de « Mes
 * documents » — la carte d'un service (Profil → Connecteurs installés) dit ses
 * comptes. La numérotation (« Compte 1 », « Compte 2 ») dépend de l'ordre :
 * les comptes sont donc rangés ICI comme `toTree` range les dossiers, pour
 * qu'un même compte porte le même titre sur les deux écrans.
 *
 * @param {Array<{cle: string, nom: string|null}>} comptes
 * @returns {Map<string, string>} identifiant → titre
 */
function titresDesComptes(comptes) {
  return titresDesDossiers(tri.parNom(comptes, (c) => libelleDOrdre(c.cle, c.nom)));
}

/**
 * Range les documents en arborescence connecteur → compte → documents.
 *
 * `noms` (facultatif) porte les noms d'organisations ou de titulaires relevés à
 * la découverte. Le TITRE d'un dossier vient de `titresDesDossiers` (lot 96) :
 * le nom seul, jamais l'identifiant entier. L'identifiant reste dans
 * `accountId` : il nomme le dossier sur le stockage, sert la recherche et la
 * clé du repli mémorisé — il ne s'affiche plus.
 *
 * L'ORDRE des dossiers d'un service ne change pas (lot 89) : il se décide,
 * comme avant ce lot, sur l'ancien libellé — le nom puis l'identifiant, ou
 * l'identifiant seul —, qui ne sort plus d'ici.
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
        label: null,
        accountName: nom,
        documents: [],
      });
    }
    branche.accounts.get(cle).documents.push(doc);
  }

  return [...parConnecteur.values()]
    .map((branche) => {
      // Les comptes d'un même service, puis les services entre eux : les deux
      // par la même règle (connectors/tri.js), sinon l'écran serait trié de
      // deux façons différentes selon le niveau où l'on regarde. La clé de
      // tri est l'ancien libellé (voir l'en-tête) : l'ordre reste celui
      // d'avant le lot 96, à l'octet.
      const accounts = tri.parNom([...branche.accounts.values()], (c) => libelleDOrdre(c.accountId, c.accountName));
      const titres = titresDesDossiers(accounts.map((c) => ({ cle: c.accountId, nom: c.accountName })));
      return {
        ...branche,
        accounts: accounts.map((c) => ({ ...c, label: titres.get(c.accountId) })),
      };
    })
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
  titresDesDossiers,
  titresDesComptes,
  // Lot 98 : la MÊME fin d'identifiant distingue deux homonymes dans le nom
  // de leur dossier sur les stockages (dossier-par-nom.js).
  finsDistinctives,
  nomsDeComptesConnus,
  filterOptions,
  browse,
};
