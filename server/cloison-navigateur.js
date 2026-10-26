'use strict';

/**
 * La cloison de la fenêtre de connexion (bilan de santé du 25/10/2026,
 * constat 1).
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * La fenêtre de connexion est un vrai Chromium, sur le serveur, que la personne
 * connectée à crabe pilote au clavier et à la souris. Jusqu'ici rien ne le
 * bornait : barre d'adresse libre, `file://` compris, et tout l'environnement
 * du service hérité — phrase secrète et secret de session avec. Tout compte qui
 * ouvrait une fenêtre pouvait lire la phrase secrète (`data/phrase-secrete`, ou
 * l'environnement du service), la base, le sel, les factures des autres
 * comptes sur le stockage local, puis les envoyer vers n'importe quel site par un champ
 * d'envoi de fichier.
 *
 * ─── Les trois verrous (mesurés sur Chromium 151, banc du 25/10) ────────────
 *
 *   1. `environnementDuNavigateur` : Chromium ne reçoit plus qu'une liste
 *      blanche de variables (chemin, langue, fuseau, mandataire). Ni phrase
 *      secrète, ni secret de session, ni rien d'autre du service.
 *   2. `cloisonner(contexte)` : toute requête du contexte, navigation comprise,
 *      passe par `context.route`. Mesuré : Playwright y voit `file://`, et
 *      `view-source:file://` arrive comme une requête `file:` — les deux sont
 *      refusés. Est refusé tout ce qui n'est ni http(s), ni data:, ni blob:, ni
 *      about:, et toute adresse de bouclage, privée ou de lien local, qu'elle
 *      soit écrite en clair, `localhost`, ou obtenue en résolvant le nom.
 *   3. Le sélecteur de fichier des pages est intercepté (mesuré : avec un
 *      écouteur, l'évènement arrive et le champ reste vide) : rien du disque du
 *      serveur ne part par un champ d'envoi.
 *
 * ─── Ce qui reste, dit ───────────────────────────────────────────────────────
 *
 *   - les pages internes `chrome://` tapées à la main (Playwright ne les voit
 *     pas ; aucune ne montre le contenu d'un fichier, et la phrase n'est plus
 *     dans l'environnement) ;
 *   - le dialogue « Ouvrir un fichier » de Chromium (Ctrl+O) : il montre des
 *     noms de dossiers, mais la navigation vers le fichier choisi est refusée ;
 *   - un nom dont la résolution changerait entre la vérification et la
 *     connexion de Chromium, et les requêtes d'un service worker, que
 *     `context.route` ne voit pas — pour les seules adresses du réseau local.
 *
 * Les fermer tout à fait demande une politique Chromium installée en root
 * (`URLBlocklist`, `AllowFileSelectionDialogs`) : c'est hors du code.
 *
 * Module sans état global : chaque appel à `cloisonner` a sa propre mémoire.
 */

const dns = require('node:dns').promises;
const net = require('node:net');
const { RESEAUX_PRIVES } = require('./config');

// ---------------------------------------------------------------------------
// 1. L'environnement
// ---------------------------------------------------------------------------

/**
 * Les seules variables du service que Chromium reçoit. `DISPLAY` et `HOME` sont
 * posés ensuite par `browserLaunchOptions`, la langue native aussi.
 */
const VARIABLES_GARDEES = Object.freeze([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  // Un mandataire réseau, s'il y en a un : sans lui, plus aucun site ne charge.
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]);

/** `LC_ALL`, `LC_CTYPE`… : la langue, détaillée. */
const PREFIXES_GARDES = Object.freeze(['LC_']);

/**
 * L'environnement réduit à transmettre à Chromium.
 * @param {object} env l'environnement du service
 * @returns {object}
 */
function environnementDuNavigateur(env = process.env) {
  const garde = {};
  for (const [nom, valeur] of Object.entries(env || {})) {
    if (valeur === undefined) continue;
    if (VARIABLES_GARDEES.includes(nom) || PREFIXES_GARDES.some((p) => nom.startsWith(p))) {
      garde[nom] = valeur;
    }
  }
  return garde;
}

// ---------------------------------------------------------------------------
// 2. Les adresses
// ---------------------------------------------------------------------------

/** Les schémas qu'une page de connexion emploie. Tout le reste est refusé. */
const SCHEMAS_PERMIS = Object.freeze(['http:', 'https:', 'data:', 'blob:', 'about:']);

/**
 * Les réseaux que la fenêtre ne joint jamais : ceux de la barrière réseau
 * (`RESEAUX_PRIVES`, lot 112 — bouclage, privés, Tailscale, IPv6 locaux), plus
 * deux plages qu'elle n'avait pas à connaître, mais qu'un navigateur sur le
 * serveur ne doit pas joindre : `0.0.0.0/8` (« cette machine ») et le lien
 * local IPv4 `169.254.0.0/16`.
 */
const RESEAUX_REFUSES = Object.freeze([...RESEAUX_PRIVES, '0.0.0.0/8', '169.254.0.0/16', '::/128']);

const listeRefusee = (() => {
  const liste = new net.BlockList();
  for (const reseau of RESEAUX_REFUSES) {
    const [adresse, bits] = reseau.split('/');
    const type = net.isIPv6(adresse) ? 'ipv6' : 'ipv4';
    if (bits === undefined) liste.addAddress(adresse, type);
    else liste.addSubnet(adresse, Number(bits), type);
  }
  return liste;
})();

