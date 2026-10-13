'use strict';

/**
 * Connecteur TotalEnergies — les factures d'électricité et de gaz de « Mon
 * historique de factures », lues dans la page et téléchargées SANS UN SEUL
 * CLIC (lot 109).
 *
 * ─── Ce que ce connecteur sait, et d'où ──────────────────────────────────────
 *
 * ANNONCÉ — une page « Mon historique de factures » enregistrée connectée par
 * un utilisateur, le 13/10/2026, dont seule la STRUCTURE a été reprise
 * (docs/reconnaissance-lot109.md), aucune valeur :
 *
 *   - l'adresse `/clients/mes-factures/mon-historique-de-factures` (adresse
 *     canonique de la page, site TYPO3), titre et `h1` « Mon historique de
 *     factures », un lien de déconnexion `…/clients/connexion?logintype=logout…` ;
 *   - deux panneaux d'onglet DÉJÀ DANS LA PAGE, l'un caché, l'autre affiché :
 *     `#js--historique-container-elec` et `#js--historique-container-gaz`
 *     (`data-energie` : `elec`, `gaz`), chacun avec sa liste
 *     (`div.js--documents-list`), sa pagination et son « Chargement » ;
 *   - un document = un `.detail-facture` : `.detail-facture__label` (le type
 *     en `strong`, puis « N° … »), `.detail-facture__date` (JJ/MM/AAAA),
 *     `.detail-facture__statut`, `.detail-facture__montant` ;
 *   - son lien `a.btn--telecharger`, sous deux formes : DANS le
 *     `.detail-facture` (`a.detail-facture__action`), ou dans le bloc replié
 *     que commande le bouton qui contient le `.detail-facture`
 *     (`button[aria-controls]` → `div.collapse#…`) — présent dans la page même
 *     replié ; adresse de même origine
 *     `…/mon-historique-de-factures?tx_demmfacture_historique[action]=telecharger&…[controller]=Historique&…[id]=<jeton>&cHash=<haché>`,
 *     et `data-trackingz-action` (« ECHEANCIER » sur les quatre documents vus).
 *
 * Les quatre documents de la page enregistrée étaient des ÉCHÉANCIERS : le
 * format d'une FACTURE n'a jamais été vu. Le code ne suppose rien de plus que
 * la structure commune : un type qui contient « facture », un lien qui n'est
 * pas marqué « ECHEANCIER », un numéro lisible après « N° ».
 *
 * NON MESURÉ : ce que sert le lien (le document est refusé s'il ne commence
 * pas par `%PDF-`) ; une liste de plus de 8 documents (`data-pagination`) —
 * la page enregistrée n'en avait que 1 et 3 par énergie et plus aucun script :
 * le connecteur lit CE QUI EST SERVI, et dit au journal combien de pages la
 * pagination annonce ; une liste dessinée par script (le connecteur attend
 * une page stable, « Chargement » caché) ; la page de connexion.
 *
 * ─── Aucun geste, et des adresses fermées, par construction ─────────────────
 *
 *   1. AUCUN clic, aucune saisie, aucune touche, aucun envoi de formulaire :
 *      ce fichier n'en contient pas (un essai le vérifie en le lisant). Les
 *      onglets d'énergie ne sont jamais touchés — en changer appelle une
 *      adresse `energieParDefaut` qui MODIFIE un réglage du compte.
 *   2. Une seule navigation : l'adresse de la page des factures.
 *   3. Une seule sorte de requête en plus : le `fetch` de la page, évalué dans
 *      elle (`onglet-pdf.fluxDeLaPage`), sur l'adresse d'un lien lu — de même
 *      origine, sur le chemin de la liste, `action=telecharger` et
 *      `controller=Historique` (`lienDeTelechargement`).
 *   4. La liste fermée `MOTS_INTERDITS` (déconnexion, `energieParDefaut`,
 *      duplicata, gestion des comptes, coordonnées bancaires, mot de passe)
 *      est recontrôlée avant CHAQUE requête du connecteur, ET posée sur le
 *      réseau du navigateur : toute requête qui en porte un — du connecteur
 *      ou de la page elle-même — est avortée avant de partir, et dite au
 *      journal.
 *
 * ─── Ce qui est pris, ce qui ne l'est pas ────────────────────────────────────
 *
 * Une FACTURE = un `.detail-facture` dont le type contient « facture » (sans
 * accent ni casse) ET dont le lien n'a pas `data-trackingz-action="ECHEANCIER"`.
 * Les échéanciers et les types inconnus sont ignorés et COMPTÉS au journal
 * par type (le type seul, jamais un numéro). Une facture sans numéro lisible,
 * sans lien unique ou au lien refusé n'est pas prise, et comptée : jamais
 * d'ancre sur le jeton ni sur le `cHash`.
 *
 * Ancre `totalenergies-<énergie>-<type>-<numéro>` ; date : celle du
 * document ; nom `totalenergies_AAAA-MM_<énergie>-<type>-<numéro>.pdf`.
 *
 * Liste atteinte et aucune facture : un succès, qui le dit (« Aucune facture
 * pour l'instant ; N échéanciers ignorés »), jamais sans la preuve de liste
 * (`ctx.preuveDeListe`). Des factures vues et aucune obtenue : un échec.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const history = require('../../history');
const pageDocs = require('../../documents-de-page');
const ongletPdf = require('../../onglet-pdf');
const navigation = require('../../releve-navigation');
const profilMarchand = require('../../profil-marchand');
const preuve = require('../../preuve-connexion');
const { suiteDEchecs } = require('../../serie-echecs');

const ID = 'totalenergies';
const NOM = 'TotalEnergies';

const HOTE = 'www.totalenergies.fr';
const ORIGINE = `https://${HOTE}`;
const CHEMIN_FACTURES = '/clients/mes-factures/mon-historique-de-factures';
const URL_FACTURES = `${ORIGINE}${CHEMIN_FACTURES}`;
/** Où le site renvoie un visiteur sans session (annoncé : la page de connexion). */
const CHEMIN_CONNEXION = '/clients/connexion';

