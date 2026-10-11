'use strict';

/**
 * Connecteur Impots.gouv.fr — avis d'impôt, déclarations, accusés de réception.
 *
 * ─── La page des documents a été refaite (lot 86, mesuré le 04/10/2026) ──────
 *
 * L'adresse `https://cfspart.impots.gouv.fr/enp/documents.do?n=0` n'a pas
 * changé, mais la page qu'elle sert a été entièrement reconstruite (gabarit
 * DSFR). Le lot 85, qui n'avait jamais vu cette page CONNECTÉE, avait conclu
 * « parcours inchangé » : c'était faux. L'ancien relevé cherchait des lignes
 * `li.row.align-items-center` portant des boutons `title="Visualiser PDF"`, et
 * des liens `documents.do?n=<année>` : plus rien de tout cela n'existe (mesuré :
 * 0 occurrence de chacun). Le passage réel du 04/10 à 21:40 rapportait
 * 0 document, « aucune année lisible ».
 *
 * ─── Toute l'histoire tient dans UNE page, en double ─────────────────────────
 *
 * Les dix années (2026 → 2017) et TOUS leurs documents sont déjà dans le DOM au
 * chargement de `documents.do?n=0`. Aucun clic d'onglet, aucun dépliage n'est
 * nécessaire : les onglets ne font que montrer ou cacher. Mieux (ou pire) : la
 * page porte DEUX FOIS les mêmes documents, une disposition « mobile » et une
 * disposition « bureau », cachées l'une ou l'autre par le CSS selon la largeur :
 *
 *   mobile : div.fr-accordions-group.fr-hidden-md   ids docRwd-/docLieRwd-/titreRwd-
 *   bureau : div.fr-hidden.fr-unhidden-md > .fr-tabs  ids doc-/docLie-/titre-
 *
 * Mesuré : 136 liens de document pour 68 documents. Lire la page entière
 * compterait chaque document DEUX FOIS. On ne lit donc QUE la disposition
 * bureau (`.fr-tabs`), par requête DOM, quelle que soit sa visibilité — les deux
 * dispositions portent les mêmes années, les mêmes titres, le même ordre et les
 * mêmes jetons (vérifié sur le fichier de référence).
 *
 * ─── Un document ─────────────────────────────────────────────────────────────
 *
 *   div#doc-<k>-<n>.panneau_doc.unDocument
 *     h3#titre-<k>-<n>.fr-card__title
 *       a.extLinkDis[target=_blank][href="Affichage_Document_PDF?idEnsua=<jeton>"]
 *         → le TEXTE du lien est le titre (pas l'aria-label, qui ajoute
 *           « (nouvelle fenêtre) »)
 *
 * L'année ne se lit PAS dans la carte : elle vient de l'onglet qui contrôle le
 * panneau — `button[role=tab]#tab-<k>` porte `title="2026"` (le texte visible
 * ajoute « , N document non lu » : on lit le `title`, pas le texte). Le `<k>` du
 * doc relie la carte à son onglet.
 *
 * ─── Les documents associés ──────────────────────────────────────────────────
 *
 * Sous une carte `.repertoire`, un volet « Documents associés » REPLIÉ dont le
 * contenu est déjà dans le DOM (aucun dépliage) :
 *
 *   div#docLie-<k>-<n>-<m>.unDocument
 *     p#titreLie-<k>-<n>-<m>                        → le titre
 *     form[action="Affichage_Document_PDF"][method=GET]
 *       input[type=hidden][name="idEnsua"][value="<jeton>"]
 *
 * ─── Le document ─────────────────────────────────────────────────────────────
 *
 * Le jeton `idEnsua` est DANS la page (href ou champ caché) : il n'y a plus de
 * clic qui le produit. Le document est à `/enp/Affichage_Document_PDF?idEnsua=…`,
 * demandé par `fetch` DANS la page (socle `onglet-pdf`, même empreinte TLS que
 * Chromium — leçon du lot 80). Repli si le `fetch` échoue : le clic sur le lien
 * du titre, qui ouvre un onglet, lu par le même socle. Ce clic passe par
 * `clicAutorise`.
 *
 * ─── Déduplication : le libellé plus l'année, et un rang pour les doublons ───
 *
 * Le `remoteId` reste `AAAA#<libellé>` — JAMAIS `idEnsua` (clé d'accès, non un
 * identifiant stable ; une rotation de clé DGFiP les changerait tous). Les
 * 45 lignes déjà en base sont des `AAAA#<libellé>` : la forme est GELÉE.
 *
 * ⚠ Défaut corrigé ici, antérieur au changement de page : HUIT groupes de
 * documents portent EXACTEMENT le même titre la même année (Notification d'avis
 * à tiers détenteur, Mise en demeure de payer… jusqu'à cinq fois). Avec l'ancre
 * nue, les membres d'un groupe partagent la même ancre : le premier déposé, les
 * suivants pris pour « déjà là » et jamais archivés (68 documents pour 54 ancres
 * distinctes — 14 jamais rapportés). Le correctif : un discriminant de rang,
 * `AAAA#<libellé>#2`, `#3`… Le rang se compte depuis le plus ancien (le bas du
 * DOM : §11 suppose le plus récent en haut, non confirmé faute de date dans les
 * groupes), pour qu'un document neuf du même titre ne décale jamais les autres.
 * Un mauvais pari sur l'ordre produit un doublon, jamais une perte.
 *
 * ─── Session et rejeux (lot 87 ; erratum au lot 89, tout mesuré le 05/10/2026) ─
 *
 * Avec l'ANCIEN enchaînement (contrôle de validité par rejeu sur
 * `documents.do` SANS `?n=0`, puis un autre rejeu 1 à 20 s plus tard), le
 * second rejeu était renvoyé d'office vers `j_spring_security_logout.ex` puis
 * `/deconnexion2` puis `/` (clé de requête `logout`), et le site fermait la
 * session sur TOUT le portail (déconnexion globale, une douzaine de
 * `…/decoGlobale`).
 *
 * ⚠ ERRATUM (lot 89) : le lot 87 en avait conclu « la connexion ne se rejoue
 * qu'une fois ». Démenti le même jour : sans contrôle à l'enregistrement, une
 * même capture a été rejouée TROIS fois en huit minutes, toutes servies
 * (passages n° 644/645/646, 11:09–11:16). La cause des déconnexions de la
 * nuit n'est pas isolée — deux pistes, non départagées : deux rejeux à
 * quelques secondes d'intervalle, ou l'adresse du contrôle sans `?n=0`.
 * Les conséquences tenues ici restent justifiées (c'est l'enchaînement
 * d'avant qui, mesuré, perdait la session) :
 *
 *   - le manifeste déclare `remoteLogin.rejeuUnique` : l'enregistrement ne
 *     lance AUCUN navigateur avec la capture — la récupération qui suit est
 *     elle-même la preuve de session ;
 *   - `test()` n'ouvre pas de navigateur : il consommerait la session ;
 *   - après la navigation, le connecteur JUGE où il est arrivé
 *     (`jugerArrivee`, fonction pure) : liste, session fermée par le site,
 *     connexion demandée, liste illisible, page inattendue. « Aucune année »
 *     ne peut plus sortir d'une page qui n'est pas la liste — c'est ce que
 *     les passages n° 638 et 639 ont écrit en arrivant sur `/?logout…` ;
 *   - chaque passage laisse au journal la chaîne des réponses de navigation
 *     et la différence de cookies entre la capture et la fin du passage
 *     (socle `releve-navigation`, noms seulement — jamais une valeur) ;
 *   - un passage qui a atteint la liste rend son état de navigateur final
 *     (`sessionRenouvelee`) : le planificateur le ré-enregistre, pour que le
 *     passage suivant parte de l'état le plus récent.
 *
 * Le site peut relancer une navigation juste après un chargement (mesuré :
 * `net::ERR_ABORTED` au goto, « Execution context was destroyed » à la
 * lecture) : l'arrivée s'attend et se juge STABILISÉE, jamais en vol.
 *
 * ─── Sortie ──────────────────────────────────────────────────────────────────
 *
 *   /Impots.gouv.fr/<numéro fiscal>/2026/2026_Avis_d_impot_sur_les_revenus_2025.pdf
 */

