'use strict';

/**
 * « L'utilisateur est-il vraiment connecté ? »
 *
 * Cette question se pose à deux endroits, et il n'en existe qu'une bonne
 * réponse : `tools/capture-session.js` (le repli en ligne de commande) et
 * `server/remote-browser.js` (le navigateur distant du lot 6) surveillent tous
 * deux une page pendant qu'un humain s'y connecte, et doivent décider du
 * moment où l'état de session vaut la peine d'être enregistré.
 *
 * Se tromper coûte cher dans les deux sens :
 *
 *   - **trop tôt** — on enregistre une session à moitié authentifiée, sur un
 *     portail à validation en deux temps. Elle passe tous les contrôles de
 *     forme (elle a des cookies, ils ne sont pas expirés) et n'échoue qu'à la
 *     première récupération, des jours plus tard ;
 *   - **trop tard** — la connexion est aboutie mais rien ne la détecte, le
 *     délai finit par tomber et l'utilisateur recommence sans comprendre.
 *
 * D'où quatre garde-fous, appliqués dans cet ordre :
 *
 *   1. l'URL ne désigne pas une étape d'authentification ;
 *   2. plus aucun champ de mot de passe à l'écran ;
 *   3. pas de grille de saisie de code (les champs d'un code à six chiffres
 *      ne sont PAS de type « password », et l'URL d'un écran OTP ne contient
 *      pas toujours « otp ») ;
 *   4. le marqueur textuel du connecteur est présent — « Mes factures » chez
 *      Free Mobile. C'est le seul contrôle réellement fiable, les trois
 *      autres ne sont que des filtres de sécurité.
 *
 * ─── Le piège du paramètre « login » ─────────────────────────────────────────
 *
 * Seuls le CHEMIN et le FRAGMENT de l'URL sont examinés, jamais la requête.
 * `https://mobile.free.fr/account/v2?login=94994336` est la page de compte
 * parfaitement authentifiée : `login` y est le paramètre qui désigne une ligne.
 * Chercher le mot dans l'URL entière ferait attendre indéfiniment une connexion
 * pourtant établie. Le connecteur Free Mobile documente le même piège
 * (`estPageAuthentification`), et pour la même raison.
 *
 * Le fragment est inclus parce que les applications monopage y rangent leurs
 * étapes (`https://exemple.fr/#/otp`) sans que le chemin ne bouge.
 */

/** Mots qui désignent une étape d'authentification dans un chemin d'URL. */
const MOTS_AUTHENTIFICATION = /login|connexion|signin|auth|otp|2fa|mfa|verif|challenge|code/i;

/** Un mot de passe encore à l'écran : la connexion n'est pas passée. */
const SELECTEUR_MOT_DE_PASSE = 'input[type="password"]';

/**
 * Champs d'une grille de code de validation. Un code à six chiffres se saisit
 * dans six petits champs numériques côte à côte — jamais dans un « password ».
 */
const SELECTEUR_CHAMP_CODE =
  'input[type="number"], input[type="tel"], input[inputmode="numeric"], [role="spinbutton"]';

/** À partir de combien de champs numériques on parle d'une grille de code. */
const SEUIL_GRILLE_CODE = 4;

/**
 * Un champ de code SEUL, mais qui se nomme comme tel.
 *
 * La grille (ci-dessus) demande quatre champs côte à côte parce qu'un unique
 * `input[type="number"]` est trop commun — un compteur de quantité suffirait à
 * bloquer la détection sur une page pourtant connectée. Mais un champ NOMMÉ
 * « otp », « 2fa », « one-time-code »… ne se trouve que sur un écran de
 * validation : lui seul suffit. C'est le champ que Hetzner affiche sur `/2fa`
 * — celui devant lequel la fenêtre s'est fermée le 14/08/2026.
 */
const SELECTEUR_CODE_NOMME =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], '
  + 'input[name*="totp" i], input[name*="2fa" i], input[id*="2fa" i], '
  + 'input[name*="mfa" i], input[name*="one-time" i], input[name*="security-code" i], '
  + 'input[name*="verification" i], input[id*="verification" i]';

/**
 * Un champ d'identifiant DANS un formulaire : l'écran propose de se connecter.
 * Restreint aux champs qui se nomment (courriel, utilisateur…) — un champ de
 * recherche dans l'en-tête d'un espace connecté ne doit pas retenir la
 * fenêtre ouverte pour rien.
 */
