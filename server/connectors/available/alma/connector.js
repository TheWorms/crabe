'use strict';

/**
 * Connecteur Alma — le REÇU de chaque échéance payée, pris sur la page de
 * l'achat (lot 104).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la page du compte (ses deux onglets) et de la
 * page d'un achat (sans et avec la fenêtre du reçu), enregistrés connectés par
 * l'utilisateur le 11/10/2026, dont le prompt du lot 104 a repris la STRUCTURE, sans
 * aucune donnée. Application React aux classes générées (`_nom_hash`),
 * INSTABLES : ce fichier ne lit que des `data-testid`, des rôles et des textes.
 *
 *   - la page du compte, `https://portal.getalma.eu/account/customer_account_<id>`
 *     — l'identifiant est propre au compte : JAMAIS écrit ici, lu dans
 *     l'adresse où le portail arrive ; `data-testid="account-logged-in-button"`
 *     au compte connecté ;
 *   - deux onglets (`div[role=button]`, « Achats en cours », « Achats
 *     terminés ») ; un clic montre l'autre liste ;
 *   - un achat : `data-testid="customer-portal-card-payment_<id>"`, SANS
 *     adresse — la page de l'achat est `https://portal.getalma.eu/payment_<id>` ;
 *   - la page d'un achat : `data-testid="schedule"`, une ligne par échéance
 *     `data-testid="payment-schedule-line-installment_<id>"` (`role=button`) —
 *     la date SANS année (« 3 mars »), le montant, un badge « Payé » ou autre ;
 *     `data-testid="purchase-detail"` porte la date d'achat AVEC son année ;
 *   - un clic sur une ligne payée ouvre une fenêtre (`role=dialog`,
 *     `data-testid="reactModal"`) : badge « Payé », la date
 *     (`payment-card-next-installment-date`), le montant, le bouton
 *     `data-testid="download-receipt"` « Télécharger le reçu », et la croix
 *     `data-testid="modal-close-button"`.
 *
 * NON MESURÉ : où le portail arrive après connexion (le connecteur exige la
 * page du compte et le dit sinon), ce que fait « Télécharger le reçu » (les
 * trois voies du socle `clic-document` sont guettées), une ligne non payée.
 *
 * ─── Les gestes, et comment ils sont enfermés ────────────────────────────────
 *
 * Quatre gestes, une liste fermée et gelée (`GESTES`), UNE fonction qui les
 * fait (`faireLeGeste`), chacun recontrôlé au moment du geste :
 *
 *   1. `onglet` — « Achats en cours » ou « Achats terminés », texte exact, un
 *      seul élément visible ;
 *   2. `ligne` — la ligne d'échéance dont l'identifiant a été LU, seule,
 *      visible, qui porte ENCORE le badge « Payé » et la date lue ; une ligne
 *      non payée n'est jamais touchée ;
 *   3. `recu` — « Télécharger le reçu », dans la fenêtre ouverte, qui montre
 *      la date de CETTE ligne et « Payé » ;
 *   4. `croix` — la croix de cette fenêtre.
 *
 * Rien d'autre dans la fenêtre ; rien ne se remplit. Le reçu est pris par le
 * socle (téléchargement, onglet ou réponse), seulement depuis les domaines
 * d'Alma (`adressePermise`), refusé sans `%PDF-`. Si le geste ne donne pas un
 * PDF, PLUS AUCUN GESTE pendant ce passage — pas même la croix — et c'est dit.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `alma-recu-installment_<id>`. Date : celle de l'échéance, son année
 * déduite de la date d'achat (`datesDesEcheances`, règle écrite et testée).
 * Nom : `alma_AAAA-MM_recu-<10 derniers caractères de l'identifiant>.pdf`.
 *
 * ─── Lot 105 : ce que l'essai réel du 12/10/2026 a montré ────────────────────
 *
 * MESURÉ au journal de production : connexion capturée et confirmée dans la
 * fenêtre (sur la page du compte), puis, au rejeu sans écran, arrivée jugée
 * « connexion » dans la seconde. MESURÉ dans le script public du portail
 * (lecture anonyme) : la session vit dans le `sessionStorage` du navigateur
 * (`customer-portal-session`, un jeton d'accès) ; sans elle, chaque page
 * renvoie vers `/login`. La capture ne la recopiait pas (les sept cookies ne
 * la portent pas). D'où :
 *
 *   - R4 — le manifeste déclare `stockageDeSession` : la fenêtre lit ce
 *     stockage à la capture, l'enregistre chiffré avec les cookies ; ce
 *     fichier le restaure AVANT la première navigation (`context.
 *     addInitScript`) et le relit en fin de passage. Le journal dit le NOMBRE
 *     de clés, jamais un nom ni une valeur ;
 *   - R3 — `/login/marketing-optin` (« Restez au courant des bons plans »,
 *     ANNONCÉ par l'utilisateur après sa connexion, structure MESURÉE sur la page
 *     enregistrée) n'est PAS une page de connexion : un cinquième geste,
 *     `nonMerci`, y clique le bouton de texte exact « Non merci » — sur cette
 *     seule adresse, la page portant son titre et le bouton « Je m'inscris » à
 *     côté —, une fois par passage. « Je m'inscris » n'est JAMAIS cliqué ;
 *     l'écran de chargement `#initial-loader` est attendu, jamais retiré ;
 *   - R5 — une VRAIE page de connexion veut dire que la session du portail
 *     n'existe plus : « session expirée » (orange), se reconnecter — jamais
 *     « réessayez dans quelques heures » (`err.expirationCertaine`).
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const history = require('../../history');
const pageDocs = require('../../documents-de-page');
const clicDocument = require('../../clic-document');
const navigation = require('../../releve-navigation');
const profilMarchand = require('../../profil-marchand');
const preuve = require('../../preuve-connexion');
const refusees = require('../../adresses-refusees');

const ID = 'alma';
const NOM = 'Alma';

const HOTE = 'portal.getalma.eu';
const URL_PORTAIL = 'https://portal.getalma.eu/';
/** L'origine du portail, celle dont le stockage de session porte la session (R4). */
const ORIGINE_PORTAIL = 'https://portal.getalma.eu';
/**
 * La page du choix de la lettre d'information (R3) : `h1` « Bienvenue sur
 * votre portail Alma », carte « Restez au courant des bons plans », deux
 * `button[type=button]` « Non merci » et « Je m'inscris » — mesuré sur la page
 * enregistrée le 12/10/2026. Aucun champ.
 */
