'use strict';

/**
 * Connecteur PayPal — API officielle, et relevé RECONSTITUÉ.
 *
 * ─── Pourquoi l'API et pas le site ───────────────────────────────────────────
 *
 * Le lot 18 avait arrêté le scraping devant DataDome, et il avait raison. Le
 * lot 19 a mesuré que ce n'était pas la même porte : trois appels côte à côte,
 * depuis le conteneur, le 12/08/2026 —
 *
 *   POST api-m.paypal.com/v1/oauth2/token (identifiants bidons)
 *     -> 401 application/json {"error":"invalid_client"}, aucun DataDome
 *   GET  api-m.paypal.com/v1/reporting/transactions (sans jeton)
 *     -> 401 {"name":"AUTHENTICATION_FAILURE"} — la route existe
 *   GET  www.paypal.com/signin
 *     -> 403 text/html, en-tête « x-datadome: protected »
 *
 * DataDome garde le SITE, pas l'API.
 *
 * ─── Ce que l'API donne, et ce qu'elle ne donne pas ──────────────────────────
 *
 * Des lignes d'opérations. Pas de factures, pas de reçus en PDF : il n'existe
 * aucune route de document pour ce qu'un particulier REÇOIT. Un document ne
 * peut donc sortir d'ici que par le relevé reconstitué
 * (`connectors/releve-reconstitue.js`), avec son bandeau en tête de chaque page
 * qui dit que PayPal ne l'a pas émis.
 *
 * ─── Les trois contraintes, et pourquoi elles sont dans le code ──────────────
 *
 *   1. **compte PROFESSIONNEL exigé.** L'option « Transaction Search » ne se
 *      coche que sur une application REST d'un compte professionnel. Un compte
 *      personnel n'y a pas accès — et le message d'erreur de PayPal, lui, ne le
 *      dit pas : il parle de permission, ce qui ressemble à un mauvais
 *      identifiant. Le connecteur le traduit.
 *   2. **fenêtre de 31 JOURS au plus par appel.** Une seule requête sur un an
 *      rend une erreur, pas un résultat partiel : l'historique se lit mois par
 *      mois, en bouclant.
 *   3. **trois ans d'historique au plus.** Le réglage « depuis toujours » de
 *      crabe ne peut pas être tenu au-delà. Le connecteur le DIT dans son
 *      journal plutôt que de laisser croire qu'il a tout repris — c'est
 *      exactement le genre de silence qui fait découvrir un trou trois ans plus
 *      tard.
 */

const applog = require('../../../applog');
const history = require('../../history');
const releve = require('../../releve-reconstitue');

const ID = 'paypal';
const NOM = 'PayPal';

const BASE = 'https://api-m.paypal.com';
/**
 * Le bac à sable de PayPal. Il ne sert JAMAIS à récupérer quoi que ce soit :
 * il ne sert qu'à répondre à une question, après un refus, et une seule —
 * « ces identifiants-là seraient-ils ceux de l'environnement d'essai ? ».
 */
const BASE_ESSAI = 'https://api-m.sandbox.paypal.com';
const SCOPE = 'https://uri.paypal.com/services/reporting/search/read';

const CHAMP_ID = 'clientId';
const CHAMP_SECRET = 'clientSecret';
const CHAMP_HISTORIQUE = 'historique';

/**
 * L'identifiant de compte affiché et rangé sur le disque.
 *
 * Sans lui, crabe déduisait l'identifiant de la configuration — donc le Client
 * ID d'application : 80 caractères illisibles, affichés en clair comme libellé
 * de compte et posés en nom de dossier. L'API ne donne pas mieux : mesuré le
 * 18/08/2026 avec un jeton `client_credentials` réel, `/v1/identity/oauth2/
 * userinfo` (deux formes) répond 200 mais ne porte que `user_id`/`sub`, jamais
 * l'adresse du compte ; et le champ `payer` des transactions décrit les
 * CORRESPONDANTS, pas le titulaire. Un libellé stable et lisible vaut mieux
 * qu'un identifiant technique : les relevés reconstitués vivent sous
 * `releves-paypal`.
 */
const COMPTE = 'releves-paypal';

const DELAI_MS = 45_000;
/**
 * Le diagnostic « ces identifiants sont-ils ceux du bac à sable ? » est un
 * confort, pas une étape : il a droit à dix secondes, et s'il ne répond pas
 * dans ce délai on rend le message d'origine plutôt que de faire attendre
 * quelqu'un pour une phrase.
 */
