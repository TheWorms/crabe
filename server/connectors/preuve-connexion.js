'use strict';

/**
 * « Est-on VRAIMENT connecté ? » — la preuve positive, et rien de moins.
 *
 * ─── Le défaut que ce module supprime ────────────────────────────────────────
 *
 * Jusqu'au lot 14, le connecteur PrestaShop concluait à une connexion réussie
 * dès qu'aucun champ de mot de passe ne restait à l'écran. C'est une preuve par
 * l'absence, et elle est fausse : PrestaShop réaffiche la page de connexion
 * **sans le moindre message d'erreur** quand le POST arrive incomplet. D'où, en
 * production, le 11/08/2026 :
 *
 *     02:57:10  Propolia : connexion établie.
 *     02:57:11  Propolia : la page des commandes renvoie à l'authentification
 *               — la session n'a pas tenu.
 *
 * Une seconde. Une session ne meurt pas en une seconde : elle n'a jamais
 * existé.
 *
 * ─── Le défaut que le lot 14 avait laissé, et que celui-ci corrige ───────────
 *
 * Le lot 14 a exigé « DEUX marqueurs » — mais les a codés comme : une URL qui
 * n'est pas celle d'un formulaire, ET **un marqueur quelconque** pris dans une
 * liste plate. Le commentaire annonçait pourtant que les liens d'espace client
 * venaient « en second rang » parce qu'ils s'affichent aussi hors connexion.
 * Ce second rang n'existait que dans le commentaire : `SELECTEURS_COMPTE` était
 * un tableau parcouru en entier, et un seul résultat suffisait.
 *
 * Résultat, le 11/08/2026 à 15:24 :
 *
 *     15:24:34  Kubii : connexion confirmée (URL finale …controller=search&s=,
 *               espace client présent (a[href*="controller=my-account"]),
 *               8 cookie(s)).
 *     15:24:36  Kubii : la page des commandes … ne montre plus de compte
 *               connecté — URL finale …controller=authentication&back=history.
 *
 * Deux secondes. Le lien « Mon compte » de l'en-tête PrestaShop est affiché à
 * tout le monde : déconnecté, il mène au formulaire de connexion. Il ne prouve
 * donc rien. Le même faux positif sur L'Île aux Épices et Apiculture.net à la
 * même minute.
 *
 * ─── Ce qu'on exige désormais ────────────────────────────────────────────────
 *
 *   1. l'URL finale n'est plus celle d'un formulaire de connexion ;
 *   2. la page porte une PREUVE FORTE : un lien de déconnexion.
 *
 * Un lien de déconnexion est le seul élément qu'une page ne peut afficher qu'à
 * quelqu'un de connecté. Les espaces clients restent relevés — ils enrichissent
 * le journal et aident au diagnostic — mais ils ne concluent JAMAIS à eux
 * seuls.
 *
 * ─── Pourquoi c'est partagé ──────────────────────────────────────────────────
 *
 * La même question se pose au connecteur PrestaShop après la soumission du
 * formulaire, et au navigateur distant avant d'enregistrer une session captée
 * (huit cookies enregistrés à 03:07:16, session déjà morte à 03:07:19).
 * Deux réponses différentes à la même question, c'est deux occasions de se
 * tromper.
 */

/**
 * Ce qui, dans une URL, désigne une étape d'authentification.
 *
 * ⚠ `authentifi` et non `authentication` : Fantazia et Apiculture.net servent
 * leur formulaire sur `/authentification`, en français. L'expression du lot 13
 * ne cherchait que la forme anglaise, et laissait donc passer une redirection
 * vers la page de connexion de ces deux boutiques — d'où « page des commandes
 * atteinte » suivi de « aucune facture », alors que la page atteinte était le
 * formulaire de connexion.
 *
 * Seuls le CHEMIN et la REQUÊTE sont examinés, jamais le domaine : une boutique
 * qui s'appellerait « monconnexion.fr » n'est pas une page de connexion.
 *
 * ⚠ Les écrans de validation en deux temps (`/2fa`, `/otp`, `/mfa`,
 * `/two-factor`…) en font partie depuis le 14/08/2026 : la page `/2fa` de
 * Hetzner porte un lien logout — une « preuve forte » — et une demi-session
 * (mot de passe passé, code jamais saisi) s'y faisait déclarer `confirme`.
 * C'est ce verdict qui a fait fermer la fenêtre de connexion pendant que
 * l'utilisateur tapait son code. Un écran qui réclame encore un facteur
 * d'authentification EST un formulaire, quoi qu'il affiche par ailleurs.
 *
 * ⚠ `/oauth2/authorize` (et `/oauth/authorize`) depuis le 28/08/2026 : la
 * session impots.gouv.fr rejouée finit sur
 * `cfspart-idp.impots.gouv.fr/oauth2/authorize?…&prompt=login` — un écran qui
 * redemande la connexion, que le motif ne reconnaissait pas (pas de `/login`
 * dans le chemin). Un utilisateur CONNECTÉ ne termine jamais sur cette
 * adresse : le fournisseur d'identité le renvoie aussitôt vers l'application.
 * Y RESTER est donc une étape d'authentification, pas une page de compte.
 */
