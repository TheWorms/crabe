'use strict';

/**
 * Connecteur eDocPerso — le coffre-fort numérique où arrivent les bulletins
 * de paie.
 *
 * ─── Pourquoi une API et pas un navigateur ───────────────────────────────────
 *
 * L'application est une coquille Vue : toutes ses routes servent le même HTML
 * de 1 348 octets, et chaque écran se remplit par JSON sous `/edp-back`. Les
 * routes ont été relevées dans le code livré au navigateur puis sondées sans
 * identifiants (GET /api/v1/login → 405 « la route existe, POST attendu » ;
 * GET /api/v1/folders sans jeton → 401). Piloter un navigateur ici, ce serait
 * rejouer en fragile ce que quatre appels HTTP font en clair.
 *
 * ─── Le piège du tableau de bord ─────────────────────────────────────────────
 *
 * `/api/v1/user/homepage` rend « Mes derniers documents » — les DERNIERS
 * seulement. Un connecteur qui ne lirait que lui raterait tout l'historique :
 * même piège que le menu des années de Materiel.net. On parcourt donc l'ARBRE
 * ENTIER (`/api/v1/folders`, onglets « Mes Employeurs » et dossiers compris),
 * puis les documents de CHAQUE dossier, page par page.
 *
 * ─── La Corbeille n'est jamais ouverte ───────────────────────────────────────
 *
 * Le listage par dossier ne rend pas les documents supprimés : la page
 * Corbeille de l'application passe par un chargeur dédié
 * (« loadAllDeletedDocuments »), que ce connecteur n'appelle jamais. Par
 * précaution, un dossier dont le nom évoque la corbeille est aussi écarté de
 * la descente — si l'arbre en montrait un, on ne veut ni le lire ni y entrer.
 *
 * ─── Données de paie : des comptes, jamais des contenus ─────────────────────
 *
 * Les journaux de ce connecteur n'écrivent NI titre de document, NI nom de
 * dossier (le nom d'un employeur est une donnée), NI montant. Des comptes,
 * des identifiants internes tronqués, rien d'autre. Le titre ne sert qu'à
 * nommer le fichier déposé — c'est le rangement de l'utilisateur, pas un
 * journal.
 */

const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'edocperso';
const NOM = 'eDocPerso';
const BASE = 'https://edocperso.fr/edp-back';

const CHAMP_EMAIL = 'email';
const CHAMP_MOT_DE_PASSE = 'motDePasse';
const CHAMP_HISTORIQUE = 'historique';

const DELAI_MS = 30_000;
const DELAI_TELECHARGEMENT_MS = 60_000;
const PAUSE_DOCUMENT_MS = 300;
/** La taille de page relevée dans l'application elle-même (limit: 1e3). */
const PAR_PAGE = 1000;
/** Garde-fou de pagination : 50 pages = 50 000 documents par dossier. */
const PAGES_MAX = 50;

/** Un dossier dont le nom évoque la corbeille n'est ni lu, ni descendu. */
const MOTIF_CORBEILLE = /corbeille|trash|supprim/i;

// ---------------------------------------------------------------------------
// Erreurs — elles disent quoi faire, pas ce qui a planté
// ---------------------------------------------------------------------------

function erreurIdentifiantsManquants() {
  return new Error(
    'Renseignez votre adresse électronique et votre mot de passe eDocPerso sur la fiche du '
      + 'service, puis relancez.'
  );
}

function erreurIdentifiants() {
  return new Error(
    'eDocPerso a refusé la connexion. Vérifiez l\'adresse électronique et le mot de passe sur '
      + 'la fiche du service — ce sont ceux de edocperso.fr — puis réessayez.'
  );
}

function erreurConnexionDeleguee() {
  return new Error(
    'Votre compte eDocPerso se connecte par un service tiers (FranceConnect ou la connexion '
      + 'de votre entreprise), et crabe ne peut pas suivre ce chemin. Si votre compte a aussi '
      + 'un mot de passe eDocPerso, saisissez-le ; sinon ce coffre ne peut pas être relevé '
      + 'automatiquement.'
  );
}

function erreurSessionTombee(precision) {
  const err = new Error(
    'La connexion au coffre eDocPerso est tombée en cours de récupération. Rien n\'a été '
      + 'perdu — relancez la récupération.'
  );
  err.sessionExpired = true;
  err.precision = precision;
  return err;
}

// ---------------------------------------------------------------------------
// Appels HTTP
// ---------------------------------------------------------------------------

