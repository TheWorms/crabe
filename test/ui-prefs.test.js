'use strict';

/**
 * Cartes / liste et tris — la règle partagée par seize écrans (lot 10, §5).
 *
 * Ce que ce fichier verrouille, parce que c'est exactement ce qui se casse en
 * silence :
 *
 *   1. **le tri porte sur la DONNÉE, pas sur son affichage.** Une date écrite
 *      « il y a 3 h » se trie chronologiquement, une taille « 99,3 Ko »
 *      numériquement. Trier la chaîne affichée donne un ordre faux qui a l'air
 *      juste ;
 *   2. **une valeur absente finit en bas**, quel que soit le sens. Un
 *      connecteur jamais exécuté ne doit pas venir en tête d'un tri
 *      décroissant par date ;
 *   3. **le tri et le mode d'affichage sont mémorisés par COMPTE**, pas par
 *      navigateur, et une valeur abîmée retombe sur le défaut plutôt que de
 *      casser un écran.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const uiPrefs = require('../web/ui-prefs');
const preferences = require('../server/preferences');

// ---------------------------------------------------------------------------
// Trier sur la donnée, jamais sur l'affichage
// ---------------------------------------------------------------------------

test('une date se trie chronologiquement, même écrite « il y a 3 h »', () => {
  // Ce que l'écran AFFICHE, et ce sur quoi il doit trier. Les libellés sont
  // ceux de `fmt.relative`, tels qu'ils apparaissent dans les journaux.
  const lignes = [
    { nom: 'instant', affiche: 'à l\'instant', at: Date.parse('2026-08-10T10:00:00Z') },
    { nom: 'heures', affiche: 'il y a 3 h', at: Date.parse('2026-08-10T07:00:00Z') },
    { nom: 'jours', affiche: 'il y a 2 j', at: Date.parse('2026-08-08T10:00:00Z') },
  ];

  const parDate = uiPrefs.trier(lignes, { key: 'at', dir: 'desc' }, { at: (l) => l.at });
  assert.deepEqual(parDate.map((l) => l.nom), ['instant', 'heures', 'jours']);

  // Trier la chaîne affichée donne un ordre FAUX qui a l'air juste : « à
  // l'instant » se range avec les A, donc en fin de liste décroissante, alors
  // que c'est la ligne la plus récente.
  const parTexte = uiPrefs.trier(lignes, { key: 'x', dir: 'desc' }, { x: (l) => l.affiche });
  assert.equal(parTexte.at(-1).nom, 'instant', 'le texte relègue la ligne la plus récente');
  assert.notDeepEqual(
    parTexte.map((l) => l.nom),
    parDate.map((l) => l.nom),
    'l\'ordre du texte ne peut pas être celui des dates'
  );
});

test('une taille se trie numériquement, même écrite « 99,3 Ko »', () => {
  const lignes = [
    { nom: '9 Mo', bytes: 9_000_000 },
    { nom: '99,3 Ko', bytes: 101_683 },
    { nom: '512 o', bytes: 512 },
  ];

  assert.deepEqual(
    uiPrefs.trier(lignes, { key: 'bytes', dir: 'asc' }, { bytes: (l) => l.bytes }).map((l) => l.nom),
    ['512 o', '99,3 Ko', '9 Mo']
  );
});

test('les accents ne renvoient pas un service en fin de liste', () => {
  const lignes = [{ n: 'Zurich' }, { n: 'Stockage local' }, { n: 'Amazon' }];
  assert.deepEqual(
    uiPrefs.trier(lignes, { key: 'n', dir: 'asc' }, { n: (l) => l.n }).map((l) => l.n),
    ['Amazon', 'Stockage local', 'Zurich']
  );
});

test('une valeur absente finit en bas, dans les deux sens', () => {
  const lignes = [
    { nom: 'jamais', at: null },
    { nom: 'vieux', at: 1000 },
    { nom: 'recent', at: 9000 },
  ];
  const acces = { at: (l) => l.at };

  assert.deepEqual(
    uiPrefs.trier(lignes, { key: 'at', dir: 'desc' }, acces).map((l) => l.nom),
    ['recent', 'vieux', 'jamais'],
    'un connecteur jamais exécuté ne prend pas la tête'
  );
  assert.deepEqual(
    uiPrefs.trier(lignes, { key: 'at', dir: 'asc' }, acces).map((l) => l.nom),
    ['vieux', 'recent', 'jamais']
  );
});

test('le départage garde un ordre stable et lisible', () => {
  const lignes = [
    { nom: 'b', groupe: 1 },
    { nom: 'a', groupe: 1 },
    { nom: 'c', groupe: 0 },
  ];
  const trie = uiPrefs.trier(
    lignes,
    { key: 'groupe', dir: 'asc' },
    { groupe: (l) => l.groupe },
    (l) => l.nom
  );
  assert.deepEqual(trie.map((l) => l.nom), ['c', 'a', 'b']);
});

test('trier ne modifie pas la liste d\'origine', () => {
  const lignes = [{ n: 'b' }, { n: 'a' }];
  uiPrefs.trier(lignes, { key: 'n', dir: 'asc' }, { n: (l) => l.n });
  assert.deepEqual(lignes.map((l) => l.n), ['b', 'a']);
});

test('une colonne sans accès ne réordonne rien plutôt que de lever', () => {
  const lignes = [{ n: 'b' }, { n: 'a' }];
  assert.deepEqual(
    uiPrefs.trier(lignes, { key: 'inconnue', dir: 'asc' }, { n: (l) => l.n }).map((l) => l.n),
    ['b', 'a']
  );
});

// ---------------------------------------------------------------------------
// La bascule de sens
// ---------------------------------------------------------------------------

test('recliquer la même colonne inverse le sens ; une autre part au naturel', () => {
  let tri = { key: 'name', dir: 'asc' };

  tri = uiPrefs.basculer(tri, 'name');
  assert.deepEqual(tri, { key: 'name', dir: 'desc' });
  tri = uiPrefs.basculer(tri, 'name');
  assert.deepEqual(tri, { key: 'name', dir: 'asc' });

  // Une date part décroissante : « le plus récent d'abord » est ce qu'on
  // cherche neuf fois sur dix.
  assert.deepEqual(uiPrefs.basculer(tri, 'date', 'desc'), { key: 'date', dir: 'desc' });
  assert.deepEqual(uiPrefs.basculer(tri, 'nom', 'asc'), { key: 'nom', dir: 'asc' });
});

test('l\'en-tête dit le sens, et reste utilisable au clavier', () => {
  const actif = uiPrefs.enTeteTriable({
    tri: { key: 'date', dir: 'desc' },
    key: 'date',
    label: 'Date',
    onclick: 'sortLogs()',
  });
  assert.match(actif, /aria-sort="descending"/);
  assert.match(actif, /class="th-sort active"/);
  assert.match(actif, /tabindex="0"/);
  assert.match(actif, /event\.key==='Enter'/);

  const inactif = uiPrefs.enTeteTriable({
    tri: { key: 'date', dir: 'desc' },
    key: 'nom',
    label: 'Nom',
    onclick: 'x()',
  });
  assert.match(inactif, /aria-sort="none"/);
});

// ---------------------------------------------------------------------------
// Lecture et écriture de la valeur mémorisée
// ---------------------------------------------------------------------------

test('« clé:sens » se relit, et une valeur abîmée retombe sur le défaut', () => {
  const defaut = { key: 'name', dir: 'asc' };
  assert.deepEqual(uiPrefs.lireTri('date:desc', defaut), { key: 'date', dir: 'desc' });
  assert.deepEqual(uiPrefs.lireTri('', defaut), defaut);
  assert.deepEqual(uiPrefs.lireTri('date:vers-le-haut', defaut), defaut);
  assert.deepEqual(uiPrefs.lireTri(null, defaut), defaut);

  assert.equal(uiPrefs.ecrireTri({ key: 'date', dir: 'desc' }), 'date:desc');
  assert.equal(uiPrefs.ecrireTri(null), '');
});

// ---------------------------------------------------------------------------
// Mémorisation par compte, côté serveur
// ---------------------------------------------------------------------------

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

test('chaque écran a sa préférence d\'affichage, et les cartes par défaut', async () => {
  const user = await helpers.createUser({ username: 'prefs' });

  // Six écrans de plus au lot 10, plus les deux qui existaient déjà.
  for (const ecran of [
    'apps', 'logos', 'cron', 'roles', 'users', 'support',
    'profil-connecteurs', 'profil-permissions',
  ]) {
    assert.ok(preferences.isKnown(`view.${ecran}`), `view.${ecran} doit exister`);
    assert.equal(preferences.get(user.id, `view.${ecran}`), 'cards', 'les cartes par défaut');
  }
});

test('le tri est mémorisé PAR ÉCRAN et par compte', async () => {
  const un = await helpers.createUser({ username: 'trieur-un' });
  const deux = await helpers.createUser({ username: 'trieur-deux' });

  preferences.set(un.id, 'sort.users', 'lastLogin:desc');
  preferences.set(un.id, 'sort.logos', 'bytes:asc');

  // Deux écrans, deux tris : l'un ne déteint pas sur l'autre.
  assert.equal(preferences.get(un.id, 'sort.users'), 'lastLogin:desc');
  assert.equal(preferences.get(un.id, 'sort.logos'), 'bytes:asc');
  assert.equal(preferences.get(un.id, 'sort.documents'), '', 'les autres gardent leur défaut');

  // Et deux comptes, deux mémoires : c'est tout l'intérêt de ne pas passer par
  // localStorage.
  assert.equal(preferences.get(deux.id, 'sort.users'), '');
});

test('une préférence abîmée ne casse pas un écran', async () => {
  const user = await helpers.createUser({ username: 'abime' });

  // Un mode d'affichage inconnu retombe sur les cartes.
  assert.equal(preferences.set(user.id, 'view.users', 'mosaique'), 'cards');
  assert.equal(preferences.get(user.id, 'view.users'), 'cards');

  // Un tri malformé est refusé, et l'écran reprend son défaut.
  assert.equal(preferences.set(user.id, 'sort.users', 'nom;DROP TABLE'), '');
  assert.equal(preferences.set(user.id, 'sort.users', 'nom:vers-le-haut'), '');
  assert.equal(preferences.set(user.id, 'sort.users', 'lastLogin:desc'), 'lastLogin:desc');

  // Une valeur écrite directement en base, hors de tout contrôle.
  helpers.db
    .get()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value) VALUES (?, 'view.logos', '"n''importe quoi"')
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    )
    .run(user.id);
  assert.equal(preferences.get(user.id, 'view.logos'), 'cards');
});

test('une clé inconnue reste refusée : la table n\'est pas une décharge', async () => {
  const user = await helpers.createUser({ username: 'decharge' });
  assert.throws(() => preferences.set(user.id, 'view.nimporte', 'cards'), /inconnue/);
  assert.throws(() => preferences.set(user.id, 'sort.nimporte', 'a:asc'), /inconnue/);
});

// ---------------------------------------------------------------------------
// Lot 12 — deux préférences de plus, et leurs bornes
// ---------------------------------------------------------------------------

test('« Mes documents » : les comptes repliés sont mémorisés, par compte', async () => {
  const un = await helpers.createUser({ username: 'replieur-un' });
  const deux = await helpers.createUser({ username: 'replieur-deux' });

  // On mémorise ce qui est FERMÉ, pas ce qui est ouvert : un connecteur
  // installé demain arrive donc déplié, sans que personne ait à le chercher.
  assert.deepEqual(preferences.get(un.id, 'documents.collapsed'), []);

  preferences.set(un.id, 'documents.collapsed', ['free/fbx22222222', 'amazon/compte']);
  assert.deepEqual(preferences.get(un.id, 'documents.collapsed'), [
    'free/fbx22222222',
    'amazon/compte',
  ]);
  assert.deepEqual(preferences.get(deux.id, 'documents.collapsed'), [], 'et pas chez le voisin');
});

test('la liste des comptes repliés est bornée, dédoublonnée et nettoyée', async () => {
  const user = await helpers.createUser({ username: 'borne' });

  // Une préférence est une commodité, pas un entrepôt : un appel bricolé ne
  // doit pas faire enfler la table indéfiniment.
  const enorme = Array.from({ length: preferences.COLLAPSED_MAX + 50 }, (_, i) => `c/${i}`);
  assert.equal(preferences.set(user.id, 'documents.collapsed', enorme).length,
    preferences.COLLAPSED_MAX);

  assert.deepEqual(
    preferences.set(user.id, 'documents.collapsed', ['a/b', 'a/b', 'c/d']),
    ['a/b', 'c/d'],
    'dédoublonné'
  );

  assert.deepEqual(
    preferences.set(user.id, 'documents.collapsed', ['ok/ok', 42, null, {}, '', 'x'.repeat(999)]),
    ['ok/ok'],
    'ce qui n\'est pas une chaîne raisonnable est écarté'
  );

  // Et une valeur d'un autre type ne casse pas l'écran.
  assert.deepEqual(preferences.set(user.id, 'documents.collapsed', 'pas un tableau'), []);
});

test('le filtre du gestionnaire de logos ne retient que ses trois états', async () => {
  const user = await helpers.createUser({ username: 'filtreur' });

  assert.equal(preferences.get(user.id, 'logos.filter'), 'tous');
  assert.equal(preferences.set(user.id, 'logos.filter', 'sans'), 'sans');
  assert.equal(preferences.set(user.id, 'logos.filter', 'avec'), 'avec');
  assert.equal(preferences.set(user.id, 'logos.filter', 'les-jolis'), 'tous',
    'un état inconnu retombe sur « tous »');
});

test('les défauts ne sont pas partagés : un appelant ne peut pas les abîmer', async () => {
  const user = await helpers.createUser({ username: 'defauts' });

  const toutes = preferences.all(user.id);
  toutes['documents.collapsed'].push('injecté');

  assert.deepEqual(preferences.KEYS['documents.collapsed'], [], 'le défaut du module est intact');
  assert.deepEqual(preferences.all(user.id)['documents.collapsed'], []);
});
