'use strict';

/**
 * Connecteur Bricomarché — la page « Mes achats », lue d'après son vrai code
 * (lot 93), ses deux onglets, le relevé de la facture qui viendra, et le
 * ticket de caisse de chaque achat en magasin (lot 94).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * MESURÉ en automatique (journaux des lots 47 à 92) :
 *
 *   - `/my-account` REDIRIGE les anonymes vers `/login` (sonde lot 48) — y
 *     rester, sans bouton « Se connecter », prouve la session ;
 *   - le MUR DE SESSION du lot 53 : la lecture automatique n'est servie que
 *     dans la foulée d'une connexion fraîche par la fenêtre ; une lecture à
 *     froid est renvoyée vers `/login`, et `erreurRenvoiVersAuthentification`
 *     le dit ;
 *   - depuis le 05/10/2026, `/my-account` aboutit DIRECTEMENT sur
 *     `/my-account/orders?choiceOrder=0` (passages n° 698, 700 et 703) ;
 *   - la liste ne vaut « toutes les commandes » qu'avec ses paramètres
 *     (lot 79) : `adresseHistorique()` les garantit.
 *
 * LU DANS LE CODE SOURCE de la page, enregistré par l'utilisateur le 06/10/2026 (le
 * prompt du lot 93 en a repris la structure, sans aucune donnée) :
 *
 *   - `title` « Mon compte », lien canonique `/my-account/orders` ;
 *   - « Mes achats » est un `h3` (les `h2` sont « Aide & support » et le
 *     « Commande » de chaque carte) ;
 *   - les onglets sont deux `button type="button"` SANS adresse, repérés par
 *     `data-testid` (`account_filtered-orders_tab-web`, `…_tab-instore`),
 *     texte dans `span.btn-label`, sans `aria-selected` ni `role="tab"` :
 *     l'actif porte `font-bold` et une classe en `-selected` ;
 *   - le filtre est `select#historyOrderFilter-select` (`default`, une option
 *     par année, `all` = « Toutes mes commandes ») ;
 *   - le menu de gauche : des liens `account_menu_<chemin>`, et la
 *     déconnexion `a[href="/logout"]`, `account_menu_logout` ;
 *   - « En ligne » : une `section` par mois (`p.heading-s`), une `ul` dont
 *     chaque `li` est une commande — `h2` « Commande » + `span` du numéro
 *     (deux lettres puis des chiffres), prix (`aria-label` « Prix du
 *     produit: »), état (`div[role="status"]`), `time[datetime]` ISO autour de
 *     « Commande passée en ligne le … », « Vendue par … », puis le CHEVRON
 *     `account_web-order-item_toggle-details` (`aria-expanded`,
 *     `aria-controls="order-details-<n°>"`) qui DÉPLIE les détails dans la
 *     page. AUCUN lien : une commande ne s'ouvre pas, elle se déplie ;
 *   - « En magasin » : même groupement ; chaque `li` porte une date, un prix
 *     et le bouton `account_purchase-history_view-ticket` « Voir mon ticket ».
 *     Pas de numéro visible.
 *
 * ANNONCÉ par l'utilisateur le 06/10/2026 (lot 94) : un clic sur « Voir mon ticket »
 * TÉLÉCHARGE un PDF — le ticket de caisse —, directement, sans fenêtre ni
 * étape. Personne n'a vu ce PDF ni la requête qui le sert.
 *
 * NON MESURÉ : ce que contient le volet déplié (la page a été enregistrée
 * repliée) ; le nom et le contenu du ticket, la voie qui l'apporte
 * (téléchargement, réponse lue par la page, onglet) ; l'ordre de la page
 * entre deux achats du même jour.
 *
 * ─── Pourquoi le lot 92 lisait « 0 commande » (docs/reconnaissance-lot93.md) ─
 *
 * Il cherchait le titre en `h1, h2` seulement, et une commande comme un LIEN
 * « Commande <n°> » hors de tout `header`. Sur la vraie page, aucune commande
 * n'est un lien, et son titre vit dans le `header` de sa carte : 0 commande,
 * ni phrase de vide — « page illisible », à juste titre.
 *
 * ─── À quoi il s'accroche maintenant ─────────────────────────────────────────
 *
 * Aux REPÈRES stables d'abord (`data-testid`, l'identifiant du `select`, le
 * lien `/logout`), aux textes ensuite. Six signes, dont quatre suffisent
 * (`reconnaitre`) : un repère renommé, un titre changé, ne font pas tomber la
 * lecture. Une page connectée mais méconnaissable se dit « page illisible »,
 * jamais « rouvrez la connexion ».
 *
 * ─── Quatre clics permis, pas un de plus (lot 93, R4 ; lot 94, R6) ──────────
 *
 * Changer d'onglet, déplier une commande et demander un ticket n'ont pas
 * d'adresse : il faut cliquer. Les clics vivent dans UNE fonction
 * (`CLIQUER_PAR_REPERE`) qui ne reçoit jamais de sélecteur : elle reçoit une
 * CLÉ de la liste fermée `CLICS_PERMIS` — l'onglet « En magasin », l'onglet
 * « En ligne », le chevron d'une commande, « Voir mon ticket » —, compare le
 * `data-testid` de chaque bouton à la valeur exacte, le recontrôle au moment
 * du clic, et rend ce qu'elle a cliqué, que Node revérifie. Un chevron déjà
 * déplié n'est jamais recliqué (il se replierait). Rien du volet déplié n'est
 * cliqué. Un repère renommé : la page reste LUE par ses textes, mais plus rien
 * ne se clique sous ce repère.
 *
 * ─── Le ticket de caisse (lot 94) ─────────────────────────────────────────────
 *
 * « Voir mon ticket » se clique en DERNIER, une fois les deux onglets lus,
 * dans l'onglet « En magasin » affiché et seulement là, un ticket à la fois :
 * le suivant n'est demandé que quand le précédent a rendu son PDF ou échoué.
 * Le PDF est pris par le socle `clic-document` (téléchargement, onglet ou
 * réponse — la voie n'est pas supposée), comme chez Decathlon, et refusé s'il
 * ne commence pas par `%PDF-`. Au moment du clic, la carte de l'achat est
 * recontrôlée (son texte doit être celui qui a été lu) : un ticket n'est
 * jamais déposé sous l'ancre d'un autre achat.
 *
 * TOUT LE RESTE ARRÊTE (R7) : un clic qui ne rend pas un PDF — une fenêtre, un
 * formulaire, une autre page, rien — met fin aux tickets pour tout le
 * passage. Rien n'est rempli, rien n'est refermé en cliquant, la page n'est
 * plus touchée ; les tickets déjà pris sont gardés, et l'écran dit ce qui a
 * bloqué.
 *
 * L'ANCRE (R8) : la page ne montre ni numéro ni adresse. Un ticket s'ancre sur
 * ce qui se lit — la date et le montant de l'achat —, et sur un rang quand
 * plusieurs achats partagent la même date et le même montant, compté du plus
 * ancien au plus récent : un achat nouveau ne décale pas les rangs existants.
 * `bricomarche-ticket-<AAAA-MM-JJ>-<euros>-<centimes>EUR[-<rang>]`, nom
 * `bricomarche_<AAAA-MM>_ticket-…pdf`. Un achat dont la date ou le montant ne
 * se lit pas n'a pas d'ancre sûre : son ticket n'est pas demandé, et c'est dit.
 * Un ticket déjà dans l'archive n'est jamais recliqué.
 *
 * LE TEMPS (R9) : le planificateur ne dépose rien d'une exécution qui dépasse
 * sa limite (lot 93, mesuré chez Gandi) ; les tickets s'arrêtent donc d'eux-
 * mêmes aux deux tiers de cette limite, et rendent ce qui est pris. Le reste
 * vient au passage suivant — y compris en « Depuis la dernière
 * récupération », qui prend ici tout ce qui manque à l'archive (dans la
 * limite de la conservation).
 *
 * ─── La facture qui viendra : relevée, jamais cliquée ────────────────────────
 *
 * Personne n'a vu le bouton de facture de Bricomarché. Dans le volet déplié de
 * chaque commande (et sur sa carte), tout élément qui évoque une facture est
 * RELEVÉ — libellé chiffres masqués, lien ou bouton, avec ou sans adresse —
 * sans être touché, et l'écran demande de le signaler.
 *
 * ─── Le reçu reconstitué du lot 78 : suspendu (lot 92) ───────────────────────
 *
 * Le reçu prendrait l'ancre de la commande — celle de la facture attendue,
 * dont le remplacement n'a jamais été codé. Il ne tourne plus ; son gabarit et
 * son ancre restent ici, en réserve (`construireRecu`, `remoteIdCommande`).
 */

const profilMarchand = require('../../profil-marchand');
const releve = require('../../releve-reconstitue');
const clicDocument = require('../../clic-document');
const identity = require('../../browser-identity');
const pageDocs = require('../../documents-de-page');
const history = require('../../history');
const scraping = require('../../scraping');

const ID = 'bricomarche';
const NOM = 'Bricomarché';

// Mesuré le 23/08/2026 (sonde lot 48, visiteur anonyme) : le lien « Se
// connecter » du site pointe sur /my-account, qui REDIRIGE les anonymes vers
// /login. C'est le point d'entrée prouvé de l'espace client.
const URL_COMMANDES = 'https://www.bricomarche.com/my-account';
const CHEMIN_LISTE = /\/my-account/i;

/**
 * Les paramètres SANS lesquels la liste ne montre pas toutes les commandes
 * (mesuré par l'utilisateur le 09/09/2026, revu le 05/10 : « Toutes mes commandes »).
 * La requête fait partie de l'adresse — voir l'en-tête du fichier.
 */
const PARAMETRES_HISTORIQUE = { choiceOrder: '0', historyOrderFilter: 'all' };
/** Le chemin de la liste, journalisé aux lots 78, 91 et 92. */
const CHEMIN_HISTORIQUE = '/my-account/orders';

