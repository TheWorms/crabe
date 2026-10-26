'use strict';

/**
 * Connecteur Decathlon — l'historique des achats, puis la facture de chaque
 * achat par « Télécharger ma facture », et par ce bouton SEUL (lot 92).
 *
 * ─── La liste (lot 52, mesuré sur une session réelle le 24/08/2026) ────────────
 *
 * L'historique vit sur `/account/myPurchase` (« Historique de vos achats ») :
 *
 *   - la page est PEINTE en JavaScript : on attend un marqueur avant de
 *     compter (une liste comptée dans le vide dirait 0 à tort) ;
 *   - un compteur de résultats vit dans un `role="status"` ;
 *   - chaque achat est un `article.my-purchase`, portant
 *     `aria-labelledby="wef-account-order-<référence>"` ; le `<h3>`
 *     correspondant affiche « Numéro de commande » et le numéro ;
 *   - DEUX natures, à leur lien de détail (`/account/orderTracking?…`) :
 *     `orderId=<référence>&type=oneom` (en ligne) et
 *     `transactionId=<uuid>&type=store` (en magasin) ;
 *   - AUCUN lien de facture sur la liste.
 *
 * ─── Le détail, et ce qui a changé depuis le lot 52 ──────────────────────────
 *
 * Mesuré le 24/08/2026 : la commande en ligne (un vendeur partenaire) portait
 * « Demander ma facture », dont le clic DÉPOSE une demande — la sonde de
 * mesure l'a cliqué une fois, et la demande est partie sur le compte réel.
 * L'achat en magasin portait déjà « Télécharger ma facture », qui ouvrait
 * alors un formulaire « Informations client » à valider.
 *
 * Vu par l'utilisateur, connecté, le 05/10/2026 : les deux achats portent « Télécharger
 * ma facture », qui donne le PDF tout de suite — à condition que l'adresse de
 * facturation et de livraison soit renseignée sur le compte Decathlon. Le
 * détail montre « Commandé le » et la date, « Commande n° » et le numéro, un
 * bloc « Achat en magasin » pour un achat en magasin, puis un bloc « Colis 1 »
 * avec « Télécharger ma facture » et « Faire un retour » côte à côte.
 *
 * NON MESURÉ, et le code ne le suppose pas : comment le PDF arrive
 * (téléchargement, onglet, réponse — `clic-document` guette les trois), ce
 * que montre la page quand l'adresse manque (le code traite l'absence, le
 * bouton grisé, l'autre libellé et le formulaire), et si un achat peut avoir
 * plusieurs colis donc plusieurs boutons (le code les sépare).
 *
 * ─── Le clic unique, et comment il est enfermé ───────────────────────────────
 *
 * Un bouton qui télécharge et un bouton qui envoie ne se distinguent sur la
 * page que par leur libellé. D'où trois verrous :
 *
 *   1. UNE seule fonction de ce fichier clique : `LIRE_OU_DECLENCHER`, quand
 *      elle reçoit un rang. Elle ne reçoit pas de libellé à chercher : elle
 *      compare le texte de chaque élément à `LIBELLE_TELECHARGER` (casse et
 *      espaces normalisés, rien de plus), au moment même du clic, et rend le
 *      texte qu'elle a cliqué, que `declencherTelechargement` recontrôle ;
 *   2. ce fichier ne porte AUCUN autre geste sur la page — ni `click` ailleurs,
 *      ni saisie, ni touche : un test le vérifie en le lisant ;
 *   3. après le clic, tout ce qui n'est pas un PDF — un formulaire, une boîte,
 *      une confirmation, une page d'erreur — arrête les clics pour tout le
 *      passage : rien n'est rempli, la boîte n'est pas fermée en cliquant, la
 *      page est abandonnée, et le journal comme l'écran le disent.
 *
 * Ouvrir le détail d'un achat est une NAVIGATION vers l'adresse que porte son
 * lien « Voir les détails », jamais un clic.
 *
 * ─── L'ancre ─────────────────────────────────────────────────────────────────
 *
 * `decathlon-<numéro de commande>`, le numéro LU sur la page — jamais une
 * empreinte du PDF, jamais l'`orderId` ni le `transactionId` d'une adresse.
 * Un deuxième colis, s'il existe, prend `-colis-<n>` : deux factures, deux
 * noms. Un achat dont la facture est déjà archivée n'est même pas rouvert.
 */

