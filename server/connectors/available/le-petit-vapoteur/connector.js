'use strict';

/**
 * Connecteur Le Petit Vapoteur — les factures des commandes, lues sur
 * l'historique des commandes et prises dans l'onglet, sans un seul clic
 * (lot 99).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — le code source de la page des commandes, enregistré connecté par
 * l'utilisateur le 11/10/2026, dont le prompt du lot 99 a repris la STRUCTURE, sans
 * aucune donnée. Boutique PrestaShop, thème maison :
 *
 *   - la liste est servie à
 *     `https://www.lepetitvapoteur.com/fr/historique-des-commandes`, `body`
 *     d'`id` `history` et de classe `logged` ;
 *   - connexion à `/fr/authentification?back=/fr/` ; déconnexion à
 *     `/?mylogout` — JAMAIS appelée ;
 *   - chaque commande est un `div.item-cmd` : un `div.item-cmd-head` (l'état
 *     `span.cmd-state-<n>`, la date, « N° de commande » et `span.cmd-number`,
 *     le prix, des points de fidélité), les produits, puis
 *     `div.item-cmd-content_actions` : un `div.invoice` qui contient
 *     `a.invoice-link.pdf` (« Télécharger la facture »), « Voir la commande »
 *     (`#showOrder`) et « Acheter à nouveau » (`#reOrder`) — ces deux-là
 *     JAMAIS suivis.
 *
 * ⚠ L'ADRESSE DE LA FACTURE EST MAL FORMÉE (annoncé) :
 * `…/fr/index.php?controller=pdf-invoice?id_order=<n>` — un second `?` au lieu
 * de `&`. Ce que le site en fait est NON MESURÉ. D'où la règle (R2) : crabe
 * demande d'abord l'adresse TELLE QUE LA PAGE LA DONNE ; si ce n'est pas un
 * PDF, il demande sa forme corrigée (`&id_order=<n>`), qui n'est qu'une
 * lecture ; la forme qui a marché est retenue pour tout le passage et dite une
 * fois au journal ; si aucune ne sert de PDF, il s'arrête pour cette boutique
 * et le dit.
 *
 * MESURÉ le 11/08/2026 (note de l'ancienne annonce) : une protection
 * Cloudflare fermait la connexion automatique avant même la saisie. La
 * connexion se fait désormais par la fenêtre, à la main ; le rejeu sans écran
 * qui suit n'a jamais été éprouvé face à cette protection (NON MESURÉ) : si
 * elle s'affiche, le connecteur la reconnaît et le dit.
 *
 * ─── Aucun clic, aucune saisie ───────────────────────────────────────────────
 *
 * Deux gestes, tous deux des LECTURES : aller sur la page de la liste
 * (`naviguer`, seule fonction qui navigue), et demander chaque PDF par le
 * `fetch` du navigateur, dans la page (`onglet-pdf.fluxDeLaPage`, lot 80).
 * Chaque adresse passe d'abord par `adresses-interdites`. Dans un bloc de
 * commande, seule une adresse de la boutique qui porte `controller=pdf-invoice`
 * est suivie ; tout autre lien est ignoré.
 *
 * ─── L'ancre, la date, le nom ────────────────────────────────────────────────
 *
 * Ancre `le-petit-vapoteur-commande-<id_order>`, lu dans le lien. Date : celle
 * de l'en-tête du bloc. Nom : `le-petit-vapoteur_AAAA-MM_<n° de commande>.pdf`
 * (le numéro affiché, à défaut l'`id_order`), jamais deux fois le même.
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
const preuve = require('../../preuve-connexion');
const interdites = require('../../adresses-interdites');

const ID = 'le-petit-vapoteur';
const NOM = 'Le Petit Vapoteur';

const HOTE = 'www.lepetitvapoteur.com';
const URL_LISTE = 'https://www.lepetitvapoteur.com/fr/historique-des-commandes';

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

/** Les deux formes de l'adresse d'une facture, telles que le journal et l'écran les nomment. */
const FORME_DONNEE = 'telle-quelle';
const FORME_CORRIGEE = 'corrigee';

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

/** Les documents qu'il ne faut SURTOUT pas prendre pour des factures (socle PrestaShop). */
const MOTIF_EXCLU = /controller=pdf-(order-return|delivery-slip)/i;

