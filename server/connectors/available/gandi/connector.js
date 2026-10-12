'use strict';

/**
 * Connecteur Gandi — les factures de chaque organisation, lues par simples
 * adresses et prises à l'API de facturation, sans un seul clic (lots 93 à 95).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * MESURÉ en anonyme le 06/10/2026 (docs/reconnaissance-lot93.md §4) :
 * `https://admin.gandi.net/billing` renvoie un visiteur sans session, en trois
 * redirections (`/billing/api/v5/login` → `id.gandi.net/fr/authorize` →
 * `id.gandi.net/fr/login`), vers le formulaire de connexion de Gandi ID — sans
 * captcha. Une adresse d'organisation inventée subit la même chaîne : la garde
 * passe avant le routage.
 *
 * MESURÉ au journal de production le 06/10/2026 (lot 94) : connecté,
 * `/billing` ne SERT pas la liste des organisations, il y RENVOIE — vers
 * `/billing/<organisation>` puis `/billing/<organisation>/organizations`
 * (200), l'organisation de l'étape intermédiaire étant vraisemblablement la
 * personnelle. Le lot 93 n'acceptait la liste qu'à `/billing` : sa première
 * rencontre avec le vrai site a donc été jugée « page illisible »
 * (docs/reconnaissance-lot94.md).
 *
 * LU DANS LE CODE SOURCE de deux pages, enregistrées par l'utilisateur le 06/10 (le
 * prompt du lot 93 en a repris la structure, sans aucune donnée) :
 *
 *   - la liste des organisations, servie à `/billing/<organisation>/organizations`
 *     (le lot 93 la croyait à `/billing`, qui reste accepté) : `title`
 *     « Choisir une organisation - Gandi.net », un `h1` « Facturation », une `ul` dont
 *     chaque `li` porte un lien `/billing/<organisation>/overview` (son texte
 *     est le NOM de l'organisation), l'étiquette « Moi » pour l'organisation
 *     personnelle, et un second lien « Voir » vers la même adresse. Les liens
 *     sont tantôt relatifs, tantôt absolus ;
 *   - les factures d'une organisation, à `/billing/<organisation>/invoices` :
 *     `title` en « … Facturation - Gandi.net », une `nav aria-label="Onglets"`
 *     dont « Factures » porte `aria-current="page"`, un tableau (Numéro de
 *     facture, Date, Montant, Méthode, Commande, Produit, Statut). Chaque
 *     numéro porte un lien « PDF » :
 *     `/billing/<organisation>/invoices/<interne>/<numéro>/pdf`. Pagination
 *     par `?page=N`, dix factures par page. Rendu par le serveur.
 *
 * ⚠ CE LIEN N'EST PAS LE PDF (lot 95). Le lot 93 l'a écrit « un lien direct
 * vers le PDF » : c'était une DÉDUCTION, tirée de la page enregistrée (un lien
 * qui finit par `/pdf`), jamais une mesure — puis recopiée dans le banc
 * d'essai, qui servait le PDF à cette adresse : aucun essai ne pouvait la
 * contredire. Elle s'est vue au premier passage réel, n° 708, le 06/10/2026 à
 * 05:03 (Paris) : 168 factures lues dans trois organisations, les trois
 * premières ont rendu une page HTML d'environ 84 Ko, et aucune n'a été prise.
 * L'utilisateur a mesuré ensuite, dans son navigateur (sondes de console, formes
 * seulement) : le lien sert une page de l'APPLICATION Gandi (200, `text/html`,
 * 83 203 ou 83 883 octets selon le lien, sans redirection) ; ouverte dans un
 * onglet, cette page demande elle-même le fichier à l'API de facturation, sur
 * le même hôte :
 *
 *   `/billing/api/v5/billing/invoices/<interne>/pdf?lang=fr&invoice_num=<numéro>&sharing_id=<organisation>`
 *
 * Redemandée par un simple `fetch` avec les cookies, sans en-tête ajouté, cette
 * adresse rend un vrai PDF (200, `application/pdf`, `Content-Disposition`
 * présent, début `%PDF-`, ≈ 2,2 s), et ses trois valeurs sont exactement les
 * trois segments du lien. C'est là que le connecteur prend désormais chaque
 * PDF (`adresseApiDuPdf`, docs/reconnaissance-lot95.md).
 *
 * NON MESURÉ : le second facteur, la durée de la session, la page d'une
 * organisation sans facture, ce que montre `/billing` à un compte d'une seule
 * organisation. Pour l'API (lot 95) : si elle répond de même pour toutes les
 * factures et toutes les organisations (une seule facture d'une seule
 * organisation a été essayée, et jamais dans le Chromium sans écran de
 * crabe), si elle limite le nombre de demandes, ce que changent `lang` et
 * `sharing_id`, et l'alphabet réel des segments interne et numéro.
 *
 * ─── Aucun clic, aucune saisie (R8) ──────────────────────────────────────────
 *
 * Tout se suit par ADRESSE : la liste des organisations, puis pour chaque
 * organisation retenue `/invoices`, `/invoices?page=2`…. Chaque PDF se demande
 * à l'API de facturation, à l'adresse construite depuis le lien lu
 * (`adresseApiDuPdf`) et revérifiée juste avant (`verifierAdresseApi`) —
 * jamais en naviguant vers le lien. La demande part DANS l'onglet, de la page
 * où l'on est (`onglet-pdf.fluxDeLaPage` : le `fetch` du navigateur, mêmes
 * cookies, même empreinte — lot 80), jamais par un client HTTP à part, sans
 * en-tête ajouté ; ce qui arrive doit commencer par `%PDF-` pour être déposé.
 * Le menu « ⋮ » de chaque ligne, « Exporter une période », les filtres, les
 * cases à cocher, « Paiements automatiques », « Paramètres », le panier et
 * `/billing/api/v5/logout` ne sont jamais approchés : seules des adresses
 * reconnues par `organisationDepuisAdresse` et `pagesSuivantes` sont
 * visitées, et seule l'adresse d'API construite par `adresseApiDuPdf` est
 * demandée.
 *
 * ─── Les organisations (R9) ──────────────────────────────────────────────────
 *
 * `discover()` les lit après la connexion ; la fiche les présente par NOM
 * (champ `multiselect` déclaré `toutCocher`). « Toutes » est le défaut, et
 * vaut aussi pour une organisation apparue plus tard ; un choix précis reste
 * précis. Une organisation décochée n'est pas même visitée.
 *
 * ─── L'ancre, le nom, le rangement (R10) ─────────────────────────────────────
 *
 * Ancre `gandi-<organisation>-<numéro>`, lue dans le lien « PDF » — jamais une
 * empreinte du PDF (le lot 95 prend le fichier ailleurs, l'ancre ne bouge pas). Nom `gandi_AAAA-MM_<numéro>.pdf`, la date venant de la
 * colonne « Date » (« 12 févr. 2026 »). Chaque facture est rangée dans le
 * dossier de SON organisation (`accountId`).
 *
 * Lot 98 : ce dossier porte le NOM de l'organisation, et non plus son
 * identifiant (un UUID illisible, vu par l'utilisateur le 06/10/2026 sur le stockage local).
 * Le connecteur ne fait que dire ce nom (`nomDuCompte`) ; le dossier se
 * décide au socle, par une seule fonction (`dossier-par-nom.js`) : nom rendu
 * sûr, suffixe entre homonymes, dossier déjà employé gardé si le nom change,
 * identifiant comme avant sans nom. `accountId` et l'ancre gardent
 * l'identifiant.
 *
 * ─── « Depuis la dernière récupération », chez Gandi ─────────────────────────
 *
 * Toutes les factures d'une organisation tiennent sur quelques pages : les lire
 * ne coûte presque rien, seul le téléchargement coûte. Le réglage par défaut
 * prend donc, à chaque passage, ce qui n'est pas encore dans l'archive (dans
 * la limite du réglage de conservation). C'est ce qui permet à une première
 * récupération coupée par le temps de reprendre où elle s'est arrêtée (R11).
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const history = require('../../history');
const pageDocs = require('../../documents-de-page');
const ongletPdf = require('../../onglet-pdf');
const navigation = require('../../releve-navigation');
const profilMarchand = require('../../profil-marchand');
const serieEchecs = require('../../serie-echecs');

const ID = 'gandi';
const NOM = 'Gandi';

const HOTE_ADMIN = 'admin.gandi.net';
const HOTE_ID = 'id.gandi.net';
const URL_FACTURATION = 'https://admin.gandi.net/billing';

/**
 * Les adresses de la liste des organisations : `/billing/<organisation>/organizations`,
 * mesurée au journal de production le 06/10/2026 (lot 94), et `/billing` tout
 * court, que le lot 93 attendait — au cas où un compte y serait servi
 * directement.
 */
