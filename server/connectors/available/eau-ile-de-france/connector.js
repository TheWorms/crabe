'use strict';

/**
 * Connecteur de l'Eau d'Île-de-France — les factures de « Historique de mes
 * factures », prises une à une par leur icône de téléchargement, le SEUL clic
 * du connecteur (lot 102).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la page des factures, enregistré connecté par
 * l'utilisateur le 11/10/2026, dont le prompt du lot 102 a repris la STRUCTURE, sans
 * aucune donnée. Un espace client Salesforce Experience Cloud :
 *
 *   - la page est servie à `/espace-particuliers/s/factures` (titre « Mes
 *     Factures », `body.comm-page-custom-factures`) ; elle est DESSINÉE par
 *     script : `#auraLoadingBox` d'abord, le contenu ensuite ;
 *   - l'historique est le composant `c-icl-contrat-factures-histo` : une ligne
 *     d'en-tête (Date, Numéro de facture, Montant, Statut, Téléchargement),
 *     puis une ligne `div.slds-grid.slds-p-around_medium` par facture — la
 *     date (`lightning-formatted-date-time`, JJ/MM/AAAA), le numéro de
 *     facture en texte (24 chiffres), le montant, le statut, et `div.download`,
 *     qui porte `data-url` (un jeton chiffré) et `data-numfacture` (le même
 *     numéro) : ni lien, ni bouton — un élément à cliquer ;
 *   - le reste de la page AGIT : « Payer ma facture », « Télécharger une
 *     attestation de contrat », « Signaler un changement », les onglets, le
 *     menu (`javascript:void(0);`), « Déconnexion »… Rien de cela n'est touché.
 *
 * NON MESURÉ, et le code ne le suppose pas : ce que fait le clic (les trois
 * voies sont guettées par le socle `clic-document`), l'adresse de la page de
 * connexion, un historique vide ou long, plusieurs contrats (seul le contrat
 * affiché est lu, et c'est dit).
 *
 * ─── Une page Salesforce : lire par le moteur de Playwright ─────────────────
 *
 * Les composants de la page sont des Lightning Web Components à ombre
 * SYNTHÉTIQUE : leur contenu est dans le DOM, mais le polyfill de Salesforce
 * filtre, dans le monde de la page, `document.querySelector(All)` et les
 * requêtes du `body` — l'intérieur d'un composant n'y apparaît pas (comportement
 * public de LWC, non mesuré sur ce site). Ce connecteur ne lit donc JAMAIS par
 * une requête du document évaluée dans la page : il lit, compte et clique par
 * le moteur de sélecteurs de Playwright (`page.locator`), qui travaille dans
 * un monde isolé où ce filtre n'existe pas. Le banc des essais l'imite.
 *
 * ─── Le seul clic, et comment il est enfermé ─────────────────────────────────
 *
 *   1. UNE fonction clique : `cliquerLeTelechargement`. Elle ne reçoit pas de
 *      sélecteur : elle reçoit un numéro, qui doit avoir la forme d'un numéro
 *      de facture ET figurer parmi ceux lus sur une ligne de l'historique ;
 *      la cible est `c-icl-contrat-factures-histo div.download` portant
 *      exactement ce `data-numfacture` ;
 *   2. au moment du clic, la cible est recontrôlée : un seul élément, visible,
 *      dans l'historique, portant ce numéro — sinon rien ne part ;
 *   3. ce fichier ne porte aucun autre geste sur la page : ni autre clic, ni
 *      saisie, ni touche — un essai le vérifie en le lisant.
 *
 * Un clic à la fois : le suivant ne part que quand le précédent a rendu son
 * document ou échoué. Le document est pris par le socle `clic-document`
 * (téléchargement, onglet ou réponse), refusé s'il ne commence pas par
 * `%PDF-` ; rien n'est lu d'une adresse hors des domaines du site
 * (`adressePermise`, lot 102). Un onglet ouvert par le clic est refermé.
 *
 * TOUT LE RESTE ARRÊTE (R5) : une fenêtre, une boîte du navigateur (refusée),
 * une autre page, un message d'erreur de Salesforce (`#auraErrorMask`
 * visible), un onglet sur un autre site, rien du tout, un document qui n'est
 * pas un PDF — plus aucun clic pendant ce passage, rien n'est rempli, les
 * factures déjà prises sont gardées, et le message dit ce qui a bloqué.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `eau-ile-de-france-facture-<numéro>`, le numéro LU (texte de la ligne
 * et `data-numfacture`, identiques). Date : celle de la ligne. Nom :
 * `eau-ile-de-france_AAAA-MM_facture-<numéro>.pdf`. Une facture déjà dans
 * l'archive n'est pas recliquée.
 *
 * ─── Le temps ────────────────────────────────────────────────────────────────
 *
 * Comme Gandi (lot 93) et les boutiques du lot 99 : le passage s'arrête de
 * lui-même aux deux tiers de la limite d'exécution et rend ce qu'il a pris —
 * le planificateur ne dépose rien d'une exécution abandonnée à la limite. Et
 * « Depuis la dernière récupération » prend tout ce qui manque à l'archive.
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

const ID = 'eau-ile-de-france';
const NOM = 'Eau d\'Île-de-France';
/** Le nom tel qu'il entre dans une phrase. */
const NOM_PHRASE = 'l\'Eau d\'Île-de-France';

const HOTE = 'connexion.leaudiledefrance.fr';
const URL_FACTURES = 'https://connexion.leaudiledefrance.fr/espace-particuliers/s/factures';
const CHEMIN_FACTURES = '/espace-particuliers/s/factures';

