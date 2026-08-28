'use strict';

/**
 * Lire le document qu'un ONGLET vient de servir.
 *
 * ─── Pourquoi ce n'est pas un « téléchargement » ─────────────────────────────
 *
 * Deux services mesurés servent leurs documents de la même façon, et ce n'est
 * pas celle qu'on attend :
 *
 *   - SNCF Connect (20/08/2026) : « Télécharger votre justificatif » est un
 *     lien `target="_blank"` vers monbillet.sncf, et la page d'arrivée EST le
 *     PDF (`document.contentType` vaut `application/pdf`) ;
 *   - OUIGO (20/08/2026) : le bouton au NOM DU PASSAGER, sur l'écran
 *     « Téléchargement des billets », ouvre un onglet sur une adresse en `.pdf`
 *     servie par `ous-prd-tickets.pasngr.com` — même `application/pdf`.
 *
 * Dans les deux cas, aucun événement « download » n'arrive jamais : l'attendre
 * revient à patienter quarante-cinq secondes pour un fichier qui ne viendra
 * pas. Le document se lit dans la RÉPONSE que l'onglet a déjà reçue.
 *
 * Ce module tenait dans le connecteur SNCF Connect jusqu'au lot 43. Le lot 44
 * l'en sort parce qu'OUIGO en a besoin mot pour mot : deux copies d'une
 * mécanique aussi tatillonne divergeraient au premier correctif.
 */

const identity = require('./browser-identity');

/**
 * Un texte d'interface prêt pour le journal : espaces réduits, chiffres
 * masqués (une date, un numéro de dossier ou un montant n'ont rien à y faire),
 * longueur bornée. Le connecteur SNCF Connect applique la même règle à ses
 * propres lignes de journal ; celle-ci reste ici pour que ce module se suffise
 * à lui-même — c'est toute sa raison d'être.
 */
function pourLeJournal(texte, longueur = 60) {
  return String(texte || '').replace(/\s+/g, ' ').trim().replace(/\d/g, '#').slice(0, longueur);
}

/** Relire l'adresse d'un onglet qui sert un PDF : au-delà, on renonce. */
const DELAI_LECTURE_ONGLET_MS = 30_000;

/**
 * Lit le document que sert un ONGLET ouvert par un déclencheur (lot 43).
 *
 * Mesuré le 20/08/2026 sur la session réelle : « Télécharger votre
 * justificatif » est un lien `target="_blank"` vers monbillet.sncf, et la
 * page d'arrivée EST le PDF — `document.contentType` vaut `application/pdf`,
 * il n'y a ni formulaire, ni bouton, ni action à faire. Ce n'est donc PAS un
 * téléchargement : c'est une navigation, et attendre un « download » revenait
 * à attendre 45 secondes un fichier qui n'arriverait jamais (le grief des
 * voyages 2 et 4 du 19/08/2026).
 *
 * Les octets se lisent d'abord dans la RÉPONSE que l'onglet a déjà reçue —
 * aucune requête nouvelle. Si elle n'est plus relisible, une seule relance :
 * la même adresse, dans le même contexte (cookies compris) — le geste que
 * l'onglet vient de faire, jamais un geste nouveau. L'onglet est refermé quoi
 * qu'il arrive : la pile d'onglets d'une récupération n'appartient pas à la
 * fenêtre de connexion suivante (leçon du lot 40).
 *
 * @param {import('playwright').Page} onglet
 * @param {import('playwright').Response|null} reponsePdf la réponse au type
 *   PDF déjà vue passer sur cet onglet, si l'écouteur l'a attrapée
 * @returns {Promise<{ok: true, buffer: Buffer, adresse: string}
 *   | {ok: false, grief: string}>}
 */
async function lireDocumentDeLOnglet(onglet, reponsePdf) {
  // Un onglet peut mourir sous les doigts (fermé par le site, contexte en
  // cours d'extinction) : chaque geste est bordé, le grief dit ce qui a manqué.
  try {
    try { await onglet.waitForLoadState?.('domcontentloaded'); } catch { /* déjà chargé, ou parti */ }
    const adresse = (() => { try { return onglet.url?.() || ''; } catch { return ''; } })();

    if (reponsePdf) {
      let octets = null;
      try { octets = await reponsePdf.body(); } catch { octets = null; }
      if (octets && identity.estPdf(octets)) {
        let adresseReponse = adresse;
        try { adresseReponse = reponsePdf.url?.() || adresse; } catch { /* l'adresse de l'onglet suffit */ }
        return { ok: true, buffer: Buffer.from(octets), adresse: adresseReponse };
      }
    }

    // La réponse n'a pas été attrapée ou ne se relit plus : le document de
    // l'onglet dit son type, et la même adresse se relit dans le même contexte.
    let type = '';
    try { type = await onglet.evaluate(() => document.contentType || ''); } catch { type = ''; }
    if (!/pdf/i.test(type)) {
      return {
        ok: false,
        grief: `la page de l'onglet sert « ${pourLeJournal(type, 40) || 'un contenu sans type lisible'} », pas un PDF`,
      };
    }
    let reponse = null;
    try {
      reponse = await onglet.context?.().request.get(adresse, { timeout: DELAI_LECTURE_ONGLET_MS });
    } catch { reponse = null; }
    if (!reponse || !reponse.ok()) {
      return {
        ok: false,
        grief: `la relecture de l'adresse de l'onglet a rendu ${reponse ? `HTTP ${reponse.status()}` : 'une erreur de réseau'}`,
      };
    }
    let octets = null;
    try { octets = await reponse.body(); } catch { octets = null; }
    if (!octets || !identity.estPdf(octets)) {
      return {
        ok: false,
        grief: `la relecture n'a pas rendu un PDF (${octets ? `${octets.length} octets` : 'aucun octet'})`,
      };
    }
    return { ok: true, buffer: Buffer.from(octets), adresse };
  } finally {
    try { await onglet.close?.(); } catch { /* déjà fermé */ }
  }
}

module.exports = {
  lireDocumentDeLOnglet,
  DELAI_LECTURE_ONGLET_MS,
};
