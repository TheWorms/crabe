'use strict';

/**
 * Lire le document qu'un CLIC déclenche — sans supposer la voie.
 *
 * ─── Pourquoi ce module existe (lot 50) ──────────────────────────────────────
 *
 * Le bouton de facture de Boulanger est un élément personnalisé `<bl-button>`
 * (relevé le 23/08/2026 sur le vrai compte) : ni un `<a>`, ni un `<button>`.
 * Un sélecteur `a[href]` ne le verra jamais, et surtout RIEN ne dit ce que son
 * clic déclenche — un téléchargement, un appel réseau qui sert le PDF, ou un
 * nouvel onglet. VistaPrint a le même piège (« Télécharger vos factures TVA »
 * est un `<button>` sans lien, relevé le même jour) : la mécanique est portée
 * ici UNE fois, pour ne pas la corriger deux fois.
 *
 * Les trois voies déjà MESURÉES ailleurs dans crabe, qu'on guette toutes :
 *
 *   - le TÉLÉCHARGEMENT (événement « download ») — la voie classique des
 *     consoles d'achat ;
 *   - le NOUVEL ONGLET qui sert un `application/pdf` — SNCF Connect et OUIGO
 *     font ainsi (module `onglet-pdf`, lot 44), et aucun « download » n'arrive
 *     jamais : l'attendre seul coûterait quarante-cinq secondes pour rien ;
 *   - la RÉPONSE PDF sur la page elle-même — un appel que l'application se
 *     fait à elle-même, ou une navigation de la page vers le document.
 *
 * Le premier signal qui arrive décide de la voie ; le résultat dit laquelle,
 * pour que le journal du connecteur consigne ce qui a été MESURÉ au premier
 * passage réel.
 */

const fs = require('node:fs');

const identity = require('./browser-identity');
const ongletPdf = require('./onglet-pdf');

/** Attendre le premier signal du clic : au-delà, on renonce et on le dit. */
const DELAI_DECLENCHEMENT_MS = 30_000;

/** La réponse est-elle un PDF, à son en-tête ? Bordé : elle peut être close. */
async function estReponsePdf(reponse) {
  try {
    const type = (await reponse.headerValue('content-type')) || '';
    return /pdf/i.test(type);
  } catch {
    return false;
  }
}

/**
 * Déclenche `clic()` et lit le document servi, quelle que soit la voie.
 *
 * @param {import('playwright').Page} page la page qui porte le déclencheur
 * @param {import('playwright').BrowserContext} context son contexte — c'est lui
 *   qui annonce un nouvel onglet
 * @param {() => Promise<boolean>} clic le geste ; rend `false` si le
 *   déclencheur n'était plus dans la page
 * @param {{delaiMs?: number, autreIssue?: () => Promise<boolean>}} [options]
 *   `autreIssue` : le clic peut ouvrir AUTRE CHOSE qu'un document — mesuré le
 *   23/08/2026 chez Boulanger, où une commande à plusieurs factures ouvre une
 *   boîte de choix au lieu de télécharger. L'appelant qui sait reconnaître
 *   cette issue la passe ici ; elle est guettée pendant l'attente, et le
 *   résultat `{ok: false, autreIssue: true}` lui rend la main SANS épuiser le
 *   délai — trente secondes d'attente pour une boîte déjà ouverte.
 * @returns {Promise<{ok: true, buffer: Buffer, voie: string}
 *   | {ok: false, grief: string, autreIssue?: boolean}>}
 */
