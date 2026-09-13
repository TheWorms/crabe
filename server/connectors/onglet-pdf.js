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
 * Ce qu'un flux relu dans la page ne doit jamais dépasser : il traverse le pont
 * `evaluate` en base64, et un JSON de plusieurs dizaines de méga-octets se
 * paierait sur la mémoire du service. Une facture tient très largement dedans ;
 * au-delà, ce n'est plus une facture.
 */
const PLAFOND_FLUX_OCTETS = 64 * 1024 * 1024;

/**
 * Le plancher de taille (lot 80). Il n'attrape PAS la page d'erreur déguisée en
 * document — c'est `estPdf` qui la refuse, une page de refus HTTP ne commence
 * jamais par `%PDF-`. Il n'attrape que le fichier VIDE ou réduit à son en-tête,
 * que la seule signature laisserait passer.
 */
const TAILLE_PLANCHER_OCTETS = 16;

/**
 * Des octets sont-ils un document déposable ? Trois refus, chacun nommé, pour
 * qu'un journal dise ce qui a manqué plutôt que « ça n'a pas marché ».
 */
function jugerLesOctets(octets) {
  if (!octets || !octets.length) return { ok: false, grief: "n'a rendu aucun octet" };
  if (!identity.estPdf(octets)) {
    return { ok: false, grief: `a rendu ${octets.length} octets qui ne sont pas un PDF` };
  }
  if (octets.length < TAILLE_PLANCHER_OCTETS) {
    return { ok: false, grief: `n'a rendu que ${octets.length} octets — un en-tête sans document` };
  }
  return { ok: true, buffer: Buffer.from(octets) };
}

/**
 * Relire l'adresse DEPUIS la page, avec le `fetch` du navigateur.
 *
 * ─── Pourquoi ce détour, mesuré le 10/09/2026 (lot 80) ───────────────────────
 *
 * `context.request.get()` porte bien les cookies, mais il sort de la pile
 * réseau de Chromium : c'est un client HTTP de Node, avec sa propre poignée de
 * main TLS et ses propres en-têtes. Auto-Doc et Coyote sont derrière Cloudflare,
 * qui l'a refusé — 403, cinquante-six fois, pour des documents que l'onglet
 * AVAIT déjà reçus. Le `fetch` évalué dans la page part, lui, du navigateur
 * lui-même : même empreinte TLS, mêmes en-têtes, même origine, même cache.
 *
 * Rendu en base64 par tranches : `String.fromCharCode` appliqué d'un coup à un
 * méga-octet fait déborder la pile d'arguments. La longueur est annoncée ET
 * revérifiée à l'arrivée — un transfert tronqué ne doit pas se déposer en
 * silence.
 */
const LIRE_LE_FLUX = async ({ adresse, plafond }) => {
  let reponse;
  try {
    reponse = await fetch(adresse, { credentials: 'include' });
  } catch (err) {
    return { grief: `n'a pas abouti (${String((err && err.message) || err).slice(0, 80)})` };
  }
  if (!reponse.ok) return { grief: `a rendu HTTP ${reponse.status}` };
  const vue = new Uint8Array(await reponse.arrayBuffer());
  if (vue.length > plafond) {
    return { grief: `a rendu ${vue.length} octets, au-delà de ce qui se transporte` };
  }
  let binaire = '';
  const PAS = 0x8000;
  for (let i = 0; i < vue.length; i += PAS) {
    binaire += String.fromCharCode.apply(null, vue.subarray(i, i + PAS));
  }
  return { base64: btoa(binaire), octets: vue.length };
};

/**
 * Lit `adresse` dans le contexte de `page`. Rend le document ou dit pourquoi.
 * @returns {Promise<{ok: true, buffer: Buffer} | {ok: false, grief: string}>}
 */