/**
 * Les domaines du site (§2.1 du lot 102, lus dans l'en-tête de sécurité de la
 * page enregistrée) : rien n'est lu d'une autre adresse.
 */
const DOMAINES_DU_SITE = Object.freeze([
  'connexion.leaudiledefrance.fr',
  'rock-vedif.my.site.com',
  'rock-vedif.my.salesforce.com',
  'rock-vedif.file.force.com',
  'rock-vedif--c.visualforce.com',
]);

const CHAMP_SESSION = 'session';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;

/**
 * La borne de l'attente du dessin de l'historique (R2). Rien n'a été mesuré de
 * ce chargement : une page Salesforce se monte en plusieurs allers-retours —
 * le cadre Aura, les composants, puis les données de l'historique par un
 * appel au serveur. 45 s, c'est le temps qu'on accorde déjà au chargement
 * d'une navigation (`NAV_TIMEOUT_MS`) : au-delà, ce n'est plus une page lente,
 * c'est une page qui ne finit pas — et l'échec est dit bien avant la limite
 * du passage.
 */
const DELAI_DESSIN_MS = 45_000;
/** Le pas de l'attente : chaque tour relit la page. */
const PAS_ATTENTE_MS = 500;
/**
 * Un historique dessiné doit le RESTER un moment avant d'être lu : les lignes
 * peuvent arriver après l'en-tête. Un historique sans aucune icône attend plus
 * longtemps — conclure « aucune facture » sur une liste pas encore remplie
 * serait le faux « rien à récupérer » que crabe s'interdit.
 */
const STABLE_MS = 1_500;
const STABLE_VIDE_MS = 5_000;
/** Un message d'erreur de Salesforce qui reste affiché pendant le chargement. */
const ERREUR_TENUE_MS = 3_000;
/** Chaque lecture d'un élément déjà compté : bornée, la page peut se redessiner. */
const DELAI_LECTURE_MS = 5_000;
/** Le clic attend que sa cible soit cliquable (visible, immobile, non masquée). */
const DELAI_CLIC_MS = 10_000;

/**
 * La limite d'une exécution (lot 67), relue comme le planificateur la relit :
 * `CRABE_LIMITE_EXECUTION_MS`, sinon quarante-cinq minutes. Un essai vérifie
 * que la valeur par défaut est celle de `scheduler.LIMITE_EXECUTION_MS`.
 */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
/** La part de cette limite que le connecteur s'accorde, comme Gandi. */
const PART_DU_TEMPS = 2 / 3;

/** L'historique des factures (annoncé). */
const SELECTEUR_HISTORIQUE = 'c-icl-contrat-factures-histo';
/** Une ligne : la plus profonde des grilles, jamais un bloc qui en contient d'autres. */
const SELECTEUR_LIGNE = 'div.slds-grid.slds-p-around_medium:not(:has(div.slds-grid.slds-p-around_medium))';
/** L'icône de téléchargement d'une ligne. */
const SELECTEUR_TELECHARGEMENT = 'div.download';
/** La date d'une ligne. */
const SELECTEUR_DATE = 'lightning-formatted-date-time';
/**
 * Le SEUL élément que ce connecteur clique (R4), complété au moment du clic
 * par le numéro exact : `[data-numfacture="<numéro lu>"]`.
 */
const REPERE_CLIC = 'c-icl-contrat-factures-histo div.download[data-numfacture]';
/** Un numéro de facture : vingt-quatre chiffres, rien d'autre (annoncé). */
const NUMERO_FACTURE = /^\d{24}$/;

/** Ce qui dit qu'un chargement est en cours : l'attente d'Aura, ou un indicateur dans l'historique. */
const CHARGEMENT_PAGE = '#auraLoadingBox:visible, .loadingBall:visible';
const CHARGEMENT_HISTORIQUE = 'lightning-spinner:visible, .slds-spinner:visible';
/** Le message d'erreur de Salesforce (cadre Aura), quand il est affiché. */
const ERREUR_SALESFORCE = '#auraErrorMask:visible';
/** Une fenêtre de la page : boîte, fenêtre modale de Salesforce. */
const FENETRES = '[role="dialog"]:visible, [role="alertdialog"]:visible, [aria-modal="true"]:visible, '
  + 'dialog[open]:visible, section.slds-modal:visible';
/** Un message d'erreur de Salesforce posé dans la page (bandeau, « toast ») après le clic. */
const MESSAGES_ERREUR = '.slds-theme_error:visible, .slds-theme--error:visible';
/** Un champ de mot de passe affiché : c'est une page de connexion, où qu'elle soit. */
const MOT_DE_PASSE = 'input[type="password"]:visible';

/** Les titres de la ligne d'en-tête qui disent l'historique (annoncés). */
const ENTETE_NUMERO = /num[ée]ro\s+de\s+facture/i;
const ENTETE_TELECHARGEMENT = /t[ée]l[ée]chargement/i;

/**
 * Les adresses de connexion d'un espace Salesforce, en plus du motif générique
 * du socle (`/login`, `/connexion`…) : la page des communautés et celle des
 * sites (non mesurées ici, connues de la plateforme).
 */
const MOTIF_CONNEXION_SALESFORCE = /communitieslogin|sitelogin|login_portal|\/secur\/login/i;

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

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

/**
 * Un texte dicible au journal : dans un chemin, chaque chiffre est masqué, et
 * un segment long ou encodé — un jeton glissé dans une adresse — est remplacé
 * en entier. Pure.
 */
function masquer(texte) {
  return String(texte ?? '').replace(/(\/[^\s;]*)/g, (chemin) => chemin
    .split('/')
    .map((segment) => (segment.length >= 20 || segment.includes('%') ? '…' : segment.replace(/\d/g, '#')))
    .join('/'));
}