/**
 * Les adresses que ce connecteur ne demande jamais, et que le navigateur
 * qu'il pilote ne laisse pas partir (R5) : un mot de cette liste, en
 * majuscules ou en minuscules, dans l'adresse telle quelle ou décodée.
 */
const MOTS_INTERDITS = Object.freeze([
  'logintype=logout',
  'energieParDefaut',
  'duplicata',
  'gerer-mes-comptes',
  'mes-coordonnees-bancaires',
  'modification-du-mot-de-passe',
]);

/** Les deux énergies de la page, et ce qu'elles deviennent dans une ancre et une phrase. */
const ENERGIES = Object.freeze({
  elec: Object.freeze({ ancre: 'electricite', phrase: 'électricité' }),
  gaz: Object.freeze({ ancre: 'gaz', phrase: 'gaz' }),
});

const TITRE_LISTE = 'Mon historique de factures';
const SELECTEUR_DECONNEXION = 'a[href*="logintype=logout"]';
const SELECTEUR_CONTENEURS = '[id^="js--historique-container-"]';
/** Ce que porte le lien d'un échéancier (annoncé : `data-trackingz-action`). */
const ACTION_ECHEANCIER = 'ECHEANCIER';
/** Les deux paramètres d'un lien de téléchargement (annoncés). */
const PARAM_ACTION = 'tx_demmfacture_historique[action]';
const PARAM_CONTROLEUR = 'tx_demmfacture_historique[controller]';
const PARAM_ID = 'tx_demmfacture_historique[id]';

const CHAMP_SESSION = 'session';
const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;

/**
 * L'attente de la liste. Rien n'a été mesuré de ce chargement (la page
 * enregistrée n'a plus ses scripts) : 45 s, comme une navigation ; une liste
 * doit rester la même 1,5 s avant d'être lue, 5 s si elle n'a aucun document —
 * conclure « aucune facture » sur une liste pas encore remplie serait le faux
 * « rien à récupérer » que crabe s'interdit.
 */
const DELAI_DESSIN_MS = 45_000;
const PAS_ATTENTE_MS = 500;
const STABLE_MS = 1_500;
const STABLE_VIDE_MS = 5_000;

/** La limite d'une exécution (lot 67), et la part que le connecteur s'accorde (comme l'Eau d'Île-de-France). */
const LIMITE_EXECUTION_DEFAUT_MS = 45 * 60 * 1000;
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
 * Un texte dicible au journal : dans un chemin, chaque chiffre est masqué, et
 * un segment long ou encodé est remplacé en entier. Pure.
 */
function masquer(texte) {
  return String(texte ?? '').replace(/(\/[^\s;]*)/g, (chemin) => chemin
    .split('/')
    .map((segment) => (segment.length >= 20 || segment.includes('%') ? '…' : segment.replace(/\d/g, '#')))
    .join('/'));
}

/**
 * Toute ligne que ce connecteur écrit au journal passe ici : les chemins
 * masqués, aucune requête d'adresse (le jeton et le `cHash` y vivent), aucune
 * longue suite au vocabulaire d'un encodage, aucune suite de six chiffres ou
 * plus (un numéro de document). Pure, testée.
 */
function pourLeJournal(texte) {
  return masquer(texte)
    .replace(/\?[^\s)\]»"']*/g, '?…')
    .replace(/[A-Za-z0-9%+/=_-]{24,}/g, (s) => ((/\d/.test(s) && /[A-Za-z]/.test(s)) || /%[0-9A-F]{2}/i.test(s) ? '…' : s))
    .replace(/\d{6,}/g, '…');
}

function journalDe(ctx) {
  const ecrire = ctx?.log || (() => {});
  return (ligne) => ecrire(pourLeJournal(ligne));
}

/** Une adresse, telle quelle et décodée (deux fois au plus), en minuscules. Pure. */
function formesDe(adresse) {
  const formes = [String(adresse ?? '')];
  for (let i = 0; i < 2; i++) {
    try {
      const decodee = decodeURIComponent(formes[formes.length - 1]);
      if (decodee === formes[formes.length - 1]) break;
      formes.push(decodee);
    } catch {
      break;
    }
  }
  return formes.map((f) => f.toLowerCase());
}

