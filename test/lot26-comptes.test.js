'use strict';

/**
 * « Le compte n'est pas bon » — lot 26.
 *
 * ─── Deux signalements, une même cause, et ce n'était pas celle qu'on croyait ─
 *
 * Signalé sur Infomaniak et sur OVHcloud, séparément. Dans les deux cas le
 * connecteur remontait le BON identifiant : mesuré sur l'installation réelle,
 * Infomaniak range ses documents sous 854637, 880049 et 2036138 — ses trois
 * organisations —, OVHcloud sous son nichandle. C'est l'AFFICHAGE qui était en
 * tort, de deux façons :
 *
 *   1. **La ligne « Compte » de chaque fiche affichait « — », pour tous les
 *      services, depuis toujours.** L'identifiant n'était simplement jamais
 *      envoyé au client : la carte promettait une information qu'elle n'avait
 *      pas. Devant un tiret, « le compte n'est pas bon » est la seule
 *      conclusion possible.
 *
 *   2. **Un numéro d'organisation ne se reconnaît pas.** « 854637 » ne dit rien
 *      à personne ; chez Infomaniak cette organisation s'appelle « Koody ». Le
 *      nom était pourtant déjà relevé par la découverte — il ne franchissait
 *      pas la frontière des écrans qui affichent un compte.
 *
 * La règle retenue est celle de Free Mobile : **le nom ET l'identifiant**,
 * jamais l'un sans l'autre. Le nom se reconnaît, l'identifiant tranche entre
 * deux comptes qui se ressemblent — et c'est lui qui nomme le dossier sur le
 * stockage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');
const documents = require('../server/documents');
const registry = require('../server/connectors/registry');
const discovery = require('../server/connectors/discovery');
const db = require('../server/db/db');

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'comptes-nommes', role: 'admin' });
  registry.load();
  registry.syncCatalog();
});

test.after(() => helpers.teardown());

/** Les trois organisations réelles, telles que la découverte les enregistre. */
function poserLesTroisOrganisations() {
  discovery.save(compte.id, 'infomaniak', 'organisations', [
    { id: '854637', label: 'Koody' },
    { id: '880049', label: 'ES Production' },
    { id: '2036138', label: 'Ouest Anti Nuisibles' },
  ]);
}

