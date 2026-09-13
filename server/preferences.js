'use strict';

/**
 * Préférences d'interface, par compte.
 *
 * Ce que `localStorage` ne sait pas faire : suivre un administrateur d'un
 * poste à l'autre. Un filtre d'écran mémorisé « par administrateur » doit
 * l'être sur le compte, pas sur le navigateur — sinon la mémoire disparaît au
 * premier changement de machine ou de session privée.
 *
 * Fourre-tout assumé (clé / valeur JSON), pour les réglages qui n'ont aucune
 * raison d'occuper une colonne de `users`. Les valeurs sont bornées à ce que
 * l'appelant déclare : une clé inconnue est refusée, une valeur illisible
 * retombe sur le défaut.
 */

const db = require('./db/db');

/**
 * Écrans qui proposent une bascule **Cartes / Liste**.
 *
 * Les cartes sont le défaut partout : elles donnent l'essentiel d'un coup d'œil
 * — logo, nom, état, deux ou trois informations, actions —, ce qu'une ligne de
 * tableau ne fait pas. La liste reste pour qui veut comparer beaucoup
 * d'éléments à la fois.
 */
const VIEW_SCREENS = [
  'apps', // Paramètres → Applications
  'logos', // Paramètres → Applications → Logos
  'cron', // Paramètres → Automatisation
  'roles', // Paramètres → Permissions
  'users', // Paramètres → Utilisateurs
  'support', // Paramètres → Support
  'profil-connecteurs', // Profil → Connecteurs installés
  'profil-permissions', // Profil → Permissions
  'documents', // Mes documents (lot 18)
  // ─── Les deux blocs de l'accueil (lot 20) ───────────────────────────────
  //
  // Deux écrans à part entière du point de vue de ce réglage, et surtout PAS
  // « documents » : le bloc « Derniers documents » de l'accueil et l'écran
  // « Mes documents » montrent des choses différentes — dix lignes récentes
  // d'un côté, l'arborescence complète de l'autre — et se règlent
  // indépendamment. Les faire partager une clé, c'est faire basculer l'un en
  // réglant l'autre, sans que rien ne l'annonce.
  'home-sync', // Accueil → bloc « Synchronisation »
  'home-documents', // Accueil → bloc « Derniers documents »
];

/**
 * Écrans dont le tableau est triable, et dont le tri est mémorisé.
 *
 * Un tri se refait à chaque visite s'il n'est pas retenu — et il est retenu
 * PAR COMPTE, pas par navigateur : un administrateur retrouve son classement
 * d'un poste à l'autre, ce que `localStorage` ne sait pas faire.
 */
const SORT_SCREENS = [
  'users',
  'apps',
  'logos',
  'cron',
  'roles',
  'support',
  'documents',
  'logs-runs', // Logs → Connecteurs
  'logs-app', // Logs → Application
  'logs-storage', // Logs → Stockage
  'logs-connexions', // Sécurité → Logs de connexion
];

const VIEW_MODES = ['cards', 'list'];

/** Forme d'un tri mémorisé : « clé:sens ». Vide = le tri par défaut de l'écran. */
const SORT_PATTERN = /^[a-z][\w-]{0,39}:(asc|desc)$/i;

/**
 * Clés connues, avec leur valeur par défaut. Toute clé absente d'ici est
 * refusée : la table ne doit pas devenir une décharge.
 */
