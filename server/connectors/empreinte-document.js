'use strict';

/**
 * L'empreinte d'un document — celle qui sert d'identifiant distant quand le
 * fournisseur n'en donne aucun.
 *
 * ─── Le défaut mesuré, et pourquoi le hachage des octets bruts ne suffit pas ──
 *
 * SNCF Connect ne sert pas un fichier ARCHIVÉ : il REGÉNÈRE le justificatif à
 * chaque téléchargement. Deux passages du connecteur, le 19/08/2026 à 23:28 et
 * le 20/08/2026 à 00:13, ont donc écrit 6 lignes pour 3 documents — six md5
 * différents pour trois justificatifs identiques, six fichiers sur le NFS, et
 * autant dans chacune des deux destinations cloud. Rien n'écrasait rien :
 * l'identifiant distant, dérivé du hachage des octets, changeait à chaque fois.
 *
 * Ce que la comparaison octet à octet des deux versions d'un même justificatif
 * a montré (paire de 24950 octets, mesure du 20/08/2026) : **68 octets
 * divergent sur 24950**, soit 0,27 %, répartis en 12 plages — et toutes
 * tombent dans TROIS champs, aucun autre :
 *
 *   - `/CreationDate(D:20260820012437+02'00')` — la date de génération du
 *     dictionnaire Info ;
 *   - `<xmp:CreateDate>2026-08-20T01:24:37+02:00</xmp:CreateDate>` — la même
 *     date, dans les métadonnées XMP ;
 *   - `/ID [<9bbd…><9bbd…>]` — l'identifiant de document du trailer.
 *
 * Tout le reste — le contenu du voyage, les polices, les flux compressés,
 * jusqu'au flux d'objets — est IDENTIQUE d'un passage à l'autre. Le document
 * est donc parfaitement stable : c'est son enveloppe qui est datée.
 *
 * D'où la règle de ce module : on efface les champs qui datent et qui
 * numérotent, et on hache ce qui reste. Vérifié sur les trois paires de production :
 * après normalisation, les deux versions d'un même justificatif sont
 * **identiques octet à octet** (24780/24780, 24765/24765, 24783/24783), et les
 * trois documents distincts gardent trois empreintes distinctes.
 *
 * ─── Ce que ce module ne fait PAS ────────────────────────────────────────────
 *
 * Il n'extrait pas le texte et ne lit pas les métadonnées de voyage. Une
 * empreinte tirée du texte d'un PDF dépend d'un décodeur de polices, donc
 * d'une bibliothèque, donc d'une version : elle bougerait sans que le document
 * bouge. Retirer trois champs nommés et hacher le reste ne dépend de rien
 * d'autre que du fichier — et se vérifie en comparant deux fichiers réels.
 *
 * Il ne convient QU'aux documents régénérés à l'identique. Un fournisseur qui
 * change la mise en page, ou qui tamponne la date du jour DANS la page, rendra
 * une empreinte différente : le document sera récupéré une seconde fois. C'est
 * le défaut d'aujourd'hui, pas un défaut nouveau — et c'est le seul sens dans
 * lequel se tromper est rattrapable. L'inverse — une empreinte trop large, qui
 * confondrait deux documents différents — ferait disparaître une facture sans
 * que personne ne le voie. C'est pourquoi la normalisation ne retire que des
 * champs NOMMÉS, jamais des plages devinées, et pourquoi elle s'efface
 * elle-même si elle en retire trop (voir `PART_VOLATILE_MAX`).
 */

const crypto = require('node:crypto');

/**
 * Les champs qu'un générateur de PDF redate ou renumérote à chaque exécution.
 * Chaque motif est BORNÉ — `[^)]`, `[^<]`, une liste de chaînes hexadécimales —
 * pour qu'aucun ne puisse déborder sur le contenu du document.
 */
