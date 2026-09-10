'use strict';

/**
 * Connecteur Bricomarché — le parcours de « Mon historique d'achats », et le
 * reçu que l'espace client ne donne pas (lot 78).
 *
 * ─── D'où vient ce que ce connecteur sait (et ce qu'il ne sait PAS) ──────────
 *
 * MESURÉ en automatique (journaux des lots 47-77, re-confirmés le 09/09/2026) :
 *
 *   - `/my-account` REDIRIGE les anonymes vers `/login` (sonde lot 48) — y
 *     rester prouve la session ;
 *   - le MUR DE SESSION du lot 53 TIENT : la lecture automatique n'est servie
 *     que dans la foulée d'une connexion fraîche par la fenêtre (~10 s après
 *     les captures de 15:38, 15:39 et 17:16 UTC le 09/09/2026) ; une lecture à
 *     froid est renvoyée vers `/login`. Le message du renvoi
 *     (`erreurRenvoiVersAuthentification`) dit exactement ce qui se passe ;
 *   - le menu de `/my-account` porte le libellé « Mon historique d'achats »
 *     (journalisé le 09/09/2026), et son lien pointe sur `/my-account/orders` ;
 *   - ⚠️ L'ADRESSE NUE NE SUFFIT PAS (régression lot 78, cause mesurée par
 *     l'utilisateur le 09/09/2026 au soir) : `/my-account/orders` SANS sa requête rend
 *     une page sans tableau (« aucun tableau reconnu », 0 commande là où le
 *     lot 77 en trouvait 4). La page servie est
 *     `/my-account/orders?choiceOrder=0&historyOrderFilter=all` — ses deux
 *     filtres passent alors sur « Mes achats sur le site » et « Toutes mes
 *     commandes » (au lieu de « De 2026 »). LA REQUÊTE FAIT PARTIE DE
 *     L'ADRESSE : toute navigation vers la liste passe par
 *     `adresseHistorique()`, qui garantit les deux paramètres.
 *
 * RELEVÉ par l'utilisateur sur sa session (09/09/2026), PAS encore lu en automatique :
 * la liste est un tableau « N° de commande / Date / Statut / Montant TTC »,
 * chaque ligne est DÉPLIABLE (articles, frais de livraison, total TTC), avec
 * des filtres périmètre + année. Sur les 4 commandes du compte, UNE n'a pas de
 * facture (statut livré, rien à télécharger). Les extractions ci-dessous
 * visent ces formes par MOTIFS DE LIBELLÉS, jamais par sélecteurs devinés ;
 * le journal dit ce qui ne se retrouve pas.
 *
 * ─── Le reçu reconstitué, et son ancre (lot 78, modèle Atma lot 74) ──────────
 *
 * Une commande sans facture téléchargeable reçoit un REÇU RECONSTITUÉ par le
 * gabarit commun (`connectors/releve-reconstitue.js`, nature « recu ») : le
 * bandeau dit en toutes lettres que le document est produit par crabe et n'est
 * pas une facture du vendeur ; le tableau recopie ce que la ligne dépliée
 * AFFICHE — rien d'inventé, rien de calculé.
 *
 * `remote_id` est ancré sur le NUMÉRO DE COMMANDE (`bricomarche-commande-N`),
 * pas sur la nature du document : l'ancre désigne la commande. Si une vraie
 * facture apparaît plus tard pour cette commande, c'est le MÊME identifiant
 * qui la désignera — le remplacement du reçu par la facture sera un geste de
 * code assumé, pas une collision d'ancres. Rien de ce remplacement n'est codé
 * ici. Et une commande dont la facture EXISTE mais n'a pas pu être lue n'est
 * PAS reconstituée : l'ancre reste libre, le prochain passage réessaie la
 * facture — la reconstituer masquerait le vrai document sous la même ancre.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');
const releve = require('../../releve-reconstitue');
const history = require('../../history');
const { normalizeFrenchDate } = require('../../scraping');

const ID = 'bricomarche';
const NOM = 'Bricomarché';
const CHAMP_HISTORIQUE = 'historique';

// Mesuré le 23/08/2026 (sonde lot 48, visiteur anonyme) : le lien « Se
// connecter » du site pointe sur /my-account, qui REDIRIGE les anonymes vers
// /login. C'est le point d'entrée prouvé de l'espace client.
const URL_COMMANDES = 'https://www.bricomarche.com/my-account';
const CHEMIN_LISTE = /\/my-account/i;

/** Le libellé du menu, JOURNALISÉ sur la vraie page le 09/09/2026. */
const MOTIF_HISTORIQUE = /mon\s+historique\s+d['’]achats/i;
/**
 * Les paramètres SANS lesquels la liste ne rend pas son tableau (mesuré par
 * l'utilisateur le 09/09/2026 : « Mes achats sur le site » + « Toutes mes commandes »).
 * La requête fait partie de l'adresse — voir l'en-tête du fichier.
 */
const PARAMETRES_HISTORIQUE = { choiceOrder: '0', historyOrderFilter: 'all' };
/** Le chemin du lien du menu, journalisé au lot 78. */
const CHEMIN_HISTORIQUE = '/my-account/orders';

/**
 * L'adresse de la liste AVEC ses paramètres. Part du href du menu quand il est
 * fourni (si le site déplace la page, on le suit), et garantit les deux
 * paramètres mesurés sans écraser ceux que le lien porterait déjà. Fonction
 * pure, testée — le test qui la couvre verrouille la régression du lot 78.
 */
function adresseHistorique(href, base) {
  const url = new URL(href || CHEMIN_HISTORIQUE, base || 'https://www.bricomarche.com/');
  for (const [cle, valeur] of Object.entries(PARAMETRES_HISTORIQUE)) {
    if (!url.searchParams.has(cle)) url.searchParams.set(cle, valeur);
  }
  return url.href;
}
/** L'en-tête du tableau relevé par l'utilisateur (09/09/2026) — à confirmer en auto. */
const MOTIF_ENTETE_COMMANDE = /n[°o]\s*(de\s*)?commande/i;
/** Un déclencheur de facture dans une ligne dépliée. */
const MOTIF_FACTURE = /factur|invoice|t[ée]l[ée]charg|\bpdf\b/i;

/** `/login` est couvert par le motif générique. */
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
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // La redirection des anonymes est MESURÉE depuis le 23/08/2026 (sonde
        // lot 48) : /my-account renvoie les visiteurs vers /login.
        redirigeLesAnonymes: true,
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
 * Rejoint « Mon historique d'achats » depuis /my-account : par le HREF du lien
 * du menu quand il en a un (une navigation franche vaut mieux qu'un clic dont
 * on ne sait rien), par le clic sinon. Dans les deux cas l'adresse finalement
 * visée passe par `adresseHistorique()` : le href du menu est NU (journalisé
 * au lot 78) et la page nue ne rend pas son tableau — la requête fait partie
 * de l'adresse.
 */
async function atteindreLHistorique(page, log) {
  const lien = await page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const el = [...document.querySelectorAll('a, button, [role="button"]')]
      .find((b) => re.test(String(b.innerText || '').replace(/\s+/g, ' ').trim()));
    if (!el) return null;
    return { href: el.getAttribute('href') || null };
  }, MOTIF_HISTORIQUE.source).catch(() => null);

  if (!lien) {
    log(`${ID} : le libellé « Mon historique d'achats » ne se retrouve pas sur /my-account — `
      + 'la présentation a peut-être changé depuis le relevé du 09/09/2026.');
    return false;
  }

  if (lien.href) {
    const cible = adresseHistorique(lien.href, page.url());
    await page.goto(cible, { waitUntil: 'domcontentloaded' }).catch(() => {});
  } else {
    await page.evaluate((motif) => {
      const re = new RegExp(motif, 'i');
      const el = [...document.querySelectorAll('a, button, [role="button"]')]
        .find((b) => re.test(String(b.innerText || '').replace(/\s+/g, ' ').trim()));
      if (el) el.click();
    }, MOTIF_HISTORIQUE.source).catch(() => {});
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw profilMarchand.erreurRenvoiVersAuthentification(
      NOM, `redirection vers ${page.url()} en rejoignant l'historique d'achats`);
  }
  // Après un clic (pas de href), le site a pu servir la liste NUE — celle qui
  // ne rend pas son tableau (régression lot 78). On force alors l'adresse
  // complète, paramètres compris.
  const atteinte = page.url();
  if (atteinte.includes(CHEMIN_HISTORIQUE) && adresseHistorique(atteinte) !== atteinte) {
    await page.goto(adresseHistorique(atteinte), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
  }
  log(`${ID} : « Mon historique d'achats » atteint — adresse mesurée : ${page.url()}.`);
  return true;
}

