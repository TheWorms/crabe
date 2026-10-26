'use strict';

/**
 * Connecteur OUIGO — les justificatifs des réservations passées.
 *
 * ─── Ce qui est mesuré, et ce qui ne l'est pas ───────────────────────────────
 *
 * Mesuré le 14/08/2026, navigateur réel du CT, sans identifiants :
 *
 *   - `ventes.ouigo.com` se rend ENTIÈREMENT en navigateur automatisé (pas de
 *     mur comme sncf-connect.com) ;
 *   - hors session, `/fr-FR/user/bookings/past-bookings` REDIRIGE vers
 *     l'accueil `/fr-FR` — rester sur la page des réservations est donc déjà
 *     un signe de session ;
 *   - le bandeau de cookies (« Bienvenue chez OUIGO ! ») bloque la page et se
 *     REMONTE après fermeture — `auth-sncf.fermerBandeauCookies` fait
 *     plusieurs passages ;
 *   - la connexion passe par « Mon Identifiant SNCF » (module auth-sncf), le
 *     même que SNCF Connect, avec un profil de navigateur distinct par
 *     service.
 *
 * Le 14/08/2026, l'onglet « PASSÉS » du compte réel mesuré était VIDE (« Vous
 * n'avez pas de réservation passée. »). Le 20/08/2026, il porte 5
 * réservations, MESURÉES par sonde (session réelle, lecture seule) :
 *
 *   - chaque réservation est une CARTE ouvrant sur « N° de réservation
 *     <réf> » — le seul marqueur textuel stable (les classes CSS sont
 *     générées) ; son seul cliquable est un bouton SANS libellé (chevron) ;
 *   - la liste n'offre AUCUN téléchargement direct ;
 *   - la navigation DIRECTE vers /user/bookings/past-bookings est parfois
 *     renvoyée vers l'accueil /fr-FR, session pourtant valide : le rattrapage
 *     mesuré est le geste de l'utilisateur (« Mes voyages » puis « PASSÉS »),
 *     voir `ramenerSurLesPasses`.
 *
 * ─── Le chemin vers le billet, mesuré de bout en bout (lot 44) ───────────────
 *
 * Deux descriptions circulaient et paraissaient se contredire — « chevron puis
 * bouton au nom du passager » d'un côté, « bouton Accéder à vos billets » de
 * l'autre. La sonde du 20/08/2026 les a recollées : ce sont les deux moitiés
 * d'un MÊME chemin.
 *
 *   liste « PASSÉS » → chevron d'une carte → `/fr-FR/after-sale/details`
 *   → « Accéder à vos billets » → `/fr-FR/after-sale/tickets`
 *   (« Téléchargement des billets ») → bouton au NOM DU PASSAGER
 *   → onglet servant un `application/pdf` sur `ous-prd-tickets.pasngr.com`.
 *
 * Une correction au passage : l'adresse du détail est `/after-sale/details`
 * pour TOUTES les réservations — elle ne porte pas la référence, contrairement
 * à ce que disait l'ancienne description. On ne peut donc pas y aller
 * directement : chaque réservation se rouvre depuis la liste.
 *
 * ─── Une liste vide ne se déclare pas toute seule ────────────────────────────
 *
 * « 0 réservation » n'est un résultat que si la page des réservations a bien
 * été SERVIE À CE COMPTE : soit elle affiche des réservations, soit elle
 * affiche mot pour mot qu'il n'y en a pas. Une page interstitielle, un écran
 * de connexion ou un accueil quelconque ne concluent RIEN — c'est la leçon de
 * la tâche 3 de ce lot, et `etatDesReservations()` la tient d'une pièce.
 */

const authSncf = require('../../auth-sncf');
const empreinte = require('../../empreinte-document');
const identite = require('../../identite-voyage');
const ongletPdf = require('../../onglet-pdf');

const ID = 'ouigo';
const NOM = 'OUIGO';
const URL_PASSES = 'https://ventes.ouigo.com/fr-FR/user/bookings/past-bookings';

const PAUSE_DOCUMENT_MS = 400;

