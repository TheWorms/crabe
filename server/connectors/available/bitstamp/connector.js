'use strict';

/**
 * Connecteur Bitstamp — API signée, et relevé RECONSTITUÉ.
 *
 * ─── Pourquoi il ne télécharge aucune facture ────────────────────────────────
 *
 * Parce qu'il n'y en a pas. Bitstamp tient un journal d'opérations ; il
 * n'émet aucun document comptable, et son API n'a aucune route de document.
 * Un connecteur qui s'arrêterait à ce constat laisserait l'utilisateur sans
 * trace de ce qui s'est passé sur son compte.
 *
 * crabe met donc cet historique en forme lui-même, par le gabarit commun
 * (`connectors/releve-reconstitue.js`) — avec son bandeau d'avertissement en
 * tête de CHAQUE page, qui dit en toutes lettres que le document ne vient pas
 * de Bitstamp. Aucun document n'est produit sans lui : c'est le gabarit qui
 * l'écrit, pas ce connecteur, et il n'y a pas d'option pour l'enlever.
 *
 * ─── La découpe : un relevé par mois RÉVOLU ──────────────────────────────────
 *
 * Voir `releve-reconstitue.parMoisRevolus`. En deux mots : le mois en cours est
 * écarté parce qu'un relevé incomplet, une fois déposé, ne serait jamais
 * regénéré — son identifiant serait déjà connu — et la fin du mois
 * disparaîtrait de tout document.
 *
 * ─── La signature, et pourquoi elle est écrite ici en toutes lettres ─────────
 *
 * Bitstamp v2 ne prend pas un jeton mais une signature HMAC-SHA256 sur une
 * CONCATÉNATION SANS SÉPARATEUR, dont l'ordre est celui-ci, à la lettre :
 *
 *   "BITSTAMP " + clé + verbe + hôte + chemin + requête + type de contenu
 *               + nonce + horodatage + version + corps
 *
 * Le type de contenu ne s'ajoute PAS quand le corps est vide. Une seule pièce à
 * la mauvaise place, et le serveur rend une erreur d'authentification
 * strictement indiscernable d'une clé fausse : on chercherait le défaut du
 * mauvais côté pendant une soirée. C'est pour cette raison, et pas par goût du
 * détail, que la chaîne est construite par une fonction PURE, testée hors
 * réseau contre des valeurs figées.
 *
 * ─── Le contrôle de la réponse ───────────────────────────────────────────────
 *
 * Bitstamp signe aussi ce qu'il renvoie (`X-Server-Auth-Signature`), et ce
 * connecteur le VÉRIFIE. Sans ce contrôle, n'importe quel intermédiaire
 * pourrait servir un historique de son choix : le relevé produit le recopierait
 * fidèlement, bandeau compris, et aurait l'air parfaitement en règle.
 */

const crypto = require('node:crypto');
const history = require('../../history');
const releve = require('../../releve-reconstitue');

const ID = 'bitstamp';
const NOM = 'Bitstamp';

const HOTE = 'www.bitstamp.net';
const BASE = `https://${HOTE}`;
const VERSION = 'v2';
const TYPE_CONTENU = 'application/x-www-form-urlencoded';

const CHAMP_CLE = 'apiKey';
const CHAMP_SECRET = 'apiSecret';
const CHAMP_HISTORIQUE = 'historique';

const DELAI_MS = 30_000;
/** Bitstamp plafonne `limit` à 1000 ; on reste dessous, page par page. */
const PAR_PAGE = 500;
/** Borne de pagination : au-delà, c'est une boucle, pas un historique. */
const PAGES_MAX = 60;
/** Politesse : Bitstamp limite le débit, et une rafale coûte un 429. */
const PAUSE_PAGE_MS = 350;

/**
 * Les types d'opération de `user_transactions`, tels que Bitstamp les numérote.
 *
 * Traduits ici pour que le relevé soit lisible par quelqu'un qui ne connaît pas
 * la nomenclature — c'est un libellé ajouté À CÔTÉ du code brut, jamais à sa
 * place : le code reste dans le document, et un type inconnu s'affiche tel quel
 * plutôt que de disparaître derrière un « autre ».
 */
