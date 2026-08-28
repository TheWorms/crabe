'use strict';

/**
 * Orchestration des destinations de stockage.
 *
 * Configuration GLOBALE, administrateur uniquement : un utilisateur ne voit
 * jamais où vont ses factures, seulement combien de place elles prennent.
 *
 * ─── Le modèle, et ce qu'il a remplacé au lot 25 ─────────────────────────────
 *
 * Jusqu'au lot 24, les destinations étaient SIX CONSTANTES du code — le stockage local,
 * Proton Drive, pCloud, MEGA, kDrive, « Autre stockage » —, une par module, et
 * livrer un fournisseur de plus demandait une version de crabe. Le modèle est
 * inversé depuis :
 *
 *   - **Le stockage local** reste à part, en dur, et pour une raison qui n'est pas
 *     historique : c'est le stockage LOCAL, la copie de référence, celle depuis
 *     laquelle tout le reste est relu. Il ne s'ajoute ni ne se supprime.
 *   - **Chaque cloud est une ligne** de `destinations_config`, créée par
 *     l'utilisateur avec le nom qu'il choisit. Deux comptes pCloud sont deux
 *     lignes, indépendantes jusqu'à leurs identifiants.
 *
 * Le pilote n'est donc plus cherché dans une table : il est FABRIQUÉ pour la
 * ligne, à partir de son fournisseur (`presets.js`) et du pilote commun
 * (`remote-rclone.js`). Le reste du module — dépôt, test, purge, mesure
 * d'espace — n'a pas eu à changer : il demandait déjà « le pilote de cette
 * destination », il continue, par `driverFor()`.
 *
 * L'échec d'un cloud n'invalide jamais une récupération ; celui du stockage local, si.
 */

const db = require('../db/db');
const crypto = require('../crypto');
const applog = require('../applog');
const accountIds = require('../connectors/account-id');
const catalogue = require('./catalogue');
const presets = require('./presets');
const paths = require('./paths');
const rclone = require('./rclone');
const erreurs = require('./erreurs-rclone');
const local = require('./local');
const space = require('./space');
const { creerDestination } = require('./remote-rclone');
const autorisation = require('./autorisation');

const backends = require('./backends');

/**
 * Les pilotes déjà fabriqués, par identifiant de destination.
 *
 * C'est un CACHE, pas une liste : ce qui existe est en base, et cet objet ne
 * fait qu'éviter de refabriquer le même pilote à chaque dépôt de document.
 * `oublierPilotes()` le vide après toute écriture sur `destinations_config` —
 * renommer un cloud ou changer son fournisseur doit se voir immédiatement.
 *
 * Il reste exporté sous le nom `DRIVERS` parce que les tests y posent des
 * pilotes en trompe-l'œil pour simuler une panne de cloud sans réseau : une
 * entrée écrite ici prime sur la fabrication.
 */
const DRIVERS = { local };

function oublierPilotes() {
  for (const id of Object.keys(DRIVERS)) {
    if (id !== 'local') delete DRIVERS[id];
  }
  catalogue.oublier();
}

/**
 * Le pilote d'une destination — celui du stockage local, ou un pilote rclone
 * fabriqué pour cette ligne-là.
 *
 * Rend `null` pour une destination qui n'existe pas (ou plus) : tous les
 * appelants le vérifient, et rendre un pilote factice ferait échouer un dépôt
 * là où il faut refuser une route.
 *
 * @param {string} destId
 * @returns {object|null}
 */
function driverFor(destId) {
  if (DRIVERS[destId]) return DRIVERS[destId];

  const ligne = row(destId);
  if (!ligne || ligne.deleted_at) return null;

  const preset = presets.of(ligne.provider) || presets.of('autre');
  DRIVERS[destId] = creerDestination({
    id: destId,
    // Le nom que l'utilisateur a donné : c'est lui qui apparaît dans les
    // messages d'erreur (« pCloud perso : … »), et c'est le seul qui lui parle.
    name: ligne.display_name || preset.label,
    // Un nom de remote interne au fichier de configuration rclone, stable et
    // sans intérêt pour qui que ce soit : il ne s'affiche nulle part.
    defaultRemote: 'crabe',
    backend: preset.backend,
    champs: preset.champs || [],
    versChamps: preset.versChamps || ((v) => v),
    // Le bucket d'un espace S3 passe devant le dossier de base (lot 62).
    versBase: preset.versBase || null,
  });
  return DRIVERS[destId];
}

/**
 * Les champs du formulaire d'une destination.
 *
 * Deux provenances, et c'est le fournisseur qui tranche :
 *
 *   - un preset qui déclare ses champs (MEGA, kDrive) ouvre le formulaire avec
 *     eux : ce sont les aides écrites en français, les pièges documentés, le
 *     travail de mesure du lot 24 ;
 *   - sinon (pCloud, Proton Drive, « Autre stockage »), ils sont DEMANDÉS à
 *     rclone pour le type retenu. On ne devine rien : rclone dit lui-même ce
 *     qu'il lui faut, ce qui est obligatoire et ce qui est un secret.
 *
 * ⚠ Cette fonction est le point d'accord entre l'écran, l'enregistrement et
 * l'obscurcissement des mots de passe. Les trois doivent voir la MÊME liste :
 * un champ absent de la liste au moment d'enregistrer serait rangé sans passer
 * par `rclone obscure`, et rclone refuserait ensuite un mot de passe pourtant
 * juste — sans que rien n'explique pourquoi.
 *
 * @param {string} destId
 * @param {string} [typeDemande] le type en cours de saisie, quand il n'est pas
 *   encore enregistré (l'utilisateur vient de le choisir dans la liste)
 * @returns {Promise<Array<object>>}
 */
async function champsDe(destId, typeDemande = '') {
  const ligne = row(destId);
  if (!ligne || destId === 'local') return [];

  const preset = presets.of(ligne.provider) || presets.of('autre');
  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  const type = String(typeDemande || conf.type || preset.backend || '').trim();
  if (!type) return preset.champs || [];

  // ⚠ Les champs « avancés » d'rclone ne sont PLUS écartés (lot 29). Ils
  // l'étaient au motif qu'ils sont nombreux et rarement utiles — sauf que
  // `mailbox_password`, le second mot de passe d'un compte Proton Drive, en
  // fait partie, comme le jeton d'autorisation de pCloud ou de Dropbox. Les
  // jeter, c'était rendre ces destinations impossibles à configurer, sans que
  // rien à l'écran ne dise pourquoi. Ils sont désormais rendus, marqués
  // `avance`, et l'écran les range dans le repli « Réglages avancés ».
  //
  // Ce qui reste écarté, c'est ce qu'rclone lui-même masque (`masque`) : ses
  // valeurs de travail, qu'il écrit après coup et que nul ne peut saisir.
  const dRclone = presets.habiller(type, (await backends.champsDuType(type)) || []);

  return (preset.champs ? [...preset.champs, ...complement(preset, dRclone)] : dRclone)
    // rclone marque ses secrets par `IsPassword`, traduit en `type: 'password'`
    // par `backends.js`. C'est ce drapeau qui décide qu'une valeur doit passer
    // par `rclone obscure` avant d'être rangée — SAUF si l'habillage a posé
    // `obscurcir: false` : le jeton pCloud est un secret (jamais réaffiché),
    // mais rclone l'attend en clair, et l'obscurcir le rendrait inutilisable.
    .map((c) => (c.type === 'password' && c.obscurcir !== false ? { ...c, obscurcir: true } : c));
}

/**
 * Contrôle de forme d'une saisie, champ par champ (lot 33).
 *
 * Le 14/08/2026, la « Clé de votre application d'authentification » de Proton
 * Drive contenait un code à six chiffres : chaque dépôt échouait, en anglais,
 * des heures après la saisie. Un champ qui déclare un `controle` (voir
 * presets.js) est vérifié ICI, au moment d'enregistrer — le refus arrive tout
 * de suite, avec un message qui dit quoi faire.
 *
 * La normalisation déclarée (retirer les espaces d'une clé, par exemple) est
 * appliquée à la valeur RENDUE : ce qui est rangé est la forme propre.
 * Une valeur vide n'est jamais contrôlée — vide veut dire « garde celui
 * d'avant » pour un secret, « rien » pour le reste.
 *
 * @param {Array<object>} champs les champs résolus par `champsDe()`
 * @param {object} valeurs ce que le formulaire envoie
 * @returns {object} les valeurs, normalisées
 * @throws {Error} statusCode 400, message écrit pour l'utilisateur
 */
function validerSaisie(champs, valeurs) {
  if (!valeurs || typeof valeurs !== 'object') return valeurs;
  const sortie = { ...valeurs };
  for (const champ of Array.isArray(champs) ? champs : []) {
    const controle = champ?.controle;
    if (!controle) continue;
    const brut = sortie[champ.key];
    if (typeof brut !== 'string' || !brut.trim()) continue;

    const texte = typeof controle.normaliser === 'function'
      ? controle.normaliser(brut)
      : brut.trim();

    const refuse = (message) => {
      const err = new Error(
        message
          || `La valeur du champ « ${champ.label || champ.key} » n'a pas la forme attendue.`
      );
      err.statusCode = 400;
      throw err;
    };

    // Les refus EXPLICITES d'abord : ils reconnaissent une confusion précise
    // (un code là où on attend une clé) et portent le message le plus utile.
    for (const regle of Array.isArray(controle.refus) ? controle.refus : []) {
      if (regle?.motif && new RegExp(regle.motif, 'i').test(texte)) refuse(regle.message);
    }
    if (controle.motif && !new RegExp(controle.motif).test(texte)) refuse(controle.message);

    sortie[champ.key] = texte;
  }
  return sortie;
}

/**
 * Ce qu'un formulaire écrit à la main ne demande pas, et qu'rclone accepte.
 *
 * ─── Le trou que ça bouche (lot 29) ──────────────────────────────────────────
 *
 * Un preset à formulaire écrit ne montrait QUE ses propres champs : MEGA en
 * déclare deux, là où le backend `mega` d'rclone en accepte dix. Les huit
 * autres étaient hors d'atteinte — sans message, sans repli, sans rien. C'est
 * le même trou que les options avancées, en plus discret : il ne se découvre
 * qu'au moment où quelqu'un a précisément besoin du champ manquant.
 *
 * Le complément arrive donc derrière le formulaire soigné, marqué avancé, dans
 * le repli. L'écran d'un service courant ne bouge pas d'un pixel ; ce qui
 * manquait cesse de manquer.
 *
 * ─── L'exception, et pourquoi elle est saine ─────────────────────────────────
 *
 * Un preset qui TRANSFORME ses valeurs (`versChamps`) n'est pas complété.
 * kDrive en est le seul cas : il demande un numéro de kDrive et FABRIQUE
 * l'adresse WebDAV, le `vendor` et le reste. Lui ajouter le champ `url` du
 * backend `webdav` afficherait une case que `versChamps` écrase juste après —
 * un champ qui ne fait rien est pire qu'un champ absent, parce qu'il se
 * remplit avec confiance.
 */
function complement(preset, champsRclone) {
  if (preset.versChamps) return [];
  const dejaLa = new Set((preset.champs || []).map((c) => c.key));
  return champsRclone
    .filter((c) => !dejaLa.has(c.key))
    .map((c) => ({ ...c, avance: true }));
}

/** Ligne de configuration brute d'une destination. */
function row(destId) {
  return db.get().prepare('SELECT * FROM destinations_config WHERE dest_id = ?').get(destId);
}

/**
 * Les lignes vivantes, le stockage local en tête puis les clouds par nom.
 *
 * Les lignes supprimées sont écartées ici, et nulle part ailleurs : elles
 * restent en base pour que les factures déjà copiées gardent le nom de
 * l'endroit où elles sont parties (voir `catalogue.js`).
 */
function lignes() {
  // ⚠ Le stockage local supprimé reste dans la liste (lot 26), marqué comme tel. Un
  // cloud supprimé disparaît : on le recrée en trois clics, ses identifiants
  // sont partis de toute façon. Le stockage local, lui, ne se recrée pas — il se REMET
  // en service, et le retirer de l'écran ferait disparaître le seul bouton qui
  // sait le faire. Un stockage qu'on ne peut plus remettre serait une
  // suppression déguisée en aller simple.
  const rows = db
    .get()
    .prepare(
      "SELECT * FROM destinations_config WHERE deleted_at IS NULL OR dest_id = 'local'"
    )
    .all();
  const localRow = rows.find((r) => r.dest_id === 'local');
  const clouds = rows
    .filter((r) => r.dest_id !== 'local')
    .sort((a, b) =>
      String(a.display_name || a.dest_id).localeCompare(
        String(b.display_name || b.dest_id),
        'fr',
        { sensitivity: 'base', numeric: true }
      )
    );
  return localRow ? [localRow, ...clouds] : clouds;
}