const DELAI_DIAGNOSTIC_MS = 10_000;
/** La borne de PayPal : 31 jours par appel, pas un de plus. */
const JOURS_PAR_FENETRE = 31;
/** Et sa borne d'historique : trois ans, quelle que soit la demande. */
const ANNEES_MAX = 3;
/** Pagination du rapport : 500 lignes par page, plafond de l'API. */
const PAR_PAGE = 500;
/** Politesse, et garde-fou contre un rapport qui ne se termine jamais. */
const PAGES_MAX = 40;
const PAUSE_MS = 250;

/** Les colonnes du relevé, dans l'ordre d'affichage. */
const COLONNES = [
  { cle: 'date', titre: 'Date' },
  { cle: 'reference', titre: 'Référence' },
  { cle: 'nature', titre: 'Nature' },
  { cle: 'correspondant', titre: 'Correspondant' },
  { cle: 'montant', titre: 'Montant' },
  { cle: 'frais', titre: 'Frais' },
];

// ---------------------------------------------------------------------------
// Fenêtres — fonctions pures, testables hors réseau
// ---------------------------------------------------------------------------

/** Une date décalée de `jours`, en UTC, sans toucher à l'original. */
function decaler(date, jours) {
  const copie = new Date(date.getTime());
  copie.setUTCDate(copie.getUTCDate() + jours);
  return copie;
}

/**
 * Découpe une période en fenêtres de 31 jours au plus.
 *
 * ⚠ Les fenêtres sont JOINTIVES et ne se recouvrent pas : chacune commence
 * exactement là où la précédente s'arrête. Un recouvrement ferait apparaître
 * deux fois les opérations de la charnière dans le relevé du mois — et un
 * relevé qui compte deux fois la même opération est pire qu'un relevé absent.
 *
 * @param {Date} du
 * @param {Date} au
 * @returns {Array<{du: Date, au: Date}>} vide si `du` est après `au`
 */
function fenetresDe31Jours(du, au) {
  const fenetres = [];
  if (!(du instanceof Date) || !(au instanceof Date) || du.getTime() > au.getTime()) return fenetres;

  let debut = new Date(du.getTime());
  // Borne de boucle : une période de plus de trois ans ne peut pas produire
  // plus de fenêtres que ça, et une date aberrante ne fera pas tourner le
  // serveur indéfiniment.
  for (let i = 0; i < 512 && debut.getTime() <= au.getTime(); i++) {
    const fin = decaler(debut, JOURS_PAR_FENETRE);
    fenetres.push({ du: debut, au: fin.getTime() > au.getTime() ? new Date(au.getTime()) : fin });
    debut = fin;
  }
  return fenetres;
}

/**
 * La borne basse réellement atteignable, et ce qu'il faut en dire.
 *
 * Rend toujours une date : `null` (« tout l'historique ») n'existe pas ici,
 * PayPal s'arrête à trois ans. Quand le réglage du compte demande davantage, le
 * `message` le dit — il part dans le journal de l'exécution, à la vue de
 * l'utilisateur.
 *
 * @returns {{du: Date, au: Date, tronque: boolean, message: string|null, raison: string}}
 */
function periodeAtteignable(config, ctx = {}, maintenant = new Date()) {
  const fenetre = history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    maintenant,
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant qu'un
    // plancher protège l'existant.
    plafondMois: ctx?.conservationMois || 0,
  });

  const au = fenetre.to instanceof Date ? fenetre.to : new Date(maintenant.getTime());
  const plancher = new Date(au.getTime());
  plancher.setUTCFullYear(plancher.getUTCFullYear() - ANNEES_MAX);
  // Un jour de marge en dedans de la borne : posé à la seconde exacte des
  // 36 mois, start_date franchissait la limite pendant le trajet de la
  // requête et PayPal rendait 400 (mesuré le 18/08/2026 à 22:14, valeur
  // 2023-08-18T20:14:58Z rejetée alors que le format était propre).
  plancher.setUTCDate(plancher.getUTCDate() + 1);

  const demande = fenetre.from;
  const tronque = !demande || demande.getTime() < plancher.getTime();
  const du = tronque ? plancher : demande;

  return {
    du,
    au,
    tronque,
    raison: fenetre.raison,
    message: tronque
      ? `${NOM} ne conserve que ${ANNEES_MAX} ans d'historique par cette voie : la reprise `
        + `commence au ${plancher.toISOString().slice(0, 10)}, même si votre réglage demande `
        + 'davantage.'
      : null,
  };
}