const KEYS = {
  /** Paramètres → Applications : masquer les applications non actives. */
  'apps.hideInactive': false,
  /**
   * Store : n'afficher que les services réellement disponibles.
   *
   * Mémorisé par COMPTE, comme les tris : quelqu'un qui vient installer plutôt
   * que parcourir ne doit pas recocher la case à chaque visite, ni la
   * retrouver cochée sur un autre poste et pas sur celui-ci.
   */
  'store.availableOnly': false,
  /**
   * « Mes documents » : les comptes REPLIÉS, par « connecteur/compte ».
   *
   * On mémorise ce qui est fermé, pas ce qui est ouvert : un connecteur
   * installé demain arrive donc déplié, sans que personne ait à le chercher.
   *
   * Par COMPTE et non dans le navigateur : avec 186 documents et plusieurs
   * connecteurs, on replie ce qu'on ne consulte pas, et le retrouver déplié au
   * changement de poste annulerait tout le bénéfice.
   */
  'documents.collapsed': [],
  /**
   * Être prévenu quand une récupération PLANIFIÉE échoue (lot 26).
   *
   * Deux canaux, deux clés, et un réglage PAR COMPTE — jamais une option
   * globale imposée à tout le monde : deux personnes sur la même installation
   * n'ont ni les mêmes services ni la même tolérance au courriel.
   *
   *   - `email` — la voie fiable, et la seule qui atteigne quelqu'un qui n'a
   *     pas crabe ouvert. **Activée par défaut** : un connecteur peut tomber en
   *     panne et le rester des mois sans que personne ne s'en aperçoive. Sans
   *     SMTP configuré, il ne se passe simplement rien ;
   *   - `navigateur` — un COMPLÉMENT. crabe n'a ni service worker ni
   *     notification poussée : elle ne peut apparaître que si une page de crabe
   *     est ouverte au moment où l'échec est relevé. Éteinte par défaut, parce
   *     qu'une alerte qui ne se déclenche que si on regardait déjà l'écran ne
   *     doit pas être présentée comme une surveillance.
   *
   * Les échecs d'un même passage de planification partent en UN seul message
   * (voir server/notifications.js) : ces clés ne règlent pas la fréquence.
   */
  'notifications.echecs.email': true,
  'notifications.echecs.navigateur': false,
  /**
   * Gestionnaire de logos : « tous », « avec » ou « sans ».
   *
   * Le compteur annonçait « 8 en place, 6 manquants » sur quatre-vingts
   * services, sans laisser isoler les six — les retrouver à l'œil est un
   * travail.
   */
  'logos.filter': 'tous',
  /**
   * Les destinations de stockage que CE compte ne veut pas (lot 24).
   *
   * ─── Pourquoi une liste de refus, et surtout pas une liste de choix ────────
   *
   * Parce que le défaut doit être « tout », et qu'une liste de choix ne sait
   * pas dire « tout ». Un compte qui n'a jamais touché ce réglage a une liste
   * vide : il reçoit donc toutes les destinations actives, c'est-à-dire
   * exactement le comportement d'avant ce lot. Et le jour où
   * l'administrateur active une destination de plus, elle arrive dans tous les
   * comptes sans que personne ait à recocher quoi que ce soit.
   *
   * Une liste de choix ferait l'inverse, et le ferait EN SILENCE : la nouvelle
   * destination n'y étant pas, elle ne recevrait rien, et personne ne verrait
   * qu'une copie manque. C'est précisément le genre de coupure muette que
   * crabe ne doit jamais faire.
   *
   * ⚠ Le stockage local n'y entre jamais : c'est la destination principale, la copie de
   * référence, et c'est depuis elle qu'une synchronisation relit les PDF. La
   * refuser ne priverait pas d'une copie, ça casserait le reste.
   */
  'destinations.desactivees': [],
  /**
   * Accueil : combien de lignes par page, BLOC PAR BLOC.
   *
   * ─── Pourquoi deux clés là où le lot 18 n'en posait qu'une ───────────────
   *
   * Le lot 18 avait tranché « un seul réglage pour les deux blocs » — deux
   * listes de la même page, lues du même œil. À l'usage, c'était faux : les
   * deux blocs ne portent pas la même chose. « Synchronisation » liste des
   * services (une dizaine, qu'on veut voir d'un coup) ; « Derniers documents »
   * liste des factures (des centaines, qu'on feuillette). Le même nombre ne
   * convient pas aux deux, et régler l'un déréglait l'autre.
   *
   * ⚠ L'ancienne clé `home.pageSize` a été RETIRÉE, sa valeur recopiée sur les
   * deux nouvelles (migration 24). La laisser vivre à côté aurait posé une
   * seconde vérité que plus rien ne lit : le premier qui la relirait croirait
   * qu'elle décide encore de quelque chose.
   *
   * Par compte et non dans le navigateur — comme les tris et les replis : un
   * accueil réglé sur le poste fixe doit être le même sur le téléphone.
   */
  'home.sync.pageSize': 10,
  'home.documents.pageSize': 10,
  /**
   * Accueil → bloc « Statistiques » : quels graphiques y sont dessinés.
   *
   * Un réglage INTERNE au bloc, et non deux blocs de plus dans le catalogue de
   * l'accueil : « Factures par mois » et « Répartition par service » ne sont
   * pas des blocs, ce sont deux façons de regarder les mêmes chiffres, sous
   * les compteurs qui les résument.
   *
   * Les deux par défaut — c'est ce que le lot 17 a livré, et un réglage neuf
   * ne doit rien retirer à qui n'a rien demandé. La liste vide est un choix
   * valable : le bloc garde alors ses compteurs, qui ne dépendent d'aucun
   * graphique.
   *
   * ⚠ Les trois graphiques ajoutés au lot 20 sont ABSENTS de ce défaut, et
   * c'est la même règle vue dans l'autre sens : un réglage neuf ne retire rien
   * à qui n'a rien demandé, il n'ajoute rien non plus. Un accueil ne doit pas
   * changer d'aspect parce que crabe a été mis à jour.
   */
  'home.stats.charts': ['mois', 'connecteurs'],

  /**
   * Accueil → « Statistiques » : COMMENT chacun des deux premiers graphiques
   * est dessiné.
   *
   * Deux clés plutôt qu'un objet : la table ne range que des valeurs simples,
   * et un objet demanderait sa propre validation — pour deux réglages qui
   * n'ont rien à voir l'un avec l'autre.
   *
   * Les défauts sont les dessins du lot 18 : personne ne doit voir son accueil
   * changer de forme parce qu'un choix est apparu.
   */
  /**
   * L'ORDRE des deux blocs de l'accueil qui listent des services (lot 25).
   *
   * ─── Pourquoi deux clés, et pas une seule « ordre des services » ──────────
   *
   * Même raison qu'au lot 20 pour la pagination et la bascule cartes/liste :
   * les deux blocs ne répondent pas à la même question. « Mes connecteurs »
   * sert à retrouver un service pour agir dessus — l'alphabétique y est
   * naturel. « Synchronisation » sert à voir ce qui a tourné et ce qui traîne
   * — beaucoup y voudront « dernière synchronisation ». Une clé commune ferait
   * régler l'un en déréglant l'autre, sans que rien ne l'annonce.
   *
   * Le défaut reste l'ordre alphabétique posé au lot 24 : personne ne voit son
   * accueil changer d'ordre parce que crabe a été mis à jour.
   *
   * ⚠ La liste des valeurs acceptées est tenue par `connectors/tri.js`, et
   * c'est le SERVEUR qui refuse ce qui n'y est pas (voir `refus`). Le menu
   * déroulant de l'écran est nourri par cette même liste : il ne peut donc pas
   * proposer une valeur que l'enregistrement rejetterait.
   */
  'home.connecteurs.tri': 'nom',
  'home.sync.tri': 'nom',
  'home.stats.type.mois': 'barres',
  'home.stats.type.connecteurs': 'barres',
  /**
   * La convention de nommage des documents déposés (lot 56).
   *
   * Deux formes possibles, décrites par `convention-noms.js` : avec le nom du
   * service en tête (`operateur_2026-05_100042.pdf`) ou sans lui
   * (`2026-05_100042.pdf`), le dossier portant déjà le service. Le réglage
   * vaut pour les PROCHAINS dépôts du compte ; les documents déjà déposés ne
   * bougent que par le geste séparé d'harmonisation (écran Profil → Fichiers).
   *
   * Le défaut est la convention EN VIGUEUR avant que ce réglage existe —
   * jamais une autre : un comportement ne change pas parce que crabe a été mis
   * à jour, il change parce que quelqu'un a cliqué.
   */
  'fichiers.convention': 'avec-service',
};

