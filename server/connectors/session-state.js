'use strict';

/**
 * État de session de navigateur — le « storageState » de Playwright.
 *
 * Certains portails n'acceptent pas qu'un robot se connecte : Free Mobile
 * exige un code SMS à chaque nouvelle session, Amazon un code de validation. Un
 * mot de passe ne suffit donc pas, et aucun connecteur ne peut ouvrir la
 * session tout seul. La seule solution honnête est de **rejouer une session
 * ouverte par l'utilisateur lui-même**, dans le navigateur distant de crabe.
 *
 * ⚠️ Les messages d'erreur de ce fichier arrivent tels quels sous les yeux de
 * l'utilisateur. Ils ne nomment donc ni fichier, ni commande, ni chemin : ils
 * disent ce qui ne va pas et ce qu'il faut faire — se reconnecter.
 *
 * Le fichier produit est un JSON de la forme :
 *
 *   {
 *     "cookies": [{ "name": "…", "value": "…", "domain": "…", "expires": 1789… }],
 *     "origins": [{ "origin": "https://…", "localStorage": [ … ] }]
 *   }
 *
 * ⚠️ Ce fichier VAUT les identifiants tant qu'il est valide : il est chiffré au
 * repos avec la passphrase maîtresse, exactement comme un mot de passe, et
 * n'est jamais réaffiché — seuls sa date d'enregistrement et son échéance le
 * sont (voir `summarize()`).
 *
 * `expires` est exprimé en **secondes** depuis l'époque Unix, et vaut `-1`
 * pour un cookie de session (effacé à la fermeture du navigateur). Un tel
 * cookie n'est pas « expiré » : il n'a simplement pas d'échéance.
 */

/** Secondes depuis l'époque, à l'instant présent. */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Un cookie porte-t-il une échéance exploitable ?
 * @param {*} cookie
 * @returns {number|null} l'échéance en secondes, ou null (cookie de session)
 */
function cookieExpiry(cookie) {
  const value = cookie?.expires;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Analyse un contenu fourni par l'utilisateur (fichier téléversé ou collé).
 *
 * @param {string|object} raw
 * @returns {{ok: boolean, state: object|null, error: string|null}}
 */
function parse(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
    return { ok: false, state: null, error: 'Aucune connexion enregistrée.' };
  }

  let state = raw;
  if (typeof raw === 'string') {
    try {
      state = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        state: null,
        error:
          'Cette connexion enregistrée n\'est pas lisible : le contenu n\'est pas du JSON '
          + `valide (${err.message}). Reconnectez-vous depuis la fiche du service.`,
      };
    }
  }

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {
      ok: false,
      state: null,
      error:
        'Cette connexion enregistrée n\'est pas lisible : le contenu doit être un objet '
        + 'JSON, pas une liste ni une valeur seule. Reconnectez-vous depuis la fiche du service.',
    };
  }

  return { ok: true, state, error: null };
}

/**
 * Contrôle complet d'un fichier de session : JSON bien formé, `cookies`
 * présent, et au moins un cookie encore valable.
 *
 * Un refus explique TOUJOURS quoi faire : une session est un objet opaque pour
 * l'utilisateur, un « format invalide » sec ne l'aiderait en rien.
 *
 * @param {string|object} raw
 * @param {{now?: number}} [options] instant de référence, en secondes (tests)
 * @returns {{ok: boolean, error: string|null, state: object|null, summary: object|null}}
 */