/** Le texte EXACT de l'onglet vide, relevé à l'écran le 14/08/2026. */
const MOTIF_AUCUNE_RESERVATION = /vous n'avez pas de r[ée]servation pass[ée]e/i;
/**
 * Une carte de réservation passée, MESURÉE le 20/08/2026 sur le compte
 * réel mesuré (5 réservations à l'écran) : chaque carte s'ouvre par « N° de
 * réservation <réf> », et c'est le SEUL marqueur textuel stable — les classes
 * CSS du site sont générées (styled-components) et changent à chaque build.
 *
 * L'ancien motif (« référence | dossier | voir le détail | billet ») comptait
 * ZÉRO sur ces 5 cartes : aucune ne porte « Voir le détail » (leur seul
 * cliquable est un bouton SANS libellé), et « billet » matchait… les liens
 * marketing du PIED DE PAGE (« Billets Paris Lyon »), présents sur toutes les
 * pages — d'où un journal qui se contredisait : « des réservations sont
 * affichées » (le pied de page), « 0 réservation(s) affichée(s) » (le compte).
 */
const MOTIF_CARTE_RESERVATION = /n[°o]\s*de\s*r[ée]servation/i;
/** Un déclencheur de téléchargement ; l'e-mail reste interdit de clic. */
const MOTIF_TELECHARGER = /t[ée]l[ée]charg|justificatif|facture|re[çc]u/i;
const MOTIF_ENVOI_EMAIL = /e-?mail|courriel/i;

/**
 * Le bouton du détail qui mène à l'écran des billets, MESURÉ le 20/08/2026 :
 * « Accéder à vos billets », un `<button>` de la page `/fr-FR/after-sale/details`.
 */
const MOTIF_ACCES_BILLETS = /acc[ée]der.*billet|vos billets|t[ée]l[ée]charg.*billet/i;

/**
 * Le bouton qui SERT le billet : celui qui porte le NOM DU PASSAGER.
 *
 * Mesuré le 20/08/2026 sur l'écran « Téléchargement des billets »
 * (`/fr-FR/after-sale/tickets`). Les boutons visibles y sont : « Mes voyages »,
 * « T le compte réelault » (le menu du compte, une initiale puis un prénom),
 * « CAMILLE MARCHAND » et « Accentuer les contrastes ». Un seul est écrit
 * ENTIÈREMENT EN CAPITALES, et c'est le passager — c'est ce qui le distingue
 * du reste sans avoir à tenir la liste des libellés du site à jour.
 *
 * Un compte à plusieurs voyageurs affichera plusieurs de ces boutons : ils
 * sont tous pris, chacun sert son billet.
 */
const MOTIF_BOUTON_PASSAGER = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'\u2019 .-]{2,}$/;

/** L'application se repeint après chaque geste : on lui laisse le temps. */
const PAUSE_ECRAN_MS = 4_000;

/**
 * Décide de l'état de l'onglet « Passés » depuis ce que la page MONTRE.
 *
 * Pure et testée : c'est elle qui interdit le faux « rien à récupérer ».
 *
 * Depuis le lot 43, la présence de réservations se juge sur le COMPTE de
 * cartes « N° de réservation » (`vue.reservations`), jamais sur le vocabulaire
 * du texte entier : « billet » matchait le pied de page marketing du site
 * (« Billets Paris Lyon ») et déclarait « des réservations sont affichées »
 * sur des pages qui n'en montraient aucune.
 *
 * @param {{url: string, texte: string, boutonSeConnecter: boolean,
 *   reservations?: number}} vue
 * @returns {{servie: boolean, vide: boolean, raison: string,
 *   reservations?: number}}
 */
