'use strict';

/**
 * Connecteur PrestaShop — un seul code, sept boutiques (et toutes les autres).
 *
 * ⚠ Ce dossier **n'a pas de manifeste**, et ce n'est pas un oubli : c'est une
 * IMPLÉMENTATION PARTAGÉE (voir `SHARED_IMPLEMENTATIONS` dans
 * connectors/registry.js). Chaque boutique a son propre dossier avec son seul
 * manifeste, qui déclare `"implementation": "prestashop"` et ses adresses. Le
 * registre les rapproche au chargement.
 *
 * À ne pas confondre avec `planned/prestashop/`, qui annonce le service
 * « PrestaShop » — l'abonnement à la plateforme — et n'a rien à voir avec les
 * boutiques qui tournent dessus.
 *
 * ─── Ce qui a été vérifié ────────────────────────────────────────────────────
 *
 * Parcours validé les 10 et 11/08/2026 contre **sept boutiques réelles**, avec
 * des PDF téléchargés et ouverts :
 *
 *   Fantazia · Aagaard · Coco Papaya · L'Île aux Épices · Kubii · Propolia ·
 *   Apiculture.net
 *
 * Plus une entrée générique, « Boutique PrestaShop », où l'utilisateur saisit
 * lui-même l'adresse de sa boutique — sans qu'on ait à écrire du code pour
 * chacune.
 *
 * **Le Petit Vapoteur est volontairement écarté** : une protection Cloudflare
 * ferme la connexion avant même la saisie. Il reste annoncé dans `planned/`,
 * avec sa réserve, plutôt que promis puis cassé.
 *
 * ─── Connexion : un mot de passe, et c'est tout ──────────────────────────────
 *
 * Pas de navigateur distant, pas de code SMS : une adresse électronique et un
 * mot de passe. Les sessions observées durent **400 jours**, sans case à cocher
 * — PrestaShop maintient une session longue par défaut.
 *
 * Un bandeau de cookies s'interpose souvent avant le formulaire. C'est ce qui
 * faisait échouer Propolia — le bandeau Didomi recouvrait le bouton, le clic
 * n'atteignait jamais sa cible, et crabe annonçait un mot de passe refusé. La
 * fermeture est désormais confiée au module partagé
 * `connectors/cookie-banner.js`, qui reconnaît sept régies, cherche dans les
 * cadres, et VÉRIFIE qu'il ne reste plus rien devant le formulaire.
 *
 * ─── Les deux schémas de facture ─────────────────────────────────────────────
 *
 * Sur la page des commandes, les liens sont cherchés dans cet ORDRE :
 *
 *   1. schéma standard — six boutiques sur sept :
 *        index.php?controller=pdf-invoice&id_order=<numéro>
 *   2. schéma module — Apiculture.net :
 *        modules/eggsodoo/pdf-invoice.php?id_order=<numéro>
 *   3. à défaut, tout lien dont l'URL contient « pdf », « invoice » ou
 *      « facture », relevé ET JOURNALISÉ — pour qu'une boutique au schéma
 *      inconnu soit diagnosticable sans avoir à s'y connecter soi-même.
 *
 * **Le tri se fait sur l'URL, jamais sur le texte du lien.** La page porte des
 * liens sans rapport — widgets d'avis clients, articles de blog, « télécharger
 * la notice » — dont le libellé peut parfaitement dire « Facture ». Un lien
 * n'est retenu que si son ADRESSE correspond à un schéma de facture.
 *
 * ─── Numéro, date et montant ─────────────────────────────────────────────────
 *
 * La structure varie d'une boutique à l'autre : Kubii met tout dans une ligne
 * `.order` (« 520390768  11/07/2026  25,50 €  Commande livrée et payée »),
 * Fantazia demande de remonter dans le DOM. On remonte donc jusqu'à **six
 * ancêtres** autour du lien, en s'arrêtant dès qu'un ancêtre engloberait
 * plusieurs commandes — sans quoi on rangerait la facture de juillet à la date
 * de celle de juin.
 *
 * Si la date reste indéterminable, le document part dans `inconnu/` plutôt que
 * de faire échouer la récupération.
 *
 * ─── Le contenu fait foi, pas l'en-tête ──────────────────────────────────────
 *
 * Apiculture.net sert ses PDF en `application/octet-stream`. On vérifie donc
 * toujours que le contenu commence par `%PDF-`, et jamais le type déclaré
 * (voir connectors/browser-identity.js).
 *
 * ─── Ce qui n'est JAMAIS fait ────────────────────────────────────────────────
 *
 * **Aucune nouvelle tentative de connexion.** Si le formulaire est refusé, le
 * connecteur s'arrête, passe en erreur et le dit. Insister sur un formulaire de
 * connexion renforce les soupçons des protections anti-robot et peut rendre la
 * boutique inaccessible même à la main.
 */

const identity = require('../../browser-identity');
const cookieBanner = require('../../obstructions');
const history = require('../../history');
const preuve = require('../../preuve-connexion');
const echecs = require('../../messages-echec');
const diagnostics = require('../../../diagnostics');

const VIEWPORT = { width: 1500, height: 950 };
const NAV_TIMEOUT_MS = 45_000;

/**
 * Patience accordée au clic sur « Se connecter ».
 *
 * Volontairement bien plus courte que la navigation : quand un bandeau recouvre
 * le bouton, Playwright réessaie jusqu'à expiration puis abandonne. Avec le
 * délai de navigation, Propolia échouait au bout de quarante-cinq secondes —
 * sur un défaut détectable en trois.
 *
 * Le PREMIER essai est court : son échec est presque toujours un recouvrement,
 * et on veut le savoir vite pour fermer le bandeau. Le SECOND est long, parce
 * que là, c'est une vraie attente qu'on accorde à une boutique lente.
 */
const DELAI_CLIC_MS = 5000;
const DELAI_CLIC_LONG_MS = 20_000;

/** Pause entre deux téléchargements : la boutique est petite, on ne la bouscule pas. */
const PAUSE_DOCUMENT_MS = 350;

const CHAMP_EMAIL = 'email';
const CHAMP_MOT_DE_PASSE = 'motDePasse';
const CHAMP_SITE = 'site';
const CHAMP_HISTORIQUE = 'historique';

/** Compte sans adresse lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/** Là où vont les documents dont on n'a pas su lire la date. */
const ANNEE_INCONNUE = 'inconnu';

// ---------------------------------------------------------------------------
// Les deux schémas de facture — fonctions pures, testables sans navigateur
// ---------------------------------------------------------------------------

/**
 * Schéma standard : `index.php?controller=pdf-invoice&id_order=42`.
 *
 * Le contrôleur peut s'écrire `pdf-invoice` ou `pdf-order-return` selon les
 * versions ; seul le premier nous intéresse. L'ordre des paramètres n'est pas
 * garanti, d'où deux motifs plutôt qu'une expression rigide.
 */
const MOTIF_STANDARD = /controller=pdf-invoice/i;

/**
 * Schéma réécrit : `/pdf-invoice/42`, `/pdf-invoice?id_order=42`.
 *
 * Une boutique dont les jolies adresses sont actives ne sert PAS
 * `index.php?controller=…` : le contrôleur passe dans le chemin. Le lot 13 ne
 * cherchait que la forme avec `controller=`, et une boutique réécrite tombait
 * donc dans le filet de diagnostic — quand elle y tombait.
 */