function validate(raw, { now = nowSeconds() } = {}) {
  const parsed = parse(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, state: null, summary: null };

  const { state } = parsed;

  if (!Array.isArray(state.cookies)) {
    return {
      ok: false,
      error:
        'Cette connexion enregistrée ne contient aucun cookie de navigateur : ce n\'est pas '
        + 'une connexion exploitable. Reconnectez-vous depuis la fiche du service.',
      state: null,
      summary: null,
    };
  }

  if (state.cookies.length === 0) {
    return {
      ok: false,
      error:
        'Cette connexion enregistrée est vide — elle s\'est probablement arrêtée avant la '
        + 'fin. Reconnectez-vous et allez au bout du parcours : mot de passe, puis code de '
        + 'validation.',
      state: null,
      summary: null,
    };
  }

  const usable = state.cookies.filter((c) => {
    if (!c || typeof c !== 'object' || !c.name) return false;
    const expiry = cookieExpiry(c);
    return expiry === null || expiry > now;
  });

  if (usable.length === 0) {
    const last = latestExpiry(state.cookies);
    return {
      ok: false,
      error:
        'Cette connexion a expiré'
        + (last ? ` (le ${formatDate(last)})` : '')
        + ' : elle ne peut plus servir. Reconnectez-vous depuis la fiche du service, en '
        + 'cochant « Se souvenir de cet appareil » si le site le propose.',
      state: null,
      summary: null,
    };
  }

  return { ok: true, error: null, state, summary: summarize(state, { now }) };
}

/** Échéance la plus lointaine parmi des cookies, en secondes, ou null. */
function latestExpiry(cookies) {
  let latest = null;
  for (const cookie of cookies || []) {
    const expiry = cookieExpiry(cookie);
    if (expiry !== null && (latest === null || expiry > latest)) latest = expiry;
  }
  return latest;
}

/** « 1789123456 » (secondes) → « 2026-09-14T…Z ». */
function toIso(seconds) {
  return seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();
}

/** Date lisible en français, pour les messages d'erreur. */
function formatDate(seconds) {
  const iso = toIso(seconds);
  if (!iso) return 'date inconnue';
  const [date] = iso.split('T');
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Résumé affichable d'une session — **jamais son contenu**.
 *
 * C'est tout ce que l'interface reçoit après enregistrement : « session
 * enregistrée le … valable jusqu'au … ». Les valeurs de cookies, elles, ne
 * ressortent jamais de la base.
 *
 * @param {object} state
 * @param {{savedAt?: string, now?: number}} [options]
 */
function summarize(state, { savedAt = null, now = nowSeconds() } = {}) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const expiry = latestExpiry(cookies);
  const domains = [...new Set(cookies.map((c) => c?.domain).filter(Boolean))];

  return {
    savedAt: savedAt || new Date().toISOString(),
    // Échéance du cookie le plus durable : c'est elle qui borne la durée de
    // vie utile de la session.
    expiresAt: toIso(expiry),
    expired: expiry !== null && expiry <= now && !cookies.some((c) => cookieExpiry(c) === null),
    cookieCount: cookies.length,
    originCount: Array.isArray(state?.origins) ? state.origins.length : 0,
    domains: domains.slice(0, 6),
  };
}

/**
 * Phrase affichée dans le formulaire à la place du contenu.
 * @param {{savedAt?: string, expiresAt?: string|null}} summary
 * @param {(iso: string) => string} [formatter] mise en forme des dates
 */
function describe(summary, formatter = null) {
  if (!summary) return 'Aucune session enregistrée.';
  const show = (iso) => (formatter ? formatter(iso) : String(iso || '').slice(0, 10));
  const saved = summary.savedAt ? `Session enregistrée le ${show(summary.savedAt)}` : 'Session enregistrée';
  if (!summary.expiresAt) return `${saved} — échéance inconnue (cookies de session seulement).`;
  return `${saved}, valable jusqu'au ${show(summary.expiresAt)}.`;
}

/**
 * La session est-elle arrivée à échéance ?
 * Utilisé avant de lancer un navigateur : inutile de payer 20 secondes de
 * scraping pour se faire rediriger vers la page de connexion.
 */
function isExpired(summary, { now = nowSeconds() } = {}) {
  if (!summary?.expiresAt) return false;
  return Date.parse(summary.expiresAt) / 1000 <= now;
}

// ---------------------------------------------------------------------------
// Ne garder que ce qui sert (lot 21)
// ---------------------------------------------------------------------------

/**
 * Un domaine appartient-il à l'un des services attendus ?
 *
 * Comparaison par SUFFIXE DE DOMAINE, jamais par « contient » : `google.com`
 * accepte `accounts.google.com` mais doit refuser `google.com.exemple.net`, qui
 * n'a de google que le début. Le point initial des cookies (`.mistral.ai`) est
 * retiré avant comparaison — c'est une notation, pas une différence.
 */