/** La date d'une opération, en ISO, ou `null`. */
function dateIso(operation) {
  const brut = operation?.transaction_info?.transaction_initiation_date
    || operation?.transaction_info?.transaction_updated_date
    || '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(brut).trim());
  return m ? m[1] : null;
}

/** Un montant PayPal (`{value, currency_code}`) recopié tel quel, ou ''. */
function montant(valeur) {
  if (!valeur || valeur.value === undefined || valeur.value === null) return '';
  const devise = valeur.currency_code ? ` ${valeur.currency_code}` : '';
  return `${valeur.value}${devise}`;
}

/**
 * Une opération de l'API ramenée aux colonnes du relevé.
 *
 * Rien n'est calculé : le montant et les frais sont recopiés séparément, avec
 * leur devise, et jamais additionnés. Le nom du correspondant est celui que
 * PayPal communique — un champ vide reste vide plutôt que de devenir
 * « inconnu », qui aurait l'air d'une information.
 */
function operationLisible(brute) {
  const info = brute?.transaction_info || {};
  const payeur = brute?.payer_info || {};
  const nom = payeur?.payer_name?.alternate_full_name
    || [payeur?.payer_name?.given_name, payeur?.payer_name?.surname].filter(Boolean).join(' ')
    || payeur?.email_address
    || '';

  return {
    date: dateIso(brute) || String(info.transaction_initiation_date || ''),
    reference: String(info.transaction_id || ''),
    nature: [info.transaction_event_code, info.transaction_subject, info.transaction_note]
      .filter(Boolean).join(' — ') || String(info.transaction_status || ''),
    correspondant: String(nom),
    montant: montant(info.transaction_amount),
    frais: montant(info.fee_amount),
  };
}

/** L'identifiant distant d'un relevé mensuel — stable, et lisible. */
function remoteIdDuMois(mois) {
  return `${ID}-releve-${mois}`;
}

/** Le refus d'identifiants, quand on ne sait pas encore d'où ils viennent. */
const MESSAGE_IDENTIFIANTS_REFUSES =
  `${NOM} a refusé l'identifiant d'application ou son secret. Vérifiez que vous les avez `
  + 'copiés depuis l\'onglet « Live » de developer.paypal.com, et non depuis « Sandbox » : '
  + 'ce sont deux jeux d\'identifiants différents, et celui de Sandbox ne voit aucune '
  + 'opération réelle. Vérifiez aussi qu\'ils viennent de la MÊME application : un identifiant '
  + 'et un secret dépareillés donnent exactement le même refus.';

/**
 * Le refus d'identifiants QUAND ON A LA PREUVE qu'ils sont ceux du bac à sable.
 *
 * ─── Pourquoi crabe va jusqu'à le vérifier ───────────────────────────────────
 *
 * L'échec réel du 12/08/2026 est celui-ci, et le message d'alors disait déjà
 * « vérifiez l'onglet Live ». Ça n'a pas suffi, et c'est logique : une phrase
 * qui commence par « vérifiez que » demande à l'utilisateur de faire le
 * diagnostic à la place du logiciel. Elle liste des causes possibles là où il
 * attend de savoir laquelle est la sienne.
 *
 * Or cette cause-là est vérifiable, et sans rien demander à personne : les
 * mêmes identifiants sont présentés au bac à sable de PayPal. S'ils y sont
 * acceptés, il n'y a plus de doute — ce sont des identifiants d'essai, et
 * crabe peut le DIRE au lieu de le suggérer.
 *
 * ⚠ Ce second appel n'a lieu QUE si le premier a échoué, et il part chez PayPal
 * lui-même (api-m.sandbox.paypal.com), pas ailleurs. Rien de plus n'en sort que
 * ce qui venait déjà d'être envoyé à api-m.paypal.com une seconde plus tôt.
 */