/** Les identifiants des clouds existants — tout sauf le stockage local. */
function cloudIds() {
  return lignes()
    .map((r) => r.dest_id)
    .filter((id) => id !== 'local');
}

/** L'ordre d'affichage : le stockage local, puis les clouds par nom. */
function ordre() {
  return lignes().map((r) => r.dest_id);
}

/** Configuration déchiffrée, prête à être passée au driver. */
function readConfig(destId) {
  const r = row(destId);
  if (!r) return null;
  if (destId === 'local') {
    return { enabled: !!r.enabled, path: r.path, protocol: r.protocol || 'local' };
  }
  return {
    enabled: !!r.enabled,
    ...(crypto.tryDecryptJson(r.config_encrypted, {}) || {}),
  };
}

/**
 * La configuration chiffrée d'une destination est-elle ILLISIBLE ?
 *
 * Vrai uniquement quand une configuration EXISTE et que son déchiffrement
 * échoue (phrase secrète absente ou changée). Le repli de `tryDecryptJson`
 * ressemble à « aucune configuration » (piège du lot 29) : sans cette
 * distinction, l'écran dirait « pas configuré » d'un espace configuré dont
 * seule la clé manque — et le geste proposé (configurer) écraserait ce qui
 * existe.
 */
function configIllisible(destId) {
  const r = row(destId);
  if (!r || destId === 'local' || !r.config_encrypted) return false;
  const SENTINELLE = { __dechiffrementEchoue: true };
  return crypto.tryDecryptJson(r.config_encrypted, SENTINELLE) === SENTINELLE;
}

/** Vue destinée à l'admin : jamais de secret en clair. */
function publicConfig(destId) {
  const r = row(destId);
  if (!r) return null;
  if (destId === 'local') {
    const conf = { path: r.path || '', protocol: r.protocol || 'local' };
    return {
      // Le stockage local n'a pas de site : son icône est interne au dépôt, et aucune
      // récupération n'est jamais tentée (voir destinations/catalogue.js).
      ...catalogue.brand('local'),
      displayName: local.NAME,
      // ⚠ `required` ne veut plus dire « indispensable » (lot 26) mais
      // « n'a pas de formulaire d'identifiants » : le stockage local se supprime
      // désormais comme un cloud. Ce drapeau reste vrai parce que c'est lui qui
      // dit à l'écran de ne pas dessiner de champs de connexion — le stockage local est
      // un dossier, il n'a pas de mot de passe.
      required: true,
      // Supprimable, et remis en service d'un seul geste : le chemin n'est
      // jamais effacé, donc il n'y a rien à ressaisir.
      supprimable: true,
      supprime: !!r.deleted_at,
      enabled: !r.deleted_at && !!r.enabled,
      ...conf,
      configured: !!r.path,
      // Pastille d'état de la page Stockage : lecture seule, sans effet de bord.
      state: local.quickState(conf),
      mounted: local.isMountPoint(conf.path),
    };
  }
  const conf = crypto.tryDecryptJson(r.config_encrypted, {}) || {};
  const driver = driverFor(destId);
  if (!driver) return null;
  const normalise = driver.normalizeConf(conf);
  const preset = presets.of(r.provider) || presets.of('autre');
  const type = normalise.type || driver.typeDe(normalise) || '';

  return {
    // La couleur, la lettre et le logo viennent du catalogue, jamais d'une
    // table écrite dans le navigateur : jusqu'au lot 24, `web/admin.js` portait
    // un `DEST_STYLE` en dur avec les six identifiants connus, et un cloud créé
    // par l'utilisateur n'y aurait rien trouvé du tout.
    ...catalogue.brand(destId),
    // Ce qui distingue une ligne d'une autre pour l'écran : son fournisseur
    // (le logo et le formulaire) et le nom que l'utilisateur lui a donné.
    provider: preset.id,
    // ⚠ L'étiquette d'un cloud sans fournisseur nommé est le SERVICE choisi
    // (« dropbox »), pas « Autre stockage ». Mesuré dans un vrai navigateur au
    // lot 28 : la carte s'intitulait « Dropbox » suivi d'une étiquette « Autre
    // stockage », c'est-à-dire du nom d'un choix qui n'existe plus — le seul
    // endroit de l'interface où il réapparaissait après la fusion des listes.
    providerLabel: preset.backend === null && type ? type : preset.label,
    displayName: r.display_name || preset.label,
    required: false,
    enabled: !!r.enabled,
    remoteName: conf.remoteName || driver.DEFAULT_REMOTE,
    basePath: conf.basePath || 'crabe',
    // Le bloc rclone contient des identifiants : on ne renvoie que sa présence.
    configured: !!normalise.rcloneConfig,
    createdAt: r.created_at,
    updatedAt: r.updated_at,

    // ─── Ce que l'écran doit savoir pour dessiner le bon formulaire ─────────
    //
    // `champs` porte les LIBELLÉS et les aides, jamais les valeurs : un champ
    // marqué secret ne revient pas au navigateur, même rempli. `valeurs` ne
    // contient que ce qui n'est pas secret, pour qu'un formulaire rouvert
    // montre ce qui a été saisi sans jamais réafficher un mot de passe.
    //
    // ⚠ Les champs sont VIDES ici quand le fournisseur n'en déclare pas : ils
    // viennent alors d'rclone, qui s'interroge par un processus, donc de façon
    // asynchrone. C'est `publicConfigComplet()` qui les pose — cette
    // fonction-ci reste synchrone parce que six autres appelants en dépendent.
    backend: preset.backend,
    typeLibre: preset.backend === null,
    type,
    champs: (preset.champs || []).map((c) => ({ ...c, obscurcir: undefined })),
    valeurs: valeursVisibles(preset.champs || [], normalise),
    // Une configuration collée à la main plutôt que saisie champ par champ.
    // L'écran doit le savoir : réécrire les champs par-dessus ferait perdre en
    // silence un bloc qui fonctionnait.
    blocBrut: !!(conf.rcloneConfig && !Object.keys(normalise.valeurs || {}).length),
  };
}

/**
 * Les valeurs qu'un formulaire rouvert peut réafficher.
 *
 * Tout sauf les secrets : un mot de passe enregistré ne repart jamais au
 * navigateur, et son emplacement vide veut dire « garde celui d'avant ».
 */
function valeursVisibles(champs, normalise) {
  return Object.fromEntries(
    champs
      .filter((c) => c.type !== 'password')
      .map((c) => [c.key, normalise.valeurs?.[c.key] ?? ''])
  );
}

/**
 * La même vue, complétée des champs qu'il faut demander à rclone.
 *
 * Deux allers-retours de moins pour l'écran : jusqu'au lot 24, le formulaire
 * d'« Autre stockage » chargeait ses champs dans une seconde requête, après
 * avoir dessiné une carte vide. Comme tous les clouds passent désormais par ce
 * chemin, la carte arriverait vide pour tout le monde.
 *
 * ⚠ Elle s'applique à TOUS les clouds depuis le lot 29, y compris ceux dont le
 * preset écrit son formulaire. La condition d'avant s'arrêtait dès que
 * `publicConfig` avait posé des champs — c'est-à-dire toujours, pour MEGA et
 * kDrive — et le complément de `champsDe()` ne serait jamais arrivé jusqu'à
 * l'écran. `champsDe()` reste la seule liste qui fasse foi : c'est elle que
 * l'enregistrement consultera pour savoir quoi obscurcir.
 */
async function publicConfigComplet(destId) {
  const base = publicConfig(destId);
  if (!base || base.required) return base;

  const champs = await champsDe(destId);
  // ⚠ Le repli de `tryDecryptJson` ressemble à « aucune configuration » (piège
  // du lot 29). La sentinelle distingue les deux cas : sans elle, une phrase
  // secrète absente ferait dire « jamais autorisé » à une destination qui
  // l'est — et proposerait de refaire une autorisation qui marcherait.
  const SENTINELLE = { __dechiffrementEchoue: true };
  const dechiffre = crypto.tryDecryptJson(row(destId).config_encrypted, SENTINELLE);
  const dechiffrementEchoue = dechiffre === SENTINELLE && !!row(destId).config_encrypted;
  const conf = (dechiffrementEchoue ? {} : dechiffre) || {};
  const normalise = driverFor(destId).normalizeConf(conf);

  // ─── L'examen des secrets obscurcis (lot 33) ──────────────────────────────
  //
  // Les avertissements regardent la FORME des valeurs enregistrées (une clé
  // de validation qui n'est qu'un code à six chiffres, panne du 14/08/2026).
  // Or les secrets sont rangés sous leur forme `rclone obscure` — illisible
  // telle quelle. Seuls les champs porteurs d'un contrôle de forme sont
  // révélés, en mémoire, le temps de l'examen : la valeur ne sort jamais de
  // cette fonction, et une forme irrévélable est simplement ignorée.
  const valeursExaminees = { ...(normalise.valeurs || {}) };
  for (const champ of champs) {
    if (!champ.controle || !champ.obscurcir) continue;
    const brut = String(normalise.valeurs?.[champ.key] || '');
    if (!brut) continue;
    try {
      valeursExaminees[champ.key] = rclone.reveal(brut);
    } catch {
      delete valeursExaminees[champ.key];
    }
  }

  // ─── Ce que la carte doit savoir de la session, en faits datés (lot 58) ────
  //
  // Jamais les valeurs — des états : le compte demande-t-il un second facteur,
  // la clé TOTP est-elle là (de quoi se reconnecter tout seul), quand la
  // dernière connexion a-t-elle réussi, la dernière reconnexion automatique
  // a-t-elle échoué. C'est sur CES faits que la carte choisit son badge et
  // propose la clé au bon moment — pas ailleurs.
  const estProton = (normalise.type || base.type) === 'protondrive';
  const blocEnregistre = String(normalise.rcloneConfig || conf.rcloneConfig || '');
  const secretEnregistre = (cle) => Boolean(String(normalise.valeurs?.[cle] || '').trim())
    || new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(blocEnregistre);
  const cleTotpEnregistree = estProton && secretEnregistre('otp_secret_key');
  const suggererCleTotp = estProton
    && !!conf.deuxFacteurs && !!conf.reconnexionEchoueeLe && !cleTotpEnregistree;

  return {
    ...base,
    // La clé TOTP vit sous « Réglages avancés » (lot 57) — SAUF au moment où
    // elle est LA sortie : une reconnexion automatique a échoué faute d'elle,
    // la carte la suggère et le champ remonte au premier niveau (lot 58).
    champs: champs.map((c) => ({
      ...c,
      obscurcir: undefined,
      ...(suggererCleTotp && c.key === 'otp_secret_key' ? { avance: false } : {}),
    })),
    valeurs: valeursVisibles(champs, normalise),
    // Les CLÉS des secrets qui ont une valeur enregistrée — jamais les
    // valeurs. C'est ce qui permet au formulaire de dire « une valeur est
    // enregistrée » sous le bon champ, et d'offrir son effacement (lot 33) :
    // avant, la case vide ne disait pas si enregistrer conservait ou effaçait.
    secretsRenseignes: champs
      .filter((c) => c.type === 'password' && String(normalise.valeurs?.[c.key] || '').trim())
      .map((c) => c.key),
    // Ce qui condamne les prochains dépôts, dit sur la carte plutôt que
    // découvert en anglais dans un journal (voir presets.avertissements).
    avertissements: presets.avertissements(normalise.type || base.type, {
      ...normalise,
      valeurs: valeursExaminees,
    }),
    // ─── L'autorisation menée par crabe (lot 34) ────────────────────────────
    //
    // Ce que la carte a le droit de savoir : ce type passe-t-il par le bouton
    // « Se connecter », et où en est le jeton — jamais le jeton lui-même.
    // `indeterminee` quand le déchiffrement a échoué : on ne dit pas « jamais
    // autorisé » à qui l'est peut-être (piège du lot 29).
    autorisation: await etatAutorisationPour(normalise, base, dechiffrementEchoue),
    // ─── La session durable Proton (lot 34) ─────────────────────────────────
    //
    // Un booléen, jamais les valeurs : les quatre `client_*` qu'rclone écrit
    // après une connexion réussie sont des secrets de session. Présentes,
    // crabe se reconnecte sans mot de passe ni code 2FA — la carte le dit,
    // c'est le gain de sécurité du lot (une session se révoque chez Proton,
    // une clé TOTP stockée à demeure supprime le second facteur).
    sessionDurable: (normalise.type || base.type) === 'protondrive'
      ? ['client_access_token', 'client_uid'].every(
        (cle) => String(normalise.valeurs?.[cle] || '').trim()
          || new RegExp(`^${cle}\\s*=\\s*\\S`, 'm').test(String(normalise.rcloneConfig || ''))
      )
      : undefined,
    // ─── La session refusée par le service, dite sur la carte (lot 57) ──────
    //
    // La date du refus, jamais les valeurs. Présente, la carte remplace le
    // badge vert par « Session refusée par le service » et demande une
    // reconnexion — au lieu de laisser croire que crabe se reconnecte seul
    // avec une session qu'il n'a plus le droit de rejouer.
    sessionMorteLe: (normalise.type || base.type) === 'protondrive' && conf.sessionMorteLe
      ? conf.sessionMorteLe
      : undefined,
    // ─── Les trois états de la carte, en faits datés (lot 58) ───────────────
    //
    // `sessionEtablieLe` : la dernière fois qu'rclone a écrit ou tourné la
    // session — la dernière connexion réussie, datée. `reconnexionAuto` :
    // mot de passe + clé TOTP enregistrés — crabe peut rouvrir la connexion
    // tout seul si le service révoque. `suggererCleTotp` : une reconnexion
    // automatique a échoué faute de clé — la proposer maintenant, c'est le
    // bon moment ; la proposer ailleurs serait du bruit.
    sessionEtablieLe: estProton ? conf.sessionEtablieLe || null : undefined,
    reconnexionAuto: estProton
      ? secretEnregistre('password') && cleTotpEnregistree
      : undefined,
    suggererCleTotp: estProton ? suggererCleTotp : undefined,
  };
}

