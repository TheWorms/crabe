'use strict';

/**
 * Connecteur Sofidial — la boutique de personnalisation textile
 * (`personnalisation-textile-en-ligne.sofidial.fr`), 1.0.3.
 *
 * ─── D'où il vient ──────────────────────────────────────────────────────────
 *
 * Écrit sur le relevé « Proposer un service » du 24/11/2026, fait sur un compte
 * réel (sept pages, trois factures ouvertes). Une application Rails :
 *
 *   - la connexion est le formulaire Devise `/users/sign_in` (adresse
 *     e-mail, mot de passe, « Se souvenir de moi ») ; la fenêtre de crabe
 *     l'ouvre, la personne s'y connecte elle-même ;
 *   - `/orders` liste les commandes, une carte `div#order_<n>` chacune, son
 *     lien `/orders/<id>` titré « WEB-<n> » ; la page porte le bouton
 *     « Déconnexion » (`form.button_to`, `/users/sign_out`) ;
 *   - chaque commande s'ouvre sur `/orders/<id>`, où la facture est un lien
 *     « FACTURE F<n> » vers `/rails/active_storage/blobs/redirect/…`, qui
 *     RENVOIE vers une adresse pré-signée d'Amazon S3 — le PDF, servi
 *     `application/pdf`, « SOFIDIAL - F<n>.pdf ».
 *
 * Le relevé ne dit ni la forme des dates ni celle des montants (ils sont
 * masqués) : la date d'une facture est lue dans la carte de sa commande,
 * puis dans sa page ; illisible, la facture est rangée sans date.
 *
 * ─── Ce que le connecteur ne fait jamais ────────────────────────────────────
 *
 * Il ne clique rien et ne soumet rien : il lit des pages et télécharge des
 * liens. Toute adresse qui sent l'action (déconnexion, panier, profil,
 * adresses, mot de passe, paiement) est refusée AVANT d'être demandée, et la
 * requête est avortée si une page la déclenche.
 *
 * ─── L'ancre d'idempotence ──────────────────────────────────────────────────
 *
 * `sofidial-<référence de commande>-facture-<numéro>` : le numéro de
 * facture lu dans le lien, la commande pour savoir, sans rouvrir sa page,
 * qu'elle a déjà donné sa facture. Une commande sans facture encore est
 * rouverte au passage suivant.
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

const ID = 'sofidial';
const NOM = 'Sofidial';

const HOTE = 'personnalisation-textile-en-ligne.sofidial.fr';
const URL_LISTE = `https://${HOTE}/orders`;

const CHAMP_SESSION = 'session';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attendre que la page se pose — borné, un site bavard ne doit pas tout coûter. */
const DELAI_REPOS_MS = 15_000;
/** Le PDF, via son renvoi vers S3. */
const DELAI_TELECHARGEMENT_MS = 60_000;
/** Pages de la liste des commandes suivies au plus (« suivante »). */
const PAGES_LISTE_MAX = 20;

/** La limite d'une exécution, telle que l'ordonnanceur l'applique. */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
/** La part de cette limite que le connecteur s'accorde. */
const PART_DU_TEMPS = 2 / 3;

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

/**
 * Ce qu'aucune adresse demandée ne doit porter : la déconnexion (Devise
 * `sign_out`), le panier et la commande, le profil, les adresses, le mot de
 * passe, le paiement. Comparé en minuscules, adresse brute et décodée.
 */
const MOTS_INTERDITS = Object.freeze([
  'sign_out', 'signout', 'logout', 'deconnexion',
  'profile', 'addresses', 'password',
  'cart', 'panier', 'checkout', 'payment', 'paiement',
  'cancel', 'destroy', 'reorder', 'duplicate',
]);

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
    if (formes.some((f) => f.includes(mot))) return mot;
  }
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