const CHEMINS_LISTE = [/^\/billing\/?$/, /^\/billing\/(?!api(?:\/|$))[A-Za-z0-9_-]{1,80}\/organizations\/?$/];

/** Le titre de la page de la liste (code source du 06/10, lot 93). */
const TITRE_LISTE = /^\s*choisir une organisation\b/i;

const CHAMP_SESSION = 'session';
const CHAMP_ORGANISATIONS = 'organisations';

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
/** Attendre que la page se pose — borné, un site bavard ne doit pas tout coûter. */
const DELAI_REPOS_MS = 15_000;

/**
 * Combien de pages de factures au plus par organisation. Une borne contre une
 * pagination qui tournerait en rond, pas une limite attendue : cinquante pages
 * de dix, c'est cinq cents factures. Atteinte, elle se dit.
 */
const PAGES_MAX = 50;

/**
 * La limite d'une exécution (lot 67), relue comme le planificateur la relit :
 * `CRABE_LIMITE_EXECUTION_MS`, sinon quarante-cinq minutes. La valeur par
 * défaut est la même que `scheduler.LIMITE_EXECUTION_MS` — un test le vérifie.
 */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;

/**
 * La part de cette limite que le connecteur s'accorde. Le planificateur ne
 * dépose rien d'une exécution qui dépasse sa limite (la promesse abandonnée
 * n'est plus lue) : passé ce délai, le connecteur s'arrête de lui-même et rend
 * ce qu'il a pris, pour que rien ne soit perdu (R11).
 */
const PART_DU_TEMPS = 2 / 3;

function budgetMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  const limite = Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_DEFAUT_MS;
  return Math.floor(limite * PART_DU_TEMPS);
}

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `Le navigateur nécessaire à ${NOM} n'est pas installé sur ce serveur. `
        + 'Signalez-le à la personne qui administre crabe.'
    );
  }
}

function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw profilMarchand.erreurSessionExpiree(NOM, controle.error);
  return controle.state;
}

/**
 * Un chemin dicible au journal : l'identifiant d'une organisation (le segment
 * qui suit `/billing/`) et toute suite de six chiffres ou plus sont masqués.
 * Le journal de navigation du socle ne masque que les chiffres, et un
 * identifiant d'organisation Gandi n'en est pas fait. Pure, testée.
 */
function masquer(texte) {
  return String(texte ?? '')
    .replace(/\/billing\/(?!api(?:\/|\b))[^/\s?#]+/g, '/billing/…')
    .replace(/\d{6,}/g, '…');
}

/** Une adresse, résolue, si elle est sur `admin.gandi.net` ; sinon `null`. */
function surAdmin(href, base = URL_FACTURATION) {
  try {
    const u = new URL(String(href), base);
    return u.protocol === 'https:' && u.hostname === HOTE_ADMIN ? u : null;
  } catch {
    return null;
  }
}

/**
 * L'identifiant d'une organisation, lu dans un lien `/billing/<id>/overview`
 * (ou `/invoices`), relatif ou absolu. Rien d'autre ne passe.
 */
function organisationDepuisAdresse(href, base = URL_FACTURATION) {
  const u = surAdmin(href, base);
  if (!u) return null;
  const m = /^\/billing\/([A-Za-z0-9_-]{1,80})\/(overview|invoices)\/?$/.exec(u.pathname);
  return m && m[1] !== 'api' ? m[1] : null;
}

/** L'adresse de la liste des factures d'une organisation, page `n` (1 = sans paramètre). */
function adresseFactures(organisation, n = 1) {
  const base = `${URL_FACTURATION}/${encodeURIComponent(organisation)}/invoices`;
  return n > 1 ? `${base}?page=${n}` : base;
}

/**
 * Un lien « PDF » de facture : `/billing/<organisation>/invoices/<interne>/<numéro>/pdf`,
 * relatif ou absolu, sur `admin.gandi.net`. Rend ses trois morceaux et
 * l'adresse absolue, ou `null`. ⚠ Cette adresse sert une page de
 * l'application, pas le PDF (lot 95) : elle ne se visite ni ne se demande —
 * elle donne l'ancre, le nom, et les trois segments de l'adresse d'API.
 */
function factureDepuisAdresse(href, base = URL_FACTURATION) {
  const u = surAdmin(href, base);
  if (!u) return null;
  const m = /^\/billing\/([^/]+)\/invoices\/([^/]+)\/([^/]+)\/pdf\/?$/.exec(u.pathname);
  if (!m) return null;
  const dec = (x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return null;
    }
  };
  const [organisation, interne, numero] = [m[1], m[2], m[3]].map(dec);
  // eslint-disable-next-line no-control-regex
  const propre = (x) => !!x && x.length <= 80 && !/[\u0000-\u001f\u007f]/.test(x);
  if (![organisation, interne, numero].every(propre)) return null;
  return { organisation, interne, numero, adresse: `${u.origin}${u.pathname}` };
}

// ---------------------------------------------------------------------------
// L'API de facturation — d'où vient le PDF (lot 95)
// ---------------------------------------------------------------------------

/** Le chemin de l'API qui sert le PDF d'une facture (mesuré par l'utilisateur le 06/10/2026). */
const CHEMIN_API_PDF = '/billing/api/v5/billing/invoices';

/** La langue que l'application de Gandi demande elle-même (mesuré). */
const LANGUE_PDF = 'fr';

/**
 * L'alphabet des segments « interne » et « numéro » repris dans l'adresse
 * d'API : celui qu'une adresse n'a jamais besoin d'échapper (lettres et
 * chiffres ASCII, `-`, `.`, `_`, `~`), sans segment fait seulement de points.
 * Leur forme réelle n'est PAS mesurée — les sondes de l'utilisateur ont comparé les
 * valeurs sans les afficher. Un segment hors de cet alphabet « surprend » :
 * la facture n'est pas demandée, et le journal dit la forme de l'écart, de
 * quoi élargir l'alphabet sur mesure, jamais à l'aveugle.
 */
const SEGMENT_API = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,80}$/;
const ALPHABET_API = /[A-Za-z0-9._~-]/;

