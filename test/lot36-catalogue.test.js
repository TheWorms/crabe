'use strict';

/**
 * Lot 36, phase F — le catalogue dit la vérité.
 *
 * ─── Le défaut que cette phase répare ────────────────────────────────────────
 *
 * Une annonce « Bientôt disponible » est une promesse, et le lot 30 a établi
 * qu'une promesse intenable est un défaut de produit (Hello Bank!). La
 * reconnaissance du lot 36 a MESURÉ que quatre services annoncés sont
 * impraticables — Google Play (mur Google), FDJ (mur DataDome), Flexiroam
 * (factures uniquement dans l'application mobile), Samsung+ (aucun guichet
 * web) — et le lot 30 avait déjà mesuré l'empêchement DSP2 des quatre banques.
 *
 * La voie retenue est l'état honnête, pas le retrait : un client du service
 * qui ne trouverait plus sa tuile conclurait que crabe l'a oublié, alors que
 * « Pas possible aujourd'hui », avec sa raison en une phrase, transmet ce que
 * la reconnaissance a établi et éteint la promesse sans effacer l'information.
 *
 * ─── Ce que ce fichier vérifie ───────────────────────────────────────────────
 *
 *   1. les HUIT annonces (4 du lot 36 + 4 banques) portent leur empêchement,
 *      et les autres annonces n'en portent pas — une annonce non mesurée reste
 *      une promesse en attente ;
 *   2. le schéma refuse un empêchement vide, hors annonce, ou trop long ;
 *   3. la tuile du Store montre « Pas possible aujourd'hui » et la raison —
 *      jamais « Bientôt disponible » — pour une annonce empêchée, et le badge
 *      de l'administration suit. Vérifié dans le VRAI web/app.js, exécuté
 *      dans un bac à sable.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');

/** Les huit annonces dont l'empêchement est MESURÉ (lots 30 et 36). */
const EMPECHEES = [
  'google-play', 'fdj', 'flexiroam', 'samsung-plus',
  'caisse-epargne', 'credit-agricole', 'credit-mutuel', 'hello-bank',
];

/** Des annonces jamais mesurées : leur promesse reste en attente, intacte. */
const PROMESSES_INTACTES = ['darty', 'uber', 'pronote', 'battle-net', 'recraft', 'betterme'];

// ---------------------------------------------------------------------------
// 1. Les manifestes du disque
// ---------------------------------------------------------------------------

test('les huit annonces empêchées portent leur raison, en français et en une phrase lisible', () => {
  const { errors } = registry.load();
  assert.deepEqual(errors, [], 'le catalogue charge sans erreur');

  for (const id of EMPECHEES) {
    const entry = registry.get(id);
    assert.ok(entry, `l'annonce ${id} existe toujours — l'état honnête n'est pas un retrait`);
    assert.equal(entry.planned, true, `${id} reste une annonce`);
    const raison = (entry.manifest.unfeasible || '').trim();
    assert.ok(raison, `${id} porte son empêchement`);
    assert.ok(raison.length <= 220, `${id} : la raison se lit d'un trait`);
    assert.match(raison, /crabe/, `${id} : la raison dit ce que crabe ne peut pas faire`);
    assert.doesNotMatch(raison, /DataDome|reCAPTCHA|Turnstile|DSP2|API|bot/i,
      `${id} : pas de jargon — crabe sera public, son public n'est pas technique`);
    // La raison doit ARRIVER au navigateur : la vue publique du manifeste la
    // garde (une route qui la filtrerait rendrait la tuile muette).
    assert.equal(schema.publicView(entry.manifest).unfeasible, entry.manifest.unfeasible,
      `${id} : la raison traverse la vue publique jusqu'au Store`);
  }
});

test('une annonce jamais mesurée ne porte AUCUN empêchement : sa promesse reste en attente', () => {
  registry.load();
  for (const id of PROMESSES_INTACTES) {
    const entry = registry.get(id);
    assert.ok(entry, `l'annonce ${id} existe`);
    assert.equal((entry.manifest.unfeasible || '').trim(), '',
      `${id} n'a pas été mesurée impraticable : elle ne doit pas être marquée telle`);
  }
});

// ---------------------------------------------------------------------------
// 2. Le schéma
// ---------------------------------------------------------------------------

test('le schéma encadre « unfeasible » : annonces seulement, jamais vide, jamais interminable', () => {
  const base = { id: 'exemple', name: 'Exemple', category: 'divers', description: 'Une annonce.' };

  const ok = schema.validate({ ...base, unfeasible: 'Ce service refuse les programmes.' },
    'test', { planned: true });
  assert.equal(ok.ok, true, 'une raison courte sur une annonce passe');

  const vide = schema.validate({ ...base, unfeasible: '   ' }, 'test', { planned: true });
  assert.equal(vide.ok, false, 'une raison vide est refusée');

  const horsAnnonce = schema.validate(
    { ...base, unfeasible: 'Ce service refuse les programmes.' }, 'test', { planned: false });
  assert.equal(horsAnnonce.ok, false,
    'un service disponible qui devient impraticable se retire, il ne s\'excuse pas');

  const trop = schema.validate({ ...base, unfeasible: 'x'.repeat(300) }, 'test', { planned: true });
  assert.equal(trop.ok, false, 'une raison de 300 caractères est refusée');
});

// ---------------------------------------------------------------------------
// 3. Le rendu — le vrai web/app.js et le vrai web/admin.js, dans un bac à sable
// ---------------------------------------------------------------------------

/** Charge les scripts du front dans un bac à sable minimal et rend une expression. */
function dansLeFront(expression) {
  const sandbox = {
    console,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { classList: { add() {}, remove() {}, contains: () => false } },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/', hash: '', search: '' },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const WEB = path.resolve(__dirname, '..', 'web');
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js', 'admin.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  return vm.runInContext(expression, context);
}

const TUILE_EMPECHEE = JSON.stringify({
  id: 'fdj', name: 'FDJ', color: '#123456', letters: 'FD', planned: true,
  description: 'Récupère automatiquement vos relevés de compte joueur FDJ.',
  unfeasible: 'Le site de la FDJ bloque les programmes avant même sa page d\'accueil.',
});

const TUILE_PROMISE = JSON.stringify({
  id: 'darty', name: 'Darty', color: '#123456', letters: 'DA', planned: true,
  description: 'Récupère automatiquement les factures de vos achats Darty.',
});

test('la tuile d\'une annonce empêchée dit « Pas possible aujourd\'hui » et sa raison — plus jamais « Bientôt »', () => {
  const html = dansLeFront(`storeCard(${TUILE_EMPECHEE})`);
  assert.match(html, /Pas possible aujourd'hui/);
  assert.match(html, /bloque les programmes/, 'la raison prend la place de la description');
  assert.doesNotMatch(html, /Bientôt disponible/, 'la promesse est éteinte');
  assert.doesNotMatch(html, /Récupère automatiquement/, 'la description-promesse ne s\'affiche plus');
});

test('la tuile d\'une annonce ordinaire dit toujours « Bientôt disponible »', () => {
  const html = dansLeFront(`storeCard(${TUILE_PROMISE})`);
  assert.match(html, /Bientôt disponible/);
  assert.doesNotMatch(html, /Pas possible aujourd'hui/);
});

test('le badge de l\'administration suit le même état', () => {
  assert.match(dansLeFront(`appStatusBadge(${TUILE_EMPECHEE})`), /Pas possible aujourd'hui/);
  assert.match(dansLeFront(`appStatusBadge(${TUILE_PROMISE})`), /Bientôt disponible/);
});
