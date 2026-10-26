'use strict';

/**
 * Le journal d'une récupération, page par page (0.2.6).
 *
 * ─── Pourquoi ce module ──────────────────────────────────────────────────────
 *
 * Demande du 26/10/2026, sur la récupération n° 875 de Private Sport Shop
 * (« la page ne ressemble plus à celle qu'il connaît », un journal vide) :
 * avec ce que crabe écrivait, impossible de refaire une lecture. Il faut, pour
 * CHAQUE récupération et sans retoucher un seul connecteur :
 *
 *   - une ligne par étape, avec l'heure (celle du journal) et la durée :
 *     l'ouverture du navigateur, chaque page, chaque téléchargement ;
 *   - pour chaque page : son chemin (sans les paramètres), son titre, son code
 *     HTTP, son temps de chargement ;
 *   - chaque sélecteur que le connecteur a cherché : trouvé ou non, combien ;
 *   - les appels réseau de la page (XHR, fetch) : méthode, chemin, statut,
 *     type — une liste chargée après coup (`api/orders…`) se voit là ;
 *   - ses cadres (iframe), et les erreurs de sa console.
 *
 * ─── Comment ─────────────────────────────────────────────────────────────────
 *
 * Par l'accroche du lot 110 (site-hors-ligne.js), qui suit déjà chaque
 * navigateur ouvert pendant une récupération. Les évènements du navigateur
 * donnent les pages, le réseau, la console et les téléchargements. Les
 * sélecteurs viennent de deux sources :
 *
 *   - les appels Playwright eux-mêmes (`locator(…).count()`, `waitFor`,
 *     `$$eval`, `click`…), interceptés sur leurs prototypes, avec leur issue ;
 *   - les sélecteurs écrits EN TOUTES LETTRES dans une fonction de
 *     `page.evaluate` (`document.querySelector('h1[data-…]')`), relevés dans
 *     son texte, puis recomptés par crabe lui-même, au plus toutes les trois
 *     secondes.
 *
 * Rien n'est injecté dans les pages pendant la récupération : une page dont
 * les fonctions natives sont remplacées se voit des murs anti-robot, et ferait
 * échouer des récupérations qui marchent.
 *
 * ─── Ce qui ne s'écrit jamais ────────────────────────────────────────────────
 *
 * Une adresse se dit sans requête ni identifiant (releve-navigation), un titre
 * ou un message de console a ses nombres masqués et perd ses salutations et
 * ses adresses e-mail ; le rapport repasse tout dans son anonymisation.
 * Aucune valeur de champ, aucun cookie, aucun corps de réponse.
 *
 * Une accroche ne doit jamais empêcher un connecteur de travailler : toutes
 * sont sous `try`, et hors d'une récupération suivie elles ne font rien.
 */

const navigation = require('./releve-navigation');

/** Les pages détaillées au journal d'une récupération ; les suivantes sont comptées. */
const PAGES_DETAILLEES = 30;
/** Les sélecteurs, appels réseau et messages gardés pour une page. */
const SELECTEURS_PAR_PAGE = 25;
const APPELS_PAR_PAGE = 20;
const CONSOLE_PAR_PAGE = 8;
const CADRES_PAR_PAGE = 8;
/** Les requêtes directes (téléchargements, API) écrites au journal d'une récupération. */
const REQUETES_DETAILLEES = 40;
/** Un recompte des sélecteurs lus dans `page.evaluate`, au plus toutes les… */
const RECOMPTE_MS = 3000;

// ---------------------------------------------------------------------------
// Petits outils
// ---------------------------------------------------------------------------

