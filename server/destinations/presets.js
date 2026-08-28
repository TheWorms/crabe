'use strict';

/**
 * Les fournisseurs de cloud « habillés » : libellé, couleur, champs soignés.
 *
 * ─── Ce que ce fichier est, et ce qu'il n'est pas ────────────────────────────
 *
 * Depuis le lot 25, une destination cloud n'est plus une entrée déclarée dans
 * le code : c'est une LIGNE que l'utilisateur crée, avec le type de stockage
 * de son choix parmi ceux que le rclone installé sait gérer. Le mécanisme est
 * générique (voir `backends.js` et `remote-rclone.js`) — mais une liste de
 * quarante noms techniques (`webdav`, `pcloud`, `sftp`…) est illisible pour
 * qui découvre le service.
 *
 * Ce fichier porte donc la PRÉSENTATION : pour les fournisseurs courants, un
 * nom propre, une couleur, un formulaire écrit en français avec ses pièges
 * documentés. Il ne porte AUCUN mécanisme : supprimer un preset ne casse
 * aucune destination existante, qui reste une ligne en base avec son type.
 *
 * ─── Deux sortes de presets ──────────────────────────────────────────────────
 *
 *   - `champs` écrits ici (MEGA, kDrive) : le lot 24 a mesuré ce que ces
 *     services demandent vraiment, et l'aide raconte les pièges (mot de passe
 *     d'application Infomaniak, double validation MEGA) ;
 *   - `champs: null` (Proton Drive, pCloud) : les champs viennent de rclone
 *     lui-même (`backends.champsDuType`), comme pour un type choisi dans la
 *     liste complète. On ne devine rien — on ne PEUT rien deviner : le backend
 *     `protondrive` est absent du rclone du serveur de production, il n'y a
 *     rien à mesurer ici.
 *
 * L'identifiant d'un preset sert aussi de clé de style pour les dest_id
 * HÉRITÉS du modèle d'avant le lot 25 (`proton`, `pcloud`, `mega`, `kdrive`,
 * `rclone`) : une facture copiée à l'époque garde sa pastille et son nom.
 *
 * ─── `couvreLeType`, ou pourquoi pCloud n'apparaît qu'une fois (lot 28) ───────
 *
 * L'écran d'ajout montrait DEUX listes : les fournisseurs habillés ci-dessous,
 * puis un bouton « Autre stockage » qui ouvrait la liste complète des types
 * d'rclone — où pCloud figurait de nouveau, sous son nom technique. Le même
 * service, deux fois, à deux endroits, avec deux présentations : de quoi faire
 * douter qu'il s'agisse de la même chose.
 *
 * Le lien entre les deux listes existait déjà, il n'était simplement pas
 * exploité : c'est le champ `backend`, qui porte exactement le nom du type
 * rclone. `couvreLeType` dit ce qu'il faut en conclure :
 *
 *   - **vrai** (pCloud, Proton Drive, MEGA) : le preset EST ce type. Le type
 *     n'a donc rien à faire dans la suite de la liste — la carte habillée le
 *     remplace, et proposer les deux serait proposer deux fois la même chose ;
 *   - **faux** (kDrive) : le type est un PROTOCOLE que bien d'autres services
 *     parlent. `webdav` reste proposé pour lui-même — l'écarter empêcherait
 *     d'ajouter un serveur WebDAV quelconque au motif qu'Infomaniak en utilise
 *     un.
 */

/** L'adresse WebDAV d'un kDrive, à partir de son numéro. */
function adresseWebdavKdrive(numero) {
  const propre = String(numero || '').trim().replace(/[^A-Za-z0-9-]/g, '');
  return propre ? `https://${propre}.connect.kdrive.infomaniak.com/${propre}` : '';
}

/**
 * Le dossier de base d'une destination S3 : le bucket d'abord (lot 62).
 *
 * Un espace S3 ne se parcourt pas comme un disque : tout vit dans un
 * « bucket », et son nom est le PREMIER segment de l'adresse
 * (`remote:bucket/chemin`). Le backend s3 d'rclone n'a aucune option `bucket`
 * — c'est mesuré sur le binaire v1.75.0 du serveur : le nom ne peut voyager
 * que par le chemin. crabe le demande donc comme un champ (`horsBloc` : il ne
 * doit PAS finir dans le bloc rclone) et le glisse ici devant le dossier de
 * base, au moment où `normalizeConf` compose l'adresse.
 *
 * Sans bucket saisi, le dossier de base sort tel quel : c'est le comportement
 * d'avant ce lot, celui des blocs collés à la main où le bucket vit déjà dans
 * « Dossier de base » — et `avertissements()` dit ce qui manque.
 */
function baseDansLeBucket(valeurs, base) {
  const bucket = String(valeurs?.bucket || '').trim().replace(/^\/+|\/+$/g, '');
  return bucket ? `${bucket}/${base}` : base;
}

/**
 * Les mots français des champs S3, écrits UNE fois (lot 62).
 *
 * Ils servent deux formulaires qui doivent se lire pareil : les champs écrits
 * du socle « Stockage compatible S3 » et de « MEGA (stockage objet) », et
 * l'habillage `PRESENTATION_S3` des destinations de type `s3` créées avant ce
 * lot par la liste complète des types.
 */
const LIBELLES_S3 = {
  endpoint: {
    label: 'Adresse du service (endpoint)',
    help: 'L\'adresse à laquelle votre fournisseur répond — il l\'affiche à côté de vos '
      + 'clés d\'accès, souvent sous le nom « endpoint » ou « adresse S3 ». Recopiez-la '
      + 'telle quelle, par exemple s3.exemple.com.',
  },
  region: {
    label: 'Région',
    help: 'La région annoncée par votre fournisseur à côté de l\'adresse du service. '
      + 'Beaucoup de fournisseurs compatibles n\'en ont pas : laissez alors la case '
      + 'vide, c\'est prévu.',
  },
  access_key_id: {
    label: 'Clé d\'accès (Access Key ID)',
    help: 'La première des deux clés que votre fournisseur crée pour ce genre d\'accès. '
      + 'Elle identifie qui se connecte — c\'est l\'autre clé, la secrète, qui prouve '
      + 'que c\'est bien vous.',
  },
  secret_access_key: {
    label: 'Clé secrète (Secret Access Key)',
    help: 'La seconde clé, montrée par votre fournisseur au moment où il crée la paire — '
      + 'souvent une seule fois : notez-la avant de fermer la fenêtre. Elle est chiffrée '
      + 'ici et n\'est jamais réaffichée.',
  },
  bucket: {
    label: 'Nom du bucket',
    help: 'Le « bucket » est le grand tiroir dans lequel tout se range chez un '
      + 'fournisseur S3. Créez-le chez lui (ou reprenez-en un qui existe) et recopiez '
      + 'son nom ici : crabe y rangera ses documents, dans un dossier à lui.',
  },
};

