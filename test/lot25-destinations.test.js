'use strict';

/**
 * Lot 25, phase A — les destinations cloud deviennent des lignes, pas du code.
 *
 * ─── Ce que ce fichier remplace, et pourquoi ─────────────────────────────────
 *
 * Il prend la suite de `lot24-phase-b.test.js`, qui verrouillait exactement
 * l'inverse : « les SIX destinations sont les mêmes partout ». C'était le bon
 * test pour le modèle du lot 24 — six fournisseurs déclarés dans le code, un
 * module chacun — et ce modèle est celui que ce lot remplace. Un catalogue
 * figé oblige à livrer une version de crabe par fournisseur, alors qu'rclone en
 * gère des dizaines.
 *
 * Tout ce qui restait vrai a été gardé mot pour mot : la composition d'un bloc
 * rclone, l'adresse WebDAV de kDrive, les types absents nommés plutôt que
 * devinés, le choix par compte, le mot de passe qui survit à une correction
 * d'adresse. Ce qui change, c'est l'objet : ces règles portent désormais sur un
 * cloud CRÉÉ, pas sur une constante.
 *
 * ─── Ce que ces tests protègent, et qui est neuf ─────────────────────────────
 *
 * 1. **Une installation neuve n'a que le stockage local.** C'est le constat réel qui
 *    ouvre ce lot : cinq fournisseurs occupaient l'écran Stockage sans que
 *    personne les ait demandés, et deux d'entre eux n'avaient même pas de
 *    formulaire.
 *
 * 2. **Deux comptes chez le même fournisseur coexistent.** C'était impossible
 *    avant : une destination = un identifiant = une configuration.
 *
 * 3. **Une destination supprimée ne fait pas disparaître l'historique.** Une
 *    facture copiée là-bas garde sa pastille et le nom de l'endroit où elle est
 *    partie. C'est la contrainte la plus dure du lot.
 *
 * 4. **Les champs d'un formulaire sont les mêmes pour l'écran, pour
 *    l'enregistrement et pour l'obscurcissement des mots de passe.** Trois
 *    endroits qui divergeraient effaceraient un secret à chaque sauvegarde.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db/db');
const destinations = require('../server/destinations');
const catalogue = require('../server/destinations/catalogue');
const presets = require('../server/destinations/presets');
const preferences = require('../server/preferences');
const backends = require('../server/destinations/backends');
const { blocDepuisChamps } = require('../server/destinations/remote-rclone');

let compteA;
let compteB;

test.before(async () => {
  await helpers.setup();
  compteA = await helpers.createUser({ username: 'dest-a', plainPassword: 'MotDePasse1' });
  compteB = await helpers.createUser({ username: 'dest-b', plainPassword: 'MotDePasse1' });
});

/**
 * Remet le stockage à l'état d'une installation neuve entre deux tests.
 *
 * Sans ça, un cloud créé par un test resterait pour les suivants — et les
 * assertions sur « ce que ce compte reçoit » dépendraient de l'ordre
 * d'exécution, ce qui est la meilleure façon d'écrire un test qui passe sans
 * rien prouver.
 */
test.beforeEach(() => {
  db.get().prepare("DELETE FROM destinations_config WHERE dest_id != 'local'").run();
  db.get().prepare("DELETE FROM user_preferences WHERE key = 'destinations.desactivees'").run();
  destinations.oublierPilotes();
});

/** Crée un cloud configuré et activé, et rend son identifiant. */
function creer({ provider = 'mega', displayName, valeurs = {} } = {}) {
  const cree = destinations.createCloud({ provider, displayName });
  destinations.saveConfig(cree.id, { enabled: true, valeurs }, presets.of(provider).champs || []);
  return cree.id;
}

// ---------------------------------------------------------------------------
// 1. Une installation neuve n'a que le stockage local
// ---------------------------------------------------------------------------