const CHEMIN_CHOIX_LETTRE = '/login/marketing-optin';
const TITRE_CHOIX_LETTRE = 'Bienvenue sur votre portail Alma';
/** Le début de l'adresse de la page du compte ; la suite est propre au compte. */
const DEBUT_COMPTE = 'https://portal.getalma.eu/account/customer_account_';

/** Les domaines d'Alma, lus dans les pages enregistrées : rien n'est lu d'ailleurs. */
const DOMAINES_ALMA = Object.freeze(['portal.getalma.eu', 'api.getalma.eu']);

const CHAMP_SESSION = 'session';
const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_DESSIN_MS = 45_000;
/** La fenêtre du reçu, qui s'ouvre ou se ferme : quelques secondes suffisent. */
const DELAI_FENETRE_MS = 10_000;
/**
 * Après « Non merci », le temps laissé au portail pour QUITTER la page du
 * choix (il enregistre la réponse, puis navigue) : 15 s, la borne de
 * l'attente d'un onglet. La page du compte est ensuite attendue comme à
 * l'arrivée.
 */
const DELAI_APRES_CHOIX_MS = 15_000;
const PAS_ATTENTE_MS = 400;
const STABLE_MS = 1_500;
const STABLE_VIDE_MS = 5_000;
const DELAI_CLIC_MS = 10_000;

const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
const PART_DU_TEMPS = 2 / 3;

/** Un identifiant d'achat ou d'échéance : le préfixe, puis des lettres et des chiffres. */
const ID_ACHAT = /^payment_[A-Za-z0-9]{6,64}$/;
const ID_ECHEANCE = /^installment_[A-Za-z0-9]{6,64}$/;

const FENETRE = '[role="dialog"][data-testid="reactModal"]';

/** Les deux onglets, textes exacts. */
const ONGLETS = Object.freeze(['Achats en cours', 'Achats terminés']);

/**
 * La liste fermée et gelée des gestes (R2). `repere` est le sélecteur exact ;
 * `{id}` y est remplacé par l'identifiant d'échéance LU, jamais par autre chose.
 */
const GESTES = Object.freeze({
  onglet: Object.freeze({ repere: 'div[role="button"]', textes: ONGLETS }),
  ligne: Object.freeze({ repere: '[data-testid="schedule"] [role="button"][data-testid="payment-schedule-line-{id}"]' }),
  recu: Object.freeze({ repere: `${FENETRE} [data-testid="download-receipt"]`, texte: 'Télécharger le reçu' }),
  croix: Object.freeze({ repere: `${FENETRE} [data-testid="modal-close-button"]` }),
  // Lot 105 (R3) — le seul geste ajouté : « Non merci », sur la page du choix
  // de la lettre d'information, et nulle part ailleurs. `voisin` est le bouton
  // qui DOIT être à côté, et qui n'est JAMAIS cliqué.
  nonMerci: Object.freeze({
    repere: 'button[type="button"]',
    texte: 'Non merci',
    voisin: 'Je m\'inscris',
    chemin: CHEMIN_CHOIX_LETTRE,
    titre: TITRE_CHOIX_LETTRE,
  }),
});

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `Le navigateur nécessaire à ${NOM} n'est pas installé sur ce serveur. `
        + 'Signalez-le à la personne qui administre crabe.'
    );
  }
}