/**
 * Toute ligne que ce connecteur écrit au journal passe ici (R8) : les chemins
 * masqués, aucune requête d'adresse, aucun jeton (une longue suite au
 * vocabulaire d'un encodage, qui porte des chiffres et des capitales, ou un
 * `%XX`), aucune suite de dix chiffres ou plus — un numéro de facture en
 * compte vingt-quatre, et un message d'erreur de Playwright peut citer le
 * sélecteur du clic, numéro compris. Pure, testée.
 */
function pourLeJournal(texte) {
  return masquer(texte)
    .replace(/\?[^\s)\]»"']*/g, '?…')
    .replace(/[A-Za-z0-9%+/=_-]{24,}/g, (s) => ((/\d/.test(s) && /[A-Z]/.test(s)) || /%[0-9A-F]{2}/i.test(s) ? '…' : s))
    .replace(/\d{10,}/g, '…');
}

/** Le journal du passage, masqué ligne à ligne. */
function journalDe(ctx) {
  const ecrire = ctx?.log || (() => {});
  return (ligne) => ecrire(pourLeJournal(ligne));
}

/**
 * Cette adresse est-elle du site ? `https` sur l'un des domaines du site, ou
 * un `blob:` né d'une de ses pages. Un onglet resté vide (« » ou
 * `about:blank`) n'a rien à lire : il passe, ce qu'il servirait ensuite est
 * jugé à son tour ; un `data:` est fabriqué par la page elle-même. Pure.
 */
function adresseDuSite(adresse) {
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
      return origine.protocol === 'https:' && DOMAINES_DU_SITE.includes(origine.hostname);
    } catch {
      return false;
    }
  }
  return u.protocol === 'https:' && DOMAINES_DU_SITE.includes(u.hostname);
}

/** Une adresse de page de connexion (motif du socle, et ceux de Salesforce). Pure. */
function estPageDeConnexion(url) {
  const chemin = preuve.sansDomaine(url);
  return preuve.estUrlAuthentification(url) || MOTIF_CONNEXION_SALESFORCE.test(chemin);
}

/** Le chemin d'une adresse, sans sa requête : une autre PAGE, pas un paramètre. Pure. */
function cheminDe(adresse) {
  try {
    const u = new URL(adresse);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(adresse || '');
  }
}

const normaliser = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/**
 * Une ligne lue dans la page, ramenée à ce qu'elle est. Pure, testée.
 *
 * @param {{visible: boolean, texte: string, dateTexte: string,
 *   icones: number, numeroIcone: string|null}} brute
 * @returns {{nature: 'facture', numero: string, issuedOn: string|null}
 *   | {nature: 'entete'|'cachee'|'autre'|'sans-icone'}
 *   | {nature: 'ecartee', raison: string}}
 */
function analyserLigne(brute) {
  if (!brute?.visible) return { nature: 'cachee' };
  const texte = normaliser(brute.texte);
  const numerosDuTexte = [...new Set(texte.match(/(?<!\d)\d{24}(?!\d)/g) || [])];
  if (!brute.icones) {
    if (ENTETE_NUMERO.test(texte) && ENTETE_TELECHARGEMENT.test(texte)) return { nature: 'entete' };
    return numerosDuTexte.length ? { nature: 'sans-icone' } : { nature: 'autre' };
  }
  if (brute.icones > 1) return { nature: 'ecartee', raison: 'plusieurs icônes de téléchargement sur la même ligne' };
  const numeroIcone = String(brute.numeroIcone ?? '').trim();
  if (!NUMERO_FACTURE.test(numeroIcone)) {
    return { nature: 'ecartee', raison: 'l\'icône ne porte pas un numéro de facture lisible' };
  }
  if (numerosDuTexte.length !== 1) {
    return {
      nature: 'ecartee',
      raison: numerosDuTexte.length ? 'la ligne porte plusieurs numéros de facture' : 'le numéro de facture de la ligne ne se lit pas',
    };
  }
  if (numerosDuTexte[0] !== numeroIcone) {
    return { nature: 'ecartee', raison: 'le numéro porté par l\'icône diffère de celui de la ligne' };
  }
  const issuedOn = pageDocs.dateDepuisTexte(brute.dateTexte) || pageDocs.dateDepuisTexte(texte.replace(numeroIcone, ' '));
  return { nature: 'facture', numero: numeroIcone, issuedOn };
}

/**
 * Les factures d'un historique lu : celles qu'on peut prendre, celles qu'on
 * écarte (et pourquoi), celles sans icône. Un numéro présent sur deux lignes
 * n'est cliqué sur aucune — sa cible ne serait pas unique. Pure, testée.
 */
function lireLesFactures(lignes) {
  const analyses = (lignes || []).map(analyserLigne);
  const vus = new Map();
  for (const a of analyses) if (a.nature === 'facture') vus.set(a.numero, (vus.get(a.numero) || 0) + 1);
  const factures = [];
  const ecartees = [];
  let sansIcone = 0;
  for (const [rang, a] of analyses.entries()) {
    if (a.nature === 'facture' && vus.get(a.numero) > 1) {
      ecartees.push({ rang, raison: 'le même numéro de facture figure sur plusieurs lignes' });
    } else if (a.nature === 'facture') {
      factures.push({ rang, numero: a.numero, issuedOn: a.issuedOn });
    } else if (a.nature === 'ecartee') {
      ecartees.push({ rang, raison: a.raison });
    } else if (a.nature === 'sans-icone') {
      sansIcone += 1;
    }
  }
  return { factures, ecartees, sansIcone, lues: factures.length + ecartees.length + sansIcone };
}

