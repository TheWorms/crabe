'use strict';

/**
 * L'identité MÉTIER d'un document de voyage — celle qui est imprimée sur la
 * page, et qui survit à la regénération du fichier.
 *
 * ─── Pourquoi l'empreinte du contenu ne suffit plus (mesure du 22/08/2026) ───
 *
 * Le lot 44 avait réglé le cas d'un PDF regénéré à l'IDENTIQUE : seule
 * l'enveloppe datée changeait (`/CreationDate`, XMP, `/ID`), on la retirait et
 * on hachait le reste (`connectors/empreinte-document.js`). Deux jours plus
 * tard, les deux services ont redéposé huit documents déjà en base — et cette
 * fois LA TAILLE MÊME des fichiers avait bougé. Les paires du 20 et du
 * 22/08/2026, rapatriées et comparées objet par objet :
 *
 *   - SNCF Connect tamponne la date d'édition DANS la page : « Paris, le
 *     20/08/2026 » devient « Paris, le 22/08/2026 ». C'est la seule ligne du
 *     texte qui change — mais elle vit dans un flux compressé, pas dans un
 *     champ nommé de l'enveloppe : aucun retrait borné ne peut l'atteindre.
 *   - OUIGO regénère le billet avec un NOM DE RESSOURCE ALÉATOIRE
 *     (`/476bcbf0…` → `/6e4b678d…`), présent jusque dans les flux compressés,
 *     plus un champ opaque `/Source (…)` et le `/ID` du trailer. Le texte
 *     extrait des deux versions est identique au caractère près ; les octets,
 *     jamais.
 *
 * L'empreinte du fichier est donc une impasse pour ces deux services :
 * l'identifiant doit venir de ce que le document DIT, pas de ce qu'il pèse.
 *
 * ─── Ce que la page expose de stable (les 18 fichiers réels de production) ───────────
 *
 * Vérifié sur les 8 justificatifs SNCF et les 10 billets OUIGO en production
 * le 22/08/2026 — chaque paire regénérée rend la même identité, chaque
 * document distinct la sienne :
 *
 *   - SNCF Connect imprime « Dossier voyage » suivi du code du dossier
 *     (six lettres/chiffres), et « votre commande e-billet du JJ/MM/AAAA » —
 *     la seule date COMPLÈTE et stable du document (les heures des trajets
 *     n'ont pas d'année, « Paris, le … » est la date d'édition, volatile).
 *     Un justificatif aller-retour porte deux fois le même dossier.
 *   - OUIGO imprime « Votre numéro de réservation est : » suivi de la
 *     référence (six lettres/chiffres), et le passager du billet sous la forme
 *     « PRÉNOM NOM - AAAA » (l'année de naissance). La référence seule ne
 *     suffit pas : une réservation à plusieurs voyageurs sert UN billet par
 *     passager, et les confondre ferait disparaître un billet sans bruit —
 *     la seule erreur qui ne se rattrape pas.
 *
 * ─── Comment on lit le texte sans dépendre d'un décodeur de polices ──────────
 *
 * `empreinte-document.js` refuse d'extraire le texte d'un PDF parce qu'une
 * extraction générale dépend d'un décodeur de polices, donc d'une bibliothèque.
 * Ici la situation est plus étroite, et MESURÉE : les deux générateurs
 * (JasperReports pour SNCF, le moteur d'OUIGO) écrivent leurs chaînes en
 * LITTÉRAUX `(…) Tj` dans des flux FlateDecode, en encodage WinAnsi — le texte
 * se relit avec `zlib` seul, sans rien décoder d'autre. Si un jour un des deux
 * services change de générateur et que l'ancre ne se trouve plus, la fonction
 * rend `null` et l'appelant retombe sur l'empreinte du lot 44 : on retombe sur
 * le doublon — rattrapable —, jamais sur la confusion de deux documents.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** Les cinq octets qui ouvrent un PDF. */
function estPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5
    && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Les flux du PDF qui se décompressent avec zlib, dans l'ordre du fichier.
 *
 * Aucune lecture de la table d'objets : on cherche les paires
 * `stream … endstream` et on tente l'inflation — un flux qui n'est pas du
 * FlateDecode échoue en silence et ne dit rien de faux. ⚠ « endstream »
 * contient « stream » : la fausse prise est écartée en regardant les trois
 * octets qui précèdent (mesuré : sans cette garde, tous les flux suivants se
 * lisent décalés et aucun ne se décompresse).
 */
function fluxDecompresses(buffer) {
  const texte = buffer.toString('latin1');
  const morceaux = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(texte))) {
    if (texte.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const debut = m.index + m[0].length;
    const fin = texte.indexOf('endstream', debut);
    if (fin < 0) break;
    try {
      morceaux.push(zlib.inflateSync(buffer.subarray(debut, fin)).toString('latin1'));
    } catch { /* pas du FlateDecode : ce flux ne porte pas de texte lisible */ }
    re.lastIndex = fin + 'endstream'.length;
  }
  return morceaux;
}

/** Un littéral PDF `(…)`, déséchappé : `\(`, `\)`, `\\`, `\n`… et l'octal. */
function desechapper(chaine) {
  return chaine.replace(/\\(\d{1,3}|.)/g, (tout, prise) => {
    if (/^\d/.test(prise)) return String.fromCharCode(parseInt(prise, 8) % 256);
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[prise] || prise;
  });
}

/**
 * Les chaînes que le document AFFICHE, dans l'ordre où il les peint.
 *
 * Seuls les littéraux `(…) Tj` sont pris : c'est la forme mesurée sur les deux
 * générateurs, et se limiter à ce qui est mesuré vaut mieux qu'un extracteur
 * général qui se tromperait en silence sur une forme jamais vue.
 */
function chainesDeTexte(buffer) {
  if (!estPdf(buffer)) return [];
  const chaines = [];
  for (const flux of fluxDecompresses(buffer)) {
    const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let m;
    while ((m = re.exec(flux))) chaines.push(desechapper(m[1]));
  }
  return chaines;
}

/** Un code de dossier ou de réservation : six lettres majuscules ou chiffres. */
const MOTIF_CODE = /^[A-Z0-9]{6}$/;

/**
 * Le code qui suit une ancre : la première chaîne non vide après elle, si elle
 * a la forme d'un code — sinon rien. La fenêtre est bornée : au-delà de
 * quelques chaînes, on n'est plus « juste après l'ancre » et prendre un code
 * qui traîne plus loin serait deviner.
 */
function codeApres(chaines, indexAncre, fenetre = 6) {
  for (let i = indexAncre + 1; i < chaines.length && i <= indexAncre + fenetre; i++) {
    const t = chaines[i].trim();
    if (!t) continue;
    return MOTIF_CODE.test(t) ? t : null;
  }
  return null;
}

/**
 * L'identité d'un justificatif SNCF Connect : le dossier voyage et la date de
 * la commande.
 *
 * Un justificatif d'aller-retour porte DEUX sections, même dossier, même
 * commande (mesuré : 82 chaînes contre 41 pour un aller simple). Toutes les
 * occurrences doivent s'accorder : deux dossiers différents dans un même
 * fichier seraient un document composite jamais rencontré — on rend `null`
 * plutôt qu'un identifiant qui confondrait.
 *
 * @returns {{dossier: string|null, commandeDu: string|null}}
 *   `commandeDu` au format AAAA-MM-JJ.
 */