/** Une adresse IP (v4, v6, ou v4 dans v6) appartient-elle à un réseau refusé ? */
function ipRefusee(ip) {
  const nue = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const v4DansV6 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(nue);
  if (v4DansV6) return listeRefusee.check(v4DansV6[1], 'ipv4');
  if (net.isIPv4(nue)) return listeRefusee.check(nue, 'ipv4');
  if (net.isIPv6(nue)) return listeRefusee.check(nue, 'ipv6');
  return false;
}

/**
 * `0.0.0.0/8` et `::` : l'adresse « nulle », qui désigne cette machine. Pour un
 * NOM, c'est le plus souvent la réponse d'un filtre DNS qui bloque ce domaine
 * (constaté le 26/10/2026 : `s-cdn.anthropic.com` et un traceur Datadog dans la
 * fenêtre d'Anthropic) — le refus est le même, la phrase ne parle plus du
 * réseau local, qui n'y est pour rien.
 */
function estAdresseNulle(ip) {
  const nue = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(nue)?.[1] || nue;
  return (net.isIPv4(v4) && v4.startsWith('0.')) || nue === '::';
}

/** `localhost`, et tout nom sous `.localhost` (RFC 6761). */
function estLocalhost(hote) {
  const h = String(hote || '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

/**
 * Le motif de refus d'une adresse, sans résolution de nom ; `null` si elle
 * passe. Chromium a déjà mis l'adresse sous forme canonique (une IPv4 écrite en
 * décimal ou en hexadécimal y est en notation pointée).
 * @param {string} adresse
 * @returns {string|null}
 */
function motifDeRefus(adresse) {
  let url;
  try {
    url = new URL(adresse);
  } catch {
    return 'adresse illisible';
  }
  if (!SCHEMAS_PERMIS.includes(url.protocol)) return `schéma ${url.protocol} refusé`;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (estLocalhost(url.hostname)) return `adresse locale ${url.hostname} refusée`;
  if (estAdresseNulle(url.hostname)) return `adresse ${url.hostname} refusée : elle désigne cette machine`;
  if (ipRefusee(url.hostname)) return `adresse du réseau local ${url.hostname} refusée`;
  return null;
}

/**
 * Comme `motifDeRefus`, en résolvant aussi le nom : un nom qui désigne une
 * adresse locale ou privée (`crabe.local`, une box) est refusé comme l'adresse
 * elle-même. Une résolution qui échoue ne refuse rien : Chromium échouera seul.
 * @param {string} adresse
 * @param {{lookup?: Function, memoire?: Map}} [options]
 * @returns {Promise<string|null>}
 */
async function motifDeRefusResolu(adresse, { lookup = dns.lookup, memoire = null } = {}) {
  const immediat = motifDeRefus(adresse);
  if (immediat) return immediat;
  let url;
  try {
    url = new URL(adresse);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hote = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hote)) return null; // déjà jugée en clair
  if (memoire?.has(hote)) return memoire.get(hote);
  let motif = null;
  try {
    const adresses = await lookup(hote, { all: true });
    const locale = (adresses || []).find((a) => ipRefusee(a.address));
    if (locale && estAdresseNulle(locale.address)) {
      motif = `${hote} désigne l'adresse ${locale.address}, refusée — la réponse d'un filtre DNS qui bloque ce domaine, le plus souvent`;
    } else if (locale) {
      motif = `${hote} désigne une adresse du réseau local (${locale.address}), refusée`;
    }
  } catch {
    motif = null;
  }
  memoire?.set(hote, motif);
  return motif;
}

// ---------------------------------------------------------------------------
// 3. Le contexte
// ---------------------------------------------------------------------------

/**
 * Pose la cloison sur un contexte Playwright : chaque requête est jugée, et le
 * sélecteur de fichier de chaque page (présente ou à venir) est intercepté.
 *
 * @param {import('playwright').BrowserContext} contexte
 * @param {{journal?: (texte: string) => void, lookup?: Function}} [options]
 *   `journal` reçoit chaque refus, une fois par motif ; `lookup` remplace la
 *   résolution de noms (essais).
 */
async function cloisonner(contexte, { journal = () => {}, lookup = dns.lookup } = {}) {
  const memoire = new Map();
  const dejaDits = new Set();
  const dire = (texte) => {
    if (dejaDits.has(texte)) return;
    dejaDits.add(texte);
    try {
      journal(texte);
    } catch {
      /* un journal en panne ne lève pas la cloison */
    }
  };

  await contexte.route('**/*', async (route) => {
    let motif = null;
    try {
      motif = await motifDeRefusResolu(route.request().url(), { lookup, memoire });
    } catch {
      motif = null;
    }
    if (motif) {
      dire(`Fenêtre de connexion : ${motif}.`);
      return route.abort('blockedbyclient').catch(() => {});
    }
    return route.continue().catch(() => {});
  });

  const surveiller = (page) => {
    // Un écouteur suffit : Playwright intercepte alors le dialogue, qui ne
    // s'ouvre pas, et le champ reste vide.
    page.on('filechooser', () => dire('Fenêtre de connexion : envoi d\'un fichier du serveur refusé.'));
  };
  for (const page of contexte.pages()) surveiller(page);
  contexte.on('page', surveiller);
}

module.exports = {
  VARIABLES_GARDEES,
  SCHEMAS_PERMIS,
  RESEAUX_REFUSES,
  estAdresseNulle,
  environnementDuNavigateur,
  ipRefusee,
  motifDeRefus,
  motifDeRefusResolu,
  cloisonner,
};
