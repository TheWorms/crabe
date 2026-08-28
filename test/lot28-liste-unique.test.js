'use strict';

/**
 * Lot 28 — une seule liste de clouds, et un rclone qui sait tout faire.
 *
 * ─── Le défaut, en une phrase ────────────────────────────────────────────────
 *
 * L'écran « Ajouter un cloud » montrait DEUX listes : quatre fournisseurs
 * habillés, puis un bouton « Autre stockage » qui ouvrait la liste complète des
 * types du binaire rclone — où pCloud figurait une seconde fois, sous son nom
 * technique. Le même service, deux fois, sous deux noms, à deux endroits.
 *
 * ─── Pourquoi un faux rclone, et pas la vraie liste ──────────────────────────
 *
 * La liste des types vient du binaire installé : elle change d'une machine à
 * l'autre, et elle est vide là où rclone n'est pas installé — c'est le cas de
 * la machine de développement. Un test qui s'appuierait dessus ne mesurerait
 * rien de reproductible.
 *
 * Ce fichier fabrique donc un rclone dont on connaît la réponse par cœur, et
 * le fait passer par le VRAI chemin : `CRABE_RCLONE_BIN` pointe dessus, le
 * serveur l'exécute comme il exécuterait l'autre. C'est la méthode de la fausse
 * bourse Bitstamp du lot 27 — un menteur utile vaut mieux qu'un test qui
 * n'exécute rien.
 *
 * La réponse contient exprès les cas qui piègent :
 *
 *   - `pcloud`, `protondrive`, `mega` — les types que trois vedettes couvrent
 *     entièrement, et qui ne doivent donc apparaître qu'UNE fois, tout en haut ;
 *   - `webdav` — le type de kDrive, qui doit rester proposé pour lui-même :
 *     c'est un protocole, pas un service, et Infomaniak n'en est qu'un usager ;
 *   - `storj` et `tardigrade` — le même service sous deux noms, rclone gardant
 *     l'ancien pour ne pas casser les configurations existantes ;
 *   - `archive`, `crypt` — des vues sur un autre remote, où rien ne se dépose.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠ AVANT tout `require` de crabe : `config.rcloneBin` est lu au chargement du
// module, pas à chaque appel. Poser la variable après coup n'aurait aucun effet,
// et le test passerait en interrogeant… rien du tout.
const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-faux-rclone-'));
const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');

const TYPES_FAUX = [
  { Name: 'pcloud', Description: 'Pcloud', Options: [
    { Name: 'username', Help: 'Nom du compte', Required: true },
    { Name: 'password', Help: 'Mot de passe', Required: true, IsPassword: true },
  ] },
  { Name: 'protondrive', Description: 'Proton Drive', Options: [
    { Name: 'username', Help: 'Adresse Proton', Required: true },
    { Name: 'password', Help: 'Mot de passe', Required: true, IsPassword: true },
  ] },
  { Name: 'mega', Description: 'Mega', Options: [
    { Name: 'user', Help: 'Adresse MEGA', Required: true },
    { Name: 'pass', Help: 'Mot de passe', Required: true, IsPassword: true },
  ] },
  { Name: 'webdav', Description: 'WebDAV', Options: [
    { Name: 'url', Help: 'Adresse du serveur', Required: true },
    { Name: 'vendor', Help: 'Nature du serveur', Examples: [{ Value: 'other', Help: 'Autre' }] },
  ] },
  { Name: 'dropbox', Description: 'Dropbox', Options: [
    { Name: 'token', Help: 'Jeton', Required: true },
    { Name: 'chunk_size', Help: 'Taille de bloc', Advanced: true },
  ] },
  { Name: 'drive', Description: 'Google Drive', Options: [{ Name: 'scope', Help: 'Portée' }] },
  { Name: 's3', Description: 'Amazon S3 Compliant Storage Providers including AWS, Ceph, Wasabi',
    Options: [{ Name: 'provider', Help: 'Fournisseur' }] },
  { Name: 'storj', Description: 'Storj Decentralized Cloud Storage', Options: [] },
  { Name: 'tardigrade', Description: 'Storj Decentralized Cloud Storage', Options: [] },
  { Name: 'archive', Description: 'Read archives', Options: [] },
  { Name: 'crypt', Description: 'Encrypt/Decrypt a remote', Options: [] },
];

fs.writeFileSync(
  FAUX_RCLONE,
  '#!/usr/bin/env node\n'
    + `const TYPES = ${JSON.stringify(TYPES_FAUX)};\n`
    + 'const args = process.argv.slice(2).filter((a) => a !== "--config");\n'
    + 'if (args.includes("providers")) { process.stdout.write(JSON.stringify(TYPES)); process.exit(0); }\n'
    + 'if (args[0] === "version") { process.stdout.write("rclone v1.75.0-faux\\n"); process.exit(0); }\n'
    + 'if (args[0] === "obscure") { process.stdout.write("OBSCURCI\\n"); process.exit(0); }\n'
    + 'process.exit(0);\n',
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const helpers = require('./helpers');
const presets = require('../server/destinations/presets');
const backends = require('../server/destinations/backends');

const WEB = path.resolve(__dirname, '..', 'web');

let client;

test.before(async () => {
  await helpers.setup();
  await helpers.createUser({
    username: 'lot28',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  client = await helpers.startServer();
  await helpers.login(client, 'lot28', 'MotDePasse1');
  // Le cache d'une heure garderait la mesure d'un autre fichier de tests.
  backends.oublier();
});

test.after(() => {
  if (client) client.close();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Une liste, et une seule
// ---------------------------------------------------------------------------

test('le faux rclone est bien celui que crabe interroge', async () => {
  const res = await client.get('/api/admin/destinations/backends');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, 'sans cela, tout ce fichier ne mesurerait qu\'un échec');
});

test('« Ajouter un cloud » ne propose plus qu\'une liste, vedettes en tête', async () => {
  const res = await client.get('/api/admin/destinations');
  const liste = res.body.providers;

  // Les six vedettes ouvrent la liste, par ordre alphabétique — les deux MEGA
  // du lot 62 se suivent, et le socle S3 est une vedette comme les autres.
  assert.deepEqual(
    liste.slice(0, 6).map((p) => p.id),
    ['kdrive', 'mega', 'megas4', 'pcloud', 'proton', 's3']
  );
  assert.equal(liste.slice(0, 6).every((p) => p.vedette), true);
  assert.equal(liste.slice(6).some((p) => p.vedette), false, 'aucune vedette après les vedettes');

  // ⚠ LE DÉFAUT DU LOT : le même service deux fois. Ni par identifiant, ni par
  // nom affiché, ni par type proposé.
  const parId = liste.map((p) => p.id);
  assert.equal(new Set(parId).size, parId.length, `identifiant en double : ${parId}`);
  const parNom = liste.map((p) => p.label.toLowerCase());
  assert.equal(new Set(parNom).size, parNom.length, `nom affiché en double : ${parNom}`);
  const parType = liste.map((p) => p.type).filter(Boolean);
  assert.equal(new Set(parType).size, parType.length, `type proposé en double : ${parType}`);

  // Les types que les vedettes couvrent ne sont pas répétés…
  for (const type of ['pcloud', 'protondrive', 'mega']) {
    assert.equal(
      liste.filter((p) => p.backend === type).length,
      1,
      `${type} apparaît deux fois : c'est exactement le doublon de ce lot`
    );
    assert.equal(liste.find((p) => p.backend === type).vedette, true);
  }

  // … mais `webdav` reste proposé pour lui-même : c'est un protocole que bien
  // d'autres serveurs parlent, kDrive n'en est qu'un usager. Depuis le lot 62,
  // `s3` est dans le même cas : le socle « Stockage compatible S3 » couvre le
  // type, et « MEGA (stockage objet) » n'en est qu'un usager. Dans les deux
  // cas, les cartes ne disent pas la même chose.
  const enWebdav = liste.filter((p) => p.backend === 'webdav');
  assert.deepEqual(enWebdav.map((p) => p.id), ['kdrive', 'type:webdav']);
  assert.deepEqual(enWebdav.map((p) => p.label), ['kDrive', 'WebDAV']);
  const enS3 = liste.filter((p) => p.backend === 's3');
  assert.deepEqual(enS3.map((p) => p.id), ['megas4', 's3']);
  assert.equal(enS3.every((p) => p.vedette), true, 'le type s3 brut est couvert par le socle');

  // Les types qui ne sont pas des stockages n'y sont pas du tout.
  for (const type of ['crypt', 'archive', 'tardigrade']) {
    assert.equal(liste.some((p) => p.type === type), false, `${type} n'a rien à faire ici`);
  }

  // La seconde partie est triée sur ce qui est AFFICHÉ, pas sur le nom
  // technique : « Google Drive » se cherche à la lettre G, pas à celle de
  // `drive`.
  const autres = liste.filter((p) => !p.vedette).map((p) => p.label);
  assert.deepEqual(autres, [...autres].sort((a, b) => a.localeCompare(b, 'fr')));
  assert.ok(autres.includes('Google Drive'), autres.join(' · '));

  // La carte brute du type s3 — « Amazon S3 Compliant Storage Providers » et
  // son énumération de cinquante services — n'existe plus : le socle du lot 62
  // la remplace, comme la carte pCloud remplace `pcloud`.
  assert.equal(liste.some((p) => p.type === 's3'), false, 'le type s3 brut est couvert');
  // Quand le nom technique n'apporte rien, il n'est pas répété.
  assert.equal(liste.find((p) => p.type === 'dropbox').resume, '');
  assert.equal(liste.find((p) => p.type === 'drive').resume, 'drive');
});

test('MEGA et Proton Drive ne sont plus grisés dès qu\'rclone sait leur parler', async () => {
  const res = await client.get('/api/admin/destinations');
  for (const id of ['mega', 'proton']) {
    const carte = res.body.providers.find((p) => p.id === id);
    assert.equal(carte.disponible, true, `${id} reste grisé alors que le binaire l'annonce`);
    assert.equal(carte.indisponibleParce, null);
  }
});

test('un type couvert par une vedette disparaît aussi du sélecteur de la carte', async () => {
  const res = await client.get('/api/admin/destinations/backends');
  const noms = res.body.types.map((t) => t.name);
  assert.equal(noms.includes('pcloud'), false, 'la carte pCloud fait cela en mieux');
  assert.ok(noms.includes('webdav'));
  // Les champs d'un type couvert restent servis : une destination qui porte
  // déjà ce type doit continuer d'afficher son formulaire.
  const champs = await client.get('/api/admin/destinations/backends?type=pcloud');
  assert.ok(champs.body.champs.length >= 2, 'sinon un formulaire existant se viderait');
});

// ---------------------------------------------------------------------------
// 2. Le type arrive avec le choix, et le nom n'est plus demandé avant
// ---------------------------------------------------------------------------

test('choisir un service crée une destination qui porte déjà son type', async () => {
  const cree = await client.post('/api/admin/destinations', { provider: 'autre', type: 'dropbox' });
  assert.equal(cree.status, 200);
  assert.equal(cree.body.destination.type, 'dropbox');
  // Le nom par défaut est celui du service, pas « Autre stockage » : personne
  // n'a demandé de nom, et « Autre stockage » n'en est pas un.
  assert.equal(cree.body.destination.displayName, 'Dropbox');
  // Et ses champs sont déjà là : lui redemander son type serait lui redemander
  // ce qu'il vient de dire.
  assert.ok(
    cree.body.destination.champs.some((c) => c.key === 'token'),
    'la carte s\'ouvre avec le formulaire du service choisi'
  );
  // ⚠ Mis à jour au lot 29. Les champs « avancés » d'rclone étaient JETÉS ici,
  // et c'était le défaut : `mailbox_password`, sans lequel un compte Proton
  // Drive à deux mots de passe ne se configure pas, en fait partie. Ils
  // descendent maintenant tous, marqués `avance` — l'écran les range dans le
  // repli « Réglages avancés » plutôt que de les faire disparaître.
  const chunk = cree.body.destination.champs.find((c) => c.key === 'chunk_size');
  assert.ok(chunk, 'un champ avancé n\'est plus perdu en route');
  assert.equal(chunk.avance, true, 'mais il reste marqué comme tel, pour le repli');
  assert.equal(
    cree.body.destination.champs.find((c) => c.key === 'token').avance,
    false,
    'et un champ courant reste courant'
  );

  await client.delete(`/api/admin/destinations/${cree.body.destination.id}`);
});

test('un type que ce serveur ne sait pas utiliser est refusé, avec la raison', async () => {
  for (const type of ['type-invente', 'crypt', 'pcloud']) {
    const res = await client.post('/api/admin/destinations', { provider: 'autre', type });
    assert.equal(res.status, 400, `${type} aurait dû être refusé`);
    assert.match(res.body.error, /ce serveur sait utiliser/);
  }
});

test('un fournisseur vedette garde son type, même si on en propose un autre', async () => {
  const cree = await client.post('/api/admin/destinations', { provider: 'mega', type: 'dropbox' });
  assert.equal(cree.status, 200);
  // ⚠ Sinon une carte « MEGA », avec le logo de MEGA, parlerait à Dropbox.
  assert.equal(cree.body.destination.type, 'mega');
  assert.equal(cree.body.destination.displayName, 'MEGA (compte gratuit)');
  await client.delete(`/api/admin/destinations/${cree.body.destination.id}`);
});

// ---------------------------------------------------------------------------
// 3. Le catalogue lui-même : ce qui garantit qu'un service ne sort pas deux fois
// ---------------------------------------------------------------------------

test('les presets déclarent tous s\'ils remplacent leur type rclone', () => {
  for (const preset of Object.values(presets.PRESETS)) {
    assert.equal(
      typeof preset.couvreLeType,
      'boolean',
      `${preset.id} ne dit pas s'il remplace son type : la liste ne peut pas trancher`
    );
    if (preset.couvreLeType) assert.ok(preset.backend, `${preset.id} ne couvre rien du tout`);
  }
  // `s3` a rejoint les types couverts au lot 62 : le socle « Stockage
  // compatible S3 » remplace la carte brute du type, comme pCloud pour le sien.
  assert.deepEqual([...presets.typesCouverts()].sort(), ['mega', 'pcloud', 'protondrive', 's3']);
  // kDrive est le contre-exemple, et il est structurel : `webdav` ne lui
  // appartient pas. « MEGA (stockage objet) » est le même contre-exemple sur
  // `s3` (lot 62) : le protocole appartient au socle, pas à MEGA.
  assert.equal(presets.of('kdrive').backend, 'webdav');
  assert.equal(presets.of('kdrive').couvreLeType, false);
  assert.equal(presets.of('megas4').backend, 's3');
  assert.equal(presets.of('megas4').couvreLeType, false);
});

test('« Autre stockage » n\'est plus une carte, mais reste un habillage', () => {
  assert.equal(presets.liste().some((p) => p.id === 'autre'), false, 'plus de porte de sortie');
  // Les deux MEGA se suivent (lot 62) : le choix entre eux se lit d'un coup
  // d'œil, chacun avec sa phrase.
  assert.deepEqual(
    presets.liste().map((p) => p.id),
    ['kdrive', 'mega', 'megas4', 'pcloud', 'proton', 's3']
  );
  // Il doit survivre : des lignes en base le portent, et il donne sa pastille
  // grise aux destinations créées avec un type libre.
  assert.equal(presets.of('autre').backend, null);
  assert.equal(presets.HERITAGE.rclone, 'autre');
});

// ---------------------------------------------------------------------------
// 4. L'écran : une liste, pas de champ de nom, et un clic qui COMPILE
// ---------------------------------------------------------------------------

/**
 * Le HTML de la fenêtre de choix, produit par le vrai `web/admin.js`.
 *
 * `htmlChoixFournisseur()` est une fonction pure : on l'exécute telle quelle
 * dans un contexte minimal, avec la vraie fonction d'échappement du produit.
 */