function identiteSncfConnect(buffer) {
  const chaines = chainesDeTexte(buffer);
  const dossiers = new Set();
  let commandeDu = null;

  for (let i = 0; i < chaines.length; i++) {
    const texte = chaines[i].trim();
    if (texte === 'Dossier voyage') {
      const code = codeApres(chaines, i);
      if (code) dossiers.add(code);
      else return { dossier: null, commandeDu: null };
    }
    if (!commandeDu && /commande e-billet du/i.test(texte)) {
      // La date vit dans la chaîne suivante (« 27/07/2026. ») ou en fin de
      // celle-ci ; « Paris, le … » (la date d'édition, volatile) vient AVANT
      // cette ancre et ne peut donc pas être prise à sa place.
      for (let j = i; j < chaines.length && j <= i + 3; j++) {
        const reste = j === i ? texte.replace(/^.*commande e-billet du/i, '') : chaines[j];
        const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(reste);
        if (m) { commandeDu = `${m[3]}-${m[2]}-${m[1]}`; break; }
      }
    }
  }

  const dossier = dossiers.size === 1 ? [...dossiers][0] : null;
  return { dossier, commandeDu: dossier ? commandeDu : null };
}

/** « PRÉNOM NOM - 1981 » : la ligne du passager sur un billet OUIGO. */
const MOTIF_PASSAGER = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’ .-]{1,60} - \d{4}$/;

/**
 * L'identité d'un billet OUIGO : la référence de réservation et le passager.
 *
 * Le passager fait partie de l'identité, et ce n'est pas un raffinement : une
 * réservation à plusieurs voyageurs sert un billet PAR passager (un bouton à
 * son nom sur l'écran « Téléchargement des billets »). La référence seule
 * donnerait le même identifiant aux deux billets, et le second disparaîtrait
 * sans bruit. Un billet qui nomme plusieurs passagers — jamais rencontré :
 * les dix billets réels en nomment exactement un — rend donc `passager: null`,
 * et l'appelant retombe sur l'empreinte : le doublon possible plutôt que la
 * perte certaine.
 *
 * @returns {{reservation: string|null, passager: string|null}}
 */
function identiteOuigo(buffer) {
  const chaines = chainesDeTexte(buffer);
  const references = new Set();
  const passagers = new Set();

  for (let i = 0; i < chaines.length; i++) {
    const texte = chaines[i].trim();
    if (/num[ée]ro de r[ée]servation/i.test(texte)) {
      const code = codeApres(chaines, i);
      if (code) references.add(code);
      else return { reservation: null, passager: null };
    }
    if (MOTIF_PASSAGER.test(texte)) passagers.add(texte);
  }

  return {
    reservation: references.size === 1 ? [...references][0] : null,
    passager: passagers.size === 1 ? [...passagers][0] : null,
  };
}

/**
 * L'identifiant distant d'un justificatif SNCF Connect, ancré sur le voyage :
 * `sncf-connect-K7M2P9`. Rend `null` quand le document ne se lit pas — à
 * l'appelant de retomber sur l'empreinte du lot 44.
 */
function remoteIdSncfConnect(buffer) {
  const { dossier } = identiteSncfConnect(buffer);
  return dossier ? `sncf-connect-${dossier}` : null;
}

/**
 * L'identifiant distant d'un billet OUIGO, ancré sur la réservation ET le
 * passager : `ouigo-ZH8PL4-a1b2c3d4`. Le passager est haché — son nom et son
 * année de naissance n'ont rien à faire dans un identifiant qui se retrouve
 * dans les journaux et les noms de fichiers.
 */
function remoteIdOuigo(buffer) {
  const { reservation, passager } = identiteOuigo(buffer);
  if (!reservation || !passager) return null;
  const somme = crypto.createHash('sha256')
    .update(`${reservation}|${passager}`)
    .digest('hex')
    .slice(0, 8);
  return `ouigo-${reservation}-${somme}`;
}

module.exports = {
  estPdf,
  chainesDeTexte,
  identiteSncfConnect,
  identiteOuigo,
  remoteIdSncfConnect,
  remoteIdOuigo,
  MOTIF_CODE,
  MOTIF_PASSAGER,
};