async function fluxDeLaPage(page, adresse, { plafondOctets = PLAFOND_FLUX_OCTETS } = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    return { ok: false, grief: "n'avait pas de page où être tenté" };
  }
  if (!adresse) return { ok: false, grief: "n'avait pas d'adresse à relire" };
  let rendu = null;
  try {
    rendu = await page.evaluate(LIRE_LE_FLUX, { adresse, plafond: plafondOctets });
  } catch (err) {
    return { ok: false, grief: `n'a pas pu être lancé (${pourLeJournal((err && err.message) || err, 80)})` };
  }
  if (!rendu) return { ok: false, grief: "n'a rien rendu" };
  if (rendu.grief) return { ok: false, grief: pourLeJournal(rendu.grief, 100) };
  const buffer = Buffer.from(String(rendu.base64 || ''), 'base64');
  if (buffer.length !== rendu.octets) {
    return {
      ok: false,
      grief: `a rendu ${buffer.length} octets pour ${rendu.octets} annoncés — transfert tronqué`,
    };
  }
  return jugerLesOctets(buffer);
}

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
 * ─── L'ordre des voies, et pourquoi il a changé au lot 80 ────────────────────
 *
 * Les octets se lisent d'abord dans la RÉPONSE que l'onglet a déjà reçue —
 * aucune requête nouvelle. Jusqu'au lot 79, le repli sortait du navigateur
 * (`context.request.get`) : cookies portés, mais poignée de main TLS de Node.
 * Cloudflare l'a refusé cinquante-six fois le 10/09/2026, sur Auto-Doc et
 * Coyote, pour des documents que l'onglet TENAIT déjà. Le repli passe donc
 * maintenant par le `fetch` du navigateur, d'abord dans l'onglet lui-même, puis
 * dans la page qui a cliqué — même origine, même session, même empreinte. La
 * sortie hors navigateur reste en DERNIER recours : elle sert les onglets d'un
 * autre domaine que la page (OUIGO sert ses billets depuis `pasngr.com`), où le
 * `fetch` de la page se heurterait, lui, à la barrière d'origine.
 *
 * L'onglet est refermé quoi qu'il arrive : la pile d'onglets d'une récupération
 * n'appartient pas à la fenêtre de connexion suivante (leçon du lot 40).
 *
 * @param {import('playwright').Page} onglet
 * @param {import('playwright').Response|null} reponsePdf la réponse au type
 *   PDF déjà vue passer sur cet onglet, si l'écouteur l'a attrapée
 * @param {{pageRelais?: import('playwright').Page|null}} [options] `pageRelais` :
 *   la page qui a déclenché l'ouverture. Elle est du même domaine que le
 *   document dans le cas mesuré, et c'est une vraie page HTML — là où l'onglet
 *   est un visualiseur de PDF, dont le contexte d'exécution est plus étroit.
 * @returns {Promise<{ok: true, buffer: Buffer, adresse: string, voie: string}
 *   | {ok: false, grief: string}>}
 */
async function lireDocumentDeLOnglet(onglet, reponsePdf, { pageRelais = null } = {}) {
  // Un onglet peut mourir sous les doigts (fermé par le site, contexte en
  // cours d'extinction) : chaque geste est bordé, le grief dit ce qui a manqué.
  const griefs = [];
  try {
    try { await onglet.waitForLoadState?.('domcontentloaded'); } catch { /* déjà chargé, ou parti */ }
    const adresse = (() => { try { return onglet.url?.() || ''; } catch { return ''; } })();

    // Voie 1 — la réponse que l'onglet a DÉJÀ reçue. Aucune requête nouvelle.
    if (reponsePdf) {
      let octets = null;
      try { octets = await reponsePdf.body(); } catch { octets = null; }
      const juge = jugerLesOctets(octets);
      if (juge.ok) {
        let adresseReponse = adresse;
        try { adresseReponse = reponsePdf.url?.() || adresse; } catch { /* l'adresse de l'onglet suffit */ }
        return {
          ok: true,
          buffer: juge.buffer,
          adresse: adresseReponse,
          voie: 'réponse déjà reçue par l\'onglet',
        };
      }
      griefs.push(`la réponse déjà reçue ${juge.grief}`);
    }

    // La réponse n'a pas été attrapée ou ne se relit plus : le document de
    // l'onglet dit son type avant qu'on aille rechercher ses octets.
    let type = '';
    try { type = await onglet.evaluate(() => document.contentType || ''); } catch { type = ''; }
    if (!/pdf/i.test(type)) {
      return {
        ok: false,
        grief: `la page de l'onglet sert « ${pourLeJournal(type, 40) || 'un contenu sans type lisible'} », pas un PDF`,
      };
    }

    // Voie 2 — le flux relu DANS le navigateur : l'onglet d'abord, la page qui
    // a cliqué ensuite. C'est la correction du lot 80.
    for (const [ou, page] of [["l'onglet", onglet], ['la page qui a cliqué', pageRelais]]) {
      if (!page) continue;
      const lu = await fluxDeLaPage(page, adresse);
      if (lu.ok) return { ok: true, buffer: lu.buffer, adresse, voie: `flux relu dans ${ou}` };
      griefs.push(`le flux relu dans ${ou} ${lu.grief}`);
    }

    // Voie 3 — la sortie hors navigateur, en dernier : elle ignore la barrière
    // d'origine, mais elle est la seule que les protections anti-robot voient.
    let reponse = null;
    try {
      reponse = await onglet.context?.().request.get(adresse, { timeout: DELAI_LECTURE_ONGLET_MS });
    } catch { reponse = null; }
    if (!reponse || !reponse.ok()) {
      griefs.push(`la relecture de l'adresse de l'onglet a rendu ${reponse ? `HTTP ${reponse.status()}` : 'une erreur de réseau'}`);
      return { ok: false, grief: griefs.join(' ; ') };
    }
    let octets = null;
    try { octets = await reponse.body(); } catch { octets = null; }
    const juge = jugerLesOctets(octets);
    if (!juge.ok) {
      griefs.push(`la relecture de l'adresse de l'onglet ${juge.grief}`);
      return { ok: false, grief: griefs.join(' ; ') };
    }
    return { ok: true, buffer: juge.buffer, adresse, voie: 'relecture hors navigateur' };
  } finally {
    try { await onglet.close?.(); } catch { /* déjà fermé */ }
  }
}

module.exports = {
  lireDocumentDeLOnglet,
  fluxDeLaPage,
  jugerLesOctets,
  DELAI_LECTURE_ONGLET_MS,
  PLAFOND_FLUX_OCTETS,
  TAILLE_PLANCHER_OCTETS,
};
