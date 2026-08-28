'use strict';

/**
 * Validation des `manifest.json` de connecteurs.
 *
 * Pas de dépendance de validation externe : le format est petit et fermé,
 * une vérification manuelle explicite est plus lisible qu'un schéma JSON.
 */

const vocabulary = require('./permission-vocabulary');
const history = require('./history');
const identification = require('./identification');

/**
 * Les catégories du Store, dans l'ordre où elles s'affichent.
 *
 * Les cinq premières datent du lot 1 ; les neuf suivantes viennent du lot 11,
 * avec la soixantaine de services annoncés. L'ordre de cet objet EST l'ordre
 * des pastilles du Store et des blocs de la grille : « Divers » ferme la
 * marche, parce qu'une catégorie fourre-tout n'a rien à faire en tête de liste.
 *
 * Les identifiants restent courts, sans accent ni tiret, comme les cinq
 * premiers : ils vivent en base (`connector_catalog.category`), les renommer
 * demanderait une migration pour un gain nul.
 *
 * Une catégorie vide ne s'affiche pas — c'est l'interface qui l'écarte, à
 * partir de ce qu'elle reçoit (voir web/app.js, renderStore).
 */
const CATEGORIES = {
  energie: 'Énergie',
  telecom: 'Mobile & Internet',
  hebergement: 'Cloud & hébergement',
  public: 'Services publics',
  shopping: 'Shopping',
  ia: 'IA & outils créatifs',
  divertissement: 'Divertissement',
  voyage: 'Voyage & mobilité',
  sante: 'Santé & assurance',
  banque: 'Banque & paiement',
  crypto: 'Crypto-monnaies',
  administratif: 'Administratif & éducation',
  domicile: 'Domicile',
  divers: 'Divers',
};

/**
 * Types de champs d'un formulaire de connecteur.
 *
 * Deux ajouts du lot 5, conçus pour être réutilisables :
 *
 *   - `session` : un état de session de navigateur capturé à la main, seule
 *     façon d'atteindre un portail qui exige un code SMS à chaque connexion.
 *     Chiffré au repos comme un mot de passe, jamais réaffiché
 *     (voir connectors/session-state.js) ;
 *   - `multiselect` : une liste à cocher dont les options ne viennent PAS du
 *     manifeste mais de `discover()`, exécuté après connexion — quatre lignes
 *     mobiles, plusieurs points de livraison… (voir connectors/discovery.js).
 *
 * Un de plus au lot 9, pour la même raison — être réutilisable :
 *
 *   - `history` : la profondeur d'historique à récupérer. Amazon expose quinze
 *     années ; un rattrapage complet prend une demi-heure et n'a de sens
 *     qu'une fois. Le champ n'a ni options ni valeurs à déclarer : ses quatre
 *     choix sont les mêmes pour tout connecteur, et vivent dans
 *     connectors/history.js.
 */
const FIELD_TYPES = ['text', 'password', 'email', 'select', 'session', 'multiselect', 'history'];

/** Origines possibles des options d'un `multiselect`. */
const OPTION_SOURCES = ['discover', 'manifest'];

/**
 * Comment un connecteur atteint le fournisseur.
 *
 * `prestashop` est arrivé au lot 11 et ne désigne pas une technique mais une
 * **implémentation commune** : dix boutiques du Store tournent sur le même
 * moteur, et leur connecteur sera écrit UNE fois. Chacune garde sa tuile, son
 * nom et son site — ce qu'un utilisateur cherche —, mais toutes pointent vers
 * le même code. Le jour où il existe, les dix deviennent fonctionnelles d'un
 * coup, sans une ligne de plus.
 *
 * `ovh-api` suit le même principe au lot 16 : OVHcloud, SoYouStart et Kimsufi
 * sont trois marques d'un même serveur d'API, avec la même signature et la
 * même route de factures. Un manifeste qui porte cette valeur n'a pas de
 * `connector.js` à lui — le registre lui prête celui de `available/ovh-api/`
 * (voir registry.js, SHARED_IMPLEMENTATIONS).
 */
const IMPLEMENTATIONS = ['api', 'scraping', 'stub', 'prestashop', 'ovh-api'];

/**
 * Les deux états d'un connecteur, décidés par le DOSSIER qui le porte :
 * `available/` ou `planned/`.
 *
 * Un manifeste peut redire le sien (`"status": "planned"`), et c'est même utile
 * à la lecture, mais **cette valeur ne décide de rien** : elle est ignorée au
 * chargement. C'est ce qui permet de rendre un service disponible en déplaçant
 * simplement son dossier, sans toucher à son contenu ni risquer d'oublier une
 * ligne à mettre à jour.
 */
const STATUSES = ['available', 'planned'];

/** Types dont la valeur est un secret : jamais renvoyée au client. */
const SECRET_FIELD_TYPES = ['password', 'session'];

/**
 * @param {object} manifest
 * @param {string} [source] chemin du fichier, pour les messages d'erreur
 * @param {{planned?: boolean}} [options] `planned` = manifeste d'un service
 *   ANNONCÉ (dossier `planned/`) : il décrit un service, il ne le connecte pas
 *   encore. Formulaire et permissions n'ont donc pas lieu d'être exigés — il
 *   n'y a rien à saisir et rien à autoriser tant qu'aucun code ne tourne.
 * @returns {{ok: boolean, errors: string[], manifest: object|null}}
 */
