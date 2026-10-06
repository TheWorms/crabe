'use strict';

/**
 * Lot 95 — le faux Gandi dit enfin la vérité sur ses PDF.
 *
 * ─── Ce qui a été mesuré ─────────────────────────────────────────────────────
 *
 * Le 06/10/2026 à 05:03 (Paris), le passage n° 708 de la production a lu les
 * trois organisations du compte observé et leurs 168 factures (42, 5 et 121), puis n'en
 * a pris AUCUNE : les trois premières ont rendu une page HTML d'environ 84 Ko
 * au lieu d'un PDF, et la sortie anticipée a arrêté le passage. L'utilisateur a mesuré
 * ensuite, dans son navigateur, par des sondes de console (formes seulement) :
 *
 *   - le lien « PDF » d'une facture, `/billing/<org>/invoices/<interne>/<numéro>/pdf`,
 *     sert une page de l'APPLICATION : 200, `text/html; charset=utf-8`,
 *     83 203 ou 83 883 octets selon le lien, sans redirection ;
 *   - ouverte dans un onglet, cette page demande elle-même le fichier à
 *     `/billing/api/v5/billing/invoices/<interne>/pdf?lang=fr&invoice_num=<numéro>&sharing_id=<org>`,
 *     sur le même hôte ;
 *   - cette adresse, redemandée par un simple `fetch` avec les cookies, sans
 *     en-tête ajouté, rend un vrai PDF (200, `application/pdf`,
 *     `Content-Disposition` présent, début `%PDF-`) ; ses trois paramètres
 *     sont égaux aux trois segments du lien.
 *
 * Le banc du lot 93 servait le PDF AU LIEN, d'après la même phrase fausse que
 * le code : aucun essai ne pouvait voir le défaut. `siteGandi` (lot 93) sert
 * désormais la page au lien et le PDF à l'API ; ce fichier y ajoute le compte
 * à la forme du 06/10 et ce que les essais du lot 95 vérifient de chaque
 * demande d'API.
 *
 * ─── Ce qui est inventé ──────────────────────────────────────────────────────
 *
 * Tout le contenu : identifiants faits de zéros, numéros en « ZZ… »,
 * organisations « Organisation d'essai … », montants à 0,00 €, la page de
 * l'application, le PDF. Ce que l'API rend hors des conditions mesurées (401
 * et 404 en JSON) est un CHOIX du banc, pas une mesure.
 *
 * ─── La mécanique ────────────────────────────────────────────────────────────
 *
 * Celle des lots 92 à 94 : `context.route('**\/*')`, hôtes non déclarés
 * avortés, aucune réponse 3xx, filets des fuites à chaque essai. En plus,
 * pour chaque demande d'API : son type (`fetch` attendu), la page d'où elle
 * part, la présence du cookie de session du banc, et la LISTE des en-têtes —
 * un en-tête ajouté par crabe s'y verrait.
 */

const faux94 = require('./lot94-faux-sites');

const { facturesInventees, idOrganisation } = faux94;

/**
 * Les en-têtes qu'un `fetch` sans option porte dans ce Chromium (mesuré au
 * banc le 06/10/2026, par une sonde jetable qui ne sortait pas du banc) :
 * tout autre en-tête serait un ajout.
 */
const ENTETES_D_UN_FETCH_SIMPLE = Object.freeze([
  'accept', 'accept-language', 'cookie', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'user-agent',
]);

/** Le cookie de la session de facturation du banc (valeur inventée). */
const COOKIE_SESSION = /(?:^|;\s*)session=session-du-banc(?:;|$)/;

/**
 * Le compte à la forme du 06/10 : trois organisations, 42, 5 et 121
 * factures, dix par page (5, 1 et 13 pages), la session de facturation à
 * rouvrir par la chaîne mesurée. Factures hebdomadaires depuis le 01/10/2026,
 * pour qu'aucune ne sorte d'une fenêtre d'historique (168 semaines < 4 ans).
 */
function compteDuSixOctobre(extra = {}) {
  const hebdo = (lettre, combien) => facturesInventees(lettre, combien).map((f, i) => {
    const d = new Date(Date.UTC(2026, 9, 1) - i * 7 * 86_400_000);
    return { ...f, jour: d.getUTCDate(), mois: d.getUTCMonth(), annee: d.getUTCFullYear() };
  });
  return {
    connecte: true,
    parPage: 10,
    sessionFacturation: false,
    organisations: [
      { id: idOrganisation(1), nom: 'Organisation d\'essai A', moi: true, factures: hebdo('A', 42) },
      { id: idOrganisation(2), nom: 'Organisation d\'essai B', factures: hebdo('B', 5) },
      { id: idOrganisation(3), nom: 'Organisation d\'essai C', factures: hebdo('C', 121) },
    ],
    ...extra,
  };
}