/**
 * Un lien de facture d'un bloc de commande, s'il en est un : sur la boutique,
 * en https, `controller=pdf-invoice` — suivi de `&` ou, dans la forme mal
 * formée de la boutique, d'un second `?` —, un `id_order` numérique, et
 * aucun mot interdit. Rend les DEUX formes de l'adresse : telle que la page
 * la donne, et corrigée (`&id_order=<n>`) ; elles sont égales quand la page
 * donne une adresse bien formée. Pure.
 *
 * @returns {{telleQuelle: string, corrigee: string, idOrder: string}|{refus: string}|null}
 */
function lienDeFacture(href, base = URL_LISTE) {
  let u;
  try {
    u = new URL(String(href ?? ''), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== HOTE) return null;
  const telleQuelle = u.href;
  if (!/[?&]controller=pdf-invoice(?:[&?]|$)/i.test(u.search) || MOTIF_EXCLU.test(telleQuelle)) return null;
  const id = /[?&]id_order=(\d{1,12})(?:&|$)/i.exec(u.search);
  if (!id) return null;
  const mot = interdites.motInterdit(telleQuelle);
  if (mot) return { refus: mot };
  const corrigee = `${u.origin}${u.pathname}?controller=pdf-invoice&id_order=${id[1]}`;
  return { telleQuelle, corrigee, idOrder: id[1] };
}

/**
 * Revérifie, JUSTE AVANT la demande, une adresse de PDF : l'une des deux
 * formes du lien de cette commande, son `id_order` égal à celui du bloc. Au
 * moindre écart, rien n'est demandé. Pure.
 */
function verifierAdresse(adresse, idOrder) {
  const lien = lienDeFacture(adresse);
  if (!lien || lien.refus) return { ok: false, raison: lien?.refus ? `mot interdit « ${lien.refus} »` : 'hors de la forme d\'un lien de facture' };
  if (lien.idOrder !== String(idOrder)) return { ok: false, raison: 'numéro de commande différent de celui du bloc' };
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

/** Un numéro de commande dicible dans un nom de fichier, ou `null`. Pure. */
function referenceSure(texte) {
  const ref = String(texte ?? '').replace(/\s+/g, '').replace(/^n[°o]\.?/i, '').trim();
  return /^[A-Za-z0-9-]{1,30}$/.test(ref) ? ref : null;
}

/** L'ancre d'une facture : l'`id_order` lu dans son lien. */
function remoteIdFacture(idOrder) {
  return `${ID}-commande-${idOrder}`;
}

/** Les noms de fichier d'un passage, jamais deux fois le même. Pure. */
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
 * Ce que l'écran dit d'un passage, en plus du compte des factures (R7) : les
 * commandes lues, celles déjà dans l'archive, celles sans facture, et la forme
 * d'adresse retenue — ou l'arrêt. Des nombres, jamais un numéro. Pure.
 */
function precisionDuPassage(b, { sansTiret = false, sansCompte = false } = {}) {
  const phrases = [];
  if (!sansCompte) {
    phrases.push(`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')}`
      + (b.deja ? `, ${pluriel(b.deja, 'facture déjà dans vos documents', 'factures déjà dans vos documents')}` : '')
      + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture', 'commandes sans facture')}` : '')
      + '.');
  }
  if (b.forme === FORME_DONNEE) {
    phrases.push('Les factures ont été prises à l\'adresse que donne la boutique.');
  } else if (b.forme === FORME_CORRIGEE) {
    phrases.push('L\'adresse de facture que donne la boutique ne servait pas le PDF : '
      + 'crabe a pris les factures à cette adresse, corrigée.');
  }
  if (b.bloque) {
    phrases.push('La boutique n\'a servi aucune facture, ni à l\'adresse qu\'elle donne, ni à cette adresse '
      + 'corrigée : crabe s\'est arrêté là pour cette boutique. Signalez-le pour que la lecture soit mise à jour.');
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
 * La page affichée : son `body`, un champ de mot de passe visible, et chaque
 * bloc `div.item-cmd` — le texte de son en-tête (sans le numéro de commande,
 * pour que la date se lise seule), son numéro, et les liens du bloc.
 */
const LIRE_LA_PAGE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const blocs = [...document.querySelectorAll('div.item-cmd')].map((bloc) => {
    const tete = bloc.querySelector('.item-cmd-head');
    const numero = tete ? tete.querySelector('span.cmd-number') : null;
    let texteTete = '';
    if (tete) {
      const copie = tete.cloneNode(true);
      for (const n of [...copie.querySelectorAll('span.cmd-number')]) n.remove();
      texteTete = norm(copie.textContent).slice(0, 300);
    }
    return {
      numero: numero ? norm(numero.textContent) : '',
      texteTete,
      liens: [...bloc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    };
  });
  return {
    url: location.href,
    bodyId: document.body ? document.body.id : '',
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    blocs,
    // Des liens de commande hors des blocs : sans bloc, la page a changé,
    // le compte n'est pas forcément vide. Un compte, pas une lecture.
    signesDeCommandes: document.querySelectorAll('a[href*="controller=pdf-invoice"], a[href*="controller=order-detail"]').length,
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

/** Le lancement du navigateur et l'horloge : les seuls points remplaçables. */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
};

/** Ouvre un navigateur sur la connexion enregistrée ; le journal de navigation suit le passage. */
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
    || { url: page.url(), bodyId: '', motDePasse: false, blocs: [], signesDeCommandes: 0 };
  vue.mur = await profilMarchand.estMurAntiRobot(page);
  return vue;
}

/** Rejoint la liste et JUGE l'arrivée ; lève sur un renvoi, un mur, une page illisible. */
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
  if (!vue.blocs.length) {
    if (vue.signesDeCommandes) {
      throw erreurPageIllisible(`aucun bloc de commande, mais ${vue.signesDeCommandes} lien(s) de commande dans la page`);
    }
    log(`${ID} : aucun bloc de commande sur l'historique — le compte n'a pas encore de commande.`);
  }
  return vue;
}

/** La session est-elle tombée ? Se vérifie par la page de la liste, une fois. */
async function sessionTombee(page) {
  await naviguer(page, URL_LISTE);
  return jugerArrivee(await lireLaPage(page)).verdict === 'connexion-demandee';
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
 * Les commandes de la page, une par bloc : son lien de facture s'il en a un
 * (tout autre lien du bloc est ignoré ; un lien de facture qui porte un mot
 * interdit est refusé), sa date, son numéro. Pure, testée.
 */
function commandesDeLaPage(vue) {
  return (vue?.blocs || []).map((bloc) => {
    const lus = (bloc.liens || []).map((h) => lienDeFacture(h, vue.url)).filter(Boolean);
    const facture = lus.find((l) => !l.refus) || null;
    return {
      facture,
      refus: !facture && lus.some((l) => l.refus) ? lus.find((l) => l.refus).refus : null,
      issuedOn: pageDocs.dateDepuisTexte(bloc.texteTete),
      reference: referenceSure(bloc.numero),
    };
  });
}

/** Le grief d'un refus pour le journal : espaces réduits, borné (chiffres gardés, ce sont des tailles). */
function grief(lu) {
  return String(lu?.grief || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * R2 — la PREMIÈRE facture décide de la forme d'adresse. L'adresse telle que
 * la page la donne d'abord ; si ce n'est pas un PDF, sa forme corrigée ; la
 * forme qui sert un PDF est retenue pour tout le passage, et dite une fois.
 *
 * @returns {Promise<{forme: string, lu: object}|{forme: null, raison: string}>}
 */
async function deciderLaForme(page, doc, log) {
  const donnee = verifierAdresse(doc.telleQuelle, doc.idOrder);
  if (!donnee.ok) return { forme: null, raison: `l'adresse donnée par la page n'a pas été demandée (${donnee.raison})` };
  const premier = await ongletPdf.fluxDeLaPage(page, doc.telleQuelle);
  if (premier.ok) {
    log(`${ID} : adresse des factures — la forme donnée par la page sert le PDF : retenue pour ce passage.`);
    return { forme: FORME_DONNEE, lu: premier };
  }
  if (doc.corrigee === doc.telleQuelle) {
    return { forme: null, raison: `l'adresse donnée par la page, bien formée, ${grief(premier)}` };
  }
  log(`${ID} : adresse des factures — la forme donnée par la page n'a pas servi de PDF (le document ${grief(premier)}) ; `
    + 'essai de sa forme corrigée (« &id_order= »), une simple lecture.');
  const corrigee = verifierAdresse(doc.corrigee, doc.idOrder);
  if (!corrigee.ok) return { forme: null, raison: `la forme corrigée n'a pas été demandée (${corrigee.raison})` };
  const second = await ongletPdf.fluxDeLaPage(page, doc.corrigee);
  if (second.ok) {
    log(`${ID} : adresse des factures — la forme corrigée (« &id_order= ») sert le PDF : retenue pour ce passage.`);
    return { forme: FORME_CORRIGEE, lu: second };
  }
  return {
    forme: null,
    raison: `la forme donnée par la page ${grief(premier)} ; la forme corrigée ${grief(second)}`,
  };
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
      message: `Connexion valide — ${pluriel(vue.blocs.length, 'commande visible', 'commandes visibles')} `
        + `dans votre historique ${NOM}. Leurs factures seront prises à la prochaine récupération.`,
    };
  });
}

/**
 * Les factures des commandes : LIRE la liste, puis PRENDRE chaque PDF manquant
 * dans l'onglet, à la forme d'adresse décidée par la première facture. Ce qui
 * est pris est GARDÉ quoi qu'il arrive ensuite.
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
      forme: null,
      bloque: false,
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
      aPrendre.push({
        remoteId,
        idOrder: c.facture.idOrder,
        telleQuelle: c.facture.telleQuelle,
        corrigee: c.facture.corrigee,
        issuedOn: c.issuedOn,
        reference: c.reference,
      });
    }
    const malFormees = aPrendre.filter((d) => d.telleQuelle !== d.corrigee).length;
    log(`${ID} : ${bilan.commandes} commande(s) lue(s) — ${bilan.commandes - bilan.sansFacture - bilan.ecartes} `
      + `avec un lien de facture, ${bilan.sansFacture} sans facture, ${bilan.deja} déjà dans l'archive, `
      + `${aPrendre.length} à prendre (dont ${malFormees} à l'adresse mal formée), ${bilan.horsPeriode} hors période.`);

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
      if (!bilan.forme) {
        const decision = await deciderLaForme(page, doc, log);
        if (decision.forme) {
          bilan.forme = decision.forme;
          serie.reussite();
          invoices.push({ ...doc, buffer: decision.lu.buffer });
          continue;
        }
        // Aucune forme ne sert de PDF. Une session tombée rendrait les deux
        // refus pareils : on le vérifie par la page, une fois, avant de
        // conclure que la boutique ne sert pas ses factures.
        if (await sessionTombee(page)) {
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
        }
        manquees++;
        bilan.bloque = true;
        log(`${ID} : aucune forme de l'adresse ne sert de PDF — ${decision.raison}. Arrêt pour cette boutique : `
          + 'aucune autre facture n\'est demandée.');
        break;
      }
      const adresse = bilan.forme === FORME_CORRIGEE ? doc.corrigee : doc.telleQuelle;
      const controle = verifierAdresse(adresse, doc.idOrder);
      if (!controle.ok) {
        manquees++;
        log(`${ID} : une facture n'a pas été demandée — ${controle.raison}.`);
        continue;
      }
      const lu = await ongletPdf.fluxDeLaPage(page, adresse);
      if (lu.ok) {
        serie.reussite();
        invoices.push({ ...doc, buffer: lu.buffer });
        continue;
      }
      manquees++;
      log(`${ID} : une facture n'a pas pu être prise : le document ${grief(lu)}.`);
      if (await sessionTombee(page)) {
        manquees--;
        tentees--;
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
    // Un arrêt sur un refus (aucune forme, sortie anticipée, session tombée)
    // laisse des factures qui n'ont plus été demandées : elles comptent comme
    // non obtenues, pour que l'écran dise combien étaient proposées (lot 95).
    const nonDemandees = bilan.bloque || renoncement || bilan.interruption === 'session' ? bilan.restantes : 0;
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
        complete: !bilan.interruption && !renoncement && !bilan.bloque && !nonObtenues,
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
      + `${bilan.restantes} en attente, forme d'adresse ${bilan.forme === FORME_CORRIGEE ? 'corrigée' : bilan.forme === FORME_DONNEE ? 'donnée par la page' : 'non décidée'}`
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
  FORME_DONNEE,
  FORME_CORRIGEE,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  ouverture,
};
