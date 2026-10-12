'use strict';

/**
 * Connecteur Private Sport Shop — la FACTURE de chaque commande, choisie dans
 * la liste déroulante de la page de la commande (lot 104).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de « Mes commandes », de l'historique et d'une
 * commande, enregistrés connectés par l'utilisateur le 11/10/2026, dont le prompt du
 * lot 104 a repris la STRUCTURE, sans aucune donnée. Application Vue :
 *
 *   - `/sales/order/history/` (« Mes commandes », `h1[data-selector-orders-title]`)
 *     ne montrait que les commandes récentes — aucune chez l'utilisateur — et le lien
 *     « Voir les commandes précédentes » ;
 *   - `/historical/orders` (« Historique des commandes », même `h1`) : une
 *     carte `[data-selector-account-card]` par commande — « Numéro de
 *     commande » et un lien `/historical/orders/<n>` de texte « #<n> »,
 *     « Date », « Total », « Statut », « Voir la commande » ;
 *   - `/historical/orders/<n>` : `h1` « Détails de la commande », « Commande
 *     #<n> | Date de commande … », puis `select#invoice-download-select`
 *     (`data-selector-invoice-download-select`, « Télécharger une facture ») :
 *     une option vide, puis une option par document, de `value` un JSON
 *     `{"type":"invoice","id":<n>}`. CHOISIR une option déclenche le
 *     téléchargement (annoncé par la forme de la page, non mesuré) ;
 *   - autour : le panier (`checkout.privatesportshop.fr`), les retours
 *     (`/ProductReturn/…`), les moyens de paiement, « Déconnexion »
 *     (`data-selector-logout`) — jamais touchés.
 *
 * NON MESURÉ : la pagination de l'historique (trois commandes chez l'utilisateur), la
 * forme des commandes récentes (lues seulement si leur lien a la forme d'un
 * détail de l'historique ; sinon comptées et dites), les autres types de
 * document (un avoir ?), ce que fait le choix d'une option.
 *
 * ─── Le seul geste, et comment il est enfermé ────────────────────────────────
 *
 *   1. UNE fonction fait le geste : `choisirLaFacture`. Elle reçoit une
 *      `value` qui doit avoir été LUE sur une option de cette page ET être un
 *      JSON de `type` exactement `invoice` et d'`id` un nombre entier ;
 *   2. au moment du choix, tout est recontrôlé : une seule liste
 *      `select#invoice-download-select[data-selector-invoice-download-select]`,
 *      visible, qui porte UNE option de cette `value` exacte ;
 *   3. les autres types sont lus, dits au journal (sans identifiant), jamais
 *      choisis ; ce fichier ne porte aucun autre geste — un essai le lit.
 *
 * Le document est pris par le socle `clic-document`, seulement depuis les
 * domaines du site (`adressePermise`), refusé sans `%PDF-` ; sinon PLUS AUCUN
 * GESTE pendant ce passage, et c'est dit.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `private-sport-shop-facture-<id>` (l'`id` de l'option). Date : la date
 * de commande. Nom : `private-sport-shop_AAAA-MM_facture-<id>.pdf`.
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

const ID = 'private-sport-shop';
const NOM = 'Private Sport Shop';

const HOTE = 'www.privatesportshop.fr';
const URL_HISTORIQUE = 'https://www.privatesportshop.fr/historical/orders';
const URL_RECENTES = 'https://www.privatesportshop.fr/sales/order/history/';
const DETAIL = /^\/historical\/orders\/(\d{1,12})\/?$/;

/**
 * Les domaines du site : la boutique, et l'API que ses pages préchargent
 * (`api.sportpursuit.com`, lu dans les pages enregistrées). Ni le panier
 * (`checkout.…`), ni le suivi d'erreurs, ni le dépôt d'images.
 */
const DOMAINES_DU_SITE = Object.freeze([HOTE, 'api.sportpursuit.com']);

const CHAMP_SESSION = 'session';
const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_DESSIN_MS = 45_000;
const PAS_ATTENTE_MS = 400;
const STABLE_MS = 1_500;
const STABLE_VIDE_MS = 5_000;
const DELAI_GESTE_MS = 10_000;

const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
const PART_DU_TEMPS = 2 / 3;

