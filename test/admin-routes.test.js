'use strict';

/**
 * Contrôle de non-régression du lot 2, écran par écran.
 *
 * La réorganisation des menus (onglets, colonnes, nouveau menu SMTP) ne touche
 * pas au serveur, mais elle déplace les appels : ce fichier vérifie que chaque
 * écran d'administration obtient bien tout ce qu'il affiche, et que les
 * permissions n'ont pas glissé au passage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');

let admin;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'ecrans',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
  await helpers.createUser({ username: 'simple-usager', plainPassword: 'MotDePasse1' });

  // Une planification n'existe que pour une installation réelle (lot 3) :
  // sans installation, l'écran Automatisation n'a rien à décrire et la
  // comparaison de forme avec la fixture serait vide, donc muette.
  require('../server/connectors/registry').install(admin.id, 'free');
});

test.after(() => helpers.teardown());

async function adminClient(t) {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'ecrans', 'MotDePasse1');
  return client;
}

/**
 * Toutes les lectures dont dépendent les écrans de Paramètres, dans l'ordre du
 * menu. Une 200 ici signifie que l'écran a de quoi s'afficher.
 */
const ECRANS = [
  ['Accueil (tableau de bord)', '/api/home'],
  ['Utilisateurs → Comptes', '/api/users'],
  ['Utilisateurs → Demandes de suppression', '/api/users/deletion/requests'],
  ['Utilisateurs → Avatars', '/api/system/settings'],
  ['Applications (cartes et liste)', '/api/admin/connectors'],
  ['Applications → Logos', '/api/admin/connectors/logos'],
  // Les deux onglets Permissions se servent de la même réponse : rôles,
  // permissions et comptes arrivent ensemble.
  ['Permissions → rôles et matrice', '/api/admin/roles'],
  ['Automatisation', '/api/admin/schedules'],
  ['Stockage', '/api/admin/destinations'],
  ['Sécurité → Connexion', '/api/system/security'],
  ['Sécurité → Logs de connexion', '/api/admin/logs/connections?user=all&result=all&days=30'],
  ['SMTP → configuration et modèles', '/api/system/smtp'],
  ['SMTP → modèles seuls', '/api/system/email-templates'],
  ['Logs → Connecteurs', '/api/admin/logs/runs?connector=all&result=all&q='],
  ['Logs → Application', '/api/admin/logs/app?level=all&q='],
  ['Logs → Stockage', '/api/admin/logs/storage?dest=all&result=all'],
  ['Support', '/api/tickets?status=all'],
  ['Système', '/api/system'],
  ['Système → rclone', '/api/system/rclone'],
];

test('chaque écran de Paramètres obtient ses données', async (t) => {
  const client = await adminClient(t);

  for (const [ecran, url] of ECRANS) {
    const res = await client.get(url);
    assert.equal(res.status, 200, `${ecran} — ${url} a répondu ${res.status}`);
    assert.equal(typeof res.body, 'object', `${ecran} — réponse JSON attendue`);
  }
});