const crypto = require('node:crypto');

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');
const identity = require('../../browser-identity');
const history = require('../../history');
const { normalizeFrenchDate } = require('../../scraping');

const ID = 'decathlon';
const NOM = 'Decathlon';
const CHAMP_HISTORIQUE = 'historique';
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
/** Le temps laissé à l'application pour peindre sa liste, ou un détail. */
const DELAI_PEINTURE_MS = 15_000;

/**
 * Le SEUL libellé que ce connecteur clique (lot 92). Comparé casse et espaces
 * normalisés, rien de plus : « Demander ma facture », « Télécharger ma facture
 * rectificative » ou « Faire un retour » ne passent pas.
 */
const LIBELLE_TELECHARGER = 'Télécharger ma facture';
/** Ce qui évoque une facture sans être le bon bouton : relevé, jamais cliqué. */
const MOTIF_FACTURE_VOISINE = /factur/i;
/** Un « voir plus » de l'historique : relevé, jamais cliqué. */
const MOTIF_SUITE_HISTORIQUE = /^(voir|afficher|charger) (plus|la suite)|^plus d'achats|^page suivante/i;

/**
 * Où l'adresse se renseigne chez Decathlon : le menu de l'espace client porte
 * « Carnet d'adresses » (capture du compte observé, 05/10/2026).
 */
const RAPPEL_ADRESSE = 'Decathlon ne remet une facture que si votre adresse de facturation et votre '
  + 'adresse de livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet '
  + 'd\'adresses », sur decathlon.fr.';

