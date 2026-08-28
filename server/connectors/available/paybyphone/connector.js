'use strict';

/**
 * Connecteur PayByPhone — stationnement payé depuis le mobile.
 *
 * **LE CONNECTEUR LE MOINS VÉRIFIÉ DU DÉPÔT, et il faut le savoir en le
 * lisant.** La connexion est mesurée au caractère près ; **tout ce qui vient
 * après ne l'est pas**. Aucun compte n'a servi à écrire ce fichier. D'où
 * `initialStatus: pending` : installable par l'administrateur seul, invisible pour les
 * autres, jusqu'à ce qu'un vrai relevé soit descendu.
 *
 * ─── Ce n'est PAS le site qu'on croit ────────────────────────────────────────
 *
 * `m.paybyphone.com` — l'application que tout le monde connaît — est un
 * cul-de-sac pour un robot. C'est une application Flutter dont l'interface est
 * DESSINÉE, pas écrite en HTML, et elle est gardée par HUMAN Security
 * (ex-PerimeterX) doublé d'un reCAPTCHA invisible. Elle **ne s'affiche jamais**
 * dans un navigateur automatisé : mesuré quatre fois en production, en mode
 * invisible et en mode visible sous Xvfb, avec et sans le filtre DNS de la
 * maison. À chaque fois, après une minute : zone graphique vide, zéro
 * caractère de texte, zéro champ.
 *
 * Et ce n'était pas la sonde : aucune réponse HTTP en erreur, `canvaskit.wasm`
 * en 200, `window.flutterCanvasKit` présent, aucune erreur JavaScript. Le
 * moteur graphique est chargé, prêt — et il ne dessine rien.
 *
 * **Le vrai point d'entrée est ailleurs**, et l'aide officielle y mène : un
 * PORTAIL DE REÇUS, intégré dans une page de paybyphone.fr sous forme de
 * cadre :
 *
 *   <iframe src="https://secure.paybyphone.fr/consumersite/login.aspx">
 *
 * Un vieil ASP.NET WebForms sur jQuery 1.7.2, **sans le moindre dispositif
 * anti-robot** : zéro occurrence de turnstile, recaptcha, datadome ou
 * perimeterx dans la page ; trois cookies, tous techniques.
 *
 * ─── Pourquoi on CLIQUE ici, alors qu'on presse Entrée chez Materiel.net ─────
 *
 * Ce n'est pas une incohérence, c'est la même règle sur deux pages différentes :
 * **on désigne le contrôle qui porte la donnée décisive, jamais « le premier
 * bouton ».**
 *
 * En ASP.NET WebForms, le couple nom/valeur du bouton
 * (`ctl00$MainContent$LoginButton=se connecter`) doit partir avec le POST pour
 * que le serveur sache quel contrôle a déclenché la soumission. Entrée ne le
 * garantit pas. Et cliquer est **sans risque ici** : la page ne contient
 * AUCUNE balise `<button>` (vérifié) et un seul `input[type=submit]`. Chez
 * Materiel.net, à l'inverse, l'œil du mot de passe est un `<button>` écrit
 * AVANT celui d'envoi — d'où la touche Entrée là-bas.
 *
 * ─── Ce qu'on récupère, et pourquoi ce n'est pas ce qu'on croirait ───────────
 *
 * Le centre d'aide officiel tranche, et il faut le citer :
 *
 *   « Puis-je recevoir une facture mensuelle ? **Non.** Les factures mensuelles
 *     ne sont pas disponibles. »
 *
 *   « Exporter votre historique de stationnement — Portail des reçus :
 *     1. Connectez-vous. 2. Sélectionnez **Transactions de stationnement**.
 *     3. Choisissez une **période (jusqu'à 31 jours)**. 4. **Téléchargez en PDF
 *     ou CSV.** »
 *
 * Donc : **un relevé de période, en PDF, par mois civil**. Pas de reçu par
 * stationnement — celui-là existe, mais il arrive par COURRIEL, et crabe n'est
 * pas un connecteur de boîte aux lettres.
 *
 * **Le mois en cours est écarté**, toujours. Un relevé d'août produit le 14 août
 * serait incomplet ; son identifiant étant déjà connu, il ne serait jamais
 * regénéré, et les stationnements du 15 au 31 disparaîtraient de tout document.
 * C'est la leçon du relevé reconstitué de Bitstamp.
 *
 * ─── Comment ce fichier assume de ne pas savoir ──────────────────────────────
 *
 * La structure du portail après connexion n'a **jamais été vue**, et une sonde
 * de routes a été tentée puis **jetée** : ASP.NET redirige vers le formulaire
 * toute adresse sous `/consumersite/`, y compris une adresse impossible. Elle ne
 * prouvait rien.
 *
 * Le connecteur **découvre** donc au lieu de supposer : il cherche le lien des
 * transactions, puis les contrôles de période et de téléchargement. Et quand il
 * ne trouve pas, **il écrit au journal ce qu'il a vu** — les liens, les champs,
 * les boutons. La première exécution réelle sera ainsi diagnosticable du premier
 * coup, au lieu de trois passages à l'aveugle.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const identity = require('../../browser-identity');
const history = require('../../history');
const profilPersistant = require('../../profil-persistant');

/** L'identifiant du connecteur — il nomme aussi son répertoire de profil. */
const ID = 'paybyphone';