test('une installation neuve ne montre que le stockage local', () => {
  assert.deepEqual(destinations.ordre(), ['local']);
  assert.deepEqual(destinations.cloudIds(), []);
  assert.deepEqual(destinations.listPublic().map((d) => d.id), ['local']);
  assert.deepEqual(destinations.activeDestinations(), ['local']);

  // Et la table ne porte QUE cette ligne : c'est l'amorçage qui a changé, pas
  // seulement l'affichage. Une ligne fantôme reviendrait à l'écran au premier
  // écran rechargé.
  const lignes = db.get().prepare('SELECT dest_id FROM destinations_config').all();
  assert.deepEqual(lignes.map((r) => r.dest_id), ['local']);
});

test('Le stockage local se supprime et se remet — mais ne se recrée pas', () => {
  // ⚠ CE TEST A CHANGÉ DE SENS AU LOT 26. Il affirmait que le stockage local « ne
  // s'ajoute ni ne se supprime ». La première moitié tient toujours ; la
  // seconde était un refus qu'on avait justifié par « c'est le stockage
  // principal » — ce qui confondait « copie de référence » et « imposé à
  // tout le monde ». Quelqu'un qui range tout sur son cloud n'a aucune raison
  // de garder une seconde copie sur le serveur de crabe.
  //
  // ⚠ Et RE-CHANGÉ AU LOT 38 : « au moins une destination active » a remplacé
  // « le stockage local obligatoire ». Le stockage local se supprime toujours — mais plus quand
  // il est le DERNIER espace actif : crabe n'accepte plus de rester sans
  // nulle part où écrire.
  const avant = destinations.publicConfig('local');
  assert.equal(avant.supprimable, true);
  assert.equal(avant.supprime, false);

  // Seul actif : le retrait est refusé, en français, avec le geste qui débloque.
  assert.throws(
    () => destinations.deleteCloud('local'),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /dernier espace de stockage actif/);
      assert.match(err.message, /Paramètres → Stockage/);
      return true;
    },
    'le dernier stockage actif ne se retire pas'
  );
  assert.equal(destinations.localActif(), true, 'le refus n\'a rien débranché');

  const relais = creer({ provider: 'mega', displayName: 'Relais',
    valeurs: { user: 'relais@exemple.fr', pass: 'obscurci' } });

  const supprime = destinations.deleteCloud('local');
  assert.ok(supprime, 'avec un autre espace actif, la suppression aboutit');
  assert.equal(destinations.localActif(), false);
  assert.deepEqual(
    destinations.activeDestinations(),
    [relais],
    'les documents ont toujours un endroit où aller'
  );

  // Le CHEMIN survit, et c'est ce qui distingue le stockage local d'un cloud : ses
  // fichiers sont toujours là, et les retrouver ne doit rien coûter.
  const pendant = destinations.publicConfig('local');
  assert.equal(pendant.supprime, true);
  assert.equal(pendant.enabled, false);
  assert.ok(pendant.path, 'le chemin n\'est jamais effacé : les fichiers y sont encore');

  // Il reste visible dans la liste, sans quoi plus rien ne saurait le remettre.
  assert.ok(
    destinations.listPublic().some((d) => d.id === 'local'),
    'un stockage qu\'on ne peut plus remettre serait une suppression déguisée en aller simple'
  );

  const remis = destinations.restoreLocal();
  assert.equal(remis.supprime, false);
  assert.equal(destinations.localActif(), true);
  assert.deepEqual(destinations.activeDestinations(), ['local', relais]);

  // Ce qui n'a pas changé : il ne se crée pas comme un cloud. Il n'y en a
  // qu'un, il existe depuis le premier démarrage, et il se remet — il ne se
  // recrée pas.
  assert.throws(
    () => destinations.createCloud({ provider: 'local' }),
    /n'existe pas/,
    'Le stockage local n\'est pas un fournisseur proposable'
  );
});

// ---------------------------------------------------------------------------
// 2. Un cloud se crée, se nomme, et se double
// ---------------------------------------------------------------------------

