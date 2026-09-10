'use strict';

/**
 * Connecteur Free Mobile — plusieurs lignes sur un même compte.
 *
 * ─── Pourquoi une session capturée à la main ─────────────────────────────────
 *
 * Free Mobile envoie un code SMS à CHAQUE nouvelle connexion. Aucun connecteur
 * ne peut donc ouvrir la session tout seul : crabe rejoue un état de session
 * ouvert par l'utilisateur dans le navigateur distant, chiffré au repos comme
 * un mot de passe (voir connectors/session-state.js).
 *
 * ─── Parcours, validé contre un compte réel le 09/08/2026 ────────────────────
 *
 * Page de compte : https://mobile.free.fr/account/v2, en **1600×900**. La
 * largeur compte : à 1280 px l'affichage change et les sélecteurs ne résolvent
 * plus les mêmes éléments.
 *
 * 1. « Mes lignes » est un menu DÉROULANT REPLIÉ. La ligne principale est
 *    affichée, les autres existent dans le DOM mais mesurent 0×0 : elles sont
 *    inatteignables tant qu'il n'est pas déplié. Le DOM contient en plus une
 *    seconde copie du menu dans un conteneur `w-0 h-0 overflow-hidden` — d'où
 *    `.filter({ visible: true })`, et surtout PAS de `getBoundingClientRect`,
 *    qui se laisse prendre.
 *
 * 2. Les entrées sont de simples `div.cursor-pointer`, pas des liens. Le nom et
 *    le numéro y sont dans deux `<p>` adjacents, d'où un texte concaténé sans
 *    séparateur : « Camille Dupont07 49 00 00 00 ».
 *
 * 3. La bascule d'une ligne à l'autre ne recharge rien et ne change pas l'URL
 *    (application React) : le SEUL signal fiable est le titre « Ma ligne - 07
 *    49 00 00 00 ». Tant qu'il n'affiche pas le numéro demandé, on ne relève
 *    RIEN — sans ce garde-fou, une bascule ratée rangerait les factures de la
 *    ligne principale sous le numéro d'une autre, en silence.
 *
 * 4. Le déroulant se referme après chaque sélection : il faut le rouvrir à
 *    chaque tour.
 *
 * 5. **Le rang d'une ligne ne se lit nulle part dans le panneau.** Deux lots
 *    l'ont cherché, deux lots s'y sont trompés. Ce qui est vrai, c'est l'ordre :
 *    la principale vient en tête. Le socle en tire le badge
 *    (connectors/discovery.js) ; ce connecteur n'en pose plus aucun.
 *
 * ⚠️ Piège d'URL : `https://mobile.free.fr/account/v2?login=94994336` est
 * parfaitement normale — `login` y est un PARAMÈTRE. Seul le **chemin** dit si
 * la session a expiré (voir `estPageAuthentification`).
 *
 * ─── Ce qui prouve la session, et pourquoi ça a changé (lot 67) ──────────────
 *
 * Le 27/08/2026 à 08:54, une connexion faite À LA MAIN dans la fenêtre a été
 * REFUSÉE deux fois de suite :
 *
 *     Session Free Mobile NON enregistrée : connexion NON confirmée —
 *     URL finale https://mobile.free.fr/account/v2, aucun marqueur de compte,
 *     aucun message d'erreur affiché
 *
 * La fenêtre n'était pas en faute : elle refuse d'enregistrer une session
 * qu'elle ne sait pas prouver, et c'est le comportement voulu depuis le
 * lot 48. Ce qui manquait, c'est la preuve : `preuve-connexion` exige un LIEN
 * DE DÉCONNEXION, et l'espace abonné de Free Mobile n'en met aucun dans son
 * document — c'est une application React dont le menu se peint au clic, comme
 * SoundCloud et Deezer avant lui.
 *
 * D'où `verifyUrlTient` (lot 40), et il tient sur une mesure prise le même
 * jour, en VISITEUR ANONYME, sans ouvrir la moindre session :
 *
 *     https://mobile.free.fr/account/v2
 *       → 200, mais URL finale .../account/v2/login?redirect=…
 *         « Connectez-vous à votre Espace Abonné mobile »
 *         aucun lien de déconnexion, surFormulaire = true
 *
 * Un anonyme ne RESTE donc jamais sur la page de compte : il est renvoyé au
 * formulaire, et `/login` suffit à `estUrlAuthentification` pour le dire.
 * Rester sur `/account/v2` sans être sur un formulaire est donc bien la
 * signature d'une session vivante — exactement la condition que `verifyUrlTient`
 * exprime, et c'est l'URL qu'affichait la fenêtre quand crabe a refusé la session.
 *
 * ⚠️ **Ce qui a été ESSAYÉ puis ÉCARTÉ, pour qu'on ne le retente pas.** Viser
 * une page plus profonde (`/account/v2/facturation`, `/account/v2/factures`)
 * paraissait plus sûr : un anonyme en est renvoyé vers une adresse qui, elle,
 * ne commence pas par la page de contrôle. Le témoin inexistant l'a interdit :
 *
 *     https://mobile.free.fr/account/v2/ceci-nexiste-absolument-pas-lot67
 *       → renvoyé vers /login, exactement comme /facturation
 *     https://mobile.free.fr/ceci-nexiste-pas-lot67   (hors /account)
 *       → 404 honnête, « Free mobile - Vous êtes perdus ? »
 *
 * La garde passe donc AVANT le routage sous `/account/v2` : de l'extérieur,
 * une page qui existe et une page qui n'existe pas sont indiscernables. Rien
 * ne prouve que `/facturation` existe, et une adresse de contrôle qu'on ne
 * peut pas vérifier n'est pas une adresse de contrôle. On garde donc
 * `/account/v2`, la seule dont on SAIT qu'elle sert un compte connecté :
 * c'est celle que ce connecteur ouvre depuis le 09/08/2026.
 *
 * Aucun `marqueursFenetre` n'est déclaré, et c'est délibéré : il faudrait
 * relever les marqueurs sur la page CONNECTÉE, ce qui exige une connexion à la
 * main. On ne suppose pas ce qu'on n'a pas mesuré.
 *
 * ─── Sortie ─────────────────────────────────────────────────────────────────
 *
 *   /Free Mobile/0628000000/2026-07_2222222222.pdf
 *
 * Le dossier est le numéro SEUL, sans le nom du titulaire : celui-ci peut
 * changer, le numéro non. `remoteId` est la référence de facture, unique et
 * stable — c'est elle qui assure l'idempotence.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');

const URL_COMPTE = 'https://mobile.free.fr/account/v2';
const VIEWPORT = { width: 1600, height: 900 };

/** Entrées de ligne du menu : de simples div cliquables, pas des liens. */
const SELECTEUR_LIGNE = 'div.cursor-pointer';
/** Un numéro français à dix chiffres, tel qu'il est affiché. */
const MOTIF_NUMERO = /0\d(?:[\s.]?\d\d){4}/;
/** Liens de facture, aperçus (`?display=1`) exclus. */
const SELECTEUR_FACTURE = 'a[href*="/api/SI/invoice/"]';