/**
 * Le socle S3 : les cinq questions qui suffisent à n'importe quel fournisseur
 * compatible (lot 62).
 *
 * Un espace S3 se configure toujours pareil — une adresse de service, parfois
 * une région, une paire de clés, un bucket. Tout le reste est rare et arrive
 * par le complément d'rclone, dans « Réglages avancés » (`complement()` joue :
 * ce preset n'a pas de `versChamps`, le bucket est écarté du bloc par
 * `horsBloc`).
 *
 * ⚠ `secret_access_key` est un secret aux yeux de crabe (jamais réaffiché,
 * vide = « garde celui d'avant ») mais `obscurcir: false` : mesuré sur le
 * binaire v1.75.0 du serveur, le backend s3 le déclare `IsPassword: false` —
 * rclone l'attend EN CLAIR dans sa configuration, et la forme `rclone obscure`
 * le rendrait inutilisable. Même règle que le jeton pCloud.
 */
const CHAMPS_S3 = [
  { key: 'endpoint', type: 'text', required: true, ...LIBELLES_S3.endpoint },
  { key: 'region', type: 'text', required: false, ...LIBELLES_S3.region },
  { key: 'access_key_id', type: 'text', required: true, ...LIBELLES_S3.access_key_id },
  {
    key: 'secret_access_key',
    type: 'password',
    obscurcir: false,
    required: true,
    ...LIBELLES_S3.secret_access_key,
  },
  { key: 'bucket', type: 'text', required: true, horsBloc: true, ...LIBELLES_S3.bucket },
];

/**
 * MEGA S4 : le stockage objet de MEGA, sur le socle S3 (lot 62).
 *
 * ─── Pourquoi cette carte existe ─────────────────────────────────────────────
 *
 * Le compte MEGA ordinaire ne tient pas la validation en deux étapes (panne
 * structurelle mesurée le 26/08/2026, voir `erreurs-rclone.js`). MEGA propose
 * à côté un stockage objet compatible S3 — payant — dont les clés d'accès ne
 * périment pas et fonctionnent que la validation en deux étapes soit active ou
 * non : c'est LA voie de sortie, et elle mérite sa carte plutôt qu'un détour
 * par la configuration générique.
 *
 * ─── D'où viennent les adresses ──────────────────────────────────────────────
 *
 * AUCUNE n'est inventée : c'est la liste que le backend s3 du binaire
 * v1.75.0 du serveur documente lui-même pour son provider « Mega | MEGA S4
 * Object Storage » (`rclone config providers`, relevé du 26/08/2026). Les
 * quatre dernières, marquées « ancienne génération » par rclone (« legacy »),
 * restent proposées : un espace créé sous ces adresses-là continue d'y
 * répondre.
 *
 * Pour ce provider, toujours d'après le binaire : `region`, `acl` et
 * `location_constraint` NE s'appliquent PAS — le formulaire ne les demande
 * donc pas, et `versChamps` fixe `provider = Mega` que personne n'a à choisir.
 */
const CHAMPS_MEGA_S4 = [
  {
    key: 'endpoint',
    label: 'Où avez-vous créé votre espace S4 ?',
    type: 'text',
    required: true,
    listeStricte: true,
    options: [
      { value: 's3.eu-amsterdam.megas4.com', label: 'Amsterdam (s3.eu-amsterdam.megas4.com)' },
      { value: 's3.eu-luxembourg.megas4.com', label: 'Luxembourg (s3.eu-luxembourg.megas4.com)' },
      { value: 's3.eu-paris.megas4.com', label: 'Paris (s3.eu-paris.megas4.com)' },
      { value: 's3.eu-barcelona.megas4.com', label: 'Barcelone (s3.eu-barcelona.megas4.com)' },
      { value: 's3.ca-montreal.megas4.com', label: 'Montréal (s3.ca-montreal.megas4.com)' },
      { value: 's3.ca-vancouver.megas4.com', label: 'Vancouver (s3.ca-vancouver.megas4.com)' },
      { value: 's3.ap-tokyo.megas4.com', label: 'Tokyo (s3.ap-tokyo.megas4.com)' },
      { value: 's3.eu-central-1.s4.mega.io', label: 'Amsterdam — ancienne génération (s3.eu-central-1.s4.mega.io)' },
      { value: 's3.eu-central-2.s4.mega.io', label: 'Bettembourg — ancienne génération (s3.eu-central-2.s4.mega.io)' },
      { value: 's3.ca-central-1.s4.mega.io', label: 'Montréal — ancienne génération (s3.ca-central-1.s4.mega.io)' },
      { value: 's3.ca-west-1.s4.mega.io', label: 'Vancouver — ancienne génération (s3.ca-west-1.s4.mega.io)' },
    ],
    help: 'La région choisie en créant votre espace de stockage objet chez MEGA — elle '
      + 'décide de l\'adresse à laquelle vos clés répondent. Les entrées « ancienne '
      + 'génération » servent aux espaces créés sous les adresses s4.mega.io.',
  },
  {
    key: 'access_key_id',
    type: 'text',
    required: true,
    ...LIBELLES_S3.access_key_id,
    help: 'La première des deux clés que MEGA crée dans la partie stockage objet '
      + '(« S4 ») de votre compte. Ces clés ne périment pas, et la validation en deux '
      + 'étapes de votre compte ne les gêne pas.',
  },
  {
    key: 'secret_access_key',
    type: 'password',
    obscurcir: false,
    required: true,
    ...LIBELLES_S3.secret_access_key,
    help: 'La seconde clé, montrée par MEGA au moment où il crée la paire — souvent une '
      + 'seule fois : notez-la avant de fermer la fenêtre. Elle est chiffrée ici et '
      + 'n\'est jamais réaffichée.',
  },
  { key: 'bucket', type: 'text', required: true, horsBloc: true, ...LIBELLES_S3.bucket },
];

