'use strict';

/**
 * Connecteur LDLC — le parcours des documents est ÉCRIT (lot 52), et l'ancre
 * du lot 48 est RÉPARÉE.
 *
 * ─── L'erreur d'ancre du lot 48, et sa réparation ────────────────────────────
 *
 * Le lot 48 avait calibré le repère de commande sur « la référence » visible de
 * la seule commande affichée — en réalité le NUMÉRO DE SUIVI DU TRANSPORTEUR,
 * affiché dans le bloc « Suivi colis » (mesuré le 24/08/2026 : deux lettres,
 * neuf chiffres, deux lettres — et la valeur réelle était en dur dans le
 * motif, ce que la règle du projet interdit). Une commande non expédiée, ou
 * confiée à un autre transporteur, n'aurait JAMAIS été comptée — sans que rien
 * ne le dise.
 *
 * Ce que la ligne d'une commande porte réellement (mesuré sur une session réelle, 24/08/2026),
 * TROIS numéros distincts :
 *
 *   - l'IDENTIFIANT D'ADRESSE (une lettre puis neuf chiffres) — celui que les
 *     routes du site portent elles-mêmes : le détail
 *     (`/fr-fr/Orders/PartialCompletedOrderContent?orderId=…`, chargé en AJAX
 *     dans un bloc `#order_<identifiant>`) ET la facture
 *     (`/fr-fr/Orders/DownloadOrderInvoice?orderId=…`) ;
 *   - le « Nº commande » AFFICHÉ dans sa cellule (treize chiffres puis une
 *     lettre) — présent à l'écran, absent de toute adresse ;
 *   - le numéro de suivi du transporteur — l'erreur du lot 48.
 *
 * L'ancre d'idempotence est l'identifiant d'adresse : c'est le seul que le
 * site utilise pour SERVIR le détail et la facture, il se relit tel quel à
 * chaque passage dans les liens de la page. Jamais le suivi, jamais une valeur
 * réelle en dur.
 *
 * ─── Les périodes (mesuré le 24/08/2026) ─────────────────────────────────────
 *
 * La liste ne montre par défaut que « Depuis les 6 derniers mois ». Le
 * sélecteur est un widget select2 (`#CompletedOrders_FirstPeriod_Value`,
 * `data-period-url=/fr-fr/Orders/CompletedOrdersPeriodSelection` — une route
 * POST : le GET rend 405) : ses options n'existent dans la page qu'une fois le
 * menu OUVERT. Le parcours ouvre le menu, lit les périodes proposées et les
 * parcourt TOUTES ; s'il n'y parvient pas, il le dit au journal — un
 * historique partiel qui se présente comme complet est un mensonge.
 *
 * Piège mesuré : la liste rafraîchie en AJAX après un changement de période ne
 * porte PLUS le lien de facture sur la ligne (le rendu serveur initial le
 * porte). Il revient en ouvrant « Détails » — le bloc `#order_<identifiant>`
 * chargé porte le lien `bill-link` « Télécharger la facture ».
 *
 * ─── La voie du document (mesurée le 24/08/2026) ─────────────────────────────
 *
 * La facture est un VRAI lien `<a href>` — premier connecteur marchand sans
 * piège d'élément personnalisé. Le clic mesuré déclenche un téléchargement
 * direct (`%PDF`, ~172 Ko) ; `clic-document` reste la voie de lecture, pour
 * dire ce qui a servi si le site change.
 *
 * §0ter — la page de détail affiche l'adresse postale du client et son moyen
 * de paiement : ce parcours ne les lit, ne les journalise et ne les stocke
 * JAMAIS. Il ne vise que les liens de détail et de facture.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');

const ID = 'ldlc';
const NOM = 'LDLC';
const URL_COMMANDES = 'https://secure2.ldlc.com/fr-fr/Orders';
/** L'adresse des commandes a tenu = la session est là (302 mesuré hors session). */
const CHEMIN_LISTE = /\/fr-fr\/Orders/i;

