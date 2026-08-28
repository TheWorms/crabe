'use strict';

/**
 * Ce qui recouvre un formulaire — bandeau de cookies, fenêtre promotionnelle,
 * invitation à la lettre d'information.
 *
 * ─── Pourquoi ce fichier ne s'appelle plus `cookie-banner.js` ────────────────
 *
 * Le lot 13 avait raison sur le mécanisme et tort sur le nom. Aagaard, en
 * production le 11/08/2026 :
 *
 *     [connector] Aagaard : un élément recouvre encore le formulaire après deux
 *                 tentatives — <div class="cp-popup-overlay"> (le clic
 *                 atterrirait sur « cp-popup-overlay »).
 *
 * `cp-popup-overlay` n'est **pas** une régie de cookies : c'est une fenêtre
 * promotionnelle. Un module qui s'appelle « bandeau de cookies » et qui ne sait
 * fermer que des bandeaux de cookies laisse passer la moitié des obstacles, et
 * son journal envoie chercher une régie qui n'existe pas. D'où le nom actuel,
 * et les cinq étapes ci-dessous plutôt que deux.
 *
 * ─── Le diagnostic d'origine, établi en production ───────────────────────────
 *
 * Propolia échouait avec ce message, qui dit tout :
 *
 *     locator.click: Timeout 45000ms exceeded
 *     <div id="didomi-popup" class="didomi-popup-backdrop didomi-notice-popup">
 *       from <div id="didomi-host" class="didomi-host">
 *       subtree intercepts pointer events
 *
 * Le bandeau Didomi recouvre le bouton de connexion. Le clic n'atteint jamais
 * sa cible, Playwright réessaie quatre-vingt-cinq fois, puis abandonne.
 *
 * Coco Papaya échouait probablement pour la même raison, mais affichait « La
 * connexion a été refusée. Vérifiez votre adresse électronique et votre mot de
 * passe » — un message FAUX : les identifiants étaient corrects, c'est le clic
 * qui n'aboutissait pas. C'est ce mensonge qui a coûté le plus de temps, plus
 * que la panne elle-même.
 *
 * ─── Les cinq étapes, dans l'ordre ───────────────────────────────────────────
 *
 * Chacune est essayée dans la page principale ET dans ses `frames()` — plusieurs
 * régies s'affichent dans un cadre. Après chacune, on **revérifie** que plus
 * rien ne recouvre la cible : sans ce contrôle, une tentative qui a cliqué sur
 * le mauvais bouton ne se distingue pas d'une réussite.
 *
 *   1. **régies connues** — les sept identifiants les plus répandus sur les
 *      sites français. Chemin rapide et sûr : un identifiant ne se confond
 *      avec rien ;
 *   2. **libellés d'acceptation** — Accepter · Tout accepter · Accepter et
 *      fermer · J'accepte · OK · Continuer, sans casse ni accents ;
 *   3. **boutons de fermeture** — la croix d'une fenêtre promotionnelle :
 *      `[aria-label*="fermer"]`, `.close`, `.cp-popup-close`, le caractère × ;
 *   4. **touche Échap** — elle ferme beaucoup de fenêtres modales, et ne coûte
 *      rien à essayer sur une page où il n'y en a pas ;
 *   5. **contournement forcé** — retirer l'élément obstruant du DOM, puis
 *      cliquer la cible directement par le DOM. Journalisé mot pour mot comme
 *      `contournement forcé` : c'est fonctionnel mais fragile — un site qui
 *      remet son voile en place au clic suivant nous ramènerait au point de
 *      départ, et il faut pouvoir le lire dans le journal.
 *
 * ─── Ce qui reste quand ça échoue ────────────────────────────────────────────
 *
 * L'obstacle est journalisé avec **son identifiant et ses classes**, et
 * l'étape qui a réussi l'est aussi quand il y en a une. C'est ce qui permettra
 * d'ajouter le motif manquant plus tard, en dix secondes, au lieu de repartir
 * d'un échec opaque et de devoir se connecter soi-même sur la boutique.
 *
 * ─── Pourquoi un module partagé ──────────────────────────────────────────────
 *
 * Le connecteur PrestaShop avait sa propre liste de libellés, la recette
 * générique un sélecteur déclaré par recette, le navigateur distant rien du
 * tout. Trois traitements, trois niveaux de qualité, et le bandeau de Propolia
 * passait au travers des trois. Une régie ajoutée ici sert désormais tout le
 * monde — connecteurs sur mesure, recettes génériques, navigateur distant et
 * outil de capture de session.
 */

