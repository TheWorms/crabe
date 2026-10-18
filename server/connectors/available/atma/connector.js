'use strict';

/**
 * Connecteur Atma Kitchenware — le reçu que Shopify ne donne pas (lot 74).
 *
 * ─── Ce que la mesure SUR SESSION du 09/09/2026 a établi ────────────────────
 *
 * La reconnaissance anonyme du lot 72 (reconnaissance anonyme du lot 72) avait
 * établi la porte : boutique Shopify, espace client « comptes clients » sur
 * shopify.com, code à usage unique par e-mail, `domaineEspaceClient` déclaré.
 * Le lot 74 a ouvert la session enregistrée et mesuré le reste :
 *
 *   - la liste `/account/orders` montre une commande par bloc `article`, dont
 *     le titre est un `h2[id^="order-"]` (« Commande #NNNNN ») et le lien de
 *     détail un `a[href*="/account/orders/<identifiant numérique>"]`. Les
 *     classes CSS sont GÉNÉRÉES (r0qqvk1, _1fragemws…) : s'y ancrer casserait
 *     à la première recompilation du thème — l'ancre est l'identifiant de
 *     titre et la forme du lien ;
 *   - « Acheter à nouveau » et « Retourner ma commande » sont des LIENS
 *     (`/cart/…`, `/a/return`) à effet : jamais suivis, ni ici ni ailleurs ;
 *   - NI la liste NI le détail ne proposent de facture, de reçu ou de
 *     téléchargement : les motifs facture|invoice|reçu|receipt|télécharg|
 *     download|PDF ne trouvent RIEN sur les deux pages. C'est le fait qui
 *     fonde ce connecteur : crabe reconstitue un reçu par commande, par le
 *     gabarit commun (`connectors/releve-reconstitue.js`, nature « recu »),
 *     avec son bandeau qui dit en toutes lettres que le document n'est pas
 *     une facture d'Atma ;
 *   - le détail affiche « Commande #NNNNN », « Confirmée le 3 févr. 2026 »
 *     (dates françaises ABRÉGÉES, aucun attribut `datetime` ISO — d'où
 *     l'extension de `normalizeFrenchDate` à ces formes), « Statut du
 *     traitement de la commande : … », puis les sections « Articles de la
 *     commande » et « Totaux de la commande » (sous-total, expédition, total,
 *     taxes incluses — tous AFFICHÉS : le reçu les recopie, il ne calcule
 *     rien) ; la section « Détails de la commande » qui suit porte l'adresse
 *     et le contact — elle n'est pas reprise ;
 *   - AUCUNE pagination observée (liste courte au moment de la mesure) : la
 *     liste est lue telle qu'affichée, et le journal dit ce compte.
 *
 * ─── L'ancre, et le jour où Shopify servirait une vraie facture ──────────────
 *
 * `remote_id` est ancré sur le NUMÉRO DE COMMANDE (`atma-commande-NNNNN`),
 * pas sur la nature du document : l'ancre désigne la commande, le reçu
 * reconstitué n'est que ce que crabe sait en produire aujourd'hui. Si un jour
 * la boutique sert une vraie facture, c'est le MÊME identifiant qui la
 * désignera — le remplacement du reçu par la facture sera alors un geste de
 * code assumé, pas une collision d'ancres. Rien de ce remplacement n'est
 * codé ici.
 */

const profilMarchand = require('../../profil-marchand');
const releve = require('../../releve-reconstitue');
const history = require('../../history');
const { normalizeFrenchDate } = require('../../scraping');

const ID = 'atma';
const NOM = 'Atma Kitchenware';

const CHAMP_HISTORIQUE = 'historique';

/**
 * La porte de l'espace client, sur le site de la boutique : mesurée le
 * 08/09/2026 (302 vers l'espace client Shopify, témoin en 404 franc).
 */
const URL_COMPTE = 'https://atmakitchenware.fr/account';

/**
 * Où un compte CONNECTÉ atterrit : `/account` de la boutique, ou l'espace
 * client Shopify — `shopify.com/<boutique>/account` et sa liste de commandes
 * `…/account/orders` (cibles des 302 mesurés). L'identifiant de boutique est
 * un `\d+` générique, jamais la valeur du compte observé (§1bis). Ancré sur
 * une fin, une query ou un fragment APRÈS `/account` ou `/account/orders` —
 * `/account/login` commence pareil mais n'est ni l'un ni l'autre, et le
 * prendre pour l'espace client ferait dire « connecté » à un écran de
 * connexion (leçon electro-depot, lot 52).
 */