const sessionState = require('../../session-state');
const history = require('../../history');
const identity = require('../../browser-identity');
const ongletPdf = require('../../onglet-pdf');
const navigation = require('../../releve-navigation');

const URL_PORTAIL = 'https://cfspart.impots.gouv.fr/';
const URL_DOCUMENTS = 'https://cfspart.impots.gouv.fr/enp/documents.do';
const CHEMIN_DOCUMENT = '/enp/Affichage_Document_PDF';
const VIEWPORT = { width: 1600, height: 900 };
const LOCALE = 'fr-FR';

const NAV_TIMEOUT_MS = 45_000;

/**
 * L'attente d'arrivée (lot 87) : le temps laissé à la page pour montrer ses
 * onglets d'année, ou pour se stabiliser ailleurs. Le site relance parfois une
 * navigation juste après un chargement : on n'y lit rien tant que ce n'est pas
 * posé.
 */
const DELAI_ARRIVEE_MS = 25_000;
const PAS_ARRIVEE_MS = 500;

/** L'hôte de la liste des documents — surchargé par les tests du faux site. */
const HOTE_LISTE = 'cfspart.impots.gouv.fr';

/** Pause entre deux documents : le portail est public, on ne le bouscule pas. */
const PAUSE_DOCUMENT_MS = 400;

/** Attente de l'onglet ouvert par le clic de repli. */
const DELAI_ONGLET_MS = 15_000;

const CHAMP_SESSION = 'session';
const CHAMP_HISTORIQUE = 'historique';

/** Compte sans numéro fiscal lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/**
 * Le préfixe que le portail collait devant chaque libellé sur l'ANCIENNE page
 * (« Visualiser PDF »). La nouvelle page ne le porte plus, mais `clicAutorise`
 * le retire encore s'il est là : un libellé déjà propre n'est pas amputé.
 */
const PREFIXE_TITRE = /^\s*«?\s*Visualiser\s+(?:le\s+)?PDF\s*»?\s*[:–-]?\s*/i;

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur Impots.gouv.fr ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à impots.gouv.fr a expiré. Rouvrez-la depuis la fiche du service, '
  + 'bouton « Se connecter à Impots.gouv.fr ». Le portail redemandera votre numéro fiscal, '
  + 'votre mot de passe et un code de sécurité.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * Le site a FERMÉ la session (lot 87) : renvoi vers la page de déconnexion du
 * portail. Ce n'est pas une session devenue vieille — c'est le portail qui l'a
 * refermée, parfois quelques secondes après l'enregistrement. La phrase dit
 * quoi faire, et le marqueur `renvoiAuthentification` (lot 71) la garde telle
 * quelle : le planificateur ne la réécrit pas en « votre connexion a expiré »
 * daté — faux pour une connexion ouverte deux minutes plus tôt.
 */
const MESSAGE_SESSION_FERMEE =
  'Impots.gouv.fr a refermé la connexion avant que crabe ait pu lire vos documents. '
  + 'Reconnectez-vous depuis la fiche du service : la récupération démarre toute '
  + 'seule juste après.';

function erreurSessionFermee() {
  const err = new Error(MESSAGE_SESSION_FERMEE);
  err.sessionExpired = true;
  err.renvoiAuthentification = true;
  return err;
}

/** La liste atteinte mais sans années : la page a changé, pas la session. */
const MESSAGE_LISTE_ILLISIBLE =
  'La page des documents d\'impots.gouv.fr a changé : crabe l\'atteint, mais n\'y '
  + 'reconnaît plus les années. Votre connexion n\'est pas en cause — signalez-le '
  + 'à la personne qui administre crabe.';

/**
 * L'adresse courante est-elle celle d'une page d'authentification ?
 * Trois marqueurs observés : `connexion`, `authorize`, `oauth`. Seuls le CHEMIN
 * et la requête comptent — le domaine `cfspart.impots.gouv.fr` contient
 * « impots », pas ceux-là.
 */
function estPageAuthentification(url) {
  const texte = String(url || '');
  let cible;
  try {
    const analysee = new URL(texte);
    cible = `${analysee.pathname}${analysee.search}`;
  } catch {
    cible = texte;
  }
  return /connexion|authorize|oauth/i.test(cible);
}

/** Les chemins qui signent la déconnexion par le site (mesurés le 05/10/2026). */
const MOTIF_CHEMIN_DECONNEXION = /j_spring_security_logout|deconnexion/i;

