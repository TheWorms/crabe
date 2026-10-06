'use strict';

/**
 * Connecteur AutoDoc (auto-doc.fr) — les factures des commandes de pièces
 * auto (lot 79).
 *
 * ─── D'où vient ce que ce connecteur sait ────────────────────────────────────
 *
 * MESURÉ le 09/09/2026 (sonde anonyme, Chromium du socle, profil jetable,
 * le serveur de production — scripts/lot79-reco-autodoc-coyote.js) :
 *
 *   - le site vit sur `www.auto-doc.fr` — `www.autodoc.fr`, que le manifeste
 *     d'annonce portait depuis août, est un domaine MORT (erreur SSL) ;
 *   - en HTTP nu, TOUT est 403 derrière Cloudflare (`cf-mitigated:
 *     challenge`) ; le Chromium complet du socle passe (200) — d'où le profil
 *     persistant et la fenêtre visible, comme les autres enseignes ;
 *   - `/profile/orders` et `/profile/order/<x>` demandés SANS session sont
 *     renvoyés vers L'ACCUEIL (`/`) — pas vers un chemin `/login`. Être
 *     renvoyé à la racine en demandant le profil, C'EST le renvoi d'anonyme ;
 *     y rester, c'est être connecté (raisonnement `verifyUrlTient`, lot 40) ;
 *   - un chemin inventé rend un vrai 404 : le renvoi de `/profile/*` vers la
 *     racine est bien une garde de session, pas une page générique.
 *
 * RELEVÉ par l'utilisateur sur sa session (09/09/2026), formes seulement, PAS encore
 * lu en automatique :
 *
 *   - liste `/profile/orders` : une carte par commande portant « Numéro de
 *     commande : <n°> », la date, le montant, un bouton « Détails de la
 *     commande » ;
 *   - détail `/profile/order/<numéro de commande>` : la même carte augmentée
 *     d'un bouton « Télécharger la facture » qui DÉPLIE un menu listant les
 *     factures (« Facture n° 1 », « émise le AAAA.MM.JJ ») avec une icône de
 *     téléchargement ;
 *   - le lien du menu pointe vers `/print-invoice/<jeton>` — un jeton JWT
 *     long, propre à la facture. CE JETON N'EST JAMAIS une ancre ni une ligne
 *     de journal (leçon lot 46 : l'ancre est le numéro de commande ; et un
 *     jeton d'URL vaut un accès au document, il ne s'affiche nulle part).
 *
 * RESTE À MESURER à la première session : le nombre de commandes une fois la
 * liste déroulée (pagination ? tri « Toutes les dates » ?), et si une commande
 * peut porter plusieurs factures. Le journal compte ce qu'il voit.
 *
 * ─── L'ancre ────────────────────────────────────────────────────────────────
 *
 * `remote_id` = `autodoc-commande-<numéro>` : l'ancre désigne la COMMANDE.
 * Si le menu liste PLUSIEURS factures, la première garde cette ancre et les
 * suivantes portent `-facture-<rang>` : une commande vue d'abord avec une
 * facture puis avec deux ne change pas d'ancre pour la première. Jamais le
 * jeton, jamais l'empreinte du PDF.
 *
 * ─── Données personnelles (§1bis) ───────────────────────────────────────────
 *
 * Les pages portent l'adresse de livraison, le numéro de client et le moyen
 * de paiement. Ce parcours ne les lit pas, ne les journalise pas, ne les
 * stocke pas : les extractions capturent le numéro de commande, le rang et la
 * date d'émission — RIEN d'autre, et jamais une recopie du texte des cartes.
 * Les montants ne sont pas lus non plus.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');
const history = require('../../history');
const serieEchecs = require('../../serie-echecs');

const ID = 'autodoc';
const NOM = 'AutoDoc';
const CHAMP_HISTORIQUE = 'historique';

/** La liste des commandes — relevé de l'utilisateur 09/09/2026, redirection mesurée. */
const URL_LISTE = 'https://www.auto-doc.fr/profile/orders';
const CHEMIN_LISTE = /\/profile\/orders(?:[/?#]|$)/i;

/** Le libellé qui identifie une carte de commande (relevé, forme seule). */
const MOTIF_REPERE = /num[ée]ro\s+de\s+commande/i;

/**
 * Le renvoi d'anonyme d'AutoDoc, MESURÉ le 09/09/2026 : `/profile/*` sans
 * session est servi… à la RACINE du site — jamais un chemin `/login`. La
 * racine, demandée en voulant le profil, est donc l'écran « pas de session »
 * de ce site ; le motif générique reste pour un éventuel vrai `/login`.
 */
function estPageAuthentification(url) {
  if (profilMarchand.estPageAuthentification(url)) return true;
  try {
    const u = new URL(String(url));
    return /(^|\.)auto-doc\.fr$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '');
  } catch {
    return false;
  }
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
    { id: ID, nom: NOM, ctx, urlDepart: URL_LISTE, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // Mesuré le 09/09/2026 : /profile/orders éconduit les anonymes vers
        // l'accueil — y rester sans « Se connecter » prouve la session.
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
// Lecture des pages — extraction DANS la page, analyse PURE côté Node
// ---------------------------------------------------------------------------

/**
 * Les numéros de commande de la liste — et RIEN d'autre (§1bis) : la capture
 * regex ne garde que ce qui suit « Numéro de commande : », jamais le texte
 * des cartes (adresse, montant, moyen de paiement restent où ils sont).
 */
const EXTRAIRE_NUMEROS = () => {
  const texte = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const re = /num[ée]ro\s+de\s+commande\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{2,30})/gi;
  const numeros = [];
  let m;
  while ((m = re.exec(texte))) {
    if (!numeros.includes(m[1])) numeros.push(m[1]);
  }
  return {
    numeros,
    // Une pagination existe-t-elle ? On COMPTE ses formes, on ne clique pas :
    // son déroulé reste à mesurer (en-tête du fichier).
    formesPagination: [...document.querySelectorAll('a, button, select')]
      .filter((el) => /page\s+suivante|toutes\s+les\s+dates|voir\s+plus/i
        .test((el.innerText || '').replace(/\s+/g, ' '))).length,
  };
};

/** Le détail d'une commande — adresse construite depuis le relevé de l'utilisateur. */
function adresseDetail(numero) {
  return `https://www.auto-doc.fr/profile/order/${encodeURIComponent(String(numero))}`;
}

/**
 * Déplie le menu des factures : le bouton « Télécharger la facture » de la
 * carte (relevé de l'utilisateur). Le clic part DANS la page (leçon Boulanger, lot 50).
 * Ce bouton ne télécharge rien lui-même — il OUVRE le menu.
 */
const DEPLIER_MENU = () => {
  const bouton = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter((el) => el.offsetWidth || el.offsetHeight)
    .find((el) => /t[ée]l[ée]charger\s+la\s+facture/i
      .test((el.innerText || '').replace(/\s+/g, ' ')));
  if (!bouton) return false;
  try { bouton.scrollIntoView(); } catch { /* hors défilement */ }
  bouton.click();
  return true;
};

/**
 * Ce que le menu déplié liste : pour chaque entrée `/print-invoice/…`, son
 * TEXTE (« Facture n° 1 · émise le AAAA.MM.JJ ») et son href. Le href porte
 * le jeton : il sert au clic, il ne sort JAMAIS de la page (ni ancre, ni
 * journal).
 */
const EXTRAIRE_MENU = () => [...document.querySelectorAll('a[href*="/print-invoice/"]')]
  .map((a) => ({
    texte: ((a.innerText || '') + ' ' + (a.closest('li, [role="menuitem"], div')?.innerText || ''))
      .replace(/\s+/g, ' ').trim().slice(0, 120),
    href: a.getAttribute('href'),
  }));

/**
 * Une entrée de menu, ramenée à ses faits : le rang (« Facture n° 1 ») et la
 * date d'émission (« émise le AAAA.MM.JJ » — points, forme relevée). Pure,
 * testée. Le texte d'entrée ne porte pas le jeton (il est dans le href, que
 * cette fonction ne voit pas).
 */
function analyserEntreeMenu(texte, index) {
  const brut = String(texte || '');
  const rang = Number(/factur\w*\s*n[°o]?\s*(\d+)/i.exec(brut)?.[1]) || index + 1;
  const emise = /(\d{4})\.(\d{2})\.(\d{2})/.exec(brut);
  const issuedOn = emise
    ? `${emise[1]}-${emise[2]}-${emise[3]}`
    : documentsDePage.dateDepuisTexte(brut);
  return { rang, issuedOn };
}

/** L'ancre — voir l'en-tête : la commande, le rang au-delà de la première. */
function remoteIdFacture(numero, rang) {
  const base = `${ID}-commande-${String(numero).replace(/\s+/g, '')}`;
  return rang > 1 ? `${base}-facture-${rang}` : base;
}

/** Clique l'entrée du menu qui porte CE href — dans la page, jamais ailleurs. */
function cliquerEntreeMenu(page, href) {
  return page.evaluate((cible) => {
    const lien = [...document.querySelectorAll('a[href*="/print-invoice/"]')]
      .find((a) => a.getAttribute('href') === cible);
    if (!lien) return false;
    try { lien.scrollIntoView(); } catch { /* hors défilement */ }
    lien.click();
    return true;
  }, href).catch(() => false);
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
  return `— ${vues} commande(s) dans votre espace client ; chaque facture est téléchargée `
    + 'depuis le menu « Télécharger la facture » de la commande.';
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la liste des commandes répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — votre espace client ${NOM} est servi à votre compte `
      + `(${etat.reperes} repère(s) de commande affiché(s)). Les factures seront lues à la `
      + 'prochaine récupération.',
  }));
}

/**
 * Lit la liste des commandes, ouvre le détail de chaque commande inconnue,
 * déplie son menu de factures et télécharge chacune. Idempotent par l'ancre :
 * une commande dont toutes les factures sont déposées n'est pas rouverte —
 * sauf si le compte de factures d'une commande peut croître, ce que seul un
 * passage réel dira (le détail est rouvert tant qu'au moins une ancre de la
 * commande est inconnue ; une commande à facture unique déjà déposée ne l'est
 * pas).
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const fenetre = borneHistorique(config, ctx);

  return surLaListe(ctx, async (etat, vue, page, context) => {
    const releve = await page.evaluate(EXTRAIRE_NUMEROS)
      .catch(() => ({ numeros: [], formesPagination: 0 }));
    const numeros = releve.numeros || [];

    // La preuve exigée par le socle (lot 31) — la liste est LUE, fût-elle vide.
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: URL_LISTE,
      elements: numeros.length,
    });
    log(`${ID} : ${numeros.length} commande(s) sur la liste, telle qu'affichée`
      + (releve.formesPagination
        ? ` — ${releve.formesPagination} forme(s) de pagination ou de tri visibles, non déroulées `
          + '(leur effet reste à mesurer)'
        : ' (aucune forme de pagination reconnue)')
      + '.');
    log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);

    const borne = fenetre.from ? fenetre.from.toISOString().slice(0, 10) : null;
    const invoices = [];
    let dejaConnues = 0;
    let horsFenetre = 0;
    let illisibles = 0;
    let ratees = 0;
    // La sortie anticipée (lot 80) : trois échecs de suite pour la même cause
    // disent tout ce que cinquante diraient, et coûtent une minute au lieu de
    // l'exécution entière.
    const serie = serieEchecs.suiteDEchecs();
    let renoncement = null;

    for (const numero of numeros) {
      // La commande à facture unique déjà déposée : on ne rouvre même pas la
      // page — c'est ce qui rend le second passage presque silencieux.
      if (connus.has(remoteIdFacture(numero, 1))) {
        dejaConnues += 1;
        continue;
      }

      await page.goto(adresseDetail(numero), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
      if (estPageAuthentification(page.url())) {
        throw profilMarchand.erreurRenvoiVersAuthentification(
          NOM, `redirection vers ${page.url()} à l'ouverture de la commande ${numero}`);
      }

      const deplie = await page.evaluate(DEPLIER_MENU).catch(() => false);
      if (deplie) await page.waitForTimeout(2000).catch(() => {});
      const entrees = (await page.evaluate(EXTRAIRE_MENU).catch(() => [])) || [];

      if (!entrees.length) {
        illisibles += 1;
        log(`${ID} : commande ${numero} — `
          + (deplie
            ? 'le menu « Télécharger la facture » s\'est déplié mais aucune entrée de facture '
              + 'ne s\'y retrouve'
            : 'le bouton « Télécharger la facture » ne se retrouve pas sur le détail')
          + ' ; rien produit pour elle, le prochain passage réessaiera.');
        continue;
      }
      if (entrees.length > 1) {
        log(`${ID} : commande ${numero} — ${entrees.length} factures au menu (rangs ancrés).`);
      }

      for (const [index, entree] of entrees.entries()) {
        const { rang, issuedOn } = analyserEntreeMenu(entree.texte, index);
        const remoteId = remoteIdFacture(numero, rang);
        if (connus.has(remoteId)) { dejaConnues += 1; continue; }
        if (!issuedOn) {
          illisibles += 1;
          log(`${ID} : commande ${numero}, facture n° ${rang} — la date d'émission ne se lit `
            + 'pas dans le menu ; rien produit pour elle, le prochain passage réessaiera.');
          continue;
        }
        if (borne && issuedOn < borne) { horsFenetre += 1; continue; }

        const obtenu = await clicDocument.documentDuClic(
          page, context, () => cliquerEntreeMenu(page, entree.href)
        );
        if (!obtenu.ok) {
          ratees += 1;
          log(`${ID} : commande ${numero}, facture n° ${rang} — aucun document obtenu `
            + `(${obtenu.grief}) ; le prochain passage réessaiera.`);
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
        log(`${ID} : commande ${numero}, facture n° ${rang} — lue `
          + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
      }
      // Le renoncement traverse les DEUX boucles : la commande suivante
      // buterait sur la même cause que les factures de celle-ci.
      if (renoncement) break;
    }

    log(`${ID} : ${numeros.length} commande(s) vue(s), ${invoices.length} facture(s) déposée(s)`
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
      precision: phrasePrecision(numeros.length),
      couverture: { detail: 'la liste des commandes telle qu\'affichée par l\'espace client (vue par défaut)' },
      aucunDocument: numeros.length === 0
        ? `Votre espace client ${NOM} n'affiche aucune commande reconnue : soit il est vide, `
          + 'soit sa présentation a changé — le journal porte le compte de ce qui était affiché.'
        : undefined,
      horsPeriode: numeros.length > 0 && !invoices.length && horsFenetre > 0 && !illisibles && !ratees
        ? `Les factures de vos ${numeros.length} commande(s) sont toutes antérieures à la période `
          + 'demandée — élargissez l\'historique de la fiche pour les récupérer.'
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
  URL_LISTE,
  CHEMIN_LISTE,
  MOTIF_REPERE,
  EXTRAIRE_NUMEROS,
  EXTRAIRE_MENU,
  adresseDetail,
  analyserEntreeMenu,
  remoteIdFacture,
  phrasePrecision,
  borneHistorique,
};
