'use strict';

/**
 * Connecteur Galaxus — profil de navigateur persistant (0.2.16, lot l7).
 *
 * Galaxus refuse tout navigateur headless (mesuré le 01/11/2026) : la
 * connexion vit dans un profil de navigateur VISIBLE, ouvert par la fenêtre
 * « Se connecter » et rouvert ici par `profil-marchand` — comme Boulanger.
 *
 * Écrit sur les pages MESURÉES le 01/11/2026 sur le compte du compte observé (relevés de
 * page nettoyés, `scripts/releve-page.js`) :
 *
 *   - la liste : `www.galaxus.fr/fr/order` — chaque commande y porte un lien
 *     « Afficher les détails de la commande » vers `/fr/order/<numéro>` ;
 *   - une commande : titre h1 « Commande <numéro> du JJ/MM/AAAA », et une
 *     `section#documents` dont chaque lien est un PDF sous
 *     `/orderdocuments/<nature>/<numéro>` (mesuré : `pdforderconfirmation`).
 *
 * La facture d'une commande expédiée n'a pas encore été vue : tout lien de la
 * section Documents est pris, et le fichier porte la nature lue dans son
 * adresse (« facture », « confirmation-commande », ou la nature brute).
 *
 * Les PDF sont demandés PAR LA PAGE (`fetch` dans le navigateur, cookies de la
 * session) : une requête faite hors du navigateur serait jugée comme le
 * headless l'est.
 */

const profilMarchand = require('../../profil-marchand');
const pageDocs = require('../../documents-de-page');
const scraping = require('../../scraping');
const identity = require('../../browser-identity');

const ID = 'galaxus';
const NOM = 'Galaxus';
const SITE = 'https://www.galaxus.fr';
const URL_COMMANDES = `${SITE}/fr/order`;

