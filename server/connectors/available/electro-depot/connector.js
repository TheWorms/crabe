'use strict';

/**
 * Connecteur Electro Dépôt — l'adresse de la liste est CORRIGÉE (lot 52) et le
 * compte vide se dit comme un fait, pas comme une panne. La récupération n'est
 * PAS écrite, et c'est un choix.
 *
 * ─── Ce que la reconnaissance du 22/08/2026 a mesuré (visiteur anonyme) ──────
 *
 * Boutique d'ossature Magento : `www.electrodepot.fr` répond 200 au fetch nu
 * (`server: fasterize`, CloudFront devant), aucun marqueur anti-robot.
 * `/customer/account` ET `/sales/order/history` rendent 302 vers
 * `/customer/account/login/` — elles EXISTENT et redirigent les anonymes ; le
 * témoin inventé rend un 404 franc. DEUX widgets de captcha sont MONTÉS sur la
 * page de connexion — une raison de plus de ne jamais soumettre ce formulaire
 * en programme.
 *
 * ─── Lot 52 (24/08/2026) : la liste vit ailleurs, et elle est VIDE ───────────
 *
 * `/sales/order/history` répond mais ne liste rien : l'espace client réel est
 * une application peinte côté client sur `/customer/account/#/order`
 * (« Mes commandes » / « Toutes mes commandes »). Mesuré sur une session
 * réelle : la page est servie au compte, et elle affiche « Vous n'avez pas de
 * commande en cours » — AUCUNE commande en ligne (les achats faits en magasin
 * ne remontent pas sur le site). Le comptage 0 est donc EXACT.
 *
 * ─── Pourquoi la récupération n'est pas écrite ───────────────────────────────
 *
 * Aucun passage réel ne pourrait la prouver : le compte n'a aucune commande en
 * ligne, donc aucune liste garnie, aucun lien de document, aucun format à
 * mesurer. Du code jamais exercé qui se présenterait comme fonctionnel serait
 * un piège pour plus tard (la règle du projet depuis le lot 20). Le jour où
 * une commande en ligne existera, le parcours s'écrira sur cette mesure-là.
 */

const profilMarchand = require('../../profil-marchand');

const ID = 'electro-depot';
const NOM = 'Electro Dépôt';
// L'espace client réel, mesuré le 24/08/2026 sur la session : une application
// peinte côté client, dont la liste des commandes vit sous le fragment
// #/order. L'ancienne cible /sales/order/history répond mais ne liste rien.
const URL_COMMANDES = 'https://www.electrodepot.fr/customer/account/#/order';
/**
 * `/customer/account` suivi de la fin, d'une query ou d'un fragment — JAMAIS
 * un simple préfixe : `/customer/account/login/` commence pareil, et le
 * prendre pour la liste ferait dire « connecté » à un écran de connexion.
 */
const CHEMIN_LISTE = /\/customer\/account\/?(?:[?#]|$)/i;

/** L'état vide, tel que la page l'écrit (relevé le 24/08/2026). */
const MOTIF_ETAT_VIDE = /n['’]avez pas de commande|aucune commande/i;
/** Le temps laissé à l'application pour peindre son espace client. */
const DELAI_PEINTURE_MS = 15_000;

/** `/customer/account/login/` est couvert par le motif générique (`/login`). */
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

/**
 * Attend que l'application ait peint son espace client : quelque chose y parle
 * de commandes — la liste, ses onglets, ou l'état vide. Compter avant, c'est
 * compter dans le vide.
 */
async function attendreLEspacePeint(page) {
  // Une boucle COMPTÉE, pas chronométrée : chaque tour attend une seconde de
  // page — et une page simulée par les tests n'a pas à faire le poireau.
  for (let tour = 0; tour < DELAI_PEINTURE_MS / 1_000; tour++) {
    const peint = await page.evaluate(
      ({ motifPeinture }) => new RegExp(motifPeinture, 'i')
        .test(document.body ? document.body.innerText : ''),
      { motifPeinture: 'commande' }
    ).catch(() => false);
    if (peint) return true;
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return false;
}

/** La page affiche-t-elle son état vide (« Vous n'avez pas de commande… ») ? */
async function etatVideAffiche(page) {
  return page.evaluate(
    ({ motifVide }) => new RegExp(motifVide, 'i')
      .test(document.body ? document.body.innerText : ''),
    { motifVide: MOTIF_ETAT_VIDE.source }
  ).catch(() => false);
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      await attendreLEspacePeint(page);
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        redirigeLesAnonymes: true,
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

/** La phrase servie à l'écran quand le compte n'a AUCUNE commande en ligne. */
function messageCompteSansCommande() {
  return (
    `Votre espace client ${NOM} a bien été ouvert : il n'affiche aucune commande en ligne — `
    + 'les achats faits en magasin ne remontent pas sur le site. Il n\'y a donc aucun '
    + 'document à récupérer : ce zéro est ce que la page montre, pas une erreur. Le jour où '
    + 'une commande en ligne existera, la lecture de ses documents devra être écrite dans '
    + 'crabe (elle ne l\'est pas encore, faute d\'avoir pu être essayée sur une commande réelle).'
  );
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, l'espace client répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat, vue, page) => {
    const vide = await etatVideAffiche(page);
    return {
      ok: true,
      accountId: null,
      invoiceCount: etat.reperes,
      message: vide
        ? `Connexion valide — votre espace client ${NOM} n'affiche aucune commande en ligne.`
        : `Connexion valide — la page des commandes ${NOM} est servie à votre compte. `
          + 'La récupération des documents n\'est pas encore écrite dans crabe.',
    };
  });
}

/** Atteint la liste, dit ce qu'elle montre — et un compte vide est un FAIT. */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLaListe(ctx, async (etat, vue, page) => {
    // La preuve exigée par le socle (lot 31) : la page des commandes a été
    // servie À CE COMPTE — l'adresse a tenu (302 vers la connexion mesuré hors
    // session le 22/08/2026), aucun bouton « Se connecter ».
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const vide = await etatVideAffiche(page);
    if (vide && !etat.reperes) {
      log(`${ID} : la page affiche son état vide (« Vous n'avez pas de commande ») — aucune `
        + 'commande en ligne sur ce compte, le comptage 0 est exact (mesuré le 24/08/2026 : '
        + 'les achats en magasin ne remontent pas sur le site).');
      return {
        accountId: null,
        invoices: [],
        aucunDocument: messageCompteSansCommande(),
      };
    }

    log(`${ID} : ${etat.reperes} repère(s) de commande compté(s) — motif générique, jamais `
      + 'vérifié sur un compte réel garni (aucune commande en ligne n\'existait au '
      + '24/08/2026) : le premier compte garni le dira.');
    if (vue.libelles.length) {
      log(`${ID} : libellés visibles sur la page — ${vue.libelles.join(' · ')}.`);
    }
    log(`${ID} : le parcours des documents n'est pas encore écrit — rien n'a été récupéré. `
      + 'Il s\'écrira le jour où une commande en ligne réelle permettra de le prouver.');

    return {
      accountId: null,
      invoices: [],
      aucunDocument: profilMarchand.messageParcoursNonEcrit(NOM, etat.reperes),
    };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  attendreLEspacePeint,
  etatVideAffiche,
  messageCompteSansCommande,
  URL_COMMANDES,
  CHEMIN_LISTE,
  MOTIF_ETAT_VIDE,
};