const TYPES = {
  0: 'Dépôt',
  1: 'Retrait',
  2: 'Opération de marché',
  14: 'Transfert entre sous-comptes',
  25: 'Échange de devises',
  27: 'Transfert de compte',
  28: 'Transfert de compte',
};

// ---------------------------------------------------------------------------
// Signature — fonctions pures, testables hors réseau
// ---------------------------------------------------------------------------

/**
 * Un nonce conforme : 36 caractères minuscules, unique dans une fenêtre de
 * 150 secondes.
 *
 * `randomUUID()` rend exactement 36 caractères, tirets compris, et déjà en
 * minuscules. Ce n'est pas une coïncidence heureuse qu'on exploite en silence :
 * la longueur est vérifiée juste après, parce qu'un nonce de 35 caractères
 * serait refusé par le serveur avec un message qui parle d'authentification.
 */
function nonce() {
  const valeur = crypto.randomUUID();
  if (valeur.length !== 36) {
    throw new Error(`nonce ${NOM} de longueur ${valeur.length} : 36 caractères attendus.`);
  }
  return valeur;
}

/**
 * La chaîne signée, dans l'ordre exact exigé par Bitstamp.
 *
 * @param {object} p
 * @param {string} p.cle           clé d'API
 * @param {string} p.verbe         « POST », en majuscules
 * @param {string} p.hote          sans protocole ni barre finale
 * @param {string} p.chemin        commence par « / »
 * @param {string} [p.requete]     la chaîne de requête, SANS le « ? »
 * @param {string} [p.typeContenu] omis quand le corps est vide
 * @param {string} p.nonce
 * @param {string|number} p.horodatage millisecondes UTC
 * @param {string} [p.corps]
 * @returns {string}
 */
function chaineASigner({
  cle, verbe, hote, chemin, requete = '', typeContenu = '', nonce: n, horodatage, corps = '',
}) {
  // Le type de contenu ne s'ajoute PAS quand le corps est vide : l'inclure
  // quand même donne une signature refusée, avec un message qui accuse la clé.
  const type = corps ? typeContenu : '';
  return `BITSTAMP ${cle}${verbe}${hote}${chemin}${requete}${type}${n}${horodatage}${VERSION}${corps}`;
}

/** HMAC-SHA256 en hexadécimal MAJUSCULE — Bitstamp refuse les minuscules. */
function signer(secret, chaine) {
  return crypto.createHmac('sha256', String(secret)).update(chaine, 'utf8').digest('hex').toUpperCase();
}

/**
 * Les cinq en-têtes d'un appel signé, plus le type de contenu quand il y a un
 * corps.
 *
 * @returns {{entetes: object, nonce: string, horodatage: string}}
 */
function entetes({ cle, secret, verbe, chemin, requete = '', corps = '', nonce: n = nonce(), horodatage = Date.now() }) {
  const estampille = String(horodatage);
  const signature = signer(
    secret,
    chaineASigner({
      cle, verbe, hote: HOTE, chemin, requete, typeContenu: TYPE_CONTENU, nonce: n, horodatage: estampille, corps,
    })
  );

  // Nommé `enTetes` et pas `entetes` : une constante du nom de la fonction qui
  // la contient masquerait la fonction dans son propre corps, et le jour où
  // quelqu'un ajoute un appel récursif ici, il obtient « entetes is not a
  // function » sur une ligne parfaitement innocente.
  const enTetes = {
    'X-Auth': `BITSTAMP ${cle}`,
    'X-Auth-Signature': signature,
    'X-Auth-Nonce': n,
    'X-Auth-Timestamp': estampille,
    'X-Auth-Version': VERSION,
  };
  if (corps) enTetes['Content-Type'] = TYPE_CONTENU;
  return { entetes: enTetes, nonce: n, horodatage: estampille };
}