/** Un fetch borné dans le temps : l'API ne doit pas pouvoir suspendre crabe. */
async function appel(url, options = {}, delai = DELAI_MS) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delai);
  try {
    return await fetch(url, { ...options, signal: controleur.signal });
  } catch (err) {
    if (controleur.signal.aborted) {
      throw new Error(`${NOM} n'a pas répondu dans le temps imparti. Réessayez plus tard.`);
    }
    throw err;
  } finally {
    clearTimeout(minuteur);
  }
}

function enTetes(jeton) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
  };
}

/**
 * Se connecte et rend le jeton.
 *
 * Le jeton revient dans l'EN-TÊTE « Set-Authorization » de la réponse, pas
 * dans le corps — c'est ainsi que l'application elle-même le lit. Un corps
 * `{loginUrl}` sans jeton désigne une connexion déléguée (SSO d'entreprise,
 * FranceConnect) : on le dit, plutôt que d'accuser le mot de passe.
 */
async function seConnecter(config) {
  const email = String(config?.[CHAMP_EMAIL] || '').trim();
  const motDePasse = String(config?.[CHAMP_MOT_DE_PASSE] || '');
  if (!email || !motDePasse) throw erreurIdentifiantsManquants();

  const reponse = await appel(`${BASE}/api/v1/login`, {
    method: 'POST',
    headers: enTetes(null),
    body: JSON.stringify({ email, password: motDePasse }),
  });

  const jeton = reponse.headers.get('set-authorization');
  if (jeton) return jeton;

  let corps = null;
  try {
    corps = await reponse.json();
  } catch {
    /* un refus sans JSON reste un refus */
  }
  if (corps?.loginUrl) throw erreurConnexionDeleguee();
  throw erreurIdentifiants();
}

