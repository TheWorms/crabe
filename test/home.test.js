'use strict';

/**
 * Accueil configurable : préférences par compte, état de transfert par
 * destination, filtrage des destinations non autorisées, renvoi d'un document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const home = require('../server/home');
const invoices = require('../server/invoices');
const destinations = require('../server/destinations');
const registry = require('../server/connectors/registry');
const permissions = require('../server/permissions');

let alix;
let bruno;

test.before(async () => {
  await helpers.setup();
  alix = await helpers.createUser({ username: 'alix', plainPassword: 'MotDePasse1', role: 'admin' });
  bruno = await helpers.createUser({ username: 'bruno', plainPassword: 'MotDePasse1' });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, alix.id);
});

test.after(() => helpers.teardown());

/** Insère une facture avec l'état de transfert voulu. */
function seedInvoice(userId, { filename, destinations: dests = {}, remoteId = null }) {
  return helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'free', ?, ?, 'fbx1', 1024, '2026-07-05', ?)`
    )
    .run(userId, filename, remoteId, JSON.stringify(dests)).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Préférences de blocs
// ---------------------------------------------------------------------------

test('sans préférence enregistrée, la disposition par défaut est complète', () => {
  const widgets = home.preferencesFor(alix.id);
  assert.deepEqual(
    widgets.map((w) => w.id),
    ['connecteurs', 'stats', 'sync', 'errors', 'documents', 'destinations']
  );
  assert.equal(widgets.every((w) => w.enabled), true);
  // Largeurs par défaut de la maquette validée : ligne entière partout, sauf
  // « Synchronisation » et « Erreurs et alertes » qui tiennent une demi-ligne.
  assert.deepEqual(
    widgets.map((w) => [w.id, w.span]),
    [
      ['connecteurs', 12],
      ['stats', 12],
      ['sync', 6],
      ['errors', 6],
      ['documents', 12],
      ['destinations', 12],
    ]
  );
  assert.deepEqual(widgets.map((w) => w.defaultSpan), widgets.map((w) => w.span));
});

test('aucun bloc n\'est jamais renvoyé deux fois', () => {
  // Le lot 3 affichait « Erreurs et alertes » en double sur l'accueil de
  // production. La liste est désormais construite depuis le catalogue, jamais
  // depuis les lignes lues en base : même une base incohérente ne peut plus
  // produire un doublon.
  home.savePreferences(alix.id, [
    { id: 'errors', enabled: true },
    { id: 'errors', enabled: false },
    { id: 'sync', enabled: true },
    { id: 'errors', enabled: true },
  ]);

  const ids = home.preferencesFor(alix.id).map((w) => w.id);
  assert.deepEqual([...new Set(ids)], ids, 'un bloc rendu deux fois');
  assert.equal(ids.length, home.WIDGET_IDS.length);

  home.resetPreferences(alix.id);
});

test('la largeur de chaque bloc est enregistrée, et bornée aux valeurs connues', () => {
  home.savePreferences(alix.id, [
    { id: 'sync', enabled: true, span: 4 },
    { id: 'errors', enabled: true, span: 3 },
    { id: 'stats', enabled: true, span: 7 }, // largeur inconnue : ignorée
  ]);

  const bySpan = Object.fromEntries(home.preferencesFor(alix.id).map((w) => [w.id, w.span]));
  assert.equal(bySpan.sync, 4);
  assert.equal(bySpan.errors, 3);
  assert.equal(bySpan.stats, 12, 'une largeur inconnue retombe sur celle du bloc');

  // Réinitialiser efface les largeurs comme le reste.
  home.resetPreferences(alix.id);
  assert.equal(home.preferencesFor(alix.id).find((w) => w.id === 'sync').span, 6);
});

test('la disposition est enregistrée en base, par compte', () => {
  home.savePreferences(alix.id, [
    { id: 'documents', enabled: true },
    { id: 'sync', enabled: false },
    { id: 'stats', enabled: true },
  ]);

  const pour = home.preferencesFor(alix.id);
  // Les trois blocs choisis viennent en tête, les autres suivent, activés.
  assert.deepEqual(pour.slice(0, 3).map((w) => w.id), ['documents', 'sync', 'stats']);
  assert.equal(pour.find((w) => w.id === 'sync').enabled, false);
  assert.equal(pour.length, 6, 'aucun bloc ne disparaît de la liste');
  assert.equal(pour.slice(3).every((w) => w.enabled), true);

  // Le compte voisin garde la disposition par défaut : rien n'est global.
  assert.deepEqual(
    home.preferencesFor(bruno.id).map((w) => w.id),
    ['connecteurs', 'stats', 'sync', 'errors', 'documents', 'destinations']
  );
});

test('une préférence survit à la reconnexion (elle est en base, pas dans le navigateur)', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'bruno', 'MotDePasse1');

  await client.put('/api/home/widgets', {
    widgets: [{ id: 'errors', enabled: true }, { id: 'connecteurs', enabled: false }],
  });

  // Nouvelle session, comme depuis un autre appareil.
  client.clearCookies();
  await helpers.login(client, 'bruno', 'MotDePasse1');
  const relu = await client.get('/api/home/widgets');

  assert.equal(relu.body.widgets[0].id, 'errors');
  assert.equal(relu.body.widgets.find((w) => w.id === 'connecteurs').enabled, false);
});

test('un identifiant de bloc inconnu est ignoré, sans faire disparaître les autres', () => {
  const widgets = home.savePreferences(bruno.id, [
    { id: 'inexistant', enabled: true },
    { id: 'documents', enabled: false },
  ]);
  assert.equal(widgets.length, 6);
  assert.equal(widgets.some((w) => w.id === 'inexistant'), false);
  assert.equal(widgets[0].id, 'documents');
});

test('la réinitialisation efface les préférences plutôt que d\'en réécrire', () => {
  home.savePreferences(bruno.id, [{ id: 'destinations', enabled: false }]);
  home.resetPreferences(bruno.id);

  assert.deepEqual(
    home.preferencesFor(bruno.id).map((w) => w.id),
    home.DEFAULT_ORDER
  );
  const restant = helpers.db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM user_home_widgets WHERE user_id = ?')
    .get(bruno.id).n;
  assert.equal(restant, 0);
});

// ---------------------------------------------------------------------------
// Verrouillage de l'accueil
// ---------------------------------------------------------------------------

/** Pose les deux verrous d'un compte, directement en base. */
function setLocks(userId, { adminAllows = 1, personal = 0 } = {}) {
  helpers.db
    .get()
    .prepare('UPDATE users SET home_customizable = ?, home_locked = ? WHERE id = ?')
    .run(adminAllows, personal, userId);
}

test('verrou administrateur : le serveur refuse (403), pas seulement l\'interface', async (t) => {
  const client = await helpers.startServer();
  t.after(() => {
    setLocks(bruno.id);
    return client.close();
  });
  await helpers.login(client, 'bruno', 'MotDePasse1');

  setLocks(bruno.id, { adminAllows: 0 });

  const enregistrement = await client.put('/api/home/widgets', {
    widgets: [{ id: 'errors', enabled: false }],
  });
  assert.equal(enregistrement.status, 403);
  assert.match(enregistrement.body.error, /désactivée par l'administrateur/);

  const remise = await client.post('/api/home/widgets/reset');
  assert.equal(remise.status, 403);

  // La disposition en vigueur reste servie, et reste intacte.
  const accueil = await client.get('/api/home');
  assert.equal(accueil.status, 200);
  assert.equal(accueil.body.access.adminAllowed, false);
  assert.equal(accueil.body.access.canCustomize, false);
  assert.equal(accueil.body.widgets.find((w) => w.id === 'errors').enabled, true);
});

test('verrou personnel : refusé aussi, mais l\'utilisateur peut le retirer lui-même', async (t) => {
  const client = await helpers.startServer();
  t.after(() => {
    setLocks(bruno.id);
    return client.close();
  });
  await helpers.login(client, 'bruno', 'MotDePasse1');

  const pose = await client.patch('/api/auth/profile', { homeLocked: true });
  assert.equal(pose.status, 200);
  assert.equal(pose.body.user.home.personalLock, true);

  const refus = await client.put('/api/home/widgets', { widgets: [{ id: 'sync', span: 3 }] });
  assert.equal(refus.status, 403);
  assert.match(refus.body.error, /Figer mon accueil/);

  // Il le retire seul : aucun administrateur nécessaire.
  const retrait = await client.patch('/api/auth/profile', { homeLocked: false });
  assert.equal(retrait.body.user.home.canCustomize, true);
  assert.equal((await client.put('/api/home/widgets', { widgets: [{ id: 'sync', span: 3 }] })).status, 200);
});

test('verrou administrateur : l\'utilisateur ne peut pas se réautoriser', async (t) => {
  const client = await helpers.startServer();
  t.after(() => {
    setLocks(bruno.id);
    return client.close();
  });
  await helpers.login(client, 'bruno', 'MotDePasse1');
  setLocks(bruno.id, { adminAllows: 0 });

  // Le seul levier du profil est le verrou personnel : il ne rend pas la main.
  await client.patch('/api/auth/profile', { homeLocked: false });
  const apres = await client.get('/api/home/widgets');
  assert.equal(apres.body.access.adminAllowed, false);
  assert.equal(apres.body.access.canCustomize, false);
  assert.equal((await client.post('/api/home/widgets/reset')).status, 403);
});

test('« appliquer cette disposition à tous » recopie l\'accueil de l\'administrateur', () => {
  home.savePreferences(alix.id, [
    { id: 'documents', enabled: true, span: 6 },
    { id: 'errors', enabled: false, span: 3 },
  ]);

  const result = home.applyLayoutToEveryone(alix.id);
  assert.ok(result.applied >= 1);

  const chezBruno = home.preferencesFor(bruno.id);
  assert.equal(chezBruno[0].id, 'documents');
  assert.equal(chezBruno[0].span, 6);
  assert.equal(chezBruno.find((w) => w.id === 'errors').enabled, false);
  assert.equal(chezBruno.find((w) => w.id === 'errors').span, 3);

  home.resetPreferences(alix.id);
  home.resetPreferences(bruno.id);
});

// ---------------------------------------------------------------------------
// État de transfert par destination
// ---------------------------------------------------------------------------

test('chaque état de transfert a sa pastille et son explication', () => {
  const stored = JSON.stringify({
    local: { state: 'ok', ok: true, at: '2026-08-01T10:00:00.000Z', path: '/mnt/x.pdf' },
    proton: { state: 'error', ok: false, at: '2026-08-01T10:00:00.000Z', message: 'quota dépassé' },
  });

  const etats = invoices.statesFor(stored, ['local', 'proton', 'pcloud']);
  assert.deepEqual(etats.map((d) => d.state), ['ok', 'error', 'pending']);
  assert.match(etats[0].tooltip, /copié le/);
  assert.match(etats[1].tooltip, /échec.*quota dépassé/);
  assert.match(etats[2].tooltip, /en attente/);
  assert.equal(invoices.hasFailure(stored, ['local', 'proton']), true);
  assert.equal(invoices.hasFailure(stored, ['local']), false);
});

test('une trace antérieure au suivi détaillé reste « inconnue », jamais « OK »', () => {
  // Format d'avant le lot 3 : un succès sans date ni état explicite.
  const ancien = JSON.stringify({ local: { ok: true, path: '/mnt/x.pdf' } });
  const [local] = invoices.statesFor(ancien, ['local']);

  assert.equal(local.state, 'unknown');
  assert.equal(local.at, null);
  assert.match(local.tooltip, /état inconnu/);
  // Pas un échec pour autant : aucun bouton « Renvoyer » ne doit apparaître.
  assert.equal(invoices.hasFailure(ancien, ['local']), false);
});

test('une destination sans trace est « en attente », pas « copiée »', () => {
  const [proton] = invoices.statesFor('{}', ['proton']);
  assert.equal(proton.state, 'pending');
  assert.deepEqual(invoices.missingDestinations('{}', ['local', 'proton']), ['local', 'proton']);
});

test('une colonne illisible ne fait pas tomber l\'accueil', () => {
  assert.deepEqual(invoices.parseDestinations('ceci n\'est pas du JSON'), {});
  assert.equal(invoices.statesFor('{{{', ['local'])[0].state, 'pending');
});

test('un document copié sur le stockage local mais pas sur Proton est identifiable', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  registry.install(alix.id, 'free');

  // Le cloud est créé ÉTEINT : c'est l'état où l'utilisateur ne doit rien voir.
  const proton = helpers.creerCloud({
    provider: 'proton',
    displayName: 'Proton Drive',
    enabled: false,
    rcloneConfig: '',
  });

  const id = seedInvoice(alix.id, {
    filename: '2026-07_partiel.pdf',
    destinations: {
      local: { state: 'ok', ok: true, at: '2026-08-01T10:00:00.000Z' },
      [proton]: { state: 'error', ok: false, at: '2026-08-01T10:00:00.000Z', message: 'quota dépassé' },
    },
  });

  // Le cloud n'est pas activé : l'utilisateur ne voit que le stockage local, tout va bien.
  let accueil = await client.get('/api/home');
  let document = accueil.body.documents.find((d) => d.id === id);
  assert.deepEqual(document.destinations.map((d) => d.id), ['local']);
  assert.equal(document.hasError, false);

  // Activé : l'échec remonte immédiatement, il n'est pas noyé.
  destinations.saveConfig(proton, {
    enabled: true,
    remoteName: 'protondrive',
    basePath: 'crabe',
    rcloneConfig: 'type = protondrive\nusername = test',
  });
  accueil = await client.get('/api/home');
  document = accueil.body.documents.find((d) => d.id === id);

  assert.deepEqual(document.destinations.map((d) => `${d.id}:${d.state}`), [
    'local:ok',
    `${proton}:error`,
  ]);
  assert.equal(document.hasError, true, 'le document en échec doit être signalé');

  destinations.saveConfig(proton, { enabled: false, rcloneConfig: '' });
});

// ---------------------------------------------------------------------------
// Destinations : n'afficher que celles autorisées
// ---------------------------------------------------------------------------

test('une destination non activée n\'apparaît nulle part', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  const accueil = await client.get('/api/home');
  assert.deepEqual(accueil.body.destinations.map((d) => d.id), ['local']);

  // ⚠ « Masquée » ne veut plus dire la même chose depuis le lot 25. Le test
  // précédent a laissé un cloud créé mais éteint : c'est LUI, et lui seul, que
  // la note doit nommer. Jusqu'au lot 24 elle en nommait cinq — les cinq
  // fournisseurs que le code déclarait —, et disait donc à l'utilisateur que
  // son administrateur lui refusait des espaces que personne n'avait demandés.
  const eteints = accueil.body.hiddenDestinations.map((d) => d.name);
  assert.deepEqual(eteints, ['Proton Drive']);
  assert.equal(
    accueil.body.hiddenDestinationsNote,
    "Proton Drive n'est pas activé par l'administrateur."
  );

  // Aucune pastille grise pour une destination que l'admin n'a pas activée.
  for (const document of accueil.body.documents) {
    assert.deepEqual(document.destinations.map((d) => d.id), ['local']);
  }
});

test('tester une destination non activée est refusé, même en devinant son nom', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'bruno', 'MotDePasse1');

  const refuse = await client.post('/api/home/destinations/cloud-inconnu/test');
  assert.equal(refuse.status, 404);

  const inconnue = await client.post('/api/home/destinations/dropbox/test');
  assert.equal(inconnue.status, 404);

  const permise = await client.post('/api/home/destinations/local/test');
  assert.equal(permise.status, 200);
  assert.equal(typeof permise.body.ok, 'boolean');
});

test('l\'espace restant est mesuré, et « inconnu » plutôt que zéro s\'il ne l\'est pas', async () => {
  const space = require('../server/destinations/space');

  const reel = await space.localSpace(helpers.dataDir);
  assert.equal(reel.known, true);
  assert.ok(reel.totalBytes > 0);
  assert.ok(reel.freeBytes >= 0);

  const absent = await space.localSpace('/chemin/qui/n/existe/pas');
  assert.equal(absent.known, false);
  assert.equal(absent.freeBytes, null, 'jamais un zéro trompeur');
  assert.ok(absent.reason);

  const sansChemin = await space.localSpace('');
  assert.equal(sansChemin.known, false);
});

// ---------------------------------------------------------------------------
// Renvoi d'un document
// ---------------------------------------------------------------------------

test('« Renvoyer » recopie depuis le stockage local, sans repasser par le fournisseur', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  // Le PDF existe réellement sur le stockage local, à l'emplacement attendu.
  const racine = destinations.readConfig('local').path;
  const dossier = path.join(racine, 'alix', 'Free Internet', 'fbx1');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, '2026-06_renvoi.pdf'), 'PDF factice');

  const id = seedInvoice(alix.id, {
    filename: '2026-06_renvoi.pdf',
    destinations: { local: { state: 'ok', ok: true, at: '2026-08-01T10:00:00.000Z' } },
  });

  // Rien à faire : le stockage local est la seule destination activée et elle est à jour.
  const rien = await client.post(`/api/connectors/me/invoices/${id}/resend`);
  assert.equal(rien.status, 200);
  assert.deepEqual(rien.body.copied, []);
  assert.match(rien.body.message, /déjà présent/);

  // Une facture d'un autre compte reste introuvable.
  const vole = await client.post('/api/connectors/me/invoices/999999/resend');
  assert.equal(vole.status, 404);
});

test('un renvoi impossible le dit, au lieu de prétendre avoir réussi', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'alix', 'MotDePasse1');

  // Fichier absent du stockage, et une destination en échec à rattraper.
  const id = seedInvoice(alix.id, {
    filename: '2026-05_disparu.pdf',
    destinations: { local: { state: 'error', ok: false, at: null, message: 'écriture refusée' } },
  });

  const res = await client.post(`/api/connectors/me/invoices/${id}/resend`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Lancez une synchronisation/);
});

// ---------------------------------------------------------------------------
// Contenu des blocs
// ---------------------------------------------------------------------------

test('l\'accueil est borné au compte courant', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'bruno', 'MotDePasse1');

  seedInvoice(alix.id, { filename: '2026-04_alix.pdf' });
  const accueil = await client.get('/api/home');

  assert.equal(accueil.body.user.username, 'bruno');
  assert.equal(
    accueil.body.documents.some((d) => d.filename.includes('alix')),
    false,
    'aucun document d\'un autre compte'
  );
  assert.equal(accueil.body.stats.invoicesTotal, 0);
});

test('le bloc « Derniers documents » s\'arrête à dix', () => {
  for (let n = 0; n < 14; n++) {
    seedInvoice(bruno.id, { filename: `2025-${String(n + 1).padStart(2, '0')}_lot.pdf`, remoteId: `r${n}` });
  }
  const documents = home.recentDocuments({ id: bruno.id }, ['local']);
  assert.equal(documents.length, home.DOCUMENTS_LIMIT);
  assert.equal(documents.length, 10);
  // La période et la référence sont déduites même sans date d'émission propre.
  assert.match(documents[0].period, /^\d{4}-\d{2}$/);
  assert.ok(documents[0].reference);
});

test('le bloc « Erreurs » ne montre que le dernier état de chaque connecteur', () => {
  const database = helpers.db.get();
  const log = database.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message)
     VALUES (?, ?, ?, datetime('now'), ?, 'manual', ?)`
  );

  log.run('edf', bruno.id, '2026-08-01 10:00:00', 0, 'Identifiants refusés');
  let erreurs = home.recentErrors({ id: bruno.id });
  assert.equal(erreurs.length, 1);
  assert.equal(erreurs[0].connectorId, 'edf');

  // Une exécution réussie ensuite : l'erreur n'a plus lieu d'être affichée.
  log.run('edf', bruno.id, '2026-08-02 10:00:00', 1, '2 factures récupérées');
  erreurs = home.recentErrors({ id: bruno.id });
  assert.deepEqual(erreurs, []);
});