const NAV_TIMEOUT_MS = 45_000;
/** Délai d'attente du titre « Ma ligne - … » après un clic de bascule. */
const DELAI_BASCULE_MS = 15_000;
/** Budget par ligne : découverte, bascule, dépliage et relevé compris. */
const DELAI_LIGNE_MS = 30_000;
/** « Voir plus » : borne haute, pour ne pas boucler sur un bouton qui reste. */
const MAX_VOIR_PLUS = 15;

const CHAMP_SESSION = 'session';
const CHAMP_LIGNES = 'lignes';

const MOIS = {
  janvier: '01', février: '02', fevrier: '02', mars: '03', avril: '04',
  mai: '05', juin: '06', juillet: '07', août: '08', aout: '08',
  septembre: '09', octobre: '10', novembre: '11', décembre: '12', decembre: '12',
};

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur Free Mobile ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il doit dire quoi faire, pas constater. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à Free Mobile a expiré. Rouvrez-la depuis la fiche du service, '
  + 'bouton « Se connecter à Free Mobile ».';

/** Erreur reconnaissable par le socle : elle bascule le connecteur en erreur. */
function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'URL courante est-elle une page d'authentification ?
 *
 * **Seul le chemin compte.** `?login=94994336` est le paramètre qui désigne une
 * ligne : le confondre avec la page de connexion ferait déclarer expirée une
 * session parfaitement valide, à chaque exécution.
 *
 * @param {string} url
 * @returns {boolean}
 */
