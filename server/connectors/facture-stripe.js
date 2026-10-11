'use strict';

/**
 * Les factures hébergées par Stripe — identité stable et numéro de facture.
 *
 * ─── La panne que ce module corrige (lot 32, 14/08/2026) ─────────────────────
 *
 * Les consoles d'Anthropic et de Mistral lient leurs factures vers
 * `invoice.stripe.com/i/<compte>/<jeton>`. Le lot 31 a montré que ce jeton est
 * un JETON D'ACCÈS : l'URL du PDF se reconstruit depuis lui, sans session.
 * Et pourtant il finissait tel quel dans `remote_id` ET dans le nom du fichier
 * déposé — un secret de 130 caractères, copié sur le stockage local et sur toute
 * destination que l'utilisateur ajoutera.
 *
 * Pire : ce jeton n'est même pas un identifiant. Sa structure, mesurée sur
 * cinq chargements de la même facture (run_logs des 13–14/08/2026) :
 *
 *     live_ + base64("compte,secret,horodatage") + "0200" + 8 car. de signature
 *
 * L'horodatage et la signature changent À CHAQUE RENDU de la page ; seul le
 * couple `compte,secret` est stable. Autrement dit, un `remote_id` bâti sur le
 * jeton entier ne reconnaît jamais rien : au passage suivant, les 11 factures
 * redescendent en se croyant nouvelles, sous 11 nouveaux noms — le nom portant
 * lui aussi le jeton, même la clé d'unicité `(user, connecteur, fichier)` ne
 * s'y opposait pas.
 *
 * ─── Ce que ce module fournit ────────────────────────────────────────────────
 *
 * 1. `referenceStable(url)` : une EMPREINTE (SHA-256 tronqué à 12 hexadécimaux)
 *    du couple stable `compte,secret`. Calculable au moment du listage,
 *    identique d'un chargement à l'autre, et NON SECRÈTE : une empreinte ne se
 *    remonte pas vers le secret, elle ne permet de reconstruire aucune URL.
 *    C'est elle qui sert de `remote_id`.
 *
 * 2. `analyserPdf(buffer)` : le numéro de facture (« CJV04PWS-0013 ») et la
 *    date d'émission, lus DANS le PDF téléchargé. C'est la seule source que la
 *    mesure a validée : la page de facturation de claude.ai n'a pas pu être
 *    relue le jour de l'écriture (garde Cloudflare intermittente), et la date
 *    qu'elle affiche n'est de toute façon pas fiable — pour 4 factures sur 11,
 *    la ligne montrait la date de PAIEMENT (13/08) quand le document porte
 *    « Date of issue: May 9, 2026 ». Le document fait foi.
 *
 * Le module est PUR : Buffer, zlib, crypto — rien d'autre. C'est ce qui le
 * rend testable sans navigateur et sans réseau.
 */

const zlib = require('node:zlib');
const nodeCrypto = require('node:crypto');