/**
 * L'état d'autorisation d'une destination, pour sa carte.
 *
 * Le jeton peut vivre à deux endroits selon la façon dont la destination a
 * été configurée : `valeurs.token` (formulaire) ou une ligne `token = …` d'un
 * bloc rclone collé. Les deux sont lus ; rien n'en sort d'autre que l'état.
 */
async function etatAutorisationPour(normalise, base, dechiffrementEchoue) {
  const type = normalise.type || base.type || '';
  if (!(await autorisation.typeAutorisable(type))) return { possible: false };
  if (dechiffrementEchoue) return { possible: true, etat: 'indeterminee', echeance: null };
  const jeton = String(normalise.valeurs?.token || '').trim()
    || (String(normalise.rcloneConfig || '').match(/^token\s*=\s*(.+)$/m)?.[1] || '').trim();
  return { possible: true, ...autorisation.etatDuJeton(jeton) };
}

/**
 * Ce que la route d'autorisation a besoin de savoir d'une destination —
 * et RIEN de plus. Les valeurs déchiffrées ne servent qu'aux réponses
 * préalables (`RCLONE_<TYPE>_<OPTION>`) ; le jeton n'y figure pas.
 *
 * `dechiffrementEchoue` est distingué (piège du lot 29) : autoriser par-dessus
 * une configuration illisible finirait, à l'enregistrement, par écraser tout
 * ce qu'elle contenait — la route refuse, plutôt que de perdre en silence.
 */
function pourAutorisation(destId) {
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at || destId === 'local') return null;

  const SENTINELLE = { __dechiffrementEchoue: true };
  const dechiffre = crypto.tryDecryptJson(ligne.config_encrypted, SENTINELLE);
  const dechiffrementEchoue = dechiffre === SENTINELLE && !!ligne.config_encrypted;
  const conf = (dechiffrementEchoue ? {} : dechiffre) || {};
  const normalise = driverFor(destId).normalizeConf(conf);
  const preset = presets.of(ligne.provider) || presets.of('autre');

  return {
    type: normalise.type || preset.backend || '',
    nom: ligne.display_name || preset.label,
    valeurs: { ...(normalise.valeurs || {}) },
    dechiffrementEchoue,
  };
}

/**
 * Range un jeton d'autorisation dans la configuration chiffrée (lot 34).
 *
 * Le SEUL chemin d'écriture du jeton obtenu par la fenêtre de crabe : il
 * passe par `saveConfig` — mêmes règles de fusion que le formulaire, aucun
 * garde-fou contourné. `indiceRegion` est le `hostname` vu passer dans la
 * redirection pCloud : il est rangé avec le jeton parce que le jeton ne le
 * porte pas et qu'un compte européen ne répond pas sans lui (mesuré,
 * « Invalid 'access_token' (2094) »).
 */
function enregistrerJeton(destId, jeton, indiceRegion = null) {
  // La configuration a deux formes possibles, et le jeton doit aller là où
  // elle vit : un bloc rclone collé PRIME sur les champs nommés
  // (`normalizeConf`) — un jeton rangé dans `valeurs` sous un bloc existant
  // serait ignoré à la première opération, en silence.
  const precedent = crypto.tryDecryptJson(row(destId)?.config_encrypted, {}) || {};
  if (precedent.rcloneConfig) {
    let bloc = String(precedent.rcloneConfig);
    bloc = /^token\s*=/m.test(bloc)
      ? bloc.replace(/^token\s*=.*$/m, `token = ${String(jeton)}`)
      : `${bloc.trim()}\ntoken = ${String(jeton)}`;
    if (indiceRegion) {
      bloc = /^hostname\s*=/m.test(bloc)
        ? bloc.replace(/^hostname\s*=.*$/m, `hostname = ${String(indiceRegion)}`)
        : `${bloc.trim()}\nhostname = ${String(indiceRegion)}`;
    }
    return saveConfig(destId, { rcloneConfig: bloc });
  }

  const valeurs = { token: String(jeton) };
  const champsConnus = [{ key: 'token', type: 'password' }];
  if (indiceRegion) {
    valeurs.hostname = String(indiceRegion);
    champsConnus.push({ key: 'hostname', type: 'text' });
  }
  return saveConfig(destId, { valeurs }, champsConnus);
}

/**
 * Crée le dossier de base de crabe sur une destination (lot 35).
 *
 * Appelé à la fin d'une autorisation réussie, APRÈS l'enregistrement du jeton :
 * la configuration est relue depuis la base, donc le mkdir est joué sur le
 * bloc rclone EXACT que les copies emploieront — jeton neuf et hostname de
 * région compris. Un mkdir joué sur un autre bloc prouverait autre chose que
 * ce que la copie fera (le piège documenté sur `rclone.adresse`).
 *
 * @throws {Error} si la destination est inconnue, sans configuration, ou si
 *   rclone refuse l'écriture — l'appelant décide quoi en dire.
 */
async function creerDossierDeBase(destId) {
  const driver = driverFor(destId);
  if (!driver || destId === 'local') throw new Error(`Destination inconnue : ${destId}`);
  const normalise = driver.normalizeConf(readConfig(destId) || {});
  if (!normalise.rcloneConfig) throw new Error('Cette destination n\'a pas de configuration.');
  await rclone.creerDossierDeBase(normalise);
}

function listPublic() {
  return ordre().map(publicConfig).filter(Boolean);
}

/** La liste de l'écran d'administration, formulaires compris. */
async function listPublicComplet() {
  const out = [];
  for (const id of ordre()) {
    const vue = await publicConfigComplet(id);
    if (vue) out.push(vue);
  }
  return out;
}

/**
 * Crée un cloud, et rien d'autre : il est vide, éteint, et attend son
 * formulaire.
 *
 * L'identifiant est tiré au sort plutôt que dérivé du nom, et c'est délibéré :
 * il ne changera jamais (voir la migration 29), alors qu'un nom se renomme.
 * Un identifiant qui contiendrait le nom deviendrait mensonger au premier
 * renommage, et le corriger demanderait de réécrire l'historique de copie de
 * chaque facture — exactement ce qu'on refuse de faire.
 *
 * @param {{provider: string, displayName?: string, type?: string}} demande
 *   `type` n'a de sens que pour un fournisseur qui n'en impose pas — c'est le
 *   type rclone choisi dans la liste d'ajout (lot 28). Ailleurs il est ignoré :
 *   le fournisseur a déjà tranché, et le laisser passer permettrait de créer
 *   une carte « pCloud » qui parlerait en réalité à Dropbox.
 * @returns {object} la vue publique du cloud créé
 */