/** L'ancre d'une facture : son numéro lu. */
function remoteIdFacture(numero) {
  return `${ID}-facture-${numero}`;
}

/**
 * Les noms de fichier d'un passage : `eau-ile-de-france_AAAA-MM_facture-<n°>.pdf`,
 * et jamais deux fois le même. Pure.
 */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: remoteIdFacture(d.numero) });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures (R8). Des
 * nombres, jamais un numéro ni un montant. Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.lues, 'facture lue', 'factures lues')} dans l'historique `
      + 'du contrat affiché'
      + (b.deja ? `, ${b.deja} déjà dans vos documents` : '')
      + (b.sansIcone ? `, ${pluriel(b.sansIcone, 'sans icône de téléchargement', 'sans icône de téléchargement')}` : '')
      + '.');
  }
  if (b.ecartees) {
    phrases.push(b.ecartees > 1
      ? `${b.ecartees} lignes ont été écartées : leur numéro de facture ne se lisait pas de façon sûre, crabe ne les a pas cliquées.`
      : 'Une ligne a été écartée : son numéro de facture ne se lisait pas de façon sûre, crabe ne l\'a pas cliquée.');
  }
  if (b.interruption === 'temps') {
    const reste = b.restantes > 1
      ? `${b.restantes} factures attendent encore ; elles viendront au prochain passage.`
      : '1 facture attend encore ; elle viendra au prochain passage.';
    phrases.push(`La récupération a pris tout le temps permis : ${reste} Rien de ce qui a été pris n'est perdu.`);
  }
  if (b.interruption === 'session') {
    phrases.push(`La lecture s'est interrompue — ${NOM_PHRASE} a demandé de vous reconnecter : les factures déjà `
      + 'prises sont gardées. Reconnectez-vous depuis la fiche de l\'Eau d\'Île-de-France pour récupérer la suite.');
  }
  return phrases.join(' ');
}

/**
 * Ce qui a bloqué, selon ce que le clic a rendu (R5) : ce que le site a fait,
 * puis ce que crabe en a fait.
 */
const ARRET = 'n\'a plus rien cliqué et s\'est arrêté là';
const BLOCAGES = {
  erreur: [`${NOM_PHRASE} a affiché un message d'erreur au lieu de la remettre`, `crabe ${ARRET}`],
  fenetre: [`${NOM_PHRASE} a ouvert une fenêtre au lieu de la remettre`, `crabe n'y a rien rempli, ${ARRET}`],
  'fenetre-navigateur': ['une boîte de dialogue du navigateur s\'est ouverte au lieu de la facture', `crabe l'a refusée, ${ARRET}`],
  page: [`${NOM_PHRASE} a affiché une autre page au lieu de la remettre`, `crabe ${ARRET}`],
  ailleurs: [`un onglet s'est ouvert sur un autre site que celui de ${NOM_PHRASE}`, `crabe n'en a rien lu, ${ARRET}`],
  rien: [`${NOM_PHRASE} n'a rien remis — ni téléchargement, ni onglet, ni document`, `crabe ${ARRET}`],
  'sans-pdf': [`${NOM_PHRASE} a remis autre chose qu'une facture PDF`, `rien n'a été déposé, crabe ${ARRET}`],
};

/**
 * La phrase qui dit pourquoi les clics se sont arrêtés (champ `renoncement`).
 * Pure, testée.
 */
function phraseArret(nature, nonDemandees = 0) {
  const [fait, suite] = BLOCAGES[nature] || BLOCAGES['sans-pdf'];
  const tete = nature === 'absent'
    ? `L'icône de téléchargement d'une facture n'a pas pu être cliquée (elle n'était plus à sa place au moment du clic) : crabe ${ARRET}.`
    : `Après un clic sur l'icône de téléchargement d'une facture, ${fait} : ${suite}.`;
  const reste = nonDemandees > 0
    ? (nonDemandees > 1
      ? ` Les ${nonDemandees} autres factures n'ont pas été demandées : elles le seront au prochain passage.`
      : ' L\'autre facture n\'a pas été demandée : elle le sera au prochain passage.')
    : '';
  return `${tete}${reste} Si cela se répète, signalez-le.`;
}

/**
 * La fenêtre d'historique : le réglage de l'utilisateur, sauf « Depuis la
 * dernière récupération », qui prend tout ce qui manque à l'archive — dans la
 * limite de la conservation (comme Gandi et les boutiques du lot 99).
 */