/**
 * Le premier mot interdit que porte une adresse, ou `null` (R5). Pure, testée
 * sur chaque mot, en clair, encodé et en majuscules.
 */
function motInterdit(adresse) {
  const formes = formesDe(adresse);
  for (const mot of MOTS_INTERDITS) {
    const cherche = mot.toLowerCase();
    if (formes.some((f) => f.includes(cherche))) return mot;
  }
  return null;
}

/**
 * Une adresse que ce connecteur peut DEMANDER : `https`, sur le site, aucun
 * mot interdit. Recontrôlée avant chaque requête. Pure.
 */
function adresseAutorisee(adresse) {
  let u;
  try {
    u = new URL(String(adresse ?? ''));
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname === HOTE && !u.username && !u.password && motInterdit(u.href) === null;
}

/**
 * L'adresse d'un lien de téléchargement lu dans la page, résolue — ou `null`.
 * Exactement : `https://www.totalenergies.fr/clients/mes-factures/mon-historique-de-factures`,
 * `action=telecharger`, `controller=Historique`, un identifiant, aucun mot
 * interdit. Le jeton et le `cHash` ne sont jamais lus pour autre chose. Pure.
 */
function lienDeTelechargement(href, base = URL_FACTURES) {
  if (typeof href !== 'string' || !href.trim()) return null;
  let u;
  try {
    u = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (!adresseAutorisee(u.href)) return null;
  if (u.pathname !== CHEMIN_FACTURES || u.hash) return null;
  if (u.searchParams.get(PARAM_ACTION) !== 'telecharger') return null;
  if (u.searchParams.get(PARAM_CONTROLEUR) !== 'Historique') return null;
  if (!u.searchParams.get(PARAM_ID)) return null;
  return u.href;
}

const normaliser = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
/** Sans accent ni casse, pour comparer un type. Pure. */
const sansAccent = (t) => normaliser(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * La nature d'un document : `facture` si son type contient « facture » ET que
 * son lien n'est pas marqué « ECHEANCIER » ; `echeancier` s'il porte l'une
 * ou l'autre marque d'un échéancier ; `inconnu` sinon. Pure, testée.
 */
function natureDuDocument({ type, action }) {
  const t = sansAccent(type);
  const marqueEcheancier = String(action ?? '').trim().toUpperCase() === ACTION_ECHEANCIER;
  if (t.includes('facture') && !marqueEcheancier) return 'facture';
  if (marqueEcheancier || t.includes('echeancier')) return 'echeancier';
  return 'inconnu';
}

/**
 * Le numéro de la ligne « N° … » d'un document, ou `null`. La ligne ENTIÈRE
 * après « N° » doit être un numéro — des lettres, des chiffres, des tirets
 * (pas au bord), au moins un chiffre, 3 à 30 signes, les espaces retirés :
 * un numéro lu à moitié ferait une ancre fausse, alors rien plutôt qu'un
 * morceau. « N° ----- », « N° xxx » ou « N° » seul ne sont pas un numéro.
 * Pure, testée.
 */
function numeroDuLibelle(ligne) {
  const lu = /^N\s*[°º]\s*(.*)$/i.exec(normaliser(ligne));
  if (!lu) return null;
  const numero = lu[1].replace(/\s+/g, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,28})[A-Za-z0-9]$/.test(numero) && /\d/.test(numero) ? numero : null;
}

/**
 * Le type, tel qu'il entre dans une ancre : sans accent, mots liés par des
 * tirets, 16 signes au plus — « facture », « facture-de-regul ». Assez pour
 * distinguer deux types, assez court pour que le nom de fichier garde
 * l'énergie et le numéro lisibles (au-delà de 40 signes, le nommage commun le
 * remplace par une empreinte). Deux types qui ne diffèrent qu'après 16 signes,
 * au même numéro, feraient la même ancre : la règle des doublons n'en prend
 * alors aucun (`lireLesDocuments`). Pure.
 */
function typeEnAncre(type) {
  return sansAccent(type).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 16).replace(/-$/, '') || 'document';
}

/** L'ancre d'une facture : énergie, type, numéro lu. Pure. */
function remoteIdFacture({ energie, type, numero }) {
  return `${ID}-${ENERGIES[energie].ancre}-${typeEnAncre(type)}-${numero}`;
}

/** Le type tel qu'il se dit au journal : ses mots, aucun chiffre. Pure. */
function typeAuJournal(type) {
  return normaliser(type).replace(/\d+/g, '#').slice(0, 60) || 'sans type';
}

/**
 * Un document lu dans la page, ramené à ce qu'il est. Pure, testée.
 *
 * @param {{energie: string, type: string, ligneNumero: string, date: string,
 *   liens: Array<{href: string, action: string}>}} brut
 */
function analyserDocument(brut) {
  const type = normaliser(brut?.type);
  const liens = Array.isArray(brut?.liens) ? brut.liens : [];
  // La marque d'un seul de ses liens suffit à faire d'un document un échéancier.
  const marque = liens.find((l) => String(l?.action ?? '').trim().toUpperCase() === ACTION_ECHEANCIER);
  const nature = natureDuDocument({ type, action: marque ? marque.action : (liens[0]?.action ?? '') });
  if (nature !== 'facture') return { nature, type };
  if (!ENERGIES[brut?.energie]) return { nature: 'refusee', type, raison: 'énergie inconnue' };
  const numero = numeroDuLibelle(brut.ligneNumero);
  if (!numero) return { nature: 'refusee', type, raison: 'aucun numéro lisible' };
  if (liens.length !== 1) {
    return { nature: 'refusee', type, raison: liens.length ? `${liens.length} liens de téléchargement` : 'aucun lien de téléchargement' };
  }
  const interdit = motInterdit(liens[0].href);
  if (interdit) return { nature: 'refusee', type, raison: `lien refusé (« ${interdit} »)` };
  const adresse = lienDeTelechargement(liens[0].href);
  if (!adresse) return { nature: 'refusee', type, raison: 'lien qui n\'est pas un téléchargement de la liste' };
  return {
    nature: 'facture',
    type,
    energie: brut.energie,
    numero,
    issuedOn: pageDocs.dateDepuisTexte(brut.date),
    adresse,
  };
}

const compterPar = (carte, cle) => carte.set(cle, (carte.get(cle) || 0) + 1);

/**
 * Les documents d'une lecture : les factures à prendre, les échéanciers et
 * types inconnus (comptés par type), les factures refusées (et pourquoi). Une
 * ancre présente deux fois n'est prise sur aucune — elle ne désignerait pas
 * UN document. Pure, testée.
 */
function lireLesDocuments(bruts) {
  const analyses = (bruts || []).map(analyserDocument);
  const ancres = new Map();
  for (const a of analyses) if (a.nature === 'facture') compterPar(ancres, remoteIdFacture(a));
  const factures = [];
  const refusees = [];
  const echeanciers = new Map();
  const inconnus = new Map();
  for (const [rang, a] of analyses.entries()) {
    if (a.nature === 'facture' && ancres.get(remoteIdFacture(a)) > 1) {
      refusees.push({ rang, type: a.type, raison: 'la même facture figure deux fois' });
    } else if (a.nature === 'facture') {
      factures.push({ ...a, rang, remoteId: remoteIdFacture(a) });
    } else if (a.nature === 'refusee') {
      refusees.push({ rang, type: a.type, raison: a.raison });
    } else if (a.nature === 'echeancier') {
      compterPar(echeanciers, typeAuJournal(a.type));
    } else {
      compterPar(inconnus, typeAuJournal(a.type));
    }
  }
  const somme = (carte) => [...carte.values()].reduce((n, v) => n + v, 0);
  return {
    factures,
    refusees,
    echeanciers,
    inconnus,
    nbEcheanciers: somme(echeanciers),
    nbInconnus: somme(inconnus),
    lus: analyses.length,
  };
}

/** Les noms de fichier d'un passage, jamais deux fois le même. Pure. */
function nommer(documents) {
  const pris = new Set();
  return documents.map((d) => {
    const base = pageDocs.nomFichier(ID, { issuedOn: d.issuedOn, remoteId: d.remoteId });
    let nom = base;
    for (let n = 2; pris.has(nom); n++) nom = base.replace(/\.pdf$/, `-${n}.pdf`);
    pris.add(nom);
    return nom;
  });
}

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

/** « 3 échéanciers ignorés », « 1 document d'un autre type ignoré ». Pure. */
function phraseDesIgnores(lecture) {
  const morceaux = [];
  if (lecture.nbEcheanciers) morceaux.push(pluriel(lecture.nbEcheanciers, 'échéancier ignoré', 'échéanciers ignorés'));
  if (lecture.nbInconnus) morceaux.push(pluriel(lecture.nbInconnus, 'document d\'un autre type ignoré', 'documents d\'un autre type ignorés'));
  return morceaux.join(', ');
}

/**
 * La phrase d'une liste lue sans aucune facture (R5) : un succès, qui le dit.
 * Pure, testée.
 */
function phraseAucuneFacture(lecture) {
  const ignores = phraseDesIgnores(lecture);
  return `Aucune facture pour l'instant${ignores ? ` ; ${ignores}` : ''}. `
    + `Votre historique ${NOM} a bien été lu, électricité et gaz : crabe n'y prend que les factures.`;
}

/**
 * Ce que l'écran dit d'un passage, en plus du compte des factures. Des
 * nombres, jamais un numéro ni un montant. Pure, testée.
 */
function precisionDuPassage(b, lecture) {
  const phrases = [];
  const ignores = phraseDesIgnores(lecture);
  phrases.push(`— ${NOM} : ${pluriel(lecture.factures.length + lecture.refusees.length, 'facture lue', 'factures lues')} `
    + 'dans votre historique (électricité et gaz)'
    + (b.deja ? `, ${b.deja} déjà dans vos documents` : '')
    + (ignores ? ` ; ${ignores}` : '')
    + '.');
  if (lecture.refusees.length) {
    phrases.push(lecture.refusees.length > 1
      ? `${lecture.refusees.length} factures n'ont pas été prises : elles ne se lisaient pas de façon sûre (le journal dit pourquoi).`
      : 'Une facture n\'a pas été prise : elle ne se lisait pas de façon sûre (le journal dit pourquoi).');
  }
  if (b.interruption === 'temps') {
    phrases.push(`La récupération a pris tout le temps permis : ${pluriel(b.restantes, 'facture attend', 'factures attendent')} `
      + 'encore ; elles viendront au prochain passage. Rien de ce qui a été pris n\'est perdu.');
  }
  return phrases.join(' ');
}

/**
 * La fenêtre d'historique : le réglage de l'utilisateur, sauf « Depuis la
 * dernière récupération », qui prend tout ce qui manque à l'archive — dans la
 * limite de la conservation (comme l'Eau d'Île-de-France).
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

/** Une adresse de la page de connexion du site (renvoi d'un visiteur sans session). Pure. */
function estPageDeConnexion(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.hostname === HOTE && u.pathname.replace(/\/+$/, '') === CHEMIN_CONNEXION) return true;
  } catch {
    /* adresse illisible : le motif générique en juge */
  }
  return preuve.estUrlAuthentification(url);
}

