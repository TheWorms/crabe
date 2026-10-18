'use strict';

/**
 * « Mes documents » en explorateur (lot 107) — une page de documents à la fois.
 *
 * ─── Ce que cette lecture est, et n'est pas ──────────────────────────────────
 *
 * Une lecture de la BASE de crabe, et de rien d'autre : ni rclone, ni réseau,
 * ni le système de fichiers d'une destination. Elle dit ce que crabe a
 * enregistré de chaque dépôt (`invoices.destinations`), pas ce qu'un stockage
 * contient à l'instant — le téléchargement, lui, ira le chercher (la route de
 * toujours, avec sa garde).
 *
 * Elle ne rend JAMAIS la liste entière : quarante documents au plus par page,
 * filtrés, cherchés et triés par SQLite, pour le compte connecté seulement
 * (`user_id = ?` dans chaque requête). Les paramètres passent par des listes
 * fermées ; la recherche est un paramètre lié, jamais un morceau de requête.
 *
 * ─── Présent sur une destination ─────────────────────────────────────────────
 *
 * Un document est présent sur une destination quand la base porte un dépôt
 * réussi pour elle : état `ok`, ou `unknown` (dépôt d'avant le suivi détaillé)
 * avec `ok: true`. Une clé absente, une copie en attente ou en échec : absent.
 * L'interface de base est un rien plus large (`unknown` sans condition) ; sur
 * la production, les deux règles donnent le même ensemble (mesuré au lot 107 :
 * les 6 dépôts `unknown` portent tous `ok: true`).
 *
 * ─── Ce que la base ne porte pas ─────────────────────────────────────────────
 *
 * La période se CALCULE (`invoices.periodOf` : émission, nom, récupération) —
 * la même fonction, enregistrée dans SQLite, filtre et trie. Le libellé d'un
 * compte se calcule aussi (`documents.titresDesComptes`, lots 96–97 : jamais
 * l'identifiant entier). Une taille nulle n'est pas une taille : elle part
 * `null`, et l'écran dit « — ».
 */

const db = require('./db/db');
const registry = require('./connectors/registry');
const tri = require('./connectors/tri');
const invoicesLib = require('./invoices');
const documents = require('./documents');
const destinations = require('./destinations');
const dossier = require('./destinations/dossier');

// Le stockage local, nommé en un seul endroit (comme au lot 98).
const LOCAL = 'local';

/** Une page : quarante documents au plus. */
const PAR_PAGE = 40;

/** La recherche, bornée. */
const RECHERCHE_MAX = 100;

/** Le dernier rang de page admis (400 000 documents) : au-delà, la demande est forgée. */
const PAGE_MAX = 10_000;

/**
 * Les tris, en liste fermée : la valeur reçue CHOISIT un fragment écrit ici,
 * elle n'entre jamais dans la requête. Chaque ordre finit par l'identifiant :
 * deux documents égaux gardent toujours le même ordre d'une page à l'autre.
 */
const TRIS = {
  recents: 'fetched_at DESC, id DESC',
  nom: 'crabe_cle_nom(filename) ASC, id ASC',
  periode: 'periode DESC, id DESC',
  taille: 'size_bytes DESC, id DESC',
};

const TRI_DEFAUT = 'recents';

const FORME_SERVICE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORME_ANNEE = /^(19[7-9]\d|20\d\d|2100)$/;
const FORME_PAGE = /^\d{1,5}$/;