/**
 * La signature que le serveur doit avoir posée sur sa réponse.
 *
 * Même clé, autre chaîne : nonce + horodatage de la REQUÊTE, puis le type de
 * contenu et le corps de la RÉPONSE.
 */
function signatureAttendueDeLaReponse({ secret, nonce: n, horodatage, typeContenu, corps }) {
  return signer(secret, `${n}${horodatage}${typeContenu}${corps}`);
}

// ---------------------------------------------------------------------------
// Lecture de l'historique
// ---------------------------------------------------------------------------

/**
 * La clé et le secret, débarrassés de ce que le copier-coller emporte.
 *
 * ─── Le premier grief du 12/08/2026 : « Wrong API key format » ───────────────
 *
 * Bitstamp ne dit pas « clé inconnue » mais « mauvais FORMAT » : la valeur
 * reçue n'a pas la forme d'une clé, avant même qu'on cherche à qui elle
 * appartient. La cause de loin la plus banale est un espace ou un retour à la
 * ligne emporté en recopiant la valeur depuis la page de Bitstamp — invisible
 * à l'écran, fatal dans un en-tête.
 *
 * On les retire donc ici, plutôt que de laisser quelqu'un chercher pendant une
 * soirée un caractère qu'il ne peut pas voir.
 *
 * ⚠ Et rien d'autre n'est nettoyé. Une clé tronquée ou un secret coupé en deux
 * ne se réparent pas : les « arranger » ferait signer une valeur inventée, et
 * le serveur répondrait exactement la même chose qu'avec une clé fausse.
 */
function identifiants(config) {
  const cle = String(config?.[CHAMP_CLE] ?? '').trim();
  const secret = String(config?.[CHAMP_SECRET] ?? '').trim();
  const manquants = [];
  if (!cle) manquants.push('clé d\'API');
  if (!secret) manquants.push('secret d\'API');
  if (manquants.length) throw new Error(`Identifiants ${NOM} manquants : ${manquants.join(', ')}.`);
  return { cle, secret };
}

/** Conservé pour les appels qui n'ont besoin que du contrôle de présence. */
function exigerIdentifiants(config) {
  identifiants(config);
}

/**
 * Les options remises à `fetch` pour un appel signé.
 *
 * ─── LE DÉFAUT QUI A FAIT ÉCHOUER LE PREMIER ESSAI RÉEL (12/08/2026, 21:44) ──
 *
 * Bitstamp a répondu « Content-Type header should not be present » alors que ce
 * connecteur n'en posait aucun. Il ne se trompait pas : l'en-tête était bien
 * là, et c'est `fetch` qui l'avait ajouté.
 *
 * La règle est dans la spécification de `fetch`, et elle ne souffre aucune
 * exception : un corps de type CHAÎNE se voit attribuer d'office le type
 * « text/plain;charset=UTF-8 ». La chaîne VIDE est une chaîne. Un `body: ''`
 * part donc avec un type de contenu que la signature n'a pas pris en compte —
 * et le serveur, qui exige que la requête corresponde à ce qui a été signé,
 * refuse. Sur `/balance/`, appelé sans aucun paramètre, c'est-à-dire à la
 * toute première vérification de la clé.
 *
 * Le lot 20 avait bien écrit un test « le Content-Type n'est posé que s'il y a
 * un corps ». Il disait vrai, et il ne pouvait rien voir : il examinait NOS
 * en-têtes, pas ceux que la couche réseau ajoute après nous. D'où cette
 * fonction, et le test qui mesure cette fois ce que le serveur REÇOIT.
 *
 * @param {{entetes: object, corps: string, signal?: AbortSignal}} p
 */
function optionsDeRequete({ entetes: enTetes, corps, signal }) {
  return {
    method: 'POST',
    headers: enTetes,
    // Pas de corps DU TOUT quand il n'y a rien à envoyer : « une chaîne vide »
    // et « aucun corps » ne coûtent pas le même prix, et toute la différence
    // est un en-tête qu'on n'a pas signé.
    ...(corps ? { body: corps } : {}),
    ...(signal ? { signal } : {}),
  };
}

