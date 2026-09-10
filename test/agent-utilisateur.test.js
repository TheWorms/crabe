'use strict';

/**
 * L'agent utilisateur, vérifié **partout** — pas seulement là où on l'a écrit.
 *
 * ─── Le constat qui a motivé ce fichier ──────────────────────────────────────
 *
 * En mode invisible, Playwright annonce de lui-même un agent contenant le mot
 * `HeadlessChrome`. Vérifié le 11/08/2026 contre Fantazia : **la même requête,
 * avec la même session**, renvoie `403` avec l'agent par défaut et `200` avec un
 * agent réaliste. Rien dans la réponse ne dit pourquoi — et le symptôme (`403`
 * à la récupération) ressemble trait pour trait à une session expirée, ce qui
 * envoie chercher très loin de la cause.
 *
 * Le lot 12 devait poser un agent réaliste sur tous les contextes. Le lot 13 le
 * VÉRIFIE, ce qui n'est pas la même chose : un connecteur ajouté demain
 * n'aurait aucune raison d'y penser, et son oubli ne se verrait qu'en
 * production, des semaines plus tard.
 *
 * ─── Comment c'est vérifié ───────────────────────────────────────────────────
 *
 * En lisant le CODE, et pas seulement en appelant les fonctions : un connecteur
 * qui n'est jamais exécuté par la suite de tests — parce qu'il exige un vrai
 * compte — passerait au travers de n'importe quel test comportemental. Toute
 * création de contexte de navigateur doit passer par
 * `browser-identity.optionsContexte()`.
 *
 * Le complément comportemental — ce qu'une vraie boutique reçoit vraiment — est
 * dans test/boutique-parcours.test.js, qui relève l'en-tête côté serveur.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../server/connectors/browser-identity');

const RACINE = path.join(__dirname, '..');

/** Tous les fichiers JavaScript de crabe, hors dépendances et tests. */
function fichiersSources(dossier = RACINE, trouves = []) {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'test', 'web'].includes(entree.name)) continue;
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) fichiersSources(chemin, trouves);
    else if (entree.name.endsWith('.js')) trouves.push(chemin);
  }
  return trouves;
}

