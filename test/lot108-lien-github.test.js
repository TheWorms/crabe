'use strict';

/**
 * Lot 108, R5 — le lien « Voir la version sur GitHub » de la fenêtre
 * « Vérifier les mises à jour ».
 *
 * L'adresse du dépôt public est UNE constante (`version.DEPOT_PUBLIC`), lue
 * par la vérification et par le lien. Le lien n'existe que pour une version
 * DISPONIBLE, quand le dépôt interrogé est le dépôt public : l'adresse donnée
 * par GitHub (`html_url`) si elle est sur ce dépôt, la page des versions
 * sinon ; une adresse étrangère est refusée. GitHub est SIMULÉ dans le
 * processus (le serveur d'essai y tourne) : aucun appel réel, et l'adresse
 * interrogée est relevée — une seule, la même qu'avant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const version = require('../server/version');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

const VRAI_FETCH = globalThis.fetch;
const sortants = [];
let reponseGithub = null;
const PAGE_DES_VERSIONS = 'https://github.com/TheWorms/crabe/releases';

/** Les tags tels que GitHub les rend ; `pages` : un `html_url` par nom. */
const tags = (noms, pages = {}) => ({
  ok: true,
  json: async () => noms.map((name) => ({ name, ...(pages[name] ? { html_url: pages[name] } : {}) })),
});

let client;

test.before(async () => {
  globalThis.fetch = async (adresse, options) => {
    const texte = String(adresse?.url ?? adresse);
    if (texte.startsWith('http://127.0.0.1')) return VRAI_FETCH(adresse, options);
    sortants.push(texte);
    if (reponseGithub instanceof Error) throw reponseGithub;
    if (!reponseGithub) throw new Error('aucune réponse simulée');
    return reponseGithub;
  };
  await helpers.setup();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  client = await helpers.startServer();
});

