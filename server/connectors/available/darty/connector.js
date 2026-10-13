'use strict';

/**
 * Connecteur Darty — le parcours des documents est ÉCRIT (lot 51), après que
 * la mesure a tranché.
 *
 * ─── L'histoire du mur, en bref ──────────────────────────────────────────────
 *
 * Lot 47 : DataDome refuse tout `www.darty.com` au visiteur anonyme (403
 * constant habillé en page « FNAC DARTY - Maintenance »). Lot 49 : l'adresse
 * des commandes est confirmée sur le vrai compte — c'est la fenêtre qui fait
 * foi, pas la seconde requête. Lot 50, au matin du 23/08/2026 : le connecteur
 * est RENVOYÉ vers l'authentification malgré une session valide (capturée
 * avec un champ de code encore affiché) — le message honnête du renvoi naît
 * là. Le même jour à 11:31 UTC, sur une session neuve (« lien de déconnexion
 * présent »), la liste est atteinte : 6 commandes.
 *
 * ─── Lot 51 : la mesure décide, pas l'hypothèse ──────────────────────────────
 *
 * Trois lectures de liste espacées sur 61 minutes (23/08/2026, 11:56, 12:11,
 * 12:57 UTC) : les trois atteignent la liste et comptent les mêmes
 * 6 commandes, aucun renvoi. La voie directe tient → le parcours s'écrit.
 * Une récupération qui marcherait deux fois sur trois aurait été PIRE qu'une
 * absence de récupération (des trous silencieux) : c'est cette mesure, et
 * elle seule, qui a autorisé ce code.
 *
 * Le mur peut REVENIR en cours de parcours (DataDome juge chaque passage) :
 * chaque page de détail est jugée avant d'être lue — page « Maintenance » ou
 * renvoi vers l'authentification au milieu du parcours arrêtent la
 * récupération EN LE DISANT, et ce qui a déjà été lu est conservé. Jamais un
 * trou silencieux.
 *
 * ─── L'ancre d'idempotence ───────────────────────────────────────────────────
 *
 * Le `remote_id` s'ancre sur le NUMÉRO DE COMMANDE lu sur la page — jamais
 * sur une empreinte du document (leçon OUIGO du lot 46). Une commande déjà
 * déposée n'est même pas rouverte.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');

const ID = 'darty';
const NOM = 'Darty';
// Mesuré le 23/08/2026 (sonde lot 48, visiteur anonyme) : le site affiche
// lui-même /espace_client/mes-commandes dans son pied de page, l'adresse
// REDIRIGE les anonymes vers /authentification/login, et le témoin inventé
// /espace_client/nawak-inexistant-42 rend un 404 franc. L'ancienne adresse
// candidate /nav/extra/compte, jamais prouvée derrière le mur du lot 47,
// était servie SANS marqueur de compte sur la session du 22/08 : une impasse.
const URL_COMMANDES = 'https://www.darty.com/espace_client/mes-commandes';
// Confirmée sur le vrai compte au lot 49 (23/08/2026) : la page des commandes
// s'affichait à cette adresse pendant que le contrôle par seconde requête
// recevait un 403 DataDome — c'est la fenêtre qui fait foi, pas la requête.
const CHEMIN_LISTE = /\/espace_client\/mes-commandes/i;

/**
 * Relevés sur la vraie page des commandes (23/08/2026) : chaque commande est
 * un bloc `data-testid="order"` — les compter, c'est les voir. Le numéro vit
 * dans un `data-testid` « _number_… » (en-tête `data-testid="orderHeader"`),
 * forme « N° » suivi de chiffres : les motifs sont calibrés sur cette FORME,
 * jamais sur une valeur réelle. Le détail vit sur
 * `/espace_client/mes-commandes/<numéro>/0` et la facture y est
 * `data-testid="downloadBillLink"`, libellé « Justificatif de vente »
 * (relevés à l'écran le 23/08/2026).
 */
const SELECTEUR_REPERE = '[data-testid="order"]';
const MOTIF_REPERE = /n[°o]\s*\d/i;
/** Le numéro seul, capturé : c'est lui qui ancre l'idempotence. */
const MOTIF_NUMERO = /n[°o]\s*(\d+)/i;
/** Le lien de détail quand le bloc en porte un — l'adresse relevée en filet. */
const SELECTEUR_LIEN_DETAIL = 'a[href*="/espace_client/mes-commandes/"]';
const urlDetail = (numero) => `https://www.darty.com/espace_client/mes-commandes/${numero}/0`;
/** Le déclencheur de facture du détail, et son libellé relevé en filet. */
const SELECTEUR_FACTURE = '[data-testid="downloadBillLink"]';
const MOTIF_FACTURE = /justificatif de vente/i;