/**
 * Ce que le tableau de l'historique montre : les cellules de chaque ligne du
 * tableau dont l'EN-TÊTE porte « N° de commande » (forme relevée par l'utilisateur le
 * 09/09/2026). Rend aussi les libellés visibles quand rien ne se reconnaît,
 * pour que le journal serve au diagnostic.
 */
const EXTRAIRE_LIGNES = (motifEntete) => {
  const reEntete = new RegExp(motifEntete, 'i');
  const tables = [...document.querySelectorAll('table')];
  const bonne = tables.find((t) => reEntete.test(t.innerText || ''));
  if (!bonne) {
    return {
      lignes: [],
      libelles: [...document.querySelectorAll('h1, h2, h3, th, button, a')]
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length <= 60).slice(0, 25),
    };
  }
  const rangees = [...bonne.querySelectorAll('tr')];
  const lignes = rangees
    .map((tr) => [...tr.querySelectorAll('td, th')]
      .map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()))
    .filter((cellules) => cellules.length >= 3);
  return { lignes, libelles: [] };
};

/**
 * Les lignes brutes du tableau ramenées aux commandes qu'elles décrivent.
 * L'en-tête (celle qui porte « N° de commande ») fixe l'ordre des colonnes ;
 * sans elle, l'ordre relevé par l'utilisateur (numéro, date, statut, montant) sert de
 * repli. Fonction pure, testée.
 */