/**
 * L'adresse de la liste AVEC ses paramètres. Part d'un href quand il est
 * fourni (si le site déplace la page, on le suit), et garantit les deux
 * paramètres mesurés sans écraser ceux que le lien porterait déjà. Fonction
 * pure, testée — le test qui la couvre verrouille la régression du lot 78.
 */
function adresseHistorique(href, base) {
  const url = new URL(href || CHEMIN_HISTORIQUE, base || 'https://www.bricomarche.com/');
  for (const [cle, valeur] of Object.entries(PARAMETRES_HISTORIQUE)) {
    if (!url.searchParams.has(cle)) url.searchParams.set(cle, valeur);
  }
  return url.href;
}

/** Les libellés des onglets (casse et espaces normalisés). */
const ONGLET_EN_LIGNE = 'En ligne';
const ONGLET_EN_MAGASIN = 'En magasin';

/**
 * Les repères stables relevés dans le code source du 06/10/2026 (annoncé,
 * prompt du lot 93, §2.1). C'est à eux que la lecture s'accroche d'abord.
 */
const REPERES = Object.freeze({
  ongletEnLigne: 'account_filtered-orders_tab-web',
  ongletEnMagasin: 'account_filtered-orders_tab-instore',
  deplier: 'account_web-order-item_toggle-details',
  ticket: 'account_purchase-history_view-ticket',
  menuAchats: 'account_menu_/my-account/orders',
  deconnexion: 'account_menu_logout',
  /** L'identifiant (`id`) du filtre, pas un `data-testid`. */
  filtre: 'historyOrderFilter-select',
});

/**
 * Les SEULS clics de ce connecteur (lot 93, R4) : une liste FERMÉE, chaque
 * élément désigné par son `data-testid` exact. Le lot 94 y ajoute UNE clé,
 * « Voir mon ticket » (R6). Rien d'autre ne se clique — ni rien du volet
 * déplié, ni un élément trouvé par son texte.
 */
const CLICS_PERMIS = Object.freeze({
  ongletEnMagasin: REPERES.ongletEnMagasin,
  ongletEnLigne: REPERES.ongletEnLigne,
  deplier: REPERES.deplier,
  ticket: REPERES.ticket,
});

/** Ce qui évoque une facture : relevé, jamais cliqué. */
const MOTIF_FACTURE = /factur|invoice|justificatif|\bpdf\b/i;
/**
 * Un panneau qui se DIT vide : la phrase doit parler de commande ou d'achat,
 * et elle se cherche sur des éléments courts — jamais sur le texte entier de
 * la page, où « Vous n'avez pas trouvé ? » ferait un faux vide.
 */
const MOTIF_VIDE = /aucun(e)?\s+(commande|achat)|vous n'avez\s+(pas encore|pas|jamais|aucun(e)?)\b[^.]{0,60}\b(commande|achat)/i;

/**
 * Le nombre de signes, sur six, qui suffit à reconnaître « Mes achats » :
 * deux peuvent changer sans que la page cesse d'être reconnue.
 */
const SIGNES_REQUIS = 4;

/** Combien de commandes se déplient au plus par passage (une borne, dite). */
const DEPLIAGES_MAX = 100;

/**
 * La limite d'une exécution (lot 67), relue comme le planificateur la relit :
 * `CRABE_LIMITE_EXECUTION_MS`, sinon quarante-cinq minutes — la même valeur
 * que `scheduler.LIMITE_EXECUTION_MS` (un test le vérifie).
 */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;

/**
 * La part de cette limite que les tickets s'accordent (R9). Le planificateur
 * ne dépose rien d'une exécution qui dépasse sa limite : passé ce délai,
 * aucun ticket de plus n'est demandé, et ce qui est pris est rendu.
 */
const PART_DU_TEMPS = 2 / 3;

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

/** L'horloge du budget — remplaçable par les essais, pour l'éprouver sans attendre. */
const horloge = {
  maintenant: () => Date.now(),
};

/** `/login` est couvert par le motif générique. */
function estPageAuthentification(url) {
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
 * La page est atteinte, la connexion est bonne, mais la liste ne se lit pas :
 * le dire tel quel, avec quoi faire — et JAMAIS « rouvrez la connexion »
 * (lot 92 : le conseil était faux, la connexion venait d'être rouverte).
 */
function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre espace client, mais crabe n'a pas su y lire vos achats : la page `
      + 'ne ressemble plus à celle qu\'il connaît (« Mes achats », avec les onglets « En ligne » et '
      + '« En magasin »). Votre connexion n\'est pas en cause : inutile de la rouvrir. Signalez-le '
      + 'pour que la lecture soit mise à jour ; la prochaine récupération réessaiera d\'elle-même.'
  );
  err.precision = detail;
  return err;
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // La redirection des anonymes est MESURÉE depuis le 23/08/2026 (sonde
        // lot 48) : /my-account renvoie les visiteurs vers /login.
        redirigeLesAnonymes: true,
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw erreurPageInconnue(etat.raison);
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// Reconnaître « Mes achats » — les repères d'abord, les textes ensuite
// ---------------------------------------------------------------------------

/**
 * Les six signes de la page, relevés dans la page. Chacun dit s'il a été
 * trouvé par son REPÈRE ou seulement par son TEXTE (`parTexte`) : un repère
 * qui manque se journalise, c'est le premier indice d'une page qui change.
 */
const RELEVER_LES_SIGNES = ({ reperes, ongletLigne, ongletMagasin }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const parRepere = (testid) => [...document.querySelectorAll('[data-testid]')]
    .some((el) => el.getAttribute('data-testid') === testid && visible(el));
  const textes = (sel) => [...document.querySelectorAll(sel)].filter(visible).map((el) => norm(el.innerText));
  const boutons = textes('a, button, [role="tab"]');
  const select = document.getElementById(reperes.filtre);
  const options = [...document.querySelectorAll('select option')]
    .map((o) => ({ texte: norm(o.textContent), valeur: o.value, choisie: o.selected }));
  const lienDeconnexion = [...document.querySelectorAll('a[href]')].some((a) => {
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      return u.origin === location.origin && u.pathname === '/logout' && visible(a);
    } catch {
      return false;
    }
  });

  const repere = {
    titre: false,
    ongletEnLigne: parRepere(reperes.ongletEnLigne),
    ongletEnMagasin: parRepere(reperes.ongletEnMagasin),
    filtre: !!(select && select.tagName === 'SELECT'),
    deconnexion: lienDeconnexion || parRepere(reperes.deconnexion),
  };
  const texte = {
    // Le titre n'a pas de repère : il se trouve quel que soit son niveau.
    titre: textes('h1, h2, h3, h4, h5, h6, [role="heading"]').some((t) => t === 'mes achats'),
    ongletEnLigne: boutons.includes(norm(ongletLigne)),
    ongletEnMagasin: boutons.includes(norm(ongletMagasin)),
    filtre: options.some((o) => o.texte === 'toutes mes commandes')
      || textes('button, [role="combobox"], label, span').some((t) => t === 'toutes mes commandes'),
    deconnexion: boutons.some((t) => /^(me |se )?d[ée]connecter$|^d[ée]connexion$/.test(t)),
  };
  const choisie = select && select.tagName === 'SELECT'
    ? (select.value === 'all' || norm(select.options[select.selectedIndex]?.textContent) === 'toutes mes commandes')
    : options.length
      ? options.some((o) => o.texte === 'toutes mes commandes' && o.choisie)
      : textes('button, [role="combobox"], span').some((t) => t === 'toutes mes commandes');
  return {
    adresse: /\/my-account\/orders(\/|$)/i.test(location.pathname),
    titre: texte.titre,
    ongletEnLigne: repere.ongletEnLigne || texte.ongletEnLigne,
    ongletEnMagasin: repere.ongletEnMagasin || texte.ongletEnMagasin,
    filtre: repere.filtre || texte.filtre,
    deconnexion: repere.deconnexion || texte.deconnexion,
    // Le filtre est VÉRIFIÉ quand « Toutes mes commandes » est la valeur
    // choisie — ou, sans liste déroulante, le texte affiché par le menu.
    filtreChoisi: !!choisie,
    parTexte: ['ongletEnLigne', 'ongletEnMagasin', 'filtre', 'deconnexion']
      .filter((cle) => !repere[cle] && texte[cle]),
  };
};

/** Les signes comptés, et la décision. Pure, testée. */
function reconnaitre(signes) {
  const cles = ['adresse', 'titre', 'ongletEnLigne', 'ongletEnMagasin', 'filtre', 'deconnexion'];
  const presents = cles.filter((cle) => signes?.[cle]);
  return {
    reconnue: presents.length >= SIGNES_REQUIS,
    presents,
    absents: cles.filter((cle) => !signes?.[cle]),
  };
}

// ---------------------------------------------------------------------------
// Les onglets : lequel est l'actif
// ---------------------------------------------------------------------------

/**
 * Un onglet est-il l'ACTIF ? Mesuré dans le code source : ni `aria-selected`
 * ni `role="tab"`, l'actif porte `font-bold` ET une classe en `-selected`.
 * Les attributs d'accessibilité restent acceptés s'ils apparaissent un jour.
 * Pure, testée.
 *
 * @param {{classes?: string[], ariaSelected?: string|null, ariaPressed?: string|null,
 *   ariaCurrent?: string|null}|null} onglet
 */
function ongletActif(onglet) {
  if (!onglet) return false;
  if (onglet.ariaSelected === 'true' || onglet.ariaPressed === 'true') return true;
  if (onglet.ariaCurrent && onglet.ariaCurrent !== 'false') return true;
  const classes = onglet.classes || [];
  return classes.includes('font-bold') && classes.some((c) => /-selected$/.test(c));
}

/**
 * Les deux onglets tels que la page les montre : trouvés par leur repère, ou
 * à défaut par leur texte (pour LIRE lequel est actif — jamais pour cliquer),
 * avec ce qu'il faut pour juger l'actif, et une empreinte du contenu affiché.
 */