const MOTIF_AUTHENTIFICATION =
  /controller=authentication|\/authentifi|\/authentication|\/connexion|\/se-connecter|\/identification|\/login|\/signin|\/2fa|\/mfa|\/otp|\/two-factor|\/twofactor|\/second-factor|\/oauth2?\/authorize/i;

/**
 * PREUVE FORTE — ce qu'une page ne peut montrer qu'à quelqu'un de connecté.
 *
 * Le lien de déconnexion, sous ses formes rencontrées. PrestaShop utilise
 * `?mylogout=` sur le thème classique et `controller=logout` ailleurs ; les
 * boutiques francisées écrivent `/deconnexion`.
 *
 * ⚠ Toute addition à cette liste doit satisfaire un test simple : l'élément
 * est-il ABSENT de la page quand on n'est pas connecté ? Si la réponse est
 * « pas toujours », il va dans INDICES_FAIBLES, pas ici.
 */
const PREUVES_FORTES = [
  'a[href*="logout"]',
  'a[href*="mylogout"]',
  'a[href*="deconnexion"]',
  'a[href*="déconnexion"]',
  'a[href*="se-deconnecter"]',
  'a[href*="/disconnect"]',
  // SoundCloud ne met AUCUN lien de déconnexion dans le document (il vit dans
  // un menu peint au clic). Mesuré le 18/08/2026 sur soundcloud.com/you/
  // subscriptions : le bouton de profil de l'en-tête est présent connecté (1)
  // et absent pour l'anonyme, qui est renvoyé en 401 vers /signin. Il passe
  // donc le test d'entrée de cette liste.
  '.header__userNavUsernameButton',
  // Même situation chez Deezer : pas de lien logout dans le document. Mesuré
  // le 18/08/2026 : le bouton de profil est présent connecté sur /fr/account
  // (1) et absent pour l'anonyme — qui est de toute façon renvoyé vers
  // account.deezer.com/fr/login/.
  '[data-testid="topbar-profile"]',
];

/**
 * INDICES FAIBLES — présents connecté comme déconnecté.
 *
 * L'en-tête PrestaShop affiche « Mon compte » à tout visiteur : déconnecté, ce
 * lien mène au formulaire de connexion. Ces sélecteurs sont donc relevés pour
 * le journal et le diagnostic, mais ne concluent jamais seuls. C'est très
 * précisément le faux positif de Kubii, L'Île aux Épices et Apiculture.net.
 */
const INDICES_FAIBLES = [
  'a[href*="controller=my-account"]',
  'a[href*="/mon-compte"]',
  'a[href*="/my-account"]',
  '#my-account',
  '.account-link',
  '[href*="mon-compte"]',
];

/**
 * L'ancienne liste plate, conservée pour les appelants qui l'importaient.
 * Les deux rangs sont désormais distincts : préférez `PREUVES_FORTES`.
 */
const SELECTEURS_COMPTE = [...PREUVES_FORTES, ...INDICES_FAIBLES];