function estPageAuthentification(url) {
  let chemin;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return false;
  }
  return /\/(login|otp)(\/|$)/i.test(`${chemin}/`);
}

/** « 07 49 00 00 00 » → « 0749000000 » ; null si ce n'est pas un numéro. */
function numeroNormalise(valeur) {
  const chiffres = String(valeur ?? '').replace(/\D/g, '');
  return chiffres.length === 10 && chiffres.startsWith('0') ? chiffres : null;
}

/** « 0749000000 » → « 07 49 00 00 00 », la forme affichée par le portail. */
function numeroEspace(numero) {
  return String(numero || '').replace(/(\d\d)(?=\d)/g, '$1 ').trim();
}

/**
 * Période d'une facture, en « AAAA-MM ».
 *
 * Deux formats coexistent sur la même page, et c'est une source d'erreur
 * avérée :
 *
 *   cartes de l'historique   « Juillet 2026 »                        → 2026-07
 *   carte « Ma dernière facture »
 *                            « Facture mensuelle du 31/07/2026
 *                               au 31/08/2026 »                      → 2026-08
 *
 * Le second se lit sur le mois de **fin** de période — c'est celui que Free
 * affiche comme nom de facture (« Août 2026 »). Sans lui, la facture la plus
 * récente de chaque ligne serait mal nommée : la plage est donc essayée
 * d'abord, sinon un « Mois AAAA » isolé de la carte l'emporterait à tort.
 *
 * @param {string} texte
 * @returns {string|null}
 */
