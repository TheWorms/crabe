'use strict';

/**
 * Planification (lot 3) :
 *   - calcul de la prochaine exécution — passage de mois, dernier jour du
 *     mois, changement d'heure été / hiver ;
 *   - une planification par installation RÉELLE, jamais par connecteur du
 *     catalogue (correction du « 13 planifications actives ») ;
 *   - verrou anti-exécution concurrente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const schedules = require('../server/schedules');
const scheduler = require('../server/scheduler');
const registry = require('../server/connectors/registry');
const permissions = require('../server/permissions');
const { config } = require('../server/config');

let admin;
let simple;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({ username: 'pilote', plainPassword: 'MotDePasse1', role: 'admin' });
  simple = await helpers.createUser({ username: 'passagere', plainPassword: 'MotDePasse1' });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});

test.after(() => {
  scheduler.stopAll();
  helpers.teardown();
});

/** Heure murale d'un instant, dans le fuseau applicatif. */
function wallClock(iso, timeZone = 'Europe/Paris') {
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const { type, value } of formatter.formatToParts(new Date(iso))) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const base = { enabled: true, timeOfDay: '03:00', dayOfWeek: 1, dayOfMonth: 1, lastDayOfMonth: false };

// ---------------------------------------------------------------------------
// Prochaine exécution
// ---------------------------------------------------------------------------

