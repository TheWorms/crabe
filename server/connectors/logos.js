'use strict';

/**
 * Les vrais logos des services, pris chez le fournisseur lui-même.
 *
 * ─── Ce que ça remplace ──────────────────────────────────────────────────────
 *
 * Des pastilles à initiales — « FM », « F », « ED ». Lisibles, mais qui
 * demandent un effort de déchiffrage à chaque écran. Un utilisateur reconnaît
 * le logo d'EDF en un dixième de seconde ; « ED » sur fond bleu, non.
 *
 * ─── Pourquoi jamais un agrégateur ───────────────────────────────────────────
 *
 * Des services rendent le logo de n'importe quelle marque à partir de son
 * domaine, et ce serait dix lignes de code. Mais interroger un tiers pour le
 * logo d'EDF, c'est **lui annoncer que l'utilisateur a un compte EDF** — et,
 * requête après requête, lui livrer la liste de tous les services de la
 * maison. crabe est confiné au réseau local et n'a aucune raison d'en sortir
 * autrement que vers les fournisseurs eux-mêmes.
 *
 * Chaque logo est donc pris SUR LE SITE DU FOURNISSEUR, à une adresse dérivée
 * du champ `site` de son manifeste, et la provenance est vérifiée : un
 * candidat qui pointe ailleurs que sur ce domaine (ou l'un de ses
 * sous-domaines) est écarté, y compris après redirection.
 *
 * ─── La cascade ──────────────────────────────────────────────────────────────
 *
 * On s'arrête au premier résultat correct :
 *
 *   1. `apple-touch-icon` déclarée dans la page d'accueil — souvent 180 px,
 *      carrée, sur fond plein : de loin la meilleure source ;
 *   2. les icônes du manifeste web (`manifest.json`), la plus grande d'abord ;
 *   3. `og:image`, mais SEULEMENT si elle ressemble à un logo (petite, à peu
 *      près carrée). La plupart des `og:image` sont des bannières 1200×630 :
 *      en faire une pastille ronde donnerait une bouillie ;
 *   4. les icônes classiques déclarées (`<link rel="icon">`) ;
 *   5. le **logo d'en-tête** — `#header_logo`, `.logo img`, tout `img` dont
 *      l'`alt` dit « logo ». Ajouté au lot 14 : Kubii n'a pas de favicon
 *      (« réponse HTTP 404 ») et son logo est pourtant à l'écran, en meilleure
 *      qualité qu'aucune icône de 32 pixels ;
 *   6. `/favicon.ico` ;
 *   7. les chemins **conventionnels de PrestaShop** — `/img/logo.jpg`,
 *      `/img/logo.png` —, que la moitié des boutiques n'annoncent nulle part
 *      parce que leur thème affiche le logo en arrière-plan CSS.
 *
 * ─── Le 403 anti-robot ───────────────────────────────────────────────────────
 *
 * Propolia refuse une requête HTTP simple (« réponse HTTP 403 ») : c'est une
 * protection, pas une absence de logo. Après un 401, 403 ou 429 — et
 * uniquement après —, la page d'accueil est redemandée par le Chromium que
 * crabe fait déjà tourner pour les connecteurs. Ouvrir un navigateur coûte une
 * seconde et 300 Mo : le payer sur les douze sites qui répondent bien serait
 * absurde.
 *
 * ─── Et si rien ne va ────────────────────────────────────────────────────────
 *
 * On garde la pastille à initiales. C'est la règle qui gouverne tout ce
 * fichier : **au moindre doute, on ne pose pas d'image**. Un carré cassé ou un
 * bout de bannière est pire qu'une initiale.
 *
 * ─── Jamais en tâche de fond ─────────────────────────────────────────────────
 *
 * Aucune récupération n'est déclenchée par un démarrage, une planification ou
 * l'affichage d'un écran. Uniquement sur action explicite d'un administrateur,
 * depuis Paramètres → Applications → Logos.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/db');

/** Poids maximal d'un logo. Au-delà, ce n'est plus une icône. */
const TAILLE_MAX = 500 * 1024;
/** Dimensions plausibles pour un logo. */
const COTE_MIN = 16;
const COTE_MAX = 2048;
/**
 * Une `og:image` n'est retenue que si elle ressemble à un logo : à peu près
 * carrée, et pas plus grande qu'une icône d'application.
 */
const OG_RAPPORT_MAX = 1.35;
const OG_COTE_MAX = 1024;

/** Délai de récupération, volontairement court : c'est un confort, pas un dû. */
const DELAI_MS = 6000;
/** Budget total pour un connecteur, cascade comprise. */
const BUDGET_MS = 20_000;

/** Formats acceptés, et l'extension sous laquelle ils sont rangés. */
const FORMATS = {
  png: { ext: 'png', type: 'image/png' },
  jpeg: { ext: 'jpg', type: 'image/jpeg' },
  webp: { ext: 'webp', type: 'image/webp' },
  ico: { ext: 'ico', type: 'image/x-icon' },
  svg: { ext: 'svg', type: 'image/svg+xml' },
};

/** Extensions servies, et le type qui va avec. */
const TYPES_PAR_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

const SOURCES = ['manual', 'fetched'];

// ---------------------------------------------------------------------------
// Analyse d'image — fonctions pures
// ---------------------------------------------------------------------------

/**
 * Reconnaît le format et les dimensions d'une image à ses premiers octets.
 *
 * Volontairement sans dépendance : cinq formats, quelques dizaines de lignes,
 * et surtout aucun décodage — on lit des en-têtes, on ne rend rien. Une
 * bibliothèque de traitement d'image pour lire deux entiers serait une surface
 * d'attaque gratuite sur des fichiers venus d'Internet.
 *
 * @param {Buffer} buffer
 * @returns {{format: string, width: number|null, height: number|null}|null}
 */