function validate(manifest, source = '<inconnu>', { planned = false } = {}) {
  const errors = [];
  const push = (msg) => errors.push(`${source}: ${msg}`);

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: [`${source}: manifest illisible`], manifest: null };
  }

  validateUnfeasible(manifest, push, { planned });

  // `color` et `letters` ne sont plus exigés : à défaut, la pastille tire une
  // couleur stable de l'identifiant et des initiales du nom (voir `normalize`).
  // Écrire soixante fois une couleur inventée n'aurait rien apporté — et un
  // manifeste minimal reste lisible d'un coup d'œil.
  const requiredStrings = ['id', 'name', 'category'];
  for (const key of requiredStrings) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) {
      push(`champ « ${key} » manquant ou vide`);
    }
  }

  if (manifest.id && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    push(`id « ${manifest.id} » invalide (attendu : minuscules, chiffres, tirets)`);
  }

  if (manifest.category && !CATEGORIES[manifest.category]) {
    push(
      `catégorie « ${manifest.category} » inconnue (attendu : ${Object.keys(CATEGORIES).join(', ')})`
    );
  }

  if (manifest.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(manifest.color))) {
    push(`couleur « ${manifest.color} » invalide (attendu : #rrggbb)`);
  }

  if (manifest.letters !== undefined) {
    const letters = String(manifest.letters);
    if (!letters.trim()) push('« letters » ne doit pas être vide (retirez-le plutôt)');
    else if (letters.length > 3) push('« letters » ne doit pas dépasser 3 caractères');
  }

  if (manifest.status !== undefined && !STATUSES.includes(manifest.status)) {
    push(`status « ${manifest.status} » invalide (attendu : ${STATUSES.join(', ')})`);
  }

  validateDescription(manifest, push);

  if (manifest.implementation && !IMPLEMENTATIONS.includes(manifest.implementation)) {
    push(
      `implementation « ${manifest.implementation} » inconnue (attendu : ${IMPLEMENTATIONS.join(', ')})`
    );
  }

  if (manifest.initialStatus && !['available', 'pending'].includes(manifest.initialStatus)) {
    push(`initialStatus « ${manifest.initialStatus} » invalide (attendu : available, pending)`);
  }

  if (manifest.fields === undefined && planned) {
    // Rien à saisir tant que le connecteur n'existe pas.
  } else if (!Array.isArray(manifest.fields) || manifest.fields.length === 0) {
    push('« fields » doit être un tableau non vide');
  } else {
    const seen = new Set();
    let identifications = 0;
    manifest.fields.forEach((f, i) => {
      const where = `fields[${i}]`;
      if (!f || typeof f !== 'object') return push(`${where} n'est pas un objet`);
      if (typeof f.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key)) {
        push(`${where}.key invalide`);
      } else if (seen.has(f.key)) {
        push(`${where}.key « ${f.key} » dupliqué`);
      } else {
        seen.add(f.key);
      }
      if (identification.estIdentification(f)) identifications += 1;
      validateIdentification(f, where, push);
      // Un champ d'identification n'écrit plus son libellé : il le tient de sa
      // nature (voir connectors/identification.js). Il garde le droit d'en
      // donner un — « Numéro fiscal » est un fait du site — mais ne le doit plus.
      if (!identification.estIdentification(f) && (typeof f.label !== 'string' || !f.label.trim())) {
        push(`${where}.label manquant`);
      }
      if (!FIELD_TYPES.includes(f.type)) {
        push(`${where}.type « ${f.type} » invalide (attendu : ${FIELD_TYPES.join(', ')})`);
      }
      if (f.type === 'select' && !Array.isArray(f.options)) {
        push(`${where}.options requis pour un champ select`);
      }
      if (f.type === 'history' && f.options !== undefined) {
        push(`${where}.options n'a pas de sens pour un champ history : ses quatre choix `
          + 'sont communs à tous les connecteurs (connectors/history.js)');
      }
      if (f.type === 'multiselect') {
        const source = f.source || 'discover';
        if (!OPTION_SOURCES.includes(source)) {
          push(
            `${where}.source « ${f.source} » invalide (attendu : ${OPTION_SOURCES.join(', ')})`
          );
        } else if (source === 'manifest' && !Array.isArray(f.options)) {
          push(`${where}.options requis pour un multiselect alimenté par le manifeste`);
        }
      }
    });

    // Deux champs d'identification laisseraient le formulaire — et le
    // pré-remplissage de la fenêtre de connexion — choisir tout seuls lequel
    // est celui du site. Un site ne demande qu'une chose pour vous reconnaître.
    if (identifications > 1) {
      push(
        `${identifications} champs déclarent « identification » : un seul champ peut porter `
          + 'ce que le site demande pour vous reconnaître'
      );
    }
  }

  validateRemoteLogin(manifest, push);
  validateUrls(manifest, push);
  // Un service annoncé ne manipule aucune donnée : il n'a rien à déclarer, et
  // lui faire écrire des permissions qu'aucun code n'exerce serait une promesse
  // en l'air. Elles redeviennent obligatoires le jour où il passe dans
  // `available/` — c'est le chargement du connecteur qui l'exigera.
  if (!planned || manifest.permissions !== undefined) validatePermissions(manifest, push);

  return { ok: errors.length === 0, errors, manifest: errors.length === 0 ? manifest : null };
}

/**
 * Le champ par lequel le site reconnaît son visiteur (voir
 * connectors/identification.js).
 *
 * Trois refus, et le même motif derrière les trois : le formulaire ne doit
 * jamais pouvoir afficher autre chose que ce que le site demande.
 *
 *   1. une nature inconnue — sinon le champ retomberait en silence sur le
 *      libellé écrit à la main, c'est-à-dire sur le défaut qu'on corrige ;
 *   2. un `type` qui contredit la nature — « Identifiant » dans un champ
 *      `type="email"` ferait refuser « prenom.nom » par le navigateur du poste ;
 *   3. un `label` ou un `help` présents mais vides — un champ sans libellé est
 *      illisible, et l'écrire vide n'est pas une façon de dire « prends le
 *      libellé de la nature » : il suffit de ne pas l'écrire.
 */
function validateIdentification(field, where, push) {
  if (!identification.estIdentification(field)) return;

  if (!identification.has(field.identification)) {
    return push(
      `${where}.identification « ${field.identification} » inconnue `
        + `(attendu : ${identification.KEYS.join(', ')})`
    );
  }

  const attendu = identification.inputType(field);
  if (field.type !== attendu) {
    push(
      `${where}.type « ${field.type} » contredit identification « ${field.identification} » `
        + `(attendu : ${attendu})`
    );
  }

  for (const cle of ['label', 'help']) {
    if (field[cle] !== undefined && (typeof field[cle] !== 'string' || !field[cle].trim())) {
      push(`${where}.${cle} est vide : retirez-le, la nature déclarée le fournit`);
    }
  }
}

/**
 * `description` — UNE phrase, et ce qu'elle fait pour l'utilisateur.
 *
 * ─── Le texte que cette règle interdit ───────────────────────────────────────
 *
 * Jusqu'au lot 8, la fiche Free Mobile affichait ceci :
 *
 *   « Récupère les factures de toutes les lignes d'un compte Free Mobile, y
 *     compris les lignes résiliées. Free Mobile exigeant un code SMS à chaque
 *     connexion, ce connecteur rejoue une session ouverte par vous : cliquez
 *     « Se connecter à Free Mobile », une fenêtre de navigateur s'ouvre dans
 *     crabe, et la session est enregistrée toute seule une fois la connexion
 *     établie. Parcours validé contre un compte réel le 09/08/2026. »
 *
 * C'est une note d'implémentation. Personne ne vient chercher ses factures avec
 * « session », « rejoue » et une date de validation en tête ; et celui qui lit
 * ça avant d'avoir cliqué se demande surtout ce qu'on attend de lui.
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * **Une phrase**, au plus `DESCRIPTION_MAX` caractères, qui dit ce que le
 * service fait POUR l'utilisateur. Rien sur le comment. Le manifeste est refusé
 * au chargement s'il déborde : une règle qu'on n'applique pas est un
 * commentaire.
 *
 * Ce qui est vrai mais technique — méthode d'accès, particularité du portail,
 * date de validation, état d'avancement — va dans `technicalNote`, qui n'est
 * JAMAIS renvoyée à l'utilisateur (voir `publicView`) et ne s'affiche que dans
 * Paramètres → Applications.
 */
const DESCRIPTION_MAX = 160;

/** Une phrase se termine une fois, à la fin. */
function compterPhrases(texte) {
  // Les points d'une abréviation ou d'une URL ne comptent pas : seule compte
  // une ponctuation finale suivie d'un espace puis d'une majuscule, ou la fin.
  const coupes = String(texte).match(/[.!?…](?=\s+[A-ZÀ-ÖØ-Þ«]|\s*$)/g);
  return coupes ? coupes.length : 0;
}