/** Une page de facture hébergée par Stripe, telle que les consoles la lient. */
const MOTIF_PAGE_FACTURE = /^https:\/\/invoice\.stripe\.com\/i\/(acct_[^/?#]+)\/([^/?#]+)/i;

/** L'URL donnée est-elle une page de facture Stripe ? */
function estPageFactureStripe(url) {
  return MOTIF_PAGE_FACTURE.test(String(url ?? ''));
}

/**
 * L'empreinte de la partie STABLE d'un jeton Stripe, ou `null`.
 *
 * Le jeton se décode par blocs base64 de quatre caractères — c'est exactement
 * équivalent à décoder la chaîne entière, et ça tolère la fin du jeton
 * (« 0200 » + signature) qui, elle, n'est pas du base64 aligné. On s'arrête au
 * premier bloc illisible : tout ce qui compte (compte et secret, séparés par
 * des virgules) est passé avant.
 *
 * ⚠ Douze hexadécimaux, pas moins : c'est assez pour ne jamais confondre deux
 * factures d'un même compte (48 bits), et rien d'utilisable pour qui voudrait
 * remonter au secret — il faudrait inverser SHA-256.
 */
function empreinteDuJeton(jeton) {
  const brut = String(jeton ?? '').replace(/^(live|test)_/i, '');
  if (!brut) return null;

  let clair = '';
  for (let i = 0; i + 4 <= brut.length; i += 4) {
    const bloc = brut.slice(i, i + 4);
    if (!/^[A-Za-z0-9+/]{4}$/.test(bloc)) break;
    clair += Buffer.from(bloc, 'base64').toString('latin1');
  }

  const morceaux = clair.split(',');
  // Sans les deux premiers morceaux (compte, secret), ce jeton n'a pas la
  // structure mesurée : on ne fabrique pas d'identifiant sur une supposition.
  if (morceaux.length < 2 || !morceaux[0] || !morceaux[1]) return null;

  return nodeCrypto
    .createHash('sha256')
    .update(`${morceaux[0]},${morceaux[1]}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * La référence STABLE d'un lien de facture Stripe, ou `null` si ce lien n'en
 * est pas une. C'est elle qui doit servir de `remote_id` — jamais le jeton.
 */
function referenceStable(url) {
  const trouve = MOTIF_PAGE_FACTURE.exec(String(url ?? ''));
  if (!trouve) return null;
  return empreinteDuJeton(trouve[2]);
}

// ---------------------------------------------------------------------------
// Lecture du PDF — numéro de facture et date d'émission
// ---------------------------------------------------------------------------

/**
 * Les flux dégonflés d'un PDF.
 *
 * On ne « parse » pas le PDF : on repère chaque paire `stream`/`endstream` et
 * on tente `inflate` dessus. Un flux qui n'est pas compressé Flate échoue en
 * silence — les PDF de Stripe compressent tout ce qui nous intéresse (les
 * tables ToUnicode et le contenu des pages).
 */
function fluxDegonfles(buffer) {
  const flux = [];
  let i = 0;
  for (;;) {
    const debut = buffer.indexOf('stream', i);
    if (debut < 0) break;
    let donnees = debut + 6;
    if (buffer[donnees] === 0x0d) donnees++;
    if (buffer[donnees] === 0x0a) donnees++;
    const fin = buffer.indexOf('endstream', donnees);
    if (fin < 0) break;
    try {
      flux.push(zlib.inflateSync(buffer.subarray(donnees, fin)).toString('latin1'));
    } catch {
      /* flux non compressé ou abîmé : il ne portait pas notre texte */
    }
    i = fin + 9;
  }
  return flux;
}

/**
 * Le texte d'un PDF Stripe, reconstruit via ses tables ToUnicode.
 *
 * Ces PDF n'écrivent pas leur texte en clair : chaque lettre est un numéro de
 * glyphe d'une police à sous-ensemble, et la correspondance glyphe → caractère
 * vit dans des tables `bfchar`/`bfrange` (marquées « Adobe UCS »). On fusionne
 * toutes les tables du document puis on décode les chaînes hexadécimales des
 * opérateurs de texte (`Tj`/`TJ`).
 *
 * Le résultat est COMPACT : sans espaces (chaque glyphe est un opérateur
 * séparé, l'espace entre mots n'existe pas dans le flux), et les glyphes sans
 * correspondance sortent en U+0000. Les extracteurs d'en dessous travaillent
 * avec ces deux particularités au lieu de les nier.
 */
function texteCompactDuPdf(buffer) {
  const flux = fluxDegonfles(buffer);

  const table = new Map();
  for (const f of flux) {
    for (const bloc of f.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const paire of bloc[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        let caractere = '';
        for (let k = 0; k + 4 <= paire[2].length; k += 4) {
          caractere += String.fromCharCode(parseInt(paire[2].slice(k, k + 4), 16));
        }
        table.set(paire[1].toLowerCase().padStart(4, '0'), caractere);
      }
    }
    for (const bloc of f.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const t of bloc[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const de = parseInt(t[1], 16);
        const a = parseInt(t[2], 16);
        const base = parseInt(t[3].slice(-4), 16);
        // Borne large mais finie : une table qui prétend couvrir des milliers
        // de glyphes d'un coup est une table qu'on ne veut pas matérialiser.
        for (let c = de; c <= a && c - de < 512; c++) {
          table.set(c.toString(16).padStart(4, '0'), String.fromCharCode(base + (c - de)));
        }
      }
    }
  }
  if (!table.size) return '';

  const morceaux = [];
  for (const f of flux) {
    if (!/T[Jj]/.test(f)) continue;
    for (const m of f.matchAll(/<([0-9a-fA-F]+)>\s*Tj|\[((?:<[0-9a-fA-F]+>|[^\]])*)\]\s*TJ/g)) {
      const hexas = m[1] ? [m[1]] : [...(m[2] || '').matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
      for (const h of hexas) {
        for (let k = 0; k + 4 <= h.length; k += 4) {
          morceaux.push(table.get(h.slice(k, k + 4).toLowerCase()) ?? '');
        }
      }
    }
  }
  return morceaux.join('');
}

/**
 * Numéro de facture et date d'émission d'un PDF Stripe.
 *
 * @param {Buffer} buffer le PDF téléchargé
 * @returns {{numero: string|null, dateEmission: string|null}}
 *
 * `numero` : ce que Stripe imprime après « Invoice number » / « Numéro de
 * facture » — la référence que l'utilisateur retrouvera sur le document
 * lui-même, donc la seule qui mérite le nom de fichier. Le tiret du numéro
 * sort parfois en U+0000 (glyphe sans correspondance dans la table du
 * sous-ensemble) : on le rétablit au lieu d'échouer dessus.
 *
 * `dateEmission` : « Date of issue » / « Date d'émission », en ISO. La page de
 * la console peut afficher une autre date (celle du paiement) ; celle-ci est
 * celle du document.
 */
function analyserPdf(buffer) {
  let texte = '';
  try {
    texte = texteCompactDuPdf(buffer);
  } catch {
    return { numero: null, dateEmission: null };
  }
  if (!texte) return { numero: null, dateEmission: null };

  // NFC d'abord : le PDF de la facturation Mistral (Lago) livre son texte en
  // forme DÉCOMPOSÉE — « é » y est un « e » suivi d'un accent combinant — et
  // « Date d'émission 12 févr. 2026 » échappait à `[ée]mission` sans que rien
  // ne le dise. Mesuré le 19/08/2026 sur une facture réelle, en production.
  const compact = texte.normalize('NFC').replace(/\s+/g, '');

  const numeroBrut =
    /(?:Invoicenumber|Num[ée]rodefacture)[:\s]*([A-Z0-9]{4,12})[-\x00]?(\d{3,5})/i.exec(compact);
  const numero = numeroBrut ? `${numeroBrut[1]}-${numeroBrut[2]}` : null;

  // « DateofissueAugust13,2026 » ou « Dated'émission13août2026 » : on réinsère
  // les espaces que le flux ne porte pas, puis le lecteur de dates commun
  // (documents-de-page) fait le travail dans les deux langues.
  const dateBrute =
    // Corps borné à {2,24} : « 9mai2026 » ne met que quatre caractères avant
    // l'année, un minimum plus exigeant l'aurait laissé passer sans date.
    /(?:Dateofissue|Dated.?[ée]mission)[:\s]*([\p{L}\d,.\x00]{2,24}?(?:19|20)\d{2})/iu.exec(compact);
  let dateEmission = null;
  if (dateBrute) {
    const lisible = dateBrute[1]
      .replace(/\x00/g, ' ')
      .replace(/(\d)(\p{L})/gu, '$1 $2')
      .replace(/(\p{L})(\d)/gu, '$1 $2')
      // Le point d'une abréviation de mois colle à l'année dans le flux
      // (« 12févr.2026 ») : sans espace après lui, le lecteur de dates ne
      // reconnaît ni « févr. 2026 » ni le jour qui précède. Même mesure du
      // 19/08/2026 que la normalisation NFC ci-dessus.
      .replace(/\.(?=\d)/g, '. ')
      .replace(/,/g, ', ');
    dateEmission = require('./documents-de-page').dateDepuisTexte(lisible);
  }

  return { numero, dateEmission };
}

module.exports = {
  estPageFactureStripe,
  empreinteDuJeton,
  referenceStable,
  analyserPdf,
  // exportés pour les tests
  fluxDegonfles,
  texteCompactDuPdf,
};
