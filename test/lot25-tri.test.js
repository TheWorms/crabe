'use strict';

/**
 * Lot 25, phase C — le tri au choix sur les listes de services.
 *
 * ─── Ce que ce fichier protège ───────────────────────────────────────────────
 *
 * 1. **Chaque ordre proposé fonctionne réellement.** Un menu qui propose quatre
 *    classements dont deux ne changent rien est pire qu'un menu absent : on
 *    croit avoir réglé quelque chose.
 *
 * 2. **Une valeur hors liste est refusée CÔTÉ SERVEUR.** Le menu déroulant ne
 *    protège de rien — il suffit d'une requête écrite à la main. C'est la
 *    leçon du lot 18 sur la pagination, appliquée telle quelle.
 *
 * 3. **Le serveur et l'écran classent PAREIL.** La règle vit aux deux endroits
 *    parce qu'il le faut — le serveur trie ce qu'il envoie, l'écran retrie
 *    quand on change le menu sans recharger. Deux règles qui divergeraient
 *    donneraient deux ordres différents sur le même bloc selon le chemin
 *    emprunté (leçon du lot 24 sur l'ordre alphabétique).
 *
 * 4. **Le défaut ne bouge pas.** L'ordre alphabétique posé au lot 24 reste le
 *    défaut : un accueil ne change pas d'aspect parce que crabe a été mis à
 *    jour.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tri = require('../server/connectors/tri');
const preferences = require('../server/preferences');

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'trieur', plainPassword: 'MotDePasse1' });
});

test.after(() => helpers.teardown());

/**
 * Un jeu de services fait exprès pour que les quatre ordres donnent quatre
 * résultats DIFFÉRENTS. Sans ça, un test passerait sur un tri qui ne fait rien.
 */
const SERVICES = [
  { name: 'Zeta', installedAt: '2026-01-01 10:00:00', lastRunAt: '2026-08-13 12:00:00', documentCount: 3 },
  { name: 'École', installedAt: '2026-08-01 10:00:00', lastRunAt: '2026-08-01 09:00:00', documentCount: 42 },
  { name: 'Alpha', installedAt: '2026-05-01 10:00:00', lastRunAt: null, documentCount: 7 },
];

// ---------------------------------------------------------------------------
// 1. Chaque ordre fait ce qu'il annonce
// ---------------------------------------------------------------------------

test('les quatre ordres donnent quatre classements distincts', () => {
  const noms = (ordre) => tri.parOrdre(SERVICES, ordre).map((s) => s.name);

  // ⚠ « École » avant « Zeta » : une comparaison brute rangerait tous les
  // accentués après Z (`'École' < 'Edf'` est faux en JavaScript).
  assert.deepEqual(noms('nom'), ['Alpha', 'École', 'Zeta']);
  assert.deepEqual(noms('ajout'), ['École', 'Alpha', 'Zeta'], 'le plus récemment ajouté d\'abord');
  assert.deepEqual(noms('synchro'), ['Zeta', 'École', 'Alpha'], 'la synchro la plus fraîche d\'abord');
  assert.deepEqual(noms('documents'), ['École', 'Alpha', 'Zeta'], 'le plus fourni d\'abord');
});

test('« jamais synchronisé » part à la fin, pas en tête', () => {
  // Une date absente n'est PAS une date très ancienne : la faire remonter en
  // tête d'un tri par fraîcheur serait faux, et la faire passer devant un
  // service qui a réellement tourné hier serait absurde.
  assert.equal(tri.parOrdre(SERVICES, 'synchro').at(-1).name, 'Alpha');
});