/**
 * Un appel signé, et le contrôle de ce qui revient.
 *
 * @param {object} config
 * @param {string} chemin  ex. « /api/v2/user_transactions/ »
 * @param {object} [parametres] corps du POST
 */
async function appel(config, chemin, parametres = {}) {
  const { cle, secret } = identifiants(config);
  const corps = new URLSearchParams(
    Object.entries(parametres).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();

  const { entetes: enTetes, nonce: n, horodatage } = entetes({
    cle, secret, verbe: 'POST', chemin, corps,
  });

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);
  let reponse;
  let texte;
  try {
    reponse = await fetch(
      `${BASE}${chemin}`,
      optionsDeRequete({ entetes: enTetes, corps, signal: controleur.signal })
    );
    texte = await reponse.text();
  } finally {
    clearTimeout(minuteur);
  }

  if (reponse.status === 401 || reponse.status === 403) {
    throw new Error(messageDeRefus(texte));
  }
  if (!reponse.ok) {
    throw new Error(`${NOM} a répondu ${reponse.status} sur ${chemin}.`);
  }

  // Le serveur signe sa réponse : on le vérifie. Une réponse non signée est
  // refusée aussi — c'est le cas d'un intermédiaire qui répond à la place de
  // Bitstamp, et il n'a aucune raison d'être toléré.
  const attendue = signatureAttendueDeLaReponse({
    secret,
    nonce: n,
    horodatage,
    typeContenu: reponse.headers.get('content-type') || '',
    corps: texte,
  });
  const recue = reponse.headers.get('x-server-auth-signature') || '';
  if (recue.toUpperCase() !== attendue) {
    throw new Error(
      `La réponse de ${NOM} n'est pas signée comme elle devrait l'être. crabe ne s'en sert pas : `
        + 'quelque chose répond à la place de Bitstamp, ou votre secret d\'API n\'est pas le bon.'
    );
  }

  let donnees;
  try {
    donnees = JSON.parse(texte);
  } catch {
    throw new Error(`${NOM} a répondu autre chose que du JSON sur ${chemin}.`);
  }
  if (donnees && !Array.isArray(donnees) && donnees.status === 'error') {
    throw new Error(messageDeRefus(texte));
  }
  return donnees;
}

/**
 * Bitstamp reproche-t-il la CLÉ, ou la REQUÊTE ?
 *
 * ─── Pourquoi cette distinction existe ───────────────────────────────────────
 *
 * Le premier essai réel a produit, sur un même compte et à quarante minutes
 * d'intervalle, « API key not found » puis « Content-Type header should not be
 * present ». Le premier reproche est pour l'utilisateur — sa clé n'était pas
 * encore activée. Le second ne l'est pas du tout : la clé était devenue bonne,
 * et c'est crabe qui envoyait une requête mal formée.
 *
 * Or les deux sortaient sous le même message, « Bitstamp a refusé la clé d'API,
 * trois choses à vérifier ». Autrement dit, crabe envoyait quelqu'un vérifier
 * trois fois de suite une clé qui n'avait plus rien à se reprocher. Un message
 * d'erreur qui accuse la mauvaise pièce coûte plus cher que pas de message.
 *
 * @returns {'cle'|'requete'}
 */
function natureDuRefus(detail) {
  const texte = String(detail || '');
  // Aucun en-tête d'authentification reçu : c'est la requête, même si le grief
  // prononce le mot « key ».
  if (/missing key, ?signature and nonce/i.test(texte)) return 'requete';
  // Ce qui met la clé en cause, nommément — le compte peut y faire quelque chose.
  if (/\bkey\b|permission|signature check|not authorized/i.test(texte)) return 'cle';
  // Ce qui met la forme de la demande en cause — le compte n'y peut rien.
  if (/header|nonce|timestamp|content-?type/i.test(texte)) return 'requete';
  return 'cle';
}

