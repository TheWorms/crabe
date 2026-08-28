'use strict';

/**
 * Le bandeau « une tâche est en cours » (lot 59).
 *
 * ─── Ce que ce module rassemble ──────────────────────────────────────────────
 *
 * crabe sait mener trois opérations longues — le renommage des documents (et
 * son annulation), la synchronisation forcée vers les destinations, et les
 * récupérations chez les fournisseurs — plus l'optimisation de l'installation
 * (lot 60). Chacune expose déjà son état quelque part : un objet en mémoire,
 * un verrou, une ligne de `run_logs`. Ce module les lit TOUS et les présente
 * sous une forme unique, pour que l'interface affiche un bandeau sur toutes
 * les pages sans connaître le détail de chaque chantier.
 *
 * ─── Ce qu'il ne fait jamais ─────────────────────────────────────────────────
 *
 *   - **Aucune sonde réseau.** Tout est lu en mémoire ou en base locale —
 *     leçon des lots 53-bis et 57 : un écran qui sondait un cloud à chaque
 *     affichage a tué une session Proton. Interroger cette vue ne coûte rien
 *     et ne touche aucun service distant.
 *   - **Aucune invention.** Une opération arrêtée sur erreur n'est pas « en
 *     cours » ; un état qui ne peut pas être établi ne produit pas de bandeau.
 *   - Un REFUS de démarrage (préalable non rempli) n'est pas une opération :
 *     rien n'a commencé, la phrase se lit là où le geste a été fait.
 *
 * ─── Forme d'une opération ───────────────────────────────────────────────────
 *
 *   { cle,        — identifiant stable (type + instant de départ) : la croix
 *                   « fermer » du bandeau de fin s'y accroche
 *     type,       — 'renommage' | 'synchronisation' | 'recuperation' | 'optimisation'
 *     titre,      — « Renommage des documents », « Récupération Free Internet »…
 *     etat,       — 'en-cours' | 'succes' | 'echec'
 *     detail,     — la phrase courte : « 12 sur 324 », le compte rendu…
 *     faites, total, — l'avancement chiffré quand il existe, sinon null
 *     ecran,      — où mène le clic : 'profil-fichiers' | 'home' | 'admin-optimisation'
 *     demarreLe, termineLe }
 *
 * ─── Combien de temps une fin reste annoncée (lot 65) ───────────────────────
 *
 * Jusqu'au lot 64, une fin restait annoncée dix minutes, quel que soit son
 * état. Le 26/08/2026 à 12:10, six récupérations lancées ensemble ont donc
 * empilé six bandeaux pleine largeur pendant dix minutes, et repoussé
 * l'accueil vers le bas. Deux fenêtres, désormais, parce que les deux fins ne
 * demandent pas la même chose du lecteur :
 *
 *   - un SUCCÈS ne demande aucune décision. Il s'annonce, puis s'efface tout
 *     seul — l'écran compte quinze secondes depuis `termineLe` (voir
 *     `majBandeauOperations`, web/app.js). La fenêtre serveur de deux minutes
 *     n'est là que pour laisser à l'écran de quoi tenir ce compte : elle est
 *     large devant la cadence de veille (4 s) et courte devant la mémoire de
 *     celui qui regarde.
 *
 *   - un ÉCHEC demande une décision. L'écran ne l'efface JAMAIS de lui-même :
 *     il part à la croix, ou quand l'écran concerné est ouvert. Le serveur, lui,
 *     le sert une heure. Ce n'est pas l'écran qui renonce, c'est la vue qui
 *     cesse d'appeler ça « ce qui vient de se passer » : au-delà d'une heure,
 *     l'échec appartient au journal et à la fiche du connecteur. Sans cette
 *     borne, chaque échec d'une récupération planifiée de la nuit accueillerait
 *     l'utilisateur au petit déjeuner comme une alerte fraîche — précisément ce que la
 *     fenêtre du lot 59 évitait. **Décision assumée, pas un défaut** : le brief
 *     demandait de la dire plutôt que de la prendre en silence.
 *
 * Le résultat complet, lui, est durable : journaux de l'écran Logs pour les
 * opérations d'installation, historique de la fiche pour les récupérations.
 */

const db = require('./db/db');

/** Minutes pendant lesquelles une fin est encore annoncée, selon son état. */
const FENETRE_SUCCES_MIN = 2;
const FENETRE_ECHEC_MIN = 60;

/**
 * Nombre maximal de récupérations finies remontées d'un coup.
 *
 * Très au-dessus de tout cas réel — les récupérations d'une balayée manuelle
 * s'enchaînent une par une, et la fenêtre de deux minutes n'en laisse
 * coexister qu'une poignée. Les échecs sont classés d'abord (`ORDER BY
 * success ASC`) : si cette borne devait un jour mordre, elle sacrifierait des
 * succès, jamais un échec.
 */
const MAX_FINIES = 20;

/** Longueur maximale du détail d'une ligne de bandeau. Voir `phraseCourte`. */
const LONGUEUR_DETAIL = 140;