// ---------------------------------------------------------------------------
// Ce qui se lit dans la page — lu, jamais touché
// ---------------------------------------------------------------------------

/** Ce que la page montre, pour juger où l'on est et si la liste est prête. */
function observer(page) {
  return page.evaluate(({ conteneurs, deconnexion }) => {
    const visible = (el) => !!el && !el.closest('.hide') && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden';
    const blocs = [...document.querySelectorAll(conteneurs)];
    const h1 = [...document.querySelectorAll('h1')].map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim());
    return {
      url: location.href,
      titres: h1,
      deconnexion: document.querySelectorAll(deconnexion).length,
      conteneurs: blocs.length,
      documents: blocs.reduce((n, b) => n + b.querySelectorAll('.detail-facture').length, 0),
      chargement: blocs.some((b) => [...b.querySelectorAll('.js--documents-loader')].some((l) => !l.classList.contains('hide'))),
      motDePasse: [...document.querySelectorAll('input[type="password"]')].some(visible),
    };
  }, { conteneurs: SELECTEUR_CONTENEURS, deconnexion: SELECTEUR_DECONNEXION }).catch(() => null);
}

/**
 * Les documents des deux panneaux, lus dans le DOM — panneau caché compris,
 * replié compris. Pour chacun : son énergie (celle de son conteneur), son
 * type, son libellé, sa date et SES liens — dans le `.detail-facture`, sinon
 * dans le bloc que commande le bouton qui le contient (dans le même
 * conteneur). Rien n'est cliqué, rien n'est déplié.
 */