/** La liste fermée et gelée des gestes (R3) : un seul repère. */
const GESTES = Object.freeze({
  facture: Object.freeze({ repere: 'select#invoice-download-select[data-selector-invoice-download-select]' }),
});
const REPERE_LISTE = GESTES.facture.repere;

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
 * Toute ligne écrite au journal passe ici (R5) : aucun numéro de commande ni
 * de facture (aucune suite de quatre chiffres ou plus), aucun montant, aucune
 * requête d'adresse. Pure, testée.
 */
function pourLeJournal(texte) {
  return String(texte ?? '')
    .replace(/\?[^\s)\]»"']*/g, '?…')
    .replace(/\d[\d\s]*,\d\d\s*€/g, '… €')
    .replace(/\d{4,}/g, '…');
}

function journalDe(ctx) {
  const ecrire = ctx?.log || (() => {});
  return (ligne) => ecrire(pourLeJournal(ligne));
}

const normaliser = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** L'adresse du détail d'une commande, lue dans un lien — ou un refus. Pure, testée. */
function adresseDuDetail(href) {
  const brut = String(href ?? '').trim();
  if (!brut) return { refus: 'lien vide' };
  const mot = refusees.motRefuse(brut);
  if (mot) return { refus: `mot refusé « ${mot} »` };
  let u;
  try {
    u = new URL(brut, URL_HISTORIQUE);
  } catch {
    return { refus: 'adresse illisible' };
  }
  if (u.protocol !== 'https:' || u.hostname !== HOTE) return { refus: 'hors de la boutique' };
  if (u.search || u.hash) return { refus: 'adresse porteuse d\'une requête' };
  const m = DETAIL.exec(u.pathname);
  if (!m) return { refus: 'pas la forme d\'un détail de commande' };
  return { adresse: `https://${HOTE}/historical/orders/${m[1]}`, numero: m[1] };
}

/**
 * Les commandes d'une liste (cartes lues). Une carte dont les liens ne
 * mènent pas à un seul détail, ou dont le numéro affiché diffère de celui de
 * l'adresse, est écartée et dite. Pure, testée.
 *
 * @param {{liens: string[], numeroTexte: string, texte: string}[]} cartes
 */