test('un cloud créé porte le nom qu\'on lui donne, et son fournisseur décide du reste', () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud perso' }).id;

  const vue = destinations.publicConfig(id);
  assert.equal(vue.displayName, 'pCloud perso');
  assert.equal(vue.provider, 'pcloud');
  assert.equal(vue.type, 'pcloud', 'le type rclone vient du fournisseur, pas de l\'utilisateur');
  assert.equal(vue.enabled, false, 'un cloud neuf est éteint : il n\'a encore rien pour se connecter');
  assert.equal(vue.configured, false);

  // L'identité visuelle suit le FOURNISSEUR, le nom suit l'utilisateur.
  const marque = catalogue.brand(id);
  assert.equal(marque.name, 'pCloud perso');
  assert.equal(marque.color, '#1f8fd6');
  assert.equal(marque.site, 'www.pcloud.com', 'c\'est là que son logo se récupère');
});

test('deux comptes chez le même fournisseur coexistent', () => {
  const perso = creer({ provider: 'mega', displayName: 'MEGA perso',
    valeurs: { user: 'moi@exemple.fr', pass: 'obscurci-1' } });
  const pro = creer({ provider: 'mega', displayName: 'MEGA boulot',
    valeurs: { user: 'boulot@exemple.fr', pass: 'obscurci-2' } });

  assert.notEqual(perso, pro, 'deux lignes, deux identifiants');
  assert.deepEqual(destinations.activeDestinations().sort(), ['local', perso, pro].sort());

  // Et leurs identifiants ne se mélangent pas : c'était structurellement
  // impossible avant ce lot, une destination n'ayant qu'une configuration.
  assert.equal(destinations.readConfig(perso).valeurs.user, 'moi@exemple.fr');
  assert.equal(destinations.readConfig(pro).valeurs.user, 'boulot@exemple.fr');
});

test('l\'identifiant d\'un cloud ne change jamais, même renommé', () => {
  const id = creer({ provider: 'kdrive', displayName: 'kDrive maison',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' } });

  destinations.saveConfig(id, { enabled: true, displayName: 'kDrive de la famille' },
    presets.of('kdrive').champs);

  assert.equal(destinations.publicConfig(id).displayName, 'kDrive de la famille');
  assert.equal(destinations.publicConfig(id).id, id, 'l\'identifiant est celui de la création');
  // Il se retrouve dans l'historique de copie de chaque facture : le réécrire
  // demanderait de réécrire des milliers de lignes sans en oublier une.
  assert.match(id, /^cloud-[0-9a-f]{8}$/);
});

test('les clouds s\'affichent par nom, le stockage local toujours en tête', () => {
  const z = creer({ provider: 'pcloud', displayName: 'Zeta' });
  const e = creer({ provider: 'pcloud', displayName: 'École' });
  const a = creer({ provider: 'pcloud', displayName: 'Alpha' });

  // « École » avant « Zeta » : une comparaison brute rangerait tous les
  // accentués après Z (voir connectors/tri.js, lot 24).
  assert.deepEqual(destinations.ordre(), ['local', a, e, z]);
});

// ---------------------------------------------------------------------------
// 3. Supprimer un cloud n'efface pas l'historique
// ---------------------------------------------------------------------------

test('un cloud supprimé garde son nom pour les factures déjà copiées', () => {
  const id = creer({ provider: 'pcloud', displayName: 'pCloud perso',
    valeurs: { user: 'moi@exemple.fr' } });

  destinations.deleteCloud(id);

  // Il disparaît de partout où l'on choisit et où l'on configure…
  assert.equal(destinations.ordre().includes(id), false);
  assert.equal(destinations.activeDestinations().includes(id), false);
  assert.equal(destinations.publicConfig(id), null);
  assert.equal(destinations.driverFor(id), null);

  // …mais la pastille d'une facture partie là-bas continue de le nommer. Une
  // pastille qui deviendrait « cloud-3f8a2b91 » ferait douter d'une copie qui a
  // bel et bien eu lieu.
  assert.equal(catalogue.brand(id).name, 'pCloud perso');
  assert.equal(catalogue.brand(id).color, '#1f8fd6');
});

test('supprimer un cloud efface ses identifiants', () => {
  const id = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'moi@exemple.fr', pass: 'secret-obscurci' } });

  destinations.deleteCloud(id);

  const ligne = db.get()
    .prepare('SELECT config_encrypted, deleted_at, display_name FROM destinations_config WHERE dest_id = ?')
    .get(id);
  assert.equal(ligne.config_encrypted, null, 'plus rien de chiffré à garder');
  assert.ok(ligne.deleted_at, 'la ligne est marquée supprimée, pas effacée');
  assert.equal(ligne.display_name, 'MEGA', 'le nom survit : c\'est tout ce qui reste');
});