function fenetre(config, ctx) {
  const plan = scraping.planHistorique(config, ctx);
  if (!plan || plan.mode !== 'depuis') return plan;
  const tout = history.fenetreDeDates({ valeur: 'tout', plafondMois: ctx?.conservationMois || 0 });
  return {
    ...tout,
    mode: 'depuis',
    raison: `toutes les factures pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — par le moteur de sélecteurs, jamais un geste
// ---------------------------------------------------------------------------

/** Combien d'éléments répondent à `selecteur` ; une page en mouvement compte 0. */
function compter(lieu, selecteur) {
  return lieu.locator(selecteur).count().catch(() => 0);
}

/** Ce que la page montre, pour juger où l'on est et si l'historique est dessiné. */
async function observer(page) {
  const historiques = await compter(page, SELECTEUR_HISTORIQUE);
  let entete = false;
  let lignes = 0;
  let icones = 0;
  let chargementHistorique = 0;
  if (historiques === 1) {
    const historique = page.locator(SELECTEUR_HISTORIQUE);
    const texte = await historique.innerText({ timeout: DELAI_LECTURE_MS }).catch(() => '');
    entete = ENTETE_NUMERO.test(texte) && ENTETE_TELECHARGEMENT.test(texte);
    lignes = await compter(historique, SELECTEUR_LIGNE);
    icones = await compter(historique, SELECTEUR_TELECHARGEMENT);
    chargementHistorique = await compter(historique, CHARGEMENT_HISTORIQUE);
  }
  return {
    url: page.url(),
    historiques,
    entete,
    lignes,
    icones,
    chargement: (await compter(page, CHARGEMENT_PAGE)) + chargementHistorique > 0,
    erreur: (await compter(page, ERREUR_SALESFORCE)) > 0,
    motDePasse: (await compter(page, MOT_DE_PASSE)) > 0,
  };
}

/**
 * Attend que l'historique soit DESSINÉ (R2) : un seul historique, son en-tête,
 * plus de chargement, et le même nombre de lignes un moment durant. Bornée par
 * `ouverture.delaiDessinMs`. Rend un verdict, ne lève jamais.
 *
 * @returns {Promise<{verdict: 'historique'|'connexion'|'erreur'|'chargement'
 *   |'mur'|'illisible', raison: string}>}
 */
async function attendreLHistorique(page) {
  const debut = Date.now();
  const fin = debut + ouverture.delaiDessinMs;
  let signature = null;
  let stableDepuis = 0;
  let erreurDepuis = 0;
  let vue = null;
  for (;;) {
    vue = await observer(page);
    if (estPageDeConnexion(vue.url) || vue.motDePasse) {
      return {
        verdict: 'connexion',
        raison: estPageDeConnexion(vue.url)
          ? `renvoyé vers ${masquer(cheminDe(vue.url).replace(/^https?:\/\/[^/]+/, ''))}, une page de connexion`
          : 'un champ de mot de passe est affiché à la place de l\'historique',
      };
    }
    const dessine = vue.historiques === 1 && vue.entete && !vue.chargement;
    if (dessine) {
      const forme = `${vue.lignes}|${vue.icones}`;
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.icones ? STABLE_MS : STABLE_VIDE_MS)) {
        return {
          verdict: 'historique',
          raison: `historique des factures dessiné en ${Math.round((Date.now() - debut) / 100) / 10} s (${SELECTEUR_HISTORIQUE})`,
        };
      }
    } else {
      signature = null;
    }
    if (vue.erreur && !dessine) {
      erreurDepuis = erreurDepuis || Date.now();
      if (Date.now() - erreurDepuis >= ERREUR_TENUE_MS) {
        return { verdict: 'erreur', raison: 'le message d\'erreur de Salesforce est affiché, sans historique' };
      }
    } else {
      erreurDepuis = 0;
    }
    if (Date.now() >= fin) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  const secondes = Math.round(ouverture.delaiDessinMs / 1000);
  if (vue.chargement) return { verdict: 'chargement', raison: `encore en cours de chargement après ${secondes} s` };
  if (await profilMarchand.estMurAntiRobot(page)) return { verdict: 'mur', raison: 'vérification de sécurité du site à l\'écran' };
  if (!adresseDuSite(vue.url) || !/^https:/.test(vue.url)) {
    let ou = 'une page qui n\'est pas du site';
    try { ou = new URL(vue.url).hostname || ou; } catch { /* adresse illisible */ }
    return { verdict: 'illisible', raison: `arrivé sur ${ou}, hors du site, après ${secondes} s` };
  }
  if (vue.historiques > 1) return { verdict: 'illisible', raison: `${vue.historiques} historiques de factures dans la page` };
  if (vue.historiques === 1) return { verdict: 'illisible', raison: `l'historique est affiché sans sa ligne d'en-tête après ${secondes} s` };
  return {
    verdict: 'illisible',
    raison: `aucun historique des factures sur ${masquer(cheminDe(vue.url).replace(/^https?:\/\/[^/]+/, ''))} après ${secondes} s`,
  };
}

/**
 * Les lignes de l'historique, lues une à une par le moteur de sélecteurs : ce
 * que la ligne montre, sa date, ses icônes et le numéro que porte l'icône.
 * Le jeton `data-url` n'est jamais lu.
 */
async function lireLesLignes(page) {
  const historique = page.locator(SELECTEUR_HISTORIQUE);
  const lignes = historique.locator(SELECTEUR_LIGNE);
  const total = await lignes.count().catch(() => 0);
  const lues = [];
  for (let i = 0; i < total; i++) {
    const ligne = lignes.nth(i);
    const visible = await ligne.isVisible().catch(() => false);
    const texte = visible ? await ligne.innerText({ timeout: DELAI_LECTURE_MS }).catch(() => '') : '';
    const dates = ligne.locator(SELECTEUR_DATE);
    const dateTexte = visible && (await dates.count().catch(() => 0))
      ? await dates.first().innerText({ timeout: DELAI_LECTURE_MS }).catch(() => '')
      : '';
    const icones = await compter(ligne, SELECTEUR_TELECHARGEMENT);
    const numeroIcone = icones === 1
      ? await ligne.locator(SELECTEUR_TELECHARGEMENT).getAttribute('data-numfacture', { timeout: DELAI_LECTURE_MS }).catch(() => null)
      : null;
    lues.push({ visible, texte, dateTexte, icones, numeroIcone });
  }
  return { lues, iconesDansLHistorique: await compter(historique, SELECTEUR_TELECHARGEMENT) };
}

// ---------------------------------------------------------------------------
// Le seul clic de ce fichier
// ---------------------------------------------------------------------------

/**
 * Clique l'icône de téléchargement de la facture `numero` — et rien d'autre.
 *
 * Le numéro doit avoir la forme d'un numéro de facture ET figurer parmi
 * `lus`, les numéros lus sur une ligne de l'historique (R3) ; sinon le passage
 * s'arrête net, rien n'est cliqué. La cible est recontrôlée au moment du
 * clic : un seul élément, visible, dans l'historique, qui porte ce numéro.
 *
 * @returns {Promise<boolean>} vrai si l'icône a été cliquée
 */
async function cliquerLeTelechargement(page, numero, lus, surRefus = () => {}) {
  const n = String(numero ?? '');
  if (!NUMERO_FACTURE.test(n) || !lus?.has?.(n)) {
    throw new Error(`${ID} : un numéro qui n'a pas été lu sur une ligne de l'historique — rien n'a été cliqué.`);
  }
  const cible = page.locator(`${REPERE_CLIC}[data-numfacture="${n}"]`);
  const nombre = await cible.count().catch(() => 0);
  if (nombre !== 1) {
    surRefus(nombre ? `${nombre} icônes portent ce numéro` : 'l\'icône n\'est plus dans l\'historique');
    return false;
  }
  if (!(await cible.isVisible().catch(() => false))) {
    surRefus('l\'icône n\'est pas visible');
    return false;
  }
  if ((await cible.getAttribute('data-numfacture', { timeout: DELAI_LECTURE_MS }).catch(() => null)) !== n) {
    surRefus('l\'icône ne porte plus ce numéro');
    return false;
  }
  try {
    await cible.click({ timeout: DELAI_CLIC_MS });
  } catch (err) {
    surRefus(`l'icône n'a pas pu être cliquée (${normaliser(err?.message).split(' Call log')[0].slice(0, 120)})`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ce que le clic rend
// ---------------------------------------------------------------------------

/** Les fenêtres et messages d'erreur visibles, comptés — jamais touchés. */
async function compterLesIssues(page) {
  return {
    fenetres: await compter(page, FENETRES),
    erreurs: await compter(page, MESSAGES_ERREUR),
    masque: (await compter(page, ERREUR_SALESFORCE)) > 0,
  };
}

/** Les onglets ouverts par le site pendant un clic : refermés, sans rien y lire. */
async function fermerLesAutresOnglets(page, context) {
  for (const autre of context?.pages?.() || []) {
    if (autre !== page) await autre.close().catch(() => {});
  }
}

/**
 * Une facture : le clic (par `cliquerLeTelechargement`, la seule voie), puis
 * le document qu'il rend, quelle que soit la voie (socle `clic-document`).
 * Une boîte du navigateur est REFUSÉE, jamais acceptée ; une fenêtre, un
 * message d'erreur ou une autre page mettent fin à l'attente sans être
 * touchés.
 *
 * @returns {Promise<{ok: true, buffer: Buffer, voie: string}
 *   | {ok: false, nature: string, grief: string}>}
 */
async function prendreUneFacture(page, context, numero, lus) {
  let boiteNative = false;
  let refus = '';
  const surBoite = (boite) => {
    boiteNative = true;
    boite.dismiss().catch(() => {});
  };
  page.on?.('dialog', surBoite);
  const avant = { chemin: cheminDe(page.url()), ...(await compterLesIssues(page)) };
  const autreIssue = async () => {
    if (boiteNative || cheminDe(page.url()) !== avant.chemin) return true;
    const maintenant = await compterLesIssues(page);
    return (maintenant.masque && !avant.masque) || maintenant.fenetres > avant.fenetres || maintenant.erreurs > avant.erreurs;
  };
  try {
    const obtenu = await clicDocument.documentDuClic(
      page,
      context,
      () => cliquerLeTelechargement(page, numero, lus, (raison) => { refus = raison; }),
      { delaiMs: ouverture.delaiDocumentMs, autreIssue, adressePermise: adresseDuSite }
    );
    if (obtenu.ok && !identity.estPdf(obtenu.buffer)) {
      return { ok: false, nature: 'sans-pdf', grief: 'le document reçu ne commence pas comme un PDF' };
    }
    if (obtenu.ok) return obtenu;
    if (boiteNative) {
      return { ok: false, nature: 'fenetre-navigateur', grief: 'une boîte de dialogue du navigateur s\'est ouverte — refusée' };
    }
    if (obtenu.horsDomaine) return { ok: false, nature: 'ailleurs', grief: obtenu.grief };
    if (refus) return { ok: false, nature: 'absent', grief: refus };
    if (obtenu.autreIssue) {
      const maintenant = await compterLesIssues(page);
      if (cheminDe(page.url()) !== avant.chemin) {
        return { ok: false, nature: 'page', grief: 'une autre page s\'est affichée à la place de la facture' };
      }
      if ((maintenant.masque && !avant.masque) || maintenant.erreurs > avant.erreurs) {
        return { ok: false, nature: 'erreur', grief: 'un message d\'erreur de Salesforce s\'est affiché, sans être touché' };
      }
      return { ok: false, nature: 'fenetre', grief: 'une fenêtre s\'est ouverte à la place de la facture, sans être touchée' };
    }
    if (/ni téléchargement, ni nouvel onglet, ni réponse PDF/.test(obtenu.grief)) {
      return { ok: false, nature: 'rien', grief: obtenu.grief };
    }
    return { ok: false, nature: 'sans-pdf', grief: obtenu.grief };
  } finally {
    try { page.off?.('dialog', surBoite); } catch { /* page partie */ }
    await fermerLesAutresOnglets(page, context);
  }
}

// ---------------------------------------------------------------------------
// Navigation et arrivée
// ---------------------------------------------------------------------------

/**
 * La seule navigation : l'adresse de la page des factures (règle 5 — on arrive
 * par l'adresse, jamais par le menu). Rend l'erreur de chargement, s'il y en a
 * une, pour la dire.
 */
async function naviguer(page) {
  try {
    await page.goto(URL_FACTURES, { waitUntil: 'domcontentloaded' });
    return null;
  } catch (err) {
    return normaliser(err?.message).split(' Call log')[0].slice(0, 160);
  }
}

/**
 * Le lancement du navigateur, seul point remplaçable : les essais y branchent
 * un faux site (pages reconstituées, réseau coupé) et éprouvent tout le reste
 * tel quel. L'horloge du budget et les deux attentes se remplacent aussi,
 * pour les éprouver sans attendre.
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
  delaiDessinMs: DELAI_DESSIN_MS,
  delaiDocumentMs: clicDocument.DELAI_DECLENCHEMENT_MS,
};

/**
 * Ouvre un navigateur sur la connexion enregistrée. Le journal de navigation
 * (lot 87 : chemins et noms de cookies, jamais une valeur) suit le passage.
 */
async function surLeCompte(config, ctx, fn) {
  const log = journalDe(ctx);
  const session = lireSession(config);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    navigation.brancher(page, { log, prefixe: `${ID} : navigation` });
    return await fn(page, context);
  } finally {
    if (context) {
      try {
        log(`${ID} : ${navigation.formaterDifference(
          navigation.differenceEtats(cookiesCapture, await context.cookies())
        )}`);
      } catch {
        /* navigateur déjà tombé : pas de différence à dire */
      }
    }
    await browser.close().catch(() => {});
  }
}

const REESSAYER = 'La prochaine récupération réessaiera d\'elle-même ; si cela se répète, signalez-le.';

function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre espace client, mais crabe n'a pas su lire l'historique de vos factures : `
      + 'la page ne ressemble plus à celle qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la '
      + 'rouvrir. Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération réessaiera '
      + 'd\'elle-même.'
  );
  err.precision = detail;
  return err;
}

function erreurArrivee(verdict, raison, erreurNavigation) {
  if (verdict === 'chargement') {
    const err = new Error(
      `La page des factures de ${NOM_PHRASE} est restée en cours de chargement plus de `
        + `${Math.round(ouverture.delaiDessinMs / 1000)} secondes : crabe n'a rien pu lire, et n'a rien cliqué. ${REESSAYER}`
    );
    err.precision = raison;
    return err;
  }
  if (verdict === 'erreur') {
    const err = new Error(
      `${NOM_PHRASE.charAt(0).toUpperCase()}${NOM_PHRASE.slice(1)} a affiché un message d'erreur au lieu de l'historique `
        + `de vos factures : crabe n'a rien pu lire, et n'a rien cliqué. ${REESSAYER}`
    );
    err.precision = raison;
    return err;
  }
  if (erreurNavigation) {
    const err = new Error(
      `La page des factures de ${NOM_PHRASE} n'a pas pu être chargée par le navigateur de crabe : rien n'a été `
        + `lu, rien n'a été cliqué. ${REESSAYER}`
    );
    err.precision = `${raison} ; chargement : ${masquer(erreurNavigation)}`;
    return err;
  }
  return erreurPageIllisible(raison);
}