/** Chaque commande est un bloc `.order` (tableau dsp-row/dsp-cell, relevé le 24/08/2026). */
const SELECTEUR_REPERE = '.order';
/**
 * Filet de texte : la FORME du « Nº commande » affiché (treize chiffres puis
 * une lettre, relevée le 24/08/2026) — jamais une valeur, et jamais la forme
 * du numéro de suivi transporteur (l'erreur du lot 48).
 */
const MOTIF_REPERE = /\b\d{13}[A-Z]\b/;
/**
 * L'ancre d'idempotence : l'identifiant que portent les adresses de détail et
 * de facture — une lettre puis neuf chiffres (forme relevée le 24/08/2026, du
 * jeu sur le nombre de chiffres pour les commandes jamais vues). Un numéro de
 * suivi transporteur (deux lettres … deux lettres) ne peut PAS le satisfaire.
 */
const MOTIF_ORDER_ID = /^[A-Z]\d{8,11}$/;
const SELECTEUR_LIEN_DETAIL = 'a[href*="PartialCompletedOrderContent"]';
const SELECTEUR_LIEN_FACTURE = 'a[href*="DownloadOrderInvoice"]';
/** Le conteneur select2 du sélecteur de périodes, relevé le 24/08/2026. */
const SELECTEUR_PERIODES = '#select2-CompletedOrders_FirstPeriod_Value-container';

/** Le temps laissé au bloc de détail AJAX pour montrer son lien de facture. */
const DELAI_DETAIL_MS = 15_000;