/** Le chemin et la requête d'une URL — le domaine n'a rien à nous dire. */
function sansDomaine(brut) {
  try {
    const url = new URL(String(brut), 'https://exemple.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return String(brut || '');
  }
}

/**
 * Cette adresse est-elle celle d'un formulaire de connexion ?
 * @param {string} url
 */
function estUrlAuthentification(url) {
  return MOTIF_AUTHENTIFICATION.test(sansDomaine(url));
}

/** L'URL débarrassée de son fragment (`#…`). */
function sansFragment(brut) {
  const texte = String(brut || '');
  const diese = texte.indexOf('#');
  return diese === -1 ? texte : texte.slice(0, diese);
}

/**
 * L'adresse de contrôle a-t-elle TENU ? — la comparaison du lot 40, corrigée
 * du fragment (lot 68).
 *
 * Un fragment n'est pas un chemin : il ne part jamais vers le serveur, c'est
 * une note que l'application se laisse à elle-même. Mesuré le 28/08/2026 sur
 * claude.ai : l'application RAMÈNE la navigation vers son accueil en gardant
 * la cible en fragment — `/settings/billing` demandé, `/new#settings/billing`
 * affiché. Le fragment de l'adresse finale est donc écarté avant de juger.
 *
 * ⚠ SAUF quand l'adresse de contrôle déclare elle-même un fragment : chez
 * Electro Dépôt (`…/customer/account/#/order`, lot 52), la route de
 * l'application VIT dans le fragment, et l'écarter reviendrait à accepter
 * n'importe quelle page du compte. Dans ce cas, la comparaison reste entière.
 *
 * @param {string} urlFinale l'adresse affichée à la fin
 * @param {string} adresseControle l'adresse déclarée par le manifeste
 */
function adresseTenue(urlFinale, adresseControle) {
  const controle = String(adresseControle || '');
  if (!controle) return false;
  const finale = String(urlFinale || '');
  if (controle.includes('#')) return finale.startsWith(controle);
  return sansFragment(finale).startsWith(controle);
}

/**
 * Ces deux adresses sont-elles sur le MÊME SITE ?
 *
 * Même règle de suffixe que `session-state.domaineAutorise` : `deezer.com`
 * accepte `account.deezer.com`, jamais `deezer.com.exemple.net`. Le `www.`
 * initial est une notation, pas une différence. Sert à la preuve par renvoi
 * mesuré (lot 68) : une application peut réécrire son chemin, elle ne change
 * pas de site — un départ vers un AUTRE site, lui, ne prouve jamais rien.
 */
function memeSite(urlA, urlB) {
  let hoteA;
  let hoteB;
  try {
    hoteA = new URL(String(urlA)).hostname.toLowerCase().replace(/^www\./, '');
    hoteB = new URL(String(urlB)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  if (!hoteA || !hoteB) return false;
  return hoteA === hoteB || hoteA.endsWith(`.${hoteB}`) || hoteB.endsWith(`.${hoteA}`);
}

/**
 * Nettoie une URL que la boutique a mal fabriquée.
 *
 * Kubii redirige vers, littéralement :
 *
 *     https://www.kubii.com/fr/index.php?controller=authentication?back=history
 *
 * Deux `?` dans la même adresse — le second aurait dû être un `&`. crabe ne
 * construit pas cette forme ; il ne doit donc ni la reproduire, ni la rejouer
 * telle quelle. Cette fonction la rend exploitable pour le JOURNAL et pour un
 * éventuel rappel.
 *
 * @param {string} brut
 * @returns {string} l'adresse avec un seul `?`
 */
function normaliserUrl(brut) {
  const texte = String(brut || '');
  const premier = texte.indexOf('?');
  if (premier === -1) return texte;
  // Tout `?` au-delà du premier est un séparateur de paramètre mal écrit.
  return texte.slice(0, premier + 1) + texte.slice(premier + 1).replace(/\?/g, '&');
}

/**
 * Cherche une liste de sélecteurs dans une page.
 *
 * Rendu sous forme de LISTE des sélecteurs trouvés plutôt que d'un booléen :
 * c'est elle qui s'écrit au journal, et une ligne qui dit ce qui a été vu vaut
 * mille suppositions.
 *
 * @param {object} page page Playwright
 * @param {string[]} selecteurs
 * @returns {Promise<string[]>}
 */
async function chercherSelecteurs(page, selecteurs) {
  const trouves = [];
  for (const selecteur of selecteurs) {
    try {
      if (await page.locator(selecteur).count()) trouves.push(selecteur);
    } catch {
      // Page en cours de navigation : on ne conclut rien de ce sélecteur-là.
    }
  }
  return trouves;
}

/**
 * Les marqueurs MESURÉS d'un service, cherchés sur le DOM déjà affiché.
 *
 * ─── Pourquoi ils existent (lot 49) ──────────────────────────────────────────
 *
 * La preuve forte générique — le lien de déconnexion — suppose que la page en
 * porte un. Les boutiques modernes n'en affichent pas toujours (Boulanger le
 * range dans un composant peint au clic), et VÉRIFIER EN REDEMANDANT LA PAGE
 * est fragile par construction : le 23/08/2026, Darty affichait la page des
 * commandes dans la fenêtre pendant que DataDome rendait 403 à la seconde
 * requête du contrôle. La preuve se lit alors sur ce que la fenêtre MONTRE :
 * des marqueurs relevés sur la vraie page du service, déclarés par son
 * manifeste (`remoteLogin.marqueursFenetre`), et calibrés sur la FORME
 * (« N° » suivi de chiffres) — jamais sur une valeur réelle.
 *
 * Chaque marqueur porte `selecteur` (CSS) et/ou `texte` (motif, insensible à
 * la casse) :
 *
 *   - `selecteur` seul : l'élément est présent ;
 *   - `texte` seul     : le motif apparaît dans le texte de la page ;
 *   - les deux         : un élément du sélecteur porte le motif — la forme
 *                        « un <h3> qui affiche N° F… » de Boulanger, qu'un
 *                        sélecteur seul ne sait pas dire.
 *
 * Aucune requête réseau : tout se lit dans le document déjà affiché. Rendu en
 * LISTE de descriptions, comme `chercherSelecteurs` — c'est elle qui va au
 * journal.
 *
 * @param {object} page page Playwright
 * @param {Array<{selecteur?: string, texte?: string}>} marqueurs
 * @returns {Promise<string[]>}
 */
async function chercherMarqueursMesures(page, marqueurs) {
  const trouves = [];
  for (const marqueur of Array.isArray(marqueurs) ? marqueurs : []) {
    const selecteur = String(marqueur?.selecteur || '').trim();
    const texte = String(marqueur?.texte || '').trim();
    if (!selecteur && !texte) continue;
    try {
      if (!texte) {
        if (await page.locator(selecteur).count()) trouves.push(selecteur);
        continue;
      }
      const present = await page.evaluate(({ sel, motif }) => {
        const re = new RegExp(motif, 'i');
        if (sel) {
          return [...document.querySelectorAll(sel)].some((el) => re.test(el.innerText || ''));
        }
        return re.test(document.body?.innerText || '');
      }, { sel: selecteur, motif: texte });
      if (present) {
        trouves.push(selecteur ? `${selecteur} portant « ${texte} »` : `texte « ${texte} »`);
      }
    } catch {
      // Page en cours de navigation : on ne conclut rien de ce marqueur-là.
    }
  }
  return trouves;
}

/**
 * Les marqueurs de compte d'une page, séparés par rang.
 *
 * @param {object} page page Playwright
 * @returns {Promise<{fortes: string[], faibles: string[]}>}
 */
async function preuvesCompte(page) {
  return {
    fortes: await chercherSelecteurs(page, PREUVES_FORTES),
    faibles: await chercherSelecteurs(page, INDICES_FAIBLES),
  };
}

/**
 * Tous les marqueurs, sans distinction de rang.
 *
 * Conservée pour les appelants existants. Ne l'utilisez pas pour CONCLURE :
 * c'est exactement l'erreur que ce module corrige.
 *
 * @param {object} page page Playwright
 * @returns {Promise<string[]>}
 */
async function marqueursCompte(page) {
  const { fortes, faibles } = await preuvesCompte(page);
  return [...fortes, ...faibles];
}

/** Une description courte du marqueur trouvé, pour le journal. */
function decrireMarqueur(selecteur) {
  if (!selecteur) return 'aucun marqueur de compte';
  if (/logout|deconnexion|déconnexion|disconnect/i.test(selecteur)) {
    return 'lien de déconnexion présent';
  }
  return `espace client présent (${selecteur})`;
}

/**
 * La connexion est-elle PROUVÉE sur cette page ?
 *
 * Ne lève jamais : une page en cours de navigation rend simplement
 * `confirme: false`, et l'appelant réessaiera ou conclura à l'échec.
 *
 * @param {object} page page Playwright
 * @param {{cookies?: number}} [options] nombre de cookies du contexte, pour le
 *   journal — jamais leurs valeurs, jamais leurs noms ici.
 * @returns {Promise<{confirme: boolean, url: string, surFormulaire: boolean,
 *                    preuvesFortes: string[], indicesFaibles: string[],
 *                    marqueurs: string[], cookies: number|null}>}
 */
async function verifier(page, { cookies = null } = {}) {
  let url = '';
  try {
    url = String(page.url());
  } catch {
    /* page fermée */
  }

  const surFormulaire = estUrlAuthentification(url);
  const { fortes, faibles } = await preuvesCompte(page);

  return {
    // Une URL hors formulaire ET une PREUVE FORTE. Un indice faible seul ne
    // conclut jamais : c'est le faux positif de Kubii du 11/08 à 15:24:34.
    confirme: !surFormulaire && fortes.length > 0,
    url: normaliserUrl(url),
    surFormulaire,
    preuvesFortes: fortes,
    indicesFaibles: faibles,
    // Compatibilité avec les appelants qui lisaient `marqueurs`.
    marqueurs: [...fortes, ...faibles],
    cookies,
  };
}

/**
 * La ligne de journal d'une connexion confirmée.
 *
 * C'est cette ligne, et son pendant en échec, qui permettent de trancher au
 * prochain incident sans redemander à l'administrateur ce que voyait le navigateur.
 */
function ligneConfirmee(nom, preuve) {
  const morceaux = [`URL finale ${preuve.url}`, decrireMarqueur(preuve.preuvesFortes[0])];
  if (preuve.indicesFaibles?.length) {
    morceaux.push(`${preuve.indicesFaibles.length} indice(s) d'espace client`);
  }
  if (preuve.cookies !== null && preuve.cookies !== undefined) {
    morceaux.push(`${preuve.cookies} cookie(s)`);
  }
  return `${nom} : connexion confirmée (${morceaux.join(', ')}).`;
}

/**
 * Ce qui manquait, dit précisément.
 *
 * Trois situations distinctes, trois formulations — parce que « aucun marqueur
 * de compte » et « seulement un lien Mon compte, qui ne prouve rien » appellent
 * des vérifications différentes au prochain incident.
 */
function decrireManque(preuve) {
  if (preuve.preuvesFortes?.length && preuve.surFormulaire) {
    return "lien de déconnexion présent mais URL d'authentification";
  }
  if (preuve.indicesFaibles?.length) {
    return `aucun lien de déconnexion — seulement ${preuve.indicesFaibles[0]}, `
      + 'affiché aussi hors connexion';
  }
  return 'aucun marqueur de compte';
}

/**
 * La ligne de journal d'une connexion NON confirmée.
 *
 * Elle part au journal MÊME quand le connecteur bascule ensuite sur un autre
 * message pour l'utilisateur.
 *
 * @param {string} nom
 * @param {object} preuve résultat de `verifier()`
 * @param {string} [alerte] le message d'erreur AFFICHÉ par la boutique
 */
function ligneNonConfirmee(nom, preuve, alerte = '') {
  const morceaux = [
    `URL finale ${preuve.url || '(inconnue)'}`,
    decrireManque(preuve),
    alerte ? `message de la boutique « ${alerte} »` : "aucun message d'erreur affiché par la boutique",
  ];
  if (preuve.cookies !== null && preuve.cookies !== undefined) {
    morceaux.push(`${preuve.cookies} cookie(s)`);
  }
  return `${nom} : connexion NON confirmée — ${morceaux.join(', ')}.`;
}

module.exports = {
  MOTIF_AUTHENTIFICATION,
  PREUVES_FORTES,
  INDICES_FAIBLES,
  SELECTEURS_COMPTE,
  sansDomaine,
  estUrlAuthentification,
  sansFragment,
  adresseTenue,
  memeSite,
  normaliserUrl,
  chercherSelecteurs,
  chercherMarqueursMesures,
  preuvesCompte,
  marqueursCompte,
  decrireMarqueur,
  decrireManque,
  verifier,
  ligneConfirmee,
  ligneNonConfirmee,
};