const SELECTEUR_CHAMP_IDENTIFIANT =
  'form input[type="email"], form input[autocomplete="username"], '
  + 'form input[autocomplete="email"], form input[name*="user" i], '
  + 'form input[name*="email" i], form input[name*="login" i], '
  + 'form input[name*="identifiant" i]';

/** Délai entre les deux lectures de la confirmation, en millisecondes. */
const DELAI_CONFIRMATION_MS = 1200;

/**
 * Pause avant de figer l'état de session — le temps que les cookies tardifs
 * s'écrivent.
 *
 * ─── Le défaut observé (lot 12, boutiques PrestaShop) ────────────────────────
 *
 * PrestaShop pose des cookies COMPLÉMENTAIRES juste après la redirection qui
 * suit la connexion. Une capture prise trop tôt en oublie une partie, et
 * l'échec est **silencieux** : le fichier de session a l'air complet, il passe
 * tous les contrôles de forme, et c'est seulement au premier téléchargement,
 * des jours plus tard, qu'un `403` tombe.
 *
 * Symptôme relevé pendant l'exploration : **12 cookies enregistrés au lieu de
 * 15**, puis `403` sur la facture. Deux secondes et demie suffisent.
 */
const DELAI_COOKIES_TARDIFS_MS = 2500;

/**
 * L'URL désigne-t-elle une étape d'authentification ?
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isAuthenticationUrl(raw) {
  let cible;
  try {
    cible = new URL(String(raw ?? ''));
  } catch {
    // URL relative ou vide (« about:blank ») : rien à en conclure.
    return false;
  }
  return MOTS_AUTHENTIFICATION.test(`${cible.pathname}${cible.hash}`);
}

/**
 * L'URL désigne-t-elle une étape technique DU SITE, déclarée par le connecteur ?
 *
 * ─── La panne mesurée (lot 32, 14/08/2026) ───────────────────────────────────
 *
 * `accounts.hetzner.com/_ray/pow` — « HeRay », la vérification anti-robot de
 * Hetzner — passait tous les garde-fous : pas de mot d'authentification dans le
 * chemin, pas de champ de mot de passe, pas de grille de code. `inspect()`
 * rendait « aucun écran d'authentification visible » devant une page titrée
 * « Security Check ». Une capture déclenchée là enregistre des cookies
 * anonymes, et l'essai qui suit échoue en coupant la détection automatique —
 * la fenêtre reste alors ouverte sur les bras de l'utilisateur.
 *
 * Ces adresses ne se devinent pas depuis un module générique : c'est le
 * connecteur qui les connaît (`remoteLogin.attendreUrls`), et il ne déclare
 * que des fragments de CHEMIN — la requête, elle, porte des valeurs.
 */
function estEtapeDuSite(raw, urlsEnCours) {
  if (!Array.isArray(urlsEnCours) || !urlsEnCours.length) return false;
  let cible;
  try {
    cible = new URL(String(raw ?? ''));
  } catch {
    return false;
  }
  const chemin = `${cible.pathname}${cible.hash}`;
  return urlsEnCours.some((fragment) => fragment && chemin.includes(String(fragment)));
}

/**
 * Où en est le parcours de connexion, d'après ce qui est à l'écran ?
 *
 * Renvoie une raison plutôt qu'un simple booléen : c'est elle qui permet
 * d'écrire « code de validation en attente » sous le navigateur distant au
 * lieu d'un compte à rebours muet. L'URL lue est rendue avec le verdict, pour
 * que l'appelant sache d'où il vient sans relire la page — la relire ferait
 * avancer les doubles de test, et compterait pour une seconde inspection.
 *
 * @param {object} page page Playwright (ou un objet qui en imite l'interface)
 * @param {{marker?: string, urlsEnCours?: string[]}} [options]
 * @returns {Promise<{ok: boolean, reason: string, url: string|null}>}
 */