function createCloud({ provider, displayName, type }) {
  const preset = presets.of(provider);
  if (!preset || preset.id === 'local') {
    const err = new Error('Ce type d\'espace de stockage n\'existe pas.');
    err.statusCode = 400;
    throw err;
  }

  const nom = String(displayName || '').trim().slice(0, 60) || preset.label;

  // Une collision est improbable (4 milliards de valeurs) mais pas impossible,
  // et elle écraserait la configuration d'un cloud existant : on tire jusqu'à
  // tomber sur un identifiant libre plutôt que de faire confiance au hasard.
  let destId;
  do {
    destId = `cloud-${require('node:crypto').randomBytes(4).toString('hex')}`;
  } while (row(destId));

  db.get()
    .prepare(
      `INSERT INTO destinations_config (dest_id, enabled, display_name, provider, created_at, updated_at)
            VALUES (?, 0, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(destId, nom, preset.id);

  oublierPilotes();

  // Le type choisi est rangé tout de suite, dans le même geste : la carte
  // arrive alors avec ses champs déjà dessinés. Sans cela, elle s'ouvrirait sur
  // « Choisissez d'abord un type de stockage » alors que l'utilisateur vient
  // précisément de le choisir — on lui redemanderait ce qu'il vient de dire.
  const typeVoulu = String(type || '').trim();
  if (typeVoulu && preset.backend === null) saveConfig(destId, { type: typeVoulu });

  return publicConfig(destId);
}

/**
 * Refuse d'éteindre la DERNIÈRE destination active (lot 38).
 *
 * « Au moins une destination active » a remplacé « le stockage local obligatoire » :
 * n'importe quel espace peut partir — tant qu'il en reste un autre où écrire.
 * Sans ce garde-fou, un dernier interrupteur laisserait crabe sans nulle part
 * où déposer quoi que ce soit, et chaque récupération échouerait ; le filet
 * `aucunStockageActif()` reste en place pour l'état déjà atteint, mais on ne
 * propose plus le geste qui y mène.
 *
 * @throws {Error} 400, en français, avec le geste qui débloque
 */
function garderUneDestination(destId) {
  if (activeDestinations().some((id) => id !== destId)) return;
  const err = new Error(
    'C\'est votre dernier espace de stockage actif : sans lui, crabe n\'aurait plus '
      + 'nulle part où déposer vos documents. Activez d\'abord un autre espace dans '
      + 'Paramètres → Stockage, puis retirez celui-ci.'
  );
  err.statusCode = 400;
  throw err;
}

/**
 * Supprime un cloud — ses identifiants, pas sa trace.
 *
 * `config_encrypted` est effacé : c'est ce que veut dire « supprimer » pour qui
 * clique dessus, et laisser dormir un mot de passe chiffré dont plus personne
 * ne se sert n'a aucune justification.
 *
 * La LIGNE, elle, reste, avec son nom et son fournisseur. Sans elle, chaque
 * facture déjà copiée là-bas afficherait une pastille « cloud-3f8a2b91 » à la
 * place de « pCloud perso » — on ferait douter d'une copie qui a réellement eu
 * lieu, pour économiser une ligne dans une table.
 */
function deleteCloud(destId) {
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at) return null;

  // Supprimer une destination INACTIVE ne retire rien à personne ; supprimer
  // la dernière active laisserait crabe sans stockage — refusé, en français.
  if (activeDestinations().includes(destId)) garderUneDestination(destId);

  // ─── le stockage local aussi (lot 26) ─────────────────────────────────────────────
  //
  // Il était refusé, au motif qu'il est « le stockage principal de crabe ».
  // C'était confondre deux choses : le stockage local est bien la copie de RÉFÉRENCE —
  // celle depuis laquelle les autres sont servies — mais ce n'est pas une
  // raison pour l'imposer à qui n'en veut pas. Quelqu'un qui range tout sur son
  // cloud n'a pas à garder une seconde copie sur le serveur de crabe.
  //
  // Ce qui le distingue tout de même d'un cloud, et qui est fait ici :
  //
  //   - **son chemin est CONSERVÉ**, contrairement aux identifiants d'un cloud
  //     qui sont effacés. Ce n'est pas un secret, c'est l'adresse des fichiers
  //     déjà rangés : l'effacer les rendrait introuvables, et le remettre
  //     obligerait à le retaper juste. Le remettre en service est donc un seul
  //     geste, sans rien à ressaisir ;
  //   - **aucun fichier n'est touché.** Même promesse que pour un cloud : crabe
  //     cesse d'y écrire, il ne vide pas un dossier qui ne lui appartient pas.
  const estLocal = destId === 'local';

  db.get()
    .prepare(
      `UPDATE destinations_config
          SET enabled = 0,
              config_encrypted = ${estLocal ? 'config_encrypted' : 'NULL'},
              deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE dest_id = ?`
    )
    .run(destId);

  oublierPilotes();
  oublierMesureEspace(destId);
  return {
    id: destId,
    name: estLocal ? local.NAME : ligne.display_name || destId,
    // Ce qui reste après coup, pour que l'écran puisse le dire sans le deviner.
    restant: activeDestinations().length,
  };
}

/**
 * Remet en service l'espace de stockage de crabe, après suppression.
 *
 * Le pendant de la suppression : un geste, sans rien à ressaisir, puisque le
 * chemin n'a jamais été effacé. Un cloud, lui, ne se « remet » pas — il se
 * recrée, parce que ses identifiants, eux, ont bien été effacés.
 */
function restoreLocal() {
  const ligne = row('local');
  if (!ligne) return null;
  if (!ligne.deleted_at) return publicConfig('local');

  db.get()
    .prepare(
      `UPDATE destinations_config
          SET enabled = 1, deleted_at = NULL, updated_at = datetime('now')
        WHERE dest_id = 'local'`
    )
    .run();

  oublierPilotes();
  return publicConfig('local');
}

/** L'espace de stockage de crabe est-il en service ? */
function localActif() {
  const ligne = row('local');
  return !!ligne && !ligne.deleted_at && !!ligne.enabled;
}

/**
 * Enregistre la configuration d'une destination (admin).
 *
 * @param {string} destId
 * @param {object} values
 * @param {Array<object>} [champsConnus] les champs résolus par `champsDe()`,
 *   que l'appelant a déjà dû demander pour obscurcir les mots de passe. Les
 *   passer ici évite de refaire l'appel, et surtout évite qu'ils diffèrent.
 */
function saveConfig(destId, values, champsConnus = []) {
  if (!driverFor(destId)) throw new Error(`Destination inconnue : ${destId}`);

  if (destId === 'local') {
    if (!values.path) {
      const err = new Error('Le chemin du stockage local est obligatoire.');
      err.statusCode = 400;
      throw err;
    }
    db.get()
      .prepare(
        `UPDATE destinations_config
            SET path = ?, protocol = ?, enabled = 1, updated_at = datetime('now')
          WHERE dest_id = 'local'`
      )
      .run(values.path, values.protocol || 'local');
    return publicConfig('local');
  }

  // ─── La garde contre le repli silencieux (lot 45) ─────────────────────────
  //
  // `tryDecryptJson` rend son repli aussi bien pour « aucune configuration »
  // que pour « déchiffrement en échec ». Ici, la confusion DÉTRUIT : fusionner
  // les valeurs reçues avec un `previous` vide, puis rechiffrer, remplacerait
  // toute la configuration existante par le seul formulaire du jour — mots de
  // passe et jetons compris, en silence. On refuse d'écrire par-dessus ce
  // qu'on ne sait pas relire. `pourAutorisation()` refusait déjà pour cette
  // raison ; la garde vaut désormais pour TOUS les chemins qui mènent ici.
  if (configIllisible(destId)) {
    const err = new Error(
      'La configuration enregistrée de cet espace de stockage ne peut plus être déchiffrée '
        + '(la phrase secrète du serveur a changé ?). Enregistrer par-dessus l\'effacerait : '
        + 'restaurez la phrase secrète d\'origine, ou supprimez cet espace puis recréez-le.'
    );
    err.statusCode = 409;
    throw err;
  }

  // ─── `enabled` absent veut dire « ne touche pas à l'interrupteur » (lot 38) ─
  //
  // `saveConfig` est aussi appelé par les écritures INTERNES — le relevé des
  // secrets qu'rclone réécrit (`onSecretsRafraichis`), le rangement d'un jeton
  // d'autorisation — qui ne passent aucun `enabled`. L'ancien `values.enabled ?
  // 1 : 0` éteignait alors la destination en silence : un simple
  // rafraîchissement de jeton sur un espace actif le sortait des copies.
  const enabledVoulu = values.enabled === undefined
    ? (row(destId).enabled ? 1 : 0)
    : (values.enabled ? 1 : 0);

  // Désactiver explicitement la DERNIÈRE destination active : refusé, comme sa
  // suppression — même règle, même phrase.
  if (!enabledVoulu && activeDestinations().includes(destId)) {
    garderUneDestination(destId);
  }

  const driver = driverFor(destId);
  const previous = crypto.tryDecryptJson(row(destId).config_encrypted, {}) || {};

  // La marque « session morte » suit la configuration : conservée par défaut,
  // levée explicitement (`sessionMorteLe: null`) par les chemins qui savent
  // qu'une connexion vient de réussir ou qu'une saisie neuve la remplace.
  let sessionMorteLe = values.sessionMorteLe === undefined
    ? previous.sessionMorteLe || null
    : values.sessionMorteLe;

  // ─── Trois faits qui suivent la configuration (lot 58) ─────────────────────
  //
  //   - `deuxFacteurs` : ce compte demande un second facteur — su parce qu'un
  //     code ou une clé a été saisi ici, ou parce que le service l'a dit
  //     (« requires a 2FA code », via `marquerReconnexion`). Ce fait ne se
  //     dé-apprend pas tout seul : seul « Repartir de zéro » l'oublie.
  //   - `sessionEtablieLe` : la date de la dernière session écrite ou tournée
  //     par rclone — c'est-à-dire de la dernière connexion RÉUSSIE. C'est elle
  //     que la carte affiche, au lieu d'un badge sans âge.
  //   - `reconnexionEchoueeLe` : la date de la dernière reconnexion
  //     automatique qui a échoué ou n'a pas pu être tentée — c'est elle qui
  //     déclenche, au bon moment et pas ailleurs, la suggestion de renseigner
  //     la clé TOTP. La saisie de cette clé l'efface : c'est la sortie du
  //     cycle.
  let deuxFacteurs = !!previous.deuxFacteurs;
  let sessionEtablieLe = values.sessionEtablieLe === undefined
    ? previous.sessionEtablieLe || null
    : values.sessionEtablieLe;
  let reconnexionEchoueeLe = previous.reconnexionEchoueeLe || null;
  // La marque MEGA « validation en deux étapes » (lot 61) suit la
  // configuration comme les faits ci-dessus ; sa levée est plus bas, avec les
  // règles de saisie neuve.
  let megaDeuxEtapesLe = previous.megaDeuxEtapesLe || null;

  /**
   * Les champs nommés, fusionnés avec ce qui était déjà là.
   *
   * ⚠ Un champ SECRET laissé vide veut dire « garde celui d'avant », jamais
   * « efface-le ». C'est la seule règle possible dès lors qu'on ne réaffiche
   * pas un mot de passe : sans elle, corriger l'adresse e-mail d'une
   * destination effacerait son mot de passe, en silence, à chaque
   * enregistrement.
   *
   * La liste des champs est celle que l'appelant a résolue par `champsDe()` —
   * jamais celle du pilote seul. Pour un cloud dont les champs viennent
   * d'rclone, le pilote n'en déclare aucun : sans la liste passée ici, tout
   * champ serait pris pour un champ ordinaire, et un mot de passe laissé vide
   * effacerait celui qui marchait.
   */
  const champs = champsConnus.length ? champsConnus : (driver.CHAMPS || []);
  const valeurs = { ...(previous.valeurs || {}) };
  if (values.valeurs && typeof values.valeurs === 'object') {
    for (const champ of champs.length ? champs : Object.keys(values.valeurs).map((key) => ({ key }))) {
      const saisi = values.valeurs[champ.key];
      if (saisi === undefined) continue;
      const texte = String(saisi);
      const estSecret = champs.find((c) => c.key === champ.key)?.type === 'password';
      if (estSecret && !texte.trim()) continue;
      // Un champ jamais rempli n'est pas rangé (lot 29). Depuis que les options
      // avancées sont proposées, le formulaire d'un espace S3 renvoie
      // soixante-dix cases, presque toutes vides : les enregistrer telles
      // quelles remplirait la configuration chiffrée de clés qui ne veulent
      // rien dire. Un champ DÉJÀ rangé, lui, garde le droit d'être vidé — c'est
      // la seule façon d'effacer une valeur qu'on a saisie par erreur.
      if (!texte.trim() && !(champ.key in valeurs)) continue;
      valeurs[champ.key] = texte;
    }
  }

  // ─── L'effacement EXPLICITE d'un secret (lot 33) ──────────────────────────
  //
  // Un secret laissé vide veut dire « garde celui d'avant » — c'est la règle
  // juste au-dessus, et elle est bonne. Mais elle rendait un secret
  // ineffaçable : la case paraît toujours vide (les secrets ne redescendent
  // jamais au navigateur), et rien ne disait qu'enregistrer à vide CONSERVE.
  // Le formulaire envoie donc la liste des champs que l'utilisateur a
  // explicitement demandé d'effacer, et eux seuls disparaissent.
  if (Array.isArray(values.effacer)) {
    for (const cle of values.effacer) {
      delete valeurs[String(cle)];
    }
  }

  // Un bloc rclone vide signifie « garder l'existant ».
  let rcloneConfig = values.rcloneConfig ? String(values.rcloneConfig) : previous.rcloneConfig || '';
  // Le type n'est modifiable que quand le fournisseur ne l'impose pas
  // (« Autre stockage ») : ailleurs, il est celui du fournisseur choisi, et
  // le laisser changer n'aurait aucun sens.
  const type = driver.BACKEND === null
    ? String(values.type || previous.type || '').trim()
    : driver.BACKEND || '';

  // ─── Une saisie neuve et complète remplace la session conservée (lot 57) ──
  //
  // L'incident du 25/08/2026 : la session durable Proton, morte côté service,
  // restait rangée dans `valeurs` — et trois réenregistrements avec des
  // identifiants corrects n'ont rien changé, parce que la session conservée
  // remplace mot de passe ET code 2FA au moment de jouer le bloc (comportement
  // rclone mesuré au lot 34). La règle est désormais : si l'utilisateur
  // fournit de quoi rouvrir une connexion — un mot de passe, un second mot de
  // passe, un code frais ou une clé TOTP —, l'ancienne session est ÉCARTÉE et
  // la connexion se rejoue sur les saisies. Une session ne survit à un
  // réenregistrement que si rien de neuf n'est fourni.
  //
  // Un bloc rclone collé DANS CE geste n'est jamais élagué : il remplace tout,
  // et la session qu'il contient peut-être est celle que l'utilisateur veut.
  if (type === 'protondrive') {
    const saisieDe = (cle) => typeof values.valeurs?.[cle] === 'string' && values.valeurs[cle].trim();
    const saisieNeuve = ['password', 'mailbox_password', '2fa', 'otp_secret_key'].some(saisieDe);
    if (saisieNeuve) {
      for (const cle of rclone.CLES_SESSION_PROTON) delete valeurs[cle];
      if (!values.rcloneConfig && rcloneConfig) {
        rcloneConfig = rclone.CLES_SESSION_PROTON.reduce(
          (bloc, cle) => bloc.replace(new RegExp(`^${cle}\\s*=.*\\n?`, 'm'), ''),
          rcloneConfig
        );
      }
      sessionMorteLe = null;
    }
    // Un code ou une clé saisis ici : le compte demande un second facteur,
    // c'est mesuré — le fait est retenu (lot 58).
    if (saisieDe('2fa') || saisieDe('otp_secret_key')) deuxFacteurs = true;
    // La clé TOTP est LA sortie du cycle « code périmé » : sa saisie clôt
    // l'échec de reconnexion retenu, la suggestion n'a plus d'objet.
    if (saisieDe('otp_secret_key')) reconnexionEchoueeLe = null;
    // Un bloc entier collé est une configuration neuve : la marque d'avant ne
    // qualifie pas ce qu'il contient.
    if (values.rcloneConfig) sessionMorteLe = null;
  }

  // ─── La sortie du refus MEGA (lot 61) ──────────────────────────────────────
  //
  // La marque « validation en deux étapes » condamne tous les gestes vers ce
  // MEGA — c'est son rôle : la panne est structurelle tant que le compte n'a
  // pas changé. Le seul qui puisse dire « il a changé », c'est l'utilisateur,
  // et il le dit en ressaisissant son mot de passe (ou en collant un bloc
  // neuf) : la marque tombe, crabe revérifie — et la repose au premier refus
  // si rien n'a changé en vrai.
  if (type === 'mega' && megaDeuxEtapesLe) {
    const saisieDe = (cle) => typeof values.valeurs?.[cle] === 'string' && values.valeurs[cle].trim();
    if (saisieDe('pass') || values.rcloneConfig) megaDeuxEtapesLe = null;
  }

  const merged = {
    remoteName: values.remoteName || previous.remoteName || driver.DEFAULT_REMOTE,
    basePath: values.basePath || previous.basePath || 'crabe',
    rcloneConfig,
    type,
    valeurs,
    ...(sessionMorteLe ? { sessionMorteLe } : {}),
    ...(deuxFacteurs ? { deuxFacteurs: true } : {}),
    ...(sessionEtablieLe ? { sessionEtablieLe } : {}),
    ...(reconnexionEchoueeLe ? { reconnexionEchoueeLe } : {}),
    ...(megaDeuxEtapesLe ? { megaDeuxEtapesLe } : {}),
  };

  // Le nom est modifiable à tout moment, sans que rien d'autre ne bouge : il
  // ne sert qu'à l'affichage, l'identifiant reste celui de la création.
  const nom = values.displayName === undefined
    ? null
    : String(values.displayName || '').trim().slice(0, 60);

  db.get()
    .prepare(
      `UPDATE destinations_config
          SET enabled = ?, config_encrypted = ?,
              display_name = COALESCE(NULLIF(?, ''), display_name),
              updated_at = datetime('now')
        WHERE dest_id = ?`
    )
    .run(enabledVoulu, crypto.encrypt(merged), nom, destId);

  // Le nom et le fournisseur alimentent les pastilles et le nom du pilote :
  // sans cet oubli, un cloud renommé garderait son ancien nom jusqu'au
  // redémarrage du service.
  oublierPilotes();
  // La configuration vient de changer : la mesure d'espace en cache portait
  // sur l'ancienne, la prochaine vue mesure à neuf.
  oublierMesureEspace(destId);
  return publicConfig(destId);
}

/**
 * Ce qui, dans un refus d'rclone, dit une session refusée par le service —
 * et non un mot de passe faux. Signatures mesurées le 25/08/2026 en
 * production : « 401 Invalid access token » puis « 400 Invalid refresh token
 * (Code=10013) ». Un mot de passe refusé ne produit aucune de ces phrases.
 */
const SIGNATURE_SESSION_MORTE = /invalid access token|invalid refresh token|Code=10013/i;

/**
 * Marque morte la session durable d'une destination que le service refuse
 * (lot 57).
 *
 * Appelée par `rclone.withConfig` (via `onSessionRefusee`) à chaque échec
 * d'opération, avec le texte complet. Elle ne retient que les signatures de
 * session refusée, et seulement si une session est réellement enregistrée :
 * un mot de passe faux, un réseau muet, un quota plein ne marquent rien.
 *
 * Une fois la marque posée, `normalizeConf` écarte la session (et le code à
 * usage unique) de tout bloc joué : elle n'est plus JAMAIS rejouée — la carte
 * le dit et demande une reconnexion. La marque se lève par une saisie neuve
 * (`saveConfig`) ou par une session neuve écrite par rclone
 * (`onSecretsRafraichis`).
 */
function marquerSessionMorte(destId, texte) {
  if (!SIGNATURE_SESSION_MORTE.test(String(texte || ''))) return false;
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at || destId === 'local') return false;
  if (configIllisible(destId)) return false;

  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  const bloc = String(conf.rcloneConfig || '');
  const enregistree = (cle) => Boolean(String(conf.valeurs?.[cle] || '').trim())
    || new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(bloc);
  if (!enregistree('client_access_token') || !enregistree('client_uid')) return false;
  if (conf.sessionMorteLe) return true;

  conf.sessionMorteLe = new Date().toISOString();
  // Écriture directe, à l'identique près de la marque : `saveConfig` fusionne
  // et revalide, ce qui n'a pas d'objet ici — rien d'autre ne change.
  db.get()
    .prepare(
      "UPDATE destinations_config SET config_encrypted = ?, updated_at = datetime('now') WHERE dest_id = ?"
    )
    .run(crypto.encrypt(conf), destId);
  oublierPilotes();
  oublierMesureEspace(destId);
  applog.warn(
    'destinations',
    `${ligne.display_name || destId} — le service a refusé la session enregistrée : elle `
      + 'ne sera plus rejouée. Reconnectez-vous depuis la carte de cette destination '
      + '(Paramètres → Stockage).'
  );
  return true;
}

