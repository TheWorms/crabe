'use strict';

/**
 * Connecteur Battle.net — l'historique des achats, et pour chaque achat sa
 * page de détail, imprimée en PDF : le site ne fournit aucune facture (lot 104).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la liste et d'un détail, enregistrés connectés
 * par l'utilisateur le 11/10/2026, dont le prompt du lot 104 a repris la STRUCTURE, sans
 * aucune donnée :
 *
 *   - la liste est servie à `https://account.battle.net/transactions` (titre
 *     « Compte Battle.net », `h1` « Historique des achats »), application Vue ;
 *     l'en-tête `blz-nav-battlenet` porte l'attribut `authenticated` au compte
 *     connecté — et un attribut `user` (BattleTag, courriel) que ce fichier ne
 *     lit JAMAIS ;
 *   - trois onglets (`button.meka-tab__inner`), « Achats » choisi ; une liste
 *     « Région » à laquelle crabe ne touche pas ;
 *   - `div.transactions-table table.table` : une ligne `tr.hoverable` par
 *     achat — la date (« 3 mars 2025 », mois abrégé), l'article, le total, le
 *     statut, et un lien vers `/transactions/<commande>/<facture>`, de texte le
 *     numéro de commande ;
 *   - sous le tableau, `ul[role=menubar]` : « « », « Précédent », des numéros,
 *     « Suivant », « » », tous en `href="#"` — la page suivante se dessine par
 *     script : UN CLIC est nécessaire ;
 *   - le détail, `/transactions/<commande>/<facture>` : `h1` « Détails de la
 *     commande », une carte « Commande #<commande> » avec « Numéro de
 *     facture » ; aucun lien ni bouton de téléchargement.
 *
 * NON MESURÉ, et le code ne le suppose pas : la région choisie à l'arrivée,
 * la page de connexion, un historique vide ou de plus de deux pages, la forme
 * de « Suivant » sur la dernière page, ce que l'impression montre de l'en-tête.
 *
 * ─── Le seul geste, et comment il est enfermé ────────────────────────────────
 *
 *   1. UNE fonction clique : `cliquerSuivant`. Sa cible est le lien
 *      `div.transactions-table ul[role="menubar"] a[role="menuitem"]` de texte
 *      EXACT « Suivant » (`REPERE_SUIVANT`, liste gelée d'un seul repère) ;
 *   2. au moment du clic, tout est recontrôlé : un seul élément, visible, de
 *      ce texte, sous le tableau qui montre ENCORE les numéros qui viennent
 *      d'être lus — sinon rien ne part ;
 *   3. la page suivante est attendue : elle doit montrer d'autres numéros,
 *      sinon la lecture s'arrête et l'écran le dit ; jamais au-delà de
 *      `PAGES_MAX` pages ;
 *   4. ce fichier ne porte aucun autre geste — un essai le lit.
 *
 * ─── Le document : la page de détail, imprimée (R1) ──────────────────────────
 *
 * Le chemin d'e-liquide-fr (lot 99), pas celui de Deezer : chaque détail est
 * ouvert PAR SON ADRESSE — lue dans le lien de la ligne, refusée si elle n'est
 * pas `https://account.battle.net/transactions/<commande>/<facture>` ou porte
 * un mot refusé —, dans un onglet de la session ; la page doit être le détail
 * de CET achat (titre, carte « Commande #<commande> », « Numéro de facture »
 * égal à celui de l'adresse) ; elle est alors rendue en PDF par le navigateur
 * (`page.pdf`, A4, fonds compris) SANS RIEN Y CHANGER, puis l'onglet est
 * refermé. Deezer cherche en plus une version française de son reçu ; ici la
 * page est déjà en français, et rien ne se choisit. L'en-tête du site (où
 * paraissent le BattleTag et le courriel) fait partie de la page : il est
 * imprimé avec elle, dans le document de l'utilisateur, rangé chez lui.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `battle-net-facture-<facture>` (second nombre de l'adresse), à défaut
 * `battle-net-commande-<commande>`. Date : celle de la ligne. Nom :
 * `battle-net_AAAA-MM_facture-<facture>.pdf`.
 *
 * ─── Lot 105 : ce que l'essai réel du 12/10/2026 a montré ────────────────────
 *
 * MESURÉ au journal de production : liste, connexion et « Suivant » bons, mais
 * aucun document.
 *
 *   - Les liens de détail de la page 2 portent une REQUÊTE (sa forme n'est
 *     pas mesurée) : ils étaient écartés. Un lien dont le CHEMIN est
 *     exactement `/transactions/<commande>/<facture>` est désormais accepté
 *     avec sa requête, et crabe suit le chemin SEUL ; le journal dit, une fois
 *     par page, les NOMS des paramètres rencontrés, jamais leurs valeurs.
 *   - Les dix détails ont été refusés en une seconde chacun : le verdict
 *     « autre » tombait à la première lecture où le titre « Commande #… »
 *     était là, valeur du numéro vide ou provisoire comprise — la carte était
 *     lue avant d'être dessinée. Le détail attend désormais sa carte
 *     DESSINÉE (`attendreLeDetail`), lit le numéro À CÔTÉ de son libellé, le
 *     compare sans espaces, et ne conclut à un écart que s'il tient ; le
 *     journal dit alors la FORME de ce qui a été lu, jamais la valeur.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const history = require('../../history');
const pageDocs = require('../../documents-de-page');
const ongletPdf = require('../../onglet-pdf');
const navigation = require('../../releve-navigation');
const profilMarchand = require('../../profil-marchand');
const preuve = require('../../preuve-connexion');
const refusees = require('../../adresses-refusees');

const ID = 'battle-net';
const NOM = 'Battle.net';

const HOTE = 'account.battle.net';
const URL_LISTE = 'https://account.battle.net/transactions';

const CHAMP_SESSION = 'session';
const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;

/** L'attente du dessin d'une page (liste ou détail) : celle d'une navigation. */
const DELAI_DESSIN_MS = 45_000;
/** L'attente de la page suivante après le clic. */
const DELAI_PAGE_SUIVANTE_MS = 20_000;
const PAS_ATTENTE_MS = 400;
/** Une liste dessinée doit le rester un moment ; une liste vide, plus longtemps. */
const STABLE_MS = 1_500;
const STABLE_VIDE_MS = 5_000;
const DELAI_CLIC_MS = 10_000;

