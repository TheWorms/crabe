'use strict';

/**
 * Registre des connecteurs.
 *
 * Scanne `available/`, valide chaque manifest, charge le module `connector.js`
 * associé, et expose les opérations de haut niveau : install / uninstall /
 * test / fetch. Toutes les opérations sont bornées à un utilisateur : un
 * compte ne voit et ne déclenche jamais les connecteurs d'un autre.
 *
 * ─── Deux dossiers, deux états (lot 11) ──────────────────────────────────────
 *
 *   available/  un service qu'on sait atteindre : manifeste + connector.js ;
 *   planned/    un service ANNONCÉ : un manifeste, et rien d'autre.
 *
 * Le second existe pour dire honnêtement où va le projet. Il apparaît dans le
 * Store, avec son logo et sa catégorie, mais ne s'installe pas — et le refus
 * est ici, dans le registre, pas seulement dans l'interface : un bouton grisé
 * n'a jamais arrêté un appel direct à l'API.
 *
 * **C'est le dossier qui fait foi**, jamais le champ `status` du manifeste.
 * Rendre un service disponible se fait donc en déplaçant son dossier, sans
 * toucher à une ligne de son contenu — et sans que ce lot ait laissé derrière
 * lui une deuxième vérité à mettre à jour en même temps.
 *
 * Deux tables séparées plutôt qu'un drapeau dans une seule : de cette façon,
 * tout ce qui existait avant ce lot — `size`, `syncCatalog`, le planificateur,
 * les statistiques — continue de ne voir QUE les connecteurs réels, et il faut
 * demander explicitement les annoncés pour les obtenir. Le contraire aurait
 * fait fuiter soixante tuiles dans des écrans où elles n'ont rien à faire.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/db');
const crypto = require('../crypto');
const schema = require('./manifest-schema');
const accountIds = require('./account-id');
const sessionState = require('./session-state');
const discovery = require('./discovery');
const history = require('./history');
const logos = require('./logos');
const tri = require('./tri');
const health = require('./health');
const messagesEchec = require('./messages-echec');
const schedules = require('../schedules');

const AVAILABLE_DIR = path.join(__dirname, 'available');
const PLANNED_DIR = path.join(__dirname, 'planned');

/**
 * Implémentations PARTAGÉES : du code, sans manifeste.
 *
 * ─── Pourquoi ça existe (lot 12) ─────────────────────────────────────────────
 *
 * Sept boutiques tournent sur PrestaShop. Elles ont chacune leur tuile, leur
 * nom et leur logo — c'est ce qu'un utilisateur cherche —, mais leur parcours
 * est le MÊME : même page de connexion, même historique de commandes, mêmes
 * deux schémas de lien de facture. Écrire sept connecteurs identiques à
 * l'adresse près, c'est sept endroits à corriger le jour où PrestaShop change
 * un sélecteur, et six qu'on oubliera.
 *
 * `available/prestashop/` porte donc le code, et rien d'autre : **pas de
 * `manifest.json`**. Chaque boutique a son dossier avec son seul manifeste, qui
 * déclare `"implementation": "prestashop"` et ses adresses — c'est le registre
 * qui les rapproche au chargement.
 *
 * Un dossier d'implémentation n'est PAS un connecteur : il n'apparaît ni dans
 * le Store, ni dans le catalogue d'administration, ni dans `size`. Rien ne
 * s'installe sur lui.
 *
 * ⚠ Ne pas confondre `available/prestashop/` (ce code) avec
 * `planned/prestashop/` (le service « PrestaShop », l'abonnement à la
 * plateforme, qui est un tout autre sujet et reste annoncé).
 *
 * ─── Le deuxième cas (lot 16) ────────────────────────────────────────────────
 *
 * `available/ovh-api/` porte le moteur d'API du groupe OVHcloud : OVHcloud,
 * SoYouStart et Kimsufi partagent le même serveur, la même signature et la
 * même route `/me/bill`, seule l'adresse de base change.
 *
 * Le code vivait dans `available/ovh/connector.js`. Il a fallu le SORTIR de
 * là : un dossier n'est reconnu comme implémentation partagée que s'il n'a
 * PAS de manifeste (voir plus bas) — et `available/ovh/` en a un, puisque
 * OVHcloud est aussi un service qu'on installe. Le code partagé et le service
 * qui l'utilise ne peuvent donc pas habiter le même dossier.
 */
const SHARED_IMPLEMENTATIONS = new Set(['prestashop', 'ovh-api']);

/** Le module d'une implémentation partagée : `available/<nom>/connector.js`. */
function sharedImplementationFile(dir, name) {
  return path.join(dir, name, 'connector.js');
}

/**
 * Les implémentations partagées déjà chargées pendant CE passage de `load()`.
 *
 * Sans ce cache, les huit boutiques PrestaShop obtiendraient huit copies du
 * même fichier — le registre vide `require.cache` avant chaque chargement pour
 * relire le disque, ce qui est juste pour un connecteur mais faux pour du code
 * commun. Huit copies, c'est huit fois la mémoire, et surtout huit modules
 * distincts : un test qui comparerait « c'est bien le même code » échouerait, et
 * il aurait raison de le faire.
 */
const modulesPartages = new Map();

/** @type {Map<string, {manifest: object, module: object, dir: string, planned: false}>} */
const registry = new Map();
/** @type {Map<string, {manifest: object, module: null, dir: string, planned: true}>} */
const planned = new Map();
/** @type {string[]} erreurs de chargement, affichées dans les logs admin */
const loadErrors = [];

/**
 * (Re)charge tous les connecteurs depuis le disque.
 *
 * @param {string} [dir] dossier des connecteurs réels
 * @param {string|null} [plannedDir] dossier des services annoncés. Vaut `null`
 *   dès qu'on charge depuis un autre dossier que celui livré : un test qui
 *   monte trois connecteurs dans un répertoire temporaire ne doit pas se voir
 *   servir soixante annonces par surprise — il les demande, ou il ne les a pas.
 * @returns {{loaded: number, planned: number, errors: string[]}}
 */
function load(dir = AVAILABLE_DIR, plannedDir = dir === AVAILABLE_DIR ? PLANNED_DIR : null) {
  registry.clear();
  planned.clear();
  modulesPartages.clear();
  loadErrors.length = 0;

  chargerDossier(dir, registry, { planned: false, obligatoire: true });
  if (plannedDir) chargerDossier(plannedDir, planned, { planned: true, obligatoire: false });

  return { loaded: registry.size, planned: planned.size, errors: [...loadErrors] };
}

/**
 * Charge un dossier de connecteurs dans la table qu'on lui donne.
 *
 * @param {string} dir
 * @param {Map} cible
 * @param {{planned: boolean, obligatoire: boolean}} options `obligatoire` :
 *   l'absence du dossier `available/` est une panne, celle de `planned/` un
 *   simple « rien à annoncer ».
 */