/**
 * MEGA : adresse + mot de passe, PAS d'OAuth — mesuré au lot 24 sur ce que
 * `rclone config` demande vraiment. Le backend `mega` est absent du rclone
 * Debian du serveur de production : le preset reste proposé, grisé, avec le
 * message qui dit quoi installer (voir `backends.messageTypeAbsent`).
 */
const CHAMPS_MEGA = [
  {
    key: 'user',
    label: 'Adresse e-mail du compte MEGA',
    type: 'text',
    required: true,
    help: 'La même adresse que celle avec laquelle vous vous connectez sur mega.nz.',
  },
  {
    key: 'pass',
    label: 'Mot de passe MEGA',
    type: 'password',
    required: true,
    obscurcir: true,
    help: 'Le mot de passe de votre compte MEGA. Il est chiffré ici et n\'est jamais '
      + 'réaffiché.\n'
      // Mesuré le 26/08/2026 : la connexion PARAÎT réussir (le test passe),
      // puis chaque copie échoue — dire « MEGA refusera cette connexion »
      // était faux, et laissait croire qu'un test réussi valait quitus.
      + '⚠ Si votre compte est protégé par une validation en deux étapes, la connexion '
      + 'semblera d\'abord réussir mais chaque copie échouera — l\'outil de copie ne sait '
      + 'pas tenir cette combinaison. Ce qui fonctionne : la carte « MEGA (stockage objet, '
      + 'payant) » de la liste d\'ajout, ou désactiver la validation en deux étapes.',
  },
];

/**
 * kDrive : il n'existe AUCUN backend `kdrive` (vérifié au lot 24) — Infomaniak
 * l'expose en WebDAV. Personne ne devrait composer une adresse WebDAV à la
 * main : crabe demande le numéro du kDrive et construit
 * `https://<numéro>.connect.kdrive.infomaniak.com/<numéro>`, avec
 * `vendor = other` (les valeurs `nextcloud`/`owncloud` activent des extensions
 * que kDrive n'implémente pas).
 */
const CHAMPS_KDRIVE = [
  {
    key: 'kdriveId',
    label: 'Numéro de votre kDrive',
    type: 'text',
    required: true,
    help: 'Un nombre, que vous lisez dans l\'adresse de votre kDrive quand vous l\'ouvrez '
      + 'dans un navigateur : après « /kdrive/ », ou dans l\'adresse qui commence par '
      + '« https://ksuite.infomaniak.com/kdrive/app/drive/ ».\n'
      + 'crabe compose lui-même l\'adresse de connexion à partir de ce numéro : vous n\'avez '
      + 'rien d\'autre à recopier.',
  },
  {
    key: 'user',
    label: 'Adresse e-mail de votre compte Infomaniak',
    type: 'text',
    required: true,
    help: 'La même adresse que celle avec laquelle vous vous connectez chez Infomaniak.',
  },
  {
    key: 'pass',
    label: 'Mot de passe d\'application',
    type: 'password',
    required: true,
    obscurcir: true,
    help: '⚠ Ce n\'est PAS le mot de passe de votre compte Infomaniak. Dès que la validation '
      + 'en deux étapes est active — et elle l\'est par défaut — Infomaniak refuse le mot de '
      + 'passe habituel pour ce genre de connexion.\n'
      + 'Créez un mot de passe dédié : sur manager.infomaniak.com, cliquez votre avatar en '
      + 'haut à droite, puis « Mot(s) de passe d\'application », puis « Ajouter ». Donnez-lui '
      + 'le nom que vous voulez (« crabe », par exemple) et recopiez ici la valeur affichée.\n'
      + 'Elle n\'est montrée qu\'une seule fois : notez-la avant de fermer la fenêtre. Elle est '
      + 'chiffrée ici et n\'est jamais réaffichée.',
  },
];

/**
 * Proton Drive : les champs viennent d'rclone, les MOTS viennent d'ici.
 *
 * ─── Pourquoi une troisième sorte de preset (lot 29) ─────────────────────────
 *
 * Proton Drive n'a pas de `champs` écrits : ils sont demandés au binaire, et
 * c'est la bonne façon de faire — une version d'rclone qui ajoute une option
 * l'ajoute au formulaire sans qu'une ligne de crabe change. Mais les libellés
 * et les aides qui arrivent avec sont la documentation d'rclone, en anglais :
 * « The username of your proton account », « The OTP secret key ». Acceptable
 * pour les soixante types génériques, pas pour un fournisseur vedette, celui
 * dont la carte porte un logo et une couleur.
 *
 * Ce tableau ne remplace donc PAS les champs : il les HABILLE. rclone reste la
 * source de ce qui existe ; crabe écrit ce que ça veut dire. Une option que
 * cette liste ne connaît pas garde son libellé d'origine et s'affiche
 * normalement — rien ne disparaît faute d'avoir été prévu ici.
 *
 * ─── Le second mot de passe, et pourquoi il remonte ──────────────────────────
 *
 * rclone classe `mailbox_password` parmi ses options avancées. Pour un compte
 * Proton en mode « deux mots de passe », c'est pourtant le champ SANS LEQUEL
 * RIEN NE MARCHE : la connexion réussit, puis le déchiffrement échoue sur
 * « this account requires a mailbox password ». `avance: false` le ramène donc
 * parmi les champs principaux — pour ce fournisseur, et pour lui seul.
 *
 * Le laisser vide reste normal : la plupart des comptes récents n'ont qu'un
 * seul mot de passe, et l'aide le dit plutôt que de laisser l'utilisateur se
 * demander ce qu'il a oublié.
 */