function analyserLignes(brutes) {
  const lignes = Array.isArray(brutes) ? brutes : [];
  const entete = lignes.find((c) => c.some((cellule) => MOTIF_ENTETE_COMMANDE.test(cellule)));
  const indice = (motif, defaut) => {
    if (!entete) return defaut;
    const i = entete.findIndex((cellule) => motif.test(cellule));
    return i >= 0 ? i : defaut;
  };
  const iNumero = indice(MOTIF_ENTETE_COMMANDE, 0);
  const iDate = indice(/date/i, 1);
  const iStatut = indice(/statut/i, 2);
  const iMontant = indice(/montant/i, 3);

  const commandes = [];
  for (const cellules of lignes) {
    if (cellules === entete) continue;
    const numero = String(cellules[iNumero] || '').trim();
    // Un numéro de commande porte des chiffres et reste court : tout le reste
    // (ligne de filtre, pied de tableau) est écarté sans être inventé.
    if (!/\d/.test(numero) || numero.length > 40) continue;
    commandes.push({
      numero,
      date: String(cellules[iDate] || '').trim(),
      statut: String(cellules[iStatut] || '').trim(),
      montant: String(cellules[iMontant] || '').trim(),
    });
  }
  return commandes;
}

/** L'ancre d'une commande — voir l'en-tête : elle désigne la COMMANDE. */
function remoteIdCommande(numero) {
  return `${ID}-commande-${String(numero).replace(/\s+/g, '')}`;
}

/**
 * Déplie la ligne d'une commande (relevé de l'utilisateur : chaque ligne est dépliable) et
 * rend ce que sa zone montre : les lignes de texte du conteneur qui porte le
 * numéro, et les libellés de ses déclencheurs de facture. Le clic part DANS la
 * page (leçon Boulanger, lot 50).
 */
async function deplierLaCommande(page, numero) {
  await page.evaluate((num) => {
    const profonds = [...document.querySelectorAll('td, th, span, div, button, a')]
      .filter((el) => (el.innerText || '').includes(num)
        && ![...el.children].some((enfant) => (enfant.innerText || '').includes(num)));
    const cible = profonds[0];
    if (!cible) return;
    const rangee = cible.closest('tr') || cible;
    try { rangee.scrollIntoView(); } catch { /* */ }
    rangee.click();
  }, String(numero)).catch(() => {});
  await page.waitForTimeout(2000).catch(() => {});

  return page.evaluate(({ num, motifFacture }) => {
    const reFacture = new RegExp(motifFacture, 'i');
    const profonds = [...document.querySelectorAll('td, th, span, div')]
      .filter((el) => (el.innerText || '').includes(num)
        && ![...el.children].some((enfant) => (enfant.innerText || '').includes(num)));
    const noeud = profonds[0];
    if (!noeud) return { lignes: [], declencheurs: [] };
    // Le conteneur de la commande : sa rangée puis, si le dépliage a écrit à
    // côté de la rangée, la zone qui la suit — on remonte jusqu'à englober le
    // texte déplié (au plus l'élément englobant du tableau).
    let conteneur = noeud.closest('tr') || noeud;
    for (let n = 0; n < 3 && conteneur.parentElement; n++) {
      const texte = conteneur.parentElement.innerText || '';
      if (texte.length > (conteneur.innerText || '').length * 4) break;
      conteneur = conteneur.parentElement;
    }
    const zone = conteneur.closest('tbody') || conteneur;
    return {
      lignes: (zone.innerText || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean).slice(0, 60),
      declencheurs: [...zone.querySelectorAll('a, button, [role="button"]')]
        .map((el) => ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))
          .replace(/\s+/g, ' ').trim())
        .filter((t) => t && reFacture.test(t)).slice(0, 5),
    };
  }, { num: String(numero), motifFacture: MOTIF_FACTURE.source }).catch(() => ({ lignes: [], declencheurs: [] }));
}