function validateDescription(manifest, push) {
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';

  if (!description) {
    return push(
      'champ « description » manquant : une phrase disant ce que ce service fait pour '
        + 'l\'utilisateur (les précisions techniques vont dans « technicalNote »)'
    );
  }
  if (description.length > DESCRIPTION_MAX) {
    push(
      `« description » fait ${description.length} caractères (${DESCRIPTION_MAX} au plus) — `
        + 'ce qui dépasse est une note d\'implémentation : mettez-la dans « technicalNote »'
    );
  }
  if (compterPhrases(description) > 1) {
    push(
      '« description » doit tenir en UNE phrase — le reste va dans « technicalNote », '
        + 'affichée seulement dans l\'administration'
    );
  }
  if (manifest.technicalNote !== undefined && typeof manifest.technicalNote !== 'string') {
    push('« technicalNote » doit être une chaîne');
  }

  validateCaveat(manifest, push);
}

/**
 * `caveat` — la réserve, quand il y en a une.
 *
 * ─── Pourquoi un champ de plus ───────────────────────────────────────────────
 *
 * Le lot 11 annonce quatre banques traditionnelles dont la faisabilité **n'est
 * pas acquise** : la validation passe par l'application mobile de la banque,
 * les sessions durent quelques minutes, et l'accès automatisé est le plus
 * souvent contraire aux conditions d'utilisation. Laisser croire le contraire
 * serait une promesse en l'air, et c'est exactement ce que ce lot cherche à
 * éviter en distinguant « disponible » de « annoncé ».
 *
 * Cette réserve ne pouvait pas aller dans `description`, tenue depuis le lot 8
 * à UNE phrase de 160 caractères — et l'y faire entrer aurait demandé de
 * relâcher la règle pour tout le monde, ou de la relâcher pour les seuls
 * services annoncés, ce qui aurait cassé le déplacement de dossier au moment
 * de rendre le service disponible.
 *
 * Elle ne pouvait pas non plus aller dans `technicalNote`, qui ne sort JAMAIS
 * vers l'utilisateur : la réserve s'adresse précisément à lui.
 *
 * D'où un champ à part, servi à l'utilisateur, facultatif, et qui reste vrai le
 * jour où le service devient disponible — « la connexion demande une validation
 * depuis l'application mobile » ne cessera pas de l'être.
 */
const CAVEAT_MAX = 220;

function validateCaveat(manifest, push) {
  if (manifest.caveat === undefined) return;
  if (typeof manifest.caveat !== 'string') return push('« caveat » doit être une chaîne');

  const caveat = manifest.caveat.trim();
  if (!caveat) return push('« caveat » ne doit pas être vide (retirez-le plutôt)');
  if (caveat.length > CAVEAT_MAX) {
    push(
      `« caveat » fait ${caveat.length} caractères (${CAVEAT_MAX} au plus) — une réserve qu'on `
        + 'ne lit pas jusqu\'au bout ne sert à rien'
    );
  }
}

/**
 * `unfeasible` — l'empêchement, quand il est MESURÉ (lot 36).
 *
 * ─── Ce que ce champ répare ──────────────────────────────────────────────────
 *
 * Une annonce « Bientôt disponible » est une promesse, et le lot 30 a montré
 * qu'une promesse qui ne sera pas tenue est un défaut de produit (l'utilisateur l'a
 * relevé pour Hello Bank!). Quand la reconnaissance conclut « impraticable » —
 * mur anti-robot, connexion par un tiers refusée aux programmes, document qui
 * n'existe pas sur le web —, l'annonce ne doit plus promettre.
 *
 * Deux voies existaient : retirer l'annonce, ou lui donner un état honnête.
 * C'est la seconde qui est retenue, parce qu'un client du service qui ne
 * trouve pas sa tuile conclurait que crabe l'a oublié et le redemanderait —
 * alors que la tuile « Pas possible aujourd'hui », avec sa raison en une
 * phrase, transmet ce que la reconnaissance a coûté à établir, et éteint la
 * promesse sans effacer l'information.
 *
 * Le champ porte LA RAISON, en une phrase, en français, pour un public non
 * technique : c'est elle qui s'affiche sur la tuile à la place de la
 * description. Il n'a de sens que sur une annonce (`planned/`) — un service
 * disponible qui deviendrait impraticable se retire, il ne s'excuse pas.
 */
const UNFEASIBLE_MAX = 220;

function validateUnfeasible(manifest, push, { planned = false } = {}) {
  if (manifest.unfeasible === undefined) return;
  if (typeof manifest.unfeasible !== 'string') {
    return push('« unfeasible » doit être une chaîne : la raison, en une phrase, en français');
  }
  const raison = manifest.unfeasible.trim();
  if (!raison) return push('« unfeasible » ne doit pas être vide (retirez-le plutôt)');
  if (raison.length > UNFEASIBLE_MAX) {
    push(
      `« unfeasible » fait ${raison.length} caractères (${UNFEASIBLE_MAX} au plus) — une raison `
        + 'qu\'on ne lit pas jusqu\'au bout ne sert à rien'
    );
  }
  if (!planned) {
    push(
      '« unfeasible » n\'a de sens que sur une annonce (dossier planned/) : un service '
        + 'disponible qui devient impraticable se retire du catalogue, il ne s\'excuse pas'
    );
  }
}

/**
 * Bloc `remoteLogin` — comment ouvrir la session par navigateur distant (lot 6).
 *
 * ```json
 * "remoteLogin": {
 *   "url": "https://mobile.free.fr/account/v2/login",
 *   "marker": "Mes factures",
 *   "hint": "Cochez « Se souvenir de cet appareil » pour une session de six mois."
 * }
 * ```
 *
 * Facultatif : un connecteur qui se contente d'un identifiant et d'un mot de
 * passe n'en a pas besoin. Mais s'il le déclare, deux choses sont exigées.
 *
 * **Une URL en HTTPS.** On y envoie l'utilisateur saisir son mot de passe : la
 * laisser en clair serait un défaut, pas une commodité.
 *
 * **Un champ de type `session`.** Sans lui, la capture n'aurait nulle part où
 * aller — le navigateur s'ouvrirait, l'utilisateur se connecterait, et rien ne
 * serait enregistré. Mieux vaut refuser le manifeste au chargement.
 *
 * Le `marker` n'est pas obligatoire mais il est vivement conseillé : c'est le
 * seul contrôle vraiment fiable de fin de parcours (voir
 * connectors/login-detection.js). Sans lui, la détection est heuristique et
 * peut se déclencher entre le mot de passe et le code SMS.
 */
