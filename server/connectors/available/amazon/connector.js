'use strict';

/**
 * Connecteur Amazon — les factures des commandes, année par année.
 *
 * Parcours **validé contre un compte réel le 10/08/2026** : 12 commandes et 18
 * documents relevés sur la seule année 2026, un PDF téléchargé et vérifié
 * (106 539 octets, en-tête `%PDF-`). Tout ce qui suit décrit ce parcours-là.
 *
 * ─── Pourquoi une session ouverte à la main ──────────────────────────────────
 *
 * Amazon exige un code de validation à la connexion. Aucun connecteur ne peut
 * donc ouvrir la session tout seul : crabe rejoue celle que l'utilisateur a
 * ouverte dans le navigateur distant (16 cookies observés, valables environ
 * 400 jours). Comme Free, Amazon n'accepte **qu'une session à la fois** — se
 * reconnecter ailleurs invalide celle de crabe, d'où la même détection
 * d'expiration et le même message actionnable.
 *
 * ─── Sans filtre, la page ment par omission ──────────────────────────────────
 *
 * `https://www.amazon.fr/your-orders/orders` sans paramètre ne montre que les
 * **trois derniers mois**. Il faut passer par le sélecteur de période, qui
 * expose quinze années (2012 à 2026) sous forme d'options dont le texte vaut
 * « en 2026 », « en 2025 »… Elles sont relevées dynamiquement — aucune année
 * n'est écrite en dur — et dédoublonnées, parce que le sélecteur apparaît
 * parfois deux fois dans le document.
 *
 *   https://www.amazon.fr/your-orders/orders?timeFilter=<valeur>&startIndex=<n×10>
 *
 * Dix commandes par page ; on s'arrête quand une page n'en rend plus aucune.
 *
 * ─── Repérer une commande ────────────────────────────────────────────────────
 *
 * Les cartes portent « N° de commande », **en minuscules dans le DOM** :
 * l'affichage en capitales vient de la feuille de style, et chercher la version
 * majuscule ne trouve rien. On retient les conteneurs qui portent UN SEUL
 * numéro, et parmi eux les plus profonds.
 *
 * La date et le montant ne sont pas toujours dans ce conteneur-là : ils
 * figurent souvent dans l'en-tête, au-dessus. On remonte jusqu'à six niveaux,
 * en s'arrêtant dès qu'un ancêtre engloberait plusieurs commandes.
 *
 * ─── Les documents : le point délicat ────────────────────────────────────────
 *
 * Chaque commande porte un lien « Facture » qui ouvre un menu flottant. Ce menu
 * contient « Facture 1 », « Facture 2 » (expéditions séparées), « Facture »
 * quand il n'y en a qu'une, « Note de crédit » (un avoir, à conserver et à
 * distinguer) et « Récapitulatif de commande imprimable », qui n'est PAS une
 * facture et qu'on ignore.
 *
 * Trois pièges, tous rencontrés :
 *
 *   a. **le déclencheur n'est pas toujours dans la carte.** On le cherche
 *      dedans, puis en remontant jusqu'à cinq ancêtres, en s'arrêtant avant
 *      d'englober une autre commande. Un déclencheur déjà attribué ne peut plus
 *      l'être à une autre ;
 *   b. **le clic ouvre le PDF dans le MÊME onglet**, ce qui fait perdre la
 *      liste. Ces navigations sont annulées pendant tout le relevé
 *      (`page.route('**' + '/documents/download/**', abort)`) ;
 *   c. **le menu est flottant, hors de la carte dans le DOM.** Impossible de
 *      rattacher un lien à sa commande en remontant l'arbre : toutes les
 *      tentatives ont échoué. La méthode qui fonctionne est de **photographier
 *      avant d'agir** — relever les liens présents, ouvrir LE menu de cette
 *      commande, attendre activement que de nouveaux liens apparaissent, et
 *      retenir ceux qui n'étaient pas là.
 *
 * ─── Déduplication : le piège majeur ─────────────────────────────────────────
 *
 * **Les UUID changent à chaque exécution.** Vérifié : la même facture portait
 * `e493a771…` puis `797ae21f…` à quelques minutes d'intervalle — Amazon les
 * régénère à l'ouverture du menu. Un `remoteId` fondé sur l'UUID ferait
 * retélécharger l'intégralité du compte à chaque synchronisation.
 *
 * La référence est donc le couple **numéro de commande + rang du document** :
 *
 *   406-0000000-0000000#1
 *   406-0000000-0000000#2
 *   406-0000000-0000000#avoir
 *
 * ─── Ménager le site ─────────────────────────────────────────────────────────
 *
 * Amazon limite les accès après des parcours rapprochés. Constaté : trois
 * parcours complets en peu de temps, puis une page qui se charge normalement
 * mais **sans aucune commande**, en 38 secondes au lieu de 123. D'où cinq
 * secondes au moins entre deux pages, l'arrêt immédiat sur une vérification
 * anti-robot, et un silence anormal signalé dans les journaux plutôt que pris
 * pour une année vide.
 *
 * ─── Sortie ──────────────────────────────────────────────────────────────────
 *
 *   /Amazon/<compte>/2026-07_406-0000000-0000000.pdf          une seule facture
 *   /Amazon/<compte>/2026-07_406-0000000-0000000_1.pdf        plusieurs
 *   /Amazon/<compte>/2026-07_406-0000000-0000000_avoir.pdf    note de crédit
 */