function commandesDeLaListe(cartes) {
  const commandes = [];
  const ecartees = [];
  for (const [rang, c] of (cartes || []).entries()) {
    const lus = [...new Set((c.liens || []).map(adresseDuDetail).filter((l) => !l.refus).map((l) => l.adresse))];
    if (lus.length !== 1) {
      ecartees.push({ rang, raison: lus.length ? 'plusieurs commandes sur une carte' : 'aucun lien vers le détail d\'une commande' });
      continue;
    }
    const lu = adresseDuDetail(lus[0]);
    if (normaliser(c.numeroTexte).replace(/^#/, '') !== lu.numero) {
      ecartees.push({ rang, raison: 'le numéro affiché n\'est pas celui de l\'adresse' });
      continue;
    }
    const lignes = String(c.texte ?? '').split('\n').map(normaliser).filter(Boolean);
    const i = lignes.indexOf('Date');
    commandes.push({ ...lu, issuedOn: i >= 0 ? pageDocs.dateDepuisTexte(lignes[i + 1] || '') : null });
  }
  return { commandes, ecartees };
}

/**
 * Une option de la liste « Télécharger une facture », ramenée à ce qu'elle
 * est : une facture (`type` exactement `invoice`, `id` entier positif), un
 * autre type (jamais choisi), l'option vide, ou illisible. Pure, testée.
 *
 * @returns {{nature: 'facture', valeur: string, id: string}|{nature: 'autre', type: string}
 *   |{nature: 'vide'}|{nature: 'illisible'}}
 */
function analyserOption(valeur) {
  const brute = String(valeur ?? '');
  if (!brute.trim()) return { nature: 'vide' };
  let lu;
  try {
    lu = JSON.parse(brute);
  } catch {
    return { nature: 'illisible' };
  }
  if (!lu || typeof lu !== 'object' || Array.isArray(lu)) return { nature: 'illisible' };
  const cles = Object.keys(lu).sort();
  if (lu.type === 'invoice') {
    if (JSON.stringify(cles) !== '["id","type"]' || !Number.isSafeInteger(lu.id) || lu.id <= 0) return { nature: 'illisible' };
    return { nature: 'facture', valeur: brute, id: String(lu.id) };
  }
  return { nature: 'autre', type: typeof lu.type === 'string' ? lu.type.replace(/[^a-z_-]/gi, '').slice(0, 20) || '?' : '?' };
}

/** Les options d'une commande, triées. Pure, testée. */
function optionsDeLaCommande(valeurs) {
  const factures = [];
  const autres = [];
  let illisibles = 0;
  const vues = new Set();
  for (const v of valeurs || []) {
    const a = analyserOption(v);
    if (a.nature === 'facture' && !vues.has(a.id)) {
      vues.add(a.id);
      factures.push(a);
    } else if (a.nature === 'autre') {
      autres.push(a.type);
    } else if (a.nature === 'illisible') {
      illisibles += 1;
    }
  }
  return { factures, autres, illisibles };
}

/** L'ancre d'une facture : son `id`. Pure. */
function remoteIdDe(facture) {
  return `${ID}-facture-${facture.id}`;
}

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

/** Cette adresse est-elle du site ? (même règle qu'à l'Eau d'Île-de-France, lot 102). Pure. */
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

function estPageDeConnexion(url) {
  return preuve.estUrlAuthentification(url) || /\/customer\/account\/login/i.test(String(url || ''));
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

const ARRETS = {
  'sans-pdf': 'la boutique a remis autre chose qu\'une facture PDF',
  rien: 'la boutique n\'a rien remis — ni téléchargement, ni onglet, ni document',
  ailleurs: 'le document venait d\'un autre site que la boutique',
  absent: 'la liste des factures n\'était plus à sa place au moment du choix',
  page: 'la boutique a affiché une autre page',
};

/**
 * Ce que l'écran dit d'un passage (R5) : commandes lues, factures, commandes
 * sans facture, ce qui a bloqué. Des nombres, jamais un numéro ni un montant.
 * Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')}, `
      + `${pluriel(b.factures, 'facture proposée', 'factures proposées')}`
      + (b.deja ? `, ${b.deja} déjà dans vos documents` : '')
      + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture', 'commandes sans facture')}` : '')
      + '.');
  }
  if (b.autres) {
    phrases.push(`${pluriel(b.autres, 'autre document est proposé', 'autres documents sont proposés')} (pas une facture) : crabe ne l${b.autres > 1 ? 'es' : 'e'} prend pas.`);
  }
  if (b.ecartees) {
    phrases.push(`${pluriel(b.ecartees, 'commande a été écartée', 'commandes ont été écartées')} : elle${b.ecartees > 1 ? 's' : ''} ne se lisai${b.ecartees > 1 ? 'en' : ''}t pas de façon sûre.`);
  }
  if (b.recentesInconnues) {
    phrases.push(`${pluriel(b.recentesInconnues, 'commande récente n\'a pas pu être lue', 'commandes récentes n\'ont pas pu être lues')} : `
      + 'leur page n\'a pas la forme connue. Signalez-le pour que la lecture soit mise à jour.');
  }
  if (b.arret) {
    phrases.push(`Après le choix d'une facture, ${ARRETS[b.arret] || ARRETS['sans-pdf']} : crabe n'a plus rien choisi pendant ce passage`
      + (b.nonDemandees ? ` ; ${pluriel(b.nonDemandees, 'autre facture n\'a pas été demandée, elle le sera', 'autres factures n\'ont pas été demandées, elles le seront')} au prochain passage` : '')
      + '. Si cela se répète, signalez-le.');
  }
  if (b.interruption === 'temps') {
    phrases.push(`La récupération a pris tout le temps permis : la suite viendra au prochain passage. Rien de ce qui a été pris n'est perdu.`);
  }
  if (b.interruption === 'session') {
    phrases.push('La lecture s\'est interrompue — Private Sport Shop a demandé de vous reconnecter : les factures déjà prises '
      + 'sont gardées. Reconnectez-vous depuis la fiche de Private Sport Shop pour récupérer la suite.');
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
    raison: `toutes les factures pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — jamais un geste
// ---------------------------------------------------------------------------

const LIRE_LA_LISTE = () => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const titre = document.querySelector('h1[data-selector-orders-title]');
  return {
    url: location.href,
    titre: titre ? n(titre.textContent) : '',
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    cartes: [...document.querySelectorAll('[data-selector-account-card]')].map((carte) => {
      const ancres = [...carte.querySelectorAll('a[href]')];
      const numero = ancres.find((a) => /^#\d+$/.test(n(a.textContent)));
      return {
        liens: ancres.map((a) => a.getAttribute('href')),
        numeroTexte: numero ? n(numero.textContent) : '',
        texte: carte.innerText || '',
      };
    }),
  };
};

const LIRE_LA_COMMANDE = () => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const n = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const h1 = [...document.querySelectorAll('h1')].find((h) => n(h.textContent) === 'Détails de la commande');
  const entete = h1 && h1.parentElement ? [...h1.parentElement.querySelectorAll('p')].map((p) => n(p.textContent)).find((t) => /^Commande #/.test(t)) : '';
  const listes = [...document.querySelectorAll('select#invoice-download-select')];
  return {
    url: location.href,
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    titre: !!h1,
    entete: entete || '',
    listes: listes.length,
    options: listes[0] ? [...listes[0].options].map((o) => o.getAttribute('value') || '') : [],
  };
};

async function lire(page, fonction) {
  return page.evaluate(fonction).catch(() => null);
}

/** Attend une liste de commandes, au titre attendu, stable ; ne lève jamais. */
async function attendreLaListe(page, titreAttendu) {
  const debut = Date.now();
  let signature = null;
  let stableDepuis = 0;
  let vue = null;
  for (;;) {
    vue = await lire(page, LIRE_LA_LISTE);
    if (vue && (estPageDeConnexion(vue.url) || vue.motDePasse)) return { verdict: 'connexion', raison: 'renvoyé vers une page de connexion', vue };
    if (vue && vue.titre === titreAttendu) {
      const forme = JSON.stringify(vue.cartes.map((c) => c.liens));
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.cartes.length ? STABLE_MS : STABLE_VIDE_MS)) {
        return { verdict: 'liste', raison: `« ${titreAttendu} » affiché (${vue.cartes.length} carte(s))`, vue };
      }
    } else {
      signature = null;
    }
    if (Date.now() - debut >= ouverture.delaiDessinMs) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  if (await profilMarchand.estMurAntiRobot(page).catch(() => false)) return { verdict: 'mur', raison: 'vérification de sécurité', vue };
  return { verdict: 'illisible', raison: `le titre « ${titreAttendu} » n'est pas affiché après ${Math.round(ouverture.delaiDessinMs / 1000)} s`, vue };
}

/** Attend le détail de CETTE commande ; ne lève jamais. */
async function attendreLaCommande(page, commande) {
  const debut = Date.now();
  let vue = null;
  let signature = null;
  let stableDepuis = 0;
  for (;;) {
    vue = await lire(page, LIRE_LA_COMMANDE);
    if (vue && (estPageDeConnexion(vue.url) || vue.motDePasse)) return { verdict: 'connexion', vue };
    if (vue && vue.titre && new RegExp(`^Commande #${commande.numero}(?!\\d)`).test(vue.entete)) {
      const forme = JSON.stringify([vue.listes, vue.options]);
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.listes ? STABLE_MS : STABLE_VIDE_MS)) return { verdict: 'commande', vue };
    } else if (vue && vue.titre && vue.entete) {
      return { verdict: 'autre', vue };
    } else {
      signature = null;
    }
    if (Date.now() - debut >= ouverture.delaiDessinMs) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  return { verdict: 'illisible', vue };
}