const PRESENTATION_PROTONDRIVE = {
  username: {
    label: 'Adresse e-mail de votre compte Proton',
    help: 'La même adresse que celle avec laquelle vous vous connectez sur proton.me — '
      + 'elle finit souvent par « @proton.me » ou « @protonmail.com », mais une adresse '
      + 'personnelle rattachée au compte convient aussi.',
  },
  password: {
    label: 'Mot de passe de connexion Proton',
    help: 'Celui que vous tapez sur le site de Proton pour ouvrir votre boîte ou votre '
      + 'espace de stockage. Il est chiffré ici et n\'est jamais réaffiché.',
  },
  mailbox_password: {
    // ⚠ `false` volontaire : rclone le range en « avancé », et il est
    // indispensable. Voir l'en-tête de ce bloc.
    avance: false,
    label: 'Second mot de passe (déchiffrement)',
    help: 'À remplir uniquement si votre compte Proton en demande DEUX à la connexion : '
      + 'un premier pour ouvrir la session, un second pour déchiffrer le contenu.\n'
      + 'Si Proton ne vous demande qu\'un seul mot de passe, laissez cette case vide — '
      + 'c\'est le cas le plus fréquent, en particulier sur les comptes créés '
      + 'récemment.\n'
      + 'Ce second mot de passe est celui que vous avez choisi en activant le mode deux '
      + 'mots de passe : sur account.proton.me, ouvrez « Tous les paramètres », puis la '
      + 'rubrique « Chiffrement et clés ». Proton ne peut pas vous le rappeler — il ne '
      + 'le connaît pas, c\'est tout l\'intérêt.\n'
      + 'Sans lui, un compte de ce type refuse la connexion avec le message « this '
      + 'account requires a mailbox password ».',
  },
  '2fa': {
    label: 'Code de validation à six chiffres',
    // ⚠ Réécrit au lot 34. L'aide du lot 33 poussait vers la clé
    // d'authentification (« qui ne périme pas ») — mesure faite depuis, dans
    // la source d'rclone v1.75.0 : après UNE connexion réussie, rclone
    // fabrique une session durable (client_uid, client_access_token…) qu'il
    // écrit lui-même, et crabe la conserve désormais (voir rclone.js). Un
    // seul code suffit donc, et c'est PRÉFÉRABLE : garder une clé TOTP en
    // permanence revient à supprimer le second facteur, alors qu'une session
    // se révoque depuis le compte Proton.
    help: 'Le code que votre application d\'authentification affiche EN CE MOMENT, si '
      + 'votre compte Proton demande une validation en deux étapes. Il ne vit qu\'une '
      + 'trentaine de secondes : cliquez « Tester la connexion » dans la foulée.\n'
      + 'Un seul code suffit : dès la première connexion réussie, crabe conserve une '
      + 'session durable et n\'a plus besoin ni du code ni de votre mot de passe pour '
      + 'les copies suivantes. Cette session se révoque à tout moment depuis votre '
      + 'compte Proton (Sécurité → Sessions).\n'
      + 'La « Clé de votre application d\'authentification » (dans « Réglages avancés ») '
      + 'reste offerte pour qui veut que crabe puisse se reconnecter seul même si Proton '
      + 'ferme la session — mais confier cette clé en permanence affaiblit la validation '
      + 'en deux étapes : ne le faites que si vous en avez vraiment besoin.',
    // ─── Contrôle de forme (lot 33) ─────────────────────────────────────────
    // Le champ n'accepte QUE six chiffres : tout le reste est une confusion
    // avec la clé du dessous, et se paierait à la première exécution.
    controle: {
      normaliser: (v) => String(v).replace(/\s+/g, ''),
      motif: '^[0-9]{6}$',
      message:
        'Le code de validation est un nombre à six chiffres — celui que votre application '
        + 'd\'authentification affiche en ce moment. Recopiez-le tel quel, sans lettres ni '
        + 'espaces. Et si vous voulez que crabe se connecte tout seul plus tard, remplissez '
        + 'plutôt « Clé de votre application d\'authentification », dans « Réglages avancés ».',
    },
  },
  otp_secret_key: {
    // ─── Rangée dans « Réglages avancés » (lot 57) ──────────────────────────
    //
    // C'est le cas rare par construction : l'aide elle-même dit « ne le faites
    // que si vous en avez vraiment besoin », et la session durable rend la clé
    // inutile au quotidien. La laisser au premier niveau, c'était un champ de
    // plus dans un formulaire déjà noyé — et la panne du 14/08/2026 (un code à
    // six chiffres saisi dedans) montre qu'un champ mal placé se remplit mal.
    avance: true,
    label: 'Clé de votre application d\'authentification',
    help: 'La suite de lettres et de chiffres que Proton vous a montrée en activant la '
      + 'validation en deux étapes — celle qui accompagne le QR code, souvent sous un '
      + 'lien « saisir la clé manuellement ». C\'est elle qui permet de CALCULER les '
      + 'codes à six chiffres.\n'
      + 'La donner ici évite d\'avoir à retaper un code à chaque fois : crabe le fabrique '
      + 'lui-même au moment où il en a besoin. Elle ne périme pas, ce qui est aussi une '
      + 'raison de ne la confier qu\'à un serveur dont vous avez la maîtrise.\n'
      + 'Si vous ne l\'avez plus, il faut la faire réafficher par Proton en '
      + 'reconfigurant la validation en deux étapes.',
    // ─── Contrôle de forme (lot 33) ─────────────────────────────────────────
    //
    // Mesuré en production le 14/08/2026 : ce champ contenait un code à six
    // chiffres, et chaque dépôt échouait sur « couldn't generate 2FA code:
    // Decoding of secret as base32 failed » — l'alphabet base32 ne contient
    // ni 0, ni 1, ni 8, ni 9. Le refus arrive désormais À LA SAISIE, avec la
    // différence expliquée, au lieu d'échouer en anglais des jours plus tard.
    controle: {
      normaliser: (v) => String(v).replace(/[\s-]+/g, '').toUpperCase(),
      refus: [
        {
          motif: '^[0-9]+$',
          message:
            'Ceci ressemble au code à six chiffres, pas à la clé. Le code change toutes les '
            + 'trente secondes et se saisit dans la case « Code de validation » ; ici, crabe '
            + 'attend la CLÉ qui accompagne le QR code de Proton — une suite de lettres et de '
            + 'chiffres, affichée sous « saisir la clé manuellement » quand vous activez la '
            + 'validation en deux étapes.',
        },
      ],
      motif: '^[A-Z2-7]+=*$',
      message:
        'Cette clé ne peut contenir que des lettres (A à Z) et des chiffres de 2 à 7 — '
        + 'c\'est la forme que Proton lui donne. Recopiez-la depuis Proton : elle accompagne '
        + 'le QR code de la validation en deux étapes, sous « saisir la clé manuellement ». '
        + 'Les espaces et tirets sont acceptés, crabe les retire.',
    },
  },
};