/** `/fr-fr/Login/Login` — la page mesurée, plus le motif générique en filet. */
function estPageAuthentification(url) {
  try {
    if (/^\/fr-fr\/Login\//i.test(new URL(String(url)).pathname)) return true;
  } catch {
    return false;
  }
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni vos commandes ni un espace connecté (${raison}) : `
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
        redirigeLesAnonymes: true,
        // Les commandes se comptent sur leur sélecteur RELEVÉ (24/08/2026),
        // le motif de forme du « Nº commande » affiché en filet.
        selecteurRepere: SELECTEUR_REPERE,
        motifRepere: MOTIF_REPERE,
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
// L'ancre : l'identifiant que portent les adresses du site
// ---------------------------------------------------------------------------

/**
 * L'identifiant de commande porté par une adresse de détail ou de facture
 * (`?orderId=…`), ou `null` si l'adresse n'en porte pas un de la forme
 * relevée. Pure et testée : c'est elle qui interdit le retour de l'ancre du
 * lot 48 — un numéro de suivi transporteur ne passe pas ce motif.
 */
function orderIdDepuisHref(href) {
  let valeur = null;
  try {
    valeur = new URL(String(href), URL_COMMANDES).searchParams.get('orderId');
  } catch {
    return null;
  }
  if (!valeur) return null;
  const propre = valeur.trim().toUpperCase();
  return MOTIF_ORDER_ID.test(propre) ? propre : null;
}

/** L'identifiant distant : l'identifiant d'adresse, jamais le suivi (lot 52). */
function remoteIdPour(orderId) {
  return `${ID}-${String(orderId).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// La lecture de la liste : chaque bloc `.order`, en une passe
// ---------------------------------------------------------------------------

/**
 * Ce que chaque commande MONTRE : l'adresse de son lien « Détails », celle de
 * son lien de facture quand la ligne en porte un (rendu serveur initial —
 * la liste rafraîchie en AJAX ne l'a plus), et sa cellule de date. Les
 * identifiants sont validés CÔTÉ NODE par `orderIdDepuisHref`, où les tests
 * peuvent mordre.
 */
async function lireCommandes(page) {
  const lignes = await page.evaluate(({ selOrder, selDetail, selFacture }) => {
    return [...document.querySelectorAll(selOrder)].map((bloc) => {
      const detail = bloc.querySelector(selDetail);
      const facture = bloc.querySelector(selFacture);
      const cellules = [...bloc.querySelectorAll('.dsp-cell')]
        .map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
      return {
        detailHref: detail ? (detail.getAttribute('href') || detail.href || null) : null,
        factureHref: facture ? (facture.getAttribute('href') || facture.href || null) : null,
        // La cellule qui n'est QU'une date : c'est la date de commande. Le
        // texte du bloc en filet — sa première date est celle de la commande,
        // « Expédiée le … » vient après.
        dateTexte: cellules.find((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t))
          || (bloc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    });
  }, {
    selOrder: SELECTEUR_REPERE,
    selDetail: SELECTEUR_LIEN_DETAIL,
    selFacture: SELECTEUR_LIEN_FACTURE,
  }).catch(() => []);

  return lignes.map((ligne) => ({
    ...ligne,
    orderId: orderIdDepuisHref(ligne.detailHref) || orderIdDepuisHref(ligne.factureHref),
  }));
}

// ---------------------------------------------------------------------------
// Les périodes : le menu select2, ouvert et parcouru comme le ferait la main
// ---------------------------------------------------------------------------

/**
 * Ouvre le menu des périodes (select2 s'ouvre sur `mousedown`, pas sur
 * `click`) et lit les options une fois montées — elles n'existent dans la
 * page qu'à ce moment-là (mesuré le 24/08/2026). Rend `null` si le menu n'a
 * pas répondu : l'appelant DOIT alors dire que l'historique peut être partiel.
 *
 * @returns {Promise<Array<{libelle: string, selectionnee: boolean}>|null>}
 */
async function lirePeriodes(page) {
  const ouvert = await page.evaluate(({ ouvrirMenu }) => {
    const conteneur = document.querySelector(ouvrirMenu);
    const poignee = conteneur ? conteneur.closest('.select2-selection') : null;
    if (!poignee) return false;
    poignee.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  }, { ouvrirMenu: SELECTEUR_PERIODES }).catch(() => false);
  if (!ouvert) return null;

  for (let attente = 0; attente < 10; attente++) {
    await page.waitForTimeout(1_000).catch(() => {});
    const options = await page.evaluate(({ lireOptions }) => {
      void lireOptions;
      return [...document.querySelectorAll('.select2-results__option')].map((o) => ({
        libelle: (o.innerText || '').replace(/\s+/g, ' ').trim(),
        selectionnee: o.getAttribute('aria-selected') === 'true',
      }));
    }, { lireOptions: true }).catch(() => []);
    if (options.length) return options;
  }
  return null;
}

/** Referme le menu sans rien choisir (select2 se ferme au mousedown ailleurs). */
async function fermerMenuPeriodes(page) {
  await page.evaluate(({ fermerMenu }) => {
    void fermerMenu;
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }, { fermerMenu: true }).catch(() => {});
}

/**
 * Choisit une période par son libellé (menu déjà ouvert par `lirePeriodes`,
 * ou rouvert ici), attend le rafraîchissement AJAX de la liste, et vérifie
 * que le widget AFFICHE bien la période demandée — sans cette vérification,
 * un clic perdu ferait relire la même période en silence.
 */
async function choisirPeriode(page, libelle) {
  const relu = await lirePeriodes(page);
  if (!relu) return false;
  const clique = await page.evaluate(({ choisir }) => {
    const cible = [...document.querySelectorAll('.select2-results__option')]
      .find((o) => (o.innerText || '').replace(/\s+/g, ' ').trim() === choisir);
    if (!cible) return false;
    cible.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    cible.click();
    return true;
  }, { choisir: libelle }).catch(() => false);
  if (!clique) {
    await fermerMenuPeriodes(page);
    return false;
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
  const affichee = await page.evaluate(({ libellePeriode }) => {
    const conteneur = document.querySelector(libellePeriode);
    return conteneur ? (conteneur.innerText || '').replace(/\s+/g, ' ').trim() : '';
  }, { libellePeriode: SELECTEUR_PERIODES }).catch(() => '');
  return affichee === libelle;
}

// ---------------------------------------------------------------------------
// Le détail d'une commande : rouvert quand la ligne n'a plus son lien
// ---------------------------------------------------------------------------

/** Clique « Détails » de la commande visée — par l'identifiant de son adresse. */
async function ouvrirDetail(page, orderId) {
  return page.evaluate(({ selDetail, id }) => {
    const lien = [...document.querySelectorAll(selDetail)]
      .find((a) => (a.getAttribute('href') || a.href || '').includes(id));
    if (!lien) return false;
    lien.click();
    return true;
  }, { selDetail: SELECTEUR_LIEN_DETAIL, id: orderId }).catch(() => false);
}

/** Le lien de facture de CETTE commande est-il monté quelque part dans la page ? */
async function factureVisible(page, orderId) {
  return page.evaluate(({ selFacture, id }) => {
    return [...document.querySelectorAll(selFacture)]
      .some((a) => (a.getAttribute('href') || a.href || '').includes(id));
  }, { selFacture: SELECTEUR_LIEN_FACTURE, id: orderId }).catch(() => false);
}

/** Attend que le bloc de détail AJAX montre le lien de facture de la commande. */
async function attendreFacture(page, orderId, delaiMs = DELAI_DETAIL_MS) {
  // Une boucle COMPTÉE, pas chronométrée : chaque tour attend une seconde de
  // page — et une page simulée par les tests n'a pas à faire le poireau.
  for (let tour = 0; tour < delaiMs / 1_000; tour++) {
    if (await factureVisible(page, orderId)) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return factureVisible(page, orderId);
}

/** Clique « Télécharger la facture » de la commande visée. Le clic part DANS la page. */
async function cliquerFacture(page, orderId) {
  return page.evaluate(({ selCliquerFacture, id }) => {
    const lien = [...document.querySelectorAll(selCliquerFacture)]
      .find((a) => (a.getAttribute('href') || a.href || '').includes(id));
    if (!lien) return false;
    lien.click();
    return true;
  }, { selCliquerFacture: SELECTEUR_LIEN_FACTURE, id: orderId }).catch(() => false);
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la page des commandes répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — ${etat.reperes} commande(s) visible(s) sur la page des `
      + `commandes ${NOM} (période affichée par défaut).`,
  }));
}

/**
 * Récupère les factures des commandes, sur TOUTES les périodes proposées.
 *
 * La liste donne les identifiants (dans les adresses de ses liens) ; chaque
 * commande inconnue livre sa facture par son lien « Télécharger la facture »
 * — sur la ligne quand le rendu serveur l'y a mis, en rouvrant « Détails »
 * sinon (liste rafraîchie en AJAX, mesuré le 24/08/2026). Si le site renvoie
 * la lecture vers son écran de connexion au milieu du parcours, la
 * récupération s'arrête EN LE DISANT : l'acquis est conservé.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) : l'adresse des commandes a tenu
    // — elle redirige les anonymes (302 mesuré hors session le 22/08/2026).
    ctx.preuveDeListe?.({
      session: `page des commandes servie au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const invoices = [];
    let dejaDeposees = 0;
    let sansIdentifiant = 0;
    let sansFacture = 0;
    let arret = false;

    const traiterLaListeAffichee = async (etiquette) => {
      const commandes = await lireCommandes(page);
      log(`${ID} : ${etiquette} — ${commandes.length} commande(s) affichée(s).`);

      for (let rang = 0; rang < commandes.length; rang++) {
        const commande = commandes[rang];

        if (!commande.orderId) {
          sansIdentifiant++;
          log(`${ID} : commande ${rang + 1}/${commandes.length} — l'identifiant que portent `
            + 'les adresses de ses liens n\'a pas pu être lu, elle est passée pour ne pas '
            + 'risquer un doublon. Signalez-le si cela se répète.');
          continue;
        }

        const remoteId = remoteIdPour(commande.orderId);
        if (connus.has(remoteId)) {
          // L'ancre d'idempotence : la commande est déjà déposée, son détail
          // n'est même pas rouvert.
          dejaDeposees++;
          continue;
        }

        // Le lien de facture : sur la ligne quand le rendu serveur l'y a mis,
        // sinon en rouvrant « Détails » (mesuré le 24/08/2026 : la liste
        // rafraîchie en AJAX ne le porte plus).
        let visible = !!commande.factureHref;
        if (!visible && (await ouvrirDetail(page, commande.orderId))) {
          visible = await attendreFacture(page, commande.orderId);
        }

        // Le renvoi vers l'authentification peut arriver au milieu du
        // parcours : on s'arrête EN LE DISANT, ce qui a été lu est conservé.
        if (estPageAuthentification(page.url())) {
          log(`${ID} : le site a renvoyé la lecture vers son écran de connexion au milieu du `
            + `parcours. La récupération s'arrête ici pour ce passage : ${invoices.length} `
            + 'document(s) déjà lu(s) sont conservés, le reste sera repris à un prochain passage.');
          arret = true;
          return;
        }

        if (!visible) {
          sansFacture++;
          log(`${ID} : commande ${rang + 1}/${commandes.length} — aucun lien « Télécharger la `
            + 'facture », ni sur sa ligne ni sur son détail. Rien n\'a été récupéré pour '
            + 'celle-ci ; signalez-le si cela se répète.');
          continue;
        }

        const issuedOn = documentsDePage.dateDepuisTexte(commande.dateTexte);
        const obtenu = await clicDocument.documentDuClic(
          page, context, () => cliquerFacture(page, commande.orderId)
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
    };

    // 1. La période affichée par défaut, telle que le serveur l'a rendue.
    await traiterLaListeAffichee('période affichée par défaut');

    // 2. Les autres périodes proposées par le menu — TOUTES, ou le dire.
    if (!arret) {
      const periodes = await lirePeriodes(page);
      if (periodes === null) {
        log(`${ID} : le menu des périodes n'a pas répondu — seule la période affichée par `
          + 'défaut a été lue. L\'historique récupéré peut être INCOMPLET : relancez plus '
          + 'tard, et signalez-le si cela se répète.');
      } else {
        await fermerMenuPeriodes(page);
        const autres = periodes.filter((p) => !p.selectionnee);
        log(`${ID} : le site propose ${periodes.length} période(s) d'historique — toutes `
          + 'sont parcourues.');
        for (let p = 0; p < autres.length && !arret; p++) {
          const periode = autres[p];
          const affichee = await choisirPeriode(page, periode.libelle);
          if (estPageAuthentification(page.url())) {
            log(`${ID} : le site a renvoyé la lecture vers son écran de connexion au milieu du `
              + `parcours. La récupération s'arrête ici pour ce passage : ${invoices.length} `
              + 'document(s) déjà lu(s) sont conservés, le reste sera repris à un prochain passage.');
            break;
          }
          if (!affichee) {
            log(`${ID} : la période ${p + 2}/${periodes.length} n'a pas pu être affichée — `
              + 'elle est passée pour ce passage. L\'historique récupéré peut être INCOMPLET '
              + 'sur cette période ; signalez-le si cela se répète.');
            continue;
          }
          await traiterLaListeAffichee(`période ${p + 2}/${periodes.length}`);
        }
      }
    }

    if (dejaDeposees) {
      log(`${ID} : ${dejaDeposees} document(s) déjà déposé(s) — reconnu(s) à leur identifiant `
        + 'de commande, rien n\'a été retéléchargé.');
    }
    log(`${ID} : ${invoices.length} document(s) récupéré(s)`
      + `${sansIdentifiant ? `, ${sansIdentifiant} commande(s) sans identifiant lisible` : ''}`
      + `${sansFacture ? `, ${sansFacture} sans lien de facture` : ''}.`);

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  orderIdDepuisHref,
  remoteIdPour,
  lireCommandes,
  lirePeriodes,
  choisirPeriode,
  ouvrirDetail,
  attendreFacture,
  cliquerFacture,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MOTIF_REPERE,
  MOTIF_ORDER_ID,
  SELECTEUR_LIEN_DETAIL,
  SELECTEUR_LIEN_FACTURE,
  SELECTEUR_PERIODES,
};
