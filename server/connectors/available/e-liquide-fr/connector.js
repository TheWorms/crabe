'use strict';

/**
 * Connecteur e-liquide-fr — boutique Oxatis : la liste des commandes, servie
 * par l'envoi du formulaire de la page « Mon compte », et chaque facture — une
 * PAGE du site — rendue en PDF par le navigateur, telle que le site la sert
 * (lot 99 ; le vrai formulaire de la page d'arrivée, lot 100).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la page des commandes et d'une facture,
 * enregistrés connecté par l'utilisateur le 11/10/2026, dont le prompt du lot 99 a
 * repris la STRUCTURE, sans aucune donnée :
 *
 *   - connexion à `https://www.e-liquide-fr.com/PBUserLogin.asp?CCode=33`
 *     (`meta name="generator"` « Oxatis ») ; connecté, la balise `html` porte
 *     la classe `is-user-logged` ; la déconnexion est un bouton
 *     `ng-click="logout()"` — JAMAIS touché ;
 *   - la liste est servie par `PBUserAccount.asp` en réponse à l'envoi du
 *     formulaire `form[name=MForm]` (POST, action `PBUserAccount.asp`) avec le
 *     champ caché `ActionID` à `8` (« Suivi des commandes »). Champs cachés
 *     mesurés SUR LA PAGE « Suivi des commandes » — celle qui était
 *     enregistrée, déjà passée par l'envoi : `ActionID`, `OrderID`,
 *     `OrdersPageIdx` (`1`), `ReloadMode` (`0`), `PagingAPIRowCount` (`5`),
 *     `PagingAPIHashCode`. L'adresse affichée après l'envoi est
 *     `PBUserAccount.asp` tout court ;
 *   - un tableau `table.PBTable` (Numéro `span.PBNumber`, Date `span.PBDate`
 *     « 3 mars 2025 », Montant TTC, Etat), une ligne par commande et ses
 *     actions : « détail » (`WNDAPIOpenWindow('InvoiceWnd','PBRenderInvoice.asp?…')`),
 *     « historique » (`SelectItem(<n>,9)`), « facture »
 *     (`WNDAPIOpenWindow('InvoiceView','Files/<n>/Orders/<n>/Invoice-AAAA-MM-<n>.htm',…)`)
 *     et « Recharger » (`/PBShoppingCart.asp?ReloadOrderID=<n>`) — JAMAIS ;
 *   - la facture : une page HTML statique sous `/Files/…/Invoice-….htm`, en
 *     `windows-1252`, titre « Facture », les tableaux `#InvoiceAddress`,
 *     `#InvoiceOrder`, `#InvoiceBody` et les mentions du vendeur.
 *
 * MESURÉ AU LOT 100 — la page d'ARRIVÉE, celle que `PBUserAccount.asp` sert en
 * lecture directe (code source enregistré connecté par l'utilisateur, adresse tapée ;
 * l'essai réel du 11/10 l'a rencontrée) : titre « Mon Compte »,
 * `html.is-user-logged`, ISO-8859-1, `#maincontainer` de classes `useraccount
 * userdashboard`, aucun `table.PBTable`. Son `MForm` (POST, action
 * `PBUserAccount.asp`) ne porte que `ActionID` (caché, `0`) et `DiscountCoupon`
 * (texte, le code promotionnel, vide) — aucun champ de pagination, ni
 * `ReloadMode`, ni `OrderID`. Le menu `ul.menulist` est fait de
 * `javascript:SubmitAction(N,null,0,null,1)` : « Suivre vos commandes » (8),
 * « Recharger une commande… » (10, JAMAIS), et les autres (2, 20, 6, 5, 18, 1,
 * et 11 pour le code promotionnel) — aucun n'est jamais exécuté. Le lot 99
 * avait prêté à cette page le formulaire de la page suivante : sa garde a
 * refusé d'envoyer (« ReloadMode autre que 0 »), et c'était juste.
 *
 * NON MESURÉ : ce que `SubmitAction` ajoute au formulaire avant l'envoi (son
 * code n'est pas dans la page enregistrée ; l'hypothèse retenue : il pose
 * `ActionID` et envoie `MForm`) ; comment la liste passe d'une page à l'autre
 * (aucun lien de page suivante n'est resté dans le code enregistré) ; le
 * message du site pour une liste vide ; si les pages `.htm` exigent la session.
 *
 * ─── Le seul envoi : deux formulaires, deux règles, une fonction (R1) ────────
 *
 * UNE fonction envoie `MForm` — `ENVOYER_LE_FORMULAIRE`, exécutée dans la page,
 * d'un seul tenant : elle relit le formulaire AU MOMENT DE L'ENVOI, reconnaît
 * DANS QUELLE PAGE elle se trouve, et n'applique que la règle de cette page.
 * Toujours : vers `https://www.e-liquide-fr.com/PBUserAccount.asp` en POST, dans
 * la page même, les champs restés tels que la page les a servis (mêmes noms,
 * valeurs et ordre que la lecture qui précède), `ActionID` mis à `8`, aucun
 * champ ajouté. Puis :
 *
 *   - page d'ARRIVÉE (`#maincontainer.userdashboard`, pas de `table.PBTable`,
 *     aucun champ de pagination) : `MForm` ne porte que `ActionID` (servi à
 *     `0`) et `DiscountCoupon`, qui doit être VIDE — et, s'ils y sont,
 *     `ReloadMode` (`0`) et `OrderID` (vide ou nul) ; seul `ActionID` change ;
 *   - page « Suivi des commandes » (`table.PBTable`) : la règle du lot 99 —
 *     `ReloadMode` à `0`, `OrderID` vide ou nul, seuls `ActionID` et
 *     `OrdersPageIdx` changent ;
 *   - toute autre forme : rien ne part ; les NOMS des champs vus (jamais leurs
 *     valeurs) vont au journal, et la page est dite illisible.
 *
 * Au moindre écart, rien ne part. Aucun script de la page ne peut s'intercaler
 * entre ce contrôle et l'envoi : ils tiennent dans la même exécution. Si
 * l'envoi parti de la page d'arrivée ne mène pas au tableau des commandes,
 * crabe s'arrête sans rien renvoyer, et le journal dit le titre de la page
 * reçue et les noms des champs de son formulaire (R3) : c'est ce qui dira si
 * `SubmitAction` faisait plus que poser `ActionID`.
 *
 * Les pages suivantes (règle du R4 du lot 99, faute de mesure) : tant que la
 * page lue montre autant de lignes que `PagingAPIRowCount` — lu sur la page
 * des commandes, la seule qui le porte (R2) —, la suivante est demandée par
 * son formulaire, `OrdersPageIdx` augmenté ; la lecture s'arrête dès qu'une
 * page est vide, plus courte, ou identique à la précédente (mêmes numéros) —
 * et alors l'écran dit « pages suivantes non lues » —, et jamais au-delà de
 * `PAGES_MAX` pages.
 *
 * ─── La facture est une page : crabe l'imprime (R3) ──────────────────────────
 *
 * L'adresse de chaque facture est tirée de l'appel `WNDAPIOpenWindow` du lien
 * « facture » PAR LECTURE DU TEXTE — ce `javascript:` n'est jamais exécuté.
 * Elle doit rester sur la boutique, sous `/Files/`, finir par `.htm`, sans
 * paramètre ni mot interdit. Elle s'ouvre dans un onglet de la session ; la
 * page doit être une facture (titre « Facture », `#InvoiceBody`) ; elle est
 * alors rendue en PDF par le navigateur (`page.pdf`, A4, fonds compris), SANS
 * RIEN Y CHANGER : c'est le document du vendeur, pas une reconstitution.
 * L'onglet est refermé. `page.pdf` n'existe que dans un Chromium sans écran
 * (Playwright 1.62.1) — c'est le mode de ce connecteur.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `e-liquide-fr-facture-<numéro>` — le numéro lu dans le nom du fichier
 * `Invoice-<numéro>.htm` —, à défaut `e-liquide-fr-commande-<n°>` (le numéro de
 * la ligne). Date : celle de la ligne (à défaut, le mois du nom du fichier).
 * Nom : `e-liquide-fr_AAAA-MM_<numéro>.pdf`, jamais deux fois le même.
 *
 * ─── Le temps, et « Depuis la dernière récupération » ────────────────────────
 *
 * Comme Gandi (lot 93) : arrêt de lui-même aux deux tiers de la limite
 * d'exécution, ce qui est pris est rendu ; « Depuis la dernière
 * récupération » prend tout ce qui manque à l'archive.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const history = require('../../history');
const pageDocs = require('../../documents-de-page');
const ongletPdf = require('../../onglet-pdf');
const navigation = require('../../releve-navigation');
const profilMarchand = require('../../profil-marchand');
const serieEchecs = require('../../serie-echecs');
const interdites = require('../../adresses-interdites');

const ID = 'e-liquide-fr';
const NOM = 'e-liquide-fr';

const HOTE = 'www.e-liquide-fr.com';
/** La page « Mon compte », qui porte le formulaire `MForm` (non mesuré en lecture directe). */
const URL_COMPTE = 'https://www.e-liquide-fr.com/PBUserAccount.asp';
/** L'adresse où le formulaire part, et nulle part ailleurs (R4). */
const ACTION_ATTENDUE = 'https://www.e-liquide-fr.com/PBUserAccount.asp';
/** « Suivi des commandes » (mesuré). */
const ACTION_SUIVI = '8';