/** Le texte d'un bouton tel qu'on le compare : casse et espaces normalisés. */
function normaliserLibelle(texte) {
  return String(texte ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
}

/** Un libellé prêt pour le journal : chiffres masqués, longueur bornée. */
function libellePourJournal(texte) {
  return String(texte ?? '').replace(/\s+/g, ' ').trim().replace(/\d/g, '#').slice(0, 60);
}

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

// ---------------------------------------------------------------------------
// La liste : un achat = un numéro, une nature, une date, une adresse de détail
// ---------------------------------------------------------------------------

/**
 * Ce que chaque carte de l'historique montre. Le texte de la carte ne sort de
 * la page que pour y lire la date ; il n'est jamais journalisé.
 */
const LIRE_LA_LISTE = ({ selArticle, motifSuite }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const reSuite = new RegExp(motifSuite, 'i');
  const achats = [...document.querySelectorAll(selArticle)].map((article) => {
    const texte = norm(article.innerText);
    const lu = /num[ée]ro de commande\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(texte);
    const attribut = /^wef-account-order-(.+)$/.exec(article.getAttribute('aria-labelledby') || '');
    const lien = article.querySelector('a[href*="orderTracking"]') || article.querySelector('a[href*="type="]');
    return {
      numero: lu ? lu[1] : (attribut ? attribut[1] : ''),
      adresse: lien ? lien.href : '',
      texte: texte.slice(0, 400),
    };
  });
  const suite = [...document.querySelectorAll('a, button, [role="button"]')]
    .some((el) => (el.offsetWidth || el.offsetHeight) && reSuite.test(norm(el.innerText)));
  return { achats, suite };
};

/** Un numéro de commande tel qu'il entre dans une ancre : lettres, chiffres, tirets. */
function nettoyerNumero(numero) {
  const propre = String(numero ?? '').replace(/[^A-Za-z0-9-]+/g, '');
  return /\d/.test(propre) && propre.length <= 40 ? propre : '';
}

/** La date lue dans un texte, le numéro de commande retiré d'abord. */
function dateLue(texte, numero) {
  const sansNumero = numero ? String(texte ?? '').split(numero).join(' ') : String(texte ?? '');
  return documentsDePage.dateDepuisTexte(sansNumero) || normalizeFrenchDate(sansNumero);
}

/**
 * Une carte brute ramenée à ce qui sert : numéro, nature, date, adresse.
 * Pure, testée.
 */
function analyserAchat(brut) {
  const numero = nettoyerNumero(brut?.numero);
  const adresse = String(brut?.adresse || '');
  let nature = null;
  try {
    const type = new URL(adresse).searchParams.get('type');
    nature = type === 'store' ? 'en magasin' : type === 'oneom' ? 'en ligne' : null;
  } catch { /* pas d'adresse lisible */ }
  return { numero, nature, adresse, issuedOn: dateLue(brut?.texte, numero) };
}

/** L'ancre d'une facture : la commande, et son colis au-delà du premier. */
function ancreFacture(numero, colis = 1) {
  const base = `${ID}-${nettoyerNumero(numero)}`;
  return Number(colis) > 1 ? `${base}-colis-${Number(colis)}` : base;
}

// ---------------------------------------------------------------------------
// Le détail : LIRE, et le seul geste permis
// ---------------------------------------------------------------------------

/**
 * Lit le détail d'un achat, ou — quand `rang` est donné — déclenche le
 * `rang`-ième bouton « Télécharger ma facture » de la page. C'est le SEUL
 * clic du connecteur (voir l'en-tête).
 *
 * Lecture et geste partagent la même énumération : le rang lu est le rang
 * cliqué. Seuls les boutons VISIBLES comptent — une page peut porter le même
 * bouton en double, caché pour l'autre format d'écran (leçon impots, lot 86) —
 * et un bouton qui en contient un autre au même libellé n'est pas compté :
 * seul le plus profond l'est. Les libellés voisins (« Demander ma facture »…)
 * se relèvent hors des menus, en-têtes et pieds de page : un lien « Mes
 * factures » du menu ne dit rien de l'achat affiché.
 */
const LIRE_OU_DECLENCHER = ({ libelle, motifVoisin, rang }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
  const brut = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const attendu = norm(libelle);
  const reVoisin = new RegExp(motifVoisin, 'i');
  const candidats = [...document.querySelectorAll('a, button, [role="button"]')];
  const exacts = candidats
    .filter((el) => visible(el) && norm(el.innerText) === attendu)
    .filter((el, _i, tous) => !tous.some((autre) => autre !== el && el.contains(autre)));
  const horsCadre = (el) => !!el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]');

  if (rang) {
    const cible = exacts[rang - 1];
    if (!cible) return { clique: false, raison: 'le bouton n\'est plus dans la page' };
    if (cible.disabled || cible.getAttribute('aria-disabled') === 'true') {
      return { clique: false, raison: 'le bouton est grisé' };
    }
    // Le libellé est recontrôlé AU MOMENT du clic, pas seulement à la lecture.
    if (norm(cible.innerText) !== attendu) return { clique: false, raison: 'le libellé a changé' };
    try { cible.scrollIntoView({ block: 'center' }); } catch { /* */ }
    cible.click();
    return { clique: true, libelle: brut(cible.innerText) };
  }

  const texte = brut(document.body ? document.body.innerText : '');
  const numero = /commande\s*n[°o]\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(texte);
  const date = /command[ée]e?\s+le\s+([^\n]{0,40})/i.exec(document.body ? document.body.innerText : '');
  const colisDe = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const titre = [...e.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, strong, p, span')]
        .map((t) => /^colis\s*(\d+)$/i.exec(brut(t.innerText)))
        .find(Boolean);
      if (titre) return Number(titre[1]);
    }
    return null;
  };
  return {
    numero: numero ? numero[1] : '',
    dateTexte: date ? brut(date[1]) : '',
    boutons: exacts.map((el, i) => ({
      rang: i + 1,
      colis: colisDe(el),
      grise: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    })),
    voisins: candidats
      .filter((el) => visible(el) && !horsCadre(el) && norm(el.innerText) !== attendu
        && reVoisin.test(el.innerText || ''))
      .map((el) => brut(el.innerText).slice(0, 80)),
    peint: !!numero || exacts.length > 0,
  };
};

/** Les tours laissés aux boutons d'un détail déjà peint, avant de conclure. */
const TOURS_BOUTONS = 3;

/**
 * Ce que le détail montre, une fois peint — ou `null` s'il ne se peint pas.
 * Un détail peint SANS bouton est relu encore quelques secondes : conclure
 * « aucune facture proposée » sur un bloc pas encore monté serait le faux
 * « rien à récupérer » que crabe s'interdit.
 */