/**
 * Rejoint la page des factures, attend l'historique et JUGE l'arrivée. Rend
 * les lignes lues, ou lève : renvoi vers la connexion (classé par le lot 91 :
 * « session expirée »), mur anti-robot, chargement sans fin, erreur de
 * Salesforce, page illisible.
 */
async function arriverSurLHistorique(page, log) {
  const erreurNavigation = await naviguer(page);
  if (erreurNavigation) log(`${ID} : le chargement de la page a échoué — ${masquer(erreurNavigation)}.`);
  const arrivee = await attendreLHistorique(page);
  log(`${ID} : arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
  if (arrivee.verdict === 'connexion') throw profilMarchand.erreurRenvoiVersAuthentification(NOM, arrivee.raison);
  if (arrivee.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (arrivee.verdict !== 'historique') throw erreurArrivee(arrivee.verdict, arrivee.raison, erreurNavigation);
  const { lues, iconesDansLHistorique } = await lireLesLignes(page);
  return { lecture: lireLesFactures(lues), lignes: lues.length, iconesDansLHistorique };
}

/** La session est-elle tombée pendant un clic ? Jugé sur la page, sans la déplacer. */
async function sessionTombee(page) {
  return estPageDeConnexion(page.url()) || (await compter(page, MOT_DE_PASSE)) > 0;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : l'historique s'affiche au compte connecté. Aucun clic. */
async function test(config, ctx = {}) {
  const log = journalDe(ctx);
  return surLeCompte(config, ctx, async (page) => {
    const { lecture } = await arriverSurLHistorique(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — ${pluriel(lecture.lues, 'facture', 'factures')} dans l'historique de votre `
        + `contrat ${NOM}. Elles seront prises à la prochaine récupération.`,
    };
  });
}