/**
 * Les champs de pagination de `MForm` — mesurés sur la page « Suivi des
 * commandes », absents de la page d'arrivée (lot 100). Un seul d'entre eux
 * suffit à dire qu'un formulaire n'est pas celui de l'arrivée.
 */
const CHAMPS_PAGINATION = Object.freeze(['OrdersPageIdx', 'PagingAPIRowCount', 'PagingAPIHashCode']);

/**
 * Les seuls champs que `MForm` peut porter sur la page d'arrivée (lot 100) :
 * `ActionID` et `DiscountCoupon` (mesurés), `ReloadMode` et `OrderID` (permis
 * s'ils y paraissent, aux valeurs du lot 99). Tout autre nom : rien ne part.
 */
const CHAMPS_ARRIVEE = Object.freeze(['ActionID', 'DiscountCoupon', 'ReloadMode', 'OrderID']);

/** La valeur mesurée de `PagingAPIRowCount`, quand le formulaire n'en dit rien de lisible. */
const LIGNES_PAR_PAGE_DEFAUT = 5;

/**
 * Combien de pages de commandes au plus. Une borne contre une pagination qui
 * tournerait sans jamais se répéter à l'identique, pas une limite attendue :
 * cinquante pages de cinq, ce sont deux cent cinquante commandes — plus de
 * vingt ans de commandes mensuelles —, pour moins de deux minutes de lecture.
 * La même borne que Gandi. Atteinte, elle se dit.
 */
const PAGES_MAX = 50;

const CHAMP_SESSION = 'session';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attendre que la page se pose — borné, un site bavard ne doit pas tout coûter. */
const DELAI_REPOS_MS = 15_000;

/** La limite d'une exécution (lot 67), relue comme le planificateur la relit. */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;

/** La part de cette limite que le connecteur s'accorde, comme Gandi. */
const PART_DU_TEMPS = 2 / 3;

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

/** Un texte dicible au journal : chaque chiffre d'un chemin est masqué. Pure. */
function masquer(texte) {
  return String(texte ?? '').replace(/(\/[^\s;]*)/g, (chemin) => chemin.replace(/\d/g, '#'));
}

/**
 * Les NOMS des champs d'un formulaire, dicibles au journal — jamais leurs
 * valeurs (lot 100). Un nom garde ses lettres, ses chiffres et `_ . : -` ; une
 * suite de quatre chiffres ou plus est masquée ; trente noms au plus. Pure.
 */
function nomsDicibles(noms) {
  const liste = (Array.isArray(noms) ? noms : []).map((nom) => String(nom ?? '')
    .replace(/[^A-Za-z0-9_.:-]/g, '?').replace(/\d{4,}/g, '#').slice(0, 40) || '(sans nom)');
  if (!liste.length) return 'aucun';
  return liste.length > 30 ? `${liste.slice(0, 30).join(', ')}, … (${liste.length} en tout)` : liste.join(', ');
}

/**
 * Ce que montre une page reçue, dicible au journal (R3, lot 100) : son titre
 * — chiffres masqués, une adresse électronique retirée — et les noms des
 * champs de son `MForm`. Pure.
 */
function pageRecue(vue) {
  const titre = String(vue?.titre ?? '').replace(/\s+/g, ' ').trim()
    .replace(/[^\s@]+@[^\s@]+/g, '…').replace(/\d/g, '#').slice(0, 80);
  const formulaire = vue?.formulaire
    ? `champs de MForm : ${nomsDicibles((vue.formulaire.champs || []).map((c) => c.nom))}`
    : 'aucun formulaire MForm';
  return `page « ${titre || 'sans titre'} », ${formulaire}`;
}