function domaineAutorise(domaine, suffixes) {
  const cible = String(domaine || '').trim().toLowerCase().replace(/^\./, '');
  if (!cible) return false;
  return suffixes.some((suffixe) => {
    const attendu = String(suffixe || '').trim().toLowerCase().replace(/^\./, '');
    return !!attendu && (cible === attendu || cible.endsWith(`.${attendu}`));
  });
}

/**
 * Une session RÉDUITE aux domaines du service.
 *
 * ─── Pourquoi ça existe (lot 21) ─────────────────────────────────────────────
 *
 * Jusqu'ici, toutes les connexions ouvertes à la main restaient chez le
 * fournisseur : on se connecte à Free Mobile sur le site de Free Mobile. Le lot
 * 21 amène les premiers services où la connexion passe par un TIERS — Mistral,
 * Anthropic et Envato acceptent « Se connecter avec Google », et les comptes
 * concernés n'ont pas d'autre voie.
 *
 * Or la photo prise en fin de parcours est celle du navigateur ENTIER. Elle
 * emporterait donc, en plus de la session du service, les cookies de connexion
 * Google — c'est-à-dire de quoi ouvrir une boîte de courriel, un espace de
 * fichiers, et tout ce qui pend au même compte. Chiffrés, certes, comme un mot
 * de passe. Mais crabe n'a aucun usage de ces cookies-là : il ne va jamais chez
 * Google, il va chercher une facture chez Mistral.
 *
 * Ce qui n'est pas conservé ne peut pas fuiter. Un connecteur déclare donc les
 * domaines dont il a besoin (`remoteLogin.keepDomains`), et le reste est jeté
 * AVANT le chiffrement, avant l'enregistrement, avant même l'essai de la
 * session — de sorte que ce qui est vérifié soit exactement ce qui est gardé.
 *
 * Sans déclaration, rien ne change : l'état est rendu tel quel. Aucun
 * connecteur écrit avant ce lot ne voit son comportement bouger.
 *
 * @param {object} state  l'état capturé
 * @param {string[]} suffixes domaines à conserver, ex. ['mistral.ai']
 * @returns {{state: object, retires: number, gardes: number}}
 */