/** Une facture rangée sous un compte donné. */
function poserFacture(connectorId, accountId, filename) {
  db.get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, fetched_at, destinations)
       VALUES (?, ?, ?, ?, ?, 1000, '2026-06-01', datetime('now'), '{}')`
    )
    .run(compte.id, connectorId, filename, filename, accountId);
}

// ---------------------------------------------------------------------------
// « Mes documents » — l'arbre nomme ses comptes
// ---------------------------------------------------------------------------

test('l\'arbre des documents montre le nom de l\'organisation, pas seulement son numéro', () => {
  poserLesTroisOrganisations();

  const docs = [
    { connectorId: 'infomaniak', connectorName: 'Infomaniak', accountId: '854637', filename: 'a.pdf' },
    { connectorId: 'infomaniak', connectorName: 'Infomaniak', accountId: '2036138', filename: 'b.pdf' },
  ];

  const noms = documents.nomsDeComptesConnus(compte.id, ['infomaniak']);
  const arbre = documents.toTree(docs, noms);

  const libelles = arbre[0].accounts.map((c) => c.label).sort();
  assert.deepEqual(
    libelles,
    ['Koody · 854637', 'Ouest Anti Nuisibles · 2036138'],
    'devant « 854637 » seul, impossible de savoir quelle organisation on regarde'
  );

  // L'identifiant reste intact : c'est lui qui nomme le dossier sur le
  // stockage et qui sert de clé au repli mémorisé.
  assert.deepEqual(arbre[0].accounts.map((c) => c.accountId).sort(), ['2036138', '854637']);
});

test('un service sans découverte garde son identifiant, sans invention', () => {
  // OVHcloud n'a pas d'étape de découverte : son nichandle est déjà ce que le
  // manager du fournisseur affiche. Rien à ajouter, et surtout rien à inventer.
  const noms = documents.nomsDeComptesConnus(compte.id, ['ovh']);
  const arbre = documents.toTree(
    [{ connectorId: 'ovh', connectorName: 'OVHcloud', accountId: 'ab1234-ovh', filename: 'f.pdf' }],
    noms
  );
  assert.equal(arbre[0].accounts[0].label, 'ab1234-ovh');
  assert.equal(arbre[0].accounts[0].accountName, null);
});

test('un compte sans identifiant reste lisible plutôt que « defaut »', () => {
  const arbre = documents.toTree(
    [{ connectorId: 'mistral', connectorName: 'Mistral', accountId: '', filename: 'f.pdf' }],
    new Map()
  );
  assert.equal(arbre[0].accounts[0].label, 'Votre compte');
});

// ---------------------------------------------------------------------------
// La fiche d'un service — ce qu'elle reçoit vraiment
// ---------------------------------------------------------------------------

test('le catalogue envoie enfin les comptes au client, nommés', () => {
  poserLesTroisOrganisations();
  registry.install(compte.id, 'infomaniak');
  poserFacture('infomaniak', '854637', 'i-1.pdf');
  poserFacture('infomaniak', '854637', 'i-2.pdf');
  poserFacture('infomaniak', '2036138', 'i-3.pdf');

  const fiche = registry.listForUser(compte).find((c) => c.id === 'infomaniak');

  // ⚠ Le défaut d'origine : cette clé n'existait pas, et la carte affichait
  // « — » pour tout le monde.
  assert.ok(Array.isArray(fiche.accounts), 'la fiche doit porter la liste de ses comptes');
  assert.deepEqual(
    fiche.accounts.map((a) => [a.id, a.name, a.count]),
    [['854637', 'Koody', 2], ['2036138', 'Ouest Anti Nuisibles', 1]],
    'le plus fourni d\'abord, chacun avec son nom et son nombre de documents'
  );

  registry.uninstall(compte.id, 'infomaniak');
  db.get().prepare('DELETE FROM invoices WHERE user_id = ?').run(compte.id);
});

// ---------------------------------------------------------------------------
// Le libellé, tel que la carte l'écrit — la VRAIE fonction de web/app.js
// ---------------------------------------------------------------------------

/** Charge `web/app.js` dans un bac à sable minimal et rend une expression. */
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
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  return vm.runInContext(expression, context);
}

test('la carte écrit le nom devant l\'identifiant, et compte le reste', () => {
  const trois = JSON.stringify({
    accountId: '854637',
    accounts: [
      { id: '854637', name: 'Koody', count: 77 },
      { id: '880049', name: 'ES Production', count: 12 },
      { id: '2036138', name: 'Ouest Anti Nuisibles', count: 3 },
    ],
  });

  assert.equal(
    dansLeFront(`libelleComptes(${trois})`),
    'Koody · 854637, ES Production · 880049 +1',
    'la carte s\'arrête à deux comptes : au-delà, la ligne déborderait'
  );
  assert.equal(
    dansLeFront(`libelleComptes(${trois}, true)`),
    'Koody · 854637, ES Production · 880049, Ouest Anti Nuisibles · 2036138',
    'l\'infobulle, elle, les montre tous'
  );
});

test('sans nom relevé, l\'identifiant seul — et jamais « defaut »', () => {
  assert.equal(
    dansLeFront("libelleComptes({ accountId: 'ab1234-ovh', accounts: [{ id: 'ab1234-ovh', name: null, count: 67 }] })"),
    'ab1234-ovh'
  );
  // `defaut` est un dossier de repli, pas un compte : l'afficher comme tel
  // ferait passer une absence d'information pour une information.
  assert.equal(
    dansLeFront("libelleComptes({ accountId: 'defaut', accounts: [{ id: 'defaut', name: null, count: 4 }] })"),
    '—'
  );
});