// ---------------------------------------------------------------------------
// Le seul geste de ce fichier
// ---------------------------------------------------------------------------

/**
 * Choisit, dans « Télécharger une facture », l'option `valeur` — et rien
 * d'autre. `valeur` doit figurer parmi `lues` (les options lues sur CETTE
 * page) et être une facture au sens d'`analyserOption` ; sinon le passage
 * s'arrête net, rien n'est choisi.
 *
 * @returns {Promise<boolean>}
 */
async function choisirLaFacture(page, valeur, lues, surRefus = () => {}) {
  const v = String(valeur ?? '');
  if (analyserOption(v).nature !== 'facture' || !lues?.has?.(v)) {
    throw new Error(`${ID} : une option qui n'est pas une facture lue sur cette page — rien n'a été choisi.`);
  }
  const liste = page.locator(GESTES.facture.repere);
  if ((await liste.count().catch(() => 0)) !== 1) {
    surRefus('la liste des factures n\'est plus seule à sa place');
    return false;
  }
  if (!(await liste.isVisible().catch(() => false))) {
    surRefus('la liste des factures n\'est pas visible');
    return false;
  }
  const options = liste.locator('option');
  const total = await options.count().catch(() => 0);
  let memes = 0;
  for (let i = 0; i < total; i++) {
    if ((await options.nth(i).getAttribute('value', { timeout: DELAI_GESTE_MS }).catch(() => null)) === v) memes += 1;
  }
  if (memes !== 1) {
    surRefus(memes ? 'plusieurs options portent cette facture' : 'l\'option n\'est plus dans la liste');
    return false;
  }
  try {
    await liste.selectOption({ value: v }, { timeout: DELAI_GESTE_MS });
  } catch (err) {
    surRefus(`l'option n'a pas pu être choisie (${normaliser(err?.message).split(' Call log')[0].slice(0, 100)})`);
    return false;
  }
  return true;
}