test('une pastille d\'un identifiant hérité reste nommée', () => {
  // Une facture copiée avant le lot 25 vers une destination jamais migrée —
  // parce que personne ne l'avait configurée, donc supprimée par la migration.
  assert.equal(catalogue.brand('proton').name, 'Proton Drive');
  assert.equal(catalogue.brand('rclone').name, 'Autre stockage');
  // Et un identifiant qui ne veut rien dire ne fait pas tomber l'écran.
  assert.equal(catalogue.brand('nawak').name, 'nawak');
  assert.equal(catalogue.brand('').name, 'destination');
});

// ---------------------------------------------------------------------------
// 4. Les formulaires : ce qu'rclone demande, pas ce qu'on suppose
// ---------------------------------------------------------------------------

test('un bloc rclone se construit des champs, sans clé vide', () => {
  // Une clé présente et vide n'est PAS la même chose qu'une clé absente pour
  // rclone : écrire « user = » là où rien n'a été saisi fait échouer des
  // remotes qui marcheraient sans.
  assert.equal(
    blocDepuisChamps('webdav', { url: 'https://x.fr', vendor: 'other', user: '', pass: null }),
    'type = webdav\nurl = https://x.fr\nvendor = other'
  );
});

test('kDrive compose son adresse WebDAV à partir du seul numéro', () => {
  assert.equal(
    presets.adresseWebdavKdrive('123456'),
    'https://123456.connect.kdrive.infomaniak.com/123456'
  );
  // Rien à composer sans numéro — et surtout pas une adresse à trous, qui
  // partirait en requête vers un hôte inexistant.
  assert.equal(presets.adresseWebdavKdrive(''), '');
  assert.equal(presets.adresseWebdavKdrive(null), '');
  // Le numéro entre dans un nom d'hôte : tout ce qui n'y a pas sa place saute.
  assert.equal(
    presets.adresseWebdavKdrive('12/../evil'),
    'https://12evil.connect.kdrive.infomaniak.com/12evil'
  );
});

