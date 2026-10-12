'use strict';

/**
 * Vérifications automatisées du front.
 *
 * Aucun navigateur n'est disponible pour relire le rendu : ces tests couvrent
 * ce qui peut l'être sans en ouvrir un, c'est-à-dire tout ce qui casse
 * silencieusement quand on réorganise des écrans —
 *
 *   1. la syntaxe de chaque fichier JS servi au navigateur ;
 *   2. chaque gestionnaire inline (onclick, onchange, oninput) pointe vers une
 *      fonction qui existe vraiment ;
 *   3. chaque identifiant DOM référencé par `$('…')` existe, soit dans
 *      app.html, soit dans un gabarit HTML produit par le JS.
 *
 * Ce qu'ils NE couvrent pas : la mise en page elle-même (colonnes, largeurs,
 * repli responsive, thème clair / sombre), qui demande une relecture à l'œil.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { nestingErrors } = require('./html-nesting');

const WEB = path.resolve(__dirname, '..', 'web');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');

/** Fichiers chargés par app.html, dans l'ordre du <script>. */
const APP_SCRIPTS = ['fmt.js', 'keysym.js', 'app.js', 'admin.js'];
const LOGIN_SCRIPTS = ['login.js'];

const sources = Object.fromEntries(
  [...APP_SCRIPTS, ...LOGIN_SCRIPTS].map((file) => [file, read(file)])
);
const appHtml = read('app.html');
const loginHtml = read('login.html');

// ---------------------------------------------------------------------------
// 1. Syntaxe
// ---------------------------------------------------------------------------

test('chaque fichier JS du front est syntaxiquement valide', () => {
  for (const [file, code] of Object.entries(sources)) {
    assert.doesNotThrow(
      () => new vm.Script(code, { filename: file }),
      `erreur de syntaxe dans web/${file}`
    );
  }
});

test('app.html et login.html chargent bien les scripts attendus', () => {
  for (const file of APP_SCRIPTS) {
    assert.ok(appHtml.includes(`/${file}`), `app.html ne charge pas ${file}`);
  }
  for (const file of LOGIN_SCRIPTS) {
    assert.ok(loginHtml.includes(`/${file}`), `login.html ne charge pas ${file}`);
  }
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Fonctions globales déclarées dans un fichier (déclarations et const fléchées). */
function declaredFunctions(code) {
  const names = new Set();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/gm)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Gestionnaires inline d'un texte (HTML ou gabarit JS) : on ne garde que le
 * nom de la fonction appelée en tête de chaque instruction.
 */
function inlineHandlerCalls(text) {
  const calls = [];
  const ATTR = /\son(?:click|change|input|submit|focus|blur|keyup|keydown)\s*=\s*"([^"]*)"/g;

  for (const match of text.matchAll(ATTR)) {
    for (const statement of match[1].split(';')) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      // `this.value = x`, `admin.x = y`, `${…}` interpolé : rien à vérifier ici.
      if (/^(this|event|admin|state)\b/.test(trimmed)) continue;
      const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
      if (call) calls.push({ name: call[1], snippet: match[1] });
    }
  }
  return calls;
}

/** Identifiants DOM déclarés dans un texte : `id="quelque-chose"` littéral. */
function declaredIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\sid\s*=\s*"([^"${}]+)"/g)) ids.add(m[1]);
  return ids;
}

/** Appels `$('identifiant')` — seuls les identifiants littéraux sont vérifiables. */
function dollarLookups(code) {
  return [...code.matchAll(/\$\(\s*'([^'${}]+)'\s*\)/g)].map((m) => m[1]);
}

const APP_CODE = APP_SCRIPTS.map((f) => sources[f]).join('\n');
const APP_FUNCTIONS = new Set(
  APP_SCRIPTS.flatMap((f) => [...declaredFunctions(sources[f])])
);

// ---------------------------------------------------------------------------
// 2. Gestionnaires inline
// ---------------------------------------------------------------------------

test('chaque gestionnaire inline d\'app.html appelle une fonction existante', () => {
  const manquantes = inlineHandlerCalls(appHtml).filter((c) => !APP_FUNCTIONS.has(c.name));
  assert.deepEqual(
    manquantes.map((c) => `${c.name}() — ${c.snippet}`),
    [],
    'gestionnaires d\'app.html sans fonction correspondante'
  );
});

test('chaque gestionnaire inline produit par le JS appelle une fonction existante', () => {
  const manquantes = [];
  for (const file of APP_SCRIPTS) {
    for (const call of inlineHandlerCalls(sources[file])) {
      if (!APP_FUNCTIONS.has(call.name)) manquantes.push(`${file} : ${call.name}() — ${call.snippet}`);
    }
  }
  assert.deepEqual(manquantes, [], 'gestionnaires générés sans fonction correspondante');
});

test('chaque gestionnaire de login.html appelle une fonction de login.js', () => {
  const loginFunctions = declaredFunctions(sources['login.js']);
  const manquantes = inlineHandlerCalls(loginHtml)
    .filter((c) => !loginFunctions.has(c.name))
    .map((c) => c.name);
  assert.deepEqual(manquantes, []);
});

// ---------------------------------------------------------------------------
// 3. Identifiants DOM
// ---------------------------------------------------------------------------

test('chaque identifiant DOM référencé par $(\'…\') existe quelque part', () => {
  // Les identifiants viennent d'app.html ou d'un gabarit produit par le JS.
  const known = new Set([...declaredIds(appHtml)]);
  for (const file of APP_SCRIPTS) {
    for (const id of declaredIds(sources[file])) known.add(id);
  }

  const inconnus = [];
  for (const file of APP_SCRIPTS) {
    for (const id of dollarLookups(sources[file])) {
      if (!known.has(id)) inconnus.push(`${file} : $('${id}')`);
    }
  }
  assert.deepEqual(inconnus, [], 'identifiants DOM référencés mais jamais créés');
});

test('les identifiants d\'app.html sont uniques', () => {
  const vus = new Map();
  const doublons = [];
  for (const m of appHtml.matchAll(/\sid\s*=\s*"([^"${}]+)"/g)) {
    if (vus.has(m[1])) doublons.push(m[1]);
    vus.set(m[1], true);
  }
  assert.deepEqual(doublons, [], 'identifiants dupliqués dans app.html');
});

