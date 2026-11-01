'use strict';

/**
 * Connecteur BlaBlaCar — reçus reconstitués PAR TRAJET (0.2.16, lot l7).
 *
 * Décisions du compte observé, le 01/11/2026 : BlaBlaCar ne remet aucun reçu à
 * télécharger (une ligne de paiement ne s'ouvre sur rien) ; crabe reconstitue
 * donc un reçu par trajet, à partir de la page « Paiements & remboursements ».
 *
 * MESURÉ le 01/11/2026 sur son compte (relevé de page nettoyé) :
 *
 *   - la page : `www.blablacar.fr/dashboard/account/payments-history`
 *     (« Paiements & remboursements ») ;
 *   - les lignes : `li[data-testid="legacy-items-list-item"]`, rangées sous un
 *     intertitre h2 qui est l'ANNÉE ; chacune dit l'opération et sa date
 *     (« Payé le 23 oct. », « Remboursé le 23 oct. »), le trajet (« 23 oct.
 *     Nantes → Pontchâteau ») et le montant (« -5,99 € », « +2,50 € ») ;
 *   - la connexion est gardée par DataDome : profil de navigateur VISIBLE et
 *     persistant (`profil-marchand`), comme Boulanger.
 *
 * Un reçu reprend les lignes d'un même trajet TELLES QU'AFFICHÉES — crabe
 * n'additionne rien. Il ne s'écrit qu'une fois le trajet passé de
 * `DELAI_APRES_TRAJET_JOURS` : un remboursement arrive souvent après le
 * paiement, et un reçu déposé ne se réécrit pas.
 */

const nodeCrypto = require('node:crypto');
const profilMarchand = require('../../profil-marchand');
const releve = require('../../releve-reconstitue');
const scraping = require('../../scraping');