// ---------------------------------------------------------------------------
// Les régies connues
// ---------------------------------------------------------------------------

/**
 * Le bouton « tout accepter » des régies les plus répandues.
 *
 * L'ordre compte peu — un site n'en installe qu'une —, mais Didomi vient en
 * tête parce que c'est celle qui bloquait Propolia, et la plus répandue en
 * France.
 *
 * Ces sélecteurs visent TOUS un bouton d'acceptation globale. On n'y met jamais
 * un « Continuer sans accepter » ni un « Paramétrer » : le premier n'existe pas
 * partout et le second ouvre un second écran, ce qui remplacerait un obstacle
 * par un autre.
 */
const REGIES = [
  { regie: 'Didomi', selecteur: '#didomi-notice-agree-button' },
  { regie: 'OneTrust', selecteur: '#onetrust-accept-btn-handler' },
  { regie: 'Axeptio', selecteur: '#axeptio_btn_acceptAll' },
  { regie: 'Complianz', selecteur: '.cmplz-accept' },
  { regie: 'Tarteaucitron', selecteur: '#tarteaucitronPersonalize2' },
  { regie: 'Cookiebot', selecteur: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll' },
  { regie: 'Sirdata', selecteur: '.sd-cmp-JI3lB' },
];

/**
 * Les libellés d'acceptation SANS AMBIGUÏTÉ, cherchés dans toute la page.
 *
 * Comparés sans casse et **sans accents** : « J'ACCEPTE », « J'accepte » et
 * « j'accepte » sont le même bouton, et une boutique sur deux écrit son libellé
 * en capitales sans accent.
 *
 * Aucun de ces libellés n'existe sur un formulaire de connexion : cliquer l'un
 * d'eux ne peut rien déclencher d'autre que la fermeture d'un bandeau.
 */
const LIBELLES_SURS = [
  'Accepter tous les cookies',
  'Autoriser tous les cookies',
  'Accepter et continuer',
  'Tout accepter',
  'J\'accepte',
  'Accepter',
];

/**
 * Les libellés GÉNÉRIQUES — cherchés uniquement DANS un bandeau de cookies.
 *
 * ─── Pourquoi cette distinction ──────────────────────────────────────────────
 *
 * « OK » et « Continuer » ferment bien des bandeaux. Mais « Continuer » est
 * aussi le bouton de soumission de la moitié des connexions en deux temps —
 * Amazon le premier, dont l'écran d'adresse électronique porte exactement ce
 * mot. Le chercher dans toute la page reviendrait à soumettre le formulaire
 * AVANT que crabe n'ait rempli quoi que ce soit, sur un site où tout allait
 * bien : on remplacerait un défaut par un pire.
 *
 * Ils ne sont donc essayés qu'à l'intérieur d'un conteneur qui se présente
 * lui-même comme un bandeau de consentement.
 */
const LIBELLES_GENERIQUES = ['Continuer', 'OK'];

/** Tous les libellés reconnus, sûrs et génériques. */
const LIBELLES = [...LIBELLES_SURS, ...LIBELLES_GENERIQUES];

/**
 * À quoi ressemble un conteneur de bandeau de cookies.
 *
 * Les régies nomment toutes leur racine — `didomi-host`, `onetrust-consent-sdk`,
 * `cookie-banner`, `cmp-container`. C'est ce qui permet de chercher « OK » là où
 * il ferme un bandeau, et nulle part ailleurs.
 */
const CONTENEURS_CONSENTEMENT = [
  'cookie', 'consent', 'consentement', 'cmp', 'didomi', 'gdpr', 'rgpd',
  'privacy', 'tarteaucitron', 'axeptio', 'cookiebot', 'sd-cmp',
]
  .flatMap((mot) => [`[id*="${mot}" i]`, `[class*="${mot}" i]`])
  .join(',');

/**
 * Délai avant la seconde tentative.
 *
 * Une régie chargée en asynchrone pose son bandeau après le `DOMContentLoaded`,
 * donc après notre premier passage. Une seconde et demie couvre ce qui a été
 * observé sans allonger sensiblement une connexion qui, elle, se passe bien.
 */
const DELAI_SECONDE_TENTATIVE_MS = 1500;

/** Patience accordée à un clic sur un bouton de bandeau. */
const DELAI_CLIC_MS = 3000;

/**
 * Ce que Playwright dit quand un élément en recouvre un autre.
 *
 * Deux formes selon la version et la situation : « intercepts pointer events »
 * (l'élément lui-même) et « subtree intercepts pointer events » (un de ses
 * descendants). La troisième forme vise les cas où la cible est bien là mais
 * hors d'atteinte.
 */
const MOTIF_CLIC_INTERCEPTE = /intercepts pointer events|is not visible|outside of the viewport/i;

// ---------------------------------------------------------------------------
// Libellés — fonctions pures
// ---------------------------------------------------------------------------

/**
 * Un libellé ramené à sa forme comparable : sans accents, sans casse, sans
 * ponctuation d'apostrophe, espaces normalisés.
 *
 * L'apostrophe typographique (’) et l'apostrophe droite (') désignent le même
 * bouton, et les sites mélangent les deux dans la même page.
 */
function normaliserLibelle(texte) {
  return String(texte ?? '')
    .normalize('NFD')
    // Les diacritiques combinants que `NFD` vient de détacher : « é » est
    // devenu « e » + U+0301, on jette le second.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, '\'')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Ce libellé est-il celui d'un bouton d'acceptation ?
 *
 * La comparaison est un **préfixe**, pas une égalité : un bouton s'intitule
 * souvent « Tout accepter et fermer » ou « Accepter ✓ ». Elle n'est pas une
 * simple inclusion non plus, sinon « Ne pas accepter » et « Refuser puis
 * accepter les essentiels » passeraient — c'est-à-dire l'inverse de ce qu'on
 * veut cliquer.
 */
function libelleAccepte(texte, libelles = LIBELLES) {
  const propre = normaliserLibelle(texte);
  if (!propre) return false;
  return libelles.some((libelle) => propre.startsWith(normaliserLibelle(libelle)));
}

/**
 * Ce libellé est-il trop générique pour être cliqué n'importe où ?
 *
 * « Continuer » ferme un bandeau, mais c'est aussi le bouton de soumission de
 * la moitié des connexions en deux temps. Voir `LIBELLES_GENERIQUES`.
 */
function libelleGenerique(texte) {
  return libelleAccepte(texte, LIBELLES_GENERIQUES)
    && !libelleAccepte(texte, LIBELLES_SURS);
}

/**
 * Cette erreur dit-elle qu'un élément a intercepté le clic ?
 *
 * C'est LA question du lot 13 : un clic intercepté n'est pas un refus
 * d'identifiants, et les confondre a produit le message le plus trompeur de
 * crabe (« Vérifiez votre adresse électronique et votre mot de passe » alors
 * que les deux étaient corrects).
 */
function estClicIntercepte(erreur) {
  const message = typeof erreur === 'string' ? erreur : erreur?.message;
  return MOTIF_CLIC_INTERCEPTE.test(String(message || ''));
}

/**
 * Décrit un obstacle pour le journal d'administration.
 *
 * L'identifiant et les classes, parce que ce sont EXACTEMENT les deux
 * informations dont on a besoin pour ajouter la régie à `REGIES` — et rien
 * d'autre : le contenu textuel d'un bandeau n'apprend rien et allonge le
 * journal.
 */
function decrireObstacle(obstacle) {
  if (!obstacle) return '';
  const morceaux = [`<${obstacle.tag || 'element'}`];
  if (obstacle.id) morceaux.push(`id="${obstacle.id}"`);
  if (obstacle.classes) morceaux.push(`class="${obstacle.classes}"`);
  const racine = `${morceaux.join(' ')}>`;
  // L'élément exact n'est mentionné que s'il diffère de la racine : le répéter
  // à l'identique n'apprendrait rien et doublerait la ligne.
  return obstacle.cible && obstacle.cible !== obstacle.id
    ? `${racine} (le clic atterrirait sur « ${obstacle.cible} »)`
    : racine;
}

/**
 * Ferme le bandeau **seulement s'il gêne**, juste avant un clic.
 *
 * ─── Pourquoi ce second contrôle existe ──────────────────────────────────────
 *
 * Les régies se chargent en asynchrone. Sur Propolia, le bandeau se pose une
 * fraction de seconde après la page — donc APRÈS le passage préventif de
 * `fermer()`, qui ne trouve rien et rend la main. Le temps de remplir le
 * formulaire, il est là, et le clic part dans le vide pendant quinze secondes
 * avant d'échouer.
 *
 * Ce contrôle-ci coûte un `evaluate` (quelques millisecondes) et se place juste
 * avant le clic, quand le bandeau a eu le temps d'arriver. Il transforme un
 * échec à quinze secondes en une fermeture immédiate.
 *
 * @returns {Promise<object|null>} le résultat de `fermer`, ou null si rien ne gênait
 */
async function fermerSiObstacle(page, options = {}) {
  const obstacle = await obstacleDevant(page, options.cible || 'form');
  if (!obstacle) return null;
  return fermer(page, options);
}

// ---------------------------------------------------------------------------
// Détection de l'obstacle — exécutée dans la page
// ---------------------------------------------------------------------------

/**
 * Quelque chose recouvre-t-il encore le formulaire ?
 *
 * On prend le centre de la cible et on demande à la page qui s'y trouve
 * (`elementFromPoint`). Si ce n'est ni la cible ni un de ses parents ou
 * descendants, c'est qu'un élément est passé devant — et c'est lui qui
 * mangerait le clic.
 *
 * Le contrôle porte sur la CIBLE RÉELLE (le bouton de connexion, le champ de
 * mot de passe) plutôt que sur « y a-t-il un bandeau quelque part » : un
 * bandeau en pied de page qui ne recouvre rien n'est pas un problème, et
 * s'acharner à le fermer ferait échouer des connexions qui marchaient.
 *
 * @param {object} page page ou cadre Playwright
 * @param {string} selecteur ce qu'on cherche à cliquer ensuite
 * @returns {Promise<{tag: string, id: string, classes: string}|null>}
 */
async function obstacleDevant(page, selecteur) {
  try {
    return await page.evaluate((sel) => {
      const cible = [...document.querySelectorAll(sel)].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!cible) return null;

      const r = cible.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Hors de la fenêtre : ce n'est pas un recouvrement, c'est un défilement
      // à faire — et Playwright s'en charge tout seul avant de cliquer.
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;

      const dessus = document.elementFromPoint(x, y);
      if (!dessus || dessus === cible) return null;
      if (cible.contains(dessus) || dessus.contains(cible)) return null;

      // `elementFromPoint` rend l'élément le plus PROFOND — souvent le petit
      // bouton « Gérer mes choix » à l'intérieur du bandeau. Ce n'est pas lui
      // qu'il faut journaliser : ce qu'on veut ajouter à REGIES, c'est la
      // racine du bandeau (« didomi-host », « onetrust-consent-sdk »). On
      // remonte donc jusqu'au dernier ancêtre qui ne contient toujours pas la
      // cible — au-delà, on tomberait sur <body>, qui n'apprend rien.
      let racine = dessus;
      for (let parent = dessus.parentElement; parent; parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        if (parent.contains(cible)) break;
        racine = parent;
      }

      return {
        tag: racine.tagName.toLowerCase(),
        id: racine.id || '',
        classes: String(racine.className || '').slice(0, 200),
        // L'élément exact qui mangerait le clic, pour les bandeaux dont la
        // racine est un <div> anonyme.
        cible: dessus.id || String(dessus.className || '').slice(0, 80) || dessus.tagName.toLowerCase(),
      };
    }, selecteur);
  } catch {
    // Page en cours de navigation : rien de concluant à en tirer, et surtout
    // pas de quoi faire échouer une connexion.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fermeture
// ---------------------------------------------------------------------------

/**
 * Tente de lever l'obstruction dans un cadre : étapes 1 à 3.
 *
 * Les étapes 4 (Échap) et 5 (contournement forcé) ne sont pas ici : elles
 * portent sur la PAGE entière, pas sur un cadre, et n'ont donc de sens qu'une
 * fois tous les cadres essayés.
 *
 * @param {object} cadre page ou frame Playwright
 * @returns {Promise<{etape: string, quoi: string}|null>}
 */
async function fermerDansUnCadre(cadre) {
  // 1. Par identifiant : rapide, sans ambiguïté.
  for (const { regie, selecteur } of REGIES) {
    const trouve = await cliquerSiPresent(cadre, cadre.locator?.(selecteur));
    if (trouve) return { etape: 'régie connue', quoi: regie };
  }

  // 2. Par rôle et libellé : les régies maison, et les thèmes qui ont renommé
  //    les identifiants de leur régie.
  const parLibelle = await cliquerParLibelle(cadre);
  if (parLibelle) return { etape: 'libellé d\'acceptation', quoi: parLibelle };

  // 3. Par bouton de fermeture : la croix d'une fenêtre promotionnelle. C'est
  //    l'étape qu'Aagaard exigeait — `cp-popup-overlay` n'a aucun bouton
  //    d'acceptation, seulement une croix.
  const parFermeture = await cliquerFermeture(cadre);
  if (parFermeture) return { etape: 'bouton de fermeture', quoi: parFermeture };

  return null;
}

/**
 * Les croix de fermeture d'une fenêtre surgissante.
 *
 * `cp-popup-close` est nommé explicitement parce que c'est celui d'Aagaard, et
 * qu'un motif générique `[class*="close"]` seul cliquerait aussi la croix d'un
 * bandeau d'information sans rapport. L'ordre va donc du plus précis au plus
 * large, comme pour les régies.
 */
const SELECTEURS_FERMETURE = [
  '[aria-label*="fermer" i]',
  '[aria-label*="close" i]',
  '.cp-popup-close',
  // Le bandeau promotionnel de Bricomarché (mesuré le 23/08/2026 sur la page
  // de connexion) : un `<div class="cms-slot contents">` injecté par ESI qui
  // recouvre le formulaire. Son bouton de fermeture n'a NI libellé, NI
  // aria-label, NI classe « close » — aucun motif générique ne le voit, et le
  // produit ne passait que par le contournement forcé. C'est le SEUL bouton
  // du bloc : le lien promotionnel, lui, est un <a>.
  '.cms-slot.contents button',
  '[class*="popup"] [class*="close"]',
  '[class*="modal"] [class*="close"]',
  '.close',
  '[data-dismiss]',
];

/** Le caractère × employé comme bouton de fermeture, seul dans son élément. */
const MOTIF_CROIX = /^[×✕✖✗x]$/i;

/**
 * Cherche une croix de fermeture et la clique.
 *
 * @returns {Promise<string|null>} une description du bouton cliqué, ou null
 */
async function cliquerFermeture(cadre) {
  for (const selecteur of SELECTEURS_FERMETURE) {
    let locator;
    try {
      locator = cadre.locator?.(selecteur);
    } catch {
      continue;
    }
    if (await cliquerSiPresent(cadre, locator)) return selecteur;
  }

  // Le caractère × employé tel quel, sans classe ni libellé accessible. On ne
  // le cherche que sur des éléments cliquables, et seul dans son contenu : un
  // « 3 × 2 » dans une page de boutique ne doit pas être pris pour une croix.
  try {
    const boutons = cadre.locator('button, a, span[role="button"], div[role="button"]');
    const total = await boutons.count();
    for (let i = 0; i < Math.min(total, 60); i++) {
      const bouton = boutons.nth(i);
      let texte = '';
      try {
        texte = ((await bouton.textContent()) || '').trim();
      } catch {
        continue;
      }
      if (!MOTIF_CROIX.test(texte)) continue;
      if (await cliquerSiPresent(cadre, bouton)) return `caractère « ${texte} »`;
    }
  } catch {
    /* cadre détaché */
  }
  return null;
}

/**
 * Étape 4 — la touche Échap.
 *
 * Beaucoup de fenêtres modales l'écoutent, et elle ne peut rien casser sur une
 * page qui n'en a pas : aucun formulaire de connexion ne se soumet sur Échap.
 */
async function toucheEchap(page) {
  try {
    if (typeof page.keyboard?.press !== 'function') return false;
    await page.keyboard.press('Escape');
    await patienter(page, 300);
    return true;
  } catch {
    return false;
  }
}

/**
 * Étape 5 — le contournement forcé.
 *
 * On retire du DOM l'élément qui mangerait le clic. C'est **fragile** : le site
 * peut le remettre en place, et un voile retiré à la main n'a pas déclenché la
 * logique de consentement que la boutique attend peut-être. C'est pour ça que
 * l'appelant journalise `contournement forcé` mot pour mot — pour qu'un
 * connecteur qui n'aboutit QUE par cette étape se repère dans le journal, et
 * finisse par recevoir son motif propre dans `REGIES` ou `SELECTEURS_FERMETURE`.
 *
 * @param {object} page
 * @param {string} selecteur la cible qu'on veut pouvoir cliquer
 * @returns {Promise<boolean>} vrai si quelque chose a été retiré
 */
async function retirerObstacle(page, selecteur) {
  try {
    return await page.evaluate((sel) => {
      const cible = [...document.querySelectorAll(sel)].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!cible) return false;

      const r = cible.getBoundingClientRect();
      const dessus = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!dessus || dessus === cible) return false;
      if (cible.contains(dessus) || dessus.contains(cible)) return false;

      // La racine du voile, pas le petit bouton qu'il contient : retirer
      // seulement l'élément le plus profond laisserait le voile en place.
      let racine = dessus;
      for (let parent = dessus.parentElement; parent; parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        if (parent.contains(cible)) break;
        racine = parent;
      }
      racine.remove();
      return true;
    }, selecteur);
  } catch {
    return false;
  }
}

/**
 * Clique un élément s'il est là et visible. Ne lève jamais.
 *
 * L'absence n'est PAS une erreur : la quasi-totalité des appels ne trouvent
 * rien, puisqu'on essaie sept régies dont une seule au plus est installée.
 */
async function cliquerSiPresent(cadre, locator) {
  if (!locator) return false;
  try {
    if (!(await locator.count())) return false;
    const premier = locator.first();
    if (typeof premier.isVisible === 'function' && !(await premier.isVisible())) return false;
    await premier.click({ timeout: DELAI_CLIC_MS });
    return true;
  } catch {
    // Bandeau parti entre le comptage et le clic, bouton masqué, cadre détaché :
    // on passe au candidat suivant.
    return false;
  }
}

/**
 * Cherche un bouton d'acceptation par son libellé, sans casse ni accents.
 *
 * `getByRole('button')` couvre les `<button>`, les `<a role="button">` et les
 * `<input type="submit">` : les trois formes rencontrées. Le tri se fait
 * ensuite sur le texte, côté Node, parce que le filtrage de Playwright ne sait
 * ignorer ni les accents ni l'apostrophe typographique.
 *
 * @returns {Promise<string|null>} « libellé « Tout accepter » », ou null
 */
async function cliquerParLibelle(cadre) {
  if (typeof cadre.getByRole !== 'function') return null;

  // 1. Les libellés sans ambiguïté, dans toute la page.
  const sur = await essayerLibelles(cadre, cadre.getByRole('button'), LIBELLES_SURS);
  if (sur) return sur;

  // 2. Les libellés génériques (« OK », « Continuer »), UNIQUEMENT dans un
  //    conteneur qui se présente comme un bandeau de consentement. Voir
  //    LIBELLES_GENERIQUES : « Continuer » est le bouton de soumission d'une
  //    connexion en deux temps sur un site sur deux.
  try {
    const dansLeBandeau = cadre
      .locator(CONTENEURS_CONSENTEMENT)
      .locator('button, a[role="button"], input[type="submit"], input[type="button"]');
    return await essayerLibelles(cadre, dansLeBandeau, LIBELLES_GENERIQUES);
  } catch {
    return null;
  }
}

/**
 * Parcourt les boutons d'un ensemble et clique le premier dont le libellé
 * accepte les cookies.
 *
 * @returns {Promise<string|null>} une description du bouton cliqué, ou null
 */
async function essayerLibelles(cadre, boutons, libelles) {
  try {
    const total = await boutons.count();
    // Une page ordinaire a une poignée de boutons ; au-delà, on est sur une
    // page d'application et le bandeau, s'il y en avait un, aurait répondu à
    // l'un des sept identifiants. Une borne évite d'inspecter deux cents
    // éléments sur chaque connexion.
    const borne = Math.min(total, 40);
    for (let i = 0; i < borne; i++) {
      const bouton = boutons.nth(i);
      let texte = '';
      try {
        texte = (await bouton.textContent()) || '';
      } catch {
        continue;
      }
      if (!libelleAccepte(texte, libelles)) continue;
      if (await cliquerSiPresent(cadre, bouton)) {
        return `libellé « ${String(texte).replace(/\s+/g, ' ').trim().slice(0, 40)} »`;
      }
    }
  } catch {
    /* cadre détaché en cours de route */
  }
  return null;
}

/**
 * Ferme le bandeau de cookies, s'il y en a un, partout où il peut se trouver.
 *
 * **À appeler avant toute interaction avec un formulaire**, sur tous les
 * connecteurs. Son absence n'est jamais une erreur : la fonction ne lève pas et
 * renvoie simplement `ferme: false`.
 *
 * @param {object} page page Playwright
 * @param {object} [options]
 * @param {string} [options.cible] sélecteur de ce qu'on va cliquer ensuite —
 *   c'est sur LUI que porte le contrôle de recouvrement
 * @param {(message: string) => void} [options.log] journal d'administration
 * @param {string} [options.prefixe] nom du connecteur, en tête des lignes
 * @returns {Promise<{ferme: boolean, regie: string|null, obstacle: object|null,
 *                    tentatives: number}>}
 */
async function fermer(page, { cible = 'form', log = () => {}, prefixe = 'connexion' } = {}) {
  let regie = null;
  let etape = null;
  let force = false;
  let tentatives = 0;

  /** Une étape a abouti : on le dit, et on note LAQUELLE. */
  const noter = (nom, quoi) => {
    etape = nom;
    regie = quoi;
    log(`${prefixe} : obstruction levée à l'étape « ${nom} » (${quoi}).`);
  };

  for (let passage = 0; passage < 2; passage++) {
    tentatives++;

    // Étapes 1 à 3, cadre principal d'abord — c'est là que l'obstacle se trouve
    // neuf fois sur dix, et c'est le moins coûteux à interroger.
    for (const cadre of [page, ...cadresDe(page)]) {
      const trouve = await fermerDansUnCadre(cadre);
      if (!trouve) continue;
      noter(trouve.etape, trouve.quoi);
      break;
    }

    // Laisse l'animation de fermeture se terminer : un voile qui s'efface en
    // 300 ms recouvre encore la cible au moment du contrôle.
    if (etape) await patienter(page, 400);

    if (!(await obstacleDevant(page, cible))) {
      return { ferme: !!etape, regie, etape, force, obstacle: null, tentatives };
    }

    // Étape 4 — Échap. Essayée avant la seconde attente : elle est instantanée,
    // et elle suffit sur une bonne part des fenêtres promotionnelles.
    if (await toucheEchap(page)) {
      if (!(await obstacleDevant(page, cible))) {
        noter('touche Échap', 'fenêtre modale fermée');
        return { ferme: true, regie, etape, force, obstacle: null, tentatives };
      }
    }

    // Un obstacle au premier passage : peut-être une régie chargée en
    // asynchrone, qui n'était pas encore là. On lui laisse le temps d'arriver
    // et on recommence — une fois, pas indéfiniment.
    if (passage === 0) {
      await patienter(page, DELAI_SECONDE_TENTATIVE_MS);
      continue;
    }

    // Étape 5 — le contournement forcé, en dernier recours seulement.
    const obstacleAvant = await obstacleDevant(page, cible);
    if (await retirerObstacle(page, cible)) {
      await patienter(page, 200);
      if (!(await obstacleDevant(page, cible))) {
        force = true;
        etape = 'contournement forcé';
        regie = decrireObstacle(obstacleAvant);
        // Mot pour mot « contournement forcé » : c'est ce qu'on cherchera dans
        // le journal pour repérer les connecteurs qui ne tiennent que par là.
        log(
          `${prefixe} : contournement forcé — l'élément obstruant a été retiré de la page `
            + `(${decrireObstacle(obstacleAvant)}). C'est fonctionnel mais fragile : ajoutez `
            + 'son motif à server/connectors/obstructions.js pour le fermer proprement.'
        );
        return { ferme: true, regie, etape, force, obstacle: null, tentatives };
      }
    }

    // Toutes les étapes ont échoué. On dit lequel : c'est cette ligne, et elle
    // seule, qui permettra d'ajouter le motif manquant.
    log(
      `${prefixe} : un élément recouvre encore le formulaire après deux tentatives et `
        + `cinq étapes — ${decrireObstacle(obstacleAvant)}. Cet obstacle n'est pas reconnu : `
        + 'ajoutez son motif à server/connectors/obstructions.js (REGIES, LIBELLES ou '
        + 'SELECTEURS_FERMETURE).'
    );
    return { ferme: false, regie, etape, force, obstacle: obstacleAvant, tentatives };
  }

  /* c8 ignore next — la boucle sort toujours par un des `return` ci-dessus */
  return { ferme: !!etape, regie, etape, force, obstacle: null, tentatives };
}

/** Les cadres d'une page, hors cadre principal, et sans jamais lever. */
function cadresDe(page) {
  try {
    const tous = typeof page.frames === 'function' ? page.frames() : [];
    // `frames()[0]` EST le cadre principal : l'interroger deux fois doublerait
    // le coût de chaque connexion pour rien.
    return tous.filter((cadre) => cadre && cadre !== tous[0]);
  } catch {
    return [];
  }
}

/** Une pause, quelle que soit l'interface offerte par le double de test. */
async function patienter(page, ms) {
  try {
    if (typeof page.waitForTimeout === 'function') return void (await page.waitForTimeout(ms));
  } catch {
    /* page fermée : la suite s'en apercevra */
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  REGIES,
  LIBELLES,
  LIBELLES_SURS,
  LIBELLES_GENERIQUES,
  SELECTEURS_FERMETURE,
  MOTIF_CROIX,
  CONTENEURS_CONSENTEMENT,
  DELAI_SECONDE_TENTATIVE_MS,
  DELAI_CLIC_MS,
  MOTIF_CLIC_INTERCEPTE,
  normaliserLibelle,
  libelleAccepte,
  libelleGenerique,
  estClicIntercepte,
  decrireObstacle,
  obstacleDevant,
  fermer,
  fermerSiObstacle,
  // exportés pour les tests
  fermerDansUnCadre,
  cliquerParLibelle,
  cliquerFermeture,
  toucheEchap,
  retirerObstacle,
  essayerLibelles,
  cadresDe,
};
