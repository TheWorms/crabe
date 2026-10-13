'use strict';

/**
 * Pourquoi une récupération a échoué — décidé ICI, et nulle part ailleurs.
 *
 * ─── Ce que ce module corrige (lot 91) ───────────────────────────────────────
 *
 * Le 05/10/2026, onze services en défaut affichaient tous « X a refusé la
 * connexion », en rouge pour cinq d'entre eux et en orange pour les six
 * autres. La phrase venait d'une expression régulière passée sur le TEXTE du
 * message (`health.js`), la couleur du RANG de l'échec (les cinq plus récents
 * en rouge, `LIMIT 5`). Ni l'une ni l'autre ne disait la vraie différence entre
 * deux situations qui n'appellent pas le même geste :
 *
 *   - **session expirée** (orange) — une connexion qui a marché, puis vieilli.
 *     C'est le cas ordinaire : on se reconnecte, la récupération repart ;
 *   - **connexion refusée** (rouge) — la récupération qui suit IMMÉDIATEMENT
 *     l'enregistrement d'une connexion échoue sur l'authentification : le site
 *     refuse alors même qu'on vient de se connecter. Recommencer tout de suite
 *     n'y changera rien.
 *
 * Tout le reste — site muet, limite de durée, page illisible, arrêt de crabe —
 * est un **autre échec** (rouge, « Échec »), comme avant.
 *
 * ─── Une seule règle, servie telle quelle ────────────────────────────────────
 *
 * La cause d'un échec se calcule au moment où il s'écrit (`scheduler.finish`,
 * `registry.testForUser`) et se range avec lui (`run_logs.cause`, migration
 * 59). Tous les écrans la lisent ici — accueil, logs, automatisation, bandeau,
 * fiche — et aucun ne la devine en lisant un texte.
 *
 * Le seul signal d'échec d'authentification est `err.sessionExpired`, posé par
 * les connecteurs et leurs socles depuis le lot 6 : aucun connecteur n'a été
 * retouché pour ce module (barrière B2 du lot 91).
 *
 * ─── L'heure d'enregistrement d'une connexion ────────────────────────────────
 *
 * La règle a besoin de savoir QUAND la connexion a été enregistrée. Aucune
 * source ne le disait pour tous les modes (reconnaissance du lot 91, §3) : la
 * table `connexions_enregistrees` (migration 59) le note au seul endroit où une
 * connexion s'enregistre, `registry.saveConfig` — fenêtre « Se connecter »,
 * fichier de session, identifiants saisis. Elle n'est jamais purgée.
 */

const db = require('../db/db');
const messagesEchec = require('./messages-echec');

const SESSION_EXPIREE = 'session-expiree';
const CONNEXION_REFUSEE = 'connexion-refusee';
const ECHEC = 'echec';
const CAUSES = [SESSION_EXPIREE, CONNEXION_REFUSEE, ECHEC];

/** Les mots de chaque cause : les mêmes sur tous les écrans, sans synonyme. */
const LIBELLES = {
  [SESSION_EXPIREE]: 'Session expirée',
  [CONNEXION_REFUSEE]: 'Connexion refusée',
  [ECHEC]: 'Échec',
};

/**
 * Jusqu'où une récupération « suit immédiatement » l'enregistrement d'une
 * connexion : quinze minutes entre l'enregistrement et son VRAI départ.
 *
 * ─── Pourquoi quinze ─────────────────────────────────────────────────────────
 *
 * Il faut rester sous la plus courte durée de vie de session MESURÉE — trente
 * minutes chez impots (lot 87) : un échec d'authentification avant cette
 * borne ne peut pas être une expiration naturelle, c'est un refus. Quinze, la
 * moitié, garde une marge contre une session plus courte que tout ce qu'on a
 * mesuré. Et c'est large devant le délai réel : le 05/10/2026, les quatre
 * récupérations qui ont suivi une reconnexion sont parties de 0 s à 3 min 47 s
 * après elle, file d'attente comprise.
 *
 * Au-delà, et dans tout cas douteux : orange. Une récupération qui a attendu
 * plus de quinze minutes derrière d'autres dans la file est donc dite
 * « session expirée » même si le site l'a refusée — limite connue, assumée.
 */
const SEUIL_CONNEXION_FRAICHE_MS = 15 * 60 * 1000;