/**
 * Les factures de l'historique, en deux temps : LIRE les lignes, puis PRENDRE
 * chaque facture manquante par son icône, une à la fois. Ce qui est pris est
 * GARDÉ quoi qu'il arrive ensuite — clic sans PDF, session tombée, temps
 * écoulé.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = journalDe(ctx);
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const { lecture, lignes, iconesDansLHistorique } = await arriverSurLHistorique(page, log);
    const bilan = {
      lues: lecture.lues,
      deja: 0,
      horsPeriode: 0,
      ecartees: lecture.ecartees.length,
      sansIcone: lecture.sansIcone,
      restantes: 0,
      interruption: null,
    };
    for (const e of lecture.ecartees) {
      log(`${ID} : ligne ${e.rang + 1} sur ${lignes} écartée — ${e.raison} ; aucun clic.`);
    }

    const aPrendre = [];
    for (const f of lecture.factures) {
      const remoteId = remoteIdFacture(f.numero);
      if (connus.has(remoteId)) {
        bilan.deja++;
        continue;
      }
      if (!scraping.dansLaFenetre(f.issuedOn, plan)) {
        bilan.horsPeriode++;
        continue;
      }
      aPrendre.push({ ...f, remoteId });
    }
    log(`${ID} : historique lu — ${lignes} ligne(s), ${bilan.lues} facture(s) : ${lecture.factures.length} avec une `
      + `icône de téléchargement lisible, ${bilan.ecartees} écartée(s), ${bilan.sansIcone} sans icône ; `
      + `${bilan.deja} déjà dans l'archive, ${aPrendre.length} à prendre, ${bilan.horsPeriode} hors période `
      + `(${iconesDansLHistorique} icône(s) dans l'historique). Seul le contrat affiché est lu.`);

    // La preuve exigée par le socle (lot 31) : l'historique a été LU.
    ctx.preuveDeListe?.({
      session: `historique des factures servi au compte connecté (${SELECTEUR_HISTORIQUE} sur ${CHEMIN_FACTURES})`,
      liste: URL_FACTURES,
      elements: bilan.lues,
    });

    const lus = new Set(lecture.factures.map((f) => f.numero));
    const invoices = [];
    let tentees = 0;
    let arret = null;
    for (const [i, doc] of aPrendre.entries()) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      tentees++;
      const qui = `facture ${i + 1} sur ${aPrendre.length}`;
      const obtenu = await prendreUneFacture(page, context, doc.numero, lus);
      if (obtenu.ok) {
        invoices.push({ ...doc, buffer: obtenu.buffer });
        log(`${ID} : ${qui} — récupérée (voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
        continue;
      }
      log(`${ID} : ${qui} — clic sur l'icône, pas de PDF (${masquer(obtenu.grief)}). Plus aucun clic pendant ce `
        + 'passage ; rien n\'a été rempli.');
      if (await sessionTombee(page)) {
        tentees--;
        if (!invoices.length) {
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
        }
        bilan.interruption = 'session';
        log(`${ID} : renvoyé vers la connexion en prenant les factures : ${pluriel(invoices.length, 'facture déjà prise est gardée', 'factures déjà prises sont gardées')}.`);
        break;
      }
      arret = obtenu;
      break;
    }
    // Après un arrêt, la facture du clic sans PDF est manquée, et les
    // suivantes, jamais demandées, ne sont pas obtenues non plus ; après une
    // session tombée, toutes celles qui restaient. Le temps écoulé, lui, ne
    // manque rien : la suite vient au passage suivant (lot 99).
    bilan.restantes = aPrendre.length - tentees;
    const nonDemandees = arret || bilan.interruption === 'session' ? bilan.restantes : 0;
    const manquees = (arret ? 1 : 0) + nonDemandees;

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((f, i) => ({
        remoteId: f.remoteId,
        filename: noms[i],
        issuedOn: f.issuedOn,
        buffer: f.buffer,
      })),
      couverture: {
        complete: !bilan.interruption && !arret && !manquees,
        detail: `l'historique des factures du contrat affiché, ${pluriel(bilan.lues, 'facture', 'factures')}`,
      },
    };
    if (manquees) {
      sortie.manquees = manquees;
      if (arret) sortie.renoncement = phraseArret(arret.nature, nonDemandees);
    }
    if (!bilan.lues) {
      sortie.aucunDocument = `Votre historique de factures ${NOM} a bien été lu : il ne contient aucune facture pour l'instant.`;
    } else if (!lecture.factures.length) {
      sortie.aucunDocument = `Votre historique de factures ${NOM} a bien été lu : `
        + `${pluriel(bilan.lues, 'facture', 'factures')}, aucune ne peut être prise pour l'instant`
        + `${bilan.sansIcone ? ` (${pluriel(bilan.sansIcone, 'sans icône de téléchargement', 'sans icône de téléchargement')})` : ''}.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: manquees > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.lues} facture(s) lue(s), ${invoices.length} prise(s), ${bilan.deja} déjà dans `
      + `l'archive, ${bilan.ecartees} écartée(s), ${bilan.sansIcone} sans icône, ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${arret ? ` — clics arrêtés (${arret.nature})` : ''}`
      + `${nonDemandees ? ` — ces ${nonDemandees} non demandée(s) comptent comme non obtenues` : ''}.`);

    // L'état de session d'un passage qui a lu l'historique remplace la capture
    // (lot 87). Jamais après un renvoi vers la connexion.
    if (bilan.interruption !== 'session') {
      try {
        sortie.sessionRenouvelee = JSON.stringify(await context.storageState());
      } catch {
        log(`${ID} : l'état de session n'a pas pu être relu en fin de passage.`);
      }
    }
    return sortie;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests
  lireSession,
  masquer,
  pourLeJournal,
  adresseDuSite,
  estPageDeConnexion,
  analyserLigne,
  lireLesFactures,
  remoteIdFacture,
  nommer,
  precisionDuPassage,
  phraseArret,
  fenetre,
  budgetMs,
  cliquerLeTelechargement,
  URL_FACTURES,
  CHEMIN_FACTURES,
  HOTE,
  DOMAINES_DU_SITE,
  REPERE_CLIC,
  SELECTEUR_HISTORIQUE,
  SELECTEUR_LIGNE,
  NUMERO_FACTURE,
  DELAI_DESSIN_MS,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