function validateRemoteLogin(manifest, push) {
  const remote = manifest.remoteLogin;
  if (remote === undefined || remote === null) return;

  if (typeof remote !== 'object' || Array.isArray(remote)) {
    return push('« remoteLogin » doit être un objet { url, marker, hint }');
  }

  if (typeof remote.url !== 'string' || !remote.url.trim()) {
    push('remoteLogin.url manquante : c\'est la page sur laquelle le navigateur s\'ouvre');
  } else if (!/^https:\/\//i.test(remote.url.trim())) {
    push(
      `remoteLogin.url « ${remote.url} » n'est pas en HTTPS — l'utilisateur y saisit son mot de passe`
    );
  }

  for (const key of ['marker', 'hint', 'verifyUrl']) {
    if (remote[key] !== undefined && typeof remote[key] !== 'string') {
      push(`remoteLogin.${key} doit être une chaîne`);
    }
  }

  if (remote.persistent !== undefined && typeof remote.persistent !== 'boolean') {
    push('remoteLogin.persistent doit être un booléen (true : la connexion s\'ouvre sur un profil de navigateur persistant)');
  }

  /**
   * `keepDomains` (lot 21) — les domaines dont la session mérite d'être gardée.
   *
   * Déclaré par les connecteurs dont la connexion passe par un tiers (« Se
   * connecter avec Google »). Sans lui, la photo de fin de parcours emporte le
   * navigateur entier, session Google comprise, dont crabe n'a aucun usage.
   *
   * Un domaine VIDE serait pire que pas de liste du tout : il ne garderait
   * rien, et la session enregistrée serait inutilisable sans que rien ne le
   * dise. On refuse donc le manifeste plutôt que de laisser passer.
   */
  if (remote.keepDomains !== undefined) {
    if (!Array.isArray(remote.keepDomains) || !remote.keepDomains.length) {
      push('remoteLogin.keepDomains doit être une liste non vide de domaines à conserver');
    } else {
      for (const domaine of remote.keepDomains) {
        if (typeof domaine !== 'string' || !domaine.trim()) {
          push('remoteLogin.keepDomains ne peut pas contenir de domaine vide');
        } else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domaine.trim())) {
          push(`remoteLogin.keepDomains : « ${domaine} » n'est pas un nom de domaine`);
        }
      }
    }
  }

  // La page d'ESSAI (lot 14, §6). Elle aussi en HTTPS : on y rejoue une
  // session qui vaut les identifiants.
  if (typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim()
    && !/^https:\/\//i.test(remote.verifyUrl.trim())) {
    push(`remoteLogin.verifyUrl « ${remote.verifyUrl} » n'est pas en HTTPS`);
  }

  /**
   * `verifyUrlTient` (lot 40) — rester sur la page de contrôle prouve la
   * session. Pour les sites sans marqueur générique de compte, mais qui
   * REDIRIGENT les anonymes hors de la page (OUIGO : hors session, la page
   * des réservations renvoie à l'accueil — mesuré le 14/08/2026). N'a aucun
   * sens sans `verifyUrl` : il n'y aurait pas d'adresse dont juger la tenue.
   */
  if (remote.verifyUrlTient !== undefined) {
    if (typeof remote.verifyUrlTient !== 'boolean') {
      push('remoteLogin.verifyUrlTient doit être un booléen (true : rester sur la page de contrôle prouve la session)');
    } else if (remote.verifyUrlTient
      && !(typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim())) {
      push('remoteLogin.verifyUrlTient sans remoteLogin.verifyUrl : aucune adresse dont juger la tenue');
    }
  }

  /**
   * `renvoiAnonyme` (lot 68) — ce que le site fait d'un anonyme qui demande la
   * page de contrôle, MESURÉ. Seule valeur comprise : « connexion » —
   * l'anonyme est renvoyé vers le formulaire de connexion. Ne pas y être
   * renvoyé, en restant sur le site, prouve alors la session même quand
   * l'application réécrit l'adresse : claude.ai ramène `/settings/billing`
   * vers `/new#settings/billing` en gardant la cible en fragment (mesuré le
   * 28/08/2026 — trois refus d'une session valide). N'a aucun sens sans
   * `verifyUrl` : il n'y aurait pas d'adresse dont mesurer le renvoi.
   */
  if (remote.renvoiAnonyme !== undefined) {
    if (remote.renvoiAnonyme !== 'connexion') {
      push('remoteLogin.renvoiAnonyme : seule la valeur « connexion » est comprise '
        + '(mesuré : le site renvoie les anonymes de la page de contrôle vers son formulaire de connexion)');
    } else if (!(typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim())) {
      push('remoteLogin.renvoiAnonyme sans remoteLogin.verifyUrl : aucune adresse dont mesurer le renvoi');
    }
  }

  /**
   * Un chemin d'accueil n'est pas une page réservée (lot 68). Les preuves par
   * la tenue ou par le renvoi supposent une adresse dont un anonyme est
   * chassé : la RACINE d'un site est servie à tout le monde, et « l'adresse a
   * tenu » y serait vrai de n'importe quelle page — formulaire de connexion
   * compris, par simple préfixe. On refuse le manifeste plutôt que de laisser
   * une preuve vide de sens confirmer un anonyme.
   */
  if ((remote.verifyUrlTient === true || remote.renvoiAnonyme === 'connexion')
    && typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim()) {
    try {
      const controle = new URL(remote.verifyUrl.trim());
      if (controle.pathname === '/' && !controle.search && !controle.hash) {
        push('remoteLogin.verifyUrlTient/renvoiAnonyme sur la racine du site : un chemin '
          + 'd\'accueil n\'est pas une page réservée, rien ne peut s\'y prouver');
      }
    } catch {
      /* URL illisible : déjà signalée par les contrôles ci-dessus */
    }
  }

  /**
   * `preuveSurFenetre` (lot 48) — la preuve de session se lit dans la fenêtre
   * VISIBLE, jamais dans un contrôle headless. Pour les sites dont la garde
   * anti-robot juge le navigateur lui-même : Akamai chez Boulanger rendait 404
   * à tout contrôle headless, cookies de session compris — mesuré le
   * 22/08/2026 pendant que l'utilisateur était connecté à l'écran. La preuve
   * exigée reste la forte (lien de déconnexion, preuve-connexion).
   */
  if (remote.preuveSurFenetre !== undefined && typeof remote.preuveSurFenetre !== 'boolean') {
    push('remoteLogin.preuveSurFenetre doit être un booléen (true : la preuve de compte connecté se lit dans la fenêtre visible)');
  }

  /**
   * `marqueursFenetre` (lot 49) — les marqueurs MESURÉS du service, lus sur le
   * DOM déjà affiché dans la fenêtre : l'adresse de contrôle a tenu ET l'un
   * d'eux est dans la page, sans aucune requête supplémentaire. Pour les
   * sites dont la garde anti-robot peut refuser la seconde requête pendant
   * que la fenêtre affiche la page (Darty : 403 DataDome au contrôle, page
   * des commandes sous les yeux — mesuré le 23/08/2026). Chaque marqueur
   * porte `selecteur` (CSS) et/ou `texte` (motif de FORME, jamais une valeur
   * réelle). Sans `preuveSurFenetre` ils ne seraient jamais lus ; sans
   * `verifyUrl` il n'y aurait pas d'adresse dont juger la tenue.
   */
  if (remote.marqueursFenetre !== undefined) {
    if (!Array.isArray(remote.marqueursFenetre) || !remote.marqueursFenetre.length) {
      push('remoteLogin.marqueursFenetre doit être une liste non vide de marqueurs mesurés');
    } else {
      for (const marqueur of remote.marqueursFenetre) {
        const selecteur = typeof marqueur?.selecteur === 'string' ? marqueur.selecteur.trim() : '';
        const texte = typeof marqueur?.texte === 'string' ? marqueur.texte.trim() : '';
        if (!marqueur || typeof marqueur !== 'object' || Array.isArray(marqueur)
          || (!selecteur && !texte)) {
          push('remoteLogin.marqueursFenetre : chaque marqueur porte « selecteur » (CSS) et/ou « texte » (motif)');
          continue;
        }
        if (texte) {
          try {
            new RegExp(texte, 'i');
          } catch {
            push(`remoteLogin.marqueursFenetre : le motif « ${texte} » n'est pas une expression valide`);
          }
        }
      }
      if (remote.preuveSurFenetre !== true) {
        push('remoteLogin.marqueursFenetre sans preuveSurFenetre : ces marqueurs ne seraient jamais lus');
      }
      if (!(typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim())) {
        push('remoteLogin.marqueursFenetre sans verifyUrl : aucune adresse dont juger la tenue');
      }
    }
  }

  /**
   * `attendreUrls` (lot 32) — les étapes techniques du site, qui ne prouvent
   * rien : la vérification anti-robot de Hetzner (`/_ray/`) passait tous les
   * garde-fous génériques et se faisait prendre pour une page connectée. Le
   * connecteur déclare des FRAGMENTS DE CHEMIN, jamais une URL complète — la
   * détection les cherche dans le chemin de la page courante.
   */
  if (remote.attendreUrls !== undefined) {
    if (!Array.isArray(remote.attendreUrls) || !remote.attendreUrls.length) {
      push('remoteLogin.attendreUrls doit être une liste non vide de fragments de chemin');
    } else {
      for (const fragment of remote.attendreUrls) {
        if (typeof fragment !== 'string' || !fragment.trim()) {
          push('remoteLogin.attendreUrls ne peut pas contenir de fragment vide');
        }
      }
    }
  }

  const champs = Array.isArray(manifest.fields) ? manifest.fields : [];
  if (!champs.some((f) => f?.type === 'session')) {
    push(
      '« remoteLogin » est déclaré mais aucun champ de type « session » ne l\'accompagne : '
        + 'la connexion capturée n\'aurait nulle part où être enregistrée'
    );
  }
}

