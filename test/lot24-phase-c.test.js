'use strict';

/**
 * Lot 24, phase C — les listes de services, dans l'ordre où on les cherche.
 *
 * ─── Ce que ces tests protègent ──────────────────────────────────────────────
 *
 * 1. **L'ordre des dossiers n'est pas l'ordre des noms.** `registry.load()`
 *    parcourt le disque : la liste sortait donc classée par nom de DOSSIER,
 *    qui est technique. « L'Île aux Épices » vit dans `ile-aux-epices` et se
 *    retrouvait entre Hetzner et Impots.gouv.fr.
 *
 * 2. **Une comparaison de chaînes ne suffit pas.** En JavaScript,
 *    `'École' < 'Edf'` est FAUX : la comparaison brute porte sur les points de
 *    code, et tous les noms accentués partiraient après Z.
 *
 * 3. **Le tri est le MÊME au serveur et à l'écran.** Le serveur trie ce qu'il
 *    envoie, l'écran retrie ce qu'il filtre : deux règles différentes
 *    donneraient deux ordres différents sur le même écran selon qu'on a tapé
 *    une recherche ou non.
 *
 * 4. **Ce qui est chronologique le reste.** Un journal rangé par ordre
 *    alphabétique n'est plus un journal.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tri = require('../server/connectors/tri');
const registry = require('../server/connectors/registry');
const documents = require('../server/documents');

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'trieur', plainPassword: 'MotDePasse1' });
});

// ---------------------------------------------------------------------------
// 1. La règle de comparaison
// ---------------------------------------------------------------------------

test('les accents se rangent avec leur lettre, pas après Z', () => {
  // Le contrôle qui donne son sens à tout le reste : la comparaison BRUTE se
  // trompe, et c'est pour ça qu'on ne s'en sert pas.
  assert.equal('École' < 'Edf', false, 'la comparaison brute range É après Z');
  assert.ok(tri.comparerNoms('École', 'Edf') < 0, 'la nôtre le range avec les E');

  const noms = ['Zoho', 'École', 'Edf', 'Émile', 'Amazon', 'Île de beauté'];
  assert.deepEqual(
    [...noms].sort(tri.comparerNoms),
    ['Amazon', 'École', 'Edf', 'Émile', 'Île de beauté', 'Zoho']
  );
});

test('la casse ne départage pas', () => {
  assert.equal(tri.comparerNoms('École', 'école'), 0);
  assert.equal(tri.comparerNoms('PCLOUD', 'pCloud'), 0);
  // Et deux services qui ne diffèrent que par la casse ne changent donc plus
  // de place selon celui qui a été écrit en premier.
  assert.deepEqual(['pCloud', 'Orange', 'PROTON'].sort(tri.comparerNoms),
    ['Orange', 'pCloud', 'PROTON']);
});

test('les nombres se comparent comme des nombres', () => {
  assert.deepEqual(
    ['Free 10', 'Free 2', 'Free 1'].sort(tri.comparerNoms),
    ['Free 1', 'Free 2', 'Free 10']
  );
});

test('un nom absent part à la fin, pas en tête', () => {
  // Une entrée sans nom est une anomalie : elle n'a pas à ouvrir la liste.
  assert.deepEqual(
    tri.parNom([{ name: 'B' }, { name: '' }, { name: 'A' }, {}]).map((x) => x.name),
    ['A', 'B', '', undefined]
  );
});

test('le tri rend une copie et ne touche pas à la liste d\'origine', () => {
  const source = [{ name: 'B' }, { name: 'A' }];
  const trie = tri.parNom(source);
  assert.deepEqual(source.map((x) => x.name), ['B', 'A'], 'l\'original est intact');
  assert.deepEqual(trie.map((x) => x.name), ['A', 'B']);
});

// ---------------------------------------------------------------------------
// 2. Le serveur et l'écran appliquent LA MÊME règle
// ---------------------------------------------------------------------------

test('la règle de l\'écran est la jumelle de celle du serveur', () => {
  // `web/fmt.js` est chargé tel quel dans un contexte isolé : ce qui est
  // vérifié ici est le VRAI code servi au navigateur, pas une copie.
  const contexte = { document: { querySelectorAll: () => [] } };
  vm.createContext(contexte);
  vm.runInContext(fs.readFileSync('web/fmt.js', 'utf8'), contexte);

  const noms = ['Zoho', 'École', 'Edf', 'Free 10', 'Free 2', 'pCloud', 'PROTON', 'Amazon'];
  // Comparé en JSON : un tableau fabriqué dans un contexte `vm` n'est pas le
  // même objet Array que celui d'ici, et `deepStrictEqual` s'en aperçoit. Ce
  // qu'on veut vérifier est l'ORDRE, pas la parenté des objets.
  assert.equal(
    JSON.stringify([...noms].sort(contexte.comparerNoms)),
    JSON.stringify([...noms].sort(tri.comparerNoms)),
    'serveur et écran doivent rendre exactement le même ordre'
  );
  assert.equal(
    JSON.stringify(contexte.trierParNom([{ name: 'B' }, { name: 'A' }]).map((x) => x.name)),
    JSON.stringify(['A', 'B'])
  );
});

// ---------------------------------------------------------------------------
// 3. Les listes réelles, une par une
// ---------------------------------------------------------------------------

/** Une liste est-elle triée par nom affiché ? */
function estTriee(items, nomDe = (x) => x.name) {
  const noms = items.map(nomDe);
  return JSON.stringify(noms) === JSON.stringify([...noms].sort(tri.comparerNoms));
}

