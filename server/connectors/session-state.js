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

module.exports = {
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
};
