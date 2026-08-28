'use strict';

/**
 * Conversion clavier → keysym X11 (web/keysym.js).
 *
 * ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * En production, les touches du pavé numérique ne produisaient RIEN dans la
 * fenêtre du navigateur distant. Ni erreur, ni journal : les frappes partaient
 * bien, mais en `XK_KP_*`, dont la valeur dépend du verrou numérique du
 * serveur X — éteint sur un `Xvfb` neuf, où `KP_0` vaut « Inser ».
 *
 * Un défaut d'ÉTAT, donc, qu'aucun test de branchement n'aurait attrapé : le
 * clavier était câblé, la touche était envoyée, et le résultat était faux.
 * D'où une table explicite, vérifiée touche par touche, verrou actif comme
 * verrou éteint — les deux états que rencontre un utilisateur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYSYMS_NOMMES,
  keysymPourCaractere,
  keysymDuPave,
  keysymDeTouche,
  estDuPave,
} = require('../web/keysym');

/** Un événement de pavé, verrou numérique ACTIF : la touche produit un signe. */
const paveAvecVerrou = (code, key) => ({ code, key, location: 3 });
/** Le même, verrou ÉTEINT : le navigateur annonce une touche de navigation. */
const paveSansVerrou = (code, key) => ({ code, key, location: 3 });

// ---------------------------------------------------------------------------
// Le pavé, verrou numérique actif — le cas du code SMS à six chiffres
// ---------------------------------------------------------------------------

test('pavé, verrou actif : chaque chiffre part comme celui de la rangée du haut', () => {
  for (let chiffre = 0; chiffre <= 9; chiffre++) {
    const keysym = keysymDuPave(paveAvecVerrou(`Numpad${chiffre}`, String(chiffre)));
    assert.equal(
      keysym,
      0x0030 + chiffre,
      `le ${chiffre} du pavé doit valoir le keysym du ${chiffre} ordinaire`
    );
    // Et surtout PAS le keysym de pavé, qui vaut « Inser » ou « Fin » sur un
    // serveur X dont le verrou numérique est éteint — c'est-à-dire le nôtre.
    assert.notEqual(keysym, 0xffb0 + chiffre, `XK_KP_${chiffre} ne doit jamais être envoyé`);
  }
});

test('pavé, verrou actif : les opérateurs et les séparateurs', () => {
  const attendus = [
    ['NumpadAdd', '+', 0x002b],
    ['NumpadSubtract', '-', 0x002d],
    ['NumpadMultiply', '*', 0x002a],
    ['NumpadDivide', '/', 0x002f],
    ['NumpadDecimal', '.', 0x002e],
    // Sur un clavier français, la touche du pavé porte une virgule.
    ['NumpadDecimal', ',', 0x002c],
    ['NumpadComma', ',', 0x002c],
    ['NumpadEqual', '=', 0x003d],
  ];
  for (const [code, key, keysym] of attendus) {
    assert.equal(keysymDuPave(paveAvecVerrou(code, key)), keysym, `${code} → « ${key} »`);
  }
});

test('pavé : « Entrée » vaut XK_Return, jamais XK_KP_Enter', () => {
  const keysym = keysymDuPave(paveAvecVerrou('NumpadEnter', 'Enter'));
  assert.equal(keysym, 0xff0d, 'XK_Return');
  assert.notEqual(keysym, 0xff8d, 'XK_KP_Enter dépend du clavier distant');
});

// ---------------------------------------------------------------------------
// Le pavé, verrou numérique éteint
// ---------------------------------------------------------------------------

test('pavé, verrou éteint : la touche de navigation annoncée est bien celle envoyée', () => {
  const attendus = [
    ['Numpad0', 'Insert', 0xff63],
    ['Numpad1', 'End', 0xff57],
    ['Numpad2', 'ArrowDown', 0xff54],
    ['Numpad3', 'PageDown', 0xff56],
    ['Numpad4', 'ArrowLeft', 0xff51],
    ['Numpad5', 'Clear', 0xff0b],
    ['Numpad6', 'ArrowRight', 0xff53],
    ['Numpad7', 'Home', 0xff50],
    ['Numpad8', 'ArrowUp', 0xff52],
    ['Numpad9', 'PageUp', 0xff55],
    ['NumpadDecimal', 'Delete', 0xffff],
  ];
  for (const [code, key, keysym] of attendus) {
    assert.equal(keysymDuPave(paveSansVerrou(code, key)), keysym, `${code} → ${key}`);
  }
});