/** L'instant est-il dans la fenêtre d'annonce de fin de CET état ? */
function recent(isoOuSql, etat) {
  if (!isoOuSql) return false;
  // `run_logs` écrit « YYYY-MM-DD HH:MM:SS » (UTC, datetime('now')) ; les états
  // mémoire écrivent de l'ISO. Le « Z » rétabli, Date lit les deux en UTC.
  const t = Date.parse(String(isoOuSql).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
  if (!Number.isFinite(t)) return false;
  const minutes = etat === 'echec' ? FENETRE_ECHEC_MIN : FENETRE_SUCCES_MIN;
  return Date.now() - t <= minutes * 60 * 1000;
}

/**
 * Le détail d'une ligne de bandeau : UNE phrase, jamais un mode d'emploi.
 *
 * Un connecteur écrit son compte rendu pour SA fiche, où il y a la place de
 * tout lire — Decathlon fait 565 caractères, Bricomarché 451, et `propolia` a
 * déjà écrit 1834 caractères sur 31 lignes. Recopié tel quel, ce texte
 * déversait quatre lignes dans le bandeau, mot pour mot identiques à ce que la
 * carte du connecteur disait déjà dessous.
 *
 * Le bandeau dit ce qui s'est passé ; la carte dit le détail. La coupure est
 * la fin de la première phrase — même idiome que `fieldHelp` (lot 57) —, et si
 * cette première phrase est elle-même trop longue, elle est coupée au dernier
 * mot entier. Jamais au milieu d'un mot.
 */
function phraseCourte(texte) {
  const brut = String(texte == null ? '' : texte).replace(/\s+/g, ' ').trim();
  if (!brut) return null;

  const fin = brut.indexOf('. ');
  const premiere = fin === -1 ? brut : brut.slice(0, fin + 1);
  if (premiere.length <= LONGUEUR_DETAIL) return premiere;

  const tronque = premiere.slice(0, LONGUEUR_DETAIL);
  const espace = tronque.lastIndexOf(' ');
  const mots = espace > LONGUEUR_DETAIL / 3 ? tronque.slice(0, espace) : tronque;
  return `${mots.replace(/[\s,;:—–-]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Les sources, une par opération
// ---------------------------------------------------------------------------

/** Renommage / annulation — visible de son seul propriétaire. */
function renommagePour(user, ops) {
  const h = require('./harmonisation').progress();
  if (h.userId !== user.id) return;

  const titre = h.phase === 'annulation' || (!h.running && h.phaseFinie === 'annulation')
    ? 'Annulation du renommage'
    : 'Renommage des documents';

  if (h.running) {
    ops.push({
      cle: `renommage:${h.demarreLe}`,
      type: 'renommage',
      titre,
      etat: 'en-cours',
      detail: h.total ? `${h.faites} sur ${h.total}` : h.message || 'vérifications…',
      faites: h.total ? h.faites : null,
      total: h.total || null,
      ecran: 'profil-fichiers',
      demarreLe: h.demarreLe,
      termineLe: null,
    });
    return;
  }

  // Refus de préalable : rien n'a commencé, rien à annoncer (voir l'en-tête).
  const etat = h.arret ? 'echec' : 'succes';
  if (h.refus || !recent(h.termineLe, etat)) return;

  ops.push({
    cle: `renommage:${h.demarreLe}`,
    type: 'renommage',
    titre,
    etat,
    detail: h.arret || h.message || 'Terminé.',
    faites: null,
    total: null,
    ecran: 'profil-fichiers',
    demarreLe: h.demarreLe,
    termineLe: h.termineLe,
  });
}

/**
 * Synchronisation forcée — visible de tout compte connecté, comme son état
 * l'est déjà sur l'accueil (GET /home/destinations/sync) : elle occupe les
 * destinations partagées de l'installation.
 */
function synchronisationPour(ops) {
  const s = require('./destinations/sync').progress();

  if (s.running) {
    ops.push({
      cle: `synchronisation:${s.startedAt}`,
      type: 'synchronisation',
      titre: 'Synchronisation vers les destinations',
      etat: 'en-cours',
      detail: s.total ? `${s.done} sur ${s.total}` : s.message || 'préparation…',
      faites: s.total ? s.done : null,
      total: s.total || null,
      ecran: 'home',
      demarreLe: s.startedAt,
      termineLe: null,
    });
    return;
  }

  // Une copie en échec n'est pas un succès : le bandeau le dit en rouge, avec
  // le compte exact — jamais un vert qui rassure à tort. L'état est établi
  // AVANT la fenêtre, puisque c'est lui qui décide de sa durée.
  const etat = s.failed || /interrompue/.test(s.message || '') ? 'echec' : 'succes';
  if (!recent(s.finishedAt, etat)) return;

  ops.push({
    cle: `synchronisation:${s.startedAt}`,
    type: 'synchronisation',
    titre: 'Synchronisation vers les destinations',
    etat,
    detail: s.message || 'Terminé.',
    faites: null,
    total: null,
    ecran: 'home',
    demarreLe: s.startedAt,
    termineLe: s.finishedAt,
  });
}

/** Récupérations — celles de CE compte, en cours (mémoire) puis finies (base). */
function recuperationsPour(user, ops) {
  const scheduler = require('./scheduler');
  const registry = require('./connectors/registry');
  const nom = (id) => {
    try {
      return registry.has(id) ? registry.manifest(id).name : id;
    } catch {
      return id;
    }
  };

  for (const pair of scheduler.runningPairs()) {
    if (pair.userId !== user.id) continue;
    ops.push({
      cle: `recuperation:${pair.connectorId}:${pair.startedAt}`,
      type: 'recuperation',
      titre: `Récupération ${nom(pair.connectorId)}`,
      etat: 'en-cours',
      // Une récupération n'annonce pas de total : on ne sait pas combien de
      // documents attendent chez le fournisseur avant d'y être allé. Et elle
      // n'annonce RIEN d'autre non plus : jusqu'au lot 64 ce champ valait la
      // chaîne « en cours », que l'écran préfixait déjà de « en cours — » —
      // d'où le « Récupération Darty : en cours — en cours » mesuré sur
      // l'écran de l'utilisateur. Le mot appartient à l'état, pas au détail.
      detail: null,
      faites: null,
      total: null,
      ecran: 'home',
      demarreLe: pair.startedAt,
      termineLe: null,
    });
  }

  // Chaque fin est retenue selon la fenêtre de SON état — un succès deux
  // minutes, un échec une heure (voir l'en-tête). `ORDER BY success ASC` fait
  // passer les échecs devant : la borne `MAX_FINIES` ne peut donc sacrifier
  // qu'un succès.
  const finies = db
    .get()
    .prepare(
      `SELECT connector_id, started_at, finished_at, success, invoice_count, message
         FROM run_logs
        WHERE user_id = ? AND finished_at IS NOT NULL
          AND finished_at >= datetime('now', CASE success WHEN 0 THEN ? ELSE ? END)
        ORDER BY success ASC, finished_at DESC
        LIMIT ?`
    )
    .all(user.id, `-${FENETRE_ECHEC_MIN} minutes`, `-${FENETRE_SUCCES_MIN} minutes`, MAX_FINIES);

  for (const r of finies) {
    ops.push({
      cle: `recuperation:${r.connector_id}:${r.finished_at}`,
      type: 'recuperation',
      titre: `Récupération ${nom(r.connector_id)}`,
      etat: r.success ? 'succes' : 'echec',
      detail: r.message
        || (r.success ? `${r.invoice_count || 0} document(s) récupéré(s).` : 'Échec.'),
      faites: null,
      total: null,
      ecran: 'home',
      demarreLe: r.started_at,
      termineLe: r.finished_at,
    });
  }
}

/** Optimisation (lot 60) — visible des comptes qui voient l'écran (storage.manage). */
function optimisationPour(user, ops) {
  let optimisation;
  try {
    optimisation = require('./optimisation');
  } catch {
    return; // le module n'existe pas encore : aucun bandeau inventé
  }
  if (typeof optimisation.operationsPour !== 'function') return;
  optimisation.operationsPour(user, ops, { recent });
}

// ---------------------------------------------------------------------------
// La vue servie au bandeau
// ---------------------------------------------------------------------------

/**
 * L'ordre d'IMPORTANCE, pas l'ordre d'arrivée (lot 65).
 *
 * Un échec passe devant une opération en cours, qui passe devant une opération
 * terminée. C'est ce classement qui décide de l'état dominant affiché quand
 * plusieurs opérations sont en jeu : le plus important, jamais le plus récent.
 * Une erreur survenue avant six succès reste la première chose à lire.
 */
const RANG_ETAT = { echec: 0, 'en-cours': 1, succes: 2 };

/**
 * Les opérations visibles de ce compte, de la plus importante à la moins
 * importante ; à importance égale, de la plus fraîche à la plus ancienne.
 */
function operationsPour(user) {
  const ops = [];
  renommagePour(user, ops);
  synchronisationPour(ops);
  recuperationsPour(user, ops);
  optimisationPour(user, ops);

  // Une seule règle de raccourcissement, appliquée à TOUTES les sources : le
  // jour où un connecteur écrira un compte rendu de mille caractères, le
  // bandeau n'aura pas à être corrigé pour lui.
  for (const op of ops) op.detail = phraseCourte(op.detail);

  ops.sort((a, b) => {
    const rang = RANG_ETAT[a.etat] - RANG_ETAT[b.etat];
    if (rang !== 0) return rang;
    return String(b.termineLe || b.demarreLe || '').localeCompare(String(a.termineLe || a.demarreLe || ''));
  });

  return ops;
}

module.exports = {
  operationsPour,
  phraseCourte,
  FENETRE_SUCCES_MIN,
  FENETRE_ECHEC_MIN,
  MAX_FINIES,
  LONGUEUR_DETAIL,
};