const LIRE_LES_ONGLETS = ({ reperes, ongletLigne, ongletMagasin }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const trouver = (testid, libelle) => {
    const parRepere = [...document.querySelectorAll('[data-testid]')]
      .find((el) => el.getAttribute('data-testid') === testid && visible(el));
    const el = parRepere || [...document.querySelectorAll('button, a, [role="tab"]')]
      .filter((e) => visible(e) && norm(e.innerText) === norm(libelle))
      .filter((e, _i, tous) => !tous.some((autre) => autre !== e && e.contains(autre)))[0];
    if (!el) return null;
    return {
      parRepere: !!parRepere,
      classes: [...el.classList],
      ariaSelected: el.getAttribute('aria-selected'),
      ariaPressed: el.getAttribute('aria-pressed'),
      ariaCurrent: el.getAttribute('aria-current'),
    };
  };
  const zone = document.querySelector('main') || document.body;
  return {
    web: trouver(reperes.ongletEnLigne, ongletLigne),
    magasin: trouver(reperes.ongletEnMagasin, ongletMagasin),
    // Le contenu affiché, pour juger qu'il a CHANGÉ après un clic : le texte
    // de la zone principale (les libellés d'onglets n'y changent pas).
    empreinte: norm(zone.innerText).slice(0, 20000),
  };
};

// ---------------------------------------------------------------------------
// Lire un onglet
// ---------------------------------------------------------------------------

/**
 * L'onglet « En ligne » : chaque commande, par son chevron (repère) et par son
 * titre « Commande … » (texte) — la carte est le `li` qui les porte. Pour
 * chacune : le numéro (le `span` du titre), la date (`time[datetime]`), l'état
 * (`role="status"`), le vendeur (« Vendue par »), le chevron (rang, état
 * déplié), et ce qui, sur la carte, évoque une facture.
 */