/** Clique le déclencheur de facture d'une commande dépliée, dans la page. */
async function cliquerFacture(page, numero) {
  return page.evaluate(({ num, motifFacture }) => {
    const reFacture = new RegExp(motifFacture, 'i');
    const profonds = [...document.querySelectorAll('td, th, span, div')]
      .filter((el) => (el.innerText || '').includes(num)
        && ![...el.children].some((enfant) => (enfant.innerText || '').includes(num)));
    const noeud = profonds[0];
    if (!noeud) return false;
    const zone = (noeud.closest('tr') || noeud).closest('tbody')
      || noeud.closest('tr') || noeud;
    const cible = [...zone.querySelectorAll('a, button, [role="button"]')]
      .find((el) => reFacture.test(((el.innerText || '') + ' '
        + (el.getAttribute('aria-label') || ''))));
    if (!cible) return false;
    try { cible.scrollIntoView(); } catch { /* */ }
    cible.click();
    return true;
  }, { num: String(numero), motifFacture: MOTIF_FACTURE.source }).catch(() => false);
}

/**
 * Le reçu d'UNE commande sans facture, par le gabarit commun — nature « recu »,
 * donc avec le bandeau qui dit qu'il est reconstitué par crabe et n'est pas
 * une facture de Bricomarché. Le tableau recopie les lignes de la zone
 * dépliée telles qu'affichées : articles, frais de livraison, total TTC —
 * rien d'ajouté, rien de calculé.
 */
function construireRecu({ numero, date, statut, lignes, genereLe }) {
  return releve.construire({
    nature: 'recu',
    service: NOM,
    compte: null,
    genereLe,
    colonnes: [{ cle: 'ligne', titre: 'Détail de la commande, tel qu\'affiché dans votre espace client' }],
    operations: lignes.map((ligne) => ({ ligne })),
    mentions: [
      `Commande n° ${numero} — date affichée par l'espace client : ${date}`,
      ...(statut ? [`Statut affiché au moment de la lecture : ${statut}`] : []),
      'Source : votre espace client Bricomarché (« Mon historique d\'achats »).',
      'Cette commande ne proposait aucune facture à télécharger au moment de la lecture.',
    ],
  });
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
function phrasePrecision(vues, reconstitues) {
  return `— ${vues} commande(s) dans votre historique d'achats ; quand une commande n'a pas de `
    + 'facture à télécharger, crabe reconstitue un reçu marqué comme tel'
    + `${reconstitues ? ` (${reconstitues} à cette exécution)` : ''}.`;
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
      `Connexion valide — votre espace client ${NOM} est servi à votre compte. `
      + 'L\'historique d\'achats sera lu à la prochaine récupération.',
  }));
}