/**
 * Bloc `urls` — les adresses d'un service servi par une implémentation partagée.
 *
 * ```json
 * "urls": {
 *   "login":  "https://propolia.com/fr/connexion",
 *   "orders": "https://propolia.com/fr/historique-commandes"
 * }
 * ```
 *
 * Arrivé au lot 12 avec le connecteur PrestaShop : sept boutiques, un seul
 * code, et la seule chose qui les distingue est leur adresse. Les mettre dans
 * le manifeste plutôt que dans le code évite d'écrire sept fichiers identiques
 * — et de les corriger sept fois.
 *
 * **HTTPS exigé, comme pour `remoteLogin`** : l'utilisateur y saisit son mot de
 * passe. Une boutique qui ne le supporterait pas n'a rien à faire ici.
 *
 * Facultatif : l'entrée générique « Boutique PrestaShop » n'en déclare pas —
 * c'est l'utilisateur qui donne l'adresse, et les chemins sont déduits.
 */
function validateUrls(manifest, push) {
  const urls = manifest.urls;
  if (urls === undefined || urls === null) return;

  if (typeof urls !== 'object' || Array.isArray(urls)) {
    return push('« urls » doit être un objet { login, orders }');
  }

  for (const [cle, valeur] of Object.entries(urls)) {
    if (typeof valeur !== 'string' || !valeur.trim()) {
      push(`urls.${cle} doit être une adresse non vide`);
    } else if (!/^https:\/\//i.test(valeur.trim())) {
      push(`urls.${cle} « ${valeur} » n'est pas en HTTPS — l'utilisateur y saisit son mot de passe`);
    }
  }
}

/**
 * Permissions : vocabulaire commun + description SPÉCIFIQUE obligatoire.
 *
 * Un connecteur qui se contente des libellés génériques du lot 3
 * (« Factures », « Identifiants du connecteur », sans un mot de plus) est
 * refusé au chargement : c'est exactement ce que le lot 4 corrige. La règle
 * est documentée dans le README, section « Écrire un connecteur ».
 *
 * @param {object} manifest
 * @param {(msg: string) => void} push
 */
function validatePermissions(manifest, push) {
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) {
    push(
      '« permissions » doit être un tableau non vide : déclarez les données que ce '
        + `connecteur manipule réellement (${vocabulary.KEYS.join(', ')})`
    );
    return;
  }

  const seen = new Set();
  manifest.permissions.forEach((p, i) => {
    const where = `permissions[${i}]`;
    if (!p || typeof p !== 'object') return push(`${where} n'est pas un objet`);

    if (!vocabulary.has(p.key)) {
      return push(
        `${where}.key « ${p.key} » hors vocabulaire (attendu : ${vocabulary.KEYS.join(', ')})`
      );
    }
    if (seen.has(p.key)) return push(`${where}.key « ${p.key} » déclarée deux fois`);
    seen.add(p.key);

    if (!vocabulary.SCOPE_IDS.includes(p.scope)) {
      push(`${where}.scope « ${p.scope} » invalide (attendu : ${vocabulary.SCOPE_IDS.join(', ')})`);
    }

    const description = typeof p.description === 'string' ? p.description.trim() : '';
    if (!description) {
      push(
        `${where}.description manquante : dites concrètement ce que ${manifest.id || 'ce connecteur'} `
          + `fait de « ${vocabulary.VOCABULARY[p.key].name} »`
      );
    } else if (description.length < 30) {
      push(`${where}.description trop courte pour être utile (${description.length} caractères)`);
    } else if (isGenericDescription(description, p.key)) {
      push(
        `${where}.description reprend le texte générique : elle doit être propre à `
          + `${manifest.id || 'ce connecteur'}`
      );
    }
  });
}

/**
 * Une description qui ne dit rien de plus que le libellé commun.
 *
 * Deux cas refusés : la recopie mot pour mot de la description par défaut du
 * vocabulaire, et les formulations passe-partout du lot 3.
 */
const GENERIC_PHRASES = [
  'factures',
  'identifiants du connecteur',
  'lecture et écriture',
  'lecture seule',
  'lecture seule — stockés chiffrés',
  'stockés chiffrés',
];

function isGenericDescription(description, key) {
  const normalized = description.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
  if (normalized === vocabulary.VOCABULARY[key].defaultDescription.toLowerCase().replace(/[.]$/, '')) {
    return true;
  }
  return GENERIC_PHRASES.includes(normalized);
}