/** Une adresse de la boutique, en https, ou `null`. Pure. */
function adresseDeLaBoutique(href, base = URL_LISTE) {
  let u;
  try {
    u = new URL(String(href ?? ''), base);
  } catch {
    return null;
  }
  return u.protocol === 'https:' && u.hostname === HOTE ? u : null;
}

/** La page d'une commande : `/orders/<id>`, et rien d'autre. Pure. */
function lienDeCommande(href, base = URL_LISTE) {
  const u = adresseDeLaBoutique(href, base);
  if (!u) return null;
  const m = /^\/orders\/([A-Za-z0-9_-]{1,64})\/?$/.exec(u.pathname);
  if (!m || motInterdit(u.href)) return null;
  return { adresse: `https://${HOTE}/orders/${m[1]}`, id: m[1] };
}

/** Une référence de commande dicible dans une ancre (« WEB-1234 »), ou `null`. Pure. */
function referenceSure(texte) {
  const ref = String(texte ?? '').replace(/\s+/g, '').trim();
  return /^[A-Za-z0-9-]{1,30}$/.test(ref) ? ref.toUpperCase() : null;
}

/**
 * Le numéro d'une facture, lu dans le texte de son lien (« FACTURE F12345 »,
 * « Facture F-2026-0012 »), ou `null` : sans le mot « facture » en tête, ce
 * n'est pas une facture (un bon de livraison, un avoir). Pure.
 */
function numeroDeFacture(texte) {
  const m = /^\s*facture\s*(?:n[°o]\s*)?([A-Za-z]{0,4}[\s-]?\d[\d\s./-]{0,30})\s*$/i.exec(String(texte ?? '').slice(0, 120));
  if (!m) return null;
  const numero = m[1].replace(/\s+/g, '').replace(/[./]/g, '-').replace(/-{2,}/g, '-').replace(/-$/, '').toUpperCase();
  return /^[A-Z0-9-]{1,30}$/.test(numero) ? numero : null;
}

/**
 * Le lien d'une facture : sur la boutique, vers le stockage de Rails
 * (`/rails/active_storage/blobs/…`), titré « FACTURE … ». Rend `{ adresse,
 * numero }`, `{ refus }` pour un lien qui porte un mot interdit, ou `null`. Pure.
 */
function lienDeFacture(href, texte, base = URL_LISTE) {
  const u = adresseDeLaBoutique(href, base);
  if (!u || !/^\/rails\/active_storage\/blobs\/(?:redirect\/|proxy\/)?[^/]+\/[^/]+/.test(u.pathname)) return null;
  const numero = numeroDeFacture(texte);
  if (!numero) return null;
  const mot = motInterdit(u.pathname);
  if (mot) return { refus: mot };
  return { adresse: u.href, numero };
}

/**
 * L'ancre d'une facture. Référence et numéro peuvent porter des tirets
 * (« WEB-1234 », « F-2026-0012 ») : « -facture- », en minuscules, les sépare
 * sans ambiguïté — les deux sont en majuscules. Pure.
 */
function remoteIdFacture(reference, numero) {
  return `${ID}-${reference}-facture-${numero}`;
}

/** Les références de commande qui ont déjà donné une facture, lues dans les ancres connues. Pure. */
function commandesConnues(knownRemoteIds) {
  const prefixe = `${ID}-`;
  const refs = new Set();
  for (const id of knownRemoteIds || []) {
    const s = String(id);
    if (!s.startsWith(prefixe)) continue;
    const m = /^([A-Z0-9-]{1,30})-facture-[A-Z0-9-]{1,30}$/.exec(s.slice(prefixe.length));
    if (m) refs.add(m[1]);
  }
  return refs;
}