const URL_CONNEXION = 'https://secure.paybyphone.fr/consumersite/login.aspx';
const RACINE_PORTAIL = 'https://secure.paybyphone.fr/consumersite/';

const VIEWPORT = { width: 1400, height: 950 };
const NAV_TIMEOUT_MS = 45_000;
const PAUSE_DOCUMENT_MS = 500;

const CHAMP_NUMERO = 'numeroMobile';
const CHAMP_MOT_DE_PASSE = 'motDePasse';
const CHAMP_INDICATIF = 'indicatif';
const CHAMP_HISTORIQUE = 'historique';

/**
 * Les indicatifs, tels que la liste déroulante du portail les numérote.
 *
 * Relevés dans le HTML servi le 13/08/2026 : la France vaut « 5 ». ⚠ L'option
 * « -3 » qui porte aussi « France » n'est que le raccourci en tête de liste,
 * pas une vraie valeur — la choisir ne sélectionnerait rien.
 *
 * On sélectionne par le LIBELLÉ plutôt que par ce nombre (voir
 * `choisirIndicatif`) : un numéro d'option est un détail de mise en page, un
 * libellé est ce que le site montre. Ces valeurs ne servent que de repli.
 */
const INDICATIFS = {
  France: { valeur: '5', libelle: 'France - 33' },
  Belgique: { valeur: null, libelle: 'Belgique - 32' },
  Suisse: { valeur: null, libelle: 'Suisse - 41' },
  Monaco: { valeur: null, libelle: 'Monaco - 377' },
  'Royaume-Uni': { valeur: null, libelle: 'Royaume-Uni - 44' },
};
const INDICATIF_PAR_DEFAUT = 'France';

/** Compte sans numéro lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/** Le lien qui mène aux transactions, cherché par ce que l'aide en dit. */
const MOTIF_LIEN_TRANSACTIONS = /transaction|stationnement|parking|historique|activit/i;

/** Un contrôle qui télécharge, et le format qu'il produit. */
const MOTIF_TELECHARGEMENT_PDF = /\bpdf\b/i;