/**
 * Combien de pages de la liste au plus. Dix achats par page (mesuré chez
 * l'utilisateur) : cinquante pages, ce sont cinq cents achats — plus qu'un compte de
 * joueur n'en accumule en vingt ans —, pour moins de deux minutes de lecture.
 * La borne d'e-liquide-fr et de Gandi ; atteinte, elle se dit.
 */
const PAGES_MAX = 50;

const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
const PART_DU_TEMPS = 2 / 3;

/**
 * La liste fermée et gelée des gestes de ce connecteur (R1) : un seul repère,
 * et le texte exact qu'il doit porter.
 */
const GESTES = Object.freeze({
  suivant: Object.freeze({
    repere: 'div.transactions-table ul[role="menubar"] a[role="menuitem"]',
    texte: 'Suivant',
  }),
});
const REPERE_SUIVANT = GESTES.suivant.repere;

/** Un lien de détail : `/transactions/<commande>[/<facture>]`. */
const CHEMIN_DETAIL = /^\/transactions\/([A-Z]{2,4}\d{4,})(?:\/(\d{4,}))?\/?$/;

/**
 * Lot 105 (R1) — un lien qui porte une requête n'est accepté que si son chemin
 * est EXACTEMENT `/transactions/<commande>/<facture>` : la page 2 de
 * l'historique en porte une (mesuré, 12/10/2026), dont la forme n'est pas
 * mesurée. La requête n'est jamais suivie.
 */
const CHEMIN_DETAIL_COMPLET = /^\/transactions\/([A-Z]{2,4}\d{4,})\/(\d{4,})\/?$/;

/** Le nom d'un paramètre de requête tel qu'il peut se dire au journal ; sinon « … ». */
const NOM_DE_PARAMETRE = /^[A-Za-z][A-Za-z_-]{0,30}$/;

/**
 * Lot 105 (R2) — l'attente d'une carte de détail DESSINÉE : celle d'une
 * navigation (`NAV_TIMEOUT_MS`, 45 s). La carte se remplit après la réponse
 * d'un appel du site ; un détail plus lent qu'une navigation n'est pas attendu
 * davantage, et le journal dit alors où en était la carte.
 */
const DELAI_DETAIL_MS = NAV_TIMEOUT_MS;
/** Un écart sur une carte dessinée ne conclut que s'il TIENT ce temps-là. */
const STABLE_ECART_MS = 2_000;

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
 * Toute ligne écrite au journal passe ici (R5) : aucun numéro de commande
 * (`EU…`), aucune suite de quatre chiffres ou plus, aucune requête d'adresse.
 * Pure, testée.
 */
function pourLeJournal(texte) {
  return String(texte ?? '')
    .replace(/\?[^\s)\]»"']*/g, '?…')
    .replace(/\b[A-Z]{2,4}\d{4,}\b/g, '…')
    .replace(/\d{4,}/g, '…');
}

function journalDe(ctx) {
  const ecrire = ctx?.log || (() => {});
  return (ligne) => ecrire(pourLeJournal(ligne));
}

const normaliser = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/**
 * L'adresse d'un détail, lue dans le lien d'une ligne — ou un refus. Seule
 * `https://account.battle.net/transactions/<commande>[/<facture>]` passe,
 * sans fragment, sans mot refusé. Pure, testée.
 *
 * Lot 105 (R1) : une REQUÊTE n'écarte plus le lien si son chemin est
 * exactement `/transactions/<commande>/<facture>` ; l'adresse rendue est le
 * chemin SEUL — c'est elle, et elle seule, qui sera suivie —, et `parametres`
 * porte les NOMS des paramètres (jamais leurs valeurs). Les mots refusés se
 * cherchent donc dans ce qui serait suivi : l'adresse sans sa requête. Un
 * chemin d'une autre forme reste écarté.
 *
 * @returns {{adresse: string, commande: string, facture: string|null, parametres: string[]}|{refus: string}}
 */