/**
 * Les tailles de page proposées.
 *
 * Une liste fermée plutôt qu'un nombre à taper : « 7 » n'apporte rien de plus
 * que « 10 », et un champ libre ouvre la porte au 0 et au 10 000.
 *
 * Six valeurs depuis le lot 18. Le 5 est parti : sur un écran d'accueil qui
 * porte deux listes, cinq lignes tenaient plus de l'aperçu que de la page, et
 * personne n'a réclamé plus court que dix.
 */
const PAGE_SIZES = [10, 15, 20, 25, 30, 50];

/**
 * Les graphiques du bloc « Statistiques », dans leur ordre d'affichage.
 *
 * L'ordre vient d'ici et non de ce que le navigateur envoie : deux cases
 * cochées dans un sens ou dans l'autre doivent donner le même accueil.
 */
const STATS_CHARTS = [
  'mois',
  'connecteurs',
  // ─── Les trois ajouts du lot 20 ─────────────────────────────────────────
  //
  // Chacun ne se dessine qu'à partir de données que crabe possède DÉJÀ, et
  // c'est le seul critère qui les a retenus. Le candidat « montant total par
  // mois » a été écarté pour cette raison précise : la table `invoices` n'a
  // aucune colonne de montant. Les connecteurs en rendent bien un, mais il
  // n'est jamais enregistré — le graphique aurait été vide pour tout le monde,
  // et vide pour toujours sur les documents déjà récupérés.
  'stockage', // espace occupé par service (invoices.size_bytes)
  'connecteurs-temps', // services connectés au fil du temps (connector_installs.installed_at)
  'executions', // récupérations réussies et échouées par mois (run_logs)
];