function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw profilMarchand.erreurSessionExpiree(NOM, controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

/**
 * Toute ligne écrite au journal passe ici (R5) : aucun identifiant d'achat,
 * d'échéance ou de compte, aucun montant, aucune suite de quatre chiffres,
 * aucune requête d'adresse. Pure, testée.
 */
function pourLeJournal(texte) {
  return String(texte ?? '')
    .replace(/\?[^\s)\]»"']*/g, '?…')
    .replace(/\b(payment|installment|customer_account)_[A-Za-z0-9]+/g, '$1_…')
    .replace(/[A-Za-z0-9]{16,}/g, (s) => (/\d/.test(s) && /[A-Z]/.test(s) ? '…' : s))
    .replace(/\d[\d\s]*,\d\d\s*€/g, '… €')
    .replace(/\d{4,}/g, '…');
}

function journalDe(ctx) {
  const ecrire = ctx?.log || (() => {});
  return (ligne) => ecrire(pourLeJournal(ligne));
}

const normaliser = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** L'adresse de la page d'un achat, depuis son identifiant LU — ou `null`. Pure. */
function adresseDeLAchat(idAchat) {
  const id = String(idAchat ?? '');
  if (!ID_ACHAT.test(id)) return null;
  const adresse = `https://${HOTE}/${id}`;
  return refusees.motRefuse(adresse) ? null : adresse;
}

/** L'identifiant d'achat d'une carte, depuis son `data-testid` — ou `null`. Pure. */
function achatDeLaCarte(testid) {
  const m = /^customer-portal-card-(payment_[A-Za-z0-9]+)$/.exec(String(testid ?? ''));
  return m && ID_ACHAT.test(m[1]) ? m[1] : null;
}

/** L'identifiant d'échéance d'une ligne, depuis son `data-testid` — ou `null`. Pure. */
function echeanceDeLaLigne(testid) {
  const m = /^payment-schedule-line-(installment_[A-Za-z0-9]+)$/.exec(String(testid ?? ''));
  return m && ID_ECHEANCE.test(m[1]) ? m[1] : null;
}

/** Le jour et le mois d'une date sans année (« 3 mars ») — ou `null`. Pure. */
function jourEtMois(texte) {
  const brut = normaliser(texte);
  const m = /^(\d{1,2})(?:er)?\s+(\S+?)\.?$/.exec(brut);
  if (!m) return null;
  const iso = pageDocs.dateDepuisTexte(`${m[1]} ${m[2]} 2000`);
  if (!iso) return null;
  return { mois: Number(iso.slice(5, 7)), jour: Number(iso.slice(8, 10)) };
}

const iso = (a, m, j) => `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;

/**
 * LA RÈGLE DE L'ANNÉE (R2). Les échéances sont dans l'ordre de l'échéancier ;
 * la première tombe le jour de l'achat, les suivantes les mois d'après. Chaque
 * échéance prend la PREMIÈRE année qui la place au jour de l'achat ou après,
 * et au jour de l'échéance précédente ou après : l'année de l'achat, puis la
 * suivante quand le mois revient en arrière (décembre → janvier). Une date
 * illisible rend `null` et ne déplace pas la suivante. Pure, testée.
 *
 * @param {string} achatIso la date d'achat, AAAA-MM-JJ
 * @param {string[]} textes les dates des échéances, sans année
 * @returns {(string|null)[]}
 */
function datesDesEcheances(achatIso, textes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(achatIso || ''))) return (textes || []).map(() => null);
  let plancher = achatIso;
  return (textes || []).map((texte) => {
    const jm = jourEtMois(texte);
    if (!jm) return null;
    let annee = Number(plancher.slice(0, 4));
    let date = iso(annee, jm.mois, jm.jour);
    while (date < plancher) {
      annee += 1;
      date = iso(annee, jm.mois, jm.jour);
    }
    plancher = date;
    return date;
  });
}

/** La date d'achat, lue dans le texte de « Détails de l'achat » (ligne « Date »). Pure. */
function dateDAchat(texteDetail) {
  const lignes = String(texteDetail ?? '').split('\n').map(normaliser).filter(Boolean);
  const i = lignes.findIndex((l) => l === 'Date');
  if (i < 0) return null;
  return pageDocs.dateDepuisTexte(lignes[i + 1] || '');
}

/**
 * Les échéances d'une page d'achat : payées (à prendre), non payées (jamais
 * touchées), écartées. Pure, testée.
 *
 * @param {{testid: string, texte: string, visible: boolean}[]} lignes
 * @param {string|null} achatIso
 */
function echeancesDeLAchat(lignes, achatIso) {
  const lues = (lignes || []).map((l) => {
    const morceaux = String(l.texte ?? '').split('\n').map(normaliser).filter(Boolean);
    return {
      id: echeanceDeLaLigne(l.testid),
      visible: !!l.visible,
      dateTexte: morceaux.find((m) => jourEtMois(m)) || '',
      paye: morceaux.includes('Payé'),
    };
  });
  const dates = datesDesEcheances(achatIso, lues.map((l) => l.dateTexte));
  const payees = [];
  const nonPayees = [];
  const ecartees = [];
  for (const [rang, l] of lues.entries()) {
    if (!l.id || !l.visible || !l.dateTexte) {
      ecartees.push({ rang, raison: !l.id ? 'identifiant d\'échéance illisible' : !l.visible ? 'ligne cachée' : 'date illisible' });
    } else if (!l.paye) {
      nonPayees.push({ rang, id: l.id });
    } else if (!dates[rang]) {
      ecartees.push({ rang, raison: 'l\'année de l\'échéance ne se déduit pas (date d\'achat illisible)' });
    } else {
      payees.push({ rang, id: l.id, dateTexte: l.dateTexte, issuedOn: dates[rang] });
    }
  }
  return { payees, nonPayees, ecartees };
}

/** L'ancre d'un reçu : l'identifiant de l'échéance. Pure. */
function remoteIdDe(echeance) {
  return `${ID}-recu-${echeance.id}`;
}

/** Les noms de fichier d'un passage, jamais deux fois le même. Pure. */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-recu-${String(d.id).slice(-10)}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

/**
 * Cette adresse est-elle d'Alma ? `https` sur l'un de ses domaines, ou un
 * `blob:` né d'une de ses pages ; un onglet resté vide passe (ce qu'il
 * servirait ensuite est jugé à son tour) ; un `data:` est fabriqué par la page.
 * Pure.
 */
function adresseAlma(adresse) {
  const brute = String(adresse ?? '');
  if (brute === '' || brute === 'about:blank') return true;
  let u;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  if (u.protocol === 'data:') return true;
  if (u.protocol === 'blob:') {
    try {
      const origine = new URL(u.pathname);
      return origine.protocol === 'https:' && DOMAINES_ALMA.includes(origine.hostname);
    } catch {
      return false;
    }
  }
  return u.protocol === 'https:' && DOMAINES_ALMA.includes(u.hostname);
}

/** La page du choix de la lettre d'information (R3), à son adresse exacte. Pure. */
function estPageDuChoixDeLettre(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' && u.hostname === HOTE && u.pathname.replace(/\/$/, '') === CHEMIN_CHOIX_LETTRE;
  } catch {
    return false;
  }
}

/**
 * Une page de connexion. Lot 105 (R3) : `/login/marketing-optin` n'en est PAS
 * une — c'est le choix de la lettre d'information, que le motif générique
 * (`/login`) prenait pour un formulaire. Pure.
 */
function estPageDeConnexion(url) {
  return !estPageDuChoixDeLettre(url) && preuve.estUrlAuthentification(url);
}

/**
 * Une VRAIE page de connexion veut dire que la session du portail n'existe
 * plus (R5, lot 105) : le jeton du stockage de session manque ou est mort.
 * Ce n'est pas un refus du site — « session expirée », se reconnecter.
 */
function erreurSessionPerdue(precision = '') {
  const err = new Error(
    `Votre session ${NOM} a expiré : le portail demande de vous reconnecter. Reconnectez-vous depuis `
      + `la fiche d'${NOM} : la récupération repartira toute seule.`
  );
  err.sessionExpired = true;
  err.expirationCertaine = true;
  err.precision = precision;
  return err;
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/** Ce qui a arrêté les gestes, tel que l'écran le dit. */
const ARRETS = {
  'sans-pdf': 'Alma a remis autre chose qu\'un reçu PDF',
  rien: 'Alma n\'a rien remis — ni téléchargement, ni onglet, ni document',
  ailleurs: 'le reçu venait d\'un autre site qu\'Alma',
  fenetre: 'la fenêtre du reçu ne s\'est pas ouverte comme prévu',
  absent: 'un élément n\'était plus à sa place au moment du geste',
  page: 'Alma a affiché une autre page',
};

