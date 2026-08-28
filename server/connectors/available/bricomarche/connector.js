'use strict';

/**
 * Connecteur Bricomarché — ÉBAUCHE du lot 47 : la fiche existe, la session se
 * garde, la récupération n'est PAS écrite.
 *
 * ─── Ce que la reconnaissance du 22/08/2026 a mesuré — et le MUR ─────────────
 *
 *   - au `fetch` nu : 403 `cf-mitigated: challenge` (Cloudflare) sur TOUT
 *     `www.bricomarche.com`, témoin inventé compris ;
 *   - au vrai Chromium du socle : l'ACCUEIL passe (36 441 caractères rendus),
 *     mais `/connexion`, `/mon-compte`, `/mon-compte/commandes` et le témoin
 *     restent sur l'interstitiel « Un instant… / Vérification de sécurité en
 *     cours » — le défi Cloudflare ne s'est pas résolu pendant la sonde.
 *     L'espace client est DERRIÈRE LE MUR : aucune route prouvée, aucun
 *     formulaire vu, aucune redirection d'anonyme mesurée.
 *
 * L'ébauche existe QUAND MÊME, et c'est voulu : la fenêtre visible de crabe
 * sur profil persistant sait franchir ce genre de mur à la main (recette du
 * lot 30, PrestaShop Addons), et le jeton de passage vit ensuite dans le
 * profil. C'est précisément ce que la connexion manuelle dans la fenêtre visible établira.
 *
 * ─── Conséquences dans le code ───────────────────────────────────────────────
 *
 * Rester sur l'adresse ne prouve RIEN (rien n'a pu être mesuré) : la session
 * se juge à la preuve forte générique (`preuve-connexion`), et le mur, s'il
 * se représente, est dit comme tel (`estMurAntiRobot` reconnaît « Un
 * instant… » depuis ce lot). Jamais de « aucune nouvelle facture ».
 *
 * ─── Lot 53 (24/08/2026) : le parcours ne sera pas écrit en l'état ──────────
 *
 * MESURÉ (protocole de stabilité, détail dans le manifeste) : la liste n'est
 * servie à la lecture automatique que dans les secondes qui suivent une
 * connexion manuelle par la fenêtre « Se connecter » ; tout passage éloigné
 * d'une capture fraîche est renvoyé vers /login malgré la session enregistrée
 * (six lectures sur les 23-24/08, deux servies — chacune ~10 s après une
 * capture). Une récupération qui ne tient que dans cette foulée produirait
 * des trous silencieux : l'ébauche reste une ébauche, et le message du renvoi
 * (erreurRenvoiVersAuthentification) dit exactement ce qui se passe.
 */

const profilMarchand = require('../../profil-marchand');

const ID = 'bricomarche';
const NOM = 'Bricomarché';
// Mesuré le 23/08/2026 (sonde lot 48, visiteur anonyme) : /mon-compte,
// /mon-compte/commandes et /connexion rendent tous un 404 franc — les
// adresses du lot 47 n'existent pas. Le lien « Se connecter » du site
// lui-même pointe sur /my-account, qui REDIRIGE les anonymes vers /login.
// L'adresse de la LISTE des commandes reste inconnue : /my-account est
// l'espace client, la première session dira le reste.
const URL_COMMANDES = 'https://www.bricomarche.com/my-account';
/** Adresse CANDIDATE — jamais prouvée, le mur passait avant le routage. */
const CHEMIN_LISTE = /\/my-account/i;

/** `/connexion` est couvert par le motif générique. */
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
        // Rien n'a pu être mesuré derrière le mur Cloudflare : preuve forte
        // exigée, rester sur l'adresse ne prouve rien.
        // La redirection des anonymes est MESURÉE depuis le 23/08/2026 (sonde
        // lot 48) : /my-account renvoie les visiteurs vers /login. Attention,
        // le témoin /my-account/nawak-inexistant-42 est redirigé LUI AUSSI —
        // la garde passe avant le routage, l'existence de la route sur session
        // n'est pas prouvée une à une (leçon du lot 21, comme Decathlon).
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
      `Connexion valide — la page des commandes ${NOM} est servie à votre compte. `
      + 'La récupération des documents n\'est pas encore écrite dans crabe.',
  }));
}

/** N'atteint que la liste, la déclare, et s'arrête en le disant. */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLaListe(ctx, async (etat, vue) => {
    // La preuve exigée par le socle (lot 31) : ici c'est la preuve FORTE qui
    // atteste la session — rien n'a pu être mesuré derrière le mur Cloudflare
    // (22/08/2026), rester sur l'adresse ne prouve rien.
    ctx.preuveDeListe?.({
      session: `page des commandes servie au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    log(`${ID} : ${etat.reperes} repère(s) de commande compté(s) — motif générique, jamais `
      + 'vérifié sur un compte réel, le premier passage réel le dira.');
    if (vue.libelles.length) {
      log(`${ID} : libellés visibles sur la page — ${vue.libelles.join(' · ')}.`);
    }
    log(`${ID} : le parcours des documents n'est pas encore écrit — rien n'a été récupéré, `
      + 'et c\'est le comportement prévu de cette ébauche (lot 47).');

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
  URL_COMMANDES,
  CHEMIN_LISTE,
};