/**
 * Retient que ce MEGA a la validation en deux étapes active (lot 61).
 *
 * Mesuré le 26/08/2026 : la création de l'espace réussit, puis chaque dépôt
 * échoue sur « couldn't login: The upload target URL you are trying to access
 * has expired » — la bibliothèque MEGA de l'outil de copie rejoue à chaque
 * appel un jeton multifacteur déjà expiré, défaut documenté et jamais corrigé.
 * Ce matin-là, trois documents ont coûté dix-huit tentatives de connexion en
 * trois minutes, et 744 documents restaient en file : sans cette marque,
 * chaque geste suivant aurait remartelé le service.
 *
 * La marque (`megaDeuxEtapesLe`, datée) arme le refus avant service du pilote
 * — même mécanique que le Proton sans clé TOTP (lot 58). Elle se lève par une
 * saisie neuve du mot de passe (`saveConfig`), un bloc collé, ou « Repartir
 * de zéro » : les trois disent « la situation du compte a changé, revérifie ».
 */
function marquerMegaDeuxEtapes(destId, texte) {
  if (!erreurs.SIGNATURE_MEGA_DEUX_ETAPES.test(String(texte || ''))) return false;
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at || destId === 'local') return false;
  if (configIllisible(destId)) return false;

  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  if (conf.megaDeuxEtapesLe) return true;

  conf.megaDeuxEtapesLe = new Date().toISOString();
  db.get()
    .prepare(
      "UPDATE destinations_config SET config_encrypted = ?, updated_at = datetime('now') WHERE dest_id = ?"
    )
    .run(crypto.encrypt(conf), destId);
  oublierPilotes();
  oublierMesureEspace(destId);
  applog.error(
    'destinations',
    `${ligne.display_name || destId} — MEGA avec validation en deux étapes : l'outil de `
      + 'copie ne sait pas tenir cette combinaison (défaut connu, jamais corrigé). crabe '
      + 'ne tentera plus de connexion vers cette destination ; le détail et les deux '
      + 'voies possibles sont sur sa carte (Paramètres → Stockage).'
  );
  return true;
}

/**
 * Retient ce qu'une reconnexion automatique vient d'apprendre (lot 58).
 *
 * Deux faits, écrits directement comme la marque de session (rien d'autre ne
 * change) : `deuxFacteurs` quand le service a exigé un second facteur — c'est
 * lui qui interdira les prochains logins voués à l'échec —, et
 * `reconnexionEchoueeLe`, la date qui déclenche sur la carte la suggestion de
 * renseigner la clé TOTP (la sortie du cycle « code périmé »).
 */
function marquerReconnexion(destId, { echouee = false, deuxFacteurs = false } = {}) {
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at || destId === 'local') return false;
  if (configIllisible(destId)) return false;

  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  if (echouee) conf.reconnexionEchoueeLe = new Date().toISOString();
  if (deuxFacteurs) conf.deuxFacteurs = true;
  db.get()
    .prepare(
      "UPDATE destinations_config SET config_encrypted = ?, updated_at = datetime('now') WHERE dest_id = ?"
    )
    .run(crypto.encrypt(conf), destId);
  oublierPilotes();
  return true;
}

/**
 * Le plafond de reconnexions d'un chantier entier (harmonisation) — TROIS, et
 * voici pourquoi ce chiffre :
 *
 *   1. la session du départ peut être morte sans que personne le sache encore
 *      (elle meurt ENTRE deux gestes — c'est l'incident du 25/08/2026) ;
 *   2. le service peut en révoquer UNE de plus en plein chantier, c'est
 *      exactement ce qui est arrivé ce soir-là ;
 *   3. une troisième absorbe un hasard (rotation malheureuse, coupure).
 *
 * Au-delà, ce n'est plus un accident : le service révoque SYSTÉMATIQUEMENT, et
 * continuer serait une rafale de logins — le comportement qui fait bloquer un
 * compte. On s'arrête en le disant ; le chantier reprendra où il en était.
 */
const RECONNEXIONS_PAR_CHANTIER = 3;

/** Le budget de reconnexions qu'un chantier partage entre tous ses gestes. */
function budgetReconnexions(plafond = RECONNEXIONS_PAR_CHANTIER) {
  return { plafond, utilisees: 0 };
}

/**
 * Décide et prépare la reconnexion après un refus d'opération (lot 58).
 *
 * Appelée par `rclone.withConfig` (rappel `reconnexion` posé par le pilote)
 * avec le texte complet de l'échec. Tout se décide sur des FAITS enregistrés :
 *
 *   - le refus n'est pas une mort de session, ou aucune session n'était
 *     enregistrée (`sessionMorteLe` absent malgré le marquage) → null,
 *     l'erreur d'origine suit son cours ;
 *   - de quoi rouvrir manque (pas de mot de passe ; ou compte à second
 *     facteur sans clé TOTP — le code à usage unique est périmé par
 *     définition) → l'opération s'arrête AVEC LA PHRASE QUI DIT ÇA, jamais
 *     « vérifiez votre mot de passe » ;
 *   - le plafond du chantier est atteint → arrêt en le disant (se reconnecter
 *     en rafale contre un service qui révoque, c'est se faire bloquer) ;
 *   - sinon : UNE tentative — la configuration fraîche est relue de la base,
 *     `normalizeConf` en écarte la session morte, le bloc joue mot de passe,
 *     second mot de passe et code CALCULÉ depuis la clé TOTP (rclone s'en
 *     charge, mesuré dans sa source v1.75.0). Une réussite persiste la
 *     session neuve par le mécanisme du lot 57 (`onSecretsRafraichis`).
 *
 * @returns {null|{dest: object, surReussite: () => void, surEchec: (err: Error) => Error}}
 */
