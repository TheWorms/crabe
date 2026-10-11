'use strict';

/**
 * Connecteur Coyote (moncoyote.com) — les factures d'abonnement (lot 79).
 *
 * ─── D'où vient ce que ce connecteur sait ────────────────────────────────────
 *
 * MESURÉ le 09/09/2026 (sonde anonyme, Chromium du socle, profil jetable,
 * le serveur de production — scripts/lot79-reco-autodoc-coyote.js) :
 *
 *   - en HTTP nu, tout est 403 derrière Cloudflare ; le Chromium complet du
 *     socle passe (200) — d'où le profil persistant et la fenêtre visible ;
 *   - `/fr/users/auth` est l'écran d'identification (champs e-mail et mot de
 *     passe, reCAPTCHA dans la page) ;
 *   - `/fr/users/account/my-invoices` demandé SANS session est renvoyé vers
 *     `/fr/users/auth` — le motif générique (`/auth`) le reconnaît, et le
 *     renvoi mesuré fonde `renvoiAnonyme: "connexion"` du manifeste ;
 *   - un chemin inventé rend un vrai 404.
 *
 * RELEVÉ par l'utilisateur sur sa session (09/09/2026), formes seulement, PAS encore
 * lu en automatique : la page des factures porte DEUX sections — « Mes
 * factures en attente de paiement » et « Mes autres factures » — chacune
 * dépliable ; chaque ligne montre « N° de facture : <n°> », une date, un
 * montant et un bouton « Télécharger ».
 *
 * ─── ⚠ LE BOUTON « PAYER » NE SE TOUCHE JAMAIS ──────────────────────────────
 *
 * La section « en attente » porte un bouton « Payer » en tête, et sa colonne
 * de droite affiche des avertissements de paiement. AUCUN déclencheur de
 * règlement n'est cliqué, JAMAIS : chaque clic de ce connecteur passe par une
 * garde (`MOTIF_REGLEMENT`) qui refuse tout élément dont le libellé évoque un
 * paiement — le dépliage vise le TITRE de section, le téléchargement vise le
 * seul « Télécharger » de la ligne. Les DEUX sections sont parcourues : une
 * facture en attente de paiement reste une facture, et l'utilisateur veut la
 * récupérer.
 *
 * ─── L'ancre, et les données personnelles (§1bis) ───────────────────────────
 *
 * `remote_id` = `coyote-facture-<numéro>` : le numéro de facture affiché sur
 * la ligne. `issued_on` = la date affichée. Les montants et les avertissements
 * de paiement ne sont NI lus NI journalisés : l'extraction capture le numéro
 * et la date, rien d'autre — jamais une recopie du texte des lignes.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');
const history = require('../../history');
const serieEchecs = require('../../serie-echecs');
const { normalizeFrenchDate } = require('../../scraping');

const ID = 'coyote';
const NOM = 'Coyote';
const CHAMP_HISTORIQUE = 'historique';

/** La page des factures — relevé de l'utilisateur 09/09/2026, redirection mesurée. */
const URL_FACTURES = 'https://www.moncoyote.com/fr/users/account/my-invoices';
const CHEMIN_FACTURES = /\/users\/account\/my-invoices(?:[/?#]|$)/i;

/** Une ligne de facture se reconnaît à son libellé (relevé, forme seule). */
const MOTIF_REPERE = /n[°o]\s*de\s*facture/i;

/** Les titres des deux sections, relevés à l'écran. */
const MOTIF_SECTION = /mes\s+(autres\s+factures|factures\s+en\s+attente\s+de\s+paiement)/i;

/**
 * La garde absolue : rien dont le libellé évoque un règlement n'est JAMAIS
 * cliqué. Vérifiée avant chaque clic de ce connecteur.
 */
const MOTIF_REGLEMENT = /payer|r[ée]gler|r[èe]glement|paiement|\bpay\b|carte\s+bancaire|pr[ée]l[èe]vement/i;

/** `/fr/users/auth` est couvert par le motif générique (`/auth`). */
function estPageAuthentification(url) {
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni vos factures ni un espace connecté (${raison}) : `
      + 'impossible de dire s\'il y a des documents. Rouvrez la connexion depuis la fiche du '
      + 'service, puis relancez la récupération.'
  );
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLesFactures(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_FACTURES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_FACTURES,
        estAuthentification: estPageAuthentification,
        // Mesuré le 09/09/2026 : my-invoices éconduit les anonymes vers
        // /fr/users/auth — y rester sans « Se connecter » prouve la session.
        redirigeLesAnonymes: true,
        motifRepere: MOTIF_REPERE,
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw erreurPageInconnue(etat.raison);
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// Lecture de la page — extraction DANS la page, analyse PURE côté Node
// ---------------------------------------------------------------------------

/**
 * Déplie les sections : le clic vise le nœud le plus profond qui porte le
 * TITRE de section — jamais un élément dont le libellé évoque un règlement
 * (le « Payer » vit en tête de la section « en attente »). Rend le nombre de
 * titres cliqués.
 */
const DEPLIER_SECTIONS = ({ motifSection, motifReglement }) => {
  const reSection = new RegExp(motifSection, 'i');
  const reReglement = new RegExp(motifReglement, 'i');
  let cliques = 0;
  const titres = [...document.querySelectorAll('*')]
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'BODY'].includes(el.tagName)
      && reSection.test((el.innerText || '').replace(/\s+/g, ' '))
      && ![...el.children].some((c) => reSection.test((c.innerText || '').replace(/\s+/g, ' '))));
  for (const titre of titres) {
    const libelle = (titre.innerText || '').replace(/\s+/g, ' ');
    // La garde absolue : un titre qui porterait AUSSI un libellé de règlement
    // n'est pas cliqué — mieux vaut une section repliée qu'un règlement. Le
    // titre légitime contient « paiement » (« Mes factures en attente de
    // paiement ») : il est retiré du libellé AVANT la garde, elle ne juge que
    // ce qui l'accompagne.
    if (reReglement.test(libelle.replace(reSection, ' '))) continue;
    try { titre.scrollIntoView(); } catch { /* hors défilement */ }
    titre.click();
    cliques += 1;
  }
  return cliques;
};

/**
 * Les lignes de facture visibles : pour chacune, le NUMÉRO (ce qui suit
 * « N° de facture : ») et le TEXTE DE DATE de la même ligne — rien d'autre
 * (§1bis : ni montant, ni avertissement de paiement). La date est cherchée
 * dans le conteneur proche du numéro, par ses seules formes de date.
 */
const EXTRAIRE_LIGNES = () => {
  const reNumero = /n[°o]\s*de\s*facture\s*:?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,30})/i;
  const reDate = /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+\p{L}+\.?\s+\d{4})\b/u;
  const profonds = [...document.querySelectorAll('*')]
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
      && reNumero.test(el.innerText || '')
      && ![...el.children].some((c) => reNumero.test(c.innerText || '')));
  const lignes = [];
  for (const el of profonds) {
    // Le conteneur de LIGNE : on remonte jusqu'à trouver une date à côté du
    // numéro, sans jamais recopier le texte — seules les deux captures sortent.
    let conteneur = el;
    let numero = null;
    let dateTexte = null;
    for (let n = 0; n < 4 && conteneur; n++, conteneur = conteneur.parentElement) {
      const texte = (conteneur.innerText || '').replace(/\s+/g, ' ');
      numero = numero || reNumero.exec(texte)?.[1] || null;
      dateTexte = dateTexte || reDate.exec(texte)?.[1] || null;
      if (numero && dateTexte) break;
    }
    if (numero && !lignes.some((l) => l.numero === numero)) {
      lignes.push({ numero, dateTexte });
    }
  }
  return lignes;
};

/**
 * Clique le « Télécharger » de la ligne qui porte CE numéro — et rien
 * d'autre : la garde de règlement est vérifiée sur le déclencheur ET sur son
 * libellé d'accessibilité avant tout clic.
 */
const CLIQUER_TELECHARGER = ({ numero, motifReglement }) => {
  const reReglement = new RegExp(motifReglement, 'i');
  const porteurs = [...document.querySelectorAll('*')]
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
      && (el.innerText || '').includes(numero)
      && ![...el.children].some((c) => (c.innerText || '').includes(numero)));
  const noeud = porteurs[0];
  if (!noeud) return false;
  let conteneur = noeud;
  for (let n = 0; n < 5 && conteneur; n++, conteneur = conteneur.parentElement) {
    const declencheur = [...conteneur.querySelectorAll('a, button, [role="button"]')]
      .filter((el) => el.offsetWidth || el.offsetHeight)
      .find((el) => {
        const libelle = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))
          .replace(/\s+/g, ' ').trim();
        return /t[ée]l[ée]charger/i.test(libelle) && !reReglement.test(libelle);
      });
    if (declencheur) {
      try { declencheur.scrollIntoView(); } catch { /* hors défilement */ }
      declencheur.click();
      return true;
    }
  }
  return false;
};

/** L'ancre — le numéro de facture affiché, espaces retirés. */
function remoteIdFacture(numero) {
  return `${ID}-facture-${String(numero).replace(/[\s/]+/g, '-')}`;
}

/** La date affichée, ramenée à l'ISO — deux lecteurs, comme Bricomarché. */
function dateFacture(dateTexte) {
  return normalizeFrenchDate(dateTexte) || documentsDePage.dateDepuisTexte(dateTexte);
}

/** La borne basse de la fenêtre, d'après le réglage d'historique du compte. */
function borneHistorique(config, ctx) {
  return history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    plafondMois: ctx?.conservationMois || 0,
  });
}

/** La phrase que la carte porte toujours (champ `precision`, lot 70). */
function phrasePrecision(vues) {
  return `— ${vues} facture(s) listée(s) dans votre espace client, sections « en attente de `
    + 'paiement » et « autres factures » confondues ; seul le bouton « Télécharger » de chaque '
    + 'ligne est utilisé, jamais un bouton de règlement.';
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la page des factures répond. */
async function test(config, ctx = {}) {
  return surLesFactures(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — votre espace client ${NOM} est servi à votre compte `
      + `(${etat.reperes} repère(s) de facture affiché(s)). Les factures seront lues à la `
      + 'prochaine récupération.',
  }));
}