function lireLaPage(page) {
  return page.evaluate((conteneurs) => {
    const texte = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const lien = (a) => ({ href: a.getAttribute('href') || '', action: a.getAttribute('data-trackingz-action') || '' });
    return [...document.querySelectorAll(conteneurs)].map((bloc) => {
      const documents = [];
      const attribues = new Set();
      for (const doc of bloc.querySelectorAll('.detail-facture')) {
        let liens = [...doc.querySelectorAll('a.btn--telecharger')];
        if (!liens.length) {
          const bouton = doc.closest('button[aria-controls]');
          const cible = bouton && bloc.querySelector(`[id="${CSS.escape(bouton.getAttribute('aria-controls'))}"]`);
          if (cible && !cible.contains(doc)) liens = [...cible.querySelectorAll('a.btn--telecharger')];
        }
        for (const a of liens) attribues.add(a);
        const etiquette = doc.querySelector('.detail-facture__label');
        const type = texte(etiquette && etiquette.querySelector('strong'));
        // La ligne « N° … » : le `span` qui suit le type (annoncé), sinon le
        // libellé sans son type.
        const ligne = etiquette && etiquette.querySelector('.text--body');
        documents.push({
          energie: bloc.getAttribute('data-energie') || '',
          type,
          ligneNumero: ligne ? texte(ligne) : texte(etiquette).replace(type, '').trim(),
          date: texte(doc.querySelector('.detail-facture__date')),
          liens: liens.map(lien),
        });
      }
      const tous = [...bloc.querySelectorAll('a.btn--telecharger')];
      return {
        energie: bloc.getAttribute('data-energie') || '',
        documents,
        liensSansDocument: tous.filter((a) => !attribues.has(a)).length,
        pages: bloc.querySelectorAll('.pager-page__item').length,
        parPage: Number.parseInt(bloc.getAttribute('data-pagination') || '', 10) || null,
      };
    });
  }, SELECTEUR_CONTENEURS);
}

/**
 * Attend la LISTE (R5) : le titre « Mon historique de factures », le lien de
 * déconnexion (lu, jamais suivi), au moins un conteneur d'historique, aucun
 * « Chargement » affiché, et le même nombre de documents un moment durant.
 * Rend un verdict, ne lève jamais.
 *
 * @returns {Promise<{verdict: 'liste'|'connexion'|'chargement'|'mur'|'illisible', raison: string}>}
 */