/** La liste : `/fr/order` suivi de la fin, d'une query ou d'un fragment — jamais une commande. */
const CHEMIN_LISTE = /\/fr\/order\/?(?:[?#]|$)/i;
/** Une commande : `/fr/order/<numéro>`. */
const MOTIF_COMMANDE = /^https:\/\/www\.galaxus\.fr\/fr\/order\/(\d+)\/?(?:[?#].*)?$/i;
/** Un document de commande : `/orderdocuments/<nature>/<…>`. */
const MOTIF_DOCUMENT = /^https:\/\/www\.galaxus\.fr\/orderdocuments\/([a-z0-9-]+)\//i;
/** « Commande 123 du 21/10/2026 ». */
const MOTIF_TITRE = /du\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

const DELAI_PEINTURE_MS = 15_000;

/** L'écran de connexion de Galaxus vit sur `id.galaxus.eu`. */
function estPageAuthentification(url) {
  const texte = String(url || '');
  if (/^https?:\/\/id\.galaxus\./i.test(texte)) return true;
  return profilMarchand.estPageAuthentification(texte);
}

/** Les numéros de commande de la liste, sans doublon, dans l'ordre de la page. */
function numerosDeCommandes(liens) {
  const vus = new Set();
  for (const lien of Array.isArray(liens) ? liens : []) {
    const m = MOTIF_COMMANDE.exec(String(lien?.href || ''));
    if (m) vus.add(m[1]);
  }
  return [...vus];
}

/** « Commande 123 du 21/10/2026 » → « 2026-10-21 », ou null. */
function dateDuTitre(titre) {
  const m = MOTIF_TITRE.exec(String(titre || ''));
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** La nature d'un document, en mots de fichier. */
function natureDe(brute) {
  const n = String(brute || '').toLowerCase();
  if (/invoice|rechnung|facture/.test(n)) return 'facture';
  if (/orderconfirmation/.test(n)) return 'confirmation-commande';
  if (/credit|gutschrift|avoir/.test(n)) return 'avoir';
  if (/delivery|lieferschein|livraison/.test(n)) return 'bon-livraison';
  return n.replace(/^pdf/, '') || 'document';
}

/** Une facture (pas une confirmation) : sa présence dit que la commande est close. */
function estFacture(remoteId) {
  return /-facture$/.test(String(remoteId || ''));
}

/** Les documents d'une commande, depuis les liens de sa section Documents. */
function documentsDeCommande(numero, liens, issuedOn) {
  const sortie = [];
  const vus = new Set();
  for (const lien of Array.isArray(liens) ? liens : []) {
    const url = String(lien?.href || '');
    const m = MOTIF_DOCUMENT.exec(url);
    if (!m || vus.has(url)) continue;
    vus.add(url);
    const nature = natureDe(m[1]);
    const remoteId = `${ID}-${numero}-${nature}`;
    sortie.push({
      remoteId,
      url,
      issuedOn,
      nature,
      filename: pageDocs.nomFichier(ID, { issuedOn, remoteId: `${nature}-${numero}` }),
    });
  }
  return sortie;
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est pas la liste de vos commandes (${raison}). `
      + 'Rouvrez la connexion depuis la fiche du service, puis relancez la récupération.'
  );
}

/** Attend que l'application ait peint la page (elle est rendue côté client). */
async function attendreLaPeinture(page, motif) {
  for (let tour = 0; tour < DELAI_PEINTURE_MS / 1_000; tour++) {
    const peint = await page.evaluate((source) => new RegExp(source, 'i')
      .test(document.body ? document.body.innerText : ''), motif.source).catch(() => false);
    if (peint) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return false;
}

/** Un PDF demandé par la page, avec sa session. */
async function telecharger(page, document) {
  const r = await page.evaluate(async (url) => {
    const reponse = await fetch(url, { credentials: 'include' });
    if (!reponse.ok) return { statut: reponse.status };
    const octets = new Uint8Array(await reponse.arrayBuffer());
    let binaire = '';
    for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
    return { statut: reponse.status, base64: btoa(binaire) };
  }, document.url);
  if (r.statut === 401 || r.statut === 403) {
    throw profilMarchand.erreurRenvoiVersAuthentification(NOM, `HTTP ${r.statut} sur un document de commande`);
  }
  if (!r.base64) throw new Error(`Téléchargement d'un document de commande ${NOM} impossible (HTTP ${r.statut}).`);
  const buffer = Buffer.from(r.base64, 'base64');
  if (!identity.estPdf(buffer)) {
    throw new Error(`Un document de commande ${NOM} n'est pas un PDF (${buffer.length} octets reçus).`);
  }
  return buffer;
}

/** L'ossature : atteindre la liste, la juger, passer la main. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      await attendreLaPeinture(page, /commande/);
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        redirigeLesAnonymes: true,
        motifRepere: /^Commande\s+#?\d+\s+du\s/i,
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
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat, vue, page) => {
    const numeros = numerosDeCommandes(await page.evaluate(pageDocs.releverLiens).catch(() => []));
    return {
      ok: true,
      accountId: null,
      invoiceCount: numeros.length,
      message: `Connexion valide — ${numeros.length} commande(s) affichée(s) sur votre compte ${NOM}.`,
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaListe(ctx, async (etat, vue, page) => {
    const numeros = numerosDeCommandes(await page.evaluate(pageDocs.releverLiens).catch(() => []));
    log(`${ID} : ${numeros.length} commande(s) dans la liste.`);
    // La preuve (lot 31) : la liste a été servie à CE compte — l'adresse a tenu
    // alors qu'elle renvoie les anonymes vers id.galaxus.eu.
    ctx.preuveDeListe?.({
      session: `liste des commandes servie au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: numeros.length,
    });

    const invoices = [];
    let ouvertes = 0;
    for (const numero of numeros) {
      // Une commande dont la FACTURE est déjà déposée est close : inutile de la rouvrir.
      if ([...connus].some((id) => id.startsWith(`${ID}-${numero}-`) && estFacture(id))) continue;
      await page.goto(`${URL_COMMANDES}/${numero}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await attendreLaPeinture(page, /documents|commande/);
      if (estPageAuthentification(page.url())) {
        throw profilMarchand.erreurRenvoiVersAuthentification(NOM, `renvoi vers ${page.url()} en ouvrant une commande`);
      }
      ouvertes++;
      const titre = await page.evaluate(() => document.querySelector('h1')?.innerText || '').catch(() => '');
      const issuedOn = dateDuTitre(titre);
      if (!scraping.dansLaFenetre(issuedOn, plan)) continue;
      const liens = await page.evaluate(() => [...document.querySelectorAll('#documents a[href]')]
        .map((a) => ({ href: a.href, texte: (a.innerText || '').trim() }))).catch(() => []);
      for (const doc of documentsDeCommande(numero, liens, issuedOn)) {
        if (connus.has(doc.remoteId)) continue;
        invoices.push({
          remoteId: doc.remoteId,
          filename: doc.filename,
          issuedOn,
          buffer: await telecharger(page, doc),
        });
      }
    }
    log(`${ID} : ${ouvertes} commande(s) ouverte(s), ${invoices.length} document(s) récupéré(s).`);
    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  numerosDeCommandes,
  dateDuTitre,
  natureDe,
  estFacture,
  documentsDeCommande,
  URL_COMMANDES,
  CHEMIN_LISTE,
};