function chargerDossier(dir, cible, { planned: estAnnonce, obligatoire }) {
  if (!fs.existsSync(dir)) {
    if (obligatoire) loadErrors.push(`Répertoire de connecteurs introuvable : ${dir}`);
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const connDir = path.join(dir, entry.name);
    const manifestFile = path.join(connDir, 'manifest.json');
    const moduleFile = path.join(connDir, 'connector.js');

    if (!fs.existsSync(manifestFile)) {
      // Une implémentation partagée : du code, pas un service. Elle n'apparaît
      // nulle part et ne s'installe pas — ce sont les manifestes qui la
      // déclarent (`"implementation": "<nom>"`) qui la font tourner.
      if (!estAnnonce && SHARED_IMPLEMENTATIONS.has(entry.name) && fs.existsSync(moduleFile)) {
        continue;
      }
      loadErrors.push(`${entry.name}: manifest.json manquant`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (err) {
      loadErrors.push(`${entry.name}: manifest.json illisible (${err.message})`);
      continue;
    }

    const { ok, errors } = schema.validate(parsed, entry.name, { planned: estAnnonce });
    if (!ok) {
      loadErrors.push(...errors);
      continue;
    }

    if (parsed.id !== entry.name) {
      loadErrors.push(
        `${entry.name}: l'id du manifest (« ${parsed.id} ») ne correspond pas au nom du dossier`
      );
      continue;
    }

    // Le piège de session, signalé mais JAMAIS bloquant (lot 26). La règle est
    // appliquée à la source par `schema.normalize()`, qui ramène ce champ à
    // « pas obligatoire » quoi qu'en dise le manifeste : l'utilisateur ne peut
    // donc plus être enfermé dehors. Reste à le dire à qui écrit les
    // manifestes, sinon la ligne fautive se recopie de connecteur en
    // connecteur. Refuser le chargement serait pire que le mal — un service
    // disparaîtrait du Store pour une ligne devenue sans effet.
    for (const champ of (parsed.fields || []).filter((f) => f?.type === 'session' && f.required)) {
      loadErrors.push(
        `${entry.name}: le champ de session « ${champ.key} » est déclaré obligatoire — `
          + 'corrigé au chargement, mais à retirer du manifeste : un champ que seule la '
          + 'capture peut remplir ne peut pas être exigé avant la connexion'
      );
    }

    // Un même identifiant des deux côtés donnerait deux tuiles pour le même
    // service, dont une inerte : on garde le connecteur réel et on le dit.
    if (estAnnonce && registry.has(parsed.id)) {
      loadErrors.push(
        `${entry.name}: annoncé dans planned/ alors qu'il existe déjà dans available/ — `
          + 'le connecteur réel est conservé, l\'annonce ignorée'
      );
      continue;
    }

    if (estAnnonce) {
      // Aucun module à charger : c'est exactement ce qui distingue une annonce.
      // Un connector.js traînant ici ne serait jamais exécuté — le dire évite
      // de chercher pourquoi « le code est là mais rien ne se passe ».
      if (fs.existsSync(moduleFile)) {
        loadErrors.push(
          `${entry.name}: un connector.js est présent dans planned/ mais n'y est jamais `
            + 'chargé — déplacez le dossier dans available/ pour le rendre disponible'
        );
      }
      cible.set(parsed.id, {
        manifest: schema.normalize(parsed, { planned: true }),
        module: null,
        dir: connDir,
        planned: true,
      });
      continue;
    }

    // Un connector.js local a toujours le dernier mot ; à défaut, le manifeste
    // peut désigner une implémentation partagée (voir SHARED_IMPLEMENTATIONS).
    const partagee = !fs.existsSync(moduleFile) && SHARED_IMPLEMENTATIONS.has(parsed.implementation)
      ? sharedImplementationFile(dir, parsed.implementation)
      : null;
    const source = partagee || moduleFile;

    if (partagee && !fs.existsSync(partagee)) {
      loadErrors.push(
        `${entry.name}: implémentation partagée « ${parsed.implementation} » introuvable `
          + `(${path.relative(dir, partagee)})`
      );
      continue;
    }

    let mod;
    try {
      if (partagee && modulesPartages.has(partagee)) {
        // Déjà chargée pour une autre boutique : le MÊME module, pas une copie.
        mod = modulesPartages.get(partagee);
      } else {
        delete require.cache[require.resolve(source)];
        mod = require(source);
        if (partagee) modulesPartages.set(partagee, mod);
      }
    } catch (err) {
      loadErrors.push(`${entry.name}: connector.js illisible (${err.message})`);
      continue;
    }

    if (typeof mod.test !== 'function' || typeof mod.fetchInvoices !== 'function') {
      loadErrors.push(`${entry.name}: connector.js doit exporter test() et fetchInvoices()`);
      continue;
    }

    // `discover()` est facultative — sauf pour un connecteur qui promet dans
    // son manifeste un champ alimenté par la découverte. Sans elle, ce champ
    // n'aurait jamais d'options et le formulaire serait inutilisable : mieux
    // vaut refuser le chargement et le dire.
    if (schema.discoveredFields(parsed).length && typeof mod.discover !== 'function') {
      loadErrors.push(
        `${entry.name}: connector.js doit exporter discover() — le manifeste déclare un champ `
          + `« ${schema.discoveredFields(parsed)[0].key} » alimenté par la découverte`
      );
      continue;
    }

    cible.set(parsed.id, {
      manifest: schema.normalize(parsed, { planned: false }),
      module: mod,
      dir: connDir,
      planned: false,
    });
  }
}

/**
 * Aligne `connector_catalog` sur les connecteurs présents sur le disque.
 *
 * Les services annoncés y ont leur ligne comme les autres : sans elle, aucun
 * compte ordinaire ne les verrait — c'est cette table qui porte l'ouverture aux
 * utilisateurs (voir `isAllowedForUser`).
 */
function syncCatalog() {
  const database = db.get();
  const insert = database.prepare(
    `INSERT INTO connector_catalog (connector_id, category, status)
     VALUES (?, ?, ?)
     ON CONFLICT(connector_id) DO NOTHING`
  );
  const tx = database.transaction(() => {
    for (const [id, entry] of entrees()) {
      insert.run(id, entry.manifest.category, entry.manifest.initialStatus || 'available');
    }

    // ─── Une entrée supprimée du disque est supprimée de la base (lot 31) ───
    //
    // Ce semis n'a longtemps su qu'INSÉRER : un service retiré du catalogue
    // (dossier supprimé sur décision) gardait sa ligne ici pour toujours, avec
    // son logo et ses échecs de logo. Homebox et Sofidial, retirés le
    // 11/08/2026, étaient toujours en base le 14/08 — comme ulule, emoa et
    // le-petit-hydroculte, retirés le 12/08. C'est la famille de la panne du
    // lot 29, où l'amorçage ressuscitait un stockage local supprimé au redémarrage.
    //
    // La règle d'effacement suit LE DISQUE, pas le registre chargé : une ligne
    // n'est retirée que si AUCUN dossier livré ne porte de manifest.json à son
    // nom. Un manifeste présent mais illisible (erreur de chargement passagère)
    // protège donc sa ligne — et ses réglages d'administration (maintenance,
    // visibilité) survivent à la panne au lieu d'être perdus avec elle.
    //
    // Les tables nettoyées sont celles du CATALOGUE : jamais les installations
    // ni les factures, qui appartiennent aux utilisateurs.
    const proteges = manifestesDuDisque();
    for (const ligne of database.prepare('SELECT connector_id FROM connector_catalog').all()) {
      if (has(ligne.connector_id)) continue;
      if (proteges.has(ligne.connector_id)) continue;
      database.prepare('DELETE FROM connector_catalog WHERE connector_id = ?').run(ligne.connector_id);
      database.prepare('DELETE FROM connector_logos WHERE connector_id = ?').run(ligne.connector_id);
      database.prepare('DELETE FROM logo_failures WHERE connector_id = ?').run(ligne.connector_id);
    }
  });
  tx();
}

/**
 * Les identifiants qui ont un `manifest.json` dans les dossiers LIVRÉS.
 *
 * Volontairement lu sur le disque et non depuis les tables chargées : un test
 * qui charge trois connecteurs d'un répertoire temporaire ne doit pas faire
 * passer les quatre-vingts services livrés pour des orphelins à effacer.
 */
function manifestesDuDisque() {
  const ids = new Set();
  for (const racine of [AVAILABLE_DIR, PLANNED_DIR]) {
    let entreesDisque;
    try {
      entreesDisque = fs.readdirSync(racine, { withFileTypes: true });
    } catch {
      continue; // racine absente : rien à protéger de ce côté
    }
    for (const e of entreesDisque) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(racine, e.name, 'manifest.json'))) ids.add(e.name);
    }
  }
  return ids;
}