test.after(async () => {
  globalThis.fetch = VRAI_FETCH;
  delete process.env.CRABE_UPDATE_REPO;
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

test('R5 — l\'adresse du dépôt est une constante unique du code', () => {
  assert.equal(version.DEPOT_PUBLIC, 'TheWorms/crabe');
  assert.equal(version.ADRESSE_DEPOT_PUBLIC, 'https://github.com/TheWorms/crabe');
  // Nulle part ailleurs dans le serveur ni dans l'écran.
  const racine = path.join(__dirname, '..');
  const vus = [];
  const parcourir = (dossier) => {
    for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
      const p = path.join(dossier, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (/\.(js|html|css)$/.test(e.name) && /TheWorms\/crabe|github\.com\/TheWorms/.test(fs.readFileSync(p, 'utf8'))) vus.push(path.relative(racine, p));
    }
  };
  parcourir(path.join(racine, 'server'));
  parcourir(path.join(racine, 'web'));
  assert.deepEqual(vus, [path.join('server', 'version.js')]);
});

test('R5 — lienDeVersion : le dépôt public seul, l\'adresse de GitHub si elle est sur ce dépôt, la page des versions sinon', () => {
  const l = (url, depot = 'TheWorms/crabe') => version.lienDeVersion(depot, url);
  // Une adresse conforme est prise telle quelle.
  assert.equal(l('https://github.com/TheWorms/crabe/releases/tag/v0.1.8'), 'https://github.com/TheWorms/crabe/releases/tag/v0.1.8');
  // Aucune adresse : la page des versions.
  for (const rien of [undefined, null, '', 42, {}]) assert.equal(l(rien), PAGE_DES_VERSIONS);
  // Une adresse étrangère, ou qui sort du dépôt une fois lue : refusée.
  for (const etrangere of [
    'https://github.com/autre/crabe/releases/tag/v0.1.8',
    'https://github.com/TheWorms/crabe-faux/releases/tag/v0.1.8',
    'https://github.com/TheWorms/crabe',
    'https://github.com/TheWorms/crabe/../../autre/depot',
    'https://github.com/TheWorms/crabe/%2e%2e/%2e%2e/autre',
    'http://github.com/TheWorms/crabe/releases',
    'https://github.com.exemple.invalid/TheWorms/crabe/releases',
    'https://exemple.invalid/https://github.com/TheWorms/crabe/',
    'https://github.com/TheWorms/crabe/x" onmouseover="alert(1)',
    'https://github.com/TheWorms/crabe/<script>',
    'javascript:alert(1)//https://github.com/TheWorms/crabe/',
    ` https://github.com/TheWorms/crabe/releases`,
  ]) {
    assert.equal(l(etrangere), PAGE_DES_VERSIONS, etrangere);
  }
  // Un autre dépôt interrogé : aucun lien du tout.
  assert.equal(l('https://github.com/TheWorms/crabe/releases', 'qui/quoi'), null);
  assert.equal(l(undefined, ''), null);
  // Les noms de dépôt GitHub ne distinguent pas la casse.
  assert.equal(l(undefined, version.DEPOT_PUBLIC.toUpperCase()), PAGE_DES_VERSIONS);
  assert.equal(l(undefined, version.DEPOT_PUBLIC.toLowerCase()), PAGE_DES_VERSIONS);
});

test('R5 — verifierEnDetail : le lien accompagne une version disponible sur le dépôt public, et elle seule', async () => {
  const appels = [];
  const faux = (r) => async (url) => { appels.push(url); if (r instanceof Error) throw r; return r; };
  const cas = [
    [tags(['v9.9.9', 'v0.0.1']), { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9', lien: PAGE_DES_VERSIONS }],
    [tags(['v9.9.9'], { 'v9.9.9': 'https://github.com/TheWorms/crabe/releases/tag/v9.9.9' }),
      { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9', lien: 'https://github.com/TheWorms/crabe/releases/tag/v9.9.9' }],
    // L'adresse est celle de la version RETENUE, pas d'une autre.
    [tags(['v0.0.1', 'v9.9.9'], { 'v0.0.1': 'https://github.com/TheWorms/crabe/releases/tag/v0.0.1' }),
      { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9', lien: PAGE_DES_VERSIONS }],
    [tags(['v9.9.9'], { 'v9.9.9': 'https://github.com/autre/depot/releases/tag/v9.9.9' }),
      { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9', lien: PAGE_DES_VERSIONS }],
    [tags([`v${version.VERSION}`], { [`v${version.VERSION}`]: 'https://github.com/TheWorms/crabe/releases/tag/x' }),
      { etat: 'a-jour', installee: version.VERSION, trouvee: version.VERSION }],
    [new Error('réseau coupé'), { etat: 'impossible', installee: version.VERSION }],
  ];
  for (const [reponse, attendu] of cas) {
    version.oublierVerification();
    assert.deepEqual(await version.verifierEnDetail({ fetchImpl: faux(reponse), repo: 'TheWorms/crabe' }), attendu, JSON.stringify(attendu));
  }
  // Un autre dépôt : le détail d'avant, sans clé `lien`.
  version.oublierVerification();
  assert.deepEqual(await version.verifierEnDetail({ fetchImpl: faux(tags(['v9.9.9'])), repo: 'qui/quoi' }),
    { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9' });
  // Aucun appel de plus : une seule adresse par vérification, celle de l'API.
  assert.equal(appels.length, cas.length + 1);
  assert.ok(appels.slice(0, cas.length).every((u) => u === 'https://api.github.com/repos/TheWorms/crabe/tags?per_page=100'), appels.join(' | '));
});

test('R5 — la route : le lien dans l\'état « disponible » seulement, et seulement depuis le dépôt public', async () => {
  const c = await helpers.startServer();
  try {
    await helpers.login(c, 'gerante', 'MotDePasse1');
    process.env.CRABE_UPDATE_REPO = 'TheWorms/crabe';
    sortants.length = 0;
    for (const [reponse, etat, lien] of [
      [tags(['v9.9.9']), 'disponible', PAGE_DES_VERSIONS],
      [tags(['v9.9.9'], { 'v9.9.9': 'https://github.com/TheWorms/crabe/releases/tag/v9.9.9' }), 'disponible', 'https://github.com/TheWorms/crabe/releases/tag/v9.9.9'],
      [tags(['v9.9.9'], { 'v9.9.9': 'https://github.com/autre/depot/releases/tag/v9.9.9' }), 'disponible', PAGE_DES_VERSIONS],
      [tags([`v${version.VERSION}`]), 'a-jour', null],
      [new Error('réseau coupé'), 'impossible', null],
    ]) {
      reponseGithub = reponse;
      const r = await c.post('/api/system/update-check');
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.etat, r.body.lien], [etat, lien]);
    }
    assert.ok(sortants.every((u) => u === 'https://api.github.com/repos/TheWorms/crabe/tags?per_page=100'), sortants.join(' | '));

    process.env.CRABE_UPDATE_REPO = 'qui/quoi';
    reponseGithub = tags(['v9.9.9']);
    const autre = await c.post('/api/system/update-check');
    assert.deepEqual([autre.body.etat, autre.body.lien], ['disponible', null], 'un autre dépôt : aucun lien');

    delete process.env.CRABE_UPDATE_REPO;
    const coupee = await c.post('/api/system/update-check');
    assert.deepEqual([coupee.body.etat, coupee.body.lien], ['coupee', null]);
  } finally {
    delete process.env.CRABE_UPDATE_REPO;
    await c.close();
  }
});

test('R5 — au vrai Chromium : « Voir la version sur GitHub » dans l\'état « disponible », nouvel onglet, sans référent — et nulle part ailleurs', AVEC_NAVIGATEUR, async (t) => {
  process.env.CRABE_UPDATE_REPO = 'TheWorms/crabe';
  t.after(() => { delete process.env.CRABE_UPDATE_REPO; });
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante', { chemin: '/administration/systeme' });
  t.after(fermer);
  const verifier = async () => {
    await page.waitForSelector('#systeme-verifier-maj');
    await page.click('#systeme-verifier-maj');
    await page.waitForFunction(() => !document.getElementById('maj-dialog').hasAttribute('aria-busy'));
  };
  const fermerFenetre = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('maj-overlay').classList.contains('show')); };

  reponseGithub = tags(['v9.9.9']);
  await verifier();
  assert.match(await page.innerText('#maj-corps'), /Une mise à jour est disponible/);
  const lien = page.locator('#maj-corps a.maj-lien');
  assert.equal(await lien.count(), 1);
  assert.equal((await lien.innerText()).trim(), 'Voir la version sur GitHub');
  assert.equal(await lien.getAttribute('href'), PAGE_DES_VERSIONS);
  assert.equal(await lien.getAttribute('target'), '_blank');
  assert.equal(await lien.getAttribute('rel'), 'noopener noreferrer');
  await fermerFenetre();

  // À jour, ou impossible : aucun lien.
  for (const reponse of [tags([`v${version.VERSION}`]), new Error('réseau coupé')]) {
    reponseGithub = reponse;
    await verifier();
    assert.equal(await page.locator('#maj-corps a').count(), 0);
    await fermerFenetre();
  }
  assert.deepEqual(erreursJs, []);
});
