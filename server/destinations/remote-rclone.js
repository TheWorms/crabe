'use strict';

/**
 * Le pilote commun de toutes les destinations qui passent par `rclone`.
 *
 * ─── Pourquoi il existe (lot 24) ─────────────────────────────────────────────
 *
 * `protondrive.js` et `pcloud.js` étaient le MÊME fichier, à trois constantes
 * près : l'identifiant, le nom affiché, et le nom de remote par défaut. Cent
 * lignes chacun, dont cent identiques. Ajouter Mega, kDrive et le mode
 * générique aurait porté ça à cinq copies — c'est-à-dire cinq endroits à
 * corriger le jour où l'on découvre que le dépôt doit réessayer, ou qu'un
 * message est faux.
 *
 * ─── Ce que le lot 24 ajoute, et qui n'existait nulle part ───────────────────
 *
 * **Un type de stockage qu'rclone ne connaît pas est dit comme tel.** Mesuré
 * sur le conteneur : le paquet Debian de rclone v1.60.1 ne fournit ni `mega`
 * ni `protondrive`. Sans ce contrôle, activer Proton Drive sur ce serveur rend
 * une erreur d'rclone que personne ne peut interpréter ; avec, l'écran dit
 * quel type manque et quel geste répare. Voir `backends.js`.
 *
 * ─── Deux façons de configurer, et pourquoi les deux restent ─────────────────
 *
 *   1. **Le bloc rclone brut** — Proton Drive et pCloud, depuis le lot 9.
 *      L'administrateur colle ce que `rclone config` a produit. C'est direct
 *      et ça marche, mais ça suppose de savoir se servir de `rclone config`.
 *   2. **Des champs nommés** — Mega, kDrive et le mode générique. crabe
 *      demande ce que ce type de stockage exige, un champ à la fois, avec une
 *      aide écrite pour quelqu'un qui n'a jamais entendu parler de rclone, et
 *      c'est crabe qui assemble le bloc.
 *
 * La seconde est la bonne, et la première n'est pas retirée : elle fonctionne,
 * elle est peut-être déjà configurée chez quelqu'un, et une destination qui
 * cesse de marcher parce qu'on a préféré une autre ergonomie serait exactement
 * ce que ce lot cherche à éviter ailleurs. Un bloc brut enregistré continue
 * donc de primer sur les champs, tant qu'il est là.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rclone = require('./rclone');
const paths = require('./paths');
const backends = require('./backends');
const erreurs = require('./erreurs-rclone');

/**
 * Assemble un bloc de configuration rclone à partir de champs nommés.
 *
 * Les valeurs vides sont omises : rclone traite une clé présente et vide
 * autrement qu'une clé absente, et écrire `user = ` là où l'utilisateur n'a
 * rien saisi ferait échouer des remotes qui marcheraient sans.
 *
 * @param {string} type le backend rclone (`webdav`, `mega`, `s3`…)
 * @param {object} valeurs
 * @returns {string}
 */
function blocDepuisChamps(type, valeurs) {
  const lignes = [`type = ${String(type).trim()}`];
  for (const [cle, valeur] of Object.entries(valeurs || {})) {
    const texte = String(valeur ?? '').trim();
    if (!texte) continue;
    lignes.push(`${cle} = ${texte}`);
  }
  return lignes.join('\n');
}

/**
 * Fabrique une destination rclone.
 *
 * @param {object} definition
 * @param {string} definition.id           identifiant de destination (colonne `dest_id`)
 * @param {string} definition.name         nom affiché
 * @param {string} definition.defaultRemote nom de remote rclone par défaut
 * @param {string|null} definition.backend  le type rclone exigé, ou `null` si
 *   le type est choisi par l'utilisateur (mode générique)
 * @param {Array<object>} [definition.champs] les champs du formulaire dédié
 * @param {(valeurs: object) => object} [definition.versChamps] adapte les
 *   valeurs saisies avant d'en faire un bloc rclone (kDrive construit son URL)
 * @param {(valeurs: object, basePath: string) => string} [definition.versBase]
 *   compose le dossier de base EFFECTIF à partir des valeurs saisies — le
 *   bucket d'un espace S3 est le premier segment de l'adresse, pas une option
 *   du bloc (lot 62, voir `presets.baseDansLeBucket`)
 */