function etatDesReservations(vue) {
  const url = String(vue?.url || '');
  const texte = String(vue?.texte || '');

  // Hors session, la page des réservations REDIRIGE vers l'accueil, qui
  // propose « Se connecter » (mesuré le 14/08/2026, revu le 18/08/2026 sur le
  // compte réel mesuré) : c'est une SESSION ABSENTE, pas une page inconnue — le
  // dire en « page qui n'est ni… ni… » envoyait chercher un défaut de
  // reconnaissance là où il fallait se reconnecter.
  if (!/\/user\/bookings\//i.test(url)) {
    if (vue?.boutonSeConnecter) {
      return {
        servie: false,
        vide: false,
        sessionAbsente: true,
        raison: `renvoyé vers ${url || '(adresse inconnue)'}, qui propose « Se connecter »`,
      };
    }
    return { servie: false, vide: false, raison: `l'adresse servie est ${url || '(inconnue)'}` };
  }
  // Un bouton « Se connecter » sur la page des réservations : session absente.
  if (vue?.boutonSeConnecter) {
    return {
      servie: false,
      vide: false,
      sessionAbsente: true,
      raison: 'la page propose « Se connecter »',
    };
  }
  if (MOTIF_AUCUNE_RESERVATION.test(texte)) {
    return { servie: true, vide: true, raison: 'la page écrit qu\'il n\'y a pas de réservation passée' };
  }
  const reservations = Number(vue?.reservations) || 0;
  if (reservations > 0) {
    return {
      servie: true,
      vide: false,
      reservations,
      raison: `${reservations} carte(s) « N° de réservation » affichée(s)`,
    };
  }
  return {
    servie: false,
    vide: false,
    raison: 'la page ne montre ni carte de réservation, ni la phrase « aucune réservation »',
  };
}

/** Ce que la page montre, ramassé en une passe pour `etatDesReservations`. */
async function photographier(page) {
  return page.evaluate((motifCarte) => {
    const texte = (document.body?.innerText || '').slice(0, 30_000);
    const reCarte = new RegExp(motifCarte, 'i');
    return {
      url: location.href,
      texte,
      boutonSeConnecter: [...document.querySelectorAll('button, a')].some((el) =>
        /^\s*se connecter\s*$/i.test((el.innerText || '').trim())),
      // Une carte = le nœud le plus PROFOND qui porte « N° de réservation » :
      // chaque réservation affiche le sien, les compter c'est les voir. Les
      // scripts sont écartés — l'état embarqué d'une application peut porter
      // le même libellé sans que rien ne soit à l'écran.
      reservations: [...document.querySelectorAll('*')].filter((el) =>
        !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
        && reCarte.test(el.innerText || '')
        && ![...el.children].some((enfant) => reCarte.test(enfant.innerText || ''))).length,
    };
  }, MOTIF_CARTE_RESERVATION.source)
    .catch(() => ({ url: page.url(), texte: '', boutonSeConnecter: false, reservations: 0 }));
}

/**
 * Ramène la page sur l'onglet « Passés » quand le site a redirigé ailleurs
 * ALORS QUE la session est là.
 *
 * Mesuré le 20/08/2026 (deux sondes à quelques minutes d'écart, même profil) :
 * la navigation directe vers /user/bookings/past-bookings est parfois servie,
 * parfois renvoyée vers l'accueil /fr-FR — avec le compte connecté (« Mes
 * voyages », initiales à l'écran). Le geste qui marche est celui de
 * l'utilisateur : cliquer « Mes voyages » (arrivée sur l'onglet « A VENIR »),
 * puis l'onglet « PASSÉS ». Deux liens mesurés, rien d'autre.
 */
async function ramenerSurLesPasses(page, log = () => {}) {
  const urlCourante = (() => { try { return page.url(); } catch { return ''; } })();
  if (/\/user\/bookings\/past/i.test(urlCourante)) return;

  const clicVoyages = await page.evaluate(() => {
    const bouton = [...document.querySelectorAll('button, a')]
      .find((el) => /^\s*mes voyages\s*$/i.test((el.innerText || '').trim()));
    if (!bouton) return false;
    bouton.click();
    return true;
  }).catch(() => false);
  if (!clicVoyages) return;
  log(`${ID} : la page des réservations a renvoyé vers l'accueil alors que la session est là — `
    + 'passage par « Mes voyages » puis l\'onglet « PASSÉS », comme à la main.');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3_000).catch(() => {});
  await page.evaluate(() => {
    const onglet = [...document.querySelectorAll('[role="tab"], a, button')]
      .find((el) => /^\s*pass[ée]s?\s*$/i.test((el.innerText || '').trim()));
    if (onglet) onglet.click();
  }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3_000).catch(() => {});
}