/**
 * L'appel du lien « facture », LU comme un texte — jamais exécuté :
 * `javascript:WNDAPIOpenWindow('InvoiceView','Files/…/Invoice-….htm',…)`.
 * Rend le second argument (le chemin de la facture), ou `null` pour tout autre
 * lien — « détail » (`InvoiceWnd`), « historique » (`SelectItem`),
 * « Recharger ». Pure.
 */
const MOTIF_APPEL_FACTURE = /^\s*javascript\s*:\s*WNDAPIOpenWindow\s*\(\s*(['"])InvoiceView\1\s*,\s*(['"])([^'"]{1,400})\2/i;

function cheminDeLAppel(href) {
  const m = MOTIF_APPEL_FACTURE.exec(String(href ?? ''));
  return m ? m[3] : null;
}

/**
 * L'adresse d'une facture, depuis le chemin tiré de l'appel : sur la boutique,
 * en https, sous `/Files/`, finissant par `.htm`, sans paramètre, sans « .. »,
 * sans mot interdit. Rend l'adresse absolue et le numéro lu dans le nom du
 * fichier (`Invoice-<numéro>.htm`, `null` si le nom n'a pas cette forme), ou
 * `{refus}` pour un mot interdit, ou `null`. Pure.
 *
 * @returns {{adresse: string, numeroFacture: string|null, mois: string|null}|{refus: string}|null}
 */
function adresseDeFacture(chemin, base = URL_COMPTE) {
  const brut = String(chemin ?? '');
  if (!brut || brut.includes('..') || /^\s*javascript:/i.test(brut)) return null;
  const mot = interdites.motInterdit(brut);
  if (mot) return { refus: mot };
  let u;
  try {
    u = new URL(brut, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== HOTE) return null;
  if (u.search || u.hash) return null;
  if (!u.pathname.startsWith('/Files/') || !/\.htm$/i.test(u.pathname)) return null;
  const motResolu = interdites.motInterdit(u.href);
  if (motResolu) return { refus: motResolu };
  let fichier = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  try {
    fichier = decodeURIComponent(fichier);
  } catch {
    return null;
  }
  const nom = /^Invoice-([A-Za-z0-9_-]{1,40})\.htm$/i.exec(fichier);
  const mois = nom ? /^(\d{4})-(\d{2})-/.exec(nom[1]) : null;
  return {
    adresse: u.href,
    numeroFacture: nom ? nom[1] : null,
    mois: mois && Number(mois[2]) >= 1 && Number(mois[2]) <= 12 ? `${mois[1]}-${mois[2]}` : null,
  };
}

/** Revérifie, JUSTE AVANT l'ouverture, l'adresse d'une facture. Pure. */
function verifierAdresseFacture(adresse) {
  const lue = adresseDeFacture(adresse);
  if (!lue) return { ok: false, raison: 'hors de la forme d\'une adresse de facture (/Files/…/….htm sur la boutique)' };
  if (lue.refus) return { ok: false, raison: `mot interdit « ${lue.refus} »` };
  if (lue.adresse !== adresse) return { ok: false, raison: 'adresse différente de celle lue dans la page' };
  return { ok: true };
}

/** Un numéro de commande dicible dans une ancre et un nom de fichier, ou `null`. Pure. */
function numeroSur(texte) {
  const n = String(texte ?? '').replace(/\s+/g, '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(n) ? n : null;
}

/** Est-ce la page de connexion d'Oxatis ? (`/PBUserLogin.asp` — que le motif commun ne reconnaît pas.) Pure. */
function estPageDeConnexion(url) {
  try {
    return /^\/PBUserLogin\.asp$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

/**
 * La page « Mon compte » : connecté (`html.is-user-logged`) et porteuse du
 * formulaire `MForm`. Une page de connexion, ou une page sans la classe du
 * compte connecté, est un renvoi vers la connexion (R5). Pure.
 *
 * @returns {{verdict: 'compte'|'connexion-demandee'|'mur'|'page-illisible', raison: string}}
 */
function jugerCompte(vue) {
  let u;
  try {
    u = new URL(String(vue?.url || ''));
  } catch {
    return { verdict: 'page-illisible', raison: 'adresse finale illisible' };
  }
  if (vue?.mur) return { verdict: 'mur', raison: 'vérification de sécurité du site à l\'écran' };
  if (u.hostname !== HOTE) return { verdict: 'page-illisible', raison: `arrivé sur ${u.hostname}, hors de la boutique` };
  if (estPageDeConnexion(u.href) || vue?.motDePasse) {
    return { verdict: 'connexion-demandee', raison: `renvoyé vers ${masquer(u.pathname)}, la page de connexion` };
  }
  if (!vue?.connecte) {
    return { verdict: 'connexion-demandee', raison: `la page ${masquer(u.pathname)} ne porte pas la classe du compte connecté (is-user-logged)` };
  }
  if (!vue?.formulaire) return { verdict: 'page-illisible', raison: `la page ${masquer(u.pathname)} ne porte pas le formulaire MForm de « Mon compte »` };
  return { verdict: 'compte', raison: 'page « Mon compte » d\'un compte connecté (is-user-logged, formulaire MForm)' };
}

/**
 * La page servie par l'envoi : connecté, et le tableau `table.PBTable` des
 * commandes (R5). Pure.
 *
 * @returns {{verdict: 'liste'|'connexion-demandee'|'mur'|'page-illisible', raison: string}}
 */
function jugerListe(vue) {
  const compte = jugerCompte({ ...vue, formulaire: true });
  if (compte.verdict !== 'compte') return compte;
  if (!vue?.tableau) return { verdict: 'page-illisible', raison: 'la page servie ne porte pas le tableau des commandes (table.PBTable)' };
  return { verdict: 'liste', raison: 'tableau des commandes d\'un compte connecté (is-user-logged, table.PBTable)' };
}

/**
 * La facture ouverte dans son onglet : restée à son adresse, titre
 * « Facture », `#InvoiceBody` présent (R3). Une page de connexion est un
 * renvoi ; toute autre chose n'est pas une facture, et rien n'est déposé. Pure.
 *
 * @returns {{verdict: 'facture'|'connexion-demandee'|'pas-une-facture', raison: string}}
 */
function jugerFacture(vue, adresse) {
  let u;
  try {
    u = new URL(String(vue?.url || ''));
  } catch {
    return { verdict: 'pas-une-facture', raison: 'adresse finale illisible' };
  }
  if (u.hostname === HOTE && (estPageDeConnexion(u.href) || vue?.motDePasse)) {
    return { verdict: 'connexion-demandee', raison: 'la facture a renvoyé vers la page de connexion' };
  }
  const finale = `${u.origin}${u.pathname}`;
  if (finale !== adresse) return { verdict: 'pas-une-facture', raison: 'la page s\'est ouverte ailleurs qu\'à l\'adresse de la facture' };
  const manques = [
    ...(/^\s*facture\b/i.test(String(vue?.titre || '')) ? [] : ['le titre « Facture »']),
    ...(vue?.corps ? [] : ['le tableau #InvoiceBody']),
  ];
  if (manques.length) return { verdict: 'pas-une-facture', raison: `la page n'a pas ${manques.join(' ni ')}` };
  return { verdict: 'facture', raison: 'titre « Facture » et tableau #InvoiceBody' };
}

/**
 * Faut-il demander la page suivante ? La règle du R4 : seulement si la page
 * lue montre exactement `lignesParPage` lignes ; une page identique à la
 * précédente (mêmes numéros), vide ou plus courte arrête la lecture ; jamais
 * au-delà de `PAGES_MAX`. Pure.
 *
 * @returns {'suivante'|'identique'|'vide'|'fin'|'borne'}
 */
function decisionPagination({ n, lues, lignesParPage, numeros = [], precedents = null, pagesMax = PAGES_MAX }) {
  if (Array.isArray(precedents) && precedents.length && numeros.length === precedents.length
    && numeros.every((x, i) => x === precedents[i])) return 'identique';
  if (!lues) return 'vide';
  if (lues !== lignesParPage) return 'fin';
  if (n >= pagesMax) return 'borne';
  return 'suivante';
}

/** `PagingAPIRowCount` tel que le formulaire le sert, s'il est lisible ; sinon la valeur mesurée. Pure. */
function lignesParPageDe(formulaire) {
  const champ = (formulaire?.champs || []).find((c) => c.nom === 'PagingAPIRowCount');
  const n = Number.parseInt(champ?.valeur ?? '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
}

/** L'ancre d'une facture : son numéro lu dans le nom du fichier, à défaut le numéro de la ligne. Pure. */
function remoteIdDe(doc) {
  return doc.numeroFacture ? `${ID}-facture-${doc.numeroFacture}` : `${ID}-commande-${doc.numeroCommande}`;
}

/** Les noms de fichier d'un passage, jamais deux fois le même. Pure. */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-${d.numeroFacture || d.numeroCommande}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/** Pourquoi les pages suivantes n'ont pas été lues, tel que l'écran le dit. */
const PAGES_NON_LUES = {
  identique: 'Pages suivantes non lues : quand crabe a demandé la page suivante, la boutique a renvoyé la même. '
    + 'Signalez-le pour que la lecture soit mise à jour.',
  borne: `Pages suivantes non lues : crabe s'arrête à ${PAGES_MAX} pages de commandes. `
    + 'Signalez-le, la limite est trop basse pour ce compte.',
  echec: 'Pages suivantes non lues : la page suivante n\'a pas pu être obtenue. '
    + 'Signalez-le pour que la lecture soit mise à jour.',
};

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures (R7) : les
 * commandes lues et le nombre de pages, celles déjà dans l'archive, celles
 * sans facture, et ce qui a arrêté la lecture. Des nombres, jamais un numéro.
 * Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')} `
      + `sur ${pluriel(b.pages, 'page', 'pages')}`
      + (b.deja ? `, ${pluriel(b.deja, 'facture déjà dans vos documents', 'factures déjà dans vos documents')}` : '')
      + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture', 'commandes sans facture')}` : '')
      + '.');
  }
  if (b.pagesNonLues && PAGES_NON_LUES[b.pagesNonLues]) phrases.push(PAGES_NON_LUES[b.pagesNonLues]);
  if (b.ecartes) {
    phrases.push(`${b.ecartes > 1 ? `${b.ecartes} liens ont été écartés : ils ne menaient` : 'Un lien a été écarté : il ne menait'} `
      + 'pas à une facture de la boutique.');
  }
  if (b.interruption === 'temps') {
    const reste = b.restantes && !b.lectureInterrompue
      ? (b.restantes > 1
        ? `${b.restantes} factures attendent encore ; elles viendront au prochain passage.`
        : '1 facture attend encore ; elle viendra au prochain passage.')
      : 'la suite viendra au prochain passage.';
    phrases.push(`La récupération a pris tout le temps permis : ${reste} Rien de ce qui a été pris n'est perdu.`);
  }
  if (b.interruption === 'session') {
    phrases.push(`La lecture s'est interrompue — ${NOM} a demandé de vous reconnecter : les factures déjà prises sont gardées. `
      + `Reconnectez-vous depuis la fiche d'${NOM} pour récupérer la suite.`);
  }
  return phrases.join(' ');
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans les pages — des lectures, jamais un geste
// ---------------------------------------------------------------------------

/**
 * La page affichée : son titre, connectée ou non, un champ de mot de passe
 * visible, le formulaire `MForm` tel qu'il partirait (adresse, méthode, cible,
 * et chaque champ envoyé : nom, type, valeur), et le tableau des commandes —
 * une commande par ligne qui porte `span.PBNumber`, les lignes suivantes sans
 * numéro lui rattachant leurs liens. Les liens sont lus comme du TEXTE
 * (`getAttribute`) : un `javascript:` n'est jamais exécuté.
 */
const LIRE_LA_PAGE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const elementsDe = (f) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(f);
  const champsDe = (f) => [...elementsDe(f)].filter((e) => {
    if (!e.name || e.disabled) return false;
    const type = String(e.type || '').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return false;
    if ((type === 'checkbox' || type === 'radio') && !e.checked) return false;
    return true;
  }).map((e) => ({ nom: e.name, type: String(e.type || '').toLowerCase(), valeur: String(e.value ?? '') }));

  const form = document.querySelector('form[name="MForm"]');
  let formulaire = null;
  if (form) {
    let action = '';
    try {
      action = new URL(form.getAttribute('action') || '', location.href).href;
    } catch {
      action = '';
    }
    formulaire = {
      action,
      methode: String(form.getAttribute('method') || 'get').toLowerCase(),
      cible: form.getAttribute('target') || '',
      champs: champsDe(form),
    };
  }

  const table = [...document.querySelectorAll('table.PBTable')].find((t) => t.querySelector('span.PBNumber')) || null;
  const lignes = [];
  if (table) {
    let courante = null;
    for (const tr of table.querySelectorAll('tr')) {
      const numero = tr.querySelector('span.PBNumber');
      const liens = [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
      if (numero) {
        const date = tr.querySelector('span.PBDate');
        courante = { numero: norm(numero.textContent), dateTexte: date ? norm(date.textContent) : '', liens };
        lignes.push(courante);
      } else if (courante) {
        courante.liens.push(...liens);
      }
    }
  }
  return {
    url: location.href,
    titre: document.title,
    connecte: document.documentElement.classList.contains('is-user-logged'),
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    formulaire,
    tableau: !!table || !!document.querySelector('table.PBTable'),
    lignes,
  };
};

/** La facture ouverte : son adresse, son titre, `#InvoiceBody`, un champ de mot de passe. */
const LIRE_LA_FACTURE = () => ({
  url: location.href,
  titre: document.title,
  corps: !!document.querySelector('#InvoiceBody'),
  motDePasse: [...document.querySelectorAll('input[type="password"]')]
    .some((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)),
});

/**
 * LA SEULE FONCTION QUI ENVOIE `MForm` (R4 du lot 99, R1 du lot 100). Exécutée
 * dans la page, d'un seul tenant — aucun script du site ne peut s'intercaler
 * entre le contrôle et l'envoi. Elle relit le formulaire, reconnaît dans
 * quelle page elle se trouve, et ne l'envoie que si :
 *
 *   - il part en POST vers `action` (l'adresse attendue, exactement), dans la
 *     page elle-même, sans mot interdit dans son adresse ;
 *   - ses champs sont ceux lus juste avant (`servis`) : mêmes noms, mêmes
 *     valeurs, dans le même ordre — sinon un script les a changés ;
 *   - la page est l'une des deux connues, et la règle de CETTE page tient :
 *       · page d'ARRIVÉE (`#maincontainer.userdashboard`, pas de
 *         `table.PBTable`, aucun champ de `champsPagination`) : seuls les
 *         noms de `champsArrivee` ; `ActionID` présent une fois, servi à `0` ;
 *         `DiscountCoupon` présent une fois, VIDE ; `ReloadMode`, s'il y est,
 *         à `0` ; seul `ActionID` change ;
 *       · page « Suivi des commandes » (`table.PBTable`) : la règle du
 *         lot 99, `ReloadMode` à `0` (une fois) ; `ActionID` et
 *         `OrdersPageIdx` seuls changent ;
 *     et, sur les deux, `OrderID` vide ou nul ;
 *   - les champs modifiés sont des champs cachés présents une seule fois, mis
 *     à `8` (`ActionID`) et au numéro de page (`OrdersPageIdx`) ; rien n'est
 *     ajouté.
 *
 * Une forme inconnue rend aussi les NOMS des champs vus (jamais leurs valeurs),
 * pour le journal. Les propriétés du formulaire sont lues par le prototype : un
 * champ nommé `action`, `method`, `submit` ou `elements` masquerait sinon la
 * vraie.
 */
const ENVOYER_LE_FORMULAIRE = ({ servis, modifs, action, motsInterdits, actionSuivi, champsPagination, champsArrivee }) => {
  const refus = (raison, champs = null) => (champs ? { envoye: false, raison, champs } : { envoye: false, raison });
  const form = document.querySelector('form[name="MForm"]');
  if (!form) return refus('le formulaire MForm a disparu de la page');
  const elements = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form);
  const lire = () => [...elements].filter((e) => {
    if (!e.name || e.disabled) return false;
    const type = String(e.type || '').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return false;
    if ((type === 'checkbox' || type === 'radio') && !e.checked) return false;
    return true;
  }).map((e) => ({ nom: e.name, type: String(e.type || '').toLowerCase(), valeur: String(e.value ?? '') }));

  let adresse;
  try {
    adresse = new URL(form.getAttribute('action') || '', location.href).href;
  } catch {
    return refus('adresse d\'envoi illisible');
  }
  if (adresse !== action) return refus('adresse d\'envoi différente de PBUserAccount.asp sur la boutique');
  const bas = adresse.toLowerCase();
  const mot = (motsInterdits || []).find((m) => bas.includes(String(m).toLowerCase()));
  if (mot) return refus(`adresse d'envoi portant le mot interdit « ${mot} »`);
  if (String(form.getAttribute('method') || 'get').toLowerCase() !== 'post') return refus('méthode d\'envoi autre que POST');
  const cible = form.getAttribute('target');
  if (cible && cible !== '_self') return refus('envoi vers une autre fenêtre');

  const actuels = lire();
  if (JSON.stringify(actuels) !== JSON.stringify(servis)) return refus('un champ du formulaire a changé depuis sa lecture');
  const noms = actuels.map((c) => c.nom);

  // Dans quelle page (lot 100) ? La page des commandes porte leur tableau ; la
  // page d'arrivée, le tableau de bord du compte et aucun champ de pagination.
  // Rien d'autre n'est connu : rien ne part.
  const liste = !!document.querySelector('table.PBTable');
  const arrivee = !liste && !!document.querySelector('#maincontainer.userdashboard')
    && !noms.some((nom) => (champsPagination || []).includes(nom));
  if (!liste && !arrivee) return refus('forme de MForm inconnue', noms);

  const cles = Object.keys(modifs || {});
  if (cles.some((c) => c !== 'ActionID' && c !== 'OrdersPageIdx')) return refus('modification d\'un champ non permis');
  if (modifs.ActionID !== actionSuivi) return refus('ActionID autre que « Suivi des commandes »');
  if ('OrdersPageIdx' in modifs && !/^\d{1,4}$/.test(String(modifs.OrdersPageIdx))) return refus('numéro de page illisible');
  const valeurs = (nom) => actuels.filter((c) => c.nom === nom).map((c) => c.valeur);
  const reload = valeurs('ReloadMode');
  if (arrivee) {
    // La règle de la page d'arrivée « Mon compte » : ActionID passe de 0 à 8,
    // tout le reste part tel que servi ; un ReloadMode absent est permis.
    if (cles.length !== 1) return refus('sur la page d\'arrivée, seul ActionID change');
    if (noms.some((nom) => !(champsArrivee || []).includes(nom))) return refus('forme de MForm inconnue', noms);
    const actions = valeurs('ActionID');
    if (actions.length !== 1 || actions[0] !== '0') return refus('ActionID absent, en double ou autre que 0 sur la page d\'arrivée');
    const coupon = valeurs('DiscountCoupon');
    if (coupon.length !== 1) return refus('forme de MForm inconnue', noms);
    if (coupon[0] !== '') return refus('le code promotionnel (DiscountCoupon) n\'est pas vide');
    if (reload.length && (reload.length !== 1 || reload[0] !== '0')) return refus('ReloadMode autre que 0');
  } else if (reload.length !== 1 || reload[0] !== '0') {
    return refus('ReloadMode autre que 0');
  }
  const commande = valeurs('OrderID');
  if (commande.length > 1 || (commande.length === 1 && commande[0] !== '' && commande[0] !== '0')) return refus('OrderID non nul');

  const nomme = (nom) => [...elements].filter((e) => e.name === nom);
  for (const c of cles) {
    const trouves = nomme(c);
    if (trouves.length !== 1 || String(trouves[0].type || '').toLowerCase() !== 'hidden') {
      return refus(`le champ ${c} est absent, en double ou n'est pas un champ caché`);
    }
  }
  const avant = cles.map((c) => [c, nomme(c)[0].value]);
  for (const c of cles) nomme(c)[0].value = String(modifs[c]);
  const apres = lire();
  const fidele = apres.length === actuels.length && apres.every((c, i) => c.nom === actuels[i].nom
    && c.type === actuels[i].type && (c.valeur === actuels[i].valeur || cles.includes(c.nom)));
  if (!fidele) {
    for (const [c, v] of avant) nomme(c)[0].value = v;
    return refus('le formulaire a changé au-delà des deux champs permis');
  }
  HTMLFormElement.prototype.submit.call(form);
  return { envoye: true };
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * La seule navigation : une adresse qui n'est ni un `javascript:` ni porteuse
 * d'un mot interdit, puis l'attente — bornée. Sert la page principale et
 * l'onglet de chaque facture.
 */
async function naviguer(page, adresse) {
  if (/^\s*javascript\s*:/i.test(String(adresse))) throw new Error(`${ID} : un « javascript: » ne se suit jamais.`);
  const mot = interdites.motInterdit(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot interdit « ${mot} »).`);
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/** Le lancement du navigateur et l'horloge : les seuls points remplaçables. */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
};

/** Ouvre un navigateur sur la connexion enregistrée ; le journal de navigation suit la page principale. */
async function surLeCompte(config, ctx, fn) {
  const log = ctx?.log || (() => {});
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
    navigation.brancher(page, { log: (ligne) => log(masquer(ligne)), prefixe: `${ID} : navigation` });
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

function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre espace client, mais crabe n'a pas su lire la page de vos `
      + 'commandes : elle ne ressemble plus à celle qu\'il connaît. Votre connexion n\'est pas '
      + 'en cause : inutile de la rouvrir. Signalez-le pour que la lecture soit mise à jour ; '
      + 'la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

/** Lit la page affichée ; ne lève jamais. */
async function lireLaPage(page) {
  const vue = await page.evaluate(LIRE_LA_PAGE).catch(() => null)
    || { url: page.url(), titre: '', connecte: false, motDePasse: false, formulaire: null, tableau: false, lignes: [] };
  vue.mur = await profilMarchand.estMurAntiRobot(page);
  return vue;
}

/** Rejoint « Mon compte » et JUGE l'arrivée ; lève sur un renvoi, un mur, une page illisible. */
async function arriverSurLeCompte(page, log) {
  await naviguer(page, URL_COMPTE);
  const vue = await lireLaPage(page);
  const jugement = jugerCompte(vue);
  log(`${ID} : arrivée jugée « ${jugement.verdict} » — ${jugement.raison}.`);
  if (jugement.verdict === 'connexion-demandee') {
    throw profilMarchand.erreurRenvoiVersAuthentification(NOM, jugement.raison);
  }
  if (jugement.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (jugement.verdict !== 'compte') throw erreurPageIllisible(jugement.raison);
  return vue;
}

/**
 * Envoie `MForm` par `ENVOYER_LE_FORMULAIRE` — la seule voie — puis attend la
 * page servie. `formulaire` est la lecture faite juste avant, sur cette page :
 * c'est contre elle que le formulaire est recontrôlé au moment de l'envoi, et
 * c'est la page elle-même qui dit quelle règle s'applique (R1, lot 100).
 *
 * @returns {Promise<{envoye: true}|{envoye: false, raison: string, champs?: string[]}>}
 */
async function envoyerLeFormulaire(page, formulaire, modifs) {
  const servie = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => null);
  let rendu = null;
  try {
    rendu = await page.evaluate(ENVOYER_LE_FORMULAIRE, {
      servis: formulaire?.champs || [],
      modifs,
      action: ACTION_ATTENDUE,
      motsInterdits: [...interdites.MOTS_INTERDITS],
      actionSuivi: ACTION_SUIVI,
      champsPagination: [...CHAMPS_PAGINATION],
      champsArrivee: [...CHAMPS_ARRIVEE],
    });
  } catch {
    // L'évaluation n'a pas rendu sa réponse : la page a navigué pendant le
    // retour (l'envoi venait de partir), ou elle s'est fermée. Rien n'est
    // supposé : la page servie est lue et jugée comme après un envoi.
    rendu = { envoye: true };
  }
  if (!rendu?.envoye) {
    return {
      envoye: false,
      raison: rendu?.raison || 'refusé',
      ...(Array.isArray(rendu?.champs) ? { champs: rendu.champs.map(String) } : {}),
    };
  }
  await servie;
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
  return { envoye: true };
}

/** La fenêtre d'historique ; « depuis » = tout ce qui manque à l'archive (Gandi, lot 93). */
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

/**
 * Les commandes d'une page de la liste : numéro, date, et l'adresse de sa
 * facture tirée de l'appel du lien « facture » (refusée si elle porte un mot
 * interdit). Pure, testée.
 */
function commandesDeLaPage(vue) {
  return (vue?.lignes || []).map((ligne) => {
    const lues = (ligne.liens || []).map(cheminDeLAppel).filter((c) => c !== null)
      .map((c) => adresseDeFacture(c, vue.url) || { refus: 'forme' });
    const facture = lues.find((l) => !l.refus) || null;
    const refus = !facture && lues.length ? lues[0].refus : null;
    const issuedOn = pageDocs.dateDepuisTexte(ligne.dateTexte) || (facture?.mois ? `${facture.mois}-01` : null);
    return {
      numero: numeroSur(ligne.numero),
      facture,
      refus,
      issuedOn,
    };
  });
}

/**
 * Ouvre la facture dans un onglet de la session, la juge, et l'imprime SANS
 * RIEN Y CHANGER. L'onglet est refermé quoi qu'il arrive.
 *
 * @returns {Promise<{ok: true, buffer: Buffer}|{ok: false, session?: boolean, grief: string}>}
 */
async function imprimerLaFacture(context, doc) {
  const onglet = await context.newPage();
  try {
    onglet.setDefaultTimeout(NAV_TIMEOUT_MS);
    await naviguer(onglet, doc.adresse);
    const vue = await onglet.evaluate(LIRE_LA_FACTURE).catch(() => null) || { url: onglet.url() };
    const jugement = jugerFacture(vue, doc.adresse);
    if (jugement.verdict === 'connexion-demandee') return { ok: false, session: true, grief: jugement.raison };
    if (jugement.verdict !== 'facture') return { ok: false, grief: `n'est pas une facture — ${jugement.raison}` };
    let octets = null;
    try {
      octets = await onglet.pdf({ format: 'A4', printBackground: true });
    } catch (err) {
      return { ok: false, grief: `n'a pas pu être rendue en PDF (${String((err && err.message) || err).replace(/\d/g, '#').slice(0, 80)})` };
    }
    const juge = ongletPdf.jugerLesOctets(octets);
    return juge.ok ? { ok: true, buffer: juge.buffer } : { ok: false, grief: `rendue, ${juge.grief}` };
  } finally {
    await onglet.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : « Mon compte » s'ouvre au compte connecté. Le
 * formulaire n'est PAS envoyé : un essai ne fait aucun geste.
 */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    await arriverSurLeCompte(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — votre espace client ${NOM} est ouvert. Vos commandes et leurs `
        + 'factures seront lues à la prochaine récupération.',
    };
  });
}

/**
 * Les factures des commandes, en deux temps : LIRE chaque page de la liste
 * (par le seul envoi permis), puis IMPRIMER chaque facture manquante. Ce qui
 * est pris est GARDÉ quoi qu'il arrive ensuite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const compte = await arriverSurLeCompte(page, log);

    const bilan = {
      commandes: 0,
      pages: 0,
      sansFacture: 0,
      deja: 0,
      ecartes: 0,
      horsPeriode: 0,
      restantes: 0,
      pagesNonLues: null,
      interruption: null,
      lectureInterrompue: false,
    };

    // ── 1. Lire : chaque page, par le seul envoi permis ──────────────────
    const lues = [];
    // La page 1 part de la page d'arrivée, les suivantes de la page des
    // commandes : chacune a son formulaire, et sa règle (R1, lot 100).
    let formulaire = compte.formulaire;
    // `PagingAPIRowCount` ne se lit que sur la page des commandes, la seule
    // qui le porte (R2, lot 100) : jamais sur la page d'arrivée.
    let lignesParPage = null;
    for (let n = 1; ; n++) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        bilan.lectureInterrompue = true;
        break;
      }
      const modifs = n === 1 ? { ActionID: ACTION_SUIVI } : { ActionID: ACTION_SUIVI, OrdersPageIdx: String(n) };
      const envoi = await envoyerLeFormulaire(page, formulaire, modifs);
      if (!envoi.envoye) {
        log(`${ID} : page ${n} — le formulaire n'est pas parti : ${envoi.raison}`
          + `${envoi.champs ? ` (champs vus : ${nomsDicibles(envoi.champs)})` : ''}.`);
        if (n === 1) throw erreurPageIllisible(`le formulaire de « Mon compte » n'a pas été envoyé : ${envoi.raison}`);
        bilan.pagesNonLues = 'echec';
        break;
      }
      const vue = await lireLaPage(page);
      const jugement = jugerListe(vue);
      if (jugement.verdict === 'connexion-demandee') {
        // Rien n'est encore pris : c'est un renvoi, classé par le lot 91.
        throw profilMarchand.erreurRenvoiVersAuthentification(NOM, `${jugement.raison}, en lisant la page ${n} des commandes`);
      }
      if (jugement.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
      if (jugement.verdict !== 'liste') {
        if (n === 1) {
          // R3 (lot 100) : l'envoi n'a pas mené au tableau des commandes. Rien
          // n'est renvoyé ; le journal dit ce que montre la page reçue — de
          // quoi savoir si `SubmitAction` faisait plus que poser ActionID. Le
          // message du site pour une liste vide n'est pas mesuré : aucun n'est
          // reconnu.
          log(`${ID} : page 1 — l'envoi « Suivi des commandes » (ActionID=8) n'a pas mené à la liste des commandes : `
            + `${jugement.raison} ; ${pageRecue(vue)}. Rien n'est renvoyé.`);
          throw erreurPageIllisible(jugement.raison);
        }
        log(`${ID} : page ${n} — ${jugement.raison} ; ${pageRecue(vue)}.`);
        bilan.pagesNonLues = 'echec';
        break;
      }
      if (lignesParPage === null) {
        lignesParPage = lignesParPageDe(vue.formulaire);
        if (!lignesParPage) {
          lignesParPage = LIGNES_PAR_PAGE_DEFAUT;
          log(`${ID} : PagingAPIRowCount illisible dans le formulaire de la page des commandes — `
            + `${LIGNES_PAR_PAGE_DEFAUT} lignes par page retenues (valeur mesurée).`);
        }
      }
      const commandes = commandesDeLaPage(vue);
      // L'identité d'une ligne : son numéro, à défaut l'adresse de sa facture —
      // deux pages « identiques » se comparent sur ce qu'elles montrent.
      const numeros = commandes.map((c) => c.numero || c.facture?.adresse || '');
      const decision = decisionPagination({
        n, lues: commandes.length, lignesParPage, numeros, precedents: lues.length ? lues[lues.length - 1].numeros : null,
      });
      if (decision === 'identique') {
        bilan.pagesNonLues = 'identique';
        log(`${ID} : page ${n} — identique à la précédente (mêmes numéros) : arrêt, pages suivantes non lues.`);
        break;
      }
      if (decision === 'vide') {
        // Une page vide n'est pas une page de commandes : elle n'est pas comptée.
        log(`${ID} : page ${n} — aucune commande : fin de la liste.`);
        break;
      }
      lues.push({ n, commandes, numeros });
      log(`${ID} : page ${n} — ${commandes.length} commande(s) lue(s)`
        + (decision === 'suivante' ? `, autant que PagingAPIRowCount (${lignesParPage}) : la suivante est demandée.`
          : decision === 'borne' ? ` : borne de ${PAGES_MAX} pages atteinte, pages suivantes non lues.`
            : ` : ${commandes.length > lignesParPage ? 'plus' : 'moins'} que PagingAPIRowCount (${lignesParPage}), fin de la liste.`));
      if (decision === 'borne') {
        bilan.pagesNonLues = 'borne';
        break;
      }
      if (decision !== 'suivante') break;
      if (!vue.formulaire) {
        bilan.pagesNonLues = 'echec';
        log(`${ID} : page ${n} — la page servie ne porte plus le formulaire MForm : pages suivantes non lues.`);
        break;
      }
      formulaire = vue.formulaire;
    }
    bilan.pages = lues.length;

    // ── 2. Ce qu'il y a à prendre ────────────────────────────────────────
    const aPrendre = [];
    for (const page_ of lues) {
      for (const c of page_.commandes) {
        bilan.commandes++;
        if (c.refus) {
          bilan.ecartes++;
          log(`${ID} : un lien de facture a été écarté sans être suivi — ${c.refus === 'forme'
            ? 'son adresse n\'a pas la forme d\'une facture de la boutique (/Files/…/….htm)'
            : `il porte le mot interdit « ${c.refus} »`}.`);
          continue;
        }
        if (!c.facture) {
          bilan.sansFacture++;
          continue;
        }
        if (!c.facture.numeroFacture && !c.numero) {
          bilan.ecartes++;
          log(`${ID} : une facture n'a ni numéro dans le nom de son fichier ni numéro de commande lisible : non prise.`);
          continue;
        }
        const doc = {
          adresse: c.facture.adresse,
          numeroFacture: c.facture.numeroFacture,
          numeroCommande: c.numero,
          issuedOn: c.issuedOn,
        };
        doc.remoteId = remoteIdDe(doc);
        if (connus.has(doc.remoteId)) {
          bilan.deja++;
          continue;
        }
        if (aPrendre.some((d) => d.remoteId === doc.remoteId)) continue;
        if (!scraping.dansLaFenetre(doc.issuedOn, plan)) {
          bilan.horsPeriode++;
          continue;
        }
        aPrendre.push(doc);
      }
    }
    log(`${ID} : ${bilan.commandes} commande(s) lue(s) sur ${bilan.pages} page(s) — `
      + `${bilan.commandes - bilan.sansFacture - bilan.ecartes} avec une facture, ${bilan.sansFacture} sans facture, `
      + `${bilan.deja} déjà dans l'archive, ${aPrendre.length} à prendre, ${bilan.horsPeriode} hors période.`);

    // La preuve exigée par le socle (lot 31) : la liste a été LUE.
    ctx.preuveDeListe?.({
      session: `liste des commandes ${NOM} servie au compte connecté (is-user-logged, table.PBTable)`,
      liste: `${URL_COMPTE} (Suivi des commandes)`,
      elements: bilan.commandes,
    });

    // ── 3. Imprimer : chaque facture manquante, dans son onglet ──────────
    const invoices = [];
    let manquees = 0;
    let renoncement = null;
    let tentees = 0;
    const serie = serieEchecs.suiteDEchecs();
    for (const doc of aPrendre) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      tentees++;
      const controle = verifierAdresseFacture(doc.adresse);
      if (!controle.ok) {
        manquees++;
        log(`${ID} : une facture n'a pas été ouverte — ${controle.raison}.`);
        continue;
      }
      const rendu = await imprimerLaFacture(context, doc);
      if (rendu.ok) {
        serie.reussite();
        invoices.push({ ...doc, buffer: rendu.buffer });
        continue;
      }
      if (rendu.session) {
        tentees--;
        if (!invoices.length) {
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en ouvrant une facture');
        }
        bilan.interruption = 'session';
        log(`${ID} : renvoyé vers la connexion en ouvrant les factures : les ${invoices.length} déjà prise(s) sont gardées.`);
        break;
      }
      manquees++;
      log(`${ID} : une facture n'a pas pu être prise : la page ${String(rendu.grief || '').replace(/\s+/g, ' ').slice(0, 300)} — rien n'est déposé à sa place.`);
      if (serie.echec(rendu.grief)) {
        renoncement = serie.phrasePublique();
        log(`${ID} : ${serie.raison()}`);
        break;
      }
    }
    bilan.restantes = aPrendre.length - tentees;
    const nonDemandees = renoncement || bilan.interruption === 'session' ? bilan.restantes : 0;
    const nonObtenues = manquees + nonDemandees;

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
        complete: !bilan.interruption && !renoncement && !bilan.pagesNonLues && !nonObtenues,
        detail: `${pluriel(bilan.pages, 'page', 'pages')} de commandes ${NOM}, ${pluriel(bilan.commandes, 'commande', 'commandes')}`,
      },
    };
    if (nonObtenues) {
      sortie.manquees = nonObtenues;
      if (renoncement) sortie.renoncement = renoncement;
    }
    const avecFacture = bilan.commandes - bilan.sansFacture - bilan.ecartes;
    if (!bilan.commandes && !bilan.interruption) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : aucune commande pour l'instant.`;
    } else if (bilan.commandes && !avecFacture) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : `
        + `${pluriel(bilan.commandes, 'commande', 'commandes')}, aucune n'a encore de facture.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: nonObtenues > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.commandes} commande(s) lue(s) sur ${bilan.pages} page(s), ${invoices.length} prise(s), `
      + `${manquees} manquée(s), ${bilan.deja} déjà dans l'archive, ${bilan.sansFacture} sans facture, `
      + `${bilan.horsPeriode} hors période, ${bilan.restantes} en attente`
      + `${bilan.pagesNonLues ? `, pages suivantes non lues (${bilan.pagesNonLues})` : ''}`
      + `${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${nonDemandees ? ` — arrêt avant la fin : ces ${nonDemandees} non demandée(s) comptent comme non obtenues` : ''}.`);

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
  // exportés pour les tests unitaires
  lireSession,
  cheminDeLAppel,
  adresseDeFacture,
  verifierAdresseFacture,
  numeroSur,
  estPageDeConnexion,
  jugerCompte,
  jugerListe,
  jugerFacture,
  decisionPagination,
  lignesParPageDe,
  remoteIdDe,
  nommer,
  masquer,
  nomsDicibles,
  pageRecue,
  precisionDuPassage,
  commandesDeLaPage,
  envoyerLeFormulaire,
  fenetre,
  budgetMs,
  LIRE_LA_PAGE,
  LIRE_LA_FACTURE,
  ENVOYER_LE_FORMULAIRE,
  MOTIF_APPEL_FACTURE,
  URL_COMPTE,
  ACTION_ATTENDUE,
  ACTION_SUIVI,
  CHAMPS_PAGINATION,
  CHAMPS_ARRIVEE,
  HOTE,
  PAGES_MAX,
  LIGNES_PAR_PAGE_DEFAUT,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