// ---------------------------------------------------------------------------
// 4. Balises correctement imbriquées
// ---------------------------------------------------------------------------

test('les balises d\'app.html sont correctement imbriquées', () => {
  assert.deepEqual(nestingErrors(appHtml), []);
});

test('les balises de login.html sont correctement imbriquées', () => {
  assert.deepEqual(nestingErrors(loginHtml), []);
});

test('le détecteur d\'imbrication attrape bien un div en trop', () => {
  // Sans cette vérification, le test précédent pourrait passer à vide.
  assert.deepEqual(nestingErrors('<div><span>x</span>'), ['<div> jamais fermé']);
  assert.equal(nestingErrors('<div>x</div></div>').length, 1);
  assert.deepEqual(nestingErrors('<div><input value="x"><br>ok</div>'), []);
});

// ---------------------------------------------------------------------------
// 5. Structure des écrans d'administration
// ---------------------------------------------------------------------------

test('chaque entrée du menu Paramètres a sa page et son rendu', () => {
  const menuPages = [...appHtml.matchAll(/data-apage="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(menuPages.includes('smtp'), 'le menu SMTP du lot 2 doit exister');

  for (const page of menuPages) {
    assert.ok(
      appHtml.includes(`id="apage-${page}"`),
      `le menu « ${page} » n'a pas de page correspondante`
    );
    assert.ok(
      new RegExp(`\\b${page}:\\s*\\w`).test(APP_CODE),
      `le menu « ${page} » n'a pas de fonction de rendu dans showAdminPage()`
    );
  }
});

test('les conteneurs des écrans réorganisés par le lot 2 sont en place', () => {
  const attendus = [
    // Utilisateurs en onglets
    'users-tab-comptes',
    'users-tab-suppressions',
    'users-tab-avatars',
    // Applications : bascule cartes / liste
    'apps-view-cards',
    'apps-view-list',
    // Stockage en deux lignes
    'admin-storage-summary',
    'admin-storage-list',
    // Sécurité en onglets
    'security-subnav',
    // SMTP en deux colonnes
    'smtp-config',
    'smtp-templates',
    // Support en deux colonnes
    'support-list',
    'support-detail',
  ];
  const ids = declaredIds(appHtml);
  for (const id of attendus) {
    assert.ok(ids.has(id), `app.html devrait porter #${id}`);
  }
});

test('les mises en page du lot 2 s\'appuient sur des classes définies', () => {
  const css = read('style.css');
  for (const klass of [
    'split-2',
    'dest-grid',
    'storage-strip',
    'col-placeholder',
    'cell-ellipsis',
    'mail-preview',
    'var-chip',
  ]) {
    assert.ok(css.includes(`.${klass}`), `classe .${klass} absente de style.css`);
    assert.ok(
      appHtml.includes(klass) || APP_CODE.includes(klass),
      `classe .${klass} définie mais jamais utilisée`
    );
  }

  // Le repli en une colonne sur écran étroit est explicite.
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
});

test('les surfaces et les textes des gabarits passent par les variables de thème', () => {
  // Une couleur littérale posée en style inline serait figée : illisible dans
  // l'un des deux thèmes. Les seules couleurs littérales admises sont celles
  // qui identifient quelque chose (palette d'avatars, couleur de marque d'une
  // destination), et elles arrivent toujours par interpolation.
  const suspectes = [];

  for (const file of APP_SCRIPTS) {
    for (const m of sources[file].matchAll(/style="([^"]*)"/g)) {
      const declarations = m[1];
      for (const decl of declarations.matchAll(/(background|background-color|color|border-color)\s*:\s*([^;"]+)/g)) {
        const value = decl[2].trim();
        if (value.startsWith('#') || /^rgb/i.test(value)) {
          suspectes.push(`${file} : ${decl[0].trim()}`);
        }
      }
    }
  }

  assert.deepEqual(suspectes, [], 'couleurs figées en style inline : utiliser var(--…)');
});