/** Les deux tables à la suite : connecteurs réels d'abord, annonces ensuite. */
function* entrees() {
  yield* registry;
  yield* planned;
}

function has(id) {
  return registry.has(id) || planned.has(id);
}

/** Ce service est-il seulement ANNONCÉ ? Faux pour un identifiant inconnu. */
function isPlanned(id) {
  return planned.has(id);
}

function get(id) {
  const entry = registry.get(id) || planned.get(id);
  if (!entry) throw new Error(`Connecteur inconnu : ${id}`);
  return entry;
}

/**
 * Refuse toute opération qui suppose du code derrière le manifeste.
 *
 * **Côté serveur, et pas seulement dans l'interface.** Le badge grisé du Store
 * suffit à l'utilisateur ; il ne suffit pas à un deuxième onglet, à un
 * rechargement ou à un appel direct. Sans cette barrière, `install()` créerait
 * une ligne d'installation et une planification pour un connecteur sans code,
 * que le planificateur essaierait ensuite d'exécuter tous les jours.
 *
 * @param {string} connectorId
 * @param {string} [geste] ce qui a été tenté, pour l'écrire dans le message
 */
function assertInstallable(connectorId, geste = 'installé') {
  const entry = get(connectorId);
  if (!entry.planned) return;
  const err = new Error(
    `« ${entry.manifest.name} » ne peut pas encore être ${geste} : ce service est annoncé, `
      + 'sa connexion arrivera dans une prochaine version de crabe.'
  );
  err.statusCode = 409;
  err.planned = true;
  throw err;
}

/** Manifest brut (avec les métadonnées de champs complètes). */
function manifest(id) {
  return get(id).manifest;
}

/** Tous les manifests, fusionnés avec l'état du catalogue admin. */
function listAll() {
  const catalog = new Map(
    db.get().prepare('SELECT * FROM connector_catalog').all().map((r) => [r.connector_id, r])
  );
  // Une seule requête pour tout le catalogue : le Store en affiche quatre-vingts,
  // et une requête par connecteur ferait quatre-vingts allers-retours par écran.
  const logoUrls = logos.tousLesUrls();
  // ⚠ TRIÉ PAR NOM AFFICHÉ, et c'est ici que ça se joue (lot 24). `entrees()`
  // rend l'ordre des DOSSIERS du disque, qui sont techniques : « L'Île aux
  // Épices » vit dans `ile-aux-epices` et se retrouvait entre Hetzner et
  // Impots.gouv.fr. Trier à la source plutôt qu'écran par écran, parce que
  // cette liste alimente le Store, « Mes documents », l'accueil, les
  // Applications de l'administration, le gestionnaire de logos et les filtres
  // de journaux — six endroits, donc six occasions d'oublier.
  //
  // Ce qui NE dépend pas de cet ordre : `syncCatalog()`, qui passe par
  // `entrees()` directement, et `listPlanned()`/`listAvailable()`, qui filtrent.
  return tri.parNom([...entrees()].map(([, entry]) => {
    const row = catalog.get(entry.manifest.id) || {};
    return {
      ...entry.manifest,
      // L'adresse du logo réel, servie par crabe — jamais rechargée depuis
      // l'extérieur à l'affichage. `null` = la pastille à initiales reprend sa
      // place (voir connectors/logos.js).
      logo: logoUrls.get(entry.manifest.id) || null,
      category: row.category || entry.manifest.category,
      categoryLabel:
        schema.CATEGORIES[row.category || entry.manifest.category] || entry.manifest.categoryLabel,
      maintenance: !!row.maintenance,
      allowedUsers: parseAllowed(row.allowed_users),
      catalogStatus: row.status || 'available',
      // Mise à disposition EXPLICITE dans le Store (approbation par un
      // administrateur). null = livré disponible par défaut, sans décision.
      publishedAt: row.published_at || null,
    };
  }));
}

/** Les seuls connecteurs réellement exécutables : ceux qui portent du code. */
function listAvailable() {
  return listAll().filter((c) => !c.planned);
}

/** Les services simplement annoncés — Store et catalogue d'administration. */
function listPlanned() {
  return listAll().filter((c) => c.planned);
}

function parseAllowed(raw) {
  if (raw === undefined || raw === null) return 'all';
  try {
    const parsed = JSON.parse(raw);
    return parsed === 'all' || Array.isArray(parsed) ? parsed : 'all';
  } catch {
    return 'all';
  }
}

/** Un utilisateur a-t-il le droit de voir/installer ce connecteur ? */
function isAllowedForUser(connectorId, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const row = db
    .get()
    .prepare('SELECT allowed_users, status FROM connector_catalog WHERE connector_id = ?')
    .get(connectorId);
  if (!row) return false;
  if (row.status === 'pending') return false;
  const allowed = parseAllowed(row.allowed_users);
  if (allowed === 'all') return true;
  return allowed.map(Number).includes(Number(user.id));
}

/**
 * Catalogue tel que vu par un utilisateur donné : les connecteurs en attente
 * de test et ceux qui ne lui sont pas ouverts sont retirés.
 */
function listForUser(user) {
  const installs = new Map(
    db
      .get()
      .prepare('SELECT * FROM connector_installs WHERE user_id = ?')
      .all(user.id)
      .map((r) => [r.connector_id, r])
  );

  // Un seul agrégat pour tout le catalogue : la fiche d'un connecteur annonce
  // « 30 factures récupérées », et une requête par connecteur ferait quatorze
  // allers-retours pour afficher un Store.
  const counts = new Map(
    db
      .get()
      .prepare(
        `SELECT connector_id, COUNT(*) AS n, MAX(fetched_at) AS last
           FROM invoices WHERE user_id = ? GROUP BY connector_id`
      )
      .all(user.id)
      .map((r) => [r.connector_id, r])
  );

  // Les comptes qui portent VRAIMENT des documents (lot 26).
  //
  // La fiche d'un service affiche une ligne « Compte » depuis longtemps — et
  // elle affichait « — » pour tout le monde, sans exception : l'identifiant
  // n'était jamais envoyé au client. Signalé comme « le compte n'est pas
  // bon », sur Infomaniak et sur OVHcloud.
  //
  // Ce qu'on envoie n'est pas le seul identifiant enregistré sur
  // l'installation : c'est la liste des comptes sous lesquels des documents
  // sont rangés. La différence compte pour un service à plusieurs comptes —
  // Infomaniak en a trois — où un identifiant unique en représenterait deux
  // autres qu'il ne nomme pas. Une requête pour tout le catalogue, comme
  // au-dessus : une par service ferait quatorze allers-retours par écran.
  const comptesParService = new Map();
  for (const ligne of db
    .get()
    .prepare(
      `SELECT connector_id, account_id, COUNT(*) AS n
         FROM invoices WHERE user_id = ?
        GROUP BY connector_id, account_id ORDER BY n DESC`
    )
    .all(user.id)) {
    if (!comptesParService.has(ligne.connector_id)) comptesParService.set(ligne.connector_id, []);
    comptesParService.get(ligne.connector_id).push({ id: ligne.account_id || '', count: ligne.n });
  }

  return listAll()
    .filter((m) => isAllowedForUser(m.id, user) && voitLesEnAttente(m, user))
    .map((m) => {
      // Un service annoncé n'a pas d'installation, et n'en aura pas : une
      // ligne d'installation qui le désignerait ne pourrait venir que d'une
      // base abîmée, et la suivre ferait apparaître une tuile « installée »
      // qu'aucun écran ne saurait ensuite configurer.
      const install = m.planned ? null : installs.get(m.id);
      const connector = {
        ...schema.publicView(m),
        status: m.planned ? 'planned' : install ? install.status : 'available',
        installed: !!install,
        lastRunAt: install?.last_run_at || null,
        // ⚠ `lastError` reste ici pour `health.summarize()`, qui le lit juste
        // en dessous — et il est RETIRÉ de l'objet avant d'être envoyé au
        // client (voir plus bas). Le lot 14, §2.2 : un message brut stocké
        // nommait parfois un autre service que la fiche affichée, parce qu'il
        // portait un nom en dur (« … sur Propolia »). Ce que l'interface reçoit
        // désormais, c'est `health.detail`, écrit à partir de CE connecteur-ci.
        lastError: install?.last_error || null,
        installedAt: install?.installed_at || null,
        invoiceCount: counts.get(m.id)?.n || 0,
        lastInvoiceAt: counts.get(m.id)?.last || null,
        // Le compte enregistré sur l'installation : celui vers lequel le
        // service pointe, même avant qu'un document n'ait été rangé.
        accountId: install?.account_id || null,
        // Et les comptes réellement porteurs de documents, nommés quand la
        // découverte a relevé leur nom. `defaut` est un dossier de repli, pas
        // un compte : il ne s'affiche pas comme s'il en était un.
        accounts: nommerComptes(user.id, m.id, comptesParService.get(m.id) || []),
        // Ce qu'on peut dire des secrets enregistrés sans les dévoiler : date
        // et échéance d'une session, éléments découverts, sélection en cours.
        configSummary: install ? configSummary(user.id, m.id) : null,
      };
      // L'état ET l'action qui le résout, calculés UNE fois côté serveur : la
      // fiche, l'accueil et l'écran d'erreur ne peuvent pas en dire trois
      // choses différentes (voir connectors/health.js).
      connector.health = health.summarize(connector);

      // Le message BRUT ne franchit pas la frontière (lot 14, §2.2). Il a
      // servi à `health`, qui en tire une phrase rattachée à CE connecteur ;
      // au-delà, c'est une chaîne stockée dont rien ne garantit qu'elle parle
      // du service affiché. `health.detail` le remplace partout.
      delete connector.lastError;
      return connector;
    });
}