const MOTIF_REECRIT = /\/pdf[-_]invoice\b/i;

/** Schéma module — Apiculture.net : `modules/eggsodoo/pdf-invoice.php?id_order=42`. */
const MOTIF_MODULE = /\/modules\/[^/]+\/pdf[-_]invoice\.php/i;

/**
 * Les documents qu'il ne faut SURTOUT pas prendre pour des factures.
 *
 * `pdf-order-return` est un bon de retour, `pdf-delivery-slip` un bon de
 * livraison. Les deux contiennent « pdf » et sortent du même contrôleur ; les
 * ramasser remplirait le dossier de documents qui ne sont pas des factures, et
 * `%PDF-` ne les distinguerait pas — ce sont de vrais PDF.
 */
const MOTIF_EXCLU = /controller=pdf-(order-return|delivery-slip)|\/pdf[-_](order[-_]return|delivery[-_]slip)/i;

/**
 * Le dernier recours : l'URL **ou** l'attribut `download` évoque une facture.
 *
 * Volontairement large — c'est le filet, pas le tamis — mais jamais appliqué au
 * TEXTE du lien : une page de boutique porte des widgets d'avis clients et des
 * articles de blog dont le libellé peut parfaitement dire « Facture ».
 */
const MOTIF_DIAGNOSTIC = /invoice|facture|\.pdf(\?|$|#)/i;

/** Le numéro de commande porté par un lien de facture. */
const MOTIF_ID_COMMANDE = /[?&]id_order=(\d+)/i;

/**
 * À quel schéma ce lien répond-il ?
 *
 * L'ordre est celui du lot 14, §3.2b : standard, réécrit, module, puis rien.
 * Les exclusions passent AVANT tout le reste — un bon de retour ne doit pas
 * pouvoir être reconnu comme facture par un motif plus loin dans la liste.
 *
 * @param {string} href
 * @returns {'standard'|'reecrit'|'module'|null}
 */
function schemaDuLien(href) {
  const url = String(href || '');
  if (MOTIF_EXCLU.test(url)) return null;
  if (MOTIF_STANDARD.test(url)) return 'standard';
  if (MOTIF_MODULE.test(url)) return 'module';
  if (MOTIF_REECRIT.test(url)) return 'reecrit';
  return null;
}

/**
 * Ce lien est-il un lien de facture connu ?
 *
 * **Sur l'URL, jamais sur le texte.** Une page de boutique porte des liens
 * d'avis clients, d'articles de blog et de notices dont le libellé peut dire
 * « Facture » sans en être une.
 */
function estLienFacture(href) {
  return schemaDuLien(href) !== null;
}

/**
 * Un lien qui MÉRITE d'être signalé quand aucun schéma connu n'a répondu.
 *
 * @param {string} href
 * @param {string} [download] l'attribut `download` du lien, quand il en a un :
 *   certaines boutiques servent la facture depuis une adresse opaque et ne
 *   trahissent sa nature que là (`download="facture-2026-03.pdf"`).
 */
function estLienSuspect(href, download = '') {
  const url = String(href || '');
  if (!url) return false;
  if (MOTIF_EXCLU.test(url)) return false;
  // Le chemin et la requête, pas le domaine : « apiculture.net » contient
  // « culture », pas de quoi confondre, mais « facturation.example.com » oui.
  return MOTIF_DIAGNOSTIC.test(sansDomaine(url)) || MOTIF_DIAGNOSTIC.test(String(download || ''));
}

/** Le chemin et la requête d'une URL — le domaine n'a rien à nous dire. */
function sansDomaine(brut) {
  try {
    const url = new URL(String(brut), 'https://exemple.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return String(brut);
  }
}

/**
 * Le numéro de commande d'un lien de facture.
 *
 * `id_order` est le numéro INTERNE de la boutique, stable et présent dans les
 * deux schémas. C'est lui qui sert de référence — contrairement aux
 * identifiants volatils d'Amazon, il ne change pas d'une visite à l'autre.
 */
function numeroDepuisLien(href) {
  const trouve = MOTIF_ID_COMMANDE.exec(String(href || ''));
  return trouve ? trouve[1] : null;
}

// ---------------------------------------------------------------------------
// Numéro, date, montant — lus autour du lien
// ---------------------------------------------------------------------------

/** Une date au format français : 11/07/2026. */
const MOTIF_DATE = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/;

/**
 * Un montant suivi de son euro : « 25,50 € », « 1 249,00 EUR ».
 *
 * Les milliers se séparent par groupes de TROIS chiffres, et pas par n'importe
 * quelle suite d'espaces : sans cette contrainte, la ligne de Kubii
 * « 520390768 11/07/2026 25,50 € » se lisait « 2026 25,50 € », c'est-à-dire
 * deux mille vingt-six euros au lieu de vingt-cinq.
 */
const MOTIF_MONTANT = /(\d{1,3}(?:[   ]\d{3})*|\d+)([.,]\d{2})\s*(?:€|EUR\b)/i;

/**
 * Une référence de commande PrestaShop.
 *
 * ⚠ **Alphanumérique**, pas seulement des lettres. Sur Fantazia, les références
 * réelles sont `DHMAY47C2` et `E1AFFHEN9` : neuf caractères mêlant lettres et
 * chiffres. Le motif du lot 12 n'acceptait que `[A-Z]{9}`, et ne les
 * reconnaissait donc pas — les factures partaient nommées d'après l'`id_order`
 * numérique de l'URL, qui n'apparaît nulle part sur la facture ni dans les
 * courriels de la boutique.
 *
 * Au moins une lettre est exigée pour ne pas confondre une référence avec une
 * date, un montant ou le numéro long de Kubii — que la seconde alternative
 * couvre séparément (« 520390768 »).
 */
const MOTIF_REFERENCE = /\b((?=[A-Z0-9]{9}\b)[A-Z0-9]*[A-Z][A-Z0-9]*)\b|\b(\d{8,12})\b/;

/**
 * Ce qu'on arrive à lire autour d'un lien de facture.
 *
 * @param {string} texte le texte de l'ancêtre le plus large ne contenant
 *   qu'une seule commande
 * @returns {{issuedOn: string|null, amount: string|null, reference: string|null}}
 */
function infosDepuisTexte(texte) {
  const propre = String(texte || '').replace(/\s+/g, ' ').trim();

  const date = MOTIF_DATE.exec(propre);
  const montant = MOTIF_MONTANT.exec(propre);
  const reference = MOTIF_REFERENCE.exec(propre);

  return {
    issuedOn: date
      ? `${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`
      : null,
    amount: montant
      ? `${montant[1].replace(/[   ]/g, '')}${montant[2]} EUR`
      : null,
    reference: reference ? reference[1] || reference[2] : null,
  };
}

/**
 * La référence stable d'une commande : son numéro.
 *
 * Le lot 9 a appris ça à ses dépens sur Amazon : un identifiant régénéré à
 * chaque visite fait retélécharger tout l'historique à chaque exécution,
 * indéfiniment. `id_order` est le numéro interne de la boutique ; il ne bouge
 * pas.
 */
function remoteIdPour(numero) {
  return `commande-${numero}`;
}

/**
 * Nom du fichier déposé : `AAAA-MM_<numéro de commande>.pdf`.
 *
 * Le mois en tête pour que l'ordre alphabétique soit l'ordre chronologique, le
 * numéro ensuite parce que c'est ce qu'on cherche quand on cherche une facture.
 */
function nomFichier(issuedOn, numero) {
  const mois = /^(\d{4})-(\d{2})/.exec(String(issuedOn || ''));
  const prefixe = mois ? `${mois[1]}-${mois[2]}` : ANNEE_INCONNUE;
  return `${prefixe}_${String(numero || 'commande').replace(/[^\w.-]/g, '_')}.pdf`;
}

// ---------------------------------------------------------------------------
// Quelle boutique ?
// ---------------------------------------------------------------------------

/**
 * Les adresses de la boutique servie.
 *
 * Deux sources, dans cet ordre :
 *
 *   1. le manifeste (`urls.login` / `urls.orders`) — les sept boutiques
 *      validées, dont les adresses sont vérifiées et n'ont pas à être saisies ;
 *   2. le champ « adresse du site » de la configuration — l'entrée générique
 *      « Boutique PrestaShop », où les chemins sont DÉDUITS des conventions
 *      PrestaShop les plus répandues.
 *
 * @param {object} manifest manifeste du connecteur en cours (ctx.manifest)
 * @param {object} config configuration déchiffrée
 * @returns {{login: string, orders: string, nom: string}}
 */
function adressesBoutique(manifest, config) {
  const nom = manifest?.name || 'la boutique';

  const declarees = manifest?.urls || {};
  if (declarees.login && declarees.orders) {
    return { login: declarees.login, orders: declarees.orders, nom };
  }

  const racine = racineDepuisSite(config?.[CHAMP_SITE] || manifest?.site);
  if (!racine) {
    throw erreurUtilisateur(
      'L\'adresse de la boutique n\'est pas renseignée. Ouvrez la fiche du service et '
        + 'saisissez-la, par exemple « maboutique.fr ».'
    );
  }

  // Les deux chemins les plus répandus, et les seuls qui marchent sans
  // réécriture d'URL : ils fonctionnent même quand les jolies adresses sont
  // désactivées, ce qui n'est pas le cas de « /historique-commandes ».
  return {
    login: `${racine}/index.php?controller=authentication`,
    orders: `${racine}/index.php?controller=history`,
    nom,
  };
}

/**
 * « propolia.com », « https://propolia.com/fr/ » → « https://propolia.com ».
 *
 * Toujours en HTTPS : on y saisit un mot de passe, et une boutique qui ne le
 * supporterait pas n'a rien à faire ici.
 */
function racineDepuisSite(site) {
  const brut = String(site || '').trim();
  if (!brut) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(brut) ? brut : `https://${brut}`);
    if (!url.hostname.includes('.')) return null;
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/** Une erreur destinée à l'utilisateur : elle dit quoi faire. */
function erreurUtilisateur(message) {
  const err = new Error(message);
  err.expose = true;
  return err;
}

/**
 * ─── Les messages d'échec ne sont plus écrits ici (lot 14, §2.1) ─────────────
 *
 * Ce fichier portait trois fabriques d'erreur — `erreurIdentifiants`,
 * `erreurBandeau`, `erreurInjoignable` — et le choix entre elles se faisait au
 * fil du code. Deux défauts en sont sortis :
 *
 *   1. **le mauvais message.** Propolia recevait « Adresse électronique ou mot
 *      de passe incorrect » sur une session qui n'avait jamais existé. Les
 *      identifiants étaient bons ;
 *   2. **le mauvais service.** Ces messages NOMMAIENT le connecteur (« crabe ne
 *      réessaiera pas tout seul sur Propolia »), et une fois stockés dans
 *      `last_error` ils s'affichaient tels quels ailleurs — sur la fiche
 *      d'Aagaard, par exemple (§2.2).
 *
 * La correspondance situation → message vit désormais dans
 * `connectors/messages-echec.js` : une table, unique, testée, et dont aucun
 * message ne nomme de service.
 */

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw erreurUtilisateur(
      'Playwright n\'est pas installé : ce connecteur ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Le bouton « Se connecter » du thème par défaut, et ses variantes.
 *
 * ─── Pourquoi on CLIQUE le bouton, et pas Entrée (§1.2b) ─────────────────────
 *
 * PrestaShop n'authentifie que si le POST porte `submitLogin`. Ce champ est
 * porté par le BOUTON (`<button name="submitLogin">`), pas par un champ caché :
 * valider au clavier soumet le formulaire sans lui, et PrestaShop réaffiche
 * alors la page de connexion **sans le moindre message d'erreur**. C'est très
 * exactement ce qu'on observait — « connexion établie » à 02:57:10, session
 * inexistante à 02:57:11.
 *
 * `button[name="submitLogin"]` vient donc en tête, avant même `#submit-login` :
 * quand il existe, c'est lui qui porte le champ décisif.
 */
/**
 * Le formulaire de connexion, désigné par ce qu'il est le seul à contenir.
 *
 * Une page PrestaShop porte plusieurs `<form>` : la recherche de l'en-tête, la
 * newsletter du pied de page, et la connexion. Un seul contient un champ de mot
 * de passe. Ancrer les replis là-dessus rend le bouton de recherche
 * structurellement inatteignable — plutôt que d'espérer que l'ordre des
 * sélecteurs suffise.
 */
const FORMULAIRE_CONNEXION = 'form:has(input[type="password"])';

/**
 * Les boutons de soumission, du plus sûr au plus général.
 *
 * ⚠ L'ORDRE DE CETTE LISTE EST APPLIQUÉ, un sélecteur après l'autre (voir
 * `boutonSoumission`). Ce n'est pas un détail : jusqu'au 11/08/2026 ces mêmes
 * sélecteurs étaient joints en une union unique résolue par `.first()`, et
 * `page.locator('a, b, c').first()` ne rend pas le premier sélecteur qui
 * correspond — il rend le premier élément dans l'ordre du DOM. Le formulaire de
 * recherche étant écrit avant celui de connexion, c'est son bouton qui était
 * cliqué. À chaque fois. Les journaux le disaient sans qu'on le lise :
 *
 *     15:24:34  Kubii : URL finale …index.php?controller=search&s=
 *     15:25:44  Coco Papaya : URL finale …searchiqit?s=
 *     15:31:17  Propolia : URL finale …searchiqit…&s=
 *
 * Une recherche vide, sur les cinq boutiques. La connexion n'échouait pas :
 * elle n'était jamais soumise.
 *
 * ─── Pourquoi `submitLogin` d'abord ─────────────────────────────────────────
 *
 * PrestaShop n'authentifie que si le POST porte `submitLogin`, et ce champ est
 * porté par le BOUTON, pas par un champ caché. Quand il existe, c'est lui qu'il
 * faut cliquer.
 */
const SELECTEURS_SOUMISSION = [
  'button[name="submitLogin"]',
  'input[type="submit"][name="submitLogin"]',
  '#submit-login',
  `${FORMULAIRE_CONNEXION} button[type="submit"]`,
  `${FORMULAIRE_CONNEXION} input[type="submit"]`,
  // Un `<button>` sans `type` vaut `submit`. `:not([type])` écarte au passage
  // les boutons « afficher le mot de passe », qui portent `type="button"`.
  `${FORMULAIRE_CONNEXION} button:not([type])`,
];

/**
 * L'union des sélecteurs, pour les appelants qui attendent une chaîne CSS —
 * `cookie-banner` la reçoit comme `cible` pour savoir quoi dégager.
 *
 * Elle ne contient plus aucun `form` nu : même résolue par `.first()`, elle ne
 * peut plus désigner le bouton de recherche.
 */
const SELECTEUR_SOUMISSION = SELECTEURS_SOUMISSION.join(', ');

/**
 * Se connecte, une seule fois.
 *
 * Les sélecteurs sont ceux du thème PrestaShop par défaut, que les sept
 * boutiques utilisent : `#email`, `#passwd`, `#submit-login`. Les replis par
 * `name` couvrent les thèmes qui ont renommé les identifiants sans toucher aux
 * champs de formulaire.
 *
 * ─── La preuve, et plus jamais l'absence de preuve (§1.2a) ───────────────────
 *
 * Jusqu'au lot 13 inclus, la réussite se concluait de « plus aucun champ de mot
 * de passe à l'écran ». C'est une preuve par l'absence, et elle est fausse :
 * PrestaShop réaffiche la page de connexion **sans erreur** quand le POST
 * arrive incomplet, et cette page-là peut très bien ne plus porter de
 * formulaire visible. D'où, en production :
 *
 *     02:57:10  Propolia : connexion établie.
 *     02:57:11  Propolia : la page des commandes renvoie à l'authentification.
 *
 * Une session ne meurt pas en une seconde. Elle n'avait jamais existé.
 *
 * On exige donc DEUX marqueurs positifs (voir connectors/preuve-connexion.js) :
 * une URL finale qui n'est plus celle du formulaire, ET un marqueur de compte
 * connecté. Sans les deux, la connexion a échoué — et on le dit ICI, sans
 * poursuivre vers la page des commandes.
 *
 * ─── Les quatre situations, et leur message ──────────────────────────────────
 *
 * Le choix du message n'est plus fait au fil du code mais par la table de
 * `connectors/messages-echec.js`, qui n'écrit « mot de passe incorrect » que
 * si la boutique l'a réellement dit.
 */
async function seConnecter(page, adresses, config, log, ctx = {}) {
  try {
    await page.goto(adresses.login, { waitUntil: 'domcontentloaded' });
  } catch {
    throw echecs.erreurPour('injoignable', { interne: `goto ${adresses.login}` });
  }

  // Avant TOUTE interaction avec le formulaire, et pas seulement avant le clic :
  // un voile recouvre aussi bien le champ que le bouton.
  const bandeau = await cookieBanner.fermer(page, {
    cible: SELECTEUR_SOUMISSION,
    log,
    prefixe: adresses.nom,
  });

  const email = page.locator('#email, input[name="email"]').first();
  const motDePasse = page.locator('#passwd, input[type="password"]').first();

  if (!(await email.count()) || !(await motDePasse.count())) {
    await noterDiagnostic(page, ctx, 'formulaire de connexion introuvable');
    throw erreurUtilisateur(
      `Le formulaire de connexion de ${adresses.nom} est introuvable à l'adresse `
        + `${adresses.login}. La boutique a peut-être changé d'adresse : vérifiez-la sur la `
        + 'fiche du service.'
    );
  }

  // `fill` et non `type` : on ne veut surtout pas d'un `Enter` implicite, et
  // aucun champ CACHÉ du formulaire n'est touché — les jetons que PrestaShop y
  // pose partent avec le POST tels que la page les a écrits (§1.2b).
  await email.fill(String(config[CHAMP_EMAIL] || ''));
  await motDePasse.fill(String(config[CHAMP_MOT_DE_PASSE] || ''));

  await cliquerSoumission(page, adresses, log, bandeau, ctx);

  // La navigation qui suit la soumission : on l'attend AVANT de juger. Sans
  // ça, on lirait la page de connexion encore affichée et on conclurait à un
  // refus sur une connexion qui allait aboutir.
  await page.waitForLoadState('networkidle').catch(() => {});

  const alerte = await texteAlerte(page);
  const resultat = await preuve.verifier(page, { cookies: await compterCookies(page) });

  if (resultat.confirme) {
    log(preuve.ligneConfirmee(adresses.nom, resultat));
    return resultat;
  }

  // ─── Le bénéfice du doute, et ses deux garde-fous ─────────────────────────
  //
  // Toutes les boutiques n'affichent pas de lien de déconnexion partout.
  // Fantazia redirige vers son ACCUEIL après une connexion réussie, et cette
  // page-là n'en porte pas — vérifié à la main le 11/08/2026. Le connecteur
  // concluait donc à un refus sur une connexion parfaitement valable :
  //
  //     16:48:49  Fantazia : connexion NON confirmée — URL finale
  //               https://www.fantazia-shop.fr/, aucun lien de déconnexion.
  //
  // La preuve forte reste exigée pour CONCLURE AU SUCCÈS : c'est elle qui a
  // démasqué les cinq faux positifs du matin, où le lien « Mon compte » de
  // l'en-tête PrestaShop validait des connexions qui n'avaient jamais eu lieu.
  // Mais son absence ne suffit pas à conclure à l'ÉCHEC quand rien d'autre
  // n'accuse. On poursuit alors vers la page des commandes, qui tranchera :
  // servie, la connexion était bonne ; renvoyée au formulaire, elle ne l'était
  // pas — et `surLaBoutique` le dira avec le message qui convient.
  //
  // Garde-fou 1 : l'URL finale ne doit PAS être celle d'un formulaire. Si la
  //   boutique nous a laissés sur la page de connexion, c'est un refus net et
  //   il n'y a aucun doute à accorder.
  // Garde-fou 2 : la boutique ne doit avoir affiché AUCUN message d'erreur. Un
  //   « mot de passe incorrect » à l'écran est un verdict, pas une ambiguïté.
  if (!resultat.surFormulaire && !alerte) {
    log(
      `${adresses.nom} : connexion probable mais non prouvée — URL finale ${resultat.url}, `
        + 'aucun lien de déconnexion sur cette page et aucun message d\'erreur. '
        + 'La page des commandes tranchera.'
    );
    return resultat;
  }

  // ⚠ Cette ligne-ci est celle qui permettra de trancher au prochain incident.
  // Elle part au journal MÊME quand le message affiché à l'utilisateur parle
  // d'autre chose (§1.2c).
  log(preuve.ligneNonConfirmee(adresses.nom, resultat, alerte));
  await noterDiagnostic(page, ctx, 'connexion non confirmée', {
    'marqueurs': resultat.marqueurs.join(', ') || '(aucun)',
    'alerte site': alerte || '(aucune)',
  });

  throw echecs.erreurPour(echecs.situationDepuis({ confirme: false, alerte }), {
    interne: `URL finale ${resultat.url}${alerte ? ` — « ${alerte} »` : ''}`,
  });
}

/**
 * Le nombre de cookies du contexte, pour la ligne de preuve.
 *
 * Un COMPTE, jamais des noms ni des valeurs : c'est ce chiffre qui a permis de
 * repérer la capture incomplète du lot 12 (12 cookies au lieu de 15), et il
 * n'apprend rien à qui lirait le journal par-dessus l'épaule.
 */
async function compterCookies(page) {
  try {
    return (await page.context().cookies()).length;
  } catch {
    return null;
  }
}

/**
 * Enregistre un diagnostic, si le contexte en offre un.
 *
 * Passe par `ctx.diagnostic` plutôt que d'appeler `diagnostics` directement :
 * les tests injectent leur propre collecteur, et un connecteur exécuté hors
 * d'une récupération (test de connexion depuis l'administration) n'a pas de
 * connecteur à nommer.
 */
async function noterDiagnostic(page, ctx, etape, extra = {}) {
  if (!ctx?.connectorId) return;
  try {
    await diagnostics.enregistrer({
      connectorId: ctx.connectorId,
      page,
      context: page.context?.(),
      etape,
      extra,
    });
  } catch {
    // Un diagnostic qui ferait échouer la récupération qu'il documente serait
    // pire que pas de diagnostic du tout.
  }
}

/**
 * Clique « Se connecter », en écartant le bandeau qui serait arrivé entre-temps.
 *
 * ─── Pourquoi une seconde tentative de CLIC, et pourquoi ce n'est pas une
 *     seconde tentative de CONNEXION ────────────────────────────────────────
 *
 * Les régies de cookies se chargent en asynchrone : le bandeau de Propolia se
 * pose une fraction de seconde après la page, donc APRÈS le passage préventif
 * de `cookie-banner`. Se contenter de ce passage laisserait exactement la panne
 * qu'on corrige.
 *
 * Un clic intercepté n'a **rien soumis** — Playwright le dit explicitement, il
 * refuse de cliquer plutôt que de cliquer à côté. Fermer le bandeau et cliquer
 * une fois de plus reste donc UNE seule soumission du formulaire, et ne
 * contrevient pas à la règle « aucune nouvelle tentative de connexion » du §7,
 * qui vise le fait de renvoyer des identifiants après un refus.
 *
 * Deux clics au plus. Si le second est intercepté à son tour, on s'arrête et on
 * le dit — sans parler de mot de passe.
 */
/**
 * Le bouton de soumission, cherché sélecteur par sélecteur, dans l'ordre.
 *
 * C'est la boucle qui fait exister la priorité annoncée par
 * `SELECTEURS_SOUMISSION`. Sans elle, l'ordre de la liste est purement
 * décoratif.
 *
 * @param {object} page page Playwright
 * @returns {Promise<object>} un locator, jamais `null` : si rien ne
 *   correspond, l'union est rendue et le clic échouera avec son propre message.
 */
async function boutonSoumission(page) {
  for (const selecteur of SELECTEURS_SOUMISSION) {
    try {
      const candidat = page.locator(selecteur).first();
      if (await candidat.count()) return candidat;
    } catch {
      // Page en cours de navigation, ou moteur CSS qui refuse `:has()` :
      // on passe au sélecteur suivant plutôt que d'interrompre la connexion.
    }
  }
  return page.locator(SELECTEUR_SOUMISSION).first();
}

async function cliquerSoumission(page, adresses, log, bandeau, ctx = {}) {
  const bouton = await boutonSoumission(page);
  let dernier = bandeau;

  // Le bandeau a eu le temps d'arriver pendant la saisie du formulaire : un
  // coup d'œil coûte quelques millisecondes, l'ignorer coûte quinze secondes.
  const tardif = await cookieBanner.fermerSiObstacle(page, {
    cible: SELECTEUR_SOUMISSION,
    log,
    prefixe: adresses.nom,
  });
  if (tardif) dernier = tardif.obstacle ? tardif : dernier;

  for (let essai = 0; essai < 2; essai++) {
    try {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        // Volontairement plus court que le délai de navigation : un clic
        // intercepté attendait quarante-cinq secondes avant de le dire, deux
        // fois de suite. Un bouton qui n'est pas cliquable au bout de quelques
        // secondes ne le sera pas à la trentième.
        bouton.click({ timeout: essai === 0 ? DELAI_CLIC_MS : DELAI_CLIC_LONG_MS }),
      ]);
      return;
    } catch (err) {
      // LE défaut de Propolia. Un clic intercepté n'est pas un refus : le dire
      // autrement a envoyé chercher un mot de passe parfaitement correct.
      if (!cookieBanner.estClicIntercepte(err)) {
        throw echecs.erreurPour('injoignable', { interne: `clic : ${err.message}` });
      }

      if (essai === 0) {
        log(
          `${adresses.nom} : un élément recouvre « Se connecter » — il est arrivé après le `
            + 'chargement de la page. Seconde tentative de levée.'
        );
        const seconde = await cookieBanner.fermer(page, {
          cible: SELECTEUR_SOUMISSION,
          log,
          prefixe: adresses.nom,
        });
        dernier = seconde.obstacle ? seconde : dernier;
        continue;
      }

      const description = dernier?.obstacle ? cookieBanner.decrireObstacle(dernier.obstacle) : '';
      log(
        `${adresses.nom} : le clic sur « Se connecter » reste intercepté par un élément du site`
          + (description ? ` — ${description}` : '')
          + '. Aucune nouvelle tentative.'
      );
      await noterDiagnostic(page, ctx, 'obstruction du formulaire de connexion', {
        obstacle: description || '(non décrit)',
      });
      throw echecs.erreurPour('obstruction', { interne: description });
    }
  }
}

/** Le message d'erreur affiché par la boutique, s'il y en a un. */
async function texteAlerte(page) {
  try {
    const alerte = page.locator('.alert-danger, .help-block li, .js-error').first();
    if (!(await alerte.count())) return '';
    return (await alerte.textContent())?.replace(/\s+/g, ' ').trim().slice(0, 160) || '';
  } catch {
    return '';
  }
}

/** Ouvre un navigateur, se connecte, atteint l'historique, et passe la main. */
async function surLaBoutique(config, ctx, fn) {
  const log = ctx.log || (() => {});
  const adresses = adressesBoutique(ctx.manifest, config);

  if (!config?.[CHAMP_EMAIL] || !config?.[CHAMP_MOT_DE_PASSE]) {
    throw erreurUtilisateur(
      `Renseignez votre adresse électronique et votre mot de passe ${adresses.nom} sur la `
        + 'fiche du service.'
    );
  }

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : vérifié sur Fantazia le 11/08/2026, la même
  // requête renvoie 403 avec l'agent par défaut de Playwright et 200 avec
  // celui-ci (voir connectors/browser-identity.js).
  const context = await browser.newContext(
    identity.optionsContexte({ viewport: VIEWPORT, acceptDownloads: true })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await seConnecter(page, adresses, config, log, ctx);

    // La connexion est CONFIRMÉE à ce stade. Ce qui suit ne peut donc plus
    // être un mot de passe faux : si la page des commandes renvoie malgré tout
    // à l'authentification, c'est que la session s'est perdue en chemin — et
    // c'est ce message-là qu'il faut afficher (§2.1, quatrième ligne).
    try {
      await page.goto(adresses.orders, { waitUntil: 'domcontentloaded' });
    } catch {
      throw echecs.erreurPour('injoignable', { interne: `goto ${adresses.orders}` });
    }
    await page.waitForLoadState('networkidle').catch(() => {});

    const apres = await preuve.verifier(page, { cookies: await compterCookies(page) });

    // ⚠ La question n'est PLUS « est-on connecté ». Elle a été tranchée par
    // `seConnecter`, lien de déconnexion à l'appui. Ici, la seule question est :
    // la boutique nous a-t-elle SERVI l'historique, ou renvoyés au formulaire ?
    //
    // Exiger de nouveau un lien de déconnexion est trop strict. Aagaard et
    // Apiculture.net rangent le leur dans un menu déroulant de l'en-tête,
    // présent sur /mon-compte et absent du gabarit de l'historique — d'où, le
    // 11/08/2026 :
    //
    //     15:51:46  Aagaard : connexion confirmée (…/mon-compte, lien de
    //               déconnexion présent, 6 cookie(s))
    //     15:51:48  Aagaard : …/historique-commandes … aucun lien de déconnexion
    //
    // Deux secondes, et une URL finale qui est bien celle de l'historique :
    // aucune redirection. Une boutique qui a perdu la session ne sert pas
    // l'historique, elle renvoie au formulaire. C'est CELA qu'on teste.
    //
    // Le champ de mot de passe couvre le cas de la boutique qui servirait le
    // formulaire SANS changer d'adresse — l'URL ne suffirait pas à le voir.
    const champMotDePasse = await page
      .locator('input[type="password"]')
      .count()
      .catch(() => 0);

    if (apres.surFormulaire || champMotDePasse > 0) {
      log(
        `${adresses.nom} : la page des commandes (${adresses.orders}) renvoie au formulaire `
          + `de connexion — ${preuve.ligneNonConfirmee(adresses.nom, apres)}`
      );
      await noterDiagnostic(page, ctx, 'page des commandes sans compte connecté', {
        'page visée': adresses.orders,
      });
      throw echecs.erreurPour('session-perdue', { interne: `URL finale ${apres.url}` });
    }

    log(`${adresses.nom} : page des commandes atteinte (${apres.url}).`);
    return await fn(page, context, adresses);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Cette adresse est-elle une page d'authentification ?
 *
 * Déléguée à `connectors/preuve-connexion.js` : le lot 13 en avait une copie
 * ici, qui ne connaissait que la forme ANGLAISE `authentication`. Fantazia et
 * Apiculture.net servent leur formulaire sur `/authentification` — une
 * redirection vers leur page de connexion passait donc pour « page des
 * commandes atteinte », suivie de « aucune facture ». Une seule définition,
 * partagée, ne peut plus diverger.
 */
function estRenvoyeALAuthentification(url) {
  return preuve.estUrlAuthentification(url);
}

/**
 * Relève les liens de facture de la page des commandes, et leur contexte.
 *
 * Tout se passe dans le navigateur : remonter dans le DOM depuis Node
 * demanderait un aller-retour par lien et par ancêtre.
 *
 * @returns {Promise<{schema: string, liens: Array<{href: string, texte: string, libelle: string}>}>}
 */
async function relever(page) {
  return page.evaluate(
    ({ standard, reecrit, module: moduleMotif, exclu, diagnostic, commandes, maxAncetres }) => {
      const re = {
        standard: new RegExp(standard, 'i'),
        reecrit: new RegExp(reecrit, 'i'),
        module: new RegExp(moduleMotif, 'i'),
        exclu: new RegExp(exclu, 'i'),
        diagnostic: new RegExp(diagnostic, 'i'),
      };

      // ─── D'ABORD les commandes, ENSUITE les factures (§3.2a) ──────────────
      //
      // « Le compte n'a pas encore de commande facturée » était la première
      // explication proposée pour Fantazia — un compte qui porte huit
      // commandes. On compte donc les LIGNES DE COMMANDE avant de chercher
      // quoi que ce soit : si elles existent et qu'aucun lien de facture ne
      // répond, ce n'est pas un compte vide, c'est un défaut de schéma, et le
      // message doit le dire.
      const lignesCommande = new Set();
      for (const el of document.querySelectorAll(commandes)) {
        // Une ligne d'en-tête de tableau n'est pas une commande.
        if (el.closest('thead')) continue;
        const texte = (el.innerText || el.textContent || '').trim();
        if (texte) lignesCommande.add(el);
      }

      // ─── Le repli qui ne suppose AUCUN balisage ──────────────────────────
      //
      // Les sélecteurs ci-dessus reposent tous sur un identifiant ou une classe
      // PrestaShop précis. Une première version de ce repli cherchait des `<tr>`
      // et des `<li>`. Apiculture.net n'utilise ni l'un ni l'autre : sa page
      // d'historique est une grille en `<div>` —
      //
      //     <div id="history-list">
      //       <div class="row ax-tab-header"> … en-têtes … </div>
      //       <div class="row ax-tab-list">          ← la commande
      //         <div>YKHOINMMS</div> …
      //         <a class="order-invoice-link" href="…pdf-invoice.php?id_order=120330">
      //
      // — d'où « 0 commande(s) détectée(s), 1 lien(s) de facture reconnu(s) »
      // sur un compte qui affiche bel et bien une commande, dont la facture
      // était par ailleurs correctement récupérée.
      //
      // Allonger la liste des thèmes ne mène nulle part : il y en aura toujours
      // un de plus. On part donc des LIENS, qui eux sont stables — chaque
      // commande en porte au moins un contenant `id_order=` — et on remonte
      // jusqu'à leur conteneur. Le nombre de commandes est le nombre de
      // conteneurs distincts.
      //
      // Le repli ne sert que si les sélecteurs connus n'ont rien donné : là où
      // ils fonctionnent, rien ne change et le compte reste le leur.
      if (!lignesCommande.size) {
        const estLienDeCommande = (a) => {
          if (re.exclu.test(a.href)) return false;
          if (a.matches('a.order-invoice-link, a[data-link-action="view-order-details"]')) {
            return true;
          }
          return (
            re.standard.test(a.href)
            || re.module.test(a.href)
            || re.reecrit.test(a.href)
            || /[?&]id_order=/i.test(a.href)
            || /order-detail|order-follow|suivi-commande|detail-commande/i.test(a.href)
          );
        };

        const liensCommande = [...document.querySelectorAll('a[href]')].filter(estLienDeCommande);

        for (const lien of liensCommande) {
          // On remonte tant que l'ancêtre ne contient QUE les liens de cette
          // commande-ci. Dès qu'il en engloberait une autre, on s'arrête :
          // sans ce garde-fou, `#history-list` avalerait la page entière et le
          // compte tomberait à 1 quel que soit le nombre réel de commandes.
          let conteneur = lien;
          for (let i = 0; i < maxAncetres && conteneur.parentElement; i++) {
            const parent = conteneur.parentElement;
            const dedans = [...parent.querySelectorAll('a[href]')].filter(estLienDeCommande);

            // Combien de commandes DISTINCTES ce parent engloberait-il ?
            const numeros = new Set(
              dedans.map((a) => {
                const trouve = /[?&]id_order=(\d+)/i.exec(a.href);
                return trouve ? trouve[1] : a.href;
              })
            );
            if (numeros.size > 1) break;

            conteneur = parent;
          }
          lignesCommande.add(conteneur);
        }
      }

      const tous = [...document.querySelectorAll('a[href]')];
      const nonExclu = (a) => !re.exclu.test(a.href);
      const parSchema = (motif) => tous.filter((a) => nonExclu(a) && motif.test(a.href));

      // L'ordre du §3.2b : standard, module, réécrit, puis le filet.
      let schema = 'standard';
      let retenus = parSchema(re.standard);
      if (!retenus.length) {
        schema = 'module';
        retenus = parSchema(re.module);
      }
      if (!retenus.length) {
        schema = 'reecrit';
        retenus = parSchema(re.reecrit);
      }
      if (!retenus.length) {
        // Filet de diagnostic : sur le CHEMIN, la requête et l'attribut
        // `download` — jamais sur le texte du lien. Une page de boutique porte
        // des avis clients et des articles dont le libellé peut dire
        // « Facture » sans en être une.
        schema = 'inconnu';
        retenus = tous.filter((a) => {
          if (!nonExclu(a)) return false;
          const telecharger = a.getAttribute('download') || '';
          if (re.diagnostic.test(telecharger)) return true;
          try {
            const url = new URL(a.href, document.baseURI);
            return re.diagnostic.test(`${url.pathname}${url.search}`);
          } catch {
            return false;
          }
        });
      }

      /**
       * Le texte de l'ancêtre le plus large ne contenant QU'UNE commande.
       *
       * On s'arrête dès qu'un ancêtre engloberait plusieurs liens de facture :
       * sans ça, on lirait la date de la commande voisine et on rangerait la
       * facture de juillet dans juin.
       */
      const contexte = (lien) => {
        const estFacture = (a) =>
          nonExclu(a) && (re.standard.test(a.href) || re.module.test(a.href) || re.reecrit.test(a.href));
        let noeud = lien;
        let texte = (lien.textContent || '').replace(/\s+/g, ' ').trim();

        for (let i = 0; i < maxAncetres; i++) {
          const parent = noeud.parentElement;
          if (!parent || parent === document.body) break;
          const dedans = [...parent.querySelectorAll('a[href]')].filter(estFacture).length;
          if (dedans > 1) break;
          noeud = parent;
          texte = (noeud.innerText || noeud.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return texte;
      };

      return {
        schema,
        // Ce qui permet de distinguer « compte vide » de « schéma inconnu ».
        commandesVisibles: lignesCommande.size,
        // Tous les liens de la page, pour le journal quand rien n'est reconnu :
        // c'est ce qui évitera d'avoir à redemander la page à l'utilisateur.
        liensTotal: tous.length,
        liens: retenus.map((a) => ({
          href: a.href,
          libelle: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          telecharger: a.getAttribute('download') || '',
          texte: contexte(a).slice(0, 600),
        })),
      };
    },
    {
      standard: MOTIF_STANDARD.source,
      reecrit: MOTIF_REECRIT.source,
      module: MOTIF_MODULE.source,
      exclu: MOTIF_EXCLU.source,
      diagnostic: MOTIF_DIAGNOSTIC.source,
      commandes: SELECTEUR_LIGNE_COMMANDE,
      maxAncetres: 6,
    }
  );
}

/**
 * À quoi ressemble une ligne de commande sur une page d'historique.
 *
 * Les trois premières formes couvrent les thèmes PrestaShop 1.6 et 1.7 ; les
 * deux dernières les thèmes qui ont refait la page en cartes plutôt qu'en
 * tableau. Le compte n'a pas besoin d'être exact au document près : il sert à
 * répondre à UNE question — « y a-t-il des commandes à l'écran ? » — dont la
 * réponse change entièrement le message affiché.
 */
const SELECTEUR_LIGNE_COMMANDE = [
  'table#order-list tbody tr',
  '.table-order-history tbody tr',
  'table.order-history tbody tr',
  'tr.order',
  '.order',
  '[id^="order-"]',
  '[class*="order-item"]',
  '[class*="commande"]',
].join(',');

/** L'adresse électronique du compte, qui nomme son dossier. */
function compteDepuisConfig(config) {
  const email = String(config?.[CHAMP_EMAIL] || '').trim().toLowerCase();
  return email && email.includes('@') ? email : COMPTE_PAR_DEFAUT;
}

/**
 * Les commandes retenues, dédoublonnées et datées.
 *
 * Un même numéro peut apparaître deux fois sur la page (un lien dans la ligne,
 * un autre dans un menu déplié) : le premier gagne.
 *
 * @param {Array<{href: string, texte: string, libelle: string}>} liens
 * @param {number} rang index de départ, pour nommer un lien sans numéro
 */
function commandesDepuisLiens(liens, rang = 0) {
  const vues = new Set();
  const sortie = [];

  for (const lien of liens || []) {
    const numero = numeroDepuisLien(lien.href) || `sans-numero-${rang + sortie.length + 1}`;
    if (vues.has(numero)) continue;
    vues.add(numero);

    const infos = infosDepuisTexte(lien.texte || lien.libelle);
    sortie.push({ ...lien, numero, ...infos });
  }

  return sortie;
}

/** Le document relève-t-il de la profondeur d'historique demandée ? */
function dansLaFenetre(issuedOn, annees) {
  if (!annees || !annees.length) return true;
  // Sans date, on garde : mieux vaut un document de trop dans `inconnu/` qu'un
  // document perdu parce qu'on n'a pas su le dater.
  if (!issuedOn) return true;
  return annees.includes(Number(String(issuedOn).slice(0, 4)));
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la connexion passe-t-elle, et voit-on des commandes ? */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});

  return surLaBoutique(config, ctx, async (page, context, adresses) => {
    const releve = await relever(page);
    const commandes = commandesDepuisLiens(releve.liens);

    if (releve.schema === 'inconnu' && commandes.length) {
      log(
        `${adresses.nom} : aucun schéma de facture connu — ${commandes.length} lien(s) `
          + `à examiner : ${commandes.slice(0, 5).map((c) => c.href).join(' | ')}`
      );
    }

    return {
      ok: true,
      accountId: compteDepuisConfig(config),
      invoiceCount: commandes.length,
      message:
        `Connexion à ${adresses.nom} réussie — ${commandes.length} facture(s) visible(s)`
        + (releve.schema === 'inconnu'
          ? '. Le schéma de facture de cette boutique n\'est pas reconnu : les documents '
            + 'seront tout de même tentés, et le journal dit ce qui a été trouvé.'
          : '.'),
    };
  });
}

/** Récupère les factures des commandes visibles. */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLaBoutique(config, ctx, async (page, context, adresses) => {
    const compte = compteDepuisConfig(config);
    const releve = await relever(page);
    const commandes = commandesDepuisLiens(releve.liens);

    // ─── Le compte rendu qui distingue un compte vide d'un schéma inconnu ───
    //
    // C'est la ligne exigée par le §3.2a. « 8 commande(s) détectée(s), 0 lien
    // de facture reconnu » et « 0 commande(s) détectée(s) » ne décrivent pas
    // la même panne, et jusqu'ici les deux s'écrivaient « aucune facture ».
    log(
      `${adresses.nom} : ${releve.commandesVisibles} commande(s) détectée(s), `
        + `${commandes.length} lien(s) de facture reconnu(s)`
        + (commandes.length ? ` (schéma « ${releve.schema} »)` : '')
        + '.'
    );

    // Preuve d'accès (lot 31) : la session a été confirmée par un lien de
    // déconnexion dans `seConnecter`, la page des commandes a été servie sans
    // renvoyer au formulaire (surLaBoutique), et son relevé vient d'être lu.
    // Déposée AVANT le tri : un compte réellement sans commande reste un
    // résultat honnête, pas un échec.
    ctx.preuveDeListe?.({
      session: 'lien de déconnexion constaté à la connexion, historique servi hors formulaire',
      liste: `page des commandes ${adresses.orders}`,
      elements: releve.commandesVisibles,
    });

    if (!commandes.length) {
      if (releve.commandesVisibles) {
        // Des commandes à l'écran et aucun lien reconnu : ce n'est PAS un
        // compte sans facture. On le dit, et on garde la page.
        log(
          `${adresses.nom} : DÉFAUT DE SCHÉMA — ${releve.commandesVisibles} commande(s) sont `
            + `visibles sur ${adresses.orders} mais aucun de ses ${releve.liensTotal} lien(s) `
            + 'ne répond à un schéma de facture connu. Un diagnostic complet a été enregistré '
            + '(Paramètres → Applications → Diagnostic).'
        );
        await noterDiagnostic(page, ctx, 'commandes visibles, aucun lien de facture', {
          commandes: releve.commandesVisibles,
          liens: releve.liensTotal,
        });
      } else {
        log(
          `${adresses.nom} : aucune commande visible sur ${adresses.orders} — ce compte n'a `
            + 'probablement pas encore de commande.'
        );
      }
      return { accountId: compte, invoices: [] };
    }

    if (releve.schema === 'inconnu') {
      log(
        `${adresses.nom} : SCHÉMA INCONNU — ni « controller=pdf-invoice », ni `
          + `« /modules/…/pdf-invoice.php », ni « /pdf-invoice ». ${commandes.length} lien(s) `
          + 'relevé(s) par le filet : '
          + commandes.slice(0, 10).map((c) => `${c.libelle || '(sans texte)'} → ${c.href}`).join(' | ')
      );
      await noterDiagnostic(page, ctx, 'schéma de facture inconnu', {
        commandes: releve.commandesVisibles,
        retenus: commandes.length,
      });
    }

    // Profondeur d'historique : les années présentes sur la page, filtrées par
    // le réglage du connecteur. Les commandes sans date passent toujours.
    const disponibles = [
      ...new Set(
        commandes.map((c) => Number(String(c.issuedOn || '').slice(0, 4))).filter(Boolean)
      ),
    ].sort((a, b) => b - a);

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles,
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      // Le plafond de conservation, posé par le socle (lot 26) : ce moteur sert
      // huit boutiques, et l'oubli valait donc pour les huit. Vaut 0 tant qu'un
      // plancher protège l'existant.
      plafondMois: ctx?.conservationMois || 0,
    });
    log(`${adresses.nom} : historique « ${plan.mode} » — ${plan.raison}`);

    const invoices = [];
    let ignorees = 0;
    let deja = 0;
    // ⚠ Pas `echecs` : c'est le nom du module de messages, requis en tête de
    // fichier. Un compteur qui l'ombre rendrait `echecs.erreurPour()` illisible
    // pour qui relit cette fonction.
    let rejetes = 0;

    for (const commande of commandes) {
      const remoteId = remoteIdPour(commande.numero);
      if (connus.has(remoteId)) {
        deja++;
        continue;
      }
      if (!dansLaFenetre(commande.issuedOn, plan.annees)) {
        ignorees++;
        continue;
      }

      const res = await context.request
        .get(commande.href, { timeout: NAV_TIMEOUT_MS })
        .catch(() => null);

      if (!res || !res.ok()) {
        rejetes++;
        log(
          `${adresses.nom} : commande ${commande.numero} — HTTP `
            + `${res ? res.status() : 'sans réponse'} sur ${commande.href}, ignorée pour cette fois`
        );
        continue;
      }

      const buffer = Buffer.from(await res.body());
      const type = String(res.headers()['content-type'] || '');

      // ─── Le CONTENU fait foi, pas l'en-tête (§3.2c) ─────────────────────
      //
      // Apiculture.net sert ses PDF en « application/octet-stream », et une
      // boutique dont la session vient de tomber sert du HTML avec un
      // « application/pdf » impeccable. On accepte donc un type déclaré PDF
      // **ou** un contenu qui commence par %PDF-, et on exige au moins l'un
      // des deux. L'URL rejetée part au journal : c'est un faux positif du
      // filet, et c'est comme ça qu'on apprendra à ne plus le retenir.
      if (!identity.estPdf(buffer) && !/application\/pdf/i.test(type)) {
        rejetes++;
        log(
          `${adresses.nom} : lien ÉCARTÉ, ce n'est pas une facture — ${commande.href} `
            + `(${buffer.length} o, type annoncé « ${type || 'inconnu'} », ne commence pas par %PDF-).`
        );
        continue;
      }

      connus.add(remoteId);
      invoices.push({
        accountId: compte,
        remoteId,
        // Le nom porte la RÉFÉRENCE lisible (« DHMAY47C2 » sur Fantazia) et
        // non l'`id_order` de l'URL, qui n'apparaît ni sur la facture ni dans
        // les courriels de la boutique. Le `remoteId`, lui, reste bâti sur
        // l'`id_order` : c'est la déduplication, elle a besoin de stabilité,
        // pas de lisibilité.
        filename: nomFichier(commande.issuedOn, commande.reference || commande.numero),
        // Sans date lisible, le socle range dans `inconnu/` plutôt que
        // d'échouer : un document mal classé vaut mieux qu'un document perdu.
        issuedOn: commande.issuedOn || null,
        amount: commande.amount || undefined,
        reference: commande.reference || commande.numero,
        buffer,
      });

      await page.waitForTimeout(PAUSE_DOCUMENT_MS);
    }

    // Le compte rendu final, et surtout l'ÉCART entre les trois chiffres :
    // commandes vues, liens reconnus, documents obtenus. Chaque écart désigne
    // une étape précise — la page, le tri des liens, le téléchargement.
    log(
      `${adresses.nom} : ${invoices.length} document(s) téléchargé(s) sur `
        + `${commandes.length} lien(s) de facture, pour ${releve.commandesVisibles} commande(s) `
        + 'visible(s)'
        + (ignorees ? `, ${ignorees} hors de la profondeur demandée` : '')
        + (deja ? `, ${deja} déjà récupéré(s)` : '')
        + (rejetes ? `, ${rejetes} écarté(s) (voir les lignes ci-dessus)` : '')
        + '.'
    );

    return { accountId: compte, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  schemaDuLien,
  estLienFacture,
  estLienSuspect,
  numeroDepuisLien,
  infosDepuisTexte,
  remoteIdPour,
  nomFichier,
  adressesBoutique,
  racineDepuisSite,
  compteDepuisConfig,
  commandesDepuisLiens,
  dansLaFenetre,
  sansDomaine,
  estRenvoyeALAuthentification,
  seConnecter,
  relever,
  SELECTEUR_SOUMISSION,
  SELECTEUR_LIGNE_COMMANDE,
  MOTIF_STANDARD,
  MOTIF_REECRIT,
  MOTIF_MODULE,
  MOTIF_EXCLU,
  MOTIF_DIAGNOSTIC,
  MOTIF_REFERENCE,
  COMPTE_PAR_DEFAUT,
  ANNEE_INCONNUE,
};