test('kDrive passe par WebDAV, MEGA par son propre backend', () => {
  assert.equal(presets.of('kdrive').backend, 'webdav', 'il n\'existe aucun backend rclone « kdrive »');
  assert.equal(presets.of('mega').backend, 'mega');
  assert.equal(presets.of('autre').backend, null, 'le choix libre n\'impose aucun type');

  const id = creer({ provider: 'kdrive', displayName: 'kDrive',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' } });

  const conf = destinations.driverFor(id).normalizeConf(destinations.readConfig(id));
  assert.equal(
    conf.rcloneConfig,
    'type = webdav\n'
      + 'url = https://123456.connect.kdrive.infomaniak.com/123456\n'
      + 'vendor = other\n'
      + 'user = moi@exemple.fr\n'
      + 'pass = obscurci'
  );
});

test('un bloc collé à la main prime sur les champs, et son type est relu', () => {
  // Quelqu'un qui a déjà une configuration rclone qui marche ne doit pas la
  // perdre parce qu'une autre ergonomie est arrivée.
  const id = destinations.createCloud({ provider: 'autre', displayName: 'Mon serveur' }).id;
  destinations.saveConfig(id, {
    enabled: true,
    rcloneConfig: 'type = sftp\nhost = exemple.fr\nuser = moi',
  });

  const driver = destinations.driverFor(id);
  const conf = driver.normalizeConf(destinations.readConfig(id));
  assert.match(conf.rcloneConfig, /type = sftp/);
  assert.equal(driver.typeDe(conf), 'sftp', 'le type se relit dans le bloc');
});

test('un type absent du rclone installé est nommé, pas laissé à deviner', () => {
  const message = backends.messageTypeAbsent('MEGA', 'mega');
  assert.match(message, /rclone/);
  assert.match(message, /mega/);
  // Ce que le message doit écarter : l'idée que le compte ou le mot de passe
  // soient en cause. C'est la première chose que l'utilisateur va soupçonner.
  assert.match(message, /pas un problème de compte/i);
  assert.match(message, /version plus récente/i);
});

test('les types qui ne sont pas des stockages ne sont pas proposés', () => {
  // `crypt`, `alias`, `union`… transforment un autre remote : les proposer
  // dans une liste de destinations n'aurait aucun sens pour qui la lit.
  for (const t of ['alias', 'crypt', 'union', 'chunker']) {
    assert.ok(backends.PAS_DES_STOCKAGES.has(t), t);
  }
});

test('une option rclone devient un champ de formulaire lisible', () => {
  const champ = backends.champDepuisOption({
    Name: 'pass',
    Help: 'Password.',
    Required: true,
    IsPassword: true,
    Advanced: false,
  });
  assert.equal(champ.key, 'pass');
  assert.equal(champ.type, 'password', 'un secret ne se réaffiche jamais');
  assert.equal(champ.required, true);

  const liste = backends.champDepuisOption({
    Name: 'vendor',
    Help: 'Name of the WebDAV site.',
    Examples: [{ Value: 'nextcloud', Help: 'Nextcloud' }, { Value: 'other', Help: 'Other' }],
  });
  assert.deepEqual(liste.options.map((o) => o.value), ['nextcloud', 'other']);
});

test('l\'adresse d\'un fichier sur le remote garde les chemins absolus', () => {
  const rclone = require('../server/destinations/rclone');

  assert.equal(
    rclone.adresse({ remoteName: 'pcloud', basePath: 'crabe' }, 'moi/Free/2026/a.pdf'),
    'pcloud:crabe/moi/Free/2026/a.pdf'
  );
  // Dossier de base vide : pas de barre parasite après les deux-points.
  assert.equal(rclone.adresse({ remoteName: 'p', basePath: '' }, 'a.pdf'), 'p:a.pdf');
  assert.equal(rclone.adresse({ remoteName: 'p' }), 'p:');

  // ⚠ LE DÉFAUT DU LOT 24, et il ne se voit qu'avec un chemin absolu : un
  // `.replace(':/', ':')` mangeait la barre. Le dépôt répondait « ok » et le
  // fichier atterrissait relativement au dossier de travail du service — donc
  // introuvable. Mesuré sur le conteneur avant correction.
  assert.equal(
    rclone.adresse({ remoteName: 'essai', basePath: '/mnt/disque' }, 'moi/a.pdf'),
    'essai:/mnt/disque/moi/a.pdf'
  );
  // Et une barre en trop d'un côté ou de l'autre ne double jamais.
  assert.equal(
    rclone.adresse({ remoteName: 'e', basePath: '/mnt/disque/' }, '/moi/a.pdf'),
    'e:/mnt/disque/moi/a.pdf'
  );
});

// ---------------------------------------------------------------------------
// 5. Le choix par compte : jamais de coupure en silence
// ---------------------------------------------------------------------------

test('sans réglage, un compte reçoit TOUTES les destinations actives', () => {
  const mega = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'moi@exemple.fr', pass: 'obscurci' } });
  const kdrive = creer({ provider: 'kdrive', displayName: 'kDrive',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' } });

  assert.deepEqual(destinations.activeDestinations().sort(), ['local', kdrive, mega].sort());
  assert.deepEqual(
    destinations.destinationsForUser(compteA.id).sort(),
    ['local', kdrive, mega].sort(),
    'aucun réglage = tout, c\'est-à-dire le comportement d\'avant ce lot'
  );
});

test('un compte qui refuse une destination ne perd rien ailleurs', () => {
  const mega = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'moi@exemple.fr', pass: 'obscurci' } });
  const kdrive = creer({ provider: 'kdrive', displayName: 'kDrive',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' } });

  preferences.set(compteA.id, 'destinations.desactivees', [mega]);

  assert.deepEqual(destinations.destinationsForUser(compteA.id), ['local', kdrive]);
  // Le point qui compte : le réglage d'un compte ne déborde JAMAIS sur un autre.
  assert.deepEqual(
    destinations.destinationsForUser(compteB.id).sort(),
    ['local', kdrive, mega].sort()
  );
  // Et l'administration continue de voir la destination : elle est active,
  // simplement pas choisie par ce compte-là.
  assert.ok(destinations.activeDestinations().includes(mega));
});

