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
 *
 * ─── Lot 102 : rien n'est lu d'une adresse que l'appelant refuse ─────────────
 *
 * L'Eau d'Île-de-France exige qu'un onglet ouvert par le clic, s'il est sur un
 * autre domaine que ceux du site, ne soit pas lu. Mesuré sur un banc local
 * (Playwright 1.62.1, sans écran, 11/10/2026) : un `window.open` vers un PDF
 * n'arrive PAS comme un onglet qui le sert, mais comme un téléchargement sur
 * la page qui a cliqué, l'onglet restant à l'adresse vide — juger l'onglet sur
 * sa seule adresse laisserait passer le PDF d'un autre domaine. L'option
 * `adressePermise` juge donc, avant toute lecture, l'adresse de CE QUI SERAIT
 * LU : l'onglet, sa réponse, le téléchargement, la réponse de la page. Hors de
 * ce qu'elle permet : rien n'est lu, l'onglet est refermé, le fichier
 * téléchargé effacé, et le grief le dit. Sans l'option, rien de ceci ne
 * s'applique : le chemin d'avant est inchangé.
 */

const fs = require('node:fs');

const identity = require('./browser-identity');
const ongletPdf = require('./onglet-pdf');
const { constat } = require('./constat-document');

/** Attendre le premier signal du clic : au-delà, on renonce et on le dit. */
const DELAI_DECLENCHEMENT_MS = 30_000;

/** L'adresse d'un onglet, d'une réponse ou d'un téléchargement, sans lever. */
function adresseDe(objet) {
  try {
    return String(objet?.url?.() ?? '');
  } catch {
    return '';
  }
}

/** Ce qu'une adresse refusée laisse dire : son hôte (ou sa forme), jamais son chemin ni sa requête. */
function hoteDit(adresse) {
  try {
    const u = new URL(adresse);
    if (u.hostname) return u.hostname;
    if (u.protocol === 'blob:') return new URL(u.pathname).hostname || 'blob:';
    return u.protocol;
  } catch {
    return adresse ? 'adresse illisible' : 'adresse vide';
  }
}

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
 *   `adressePermise` (lot 102) : `(adresse) => boolean`. Donnée, elle juge
 *   l'adresse de ce qui serait lu avant toute lecture (voir l'en-tête) ; un
 *   refus rend `{ok: false, horsDomaine: true}` sans rien avoir lu.
 * @returns {Promise<{ok: true, buffer: Buffer, voie: string}
 *   | {ok: false, grief: string, autreIssue?: boolean, horsDomaine?: boolean}>}
 */
