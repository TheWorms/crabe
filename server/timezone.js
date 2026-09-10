'use strict';

/**
 * Arithmétique de fuseau horaire, sans dépendance.
 *
 * Contexte : le conteneur tournait en Etc/UTC alors que crabe.env déclarait
 * TZ=Europe/Paris, ce qui produisait des horodatages et des heures
 * d'exécution incohérents. Le fuseau de référence est désormais un réglage
 * applicatif (app_settings.timezone), et c'est LUI qui sert à la fois au
 * scheduler et au calcul des prochaines exécutions — quel que soit le fuseau
 * du système d'exploitation.
 */

/** Composantes d'une date, telles qu'un humain les lit dans un fuseau donné. */
function partsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;

  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl rend « 24 » à minuit sur certaines plateformes.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

/** Décalage du fuseau, en millisecondes, à l'instant donné. */
function offsetMs(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // On perd les millisecondes : sans importance pour une planification.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convertit une heure murale (« le 3 août à 03:00 à Paris ») en instant UTC.
 * Le second passage rattrape les changements d'heure.
 */
function wallClockToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(naive), timeZone);
  let timestamp = naive - first;
  const second = offsetMs(new Date(timestamp), timeZone);
  if (second !== first) timestamp = naive - second;
  return new Date(timestamp);
}

/** Le fuseau est-il connu de l'environnement ? */
function isValid(timeZone) {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone });
    return true;
  } catch {
    return false;
  }
}

module.exports = { partsInZone, offsetMs, wallClockToUtc, isValid };