function erreurPageInconnue(raison) {
  return new Error(
    `OUIGO a affiché une page qui n'est ni vos réservations passées ni un espace connecté `
      + `(${raison}) : impossible de dire s'il y a des documents. Rouvrez la connexion depuis `
      + 'la fiche du service, puis relancez la récupération.'
  );
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, et l'onglet des passés répond. */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return authSncf.surLeProfil({ id: ID, nom: NOM, ctx, urlDepart: URL_PASSES }, async (page) => {
    // Le site renvoie parfois l'arrivée directe vers l'accueil, session
    // pourtant valide (mesuré le 20/08/2026) : on refait le geste de
    // l'utilisateur avant de juger la page.
    await ramenerSurLesPasses(page, log);
    const etat = etatDesReservations(await photographier(page));
    if (!etat.servie) {
      log(`${ID} : ${etat.raison}.`);
      // Une session absente se dit comme telle : le geste attendu est « Se
      // connecter », pas « signalez un défaut de reconnaissance » (lot 37).
      if (etat.sessionAbsente) throw authSncf.erreurSessionExpiree(NOM, etat.raison);
      throw erreurPageInconnue(etat.raison);
    }
    const reservations = etat.reservations || 0;
    return {
      ok: true,
      accountId: null,
      invoiceCount: reservations,
      message: etat.vide
        ? 'Connexion valide — aucune réservation passée pour le moment. Les justificatifs '
          + 'arriveront ici quand un voyage aura été effectué.'
        : `Connexion valide — ${reservations} réservation(s) passée(s) visible(s).`,
    };
  });
}

/**
 * Ouvre la n-ième réservation de la liste.
 *
 * Une carte n'a AUCUN libellé cliquable (mesuré le 20/08/2026) : son seul
 * bouton est un chevron sans texte. On part donc du marqueur « N° de
 * réservation », qui est le seul repère stable — les classes CSS du site sont
 * générées — et on remonte vers le premier ancêtre qui porte un bouton.
 */
async function ouvrirReservation(page, rang) {
  return page.evaluate(({ motif, cible }) => {
    const re = new RegExp(motif, 'i');
    const marqueurs = [...document.querySelectorAll('*')].filter(
      (el) =>
        !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
        && re.test(el.innerText || '')
        && ![...el.children].some((enfant) => re.test(enfant.innerText || ''))
    );
    const marqueur = marqueurs[cible];
    if (!marqueur) return false;
    let noeud = marqueur;
    for (let i = 0; i < 8 && noeud; i++) {
      const bouton = noeud.querySelector?.('button');
      if (bouton) {
        bouton.click();
        return true;
      }
      noeud = noeud.parentElement;
    }
    return false;
  }, { motif: MOTIF_CARTE_RESERVATION.source, cible: rang }).catch(() => false);
}

/**
 * Depuis le détail d'une réservation, ouvre l'écran « Téléchargement des
 * billets » — le bouton « Accéder à vos billets ». Les libellés qui parlent
 * d'e-mail sont écartés AVANT le clic : déclencher un envoi n'appartient pas
 * à crabe.
 */
async function ouvrirEcranDesBillets(page) {
  return page.evaluate(({ acces, email }) => {
    const reAcces = new RegExp(acces, 'i');
    const reEmail = new RegExp(email, 'i');
    const bouton = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => el.offsetWidth || el.offsetHeight)
      .find((el) => {
        const texte = (el.innerText || '').normalize('NFC').replace(/\s+/g, ' ').trim();
        return texte && reAcces.test(texte) && !reEmail.test(texte);
      });
    if (!bouton) return false;
    bouton.click();
    return true;
  }, { acces: MOTIF_ACCES_BILLETS.source, email: MOTIF_ENVOI_EMAIL.source }).catch(() => false);
}