const MESSAGE_IDENTIFIANTS_SANDBOX =
  `Ce sont vos identifiants d'ESSAI ${NOM}, pas ceux de votre compte réel — crabe vient de le `
  + 'vérifier : ils sont acceptés par le bac à sable de PayPal, et refusés par le compte réel. '
  + 'Les identifiants d\'essai ne voient aucune opération réelle, quelle que soit la suite. '
  + 'Retournez sur developer.paypal.com, basculez l\'interrupteur « Sandbox / Live » sur '
  + '« Live », ouvrez l\'application qui s\'y trouve, et recopiez son identifiant ET son secret '
  + '— les deux, depuis cette fiche-là.';

/**
 * Le message d'un refus, traduit pour quelqu'un qui n'a pas la documentation
 * ouverte à côté.
 *
 * Les deux causes se ressemblent à s'y méprendre dans la réponse de PayPal, et
 * elles n'appellent pas du tout la même action : une clé fausse se corrige, une
 * permission fraîche s'attend. Les confondre fait générer une nouvelle clé pour
 * rien, et recommencer neuf heures d'attente depuis le début.
 */
/**
 * Masque ce qui ressemble à un secret dans un corps de réponse, avant journal.
 * PayPal n'en met pas dans ses erreurs, mais la règle du lot 38 est générale :
 * le corps part ENTIER au journal, jamais un secret avec lui.
 */
function sansSecrets(texte) {
  return String(texte ?? '').replace(
    /"(access_token|refresh_token|client_secret|id_token)"\s*:\s*"[^"]*"/gi,
    '"$1":"<masqué>"'
  );
}

/**
 * Le corps COMPLET d'un refus, au journal technique (lot 38).
 *
 * Le 18/08/2026, le 400 de `/v1/reporting/transactions` a été diagnostiqué
 * deux fois à l'aveugle : le champ `issue` — qui nommait la règle violée
 * (start_date trop ancien) — vivait au-delà des 200 caractères que l'écran
 * garde, et le journal ne recevait que la même phrase courte. Désormais :
 * l'écran garde sa phrase courte, le journal reçoit tout.
 */
function journaliserRefus(statut, corps, ou) {
  applog.error(
    ID,
    `${NOM} a répondu ${statut} sur ${ou} — corps complet : ${sansSecrets(corps) || '(vide)'}`
  );
}