async function documentDuClic(page, context, clic, {
  delaiMs = DELAI_DECLENCHEMENT_MS,
  autreIssue = null,
  adressePermise = null,
} = {}) {
  let telechargement = null;
  let nouvelOnglet = null;
  let reponseOngletPdf = null;
  let reponsePagePdf = null;

  // Lot 102 — la première adresse refusée parmi ce qui serait lu, ou `null`.
  // Sans `adressePermise`, toujours `null` : rien de ce qui suit ne change.
  const horsPermis = () => {
    if (!adressePermise) return null;
    const vues = [
      nouvelOnglet && { quoi: 'l\'onglet ouvert par le clic', adresse: adresseDe(nouvelOnglet) },
      reponseOngletPdf && { quoi: 'la réponse de l\'onglet', adresse: adresseDe(reponseOngletPdf) },
      telechargement && { quoi: 'le téléchargement', adresse: adresseDe(telechargement) },
      reponsePagePdf && { quoi: 'la réponse de la page', adresse: adresseDe(reponsePagePdf) },
    ].filter(Boolean);
    return vues.find((v) => !adressePermise(v.adresse)) || null;
  };
  const refuserHorsPermis = async (refus) => {
    // Rien n'est lu : ni réponse, ni flux, ni fichier. L'onglet est refermé,
    // le fichier déjà reçu par le navigateur est effacé.
    try { await nouvelOnglet?.close?.(); } catch { /* déjà fermé */ }
    try { await telechargement?.delete?.(); } catch { /* déjà effacé */ }
    return {
      ok: false,
      horsDomaine: true,
      grief: `${refus.quoi} venait de ${hoteDit(refus.adresse)}, hors des domaines permis : rien n'en a été lu`,
    };
  };

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
    // Lot 102 : un onglet déjà ouvert hors des domaines permis n'attend pas.
    if (adressePermise) {
      const refus = horsPermis();
      if (refus) return await refuserHorsPermis(refus);
    }
    // Un onglet s'est ouvert mais n'a encore rien servi : on lui laisse le
    // même délai pour recevoir son PDF — ou pour lancer un téléchargement.
    if (nouvelOnglet && !telechargement && !reponseOngletPdf) {
      const finOnglet = Date.now() + delaiMs;
      while (Date.now() < finOnglet && !telechargement && !reponseOngletPdf) {
        await page.waitForTimeout(250).catch(() => {});
      }
    }
    // Lot 102 : l'adresse de ce qui serait lu, jugée avant toute lecture.
    if (adressePermise) {
      const refus = horsPermis();
      if (refus) return await refuserHorsPermis(refus);
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
        // Lot 95 : ce que le fichier était — un téléchargement ne dit ni son
        // type déclaré ni sa redirection : le constat ne les écrit pas.
        return {
          ok: false,
          grief: `le fichier téléchargé n'est pas un PDF (${octets.length} octets) ${constat(octets)}`,
        };
      }
      return { ok: true, buffer: Buffer.from(octets), voie: 'téléchargement direct' };
    }

    if (nouvelOnglet) {
      // La page qui a cliqué sert de relais : c'est depuis ELLE que le flux se
      // relit si l'onglet ne rend plus ses octets (lot 80).
      const lu = await ongletPdf.lireDocumentDeLOnglet(nouvelOnglet, reponseOngletPdf, {
        pageRelais: page,
      });
      return lu.ok
        ? { ok: true, buffer: lu.buffer, voie: `nouvel onglet — ${lu.voie}` }
        : { ok: false, grief: `un onglet s'est ouvert mais ${lu.grief}` };
    }

    if (reponsePagePdf) {
      let octets = null;
      try { octets = await reponsePagePdf.body(); } catch { octets = null; }
      if (octets && identity.estPdf(octets)) {
        return { ok: true, buffer: Buffer.from(octets), voie: 'réponse PDF de la page' };
      }
      // La réponse est passée sous les yeux de la page mais ne se relit plus :
      // le flux se redemande au navigateur lui-même, jamais hors de lui (lot 80).
      let adresse = '';
      try { adresse = reponsePagePdf.url?.() || ''; } catch { adresse = ''; }
      const relu = await ongletPdf.fluxDeLaPage(page, adresse);
      if (relu.ok) {
        return { ok: true, buffer: relu.buffer, voie: 'réponse PDF de la page, flux relu dans la page' };
      }
      // Lot 95 : des octets reçus qui ne sont pas un PDF disent ce qu'ils
      // étaient — au refus seulement : le chemin d'un document obtenu ne
      // change pas.
      let decrits = '';
      if (octets) {
        const connu = {};
        try { connu.type = await reponsePagePdf.headerValue('content-type'); } catch { /* inconnu */ }
        try { connu.redirige = !!reponsePagePdf.request().redirectedFrom(); } catch { /* inconnue */ }
        decrits = ` ${constat(octets, connu)}`;
      }
      return {
        ok: false,
        grief: `une réponse au type PDF est passée mais ne se relit pas`
          + `${octets ? ` (${octets.length} octets)${decrits}` : ''} et le flux relu dans la page ${relu.grief}`,
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
  hoteDit,
  DELAI_DECLENCHEMENT_MS,
};