/** Une facture : le choix (la seule voie), puis le document, par le socle. */
async function prendreUneFacture(page, context, facture, lues) {
  let refus = '';
  let boiteNative = false;
  const surBoite = (b) => { boiteNative = true; b.dismiss().catch(() => {}); };
  page.on?.('dialog', surBoite);
  const chemin = new URL(page.url()).pathname;
  let obtenu = null;
  try {
    obtenu = await clicDocument.documentDuClic(
      page,
      context,
      () => choisirLaFacture(page, facture.valeur, lues, (r) => { refus = r; }),
      {
        delaiMs: ouverture.delaiDocumentMs,
        adressePermise: adresseDuSite,
        autreIssue: async () => boiteNative || new URL(page.url()).pathname !== chemin,
      }
    );
  } finally {
    try { page.off?.('dialog', surBoite); } catch { /* page partie */ }
    for (const autre of context?.pages?.() || []) if (autre !== page) await autre.close().catch(() => {});
  }
  if (obtenu.ok && !identity.estPdf(obtenu.buffer)) return { ok: false, nature: 'sans-pdf', grief: 'le document reçu ne commence pas comme un PDF' };
  if (obtenu.ok) return obtenu;
  if (refus) return { ok: false, nature: 'absent', grief: refus };
  if (obtenu.horsDomaine) return { ok: false, nature: 'ailleurs', grief: obtenu.grief };
  if (boiteNative || obtenu.autreIssue) return { ok: false, nature: 'page', grief: 'une autre page ou une boîte du navigateur au lieu de la facture' };
  if (/ni téléchargement, ni nouvel onglet/.test(obtenu.grief)) return { ok: false, nature: 'rien', grief: obtenu.grief };
  return { ok: false, nature: 'sans-pdf', grief: obtenu.grief };
}

// ---------------------------------------------------------------------------
// Navigation et arrivée
// ---------------------------------------------------------------------------

/** La seule navigation : les deux listes, ou le détail d'une commande lue. */
async function naviguer(page, adresse) {
  const mot = refusees.motRefuse(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot refusé « ${mot} »).`);
  if (adresse !== URL_HISTORIQUE && adresse !== URL_RECENTES && adresseDuDetail(adresse).adresse !== adresse) {
    throw new Error(`${ID} : une adresse qui n'est ni une liste ni une commande lue ne se suit jamais.`);
  }
  try {
    await page.goto(adresse, { waitUntil: 'domcontentloaded' });
    return null;
  } catch (err) {
    return normaliser(err?.message).split(' Call log')[0].slice(0, 160);
  }
}

const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
  delaiDessinMs: DELAI_DESSIN_MS,
  delaiDocumentMs: clicDocument.DELAI_DECLENCHEMENT_MS,
};

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
    `${NOM} a bien ouvert votre compte, mais crabe n'a pas su lire l'historique de vos commandes : la page ne `
      + 'ressemble plus à celle qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la rouvrir. '
      + 'Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