function messageDeRefus(statut, corps) {
  const texte = String(corps || '');
  if (statut === 401 || /invalid_client/i.test(texte)) {
    return MESSAGE_IDENTIFIANTS_REFUSES;
  }
  if (statut === 403 || /NOT_AUTHORIZED|permission|scope/i.test(texte)) {
    return (
      `${NOM} accepte vos identifiants mais refuse la lecture de votre historique. Deux causes, `
      + 'et une seule demande une correction : soit l\'option « Transaction Search » n\'est pas '
      + 'cochée sur votre application (fiche de l\'application, section « Features »), soit elle '
      + 'vient de l\'être — comptez alors jusqu\'à neuf heures avant qu\'elle vaille. Cette route '
      + 'exige par ailleurs un compte PayPal professionnel : sur un compte personnel, l\'option '
      + 'n\'existe pas.'
    );
  }
  // La phrase d'écran finit aussi en run_logs : mêmes règles — courte, et
  // jamais un secret dedans.
  return `${NOM} a répondu ${statut} : ${sansSecrets(texte).slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------

/**
 * En dessous de cette longueur, ce n'est pas une valeur de developer.paypal.com.
 *
 * Les vraies mesurent 80 caractères (l'identifiant) et 64 (le secret), en
 * lettres, chiffres, tirets et traits soulignés. 40 laisse donc une marge
 * confortable : aucune valeur légitime ne peut tomber en dessous, et la
 * confusion que ce seuil attrape — une adresse e-mail, un mot de passe — en est
 * très loin.
 */
const LONGUEUR_MINIMALE = 40;

/**
 * Ce qui a été saisi ressemble-t-il seulement à ce qui est demandé ?
 *
 * ─── L'échec réel que ce contrôle évite de refaire ───────────────────────────
 *
 * Deux tentatives, le 12/08/2026 à 21:06 et le 13/08 à 08:56, le même refus mot
 * pour mot : « PayPal a refusé l'identifiant d'application ou son secret,
 * vérifiez l'onglet Live ». Sondé au lot 23, ce qui était réellement enregistré
 * mesurait 14 et 19 caractères, ponctuation comprise — une adresse e-mail et un
 * mot de passe de compte PayPal, pas les identifiants d'une application REST.
 *
 * PayPal, lui, ne fait aucune différence : il répond
 * `401 {"error":"invalid_client"}` pour une adresse e-mail exactement comme
 * pour un identifiant Sandbox ou une valeur inventée — mesuré côte à côte, les
 * trois donnent la même réponse au caractère près. Aucune information n'arrive
 * donc du réseau qui permette de trancher : la seule chose qui distingue les
 * cas est la FORME de ce qu'on s'apprête à envoyer, et elle se lit avant
 * d'appeler qui que ce soit.
 *
 * D'où ce contrôle en amont : il ne devine pas, il mesure. Et il évite au
 * passage d'envoyer un mot de passe de compte PayPal sur une route qui n'en
 * attend pas.
 *
 * @returns {string|null} le message à afficher, ou `null` si la forme convient
 */
function defautDeForme(cle, secret) {
  const commeUnCompte = (valeur) => valeur.includes('@');
  const tropCourt = (valeur) => valeur.length < LONGUEUR_MINIMALE;

  if (!commeUnCompte(cle) && !commeUnCompte(secret) && !tropCourt(cle) && !tropCourt(secret)) {
    return null;
  }

  const constat = commeUnCompte(cle) || commeUnCompte(secret)
    ? 'Ce qui a été saisi ressemble à l\'adresse e-mail et au mot de passe de votre compte '
      + 'PayPal.'
    : `Ce qui a été saisi est bien trop court : ${cle.length} et ${secret.length} caractères.`;

  return (
    `${constat} Ce n'est pas ce que cette page attend, et ce n'est pas de votre faute : les `
    + 'deux valeurs demandées ici ne sont ni votre adresse e-mail, ni votre mot de passe. Ce '
    + 'sont deux très longues suites de lettres et de chiffres — environ 80 caractères pour '
    + 'l\'identifiant, 64 pour le secret — qui n\'existent pas tant que vous ne les avez pas '
    + 'créées. Pour les obtenir : connectez-vous sur developer.paypal.com, ouvrez « Apps & '
    + 'Credentials », basculez l\'interrupteur en haut de la page sur « Live », puis « Create '
    + 'App ». La fiche de l\'application affiche alors l\'identifiant, et le secret sous « Secret '
    + 'key ». Il faut aussi y cocher « Transaction Search », dans « Features ». Et il faut un '
    + `compte ${NOM} professionnel : sur un compte personnel, cette option n'existe pas.`
  );
}

/**
 * L'identifiant et le secret, débarrassés de leurs espaces de bord, et vérifiés.
 *
 * Un identifiant d'application PayPal fait quatre-vingts caractères : il se
 * recopie forcément au presse-papiers, et un retour à la ligne emporté au
 * passage se voit d'autant moins qu'il est au bout d'une longue valeur. Le
 * refus qui en découle est le même que celui d'un secret faux.
 */
function identifiants(config) {
  const cle = String(config?.[CHAMP_ID] ?? '').trim();
  const secret = String(config?.[CHAMP_SECRET] ?? '').trim();
  const manquants = [];
  if (!cle) manquants.push('identifiant d\'application');
  if (!secret) manquants.push('secret d\'application');
  if (manquants.length) throw new Error(`Identifiants ${NOM} manquants : ${manquants.join(', ')}.`);

  const defaut = defautDeForme(cle, secret);
  if (defaut) throw new Error(defaut);

  return { cle, secret };
}

function exigerIdentifiants(config) {
  identifiants(config);
}

async function avecDelai(fabrique) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);
  try {
    return await fabrique(controleur.signal);
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Une demande de jeton adressée à une base donnée.
 *
 * Ne lève pas : elle rend ce qui s'est passé. C'est ce qui permet de la poser
 * deux fois — une fois pour de bon, une fois pour comprendre.
 *
 * @returns {Promise<{ok: boolean, statut: number, texte: string}>}
 */
async function demanderJeton(base, cle, secret, delaiMs = DELAI_MS) {
  const basic = Buffer.from(`${cle}:${secret}`).toString('base64');
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delaiMs);
  try {
    const reponse = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      signal: controleur.signal,
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
    });
    return { ok: reponse.ok, statut: reponse.status, texte: await reponse.text() };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Ces identifiants sont-ils ceux du bac à sable ?
 *
 * Appelée UNIQUEMENT après un refus du compte réel, et son résultat ne sert
 * qu'à choisir un message. Une panne de ce diagnostic (réseau coupé, PayPal
 * indisponible) ne doit jamais remplacer l'erreur d'origine par une erreur de
 * diagnostic : dans le doute, elle répond « non » et on garde le message
 * prudent.
 */