function creerDestination({
  id,
  name,
  defaultRemote,
  backend = null,
  champs = [],
  versChamps = (v) => v,
  versBase = null,
}) {
  // Les champs qui ne vont JAMAIS dans le bloc rclone (lot 62) : le backend ne
  // les connaît pas — écrire `bucket = …` dans un bloc s3 serait ranger une
  // clé que personne ne lit, dans le meilleur des cas. Leur valeur sert
  // ailleurs (`versBase`).
  const clesHorsBloc = (champs || []).filter((c) => c?.horsBloc).map((c) => c.key);
  const sansHorsBloc = (jeu) => {
    if (!clesHorsBloc.length) return jeu;
    const propre = { ...jeu };
    for (const cle of clesHorsBloc) delete propre[cle];
    return propre;
  };
  /**
   * Remet une configuration enregistrée dans une forme complète.
   *
   * `rcloneConfig` est calculé ici quand il n'est pas stocké tel quel : c'est
   * le seul endroit qui sait comment un jeu de champs devient un bloc, et le
   * reste du code (test, dépôt, purge) n'a jamais à connaître la différence.
   */
  function normalizeConf(conf) {
    const type = String(conf?.type || backend || '').trim();
    const valeurs = conf?.valeurs && typeof conf.valeurs === 'object' ? conf.valeurs : null;

    // ─── Une session marquée morte n'est plus jamais rejouée (lot 57) ────────
    //
    // Le service l'a refusée (`sessionMorteLe`, posé par `marquerSessionMorte`
    // quand rclone rend « invalid access/refresh token ») : la rejouer ne peut
    // que reproduire le même refus, en consommant des tentatives. Elle est
    // écartée du bloc joué — comme le code à usage unique enregistré, qui a
    // péri par construction et dont le rejeu est le « 422 sur /auth/v4/2fa »
    // mesuré le 25/08/2026. Ce qui reste : mot de passe, second mot de passe,
    // clé TOTP éventuelle — de quoi rouvrir une connexion propre, ou échouer
    // avec la phrase qui dit le vrai manque.
    const sessionMorte = !!conf?.sessionMorteLe;
    const sansSession = (jeu) => {
      if (!sessionMorte || type !== 'protondrive') return jeu;
      const propre = { ...jeu };
      for (const cle of [...rclone.CLES_SESSION_PROTON, '2fa']) delete propre[cle];
      return propre;
    };
    const blocSansSession = (texte) => {
      if (!sessionMorte || type !== 'protondrive') return texte;
      return [...rclone.CLES_SESSION_PROTON, '2fa'].reduce(
        (b, cle) => b.replace(new RegExp(`^${cle}\\s*=.*\\n?`, 'm'), ''),
        texte
      );
    };

    const bloc = conf?.rcloneConfig
      ? blocSansSession(String(conf.rcloneConfig))
      : (type && valeurs ? blocDepuisChamps(type, sansSession(sansHorsBloc(versChamps(valeurs)))) : '');

    // ─── Le dossier de base effectif (lot 62) ─────────────────────────────────
    //
    // Pour un espace S3, le bucket saisi passe DEVANT le dossier de base :
    // c'est ici, et nulle part ailleurs, que l'adresse se compose — dépôt,
    // téléchargement, test, mesure d'espace et harmonisation lisent tous cette
    // valeur normalisée. Sans `versBase` (tous les autres types), rien ne
    // change.
    const basePathEffectif = typeof versBase === 'function'
      ? versBase(valeurs || {}, conf?.basePath || 'crabe')
      : (conf?.basePath || 'crabe');

    // ─── Ce que la configuration sait du second facteur (lot 58) ─────────────
    //
    // Trois indices, tous MESURÉS sur ce qui est enregistré : la marque
    // `deuxFacteurs` (posée quand un code ou une clé a été saisi, ou quand le
    // service a répondu « requires a 2FA code »), un code ou une clé encore
    // rangés dans les valeurs, ou leurs lignes dans un bloc collé. Et la clé
    // TOTP disponible, elle, se lit aux mêmes endroits.
    const blocBrut = String(conf?.rcloneConfig || '');
    const dansValeurs = (cle) => Boolean(String(valeurs?.[cle] || '').trim());
    const dansBloc = (cle) => new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(blocBrut);
    const cleTotpDisponible = dansValeurs('otp_secret_key') || dansBloc('otp_secret_key');
    const deuxFacteursConnu = !!conf?.deuxFacteurs
      || cleTotpDisponible || dansValeurs('2fa') || dansBloc('2fa');

    return {
      remoteName: conf?.remoteName || defaultRemote,
      basePath: basePathEffectif,
      rcloneConfig: bloc,
      type,
      valeurs: valeurs || {},
      // ─── Ce qu'rclone réécrit revient dans la configuration chiffrée ────────
      //
      // `rclone.withConfig` relit son fichier jetable après chaque opération :
      // quand rclone y a réécrit un jeton OAuth renouvelé, ou déposé la
      // session durable Proton (`client_*`, écrite par son authHandler à
      // chaque connexion réussie — vérifié dans la source v1.75.0), ce rappel
      // range les valeurs là d'où la configuration est venue — champ nommé ou
      // bloc collé, selon la forme enregistrée. C'est CE relevé qui fait
      // qu'après UNE connexion Proton réussie (mot de passe + un seul code
      // 2FA), les suivantes n'exigent plus ni l'un ni l'autre. Le `require`
      // est différé : `index.js` charge ce module au démarrage, le sens
      // inverse ne doit exister qu'à l'exécution.
      onSecretsRafraichis: (changements) => {
        const index = require('./index');
        // Une session neuve vient d'être écrite par rclone : la connexion a
        // RÉUSSI. La marque « session morte » n'a plus d'objet, et le code à
        // usage unique qui a servi à l'établir a péri par construction — le
        // conserver, c'est garantir un « 422 code refusé » le jour où la
        // session mourra (mesuré le 25/08/2026). Les deux partent ici, dans le
        // même geste que l'enregistrement de la session.
        const sessionNeuve = Object.keys(changements)
          .some((cle) => rclone.CLES_SESSION_PROTON.includes(cle));
        // Une session écrite (ou tournée) par rclone est la preuve datée d'une
        // connexion qui vient de RÉUSSIR : la carte affiche cette date plutôt
        // qu'un badge sans âge (lot 58) — des faits, pas des espoirs.
        const succes = sessionNeuve
          ? { sessionMorteLe: null, sessionEtablieLe: new Date().toISOString() }
          : {};
        if (conf?.rcloneConfig) {
          let blocNeuf = String(conf.rcloneConfig);
          for (const [cle, valeur] of Object.entries(changements)) {
            blocNeuf = new RegExp(`^${cle}\\s*=`, 'm').test(blocNeuf)
              ? blocNeuf.replace(new RegExp(`^${cle}\\s*=.*$`, 'm'), `${cle} = ${valeur}`)
              : `${blocNeuf.trim()}\n${cle} = ${valeur}`;
          }
          if (sessionNeuve) blocNeuf = blocNeuf.replace(/^2fa\s*=.*\n?/m, '');
          index.saveConfig(id, { rcloneConfig: blocNeuf, ...succes });
          return;
        }
        index.saveConfig(
          id,
          {
            valeurs: { ...changements },
            ...(sessionNeuve ? { effacer: ['2fa'] } : {}),
            ...succes,
          },
          Object.keys(changements).map((cle) => ({ key: cle, type: 'password' }))
        );
      },
      // ─── Le refus d'une session se marque là où il se voit (lot 57) ─────────
      //
      // Appelé par `rclone.withConfig` quand une opération échoue, avec le
      // texte complet. `marquerSessionMorte` ne retient que les signatures de
      // session refusée (« invalid access token », « invalid refresh token »),
      // et seulement si une session est réellement enregistrée : un mot de
      // passe faux ne marque rien.
      onSessionRefusee: (texte) => {
        const index = require('./index');
        index.marquerSessionMorte(id, texte);
        // ─── Le MEGA à validation en deux étapes se retient (lot 61) ─────────
        //
        // Même principe que la session morte : le service vient de dire un
        // fait (« couldn't login: The upload target URL … has expired » — la
        // signature du 2FA cassé de la bibliothèque MEGA, mesurée le
        // 26/08/2026), et rejouer ce bloc ne peut que le reproduire. La marque
        // arme le refus avant service ci-dessous : les gestes suivants
        // s'arrêtent SANS marteler le service — le 26/08, trois documents ont
        // produit dix-huit tentatives de connexion en trois minutes.
        if (type === 'mega') index.marquerMegaDeuxEtapes(id, texte);
      },
      // ─── La reconnexion en plein geste (lot 58) ──────────────────────────────
      //
      // Appelé par `rclone.withConfig` quand l'opération vient d'échouer.
      // `preparerReconnexion` décide sur des FAITS enregistrés : le refus
      // est-il une mort de session, de quoi rouvrir dispose-t-on (mot de
      // passe, clé TOTP), le compte demande-t-il un second facteur. Il rend la
      // configuration fraîche à rejouer, ou null, ou lève le message français
      // qui dit le vrai manque. Le `require` est différé, comme au-dessus.
      reconnexion: (texteEchec) => require('./index').preparerReconnexion(id, texteEchec),
      // ─── La reconnexion impossible ne sollicite pas le service (lot 58) ─────
      //
      // Session morte + compte à validation en deux étapes + aucune clé pour
      // calculer un code : jouer ce bloc, c'est un échec de login garanti — et
      // la rafale d'échecs de login est vraisemblablement ce qui a valu les
      // révocations du 25/08/2026. `withConfig` lève cette phrase AVANT de
      // toucher au service. Une saisie neuve (mot de passe + code frais, ou la
      // clé) lève `sessionMorteLe` et rouvre le chemin.
      refusAvantService:
        sessionMorte && type === 'protondrive' && deuxFacteursConnu && !cleTotpDisponible
          ? require('./erreurs-rclone').MESSAGE_RECONNEXION_SANS_CLE
          // MEGA marqué « validation en deux étapes » (lot 61) : la panne est
          // structurelle — la bibliothèque MEGA de l'outil de copie ne tient
          // qu'une opération par connexion, aucun réglage n'y remédie. Chaque
          // login tenté serait un échec garanti ; on n'en joue plus aucun.
          // Une saisie neuve du mot de passe lève la marque (`saveConfig`).
          : type === 'mega' && conf?.megaDeuxEtapesLe
            ? require('./erreurs-rclone').MESSAGE_MEGA_DEUX_ETAPES
            : undefined,
    };
  }

  /**
   * Le type rclone réellement demandé par une configuration.
   *
   * Lu dans le bloc quand il vient d'un copier-coller : c'est la seule façon
   * de savoir si le type d'un bloc collé à la main est disponible.
   */
  function typeDe(normalized) {
    if (normalized.type) return normalized.type;
    const trouve = /^\s*type\s*=\s*(\S+)/m.exec(normalized.rcloneConfig || '');
    return trouve ? trouve[1] : (backend || '');
  }

  async function test(conf) {
    const normalized = normalizeConf(conf);
    if (!normalized.rcloneConfig) {
      return { ok: false, message: `Configuration ${name} absente.` };
    }
    if (!(await rclone.isAvailable())) {
      return {
        ok: false,
        message: 'Binaire rclone introuvable sur le serveur — installez-le (apt install rclone).',
      };
    }

    // Le contrôle qui manquait : demander à rclone s'il connaît ce type AVANT
    // de lui demander de s'en servir. Une réponse ici est claire ; la même
    // information tirée d'un échec de `lsd` ne l'est pas.
    const type = typeDe(normalized);
    if (type) {
      const dispo = await backends.estDisponible(type);
      if (dispo.mesurable && !dispo.connu) {
        return { ok: false, message: backends.messageTypeAbsent(name, type) };
      }
    }

    try {
      return await rclone.testRemote(normalized);
    } catch (err) {
      // La phrase française d'abord (lot 33) : « empty token - please run
      // rclone config reconnect » s'est affiché tel quel en production, devant
      // quelqu'un qui n'a aucun terminal où « run » quoi que ce soit. Une
      // erreur du chemin de reconnexion (lot 58) arrive DÉJÀ en français —
      // la retraduire l'envelopperait dans « détail technique : … ».
      return {
        ok: false,
        message: err.dejaTraduite ? `${name} : ${err.message}` : `${name} : ${erreurs.traduire(err.message)}`,
      };
    }
  }

  /**
   * Dépose une facture.
   *
   * Le buffer transite par un fichier temporaire : rclone travaille sur des
   * fichiers, pas sur des flux mémoire.
   */
  async function store(conf, { username, connectorName, accountId, year, issuedOn, filename, buffer, sousChemin, cheminRelatif }) {
    const normalized = normalizeConf(conf);
    if (!normalized.rcloneConfig) return { ok: false, message: `${name} non configuré.` };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crabe-${id}-`));
    const localFile = path.join(dir, paths.safeSegment(filename, 'facture.pdf'));
    try {
      fs.writeFileSync(localFile, buffer);
      // Une destination secondaire est un MIROIR, pas un rangement différent :
      // <user>/<Nom du connecteur>/<compte>/<année>/ — ou le sous-chemin du
      // connecteur (lot 38) — exactement comme le stockage local. Une REPRISE passe le
      // chemin réel de la copie de référence (`cheminRelatif`), qui prime :
      // recalculer ici rangerait un document du coffre sous une année.
      const remoteRel = cheminRelatif || paths.relativePath({
        username,
        connectorName,
        accountId,
        year,
        issuedOn,
        filename,
        sousChemin,
      });
      const target = await rclone.upload(normalized, localFile, remoteRel);
      return { ok: true, path: target };
    } catch (err) {
      // Même règle qu'au test : ce message finit sur les pastilles de « Mes
      // documents » — il doit dire quoi faire, en français (lot 33).
      // `definitif` (lot 61) : un refus posé avant de solliciter le service ne
      // changera pas dans trois secondes — la boucle de dépôt s'arrête dessus.
      // Le TOUT PREMIER refus mesuré du MEGA à deux étapes est définitif lui
      // aussi : sans cela, la boucle promettait « nouvel essai dans quelques
      // secondes » une ligne avant que le refus avant service ne l'arrête.
      const structurel = err.refusAvantService === true
        || erreurs.SIGNATURE_MEGA_DEUX_ETAPES.test(`${err.message || ''}\n${err.stderr || ''}`);
      return {
        ok: false,
        ...(structurel ? { definitif: true } : {}),
        message: err.dejaTraduite ? `${name} : ${err.message}` : `${name} : ${erreurs.traduire(err.message)}`,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Purge RGPD : supprime le dossier de l'utilisateur sur le remote. */
  async function purgeUser(conf, username) {
    const normalized = normalizeConf(conf);
    if (!normalized.rcloneConfig) return { ok: false, removed: 0 };
    try {
      await rclone.withConfig(normalized, (confFile) =>
        // Par `rclone.adresse()` comme le dépôt : une purge RGPD qui viserait
        // un chemin différent de celui où les fichiers ont été écrits ne
        // supprimerait rien, et répondrait « ok ».
        rclone.run(
          ['purge', rclone.adresse(normalized, paths.safeSegment(username))],
          { confFile }
        )
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  return {
    ID: id,
    NAME: name,
    DEFAULT_REMOTE: defaultRemote,
    /** Le type rclone exigé, ou `null` si l'utilisateur le choisit. */
    BACKEND: backend,
    /** Les champs du formulaire dédié, vide pour une configuration par bloc. */
    CHAMPS: champs,
    normalizeConf,
    typeDe,
    test,
    store,
    purgeUser,
  };
}

module.exports = { creerDestination, blocDepuisChamps };