// ---------------------------------------------------------------------------
// La pastille de repli, quand aucun logo n'a pu être récupéré
//
// Jusqu'au lot 10, chaque manifeste déclarait sa couleur et ses initiales à la
// main : quatorze connecteurs, quatorze décisions, c'était tenable. Le lot 11
// en ajoute une soixantaine, et inventer soixante couleurs « de marque » aurait
// surtout produit soixante approximations — la plupart de ces services portent
// de toute façon un vrai logo, récupéré sur leur propre site.
//
// Les deux valeurs sont donc DÉDUITES quand le manifeste se tait. Un manifeste
// qui les déclare garde le dernier mot : les quatorze connecteurs d'origine ne
// bougent pas d'un pixel.
// ---------------------------------------------------------------------------

/**
 * Couleurs de pastille, toutes assez sombres pour porter du texte blanc.
 *
 * Choisies distinctes les unes des autres plutôt que jolies ensemble : deux
 * services voisins dans une grille doivent se distinguer, c'est tout ce qu'on
 * demande à un fond d'initiales.
 */
const COULEURS_PASTILLE = [
  '#2f6f4f', '#1c5d99', '#6a3d9a', '#a13d63', '#b05a2a', '#3f6d7d',
  '#7a5c1e', '#4a4f8c', '#8c3a3a', '#2b7a78', '#5c5470', '#63722f',
];

/**
 * Une couleur STABLE pour un identifiant donné.
 *
 * Stable est le mot important : un même service garde sa pastille d'un
 * démarrage à l'autre, d'une machine à l'autre. Tirer au hasard ferait changer
 * la grille à chaque redémarrage, ce qui est exactement ce qu'un repère visuel
 * ne doit pas faire.
 */
function couleurParDefaut(id) {
  const texte = String(id || '');
  let empreinte = 0;
  for (let i = 0; i < texte.length; i++) empreinte = (empreinte * 31 + texte.charCodeAt(i)) >>> 0;
  return COULEURS_PASTILLE[empreinte % COULEURS_PASTILLE.length];
}

/** Mots qui ne portent pas l'identité d'une marque, et n'ont rien à faire dans ses initiales. */
const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'du', 'de', 'des', 'd', 'au', 'aux', 'et',
  'the', 'net', 'com', 'fr', 'io',
]);

/**
 * Les initiales d'un nom de service : « Le Petit Vapoteur » → « PV ».
 *
 * Trois règles, dans cet ordre :
 *
 *   1. les articles et les extensions de domaine sautent — « L'Île aux Épices »
 *      donne « IE », pas « LI » ;
 *   2. deux mots ou plus → la première lettre des deux premiers ;
 *   3. un seul mot → sa bosse interne s'il en a une (« TotalEnergies » → « TE »,
 *      « eDocPerso » → « ED »), sinon ses deux premières lettres. Un sigle court
 *      déjà tout en capitales est gardé tel quel : « FDJ » reste « FDJ ».
 */
