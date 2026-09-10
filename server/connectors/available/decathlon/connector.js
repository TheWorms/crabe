'use strict';

/**
 * Connecteur Decathlon — la liste est TROUVÉE et comptée (lot 52) ; la mesure
 * a établi qu'aucun document n'est directement récupérable, et le connecteur
 * le dit.
 *
 * ─── La liste n'était pas là où on regardait (lot 52, 24/08/2026) ────────────
 *
 * Le lot 47 visait le tableau de bord (`/account/dashboard`) et comptait 0.
 * L'historique vit sur `/account/myPurchase` (« Historique de vos achats »),
 * mesuré sur une session réelle le 24/08/2026 :
 *
 *   - la page est PEINTE en JavaScript : on attend un marqueur avant de
 *     compter (une liste comptée dans le vide dirait 0 à tort) ;
 *   - un compteur de résultats vit dans un `role="status"` ;
 *   - chaque achat est un `article.my-purchase`, portant
 *     `aria-labelledby="wef-account-order-<référence>"` — la référence est
 *     dans l'attribut, le `<h3>` correspondant l'affiche sous « Numéro de
 *     commande » ; le statut est lisible dans un `aria-label` « Statut de la
 *     commande : … » ;
 *   - DEUX natures de commande, à leur lien de détail
 *     (`/account/orderTracking?…`) : `orderId=<référence>&type=oneom` (une
 *     commande en ligne) et `transactionId=<uuid>&type=store` (un achat en
 *     magasin) ;
 *   - AUCUN lien de facture sur la liste.
 *
 * ─── Ce que chaque nature PROPOSE (mesuré sur les détails, 24/08/2026) ───────
 *
 *   - `oneom` : un bouton « Demander ma facture ». Le clic DÉPOSE la demande
 *     immédiatement (boîte « Nous recevons votre facture », bouton « Fermer »
 *     seul) — et 25 minutes plus tard le bouton était inchangé : la facture
 *     n'apparaît pas sur la page, elle est préparée puis remise ailleurs.
 *     Un automate qui cliquerait ça à chaque passage déposerait des demandes
 *     en rafale sans jamais rien lire : crabe ne le déclenche PAS ;
 *   - `store` : un bouton « Télécharger ma facture » qui ouvre un formulaire
 *     « Informations client » (nom, prénom, adresse…) à VALIDER pour générer
 *     la facture depuis le ticket. crabe ne remplit jamais ces informations à
 *     la place de l'utilisateur : ce geste lui appartient.
 *
 * AUCUN document n'est donc directement récupérable aujourd'hui : le
 * connecteur compte l'historique, prouve la liste, et dit à l'écran ce que le
 * site propose — un fait mesuré, pas une panne. Le jour où Decathlon servira
 * un document sur la page, le parcours s'écrira sur cette mesure-là.
 */

const profilMarchand = require('../../profil-marchand');

const ID = 'decathlon';
const NOM = 'Decathlon';
// L'historique mesuré le 24/08/2026 sur une session réelle : « Historique de
// vos achats ». /account/dashboard (lot 48) était le tableau de bord — il ne
// liste rien ; /account/purchases (lot 47) rendait 404 sur session.
const URL_COMMANDES = 'https://www.decathlon.fr/account/myPurchase';
/** L'adresse de l'historique a tenu = la session est là (redirection mesurée). */
const CHEMIN_LISTE = /\/account\/myPurchase/i;

/** Chaque achat est un `article.my-purchase` (relevé le 24/08/2026). */
const SELECTEUR_REPERE = 'article.my-purchase';
/** Filet de texte : le libellé que le `<h3>` de chaque achat porte. */
const MOTIF_REPERE = /num[ée]ro de commande/i;
/** Le marqueur qui dit que la liste peinte en JavaScript est RENDUE. */
const SELECTEUR_LISTE_PEINTE = 'article.my-purchase, [role="status"]';
/** Le temps laissé à l'application pour peindre sa liste. */
const DELAI_PEINTURE_MS = 15_000;

/**
 * L'écran d'authentification est un HÔTE dédié, pas un chemin :
 * `login.decathlon.net` (mesuré le 22/08/2026 — toute route `/account/*`
 * anonyme y atterrit). Le motif de chemin par défaut reste en second filet.
 */
function estPageAuthentification(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)login\.decathlon\.net$/i.test(u.hostname)) return true;
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

/**
 * Attend que la liste peinte en JavaScript soit RENDUE — un achat monté, ou le
 * compteur de résultats (`role="status"`) qui sait dire « 0 ». Compter avant,
 * c'est compter dans le vide (piège relevé au lot 43, mesuré ici : la page
 * arrive coquille vide et se peint après).
 */