/**
 * Les deux champs de période — et pourquoi chacun porte `:visible`.
 *
 * ─── Le défaut que ce filtre corrige, mesuré le 27/08/2026 ───────────────────
 *
 * Sans lui, le sélecteur était :
 *
 *     'input[type="date"], input[id*="ate" i], input[name*="ate" i]'
 *
 * `input[id*="ate" i]` est une recherche de SOUS-CHAÎNE, et ASP.NET WebForms
 * nomme ses champs cachés `__VIEWSTATE`, `__VIEWSTATEGENERATOR`,
 * `__VIEWSTATEENCRYPTED` — tous porteurs de « …ST**ATE** ». Relevé sur la vraie
 * page `tranrpt1.aspx`, le sélecteur attrapait SIX éléments dans cet ordre :
 *
 *     [0] __VIEWSTATE                                    type=hidden
 *     [1] ctl00_MainContent_GridDisplaySelectionState    type=hidden
 *     [2] ctl00_MainContent_recent_start_date            VISIBLE  ← le vrai début
 *     [3] ctl00_MainContent_recent_end_date              VISIBLE  ← la vraie fin
 *     [4] __VIEWSTATEGENERATOR                           type=hidden
 *     [5] __VIEWSTATEENCRYPTED                           type=hidden
 *
 * Or la fonction écrit dans `nth(0)` et `nth(1)` : elle visait `__VIEWSTATE` et
 * `GridDisplaySelectionState`, **jamais les deux vrais champs**. Et `fill()`
 * attend qu'un élément devienne visible — un `type=hidden` ne le devient
 * jamais : 45 s d'attente, puis 45 s pour la seconde écriture du `.catch`,
 * pour chacun des deux, soit 180 s par mois à ne rien régler du tout.
 * Avec le délai du téléchargement, 225 s par mois × 19 mois = les
 * **71 minutes** que les trois exécutions de ce connecteur ont mises, à la
 * seconde près, sans jamais écrire une ligne de journal.
 *
 * ⚠ Le filtre ne fait pas que gagner du temps, il REND AU CONNECTEUR SON
 * DIAGNOSTIC. Les quatre champs cachés lui faisaient croire qu'il avait trouvé
 * « au moins deux champs de date » : la garde `nombre < 2`, juste en dessous,
 * ne pouvait pas se déclencher, et c'est pour ça que 71 minutes se sont
 * écoulées en silence complet. Une page qui n'offrirait plus de période le
 * dira désormais dès le premier mois.
 *
 * Ce lot ne corrige QUE cela. Savoir si le portail sert ensuite un PDF n'a
 * jamais été mesuré — aucune des trois exécutions n'en a rapporté un seul —
 * et cela reste à établir sur pièces, pas à deviner ici.
 */
const SELECTEUR_CHAMPS_DATE = [
  'input[type="date"]:visible',
  'input[id*="ate" i]:visible',
  'input[name*="ate" i]:visible',
].join(', ');

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Le navigateur nécessaire à PayByPhone n\'est pas installé sur ce serveur. '
        + 'Signalez-le à la personne qui administre crabe.'
    );
  }
}

const MESSAGE_SESSION_EXPIREE =
  'La connexion au portail PayByPhone n\'a pas pu être rouverte. Vérifiez votre numéro de mobile '
  + 'et votre mot de passe sur la fiche du service, puis relancez. crabe ne réessaie jamais tout '
  + 'seul : insister sur un formulaire de connexion peut rendre le portail inaccessible même à '
  + 'la main.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

const MESSAGE_IDENTIFIANTS =
  'Numéro de mobile ou mot de passe refusé par PayByPhone. Vérifiez-les sur la fiche du service. '
  + 'Si vous ne vous êtes jamais connecté sur ordinateur, refaites votre mot de passe depuis '
  + '« Réinitialiser le mot de passe » sur la page de connexion du portail, puis relancez. crabe '
  + 'ne réessaie jamais tout seul.';

function erreurIdentifiants(precision = '') {
  const err = new Error(MESSAGE_IDENTIFIANTS + (precision ? ` (${precision})` : ''));
  err.credentialsRejected = true;
  return err;
}

function erreurIdentifiantsManquants() {
  return new Error(
    'Renseignez votre numéro de mobile et votre mot de passe PayByPhone sur la fiche du service.'
  );
}

/**
 * Le numéro de mobile, débarrassé de ce que le portail n'attend pas.
 *
 * Le champ du site est un simple champ texte sans indicatif : celui-ci se
 * choisit dans la liste déroulante d'à côté. On retire donc espaces, points,
 * tirets, et le zéro de tête d'un numéro français écrit « 06… » — le site
 * attend « 6… » puisque l'indicatif est déjà porté par la liste.
 *
 * On ne retire PAS un « +33 » collé devant : ce serait deviner le pays à la
 * place de l'utilisateur, qui l'a déjà choisi dans le champ prévu. On le laisse
 * partir tel quel, et le portail dira qu'il ne le reconnaît pas — un refus
 * lisible vaut mieux qu'une correction silencieuse et fausse.
 */
function numeroPourLeSite(brut) {
  const propre = String(brut || '').replace(/[\s.\-()]/g, '');
  return propre.replace(/^0(?=\d)/, '');
}

/** Le pays choisi sur la fiche, ramené à une entrée connue. */
function indicatifChoisi(config = {}) {
  const demande = String(config?.[CHAMP_INDICATIF] || '').trim();
  return INDICATIFS[demande] ? demande : INDICATIF_PAR_DEFAUT;
}