/**
 * Le message d'un refus, écrit pour quelqu'un qui n'a pas la documentation
 * ouverte à côté.
 *
 * Quand la clé est en cause, les trois causes fréquentes sont dites nommément,
 * parce qu'aucune ne se devine : une clé neuve n'est pas activée tant qu'on n'a
 * pas cliqué le lien reçu par courriel, une permission peut manquer, et une
 * restriction par IP posée depuis le poste de l'utilisateur ne couvre pas
 * l'adresse par laquelle sort le serveur.
 */
function messageDeRefus(reponseBrute) {
  const texte = String(reponseBrute || '');
  const detail = /"reason"\s*:\s*"([^"]{1,200})"/.exec(texte)?.[1];

  if (natureDuRefus(detail) === 'requete') {
    return (
      `${NOM} a bien reconnu votre clé d'API, mais il a refusé la demande que crabe lui a `
      + `envoyée — ${detail}. Il n'y a rien à corriger de votre côté : ni votre clé, ni votre `
      + 'compte ne sont en cause. C\'est un défaut de crabe, et il faut le signaler.'
    );
  }

  return (
    `${NOM} a refusé la clé d'API${detail ? ` — ${detail}` : ''}. Trois choses à vérifier : `
    + 'que la clé a bien été activée par le lien reçu par courriel après sa création — c\'est '
    + 'l\'oubli le plus fréquent, et une clé non activée est vue comme inexistante ; '
    + 'que les permissions de lecture du solde et des opérations sont cochées ; '
    + 'et, si vous avez posé une restriction par adresse IP, qu\'elle vise bien l\'adresse '
    + 'publique par laquelle sort votre installation de crabe.'
  );
}