async function identifiantsDEssai(cle, secret) {
  try {
    const essai = await demanderJeton(BASE_ESSAI, cle, secret, DELAI_DIAGNOSTIC_MS);
    return essai.ok;
  } catch {
    return false;
  }
}

/** Un jeton d'accès, par `client_credentials`. */
async function jeton(config) {
  const { cle, secret } = identifiants(config);
  const reponse = await demanderJeton(BASE, cle, secret);

  if (!reponse.ok) {
    journaliserRefus(reponse.statut, reponse.texte, '/v1/oauth2/token');
    // Un refus d'identifiants, et seulement celui-là, vaut la peine d'être
    // instruit : une permission manquante n'a rien à voir avec le bac à sable,
    // et l'y chercher ferait perdre du temps à tout le monde.
    if (reponse.statut === 401 || /invalid_client/i.test(reponse.texte)) {
      if (await identifiantsDEssai(cle, secret)) throw new Error(MESSAGE_IDENTIFIANTS_SANDBOX);
    }
    throw new Error(messageDeRefus(reponse.statut, reponse.texte));
  }

  let donnees;
  try {
    donnees = JSON.parse(reponse.texte);
  } catch {
    throw new Error(`${NOM} a répondu autre chose que du JSON en délivrant le jeton.`);
  }
  if (!donnees?.access_token) {
    throw new Error(`${NOM} n'a pas délivré de jeton d'accès malgré une réponse en succès.`);
  }
  return donnees.access_token;
}

/**
 * Les opérations d'une fenêtre de 31 jours, toutes pages comprises.
 *
 * ⚠ Les bornes sont envoyées en ISO avec fuseau explicite (`…Z`) : PayPal
 * refuse une date sans fuseau, et l'erreur qu'il rend parle de format, pas de
 * fuseau.
 */