/** Une demande refusée : 400, et la phrase qui dit pourquoi. */
class DemandeRefusee extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Minuscules, sans accents : « Échéance » et « echeance » se trouvent. */
function plier(texte) {
  return String(texte ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * La clé de tri d'un nom : pliée, et les nombres alignés (« facture 9 » avant
 * « facture 10 »), comme le classement du reste de crabe (`tri.js` : français,
 * insensible aux accents, numérique).
 */
function cleDeNom(texte) {
  return plier(texte).replace(/\d+/g, (n) => n.replace(/^0+(?=\d)/, '').padStart(20, '0'));
}

/** Le dépôt enregistré de `destId` dit-il le document présent ? */
function estDepose(colonne, destId) {
  const depots = invoicesLib.parseDestinations(colonne);
  if (!Object.prototype.hasOwnProperty.call(depots, destId)) return false;
  const depot = invoicesLib.normalizeOutcome(depots[destId]);
  return depot.state === 'ok' || (depot.state === 'unknown' && depot.ok === true);
}

/**
 * Les fonctions de l'explorateur, enregistrées UNE fois par connexion. Toutes
 * déterministes, toutes sans effet : elles lisent la ligne qu'on leur passe.
 */
const connexionsPreparees = new WeakSet();

function connexion() {
  const conn = db.get();
  if (!connexionsPreparees.has(conn)) {
    const fixe = { deterministic: true };
    conn.function('crabe_periode', fixe, (issuedOn, filename, fetchedAt) =>
      invoicesLib.periodOf({ issued_on: issuedOn, filename, fetched_at: fetchedAt }));
    conn.function('crabe_depose', fixe, (colonne, destId) => (estDepose(colonne, destId) ? 1 : 0));
    conn.function('crabe_plier', fixe, (texte) => plier(texte));
    conn.function('crabe_cle_nom', fixe, (texte) => cleDeNom(texte));
    connexionsPreparees.add(conn);
  }
  return conn;
}

/** Une valeur de l'adresse : une chaîne, ou rien. Deux valeurs pour une clé : refusé. */
function valeurUnique(query, cle) {
  const v = query?.[cle];
  if (v === undefined || v === '') return '';
  if (typeof v !== 'string') throw new DemandeRefusee(`Le paramètre « ${cle} » est donné plusieurs fois.`);
  return v;
}

/** Les espaces de stockage du compte, dans l'ordre de « Mes documents ». */
function espacesDe(user) {
  const catalogue = require('./destinations/catalogue');
  const actives = destinations.destinationsForUser(user.id);
  // Le stockage local en tête, comme dans l'interface de base.
  const ordre = [...actives.filter((id) => id === LOCAL), ...actives.filter((id) => id !== LOCAL)];
  return ordre.map((id) => {
    const style = catalogue.brand(id);
    return { id, name: style.name, letter: style.letter, color: style.color, logo: style.logo || null, logoInterne: !!style.logoInterne };
  });
}

/**
 * Ce que crabe sait du service : nom, couleur, lettres, logo (le catalogue,
 * comme l'interface de base) — ou son seul identifiant, s'il a disparu.
 */
function styleDuService(catalogue, id) {
  const c = catalogue.get(id);
  if (!c) return { nom: id, couleur: '#63666e', lettres: '?', logo: null };
  return { nom: c.name || id, couleur: c.color || '#63666e', lettres: c.letters || '?', logo: c.logo || null };
}

/**
 * Valide la demande, ou la refuse (400). Rend les valeurs retenues.
 *
 * @param {object} query `req.query`
 * @param {string[]} espaces les identifiants des espaces du compte
 * @param {Set<string>} sesServices les services où le compte a des documents
 */
function lireDemande(query, espaces, sesServices) {
  const espace = valeurUnique(query, 'espace');
  if (espace && !espaces.includes(espace)) throw new DemandeRefusee('Espace de stockage inconnu.');

  const service = valeurUnique(query, 'service');
  if (service && (!FORME_SERVICE.test(service) || !(registry.has(service) || sesServices.has(service)))) {
    throw new DemandeRefusee('Service inconnu.');
  }

  const annee = valeurUnique(query, 'annee');
  if (annee && !FORME_ANNEE.test(annee)) throw new DemandeRefusee('Année inconnue : quatre chiffres attendus.');

  const triDemande = valeurUnique(query, 'tri') || TRI_DEFAUT;
  if (!Object.prototype.hasOwnProperty.call(TRIS, triDemande)) {
    throw new DemandeRefusee('Tri inconnu : récents, nom, période ou taille.');
  }

  const q = valeurUnique(query, 'q').trim();
  if ([...q].length > RECHERCHE_MAX) {
    throw new DemandeRefusee(`Recherche trop longue : ${RECHERCHE_MAX} caractères au plus.`);
  }

  const pageBrute = valeurUnique(query, 'page') || '1';
  const page = FORME_PAGE.test(pageBrute) ? Number(pageBrute) : 0;
  if (page < 1 || page > PAGE_MAX) throw new DemandeRefusee('Page inconnue.');

  return {
    espace: espace || (espaces.includes(LOCAL) ? LOCAL : espaces[0] || ''),
    service,
    annee,
    tri: triDemande,
    q,
    page,
  };
}

/** Les libellés des comptes, pour les services qui en ont plusieurs sur cet espace. */
function libellesDesComptes(user, comptesParService) {
  const multiples = [...comptesParService].filter(([, comptes]) => comptes.length > 1);
  if (!multiples.length) return new Map();
  const noms = documents.nomsDeComptesConnus(user.id, multiples.map(([id]) => id));
  const libelles = new Map();
  for (const [service, comptes] of multiples) {
    const titres = documents.titresDesComptes(comptes.map((cle) => ({ cle, nom: noms.get(service)?.get(cle) || null })));
    libelles.set(service, titres);
  }
  return libelles;
}

/**
 * Une page de l'explorateur.
 *
 * @param {object} user le compte connecté (`req.user`) — SEUL compte lu
 * @param {object} query `req.query` : espace, service, annee, q, tri, page
 * @throws {DemandeRefusee} paramètre hors liste (400)
 */
function lire(user, query = {}) {
  const conn = connexion();
  const espaces = espacesDe(user);
  const idsEspaces = espaces.map((e) => e.id);

  // Les services du compte, toutes destinations confondues : un service dont
  // le catalogue a perdu la trace reste un filtre valable pour SES documents.
  const sesServices = new Set(
    conn.prepare('SELECT DISTINCT connector_id FROM invoices WHERE user_id = ?').pluck().all(user.id)
  );
  const demande = lireDemande(query, idsEspaces, sesServices);
  const filtre = { service: demande.service, annee: demande.annee, q: demande.q, tri: demande.tri };

  if (!demande.espace) {
    return {
      espaces, espace: null,
      raison: 'Aucun espace de stockage n\'est activé par l\'administrateur.',
      total: 0, services: [], filtre, page: 1, parPage: PAR_PAGE, correspondants: 0, suite: false, documents: [],
    };
  }

  // ─── L'arbre : services et années du compte sur cet espace ────────────────
  const groupes = conn.prepare(
    `SELECT connector_id AS service, substr(crabe_periode(issued_on, filename, fetched_at), 1, 4) AS annee,
            COUNT(*) AS nombre
       FROM invoices
      WHERE user_id = ? AND crabe_depose(destinations, ?) = 1
      GROUP BY connector_id, annee`
  ).all(user.id, demande.espace);

  const parService = new Map();
  for (const g of groupes) {
    if (!parService.has(g.service)) parService.set(g.service, { nombre: 0, annees: [] });
    const s = parService.get(g.service);
    s.nombre += g.nombre;
    s.annees.push({ annee: g.annee, nombre: g.nombre });
  }

  const catalogue = new Map(registry.listAll().map((c) => [c.id, c]));
  const services = tri.parNom(
    [...parService].map(([id, s]) => {
      const style = styleDuService(catalogue, id);
      return {
        id,
        ...style,
        nombre: s.nombre,
        annees: s.annees.sort((a, b) => String(b.annee).localeCompare(String(a.annee))),
        // Le dossier DU SERVICE (lot 106) : le niveau suivant du chemin réel
        // est l'identifiant du compte, que le lot 96 a retiré de l'écran.
        dossier: dossier.dossierDe(demande.espace, { user, connectorName: style.nom }),
      };
    }),
    (s) => s.nom
  );
  const total = services.reduce((n, s) => n + s.nombre, 0);

  // ─── Les comptes : un libellé seulement là où il y en a plusieurs ─────────
  const comptesParService = new Map();
  for (const ligne of conn.prepare(
    `SELECT connector_id AS service, COALESCE(account_id, '') AS compte
       FROM invoices
      WHERE user_id = ? AND crabe_depose(destinations, ?) = 1
      GROUP BY 1, 2`
  ).all(user.id, demande.espace)) {
    if (!comptesParService.has(ligne.service)) comptesParService.set(ligne.service, []);
    comptesParService.get(ligne.service).push(ligne.compte);
  }
  const libelles = libellesDesComptes(user, comptesParService);

  // ─── La requête : toutes ses valeurs sont des paramètres liés ─────────────
  const conditions = ['user_id = ?', 'crabe_depose(destinations, ?) = 1'];
  const valeurs = [user.id, demande.espace];
  if (demande.service) {
    conditions.push('connector_id = ?');
    valeurs.push(demande.service);
  }
  if (demande.annee) {
    conditions.push('substr(crabe_periode(issued_on, filename, fetched_at), 1, 4) = ?');
    valeurs.push(demande.annee);
  }
  if (demande.q) {
    // Nom du fichier, nom du service, libellé du compte (là où il s'affiche).
    // Les services et les comptes dont le NOM correspond se trouvent ici, en
    // JavaScript, et partent en paramètres (une liste JSON) : la saisie
    // n'entre jamais dans le texte de la requête.
    const cherche = plier(demande.q);
    const servicesTrouves = services.filter((s) => plier(s.nom).includes(cherche)).map((s) => s.id);
    const comptesTrouves = [];
    for (const [service, titres] of libelles) {
      for (const [cle, titre] of titres) {
        if (plier(titre).includes(cherche)) comptesTrouves.push(`${service}\u001f${cle}`);
      }
    }
    conditions.push(`(instr(crabe_plier(filename), ?) > 0
      OR connector_id IN (SELECT value FROM json_each(?))
      OR (connector_id || char(31) || COALESCE(account_id, '')) IN (SELECT value FROM json_each(?)))`);
    valeurs.push(cherche, JSON.stringify(servicesTrouves), JSON.stringify(comptesTrouves));
  }
  const ou = conditions.join(' AND ');

  const correspondants = conn.prepare(`SELECT COUNT(*) FROM invoices WHERE ${ou}`).pluck().get(...valeurs);
  const lignes = conn.prepare(
    `SELECT id, connector_id, filename, account_id, size_bytes, fetched_at,
            crabe_periode(issued_on, filename, fetched_at) AS periode
       FROM invoices
      WHERE ${ou}
      ORDER BY ${TRIS[demande.tri]}
      LIMIT ? OFFSET ?`
  ).all(...valeurs, PAR_PAGE + 1, (demande.page - 1) * PAR_PAGE);

  const suite = lignes.length > PAR_PAGE;
  const documentsDeLaPage = lignes.slice(0, PAR_PAGE).map((l) => ({
    id: l.id,
    nom: l.filename,
    service: l.connector_id,
    compte: libelles.get(l.connector_id)?.get(l.account_id || '') || null,
    periode: l.periode || null,
    taille: Number(l.size_bytes) > 0 ? Number(l.size_bytes) : null,
    recupereLe: l.fetched_at || null,
  }));

  return {
    espaces,
    espace: espaces.find((e) => e.id === demande.espace),
    raison: null,
    total,
    services,
    filtre,
    page: demande.page,
    parPage: PAR_PAGE,
    correspondants,
    suite,
    documents: documentsDeLaPage,
  };
}

module.exports = { PAR_PAGE, RECHERCHE_MAX, TRIS, DemandeRefusee, plier, cleDeNom, estDepose, lire };
