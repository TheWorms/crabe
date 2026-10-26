'use strict';

/**
 * Réglages globaux : politique de sécurité (2FA, mots de passe, SMTP,
 * rétention) et réglages d'affichage (fuseau horaire, formats de date et
 * d'heure, Gravatar).
 *
 * Deux singletons en base : `security_policy` et `app_settings`, tous deux à
 * id = 1. Ce module est le seul endroit qui les lit et les écrit.
 */

const { createHash } = require('node:crypto');
const db = require('./db/db');

// ---------------------------------------------------------------------------
// Politique de sécurité
// ---------------------------------------------------------------------------

function securityPolicy() {
  return db.get().prepare('SELECT * FROM security_policy WHERE id = 1').get();
}

/**
 * État de la 2FA sur l'instance.
 *
 *   'disabled' — l'administrateur ne l'autorise pas (défaut) : le toggle du
 *                profil est grisé, avec la mention « Désactivé par
 *                l'administrateur » ;
 *   'allowed'  — chaque utilisateur décide pour son compte ;
 *   'required' — les comptes sans 2FA sont invités à la configurer à la
 *                prochaine connexion, jamais bloqués sans porte de sortie.
 *
 * @returns {'disabled'|'allowed'|'required'}
 */
function twoFactorMode(policy = securityPolicy()) {
  if (!policy) return 'disabled';
  if (policy.require_2fa) return 'required';
  return policy.allow_2fa ? 'allowed' : 'disabled';
}

const TWO_FACTOR_MODES = [
  { id: 'disabled', label: 'Désactivée', help: 'Personne ne peut activer la double authentification.' },
  { id: 'allowed', label: 'Autorisée', help: 'Chaque utilisateur décide pour son compte.' },
  {
    id: 'required',
    label: 'Exigée',
    help: 'Les comptes sans 2FA sont invités à la configurer à la connexion, sans jamais être bloqués.',
  },
];

function setTwoFactorMode(mode) {
  if (!TWO_FACTOR_MODES.some((m) => m.id === mode)) {
    const err = new Error('Politique de double authentification inconnue.');
    err.statusCode = 400;
    throw err;
  }
  db.get()
    .prepare(
      "UPDATE security_policy SET allow_2fa = ?, require_2fa = ?, updated_at = datetime('now') WHERE id = 1"
    )
    .run(mode === 'disabled' ? 0 : 1, mode === 'required' ? 1 : 0);
  return twoFactorMode();
}

/** La 2FA peut-elle être activée par un utilisateur pour son compte ? */
function twoFactorSelfServiceAllowed() {
  return twoFactorMode() !== 'disabled';
}

// ---------------------------------------------------------------------------
// Réglages d'affichage
// ---------------------------------------------------------------------------

const TIME_FORMATS = [
  { id: '24', label: '24 h (14:30)' },
  { id: '12', label: '12 h AM/PM (2:30 PM)' },
];

const DATE_FORMATS = [
  { id: 'DD/MM/YYYY', label: 'JJ/MM/AAAA (31/07/2026)' },
  { id: 'YYYY-MM-DD', label: 'AAAA-MM-JJ (2026-07-31)' },
  { id: 'MM/DD/YYYY', label: 'MM/JJ/AAAA (07/31/2026)' },
];

/** Fuseaux IANA proposés dans l'interface. */
function timezones() {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    if (Array.isArray(all) && all.length) return all;
  } catch {
    /* Node trop ancien : on retombe sur une liste courte */
  }
  return [
    'Europe/Paris',
    'Europe/Brussels',
    'Europe/London',
    'Europe/Madrid',
    'Europe/Lisbon',
    'Europe/Berlin',
    'Europe/Zurich',
    'America/Montreal',
    'America/New_York',
    'UTC',
  ];
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function appSettings() {
  return db.get().prepare('SELECT * FROM app_settings WHERE id = 1').get();
}

/**
 * Les quatre volets du détail d'une récupération (0.2.3, migration 68) :
 * son déroulé, son rapport lisible à l'écran, l'accès depuis la fiche du
 * service, ses récupérations précédentes. Chacun s'active ou se désactive
 * dans l'administration ; le serveur les applique — un volet fermé n'est pas
 * servi, pas seulement caché.
 */
const VOLETS_DETAIL = Object.freeze(['deroule', 'rapport', 'fiche', 'precedentes']);

/**
 * Les volets ouverts. 0.2.4 (décision du 26/10/2026) : fermés par défaut —
 * seul un volet que l'administration a ouvert vaut « ouvert » ; une colonne
 * absente (base d'avant la migration 68) vaut « fermé ».
 */
function detailRecuperation(row = appSettings() || {}) {
  return Object.fromEntries(VOLETS_DETAIL.map((v) => [v, row[`detail_${v}`] === 1]));
}

