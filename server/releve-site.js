'use strict';

/**
 * Relever un site — l'archive pour écrire un connecteur (1.0.0).
 *
 * ─── Ce que ce module remplace ───────────────────────────────────────────────
 *
 * Jusqu'ici, écrire un connecteur commençait par `scripts/releve-page.js`,
 * collé à la main dans la console du navigateur (F12), page après page, et
 * chaque relevé envoyé à part. Trois défauts, tous mesurés en écrivant les
 * connecteurs : la console est un geste de développeur ; le relevé ne voit pas
 * la chaîne des renvois de la connexion ; et surtout il ne voit pas ce que
 * déclenche le clic sur « Facture » — un téléchargement, un appel réseau qui
 * sert le PDF, un nouvel onglet (Boulanger, VistaPrint : lot 50). C'est
 * presque toujours là que le premier essai d'un connecteur échouait.
 *
 * Ici, n'importe quel compte tape l'adresse du site (Connecteurs › Proposer
 * un service) ; crabe ouvre SA fenêtre de connexion (le Chromium visible de
 * remote-browser.js, sans capture de session) et enregistre le passage :
 * chaque page, masquée comme le relevé de console ; chaque réponse de
 * navigation (statut, renvoi, NOMS des cookies) ; chaque clic, décrit par
 * l'élément cliqué ; chaque document servi (téléchargement, réponse réseau,
 * onglet) ; la FORME des réponses JSON des appels de la page. « Terminer le
 * relevé » range le tout dans un dossier, que l'écran rend en une archive
 * `.zip` — que crabe envoie lui-même, à la demande (`envoyer`, 1.0.0), ou
 * que l'on télécharge.
 *
 * Le relevé est GUIDÉ : quatre étapes se cochent d'elles-mêmes à mesure que
 * crabe les voit (`noterEtapes`) — la page de connexion, la connexion, la
 * liste des documents, un document ouvert. Ce sont des indices lus sur les
 * copies de page, jamais une garde : on peut terminer à tout moment, et
 * l'archive dit alors ce qui lui manque.
 *
 * ─── Ce qui n'y entre JAMAIS ─────────────────────────────────────────────────
 *
 *   - rien de ce qui est tapé : aucun champ n'est lu (les copies de page
 *     perdent leurs `value`), aucun corps de requête n'est lu — l'envoi du
 *     formulaire de connexion porte le mot de passe, il ne sort pas d'ici ;
 *   - aucune valeur de cookie ni d'en-tête : des NOMS de cookies seulement ;
 *   - aucune adresse complète : l'hôte, le chemin dont chaque segment qui
 *     ressemble à un identifiant devient `…`, et les NOMS des paramètres ;
 *   - aucun texte de page hors des liens, boutons, titres, étiquettes et
 *     en-têtes de tableau, lesquels perdent courriels et TOUS leurs chiffres
 *     (un montant, une date, un numéro) ;
 *   - les mots que le compte a demandé de retirer (son nom, son prénom) :
 *     crabe ne peut pas deviner un nom écrit dans un lien ou un titre. Ils ne
 *     vivent qu'en mémoire, le temps du relevé — ni écrits, ni journalisés ;
 *   - aucune valeur d'une réponse JSON : ses clés et le type de chaque valeur ;
 *   - aucun document : de chacun, s'il est un PDF, son nombre de pages et
 *     son poids. Le fichier téléchargé est effacé aussitôt lu.
 *
 * Le masquage est fait DANS la page (le code de `squeletteDeLaPage`), puis
 * refait ici sur tout ce qui en revient (`nettoyerInstantane`) : la page est
 * celle d'un site tiers, ce qu'elle rend est une donnée, jamais une
 * instruction. Les copies de page sont écrites avec une politique de sécurité
 * qui interdit tout script et tout chargement : ouvertes depuis l'archive,
 * elles ne contactent rien.
 *
 * ─── Qui, où, combien ────────────────────────────────────────────────────────
 *
 * Tout compte connecté (routes/releves.js), et chacun ne voit que les siens.
 * Un relevé à la fois pour tout crabe — il n'y a qu'une fenêtre sur le
 * serveur. Les relevés vivent sous `config.relevesDir` (`<dataDir>/releves`),
 * un dossier par compte, fichiers en 0600 : les vingt derniers de chaque
 * compte, trente jours au plus. « Fermer / Abandonner », un délai
 * d'inactivité ou une erreur n'enregistrent rien.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const navigation = require('./connectors/releve-navigation');

/** La clé de la fenêtre chez le gestionnaire : jamais l'identifiant d'un connecteur. */
const ID_FENETRE = 'releve:site';

/**
 * Où part l'archive (1.0.0) : crabe l'envoie lui-même, par le SMTP du serveur.
 * L'adresse ne sort plus d'ici : ni l'écran, ni l'archive, ni le journal ne
 * la donnent.
 */
const ADRESSE_ENVOI = 'crabe23@proton.me';
const OBJET_ENVOI = 'Demande d\'ajout d\'un connecteur';
/** Un relevé ne part pas plus de trois fois, et son archive pas au-delà de 20 Mo. */
const ENVOIS_MAX = 3;
const ARCHIVE_MAX_OCTETS = 20 * 1024 * 1024;
const MESSAGE_MAX = 2000;
/** Le carnet des envois d'un relevé : hors de l'archive (`fichiers` ne le liste pas). */
const FICHIER_ENVOIS = 'envois.json';

/** Au-delà, les copies de page suivantes ne sont plus prises — et le relevé le dit. */
const PAGES_MAX = 60;
const EVENEMENTS_MAX = 1500;
const REQUETES_MAX = 300;
const DOCUMENTS_MAX = 60;
const CLICS_MAX = 400;
const CADRES_MAX = 5;

/** Une copie de page plus grosse n'apprend plus rien et remplit le disque. */
const SQUELETTE_MAX_OCTETS = 600 * 1024;
/**
 * Toutes les copies d'un relevé, ensemble : elles vivent en MÉMOIRE jusqu'à
 * « Terminer ». Passé ce poids, plus aucune n'est prise — le relevé le dit.
 */
const COPIES_MAX_OCTETS = 12 * 1024 * 1024;
/** Une réponse JSON plus grosse n'est pas lue : sa forme n'est pas relevée. */
const CORPS_JSON_MAX_OCTETS = 2 * 1024 * 1024;
/** Au-delà, un document n'est lu qu'en tête : PDF ou non, mais pas ses pages. */
const CORPS_DOCUMENT_MAX_OCTETS = 8 * 1024 * 1024;

/**
 * Les attentes sont TOUTES bornées : une page figée, une réponse qui ne finit
 * pas ou un téléchargement interminable ne retiennent ni le relevé, ni sa fin.
 */
const DELAI_COPIE_MS = 8000;
const DELAI_CORPS_MS = 10000;
const DELAI_TELECHARGEMENT_MS = 60000;

/** La copie d'une page est prise quand elle s'est tenue tranquille ce temps-là. */
const DELAI_INSTANTANE_MS = 2000;
/** Un document arrivé dans ce délai après un clic est rattaché à ce clic. */
const CLIC_RECENT_MS = 15000;
/** Le flux tombé (un onglet fermé), la fenêtre d'un relevé attend ce temps qu'on la reprenne. */
const SURSIS_REPRISE_MS = 5 * 60 * 1000;
/** « Terminer » n'attend pas plus longtemps un téléchargement en cours. */
const ATTENTE_FIN_MS = 8000;

const MAX_RELEVES = 20;
const MAX_JOURS = 30;

/** Le préfixe des messages de clic que la page envoie à sa console (voir SCRIPT_CLIC). */
const MARQUE_CLIC = 'crabe-releve:clic ';

/** La phrase du bandeau de la fenêtre. */
const CONSIGNE =
  'Connectez-vous comme d\'habitude, puis allez jusqu\'à vos factures et ouvrez-en une. '
  + 'crabe relève chaque page en passant — jamais ce que vous tapez. Cliquez « Terminer le relevé » '
  + 'à la fin ; « Fermer / Abandonner » ne garde rien.';

/** Les mots qui font d'une page une liste de documents (titres) et d'un lien un document. */
const MOTS_LISTE = /factur|invoice|re[çc]us?\b|receipts?\b|commandes?\b|orders?\b|documents?\b|historique|history|billing|relev[ée]s?\b|attestations?\b|justificatifs?\b|achats?\b|purchases?\b|rechnung/i;
const MOTS_LIEN_DOCUMENT = /factur|invoice|re[çc]u|receipt|pdf|t[ée]l[ée]charg|download|attestation|justificatif|rechnung/i;

/** Au plus tant de mots à retirer de l'archive, de deux à quarante caractères. */
const MOTS_A_RETIRER_MAX = 8;

// ---------------------------------------------------------------------------
// Masquage (fonctions pures, testées)
// ---------------------------------------------------------------------------
//
// Tout ce qui passe ici vient d'une page tierce, qui peut mentir : le code de
// `squeletteDeLaPage` tourne DANS la page, et une page hostile lui fait rendre
// ce qu'elle veut. Deux règles en découlent, tenues par chaque fonction :
//
//   - l'entrée est COUPÉE avant la moindre expression régulière (`borner`) :
//     aucune ne voit plus de quelques centaines de caractères, un texte
//     fabriqué pour les ralentir ne fige rien ;
//   - c'est ICI que le masquage fait foi. Celui de la page n'est qu'une
//     première passe : `nettoyerHtml` reconstruit chaque copie, balise par
//     balise, et ne laisse passer que ce qu'il a lui-même écrit.

/**
 * Coupe un texte avant de le masquer : quatre fois la longueur gardée, plus
 * une marge ; le dernier mot — peut-être coupé au milieu d'un courriel ou d'un
 * nombre — est écarté.
 */
function borner(texte, max) {
  const s = String(texte ?? '');
  const borne = 4 * max + 200;
  return s.length > borne ? s.slice(0, borne).replace(/\S*$/, '') : s;
}

/**
 * Un texte de page tel qu'un relevé peut le garder : courriels, salutation
 * suivie d'un prénom, nombres de quatre chiffres et plus — les règles de
 * `scripts/releve-page.js`, refaites côté serveur. La salutation est un MOT
 * entier suivi d'un blanc : « historique » n'en est pas une.
 */
/** Les caractères invisibles qui coupent un mot sans se voir : un courriel « camille.martin\u200b@… » en est un. */
const INVISIBLES = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
/** Un courriel, lettres accentuées comprises (« hélène.dupré@exemple.fr »). */
const COURRIEL = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/gu;