async function operationsDeLaFenetre(acces, du, au, log = () => {}) {
  const sortie = [];

  for (let page = 1; page <= PAGES_MAX; page++) {
    const parametres = new URLSearchParams({
      // PayPal refuse les millisecondes de toISOString() : 400 INVALID_REQUEST
      // sur start_date (mesuré le 18/08/2026, debug_id 9ff49d76d8968). Le
      // format attendu est 2023-08-18T19:57:05Z, sans fraction de seconde —
      // le même travers que Bitstamp au lot 34.
      start_date: du.toISOString().replace(/\.\d+Z$/, 'Z'),
      end_date: au.toISOString().replace(/\.\d+Z$/, 'Z'),
      fields: 'transaction_info,payer_info',
      page_size: String(PAR_PAGE),
      page: String(page),
    });

    const reponse = await avecDelai((signal) =>
      fetch(`${BASE}/v1/reporting/transactions?${parametres}`, {
        signal,
        headers: { Authorization: `Bearer ${acces}`, Accept: 'application/json' },
      })
    );
    const texte = await reponse.text();
    if (!reponse.ok) {
      journaliserRefus(reponse.status, texte, '/v1/reporting/transactions');
      throw new Error(messageDeRefus(reponse.status, texte));
    }

    let donnees;
    try {
      donnees = JSON.parse(texte);
    } catch {
      throw new Error(`${NOM} a répondu autre chose que du JSON sur le rapport d'opérations.`);
    }

    const details = Array.isArray(donnees?.transaction_details) ? donnees.transaction_details : [];
    sortie.push(...details);

    const total = Number(donnees?.total_pages || 1);
    if (page >= total || !details.length) return sortie;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  log(
    `${ID} : ${PAGES_MAX} pages lues sur une seule fenêtre sans en voir la fin — le reste sera `
      + 'repris à la prochaine exécution'
  );
  return sortie;
}

/** Tout l'historique atteignable, fenêtre par fenêtre. */
async function listerOperations(config, periode, log = () => {}) {
  const acces = await jeton(config);
  const fenetres = fenetresDe31Jours(periode.du, periode.au);
  log(`${ID} : ${fenetres.length} fenêtre(s) de ${JOURS_PAR_FENETRE} jours à parcourir`);

  const operations = [];
  for (const [index, fenetre] of fenetres.entries()) {
    const lot = await operationsDeLaFenetre(acces, fenetre.du, fenetre.au, log);
    operations.push(...lot);
    log(
      `${ID} : fenêtre ${index + 1}/${fenetres.length} `
        + `(${fenetre.du.toISOString().slice(0, 10)} → ${fenetre.au.toISOString().slice(0, 10)}) `
        + `— ${lot.length} opération(s)`
    );
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : le jeton s'obtient, et la route du rapport répond sur
 * une fenêtre courte. Aucun document n'est produit.
 */
async function test(config, ctx = {}) {
  exigerIdentifiants(config);
  const acces = await jeton(config);

  // Sept jours suffisent à prouver que « Transaction Search » est bien active :
  // c'est cette permission-là qui manque neuf fois sur dix, pas le jeton.
  const au = new Date();
  const du = decaler(au, -7);
  const operations = await operationsDeLaFenetre(acces, du, au, ctx.log);

  const periode = periodeAtteignable(config, ctx, au);
  return {
    ok: true,
    accountId: COMPTE,
    invoiceCount: undefined,
    message:
      `Identifiants acceptés et lecture de l'historique autorisée — ${operations.length} `
      + 'opération(s) sur les sept derniers jours. crabe produira un relevé par mois civil '
      + `terminé, à partir du ${periode.du.toISOString().slice(0, 10)}.`,
  };
}

/** Produit un relevé reconstitué par mois civil révolu. */
async function fetchInvoices(config, ctx = {}) {
  exigerIdentifiants(config);
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  const periode = periodeAtteignable(config, ctx);
  log(`${ID} : historique demandé — ${periode.raison}`);
  // La troncature est DITE, pas subie en silence : c'est ce qui distingue
  // « crabe a tout repris » de « crabe a repris ce qu'il pouvait ».
  if (periode.message) log(`${ID} : ${periode.message}`);

  const brutes = await listerOperations(config, periode, log);
  const sansDate = brutes.filter((o) => !dateIso(o)).length;
  if (sansDate) {
    log(
      `${ID} : ${sansDate} opération(s) sans date exploitable — elles ne figurent dans aucun `
        + 'relevé, signalez-le'
    );
  }

  const mois = releve.parMoisRevolus(brutes, dateIso);
  log(`${ID} : ${brutes.length} opération(s), ${mois.length} mois civil(s) terminé(s)`);

  // Preuve d'accès (lot 31) : le jeton OAuth a été accepté et l'historique des
  // transactions rendu — sans cette lecture, « aucun nouveau relevé » serait
  // une conclusion sans fondement.
  ctx.preuveDeListe?.({
    session: 'jeton d\'API accepté par PayPal',
    liste: 'historique des transactions (API /v1/reporting/transactions)',
    elements: brutes.length,
  });

  const documents = [];
  for (const groupe of mois) {
    const remoteId = remoteIdDuMois(groupe.mois);
    if (connus.has(remoteId)) continue;

    documents.push({
      remoteId,
      filename: releve.nomFichier({ service: NOM, du: groupe.du, au: groupe.au }),
      issuedOn: groupe.au,
      buffer: releve.construire({
        service: NOM,
        compte: null,
        periode: { du: groupe.du, au: groupe.au },
        colonnes: COLONNES,
        operations: groupe.operations.map(operationLisible),
        mentions: [
          'Source : API PayPal, GET /v1/reporting/transactions',
          'PayPal n\'émet aucune facture pour ces opérations : ce relevé est la mise en',
          'forme de votre historique, produite par crabe.',
        ],
      }),
    });
  }

  log(`${ID} : ${documents.length} relevé(s) mensuel(s) produit(s)`);
  return { accountId: COMPTE, invoices: documents };
}

module.exports = {
  test,
  fetchInvoices,
  COMPTE,
  // exportés pour les tests unitaires
  fenetresDe31Jours,
  periodeAtteignable,
  dateIso,
  montant,
  operationLisible,
  messageDeRefus,
  identifiants,
  defautDeForme,
  LONGUEUR_MINIMALE,
  demanderJeton,
  remoteIdDuMois,
  decaler,
  COLONNES,
  MESSAGE_IDENTIFIANTS_REFUSES,
  MESSAGE_IDENTIFIANTS_SANDBOX,
  BASE,
  BASE_ESSAI,
  SCOPE,
  JOURS_PAR_FENETRE,
  ANNEES_MAX,
};
