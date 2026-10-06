'use strict';

/**
 * Lot 98 — la règle du dossier au nom d'un compte (`server/dossier-par-nom.js`).
 *
 * La fonction pure, seule à décider : le nom rendu sûr pour tous les
 * stockages, le suffixe entre homonymes (celui de « Mes documents », lot 96),
 * le dossier déjà employé gardé quand le nom change, l'identifiant comme avant
 * sans nom. Et le nom que Gandi en donne (`nomDuCompte`). Valeurs inventées :
 * identifiants faits de zéros, noms « Organisation d'essai … ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const dpn = require('../server/dossier-par-nom');
const documents = require('../server/documents');
const gandi = require('../server/connectors/available/gandi/connector');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const decider = (comptes, employes = new Map()) => dpn.dossiersDesComptes({ comptes, employes });
const employes = (entrees) => new Map(entrees.map(([cle, dossiers]) => [cle, new Map(Object.entries(dossiers))]));

// ---------------------------------------------------------------------------
// Le nom rendu sûr
// ---------------------------------------------------------------------------

test('le nom rendu sûr : ni /, ni \\, ni :, ni point final, ni espace au bord ; les accents restent', () => {
  assert.equal(dpn.nomDeDossier('Société / Essai : Sud.'), 'Société _ Essai _ Sud');
  assert.equal(dpn.nomDeDossier('Atelier\\Nord'), 'Atelier_Nord');
  assert.equal(dpn.nomDeDossier('  Été d\'essai   '), 'Été d\'essai');
  assert.equal(dpn.nomDeDossier('Point final...'), 'Point final');
  assert.equal(dpn.nomDeDossier('.cache'), 'cache', 'jamais de dossier caché');
  assert.equal(dpn.nomDeDossier('Crème brûlée & Cie'), 'Crème brûlée & Cie');
  for (const signe of ['*', '?', '"', '<', '>', '|']) {
    assert.equal(dpn.nomDeDossier(`A${signe}B`), 'A_B', `« ${signe} » refusé par un partage réseau`);
  }
});

test('le nom rendu sûr : aucun caractère de contrôle, aucune moitié de caractère, une seule forme Unicode', () => {
  assert.equal(dpn.nomDeDossier('Ligne\u0000un\ttab\nfin'), 'Ligne un tab fin');
  assert.equal(dpn.nomDeDossier('C1\u0085ici\u2028là'), 'C1 ici là');
  assert.equal(dpn.nomDeDossier('Orpheline \ud83d fin'), 'Orpheline fin');
  const decompose = 'Café';
  assert.equal(dpn.nomDeDossier(decompose), 'Café', 'NFC');
  assert.equal(dpn.nomDeDossier(decompose).length, 4);
});

test('le nom rendu sûr : 100 octets au plus, coupé entre deux caractères, jamais un point ou une espace à la fin', () => {
  const long = 'é'.repeat(80); // 160 octets
  const coupe = dpn.nomDeDossier(long);
  assert.ok(Buffer.byteLength(coupe) <= dpn.NOM_OCTETS_MAX);
  assert.equal(coupe, 'é'.repeat(50));
  const emoji = `${'a'.repeat(98)}😀b`; // l'emoji (4 octets) ne tient plus
  assert.equal(dpn.nomDeDossier(emoji), 'a'.repeat(98));
  const point = `${'a'.repeat(99)}. suite`;
  assert.equal(dpn.nomDeDossier(point), 'a'.repeat(99), 'la coupe retombe sur un point : il part aussi');
});

test('le nom rendu sûr : ce qui ne laisse rien rend une chaîne vide', () => {
  for (const vide of ['', '   ', '...', '\u0000\u0001', null, undefined]) {
    assert.equal(dpn.nomDeDossier(vide), '', JSON.stringify(vide));
  }
});

// ---------------------------------------------------------------------------
// La décision
// ---------------------------------------------------------------------------

test('chaque organisation nommée : son dossier à son nom ; l\'identifiant n\'apparaît nulle part', () => {
  const d = decider([
    { cle: ID(1), nom: 'Organisation d\'essai A' },
    { cle: ID(2), nom: 'Organisation d\'essai B' },
  ]);
  assert.deepEqual(d.get(ID(1)), { dossier: 'Organisation d\'essai A', regle: 'nom' });
  assert.deepEqual(d.get(ID(2)), { dossier: 'Organisation d\'essai B', regle: 'nom' });
});

test('deux organisations du même nom — à la casse près — prennent le suffixe de « Mes documents »', () => {
  const comptes = [
    { cle: ID(2), nom: 'Organisation jumelle' },
    { cle: ID(3), nom: 'ORGANISATION JUMELLE' },
    { cle: ID(4), nom: 'Organisation seule' },
  ];
  const d = decider(comptes);
  assert.equal(d.get(ID(2)).dossier, 'Organisation jumelle (…0002)');
  assert.equal(d.get(ID(3)).dossier, 'ORGANISATION JUMELLE (…0003)');
  assert.equal(d.get(ID(2)).regle, 'homonyme');
  assert.equal(d.get(ID(4)).dossier, 'Organisation seule');
  // Le MÊME suffixe que l'affichage du lot 96.
  const titres = documents.titresDesDossiers([
    { cle: ID(2), nom: 'Organisation jumelle' },
    { cle: ID(3), nom: 'Organisation jumelle' },
  ]);
  assert.equal(titres.get(ID(2)), 'Organisation jumelle (…0002)');
});

test('homonymes que la fin de l\'identifiant ne distingue pas : l\'identifiant, comme avant', () => {
  const d = decider([{ cle: 'ab12', nom: 'Même' }, { cle: 'cd34', nom: 'Même' }]);
  assert.deepEqual(d.get('ab12'), { dossier: 'ab12', regle: 'identifiant', raison: 'homonymes que la fin de leur identifiant ne distingue pas' });
  assert.equal(d.get('cd34').dossier, 'cd34');
});

test('sans nom — vide, absent, vidé par l\'assainissement, ou qui contient l\'identifiant : l\'identifiant, et la raison', () => {
  const d = decider([
    { cle: ID(1), nom: '' },
    { cle: ID(2), nom: '...' },
    { cle: ID(3), nom: `Organisation ${ID(3)}` },
    { cle: ID(4) },
  ], employes([[ID(5), { [ID(5)]: 2 }]]));
  assert.deepEqual(d.get(ID(1)), { dossier: ID(1), regle: 'identifiant', raison: 'aucun nom connu' });
  assert.deepEqual(d.get(ID(2)), { dossier: ID(2), regle: 'identifiant', raison: 'nom vide une fois rendu sûr' });
  assert.deepEqual(d.get(ID(3)), { dossier: ID(3), regle: 'identifiant', raison: 'nom qui contient l\'identifiant' });
  assert.equal(d.get(ID(4)).dossier, ID(4));
  assert.deepEqual(d.get(ID(5)), { dossier: ID(5), regle: 'identifiant', raison: 'aucun nom connu' }, 'connu seulement par ses documents');
});

test('le dossier à l\'identifiant ne retient personne : les documents d\'avant le lot n\'empêchent pas le nom', () => {
  const d = decider([{ cle: ID(1), nom: 'Organisation d\'essai A' }], employes([[ID(1), { [ID(1)]: 41 }]]));
  assert.deepEqual(d.get(ID(1)), { dossier: 'Organisation d\'essai A', regle: 'nom' });
});

test('le nom change chez le fournisseur : le dossier déjà employé est GARDÉ, et le changement est su', () => {
  const avant = employes([[ID(1), { 'Ancien nom': 12 }]]);
  const d = decider([{ cle: ID(1), nom: 'Nouveau nom' }], avant);
  assert.deepEqual(d.get(ID(1)), { dossier: 'Ancien nom', regle: 'deja-employe', nomChange: true });
  const inchange = decider([{ cle: ID(1), nom: 'Ancien nom' }], avant);
  assert.deepEqual(inchange.get(ID(1)), { dossier: 'Ancien nom', regle: 'deja-employe', nomChange: false });
  // À mi-chemin d'un déplacement (une copie déplacée, une autre pas) : le dossier nommé gagne.
  const moitie = decider([{ cle: ID(1), nom: 'Ancien nom' }], employes([[ID(1), { [ID(1)]: 5, 'Ancien nom': 1 }]]));
  assert.equal(moitie.get(ID(1)).dossier, 'Ancien nom');
});

test('un dossier n\'appartient qu\'à un compte : le nom pris par un autre prend le suffixe, puis l\'identifiant', () => {
  // A s'appelait « Commun » et le garde ; B s'appelle désormais « Commun ».
  const e = employes([[ID(1), { Commun: 3 }]]);
  const d = decider([{ cle: ID(1), nom: 'Autre nom' }, { cle: ID(2), nom: 'Commun' }], e);
  assert.equal(d.get(ID(1)).dossier, 'Commun');
  assert.equal(d.get(ID(2)).dossier, 'Commun (…0002)');
  // Le suffixe pris lui aussi : l'identifiant.
  const e2 = employes([[ID(1), { Commun: 3, 'Commun (…0002)': 1 }]]);
  const d2 = decider([{ cle: ID(1), nom: 'Autre nom' }, { cle: ID(2), nom: 'Commun' }], e2);
  assert.equal(d2.get(ID(2)).dossier, ID(2));
  assert.equal(d2.get(ID(2)).raison, 'le dossier de ce nom est déjà celui d\'un autre compte');
  // Un dossier où DEUX comptes rangent ne retient aucun des deux.
  const partage = employes([[ID(1), { Mêlé: 1 }], [ID(2), { Mêlé: 1 }]]);
  const d3 = decider([{ cle: ID(1), nom: 'Un' }, { cle: ID(2), nom: 'Deux' }], partage);
  assert.equal(d3.get(ID(1)).dossier, 'Un');
  assert.equal(d3.get(ID(2)).dossier, 'Deux');
});

test('quels que soient les noms, deux comptes n\'ont jamais le même dossier (à la casse près)', () => {
  const noms = ['A', 'a', 'A.', 'A ', 'A/', 'A_', 'B', '', '...', 'A (…0001)', 'a (…0002)'];
  for (let graine = 0; graine < 200; graine++) {
    const comptes = [];
    const e = new Map();
    for (let i = 1; i <= 6; i++) {
      comptes.push({ cle: ID(i), nom: noms[(graine * 7 + i * 3) % noms.length] });
      if ((graine + i) % 4 === 0) e.set(ID(i), new Map([[noms[(graine + i) % noms.length] || ID(i), 1]]));
    }
    const d = decider(comptes, e);
    const dossiers = [...d.values()].map((x) => dpn.cleDeDossier(x.dossier));
    assert.equal(new Set(dossiers).size, dossiers.length, `graine ${graine} : ${JSON.stringify([...d.values()])}`);
    for (const x of d.values()) assert.ok(x.dossier && !/[/\\:]/.test(x.dossier), x.dossier);
  }
});

// ---------------------------------------------------------------------------
// Les chemins enregistrés
// ---------------------------------------------------------------------------

test('le dossier d\'un chemin enregistré, sur le stockage local et sur un cloud ; et le même chemin, dossier remplacé', () => {
  const ctx = { username: 'camille', connectorName: 'Gandi' };
  const e = `/mnt/essai/camille/Gandi/${ID(1)}/2016/gandi_2016-01_ZZA009000.pdf`;
  assert.equal(dpn.dossierDuChemin(e, ctx).dossier, ID(1));
  assert.equal(dpn.cheminDansLeDossier(e, 'Organisation d\'essai A', ctx),
    '/mnt/essai/camille/Gandi/Organisation d\'essai A/2016/gandi_2016-01_ZZA009000.pdf');
  const c = `pcloud:crabe/camille/Gandi/${ID(1)}/2016/gandi_2016-01_ZZA009000.pdf`;
  assert.equal(dpn.cheminDansLeDossier(c, 'X', ctx), 'pcloud:crabe/camille/Gandi/X/2016/gandi_2016-01_ZZA009000.pdf');
  const sansBase = `proton:camille/Gandi/${ID(2)}/2021/f.pdf`;
  assert.equal(dpn.dossierDuChemin(sansBase, ctx).dossier, ID(2));
  // Le DERNIER couple utilisateur/connecteur : une base qui le répète ne trompe pas.
  const repete = `x:camille/Gandi/camille/Gandi/${ID(3)}/2021/f.pdf`;
  assert.equal(dpn.dossierDuChemin(repete, ctx).dossier, ID(3));
  assert.equal(dpn.dossierDuChemin('/ailleurs/autre/chose.pdf', ctx), null);
  assert.equal(dpn.cheminDansLeDossier('/ailleurs/autre/chose.pdf', 'X', ctx), null);
});

// ---------------------------------------------------------------------------
// Ce que Gandi en dit
// ---------------------------------------------------------------------------

test('Gandi dit le nom de ses organisations ; « Organisation sans nom » n\'en est pas un', () => {
  assert.equal(gandi.nomDuCompte({ id: ID(1), label: 'Organisation d\'essai A' }), 'Organisation d\'essai A');
  assert.equal(gandi.nomDuCompte({ id: ID(1), label: '  Espacée  ' }), 'Espacée');
  assert.equal(gandi.nomDuCompte({ id: ID(1), label: gandi.LIBELLE_SANS_NOM }), '');
  assert.equal(gandi.nomDuCompte({ id: ID(1), label: ID(1) }), '', 'le libellé de repli de la découverte');
  assert.equal(gandi.nomDuCompte({ id: ID(1) }), '');
  assert.equal(gandi.enElementDecouvert({ id: ID(1), nom: '' }).label, 'Organisation sans nom', 'la fiche, inchangée');
});

test('seul Gandi nomme ses comptes parmi les connecteurs disponibles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dossier = path.join(__dirname, '..', 'server', 'connectors', 'available');
  const nommeurs = fs.readdirSync(dossier)
    .filter((id) => fs.existsSync(path.join(dossier, id, 'connector.js')))
    .filter((id) => /\bnomDuCompte\b/.test(fs.readFileSync(path.join(dossier, id, 'connector.js'), 'utf8')));
  assert.deepEqual(nommeurs, ['gandi']);
});