function periodeDepuisTexte(texte) {
  const propre = String(texte || '').replace(/\s+/g, ' ');

  const plage = propre.match(
    /du\s+\d{1,2}\/\d{1,2}\/\d{4}\s+au\s+\d{1,2}\/(\d{1,2})\/(\d{4})/i
  );
  if (plage) return `${plage[2]}-${String(plage[1]).padStart(2, '0')}`;

  const mois = propre
    .toLowerCase()
    .match(
      /(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/
    );
  return mois ? `${mois[2]}-${MOIS[mois[1]]}` : null;
}

/** « 2026-07 » + « 2222222222 » → « 2026-07_2222222222.pdf ». */
function nomFichier(periode, reference) {
  return `${periode || 'inconnu'}_${reference}.pdf`;
}

/**
 * Une ligne découverte, mise en forme pour l'écran de sélection.
 *
 * ─── Ce qui a disparu ici, et pourquoi ───────────────────────────────────────
 *
 * Deux lots de suite, ce connecteur a tenté de LIRE sur le panneau laquelle des
 * quatre lignes est la principale — d'abord par la position des titres de
 * section dans le document, puis par la remontée d'ancêtres jusqu'au premier
 * titre frère. Les deux fois, la production a affiché « principale » sur les
 * quatre lignes.
 *
 * La cause n'est pas un motif mal écrit : le panneau porte une seconde copie
 * repliée du menu, ses titres sont mis en capitales par la feuille de style, et
 * l'ordre du document n'est pas celui de l'affichage. Il n'y avait rien de
 * fiable à lire, et une heuristique de plus n'aurait fait que déplacer
 * l'endroit où elle se trompe.
 *
 * Le rang ne se déduit donc plus d'aucune analyse : il vient de l'ORDRE de
 * découverte, et la règle vit dans le socle (connectors/discovery.js) — premier
 * élément principal, suivants secondaires. Ce connecteur ne pose plus AUCUN
 * badge ; celui qu'il remonterait serait ignoré.
 *
 * Reste à sa charge ce qu'il est seul à savoir : le numéro, le nom du
 * titulaire, le nombre de factures, et le fait que seule la première ligne soit
 * cochée d'office — les autres sont un choix, et l'écran de sélection explique
 * pourquoi il vaut mieux les sauvegarder maintenant (Free ne conserve que les
 * 12 dernières factures).
 *
 * @param {{numero: string, nom?: string}} ligne
 * @param {number|null} [nombreFactures] `null` = non compté
 * @param {number} [index] position dans la découverte
 */
function enElementDecouvert(ligne, nombreFactures = null, index = 0) {
  return {
    id: ligne.numero,
    label: ligne.nom || '',
    detail:
      nombreFactures === null
        ? ''
        : `${nombreFactures} facture${nombreFactures > 1 ? 's' : ''}`,
    preselected: index === 0,
  };
}

/**
 * Attend qu'une valeur lue devienne celle attendue.
 *
 * Sorti de la logique de bascule pour être testable sans navigateur : c'est
 * le garde-fou qui empêche de relever les factures d'une autre ligne.
 *
 * @param {{lire: () => Promise<*>, attendu: *, delaiMs: number, pause: (ms: number) => Promise<void>}} options
 * @returns {Promise<{ok: boolean, vu: *}>}
 */
async function attendreValeur({ lire, attendu, delaiMs = DELAI_BASCULE_MS, pause }) {
  const limite = Date.now() + delaiMs;
  let vu = null;
  for (;;) {
    vu = await lire();
    if (vu === attendu) return { ok: true, vu };
    if (Date.now() >= limite) return { ok: false, vu };
    await pause(400);
  }
}

/**
 * Parcourt les lignes retenues, en refusant de relever après une bascule non
 * confirmée.
 *
 * Injecter `basculer` et `relever` rend la règle vérifiable sans navigateur :
 * un test peut faire échouer la bascule et constater que rien n'a été relevé.
 *
 * @param {{lignes: Array<object>, basculer: Function, relever: Function, log: Function}} options
 */
async function parcourirLignes({ lignes, basculer, relever, log = () => {} }) {
  const resultats = [];
  for (const ligne of lignes) {
    const bascule = await basculer(ligne);
    if (!bascule?.ok) {
      log(
        `free-mobile : bascule vers ${ligne.numero} non confirmée (${bascule?.raison || 'raison inconnue'}) `
          + '— ligne ignorée, aucune facture relevée'
      );
      resultats.push({ ligne, ok: false, raison: bascule?.raison || 'bascule non confirmée', factures: [] });
      continue;
    }
    resultats.push({ ligne, ok: true, raison: null, factures: await relever(ligne) });
  }
  return resultats;
}

/** Contrôle du fichier de session avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la session enregistrée, atteint la page de compte,
 * puis passe la main à `fn(page, context)`. Le navigateur est toujours refermé.
 */
async function surLeCompte(config, fn) {
  // La session est contrôlée AVANT tout : inutile de payer le lancement d'un
  // navigateur pour se faire rediriger vers la page de connexion, et une
  // session vide ou périmée se voit sans sortir de la machine.
  const session = lireSession(config);

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : voir connectors/browser-identity.js.
  const context = await browser.newContext(
    identity.optionsContexte({ storageState: session, viewport: VIEWPORT })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(URL_COMPTE, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (estPageAuthentification(page.url())) {
      throw erreurSessionExpiree('redirection vers la page de connexion');
    }

    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Nombre d'entrées de ligne actuellement VISIBLES (Playwright en juge). */
async function compterEntrees(page) {
  return page
    .locator(SELECTEUR_LIGNE)
    .filter({ hasText: MOTIF_NUMERO })
    .filter({ visible: true })
    .count();
}

/**
 * Déplie le menu « Mes lignes ».
 * @returns {Promise<boolean>} au moins une entrée est atteignable
 */
async function ouvrirDeroulant(page) {
  if ((await compterEntrees(page)) > 1) return true; // déjà déplié

  const bascule = page.getByText('Mes lignes', { exact: false }).first();
  if (await bascule.count()) {
    await bascule.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  return (await compterEntrees(page)) > 0;
}

/** Numéro affiché dans le titre « Ma ligne - … », ou null. */
async function ligneAffichee(page) {
  const brut = await page.evaluate(() => {
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"]')) {
      const m = (h.textContent || '').trim().match(/^Ma ligne\s*[-–]\s*(0\d(?:[\s.]?\d\d){4})/i);
      if (m) return m[1];
    }
    return null;
  });
  return numeroNormalise(brut);
}

/**
 * Lignes déclarées par le compte, dans l'ORDRE du panneau.
 *
 * ─── Ce qui a été retiré ─────────────────────────────────────────────────────
 *
 * Le relevé des titres de section, et tout ce qui allait avec : reconnaître un
 * titre, remonter les ancêtres, attribuer une entrée à une section. Deux
 * versions de cette analyse ont été livrées, et les deux ont classé les quatre
 * lignes du compte en « principale ». Le panneau n'est pas lisible ainsi.
 *
 * ─── Ce qui reste, et suffit ─────────────────────────────────────────────────
 *
 * Les entrées, dans l'ordre où le document les porte — le portail place la
 * ligne principale en tête. Le rang est posé par le socle à partir de cet ordre
 * (connectors/discovery.js) ; ici, on ne relève plus qu'un numéro et un nom.
 */
async function decouvrirLignes(page, log = () => {}) {
  await ouvrirDeroulant(page);

  const brutes = await page.evaluate((sel) => {
    const motif = /0\d(?:[\s.]?\d\d){4}/;
    const sortie = [];
    const vus = new Set();
    for (const el of document.querySelectorAll(sel)) {
      const texte = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const nums = texte.match(new RegExp(motif.source, 'g')) || [];
      // Une entrée de ligne porte UN seul numéro : plus, c'est un conteneur.
      if (nums.length !== 1) continue;
      const numero = nums[0].replace(/\D/g, '');
      if (numero.length !== 10 || vus.has(numero)) continue;
      vus.add(numero);

      sortie.push({
        numero,
        nom: texte.replace(new RegExp(motif.source, 'g'), '').trim(),
      });
    }
    return sortie;
  }, SELECTEUR_LIGNE);

  const trouvees = brutes
    .map((l) => ({ numero: numeroNormalise(l.numero), nom: l.nom, bascule: true }))
    .filter((l) => l.numero);

  if (trouvees.length) {
    log(
      `free-mobile : ${trouvees.length} ligne(s) découverte(s) dans le menu « Mes lignes » — `
        + `${trouvees[0].numero} vient en tête du panneau, c'est la ligne principale`
    );
    return trouvees;
  }

  // Repli mono-ligne : le menu déroulant n'existe peut-être pas sur un compte
  // qui ne porte qu'un abonnement. Le titre « Ma ligne - … » suffit alors.
  const affichee = await ligneAffichee(page);
  if (affichee) {
    log(`free-mobile : aucune entrée de menu — compte mono-ligne, numéro ${affichee} lu dans le titre`);
    return [{ numero: affichee, nom: '', bascule: false }];
  }

  // Ni menu, ni titre exploitable : plutôt qu'un échec, un dossier « defaut ».
  log(
    'free-mobile : aucune ligne trouvée, ni dans le menu ni dans le titre — '
      + 'les factures iront dans le dossier « defaut »'
  );
  return [{ numero: 'defaut', nom: '', bascule: false }];
}

/**
 * Bascule vers une ligne et attend la confirmation du titre.
 * @returns {Promise<{ok: boolean, raison: string|null}>}
 */
async function basculerVers(page, ligne) {
  if (ligne.bascule === false) return { ok: true, raison: null };

  // Le déroulant se referme après chaque sélection : le rouvrir à chaque tour.
  await ouvrirDeroulant(page);

  let clique = false;
  for (const forme of [numeroEspace(ligne.numero), ligne.numero]) {
    const entree = page
      .locator(SELECTEUR_LIGNE)
      .filter({ hasText: forme })
      .filter({ visible: true });
    if (await entree.count()) {
      await entree.first().click({ timeout: 6000 }).catch(() => {});
      clique = true;
      break;
    }
  }
  if (!clique) return { ok: false, raison: 'entrée visible introuvable — déroulant non déplié ?' };

  const attente = await attendreValeur({
    lire: () => ligneAffichee(page),
    attendu: ligne.numero,
    delaiMs: DELAI_BASCULE_MS,
    pause: (ms) => page.waitForTimeout(ms),
  });

  return attente.ok
    ? { ok: true, raison: null }
    : { ok: false, raison: `le titre affiche ${attente.vu || 'rien'} au lieu de ${ligne.numero}` };
}

/** Onglet « Mes factures », puis « Voir plus » jusqu'à épuisement. */
async function ouvrirFactures(page) {
  const onglet = page.getByRole('tab', { name: 'Mes factures' });
  if (await onglet.count()) {
    await onglet.first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  for (let i = 0; i < MAX_VOIR_PLUS; i++) {
    const plus = page.getByRole('button', { name: 'Voir plus' });
    if (!(await plus.count())) break;
    await plus.first().click().catch(() => {});
    await page.waitForTimeout(900);
  }
}

/**
 * Factures de la section « Ma ligne » seulement.
 *
 * On s'arrête au titre « Récapitulatif des factures de toutes mes lignes » :
 * ce qui suit concerne le compte entier, et n'est pas ce qui est demandé.
 */
async function facturesDeLaLigne(page) {
  const brutes = await page.evaluate((selecteur) => {
    const titres = [...document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"]')];
    const debut = titres.find((h) => /^Ma ligne/i.test((h.textContent || '').trim()));
    const fin =
      titres.find((h) => /R[ée]capitulatif des factures/i.test(h.textContent || ''))
      || titres.find((h) => /R[ée]capitulatif/i.test(h.textContent || ''));
    if (!debut) return [];

    const dans = [];
    const marcheur = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let actif = false;
    while (marcheur.nextNode()) {
      const n = marcheur.currentNode;
      if (n === debut) { actif = true; continue; }
      if (fin && n === fin) break;
      if (actif) dans.push(n);
    }

    const vus = new Set();
    const sortie = [];
    for (const el of dans) {
      if (!el.matches?.(selecteur)) continue;
      const href = el.href || '';
      // `?display=1` est l'aperçu du même document : un seul lien par facture.
      if (href.includes('display=1')) continue;
      const m = href.match(/\/invoice\/(\d+)/);
      if (!m || vus.has(m[1])) continue;
      vus.add(m[1]);

      // La carte porte la période ; on remonte jusqu'à un bloc qui a du texte.
      let carte = el;
      for (let i = 0; i < 6 && carte.parentElement; i++) {
        carte = carte.parentElement;
        const t = (carte.textContent || '').trim();
        if (/\d{4}/.test(t) && t.length > 12) break;
      }

      sortie.push({
        reference: m[1],
        href,
        texte: (carte.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    }
    return sortie;
  }, SELECTEUR_FACTURE);

  return brutes.map((f) => {
    const periode = periodeDepuisTexte(f.texte);
    return {
      remoteId: f.reference,
      reference: f.reference,
      href: f.href,
      yearMonth: periode,
      issuedOn: periode ? `${periode}-01` : null,
      filename: nomFichier(periode, f.reference),
    };
  });
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : la session est-elle encore acceptée ?
 * Ne bascule sur aucune ligne et ne télécharge rien — quelques secondes.
 */
async function test(config, ctx = {}) {
  return surLeCompte(config, async (page) => {
    const lignes = await decouvrirLignes(page, ctx.log);
    // La première du panneau est la principale : c'est elle qui donne son
    // identifiant au compte (voir connectors/discovery.js).
    const principale = lignes[0];
    const secondaires = Math.max(0, lignes.length - 1);

    return {
      ok: true,
      accountId: principale?.numero || null,
      invoiceCount: undefined,
      message:
        `Session valide — ${lignes.length} ligne(s) sur ce compte`
        + (secondaires ? ` (dont ${secondaires} secondaire${secondaires > 1 ? 's' : ''})` : '')
        + (principale ? ` · ligne principale ${numeroEspace(principale.numero)}` : ''),
    };
  });
}

/**
 * Découverte : les lignes du compte, avec leur nombre de factures.
 *
 * C'est l'étape longue (20 à 60 secondes) : elle bascule réellement sur chaque
 * ligne pour compter ses factures, faute de quoi l'écran de sélection
 * n'aiderait pas à choisir.
 */
async function discover(config, ctx = {}) {
  return surLeCompte(config, async (page) => {
    const lignes = await decouvrirLignes(page, ctx.log);

    const resultats = await parcourirLignes({
      lignes,
      basculer: (ligne) => basculerVers(page, ligne),
      relever: async () => {
        await ouvrirFactures(page);
        return facturesDeLaLigne(page);
      },
      log: ctx.log || (() => {}),
    });

    return {
      items: resultats.map((r, index) =>
        enElementDecouvert(r.ligne, r.ok ? r.factures.length : null, index)
      ),
    };
  });
}

/**
 * Récupère les factures des lignes retenues.
 *
 * Le téléchargement passe par le contexte authentifié (`context.request`)
 * plutôt que par un clic suivi d'un événement « download » : plus fiable, et
 * les cookies de session sont réutilisés tels quels.
 */
async function fetchInvoices(config, ctx = {}) {
  const known = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeCompte(config, async (page, context) => {
    const lignes = await decouvrirLignes(page, log);

    // Rapprochement avec ce qui est enregistré : une ligne jamais vue rejoint
    // la sélection d'office, une ligne disparue est conservée mais ignorée.
    // Hors socle (test direct), on retombe sur la configuration telle quelle.
    const decouverts = lignes.map((l, index) => enElementDecouvert(l, null, index));
    const retenues = ctx.reconcile
      ? ctx.reconcile(CHAMP_LIGNES, decouverts).selection
      : Array.isArray(config?.[CHAMP_LIGNES]) && config[CHAMP_LIGNES].length
        ? config[CHAMP_LIGNES]
        : lignes.map((l) => l.numero);

    const choisies = lignes.filter((l) => retenues.includes(l.numero));
    log(
      `free-mobile : ${choisies.length} ligne(s) retenue(s) sur ${lignes.length} découverte(s)`
    );

    const invoices = [];
    const resultats = await parcourirLignes({
      lignes: choisies,
      basculer: (ligne) => basculerVers(page, ligne),
      relever: async (ligne) => {
        const limite = Date.now() + DELAI_LIGNE_MS;
        await ouvrirFactures(page);
        const listees = await facturesDeLaLigne(page);
        const aPrendre = listees.filter((f) => !known.has(f.remoteId));
        log(
          `free-mobile : ligne ${ligne.numero} — ${listees.length} facture(s) listée(s), `
            + `${aPrendre.length} à récupérer`
        );

        for (const facture of aPrendre) {
          if (Date.now() > limite) {
            log(
              `free-mobile : ligne ${ligne.numero} — délai de ${DELAI_LIGNE_MS / 1000} s dépassé, `
                + 'les factures restantes seront reprises à la prochaine exécution'
            );
            break;
          }
          const res = await context.request
            .get(facture.href, { timeout: NAV_TIMEOUT_MS })
            .catch(() => null);
          if (!res || !res.ok()) {
            log(
              `free-mobile : facture ${facture.reference} — HTTP ${res ? res.status() : 'sans réponse'}, ignorée`
            );
            continue;
          }
          const buffer = Buffer.from(await res.body());
          if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
            // Un HTML à la place d'un PDF, c'est la page de connexion : la
            // session vient de tomber. Inutile de continuer les autres lignes.
            throw erreurSessionExpiree(
              `réponse non-PDF pour la facture ${facture.reference} (${buffer.length} o)`
            );
          }

          invoices.push({
            accountId: ligne.numero,
            remoteId: facture.remoteId,
            filename: facture.filename,
            issuedOn: facture.issuedOn,
            amount: null, // non exposé de façon fiable sur cette page
            buffer,
          });
        }

        return listees;
      },
      log,
    });

    const echecs = resultats.filter((r) => !r.ok);
    if (echecs.length) {
      log(
        `free-mobile : ${echecs.length} ligne(s) abandonnée(s) faute de bascule confirmée — `
          + echecs.map((r) => r.ligne.numero).join(', ')
      );
    }

    // Preuve d'accès (lot 31) : les lignes mobiles du panneau n'existent que
    // connecté, et les factures de chaque ligne parcourue ont été listées.
    // Rien de découvert = rien de positif = pas de preuve, et le socle
    // refusera de conclure « aucune nouvelle facture ».
    if (lignes.length > 0) {
      ctx.preuveDeListe?.({
        session: `${lignes.length} ligne(s) mobile(s) affichée(s) dans l'espace abonné`,
        liste: 'factures par ligne de l\'espace abonné Free Mobile',
        elements: resultats.filter((r) => r.ok).reduce((n, r) => n + r.factures.length, 0),
      });
    }

    // Le compte porte le numéro de la ligne principale, c'est-à-dire la
    // première du panneau — même si elle n'a pas été retenue pour la
    // récupération, elle reste ce qui identifie le compte.
    const principale = lignes[0] || choisies[0];
    return { accountId: principale?.numero || null, invoices };
  });
}

module.exports = {
  test,
  discover,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  periodeDepuisTexte,
  numeroNormalise,
  numeroEspace,
  nomFichier,
  enElementDecouvert,
  attendreValeur,
  parcourirLignes,
  erreurSessionExpiree,
  MESSAGE_SESSION_EXPIREE,
  URL_COMPTE,
  SELECTEUR_LIGNE,
  SELECTEUR_FACTURE,
  DELAI_BASCULE_MS,
  DELAI_LIGNE_MS,
};
