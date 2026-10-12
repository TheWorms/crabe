'use strict';

/**
 * Lot 103 — la page publique des connecteurs, `docs/CONNECTEURS.md`, reclassée.
 *
 * Elle est générée d'après les manifestes et un classement décidé le
 * 11/10/2026. Ce fichier verrouille ce que le lot en a fait :
 *
 *   1. le chapeau annonce cinq groupes et définit « En cours » et « Non
 *      faisables » ; les trois autres définitions n'ont pas bougé ; la ligne
 *      d'état dit la version, la même dans ses quatre emplacements ;
 *   2. les groupes, dans l'ordre — Fonctionnels, En cours, En attente, Non
 *      faisables, Proposés —, leurs comptes (2, 12, 8, 20) et leurs membres ;
 *      88 services en tout ;
 *   3. chaque raison : « Pourquoi il attend » pour chaque connecteur en
 *      attente (« Écrit, mais aucun compte n'a encore pu être essayé. » pour
 *      les sept qui y entrent), « Pourquoi ce n'est pas faisable » = la phrase
 *      `unfeasible` de l'annonce, mot pour mot ; plus aucun « Pas possible
 *      aujourd'hui » parmi les proposés ;
 *   4. BetterMe n'existe plus : ni sur la page, ni parmi les annonces, ni dans
 *      la table du générateur d'annonces, ni parmi les icônes.
 *
 * Un changement de classement fait tomber cet essai : c'est voulu — il se
 * modifie par décision, comme la page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RACINE = path.join(__dirname, '..');
const PAGE = path.join(RACINE, 'docs', 'CONNECTEURS.md');
const ANNONCES = path.join(RACINE, 'server', 'connectors', 'planned');

const GROUPES = ['Fonctionnels', 'En cours', 'En attente', 'Non faisables', 'Proposés'];
// Lot 104 : Alma, Battle.net et Private Sport Shop rejoignent les deux du lot 103.
// Lot 105 : Private Sport Shop (trois documents en production) et l'Eau
// d'Île-de-France (décision du compte observé) quittent « En cours » pour « Fonctionnels ».
const EN_COURS = ['alma', 'battle-net', 'paybyphone'];
/** Les sept connecteurs que personne n'a encore pu essayer, passés « en attente » au lot 103. */
const SANS_COMPTE = ['bouygues', 'engie', 'orange', 'qobuz', 'scaleway', 'sfr', 'vinted'];
// Lot 106, par décision du 12/10/2026 : ces sept, EDF, Mint Énergie
// et SEPIG passent « Non faisables » (`unfeasible` dans leur manifeste).
// Restent en attente : Atlantic'eau et Electro Dépôt.
const ECRITS_NON_FAISABLES = ['edf', 'mint-energie', 'sepig', ...SANS_COMPTE];
const EN_ATTENTE = ['atlanticeau', 'electro-depot'];
const NON_FAISABLES = [
  'caisse-epargne', 'credit-agricole', 'credit-mutuel', 'fdj', 'flexiroam', 'google-play', 'hello-bank',
  'samsung-plus', ...ECRITS_NON_FAISABLES,
];
const DISPONIBLES = path.join(RACINE, 'server', 'connectors', 'available');
const RAISON_SANS_COMPTE = 'Écrit, mais aucun compte n\'a encore pu être essayé.';

/** Un texte sur une ligne : la page est écrite en lignes de 80 colonnes, le Markdown les rejoint. */
const aplati = (texte) => texte.replace(/\s+/g, ' ').trim();

/** Le manifeste d'une annonce livrée — ou, depuis le lot 106, d'un connecteur écrit. */
const annonce = (id) => JSON.parse(fs.readFileSync(path.join(
  fs.existsSync(path.join(ANNONCES, id, 'manifest.json')) ? ANNONCES : DISPONIBLES, id, 'manifest.json'
), 'utf8'));

function annoncesDuDisque() {
  return fs.readdirSync(ANNONCES).filter((id) => fs.existsSync(path.join(ANNONCES, id, 'manifest.json')));
}

/**
 * La page : son chapeau (tout ce qui précède le premier groupe) et ses groupes
 * — titre, compte annoncé, et chaque ligne du tableau découpée en cellules.
 */