// ---------------------------------------------------------------------------
// Lot 7 — l'état d'un connecteur, et l'action qui le résout
//
// Jusqu'au lot 6, un connecteur en échec proposait « Synchroniser », quel que
// soit l'échec. Les trois pannes réelles ne se résolvent pourtant PAS en
// resynchronisant : jamais configuré, connexion expirée, identifiants refusés.
// Le bouton proposé ramenait à l'échec de départ, à chaque fois.
// ---------------------------------------------------------------------------

const health = require('../server/connectors/health');

/** Un connecteur tel que `registry.listForUser()` le renvoie. */
function connecteur(extra = {}) {
  return {
    id: 'free',
    name: 'Free Internet',
    installed: true,
    status: 'installed',
    lastError: null,
    configSummary: null,
    ...extra,
  };
}

test('jamais configuré : on propose de configurer, jamais de synchroniser', () => {
  const etat = health.evaluate(connecteur({ status: 'needs-config' }));

  assert.equal(etat.code, 'not-configured');
  assert.equal(etat.title, 'Non connecté');
  assert.match(etat.detail, /n'est pas encore configuré/);
  assert.equal(etat.action.label, 'Configurer');
  assert.equal(etat.canSync, false, 'il n\'y a rien à synchroniser');
  assert.equal(etat.canReconfigure, true);
  assert.equal(etat.connected, false);
});

test('connexion expirée : on propose de se reconnecter', () => {
  const etat = health.evaluate(
    connecteur({
      configSummary: { sessions: { session: { expired: true } }, discoveries: {} },
    })
  );

  assert.equal(etat.code, 'session-expired');
  assert.equal(etat.title, 'Connexion expirée');
  assert.match(etat.detail, /a expiré/);
  assert.equal(etat.action.label, 'Se reconnecter');
  assert.equal(etat.canSync, false, 'resynchroniser rejouerait une session morte');
});

test('identifiants refusés : se reconnecter, surtout pas réessayer', () => {
  for (const message of [
    'Identifiants refusés par le portail',
    'Mot de passe incorrect',
    'Authentification impossible (401)',
    'Session invalide',
  ]) {
    const etat = health.evaluate(connecteur({ status: 'error', lastError: message }));
    assert.equal(etat.code, 'error', message);
    assert.equal(etat.title, 'Connexion refusée', message);
    assert.equal(etat.action.label, 'Se reconnecter', message);
    assert.equal(etat.canSync, false, `« ${message} » : réessayer échouerait pareil`);
    assert.equal(etat.canReconfigure, true, message);
  }
});

test('incident passager : là, réessayer est bien la bonne réponse', () => {
  const etat = health.evaluate(
    connecteur({ status: 'error', lastError: 'Le portail n\'a pas répondu (délai dépassé)' })
  );

  assert.equal(etat.code, 'error');
  assert.equal(etat.title, 'Dernière récupération en échec');
  assert.equal(etat.action.id, 'sync');
  assert.equal(etat.canSync, true, 'un incident réseau se réessaie');
  // …et « Reconfigurer » reste accessible depuis la fiche, dans tous les cas.
  assert.equal(etat.canReconfigure, true);
});

test('connecteur en état de marche : récupérer maintenant, et le suivi affiché', () => {
  const etat = health.evaluate(
    connecteur({
      fields: [{
        key: 'lignes', type: 'multiselect', unit: 'ligne', unitFeminine: true,
        label: 'Lignes à récupérer',
      }],
      configSummary: {
        sessions: {},
        discoveries: { lignes: { selection: ['0628000000', '0749000000'], items: [] } },
      },
    })
  );

  assert.equal(etat.code, 'ready');
  assert.equal(etat.title, 'Connecté');
  assert.equal(etat.action.label, 'Récupérer maintenant');
  assert.equal(etat.canSync, true);
  assert.equal(etat.connected, true);
  // « 2 lignes suivies » — dans la langue du fournisseur, pas « 2 élément(s) ».
  assert.equal(etat.followedLabel, '2 lignes suivies');
});

test('un seul élément suivi : le singulier, parce qu\'on écrit du français', () => {
  const etat = health.evaluate(
    connecteur({
      fields: [{
        key: 'lignes', type: 'multiselect', unit: 'ligne', unitFeminine: true,
        label: 'Lignes à récupérer',
      }],
      configSummary: { sessions: {}, discoveries: { lignes: { selection: ['0628000000'] } } },
    })
  );
  assert.equal(etat.followedLabel, '1 ligne suivie');
});

test('connexion par navigateur : le geste porte le nom du fournisseur', () => {
  const parNavigateur = health.evaluate(
    connecteur({
      name: 'Free Mobile',
      status: 'needs-config',
      remoteLogin: { url: 'https://mobile.free.fr/account/v2/login' },
    })
  );
  assert.equal(parNavigateur.action.id, 'connect');
  assert.equal(parNavigateur.action.label, 'Se connecter à Free Mobile');

  // Un connecteur à mot de passe ouvre un formulaire, pas une fenêtre.
  assert.equal(health.evaluate(connecteur({ status: 'needs-config' })).action.id, 'configure');
});

test('l\'accueil signale un connecteur qui attend, même s\'il n\'a jamais tourné', () => {
  registry.install(bruno.id, 'edf');

  // Jamais configuré : aucune exécution, donc aucune ligne dans « Erreurs ».
  const erreurs = home.recentErrors({ id: bruno.id });
  assert.equal(erreurs.some((e) => e.connectorId === 'edf'), false);

  // Il apparaît pourtant, avec le geste qui le débloque.
  const attentes = home.pendingActions({ id: bruno.id });
  const edf = attentes.find((p) => p.connectorId === 'edf');
  assert.ok(edf, 'un connecteur jamais configuré doit être signalé quelque part');
  assert.equal(edf.health.code, 'not-configured');
  assert.equal(edf.health.canSync, false);
  assert.equal(edf.health.canReconfigure, true);

  registry.uninstall(bruno.id, 'edf');
});

test('le bloc « Synchronisation » ne propose la synchro que là où elle aboutirait', () => {
  registry.install(bruno.id, 'edf');
  helpers.db
    .get()
    .prepare("UPDATE connector_installs SET status = 'error', last_error = ? WHERE user_id = ? AND connector_id = 'edf'")
    .run('Identifiants refusés', bruno.id);

  const ligne = home.syncRows({ id: bruno.id }).find((r) => r.id === 'edf');
  assert.ok(ligne, 'un connecteur en erreur reste listé');
  assert.equal(ligne.health.canSync, false);
  assert.equal(ligne.health.action.label, 'Se reconnecter');

  registry.uninstall(bruno.id, 'edf');
});
