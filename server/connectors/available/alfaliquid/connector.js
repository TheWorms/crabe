'use strict';

/**
 * Connecteur Alfaliquid — les factures des commandes, lues sur la page
 * « Historique de vos commandes » et prises dans l'onglet, sans un seul clic
 * (lot 99).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la page des commandes, enregistré connecté par
 * l'utilisateur le 11/10/2026, dont le prompt du lot 99 a repris la STRUCTURE, sans
 * aucune donnée. Boutique PrestaShop, thème classique :
 *
 *   - la liste est servie à `https://www.alfaliquid.com/fr/historique-commandes`,
 *     `body` d'`id` `history`, titre « Historique de vos commandes » ;
 *   - un tableau `table.table-history` — Référence de commande, Date, Prix
 *     total, Paiement, État, Facture, puis les actions — une ligne `tbody tr`
 *     par commande ;
 *   - la colonne Facture porte, quand la commande en a une, un lien (une
 *     icône, sans texte) vers
 *     `https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=<n>` ;
 *   - les actions : « Détails » (`controller=order-detail`) et « Commander à
 *     nouveau » (`commande?submitReorder=1&id_order=<n>`) — JAMAIS suivi ;
 *   - la même liste est répétée pour les petits écrans dans
 *     `div.orders.table-replace-resp` : elle n'est pas lue.
 *
 * NON MESURÉ : l'adresse de connexion. Le connecteur fait comme le socle
 * PrestaShop quand il doit la déduire — `index.php?controller=authentication`,
 * la forme qui marche sans réécriture d'adresse, sous le préfixe `/fr/` que les
 * liens de facture de la boutique portent déjà (voir le manifeste).
 *
 * ─── Aucun clic, aucune saisie ───────────────────────────────────────────────
 *
 * La session est ouverte par l'utilisateur dans la fenêtre de connexion de
 * crabe, puis rejouée dans un Chromium sans écran. Le connecteur ne fait que
 * deux gestes, tous deux des LECTURES : aller sur la page de la liste
 * (`naviguer`, seule fonction qui navigue), et demander chaque PDF par le
 * `fetch` du navigateur, dans la page (`onglet-pdf.fluxDeLaPage`, lot 80 —
 * mêmes cookies, même empreinte). Chaque adresse passe d'abord par
 * `adresses-interdites` : « Commander à nouveau », le panier, un retour ne
 * partent jamais, même glissés dans un lien de facture.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `alfaliquid-commande-<id_order>`, lu dans le lien de facture (le
 * numéro interne de la boutique, stable). Date : celle de la ligne. Nom :
 * `alfaliquid_AAAA-MM_<référence de commande>.pdf` — la référence lisible de
 * la ligne, celle des courriels de la boutique, à défaut l'`id_order` ; jamais
 * deux fois le même nom dans un passage.
 *
 * ─── Le temps, et « Depuis la dernière récupération » ────────────────────────
 *
 * Comme Gandi (lot 93) : le passage s'arrête de lui-même aux deux tiers de la
 * limite d'exécution et rend ce qu'il a pris — le planificateur ne dépose rien
 * d'une exécution abandonnée à la limite. Et « Depuis la dernière
 * récupération » prend tout ce qui manque à l'archive : une première
 * récupération coupée reprend au passage suivant.
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
const interdites = require('../../adresses-interdites');

const ID = 'alfaliquid';
const NOM = 'Alfaliquid';

const HOTE = 'www.alfaliquid.com';
const URL_LISTE = 'https://www.alfaliquid.com/fr/historique-commandes';

const CHAMP_SESSION = 'session';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attendre que la page se pose — borné, un site bavard ne doit pas tout coûter. */
const DELAI_REPOS_MS = 15_000;

/**
 * La limite d'une exécution (lot 67), relue comme le planificateur la relit :
 * `CRABE_LIMITE_EXECUTION_MS`, sinon quarante-cinq minutes. Un essai vérifie
 * que la valeur par défaut est celle de `scheduler.LIMITE_EXECUTION_MS`.
 */
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

/**
 * Un texte dicible au journal : chaque chiffre d'un chemin est masqué. Le
 * journal de navigation du socle ne masque que les suites de six chiffres ou
 * plus ; un numéro de commande en compte moins. Pure.
 */
function masquer(texte) {
  return String(texte ?? '').replace(/(\/[^\s;]*)/g, (chemin) => chemin.replace(/\d/g, '#'));
}

/** Les documents qu'il ne faut SURTOUT pas prendre pour des factures (socle PrestaShop). */
const MOTIF_EXCLU = /controller=pdf-(order-return|delivery-slip)/i;

/**
 * Un lien de facture de la ligne, s'il en est un : sur la boutique, en https,
 * `controller=pdf-invoice`, un `id_order` numérique, et aucun mot interdit.
 * Rend l'adresse absolue et le numéro, ou `null`. Le texte du lien ne compte
 * pas — la colonne Facture n'en a pas (une icône). Pure.
 *
 * @returns {{adresse: string, idOrder: string}|{refus: string}|null} `refus` :
 *   l'adresse aurait été un lien de facture, mais elle porte un mot interdit
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
  const mot = interdites.motInterdit(adresse);
  if (mot) return { refus: mot };
  return { adresse, idOrder: id[1] };
}

/**
 * Revérifie, JUSTE AVANT la demande, l'adresse du PDF d'une commande : la
 * forme exacte, et son `id_order` égal à celui de la ligne. Au moindre écart,
 * rien n'est demandé. Pure.
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

/** Une référence de commande dicible dans un nom de fichier, ou `null`. Pure. */
function referenceSure(texte) {
  const ref = String(texte ?? '').replace(/\s+/g, '').trim();
  return /^[A-Za-z0-9-]{1,30}$/.test(ref) ? ref : null;
}