async function attendreLaListePeinte(page) {
  // Une boucle COMPTÉE, pas chronométrée : chaque tour attend une seconde de
  // page — et une page simulée par les tests n'a pas à faire le poireau.
  for (let tour = 0; tour < DELAI_PEINTURE_MS / 1_000; tour++) {
    const peinte = await page.evaluate(
      ({ selPeinture }) => !!document.querySelector(selPeinture),
      { selPeinture: SELECTEUR_LISTE_PEINTE }
    ).catch(() => false);
    if (peinte) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return false;
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const peinte = await attendreLaListePeinte(page);
      if (!peinte) {
        // Compter une coquille vide dirait « 0 achat » à tort — le faux
        // « rien à récupérer » que crabe s'interdit : on s'arrête EN LE DISANT.
        (ctx.log || (() => {}))(
          `${ID} : la liste ne s'est pas peinte en ${Math.round(DELAI_PEINTURE_MS / 1000)} s `
            + `sur ${page.url()} — impossible de compter quoi que ce soit.`
        );
        throw new Error(
          `${NOM} n'a pas affiché votre historique d'achats (la page est restée vide trop `
            + 'longtemps) : impossible de dire ce qu\'il contient. Réessayez dans '
            + 'quelques minutes, et signalez-le si cela se répète.'
        );
      }
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        redirigeLesAnonymes: true,
        // Les achats se comptent sur leur sélecteur RELEVÉ (24/08/2026), le
        // libellé « Numéro de commande » en filet.
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

/**
 * Ce que la liste MONTRE, compté par nature — jamais les références : sans
 * parcours de récupération, les lire ne servirait qu'à les faire circuler.
 */
async function compterParNature(page) {
  return page.evaluate(({ selArticle }) => {
    const articles = [...document.querySelectorAll(selArticle)];
    return {
      total: articles.length,
      enLigne: articles.filter((a) => a.querySelector('a[href*="type=oneom"]')).length,
      enMagasin: articles.filter((a) => a.querySelector('a[href*="type=store"]')).length,
    };
  }, { selArticle: SELECTEUR_REPERE }).catch(() => null);
}

/** La phrase servie à l'écran : ce que le site propose, mesuré — pas une panne. */
function messageAucunDocumentDirect(natures) {
  const compte = natures && natures.total
    ? `${natures.total} achat(s) — ${natures.enLigne} commande(s) en ligne, ${natures.enMagasin} en magasin — `
    : '';
  return (
    `Votre historique Decathlon a bien été lu (${compte}aucun document à descendre). `
    + 'Decathlon ne sert pas de facture directement sur ses pages : pour une commande en '
    + 'ligne, le site propose « Demander ma facture » (la demande part chez le vendeur, et '
    + 'crabe ne la déclenche pas à votre place) ; pour un achat en magasin, un formulaire '
    + 'd\'informations à remplir et valider (crabe ne remplit jamais ces informations pour '
    + 'vous). Faites ces démarches sur le site de Decathlon si vous avez besoin d\'une '
    + 'facture — mesuré le 24/08/2026.'
  );
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, l'historique des achats répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — ${etat.reperes} achat(s) visible(s) sur l'historique ${NOM}. `
      + 'Decathlon ne sert pas de facture directement sur ses pages (mesuré le 24/08/2026).',
  }));
}

/**
 * Atteint l'historique, le compte par nature, et dit ce que le site propose.
 *
 * Aucune récupération : c'est un FAIT mesuré le 24/08/2026 (voir l'en-tête),
 * pas un parcours manquant — et le journal le dit dans ces termes.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLaListe(ctx, async (etat, vue, page) => {
    // La preuve exigée par le socle (lot 31) : l'historique a été servi À CE
    // COMPTE — l'adresse a tenu (elle redirige les anonymes, mesuré le
    // 22/08/2026), aucun bouton « Se connecter ».
    ctx.preuveDeListe?.({
      session: `historique des achats servi au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const natures = await compterParNature(page);
    if (natures) {
      log(`${ID} : ${natures.total} achat(s) sur l'historique — ${natures.enLigne} commande(s) `
        + `en ligne, ${natures.enMagasin} achat(s) en magasin.`);
    } else {
      log(`${ID} : ${etat.reperes} achat(s) compté(s) sur l'historique.`);
    }
    log(`${ID} : aucun document n'est servi directement par le site (mesuré le 24/08/2026) — `
      + 'commande en ligne : « Demander ma facture » dépose une demande chez le vendeur, que '
      + 'crabe ne déclenche pas ; achat en magasin : un formulaire d\'informations à valider, '
      + 'que crabe ne remplit pas. Rien n\'a été récupéré, et c\'est le comportement prévu.');

    return {
      accountId: null,
      invoices: [],
      aucunDocument: messageAucunDocumentDirect(natures),
    };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  attendreLaListePeinte,
  compterParNature,
  messageAucunDocumentDirect,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MOTIF_REPERE,
  SELECTEUR_LISTE_PEINTE,
};