/**
 * La page « Maintenance » de Darty est le refus DataDome habillé (mesuré deux
 * fois le 22/08/2026, HTTP 403 aux deux passages) : la reconnaître évite de
 * chercher une panne du site là où c'est le mur qui parle.
 */
const MOTIF_FAUSSE_MAINTENANCE = /notre site n'est actuellement pas disponible/i;

/** `/nav/connexion` est couvert par le motif générique (`/connexion`). */
function estPageAuthentification(url) {
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
      // Le refus DataDome habillé en maintenance, AVANT tout autre jugement :
      // sans ce contrôle, la page 403 passerait pour une « page inconnue » et
      // enverrait chercher un défaut de reconnaissance là où c'est le mur.
      const fausseMaintenance = await page.evaluate(
        (motif) => new RegExp(motif, 'i').test(document.body?.innerText || ''),
        MOTIF_FAUSSE_MAINTENANCE.source
      ).catch(() => false);
      if (fausseMaintenance) {
        (ctx.log || (() => {}))(
          `${ID} : page « Maintenance » servie — c'est la forme que prend le refus DataDome `
            + 'de Darty (mesuré le 22/08/2026, HTTP 403 constant).'
        );
        throw new Error(profilMarchand.messageMur(NOM));
      }

      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // La redirection des anonymes est MESURÉE depuis le 23/08/2026 (sonde
        // lot 48) : rester sur /espace_client/mes-commandes prouve la session.
        redirigeLesAnonymes: true,
        // Les commandes se comptent sur leur sélecteur RELEVÉ (lot 49), le
        // motif de forme « N° » + chiffres en filet.
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
// La lecture de la liste : chaque bloc `data-testid="order"`, en une passe
// ---------------------------------------------------------------------------

/**
 * Ce que chaque commande MONTRE : son numéro (l'élément au `data-testid`
 * « number », l'en-tête `orderHeader`, le bloc entier en filet), son texte
 * (où vit la date de commande), et l'adresse de son détail quand le bloc
 * porte un lien. Le numéro ancre l'idempotence et le texte donne la date —
 * aucune de ces valeurs ne part au journal.
 */
async function lireCommandes(page) {
  return page.evaluate(({ selOrder, motifNumero, selLien }) => {
    const reNumero = new RegExp(motifNumero, 'i');
    return [...document.querySelectorAll(selOrder)].map((bloc) => {
      const texte = (bloc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      const porteurs = [
        ...bloc.querySelectorAll('[data-testid*="number" i]'),
        ...bloc.querySelectorAll('[data-testid="orderHeader"]'),
      ].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
      const porteur = porteurs.find((t) => reNumero.test(t)) || texte;
      const lien = bloc.querySelector(selLien);
      return {
        numero: (reNumero.exec(porteur) || [null, null])[1],
        texte,
        href: lien ? lien.href : null,
      };
    });
  }, {
    selOrder: SELECTEUR_REPERE,
    motifNumero: MOTIF_NUMERO.source,
    selLien: SELECTEUR_LIEN_DETAIL,
  }).catch(() => []);
}

/** L'identifiant distant : le numéro de commande lu sur la page (lot 46). */
function remoteIdPour(numero) {
  return `${ID}-${String(numero).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Le détail d'une commande : jugé avant d'être lu — le mur peut revenir
// ---------------------------------------------------------------------------

/**
 * DataDome juge chaque passage : une page de détail peut être le refus
 * habillé en « Maintenance », ou un renvoi vers l'authentification, alors
 * même que la liste vient d'être servie. Dire lequel, pour que le parcours
 * s'arrête en le disant — jamais un trou silencieux.
 *
 * @returns {Promise<'mur'|'authentification'|null>}
 */
async function pageDeDetailRefusee(page) {
  const urlCourante = (() => { try { return page.url(); } catch { return ''; } })();
  if (estPageAuthentification(urlCourante)) return 'authentification';
  const maintenance = await page.evaluate(
    (motif) => new RegExp(motif, 'i').test(document.body?.innerText || ''),
    MOTIF_FAUSSE_MAINTENANCE.source
  ).catch(() => false);
  return maintenance ? 'mur' : null;
}

/** Le détail porte-t-il le déclencheur de facture relevé ? */
async function lireDetail(page) {
  return page.evaluate(({ selFacture, motifFacture }) => {
    const re = new RegExp(motifFacture, 'i');
    const declencheur = document.querySelector(selFacture)
      || [...document.querySelectorAll('a, button, [role="button"]')]
        .find((el) => re.test(el.innerText || '') && (el.offsetWidth || el.offsetHeight));
    return { justificatif: !!declencheur };
  }, { selFacture: SELECTEUR_FACTURE, motifFacture: MOTIF_FACTURE.source })
    .catch(() => ({ justificatif: false }));
}

/**
 * Clique le « Justificatif de vente » du détail — par son `data-testid`
 * relevé, le libellé en filet. Le clic part DANS la page.
 */
async function cliquerJustificatif(page) {
  return page.evaluate(({ selDeclencheur, motifDeclencheur }) => {
    const re = new RegExp(motifDeclencheur, 'i');
    const declencheur = document.querySelector(selDeclencheur)
      || [...document.querySelectorAll('a, button, [role="button"]')]
        .find((el) => re.test(el.innerText || '') && (el.offsetWidth || el.offsetHeight));
    if (!declencheur) return false;
    declencheur.click();
    return true;
  }, { selDeclencheur: SELECTEUR_FACTURE, motifDeclencheur: MOTIF_FACTURE.source })
    .catch(() => false);
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
      + `commandes ${NOM}.`,
  }));
}

/**
 * Récupère les justificatifs de vente des commandes.
 *
 * La liste donne les numéros ; chaque commande inconnue est ouverte sur son
 * détail (`/espace_client/mes-commandes/<numéro>/0` — l'adresse que porte le
 * bloc quand il a un lien, la forme relevée sinon), où le « Justificatif de
 * vente » est cliqué — `clic-document` lit le document quelle que soit la
 * voie. Le mur, s'il revient en cours de route, arrête le parcours EN LE
 * DISANT : ce qui a été lu est conservé, le reste attendra un autre passage.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) : l'adresse des commandes a tenu
    // — elle redirige les anonymes (mesuré le 23/08/2026, sonde lot 48).
    ctx.preuveDeListe?.({
      session: `page des commandes servie au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const commandes = await lireCommandes(page);
    log(`${ID} : ${commandes.length} commande(s) lue(s) sur la page `
      + `(sélecteur ${SELECTEUR_REPERE}, relevé du 23/08/2026).`);

    const invoices = [];
    let dejaDeposees = 0;
    let sansNumero = 0;
    let sansJustificatif = 0;

    for (let rang = 0; rang < commandes.length; rang++) {
      const commande = commandes[rang];

      if (!commande.numero) {
        sansNumero++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — son numéro n'a pas pu être lu `
          + 'sur la page, elle est passée pour ne pas risquer un doublon. Signalez-le si cela '
          + 'se répète.');
        continue;
      }

      const remoteId = remoteIdPour(commande.numero);
      if (connus.has(remoteId)) {
        // L'ancre d'idempotence : la commande est déjà déposée, son détail
        // n'est même pas rouvert.
        dejaDeposees++;
        continue;
      }

      await page.goto(commande.href || urlDetail(commande.numero), { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
      await profilMarchand.fermerBandeauCookies(page, () => {});

      // Le mur peut revenir au milieu du parcours (DataDome juge chaque
      // passage — c'est la leçon des mesures du 23/08/2026 au matin) : on
      // s'arrête EN LE DISANT, ce qui a été lu est conservé.
      const refus = await pageDeDetailRefusee(page);
      if (refus) {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — le site a ${refus === 'mur'
          ? 'servi sa page « Maintenance » (la forme que prend le refus DataDome de Darty)'
          : 'renvoyé la lecture vers son écran de connexion'} au milieu du parcours. `
          + `La récupération s'arrête ici pour ce passage : ${invoices.length} document(s) `
          + 'déjà lu(s) sont conservés, le reste sera repris à un prochain passage.');
        break;
      }

      const detail = await lireDetail(page);
      if (!detail.justificatif) {
        sansJustificatif++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — aucun « Justificatif de `
          + 'vente » sur son détail. Rien n\'a été récupéré pour celle-ci ; signalez-le si '
          + 'cela se répète.');
        continue;
      }

      const issuedOn = documentsDePage.dateDepuisTexte(commande.texte);
      const obtenu = await clicDocument.documentDuClic(
        page, context, () => cliquerJustificatif(page)
      );
      if (!obtenu.ok) {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — le justificatif n'a pas été `
          + `lu (${obtenu.grief}). On continue avec les suivantes.`);
        continue;
      }

      log(`${ID} : commande ${rang + 1}/${commandes.length} — justificatif lu `
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
      log(`${ID} : ${dejaDeposees} document(s) déjà déposé(s) — reconnu(s) à leur numéro, `
        + 'rien n\'a été retéléchargé.');
    }
    log(`${ID} : ${invoices.length} document(s) récupéré(s) sur ${commandes.length} commande(s)`
      + `${sansNumero ? `, ${sansNumero} sans numéro lisible` : ''}`
      + `${sansJustificatif ? `, ${sansJustificatif} sans justificatif sur leur détail` : ''}.`);

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
  cliquerJustificatif,
  pageDeDetailRefusee,
  remoteIdPour,
  urlDetail,
  MOTIF_FAUSSE_MAINTENANCE,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MOTIF_REPERE,
  MOTIF_NUMERO,
  SELECTEUR_LIEN_DETAIL,
  SELECTEUR_FACTURE,
  MOTIF_FACTURE,
};