test('les données affichées par les écrans réorganisés sont complètes', async (t) => {
  const client = await adminClient(t);

  // Stockage : la bande de statistiques et les cartes de destination. Elles
  // sont six depuis le lot 24 — le stockage local, Proton Drive, pCloud, MEGA, kDrive et
  // le mode générique — et l'écran doit toutes les servir, activées ou non :
  // c'est là qu'on les configure.
  const stockage = await client.get('/api/admin/destinations');
  // Une seule destination sur une installation neuve : le stockage local. Le lot 25 a
  // retiré les cinq fournisseurs que le code déclarait d'office et que
  // personne n'avait demandés.
  assert.deepEqual(stockage.body.destinations.map((d) => d.id), ['local']);
  // Les quatre fournisseurs vedettes au minimum. Les types d'rclone les
  // suivent dans la MÊME liste depuis le lot 28, mais rclone n'est pas
  // forcément installé là où les tests tournent : le compte exact dépend du
  // binaire, ce qui est précisément la propriété qu'on veut (voir
  // `test/lot28-liste-unique.test.js`, qui mesure la fusion avec un faux
  // rclone dont on connaît la réponse).
  assert.ok(stockage.body.providers.length >= 4, 'le choix du bouton « Ajouter un cloud »');
  for (const champ of ['totalBytes', 'files', 'users', 'breakdown']) {
    assert.ok(champ in stockage.body.summary, `summary.${champ} manquant`);
  }

  // SMTP : configuration, modes de chiffrement, modèles avec leurs variables.
  const smtp = await client.get('/api/system/smtp');
  assert.ok(smtp.body.secureModes.length === 3);
  for (const modele of smtp.body.templates) {
    assert.ok(modele.label, 'libellé du modèle');
    assert.ok(modele.description, 'description du modèle');
    assert.ok(modele.variables.length, 'variables documentées');
    assert.ok(modele.defaults.subject, 'modèle par défaut disponible pour la réinitialisation');
  }

  // Système : les deux colonnes Logiciel et Infrastructure.
  const systeme = await client.get('/api/system');
  for (const champ of ['version', 'node', 'uptimeSeconds', 'schemaVersion', 'scheduler']) {
    assert.ok(champ in systeme.body, `colonne Logiciel : ${champ} manquant`);
  }
  for (const champ of ['dbSizeBytes', 'diskFreeBytes', 'dataDir']) {
    assert.ok(champ in systeme.body.runtime, `colonne Infrastructure : runtime.${champ} manquant`);
  }
  assert.ok('state' in systeme.body.local, 'état du montage du stockage local');
  assert.equal(typeof systeme.body.playwright.available, 'boolean');

  // Sécurité : l'onglet Connexion garde politique de mot de passe et 2FA.
  const securite = await client.get('/api/system/security');
  assert.ok(securite.body.passwordLevels.length);
  assert.ok(securite.body.twoFactorModes.length);

  // Automatisation : une ligne par couple (compte, connecteur) installé,
  // avec de quoi choisir précisément QUAND.
  const cron = await client.get('/api/admin/schedules');
  assert.equal(cron.body.schedules.length, 1, 'un seul connecteur est installé');
  const planif = cron.body.schedules[0];
  for (const champ of [
    'id', 'userId', 'username', 'connectorId', 'frequency', 'timeOfDay',
    'dayOfWeek', 'dayOfMonth', 'lastDayOfMonth', 'enabled', 'nextRunAt', 'rhythm',
  ]) {
    assert.ok(champ in planif, `planification : ${champ} manquant`);
  }
  // Six rythmes depuis le lot 14 : quotidien, hebdomadaire, mensuel, tous les
  // 3 mois, tous les 6 mois, et « désactivée » — qui suspend sans désinstaller.
  assert.equal(cron.body.frequencies.length, 6);
  assert.deepEqual(
    cron.body.frequencies.map((f) => f.id),
    ['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'disabled']
  );
  assert.equal(cron.body.weekdays.length, 7);

  // Accueil : les six blocs et leur contenu, en un seul appel.
  const accueil = await client.get('/api/home');
  assert.equal(accueil.body.widgets.length, 6);
  for (const champ of [
    'user', 'today', 'connectors', 'stats', 'sync', 'errors',
    'documents', 'destinations', 'hiddenDestinations',
  ]) {
    assert.ok(champ in accueil.body, `accueil : ${champ} manquant`);
  }
  // Le stockage local, et rien d'autre : depuis le lot 25 une installation neuve n'a
  // aucun cloud, donc aucune destination « masquée » à signaler. La note
  // d'avant nommait cinq fournisseurs que personne n'avait ajoutés, ce qui
  // revenait à reprocher à l'administrateur un choix qui n'existait pas.
  assert.deepEqual(accueil.body.destinations.map((d) => d.id), ['local']);
  assert.deepEqual(
    accueil.body.hiddenDestinations.map((d) => d.id),
    []
  );
  // Rien à signaler ⇒ pas de note du tout. Une phrase vide affichée sous les
  // cartes serait un bruit permanent sur l'accueil de qui n'a que le stockage local.
  assert.equal(accueil.body.hiddenDestinationsNote, null);
});

test('les fixtures du test de rendu ont la forme des vraies réponses', async (t) => {
  // Sans cette vérification, `test/render.test.js` pourrait valider des écrans
  // nourris de données qui n'existent pas — et casser en production.
  const { FIXTURES } = require('./fixtures-front');
  const client = await adminClient(t);

  /** Compare récursivement les CLÉS (pas les valeurs) de deux objets. */
  function champsManquants(attendu, reel, chemin = '') {
    if (attendu === null || typeof attendu !== 'object') return [];
    if (Array.isArray(attendu)) {
      if (!Array.isArray(reel)) return [`${chemin} devrait être un tableau`];
      // Un seul élément suffit à décrire la forme des lignes.
      return attendu.length && reel.length ? champsManquants(attendu[0], reel[0], `${chemin}[]`) : [];
    }

    const erreurs = [];
    for (const [cle, valeur] of Object.entries(attendu)) {
      const sousChemin = chemin ? `${chemin}.${cle}` : cle;
      if (!(cle in (reel || {}))) {
        erreurs.push(sousChemin);
        continue;
      }
      // Champ légitimement nul (aucune exécution encore, aucun port réglé…) :
      // sa présence suffit, il n'y a pas de sous-champ à comparer.
      if (reel[cle] === null) continue;
      erreurs.push(...champsManquants(valeur, reel[cle], sousChemin));
    }
    return erreurs;
  }

  const aVerifier = [
    ['/api/system', '/system'],
    ['/api/system/smtp', '/system/smtp'],
    ['/api/system/settings', '/system/settings'],
    ['/api/system/security', '/system/security'],
    ['/api/admin/destinations', '/admin/destinations'],
    ['/api/admin/schedules', '/admin/schedules'],
    ['/api/home', '/home'],
    ['/api/tickets?status=all', '/tickets'],
  ];
  // `/api/connectors` n'est pas comparé ici : cette boucle ne regarde que le
  // PREMIER élément d'un tableau, et l'ordre du catalogue vient du disque. La
  // fixture du connecteur à session et à découverte est confrontée à la
  // réponse réelle, entrée par entrée, dans test/session-discovery.test.js.

  for (const [url, cle] of aVerifier) {
    const res = await client.get(url);
    assert.equal(res.status, 200, url);
    assert.deepEqual(
      champsManquants(FIXTURES[cle], res.body),
      [],
      `fixture ${cle} : champs absents de la réponse réelle de ${url}`
    );
  }
});

test('un compte sans droits d\'administration ne voit aucun de ces écrans', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'simple-usager', 'MotDePasse1');

  // Deux routes sont volontairement lisibles par tous : /system/settings, dont
  // le front a besoin pour formater les dates, et /home, qui est l'accueil de
  // l'utilisateur lui-même — borné à son propre compte. Tout le reste est refusé.
  const publiques = new Set(['/api/system/settings', '/api/home']);

  for (const [ecran, url] of ECRANS) {
    if (publiques.has(url)) continue;
    const res = await client.get(url);
    assert.ok(
      res.status === 403 || res.status === 401,
      `${ecran} — ${url} devrait être refusé, a répondu ${res.status}`
    );
  }
});