function limiterAuxDomaines(state, suffixes) {
  const liste = (Array.isArray(suffixes) ? suffixes : []).filter((s) => String(s || '').trim());
  if (!liste.length || !state || typeof state !== 'object') {
    return { state, retires: 0, gardes: Array.isArray(state?.cookies) ? state.cookies.length : 0 };
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const gardes = cookies.filter((c) => domaineAutorise(c?.domain, liste));

  const origines = Array.isArray(state.origins) ? state.origins : [];
  const originesGardees = origines.filter((o) => {
    try {
      return domaineAutorise(new URL(String(o?.origin)).hostname, liste);
    } catch {
      // Une origine illisible ne peut pas être rattachée à un service : on ne
      // la garde pas. Le doute ne profite pas à ce qu'on stocke.
      return false;
    }
  });

  return {
    state: { ...state, cookies: gardes, origins: originesGardees },
    retires: cookies.length - gardes.length,
    gardes: gardes.length,
  };
}

// ---------------------------------------------------------------------------
// Le stockage de session d'un portail (lot 105)
// ---------------------------------------------------------------------------

/**
 * ─── Pourquoi (lot 105, R4) ──────────────────────────────────────────────────
 *
 * Un `storageState` de Playwright porte les cookies et le `localStorage` des
 * origines visitées — jamais le `sessionStorage`. Or le portail d'Alma garde
 * sa session LÀ (`sessionStorage["customer-portal-session"]`, jeton d'accès),
 * et la relit à chaque page : sans elle, il renvoie vers sa page de connexion
 * — mesuré dans le script public du portail, le 12/10/2026. La capture du
 * 12/10 (sept cookies, aucun ne portant la session) ne pouvait donc PAS être
 * rejouée, alors que la fenêtre, elle, montrait le compte.
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * Un connecteur DÉCLARE les origines dont la session vit dans ce stockage
 * (`remoteLogin.stockageDeSession`, seul Alma). Pour elles seules, la fenêtre
 * lit le stockage de session au moment de la capture et l'ajoute à l'état
 * enregistré, sous `stockageDeSession` — donc chiffré avec les cookies, par le
 * même chemin (`registry.saveConfig`). Le connecteur le restaure AVANT la
 * première navigation de son passage (`context.addInitScript`), et le relit en
 * fin de passage. Sans déclaration, rien n'est lu, l'état ne change pas d'un
 * octet. Le journal ne dit que des NOMBRES de clés — jamais un nom, jamais une
 * valeur.
 *
 * Forme : `stockageDeSession: [{ origine: "https://hôte", entrees: [{ name, value }] }]`.
 * Playwright ne connaît pas ce champ : `sansStockageDeSession` le retire avant
 * de lui confier l'état.
 */
const CLE_STOCKAGE_DE_SESSION = 'stockageDeSession';

/** Au plus tant de clés par origine, et tant de caractères par clé (nom et valeur). */
const STOCKAGE_MAX_CLES = 50;
const STOCKAGE_MAX_CARACTERES = 64 * 1024;

/** `https://hôte[:port]` seul — ni chemin, ni requête, ni fragment — ou `null`. Pure. */
function origineHttps(texte) {
  try {
    const u = new URL(String(texte ?? '').trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Les entrées utilisables d'une liste lue : chaînes, nom non vide, sans doublon, bornées. Pure. */
function entreesValides(entrees) {
  const vues = new Set();
  const sortie = [];
  for (const e of Array.isArray(entrees) ? entrees : []) {
    if (!e || typeof e.name !== 'string' || typeof e.value !== 'string' || !e.name) continue;
    if (vues.has(e.name) || e.name.length + e.value.length > STOCKAGE_MAX_CARACTERES) continue;
    vues.add(e.name);
    sortie.push({ name: e.name, value: e.value });
    if (sortie.length >= STOCKAGE_MAX_CLES) break;
  }
  return sortie;
}

/** Les blocs `{origine, entrees}` valides d'un état (liste vide si aucun). Pure. */
function blocsDeStockage(state) {
  const blocs = Array.isArray(state?.[CLE_STOCKAGE_DE_SESSION]) ? state[CLE_STOCKAGE_DE_SESSION] : [];
  return blocs
    .map((b) => ({ origine: origineHttps(b?.origine), entrees: entreesValides(b?.entrees) }))
    .filter((b) => b.origine);
}

/**
 * L'état, augmenté du stockage de session lu (`[{origine, entrees}]`). Les
 * origines lues remplacent celles déjà portées ; une origine illisible n'est
 * pas gardée. Pure — l'état reçu n'est pas modifié.
 */
function avecStockageDeSession(state, lus) {
  const neufs = blocsDeStockage({ [CLE_STOCKAGE_DE_SESSION]: lus });
  const remplacees = new Set(neufs.map((b) => b.origine));
  const gardes = blocsDeStockage(state).filter((b) => !remplacees.has(b.origine));
  return { ...state, [CLE_STOCKAGE_DE_SESSION]: [...gardes, ...neufs] };
}

/** Les entrées enregistrées pour `origine` — liste vide si aucune. Pure. */
function stockageDeSession(state, origine) {
  const cible = origineHttps(origine);
  return blocsDeStockage(state).find((b) => b.origine === cible)?.entrees || [];
}

/** L'état tel que Playwright le prend : sans le stockage de session, qu'il ne connaît pas. Pure. */
function sansStockageDeSession(state) {
  if (!state || typeof state !== 'object' || !(CLE_STOCKAGE_DE_SESSION in state)) return state;
  const { [CLE_STOCKAGE_DE_SESSION]: _retire, ...reste } = state;
  return reste;
}

/** Combien de clés de stockage de session un état porte, toutes origines. Pure. */
function nombreDeClesDeStockage(state) {
  return blocsDeStockage(state).reduce((n, b) => n + b.entrees.length, 0);
}

/**
 * Lu DANS une page (`page.evaluate`) : l'origine de la page et son stockage
 * de session. Ne lève pas : un stockage refusé rend une liste vide.
 */
const LIRE_STOCKAGE_DE_SESSION = () => {
  const entrees = [];
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const name = window.sessionStorage.key(i);
      entrees.push({ name, value: window.sessionStorage.getItem(name) });
    }
  } catch {
    /* stockage refusé par la page : rien à lire */
  }
  return { origine: location.origin, entrees };
};

/**
 * Posé par `context.addInitScript(RESTAURER_STOCKAGE_DE_SESSION, {origine,
 * entrees})` : AVANT tout script de la page, sur la seule origine déclarée,
 * chaque clé ABSENTE reçoit sa valeur. Une clé que le site a déjà écrite
 * pendant le passage n'est jamais écrasée.
 */
const RESTAURER_STOCKAGE_DE_SESSION = ({ origine, entrees }) => {
  try {
    if (location.origin !== origine) return;
    for (const { name, value } of entrees) {
      if (window.sessionStorage.getItem(name) === null) window.sessionStorage.setItem(name, value);
    }
  } catch {
    /* stockage refusé : le site dira lui-même qu'il n'a pas de session */
  }
};

/**
 * La sortie d'un passage réussi, augmentée de l'état du navigateur à sa fin
 * (`sessionRenouvelee`, lot 87) — 0.2.3.
 *
 * ─── Pourquoi ─────────────────────────────────────────────────────────────────
 *
 * Demande du 25/10/2026 : ne plus avoir à se reconnecter. Onze
 * services rejouent la connexion enregistrée dans un navigateur neuf, puis le
 * ferment — et perdent tout ce que le site a rafraîchi pendant le passage
 * (un jeton prolongé, un cookie tournant) : la connexion enregistrée
 * vieillit donc d'un passage à l'autre jusqu'à l'expiration, même quand le
 * site l'aurait prolongée. Les dix services qui renouvelaient déjà leur
 * session le faisaient chacun à sa façon ; les onze suivants passent par ici.
 *
 * ─── Les bornes ───────────────────────────────────────────────────────────────
 *
 * Seulement à la SORTIE RÉUSSIE d'un passage : une erreur n'arrive jamais
 * jusqu'ici, donc une session tombée ne remplace jamais la bonne. L'état
 * relu est ensuite trié par le planificateur sur les domaines du service
 * (`remoteLogin.keepDomains`), comme une connexion enregistrée, puis
 * contrôlé et chiffré par `saveConfig`. Un état illisible ne change rien : la
 * connexion d'avant reste, et le journal le dit.
 *
 * @param {{storageState: () => Promise<object>}} context le contexte du passage
 * @param {Array|object} sortie ce que rend `fetchInvoices` : un tableau de
 *   factures, ou un objet (`{ invoices, accountId, aucunDocument… }`)
 * @param {(texte: string) => void} [log]
 * @returns {Promise<object>} la même sortie, en objet, avec `sessionRenouvelee`
 */
async function avecSessionRenouvelee(context, sortie, log = () => {}) {
  const corps = Array.isArray(sortie) ? { invoices: sortie } : { ...(sortie || {}) };
  try {
    corps.sessionRenouvelee = JSON.stringify(await context.storageState());
  } catch {
    log('l\'état de session n\'a pas pu être relu en fin de passage : la connexion enregistrée reste celle d\'avant.');
  }
  return corps;
}

module.exports = {
  avecSessionRenouvelee,
  parse,
  validate,
  summarize,
  describe,
  isExpired,
  latestExpiry,
  cookieExpiry,
  limiterAuxDomaines,
  domaineAutorise,
  toIso,
  nowSeconds,
  CLE_STOCKAGE_DE_SESSION,
  STOCKAGE_MAX_CLES,
  STOCKAGE_MAX_CARACTERES,
  origineHttps,
  entreesValides,
  avecStockageDeSession,
  stockageDeSession,
  sansStockageDeSession,
  nombreDeClesDeStockage,
  LIRE_STOCKAGE_DE_SESSION,
  RESTAURER_STOCKAGE_DE_SESSION,
};