function preparerReconnexion(destId, texteEchec, { budget = null, surEvenement = null } = {}) {
  if (!SIGNATURE_SESSION_MORTE.test(String(texteEchec || ''))) return null;
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at || destId === 'local') return null;
  if (configIllisible(destId)) return null;

  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  // Sans la marque, le refus ne venait pas d'une session enregistrée (mot de
  // passe faux, réseau…) : il n'y a rien à rejouer qui puisse mieux finir.
  if (!conf.sessionMorteLe) return null;

  const driver = driverFor(destId);
  if (!driver?.normalizeConf) return null;
  const normalise = driver.normalizeConf(conf);
  if ((driver.typeDe ? driver.typeDe(normalise) : normalise.type) !== 'protondrive') return null;

  const nom = ligne.display_name || destId;
  const bloc = String(conf.rcloneConfig || '');
  const enregistree = (cle) => Boolean(String(conf.valeurs?.[cle] || '').trim())
    || new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(bloc);
  const dire = (type, niveau, message) => {
    if (typeof surEvenement === 'function') surEvenement(type, message);
    else applog[niveau]('destinations', message);
  };
  const arretTraduit = (message) => {
    const err = new Error(message);
    err.dejaTraduite = true;
    return err;
  };

  if (!enregistree('username') || !enregistree('password')) {
    marquerReconnexion(destId, { echouee: true });
    const message = `${nom} — la session a été refusée par le service et aucun mot de passe `
      + 'n\'est enregistré pour rouvrir la connexion. Saisissez vos identifiants sur la '
      + 'carte de cette destination, puis « Tester la connexion ».';
    dire('impossible', 'error', message);
    throw arretTraduit(message);
  }

  // Compte à second facteur, aucune clé pour calculer un code : impossible par
  // construction — on le dit tout de suite, sans consommer un login.
  if ((conf.deuxFacteurs || enregistree('2fa')) && !enregistree('otp_secret_key')) {
    marquerReconnexion(destId, { echouee: true });
    const message = `${nom} — ${erreurs.MESSAGE_RECONNEXION_SANS_CLE}`;
    dire('impossible', 'error', message);
    throw arretTraduit(message);
  }

  if (budget && budget.utilisees >= budget.plafond) {
    const message = `${nom} — le service a déjà révoqué ${budget.plafond} sessions pendant ce `
      + 'chantier : crabe s\'arrête plutôt que de se reconnecter en boucle (un service qui '
      + 'révoque à répétition finirait par bloquer le compte). Attendez un moment, vérifiez '
      + 'les sessions ouvertes depuis votre compte chez le service, puis relancez.';
    dire('plafond', 'error', message);
    throw arretTraduit(message);
  }
  if (budget) budget.utilisees++;

  const avecCle = enregistree('otp_secret_key');
  dire(
    'tentee',
    'info',
    `${nom} — le service a refusé la session en cours d'opération : reconnexion immédiate `
      + `avec les identifiants enregistrés${avecCle ? ' (code calculé depuis la clé de '
      + 'l\'application d\'authentification)' : ''}, puis l'opération continue.`
  );

  return {
    // La configuration FRAÎCHE : relue de la base, où la session vient d'être
    // marquée morte — `normalizeConf` l'écarte du bloc joué.
    dest: driver.normalizeConf(readConfig(destId) || {}),
    surReussite: () => dire(
      'reussie',
      'info',
      `${nom} — reconnexion réussie : une nouvelle session est enregistrée, l'opération a repris.`
    ),
    surEchec: (err2) => {
      const texte2 = `${err2.message || ''}\n${err2.stderr || ''}`;
      // Le service exige un second facteur que la tentative n'avait pas : le
      // fait est retenu (les prochains gestes s'arrêteront AVANT de le
      // solliciter), et la phrase dit la seule sortie — la clé TOTP.
      if (/requires a 2FA code/i.test(texte2)) {
        marquerReconnexion(destId, { echouee: true, deuxFacteurs: true });
        const message = `${nom} — ${erreurs.MESSAGE_RECONNEXION_SANS_CLE}`;
        dire('echouee', 'error', message);
        return arretTraduit(message);
      }
      marquerReconnexion(destId, { echouee: true });
      const message = `${nom} — la reconnexion a échoué : ${err2.dejaTraduite ? err2.message : erreurs.traduire(texte2)}`;
      dire('echouee', 'error', message);
      return arretTraduit(message);
    },
  };
}

/**
 * Oublie tout ce qui est saisi ou conservé pour une destination — la session,
 * les mots de passe, le bloc collé — sans supprimer la destination elle-même
 * ni son historique de dépôts (lot 57 : « repartir de zéro »).
 *
 * Ce qui reste : la ligne, son nom, son fournisseur, son type, le nom de
 * remote et le dossier de base — tout ce qui n'est pas un identifiant. La
 * carte se rouvre avec son formulaire vide, prête pour une saisie propre.
 *
 * Fonctionne AUSSI sur une configuration illisible : oublier ce qu'on ne sait
 * plus relire est précisément le geste qui répare (contrairement à
 * `saveConfig`, qui refuse d'écrire par-dessus — ici, l'effacement est le but
 * demandé, confirmé à l'écran).
 */
function repartirDeZero(destId) {
  const ligne = row(destId);
  if (!ligne || ligne.deleted_at) return null;
  if (destId === 'local') {
    const err = new Error(
      'L\'espace de stockage de crabe n\'a pas d\'identifiants à oublier — c\'est un '
        + 'dossier, son chemin se modifie directement sur sa carte.'
    );
    err.statusCode = 400;
    throw err;
  }
  // Repartir de zéro rend la destination inutilisable le temps de la
  // reconfigurer : sur la dernière active, ce serait laisser crabe sans
  // stockage — même règle, même phrase que pour une suppression.
  if (activeDestinations().includes(destId)) garderUneDestination(destId);

  const conf = crypto.tryDecryptJson(ligne.config_encrypted, {}) || {};
  // ⚠ Pas de clé `valeurs` du tout : avec un objet vide, `normalizeConf`
  // fabriquerait un bloc réduit à `type = …` et la carte se croirait
  // configurée — l'inverse exact de ce que ce geste promet.
  const neuf = {
    remoteName: conf.remoteName || 'crabe',
    basePath: conf.basePath || 'crabe',
    rcloneConfig: '',
    type: conf.type || '',
  };
  db.get()
    .prepare(
      "UPDATE destinations_config SET config_encrypted = ?, updated_at = datetime('now') WHERE dest_id = ?"
    )
    .run(crypto.encrypt(neuf), destId);
  oublierPilotes();
  oublierMesureEspace(destId);
  return publicConfig(destId);
}

function logResult(destId, userId, ok, message) {
  db.get()
    .prepare(
      'INSERT INTO destination_logs (dest_id, user_id, success, message) VALUES (?, ?, ?, ?)'
    )
    .run(destId, userId ?? null, ok ? 1 : 0, message || null);
}

/** Teste une destination et journalise le résultat. */
async function test(destId, userId = null) {
  const driver = driverFor(destId);
  if (!driver) throw new Error(`Destination inconnue : ${destId}`);
  const conf = readConfig(destId);
  const result = await driver.test(conf);
  logResult(destId, userId, result.ok, result.message);
  // « Tester » est le geste explicite de qui veut savoir MAINTENANT : la
  // mesure d'espace suivante repart à neuf plutôt que de servir le cache.
  oublierMesureEspace(destId);
  return result;
}

/**
 * Destinations actives pour une écriture : le stockage local + les clouds activés.
 *
 * « Activée » est une décision d'ADMINISTRATION, et elle vaut pour tout le
 * monde : une destination éteinte ici n'apparaît nulle part, pour personne.
 *
 * Un cloud sans configuration n'est jamais actif, même activé : il n'a rien à
 * quoi se connecter, et le compter parmi les actives ferait échouer une copie
 * par destination et par document, sans que personne comprenne pourquoi.
 */
function activeDestinations() {
  // ⚠ Le stockage local n'est plus inscrit d'office (lot 26) : il se supprime comme un
  // cloud, et une liste qui le contiendrait toujours ferait croire à une copie
  // qui n'a pas lieu. C'est cette liste, et elle seule, qui décide où un
  // document part — et si elle est vide, plus rien ne doit être récupéré.
  const active = localActif() ? ['local'] : [];
  for (const id of cloudIds()) {
    const conf = readConfig(id);
    const driver = driverFor(id);
    if (!driver) continue;
    const normalise = driver.normalizeConf ? driver.normalizeConf(conf) : conf;
    if (conf?.enabled && normalise?.rcloneConfig) active.push(id);
  }
  return active;
}

/**
 * Plus aucun endroit où déposer un document — et ce que ça implique.
 *
 * ─── Pourquoi c'est un blocage et pas un avertissement (lot 26) ──────────────
 *
 * Depuis que l'espace de stockage de crabe se supprime comme un cloud, l'état
 * « aucune destination » est atteignable. Une récupération planifiée y
 * garderait tout son sens apparent — elle se connecterait, téléchargerait des
 * PDF, et les jetterait. Le journal dirait « 12 factures récupérées », et il n'y
 * aurait rien nulle part.
 *
 * Récupérer sans destination, ce n'est pas rendre un service dégradé : c'est
 * solliciter le site d'un fournisseur, rejouer une session, consommer une
 * fenêtre de connexion — pour rien. Le geste est donc refusé, avec la phrase
 * qui dit quoi faire, et l'accueil le signale avant même qu'une planification
 * ne tombe.
 *
 * @returns {{bloque: boolean, message: string|null}}
 */
function aucunStockageActif() {
  if (activeDestinations().length) return { bloque: false, message: null };
  return {
    bloque: true,
    message:
      'Aucun espace de stockage n\'est actif : crabe n\'a nulle part où déposer vos '
      + 'documents, et ne va donc pas les chercher. Ouvrez Paramètres → Stockage pour '
      + 'remettre en service l\'espace de crabe, ou ajouter un cloud.',
  };
}

/**
 * Les destinations qu'un COMPTE reçoit — son choix appliqué aux actives.
 *
 * ─── Deux décisions distinctes, et l'ordre compte ────────────────────────────
 *
 * L'administration décide ce qui EXISTE ; le compte décide, parmi ce qui
 * existe, ce qu'il VEUT. Les deux ne se remplacent pas :
 *
 *   - une destination éteinte par l'administration n'apparaît nulle part, même
 *     si un compte l'avait choisie — la décision d'administration prime ;
 *   - une destination active mais refusée par le compte reste visible à
 *     l'administration, et ne reçoit simplement rien pour CE compte.
 *
 * Le défaut est « toutes », parce que la préférence est une liste de REFUS :
 * un compte qui n'a jamais ouvert cet écran a une liste vide et reçoit tout,
 * comme avant ce lot. Voir `preferences.js`, clé `destinations.desactivees`.
 *
 * Le stockage local n'est jamais retiré PAR UN COMPTE : c'est la copie de référence, et
 * c'est depuis elle que la synchronisation relit les PDF pour les envoyer
 * ailleurs. Elle peut en revanche être supprimée par l'administration depuis le
 * lot 26, et elle ne figure alors plus dans les actives — auquel cas la
 * synchronisation vers les clouds n'a plus de source à relire, et le dit.
 *
 * @param {number|null} userId
 * @returns {string[]}
 */
function destinationsForUser(userId) {
  const actives = activeDestinations();
  if (!userId) return actives;

  let refusees = [];
  try {
    refusees = require('../preferences').get(userId, 'destinations.desactivees') || [];
  } catch {
    // Préférence illisible : on ne coupe RIEN. Se tromper du côté de « tout
    // copier » ne perd aucun document ; se tromper de l'autre côté, si.
    refusees = [];
  }
  const exclues = new Set(refusees);
  return actives.filter((id) => id === 'local' || !exclues.has(id));
}

/**
 * Écrit une facture sur toutes les destinations actives.
 *
 * L'arborescence est la même partout :
 * <utilisateur>/<Nom du connecteur>/<identifiant de compte>/<année>/<fichier>
 *
 * @param {{username: string, userId: number, connectorId: string,
 *          connectorName?: string, accountId?: string, issuedOn?: string,
 *          filename: string, buffer: Buffer}} invoice
 * @returns {Promise<Object>} { local: {ok, path}, proton: {...}, … }
 */
async function storeInvoice({
  username,
  userId,
  connectorId,
  connectorName,
  accountId,
  issuedOn,
  filename,
  buffer,
  destinationIds,
  sousChemin,
}) {
  const results = await copyToDestinations({
    // Le choix du compte, appliqué à ce que l'administration a activé. Un
    // appelant qui passe une liste explicite (la synchronisation forcée, le
    // bouton « Renvoyer ») garde la main : il sait déjà ce qu'il vise.
    destinationIds: destinationIds || destinationsForUser(userId),
    userId,
    username,
    target: {
      username,
      // Le dossier porte le NOM lisible du connecteur (« Free Internet »), pas
      // son identifiant technique.
      connectorName: connectorName || connectorId,
      accountId: accountId || accountIds.DEFAULT_ACCOUNT_ID,
      // L'année du DOCUMENT : la date d'émission relevée par le connecteur, à
      // défaut la période lue dans le nom du fichier (voir paths.yearFor).
      issuedOn: issuedOn || null,
      filename,
      buffer,
      // Le rangement fourni par le connecteur (dossiers du coffre eDocPerso),
      // à la place du niveau d'année. Assaini par `paths.relativeParts`.
      sousChemin: sousChemin || null,
    },
  });

  // ─── « Au moins une destination », plus « le stockage local obligatoire » (lot 38) ──
  //
  // Le stockage local, QUAND il est actif, reste la copie de référence : son échec fait
  // échouer la facture entière, parce que c'est depuis lui que « Synchroniser »
  // répare les clouds — une facture sans copie de référence ne serait jamais
  // rattrapable. Mais quand l'administration l'a retiré, exiger son écriture
  // ferait échouer TOUTE récupération : la facture est alors valide dès qu'une
  // destination l'a réellement reçue, et l'échec de toutes les dit toutes.
  const tentees = Object.keys(results);
  if (tentees.includes('local') && !results.local?.ok) {
    throw new Error(
      `Écriture sur le stockage local impossible — ${results.local?.message || 'raison inconnue'}`
    );
  }
  if (!tentees.some((id) => results[id]?.ok)) {
    const motif = tentees.map((id) => results[id]?.message).find(Boolean);
    throw new Error(
      `Aucun espace de stockage n'a accepté ce document — ${motif || 'raison inconnue'}`
    );
  }

  return results;
}