/** L'alphabet d'un identifiant d'organisation : celui que tout ce connecteur exige déjà. */
const SEGMENT_ORGANISATION = /^[A-Za-z0-9_-]{1,80}$/;
const ALPHABET_ORGANISATION = /[A-Za-z0-9_-]/;

/**
 * Le motif EXACT d'une adresse d'API : l'hôte `admin.gandi.net` en https, le
 * chemin `/billing/api/v5/billing/invoices/<interne>/pdf`, et exactement trois
 * paramètres, dans l'ordre mesuré, `lang` valant `fr`. Revérifié juste avant
 * chaque demande (`verifierAdresseApi`) ; rien d'autre ne passe.
 */
const MOTIF_ADRESSE_API = /^https:\/\/admin\.gandi\.net\/billing\/api\/v5\/billing\/invoices\/((?!\.{1,2}\/)[A-Za-z0-9._~-]{1,80})\/pdf\?lang=fr&invoice_num=((?!\.{1,2}&)[A-Za-z0-9._~-]{1,80})&sharing_id=([A-Za-z0-9_-]{1,80})$/;

/**
 * La FORME d'un segment qui surprend, pour le journal — jamais sa valeur.
 * Seuls les signes ASCII hors alphabet sont nommés : une lettre accentuée
 * pourrait appartenir à un nom. Pure.
 */
function formeDuSegment(valeur, alphabet = ALPHABET_API) {
  const v = String(valeur ?? '');
  if (!v) return 'vide';
  if (/^\.{1,2}$/.test(v)) return 'fait seulement de points';
  if (v.length > 80) return `de ${v.length} caractères, au-delà de 80`;
  const hors = [...v].filter((c) => !alphabet.test(c));
  const signes = [...new Set(hors.filter((c) => /[\x20-\x7e]/.test(c)))]
    .map((c) => (c === ' ' ? 'espace' : `« ${c} »`));
  return `de ${v.length} caractère(s), dont ${hors.length} hors de l'alphabet attendu`
    + (signes.length ? ` (${signes.join(', ')})` : '');
}

/**
 * Une adresse d'API dite SOUS SA FORME, pour le journal : l'hôte s'il est
 * celui de la facturation, le chemin dont chaque segment inconnu devient « … »,
 * le nom de chaque paramètre (inconnu : « … »), jamais sa valeur — sauf
 * `lang=fr`. Pure.
 */
function formeAdresseApi(adresse) {
  let u;
  try {
    u = new URL(String(adresse));
  } catch {
    return 'adresse illisible';
  }
  const connus = new Set(['billing', 'api', 'v5', 'invoices', 'pdf']);
  const chemin = u.pathname.split('/').map((s) => (!s || connus.has(s) ? s : '…')).join('/');
  const parametres = [...u.searchParams.entries()].map(([cle, valeur]) => {
    const nom = ['lang', 'invoice_num', 'sharing_id'].includes(cle) ? cle : '…';
    return `${nom}=${nom === 'lang' && valeur === LANGUE_PDF ? valeur : '…'}`;
  });
  const hote = u.hostname === HOTE_ADMIN ? `${u.protocol}//${u.hostname}` : '[autre hôte]';
  return `${hote}${chemin}${parametres.length ? `?${parametres.join('&')}` : ''}${u.hash ? '#…' : ''}`;
}

/**
 * La SEULE fonction qui construit l'adresse d'où se demande le PDF d'une
 * facture (lot 95), depuis un lien « PDF » que `factureDepuisAdresse`
 * accepte : ses trois segments deviennent le chemin et deux des trois
 * paramètres, tels quels — l'alphabet exigé n'a jamais besoin d'échappement.
 * Un lien qui n'en est pas un, ou dont un segment surprend : rien n'est
 * construit, et la raison dit la forme de l'écart. Pure, testée.
 *
 * @returns {{ok: true, adresse: string, organisation: string, interne: string, numero: string}
 *   | {ok: false, raison: string}}
 */
function adresseApiDuPdf(lien, base = URL_FACTURATION) {
  const f = factureDepuisAdresse(lien, base);
  if (!f) return { ok: false, raison: 'le lien n\'a pas la forme d\'un lien « PDF » de facture' };
  const ecarts = [
    ['organisation', f.organisation, SEGMENT_ORGANISATION, ALPHABET_ORGANISATION],
    ['interne', f.interne, SEGMENT_API, ALPHABET_API],
    ['numéro', f.numero, SEGMENT_API, ALPHABET_API],
  ].filter(([, valeur, motif]) => !motif.test(valeur))
    .map(([nom, valeur, , alphabet]) => `segment « ${nom} » ${formeDuSegment(valeur, alphabet)}`);
  if (ecarts.length) return { ok: false, raison: `le lien surprend : ${ecarts.join(', ')}` };
  return {
    ok: true,
    adresse: `https://${HOTE_ADMIN}${CHEMIN_API_PDF}/${f.interne}/pdf`
      + `?lang=${LANGUE_PDF}&invoice_num=${f.numero}&sharing_id=${f.organisation}`,
    organisation: f.organisation,
    interne: f.interne,
    numero: f.numero,
  };
}

/**
 * Revérifie, JUSTE AVANT la demande, l'adresse d'API d'une facture : le motif
 * exact, puis ses trois valeurs égales aux trois segments du lien de CETTE
 * facture. Au moindre écart, rien n'est demandé. Pure, testée.
 *
 * @param {string} adresse
 * @param {{organisation: string, interne: string, numero: string}} lien
 * @returns {{ok: true} | {ok: false, raison: string}}
 */