/**
 * Juge où la navigation est ARRIVÉE (lot 87). Fonction PURE, partagée avec les
 * tests : l'adresse finale stabilisée, les chemins traversés par le cadre
 * principal (relevé de navigation), et le nombre d'onglets d'année ATTACHÉS au
 * DOM.
 *
 * Cinq verdicts, dans cet ordre :
 *
 *   - `liste`              — hôte de la liste, chemin `/enp/documents.do`,
 *                            onglets présents. L'adresse FINALE juge, jamais
 *                            les étapes : un détour par `/` et
 *                            `oauth2/authorize` suivi d'un retour sur la
 *                            liste est un succès ;
 *   - `session-fermee`     — la chaîne est passée par
 *                            `j_spring_security_logout` ou `deconnexion`, ou
 *                            l'adresse finale porte `logout` (le `/?logout…`
 *                            des passages n° 638/639) ;
 *   - `connexion-demandee` — adresse finale d'authentification
 *                            (`cfspart-idp…`, `oauth2/authorize`,
 *                            `connexion`) ;
 *   - `liste-illisible`    — sur `documents.do`, mais aucun onglet après
 *                            l'attente : la page a changé, pas la session ;
 *   - `page-inattendue`    — tout le reste, avec la forme de l'adresse
 *                            (jamais ses paramètres).
 *
 * @param {{urlFinale: string, chemins?: string[], onglets?: number,
 *          hoteListe?: string}} arrivee `hoteListe` n'est surchargé que par
 *        les tests au faux site local.
 * @returns {{verdict: string, raison: string}}
 */
function jugerArrivee({ urlFinale, chemins = [], onglets = 0, hoteListe = HOTE_LISTE } = {}) {
  let finale = null;
  try {
    finale = new URL(String(urlFinale || ''));
  } catch {
    finale = null;
  }
  const surListe = !!finale
    && finale.hostname === hoteListe
    && finale.pathname === '/enp/documents.do';

  if (surListe && onglets > 0) {
    return {
      verdict: 'liste',
      raison: `liste des documents atteinte — ${onglets} onglet(s) d'année`,
    };
  }

  const parDeconnexion = (Array.isArray(chemins) ? chemins : [])
    .some((c) => MOTIF_CHEMIN_DECONNEXION.test(String(c || '')));
  const finaleLogout = !!finale
    && (/logout/i.test(finale.pathname) || /logout/i.test(finale.search));
  if (!surListe && (parDeconnexion || finaleLogout)) {
    return {
      verdict: 'session-fermee',
      raison: 'le site a renvoyé vers sa page de déconnexion',
    };
  }

  if (!surListe && finale
    && (finale.hostname === 'cfspart-idp.impots.gouv.fr' || estPageAuthentification(urlFinale))) {
    return {
      verdict: 'connexion-demandee',
      raison: 'arrivée sur un écran d\'authentification',
    };
  }

  if (surListe) {
    return {
      verdict: 'liste-illisible',
      raison: 'page des documents atteinte, mais aucun onglet d\'année dans le DOM',
    };
  }

  return {
    verdict: 'page-inattendue',
    raison: `adresse finale ${formeAdresse(urlFinale)}`,
  };
}

/** L'erreur qui correspond à un verdict d'arrivée autre que `liste`. */
function erreurDArrivee(jugement) {
  if (jugement.verdict === 'session-fermee') return erreurSessionFermee();
  if (jugement.verdict === 'connexion-demandee') {
    return erreurSessionExpiree(jugement.raison);
  }
  if (jugement.verdict === 'liste-illisible') return new Error(MESSAGE_LISTE_ILLISIBLE);
  return new Error(
    `Impots.gouv.fr a répondu par une page inattendue (${jugement.raison}). `
      + 'Réessayez plus tard ; si cela se répète, signalez-le à la personne qui '
      + 'administre crabe.'
  );
}

/** L'adresse de la page des documents (`0` = tout, l'année courante en tête). */
function urlAnnee(annee) {
  const valeur = Number.parseInt(annee, 10);
  return `${URL_DOCUMENTS}?n=${Number.isFinite(valeur) ? valeur : 0}`;
}

/**
 * La FORME d'une adresse, pour le journal : son chemin et la présence (jamais la
 * valeur) d'un `idEnsua`. Un jeton ne va ni dans un journal ni dans un message.
 */
function formeAdresse(url) {
  try {
    const u = new URL(url, URL_DOCUMENTS);
    const idEnsua = u.searchParams.has('idEnsua') ? ' ?idEnsua=…' : '';
    return `${u.pathname}${idEnsua}`;
  } catch {
    return '(adresse illisible)';
  }
}

/**
 * LISTE BLANCHE D'ADRESSES (lot 86 B2). Le connecteur ne navigue que vers
 * `documents.do` et ne demande que `Affichage_Document_PDF?idEnsua=…`. Toute
 * autre adresse est refusée — c'est la garde principale sur le site le plus
 * dangereux du catalogue. Le domaine doit être celui du portail.
 */
function adresseAutorisee(url) {
  let u;
  try {
    // Une adresse relative (href de la page : « Affichage_Document_PDF?… »)
    // se résout contre la page des documents, donc sous /enp/.
    u = new URL(url, URL_DOCUMENTS);
  } catch {
    return false;
  }
  if (u.hostname !== 'cfspart.impots.gouv.fr') return false;
  if (u.pathname === '/enp/documents.do') return true;
  if (u.pathname === CHEMIN_DOCUMENT && u.searchParams.has('idEnsua')) return true;
  return false;
}

