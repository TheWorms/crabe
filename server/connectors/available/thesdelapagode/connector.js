'use strict';

/**
 * Connecteur Les Thés de la Pagode — les factures des commandes, lues sur la
 * page « Historique de vos commandes » et prises dans l'onglet, sans un seul
 * clic (lot 110).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * MESURÉ — une reconnaissance publique, cinq requêtes GET sans compte, le
 * 18/10/2026 (docs/reconnaissance-lot110.md), la structure seule :
 *
 *   - boutique PrestaShop : l'objet de page `prestashop` standard (ses
 *     adresses de contrôleurs), des cookies `PrestaShop-…`, un thème maison
 *     (« antadis ») ; version non lisible ;
 *   - l'historique des commandes est `https://www.thesdelapagode.com/fr/historique-commandes`,
 *     et il renvoie un visiteur anonyme vers `/fr/connexion?back=history` ;
 *   - la connexion : le formulaire standard (`form#login-form`, champs
 *     `email` et `password`) — jamais rempli ni envoyé par ce connecteur ;
 *   - les factures : le contrôleur standard
 *     `/fr/index.php?controller=pdf-invoice` (avec `&id_order=<n>`) ;
 *   - la déconnexion : `/fr/?mylogout=` ; aucune garde anti-robot vue.
 *
 * NON VÉRIFIÉ — la page de l'historique CONNECTÉE n'a jamais été vue. Sa forme
 * est PRÉSUMÉE celle du thème PrestaShop standard : `body#history`, un
 * tableau dont l'en-tête dit « Référence » (classe `table-history` dans le
 * thème classique), une ligne par commande, la référence lisible dans la
 * ligne, un lien `pdf-invoice&id_order=<n>` quand la commande a une facture.
 * Le connecteur JUGE cette forme : si la page est l'historique mais ne
 * présente pas ce tableau alors qu'elle porte des liens de commande, il dit
 * que la page a changé — jamais « aucune facture » sur une page qu'il n'a pas
 * su lire.
 *
 * ─── Aucun clic, aucune saisie ───────────────────────────────────────────────
 *
 * La session est ouverte par l'utilisateur dans la fenêtre de connexion de
 * crabe, puis rejouée dans un Chromium sans écran. Deux gestes, tous deux des
 * LECTURES : aller sur la page de la liste (`naviguer`, seule fonction qui
 * navigue), et demander chaque PDF par le `fetch` du navigateur, dans la page
 * (`onglet-pdf.fluxDeLaPage` — mêmes cookies, même origine ; un document qui
 * n'est pas un PDF est refusé).
 *
 * ─── Des adresses fermées, par construction ──────────────────────────────────
 *
 * La liste `MOTS_INTERDITS` (déconnexion, identité et compte, adresses, mot
 * de passe, panier, commande et paiement, avoirs, retours, bons de livraison)
 * est contrôlée avant CHAQUE requête du connecteur, ET posée sur le réseau du
 * navigateur : toute requête qui en porte un — du connecteur ou de la page —
 * est avortée avant de partir, et comptée au journal.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `thesdelapagode-commande-<référence>` : la référence de commande LUE
 * dans la ligne (celle des courriels de la boutique) — jamais un jeton. Deux
 * lignes de même référence (une commande scindée, que PrestaShop range sous
 * une seule référence) prennent chacune `-<id_order>` en plus. Une ligne
 * facturée SANS référence lisible n'est pas prise, et comptée. Date : celle
 * de la ligne. Nom : `thesdelapagode_AAAA-MM_<référence>.pdf`.
 *
 * ─── Le temps, et « Depuis la dernière récupération » ────────────────────────
 *
 * Comme Alfaliquid (lot 99) : le passage s'arrête de lui-même aux deux tiers
 * de la limite d'exécution et rend ce qu'il a pris ; « Depuis la dernière
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
const preuve = require('../../preuve-connexion');

const ID = 'thesdelapagode';
const NOM = 'Les Thés de la Pagode';

const HOTE = 'www.thesdelapagode.com';
const URL_LISTE = 'https://www.thesdelapagode.com/fr/historique-commandes';

const CHAMP_SESSION = 'session';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attendre que la page se pose — borné, un site bavard ne doit pas tout coûter. */
const DELAI_REPOS_MS = 15_000;

