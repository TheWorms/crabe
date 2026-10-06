'use strict';

/**
 * Chaque conteneur de logo est contraint en taille (lot 37).
 *
 * ─── Le défaut que ce test supprime ──────────────────────────────────────────
 *
 * Le 18/08/2026, le logo pCloud remplissait la page d'accueil de crabe.local.
 * Mécanisme : `.logo-img` se pose en `position:absolute; inset:0; width:100%;
 * height:100%` par-dessus la pastille à initiales — et le conteneur
 * `.dest-choice-icon` (bloc « Où vont vos documents ») manquait à la liste
 * des conteneurs `position:relative; overflow:hidden`. Sans ancêtre
 * positionné, le logo s'étendait jusqu'à la page entière.
 *
 * Ce test relève TOUS les conteneurs qui reçoivent `logoHtml()` dans app.js
 * et vérifie que chacun est positionné et rogné dans style.css : le prochain
 * écran qui ajoutera une pastille sans la contraindre tombera ici, pas sur
 * l'écran de quelqu'un.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');

/** Les classes de conteneur : le premier nom de classe avant chaque logoHtml(. */
function conteneursDeLogo() {
  const classes = new Set();
  let position = APP.indexOf('logoHtml(');
  while (position !== -1) {
    const fenetre = APP.slice(Math.max(0, position - 300), position);
    const correspondances = [...fenetre.matchAll(/class="([A-Za-z][A-Za-z0-9-]*)/g)];
    if (correspondances.length) classes.add(correspondances[correspondances.length - 1][1]);
    position = APP.indexOf('logoHtml(', position + 1);
  }
  return [...classes];
}

/** La classe est-elle positionnée ET rognée quelque part dans le CSS ? */
function estContrainte(classe) {
  const regles = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return regles.some(([, selecteur, corps]) => {
    if (!new RegExp(`\\.${classe}(?![A-Za-z0-9-])`).test(selecteur)) return false;
    return /position\s*:\s*relative/.test(corps) && /overflow\s*:\s*hidden/.test(corps);
  });
}

test('tous les conteneurs de logo sont relevés — la liste ne peut pas se vider en silence', () => {
  const conteneurs = conteneursDeLogo();
  assert.ok(conteneurs.length >= 8, `${conteneurs.length} conteneur(s) relevé(s) : ${conteneurs.join(', ')}`);
  // Le conteneur du défaut mesuré est bien dans la liste relevée : si le
  // relevé le perdait, le test entier ne prouverait plus rien.
  assert.ok(conteneurs.includes('dest-choice-icon'), conteneurs.join(', '));
});

test('chaque conteneur de logo est positionné et rogné — le logo ne peut plus remplir la page', () => {
  for (const classe of conteneursDeLogo()) {
    assert.ok(
      estContrainte(classe),
      `.${classe} reçoit logoHtml() mais n'a pas position:relative + overflow:hidden — `
        + 'c\'est le logo pCloud plein écran du 18/08/2026'
    );
  }
});