/** « 2026-07-12 08:11:12.000000 » → « 2026-07-12 », ou null. */
function dateIso(valeur) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(valeur ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Une opération de l'API ramenée aux colonnes du relevé.
 *
 * ⚠ Rien n'est calculé ni converti. Les montants sont recopiés tels quels, avec
 * le nom de leur devise, et deux montants ne sont jamais additionnés : un
 * relevé qui ferait ses propres totaux serait un relevé qu'on ne peut plus
 * confronter au compte.
 */
function operationLisible(brute) {
  const ignorees = new Set(['id', 'datetime', 'type', 'order_id', 'fee']);
  const montants = Object.entries(brute || {})
    .filter(([cle, valeur]) => !ignorees.has(cle) && valeur !== null && valeur !== undefined)
    // Un champ de montant nul n'apprend rien et remplit la colonne : Bitstamp
    // rend TOUTES les devises du compte à chaque ligne, la plupart à zéro.
    .filter(([, valeur]) => !/^-?0(\.0+)?$/.test(String(valeur)))
    .map(([cle, valeur]) => `${valeur} ${cle.toUpperCase()}`)
    .join('  ');

  const code = String(brute?.type ?? '');
  return {
    date: dateIso(brute?.datetime) || String(brute?.datetime ?? ''),
    reference: String(brute?.id ?? ''),
    nature: TYPES[code] ? `${TYPES[code]} (${code})` : `Type ${code}`,
    montants: montants || '—',
    frais: brute?.fee !== undefined && brute?.fee !== null ? String(brute.fee) : '',
  };
}

/** Les colonnes du relevé, dans l'ordre d'affichage. */
const COLONNES = [
  { cle: 'date', titre: 'Date' },
  { cle: 'reference', titre: 'Référence' },
  { cle: 'nature', titre: 'Nature' },
  { cle: 'montants', titre: 'Montants communiqués' },
  { cle: 'frais', titre: 'Frais' },
];

/**
 * L'historique d'opérations, page par page — et la fenêtre appliquée ICI.
 *
 * ─── POURQUOI `since_timestamp` N'EST PLUS ENVOYÉ DU TOUT (lot 27) ───────────
 *
 * Ce connecteur passait la borne basse à Bitstamp par `since_timestamp`, en
 * MILLISECONDES. Bitstamp les attend en SECONDES, et répondait
 * « Failed to convert since_timestamp parameter. » — le message exact que l'utilisateur
 * a vu. Le test de connexion, lui, ne construit pas ce paramètre : la clé était
 * donc déclarée bonne, et la vraie récupération échouait juste après. Le défaut
 * date de l'écriture du connecteur au lot 19 ; il n'est apparu qu'après le lot
 * 23, parce que le tout premier passage (« depuis la dernière récupération »,
 * rien encore récupéré) ne pose aucune borne et ne construisait donc rien.
 *
 * Mais convertir en secondes ne suffisait pas, et c'est le point important.
 * Mesuré le 13/08/2026 contre le compte réel : Bitstamp refuse toute borne de
 * plus de 30 jours — « since_timestamp parameter must be higher than … », où le
 * nombre cité vaut exactement « maintenant moins 30 jours ». Or les fenêtres de
 * crabe tombent toujours sur un 1er janvier (voir connectors/history.js) : elles
 * ont plus de 30 jours onze mois sur douze. Le paramètre est donc structurellement
 * inutilisable ici — le garder en le corrigeant n'aurait fait que remplacer un
 * refus par un autre, onze mois par an.
 *
 * La fenêtre est donc appliquée par crabe, sur les dates que Bitstamp renvoie.
 * Coût : l'historique est relu depuis le début à chaque exécution. C'est borné
 * (PAGES_MAX × PAR_PAGE) et sans conséquence — les relevés déjà déposés portent
 * un identifiant connu et ne sont pas reproduits.
 *
 * Le tri reste `asc` : avec une pagination par `offset`, c'est le seul ordre où
 * une opération qui arrive pendant la lecture ne décale pas les pages suivantes.
 *
 * @param {object} config
 * @param {Date|null} depuis borne basse, ou `null` pour tout l'historique
 * @param {(msg: string) => void} [log]
 */
async function listerOperations(config, depuis, log = () => {}) {
  const operations = [];
  // Comparaison de jours en « AAAA-MM-JJ », comme partout ailleurs dans ce
  // connecteur : les dates de Bitstamp arrivent en texte, les convertir en
  // objets pour les recomparer n'ajouterait qu'un fuseau à se tromper.
  const borne = depuis ? depuis.toISOString().slice(0, 10) : null;
  let lues = 0;

  for (let page = 0; page < PAGES_MAX; page++) {
    const lot = await appel(config, '/api/v2/user_transactions/', {
      limit: PAR_PAGE,
      sort: 'asc',
      offset: page * PAR_PAGE,
    });
    const lignes = Array.isArray(lot) ? lot : [];
    lues += lignes.length;
    for (const ligne of lignes) {
      const jour = dateIso(ligne?.datetime);
      // Une opération SANS date exploitable est gardée : c'est `fetchInvoices`
      // qui la compte et le signale. L'écarter en silence ici la ferait
      // disparaître sans que personne ne l'apprenne jamais.
      if (borne && jour && jour < borne) continue;
      operations.push(ligne);
    }
    log(
      `${ID} : page ${page + 1} — ${lignes.length} opération(s) lue(s), `
        + `${operations.length} retenue(s) dans la fenêtre`
    );
    if (lignes.length < PAR_PAGE) return operations;
    await new Promise((r) => setTimeout(r, PAUSE_PAGE_MS));
  }

  log(
    `${ID} : ${PAGES_MAX} pages lues (${lues} opération(s)) sans atteindre la fin de `
      + "l'historique — le reste sera repris à la prochaine exécution"
  );
  return operations;
}

/** La borne basse de la fenêtre, d'après le réglage d'historique du compte. */
function borneHistorique(config, ctx) {
  return history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant qu'un
    // plancher protège l'existant.
    plafondMois: ctx?.conservationMois || 0,
  });
}