function verifierAdresseApi(adresse, lien) {
  const m = MOTIF_ADRESSE_API.exec(String(adresse ?? ''));
  if (!m) return { ok: false, raison: `adresse d'API hors du motif attendu (${formeAdresseApi(adresse)})` };
  if (m[1] !== lien?.interne || m[2] !== lien?.numero || m[3] !== lien?.organisation) {
    return { ok: false, raison: 'adresse d\'API dont les paramètres ne sont pas les segments du lien de cette facture' };
  }
  return { ok: true };
}

/**
 * Les pages SUIVANTES annoncées par la pagination d'une liste : les liens
 * `?page=N` (N ≥ 2) de la MÊME liste, réécrits en `?page=N` seul — un autre
 * paramètre (un filtre, une période) n'est jamais suivi. Ordonnées.
 */
function pagesSuivantes(hrefs, adresseListe) {
  const liste = surAdmin(adresseListe);
  if (!liste) return [];
  const chemin = liste.pathname.replace(/\/$/, '');
  const trouvees = new Map();
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    const u = surAdmin(href, adresseListe);
    if (!u || u.pathname.replace(/\/$/, '') !== chemin) continue;
    const n = Number.parseInt(u.searchParams.get('page'), 10);
    if (!Number.isFinite(n) || n < 2 || n > 10_000) continue;
    if (!trouvees.has(n)) trouvees.set(n, `${liste.origin}${chemin}?page=${n}`);
  }
  return [...trouvees.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url);
}

/**
 * La page affichée EST-elle la liste des organisations, quelle que soit son
 * adresse ? Il y faut des liens d'organisation ET l'un des deux signes de la
 * page enregistrée : son titre « Choisir une organisation », ou son titre
 * principal « Facturation ». Des liens seuls ne suffisent pas : la page d'une
 * organisation en porte un vers elle-même (« Vue générale »). Pure, testée.
 *
 * @param {{titreListe?: boolean, h1Facturation?: boolean}|null} page
 * @param {number} organisations les liens d'organisation lus
 * @returns {string[]|null} les signes trouvés, ou `null` si ce n'est pas la liste
 */
function signesDeLaListe(page, organisations) {
  if (!page || !(organisations > 0)) return null;
  const signes = [
    ...(page.titreListe ? ['titre « Choisir une organisation »'] : []),
    ...(page.h1Facturation ? ['titre principal « Facturation »'] : []),
  ];
  if (!signes.length) return null;
  return [...signes, `${organisations} lien(s) d'organisation`];
}

/**
 * Où le navigateur est-il ARRIVÉ ? Jugé sur l'adresse finale, stabilisée : un
 * détour par l'autorisation de Gandi ID qui revient sur la facturation est un
 * succès (la session de facturation se rouvre ainsi d'elle-même).
 *
 * Lot 94 : la liste est reconnue à ses deux adresses (`CHEMINS_LISTE`) ; et à
 * une adresse inattendue sous `/billing/`, c'est la PAGE qui tranche — si elle
 * est la liste (`signesDeLaListe`), elle est lue, et l'écart est dit
 * (`ecart: true`). Une vraie page inconnue reste « page illisible ».
 *
 * @param {{urlFinale: string, organisations?: number,
 *   page?: {titreListe?: boolean, h1Facturation?: boolean}|null}} arrivee
 * @returns {{verdict: 'liste'|'organisation-unique'|'connexion-demandee'|'page-illisible',
 *   raison: string, organisation?: string, ecart?: boolean}}
 */
function jugerArrivee({ urlFinale, organisations = 0, page = null }) {
  let u;
  try {
    u = new URL(String(urlFinale));
  } catch {
    return { verdict: 'page-illisible', raison: 'adresse finale illisible' };
  }
  if (u.hostname === HOTE_ID) {
    return { verdict: 'connexion-demandee', raison: `renvoyé vers ${u.hostname}${u.pathname}` };
  }
  if (u.hostname !== HOTE_ADMIN) {
    return { verdict: 'page-illisible', raison: `arrivé sur ${u.hostname}, hors de la facturation de Gandi` };
  }
  if (/^\/billing\/api\//.test(u.pathname)) {
    return { verdict: 'connexion-demandee', raison: 'arrêté dans le passage de connexion de la facturation' };
  }
  if (CHEMINS_LISTE.some((motif) => motif.test(u.pathname))) {
    return organisations > 0
      ? { verdict: 'liste', raison: `${organisations} organisation(s) affichée(s)` }
      : { verdict: 'page-illisible', raison: 'la page « Facturation » ne montre aucune organisation reconnaissable' };
  }
  const organisation = organisationDepuisAdresse(u.href);
  if (organisation) {
    return { verdict: 'organisation-unique', raison: 'la facturation s\'est ouverte directement sur une organisation', organisation };
  }
  const signes = /^\/billing\//.test(u.pathname) ? signesDeLaListe(page, organisations) : null;
  if (signes) {
    return {
      verdict: 'liste',
      ecart: true,
      raison: `écart : adresse inattendue ${masquer(u.pathname)}, mais la page est la liste des organisations `
        + `(${signes.join(', ')}) — lue quand même`,
    };
  }
  return { verdict: 'page-illisible', raison: `arrivé sur ${masquer(u.pathname)}, qui n'est pas la facturation` };
}

/**
 * La page des factures ressemble-t-elle à celle du code source (§2.2) ?
 * L'onglet « Factures » marqué courant, ou le titre de la facturation, ET un
 * tableau dont l'en-tête porte « Numéro de facture » et « Date » — ou aucun
 * tableau du tout (une organisation sans facture : forme non mesurée, on ne
 * conclut « 0 » que sur la bonne page). Un AUTRE tableau : illisible.
 */
function jugerPageFactures(vue) {
  const bonnePage = !!vue?.ongletFactures || /facturation\s*-\s*gandi\.net\s*$/i.test(String(vue?.titre || ''));
  if (!bonnePage) return { reconnue: false, raison: 'ni l\'onglet « Factures » ni le titre de la facturation' };
  if (vue.tableau) return { reconnue: true, raison: 'tableau des factures reconnu' };
  if (vue.autresTableaux) return { reconnue: false, raison: `un tableau inattendu (${(vue.entetes || []).join(' / ').slice(0, 120)})` };
  return { reconnue: true, raison: 'aucun tableau de factures : l\'organisation n\'en a pas' };
}

/** L'ancre d'une facture : l'organisation et le numéro lus dans son lien. */
function remoteIdFacture(organisation, numero) {
  return `${ID}-${organisation}-${numero}`;
}

/**
 * Les noms de fichier d'un passage : `gandi_AAAA-MM_<numéro>.pdf`, et jamais
 * deux fois le même — un numéro répété (deux organisations, deux documents)
 * reçoit un suffixe. Pure, testée.
 */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: `${ID}-${d.numero}` });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

/** Le libellé d'une organisation dont la page ne montre aucun nom. */
const LIBELLE_SANS_NOM = 'Organisation sans nom';

