'use strict';

/**
 * Connecteur VistaPrint — le parcours des documents est ÉCRIT (lot 51).
 *
 * ─── D'où vient ce connecteur ────────────────────────────────────────────────
 *
 * Ébauche au lot 47 (reconnaissance anonyme : `/mon-compte` redirige l'anonyme
 * vers le SSO `account.vista.com`, aucune liste vue), adresse corrigée au
 * lot 50 : `/mon-compte` ne contient AUCUNE commande, l'historique vit sur
 * `/oh/` (conteneur `[data-testid="order-history-application"]`, chaque ligne
 * porte un lien `/od?orderId=…`). Le lot 51 écrit le parcours.
 *
 * ─── Ce que la sonde du 23/08/2026 a MESURÉ sur le vrai compte ───────────────
 *
 *   - le détail d'une commande vit sur `/od?orderId=<référence>` — la
 *     référence métier est DANS l'adresse du lien que porte chaque ligne de
 *     l'historique ; le détail affiche `data-testid="order-info-number"`
 *     (« Numéro de commande: … ») et `data-testid="order-info-date"`
 *     (« Date de la commande: … », date française en toutes lettres) ;
 *   - le bouton « Télécharger vos factures TVA » est un `<button
 *     type="button">` sans lien (même piège que le `<bl-button>` de
 *     Boulanger) : son clic appelle un service de génération
 *     (`vatinvoicegenerator.orders.vpsvc.com/…/order/<référence>/pdf`,
 *     réponse `application/pdf`) puis DÉCLENCHE UN TÉLÉCHARGEMENT — voie
 *     mesurée : téléchargement direct, un seul document pour la commande,
 *     aucune boîte de choix malgré le pluriel du libellé. `clic-document`
 *     guette quand même les trois voies : c'est lui qui journalise celle qui
 *     a servi à chaque passage.
 *
 * ─── L'ancre d'idempotence ───────────────────────────────────────────────────
 *
 * Le `remote_id` s'ancre sur la RÉFÉRENCE DE COMMANDE lue sur la page (le
 * lien de la ligne la porte dans son adresse, le détail l'affiche) — jamais
 * sur une empreinte du document : un site qui regénère ses PDF change leurs
 * octets sans changer ce qu'ils disent (leçon OUIGO du lot 46). Une commande
 * déjà déposée n'est même pas rouverte.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');

const ID = 'vistaprint';
const NOM = 'VistaPrint';
// ⚠ `/mon-compte` était l'erreur des lots 47-49 : cette page ne contient
// AUCUNE commande — le connecteur y comptait 0 repère sur une session valide.
// L'historique des commandes vit sur `/oh/`, relevé à l'écran par
// l'utilisateur le 23/08/2026 (conteneur `[data-testid=
// "order-history-application"]`, lignes en `li` portant chacune un lien vers
// `/od?orderId=…`).
const URL_COMMANDES = 'https://www.vistaprint.fr/oh/';
const CHEMIN_LISTE = /\/oh([/?#]|$)/i;

/**
 * Le repère de comptage le plus sûr, relevé le 23/08/2026 : chaque ligne de
 * commande porte un lien dont l'adresse commence par `/od?orderId=` — et
 * cette adresse porte l'identifiant métier de la commande. Le sélecteur
 * matche l'attribut par sous-chaîne : le site peut écrire l'adresse relative
 * ou absolue sans casser le compte.
 *
 * Sondé en visiteur anonyme le 23/08/2026 depuis la production : `/oh/` répond 200 à
 * tout le monde (pas de redirection mesurable au fetch), mais la page anonyme
 * (390 Ko) ne porte NI `order-history-application` NI `orderId=` — ces
 * marqueurs ne sont servis qu'à un compte connecté, ils valent donc preuve.
 */
const SELECTEUR_REPERE = 'a[href*="/od?orderId="]';
const MARQUEURS_MESURES = [
  { selecteur: '[data-testid="order-history-application"]' },
  { selecteur: 'a[href*="/od?orderId="]' },
];

/**
 * Les marqueurs du détail d'une commande, relevés à l'écran (lot 50) et
 * confirmés par sonde sur le vrai compte (lot 51) ; et le bouton de facture,
 * reconnu à son libellé relevé.
 */