test('le nom départage toujours les ex æquo', () => {
  // Sans ce départage, deux services installés la même seconde — ce qui arrive
  // à l'installation — ou vingt services à zéro document changeraient de place
  // à chaque rafraîchissement, sans que rien ne l'explique.
  const memeInstant = [
    { name: 'Zeta', installedAt: '2026-08-01 10:00:00', documentCount: 0 },
    { name: 'Alpha', installedAt: '2026-08-01 10:00:00', documentCount: 0 },
    { name: 'Mu', installedAt: '2026-08-01 10:00:00', documentCount: 0 },
  ];
  for (const ordre of tri.ORDRE_IDS) {
    assert.deepEqual(
      tri.parOrdre(memeInstant, ordre).map((s) => s.name),
      ['Alpha', 'Mu', 'Zeta'],
      `ordre « ${ordre} » : le classement doit être stable`
    );
  }
});

test('trier ne modifie pas la liste reçue', () => {
  const source = [...SERVICES];
  tri.parOrdre(source, 'documents');
  assert.deepEqual(source.map((s) => s.name), SERVICES.map((s) => s.name));
});

test('un ordre inconnu retombe sur l\'alphabétique, il ne fait pas tomber l\'écran', () => {
  // Cette fonction est appelée pour DESSINER : un écran vide serait une réponse
  // bien pire qu'un écran rangé autrement que demandé. Le refus se fait à
  // l'enregistrement de la préférence, pas ici.
  assert.deepEqual(tri.parOrdre(SERVICES, 'nawak').map((s) => s.name), ['Alpha', 'École', 'Zeta']);
  assert.deepEqual(tri.parOrdre(SERVICES, undefined).map((s) => s.name), ['Alpha', 'École', 'Zeta']);
});

// ---------------------------------------------------------------------------
// 2. Le refus vient du serveur, pas du menu déroulant
// ---------------------------------------------------------------------------

test('une valeur hors liste est refusée, et le refus dit quoi choisir', () => {
  for (const cle of ['home.connecteurs.tri', 'home.sync.tri']) {
    const refus = preferences.refus(cle, 'par-couleur');
    assert.ok(refus, `${cle} : une valeur inventée doit être refusée`);
    assert.match(refus, /par-couleur/, 'le refus nomme la valeur rejetée');
    assert.match(refus, /alphabétique/i, 'et il dit ce qui est possible');

    // Les quatre valeurs annoncées, elles, passent toutes.
    for (const ordre of tri.ORDRE_IDS) {
      assert.equal(preferences.refus(cle, ordre), null, `${cle} = ${ordre}`);
    }
  }
});

test('le refus est appliqué par la ROUTE, pas seulement par la fonction', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'trieur', 'MotDePasse1');

  const refuse = await client.put('/api/users/me/preferences', {
    preferences: { 'home.sync.tri': 'par-couleur' },
  });
  assert.equal(refuse.status, 400, 'une requête écrite à la main est refusée');
  assert.match(refuse.body.error, /par-couleur/);

  // Et la valeur d'avant n'a pas bougé : un refus ne range rien en douce.
  assert.equal(preferences.get(compte.id, 'home.sync.tri'), 'nom');

  const accepte = await client.put('/api/users/me/preferences', {
    preferences: { 'home.sync.tri': 'synchro' },
  });
  assert.equal(accepte.status, 200);
  assert.equal(preferences.get(compte.id, 'home.sync.tri'), 'synchro');
});

test('les deux blocs ont chacun leur ordre, et ne se déréglent pas l\'un l\'autre', () => {
  preferences.set(compte.id, 'home.connecteurs.tri', 'nom');
  preferences.set(compte.id, 'home.sync.tri', 'synchro');

  assert.equal(preferences.get(compte.id, 'home.connecteurs.tri'), 'nom');
  assert.equal(preferences.get(compte.id, 'home.sync.tri'), 'synchro');

  preferences.set(compte.id, 'home.connecteurs.tri', 'documents');
  assert.equal(
    preferences.get(compte.id, 'home.sync.tri'),
    'synchro',
    'régler un bloc ne doit pas dérégler l\'autre'
  );
});