/** L'ancre d'une facture : l'`id_order` lu dans son lien. */
function remoteIdFacture(idOrder) {
  return `${ID}-commande-${idOrder}`;
}

/**
 * Les noms de fichier d'un passage : `alfaliquid_AAAA-MM_<référence>.pdf`, et
 * jamais deux fois le même — un nom répété reçoit un suffixe. Pure.
 */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-${d.reference || d.idOrder}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures (R7).
 * Des nombres, jamais un numéro ni un montant. Pure, testée.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')}`
      + (b.deja ? `, ${pluriel(b.deja, 'facture déjà dans vos documents', 'factures déjà dans vos documents')}` : '')
      + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture', 'commandes sans facture')}` : '')
      + '.');
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
      + `Reconnectez-vous depuis la fiche d'${NOM} pour récupérer la suite.`);
  }
  return phrases.join(' ');
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — des lectures, jamais un geste
// ---------------------------------------------------------------------------

/**
 * La page affichée : son `body`, un champ de mot de passe visible, et le
 * tableau `table.table-history` — UN seul, jamais la copie pour petits écrans
 * (`div.orders.table-replace-resp`), qui n'est pas un tableau et n'est pas lue.
 */
const LIRE_LA_PAGE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const table = [...document.querySelectorAll('table.table-history')]
    .find((t) => !t.closest('.table-replace-resp')) || null;
  let entetes = [];
  let lignes = [];
  if (table) {
    entetes = [...table.querySelectorAll('thead th')].map((th) => norm(th.textContent).toLowerCase());
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
    // Des commandes ailleurs dans la page (détail, facture, la copie pour
    // petits écrans) : sans tableau, c'est que la page a changé, pas que le
    // compte est vide. Un compte, pas une lecture.
    signesDeCommandes: document.querySelectorAll('a[href*="controller=order-detail"], a[href*="controller=pdf-invoice"]').length,
  };
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** La seule navigation : une adresse sans mot interdit, puis l'attente — bornée. */
async function naviguer(page, adresse) {
  const mot = interdites.motInterdit(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot interdit « ${mot} »).`);
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/**
 * Le lancement du navigateur, seul point remplaçable : les essais y branchent
 * un faux site (pages reconstituées, réseau coupé) et éprouvent tout le
 * reste tel quel.
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  /** L'horloge du budget de temps — remplaçable aussi, pour l'éprouver sans attendre. */
  maintenant: () => Date.now(),
};

/**
 * Ouvre un navigateur sur la connexion enregistrée. Le journal de navigation
 * (lot 87 : chemins et noms de cookies, jamais une valeur) suit le passage.
 */
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

/** Lit la page affichée ; ne lève jamais (une page en cours de navigation se lit vide). */
async function lireLaPage(page) {
  const vue = await page.evaluate(LIRE_LA_PAGE).catch(() => null)
    || { url: page.url(), bodyId: '', motDePasse: false, tableau: false, entetes: [], lignes: [], signesDeCommandes: 0 };
  vue.mur = await profilMarchand.estMurAntiRobot(page);
  return vue;
}

/**
 * Rejoint la liste et JUGE l'arrivée. Rend la page lue, ou lève : renvoi vers
 * la connexion (classé par le lot 91), mur anti-robot, page illisible.
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
    // body#history sans tableau : un compte sans commande — le thème classique
    // l'écrit en phrase, forme non mesurée. Mais si la page porte des liens de
    // commande ailleurs, c'est elle qui a changé : on ne conclut pas « 0 ».
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
 * limite de la conservation (voir l'en-tête, et Gandi au lot 93).
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
 * s'il en a un (refusé s'il porte un mot interdit), sa date, sa référence.
 * Pure, testée.
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
      const remoteId = remoteIdFacture(c.facture.idOrder);
      if (connus.has(remoteId)) {
        bilan.deja++;
        continue;
      }
      if (aPrendre.some((d) => d.remoteId === remoteId)) continue;
      if (!scraping.dansLaFenetre(c.issuedOn, plan)) {
        bilan.horsPeriode++;
        continue;
      }
      aPrendre.push({ remoteId, idOrder: c.facture.idOrder, adresse: c.facture.adresse, issuedOn: c.issuedOn, reference: c.reference });
    }
    log(`${ID} : ${bilan.commandes} commande(s) lue(s) dans le tableau des commandes — `
      + `${bilan.commandes - bilan.sansFacture - bilan.ecartes} avec un lien de facture, ${bilan.sansFacture} sans facture, `
      + `${bilan.deja} déjà dans l'archive, ${aPrendre.length} à prendre, ${bilan.horsPeriode} hors période.`);

    // La preuve exigée par le socle (lot 31) : la liste a été LUE.
    ctx.preuveDeListe?.({
      session: `historique des commandes ${NOM} servi au compte connecté (body#history)`,
      liste: URL_LISTE,
      elements: bilan.commandes,
    });

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
      const controle = verifierAdresse(doc.adresse, doc.idOrder);
      if (!controle.ok) {
        manquees++;
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
      log(`${ID} : une facture n'a pas pu être prise : le document ${String(lu.grief || '').replace(/\s+/g, ' ').slice(0, 400)}.`);
      // Un refus peut être une session tombée : on le vérifie par la page, une fois.
      if (await sessionTombee(page)) {
        manquees--;
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
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: nonObtenues > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.commandes} commande(s) lue(s), ${invoices.length} prise(s), ${manquees} manquée(s), `
      + `${bilan.deja} déjà dans l'archive, ${bilan.sansFacture} sans facture, ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
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
  URL_LISTE,
  HOTE,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