/** Une organisation, traduite en élément de la fiche. Toutes cochées d'office. */
function enElementDecouvert(organisation) {
  return {
    id: organisation.id,
    label: String(organisation.nom || '').trim() || LIBELLE_SANS_NOM,
    detail: organisation.moi ? 'Votre organisation personnelle' : '',
    preselected: true,
  };
}

/**
 * Le NOM d'une organisation, tel que la découverte l'a gardé — ou '' quand
 * elle n'en a pas (lot 98). En l'exportant, ce connecteur demande au socle de
 * ranger chaque organisation dans un dossier à son nom
 * (`dossier-par-nom.js`) ; « Organisation sans nom » n'est pas un nom : c'est
 * le libellé de son absence, et le dossier garde alors l'identifiant. Pure.
 */
function nomDuCompte(element) {
  const libelle = String(element?.label ?? '').trim();
  if (!libelle || libelle === String(element?.id ?? '') || libelle === LIBELLE_SANS_NOM) return '';
  return libelle;
}

/** Le texte d'un grief pour le journal : chiffres masqués, borné. */
function pourLeJournal(texte, longueur = 100) {
  return String(texte || '').replace(/\s+/g, ' ').trim().replace(/\d/g, '#').slice(0, longueur);
}

/**
 * Le grief d'un document refusé par le socle, pour le journal : espaces
 * réduits, borné — et ses chiffres GARDÉS (lot 95). Ce sont des tailles
 * (« a rendu 84014 octets… », et le constat du socle) : masqués par
 * `pourLeJournal`, ils faisaient les « ##### » du passage n° 708, quand la
 * ligne d'arrêt, écrite par le socle, les montrait en clair. Les griefs du
 * socle ne portent jamais d'adresse, et ses propres erreurs de page y sont
 * déjà masquées (`onglet-pdf`).
 */
function griefPourLeJournal(grief, longueur = 400) {
  return String(grief || '').replace(/\s+/g, ' ').trim().slice(0, longueur);
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures (R11).
 * Pure, testée. Des nombres, jamais un nom d'organisation.
 */
function precisionDuPassage(b, { sansCompte = false, sansTiret = false } = {}) {
  // Le compte principal s'accroche au message du planificateur (« 3 factures
  // récupérées ») par un tiret, comme les autres précisions ; sans lui, les
  // phrases suivent une phrase déjà close.
  //
  // `sansTiret` (lot 94, R5) : quand le message du planificateur finit DÉJÀ
  // sa phrase — « … 1 non obtenue — le prochain passage les réessaiera. », un
  // échec complet, une phrase « hors période » —, le tiret doublait la
  // ponctuation (« … réessaiera. — Gandi : … ») : le compte ouvre alors une
  // phrase neuve.
  const phrases = sansCompte ? [] : [
    `${sansTiret ? '' : '— '}${NOM} : ${pluriel(b.organisationsLues, 'organisation lue', 'organisations lues')}, `
      + `${pluriel(b.facturesVues, 'facture vue', 'factures vues')}.`,
  ];
  if (b.sansFacture && !sansCompte) {
    phrases.push(`${b.sansFacture > 1 ? `${b.sansFacture} organisations n'ont` : 'Une organisation n\'a'} aucune facture.`);
  }
  if (b.nouvellesRetenues) {
    phrases.push(`${b.nouvellesRetenues > 1 ? `${b.nouvellesRetenues} organisations sont apparues` : 'Une organisation est apparue'} `
      + 'sur votre compte depuis la dernière récupération : elle est lue avec les autres, comme toutes vos organisations.');
  }
  if (b.nouvellesIgnorees) {
    phrases.push(`${b.nouvellesIgnorees > 1 ? `${b.nouvellesIgnorees} organisations sont apparues` : 'Une organisation est apparue'} `
      + 'sur votre compte : comme vous avez choisi vos organisations une par une, elle n\'est pas récupérée. '
      + 'Cochez-la dans la fiche de Gandi si vous voulez ses factures.');
  }
  if (b.disparues) {
    phrases.push(`${b.disparues > 1 ? `${b.disparues} organisations que vous aviez cochées n'apparaissent` : 'Une organisation que vous aviez cochée n\'apparaît'} `
      + 'plus sur votre compte Gandi : elle est ignorée, les autres ont été lues. Si c\'est voulu, '
      + 'enregistrez de nouveau votre choix dans la fiche de Gandi.');
  }
  if (b.illisibles) {
    phrases.push(`La page des factures de ${pluriel(b.illisibles, 'organisation', 'organisations')} n'a pas pu être lue : `
      + 'elle ne ressemble plus à celle que crabe connaît. Les autres ont été lues ; signalez-le pour que la lecture soit mise à jour.');
  }
  if (b.bornePages) {
    phrases.push(`La lecture s'est arrêtée à ${PAGES_MAX} pages de factures pour ${pluriel(b.bornePages, 'organisation', 'organisations')} : `
      + 'signalez-le, la limite de crabe est trop basse pour ce compte.');
  }
  if (b.interruption === 'temps') {
    // Le compte des factures en attente n'est dit que s'il est CONNU : coupée
    // pendant la lecture des pages, la récupération ne sait pas ce qui reste.
    const reste = b.restantes && !b.lectureInterrompue
      ? (b.restantes > 1
        ? `${b.restantes} factures attendent encore ; elles viendront au prochain passage.`
        : '1 facture attend encore ; elle viendra au prochain passage.')
      : 'la suite viendra au prochain passage.';
    phrases.push(`La récupération a pris tout le temps permis : ${reste} Rien de ce qui a été pris n'est perdu.`);
  }
  if (b.interruption === 'session') {
    phrases.push('La lecture s\'est interrompue — Gandi a demandé de vous reconnecter : les factures déjà prises sont gardées. '
      + 'Reconnectez-vous depuis la fiche de Gandi pour récupérer la suite.');
  }
  return phrases.join(' ');
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans les pages — des lectures, jamais un geste
// ---------------------------------------------------------------------------

/** La liste des organisations : identifiant, nom, « Moi ». */
const LIRE_LES_ORGANISATIONS = ({ hote, motifTitre }) => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const titreListe = new RegExp(motifTitre, 'i');
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const parId = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    let u;
    try {
      u = new URL(a.getAttribute('href'), location.href);
    } catch {
      continue;
    }
    if (u.hostname !== hote) continue;
    const m = /^\/billing\/([A-Za-z0-9_-]{1,80})\/overview\/?$/.exec(u.pathname);
    if (!m || m[1] === 'api') continue;
    const entree = parId.get(m[1]) || { id: m[1], nom: '', moi: false };
    // Le nom : le texte du lien, sans l'étiquette « Moi » si elle y est logée.
    const copie = a.cloneNode(true);
    for (const e of [...copie.querySelectorAll('*')]) {
      if (/^moi$/i.test(norm(e.textContent))) e.remove();
    }
    const texte = norm(copie.textContent);
    if (texte && !/^voir$/i.test(texte) && !entree.nom) entree.nom = texte.slice(0, 120);
    const li = a.closest('li');
    if (li && [...li.querySelectorAll('*')].some((e) => !e.children.length && /^moi$/i.test(norm(e.textContent)))) {
      entree.moi = true;
    }
    parId.set(m[1], entree);
  }
  return {
    titre: document.title,
    // Les deux signes de la page enregistrée, pour juger une adresse
    // inattendue (lot 94) : jamais journalisés tels quels.
    titreListe: titreListe.test(document.title || ''),
    h1Facturation: [...document.querySelectorAll('h1')].some((h) => visible(h) && /^facturation$/i.test(norm(h.innerText))),
    organisations: [...parId.values()],
  };
};