/**
 * Les représentations possibles, graphique par graphique.
 *
 * Fermée, et vérifiée côté serveur : c'est lui qui refuse, le menu du
 * navigateur ne fait que proposer. Les deux graphiques du lot 18 sont les
 * seuls concernés — les trois ajouts du lot 20 n'ont qu'une forme, celle qui
 * convient à ce qu'ils montrent, et proposer un choix qui n'en est pas un
 * serait un réglage de plus pour rien.
 */
const STATS_CHART_TYPES = {
  mois: ['barres', 'courbe'],
  connecteurs: ['barres', 'anneau'],
};

/** Les libellés des représentations, tels qu'ils s'écrivent à l'écran. */
const STATS_TYPE_LABELS = {
  barres: 'Barres',
  courbe: 'Courbe',
  anneau: 'Anneau',
};

/** Les trois états du filtre du gestionnaire de logos. */
const LOGO_FILTERS = ['tous', 'avec', 'sans'];

/**
 * Bornes de la liste des comptes repliés.
 *
 * Une préférence est une commodité, pas un entrepôt : une clé abîmée ou un
 * appel bricolé ne doit pas faire enfler la table indéfiniment.
 */
const COLLAPSED_MAX = 500;
const COLLAPSED_KEY_MAX = 200;

// Les cartes par défaut, partout.
for (const screen of VIEW_SCREENS) KEYS[`view.${screen}`] = 'cards';
// Tri vide = celui que l'écran juge sensé (le plus récent d'abord pour les
// journaux et les documents, l'ordre alphabétique pour les catalogues, les
// non-lus d'abord pour le support).
for (const screen of SORT_SCREENS) KEYS[`sort.${screen}`] = '';

function isKnown(key) {
  return Object.prototype.hasOwnProperty.call(KEYS, key);
}

/**
 * Ramène une valeur à ce que sa clé accepte.
 *
 * Une préférence d'affichage abîmée — par une version antérieure, par un appel
 * bricolé — ne doit pas casser un écran : elle retombe sur le défaut.
 */
function coerce(key, value) {
  const attendu = KEYS[key];
  if (typeof attendu === 'boolean') return !!value;

  // Un nombre hors de la liste proposée retombe sur le défaut : une page de 0
  // ligne n'afficherait rien, et une page de 10 000 n'est plus une page.
  if (typeof attendu === 'number') {
    const n = Number.parseInt(value, 10);
    return PAGE_SIZES.includes(n) ? n : attendu;
  }

  // Liste bornée, dédoublonnée, débarrassée de ce qui n'est pas une chaîne.
  if (Array.isArray(attendu)) {
    if (!Array.isArray(value)) return [...attendu];

    // Liste FERMÉE, filtrée dans l'ordre du catalogue : un identifiant inconnu
    // disparaît, et deux cases cochées dans un sens ou dans l'autre donnent le
    // même accueil. On filtre au lieu de refuser — contrairement à la taille de
    // page — parce qu'un navigateur laissé ouvert renvoie la liste qu'il a en
    // mémoire : si une version future retirait un graphique, refuser
    // bloquerait chaque clic de cet onglet au lieu de l'ignorer.
    if (key === 'home.stats.charts') return STATS_CHARTS.filter((id) => value.includes(id));

    return [
      ...new Set(
        value
          .filter((v) => typeof v === 'string' && v && v.length <= COLLAPSED_KEY_MAX)
      ),
    ].slice(0, COLLAPSED_MAX);
  }

  const texte = String(value ?? '');
  // Un type de dessin inconnu — version antérieure, base recopiée à la main —
  // retombe sur le dessin d'origine plutôt que de rendre un bloc vide.
  if (key.startsWith('home.stats.type.')) {
    const graphique = key.slice('home.stats.type.'.length);
    const permis = STATS_CHART_TYPES[graphique] || [];
    return permis.includes(texte) ? texte : attendu;
  }
  if (key.startsWith('view.')) return VIEW_MODES.includes(texte) ? texte : attendu;
  if (key.startsWith('sort.')) return SORT_PATTERN.test(texte) ? texte : '';
  if (key === 'logos.filter') return LOGO_FILTERS.includes(texte) ? texte : attendu;
  if (key === 'fichiers.convention') {
    // Une valeur inconnue retombe sur la convention en vigueur : un dépôt ne
    // doit jamais échouer parce qu'une préférence est abîmée.
    const { CONVENTION_IDS } = require('./convention-noms');
    return CONVENTION_IDS.includes(texte) ? texte : attendu;
  }
  return texte;
}