/**
 * Lit les deux sections de la page des factures et télécharge chaque facture
 * inconnue par son bouton « Télécharger ». Idempotent par l'ancre : une
 * facture déjà déposée n'est pas recliquée. AUCUN bouton de règlement n'est
 * jamais approché (voir l'en-tête).
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const fenetre = borneHistorique(config, ctx);

  return surLesFactures(ctx, async (etat, vue, page, context) => {
    // Passe 1 : ce qui est déjà visible. Passe 2 : après dépliage des titres
    // de section (un titre déjà ouvert peut se replier au clic — la première
    // passe a déjà gardé ses lignes, l'union des deux couvre tous les cas).
    const passe1 = (await page.evaluate(EXTRAIRE_LIGNES).catch(() => [])) || [];
    const depliees = await page.evaluate(DEPLIER_SECTIONS, {
      motifSection: MOTIF_SECTION.source,
      motifReglement: MOTIF_REGLEMENT.source,
    }).catch(() => 0);
    if (depliees) await page.waitForTimeout(2000).catch(() => {});
    const passe2 = (await page.evaluate(EXTRAIRE_LIGNES).catch(() => [])) || [];

    const lignes = [...passe1];
    for (const ligne of passe2) {
      if (!lignes.some((l) => l.numero === ligne.numero)) lignes.push(ligne);
    }

    // La preuve exigée par le socle (lot 31) — la liste est LUE, fût-elle vide.
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: URL_FACTURES,
      elements: lignes.length,
    });
    log(`${ID} : ${lignes.length} ligne(s) de facture visibles (${passe1.length} avant dépliage, `
      + `${depliees} titre(s) de section clique(s) — jamais un bouton de règlement).`);
    log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);

    const borne = fenetre.from ? fenetre.from.toISOString().slice(0, 10) : null;
    const invoices = [];
    let dejaConnues = 0;
    let horsFenetre = 0;
    let illisibles = 0;
    let ratees = 0;
    // La sortie anticipée (lot 80) : 55 fois le même échec, c'est 27 minutes
    // pour rien. Trois suffisent à connaître la cause.
    const serie = serieEchecs.suiteDEchecs();
    let renoncement = null;

    for (const ligne of lignes) {
      const remoteId = remoteIdFacture(ligne.numero);
      if (connus.has(remoteId)) { dejaConnues += 1; continue; }

      const issuedOn = dateFacture(ligne.dateTexte);
      if (!issuedOn) {
        illisibles += 1;
        log(`${ID} : facture ${ligne.numero} — la date affichée ne se lit pas `
          + `(« ${ligne.dateTexte || '(absente)'} ») ; rien produit pour elle, le prochain `
          + 'passage réessaiera.');
        continue;
      }
      if (borne && issuedOn < borne) { horsFenetre += 1; continue; }

      const obtenu = await clicDocument.documentDuClic(
        page, context,
        () => page.evaluate(CLIQUER_TELECHARGER, {
          numero: String(ligne.numero),
          motifReglement: MOTIF_REGLEMENT.source,
        }).catch(() => false)
      );
      if (!obtenu.ok) {
        ratees += 1;
        log(`${ID} : facture ${ligne.numero} — aucun document obtenu (${obtenu.grief}) ; `
          + 'le prochain passage réessaiera.');
        if (serie.echec(obtenu.grief)) {
          renoncement = serie.phrasePublique();
          log(`${ID} : ${serie.raison()}`);
          break;
        }
        continue;
      }
      serie.reussite();
      connus.add(remoteId);
      invoices.push({
        remoteId,
        filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
        issuedOn,
        buffer: obtenu.buffer,
      });
      log(`${ID} : facture ${ligne.numero} — lue (voie mesurée : ${obtenu.voie}, `
        + `${obtenu.buffer.length} octets).`);
    }

    log(`${ID} : ${lignes.length} facture(s) vue(s), ${invoices.length} déposée(s)`
      + `${dejaConnues ? `, ${dejaConnues} déjà déposée(s)` : ''}`
      + `${horsFenetre ? `, ${horsFenetre} hors de la période demandée` : ''}`
      + `${ratees ? `, ${ratees} non obtenue(s)` : ''}`
      + `${illisibles ? `, ${illisibles} illisible(s)` : ''}.`);

    return {
      accountId: null,
      invoices,
      // Ce qui a été TENTÉ et manqué (lot 80) : c'est ce compte qui empêche
      // « Aucune nouvelle facture » de recouvrir un échec complet. Les
      // factures hors période n'en sont pas — elles ont leur propre phrase.
      manquees: ratees + illisibles,
      renoncement: renoncement || undefined,
      precision: phrasePrecision(lignes.length),
      couverture: { detail: 'les deux sections de la page des factures, telles qu\'affichées' },
      aucunDocument: lignes.length === 0
        ? `Votre espace client ${NOM} n'affiche aucune facture reconnue : soit il n'y en a pas, `
          + 'soit la présentation a changé — le journal porte le compte de ce qui était affiché.'
        : undefined,
      horsPeriode: lignes.length > 0 && !invoices.length && horsFenetre > 0 && !illisibles && !ratees
        ? `Les ${lignes.length} facture(s) de votre espace client sont toutes antérieures à la `
          + 'période demandée — élargissez l\'historique de la fiche pour les récupérer.'
        : undefined,
    };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  URL_FACTURES,
  CHEMIN_FACTURES,
  MOTIF_REPERE,
  MOTIF_SECTION,
  MOTIF_REGLEMENT,
  DEPLIER_SECTIONS,
  EXTRAIRE_LIGNES,
  CLIQUER_TELECHARGER,
  remoteIdFacture,
  dateFacture,
  phrasePrecision,
  borneHistorique,
};
