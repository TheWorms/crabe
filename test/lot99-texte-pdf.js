'use strict';

/**
 * Lot 99 — relire le TEXTE d'un PDF rendu par Chromium, sans dépendance.
 *
 * ─── Pourquoi ce n'est pas `buffer.includes('Facture')` ──────────────────────
 *
 * Chromium n'écrit pas le texte en clair : il embarque une découpe de chaque
 * police et remplace chaque caractère par son numéro de glyphe (mémoire du
 * lot 19). Mais chaque police embarquée porte aussi sa table `ToUnicode` —
 * celle que lisent les lecteurs de PDF pour copier-coller. On la relit ici :
 * flux inflatés, `beginbfchar`/`beginbfrange`, puis chaque chaîne
 * hexadécimale des opérateurs `Tj` et `TJ` traduite glyphe par glyphe.
 *
 * ─── Calibré sur un fichier sain ET un fichier cassé (A4 du lot 99) ──────────
 *
 * Une page en `windows-1252` rendue au vrai Chromium : servie sans `charset`
 * (la balise `<meta>` décide), ce lecteur rend « Désignation » et « 0,00 € »,
 * comme `pdftotext` ; servie avec `charset=utf-8` (l'en-tête l'emporte, les
 * octets sont mal lus), il rend U+FFFD aux mêmes places, comme `pdftotext`.
 * C'est cette différence que les essais regardent.
 *
 * Le texte rendu n'a pas d'espaces fiables entre les mots ni de retours à la
 * ligne : un mot peut être coupé en deux opérateurs (« Factur » + « e ») par
 * l'approche. `texteDuPdf(…, { colle: true })` rend tout bout à bout.
 */

const zlib = require('node:zlib');

/** Les flux d'un PDF, inflatés quand ils sont compressés. */
function flux(octets) {
  const texte = octets.toString('latin1');
  const sortie = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(texte))) {
    const debut = m.index + m[0].length;
    const dico = m[1];
    const longueur = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dico);
    const fin = longueur ? debut + Number(longueur[1]) : texte.indexOf('endstream', debut);
    let brut = octets.subarray(debut, fin);
    if (/\/FlateDecode/.test(dico)) {
      try {
        brut = zlib.inflateSync(brut);
      } catch {
        continue;
      }
    }
    sortie.push(brut.toString('latin1'));
  }
  return sortie;
}

/** Une chaîne hexadécimale UTF-16BE, en texte. */
function utf16(hex) {
  let t = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) t += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return t;
}

/** La table glyphe → texte, de toutes les CMaps `ToUnicode` du fichier. */
function tablesToUnicode(lesFlux) {
  const table = new Map();
  for (const f of lesFlux) {
    if (!/begincmap/.test(f)) continue;
    for (const bloc of f.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
      for (const p of bloc[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        table.set(p[1].toUpperCase(), utf16(p[2]));
      }
    }
    for (const bloc of f.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
      for (const p of bloc[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const de = Number.parseInt(p[1], 16);
        const a = Number.parseInt(p[2], 16);
        const premier = Number.parseInt(p[3], 16);
        for (let g = de; g <= a; g++) {
          table.set(g.toString(16).toUpperCase().padStart(p[1].length, '0'), String.fromCodePoint(premier + g - de));
        }
      }
    }
  }
  return table;
}

/**
 * Le texte d'un PDF de Chromium. Un glyphe sans correspondance devient U+FFFD.
 *
 * @param {Buffer} octets
 * @param {{colle?: boolean}} [options] `colle` : sans retours à la ligne
 * @returns {string}
 */
function texteDuPdf(octets, { colle = false } = {}) {
  const lesFlux = flux(Buffer.from(octets));
  const table = tablesToUnicode(lesFlux);
  const morceaux = [];
  for (const f of lesFlux) {
    if (/begincmap/.test(f)) continue;
    for (const m of f.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hexes = m[1] !== undefined ? [...m[1].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]) : [m[2]];
      let ligne = '';
      for (const h of hexes) {
        for (let i = 0; i + 4 <= h.length; i += 4) ligne += table.get(h.slice(i, i + 4).toUpperCase()) ?? '�';
      }
      morceaux.push(ligne);
    }
  }
  return morceaux.join(colle ? '' : '\n');
}

module.exports = { texteDuPdf };