/** Les libellés des boutons au nom du passager, dans l'ordre de la page. */
async function libellesDesPassagers(page) {
  return page.evaluate(({ passager, email }) => {
    const rePassager = new RegExp(passager);
    const reEmail = new RegExp(email, 'i');
    return [...document.querySelectorAll('button')]
      .filter((el) => el.offsetWidth || el.offsetHeight)
      .map((el) => (el.innerText || '').normalize('NFC').replace(/\s+/g, ' ').trim())
      .filter((texte) => texte && rePassager.test(texte) && !reEmail.test(texte));
  }, { passager: MOTIF_BOUTON_PASSAGER.source, email: MOTIF_ENVOI_EMAIL.source }).catch(() => []);
}

/**
 * Clique le bouton d'un passager et lit le billet que l'onglet sert.
 *
 * Mesuré le 20/08/2026 : l'onglet s'ouvre sur une adresse en `.pdf` servie par
 * `ous-prd-tickets.pasngr.com`, `contentType` `application/pdf`. Aucun
 * événement « download » n'arrive — c'est une navigation, pas un
 * téléchargement, exactement comme le justificatif SNCF Connect.
 *
 * @returns {Promise<{ok: true, buffer: Buffer, adresse: string}
 *   | {ok: false, grief: string}>}
 */
async function billetDuPassager(page, context, libelle) {
  let nouvelOnglet = null;
  let reponsePdf = null;
  const surReponse = async (reponse) => {
    try {
      if (reponsePdf) return;
      const type = (await reponse.headerValue('content-type')) || '';
      if (/pdf/i.test(type)) reponsePdf = reponse;
    } catch { /* réponse déjà close : l'onglet reste lisible par ailleurs */ }
  };
  const surNouvellePage = (p) => {
    if (nouvelOnglet) return;
    nouvelOnglet = p;
    p.on?.('response', surReponse);
  };
  context?.on?.('page', surNouvellePage);

  try {
    const clique = await page.evaluate((texte) => {
      const bouton = [...document.querySelectorAll('button')]
        .filter((el) => el.offsetWidth || el.offsetHeight)
        .find((el) => (el.innerText || '').normalize('NFC').replace(/\s+/g, ' ').trim() === texte);
      if (!bouton) return false;
      bouton.click();
      return true;
    }, libelle).catch(() => false);
    if (!clique) {
      return { ok: false, grief: `le bouton « ${libelle} » n'était plus dans la page` };
    }

    // On attend l'onglet, puis sa réponse PDF — jamais un « download », qui
    // n'arrive pas et coûterait quarante-cinq secondes d'attente pour rien.
    const fin = Date.now() + authSncf.NAV_TIMEOUT_MS;
    while (Date.now() < fin && !reponsePdf) {
      if (nouvelOnglet && reponsePdf) break;
      await page.waitForTimeout(250).catch(() => {});
    }
    if (!nouvelOnglet) return { ok: false, grief: 'aucun onglet ne s\'est ouvert après le clic' };
    return await ongletPdf.lireDocumentDeLOnglet(nouvelOnglet, reponsePdf);
  } finally {
    context?.off?.('page', surNouvellePage);
  }
}

/**
 * L'identifiant distant s'ancre sur la RÉSERVATION, plus sur le fichier
 * (lot 46).
 *
 * L'empreinte du document — même privée de son enveloppe datée, la leçon du
 * lot 44 — n'a pas tenu deux jours : le 22/08/2026, les cinq billets sont
 * revenus sous d'autres octets ET d'autres tailles. Mesuré sur les paires
 * réelles : le texte des deux versions est identique au caractère près, mais
 * le générateur pose un nom de ressource ALÉATOIRE jusque dans les flux
 * compressés, plus un champ opaque `/Source` et le `/ID` du trailer. Rien de
 * normalisable : l'identifiant vient de ce que le billet DIT.
 *
 * C'est le numéro de réservation imprimé sur le billet — celui-là même que la
 * liste des « Passés » affiche sur chaque carte — complété du passager, parce
 * qu'une réservation à plusieurs voyageurs sert un billet PAR passager et que
 * les confondre en perdrait un sans bruit (`connectors/identite-voyage.js`,
 * qui porte la mesure). Un billet qui ne se lit pas retombe sur l'empreinte
 * du lot 44 : le doublon possible — rattrapable —, jamais la perte.
 */