async function inspect(page, { marker = '', markerRequired = true, urlsEnCours = [] } = {}) {
  let url = null;
  try {
    url = String(page.url() ?? '');

    // L'étape du site AVANT tout le reste : une page de vérification anti-robot
    // n'est ni une connexion aboutie, ni un formulaire — elle est « en cours »,
    // et la seule chose à faire est d'attendre qu'elle passe.
    if (estEtapeDuSite(url, urlsEnCours)) {
      return { ok: false, reason: 'vérification du site en cours', url };
    }

    if (isAuthenticationUrl(url)) {
      return { ok: false, reason: 'authentification en cours', url };
    }

    if (await page.locator(SELECTEUR_MOT_DE_PASSE).count()) {
      return { ok: false, reason: 'mot de passe attendu', url };
    }

    if ((await page.locator(SELECTEUR_CHAMP_CODE).count()) >= SEUIL_GRILLE_CODE) {
      return { ok: false, reason: 'code de validation attendu', url };
    }

    // Un champ de code isolé mais nommé comme tel vaut une grille : l'écran de
    // validation de Hetzner n'a qu'un champ, et il a suffi à perdre une
    // cérémonie entière (14/08/2026, fenêtre fermée pendant la saisie).
    if (await page.locator(SELECTEUR_CODE_NOMME).count()) {
      return { ok: false, reason: 'code de validation attendu', url };
    }

    if (marker) {
      const vu = await page.getByText(marker, { exact: false }).count();
      if (vu > 0) return { ok: true, reason: `marqueur « ${marker} » trouvé`, url };
      // Marqueur EXIGÉ (le défaut, et ce que fait le navigateur distant) : son
      // absence bloque. C'est le seul contrôle vraiment fiable sur un portail à
      // validation en deux temps, et un connecteur livré déclare le sien.
      if (markerRequired) {
        return { ok: false, reason: `en attente du marqueur « ${marker} »`, url };
      }
      // Marqueur SIMPLE INDICE (l'outil de capture, lot 12). Chaque boutique a
      // son libellé — « Mes commandes », « Historique de mes commandes »,
      // « Vos commandes »… — et on ne peut pas tous les deviner. Un marqueur
      // faux faisait alors attendre dix minutes une connexion pourtant établie,
      // sur un site où tout s'était bien passé. Le critère générique suffit ;
      // il est de toute façon confirmé deux fois, à 1,2 s d'intervalle.
    }

    // Sans marqueur, la détection est heuristique : on ne peut qu'affirmer
    // qu'aucun écran d'authentification n'est visible. Un connecteur sérieux
    // en déclare un (voir le bloc « remoteLogin » d'un manifeste).
    return { ok: true, reason: 'aucun écran d\'authentification visible', url };
  } catch {
    // Navigation en cours : le DOM est en train de changer sous nos pieds.
    return { ok: false, reason: 'page en cours de chargement', url };
  }
}

/** Forme booléenne, pour qui n'a pas besoin de la raison. */
async function isLoggedIn(page, options = {}) {
  return (await inspect(page, options)).ok;
}

/**
 * Un écran attend-il une saisie de l'utilisateur ?
 *
 * ─── La règle qui manquait (lot 33, 14/08/2026) ──────────────────────────────
 *
 * La sonde du lot 32 a fermé la fenêtre de connexion Hetzner pendant que
 * l'utilisateur était devant le champ de son code de validation : l'arrivée
 * sur `/2fa` est un changement d'adresse, la demi-session (mot de passe passé,
 * code jamais saisi) se « prouvait » sur la page de contrôle — `/2fa` porte un
 * lien logout, et son chemin n'était pas reconnu comme un formulaire. La leçon
 * dépasse Hetzner : **aucune preuve de session ne justifie de fermer une
 * fenêtre dont l'écran attend une frappe.** Ce que le site répond ailleurs ne
 * dit rien de ce que l'utilisateur est en train de faire ici.
 *
 * Trois familles de champs retiennent la fenêtre : un mot de passe, un champ
 * de code (grille OU champ isolé — l'écran de Hetzner n'en a qu'un), un champ
 * d'identifiant dans un formulaire. Une page illisible (navigation en cours)
 * retient aussi : on ne fait pas confiance à un écran qu'on n'a pas pu lire.
 *
 * @param {object} page page Playwright (ou un double qui en imite l'interface)
 * @returns {Promise<{attend: boolean, motif: string|null}>}
 */