const sessionState = require('../../session-state');
const history = require('../../history');
const identity = require('../../browser-identity');
const pageDocs = require('../../documents-de-page');

const URL_COMMANDES = 'https://www.amazon.fr/your-orders/orders';
const VIEWPORT = { width: 1600, height: 900 };
const LOCALE = 'fr-FR';

/** Dix commandes par page : c'est la pagination d'Amazon, pas un réglage. */
const PAR_PAGE = 10;

const NAV_TIMEOUT_MS = 45_000;
/** Attente active des nouveaux liens après ouverture d'un menu. */
const DELAI_MENU_MS = 4000;
/** Borne haute de pages par année : 400 commandes, largement au-delà du réel. */
const MAX_PAGES_PAR_ANNEE = 40;

/**
 * Délai minimal entre deux pages.
 *
 * Réglable par `CRABE_AMAZON_PAUSE_MS`, mais **jamais en dessous de cinq
 * secondes** : le plancher est là pour qu'un réglage distrait ne puisse pas
 * faire bannir le compte de l'utilisateur.
 */
const PAUSE_PLANCHER_MS = 5000;

function pauseEntrePages() {
  const demande = Number.parseInt(process.env.CRABE_AMAZON_PAUSE_MS || '', 10);
  return Number.isFinite(demande) ? Math.max(PAUSE_PLANCHER_MS, demande) : PAUSE_PLANCHER_MS;
}

const CHAMP_SESSION = 'session';
const CHAMP_HISTORIQUE = 'historique';

/** Compte sans adresse lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

const MOIS = {
  janvier: '01', février: '02', fevrier: '02', mars: '03', avril: '04',
  mai: '05', juin: '06', juillet: '07', août: '08', aout: '08',
  septembre: '09', octobre: '10', novembre: '11', décembre: '12', decembre: '12',
};

/**
 * Un numéro de commande Amazon : trois groupes de chiffres séparés de tirets.
 * La casse du libellé n'a aucune importance — dans le DOM il est en minuscules,
 * à l'écran en capitales, et c'est la feuille de style qui fait la différence.
 */
const MOTIF_COMMANDE = /N°\s*de\s*commande\s*:?\s*([\d-]{15,25})/i;

/** Adresse d'un document téléchargeable. */
const MOTIF_DOCUMENT = '/documents/download/';

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur Amazon ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à Amazon a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Amazon ». Amazon n\'accepte qu\'une connexion à la fois : vous '
  + 'reconnecter ailleurs invalide celle de crabe.';

/** Ce qu'on dit quand Amazon demande une vérification. Une seule phrase utile. */
const MESSAGE_VERIFICATION =
  'Amazon demande une vérification. Réessayez dans quelques heures.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/** Erreur d'arrêt immédiat : rien ne sert d'insister, ni maintenant ni en boucle. */
function erreurVerification(precision = '') {
  const err = new Error(MESSAGE_VERIFICATION + (precision ? ` (${precision})` : ''));
  err.rateLimited = true;
  return err;
}

/**
 * L'URL courante est-elle une page d'authentification ?
 * Seul le CHEMIN compte : `?ref=ap_signin` sur une page de commandes est
 * parfaitement normal, et le confondre déclarerait expirée une session valide.
 */
