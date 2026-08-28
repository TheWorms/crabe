'use strict';

/**
 * Ce qu'on dit à l'utilisateur quand rclone échoue — en français, avec le
 * geste qui répare.
 *
 * ─── Pourquoi ce module existe (lot 33) ──────────────────────────────────────
 *
 * Relevé en production le 14/08/2026, sur chaque document rangé :
 *
 *     pCloud       : empty token - please run rclone config reconnect
 *     Proton Drive : couldn't generate 2FA code: Decoding of secret as base32 failed
 *
 * et sur l'écran « Mes documents », des pastilles rouges portant du
 * `CRITICAL: Failed to create file system for "crabe:crabe"`. crabe a
 * vocation à être publié devant un public non technique : un message d'erreur
 * en anglais, écrit pour un utilisateur de terminal, est un manquement — il ne
 * dit ni ce qui s'est passé, ni quoi faire.
 *
 * La table ci-dessous reconnaît les pannes MESURÉES et celles dont la forme
 * est connue d'rclone. Une erreur inconnue reste dite en français, avec le
 * détail technique conservé entre parenthèses : c'est lui qui permettra de
 * l'ajouter ici quand elle se sera montrée.
 */

/**
 * Le manque que seule la clé TOTP comble (lot 58).
 *
 * Servi dans deux situations qui sont le MÊME manque : une connexion jouée
 * sans code ni clé qu'un compte à validation en deux étapes refuse (signature
 * ci-dessous), et une reconnexion automatique déclarée impossible AVANT de
 * solliciter le service (la session est morte, le compte demande un code, et
 * rien ne permet d'en calculer un). Jamais « vérifiez votre mot de passe » :
 * le mot de passe n'y est pour rien, c'est le second facteur qui manque.
 */
const MESSAGE_RECONNEXION_SANS_CLE =
  'La connexion a expiré et crabe ne peut pas la rouvrir tout seul : ce compte demande '
  + 'un code de validation à chaque connexion, et seule la « Clé de votre application '
  + 'd\'authentification » lui permettrait d\'en calculer un frais. Renseignez-la dans '
  + 'les réglages de cette destination — c\'est la suite de lettres et de chiffres qui '
  + 'accompagne le QR code de Proton, sous « saisir la clé manuellement ». Sans elle, '
  + 'reconnectez-vous à la main : mot de passe, code frais, puis « Tester la '
  + 'connexion » dans la foulée.';

/**
 * La signature du MEGA à validation en deux étapes (lot 61).
 *
 * Mesurée en production le 26/08/2026 : la création de l'espace réussit à
 * 09:16, puis CHAQUE dépôt échoue sur « couldn't login: The upload target URL
 * you are trying to access has expired. Please request a fresh one ». La cause
 * est documentée hors de crabe : la bibliothèque MEGA de l'outil de copie
 * (go-mega) refait une connexion multifacteur à chaque appel en rejouant un
 * jeton déjà expiré — seule la première requête d'une connexion passe. La
 * contribution qui devait corriger cela n'a jamais été intégrée : aucun
 * réglage de crabe n'y peut rien, et « réessayez » serait une promesse fausse.
 */
const SIGNATURE_MEGA_DEUX_ETAPES = /couldn't login[\s\S]*upload target URL[\s\S]*expired/i;

/**
 * Le manque que MEGA + validation en deux étapes ne laisse pas combler
 * (lot 61). Servi par la table des pannes ET par le refus avant service
 * (`remote-rclone.normalizeConf`) : deux visages du même fait — cette
 * combinaison n'est pas joignable, et le dire deux fois pareil vaut mieux que
 * deux phrases qui divergent.
 */
const MESSAGE_MEGA_DEUX_ETAPES =
  'Cette destination MEGA n\'est pas joignable tant que la validation en deux étapes est '
  + 'active sur le compte : l\'outil de copie ne réussit qu\'une seule opération par '
  + 'connexion — un défaut connu de sa bibliothèque MEGA, sans correction à ce jour. Vos '
  + 'identifiants et le réseau n\'y sont pour rien, et réessayer reproduirait le même '
  + 'refus : crabe ne réessaie donc plus. Ce qui fonctionne : le stockage objet '
  + 'compatible S3 de MEGA — la carte « MEGA (stockage objet, payant) » de la liste '
  + 'd\'ajout, des clés d\'accès qui n\'expirent pas, votre validation en deux étapes '
  + 'restant active —, ou un compte MEGA sans validation en deux étapes : ressaisissez '
  + 'alors votre mot de passe sur cette carte pour que crabe réessaie.';

/**
 * Les pannes reconnues, dans l'ordre d'essai. La PREMIÈRE qui correspond
 * gagne : les motifs précis (jeton vide, clé illisible) passent avant les
 * familles générales (authentification, réseau).
 */