/** Un appel JSON authentifié ; 401/403 = la session est tombée. */
async function appelJson(jeton, chemin, { method = 'GET', corps = undefined } = {}) {
  const reponse = await appel(`${BASE}${chemin}`, {
    method,
    headers: enTetes(jeton),
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  if (reponse.status === 401 || reponse.status === 403) {
    throw erreurSessionTombee(`HTTP ${reponse.status} sur ${chemin}`);
  }
  if (!reponse.ok) {
    throw new Error(`${NOM} a répondu ${reponse.status} sur ${chemin}. Réessayez plus tard.`);
  }
  try {
    return await reponse.json();
  } catch {
    throw new Error(`${NOM} a répondu autre chose que du JSON sur ${chemin}.`);
  }
}

// ---------------------------------------------------------------------------
// Lecture de l'arbre et des documents — formes TOLÉRÉES, jamais devinées
// ---------------------------------------------------------------------------

/**
 * Aplati l'arbre des dossiers, quelle que soit son enveloppe.
 *
 * La forme exacte de `/api/v1/folders` n'a pas pu être vue sans compte : on
 * accepte un tableau nu ou une enveloppe ({folders|data|content|items}), et
 * des enfants imbriqués ({children|subFolders|folders}). Tout nœud portant un
 * `id` est un dossier. Un dossier « corbeille » est écarté AVEC sa descente.
 */
function aplatirDossiers(brut) {
  const racines = Array.isArray(brut)
    ? brut
    : brut?.folders || brut?.data || brut?.content || brut?.items || [];

  const dossiers = [];
  const vus = new Set();

  const descendre = (noeud, parents = []) => {
    if (!noeud || typeof noeud !== 'object') return;
    const nom = String(noeud.name ?? noeud.title ?? noeud.label ?? '');
    if (MOTIF_CORBEILLE.test(nom)) return; // ni lu, ni descendu
    // Le CHEMIN du dossier dans le coffre (« Mes Employeurs/EMPLOYEUR-UN ») :
    // c'est le rangement de l'utilisateur, et c'est lui que le dépôt reproduit
    // à la place du niveau d'année (lot 38). Un nœud sans nom ne crée pas de
    // niveau vide.
    const chemin = nom ? [...parents, nom] : parents;
    const id = noeud.id ?? noeud.folderId ?? null;
    if (id !== null && id !== undefined && !vus.has(String(id))) {
      vus.add(String(id));
      dossiers.push({ id, nom, chemin });
    }
    for (const cle of ['children', 'subFolders', 'folders']) {
      if (Array.isArray(noeud[cle])) noeud[cle].forEach((enfant) => descendre(enfant, chemin));
    }
  };

  racines.forEach((racine) => descendre(racine, []));
  return dossiers;
}

/** Les documents d'une réponse de listage, quelle que soit son enveloppe. */
function documentsDeLaReponse(brut) {
  const liste = Array.isArray(brut)
    ? brut
    : brut?.documents || brut?.data || brut?.content || brut?.items || [];
  return liste.filter((d) => d && typeof d === 'object' && (d.id ?? null) !== null);
}

/**
 * La période lue dans le TITRE du document — c'est elle qui range.
 *
 * « Bulletins 12/2025 » → 2025-12-01. L'année vient de la période du document,
 * jamais de la date de récupération : un bulletin de décembre récupéré en
 * février doit dormir dans 2025, pas dans 2026. À défaut de « MM/AAAA », une
 * année seule suffit au rangement ; à défaut de tout, les dates portées par
 * l'API sont tentées, puis le document part en « inconnu/ » plutôt que d'être
 * daté du jour.
 */
function periodeDepuisTitre(titre) {
  const texte = String(titre || '');
  const moisAnnee = /\b(0?[1-9]|1[0-2])\s*\/\s*(20\d{2})\b/.exec(texte);
  if (moisAnnee) return `${moisAnnee[2]}-${moisAnnee[1].padStart(2, '0')}-01`;
  const annee = /\b(20\d{2})\b/.exec(texte);
  if (annee) return `${annee[1]}-01-01`;
  return null;
}

/** La date d'un document : sa période d'abord, les champs de l'API ensuite. */
function dateDuDocument(doc) {
  const parTitre = periodeDepuisTitre(doc?.title ?? doc?.name);
  if (parTitre) return parTitre;
  for (const cle of ['addedDate', 'creationDate', 'createdAt', 'depositDate', 'uploadDate', 'date']) {
    const brut = doc?.[cle];
    if (!brut) continue;
    const iso = String(brut).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  return null;
}

/** Un morceau de titre assez propre pour un NOM DE FICHIER (jamais un journal). */
function bribeDeTitre(titre) {
  const propre = String(titre || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return propre || 'document';
}

function nomFichier(doc, issuedOn) {
  // Le nom reprend le titre du coffre — c'est le rangement de l'utilisateur.
  // Ni préfixe du connecteur (le chemin de dépôt le porte déjà), ni période
  // (elle est dans le titre). Le court identifiant reste : « Bulletins
  // 08/2025 » existe trois fois dans un même dossier (mesuré le 18/08/2026),
  // le titre seul écraserait des documents distincts.
  const id = String(doc.id).replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8) || 'sans-id';
  return `${bribeDeTitre(doc.title ?? doc.name)}_${id}.pdf`;
}

/**
 * Tous les documents d'un dossier, page par page.
 *
 * Le POST de LISTAGE est celui de l'application elle-même :
 * `{paging:{limit,offset}, folderId}`. On pagine tant que la page est pleine.
 */
async function documentsDuDossier(jeton, folderId) {
  const documents = [];
  for (let page = 0; page < PAGES_MAX; page++) {
    const brut = await appelJson(jeton, '/api/v1/documents', {
      method: 'POST',
      corps: { paging: { limit: PAR_PAGE, offset: page * PAR_PAGE }, folderId },
    });
    const lot = documentsDeLaReponse(brut);
    documents.push(...lot);
    if (lot.length < PAR_PAGE) return documents;
  }
  return documents;
}

/** Télécharge UN document ; le contenu fait foi, jamais l'en-tête. */
async function telecharger(jeton, documentId) {
  const reponse = await appel(
    `${BASE}/api/v1/documents/download`,
    {
      method: 'POST',
      // Le coffre sert un binaire : annoncer « application/json » lui faisait
      // rendre 406 sur chaque document (mesuré le 18/08/2026, 13/13 refusés).
      // On annonce accepter tout ; le contenu fait foi, jamais l'en-tête.
      headers: { ...enTetes(jeton), Accept: '*/*' },
      body: JSON.stringify({ documentIds: [documentId], folderIds: [] }),
    },
    DELAI_TELECHARGEMENT_MS
  );
  if (reponse.status === 401 || reponse.status === 403) {
    throw erreurSessionTombee(`HTTP ${reponse.status} au téléchargement`);
  }
  if (!reponse.ok) return { buffer: null, statut: reponse.status };
  return { buffer: Buffer.from(await reponse.arrayBuffer()), statut: reponse.status };
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : connexion, et l'arbre des dossiers se lit. */
async function test(config, ctx = {}) {
  const jeton = await seConnecter(config);
  const dossiers = aplatirDossiers(await appelJson(jeton, '/api/v1/folders'));

  return {
    ok: true,
    accountId: String(config?.[CHAMP_EMAIL] || '').trim().toLowerCase() || null,
    invoiceCount: undefined,
    message:
      `Connexion valide — ${dossiers.length} dossier(s) dans votre coffre. `
      + 'La première récupération parcourra chacun d\'eux.',
  };
}

/** Parcourt l'arbre entier et récupère les documents nouveaux. */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  const compte = String(config?.[CHAMP_EMAIL] || '').trim().toLowerCase() || null;
  const jeton = await seConnecter(config);
  log(`${ID} : connexion acceptée, lecture de l'arbre des dossiers.`);

  const dossiers = aplatirDossiers(await appelJson(jeton, '/api/v1/folders'));
  log(`${ID} : ${dossiers.length} dossier(s) à parcourir (corbeille exclue d'office).`);

  // La racine du coffre peut porter des documents hors de tout dossier : on la
  // tente UNE fois. Si l'API refuse cette forme, on le dit et on continue —
  // les dossiers, eux, sont le parcours principal.
  const aParcourir = [{ id: null, nom: '(racine)', chemin: [] }, ...dossiers];

  const releves = [];
  const vus = new Set();
  let dossiersLus = 0;

  for (const dossier of aParcourir) {
    let documents;
    try {
      documents = await documentsDuDossier(jeton, dossier.id);
    } catch (err) {
      if (err.sessionExpired) throw err;
      if (dossier.id === null) {
        log(`${ID} : la racine ne se liste pas séparément (${err.message}) — les dossiers suffisent.`);
        continue;
      }
      // Un dossier illisible ne fait pas taire les autres, mais il se voit.
      log(`${ID} : un dossier n'a pas pu être lu (${err.message}) — les autres continuent.`);
      continue;
    }
    dossiersLus++;
    for (const doc of documents) {
      if (vus.has(String(doc.id))) continue; // un document peut se montrer deux fois
      vus.add(String(doc.id));
      // Le document retient le dossier où il a été VU en premier : c'est ce
      // chemin-là que le dépôt reproduit (lot 38).
      releves.push({ doc, chemin: dossier.chemin || [] });
    }
  }

  if (dossiersLus === 0) {
    throw new Error(
      `Le coffre ${NOM} s'est laissé ouvrir mais aucun dossier n'a pu être lu : impossible de `
        + 'dire ce qu\'il contient. Réessayez plus tard ; si le message revient, signalez-le.'
    );
  }

  // La preuve exigée par le socle (lot 31) : le jeton a été accepté, l'arbre
  // et les listes ont été effectivement lus — c'est ce qui autorise « aucun
  // nouveau document » quand tout est déjà récupéré.
  ctx.preuveDeListe?.({
    session: 'jeton de connexion accepté par le coffre',
    liste: `${dossiersLus} dossier(s) du coffre listé(s) par l'API`,
    elements: releves.length,
  });

  log(`${ID} : ${releves.length} document(s) listé(s) dans ${dossiersLus} dossier(s).`);

  const invoices = [];
  let horsFenetre = 0;
  let pasPdf = 0;
  let manques = 0;

  for (const { doc, chemin } of releves) {
    const remoteId = `${ID}-${doc.id}`;
    if (connus.has(remoteId)) continue;

    const issuedOn = dateDuDocument(doc);
    if (!scraping.dansLaFenetre(issuedOn, plan)) {
      horsFenetre++;
      continue;
    }

    const { buffer, statut } = await telecharger(jeton, doc.id);
    if (!buffer) {
      manques++;
      log(`${ID} : document ${pageDocs.idPourJournal(doc.id)} — HTTP ${statut}, ignoré pour cette fois.`);
      continue;
    }
    if (!identity.estPdf(buffer)) {
      // Un coffre peut contenir autre chose que des PDF (une photo, un zip) :
      // ce n'est pas une panne, on le compte et on ne dépose que du PDF.
      pasPdf++;
      continue;
    }

    invoices.push({
      accountId: compte,
      remoteId,
      filename: nomFichier(doc, issuedOn),
      issuedOn,
      buffer,
      // Les dossiers du coffre remplacent le niveau d'année au dépôt (lot 38) :
      // le rangement de l'utilisateur fait foi. Vide (racine) = année.
      sousChemin: chemin.length ? chemin : null,
    });
    await new Promise((r) => setTimeout(r, PAUSE_DOCUMENT_MS));
  }

  log(
    `${ID} : ${invoices.length} document(s) déposé(s)`
      + (horsFenetre ? `, ${horsFenetre} hors de la fenêtre demandée` : '')
      + (pasPdf ? `, ${pasPdf} écarté(s) (pas des PDF)` : '')
      + (manques ? `, ${manques} non servi(s) par le coffre` : '')
      + '.'
  );

  return { accountId: compte, invoices };
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  aplatirDossiers,
  documentsDeLaReponse,
  periodeDepuisTitre,
  dateDuDocument,
  nomFichier,
  bribeDeTitre,
  seConnecter,
  BASE,
  MOTIF_CORBEILLE,
};