/**
 * Ce que l'écran dit d'un passage (R5) : achats et échéances payées lus, déjà
 * en archive, ce qui a bloqué. Des nombres, jamais un identifiant, un
 * commerçant ou un montant. Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.achats, 'achat lu', 'achats lus')}, `
      + `${pluriel(b.payees, 'échéance payée', 'échéances payées')}`
      + (b.deja ? `, ${b.deja} déjà dans vos documents` : '')
      + (b.nonPayees ? `, ${pluriel(b.nonPayees, 'échéance pas encore payée', 'échéances pas encore payées')} (pas de reçu pour l'instant)` : '')
      + '.');
  }
  if (b.ecartees) {
    phrases.push(`${pluriel(b.ecartees, 'échéance a été écartée', 'échéances ont été écartées')} : elle${b.ecartees > 1 ? 's' : ''} ne se lisai${b.ecartees > 1 ? 'en' : ''}t pas de façon sûre.`);
  }
  if (b.achatsIllisibles) {
    phrases.push(`${pluriel(b.achatsIllisibles, 'page d\'achat ne s\'est pas lue', 'pages d\'achat ne se sont pas lues')} : la prochaine récupération réessaiera.`);
  }
  if (b.arret) {
    phrases.push(`Après un geste sur un reçu, ${ARRETS[b.arret] || ARRETS['sans-pdf']} : crabe n'a plus rien cliqué pendant ce passage`
      + (b.nonDemandees ? ` ; ${pluriel(b.nonDemandees, 'autre reçu n\'a pas été demandé, il le sera', 'autres reçus n\'ont pas été demandés, ils le seront')} au prochain passage` : '')
      + '. Si cela se répète, signalez-le.');
  }
  if (b.interruption === 'temps') {
    phrases.push(`La récupération a pris tout le temps permis : ${pluriel(b.restantes, 'reçu attend', 'reçus attendent')} encore ; `
      + 'la suite viendra au prochain passage. Rien de ce qui a été pris n\'est perdu.');
  }
  if (b.interruption === 'session') {
    phrases.push('La lecture s\'est interrompue — Alma a demandé de vous reconnecter : les reçus déjà pris sont gardés. '
      + 'Reconnectez-vous depuis la fiche d\'Alma pour récupérer la suite.');
  }
  return phrases.join(' ');
}

function fenetre(config, ctx) {
  const plan = scraping.planHistorique(config, ctx);
  if (!plan || plan.mode !== 'depuis') return plan;
  const tout = history.fenetreDeDates({ valeur: 'tout', plafondMois: ctx?.conservationMois || 0 });
  return {
    ...tout,
    mode: 'depuis',
    raison: `tous les reçus pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — jamais un geste
// ---------------------------------------------------------------------------

const LIRE_LE_COMPTE = () => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const boutons = [...document.querySelectorAll('button[type="button"]')].filter(visible).map((b) => n(b.innerText || b.textContent));
  const h1 = document.querySelector('h1');
  return {
    url: location.href,
    connecte: visible(document.querySelector('[data-testid="account-logged-in-button"]')),
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    onglets: [...document.querySelectorAll('div[role="button"]')].filter(visible).map((el) => n(el.innerText || el.textContent)),
    cartes: [...document.querySelectorAll('[data-testid^="customer-portal-card-"]')].filter(visible).map((el) => el.getAttribute('data-testid')),
    vide: visible(document.querySelector('[data-testid="customer-portal-no-payments-found"]')),
    // Lot 105 — l'écran de chargement du portail, attendu, jamais retiré.
    chargeur: visible(document.getElementById('initial-loader')),
    // Lot 105 — la page du choix de la lettre : son titre, et combien de
    // boutons portent EXACTEMENT chacun des deux textes.
    titre: h1 ? n(h1.innerText || h1.textContent) : '',
    nonMerci: boutons.filter((t) => t === 'Non merci').length,
    inscription: boutons.filter((t) => t === 'Je m\'inscris').length,
  };
};

const LIRE_L_ACHAT = () => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const echeancier = document.querySelector('section[data-testid="schedule"]');
  const detail = document.querySelector('[data-testid="purchase-detail"]');
  return {
    url: location.href,
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    connecte: visible(document.querySelector('[data-testid="account-logged-in-button"]')),
    echeancier: !!echeancier,
    detail: detail ? detail.innerText || '' : '',
    lignes: echeancier
      ? [...echeancier.querySelectorAll('[data-testid^="payment-schedule-line-"]')].map((el) => ({
        testid: el.getAttribute('data-testid'),
        texte: el.innerText || '',
        visible: visible(el),
      }))
      : [],
    fenetres: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
  };
};

/** La fenêtre ouverte : combien, et ce qu'elle montre (date, « Payé », le bouton). */
const LIRE_LA_FENETRE = () => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const toutes = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const f = toutes[0] || null;
  const date = f && f.querySelector('[data-testid="payment-card-next-installment-date"]');
  return {
    nombre: toutes.length,
    alma: !!f && f.getAttribute('data-testid') === 'reactModal',
    date: date ? n(date.textContent) : '',
    paye: !!f && [...f.querySelectorAll('span')].some((s) => n(s.textContent) === 'Payé'),
    boutons: f ? f.querySelectorAll('[data-testid="download-receipt"]').length : 0,
  };
};

async function lire(page, fonction) {
  return page.evaluate(fonction).catch(() => null);
}

/** Attend la page du compte, stable ; ne lève jamais. */
async function attendreLeCompte(page, { delaiMs = ouverture.delaiDessinMs } = {}) {
  const debut = Date.now();
  let signature = null;
  let stableDepuis = 0;
  let vue = null;
  for (;;) {
    vue = await lire(page, LIRE_LE_COMPTE);
    // Lot 105 — l'écran de chargement du portail : attendu, jamais jugé.
    if (vue && vue.chargeur) {
      signature = null;
      if (Date.now() - debut >= delaiMs) break;
      await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
      continue;
    }
    if (vue && estPageDuChoixDeLettre(vue.url) && !vue.motDePasse) {
      // Le choix de la lettre (R3) : dessiné quand son titre et ses deux
      // boutons sont là ; jamais une page de connexion.
      if (vue.titre === TITRE_CHOIX_LETTRE && vue.nonMerci && vue.inscription) {
        return { verdict: 'choix-lettre', raison: 'page du choix de la lettre d\'information (« Non merci » / « Je m\'inscris »)', vue };
      }
    } else if (vue && (estPageDeConnexion(vue.url) || vue.motDePasse)) {
      return { verdict: 'connexion', raison: 'renvoyé vers une page de connexion', vue };
    }
    const surLeCompte = vue && String(vue.url).startsWith(DEBUT_COMPTE) && vue.connecte
      && ONGLETS.every((o) => vue.onglets.includes(o)) && (vue.cartes.length || vue.vide);
    if (surLeCompte) {
      const forme = JSON.stringify(vue.cartes) + vue.vide;
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.cartes.length ? STABLE_MS : STABLE_VIDE_MS)) {
        return { verdict: 'compte', raison: 'page du compte affichée au compte connecté', vue };
      }
    } else {
      signature = null;
    }
    if (Date.now() - debut >= delaiMs) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  if (await profilMarchand.estMurAntiRobot(page).catch(() => false)) return { verdict: 'mur', raison: 'vérification de sécurité', vue };
  let raison = 'rien de lisible';
  if (vue) {
    if (vue.chargeur) raison = 'l\'écran de chargement du portail est resté affiché';
    else if (estPageDuChoixDeLettre(vue.url)) raison = 'la page du choix de la lettre d\'information ne ressemble pas à celle mesurée';
    else if (!String(vue.url).startsWith(DEBUT_COMPTE)) raison = 'le portail n\'est pas arrivé sur la page du compte';
    else if (!vue.connecte) raison = 'le bouton du compte connecté n\'est pas affiché';
    else raison = 'les onglets ou la liste des achats ne sont pas dessinés';
  }
  return { verdict: 'illisible', raison, vue };
}