function reconnaitreImage(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG : signature, puis IHDR (largeur et hauteur en gros-boutiste).
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // ICO : 00 00 01 00, puis un répertoire d'entrées. Un côté noté 0 vaut 256.
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) {
    const entrees = buffer.readUInt16LE(4);
    if (entrees > 0 && buffer.length >= 6 + 16) {
      // La plus grande des entrées : un .ico en porte souvent plusieurs.
      let largeur = 0;
      let hauteur = 0;
      for (let i = 0; i < entrees && 6 + i * 16 + 1 < buffer.length; i++) {
        const l = buffer[6 + i * 16] || 256;
        const h = buffer[6 + i * 16 + 1] || 256;
        if (l * h > largeur * hauteur) {
          largeur = l;
          hauteur = h;
        }
      }
      return { format: 'ico', width: largeur, height: hauteur };
    }
  }

  // WebP : RIFF … WEBP, puis un chunk VP8 / VP8L / VP8X.
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { format: 'webp', ...tailleWebp(buffer) };
  }

  // JPEG : SOI, puis on saute de marqueur en marqueur jusqu'à un SOFn.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: 'jpeg', ...tailleJpeg(buffer) };
  }

  // SVG : du texte. On tolère une BOM, une déclaration XML, un DOCTYPE, des
  // commentaires — tout ce qui précède réellement la balise racine.
  const tete = buffer.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^<(\?xml|!DOCTYPE|!--|svg)/i.test(tete) && /<svg[\s>]/i.test(buffer.toString('utf8', 0, 4096))) {
    return { format: 'svg', ...tailleSvg(buffer.toString('utf8', 0, 4096)) };
  }

  return null;
}

/** Dimensions d'un WebP, selon celui de ses trois encodages qui est présent. */
function tailleWebp(buffer) {
  const chunk = buffer.subarray(12, 16).toString('latin1');
  try {
    if (chunk === 'VP8 ') {
      // Bloc-clé VP8 : 14 octets d'en-tête, puis largeur et hauteur sur 14 bits.
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const lire24 = (offset) =>
        buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      return { width: lire24(24) + 1, height: lire24(27) + 1 };
    }
  } catch {
    /* fichier tronqué : dimensions inconnues, la suite tranchera */
  }
  return { width: null, height: null };
}

/** Dimensions d'un JPEG : premier marqueur SOFn rencontré. */
function tailleJpeg(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) {
      i++;
      continue;
    }
    const marqueur = buffer[i + 1];
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 : les cadres qui portent la taille.
    // C0..CF sauf C4 (Huffman), C8 (JPG) et CC (arithmétique).
    if (marqueur >= 0xc0 && marqueur <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marqueur)) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    if (marqueur === 0xd8 || (marqueur >= 0xd0 && marqueur <= 0xd9)) {
      i += 2;
      continue;
    }
    const taille = buffer.readUInt16BE(i + 2);
    if (taille < 2) break;
    i += 2 + taille;
  }
  return { width: null, height: null };
}

/**
 * Dimensions d'un SVG, si elles sont déclarées.
 *
 * Souvent absentes — un SVG sans dimensions se met à l'échelle, ce qui est
 * précisément ce qu'on veut d'un logo. On ne le refuse donc pas pour ça.
 */
