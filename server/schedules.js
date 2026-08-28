'use strict';

/**
 * Planification : une ligne par couple (utilisateur, connecteur) RÉELLEMENT
 * installé.
 *
 * Avant le lot 3, la planification était globale (`connector_schedules`, une
 * ligne par connecteur du catalogue) et le scheduler armait une tâche cron
 * pour les 13 connecteurs livrés, alors qu'un seul était installé — d'où le
 * « scheduler : 13 planification(s) active(s) » relevé en production.
 *
 * Ce module ne contient que la donnée et l'arithmétique de dates : pas de
 * cron, pas de registre de connecteurs. C'est ce qui permet à
 * `connectors/registry.js` de créer et retirer une planification sans
 * dépendance circulaire avec `scheduler.js`.
 */

const db = require('./db/db');
const settings = require('./settings');
const tz = require('./timezone');

/**
 * Les rythmes réglables, du plus fréquent au plus rare.
 *
 * ─── Pourquoi trimestriel et semestriel (lot 14, §9) ─────────────────────────
 *
 * Le maximum réglable était « mensuelle ». Beaucoup de factures ne tombent pas
 * tous les mois — une assurance, une taxe, un abonnement annuel — et faire
 * tourner un navigateur douze fois par an pour zéro document est du bruit,
 * chez le fournisseur comme dans les journaux.
 *
 * L'ordre de cette liste est celui du menu déroulant : « Désactivée » reste en
 * dernier, parce que c'est une suspension, pas un rythme.
 */
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'disabled'];

const FREQUENCY_LABELS = {
  daily: 'quotidien',
  weekly: 'hebdomadaire',
  monthly: 'mensuel',
  quarterly: 'tous les 3 mois',
  'half-yearly': 'tous les 6 mois',
  disabled: 'désactivé',
};

/**
 * Les fréquences qui se comptent en mois, et leur pas.
 *
 * `monthly` n'y figure pas : tous les mois, c'est tous les mois, il n'y a pas
 * de mois à sauter et donc pas d'ancrage à retenir.
 */
const PAS_EN_MOIS = { quarterly: 3, 'half-yearly': 6 };

/** Cette fréquence saute-t-elle des mois ? */
function estPluriMensuelle(frequency) {
  return Object.prototype.hasOwnProperty.call(PAS_EN_MOIS, frequency);
}

/**
 * Les mois où une fréquence pluri-mensuelle se déclenche, à partir de son
 * ancrage.
 *
 * Ancrée en février, une trimestrielle tombe en février, mai, août, novembre —
 * le calendrier de CELUI qui l'a réglée, pas celui du 1er janvier.
 *
 * @param {string} frequency
 * @param {number} anchorMonth 1-12
 * @returns {number[]} les mois (1-12), triés
 */
function moisDeclenchement(frequency, anchorMonth) {
  const pas = PAS_EN_MOIS[frequency];
  if (!pas) return [];
  const depart = normaliserMois(anchorMonth);
  const mois = [];
  for (let i = 0; i < 12 / pas; i++) mois.push(((depart - 1 + i * pas) % 12) + 1);
  return mois.sort((a, b) => a - b);
}