/**
 * Motif de refus d'une écriture, ou `null` si la valeur est recevable.
 *
 * ─── Pourquoi refuser ici, alors que `coerce()` sait déjà se rattraper ──────
 *
 * Les deux ne servent pas la même chose, et les confondre serait une erreur :
 *
 *   - `coerce()` protège la LECTURE. Une valeur abîmée en base — par une
 *     version antérieure, par une reprise de sauvegarde — retombe sur le défaut
 *     plutôt que de casser un écran. Se taire est la bonne réponse : personne
 *     n'est en train de demander quoi que ce soit.
 *   - `refus()` protège l'ÉCRITURE. Quelqu'un demande explicitement une valeur.
 *     La ranger en douce sur autre chose lui ferait croire qu'elle est prise en
 *     compte, et il repasserait derrière l'écran pour comprendre pourquoi rien
 *     ne change.
 *
 * Le message part tel quel à l'utilisateur : il dit ce qui a été refusé ET ce
 * qui est acceptable, sans le renvoyer chercher la liste ailleurs.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string|null}
 */
function refus(key, value) {
  // Les deux blocs de l'accueil ont chacun leur pagination, et chacune est
  // refusée de la même façon : une valeur hors liste est REFUSÉE, jamais
  // rangée en douce sur autre chose (voir le bloc ci-dessus).
  if (key === 'home.sync.pageSize' || key === 'home.documents.pageSize') {
    const n = Number(value);
    if (!PAGE_SIZES.includes(n)) {
      return (
        `Nombre de lignes par page impossible : « ${String(value)} ». ` +
        `Choisissez ${PAGE_SIZES.slice(0, -1).join(', ')} ou ${PAGE_SIZES.at(-1)}.`
      );
    }
  }

  if (key.startsWith('home.stats.type.')) {
    const graphique = key.slice('home.stats.type.'.length);
    const permis = STATS_CHART_TYPES[graphique];
    // Filet de sécurité, pas un cas courant : une clé absente de `KEYS` est
    // déjà refusée en amont par `isKnown()`. Celui-ci ne se déclenche que si
    // quelqu'un ajoute un jour `home.stats.type.<x>` aux clés SANS déclarer les
    // formes de ce graphique — le réglage serait alors accepté et n'aurait
    // aucun effet, ce qui est la pire des deux réponses.
    if (!permis) {
      return `Ce graphique n'a pas de forme au choix : « ${String(graphique)} ».`;
    }
    if (!permis.includes(String(value ?? ''))) {
      const noms = permis.map((t) => STATS_TYPE_LABELS[t] || t);
      return (
        `Forme de graphique impossible : « ${String(value)} ». ` +
        `Choisissez ${noms.slice(0, -1).join(', ')} ou ${noms.at(-1)}.`
      );
    }
  }

  // Les deux ordres de l'accueil : une valeur hors liste est REFUSÉE, avec le
  // nom des ordres possibles. Ce contrôle est le seul qui compte — un menu
  // déroulant ne protège de rien, il suffit d'une requête écrite à la main.
  if (key === 'home.connecteurs.tri' || key === 'home.sync.tri') {
    const tri = require('./connectors/tri');
    if (!tri.ORDRE_IDS.includes(String(value ?? ''))) {
      const noms = tri.ORDRES.map((o) => o.label.toLowerCase());
      return (
        `Ordre d'affichage impossible : « ${String(value)} ». `
        + `Choisissez ${noms.slice(0, -1).join(', ')} ou ${noms.at(-1)}.`
      );
    }
  }

  // La convention de nommage : une valeur hors liste est REFUSÉE, avec le nom
  // des deux formes possibles — jamais rangée en douce sur autre chose.
  if (key === 'fichiers.convention') {
    const { CONVENTIONS, CONVENTION_IDS } = require('./convention-noms');
    if (!CONVENTION_IDS.includes(String(value ?? ''))) {
      const noms = CONVENTIONS.map((c) => `« ${c.titre.toLowerCase()} »`);
      return (
        `Convention de nommage impossible : « ${String(value)} ». `
        + `Choisissez ${noms.join(' ou ')}.`
      );
    }
  }

  if (key === 'destinations.desactivees') {
    // Chargement tardif : `destinations/index.js` charge des pilotes qui
    // chargent la configuration, et la lier au module de préférences en tête
    // de fichier ferait un tour de dépendances pour une liste de noms.
    //
    // ⚠ La liste est demandée à CHAQUE contrôle depuis le lot 25 : les clouds
    // sont créés et supprimés en cours de vie du service, une liste lue une
    // fois au démarrage refuserait un cloud ajouté depuis.
    const clouds = require('./destinations').cloudIds();
    for (const id of Array.isArray(value) ? value : []) {
      if (id === 'local') {
        return (
          'La destination principale ne peut pas être refusée : c\'est elle qui garde la '
          + 'copie de référence de vos documents, et c\'est depuis elle que les copies vers '
          + 'les autres destinations sont faites.'
        );
      }
      if (!clouds.includes(String(id))) {
        return `Destination de stockage inconnue : « ${String(id)} ».`;
      }
    }
  }
  return null;
}

