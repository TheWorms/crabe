'use strict';

/**
 * Lot 105 (R7) — la page des connecteurs, `docs/CONNECTEURS.md` : Private
 * Sport Shop et l'Eau d'Île-de-France passent « Fonctionnels » ; Battle.net
 * et Alma, corrigés après leur premier essai réel, restent « En cours ».
 *
 * Private Sport Shop : trois documents en production (mesuré le 12/10/2026,
 * `COUNT(*)`, deux passes). L'Eau d'Île-de-France : AUCUN document en
 * production, classée « Fonctionnels » par décision — elle a récupéré ses
 * factures sur l'installation de qui l'a essayée ; l'exception est dite là où
 * le classement s'écrit.
 *
 * Cet essai ne lit que la page publiée (aucun script, aucune base).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');

function groupes() {
  const g = {};
  let nom = null;
  for (const ligne of fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8').split('\n')) {
    const t = /^## (.+) \((\d+)\)$/.exec(ligne);
    if (t) {
      nom = t[1];
      g[nom] = { annonce: Number(t[2]), ids: [] };
      continue;
    }
    const icone = nom && /^\| <img src="icones\/([a-z0-9-]+)\.png"/.exec(ligne);
    if (icone) g[nom].ids.push(icone[1]);
  }
  return g;
}

test('D4 — la page : Fonctionnels 48, En cours 3, En attente 2, Non faisables 18 (lot 106), Proposés 17 — 88', () => {
  const g = groupes();
  assert.deepEqual(Object.keys(g), ['Fonctionnels', 'En cours', 'En attente', 'Non faisables', 'Proposés']);
  const comptes = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.ids.length]));
  // Lot 106, par décision : dix connecteurs écrits passent « Non faisables ».
  assert.deepEqual(comptes, { Fonctionnels: 48, 'En cours': 3, 'En attente': 2, 'Non faisables': 18, Proposés: 17 });
  for (const [k, v] of Object.entries(g)) assert.equal(v.annonce, v.ids.length, `${k} : le compte du titre`);
  assert.equal(Object.values(comptes).reduce((a, b) => a + b, 0), 88);
});

test('D4 — Private Sport Shop et l\'Eau d\'Île-de-France sont fonctionnels ; Alma, Battle.net et PayByPhone en cours ; chacun une seule fois', () => {
  const g = groupes();
  for (const id of ['private-sport-shop', 'eau-ile-de-france']) assert.ok(g.Fonctionnels.ids.includes(id), id);
  assert.deepEqual(g['En cours'].ids, ['alma', 'battle-net', 'paybyphone']);
  const tous = Object.values(g).flatMap((v) => v.ids);
  assert.equal(new Set(tous).size, tous.length, 'aucun service dans deux groupes');
  const page = fs.readFileSync(path.join(RACINE, 'docs', 'CONNECTEURS.md'), 'utf8');
  assert.match(page, /^État au 12 octobre 2026, version \d+\.\d+\.\d+\. /m);
});

test('D4 — la réserve des deux nouveaux fonctionnels ne les dit pas « jamais essayés »', () => {
  for (const id of ['private-sport-shop', 'eau-ile-de-france']) {
    const manifeste = JSON.parse(fs.readFileSync(path.join(RACINE, 'server', 'connectors', 'available', id, 'manifest.json'), 'utf8'));
    assert.doesNotMatch(manifeste.caveat, /jamais|pas encore (?:été )?essay|aucun compte/i, id);
  }
});