const CHAMPS_VOLATILS = [
  // Dictionnaire Info : `/CreationDate(D:20260820012437+02'00')`, `/ModDate(…)`.
  /\/(?:CreationDate|ModDate)\s*\([^)]*\)/g,
  // Trailer / flux XRef : `/ID [<9bbd…><9bbd…>]`. Le `[` obligatoire après le
  // nom évite d'attraper une clé qui commencerait par les mêmes lettres.
  /\/ID\s*\[(?:\s*<[0-9a-fA-F]*>\s*)*\]/g,
  // XMP : les trois dates d'enveloppe, dans l'un ou l'autre préfixe historique.
  /<(?:xmp|xap):CreateDate>[^<]*<\/(?:xmp|xap):CreateDate>/g,
  /<(?:xmp|xap):ModifyDate>[^<]*<\/(?:xmp|xap):ModifyDate>/g,
  /<(?:xmp|xap):MetadataDate>[^<]*<\/(?:xmp|xap):MetadataDate>/g,
  // XMP : les identifiants d'exemplaire, quand le générateur en pose.
  /<(?:xmpMM|xapMM):DocumentID>[^<]*<\/(?:xmpMM|xapMM):DocumentID>/g,
  /<(?:xmpMM|xapMM):InstanceID>[^<]*<\/(?:xmpMM|xapMM):InstanceID>/g,
];

/**
 * Part du document qu'une normalisation ne doit JAMAIS dépasser.
 *
 * Mesuré sur les justificatifs SNCF : 170 octets retirés sur 24950, soit
 * 0,68 %. Le plafond est fixé très au-dessus (5 %) : il ne discute pas les
 * mesures normales, il n'attrape qu'un emballement — un motif qui, sur un PDF
 * d'une forme non rencontrée, mangerait du contenu et ferait se confondre deux
 * documents différents. Dans ce cas la normalisation s'annule et l'empreinte
 * repart des octets bruts : on retombe sur le doublon, jamais sur la perte.
 */
const PART_VOLATILE_MAX = 0.05;

/** Les cinq octets qui ouvrent un PDF. */
function estPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5
    && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Le document débarrassé de ce qui change sans qu'il change : dates de
 * génération et identifiants d'exemplaire.
 *
 * Rend le buffer d'origine, inchangé, si ce n'est pas un PDF ou si la
 * normalisation en retirait plus que `PART_VOLATILE_MAX`.
 *
 * @param {Buffer} buffer le document tel qu'il a été reçu
 * @returns {{octets: Buffer, retire: number, normalise: boolean}}
 *   `retire` = nombre d'octets ôtés, `normalise` = faux si on a rendu le brut
 */
function normaliserPdf(buffer) {
  if (!estPdf(buffer)) return { octets: buffer, retire: 0, normalise: false };

  // `latin1` fait l'aller-retour octet pour octet : un PDF est un binaire, il
  // ne se relit pas en UTF-8 sans se faire abîmer.
  let texte = buffer.toString('latin1');
  for (const motif of CHAMPS_VOLATILS) texte = texte.replace(motif, '');
  const octets = Buffer.from(texte, 'latin1');

  const retire = buffer.length - octets.length;
  if (retire > buffer.length * PART_VOLATILE_MAX) {
    return { octets: buffer, retire: 0, normalise: false };
  }
  return { octets, retire, normalise: true };
}

/**
 * L'empreinte qui sert d'identifiant distant : stable d'une exécution à
 * l'autre pour un même document, distincte pour deux documents différents.
 *
 * @param {Buffer} buffer le document reçu
 * @param {{prefixe?: string, longueur?: number}} [options]
 * @returns {string} par exemple `sncf-connect-04d457aac9244f1e`
 */
function empreinteStable(buffer, { prefixe = '', longueur = 16 } = {}) {
  const { octets } = normaliserPdf(buffer);
  const somme = crypto.createHash('sha256').update(octets).digest('hex').slice(0, longueur);
  return prefixe ? `${prefixe}-${somme}` : somme;
}

module.exports = {
  estPdf,
  normaliserPdf,
  empreinteStable,
  CHAMPS_VOLATILS,
  PART_VOLATILE_MAX,
};