/** Normalise un titre : insécables → espaces, espaces réduits, bords coupés. */
function normaliserTitre(titre) {
  return String(titre || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Le libellé d'un document, débarrassé de l'éventuel préfixe de l'ancienne page.
 * Sur la nouvelle page le titre est déjà propre ; la normalisation reste la
 * même des DEUX côtés de la comparaison avec les ancres en base.
 */
function libelleDepuisTitre(titre) {
  return normaliserTitre(titre).replace(PREFIXE_TITRE, '').trim();
}

/**
 * La référence stable d'un document : son libellé normalisé et son année.
 * ⚠ Forme GELÉE : les 45 lignes en base sont des `AAAA#libellé`. Les documents
 * au titre UNIQUE dans leur année gardent EXACTEMENT cette forme.
 */
function remoteIdPour(libelle, annee) {
  return `${annee}#${normaliserTitre(libelle)}`;
}

/** La même ancre, suffixée d'un rang (pour les titres en double, lot 86 B3). */
function remoteIdAvecRang(libelle, annee, rang) {
  return `${remoteIdPour(libelle, annee)}#${rang}`;
}

// ---------------------------------------------------------------------------
// Lecture du DOM — une seule source, partagée par le direct et les tests
// ---------------------------------------------------------------------------

/**
 * Découpe un fragment HTML en documents, dans l'ordre du DOM.
 *
 * On opère sur la chaîne plutôt que sur un vrai DOM pour que le MÊME code lise
 * la page réelle (via `page.evaluate(() => conteneur.outerHTML)`) et les
 * fixtures des tests — deux lecteurs divergeraient au premier correctif.
 *
 * Chaque document est borné par son `id` et celui du suivant. Un principal
 * (`doc-<k>-<n>`) porte son titre dans le texte de `h3 a` et son jeton dans le
 * `href` ; un associé (`docLie-<k>-<n>-<m>`) porte son titre dans `p#titreLie…`
 * et son jeton dans `input[name="idEnsua"]`. Les ids mobiles (`docRwd-`,
 * `docLieRwd-`) ne sont PAS attrapés : le `-` après `doc`/`docLie` les exclut.
 *
 * @param {string} html le fragment de la disposition bureau
 * @returns {Array<{k:number, lie:boolean, titre:string, jeton:string|null}>}
 */
function lireDocumentsDuHtml(html) {
  const source = String(html || '');
  const points = [];
  const reDoc = /\bid="doc-(\d+)-(\d+)"/g;
  const reLie = /\bid="docLie-(\d+)-(\d+)-(\d+)"/g;
  let m;
  while ((m = reDoc.exec(source))) points.push({ idx: m.index, lie: false, k: Number(m[1]) });
  while ((m = reLie.exec(source))) points.push({ idx: m.index, lie: true, k: Number(m[1]) });
  points.sort((a, b) => a.idx - b.idx);

  const texte = (frag) =>
    normaliserTitre(
      String(frag || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&apos;/g, '\'')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
    );

  const sortie = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const bloc = source.slice(p.idx, i + 1 < points.length ? points[i + 1].idx : source.length);

    let titre = '';
    let jeton = null;
    if (!p.lie) {
      const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(bloc);
      const a = h3 && /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(h3[1]);
      titre = a ? texte(a[1]) : texte(h3 ? h3[1] : '');
      jeton = (/[?&]idEnsua=([0-9a-fA-F]+)/.exec(bloc) || [])[1] || null;
    } else {
      const t = /<p\b[^>]*\bid="titreLie-[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(bloc);
      titre = t ? texte(t[1]) : '';
      jeton =
        (/name="idEnsua"\s+value="([0-9a-fA-F]+)"/.exec(bloc) || [])[1]
        || (/value="([0-9a-fA-F]+)"[^>]*name="idEnsua"/.exec(bloc) || [])[1]
        || null;
    }
    if (titre) sortie.push({ k: p.k, lie: p.lie, titre, jeton });
  }
  return sortie;
}

/**
 * Les compteurs « N documents » par année (B4). Ils vivent dans la disposition
 * MOBILE : chaque accordéon d'année `div.fr-collapse#<AAAA>` contient un
 * `<em>N&nbsp;documents</em>` qui annonce le nombre de documents PRINCIPAUX de
 * l'année (associés non compris). C'est la preuve de complétude.
 *
 * L'espace entre le nombre et « documents » accepte TOUTE espace (lot 87) :
 * `\s` couvre déjà les insécables littérales (U+00A0, U+202F), les entités
 * `&nbsp;`/`&#160;`/`&#8239;`/`&#xa0;`/`&#x202f;` s'ajoutent. Un compteur qui
 * manque quand même ne bloque JAMAIS la récupération : il se journalise dans
 * `fetchInvoices`, rien de plus — perdre un document est pire qu'un doublon.
 *
 * @param {string} html le fragment de la disposition mobile
 * @returns {Record<string, number>} { "2026": 4, "2025": 4, … }
 */
function compteursDuHtml(html) {
  const source = String(html || '');
  const re = /\bid="((?:19|20)\d\d)"[^>]*>([\s\S]*?)(?=\bid="(?:19|20)\d\d"|$)/g;
  const out = {};
  let m;
  while ((m = re.exec(source))) {
    const em = /<em>\s*(\d+)(?:&nbsp;|&#160;|&#8239;|&#xa0;|&#x202f;|\s)+documents?\s*<\/em>/i
      .exec(m[2]);
    if (em) out[m[1]] = Number(em[1]);
  }
  return out;
}

/**
 * Les années proposées, lues dans le `title` des onglets `role="tab"`.
 * @param {Array<{title?: string}>} onglets
 * @returns {number[]} décroissant, dédoublonné
 */
function anneesDepuisOnglets(onglets) {
  const vues = new Set();
  for (const o of Array.isArray(onglets) ? onglets : []) {
    const annee = (/\b((?:19|20)\d\d)\b/.exec(String(o?.title || '')) || [])[1];
    if (annee) vues.add(Number.parseInt(annee, 10));
  }
  return [...vues].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Garde par libellé — second filet, derrière la liste blanche d'adresses
// ---------------------------------------------------------------------------

/**
 * Les verbes qui trahissent un bouton d'ACTION, en TÊTE de libellé (`^`). Les
 * libellés de documents RÉELS contiennent « payer », « prélèvement » au MILIEU
 * (« Mise en demeure de payer », « Rejet de prélèvement ») : ce sont des types
 * de document, pas des actions. Seul un libellé qui COMMENCE par un verbe
 * dénonce un bouton d'action.
 *
 * `télécharger` y figure parce que la nouvelle page n'a plus le préfixe
 * « Visualiser PDF » qui écartait jadis « Télécharger et payer » (lot 86).
 */
const MOTIF_ACTION_INITIALE =
  /^(?:payer|r[ée]gler|r[ée]glement|paiement|pr[ée]l[èe]vement|d[ée]clarer|t[ée]l[ée]charger|corriger|modifier|valider|signer|envoyer|transmettre|adh[ée]rer|souscrire|supprimer|annuler|rectifier|r[ée]clam(?:er|ation)|messagerie|[ée]crire)\b/i;

/** Les mots d'une DÉCONNEXION, à refuser où qu'ils soient (lot 86 B2). */
const MOTIF_DECONNEXION = /d[ée]connect|d[ée]connex|se d[ée]connecter|logout|j_spring_security_logout/i;

/** Le nom du document commence-t-il par un verbe d'action ? */
function libelleEvoqueUneAction(nom) {
  return MOTIF_ACTION_INITIALE.test(normaliserTitre(nom));
}

/** Le libellé parle-t-il de déconnexion ? */
function libelleEstDeconnexion(nom) {
  return MOTIF_DECONNEXION.test(normaliserTitre(nom));
}

/**
 * CE CLIC DE REPLI EST-IL AUTORISÉ ? — second filet, derrière la liste blanche
 * d'adresses. On retire l'éventuel préfixe « Visualiser PDF » (ancienne page),
 * puis on refuse un libellé vide, un verbe d'action en tête, ou un mot de
 * déconnexion. En cas de doute, on NE clique PAS.
 *
 * @param {string} titre le libellé du lien à cliquer
 */
function clicAutorise(titre) {
  const nom = normaliserTitre(titre).replace(PREFIXE_TITRE, '').trim();
  if (!nom) return false;
  return !libelleEvoqueUneAction(nom) && !libelleEstDeconnexion(nom);
}

// ---------------------------------------------------------------------------
// Ancrage — c'est le point critique du lot (B3)
// ---------------------------------------------------------------------------

/**
 * Décide l'ancre de chaque membre d'un GROUPE de documents au titre identique
 * dans une même année. Fonction PURE (les tailles viennent du téléchargement).
 *
 * Règles (B3) :
 *   - un seul membre → l'ancre nue `AAAA#titre`, comme les 45 déjà en base ;
 *   - plusieurs membres → un rang `AAAA#titre#<r>`, `r` compté DEPUIS LE PLUS
 *     ANCIEN (le dernier du DOM), pour qu'un document neuf (en tête) ne décale
 *     jamais les rangs existants ;
 *   - si l'ancre nue est DÉJÀ en base, on cherche lequel des membres elle
 *     désigne, par la TAILLE (jamais le contenu). Une seule correspondance → ce
 *     membre REPREND l'ancre nue (il est déjà déposé, on ne le redépose pas) ;
 *     les autres prennent leur rang. Aucune correspondance unique → on ne
 *     devine pas : tous prennent un rang, la ligne nue reste, un doublon est
 *     possible et le bilan le dira.
 *
 * Chaque ancre porte aussi son `rang` (`null` pour l'ancre nue) : le NOM DE
 * FICHIER le reprend (lot 88). Le 05/10/2026, les 14 membres de groupe déposés
 * portaient tous le nom de la ligne nue de leur groupe — le dépôt se fait par
 * nom de fichier, chacun a donc écrasé le fichier d'un autre document sur deux
 * stockages. Le rang dans le nom rend les noms distincts et STABLES : compté
 * depuis le plus ancien, un document neuf (en tête du DOM) ne décale personne.
 *
 * @param {{libelle:string, annee:number|string}} tete
 * @param {Array<{domIndex:number, taille?:number|null}>} membres ordre DOM
 * @param {{bareEnBase:boolean, tailleBase:number|null}} base
 * @returns {{ancres: Array<{remoteId:string, repris:boolean, rang:number|null}>,
 *            doublonPossible:boolean}}
 */
function deciderAncresGroupe(tete, membres, base = {}) {
  const bare = remoteIdPour(tete.libelle, tete.annee);
  const n = membres.length;

  if (n === 1) {
    return { ancres: [{ remoteId: bare, repris: false, rang: null }], doublonPossible: false };
  }

  // Rang depuis le plus ancien : le dernier du DOM (plus grand domIndex) = 1.
  const ordonnes = membres.map((m, i) => ({ i, domIndex: m.domIndex, taille: m.taille }));
  const parAge = [...ordonnes].sort((a, b) => b.domIndex - a.domIndex); // plus ancien d'abord
  const rangDe = new Map();
  parAge.forEach((m, k) => rangDe.set(m.i, k + 1));

  const ancres = ordonnes.map((m) => ({
    remoteId: remoteIdAvecRang(tete.libelle, tete.annee, rangDe.get(m.i)),
    repris: false,
    rang: rangDe.get(m.i),
  }));

  let doublonPossible = false;
  if (base.bareEnBase) {
    const tailleBase = Number(base.tailleBase);
    const candidats = Number.isFinite(tailleBase)
      ? ordonnes.filter((m) => Number.isFinite(Number(m.taille)) && Number(m.taille) === tailleBase)
      : [];
    if (candidats.length === 1) {
      // Ce membre EST la ligne nue déjà en base : il la reprend, on ne le
      // redépose pas. Les autres gardent leur rang.
      ancres[candidats[0].i] = { remoteId: bare, repris: true, rang: null };
    } else {
      // On ne devine pas : la ligne nue reste, un membre peut figurer deux fois.
      doublonPossible = true;
    }
  }
  return { ancres, doublonPossible };
}

/** Le numéro fiscal porté par un texte, ou « compte ». */
function compteDepuisTexte(texte, config = {}) {
  const declare = String(config?.numeroFiscal || '').replace(/\s+/g, '');
  if (/^\d{13}$/.test(declare)) return declare;
  const trouve = /\b(\d{13})\b/.exec(String(texte || '').replace(/\s+/g, ''));
  return trouve ? trouve[1] : COMPTE_PAR_DEFAUT;
}

/**
 * Nom du fichier déposé : l'année, puis un nom tiré du libellé — et le RANG
 * pour les membres d'un groupe de même titre (lot 88). Sans lui, deux
 * documents distincts partagent un nom, et le dépôt — qui se fait par nom de
 * fichier — remplace l'un par l'autre (mesuré le 05/10/2026 : 8 fichiers
 * archivés écrasés). Le membre qui reprend l'ancre nue garde le nom simple :
 * aucun fichier existant n'est renommé.
 *
 * @param {number|string} annee
 * @param {string} libelle
 * @param {number|null} [rang] le rang du membre dans son groupe (`null` : nom simple)
 */
function nomFichier(annee, libelle, rang = null) {
  const base = String(libelle || 'document')
    // Translittération des accents : « impôt » → « impot », comme le faisait
    // le nom de fichier servi par le portail sur l'ancienne page.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^\w.@()+-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '') || 'document';
  const sansExtension = base.replace(/\.pdf$/i, '');
  const suffixe = Number.isFinite(Number(rang)) && rang !== null ? `_${rang}` : '';
  return `${annee}_${sansExtension}${suffixe}.pdf`;
}

/** Contrôle de la connexion enregistrée avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la connexion enregistrée, navigue vers la liste,
 * JUGE l'arrivée, puis passe la main (lot 87).
 *
 * Chaque passage, réussi ou non, laisse au journal : la chaîne des réponses
 * de navigation du cadre principal (relevé du socle, noms et chemins
 * seulement), le jugement d'arrivée, et la différence de cookies entre la
 * capture et la fin du passage. Un passage qui a atteint la liste rend aussi
 * son état de navigateur final (`sessionRenouvelee`, R4) — en dernier, et
 * sans jamais pouvoir changer le résultat du passage.
 */
async function surLeCompte(config, fn, { log = () => {} } = {}) {
  const session = lireSession(config);

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  let context = null;
  let cookiesCapture = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({
        storageState: session,
        viewport: VIEWPORT,
        locale: LOCALE,
        acceptDownloads: true,
      })
    );
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    const releve = navigation.brancher(page, { log, prefixe: 'impots : navigation' });
    cookiesCapture = await context.cookies().catch(() => []);

    const { onglets } = await aller(page, urlAnnee(0), { log });
    const jugement = jugerArrivee({
      urlFinale: page.url(),
      chemins: releve.chemins(),
      onglets,
    });
    log(`impots : arrivée jugée « ${jugement.verdict} » — ${jugement.raison}`);
    if (jugement.verdict !== 'liste') throw erreurDArrivee(jugement);

    const sortie = await fn(page, context);

    // R4 — l'état de session en fin de passage RÉUSSI remplace la capture
    // (le planificateur l'enregistre). Jamais après une session fermée ou une
    // connexion demandée : on vient de prouver « liste ». Un échec de lecture
    // se dit et ne change rien au passage.
    if (sortie && typeof sortie === 'object' && !Array.isArray(sortie)) {
      try {
        sortie.sessionRenouvelee = JSON.stringify(await context.storageState());
      } catch (err) {
        log(
          'impots : l\'état de session n\'a pas pu être relu en fin de passage '
            + `(${err.message}) — le passage reste ce qu'il est`
        );
      }
    }
    return sortie;
  } finally {
    // La différence de cookies se dit sur TOUS les chemins de sortie : c'est
    // elle qui permettra de comprendre un refus sans refaire une nuit de
    // sondes. Noms seulement, jamais une valeur.
    if (context) {
      try {
        const cookiesFin = await context.cookies();
        log(`impots : ${navigation.formaterDifference(
          navigation.differenceEtats(cookiesCapture, cookiesFin)
        )}`);
      } catch {
        /* navigateur déjà tombé : pas de différence à dire */
      }
    }
    await browser.close().catch(() => {});
  }
}

/**
 * Va sur une page AUTORISÉE et attend l'ARRIVÉE — sans juger : c'est
 * `jugerArrivee` qui juge, sur l'adresse finale stabilisée.
 *
 * Le site peut relancer une navigation juste après un chargement (mesuré le
 * 05/10/2026 : `net::ERR_ABORTED` au `goto` pendant une chaîne de renvois) :
 * ce n'est pas une erreur, l'arrivée s'attend.
 */
async function aller(page, url, { log = () => {} } = {}) {
  if (!adresseAutorisee(url)) {
    throw new Error(`adresse hors liste blanche refusée : ${formeAdresse(url)}`);
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    if (!/ERR_ABORTED/i.test(String(err?.message || ''))) throw err;
    log('impots : le site a relancé une navigation pendant le chargement — on attend l\'arrivée');
  }
  return attendreArrivee(page);
}

/**
 * Attend que la navigation soit POSÉE : soit les onglets d'année sont
 * attachés au DOM (visibles ou non — règle du lot 86), soit l'adresse finale
 * est stable HORS de la liste (deux lectures identiques à un pas d'écart).
 * Délai borné ; on ne lit jamais le DOM pendant une navigation — un comptage
 * pris de vitesse par une navigation (« Execution context was destroyed »)
 * vaut zéro et se retente au pas suivant.
 *
 * @returns {Promise<{onglets: number}>}
 */
async function attendreArrivee(page, { delaiMs = DELAI_ARRIVEE_MS, pasMs = PAS_ARRIVEE_MS } = {}) {
  const fin = Date.now() + delaiMs;
  let precedente = null;
  for (;;) {
    const courante = String(page.url() || '');
    const onglets = await page
      .locator('button[role="tab"][id^="tab-"]')
      .count()
      .catch(() => 0);
    if (onglets > 0) return { onglets };

    let surListe = false;
    try {
      surListe = new URL(courante).pathname === '/enp/documents.do';
    } catch {
      surListe = false;
    }
    if (!surListe && precedente !== null && courante === precedente) return { onglets: 0 };
    if (Date.now() >= fin) return { onglets: 0 };
    precedente = courante;
    await page.waitForTimeout(pasMs).catch(() => {});
  }
}

/**
 * Lit, dans la page déjà chargée, la disposition BUREAU et les compteurs
 * MOBILES, sans un seul clic. Rend les fragments HTML (lus par les fonctions
 * pures) et les onglets d'années.
 */
async function lirePage(page) {
  return page.evaluate(() => {
    const bureau = document.querySelector('div.fr-hidden.fr-unhidden-md div.fr-tabs')
      || document.querySelector('div.fr-tabs');
    const mobile = document.querySelector('div.fr-accordions-group.fr-hidden-md');
    const onglets = [...document.querySelectorAll('button[role="tab"][id^="tab-"]')]
      .filter((b) => /^tab-\d+$/.test(b.id))
      .map((b) => ({ k: Number(b.id.slice(4)), title: b.getAttribute('title') || '' }));
    return {
      bureauHtml: bureau ? bureau.outerHTML : '',
      mobileHtml: mobile ? mobile.outerHTML : '',
      onglets,
    };
  });
}

/** L'adresse (relative) d'un document, à partir de son jeton. */
function urlDocument(jeton) {
  return `${CHEMIN_DOCUMENT}?idEnsua=${jeton}`;
}

/**
 * Télécharge un document. Voie principale : le `fetch` DANS la page (socle
 * onglet-pdf, même empreinte que Chromium). Repli : le clic sur le lien du
 * titre, qui ouvre un onglet, lu par le même socle — et ce clic passe par
 * `clicAutorise`.
 *
 * @returns {Promise<{ok:true, buffer:Buffer} | {ok:false, grief:string}>}
 */
async function telechargerDocument(page, context, { jeton, titre }) {
  const url = urlDocument(jeton);
  if (!adresseAutorisee(url)) {
    return { ok: false, grief: `adresse hors liste blanche : ${formeAdresse(url)}` };
  }

  // Voie 1 — le flux relu dans la page.
  const direct = await ongletPdf.fluxDeLaPage(page, url);
  if (direct.ok) return { ok: true, buffer: direct.buffer };

  // Voie 2 — le repli par clic, sous le second filet.
  if (!clicAutorise(titre)) {
    return { ok: false, grief: `${direct.grief} ; repli refusé par la garde` };
  }
  const lien = page
    .locator(`h3 a.extLinkDis[href*="idEnsua=${jeton}"], a[href*="idEnsua=${jeton}"]`)
    .first();
  if (!(await lien.count().catch(() => 0))) {
    return { ok: false, grief: `${direct.grief} ; lien du titre introuvable pour le repli` };
  }
  let reponsePdf = null;
  const attenteReponse = page
    .waitForResponse((r) => /Affichage_Document_PDF/.test(r.url()) && /pdf/i.test(r.headers()['content-type'] || ''), { timeout: DELAI_ONGLET_MS })
    .then((r) => { reponsePdf = r; })
    .catch(() => {});
  const attenteOnglet = context.waitForEvent('page', { timeout: DELAI_ONGLET_MS }).catch(() => null);
  await lien.click({ timeout: 5000 }).catch(() => {});
  const onglet = await attenteOnglet;
  await attenteReponse;
  if (!onglet) return { ok: false, grief: `${direct.grief} ; aucun onglet ouvert au repli` };
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, reponsePdf, { pageRelais: page });
  return lu.ok ? { ok: true, buffer: lu.buffer } : { ok: false, grief: `${direct.grief} ; ${lu.grief}` };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification SANS navigateur (lot 87 ; commentaire corrigé au lot 89).
 * Mesuré : avec l'ancien enchaînement, un contrôle par rejeu suivi d'un autre
 * rejeu quelques secondes plus tard perdait la session (cause non isolée —
 * rejeux rapprochés, ou adresse de contrôle sans `?n=0`). On ne prétend plus
 * que « le site ne tolère qu'un rejeu » (démenti : trois rejeux servis en
 * huit minutes le 05/10/2026) ; on s'abstient simplement de tout rejeu de
 * contrôle. On vérifie ce qui se vérifie sans rejeu — une session est
 * enregistrée et n'est pas périmée — et on dit honnêtement que la preuve
 * viendra de la prochaine récupération. Jusqu'au lot 86, ce test rendait
 * « Connexion valide » même sur une page sans aucune année : c'était faux
 * deux fois.
 */