function modaleDeChoix(fournisseurs) {
  const contexte = vm.createContext({ ETAT_FOURNISSEURS: fournisseurs, console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  // Seules les deux fonctions utiles sont extraites : charger tout `admin.js`
  // exigerait un DOM, et ce n'est pas ce qu'on mesure ici.
  for (const nom of ['htmlChoixFournisseur', 'motsDeRecherche']) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans admin.js`);
    const fin = source.indexOf('\n}\n', debut);
    vm.runInContext(`${source.slice(debut, fin + 3)}`, contexte);
  }
  return {
    html: vm.runInContext('htmlChoixFournisseur(ETAT_FOURNISSEURS)', contexte),
    contexte,
  };
}

test('la fenêtre de choix : une carte par service, aucune en double', async () => {
  const res = await client.get('/api/admin/destinations');
  const { html } = modaleDeChoix(res.body.providers);

  const cartes = html.match(/class="prov-card/g) || [];
  assert.equal(cartes.length, res.body.providers.length);

  // Plus de porte vers une seconde liste, et plus de champ de nom prématuré.
  assert.equal(html.includes('Autre stockage'), false);
  assert.equal(html.includes('id="prov-nom"'), false);
  assert.equal(html.includes('Comment voulez-vous l\'appeler'), false);

  // Le nom des services y est bien, une fois chacun — les deux MEGA du lot 62
  // sont deux cartes distinctes, et le socle S3 remplace la carte brute du
  // type (« Amazon S3 Compliant Storage Providers »), qui ne doit plus sortir.
  assert.equal(html.includes('Amazon S3 Compliant'), false, 'le type s3 brut est couvert par le socle');
  for (const nom of [
    'pCloud', 'Proton Drive', 'MEGA (compte gratuit)', 'MEGA (stockage objet, payant)',
    'Stockage compatible S3', 'kDrive', 'Dropbox', 'WebDAV',
  ]) {
    assert.equal(
      html.split(`>${nom}</span>`).length - 1,
      1,
      `« ${nom} » n'apparaît pas exactement une fois`
    );
  }
});