const CHEMIN_COMPTE = /(?:atmakitchenware\.fr\/account|shopify\.com\/\d+\/account(?:\/orders)?)(?:[?#]|$)/i;

/**
 * Une commande de la liste = son titre `h2[id^="order-"]` (mesuré le
 * 09/09/2026 sur la session réelle). Compter ces éléments, c'est compter les
 * commandes — la mesure qui remplace l'indice générique (lot 49).
 */
const SELECTEUR_COMMANDE = 'h2[id^="order-"]';

/**
 * `shopify.com/authentication/…/login` est couvert par le motif générique
 * (`/authentication`, `/login`) — pas besoin d'un motif d'hôte ici.
 */
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
async function surLeCompte(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMPTE, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_COMPTE,
        estAuthentification: estPageAuthentification,
        // Mesuré le 08/09/2026 : /account éconduit les anonymes vers l'écran
        // de connexion Shopify — y rester sans « Se connecter » prouve.
        redirigeLesAnonymes: true,
        selecteurRepere: SELECTEUR_COMMANDE,
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
 * Ce que la liste montre : le titre de chaque commande et son lien de détail.
 * Exécutée dans la page ; le marqueur d'appel (`{ extraction: 'liste' }`) ne
 * sert qu'aux tests, qui simulent `evaluate`.
 */
const EXTRAIRE_LISTE = () => [...document.querySelectorAll('h2[id^="order-"]')].map((titre) => {
  let englobant = titre;
  while (englobant && englobant.tagName !== 'ARTICLE') englobant = englobant.parentElement;
  const lien = (englobant || titre.parentElement)
    ?.querySelector('a[href*="/account/orders/"]')?.getAttribute('href') || null;
  return { titre: (titre.innerText || '').trim(), href: lien };
});

/** Ce que le détail montre : ses titres et son texte, lignes préservées. */
const EXTRAIRE_DETAIL = () => ({
  titres: [...document.querySelectorAll('h1')].map((h) => (h.innerText || '').trim()),
  texte: document.body.innerText || '',
});

/** « Commande #12345 » → « 12345 » ; rien d'autre n'est un numéro. */
function numeroDeCommande(titre) {
  return /#\s*(\d+)/.exec(String(titre || ''))?.[1] || null;
}

/** L'ancre d'une commande — voir l'en-tête : elle désigne la COMMANDE. */
function remoteIdCommande(numero) {
  return `${ID}-commande-${numero}`;
}

/**
 * Le texte du détail, ramené aux faits affichés.
 *
 * Tout vient du texte rendu, jamais d'un calcul : le numéro (« Commande
 * #NNNNN »), la date (« Confirmée le 3 févr. 2026 »), le statut (« Statut du
 * traitement de la commande : Livrée »), et les lignes du résumé — celles qui
 * suivent « Articles de la commande » jusqu'à « Détails de la commande »
 * EXCLUE (cette dernière section porte l'adresse et le contact, qui n'ont
 * rien à faire dans le reçu). Une pièce manquante rend `null` sur son champ :
 * c'est l'appelant qui décide de ne PAS produire un reçu illisible.
 */
function analyserDetail(texte) {
  const brut = String(texte || '');
  const numero = numeroDeCommande(/Commande\s*#\s*\d+/.exec(brut)?.[0]);
  const confirmee = /Confirmée le\s+(\d{1,2}\s+\S+\s+\d{4})/.exec(brut)?.[1] || null;
  const statut = /Statut du traitement de la commande\s*:\s*([^\n]+)/.exec(brut)?.[1]?.trim() || null;

  const lignes = [];
  let dedans = false;
  for (const ligne of brut.split('\n').map((l) => l.trim())) {
    if (!dedans) {
      if (ligne === 'Articles de la commande') dedans = true;
      continue;
    }
    if (ligne === 'Détails de la commande') break;
    if (ligne) lignes.push(ligne);
  }
  return { numero, confirmee, statut, lignes };
}

/**
 * Le reçu d'UNE commande, par le gabarit commun — nature « recu », donc avec
 * le bandeau qui dit qu'il est reconstitué et n'est pas une facture d'Atma.
 * Le tableau recopie les lignes du résumé telles qu'affichées : articles,
 * sous-total, expédition, total, taxes incluses — rien d'ajouté, rien de
 * calculé.
 */
function construireRecu({ numero, confirmee, statut, lignes, genereLe }) {
  return releve.construire({
    nature: 'recu',
    service: NOM,
    compte: null,
    genereLe,
    colonnes: [{ cle: 'ligne', titre: 'Résumé de la commande, tel qu\'affiché dans l\'espace client' }],
    operations: lignes.map((ligne) => ({ ligne })),
    mentions: [
      `Commande n° ${numero} — confirmée le ${confirmee} (date affichée par l'espace client)`,
      ...(statut ? [`Statut affiché au moment de la lecture : ${statut}`] : []),
      'Source : votre espace client Atma Kitchenware (comptes clients Shopify),',
      'page de la commande. Atma Kitchenware ne fournit pas de facture.',
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

/**
 * La phrase que la carte porte TOUJOURS (champ `precision`, lot 70) : c'est
 * elle qui dit le fait — Atma ne fournit pas de facture, les documents sont
 * des reçus reconstitués — sous « N facture(s) récupérée(s) » comme sous
 * « Aucune nouvelle facture ».
 */
function phrasePrecision(vues) {
  // Le tiret d'attaque fait la jointure : la phrase arrive TOUJOURS derrière
  // « N factures récupérées » ou « Aucune nouvelle facture », avec une espace
  // pour seule couture (scheduler.js) — sans lui, les deux comptes se collent
  // (« 2 factures récupérées 2 commande(s)… », vu au premier essai réel).
  return `— ${vues} commande(s) affichée(s) dans votre espace client ; ${NOM} ne fournit pas `
    + 'de facture, crabe reconstitue donc un reçu par commande, marqué comme tel.';
}

/**
 * Conduit la page de la liste : le renvoi mesuré dépose déjà sur
 * `/account/orders`, mais si l'atterrissage est `/account`, on rejoint la
 * liste par la forme mesurée (même boutique, même hôte).
 */
async function atteindreLesCommandes(page, log) {
  if (/\/account\/orders(?:[/?#]|$)/.test(page.url())) return;
  const boutique = /^(https:\/\/shopify\.com\/\d+)\/account/i.exec(page.url());
  if (!boutique) throw erreurPageInconnue(`l'adresse servie est ${page.url()}`);
  const cible = `${boutique[1]}/account/orders`;
  log(`${ID} : atterri sur ${page.url().split(/[?#]/)[0]} — navigation vers la liste (${cible}).`);
  await page.goto(cible, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
  if (!/\/account\/orders(?:[/?#]|$)/.test(page.url())) {
    throw erreurPageInconnue(`la liste des commandes n'est pas servie (${page.url()})`);
  }
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, l'espace client est servi. */
async function test(config, ctx = {}) {
  return surLeCompte(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — l'espace client ${NOM} est servi à votre compte `
      + `(${etat.reperes} commande(s) affichée(s)). ${NOM} ne fournit pas de facture : `
      + 'crabe reconstituera un reçu par commande, marqué comme tel.',
  }));
}

/**
 * Reconstitue un reçu par commande affichée que la base ne connaît pas
 * encore : lecture de la liste, puis du DÉTAIL de chaque commande nouvelle
 * (un clic qui navigue — jamais « Acheter à nouveau » ni « Retourner ma
 * commande »). Idempotent par l'ancre : une commande déjà reconstituée n'est
 * ni revisitée ni reproduite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const fenetre = borneHistorique(config, ctx);

  return surLeCompte(ctx, async (etat, vue, page) => {
    await atteindreLesCommandes(page, log);
    const cartes = await page.evaluate(EXTRAIRE_LISTE, { extraction: 'liste' });

    const commandes = [];
    for (const carte of cartes || []) {
      const numero = numeroDeCommande(carte.titre);
      if (!numero || !carte.href) {
        // Une carte sans numéro ou sans lien ne peut être ni identifiée ni
        // ouverte : le dire vaut mieux qu'inventer une ancre.
        log(`${ID} : une carte de commande sans ${numero ? 'lien' : 'numéro'} est ignorée `
          + `(titre : « ${carte.titre || '(vide)'} »).`);
        continue;
      }
      commandes.push({ numero, href: carte.href });
    }

    // La preuve exigée par le socle (lot 31).
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: URL_COMPTE,
      elements: commandes.length,
    });
    log(`${ID} : ${commandes.length} commande(s) sur la liste, telle qu'affichée `
      + '(aucune pagination observée sur ce site à ce jour).');
    log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);

    const borne = fenetre.from ? fenetre.from.toISOString().slice(0, 10) : null;
    const adresseListe = page.url();
    const invoices = [];
    let dejaConnues = 0;
    let horsFenetre = 0;
    let illisibles = 0;

    for (const commande of commandes) {
      const remoteId = remoteIdCommande(commande.numero);
      if (connus.has(remoteId)) {
        // Déjà reconstituée : on ne rouvre même pas la page — c'est ce qui
        // rend le second passage silencieux pour la boutique.
        dejaConnues += 1;
        continue;
      }

      const adresse = new URL(commande.href, adresseListe).href;
      await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
      if (estPageAuthentification(page.url())) {
        throw profilMarchand.erreurRenvoiVersAuthentification(
          NOM, `redirection vers ${page.url()} à l'ouverture de la commande ${commande.numero}`);
      }

      const brut = await page.evaluate(EXTRAIRE_DETAIL, { extraction: 'detail' });
      const detail = analyserDetail(brut?.texte);
      const issuedOn = normalizeFrenchDate(detail.confirmee);

      if (detail.numero !== commande.numero || !detail.lignes.length || !issuedOn) {
        // Page illisible ou incohérente : AUCUN reçu partiel. L'ancre reste
        // inconnue, le prochain passage réessaiera — et le journal dit quoi.
        illisibles += 1;
        log(`${ID} : la commande ${commande.numero} n'a pas pu être lue — `
          + (detail.numero !== commande.numero
            ? `la page ouverte porte « ${detail.numero || 'aucun numéro'} »`
            : !detail.lignes.length
              ? 'le résumé de la commande est introuvable dans la page'
              : `la date « ${detail.confirmee || '(absente)'} » n'est pas comprise`)
          + ' ; aucun reçu produit pour elle, la prochaine récupération réessaiera.');
        continue;
      }
      if (borne && issuedOn < borne) {
        horsFenetre += 1;
        continue;
      }

      invoices.push({
        remoteId,
        filename: releve.nomFichierRecu({ service: NOM, reference: `commande-${commande.numero}` }),
        issuedOn,
        buffer: construireRecu(detail),
      });
    }

    log(`${ID} : ${commandes.length} commande(s) vue(s), ${invoices.length} reçu(s) reconstitué(s)`
      + `${dejaConnues ? `, ${dejaConnues} déjà reconstituée(s)` : ''}`
      + `${horsFenetre ? `, ${horsFenetre} hors de la période demandée` : ''}`
      + `${illisibles ? `, ${illisibles} illisible(s)` : ''}`
      + ` — ${NOM} ne fournit pas de facture.`);

    return {
      accountId: null,
      invoices,
      precision: phrasePrecision(commandes.length),
      couverture: { detail: 'la liste des commandes telle qu\'affichée par l\'espace client' },
      aucunDocument: commandes.length === 0
        ? `Votre espace client ${NOM} n'affiche aucune commande : il n'y a rien à reconstituer.`
        : undefined,
      horsPeriode: commandes.length > 0 && !invoices.length && horsFenetre > 0 && !illisibles
        ? `Les ${commandes.length} commande(s) de votre espace client sont toutes antérieures à la `
          + 'période demandée — élargissez l\'historique de la fiche pour les reconstituer.'
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
  URL_COMPTE,
  CHEMIN_COMPTE,
  SELECTEUR_COMMANDE,
  EXTRAIRE_LISTE,
  EXTRAIRE_DETAIL,
  numeroDeCommande,
  remoteIdCommande,
  analyserDetail,
  construireRecu,
  phrasePrecision,
  borneHistorique,
};
