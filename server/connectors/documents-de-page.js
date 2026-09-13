'use strict';

/**
 * Reconnaître un document dans une page dont on ne connaît pas encore la forme.
 *
 * ─── Pourquoi ce module existe (lot 20) ──────────────────────────────────────
 *
 * Les lots 16 à 19 posaient une règle saine : on n'écrit un connecteur qu'après
 * avoir vu la page réelle, session ouverte. Elle a produit un blocage : sans
 * identifiants, la page derrière la connexion reste invisible, donc rien ne
 * s'écrit, donc rien n'est installable, donc personne ne peut fournir les
 * identifiants. Trois services — Mistral, Invoice Ninja, Envato — étaient
 * arrêtés là, avec leur page de connexion parfaitement relevée et le reste
 * inconnu.
 *
 * Ce module est la réponse honnête à cette situation. Il ne devine pas la mise
 * en page : il ramasse les LIENS d'une page et décide, sur des indices
 * explicites, lesquels ressemblent à un document de facturation. C'est moins
 * précis qu'une recette écrite pour un site donné — et ça doit le rester : le
 * jour où quelqu'un voit la vraie page, chaque connecteur remplace cet appel
 * par ses sélecteurs à lui.
 *
 * ⚠ Ce que ce module ne fera jamais : conclure. Rendre zéro document n'est pas
 * la même chose que « ce compte n'a aucune facture », et les connecteurs qui
 * s'en servent doivent dire lequel des deux ils constatent. Un « 0 facture »
 * annoncé comme un fait sur une page qu'on n'a jamais lue est exactement le
 * genre de silence que crabe passe son temps à corriger.
 *
 * ─── Ce qu'il reçoit ─────────────────────────────────────────────────────────
 *
 * Des liens déjà extraits du DOM par le connecteur, sous une forme plate :
 *
 *   { href, texte, ligne }
 *
 * `ligne` est le texte du conteneur qui porte le lien (une `<tr>`, un `<li>`) :
 * c'est presque toujours lui qui porte la date et le montant, pas le lien
 * lui-même, dont le texte se réduit souvent à « PDF » ou à une icône.
 *
 * Le module est donc PUR : aucune dépendance à Playwright, testable hors
 * réseau, et c'est la seule raison pour laquelle l'extraction vit ici plutôt
 * qu'à l'intérieur d'un `page.evaluate()` où rien ne pourrait la vérifier.
 */

// Reconnaissance des factures hébergées par Stripe : leur adresse porte un
// jeton d'accès qui ne doit jamais servir de référence (lot 32). Module pur
// lui aussi — la promesse « testable hors réseau » tient toujours.
const factureStripe = require('./facture-stripe');