/** Le code d'un fichier, commentaires retirés. */
function codeSeul(chemin) {
  return fs
    .readFileSync(chemin, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// §6 — aucun contexte sans agent explicite
// ---------------------------------------------------------------------------

test('aucun contexte de navigateur n\'est créé sans agent explicite', () => {
  const fautifs = [];
  const vus = [];

  for (const chemin of fichiersSources()) {
    const code = codeSeul(chemin);
    // `newContext(` et `launchPersistentContext(` : les deux seules façons
    // d'obtenir un contexte dans Playwright.
    const motif = /\.(newContext|launchPersistentContext)\s*\(/g;
    let trouve;
    while ((trouve = motif.exec(code)) !== null) {
      const relatif = path.relative(RACINE, chemin);
      // Les options du contexte se lisent dans les 400 caractères qui suivent :
      // c'est très large pour un appel qui tient en dix lignes.
      const suite = code.slice(trouve.index, trouve.index + 400);
      vus.push(relatif);
      if (!/optionsContexte\s*\(/.test(suite)) {
        fautifs.push(`${relatif} — ${trouve[1]}() sans identity.optionsContexte()`);
      }
    }
  }

  // Le test doit AUSSI échouer si plus rien n'est trouvé : un test qui ne
  // vérifie plus rien passe toujours, et c'est le pire des états.
  assert.ok(
    vus.length >= 8,
    `au moins huit créations de contexte attendues, ${vus.length} trouvée(s) : `
      + 'le motif de recherche a-t-il cessé de correspondre ?'
  );

  assert.deepEqual(
    fautifs,
    [],
    'chaque contexte doit passer par connectors/browser-identity.optionsContexte()'
  );
});

/**
 * Les huit endroits attendus, nommés.
 *
 * Une liste explicite plutôt qu'un simple compte : si un connecteur disparaît
 * de la liste des contextes vérifiés, on veut lire LEQUEL, pas « 7 au lieu de
 * 8 ». Les quatre connecteurs cités par la mission (`free`, `free-mobile`,
 * `amazon`, `impots`) y figurent nommément, ainsi que le navigateur distant.
 */
test('les huit ouvreurs de navigateur de crabe sont tous couverts', () => {
  const attendus = [
    'server/connectors/available/free/connector.js',
    'server/connectors/available/free-mobile/connector.js',
    'server/connectors/available/amazon/connector.js',
    'server/connectors/available/impots/connector.js',
    'server/connectors/available/atelier-du-portable/connector.js',
    'server/connectors/available/prestashop/connector.js',
    'server/connectors/scraping.js',
    'server/remote-browser.js',
    'tools/capture-session.js',
  ];

  for (const relatif of attendus) {
    const code = codeSeul(path.join(RACINE, relatif));
    assert.match(
      code,
      /\.newContext\s*\(\s*\n?\s*identity\.optionsContexte\s*\(/,
      `${relatif} doit ouvrir son contexte avec identity.optionsContexte()`
    );
  }
});

// ---------------------------------------------------------------------------
// Ce que l'agent dit, et ce qu'il ne dit pas
// ---------------------------------------------------------------------------

test('l\'agent ne contient jamais le mot qui fait tomber les pare-feux', () => {
  identity.oublier();
  const agent = identity.agentUtilisateur();

  assert.doesNotMatch(agent, /Headless/i, `l'agent trahit le navigateur : ${agent}`);
  assert.match(agent, /^Mozilla\/5\.0 \(X11; Linux x86_64\)/, agent);
  assert.match(agent, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/, agent);

  // La langue part avec, sur TOUS les contextes : les portails français
  // servent des pages anglaises à qui ne la demande pas, et les marqueurs
  // textuels des connecteurs (« Mes factures ») ne s'y retrouvent plus.
  const options = identity.optionsContexte();
  assert.equal(options.locale, 'fr-FR');
  assert.equal(options.userAgent, agent);
});

test('la version annoncée suit le Chromium embarqué, sans être écrite en dur', () => {
  identity.oublier();
  const embarque = identity.versionChromiumEmbarque();
  const agent = identity.agentUtilisateur();

  if (embarque) {
    // Un agent qui annonce Chrome 131 alors que le moteur est un Chrome 151
    // est un mensonge vérifiable : les en-têtes `Sec-CH-UA` que Chromium envoie
    // de lui-même portent sa VRAIE version, et l'écart est exactement ce qu'un
    // pare-feu applicatif relève.
    assert.ok(
      agent.includes(`Chrome/${embarque} `),
      `l'agent (${agent}) doit annoncer la version du Chromium embarqué (${embarque})`
    );
  } else {
    assert.ok(agent.includes(`Chrome/${identity.VERSION_DE_REPLI} `), agent);
  }

  // Le repli n'est employé QUE si le registre de Playwright est illisible.
  const source = fs.readFileSync(
    path.join(RACINE, 'server', 'connectors', 'browser-identity.js'),
    'utf8'
  );
  assert.match(source, /versionChromiumEmbarque\(\)\s*\|\|\s*VERSION_DE_REPLI/);
});

test('un connecteur peut imposer ses options, sans perdre l\'agent', () => {
  const options = identity.optionsContexte({ viewport: { width: 800, height: 600 } });
  assert.deepEqual(options.viewport, { width: 800, height: 600 });
  assert.ok(options.userAgent, 'l\'agent reste posé');

  // Et s'il le fallait vraiment, l'appelant a le dernier mot — c'est documenté,
  // et c'est ce qui évite qu'un connecteur recopie `userAgent` à la main pour
  // contourner ce module.
  assert.equal(
    identity.optionsContexte({ userAgent: 'crabe/test' }).userAgent,
    'crabe/test'
  );
});