test('l\'administrateur retire la personnalisation de l\'accueil d\'un compte', async (t) => {
  const client = await adminClient(t);
  const cible = helpers.db
    .get()
    .prepare('SELECT id FROM users WHERE username = ?')
    .get('simple-usager');

  const avant = await client.get('/api/users');
  assert.equal(avant.body.users.find((u) => u.id === cible.id).home.adminAllowed, true);

  const refus = await client.patch(`/api/users/${cible.id}`, { homeCustomizable: false });
  assert.equal(refus.status, 200);
  assert.equal(refus.body.user.home.adminAllowed, false);
  assert.equal(refus.body.user.home.canCustomize, false);

  // Le compte concerné se voit refuser toute modification, côté serveur.
  const usager = await helpers.startServer();
  t.after(() => usager.close());
  await helpers.login(usager, 'simple-usager', 'MotDePasse1');
  assert.equal((await usager.put('/api/home/widgets', { widgets: [] })).status, 403);

  // L'administrateur peut rendre la main.
  const rendu = await client.patch(`/api/users/${cible.id}`, { homeCustomizable: true });
  assert.equal(rendu.body.user.home.canCustomize, true);
  assert.equal((await usager.put('/api/home/widgets', { widgets: [] })).status, 200);
});

test('« appliquer cette disposition à tous » passe par une route protégée', async (t) => {
  const client = await adminClient(t);

  await client.put('/api/home/widgets', {
    widgets: [{ id: 'destinations', enabled: true, span: 4 }],
  });
  const applique = await client.post('/api/users/home-layout/apply-to-all');
  assert.equal(applique.status, 200);
  assert.ok(applique.body.applied >= 1);

  const usager = await helpers.startServer();
  t.after(() => usager.close());
  await helpers.login(usager, 'simple-usager', 'MotDePasse1');
  const chezLui = await usager.get('/api/home/widgets');
  assert.equal(chezLui.body.widgets[0].id, 'destinations');
  assert.equal(chezLui.body.widgets[0].span, 4);

  // Un compte sans « Gérer les utilisateurs » ne peut pas imposer sa mise en page.
  assert.equal((await usager.post('/api/users/home-layout/apply-to-all')).status, 403);
});