/** Une page de factures : sa forme, ses lignes (liens et date), sa pagination. */
const LIRE_LES_FACTURES = () => {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const nav = [...document.querySelectorAll('nav')]
    .find((n) => /onglets/i.test(n.getAttribute('aria-label') || ''));
  const ongletFactures = !!nav && [...nav.querySelectorAll('a[href]')].some((a) => {
    try {
      return /\/invoices\/?$/.test(new URL(a.getAttribute('href'), location.href).pathname)
        && a.getAttribute('aria-current') === 'page';
    } catch {
      return false;
    }
  });
  let tableau = null;
  let iDate = -1;
  let entetes = [];
  let autresTableaux = 0;
  for (const t of document.querySelectorAll('table')) {
    const ths = [...t.querySelectorAll('thead th')].map((th) => norm(th.innerText).toLowerCase());
    const iNumero = ths.findIndex((x) => /num[ée]ro de facture/.test(x));
    const d = ths.findIndex((x) => x === 'date');
    if (iNumero >= 0 && d >= 0) {
      tableau = t;
      iDate = d;
      entetes = ths;
      break;
    }
    autresTableaux++;
    if (!entetes.length) entetes = ths;
  }
  const lignes = tableau
    ? [...tableau.querySelectorAll('tbody tr')].map((tr) => {
      const cellules = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      return {
        liens: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
        dateTexte: cellules[iDate] ? norm(cellules[iDate].innerText) : '',
      };
    })
    : [];
  return {
    url: location.href,
    titre: document.title,
    ongletFactures,
    tableau: !!tableau,
    autresTableaux: tableau ? 0 : autresTableaux,
    entetes,
    lignes,
    pagination: [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => /[?&]page=\d+/.test(h)),
  };
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Une navigation, puis l'attente — bornée — que la page se pose. */
async function naviguer(page, adresse) {
  await page.goto(adresse, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: DELAI_REPOS_MS }).catch(() => {});
}

/**
 * Le lancement du navigateur, seul point remplaçable : les essais y branchent
 * un faux site (pages reconstituées, réseau coupé) et éprouvent tout le
 * reste — contrôle de la session, contexte, journal de navigation — tel quel.
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  /** L'horloge du budget de temps — remplaçable aussi, pour l'éprouver sans attendre. */
  maintenant: () => Date.now(),
};

/**
 * Ouvre un navigateur sur la connexion enregistrée. Le journal de navigation
 * (socle du lot 87 : chemins et noms de cookies, jamais une valeur) suit
 * chaque passage, réussi ou non.
 */
async function surLeCompte(config, ctx, fn) {
  const log = ctx?.log || (() => {});
  const session = lireSession(config);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    navigation.brancher(page, { log: (ligne) => log(masquer(ligne)), prefixe: `${ID} : navigation` });
    return await fn(page, context);
  } finally {
    if (context) {
      try {
        log(`${ID} : ${navigation.formaterDifference(
          navigation.differenceEtats(cookiesCapture, await context.cookies())
        )}`);
      } catch {
        /* navigateur déjà tombé : pas de différence à dire */
      }
    }
    await browser.close().catch(() => {});
  }
}

/**
 * Rejoint la facturation et JUGE l'arrivée. Rend les organisations lues, ou
 * lève : renvoi vers la connexion (classé par le lot 91), page illisible.
 */
async function arriverSurLaFacturation(page, log) {
  await naviguer(page, URL_FACTURATION);
  const vue = await page.evaluate(LIRE_LES_ORGANISATIONS, { hote: HOTE_ADMIN, motifTitre: TITRE_LISTE.source })
    .catch(() => ({ titre: '', titreListe: false, h1Facturation: false, organisations: [] }));
  const jugement = jugerArrivee({ urlFinale: page.url(), organisations: vue.organisations.length, page: vue });
  log(`${ID} : arrivée jugée « ${jugement.verdict} » — ${jugement.raison}.`);
  if (jugement.verdict === 'connexion-demandee') {
    throw profilMarchand.erreurRenvoiVersAuthentification(NOM, jugement.raison);
  }
  if (jugement.verdict === 'organisation-unique') {
    // Non mesuré : un compte d'une seule organisation pourrait être conduit
    // droit sur elle. Son identifiant est dans l'adresse ; son nom, inconnu.
    return { organisations: [{ id: jugement.organisation, nom: '', moi: false }] };
  }
  if (jugement.verdict !== 'liste') throw erreurPageIllisible(jugement.raison);
  return { organisations: vue.organisations };
}

function erreurPageIllisible(detail) {
  const err = new Error(
    `${NOM} a bien ouvert votre facturation, mais crabe n'a pas su la lire : la page ne ressemble `
      + 'plus à celle qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la rouvrir. '
      + 'Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération réessaiera '
      + 'd\'elle-même.'
  );
  err.precision = detail;
  return err;
}

/** La session est-elle tombée ? Se vérifie par la page de liste, une fois. */
async function sessionTombee(page, adresseListe) {
  await naviguer(page, adresseListe);
  return jugerArrivee({ urlFinale: page.url(), organisations: 1 }).verdict === 'connexion-demandee';
}

/**
 * Le choix des organisations : par le socle (`ctx.reconcile`, qui mémorise et
 * applique « toutes » ou le choix précis), sinon — hors planificateur — par la
 * configuration telle quelle, et à défaut toutes.
 */
function choisir(ctx, config, organisations) {
  const elements = organisations.map(enElementDecouvert);
  if (typeof ctx.reconcile === 'function') {
    const r = ctx.reconcile(CHAMP_ORGANISATIONS, elements);
    const actives = new Set((r.active || []).map((i) => i.id));
    return {
      retenues: organisations.filter((o) => actives.has(o.id)),
      mode: r.mode || (Array.isArray(r.selection) ? 'choix' : 'toutes'),
      nouvellesRetenues: (r.added || []).length,
      nouvellesIgnorees: (r.ignored || []).length,
      disparues: (r.missing || []).length,
    };
  }
  const choix = Array.isArray(config?.[CHAMP_ORGANISATIONS]) ? config[CHAMP_ORGANISATIONS] : null;
  return {
    retenues: choix ? organisations.filter((o) => choix.includes(o.id)) : organisations,
    mode: choix ? 'choix' : 'toutes',
    nouvellesRetenues: 0,
    nouvellesIgnorees: 0,
    disparues: choix ? choix.filter((id) => !organisations.some((o) => o.id === id)).length : 0,
  };
}