async function test(config, ctx = {}) {
  try {
    lireSession(config);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const compte = compteDepuisTexte('', config);
  ctx.log?.(
    'impots : connexion enregistrée — pas de contrôle par rejeu (un rejeu de '
      + 'contrôle a déjà coûté la session sur ce site), la prochaine récupération '
      + 'en fera la preuve'
  );
  return {
    ok: true,
    accountId: compte,
    invoiceCount: undefined,
    message:
      'Connexion enregistrée'
      + (compte !== COMPTE_PAR_DEFAUT ? ` — numéro fiscal ${compte}` : '')
      + '. Elle n\'est pas vérifiée d\'avance sur ce site : '
      + 'la prochaine récupération en fera la preuve.',
  };
}

/**
 * Récupère les documents des années retenues, sans un seul clic : une
 * navigation sur `documents.do?n=0`, puis lecture du DOM.
 */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const taillesConnues = new Map(
    Object.entries(ctx.knownSizes || {}).map(([k, v]) => [String(k), Number(v)])
  );
  const log = ctx.log || (() => {});

  return surLeCompte(config, async (page, context) => {
    const texteAccueil = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
    const compte = compteDepuisTexte(texteAccueil, config);

    const { bureauHtml, mobileHtml, onglets } = await lirePage(page);
    const disponibles = anneesDepuisOnglets(onglets);

    // Le jugement d'arrivée a prouvé des onglets ATTACHÉS ; si aucun ne porte
    // d'année lisible, la page a encore changé — échec net qui n'accuse pas la
    // session. « Aucune année » ne sort plus jamais en silence (lot 87).
    if (!disponibles.length) throw new Error(MESSAGE_LISTE_ILLISIBLE);
    const anneeDuK = new Map(
      onglets.map((o) => [o.k, (/\b((?:19|20)\d\d)\b/.exec(o.title) || [])[1] || null])
    );

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles,
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      plafondMois: ctx?.conservationMois || 0,
    });
    const aParcourir = new Set(plan.annees.map(String));

    log(
      `impots : historique « ${plan.mode} » — ${plan.raison} ; `
        + `${plan.annees.length} année(s) à parcourir, ${connus.size} document(s) déjà récupérés`
    );

    if (disponibles.length > 0) {
      ctx.preuveDeListe?.({
        session: `menu des années affiché dans l'espace documents (${disponibles.length} année(s))`,
        liste: 'espace « Mes documents » d\'impots.gouv.fr',
        elements: disponibles.length,
      });
    }

    // ─── Lecture du DOM : tous les documents, dans l'ordre du DOM ──────────
    const tous = lireDocumentsDuHtml(bureauHtml).map((d, domIndex) => ({
      ...d,
      domIndex,
      annee: anneeDuK.get(d.k),
      libelle: libelleDepuisTitre(d.titre),
    }));
    const compteurs = compteursDuHtml(mobileHtml);
    // Un compteur absent ou illisible se JOURNALISE, rien de plus (lot 87) :
    // perdre un document est pire qu'un doublon, et la sonde du 05/10/2026 n'a
    // trouvé aucun « N documents » à l'espace ordinaire — balise ou espace ont
    // pu changer. La complétude se contre-vérifie quand les compteurs parlent.
    if (!Object.keys(compteurs).length) {
      log('impots : aucun compteur « N documents » lisible dans la page — '
        + 'complétude non contre-vérifiée, la récupération continue');
    }

    // Compte des principaux lus par année (B4) et preuve de complétude.
    const principauxParAnnee = new Map();
    for (const d of tous) {
      if (d.lie) continue;
      principauxParAnnee.set(d.annee, (principauxParAnnee.get(d.annee) || 0) + 1);
    }
    let complet = true;
    for (const annee of disponibles) {
      const lu = principauxParAnnee.get(String(annee)) || 0;
      const annonce = compteurs[String(annee)];
      if (annonce != null && annonce !== lu) {
        complet = false;
        log(`impots : ${annee} — ${lu} document(s) principaux lus, ${annonce} annoncé(s) par le compteur : écart`);
      }
    }

    // ─── Groupage par (année, libellé), rang pour les doublons ────────────
    const groupes = new Map();
    for (const d of tous) {
      if (!d.libelle || !d.annee) continue;
      const cle = `${d.annee}#${d.libelle}`;
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(d);
    }
    const groupesDoubles = [...groupes.values()].filter((g) => g.length > 1).length;

    const invoices = [];
    const bilan = new Map(); // année → {vus, dejaDeposes, deposes, manques}
    const compteur = (annee) => {
      if (!bilan.has(annee)) bilan.set(annee, { vus: 0, dejaDeposes: 0, deposes: 0, manques: 0 });
      return bilan.get(annee);
    };
    let doublonsPossibles = 0;

    for (const [cle, membres] of groupes) {
      const annee = membres[0].annee;
      if (!aParcourir.has(String(annee))) continue;

      const bare = remoteIdPour(membres[0].libelle, annee);
      const bareEnBase = connus.has(bare);
      const tailleBase = taillesConnues.has(bare) ? taillesConnues.get(bare) : null;

      // Rang provisoire (sans taille) pour savoir qui télécharger.
      const provisoire = deciderAncresGroupe(
        { libelle: membres[0].libelle, annee },
        membres.map((m) => ({ domIndex: m.domIndex, taille: null })),
        { bareEnBase, tailleBase }
      );

      // On télécharge un membre si son ancre de rang n'est PAS déjà connue
      // (le membre qui pourrait reprendre l'ancre nue a un rang non connu : il
      // est donc téléchargé, ce qui permet la comparaison de tailles).
      const tailles = new Array(membres.length).fill(null);
      const buffers = new Array(membres.length).fill(null);
      for (let i = 0; i < membres.length; i++) {
        compteur(annee).vus++;
        const ancreRang = provisoire.ancres[i].remoteId;
        if (membres.length > 1 && connus.has(ancreRang)) {
          compteur(annee).dejaDeposes++;
          continue;
        }
        if (membres.length === 1 && connus.has(bare)) {
          compteur(annee).dejaDeposes++;
          continue;
        }
        const res = await telechargerDocument(page, context, { jeton: membres[i].jeton, titre: membres[i].titre });
        if (!res.ok) {
          compteur(annee).manques++;
          log(`impots : ${annee} — « ${membres[i].libelle} » non obtenu (${res.grief}), repris au prochain passage`);
          await page.waitForTimeout(PAUSE_DOCUMENT_MS);
          continue;
        }
        buffers[i] = res.buffer;
        tailles[i] = res.buffer.length;
        await page.waitForTimeout(PAUSE_DOCUMENT_MS);
      }

      // Décision finale, tailles en main.
      const decision = deciderAncresGroupe(
        { libelle: membres[0].libelle, annee },
        membres.map((m, i) => ({ domIndex: m.domIndex, taille: tailles[i] })),
        { bareEnBase, tailleBase }
      );
      if (decision.doublonPossible) {
        doublonsPossibles++;
        log(`impots : ${annee} — groupe « ${membres[0].libelle} » : ancre nue déjà en base non rattachable par la taille, un doublon est possible`);
      }

      for (let i = 0; i < membres.length; i++) {
        if (!buffers[i]) continue; // pas téléchargé (déjà déposé) ou manqué
        const { remoteId, repris, rang } = decision.ancres[i];
        if (repris || connus.has(remoteId)) {
          // Ce membre EST la ligne nue déjà en base : on ne le redépose pas.
          compteur(annee).dejaDeposes++;
          connus.add(remoteId);
          continue;
        }
        if (!identity.estPdf(buffers[i])) {
          throw erreurSessionExpiree(`réponse non-PDF pour « ${membres[i].libelle} » (${buffers[i].length} o)`);
        }
        connus.add(remoteId);
        compteur(annee).deposes++;
        invoices.push({
          accountId: compte,
          remoteId,
          // Le rang entre dans le NOM (lot 88) : deux membres d'un groupe ne
          // partagent plus jamais un nom de fichier, et le dépôt n'écrase plus.
          filename: nomFichier(annee, membres[i].libelle, rang),
          issuedOn: `${annee}-01-01`,
          buffer: buffers[i],
        });
      }
    }

    // ─── Journal de bilan, sans rien de personnel ─────────────────────────
    for (const annee of [...bilan.keys()].sort((a, b) => Number(b) - Number(a))) {
      const b = bilan.get(annee);
      log(`impots : ${annee} — vus ${b.vus}, déjà déposés ${b.dejaDeposes}, déposés ${b.deposes}, manqués ${b.manques}`);
    }
    const manques = [...bilan.values()].reduce((s, b) => s + b.manques, 0);
    log(
      `impots : ${plan.annees.length} année(s) parcourue(s), ${invoices.length} document(s) récupéré(s), `
        + `${groupesDoubles} groupe(s) de titres identiques, ${doublonsPossibles} doublon(s) possible(s)`
    );

    return {
      accountId: compte,
      invoices,
      manquees: manques,
      couverture: complet
        ? { complete: true }
        : { detail: 'une ou plusieurs années montrent un écart entre les documents lus et le compteur annoncé' },
    };
  }, { log });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  jugerArrivee,
  erreurDArrivee,
  erreurSessionFermee,
  attendreArrivee,
  MESSAGE_SESSION_FERMEE,
  MESSAGE_LISTE_ILLISIBLE,
  urlAnnee,
  formeAdresse,
  adresseAutorisee,
  normaliserTitre,
  libelleDepuisTitre,
  remoteIdPour,
  remoteIdAvecRang,
  lireDocumentsDuHtml,
  compteursDuHtml,
  anneesDepuisOnglets,
  deciderAncresGroupe,
  clicAutorise,
  libelleEvoqueUneAction,
  libelleEstDeconnexion,
  nomFichier,
  compteDepuisTexte,
  erreurSessionExpiree,
  MESSAGE_SESSION_EXPIREE,
  URL_PORTAIL,
  URL_DOCUMENTS,
  CHEMIN_DOCUMENT,
  COMPTE_PAR_DEFAUT,
};