/**
 * La limite d'une exécution (lot 67), relue comme le planificateur la relit :
 * `CRABE_LIMITE_EXECUTION_MS`, sinon quarante-cinq minutes.
 */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;

/** La part de cette limite que le connecteur s'accorde. */
const PART_DU_TEMPS = 2 / 3;

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

/**
 * Les adresses que ce connecteur ne demande jamais, et que le navigateur
 * qu'il pilote ne laisse pas partir : un mot de cette liste, dans l'adresse
 * telle quelle ou décodée, sans casse.
 */
const MOTS_INTERDITS = Object.freeze([
  'mylogout', 'logout',
  'identite', 'identity',
  'adresse', 'address',
  'mot-de-passe', 'password',
  'panier', 'cart',
  'submitReorder', 'reorder',
  'paiement', 'payment', 'validation',
  'avoir', 'order-slip',
  'delivery-slip',
  'return',
  'order-follow', 'suivi-commande',
]);

/** Le tunnel de commande : `/fr/commande` (segment exact) ou `controller=order` seul. */
const MOTIF_COMMANDE = /\/commande(?:[/?#]|$)|[?&]controller=order(?:&|$)/i;

function decodee(texte) {
  try {
    return decodeURIComponent(texte);
  } catch {
    return texte;
  }
}

/** Le mot interdit que porte une adresse, ou `null`. Pure. */
function motInterdit(adresse) {
  const brute = String(adresse ?? '');
  const formes = [brute.toLowerCase(), decodee(brute).toLowerCase()];
  for (const mot of MOTS_INTERDITS) {
    if (formes.some((f) => f.includes(mot.toLowerCase()))) return mot;
  }
  if (formes.some((f) => MOTIF_COMMANDE.test(f))) return 'commande';
  return null;
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

/** Un texte dicible au journal : chaque chiffre d'un chemin est masqué. Pure. */
function masquer(texte) {
  return String(texte ?? '').replace(/(\/[^\s;]*)/g, (chemin) => chemin.replace(/\d/g, '#'));
}

/** Les documents qu'il ne faut SURTOUT pas prendre pour des factures. */
const MOTIF_EXCLU = /controller=pdf-(order-return|order-slip|delivery-slip)/i;

/**
 * Un lien de facture de la ligne, s'il en est un : sur la boutique, en https,
 * `controller=pdf-invoice`, un `id_order` numérique, et aucun mot interdit.
 * Pure.
 *
 * @returns {{adresse: string, idOrder: string}|{refus: string}|null}
 */
function lienDeFacture(href, base = URL_LISTE) {
  let u;
  try {
    u = new URL(String(href ?? ''), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== HOTE) return null;
  const adresse = u.href;
  if (!/[?&]controller=pdf-invoice(?:&|$)/i.test(u.search) || MOTIF_EXCLU.test(adresse)) return null;
  const id = /[?&]id_order=(\d{1,12})(?:&|$)/i.exec(u.search);
  if (!id) return null;
  const mot = motInterdit(adresse);
  if (mot) return { refus: mot };
  return { adresse, idOrder: id[1] };
}

/**
 * Revérifie, JUSTE AVANT la demande, l'adresse du PDF : la forme exacte, et
 * son `id_order` égal à celui de la ligne. Au moindre écart, rien n'est
 * demandé. Pure.
 */
function verifierAdresse(adresse, idOrder) {
  const lien = lienDeFacture(adresse);
  if (!lien || lien.refus) return { ok: false, raison: lien?.refus ? `mot interdit « ${lien.refus} »` : 'hors de la forme d\'un lien de facture' };
  if (lien.idOrder !== String(idOrder)) return { ok: false, raison: 'numéro de commande différent de celui de la ligne' };
  return { ok: true };
}

/**
 * Où le navigateur est-il ARRIVÉ ? Jugé sur ce que la page montre.
 *
 * @param {{url: string, bodyId?: string, motDePasse?: boolean, mur?: boolean}} vue
 * @returns {{verdict: 'liste'|'connexion-demandee'|'mur'|'page-illisible', raison: string}}
 */
function jugerArrivee(vue) {
  let u;
  try {
    u = new URL(String(vue?.url || ''));
  } catch {
    return { verdict: 'page-illisible', raison: 'adresse finale illisible' };
  }
  if (vue?.mur) return { verdict: 'mur', raison: 'vérification de sécurité du site à l\'écran' };
  if (u.hostname !== HOTE) return { verdict: 'page-illisible', raison: `arrivé sur ${u.hostname}, hors de la boutique` };
  if (preuve.estUrlAuthentification(u.href) || vue?.motDePasse) {
    return { verdict: 'connexion-demandee', raison: `renvoyé vers ${masquer(u.pathname)}, la page de connexion` };
  }
  if (vue?.bodyId === 'history') return { verdict: 'liste', raison: 'page de l\'historique des commandes (body#history)' };
  return { verdict: 'page-illisible', raison: `arrivé sur ${masquer(u.pathname)}, qui n'est pas l'historique des commandes` };
}

/** Une référence de commande dicible dans une ancre et un nom de fichier, ou `null`. Pure. */
function referenceSure(texte) {
  const ref = String(texte ?? '').replace(/\s+/g, '').trim();
  return /^[A-Za-z0-9-]{1,30}$/.test(ref) ? ref.toUpperCase() : null;
}

/** L'ancre d'une facture : la référence lue, et l'`id_order` en cas de référence partagée. Pure. */
function remoteIdFacture(reference, idOrder = null) {
  return `${ID}-commande-${reference}${idOrder ? `-${idOrder}` : ''}`;
}

/**
 * Les noms de fichier d'un passage : `thesdelapagode_AAAA-MM_<référence>.pdf`,
 * jamais deux fois le même — un nom répété reçoit un suffixe. Pure.
 */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-${d.reference}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures. Des
 * nombres, jamais un numéro ni un montant. Pure.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')}`
      + (b.deja ? `, ${pluriel(b.deja, 'facture déjà dans vos documents', 'factures déjà dans vos documents')}` : '')
      + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture', 'commandes sans facture')}` : '')
      + '.');
  }
  if (b.sansReference) {
    phrases.push(`${b.sansReference > 1 ? `${b.sansReference} factures n'ont pas été prises : leur commande n'affiche` : 'Une facture n\'a pas été prise : sa commande n\'affiche'} `
      + 'pas de référence lisible.');
  }
  if (b.ecartes) {
    phrases.push(`${b.ecartes > 1 ? `${b.ecartes} liens ont été écartés : ils ne menaient` : 'Un lien a été écarté : il ne menait'} `
      + 'pas à une facture de la boutique.');
  }
  if (b.interruption === 'temps') {
    const reste = b.restantes > 1
      ? `${b.restantes} factures attendent encore ; elles viendront au prochain passage.`
      : '1 facture attend encore ; elle viendra au prochain passage.';
    phrases.push(`La récupération a pris tout le temps permis : ${reste} Rien de ce qui a été pris n'est perdu.`);
  }
  if (b.interruption === 'session') {
    phrases.push(`La lecture s'est interrompue — ${NOM} a demandé de vous reconnecter : les factures déjà prises sont gardées. `
      + 'Reconnectez-vous depuis la fiche du service pour récupérer la suite.');
  }
  return phrases.join(' ');
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — des lectures, jamais un geste
// ---------------------------------------------------------------------------

/**
 * La page affichée : son `body`, un champ de mot de passe visible, et LE
 * tableau des commandes — celui dont l'en-tête dit « Référence » (forme
 * PrestaShop standard, présumée), jamais une copie pour petits écrans
 * (`.table-replace-resp`, `div.orders`), qui n'est pas lue.
 */
const LIRE_LA_PAGE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const enTetes = (t) => [...t.querySelectorAll('thead th')].map((th) => norm(th.textContent).toLowerCase());
  const candidates = [...document.querySelectorAll('table')]
    .filter((t) => !t.closest('.table-replace-resp'))
    .filter((t) => enTetes(t).some((x) => /r[ée]f[ée]rence/.test(x)));
  const table = candidates.find((t) => t.classList.contains('table-history')) || candidates[0] || null;
  let entetes = [];
  let lignes = [];
  if (table) {
    entetes = enTetes(table);
    const iRef = entetes.findIndex((x) => /r[ée]f[ée]rence/.test(x));
    const iDate = entetes.findIndex((x) => x === 'date');
    lignes = [...table.querySelectorAll('tbody tr')].map((tr) => {
      const cellules = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      return {
        reference: iRef >= 0 && cellules[iRef] ? norm(cellules[iRef].textContent) : '',
        dateTexte: iDate >= 0 && cellules[iDate] ? norm(cellules[iDate].textContent) : '',
        // Le texte de la ligne : la date s'y relit si la colonne « Date » a
        // changé de titre — jamais journalisé.
        texte: norm(tr.textContent).slice(0, 400),
        liens: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      };
    });
  }
  return {
    url: location.href,
    bodyId: document.body ? document.body.id : '',
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    tableau: !!table,
    entetes,
    lignes,
    // Des commandes ailleurs dans la page : sans tableau, c'est que la page a
    // changé, pas que le compte est vide. Un compte, pas une lecture.
    signesDeCommandes: document.querySelectorAll('a[href*="controller=order-detail"], a[href*="controller=pdf-invoice"]').length,
  };
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** La seule navigation : une adresse sans mot interdit, puis l'attente — bornée. */
async function naviguer(page, adresse) {
  const mot = motInterdit(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot interdit « ${mot} »).`);
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/**
 * Le lancement du navigateur, seul point remplaçable : les essais y branchent
 * un faux site (page inventée, réseau coupé) et éprouvent tout le reste tel
 * quel. L'horloge du budget se remplace aussi.
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
};

/**
 * Ouvre un navigateur sur la connexion enregistrée, AVEC la liste fermée posée
 * sur son réseau : une requête qui porte un mot interdit — du connecteur ou
 * de la page — est avortée avant de partir, et comptée. Le journal de
 * navigation (chemins et noms de cookies, jamais une valeur) suit le passage.
 */
async function surLeCompte(config, ctx, fn) {
  const log = ctx?.log || (() => {});
  const session = lireSession(config);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  const avortees = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: false })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    await context.route((url) => motInterdit(url.href) !== null, (route) => {
      avortees.push(motInterdit(route.request().url()));
      return route.abort('blockedbyclient');
    });
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    // Aucune boîte n'est attendue (aucun geste) : une boîte est refusée.
    page.on('dialog', (boite) => { boite.dismiss().catch(() => {}); });
    navigation.brancher(page, { log: (ligne) => log(masquer(ligne)), prefixe: `${ID} : navigation` });
    return await fn(page, context);
  } finally {
    if (avortees.length) {
      log(`${ID} : ${pluriel(avortees.length, 'requête interdite avortée', 'requêtes interdites avortées')} avant de partir `
        + `(${[...new Set(avortees)].map((m) => `« ${m} »`).join(', ')}).`);
    }
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
      + 'commandes : elle ne ressemble pas à celle qu\'il attend. Votre connexion n\'est pas '
      + 'en cause : inutile de la rouvrir. Signalez-le pour que la lecture soit mise à jour ; '
      + 'la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

/** Lit la page affichée ; ne lève jamais (une page en cours de navigation se lit vide). */
async function lireLaPage(page) {
  const vue = await page.evaluate(LIRE_LA_PAGE).catch(() => null)
    || { url: page.url(), bodyId: '', motDePasse: false, tableau: false, entetes: [], lignes: [], signesDeCommandes: 0 };
  vue.mur = await profilMarchand.estMurAntiRobot(page);
  return vue;
}

/**
 * Rejoint la liste et JUGE l'arrivée. Rend la page lue, ou lève : renvoi vers
 * la connexion (session expirée), mur anti-robot, page illisible.
 */
async function arriverSurLaListe(page, log) {
  await naviguer(page, URL_LISTE);
  const vue = await lireLaPage(page);
  const jugement = jugerArrivee(vue);
  log(`${ID} : arrivée jugée « ${jugement.verdict} » — ${jugement.raison}.`);
  if (jugement.verdict === 'connexion-demandee') {
    throw profilMarchand.erreurRenvoiVersAuthentification(NOM, jugement.raison);
  }
  if (jugement.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (jugement.verdict !== 'liste') throw erreurPageIllisible(jugement.raison);
  if (!vue.tableau) {
    // L'historique sans tableau des commandes : un compte sans commande — si
    // et seulement si la page ne porte aucun lien de commande ailleurs. Sinon
    // c'est la page qui n'a pas la forme présumée : on ne conclut pas « 0 ».
    if (vue.signesDeCommandes) {
      throw erreurPageIllisible(`aucun tableau des commandes, mais ${vue.signesDeCommandes} lien(s) de commande dans la page`);
    }
    log(`${ID} : aucun tableau des commandes sur l'historique — le compte n'a pas encore de commande.`);
  }
  return vue;
}

/** La session est-elle tombée ? Se vérifie par la page de la liste, une fois. */
async function sessionTombee(page) {
  await naviguer(page, URL_LISTE);
  return jugerArrivee(await lireLaPage(page)).verdict === 'connexion-demandee';
}

/**
 * La fenêtre d'historique : le réglage de l'utilisateur, sauf « Depuis la
 * dernière récupération », qui prend tout ce qui manque à l'archive — dans la
 * limite de la conservation.
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

/**
 * Les commandes de la page, une par ligne du tableau : son lien de facture
 * s'il en a un (refusé s'il porte un mot interdit), sa date, sa référence, et
 * son ancre. Une référence partagée par plusieurs lignes facturées donne à
 * chacune son `id_order` en plus. Pure, testée.
 */
function commandesDeLaPage(vue) {
  const commandes = [];
  for (const ligne of vue?.lignes || []) {
    const lus = (ligne.liens || []).map((h) => lienDeFacture(h, vue.url)).filter(Boolean);
    const facture = lus.find((l) => !l.refus) || null;
    commandes.push({
      facture,
      refus: !facture && lus.some((l) => l.refus) ? lus.find((l) => l.refus).refus : null,
      issuedOn: pageDocs.dateDepuisTexte(ligne.dateTexte) || pageDocs.dateDepuisTexte(ligne.texte),
      reference: referenceSure(ligne.reference),
    });
  }
  const parReference = new Map();
  for (const c of commandes) {
    if (c.facture && c.reference) parReference.set(c.reference, (parReference.get(c.reference) || 0) + 1);
  }
  for (const c of commandes) {
    c.remoteId = c.facture && c.reference
      ? remoteIdFacture(c.reference, parReference.get(c.reference) > 1 ? c.facture.idOrder : null)
      : null;
  }
  return commandes;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la liste s'ouvre au compte connecté. */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    const vue = await arriverSurLaListe(page, log);
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — ${pluriel(vue.lignes.length, 'commande visible', 'commandes visibles')} `
        + `dans votre historique ${NOM}. Leurs factures seront prises à la prochaine récupération.`,
    };
  });
}