/**
 * Lit « Mon historique d'achats » : télécharge la facture de chaque commande
 * qui en propose une, reconstitue un reçu pour celles qui n'en ont pas.
 * Idempotent par l'ancre : une commande déjà déposée n'est ni dépliée ni
 * recliquée.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const fenetre = borneHistorique(config, ctx);

  return surLaListe(ctx, async (etat, vue, page, context) => {
    const atteint = await atteindreLHistorique(page, log);
    if (!atteint) {
      // Sans la liste, rien ne peut être affirmé : échec explicite, jamais un
      // faux « aucune nouvelle facture » (lot 31).
      throw erreurPageInconnue('le menu « Mon historique d\'achats » ne se retrouve pas');
    }

    const adresseListe = page.url();
    const brut = await page.evaluate(EXTRAIRE_LIGNES, MOTIF_ENTETE_COMMANDE.source)
      .catch(() => ({ lignes: [], libelles: [] }));
    const commandes = analyserLignes(brut.lignes);

    // La preuve exigée par le socle (lot 31) — la liste est LUE, fût-elle vide.
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: adresseListe,
      elements: commandes.length,
    });
    log(`${ID} : ${commandes.length} commande(s) dans l'historique d'achats, vue par défaut `
      + '(filtres périmètre et année laissés tels quels — leur déroulé reste à mesurer).');
    if (!commandes.length && brut.libelles.length) {
      log(`${ID} : aucun tableau reconnu — libellés visibles : ${brut.libelles.join(' · ')}.`);
    }
    log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);

    const borne = fenetre.from ? fenetre.from.toISOString().slice(0, 10) : null;
    const invoices = [];
    let dejaConnues = 0;
    let horsFenetre = 0;
    let illisibles = 0;
    let reconstituees = 0;
    let facturesRatees = 0;

    for (const commande of commandes) {
      const remoteId = remoteIdCommande(commande.numero);
      if (connus.has(remoteId)) { dejaConnues += 1; continue; }

      const issuedOn = normalizeFrenchDate(commande.date)
        || documentsDePage.dateDepuisTexte(commande.date);
      if (!issuedOn) {
        illisibles += 1;
        log(`${ID} : la commande ${commande.numero} porte une date illisible `
          + `(« ${commande.date || '(vide)'} ») — rien produit pour elle, le prochain passage réessaiera.`);
        continue;
      }
      if (borne && issuedOn < borne) { horsFenetre += 1; continue; }

      const detail = await deplierLaCommande(page, commande.numero);

      if (detail.declencheurs.length) {
        // Une facture est proposée : c'est ELLE le document de la commande.
        const obtenu = await clicDocument.documentDuClic(
          page, context, () => cliquerFacture(page, commande.numero)
        );
        if (obtenu.ok) {
          connus.add(remoteId);
          invoices.push({
            remoteId,
            filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
            issuedOn,
            buffer: obtenu.buffer,
          });
          log(`${ID} : commande ${commande.numero} — facture lue `
            + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
        } else {
          // La facture EXISTE mais n'a pas pu être lue : on ne reconstitue
          // PAS (l'ancre est commune, le reçu masquerait la facture) — le
          // prochain passage réessaiera.
          facturesRatees += 1;
          log(`${ID} : commande ${commande.numero} — un déclencheur de facture est affiché `
            + `(« ${detail.declencheurs[0]} ») mais aucun document n'a été obtenu (${obtenu.grief}). `
            + 'Rien n\'est reconstitué pour elle : le prochain passage réessaiera la facture.');
        }
        continue;
      }

      // Aucune facture proposée : le reçu reconstitué porte ce que la page
      // montre. Sans lignes lisibles, AUCUN reçu partiel (leçon Atma, lot 74).
      if (!detail.lignes.length) {
        illisibles += 1;
        log(`${ID} : commande ${commande.numero} — la zone dépliée n'a pas pu être lue ; `
          + 'aucun reçu produit pour elle, le prochain passage réessaiera.');
        continue;
      }
      connus.add(remoteId);
      reconstituees += 1;
      invoices.push({
        remoteId,
        filename: releve.nomFichierRecu({ service: NOM, reference: `commande-${commande.numero}` }),
        issuedOn,
        buffer: construireRecu({ ...commande, lignes: detail.lignes }),
      });
      log(`${ID} : commande ${commande.numero} — aucune facture proposée, reçu reconstitué `
        + `depuis la ligne dépliée (${detail.lignes.length} ligne(s) recopiée(s)).`);
    }

    log(`${ID} : ${commandes.length} commande(s) vue(s), ${invoices.length} document(s) déposé(s) `
      + `dont ${reconstituees} reçu(s) reconstitué(s)`
      + `${dejaConnues ? `, ${dejaConnues} déjà déposée(s)` : ''}`
      + `${horsFenetre ? `, ${horsFenetre} hors de la période demandée` : ''}`
      + `${facturesRatees ? `, ${facturesRatees} facture(s) affichée(s) mais non lue(s)` : ''}`
      + `${illisibles ? `, ${illisibles} illisible(s)` : ''}.`);

    return {
      accountId: null,
      invoices,
      precision: phrasePrecision(commandes.length, reconstituees),
      couverture: { detail: 'l\'historique d\'achats tel qu\'affiché par l\'espace client (vue par défaut)' },
      aucunDocument: commandes.length === 0
        ? `Votre historique d'achats ${NOM} n'affiche aucune commande reconnue : soit il est vide, `
          + 'soit sa présentation a changé — le journal porte ce qui était affiché.'
        : undefined,
      horsPeriode: commandes.length > 0 && !invoices.length && horsFenetre > 0
        && !illisibles && !facturesRatees
        ? `Les ${commandes.length} commande(s) de votre historique sont toutes antérieures à la `
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
  analyserLignes,
  remoteIdCommande,
  construireRecu,
  phrasePrecision,
  borneHistorique,
  URL_COMMANDES,
  CHEMIN_LISTE,
  CHEMIN_HISTORIQUE,
  PARAMETRES_HISTORIQUE,
  adresseHistorique,
  MOTIF_HISTORIQUE,
  MOTIF_ENTETE_COMMANDE,
  MOTIF_FACTURE,
  EXTRAIRE_LIGNES,
};