function masquerTexte(texte, max = 200) {
  return borner(texte, max)
    .replace(INVISIBLES, '')
    .replace(COURRIEL, '<e-mail>')
    .replace(/\b(bonjour|bonsoir|hello|hi|salut|bienvenue)\b[\s,]+[^\s<]+/gi, '$1 …')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Un LIBELLÉ de page (lien, bouton, titre, étiquette, nom de fichier) : comme
 * `masquerTexte`, et plus un seul chiffre — un montant, une date ou un numéro
 * de commande écrits dans un titre ne passent pas. Pure.
 */
function masquerLibelle(texte, max = 200) {
  // Le courriel d'abord, les chiffres ensuite : « camille.martin75@… » est un
  // courriel, pas « camille.martin#@… ».
  return masquerTexte(texte, max).replace(/\d+/g, '#').replace(/#(?:[\s.,/:-]*#)+/g, '#');
}

/**
 * Les mots que le compte demande de retirer de l'archive (son nom, son
 * prénom) : séparés par des espaces ou des virgules, lettres, chiffres,
 * apostrophes et traits d'union seulement, huit au plus. Le reste est écarté
 * sans bruit — ce champ est un confort, pas une saisie à valider. Pure.
 * @returns {string[]}
 */
function motsARetirer(saisie) {
  return [...new Set(String(saisie ?? '')
    .slice(0, 2000)
    .normalize('NFC')
    .split(/[\s,;]+/)
    .map((m) => m.trim())
    .filter((m) => /^[\p{L}\p{N}'’-]{2,40}$/u.test(m))
    .map((m) => m.toLowerCase()))]
    .slice(0, MOTS_A_RETIRER_MAX);
}

/** Les lettres qu'un site écrit avec ou sans accent : « Hélène », « HELENE », « helene-dupre ». */
const VARIANTES = {
  a: 'aàâäáãå', c: 'cç', e: 'eéèêë', i: 'iîïíì', n: 'nñ', o: 'oôöóòõ', u: 'uùûüú', y: 'yÿý',
};
const sansAccents = (t) => String(t).normalize('NFD').replace(/\p{M}/gu, '');

/**
 * L'expression d'un mot à retirer. Chaque lettre telle qu'elle a été tapée
 * (« ř », « ț », « 김 »), sa forme sans accent et, pour les lettres latines
 * courantes, leurs autres accents ; une marque combinante qui suit est
 * avalée (un texte en forme décomposée). Les deux apostrophes se valent.
 */
function motifDuMot(mot) {
  return [...String(mot).normalize('NFC').toLowerCase()]
    .map((c) => {
      if (c === '\'' || c === '’') return '[\'’]';
      const base = sansAccents(c);
      const formes = new Set([c, ...(base.length === 1 ? [base, ...(VARIANTES[base] || '')] : [])]);
      return `(?:${[...formes].map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\p{M}*`;
    })
    .join('');
}

/** Les expressions d'une liste de mots, compilées une fois par liste (et oubliées avec elle). */
const EXPRESSIONS_DES_MOTS = new WeakMap();
function expressionsDe(mots) {
  let e = EXPRESSIONS_DES_MOTS.get(mots);
  if (!e) {
    e = mots.map(motifDuMot).filter(Boolean).map((m) => new RegExp(`(?<![\\p{L}\\p{N}])${m}(?![\\p{L}\\p{N}])`, 'giu'));
    EXPRESSIONS_DES_MOTS.set(mots, e);
  }
  return e;
}

/**
 * Retire des mots d'un texte, en mots entiers, sans égard à la casse ni aux
 * accents : chacun devient « … ». Pure. Appliquée aux TEXTES (un libellé, une
 * valeur d'attribut, une ligne de parcours), jamais à un fichier assemblé :
 * un mot qui serait aussi une balise ou une clé n'abîme ni une copie de page,
 * ni releve.json.
 */
function retirerMots(texte, mots) {
  let s = String(texte ?? '');
  if (!Array.isArray(mots) || !mots.length) return s;
  s = s.normalize('NFC');
  for (const e of expressionsDe(mots)) s = s.replace(e, '…');
  return s;
}

// ---------------------------------------------------------------------------
// Un nom que le site affiche près du compte, retiré d'office (1.0.1)
// ---------------------------------------------------------------------------
//
// Mesuré sur le premier relevé réel (une boutique PrestaShop, 12/11/2026) : elle
// écrit le prénom et le nom du compte dans le lien « Voir mon compte » de son
// en-tête, et dans le bouton de son menu de déconnexion. Un lien PARLE : son
// texte était gardé, et le nom avec lui — le champ « votre nom » n'avait pas
// été rempli. crabe ne connaît pas ce nom, mais il sait où le chercher : dans
// la ZONE DU COMPTE, un élément dont la classe, l'identifiant, l'infobulle,
// l'étiquette ou le chemin du lien parlent de compte, d'utilisateur, de
// connexion — lui ou l'un de ses trois ancêtres les plus proches (jamais la
// page entière : PrestaShop marque tout le corps de « page-customer-account »).
// Là, un libellé n'a que des mots ordinaires (« Mon profil », « Se
// déconnecter », « Retour à votre compte ») ; un mot qui n'en est pas un est
// celui du compte : le texte devient « … », et ce mot est retiré de toute
// l'archive, comme un mot donné à retirer.

/**
 * Les MOTS qui désignent la zone du compte, dans une classe, un identifiant,
 * une infobulle ou un chemin : des mots entiers, seuls ou accolés à leur
 * voisin (« sign-in », « user_info », « myAccount ») — « connecteurs » ou
 * « compteur » n'en sont pas. « client » seul n'en est pas un non plus : chez
 * cette boutique, c'est le service client et la fenêtre de discussion.
 */
const SIGNAUX_COMPTE = new Set(`
  account myaccount compte moncompte user username userinfo usermenu customer espaceclient clientarea
  profil profile member membre signin signout signup login logout connexion deconnexion connecter connectez
  deconnecter connected disconnect identity identite avatar utilisateur greeting welcome bienvenue
  myspace espaceperso monespace
`.split(/\s+/).filter(Boolean));
/** Au-delà de l'élément et de ses trois ancêtres, la zone du compte s'arrête. */
const ZONE_COMPTE_PROFONDEUR = 4;
/** Les mots détectés d'office : huit au plus, comme ceux que le compte donne. */
const MOTS_DU_SITE_MAX = 8;
/** Les mots ordinaires d'une zone de compte, sans accents. */
const MOTS_DE_COMPTE = new Set(`
  mon ma mes votre vos ton ta tes notre nos le la les l un une des de du d a au aux et ou en sur pour par avec sans
  se s me m vous tu il elle on y ne pas plus ici ce cet cette ces qui que quoi etes est suis avez ai
  compte comptes espace client cliente clients personnel personnelle perso prive privee particulier particuliers
  professionnel professionnels professionnelle pro entreprise entreprises societe administration admin
  connecter connectez connexion deconnecter deconnectez deconnexion reconnecter reconnectez
  identifier identifiez identification identifiant identifiants inscription inscrire inscrivez creer creez enregistrer
  mot mots passe oublie oubliez oublies
  profil informations information infos donnees adresse adresses parametres reglages preferences securite
  commande commandes facture factures achat achats historique detail details suivi retour retours avoir avoirs
  bon bons reduction reductions fidelite point points cadeau cadeaux alerte alertes favori favoris liste listes
  envie envies souhait souhaits panier abonnement abonnements newsletter lettre
  accueil aide contact contacts menu ouvrir fermer voir acceder afficher gerer modifier deroulante tableau bord
  bonjour bonsoir bienvenue salut
  my your our the an of to in on for and or with
  account accounts sign signin signout signup in out up log login logout register registration create forgot
  forgotten password email e-mail mail username user users profile settings preferences information
  orders order history invoices invoice billing returns wishlist favorites favourites cart basket
  dashboard overview home help open close view manage edit hello hi welcome personal business company
  customer customers member members area dropdown
`.split(/\s+/).filter(Boolean));

/** Un mot de la zone du compte est-il ordinaire ? « connectez-vous », « s'inscrire » le sont, morceau par morceau. */
function motOrdinaire(mot) {
  const m = sansAccents(mot).toLowerCase();
  return MOTS_DE_COMPTE.has(m) || m.split(/['’-]/).filter(Boolean).every((p) => MOTS_DE_COMPTE.has(p));
}

/**
 * Les mots d'un libellé de la zone du compte qui n'y sont pas ordinaires —
 * ceux d'un nom. Une lettre seule (une initiale), « # » et « … » ne comptent
 * pas. Pure.
 */
function motsDuCompte(libelle) {
  return (String(libelle ?? '').normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) || [])
    .map((m) => m.replace(/['’-]+$/, ''))
    .filter((m) => [...m].length >= 2 && !/^\p{N}+$/u.test(m) && !motOrdinaire(m));
}

/** Les attributs d'un élément disent-ils la zone du compte ? Le chemin d'un lien compte, jamais sa requête. */
function signaleLeCompte(attributs) {
  let signes = '';
  for (const cle of ['class', 'id', 'title', 'aria-label', 'name', 'data-testid', 'href']) {
    let v = String(attributs.get(cle) ?? '');
    if (!v) continue;
    // Le CHEMIN d'un lien, sans son hôte : « espace-client.exemple.fr » ne fait pas de tout lien un lien du compte.
    if (cle === 'href') v = v.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, '').split(/[?#]/)[0];
    signes += ` ${v.slice(0, 400)}`;
  }
  return signeDuCompte(signes);
}

/** Des attributs mis bout à bout parlent-ils du compte ? Mot à mot, et chaque mot accolé au suivant. */
function signeDuCompte(signes) {
  const mots = sansAccents(String(signes).slice(0, 4000))
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const connu = (m) => SIGNAUX_COMPTE.has(m) || (m.endsWith('s') && SIGNAUX_COMPTE.has(m.slice(0, -1)));
  return mots.some((m, i) => connu(m) || (i + 1 < mots.length && connu(m + mots[i + 1])));
}

/** Note des mots détectés d'office (sous la forme d'un mot à retirer), dans la limite. */
function noterMotsDuSite(trouves, mots) {
  if (!trouves) return;
  for (const m of mots) {
    if (trouves.size >= MOTS_DU_SITE_MAX) return;
    const mot = String(m).normalize('NFC').toLowerCase();
    if (/^[\p{L}\p{N}'’-]{2,40}$/u.test(mot)) trouves.add(mot);
  }
}

/** Applique une fonction à chaque chaîne d'une valeur (objets et tableaux compris), clés à la demande. */
function partout(valeur, f, { cles = false } = {}) {
  if (typeof valeur === 'string') return f(valeur);
  if (Array.isArray(valeur)) return valeur.map((v) => partout(v, f, { cles }));
  if (valeur && typeof valeur === 'object') {
    return Object.fromEntries(Object.entries(valeur).map(([k, v]) => [cles ? f(k) : k, partout(v, f, { cles })]));
  }
  return valeur;
}

/**
 * Une adresse telle qu'un relevé l'écrit : schéma, hôte, chemin masqué
 * segment par segment (`releve-navigation.cheminMasque`), puis les NOMS des
 * paramètres entre crochets — jamais leurs valeurs, jamais le fragment.
 * `https://site.fr/compte/factures?[annee,page]`. Une requête sans « = » est
 * une VALEUR (un jeton, un chemin), pas un nom : elle devient « … ». Chaque
 * morceau est borné. Pure.
 */
function adresseReleve(url, base = undefined) {
  try {
    const u = new URL(String(url ?? '').slice(0, 4000), base === undefined ? undefined : String(base).slice(0, 4000));
    if (!/^https?:$/.test(u.protocol)) return `${u.protocol.slice(0, 40)}…`;
    const morceaux = u.search.slice(1).split('&').filter(Boolean);
    const cles = [...new Set(morceaux.slice(0, 100).map((p) => {
      const i = p.indexOf('=');
      if (i < 0) return '…';
      // « MTIz…MA== », « eyJ….sig= » : une valeur en base 64 et son bourrage,
      // pas un nom au contenu vide.
      if (/^=*$/.test(p.slice(i + 1)) && (p.endsWith('==') || navigation.segmentIdentifiant(p.slice(0, i)))) return '…';
      let nom = p.slice(0, Math.min(i, 200));
      try {
        nom = decodeURIComponent(nom.replace(/\+/g, ' '));
      } catch {
        /* gardé tel quel */
      }
      return masquerTexte(nom, 40) || '…';
    }))].slice(0, 30);
    const chemin = navigation.cheminMasque(u.pathname.slice(0, 2000));
    return `${u.protocol}//${u.hostname.slice(0, 255)}${u.port ? `:${u.port}` : ''}`
      + (chemin.length > 400 ? `${chemin.slice(0, 400)}…` : chemin)
      + (cles.length ? `?[${cles.join(',')}]` : '')
      + (u.hash ? '#…' : '');
  } catch {
    return '(adresse illisible)';
  }
}

/**
 * L'adresse tapée par la personne, rendue visitable : `https://` ajouté s'il
 * manque, http(s) seulement, jamais d'identifiants dans l'adresse. Lève une
 * erreur lisible sinon. Pure.
 */
function normaliserAdresse(saisie) {
  let texte = String(saisie ?? '').trim();
  if (!texte) throw erreur('Indiquez l\'adresse du site à relever.', 400);
  if (texte.length > 2000) throw erreur('Cette adresse est trop longue : donnez celle de l\'accueil du site.', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(texte)) texte = `https://${texte}`;
  let u;
  try {
    u = new URL(texte);
  } catch {
    throw erreur('Cette adresse n\'est pas lisible : écrivez-la comme dans la barre du navigateur.', 400);
  }
  if (!/^https?:$/.test(u.protocol)) throw erreur('Seules les adresses http et https se relèvent.', 400);
  if (u.username || u.password) {
    throw erreur('L\'adresse ne doit pas contenir d\'identifiant ni de mot de passe.', 400);
  }
  if (!u.hostname || !u.hostname.includes('.')) {
    throw erreur('Il manque le nom du site (par exemple www.exemple.fr).', 400);
  }
  return u.href;
}

/**
 * La FORME d'une valeur JSON : ses clés, et pour chaque valeur son type —
 * jamais la valeur. Un tableau se dit par sa longueur et la forme de son
 * premier élément. Profondeur et nombre de clés bornés. Une clé suit la règle
 * des libellés (ni courriel, ni chiffre) : un objet indexé par numéro ou par
 * date se replie sur une seule entrée « # » ; une clé à espaces — un nom, une
 * phrase : une valeur rangée en clé — devient « … ». Pure.
 *
 * @returns {*} p. ex. `{ factures: ['tableau (12)', { id: 'nombre', pdf: 'texte' }] }`
 */
function formeJson(valeur, { profondeur = 6, budget = { cles: 300 } } = {}) {
  if (valeur === null) return 'null';
  if (Array.isArray(valeur)) {
    if (!valeur.length) return 'tableau (vide)';
    if (profondeur <= 0) return `tableau (${valeur.length})`;
    return [`tableau (${valeur.length})`, formeJson(valeur[0], { profondeur: profondeur - 1, budget })];
  }
  switch (typeof valeur) {
    case 'string': return 'texte';
    case 'number': return 'nombre';
    case 'boolean': return 'booléen';
    case 'object': {
      if (profondeur <= 0) return 'objet';
      const sortie = {};
      for (const [cle, v] of Object.entries(valeur)) {
        if (budget.cles-- <= 0) {
          sortie['…'] = 'clés suivantes non relevées';
          break;
        }
        const nom = /\s/.test(cle.trim()) || cle.length > 60 ? '…' : (masquerLibelle(cle, 60) || '(vide)');
        sortie[nom] = formeJson(v, { profondeur: profondeur - 1, budget });
      }
      return sortie;
    }
    default: return typeof valeur;
  }
}

/**
 * Ce qu'on peut dire d'un document sans le garder : est-ce un PDF (l'en-tête
 * `%PDF-` dans le premier kilo-octet), combien de pages (le plus grand
 * `/Count` d'un arbre de pages, à défaut les objets `/Type /Page`), et son
 * poids. `pages` vaut null quand rien ne permet de le lire (flux compressés).
 * L'écart entre `/Type /Pages` et `/Count` est borné : un faux PDF fabriqué
 * pour ralentir la lecture ne ralentit rien. Pure.
 */
function decrireDocument(corps, octets = null) {
  const tampon = Buffer.isBuffer(corps) ? corps : Buffer.alloc(0);
  const tete = tampon.subarray(0, 1024).toString('latin1');
  const pdf = tete.includes('%PDF-');
  let pages = null;
  if (pdf) {
    // Quatre mégaoctets suffisent à trouver l'arbre des pages d'une facture, et bornent la lecture.
    const texte = tampon.subarray(0, 4 * 1024 * 1024).toString('latin1');
    const comptes = [...texte.matchAll(/\/Type\s{0,8}\/Pages\b[^>]{0,400}?\/Count\s{1,8}(\d{1,7})|\/Count\s{1,8}(\d{1,7})[^>]{0,400}?\/Type\s{0,8}\/Pages\b/g)]
      .map((m) => Number(m[1] || m[2]))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 100000);
    if (comptes.length) pages = Math.max(...comptes);
    else {
      const objets = (texte.match(/\/Type\s{0,8}\/Page(?![a-zA-Z])/g) || []).length;
      pages = objets || null;
    }
  }
  return { pdf, pages, octets: Number.isFinite(octets) ? octets : tampon.length };
}

/** Le nom de fichier d'un `Content-Disposition`, masqué comme un libellé. Pure. */
function nomDeFichier(disposition) {
  const texte = String(disposition || '').slice(0, 1000);
  const etoile = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(texte);
  const simple = /filename\s*=\s*"?([^";]+)"?/i.exec(texte);
  let nom = (etoile && etoile[1]) || (simple && simple[1]) || '';
  try {
    nom = decodeURIComponent(nom);
  } catch {
    /* gardé tel quel */
  }
  return masquerLibelle(nom.replace(/^"|"$/g, ''), 120);
}

/** Le type d'un contenu, sans ses paramètres. Pure. */
function typeDe(enTetes) {
  return String(enTetes?.['content-type'] || '').slice(0, 200).split(';')[0].trim().toLowerCase().slice(0, 100);
}

/**
 * Une réponse porte-t-elle un document ? Un PDF déclaré, une pièce jointe,
 * ou un flux d'octets dont l'adresse finit en `.pdf`. Du JSON servi « en
 * pièce jointe » (une protection courante des API) reste un appel. Pure.
 */
function estDocument(enTetes, url = '') {
  const type = typeDe(enTetes);
  if (type === 'application/pdf' || type === 'application/x-pdf') return true;
  // Des données servies « en pièce jointe » (JSON, script, texte brut,
  // protobuf : une protection courante des API) restent un appel.
  if (/json|javascript|protobuf|^text\/plain$/.test(type)) return false;
  if (/\battachment\b/i.test(String(enTetes?.['content-disposition'] || '').slice(0, 1000))) return true;
  return type === 'application/octet-stream' && /\.pdf(?:$|[?#])/i.test(String(url).slice(0, 4000));
}

/**
 * Une copie de page rendue par la page, refaite proprement : textes masqués
 * à nouveau, longueurs bornées, mots à retirer retirés, et le HTML
 * RECONSTRUIT (`nettoyerHtml`). Pure.
 */
function nettoyerInstantane(brut, adresse, { mots: demandes = [], trouves = null } = {}) {
  const r = brut && typeof brut === 'object' ? brut : {};
  const liste = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  // Un nom dans la zone du compte est cherché d'abord, sur toute la page :
  // ailleurs dans la copie (le titre, un autre lien), il est déjà retiré.
  const duSite = trouves || new Set();
  nettoyerHtml(r.squelette, { mots: demandes, base: adresse, trouves: duSite });
  const mots = duSite.size ? [...new Set([...demandes, ...duSite])] : demandes;
  const sans = (t) => (mots.length ? retirerMots(t, mots) : t);
  const texte = (v, n = 120) => sans(masquerTexte(v, n));
  const libelle = (v, n = 120) => sans(masquerLibelle(v, n));
  const adr = (v) => (v ? sans(adresseReleve(v, adresse)) : '');
  return {
    adresse: sans(adresseReleve(adresse)),
    titre: libelle(r.titre, 120),
    // Trois indices pour le guidage (`noterEtapes`) : des booléens, rien d'autre.
    motDePasse: r.motDePasse === true,
    identifiant: r.identifiant === true,
    deconnexion: r.deconnexion === true,
    intertitres: liste(r.intertitres, 20).map((t) => libelle(t, 80)),
    formulaires: liste(r.formulaires, 10).map((f) => ({
      action: adr(f?.action),
      methode: texte(f?.methode, 30).toUpperCase(),
      champs: liste(f?.champs, 40).map((c) => ({
        balise: texte(c?.balise, 12),
        type: texte(c?.type, 20),
        nom: texte(c?.nom, 60),
        id: texte(c?.id, 60),
        autocomplete: texte(c?.autocomplete, 40),
        etiquette: libelle(c?.etiquette, 80),
        requis: !!c?.requis,
      })),
    })),
    liensUtiles: liste(r.liensUtiles, 60).map((l) => ({
      texte: libelle(l?.texte, 60),
      href: adr(l?.href),
      balise: texte(l?.balise, 120),
      ligne: texte(l?.ligne, 120),
    })),
    blocsRepetes: liste(r.blocsRepetes, 15)
      .filter((b) => Array.isArray(b))
      .map(([sig, n]) => [texte(sig, 120), Number(n) || 0]),
    iframes: liste(r.iframes, 8).map(adr),
    liens: Number(r.liens) || 0,
    boutons: Number(r.boutons) || 0,
    squelette: nettoyerHtml(r.squelette, { mots, base: adresse, trouves: duSite }),
  };
}

// ---------------------------------------------------------------------------
// La copie d'une page, RECONSTRUITE
// ---------------------------------------------------------------------------
//
// `nettoyerHtml` ne nettoie pas le HTML que la page a rendu : il le LIT, et en
// écrit un autre. Une balise n'entre dans la sortie que si elle n'est pas
// refusée, avec les seuls attributs d'une liste fermée, leurs valeurs
// réécrites ; un texte n'y entre que masqué et échappé, et seulement dans un
// élément « parlant » (lien, bouton, titre, étiquette, en-tête de tableau) —
// partout ailleurs il devient « … ». Rien de ce que la page a écrit n'est
// recopié tel quel : des balises imbriquées pour se recoller, un attribut
// exotique, un commentaire, une entité qui cache un « @ » ne passent pas,
// parce que la sortie ne contient que ce qui est écrit ici. Le tout en une
// passe : le temps est linéaire, quelle que soit l'entrée.

/** Ce qui ne s'écrit jamais dans une copie. */
const BALISES_REFUSEES = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'svg',
  'math', 'template', 'noscript', 'img', 'picture', 'video', 'audio', 'canvas', 'source', 'track', 'title',
  'head', 'html', 'body', 'param', 'portal', 'plaintext', 'xmp', 'listing', 'noembed', 'noframes',
]);
/** Celles dont le contenu part avec elles (du texte brut, ou un autre langage). */
const BLOCS_SAUTES = new Set([
  'script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'object', 'title', 'textarea', 'xmp',
  'plaintext', 'listing', 'noembed', 'noframes', 'video', 'audio', 'canvas', 'picture',
]);
const BALISES_VIDES = new Set(['area', 'br', 'col', 'hr', 'input', 'wbr']);
const BALISES_PARLANTES = new Set(['a', 'button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'legend', 'summary', 'caption']);
/** Leur texte n'est jamais gardé : les options d'une liste portent des valeurs (une adresse, un compte). */
const BALISES_MUETTES = new Set(['select', 'option', 'optgroup', 'datalist']);
const CHAMPS = new Set(['input', 'select', 'textarea']);
const ATTRIBUTS_DE_STRUCTURE = new Set([
  'class', 'id', 'data-testid', 'role', 'type', 'name', 'autocomplete', 'for', 'method', 'target', 'disabled', 'required',
]);
/** Des attributs qui PARLENT : gardés comme un texte — sur un élément parlant ou un champ, sans chiffre. */
const ATTRIBUTS_PARLANTS = new Set(['aria-label', 'title', 'placeholder', 'download']);

const DEBUT_DE_BALISE = /<(\/?)([a-zA-Z][a-zA-Z0-9._-]*)/y;
const HORS_NOM = /[\s"'<>/=]+/y;
const UN_ATTRIBUT = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/y;

/** Les entités qu'un navigateur écrit en sérialisant une page, et les numériques ; les autres restent du texte. */
function decoderEntites(texte) {
  return String(texte)
    .replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});/gi, (tout, hexa, dec) => {
      const code = hexa ? parseInt(hexa, 16) : Number(dec);
      return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&(lt|gt|quot|apos|nbsp|amp);/gi, (tout, nom) => ({ lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', amp: '&' }[nom.toLowerCase()]));
}
const echapperTexte = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const echapperAttribut = (t) => echapperTexte(t).replace(/"/g, '&quot;');

/** Où finit la balise ouverte en `depuis` : après son « > », guillemets respectés — ou -1 (jamais fermée, ou démesurée). */
function finDeBalise(s, depuis) {
  let guillemet = '';
  const limite = Math.min(s.length, depuis + 8000);
  for (let i = depuis; i < limite; i++) {
    const c = s[i];
    if (guillemet) {
      if (c === guillemet) guillemet = '';
    } else if (c === '"' || c === '\'') guillemet = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

/** Les attributs d'une balise, par leur nom en minuscules : le premier de chaque nom, soixante au plus. */
function lireAttributs(source) {
  const attributs = new Map();
  let i = 0;
  while (i < source.length && attributs.size < 60) {
    // Les blancs et signes entre deux attributs sont sautés d'un coup : le
    // temps reste linéaire, même sur une balise faite de huit mille blancs.
    HORS_NOM.lastIndex = i;
    if (HORS_NOM.test(source)) {
      i = HORS_NOM.lastIndex;
      continue;
    }
    UN_ATTRIBUT.lastIndex = i;
    const m = UN_ATTRIBUT.exec(source);
    if (!m || UN_ATTRIBUT.lastIndex <= i) {
      i++;
      continue;
    }
    i = UN_ATTRIBUT.lastIndex;
    const nom = m[1].toLowerCase();
    if (!attributs.has(nom)) attributs.set(nom, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attributs;
}

/**
 * Le HTML d'une copie de page, reconstruit (voir plus haut). `mots` : les mots
 * à retirer des textes et des valeurs d'attribut ; `base` : l'adresse de la
 * page, pour un lien relatif.
 */
function nettoyerHtml(html, { mots = [], base = undefined, trouves = null } = {}) {
  let s = String(html ?? '');
  let tronquee = false;
  if (s.length > SQUELETTE_MAX_OCTETS) {
    s = s.slice(0, SQUELETTE_MAX_OCTETS);
    tronquee = true;
  }
  const sans = (t) => (mots.length ? retirerMots(t, mots) : t);
  const sortie = [];
  // La SORTIE est bornée aussi : un lien relatif sur une adresse longue
  // s'écrit plus long qu'il ne se lit.
  let poids = 0;
  const ecrire = (morceau) => {
    poids += morceau.length;
    sortie.push(morceau);
  };
  /** Les éléments ouverts : { nom, parlant, muet, compte }. */
  const pile = [];
  const dessus = () => pile[pile.length - 1];
  /** L'élément du dessus, ou l'un de ses trois ancêtres, dit-il la zone du compte ? */
  const dansLeCompte = (k = pile.length) => {
    for (let j = k - 1; j >= 0 && j >= k - ZONE_COMPTE_PROFONDEUR; j--) if (pile[j].compte) return true;
    return false;
  };
  /**
   * Un libellé de la zone du compte qui a des mots d'un nom : « … », et ces
   * mots notés. Il arrive ici déjà privé des mots donnés à retirer : ceux-là
   * ne sont pas comptés deux fois.
   */
  const sansLeNom = (t, zone) => {
    if (!zone) return t;
    const inconnus = motsDuCompte(t);
    if (!inconnus.length) return t;
    noterMotsDuSite(trouves, inconnus);
    return '…';
  };

  const texte = (brut) => {
    const haut = dessus();
    if (!brut || (haut && haut.muet)) return;
    const t = masquerLibelle(decoderEntites(borner(brut, 200)), 200);
    if (!t) return;
    // Un « @ » resté là est la moitié d'un courriel, coupé par une balise.
    ecrire(haut && haut.parlant && t.length <= 60 && !t.includes('@') ? echapperTexte(sansLeNom(sans(t), dansLeCompte())) : '…');
  };

  const n = s.length;
  let i = 0;
  while (i < n) {
    if (poids > SQUELETTE_MAX_OCTETS) {
      tronquee = true;
      break;
    }
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      texte(s.slice(i));
      break;
    }
    if (lt > i) texte(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const f = s.indexOf('-->', lt + 4);
      i = f < 0 ? n : f + 3;
      continue;
    }
    DEBUT_DE_BALISE.lastIndex = lt;
    const m = DEBUT_DE_BALISE.exec(s);
    if (!m) {
      // Une déclaration (`<!doctype`, `<?xml`) part jusqu'à son « > » ; un « < » nu est un signe perdu.
      if (s[lt + 1] === '!' || s[lt + 1] === '?') {
        const f = s.indexOf('>', lt);
        i = f < 0 ? n : f + 1;
      } else i = lt + 1;
      continue;
    }
    const apresLeNom = DEBUT_DE_BALISE.lastIndex;
    const fin = finDeBalise(s, apresLeNom);
    // Une balise jamais fermée (la copie coupée en plein milieu) : le reste est écarté.
    if (fin < 0) break;
    const nom = m[2].toLowerCase();

    if (m[1] === '/') {
      let k = pile.length - 1;
      while (k >= 0 && pile[k].nom !== nom) k--;
      if (k >= 0) {
        for (let j = pile.length - 1; j >= k; j--) ecrire(`</${pile[j].nom}>`);
        pile.length = k;
      }
      i = fin;
      continue;
    }

    if (BLOCS_SAUTES.has(nom)) {
      // Son contenu n'est pas relevé : on saute jusqu'à sa fermeture — ou jusqu'au bout.
      const fermeture = new RegExp(`</${nom}\\s*>`, 'gi');
      fermeture.lastIndex = fin;
      const f = fermeture.exec(s);
      if (nom === 'textarea') ecrire(`<textarea${ecrireAttributs(nom, lireAttributs(s.slice(apresLeNom, fin - 1)), false, sans, base)}></textarea>`);
      i = f ? fermeture.lastIndex : n;
      continue;
    }
    if (BALISES_REFUSEES.has(nom)) {
      i = fin;
      continue;
    }

    const attributs = lireAttributs(s.slice(apresLeNom, fin - 1));
    const haut = dessus();
    // Un élément muet (une liste, ses options) ne parle pas : ni par son texte, ni par ses attributs.
    const muet = BALISES_MUETTES.has(nom) || !!(haut && haut.muet);
    const parlant = !muet && (BALISES_PARLANTES.has(nom) || /^(button|link|menuitem|tab)$/i.test(attributs.get('role') || '') || !!(haut && haut.parlant));
    const compte = signaleLeCompte(attributs);
    const zone = compte || dansLeCompte();
    ecrire(`<${nom}${ecrireAttributs(nom, attributs, parlant, sans, base, zone ? (t) => sansLeNom(t, true) : null)}>`);
    // Au-delà de cinq cents niveaux, la page n'est plus une page : la copie reste à plat.
    if (!BALISES_VIDES.has(nom) && pile.length < 500) {
      pile.push({ nom, parlant, muet, compte });
    }
    i = fin;
  }
  for (let j = pile.length - 1; j >= 0; j--) sortie.push(`</${pile[j].nom}>`);
  return sortie.join('') + (tronquee ? '\n<!-- copie tronquée : page trop longue -->' : '');
}

/** Les attributs qu'une copie garde, réécrits : la structure telle quelle (masquée), ce qui parle comme un texte, un lien comme une adresse relevée. */
function ecrireAttributs(nom, attributs, parlant, sans, base, duCompte = null) {
  let ecrits = '';
  for (const [cle, brut] of attributs) {
    const valeur = decoderEntites(String(brut ?? '').slice(0, 4000));
    if (cle === 'href') {
      const adresse = adresseReleve(valeur, base);
      if (/^https?:\/\//.test(adresse)) ecrits += ` href="${echapperAttribut(sans(adresse))}"`;
    } else if (ATTRIBUTS_PARLANTS.has(cle)) {
      if (!parlant && !CHAMPS.has(nom)) continue;
      const t = masquerLibelle(valeur, 80);
      // Dans la zone du compte, une infobulle qui porte un nom le perd, comme un texte.
      ecrits += ` ${cle}="${echapperAttribut(t.length <= 60 ? (duCompte ? duCompte(sans(t)) : sans(t)) : '…')}"`;
    } else if (ATTRIBUTS_DE_STRUCTURE.has(cle)) {
      // Une liste de classes se coupe au MOT, et le dit : un morceau de classe n'est pas une classe.
      let v = masquerTexte(valeur, cle === 'class' ? 81 : 80);
      if (v.length > 80) v = `${v.slice(0, 79).replace(/\S*$/, '')}…`;
      ecrits += ` ${cle}="${echapperAttribut(sans(v))}"`;
    }
  }
  return ecrits;
}

/** Une copie de page, au format du relevé de console : le relevé, puis le squelette. Rien n'y charge ni n'y exécute quoi que ce soit. */
function htmlDeLaCopie(copie, cadres = []) {
  const { squelette, ...releve } = copie;
  const blocCadres = cadres
    .map((c) => {
      const { squelette: sq, ...rc } = c;
      return `<hr><h2>Cadre ${echapperTexte(rc.adresse)}</h2><pre>${echapperTexte(JSON.stringify(rc, null, 1))}</pre><hr>${sq}`;
    })
    .join('\n');
  return '<!doctype html><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'
    + `<title>Relevé ${echapperTexte(releve.adresse)}</title>\n`
    + `<h1>Relevé pour crabe</h1><pre>${echapperTexte(JSON.stringify(releve, null, 1))}</pre><hr>\n${squelette}\n${blocCadres}\n`;
}

/**
 * Un nom de fichier sûr pour une copie : `pages/03-www.site.fr-compte-factures.html`.
 * Les mots à retirer le sont ICI : le nom est le même partout où il est écrit. Pure.
 */
function nomDeCopie(numero, adresse, mots = []) {
  let hote = 'page';
  let chemin = '';
  try {
    const u = new URL(String(adresse || '').slice(0, 4000));
    hote = u.hostname.replace(/^www\./, '').slice(0, 80) || 'page';
    chemin = navigation.cheminMasque(u.pathname.slice(0, 2000));
    try {
      chemin = decodeURIComponent(chemin);
    } catch {
      /* gardé tel quel */
    }
  } catch {
    /* adresse illisible : le numéro suffit */
  }
  const morceau = retirerMots(`${hote}-${chemin}`.slice(0, 400), mots)
    .replace(/…/g, 'x')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'page';
  return `pages/${String(numero).padStart(2, '0')}-${morceau}.html`;
}

/** L'heure d'un évènement, comptée depuis l'ouverture du relevé : `+02:15`. Pure. */
function ecoule(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Le poids d'un fichier, lisible. Pure. */
function poids(octets) {
  const n = Number(octets) || 0;
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/** Un élément cliqué, en une ligne : `<button#dl.btn.primary> « Télécharger »`. Pure. */
function ligneDeClic(d) {
  const e = d && typeof d === 'object' ? d : {};
  let sig = masquerTexte(e.balise, 20) || '?';
  if (e.id) sig += `#${masquerTexte(e.id, 60)}`;
  for (const c of Array.isArray(e.classes) ? e.classes.slice(0, 4) : []) sig += `.${masquerTexte(c, 40)}`;
  const attrs = [];
  for (const [cle, nom] of [['testid', 'data-testid'], ['role', 'role'], ['type', 'type'], ['nom', 'name']]) {
    if (e[cle]) attrs.push(`${nom}=${masquerTexte(e[cle], 60)}`);
  }
  // Une étiquette PARLE : elle suit la règle des libellés (plus un chiffre).
  if (e.aria) attrs.push(`aria-label=${masquerLibelle(e.aria, 60)}`);
  if (attrs.length) sig += `[${attrs.join(' ')}]`;
  const texte = masquerLibelle(e.texte, 60);
  const href = e.href ? ` → ${adresseReleve(e.href)}` : '';
  const chemin = e.chemin ? ` (dans ${masquerTexte(e.chemin, 160)})` : '';
  return `<${sig}>${texte ? ` « ${texte} »` : ''}${href}${chemin}`;
}

// ---------------------------------------------------------------------------
// Ce qui tourne DANS la page (sérialisé par Playwright : rien de ce module)
// ---------------------------------------------------------------------------

/**
 * La copie de la page, faite dans la page : le relevé (titres, formulaires,
 * liens utiles, blocs répétés, cadres) puis le squelette — les balises et
 * leurs attributs de structure, les textes « parlants » masqués, tout le
 * reste réduit à « … ». Reprend `scripts/releve-page.js`, plus les
 * formulaires (les champs, jamais leurs valeurs). Autonome : Playwright en
 * envoie le SOURCE à la page.
 */
/* eslint-disable no-undef */
function squeletteDeLaPage() {
  // Une première passe : le masquage qui fait foi est celui du serveur
  // (`nettoyerInstantane`, `nettoyerHtml`), qui ne recopie rien d'ici.
  const masque = (t) => String(t || '').slice(0, 2000)
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/gu, '<e-mail>')
    .replace(/\b(bonjour|bonsoir|hello|hi|salut|bienvenue)\b[\s,]+[^\s<]+/gi, '$1 …')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ').trim();
  // Un libellé (lien, bouton, titre, étiquette) ne garde AUCUN chiffre — le courriel masqué d'abord.
  const libelle = (t) => masque(t).replace(/\d+/g, '#').replace(/#(?:[\s.,/:-]*#)+/g, '#');
  const GARDES = ['class', 'id', 'data-testid', 'role', 'type', 'name',
    'autocomplete', 'for', 'method', 'target', 'disabled', 'required'];
  // Des attributs qui PARLENT : gardés comme un texte — sur un élément
  // parlant ou un champ (c'est son étiquette), sans chiffre, soixante
  // caractères au plus ; partout ailleurs, retirés.
  const QUI_PARLENT = ['aria-label', 'title', 'placeholder', 'download'];
  const RETIRES = 'script, style, noscript, template, svg, img, picture, video, audio, canvas, link, meta, '
    + 'input[type=hidden], address, iframe, object, embed';
  const PARLANTS = 'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], label, h1, h2, h3, h4, h5, h6, th, legend, summary, caption';
  const SORTIE = /d[ée]connexion|se d[ée]connecter|d[ée]connecter|log[\s-]?out|sign[\s-]?out|abmelden|cerrar sesi[oó]n|disconnect/i;
  const NOM_IDENTIFIANT = /login|user(name)?|identifiant|\bident\b|pseudo/i;

  const visible = (e) => !!e && (e.offsetWidth > 0 || e.offsetHeight > 0);
  const signature = (e) => (e ? e.tagName.toLowerCase()
    + (e.id ? '#' + masque(e.id) : '')
    + (e.getAttribute('data-testid') ? `[data-testid=${masque(e.getAttribute('data-testid'))}]` : '')
    + [...e.classList].slice(0, 3).map((c) => '.' + masque(c)).join('') : '');
  const MOTS = /re[çc]u|receipt|facture|invoice|pdf|avoir|paiement|payment|virement|transfer|commande|order|achat|historique|history|document|relev[ée]|attestation|t[ée]l[ée]charger|download|g[ée]rer|manage|suivant|next|page|ann[ée]e|year/i;

  // Le texte d'un label SANS ses champs : `innerText` y rendrait aussi les
  // options d'un <select> qu'il enveloppe.
  const texteDuLabel = (l) => {
    if (!l) return '';
    const c = l.cloneNode(true);
    c.querySelectorAll('select, textarea, input, button, datalist').forEach((x) => x.remove());
    return c.textContent || '';
  };
  const etiquetteDe = (champ) => {
    let t = '';
    if (champ.id) {
      try {
        t = texteDuLabel(document.querySelector(`label[for="${CSS.escape(champ.id)}"]`));
      } catch { /* sélecteur refusé */ }
    }
    if (!t) t = texteDuLabel(champ.closest('label'));
    return libelle(t || champ.getAttribute('aria-label') || champ.getAttribute('placeholder') || '').slice(0, 80);
  };
  // Les adresses (action, href, cadres — et les liens du squelette) partent
  // ENTIÈRES : c'est le serveur qui les masque (`adresseReleve`), une seule
  // fois. Elles ne vivent qu'en mémoire, le temps de l'être.
  const absolue = (u) => {
    try {
      const x = new URL(u, document.baseURI);
      return /^https?:$/.test(x.protocol) ? x.href.slice(0, 4000) : '';
    } catch { return ''; }
  };
  const formulaires = [...document.querySelectorAll('form')].slice(0, 10).map((f) => ({
    action: f.getAttribute('action') ? absolue(f.getAttribute('action')) : '',
    methode: (f.getAttribute('method') || 'get').toLowerCase(),
    champs: [...f.querySelectorAll('input, select, textarea, button')].slice(0, 40)
      .filter((c) => !(c.tagName === 'INPUT' && c.type === 'hidden'))
      .map((c) => ({
        balise: c.tagName.toLowerCase(),
        type: (c.getAttribute('type') || '').toLowerCase(),
        nom: masque(c.getAttribute('name') || ''),
        id: masque(c.id || ''),
        autocomplete: masque(c.getAttribute('autocomplete') || ''),
        etiquette: c.tagName === 'BUTTON' ? libelle(c.innerText).slice(0, 60) : etiquetteDe(c),
        requis: c.required === true,
      })),
  }));
  // Les champs hors formulaire (les applications d'une seule page) comptent aussi.
  const orphelins = [...document.querySelectorAll('input, select, textarea')]
    .filter((c) => !c.form && !(c.tagName === 'INPUT' && c.type === 'hidden')).slice(0, 30);
  if (orphelins.length) {
    formulaires.push({
      action: '',
      methode: '(champs hors formulaire)',
      champs: orphelins.map((c) => ({
        balise: c.tagName.toLowerCase(),
        type: (c.getAttribute('type') || '').toLowerCase(),
        nom: masque(c.getAttribute('name') || ''),
        id: masque(c.id || ''),
        autocomplete: masque(c.getAttribute('autocomplete') || ''),
        etiquette: etiquetteDe(c),
        requis: c.required === true,
      })),
    });
  }

  const repetes = {};
  for (const e of document.querySelectorAll('li, tr, article, [data-testid]')) {
    if (visible(e)) repetes[signature(e)] = (repetes[signature(e)] || 0) + 1;
  }
  const actifs = [...document.querySelectorAll('a[href], button, [role="button"]')].filter(visible);

  // Les trois indices du guidage : des booléens. Aucun champ n'est LU — on
  // regarde qu'il existe, son type et son nom.
  const champsVisibles = [...document.querySelectorAll('input')].filter(visible);
  const motDePasse = champsVisibles.some((c) => c.type === 'password');
  const identifiant = champsVisibles.some((c) => /username|webauthn/i.test(c.getAttribute('autocomplete') || '')
    || NOM_IDENTIFIANT.test(`${c.getAttribute('name') || ''} ${c.id || ''}`));
  const deconnexion = [...document.querySelectorAll('a, button, [role="button"], [role="menuitem"]')].slice(0, 3000)
    .some((e) => SORTIE.test(`${(e.textContent || '').slice(0, 80)} ${e.getAttribute('href') || ''} `
      + `${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''}`));

  const copie = document.body ? document.body.cloneNode(true) : document.createElement('body');
  copie.querySelectorAll(RETIRES).forEach((e) => e.remove());
  // Les commentaires de la page ne sont pas du squelette : retirés.
  const guetCommentaires = document.createTreeWalker(copie, NodeFilter.SHOW_COMMENT);
  const commentaires = [];
  while (guetCommentaires.nextNode()) commentaires.push(guetCommentaires.currentNode);
  for (const c of commentaires) c.remove();
  for (const e of copie.querySelectorAll('*')) {
    for (const a of [...e.attributes]) {
      if (a.name === 'href') {
        const cible = absolue(a.value);
        if (cible) e.setAttribute('href', cible);
        else e.removeAttribute('href');
      } else if (QUI_PARLENT.includes(a.name)) {
        const t = libelle(a.value);
        // Une option ne parle pas, même dans un label : ses attributs portent des valeurs.
        if (e.matches('option, optgroup, datalist')
          || !(e.closest(PARLANTS) || e.matches('input, select, textarea'))) e.removeAttribute(a.name);
        else e.setAttribute(a.name, t.length <= 60 ? t : '…');
      } else if (GARDES.includes(a.name)) {
        const v = masque(a.value);
        // Une liste de classes se coupe au mot : un morceau de classe n'est pas une classe.
        e.setAttribute(a.name, a.name === 'class' && v.length > 80 ? `${v.slice(0, 79).replace(/\S*$/, '')}…` : v.slice(0, 80));
      } else e.removeAttribute(a.name);
    }
    if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(e.tagName)) {
      e.removeAttribute('value');
      e.removeAttribute('checked');
      e.removeAttribute('selected');
    }
    if (e.tagName === 'TEXTAREA' || e.tagName === 'OPTION') e.textContent = '';
  }
  const marcheur = document.createTreeWalker(copie, NodeFilter.SHOW_TEXT);
  const textes = [];
  while (marcheur.nextNode()) textes.push(marcheur.currentNode);
  for (const n of textes) {
    const t = libelle(n.nodeValue);
    const parlant = n.parentElement && n.parentElement.closest(PARLANTS);
    n.nodeValue = !t ? '' : parlant && t.length <= 60 ? t : '…';
  }

  return {
    titre: libelle(document.title).slice(0, 120),
    motDePasse,
    identifiant,
    deconnexion,
    intertitres: [...document.querySelectorAll('h1, h2, h3')].filter(visible)
      .map((h) => libelle(h.innerText).slice(0, 80)).slice(0, 20),
    formulaires,
    liensUtiles: actifs
      .map((e) => ({
        texte: libelle(e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(0, 60),
        href: e.href && typeof e.href === 'string' ? absolue(e.href) : '',
        balise: signature(e),
        ligne: signature(e.closest('li, tr, article, [data-testid], [class*="order" i], [class*="invoice" i], [class*="card" i]')),
      }))
      .filter((l) => MOTS.test(l.texte + ' ' + l.href.split('?')[0] + ' ' + l.balise)).slice(0, 60),
    blocsRepetes: Object.entries(repetes).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 15),
    iframes: [...document.querySelectorAll('iframe[src]')].map((f) => absolue(f.src)).slice(0, 8),
    liens: document.querySelectorAll('a[href]').length,
    boutons: document.querySelectorAll('button, [role="button"]').length,
    squelette: copie.innerHTML,
  };
}
/* eslint-enable no-undef */

/**
 * Le guet des clics, posé dans chaque page AVANT ses propres scripts. Il ne
 * modifie rien et n'expose rien à la page : au clic, il décrit l'élément
 * cliqué (balise, identifiant, classes, attributs de structure, texte s'il
 * s'agit d'un lien ou d'un bouton, masqué) et l'envoie à la console, où
 * Playwright le lit. La console est prise au chargement : un site qui la
 * remplace ensuite ne fait pas taire le guet. Aucune touche, aucune valeur de
 * champ : un clic dans un champ ne dit que son type et son nom.
 */
const SCRIPT_CLIC = `(() => {
  const ecrire = console.debug.bind(console);
  const masque = (t) => String(t || '').slice(0, 2000)
    .replace(/[\\u00ad\\u200b-\\u200d\\u2060\\ufeff]/g, '')
    .replace(/[\\p{L}\\p{N}_.+-]+@[\\p{L}\\p{N}-]+\\.[\\p{L}\\p{N}.-]+/gu, '<e-mail>')
    .replace(/\\d{4,}/g, '#')
    .replace(/\\s+/g, ' ').trim();
  const libelle = (t) => masque(t).replace(/\\d+/g, '#');
  // Le texte d'un label sans ses champs (les options d'une liste n'en sont pas).
  const texteDe = (e) => {
    if (e.tagName !== 'LABEL') return e.innerText || e.getAttribute('title');
    const c = e.cloneNode(true);
    c.querySelectorAll('select, textarea, input, button, datalist').forEach((x) => x.remove());
    return c.textContent;
  };
  const sig = (e) => e ? e.tagName.toLowerCase() + (e.id ? '#' + masque(e.id) : '')
    + [...e.classList].slice(0, 3).map((c) => '.' + masque(c)).join('') : '';
  addEventListener('click', (ev) => {
    try {
      // Un clic que la page fabrique elle-même (un lien de téléchargement
      // créé puis « cliqué » par son script) n'est pas un geste de la personne.
      if (!ev.isTrusted) return;
      // La vraie cible, même à l'intérieur d'un composant web ouvert.
      const premiere = typeof ev.composedPath === 'function' ? ev.composedPath()[0] : ev.target;
      const cible = premiere && premiere.closest ? premiere : (ev.target && ev.target.closest ? ev.target : null);
      if (!cible) return;
      const e = cible.closest('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, select, summary, label, [onclick], [tabindex]') || cible;
      const parlant = e.matches('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], summary, label');
      const champ = e.matches('input, select, textarea');
      const chemin = [];
      for (let p = e.parentElement, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) chemin.push(sig(p));
      ecrire(${JSON.stringify(MARQUE_CLIC)} + JSON.stringify({
        balise: e.tagName.toLowerCase(),
        id: masque(e.id).slice(0, 60),
        classes: [...e.classList].slice(0, 4).map((c) => masque(c).slice(0, 40)),
        testid: masque(e.getAttribute('data-testid')).slice(0, 60),
        role: masque(e.getAttribute('role')).slice(0, 30),
        type: masque(e.getAttribute('type')).slice(0, 30),
        nom: masque(e.getAttribute('name')).slice(0, 60),
        aria: libelle(e.getAttribute('aria-label')).slice(0, 60),
        texte: parlant && !champ ? libelle(texteDe(e)).slice(0, 60) : '',
        href: e.href && typeof e.href === 'string' ? e.href.split('#')[0].split('?')[0] : '',
        chemin: chemin.reverse().join(' > '),
        cadre: window !== window.top,
      }));
    } catch (err) { /* le guet ne gêne jamais la page */ }
  }, true);
})();`;

// ---------------------------------------------------------------------------
// L'enregistreur
// ---------------------------------------------------------------------------

/**
 * Attend une promesse, pas plus longtemps que `ms` : passé le délai (ou sur
 * un rejet), rend `defaut`. La promesse abandonnée ne lève jamais plus tard.
 */
function avecDelai(promesse, ms, defaut = null) {
  let minuterie;
  const attente = new Promise((resolve) => {
    minuterie = setTimeout(() => resolve(defaut), ms);
    minuterie.unref?.();
  });
  return Promise.race([Promise.resolve(promesse).catch(() => defaut), attente]).finally(() => clearTimeout(minuterie));
}

/** Une écoute qui ne lève jamais : une erreur du relevé ne doit rien coûter à la fenêtre. */
function sansLever(fn) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* le relevé est un témoin : il se tait plutôt que de gêner */
    }
  };
}

/** Tous les mots à retirer d'un relevé : ceux du compte, puis ceux que crabe a vus. La liste change quand elle grandit. */
function motsDe(etat) {
  const n = etat.aRetirer.length + etat.motsDuSite.size;
  if (!etat.motsTous || etat.motsTous.length !== n) etat.motsTous = [...new Set([...etat.aRetirer, ...etat.motsDuSite])];
  return etat.motsTous;
}

/** Un relevé neuf, en mémoire. */
function nouvelEtat({ userId, url, masquer = '', maintenant = Date.now() }) {
  let hote = '';
  try {
    hote = new URL(url).hostname;
  } catch {
    hote = 'site';
  }
  return {
    id: crypto.randomBytes(6).toString('hex'),
    userId,
    hote,
    depart: adresseReleve(url),
    debut: maintenant,
    fin: null,
    maintenant: () => Date.now(),
    evenements: [],
    copies: [],
    documents: [],
    requetes: [],
    empreintes: new Set(),
    empreintesDuReleve: new Set(),
    vusDocuments: new Map(),
    clics: 0,
    dernierClic: null,
    enCours: new Set(),
    onglets: new Map(),
    prochainOnglet: 1,
    tronque: { evenements: false, pages: false, requetes: false, documents: false, clics: false },
    octetsCopies: 0,
    // Les premières réponses de navigation d'onglets pas encore livrés (voir `brancher`).
    orphelines: [],
    // Le guidage : ce que crabe a vu, étape par étape (`noterEtapes`).
    etapes: { connexion: null, connecte: null, liste: null, document: null },
    // Les mots à retirer de l'archive : en mémoire seulement, jamais écrits.
    aRetirer: motsARetirer(masquer),
    // Ceux que crabe retire d'office : un nom vu dans la zone du compte (`motsDuCompte`).
    motsDuSite: new Set(),
    delaiCopieMs: DELAI_INSTANTANE_MS,
    termine: false,
  };
}

// ---------------------------------------------------------------------------
// Le guidage : quatre étapes, cochées sur ce que les copies montrent
// ---------------------------------------------------------------------------

/**
 * Une copie ressemble-t-elle à une liste de documents ? Un titre qui le dit
 * et au moins un lien utile, ou deux liens qui mènent à un document. Pure.
 */
function ressembleAUneListe(copie) {
  const titres = [copie.titre, ...(copie.intertitres || [])].some((t) => MOTS_LISTE.test(String(t || '')));
  const liens = copie.liensUtiles || [];
  const versDocument = liens.filter((l) => MOTS_LIEN_DOCUMENT.test(`${l.texte} ${l.href}`)).length;
  return (titres && liens.length >= 1) || versDocument >= 2;
}

/**
 * Coche les étapes qu'une copie de page prouve. Des INDICES, jamais une
 * garde : rien ici n'empêche de terminer, et une étape qui ne se coche pas
 * (un site à composants fermés, une liste sans mot connu) se coche avec la
 * suivante.
 *
 *   connexion  un champ de mot de passe, ou un champ d'identifiant nommé ;
 *   connecté   un lien de déconnexion sur une page sans mot de passe ;
 *   liste      une page qui ressemble à une liste de documents, une fois la
 *              page de connexion vue ou la déconnexion offerte ;
 *   document   posée par `noterDocument`, sur un PDF.
 */
function noterEtapes(etat, nom, copie, cadres = []) {
  const tout = [copie, ...cadres];
  const motDePasse = tout.some((c) => c.motDePasse);
  const { etapes } = etat;
  if (!etapes.connexion && (motDePasse || tout.some((c) => c.identifiant))) {
    const formulaires = tout.reduce((n, c) => n + c.formulaires.length, 0);
    const champs = tout.reduce((n, c) => n + c.formulaires.reduce((m, f) => m + f.champs.filter((x) => x.balise !== 'button').length, 0), 0);
    etapes.connexion = { page: nom, formulaires, champs };
    noter(etat, 'etape', 'étape 1 — la page de connexion est relevée');
  }
  if (motDePasse) return;
  const sortie = tout.some((c) => c.deconnexion);
  if (!etapes.connecte && sortie) {
    etapes.connecte = { page: nom };
    noter(etat, 'etape', 'étape 2 — connecté : la page offre la déconnexion');
  }
  // Une connexion SANS mot de passe (un courriel ou un téléphone, puis un
  // code) : aucun champ ne la signale. Le navigateur du relevé est neuf — une
  // page qui offre la déconnexion prouve que l'écran de connexion a été
  // traversé, et la première page à formulaire relevée avant elle est la sienne.
  if (!etapes.connexion && sortie) {
    const avant = (etat.copies || []).find((c) => c.champs > 0 && c.nom !== nom);
    if (avant) {
      etapes.connexion = { page: avant.nom, formulaires: avant.formulaires, champs: avant.champs, deduit: true };
      noter(etat, 'etape', 'étape 1 — la page de connexion est relevée (une connexion sans mot de passe)');
    }
  }
  // La liste ne se coche que sur une PREUVE de connexion : la déconnexion
  // offerte, ici ou sur une page d'avant. Deux liens « Télécharger » sur la
  // page de l'identifiant ne sont pas des factures.
  const connecte = sortie || (etapes.connecte && !etapes.connecte.deduit);
  if (!etapes.liste && connecte && ressembleAUneListe(copie)) {
    etapes.liste = { page: nom, liens: copie.liensUtiles.length };
    noter(etat, 'etape', 'étape 3 — la liste des documents est relevée');
  }
}

/** Les étapes telles que l'écran les montre : faites ou non, et ce qui a été vu. Pure. */
function etapesPubliques(etat) {
  const e = etat.etapes;
  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;
  const liste = [
    { cle: 'connexion', fait: !!e.connexion, detail: e.connexion ? `relevée : ${pluriel(e.connexion.formulaires, 'formulaire')}, ${pluriel(e.connexion.champs, 'champ')}` : '' },
    { cle: 'connecte', fait: !!e.connecte, detail: e.connecte ? (e.connecte.deduit ? 'vous avez atteint vos documents' : 'la page offre la déconnexion') : '' },
    { cle: 'liste', fait: !!e.liste, detail: e.liste ? (e.liste.deduit ? 'le document vient d\'en être ouvert' : `relevée : ${e.liste.liens} lien${e.liste.liens > 1 ? 's' : ''} utile${e.liste.liens > 1 ? 's' : ''}`) : '' },
    { cle: 'document', fait: !!e.document, detail: e.document ? e.document.texte : '' },
  ];
  return { liste, courante: liste.find((x) => !x.fait)?.cle || null };
}

/** L'archive est-elle complète, et sinon que lui manque-t-il ? Pure. */
function bilanDesEtapes(etat) {
  const e = etat.etapes;
  const manque = [];
  if (!e.connexion) manque.push('la page de connexion n\'a pas été relevée');
  if (!e.document) manque.push(etat.documents.length ? 'le document ouvert n\'est pas un PDF' : 'aucune facture ouverte');
  return { complet: !manque.length, manque };
}

/** Une ligne de parcours. Bornée : passé le plafond, le relevé dit qu'il s'arrête là. */
function noter(etat, type, texte, extra = {}) {
  if (etat.termine) return;
  if (etat.evenements.length >= EVENEMENTS_MAX) {
    etat.tronque.evenements = true;
    return;
  }
  etat.evenements.push({ t: etat.maintenant() - etat.debut, type, texte: String(texte).slice(0, 2000), ...extra });
}

/** Retient une promesse en cours, pour que « Terminer » l'attende. */
function suivre(etat, promesse) {
  const p = Promise.resolve(promesse).catch(() => {});
  etat.enCours.add(p);
  p.finally(() => etat.enCours.delete(p));
  return p;
}

/** Le clic qui a précédé, s'il est assez récent pour expliquer ce qui arrive. */
function clicRecent(etat) {
  const c = etat.dernierClic;
  return c && etat.maintenant() - c.quand <= CLIC_RECENT_MS ? c.ligne : '';
}

/**
 * Branche le relevé sur le contexte du navigateur, AVANT la première
 * navigation (`avantNavigation` du gestionnaire de fenêtre).
 */
async function brancher(etat, context) {
  await context.addInitScript({ content: SCRIPT_CLIC });
  // La première réponse de navigation d'un NOUVEL onglet (une facture ouverte
  // à côté) passe avant que Playwright ne livre l'onglet : elle n'est émise
  // que sur le contexte, et `request().frame()` lève jusque-là. Gardée ici,
  // puis rejouée par `suivrePage` quand l'onglet arrive. Bornée : un onglet
  // qui devient un téléchargement n'est jamais livré.
  context.on('response', sansLever((reponse) => {
    if (etat.termine) return;
    const requete = reponse.request();
    if (!requete.isNavigationRequest()) return;
    try {
      requete.frame(); // l'onglet est déjà livré : son `page.on('response')` s'en charge
    } catch {
      if (etat.orphelines.length >= 20) etat.orphelines.shift();
      etat.orphelines.push(reponse);
    }
  }));
  context.on('page', sansLever((page) => suivrePage(etat, page)));
  for (const page of context.pages()) suivrePage(etat, page);
}

function suivrePage(etat, page) {
  if (etat.onglets.has(page)) return;
  const onglet = { numero: etat.prochainOnglet++, minuterie: null, ferme: false, document: false };
  etat.onglets.set(page, onglet);
  noter(etat, 'onglet', `onglet ${onglet.numero} ouvert`, { onglet: onglet.numero });

  page.on('response', sansLever((reponse) => suivre(etat, surReponse(etat, page, onglet, reponse))));
  page.on('download', sansLever((d) => suivre(etat, surTelechargement(etat, onglet, d))));
  page.on('console', sansLever((message) => surConsole(etat, page, onglet, message)));
  page.on('popup', sansLever(() => {
    const clic = clicRecent(etat);
    noter(etat, 'nouvel-onglet', `un nouvel onglet s'ouvre depuis l'onglet ${onglet.numero}${clic ? ` après le clic ${clic}` : ''}`, { onglet: onglet.numero });
  }));
  page.on('framenavigated', sansLever((cadre) => {
    if (cadre !== page.mainFrame()) return;
    noter(etat, 'page', `onglet ${onglet.numero} : ${adresseReleve(cadre.url())}`, { onglet: onglet.numero });
    planifierCopie(etat, page, onglet);
  }));
  page.on('load', sansLever(() => planifierCopie(etat, page, onglet)));
  page.on('close', sansLever(() => {
    onglet.ferme = true;
    if (onglet.minuterie) clearTimeout(onglet.minuterie);
    noter(etat, 'onglet', `onglet ${onglet.numero} fermé`, { onglet: onglet.numero });
  }));

  // Les réponses de navigation arrivées avant cet onglet lui reviennent, dans l'ordre.
  const siennes = [];
  etat.orphelines = etat.orphelines.filter((reponse) => {
    let sienne = false;
    try {
      sienne = reponse.request().frame() === page.mainFrame();
    } catch {
      /* son onglet n'est pas encore livré */
    }
    if (sienne) siennes.push(reponse);
    return !sienne;
  });
  for (const reponse of siennes) suivre(etat, surReponse(etat, page, onglet, reponse));
}

/** La copie d'une page est prise quand la page s'est tenue tranquille un instant. */
function planifierCopie(etat, page, onglet, raison = 'automatique') {
  if (etat.termine || onglet.ferme) return;
  // Une navigation attendue l'emporte sur un clic : c'est elle qui dira
  // pourquoi la page est relevée.
  if (onglet.minuterie) {
    clearTimeout(onglet.minuterie);
    if (onglet.raison === 'automatique') raison = 'automatique';
  }
  onglet.raison = raison;
  onglet.minuterie = setTimeout(() => {
    onglet.minuterie = null;
    suivre(etat, prendreCopie(etat, page, onglet, raison));
  }, etat.delaiCopieMs);
  onglet.minuterie.unref?.();
}

/**
 * Copie la page (et ses cadres qui portent un formulaire ou des liens
 * utiles). Une copie identique à une précédente n'est pas reprise.
 * @returns {Promise<object|null>} la copie retenue, ou null
 */
async function prendreCopie(etat, page, onglet, raison) {
  if (onglet.ferme || onglet.document || etat.termine) return null;
  if (etat.copies.length >= PAGES_MAX || etat.octetsCopies >= COPIES_MAX_OCTETS) {
    etat.tronque.pages = true;
    return null;
  }
  let url;
  let brut;
  try {
    url = page.url();
    if (!/^https?:/i.test(url)) return null;
    // Une page figée (un script qui boucle, une boîte de dialogue) ne répond
    // pas : la copie est abandonnée, le relevé continue.
    brut = await avecDelai(page.mainFrame().evaluate(squeletteDeLaPage), DELAI_COPIE_MS);
  } catch {
    return null;
  }
  if (!brut || etat.termine) return null;
  const copie = nettoyerInstantane(brut, url, { mots: motsDe(etat), trouves: etat.motsDuSite });
  const cadres = [];
  // Vingt cadres interrogés au plus, et pas plus de DELAI_COPIE_MS pour eux tous.
  const limiteCadres = Date.now() + DELAI_COPIE_MS;
  for (const cadre of page.frames().slice(1, 1 + 4 * CADRES_MAX)) {
    if (cadres.length >= CADRES_MAX || etat.termine || Date.now() >= limiteCadres) break;
    try {
      const adresseCadre = cadre.url();
      if (!/^https?:/i.test(adresseCadre)) continue;
      const brutCadre = await avecDelai(cadre.evaluate(squeletteDeLaPage), DELAI_COPIE_MS / 2);
      if (!brutCadre) continue;
      const c = nettoyerInstantane(brutCadre, adresseCadre, { mots: motsDe(etat), trouves: etat.motsDuSite });
      if (c.formulaires.length || c.liensUtiles.length) cadres.push(c);
    } catch {
      /* cadre parti entre-temps */
    }
  }

  const empreinte = crypto.createHash('sha256')
    .update(copie.adresse).update('\n').update(copie.squelette)
    .update(JSON.stringify(cadres.map((c) => c.squelette)))
    .digest('hex');
  if (etat.empreintes.has(empreinte)) return null;
  // Ce que la page OFFRE : son titre, ses formulaires, ses liens utiles, ses
  // lignes répétées. Après un simple clic, une page qui n'offre rien de neuf
  // (un menu refermé, une classe qui change) n'est pas relevée une fois de
  // plus : les soixante copies sont gardées pour ce qui compte.
  const { squelette: _s, ...offre } = copie;
  const empreinteDuReleve = crypto.createHash('sha256')
    .update(JSON.stringify([offre, cadres.map(({ squelette: _c, ...o }) => o)]))
    .digest('hex');
  if (raison === 'après un clic' && etat.empreintesDuReleve.has(empreinteDuReleve)) return null;
  if (etat.copies.length >= PAGES_MAX) {
    etat.tronque.pages = true;
    return null;
  }
  etat.empreintes.add(empreinte);
  etat.empreintesDuReleve.add(empreinteDuReleve);

  const numero = etat.copies.length + 1;
  const nom = nomDeCopie(numero, url, motsDe(etat));
  const retenue = {
    numero,
    nom,
    onglet: onglet.numero,
    raison,
    adresse: copie.adresse,
    titre: copie.titre,
    formulaires: copie.formulaires.length,
    champs: copie.formulaires.reduce((n, f) => n + f.champs.length, 0),
    liensUtiles: copie.liensUtiles.length,
    cadres: cadres.length,
    html: htmlDeLaCopie(copie, cadres),
  };
  etat.copies.push(retenue);
  etat.octetsCopies += Buffer.byteLength(retenue.html);
  noterEtapes(etat, nom, copie, cadres);
  noter(
    etat,
    'copie',
    `page relevée (${raison}) : ${nom} — « ${copie.titre || 'sans titre'} », `
      + `${retenue.formulaires} formulaire(s), ${retenue.liensUtiles} lien(s) utile(s)`
      + (cadres.length ? `, ${cadres.length} cadre(s)` : ''),
    { onglet: onglet.numero }
  );
  return retenue;
}

/** Une réponse : navigation du cadre principal, document, ou appel de la page. */
async function surReponse(etat, page, onglet, reponse) {
  if (etat.termine) return;
  let requete;
  let enTetes;
  let url;
  try {
    requete = reponse.request();
    enTetes = reponse.headers();
    url = reponse.url();
  } catch {
    return;
  }
  let navigationPrincipale = false;
  try {
    navigationPrincipale = requete.isNavigationRequest() && requete.frame() === page.mainFrame();
  } catch {
    navigationPrincipale = false;
  }

  if (navigationPrincipale) {
    // L'onglet affiche-t-il un document (le lecteur PDF du navigateur) ? Il
    // n'y a alors aucune page à copier — jusqu'à la navigation suivante.
    // Seul `application/pdf` s'affiche : un flux d'octets devient un
    // téléchargement, et l'onglet reste sur sa page.
    onglet.document = typeDe(enTetes) === 'application/pdf'
      && !/\battachment\b/i.test(String(enTetes['content-disposition'] || '').slice(0, 1000));
    let cookies = { poses: [], effaces: [] };
    try {
      cookies = navigation.nomsDeCookies((await reponse.headerValues('set-cookie')).slice(0, 60));
      // Un NOM de cookie peut porter un identifiant de compte ou un courriel.
      const propre = (n) => String(n).slice(0, 200).replace(/%40/gi, '@')
        .replace(/[\p{L}\p{N}_.+…-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/gu, '<e-mail>').replace(/\d{4,}/g, '#').slice(0, 60);
      cookies = { poses: cookies.poses.slice(0, 30).map(propre), effaces: cookies.effaces.slice(0, 30).map(propre) };
    } catch {
      /* en-têtes illisibles : la ligne sans cookies */
    }
    noter(
      etat,
      'navigation',
      `onglet ${onglet.numero} : ${navigation.formaterReponse({
        statut: reponse.status(),
        url,
        renvoi: enTetes.location || null,
        ...cookies,
      })}`,
      { onglet: onglet.numero }
    );
  }

  if (estDocument(enTetes, url)) {
    // Une pièce jointe ouverte par navigation devient un téléchargement : c'est
    // lui qui la décrira (sans quoi elle serait comptée deux fois).
    if (navigationPrincipale && /\battachment\b/i.test(String(enTetes['content-disposition'] || ''))) return;
    await noterDocument(etat, {
      voie: navigationPrincipale ? `ouvert dans l'onglet ${onglet.numero}` : `réponse à un appel de l'onglet ${onglet.numero}`,
      cle: url,
      adresse: adresseReleve(url),
      statut: reponse.status(),
      type: typeDe(enTetes),
      nomFichier: nomDeFichier(enTetes['content-disposition']),
      octetsAnnonces: Number(enTetes['content-length']) || null,
      lire: () => avecDelai(reponse.body(), DELAI_CORPS_MS),
    });
    return;
  }

  let typeRessource = '';
  try {
    typeRessource = requete.resourceType();
  } catch {
    return;
  }
  if (typeRessource !== 'xhr' && typeRessource !== 'fetch') return;
  if (etat.requetes.length >= REQUETES_MAX) {
    etat.tronque.requetes = true;
    return;
  }
  const type = typeDe(enTetes);
  const entree = {
    numero: etat.requetes.length + 1,
    onglet: onglet.numero,
    methode: masquerTexte(requete.method(), 10),
    adresse: adresseReleve(url),
    statut: reponse.status(),
    type,
    forme: null,
  };
  etat.requetes.push(entree);
  if (/json/.test(type)) {
    const annonce = Number(enTetes['content-length']) || 0;
    if (annonce > CORPS_JSON_MAX_OCTETS) {
      entree.forme = `(réponse de ${poids(annonce)}, non lue)`;
    } else {
      try {
        const corps = await avecDelai(reponse.body(), DELAI_CORPS_MS);
        if (!corps) entree.forme = '(corps non lu)';
        else {
          entree.forme = corps.length > CORPS_JSON_MAX_OCTETS
            ? `(réponse de ${poids(corps.length)}, non lue)`
            : formeJson(JSON.parse(corps.toString('utf8')));
        }
      } catch {
        entree.forme = '(corps illisible)';
      }
    }
  }
  noter(
    etat,
    'appel',
    `appel ${entree.numero} de l'onglet ${onglet.numero} : ${entree.methode} ${entree.adresse} → ${entree.statut}${type ? ` ${type}` : ''}`,
    { onglet: onglet.numero }
  );
}

/** Un téléchargement : lu, décrit, puis effacé. */
async function surTelechargement(etat, onglet, telechargement) {
  if (etat.termine) return;
  const clic = clicRecent(etat);
  // `path()` attend la fin du téléchargement : borné, comme tout le reste.
  const chemin = await avecDelai(telechargement.path(), DELAI_TELECHARGEMENT_MS);
  let corps = null;
  let octets = null;
  if (chemin) {
    try {
      octets = fs.statSync(chemin).size;
      if (octets <= CORPS_DOCUMENT_MAX_OCTETS) corps = fs.readFileSync(chemin);
      else {
        const fd = fs.openSync(chemin, 'r');
        try {
          corps = Buffer.alloc(1024);
          fs.readSync(fd, corps, 0, 1024, 0);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      corps = null;
    }
  }
  // Effacé aussitôt lu ; à défaut, le contexte l'efface à sa fermeture.
  await avecDelai(telechargement.delete(), 5000);
  let url = '';
  let nom = '';
  try {
    url = telechargement.url();
    nom = telechargement.suggestedFilename();
  } catch {
    /* rien de plus à dire */
  }
  await noterDocument(etat, {
    voie: `téléchargement depuis l'onglet ${onglet.numero}`,
    cle: url,
    adresse: adresseReleve(url),
    statut: null,
    type: '',
    nomFichier: masquerLibelle(nom, 120),
    octetsAnnonces: octets,
    clic,
    lire: async () => corps || Buffer.alloc(0),
    estTelechargement: true,
  });
}

async function noterDocument(etat, { voie, cle, adresse, statut, type, nomFichier, octetsAnnonces, lire, clic = null, estTelechargement = false }) {
  // La même adresse servie deux fois en quelques secondes (la réponse, puis
  // le téléchargement qu'elle déclenche) : un seul document.
  const vu = etat.vusDocuments.get(cle);
  if (cle && vu && etat.maintenant() - vu.quand < 10000) {
    if (estTelechargement && !vu.document.voie.includes('télécharg')) vu.document.voie += ', puis téléchargé';
    return;
  }
  // Un téléchargement depuis une adresse `blob:` ou `data:` : la page vient
  // de fabriquer le fichier avec la réponse d'un appel — c'est le MÊME
  // document, et la façon dont il arrive est exactement ce qu'il faut savoir.
  if (estTelechargement && /^(blob|data):/i.test(String(cle))) {
    const dernier = etat.documents[etat.documents.length - 1];
    if (dernier && etat.maintenant() - dernier.quand < 10000) {
      if (!dernier.voie.includes('télécharg')) dernier.voie += ', puis enregistré par la page (téléchargement d\'un blob)';
      if (!dernier.nomFichier && nomFichier) dernier.nomFichier = nomFichier;
      return;
    }
  }
  if (etat.documents.length >= DOCUMENTS_MAX) {
    etat.tronque.documents = true;
    return;
  }
  const clicAvant = clic ?? clicRecent(etat);
  const document = {
    numero: etat.documents.length + 1,
    voie,
    adresse,
    statut,
    type,
    nomFichier,
    clic: clicAvant,
    // Sans corps lisible (un PDF affiché par le lecteur du navigateur), le
    // type annoncé fait foi ; le corps, lu juste après, le confirme ou non.
    pdf: /pdf/.test(String(type)) || /\.pdf$/i.test(String(nomFichier)),
    pages: null,
    octets: octetsAnnonces,
    quand: etat.maintenant(),
  };
  etat.documents.push(document);
  if (cle) etat.vusDocuments.set(cle, { quand: etat.maintenant(), document });
  let corps = null;
  try {
    const annonce = Number(octetsAnnonces) || 0;
    if (annonce <= CORPS_DOCUMENT_MAX_OCTETS) corps = await lire();
  } catch {
    corps = null;
  }
  if (corps && corps.length) Object.assign(document, decrireDocument(corps, octetsAnnonces || corps.length));
  noter(etat, 'document', `document ${document.numero} — ${ligneDocument(document)}`);
  if (document.pdf && !etat.etapes.document) {
    const e = etat.etapes;
    e.document = { texte: `PDF${document.pages ? `, ${document.pages} page${document.pages > 1 ? 's' : ''}` : ''}, ${poids(document.octets)}` };
    // Le navigateur du relevé est neuf : un PDF atteint prouve que l'écran de
    // connexion a été traversé (une connexion sans mot de passe, sans lien de
    // déconnexion visible). La première page à formulaire relevée avant celle
    // d'où il s'ouvre est la sienne.
    if (!e.connexion) {
      const derniere = etat.copies[etat.copies.length - 1];
      const avant = etat.copies.find((c) => c.champs > 0 && c !== derniere);
      if (avant) {
        e.connexion = { page: avant.nom, formulaires: avant.formulaires, champs: avant.champs, deduit: true };
        noter(etat, 'etape', 'étape 1 — la page de connexion est relevée (déduite du document ouvert)');
      }
    }
    if (!e.connecte) e.connecte = { deduit: true };
    if (!e.liste) e.liste = { deduit: true };
    noter(etat, 'etape', 'étape 4 — un document est ouvert');
  }
}

function ligneDocument(d) {
  const nature = d.pdf ? `PDF${d.pages ? `, ${d.pages} page${d.pages > 1 ? 's' : ''}` : ''}` : (d.type || 'type inconnu');
  return `${d.voie} : ${nature}, ${poids(d.octets)}`
    + (d.nomFichier ? `, fichier « ${d.nomFichier} »` : '')
    + (d.adresse ? ` — ${d.adresse}` : '')
    + (d.statut ? ` (${d.statut})` : '')
    + (d.clic ? `\n      après le clic ${d.clic}` : '');
}

/** Un message de console : seul le guet des clics est lu, tout le reste est ignoré. */
/** L'élément cliqué, ou l'un de ses trois parents, dit-il la zone du compte ? */
function clicDuCompte(desc) {
  const e = desc && typeof desc === 'object' ? desc : {};
  const signes = [
    e.id, ...(Array.isArray(e.classes) ? e.classes.slice(0, 8) : []), e.aria, e.testid, e.nom,
    String(e.href || '').replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, '').split(/[?#]/)[0],
    ...String(e.chemin || '').slice(0, 400).split('>').slice(-3),
  ].filter(Boolean).map((v) => String(v).slice(0, 400)).join(' ');
  return signeDuCompte(signes);
}

function surConsole(etat, page, onglet, message) {
  if (etat.termine) return;
  let texte;
  try {
    if (message.type() !== 'debug') return;
    texte = message.text();
  } catch {
    return;
  }
  if (!texte.startsWith(MARQUE_CLIC)) return;
  if (etat.clics >= CLICS_MAX) {
    etat.tronque.clics = true;
    return;
  }
  let desc;
  try {
    desc = JSON.parse(texte.slice(MARQUE_CLIC.length));
  } catch {
    return;
  }
  etat.clics++;
  // Un clic sur le lien du compte peut en dire le nom : il est retiré d'office, comme dans une copie.
  if (clicDuCompte(desc)) noterMotsDuSite(etat.motsDuSite, motsDuCompte(masquerLibelle(desc?.texte, 60)));
  const ligne = ligneDeClic(desc);
  etat.dernierClic = { quand: etat.maintenant(), ligne };
  noter(etat, 'clic', `clic dans l'onglet ${onglet.numero}${desc?.cadre ? ' (dans un cadre)' : ''} : ${ligne}`, { onglet: onglet.numero });
  // Une application d'une seule page change d'écran sans changer d'adresse :
  // après un clic, la page est regardée de nouveau — et relevée seulement si
  // ce qu'elle offre a changé (voir `prendreCopie`).
  planifierCopie(etat, page, onglet, 'après un clic');
}

/** Ce que l'écran montre pendant le relevé. */
function resume(etat) {
  if (!etat) return null;
  return {
    hote: etat.hote,
    pages: etat.copies.length,
    documents: etat.documents.length,
    documentsPdf: etat.documents.filter((d) => d.pdf).length,
    appels: etat.requetes.length,
    clics: etat.clics,
    pagesMax: PAGES_MAX,
    etapes: etapesPubliques(etat),
    ...bilanDesEtapes(etat),
  };
}

// ---------------------------------------------------------------------------
// Le rangement
// ---------------------------------------------------------------------------

function racine() {
  return require('./config').config.relevesDir;
}

/** Le dossier des relevés d'un compte : `<racine>/u<id>`. Un identifiant douteux ne mène nulle part. */
function dossierDuCompte(userId, dossierRacine = racine()) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw erreur('Compte inconnu.', 400);
  return path.join(dossierRacine, `u${id}`);
}

/** Un identifiant de relevé est un nom de dossier que ce module a fabriqué. */
function idValide(id) {
  return typeof id === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9.-]{1,80}$/.test(id);
}

function horodatage(date) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

/** Le texte du parcours, une ligne par évènement. Pure. */
function texteDuParcours(etat) {
  const lignes = etat.evenements.map((e) => `${ecoule(e.t)}  ${e.texte}`);
  if (etat.tronque.evenements) lignes.push(`… le parcours s'arrête là : ${EVENEMENTS_MAX} évènements au plus.`);
  return `Parcours relevé sur ${etat.hote}, depuis ${etat.depart}\n\n${lignes.join('\n')}\n`;
}

function texteDesDocuments(etat) {
  if (!etat.documents.length) {
    return 'Aucun document vu pendant le relevé : ni téléchargement, ni PDF servi.\n'
      + 'Si les factures se trouvent derrière un bouton, cliquez-en un pendant le relevé.\n';
  }
  return `${etat.documents.map((d) => `${d.numero}. ${ligneDocument(d)}`).join('\n')}\n`
    + (etat.tronque.documents ? `… ${DOCUMENTS_MAX} documents au plus.\n` : '');
}

function texteDesAppels(etat) {
  if (!etat.requetes.length) return 'Aucun appel de la page (XHR ou fetch) pendant le relevé.\n';
  return etat.requetes
    .map((r) => `${r.numero}. onglet ${r.onglet} : ${r.methode} ${r.adresse} → ${r.statut}${r.type ? ` ${r.type}` : ''}`
      + (r.forme ? `\n${typeof r.forme === 'string' ? `   ${r.forme}` : JSON.stringify(r.forme, null, 2).replace(/^/gm, '   ')}` : ''))
    .join('\n\n') + '\n'
    + (etat.tronque.requetes ? `\n… ${REQUETES_MAX} appels au plus.\n` : '');
}

function texteLisezMoi(etat, version, sans = (t) => t) {
  const duree = Math.round(((etat.fin || etat.maintenant()) - etat.debut) / 1000);
  const limites = Object.entries(etat.tronque).filter(([, v]) => v).map(([k]) => k);
  const bilan = bilanDesEtapes(etat);
  const NOMS = { connexion: 'la page de connexion', connecte: 'la connexion', liste: 'la liste des documents', document: 'un document ouvert' };
  return [
    'Relevé de site pour crabe',
    '',
    `Site        : ${etat.hote}`,
    `Départ      : ${sans(etat.depart)}`,
    `Relevé le   : ${new Date(etat.debut).toISOString()} (${Math.floor(duree / 60)} min ${duree % 60} s)`,
    `crabe       : ${version || '?'}`,
    `Contenu     : ${etat.copies.length} page(s), ${etat.documents.length} document(s), `
      + `${etat.requetes.length} appel(s), ${etat.clics} clic(s)`,
    limites.length ? `Plafonds atteints : ${limites.join(', ')}` : '',
    '',
    bilan.complet ? 'Relevé COMPLET.' : `Relevé INCOMPLET : ${bilan.manque.join(' ; ')}.`,
    ...etapesPubliques(etat).liste.map((x) => `  [${x.fait ? 'x' : ' '}] ${NOMS[x.cle]}${x.detail ? ` — ${x.detail}` : ''}`),
    etat.aRetirer.length
      ? `  ${etat.aRetirer.length} mot(s) retiré(s) de l'archive à la demande du compte`
        + (sans(etat.hote) !== etat.hote ? ' — sauf du nom du site, gardé tel quel ici, dans releve.json et dans le nom de l\'archive.' : '.')
      : '',
    etat.motsDuSite.size
      ? `  ${etat.motsDuSite.size} mot(s) retiré(s) d'office : un nom que le site affiche près du compte (son lien, son menu).`
      : '',
    '',
    'parcours.txt   chaque étape, dans l\'ordre : onglets, pages, réponses de navigation',
    '               (statut, renvoi, NOMS des cookies), clics, documents, appels',
    'documents.txt  chaque document vu : comment il est arrivé, PDF ou non, pages, poids,',
    '               et le clic qui l\'a déclenché',
    'appels.txt     les appels de la page (XHR, fetch) et la FORME de leurs réponses JSON',
    'pages/         la copie de chaque page : le relevé, puis son squelette',
    'releve.json    tout cela, lisible par un programme',
    '',
    'Ce relevé ne contient RIEN de ce qui a été tapé (aucun champ, aucun corps de requête),',
    'aucune valeur de cookie ni d\'en-tête, aucune adresse complète (les identifiants des',
    'chemins sont masqués, les paramètres réduits à leur nom), aucun texte de page hors des',
    'liens, boutons, titres et étiquettes (masqués eux aussi : courriels, tous les chiffres),',
    'aucune valeur JSON, aucun document. Le nom que le site affiche près du compte (son lien',
    '« Mon compte », son menu) est retiré d\'office ; écrit ailleurs dans un lien ou un titre,',
    'il ne l\'est que s\'il a été donné à retirer avant le relevé : ouvrez les fichiers pour',
    'vérifier avant d\'envoyer.',
    '',
  ].filter((l, i, t) => l !== '' || t[i - 1] !== '').join('\n');
}

/** Écrit un fichier en 0600, dans un dossier en 0700. */
function ecrire(dossier, nom, contenu) {
  const fichier = path.join(dossier, nom);
  fs.mkdirSync(path.dirname(fichier), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fichier, contenu, { mode: 0o600 });
}

/**
 * Range un relevé terminé : un dossier par relevé, sous la racine.
 * @returns {object} l'entrée de la liste
 */
function ranger(etat, { dossierRacine = racine(), version = '' } = {}) {
  const duCompte = dossierDuCompte(etat.userId, dossierRacine);
  const date = new Date(etat.debut);
  const hote = String(etat.hote || 'site').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 80) || 'site';
  let id = `${horodatage(date)}-${hote}`;
  fs.mkdirSync(duCompte, { recursive: true, mode: 0o700 });
  for (let i = 2; fs.existsSync(path.join(duCompte, id)); i++) id = `${horodatage(date)}-${hote}`.slice(0, 96) + `-${i}`;
  const dossier = path.join(duCompte, id);
  fs.mkdirSync(dossier, { mode: 0o700 });
  let entree;
  try {
    entree = ecrireLeReleve(etat, { dossier, duCompte, id, version });
  } catch (err) {
    // Un relevé écrit à moitié (disque plein) ne reste pas : tout, ou rien.
    fs.rmSync(dossier, { recursive: true, force: true });
    throw err;
  }
  // La purge vient APRÈS, hors de ce rattrapage : un vieux relevé qui résiste
  // à l'effacement n'emporte pas celui qu'on vient d'écrire. L'entrée, lue
  // avant elle, est rendue même si le relevé — rangé en retard, plus ancien
  // que les vingt gardés — part avec la purge.
  purger(etat.userId, { dossierRacine });
  return entree;
}

function ecrireLeReleve(etat, { dossier, duCompte, id, version }) {
  // Les mots à retirer sont retirés des TEXTES — une ligne de parcours, une
  // adresse, un nom de fichier servi, les clés d'une réponse —, jamais d'un
  // fichier assemblé : un mot qui serait aussi une clé de releve.json ou une
  // balise n'abîme rien. Les copies de page et leurs noms l'ont été à la
  // source (`prendreCopie`), et ne sont pas retouchées ici.
  const sans = (texte) => retirerMots(texte, motsDe(etat));
  const bilan = bilanDesEtapes(etat);
  ecrire(dossier, 'LISEZ-MOI.txt', texteLisezMoi(etat, version, sans));
  ecrire(dossier, 'parcours.txt', sans(texteDuParcours(etat)));
  ecrire(dossier, 'documents.txt', sans(texteDesDocuments(etat)));
  ecrire(dossier, 'appels.txt', sans(texteDesAppels(etat)));
  for (const copie of etat.copies) ecrire(dossier, copie.nom, copie.html);
  ecrire(dossier, 'releve.json', `${JSON.stringify({
    format: 1,
    crabe: version || null,
    site: etat.hote,
    depart: sans(etat.depart),
    debut: new Date(etat.debut).toISOString(),
    fin: new Date(etat.fin || etat.maintenant()).toISOString(),
    complet: bilan.complet,
    manque: bilan.manque,
    etapes: etapesPubliques(etat).liste,
    tronque: etat.tronque,
    pages: etat.copies.map(({ html, ...c }) => c),
    documents: etat.documents.map(({ quand, ...d }) => ({ ...d, adresse: sans(d.adresse), nomFichier: sans(d.nomFichier), clic: sans(d.clic) })),
    appels: etat.requetes.map((r) => ({ ...r, adresse: sans(r.adresse), forme: partout(r.forme, sans, { cles: true }) })),
    clics: etat.clics,
    parcours: etat.evenements.map((e) => ({ ...e, texte: sans(e.texte) })),
  }, null, 1)}\n`);
  return entreeDe(duCompte, id);
}

/** La ligne d'un relevé rangé, lue sur disque. */
function entreeDe(dossierRacine, id) {
  const dossier = path.join(dossierRacine, id);
  let octets = 0;
  const pile = [dossier];
  while (pile.length) {
    const d = pile.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) pile.push(path.join(d, e.name));
      else octets += fs.statSync(path.join(d, e.name)).size;
    }
  }
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dossier, 'releve.json'), 'utf8'));
  } catch {
    meta = {};
  }
  return {
    id,
    site: meta.site || id.slice(20),
    depart: meta.depart || '',
    debut: meta.debut || null,
    pages: Array.isArray(meta.pages) ? meta.pages.length : 0,
    documents: Array.isArray(meta.documents) ? meta.documents.length : 0,
    documentsPdf: Array.isArray(meta.documents) ? meta.documents.filter((d) => d.pdf).length : 0,
    appels: Array.isArray(meta.appels) ? meta.appels.length : 0,
    complet: meta.complet === true,
    manque: Array.isArray(meta.manque) ? meta.manque.map(String) : [],
    octets,
    envois: envoisDe(dossier),
  };
}

/** Quand ce relevé est parti par courriel : des dates ISO, la plus ancienne d'abord. */
function envoisDe(dossier) {
  try {
    const lus = JSON.parse(fs.readFileSync(path.join(dossier, FICHIER_ENVOIS), 'utf8'));
    return Array.isArray(lus) ? lus.filter((d) => typeof d === 'string' && !Number.isNaN(Date.parse(d))).slice(0, ENVOIS_MAX) : [];
  } catch {
    return [];
  }
}

/** Les relevés rangés d'un compte, du plus récent au plus ancien. */
function lister(userId, { dossierRacine = racine() } = {}) {
  const duCompte = dossierDuCompte(userId, dossierRacine);
  if (!fs.existsSync(duCompte)) return [];
  purger(userId, { dossierRacine });
  let noms;
  try {
    noms = fs.readdirSync(duCompte);
  } catch {
    return []; // un dossier illisible ne casse pas la page : rien à montrer
  }
  return noms
    .filter((id) => idValide(id) && fs.existsSync(path.join(duCompte, id, 'releve.json')))
    .sort()
    .reverse()
    .map((id) => {
      try {
        return entreeDe(duCompte, id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Le dossier d'un relevé DE CE COMPTE, ou null : celui d'un autre n'existe pas pour lui. */
function chemin(userId, id, { dossierRacine = racine() } = {}) {
  if (!idValide(id)) return null;
  const dossier = path.join(dossierDuCompte(userId, dossierRacine), id);
  return fs.existsSync(path.join(dossier, 'releve.json')) ? dossier : null;
}

/** Les fichiers d'un relevé, chemins relatifs, dans l'ordre de l'archive. */
function fichiers(dossier) {
  const premiers = ['LISEZ-MOI.txt', 'parcours.txt', 'documents.txt', 'appels.txt', 'releve.json'];
  const pages = fs.existsSync(path.join(dossier, 'pages'))
    ? fs.readdirSync(path.join(dossier, 'pages')).filter((n) => /\.html$/.test(n)).sort().map((n) => `pages/${n}`)
    : [];
  return [...premiers.filter((n) => fs.existsSync(path.join(dossier, n))), ...pages];
}

function effacer(userId, id, { dossierRacine = racine() } = {}) {
  const dossier = chemin(userId, id, { dossierRacine });
  if (!dossier) return false;
  fs.rmSync(dossier, { recursive: true, force: true });
  return true;
}

/** Tous les relevés d'un compte, effacés d'un coup (la suppression du compte). */
function effacerTout(userId, { dossierRacine = racine() } = {}) {
  fs.rmSync(dossierDuCompte(userId, dossierRacine), { recursive: true, force: true });
}

/** L'archive `.zip` d'un relevé, assemblée en mémoire : du texte, borné à l'écriture. */
function archiveEnMemoire(dossier) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });
    const morceaux = [];
    let octets = 0;
    archive.on('data', (m) => {
      octets += m.length;
      if (octets > ARCHIVE_MAX_OCTETS) return void archive.abort();
      morceaux.push(m);
    });
    archive.on('error', reject);
    archive.on('end', () => {
      if (octets > ARCHIVE_MAX_OCTETS) {
        return reject(erreur('Cette archive est trop lourde pour un courriel : téléchargez-la.', 413));
      }
      resolve(Buffer.concat(morceaux));
    });
    for (const nom of fichiers(dossier)) archive.file(path.join(dossier, nom), { name: nom });
    archive.finalize().catch(reject);
  });
}

/** Le nom de l'archive d'un relevé, pour le navigateur comme pour la pièce jointe. */
function nomDArchive(id) {
  return `releve-${String(id).slice(20)}-${String(id).slice(0, 10)}.zip`;
}

/** Le message joint à la demande : du texte, sans caractère de contrôle, borné. */
function messageDeDemande(texte) {
  return String(texte ?? '')
    .slice(0, MESSAGE_MAX * 4)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX);
}

/** Une adresse à qui répondre, ou rien : jamais un en-tête fabriqué. */
function adresseDeReponse(email) {
  const lue = String(email ?? '').trim();
  return lue.length <= 254 && /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+\.[^\s<>@,;:"()[\]\\]+$/.test(lue) ? lue : '';
}

/** Le courriel de la demande : qui demande, quel site, ce que contient le relevé, le message. */
function courrielDeDemande(entree, { demandeur = {}, message = '', version = '' } = {}) {
  const nom = String(demandeur.username ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || 'compte sans nom';
  const reponse = adresseDeReponse(demandeur.email);
  const site = String(entree.site).replace(/[^A-Za-z0-9.:-]/g, '').slice(0, 120) || 'site';
  const documents = `${entree.documents} document(s)${entree.documentsPdf ? `, dont ${entree.documentsPdf} PDF` : ''}`;
  return {
    objet: `${OBJET_ENVOI} — ${site}`,
    reponse,
    texte: [
      OBJET_ENVOI,
      '',
      `Site        : ${site}`,
      entree.depart ? `Départ      : ${entree.depart}` : '',
      entree.debut ? `Relevé le   : ${entree.debut}` : '',
      `Contenu     : ${entree.pages} page(s), ${documents}, ${entree.appels} appel(s)`,
      `Bilan       : ${entree.complet ? 'complet' : `incomplet — ${entree.manque.join(' ; ') || 'une étape manque'}`}`,
      '',
      `Demandé par : ${nom}${reponse ? ` <${reponse}>` : ' (sans adresse de courriel)'}`,
      `crabe       : ${version || '?'}`,
      '',
      message ? 'Message :' : 'Aucun message.',
      message,
      '',
      `Archive jointe : ${nomDArchive(entree.id)}`,
    ].filter((l, i, t) => l !== '' || t[i - 1] !== '').join('\n').trim() + '\n',
  };
}

/** Les relevés en train de partir : un double clic n'envoie qu'une fois. */
const envoisEnCours = new Set();

/**
 * « Envoyer » : l'archive part par le SMTP du serveur, avec qui demande, le
 * site et le message. Rien ne part sans SMTP (503, dit tel quel), ni deux fois
 * à la fois (409), ni plus de trois fois (429). L'envoi réussi est noté dans
 * le dossier du relevé.
 */
async function envoyer(userId, id, { message, demandeur, version } = {}, { mailer = require('./mailer'), dossierRacine = racine(), maintenant = Date.now } = {}) {
  const dossier = chemin(userId, id, { dossierRacine });
  if (!dossier) throw erreur('Relevé introuvable.', 404);
  const cle = `${userId}/${id}`;
  if (envoisEnCours.has(cle)) throw erreur('Ce relevé est déjà en train de partir.', 409);
  const deja = envoisDe(dossier);
  if (deja.length >= ENVOIS_MAX) throw erreur(`Ce relevé a déjà été envoyé ${ENVOIS_MAX} fois.`, 429);
  envoisEnCours.add(cle);
  try {
    const entree = entreeDe(path.dirname(dossier), id);
    const courriel = courrielDeDemande(entree, { demandeur, message: messageDeDemande(message), version });
    const contenu = await archiveEnMemoire(dossier);
    await mailer.send({
      to: ADRESSE_ENVOI,
      subject: courriel.objet,
      text: courriel.texte,
      replyTo: courriel.reponse || undefined,
      attachments: [{ filename: nomDArchive(id), content: contenu, contentType: 'application/zip' }],
      discret: true,
    });
    // Le courriel est parti : un carnet qui ne s'écrit pas n'en fait pas un échec.
    sansLever(() => ecrire(dossier, FICHIER_ENVOIS, `${JSON.stringify([...deja, new Date(maintenant()).toISOString()])}\n`))();
    return entreeDe(path.dirname(dossier), id);
  } finally {
    envoisEnCours.delete(cle);
  }
}

/**
 * Plus de vingt relevés pour un compte, ou plus vieux que trente jours :
 * effacés. Le reste d'un arrêt en pleine écriture (un dossier sans
 * releve.json, écrit en dernier) part aussi. Un dossier qui résiste n'arrête
 * ni le rangement ni la liste : la purge suivante le reprendra.
 */
function purger(userId, { dossierRacine = racine(), maintenant = Date.now() } = {}) {
  const duCompte = dossierDuCompte(userId, dossierRacine);
  let effaces = 0;
  let ids;
  try {
    if (!fs.existsSync(duCompte)) return 0;
    ids = fs.readdirSync(duCompte).filter(idValide).sort().reverse();
  } catch {
    return 0;
  }
  const effacer1 = (id) => {
    try {
      fs.rmSync(path.join(duCompte, id), { recursive: true, force: true });
      effaces++;
    } catch {
      /* repris à la purge suivante */
    }
  };
  ids = ids.filter((id) => {
    if (fs.existsSync(path.join(duCompte, id, 'releve.json'))) return true;
    effacer1(id);
    return false;
  });
  ids.forEach((id, rang) => {
    const quand = Date.parse(`${id.slice(0, 10)}T${id.slice(11, 19).replace(/-/g, ':')}Z`);
    if (rang >= MAX_RELEVES || (Number.isFinite(quand) && maintenant - quand > MAX_JOURS * 86400000)) effacer1(id);
  });
  return effaces;
}

/**
 * La purge de TOUS les comptes, pour l'entretien quotidien : sans elle, les
 * trente jours ne vaudraient que pour qui rouvre « Proposer un service ».
 * Ne lève jamais.
 */
function purgerTout({ dossierRacine = racine(), maintenant = Date.now() } = {}) {
  let effaces = 0;
  try {
    if (!fs.existsSync(dossierRacine)) return 0;
    for (const nom of fs.readdirSync(dossierRacine)) {
      const m = /^u(\d{1,12})$/.exec(nom);
      if (!m) continue;
      effaces += purger(Number(m[1]), { dossierRacine, maintenant });
      // Un dossier de compte vide ne reste pas.
      try {
        fs.rmdirSync(path.join(dossierRacine, nom));
      } catch {
        /* il n'est pas vide, ou il résiste : rien à faire */
      }
    }
  } catch {
    /* la purge suivante reprendra */
  }
  return effaces;
}

// ---------------------------------------------------------------------------
// Le relevé en cours, avec la fenêtre
// ---------------------------------------------------------------------------

let courant = null;

function erreur(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

function gestionnaire(dependances) {
  return (dependances.manager || require('./remote-browser').manager)();
}

/**
 * Pourquoi la première page n'a pas pu s'ouvrir, dit pour la personne — ou
 * null quand l'erreur n'est pas de celles qu'elle peut corriger. Lit le code
 * réseau que Chromium donne (`net::ERR_…`), jamais l'adresse. Pure.
 */
function erreurDOuverture(err, hote = 'ce site') {
  const texte = String(err?.message || '');
  if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_INVALID/.test(texte)) {
    return erreur(`Le site ${hote} est introuvable : vérifiez l'adresse, puis réessayez.`, 400);
  }
  if (/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/.test(texte)) {
    return erreur(`Le navigateur refuse la connexion sécurisée de ${hote} (certificat) : le relevé ne peut pas s'ouvrir sur ce site.`, 400);
  }
  if (/ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED|ERR_ADDRESS_UNREACHABLE/.test(texte)) {
    return erreur(`crabe n'ouvre pas ${hote} : cette adresse lui est interdite (une adresse du réseau local, par exemple).`, 400);
  }
  if (/ERR_CONNECTION_|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_|Timeout \d+ ?ms exceeded/.test(texte)) {
    return erreur(`Le site ${hote} n'a pas répondu : vérifiez l'adresse, ou réessayez dans un instant.`, 502);
  }
  // Un autre refus du réseau : son code suffit, l'adresse tapée ne va nulle part.
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(texte)?.[1];
  if (code) return erreur(`Le site ${hote} n'a pas pu s'ouvrir dans la fenêtre de crabe (${code}). Réessayez dans un instant.`, 502);
  return null;
}

/** La première ligne d'un message d'erreur, sans aucune adresse : ce qu'un journal peut en garder. Pure. */
function sansAdresses(message) {
  return String(message ?? '').slice(0, 2000).split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<adresse>')
    .slice(0, 300);
}

/**
 * Le relevé fini ne retient plus rien. La fenêtre finie garde ses rappels —
 * donc cet état — jusqu'à la fenêtre suivante : les copies, le parcours et
 * les mots à retirer ne vivent que le temps du relevé.
 */
function vider(etat) {
  etat.copies = [];
  etat.evenements = [];
  etat.requetes = [];
  etat.orphelines = [];
  etat.aRetirer = [];
  etat.motsDuSite.clear();
  etat.motsTous = null;
  etat.octetsCopies = 0;
  etat.empreintes.clear();
  etat.empreintesDuReleve.clear();
  etat.vusDocuments.clear();
  etat.onglets.clear();
}

/** Le relevé en cours de ce compte, ou null — un relevé dont la fenêtre s'est fermée est oublié. */
function enCours(userId, dependances = {}) {
  if (!courant || courant.userId !== userId) return null;
  const vue = gestionnaire(dependances).status(userId, ID_FENETRE);
  if (!vue || vue.done || courant.termine) {
    courant = null;
    return null;
  }
  return courant;
}

/**
 * Ouvre la fenêtre sur le site et branche le relevé.
 * @returns {Promise<object>} la vue publique de la fenêtre, jeton compris, et le résumé
 */
async function demarrer({ userId, adresse, masquer = '' }, dependances = {}) {
  const url = normaliserAdresse(adresse);
  const rb = require('./remote-browser');
  rb.exigerAdresseVisitable(url, 'ce site');
  if (courant && !enCours(courant.userId, dependances)) courant = null;
  const etat = nouvelEtat({ userId, url, masquer });
  if (dependances.maintenant) etat.maintenant = dependances.maintenant;
  if (dependances.maintenant) etat.debut = dependances.maintenant();
  let vue;
  try {
    vue = await gestionnaire(dependances).start({
      userId,
      connectorId: ID_FENETRE,
      connectorName: etat.hote,
      url,
      capture: false,
      hint: CONSIGNE,
      // Seuls les écrans de connexion sont recadrés : le reste du site se
      // parcourt sans que la fenêtre fasse défiler quoi que ce soit.
      recadrage: 'connexion',
      // Un site ouvre exprès des onglets de même chemin (/#/factures/42,
      // index.php?page=pdf) : la fenêtre ne les referme pas pendant un relevé.
      doublons: false,
      // Un onglet fermé par mégarde : cinq minutes pour reprendre le relevé depuis la page.
      sursisDetachementMs: SURSIS_REPRISE_MS,
      avantNavigation: (context) => brancher(etat, context),
      onFin: async () => {
        // Toute sortie qui n'est pas « Terminer » oublie le relevé : rien n'est
        // rangé, et ses écoutes se taisent (les copies en attente ne partent plus).
        if (etat.termine) return;
        etat.termine = true;
        for (const onglet of etat.onglets.values()) {
          if (onglet.minuterie) clearTimeout(onglet.minuterie);
        }
        if (courant === etat) courant = null;
        // Un « Terminer » en cours range encore ce relevé : il le videra lui-même.
        if (!etat.enFin) vider(etat);
      },
    });
  } catch (err) {
    if (courant === etat) courant = null;
    // Les refus de la fenêtre proposent un « fichier de session » : c'est le
    // repli d'une connexion, il n'existe pas pour un relevé.
    if (err && err.expose && typeof err.message === 'string') {
      err.message = err.message
        .replace(/,? ou utilisez un fichier de session/g, '')
        .replace(/\s*Vous pouvez continuer avec un fichier de session\./g, '')
        .replace(/Connexion par navigateur indisponible/g, 'La fenêtre de crabe est indisponible sur ce serveur');
      throw err;
    }
    vider(etat);
    // Le site n'a pas pu s'ouvrir : une adresse mal tapée est le cas courant,
    // et « erreur interne » n'aiderait personne à la corriger.
    const refus = erreurDOuverture(err, etat.hote);
    if (refus) throw refus;
    // Une autre panne (le navigateur, la fenêtre) : dite sans le message de
    // Playwright, qui recopie l'adresse tapée — au journal, sa première ligne
    // seulement, adresses retirées.
    try {
      require('./applog').error(
        'releve',
        `Relevé de ${etat.hote} : la fenêtre n'a pas pu s'ouvrir — ${sansAdresses(err?.message)}`,
        { userId }
      );
    } catch {
      /* le journal n'est pas prêt (essais) : rien de plus à dire */
    }
    throw erreur(
      `La fenêtre de crabe n'a pas pu s'ouvrir sur ${etat.hote}. Réessayez dans un instant ; si cela persiste, signalez-le.`,
      502
    );
  }
  courant = etat;
  return { ...vue, releve: resume(etat) };
}

/** La vue de la fenêtre et le résumé du relevé. */
function etatDuReleve(userId, dependances = {}) {
  const vue = gestionnaire(dependances).status(userId, ID_FENETRE);
  if (!vue) return null;
  return { ...vue, releve: courant && courant.userId === userId ? resume(courant) : null };
}

/** Une copie de chaque onglet ouvert, tout de suite. Rend le nombre de copies NOUVELLES. */
async function copierOnglets(etat, raison) {
  let nouvelles = 0;
  for (const [page, onglet] of etat.onglets) {
    if (onglet.ferme) continue;
    if (onglet.minuterie) {
      clearTimeout(onglet.minuterie);
      onglet.minuterie = null;
    }
    if (await suivre(etat, prendreCopie(etat, page, onglet, raison))) nouvelles++;
  }
  return nouvelles;
}

/** « Relever cette page maintenant » : une copie de chaque onglet, tout de suite. */
async function releverMaintenant(userId, dependances = {}) {
  const etat = enCours(userId, dependances);
  if (!etat) throw erreur('Aucun relevé en cours.', 404);
  const nouvelles = await copierOnglets(etat, 'demandée');
  gestionnaire(dependances).activite(userId, ID_FENETRE);
  return { nouvelles, releve: resume(etat) };
}

/**
 * « Terminer le relevé » : une dernière copie de chaque onglet, l'attente des
 * documents en cours de lecture, la fenêtre fermée, puis le rangement.
 * @returns {Promise<object>} l'entrée du relevé rangé
 */
async function terminer(userId, dependances = {}) {
  const etat = enCours(userId, dependances);
  if (!etat) throw erreur('Aucun relevé en cours : la fenêtre a été fermée.', 404);
  // Deux « Terminer » d'affilée (un double clic) ne rangent pas deux archives.
  if (etat.enFin) throw erreur('Le relevé est déjà en cours d\'enregistrement.', 409);
  etat.enFin = true;
  let entree;
  try {
    await copierOnglets(etat, 'fin du relevé');
    const attente = new Promise((resolve) => {
      const t = setTimeout(resolve, dependances.attenteFinMs ?? ATTENTE_FIN_MS);
      t.unref?.();
    });
    await Promise.race([Promise.allSettled([...etat.enCours]), attente]);
    etat.fin = etat.maintenant();
    // « Fermer / Abandonner » est arrivé pendant ces attentes : rien n'est rangé.
    if (etat.abandonne) throw erreur('Le relevé a été abandonné : rien n\'a été enregistré.', 404);
    let version = '';
    try {
      version = String(require('./config').config.version || '');
    } catch {
      version = '';
    }
    // Rangé AVANT de fermer la fenêtre : si le disque refuse, elle reste
    // ouverte, rien n'est perdu, et « Terminer » peut être retenté.
    try {
      entree = ranger(etat, { dossierRacine: dependances.dossierRacine || racine(), version });
    } catch (err) {
      const refus = erreur(
        `Le relevé n'a pas pu être enregistré sur le serveur (${err.code || 'écriture refusée'}). `
          + 'La fenêtre reste ouverte : réessayez, ou voyez avec la personne qui administre ce crabe.',
        507
      );
      refus.cause = err;
      throw refus;
    }
  } finally {
    etat.enFin = false;
    // La fenêtre s'est fermée pendant un enregistrement qui n'a pas abouti : plus rien à garder.
    if (etat.termine && !entree) vider(etat);
  }
  etat.termine = true;
  const r = resume(etat);
  // La fenêtre se ferme ; si elle s'est déjà fermée d'elle-même (un délai
  // tombé pendant l'enregistrement), le relevé est rangé quand même.
  try {
    await gestionnaire(dependances).conclure(userId, ID_FENETRE, {
      ok: true,
      message: `Relevé enregistré : ${r.pages} page(s), ${r.documents} document(s).`,
    });
  } catch {
    /* l'archive est rangée : une fenêtre qui se ferme mal ne l'enlève pas */
  }
  if (courant === etat) courant = null;
  vider(etat);
  return entree;
}

/** « Fermer / Abandonner » : la fenêtre s'éteint, rien n'est rangé — pas même par un « Terminer » en attente. */
async function abandonner(userId, dependances = {}) {
  if (courant && courant.userId === userId) {
    courant.abandonne = true;
    courant = null;
  }
  return gestionnaire(dependances).stop(userId, ID_FENETRE);
}

module.exports = {
  avecDelai,
  ID_FENETRE,
  OBJET_ENVOI,
  ENVOIS_MAX,
  MESSAGE_MAX,
  courrielDeDemande,
  messageDeDemande,
  nomDArchive,
  archiveEnMemoire,
  envoyer,
  CONSIGNE,
  MARQUE_CLIC,
  SCRIPT_CLIC,
  PAGES_MAX,
  MAX_RELEVES,
  MAX_JOURS,
  SURSIS_REPRISE_MS,
  masquerTexte,
  masquerLibelle,
  motsARetirer,
  retirerMots,
  motsDuCompte,
  partout,
  decoderEntites,
  adresseReleve,
  normaliserAdresse,
  erreurDOuverture,
  sansAdresses,
  formeJson,
  decrireDocument,
  nomDeFichier,
  estDocument,
  nettoyerInstantane,
  nettoyerHtml,
  htmlDeLaCopie,
  nomDeCopie,
  ligneDeClic,
  ecoule,
  squeletteDeLaPage,
  nouvelEtat,
  brancher,
  prendreCopie,
  copierOnglets,
  ressembleAUneListe,
  noterEtapes,
  noterDocument,
  etapesPubliques,
  bilanDesEtapes,
  resume,
  texteDuParcours,
  ranger,
  lister,
  chemin,
  fichiers,
  effacer,
  effacerTout,
  purger,
  purgerTout,
  idValide,
  demarrer,
  etatDuReleve,
  releverMaintenant,
  terminer,
  abandonner,
  enCours,
  /** Pour les essais : oublie le relevé en cours. */
  _oublier: () => {
    courant = null;
  },
};