/** Un lien qui pointe explicitement un fichier de document. */
const EXTENSION_DOCUMENT = /\.(pdf|PDF)(?:[?#]|$)/;

/**
 * Les mots qui, dans une adresse ou dans un libellé, annoncent un document
 * comptable. En français et en anglais : ces consoles sont servies dans les
 * deux langues selon le compte, et souvent en anglais même pour un compte
 * français.
 */
const MOTS_DOCUMENT =
  /(factur|invoice|re[cç]u|receipt|statement|relev[ée]|billing|quittance|avoir|credit[-_ ]?note)/i;

/**
 * Les mots qui disqualifient un lien MALGRÉ un mot de document.
 *
 * « Paramètres de facturation », « Comment lire ma facture », « Contester une
 * facture » portent tous le mot et ne mènent nulle part : sans cette liste, le
 * connecteur téléchargerait une page d'aide et la déposerait dans les
 * documents de l'utilisateur.
 */
const MOTS_HORS_SUJET =
  /(param[èe]tres|settings|pr[ée]f[ée]rences|aide|help|support|faq|contact|conditions|terms|abonnement|subscription|moyens?[- ]de[- ]paiement|payment[- ]methods?|adresse[- ]de[- ]facturation|billing[- ]address|contester|dispute)/i;

/** Mois écrits en toutes lettres, français et anglais, avec leurs abréviations. */
const MOIS = {
  janvier: '01', january: '01', jan: '01', janv: '01',
  'février': '02', fevrier: '02', february: '02', feb: '02', 'févr': '02', fevr: '02',
  mars: '03', march: '03', mar: '03',
  avril: '04', april: '04', apr: '04', avr: '04',
  mai: '05', may: '05',
  juin: '06', june: '06', jun: '06',
  juillet: '07', july: '07', jul: '07', juil: '07',
  'août': '08', aout: '08', august: '08', aug: '08',
  septembre: '09', september: '09', sep: '09', sept: '09',
  octobre: '10', october: '10', oct: '10',
  novembre: '11', november: '11', nov: '11',
  'décembre': '12', decembre: '12', december: '12', dec: '12', 'déc': '12',
};

/** Les clés de `MOIS`, de la plus longue à la plus courte. */
const MOIS_MOTIF = Object.keys(MOIS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * La date portée par un texte, en ISO, ou `null`.
 *
 * Quatre écritures acceptées, parce que ces consoles n'en choisissent pas une :
 *
 *   - `2026-07-12`      ISO, la seule non ambiguë ;
 *   - `12/07/2026`      jour d'abord — l'écriture française ;
 *   - `12 juillet 2026` / `12 July 2026` ;
 *   - `July 12, 2026`   mois d'abord — l'écriture anglaise.
 *
 * ⚠ `07/12/2026` est volontairement lu « 12 juillet » et JAMAIS « 7 décembre ».
 * Les deux lectures sont défendables et il n'existe aucun moyen de trancher
 * depuis le texte seul : on choisit donc la même règle partout, on l'écrit ici,
 * et le pire cas est un document rangé sous le mauvais mois — jamais un
 * document perdu, puisque c'est l'identifiant distant qui dédoublonne.
 *
 * @param {string} texte
 * @returns {string|null} `AAAA-MM-JJ`
 */
function dateDepuisTexte(texte) {
  const brut = String(texte ?? '');
  if (!brut) return null;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(brut);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const barres = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(brut);
  if (barres) {
    const jour = Number(barres[1]);
    const mois = Number(barres[2]);
    // Jour d'abord, toujours — y compris quand les deux lectures sont
    // possibles. Une exception « si le second nombre dépasse 12, alors c'était
    // l'écriture anglaise » rendrait la règle dépendante de la valeur : le même
    // site produirait des dates lues dans un sens le 3 du mois et dans l'autre
    // le 13. Une règle qu'on ne peut pas énoncer en une phrase est une règle
    // qu'on appliquera de travers.
    if (mois >= 1 && mois <= 12 && jour >= 1 && jour <= 31) {
      return `${barres[3]}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
    }
  }

  const jourMois = new RegExp(`\\b(\\d{1,2})(?:er)?\\.?\\s+(${MOIS_MOTIF})\\.?\\s+(\\d{4})`, 'i')
    .exec(brut);
  if (jourMois) {
    return `${jourMois[3]}-${MOIS[jourMois[2].toLowerCase()]}-${jourMois[1].padStart(2, '0')}`;
  }

  const moisJour = new RegExp(`\\b(${MOIS_MOTIF})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i')
    .exec(brut);
  if (moisJour) {
    return `${moisJour[3]}-${MOIS[moisJour[1].toLowerCase()]}-${moisJour[2].padStart(2, '0')}`;
  }

  // Un mois seul (« juillet 2026 », « 2026-07ction ») : on range au premier du
  // mois. C'est faux au jour près, et c'est assumé — la période du document est
  // ce qui compte pour le classer, pas la date d'émission exacte.
  const moisSeul = new RegExp(`\\b(${MOIS_MOTIF})\\.?\\s+(\\d{4})\\b`, 'i').exec(brut);
  if (moisSeul) return `${moisSeul[2]}-${MOIS[moisSeul[1].toLowerCase()]}-01`;

  const isoMois = /\b(\d{4})-(\d{2})\b/.exec(brut);
  if (isoMois && Number(isoMois[2]) >= 1 && Number(isoMois[2]) <= 12) {
    return `${isoMois[1]}-${isoMois[2]}-01`;
  }

  return null;
}

/**
 * Le montant porté par un texte, tel qu'il est écrit, ou `null`.
 *
 * **Recopié, jamais converti ni recalculé** : le symbole reste celui du site, la
 * virgule reste une virgule. crabe range des documents, il ne fait pas de
 * comptabilité — et un montant reformaté est un montant qu'on ne peut plus
 * comparer à la facture.
 */
function montantDepuisTexte(texte) {
  const brut = String(texte ?? '');
  const m = /(?:[€$£]\s*)?(\d[\d\s .,]*\d|\d)\s*(?:[€$£]|EUR|USD|GBP)|[€$£]\s*\d[\d\s .,]*/i
    .exec(brut);
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

/**
 * Un identifiant stable pour un lien, tiré de son adresse.
 *
 * ─── Pourquoi pas le rang dans la page ───────────────────────────────────────
 *
 * Parce qu'il change. Une facture de plus en tête de liste décale tout le
 * reste : au passage suivant, le rang 3 ne désigne plus le même document, le
 * dédoublonnage ne reconnaît plus rien, et les mêmes factures sont
 * retéléchargées sous de nouveaux noms. L'adresse, elle, porte presque toujours
 * un numéro de document — c'est lui qu'on garde.
 *
 * Le chemin ET les paramètres sont pris en compte : plusieurs consoles servent
 * tous leurs documents depuis `/download` en ne changeant que `?id=…`.
 */
function referenceDepuisLien(href) {
  const brut = String(href ?? '').trim();
  if (!brut) return null;

  let chemin = brut;
  let requete = '';
  try {
    const url = new URL(brut, 'https://exemple.invalid');
    chemin = url.pathname;
    requete = url.search;
  } catch {
    // Adresse illisible : on travaille sur la chaîne telle quelle.
  }

  const morceaux = [
    ...`${chemin}${requete}`.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{3,}/g),
  ].map((m) => m[0]);

  // Le dernier morceau significatif, extension retirée. « /invoices/INV-0042.pdf »
  // donne « INV-0042 », « /billing/pdf?invoice=7712 » donne « 7712 ».
  for (let i = morceaux.length - 1; i >= 0; i--) {
    const candidat = morceaux[i].replace(/\.(pdf|html?|json)$/i, '');
    if (/^(pdf|html?|download|telecharger|invoice|invoices|facture|factures|billing|file|files|api|v\d)$/i
      .test(candidat)) continue;
    if (candidat.length >= 3) return candidat;
  }
  return null;
}

/**
 * Ce lien mène-t-il à un document ?
 *
 * Trois indices, dans cet ordre de confiance : l'extension du fichier, puis un
 * mot de document dans l'adresse, puis un mot de document dans le libellé du
 * lien. Le troisième est le plus faible — c'est pour lui que `MOTS_HORS_SUJET`
 * existe.
 *
 * @param {{href?: string, texte?: string, ligne?: string}} lien
 */
function estLienDeDocument(lien) {
  const href = String(lien?.href ?? '');
  const texte = String(lien?.texte ?? '');
  if (!href || !/^https?:/i.test(href)) return false;

  if (EXTENSION_DOCUMENT.test(href)) return true;
  if (MOTS_HORS_SUJET.test(texte) || MOTS_HORS_SUJET.test(href)) return false;
  if (MOTS_DOCUMENT.test(href)) return true;
  return MOTS_DOCUMENT.test(texte);
}

/**
 * Deux adresses désignent-elles la MÊME page, aux paramètres près ?
 *
 * Sert à écarter les liens de navigation qui ramènent à la page qu'on est en
 * train de lire — et c'est le défaut qui a coûté le connecteur Hetzner
 * (lot 24). Sur `accounts.hetzner.com/invoice`, quatre liens portent le mot
 * `invoice` sans être des factures : le sélecteur de langue, l'entrée
 * « Vue d'ensemble » du menu, et les trois liens de pagination `?page=2,3,4`.
 * crabe téléchargeait la page elle-même, 78 850 octets de HTML, et échouait sur
 * « ce document n'est pas un PDF » avant d'atteindre la moindre vraie facture.
 *
 * La comparaison ignore la query : `?page=2` est la même page, sous un autre
 * angle. Elle ignore aussi le fragment, qui ne part même pas au serveur.
 */
function memePage(a, b) {
  if (!a || !b) return false;
  try {
    const x = new URL(String(a));
    const y = new URL(String(b));
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * Les documents candidats d'une page, dédoublonnés par adresse.
 *
 * @param {Array<{href: string, texte?: string, ligne?: string}>} liens
 * @param {object} [options]
 * @param {string} [options.prefixe] préfixe des identifiants distants, pour que
 *   deux sources d'un même connecteur ne se masquent pas l'une l'autre
 * @param {string} [options.pageActuelle] l'adresse de la page en cours de
 *   lecture : tout lien qui y ramène est de la navigation, pas un document
 * @param {RegExp|((url: string) => boolean)} [options.route] la route EXACTE des
 *   documents, quand le connecteur a vu la vraie page et sait la nommer. C'est
 *   le remède définitif à ce module : les indices génériques ne servent qu'à
 *   ceux qui n'ont pas encore pu regarder.
 * @returns {Array<{remoteId: string, url: string, issuedOn: string|null,
 *   amount: string|null, libelle: string}>}
 */
function documentsDepuisLiens(liens, { prefixe = '', pageActuelle = null, route = null } = {}) {
  const vus = new Set();
  const sortie = [];
  const surLaRoute = route instanceof RegExp
    ? (url) => route.test(url)
    : typeof route === 'function' ? route : null;

  for (const lien of Array.isArray(liens) ? liens : []) {
    const brut = String(lien?.href ?? '').trim();

    // La route déclarée prime sur tout : quand un connecteur sait où sont ses
    // documents, les indices génériques n'ont plus voix au chapitre.
    if (surLaRoute) {
      if (!brut || !surLaRoute(brut)) continue;
    } else {
      if (!estLienDeDocument(lien)) continue;
      if (memePage(brut, pageActuelle)) continue;
    }

    const url = brut;
    if (vus.has(url)) continue;
    vus.add(url);

    // La ligne d'abord : c'est elle qui porte la date et le montant. Le texte
    // du lien ne dit souvent que « PDF ».
    const contexte = `${lien.ligne ?? ''} ${lien.texte ?? ''}`.trim();
    // Les pages de facture Stripe D'ABORD (lot 32) : leur « référence » tirée
    // de l'adresse serait le jeton d'accès entier — un secret de 130 caractères
    // qui change à chaque chargement de la page. Comme identifiant, il
    // re-téléchargeait tout à chaque passage ; comme nom de fichier, il partait
    // en clair sur les destinations. L'empreinte de sa partie stable règle les
    // deux (voir facture-stripe.js).
    const reference = factureStripe.referenceStable(url)
      || referenceDepuisLien(url) || `doc${sortie.length + 1}`;

    sortie.push({
      remoteId: `${prefixe}${reference}`,
      url,
      issuedOn: dateDepuisTexte(contexte),
      amount: montantDepuisTexte(contexte),
      libelle: String(lien.texte ?? '').replace(/\s+/g, ' ').trim(),
    });
  }

  return sortie;
}

/**
 * Le script exécuté dans la page pour relever ses liens.
 *
 * Écrit ici, en une chaîne, plutôt que dans chaque connecteur : les trois
 * connecteurs de ce lot relèvent exactement la même chose, et une copie par
 * connecteur, c'est trois endroits à corriger le jour où l'un d'eux découvre
 * qu'il manquait les liens portés par un `<button>`.
 *
 * ⚠ Cette fonction s'exécute dans le NAVIGATEUR : elle ne peut rien voir du
 * module. Tout ce dont elle a besoin doit tenir dans son corps.
 */
function releverLiens() {
  const sortie = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!/^https?:/i.test(href)) continue;
    let conteneur = a.closest('tr, li, [role="row"]') || a.parentElement;

    // Beaucoup de consoles récentes n'ont ni <tr> ni <li> : la ligne d'une
    // facture y est un empilement de <div>, et le conteneur immédiat du lien
    // ne dit rien de plus que « Télécharger ». Chez Mistral, c'est ce qui
    // faisait ranger la facture sans date, alors que son numéro ET sa date
    // étaient écrits juste à côté.
    //
    // On remonte donc, mais sous deux bornes strictes : tant que ce qu'on
    // tient est trop court pour porter une date, et jamais vers un parent qui
    // en dit trop. Sans la seconde, on finirait par ramasser le texte de la
    // page entière et on daterait cette facture-ci avec la date de celle-là.
    for (let i = 0; i < 4 && conteneur; i++) {
      if ((conteneur.textContent || '').trim().length >= 25) break;
      const parent = conteneur.parentElement;
      if (!parent || parent === document.body) break;
      if ((parent.textContent || '').trim().length > 400) break;
      conteneur = parent;
    }

    sortie.push({
      href,
      texte: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      ligne: (conteneur?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }
  return sortie;
}

/**
 * Le nom du fichier déposé : `<service>_<période ou référence>_<référence>.pdf`.
 *
 * La date vient EN PREMIER quand elle est connue : dans un dossier trié par
 * nom, les documents se rangent alors chronologiquement tout seuls, ce qui est
 * la seule chose qu'on demande à un nom de fichier de facture.
 */
function nomFichier(prefixe, { issuedOn, remoteId }) {
  const propre = (v) => String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/(^-|-$)/g, '');
  const periode = issuedOn ? String(issuedOn).slice(0, 7) : null;
  const service = propre(prefixe);
  let reference = propre(remoteId) || 'document';

  // Les identifiants distants sont pr\u00e9fix\u00e9s du nom du connecteur pour ne pas
  // se masquer entre sources ; dans le nom du fichier, le service est d\u00e9j\u00e0 le
  // premier segment \u2014 le r\u00e9p\u00e9ter donnait \u00ab mistral_mistral-MSTRL-\u2026\u200b.pdf \u00bb.
  if (service && reference.startsWith(`${service}-`) && reference.length > service.length + 1) {
    reference = reference.slice(service.length + 1);
  }

  // R\u00e9f\u00e9rence born\u00e9e \u00e0 40 caract\u00e8res (lot 32). Au-del\u00e0, ce n'est plus un
  // num\u00e9ro de facture, c'est un identifiant opaque \u2014 et la production a montr\u00e9
  // le pire cas : le jeton d'acc\u00e8s Stripe, 130 caract\u00e8res, copi\u00e9 EN CLAIR dans
  // les noms d\u00e9pos\u00e9s sur \u00c9cureuil, alors que l'URL du document se reconstruit
  // depuis lui sans session. Un nom de fichier part vers des destinations
  // tierces ; un secret n'y a jamais sa place. On remplace par l'empreinte
  // SHA-256 (12 hexad\u00e9cimaux) : courte, stable, muette sur ce qu'elle
  // recouvre. 40, parce que la plus longue r\u00e9f\u00e9rence l\u00e9gitime relev\u00e9e chez les
  // connecteurs en fait 28 (`mistral-MSTRL-API-781711-001`, pr\u00e9fixe compris).
  if (reference.length > 40) {
    reference = require('node:crypto').createHash('sha256').update(reference).digest('hex').slice(0, 12);
  }

  return `${service}_${periode ? `${periode}_` : ''}${reference}.pdf`;
}

/**
 * L'adresse à TÉLÉCHARGER pour un lien de document — pas toujours le lien.
 *
 * ─── La panne mesurée (lot 31, 14/08/2026) ───────────────────────────────────
 *
 * La console de Claude lie ses factures vers la page Stripe
 * `invoice.stripe.com/i/<compte>/<jeton>`. Un GET dessus rend **745 octets** de
 * HTML (HTTP 200, `text/html`) : la coquille JavaScript qui peint la facture à
 * l'écran — jamais la facture. Suffixer `/pdf` sur ce même hôte rend la même
 * coquille. Le PDF vit sur un AUTRE hôte, mesuré au curl le 14/08 :
 *
 *     pay.stripe.com/invoice/<compte>/<jeton>/pdf
 *     → HTTP 200, application/octet-stream, 34 837 octets, « %PDF-1.4 »
 *
 * Même famille que la route PDF de Proxmox au lot 20 (`type=i` au lieu de
 * `type=invoice`) : la page qui MONTRE et la route qui SERT ne sont pas au
 * même endroit. Toute adresse qui n'est pas une page de facture Stripe ressort
 * inchangée.
 *
 * @param {string} url le lien relevé dans la page
 * @returns {string} l'adresse à donner au téléchargement
 */
function urlDeTelechargement(url) {
  const trouve = /^https:\/\/invoice\.stripe\.com\/i\/(acct_[^/?#]+)\/([^/?#]+)/i.exec(
    String(url ?? '')
  );
  if (!trouve) return String(url ?? '');
  return `https://pay.stripe.com/invoice/${trouve[1]}/${trouve[2]}/pdf`;
}

/**
 * Un identifiant de document raccourci pour un journal ou un message d'erreur.
 *
 * La règle du projet est stricte : jamais d'identifiant complet de document
 * dans un journal. Ici elle protège plus qu'un principe — l'identifiant des
 * factures Stripe EST un jeton d'accès (l'URL entière se reconstruit depuis
 * lui, sans session). Vingt caractères suffisent à reconnaître de quel
 * document on parle ; la longueur dit qu'il y avait une suite.
 *
 * @param {*} valeur
 * @returns {string}
 */
function idPourJournal(valeur) {
  const texte = String(valeur ?? '');
  return texte.length <= 20 ? texte : `${texte.slice(0, 20)}… (${texte.length} car.)`;
}

module.exports = {
  dateDepuisTexte,
  montantDepuisTexte,
  referenceDepuisLien,
  estLienDeDocument,
  memePage,
  documentsDepuisLiens,
  releverLiens,
  nomFichier,
  urlDeTelechargement,
  idPourJournal,
  MOTS_DOCUMENT,
  MOTS_HORS_SUJET,
};