test('le défaut reste l\'ordre alphabétique posé au lot 24', () => {
  const neuf = 999999; // un compte qui n'a jamais ouvert ce menu
  assert.equal(preferences.get(neuf, 'home.connecteurs.tri'), 'nom');
  assert.equal(preferences.get(neuf, 'home.sync.tri'), 'nom');
  assert.equal(tri.ORDRE_PAR_DEFAUT, 'nom');
});

// ---------------------------------------------------------------------------
// 3. Le serveur et l'écran classent pareil
// ---------------------------------------------------------------------------

test('la règle de l\'écran donne exactement le même ordre que celle du serveur', () => {
  // Le VRAI web/fmt.js et le VRAI web/app.js, chargés dans un contexte isolé :
  // c'est le code livré qu'on compare, pas une réécriture de ce qu'il devrait
  // faire.
  // `Intl` est indispensable : c'est `localeCompare` qui range É avec E.
  const contexte = vm.createContext({ console, Date, Number, String, Array, Math, JSON, Intl });
  for (const fichier of ['fmt.js', 'app.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'web', fichier), 'utf8');
    // app.js appelle des API de navigateur au chargement : on ne garde que ce
    // dont ce test a besoin, la fonction de classement et ses dépendances.
    if (fichier === 'app.js') {
      const debut = source.indexOf('function trierServices(');
      const fin = source.indexOf('\nfunction widgetConnectors(');
      vm.runInContext(source.slice(debut, fin), contexte);
    } else {
      vm.runInContext(source, contexte);
    }
  }

  contexte.services = SERVICES;
  for (const ordre of tri.ORDRE_IDS) {
    // ⚠ Le résultat revient en CHAÎNE et non en tableau : un tableau fabriqué
    // dans l'autre contexte n'a pas le même prototype, et `deepStrictEqual` le
    // refuse alors que son contenu est identique — deux listes visiblement
    // égales, un test rouge, et une demi-heure à chercher une divergence qui
    // n'existe pas.
    const cote = vm.runInContext(
      `trierServices(services, ${JSON.stringify(ordre)}).map((s) => s.name).join('|')`,
      contexte
    );
    assert.equal(
      cote,
      tri.parOrdre(SERVICES, ordre).map((s) => s.name).join('|'),
      `ordre « ${ordre} » : serveur et écran doivent classer pareil`
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Le recensement : où le menu est posé, et où il ne l'est pas
// ---------------------------------------------------------------------------

test('le menu n\'est posé que sur les deux blocs qui en ont besoin', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const appels = app.match(/triSelect\('[^']+'/g) || [];
  assert.deepEqual(
    appels.sort(),
    ["triSelect('connecteurs'", "triSelect('sync'"],
    'le Store, « Mes documents », Applications, Logos et Stockage n\'en reçoivent pas — '
      + 'les trois écrans du milieu ont déjà un tri par en-tête de colonne, et les deux '
      + 'autres n\'ont qu\'un ordre sensé'
  );
});

test('la liste des ordres descend du serveur, elle n\'est pas écrite dans l\'écran', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  // Le menu est nourri par ce que le serveur envoie, qui est aussi ce que le
  // serveur accepte : il ne peut donc pas proposer une valeur que
  // l'enregistrement rejetterait.
  assert.match(app, /home\.data\.trisCatalog/);

  // Aucun libellé d'ordre écrit en dur DANS le sélecteur. Le contrôle porte
  // sur cette fonction et pas sur le fichier entier : « Dernière
  // synchronisation » est aussi, ailleurs, l'intitulé d'une ligne de la page
  // Stockage, et l'interdire partout ferait un test qui punit une homonymie.
  const selecteur = app.slice(app.indexOf('function triSelect('), app.indexOf('function changerTri('));
  for (const ordre of tri.ORDRES) {
    assert.equal(
      selecteur.includes(ordre.label),
      false,
      `« ${ordre.label} » ne doit pas être écrit en dur dans le sélecteur`
    );
  }
});