/**
 * Nombre de tentatives sur une destination SECONDAIRE avant abandon.
 *
 * Un cloud injoignable ne doit ni bloquer la récupération, ni provoquer un
 * acharnement : trois essais espacés, puis on s'arrête et on le dit. La reprise
 * est ensuite un geste explicite — « Synchroniser » sur la carte de la
 * destination —, jamais une boucle automatique.
 */
const TENTATIVES_SECONDAIRES = 3;

/** Attente entre deux tentatives. Réduite à zéro par les tests. */
function delaiEntreTentatives() {
  const demande = Number.parseInt(process.env.CRABE_COPIE_DELAI_MS || '', 10);
  return Number.isFinite(demande) && demande >= 0 ? demande : 3000;
}

const pause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Dépose un contenu déjà en mémoire sur une liste de destinations.
 *
 * Séparé de `storeInvoice()` pour que le bouton « Renvoyer » de l'accueil et la
 * synchronisation forcée puissent recopier vers les seules destinations
 * manquantes, **sans repasser par le fournisseur** : le PDF est relu depuis
 * Le stockage local, pas retéléchargé.
 *
 * Le stockage local est tenté UNE fois : c'est un chemin local, un échec y est une
 * erreur de configuration ou de montage, et réessayer trois fois ne ferait que
 * retarder le message qui dit quoi corriger. Les destinations secondaires, qui
 * passent par le réseau et rclone, ont droit à trois tentatives.
 *
 * @returns {Promise<Object>} un résultat par destination tentée
 */
async function copyToDestinations({ destinationIds, target, userId, username }) {
  const results = {};
  for (const destId of destinationIds) {
    const driver = driverFor(destId);
    if (!driver) continue;
    const essais = destId === 'local' ? 1 : TENTATIVES_SECONDAIRES;

    let outcome;
    let essaisFaits = 0;
    for (let essai = 1; essai <= essais; essai++) {
      // La configuration est relue à CHAQUE essai (lot 58) : le premier a pu
      // marquer une session morte, ou une reconnexion a pu en écrire une
      // neuve — rejouer l'objet du départ rejouerait l'état d'avant.
      const conf = readConfig(destId);
      try {
        outcome = await driver.store(conf, target);
      } catch (err) {
        outcome = { ok: false, message: err.message };
      }
      essaisFaits = essai;
      if (outcome.ok) break;
      // Un refus posé AVANT de solliciter le service (lot 61 — le MEGA à
      // validation en deux étapes, le Proton sans clé TOTP) ne changera pas
      // dans trois secondes : promettre un « nouvel essai » ferait mentir le
      // message même qui explique que réessayer ne sert à rien.
      if (outcome.definitif) break;

      if (essai < essais) {
        applog.warn(
          'destinations',
          `${driver.NAME} — tentative ${essai}/${essais} en échec pour `
            + `${target.filename} : ${outcome.message}. Nouvel essai dans quelques secondes.`,
          { userId, username }
        );
        await pause(delaiEntreTentatives());
      }
    }

    results[destId] = outcome;
    if (!outcome.ok) {
      logResult(destId, userId, false, `${target.filename} : ${outcome.message}`);
      applog.error(
        'destinations',
        `${driver.NAME} — échec du dépôt de ${target.filename} après ${essaisFaits} `
          + `tentative(s) : ${outcome.message}. Le document reste valide sur la destination `
          + (outcome.definitif
            ? 'principale ; réessayer ne changerait rien — aucun nouvel essai n\'aura lieu '
              + 'tant que la cause dite sur la carte de cette destination n\'est pas réglée.'
            : 'principale ; aucune reprise automatique — utilisez « Synchroniser » sur la carte '
              + 'de cette destination.'),
        { userId, username }
      );
    }
  }
  return results;
}

/**
 * Le chemin d'une copie de référence, relatif à la racine du stockage local (lot 38).
 *
 * C'est ce que les REPRISES (« Synchroniser », « Renvoyer ») passent aux
 * destinations secondaires : le miroir copie le rangement RÉEL de la copie de
 * référence — dossiers du coffre eDocPerso compris — au lieu de recalculer un
 * niveau d'année qui ne correspondrait pas. `null` quand le chemin ne se
 * laisse pas relativiser : l'appelant retombe alors sur le calcul habituel.
 */
function cheminRelatifDepuisLocal(source) {
  const root = readConfig('local')?.path;
  if (!root || !source || !paths.isInside(root, source)) return null;
  const nodePath = require('node:path');
  const rel = nodePath.relative(root, source);
  return rel ? rel.split(nodePath.sep).join('/') : null;
}

/** Nom lisible d'un connecteur, ou son identifiant s'il a quitté le disque. */
function connectorNameOf(connectorId) {
  try {
    return require('../connectors/registry').manifest(connectorId).name;
  } catch {
    return connectorId;
  }
}

/**
 * Chemin du fichier déposé sur le stockage local pour une facture donnée.
 *
 * Trois candidats, essayés dans cet ordre, et le premier qui existe gagne :
 *
 *   1. le chemin réellement ENREGISTRÉ au dépôt, après vérification qu'il
 *      pointe bien sous la racine du stockage local ;
 *   2. le chemin reconstruit dans l'arborescence courante, **avec** son niveau
 *      d'année (lot 10) ;
 *   3. le chemin reconstruit SANS année — l'arborescence d'avant le lot 10.
 *
 * Le troisième candidat est ce qui rend la migration sans danger : un document
 * pas encore déplacé, ou déplacé sans que la base ait suivi, reste téléchargeable
 * pendant tout l'intervalle. Si aucun n'existe, le chemin de l'arborescence
 * courante est renvoyé quand même — c'est lui qui doit apparaître dans le
 * message « le fichier n'est plus présent ».
 *
 * Dans tous les cas, aucune valeur venant d'une requête HTTP n'entre dans le
 * chemin : impossible de sortir du dossier de l'utilisateur.
 *
 * @param {{connector_id: string, account_id?: string, filename: string,
 *          issued_on?: string, destinations?: string}} invoice
 * @param {string} username propriétaire de la facture
 * @returns {string|null}
 */
function invoicePath(invoice, username) {
  const root = readConfig('local')?.path;
  if (!root || !invoice) return null;

  const fsLocal = require('node:fs');
  const candidats = [];

  try {
    const recorded = JSON.parse(invoice.destinations || '{}')?.local?.path;
    if (recorded && paths.isInside(root, recorded)) candidats.push(recorded);
  } catch {
    /* colonne illisible : on reconstruit */
  }

  const parts = {
    username,
    connectorName: connectorNameOf(invoice.connector_id),
    accountId: invoice.account_id,
    issuedOn: invoice.issued_on,
    filename: invoice.filename,
  };

  const courant = local.targetPath(root, parts);
  if (paths.isInside(root, courant)) candidats.push(courant);

  const ancien = local.legacyTargetPath(root, parts);
  if (paths.isInside(root, ancien)) candidats.push(ancien);

  for (const candidat of candidats) {
    try {
      if (fsLocal.existsSync(candidat)) return candidat;
    } catch {
      /* chemin illisible : on essaie le suivant */
    }
  }

  return candidats[0] || null;
}

/**
 * Rapatrie une facture depuis une destination, dans un fichier temporaire.
 *
 * Le stockage local est lu directement — c'est un chemin local, il n'y a rien à
 * rapatrier. Les destinations distantes passent par rclone, et l'appelant est
 * responsable d'effacer le répertoire rendu (`cleanup`).
 *
 * @returns {Promise<{ok: boolean, file?: string, cleanup?: () => void, message?: string}>}
 */
async function fetchInvoice(destId, invoice, username) {
  if (destId === 'local') {
    const file = invoicePath(invoice, username);
    if (!file || !require('node:fs').existsSync(file)) {
      return { ok: false, message: 'Le fichier n\'est plus présent sur cet espace de stockage.' };
    }
    return { ok: true, file, cleanup: () => {} };
  }

  const driver = driverFor(destId);
  if (!driver) return { ok: false, message: 'Espace de stockage inconnu.' };

  if (configIllisible(destId)) {
    return {
      ok: false,
      message:
        'Impossible de lire la configuration de cet espace de stockage — signalez-le à votre administrateur.',
    };
  }
  // Le MÊME critère que le contrôle de santé : la configuration NORMALISÉE.
  // Le bloc rclone est calculé depuis les champs saisis quand il n'est pas
  // collé tel quel ; lire le champ brut disait « pas configuré » d'espaces
  // dont le contrôle de santé venait de réussir (mesuré le 18/08/2026).
  const conf = readConfig(destId);
  const normalise = driver.normalizeConf ? driver.normalizeConf(conf) : conf;
  if (!normalise?.rcloneConfig) {
    return { ok: false, message: 'Cet espace de stockage n\'est pas configuré.' };
  }

  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');

  const connectorName = connectorNameOf(invoice.connector_id);

  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'crabe-lecture-'));
  const local = nodePath.join(dir, paths.safeSegment(invoice.filename, 'facture.pdf'));
  const cleanup = () => {
    try {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* déjà parti */
    }
  };

  // Le chemin ENREGISTRÉ au dépôt prime (lot 38) : c'est là que la copie vit
  // réellement — dossiers du coffre eDocPerso compris. La reconstruction par
  // année reste le repli des copies d'avant le suivi détaillé.
  let enregistre = null;
  try {
    const brut = JSON.parse(invoice.destinations || '{}')?.[destId]?.path;
    if (brut) {
      const base = String(normalise.basePath || '').replace(/\/+$/, '');
      const prefixe = `${normalise.remoteName}:${base ? `${base}/` : ''}`;
      if (String(brut).startsWith(prefixe)) enregistre = String(brut).slice(prefixe.length);
    }
  } catch {
    /* colonne illisible : la reconstruction suffit */
  }

  try {
    await rclone.download(
      normalise,
      enregistre || paths.relativePath({
        username,
        connectorName,
        accountId: invoice.account_id || accountIds.DEFAULT_ACCOUNT_ID,
        issuedOn: invoice.issued_on,
        filename: invoice.filename,
      }),
      local
    );
    return { ok: true, file: local, cleanup };
  } catch (err) {
    cleanup();
    return { ok: false, message: err.message };
  }
}

/** Purge des fichiers d'un utilisateur sur toutes les destinations. */
async function purgeUser(username, userId = null) {
  const results = {};
  for (const destId of activeDestinations()) {
    try {
      results[destId] = await driverFor(destId).purgeUser(readConfig(destId), username);
    } catch (err) {
      results[destId] = { ok: false, message: err.message };
    }
    logResult(
      destId,
      userId,
      !!results[destId].ok,
      `Purge RGPD de ${username} : ${results[destId].ok ? 'terminée' : results[destId].message}`
    );
  }
  return results;
}

/**
 * Usage agrégé par destination, calculé depuis la table `invoices`
 * (une facture compte pour chaque destination où sa copie a réussi).
 */
function usageByDestination() {
  const rows = db.get().prepare('SELECT user_id, size_bytes, destinations FROM invoices').all();
  const totals = { local: { bytes: 0, files: 0, users: new Set() } };
  for (const id of cloudIds()) totals[id] = { bytes: 0, files: 0, users: new Set() };

  for (const r of rows) {
    let dests;
    try {
      dests = JSON.parse(r.destinations || '{}');
    } catch {
      dests = {};
    }
    for (const [destId, outcome] of Object.entries(dests)) {
      if (!totals[destId] || !outcome?.ok) continue;
      totals[destId].bytes += r.size_bytes || 0;
      totals[destId].files += 1;
      totals[destId].users.add(r.user_id);
    }
  }

  return Object.entries(totals).map(([id, t]) => ({
    ...catalogue.brand(id),
    bytes: t.bytes,
    files: t.files,
    users: t.users.size,
    enabled: id === 'local' ? true : !!readConfig(id)?.enabled,
  }));
}