/**
 * Où la navigation a mené. `liste` : la page des commandes, au compte
 * connecté (son bouton « Déconnexion », ou des commandes). Pure.
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
  if (/^\/users\/sign_in\b/.test(u.pathname) || vue?.motDePasse) {
    return { verdict: 'connexion-demandee', raison: `renvoyé vers ${masquer(u.pathname)}, la page de connexion` };
  }
  if (/^\/orders\/?$/.test(u.pathname) && (vue?.deconnexion || (vue?.commandes || []).length)) {
    return { verdict: 'liste', raison: 'page des commandes, au compte connecté (bouton « Déconnexion »)' };
  }
  return { verdict: 'page-illisible', raison: `arrivé sur ${masquer(u.pathname)}, qui n'est pas la page des commandes` };
}

/** Les commandes d'une page de liste, dédoublonnées. Pure. */
function commandesDeLaPage(vue) {
  const vues = new Set();
  const commandes = [];
  for (const carte of vue?.commandes || []) {
    const lien = lienDeCommande(carte.href, vue.url);
    if (!lien || vues.has(lien.adresse)) continue;
    vues.add(lien.adresse);
    commandes.push({
      adresse: lien.adresse,
      reference: referenceSure(carte.reference),
      issuedOn: pageDocs.dateDepuisTexte(carte.texte),
    });
  }
  return commandes;
}

/** Les factures d'une page de commande, dédoublonnées par numéro. Pure. */
function facturesDeLaCommande(vue) {
  const parNumero = new Map();
  let refus = null;
  for (const lien of vue?.liens || []) {
    const f = lienDeFacture(lien.href, lien.texte, vue.url);
    if (!f) continue;
    if (f.refus) {
      refus = f.refus;
      continue;
    }
    if (!parNumero.has(f.numero)) parNumero.set(f.numero, f);
  }
  return { factures: [...parNumero.values()], refus };
}

/** Des noms de fichiers distincts, dans l'ordre. */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-${d.numero}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/** La phrase du passage, pour l'écran. */
function precisionDuPassage(b, { sansTiret = false } = {}) {
  const phrases = [`${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.commandes, 'commande lue', 'commandes lues')}`
    + (b.connues ? `, ${pluriel(b.connues, 'déjà dans vos documents', 'déjà dans vos documents')}` : '')
    + (b.sansFacture ? `, ${pluriel(b.sansFacture, 'commande sans facture pour l\'instant', 'commandes sans facture pour l\'instant')}` : '')
    + '.'];
  if (b.sansReference) {
    phrases.push(`${b.sansReference > 1 ? `${b.sansReference} commandes n'ont pas été lues : elles n'affichent` : 'Une commande n\'a pas été lue : elle n\'affiche'} `
      + 'pas de référence lisible.');
  }
  if (b.interruption === 'temps') {
    phrases.push('La récupération a pris tout le temps permis : les commandes restantes viendront au prochain passage. '
      + 'Rien de ce qui a été pris n\'est perdu.');
  }
  if (b.interruption === 'session') {
    phrases.push(`La lecture s'est interrompue — ${NOM} a demandé de vous reconnecter : les factures déjà prises sont gardées. `
      + 'Reconnectez-vous depuis la fiche du service pour récupérer la suite.');
  }
  return phrases.join(' ');
}

// ---------------------------------------------------------------------------
// Ce qui tourne DANS la page
// ---------------------------------------------------------------------------

/** La page des commandes : ses cartes, son bouton « Déconnexion », sa page suivante. */
const LIRE_LA_LISTE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  // Le texte nœud par nœud, séparé par des espaces : d'un seul tenant, deux
  // paragraphes se collent (« 03/11/2026 » puis « 0,00 € » donnaient
  // « 03/11/20260,00 € », une date illisible — mesuré à l'essai).
  const texteDe = (el) => {
    const marcheur = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const morceaux = [];
    while (marcheur.nextNode() && morceaux.length < 200) morceaux.push(marcheur.currentNode.nodeValue);
    return norm(morceaux.join(' '));
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const cartes = [...document.querySelectorAll('[id^="order_"]')]
    .filter((c) => /^order_\d+$/.test(c.id) && !c.closest('turbo-frame[id^="order_item_"]'));
  const suivante = document.querySelector('a[rel="next"]');
  return {
    url: location.href,
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    deconnexion: [...document.querySelectorAll('form')].some((f) => /\/users\/sign_out\b/.test(f.getAttribute('action') || '')),
    commandes: cartes.map((c) => {
      const a = c.querySelector('a[href*="/orders/"]');
      return { href: a ? a.getAttribute('href') : '', reference: a ? norm(a.textContent) : '', texte: texteDe(c).slice(0, 400) };
    }),
    suivante: suivante ? suivante.getAttribute('href') : '',
  };
};