const SELECTEUR_NUMERO_DETAIL = '[data-testid="order-info-number"]';
const SELECTEUR_DATE_DETAIL = '[data-testid="order-info-date"]';
const MOTIF_BOUTON_FACTURE = /t[ée]l[ée]charger vos factures/i;

/**
 * L'écran d'authentification est un HÔTE dédié : `account.vista.com`
 * (mesuré le 22/08/2026 — `/mon-compte` anonyme y atterrit). Le motif de
 * chemin par défaut reste en second filet.
 */
function estPageAuthentification(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)account\.vista\.com$/i.test(u.hostname)) return true;
  } catch {
    return false;
  }
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni votre espace client ni un espace connecté (${raison}) : `
      + 'impossible de dire s\'il y a des documents. Rouvrez la connexion depuis la fiche du '
      + 'service, puis relancez la récupération.'
  );
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // `/oh/` répond 200 aux anonymes (sondé le 23/08/2026) : y rester ne
        // prouve rien. La preuve est DANS la page — les marqueurs relevés sur
        // le vrai compte, absents de la page anonyme (mesuré des deux côtés),
        // le lien de déconnexion générique en filet.
        redirigeLesAnonymes: false,
        marqueursMesures: MARQUEURS_MESURES,
        selecteurRepere: SELECTEUR_REPERE,
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        // Le profil existe (surLeProfil l'a vérifié) : une page qui renvoie à
        // l'authentification est un renvoi MALGRÉ session — dire « expirée ou
        // jamais ouverte » à quelqu'un qui vient de se connecter était le
        // mensonge mesuré le 23/08/2026 (lot 50).
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw erreurPageInconnue(etat.raison);
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// La lecture de la liste : chaque ligne porte sa référence dans son lien
// ---------------------------------------------------------------------------

/**
 * Les commandes de l'historique : pour chacune, la référence métier lue dans
 * l'adresse de son lien de détail (`/od?orderId=<référence>`) et l'adresse
 * complète pour l'ouvrir. Une même commande peut porter plusieurs liens vers
 * son détail — elles se dédoublonnent sur la référence. Aucune de ces valeurs
 * ne part au journal.
 */
async function lireCommandes(page) {
  const brutes = await page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((a) => {
      let reference = null;
      try {
        reference = new URL(a.href).searchParams.get('orderId');
      } catch { /* adresse illisible : la ligne sera dite sans référence */ }
      return { reference: reference || null, href: a.href };
    });
  }, SELECTEUR_REPERE).catch(() => []);

  const parReference = new Map();
  for (const c of brutes) {
    const cle = c.reference ? c.reference.toUpperCase() : `sans-reference-${parReference.size}`;
    if (!parReference.has(cle)) parReference.set(cle, c);
  }
  return [...parReference.values()];
}

/** L'identifiant distant : la référence de commande lue sur la page (lot 46). */
function remoteIdPour(reference) {
  return `${ID}-${String(reference).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Le détail d'une commande : ses marqueurs, son bouton de facture
// ---------------------------------------------------------------------------

/**
 * Ce que le détail MONTRE (marqueurs relevés puis confirmés par sonde) : le
 * numéro affiché — le filet qui confirme que la page est bien celle de la
 * commande demandée —, le texte de la date, et la présence du bouton de
 * facture.
 */
async function lireDetail(page) {
  return page.evaluate(({ selNumero, selDate, motifBouton }) => {
    const reBouton = new RegExp(motifBouton, 'i');
    const numero = document.querySelector(selNumero);
    const date = document.querySelector(selDate);
    const boutonFacture = [...document.querySelectorAll('button')]
      .some((b) => reBouton.test(b.innerText || '') && (b.offsetWidth || b.offsetHeight));
    return {
      numero: numero ? (numero.innerText || '').replace(/\s+/g, ' ').trim() : null,
      texteDate: date ? (date.innerText || '').replace(/\s+/g, ' ').trim() : null,
      boutonFacture,
    };
  }, {
    selNumero: SELECTEUR_NUMERO_DETAIL,
    selDate: SELECTEUR_DATE_DETAIL,
    motifBouton: MOTIF_BOUTON_FACTURE.source,
  }).catch(() => ({ numero: null, texteDate: null, boutonFacture: false }));
}

/**
 * Clique le bouton « Télécharger vos factures TVA » du détail. Le clic part
 * DANS la page : c'est un `<button>` d'application React, un clic Playwright
 * serait jugé sur la géométrie d'un élément dont on ne sait rien.
 */
async function cliquerBoutonFacture(page) {
  return page.evaluate((motifBouton) => {
    const reBouton = new RegExp(motifBouton, 'i');
    const bouton = [...document.querySelectorAll('button')]
      .find((b) => reBouton.test(b.innerText || '') && (b.offsetWidth || b.offsetHeight));
    if (!bouton) return false;
    bouton.click();
    return true;
  }, MOTIF_BOUTON_FACTURE.source).catch(() => false);
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, l'historique répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — ${etat.reperes} commande(s) visible(s) sur l'historique ${NOM}.`,
  }));
}

/**
 * Récupère les factures des commandes de l'historique.
 *
 * La liste donne les références ; chaque commande inconnue est ouverte sur
 * son détail (`/od?orderId=…`), où le bouton de facture est cliqué —
 * `clic-document` lit le document quelle que soit la voie (le téléchargement
 * direct est celle qui a été mesurée). Une commande déjà déposée n'est même
 * pas rouverte.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) : l'historique a été servi À CE
    // COMPTE — marqueurs relevés sur le vrai compte, jamais servis aux
    // anonymes (mesuré des deux côtés le 23/08/2026).
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const commandes = await lireCommandes(page);
    log(`${ID} : ${commandes.length} commande(s) lue(s) sur l'historique `
      + `(sélecteur ${SELECTEUR_REPERE}, relevé du 23/08/2026).`);

    const invoices = [];
    let dejaDeposees = 0;
    let sansReference = 0;

    for (let rang = 0; rang < commandes.length; rang++) {
      const commande = commandes[rang];

      if (!commande.reference) {
        sansReference++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — la référence n'a pas pu être `
          + 'lue dans l\'adresse de son lien, elle est passée pour ne pas risquer un doublon. '
          + 'Signalez-le si cela se répète.');
        continue;
      }

      const remoteId = remoteIdPour(commande.reference);
      if (connus.has(remoteId)) {
        // L'ancre d'idempotence : la commande est déjà déposée, son détail
        // n'est même pas rouvert — le site regénérerait le document pour rien.
        dejaDeposees++;
        continue;
      }

      // Le détail s'ouvre par l'adresse que la liste porte : les rangs ne
      // comptent sur rien, la liste n'a pas besoin d'être rejouée.
      await page.goto(commande.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
      await profilMarchand.fermerBandeauCookies(page, () => {});

      const detail = await lireDetail(page);
      if (!detail.boutonFacture) {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — aucun bouton « Télécharger `
          + 'vos factures TVA » sur son détail. Rien n\'a été récupéré pour celle-ci ; '
          + 'signalez-le si cela se répète.');
        continue;
      }

      const issuedOn = documentsDePage.dateDepuisTexte(detail.texteDate || '');
      const obtenu = await clicDocument.documentDuClic(
        page, context, () => cliquerBoutonFacture(page)
      );
      if (!obtenu.ok) {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — la facture n'a pas été lue `
          + `(${obtenu.grief}). On continue avec les suivantes.`);
        continue;
      }

      log(`${ID} : commande ${rang + 1}/${commandes.length} — facture lue `
        + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
      connus.add(remoteId);
      invoices.push({
        remoteId,
        filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
        issuedOn,
        buffer: obtenu.buffer,
      });
    }

    if (dejaDeposees) {
      log(`${ID} : ${dejaDeposees} document(s) déjà déposé(s) — reconnu(s) à leur référence, `
        + 'rien n\'a été retéléchargé.');
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${commandes.length} commande(s)`
      + `${sansReference ? `, ${sansReference} sans référence lisible` : ''}.`);

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  lireCommandes,
  lireDetail,
  cliquerBoutonFacture,
  remoteIdPour,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MARQUEURS_MESURES,
  SELECTEUR_NUMERO_DETAIL,
  SELECTEUR_DATE_DETAIL,
  MOTIF_BOUTON_FACTURE,
};
