'use strict';

/**
 * Ce qu'ÉTAIT un document refusé faute d'être un PDF — pour le journal, et pour
 * lui seul (lot 95).
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Le 06/10/2026, le passage n° 708 de Gandi a écrit trois fois « le document a
 * rendu ##### octets qui ne sont pas un PDF » : le journal disait le refus,
 * jamais ce qui était arrivé à la place. Il a fallu les sondes de l'utilisateur, dans
 * son navigateur, pour apprendre que c'était une page web (`text/html`, sans
 * redirection). Les codes communs qui refusent un document parce qu'il ne
 * commence pas par `%PDF-` (`onglet-pdf`, `clic-document`) ajoutent désormais
 * ce constat à leur grief : la nature du document, son type déclaré, sa taille,
 * et la redirection quand elle est connue.
 *
 * ─── Ce que le constat ne dit JAMAIS ─────────────────────────────────────────
 *
 * L'adresse, un extrait du contenu, un nom de fichier. La nature se lit dans
 * les premiers octets mais ne les recopie pas ; le type déclaré n'est rendu que
 * s'il a la forme d'un type (`texte/sous-type`), sinon « illisible ».
 *
 * ─── Ce qu'il ne change pas ──────────────────────────────────────────────────
 *
 * Aucune décision : le document reste refusé, compté de même, et l'écran de
 * l'utilisateur ne reçoit jamais un grief. Le constat est écrit entre crochets
 * (`[reçu : …]`) pour que la sortie anticipée (`serie-echecs`) le retire avant
 * de comparer deux griefs : deux refus de même cause restent la même cause,
 * quelle que soit la nature de ce qui a été reçu.
 */

/** Les quatre natures, telles que le journal les écrit. */
const NATURES = Object.freeze({
  html: 'page web (HTML)',
  json: 'données JSON',
  vide: 'vide',
  autre: 'autre',
});

/** Au-delà, des blancs en tête ne disent plus rien : « autre ». */
const OCTETS_LUS_AU_PLUS = 4096;

/** Un constat, tel qu'il s'écrit dans un grief — et se retire avant comparaison. */
const MOTIF_CONSTAT = /\s*\[reçu : [^\]]*\]/g;

/**
 * La nature d'un document, d'après ses premiers octets non blancs : une page
 * web s'il commence par une balise (`<`), des données JSON par `{` ou `[`,
 * « vide » à 0 octet, « autre » sinon. Les blancs ASCII et la marque d'ordre
 * des octets UTF-8 sont sautés. Pure.
 *
 * @param {Buffer|Uint8Array|null|undefined} octets
 * @returns {'html'|'json'|'vide'|'autre'}
 */
function natureDesOctets(octets) {
  if (!octets || !octets.length) return 'vide';
  let i = 0;
  if (octets.length >= 3 && octets[0] === 0xef && octets[1] === 0xbb && octets[2] === 0xbf) i = 3;
  const fin = Math.min(octets.length, OCTETS_LUS_AU_PLUS);
  while (i < fin && (octets[i] === 0x20 || octets[i] === 0x09 || octets[i] === 0x0a
    || octets[i] === 0x0d || octets[i] === 0x0c)) i += 1;
  if (i >= fin) return 'autre';
  if (octets[i] === 0x3c) return 'html';
  if (octets[i] === 0x7b || octets[i] === 0x5b) return 'json';
  return 'autre';
}

/**
 * Le type déclaré (`Content-Type`) sans ses paramètres, en minuscules, s'il a
 * la forme d'un type ; sinon `null`. Pure.
 */
function typeDeclare(entete) {
  const type = String(entete ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(type) ? type : null;
}

/**
 * Le constat d'un document refusé, prêt à suivre un grief :
 * « [reçu : page web (HTML), type déclaré text/html, 84014 octets, sans redirection] ».
 *
 * @param {Buffer|Uint8Array|null} octets le début du document (sa nature)
 * @param {{taille?: number, type?: string|null, redirige?: boolean}} [connu]
 *   `taille` : la taille entière quand `octets` n'en est que le début ;
 *   `type` : l'en-tête `Content-Type` reçu — `undefined` s'il n'est pas connu
 *   (un téléchargement), `null` ou `''` s'il est absent de la réponse ;
 *   `redirige` : la redirection, quand elle est connue.
 * @returns {string}
 */
function constat(octets, { taille, type, redirige } = {}) {
  const nombre = Number.isFinite(taille) ? taille : (octets ? octets.length : 0);
  const morceaux = [NATURES[natureDesOctets(octets)]];
  if (type !== undefined) {
    const lu = typeDeclare(type);
    morceaux.push(type === null || type === '' ? 'aucun type déclaré' : lu ? `type déclaré ${lu}` : 'type déclaré illisible');
  }
  morceaux.push(`${nombre} ${nombre > 1 ? 'octets' : 'octet'}`);
  if (typeof redirige === 'boolean') morceaux.push(redirige ? 'après redirection' : 'sans redirection');
  return `[reçu : ${morceaux.join(', ')}]`;
}

/** Un grief sans son constat — ce que la sortie anticipée compare. Pure. */
function sansConstat(grief) {
  return String(grief ?? '').replace(MOTIF_CONSTAT, '');
}

module.exports = {
  natureDesOctets,
  typeDeclare,
  constat,
  sansConstat,
  NATURES,
  MOTIF_CONSTAT,
  OCTETS_LUS_AU_PLUS,
};