/**
 * Les comptes d'un service, avec leur nom quand la découverte en connaît un.
 *
 * « 854637 » ne dit rien à personne ; « Koody » se reconnaît d'un coup d'œil.
 * Les deux sont affichés — le nom pour reconnaître, l'identifiant pour lever le
 * doute entre deux comptes qui se ressemblent, et parce que c'est lui qui nomme
 * le dossier sur le stockage.
 *
 * @returns {Array<{id: string, name: string|null, count: number}>}
 */
function nommerComptes(userId, connectorId, comptes) {
  if (!comptes.length) return [];

  let noms = new Map();
  try {
    const champ = hasDiscovery(connectorId) ? discoveryField(connectorId) : null;
    const stocke = champ ? discovery.read(userId, connectorId, champ.key) : null;
    for (const item of stocke?.items || []) {
      const nom = String(item?.label || '').trim();
      if (nom && nom !== String(item.id)) noms.set(String(item.id), nom);
    }
  } catch {
    // Un service sans découverte n'a pas de nom à donner : l'identifiant seul
    // fait l'affaire, c'est déjà ce que le fournisseur affiche de son côté.
    noms = new Map();
  }

  return comptes.map(({ id, count }) => ({
    id,
    name: noms.get(id) || null,
    count,
  }));
}

/**
 * Un connecteur EN ATTENTE DE TEST doit-il apparaître dans le Store de ce
 * compte ?
 *
 * ─── Le cercle que ceci brise (lot 20) ───────────────────────────────────────
 *
 * `pending` désigne un connecteur ÉCRIT mais jamais exercé contre un compte
 * réel. Jusqu'au lot 20, il était retiré du Store de TOUT LE MONDE,
 * administrateur compris. Conséquence : personne ne pouvait l'installer, donc
 * personne ne pouvait saisir d'identifiants, donc il ne pouvait jamais être
 * testé — donc il ne quittait jamais l'état « en attente de test ». Le
 * garde-fou empêchait exactement le geste qui devait le lever.
 *
 * L'administrateur le voit donc désormais, et lui seul. C'est le compte qui
 * décide de ce que l'installation propose : lui faire essayer un connecteur
 * neuf est son rôle, et il est la seule personne à qui un service qui échoue
 * n'apprend rien de faux sur crabe.
 *
 * ⚠ Un compte ORDINAIRE continue de ne rien voir. La promesse tient : tant
 * qu'aucune facture réelle n'a été récupérée, le service n'est proposé à
 * personne d'autre. L'interface marque la tuile en clair — ce n'est pas une
 * disponibilité déguisée.
 */
function voitLesEnAttente(manifest, user) {
  if (manifest.catalogStatus !== 'pending') return true;
  return user?.role === 'admin';
}

/**
 * Installe un connecteur pour un utilisateur (statut « configuration requise »).
 * La planification du couple est créée dans la foulée : c'est l'installation,
 * et elle seule, qui fait exister une planification (lot 3, §6).
 */
function install(userId, connectorId) {
  get(connectorId); // lève si inconnu
  assertInstallable(connectorId, 'installé');
  db.get()
    .prepare(
      `INSERT INTO connector_installs (user_id, connector_id, status)
       VALUES (?, ?, 'needs-config')
       ON CONFLICT(user_id, connector_id) DO NOTHING`
    )
    .run(userId, connectorId);
  schedules.ensureForInstall(userId, connectorId);
  return getInstall(userId, connectorId);
}

/**
 * Désinstalle, efface la configuration chiffrée et retire la planification.
 * Les éléments découverts partent aussi : ce sont des données personnelles
 * (numéros de ligne, noms de titulaires) qui n'ont plus de raison d'être.
 */