test('« active » distingue l\'installée du simplement livré avec crabe', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  const catalogue = await client.get('/api/admin/connectors');
  const parId = Object.fromEntries(catalogue.body.connectors.map((c) => [c.id, c]));

  // « free » est installé par le compte administrateur (voir test.before).
  assert.equal(parId.free.installCount >= 1, true);
  assert.equal(parId.free.active, true, 'une application installée est active');

  // Les autres sont livrées « disponibles » avec crabe, sans qu'aucun
  // administrateur ne l'ait décidé : elles ne sont pas actives.
  const jamaisTouche = catalogue.body.connectors.find((c) => c.id !== 'free' && !c.installCount);
  assert.equal(jamaisTouche.publishedAt, null);
  assert.equal(jamaisTouche.active, false, 'livrée par défaut ≠ mise à disposition');

  // L'approbation explicite d'un administrateur, elle, la rend active.
  const approuve = await client.post(`/api/admin/connectors/${jamaisTouche.id}/approve`);
  assert.equal(approuve.status, 200);
  const relu = await client.get('/api/admin/connectors');
  const apres = relu.body.connectors.find((c) => c.id === jamaisTouche.id);
  assert.ok(apres.publishedAt, 'la date de mise à disposition est enregistrée');
  assert.equal(apres.active, true);
  assert.equal(relu.body.activeCount >= 2, true);

  // Retirer du Store annule cette mise à disposition.
  await client.post(`/api/admin/connectors/${jamaisTouche.id}/reject`);
  const final = await client.get('/api/admin/connectors');
  const retire = final.body.connectors.find((c) => c.id === jamaisTouche.id);
  assert.equal(retire.publishedAt, null);
  assert.equal(retire.active, false);

  // Le filtre lui-même est mémorisé sur le compte, pas dans le navigateur.
  const defaut = await client.get('/api/users/me/preferences');
  assert.equal(defaut.body.preferences['apps.hideInactive'], false);

  const pose = await client.put('/api/users/me/preferences', {
    preferences: { 'apps.hideInactive': true },
  });
  assert.equal(pose.status, 200);
  assert.equal(pose.body.preferences['apps.hideInactive'], true);
  assert.equal((await client.get('/api/users/me/preferences')).body.preferences['apps.hideInactive'], true);
  assert.equal(preferences.get(admin.id, 'apps.hideInactive'), true);

  // Une clé inconnue est refusée : la table n'est pas une décharge.
  const inconnue = await client.put('/api/users/me/preferences', {
    preferences: { 'nimporte.quoi': 1 },
  });
  assert.equal(inconnue.status, 400);
});

/**
 * Synchronisation forcée vers les destinations secondaires (lot 10, §4.4).
 *
 * Deux portées, et elles ne se confondent pas : l'accueil ne traite que les
 * documents de celui qui clique, l'administration rattrape l'installation
 * entière. La seconde demande donc la permission de gérer le stockage.
 */
test('le forçage de synchronisation est monté, et fermé au bon endroit', async (t) => {
  const client = await adminClient(t);

  // Aucune destination secondaire activée sur cette installation : le refus
  // dit quoi faire, plutôt que de lancer un transfert vide.
  const global = await client.post('/api/admin/destinations/sync');
  assert.equal(global.status, 400);
  assert.match(global.body.error, /Aucune destination secondaire/);
  assert.match(global.body.error, /Paramètres → Stockage/);

  // Un cloud qui existe mais n'est pas activé : même refus, même phrase.
  const eteint = helpers.creerCloud({
    provider: 'pcloud', displayName: 'pCloud', enabled: false, rcloneConfig: '',
  });
  const parDestination = await client.post(`/api/admin/destinations/${eteint}/sync`);
  assert.equal(parDestination.status, 400);

  const inconnue = await client.post('/api/admin/destinations/nimporte/sync');
  assert.equal(inconnue.status, 404);

  // L'avancement est lisible, et au repos entre deux lancements.
  const etat = await client.get('/api/admin/destinations/sync/state');
  assert.equal(etat.status, 200);
  assert.equal(etat.body.running, false);
  for (const champ of ['total', 'done', 'copied', 'failed', 'errors', 'message']) {
    assert.ok(champ in etat.body, `avancement : ${champ} manquant`);
  }

  // Depuis l'accueil, la même chose, bornée au compte connecté.
  const depuisAccueil = await client.post('/api/home/destinations/sync', {});
  assert.equal(depuisAccueil.status, 400);
  const suivi = await client.get('/api/home/destinations/sync');
  assert.equal(suivi.status, 200);
  assert.equal(suivi.body.running, false);

  // Une destination inconnue depuis l'accueil ne révèle rien.
  const devinee = await client.post('/api/home/destinations/sync', { destinationId: 'proton' });
  assert.equal(devinee.status, 404);
});