/** Vue consommée par le front pour formater toutes les dates et heures. */
function publicSettings() {
  const row = appSettings() || {};
  return {
    timezone: row.timezone || 'Europe/Paris',
    timeFormat: row.time_format || '24',
    dateFormat: row.date_format || 'DD/MM/YYYY',
    gravatarEnabled: !!row.gravatar_enabled,
    detailRecuperation: detailRecuperation(row),
  };
}

/**
 * Met à jour les réglages d'affichage.
 * @param {{timezone?: string, timeFormat?: string, dateFormat?: string, gravatarEnabled?: boolean}} patch
 */
function updateAppSettings(patch = {}) {
  const fields = [];
  const values = [];

  if (patch.timezone !== undefined) {
    if (!isValidTimezone(patch.timezone)) {
      const err = new Error('Fuseau horaire inconnu.');
      err.statusCode = 400;
      throw err;
    }
    fields.push('timezone = ?');
    values.push(patch.timezone);
  }
  if (patch.timeFormat !== undefined) {
    if (!TIME_FORMATS.some((f) => f.id === patch.timeFormat)) {
      const err = new Error('Format d\'heure inconnu.');
      err.statusCode = 400;
      throw err;
    }
    fields.push('time_format = ?');
    values.push(patch.timeFormat);
  }
  if (patch.dateFormat !== undefined) {
    if (!DATE_FORMATS.some((f) => f.id === patch.dateFormat)) {
      const err = new Error('Format de date inconnu.');
      err.statusCode = 400;
      throw err;
    }
    fields.push('date_format = ?');
    values.push(patch.dateFormat);
  }
  if (patch.gravatarEnabled !== undefined) {
    fields.push('gravatar_enabled = ?');
    values.push(patch.gravatarEnabled ? 1 : 0);
  }
  if (patch.detailRecuperation !== undefined) {
    const volets = patch.detailRecuperation;
    const cles = volets && typeof volets === 'object' && !Array.isArray(volets) ? Object.keys(volets) : null;
    if (!cles?.length || cles.some((v) => !VOLETS_DETAIL.includes(v) || typeof volets[v] !== 'boolean')) {
      const err = new Error(`Réglage du détail inconnu : chaque volet (${VOLETS_DETAIL.join(', ')}) vaut true ou false.`);
      err.statusCode = 400;
      throw err;
    }
    for (const v of cles) {
      fields.push(`detail_${v} = ?`);
      values.push(volets[v] ? 1 : 0);
    }
  }

  if (!fields.length) {
    const err = new Error('Aucune modification fournie.');
    err.statusCode = 400;
    throw err;
  }

  fields.push("updated_at = datetime('now')");
  db.get().prepare(`UPDATE app_settings SET ${fields.join(', ')} WHERE id = 1`).run(...values);
  return publicSettings();
}

/** Fuseau à utiliser pour les tâches planifiées et les affichages. */
function timezone() {
  return publicSettings().timezone;
}

// ---------------------------------------------------------------------------
// Gravatar
// ---------------------------------------------------------------------------

/**
 * URL Gravatar d'une adresse, ou null.
 *
 * Aucune requête n'est faite par le serveur : c'est le navigateur qui va
 * chercher l'image, et seulement si l'administrateur l'a autorisé. `d=404`
 * garantit un échec propre quand l'adresse n'a pas d'avatar, ce qui laisse le
 * front retomber sur les initiales colorées.
 */
function gravatarUrl(email, size = 160) {
  if (!gravatarAllowed()) return null;
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return null;
  const hash = createHash('sha256').update(clean).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

function gravatarAllowed() {
  return !!appSettings()?.gravatar_enabled;
}

// ---------------------------------------------------------------------------
// Couleur d'avatar
// ---------------------------------------------------------------------------

/** Lot 112 — le seul format de couleur d'avatar admis : `#rrggbb`. */
const FORMAT_COULEUR_AVATAR = /^#[0-9a-fA-F]{6}$/;

/**
 * La couleur d'avatar telle qu'elle peut être servie, ou null.
 *
 * Elle finit dans un attribut `style` (web/fmt.js, `avatarHtml`) : jusqu'à la
 * 0.1.9, toute chaîne de 32 caractères était rangée, de quoi y glisser une
 * autre déclaration CSS. Une valeur rangée hors format est servie comme
 * absente — elle n'est jamais réécrite en base.
 */
function couleurAvatar(valeur) {
  return typeof valeur === 'string' && FORMAT_COULEUR_AVATAR.test(valeur) ? valeur : null;
}

module.exports = {
  securityPolicy,
  twoFactorMode,
  setTwoFactorMode,
  twoFactorSelfServiceAllowed,
  TWO_FACTOR_MODES,
  TIME_FORMATS,
  DATE_FORMATS,
  timezones,
  isValidTimezone,
  appSettings,
  VOLETS_DETAIL,
  detailRecuperation,
  publicSettings,
  updateAppSettings,
  timezone,
  gravatarUrl,
  gravatarAllowed,
  couleurAvatar,
};