/** Attend la page d'un achat, stable ; ne lève jamais. */
async function attendreLAchat(page) {
  const debut = Date.now();
  let signature = null;
  let stableDepuis = 0;
  let vue = null;
  for (;;) {
    vue = await lire(page, LIRE_L_ACHAT);
    if (vue && (estPageDeConnexion(vue.url) || vue.motDePasse)) return { verdict: 'connexion', vue };
    if (vue && vue.echeancier && vue.lignes.length && dateDAchat(vue.detail)) {
      const forme = JSON.stringify(vue.lignes);
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= STABLE_MS) return { verdict: 'achat', vue };
    } else {
      signature = null;
    }
    if (Date.now() - debut >= ouverture.delaiDessinMs) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  return { verdict: 'illisible', vue };
}

/** Attend que la fenêtre soit ouverte (`ouverte` vrai) ou fermée ; bornée. */
async function attendreLaFenetre(page, ouverte) {
  const fin = Date.now() + ouverture.delaiFenetreMs;
  let vue = null;
  for (;;) {
    vue = await lire(page, LIRE_LA_FENETRE);
    if (vue && (ouverte ? vue.nombre === 1 : vue.nombre === 0)) {
      if (!ouverte) return vue;
      await page.waitForTimeout(300).catch(() => {});
      return await lire(page, LIRE_LA_FENETRE);
    }
    if (Date.now() >= fin) return vue;
    await page.waitForTimeout(250).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// La seule fonction qui fait un geste
// ---------------------------------------------------------------------------

/**
 * Fait le geste `nom` de la liste fermée `GESTES` — et rien d'autre.
 *
 *   - `onglet` : `attendu` est le texte exact de l'onglet ;
 *   - `ligne` : `attendu` = `{id, dateTexte}`, LUS sur une ligne payée ;
 *   - `recu` : `attendu` = `{dateTexte}` de la ligne dont la fenêtre est ouverte ;
 *   - `croix` : sans attendu.
 *
 * Tout est recontrôlé au moment du geste ; un refus rend `false` et dit
 * pourquoi (`surRefus`). Un nom hors de la liste, ou un identifiant qui n'a
 * pas la forme lue, lève : rien n'est cliqué.
 *
 * @returns {Promise<boolean>}
 */
async function faireLeGeste(page, nom, attendu, surRefus = () => {}) {
  const geste = GESTES[nom];
  if (!geste || !Object.prototype.hasOwnProperty.call(GESTES, nom)) {
    throw new Error(`${ID} : un geste hors de la liste — rien n'a été cliqué.`);
  }
  let cible = null;
  if (nom === 'onglet') {
    if (!geste.textes.includes(attendu)) throw new Error(`${ID} : un onglet hors de la liste — rien n'a été cliqué.`);
    const tous = page.locator(geste.repere);
    const total = await tous.count().catch(() => 0);
    const exacts = [];
    for (let i = 0; i < total; i++) {
      if (normaliser(await tous.nth(i).textContent({ timeout: DELAI_CLIC_MS }).catch(() => '')) === attendu) exacts.push(i);
    }
    if (exacts.length !== 1) {
      surRefus(exacts.length ? 'plusieurs onglets de ce nom' : 'l\'onglet n\'est pas dans la page');
      return false;
    }
    cible = tous.nth(exacts[0]);
  } else if (nom === 'nonMerci') {
    // R3 (lot 105) — sur la page du choix de la lettre, et sur elle seule ; la
    // page porte son titre et les DEUX boutons ; un seul « Non merci »,
    // visible. Le bouton voisin, « Je m'inscris », n'est jamais une cible.
    if (attendu !== null && attendu !== undefined) throw new Error(`${ID} : « Non merci » ne prend aucune cible — rien n'a été cliqué.`);
    if (!estPageDuChoixDeLettre(page.url())) {
      surRefus('la page n\'est pas celle du choix de la lettre d\'information');
      return false;
    }
    const vue = await lire(page, LIRE_LE_COMPTE);
    if (!vue || vue.titre !== geste.titre || vue.inscription !== 1 || vue.nonMerci !== 1) {
      surRefus('la page ne montre pas son titre, un seul « Non merci » et « Je m\'inscris » à côté');
      return false;
    }
    const tous = page.locator(geste.repere);
    const total = await tous.count().catch(() => 0);
    const exacts = [];
    for (let i = 0; i < total; i++) {
      if (normaliser(await tous.nth(i).textContent({ timeout: DELAI_CLIC_MS }).catch(() => '')) === geste.texte) exacts.push(i);
    }
    if (exacts.length !== 1) {
      surRefus(exacts.length ? 'plusieurs boutons « Non merci »' : 'le bouton « Non merci » n\'est pas dans la page');
      return false;
    }
    cible = tous.nth(exacts[0]);
    if (normaliser(await cible.textContent({ timeout: DELAI_CLIC_MS }).catch(() => '')) !== geste.texte) {
      surRefus('le bouton ne porte plus « Non merci »');
      return false;
    }
  } else if (nom === 'ligne') {
    const id = String(attendu?.id ?? '');
    if (!ID_ECHEANCE.test(id)) throw new Error(`${ID} : une échéance qui n'a pas été lue — rien n'a été cliqué.`);
    cible = page.locator(geste.repere.replace('{id}', id));
    if ((await cible.count().catch(() => 0)) !== 1) {
      surRefus('la ligne n\'est plus seule à sa place');
      return false;
    }
    const morceaux = String(await cible.innerText({ timeout: DELAI_CLIC_MS }).catch(() => '')).split('\n').map(normaliser);
    if (!morceaux.includes('Payé')) {
      surRefus('la ligne ne porte plus le badge « Payé »');
      return false;
    }
    if (!morceaux.includes(attendu.dateTexte)) {
      surRefus('la ligne ne porte plus la date lue');
      return false;
    }
  } else {
    const fen = await lire(page, LIRE_LA_FENETRE);
    if (!fen || fen.nombre !== 1 || !fen.alma) {
      surRefus('la fenêtre du reçu n\'est pas seule ouverte');
      return false;
    }
    if (nom === 'recu' && (!fen.paye || fen.date !== attendu?.dateTexte || fen.boutons !== 1)) {
      surRefus('la fenêtre ne montre pas « Payé » et la date de cette échéance');
      return false;
    }
    cible = page.locator(geste.repere);
    if ((await cible.count().catch(() => 0)) !== 1) {
      surRefus('le bouton n\'est plus seul à sa place');
      return false;
    }
    if (nom === 'recu' && normaliser(await cible.textContent({ timeout: DELAI_CLIC_MS }).catch(() => '')) !== geste.texte) {
      surRefus('le bouton ne porte plus « Télécharger le reçu »');
      return false;
    }
  }
  if (!(await cible.isVisible().catch(() => false))) {
    surRefus('l\'élément n\'est pas visible');
    return false;
  }
  try {
    await cible.click({ timeout: DELAI_CLIC_MS });
  } catch (err) {
    surRefus(`le geste n'a pas pu se faire (${normaliser(err?.message).split(' Call log')[0].slice(0, 100)})`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Les deux listes, un reçu
// ---------------------------------------------------------------------------

/** Les achats des deux onglets, par le geste `onglet`. Rend aussi un refus éventuel. */
async function lireLesDeuxListes(page, log) {
  const achats = [];
  for (const onglet of ONGLETS) {
    let refus = '';
    const fait = await faireLeGeste(page, 'onglet', onglet, (r) => { refus = r; });
    if (!fait) return { achats, refus: `onglet « ${onglet} » : ${refus}` };
    const lue = await attendreLeCompte(page, { delaiMs: 15_000 });
    if (lue.verdict === 'connexion') return { achats, session: true };
    if (lue.verdict !== 'compte') return { achats, refus: `onglet « ${onglet} » : ${lue.raison}` };
    const ids = lue.vue.cartes.map(achatDeLaCarte);
    const illisibles = ids.filter((x) => !x).length;
    for (const id of ids) if (id && !achats.includes(id)) achats.push(id);
    log(`${ID} : onglet « ${onglet} » — ${lue.vue.cartes.length} achat(s)${illisibles ? `, ${illisibles} carte(s) illisible(s)` : ''}.`);
  }
  return { achats };
}

/**
 * Un reçu : la ligne, la fenêtre, « Télécharger le reçu » (le document par le
 * socle), puis la croix. Toute anomalie rend `{ok: false, nature}` ; l'appelant
 * arrête alors tous les gestes.
 */
async function prendreUnRecu(page, context, echeance) {
  let refus = '';
  const surRefus = (r) => { refus = r; };
  if (!(await faireLeGeste(page, 'ligne', echeance, surRefus))) return { ok: false, nature: 'absent', grief: refus };
  const fen = await attendreLaFenetre(page, true);
  if (!fen || fen.nombre !== 1 || !fen.alma || !fen.paye || fen.date !== echeance.dateTexte || fen.boutons !== 1) {
    return { ok: false, nature: 'fenetre', grief: 'la fenêtre ouverte ne montre pas « Payé », la date de l\'échéance et un seul bouton de reçu' };
  }
  let boiteNative = false;
  const surBoite = (b) => { boiteNative = true; b.dismiss().catch(() => {}); };
  page.on?.('dialog', surBoite);
  const chemin = new URL(page.url()).pathname;
  let obtenu = null;
  try {
    obtenu = await clicDocument.documentDuClic(
      page,
      context,
      () => faireLeGeste(page, 'recu', echeance, surRefus),
      {
        delaiMs: ouverture.delaiDocumentMs,
        adressePermise: adresseAlma,
        autreIssue: async () => boiteNative || new URL(page.url()).pathname !== chemin,
      }
    );
  } finally {
    try { page.off?.('dialog', surBoite); } catch { /* page partie */ }
    for (const autre of context?.pages?.() || []) if (autre !== page) await autre.close().catch(() => {});
  }
  if (obtenu.ok && !identity.estPdf(obtenu.buffer)) return { ok: false, nature: 'sans-pdf', grief: 'le document reçu ne commence pas comme un PDF' };
  if (!obtenu.ok) {
    if (refus) return { ok: false, nature: 'absent', grief: refus };
    if (obtenu.horsDomaine) return { ok: false, nature: 'ailleurs', grief: obtenu.grief };
    if (boiteNative || obtenu.autreIssue) return { ok: false, nature: 'page', grief: 'une autre page ou une boîte du navigateur au lieu du reçu' };
    if (/ni téléchargement, ni nouvel onglet/.test(obtenu.grief)) return { ok: false, nature: 'rien', grief: obtenu.grief };
    return { ok: false, nature: 'sans-pdf', grief: obtenu.grief };
  }
  // Le reçu est pris : la croix referme la fenêtre, avant la ligne suivante.
  const fermee = await faireLeGeste(page, 'croix', null, surRefus)
    && (await attendreLaFenetre(page, false))?.nombre === 0;
  return { ok: true, buffer: obtenu.buffer, voie: obtenu.voie, fermeture: fermee };
}

/** Le lancement du navigateur, l'horloge et les attentes : les seuls points remplaçables. */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
  delaiDessinMs: DELAI_DESSIN_MS,
  delaiFenetreMs: DELAI_FENETRE_MS,
  delaiDocumentMs: clicDocument.DELAI_DECLENCHEMENT_MS,
  delaiApresChoixMs: DELAI_APRES_CHOIX_MS,
};

async function surLeCompte(config, ctx, fn) {
  const log = journalDe(ctx);
  const session = lireSession(config);
  // R4 (lot 105) — le stockage de session du portail, enregistré avec la
  // connexion : Playwright ne le connaît pas (retiré de ce qu'on lui confie),
  // il est restauré par un script posé AVANT la première navigation.
  const stockage = sessionState.stockageDeSession(session, ORIGINE_PORTAIL);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: sessionState.sansStockageDeSession(session), viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    if (stockage.length) {
      await context.addInitScript(sessionState.RESTAURER_STOCKAGE_DE_SESSION, { origine: ORIGINE_PORTAIL, entrees: stockage });
    }
    log(stockage.length
      ? `${ID} : stockage de session du portail — ${stockage.length} clé(s) restaurée(s) avant la première navigation.`
      : `${ID} : stockage de session du portail — aucune clé dans la connexion enregistrée (enregistrée avant que crabe sache `
        + 'le garder) : le portail demandera de se reconnecter.');
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    navigation.brancher(page, { log, prefixe: `${ID} : navigation` });
    return await fn(page, context, stockage);
  } finally {
    if (context) {
      try {
        log(`${ID} : ${navigation.formaterDifference(navigation.differenceEtats(cookiesCapture, await context.cookies()))}`);
      } catch {
        /* navigateur déjà tombé */
      }
    }
    await browser.close().catch(() => {});
  }
}

/**
 * La seule navigation : le portail, ou la page d'un achat dont l'identifiant
 * a été LU sur une carte. Une adresse qui porte un mot refusé ne part jamais.
 */
async function naviguer(page, adresse) {
  const mot = refusees.motRefuse(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot refusé « ${mot} »).`);
  if (adresse !== URL_PORTAIL && !/^https:\/\/portal\.getalma\.eu\/payment_[A-Za-z0-9]+$/.test(adresse)) {
    throw new Error(`${ID} : une adresse qui n'est ni le portail ni un achat lu ne se suit jamais.`);
  }
  try {
    await page.goto(adresse, { waitUntil: 'domcontentloaded' });
    return null;
  } catch (err) {
    return normaliser(err?.message).split(' Call log')[0].slice(0, 160);
  }
}

function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre espace, mais crabe n'a pas su lire vos achats : la page ne ressemble plus à celle `
      + 'qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la rouvrir. Signalez-le pour que la lecture '
      + 'soit mise à jour ; la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

async function arriverSurLeCompte(page, log) {
  const erreur = await naviguer(page, URL_PORTAIL);
  if (erreur) log(`${ID} : le chargement du portail a échoué — ${erreur}.`);
  let arrivee = await attendreLeCompte(page);
  log(`${ID} : arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
  if (arrivee.verdict === 'choix-lettre') {
    // R3 (lot 105) — UN « Non merci » par passage, puis la page du compte.
    let refus = '';
    const fait = await faireLeGeste(page, 'nonMerci', null, (r) => { refus = r; });
    if (!fait) throw erreurPageIllisible(`« Non merci » non cliqué : ${refus}`);
    log(`${ID} : « Non merci » cliqué sur la page du choix de la lettre d'information (jamais « Je m'inscris »).`);
    // Le portail enregistre la réponse, PUIS quitte la page : on attend qu'il
    // l'ait quittée (borné), avant de juger la suivante.
    const fin = Date.now() + ouverture.delaiApresChoixMs;
    while (estPageDuChoixDeLettre(page.url()) && Date.now() < fin) await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
    if (estPageDuChoixDeLettre(page.url())) {
      throw erreurPageIllisible('la page du choix de la lettre d\'information est restée affichée après « Non merci »');
    }
    arrivee = await attendreLeCompte(page);
    log(`${ID} : après « Non merci », arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
    if (arrivee.verdict === 'choix-lettre') throw erreurPageIllisible('la page du choix de la lettre d\'information est revenue après « Non merci »');
  }
  if (arrivee.verdict === 'connexion') throw erreurSessionPerdue(arrivee.raison);
  if (arrivee.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (arrivee.verdict !== 'compte') throw erreurPageIllisible(arrivee.raison);
  return arrivee.vue;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la page du compte s'affiche au compte connecté. Aucun geste. */
async function test(config, ctx = {}) {
  const log = journalDe(ctx);
  return surLeCompte(config, ctx, async (page) => {
    await arriverSurLeCompte(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — votre espace ${NOM} est ouvert. Les reçus de vos échéances payées seront pris à la prochaine récupération.`,
    };
  });
}

/**
 * Les reçus, en trois temps : LIRE les deux listes (geste `onglet`), LIRE la
 * page de chaque achat (par son adresse), puis PRENDRE chaque reçu manquant
 * d'une échéance payée (gestes `ligne`, `recu`, `croix`). Ce qui est pris est
 * GARDÉ quoi qu'il arrive ensuite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = journalDe(ctx);
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context, stockageCapture) => {
    await arriverSurLeCompte(page, log);
    const listes = await lireLesDeuxListes(page, log);
    if (listes.session) throw erreurSessionPerdue('renvoyé vers la connexion en lisant les listes');
    if (listes.refus) throw erreurPageIllisible(listes.refus);

    const bilan = {
      achats: listes.achats.length,
      payees: 0,
      nonPayees: 0,
      deja: 0,
      horsPeriode: 0,
      ecartees: 0,
      achatsIllisibles: 0,
      arret: null,
      nonDemandees: 0,
      restantes: 0,
      interruption: null,
    };
    ctx.preuveDeListe?.({
      session: 'page du compte servie au compte connecté (account-logged-in-button), deux listes lues',
      liste: DEBUT_COMPTE,
      elements: bilan.achats,
    });

    const invoices = [];
    let aPrendreTotal = 0;
    let tentes = 0;
    for (const [i, idAchat] of listes.achats.entries()) {
      // Après un arrêt des gestes, la lecture continue — sans aucun geste —
      // pour dire combien de documents n'ont pas été demandés.
      if (bilan.interruption) break;
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      const adresse = adresseDeLAchat(idAchat);
      if (!adresse) {
        bilan.achatsIllisibles++;
        log(`${ID} : achat ${i + 1} — adresse refusée.`);
        continue;
      }
      const erreur = await naviguer(page, adresse);
      const lu = await attendreLAchat(page);
      if (lu.verdict === 'connexion') {
        if (!invoices.length) throw erreurSessionPerdue('renvoyé vers la connexion en ouvrant un achat');
        bilan.interruption = 'session';
        break;
      }
      if (lu.verdict !== 'achat') {
        bilan.achatsIllisibles++;
        log(`${ID} : achat ${i + 1} — page illisible${erreur ? ` (chargement : ${erreur})` : ''}.`);
        continue;
      }
      const ech = echeancesDeLAchat(lu.vue.lignes, dateDAchat(lu.vue.detail));
      bilan.payees += ech.payees.length;
      bilan.nonPayees += ech.nonPayees.length;
      bilan.ecartees += ech.ecartees.length;
      const aPrendre = [];
      for (const e of ech.payees) {
        if (connus.has(remoteIdDe(e))) bilan.deja++;
        else if (!scraping.dansLaFenetre(e.issuedOn, plan)) bilan.horsPeriode++;
        else aPrendre.push(e);
      }
      aPrendreTotal += aPrendre.length;
      log(`${ID} : achat ${i + 1} sur ${listes.achats.length} — ${lu.vue.lignes.length} échéance(s) : ${ech.payees.length} payée(s), `
        + `${ech.nonPayees.length} non payée(s) (jamais touchées), ${ech.ecartees.length} écartée(s) ; ${aPrendre.length} reçu(s) à prendre.`);
      for (const [j, e] of aPrendre.entries()) {
        if (bilan.arret) break;
        if (ouverture.maintenant() > echeance) {
          bilan.interruption = 'temps';
          break;
        }
        tentes++;
        const obtenu = await prendreUnRecu(page, context, e);
        if (!obtenu.ok) {
          log(`${ID} : reçu ${j + 1} de l'achat ${i + 1} — pas de PDF (${obtenu.grief}). Plus aucun geste pendant ce passage.`);
          if (await sessionTombee(page)) {
            tentes--;
            if (!invoices.length) throw erreurSessionPerdue('renvoyé vers la connexion en prenant un reçu');
            bilan.interruption = 'session';
          } else {
            bilan.arret = obtenu.nature;
          }
          break;
        }
        invoices.push({ ...e, buffer: obtenu.buffer });
        log(`${ID} : reçu ${j + 1} de l'achat ${i + 1} — pris (voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
        if (obtenu.fermeture === false) {
          bilan.arret = 'fenetre';
          log(`${ID} : la fenêtre du reçu ne s'est pas refermée — plus aucun geste pendant ce passage.`);
          break;
        }
      }
    }
    bilan.restantes = aPrendreTotal - tentes;
    if (bilan.arret) bilan.nonDemandees = bilan.restantes;
    const manquees = (bilan.arret && bilan.arret !== 'fenetre' ? 1 : 0) + (bilan.arret || bilan.interruption === 'session' ? bilan.restantes : 0);

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((e, i) => ({ remoteId: remoteIdDe(e), filename: noms[i], issuedOn: e.issuedOn, buffer: e.buffer })),
      couverture: {
        complete: !bilan.interruption && !bilan.arret && !bilan.achatsIllisibles,
        detail: `les deux listes d'achats, ${pluriel(bilan.achats, 'achat', 'achats')}`,
      },
    };
    if (manquees) sortie.manquees = manquees;
    if (!bilan.achats) {
      sortie.aucunDocument = `Votre espace ${NOM} a bien été lu : il ne contient aucun achat pour l'instant.`;
    } else if (!bilan.payees && !invoices.length) {
      sortie.aucunDocument = `Votre espace ${NOM} a bien été lu : ${pluriel(bilan.achats, 'achat', 'achats')}, aucune échéance payée pour l'instant.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendreTotal) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'reçu');
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: manquees > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.achats} achat(s), ${bilan.payees} échéance(s) payée(s), ${invoices.length} reçu(s) pris, `
      + `${bilan.deja} déjà dans l'archive, ${bilan.nonPayees} non payée(s), ${bilan.ecartees} écartée(s), ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${bilan.arret ? ` — gestes arrêtés (${bilan.arret})` : ''}.`);

    if (bilan.interruption !== 'session') {
      try {
        const relu = await relireLeStockage(page);
        const stockage = relu.length ? relu : stockageCapture;
        log(`${ID} : stockage de session du portail — ${stockage.length} clé(s) gardée(s) en fin de passage`
          + `${relu.length ? '' : ' (celles de la connexion enregistrée : la page n\'en montrait aucune)'}.`);
        sortie.sessionRenouvelee = JSON.stringify(sessionState.avecStockageDeSession(
          await context.storageState(),
          [{ origine: ORIGINE_PORTAIL, entrees: stockage }]
        ));
      } catch {
        log(`${ID} : l'état de session n'a pas pu être relu en fin de passage.`);
      }
    }
    return sortie;
  });
}