test('chaque carte porte un gestionnaire de clic qui COMPILE', async () => {
  // La leçon du lot 27, appliquée à un écran neuf : un nom de service comme
  // « google cloud storage » posé dans un attribut `onclick="…"` finit un jour
  // par le refermer, et le bouton ne fait alors plus STRICTEMENT rien. Le rang
  // dans la liste, lui, n'a ni espace, ni accent, ni guillemet.
  const res = await client.get('/api/admin/destinations');
  const { html } = modaleDeChoix(res.body.providers);

  const gestionnaires = [...html.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(gestionnaires.length >= 5);
  for (const code of gestionnaires) {
    assert.match(code, /^choisirFournisseur\(\d+\)$/, `attribut suspect : ${code}`);
    assert.doesNotThrow(() => new Function(code), `ne compile pas : ${code}`);
  }
  // Et le rang désigne bien la bonne carte.
  const rang = Number(gestionnaires[0].match(/\d+/)[0]);
  assert.equal(res.body.providers[rang].id, 'kdrive');
});

test('la recherche retrouve un service par son nom technique comme par son nom', async () => {
  const res = await client.get('/api/admin/destinations');
  const { html, contexte } = modaleDeChoix(res.body.providers);

  // Les cartes telles que le navigateur les verrait, reconstituées depuis le
  // HTML réellement produit : chacune avec la clé de recherche qu'elle porte.
  const cles = [...html.matchAll(/data-prov-cle="([^"]*)"/g)].map((m) =>
    m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  );
  assert.equal(cles.length, res.body.providers.length);

  const cartes = cles.map((cle) => ({
    style: {},
    getAttribute: (nom) => (nom === 'data-prov-cle' ? cle : null),
  }));
  const grille = { querySelectorAll: () => cartes };
  const vide = { style: {} };
  const champ = { value: '' };
  contexte.$ = (id) =>
    ({ 'prov-filtre': champ, 'prov-grid': grille, 'prov-aucun': vide })[id] || null;

  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const debut = source.indexOf('function filtrerFournisseurs(');
  vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);

  const visibles = () =>
    cartes.map((c, i) => (c.style.display === 'none' ? null : res.body.providers[i]))
      .filter(Boolean);

  champ.value = 'drive';
  vm.runInContext('filtrerFournisseurs()', contexte);
  const trouves = visibles().map((p) => p.label);
  assert.ok(trouves.includes('Google Drive'), trouves.join(' · '));
  assert.ok(trouves.includes('kDrive'), 'le nom affiché compte aussi');
  assert.equal(trouves.includes('Dropbox'), false);
  assert.equal(vide.style.display, 'none', 'il y a des résultats : pas de message');

  // Un service indisponible reste trouvable : il faut pouvoir LIRE pourquoi il
  // ne marchera pas, plutôt que de croire que crabe ne le connaît pas.
  champ.value = 'mega';
  vm.runInContext('filtrerFournisseurs()', contexte);
  assert.ok(visibles().some((p) => p.id === 'mega'));

  champ.value = 'un service qui n\'existe pas';
  vm.runInContext('filtrerFournisseurs()', contexte);
  assert.equal(visibles().length, 0);
  assert.equal(vide.style.display, '', 'et le message d\'absence s\'affiche');

  champ.value = '';
  vm.runInContext('filtrerFournisseurs()', contexte);
  assert.equal(visibles().length, res.body.providers.length, 'tout revient quand on efface');
});