async function lireLeDetail(page) {
  const lire = () => page.evaluate(LIRE_OU_DECLENCHER, {
    libelle: LIBELLE_TELECHARGER,
    motifVoisin: MOTIF_FACTURE_VOISINE.source,
    rang: 0,
  }).catch(() => null);
  for (let tour = 0; tour < DELAI_PEINTURE_MS / 1_000; tour++) {
    let vue = await lire();
    if (vue && vue.peint) {
      for (let encore = 0; encore < TOURS_BOUTONS && !vue.boutons.length && !vue.voisins.length; encore++) {
        await page.waitForTimeout(1_000).catch(() => {});
        vue = (await lire()) || vue;
      }
      return vue;
    }
    await page.waitForTimeout(1_000).catch(() => {});
  }
  return null;
}

/**
 * Déclenche le `rang`-ième « Télécharger ma facture » — et rien d'autre. Le
 * libellé n'est pas un paramètre : c'est la constante du fichier, et le texte
 * réellement cliqué est recontrôlé ici.
 */
async function declencherTelechargement(page, rang) {
  const r = await page.evaluate(LIRE_OU_DECLENCHER, {
    libelle: LIBELLE_TELECHARGER,
    motifVoisin: MOTIF_FACTURE_VOISINE.source,
    rang,
  }).catch(() => ({ clique: false }));
  if (r?.clique && normaliserLibelle(r.libelle) !== normaliserLibelle(LIBELLE_TELECHARGER)) {
    // Impossible par construction ; s'il arrivait quand même, le passage
    // s'arrête net plutôt que de continuer après un clic imprévu.
    throw new Error(`${ID} : un élément d'un autre libellé a été déclenché — passage arrêté.`);
  }
  return !!r?.clique;
}

/**
 * Ce qui, APRÈS le clic, n'est pas un document : une boîte ou un formulaire
 * de plus qu'avant. Compté, jamais touché.
 */
const COMPTER_BOITES = () => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const boites = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .filter(visible).length;
  const formulaires = [...document.querySelectorAll('form')]
    .filter((f) => visible(f) && f.querySelector('input:not([type="hidden"]), textarea, select')).length;
  return boites + formulaires;
};

/**
 * Le clic, et ce qu'il rend. Une boîte native du navigateur (« confirmer ? »)
 * est REFUSÉE, jamais acceptée ; une boîte ou un formulaire de la page met fin
 * à l'attente sans être touché.
 */
async function telecharger(page, context, rang) {
  let boiteNative = false;
  const surBoite = (boite) => {
    boiteNative = true;
    boite.dismiss().catch(() => {});
  };
  page.on?.('dialog', surBoite);
  try {
    const avant = await page.evaluate(COMPTER_BOITES).catch(() => 0);
    const obtenu = await clicDocument.documentDuClic(
      page,
      context,
      () => declencherTelechargement(page, rang),
      {
        autreIssue: async () => boiteNative
          || (await page.evaluate(COMPTER_BOITES).catch(() => avant)) > avant,
      }
    );
    if (obtenu.ok && !identity.estPdf(obtenu.buffer)) {
      return { ok: false, grief: 'le document reçu ne commence pas comme un PDF', formulaire: false };
    }
    if (obtenu.ok) return obtenu;
    return {
      ...obtenu,
      formulaire: !!obtenu.autreIssue,
      grief: boiteNative
        ? 'une boîte de confirmation du navigateur s\'est ouverte — refusée'
        : obtenu.grief,
    };
  } finally {
    try { page.off?.('dialog', surBoite); } catch { /* page partie */ }
  }
}