/** L'identifiant distant d'un relevé mensuel — stable, et lisible. */
function remoteIdDuMois(mois) {
  return `${ID}-releve-${mois}`;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : la clé est acceptée, et on dit combien d'opérations
 * l'API rend sur la première page. Aucun document n'est produit.
 */
async function test(config, ctx = {}) {
  exigerIdentifiants(config);
  const solde = await appel(config, '/api/v2/balance/');
  // `balance` rend un objet de devises : sa seule présence prouve que la clé
  // porte bien la permission de lecture du solde.
  const devises = Object.keys(solde || {}).length;
  const premieres = await appel(config, '/api/v2/user_transactions/', { limit: 1, sort: 'desc' });
  const derniere = Array.isArray(premieres) && premieres[0] ? dateIso(premieres[0].datetime) : null;

  return {
    ok: true,
    accountId: null,
    invoiceCount: undefined,
    message:
      `Clé d'API acceptée (${devises} ligne(s) de solde lue(s))`
      + (derniere
        ? `, dernière opération le ${derniere}. crabe produira un relevé par mois civil terminé.`
        : '. Aucune opération dans l\'historique pour l\'instant.'),
  };
}

/**
 * Produit un relevé reconstitué par mois civil révolu.
 *
 * Idempotent : le relevé du mois M porte toujours le même identifiant, il n'est
 * donc produit qu'une fois. C'est aussi pourquoi le mois en cours est écarté —
 * un document incomplet ne serait jamais remplacé.
 */
async function fetchInvoices(config, ctx = {}) {
  exigerIdentifiants(config);
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  const fenetre = borneHistorique(config, ctx);
  log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);

  const brutes = await listerOperations(config, fenetre.from, log);
  const sansDate = brutes.filter((o) => !dateIso(o?.datetime)).length;
  if (sansDate) {
    // Une opération sans date ne peut être rangée dans aucun mois. Le taire
    // ferait disparaître des lignes d'un document qui prétend être un relevé.
    log(
      `${ID} : ${sansDate} opération(s) sans date exploitable — elles ne figurent dans aucun `
        + 'relevé, signalez-le'
    );
  }

  const mois = releve.parMoisRevolus(brutes, (o) => dateIso(o?.datetime));
  log(`${ID} : ${brutes.length} opération(s), ${mois.length} mois civil(s) terminé(s)`);

  // Preuve d'accès (lot 31) : l'API a accepté la requête signée et rendu
  // l'historique des opérations — c'est cette lecture qui autorise à conclure
  // « aucun nouveau relevé » quand tous les mois sont déjà connus.
  ctx.preuveDeListe?.({
    session: 'clé d\'API acceptée par Bitstamp',
    liste: 'historique des opérations (API user_transactions)',
    elements: brutes.length,
  });

  const documents = [];
  for (const groupe of mois) {
    const remoteId = remoteIdDuMois(groupe.mois);
    if (connus.has(remoteId)) continue;

    const buffer = releve.construire({
      service: NOM,
      compte: null,
      periode: { du: groupe.du, au: groupe.au },
      colonnes: COLONNES,
      operations: groupe.operations.map(operationLisible),
      mentions: [
        'Source : API Bitstamp v2, POST /api/v2/user_transactions/',
        'Bitstamp n\'émet aucune facture : ce relevé est la mise en forme de votre',
        'historique d\'opérations, produite par crabe.',
      ],
    });

    documents.push({
      remoteId,
      filename: releve.nomFichier({ service: NOM, du: groupe.du, au: groupe.au }),
      issuedOn: groupe.au,
      buffer,
    });
  }

  log(`${ID} : ${documents.length} relevé(s) mensuel(s) produit(s)`);
  return documents;
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  chaineASigner,
  signer,
  entetes,
  optionsDeRequete,
  identifiants,
  signatureAttendueDeLaReponse,
  nonce,
  dateIso,
  operationLisible,
  messageDeRefus,
  natureDuRefus,
  remoteIdDuMois,
  borneHistorique,
  COLONNES,
  TYPES,
  HOTE,
  BASE,
  VERSION,
  TYPE_CONTENU,
};