test('un compte sans droit sur le stockage ne force aucune synchronisation', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'simple-usager', 'MotDePasse1');

  assert.equal((await client.post('/api/admin/destinations/sync')).status, 403);
  assert.equal((await client.get('/api/admin/destinations/sync/state')).status, 403);

  // Son propre accueil, en revanche, lui appartient : le refus qu'il obtient
  // est celui de la configuration, pas celui des droits.
  assert.equal((await client.post('/api/home/destinations/sync', {})).status, 400);
});

// ---------------------------------------------------------------------------
// Lot 18 — la liste des tailles de page est défendue par le SERVEUR
//
// Un menu déroulant ne protège de rien : il propose, il n'interdit pas. Ce qui
// tient la liste fermée, c'est la route — sans quoi une page de 0 ligne
// n'afficherait rien, et une page de 10 000 ne serait plus une page.
//
// Lot 20 : `home.pageSize` est devenu DEUX clés, une par bloc de l'accueil
// (`home.sync.pageSize`, `home.documents.pageSize`). La règle, elle, n'a pas
// bougé — et elle s'applique aux deux.
// ---------------------------------------------------------------------------

test('Accueil : les six tailles de page passent, et les autres sont refusées', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  // Le défaut ne change pas : un compte déjà réglé ne doit pas être surpris.
  const defaut = await client.get('/api/users/me/preferences');
  assert.equal(defaut.body.preferences['home.sync.pageSize'], 10);

  // Les six valeurs proposées sont acceptées, et relues telles quelles.
  for (const taille of [10, 15, 20, 25, 30, 50]) {
    const pose = await client.put('/api/users/me/preferences', {
      preferences: { 'home.sync.pageSize': taille },
    });
    assert.equal(pose.status, 200, `${taille} lignes doit être accepté`);
    assert.equal(pose.body.preferences['home.sync.pageSize'], taille);
    assert.equal(preferences.get(admin.id, 'home.sync.pageSize'), taille);
  }

  // Tout le reste est REFUSÉ, et jamais rangé en douce sur autre chose : 5 est
  // l'ancienne valeur du lot 17, 7 un nombre plausible, 0 et 10 000 les deux
  // bornes qu'un champ libre laisserait passer.
  for (const mauvaise of [5, 7, 0, -1, 10_000, 'douze', null]) {
    const refus = await client.put('/api/users/me/preferences', {
      preferences: { 'home.sync.pageSize': mauvaise },
    });
    assert.equal(refus.status, 400, `« ${mauvaise} » doit être refusé`);
    // Le message dit ce qui est possible, sans renvoyer chercher la liste
    // ailleurs — l'utilisateur n'a pas à deviner ce qu'on attend de lui.
    assert.match(refus.body.error, /10, 15, 20, 25, 30 ou 50/);
  }

  // Et le refus n'a rien écrasé : la dernière valeur valable tient toujours.
  assert.equal(preferences.get(admin.id, 'home.sync.pageSize'), 50);
});

test('Accueil : un envoi dont une valeur est refusée n\'écrit rien du tout', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  // On part d'un état connu : un test précédent de ce fichier a déjà posé
  // « apps.hideInactive », et la base est partagée par tout le fichier.
  await client.put('/api/users/me/preferences', {
    preferences: { 'home.sync.pageSize': 20, 'apps.hideInactive': false },
  });
  assert.equal(preferences.get(admin.id, 'apps.hideInactive'), false);

  // Deux réglages, le second impossible. Écrire le premier quand même
  // laisserait une moitié de geste appliquée, sans que personne sache laquelle.
  const melange = await client.put('/api/users/me/preferences', {
    preferences: { 'apps.hideInactive': true, 'home.sync.pageSize': 33 },
  });
  assert.equal(melange.status, 400);
  assert.equal(preferences.get(admin.id, 'apps.hideInactive'), false, 'le premier non plus');
  assert.equal(preferences.get(admin.id, 'home.sync.pageSize'), 20, 'et l\'ancienne taille tient');
});

