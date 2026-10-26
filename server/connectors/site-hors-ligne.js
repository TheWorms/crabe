'use strict';

/**
 * Site hors ligne — dire « le site ne répond pas » au lieu d'un faux échec.
 *
 * ─── Ce que ce module corrige (lot 110) ──────────────────────────────────────
 *
 * Le 17/10/2026, Matériel.net était réellement hors ligne : son nom ne se
 * résolvait plus. Le journal disait tout :
 *
 *     page.goto: net::ERR_NAME_NOT_RESOLVED at https://secure.materiel.net/Orders
 *
 * et l'écran affichait « Le site n'a pas présenté l'écran attendu : quelque
 * chose que crabe cherchait n'est jamais apparu », en rouge, comme une panne
 * du connecteur. Quatre fois, une récupération et trois essais. Ni le message
 * ni la couleur n'étaient vrais : personne n'avait rien à corriger, il fallait
 * seulement attendre que le site revienne.
 *
 * ─── La règle, une seule, pour tous les connecteurs ──────────────────────────
 *
 * Un passage (une récupération, un essai de connexion) est « hors ligne »
 * quand, à la fois :
 *
 *   1. une erreur RÉSEAU de la liste fermée (`CODES_NAVIGATEUR`, `CODES_NODE`)
 *      a été vue — dans l'erreur qui a arrêté le passage, ou sur le réseau du
 *      navigateur ou de `fetch` pendant le passage ;
 *   2. elle visait le DOMAINE DU CONNECTEUR (`domainesDe` : le site, l'adresse
 *      de connexion et la page de contrôle du manifeste) — une régie de
 *      publicité injoignable ne dit rien du site ;
 *   3. le site n'a RIEN répondu pendant tout le passage — aucune réponse HTTP
 *      de son domaine. C'est ce qui réserve la règle à la PREMIÈRE navigation
 *      ou requête, avant toute connexion : un site qui a servi sa page de
 *      connexion, puis coupe, a répondu ; ce n'est pas « hors ligne ».
 *
 * Une erreur de certificat (`ERR_CERT_…`), un 403, un 5xx, un écran absent
 * après chargement ne sont JAMAIS « hors ligne » : dans les trois derniers cas
 * le site a répondu, et le premier n'est pas dans la liste. Une session
 * expirée (`sessionExpired`) ou la limite de durée (`dureeDepassee`) non plus.
 *
 * ─── Pourquoi observer le réseau, et pas seulement lire l'erreur ─────────────
 *
 * Le texte d'erreur ne suffit pas : `profil-marchand.atteindreLaPage` avale
 * l'échec de `page.goto` pour ses sept enseignes, plusieurs connecteurs
 * enveloppent l'erreur dans une phrase à eux, et une erreur de `fetch` ne dit
 * que « fetch failed ». Le socle suit donc chaque passage
 * (`AsyncLocalStorage`) et s'accroche UNE fois à Playwright et à `fetch`
 * (`brancher`) : les réponses et les échecs réseau vers le domaine du
 * connecteur sont comptés, quel que soit le connecteur, sans qu'aucun soit
 * retouché. Hors d'un passage, les accroches ne font rien.
 *
 * Rien n'est retenu d'une adresse que son hôte : ni chemin, ni requête.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

/** La cause rangée dans `run_logs.cause` (la même que `cause-echec.HORS_LIGNE`). */
const HORS_LIGNE = 'hors-ligne';

/** Les erreurs du navigateur qui disent « le site n'a pas pu être joint ». */
const CODES_NAVIGATEUR = Object.freeze([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_INTERNET_DISCONNECTED',
]);