test('pavé : un navigateur muet retombe sur la table du verrou éteint', () => {
  // `key` vide ou « Unidentified » : aucun navigateur d'aujourd'hui ne le fait,
  // mais le repli ne doit pas rendre une touche morte.
  assert.equal(keysymDuPave({ code: 'Numpad7', key: '', location: 3 }), 0xff50);
  assert.equal(keysymDuPave({ code: 'Numpad4', key: 'Unidentified', location: 3 }), 0xff51);
  assert.equal(keysymDuPave({ code: 'NumpadEnter', key: '', location: 3 }), 0xff0d);
});

// ---------------------------------------------------------------------------
// Ce qui ne doit PAS être détourné
// ---------------------------------------------------------------------------

test('la rangée du haut et les lettres restent à noVNC', () => {
  // Ce clavier-là fonctionne en production : l'intercepter serait le meilleur
  // moyen de casser ce qui marche.
  assert.equal(keysymDuPave({ code: 'Digit7', key: '7', location: 0 }), null);
  assert.equal(keysymDuPave({ code: 'KeyA', key: 'a', location: 0 }), null);
  assert.equal(keysymDuPave({ code: 'Enter', key: 'Enter', location: 0 }), null);
  assert.equal(keysymDuPave({ code: 'Tab', key: 'Tab', location: 0 }), null);
  assert.equal(keysymDuPave({ code: 'ArrowLeft', key: 'ArrowLeft', location: 0 }), null);
});

test('le verrou numérique lui-même n\'est jamais transmis', () => {
  // C'est un état LOCAL. Le transmettre inverserait celui du serveur X et
  // rendrait faux tout ce que ce module corrige.
  assert.equal(estDuPave({ code: 'NumLock', key: 'NumLock', location: 3 }), false);
  assert.equal(keysymDuPave({ code: 'NumLock', key: 'NumLock', location: 3 }), null);
});

// ---------------------------------------------------------------------------
// Les autres touches indispensables à une saisie
// ---------------------------------------------------------------------------

test('les touches d\'édition et de navigation ont la valeur attendue', () => {
  const attendus = {
    Tab: 0xff09,
    Backspace: 0xff08,
    Delete: 0xffff,
    Insert: 0xff63,
    Escape: 0xff1b,
    Home: 0xff50,
    End: 0xff57,
    PageUp: 0xff55,
    PageDown: 0xff56,
    ArrowLeft: 0xff51,
    ArrowUp: 0xff52,
    ArrowRight: 0xff53,
    ArrowDown: 0xff54,
    Enter: 0xff0d,
  };
  for (const [key, keysym] of Object.entries(attendus)) {
    assert.equal(KEYSYMS_NOMMES[key], keysym, `${key}`);
    assert.equal(keysymDeTouche({ code: key, key, location: 0 }), keysym, `${key} (par touche)`);
  }
});

test('les caractères accentués d\'un clavier français passent en Latin-1 direct', () => {
  const attendus = [
    ['é', 0x00e9], ['è', 0x00e8], ['ê', 0x00ea], ['à', 0x00e0], ['ù', 0x00f9],
    ['ç', 0x00e7], ['ô', 0x00f4], ['î', 0x00ee], ['ë', 0x00eb], ['°', 0x00b0],
    ['µ', 0x00b5], ['§', 0x00a7], ['£', 0x00a3],
  ];
  for (const [caractere, keysym] of attendus) {
    assert.equal(keysymPourCaractere(caractere), keysym, `« ${caractere} » en Latin-1 direct`);
  }
});

test('au-delà du Latin-1, la convention 0x01000000 + point de code', () => {
  assert.equal(keysymPourCaractere('€'), 0x01000000 + 0x20ac);
  assert.equal(keysymPourCaractere('œ'), 0x01000000 + 0x0153);
  // Un caractère hors du plan de base ne doit pas être coupé en deux.
  assert.equal(keysymPourCaractere('😀'), 0x01000000 + 0x1f600);
});

test('l\'ASCII imprimable vaut son propre point de code', () => {
  for (const caractere of 'aZ0!@#$%^&*()_+-=[]{};\':"\\|,.<>/?`~ ') {
    assert.equal(
      keysymPourCaractere(caractere),
      caractere.codePointAt(0),
      `« ${caractere} »`
    );
  }
});

test('une entrée vide ne produit pas de keysym', () => {
  assert.equal(keysymPourCaractere(''), null);
  assert.equal(keysymPourCaractere(null), null);
  assert.equal(keysymDuPave(null), null);
  assert.equal(keysymDuPave({}), null);
  assert.equal(keysymDeTouche({ code: 'ShiftLeft', key: 'Shift', location: 1 }), null);
});