/**
 * Les factures des commandes, en deux temps : LIRE la liste, puis PRENDRE
 * chaque PDF manquant dans l'onglet. Ce qui est pris est GARDÉ quoi qu'il
 * arrive ensuite — session tombée en route, temps écoulé.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const vue = await arriverSurLaListe(page, log);
    const commandes = commandesDeLaPage(vue);

    const bilan = {
      commandes: commandes.length,
      sansFacture: 0,
      sansReference: 0,
      deja: 0,
      ecartes: 0,
      horsPeriode: 0,
      restantes: 0,
      interruption: null,
    };

    const aPrendre = [];
    for (const c of commandes) {
      if (c.refus) {
        bilan.ecartes++;
        log(`${ID} : un lien de facture a été écarté sans être suivi — il porte le mot interdit « ${c.refus} ».`);
        continue;
      }
      if (!c.facture) {
        bilan.sansFacture++;
        continue;
      }
      if (!c.remoteId) {
        // Jamais d'ancre sur un jeton ni sur un numéro interne seul : sans
        // référence lisible, la facture n'est pas prise — et c'est dit.
        bilan.sansReference++;
        log(`${ID} : une facture n'a pas été prise — sa commande n'affiche pas de référence lisible.`);
        continue;
      }
      if (connus.has(c.remoteId)) {
        bilan.deja++;
        continue;
      }
      if (aPrendre.some((d) => d.remoteId === c.remoteId)) continue;
      if (!scraping.dansLaFenetre(c.issuedOn, plan)) {
        bilan.horsPeriode++;
        continue;
      }
      aPrendre.push({ remoteId: c.remoteId, idOrder: c.facture.idOrder, adresse: c.facture.adresse, issuedOn: c.issuedOn, reference: c.reference });
    }
    log(`${ID} : ${bilan.commandes} commande(s) lue(s) dans le tableau des commandes — `
      + `${bilan.commandes - bilan.sansFacture - bilan.ecartes} avec un lien de facture, ${bilan.sansFacture} sans facture, `
      + `${bilan.sansReference} sans référence lisible, ${bilan.deja} déjà dans l'archive, ${aPrendre.length} à prendre, `
      + `${bilan.horsPeriode} hors période.`);

    // La preuve exigée par le socle (lot 31) : la liste a été LUE.
    ctx.preuveDeListe?.({
      session: `historique des commandes ${NOM} servi au compte connecté (body#history)`,
      liste: URL_LISTE,
      elements: bilan.commandes,
    });

    const invoices = [];
    let manquees = bilan.sansReference;
    let manqueesAuTelechargement = 0;
    let renoncement = null;
    let tentees = 0;
    const serie = serieEchecs.suiteDEchecs();
    for (const doc of aPrendre) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      tentees++;
      const controle = verifierAdresse(doc.adresse, doc.idOrder);
      if (!controle.ok) {
        manquees++;
        manqueesAuTelechargement++;
        log(`${ID} : une facture n'a pas été demandée — ${controle.raison}.`);
        continue;
      }
      const lu = await ongletPdf.fluxDeLaPage(page, doc.adresse);
      if (lu.ok) {
        serie.reussite();
        invoices.push({ ...doc, buffer: lu.buffer });
        continue;
      }
      manquees++;
      manqueesAuTelechargement++;
      log(`${ID} : une facture n'a pas pu être prise : le document ${String(lu.grief || '').replace(/\s+/g, ' ').slice(0, 400)}.`);
      // Un refus peut être une session tombée : on le vérifie par la page, une fois.
      if (await sessionTombee(page)) {
        manquees--;
        manqueesAuTelechargement--;
        tentees--;
        if (!invoices.length) {
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
        }
        bilan.interruption = 'session';
        log(`${ID} : renvoyé vers la connexion en prenant les factures : les ${invoices.length} déjà prise(s) sont gardées.`);
        break;
      }
      if (serie.echec(lu.grief)) {
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
        complete: !bilan.interruption && !renoncement && !nonObtenues,
        detail: `l'historique des commandes ${NOM}, ${pluriel(bilan.commandes, 'commande', 'commandes')}`,
      },
    };
    if (nonObtenues) {
      sortie.manquees = nonObtenues;
      if (renoncement) sortie.renoncement = renoncement;
    }
    const avecFacture = bilan.commandes - bilan.sansFacture - bilan.ecartes;
    if (!bilan.commandes) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : aucune commande pour l'instant.`;
    } else if (!avecFacture) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : `
        + `${pluriel(bilan.commandes, 'commande', 'commandes')}, aucune n'a encore de facture.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length && !nonObtenues) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: nonObtenues > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.commandes} commande(s) lue(s), ${invoices.length} prise(s), ${manqueesAuTelechargement} manquée(s) `
      + `au téléchargement, ${bilan.sansReference} sans référence, ${bilan.deja} déjà dans l'archive, ${bilan.sansFacture} sans facture, `
      + `${bilan.horsPeriode} hors période, ${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${nonDemandees ? ` — arrêt avant la fin : ces ${nonDemandees} non demandée(s) comptent comme non obtenues` : ''}.`);

    // L'état de session d'un passage qui a lu la liste remplace la capture
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
  // exportés pour les tests unitaires
  lireSession,
  motInterdit,
  lienDeFacture,
  verifierAdresse,
  jugerArrivee,
  referenceSure,
  remoteIdFacture,
  nommer,
  masquer,
  precisionDuPassage,
  commandesDeLaPage,
  fenetre,
  budgetMs,
  LIRE_LA_PAGE,
  MOTS_INTERDITS,
  URL_LISTE,
  HOTE,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