/**
 * Les mois civils RÉVOLUS d'une fenêtre d'années.
 *
 * Le mois en cours est écarté, et ce n'est pas un détail : un relevé d'août
 * produit le 14 août serait incomplet, et comme son identifiant serait déjà
 * connu il ne serait jamais regénéré — les stationnements du 15 au 31
 * disparaîtraient de tout document.
 *
 * @param {number[]} annees années à couvrir ; vide = les douze derniers mois
 * @param {Date} maintenant
 * @returns {Array<{annee: number, mois: number, debut: string, fin: string}>}
 *   du plus récent au plus ancien
 */
function moisRevolus(annees, maintenant = new Date()) {
  const anneeCourante = maintenant.getUTCFullYear();
  const moisCourant = maintenant.getUTCMonth() + 1;

  // Aucune année imposée : les douze derniers mois révolus, ce que le portail
  // conserve d'après son aide.
  let cibles = Array.isArray(annees) && annees.length ? [...annees] : null;
  if (!cibles) {
    cibles = [];
    for (let recul = 1; recul <= 12; recul++) {
      const d = new Date(Date.UTC(anneeCourante, moisCourant - 1 - recul, 1));
      const cle = d.getUTCFullYear();
      if (!cibles.includes(cle)) cibles.push(cle);
    }
  }

  const sortie = [];
  for (const annee of [...new Set(cibles)].sort((a, b) => b - a)) {
    for (let mois = 12; mois >= 1; mois--) {
      // Strictement révolu : le mois en cours et tout futur sont écartés.
      if (annee > anneeCourante) continue;
      if (annee === anneeCourante && mois >= moisCourant) continue;
      const dernier = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
      sortie.push({
        annee,
        mois,
        debut: `${annee}-${String(mois).padStart(2, '0')}-01`,
        fin: `${annee}-${String(mois).padStart(2, '0')}-${String(dernier).padStart(2, '0')}`,
      });
    }
  }
  return sortie;
}

/** La référence stable d'un relevé : son mois. */
function remoteIdPour(annee, mois) {
  return `releve-${annee}-${String(mois).padStart(2, '0')}`;
}

/** Nom du fichier déposé : `AAAA-MM_stationnement.pdf`. */
function nomFichier(annee, mois) {
  return `${annee}-${String(mois).padStart(2, '0')}_stationnement.pdf`;
}

/** Le dossier du compte : le numéro tel que l'utilisateur l'a écrit. */
function compteDepuisConfig(config = {}) {
  const numero = String(config?.[CHAMP_NUMERO] || '').replace(/[^\d+]/g, '');
  return numero || COMPTE_PAR_DEFAUT;
}

/** Une adresse est-elle celle d'une page de connexion du portail ? */
function estPageConnexion(url) {
  const texte = String(url || '');
  let cible;
  try {
    const analysee = new URL(texte);
    cible = `${analysee.pathname}${analysee.search}`;
  } catch {
    cible = texte;
  }
  return /login\.aspx|\/login\b|signin/i.test(cible);
}

