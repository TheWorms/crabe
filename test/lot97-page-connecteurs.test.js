'use strict';

/**
 * Lot 97 — R4 : la page publique des connecteurs, `docs/CONNECTEURS.md`.
 *
 * Elle est générée par `scripts/lot97-page-connecteurs.js` (dépôt privé), à
 * partir des manifestes et d'un classement mesuré en production le 06/10/2026
 * (le détail est au SUMMARY.md du lot 97). Ce fichier verrouille ce que la
 * page doit rester, lot après lot :
 *
 *   1. cinq groupes depuis le lot 103, dans l'ordre : Fonctionnels, En
 *      cours, En attente, Non faisables, Proposés — chacun avec son compte
 *      exact ;
 *   2. chaque service du catalogue (connecteurs et annonces) y est, et une
 *      seule fois ; « Non faisables » est exactement la liste des annonces
 *      qui portent un empêchement (`unfeasible`), « Proposés » celle des
 *      autres (avant le lot 103 : toutes les annonces) ;
 *   3. chaque icône pointe un fichier du dépôt, en PNG de 48 × 48, et aucun
 *      fichier d'icône n'est orphelin ;
 *   4. un service « en attente » dit pourquoi ;
 *   5. rien de personnel : ni adresse e-mail, ni long numéro, ni chiffre de
 *      production. (Les noms propres à une installation privée, eux, sont
 *      cherchés par le scan de publication, qui vit hors de ce dépôt : un
 *      essai qui les écrirait pour les interdire les publierait.)
 *
 * Un connecteur ajouté au catalogue fait tomber cet essai tant que la page ne
 * le classe pas : c'est voulu — la page publique ne doit pas oublier un service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const PAGE = path.join(RACINE, 'docs', 'CONNECTEURS.md');
const ICONES = path.join(RACINE, 'docs', 'icones');
const GROUPES = ['Fonctionnels', 'En cours', 'En attente', 'Non faisables', 'Proposés'];

function catalogue() {
  const ids = { ecrits: [], annonces: [] };
  for (const [dossier, liste] of [['available', ids.ecrits], ['planned', ids.annonces]]) {
    const racine = path.join(RACINE, 'server', 'connectors', dossier);
    for (const id of fs.readdirSync(racine)) {
      if (fs.existsSync(path.join(racine, id, 'manifest.json'))) liste.push(id);
    }
  }
  return ids;
}

/** Les groupes de la page : leur titre, leur compte annoncé, et leurs lignes. */
function lireLaPage() {
  const texte = fs.readFileSync(PAGE, 'utf8');
  const sections = [];
  let courante = null;
  for (const ligne of texte.split('\n')) {
    const titre = /^## (.+) \((\d+)\)$/.exec(ligne);
    if (titre) {
      courante = { nom: titre[1], annonce: Number(titre[2]), lignes: [] };
      sections.push(courante);
      continue;
    }
    if (/^## /.test(ligne)) courante = null;
    if (courante && /^\| <img /.test(ligne)) courante.lignes.push(ligne);
  }
  return { texte, sections };
}

const idDe = (ligne) => /<img src="icones\/([a-z0-9-]+)\.png" width="24" height="24" alt="">/.exec(ligne)?.[1];

/** Une annonce porte-t-elle un empêchement mesuré (`unfeasible`) ? */
function empechee(id) {
  // Lot 106 : un connecteur écrit (available/) peut porter l'empêchement aussi.
  const annonce = path.join(RACINE, 'server', 'connectors', 'planned', id, 'manifest.json');
  const manifeste = fs.existsSync(annonce)
    ? annonce
    : path.join(RACINE, 'server', 'connectors', 'available', id, 'manifest.json');
  return !!String(JSON.parse(fs.readFileSync(manifeste, 'utf8')).unfeasible || '').trim();
}

test('R4 → lot 103 — cinq groupes, dans l\'ordre, chacun avec son compte exact', () => {
  const { sections } = lireLaPage();
  assert.deepEqual(sections.map((s) => s.nom), GROUPES);
  for (const s of sections) {
    assert.equal(s.lignes.length, s.annonce, `${s.nom} : ${s.annonce} annoncés, ${s.lignes.length} lignes`);
    assert.ok(s.lignes.every(idDe), `${s.nom} : chaque ligne porte son icône, en 24 pixels`);
  }
});

test('R4 — chaque service du catalogue est dans un groupe, et un seul', () => {
  const { sections } = lireLaPage();
  const { ecrits, annonces } = catalogue();
  const vus = sections.flatMap((s) => s.lignes.map(idDe));
  const doublons = vus.filter((id, i) => vus.indexOf(id) !== i);
  assert.deepEqual(doublons, [], 'aucun service classé deux fois');
  assert.deepEqual([...vus].sort(), [...ecrits, ...annonces].sort(), 'chaque service du catalogue, et rien d\'autre');
  const nonFaisables = sections.find((s) => s.nom === 'Non faisables').lignes.map(idDe);
  const proposes = sections.find((s) => s.nom === 'Proposés').lignes.map(idDe);
  // Lot 106, par décision : les connecteurs ÉCRITS empêchés y sont aussi.
  assert.deepEqual([...nonFaisables].sort(), [...annonces, ...ecrits].filter(empechee).sort(),
    '« Non faisables » est exactement la liste des services empêchés (lot 103, écrits compris au lot 106)');
  assert.deepEqual([...proposes].sort(), annonces.filter((id) => !empechee(id)).sort(),
    '« Proposés » est exactement la liste des autres annonces');
});

test('R4 — chaque icône pointe un PNG de 48 × 48 du dépôt, et aucune icône n\'est orpheline', () => {
  const { texte } = lireLaPage();
  const references = [...texte.matchAll(/<img src="(icones\/[^"]+)"/g)].map((m) => m[1]);
  for (const reference of references) {
    const fichier = path.join(RACINE, 'docs', reference);
    assert.ok(fs.existsSync(fichier), `${reference} : le fichier n'existe pas`);
    const octets = fs.readFileSync(fichier);
    assert.ok(octets.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${reference} : pas un PNG`);
    assert.deepEqual([octets.readUInt32BE(16), octets.readUInt32BE(20)], [48, 48], `${reference} : 48 × 48 attendu`);
  }
  const orphelins = fs.readdirSync(ICONES).filter((f) => !references.includes(`icones/${f}`));
  assert.deepEqual(orphelins, [], 'chaque fichier de docs/icones sert la page');
});

test('R4 — un service « en attente » dit pourquoi', () => {
  const { sections } = lireLaPage();
  for (const ligne of sections.find((s) => s.nom === 'En attente').lignes) {
    const cellules = ligne.split(' | ');
    assert.ok(cellules.length >= 4, `${idDe(ligne)} : une colonne « Pourquoi il attend »`);
    assert.ok(cellules.at(-1).replace(/\|\s*$/, '').trim().length > 30, `${idDe(ligne)} : la raison est dite`);
  }
});

test('R4 — rien de personnel, et aucun chiffre de production', () => {
  const { texte } = lireLaPage();
  assert.doesNotMatch(texte, /[\w.+-]+@[\w-]+\.[\w.]+/, 'aucune adresse e-mail');
  assert.doesNotMatch(texte, /\d{8,}/, 'aucun long numéro (identifiant, téléphone)');
  assert.doesNotMatch(texte, /\b\d+ (documents?|factures?) récupérée?s?\b/i, 'aucun nombre de documents de production');
  assert.doesNotMatch(texte, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'aucune adresse IP');
});