async function documentDuClic(page, context, clic, { delaiMs = DELAI_DECLENCHEMENT_MS, autreIssue = null } = {}) {
  let telechargement = null;
  let nouvelOnglet = null;
  let reponseOngletPdf = null;
  let reponsePagePdf = null;

  const surTelechargement = (d) => { if (!telechargement) telechargement = d; };
  const surReponseOnglet = async (reponse) => {
    if (!reponseOngletPdf && (await estReponsePdf(reponse))) reponseOngletPdf = reponse;
  };
  const surReponsePage = async (reponse) => {
    if (!reponsePagePdf && (await estReponsePdf(reponse))) reponsePagePdf = reponse;
  };
  const surNouvellePage = (p) => {
    if (nouvelOnglet) return;
    nouvelOnglet = p;
    // Le document peut arriver DANS l'onglet, par l'une ou l'autre voie : on
    // guette les deux là aussi.
    p.on?.('response', surReponseOnglet);
    p.on?.('download', surTelechargement);
  };

  page.on?.('download', surTelechargement);
  page.on?.('response', surReponsePage);
  context?.on?.('page', surNouvellePage);

  try {
    const clique = await clic();
    if (!clique) return { ok: false, grief: 'le déclencheur n\'était plus dans la page' };

    const fin = Date.now() + delaiMs;
    let tours = 0;
    while (Date.now() < fin && !telechargement && !reponsePagePdf && !nouvelOnglet) {
      // L'autre issue se guette environ une fois par seconde : c'est un
      // `page.evaluate`, le marteler à chaque tour coûterait plus qu'il ne
      // rend. Le document, lui, arrive par les écouteurs — aucun retard.
      if (autreIssue && tours % 4 === 0 && (await autreIssue().catch(() => false))) {
        return {
          ok: false,
          grief: 'le clic a ouvert autre chose qu\'un document — l\'appelant sait la lire',
          autreIssue: true,
        };
      }
      tours += 1;
      await page.waitForTimeout(250).catch(() => {});
    }
    // Un onglet s'est ouvert mais n'a encore rien servi : on lui laisse le
    // même délai pour recevoir son PDF — ou pour lancer un téléchargement.
    if (nouvelOnglet && !telechargement && !reponseOngletPdf) {
      const finOnglet = Date.now() + delaiMs;
      while (Date.now() < finOnglet && !telechargement && !reponseOngletPdf) {
        await page.waitForTimeout(250).catch(() => {});
      }
    }

    if (telechargement) {
      const chemin = await telechargement.path().catch(() => null);
      if (!chemin) {
        const echec = await telechargement.failure().catch(() => null);
        return {
          ok: false,
          grief: `le téléchargement annoncé n'a pas abouti${echec ? ` (${echec})` : ''}`,
        };
      }
      const octets = fs.readFileSync(chemin);
      if (!identity.estPdf(octets)) {
        return {
          ok: false,
          grief: `le fichier téléchargé n'est pas un PDF (${octets.length} octets)`,
        };
      }
      return { ok: true, buffer: Buffer.from(octets), voie: 'téléchargement direct' };
    }

    if (nouvelOnglet) {
      const lu = await ongletPdf.lireDocumentDeLOnglet(nouvelOnglet, reponseOngletPdf);
      return lu.ok
        ? { ok: true, buffer: lu.buffer, voie: 'nouvel onglet' }
        : { ok: false, grief: `un onglet s'est ouvert mais ${lu.grief}` };
    }

    if (reponsePagePdf) {
      let octets = null;
      try { octets = await reponsePagePdf.body(); } catch { octets = null; }
      if (octets && identity.estPdf(octets)) {
        return { ok: true, buffer: Buffer.from(octets), voie: 'réponse PDF de la page' };
      }
      return {
        ok: false,
        grief: `une réponse au type PDF est passée mais ne se relit pas`
          + `${octets ? ` (${octets.length} octets)` : ''}`,
      };
    }

    return {
      ok: false,
      grief: 'le clic n\'a déclenché ni téléchargement, ni nouvel onglet, ni réponse PDF '
        + `en ${Math.round(delaiMs / 1000)} s`,
    };
  } finally {
    try { page.off?.('download', surTelechargement); } catch { /* page partie */ }
    try { page.off?.('response', surReponsePage); } catch { /* page partie */ }
    try { context?.off?.('page', surNouvellePage); } catch { /* contexte parti */ }
    // Un onglet resté ouvert sans avoir servi de document n'appartient pas à
    // la suite de la récupération (leçon du lot 40) — `lireDocumentDeLOnglet`
    // ferme déjà celui qu'il a lu.
    if (nouvelOnglet && !telechargement && !reponseOngletPdf) {
      try { await nouvelOnglet.close?.(); } catch { /* déjà fermé */ }
    }
  }
}

module.exports = {
  documentDuClic,
  DELAI_DECLENCHEMENT_MS,
};