/** Un mois exploitable : entier, 1-12, sinon janvier. */
function normaliserMois(valeur) {
  const n = Number(valeur);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

const WEEKDAY_LABELS = [
  'dimanche',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
];

const DEFAULTS = {
  frequency: 'monthly',
  timeOfDay: '03:00',
  dayOfWeek: 1,
  dayOfMonth: 1,
  lastDayOfMonth: false,
  enabled: true,
  // Null tant qu'aucune fréquence pluri-mensuelle n'a été choisie : c'est
  // `save()` qui le pose, au mois de la première exécution.
  anchorMonth: null,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Ramène des valeurs venant d'une requête à une planification valide.
 *
 * `dayOfMonth` est borné à 1-28 : c'est la seule façon de garantir qu'une
 * planification mensuelle ne saute jamais février. Pour viser la fin du mois,
 * il faut demander explicitement `lastDayOfMonth`.
 */
function sanitize(values = {}, base = DEFAULTS) {
  const frequency = FREQUENCIES.includes(values.frequency) ? values.frequency : base.frequency;
  const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(values.timeOfDay || ''))
    ? values.timeOfDay
    : base.timeOfDay;

  const rawWeekday = Number(values.dayOfWeek ?? base.dayOfWeek);
  const dayOfWeek = Number.isInteger(rawWeekday) && rawWeekday >= 0 && rawWeekday <= 6
    ? rawWeekday
    : base.dayOfWeek;

  const rawDay = Number(values.dayOfMonth ?? base.dayOfMonth);
  const dayOfMonth = Number.isInteger(rawDay) ? Math.min(Math.max(rawDay, 1), 28) : base.dayOfMonth;

  // L'ancrage n'est PAS réglable par le client : il est posé à l'écriture, au
  // mois de la première exécution (voir `save`). Ce qui est repris ici, c'est
  // celui qui existait déjà — un changement d'heure ne doit pas déplacer un
  // trimestre.
  const brutAncre = values.anchorMonth ?? base.anchorMonth;
  const anchorMonth = brutAncre === null || brutAncre === undefined
    ? null
    : normaliserMois(brutAncre);

  return {
    frequency,
    timeOfDay,
    dayOfWeek,
    dayOfMonth,
    lastDayOfMonth:
      values.lastDayOfMonth === undefined ? !!base.lastDayOfMonth : !!values.lastDayOfMonth,
    enabled: values.enabled === undefined ? !!base.enabled : !!values.enabled,
    anchorMonth,
  };
}

/** Ligne SQL → objet camelCase. */
function fromRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    connectorId: row.connector_id,
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    lastDayOfMonth: !!row.last_day_of_month,
    enabled: !!row.enabled,
    anchorMonth: row.anchor_month ?? null,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Lecture / écriture
// ---------------------------------------------------------------------------

/**
 * Valeurs proposées à une nouvelle installation : celles que
 * l'administrateur a posées pour ce connecteur dans l'ancienne table globale,
 * sinon les défauts. Cette table ne déclenche plus rien, elle sert de gabarit.
 */
function template(connectorId) {
  const row = db
    .get()
    .prepare('SELECT * FROM connector_schedules WHERE connector_id = ?')
    .get(connectorId);
  if (!row) return { ...DEFAULTS };
  return sanitize({
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    enabled: !!row.enabled,
  });
}

function get(userId, connectorId) {
  return fromRow(
    db
      .get()
      .prepare('SELECT * FROM user_connector_schedules WHERE user_id = ? AND connector_id = ?')
      .get(userId, connectorId)
  );
}

/** Crée la planification d'une installation si elle n'existe pas encore. */
function ensureForInstall(userId, connectorId) {
  const existing = get(userId, connectorId);
  if (existing) return existing;

  const values = template(connectorId);
  db.get()
    .prepare(
      `INSERT INTO user_connector_schedules
         (user_id, connector_id, frequency, time_of_day, day_of_week, day_of_month,
          last_day_of_month, enabled, anchor_month)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connector_id) DO NOTHING`
    )
    .run(
      userId,
      connectorId,
      values.frequency,
      values.timeOfDay,
      values.dayOfWeek,
      values.dayOfMonth,
      values.lastDayOfMonth ? 1 : 0,
      values.enabled ? 1 : 0,
      values.anchorMonth
    );
  return get(userId, connectorId);
}

/** Retire la planification d'une installation (désinstallation). */
function removeForInstall(userId, connectorId) {
  return db
    .get()
    .prepare('DELETE FROM user_connector_schedules WHERE user_id = ? AND connector_id = ?')
    .run(userId, connectorId).changes;
}

/** Retire toutes les planifications d'un connecteur (rejet d'une candidature). */
function removeForConnector(connectorId) {
  return db
    .get()
    .prepare('DELETE FROM user_connector_schedules WHERE connector_id = ?')
    .run(connectorId).changes;
}

function save(userId, connectorId, values, { now = new Date() } = {}) {
  const base = get(userId, connectorId) || template(connectorId);
  const clean = sanitize(values, base);

  // ─── L'ancrage, posé une fois (lot 14, §9) ────────────────────────────────
  //
  // « Ancré sur le mois de la première exécution » : quand on passe en
  // trimestriel ou en semestriel, le mois de départ est celui de la PROCHAINE
  // exécution calculée — pas le mois courant, qui peut être déjà passé si le
  // jour choisi est derrière nous.
  //
  // Il n'est posé qu'une fois : rouvrir l'écran, changer l'heure ou basculer
  // de trimestriel à semestriel ne redémarre pas le compte. Sans ça, chaque
  // enregistrement déplacerait le trimestre, et la « prochaine exécution »
  // affichée reculerait à chaque visite.
  if (estPluriMensuelle(clean.frequency) && !clean.anchorMonth) {
    const premiere = nextRunAt({ ...clean, anchorMonth: null, frequency: 'monthly' }, now);
    clean.anchorMonth = premiere
      ? tz.partsInZone(new Date(premiere), zoneApplicative()).month
      : tz.partsInZone(now, zoneApplicative()).month;
  }

  db.get()
    .prepare(
      `INSERT INTO user_connector_schedules
         (user_id, connector_id, frequency, time_of_day, day_of_week, day_of_month,
          last_day_of_month, enabled, anchor_month, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, connector_id) DO UPDATE SET
         frequency         = excluded.frequency,
         time_of_day       = excluded.time_of_day,
         day_of_week       = excluded.day_of_week,
         day_of_month      = excluded.day_of_month,
         last_day_of_month = excluded.last_day_of_month,
         enabled           = excluded.enabled,
         anchor_month      = excluded.anchor_month,
         updated_at        = datetime('now')`
    )
    .run(
      userId,
      connectorId,
      clean.frequency,
      clean.timeOfDay,
      clean.dayOfWeek,
      clean.dayOfMonth,
      clean.lastDayOfMonth ? 1 : 0,
      clean.enabled ? 1 : 0,
      clean.anchorMonth
    );

  return get(userId, connectorId);
}

/** Le fuseau réglé en administration, ou Paris à défaut. */
function zoneApplicative(timeZone = settings.timezone()) {
  return tz.isValid(timeZone) ? timeZone : 'Europe/Paris';
}

/**
 * Toutes les installations réelles, avec leur planification.
 *
 * Une installation sans ligne de planification (base migrée à la main,
 * installation créée avant le lot 3) reçoit les valeurs par défaut plutôt que
 * de disparaître de l'écran.
 *
 * @returns {Array<object>} un élément par couple (utilisateur, connecteur)
 */
function listInstallations() {
  const rows = db
    .get()
    .prepare(
      `SELECT ci.user_id, ci.connector_id, ci.status AS install_status,
              ci.config_encrypted IS NOT NULL AS configured,
              ci.last_run_at, ci.last_error,
              u.username, u.status AS user_status,
              s.frequency, s.time_of_day, s.day_of_week, s.day_of_month,
              s.last_day_of_month, s.enabled, s.anchor_month, s.updated_at
         FROM connector_installs ci
         JOIN users u ON u.id = ci.user_id
         LEFT JOIN user_connector_schedules s
                ON s.user_id = ci.user_id AND s.connector_id = ci.connector_id
        ORDER BY ci.connector_id, u.username`
    )
    .all();

  return rows.map((row) => {
    const schedule = row.frequency
      ? fromRow(row)
      : { userId: row.user_id, connectorId: row.connector_id, ...DEFAULTS, updatedAt: null };

    return {
      ...schedule,
      userId: row.user_id,
      connectorId: row.connector_id,
      username: row.username,
      userActive: row.user_status === 'active',
      configured: !!row.configured,
      installStatus: row.install_status,
      lastRunAt: row.last_run_at,
      lastError: row.last_error,
    };
  });
}

// ---------------------------------------------------------------------------
// Cron et prochaine exécution
// ---------------------------------------------------------------------------

/** Nombre de jours du mois (month : 1-12). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Expression cron (5 champs) correspondant à une planification.
 *
 * node-cron ne connaît pas le `L` de « dernier jour du mois » : on arme donc
 * les jours 28 à 31 et la tâche vérifie elle-même, au déclenchement, qu'on est
 * bien le dernier jour (voir `isDueOn()`).
 *
 * @returns {string|null} null si rien n'est planifié
 */
function toCronExpression(schedule) {
  if (!schedule || schedule.frequency === 'disabled' || !schedule.enabled) return null;

  const [hh, mm] = String(schedule.timeOfDay || DEFAULTS.timeOfDay).split(':');
  const hour = Number(hh);
  const minute = Number(mm);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  // Le champ « jour du mois », commun à toutes les fréquences mensuelles et
  // pluri-mensuelles. node-cron ne connaît pas le `L` de « dernier jour » : on
  // arme donc 28 à 31, et `isDueOn` tranche au déclenchement.
  const jours = schedule.lastDayOfMonth
    ? '28,29,30,31'
    : String(Math.min(Math.max(Number(schedule.dayOfMonth ?? 1), 1), 28));

  switch (schedule.frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${schedule.dayOfWeek ?? 1}`;
    case 'monthly':
      return `${minute} ${hour} ${jours} * *`;
    case 'quarterly':
    case 'half-yearly':
      // La restriction aux mois d'ancrage passe par le champ MOIS de
      // l'expression : cron sait faire, et c'est la seule façon de ne pas
      // réveiller le service onze mois sur douze pour rien.
      return `${minute} ${hour} ${jours} `
        + `${moisDeclenchement(schedule.frequency, schedule.anchorMonth).join(',')} *`;
    default:
      return null;
  }
}

/**
 * Le déclenchement du jour est-il légitime ?
 *
 * Seul cas où la réponse peut être non : « dernier jour du mois », dont
 * l'expression cron couvre volontairement les 28 au 31.
 */
function isDueOn(schedule, at = new Date(), timeZone = settings.timezone()) {
  if (!schedule) return true;
  const mensuelle = ['monthly', 'quarterly', 'half-yearly'].includes(schedule.frequency);
  if (!mensuelle || !schedule.lastDayOfMonth) return true;
  const parts = tz.partsInZone(at, zoneApplicative(timeZone));
  return parts.day === daysInMonth(parts.year, parts.month);
}

/**
 * Prochaine exécution, dans le fuseau réglé en administration.
 *
 * Calculé sur l'heure murale du fuseau applicatif — le même que celui passé à
 * node-cron : l'heure affichée est bien celle à laquelle la tâche partira,
 * changements d'heure été / hiver compris (voir timezone.wallClockToUtc).
 *
 * @returns {string|null} instant ISO, ou null si rien n'est planifié
 */
function nextRunAt(schedule, from = new Date(), timeZone = settings.timezone()) {
  if (!schedule || schedule.frequency === 'disabled' || !schedule.enabled) return null;

  const zone = tz.isValid(timeZone) ? timeZone : 'Europe/Paris';
  const [hh, mm] = String(schedule.timeOfDay || DEFAULTS.timeOfDay).split(':').map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;

  const now = tz.partsInZone(from, zone);
  const at = (year, month, day) =>
    tz.wallClockToUtc({ year, month, day, hour: hh, minute: mm }, zone);

  if (schedule.frequency === 'daily') {
    const today = at(now.year, now.month, now.day);
    if (today > from) return today.toISOString();
    // Milieu de journée : à l'abri d'un changement d'heure au passage minuit.
    const tomorrow = tz.partsInZone(
      new Date(Date.UTC(now.year, now.month - 1, now.day + 1, 12)),
      zone
    );
    return at(tomorrow.year, tomorrow.month, tomorrow.day).toISOString();
  }

  if (schedule.frequency === 'weekly') {
    const wanted = Number(schedule.dayOfWeek ?? 1);
    for (let ahead = 0; ahead <= 7; ahead++) {
      const parts = tz.partsInZone(
        new Date(Date.UTC(now.year, now.month - 1, now.day + ahead, 12)),
        zone
      );
      if (parts.weekday !== wanted) continue;
      const candidate = at(parts.year, parts.month, parts.day);
      if (candidate > from) return candidate.toISOString();
    }
    return null;
  }

  // Mensuel et pluri-mensuel : le prochain mois AUTORISÉ dont l'échéance est
  // encore devant nous.
  const dayFor = (year, month) =>
    schedule.lastDayOfMonth
      ? daysInMonth(year, month)
      : Math.min(Math.max(Number(schedule.dayOfMonth ?? 1), 1), 28);

  // `monthly` autorise les douze mois ; les autres, ceux de leur ancrage.
  const autorises = estPluriMensuelle(schedule.frequency)
    ? new Set(moisDeclenchement(schedule.frequency, schedule.anchorMonth))
    : null;

  // Treize mois d'avance : de quoi retomber sur le même mois l'année suivante
  // même quand l'échéance de ce mois-ci vient de passer.
  for (let avance = 0; avance <= 13; avance++) {
    const mois = ((now.month - 1 + avance) % 12) + 1;
    const annee = now.year + Math.floor((now.month - 1 + avance) / 12);
    if (autorises && !autorises.has(mois)) continue;

    const candidat = at(annee, mois, dayFor(annee, mois));
    if (candidat > from) return candidat.toISOString();
  }

  /* c8 ignore next — treize mois couvrent forcément un mois autorisé */
  return null;
}

/** « mensuel, jour 5 à 03:00 » — utilisé par les journaux et l'interface. */
function rhythmLabel(schedule) {
  const time = schedule.timeOfDay || DEFAULTS.timeOfDay;
  switch (schedule.frequency) {
    case 'daily':
      return `quotidien, à ${time}`;
    case 'weekly':
      return `hebdomadaire, ${WEEKDAY_LABELS[schedule.dayOfWeek ?? 1]} à ${time}`;
    case 'monthly':
      return schedule.lastDayOfMonth
        ? `mensuel, dernier jour du mois à ${time}`
        : `mensuel, jour ${schedule.dayOfMonth ?? 1} à ${time}`;
    case 'quarterly':
    case 'half-yearly': {
      const quand = schedule.lastDayOfMonth
        ? `dernier jour du mois à ${time}`
        : `jour ${schedule.dayOfMonth ?? 1} à ${time}`;
      // Les mois réels plutôt que « tous les 3 mois » tout court : c'est la
      // seule façon de vérifier d'un coup d'œil que l'ancrage est le bon.
      const mois = moisDeclenchement(schedule.frequency, schedule.anchorMonth)
        .map((m) => MOIS_LABELS[m - 1])
        .join(', ');
      return `${FREQUENCY_LABELS[schedule.frequency]} (${mois}), ${quand}`;
    }
    default:
      return 'désactivé';
  }
}

/** Les mois, pour écrire un rythme lisible plutôt qu'une liste de nombres. */
const MOIS_LABELS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

/** Date courte JJ/MM/AAAA dans le fuseau applicatif. */
function shortDate(iso, timeZone = settings.timezone()) {
  if (!iso) return '—';
  const parts = tz.partsInZone(new Date(iso), tz.isValid(timeZone) ? timeZone : 'Europe/Paris');
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
}

/**
 * Une planification en une ligne lisible, pour le journal de démarrage :
 * « free (camille, mensuel, jour 5 à 03:00, prochaine le 05/08/2026) »
 */
function describe(schedule, { connectorId = schedule.connectorId, next } = {}) {
  const when = next === undefined ? nextRunAt(schedule) : next;
  return `${connectorId} (${schedule.username || `compte ${schedule.userId}`}, ${rhythmLabel(schedule)}, prochaine le ${shortDate(when)})`;
}

module.exports = {
  FREQUENCIES,
  FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  DEFAULTS,
  sanitize,
  fromRow,
  template,
  get,
  ensureForInstall,
  removeForInstall,
  removeForConnector,
  save,
  listInstallations,
  daysInMonth,
  PAS_EN_MOIS,
  MOIS_LABELS,
  estPluriMensuelle,
  moisDeclenchement,
  normaliserMois,
  toCronExpression,
  isDueOn,
  nextRunAt,
  rhythmLabel,
  shortDate,
  describe,
};