/** La page d'une commande : ses liens vers le stockage, et son texte (pour la date). */
const LIRE_LA_COMMANDE = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const texteDe = (el) => {
    if (!el) return '';
    const marcheur = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const morceaux = [];
    while (marcheur.nextNode() && morceaux.length < 400) morceaux.push(marcheur.currentNode.nodeValue);
    return norm(morceaux.join(' '));
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  return {
    url: location.href,
    motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    liens: [...document.querySelectorAll('a[href*="/rails/active_storage/"]')]
      .slice(0, 40)
      .map((a) => ({ href: a.getAttribute('href'), texte: norm(a.textContent).slice(0, 120) })),
    texte: texteDe(document.querySelector('main') || document.body).slice(0, 2000),
  };
};

// ---------------------------------------------------------------------------
// Le navigateur
// ---------------------------------------------------------------------------

/** La seule navigation : une adresse sans mot interdit, puis l'attente — bornée. */
async function naviguer(page, adresse) {
  const mot = motInterdit(adresse);
  if (mot) throw new Error(`${ID} : adresse refusée avant toute navigation (mot interdit « ${mot} »).`);
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/**
 * Ce qui ouvre le navigateur, télécharge une facture et lit l'heure :
 * remplaçable par les essais (le faux navigateur ne sert pas `context.request`).
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  telecharger: (context, adresse, _page) => telechargerFacture(context, adresse),
  maintenant: () => Date.now(),
};

/** Ouvre la session enregistrée, appelle `fn(page, context)`, referme toujours. */
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

/** Lit la liste affichée ; ne lève jamais. */
async function lireLaListe(page) {
  const vue = await page.evaluate(LIRE_LA_LISTE).catch(() => null)
    || { url: page.url(), motDePasse: false, deconnexion: false, commandes: [], suivante: '' };
  vue.mur = await profilMarchand.estMurAntiRobot(page);
  return vue;
}

/** Arrive sur la liste, ou dit pourquoi pas. */
async function arriverSurLaListe(page, log, adresse = URL_LISTE) {
  await naviguer(page, adresse);
  const vue = await lireLaListe(page);
  const jugement = jugerArrivee(vue);
  log(`${ID} : arrivée jugée « ${jugement.verdict} » — ${jugement.raison}.`);
  if (jugement.verdict === 'connexion-demandee') {
    throw profilMarchand.erreurRenvoiVersAuthentification(NOM, jugement.raison);
  }
  if (jugement.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (jugement.verdict !== 'liste') throw erreurPageIllisible(jugement.raison);
  return vue;
}

/** Toutes les commandes, page après page (« suivante »), dans la limite. */
async function toutesLesCommandes(page, log) {
  let vue = await arriverSurLaListe(page, log);
  const commandes = commandesDeLaPage(vue);
  const vues = new Set([URL_LISTE]);
  for (let n = 1; n < PAGES_LISTE_MAX && vue.suivante; n++) {
    const suivante = adresseDeLaBoutique(vue.suivante, vue.url);
    if (!suivante || !/^\/orders\/?$/.test(suivante.pathname) || vues.has(suivante.href) || motInterdit(suivante.href)) break;
    vues.add(suivante.href);
    vue = await arriverSurLaListe(page, log, suivante.href);
    for (const c of commandesDeLaPage(vue)) {
      if (!commandes.some((x) => x.adresse === c.adresse)) commandes.push(c);
    }
  }
  return commandes;
}

/** La session est-elle tombée ? Se vérifie par la page de la liste, une fois. */
async function sessionTombee(page) {
  await naviguer(page, URL_LISTE);
  return jugerArrivee(await lireLaListe(page)).verdict === 'connexion-demandee';
}

/**
 * Télécharge une facture par le contexte : son lien renvoie vers une adresse
 * pré-signée d'Amazon S3, que le `fetch` de la page ne pourrait pas lire
 * (une autre origine, sans autorisation CORS). Rend `{ ok, buffer }`, ou
 * `{ ok: false, grief, session }` — `session` quand le renvoi mène à la
 * page de connexion.
 */
async function telechargerFacture(context, adresse) {
  let reponse;
  try {
    reponse = await context.request.get(adresse, { timeout: DELAI_TELECHARGEMENT_MS, maxRedirects: 5 });
  } catch (err) {
    return { ok: false, grief: `n'a pas abouti (${String(err?.message || err).split('\n')[0].slice(0, 80)})` };
  }
  let finale = null;
  try {
    finale = new URL(reponse.url());
  } catch {
    finale = null;
  }
  if (finale && finale.hostname === HOTE && /^\/users\/sign_in\b/.test(finale.pathname)) {
    return { ok: false, grief: 'a renvoyé vers la page de connexion', session: true };
  }
  if (!reponse.ok()) return { ok: false, grief: `a rendu HTTP ${reponse.status()}`, session: reponse.status() === 401 };
  let octets;
  try {
    octets = await reponse.body();
  } catch (err) {
    return { ok: false, grief: `n'a pas pu se lire (${String(err?.message || err).slice(0, 80)})` };
  }
  return ongletPdf.jugerLesOctets(octets, { type: reponse.headers()['content-type'], redirige: !!finale && finale.hostname !== HOTE, adresse });
}

/**
 * La fenêtre d'historique : « depuis » reprend tout ce qui n'est pas encore
 * dans l'archive (une commande déjà prise n'est même pas rouverte).
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
// L'interface du connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la liste s'ouvre au compte connecté. */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    const vue = await arriverSurLaListe(page, log);
    const n = commandesDeLaPage(vue).length;
    return {
      ok: true,
      accountId: null,
      message: `Connexion valide — ${pluriel(n, 'commande visible', 'commandes visibles')} dans votre espace ${NOM}. `
        + 'Leurs factures seront prises à la prochaine récupération.',
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connues = commandesConnues(ctx.knownRemoteIds);
  const connusIds = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const commandes = await toutesLesCommandes(page, log);
    const bilan = {
      commandes: commandes.length,
      connues: 0,
      sansFacture: 0,
      sansReference: 0,
      horsPeriode: 0,
      ecartes: 0,
      interruption: null,
    };

    const aOuvrir = [];
    for (const c of commandes) {
      if (!c.reference) {
        bilan.sansReference++;
        continue;
      }
      if (connues.has(c.reference)) {
        bilan.connues++;
        continue;
      }
      if (!scraping.dansLaFenetre(c.issuedOn, plan)) {
        bilan.horsPeriode++;
        continue;
      }
      aOuvrir.push(c);
    }
    log(`${ID} : ${bilan.commandes} commande(s) lue(s) — ${bilan.connues} déjà dans l'archive, `
      + `${bilan.sansReference} sans référence lisible, ${bilan.horsPeriode} hors période, ${aOuvrir.length} à ouvrir.`);

    ctx.preuveDeListe?.({
      session: `page des commandes ${NOM} servie au compte connecté (bouton « Déconnexion »)`,
      liste: URL_LISTE,
      elements: bilan.commandes,
    });

    const invoices = [];
    let manquees = 0;
    let renoncement = null;
    let ouvertes = 0;
    const serie = serieEchecs.suiteDEchecs();
    for (const commande of aOuvrir) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      ouvertes++;
      await naviguer(page, commande.adresse);
      const vue = await page.evaluate(LIRE_LA_COMMANDE).catch(() => null)
        || { url: page.url(), motDePasse: false, liens: [], texte: '' };
      if (jugerArrivee({ url: vue.url, motDePasse: vue.motDePasse }).verdict === 'connexion-demandee') {
        if (!invoices.length) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en ouvrant une commande');
        bilan.interruption = 'session';
        break;
      }
      const { factures, refus } = facturesDeLaCommande(vue);
      if (refus) {
        bilan.ecartes++;
        log(`${ID} : un lien de facture a été écarté sans être suivi — il porte le mot interdit « ${refus} ».`);
      }
      if (!factures.length) {
        bilan.sansFacture++;
        continue;
      }
      const issuedOn = commande.issuedOn || pageDocs.dateDepuisTexte(vue.texte);
      for (const facture of factures) {
        const remoteId = remoteIdFacture(commande.reference, facture.numero);
        if (connusIds.has(remoteId) || invoices.some((f) => f.remoteId === remoteId)) continue;
        const lu = await ouverture.telecharger(context, facture.adresse, page);
        if (lu.ok) {
          serie.reussite();
          invoices.push({ remoteId, numero: facture.numero, issuedOn, buffer: lu.buffer });
          continue;
        }
        manquees++;
        log(`${ID} : une facture n'a pas pu être prise : le document ${String(lu.grief || '').replace(/\s+/g, ' ').slice(0, 300)}.`);
        if (lu.session || await sessionTombee(page)) {
          manquees--;
          if (!invoices.length) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
          bilan.interruption = 'session';
          break;
        }
        if (serie.echec(lu.grief)) {
          renoncement = serie.phrasePublique();
          log(`${ID} : ${serie.raison()}`);
          break;
        }
      }
      if (bilan.interruption || renoncement) break;
    }

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((f, i) => ({ remoteId: f.remoteId, filename: noms[i], issuedOn: f.issuedOn, buffer: f.buffer })),
      couverture: {
        complete: !bilan.interruption && !renoncement && !manquees,
        detail: `la page des commandes ${NOM}, ${pluriel(bilan.commandes, 'commande', 'commandes')}`,
      },
    };
    // Après un renoncement ou une session tombée, les commandes qui n'ont pas
    // été ouvertes comptent comme non obtenues : leur facture n'est pas venue.
    const nonOuvertes = renoncement || bilan.interruption === 'session' ? aOuvrir.length - ouvertes : 0;
    if (manquees + nonOuvertes) {
      sortie.manquees = manquees + nonOuvertes;
      if (renoncement) sortie.renoncement = renoncement;
    }
    if (!bilan.commandes) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : aucune commande pour l'instant.`;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aOuvrir.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'commande', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, { sansTiret: !!sortie.manquees || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.commandes} commande(s), ${invoices.length} facture(s) prise(s), ${manquees} manquée(s), `
      + `${bilan.connues} déjà dans l'archive, ${bilan.sansFacture} sans facture, ${bilan.horsPeriode} hors période`
      + `${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}.`);

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
  lireSession,
  motInterdit,
  lienDeCommande,
  lienDeFacture,
  numeroDeFacture,
  referenceSure,
  remoteIdFacture,
  commandesConnues,
  jugerArrivee,
  commandesDeLaPage,
  facturesDeLaCommande,
  telechargerFacture,
  nommer,
  masquer,
  precisionDuPassage,
  fenetre,
  budgetMs,
  LIRE_LA_LISTE,
  LIRE_LA_COMMANDE,
  MOTS_INTERDITS,
  URL_LISTE,
  HOTE,
  ouverture,
};