/** Les mêmes, côté Node (`fetch`, requêtes de Playwright hors navigateur). */
const CODES_NODE = Object.freeze(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

/** Celle-là ne dit rien du site : c'est crabe qui n'a plus internet. */
const INTERNET_COUPE = 'ERR_INTERNET_DISCONNECTED';

const MOTIF_NAVIGATEUR = new RegExp(`net::(${CODES_NAVIGATEUR.join('|')})(?![A-Z_])(?:\\s+at\\s+(\\S+))?`);
const MOTIF_NODE = new RegExp(`\\b(${CODES_NODE.join('|')})\\b`);
/** « getaddrinfo ENOTFOUND www.exemple.fr » : le seul message Node qui nomme l'hôte. */
const MOTIF_GETADDRINFO = /getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\s+([^\s,;:'"()]+)/;

/** Au-delà, les échecs d'un passage ne sont plus notés : le premier suffit. */
const ECHECS_GARDES = 20;

// ---------------------------------------------------------------------------
// Hôtes et domaines
// ---------------------------------------------------------------------------

/** L'hôte d'une adresse (ou d'un hôte nu), en minuscules — null si illisible. */
function hoteDe(adresse) {
  const texte = String(adresse ?? '').trim().replace(/[.,;:!)\]"'»]+$/, '');
  if (!texte) return null;
  try {
    return new URL(texte).hostname.toLowerCase() || null;
  } catch {
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(texte) ? texte.toLowerCase() : null;
  }
}

/**
 * Les suffixes publics à deux étiquettes rencontrés sur des services
 * français : `impots.gouv.fr` a pour domaine `impots.gouv.fr`, pas `gouv.fr`.
 */
const SUFFIXES_DOUBLES = new Set(['gouv.fr', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'asso.fr']);

/** Le domaine qui couvre un hôte : `secure.materiel.net` → `materiel.net`. */
function domaineRacine(hote) {
  const h = String(hote || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^\d+(\.\d+){3}$/.test(h)) return h;
  const etiquettes = h.split('.');
  if (etiquettes.length <= 2) return h;
  const deux = etiquettes.slice(-2).join('.');
  return SUFFIXES_DOUBLES.has(deux) ? etiquettes.slice(-3).join('.') : deux;
}

/**
 * Les domaines d'un connecteur, d'après son manifeste : son site, l'adresse de
 * sa fenêtre de connexion et sa page de contrôle. Un manifeste sans aucune de
 * ces adresses n'a pas de domaine — et ne peut donc jamais être dit « hors
 * ligne » (dans le doute, l'échec reste un échec).
 */
function domainesDe(manifest) {
  const adresses = [manifest?.site, manifest?.remoteLogin?.url, manifest?.remoteLogin?.verifyUrl];
  const domaines = new Set();
  for (const adresse of adresses) {
    const hote = hoteDe(adresse);
    if (hote) domaines.add(domaineRacine(hote));
  }
  return [...domaines];
}

/** Cet hôte est-il sur l'un des domaines ? `secure.materiel.net` est sur `materiel.net`. */
function surLeDomaine(hote, domaines) {
  const h = String(hote || '').toLowerCase();
  if (!h) return false;
  return (domaines || []).some((d) => d && (h === d || h.endsWith(`.${d}`)));
}

// ---------------------------------------------------------------------------
// Lire une erreur
// ---------------------------------------------------------------------------

/** L'erreur, ses causes et ses erreurs agrégées — à profondeur bornée. */
function maillons(err, profondeur = 0, vus = new Set(), adresse = null) {
  if (!err || typeof err !== 'object' || vus.has(err) || profondeur > 4) return [];
  vus.add(err);
  const ici = typeof err.crabeAdresse === 'string' ? err.crabeAdresse : adresse;
  const sortie = [{ err, adresse: ici }];
  if (err.cause) sortie.push(...maillons(err.cause, profondeur + 1, vus, ici));
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) sortie.push(...maillons(e, profondeur + 1, vus, ici));
  }
  return sortie;
}

/**
 * Le code réseau porté par une erreur, et l'hôte qu'il visait — ou null.
 *
 * Lit le message, la précision interne (`interne`, `precision` : là où les
 * connecteurs rangent le détail technique) et le code de chaque maillon.
 * L'hôte vient de l'adresse citée par le navigateur (« … at https://hôte/ »),
 * de `hostname` (Node), du message `getaddrinfo`, ou de l'adresse notée par
 * l'accroche de `fetch` (`crabeAdresse`). Sans hôte, pas de verdict possible.
 *
 * @returns {{code: string, hote: string|null}|null}
 */
function lireErreurReseau(err) {
  if (err == null) return null;
  if (typeof err !== 'object') return lireTexte(String(err), null);
  for (const { err: maillon, adresse } of maillons(err)) {
    const textes = [maillon.message, maillon.interne, maillon.precision]
      .filter((t) => typeof t === 'string' && t);
    let lu = null;
    for (const texte of textes) {
      lu = lireTexte(texte, null);
      if (lu) break;
    }
    if (!lu && CODES_NODE.includes(maillon.code)) lu = { code: maillon.code, hote: null };
    // L'hôte : celui que dit le texte, sinon celui du maillon (Node), sinon
    // l'adresse notée par l'accroche de `fetch`.
    if (lu) return { code: lu.code, hote: lu.hote || hoteDe(maillon.hostname) || hoteDe(adresse) };
  }
  return null;
}

/** Un texte d'erreur : un code de la liste, et l'hôte s'il est dit. */
function lireTexte(texte, adresse) {
  const nav = MOTIF_NAVIGATEUR.exec(texte);
  if (nav) return { code: nav[1], hote: hoteDe(nav[2]) || hoteDe(adresse) };
  const node = MOTIF_NODE.exec(texte);
  if (node) {
    const hote = MOTIF_GETADDRINFO.exec(texte)?.[1];
    return { code: node[1], hote: hoteDe(hote) || hoteDe(adresse) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Le passage : ce que le réseau a vu
// ---------------------------------------------------------------------------

const suivi = new AsyncLocalStorage();

/**
 * Un passage neuf pour ce connecteur : rien vu, rien répondu. `parcours` et
 * `vues` (0.2.5) : les pages successives et ce qu'elles montraient à la
 * fermeture du navigateur (vue-de-page.js).
 */
function nouveauPassage(manifest) {
  return { domaines: domainesDe(manifest), reponses: 0, echecs: [], parcours: [], vues: [] };
}

/**
 * Exécute `fn` DANS le passage : tout ce qu'elle lance (navigateurs, `fetch`)
 * y est rattaché, même à travers les `await`.
 */
function suivre(passage, fn) {
  brancher();
  return suivi.run(passage, fn);
}

/** Le passage en cours, ou null hors de tout passage. */
function passageCourant() {
  return suivi.getStore() || null;
}

/** Une réponse HTTP est arrivée : si elle vient du site, le site a répondu. */
function noterReponse(passage, adresse) {
  if (!passage) return;
  if (surLeDomaine(hoteDe(adresse), passage.domaines)) passage.reponses += 1;
}

/** Une requête a échoué sur le réseau, avec un code de la liste. */
function noterEchec(passage, adresse, code) {
  if (!passage || !code || passage.echecs.length >= ECHECS_GARDES) return;
  if (!CODES_NAVIGATEUR.includes(code) && !CODES_NODE.includes(code)) return;
  passage.echecs.push({ code, hote: hoteDe(adresse) });
}

/**
 * LA règle. Rend `{code, hote, internetCoupe}` si le passage était hors
 * ligne, null sinon. `err` peut être null : un essai qui rend un échec sans
 * lever se juge sur ce que le réseau a vu.
 */
function classer(err, passage) {
  if (!passage) return null;
  if (err && typeof err === 'object' && (err.sessionExpired || err.dureeDepassee)) return null;
  // Le site a répondu, ne serait-ce qu'une fois : il n'était pas hors ligne.
  if (passage.reponses > 0) return null;
  const candidats = [err == null ? null : lireErreurReseau(err), ...passage.echecs];
  for (const c of candidats) {
    if (c && c.code && c.hote && surLeDomaine(c.hote, passage.domaines)) {
      return { code: c.code, hote: c.hote, internetCoupe: c.code === INTERNET_COUPE };
    }
  }
  return null;
}

/** Pose le verdict sur l'erreur (`err.horsLigne`), pour le planificateur. */
function marquer(err, passage) {
  if (!err || typeof err !== 'object') return null;
  const verdict = classer(err, passage);
  if (verdict) {
    try {
      err.horsLigne = verdict;
    } catch {
      /* erreur gelée : le verdict ne voyagera pas, l'échec reste un échec */
    }
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Les mots
// ---------------------------------------------------------------------------

/**
 * Le message de l'écran. Il nomme le service — il dit QUI ne répond pas, pas
 * ce que le service a mal fait (même choix que le message du mur anti-robot).
 */
function messageHorsLigne(nom, verdict = {}) {
  const fin = FIN_DU_MESSAGE;
  if (verdict?.internetCoupe) return `crabe n'a plus accès à internet. ${fin}`;
  return `${nom || 'Ce site'} est hors ligne ou injoignable pour le moment. ${fin}`;
}

/**
 * La fin du message (lot 111). Elle disait « rien à faire, crabe
 * réessaiera » : or le planificateur ne connaît que ses échéances, aucun
 * réessai n'existe. Elle dit désormais quand aura lieu le prochain essai.
 */
const FIN_DU_MESSAGE = 'Ce n\'est pas votre connexion : rien à faire de votre côté. crabe ne réessaie '
  + 'pas de lui-même : le prochain essai aura lieu à la prochaine récupération planifiée.';

/** La fin écrite par le lot 110 dans `run_logs`, telle quelle. */
const FIN_PROMETTANT_UN_REESSAI = 'Ce n\'est pas votre connexion : rien à faire, crabe réessaiera.';

/**
 * Un message déjà rangé, sans la promesse d'un réessai qui n'existe pas
 * (lot 111). Les lignes écrites par la 0.1.9 du lot 110 la portent ; elles ne
 * sont jamais réécrites — la phrase est remplacée là où elle est SERVIE à un
 * écran. Tout autre message passe tel quel. Pure.
 */
function sansReessaiPromis(message) {
  if (typeof message !== 'string' || !message.includes(FIN_PROMETTANT_UN_REESSAI)) return message;
  return message.split(FIN_PROMETTANT_UN_REESSAI).join(FIN_DU_MESSAGE);
}

/** La ligne du journal : le code et l'hôte, le détail sans adresse complète. */
function ligneDeJournal(verdict, brut = '') {
  const { masquerAdresses } = require('./releve-navigation');
  const detail = masquerAdresses(String(brut || '').split(/\r?\n/)[0]).slice(0, 200);
  return `site hors ligne — ${verdict.code} vers ${verdict.hote}, aucune réponse du site pendant ce passage`
    + (detail ? ` (détail technique : ${detail})` : '');
}

// ---------------------------------------------------------------------------
// Les accroches — Playwright et fetch, posées une fois
// ---------------------------------------------------------------------------

let branche = false;

/** Écoute un contexte de navigateur pour le compte d'un passage. */
function surveiller(contexte, passage) {
  if (!passage || !contexte?.on) return contexte;
  // 0.2.5 : le parcours et ce que montrait la page à l'arrêt (vue-de-page.js),
  // par la même accroche — aucun connecteur retouché.
  try {
    require('./vue-de-page').suivre(contexte, passage);
  } catch { /* une accroche ne doit jamais empêcher un navigateur de s'ouvrir */ }
  try {
    contexte.on('response', (reponse) => {
      try {
        noterReponse(passage, reponse.url());
      } catch {
        /* une réponse illisible ne compte pas */
      }
    });
    contexte.on('requestfailed', (requete) => {
      try {
        const code = /net::(ERR_[A-Z_]+)/.exec(requete.failure()?.errorText || '')?.[1];
        noterEchec(passage, requete.url(), code);
      } catch {
        /* un échec illisible ne compte pas */
      }
    });
  } catch {
    /* une accroche ne doit jamais empêcher un navigateur de s'ouvrir */
  }
  return contexte;
}

function accrocherNavigateur(navigateur) {
  if (!navigateur || navigateur.__crabeHorsLigne) return navigateur;
  try {
    Object.defineProperty(navigateur, '__crabeHorsLigne', { value: true });
  } catch {
    return navigateur;
  }
  try {
    require('./vue-de-page').suivreNavigateur(navigateur, passageCourant);
  } catch { /* la vue de la page est un plus, jamais une condition */ }
  if (typeof navigateur.newContext === 'function') {
    const creer = navigateur.newContext.bind(navigateur);
    navigateur.newContext = async (...options) => surveiller(await creer(...options), passageCourant());
  }
  if (typeof navigateur.newPage === 'function') {
    const ouvrir = navigateur.newPage.bind(navigateur);
    navigateur.newPage = async (...options) => {
      const page = await ouvrir(...options);
      surveiller(page?.context?.(), passageCourant());
      return page;
    };
  }
  return navigateur;
}

function brancherPlaywright(playwright) {
  const chromium = playwright?.chromium;
  if (!chromium || chromium.__crabeHorsLigne) return;
  try {
    Object.defineProperty(chromium, '__crabeHorsLigne', { value: true });
  } catch {
    return;
  }
  // 0.2.6 : l'ouverture se mesure ici — première étape du journal.
  const ouvrir = async (fonction, args, persiste) => {
    const debut = Date.now();
    const sortie = await fonction(...args);
    try {
      const passage = passageCourant();
      if (passage) require('./journal-de-passage').noterOuverture(passage, Date.now() - debut, persiste);
    } catch { /* le journal est un plus */ }
    return sortie;
  };
  const lancer = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => accrocherNavigateur(await ouvrir(lancer, args, false));
  const persistant = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (...args) => surveiller(await ouvrir(persistant, args, true), passageCourant());
}

function brancherFetch() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__crabeHorsLigne) return;
  const accroche = async function fetchSuivi(entree, init) {
    const passage = passageCourant();
    if (!passage) return original.call(this, entree, init);
    const adresse = typeof entree === 'string' ? entree : String(entree?.url ?? entree ?? '');
    try {
      const reponse = await original.call(this, entree, init);
      noterReponse(passage, adresse);
      return reponse;
    } catch (err) {
      const lu = lireErreurReseau(err);
      if (lu) noterEchec(passage, adresse, lu.code);
      try {
        if (err && typeof err === 'object' && !err.crabeAdresse) err.crabeAdresse = adresse;
      } catch {
        /* erreur gelée */
      }
      throw err;
    }
  };
  Object.defineProperty(accroche, '__crabeHorsLigne', { value: true });
  globalThis.fetch = accroche;
}

/** Pose les deux accroches, une fois. Sans Playwright, seule `fetch` est suivie. */
function brancher() {
  if (branche) return;
  branche = true;
  let playwright = null;
  try {
    playwright = require('playwright');
  } catch {
    playwright = null;
  }
  try {
    brancherPlaywright(playwright);
  } catch {
    /* Playwright d'une forme inattendue : les erreurs se lisent encore */
  }
  brancherFetch();
}

module.exports = {
  HORS_LIGNE,
  CODES_NAVIGATEUR,
  CODES_NODE,
  INTERNET_COUPE,
  hoteDe,
  domaineRacine,
  domainesDe,
  surLeDomaine,
  lireErreurReseau,
  nouveauPassage,
  suivre,
  passageCourant,
  noterReponse,
  noterEchec,
  classer,
  marquer,
  messageHorsLigne,
  sansReessaiPromis,
  FIN_DU_MESSAGE,
  ligneDeJournal,
  surveiller,
  brancher,
};