/**
 * pCloud : la région d'abord, le jeton en secours (lots 33 et 34).
 *
 * Le lot 33 avait sorti le jeton des réglages avancés — mesuré en production
 * le 14/08/2026, chaque dépôt échouait sur « empty token » et personne ne
 * pouvait deviner que « token » était LE champ indispensable. Le lot 34 va au
 * bout : le jeton s'obtient par le bouton « Se connecter à pCloud » (crabe
 * mène l'autorisation lui-même, dans sa fenêtre visible), et le champ à
 * coller RETOURNE dans les réglages avancés — il reste là pour qui a déjà un
 * jeton rclone sous la main, mais plus personne n'a à le remplir.
 *
 * Ce qui monte à la place, c'est la RÉGION. Mesuré au lot 34 sur le vrai
 * pCloud : la région voyage dans la redirection d'autorisation
 * (`hostname=eapi.pcloud.com` pour un compte européen) puis SE PERD — le
 * jeton imprimé ne la porte pas. Sans elle, un compte européen répond
 * « Invalid 'access_token' provided. (2094) » à chaque opération, alors que
 * le jeton est bon. C'est exactement la panne réelle du 14/08/2026.
 *
 * ⚠ `obscurcir: false` explicite sur le jeton : c'est un secret (il ne
 * redescend jamais au navigateur), mais rclone l'attend EN CLAIR dans sa
 * configuration — le passer par `rclone obscure` le rendrait inutilisable.
 */
const PRESENTATION_PCLOUD = {
  hostname: {
    avance: false,
    label: 'Où est hébergé votre compte pCloud ?',
    help: 'pCloud a deux régions, et un compte ne répond que dans la sienne — avec la '
      + 'mauvaise, pCloud refuse la connexion alors que tout le reste est juste.\n'
      + 'Pour le savoir : ouvrez pcloud.com dans votre navigateur et connectez-vous. '
      + 'Si l\'adresse devient e.pcloud.com, votre compte est en Europe ; si elle '
      + 'devient my.pcloud.com, il est aux États-Unis. Les comptes créés depuis la '
      + 'France sont presque toujours en Europe.',
    listeStricte: true,
    options: [
      { value: 'eapi.pcloud.com', label: 'Europe' },
      { value: 'api.pcloud.com', label: 'États-Unis' },
    ],
  },
  // ─── client_id / client_secret : sous « Réglages avancés » (lot 57) ───────
  //
  // rclone les classe parmi les options COURANTES (« Leave blank normally »),
  // et elles s'étalaient donc au premier niveau de la carte, au même rang que
  // la région. Personne ne les remplit — elles ne servent qu'à qui a créé sa
  // propre application OAuth chez pCloud. Le rare se range, il ne disparaît
  // pas.
  client_id: {
    avance: true,
    label: 'Identifiant d\'application OAuth (client_id)',
    help: 'À laisser vide dans la quasi-totalité des cas : crabe se connecte avec '
      + 'l\'application pCloud du logiciel rclone. Ne remplissez cette case que si vous '
      + 'avez créé votre propre application OAuth chez pCloud et voulez l\'utiliser.',
  },
  client_secret: {
    avance: true,
    label: 'Secret d\'application OAuth (client_secret)',
    help: 'À laisser vide, comme l\'identifiant juste au-dessus — les deux vont ensemble, '
      + 'et ne servent qu\'avec votre propre application OAuth.',
  },
  token: {
    avance: true,
    type: 'password',
    obscurcir: false,
    label: 'Jeton d\'accès pCloud (rempli par « Se connecter »)',
    help: 'Ce jeton se remplit tout seul quand vous passez par le bouton « Se connecter '
      + 'à pCloud » : vous n\'avez normalement rien à faire ici.\n'
      + 'La case reste offerte pour un cas précis : vous avez déjà obtenu un jeton avec '
      + 'le logiciel rclone (commande rclone authorize "pcloud") et préférez le coller '
      + 'vous-même. Collez alors TOUT le bloc affiché entre les lignes d\'encadrement, '
      + 'accolades comprises : { "access_token": … }.\n'
      + 'Le jeton est chiffré ici et n\'est jamais réaffiché.',
  },
};

/**
 * Zoho WorkDrive : la région est OBLIGATOIRE avant même l'autorisation.
 *
 * Mesuré au lot 34 sur le binaire v1.75.0 : `rclone authorize zoho` sans
 * région meurt sur `Error: no region set` — il ne montre même pas de page de
 * connexion. La question doit donc être posée AVANT le bouton, en français.
 */
const PRESENTATION_ZOHO = {
  region: {
    avance: false,
    required: true,
    label: 'Où est hébergé votre compte Zoho ?',
    help: 'Zoho répartit ses comptes par région, et la connexion ne peut même pas '
      + 'commencer sans elle. C\'est la fin de l\'adresse que vous utilisez pour ouvrir '
      + 'Zoho dans votre navigateur : zoho.eu → Europe, zoho.com → International '
      + '(États-Unis), zoho.in → Inde. Les comptes créés depuis la France sont presque '
      + 'toujours en Europe.',
    listeStricte: true,
    options: [
      { value: 'eu', label: 'Europe (zoho.eu)' },
      { value: 'com', label: 'International — États-Unis (zoho.com)' },
      { value: 'in', label: 'Inde (zoho.in)' },
      { value: 'jp', label: 'Japon (zoho.jp)' },
      { value: 'com.au', label: 'Australie (zoho.com.au)' },
      { value: 'com.cn', label: 'Chine (zoho.com.cn)' },
    ],
  },
};

/**
 * L'habillage français, par type rclone.
 *
 * Indexé par le TYPE et non par le preset : `protondrive` est `protondrive`,
 * qu'on y arrive par la carte Proton Drive ou par la liste complète des types.
 * Les deux écrans doivent lire les mêmes mots.
 */
/**
 * S3 : l'habillage des champs venus d'rclone (lot 62).
 *
 * Il sert aux destinations de type `s3` créées AVANT ce lot par la liste
 * complète des types (leur formulaire vient d'rclone), et aux options que le
 * complément range dans « Réglages avancés » du socle. Les mêmes mots que les
 * champs écrits du socle : deux chemins, une seule lecture.
 *
 * `endpoint` et `region` perdent leur liste déroulante (`options: []`) : celle
 * d'rclone mélange les adresses de cinquante fournisseurs — deux cents entrées
 * où trouver la sienne relève du hasard, et la bonne se recopie de toute façon
 * depuis le fournisseur. `secret_access_key` devient un secret aux yeux de
 * crabe (jamais réaffiché, vide = « garde celui d'avant ») tout en restant en
 * clair dans le bloc — `IsPassword: false` mesuré, voir `CHAMPS_S3`.
 */