const ID = 'blablacar';
const NOM = 'BlaBlaCar';
const URL_PAIEMENTS = 'https://www.blablacar.fr/dashboard/account/payments-history';
const CHEMIN_LISTE = /\/dashboard\/account\/payments-history\/?(?:[?#]|$)/i;

/** Un trajet n'est reconstitué qu'une fois passé de ce délai : ses remboursements sont alors connus. */
const DELAI_APRES_TRAJET_JOURS = 7;
const DELAI_PEINTURE_MS = 15_000;

const MOIS = {
  janv: 1, 'janv.': 1, janvier: 1, fevr: 2, 'févr': 2, 'févr.': 2, fevrier: 2, 'février': 2, mars: 3, avr: 4, 'avr.': 4, avril: 4,
  mai: 5, juin: 6, juil: 7, 'juil.': 7, juillet: 7, aout: 8, 'août': 8, sept: 9, 'sept.': 9, septembre: 9,
  oct: 10, 'oct.': 10, octobre: 10, nov: 11, 'nov.': 11, novembre: 11, dec: 12, 'déc': 12, 'déc.': 12, decembre: 12, 'décembre': 12,
};

const MOTIF_OPERATION = /(Pay[ée]|Rembours[ée]|D[ée]bit[ée]|Cr[ée]dit[ée])\s+le\s+(\d{1,2})\s+([a-zéûèô.]+)/i;
/** La date du trajet, en tête de ce qui suit l'opération : « 23 oct. ». */
const MOTIF_DATE_TRAJET = /^\s*(\d{1,2})\s+([a-zéûèô.]+)\s+/i;
/** Le montant, en FIN de ligne : « -5,99 € », « +2,50 € ». */
const MOTIF_MONTANT = /([+−-])\s?(\d+(?:[.,]\d{1,2})?)\s?€\s*$/;

/** L'écran de connexion de BlaBlaCar : `/login`, et ses variantes. */
function estPageAuthentification(url) {
  return profilMarchand.estPageAuthentification(url);
}

function moisDe(texte) {
  const cle = String(texte || '').toLowerCase().replace(/\.$/, '');
  return MOIS[cle] || MOIS[`${cle}.`] || null;
}

function isoDe(annee, jour, mois) {
  const m = moisDe(mois);
  if (!annee || !m) return null;
  return `${annee}-${String(m).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
}

/**
 * Une ligne de la page → `{ operation, le, trajetLe, trajet, montant, texte }`,
 * ou null si elle n'a pas la forme mesurée. `annee` : l'intertitre de sa
 * section.
 */
function lireLigne(texte, annee) {
  const brut = String(texte || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\u2212/g, '-').trim();
  return lireLigneEnColonnes(brut, annee) || lireLigneCollee(brut, annee);
}

/** Une opération seule sur sa ligne : « Payé le 22 oct. ». */
const MOTIF_OPERATION_SEULE = new RegExp(`^${MOTIF_OPERATION.source}\\s*$`, 'i');
/** Une date de trajet seule sur sa ligne : « 23 oct. ». */
const MOTIF_DATE_SEULE = /^(\d{1,2})\s+([a-zéûèô.]+)\s*$/i;
/** Un montant seul sur sa ligne : « -5,99 € », « +2,50 € ». */
const MOTIF_MONTANT_SEUL = /^([+-])\s?(\d+(?:[.,]\d{1,2})?)\s?€\s*$/;

/**
 * La forme MESURÉE le 01/11/2026 (n° 965, puis la forme du texte relevée en
 * console) : une phrase d'accessibilité (« Trajet de covoiturage de A à B le
 * 23 oct. Payé le 22 oct. au tarif total de 5,99 €. »), puis, chacun sur SA
 * ligne : l'opération, la date du trajet, l'itinéraire, le montant — et
 * parfois, après, une note. La phrase porte aussi « Payé le … » : lire le
 * texte d'un seul tenant s'y accrochait, et aucune ligne n'était reconnue.
 */
function lireLigneEnColonnes(brut, annee) {
  const lignes = brut.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  for (let i = 0; i + 3 < lignes.length; i++) {
    const op = MOTIF_OPERATION_SEULE.exec(lignes[i]);
    const date = MOTIF_DATE_SEULE.exec(lignes[i + 1]);
    const montant = MOTIF_MONTANT_SEUL.exec(lignes[i + 3]);
    if (!op || !date || !montant || !lignes[i + 2].includes('→')) continue;
    return {
      operation: op[1],
      le: isoDe(annee, op[2], op[3]),
      trajetLe: isoDe(annee, date[1], date[2]),
      trajet: lignes[i + 2],
      montant: `${montant[1]}${montant[2].replace('.', ',')} €`,
      texte: lignes.slice(i, i + 4).join(' '),
    };
  }
  return null;
}

/** La forme collée (tous les morceaux d'un tenant), gardée en repli. */
function lireLigneCollee(brut, annee) {
  const op = MOTIF_OPERATION.exec(brut);
  if (!op) return null;
  // Après l'opération : la date du trajet, l'itinéraire, puis le montant en
  // fin de ligne. L'itinéraire est TOUT ce qui sépare les deux — un nom de
  // ville porte souvent un trait d'union (« Saint-Nazaire »).
  const reste = brut.slice(op.index + op[0].length).replace(/\s+/g, ' ');
  const date = MOTIF_DATE_TRAJET.exec(reste);
  const montant = MOTIF_MONTANT.exec(reste);
  if (!date || !montant) return null;
  const itineraire = reste.slice(date[0].length, montant.index).trim();
  if (!itineraire.includes('→')) return null;
  return {
    operation: op[1],
    le: isoDe(annee, op[2], op[3]),
    trajetLe: isoDe(annee, date[1], date[2]),
    trajet: itineraire,
    montant: `${montant[1] === '+' ? '+' : '-'}${montant[2].replace('.', ',')} €`,
    texte: brut.replace(/\s+/g, ' '),
  };
}

/**
 * Une ligne avec son année : celle de l'intertitre de sa section, sinon
 * l'année en cours — ou la précédente si la date tomberait dans le futur
 * (une ligne de décembre lue en janvier).
 */
function lireLigneDatee({ texte, annee }, maintenant = new Date()) {
  if (annee) return lireLigne(texte, annee);
  const courante = maintenant.getUTCFullYear();
  const l = lireLigne(texte, String(courante));
  if (l?.trajetLe && Date.parse(`${l.trajetLe}T00:00:00Z`) > maintenant.getTime() + 86_400_000) {
    return lireLigne(texte, String(courante - 1));
  }
  return l;
}

/** Les lignes, regroupées par trajet (date et itinéraire), dans l'ordre de la page. */
function parTrajet(lignes) {
  const trajets = new Map();
  for (const l of lignes) {
    if (!l?.trajetLe) continue;
    const cle = `${l.trajetLe}|${l.trajet}`;
    if (!trajets.has(cle)) trajets.set(cle, { trajetLe: l.trajetLe, trajet: l.trajet, lignes: [] });
    trajets.get(cle).lignes.push(l);
  }
  return [...trajets.values()];
}

/** L'identifiant stable d'un trajet : sa date et une empreinte de son itinéraire. */
function referenceDuTrajet(t) {
  const empreinte = nodeCrypto.createHash('sha256').update(t.trajet).digest('hex').slice(0, 8);
  return `trajet-${t.trajetLe}-${empreinte}`;
}

function construireRecu(t, genereLe) {
  return releve.construire({
    nature: 'recu',
    service: NOM,
    compte: null,
    genereLe,
    colonnes: [
      { cle: 'operation', titre: 'Opération' },
      { cle: 'le', titre: 'Le' },
      { cle: 'montant', titre: 'Montant' },
    ],
    operations: t.lignes.map((l) => ({ operation: l.operation, le: l.le, montant: l.montant })),
    mentions: [
      `Trajet du ${t.trajetLe} — ${t.trajet}`,
      'Source : votre espace BlaBlaCar, page « Paiements & remboursements ».',
      'BlaBlaCar ne fournit pas de reçu téléchargeable.',
    ],
  });
}

async function attendreLaPeinture(page) {
  for (let tour = 0; tour < DELAI_PEINTURE_MS / 1_000; tour++) {
    const peint = await page.evaluate(() => /paiements|remboursements/i
      .test(document.body ? document.body.innerText : '')).catch(() => false);
    if (peint) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return false;
}

/** Ce que la page affiche : chaque ligne avec l'année de sa section. Dans le navigateur. */
function releverLesLignes() {
  const sortie = [];
  for (const li of document.querySelectorAll('li[data-testid="legacy-items-list-item"]')) {
    let annee = null;
    // L'intertitre de la section : le h2 qui précède la liste, et dit l'année.
    let n = li.closest('ul');
    while (n && !annee) {
      let precedent = n.previousElementSibling;
      while (precedent && !annee) {
        const m = /^\s*(20\d{2})\s*$/.exec(precedent.innerText || '');
        if (m) annee = m[1];
        precedent = precedent.previousElementSibling;
      }
      n = n.parentElement;
    }
    sortie.push({ texte: li.innerText || '', annee });
  }
  return sortie;
}

async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_PAIEMENTS, estAuthentification: estPageAuthentification },
    async (page, context) => {
      await attendreLaPeinture(page);
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        redirigeLesAnonymes: true,
        selecteurRepere: 'li[data-testid="legacy-items-list-item"]',
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw new Error(`${NOM} a affiché une page qui n'est pas vos paiements (${etat.raison}). `
          + 'Rouvrez la connexion depuis la fiche du service, puis relancez la récupération.');
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat, vue, page) => {
    const lignes = await page.evaluate(releverLesLignes).catch(() => []);
    return {
      ok: true,
      accountId: null,
      invoiceCount: parTrajet(lignes.map((l) => lireLigne(l.texte, l.annee))).length,
      message: `Connexion valide — ${lignes.length} paiement(s) et remboursement(s) affiché(s) sur votre compte ${NOM}.`,
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = scraping.planHistorique(config, ctx);
  const maintenant = ctx.maintenant || new Date();

  return surLaListe(ctx, async (etat, vue, page) => {
    const brutes = await page.evaluate(releverLesLignes).catch(() => []);
    const sansAnnee = brutes.filter((l) => !l.annee).length;
    if (sansAnnee) log(`${ID} : ${sansAnnee} ligne(s) sans intertitre d'année — l'année est déduite de la date du jour.`);
    const lues = brutes.map((l) => lireLigneDatee(l, maintenant));
    const illisibles = lues.filter((l) => !l).length;
    const trajets = parTrajet(lues);
    ctx.preuveDeListe?.({
      session: `page des paiements servie au compte connecté (${etat.raison})`,
      liste: URL_PAIEMENTS,
      elements: brutes.length,
    });
    if (illisibles) log(`${ID} : ${illisibles} ligne(s) sans la forme attendue (opération, trajet, montant) — non reprises.`);
    // Des lignes affichées, et AUCUNE reconnue : la lecture ne correspond pas à
    // la page — jamais un « aucune nouvelle facture » (premier essai réel,
    // 01/11/2026 : trois lignes, aucune lue, et un succès).
    if (brutes.length && illisibles === brutes.length) {
      throw new Error(`Votre page de paiements ${NOM} affiche ${brutes.length} opération(s), mais crabe n'en a reconnu `
        + 'aucune : leur présentation diffère de celle attendue. Rien n\'a été reconstitué. Signalez-le, la lecture doit être adaptée.');
    }

    const invoices = [];
    let enAttente = 0;
    for (const t of trajets) {
      const remoteId = `${ID}-${referenceDuTrajet(t)}`;
      if (connus.has(remoteId)) continue;
      if (!scraping.dansLaFenetre(t.trajetLe, plan)) continue;
      const age = (maintenant.getTime() - Date.parse(`${t.trajetLe}T00:00:00Z`)) / 86_400_000;
      if (age < DELAI_APRES_TRAJET_JOURS) {
        enAttente++;
        continue;
      }
      invoices.push({
        remoteId,
        filename: releve.nomFichierRecu({ service: NOM, reference: referenceDuTrajet(t) }),
        issuedOn: t.trajetLe,
        buffer: construireRecu(t, maintenant),
      });
    }
    log(`${ID} : ${brutes.length} ligne(s), ${trajets.length} trajet(s), ${invoices.length} reçu(s) reconstitué(s)`
      + `${enAttente ? `, ${enAttente} trajet(s) de moins de ${DELAI_APRES_TRAJET_JOURS} jours (reconstitués plus tard)` : ''}.`);
    return {
      accountId: null,
      invoices,
      precision: `${NOM} ne fournit pas de reçu : crabe en reconstitue un par trajet, à partir de vos paiements et remboursements.`,
      aucunDocument: brutes.length === 0
        ? `Votre page de paiements ${NOM} n'affiche aucune opération : il n'y a rien à reconstituer.`
        : undefined,
    };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  lireLigne,
  lireLigneDatee,
  parTrajet,
  referenceDuTrajet,
  construireRecu,
  releverLesLignes,
  URL_PAIEMENTS,
  CHEMIN_LISTE,
  DELAI_APRES_TRAJET_JOURS,
};