/** Ce lien mène-t-il aux transactions ? */
function estLienTransactions({ texte, url }) {
  return MOTIF_LIEN_TRANSACTIONS.test(String(texte || ''))
    || MOTIF_LIEN_TRANSACTIONS.test(String(url || ''));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Le premier élément qui existe, sélecteur par sélecteur, dans l'ordre écrit.
 *
 * ⚠ Jamais `page.locator(union).first()`, qui rend le premier élément dans
 * l'ORDRE DU DOM : la priorité écrite ne serait alors qu'un commentaire.
 */
async function premierPresent(page, selecteurs) {
  for (const selecteur of selecteurs) {
    try {
      const candidat = page.locator(selecteur).first();
      if (await candidat.count()) return candidat;
    } catch {
      /* sélecteur inutilisable ici */
    }
  }
  return null;
}

/**
 * Choisit le pays du numéro dans la liste déroulante.
 *
 * Par le LIBELLÉ d'abord : un numéro d'option est un détail de mise en page qui
 * peut changer d'un déploiement à l'autre, un libellé est ce que le site montre
 * à l'utilisateur. La valeur relevée ne sert que de repli.
 */
async function choisirIndicatif(page, pays, log) {
  const liste = await premierPresent(page, [
    '#CallingCodeDropDownList',
    'select[name$="CallingCodeDropDownList"]',
    'select',
  ]);
  if (!liste) return false;

  const { valeur, libelle } = INDICATIFS[pays] || INDICATIFS[INDICATIF_PAR_DEFAUT];

  const parLibelle = await liste.selectOption({ label: libelle }).then(() => true).catch(() => false);
  if (parLibelle) {
    log(`paybyphone : pays du numéro réglé sur « ${libelle} ».`);
    return true;
  }
  if (valeur) {
    const parValeur = await liste.selectOption(valeur).then(() => true).catch(() => false);
    if (parValeur) {
      log(`paybyphone : pays du numéro réglé par sa valeur (${valeur}).`);
      return true;
    }
  }
  log(`paybyphone : le pays « ${libelle} » n'a pas pu être choisi ; la liste garde son défaut.`);
  return false;
}

/**
 * Se connecte au portail des reçus.
 *
 * Une seule soumission, jamais deux : le portail est un vieil ASP.NET, et rien
 * ne dit ce qu'il fait d'un compte qui échoue plusieurs fois de suite.
 */
async function seConnecter(page, config, log) {
  const numero = numeroPourLeSite(config?.[CHAMP_NUMERO]);
  const motDePasse = String(config?.[CHAMP_MOT_DE_PASSE] || '');

  await page.goto(URL_CONNEXION, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const champNumero = await premierPresent(page, [
    '#MobileNumberTextBox',
    'input[name$="MobileNumberTextBox"]',
    'form input[type="text"]',
  ]);
  const champMotDePasse = await premierPresent(page, [
    '#PinTextBox',
    'input[name$="PinTextBox"]',
    'input[type="password"]',
  ]);

  if (!champNumero || !champMotDePasse) {
    throw new Error(
      'Le formulaire de connexion du portail PayByPhone est introuvable. Le portail a peut-être '
        + 'changé : signalez-le à la personne qui administre crabe.'
    );
  }

  await choisirIndicatif(page, indicatifChoisi(config), log);
  // `fill` et non `type` : aucun champ caché n'est touché — le jeton
  // `__VIEWSTATE` que la page y a écrit part avec le formulaire tel quel. Le
  // reconstruire à la main le perdrait, et le portail refuserait sans rien
  // expliquer.
  await champNumero.fill(numero);
  await champMotDePasse.fill(motDePasse);

  // ⚠ Ici on CLIQUE le bouton d'envoi, et c'est voulu.
  //
  // En ASP.NET WebForms, le couple nom/valeur du bouton
  // (`ctl00$MainContent$LoginButton=se connecter`) doit partir avec le POST pour
  // que le serveur sache quel contrôle a déclenché la soumission — la touche
  // Entrée ne le garantit pas. C'est sans risque sur cette page : elle ne
  // contient AUCUNE balise `<button>` et un seul `input[type=submit]`.
  const bouton = await premierPresent(page, [
    '#LoginButton',
    'input[name$="LoginButton"]',
    'input[type="submit"]',
  ]);
  if (!bouton) {
    throw new Error(
      'Le bouton de connexion du portail PayByPhone est introuvable. Le portail a peut-être '
        + 'changé : signalez-le à la personne qui administre crabe.'
    );
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    bouton.click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageConnexion(page.url())) {
    // Le grief tel que le portail l'écrit, s'il en écrit un. Jamais le mot de
    // passe, jamais le numéro : rien de ce que l'utilisateur a saisi ne part au
    // journal.
    const grief = await page.evaluate(() => {
      const zones = [...document.querySelectorAll(
        '.error,.errormessage,[id*="Error" i],[class*="error" i],span[style*="color"]'
      )];
      const texte = zones.map((z) => (z.innerText || '').trim()).find(Boolean);
      return (texte || '').slice(0, 200);
    }).catch(() => '');
    throw erreurIdentifiants(grief || `URL finale ${page.url()}`);
  }

  log(`paybyphone : connexion au portail établie (URL finale ${page.url()}).`);
}

/**
 * Le répertoire où Chromium écrit ses fichiers temporaires.
 *
 * Sans un HOME inscriptible, un Chromium lancé par un service systemd meurt sur
 * un SIGTRAP — même cause et même remède que dans le navigateur distant.
 */
function maisonNavigateur() {
  const dossier = nodePath.join(require('../../../config').config.dataDir, 'navigateur');
  nodeFs.mkdirSync(dossier, { recursive: true });
  return dossier;
}

/**
 * Ouvre le profil persistant, atteint le portail connecté, et passe la main.
 *
 * La racine du portail est tentée d'abord, avec la session que porte le profil :
 * si elle est servie, aucun formulaire n'est ouvert et aucun mot de passe n'est
 * saisi.
 */
async function surLeCompte(config, ctx, fn) {
  const numero = String(config?.[CHAMP_NUMERO] || '').trim();
  const motDePasse = String(config?.[CHAMP_MOT_DE_PASSE] || '');
  if (!numero || !motDePasse) throw erreurIdentifiantsManquants();

  const log = ctx?.log || (() => {});
  const userId = ctx?.userId;
  if (userId === undefined || userId === null) {
    throw new Error(
      'paybyphone : le contexte d\'exécution ne porte pas l\'utilisateur (ctx.userId) — '
        + 'le profil de navigateur ne peut pas être retrouvé.'
    );
  }

  const profil = profilPersistant.preparer(userId, ID);
  const { chromium } = requirePlaywright();

  let context = null;
  try {
    try {
      context = await chromium.launchPersistentContext(profil, {
        ...identity.optionsContexte({ viewport: VIEWPORT, acceptDownloads: true }),
        headless: true,
        env: { ...process.env, HOME: maisonNavigateur() },
        args: [
          '--disable-dev-shm-usage',
          '--disable-crashpad',
          '--disable-crash-reporter',
          '--no-sandbox',
        ],
      });
    } catch (err) {
      if (/Singleton|ProcessSingleton|already running/i.test(String(err?.message))) {
        throw new Error(
          'Le navigateur de PayByPhone est déjà ouvert par une autre récupération. '
            + 'Attendez qu\'elle se termine, puis relancez.'
        );
      }
      throw err;
    }

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(RACINE_PORTAIL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (estPageConnexion(page.url())) {
      log('paybyphone : la session enregistrée a expiré, connexion par le formulaire.');
      await seConnecter(page, config, log);
    } else {
      log('paybyphone : session encore valable, aucune connexion nécessaire.');
    }

    return await fn(page, context);
  } finally {
    await context?.close?.().catch(() => {});
  }
}

/**
 * Ce que la page offre, écrit tel quel au journal.
 *
 * ⚠ **La fonction la plus importante de ce fichier tant qu'aucun compte n'a
 * servi.** La structure du portail après connexion n'a jamais été vue : quand
 * le connecteur ne trouve pas ce qu'il cherche, il ne doit pas se contenter de
 * dire « introuvable », il doit dire **ce qu'il a vu à la place**. Sans ça, la
 * première exécution réelle demanderait trois allers-retours pour
 * comprendre ; avec ça, elle en demande zéro.
 */
async function decrirePage(page) {
  return page.evaluate(() => {
    const court = (t) => (t || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return {
      url: location.href,
      titre: document.title,
      liens: [...document.querySelectorAll('a[href]')]
        .map((a) => `${court(a.innerText)} → ${a.getAttribute('href')}`)
        .filter(Boolean).slice(0, 25),
      champs: [...document.querySelectorAll('input,select')]
        .filter((i) => i.type !== 'hidden')
        .map((i) => `${i.tagName.toLowerCase()}[${i.type || 'select'}]#${i.id || '?'}`)
        .slice(0, 25),
      boutons: [...document.querySelectorAll('button,input[type=submit],input[type=button]')]
        .map((b) => court(b.innerText || b.value)).filter(Boolean).slice(0, 20),
    };
  }).catch(() => ({ url: '?', titre: '?', liens: [], champs: [], boutons: [] }));
}

/** Écrit au journal ce que la page offrait, quand on n'y a pas trouvé son compte. */
function journaliserPage(vue, log, pourquoi) {
  log(`paybyphone : ${pourquoi}. Page « ${vue.titre} » (${vue.url}).`);
  log(`paybyphone :   liens vus — ${vue.liens.join(' | ') || 'aucun'}`);
  log(`paybyphone :   champs vus — ${vue.champs.join(', ') || 'aucun'}`);
  log(`paybyphone :   boutons vus — ${vue.boutons.join(' | ') || 'aucun'}`);
}

/**
 * Atteint la page des transactions de stationnement.
 *
 * L'aide officielle dit « Sélectionnez Transactions de stationnement » sans
 * donner d'adresse, et la sonde de routes ne discrimine pas sur ce portail
 * (ASP.NET redirige toute adresse vers le formulaire). On cherche donc le lien
 * dans la page, par ce que l'aide en dit.
 */
async function allerAuxTransactions(page, log) {
  const vue = await decrirePage(page);

  const liens = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => ({
      texte: (a.innerText || '').trim(),
      url: new URL(a.getAttribute('href'), location.href).href,
    }))
  ).catch(() => []);

  const cible = liens.find(estLienTransactions);
  if (!cible) {
    journaliserPage(vue, log, 'aucun lien vers les transactions de stationnement');
    return null;
  }

  await page.goto(cible.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageConnexion(page.url())) {
    throw erreurSessionExpiree('la page des transactions renvoie au formulaire');
  }

  log(`paybyphone : page des transactions atteinte (${page.url()}).`);
  return page.url();
}

/**
 * Demande le relevé d'un mois, et rend le PDF si le portail en sert un.
 *
 * ⚠ **Jamais vu tourner.** Les contrôles de période et de téléchargement sont
 * cherchés par ce que l'aide décrit, pas par des identifiants relevés — il n'y
 * en a pas eu à relever. Un échec n'est donc pas forcément une panne du
 * portail : ce peut être ce connecteur qui cherche mal, et c'est pour ça que la
 * page est décrite au journal.
 *
 * @returns {Buffer|null}
 */
async function releveDuMois(page, context, mois, log) {
  const champsDate = page.locator(SELECTEUR_CHAMPS_DATE);
  const nombre = await champsDate.count().catch(() => 0);

  if (nombre >= 2) {
    // Deux champs de date : début, puis fin. On écrit les deux formes les plus
    // répandues et on laisse le portail retenir celle qu'il comprend.
    for (const [indice, valeur] of [[0, mois.debut], [1, mois.fin]]) {
      const champ = champsDate.nth(indice);
      const [a, m, j] = valeur.split('-');
      await champ.fill(valeur).catch(async () => {
        await champ.fill(`${j}/${m}/${a}`).catch(() => {});
      });
    }
  } else {
    log(
      `paybyphone : ${mois.annee}-${String(mois.mois).padStart(2, '0')} — `
        + `${nombre} champ(s) de date trouvé(s) au lieu de deux ; la période n'a pas pu être réglée.`
    );
  }

  // Le contrôle qui produit un PDF, désigné par ce qu'il annonce.
  const bouton = await premierPresent(page, [
    'a:has-text("PDF")',
    'input[value*="PDF" i]',
    'button:has-text("PDF")',
    '[id*="pdf" i]',
  ]);
  if (!bouton) {
    journaliserPage(
      await decrirePage(page), log,
      `aucun contrôle de téléchargement PDF pour ${mois.annee}-${String(mois.mois).padStart(2, '0')}`
    );
    return null;
  }

  // Le portail peut servir le PDF par un téléchargement OU par une navigation.
  // On écoute les deux, comme le fait le connecteur impots.
  const attenteTelechargement = page.waitForEvent('download', { timeout: NAV_TIMEOUT_MS })
    .catch(() => null);
  const attenteReponse = page.waitForResponse(
    (r) => MOTIF_TELECHARGEMENT_PDF.test(r.url())
      || /application\/pdf/i.test(r.headers()['content-type'] || ''),
    { timeout: NAV_TIMEOUT_MS }
  ).catch(() => null);

  await bouton.click().catch(() => {});
  const [telechargement, reponse] = await Promise.all([attenteTelechargement, attenteReponse]);

  if (telechargement) {
    const flux = await telechargement.createReadStream().catch(() => null);
    if (flux) {
      const morceaux = [];
      for await (const morceau of flux) morceaux.push(morceau);
      return Buffer.concat(morceaux);
    }
  }
  if (reponse) {
    return Buffer.from(await reponse.body().catch(() => Buffer.alloc(0)));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la connexion au portail tient-elle ? */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    const compte = compteDepuisConfig(config);
    const transactions = await allerAuxTransactions(page, log);

    return {
      ok: true,
      accountId: compte,
      invoiceCount: 0,
      message: transactions
        ? `Connexion valide — ${compte} · page des transactions atteinte.`
        : `Connexion valide — ${compte} · page des transactions non trouvée, `
          + 'voir le journal pour ce que le portail a affiché.',
    };
  });
}

/** Récupère un relevé de stationnement par mois civil révolu. */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeCompte(config, ctx, async (page, context) => {
    const compte = compteDepuisConfig(config);

    const transactions = await allerAuxTransactions(page, log);
    if (!transactions) {
      // Une page qu'on n'a pas su lire N'EST PAS un compte sans relevé : en
      // ressortir `invoices: []` faisait conclure « OK — Aucune nouvelle
      // facture » au planificateur (14/08/2026, 00:02). Le journal porte déjà
      // ce que le portail affichait — c'est ça qui permettra de corriger — et
      // l'utilisateur, lui, reçoit un échec qui dit quoi faire.
      throw new Error(
        'PayByPhone a bien ouvert votre espace, mais la page des transactions de '
          + 'stationnement n\'a pas été trouvée : aucun relevé n\'a pu être cherché. '
          + 'Réessayez plus tard ; si le message revient, signalez-le à la personne '
          + 'qui administre crabe — le journal contient ce que le portail affichait.'
      );
    }

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      // Le portail conserve environ douze mois : proposer davantage ferait
      // parcourir des mois vides.
      disponibles: [...new Set(moisRevolus(null).map((m) => m.annee))],
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      plafondMois: ctx?.conservationMois || 0,
    });

    const mois = moisRevolus(plan.annees);
    log(
      `paybyphone : ${mois.length} mois révolu(s) à parcourir — historique « ${plan.mode} », `
        + plan.raison
    );

    // Preuve d'accès (lot 31) : le lien « transactions de stationnement »
    // n'apparaît que dans la navigation d'un compte ouvert, et la page qu'il
    // sert a répondu sans renvoyer au formulaire. C'est elle, la liste — le
    // portail n'a pas d'inventaire de documents : chaque mois se demande.
    ctx.preuveDeListe?.({
      session: 'lien « transactions de stationnement » présent dans le portail connecté',
      liste: `page des transactions (${transactions})`,
      elements: mois.length,
    });

    const invoices = [];
    let sansReleve = 0;

    for (const m of mois) {
      const remoteId = remoteIdPour(m.annee, m.mois);
      if (connus.has(remoteId)) continue;

      const buffer = await releveDuMois(page, context, m, log);

      if (!buffer || !buffer.length) {
        sansReleve++;
        continue;
      }

      // Le CONTENU fait foi, jamais l'en-tête : une session qui vient
      // d'expirer rend une page de connexion avec un type parfaitement propre,
      // et s'y fier déposerait du HTML dans le dossier des factures.
      if (!identity.estPdf(buffer)) {
        sansReleve++;
        log(
          `paybyphone : ${m.annee}-${String(m.mois).padStart(2, '0')} — le document reçu n'est `
            + `pas un PDF (${buffer.length} o), ignoré.`
        );
        continue;
      }

      connus.add(remoteId);
      invoices.push({
        accountId: compte,
        remoteId,
        filename: nomFichier(m.annee, m.mois),
        // Daté du dernier jour du mois couvert : c'est la date à laquelle le
        // relevé devient complet, et c'est elle qui le range dans la bonne année.
        issuedOn: m.fin,
        reference: `${m.annee}-${String(m.mois).padStart(2, '0')}`,
        buffer,
      });

      await page.waitForTimeout(PAUSE_DOCUMENT_MS);
    }

    // Les deux chiffres, parce que leur écart désigne l'étape en cause.
    log(
      `paybyphone : ${invoices.length} relevé(s) téléchargé(s) sur ${mois.length} mois parcouru(s)`
        + (sansReleve ? `, ${sansReleve} sans relevé disponible` : '')
        + '.'
    );

    return { accountId: compte, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  ID,
  estPageConnexion,
  estLienTransactions,
  numeroPourLeSite,
  indicatifChoisi,
  moisRevolus,
  remoteIdPour,
  nomFichier,
  compteDepuisConfig,
  premierPresent,
  SELECTEUR_CHAMPS_DATE,
  choisirIndicatif,
  seConnecter,
  decrirePage,
  journaliserPage,
  allerAuxTransactions,
  erreurSessionExpiree,
  erreurIdentifiants,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_IDENTIFIANTS,
  URL_CONNEXION,
  RACINE_PORTAIL,
  INDICATIFS,
  INDICATIF_PAR_DEFAUT,
  COMPTE_PAR_DEFAUT,
};