test('quotidienne : aujourd\'hui si c\'est encore devant, demain sinon', () => {
  const daily = { ...base, frequency: 'daily', timeOfDay: '03:00' };

  const avant = schedules.nextRunAt(daily, new Date('2026-08-09T00:30:00Z'), 'Europe/Paris');
  assert.equal(wallClock(avant), '2026-08-09 03:00');

  const apres = schedules.nextRunAt(daily, new Date('2026-08-09T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(apres), '2026-08-10 03:00');
});

test('hebdomadaire : le bon jour de la semaine, jamais celui d\'avant', () => {
  // 2026-08-09 est un dimanche.
  const mercredi = { ...base, frequency: 'weekly', dayOfWeek: 3 };
  const suivant = schedules.nextRunAt(mercredi, new Date('2026-08-09T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(suivant), '2026-08-12 03:00');

  // Le jour même, avant l'heure : c'est aujourd'hui.
  const dimanche = { ...base, frequency: 'weekly', dayOfWeek: 0 };
  const aujourdhui = schedules.nextRunAt(dimanche, new Date('2026-08-09T00:10:00Z'), 'Europe/Paris');
  assert.equal(wallClock(aujourdhui), '2026-08-09 03:00');
});

test('mensuelle : passage au mois suivant quand le jour est passé', () => {
  const cinq = { ...base, frequency: 'monthly', dayOfMonth: 5 };

  const ceMois = schedules.nextRunAt(cinq, new Date('2026-08-02T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(ceMois), '2026-08-05 03:00');

  const moisSuivant = schedules.nextRunAt(cinq, new Date('2026-08-09T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(moisSuivant), '2026-09-05 03:00');

  // Passage d'année.
  const decembre = schedules.nextRunAt(cinq, new Date('2026-12-20T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(decembre), '2027-01-05 03:00');
});

test('mensuelle : le jour est borné à 28, pour ne jamais sauter février', () => {
  const trop = schedules.sanitize({ frequency: 'monthly', dayOfMonth: 31 });
  assert.equal(trop.dayOfMonth, 28);
  assert.equal(schedules.sanitize({ frequency: 'monthly', dayOfMonth: 0 }).dayOfMonth, 1);

  const fevrier = schedules.nextRunAt(
    { ...base, frequency: 'monthly', dayOfMonth: 28 },
    new Date('2027-02-01T10:00:00Z'),
    'Europe/Paris'
  );
  assert.equal(wallClock(fevrier), '2027-02-28 03:00');
});

test('« dernier jour du mois » tombe juste, année bissextile comprise', () => {
  const dernier = { ...base, frequency: 'monthly', lastDayOfMonth: true };

  assert.equal(
    wallClock(schedules.nextRunAt(dernier, new Date('2026-08-09T10:00:00Z'), 'Europe/Paris')),
    '2026-08-31 03:00'
  );
  // Février d'une année ordinaire, puis d'une année bissextile.
  assert.equal(
    wallClock(schedules.nextRunAt(dernier, new Date('2027-02-01T10:00:00Z'), 'Europe/Paris')),
    '2027-02-28 03:00'
  );
  assert.equal(
    wallClock(schedules.nextRunAt(dernier, new Date('2028-02-01T10:00:00Z'), 'Europe/Paris')),
    '2028-02-29 03:00'
  );
  // Le 30 avril, pas le 31 qui n'existe pas.
  assert.equal(
    wallClock(schedules.nextRunAt(dernier, new Date('2026-04-15T10:00:00Z'), 'Europe/Paris')),
    '2026-04-30 03:00'
  );
});

test('« dernier jour du mois » : le cron couvre 28-31, la tâche filtre le reste', () => {
  const dernier = { ...base, frequency: 'monthly', lastDayOfMonth: true };
  assert.equal(schedules.toCronExpression(dernier), '0 3 28,29,30,31 * *');

  // Le 30 avril EST le dernier jour ; le 30 mai ne l'est pas.
  assert.equal(schedules.isDueOn(dernier, new Date('2026-04-30T12:00:00Z'), 'Europe/Paris'), true);
  assert.equal(schedules.isDueOn(dernier, new Date('2026-05-30T12:00:00Z'), 'Europe/Paris'), false);
  assert.equal(schedules.isDueOn(dernier, new Date('2026-05-31T12:00:00Z'), 'Europe/Paris'), true);

  // Une planification qui ne vise pas la fin du mois n'est jamais filtrée.
  const cinq = { ...base, frequency: 'monthly', dayOfMonth: 5 };
  assert.equal(schedules.isDueOn(cinq, new Date('2026-05-30T12:00:00Z'), 'Europe/Paris'), true);
});

test('changement d\'heure : 03:00 reste 03:00 à Paris, en été comme en hiver', () => {
  const daily = { ...base, frequency: 'daily', timeOfDay: '03:00' };

  // Passage à l'heure d'été : nuit du 28 au 29 mars 2026 (02:00 → 03:00).
  const printemps = schedules.nextRunAt(daily, new Date('2026-03-28T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(printemps), '2026-03-29 03:00');
  // En heure d'été, 03:00 à Paris vaut 01:00 UTC ; en heure d'hiver, 02:00.
  assert.equal(printemps.slice(11, 16), '01:00', 'décalage d\'été appliqué');

  const hiver = schedules.nextRunAt(daily, new Date('2026-03-20T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(hiver), '2026-03-21 03:00');
  assert.equal(hiver.slice(11, 16), '02:00', 'décalage d\'hiver appliqué');

  // Passage à l'heure d'hiver : nuit du 24 au 25 octobre 2026.
  const automne = schedules.nextRunAt(daily, new Date('2026-10-24T10:00:00Z'), 'Europe/Paris');
  assert.equal(wallClock(automne), '2026-10-25 03:00');
  assert.equal(automne.slice(11, 16), '02:00');
});

test('une planification désactivée ou suspendue n\'a pas de prochaine exécution', () => {
  assert.equal(schedules.nextRunAt({ ...base, frequency: 'disabled' }), null);
  assert.equal(schedules.nextRunAt({ ...base, frequency: 'daily', enabled: false }), null);
  assert.equal(schedules.toCronExpression({ ...base, frequency: 'daily', enabled: false }), null);
});

test('le rythme se dit en français, pour le journal comme pour l\'écran', () => {
  assert.equal(schedules.rhythmLabel({ ...base, frequency: 'daily' }), 'quotidien, à 03:00');
  assert.equal(
    schedules.rhythmLabel({ ...base, frequency: 'weekly', dayOfWeek: 3 }),
    'hebdomadaire, mercredi à 03:00'
  );
  assert.equal(
    schedules.rhythmLabel({ ...base, frequency: 'monthly', dayOfMonth: 5 }),
    'mensuel, jour 5 à 03:00'
  );
  assert.equal(
    schedules.rhythmLabel({ ...base, frequency: 'monthly', lastDayOfMonth: true }),
    'mensuel, dernier jour du mois à 03:00'
  );
});

// ---------------------------------------------------------------------------
// Une planification par installation réelle
// ---------------------------------------------------------------------------

test('sans installation, aucune planification — même avec un catalogue bien fourni', () => {
  assert.ok(registry.listAll().length >= 10, 'le catalogue est bien fourni');
  assert.deepEqual(schedules.listInstallations(), []);
  assert.deepEqual(scheduler.listSchedules(), []);
});

test('installer crée la planification, désinstaller la retire', () => {
  registry.install(simple.id, 'edf');

  const apresInstall = scheduler.listSchedules();
  assert.equal(apresInstall.length, 1);
  assert.equal(apresInstall[0].id, `${simple.id}:edf`);
  assert.equal(apresInstall[0].username, 'passagere');
  assert.equal(apresInstall[0].connectorId, 'edf');
  assert.ok(apresInstall[0].nextRunAt);

  registry.uninstall(simple.id, 'edf');
  assert.deepEqual(scheduler.listSchedules(), []);
  assert.equal(schedules.get(simple.id, 'edf'), null);
});

test('deux comptes, deux planifications indépendantes sur le même connecteur', () => {
  registry.install(admin.id, 'edf');
  registry.install(simple.id, 'edf');

  scheduler.saveSchedule(admin.id, 'edf', { frequency: 'daily', timeOfDay: '07:15' });
  scheduler.saveSchedule(simple.id, 'edf', {
    frequency: 'monthly',
    timeOfDay: '23:45',
    lastDayOfMonth: true,
  });

  const parCompte = new Map(scheduler.listSchedules().map((s) => [s.username, s]));
  assert.equal(parCompte.get('pilote').timeOfDay, '07:15');
  assert.equal(parCompte.get('pilote').frequency, 'daily');
  assert.equal(parCompte.get('passagere').timeOfDay, '23:45');
  assert.equal(parCompte.get('passagere').lastDayOfMonth, true);
  // Modifier l'un n'a pas touché l'autre.
  assert.equal(parCompte.get('pilote').lastDayOfMonth, false);
});

test('le scheduler n\'arme une tâche que pour les couples exécutables', (t) => {
  // Les tests tournent avec le scheduler coupé : on le rallume le temps de
  // vérifier ce qui serait réellement planifié, puis on arrête tout.
  const initial = config.schedulerDisabled;
  config.schedulerDisabled = false;
  t.after(() => {
    scheduler.stopAll();
    config.schedulerDisabled = initial;
  });

  // Installé mais pas configuré : rien à exécuter, donc rien à armer.
  let etat = scheduler.reload();
  assert.equal(etat.scheduled, 0, 'un connecteur non configuré ne se planifie pas');

  const manifest = registry.manifest('edf');
  const identifiants = Object.fromEntries(manifest.fields.map((f) => [f.key, 'valeur-de-test']));
  registry.saveConfig(admin.id, 'edf', identifiants);

  etat = scheduler.reload();
  assert.equal(etat.scheduled, 1, 'une seule tâche : le seul couple configuré');
  assert.match(etat.details[0], /^edf \(pilote, quotidien, à 07:15, prochaine le \d{2}\/\d{2}\/\d{4}\)$/);
  assert.match(scheduler.summarize(etat), /^1 planification — edf \(pilote/);

  // Compte désactivé : la tâche disparaît, sans que la planification soit perdue.
  helpers.db.get().prepare("UPDATE users SET status = 'inactive' WHERE id = ?").run(admin.id);
  assert.equal(scheduler.reload().scheduled, 0);
  helpers.db.get().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.id);
  assert.equal(scheduler.reload().scheduled, 1);

  // Planification suspendue : la donnée reste, la tâche non.
  scheduler.saveSchedule(admin.id, 'edf', { enabled: false });
  assert.equal(scheduler.reload().scheduled, 0);
  assert.equal(schedules.get(admin.id, 'edf').frequency, 'daily', 'la fréquence est conservée');
  scheduler.saveSchedule(admin.id, 'edf', { enabled: true });
});

test('le résumé de démarrage détaille, il ne se contente pas de compter', () => {
  assert.equal(
    scheduler.summarize({ scheduled: 0, disabled: true, details: [] }),
    'désactivé (CRABE_DISABLE_SCHEDULER=1)'
  );
  assert.equal(
    scheduler.summarize({ scheduled: 0, disabled: false, details: [] }),
    'aucune planification — aucun connecteur installé et configuré'
  );
  assert.equal(
    scheduler.summarize({ scheduled: 2, disabled: false, details: ['a', 'b'] }),
    '2 planifications — a · b'
  );
});

test('planifier un connecteur non installé pour ce compte est refusé', () => {
  assert.throws(() => scheduler.saveSchedule(simple.id, 'ovh', { frequency: 'daily' }), /pas installé/);
  assert.throws(() => scheduler.saveSchedule(simple.id, 'inconnu', {}), /Connecteur inconnu/);
});

// ---------------------------------------------------------------------------
// Verrou anti-exécution concurrente
// ---------------------------------------------------------------------------

test('un même connecteur ne peut pas être lancé deux fois en parallèle', async (t) => {
  const original = registry.fetchInvoicesDetailed;
  // Une récupération lente, pour que les deux appels se chevauchent vraiment.
  registry.fetchInvoicesDetailed = () =>
    new Promise((resolve) => setTimeout(() => resolve({ invoices: [], accountId: null }), 120));
  t.after(() => {
    registry.fetchInvoicesDetailed = original;
  });

  const manifest = registry.manifest('edf');
  registry.saveConfig(
    admin.id,
    'edf',
    Object.fromEntries(manifest.fields.map((f) => [f.key, 'valeur-de-test']))
  );

  const premier = scheduler.runForUser(admin.id, 'edf', 'manual');
  // Le verrou est pris dès l'appel, pas à la première écriture.
  assert.equal(scheduler.isRunning(admin.id, 'edf'), true);
  assert.deepEqual(
    scheduler.runningPairs().map((p) => `${p.userId}:${p.connectorId}`),
    [`${admin.id}:edf`]
  );

  await assert.rejects(
    () => scheduler.runForUser(admin.id, 'edf', 'manual'),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.alreadyRunning, true);
      assert.match(err.message, /déjà en cours/);
      return true;
    }
  );

  const resultat = await premier;
  assert.equal(resultat.ok, true);

  // Verrou relâché : un nouveau lancement redevient possible.
  assert.equal(scheduler.isRunning(admin.id, 'edf'), false);
  const second = await scheduler.runForUser(admin.id, 'edf', 'manual');
  assert.equal(second.ok, true);

  // Une seule exécution a été enregistrée par lancement accepté : la tentative
  // refusée ne laisse pas de ligne fantôme dans les journaux.
  const lignes = helpers.db
    .get()
    .prepare("SELECT COUNT(*) AS n FROM run_logs WHERE user_id = ? AND connector_id = 'edf' AND trigger = 'manual'")
    .get(admin.id).n;
  assert.equal(lignes, 2);
});

test('le verrou est par couple : deux comptes peuvent synchroniser en même temps', async (t) => {
  const original = registry.fetchInvoicesDetailed;
  registry.fetchInvoicesDetailed = () =>
    new Promise((resolve) => setTimeout(() => resolve({ invoices: [], accountId: null }), 80));
  t.after(() => {
    registry.fetchInvoicesDetailed = original;
  });

  const manifest = registry.manifest('edf');
  const identifiants = Object.fromEntries(manifest.fields.map((f) => [f.key, 'valeur-de-test']));
  registry.saveConfig(admin.id, 'edf', identifiants);
  registry.saveConfig(simple.id, 'edf', identifiants);

  const [a, b] = await Promise.all([
    scheduler.runForUser(admin.id, 'edf', 'manual'),
    scheduler.runForUser(simple.id, 'edf', 'manual'),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('l\'API répond 409 sur une seconde synchronisation, sans casser la page', async (t) => {
  const original = registry.fetchInvoicesDetailed;
  registry.fetchInvoicesDetailed = () =>
    new Promise((resolve) => setTimeout(() => resolve({ invoices: [], accountId: null }), 150));
  t.after(() => {
    registry.fetchInvoicesDetailed = original;
  });

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'pilote', 'MotDePasse1');

  const manifest = registry.manifest('edf');
  registry.saveConfig(
    admin.id,
    'edf',
    Object.fromEntries(manifest.fields.map((f) => [f.key, 'valeur-de-test']))
  );

  const [premier, second] = await Promise.all([
    client.post('/api/connectors/edf/run'),
    // Décalé d'un souffle, pour être sûr que le premier a pris le verrou.
    new Promise((resolve) => setTimeout(() => resolve(client.post('/api/connectors/edf/run')), 30)),
  ]);

  assert.equal(premier.status, 200);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /déjà en cours/);
});

test('révoquer puis supprimer un compte retire ses tâches planifiées', (t) => {
  const initial = config.schedulerDisabled;
  config.schedulerDisabled = false;
  t.after(() => {
    scheduler.stopAll();
    config.schedulerDisabled = initial;
  });

  const partant = helpers.db
    .get()
    .prepare("INSERT INTO users (username, password_hash, role) VALUES ('partant', 'hash', 'user')")
    .run().lastInsertRowid;

  registry.install(partant, 'edf');
  const manifest = registry.manifest('edf');
  registry.saveConfig(
    partant,
    'edf',
    Object.fromEntries(manifest.fields.map((f) => [f.key, 'valeur-de-test']))
  );

  const avant = scheduler.reload().scheduled;
  assert.ok(avant >= 1, 'le compte a bien une tâche armée');

  // La suppression de la ligne `users` emporte la planification (CASCADE),
  // et le scheduler doit être rechargé dans la foulée.
  helpers.db.get().prepare('DELETE FROM users WHERE id = ?').run(partant);
  assert.equal(schedules.get(partant, 'edf'), null);
  assert.equal(scheduler.reload().scheduled, avant - 1);
});

// ---------------------------------------------------------------------------
// Lot 4 — identifiants vides : la route ne se laisse pas marteler
// ---------------------------------------------------------------------------

test('un identifiant de compte ou de connecteur vide est refusé proprement', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'pilote', 'MotDePasse1');

  // La forme exacte observée en production : deux barres obliques d'affilée.
  // Express la faisait tomber sur l'action groupée, qui répondait « Aucune
  // planification sélectionnée » — un message qui envoyait sur une fausse piste.
  const vide = await client.put('/api/admin/schedules//', { frequency: 'daily' });
  assert.equal(vide.status, 400);
  assert.match(vide.body.error, /Identifiants de planification manquants/);

  // Répétée en rafale, la réponse reste la même et reste bon marché.
  const rafale = await Promise.all(
    Array.from({ length: 12 }, () => client.put('/api/admin/schedules//', { frequency: 'daily' }))
  );
  assert.deepEqual([...new Set(rafale.map((r) => r.status))], [400]);

  // Un compte qui n'est pas un entier ne passe pas non plus.
  for (const mauvais of ['abc', '0', '-3', '1.5']) {
    const res = await client.put(`/api/admin/schedules/${mauvais}/free`, { frequency: 'daily' });
    assert.equal(res.status, 400, `compte « ${mauvais} » aurait dû être refusé`);
    assert.match(res.body.error, /Compte invalide/);
  }

  // Un connecteur inconnu reste un 404, pas un 400 : la distinction compte.
  const inconnu = await client.put(`/api/admin/schedules/${admin.id}/nexiste-pas`, {
    frequency: 'daily',
  });
  assert.equal(inconnu.status, 404);
});

test('chaque planification listée porte un couple (compte, connecteur) exploitable', () => {
  registry.install(simple.id, 'edf');
  for (const s of scheduler.listSchedules()) {
    assert.ok(Number.isInteger(s.userId) && s.userId > 0, `userId manquant sur ${s.id}`);
    assert.ok(s.connectorId, `connectorId manquant sur ${s.id}`);
    assert.equal(s.id, `${s.userId}:${s.connectorId}`);
  }
});