async function attendreLaListe(page) {
  const debut = Date.now();
  const fin = debut + ouverture.delaiDessinMs;
  let signature = null;
  let stableDepuis = 0;
  let vue = null;
  for (;;) {
    vue = (await observer(page)) || { url: page.url(), titres: [], deconnexion: 0, conteneurs: 0, documents: 0, chargement: true, motDePasse: false };
    if (estPageDeConnexion(vue.url) || vue.motDePasse) {
      return {
        verdict: 'connexion',
        raison: estPageDeConnexion(vue.url)
          ? `renvoyé vers ${masquer(String(vue.url).replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0])}, une page de connexion`
          : 'un champ de mot de passe est affiché à la place de la liste',
      };
    }
    const titre = vue.titres.includes(TITRE_LISTE);
    const prete = titre && vue.deconnexion > 0 && vue.conteneurs > 0 && !vue.chargement;
    if (prete) {
      const forme = `${vue.conteneurs}|${vue.documents}`;
      if (forme !== signature) {
        signature = forme;
        stableDepuis = Date.now();
      }
      if (Date.now() - stableDepuis >= (vue.documents ? STABLE_MS : STABLE_VIDE_MS)) {
        return {
          verdict: 'liste',
          raison: `liste lue en ${Math.round((Date.now() - debut) / 100) / 10} s — titre « ${TITRE_LISTE} », `
            + `lien de déconnexion présent (non suivi), ${pluriel(vue.conteneurs, 'historique', 'historiques')}`,
        };
      }
    } else {
      signature = null;
    }
    if (Date.now() >= fin) break;
    await page.waitForTimeout(PAS_ATTENTE_MS).catch(() => {});
  }
  const secondes = Math.round(ouverture.delaiDessinMs / 1000);
  if (vue.chargement && vue.conteneurs) return { verdict: 'chargement', raison: `encore en cours de chargement après ${secondes} s` };
  if (await profilMarchand.estMurAntiRobot(page)) return { verdict: 'mur', raison: 'vérification de sécurité du site à l\'écran' };
  let ou = 'une page qui n\'est pas du site';
  try {
    const u = new URL(vue.url);
    if (u.hostname !== HOTE) return { verdict: 'illisible', raison: `arrivé sur ${u.hostname || ou}, hors du site, après ${secondes} s` };
    ou = masquer(u.pathname);
  } catch { /* adresse illisible */ }
  const manque = [
    vue.titres.includes(TITRE_LISTE) ? null : `pas de titre « ${TITRE_LISTE} »`,
    vue.deconnexion ? null : 'pas de lien de déconnexion',
    vue.conteneurs ? null : 'aucun historique d\'énergie',
  ].filter(Boolean).join(', ');
  return { verdict: 'illisible', raison: `sur ${ou} après ${secondes} s : ${manque || 'page instable'}` };
}

// ---------------------------------------------------------------------------
// Le navigateur
// ---------------------------------------------------------------------------

/**
 * Le lancement du navigateur, seul point remplaçable : les essais y branchent
 * un faux site (page inventée, réseau coupé) et éprouvent tout le reste tel
 * quel. L'horloge du budget et l'attente se remplacent aussi.
 */
const ouverture = {
  lancer: () => requirePlaywright().chromium.launch(identity.optionsLancement()),
  maintenant: () => Date.now(),
  delaiDessinMs: DELAI_DESSIN_MS,
};

/**
 * Ouvre un navigateur sur la connexion enregistrée, AVEC la liste fermée posée
 * sur son réseau : une requête qui porte un mot interdit — du connecteur ou
 * de la page — est avortée avant de partir, et comptée.
 */