/**
 * La fenêtre d'historique de Gandi : le réglage de l'utilisateur, sauf
 * « Depuis la dernière récupération », qui prend tout ce qui n'est pas encore
 * dans l'archive — dans la limite de la conservation (voir l'en-tête).
 */
function fenetre(config, ctx) {
  const plan = scraping.planHistorique(config, ctx);
  if (!plan || plan.mode !== 'depuis') return plan;
  const tout = history.fenetreDeDates({ valeur: 'tout', plafondMois: ctx?.conservationMois || 0 });
  return {
    ...tout,
    mode: 'depuis',
    raison: `toutes les factures pas encore dans l'archive${tout.plafonne ? ', dans la limite de votre réglage de conservation' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la facturation s'ouvre, les organisations se lisent. */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    const { organisations } = await arriverSurLaFacturation(page, log);
    return {
      ok: true,
      accountId: (organisations.find((o) => o.moi) || organisations[0])?.id || null,
      message: `Connexion valide — ${pluriel(organisations.length, 'organisation visible', 'organisations visibles')} `
        + `dans votre facturation ${NOM}. Leurs factures seront lues à la prochaine récupération.`,
    };
  });
}

/** Découverte : les organisations du compte, pour la fiche (R9). */
async function discover(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeCompte(config, ctx, async (page) => {
    const { organisations } = await arriverSurLaFacturation(page, log);
    log(`${ID} : ${organisations.length} organisation(s) découverte(s).`);
    return { items: organisations.map(enElementDecouvert) };
  });
}

/**
 * Les factures de chaque organisation retenue, en deux temps : LIRE toutes
 * les pages de factures (quelques navigations), puis PRENDRE chaque PDF
 * manquant dans l'onglet. Ce qui est pris est GARDÉ quoi qu'il arrive
 * ensuite — session tombée en route, temps écoulé (R11).
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const { organisations } = await arriverSurLaFacturation(page, log);
    const choix = choisir(ctx, config, organisations);
    log(`${ID} : ${choix.retenues.length} organisation(s) retenue(s) sur ${organisations.length} `
      + `(${choix.mode === 'toutes' ? 'toutes sont choisies' : 'choix précis'}).`);

    const bilan = {
      organisationsLues: 0,
      facturesVues: 0,
      sansFacture: 0,
      illisibles: 0,
      bornePages: 0,
      horsPeriode: 0,
      restantes: 0,
      interruption: null,
      lectureInterrompue: false,
      nouvellesRetenues: choix.nouvellesRetenues,
      nouvellesIgnorees: choix.nouvellesIgnorees,
      disparues: choix.disparues,
    };
    let toutLu = true;

    // ── 1. Lire : chaque page de factures de chaque organisation retenue ──
    const aPrendre = [];
    lecture: for (const [rangOrg, org] of choix.retenues.entries()) {
      const etiquette = `organisation ${rangOrg + 1}/${choix.retenues.length}`;
      const aVisiter = [adresseFactures(org.id)];
      const visitees = [];
      let vuesIci = 0;
      let lue = false;

      while (aVisiter.length) {
        if (visitees.length >= PAGES_MAX) {
          bilan.bornePages++;
          toutLu = false;
          log(`${ID} : ${etiquette} — arrêt à ${PAGES_MAX} pages, ${aVisiter.length} page(s) non visitée(s).`);
          break;
        }
        if (ouverture.maintenant() > echeance) {
          bilan.interruption = 'temps';
          bilan.lectureInterrompue = true;
          toutLu = false;
          break lecture;
        }
        const adresse = aVisiter.shift();
        visitees.push(adresse);
        await naviguer(page, adresse);

        const arrivee = jugerArrivee({ urlFinale: page.url(), organisations: 1 });
        if (arrivee.verdict === 'connexion-demandee') {
          // Rien n'est encore pris : c'est un renvoi, classé par le lot 91.
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, `${arrivee.raison}, en lisant les factures`);
        }
        const vue = await page.evaluate(LIRE_LES_FACTURES).catch(() => null);
        const forme = jugerPageFactures(vue);
        if (!vue || !forme.reconnue || organisationDepuisAdresse(page.url()) !== org.id) {
          bilan.illisibles++;
          toutLu = false;
          log(`${ID} : ${etiquette} — page de factures illisible (${forme.raison}) : organisation non lue.`);
          break;
        }
        lue = true;

        let sansLien = 0;
        for (const ligne of vue.lignes) {
          const lien = ligne.liens.map((h) => factureDepuisAdresse(h, vue.url)).find((f) => f && f.organisation === org.id);
          if (!lien) {
            sansLien++;
            continue;
          }
          vuesIci++;
          const remoteId = remoteIdFacture(org.id, lien.numero);
          if (connus.has(remoteId) || aPrendre.some((d) => d.remoteId === remoteId)) continue;
          const issuedOn = pageDocs.dateDepuisTexte(ligne.dateTexte);
          if (!scraping.dansLaFenetre(issuedOn, plan)) {
            bilan.horsPeriode++;
            continue;
          }
          aPrendre.push({
            remoteId, numero: lien.numero, interne: lien.interne, issuedOn, adresse: lien.adresse, organisation: org.id, liste: adresse,
          });
        }
        if (sansLien) log(`${ID} : ${etiquette} — ${sansLien} ligne(s) sans lien de PDF reconnu, non prise(s).`);

        for (const suivante of pagesSuivantes(vue.pagination, vue.url)) {
          if (!visitees.includes(suivante) && !aVisiter.includes(suivante)) aVisiter.push(suivante);
        }
      }

      if (lue) {
        bilan.organisationsLues++;
        bilan.facturesVues += vuesIci;
        if (!vuesIci) bilan.sansFacture++;
        log(`${ID} : ${etiquette} — ${vuesIci} facture(s) vue(s) sur ${visitees.length} page(s).`);
      }
    }

    if (choix.retenues.length && !bilan.organisationsLues && bilan.illisibles) {
      throw erreurPageIllisible(`${bilan.illisibles} page(s) de factures illisible(s)`);
    }

    // La preuve exigée par le socle (lot 31) : la facturation a été LUE.
    ctx.preuveDeListe?.({
      session: `facturation ${NOM} servie au compte connecté (${organisations.length} organisation(s) listée(s))`,
      liste: URL_FACTURATION,
      elements: bilan.facturesVues,
    });

    // ── 2. Prendre : chaque PDF manquant, à l'API de facturation ──────────
    //
    // Lot 95 : le lien « PDF » n'est pas le PDF (voir l'en-tête). L'adresse
    // d'API se construit depuis le lien, se revérifie juste avant la demande,
    // et la demande part de la page où l'on est, par le `fetch` du navigateur
    // — aucune navigation, aucun onglet, aucun en-tête ajouté.
    const invoices = [];
    let manquees = 0;
    let renoncement = null;
    const serie = serieEchecs.suiteDEchecs();
    let tentees = 0;
    for (const doc of aPrendre) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      tentees++;
      const api = adresseApiDuPdf(doc.adresse);
      const controle = api.ok ? verifierAdresseApi(api.adresse, doc) : api;
      if (!controle.ok) {
        // Rien n'est demandé : ni requête, ni contrôle de session.
        manquees++;
        const grief = `n'a pas été demandée — ${controle.raison}`;
        log(`${ID} : une facture n'a pas pu être prise : elle ${grief}.`);
        if (serie.echec(grief)) {
          renoncement = serie.phrasePublique();
          log(`${ID} : ${serie.raison()}`);
          break;
        }
        continue;
      }
      const lu = await ongletPdf.fluxDeLaPage(page, api.adresse);
      if (lu.ok) {
        serie.reussite();
        invoices.push({ ...doc, buffer: lu.buffer });
        continue;
      }
      manquees++;
      log(`${ID} : une facture n'a pas pu être prise : le document ${griefPourLeJournal(lu.grief)}.`);
      // Un refus peut être une session tombée : on le vérifie par la page, une fois.
      if (await sessionTombee(page, doc.liste)) {
        manquees--;
        tentees--;
        if (!invoices.length) {
          throw profilMarchand.erreurRenvoiVersAuthentification(NOM, 'renvoyé vers la connexion en prenant une facture');
        }
        bilan.interruption = 'session';
        log(`${ID} : renvoyé vers la connexion en prenant les factures : les ${invoices.length} déjà prise(s) sont gardées.`);
        break;
      }
      if (serie.echec(lu.grief)) {
        renoncement = serie.phrasePublique();
        log(`${ID} : ${serie.raison()}`);
        break;
      }
    }
    bilan.restantes = aPrendre.length - tentees;
    // R4 (lot 95) — un arrêt avant la fin sur un refus (la sortie anticipée,
    // ou la session tombée en route) laisse des factures qui n'ont plus été
    // demandées : elles comptent comme non obtenues, sinon l'écran dirait
    // « 3 vous étaient proposés » quand 168 l'étaient (passage n° 708). Le
    // temps écoulé ne change pas (lot 93) : ce qui attend encore n'est pas
    // manqué, la précision le dit.
    const nonDemandees = renoncement || bilan.interruption === 'session' ? bilan.restantes : 0;
    const nonObtenues = manquees + nonDemandees;
    if (bilan.interruption || renoncement) toutLu = false;

    const noms = nommer(invoices);
    const sortie = {
      accountId: (organisations.find((o) => o.moi) || organisations[0])?.id || null,
      invoices: invoices.map((f, i) => ({
        remoteId: f.remoteId,
        filename: noms[i],
        issuedOn: f.issuedOn,
        // Le dossier de l'ORGANISATION : sans cette ligne, toutes les factures
        // du compte tomberaient au même endroit (lot 25, Infomaniak).
        accountId: f.organisation,
        buffer: f.buffer,
      })),
      couverture: {
        complete: toutLu && !nonObtenues,
        detail: `${pluriel(bilan.organisationsLues, 'organisation', 'organisations')}, toutes leurs pages de factures`,
      },
    };
    if (nonObtenues) {
      sortie.manquees = nonObtenues;
      if (renoncement) sortie.renoncement = renoncement;
    }
    if (!choix.retenues.length) {
      sortie.aucunDocument = 'Aucune organisation n\'est cochée dans la fiche de Gandi : crabe n\'a rien récupéré. '
        + 'Cochez celles dont vous voulez les factures, ou « Toutes mes organisations ».';
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else if (!bilan.facturesVues && bilan.organisationsLues) {
      sortie.aucunDocument = `Votre compte ${NOM} a bien été lu : `
        + `${pluriel(bilan.organisationsLues, 'organisation', 'organisations')}, aucune facture pour l'instant.`;
      const reste = precisionDuPassage(bilan, { sansCompte: true });
      if (reste) sortie.precision = reste;
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      // Une manquée (partielle ou complète) ou une phrase « hors période » :
      // le message du planificateur finit sa phrase avant la précision (R5).
      sortie.precision = precisionDuPassage(bilan, { sansTiret: nonObtenues > 0 || !!sortie.horsPeriode });
    }
    log(`${ID} : bilan — ${bilan.organisationsLues} organisation(s) lue(s), ${bilan.facturesVues} facture(s) vue(s), `
      + `${invoices.length} prise(s), ${manquees} manquée(s), ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${nonDemandees ? ` — arrêt avant la fin : ces ${nonDemandees} non demandée(s) comptent comme non obtenues, `
        + `${nonObtenues} au total` : ''}.`);

    // L'état de session d'un passage qui a lu la facturation remplace la
    // capture (lot 87) : la session de facturation, rouverte par Gandi ID, y
    // est. Jamais après un renvoi vers la connexion.
    if (bilan.interruption !== 'session') {
      try {
        sortie.sessionRenouvelee = JSON.stringify(await context.storageState());
      } catch (err) {
        log(`${ID} : l'état de session n'a pas pu être relu en fin de passage (${pourLeJournal(err.message)}).`);
      }
    }
    return sortie;
  });
}