function lireLaPage() {
  const texte = fs.readFileSync(PAGE, 'utf8');
  const sections = [];
  let courante = null;
  let entetes = null;
  for (const ligne of texte.split('\n')) {
    const titre = /^## (.+) \((\d+)\)$/.exec(ligne);
    if (titre) {
      courante = { nom: titre[1], annonce: Number(titre[2]), entete: null, lignes: [] };
      sections.push(courante);
      continue;
    }
    if (/^## /.test(ligne)) courante = null;
    if (!courante || !/^\|/.test(ligne)) continue;
    // Les cellules, sans les barres de bord ; une barre échappée (« \| ») n'en sépare pas.
    const cellules = ligne.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (/^\| \| Service \|/.test(ligne)) entetes = cellules;
    if (entetes && !courante.entete) courante.entete = entetes;
    const id = /<img src="icones\/([a-z0-9-]+)\.png"/.exec(cellules[0] || '')?.[1];
    if (id) courante.lignes.push({ id, nom: cellules[1], cellules: cellules.slice(2) });
  }
  return { texte, chapeau: texte.split(/^## /m)[0], sections };
}

const groupe = (sections, nom) => sections.find((s) => s.nom === nom);

test('R1 — le chapeau annonce cinq groupes et les définit, dans l\'ordre de la page', () => {
  const chapeau = aplati(lireLaPage().chapeau);
  assert.match(chapeau, /où en est chacun, en cinq groupes :/);
  const definitions = [
    '- **Fonctionnels** : ils ont déjà récupéré des documents sur un vrai compte.',
    '- **En cours** : écrits, en cours d\'essai sur un vrai compte. Ils peuvent marcher du premier coup, '
      + 'ou demander une correction : dites ce qui se passe.',
    '- **En attente** : écrits, mais arrêtés par quelque chose qui ne dépend pas de crabe. La raison est '
      + 'dite pour chacun.',
    // Lot 106, par décision : un connecteur écrit non faisable revient dans
    // SON groupe, pas parmi les proposés.
    '- **Non faisables** : le service ne laisse aucune voie à crabe aujourd\'hui. La raison est dite pour '
      + 'chacun ; si elle disparaît, le service revient dans son groupe.',
    '- **Proposés** : annoncés dans crabe, pas encore écrits. Rien n\'est promis : un service annoncé peut '
      + 's\'avérer impossible à atteindre.',
  ];
  let depuis = 0;
  for (const definition of definitions) {
    const ou = chapeau.indexOf(definition, depuis);
    assert.ok(ou >= 0, `définition absente ou hors de son rang : « ${definition} »`);
    depuis = ou + definition.length;
  }
  assert.equal((chapeau.match(/^- \*\*|\s- \*\*/g) || []).length, 5, 'cinq définitions, pas une de plus');
});

test('R7 — la ligne d\'état dit la version, la même dans ses quatre emplacements', () => {
  const version = fs.readFileSync(path.join(RACINE, 'VERSION'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const paquet = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
  const verrou = JSON.parse(fs.readFileSync(path.join(RACINE, 'package-lock.json'), 'utf8'));
  assert.equal(paquet.version, version, 'package.json');
  assert.equal(verrou.version, version, 'package-lock.json, en tête');
  assert.equal(verrou.packages[''].version, version, 'package-lock.json, le paquet racine');
  const etat = lireLaPage().texte.split('\n').filter((ligne) => ligne.startsWith('État au '));
  assert.equal(etat.length, 1);
  // Lot 105 : la date du classement suit la mesure du 12/10/2026.
  assert.ok(etat[0].startsWith(`État au 12 octobre 2026, version ${version}. `), etat[0]);
});

test('R2-R6 — cinq groupes dans l\'ordre ; 3 en cours (2 au lot 103, 5 au lot 104), 2 en attente (12 avant le lot 106), 18 non faisables (8 avant le lot 106), 17 proposés (20 au lot 103) ; 88 services', () => {
  const { sections } = lireLaPage();
  assert.deepEqual(sections.map((s) => s.nom), GROUPES);
  for (const s of sections) assert.equal(s.lignes.length, s.annonce, `${s.nom} : le compte du titre`);

  const ids = (nom) => groupe(sections, nom).lignes.map((l) => l.id);
  assert.deepEqual(ids('En cours').sort(), [...EN_COURS].sort());
  assert.deepEqual(ids('En attente').sort(), [...EN_ATTENTE].sort());
  assert.deepEqual(ids('Non faisables').sort(), [...NON_FAISABLES].sort());
  assert.deepEqual(
    [groupe(sections, 'En cours'), groupe(sections, 'En attente'), groupe(sections, 'Non faisables'),
      groupe(sections, 'Proposés')].map((s) => s.annonce),
    [3, 2, 18, 17]
  );
  assert.equal(sections.reduce((n, s) => n + s.annonce, 0), 88, '88 services sur la page');

  // Les non faisables sont EXACTEMENT les services qui portent un empêchement
  // — annonces, et connecteurs écrits depuis le lot 106 ; les proposés, les
  // autres annonces.
  const annonces = annoncesDuDisque();
  const empechees = annonces.filter((id) => String(annonce(id).unfeasible || '').trim());
  const ecritsEmpeches = fs.readdirSync(DISPONIBLES)
    .filter((id) => fs.existsSync(path.join(DISPONIBLES, id, 'manifest.json')))
    .filter((id) => String(annonce(id).unfeasible || '').trim());
  assert.deepEqual([...empechees, ...ecritsEmpeches].sort(), [...NON_FAISABLES].sort());
  assert.deepEqual(ids('Proposés').sort(), annonces.filter((id) => !empechees.includes(id)).sort());

  // Classés par ordre alphabétique, comme le reste de la page.
  for (const nom of ['En attente', 'Non faisables']) {
    const noms = groupe(sections, nom).lignes.map((l) => l.nom);
    assert.deepEqual(noms, [...noms].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })), nom);
  }
});

test('R3 — chaque connecteur en attente dit pourquoi ; les sept entrés au lot 103 : « Écrit, mais aucun compte n\'a encore pu être essayé. »', () => {
  const attente = groupe(lireLaPage().sections, 'En attente');
  assert.deepEqual(attente.entete, ['', 'Service', 'Ce qu\'il récupérera', 'Pourquoi il attend']);
  for (const ligne of attente.lignes) {
    assert.equal(ligne.cellules.length, 2, `${ligne.id} : deux colonnes après le nom`);
    const raison = ligne.cellules[1];
    if (SANS_COMPTE.includes(ligne.id)) {
      assert.equal(raison, RAISON_SANS_COMPTE, ligne.id);
    } else {
      assert.ok(raison.length > 30 && raison !== RAISON_SANS_COMPTE, `${ligne.id} : sa raison d'avant`);
    }
  }
});

test('R4 — chaque non faisable dit pourquoi : la phrase de son annonce, mot pour mot ; plus aucun « Pas possible aujourd\'hui » chez les proposés', () => {
  const { sections } = lireLaPage();
  const nonFaisables = groupe(sections, 'Non faisables');
  assert.deepEqual(nonFaisables.entete,
    ['', 'Service', 'Ce qu\'il récupérerait', 'Pourquoi ce n\'est pas faisable']);
  for (const ligne of nonFaisables.lignes) {
    const [recupererait, raison] = ligne.cellules;
    assert.equal(ligne.nom, annonce(ligne.id).name);
    assert.match(recupererait, /^Récupérerait /, `${ligne.id} : au conditionnel`);
    assert.doesNotMatch(recupererait, /Pas possible/, `${ligne.id} : la raison a sa colonne`);
    assert.equal(raison, annonce(ligne.id).unfeasible.trim(), `${ligne.id} : la phrase de l'annonce, telle quelle`);
  }
  const proposes = groupe(sections, 'Proposés');
  for (const ligne of proposes.lignes) {
    assert.doesNotMatch(ligne.cellules.join(' '), /Pas possible aujourd'hui/, ligne.id);
  }
  // La CAF garde son « À savoir » : une réserve, pas un empêchement.
  assert.match(proposes.lignes.find((l) => l.id === 'caf').cellules[0], /<br>\*\*À savoir\*\* : /);
});

test('R5 — BetterMe n\'existe plus : ni sur la page, ni parmi les annonces, ni dans la table du générateur, ni parmi les icônes', () => {
  assert.doesNotMatch(lireLaPage().texte, /betterme|better ?me/i, 'la page');
  assert.equal(fs.existsSync(path.join(ANNONCES, 'betterme')), false, 'le dossier de l\'annonce');
  assert.equal(fs.existsSync(path.join(RACINE, 'docs', 'icones', 'betterme.png')), false, 'son icône');
  // La table du générateur d'annonces : la relancer ne doit pas la recréer.
  // Lue sans l'exécuter — son `main()` réécrirait les annonces —, et on s'en
  // assure avant de charger quoi que ce soit.
  const brut = fs.readFileSync(path.join(RACINE, 'scripts', 'gen-planned.js'), 'utf8').replace(/^#!.*\n/, '');
  const source = brut.replace(/\nmain\(\);\s*$/, '\nmodule.exports = { SERVICES };\n');
  assert.notEqual(source, brut, 'le générateur ne finit plus par « main(); » : il serait exécuté');
  const module_ = { exports: {} };
  vm.runInThisContext(`(function (require, module, exports, __dirname) {${source}\n})`)(
    require, module_, module_.exports, path.join(RACINE, 'scripts')
  );
  assert.ok(module_.exports.SERVICES.length > 0, 'la table est lue');
  assert.equal(module_.exports.SERVICES.some((s) => s.id === 'betterme'), false, 'la table du générateur');
});