test('le catalogue complet sort trié — et tout le reste en découle', () => {
  const tous = registry.listAll();
  assert.ok(tous.length > 10, `${tous.length} services chargés`);
  assert.ok(estTriee(tous), `ordre obtenu : ${tous.map((c) => c.name).slice(0, 8).join(' · ')}`);

  // Ce qui, sans ce tri, se rangeait par nom de dossier : la preuve que le
  // classement porte bien sur le nom AFFICHÉ.
  const noms = tous.map((c) => c.name);
  const ile = noms.findIndex((n) => n.includes('Île aux Épices'));
  const impots = noms.findIndex((n) => n.startsWith('Impots'));
  if (ile >= 0 && impots >= 0) {
    assert.ok(ile > impots, '« L\'Île aux Épices » se range à L, pas au dossier ile-aux-epices');
  }
});

test('les listes dérivées héritent du tri, sans le refaire', () => {
  assert.ok(estTriee(registry.listAvailable()), 'services installables');
  assert.ok(estTriee(registry.listPlanned()), 'services annoncés');
  assert.ok(estTriee(registry.listForUser(compte)), 'catalogue de l\'utilisateur');
});

test('les sujets du gestionnaire de logos suivent le même ordre', () => {
  const logos = require('../server/connectors/logos');
  const sujets = logos.sujets();
  // Deux groupes distincts à l'écran — les applications, puis les destinations
  // — et chacun trié. Les mêler serait plus long à parcourir, c'est le choix
  // fait au lot 9 et il est conservé.
  assert.ok(estTriee(sujets.filter((s) => s.kind === 'connector')), 'applications');
});

test('« Mes documents » range ses services, ses comptes et son filtre', () => {
  // Des documents fabriqués exprès dans le DÉSORDRE, et avec des noms que
  // l'ordre des dossiers rangerait autrement : « L'Île aux Épices » vit dans
  // `ile-aux-epices`, « L'Atelier du Portable » dans `atelier-du-portable`.
  const docs = [
    { connectorId: 'zoho', connectorName: 'Zoho', accountId: 'b', period: '2026-01' },
    { connectorId: 'ile', connectorName: "L'Île aux Épices", accountId: 'z', period: '2026-02' },
    { connectorId: 'edf', connectorName: 'Edf', accountId: 'a', period: '2026-03' },
    { connectorId: 'ile', connectorName: "L'Île aux Épices", accountId: 'a', period: '2026-01' },
    { connectorId: 'ecole', connectorName: 'École du village', accountId: 'a', period: '2026-01' },
  ].map((d, i) => ({ ...d, id: i + 1, filename: `f${i}.pdf`, accountLabel: d.accountId }));

  const arbre = documents.toTree(docs);
  assert.deepEqual(
    arbre.map((b) => b.connectorName),
    ['École du village', 'Edf', "L'Île aux Épices", 'Zoho'],
    // « École » avant « Edf » : É vaut E, puis c vient avant d. C'est bien le
    // classement d'un dictionnaire français, et c'est là qu'on va le chercher.
    'les services sont rangés par nom affiché, accents compris'
  );
  const epices = arbre.find((b) => b.connectorName === "L'Île aux Épices");
  assert.deepEqual(epices.accounts.map((c) => c.label), ['a', 'z'], 'les comptes aussi');

  // Le filtre par service de cet écran : même règle, même ordre.
  assert.deepEqual(
    documents.filterOptions(docs).connectors.map((c) => c.name),
    ['École du village', 'Edf', "L'Île aux Épices", 'Zoho']
  );
  // Les périodes, elles, restent du plus récent au plus ancien : c'est une
  // question de temps, pas une liste de services.
  assert.deepEqual(documents.filterOptions(docs).periods, ['2026-03', '2026-02', '2026-01']);
});

// ---------------------------------------------------------------------------
// 4. Ce qui NE doit pas être trié
// ---------------------------------------------------------------------------

test('les blocs chronologiques de l\'accueil restent chronologiques', () => {
  const home = require('../server/home');
  // « Derniers documents » et « Erreurs et alertes » répondent à une question
  // de temps — « qu'est-ce qui vient d'arriver ? ». Les ranger par ordre
  // alphabétique les viderait de leur sens.
  const source = fs.readFileSync('server/home.js', 'utf8');
  assert.match(source, /recentDocuments[\s\S]{0,900}ORDER BY fetched_at DESC/);
  assert.match(source, /recentErrors[\s\S]{0,900}ORDER BY r\.started_at DESC/);
  assert.equal(typeof home.syncRows, 'function');
});

test('les graphiques gardent leur classement par grandeur', () => {
  // « Espace occupé par service » et « Répartition par service » se lisent du
  // plus grand au plus petit : c'est ce qu'on vient y chercher, et c'est un
  // ordre volontaire qu'il ne fallait pas écraser.
  const source = fs.readFileSync('server/home.js', 'utf8');
  assert.match(source, /stockageParConnecteur[\s\S]{0,900}ORDER BY bytes DESC/);
  assert.match(source, /facturesParConnecteur[\s\S]{0,900}ORDER BY n DESC/);
});

test('le journal des exécutions reste antichronologique, son filtre non', () => {
  const source = fs.readFileSync('server/routes/logs.js', 'utf8');
  // Le filtre est une liste de SERVICES : alphabétique.
  assert.match(source, /tri\.comparerNoms\(a\.name, b\.name\)/);
  // Ce qu'il filtre est un JOURNAL : du plus récent au plus ancien.
  assert.match(source, /ORDER BY r\.started_at DESC, r\.id DESC/);
});