const PRESENTATION_S3 = {
  provider: {
    label: 'Nom du fournisseur dans rclone',
    help: 'Le nom que l\'outil de copie donne à votre fournisseur — le choisir améliore '
      + 'la compatibilité, parce qu\'rclone connaît les particularités de chacun. S\'il '
      + 'n\'est pas dans la liste, choisissez « Other » : le service répondra avec les '
      + 'réglages standards.',
  },
  env_auth: {
    // Rangée dans « Réglages avancés » : cette option fait lire les clés dans
    // l'environnement du SERVEUR — un cas d'hébergeur, pas d'utilisateur. Au
    // premier niveau, elle sème le doute sous les deux champs de clés.
    avance: true,
    label: 'Lire les clés dans l\'environnement du serveur',
    help: 'À laisser vide : ne sert que si le serveur qui héberge crabe porte déjà des '
      + 'clés S3 dans son environnement et que vous voulez les utiliser telles quelles.',
  },
  endpoint: { options: [], ...LIBELLES_S3.endpoint },
  region: { options: [], ...LIBELLES_S3.region },
  access_key_id: { ...LIBELLES_S3.access_key_id },
  secret_access_key: {
    type: 'password',
    obscurcir: false,
    ...LIBELLES_S3.secret_access_key,
  },
};

const PRESENTATIONS = {
  protondrive: PRESENTATION_PROTONDRIVE,
  pcloud: PRESENTATION_PCLOUD,
  zoho: PRESENTATION_ZOHO,
  s3: PRESENTATION_S3,
};

/**
 * Ce qui, dans une configuration enregistrée, condamne les prochains dépôts.
 *
 * Rendu à l'écran au moment d'ENREGISTRER, et affiché sur la carte tant que ça
 * dure : les deux pannes ci-dessous ont tourné en production sans qu'aucun
 * écran ne les annonce — elles ne se découvraient qu'à l'exécution suivante,
 * en anglais, dans un journal.
 *
 * @param {string} type le type rclone de la destination
 * @param {{valeurs?: object, rcloneConfig?: string}} normalise la
 *   configuration complète (les valeurs nommées ET le bloc brut : un jeton
 *   peut vivre dans l'un ou l'autre)
 * @returns {string[]} phrases prêtes à afficher, vide si rien à signaler
 */
function avertissements(type, normalise = {}) {
  const valeurs = normalise.valeurs || {};
  const bloc = String(normalise.rcloneConfig || '');
  const dansBloc = (cle) => new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(bloc);
  const renseigne = (cle) => Boolean(String(valeurs[cle] || '').trim()) || dansBloc(cle);
  const avis = [];

  if (String(type) === 'protondrive') {
    // La session durable d'rclone (lot 34) : après une connexion réussie, son
    // authHandler écrit `client_*` dans la configuration, et crabe les
    // conserve. Présentes, elles remplacent mot de passe ET code 2FA — les
    // avertissements changent donc de visage.
    const sessionDurable = renseigne('client_access_token') && renseigne('client_uid');

    // Un code à usage unique sans clé NI session : la PREMIÈRE exécution
    // planifiée échouera, c'est certain — le code aura péri bien avant elle.
    // Avec la session durable, ce même code a déjà fait son travail : il a
    // servi à l'établir, et plus personne n'en aura besoin.
    if (renseigne('2fa') && !renseigne('otp_secret_key') && !sessionDurable) {
      avis.push(
        'Le code à six chiffres ne vit qu\'une trentaine de secondes : cliquez « Tester '
          + 'la connexion » MAINTENANT, pendant qu\'il est valable. Si la connexion '
          + 'réussit, crabe garde une session durable et n\'aura plus jamais besoin de '
          + 'code. Si vous enregistrez sans tester, la prochaine copie automatique '
          + 'échouera — le code aura péri bien avant elle.'
      );
    }

    // La clé DÉJÀ enregistrée est examinée aussi : le contrôle de saisie ne
    // protège que l'avenir, et la panne du 14/08/2026 était précisément une
    // valeur posée AVANT lui — un code à six chiffres rangé comme clé, que
    // chaque dépôt payait en anglais. La valeur est lue côté serveur pour sa
    // FORME seulement : jamais modifiée, jamais affichée.
    const cleStockee = String(valeurs.otp_secret_key || '').replace(/[\s-]+/g, '');
    const cleDuBloc = /^\s*otp_secret_key\s*=\s*([0-9]+)\s*$/m.exec(bloc)?.[1] || '';
    if ((cleStockee && /^[0-9]+$/.test(cleStockee)) || cleDuBloc) {
      // Deux vérités selon qu'une session durable existe : sans elle, chaque
      // copie paie la fausse clé tout de suite ; avec elle, les copies passent
      // — c'est la RECONNEXION, le jour où Proton fermera la session, qui
      // butera dessus. Dire « chaque copie échouera » à quelqu'un dont les
      // copies marchent ferait perdre confiance dans tous les autres messages.
      avis.push(
        sessionDurable
          ? 'La « Clé de votre application d\'authentification » enregistrée ressemble à '
            + 'un code à six chiffres — ce n\'est pas une clé. Vos copies marchent grâce à '
            + 'la session durable, mais le jour où Proton la fermera, la reconnexion '
            + 'automatique échouera sur cette fausse clé. Le plus simple : effacez-la, '
            + 'crabe n\'en a plus besoin. Ou remplacez-la par la vraie — celle qui '
            + 'accompagne le QR code de Proton, sous « saisir la clé manuellement ».'
          : 'La « Clé de votre application d\'authentification » enregistrée ressemble à un '
            + 'code à six chiffres — ce n\'est pas une clé, et chaque copie échouera. '
            + 'Effacez-la, puis recopiez la clé qui accompagne le QR code de Proton '
            + '(des lettres et des chiffres de 2 à 7, sous « saisir la clé manuellement »).'
      );
    }
  }

  if (String(type) === 'pcloud' && !renseigne('token')) {
    avis.push(
      'Aucun jeton d\'accès pCloud n\'est enregistré : les copies vers cette destination '
        + 'échoueront. Cliquez sur « Se connecter à pCloud » sur cette carte — crabe mène '
        + 'l\'autorisation tout seul, aucun code à recopier.'
    );
  }

  // ─── La région pCloud absente (lot 34) ────────────────────────────────────
  //
  // Mesuré en production le 14/08/2026 sur cloud-a19497a4 : un jeton VALIDE,
  // et chaque copie répondait « Invalid 'access_token' provided. (2094) » —
  // parce que le compte est européen et que, sans `hostname`, rclone vise
  // l'API américaine. La configuration ne contenait qu'une clé (`token`) :
  // personne n'avait jamais demandé la région. Un compte américain marche
  // sans elle — l'avertissement dit donc les deux cas, honnêtement.
  if (String(type) === 'pcloud' && renseigne('token') && !renseigne('hostname')) {
    avis.push(
      'La région de votre compte pCloud n\'est pas renseignée : crabe visera la région '
        + 'américaine. Si votre compte est hébergé en Europe — le cas le plus fréquent en '
        + 'France — chaque copie échouera, alors que le jeton est bon. Choisissez « Où est '
        + 'hébergé votre compte pCloud ? » sur cette carte, puis enregistrez.'
    );
  }

  // ─── Le bucket S3 absent (lot 62) ─────────────────────────────────────────
  //
  // Sans bucket, l'adresse composée retombe sur le dossier de base seul :
  // les copies viseraient un bucket nommé « crabe », qui n'existe
  // vraisemblablement pas — et « Tester » risquerait même de le créer. Le cas
  // se reconnaît à l'adresse EFFECTIVE (`basePath` normalisé, bucket compris) :
  // un bloc collé à la main ou un « Dossier de base » qui porte déjà le bucket
  // (`mon-bucket/crabe`) ne sont pas inquiétés. Rien n'est dit tant que rien
  // n'est configuré : une carte neuve n'a pas besoin d'un avertissement.
  if (
    String(type) === 's3'
    && bloc
    && !renseigne('bucket')
    && !String(normalise.basePath || '').includes('/')
  ) {
    avis.push(
      'Aucun nom de bucket n\'est renseigné : les copies viseraient un bucket nommé '
        + `« ${String(normalise.basePath || 'crabe')} », qui n'existe probablement pas chez votre `
        + 'fournisseur. Renseignez « Nom du bucket » sur cette carte — ou, si elle n\'a pas '
        + 'cette case, placez le nom du bucket devant le dossier de base, sous la forme '
        + '« mon-bucket/crabe » — puis enregistrez.'
    );
  }

  // ─── Le MEGA à validation en deux étapes (lot 61) ─────────────────────────
  //
  // La marque a été posée par un refus MESURÉ du service (voir
  // `marquerMegaDeuxEtapes`), et `refusAvantService` porte déjà la phrase
  // complète — celle qui dit que réessayer ne sert à rien et ce qui, lui,
  // fonctionnerait. La carte l'affiche telle quelle : deux formulations du
  // même fait finiraient par diverger.
  if (String(type) === 'mega' && normalise.refusAvantService) {
    avis.push(normalise.refusAvantService);
  }

  return avis;
}