/**
 * Des liens « PDF » ALTÉRÉS dans les pages de factures (essais D2).
 * `etat.liensAlteres` associe un numéro à une altération :
 *
 *   - `manquant` : le segment interne ôté ;
 *   - `en-trop` : un segment de plus avant `/pdf` ;
 *   - `autre-hote` : le même chemin sur un hôte qui n'est pas déclaré au banc
 *     (une demande y serait avortée, et comptée) ;
 *   - `autre-organisation` : le lien d'une AUTRE organisation, dans la page de
 *     celle-ci ;
 *   - `surprenant` : un « + » à la fin du numéro — un lien bien formé dont un
 *     segment sort de l'alphabet attendu.
 */
function altererLiens(html, etat) {
  let rendu = html;
  for (const [numero, alteration] of Object.entries(etat.liensAlteres || {})) {
    for (const org of etat.organisations) {
      const f = org.factures.find((x) => x.numero === numero);
      if (!f) continue;
      const chemin = `/billing/${org.id}/invoices/${f.interne}/${f.numero}/pdf`;
      const autre = etat.organisations.find((o) => o.id !== org.id);
      const remplacant = {
        manquant: `/billing/${org.id}/invoices/${f.numero}/pdf`,
        'en-trop': `/billing/${org.id}/invoices/${f.interne}/${f.numero}/copie/pdf`,
        'autre-hote': `https://autre-hote.invalid${chemin}`,
        'autre-organisation': `/billing/${autre.id}/invoices/${f.interne}/${f.numero}/pdf`,
        surprenant: `/billing/${org.id}/invoices/${f.interne}/${f.numero}+1/pdf`,
      }[alteration];
      if (!remplacant) throw new Error(`altération inconnue : ${alteration}`);
      rendu = rendu.replace(`href="https://admin.gandi.net${chemin}"`, `href="${remplacant}"`)
        .replace(`href="${chemin}"`, `href="${remplacant}"`);
    }
  }
  return rendu;
}

/**
 * Le faux Gandi du lot 94 (chaîne mesurée, liste à `/organizations`), dont
 * l'API sert le PDF comme le vrai site (lot 93 modifié au lot 95), et qui
 * consigne chaque demande d'API dans `etat.compteurs.demandesApi` :
 * `{ type, page, cookieSession, entetes, adresse }`.
 *
 * Une fois la session de facturation ouverte par la chaîne (le cookie posé),
 * une demande d'API qui ne porte PAS ce cookie reçoit un 401 : seule la
 * session du banc obtient un PDF. `etat.liensAlteres` : voir `altererLiens`.
 */
function siteGandiVrai(etat) {
  const interieur = faux94.siteGandiMesure(etat);
  return async (url, requete) => {
    if (url.host === faux94.GANDI_ADMIN && url.pathname === '/billing/api/v5/login' && url.searchParams.get('code')) {
      etat.cookieSessionPose = true;
    }
    if (url.host === faux94.GANDI_ADMIN && url.pathname.startsWith('/billing/api/v5/billing/')) {
      etat.compteurs = etat.compteurs || {};
      const demandes = etat.compteurs.demandesApi || (etat.compteurs.demandesApi = []);
      const entetes = await requete.allHeaders().catch(() => ({}));
      let page = '';
      try { page = requete.frame().url(); } catch { page = '(sans page)'; }
      const demande = {
        type: requete.resourceType(),
        page,
        cookieSession: COOKIE_SESSION.test(entetes.cookie || ''),
        entetes: Object.keys(entetes).sort(),
        adresse: url.href,
      };
      demandes.push(demande);
      if (etat.cookieSessionPose && !demande.cookieSession) {
        etat.compteurs.api = (etat.compteurs.api || 0) + 1;
        return faux94.apiNonPdf('401');
      }
    }
    const r = await interieur(url, requete);
    if (etat.liensAlteres && url.host === faux94.GANDI_ADMIN && /^\/billing\/[^/]+\/invoices\/?$/.test(url.pathname)
      && typeof r.html === 'string') {
      return { ...r, html: altererLiens(r.html, etat) };
    }
    return r;
  };
}

/** L'adresse d'API d'une facture du banc, telle que la page de l'application la compose. */
function adresseApiDe(org, f) {
  return `https://admin.gandi.net/billing/api/v5/billing/invoices/${f.interne}/pdf?lang=fr&invoice_num=${f.numero}&sharing_id=${org.id}`;
}

module.exports = {
  ...faux94,
  ENTETES_D_UN_FETCH_SIMPLE,
  COOKIE_SESSION,
  compteDuSixOctobre,
  siteGandiVrai,
  altererLiens,
  adresseApiDe,
};