test('la destination principale ne peut pas être refusée', () => {
  const message = preferences.refus('destinations.desactivees', ['local']);
  assert.match(message, /copie de référence/i);

  // Et même si la valeur arrivait en base par un autre chemin, la lecture ne
  // retire jamais le stockage local : c'est depuis elle que les copies sont faites.
  db.get()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, 'destinations.desactivees', '["local"]', datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(compteA.id);
  assert.ok(destinations.destinationsForUser(compteA.id).includes('local'));
});

test('une destination inconnue est refusée avec son nom', () => {
  const mega = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'moi@exemple.fr', pass: 'obscurci' } });

  assert.match(
    preferences.refus('destinations.desactivees', ['nawak']),
    /Destination de stockage inconnue.*nawak/
  );
  assert.equal(preferences.refus('destinations.desactivees', [mega]), null);

  // ⚠ La liste des clouds est relue à chaque contrôle : un cloud ajouté après
  // le démarrage du service doit être acceptable tout de suite.
  const neuf = creer({ provider: 'pcloud', displayName: 'pCloud' });
  assert.equal(preferences.refus('destinations.desactivees', [neuf]), null);
});

test('une préférence illisible ne coupe AUCUNE copie', () => {
  const mega = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'moi@exemple.fr', pass: 'obscurci' } });

  db.get()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, 'destinations.desactivees', 'ceci n''est pas du JSON', datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(compteA.id);

  // Se tromper du côté de « tout copier » ne perd aucun document ; se tromper
  // de l'autre côté, si.
  assert.deepEqual(destinations.destinationsForUser(compteA.id).sort(), ['local', mega].sort());
});

// ---------------------------------------------------------------------------
// 6. Un secret enregistré ne s'efface pas parce qu'un champ revient vide
// ---------------------------------------------------------------------------

test('corriger une adresse n\'efface pas le mot de passe d\'à côté', () => {
  const champs = presets.of('mega').champs;
  const id = creer({ provider: 'mega', displayName: 'MEGA',
    valeurs: { user: 'ancienne@exemple.fr', pass: 'secret-obscurci' } });

  // Ce que le navigateur renvoie après avoir corrigé la seule adresse : le
  // champ mot de passe est vide, parce qu'il n'a jamais été rempli.
  destinations.saveConfig(id, {
    enabled: true,
    valeurs: { user: 'nouvelle@exemple.fr', pass: '' },
  }, champs);

  const normalise = destinations.driverFor(id).normalizeConf(destinations.readConfig(id));
  assert.equal(normalise.valeurs.user, 'nouvelle@exemple.fr');
  assert.equal(normalise.valeurs.pass, 'secret-obscurci', 'le mot de passe a survécu');
  assert.match(normalise.rcloneConfig, /^type = mega$/m);
});