const PANNES = [
  {
    // pCloud, mesuré : « empty token - please run rclone config reconnect ».
    motif: /empty token/i,
    message:
      'Aucun jeton d\'accès n\'est enregistré pour cette destination : elle n\'a jamais été '
      + 'autorisée. Ouvrez ses réglages (Paramètres → Stockage), renseignez le champ '
      + '« Jeton d\'accès » — son aide explique comment l\'obtenir — puis réessayez.',
  },
  {
    // Proton Drive, mesuré : « couldn't generate 2FA code: Decoding of secret
    // as base32 failed » — un code à six chiffres rangé à la place de la clé.
    motif: /base32|couldn't generate 2FA code/i,
    message:
      'La clé de validation en deux étapes enregistrée n\'en est pas une — c\'est '
      + 'probablement un code à six chiffres qui a été saisi à sa place. Ouvrez les '
      + 'réglages de cette destination et recopiez la CLÉ affichée par votre application '
      + 'd\'authentification (des lettres et des chiffres de 2 à 7, jamais un simple code).',
  },
  {
    // Proton en mode deux mots de passe, forme connue d'rclone : « this
    // account requires a mailbox password ». Le champ du formulaire s'appelle
    // « Second mot de passe (déchiffrement) » — la phrase le nomme tel quel.
    motif: /mailbox password/i,
    message:
      'Ce compte demande DEUX mots de passe : un pour ouvrir la session, un second pour '
      + 'déchiffrer le contenu. Renseignez le champ « Second mot de passe (déchiffrement) » '
      + 'dans les réglages de cette destination, puis réessayez.',
  },
  {
    // ─── La session durable révoquée ou périmée (incident du 25/08/2026) ─────
    //
    // Séquence mesurée en production : « 401 Invalid access token » puis
    // « 400 Invalid refresh token (Code=10013) ». La cause n'est PAS un
    // mauvais mot de passe : c'est la session conservée par crabe que le
    // service ne reconnaît plus. L'ancien message (« Vérifiez l'adresse et le
    // mot de passe ») a fait ressaisir trois fois des identifiants corrects.
    motif: /invalid access token|invalid refresh token|Code=10013/i,
    message:
      'La session enregistrée pour cette destination a été fermée ou a expiré chez le '
      + 'service — vos identifiants n\'y sont pour rien. Ouvrez les réglages de cette '
      + 'destination, saisissez votre mot de passe (et un code de validation frais si '
      + 'votre compte en demande un), puis cliquez « Tester la connexion ».',
  },
  {
    // ─── Le 2FA exigé, rien à jouer (lot 58) ─────────────────────────────────
    //
    // Signature lue dans la SOURCE des deux versions en jeu — le backend
    // protondrive de rclone v1.75.0 et Proton-API-Bridge (common/error.go),
    // qu'il embarque : « this account requires a 2FA code. Can be provided
    // with --protondrive-2fa=000000 ». C'est le refus d'une connexion jouée
    // sans code ni clé sur un compte à validation en deux étapes — le visage
    // exact d'une reconnexion automatique tentée sans la clé TOTP.
    motif: /requires a 2FA code/i,
    message: MESSAGE_RECONNEXION_SANS_CLE,
  },
  {
    // Le second facteur refusé (incident du 25/08/2026) : « 422 … Code=8002
    // sur /auth/v4/2fa » — le code à usage unique enregistré, rejoué après
    // péremption. Un code ne vit qu'une trentaine de secondes.
    motif: /auth\/v4\/2fa|invalid 2fa|2fa code (?:is )?(?:invalid|incorrect|wrong|expired)/i,
    message:
      'Le service a refusé le code de validation : un code à six chiffres ne sert qu\'une '
      + 'fois et ne vit qu\'une trentaine de secondes — celui qui est enregistré a déjà '
      + 'servi ou a expiré. Ouvrez les réglages de cette destination, saisissez le code '
      + 'que votre application affiche EN CE MOMENT, puis « Tester la connexion » dans '
      + 'la foulée.',
  },
  {
    // ─── MEGA + validation en deux étapes (lot 61) ───────────────────────────
    //
    // Voir SIGNATURE_MEGA_DEUX_ETAPES : la panne est STRUCTURELLE, le message
    // ne promet aucun « réessayez ». Avant la famille « token expired » — le
    // texte contient « expired », et la reconnexion que cette famille propose
    // ne réparerait rien ici.
    motif: SIGNATURE_MEGA_DEUX_ETAPES,
    message: MESSAGE_MEGA_DEUX_ETAPES,
  },
  {
    // Jeton expiré ou révoqué : la reconnexion est le seul geste qui répare.
    motif: /token expired|invalid_grant|token has been revoked|couldn't fetch token/i,
    message:
      'L\'autorisation donnée à crabe par ce service a expiré ou a été révoquée. Ouvrez '
      + 'les réglages de cette destination et renseignez un nouveau jeton d\'accès — son '
      + 'aide explique comment l\'obtenir.',
  },
  {
    // Espace jamais utilisé : le dossier de crabe n'existe pas encore. Mesuré
    // le 15/08/2026 sur un compte pCloud vierge — c'est l'état NORMAL d'une
    // destination neuve, pas une panne, et le message doit le dire ainsi.
    motif: /directory not found/i,
    message:
      'Le dossier de crabe n\'existe pas encore sur cet espace — c\'est l\'état normal d\'un '
      + 'espace tout neuf. Il sera créé automatiquement au premier dépôt ; le bouton '
      + '« Tester » de cette destination le crée aussi, tout de suite.',
  },
  // ─── Les refus S3, par leur code (lot 62) ──────────────────────────────────
  //
  // Ces codes ne sont pas des messages d'rclone : ce sont ceux du protocole S3
  // lui-même, que tout fournisseur compatible renvoie tels quels — c'est même
  // ce qui fait la compatibilité. Ils passent AVANT la famille « 401 » : un
  // refus S3 embarque souvent un code HTTP 403, et la phrase générique
  // accuserait « l'adresse et le mot de passe » là où c'est une clé précise
  // qui cloche.
  {
    // La clé d'accès n'existe pas chez le service.
    motif: /InvalidAccessKeyId/i,
    message:
      'Le service ne connaît pas cette clé d\'accès. Vérifiez la « Clé d\'accès (Access '
      + 'Key ID) » dans les réglages de cette destination — et que l\'adresse du service '
      + 'est bien celle où ces clés ont été créées.',
  },
  {
    // La clé secrète ne correspond pas à la clé d'accès.
    motif: /SignatureDoesNotMatch/i,
    message:
      'La clé secrète ne correspond pas à la clé d\'accès : le service reconnaît la '
      + 'première clé mais pas la signature calculée avec la seconde. Ressaisissez la '
      + '« Clé secrète (Secret Access Key) » dans les réglages de cette destination — '
      + 'telle que le fournisseur l\'a montrée à la création, sans espace autour.',
  },
  {
    // Le bucket demandé n'existe pas (ou pas à cette adresse).
    motif: /NoSuchBucket/i,
    message:
      'Ce bucket n\'existe pas chez le service. Vérifiez le « Nom du bucket » dans les '
      + 'réglages de cette destination — et qu\'il a bien été créé à l\'adresse de '
      + 'service (la région) que vous avez choisie : un bucket ne répond que dans la '
      + 'sienne.',
  },
  {
    motif: /401|unauthorized|authentication failed|invalid credentials|login failed|incorrect password/i,
    message:
      'Le service a refusé les identifiants enregistrés. Vérifiez l\'adresse et le mot de '
      + 'passe dans les réglages de cette destination, puis réessayez.',
  },
  {
    motif: /quota|insufficient storage|storage limit|disk full|not enough space/i,
    message:
      'L\'espace de stockage est plein chez ce service : faites de la place, ou '
      + 'augmentez votre abonnement, puis relancez la synchronisation.',
  },
  {
    motif: /timeout|connection refused|no such host|network is unreachable|dial tcp|i\/o timeout|temporary failure/i,
    message: 'Le service n\'a pas répondu. Vérifiez la connexion du serveur, ou réessayez plus tard.',
  },
];