async function arriverSurLHistorique(page, log) {
  const erreur = await naviguer(page, URL_HISTORIQUE);
  if (erreur) log(`${ID} : le chargement de l'historique a échoué — ${erreur}.`);
  const arrivee = await attendreLaListe(page, 'Historique des commandes');
  log(`${ID} : arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
  if (arrivee.verdict === 'connexion') throw profilMarchand.erreurRenvoiVersAuthentification(NOM, arrivee.raison);
  if (arrivee.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (arrivee.verdict !== 'liste') throw erreurPageIllisible(arrivee.raison);
  return arrivee.vue;
}

/** Les commandes récentes de « Mes commandes » : seulement celles de forme connue. */
async function lireLesRecentes(page, log) {
  await naviguer(page, URL_RECENTES);
  const lue = await attendreLaListe(page, 'Mes commandes');
  if (lue.verdict === 'connexion') return { session: true, commandes: [], inconnues: 0 };
  if (lue.verdict !== 'liste') {
    log(`${ID} : « Mes commandes » non lue — ${lue.raison}.`);
    return { commandes: [], inconnues: 0, nonLue: true };
  }
  const { commandes, ecartees } = commandesDeLaListe(lue.vue.cartes);
  log(`${ID} : « Mes commandes » — ${lue.vue.cartes.length} carte(s), ${commandes.length} de forme connue.`);
  return { commandes, inconnues: ecartees.length };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : l'historique s'affiche au compte connecté. Aucun geste. */
async function test(config, ctx = {}) {
  const log = journalDe(ctx);
  return surLeCompte(config, ctx, async (page) => {
    const vue = await arriverSurLHistorique(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — l'historique de vos commandes ${NOM} s'affiche (${pluriel(vue.cartes.length, 'commande', 'commandes')}). `
        + 'Leurs factures seront prises à la prochaine récupération.',
    };
  });
}