test('un secret n\'est jamais renvoyé au navigateur, même configuré', () => {
  const id = creer({ provider: 'kdrive', displayName: 'kDrive',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'secret-obscurci' } });

  const vue = destinations.publicConfig(id);
  assert.equal(vue.configured, true);
  assert.equal(vue.valeurs.kdriveId, '123456', 'ce qui n\'est pas secret est réaffiché');
  assert.equal('pass' in vue.valeurs, false, 'le mot de passe, lui, ne sort pas');
  assert.equal(JSON.stringify(vue).includes('secret-obscurci'), false);
  // Les libellés, eux, descendent : c'est avec eux que l'écran se dessine.
  assert.deepEqual(vue.champs.map((c) => c.key), ['kdriveId', 'user', 'pass']);
});

test('les champs d\'un fournisseur sans formulaire écrit viennent d\'rclone', async () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud' }).id;

  // Sur une machine sans rclone, la liste est vide — et c'est une information,
  // pas une erreur : l'écran propose alors le bloc à coller. Ce qui doit être
  // vrai dans les deux cas, c'est qu'on ne lève pas, et qu'on ne fabrique
  // aucun champ imaginaire.
  const champs = await destinations.champsDe(id);
  assert.ok(Array.isArray(champs), 'jamais null, jamais une exception');
  for (const c of champs) {
    assert.equal(typeof c.key, 'string');
    // ⚠ Mis à jour au lot 29 : les champs avancés SONT proposés désormais,
    // dans le repli « Réglages avancés ». Ce qui reste écarté, c'est ce
    // qu'rclone lui-même masque du fichier de configuration — ses valeurs de
    // travail, qu'il écrit après coup et que personne ne peut saisir.
    assert.equal(c.masque, false, 'un champ masqué par rclone n\'est pas proposé');
    // Le drapeau qui décide du passage par `rclone obscure`. Sans lui, un mot
    // de passe juste serait refusé par rclone sans que rien ne l'explique.
    // ⚠ Mis à jour au lot 34 : « password » ne veut plus dire « à obscurcir »
    // sans exception. Le lot 33 a rangé le jeton pCloud dans les champs
    // `password` (un secret, jamais réaffiché) avec `obscurcir: false`
    // explicite — rclone attend ce jeton EN CLAIR, l'obscurcir le rendrait
    // inutilisable. Ce conflit est resté invisible tant que la machine de
    // travail n'avait pas d'rclone : la boucle était vide, l'assertion ne
    // s'exécutait jamais. L'invariant affiné : l'exemption ne peut venir que
    // de l'habillage français, écrite noir sur blanc dans PRESENTATIONS —
    // jamais d'un oubli, car un mot de passe non obscurci serait refusé par
    // rclone au premier usage, sans un mot d'explication à l'écran.
    if (c.type === 'password') {
      const exemption = presets.PRESENTATIONS.pcloud?.[c.key]?.obscurcir === false;
      assert.equal(c.obscurcir, exemption ? false : true,
        `le champ « ${c.key} » doit porter le drapeau que l'habillage lui donne`);
    }
  }
});

// ---------------------------------------------------------------------------
// 7. La synchronisation manuelle suit, sans travail supplémentaire
// ---------------------------------------------------------------------------

test('un cloud créé reçoit le bouton « Synchroniser »', () => {
  const kdrive = creer({ provider: 'kdrive', displayName: 'kDrive',
    valeurs: { kdriveId: '123456', user: 'moi@exemple.fr', pass: 'obscurci' } });

  // Le bouton n'est pas déclaré destination par destination : il suit
  // `activeDestinations()`, la même liste que les copies. Une destination qui
  // reçoit des copies a donc toujours de quoi rattraper ce qui lui manque.
  const cibles = destinations.activeDestinations().filter((id) => id !== 'local');
  assert.deepEqual(cibles, [kdrive]);

  const sync = require('../server/destinations/sync');
  assert.equal(typeof sync.pendingCount(kdrive), 'number');
});