function lettresParDefaut(name) {
  const texte = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const mots = texte.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const utiles = mots.filter((m) => !MOTS_VIDES.has(m.toLowerCase()));
  const retenus = utiles.length ? utiles : mots;

  if (!retenus.length) return '?';
  if (retenus.length >= 2) return (retenus[0][0] + retenus[1][0]).toUpperCase();

  const seul = retenus[0];
  if (seul.length <= 3 && seul === seul.toUpperCase()) return seul;

  // Une bosse interne : une minuscule ou un chiffre suivi d'une capitale.
  const bosses = seul.split(/(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  if (bosses.length >= 2) return (bosses[0][0] + bosses[1][0]).toUpperCase();

  return seul.slice(0, 2).toUpperCase();
}

/**
 * Complète un manifest validé avec ses valeurs par défaut.
 *
 * Plus de permissions par défaut : elles sont désormais obligatoires et
 * validées. Un connecteur ne peut plus hériter en silence de deux libellés
 * génériques qui ne décrivent rien.
 *
 * `planned` vient du DOSSIER, jamais du fichier : le `status` que le manifeste
 * porte éventuellement est retiré ici même, pour qu'aucun code en aval ne
 * puisse le prendre pour la vérité et se tromper d'un dossier à l'autre.
 */
function normalize(manifest, { planned = false } = {}) {
  const { status, ...reste } = manifest;
  return {
    site: '',
    description: '',
    // La réserve, quand il y en a une. Servie à l'utilisateur, contrairement à
    // `technicalNote` — c'est tout l'intérêt d'en avoir fait deux champs.
    caveat: '',
    // L'empêchement mesuré, quand il y en a un (annonces seulement, lot 36) :
    // la tuile le montre à la place de « Bientôt disponible ».
    unfeasible: '',
    // Ce qui est vrai mais technique. Jamais servi à l'utilisateur.
    technicalNote: '',
    implementation: 'stub',
    initialStatus: 'available',
    color: couleurParDefaut(reste.id),
    letters: lettresParDefaut(reste.name),
    permissions: [],
    ...reste,
    planned: !!planned,
    categoryLabel: CATEGORIES[reste.category] || reste.category,
    remoteLogin: normalizeRemoteLogin(reste.remoteLogin),
    // Le nom du service traverse jusqu'au champ : c'est lui qui écrit l'aide du
    // champ d'identification — « Celle avec laquelle vous vous connectez sur
    // Kubii. » — au lieu de la voir recopiée dans chaque manifeste.
    fields: (reste.fields || []).map((f) => normalizeField(f, reste.name)),
    // Vue prête à afficher : icône et libellé viennent du vocabulaire commun,
    // la description du manifeste.
    permissionDetails: vocabulary.describeAll(reste.permissions),
  };
}

/**
 * Valeurs par défaut d'un champ.
 *
 * Un `multiselect` n'est jamais obligatoire : ses options n'existent pas avant
 * la première découverte, exiger une valeur à l'enregistrement rendrait le
 * connecteur impossible à configurer.
 *
 * `inputType` est posé sur TOUS les champs : c'est ce que le formulaire écrit
 * dans `<input type="…">`, et il n'a plus à le déduire lui-même. Pour un champ
 * d'identification, il vient de la nature déclarée — `email` pour une adresse,
 * `text` pour un identifiant.
 *
 * @param {object} field
 * @param {string} [nomDuService] nom du connecteur, pour l'aide d'un champ
 *   d'identification qui n'en écrit pas
 */
function normalizeField(field, nomDuService = '') {
  const base = {
    required: true,
    help: '',
    // Avant `...field` : ce que le manifeste écrit garde le dernier mot, et un
    // champ qui se taît hérite du libellé et de l'aide de sa nature.
    ...identification.defauts(field, nomDuService),
    ...field,
    inputType: identification.inputType(field),
  };

  if (base.type === 'session') {
    // ─── Jamais obligatoire, et ce n'est plus à la vigilance de personne ─────
    //
    // Un champ de session n'est PAS rempli par la fiche : il est écrit par la
    // capture, à la fin d'une connexion que l'utilisateur ouvre lui-même. Le
    // bouton « Se connecter à … » enregistre d'abord la fiche et retire ce
    // champ de ce qu'il envoie, pour ne pas écraser une connexion valable.
    // Déclaré obligatoire, cet enregistrement est refusé — « Champs
    // obligatoires manquants : Connexion à … » —, la fenêtre ne s'ouvre jamais,
    // et il faudrait être déjà connecté pour pouvoir se connecter.
    //
    // Trois fois que ce piège revient : SoYouStart (lot 15), Infomaniak (lot 23),
    // puis huit connecteurs d'un coup (lot 25). Il ne se voit pas à la lecture
    // d'un manifeste, où `required: true` a l'air d'une précaution — et sur un
    // service déjà configuré il dort jusqu'à la première session expirée.
    //
    // Un test transverse ne suffisait pas : il n'attrape que ce qui existe le
    // jour où on le lance, et le défaut naissait ici même, dans le `required:
    // true` par défaut ci-dessus — un manifeste qui ne dit RIEN sur ce champ le
    // rendait obligatoire. La règle est donc appliquée à la source, sur le
    // chemin que tout le monde emprunte : plus aucun manifeste, existant, ajouté
    // ou modifié plus tard, ne peut refermer ce piège.
    //
    // La vraie preuve de connexion n'a jamais été ce drapeau : c'est la session
    // elle-même, que le connecteur vérifie et dont il sait dire ce qui manque.
    return { ...base, required: false };
  }

  if (base.type === 'history') {
    // Jamais obligatoire : le défaut est bon pour tout le monde, et exiger un
    // choix avant la première connexion n'apprendrait rien à personne.
    return { ...base, required: false, default: history.format(base.default || history.DEFAUT) };
  }

  if (base.type !== 'multiselect') return base;
  return {
    source: 'discover',
    notice: '',
    unit: unitOf(base),
    // Le genre ne se devine pas en français (« une ligne » mais « un compte »,
    // tous deux en -e) : il se déclare, et le masculin est le défaut.
    unitFeminine: !!base.unitFeminine,
    ...base,
    required: false,
  };
}

/**
 * Nom de ce qu'on choisit, au singulier : « ligne », « contrat », « compte ».
 *
 * Sert à écrire des phrases qui parlent la langue de l'utilisateur — « 2 lignes
 * suivies », « Quelles lignes voulez-vous suivre ? » — plutôt que « 2
 * élément(s) sélectionné(s) », qui ne veut rien dire pour personne.
 *
 * Un manifeste peut le déclarer (`"unit": "ligne"`) ; à défaut on prend le
 * premier mot du libellé, au singulier : « Lignes à récupérer » → « ligne ».
 */
function unitOf(field) {
  if (field.unit) return String(field.unit).trim();
  const premier = String(field.label || '').trim().split(/\s+/)[0] || 'élément';
  return premier.toLowerCase().replace(/s$/, '');
}

/** Bloc `remoteLogin` complété, ou `null` si le connecteur n'en déclare pas. */
function normalizeRemoteLogin(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return null;
  return {
    url: String(remote.url || '').trim(),
    marker: String(remote.marker || '').trim(),
    hint: String(remote.hint || '').trim(),
    // §6 du lot 14 : la page sur laquelle la session capturée est ESSAYÉE
    // avant d'être enregistrée. Sans elle, on enregistre à l'aveugle — et
    // c'est comme ça qu'une session morte à la naissance a été gardée.
    verifyUrl: String(remote.verifyUrl || '').trim(),
    // Lot 40 — sur cette page d'essai, RESTER est la preuve : le site en
    // redirige les anonymes (OUIGO, mesure du 14/08/2026). Même liste
    // blanche, même piège que `persistent` : sans cette ligne, la clé
    // disparaîtrait du manifeste chargé et le contrôle retomberait sur les
    // marqueurs génériques, qui ne captent rien sur ces sites.
    verifyUrlTient: !!remote.verifyUrlTient,
    // Lot 68 — le renvoi des anonymes, mesuré : « connexion » quand le site
    // renvoie tout anonyme de la page de contrôle vers son formulaire. Même
    // liste blanche, même piège que `persistent` : sans cette ligne, la clé
    // disparaîtrait du manifeste chargé et le contrôle retomberait sur le seul
    // lien de déconnexion — que ces sites, précisément, n'affichent pas.
    renvoiAnonyme: remote.renvoiAnonyme === 'connexion' ? 'connexion' : '',
    // Depuis le lot 37, le contrôle de session est strict pour tous les
    // connecteurs : l'ancienne option `verifyStrict` n'a plus d'effet, et
    // cette liste blanche l'efface volontairement des manifestes qui la
    // porteraient encore.
    // La connexion s'ouvre sur un PROFIL DE NAVIGATEUR PERSISTANT plutôt que
    // sur un contexte jetable dont on capture les cookies. Pour les sites dont
    // la protection juge le navigateur lui-même — Cloudflare en tête (voir
    // connectors/profil-persistant.js et le connecteur addons-prestashop).
    // La clé DOIT être reprise ici : cette normalisation est une liste
    // blanche, tout ce qu'elle ne recopie pas disparaît du manifeste chargé —
    // c'est exactement ainsi qu'un premier « persistent » a été jeté en
    // silence le 12/08/2026, ouvrant la fenêtre sans profil et laissant
    // Cloudflare boucler.
    persistent: !!remote.persistent,
    // Lot 48 — la preuve de session se lit dans la fenêtre VISIBLE, jamais
    // dans un contrôle headless (Boulanger : Akamai rend 404 au contrôle
    // headless, cookies compris — mesuré le 22/08/2026). Même liste blanche,
    // même piège que `persistent` : sans cette ligne, la clé disparaîtrait et
    // le contrôle headless reviendrait échouer en silence.
    preuveSurFenetre: !!remote.preuveSurFenetre,
    // Lot 49 — les marqueurs MESURÉS du service, lus sur le DOM déjà affiché
    // (l'adresse a tenu ET un marqueur est dans la page, aucune requête
    // supplémentaire — Darty : 403 DataDome au contrôle pendant que la page
    // était affichée, mesuré le 23/08/2026). Même liste blanche, même piège
    // que `persistent` : sans cette ligne, la clé disparaîtrait et la preuve
    // retomberait sur le seul lien de déconnexion générique.
    marqueursFenetre: Array.isArray(remote.marqueursFenetre)
      ? remote.marqueursFenetre
        .map((m) => ({
          selecteur: String(m?.selecteur || '').trim(),
          texte: String(m?.texte || '').trim(),
        }))
        .filter((m) => m.selecteur || m.texte)
      : [],
    // Lot 21 — les domaines dont la session doit être conservée, pour les
    // connexions qui passent par un tiers (« Se connecter avec Google »). Même
    // avertissement que ci-dessus, et il vient d'être vérifié une seconde fois :
    // oublier cette ligne ne casse rien de visible, ça se contente de garder
    // les cookies Google de l'utilisateur pour toujours.
    keepDomains: Array.isArray(remote.keepDomains)
      ? remote.keepDomains.map((d) => String(d).trim()).filter(Boolean)
      : [],
    // Lot 32 — les étapes techniques du site (vérification anti-robot), sur
    // lesquelles la détection de connexion doit ATTENDRE au lieu de conclure.
    // Même liste blanche, même piège : sans cette ligne, la clé disparaîtrait
    // du manifeste chargé et la page « Security Check » de Hetzner repasserait
    // pour une connexion aboutie.
    attendreUrls: Array.isArray(remote.attendreUrls)
      ? remote.attendreUrls.map((u) => String(u).trim()).filter(Boolean)
      : [],
  };
}

/**
 * Ce qu'un écran utilisateur ne doit JAMAIS montrer.
 *
 * ─── D'où vient cette liste ──────────────────────────────────────────────────
 *
 * Du lot 9, §4. La fiche Free Mobile proposait alors, sous « Options
 * avancées », de lancer une commande dans un terminal avec un chemin de
 * fichier et une URL en argument. crabe s'adresse à des gens qui n'ont jamais
 * ouvert un terminal ; replier ce texte n'y changeait rien, on finit toujours
 * par ouvrir le repli quand on cherche.
 *
 * ─── Ce que le lot 17 y ajoute ───────────────────────────────────────────────
 *
 * La règle vivait dans un test, et le test seul. Elle remonte ici parce qu'elle
 * a maintenant deux appelants : le garde-fou du catalogue, et les aides de
 * champ réécrites pour dire où créer une clé d'API.
 *
 * Et surtout : **une adresse web n'est pas un chemin technique.** « Créez
 * votre clé sur https://api.ovh.com/createToken/ » est exactement ce que
 * l'utilisateur a besoin de lire — c'est même l'absence de cette phrase qui a
 * fait échouer l'utilisateur au lot 16. Les motifs de chemin (`tools/`, `/etc/`, `~/`)
 * ne sont donc PAS appliqués à l'intérieur d'une adresse : sans cette
 * précaution, une URL de console parfaitement légitime finirait refusée un
 * jour, et on retirerait la seule information utile de l'aide.
 *
 * @param {string} texte
 * @returns {string|null} ce qui a été trouvé, ou `null` si le texte est bon
 */
function jargonUtilisateur(texte) {
  const brut = String(texte || '');
  if (!brut) return null;

  // Les adresses web sont mises de côté AVANT l'examen des chemins : elles ont
  // le droit de porter des barres obliques, c'est leur nature.
  const sansUrls = brut.replace(/https?:\/\/\S+/gi, ' ');

  for (const [motif, quoi, cible] of MOTIFS_INTERDITS) {
    if (motif.test(cible === 'sans-urls' ? sansUrls : brut)) return quoi;
  }
  return null;
}

/**
 * Les motifs, et sur quel texte chacun s'applique.
 *
 * `sans-urls` = le motif ne doit pas voir ce qui est à l'intérieur d'une
 * adresse web ; `tout` = il s'applique au texte entier, une commande restant
 * une commande où qu'elle se trouve.
 */
const MOTIFS_INTERDITS = [
  [/\bnode\s+\w/i, 'une commande à taper', 'tout'],
  [/\bnpm\b|\bnpx\b|\bapt\b|\bsudo\b/i, 'une commande système', 'tout'],
  [/[\w-]+\.js\b/i, 'un nom de fichier de programme', 'sans-urls'],
  [/tools\/|\/opt\/|\/etc\/|~\//, 'un chemin technique', 'sans-urls'],
  [/fichier de session|storageState/i, 'un fichier de session', 'tout'],
];

/** Un champ dont les options viennent de `discover()`. */
function isDiscoveredField(field) {
  return field?.type === 'multiselect' && (field.source || 'discover') === 'discover';
}

/** Champs alimentés par la découverte, dans l'ordre du manifeste. */
function discoveredFields(manifest) {
  return (manifest?.fields || []).filter(isDiscoveredField);
}

/**
 * Retire les champs qui ne doivent jamais être renvoyés au client.
 *
 * `technicalNote` en fait partie depuis le lot 8 : elle dit comment le
 * connecteur s'y prend, ce qui n'intéresse que l'administrateur. La laisser
 * passer, c'est la voir réapparaître dans une fiche un jour ou l'autre.
 */
function publicView(manifest) {
  const { fields, technicalNote, ...rest } = manifest;
  return {
    ...rest,
    // Lot 21 — `keepDomains` ne descend PAS au navigateur. C'est un réglage de
    // capture, appliqué côté serveur au moment d'enregistrer la session : le
    // front n'en fait rien, et une liste que personne ne lit n'a rien à faire
    // dans une réponse HTTP. Ce que l'utilisateur doit savoir — « les cookies
    // de votre compte Google ne sont pas conservés » — est écrit en français
    // dans l'aide du champ, où il le lira. `attendreUrls` (lot 32) suit la
    // même règle : c'est la détection côté serveur qui s'en sert, pas l'écran.
    // `renvoiAnonyme` (lot 68) aussi : c'est le contrôle de session côté
    // serveur qui s'en sert, l'écran n'en fait rien.
    remoteLogin: rest.remoteLogin
      ? (({ keepDomains, attendreUrls, renvoiAnonyme, ...visible }) => visible)(rest.remoteLogin)
      : rest.remoteLogin,
    // Un connecteur qui déclare un champ alimenté par la découverte fait
    // apparaître une étape supplémentaire dans le formulaire : le front doit
    // le savoir sans avoir à deviner depuis les types de champs.
    discovery: (fields || []).some(isDiscoveredField),
    fields: fields.map(
      ({ key, label, type, required, help, options, placeholder, source, notice, accept, unit,
         unitFeminine, identification: nature, inputType, default: valeurParDefaut }) => ({
        key,
        label,
        type,
        // Ce que le site demande pour vous reconnaître, et le type de champ HTML
        // qui en découle. Le formulaire n'en décide plus rien lui-même : il
        // écrit `inputType` tel quel (voir connectors/identification.js).
        identification: nature,
        inputType,
        required,
        help,
        options,
        placeholder,
        source,
        notice,
        accept,
        unit,
        unitFeminine,
        default: valeurParDefaut,
        // Les quatre choix d'un champ `history` viennent du serveur : ce sont
        // eux qui engagent son comportement, les tenir aussi dans le front les
        // ferait diverger (voir connectors/history.js).
        choices: type === 'history' ? history.choix() : undefined,
        yearRange: type === 'history' ? { min: history.ANNEES_MIN, max: history.ANNEES_MAX } : undefined,
      })
    ),
  };
}

module.exports = {
  history,
  identification,
  CATEGORIES,
  DESCRIPTION_MAX,
  CAVEAT_MAX,
  FIELD_TYPES,
  OPTION_SOURCES,
  SECRET_FIELD_TYPES,
  IMPLEMENTATIONS,
  STATUSES,
  COULEURS_PASTILLE,
  couleurParDefaut,
  lettresParDefaut,
  vocabulary,
  validate,
  validatePermissions,
  validateIdentification,
  validateUrls,
  validateDescription,
  validateCaveat,
  validateUnfeasible,
  compterPhrases,
  isGenericDescription,
  jargonUtilisateur,
  MOTIFS_INTERDITS,
  normalize,
  normalizeField,
  isDiscoveredField,
  discoveredFields,
  publicView,
};