module.exports = {
  test,
  discover,
  fetchInvoices,
  // Lot 98 : le nom d'une organisation nomme son dossier sur les stockages.
  nomDuCompte,
  LIBELLE_SANS_NOM,
  // exportés pour les tests unitaires
  lireSession,
  organisationDepuisAdresse,
  adresseFactures,
  factureDepuisAdresse,
  adresseApiDuPdf,
  verifierAdresseApi,
  formeAdresseApi,
  formeDuSegment,
  griefPourLeJournal,
  pagesSuivantes,
  jugerArrivee,
  signesDeLaListe,
  jugerPageFactures,
  remoteIdFacture,
  masquer,
  nommer,
  enElementDecouvert,
  precisionDuPassage,
  choisir,
  fenetre,
  budgetMs,
  LIRE_LES_ORGANISATIONS,
  LIRE_LES_FACTURES,
  URL_FACTURATION,
  CHEMIN_API_PDF,
  LANGUE_PDF,
  MOTIF_ADRESSE_API,
  SEGMENT_API,
  SEGMENT_ORGANISATION,
  CHEMINS_LISTE,
  TITRE_LISTE,
  HOTE_ADMIN,
  HOTE_ID,
  PAGES_MAX,
  LIMITE_EXECUTION_DEFAUT_MS,
  PART_DU_TEMPS,
  CHAMP_ORGANISATIONS,
  ouverture,
};