function estPageAuthentification(url) {
  let chemin;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return false;
  }
  return /\/(ap\/signin|ap\/mfa|gp\/sign-?in)(\/|$)/i.test(`${chemin}/`);
}

/**
 * Amazon demande-t-il une vérification anti-robot ?
 *
 * Deux signaux, et ils ne se recouvrent pas : l'adresse (`/errors/validateCaptcha`,
 * les pages `cvf`) et le texte de la page, qu'Amazon sert parfois en 200 sur
 * l'URL demandée.
 */
function estVerificationRobot({ url = '', texte = '' } = {}) {
  if (/\/errors\/validateCaptcha|\/ap\/cvf\/|captcha/i.test(String(url))) return true;
  const propre = String(texte).replace(/\s+/g, ' ');
  return /saisissez les caract[èe]res|tapez les caract[èe]res|type the characters/i.test(propre)
    || /vous n[’']?[êe]tes pas un robot|not a robot/i.test(propre);
}

/**
 * Les années exposées par le sélecteur de période.
 *
 * Les options portent un texte « en 2026 » et une valeur technique. On garde le
 * couple, dédoublonné par année : le sélecteur apparaît parfois deux fois dans
 * le document, et parcourir 2026 deux fois doublerait le temps pour rien.
 *
 * Une option sans valeur exploitable retombe sur la convention d'Amazon
 * (`year-2026`) plutôt que d'être perdue.
 *
 * @param {Array<{valeur?: string, texte?: string}>} options
 * @returns {Array<{annee: number, filtre: string}>} décroissant
 */
function anneesDepuisOptions(options) {
  const vues = new Map();
  for (const option of Array.isArray(options) ? options : []) {
    const trouve = /(?:^|\s)(?:en\s+)?((?:19|20)\d\d)\s*$/i.exec(String(option?.texte || '').trim());
    if (!trouve) continue;
    const annee = Number.parseInt(trouve[1], 10);
    if (vues.has(annee)) continue;
    const valeur = String(option?.valeur || '').trim();
    vues.set(annee, { annee, filtre: valeur || `year-${annee}` });
  }
  return [...vues.values()].sort((a, b) => b.annee - a.annee);
}

/** L'adresse d'une page de commandes, pour une année et un rang donnés. */
function urlPage(filtre, page = 0) {
  const index = Math.max(0, page) * PAR_PAGE;
  return `${URL_COMMANDES}?timeFilter=${encodeURIComponent(filtre)}&startIndex=${index}`;
}

/** Le numéro de commande porté par un texte, ou `null`. */
function numeroCommande(texte) {
  const trouve = MOTIF_COMMANDE.exec(String(texte || ''));
  if (!trouve) return null;
  const numero = trouve[1].replace(/-+$/, '');
  return /^\d{3}-\d{7}-\d{7}$/.test(numero) ? numero : numero || null;
}

/**
 * Période d'une commande, en « AAAA-MM ».
 *
 * Deux formes rencontrées sur la même page :
 *
 *   « commande effectuée le 14 juillet 2026 »   → 2026-07
 *   une date française isolée : « 14 juillet 2026 » → 2026-07
 *
 * La première est essayée d'abord : une carte peut porter plusieurs dates
 * (livraison, retour possible jusqu'au…), et c'est celle de la COMMANDE qui
 * date la facture.
 */
function periodeDepuisTexte(texte) {
  const propre = String(texte || '').replace(/\s+/g, ' ').toLowerCase();
  const mois = Object.keys(MOIS).join('|');

  // `\S*` et non `\w*` : « effectuée » porte un accent, et `\w` ne matche que
  // l'ASCII en JavaScript — le motif s'arrêtait net avant le « é ».
  const commande = new RegExp(`command\\S*\\s+effectu\\S*\\s+le\\s+\\d{1,2}\\s+(${mois})\\s+(\\d{4})`)
    .exec(propre);
  if (commande) return `${commande[2]}-${MOIS[commande[1]]}`;

  const isolee = new RegExp(`\\b\\d{1,2}\\s+(${mois})\\s+(\\d{4})\\b`).exec(propre);
  return isolee ? `${isolee[2]}-${MOIS[isolee[1]]}` : null;
}

/**
 * Montant total d'une commande, en euros, ou `null`.
 *
 * Amazon écrit « 106,52 € » ou « 1 240,00 € ». On ne retient QUE ce qui suit un
 * libellé de total : une carte porte aussi des prix d'articles, et prendre le
 * premier montant venu daterait la facture du prix d'une brosse à dents.
 */
function montantDepuisTexte(texte) {
  const propre = String(texte || '').replace(/\s+/g, ' ');
  const trouve = /total\s*(?:de la commande)?\s*:?\s*([\d  ]+(?:[.,]\d{1,2})?)\s*€/i.exec(propre);
  if (!trouve) return null;
  const nombre = Number.parseFloat(trouve[1].replace(/[  ]/g, '').replace(',', '.'));
  return Number.isFinite(nombre) ? nombre : null;
}

/**
 * Ce qu'est une entrée du menu flottant.
 *
 * @param {string} libelle
 * @returns {{type: 'facture'|'avoir'|'ignore', rang: number|null}}
 */
function typeDocument(libelle) {
  const propre = String(libelle || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // « Récapitulatif de commande imprimable » n'est pas une facture : c'est un
  // résumé de page web, sans valeur comptable. Testé d'abord, parce qu'il
  // contient parfois le mot « commande » et jamais le mot « facture ».
  if (/r[ée]capitulatif/.test(propre)) return { type: 'ignore', rang: null };
  if (/note de cr[ée]dit|avoir\b/.test(propre)) return { type: 'avoir', rang: null };

  const facture = /^facture\s*(\d+)?$/.exec(propre);
  if (facture) return { type: 'facture', rang: facture[1] ? Number(facture[1]) : null };

  // Un libellé inconnu ne devient pas une facture par défaut : on l'ignore, et
  // le journal le dira.
  return { type: 'ignore', rang: null };
}

/**
 * Classe les documents d'UNE commande, et leur donne leur rang.
 *
 * Le rang déclaré par Amazon fait foi quand il existe (« Facture 2 ») ; sinon
 * c'est l'ordre d'apparition. C'est lui, et lui seul, qui rend un document
 * identifiable d'une exécution à l'autre — les UUID, eux, changent.
 *
 * @param {Array<{libelle: string, href: string}>} entrees
 * @returns {Array<{libelle, href, type, rang, suffixe, plusieurs}>}
 */
function classerDocuments(entrees) {
  const retenus = [];
  let vuesFactures = 0;
  let vusAvoirs = 0;

  for (const entree of Array.isArray(entrees) ? entrees : []) {
    const { type, rang } = typeDocument(entree?.libelle);
    if (type === 'ignore') continue;
    if (type === 'facture') {
      vuesFactures += 1;
      retenus.push({ ...entree, type, rang: rang || vuesFactures });
    } else {
      vusAvoirs += 1;
      retenus.push({ ...entree, type, rang: vusAvoirs });
    }
  }

  const plusieurs = retenus.filter((d) => d.type === 'facture').length > 1;
  return retenus.map((doc) => ({
    ...doc,
    plusieurs,
    suffixe: doc.type === 'avoir' ? (doc.rang > 1 ? `avoir${doc.rang}` : 'avoir') : String(doc.rang),
  }));
}

/**
 * La référence stable d'un document : numéro de commande + rang.
 *
 * **Jamais l'UUID.** C'est le piège majeur de ce connecteur : Amazon régénère
 * l'identifiant du PDF à chaque ouverture du menu, et une déduplication fondée
 * dessus retéléchargerait tout, à chaque exécution, indéfiniment.
 */
function remoteIdPour(numero, doc) {
  return `${numero}#${doc.suffixe}`;
}

/** « 2026-07 » + un document → le nom du fichier déposé. */
function nomFichier(periode, numero, doc) {
  const base = `${periode || 'inconnu'}_${numero}`;
  if (doc.type === 'avoir') return `${base}_${doc.suffixe}.pdf`;
  return doc.plusieurs ? `${base}_${doc.rang}.pdf` : `${base}.pdf`;
}

/**
 * Les liens apparus entre deux photographies de la page.
 *
 * C'est **la** méthode de rattachement : le menu est flottant, hors de la carte
 * dans le DOM, et remonter l'arbre ne relie rien. Ce qui n'était pas là avant
 * d'ouvrir CE menu appartient à CETTE commande.
 *
 * @param {Array<{href: string}>} avant
 * @param {Array<{href: string}>} apres
 */
function nouveauxLiens(avant, apres) {
  const connus = new Set((avant || []).map((l) => l?.href).filter(Boolean));
  const vus = new Set();
  return (apres || []).filter((lien) => {
    const href = lien?.href;
    if (!href || connus.has(href) || vus.has(href)) return false;
    vus.add(href);
    return true;
  });
}

/**
 * Une page vide est-elle une année sans commande, ou une limitation d'accès ?
 *
 * Le cas observé : trois parcours complets en peu de temps, puis une page qui
 * se charge normalement mais sans aucune commande, en 38 secondes au lieu de
 * 123. Rien dans la page ne le dit — ni erreur, ni message.
 *
 * Deux signaux honnêtes, et aucun devin :
 *
 *   - le compte a DÉJÀ livré des documents lors d'exécutions précédentes, et
 *     cette fois le parcours entier n'en trouve aucun ;
 *   - trois années ou plus parcourues sans la moindre commande, sur un compte
 *     que quelqu'un a pris la peine de connecter.
 *
 * Renvoie une phrase pour le journal, ou `null` s'il n'y a rien à signaler.
 *
 * @returns {string|null}
 */
function silenceAnormal({ commandesVues = 0, anneesParcourues = 0, dejaConnues = 0 } = {}) {
  if (commandesVues > 0 || anneesParcourues === 0) return null;

  if (dejaConnues > 0) {
    return `aucune commande trouvée sur ${anneesParcourues} année(s) alors que `
      + `${dejaConnues} document(s) ont déjà été récupérés sur ce compte — c'est le signe `
      + 'd\'une limitation d\'accès d\'Amazon, pas d\'un compte vide. Réessayez dans quelques heures.';
  }

  if (anneesParcourues >= 3) {
    return `aucune commande trouvée sur ${anneesParcourues} années consécutives — c'est `
      + 'inhabituel pour un compte qu\'on vient de connecter, et cela ressemble à une '
      + 'limitation d\'accès d\'Amazon. Réessayez dans quelques heures.';
  }

  return null;
}

/** Contrôle de la connexion enregistrée avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

/** L'adresse du compte, si la page la porte. Sinon « compte ». */
function compteDepuisTexte(texte) {
  const trouve = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(String(texte || ''));
  return trouve ? trouve[0].toLowerCase() : COMPTE_PAR_DEFAUT;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la connexion enregistrée et passe la main.
 *
 * Deux précautions posées ici, une fois pour toutes :
 *
 *   - `page.route(… /documents/download/ …, abort)` : un clic sur un document
 *     ouvre le PDF dans le MÊME onglet et fait perdre la liste. Les
 *     téléchargements, eux, passent par `context.request`, que cette règle ne
 *     touche pas ;
 *   - `locale: 'fr-FR'` : les libellés du menu — « Facture », « Note de
 *     crédit », « Récapitulatif de commande imprimable » — sont ceux du site
 *     français, et c'est sur eux que tout ce fichier s'appuie.
 */
async function surLeCompte(config, fn) {
  const session = lireSession(config);

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : voir connectors/browser-identity.js.
  const context = await browser.newContext(
    identity.optionsContexte({ storageState: session, viewport: VIEWPORT, locale: LOCALE })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  await page.route(`**${MOTIF_DOCUMENT}**`, (route) => route.abort()).catch(() => {});

  try {
    await aller(page, URL_COMMANDES);
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Va sur une page et contrôle qu'on est bien arrivé quelque part d'utile.
 *
 * Les deux refus possibles sont traités ici, et pas plus loin : une session
 * tombée (redirection vers la connexion) et une vérification anti-robot.
 * Continuer après l'un ou l'autre ne ferait qu'aggraver la limitation.
 */
async function aller(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('redirection vers la page de connexion');
  }

  const texte = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
  if (estVerificationRobot({ url: page.url(), texte })) throw erreurVerification();

  return texte;
}

/** Les années proposées par le sélecteur de période, dédoublonnées. */
async function anneesDisponibles(page, log = () => {}) {
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('select option, [role="option"]')].map((el) => ({
      valeur: el.getAttribute('value') || el.getAttribute('data-value') || '',
      texte: (el.textContent || '').trim(),
    }))
  );

  const annees = anneesDepuisOptions(options);
  log(
    annees.length
      ? `amazon : ${annees.length} année(s) proposée(s) par le sélecteur de période `
        + `(${annees[annees.length - 1].annee} à ${annees[0].annee})`
      : 'amazon : aucune année lisible dans le sélecteur de période'
  );
  return annees;
}

/**
 * Les commandes d'une page, et le déclencheur de leur menu de documents.
 *
 * Tout se fait en une seule passe dans le document, parce que les trois
 * informations qu'on cherche vivent à trois hauteurs différentes de l'arbre :
 * le numéro dans le nœud le plus profond, la date et le montant dans l'en-tête
 * au-dessus, le lien « Facture » quelque part entre les deux.
 *
 * Le résultat est MARQUÉ dans le DOM (`data-crabe-declencheur`) : c'est le seul
 * moyen de recliquer ensuite un élément précis depuis Node sans réécrire toute
 * la recherche en sélecteurs Playwright.
 */
async function commandesDeLaPage(page) {
  return page.evaluate(() => {
    const MOTIF = /N°\s*de\s*commande\s*:?\s*([\d-]{15,25})/gi;
    const compter = (el) => ((el.textContent || '').match(MOTIF) || []).length;

    // Les conteneurs qui portent UN SEUL numéro, et parmi eux les plus profonds
    // — ceux qui n'en contiennent pas d'autre.
    const uniques = [...document.querySelectorAll('div,li,section,article,span,p')]
      .filter((el) => compter(el) === 1);
    const ensemble = new Set(uniques);
    const cartes = uniques.filter(
      (el) => ![...el.querySelectorAll('*')].some((enfant) => ensemble.has(enfant))
    );

    const numeroDe = (el) => {
      const trouve = /N°\s*de\s*commande\s*:?\s*([\d-]{15,25})/i.exec(el.textContent || '');
      return trouve ? trouve[1].replace(/-+$/, '') : null;
    };

    const sortie = [];
    const vus = new Set();
    const declencheursPris = new Set();

    for (const carte of cartes) {
      const numero = numeroDe(carte);
      if (!numero || vus.has(numero)) continue;
      vus.add(numero);

      // a. Le contexte : on remonte jusqu'à six niveaux pour trouver la date et
      //    le montant, en s'arrêtant dès qu'un ancêtre engloberait une autre
      //    commande.
      let contexte = carte;
      for (let i = 0; i < 6 && contexte.parentElement; i++) {
        if (compter(contexte.parentElement) > 1) break;
        contexte = contexte.parentElement;
      }

      // b. Le déclencheur : un lien dont le texte est exactement « Facture ».
      //    D'abord dans la carte, puis en remontant jusqu'à cinq ancêtres, en
      //    s'arrêtant avant d'englober une autre commande. Un déclencheur déjà
      //    attribué ne peut plus l'être à une autre commande.
      const chercher = (racine) =>
        [...racine.querySelectorAll('a')].find(
          (a) => (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'facture'
            && !declencheursPris.has(a)
        ) || null;

      let declencheur = chercher(carte);
      let noeud = carte;
      for (let i = 0; !declencheur && i < 5 && noeud.parentElement; i++) {
        if (compter(noeud.parentElement) > 1) break;
        noeud = noeud.parentElement;
        declencheur = chercher(noeud);
      }
      if (declencheur) {
        declencheursPris.add(declencheur);
        declencheur.setAttribute('data-crabe-declencheur', numero);
      }

      sortie.push({
        numero,
        texte: (contexte.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        aUnMenu: !!declencheur,
      });
    }

    return sortie;
  });
}

/** Tous les liens de document présents à cet instant. */
async function liensPresents(page) {
  return page.evaluate(
    (motif) =>
      [...document.querySelectorAll(`a[href*="${motif}"]`)].map((a) => ({
        href: a.href,
        libelle: (a.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
    MOTIF_DOCUMENT
  );
}

/**
 * Ouvre le menu d'une commande et retient ce qui vient d'apparaître.
 *
 * L'attente est ACTIVE : le menu est peuplé en JavaScript, et une pause fixe
 * serait soit trop courte (documents manqués) soit trop longue (multipliée par
 * douze commandes et quinze années). On sort dès que quelque chose apparaît.
 */
async function documentsDeLaCommande(page, numero) {
  const avant = await liensPresents(page);
  const bouton = page.locator(`[data-crabe-declencheur="${numero}"]`).first();
  if (!(await bouton.count())) return [];

  await bouton.click({ timeout: 5000 }).catch(() => {});

  const limite = Date.now() + DELAI_MENU_MS;
  let nouveaux = [];
  for (;;) {
    nouveaux = nouveauxLiens(avant, await liensPresents(page));
    if (nouveaux.length || Date.now() >= limite) break;
    await page.waitForTimeout(250);
  }

  // Refermer, et revenir si le clic a malgré tout fait naviguer : la liste des
  // commandes est notre seul point d'appui, on ne la perd pas.
  await page.keyboard.press('Escape').catch(() => {});
  return nouveaux;
}

/**
 * Parcourt une année, page par page, et rend ses commandes.
 *
 * On s'arrête quand une page ne rend plus aucune commande — c'est le signal
 * d'Amazon, il n'y a pas de compteur fiable ailleurs.
 */
async function commandesDeLAnnee(page, annee, { log = () => {}, pauseMs, aPause }) {
  const commandes = [];

  for (let index = 0; index < MAX_PAGES_PAR_ANNEE; index++) {
    if (index > 0 || aPause) await page.waitForTimeout(pauseMs);
    await aller(page, urlPage(annee.filtre, index));

    const lot = await commandesDeLaPage(page);
    if (!lot.length) {
      log(
        `amazon : ${annee.annee} — page ${index + 1} sans commande, fin du parcours de l'année`
      );
      break;
    }

    for (const commande of lot) {
      const documents = commande.aUnMenu
        ? classerDocuments(await documentsDeLaCommande(page, commande.numero))
        : [];
      if (!commande.aUnMenu) {
        log(`amazon : commande ${commande.numero} — aucun lien « Facture » sur la carte, ignorée`);
      }
      commandes.push({
        numero: commande.numero,
        annee: annee.annee,
        periode: periodeDepuisTexte(commande.texte),
        montant: montantDepuisTexte(commande.texte),
        documents,
      });
    }

    log(
      `amazon : ${annee.annee} — page ${index + 1}, ${lot.length} commande(s), `
        + `${commandes.reduce((n, c) => n + c.documents.length, 0)} document(s) au total`
    );
    if (lot.length < PAR_PAGE) break; // dernière page de l'année
  }

  return commandes;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : la connexion est-elle encore acceptée ?
 *
 * Une seule page, aucun menu ouvert, aucun téléchargement — quelques secondes,
 * et surtout aucune sollicitation qui compterait dans la limitation d'Amazon.
 */
async function test(config, ctx = {}) {
  return surLeCompte(config, async (page) => {
    const texte = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
    const annees = await anneesDisponibles(page, ctx.log);
    const compte = compteDepuisTexte(texte);

    return {
      ok: true,
      accountId: compte,
      invoiceCount: undefined,
      message:
        'Connexion valide'
        + (compte !== COMPTE_PAR_DEFAUT ? ` — compte ${compte}` : '')
        + (annees.length
          ? ` · ${annees.length} année(s) de commandes, de ${annees[annees.length - 1].annee} `
            + `à ${annees[0].annee}`
          : ' · aucune année de commandes lisible'),
    };
  });
}

/**
 * Récupère les factures des années retenues.
 *
 * Le téléchargement passe par le contexte authentifié (`context.request`) et
 * non par un clic : plus fiable, et la règle qui annule les navigations vers
 * les documents ne s'y applique pas.
 *
 * **Reprise :** les documents déjà récupérés sont connus (`ctx.knownRemoteIds`)
 * et ne sont ni rouverts ni retéléchargés. Une exécution interrompue reprend
 * donc là où elle en est, sans tout recommencer — c'est la contrepartie
 * indispensable d'un parcours qui peut durer une demi-heure.
 */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const pauseMs = pauseEntrePages();

  return surLeCompte(config, async (page, context) => {
    const texteAccueil = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
    const compte = compteDepuisTexte(texteAccueil);
    const disponibles = await anneesDisponibles(page, log);

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles: disponibles.map((a) => a.annee),
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      // Le plafond de conservation, posé par le socle (lot 26) : sans lui, ce
      // connecteur parcourait quinze années pour que l'entretien de la nuit en
      // efface la moitié. Il vaut 0 — aucun plafond — tant qu'un plancher
      // protège l'existant, ce qui est le cas courant.
      plafondMois: ctx?.conservationMois || 0,
    });
    const aParcourir = disponibles.filter((a) => plan.annees.includes(a.annee));

    log(
      `amazon : historique « ${plan.mode} » — ${plan.raison} ; `
        + `${aParcourir.length} année(s) à parcourir, ${connus.size} document(s) déjà récupérés`
    );

    const invoices = [];
    let commandesVues = 0;
    let anneesParcourues = 0;

    for (const annee of aParcourir) {
      const commandes = await commandesDeLAnnee(page, annee, {
        log,
        pauseMs,
        aPause: anneesParcourues > 0,
      });
      anneesParcourues += 1;
      commandesVues += commandes.length;

      for (const commande of commandes) {
        for (const doc of commande.documents) {
          const remoteId = remoteIdPour(commande.numero, doc);
          if (connus.has(remoteId)) continue;

          const res = await context.request
            .get(doc.href, { timeout: NAV_TIMEOUT_MS })
            .catch(() => null);
          if (!res || !res.ok()) {
            // Identifiant TRONQUÉ (règle du projet, lot 31) : jamais entier au journal.
            log(
              `amazon : ${pageDocs.idPourJournal(remoteId)} — HTTP `
                + `${res ? res.status() : 'sans réponse'}, ignoré pour `
                + 'cette fois ; il sera repris à la prochaine exécution'
            );
            continue;
          }

          const buffer = Buffer.from(await res.body());
          if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
            // Un HTML à la place d'un PDF, c'est la page de connexion : la
            // session vient de tomber. Inutile de continuer les autres années.
            throw erreurSessionExpiree(
              `réponse non-PDF pour ${pageDocs.idPourJournal(remoteId)} (${buffer.length} o)`
            );
          }

          connus.add(remoteId);
          invoices.push({
            accountId: compte,
            remoteId,
            filename: nomFichier(commande.periode, commande.numero, doc),
            issuedOn: commande.periode ? `${commande.periode}-01` : null,
            amount: commande.montant,
            buffer,
          });
        }
      }
    }

    // Une page qui se charge sans commande n'est pas forcément une année vide :
    // c'est le symptôme observé d'une limitation d'accès. On le DIT, plutôt que
    // de conclure à tort que le compte est vide.
    const alerte = silenceAnormal({
      commandesVues,
      anneesParcourues,
      dejaConnues: (ctx.knownRemoteIds || []).length,
    });
    if (alerte) log(`amazon : ${alerte}`);

    // Preuve d'accès (lot 31), déposée seulement si des commandes ont bien été
    // affichées : elles n'existent que connecté. Zéro commande vue, c'est le
    // silence anormal ci-dessus — sans preuve, le socle refusera de conclure
    // « aucune nouvelle facture », et c'est exactement ce qu'on veut.
    if (commandesVues > 0) {
      ctx.preuveDeListe?.({
        session: `${commandesVues} commande(s) affichée(s) dans l'espace client`,
        liste: `historique des commandes Amazon (${anneesParcourues} année(s) parcourue(s))`,
        elements: commandesVues,
      });
    }

    log(
      `amazon : ${anneesParcourues} année(s) parcourue(s), ${commandesVues} commande(s), `
        + `${invoices.length} document(s) récupéré(s)`
    );

    return { accountId: compte, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  estVerificationRobot,
  anneesDepuisOptions,
  urlPage,
  numeroCommande,
  periodeDepuisTexte,
  montantDepuisTexte,
  typeDocument,
  classerDocuments,
  remoteIdPour,
  nomFichier,
  nouveauxLiens,
  silenceAnormal,
  compteDepuisTexte,
  pauseEntrePages,
  erreurSessionExpiree,
  erreurVerification,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_VERIFICATION,
  MOTIF_COMMANDE,
  URL_COMMANDES,
  PAR_PAGE,
  PAUSE_PLANCHER_MS,
  DELAI_MENU_MS,
  COMPTE_PAR_DEFAUT,
};