function adresseDuDetail(href) {
  const brut = String(href ?? '').trim();
  if (!brut) return { refus: 'lien vide' };
  const mot = refusees.motRefuse(brut.replace(/[?#][\s\S]*$/, ''));
  if (mot) return { refus: `mot refusé « ${mot} »` };
  let u;
  try {
    u = new URL(brut, URL_LISTE);
  } catch {
    return { refus: 'adresse illisible' };
  }
  if (u.protocol !== 'https:' || u.hostname !== HOTE) return { refus: 'hors du compte Battle.net' };
  if (u.hash) return { refus: 'adresse porteuse d\'un fragment' };
  const m = (u.search ? CHEMIN_DETAIL_COMPLET : CHEMIN_DETAIL).exec(u.pathname);
  if (!m) {
    return { refus: u.search ? 'adresse porteuse d\'une requête, d\'une autre forme que commande et facture' : 'pas la forme d\'un détail d\'achat' };
  }
  const parametres = [...new Set([...u.searchParams.keys()].map((nom) => (NOM_DE_PARAMETRE.test(nom) ? nom : '…')))].sort();
  return { adresse: `https://${HOTE}${u.pathname.replace(/\/$/, '')}`, commande: m[1], facture: m[2] || null, parametres };
}

/**
 * Les achats d'une page de la liste. Une ligne dont le lien ne se lit pas, ou
 * dont le texte du lien n'est pas le numéro de commande de son adresse, est
 * écartée et dite (sans numéro). Pure, testée.
 */
function achatsDeLaPage(lignes) {
  const achats = [];
  const ecartees = [];
  const parametres = new Set();
  for (const [rang, l] of (lignes || []).entries()) {
    const liens = [...new Set(l.liens || [])];
    if (liens.length !== 1) {
      ecartees.push({ rang, raison: liens.length ? 'plusieurs liens de détail sur la ligne' : 'aucun lien de détail' });
      continue;
    }
    const lu = adresseDuDetail(liens[0]);
    if (lu.refus) {
      ecartees.push({ rang, raison: lu.refus });
      continue;
    }
    if (normaliser(l.texteLien) !== lu.commande) {
      ecartees.push({ rang, raison: 'le texte du lien n\'est pas le numéro de commande de son adresse' });
      continue;
    }
    const { parametres: noms, ...achat } = lu;
    for (const nom of noms) parametres.add(nom);
    achats.push({ ...achat, issuedOn: pageDocs.dateDepuisTexte(l.date), requete: noms.length > 0 });
  }
  return { achats, ecartees, parametres: [...parametres].sort() };
}

/**
 * Faut-il cliquer « Suivant » ? Seulement si le lien est là, si la page
 * courante n'est pas la dernière des numéros montrés, et sous la borne ; une
 * page identique à la précédente arrête tout. Pure, testée.
 *
 * @returns {'suivante'|'fin'|'identique'|'vide'|'borne'}
 */
function decisionPagination({ n, numeros = [], precedents = null, suivant = false, courante = null, pages = [], pagesMax = PAGES_MAX }) {
  if (Array.isArray(precedents) && precedents.length && numeros.length === precedents.length
    && numeros.every((x, i) => x === precedents[i])) return 'identique';
  if (!numeros.length) return 'vide';
  if (!suivant) return 'fin';
  const derniere = pages.length ? Math.max(...pages) : null;
  if (Number.isFinite(courante) && Number.isFinite(derniere) && courante >= derniere) return 'fin';
  if (n >= pagesMax) return 'borne';
  return 'suivante';
}

/** L'ancre d'un achat : le numéro de facture, à défaut celui de la commande. Pure. */
function remoteIdDe(achat) {
  return achat.facture ? `${ID}-facture-${achat.facture}` : `${ID}-commande-${achat.commande}`;
}

/** Les noms de fichier d'un passage, jamais deux fois le même. Pure. */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: remoteIdDe(d) });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

/** Une adresse de page de connexion. Pure. */
function estPageDeConnexion(url) {
  return preuve.estUrlAuthentification(url) || /battle\.net\/(?:login|oauth)/i.test(String(url || ''));
}

/**
 * La liste lue est-elle celle du compte connecté ? Pure, testée.
 *
 * @returns {{verdict: 'liste'|'connexion'|'attente'|'illisible', raison: string}}
 */
function jugerListe(vue) {
  if (!vue) return { verdict: 'attente', raison: 'la page ne se lit pas encore' };
  if (estPageDeConnexion(vue.url) || vue.motDePasse) {
    return { verdict: 'connexion', raison: vue.motDePasse ? 'un champ de mot de passe est affiché' : 'renvoyé vers une page de connexion' };
  }
  if (vue.chargement) return { verdict: 'attente', raison: 'chargement en cours' };
  if (normaliser(vue.h1) !== 'Historique des achats') return { verdict: 'attente', raison: 'le titre « Historique des achats » n\'est pas affiché' };
  if (!vue.authentifie) return { verdict: 'attente', raison: 'l\'en-tête ne dit pas le compte connecté' };
  if (!vue.achatsChoisi) return { verdict: 'illisible', raison: 'l\'onglet « Achats » n\'est pas celui affiché' };
  if (!vue.tableau && !vue.etatVide) return { verdict: 'attente', raison: 'le tableau des achats n\'est pas dessiné' };
  return { verdict: 'liste', raison: `historique des achats affiché au compte connecté (${vue.lignes.length} ligne(s))` };
}

/** Un numéro lu, sans aucun espace — espaces insécables compris (R2). Pure. */
const sansEspaces = (t) => String(t ?? '').replace(/[\s\u00a0\u2007\u202f\u200b]/g, '');

/**
 * La FORME de ce qui a été lu sur une carte de détail — jamais la valeur
 * (R2) : longueur, chiffres seulement ou non, libellé trouvé, carte encore
 * provisoire. C'est ce que le journal dit d'un écart. Pure, testée.
 */
function formeDuNumero(vue) {
  const valeur = sansEspaces(vue?.valeur);
  return [
    `libellé « Numéro de facture » ${vue?.libelle ? 'trouvé' : 'absent'}`,
    `valeur lue : ${valeur.length} caractère(s)${valeur.length ? `, ${/^\d+$/.test(valeur) ? 'chiffres seulement' : 'pas seulement des chiffres'}` : ''}`,
    `carte provisoire ${vue?.provisoire ? 'encore là' : 'partie'}`,
  ].join(', ');
}

/**
 * Le détail ouvert est-il celui de CET achat ? Pure, testée.
 *
 * Lot 105 (R2) — la carte doit être DESSINÉE avant tout jugement du numéro :
 * plus de carte provisoire, le titre « Commande #… », le libellé « Numéro de
 * facture » suivi d'une valeur. Avant cela, on attend. Le numéro se compare
 * sans espaces ; un écart sur une carte dessinée rend `ecart` — l'appelant
 * n'y conclut que s'il TIENT (`STABLE_ECART_MS`). Seule une carte d'une AUTRE
 * commande conclut tout de suite.
 *
 * @returns {{verdict: 'detail'|'connexion'|'attente'|'ecart'|'autre', raison: string}}
 */
function jugerDetail(vue, achat) {
  if (!vue) return { verdict: 'attente', raison: 'la page ne se lit pas encore' };
  if (estPageDeConnexion(vue.url) || vue.motDePasse) return { verdict: 'connexion', raison: 'renvoyé vers une page de connexion' };
  if (vue.chargement) return { verdict: 'attente', raison: 'chargement en cours' };
  if (normaliser(vue.h1) !== 'Détails de la commande') return { verdict: 'attente', raison: 'le titre « Détails de la commande » n\'est pas affiché' };
  if (vue.cartes !== 1) return { verdict: 'attente', raison: `${vue.cartes} carte(s) de commande` };
  if (!normaliser(vue.titreCarte)) return { verdict: 'attente', raison: 'le titre « Commande #… » n\'est pas affiché' };
  if (normaliser(vue.titreCarte) !== `Commande #${achat.commande}`) return { verdict: 'autre', raison: 'la carte n\'est pas celle de cette commande' };
  if (!achat.facture) return vue.provisoire ? { verdict: 'attente', raison: 'la carte est encore provisoire' } : { verdict: 'detail', raison: 'détail de cet achat' };
  if (vue.provisoire) return { verdict: 'attente', raison: 'la carte est encore provisoire' };
  if (!vue.libelle) return { verdict: 'attente', raison: 'le libellé « Numéro de facture » n\'est pas affiché' };
  if (!sansEspaces(vue.valeur)) return { verdict: 'attente', raison: 'le numéro de facture n\'est pas encore affiché' };
  if (sansEspaces(vue.valeur) !== achat.facture) {
    return { verdict: 'ecart', raison: 'le numéro de facture affiché n\'est pas celui de l\'adresse' };
  }
  return { verdict: 'detail', raison: 'détail de cet achat' };
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/** Pourquoi les pages suivantes n'ont pas été lues, tel que l'écran le dit. */
const PAGES_NON_LUES = {
  identique: 'Pages suivantes non lues : après le clic sur « Suivant », Battle.net a montré les mêmes achats. '
    + 'Signalez-le pour que la lecture soit mise à jour.',
  borne: `Pages suivantes non lues : crabe s'arrête à ${PAGES_MAX} pages d'achats. Signalez-le, la limite est trop basse pour ce compte.`,
  absent: 'Pages suivantes non lues : le lien « Suivant » n\'a pas pu être cliqué (il n\'était plus à sa place). '
    + 'Signalez-le si cela se répète.',
  attente: 'Pages suivantes non lues : la page suivante ne s\'est pas affichée à temps. La prochaine récupération réessaiera.',
};

/**
 * Ce que l'écran dit d'un passage (R5) : achats lus, pages, déjà en archive,
 * et ce qui a bloqué. Des nombres, jamais un numéro, un montant ou un article.
 * Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.lus, 'achat lu', 'achats lus')} sur `
      + `${pluriel(b.pages, 'page', 'pages')} de l'historique`
      + (b.deja ? `, ${b.deja} déjà dans vos documents` : '')
      + '. Battle.net ne fournit pas de facture : crabe enregistre en PDF la page de détail de chaque achat.');
  }
  if (b.ecartees) {
    phrases.push(b.ecartees > 1
      ? `${b.ecartees} lignes ont été écartées : leur lien de détail ne se lisait pas de façon sûre.`
      : 'Une ligne a été écartée : son lien de détail ne se lisait pas de façon sûre.');
  }
  if (b.pagination && PAGES_NON_LUES[b.pagination]) phrases.push(PAGES_NON_LUES[b.pagination]);
  if (b.illisibles) {
    phrases.push(b.illisibles > 1
      ? `${b.illisibles} pages de détail ne ressemblaient pas à celle de leur achat : elles n'ont pas été enregistrées, la prochaine récupération réessaiera.`
      : 'Une page de détail ne ressemblait pas à celle de son achat : elle n\'a pas été enregistrée, la prochaine récupération réessaiera.');
  }
  if (b.interruption === 'temps') {
    phrases.push(`La récupération a pris tout le temps permis : ${pluriel(b.restantes, 'achat attend', 'achats attendent')} `
      + 'encore ; la suite viendra au prochain passage. Rien de ce qui a été pris n\'est perdu.');
  }
  if (b.interruption === 'session') {
    phrases.push('La lecture s\'est interrompue — Battle.net a demandé de vous reconnecter : les documents déjà '
      + 'pris sont gardés. Reconnectez-vous depuis la fiche de Battle.net pour récupérer la suite.');
  }
  return phrases.join(' ');
}

/** « Depuis la dernière récupération » prend tout ce qui manque à l'archive (Gandi, lot 93). */
function fenetre(config, ctx) {
  const plan = scraping.planHistorique(config, ctx);
  if (!plan || plan.mode !== 'depuis') return plan;
  const tout = history.fenetreDeDates({ valeur: 'tout', plafondMois: ctx?.conservationMois || 0 });
  return {
    ...tout,
    mode: 'depuis',
    raison: `tous les achats pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — jamais un geste
// ---------------------------------------------------------------------------

/**
 * La liste, lue dans la page. L'attribut `user` de l'en-tête n'est jamais lu :
 * seule la PRÉSENCE de `authenticated` compte.
 */
const LIRE_LA_LISTE = () => {
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const entete = document.querySelector('blz-nav-battlenet');
  const h1 = document.querySelector('.transactions-overview h1') || document.querySelector('h1');
  const choisi = document.querySelector('button.meka-tab__inner.meka-tab__inner--selected');
  const zone = document.querySelector('div.transactions-table');
  const lignes = zone ? [...zone.querySelectorAll('table.table tbody tr.hoverable')] : [];
  const pagination = zone ? zone.querySelector('ul[role="menubar"]') : null;
  const liens = pagination ? [...pagination.querySelectorAll('a[role="menuitem"]')] : [];
  const suivants = liens.filter((a) => n(a.innerText || a.textContent) === 'Suivant' && visible(a));
  const courante = pagination ? pagination.querySelector('li.current-page') : null;
  const overlay = document.querySelector('div.loading-overlay');
  return {
    url: location.href,
    h1: h1 ? h1.innerText || h1.textContent : '',
    authentifie: !!entete && entete.hasAttribute('authenticated'),
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    achatsChoisi: !!choisi && n(choisi.innerText || choisi.textContent) === 'Achats',
    tableau: !!(zone && zone.querySelector('table.table')),
    etatVide: !zone && !!document.querySelector('.transactions-overview .table-states-container'),
    chargement: !!overlay && !overlay.classList.contains('hide'),
    lignes: lignes.map((tr) => {
      const cellules = [...tr.querySelectorAll('td')];
      const ancres = [...tr.querySelectorAll('a[href*="/transactions/"]')];
      return {
        date: cellules[0] ? n(cellules[0].innerText || cellules[0].textContent) : '',
        liens: ancres.map((a) => a.getAttribute('href')),
        texteLien: ancres[0] ? n(ancres[0].textContent) : '',
      };
    }),
    suivant: suivants.length === 1,
    courante: courante ? Number.parseInt(n(courante.textContent), 10) : null,
    pages: liens.map((a) => Number.parseInt(n(a.textContent), 10)).filter((x) => Number.isFinite(x)),
  };
};

/**
 * Le détail d'un achat, lu dans la page.
 *
 * Lot 105 (R2) — le numéro se lit À CÔTÉ de son libellé : l'élément sans
 * enfant de texte exact « Numéro de facture », puis son frère suivant dans la
 * même ligne. Jamais par la classe `blz-text-capitalize-first` : la valeur du
 * statut la porte aussi (mesuré sur la page enregistrée). La carte est dite
 * PROVISOIRE tant qu'elle porte une classe d'attente (`placeholder…`, sur le
 * conteneur `data-placeholder-id` ou dedans) : l'attribut `data-placeholder-id`
 * lui-même reste sur la carte dessinée, de classe vide (mesuré) — sa seule
 * présence ne prouve rien. La forme exacte de la carte provisoire n'est pas
 * mesurée.
 */
const LIRE_LE_DETAIL = () => {
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const cartes = [...document.querySelectorAll('.main-content-section .blz-card')];
  const carte = cartes[0] || null;
  let libelle = false;
  let valeur = '';
  let provisoire = false;
  if (carte) {
    const etiquette = [...carte.querySelectorAll('div')].find((d) => d.children.length === 0 && n(d.textContent) === 'Numéro de facture');
    libelle = !!etiquette;
    const voisin = etiquette ? etiquette.nextElementSibling : null;
    valeur = voisin ? String(voisin.textContent || '') : '';
    provisoire = [...carte.querySelectorAll('[data-placeholder-id]')].some((el) => /placeholder|skeleton/i.test(el.getAttribute('class') || ''))
      || !!carte.querySelector('.placeholder, .placeholder-glow, .placeholder-wave, .skeleton, [aria-busy="true"]');
  }
  const overlay = document.querySelector('div.loading-overlay');
  const h1 = document.querySelector('.main-content-section h1') || document.querySelector('h1');
  return {
    url: location.href,
    h1: h1 ? h1.innerText || h1.textContent : '',
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    chargement: !!overlay && !overlay.classList.contains('hide'),
    cartes: cartes.length,
    titreCarte: carte && carte.querySelector('.blz-card-header h2') ? carte.querySelector('.blz-card-header h2').textContent : '',
    libelle,
    valeur,
    provisoire,
  };
};

async function lire(page, fonction) {
  return page.evaluate(fonction).catch(() => null);
}

/**
 * Attend que la liste soit DESSINÉE et stable, bornée. Rend un verdict et la
 * dernière lecture ; ne lève jamais.
 */
async function attendreLaListe(page) {
  const debut = Date.now();
  let signature = null;
  let stableDepuis = 0;
  let vue = null;
  let jugement = null;
  for (;;) {
    vue = await lire(page, LIRE_LA_LISTE);
    jugement = jugerListe(vue);
    if (jugement.verdict === 'connexion' || jugement.verdict === 'illisible') return { ...jugement, vue };
    if (jugement.verdict === 'liste') {
      const forme = JSON.stringify(vue.lignes.map((l) => l.liens));
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.lignes.length ? STABLE_MS : STABLE_VIDE_MS)) return { ...jugement, vue };
    } else {
      signature = null;
    }
    if (Date.now() - debut >= ouverture.delaiDessinMs) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  if (await profilMarchand.estMurAntiRobot(page).catch(() => false)) return { verdict: 'mur', raison: 'vérification de sécurité du site', vue };
  return { verdict: 'illisible', raison: `${jugement?.raison || 'rien de lisible'} après ${Math.round(ouverture.delaiDessinMs / 1000)} s`, vue };
}

/** Les numéros de commande d'une lecture, dans l'ordre. */
function numerosDe(vue) {
  return (vue?.lignes || []).map((l) => normaliser(l.texteLien));
}

// ---------------------------------------------------------------------------
// Le seul geste de ce fichier
// ---------------------------------------------------------------------------

/**
 * Clique « Suivant » sous le tableau des achats — et rien d'autre.
 *
 * `numerosLus` : les numéros de commande que la page vient de montrer. Le
 * lien n'est cliqué que s'il est seul, visible, de texte exact, et si le
 * tableau montre ENCORE ces numéros (R1).
 *
 * @returns {Promise<{clique: true}|{clique: false, raison: string}>}
 */
async function cliquerSuivant(page, numerosLus) {
  const geste = GESTES.suivant;
  const liens = page.locator(geste.repere);
  const total = await liens.count().catch(() => 0);
  const exacts = [];
  for (let i = 0; i < total; i++) {
    const texte = normaliser(await liens.nth(i).textContent({ timeout: DELAI_CLIC_MS }).catch(() => ''));
    if (texte === geste.texte) exacts.push(i);
  }
  if (exacts.length !== 1) return { clique: false, raison: exacts.length ? 'plusieurs liens « Suivant »' : 'aucun lien « Suivant »' };
  const cible = liens.nth(exacts[0]);
  if (!(await cible.isVisible().catch(() => false))) return { clique: false, raison: 'le lien « Suivant » n\'est pas visible' };
  const encore = numerosDe(await lire(page, LIRE_LA_LISTE));
  if (!Array.isArray(numerosLus) || !numerosLus.length || JSON.stringify(encore) !== JSON.stringify(numerosLus)) {
    return { clique: false, raison: 'le tableau ne montre plus les achats qui viennent d\'être lus' };
  }
  if (normaliser(await cible.textContent({ timeout: DELAI_CLIC_MS }).catch(() => '')) !== geste.texte) {
    return { clique: false, raison: 'le lien ne porte plus « Suivant »' };
  }
  try {
    await cible.click({ timeout: DELAI_CLIC_MS });
  } catch (err) {
    return { clique: false, raison: `le lien n'a pas pu être cliqué (${normaliser(err?.message).split(' Call log')[0].slice(0, 100)})` };
  }
  return { clique: true };
}

/** Attend, après le clic, une liste qui montre d'AUTRES numéros ; bornée. */
async function attendreLaPageSuivante(page, precedents) {
  const fin = Date.now() + ouverture.delaiPageSuivanteMs;
  let vue = null;
  for (;;) {
    vue = await lire(page, LIRE_LA_LISTE);
    const j = jugerListe(vue);
    if (j.verdict === 'connexion') return { verdict: 'connexion', vue };
    const numeros = numerosDe(vue);
    if (j.verdict === 'liste' && numeros.length && JSON.stringify(numeros) !== JSON.stringify(precedents)) {
      await page.waitForTimeout(STABLE_MS).catch(() => {});
      const relue = await lire(page, LIRE_LA_LISTE);
      if (JSON.stringify(numerosDe(relue)) === JSON.stringify(numeros)) return { verdict: 'liste', vue: relue };
    }
    if (Date.now() >= fin) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  const numeros = numerosDe(vue);
  if (numeros.length && JSON.stringify(numeros) === JSON.stringify(precedents)) return { verdict: 'identique', vue };
  return { verdict: 'attente', vue };
}

// ---------------------------------------------------------------------------
// Navigation, impression
// ---------------------------------------------------------------------------

/**
 * La seule navigation : la liste, ou un détail dont l'adresse a passé
 * `adresseDuDetail`. Une adresse qui porte un mot refusé ne part jamais.
 */
async function naviguer(page, adresse) {
  const mot = refusees.motRefuse(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot refusé « ${mot} »).`);
  if (adresse !== URL_LISTE && adresseDuDetail(adresse).refus) {
    throw new Error(`${ID} : une adresse qui n'est pas celle d'un détail d'achat ne se suit jamais.`);
  }
  try {
    await page.goto(adresse, { waitUntil: 'domcontentloaded' });
    return null;
  } catch (err) {
    return normaliser(err?.message).split(' Call log')[0].slice(0, 160);
  }
}

/**
 * Ouvre le détail dans un onglet de la session, attend qu'il soit celui de
 * CET achat, et l'imprime SANS RIEN Y CHANGER. L'onglet est refermé quoi qu'il
 * arrive.
 *
 * @returns {Promise<{ok: true, buffer: Buffer}|{ok: false, session?: boolean, grief: string}>}
 */
async function imprimerLeDetail(context, achat) {
  const onglet = await context.newPage();
  try {
    onglet.setDefaultTimeout(NAV_TIMEOUT_MS);
    const erreur = await naviguer(onglet, achat.adresse);
    const attente = await attendreLeDetail(onglet, achat);
    if (attente.verdict === 'connexion') return { ok: false, session: true, grief: attente.raison };
    if (attente.verdict !== 'detail') {
      return { ok: false, grief: `${attente.raison}${erreur ? ` (chargement : ${erreur})` : ''}` };
    }
    let octets = null;
    try {
      octets = await onglet.pdf({ format: 'A4', printBackground: true });
    } catch (err) {
      return { ok: false, grief: `n'a pas pu être rendue en PDF (${normaliser(err?.message).replace(/\d/g, '#').slice(0, 80)})` };
    }
    const juge = ongletPdf.jugerLesOctets(octets);
    return juge.ok ? { ok: true, buffer: juge.buffer } : { ok: false, grief: `rendue, ${juge.grief}` };
  } finally {
    await onglet.close().catch(() => {});
  }
}

/**
 * Attend que la carte de CET achat soit dessinée (R2, lot 105), bornée par
 * `ouverture.delaiDetailMs`. Un écart sur une carte dessinée ne conclut que
 * s'il tient `STABLE_ECART_MS` ; à la borne, le grief dit où en était la
 * carte. Dans les deux cas, la FORME de ce qui a été lu — jamais la valeur.
 * Ne lève jamais.
 *
 * @returns {Promise<{verdict: 'detail'|'connexion'|'autre'|'ecart'|'attente', raison: string}>}
 */
async function attendreLeDetail(onglet, achat) {
  const debut = Date.now();
  let vue = null;
  let jugement = null;
  let ecart = null;
  for (;;) {
    vue = await lire(onglet, LIRE_LE_DETAIL);
    jugement = jugerDetail(vue, achat);
    if (jugement.verdict === 'connexion' || jugement.verdict === 'autre' || jugement.verdict === 'detail') return jugement;
    if (jugement.verdict === 'ecart') {
      const lu = sansEspaces(vue.valeur);
      if (!ecart || ecart.lu !== lu) ecart = { lu, depuis: Date.now() };
      if (Date.now() - ecart.depuis >= STABLE_ECART_MS) {
        return { verdict: 'ecart', raison: `${jugement.raison} (${formeDuNumero(vue)})` };
      }
    } else {
      ecart = null;
    }
    if (Date.now() - debut >= ouverture.delaiDetailMs) {
      return { verdict: 'attente', raison: `${jugement.raison} après ${Math.round(ouverture.delaiDetailMs / 1000)} s (${formeDuNumero(vue)})` };
    }
    await onglet.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
}

/** Le lancement du navigateur, l'horloge et les attentes : les seuls points remplaçables. */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
  delaiDessinMs: DELAI_DESSIN_MS,
  delaiDetailMs: DELAI_DETAIL_MS,
  delaiPageSuivanteMs: DELAI_PAGE_SUIVANTE_MS,
};

async function surLeCompte(config, ctx, fn) {
  const log = journalDe(ctx);
  const session = lireSession(config);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    navigation.brancher(page, { log, prefixe: `${ID} : navigation` });
    return await fn(page, context);
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

function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre compte, mais crabe n'a pas su lire l'historique de vos achats : la page ne `
      + 'ressemble plus à celle qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la rouvrir. '
      + 'Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

/** Rejoint la liste et JUGE l'arrivée ; lève sur un renvoi, un mur, une page illisible. */
async function arriverSurLaListe(page, log) {
  const erreur = await naviguer(page, URL_LISTE);
  if (erreur) log(`${ID} : le chargement de la liste a échoué — ${erreur}.`);
  const arrivee = await attendreLaListe(page);
  log(`${ID} : arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
  if (arrivee.verdict === 'connexion') throw profilMarchand.erreurRenvoiVersAuthentification(NOM, arrivee.raison);
  if (arrivee.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (arrivee.verdict !== 'liste') throw erreurPageIllisible(arrivee.raison);
  return arrivee.vue;
}

/**
 * Toutes les pages de la liste, par le seul geste permis. Rend les achats lus,
 * le nombre de pages, ce qui a arrêté la lecture, et si la session est tombée.
 */
async function lireToutesLesPages(page, premiere, log) {
  const achats = [];
  let ecartees = 0;
  let vue = premiere;
  let pages = 0;
  let precedents = null;
  let pagination = null;
  let session = false;
  const vus = new Set();
  for (;;) {
    pages += 1;
    const numeros = numerosDe(vue);
    const lu = achatsDeLaPage(vue.lignes);
    ecartees += lu.ecartees.length;
    for (const e of lu.ecartees) log(`${ID} : page ${pages}, ligne ${e.rang + 1} écartée — ${e.raison}.`);
    const aRequete = lu.achats.filter((a) => a.requete).length;
    if (aRequete) {
      log(`${ID} : page ${pages} — ${aRequete} lien(s) de détail porteur(s) d'une requête, paramètre(s) : `
        + `${lu.parametres.join(', ') || 'aucun nom'} ; la requête est retirée, seul le chemin est suivi.`);
    }
    for (const a of lu.achats) {
      const ancre = remoteIdDe(a);
      if (!vus.has(ancre)) {
        vus.add(ancre);
        achats.push(a);
      }
    }
    log(`${ID} : page ${pages} lue — ${vue.lignes.length} ligne(s), ${lu.achats.length} achat(s) lisible(s).`);
    const decision = decisionPagination({ n: pages, numeros, precedents, suivant: vue.suivant, courante: vue.courante, pages: vue.pages });
    if (decision !== 'suivante') {
      if (decision === 'identique' || decision === 'borne') pagination = decision;
      log(`${ID} : pagination — ${decision}.`);
      break;
    }
    const clic = await cliquerSuivant(page, numeros);
    if (!clic.clique) {
      pagination = 'absent';
      log(`${ID} : « Suivant » non cliqué — ${clic.raison}.`);
      break;
    }
    const suite = await attendreLaPageSuivante(page, numeros);
    if (suite.verdict === 'connexion') {
      session = true;
      break;
    }
    if (suite.verdict !== 'liste') {
      pagination = suite.verdict === 'identique' ? 'identique' : 'attente';
      log(`${ID} : après « Suivant » — ${suite.verdict}.`);
      break;
    }
    precedents = numeros;
    vue = suite.vue;
  }
  return { achats, ecartees, pages, pagination, session };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : l'historique s'affiche au compte connecté. Aucun geste. */
async function test(config, ctx = {}) {
  const log = journalDe(ctx);
  return surLeCompte(config, ctx, async (page) => {
    const vue = await arriverSurLaListe(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — l'historique de vos achats ${NOM} s'affiche (${pluriel(vue.lignes.length, 'achat', 'achats')} `
        + 'sur la première page). Ils seront enregistrés à la prochaine récupération.',
    };
  });
}

/**
 * Les achats, en deux temps : LIRE toutes les pages de la liste (le seul
 * geste : « Suivant »), puis IMPRIMER le détail de chaque achat manquant. Ce
 * qui est pris est GARDÉ quoi qu'il arrive ensuite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = journalDe(ctx);
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const premiere = await arriverSurLaListe(page, log);
    const lecture = await lireToutesLesPages(page, premiere, log);
    if (lecture.session && !lecture.achats.length) {
      throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en lisant la liste');
    }
    const bilan = {
      lus: lecture.achats.length,
      pages: lecture.pages,
      deja: 0,
      horsPeriode: 0,
      ecartees: lecture.ecartees,
      pagination: lecture.pagination,
      illisibles: 0,
      restantes: 0,
      interruption: lecture.session ? 'session' : null,
    };

    ctx.preuveDeListe?.({
      session: 'historique des achats servi au compte connecté (en-tête « authenticated », titre « Historique des achats »)',
      liste: URL_LISTE,
      elements: bilan.lus,
    });

    const aPrendre = [];
    for (const a of lecture.achats) {
      if (connus.has(remoteIdDe(a))) {
        bilan.deja++;
      } else if (!scraping.dansLaFenetre(a.issuedOn, plan)) {
        bilan.horsPeriode++;
      } else {
        aPrendre.push(a);
      }
    }
    log(`${ID} : liste lue — ${lecture.pages} page(s), ${bilan.lus} achat(s), ${bilan.ecartees} ligne(s) écartée(s) ; `
      + `${bilan.deja} déjà dans l'archive, ${aPrendre.length} à enregistrer, ${bilan.horsPeriode} hors période.`);

    const invoices = [];
    let tentes = 0;
    if (!lecture.session) {
      for (const [i, achat] of aPrendre.entries()) {
        if (ouverture.maintenant() > echeance) {
          bilan.interruption = 'temps';
          break;
        }
        tentes++;
        const qui = `achat ${i + 1} sur ${aPrendre.length}`;
        const rendu = await imprimerLeDetail(context, achat);
        if (rendu.ok) {
          invoices.push({ ...achat, buffer: rendu.buffer });
          log(`${ID} : ${qui} — détail imprimé en PDF (${rendu.buffer.length} octets).`);
          continue;
        }
        if (rendu.session) {
          tentes--;
          if (!invoices.length) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en ouvrant un détail');
          bilan.interruption = 'session';
          log(`${ID} : renvoyé vers la connexion : ${pluriel(invoices.length, 'document déjà pris est gardé', 'documents déjà pris sont gardés')}.`);
          break;
        }
        bilan.illisibles++;
        log(`${ID} : ${qui} — pas enregistré : ${rendu.grief}.`);
      }
    }
    bilan.restantes = aPrendre.length - tentes;
    const manquees = bilan.illisibles + (bilan.interruption === 'session' ? bilan.restantes : 0);

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((a, i) => ({ remoteId: remoteIdDe(a), filename: noms[i], issuedOn: a.issuedOn, buffer: a.buffer })),
      couverture: {
        complete: !bilan.interruption && !manquees && !bilan.pagination,
        detail: `l'historique des achats, ${pluriel(bilan.pages, 'page', 'pages')}, ${pluriel(bilan.lus, 'achat', 'achats')}`,
      },
    };
    if (manquees) sortie.manquees = manquees;
    if (!bilan.lus) {
      sortie.aucunDocument = `Votre historique d'achats ${NOM} a bien été lu : il ne contient aucun achat pour l'instant.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'achat');
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: manquees > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.lus} achat(s) lu(s) sur ${bilan.pages} page(s), ${invoices.length} imprimé(s), `
      + `${bilan.deja} déjà dans l'archive, ${bilan.illisibles} détail(s) illisible(s), ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${bilan.pagination ? ` — pagination : ${bilan.pagination}` : ''}.`);

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
  pourLeJournal,
  adresseDuDetail,
  achatsDeLaPage,
  decisionPagination,
  remoteIdDe,
  nommer,
  jugerListe,
  jugerDetail,
  formeDuNumero,
  sansEspaces,
  precisionDuPassage,
  fenetre,
  budgetMs,
  cliquerSuivant,
  GESTES,
  REPERE_SUIVANT,
  URL_LISTE,
  HOTE,
  PAGES_MAX,
  DELAI_DETAIL_MS,
  STABLE_ECART_MS,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