async function attendUneSaisie(page) {
  try {
    if (await page.locator(SELECTEUR_MOT_DE_PASSE).count()) {
      return { attend: true, motif: 'un mot de passe est attendu à l\'écran' };
    }
    // Seuil 1, pas la grille : pour RETENIR une fenêtre, un seul champ
    // numérique suffit — le pire cas d'un excès de prudence est une fenêtre
    // qui ne se ferme pas seule, pas une session à moitié capturée.
    if (await page.locator(SELECTEUR_CHAMP_CODE).count()) {
      return { attend: true, motif: 'un champ de code est affiché à l\'écran' };
    }
    if (await page.locator(SELECTEUR_CODE_NOMME).count()) {
      return { attend: true, motif: 'un champ de code est affiché à l\'écran' };
    }
    if (await page.locator(SELECTEUR_CHAMP_IDENTIFIANT).count()) {
      return { attend: true, motif: 'un formulaire de connexion est affiché à l\'écran' };
    }
    return { attend: false, motif: null };
  } catch {
    return { attend: true, motif: 'page en cours de chargement' };
  }
}

/**
 * Confirme la connexion par une SECONDE lecture, espacée.
 *
 * Une redirection intermédiaire peut présenter, l'espace d'un instant, une
 * page sans champ de mot de passe et sans mot d'authentification dans son
 * chemin. La double lecture élimine ce faux positif — elle a été ajoutée pour
 * ça dans `tools/capture-session.js`.
 *
 * @param {object} page
 * @param {{marker?: string, pause: (ms: number) => Promise<void>, delayMs?: number}} options
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function confirm(page, { marker = '', markerRequired = true, urlsEnCours = [],
  pause, delayMs = DELAI_CONFIRMATION_MS }) {
  const premiere = await inspect(page, { marker, markerRequired, urlsEnCours });
  if (!premiere.ok) return premiere;

  await pause(delayMs);
  const seconde = await inspect(page, { marker, markerRequired, urlsEnCours });
  return seconde.ok
    ? seconde
    : { ok: false, reason: `${seconde.reason} (confirmation non tenue)`, url: seconde.url };
}

/**
 * Le champ actif d'une page, décrit **sans jamais lire son contenu**.
 *
 * Seules une nature (modifiable ou non) et une LONGUEUR franchissent la
 * frontière du navigateur. Le texte, lui, ne sort pas : c'est un mot de passe
 * dans la quasi-totalité des cas, et il n'a rien à faire dans la mémoire de
 * crabe, encore moins dans un journal.
 *
 * @param {object} page page Playwright
 * @returns {Promise<{editable: boolean, tag: string, longueur: number}|null>}
 */
async function champActif(page) {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;

      const tag = el.tagName.toLowerCase();
      const type = String(el.type || 'text').toLowerCase();
      const nonSaisissables = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'];
      const modifiable =
        (tag === 'input' && !nonSaisissables.includes(type)) || tag === 'textarea'
          ? true
          : !!el.isContentEditable;

      if (!modifiable) return { editable: false, tag, longueur: 0 };

      const valeur = tag === 'input' || tag === 'textarea'
        ? String(el.value ?? '')
        : String(el.textContent ?? '');
      // La LONGUEUR, et rien d'autre.
      return { editable: true, tag, longueur: valeur.length };
    });
  } catch {
    // Page en cours de navigation : on ne peut rien affirmer.
    return null;
  }
}

/**
 * Fait défiler jusqu'au formulaire et place le curseur dans le premier champ.
 *
 * Beaucoup de portails placent une grande image d'accroche au-dessus du
 * formulaire : sans ça, la fenêtre s'ouvre sur la bannière plutôt que sur les
 * champs à remplir. Le parcours enchaînant plusieurs écrans (mot de passe,
 * puis code de validation), il faut recadrer à chaque étape.
 *
 * ─── Le curseur de l'utilisateur est SACRÉ (lot 13) ──────────────────────────
 *
 * Cette fonction est appelée par la boucle de surveillance à chaque changement
 * de formulaire, c'est-à-dire potentiellement **pendant que l'utilisateur
 * tape**. Jusqu'ici elle reprenait le curseur sans rien demander, et le posait
 * dans le PREMIER champ texte de la page.
 *
 * L'effet en production : l'utilisateur clique dans « Mot de passe », colle son
 * texte, et le curseur file dans « Identifiant » au milieu de la frappe — la
 * moitié du mot de passe atterrit dans le mauvais champ, et il n'y a rien à
 * l'écran pour le comprendre. C'est très exactement le symptôme « le collage ne
 * fonctionne pas » signalé depuis trois lots, et il a été retrouvé par un test
 * qui frappait un mot de passe complet dans une vraie page.
 *
 * D'où la règle : **si quelque chose de modifiable a déjà le focus, on n'y
 * touche pas.** Recadrer n'a de sens que sur un écran où personne n'a encore
 * choisi où écrire.
 *
 * @param {object} page
 * @param {{forcer?: boolean}} [options] `forcer` ignore le contrôle ci-dessus
 */