/**
 * Totaux réels, comptés une fois par facture — et non une fois par copie
 * comme `usageByDestination()`, dont la somme compte deux fois une facture
 * déposée sur deux destinations.
 */
function globalUsage() {
  const row = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS files,
              COALESCE(SUM(size_bytes), 0) AS bytes,
              COUNT(DISTINCT user_id) AS users
         FROM invoices`
    )
    .get();
  return { files: row.files, bytes: row.bytes, users: row.users };
}

/** Usage d'un seul utilisateur (page « Stockage » du profil). */
function usageForUser(userId) {
  const agg = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS files,
              COALESCE(SUM(size_bytes), 0) AS bytes,
              MAX(fetched_at) AS last_fetch
         FROM invoices WHERE user_id = ?`
    )
    .get(userId);

  const thisMonth = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS files FROM invoices
        WHERE user_id = ? AND strftime('%Y-%m', fetched_at) = strftime('%Y-%m', 'now')`
    )
    .get(userId);

  return {
    bytes: agg.bytes,
    files: agg.files,
    filesThisMonth: thisMonth.files,
    lastFetchAt: agg.last_fetch,
  };
}

/**
 * Usage d'un compte, destination par destination.
 *
 * Une facture compte pour CHAQUE destination où sa copie a réussi : la somme
 * de ces lignes dépasse donc l'espace réel du compte, qui reste celui de
 * `usageForUser()`. C'est voulu — la page du profil montre la répartition,
 * pas un second total.
 */
function usageForUserByDestination(userId) {
  const rows = db
    .get()
    .prepare('SELECT size_bytes, destinations FROM invoices WHERE user_id = ?')
    .all(userId);

  const totals = {};
  for (const id of ['local', ...cloudIds()]) totals[id] = { bytes: 0, files: 0 };

  for (const r of rows) {
    let dests;
    try {
      dests = JSON.parse(r.destinations || '{}');
    } catch {
      dests = {};
    }
    for (const [destId, outcome] of Object.entries(dests)) {
      if (!totals[destId] || !outcome?.ok) continue;
      totals[destId].bytes += r.size_bytes || 0;
      totals[destId].files += 1;
    }
  }
  return totals;
}

/**
 * Tout ce qu'affiche la page « Stockage » du profil, en un appel.
 *
 * Règle non négociable : **chaque nombre est vrai à l'échelle où il s'affiche**.
 * Jusqu'au lot 59, cette vue additionnait les capacités et les espaces libres
 * de toutes les destinations actives (« 62.9 Mo sur 4.89 To », « Disponible :
 * 3.35 To ») : un partage local et deux clouds ne forment pas un espace commun,
 * et les documents n'y sont pas répartis mais COPIÉS à l'identique sur chacun.
 * Additionner laissait croire à un réservoir unique qui n'existe pas, et le
 * « % occupé au total » mesurait surtout ce que d'autres données occupent sur
 * ces volumes — information sans valeur pour ce compte.
 *
 * La vue s'en tient donc aux questions que l'utilisateur se pose : ce que ses
 * documents pèsent (une valeur — la même copie part partout), combien il en a,
 * et, destination par destination, l'espace encore libre MESURÉ, daté
 * (`space.measuredAt`, cache du lot 54). Aucun total cumulé, aucun pourcentage
 * global. Une mesure impossible se dit sur sa carte (`space.reason`), jamais
 * remplacée par une estimation.
 */
async function storageOverviewForUser(userId) {
  const base = usageForUser(userId);
  const perDestination = usageForUserByDestination(userId);

  const cards = [];

  // Ce que le compte reçoit vraiment, pour que l'écran puisse le montrer plutôt
  // que de laisser croire que tout part partout (lot 24).
  const choisies = new Set(destinationsForUser(userId));

  for (const id of activeDestinations()) {
    const style = catalogue.brand(id);
    const measure = await spaceFor(id);
    cards.push({
      id,
      name: style.name,
      letter: style.letter,
      color: style.color,
      logo: style.logo,
      logoInterne: style.logoInterne,
      bytes: perDestination[id]?.bytes || 0,
      files: perDestination[id]?.files || 0,
      space: measure,
      // Le stockage local ne se refuse pas : l'écran affiche une case cochée et figée
      // plutôt que de faire croire à un choix qui n'existe pas.
      choisie: choisies.has(id),
      obligatoire: id === 'local',
    });
  }

  return { ...base, destinations: cards };
}

/**
 * Cache des mesures d'espace des clouds (lot 54).
 *
 * Depuis que la mesure fonctionne (lot 53-bis), chaque affichage de l'accueil
 * ou de la page Stockage lançait une VRAIE mesure par cloud (`rclone about`).
 * Mesuré la nuit du 24 au 25/08/2026 : l'un des espaces cloud a servi la
 * première mesure puis refusé d'un 401 la seconde, lancée quelques secondes
 * après — l'écran clignotait entre « mesuré » et « n'a pas répondu » au gré
 * des rechargements, et le service distant était sollicité sans nécessité.
 *
 * Deux durées, choisies exprès :
 *   - une mesure RÉUSSIE se garde 5 minutes : l'espace ne bouge qu'au rythme
 *     des dépôts, et cinq minutes absorbent les rechargements rapprochés sans
 *     retarder sensiblement la vue d'un dépôt ;
 *   - une mesure en ÉCHEC se garde 60 secondes seulement : assez pour ne pas
 *     marteler un service qui vient de refuser (c'est ce martèlement qui
 *     provoquait le 401), assez court pour qu'une panne DURABLE soit
 *     re-mesurée et re-dite à l'écran en moins d'une minute. Le cache ne
 *     transforme jamais une panne en bonne nouvelle périmée, ni l'inverse.
 *
 * Une mesure EN COURS est partagée : deux vues simultanées attendent la même
 * promesse au lieu de lancer deux sondes — la paire de sondes rapprochées est
 * précisément ce que le service a refusé.
 *
 * Le cache vit en mémoire : un redémarrage du service repart de zéro, et tout
 * geste explicite sur la destination (enregistrement de configuration ou de
 * jeton, suppression, bouton « Tester ») oublie l'entrée. Chaque mesure porte
 * `measuredAt` pour que l'écran dise de quand elle date au lieu de la
 * présenter comme instantanée.
 */
const ESPACE_MESURE_REUSSIE_MS = 5 * 60_000;
const ESPACE_MESURE_ECHEC_MS = 60_000;
const mesuresEspace = new Map(); // dest_id → { at, known, promise }

function oublierMesureEspace(destId = null) {
  if (destId === null) mesuresEspace.clear();
  else mesuresEspace.delete(destId);
}

function mesureEncoreValable(entree) {
  if (!entree) return false;
  if (entree.known === undefined) return true; // en cours : on la partage
  const ttl = entree.known ? ESPACE_MESURE_REUSSIE_MS : ESPACE_MESURE_ECHEC_MS;
  return Date.now() - entree.at < ttl;
}

/**
 * Espace restant sur une destination.
 * Le stockage local interroge le système de fichiers, les clouds `rclone about`.
 * Une mesure indisponible renvoie `{ known: false }` — jamais un zéro.
 */
async function spaceFor(destId) {
  const conf = readConfig(destId);
  if (!conf) return space.unknown('Destination inconnue.');
  if (destId === 'local') {
    // `statfs` est local et instantané : pas de cache, la mesure est toujours
    // fraîche — et elle le dit, comme les autres.
    return { ...(await space.localSpace(conf.path)), measuredAt: new Date().toISOString() };
  }

  const connue = mesuresEspace.get(destId);
  if (mesureEncoreValable(connue)) return connue.promise;

  const entree = { at: Date.now(), known: undefined, promise: null };
  entree.promise = (async () => {
    // Le MÊME critère que le contrôle de santé et le dépôt : la configuration
    // NORMALISÉE. Le bloc rclone est calculé depuis les champs saisis quand il
    // n'est pas collé tel quel ; lire le champ brut faisait dire « espace
    // restant inconnu — configuration absente » à l'accueil et à la page
    // Stockage d'espaces configurés par formulaire dont les dépôts
    // réussissaient (mesuré le 24/08/2026 en production, sur deux espaces cloud
    // configurés par formulaire — le même défaut avait été corrigé le
    // 18/08/2026 dans `documents.js`, pas ici).
    const driver = driverFor(destId);
    const normalise = driver?.normalizeConf ? driver.normalizeConf(conf) : conf;
    const mesure = await space.remoteSpace({
      remoteName: normalise.remoteName || driver?.DEFAULT_REMOTE,
      basePath: normalise.basePath || 'crabe',
      rcloneConfig: normalise.rcloneConfig,
      // ─── Les jetons rafraîchis pendant la mesure sont PERSISTÉS (lot 57) ──
      //
      // C'était le chemin qui tuait la session Proton : le refresh token
      // tourne à chaque rafraîchissement (l'ancien est consommé, un neuf est
      // émis), la mesure d'espace tourne à chaque affichage de l'accueil — et
      // cet objet nu, sans le rappel, jetait le jeton neuf avec le fichier
      // temporaire. La copie stockée mourait au rafraîchissement suivant,
      // quelle que soit la fraîcheur des identifiants (incident du
      // 25/08/2026 : session rétablie à 17:35, morte à 18:58).
      onSecretsRafraichis: normalise.onSecretsRafraichis,
      // Et une session refusée pendant la mesure est marquée, comme partout.
      onSessionRefusee: normalise.onSessionRefusee,
      // Une session refusée EN PLEINE mesure se rouvre et la mesure continue
      // (lot 58) — et une reconnexion impossible par construction s'arrête
      // AVANT de solliciter le service : c'est la mesure d'espace, jouée à
      // chaque affichage de l'accueil, qui martelait Proton d'échecs de login.
      reconnexion: normalise.reconnexion,
      refusAvantService: normalise.refusAvantService,
    });
    mesure.measuredAt = new Date().toISOString();
    // Le TTL court depuis la FIN de la mesure : une sonde de trente secondes
    // ne doit pas manger sa propre durée de validité.
    entree.at = Date.now();
    entree.known = mesure.known;
    return mesure;
  })().catch((err) => {
    // `remoteSpace` ne lance jamais — mais si un pilote le faisait, garder la
    // promesse rejetée servirait l'erreur en boucle jusqu'à l'expiration.
    mesuresEspace.delete(destId);
    throw err;
  });
  mesuresEspace.set(destId, entree);
  return entree.promise;
}

/** Dernier test enregistré pour une destination (carte de l'accueil). */
function lastTest(destId) {
  const row = db
    .get()
    .prepare('SELECT at, success, message FROM destination_logs WHERE dest_id = ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(destId);
  if (!row) return null;
  return { at: row.at, ok: !!row.success, message: row.message };
}

function recentLogs(destId, limit = 20) {
  return db
    .get()
    .prepare(
      `SELECT d.*, u.username
         FROM destination_logs d
         LEFT JOIN users u ON u.id = d.user_id
        WHERE d.dest_id = ?
        ORDER BY d.at DESC LIMIT ?`
    )
    .all(destId, limit);
}

module.exports = {
  DRIVERS,
  driverFor,
  oublierPilotes,
  cloudIds,
  ordre,
  champsDe,
  validerSaisie,
  backends,
  presets,
  destinationsForUser,
  readConfig,
  configIllisible,
  publicConfig,
  publicConfigComplet,
  listPublic,
  listPublicComplet,
  createCloud,
  deleteCloud,
  pourAutorisation,
  enregistrerJeton,
  creerDossierDeBase,
  restoreLocal,
  localActif,
  saveConfig,
  marquerSessionMorte,
  marquerMegaDeuxEtapes,
  marquerReconnexion,
  preparerReconnexion,
  budgetReconnexions,
  RECONNEXIONS_PAR_CHANTIER,
  repartirDeZero,
  test,
  activeDestinations,
  aucunStockageActif,
  storeInvoice,
  copyToDestinations,
  spaceFor,
  oublierMesureEspace,
  lastTest,
  invoicePath,
  cheminRelatifDepuisLocal,
  fetchInvoice,
  purgeUser,
  usageByDestination,
  globalUsage,
  usageForUser,
  usageForUserByDestination,
  storageOverviewForUser,
  recentLogs,
};