/**
 * Habille les champs d'un type avec les libellés français écrits ici.
 *
 * Ne retire jamais un champ, n'en invente jamais : elle remplace `label`,
 * `help`, et — quand c'est justifié — le classement `avance`. Un type sans
 * habillage ressort tel quel.
 */
function habiller(type, champs) {
  const habits = PRESENTATIONS[String(type || '')];
  if (!habits || !Array.isArray(champs)) return champs;
  return champs.map((c) => (habits[c.key] ? { ...c, ...habits[c.key] } : c));
}

/**
 * Le catalogue des presets, dans l'ordre où la liste de choix les propose.
 *
 * `backend` : le type rclone imposé, ou `null` quand c'est l'utilisateur qui
 * choisit le type dans la liste complète.
 * `couvreLeType` : ce preset remplace-t-il son type rclone dans la liste de
 *   choix ? (voir l'en-tête du fichier)
 * `champs`  : le formulaire écrit ici, ou `null` pour « demande à rclone ».
 * `versChamps` : adapte les valeurs saisies avant d'en faire un bloc rclone.
 * `resume` : une phrase pour la liste de choix, écrite pour quelqu'un qui ne
 *   sait pas ce qu'est un backend rclone — c'est tout ce qu'il lira avant de
 *   cliquer.
 */