/** Une durée lisible : « 350 ms », « 1,8 s », « 2 min 05 s ». */
function duree(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

const SALUTATION = /^(bonjour|bonsoir|salut|hello|hi|hey|bienvenue|welcome)\b/i;

/**
 * Un texte de page dicible : court, adresses et nombres masqués ; une
 * salutation ou une adresse e-mail le taisent, comme le titre provisoire
 * (« Loading https://… ») que Chromium donne à une page qui se charge.
 */
function textePropre(texte, max = 120) {
  const brut = String(texte ?? '').replace(/\s+/g, ' ').trim();
  if (/^(loading|chargement)\b.*https?:/i.test(brut) || /^https?:\/\//i.test(brut)) return null;
  const t = navigation.masquerAdresses(brut).replace(/\d{4,}/g, '####');
  if (!t || SALUTATION.test(t) || t.includes('@')) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Les mots usuels d'un site, en français et en anglais (sans accents, en
 * minuscules) : ce qu'un titre, un intertitre ou une alerte peut garder.
 * Tout autre mot devient « … » — un nom, une organisation, une ville. Mesuré
 * le 26/10/2026 : le titre d'une page Gandi porte le nom de l'organisation
 * (« Organisation d'essai C - Facturation - Gandi.net ») ; on ne peut pas
 * deviner ce qui est personnel, on garde ce qui est SÛR.
 */
const MOTS_USUELS = new Set(`
a au aux avec ce ces dans de des du en et la le les leur mes mon ma nos notre nous ou par pas plus pour que qui sa se ses son sur ta tes ton un une vos votre vous il elle est sont etes etre ne non oui tout tous toute toutes
accueil achat achats abonnement abonnements acces activite adresse adresses aide aller annuler application attente authentification autre autres
boutique bouton carte cartes catalogue choisir choix client clients code commande commandes compte comptes confirmation confirmer connexion connecter
contact contrat contrats cookie cookies creer date dernier derniere details detail document documents donnees echeance echeances ecran erreur espace
etape expire expiree facturation facture factures fermer fois gerer historique humain identifiant identification informations introuvable
liste livraison maintenance mot nouveau nouvelle numero offre offres organisation organisations page pages paiement paiements panier parametres
passe payer pdf personnel personnelles preferences produit produits profil recherche recu recus reglages releve releves retour robot securite
service services session souscription suivi suivant precedent tableau bord telecharger telechargement utilisateur valider verification verifiez
verifier bienvenue merci instant patientez veuillez reessayer refuse refusee interdit indisponible
account accounts activity address addresses all and app are attention access billing browser cart checkout checking choose code confirm contact
contract cookies customer dashboard date denied details detail document documents download error for forbidden found gateway help history home
human in invoice invoices is just list loading log login logout maintenance many moment my new next not of order orders organization organizations
page password pay payment payments pdf please previous profile purchase purchases receipt receipts required robot search security select server
service services session settings sign statement statements subscription subscriptions the to too unauthorized unavailable verification verify
wait welcome you your requests timeout bad
`.split(/\s+/).filter(Boolean));

const sansAccent = (m) => m.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Un texte de page réduit à ses mots usuels (et au nom du site, tiré de son
 * adresse) ; nombres de quatre chiffres ou plus masqués ; « … » pour le reste.
 */
function texteDeRepere(texte, { hote = '' } = {}) {
  const marque = new Set(String(hote).toLowerCase().split(/[.-]/).filter((x) => x.length >= 3));
  // Mot par mot, élisions séparées : « d'essai » se juge sur « essai ».
  const garde = String(texte ?? '').replace(/\p{L}+/gu, (mot) => {
    const bas = sansAccent(mot);
    if (bas.length <= 2 || MOTS_USUELS.has(bas) || MOTS_USUELS.has(bas.replace(/s$/, '')) || marque.has(bas)) return mot;
    return '…';
  });
  return garde.replace(/\d{4,}/g, '####').replace(/…(?:[\s'’-]*…)+/g, '…');
}

/** Un identifiant d'enregistrement (lettres ET chiffres mêlés, ou trois chiffres de suite). */
const MOTIF_IDENTIFIANT = /[A-Za-z0-9]*(?:\d[A-Za-z]|[A-Za-z]\d|\d{3,})[A-Za-z0-9]*/g;

/**
 * Un sélecteur dicible. Un connecteur y glisse parfois une donnée : le texte
 * cherché (`getByText`, le nom d'un rôle, un `aria-label`…) passe par la même
 * règle que les textes de page ; dans les autres valeurs, un identifiant
 * d'enregistrement devient « … » (mesuré : `payment-schedule-line-installment_<identifiant>`).
 */
function selecteurPropre(selecteur, { hote = '' } = {}) {
  const s = String(selecteur ?? '').replace(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g, (tout, guillemet, valeur, position, chaine) => {
    const avant = chaine.slice(Math.max(0, position - 40), position);
    const texte = /(internal:(?:text|has-text|has-not-text|label)=|\[(?:name|placeholder|title|alt|aria-label)[*^$|~]?=|text=|:has-text\(|:text(?:-is)?\()\s*$/i.test(avant);
    const propre = texte
      ? texteDeRepere(valeur, { hote })
      : valeur.replace(MOTIF_IDENTIFIANT, (m) => (/[A-Za-z]/.test(m) && !/\d/.test(m) ? m : '…'));
    return `${guillemet}${propre}${guillemet}`;
  }).replace(/\d{4,}/g, '####').replace(/\S+@\S+\.\w+/g, '[e-mail]').trim();
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

/** Un message de console dicible : adresses masquées, nombres masqués, court. */
function messagePropre(texte) {
  const t = navigation.masquerAdresses(String(texte ?? '').split('\n')[0]).replace(/\d{4,}/g, '####').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/**
 * Les sélecteurs écrits en toutes lettres dans une fonction de page :
 * `querySelector('…')`, `querySelectorAll("…")`, `closest('…')`,
 * `matches('…')`. Un gabarit à trous (`${…}`) ne se relève pas : il ne dit
 * pas ce qui a vraiment été cherché.
 */
const MOTIF_SELECTEUR_EN_CLAIR = /\b(?:querySelector(?:All)?|closest|matches)\(\s*(['"`])((?:\\.|(?!\1)[^\\])+?)\1\s*\)/g;
const cacheDesSources = new Map();
function selecteursDeLaSource(source) {
  const texte = String(source ?? '');
  if (cacheDesSources.has(texte)) return cacheDesSources.get(texte);
  const trouves = [];
  for (const m of texte.matchAll(MOTIF_SELECTEUR_EN_CLAIR)) {
    const brut = m[2];
    if (m[1] === '`' && brut.includes('${')) continue;
    const s = brut.replace(/\\(['"`\\])/g, '$1');
    if (!trouves.includes(s)) trouves.push(s);
  }
  if (cacheDesSources.size > 500) cacheDesSources.clear();
  cacheDesSources.set(texte, trouves);
  return trouves;
}

/** La nature d'une page, d'après son chemin : ce que l'étape fait, pour qui lit le journal. */
function natureDeLaPage(adresse, { motDePasse = false } = {}) {
  const a = String(adresse ?? '').toLowerCase();
  if (motDePasse || /log-?in|sign-?in|connexion|identification|authenti|\/auth\b|\/session/.test(a)) return 'connexion';
  if (/invoice|facture|receipt|recu|reçu|\.pdf|\/pdf\b|document/.test(a)) return 'facture';
  if (/order|commande|achat|purchase|historique|historical|history/.test(a)) return 'commandes';
  if (/account|compte|profil|profile|espace|dashboard|tableau/.test(a)) return 'compte';
  return 'page';
}

// ---------------------------------------------------------------------------
// L'état d'une page suivie
// ---------------------------------------------------------------------------

/** page Playwright → { passage, courant } */
const PAGES = new WeakMap();

function nouvelleVisite(adresse, debut, statut = null) {
  return {
    adresse,
    debut,
    chargeeEn: null,
    statut,
    titre: null,
    motDePasse: false,
    selecteurs: new Map(),
    appels: new Map(),
    console: [],
    cadres: [],
    dernierRecompte: 0,
    ecrite: false,
  };
}

/** Le journal de la récupération ; sans `passage.log`, rien ne s'écrit. */
function ecrire(passage, ligne) {
  try {
    passage?.log?.(ligne);
  } catch { /* le journal ne doit jamais faire tomber une récupération */ }
}

function etatDuJournal(passage) {
  passage.journal ??= { pages: 0, omises: 0, requetes: 0, requetesOmises: 0 };
  return passage.journal;
}

/** Un sélecteur cherché sur la page courante, et ce que la recherche a donné. */
function noterSelecteur(etatPage, selecteur, { api, compte = undefined, issue = 'ok' }) {
  const visite = etatPage?.courant;
  if (!visite || !selecteur) return;
  const cle = String(selecteur);
  let s = visite.selecteurs.get(cle);
  if (!s) {
    if (visite.selecteurs.size >= SELECTEURS_PAR_PAGE) return;
    s = { api, appels: 0, compte: null, max: null, issue: null };
    visite.selecteurs.set(cle, s);
  }
  s.appels += 1;
  if (api && !String(s.api).split('/').includes(api)) s.api = `${s.api}/${api}`;
  if (Number.isFinite(compte)) {
    s.compte = compte;
    s.max = Math.max(s.max ?? 0, compte);
  }
  // L'issue la plus parlante l'emporte : une attente vaine reste dite.
  if (s.issue !== 'delai' || issue === 'delai') s.issue = issue;
}

/** Les lignes d'une visite de page, au journal. */
function lignesDeLaVisite(visite, fin = Date.now()) {
  const lignes = [];
  const nature = natureDeLaPage(visite.adresse, visite);
  lignes.push(`Étape « ${nature} » : ${visite.adresse}`
    + `${visite.titre ? ` — titre « ${visite.titre} »` : ''}`
    + `${visite.statut ? ` — HTTP ${visite.statut}` : ''}`
    + `${visite.chargeeEn !== null ? ` — chargée en ${duree(visite.chargeeEn)}` : ' — chargement non terminé'}`
    + ` — restée ${duree(fin - visite.debut)}.`);
  if (visite.selecteurs.size) {
    const morceaux = [...visite.selecteurs].map(([sel, s]) => {
      const compte = s.compte === null
        ? ({ absent: '0', delai: '0', ok: 'trouvé', erreur: 'erreur' }[s.issue] || '?')
        : String(s.compte);
      const max = s.max !== null && s.max !== s.compte ? `, jusqu'à ${s.max}` : '';
      const attente = s.issue === 'delai' ? ', attendu en vain' : '';
      return `${selecteurPropre(sel, { hote: visite.adresse.split('/')[0] })} → ${compte}${max}${attente} [${s.api}${s.appels > 1 ? ` ×${s.appels}` : ''}]`;
    });
    lignes.push(`Sélecteurs cherchés sur ${visite.adresse} : ${morceaux.join(' ; ')}.`);
  }
  if (visite.appels.size) {
    const morceaux = [...visite.appels.values()].map((a) =>
      `${a.methode} ${a.adresse} → ${a.statut ?? 'sans réponse'}${a.type ? ` ${a.type}` : ''}${a.n > 1 ? ` ×${a.n}` : ''}`);
    lignes.push(`Appels réseau de ${visite.adresse} : ${morceaux.join(' ; ')}.`);
  }
  if (visite.cadres.length) lignes.push(`Cadres de ${visite.adresse} : ${visite.cadres.join(' ; ')}.`);
  if (visite.console.length) lignes.push(`Console de ${visite.adresse} : ${visite.console.join(' ; ')}.`);
  return lignes;
}

/** Écrit la visite au journal, une fois, dans la limite des pages détaillées. */
function ecrireLaVisite(passage, visite) {
  if (!visite || visite.ecrite) return;
  visite.ecrite = true;
  const j = etatDuJournal(passage);
  if (j.pages >= PAGES_DETAILLEES) {
    j.omises += 1;
    return;
  }
  j.pages += 1;
  for (const ligne of lignesDeLaVisite(visite)) ecrire(passage, ligne);
}

// ---------------------------------------------------------------------------
// Les accroches de prototypes (une fois par processus)
// ---------------------------------------------------------------------------

/** Les méthodes d'origine, pour les lectures de crabe lui-même (jamais comptées). */
const ORIGINAUX = { evaluateDeCadre: null, screenshot: null };
let prototypesBranches = false;

/** La page d'un cadre ou d'un localisateur, et son état suivi. */
function etatDe(objet) {
  try {
    const cadre = objet?._frame || objet;
    const page = typeof cadre?.page === 'function' ? cadre.page() : null;
    return page ? PAGES.get(page) || null : null;
  } catch {
    return null;
  }
}

/** Ce qu'un résultat dit du nombre d'éléments trouvés, quand il le dit. */
function compteDuResultat(methode, resultat) {
  if (methode === 'count') return Number.isFinite(resultat) ? resultat : undefined;
  if (methode === '$$' || methode === 'all') return Array.isArray(resultat) ? resultat.length : undefined;
  if (methode === '$' || methode === 'waitForSelector') return resultat ? 1 : 0;
  return undefined;
}

/** Un délai dépassé en attendant un élément : c'est qu'il n'est pas venu. */
function estUnDelaiDepasse(err) {
  return /Timeout|TimeoutError/.test(`${err?.name ?? ''} ${err?.message ?? ''}`);
}

function envelopper(proto, nom, selecteurDe, { compter = nom } = {}) {
  const original = proto?.[nom];
  if (typeof original !== 'function' || original.__crabeJournal) return;
  const enveloppe = async function journalise(...args) {
    const etatPage = etatDe(this);
    if (!etatPage) return original.apply(this, args);
    let selecteur = null;
    try {
      selecteur = selecteurDe(this, args);
    } catch { /* sélecteur illisible : l'appel se fait quand même */ }
    try {
      const resultat = await original.apply(this, args);
      try {
        if (selecteur) noterSelecteur(etatPage, selecteur, { api: compter, compte: compteDuResultat(compter, resultat), issue: compteDuResultat(compter, resultat) === 0 ? 'absent' : 'ok' });
      } catch { /* noter ne doit jamais coûter l'appel */ }
      return resultat;
    } catch (err) {
      try {
        if (selecteur) noterSelecteur(etatPage, selecteur, { api: compter, issue: estUnDelaiDepasse(err) ? 'delai' : 'erreur' });
      } catch { /* idem */ }
      throw err;
    }
  };
  Object.defineProperty(enveloppe, '__crabeJournal', { value: true });
  Object.defineProperty(enveloppe, 'length', { value: original.length });
  proto[nom] = enveloppe;
}

/**
 * `evaluate` d'un cadre : les sélecteurs écrits dans la fonction sont notés,
 * puis recomptés par crabe (au plus toutes les trois secondes par page) avec
 * l'`evaluate` d'origine — jamais compté lui-même.
 */
function envelopperEvaluate(protoCadre) {
  const original = protoCadre?.evaluate;
  if (typeof original !== 'function' || original.__crabeJournal) return;
  ORIGINAUX.evaluateDeCadre = original;
  const enveloppe = async function evaluateJournalise(fonction, ...reste) {
    const etatPage = etatDe(this);
    const resultat = await original.call(this, fonction, ...reste);
    if (etatPage) {
      try {
        const lus = selecteursDeLaSource(typeof fonction === 'function' ? Function.prototype.toString.call(fonction) : fonction);
        for (const s of lus) noterSelecteur(etatPage, s, { api: 'evaluate' });
        if (lus.length) recompter(this, etatPage).catch(() => {});
      } catch { /* la lecture du connecteur a eu lieu, c'est elle qui compte */ }
    }
    return resultat;
  };
  Object.defineProperty(enveloppe, '__crabeJournal', { value: true });
  Object.defineProperty(enveloppe, 'length', { value: original.length });
  protoCadre.evaluate = enveloppe;
}

/**
 * Mode détaillé : la page que le connecteur QUITTE est capturée avant sa
 * navigation — c'est l'état qu'il a lu. (Capturer après le chargement de la
 * suivante n'est plus possible : l'ancienne page n'existe plus.)
 */
function envelopperGoto(protoCadre) {
  const original = protoCadre?.goto;
  if (typeof original !== 'function' || original.__crabeJournal) return;
  const enveloppe = async function gotoJournalise(...args) {
    try {
      const etatPage = etatDe(this);
      const page = this.page?.();
      if (etatPage?.passage?.detail && page && this === page.mainFrame() && etatPage.courant && !etatPage.courant.capturee) {
        etatPage.courant.capturee = true;
        await require('./vue-de-page').captureDEtape(page, etatPage.passage, { immediate: true });
      }
    } catch { /* la capture est un plus : la navigation a lieu quand même */ }
    return original.apply(this, args);
  };
  Object.defineProperty(enveloppe, '__crabeJournal', { value: true });
  Object.defineProperty(enveloppe, 'length', { value: original.length });
  protoCadre.goto = enveloppe;
}

/** La visite en cours d'une page (pour la capture d'une étape). */
function visiteCourante(page) {
  return PAGES.get(page)?.courant || null;
}

/** La visite en cours d'une page a-t-elle déjà sa capture d'étape ? La marque. */
function marquerLaCapture(page) {
  const visite = PAGES.get(page)?.courant;
  if (!visite || visite.capturee) return false;
  visite.capturee = true;
  return true;
}

/** Le compte, sur la page, des sélecteurs que le connecteur y a lus. */
function compterDansLaPage(selecteurs) {
  return selecteurs.map((s) => {
    try {
      return document.querySelectorAll(s).length;
    } catch {
      return null;
    }
  });
}

async function recompter(cadre, etatPage, { force = false } = {}) {
  const visite = etatPage?.courant;
  if (!visite || !ORIGINAUX.evaluateDeCadre) return;
  const maintenant = Date.now();
  if (!force && maintenant - visite.dernierRecompte < RECOMPTE_MS) return;
  visite.dernierRecompte = maintenant;
  const lus = [...visite.selecteurs].filter(([, s]) => String(s.api).includes('evaluate')).map(([sel]) => sel);
  if (!lus.length) return;
  let comptes = null;
  try {
    comptes = await ORIGINAUX.evaluateDeCadre.call(cadre?._frame || cadre, compterDansLaPage, lus);
  } catch {
    return;
  }
  if (etatPage.courant !== visite || !Array.isArray(comptes)) return;
  lus.forEach((sel, i) => {
    const s = visite.selecteurs.get(sel);
    if (!s || !Number.isFinite(comptes[i])) return;
    s.compte = comptes[i];
    s.max = Math.max(s.max ?? 0, comptes[i]);
    if (s.issue !== 'delai') s.issue = comptes[i] === 0 ? 'absent' : 'ok';
  });
}

/** Les accroches de prototypes, posées à la première page vue. */
function brancherPrototypes(page) {
  if (prototypesBranches || !page) return;
  prototypesBranches = true;
  try {
    const protoCadre = Object.getPrototypeOf(page.mainFrame());
    const protoLocalisateur = Object.getPrototypeOf(page.locator('html'));
    ORIGINAUX.screenshot = Object.getPrototypeOf(page).screenshot;
    envelopperEvaluate(protoCadre);
    envelopperGoto(protoCadre);
    const premierArgument = (_, args) => args[0];
    for (const nom of ['$', '$$', '$eval', '$$eval', 'waitForSelector', 'click', 'fill', 'check', 'selectOption',
      'textContent', 'innerText', 'getAttribute', 'isVisible', 'hover', 'press', 'type', 'dblclick']) {
      envelopper(protoCadre, nom, premierArgument);
    }
    const leSien = (localisateur) => localisateur._selector || String(localisateur);
    for (const nom of ['count', 'waitFor', 'click', 'fill', 'check', 'selectOption', 'textContent', 'innerText',
      'getAttribute', 'isVisible', 'inputValue', 'all', 'allTextContents', 'allInnerTexts', 'evaluate', 'evaluateAll',
      'hover', 'press', 'dblclick', 'pressSequentially']) {
      envelopper(protoLocalisateur, nom, leSien);
    }
  } catch { /* une forme inattendue de Playwright : le reste du journal tient */ }
}

/** Les requêtes directes du contexte (`context.request.get`…) : téléchargements et API. */
function brancherRequetes(contexte, passage) {
  const requete = contexte?.request;
  if (!requete) return;
  for (const nom of ['get', 'post', 'fetch']) {
    const original = requete[nom];
    if (typeof original !== 'function' || original.__crabeJournal) continue;
    const enveloppe = async function requeteJournalisee(adresse, ...reste) {
      const debut = Date.now();
      const methode = nom === 'fetch' ? String(reste[0]?.method || 'GET').toUpperCase() : nom.toUpperCase();
      const dite = navigation.adresseMasquee(typeof adresse === 'string' ? adresse : adresse?.url?.());
      try {
        const reponse = await original.call(this, adresse, ...reste);
        try {
          noterRequete(passage, `${methode} ${dite} → ${reponse.status()}`
            + `${typeDeContenu(reponse.headers?.()['content-type'])}`
            + `${tailleDe(reponse.headers?.()['content-length'])} en ${duree(Date.now() - debut)}`);
        } catch { /* noter ne doit jamais coûter la requête */ }
        return reponse;
      } catch (err) {
        noterRequete(passage, `${methode} ${dite} → échec après ${duree(Date.now() - debut)} (${messagePropre(err?.message)})`);
        throw err;
      }
    };
    Object.defineProperty(enveloppe, '__crabeJournal', { value: true });
    try {
      requete[nom] = enveloppe;
    } catch { /* objet gelé : pas de journal des requêtes directes */ }
  }
}

function typeDeContenu(brut) {
  const t = String(brut ?? '').split(';')[0].trim();
  return t ? ` ${t}` : '';
}

function tailleDe(brut) {
  const n = Number(brut);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1024 * 1024 ? `, ${(n / 1048576).toFixed(1).replace('.', ',')} Mo` : `, ${Math.max(1, Math.round(n / 1024))} Ko`;
}

function noterRequete(passage, texte) {
  const j = etatDuJournal(passage);
  if (j.requetes >= REQUETES_DETAILLEES) {
    j.requetesOmises += 1;
    return;
  }
  j.requetes += 1;
  ecrire(passage, `Requête directe : ${texte}.`);
}

// ---------------------------------------------------------------------------
// Les évènements d'un contexte et de ses pages
// ---------------------------------------------------------------------------

function suivrePage(page, passage) {
  if (!page || PAGES.has(page)) return;
  const etatPage = { passage, courant: null, departNavigation: null };
  PAGES.set(page, etatPage);
  brancherPrototypes(page);
  try {
    page.on('request', (requete) => {
      try {
        if (requete.isNavigationRequest() && requete.frame() === page.mainFrame()) etatPage.departNavigation = Date.now();
      } catch { /* requête illisible */ }
    });
    page.on('framenavigated', (cadre) => {
      try {
        if (cadre !== page.mainFrame()) return;
        const adresse = navigation.adresseMasquee(cadre.url());
        if (adresse === '(adresse non web)' || adresse === '(adresse illisible)') return;
        if (etatPage.courant && etatPage.courant.adresse === adresse) return;
        ecrireLaVisite(passage, etatPage.courant);
        etatPage.courant = nouvelleVisite(adresse, etatPage.departNavigation || Date.now(), etatPage.statut ?? null);
        etatPage.departNavigation = null;
        etatPage.statut = null;
      } catch { /* navigation illisible */ }
    });
    page.on('load', () => {
      const visite = etatPage.courant;
      if (!visite) return;
      visite.chargeeEn = Date.now() - visite.debut;
      page.title().then((t) => {
        if (etatPage.courant !== visite) return;
        const propre = textePropre(t);
        visite.titre = propre ? texteDeRepere(propre, { hote: visite.adresse.split('/')[0] }) : null;
      }).catch(() => {});
      try {
        visite.cadres = page.frames()
          .filter((f) => f !== page.mainFrame())
          .map((f) => navigation.adresseMasquee(f.url()))
          .filter((a) => a !== '(adresse non web)' && a !== '(adresse illisible)')
          .filter((a, i, tous) => tous.indexOf(a) === i)
          .slice(0, CADRES_PAR_PAGE);
      } catch { /* cadres illisibles */ }
      // Mode détaillé, en secours (une navigation par clic ne passe pas par
      // `goto`) : la page chargée, après un temps de dessin.
      if (passage.detail) require('./vue-de-page').captureDEtape(page, passage, { visite }).catch(() => {});
    });
    page.on('console', (message) => {
      try {
        if (message.type() !== 'error') return;
        const visite = etatPage.courant;
        if (visite && visite.console.length < CONSOLE_PAR_PAGE) visite.console.push(messagePropre(message.text()));
      } catch { /* message illisible */ }
    });
    page.on('pageerror', (err) => {
      const visite = etatPage.courant;
      if (visite && visite.console.length < CONSOLE_PAR_PAGE) visite.console.push(`erreur de script : ${messagePropre(`${err?.name ?? 'Error'}: ${err?.message ?? ''}`)}`);
    });
    page.on('download', (telechargement) => {
      try {
        ecrire(passage, `Téléchargement déclenché sur ${etatPage.courant?.adresse ?? navigation.adresseMasquee(page.url())}`
          + ` (depuis ${navigation.adresseMasquee(telechargement.url())}).`);
      } catch { /* téléchargement illisible */ }
    });
  } catch { /* page sans évènements */ }
}

/** Suit un contexte de navigateur pour le journal d'une récupération. */
function suivreContexte(contexte, passage) {
  if (!passage || !contexte?.on) return;
  try {
    for (const page of contexte.pages?.() || []) suivrePage(page, passage);
    contexte.on('page', (page) => suivrePage(page, passage));
    contexte.on('response', (reponse) => {
      try {
        const requete = reponse.request();
        const page = requete.frame().page();
        const etatPage = PAGES.get(page);
        if (!etatPage) return;
        if (requete.isNavigationRequest() && requete.frame() === page.mainFrame()) {
          // Le statut de la page QUI ARRIVE : la visite en cours est encore
          // celle d'avant, elle le recevra à sa navigation.
          etatPage.statut = reponse.status();
          return;
        }
        const nature = requete.resourceType();
        if (nature !== 'xhr' && nature !== 'fetch') return;
        const visite = etatPage.courant;
        if (!visite) return;
        const adresse = navigation.adresseMasquee(reponse.url());
        const cle = `${requete.method()} ${adresse}`;
        const deja = visite.appels.get(cle);
        if (deja) {
          deja.n += 1;
          deja.statut = reponse.status();
          return;
        }
        if (visite.appels.size >= APPELS_PAR_PAGE) return;
        visite.appels.set(cle, {
          methode: requete.method(),
          adresse,
          statut: reponse.status(),
          type: typeDeContenu(reponse.headers()['content-type']).trim(),
          n: 1,
        });
      } catch { /* réponse illisible */ }
    });
    brancherRequetes(contexte, passage);
  } catch { /* contexte sans évènements */ }
}

/** Les sélecteurs cherchés sur la page courante (pour la capture d'une étape). */
function selecteursDeLaPage(page) {
  return [...(PAGES.get(page)?.courant?.selecteurs.keys() || [])];
}

/** L'ouverture d'un navigateur, au journal. */
function noterOuverture(passage, dureeMs, persistant = false) {
  ecrire(passage, `Étape « ouverture » : navigateur ${persistant ? 'à profil persistant ' : ''}ouvert en ${duree(dureeMs)}.`);
}

/**
 * Avant la fermeture d'un contexte : le dernier recompte des sélecteurs lus,
 * puis la visite en cours de chaque page au journal. Rend, pour la vue de la
 * page, les sélecteurs qu'elle a vu chercher.
 */
async function clore(contexte, passage) {
  const sortie = new Map();
  let pages = [];
  try {
    pages = contexte.pages?.() || [];
  } catch {
    pages = [];
  }
  for (const page of pages) {
    const etatPage = PAGES.get(page);
    if (!etatPage?.courant) continue;
    try {
      await recompter(page.mainFrame(), etatPage, { force: true });
    } catch { /* page tombée */ }
    sortie.set(page, [...etatPage.courant.selecteurs.keys()]);
    ecrireLaVisite(passage, etatPage.courant);
  }
  const j = etatDuJournal(passage);
  if (j.omises) {
    ecrire(passage, `… et ${j.omises} autre(s) page(s), non détaillée(s) (${PAGES_DETAILLEES} au plus par récupération).`);
    j.omises = 0;
  }
  if (j.requetesOmises) {
    ecrire(passage, `… et ${j.requetesOmises} autre(s) requête(s) directe(s), non détaillée(s).`);
    j.requetesOmises = 0;
  }
  return sortie;
}

module.exports = {
  PAGES_DETAILLEES,
  SELECTEURS_PAR_PAGE,
  APPELS_PAR_PAGE,
  RECOMPTE_MS,
  ORIGINAUX,
  duree,
  textePropre,
  texteDeRepere,
  MOTS_USUELS,
  selecteurPropre,
  messagePropre,
  selecteursDeLaSource,
  natureDeLaPage,
  lignesDeLaVisite,
  suivreContexte,
  suivrePage,
  noterOuverture,
  selecteursDeLaPage,
  marquerLaCapture,
  visiteCourante,
  clore,
};
