'use strict';

/**
 * Lot 101 — la page publique des connecteurs, `docs/CONNECTEURS.md`, dit la
 * même chose que le reste de crabe.
 *
 *   1. Sa ligne d'état porte la version du fichier `VERSION`, seule vérité
 *      depuis le lot 84 : une version publiée ne montre pas le numéro de la
 *      précédente. Changer de version fait tomber cet essai tant que la page
 *      n'est pas régénérée : c'est voulu.
 *   2. Un service rangé parmi les « Fonctionnels » — il a déjà récupéré des
 *      documents sur un vrai compte — ne dit pas le contraire dans sa réserve
 *      (`caveat`), que sa fiche affiche.
 *
 * Les comptes qui décident du groupe (documents rangés en production) ne
 * sont pas dans ce dépôt : ils sont mesurés à chaque génération de la page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const PAGE = path.join(RACINE, 'docs', 'CONNECTEURS.md');

const lignesDeLaPage = () => fs.readFileSync(PAGE, 'utf8').split('\n');

/** Les services d'un groupe de la page, d'après l'icône de chaque ligne. */
function groupe(nom) {
  const ids = [];
  let dedans = false;
  for (const ligne of lignesDeLaPage()) {
    if (/^## /.test(ligne)) {
      dedans = new RegExp(`^## ${nom} \\(\\d+\\)$`).test(ligne);
      continue;
    }
    const icone = dedans && /^\| <img src="icones\/([a-z0-9-]+)\.png"/.exec(ligne);
    if (icone) ids.push(icone[1]);
  }
  return ids;
}

test('R2 — la ligne d\'état de la page porte la version du fichier VERSION', () => {
  const version = fs.readFileSync(path.join(RACINE, 'VERSION'), 'utf8').trim();
  const etat = lignesDeLaPage().filter((ligne) => ligne.startsWith('État au '));
  assert.equal(etat.length, 1, 'une seule ligne d\'état');
  const lue = /^État au (\d{1,2}(?:er)? [a-zéû]+ \d{4}), version (\d+\.\d+\.\d+)\. /.exec(etat[0]);
  assert.ok(lue, `ligne d'état illisible : « ${etat[0]} »`);
  assert.equal(lue[2], version, 'la page dit la version installée — sinon, la régénérer');
});

test('R3 — un service « Fonctionnel » ne se dit pas « pas encore essayé » dans sa réserve', () => {
  const fonctionnels = groupe('Fonctionnels');
  assert.ok(fonctionnels.length > 0, 'le groupe « Fonctionnels » est lu');
  for (const id of fonctionnels) {
    const fichier = path.join(RACINE, 'server', 'connectors', 'available', id, 'manifest.json');
    const reserve = String(JSON.parse(fs.readFileSync(fichier, 'utf8')).caveat || '');
    assert.doesNotMatch(
      reserve,
      /pas encore (?:été )?essayé|jamais (?:été )?essayé|essayé sur aucun compte/i,
      `${id} : sa réserve dit le contraire de son groupe`
    );
  }
});