function uninstall(userId, connectorId) {
  const res = db
    .get()
    .prepare('DELETE FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .run(userId, connectorId);
  schedules.removeForInstall(userId, connectorId);
  discovery.forget(userId, connectorId);
  return res.changes > 0;
}

function getInstall(userId, connectorId) {
  return db
    .get()
    .prepare('SELECT * FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(userId, connectorId);
}

function listInstalls(userId) {
  return db
    .get()
    .prepare('SELECT * FROM connector_installs WHERE user_id = ? ORDER BY installed_at')
    .all(userId);
}

/**
 * La configuration chiffrée d'un connecteur est-elle ILLISIBLE ?
 *
 * Miroir de `destinations.configIllisible()` — même piège, même réponse. Le
 * repli de `tryDecryptJson` rend la même valeur pour « aucune configuration »
 * et pour « déchiffrement en échec » (phrase secrète absente ou changée) :
 * deux situations opposées, indiscernables sans cette sentinelle. Vrai
 * uniquement quand une configuration EXISTE et ne se déchiffre pas.
 */
function configIllisible(userId, connectorId) {
  const install = getInstall(userId, connectorId);
  if (!install?.config_encrypted) return false;
  const SENTINELLE = { __dechiffrementEchoue: true };
  return crypto.tryDecryptJson(install.config_encrypted, SENTINELLE) === SENTINELLE;
}

/**
 * Clé réservée de la configuration chiffrée : ce qui décrit un secret sans le
 * dévoiler. Aujourd'hui, le résumé des champs de type `session` (date
 * d'enregistrement, échéance) — la seule chose que l'interface reçoit en
 * retour, le contenu ne ressortant jamais.
 */
const META_KEY = '__meta';

/**
 * Les types de champ que l'interface a le droit de RELIRE en clair.
 *
 * ─── Pourquoi une liste positive (lot 14, §8) ────────────────────────────────
 *
 * En rouvrant la fiche d'un service déjà configuré, le champ « Adresse
 * électronique » revenait vide : rien ne disait quel compte était enregistré,
 * et il fallait croire qu'on devait tout ressaisir. Ces champs-là n'ont rien de
 * secret — c'est même leur affichage qui permet de vérifier qu'on a configuré
 * le bon compte.
 *
 * La liste est **positive** : `password` et `session` n'y sont pas, et un type
 * ajouté demain ne s'y trouvera pas non plus. Une liste négative
 * (« tout sauf password ») ferait fuiter le premier type secret que quelqu'un
 * oublierait d'y inscrire.
 */
const TYPES_RELISIBLES = ['text', 'email', 'url', 'tel', 'number', 'select'];

/**
 * Enregistre la configuration d'un connecteur (chiffrée au repos).
 * Les champs laissés vides conservent leur valeur précédente : l'UI n'envoie
 * jamais les mots de passe déjà stockés.
 *
 * Trois formes de valeur, selon le type de champ :
 *   - texte, mot de passe, session → une chaîne ;
 *   - `session` → contrôlée avant écriture (JSON bien formé, au moins un
 *     cookie encore valable), et résumée dans `__meta` ;
 *   - `multiselect` → un tableau d'identifiants. Un tableau VIDE est une
 *     valeur à part entière (« aucun élément retenu »), à ne pas confondre
 *     avec l'absence de valeur (« jamais choisi »).
 */
function saveConfig(userId, connectorId, values) {
  assertInstallable(connectorId, 'configuré');
  const { manifest: mf } = get(connectorId);
  const existing = getInstall(userId, connectorId);

  // ─── La garde contre le repli silencieux (lot 45) ─────────────────────────
  //
  // Ici, confondre « pas de configuration » et « configuration indéchiffrable »
  // DÉTRUIT : fusionner les valeurs reçues avec un `previous` vide, puis
  // rechiffrer, remplacerait toute la configuration existante par le seul
  // formulaire du jour — mots de passe et session capturée compris, en
  // silence. On refuse d'écrire par-dessus ce qu'on ne sait pas relire.
  if (configIllisible(userId, connectorId)) {
    const err = new Error(
      'La configuration enregistrée de ce service ne peut plus être déchiffrée '
        + '(la phrase secrète du serveur a changé ?). Enregistrer par-dessus l\'effacerait : '
        + 'restaurez la phrase secrète d\'origine, ou désinstallez puis reconfigurez ce service.'
    );
    err.statusCode = 409;
    throw err;
  }

  const previous = existing?.config_encrypted
    ? crypto.tryDecryptJson(existing.config_encrypted, {})
    : {};

  const merged = {};
  const meta = { ...(previous?.[META_KEY] || {}) };
  const missing = [];
  for (const field of mf.fields) {
    const incoming = values?.[field.key];

    if (field.type === 'history') {
      // Normalisé à l'écriture : ce qui entre en base est toujours une valeur
      // que `history.parse()` relira à l'identique, quoi qu'ait envoyé le
      // client. Rien reçu = la valeur enregistrée, sinon le défaut du champ.
      const brut = incoming === undefined || incoming === null || incoming === ''
        ? previous[field.key] ?? field.default
        : incoming;
      merged[field.key] = history.format(brut);
      continue;
    }

    if (field.type === 'multiselect') {
      const value = Array.isArray(incoming)
        ? discovery.normalizeItems(incoming.map((id) => ({ id }))).map((i) => i.id)
        : previous[field.key];
      if (Array.isArray(value)) merged[field.key] = value;
      else if (field.required) missing.push(field.label);
      continue;
    }

    if (field.type === 'session') {
      const provided = typeof incoming === 'string' ? incoming.trim() : '';
      if (!provided) {
        // Rien de nouveau : la session déjà enregistrée reste en place.
        if (previous[field.key]) merged[field.key] = previous[field.key];
        else if (field.required) missing.push(field.label);
        continue;
      }
      const checked = sessionState.validate(provided);
      if (!checked.ok) {
        const err = new Error(`${field.label} — ${checked.error}`);
        err.statusCode = 400;
        throw err;
      }
      // Réécrit depuis l'objet analysé : ni indentation d'origine, ni clé
      // parasite ajoutée à la main dans le fichier.
      merged[field.key] = JSON.stringify(checked.state);
      meta[field.key] = { type: 'session', ...checked.summary, savedAt: new Date().toISOString() };
      continue;
    }

    const value =
      incoming === undefined || incoming === null || incoming === ''
        ? previous[field.key]
        : String(incoming);
    if (value !== undefined && value !== null && value !== '') merged[field.key] = value;
    else if (field.required) missing.push(field.label);
  }

  if (Object.keys(meta).length) merged[META_KEY] = meta;

  if (missing.length) {
    const err = new Error(`Champs obligatoires manquants : ${missing.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  db.get()
    .prepare(
      `INSERT INTO connector_installs (user_id, connector_id, status, config_encrypted, last_error)
       VALUES (?, ?, 'installed', ?, NULL)
       ON CONFLICT(user_id, connector_id)
       DO UPDATE SET config_encrypted = excluded.config_encrypted,
                     status = 'installed',
                     last_error = NULL`
    )
    .run(userId, connectorId, crypto.encrypt(merged));

  // Identifiant de compte déductible de la configuration : on le pose tout de
  // suite, le premier test()/fetchInvoices() réussi le confirmera ou l'affinera.
  const derived = accountIds.fromConfig(mf, merged);
  if (derived) recordAccountId(userId, connectorId, derived);

  return getInstall(userId, connectorId);
}

/**
 * Mémorise l'identifiant de compte d'une installation.
 * @param {number} userId
 * @param {string} connectorId
 * @param {string} accountId
 */
function recordAccountId(userId, connectorId, accountId) {
  const clean = accountIds.normalize(accountId);
  if (!clean) return null;
  db.get()
    .prepare('UPDATE connector_installs SET account_id = ? WHERE user_id = ? AND connector_id = ?')
    .run(clean, userId, connectorId);
  return clean;
}

/**
 * Identifiant de compte à utiliser pour un dépôt : ce que le connecteur vient
 * de remonter, sinon la configuration, sinon la valeur déjà en base, sinon
 * « defaut » — jamais un échec.
 */
function accountIdFor(userId, connectorId, config, reported = null) {
  return accountIds.resolve({
    manifest: manifest(connectorId),
    config,
    reported,
    stored: getInstall(userId, connectorId)?.account_id,
  });
}

/** Configuration déchiffrée d'une installation. */
function readConfig(userId, connectorId) {
  const install = getInstall(userId, connectorId);
  if (!install) {
    const err = new Error(`Connecteur « ${connectorId} » non installé pour cet utilisateur.`);
    err.statusCode = 404;
    throw err;
  }
  if (!install.config_encrypted) {
    const err = new Error(`Connecteur « ${connectorId} » non configuré.`);
    err.statusCode = 400;
    throw err;
  }
  return crypto.decryptJson(install.config_encrypted);
}

// ---------------------------------------------------------------------------
// Découverte (lot 5)
//
// Contrat de connecteur, entre test() et fetchInvoices() :
//
//   async discover(config, ctx) → { items: [{ id, label, badge, detail,
//                                             preselected }] }
//
// Facultative. Un connecteur qui ne l'implémente pas se comporte comme avant.
// Elle sert à peupler un champ de manifeste de type `multiselect` dont les
// options ne sont connues qu'après connexion : les quatre lignes d'un compte
// Free Mobile, les points de livraison d'un compte EDF, les comptes d'une
// banque.
// ---------------------------------------------------------------------------

/** Le connecteur propose-t-il une étape de découverte exploitable ? */
function hasDiscovery(connectorId) {
  const entry = registry.get(connectorId);
  if (!entry) return false;
  return (
    typeof entry.module.discover === 'function'
    && schema.discoveredFields(entry.manifest).length > 0
  );
}

/** Champ de manifeste alimenté par la découverte (le premier déclaré). */
function discoveryField(connectorId) {
  return schema.discoveredFields(manifest(connectorId))[0] || null;
}

/**
 * Lance la découverte pour un utilisateur et mémorise le résultat.
 *
 * L'appel est long (20 à 60 secondes chez Free Mobile : un navigateur s'ouvre,
 * se connecte et déplie un menu), d'où l'état d'attente explicite côté
 * interface.
 *
 * @returns {Promise<{field: object, items: Array<object>, selection: string[]}>}
 */
async function discoverForUser(userId, connectorId, ctx = {}) {
  assertInstallable(connectorId, 'exploré');
  const { module: mod } = get(connectorId);
  const field = discoveryField(connectorId);
  if (!field || typeof mod.discover !== 'function') {
    const err = new Error(`Le connecteur « ${connectorId} » n'a pas d'étape de découverte.`);
    err.statusCode = 400;
    throw err;
  }

  assertScrapingAllowed(connectorId);
  const config = readConfig(userId, connectorId);
  // Même règle que `testForUser` : l'utilisateur reçu en paramètre est injecté
  // ici même, APRÈS `...ctx`, pour qu'aucun appelant distrait ne puisse le
  // perdre ni l'écraser — sans lui, un connecteur à profil de navigateur
  // persistant ne retrouve pas son profil et la découverte échoue.
  const raw = await mod.discover(config, makeContext({ ...ctx, userId }, connectorId));

  // Même rapprochement que pendant une récupération, volontairement : un
  // élément découvert ici rejoint la sélection tout de suite, et y reste même
  // si l'utilisateur quitte l'écran de sélection sans valider. Le laisser
  // dépendre d'un clic reviendrait à le perdre définitivement — il ne serait
  // plus « jamais vu » au passage suivant.
  const outcome = makeReconciler(userId, connectorId, (message) => ctx.log?.(message))(
    field.key,
    discovery.normalizeItems(raw?.items)
  );

  return {
    field,
    items: outcome.items,
    selection: outcome.selection,
    added: outcome.added,
    missing: outcome.missing,
  };
}

/**
 * Fabrique le `reconcile()` passé aux connecteurs dans leur contexte.
 *
 * Le connecteur redécouvre de toute façon les éléments au cours de sa
 * récupération : plutôt que de refaire une passe complète, il annonce ce qu'il
 * a vu et reçoit en retour la sélection à traiter. Le socle se charge du reste
 * — mémoriser, ajouter les nouveautés, avertir des disparitions.
 *
 * @returns {(fieldKey: string, discovered: Array<object>) => {selection: string[], added: string[], missing: string[], active: Array<object>, items: Array<object>}}
 */
function makeReconciler(userId, connectorId, log = () => {}) {
  return (fieldKey, discovered) => {
    const key = fieldKey || discoveryField(connectorId)?.key;
    if (!key) return { selection: [], added: [], missing: [], active: [], items: [] };

    const install = getInstall(userId, connectorId);
    const config = install?.config_encrypted
      ? crypto.tryDecryptJson(install.config_encrypted, {})
      : {};
    const known = discovery.read(userId, connectorId, key);

    const outcome = discovery.reconcile({
      known: known?.items || null,
      discovered,
      selection: Array.isArray(config?.[key]) ? config[key] : null,
    });

    // Fusion, pas écrasement : une récupération redécouvre les éléments sans
    // en recalculer le détail (« 12 factures » coûterait une bascule par ligne
    // pour une information qui ne sert qu'à l'écran de sélection).
    const items = discovery.save(
      userId,
      connectorId,
      key,
      discovery.merge(known?.items || null, discovered)
    );

    // La sélection élargie retourne dans la configuration chiffrée : sans ça,
    // la nouveauté serait redécouverte — et re-signalée — à chaque exécution.
    //
    // ⚠ Sauf configuration ILLISIBLE (lot 45) : `config` vaut alors le repli
    // `{}` de `tryDecryptJson`, et réécrire `{...config, [key]: ...}` viderait
    // la configuration entière — identifiants et session — pour n'y laisser
    // que la sélection. Rien n'est réécrit, et la ligne de journal le dit.
    if (install?.config_encrypted && configIllisible(userId, connectorId)) {
      log(
        `${connectorId} : configuration chiffrée illisible — sélection non réécrite, `
          + 'rien n\'est écrasé'
      );
    } else if (install?.config_encrypted && !sameIds(config?.[key], outcome.selection)) {
      db.get()
        .prepare('UPDATE connector_installs SET config_encrypted = ? WHERE user_id = ? AND connector_id = ?')
        .run(crypto.encrypt({ ...config, [key]: outcome.selection }), userId, connectorId);
    }

    for (const id of outcome.added) {
      log(`${connectorId} : nouvelle ligne ${id} détectée et ajoutée`);
    }
    for (const id of outcome.missing) {
      log(
        `${connectorId} : ${id} ne figure plus chez le fournisseur — conservé en configuration, `
          + 'ignoré pour cette exécution'
      );
    }

    // `items` : la liste telle qu'elle vient d'être enregistrée, détails
    // conservés — c'est elle que l'écran de sélection affiche.
    return { ...outcome, items };
  };
}

function sameIds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

/**
 * Ce que l'interface peut savoir d'une configuration enregistrée — et rien de
 * plus. Aucun mot de passe, aucun contenu de session : la date
 * d'enregistrement et l'échéance d'une session, les éléments découverts et la
 * sélection en cours.
 */
function configSummary(userId, connectorId) {
  const install = getInstall(userId, connectorId);
  if (!install?.config_encrypted) return null;

  const config = crypto.tryDecryptJson(install.config_encrypted, null);
  if (!config) return null;

  const mf = manifest(connectorId);
  // `settings` : les réglages non secrets, que l'interface a le droit de
  // relire tels quels pour recocher le bon choix. Aujourd'hui la profondeur
  // d'historique, demain tout réglage du même genre.
  //
  // `values` : les champs de SAISIE non secrets — adresse électronique,
  // identifiant, adresse du site. Lot 14, §8 : en rouvrant la fiche d'un
  // service déjà configuré, le champ « Adresse électronique » était vide.
  // l'administrateur ne savait donc pas quel compte était enregistré, et croyait devoir
  // tout ressaisir. Un mot de passe, lui, ne ressort jamais.
  const summary = { sessions: {}, discoveries: {}, settings: {}, values: {} };

  for (const field of mf.fields) {
    // ⚠ La liste est POSITIVE : seuls les types énumérés ici ressortent. Un
    // type ajouté demain est secret par défaut, ce qui est le bon sens du
    // refus — l'inverse ferait fuiter un secret à la première distraction.
    if (TYPES_RELISIBLES.includes(field.type)) {
      const valeur = config[field.key];
      if (typeof valeur === 'string' && valeur !== '') summary.values[field.key] = valeur;
      continue;
    }
    if (field.type === 'history') {
      summary.settings[field.key] = require('./history').format(
        config[field.key] || field.default
      );
      continue;
    }
    if (field.type === 'session') {
      const meta = config[META_KEY]?.[field.key] || null;
      summary.sessions[field.key] = meta
        ? {
            savedAt: meta.savedAt || null,
            expiresAt: meta.expiresAt || null,
            cookieCount: meta.cookieCount || 0,
            expired: sessionState.isExpired(meta),
          }
        // Session enregistrée avant que le résumé n'existe : on dit ce qu'on
        // sait — elle est là — sans inventer de date.
        : config[field.key] ? { savedAt: null, expiresAt: null, cookieCount: 0, expired: false } : null;
      continue;
    }
    if (schema.isDiscoveredField(field)) {
      const stored = discovery.read(userId, connectorId, field.key);
      summary.discoveries[field.key] = {
        items: stored?.items || [],
        updatedAt: stored?.updatedAt || null,
        selection: Array.isArray(config[field.key]) ? config[field.key] : null,
      };
    }
  }

  return summary;
}

/**
 * Contexte passé aux connecteurs.
 *
 * `connectorId` et `manifest` sont arrivés au lot 12, pour les IMPLÉMENTATIONS
 * PARTAGÉES : un connecteur PrestaShop sert sept boutiques, et il n'a aucun
 * autre moyen de savoir laquelle — les adresses vivent dans le manifeste, pas
 * dans la configuration chiffrée de l'utilisateur.
 */
function makeContext(extra = {}, connectorId = null) {
  return {
    // Le journal du connecteur va en base (lot 41) : les lignes `[connector]`
    // ne vivaient que dans journalctl — une soirée de diagnostic perdue le
    // 19/08/2026 faute de pouvoir les relire à l'écran. `util.format` produit
    // exactement le texte que `console.log` aurait écrit ; applog.connector
    // garde la sortie standard intacte et ajoute la ligne dans app_logs.
    log: (...args) => {
      require('../applog').connector(
        connectorId,
        require('node:util').format(...args),
        { userId: extra?.userId ?? null }
      );
    },
    fetch: globalThis.fetch,
    connectorId,
    manifest: connectorId && has(connectorId) ? manifest(connectorId) : null,
    // Le PLAFOND de ce que les connecteurs iront chercher, en mois (0 = aucun).
    // Sans lui, crabe télécharge des documents que l'entretien de la nuit
    // effacera — 118 PDF perdus ainsi le 13/08/2026, voir connectors/history.js.
    //
    // ⚠ Ce n'est PAS la profondeur de conservation brute (lot 26). Tant qu'un
    // plancher protège l'existant, le nettoyage n'efface rien d'ancien, et
    // refuser d'aller le chercher privait l'utilisateur de documents que crabe
    // aurait gardés : Hetzner s'arrêtait à août 2025 quand le fournisseur
    // propose depuis 2019. `retention.fetchCapMonths()` tient les deux gestes
    // sur la même règle. Lu ici et une seule fois par exécution, pour que
    // `history.js` reste pur et vérifiable sans base.
    conservationMois: profondeurDeConservation(),
    ...extra,
  };
}

/**
 * Le plafond de récupération en mois, ou 0 s'il est indisponible.
 *
 * Enveloppée dans un `try` volontairement : une base pas encore ouverte (un
 * test unitaire qui appelle un connecteur à la main) ne doit pas empêcher une
 * récupération. Se tromper ici du côté de 0 est le bon sens du risque —
 * « aucun plafond » rend le comportement d'avant le lot 24, jamais une fenêtre
 * plus courte que ce que l'utilisateur a demandé.
 */
function profondeurDeConservation() {
  try {
    return Number(require('../retention').fetchCapMonths()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Refuse d'ouvrir un navigateur quand `CRABE_DISABLE_SCRAPING=1`.
 *
 * Les recettes génériques (connectors/scraping.js) n'ont pas besoin de cette
 * barrière : elles portent un `recipe` et retombent d'elles-mêmes sur leur
 * mode simulé. Les connecteurs SUR MESURE — `free`, `free-mobile` — n'ont pas
 * ce repli : eux ouvrent vraiment un navigateur vers le portail du
 * fournisseur, et il faut les arrêter en amont.
 *
 * Sert dans les tests (aucun ne doit joindre un site réel) et donne à
 * l'exploitation un interrupteur franc pour couper toute sortie vers
 * l'extérieur sans désinstaller Playwright.
 */
function assertScrapingAllowed(connectorId) {
  if (!require('../config').config.scrapingDisabled) return;
  const entry = get(connectorId);
  if (entry.manifest.implementation !== 'scraping' || entry.module.recipe) return;
  throw new Error(
    `Le scraping est désactivé sur cette installation (CRABE_DISABLE_SCRAPING=1) : `
      + `« ${entry.manifest.name} » ne peut pas ouvrir de navigateur vers ${entry.manifest.site || 'son portail'}.`
  );
}

/**
 * Vérification d'authentification légère, sans téléchargement.
 * @param {string} connectorId
 * @param {object} config identifiants en clair
 * @returns {Promise<{ok: boolean, message: string, invoiceCount?: number}>}
 */
async function test(connectorId, config, ctx = {}) {
  const { module: mod } = get(connectorId);
  try {
    assertInstallable(connectorId, 'testé');
    assertScrapingAllowed(connectorId);
    const result = await mod.test(config, makeContext(ctx, connectorId));
    return {
      ok: !!result?.ok,
      // Un échec muet reçoit la phrase du socle — « Échec de la connexion »
      // tout court disait ce qui a raté sans dire quoi faire (règle du
      // 14/08/2026 : un échec porte toujours un message utile).
      message:
        result?.message
        || (result?.ok ? 'Connexion réussie' : messagesEchec.messageJamaisVide('', 'test')),
      invoiceCount: result?.invoiceCount,
      // Facultatif dans le contrat de connecteur (voir account-id.js).
      accountId: accountIds.normalize(result?.accountId),
    };
  } catch (err) {
    // Le point d'écriture traduit le jargon d'automatisation (lot 37) : le
    // texte brut part au journal technique, l'écran reçoit une phrase lisible.
    return {
      ok: false,
      message: messagesEchec.messageJamaisVide(err.message, 'test', (brut) =>
        require('../applog').warn('connectors', `${connectorId} : détail technique de l'échec — ${brut}`)),
    };
  }
}

/**
 * Teste un connecteur avec la configuration stockée d'un utilisateur.
 * Trace le résultat dans run_logs (trigger « test »).
 */
async function testForUser(userId, connectorId) {
  const config = readConfig(userId, connectorId);
  // `{ userId }`, toujours : cette fonction TIENT l'utilisateur en paramètre,
  // et ne pas le transmettre a privé les connecteurs à profil persistant de
  // leur profil (« le contexte d'exécution ne porte pas l'utilisateur »,
  // materiel-net et paybyphone, 13/08/2026 23:55, déclencheur « test »). La
  // règle vaut pour toute fonction « ForUser » de ce fichier : celui qui
  // connaît l'utilisateur le met dans le contexte, aucun appelant n'a à y
  // penser.
  const result = await test(connectorId, config, { userId });

  // Un test réussi est le premier moment fiable pour connaître l'identifiant
  // de compte (le nichandle OVH, par exemple, ne vient que de l'API).
  if (result.ok) {
    recordAccountId(userId, connectorId, accountIdFor(userId, connectorId, config, result.accountId));
  }

  // Un test qui échoue sans un mot laisserait la fiche dire « Échec » sans
  // explication — même règle de socle que pour les récupérations (14/08/2026) :
  // si le connecteur n'a rien produit, on fabrique la phrase du geste « test ».
  const texte = result.ok
    ? result.message
    : messagesEchec.messageJamaisVide(result.message, 'test');

  db.get()
    .prepare(
      `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, message)
       VALUES (?, ?, datetime('now'), ?, 'test', ?)`
    )
    .run(connectorId, userId, result.ok ? 1 : 0, texte);

  db.get()
    .prepare(
      `UPDATE connector_installs SET status = ?, last_error = ?
        WHERE user_id = ? AND connector_id = ?`
    )
    .run(result.ok ? 'installed' : 'error', result.ok ? null : texte, userId, connectorId);

  // L'écran reçoit le MÊME texte que le journal : rendre `result` tel quel
  // recréerait la divergence qu'on vient d'interdire — un message à l'écran,
  // un autre (fabriqué) dans les logs.
  return result.message === texte ? result : { ...result, message: texte };
}

/**
 * Récupère les factures brutes auprès du fournisseur, avec l'identifiant de
 * compte quand le connecteur le remonte.
 *
 * Deux formes acceptées côté connecteur :
 *   - un tableau de factures (les éléments peuvent porter `accountId`) ;
 *   - `{ accountId, invoices: [...] }`.
 *
 * Ne s'occupe PAS du stockage : c'est le rôle de destinations/index.js.
 *
 * @returns {Promise<{invoices: Array<object>, accountId: string|null}>}
 */
async function fetchInvoicesDetailed(connectorId, config, ctx = {}) {
  const { module: mod } = get(connectorId);
  assertInstallable(connectorId, 'exécuté');
  assertScrapingAllowed(connectorId);

  // ─── « Aucune nouvelle facture » exige une PREUVE (lot 31) ────────────────
  //
  // Le 14/08/2026 à 00:01:51, materiel-net a conclu « OK — Aucune nouvelle
  // facture » en neuf secondes… sans avoir rien ouvert : la page atteinte
  // n'était pas celle des commandes, personne ne l'avait vérifié, et un
  // tableau vide est ressorti en succès. C'est le mode de panne le plus
  // dangereux du produit — silencieux, rassurant, et faux (même famille que
  // les huit faux « connexion établie » du lot 13).
  //
  // La règle, tenue ICI parce que tous les chemins d'exécution y passent :
  // un connecteur qui ne rapporte AUCUN document téléchargé doit avoir déposé
  // une preuve positive via `ctx.preuveDeListe({ session, liste, elements })`
  // — le marqueur qui atteste la session (nom du compte, lien de déconnexion,
  // réponse d'API authentifiée) et la liste de documents effectivement lue,
  // fût-elle vide. L'absence d'erreur n'est pas une preuve. Sans dépôt, le
  // résultat est un échec explicite, jamais un succès à zéro document.
  //
  // L'enregistreur est posé APRÈS makeContext pour qu'aucun appelant ne
  // puisse fournir le sien : la preuve se constate, elle ne s'injecte pas.
  let preuveDeposee = null;
  const contexte = makeContext(ctx, connectorId);
  contexte.preuveDeListe = (info) => {
    const liste = String(info?.liste || '').trim();
    const session = String(info?.session || '').trim();
    const elements = Number(info?.elements);
    // Une demi-preuve n'est pas une preuve : les trois morceaux, ou rien.
    if (!liste || !session || !Number.isInteger(elements) || elements < 0) return;
    preuveDeposee = { session, liste, elements };
  };

  const raw = await mod.fetchInvoices(config, contexte);

  const invoices = Array.isArray(raw) ? raw : raw?.invoices;
  if (!Array.isArray(invoices)) {
    throw new Error(
      `${connectorId}: fetchInvoices() doit renvoyer un tableau ou { accountId, invoices }`
    );
  }

  // Un document réellement téléchargé prouve à lui seul que la liste a été
  // atteinte ; c'est le zéro-document qui n'a pas le droit d'être muet.
  if (!invoices.some((i) => i?.buffer) && !preuveDeposee) {
    const nom = has(connectorId) ? manifest(connectorId).name : connectorId;
    throw new Error(
      `${nom} s'est arrêté sans avoir pu confirmer l'accès à la liste des documents : `
        + 'impossible de dire s\'il y a de nouvelles factures. Rien n\'a été perdu — '
        + 'relancez la récupération ; si le message revient, ouvrez la fiche du '
        + 'connecteur et refaites la connexion.'
    );
  }
  if (preuveDeposee) {
    contexte.log?.(
      `${connectorId} : liste des documents confirmée — ${preuveDeposee.liste}, `
        + `${preuveDeposee.elements} élément(s), session attestée par ${preuveDeposee.session}.`
    );
  }

  // ─── La couverture d'historique, attestée par le connecteur (lot 33) ──────
  //
  // « Tout l'historique disponible a été parcouru » ne peut pas être une
  // formule automatique : le 14/08/2026, materiel-net l'a laissée s'écrire en
  // n'ayant lu que les six derniers mois. Un connecteur qui SAIT ce qu'il a
  // couvert le déclare (`couverture: { complete, detail }`) ; sans
  // déclaration, le socle n'affirme rien.
  const couvertureBrute = Array.isArray(raw) ? null : raw?.couverture;
  const couverture =
    couvertureBrute && typeof couvertureBrute === 'object'
      ? {
          complete: couvertureBrute.complete === true,
          detail: String(couvertureBrute.detail || '').trim(),
        }
      : null;

  // ─── « Ce service ne délivre pas de facture téléchargeable » (lot 41) ─────
  //
  // « Aucune nouvelle facture » recouvrait DEUX réalités : « tout était déjà
  // récupéré » (légitime, et ce cas ne change pas) et « le service n'offre
  // AUCUN document téléchargeable » — la seconde ressemblait à une panne, et
  // le 19/08/2026 une soirée a été perdue à la diagnostiquer. Le connecteur
  // qui SAIT que la liste atteinte ne propose aucun document le déclare
  // (`aucunDocument`, une phrase complète prête pour l'écran) ; le
  // planificateur l'affiche à la place du message générique. La déclaration
  // ne décrit que le vide : dès qu'un document est descendu, elle est ignorée.
  const aucunDocument =
    invoices.length === 0
      ? String((Array.isArray(raw) ? '' : raw?.aucunDocument) || '').trim() || null
      : null;

  // ─── « Ils existent, mais ils sont plus vieux que ça » (lot 42) ───────────
  //
  // Le troisième cas, mesuré sur SoundCloud le 19/08/2026 : 24 reçus vus, 0
  // rapporté, tous antérieurs à la période demandée — et l'écran disait
  // « Aucune nouvelle facture ». Le connecteur qui SAIT que tout ce qu'il a vu
  // est hors fenêtre le déclare (`horsPeriode`, phrase complète), et le
  // planificateur l'affiche. Même règle de retenue que `aucunDocument` : dès
  // qu'un document est descendu, la déclaration est ignorée.
  const horsPeriode =
    invoices.length === 0
      ? String((Array.isArray(raw) ? '' : raw?.horsPeriode) || '').trim() || null
      : null;

  return {
    invoices,
    couverture,
    aucunDocument,
    horsPeriode,
    accountId: accountIds.normalize(Array.isArray(raw) ? null : raw?.accountId) ||
      accountIds.fromInvoices(invoices),
  };
}

/** Forme historique : le seul tableau de factures. */
async function fetchInvoices(connectorId, config, ctx = {}) {
  return (await fetchInvoicesDetailed(connectorId, config, ctx)).invoices;
}

module.exports = {
  AVAILABLE_DIR,
  PLANNED_DIR,
  SHARED_IMPLEMENTATIONS,
  META_KEY,
  TYPES_RELISIBLES,
  load,
  syncCatalog,
  has,
  isPlanned,
  assertInstallable,
  get,
  manifest,
  listAll,
  listAvailable,
  listPlanned,
  listForUser,
  isAllowedForUser,
  voitLesEnAttente,
  parseAllowed,
  install,
  uninstall,
  getInstall,
  listInstalls,
  configIllisible,
  saveConfig,
  readConfig,
  test,
  testForUser,
  fetchInvoices,
  fetchInvoicesDetailed,
  recordAccountId,
  accountIdFor,
  hasDiscovery,
  discoveryField,
  discoverForUser,
  makeReconciler,
  configSummary,
  // `size` ne compte QUE les connecteurs réels : c'est lui que les
  // statistiques d'administration affichent sous « connecteurs disponibles »,
  // et un service annoncé n'en est pas un.
  get size() {
    return registry.size;
  },
  get plannedSize() {
    return planned.size;
  },
  get errors() {
    return [...loadErrors];
  },
};