/**
 * Valeur d'une préférence, ou son défaut.
 * @param {number} userId
 * @param {string} key
 */
function get(userId, key) {
  if (!isKnown(key)) throw new Error(`Préférence inconnue : ${key}`);
  const row = db
    .get()
    .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
    .get(userId, key);
  if (!row) return defaut(key);
  try {
    return coerce(key, JSON.parse(row.value));
  } catch {
    // Une valeur corrompue ne doit pas casser un écran : on revient au défaut.
    return defaut(key);
  }
}

/**
 * Le défaut d'une clé, **copié**.
 *
 * Sans la copie, un appelant qui ferait `preferences.get(…).push(…)` sur une
 * valeur de type tableau modifierait la table des défauts pour tout le
 * processus — et le compte suivant hériterait de ce qu'a fait le précédent.
 */
function defaut(key) {
  const valeur = KEYS[key];
  return Array.isArray(valeur) ? [...valeur] : valeur;
}

/** Écrit une préférence et renvoie la valeur retenue. */
function set(userId, key, value) {
  if (!isKnown(key)) throw new Error(`Préférence inconnue : ${key}`);
  // Le type du défaut fait loi : un booléen reste un booléen, un mode
  // d'affichage inconnu retombe sur « cartes ».
  const typed = coerce(key, value);

  db.get()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET
         value      = excluded.value,
         updated_at = datetime('now')`
    )
    .run(userId, key, JSON.stringify(typed));

  return typed;
}

/** Toutes les préférences d'un compte, défauts compris. */
function all(userId) {
  // Copie des défauts, tableaux compris : sans le clone, un appelant qui
  // modifierait `preferences['documents.collapsed']` abîmerait la table des
  // défauts pour tout le processus.
  const out = Object.fromEntries(Object.keys(KEYS).map((k) => [k, defaut(k)]));
  for (const key of Object.keys(KEYS)) out[key] = get(userId, key);
  return out;
}

module.exports = {
  KEYS,
  VIEW_SCREENS,
  SORT_SCREENS,
  VIEW_MODES,
  LOGO_FILTERS,
  PAGE_SIZES,
  STATS_CHARTS,
  STATS_CHART_TYPES,
  STATS_TYPE_LABELS,
  COLLAPSED_MAX,
  COLLAPSED_KEY_MAX,
  SORT_PATTERN,
  isKnown,
  coerce,
  refus,
  defaut,
  get,
  set,
  all,
};