/**
 * Retire l'habillage d'rclone pour ne garder que la cause.
 *
 * `CRITICAL: Failed to create file system for "crabe:crabe": pcloud: empty
 * token…` : les deux premiers segments décrivent la plomberie d'rclone, la
 * cause est à la fin. On la cherche dans le TOUT (les motifs ci-dessus s'en
 * chargent) ; ceci ne sert qu'au détail technique affiché en dernier recours.
 */
function depouiller(brut) {
  return String(brut || '')
    .replace(/^\s*\d{4}\/\d{2}\/\d{2}[^ ]* [^ ]* /gm, '') // l'horodatage des lignes de log
    .replace(/(CRITICAL|ERROR|NOTICE|Failed to [^:]+):\s*/gi, '')
    .trim();
}

/**
 * La phrase française pour un message d'rclone.
 *
 * @param {unknown} brut ce qu'rclone a écrit (stderr, message d'erreur…)
 * @returns {string} une phrase qui dit quoi faire ; jamais vide, jamais brute
 */
function traduire(brut) {
  const texte = String(brut || '').trim();
  if (!texte) {
    return 'La copie a échoué sans explication. Réessayez ; si cela se reproduit, signalez-le.';
  }
  for (const panne of PANNES) {
    if (panne.motif.test(texte)) return panne.message;
  }
  // Inconnue : le français d'abord, le détail ensuite — tronqué, il sert au
  // diagnostic, pas à la lecture.
  const detail = depouiller(texte).slice(0, 160);
  return (
    'La copie vers cette destination a échoué. Réessayez ; si cela se reproduit, '
    + `signalez-le en joignant ce détail technique : « ${detail} ».`
  );
}

module.exports = {
  traduire,
  PANNES,
  MESSAGE_RECONNEXION_SANS_CLE,
  MESSAGE_MEGA_DEUX_ETAPES,
  SIGNATURE_MEGA_DEUX_ETAPES,
};