function remoteIdPour(buffer) {
  return identite.remoteIdOuigo(buffer)
    || empreinte.empreinteStable(buffer, { prefixe: ID });
}

/**
 * Le suffixe du nom de fichier : la référence et le passager haché quand
 * l'identifiant est métier (`ouigo-ZH8PL4-a1b2c3d4` → `ZH8PL4-a1b2c3d4`),
 * la fin de l'empreinte sinon — la forme des noms déjà déposés.
 */
function suffixeDeFichier(remoteId) {
  return remoteId.startsWith(`${ID}-`) ? remoteId.slice(ID.length + 1) : remoteId.slice(-8);
}

/** Une date « 12 juillet 2026 » ou « 12/07/2026 » lue sur le détail courant. */
async function dateDuVoyage(page) {
  const texte = await page.evaluate(() =>
    (document.body?.innerText || '').slice(0, 6_000)).catch(() => '');
  const lireDate = require('../../scraping').normalizeFrenchDate;
  for (const morceau of texte.split('\n')) {
    const date = lireDate(morceau);
    if (date) return date;
  }
  return null;
}

/**
 * Récupère les billets des réservations passées.
 *
 * ─── Le parcours, mesuré de bout en bout le 20/08/2026 ───────────────────────
 *
 * Deux descriptions circulaient, qu'on croyait contradictoires. Elles sont les
 * deux moitiés d'un MÊME chemin, et la sonde les a recollées :
 *
 *   liste « PASSÉS » → chevron d'une carte → `/fr-FR/after-sale/details`
 *   → bouton « Accéder à vos billets » → `/fr-FR/after-sale/tickets`
 *   (« Téléchargement des billets ») → bouton au NOM DU PASSAGER
 *   → onglet servant un `application/pdf` sur `ous-prd-tickets.pasngr.com`.
 *
 * Un détail qui change tout pour le code : l'adresse du détail est
 * `/after-sale/details` pour TOUTES les réservations — elle ne porte pas la
 * référence. On ne peut donc pas y aller directement : chaque réservation se
 * rouvre depuis la liste, comme le fait SNCF Connect.
 *
 * ─── L'identifiant distant est ancré sur la réservation (lot 46) ─────────────
 *
 * L'empreinte du document — même normalisée, la leçon du lot 44 — n'a pas
 * survécu au 22/08/2026 : le billet est regénéré avec un nom de ressource
 * aléatoire, sa taille même change. L'identifiant vient de ce que le billet
 * DIT — numéro de réservation et passager, `connectors/identite-voyage.js` :
 * deux passages sur la même réservation n'écrivent qu'une ligne, quels que
 * soient les octets servis.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return authSncf.surLeProfil({ id: ID, nom: NOM, ctx, urlDepart: URL_PASSES }, async (page, context) => {
    // Même rattrapage que `test()` : le site renvoie parfois l'arrivée directe
    // vers l'accueil, session pourtant valide (mesuré le 20/08/2026).
    await ramenerSurLesPasses(page, log);
    const etat = etatDesReservations(await photographier(page));
    if (!etat.servie) {
      log(`${ID} : ${etat.raison}.`);
      // Une session absente se dit comme telle : le geste attendu est « Se
      // connecter », pas « signalez un défaut de reconnaissance » (lot 37).
      if (etat.sessionAbsente) throw authSncf.erreurSessionExpiree(NOM, etat.raison);
      throw erreurPageInconnue(etat.raison);
    }

    const reservations = etat.reservations || 0;

    // La preuve exigée par le socle (lot 31) : la page des réservations a été
    // servie À CE COMPTE (l'adresse a tenu, pas de « Se connecter »), et la
    // liste a été lue — fût-elle vide, ce que la page écrit alors mot pour
    // mot. Sans cette preuve, « aucune nouvelle facture » serait refusé.
    ctx.preuveDeListe?.({
      session: `page des réservations servie au compte connecté (${etat.raison})`,
      liste: 'onglet « Passés » de ventes.ouigo.com',
      elements: reservations,
    });

    if (etat.vide) {
      log(`${ID} : aucune réservation passée — rien à récupérer, et c'est un résultat prouvé.`);
      return { accountId: null, invoices: [] };
    }

    log(`${ID} : ${reservations} réservation(s) passée(s) affichée(s).`);

    const invoices = [];
    let sansEcranBillets = 0;
    let sansPassager = 0;

    for (let rang = 0; rang < reservations; rang++) {
      // La liste se rejoue à chaque tour : le détail s'ouvre sur la MÊME
      // adresse pour toutes les réservations, revenir en arrière ne suffit pas
      // à savoir laquelle est à l'écran.
      if (rang > 0) {
        await page.goto(URL_PASSES, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(PAUSE_ECRAN_MS).catch(() => {});
        await authSncf.fermerBandeauCookies(page, () => {});
        await ramenerSurLesPasses(page, () => {});
      }

      if (!(await ouvrirReservation(page, rang))) {
        log(`${ID} : réservation ${rang + 1} — sa carte n'a pas pu être ouverte, on continue.`);
        continue;
      }
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(PAUSE_ECRAN_MS).catch(() => {});

      const issuedOn = await dateDuVoyage(page);

      if (!(await ouvrirEcranDesBillets(page))) {
        sansEcranBillets++;
        log(
          `${ID} : réservation ${rang + 1} — le détail ne propose pas « Accéder à vos billets ». `
            + 'Rien n\'a été récupéré pour celle-ci.'
        );
        continue;
      }
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(PAUSE_ECRAN_MS).catch(() => {});

      const passagers = await libellesDesPassagers(page);
      if (!passagers.length) {
        sansPassager++;
        log(
          `${ID} : réservation ${rang + 1} — l'écran des billets n'affiche aucun bouton au nom `
            + 'd\'un passager. Rien n\'a été récupéré pour celle-ci.'
        );
        continue;
      }

      for (const passager of passagers) {
        const obtenu = await billetDuPassager(page, context, passager);
        if (!obtenu.ok) {
          log(
            `${ID} : réservation ${rang + 1} — le billet d'un passager n'a pas été lu `
              + `(${obtenu.grief}). On continue.`
          );
          continue;
        }

        const remoteId = remoteIdPour(obtenu.buffer);
        if (connus.has(remoteId)) continue;
        connus.add(remoteId);

        invoices.push({
          remoteId,
          filename: `${ID}_billet_${issuedOn || 'date-inconnue'}_${suffixeDeFichier(remoteId)}.pdf`,
          issuedOn,
          buffer: obtenu.buffer,
        });
        await page.waitForTimeout(PAUSE_DOCUMENT_MS).catch(() => {});
      }
    }

    if (sansEcranBillets) {
      log(`${ID} : ${sansEcranBillets} réservation(s) sans bouton « Accéder à vos billets ».`);
    }
    if (sansPassager) {
      log(`${ID} : ${sansPassager} réservation(s) dont l'écran des billets n'a nommé aucun passager.`);
    }
    log(`${ID} : ${invoices.length} billet(s) récupéré(s) sur ${reservations} réservation(s).`);

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  etatDesReservations,
  photographier,
  ramenerSurLesPasses,
  ouvrirReservation,
  ouvrirEcranDesBillets,
  libellesDesPassagers,
  billetDuPassager,
  remoteIdPour,
  suffixeDeFichier,
  MOTIF_AUCUNE_RESERVATION,
  MOTIF_CARTE_RESERVATION,
  MOTIF_TELECHARGER,
  MOTIF_ENVOI_EMAIL,
  MOTIF_ACCES_BILLETS,
  MOTIF_BOUTON_PASSAGER,
  URL_PASSES,
};
