'use strict';

/**
 * §9 du lot 14 — « tous les 3 mois » et « tous les 6 mois ».
 *
 * Besoin réel jamais transcrit dans les lots précédents : le maximum
 * réglable était « mensuelle ». Beaucoup de factures ne tombent pas tous les
 * mois — une assurance, une taxe, un abonnement annuel — et faire tourner un
 * navigateur douze fois par an pour zéro document est du bruit, chez le
 * fournisseur comme dans les journaux.
 *
 * ─── Ce que « ancré sur le mois de la première exécution » veut dire ─────────
 *
 * Une trimestrielle réglée en février tombe en février, mai, août, novembre —
 * PAS en janvier, avril, juillet, octobre. Sans ancrage, tout le monde
 * partirait du 1er janvier et se retrouverait avec le calendrier de quelqu'un
 * d'autre. C'est ce que la moitié de ce fichier vérifie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// helpers d'abord : il pose l'environnement de test (phrase maîtresse, répertoire
// de données) avant que server/config ne fige sa lecture des variables.
require('./helpers');
const schedules = require('../server/schedules');

/** Une planification complète, dont on ne change que ce qu'on veut éprouver. */
function planif(extra = {}) {
  return {
    frequency: 'quarterly',
    timeOfDay: '03:00',
    dayOfWeek: 1,
    dayOfMonth: 5,
    lastDayOfMonth: false,
    enabled: true,
    anchorMonth: 2,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Les deux fréquences existent, et se règlent
// ---------------------------------------------------------------------------

test('les deux nouvelles fréquences sont proposées, et « désactivée » reste en dernier', () => {
  assert.deepEqual(schedules.FREQUENCIES, [
    'daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'disabled',
  ]);
  assert.equal(schedules.FREQUENCY_LABELS.quarterly, 'tous les 3 mois');
  assert.equal(schedules.FREQUENCY_LABELS['half-yearly'], 'tous les 6 mois');
});

test('une fréquence inconnue retombe sur la valeur précédente, jamais sur du hasard', () => {
  const propre = schedules.sanitize({ frequency: 'toutes-les-lunes' }, planif());
  assert.equal(propre.frequency, 'quarterly');
});

// ---------------------------------------------------------------------------
// L'ancrage
// ---------------------------------------------------------------------------

test('une trimestrielle ancrée en février tombe en février, mai, août, novembre', () => {
  assert.deepEqual(schedules.moisDeclenchement('quarterly', 2), [2, 5, 8, 11]);
  assert.deepEqual(schedules.moisDeclenchement('quarterly', 1), [1, 4, 7, 10]);
  // Décembre : le tour de l'année se fait sans trou ni doublon.
  assert.deepEqual(schedules.moisDeclenchement('quarterly', 12), [3, 6, 9, 12]);
});

test('une semestrielle n\'a que deux mois, six mois d\'écart', () => {
  assert.deepEqual(schedules.moisDeclenchement('half-yearly', 2), [2, 8]);
  assert.deepEqual(schedules.moisDeclenchement('half-yearly', 9), [3, 9]);
});

test('les fréquences mensuelle et hebdomadaire n\'ont pas d\'ancrage', () => {
  assert.equal(schedules.estPluriMensuelle('monthly'), false);
  assert.equal(schedules.estPluriMensuelle('weekly'), false);
  assert.deepEqual(schedules.moisDeclenchement('monthly', 3), []);
});

// ---------------------------------------------------------------------------
// L'expression cron
// ---------------------------------------------------------------------------

test('le cron restreint les MOIS, pour ne pas réveiller le service pour rien', () => {
  assert.equal(schedules.toCronExpression(planif()), '0 3 5 2,5,8,11 *');
  assert.equal(
    schedules.toCronExpression(planif({ frequency: 'half-yearly', anchorMonth: 9 })),
    '0 3 5 3,9 *'
  );
  // Le mensuel, lui, n'a rien à restreindre.
  assert.equal(schedules.toCronExpression(planif({ frequency: 'monthly' })), '0 3 5 * *');
});

test('« dernier jour du mois » vaut aussi pour les fréquences longues', () => {
  // node-cron ne connaît pas le `L` : on arme 28 à 31 et `isDueOn` tranche.
  assert.equal(
    schedules.toCronExpression(planif({ lastDayOfMonth: true })),
    '0 3 28,29,30,31 2,5,8,11 *'
  );

  const trimestrielle = planif({ lastDayOfMonth: true });
  // Le 30 novembre est bien le dernier jour de novembre.
  assert.equal(
    schedules.isDueOn(trimestrielle, new Date('2026-11-30T03:00:00Z'), 'Europe/Paris'),
    true
  );
  // Le 28, non — et la tâche armée ce jour-là ne doit pas partir.
  assert.equal(
    schedules.isDueOn(trimestrielle, new Date('2026-11-28T03:00:00Z'), 'Europe/Paris'),
    false
  );
});

test('une planification désactivée n\'arme aucune tâche', () => {
  assert.equal(schedules.toCronExpression(planif({ enabled: false })), null);
  assert.equal(schedules.toCronExpression(planif({ frequency: 'disabled' })), null);
});

// ---------------------------------------------------------------------------
// La prochaine exécution — la preuve exigée par le §11
// ---------------------------------------------------------------------------

test('la prochaine exécution saute au mois autorisé suivant', () => {
  const zone = 'Europe/Paris';
  const trimestrielle = planif(); // février, mai, août, novembre — le 5, à 03:00

  // Le 11 août 2026 : le 5 août est passé, donc novembre.
  assert.equal(
    schedules.nextRunAt(trimestrielle, new Date('2026-08-11T10:00:00Z'), zone),
    '2026-11-05T02:00:00.000Z'
  );

  // Le 1er août 2026 : le 5 août est encore devant.
  assert.equal(
    schedules.nextRunAt(trimestrielle, new Date('2026-08-01T10:00:00Z'), zone),
    '2026-08-05T01:00:00.000Z'
  );

  // Et depuis novembre, on passe à l'année suivante sans se tromper de mois.
  assert.equal(
    schedules.nextRunAt(trimestrielle, new Date('2026-11-30T10:00:00Z'), zone),
    '2027-02-05T02:00:00.000Z'
  );
});

test('la semestrielle attend bien six mois, pas trois', () => {
  const semestrielle = planif({ frequency: 'half-yearly' }); // février et août
  assert.equal(
    schedules.nextRunAt(semestrielle, new Date('2026-08-11T10:00:00Z'), 'Europe/Paris'),
    '2027-02-05T02:00:00.000Z'
  );
});

test('l\'heure affichée est l\'heure murale du fuseau, été comme hiver', () => {
  const zone = 'Europe/Paris';
  // Le 5 août est en heure d'été (UTC+2) : 03:00 locales = 01:00 UTC.
  assert.equal(
    schedules.nextRunAt(planif(), new Date('2026-08-01T10:00:00Z'), zone),
    '2026-08-05T01:00:00.000Z'
  );
  // Le 5 novembre est en heure d'hiver (UTC+1) : 03:00 locales = 02:00 UTC.
  assert.equal(
    schedules.nextRunAt(planif(), new Date('2026-09-01T10:00:00Z'), zone),
    '2026-11-05T02:00:00.000Z'
  );
});

test('« dernier jour du mois » vise le bon jour, février compris', () => {
  const zone = 'Europe/Paris';
  const trimestrielle = planif({ lastDayOfMonth: true, anchorMonth: 2 });

  // Février 2027 n'est pas bissextile : 28 jours.
  assert.equal(
    schedules.nextRunAt(trimestrielle, new Date('2026-12-01T10:00:00Z'), zone),
    '2027-02-28T02:00:00.000Z'
  );
});

// ---------------------------------------------------------------------------
// Le libellé
// ---------------------------------------------------------------------------

test('le rythme affiché NOMME les mois : c\'est le seul contrôle d\'un coup d\'œil', () => {
  assert.equal(
    schedules.rhythmLabel(planif()),
    'tous les 3 mois (février, mai, août, novembre), jour 5 à 03:00'
  );
  assert.equal(
    schedules.rhythmLabel(planif({ frequency: 'half-yearly', anchorMonth: 9 })),
    'tous les 6 mois (mars, septembre), jour 5 à 03:00'
  );
  assert.equal(
    schedules.rhythmLabel(planif({ lastDayOfMonth: true })),
    'tous les 3 mois (février, mai, août, novembre), dernier jour du mois à 03:00'
  );
});

test('les rythmes existants n\'ont pas bougé', () => {
  assert.equal(schedules.rhythmLabel(planif({ frequency: 'daily' })), 'quotidien, à 03:00');
  assert.equal(
    schedules.rhythmLabel(planif({ frequency: 'monthly' })),
    'mensuel, jour 5 à 03:00'
  );
  assert.equal(schedules.rhythmLabel(planif({ frequency: 'disabled' })), 'désactivé');
});

// ---------------------------------------------------------------------------
// L'ancrage, à travers le VRAI chemin d'enregistrement
// ---------------------------------------------------------------------------

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');

test.before(async () => helpers.setup());
test.after(() => helpers.teardown());

test('l\'ancrage est posé au mois de la première exécution, et ne bouge plus', async () => {
  const user = await helpers.createUser({ username: 'camille' });
  registry.install(user.id, 'kubii');

  // Le 11 août : le jour 5 est passé, la première exécution tombe donc en
  // SEPTEMBRE — et c'est septembre qui doit ancrer le trimestre, pas août.
  const pose = schedules.save(
    user.id,
    'kubii',
    { frequency: 'quarterly', dayOfMonth: 5, timeOfDay: '03:00', enabled: true },
    { now: new Date('2026-08-11T10:00:00Z') }
  );

  assert.equal(pose.anchorMonth, 9, 'l\'ancrage suit la première exécution, pas le mois courant');
  assert.deepEqual(schedules.moisDeclenchement('quarterly', pose.anchorMonth), [3, 6, 9, 12]);

  // Rouvrir l'écran et changer l'HEURE ne doit pas déplacer le trimestre :
  // sans ça, la « prochaine exécution » reculerait à chaque visite.
  const retouche = schedules.save(
    user.id,
    'kubii',
    { timeOfDay: '05:30' },
    { now: new Date('2026-12-20T10:00:00Z') }
  );
  assert.equal(retouche.anchorMonth, 9, 'l\'ancrage ne se recalcule pas à chaque enregistrement');
  assert.equal(retouche.timeOfDay, '05:30');

  // Et passer de trimestriel à semestriel garde le même point de départ.
  const semestrielle = schedules.save(
    user.id,
    'kubii',
    { frequency: 'half-yearly' },
    { now: new Date('2027-01-05T10:00:00Z') }
  );
  assert.equal(semestrielle.anchorMonth, 9);
  assert.deepEqual(schedules.moisDeclenchement('half-yearly', 9), [3, 9]);
});

test('une planification mensuelle ne se voit pas inventer d\'ancrage', async () => {
  const user = await helpers.createUser({ username: 'sansancre' });
  registry.install(user.id, 'kubii');

  const pose = schedules.save(user.id, 'kubii', { frequency: 'monthly', dayOfMonth: 5 });
  assert.equal(pose.anchorMonth, null, 'un ancrage inutile est une donnée fausse de plus');
});