/**
 * Les factures, en deux temps : LIRE les listes, puis, commande par commande,
 * LIRE ses options et CHOISIR chaque facture manquante (le seul geste). Ce
 * qui est pris est GARDÉ quoi qu'il arrive ensuite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = journalDe(ctx);
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const vue = await arriverSurLHistorique(page, log);
    const historique = commandesDeLaListe(vue.cartes);
    for (const e of historique.ecartees) log(`${ID} : carte ${e.rang + 1} écartée — ${e.raison}.`);
    const recentes = await lireLesRecentes(page, log);
    if (recentes.session) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en lisant « Mes commandes »');
    const commandes = [];
    for (const c of [...recentes.commandes, ...historique.commandes]) {
      if (!commandes.some((x) => x.numero === c.numero)) commandes.push(c);
    }
    const bilan = {
      commandes: commandes.length,
      factures: 0,
      deja: 0,
      horsPeriode: 0,
      sansFacture: 0,
      autres: 0,
      ecartees: historique.ecartees.length,
      recentesInconnues: recentes.inconnues,
      arret: null,
      nonDemandees: 0,
      interruption: null,
    };
    ctx.preuveDeListe?.({
      session: 'historique des commandes servi au compte connecté (« Historique des commandes »)',
      liste: URL_HISTORIQUE,
      elements: bilan.commandes,
    });
    log(`${ID} : ${bilan.commandes} commande(s) à lire (${historique.commandes.length} dans l'historique, ${recentes.commandes.length} récente(s)) ; `
      + 'pagination de l\'historique non mesurée : seule la page affichée est lue.');

    const invoices = [];
    let aPrendreTotal = 0;
    let tentes = 0;
    for (const [i, commande] of commandes.entries()) {
      // Après un arrêt des gestes, la lecture continue — sans aucun geste —
      // pour dire combien de documents n'ont pas été demandés.
      if (bilan.interruption) break;
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      const erreur = await naviguer(page, commande.adresse);
      const lue = await attendreLaCommande(page, commande);
      if (lue.verdict === 'connexion') {
        if (!invoices.length) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en ouvrant une commande');
        bilan.interruption = 'session';
        break;
      }
      if (lue.verdict !== 'commande') {
        bilan.ecartees++;
        log(`${ID} : commande ${i + 1} — page ${lue.verdict === 'autre' ? 'd\'une autre commande' : 'illisible'}${erreur ? ` (chargement : ${erreur})` : ''}.`);
        continue;
      }
      const opts = optionsDeLaCommande(lue.vue.options);
      if (lue.vue.listes > 1) {
        bilan.ecartees++;
        log(`${ID} : commande ${i + 1} — plusieurs listes de factures, rien n'est choisi.`);
        continue;
      }
      bilan.factures += opts.factures.length;
      bilan.autres += opts.autres.length;
      if (!opts.factures.length) bilan.sansFacture++;
      const issuedOn = pageDocs.dateDepuisTexte(lue.vue.entete) || commande.issuedOn;
      const aPrendre = [];
      for (const f of opts.factures) {
        const doc = { ...f, issuedOn, commande: commande.numero };
        if (connus.has(remoteIdDe(doc))) bilan.deja++;
        else if (!scraping.dansLaFenetre(issuedOn, plan)) bilan.horsPeriode++;
        else aPrendre.push(doc);
      }
      aPrendreTotal += aPrendre.length;
      log(`${ID} : commande ${i + 1} sur ${commandes.length} — ${opts.factures.length} facture(s), `
        + `${opts.autres.length} autre(s) document(s) jamais choisi(s)${opts.autres.length ? ` (type : ${[...new Set(opts.autres)].join(', ')})` : ''}, `
        + `${opts.illisibles} option(s) illisible(s) ; ${aPrendre.length} à prendre.`);
      const lues = new Set(lue.vue.options);
      for (const doc of aPrendre) {
        if (bilan.arret) break;
        if (ouverture.maintenant() > echeance) {
          bilan.interruption = 'temps';
          break;
        }
        tentes++;
        const obtenu = await prendreUneFacture(page, context, doc, lues);
        if (!obtenu.ok) {
          log(`${ID} : commande ${i + 1} — facture choisie, pas de PDF (${obtenu.grief}). Plus aucun geste pendant ce passage.`);
          const relue = await lire(page, LIRE_LA_COMMANDE);
          if (estPageDeConnexion(page.url()) || relue?.motDePasse) {
            tentes--;
            if (!invoices.length) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
            bilan.interruption = 'session';
          } else {
            bilan.arret = obtenu.nature;
          }
          break;
        }
        invoices.push({ ...doc, buffer: obtenu.buffer });
        log(`${ID} : commande ${i + 1} — facture prise (voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
      }
    }
    const restantes = aPrendreTotal - tentes;
    if (bilan.arret) bilan.nonDemandees = restantes;
    const manquees = (bilan.arret ? 1 : 0) + (bilan.arret || bilan.interruption === 'session' ? restantes : 0);

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((d, i) => ({ remoteId: remoteIdDe(d), filename: noms[i], issuedOn: d.issuedOn, buffer: d.buffer })),
      couverture: {
        complete: !bilan.interruption && !bilan.arret && !bilan.ecartees && !bilan.recentesInconnues,
        detail: `l'historique des commandes (page affichée), ${pluriel(bilan.commandes, 'commande', 'commandes')}`,
      },
    };
    if (manquees) sortie.manquees = manquees;
    if (!bilan.commandes) {
      sortie.aucunDocument = `Votre historique de commandes ${NOM} a bien été lu : il ne contient aucune commande pour l'instant.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else if (!bilan.factures && !invoices.length) {
      sortie.aucunDocument = `Votre historique de commandes ${NOM} a bien été lu : ${pluriel(bilan.commandes, 'commande', 'commandes')}, `
        + 'aucune facture proposée pour l\'instant.';
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendreTotal) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: manquees > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.commandes} commande(s), ${bilan.factures} facture(s) proposée(s), ${invoices.length} prise(s), `
      + `${bilan.deja} déjà dans l'archive, ${bilan.sansFacture} sans facture, ${bilan.autres} autre(s) document(s), `
      + `${bilan.horsPeriode} hors période, ${restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${bilan.arret ? ` — gestes arrêtés (${bilan.arret})` : ''}.`);

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
  commandesDeLaListe,
  analyserOption,
  optionsDeLaCommande,
  remoteIdDe,
  nommer,
  adresseDuSite,
  precisionDuPassage,
  fenetre,
  budgetMs,
  choisirLaFacture,
  GESTES,
  REPERE_LISTE,
  DOMAINES_DU_SITE,
  URL_HISTORIQUE,
  URL_RECENTES,
  HOTE,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