function tailleSvg(texte) {
  const nombre = (valeur) => {
    const n = Number.parseFloat(valeur);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  const largeur = nombre(/<svg[^>]*\swidth\s*=\s*["']?([\d.]+)/i.exec(texte)?.[1]);
  const hauteur = nombre(/<svg[^>]*\sheight\s*=\s*["']?([\d.]+)/i.exec(texte)?.[1]);
  if (largeur && hauteur) return { width: largeur, height: hauteur };

  const vue = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(texte);
  if (vue) return { width: nombre(vue[1]), height: nombre(vue[2]) };

  return { width: null, height: null };
}

/**
 * Ce fichier est-il un logo acceptable ?
 *
 * @param {Buffer} buffer
 * @param {{source?: string}} [options] la source de la cascade, qui durcit
 *   la règle pour `og:image`
 * @returns {{ok: boolean, ext?: string, width?: number|null, height?: number|null, raison?: string}}
 */
function analyserImage(buffer, { source = '' } = {}) {
  if (!buffer || !buffer.length) return { ok: false, raison: 'fichier vide' };
  if (buffer.length > TAILLE_MAX) {
    return {
      ok: false,
      raison: `trop lourd (${Math.round(buffer.length / 1024)} Ko, ${TAILLE_MAX / 1024} au plus)`,
    };
  }

  const image = reconnaitreImage(buffer);
  if (!image) return { ok: false, raison: 'ce n\'est pas une image reconnue' };
  if (!FORMATS[image.format]) return { ok: false, raison: `format ${image.format} non accepté` };

  const { width, height } = image;
  if (width !== null && height !== null) {
    if (width < COTE_MIN || height < COTE_MIN) {
      return { ok: false, raison: `trop petite (${width}×${height})` };
    }
    if (width > COTE_MAX || height > COTE_MAX) {
      return { ok: false, raison: `trop grande (${width}×${height})` };
    }
    if (source === 'og:image') {
      // Presque toutes les og:image sont des bannières 1200×630 : en faire une
      // pastille ronde donnerait un bout d'image sans rapport avec un logo.
      const rapport = Math.max(width / height, height / width);
      if (rapport > OG_RAPPORT_MAX) {
        return { ok: false, raison: `og:image pas assez carrée (${width}×${height})` };
      }
      if (width > OG_COTE_MAX || height > OG_COTE_MAX) {
        return { ok: false, raison: `og:image trop grande pour un logo (${width}×${height})` };
      }
    }
  } else if (image.format !== 'svg') {
    // Un raster dont on n'a pas su lire l'en-tête est probablement tronqué.
    return { ok: false, raison: 'dimensions illisibles' };
  }

  return { ok: true, ext: FORMATS[image.format].ext, width, height };
}

// ---------------------------------------------------------------------------
// Cascade de candidats — fonctions pures
// ---------------------------------------------------------------------------

/**
 * L'adresse d'où partir pour chercher le logo d'un service.
 *
 * ─── Depuis l'ADRESSE, jamais depuis le NOM ──────────────────────────────────
 *
 * Question posée au lot 13 : la récupération part-elle de l'adresse du site ou
 * du nom du service ? De l'adresse, et il ne peut pas en être autrement.
 * Chercher « Propolia » dans un moteur de recherche donnerait le premier
 * résultat venu — une place de marché, un article, un concurrent — et enverrait
 * en prime une requête à un tiers avec la liste des services installés. Aucune
 * fonction de ce module ne lit `manifest.name`.
 *
 * ─── Trois sources d'adresse, dans cet ordre ─────────────────────────────────
 *
 *   1. le champ `site` du manifeste — déclaré pour ça, et le plus court
 *      (« propolia.com » plutôt qu'une page interne) ;
 *   2. les URL de CONNEXION et de COMMANDES, dont on extrait le domaine — un
 *      connecteur qui déclare
 *      `https://www.coco-papaya.com/fr/connexion?back=my-account` sait
 *      parfaitement où il va, même si son champ `site` manque ou approxime ;
 *   3. l'URL de connexion par navigateur distant, pour ceux qui n'ont que
 *      celle-là.
 *
 * @param {object} manifest
 * @returns {{url: URL, source: string}|null}
 */
function adresseDuManifeste(manifest) {
  const candidats = [
    { valeur: manifest?.site, source: 'le champ « site » du manifeste' },
    { valeur: manifest?.urls?.login, source: 'l\'adresse de connexion déclarée' },
    { valeur: manifest?.urls?.orders, source: 'l\'adresse des commandes déclarée' },
    { valeur: manifest?.remoteLogin?.url, source: 'l\'adresse de connexion par navigateur' },
  ];

  for (const { valeur, source } of candidats) {
    const url = urlDuSite(valeur);
    if (!url) continue;
    // La RACINE du domaine, jamais la page profonde : c'est là que se déclarent
    // l'apple-touch-icon et le manifeste web, qu'une page de connexion allégée
    // omet souvent.
    return { url: new URL('/', url), source };
  }
  return null;
}

/** `mobile.free.fr` ou `https://mobile.free.fr/x` → `https://mobile.free.fr/`. */
function urlDuSite(site) {
  const brut = String(site || '').trim();
  if (!brut) return null;
  // Un autre protocole n'est PAS un site : le préfixer d'un « https:// » en
  // ferait une adresse absurde (« https://ftp//exemple.fr ») au lieu d'un refus.
  if (/^[a-z][a-z0-9+.-]*:/i.test(brut) && !/^https?:\/\//i.test(brut)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(brut) ? brut : `https://${brut}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Cette adresse est-elle bien chez le fournisseur ?
 *
 * Le point entier du lot : le logo vient du site du fournisseur, pas d'un
 * tiers. Un `mobile.free.fr` accepte `free.fr` et `static.free.fr`, mais pas
 * un CDN d'images ni un annuaire de marques.
 */
function memeFournisseur(candidat, base) {
  try {
    const a = new URL(candidat).hostname.toLowerCase().replace(/^www\./, '');
    const b = new URL(base).hostname.toLowerCase().replace(/^www\./, '');
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

/** Un hôte qui n'a rien à faire là : boucle locale, adresse IP, réseau privé. */
function hoteSuspect(url) {
  let hote;
  try {
    hote = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hote === 'localhost' || hote.endsWith('.localhost') || hote.endsWith('.local')) return true;
  // Une adresse IP littérale ne désigne pas un site de fournisseur.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hote) || hote.includes(':')) return true;
  return !hote.includes('.');
}

/** Résout une adresse relative, en écartant tout ce qui n'est pas http(s). */
function resoudre(reference, base) {
  try {
    const url = new URL(String(reference).trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** « 180x180 » ou « 32x32 48x48 » → le plus grand côté déclaré. */
function tailleDeclaree(sizes) {
  const nombres = String(sizes || '')
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nombres.length ? Math.max(...nombres) : 0;
}

/** Les balises `<link>` et `<meta>` de la page, sous forme d'attributs. */
function balises(html, nom) {
  const sortie = [];
  const motif = new RegExp(`<${nom}\\b[^>]*>`, 'gi');
  for (const balise of String(html || '').match(motif) || []) {
    const attributs = {};
    for (const [, cle, valeur] of balise.matchAll(
      /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    )) {
      const propre = valeur.replace(/^["']|["']$/g, '');
      attributs[cle.toLowerCase()] = propre;
    }
    sortie.push(attributs);
  }
  return sortie;
}

/**
 * Les candidats déclarés par une page d'accueil, dans l'ordre de la cascade.
 *
 * @param {string} html
 * @param {string} base URL de la page, pour résoudre les adresses relatives
 * @returns {Array<{url: string, source: string, taille: number}>}
 */
function candidatsDepuisPage(html, base) {
  const liens = balises(html, 'link');
  const metas = balises(html, 'meta');
  const candidats = [];

  const relsDe = (attributs) => String(attributs.rel || '').toLowerCase().split(/\s+/);

  // 1. apple-touch-icon — la meilleure source, la plus grande d'abord.
  const pommes = liens
    .filter((a) => relsDe(a).some((r) => r.startsWith('apple-touch-icon')))
    .map((a) => ({ href: a.href, taille: tailleDeclaree(a.sizes) }))
    .filter((a) => a.href)
    .sort((a, b) => b.taille - a.taille);
  for (const { href, taille } of pommes) {
    const url = resoudre(href, base);
    if (url) candidats.push({ url, source: 'apple-touch-icon', taille });
  }

  // 2. le manifeste web — ses icônes sont récupérées dans un second temps.
  for (const attributs of liens) {
    if (!relsDe(attributs).includes('manifest') || !attributs.href) continue;
    const url = resoudre(attributs.href, base);
    if (url) candidats.push({ url, source: 'manifest', taille: 0 });
  }

  // 3. og:image, sous réserve qu'elle ressemble à un logo (voir analyserImage).
  for (const attributs of metas) {
    const propriete = String(attributs.property || attributs.name || '').toLowerCase();
    if (!['og:image', 'og:image:url', 'twitter:image'].includes(propriete)) continue;
    const url = resoudre(attributs.content || '', base);
    if (url) candidats.push({ url, source: 'og:image', taille: 0 });
  }

  // 4. les icônes classiques déclarées, puis /favicon.ico en dernier recours.
  const icones = liens
    .filter((a) => relsDe(a).some((r) => r === 'icon' || r === 'shortcut'))
    .map((a) => ({ href: a.href, taille: tailleDeclaree(a.sizes) }))
    .filter((a) => a.href)
    .sort((a, b) => b.taille - a.taille);
  for (const { href, taille } of icones) {
    const url = resoudre(href, base);
    if (url) candidats.push({ url, source: 'favicon', taille });
  }

  // 5. le logo d'EN-TÊTE, lu dans le corps de la page.
  //
  // Lot 14, §10 : Kubii n'a pas de favicon (« réponse HTTP 404 »), et beaucoup
  // de boutiques n'en déclarent aucun. Leur logo est pourtant à l'écran, dans
  // l'en-tête, en meilleure qualité que n'importe quelle icône de 32 pixels.
  for (const url of logosDEnTete(html, base)) {
    candidats.push({ url, source: 'en-tête', taille: 0 });
  }

  const parDefaut = resoudre('/favicon.ico', base);
  if (parDefaut) candidats.push({ url: parDefaut, source: 'favicon', taille: 0 });

  // 6. les chemins conventionnels de PrestaShop, en tout dernier recours.
  //
  // Sur PrestaShop, le logo est presque toujours à `/img/logo.jpg` ou
  // `/img/logo.png` — y compris quand la page ne le déclare nulle part parce
  // que le thème l'affiche en arrière-plan CSS. Ça ne coûte que deux requêtes,
  // et seulement quand tout le reste a échoué.
  for (const chemin of CHEMINS_CONVENTIONNELS) {
    const url = resoudre(chemin, base);
    if (url) candidats.push({ url, source: 'chemin conventionnel', taille: 0 });
  }

  // Un même fichier peut être déclaré deux fois : on ne le récupère qu'une.
  const vus = new Set();
  return candidats.filter((c) => !vus.has(c.url) && vus.add(c.url));
}

/**
 * Ce qui porte le mot « logo » sans être celui de la boutique.
 *
 * Une page de boutique en affiche une dizaine — cartes bancaires, transporteurs,
 * labels de confiance, réseaux sociaux — et ils sont souvent mieux balisés que
 * le vrai. Poser le logo de Visa sur la tuile de Kubii serait pire que
 * l'initiale qu'on remplace.
 */
const MOTIF_LOGO_TIERS =
  /visa|mastercard|paypal|amex|american.?express|bancontact|klarna|alma|scalapay|apple.?pay|google.?pay'?|stripe'?|colissimo|chronopost|mondial.?relay|dhl|ups|fedex|facebook|instagram|twitter|youtube|linkedin|tiktok|pinterest|trustpilot|avis.?verifi|paiement|payment|secur|partenaire|partner|sponsor/i;

/** Les chemins où PrestaShop range son logo, par convention. */
const CHEMINS_CONVENTIONNELS = [
  '/img/logo.png',
  '/img/logo.jpg',
  '/img/logo.svg',
  '/img/logo.webp',
];

/**
 * Les images qui ressemblent à un logo d'en-tête.
 *
 * ─── Pourquoi sur le texte plutôt que sur un DOM ─────────────────────────────
 *
 * Ce module ne charge pas de navigateur : la page est une chaîne. On cherche
 * donc les `<img>` dont l'identifiant, la classe ou l'attribut `alt` disent
 * « logo », et on borne la recherche à la première moitié du document — un
 * en-tête n'est jamais en bas de page, et les pieds de page sont pleins de
 * logos de moyens de paiement.
 *
 * L'ordre est celui du §10 : `#header_logo` (l'identifiant PrestaShop) d'abord,
 * puis `.logo`, puis tout `img` dont l'`alt` parle de logo.
 *
 * @param {string} html
 * @param {string} base
 * @returns {string[]}
 */
function logosDEnTete(html, base) {
  // La moitié haute suffit, et évite les logos de cartes bancaires du pied de
  // page. 60 000 caractères couvrent largement un en-tête, même verbeux.
  const haut = String(html || '').slice(0, 60_000);
  const images = balises(haut, 'img');

  const score = (attributs) => {
    const signature = [attributs.id, attributs.class, attributs.alt]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    // Les logos qui ne sont pas CELUI de la boutique : moyens de paiement,
    // réseaux sociaux, labels de confiance, transporteurs. Ils portent le mot
    // « logo » aussi souvent que le bon, et ils sont plus nombreux.
    if (MOTIF_LOGO_TIERS.test(signature)) return 0;
    if (/header[_-]?logo/.test(signature)) return 3;
    if (/\blogo\b/.test(signature)) return 2;
    // Un `alt` qui reprend le nom de la boutique sans dire « logo » : c'est
    // souvent le bon, mais on le met après, il se confond avec une bannière.
    if (/logotype|marque|brand/.test(signature)) return 1;
    return 0;
  };

  return images
    .map((attributs) => ({ attributs, poids: score(attributs) }))
    .filter((c) => c.poids > 0)
    .sort((a, b) => b.poids - a.poids)
    .map((c) => resoudre(c.attributs.src || c.attributs['data-src'] || '', base))
    .filter(Boolean)
    .slice(0, 4);
}

/** Les icônes d'un manifeste web, la plus grande d'abord. */
function candidatsDepuisManifesteWeb(json, base) {
  const icones = Array.isArray(json?.icons) ? json.icons : [];
  return icones
    .map((icone) => ({
      url: resoudre(icone?.src || '', base),
      source: 'manifest',
      taille: tailleDeclaree(icone?.sizes),
    }))
    .filter((c) => c.url)
    .sort((a, b) => b.taille - a.taille);
}

// ---------------------------------------------------------------------------
// Stockage
// ---------------------------------------------------------------------------

/** `CRABE_DATA_DIR/logos`, créé à la demande. */
function dossier() {
  return path.join(require('../config').config.dataDir, 'logos');
}

function assurerDossier() {
  const dir = dossier();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Un identifiant de sujet ne peut être qu'un nom de fichier sûr. */
function identifiantValide(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(id || ''));
}

// ---------------------------------------------------------------------------
// Les sujets : ce qui peut porter un logo
// ---------------------------------------------------------------------------

/**
 * Un logo n'est plus l'affaire des seuls connecteurs.
 *
 * Le lot 8 a récupéré les logos des treize fournisseurs ; les **destinations de
 * stockage** — Proton Drive, pCloud — s'affichent aux mêmes endroits, avec les
 * mêmes pastilles à initiales, et méritaient le même traitement. Le mécanisme
 * est rigoureusement identique : la cascade ne connaît qu'un `{ id, site }`.
 *
 * Reste à ne pas mélanger les identifiants. Une destination range son logo sous
 * `destination-proton`, un connecteur sous `proton` s'il en existait un un jour.
 * Le préfixe est la SEULE chose qui les sépare, et il est posé ici plutôt que
 * chez les cinq appelants.
 *
 * Le stockage local est un sujet à part : stockage local, aucun site, donc aucune
 * récupération possible — la cascade le refuse d'elle-même, faute de `site`, et
 * l'écran d'administration grise son bouton comme celui d'un connecteur sans
 * site. Son icône est interne au dépôt (voir destinations/catalogue.js).
 */
const PREFIXE_DESTINATION = 'destination-';

/** « proton » → « destination-proton ». */
function idDeDestination(destId) {
  return `${PREFIXE_DESTINATION}${String(destId || '').trim()}`;
}

/** « destination-proton » → « proton » ; `null` si ce n'en est pas un. */
function destinationDeId(logoId) {
  const texte = String(logoId || '');
  return texte.startsWith(PREFIXE_DESTINATION)
    ? texte.slice(PREFIXE_DESTINATION.length) || null
    : null;
}

/**
 * Tout ce qui peut porter un logo, connecteurs puis destinations.
 *
 * Les deux modules sont chargés à l'appel, et non en tête de fichier : le
 * registre des connecteurs requiert déjà celui-ci, et le catalogue des
 * destinations aussi. C'est l'idiome du fichier (voir `dossier()`).
 *
 * @returns {Array<{id: string, kind: 'connector'|'destination', name: string,
 *                  site: string, color: string, letters: string}>}
 */
function sujets() {
  const registry = require('./registry');
  const catalogue = require('../destinations/catalogue');

  const connecteurs = registry.listAll().map((c) => ({
    id: c.id,
    kind: 'connector',
    name: c.name,
    site: c.site || '',
    color: c.color,
    letters: c.letters,
  }));

  const destinations = catalogue.list().map((d) => ({
    id: idDeDestination(d.id),
    kind: 'destination',
    name: d.name,
    site: d.site || '',
    color: d.color,
    letters: d.letter,
    // Le stockage local, et lui seul : une icône livrée dans le dépôt, qui s'affiche
    // faute de logo récupéré et qui ne peut pas l'être.
    interne: d.logoInterne ? d.logo : null,
  }));

  return [...connecteurs, ...destinations];
}

/** Le sujet portant cet identifiant de logo, ou `null`. */
function sujet(id) {
  return sujets().find((s) => s.id === String(id || '')) || null;
}

/** Ligne de la table, ou `null`. */
function lire(connectorId) {
  return (
    db
      .get()
      .prepare('SELECT * FROM connector_logos WHERE connector_id = ?')
      .get(String(connectorId)) || null
  );
}

/** Chemin du fichier d'un logo enregistré, ou `null`. */
function chemin(connectorId) {
  const ligne = lire(connectorId);
  if (!ligne || !identifiantValide(connectorId)) return null;
  return path.join(dossier(), `${connectorId}.${ligne.extension}`);
}

/**
 * L'adresse à laquelle l'interface va chercher le logo — ou `null`.
 *
 * Toujours servie par crabe : une fois récupéré, un logo est LOCAL. Aucun
 * écran ne redemande quoi que ce soit au fournisseur à l'affichage, sans quoi
 * ouvrir l'accueil reviendrait à annoncer à treize services qu'on est là.
 *
 * L'horodatage en paramètre force le navigateur à recharger après une
 * resynchronisation, sans quoi l'ancien logo resterait affiché.
 */
function publicUrl(connectorId) {
  const ligne = lire(connectorId);
  if (!ligne || !identifiantValide(connectorId)) return null;
  const version = Date.parse(`${ligne.fetched_at}Z`.replace(' ', 'T')) || 0;
  return `/api/connectors/logos/${connectorId}.${ligne.extension}?v=${version}`;
}

/** Tous les logos connus, par identifiant de connecteur. */
function tousLesUrls() {
  const sortie = new Map();
  for (const ligne of db.get().prepare('SELECT * FROM connector_logos').all()) {
    if (!identifiantValide(ligne.connector_id)) continue;
    const version = Date.parse(`${ligne.fetched_at}Z`.replace(' ', 'T')) || 0;
    sortie.set(
      ligne.connector_id,
      `/api/connectors/logos/${ligne.connector_id}.${ligne.extension}?v=${version}`
    );
  }
  return sortie;
}

/**
 * Écrit un logo et l'enregistre.
 *
 * @param {string} connectorId
 * @param {Buffer} buffer
 * @param {{ext: string, source: 'fetched'|'manual', origin?: string|null,
 *          width?: number|null, height?: number|null}} meta
 */
function enregistrer(connectorId, buffer, meta) {
  if (!identifiantValide(connectorId)) throw new Error(`Identifiant invalide : ${connectorId}`);
  if (!SOURCES.includes(meta.source)) throw new Error(`Source inconnue : ${meta.source}`);

  const dir = assurerDossier();
  // Un changement de format laisserait l'ancien fichier derrière lui.
  supprimerFichiers(connectorId);
  fs.writeFileSync(path.join(dir, `${connectorId}.${meta.ext}`), buffer);

  db.get()
    .prepare(
      `INSERT INTO connector_logos
         (connector_id, extension, source, origin, bytes, width, height, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(connector_id) DO UPDATE SET
         extension = excluded.extension, source = excluded.source, origin = excluded.origin,
         bytes = excluded.bytes, width = excluded.width, height = excluded.height,
         fetched_at = datetime('now')`
    )
    .run(
      connectorId,
      meta.ext,
      meta.source,
      meta.origin || null,
      buffer.length,
      meta.width ?? null,
      meta.height ?? null
    );

  return lire(connectorId);
}

/** Efface les fichiers d'un connecteur, quelle que soit leur extension. */
function supprimerFichiers(connectorId) {
  if (!identifiantValide(connectorId)) return;
  for (const ext of Object.keys(TYPES_PAR_EXT)) {
    try {
      fs.rmSync(path.join(dossier(), `${connectorId}.${ext}`), { force: true });
    } catch {
      /* déjà parti */
    }
  }
}

/** Retire un logo : le fichier et la ligne. La pastille reprend sa place. */
function supprimer(connectorId) {
  supprimerFichiers(connectorId);
  oublierEchec(connectorId);
  return (
    db.get().prepare('DELETE FROM connector_logos WHERE connector_id = ?').run(connectorId)
      .changes > 0
  );
}

// ---------------------------------------------------------------------------
// Le dernier échec, gardé pour pouvoir le dire
// ---------------------------------------------------------------------------

/**
 * Mémorise pourquoi un logo n'a pas pu être récupéré.
 *
 * Le gestionnaire annonçait « 8 logos en place, 6 manquants » sans jamais dire
 * pourquoi les six manquaient : la raison existait, mais elle disparaissait dès
 * qu'on quittait l'écran. C'est elle qui permet de comprendre pourquoi Ameli et
 * Engie résistent, sans relancer une récupération pour la relire.
 */
function noterEchec(connectorId, raison) {
  if (!identifiantValide(connectorId)) return;
  db.get()
    .prepare(
      `INSERT INTO logo_failures (connector_id, reason, at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(connector_id) DO UPDATE SET
         reason = excluded.reason, at = datetime('now')`
    )
    .run(String(connectorId), String(raison || 'raison inconnue').slice(0, 500));
}

/** Une récupération réussie efface l'échec précédent : il n'est plus vrai. */
function oublierEchec(connectorId) {
  try {
    db.get().prepare('DELETE FROM logo_failures WHERE connector_id = ?').run(String(connectorId));
  } catch {
    /* table absente sur une base non migrée : sans conséquence */
  }
}

/** Le dernier échec connu pour ce sujet, ou `null`. */
function dernierEchec(connectorId) {
  try {
    const ligne = db
      .get()
      .prepare('SELECT reason, at FROM logo_failures WHERE connector_id = ?')
      .get(String(connectorId));
    return ligne ? { reason: ligne.reason, at: ligne.at } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Récupération
// ---------------------------------------------------------------------------

/** Ce que ce module emprunte au monde extérieur. Remplacé en test. */
function defaultRuntime() {
  return {
    fetch: (url, options) => globalThis.fetch(url, options),
    now: () => Date.now(),
    /**
     * crabe a-t-il le droit de sortir vers un site de fournisseur ?
     *
     * Le même interrupteur que pour le scraping : `CRABE_DISABLE_SCRAPING=1`
     * coupe TOUTE sortie, logos compris. Injectable, parce que les tests de la
     * cascade doivent pouvoir l'exercer contre un réseau simulé — et parce
     * qu'un test qui oublierait ce double partirait vraiment chez Free.
     */
    sortiesAutorisees: () => !require('../config').config.scrapingDisabled,
  };
}

/**
 * Récupère une adresse, avec un délai court et une taille bornée.
 *
 * `redirect: 'follow'` est laissé actif — un `/favicon.ico` redirige souvent —
 * mais l'adresse FINALE est revérifiée par l'appelant : une redirection vers
 * un tiers ne doit pas contourner le contrôle de provenance.
 */
async function recuperer(runtime, url, { texte = false } = {}) {
  const abandon = new AbortController();
  const minuteur = setTimeout(() => abandon.abort(), DELAI_MS);
  try {
    const reponse = await runtime.fetch(url, {
      signal: abandon.signal,
      redirect: 'follow',
      headers: {
        // Se présenter honnêtement : crabe n'a aucune raison de se déguiser.
        'User-Agent': 'crabe/1.0 (+logo de service, auto-hébergé)',
        Accept: texte ? 'text/html,application/json;q=0.9,*/*;q=0.5' : 'image/*,*/*;q=0.5',
      },
    });
    if (!reponse?.ok) {
      return { ok: false, statut: reponse?.status ?? 0, raison: `réponse HTTP ${reponse?.status ?? '?'}` };
    }

    const finale = reponse.url || url;
    if (texte) {
      const contenu = await reponse.text();
      return { ok: true, texte: contenu.slice(0, 400_000), url: finale };
    }

    const buffer = Buffer.from(await reponse.arrayBuffer());
    return { ok: true, buffer, url: finale };
  } catch (err) {
    return {
      ok: false,
      raison: err?.name === 'AbortError' ? 'site injoignable (délai dépassé)' : 'site injoignable',
    };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Récupère le logo d'un connecteur chez son fournisseur.
 *
 * Ne lève jamais : un échec est une information, pas un incident. La raison
 * est écrite pour un humain (« site injoignable », « aucune image trouvée »),
 * parce que c'est elle qui s'affiche dans le compte rendu.
 *
 * @param {object} manifest le manifeste du connecteur (`id` et `site`)
 * @param {object} [runtime]
 * @returns {Promise<{ok: boolean, raison?: string, origin?: string, ext?: string}>}
 */
async function recupererPour(manifest, runtime = defaultRuntime()) {
  const id = manifest?.id;
  if (!identifiantValide(id)) return { ok: false, raison: 'identifiant de connecteur invalide' };

  if (runtime.sortiesAutorisees && !runtime.sortiesAutorisees()) {
    return {
      ok: false,
      raison:
        'les sorties vers les sites de fournisseurs sont désactivées sur cette installation '
        + '(CRABE_DISABLE_SCRAPING=1)',
    };
  }

  const adresse = adresseDuManifeste(manifest);
  if (!adresse) {
    return {
      ok: false,
      raison: 'aucune adresse de site déclarée dans le manifeste de ce connecteur',
      details: [
        'ni « site », ni « urls.login », ni « urls.orders », ni « remoteLogin.url » : '
          + 'il n\'y a aucune adresse à interroger, et crabe ne cherche JAMAIS par le nom.',
      ],
    };
  }

  const base = adresse.url;
  if (hoteSuspect(base.toString())) {
    return {
      ok: false,
      raison: 'le site déclaré n\'est pas une adresse publique',
      details: [`${base} (source : ${adresse.source})`],
    };
  }

  const limite = runtime.now() + BUDGET_MS;
  const notes = [];
  let accueil = await recuperer(runtime, base.toString(), { texte: true });

  // ─── Le 403 anti-robot (lot 14, §10) ──────────────────────────────────────
  //
  // Propolia répond « 403 » à une requête HTTP simple : c'est une protection
  // anti-robot, pas une absence de logo. Le même site s'ouvre parfaitement
  // dans le Chromium que crabe fait déjà tourner pour les connecteurs — il
  // exécute le JavaScript et présente une empreinte de vrai navigateur.
  //
  // On n'y va QU'APRÈS un refus, et seulement pour un refus qui ressemble à
  // une protection : ouvrir un navigateur pèse une seconde et 300 Mo, et ce
  // serait absurde de le payer sur les douze sites qui répondent très bien.
  if (!accueil.ok && ressembleAUneProtection(accueil)) {
    notes.push(`${accueil.raison} en HTTP simple — seconde tentative par navigateur`);
    const parNavigateur = await recupererParNavigateur(runtime, base.toString());
    if (parNavigateur.ok) {
      accueil = parNavigateur;
      notes.push('page d\'accueil obtenue par le navigateur');
    } else {
      notes.push(`navigateur : ${parNavigateur.raison}`);
    }
  }

  if (!accueil.ok) {
    // Même sans page d'accueil lisible, /favicon.ico mérite une tentative.
    const secours = await essayerCandidats(
      runtime,
      [{ url: resoudre('/favicon.ico', base.toString()), source: 'favicon', taille: 0 }],
      base.toString(),
      id,
      limite
    );
    if (secours.ok) return { ...secours, base: base.toString(), source: adresse.source };
    return {
      ok: false,
      raison: accueil.raison,
      base: base.toString(),
      source: adresse.source,
      // L'adresse interrogée ET la raison : sans les deux, un échec de logo ne
      // se diagnostique pas — on ne sait même pas où crabe est allé frapper.
      details: [
        `page d'accueil ${base} (d'après ${adresse.source}) : ${accueil.raison}`,
        ...notes,
        ...(secours.details || []),
      ],
    };
  }

  const candidats = candidatsDepuisPage(accueil.texte, accueil.url || base.toString());
  const resultat = await essayerCandidats(runtime, candidats, base.toString(), id, limite);
  return {
    ...resultat,
    base: base.toString(),
    source: adresse.source,
    details: [
      `adresse interrogée : ${base} (d'après ${adresse.source})`,
      ...notes,
      ...(resultat.details || []),
    ],
  };
}

/**
 * Ce refus ressemble-t-il à une protection anti-robot ?
 *
 * `403` et `401` sont les deux réponses des pare-feux applicatifs, `429` celle
 * d'une limitation de débit. Un `404` n'en est pas une : la page n'existe pas,
 * et un navigateur n'y changera rien.
 */
function ressembleAUneProtection(reponse) {
  return [401, 403, 429].includes(Number(reponse?.statut));
}

/**
 * Récupère une page d'accueil avec le navigateur, quand HTTP simple est refusé.
 *
 * Le MÊME `browser-identity` que les connecteurs : agent utilisateur réaliste,
 * en-têtes cohérents. C'est déjà ce qui fait la différence entre un 403 et un
 * 200 sur Fantazia (vérifié le 11/08/2026), et il n'y a aucune raison d'avoir
 * deux identités selon qu'on cherche une facture ou une image.
 *
 * Ne lève jamais : sans Playwright, sans mémoire ou sur un site qui ne répond
 * pas davantage, l'appelant retombe sur la cascade de secours.
 */
async function recupererParNavigateur(runtime, url) {
  let playwright;
  try {
    playwright = runtime.playwright ? runtime.playwright() : require('playwright');
  } catch {
    return { ok: false, raison: 'Playwright n\'est pas installé sur cette machine' };
  }
  if (!playwright?.chromium) return { ok: false, raison: 'navigateur indisponible' };

  const identity = require('./browser-identity');
  let navigateur = null;
  try {
    navigateur = await playwright.chromium.launch({ headless: true });
    const contexte = await navigateur.newContext(identity.optionsContexte());
    const page = await contexte.newPage();
    page.setDefaultTimeout(DELAI_NAVIGATEUR_MS);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const texte = await page.content();
    return { ok: true, texte: String(texte).slice(0, 400_000), url: page.url() };
  } catch (err) {
    return { ok: false, raison: `le navigateur n'a pas pu ouvrir la page (${err.message})` };
  } finally {
    await navigateur?.close?.().catch(() => {});
  }
}

/** Patience du navigateur de secours : une page d'accueil, pas un parcours. */
const DELAI_NAVIGATEUR_MS = 15_000;

/**
 * Parcourt la cascade et s'arrête au premier candidat correct.
 *
 * Chaque étape peut échouer sans conséquence : c'est le principe même d'une
 * cascade, et c'est ce qui permet de rester strict sur chaque contrôle plutôt
 * que d'accepter n'importe quoi de peur de repartir les mains vides.
 */
async function essayerCandidats(runtime, candidats, base, id, limite) {
  const raisons = [];

  for (const candidat of candidats) {
    if (!candidat?.url) continue;
    if (runtime.now() > limite) {
      raisons.push('délai dépassé');
      break;
    }
    if (!memeFournisseur(candidat.url, base)) {
      // Le point entier du lot : jamais chez un tiers.
      raisons.push(`${candidat.source} hébergée hors du site du fournisseur`);
      continue;
    }

    // Le manifeste web n'est pas une image : il faut d'abord le lire.
    if (candidat.source === 'manifest' && !/\.(png|jpe?g|webp|ico|svg)$/i.test(candidat.url)) {
      const reponse = await recuperer(runtime, candidat.url, { texte: true });
      if (!reponse.ok) {
        raisons.push(`manifeste web : ${reponse.raison}`);
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(reponse.texte);
      } catch {
        raisons.push('manifeste web illisible');
        continue;
      }
      const issus = candidatsDepuisManifesteWeb(json, reponse.url || candidat.url);
      const trouve = await essayerCandidats(runtime, issus, base, id, limite);
      if (trouve.ok) return trouve;
      raisons.push(...(trouve.details || []));
      continue;
    }

    const reponse = await recuperer(runtime, candidat.url);
    if (!reponse.ok) {
      raisons.push(`${candidat.source} : ${reponse.raison}`);
      continue;
    }
    // Une redirection ne doit pas faire sortir du domaine du fournisseur.
    if (!memeFournisseur(reponse.url || candidat.url, base)) {
      raisons.push(`${candidat.source} redirigée hors du site du fournisseur`);
      continue;
    }

    const analyse = analyserImage(reponse.buffer, { source: candidat.source });
    if (!analyse.ok) {
      raisons.push(`${candidat.source} : ${analyse.raison}`);
      continue;
    }

    enregistrer(id, reponse.buffer, {
      ext: analyse.ext,
      source: 'fetched',
      origin: candidat.url,
      width: analyse.width,
      height: analyse.height,
    });
    return {
      ok: true,
      origin: candidat.url,
      ext: analyse.ext,
      width: analyse.width,
      height: analyse.height,
    };
  }

  return {
    ok: false,
    // Une raison lisible d'abord, le détail ensuite pour le journal.
    raison: raisons.length ? 'aucune image utilisable trouvée sur le site' : 'aucune image trouvée',
    details: raisons,
  };
}

/**
 * Enregistre une image envoyée à la main par un administrateur.
 *
 * Elle prime sur toute récupération automatique et n'est JAMAIS écrasée par une
 * resynchronisation : c'est le dernier mot de quelqu'un qui a regardé le
 * résultat, et une cascade n'a pas à revenir dessus.
 *
 * @param {string} connectorId
 * @param {Buffer} buffer
 * @returns {{ok: boolean, raison?: string}}
 */
function enregistrerManuel(connectorId, buffer) {
  const analyse = analyserImage(buffer);
  if (!analyse.ok) return { ok: false, raison: analyse.raison };
  enregistrer(connectorId, buffer, {
    ext: analyse.ext,
    source: 'manual',
    origin: null,
    width: analyse.width,
    height: analyse.height,
  });
  // Une image envoyée à la main répond à l'échec précédent : il n'est plus vrai.
  oublierEchec(connectorId);
  return { ok: true, ext: analyse.ext, width: analyse.width, height: analyse.height };
}

/** « data:image/png;base64,… » → un Buffer, ou `null` si ce n'en est pas une. */
function depuisDataUrl(valeur) {
  const trouve = /^data:([\w/+.-]+)?;base64,([\s\S]+)$/i.exec(String(valeur || '').trim());
  if (!trouve) return null;
  try {
    return Buffer.from(trouve[2], 'base64');
  } catch {
    return null;
  }
}

module.exports = {
  PREFIXE_DESTINATION,
  idDeDestination,
  destinationDeId,
  sujets,
  sujet,
  TAILLE_MAX,
  COTE_MIN,
  COTE_MAX,
  OG_RAPPORT_MAX,
  OG_COTE_MAX,
  DELAI_MS,
  TYPES_PAR_EXT,
  // analyse
  reconnaitreImage,
  analyserImage,
  // cascade
  urlDuSite,
  adresseDuManifeste,
  memeFournisseur,
  hoteSuspect,
  candidatsDepuisPage,
  logosDEnTete,
  MOTIF_LOGO_TIERS,
  CHEMINS_CONVENTIONNELS,
  ressembleAUneProtection,
  candidatsDepuisManifesteWeb,
  // stockage
  dossier,
  lire,
  chemin,
  publicUrl,
  tousLesUrls,
  enregistrer,
  enregistrerManuel,
  supprimer,
  depuisDataUrl,
  noterEchec,
  oublierEchec,
  dernierEchec,
  // récupération
  defaultRuntime,
  recupererPour,
};