test('Accueil : les deux blocs se règlent séparément, côté serveur aussi', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  await client.put('/api/users/me/preferences', {
    preferences: { 'home.sync.pageSize': 15, 'home.documents.pageSize': 30 },
  });
  assert.equal(preferences.get(admin.id, 'home.sync.pageSize'), 15);
  assert.equal(preferences.get(admin.id, 'home.documents.pageSize'), 30);

  // Régler l'un ne touche pas l'autre — c'est tout l'objet de la séparation.
  await client.put('/api/users/me/preferences', {
    preferences: { 'home.sync.pageSize': 50 },
  });
  assert.equal(preferences.get(admin.id, 'home.sync.pageSize'), 50);
  assert.equal(preferences.get(admin.id, 'home.documents.pageSize'), 30, 'l\'autre bloc tient');

  // Et la clé partagée du lot 18 n'existe plus : la laisser vivre poserait une
  // seconde vérité que plus rien ne lit.
  const refus = await client.put('/api/users/me/preferences', {
    preferences: { 'home.pageSize': 20 },
  });
  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /Préférence inconnue/);
});

test('Accueil : la forme d\'un graphique hors liste est refusée, en toutes lettres', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  for (const [graphique, forme] of [['mois', 'courbe'], ['connecteurs', 'anneau']]) {
    const pose = await client.put('/api/users/me/preferences', {
      preferences: { [`home.stats.type.${graphique}`]: forme },
    });
    assert.equal(pose.status, 200, `${graphique} en ${forme} doit être accepté`);
    assert.equal(preferences.get(admin.id, `home.stats.type.${graphique}`), forme);
  }

  // Une forme qui n'existe pas pour CE graphique : l'anneau va bien à une
  // répartition, il ne veut rien dire sur douze mois.
  const croise = await client.put('/api/users/me/preferences', {
    preferences: { 'home.stats.type.mois': 'anneau' },
  });
  assert.equal(croise.status, 400);
  assert.match(croise.body.error, /Barres ou Courbe/);
  assert.equal(
    preferences.get(admin.id, 'home.stats.type.mois'),
    'courbe',
    'et le refus n\'a rien écrasé'
  );

  // Un graphique qui n'a pas de forme au choix n'a pas de réglage non plus :
  // accepter la clé laisserait croire qu'elle décide de quelque chose.
  const sansChoix = await client.put('/api/users/me/preferences', {
    preferences: { 'home.stats.type.stockage': 'barres' },
  });
  assert.equal(sansChoix.status, 400);
});

test('Accueil : le choix des graphiques est mémorisé sur le compte', async (t) => {
  const client = await adminClient(t);
  const preferences = require('../server/preferences');

  // Les deux par défaut : un réglage neuf ne retire rien à qui n'a rien demandé.
  const defaut = await client.get('/api/users/me/preferences');
  assert.deepEqual(defaut.body.preferences['home.stats.charts'], ['mois', 'connecteurs']);

  // Les quatre combinaisons sont enregistrables, la liste vide comprise : ne
  // vouloir aucun graphique est un choix, pas une valeur abîmée.
  for (const choix of [['mois'], ['connecteurs'], [], ['mois', 'connecteurs']]) {
    const pose = await client.put('/api/users/me/preferences', {
      preferences: { 'home.stats.charts': choix },
    });
    assert.equal(pose.status, 200);
    assert.deepEqual(pose.body.preferences['home.stats.charts'], choix);
  }

  // L'ordre vient du catalogue, pas de ce que le navigateur envoie : cocher les
  // deux cases dans un sens ou dans l'autre doit donner le même accueil.
  const inverse = await client.put('/api/users/me/preferences', {
    preferences: { 'home.stats.charts': ['connecteurs', 'mois'] },
  });
  assert.deepEqual(inverse.body.preferences['home.stats.charts'], ['mois', 'connecteurs']);

  // Un identifiant inconnu disparaît sans faire échouer le reste — un onglet
  // resté ouvert pendant une mise à jour ne doit pas se bloquer à chaque clic.
  const bricole = await client.put('/api/users/me/preferences', {
    preferences: { 'home.stats.charts': ['mois', 'camembert-3d'] },
  });
  assert.equal(bricole.status, 200);
  assert.deepEqual(preferences.get(admin.id, 'home.stats.charts'), ['mois']);
});