/** La page où un clic n'a pas rendu de PDF est abandonnée — rien n'y est touché. */
async function abandonnerLaPage(page) {
  await page.close?.({ runBeforeUnload: false }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Le bilan, et ce que l'utilisateur lit
// ---------------------------------------------------------------------------

/** Les issues d'un achat, dans l'ordre où le bilan les dit. */
const ISSUES = [
  ['recuperee', 'facture récupérée', 'factures récupérées'],
  ['archivee', 'déjà dans l\'archive', 'déjà dans l\'archive'],
  ['nonProposee', 'sans facture proposée', 'sans facture proposée'],
  ['autreLibelle', 'avec un autre bouton, non cliqué', 'avec un autre bouton, non cliqué'],
  ['sansPdf', 'clic sans PDF', 'clics sans PDF'],
  ['nonExaminee', 'non examiné (clics arrêtés)', 'non examinés (clics arrêtés)'],
  ['horsPeriode', 'hors de la période demandée', 'hors de la période demandée'],
  ['illisible', 'détail illisible', 'détails illisibles'],
];

function nouveauBilan() {
  return Object.fromEntries(ISSUES.map(([cle]) => [cle, 0]));
}

/** « 2 achat(s) : 1 facture récupérée, 1 sans facture proposée. » Pure. */
function phraseBilan(total, bilan) {
  const morceaux = ISSUES
    .filter(([cle]) => bilan[cle] > 0)
    .map(([cle, un, plusieurs]) => `${bilan[cle]} ${bilan[cle] > 1 ? plusieurs : un}`);
  return `${total} achat(s)${morceaux.length ? ` : ${morceaux.join(', ')}` : ''}.`;
}

/**
 * Ce que l'écran dit des achats qui n'ont pas donné de facture — une phrase
 * par cas, ajoutée au message (champ `precision`, lot 70). Pure, testée.
 */
function phrasePrecision(bilan, { voisins = [], suite = false, interruption = null } = {}) {
  const morceaux = [];
  if (interruption) {
    morceaux.push(`La lecture s'est interrompue — ${interruption} : les factures déjà prises sont `
      + `gardées, ${bilan.nonExaminee} achat(s) seront examinés au prochain passage.`);
  }
  // Le message de l'écran se compose « tête » puis précision : le tiret les
  // sépare, comme pour les autres connecteurs qui en déclarent une.
  if (bilan.nonProposee > 0) {
    morceaux.push(`${bilan.nonProposee} achat(s) ne propose(nt) pas encore « ${LIBELLE_TELECHARGER} ». `
      + RAPPEL_ADRESSE);
  }
  if (bilan.autreLibelle > 0) {
    const noms = [...new Set(voisins)].slice(0, 3).map((v) => `« ${v} »`).join(', ');
    morceaux.push(`${bilan.autreLibelle} achat(s) propose(nt) ${noms || 'un autre bouton'} au lieu de `
      + `« ${LIBELLE_TELECHARGER} » : crabe ne clique jamais un bouton qui envoie une demande. `
      + 'Faites-la vous-même sur decathlon.fr si vous avez besoin de cette facture : crabe la '
      + 'récupérera quand elle sera proposée au téléchargement.');
  }
  if (bilan.illisible > 0) {
    morceaux.push(`${bilan.illisible} achat(s) n'ont pas pu être lus : le prochain passage réessaiera.`);
  }
  if (suite) {
    morceaux.push('Votre historique Decathlon semble continuer au-delà des achats affichés : crabe ne '
      + 'lit que ceux que la page montre.');
  }
  return morceaux.length ? `— ${morceaux.join(' ')}` : undefined;
}

/** La phrase qui dit pourquoi les clics se sont arrêtés (champ `renoncement`). */
function phraseArret(arret, nonExaminees) {
  const quoi = arret.formulaire
    ? `Après un clic sur « ${LIBELLE_TELECHARGER} », Decathlon a affiché un formulaire au lieu de la `
      + 'facture : crabe n\'y a rien rempli, n\'a plus rien cliqué et s\'est arrêté là. C\'est ce que '
      + `le site montre quand l'adresse manque. ${RAPPEL_ADRESSE} Puis relancez la récupération.`
    : `Après un clic sur « ${LIBELLE_TELECHARGER} », Decathlon n'a pas remis de PDF : crabe n'a plus `
      + 'rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le.';
  return quoi + (nonExaminees > 0
    ? ` ${nonExaminees} autre(s) achat(s) seront examinés au prochain passage.`
    : '');
}

/** La borne basse de la fenêtre, d'après le réglage d'historique du compte. */
function borneHistorique(config, ctx) {
  return history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    plafondMois: ctx?.conservationMois || 0,
  });
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
      + `Les factures se récupèrent achat par achat, par « ${LIBELLE_TELECHARGER} ».`,
  }));
}

