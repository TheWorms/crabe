'use strict';

/**
 * Lot 11 — les services ANNONCÉS.
 *
 * Un service annoncé est un manifeste sans `connector.js`, rangé sous
 * `server/connectors/planned/`. Il existe pour dire honnêtement où va le
 * projet : il s'affiche dans le Store avec son logo et sa catégorie, et **rien
 * d'autre ne doit le voir**.
 *
 * Ce fichier tient les cinq promesses du lot, et surtout la dernière, qui est
 * le vrai risque : le lot touche au registre, et les quatre connecteurs
 * réellement fonctionnels doivent en sortir intacts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');

/** Les quatre connecteurs dont le parcours a été validé contre un compte réel. */
const FONCTIONNELS = ['free', 'free-mobile', 'amazon', 'impots'];

let admin;
let client;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({ username: 'lot11', role: 'admin' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot11', 'MotDePasse1');
});

test.after(async () => {
  await client.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. Chargement
// ---------------------------------------------------------------------------

test('les manifestes annoncés se chargent, sans connector.js et sans erreur', () => {
  const result = registry.load();

  assert.equal(result.errors.length, 0, result.errors.join(' / '));
  // Le nombre exact bouge à chaque lot — un service annoncé devient disponible,
  // un autre est retiré du catalogue à la demande (cinq au lot 16, sept au lot
  // 20). Ce seuil ne garde donc qu'une chose, mais il la garde bien : que le
  // dossier planned/ est lu. Le jour où il ne l'est plus, ce n'est pas 49 qu'on
  // obtient, c'est 0 — et c'est pour ÇA que le seuil existe, pas pour figer un
  // inventaire qui a vocation à fondre lot après lot.
  // 33 annonces depuis le lot 47 : sept enseignes (Decathlon, Darty, Boulanger,
  // LDLC, Electro Dépôt, Bricomarché, VistaPrint) sont devenues des ébauches
  // sous available/. Le seuil fond avec l'inventaire, comme annoncé ci-dessus.
  assert.ok(result.planned >= 30, `attendu au moins 30 annonces, obtenu ${result.planned}`);
  assert.equal(result.loaded, registry.size);

  for (const annonce of registry.listPlanned()) {
    assert.equal(annonce.planned, true, `${annonce.id} : devrait être annoncé`);
    assert.equal(registry.isPlanned(annonce.id), true);
    assert.equal(registry.get(annonce.id).module, null, `${annonce.id} : ne charge aucun module`);
    assert.ok(annonce.description, `${annonce.id} : description manquante`);
    assert.ok(schema.CATEGORIES[annonce.category], `${annonce.id} : catégorie inconnue`);
  }
});

test('la pastille de repli est déduite quand le manifeste se tait', () => {
  // Déduite, mais STABLE : un même service garde sa couleur d'un démarrage à
  // l'autre. Un tirage au hasard ferait changer la grille à chaque redémarrage.
  assert.equal(schema.couleurParDefaut('spotify'), schema.couleurParDefaut('spotify'));
  assert.ok(schema.COULEURS_PASTILLE.includes(schema.couleurParDefaut('spotify')));

  assert.equal(schema.lettresParDefaut('Le Petit Vapoteur'), 'PV', 'les articles sautent');
  assert.equal(schema.lettresParDefaut('L\'Île aux Épices'), 'IE', 'accents et apostrophes aussi');
  assert.equal(schema.lettresParDefaut('TotalEnergies'), 'TE', 'la bosse interne compte');
  assert.equal(schema.lettresParDefaut('FDJ'), 'FDJ', 'un sigle court reste entier');
  assert.equal(schema.lettresParDefaut('Spotify'), 'SP');

  // Ce que le manifeste déclare garde le dernier mot : les quatorze connecteurs
  // d'origine ne bougent pas d'un pixel.
  assert.equal(registry.manifest('free').letters, 'F');
  assert.equal(registry.manifest('free').color, '#c8102e');
});

test('un connector.js dans planned/ est signalé plutôt qu\'ignoré en silence', () => {
  const { available, planned, nettoyer } = dossiersTemporaires();
  try {
    ecrireManifeste(planned, 'zombie', manifesteAnnonce());
    fs.writeFileSync(
      path.join(planned, 'zombie', 'connector.js'),
      'module.exports = { test: async () => ({ ok: true }), fetchInvoices: async () => [] };'
    );

    const result = registry.load(available, planned);
    assert.equal(result.planned, 1, 'le service est bien annoncé…');
    assert.match(
      result.errors.join(' '),
      /connector\.js est présent dans planned/,
      '…mais on le dit'
    );
  } finally {
    // Le vrai registre est remis en place quoi qu'il arrive : sans ce `finally`,
    // un échec ici laisserait les tests suivants tourner sur trois connecteurs
    // fictifs, et leurs messages parleraient d'autre chose que du défaut réel.
    nettoyer();
    registry.load();
  }
});

// ---------------------------------------------------------------------------
// 2. Refus d'installation — côté SERVEUR, pas seulement dans l'interface
// ---------------------------------------------------------------------------

test('installer un service annoncé est refusé par le registre', () => {
  const annonce = registry.listPlanned()[0];

  assert.throws(
    () => registry.install(admin.id, annonce.id),
    (err) => err.statusCode === 409 && /annoncé/.test(err.message),
    'le refus vient du registre, pas de l\'interface'
  );
  assert.equal(registry.getInstall(admin.id, annonce.id), undefined, 'aucune ligne créée');
});

test('configurer, tester, explorer ou exécuter un service annoncé est refusé', async () => {
  const annonce = registry.listPlanned()[0];

  assert.throws(() => registry.saveConfig(admin.id, annonce.id, {}), /annoncé/);
  assert.throws(() => registry.assertInstallable(annonce.id), /annoncé/);
  await assert.rejects(() => registry.discoverForUser(admin.id, annonce.id), /annoncé/);
  await assert.rejects(() => registry.fetchInvoicesDetailed(annonce.id, {}), /annoncé/);

  // `test()` ne lève jamais : il rend un échec décrit. La raison doit rester
  // lisible plutôt que de parler d'un module absent.
  const essai = await registry.test(annonce.id, {});
  assert.equal(essai.ok, false);
  assert.match(essai.message, /annoncé/);
});

test('l\'API refuse l\'installation d\'un service annoncé, même appelée directement', async () => {
  const annonce = registry.listPlanned()[0];

  // Le badge grisé du Store n'arrête ni un deuxième onglet, ni un appel direct.
  for (const [methode, chemin] of [
    ['post', `/api/connectors/${annonce.id}/install`],
    ['post', `/api/connectors/${annonce.id}/test`],
    ['post', `/api/connectors/${annonce.id}/run`],
    ['post', `/api/connectors/${annonce.id}/discover`],
  ]) {
    const res = await client[methode](chemin, {});
    assert.equal(res.status, 409, `${chemin} devrait être refusé`);
    assert.match(res.body.error, /annoncé/);
  }

  const config = await client.put(`/api/connectors/${annonce.id}/config`, { config: {} });
  assert.equal(config.status, 409);

  assert.equal(
    helpers.db
      .get()
      .prepare('SELECT COUNT(*) AS n FROM connector_installs WHERE connector_id = ?')
      .get(annonce.id).n,
    0,
    'aucune installation n\'a été créée en chemin'
  );
});

test('la fiche d\'un service annoncé reste consultable — c\'est tout l\'objet du lot', async () => {
  const annonce = registry.listPlanned()[0];
  const res = await client.get(`/api/connectors/${annonce.id}`);

  assert.equal(res.status, 200, 'regarder est normal, agir ne l\'est pas');
  assert.equal(res.body.connector.planned, true);
  assert.equal(res.body.connector.installed, false);
});

// ---------------------------------------------------------------------------
// 3. Nulle part ailleurs que dans le Store et le catalogue d'administration
// ---------------------------------------------------------------------------

test('un service annoncé n\'apparaît ni dans les installés, ni dans les statistiques', async () => {
  const annonces = new Set(registry.listPlanned().map((c) => c.id));
  assert.ok(annonces.size >= 30); // 33 depuis le lot 47, voir le test de chargement

  // Les installés : impossibles par construction, `installed` est toujours faux.
  assert.equal(
    registry.listForUser(admin).filter((c) => c.planned && c.installed).length,
    0
  );

  // Les statistiques d'administration comptent les connecteurs DISPONIBLES.
  // Y verser soixante annonces annoncerait quatre-vingts services opérationnels.
  const info = await client.get('/api/system');
  assert.equal(info.body.stats.connectorsAvailable, registry.size);
  assert.equal(registry.size, registry.listAvailable().length);
  for (const id of annonces) assert.equal(registry.listAvailable().some((c) => c.id === id), false);

  // L'accueil : ses blocs partent tous des connecteurs installés.
  const home = await client.get('/api/home');
  assert.equal(home.status, 200);
  const bloc = home.body.connectors || [];
  assert.equal(bloc.filter((c) => annonces.has(c.id)).length, 0);
});

test('un service annoncé n\'a pas d\'écran de permissions', async () => {
  const annonce = registry.listPlanned()[0];
  const res = await client.get(`/api/connectors/${annonce.id}/permissions`);
  assert.equal(res.status, 409, 'rien n\'est manipulé, il n\'y a rien à autoriser');
});

test('aucune planification ne peut viser un service annoncé', async () => {
  const annonce = registry.listPlanned()[0];
  const res = await client.put(`/api/admin/schedules/${admin.id}/${annonce.id}`, {
    frequency: 'daily',
  });
  // Aucune installation possible → aucune planification à enregistrer.
  assert.ok(res.status >= 400, `attendu un refus, obtenu ${res.status}`);
  assert.equal(
    helpers.db
      .get()
      .prepare('SELECT COUNT(*) AS n FROM user_connector_schedules WHERE connector_id = ?')
      .get(annonce.id).n,
    0
  );
});

test('le catalogue d\'administration, lui, les montre — et les compte à part', async () => {
  const res = await client.get('/api/admin/connectors');

  assert.equal(res.status, 200);
  assert.equal(res.body.plannedCount, registry.listPlanned().length);
  assert.ok(res.body.plannedCount >= 30); // 33 depuis le lot 47, voir le test de chargement

  const annonce = res.body.connectors.find((c) => c.planned);
  assert.ok(annonce, 'les annonces figurent au catalogue d\'administration');
  assert.equal(annonce.installCount, 0);

  // Les catégories servies à l'écran sont celles du serveur, au complet.
  assert.equal(res.body.categories.length, Object.keys(schema.CATEGORIES).length);
});

// ---------------------------------------------------------------------------
// 4. Le comptage annoncé par le Store
// ---------------------------------------------------------------------------

test('le Store annonce le compte EXACT, sur le périmètre du compte courant', async () => {
  const res = await client.get('/api/connectors');

  const attente = res.body.connectors.filter((c) => !c.planned && c.catalogStatus === 'pending');
  const disponibles = res.body.connectors.filter(
    (c) => !c.planned && c.catalogStatus !== 'pending'
  ).length;
  const annonces = res.body.connectors.filter((c) => c.planned).length;

  assert.equal(res.body.counts.available, disponibles);
  assert.equal(res.body.counts.pending, attente.length);
  assert.equal(res.body.counts.planned, annonces);
  assert.equal(
    res.body.counts.available + res.body.counts.pending + res.body.counts.planned,
    res.body.connectors.length
  );
  assert.equal(res.body.counts.planned, registry.listPlanned().length);

  // ⚠ Lot 20 : un connecteur EN ATTENTE DE TEST est désormais visible de
  // l'administrateur — sans quoi il ne pourrait jamais être testé, et resterait
  // en attente pour toujours (c'est arrivé à `vinted` depuis le lot 3). Mais il
  // est compté À PART : le fondre dans les « disponibles » annoncerait un
  // catalogue plus large qu'il ne l'est, c'est-à-dire exactement le mensonge
  // que le mécanisme existe pour éviter.
  assert.ok(
    attente.some((c) => c.id === 'vinted'),
    'l\'administrateur voit les services en attente de test'
  );
  assert.equal(
    res.body.counts.available,
    disponibles,
    'et ils ne gonflent pas le nombre de services annoncés disponibles'
  );
});

test('un compte ordinaire, lui, ne voit aucun service en attente de test', async () => {
  // La promesse qui compte : un service écrit mais jamais exercé contre un
  // compte réel n'est proposé à personne d'autre que celui qui va l'essayer.
  const ordinaire = await helpers.createUser({ username: 'lot20-ordinaire' });
  const vus = registry.listForUser(ordinaire);
  assert.equal(vus.some((c) => c.catalogStatus === 'pending'), false);
});

test('un service réservé à quelqu\'un d\'autre ne gonfle pas le compte affiché', async () => {
  const autre = await helpers.createUser({ username: 'lot11-bis' });
  const annonce = registry.listPlanned()[0];

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET allowed_users = ? WHERE connector_id = ?')
    .run(JSON.stringify([autre.id]), annonce.id);

  const vu = registry.listForUser(await helpers.createUser({ username: 'lot11-ter' }));
  assert.equal(vu.some((c) => c.id === annonce.id), false);

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET allowed_users = \'"all"\' WHERE connector_id = ?')
    .run(annonce.id);
});

// ---------------------------------------------------------------------------
// 5. La bascule annoncé → disponible : DÉPLACER LE DOSSIER, et rien d'autre
// ---------------------------------------------------------------------------

test('déplacer un dossier de planned/ vers available/ suffit à rendre le service disponible', () => {
  const { available, planned, nettoyer } = dossiersTemporaires();
  try {
  // Un manifeste COMPLET — champs, permissions, et un `status` qui dit encore
  // « planned ». C'est exactement le fichier qu'on déplacera : le test tient
  // seulement s'il n'est pas retouché entre les deux chargements.
  const manifeste = manifesteComplet();
  ecrireManifeste(planned, 'bascule', manifeste);

  const avant = registry.load(available, planned);
  assert.equal(avant.errors.length, 0, avant.errors.join(' / '));
  assert.equal(avant.planned, 1);
  assert.equal(registry.isPlanned('bascule'), true);
  assert.throws(() => registry.assertInstallable('bascule'), /annoncé/);

  // Le déplacement, tel qu'on le ferait à la main. Le connector.js est ce qui
  // manquait — c'est le code, pas une ligne de configuration.
  fs.renameSync(path.join(planned, 'bascule'), path.join(available, 'bascule'));
  fs.writeFileSync(
    path.join(available, 'bascule', 'connector.js'),
    'module.exports = { test: async () => ({ ok: true }), fetchInvoices: async () => [] };'
  );

  const apres = registry.load(available, planned);
  assert.equal(apres.errors.length, 0, apres.errors.join(' / '));
  assert.equal(apres.loaded, 1);
  assert.equal(apres.planned, 0);
  assert.equal(registry.isPlanned('bascule'), false);
  assert.doesNotThrow(() => registry.assertInstallable('bascule'));

  // Le fichier n'a pas été touché : son `status` dit toujours « planned », et
  // ça ne change rien. C'est le DOSSIER qui fait foi.
  const relu = JSON.parse(
    fs.readFileSync(path.join(available, 'bascule', 'manifest.json'), 'utf8')
  );
  assert.deepEqual(relu, manifeste, 'le manifeste est resté identique au caractère près');
  assert.equal(relu.status, 'planned');
  assert.equal(registry.manifest('bascule').planned, false, 'et pourtant il est disponible');
  } finally {
    nettoyer();
    registry.load();
  }
});

test('le même identifiant des deux côtés garde le connecteur réel', () => {
  const { available, planned, nettoyer } = dossiersTemporaires();
  try {
    ecrireManifeste(available, 'doublon', manifesteComplet());
    fs.writeFileSync(
      path.join(available, 'doublon', 'connector.js'),
      'module.exports = { test: async () => ({ ok: true }), fetchInvoices: async () => [] };'
    );
    ecrireManifeste(planned, 'doublon', manifesteComplet());

    const result = registry.load(available, planned);
    assert.equal(result.loaded, 1);
    assert.equal(result.planned, 0, 'l\'annonce est écartée');
    assert.equal(registry.isPlanned('doublon'), false);
    assert.match(result.errors.join(' '), /existe déjà dans available/);
  } finally {
    nettoyer();
    registry.load();
  }
});

// ---------------------------------------------------------------------------
// 6. Le vrai risque du lot : les quatre connecteurs qui marchent
// ---------------------------------------------------------------------------

test('les quatre connecteurs fonctionnels restent installables et opérationnels', async () => {
  registry.load();
  registry.syncCatalog();

  const compte = await helpers.createUser({ username: 'lot11-reel' });

  for (const id of FONCTIONNELS) {
    assert.equal(registry.has(id), true, `${id} : absent du registre`);
    assert.equal(registry.isPlanned(id), false, `${id} : ne doit pas être annoncé`);

    const entry = registry.get(id);
    assert.equal(typeof entry.module.test, 'function', `${id} : test() manquant`);
    assert.equal(typeof entry.module.fetchInvoices, 'function', `${id} : fetchInvoices() manquant`);

    assert.doesNotThrow(() => registry.assertInstallable(id), `${id} : refusé à tort`);

    const install = registry.install(compte.id, id);
    assert.equal(install.status, 'needs-config', `${id} : installation refusée`);

    // La planification suit l'installation, comme depuis le lot 3.
    assert.ok(
      helpers.db
        .get()
        .prepare('SELECT COUNT(*) AS n FROM user_connector_schedules WHERE user_id = ? AND connector_id = ?')
        .get(compte.id, id).n > 0,
      `${id} : aucune planification créée`
    );

    const vu = registry.listForUser(compte).find((c) => c.id === id);
    assert.equal(vu.installed, true, `${id} : absent du Store de ce compte`);
    assert.equal(vu.planned, false);
    assert.ok(vu.fields.length, `${id} : formulaire vide`);
    assert.ok(vu.permissions.length, `${id} : permissions perdues`);
    assert.ok(vu.health.action, `${id} : plus d'action proposée`);

    assert.equal(registry.uninstall(compte.id, id), true, `${id} : désinstallation refusée`);
  }
});

test('Free reste configurable et testable de bout en bout', async () => {
  const compte = await helpers.createUser({ username: 'lot11-free' });

  registry.install(compte.id, 'free');
  registry.saveConfig(compte.id, 'free', { username: 'fbx99999999', password: 'motdepasse' });

  const install = registry.getInstall(compte.id, 'free');
  assert.equal(install.status, 'installed');
  assert.ok(install.config_encrypted, 'la configuration est chiffrée au repos');
  assert.equal(install.account_id, 'fbx99999999', 'l\'identifiant de compte est déduit');

  // Le scraping est coupé en test : ce qu'on vérifie ici, c'est que l'appel
  // traverse bien le registre et revient avec une raison lisible — pas qu'il
  // joigne Free.
  const essai = await registry.testForUser(compte.id, 'free');
  assert.equal(typeof essai.ok, 'boolean');
  assert.ok(essai.message, 'un test rend toujours une raison');
  assert.equal(/annoncé/.test(essai.message), false, 'et jamais celle d\'un service annoncé');
});

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

/** Deux dossiers frères jetables, pour exercer le chargement sans le vrai disque. */
function dossiersTemporaires() {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-planned-'));
  const available = path.join(racine, 'available');
  const planned = path.join(racine, 'planned');
  fs.mkdirSync(available);
  fs.mkdirSync(planned);
  return {
    available,
    planned,
    nettoyer: () => fs.rmSync(racine, { recursive: true, force: true }),
  };
}

function ecrireManifeste(dir, id, manifeste) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(
    path.join(dir, id, 'manifest.json'),
    JSON.stringify({ ...manifeste, id }, null, 2),
    'utf8'
  );
}

/** Le manifeste minimal d'un service annoncé : ni champs, ni permissions. */
function manifesteAnnonce() {
  return {
    id: 'zombie',
    name: 'Zombie',
    category: 'divers',
    site: 'www.exemple.fr',
    description: 'Récupère automatiquement vos factures de démonstration.',
    status: 'planned',
  };
}

/** Un manifeste qui tient la route des DEUX côtés : c'est le sujet du test. */
function manifesteComplet() {
  return {
    id: 'bascule',
    name: 'Bascule',
    category: 'divers',
    site: 'www.exemple.fr',
    description: 'Récupère automatiquement vos factures de bascule.',
    status: 'planned',
    fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
    permissions: [
      {
        key: 'factures',
        scope: 'read-write',
        description:
          'Télécharge les factures du fournisseur de bascule et les dépose sur vos destinations.',
      },
      {
        key: 'identifiants',
        scope: 'read',
        description:
          'L\'identifiant saisi à la configuration, chiffré au repos, utilisé pour la seule connexion.',
      },
    ],
  };
}