async function surLeCompte(config, ctx, fn) {
  const log = journalDe(ctx);
  const session = lireSession(config);
  const browser = await ouverture.lancer();
  let context = null;
  let cookiesCapture = [];
  const avortees = [];
  try {
    context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: false })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    await context.route((url) => motInterdit(url.href) !== null, (route) => {
      avortees.push(motInterdit(route.request().url()));
      return route.abort('blockedbyclient');
    });
    cookiesCapture = await context.cookies().catch(() => []);
    const page = await context.newPage();
    // Aucune boîte n'est attendue (aucun geste) : une boîte est refusée.
    page.on('dialog', (boite) => { boite.dismiss().catch(() => {}); });
    navigation.brancher(page, { log, prefixe: `${ID} : navigation` });
    return await fn(page, context);
  } finally {
    if (avortees.length) {
      log(`${ID} : ${pluriel(avortees.length, 'requête interdite avortée', 'requêtes interdites avortées')} avant de partir `
        + `(${[...new Set(avortees)].map((m) => `« ${m} »`).join(', ')}).`);
    }
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

const REESSAYER = 'La prochaine récupération réessaiera d\'elle-même ; si cela se répète, signalez-le.';

function erreurArrivee(verdict, raison, erreurNavigation) {
  let err;
  if (verdict === 'chargement') {
    err = new Error(`La liste de vos factures ${NOM} est restée en cours de chargement plus de `
      + `${Math.round(ouverture.delaiDessinMs / 1000)} secondes : crabe n'a rien pu lire. ${REESSAYER}`);
  } else if (erreurNavigation) {
    err = new Error(`La page de vos factures ${NOM} n'a pas pu être chargée par le navigateur de crabe : rien n'a été lu. ${REESSAYER}`);
  } else {
    err = new Error(
      `${NOM} a bien ouvert votre espace client, mais crabe n'a pas su lire la liste de vos factures : la page ne `
        + 'ressemble plus à celle qu\'il connaît. Votre connexion n\'est pas en cause : inutile de la rouvrir. '
        + 'Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération réessaiera d\'elle-même.'
    );
  }
  err.precision = erreurNavigation ? `${raison} ; chargement : ${masquer(erreurNavigation)}` : raison;
  return err;
}

/**
 * La SEULE navigation : l'adresse de la page des factures, recontrôlée
 * (jamais par le menu, jamais par un onglet).
 */
async function naviguer(page) {
  if (!adresseAutorisee(URL_FACTURES)) throw new Error(`${ID} : l'adresse de la liste n'est pas permise — rien n'a été demandé.`);
  try {
    await page.goto(URL_FACTURES, { waitUntil: 'domcontentloaded' });
    return null;
  } catch (err) {
    return normaliser(err?.message).split(' Call log')[0].slice(0, 160);
  }
}

/**
 * Rejoint la liste, l'attend, JUGE l'arrivée, puis la lit. Rend la lecture,
 * ou lève : renvoi vers la connexion (« session expirée »), mur anti-robot,
 * chargement sans fin, page illisible.
 */
async function arriverSurLaListe(page, log) {
  const erreurNavigation = await naviguer(page);
  if (erreurNavigation) log(`${ID} : le chargement de la page a échoué — ${masquer(erreurNavigation)}.`);
  const arrivee = await attendreLaListe(page);
  log(`${ID} : arrivée jugée « ${arrivee.verdict} » — ${arrivee.raison}.`);
  if (arrivee.verdict === 'connexion') throw profilMarchand.erreurRenvoiVersAuthentification(NOM, arrivee.raison);
  if (arrivee.verdict === 'mur') throw new Error(profilMarchand.messageMur(NOM));
  if (arrivee.verdict !== 'liste') throw erreurArrivee(arrivee.verdict, arrivee.raison, erreurNavigation);
  const blocs = await lireLaPage(page);
  const connues = blocs.filter((b) => ENERGIES[b.energie]);
  for (const b of blocs) {
    if (!ENERGIES[b.energie]) {
      log(`${ID} : un historique d'énergie inconnue (« ${typeAuJournal(b.energie)} ») — ${pluriel(b.documents.length, 'document ignoré', 'documents ignorés')}.`);
    }
  }
  const lecture = lireLesDocuments(connues.flatMap((b) => b.documents));
  for (const b of connues) {
    const energie = ENERGIES[b.energie].phrase;
    log(`${ID} : ${energie} — ${pluriel(b.documents.length, 'document lu', 'documents lus')}`
      + `${b.pages > 1 ? ` ; la pagination annonce ${b.pages} pages : seuls les documents servis dans la page sont lus` : ''}`
      + `${b.liensSansDocument ? ` ; ${pluriel(b.liensSansDocument, 'lien de téléchargement', 'liens de téléchargement')} sans document, ignoré(s)` : ''}.`);
  }
  for (const [type, n] of lecture.echeanciers) log(`${ID} : ignoré — « ${type} » (échéancier) : ${n}.`);
  for (const [type, n] of lecture.inconnus) log(`${ID} : ignoré — « ${type} » (type inconnu) : ${n}.`);
  for (const r of lecture.refusees) log(`${ID} : facture non prise — « ${typeAuJournal(r.type)} » : ${r.raison}.`);
  return { lecture, energies: connues.length };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la liste s'affiche au compte connecté. Aucune requête de document. */
async function test(config, ctx = {}) {
  const log = journalDe(ctx);
  return surLeCompte(config, ctx, async (page) => {
    const { lecture } = await arriverSurLaListe(page, log);
    const n = lecture.factures.length + lecture.refusees.length;
    return {
      ok: true,
      accountId: null,
      message: n
        ? `Connexion valide — ${pluriel(n, 'facture', 'factures')} dans votre historique ${NOM}. `
          + 'Elles seront prises à la prochaine récupération.'
        : `Connexion valide — votre historique ${NOM} se lit : aucune facture pour l'instant`
          + `${phraseDesIgnores(lecture) ? ` (${phraseDesIgnores(lecture)})` : ''}.`,
    };
  });
}

/**
 * Les factures des deux énergies, en deux temps : LIRE la page entière, puis
 * PRENDRE chaque facture manquante par le `fetch` de la page, une à la fois.
 * Ce qui est pris est GARDÉ quoi qu'il arrive ensuite.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = journalDe(ctx);
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = fenetre(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}.`);
  const echeance = ouverture.maintenant() + budgetMs();

  return surLeCompte(config, ctx, async (page, context) => {
    const { lecture } = await arriverSurLaListe(page, log);
    const bilan = { deja: 0, horsPeriode: 0, restantes: 0, interruption: null };

    const aPrendre = [];
    for (const f of lecture.factures) {
      if (connus.has(f.remoteId)) {
        bilan.deja++;
        continue;
      }
      if (!scraping.dansLaFenetre(f.issuedOn, plan)) {
        bilan.horsPeriode++;
        continue;
      }
      aPrendre.push(f);
    }
    log(`${ID} : liste lue — ${lecture.lus} document(s) : ${lecture.factures.length} facture(s) lisible(s), `
      + `${lecture.refusees.length} non prise(s), ${lecture.nbEcheanciers} échéancier(s) et ${lecture.nbInconnus} `
      + `d'un autre type ignorés ; ${bilan.deja} déjà dans l'archive, ${aPrendre.length} à prendre, `
      + `${bilan.horsPeriode} hors période.`);

    // La preuve exigée par le socle (lot 31) : la liste a été LUE, session
    // prouvée par le lien de déconnexion et le titre de la page.
    ctx.preuveDeListe?.({
      session: `lien de déconnexion et titre « ${TITRE_LISTE} » sur ${CHEMIN_FACTURES}`,
      liste: URL_FACTURES,
      elements: lecture.lus,
    });

    const invoices = [];
    const serie = suiteDEchecs();
    let tentees = 0;
    let manqueesAuTelechargement = 0;
    let renoncement = null;
    for (const [i, f] of aPrendre.entries()) {
      if (ouverture.maintenant() > echeance) {
        bilan.interruption = 'temps';
        break;
      }
      tentees++;
      const qui = `facture ${i + 1} sur ${aPrendre.length} (${ENERGIES[f.energie].phrase})`;
      // Recontrôlée juste avant la requête : la liste fermée, et la forme exacte.
      const adresse = motInterdit(f.adresse) === null ? lienDeTelechargement(f.adresse) : null;
      const obtenu = adresse
        ? await ongletPdf.fluxDeLaPage(page, adresse)
        : { ok: false, grief: 'adresse refusée au dernier contrôle — rien n\'a été demandé' };
      if (obtenu.ok) {
        serie.reussite();
        invoices.push({ ...f, buffer: obtenu.buffer });
        log(`${ID} : ${qui} — récupérée (${obtenu.buffer.length} octets).`);
        continue;
      }
      manqueesAuTelechargement++;
      log(`${ID} : ${qui} — pas de PDF : ${masquer(obtenu.grief)}.`);
      if (serie.echec(obtenu.grief)) {
        log(`${ID} : ${serie.raison()}`);
        renoncement = serie.phrasePublique();
        break;
      }
    }
    bilan.restantes = aPrendre.length - tentees;
    const nonDemandees = renoncement ? bilan.restantes : 0;
    // Manquées : les factures vues et non prises (refusées à la lecture, ou
    // sans PDF), et celles qu'un renoncement n'a pas demandées. Le temps
    // écoulé ne manque rien : la suite vient au passage suivant.
    const manquees = lecture.refusees.length + manqueesAuTelechargement + nonDemandees;

    const noms = nommer(invoices);
    const sortie = {
      accountId: null,
      invoices: invoices.map((f, i) => ({
        remoteId: f.remoteId,
        filename: noms[i],
        issuedOn: f.issuedOn,
        buffer: f.buffer,
      })),
      couverture: {
        complete: !bilan.interruption && !manquees,
        detail: `l'historique des factures servi dans la page, électricité et gaz, ${pluriel(lecture.lus, 'document', 'documents')}`,
      },
    };
    if (manquees) sortie.manquees = manquees;
    if (renoncement) sortie.renoncement = renoncement;
    if (!lecture.factures.length && !lecture.refusees.length) {
      sortie.aucunDocument = phraseAucuneFacture(lecture);
    } else {
      if (!invoices.length && bilan.horsPeriode && !aPrendre.length && !manquees) {
        sortie.horsPeriode = scraping.phraseHorsPeriode(bilan.horsPeriode, 'facture', { feminin: true });
      }
      sortie.precision = precisionDuPassage(bilan, lecture);
    }
    log(`${ID} : bilan — ${invoices.length} prise(s), ${bilan.deja} déjà dans l'archive, ${lecture.refusees.length} `
      + `refusée(s) à la lecture, ${manqueesAuTelechargement} sans PDF, ${bilan.horsPeriode} hors période, `
      + `${bilan.restantes} en attente${bilan.interruption ? ` (interrompu : ${bilan.interruption})` : ''}`
      + `${renoncement ? ' — parcours arrêté (même échec répété)' : ''}.`);

    // L'état de session d'un passage qui a lu la liste remplace la capture (lot 87).
    try {
      sortie.sessionRenouvelee = JSON.stringify(await context.storageState());
    } catch {
      log(`${ID} : l'état de session n'a pas pu être relu en fin de passage.`);
    }
    return sortie;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests
  lireSession,
  masquer,
  pourLeJournal,
  motInterdit,
  adresseAutorisee,
  lienDeTelechargement,
  natureDuDocument,
  numeroDuLibelle,
  typeEnAncre,
  remoteIdFacture,
  analyserDocument,
  lireLesDocuments,
  nommer,
  phraseAucuneFacture,
  precisionDuPassage,
  estPageDeConnexion,
  fenetre,
  budgetMs,
  MOTS_INTERDITS,
  ENERGIES,
  HOTE,
  URL_FACTURES,
  CHEMIN_FACTURES,
  TITRE_LISTE,
  DELAI_DESSIN_MS,
  LIMITE_EXECUTION_DEFAUT_MS,
  ouverture,
};