/**
 * Lit l'historique, ouvre le détail de chaque achat nouveau et y prend la
 * facture par « Télécharger ma facture » — le seul clic permis.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const fenetre = borneHistorique(config, ctx);

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) : l'historique a été servi À CE
    // COMPTE — l'adresse a tenu (elle redirige les anonymes, mesuré le
    // 22/08/2026), aucun bouton « Se connecter ».
    ctx.preuveDeListe?.({
      session: `historique des achats servi au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const liste = await page.evaluate(LIRE_LA_LISTE, {
      selArticle: SELECTEUR_REPERE,
      motifSuite: MOTIF_SUITE_HISTORIQUE.source,
    }).catch(() => ({ achats: [], suite: false }));
    const achats = liste.achats.map(analyserAchat);
    const enLigne = achats.filter((a) => a.nature === 'en ligne').length;
    const enMagasin = achats.filter((a) => a.nature === 'en magasin').length;
    log(`${ID} : ${achats.length} achat(s) sur l'historique — ${enLigne} commande(s) en ligne, `
      + `${enMagasin} achat(s) en magasin.`);
    log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);
    if (liste.suite) {
      log(`${ID} : la page propose de voir d'autres achats — crabe ne clique pas ce bouton, `
        + 'seuls les achats affichés sont lus.');
    }

    const borne = fenetre.from ? fenetre.from.toISOString().slice(0, 10) : null;
    const bilan = nouveauBilan();
    const invoices = [];
    const voisins = [];
    let arret = null;
    let pageAbandonnee = false;
    let interruption = null;

    for (const [i, achat] of achats.entries()) {
      const qui = `achat ${i + 1}/${achats.length}${achat.nature ? ` (${achat.nature})` : ''}`;
      if (achat.numero && connus.has(ancreFacture(achat.numero))) { bilan.archivee += 1; continue; }
      if (borne && achat.issuedOn && achat.issuedOn < borne) { bilan.horsPeriode += 1; continue; }
      if (arret || pageAbandonnee) { bilan.nonExaminee += 1; continue; }
      if (!achat.adresse) {
        bilan.illisible += 1;
        log(`${ID} : ${qui} — aucune adresse de détail sur la carte, rien n'est tenté.`);
        continue;
      }

      // Ouvrir le détail est une NAVIGATION — jamais un clic.
      await page.goto(achat.adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (estPageAuthentification(page.url()) || (await profilMarchand.estMurAntiRobot(page))) {
        const raison = estPageAuthentification(page.url())
          ? `renvoyé vers ${page.url()} en ouvrant un détail`
          : 'le mur anti-robot est apparu en ouvrant un détail';
        log(`${ID} : ${qui} — ${raison}.`);
        // Rien d'obtenu : c'est un renvoi, et la règle du lot 91 le classe.
        // Des factures déjà prises : on les garde, et on s'arrête en le disant.
        if (!invoices.length) {
          if (estPageAuthentification(page.url())) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, raison);
          throw new Error(profilMarchand.messageMur(NOM));
        }
        pageAbandonnee = true;
        interruption = estPageAuthentification(page.url())
          ? 'Decathlon a renvoyé vers sa page de connexion'
          : 'Decathlon a présenté sa vérification de sécurité';
        bilan.nonExaminee += 1;
        continue;
      }

      const detail = await lireLeDetail(page);
      const numero = nettoyerNumero(detail?.numero) || achat.numero;
      if (!detail || !numero) {
        bilan.illisible += 1;
        log(`${ID} : ${qui} — le détail ne s'est pas peint ou ne montre pas de numéro de commande.`);
        continue;
      }
      if (detail.numero && achat.numero && nettoyerNumero(detail.numero) !== achat.numero) {
        log(`${ID} : ${qui} — le numéro du détail diffère de celui de la carte ; c'est celui du détail qui ancre.`);
      }
      const issuedOn = achat.issuedOn || dateLue(detail.dateTexte, numero);
      if (borne && issuedOn && issuedOn < borne) { bilan.horsPeriode += 1; continue; }

      const actifs = detail.boutons.filter((b) => !b.grise);
      if (!actifs.length) {
        if (detail.boutons.length) {
          bilan.nonProposee += 1;
          log(`${ID} : ${qui} — « ${LIBELLE_TELECHARGER} » est affiché mais grisé : pas de clic.`);
        } else if (detail.voisins.length) {
          bilan.autreLibelle += 1;
          voisins.push(...detail.voisins.map(libellePourJournal));
          log(`${ID} : ${qui} — pas de « ${LIBELLE_TELECHARGER} », mais `
            + `${detail.voisins.map((v) => `« ${libellePourJournal(v)} »`).join(', ')} : non cliqué.`);
        } else {
          bilan.nonProposee += 1;
          log(`${ID} : ${qui} — aucune facture proposée sur le détail.`);
        }
        continue;
      }

      // Le colis nomme la facture quand chaque bouton a le sien ; sinon le rang
      // — deux boutons ne doivent jamais partager une ancre, le second serait
      // pris pour « déjà récupéré » et perdu sans un mot.
      const colisDistincts = actifs.every((b) => b.colis)
        && new Set(actifs.map((b) => b.colis)).size === actifs.length;
      let prises = 0;
      const empreintes = [];
      for (const bouton of actifs) {
        const colis = colisDistincts ? bouton.colis : bouton.rang;
        const remoteId = ancreFacture(numero, colis);
        if (connus.has(remoteId)) continue;
        const obtenu = await telecharger(page, context, bouton.rang);
        if (!obtenu.ok) {
          arret = obtenu;
          log(`${ID} : ${qui} — « ${LIBELLE_TELECHARGER} » cliqué, pas de PDF (${obtenu.grief}). `
            + 'Plus aucun clic pendant ce passage.');
          // La boîte ou le formulaire restent tels quels : la page est
          // abandonnée, rien n'y est rempli ni refermé en cliquant.
          await abandonnerLaPage(page);
          pageAbandonnee = true;
          break;
        }
        const empreinte = crypto.createHash('sha256').update(obtenu.buffer).digest('hex');
        if (empreintes.includes(empreinte)) {
          log(`${ID} : ${qui} — le colis ${colis} rend le même document qu'un colis précédent : gardé une fois.`);
          continue;
        }
        empreintes.push(empreinte);
        connus.add(remoteId);
        prises += 1;
        invoices.push({
          remoteId,
          filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
          issuedOn,
          buffer: obtenu.buffer,
        });
        log(`${ID} : ${qui} — facture récupérée (voie mesurée : ${obtenu.voie}, `
          + `${obtenu.buffer.length} octets${actifs.length > 1 ? `, colis ${colis}` : ''}).`);
      }
      if (arret) bilan.sansPdf += 1;
      else if (prises > 0) bilan.recuperee += 1;
      else bilan.archivee += 1;
    }

    log(`${ID} : bilan — ${phraseBilan(achats.length, bilan)}`);

    const precision = phrasePrecision(bilan, { voisins, suite: liste.suite, interruption });
    const rienAPrendre = !invoices.length && !arret && !bilan.archivee && !bilan.autreLibelle
      && !bilan.horsPeriode && !bilan.illisible;
    return {
      accountId: null,
      invoices,
      precision: rienAPrendre ? undefined : precision,
      manquees: arret ? 1 : 0,
      renoncement: arret ? phraseArret(arret, bilan.nonExaminee) : undefined,
      couverture: { detail: 'l\'historique d\'achats tel que la page l\'affiche' },
      aucunDocument: rienAPrendre
        ? (achats.length
          ? `Votre historique Decathlon a bien été lu (${achats.length} achat(s)) : aucun ne propose `
            + `encore « ${LIBELLE_TELECHARGER} ». ${RAPPEL_ADRESSE} Puis relancez la récupération.`
            + (liste.suite ? ` ${phrasePrecision(nouveauBilan(), { suite: true }).slice(2)}` : '')
          : 'Votre historique Decathlon a bien été lu : il ne contient aucun achat pour l\'instant.')
        : undefined,
      horsPeriode: !invoices.length && bilan.horsPeriode > 0 && bilan.horsPeriode === achats.length
        ? `Vos ${achats.length} achat(s) Decathlon sont tous antérieurs à la période demandée — `
          + 'élargissez l\'historique de la fiche pour récupérer leurs factures.'
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
  attendreLaListePeinte,
  normaliserLibelle,
  nettoyerNumero,
  analyserAchat,
  ancreFacture,
  phraseBilan,
  phrasePrecision,
  phraseArret,
  borneHistorique,
  LIRE_OU_DECLENCHER,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MOTIF_REPERE,
  SELECTEUR_LISTE_PEINTE,
  LIBELLE_TELECHARGER,
  RAPPEL_ADRESSE,
};