/** Le stockage de session du portail, relu sur la page en fin de passage ; liste vide sinon. */
async function relireLeStockage(page) {
  const lu = await lire(page, sessionState.LIRE_STOCKAGE_DE_SESSION);
  return lu && lu.origine === ORIGINE_PORTAIL ? sessionState.entreesValides(lu.entrees) : [];
}

/** La session est-elle tombée ? Jugé sur la page, sans la déplacer. */
async function sessionTombee(page) {
  const vue = await lire(page, LIRE_L_ACHAT);
  return estPageDeConnexion(page.url()) || !!vue?.motDePasse;
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests
  lireSession,
  pourLeJournal,
  adresseDeLAchat,
  achatDeLaCarte,
  echeanceDeLaLigne,
  jourEtMois,
  datesDesEcheances,
  dateDAchat,
  echeancesDeLAchat,
  remoteIdDe,
  nommer,
  adresseAlma,
  estPageDeConnexion,
  estPageDuChoixDeLettre,
  erreurSessionPerdue,
  precisionDuPassage,
  fenetre,
  budgetMs,
  faireLeGeste,
  GESTES,
  ONGLETS,
  DOMAINES_ALMA,
  URL_PORTAIL,
  ORIGINE_PORTAIL,
  CHEMIN_CHOIX_LETTRE,
  DEBUT_COMPTE,
  HOTE,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