const LIRE_EN_LIGNE = ({ reperes, motifFacture, motifVide }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const reFacture = new RegExp(motifFacture, 'i');
  const reVide = new RegExp(motifVide, 'i');
  const zone = document.querySelector('main') || document.body;
  const horsCompte = (el) => !!el.closest('nav, footer, aside, [role="navigation"], [role="contentinfo"]');
  const chevrons = [...document.querySelectorAll('button')]
    .filter((el) => el.getAttribute('data-testid') === reperes.deplier && visible(el));
  const titres = [...zone.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .filter((h) => visible(h) && !horsCompte(h) && /^commande\b/i.test(norm(h.innerText)));

  const cartes = [];
  const ajouter = (carte) => { if (carte && !cartes.includes(carte)) cartes.push(carte); };
  for (const h of titres) ajouter(h.closest('li') || h.parentElement);
  for (const c of chevrons) ajouter(c.closest('li') || c.parentElement);

  const numeroDe = (carte) => {
    const titre = [...carte.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
      .find((h) => /^commande\b/i.test(norm(h.innerText)));
    const span = titre && titre.querySelector('span');
    const brut = norm(span ? span.innerText : (titre ? norm(titre.innerText).replace(/^commande\s*(n[°o]\.?)?\s*:?\s*/i, '') : ''));
    if (/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(brut) && /\d/.test(brut)) return brut;
    // Sans titre lisible : le numéro que porte le chevron (`order-details-<n°>`).
    const chevron = [...carte.querySelectorAll('button')].find((b) => b.getAttribute('data-testid') === reperes.deplier);
    const controle = chevron ? String(chevron.getAttribute('aria-controls') || '') : '';
    const m = /^order-details-([A-Za-z0-9-]{3,40})$/.exec(controle);
    return m && /\d/.test(m[1]) ? m[1] : null;
  };
  const relever = (racine, exclus) => [...racine.querySelectorAll('a, button, [role="button"]')]
    .filter((el) => visible(el) && !exclus.includes(el))
    .filter((el) => reFacture.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`))
    .map((el) => {
      const href = el.getAttribute('href') || '';
      return {
        libelle: norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title')).slice(0, 80),
        nature: el.tagName === 'A' ? 'lien' : 'bouton',
        avecAdresse: !!href && href !== '#' && !/^javascript:/i.test(href),
        telechargement: el.hasAttribute('download'),
        nouvelOnglet: el.getAttribute('target') === '_blank',
      };
    });

  const vus = new Set();
  const commandes = [];
  for (const carte of cartes) {
    const numero = numeroDe(carte);
    const cle = numero || `#${cartes.indexOf(carte)}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const chevron = [...carte.querySelectorAll('button')]
      .find((b) => b.getAttribute('data-testid') === reperes.deplier && visible(b));
    const temps = carte.querySelector('time[datetime]');
    const phraseDate = [...carte.querySelectorAll('p, span, time')]
      .map((e) => norm(e.innerText)).find((t) => /pass[ée]e en ligne le/i.test(t)) || '';
    const vendeur = [...carte.querySelectorAll('p, span, div')]
      .map((e) => norm(e.innerText)).find((t) => /^vendue? par\s+\S/i.test(t)) || '';
    const statut = carte.querySelector('[role="status"]');
    commandes.push({
      numero,
      datetime: temps ? String(temps.getAttribute('datetime') || '') : '',
      phraseDate,
      etat: statut ? norm(statut.innerText).slice(0, 60) : '',
      vendeur: vendeur.replace(/^vendue? par\s+/i, '').slice(0, 80),
      chevron: chevron ? {
        rang: chevrons.indexOf(chevron),
        deplie: chevron.getAttribute('aria-expanded') === 'true',
        controle: String(chevron.getAttribute('aria-controls') || ''),
      } : null,
      factures: relever(carte, chevron ? [chevron] : []),
    });
  }
  const phrasesVides = [...zone.querySelectorAll('p, div, span, li')]
    .filter((e) => visible(e) && !horsCompte(e) && !e.children.length)
    .map((e) => norm(e.innerText))
    .filter((t) => t.length <= 200 && reVide.test(t));
  return { commandes, vide: !commandes.length && phrasesVides.length > 0 };
};

/**
 * L'onglet « En magasin » : chaque achat, par son bouton « Voir mon ticket »
 * (repère, puis texte) ou par son prix — la carte est le `li` qui les porte,
 * jamais une carte de commande en ligne. Pour chacun : la date affichée, le
 * montant lu (présent ou non), le ticket, et ce qui évoque une facture.
 *
 * Lot 94 : les cartes sont rendues dans l'ORDRE DE LA PAGE (le rang d'un
 * ticket en dépend) ; chacune porte en plus le TEXTE de son montant
 * (`montant`, lu dans l'`aria-label` « Prix du produit: … » puis dans le texte
 * affiché), le RANG de son bouton parmi les boutons au repère exact — la même
 * énumération que `CLIQUER_PAR_REPERE` —, et le texte de la carte
 * (`texteCarte`), recontrôlé au moment du clic. Rien de cela n'est jamais
 * journalisé.
 */
const LIRE_EN_MAGASIN = ({ reperes, motifFacture, motifVide }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const reFacture = new RegExp(motifFacture, 'i');
  const reVide = new RegExp(motifVide, 'i');
  const zone = document.querySelector('main') || document.body;
  const horsCompte = (el) => !!el.closest('nav, footer, aside, [role="navigation"], [role="contentinfo"]');
  const estTicket = (el) => el.getAttribute('data-testid') === reperes.ticket
    || /^voir mon ticket$/i.test(norm(el.innerText));
  const estCommandeEnLigne = (li) => [...li.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .some((h) => /^commande\b/i.test(norm(h.innerText)))
    || [...li.querySelectorAll('button')].some((b) => b.getAttribute('data-testid') === reperes.deplier);

  const cartes = [];
  const ajouter = (li) => { if (li && !cartes.includes(li) && !estCommandeEnLigne(li)) cartes.push(li); };
  for (const b of zone.querySelectorAll('button, a, [role="button"]')) {
    if (visible(b) && !horsCompte(b) && estTicket(b)) ajouter(b.closest('li'));
  }
  for (const p of zone.querySelectorAll('[aria-label]')) {
    if (visible(p) && !horsCompte(p) && /^prix du produit/i.test(p.getAttribute('aria-label'))) ajouter(p.closest('li'));
  }
  // L'ordre de la page, pas celui de la recherche : le rang d'un ticket en dépend.
  cartes.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // La même énumération que `CLIQUER_PAR_REPERE` : des `button` au repère EXACT, visibles.
  const boutonsTicket = [...document.querySelectorAll('button')]
    .filter((el) => el.getAttribute('data-testid') === reperes.ticket && visible(el));
  const achats = cartes.map((li) => {
    const ticket = [...li.querySelectorAll('button, a, [role="button"]')].find((b) => visible(b) && estTicket(b));
    const date = [...li.querySelectorAll('p, span, time')]
      .map((e) => norm(e.innerText)).find((t) => /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t)) || '';
    const prix = [...li.querySelectorAll('[aria-label]')].find((e) => /^prix du produit/i.test(e.getAttribute('aria-label')));
    const etiquette = prix ? norm(prix.getAttribute('aria-label')).replace(/^prix du produit\s*:?\s*/i, '') : '';
    return {
      date,
      montantLu: !!(prix && /\d/.test(`${prix.getAttribute('aria-label')} ${prix.innerText}`)),
      montant: prix ? (/\d/.test(etiquette) ? etiquette : norm(prix.innerText)).slice(0, 40) : '',
      ticket: ticket ? {
        parRepere: ticket.getAttribute('data-testid') === reperes.ticket,
        rang: boutonsTicket.indexOf(ticket),
      } : null,
      texteCarte: norm(li.innerText).slice(0, 400),
      factures: [...li.querySelectorAll('a, button, [role="button"]')]
        .filter((el) => visible(el) && el !== ticket)
        .filter((el) => reFacture.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`))
        .map((el) => {
          const href = el.getAttribute('href') || '';
          return {
            libelle: norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title')).slice(0, 80),
            nature: el.tagName === 'A' ? 'lien' : 'bouton',
            avecAdresse: !!href && href !== '#' && !/^javascript:/i.test(href),
            telechargement: el.hasAttribute('download'),
            nouvelOnglet: el.getAttribute('target') === '_blank',
          };
        }),
    };
  });
  const commandesEnLigne = [...document.querySelectorAll('button')]
    .filter((b) => b.getAttribute('data-testid') === reperes.deplier && visible(b)).length
    + [...zone.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((h) => visible(h) && /^commande\b/i.test(norm(h.innerText))).length;
  const phrasesVides = [...zone.querySelectorAll('p, div, span, li')]
    .filter((e) => visible(e) && !horsCompte(e) && !e.children.length)
    .map((e) => norm(e.innerText))
    .filter((t) => t.length <= 200 && reVide.test(t));
  return { achats, vide: !achats.length && phrasesVides.length > 0, commandesEnLigne };
};

/**
 * Le volet déplié d'UNE commande : la zone que son chevron contrôle
 * (`aria-controls`), ou à défaut la carte entière. Ce qui y évoque une
 * facture est relevé, jamais cliqué.
 */
const RELEVER_LE_VOLET = ({ controle, rang, reperes, motifFacture }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const reFacture = new RegExp(motifFacture, 'i');
  const chevrons = [...document.querySelectorAll('button')]
    .filter((el) => el.getAttribute('data-testid') === reperes.deplier && visible(el));
  const chevron = chevrons[rang] || null;
  const volet = controle ? document.getElementById(controle) : null;
  const deplie = !!(chevron && chevron.getAttribute('aria-expanded') === 'true');
  if (!deplie) return { deplie: false, voletVu: false, factures: [] };
  const racine = volet && visible(volet) ? volet : null;
  if (!racine) return { deplie: true, voletVu: false, factures: [] };
  return {
    deplie: true,
    voletVu: true,
    factures: [...racine.querySelectorAll('a, button, [role="button"]')]
      .filter((el) => visible(el))
      .filter((el) => reFacture.test(`${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`))
      .map((el) => {
        const href = el.getAttribute('href') || '';
        return {
          libelle: norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title')).slice(0, 80),
          nature: el.tagName === 'A' ? 'lien' : 'bouton',
          avecAdresse: !!href && href !== '#' && !/^javascript:/i.test(href),
          telechargement: el.hasAttribute('download'),
          nouvelOnglet: el.getAttribute('target') === '_blank',
        };
      }),
  };
};

// ---------------------------------------------------------------------------
// Le SEUL clic de ce fichier
// ---------------------------------------------------------------------------

/**
 * Clique UN bouton désigné par son `data-testid` exact — et rien d'autre.
 *
 * Elle ne reçoit pas de sélecteur : `attendu` est une valeur de
 * `CLICS_PERMIS`, comparée à l'attribut par égalité stricte (jamais un motif,
 * jamais une requête CSS composée). Seuls les `button` visibles et actifs sont
 * candidats ; le repère est RECONTRÔLÉ juste avant le clic ; un chevron déjà
 * déplié n'est jamais recliqué. Rend le repère cliqué, ou `null`.
 *
 * `carte` (lot 94, le ticket) : le texte attendu de la carte (`li`) qui porte
 * le bouton. Recontrôlé au moment du clic : si la carte n'est plus celle qui a
 * été lue, rien ne part — un ticket ne se dépose jamais sous l'ancre d'un
 * autre achat. Un ticket marqué `aria-disabled` ne part pas non plus ; cette
 * garde-là ne vaut que pour lui (R11 : les trois autres clics ne changent
 * pas).
 */
const CLIQUER_PAR_REPERE = ({ attendu, rang, deplier, carte }) => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const candidats = [...document.querySelectorAll('button')]
    .filter((el) => el.getAttribute('data-testid') === attendu && visible(el));
  const cible = candidats[rang || 0];
  if (!cible || cible.disabled) return null;
  if (deplier && cible.getAttribute('aria-expanded') !== 'false') return null;
  // Le ticket seul (lot 94) : actif au sens large — ni `disabled` ni
  // `aria-disabled` —, et porté par la carte qui a été lue. Les trois autres
  // clics gardent exactement les gardes du lot 93.
  if (typeof carte === 'string' && cible.getAttribute('aria-disabled') === 'true') return null;
  if (typeof carte === 'string' && norm(cible.closest('li') ? cible.closest('li').innerText : '').slice(0, 400) !== carte) return null;
  if (cible.getAttribute('data-testid') !== attendu) return null;
  cible.click();
  return cible.getAttribute('data-testid');
};

/**
 * Le côté Node du clic : une CLÉ de la liste fermée, jamais autre chose. Le
 * repère rendu par la page est revérifié ; un écart arrête le passage net.
 * Un ticket ne se demande qu'avec le texte de sa carte (`carte`), recontrôlé
 * dans la page au moment du clic.
 *
 * @returns {Promise<boolean>} vrai si le bouton a été cliqué
 */
async function cliquer(page, cle, rang = 0, carte = null) {
  if (!Object.prototype.hasOwnProperty.call(CLICS_PERMIS, cle)) {
    throw new Error(`${ID} : « ${cle} » n'est pas un clic permis — rien n'a été cliqué.`);
  }
  if (cle === 'ticket' && typeof carte !== 'string') {
    throw new Error(`${ID} : un ticket ne se demande qu'avec la carte de son achat — rien n'a été cliqué.`);
  }
  const attendu = CLICS_PERMIS[cle];
  const clique = await page.evaluate(CLIQUER_PAR_REPERE, {
    attendu, rang, deplier: cle === 'deplier', ...(cle === 'ticket' ? { carte } : {}),
  }).catch(() => null);
  if (clique !== null && clique !== attendu) {
    throw new Error(`${ID} : le bouton cliqué ne portait pas le repère attendu — passage arrêté.`);
  }
  return clique === attendu;
}

// ---------------------------------------------------------------------------
// Les gestes de lecture, et leurs attentes bornées
// ---------------------------------------------------------------------------

function attendre(page, ms) {
  return page.waitForTimeout(ms).catch(() => {});
}

/** Les deux onglets, lus. */
function lireLesOnglets(page) {
  return page.evaluate(LIRE_LES_ONGLETS, {
    reperes: REPERES, ongletLigne: ONGLET_EN_LIGNE, ongletMagasin: ONGLET_EN_MAGASIN,
  }).catch(() => ({ web: null, magasin: null, empreinte: '' }));
}

/** Attend qu'un panneau se peigne : des éléments, ou un panneau qui se dit vide. */
async function lirePanneau(page, fonction, cle) {
  let lu = null;
  for (let tour = 0; tour < 8; tour++) {
    lu = await page.evaluate(fonction, {
      reperes: REPERES, motifFacture: MOTIF_FACTURE.source, motifVide: MOTIF_VIDE.source,
    }).catch(() => null);
    if (lu && (lu[cle].length || lu.vide)) return lu;
    await attendre(page, 1_000);
  }
  return lu || { [cle]: [], vide: false };
}

/**
 * Passe à l'onglet `vers` par SON clic, et ne rend la main que si l'onglet est
 * DEVENU l'actif ET que le contenu a CHANGÉ (R3). Sinon : pourquoi, en clair,
 * pour le journal — et l'onglet n'est pas lu, jamais compté « 0 ».
 *
 * @returns {Promise<{ok: true} | {ok: false, raison: string}>}
 */
async function passerALOnglet(page, vers) {
  const cle = vers === 'magasin' ? 'ongletEnMagasin' : 'ongletEnLigne';
  const autre = vers === 'magasin' ? 'web' : 'magasin';
  const avant = await lireLesOnglets(page);
  if (!avant[vers]?.parRepere) {
    return { ok: false, raison: `son repère « ${CLICS_PERMIS[cle]} » est absent de la page : rien n'a été cliqué` };
  }
  if (!(await cliquer(page, cle))) {
    return { ok: false, raison: 'le bouton n\'a pas pu être cliqué (absent, masqué ou désactivé au moment du clic)' };
  }
  let apres = avant;
  for (let tour = 0; tour < 20; tour++) {
    await attendre(page, 500);
    apres = await lireLesOnglets(page);
    const actif = ongletActif(apres[vers]) && !ongletActif(apres[autre]);
    if (actif && apres.empreinte !== avant.empreinte) return { ok: true };
  }
  if (!ongletActif(apres[vers])) return { ok: false, raison: 'cliqué, mais il n\'est pas devenu l\'onglet actif' };
  if (ongletActif(apres[autre])) return { ok: false, raison: 'cliqué, mais l\'autre onglet est resté actif' };
  return { ok: false, raison: 'il est devenu l\'onglet actif, mais le contenu affiché n\'a pas changé' };
}

/** Un libellé pour le journal : chiffres masqués, longueur bornée. */
function pourLeJournal(texte) {
  return String(texte ?? '').replace(/\s+/g, ' ').trim().replace(/\d/g, '#').slice(0, 60);
}

/** « lien avec adresse (téléchargement direct) » — la nature d'un relevé. */
function natureRelevee(f) {
  const precisions = [
    f.avecAdresse ? 'avec adresse' : 'sans adresse',
    ...(f.telechargement ? ['marqué « télécharger »'] : []),
    ...(f.nouvelOnglet ? ['ouvre un nouvel onglet'] : []),
  ];
  return `${f.nature} ${precisions.join(', ')}`;
}

/**
 * Ce que le journal dit d'une commande lue : CE QUI a été lu, jamais la valeur
 * (aucun numéro, aucune date au journal). Pure, testée.
 */
function ligneCommande(c, i, total) {
  const forme = c.numero
    ? `numéro lu (${(c.numero.match(/[A-Za-z]/g) || []).length} lettre(s), ${(c.numero.match(/\d/g) || []).length} chiffre(s))`
    : 'numéro NON lu';
  const date = c.datetime ? 'date lue (attribut datetime)' : c.phraseDate ? 'date lue (texte)' : 'date NON lue';
  const etat = c.etat ? `état « ${pourLeJournal(c.etat)} »` : 'état NON lu';
  const vendeur = c.vendeur ? 'vendeur lu' : 'vendeur NON lu';
  return `${ID} : commande ${i + 1}/${total} — ${forme}, ${date}, ${etat}, ${vendeur}.`;
}

/**
 * Une navigation, puis l'attente que la page se pose — bornée : un site qui
 * ne se tait jamais (mesures d'audience) ferait attendre le délai entier du
 * socle, 45 s.
 */
const DELAI_REPOS_MS = 10_000;
async function naviguer(page, adresse) {
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/** « 1 commande en ligne », « aucun achat en magasin »… Pure. */
function compte(n, singulier, pluriel, aucun) {
  if (n === 0) return aucun;
  return `${n} ${n > 1 ? pluriel : singulier}`;
}

/**
 * Ce que l'écran dit d'un passage qui a lu la page (lot 93, R5). Pure,
 * testée. Depuis le lot 94, la phrase « Vos achats en magasin portent un
 * bouton « Voir mon ticket » : crabe ne sait pas encore l'ouvrir… » n'existe
 * plus : les tickets se disent par leurs propres phrases (`phraseTicketsPris`,
 * `phrasesTickets`, `phraseArretTickets`).
 *
 * @param {{enLigne: number, enMagasin: number|null, factures: number,
 *   libelles: string[], filtreVerifie: boolean, facturesMagasin?: number,
 *   nonDepliees?: number}} lu `enMagasin` vaut `null` quand l'onglet n'a pas
 *   pu être lu ; `factures` : les commandes en ligne où une facture semble
 *   proposée, `facturesMagasin` : les achats en magasin ; `nonDepliees` : les
 *   commandes dont le détail n'a pas pu être déplié
 */
function messageDuPassage({
  enLigne, enMagasin, factures, libelles, filtreVerifie, facturesMagasin = 0, nonDepliees = 0,
}) {
  const vus = `${compte(enLigne, 'commande en ligne', 'commandes en ligne', 'aucune commande en ligne')} et `
    + (enMagasin === null
      ? 'un onglet « En magasin » qui n\'a pas pu être lu'
      : compte(enMagasin, 'achat en magasin', 'achats en magasin', 'aucun achat en magasin'));
  const tete = `Votre espace client ${NOM} a bien été lu : ${vus}.`;
  const filtre = filtreVerifie ? ''
    : ' Le filtre « Toutes mes commandes » n\'a pas pu être vérifié : seules les commandes affichées ont été comptées.';
  const replies = nonDepliees > 0
    ? ` Le détail de ${nonDepliees} commande(s) n'a pas pu être déplié : une facture qui s'y trouverait `
      + 'n\'a pas pu être cherchée. Si cela se répète, signalez-le.'
    : '';
  if (!factures && !facturesMagasin) {
    return `${tete} Aucune facture n'y est encore proposée : quand une facture apparaîtra, crabe vous `
      + `le signalera ici.${replies}${filtre}`;
  }
  const noms = [...new Set(libelles)].slice(0, 3).map((l) => `« ${l} »`).join(', ');
  const ou = [
    ...(factures ? [`${factures} commande(s)`] : []),
    ...(facturesMagasin ? [`${facturesMagasin} achat(s) en magasin`] : []),
  ].join(' et ');
  return `${tete} Une facture semble proposée pour ${ou}${noms ? ` (${noms})` : ''} : `
    + 'crabe ne sait pas encore la récupérer et n\'y a pas touché. Signalez-le, avec le libellé du '
    + 'bouton, ce que fait son clic et une capture de la commande dépliée : c\'est ce qui '
    + `permettra d'écrire la suite.${replies}${filtre}`;
}

// ---------------------------------------------------------------------------
// Le ticket de caisse : son ancre, son nom, ce que l'écran en dit (lot 94)
// ---------------------------------------------------------------------------

/**
 * Un montant affiché, en centimes : « 12,34 € », « 1 234,56 € » (espaces
 * insécables compris), « -5,00 € », « 12 € », « Prix du produit: 0,00 € ».
 * `null` s'il ne se lit pas sans doute — un ticket sans ancre sûre n'est pas
 * demandé. Pure, testée.
 */
function montantEnCentimes(texte) {
  const brut = String(texte ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^prix du produit\s*:?\s*/i, '');
  const m = /^([-\u2212\u2013])?\s*(\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(?:€|eur(?:os?)?)?\s*(?:ttc)?$/i.exec(brut);
  if (!m) return null;
  const euros = Number(m[2].replace(/[ .]/g, ''));
  if (!Number.isSafeInteger(euros) || euros > 9_999_999) return null;
  const total = euros * 100 + (m[3] ? Number(m[3].padEnd(2, '0')) : 0);
  return m[1] ? -total : total;
}

/** 1234 centimes → « 12-34EUR » ; un avoir → « moins-12-34EUR ». Pure. */
function montantPourAncre(centimes) {
  const abs = Math.abs(centimes);
  return `${centimes < 0 ? 'moins-' : ''}${Math.floor(abs / 100)}-${String(abs % 100).padStart(2, '0')}EUR`;
}

/**
 * L'ancre d'un ticket : `bricomarche-ticket-<AAAA-MM-JJ>-<montant>[-<rang>]`.
 * Elle désigne un ACHAT EN MAGASIN, jamais une commande en ligne (dont
 * l'ancre, `bricomarche-commande-<n°>`, reste libre pour sa facture). Pure.
 */
function remoteIdTicket(issuedOn, centimes, rang = 1) {
  return `${ID}-ticket-${issuedOn}-${montantPourAncre(centimes)}${rang > 1 ? `-${rang}` : ''}`;
}

/** Le nom d'un ticket : `bricomarche_<AAAA-MM>_ticket-<…>.pdf` — il dit que c'est un ticket. */
function nomDuTicket(issuedOn, remoteId) {
  return pageDocs.nomFichier(ID, { issuedOn, remoteId });
}

/**
 * L'ancre du ticket de chaque achat, dans l'ORDRE DE LA PAGE (R8).
 *
 * Le rang départage les achats de même date et de même montant, compté du
 * plus ANCIEN au plus récent : la page montre les plus récents d'abord (code
 * source du 06/10 : groupés par mois, le plus récent en tête), un achat
 * nouveau s'ajoute donc en tête et ne décale aucun rang déjà donné. Si la
 * page montrait au contraire les plus anciens d'abord (première date plus
 * ancienne que la dernière), son ordre serait lu tel quel. Un achat sans date
 * ou sans montant lisible n'a pas d'ancre (`remoteId: null`). Pure, testée.
 *
 * @param {Array<{date?: string, montant?: string}>} achats
 * @returns {Array<{issuedOn: string|null, centimes: number|null, rang: number,
 *   remoteId: string|null}>}
 */
function ancresDesTickets(achats) {
  const lus = (achats || []).map((a) => ({
    issuedOn: pageDocs.dateDepuisTexte(a?.date),
    centimes: montantEnCentimes(a?.montant),
  }));
  const datees = lus.map((l) => l.issuedOn).filter(Boolean);
  const plusAnciensDAbord = datees.length > 1 && datees[0] < datees[datees.length - 1];
  const ordre = lus.map((_l, i) => i);
  if (!plusAnciensDAbord) ordre.reverse();
  const vus = new Map();
  const rangs = lus.map(() => 1);
  for (const i of ordre) {
    if (!lus[i].issuedOn || lus[i].centimes === null) continue;
    const cle = `${lus[i].issuedOn}|${lus[i].centimes}`;
    vus.set(cle, (vus.get(cle) || 0) + 1);
    rangs[i] = vus.get(cle);
  }
  return lus.map((l, i) => ({
    ...l,
    rang: rangs[i],
    remoteId: l.issuedOn && l.centimes !== null ? remoteIdTicket(l.issuedOn, l.centimes, rangs[i]) : null,
  }));
}

/**
 * La phrase des tickets PRIS, qui suit « N factures récupérées » du
 * planificateur (R10). `tiret` : elle s'y accroche ; sinon (le message du
 * planificateur a déjà fini sa phrase), elle se tient seule. Pure, testée.
 */
function phraseTicketsPris(pris, archives = 0, { tiret = true } = {}) {
  const tete = tiret
    ? `— ${pris > 1 ? `ce sont les tickets de caisse de ${pris} achats en magasin` : 'c\'est le ticket de caisse d\'un achat en magasin'}`
    : (pris > 1
      ? `Les ${pris} documents récupérés sont les tickets de caisse de ${pris} achats en magasin`
      : 'Le document récupéré est le ticket de caisse d\'un achat en magasin');
  const deja = archives > 0
    ? ` ; ${archives > 1 ? `ceux des ${archives} autres étaient` : 'celui de l\'autre était'} déjà dans vos documents`
    : '';
  return `${tete}${deja}.`;
}

/**
 * Les autres phrases des tickets, chacune autonome : déjà dans l'archive
 * (quand rien n'a été pris), hors période, sans repère, sans ancre sûre, en
 * attente faute de temps. Des nombres, jamais une date ni un montant. Pure.
 *
 * @param {{pris: number, archives: number, horsPeriode: number, sansRepere: number,
 *   nonIdentifies: number, restants: number, avecTicket: number}} t
 * @returns {string[]}
 */
function phrasesTickets(t) {
  const phrases = [];
  if (!t.pris && t.archives > 0) {
    const qui = t.archives === t.avecTicket
      ? (t.archives > 1 ? `de vos ${t.archives} achats en magasin sont` : 'de votre achat en magasin est')
      : (t.archives > 1 ? `de ${t.archives} de vos achats en magasin sont` : 'd\'un de vos achats en magasin est');
    phrases.push(`${t.archives > 1 ? 'Les tickets' : 'Le ticket'} de caisse ${qui} déjà dans vos documents.`);
  }
  if (t.restants > 0) {
    phrases.push(`La récupération a pris tout le temps permis : ${t.restants > 1
      ? `${t.restants} tickets attendent encore ; ils viendront`
      : '1 ticket attend encore ; il viendra'} au prochain passage. Rien de ce qui a été pris n'est perdu.`);
  }
  if (t.horsPeriode > 0) {
    phrases.push(t.horsPeriode > 1
      ? `Les tickets de ${t.horsPeriode} achats en magasin, antérieurs à la période choisie dans « Historique à récupérer », n'ont pas été demandés.`
      : 'Le ticket d\'un achat en magasin, antérieur à la période choisie dans « Historique à récupérer », n\'a pas été demandé.');
  }
  if (t.sansRepere > 0) {
    phrases.push(t.sansRepere > 1
      ? `Les boutons « Voir mon ticket » de ${t.sansRepere} achats en magasin n'ont plus leur repère habituel : crabe ne les a pas cliqués. Si cela se répète, signalez-le.`
      : 'Le bouton « Voir mon ticket » d\'un achat en magasin n\'a plus son repère habituel : crabe ne l\'a pas cliqué. Si cela se répète, signalez-le.');
  }
  if (t.nonIdentifies > 0) {
    phrases.push(t.nonIdentifies > 1
      ? `Les tickets de ${t.nonIdentifies} achats en magasin n'ont pas été demandés : leur date ou leur montant n'a pas pu être lu, et crabe ne saurait pas les reconnaître au passage suivant. Si cela se répète, signalez-le.`
      : 'Le ticket d\'un achat en magasin n\'a pas été demandé : sa date ou son montant n\'a pas pu être lu, et crabe ne saurait pas le reconnaître au passage suivant. Si cela se répète, signalez-le.');
  }
  return phrases;
}

/**
 * La phrase qui dit pourquoi les tickets se sont arrêtés (champ
 * `renoncement`, R7) et ce qui attend. Pure, testée.
 *
 * @param {{nature: 'fenetre'|'page'|'absent'|'onglet'|'liste'|'sans-pdf'}} arret
 * @param {number} nonExamines les tickets qui n'ont plus été demandés ensuite
 */
function phraseArretTickets(arret, nonExamines = 0) {
  const quoi = {
    fenetre: 'Après un clic sur « Voir mon ticket », Bricomarché a ouvert une fenêtre au lieu de remettre le '
      + 'ticket : crabe n\'y a rien rempli, n\'a plus rien cliqué et s\'est arrêté là. Signalez-le, avec ce que '
      + 'montre cette fenêtre : c\'est ce qui permettra d\'écrire la suite.',
    page: 'Après un clic sur « Voir mon ticket », Bricomarché a affiché une autre page au lieu de remettre le '
      + 'ticket : crabe n\'y a rien rempli, n\'a plus rien cliqué et s\'est arrêté là. Signalez-le.',
    absent: 'Au moment de demander un ticket, le bouton « Voir mon ticket » attendu n\'était plus sur sa carte : '
      + 'crabe n\'a rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le.',
    onglet: 'Au moment de demander un ticket, l\'onglet « En magasin » n\'était plus celui qui est affiché : '
      + 'crabe n\'a rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le.',
    liste: 'La liste de vos achats en magasin a changé pendant que crabe demandait les tickets : il n\'a plus '
      + 'rien cliqué et s\'est arrêté là.',
  }[arret?.nature] || ('Après un clic sur « Voir mon ticket », Bricomarché n\'a pas remis de PDF : crabe n\'a plus '
    + 'rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le.');
  const reste = nonExamines > 0
    ? ` ${nonExamines > 1 ? `Les ${nonExamines} autres tickets n'ont pas été demandés : ils le seront`
      : 'L\'autre ticket n\'a pas été demandé : il le sera'} au prochain passage.`
    : '';
  return `${quoi}${reste}`;
}

/**
 * Le nom que le site propose pour un ticket, réduit à sa FORME — jamais le nom
 * lui-même, qui pourrait porter une date ou un magasin : longueur, chiffres,
 * plus longue suite de chiffres, extension. Au premier passage réel, il dira
 * si un identifiant stable s'y trouve (R8). Pure, testée.
 */
function formeDuNom(nom) {
  const brut = String(nom || '').trim();
  if (!brut) return 'aucun nom proposé';
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(brut);
  const suites = brut.match(/\d+/g) || [];
  return `${brut.length} caractère(s), dont ${suites.join('').length} chiffre(s), plus longue suite de chiffres : `
    + `${Math.max(0, ...suites.map((x) => x.length))}${ext ? `, extension .${ext[1].toLowerCase()}` : ''}`;
}

/**
 * La fenêtre d'historique des tickets : le réglage de l'utilisateur, sauf
 * « Depuis la dernière récupération », qui prend tout ce qui n'est pas encore
 * dans l'archive — dans la limite de la conservation (R9, comme Gandi au lot
 * 93) : sinon, dès le premier ticket déposé, « depuis » se réduirait à
 * l'année en cours et les tickets laissés par un passage coupé ne viendraient
 * jamais. Lire la liste ne coûte rien ; seuls les tickets manquants se
 * demandent.
 */
function fenetre(config, ctx) {
  const plan = scraping.planHistorique(config, ctx);
  if (!plan || plan.mode !== 'depuis') return plan;
  const tout = history.fenetreDeDates({ valeur: 'tout', plafondMois: ctx?.conservationMois || 0 });
  return {
    ...tout,
    mode: 'depuis',
    raison: `tous les tickets pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Le reçu reconstitué et son ancre — EN RÉSERVE depuis le lot 92
// ---------------------------------------------------------------------------

/** L'ancre d'une commande — elle désigne la COMMANDE (lot 78). */
function remoteIdCommande(numero) {
  return `${ID}-commande-${String(numero).replace(/\s+/g, '')}`;
}

/**
 * Le reçu d'UNE commande sans facture, par le gabarit commun — nature « recu »,
 * donc avec le bandeau qui dit qu'il est reconstitué par crabe et n'est pas
 * une facture de Bricomarché. EN RÉSERVE depuis le lot 92 (voir l'en-tête) :
 * plus aucun passage ne l'appelle.
 */
function construireRecu({ numero, date, statut, lignes, genereLe }) {
  return releve.construire({
    nature: 'recu',
    service: NOM,
    compte: null,
    genereLe,
    colonnes: [{ cle: 'ligne', titre: 'Détail de la commande, tel qu\'affiché dans votre espace client' }],
    operations: lignes.map((ligne) => ({ ligne })),
    mentions: [
      `Commande n° ${numero} — date affichée par l'espace client : ${date}`,
      ...(statut ? [`Statut affiché au moment de la lecture : ${statut}`] : []),
      'Source : votre espace client Bricomarché (« Mes achats »).',
      'Cette commande ne proposait aucune facture à télécharger au moment de la lecture.',
    ],
  });
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la page des commandes répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — votre espace client ${NOM} est servi à votre compte. `
      + 'Vos achats en ligne et en magasin seront lus à la prochaine récupération.',
  }));
}

/**
 * L'onglet « En ligne » : lu, puis chaque commande dépliée par son chevron et
 * son volet relevé. Rend les commandes, les relevés et les dépliages manqués.
 */
async function lireLesCommandes(page, log) {
  const enLigne = await lirePanneau(page, LIRE_EN_LIGNE, 'commandes');
  log(`${ID} : onglet « ${ONGLET_EN_LIGNE} » — ${enLigne.commandes.length} commande(s)`
    + `${enLigne.vide ? ' (le panneau se dit vide)' : ''}.`);
  const total = enLigne.commandes.length;
  for (const [i, c] of enLigne.commandes.entries()) log(ligneCommande(c, i, total));

  const releves = [];
  let nonDepliees = 0;
  for (const [i, c] of enLigne.commandes.entries()) {
    const surCarte = c.factures;
    let surVolet = [];
    if (i >= DEPLIAGES_MAX) {
      nonDepliees++;
      if (i === DEPLIAGES_MAX) log(`${ID} : au-delà de ${DEPLIAGES_MAX} commandes, les détails ne sont plus dépliés ce passage-ci.`);
    } else if (!c.chevron) {
      nonDepliees++;
      log(`${ID} : commande ${i + 1}/${total} — pas de chevron sous son repère « ${CLICS_PERMIS.deplier} » : `
        + 'détail non déplié, rien n\'a été cliqué.');
    } else {
      if (!c.chevron.deplie) await cliquer(page, 'deplier', c.chevron.rang);
      let volet = { deplie: false, voletVu: false, factures: [] };
      for (let tour = 0; tour < 10; tour++) {
        await attendre(page, 500);
        volet = await page.evaluate(RELEVER_LE_VOLET, {
          controle: c.chevron.controle, rang: c.chevron.rang, reperes: REPERES, motifFacture: MOTIF_FACTURE.source,
        }).catch(() => volet);
        if (volet.voletVu) break;
      }
      if (!volet.voletVu) {
        nonDepliees++;
        log(`${ID} : commande ${i + 1}/${total} — ${volet.deplie ? 'chevron déplié, mais aucun détail ne s\'est affiché'
          : 'le chevron ne s\'est pas déplié'} : détail non lu.`);
      } else {
        surVolet = volet.factures;
        if (!surVolet.length && !surCarte.length) {
          log(`${ID} : commande ${i + 1}/${total} — détail déplié : rien n'y évoque une facture.`);
        }
      }
    }
    const vus = [...surCarte, ...surVolet];
    if (vus.length) {
      releves.push(vus);
      for (const f of vus) {
        log(`${ID} : commande ${i + 1}/${total} — un élément évoque une facture : `
          + `« ${pourLeJournal(f.libelle)} », ${natureRelevee(f)}. Non cliqué : crabe ne sait pas encore `
          + 'ce que fait ce bouton.');
      }
    }
  }
  return { enLigne, releves, nonDepliees };
}

/** L'onglet « En magasin » : lu, sans rien y cliquer — les tickets se demandent après, en dernier (`prendreLesTickets`). */
async function lireLesAchats(page, log) {
  const lu = await lirePanneau(page, LIRE_EN_MAGASIN, 'achats');
  if (lu.commandesEnLigne > 0) {
    log(`${ID} : onglet « ${ONGLET_EN_MAGASIN} » — le panneau montre encore des commandes en ligne : non compté.`);
    return null;
  }
  if (!lu.achats.length && !lu.vide) {
    log(`${ID} : onglet « ${ONGLET_EN_MAGASIN} » affiché, mais ni achat ni panneau vide reconnus — non compté.`);
    return null;
  }
  const tickets = lu.achats.filter((a) => a.ticket).length;
  const dates = lu.achats.filter((a) => a.date).length;
  const montants = lu.achats.filter((a) => a.montantLu).length;
  log(`${ID} : onglet « ${ONGLET_EN_MAGASIN} » — ${lu.achats.length} achat(s)`
    + `${lu.vide ? ' (le panneau se dit vide)' : ''}`
    + `${lu.achats.length ? ` : ${dates} date(s) et ${montants} montant(s) lus, ${tickets} bouton(s) « Voir mon ticket »` : ''}.`);
  return lu;
}

// ---------------------------------------------------------------------------
// Les tickets : un clic à la fois, et tout le reste arrête (lot 94)
// ---------------------------------------------------------------------------

/**
 * Ce qui, APRÈS un clic, n'est pas un document : une boîte ou un formulaire
 * de plus qu'avant. Compté, jamais touché (la même règle que Decathlon).
 */
const COMPTER_BOITES = () => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const boites = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .filter(visible).length;
  const formulaires = [...document.querySelectorAll('form')]
    .filter((f) => visible(f) && f.querySelector('input:not([type="hidden"]), textarea, select')).length;
  return boites + formulaires;
};

/** Le panneau « En magasin » tel qu'il est affiché, lu une fois, sans attendre. */
function lireMagasinMaintenant(page) {
  return page.evaluate(LIRE_EN_MAGASIN, {
    reperes: REPERES, motifFacture: MOTIF_FACTURE.source, motifVide: MOTIF_VIDE.source,
  }).catch(() => ({ achats: [], vide: false, commandesEnLigne: 0 }));
}

/** L'adresse sans sa requête ni son fragment : une autre PAGE, pas un paramètre. */
function cheminDe(adresse) {
  try {
    const u = new URL(adresse);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(adresse || '');
  }
}

/**
 * Demande UN ticket : le clic (par `cliquer`, la seule voie, avec la carte de
 * l'achat), puis le document qu'il rend, quelle que soit la voie
 * (`clic-document` guette le téléchargement, l'onglet, la réponse PDF). Une
 * boîte native du navigateur est REFUSÉE, jamais acceptée ; une boîte ou un
 * formulaire de la page, ou une autre page, mettent fin à l'attente sans être
 * touchés. Le nom proposé par le site est noté pour sa seule FORME.
 *
 * @returns {Promise<{ok: true, buffer: Buffer, voie: string, nomPropose: string}
 *   | {ok: false, nature: string, grief: string}>}
 */
async function demanderUnTicket(page, context, { rang, carte }) {
  let boiteNative = false;
  let nomPropose = '';
  const surBoite = (boite) => {
    boiteNative = true;
    boite.dismiss().catch(() => {});
  };
  const surTelechargement = (d) => {
    try { if (!nomPropose) nomPropose = d.suggestedFilename() || ''; } catch { /* téléchargement parti */ }
  };
  const surReponse = async (reponse) => {
    try {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec((await reponse.headerValue('content-disposition')) || '');
      if (m && !nomPropose) nomPropose = m[1];
    } catch { /* réponse close */ }
  };
  page.on?.('dialog', surBoite);
  page.on?.('download', surTelechargement);
  page.on?.('response', surReponse);
  const avant = cheminDe(page.url());
  try {
    const boites = await page.evaluate(COMPTER_BOITES).catch(() => 0);
    const obtenu = await clicDocument.documentDuClic(page, context, () => cliquer(page, 'ticket', rang, carte), {
      autreIssue: async () => boiteNative
        || cheminDe(page.url()) !== avant
        || (await page.evaluate(COMPTER_BOITES).catch(() => boites)) > boites,
    });
    if (obtenu.ok && !identity.estPdf(obtenu.buffer)) {
      return { ok: false, nature: 'sans-pdf', grief: 'le document reçu ne commence pas comme un PDF' };
    }
    if (obtenu.ok) return { ...obtenu, nomPropose };
    if (boiteNative) {
      return { ok: false, nature: 'fenetre', grief: 'une boîte de confirmation du navigateur s\'est ouverte — refusée' };
    }
    const nature = obtenu.autreIssue ? (cheminDe(page.url()) !== avant ? 'page' : 'fenetre')
      : /n'était plus dans la page/.test(obtenu.grief) ? 'absent'
        : 'sans-pdf';
    const grief = {
      page: 'une autre page s\'est affichée à la place du ticket',
      fenetre: 'une fenêtre ou un formulaire s\'est ouvert à la place du ticket, sans être touché',
      absent: 'le bouton attendu n\'était plus sur sa carte au moment du clic',
    }[nature] || obtenu.grief;
    return { ok: false, nature, grief };
  } finally {
    try { page.off?.('dialog', surBoite); } catch { /* page partie */ }
    try { page.off?.('download', surTelechargement); } catch { /* page partie */ }
    try { page.off?.('response', surReponse); } catch { /* page partie */ }
  }
}

/** Un bilan de tickets vide : rien de vu, rien de pris. */
function bilanTickets() {
  return {
    avecTicket: 0, pris: 0, archives: 0, horsPeriode: 0, sansRepere: 0, nonIdentifies: 0,
    restants: 0, arretes: 0, nonExamines: 0, arret: null,
  };
}

/**
 * Les tickets à demander dans une lecture du panneau : les achats qui portent
 * un ticket, avec une ancre sûre, absente de l'archive, dans la fenêtre, et
 * dont le bouton porte son repère exact. Pure, testée.
 */
function ticketsADemander(achats, { connus = new Set(), plan = null } = {}) {
  const ancres = ancresDesTickets(achats);
  return achats.map((a, i) => ({ a, i, ancre: ancres[i] }))
    .filter(({ a, ancre }) => a.ticket && a.ticket.parRepere && a.ticket.rang >= 0 && ancre.remoteId
      && !connus.has(ancre.remoteId) && scraping.dansLaFenetre(ancre.issuedOn, plan));
}

/**
 * Les tickets des achats en magasin, un à un, dans l'ordre de la page (R6 à
 * R9). Rend les tickets pris et le bilan ; ne lève jamais pour un ticket :
 * ce qui est pris est toujours rendu. Au premier clic sans PDF — ou au premier
 * contrôle qui ne tient plus —, plus aucun ticket n'est demandé, et la page
 * n'est plus touchée.
 */
async function prendreLesTickets(page, context, { log, connus, plan, echeance }) {
  const bilan = bilanTickets();
  const tickets = [];
  const lu = await lireMagasinMaintenant(page);
  const ancres = ancresDesTickets(lu.achats);
  const total = lu.achats.length;

  for (const [i, achat] of lu.achats.entries()) {
    if (!achat.ticket) continue;
    bilan.avecTicket++;
    const qui = `achat en magasin ${i + 1}/${total}`;
    const { remoteId, issuedOn } = ancres[i];
    if (!remoteId) {
      bilan.nonIdentifies++;
      log(`${ID} : ${qui} — sa date ou son montant ne se lit pas : son ticket n'est pas demandé (aucune ancre sûre).`);
      continue;
    }
    if (connus.has(remoteId)) { bilan.archives++; continue; }
    if (!scraping.dansLaFenetre(issuedOn, plan)) { bilan.horsPeriode++; continue; }
    if (!achat.ticket.parRepere || achat.ticket.rang < 0) {
      bilan.sansRepere++;
      log(`${ID} : ${qui} — « Voir mon ticket » trouvé par son texte, sans son repère « ${CLICS_PERMIS.ticket} » : non cliqué.`);
      continue;
    }
    if (bilan.arret) { bilan.nonExamines++; continue; }
    if (horloge.maintenant() > echeance) { bilan.restants++; continue; }

    // L'onglet « En magasin » doit être celui qui est affiché (R6).
    const onglets = await lireLesOnglets(page);
    if (!(ongletActif(onglets.magasin) && !ongletActif(onglets.web))) {
      bilan.arret = { nature: 'onglet' };
      bilan.arretes++;
      log(`${ID} : ${qui} — l'onglet « ${ONGLET_EN_MAGASIN} » n'est plus l'onglet affiché : aucun ticket de plus n'est demandé.`);
      continue;
    }
    // La carte relue juste avant le clic : c'est elle qui sera recontrôlée.
    const frais = await lireMagasinMaintenant(page);
    const meme = frais.achats[i];
    if (frais.achats.length !== total || !meme || meme.texteCarte !== achat.texteCarte || meme.ticket?.rang !== achat.ticket.rang) {
      bilan.arret = { nature: 'liste' };
      bilan.arretes++;
      log(`${ID} : ${qui} — la liste des achats a changé depuis sa lecture : aucun ticket de plus n'est demandé.`);
      continue;
    }

    const obtenu = await demanderUnTicket(page, context, { rang: achat.ticket.rang, carte: achat.texteCarte });
    if (!obtenu.ok) {
      bilan.arret = obtenu;
      bilan.arretes++;
      log(`${ID} : ${qui} — « Voir mon ticket » demandé, pas de PDF (${obtenu.grief}). `
        + 'Plus aucun ticket ne sera demandé pendant ce passage ; rien n\'a été rempli.');
      continue;
    }
    connus.add(remoteId);
    tickets.push({ remoteId, issuedOn, filename: nomDuTicket(issuedOn, remoteId), buffer: obtenu.buffer });
    bilan.pris++;
    log(`${ID} : ${qui} — ticket de caisse récupéré (voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets ; `
      + `nom proposé par le site : ${formeDuNom(obtenu.nomPropose)}).`);
  }

  log(`${ID} : tickets — ${bilan.avecTicket} achat(s) avec « Voir mon ticket » : ${bilan.pris} pris, `
    + `${bilan.archives} déjà dans l'archive, ${bilan.horsPeriode} hors période, ${bilan.sansRepere} sans repère, `
    + `${bilan.nonIdentifies} sans ancre sûre, ${bilan.restants} en attente (temps), `
    + `${bilan.arretes + bilan.nonExamines} non demandé(s) après un arrêt.`);
  return { tickets, bilan };
}

/**
 * Lit « Mes achats » : l'onglet actif, puis l'autre par SON clic ; déplie
 * chaque commande en ligne pour relever ce qui évoque une facture — sans
 * jamais le toucher —, puis, EN DERNIER, demande le ticket de caisse de
 * chaque achat en magasin qui n'est pas encore dans l'archive (lot 94).
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  // Le temps des tickets se compte dès le départ du passage (R9).
  const echeance = horloge.maintenant() + budgetMs();

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // 1. La liste, avec « Toutes mes commandes ». L'adresse atteinte depuis
    //    le 05/10/2026 porte `choiceOrder=0` sans `historyOrderFilter` : la
    //    requête complète se pose par navigation.
    const arrivee = page.url();
    const cible = adresseHistorique(new URL(arrivee).pathname.startsWith(CHEMIN_HISTORIQUE) ? arrivee : null, arrivee);
    if (cible !== arrivee) await naviguer(page, cible);
    if (estPageAuthentification(page.url())) {
      throw profilMarchand.erreurRenvoiVersAuthentification(
        NOM, `redirection vers ${page.url()} en rejoignant « Mes achats »`);
    }

    // 2. La page se reconnaît à ce qu'elle EST — repères d'abord.
    const signes = await page.evaluate(RELEVER_LES_SIGNES, {
      reperes: REPERES, ongletLigne: ONGLET_EN_LIGNE, ongletMagasin: ONGLET_EN_MAGASIN,
    }).catch(() => ({}));
    const jugement = reconnaitre(signes);
    log(`${ID} : « Mes achats » — signes présents : ${jugement.presents.join(', ') || 'aucun'}`
      + `${jugement.absents.length ? ` ; absents : ${jugement.absents.join(', ')}` : ''} (adresse ${page.url()}).`);
    if (signes.parTexte?.length) {
      log(`${ID} : reconnus par leur texte seulement, leur repère manque : ${signes.parTexte.join(', ')}.`);
    }
    if (!jugement.reconnue) {
      throw erreurPageIllisible(`${jugement.presents.length} signe(s) sur 6 reconnu(s) — il en faut ${SIGNES_REQUIS}`);
    }

    // 3. L'onglet actif à l'arrivée, lu en premier ; l'autre par son clic.
    const onglets = await lireLesOnglets(page);
    const arriveeSurMagasin = ongletActif(onglets.magasin) && !ongletActif(onglets.web);
    log(`${ID} : onglet actif à l'arrivée : « ${arriveeSurMagasin ? ONGLET_EN_MAGASIN : ONGLET_EN_LIGNE} ».`);

    let commandes = null;
    let magasin = null;
    const adresseListe = page.url();

    const lireMagasinParSonClic = async () => {
      const passage = await passerALOnglet(page, 'magasin');
      if (!passage.ok) {
        log(`${ID} : onglet « ${ONGLET_EN_MAGASIN} » — ${passage.raison} : les achats en magasin ne sont pas lus (jamais comptés « 0 »).`);
        return null;
      }
      log(`${ID} : onglet « ${ONGLET_EN_MAGASIN} » — cliqué par son repère, devenu l'actif, contenu changé.`);
      return lireLesAchats(page, log);
    };

    if (arriveeSurMagasin) {
      magasin = await lireLesAchats(page, log);
      const passage = await passerALOnglet(page, 'web');
      if (!passage.ok) {
        throw erreurPageIllisible(`onglet « En ligne » non affiché : ${passage.raison}`);
      }
      log(`${ID} : onglet « ${ONGLET_EN_LIGNE} » — cliqué par son repère, devenu l'actif, contenu changé.`);
      commandes = await lireLesCommandes(page, log);
    } else {
      commandes = await lireLesCommandes(page, log);
    }

    // Un panneau sans commande ET sans phrase de vide n'est pas « 0 » : il
    // n'a pas été lu (le faux « rien à récupérer » que crabe s'interdit).
    if (!commandes.enLigne.commandes.length && !commandes.enLigne.vide) {
      throw erreurPageIllisible('onglet « En ligne » : ni commande ni panneau vide reconnus');
    }
    if (!arriveeSurMagasin) {
      magasin = await lireMagasinParSonClic();
    } else if (magasin && ticketsADemander(magasin.achats, { connus, plan }).length) {
      // Les tickets se demandent EN DERNIER, l'onglet « En magasin » affiché
      // (R6) : on y revient par son clic, s'il y a un ticket à demander.
      const retour = await passerALOnglet(page, 'magasin');
      log(retour.ok
        ? `${ID} : onglet « ${ONGLET_EN_MAGASIN} » — rouvert par son repère pour les tickets.`
        : `${ID} : onglet « ${ONGLET_EN_MAGASIN} » — ${retour.raison} : il n'a pas pu être rouvert pour les tickets.`);
    }

    // La preuve exigée par le socle (lot 31) — la liste est LUE, fût-elle vide.
    const nbEnLigne = commandes.enLigne.commandes.length;
    const nbMagasin = magasin ? magasin.achats.length : null;
    ctx.preuveDeListe?.({
      session: `espace client servi au compte connecté (${etat.raison})`,
      liste: adresseListe,
      elements: nbEnLigne + (nbMagasin || 0),
    });

    const relevesMagasin = magasin ? magasin.achats.filter((a) => a.factures.length).map((a) => a.factures) : [];
    for (const [i, vus] of relevesMagasin.entries()) {
      for (const f of vus) {
        log(`${ID} : achat en magasin ${i + 1} — un élément évoque une facture : `
          + `« ${pourLeJournal(f.libelle)} », ${natureRelevee(f)}. Non cliqué.`);
      }
    }
    const releves = [...commandes.releves, ...relevesMagasin];
    const lu = {
      enLigne: nbEnLigne,
      enMagasin: nbMagasin,
      factures: commandes.releves.length,
      facturesMagasin: relevesMagasin.length,
      libelles: releves.flat().map((f) => pourLeJournal(f.libelle)),
      filtreVerifie: !!signes.filtreChoisi,
      nonDepliees: commandes.nonDepliees,
    };

    // 4. Les tickets de caisse — en dernier, un à la fois (lot 94).
    let tickets = [];
    let t = bilanTickets();
    if (magasin && magasin.achats.some((a) => a.ticket)) {
      if (plan) log(`${ID} : tickets — historique « ${plan.mode} » — ${plan.raison}.`);
      ({ tickets, bilan: t } = await prendreLesTickets(page, context, { log, connus, plan, echeance }));
    }

    log(`${ID} : bilan — ${lu.enLigne} commande(s) en ligne, `
      + `${lu.enMagasin === null ? 'onglet « En magasin » non lu' : `${lu.enMagasin} achat(s) en magasin`}, `
      + `${lu.factures + lu.facturesMagasin} élément(s) où une facture semble proposée, ${lu.nonDepliees} détail(s) non déplié(s) ; `
      + `${t.pris ? `${t.pris} ticket(s) de caisse pris` : 'aucun document déposé'}.`);

    // Ce que l'écran dit (R10). « N factures récupérées » vient du
    // planificateur : la phrase des tickets le suit et dit ce que sont ces
    // documents. Après un arrêt, le message du planificateur finit sa phrase
    // (« … les réessaiera. », un échec complet) : plus de tiret.
    const manquees = t.arret ? t.arretes + t.nonExamines : 0;
    const resume = messageDuPassage(lu);
    const autres = phrasesTickets(t);
    const sortie = {
      accountId: null,
      invoices: tickets,
      couverture: {
        detail: 'les onglets « En ligne » et « En magasin » de « Mes achats », filtre « Toutes mes commandes », '
          + 'et le ticket de caisse de chaque achat en magasin',
      },
    };
    if (t.pris > 0) {
      sortie.precision = [phraseTicketsPris(t.pris, t.archives, { tiret: !manquees }), ...autres, resume].join(' ');
    } else if (manquees) {
      sortie.precision = [...autres, resume].join(' ');
    } else {
      sortie.aucunDocument = [resume, ...autres].join(' ');
    }
    if (manquees) {
      // Le ticket qui a bloqué, et ceux qui n'ont plus été demandés ensuite :
      // tous « non obtenus » ce passage-ci, tous redemandés au suivant.
      sortie.manquees = manquees;
      sortie.renoncement = phraseArretTickets(t.arret, t.nonExamines);
    }
    return sortie;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  erreurPageIllisible,
  reconnaitre,
  ongletActif,
  messageDuPassage,
  natureRelevee,
  ligneCommande,
  remoteIdCommande,
  construireRecu,
  cliquer,
  montantEnCentimes,
  remoteIdTicket,
  nomDuTicket,
  ancresDesTickets,
  ticketsADemander,
  phraseTicketsPris,
  phrasesTickets,
  phraseArretTickets,
  formeDuNom,
  fenetre,
  budgetMs,
  horloge,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  COMPTER_BOITES,
  URL_COMMANDES,
  CHEMIN_LISTE,
  CHEMIN_HISTORIQUE,
  PARAMETRES_HISTORIQUE,
  adresseHistorique,
  ONGLET_EN_LIGNE,
  ONGLET_EN_MAGASIN,
  REPERES,
  CLICS_PERMIS,
  MOTIF_FACTURE,
  MOTIF_VIDE,
  SIGNES_REQUIS,
  RELEVER_LES_SIGNES,
  LIRE_LES_ONGLETS,
  LIRE_EN_LIGNE,
  LIRE_EN_MAGASIN,
  RELEVER_LE_VOLET,
  CLIQUER_PAR_REPERE,
};