const PRESETS = {
  pcloud: {
    id: 'pcloud',
    label: 'pCloud',
    backend: 'pcloud',
    couvreLeType: true,
    letter: 'p',
    color: '#1f8fd6',
    site: 'www.pcloud.com',
    resume: 'Stockage en ligne suisse, avec offre à vie.',
    champs: null,
  },
  proton: {
    id: 'proton',
    label: 'Proton Drive',
    backend: 'protondrive',
    couvreLeType: true,
    letter: 'P',
    color: '#6c5ce7',
    site: 'proton.me',
    resume: 'Le stockage chiffré de Proton, l\'éditeur de Proton Mail.',
    champs: null,
  },
  /**
   * Les DEUX MEGA (lot 62) : le même fournisseur, deux voies qui ne savent pas
   * faire la même chose — et chacune le dit AVANT qu'on la choisisse.
   *
   * Le compte ordinaire échoue structurellement dès que la validation en deux
   * étapes est active (panne mesurée le 26/08/2026, voir `erreurs-rclone.js`) ;
   * le stockage objet est payant, mais ses clés ne périment pas et la
   * validation en deux étapes ne le gêne pas. Découvrir cette différence après
   * trois échecs de dépôt, c'est exactement ce que ces deux résumés évitent.
   */
  mega: {
    id: 'mega',
    label: 'MEGA (compte gratuit)',
    backend: 'mega',
    couvreLeType: true,
    letter: 'M',
    color: '#d9272e',
    site: 'mega.io',
    resume: 'Le compte MEGA habituel, 20 Go offerts — ne fonctionne pas si la validation '
      + 'en deux étapes est active sur le compte.',
    champs: CHAMPS_MEGA,
  },
  megas4: {
    id: 'megas4',
    label: 'MEGA (stockage objet, payant)',
    backend: 's3',
    // ⚠ FAUX, et c'est voulu — comme kDrive avec `webdav` : `s3` est un
    // protocole que des dizaines de services parlent. Le socle « Stockage
    // compatible S3 » couvre le type ; cette carte n'en est qu'un visage.
    couvreLeType: false,
    letter: 'M',
    color: '#d9272e',
    site: 'mega.io',
    resume: 'Le stockage objet de MEGA (« S4 »), payant — des clés d\'accès qui ne '
      + 'périment pas, et qui fonctionnent même avec la validation en deux étapes.',
    champs: CHAMPS_MEGA_S4,
    // `provider = Mega` posé d'office, et RIEN d'autre que ce que le formulaire
    // demande : pour ce provider, le binaire dit lui-même que région et ACL ne
    // s'appliquent pas. Le bucket ne passe pas — il vit dans l'adresse
    // (`versBase`), pas dans le bloc.
    versChamps: (valeurs) => ({
      provider: 'Mega',
      endpoint: valeurs?.endpoint,
      access_key_id: valeurs?.access_key_id,
      secret_access_key: valeurs?.secret_access_key,
    }),
    versBase: baseDansLeBucket,
  },
  s3: {
    id: 's3',
    label: 'Stockage compatible S3',
    backend: 's3',
    couvreLeType: true,
    letter: 'S',
    color: '#b3702d',
    site: '',
    resume: 'Un espace « bucket » chez n\'importe quel fournisseur compatible S3 — '
      + 'Amazon, OVHcloud, Hetzner, Scaleway, Wasabi… Il vous faut une adresse de '
      + 'service et une paire de clés d\'accès.',
    champs: CHAMPS_S3,
    // Pas de `versChamps` : les champs écrits portent les clés telles
    // qu'rclone les attend, et le COMPLÉMENT reste ouvert — les soixante-dix
    // options avancées du backend s3 arrivent dans « Réglages avancés »,
    // habillées par `PRESENTATION_S3`. Seul le bucket est écarté du bloc
    // (`horsBloc`) : il vit dans l'adresse.
    versBase: baseDansLeBucket,
  },
  kdrive: {
    id: 'kdrive',
    label: 'kDrive',
    backend: 'webdav',
    // ⚠ FAUX, et c'est voulu : `webdav` n'appartient pas à Infomaniak. Le
    // retirer de la liste au motif que kDrive s'en sert priverait d'un serveur
    // WebDAV quelconque — Nextcloud, ownCloud, une box d'hébergeur.
    couvreLeType: false,
    letter: 'k',
    color: '#0098ff',
    site: 'www.infomaniak.com',
    resume: 'Le stockage d\'Infomaniak, hébergé en Suisse.',
    champs: CHAMPS_KDRIVE,
    versChamps: (valeurs) => ({
      url: adresseWebdavKdrive(valeurs?.kdriveId),
      vendor: 'other',
      user: valeurs?.user,
      pass: valeurs?.pass,
    }),
  },
  /**
   * Le type choisi dans la liste d'rclone — Dropbox, un serveur WebDAV, un
   * espace S3…
   *
   * ⚠ Ce n'est PLUS une carte de la liste de choix depuis le lot 28 : chaque
   * type y figure désormais sous son propre nom, et cliquer dessus crée une
   * destination `autre` avec ce type déjà posé. Le preset reste, parce qu'il
   * porte l'HABILLAGE de ces destinations-là — l'icône neutre du dépôt, la
   * couleur grise — et parce que des lignes en base le portent déjà, y compris
   * l'unique destination « rclone » de l'ancien modèle (voir HERITAGE).
   *
   * Son libellé sert de nom par défaut à une destination créée sans type, cas
   * qui ne survient plus par l'interface mais reste possible par l'API.
   */
  autre: {
    id: 'autre',
    label: 'Autre stockage',
    backend: null,
    couvreLeType: false,
    letter: '+',
    color: '#63666e',
    site: '',
    icone: '/stockage-autre.svg',
    resume: 'Dropbox, Google Drive, un serveur WebDAV, un espace S3… : la liste '
      + 'complète de ce que ce serveur sait utiliser.',
    champs: null,
  },
};

/**
 * Les fournisseurs VEDETTES, par ordre alphabétique.
 *
 * Ils ouvrent la liste de choix, avant les types d'rclone (lot 28) : ce sont
 * les seuls dont crabe connaît le nom propre, la couleur et les pièges. Le
 * reste de la liste vient du binaire installé et se range derrière, sans
 * rupture ni second menu.
 *
 * « Autre stockage » n'en fait plus partie : ce n'était pas un fournisseur mais
 * une porte vers une seconde liste, et cette seconde liste n'existe plus.
 */
function liste() {
  return Object.values(PRESETS)
    .filter((p) => p.id !== 'autre')
    .sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base', numeric: true }));
}

/**
 * Les types rclone qu'un fournisseur vedette remplace à lui seul.
 *
 * C'est ce qui garantit qu'un service n'apparaît jamais deux fois dans la
 * liste : `pcloud` est déjà là, tout en haut, avec son nom écrit correctement.
 */
function typesCouverts() {
  return new Set(
    Object.values(PRESETS)
      .filter((p) => p.couvreLeType && p.backend)
      .map((p) => p.backend)
  );
}

/**
 * `provider` d'une ligne héritée du modèle d'avant le lot 25.
 *
 * La destination unique « rclone » (type libre) devient un cloud « autre » ;
 * les quatre autres gardent le preset de leur fournisseur. Sert à la
 * migration 29 comme aux pastilles des factures copiées à l'époque.
 */
const HERITAGE = {
  proton: 'proton',
  pcloud: 'pcloud',
  mega: 'mega',
  kdrive: 'kdrive',
  rclone: 'autre',
};

/** Le preset demandé, ou `null` — jamais d'exception pour un id inconnu. */
function of(providerId) {
  return PRESETS[String(providerId || '')] || null;
}

module.exports = {
  PRESETS,
  HERITAGE,
  CHAMPS_MEGA,
  CHAMPS_KDRIVE,
  CHAMPS_S3,
  CHAMPS_MEGA_S4,
  PRESENTATIONS,
  adresseWebdavKdrive,
  baseDansLeBucket,
  habiller,
  avertissements,
  liste,
  typesCouverts,
  of,
};