async function focusForm(page, { forcer = false } = {}) {
  if (!forcer) {
    const actif = await champActif(page);
    if (actif?.editable) return;
  }

  try {
    // On vise, dans l'ordre : un mot de passe, une grille de code de
    // validation, ou à défaut le premier champ de saisie de la page.
    const cible = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const candidats = [
        'input[type="password"]',
        'input[type="number"], input[inputmode="numeric"], input[type="tel"][maxlength="1"]',
        'input:not([type="hidden"]), textarea, select',
      ];
      for (const selecteur of candidats) {
        const el = [...document.querySelectorAll(selecteur)].find(visible);
        if (!el) continue;
        const bloc = el.closest('form') || el.parentElement || el;
        bloc.scrollIntoView({ block: 'center', behavior: 'instant' });
        return selecteur;
      }
      return null;
    });
    if (!cible) return;

    const premier = page
      .locator(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[inputmode="numeric"]'
      )
      .first();
    if (await premier.count()) await premier.focus().catch(() => {});
  } catch {
    // Étape sans champ visible (redirection, écran d'attente…) : sans gravité.
  }
}

// ---------------------------------------------------------------------------
// Pré-remplissage de l'identifiant (lot 13)
// ---------------------------------------------------------------------------

/**
 * Les clés de configuration qui portent un identifiant de connexion.
 *
 * ─── Pourquoi ce pré-remplissage existe ──────────────────────────────────────
 *
 * Le lot 12 affichait, sous le champ « Adresse électronique » de L'Atelier du
 * Portable : « Facultative : elle sert seulement à nommer le dossier de vos
 * documents. » C'était le choix spécifié, et c'était un mauvais choix. Quelqu'un
 * qui vient de saisir son identifiant dans crabe s'attend légitimement à ne pas
 * avoir à le retaper dans la fenêtre de connexion qui s'ouvre juste après.
 *
 * **Jamais de mot de passe.** Il n'est pas conservé pour cet usage sur les
 * connecteurs à navigateur distant — et quand bien même il le serait, le
 * pré-remplir mettrait un secret dans une fenêtre que l'utilisateur peut
 * partager par-dessus l'épaule sans y penser.
 */
const CLES_IDENTIFIANT = ['email', 'login', 'identifiant', 'username', 'utilisateur'];

/**
 * L'identifiant à pré-remplir, s'il y en a un de renseigné.
 *
 * Cherché parmi les champs DÉCLARÉS par le manifeste, jamais dans toute la
 * configuration : une clé nommée `login` dans un bloc technique ne doit pas
 * finir tapée dans un formulaire. Les champs de type `password` et `session`
 * sont écartés d'office, quel que soit leur nom.
 *
 * @param {object} manifest
 * @param {object} config configuration déchiffrée
 * @returns {string|null}
 */
function identifiantDeConfig(manifest, config) {
  for (const champ of manifest?.fields || []) {
    if (!champ?.key) continue;
    if (champ.type === 'password' || champ.type === 'session') continue;
    if (!CLES_IDENTIFIANT.includes(String(champ.key).toLowerCase())) continue;

    const valeur = String(config?.[champ.key] ?? '').trim();
    // Une valeur avec un saut de ligne n'est pas un identifiant : la frapper
    // validerait le formulaire au milieu de la saisie.
    if (valeur && !/[\r\n]/.test(valeur)) return valeur;
  }
  return null;
}

/**
 * Le champ d'identifiant d'un formulaire, par type PUIS par nom.
 *
 * L'ordre n'est pas indifférent : `type="email"` est le signal le plus sûr, un
 * `name="login"` vient ensuite, et le premier champ texte du formulaire n'est
 * qu'un dernier recours. Chercher d'abord par nom ferait taper l'identifiant
 * dans un champ « code postal » nommé `login_zip` sur une boutique mal balisée.
 */