/** Un horodatage de la base (« AAAA-MM-JJ HH:MM:SS », UTC) ou ISO, en millisecondes. */
function instant(horodatage) {
  const t = Date.parse(String(horodatage || '').replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * LA règle — pure, testable cas par cas.
 *
 * @param {object} faits
 * @param {boolean} faits.echecConnexion l'échec à classer porte-t-il sur
 *   l'authentification (`err.sessionExpired`) ?
 * @param {string|null} faits.connexionLe le dernier enregistrement de
 *   connexion AVANT cet échec (null : inconnu)
 * @param {boolean} faits.reussiteDepuis une réussite est-elle survenue entre
 *   cet enregistrement et l'échec ?
 * @param {{debut: string, echecConnexion: boolean}|null} faits.premiere la
 *   première récupération lancée après l'enregistrement — son VRAI départ et
 *   la nature de son échec
 * @param {boolean} [faits.expirationCertaine] le connecteur a CONSTATÉ que la
 *   session n'existe plus pour le site (lot 105, `err.expirationCertaine`) —
 *   ce n'est pas un refus, quelle que soit l'heure de l'enregistrement
 * @returns {'session-expiree'|'connexion-refusee'|'echec'}
 */
function decider({ echecConnexion, connexionLe = null, reussiteDepuis = false, premiere = null, expirationCertaine = false } = {}) {
  if (!echecConnexion) return ECHEC;
  // Lot 105 — le connecteur SAIT que la session n'existe plus côté site : le
  // portail d'Alma garde sa session dans le stockage du navigateur, et une
  // connexion enregistrée sans lui (toutes celles d'avant ce lot) ne peut
  // être que renvoyée vers la connexion, à toute heure. Ce n'est pas le site
  // qui refuse un passage : c'est une session à rouvrir — orange, « session
  // expirée ». Seul un connecteur qui le constate pose ce drapeau ; sans lui,
  // la règle ci-dessous est inchangée.
  if (expirationCertaine) return SESSION_EXPIREE;
  // Dans le doute, orange : sans heure d'enregistrement, rien ne distingue un
  // refus d'une expiration.
  if (!connexionLe) return SESSION_EXPIREE;
  // La connexion a marché depuis son enregistrement : elle a vécu, puis vieilli.
  if (reussiteDepuis) return SESSION_EXPIREE;
  // Rouge seulement si la récupération qui a SUIVI l'enregistrement a, elle,
  // échoué sur l'authentification, et qu'elle est partie peu après. L'état
  // reste rouge jusqu'à une réussite ou un nouvel enregistrement : les
  // échecs suivants héritent de cette première.
  if (!premiere || !premiere.echecConnexion) return SESSION_EXPIREE;
  const delai = instant(premiere.debut) - instant(connexionLe);
  // `delai` peut valoir 0 : départ dans la même seconde que l'enregistrement
  // (mesuré pour darty le 05/10/2026). Négatif ou illisible : doute.
  if (!Number.isFinite(delai) || delai < 0 || delai > SEUIL_CONNEXION_FRAICHE_MS) {
    return SESSION_EXPIREE;
  }
  return CONNEXION_REFUSEE;
}

// ---------------------------------------------------------------------------
// Les lignes écrites AVANT ce lot : classées au mieux, jamais réécrites
// ---------------------------------------------------------------------------

/**
 * Les phrases d'échec écrites sans le préfixe « Échec — » par le planificateur
 * lui-même, sans rapport avec une connexion. Toutes les autres phrases sans
 * préfixe d'une récupération viennent d'une erreur qui portait
 * `sessionExpired` : c'est la règle d'écriture de `scheduler.runLocked`
 * depuis le 10/08/2026 (« err.sessionExpired ? brut : `Échec — ${brut}` »),
 * vérifiée le 05/10/2026 sur les 259 échecs de production.
 */
const PHRASES_SANS_PREFIXE_HORS_CONNEXION = [
  /^Connecteur en maintenance — /,
  /^Compte inactif — /,
  /^Aucun espace de stockage n'est actif/,
  /^Aucun document n'a pu être récupéré/,
];

/**
 * Les phrases EXACTES que crabe écrit pour un échec d'authentification. Elles
 * servent aux seules lignes de TEST d'avant ce lot, qui s'écrivaient toutes
 * sans préfixe et ne permettent donc pas la règle précédente.
 */
const PHRASES_ECHEC_CONNEXION = [
  /^Votre connexion a expiré \((?:dernière réussite|connexion ouverte) le /,
  /^Votre connexion à .+ est bien enregistrée, mais le site a renvoyé la lecture automatique/,
  /^Votre connexion à .+ a expiré\b/,
  /^La connexion à ce service a été interrompue\./,
  /^Adresse électronique ou mot de passe incorrect\./,
];

/** Ce texte est-il l'un des messages du socle qui ne parlent pas de connexion ? */
function phraseHorsConnexion(texte) {
  if (PHRASES_SANS_PREFIXE_HORS_CONNEXION.some((motif) => motif.test(texte))) return true;
  return [
    messagesEchec.MESSAGE_ECRAN_AUTOMATISATION,
    ...Object.values(messagesEchec.ECHECS_SANS_MESSAGE),
  ].some((phrase) => texte.startsWith(phrase.slice(0, 40)));
}

/**
 * Une ligne d'avant le lot était-elle un échec d'authentification ? Lue dans
 * son message, faute de mieux — c'est la SEULE lecture de texte de ce module,
 * et elle ne vaut que pour les lignes sans cause rangée.
 */
function echecConnexionDepuisLigne(ligne) {
  const texte = String(ligne?.message || '').replace(/\s+/g, ' ').trim();
  if (!texte) return false;
  if (ligne.trigger === 'test') return PHRASES_ECHEC_CONNEXION.some((motif) => motif.test(texte));
  if (/^Échec\b/.test(texte)) return false;
  return !phraseHorsConnexion(texte);
}

/** Une ligne d'exécution est-elle un échec d'authentification ? Rangé d'abord, déduit sinon. */
function echecConnexionDe(ligne) {
  if (!ligne || ligne.success || !ligne.finished_at) return false;
  if (ligne.cause) return ligne.cause !== ECHEC;
  return echecConnexionDepuisLigne(ligne);
}

// ---------------------------------------------------------------------------
// L'heure d'enregistrement d'une connexion
// ---------------------------------------------------------------------------

/** Les origines possibles d'un enregistrement (voir la migration 59). */
const ORIGINES = ['fenetre', 'formulaire', 'journal'];

/**
 * Note qu'une connexion vient d'être enregistrée pour ce couple. Appelé par
 * `registry.saveConfig` — fenêtre « Se connecter », fichier de session ou
 * identifiants saisis — et par rien d'autre.
 */
function noterConnexion(userId, connectorId, origine = 'formulaire') {
  db.get()
    .prepare('INSERT INTO connexions_enregistrees (user_id, connector_id, origine) VALUES (?, ?, ?)')
    .run(userId, connectorId, ORIGINES.includes(origine) ? origine : 'formulaire');
}

/** Le dernier enregistrement de connexion au plus tard à `avant` (inclus), ou null. */
function derniereConnexionAvant(userId, connectorId, avant) {
  return db
    .get()
    .prepare(
      `SELECT MAX(at) AS at FROM connexions_enregistrees
        WHERE user_id = ? AND connector_id = ? AND at <= ?`
    )
    .get(userId, connectorId, avant)?.at || null;
}

/** Une connexion a-t-elle été enregistrée STRICTEMENT après cet instant ? */
function connexionApres(userId, connectorId, instantSql) {
  return !!db
    .get()
    .prepare(
      `SELECT 1 FROM connexions_enregistrees
        WHERE user_id = ? AND connector_id = ? AND at > ? LIMIT 1`
    )
    .get(userId, connectorId, instantSql);
}

// ---------------------------------------------------------------------------
// La cause d'un échec, à partir de l'historique
// ---------------------------------------------------------------------------

/**
 * La cause d'un échec de ce couple, survenu sur une exécution partie à
 * `debut`. `runId` désigne sa ligne si elle existe déjà (une récupération : sa
 * ligne naît au départ) ; null pour un test, écrit après coup.
 *
 * @returns {'session-expiree'|'connexion-refusee'|'echec'}
 */
function causePour({ userId, connectorId, runId = null, debut, echecConnexion, expirationCertaine = false }) {
  if (!echecConnexion) return ECHEC;
  if (expirationCertaine) return decider({ echecConnexion, expirationCertaine });
  const connexionLe = derniereConnexionAvant(userId, connectorId, debut);
  if (!connexionLe) return decider({ echecConnexion, connexionLe });

  const autre = runId == null ? -1 : runId;
  const reussiteDepuis = !!db
    .get()
    .prepare(
      `SELECT 1 FROM run_logs
        WHERE user_id = ? AND connector_id = ? AND success = 1 AND finished_at IS NOT NULL
          AND started_at >= ? AND started_at <= ? AND id != ? LIMIT 1`
    )
    .get(userId, connectorId, connexionLe, debut, autre);

  // La première exécution partie après l'enregistrement. Si c'est celle qu'on
  // classe (ou si aucune ligne ne la précède), ses faits sont ceux qu'on reçoit.
  const ligne = db
    .get()
    .prepare(
      `SELECT id, started_at, finished_at, success, trigger, message, cause FROM run_logs
        WHERE user_id = ? AND connector_id = ? AND started_at >= ? AND started_at <= ?
        ORDER BY started_at ASC, id ASC LIMIT 1`
    )
    .get(userId, connectorId, connexionLe, debut);
  const premiere = !ligne || ligne.id === runId
    ? { debut, echecConnexion }
    : { debut: ligne.started_at, echecConnexion: echecConnexionDe(ligne) };

  return decider({ echecConnexion, connexionLe, reussiteDepuis, premiere });
}

/**
 * La cause d'une ligne d'exécution TERMINÉE en échec, telle que tous les écrans
 * la servent : celle rangée à l'écriture, sinon (ligne d'avant ce lot) la même
 * règle appliquée à son historique. Rien n'est jamais réécrit.
 *
 * @param {{id: number, user_id: number, connector_id: string, started_at: string,
 *          finished_at: string|null, success: number, trigger: string,
 *          message: string|null, cause?: string|null}} ligne
 * @returns {'session-expiree'|'connexion-refusee'|'echec'|null} null pour une
 *   réussite ou une exécution en cours
 */
function causeDeLigne(ligne) {
  if (!ligne || ligne.success || !ligne.finished_at) return null;
  if (CAUSES.includes(ligne.cause)) return ligne.cause;
  return causePour({
    userId: ligne.user_id,
    connectorId: ligne.connector_id,
    runId: ligne.id,
    debut: ligne.started_at,
    echecConnexion: echecConnexionDepuisLigne(ligne),
  });
}

/** Les colonnes qu'il faut lire d'une ligne pour en servir la cause. */
const COLONNES_LIGNE =
  'id, user_id, connector_id, started_at, finished_at, success, trigger, message, cause';

/**
 * Le défaut ACTUEL d'un service : la dernière exécution terminée (test
 * compris : c'est elle qui a posé l'état) si elle a échoué, et qu'aucune
 * connexion n'a été enregistrée depuis. Null sinon.
 *
 * ─── Pourquoi depuis l'historique, et pas depuis `status` (R11) ──────────────
 *
 * Un service ne sort de son défaut que par une réussite ou par
 * l'enregistrement d'une nouvelle connexion. Lu ainsi, aucun autre geste ne
 * peut l'effacer — pas même un `status` remis à `installed` par erreur, comme
 * celui d'addons-prestashop le 05/10/2026 à l'ouverture d'une fenêtre ensuite
 * abandonnée.
 *
 * @returns {{cause: string, libelle: string, at: string, finishedAt: string,
 *            runId: number, trigger: string}|null}
 */
function defautActuel(userId, connectorId) {
  const derniere = db
    .get()
    .prepare(
      `SELECT ${COLONNES_LIGNE} FROM run_logs
        WHERE user_id = ? AND connector_id = ? AND finished_at IS NOT NULL
        ORDER BY started_at DESC, id DESC LIMIT 1`
    )
    .get(userId, connectorId);
  if (!derniere || derniere.success) return null;
  if (connexionApres(userId, connectorId, derniere.finished_at)) return null;
  const cause = causeDeLigne(derniere);
  return {
    cause,
    libelle: LIBELLES[cause],
    at: derniere.started_at,
    finishedAt: derniere.finished_at,
    runId: derniere.id,
    trigger: derniere.trigger,
  };
}

/** L'instant présent, au format de la base (UTC). */
function maintenantSql() {
  return db.get().prepare("SELECT datetime('now') AS t").get().t;
}

module.exports = {
  SESSION_EXPIREE,
  CONNEXION_REFUSEE,
  ECHEC,
  CAUSES,
  LIBELLES,
  ORIGINES,
  SEUIL_CONNEXION_FRAICHE_MS,
  COLONNES_LIGNE,
  decider,
  echecConnexionDepuisLigne,
  echecConnexionDe,
  noterConnexion,
  derniereConnexionAvant,
  connexionApres,
  causePour,
  causeDeLigne,
  defautActuel,
  maintenantSql,
};