const SELECTEURS_IDENTIFIANT = [
  'input[type="email"]',
  ...CLES_IDENTIFIANT.flatMap((cle) => [
    `input[name="${cle}"]`,
    `input[id="${cle}"]`,
    `input[autocomplete="username"]`,
  ]),
  'input[type="text"]',
];

/**
 * Saisit l'identifiant dans le champ correspondant, puis place le curseur dans
 * le mot de passe.
 *
 * **Frappé, pas injecté** : beaucoup de formulaires écoutent les événements
 * clavier et ignorent une valeur posée directement dans le DOM — c'est la même
 * raison qu'au §2 pour le collage.
 *
 * **Un champ introuvable n'est pas une erreur.** L'utilisateur saisira à la
 * main, exactement comme avant ; faire échouer l'ouverture d'une fenêtre de
 * connexion parce qu'un confort n'a pas pu s'appliquer serait absurde.
 *
 * @param {object} page page Playwright
 * @param {string} identifiant
 * @param {{delaiFrappeMs?: number}} [options]
 * @returns {Promise<{rempli: boolean, motDePasseVise: boolean}>}
 */
async function preremplirIdentifiant(page, identifiant, { delaiFrappeMs = 12 } = {}) {
  const texte = String(identifiant || '').trim();
  if (!texte) return { rempli: false, motDePasseVise: false };

  let rempli = false;
  try {
    for (const selecteur of SELECTEURS_IDENTIFIANT) {
      const champ = page.locator(selecteur).first();
      if (!(await champ.count())) continue;
      if (typeof champ.isVisible === 'function' && !(await champ.isVisible())) continue;

      // Un champ déjà rempli (navigateur qui a restauré une valeur, site qui
      // pré-remplit lui-même) ne doit pas être écrasé ni doublé.
      const dejaLa = await champ.inputValue().catch(() => '');
      if (String(dejaLa).trim()) {
        rempli = true;
        break;
      }

      await champ.click({ timeout: 5000 });
      await page.keyboard.type(texte, { delay: delaiFrappeMs });
      rempli = true;
      break;
    }
  } catch {
    // Page en cours de navigation, champ disparu : l'utilisateur saisira à la
    // main. Ce confort ne doit jamais faire échouer une connexion.
    return { rempli: false, motDePasseVise: false };
  }

  // Le curseur dans le mot de passe : c'est là que l'utilisateur va coller.
  let motDePasseVise = false;
  try {
    const motDePasse = page.locator(SELECTEUR_MOT_DE_PASSE).first();
    if (await motDePasse.count()) {
      await motDePasse.click({ timeout: 5000 });
      motDePasseVise = true;
    }
  } catch {
    /* pas de champ de mot de passe à cette étape : sans conséquence */
  }

  return { rempli, motDePasseVise };
}

/**
 * Signature des champs visibles d'une page.
 *
 * Une application monopage change d'écran sans événement de navigation : c'est
 * la seule façon de savoir qu'il faut recadrer le formulaire.
 *
 * @param {object} page
 * @returns {Promise<string>}
 */
async function fieldSignature(page) {
  try {
    return await page.evaluate(() => {
      const champs = [...document.querySelectorAll('input:not([type="hidden"])')].filter(
        (e) => e.getBoundingClientRect().height > 0
      );
      return champs.map((e) => e.type + (e.name || '')).join('|');
    });
  } catch {
    return '';
  }
}

module.exports = {
  MOTS_AUTHENTIFICATION,
  SELECTEUR_MOT_DE_PASSE,
  SELECTEUR_CHAMP_CODE,
  SELECTEUR_CODE_NOMME,
  SELECTEUR_CHAMP_IDENTIFIANT,
  SEUIL_GRILLE_CODE,
  DELAI_CONFIRMATION_MS,
  DELAI_COOKIES_TARDIFS_MS,
  CLES_IDENTIFIANT,
  SELECTEURS_IDENTIFIANT,
  identifiantDeConfig,
  preremplirIdentifiant,
  champActif,
  isAuthenticationUrl,
  estEtapeDuSite,
  inspect,
  isLoggedIn,
  attendUneSaisie,
  confirm,
  focusForm,
  fieldSignature,
};
