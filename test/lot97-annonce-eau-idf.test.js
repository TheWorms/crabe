'use strict';

/**
 * Lot 97 — R5 : l'Eau d'Île-de-France entre dans les services annoncés.
 *
 * ─── Ce qui a été fait ───────────────────────────────────────────────────────
 *
 * Une annonce se déclare par un manifeste sous `server/connectors/planned/`
 * (le dossier fait foi) et une ligne de la table de `scripts/gen-planned.js`,
 * qui la reproduit à l'octet si on régénère. Son icône a été prise sur le site
 * du service par la seule requête permise du lot, en visiteur anonyme ; crabe
 * range les logos dans son dossier de données (Paramètres → Applications →
 * Logos), et la page des connecteurs en garde une copie en PNG
 * (`docs/icones/eau-ile-de-france.png`).
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 *   1. le manifeste est une annonce valide, au conditionnel, et la table du
 *      générateur le reproduit à l'octet ;
 *   2. le registre la charge comme annonce, et refuse de l'installer ;
 *   3. (D4) au VRAI Chromium : le Store la montre, « Bientôt disponible »,
 *      avec son icône une fois celle-ci envoyée par l'écran des logos — et le
 *      compte des services « à venir » la compte.
 *
 * ─── Lot 102 : l'annonce est devenue un connecteur ───────────────────────────
 *
 * Le lot 102 écrit le vrai connecteur (`available/eau-ile-de-france/`) et
 * retire l'annonce selon les quatre gestes du lot 99. Ce que ce fichier
 * verrouillait — une annonce — n'existe plus : ses essais disent désormais ce
 * qui en reste (le nom, le site, la catégorie, l'icône) et que l'annonce ne
 * ressuscite pas ; la tuile du Store est celle d'un connecteur en attente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');

const RACINE = path.join(__dirname, '..');
const ID = 'eau-ile-de-france';
const ANNONCE = path.join(RACINE, 'server', 'connectors', 'planned', ID, 'manifest.json');
const MANIFESTE = path.join(RACINE, 'server', 'connectors', 'available', ID, 'manifest.json');
const ICONE = path.join(RACINE, 'docs', 'icones', `${ID}.png`);

/** Les annonces livrées : les dossiers de `planned/` qui portent un manifeste. */
function annoncesDuDisque() {
  const dossier = path.join(RACINE, 'server', 'connectors', 'planned');
  return fs.readdirSync(dossier).filter((id) => fs.existsSync(path.join(dossier, id, 'manifest.json')));
}

/** Lot 103 : les annonces non faisables — celles qui portent un empêchement mesuré. */
function annoncesEmpechees() {
  const dossier = path.join(RACINE, 'server', 'connectors', 'planned');
  return annoncesDuDisque().filter((id) => String(
    JSON.parse(fs.readFileSync(path.join(dossier, id, 'manifest.json'), 'utf8')).unfeasible || ''
  ).trim());
}

/** Lot 106 : les connecteurs ÉCRITS déclarés non faisables (EDF, Engie…). */
function ecritsEmpeches() {
  const dossier = path.join(RACINE, 'server', 'connectors', 'available');
  return fs.readdirSync(dossier)
    .filter((id) => fs.existsSync(path.join(dossier, id, 'manifest.json')))
    .filter((id) => String(JSON.parse(fs.readFileSync(path.join(dossier, id, 'manifest.json'), 'utf8')).unfeasible || '').trim());
}

test('R5 → lot 102 — l\'annonce est devenue connecteur : même nom, même site, même catégorie ; plus de manifeste annoncé', () => {
  assert.equal(fs.existsSync(ANNONCE), false, 'le dossier planned/ est retiré (lot 102)');
  const m = JSON.parse(fs.readFileSync(MANIFESTE, 'utf8'));
  assert.equal(m.id, ID);
  assert.equal(m.name, 'Eau d\'Île-de-France');
  assert.equal(m.category, 'energie', 'la catégorie des autres services d\'eau (SAUR, Atlantic\'eau)');
  assert.equal(m.site, 'connexion.leaudiledefrance.fr');
  assert.equal(m.status, undefined, 'ce n\'est plus une annonce');
  assert.equal(m.initialStatus, 'pending', 'un connecteur jamais exercé contre un compte réel');
});

test('R5 → lot 102 — la table de gen-planned.js ne la porte plus : la relancer ne ressuscite pas l\'annonce', () => {
  const source = fs.readFileSync(path.join(RACINE, 'scripts', 'gen-planned.js'), 'utf8')
    .replace(/^#!.*\n/, '')
    .replace(/\nmain\(\);\s*$/, '\nmodule.exports = { SERVICES, manifestFor };\n');
  const module_ = { exports: {} };
  vm.runInThisContext(`(function (require, module, exports, __dirname) {${source}\n})`)(
    require, module_, module_.exports, path.join(RACINE, 'scripts')
  );
  assert.equal(module_.exports.SERVICES.some((s) => s.id === ID), false);
});

test('R5 → lot 102 — le registre la charge comme connecteur, plus comme annonce', async () => {
  await helpers.setup();
  const registry = require('../server/connectors/registry');
  assert.equal(registry.isPlanned(ID), false);
  assert.equal(registry.has(ID), true);
  const annonces = registry.listPlanned().map((c) => c.id);
  assert.equal(annonces.includes(ID), false);
  assert.equal(annonces.length, annoncesDuDisque().length, 'chaque manifeste annoncé est chargé');
  assert.doesNotThrow(() => registry.assertInstallable(ID), 'il s\'installe — en attente, pour un administrateur');
});

test('R5 — l\'icône de la page est acceptée par crabe comme logo', () => {
  const logos = require('../server/connectors/logos');
  const analyse = logos.analyserImage(fs.readFileSync(ICONE));
  assert.deepEqual(analyse, { ok: true, ext: 'png', width: 48, height: 48 });
});

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();

test('D4 → lot 102 — au vrai Chromium : le Store montre le connecteur à l\'administrateur, « Pas encore testé », avec son icône, sous « Énergie »',
  { skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.', timeout: 120_000 },
  async (t) => {
    await helpers.setup();
    t.after(() => helpers.teardown());
    await helpers.createUser({ username: 'lot97annonce', plainPassword: 'MotDePasse1', role: 'admin' });
    const client = await helpers.startServer();
    t.after(() => client.close());
    const reponse = await fetch(`${client.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lot97annonce', password: 'MotDePasse1' }),
    });
    const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
    assert.ok(brut, 'cookie de session absent');
    const cookie = brut.split(';')[0];

    // L'icône, envoyée par la route de Paramètres → Applications → Logos.
    const envoi = await fetch(`${client.base}/api/admin/connectors/${ID}/logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${fs.readFileSync(ICONE).toString('base64')}` }),
    });
    const resultat = await envoi.json();
    assert.equal(envoi.status, 200, JSON.stringify(resultat));
    assert.match(resultat.logo, new RegExp(`^/api/connectors/logos/${ID}\\.png\\?v=\\d+$`));

    const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
    t.after(() => navigateur.close());
    const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
    await contexte.addCookies([{ name: 'crabe.sid', value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
    const page = await contexte.newPage();
    const erreursJs = [];
    page.on('pageerror', (e) => erreursJs.push(String(e)));
    await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => showView('store'));
    await page.waitForSelector('#store-grid .card');

    assert.equal(await page.locator('#store-grid .card.planned', { hasText: 'Eau d\'Île-de-France' }).count(), 0,
      'plus de tuile « Bientôt disponible »');
    const tuile = page.locator('#store-grid .card:not(.planned)', { hasText: 'Eau d\'Île-de-France' });
    assert.equal(await tuile.count(), 1, 'une tuile, et une seule');
    assert.equal((await tuile.locator('.card-status').textContent()).replace(/\s+/g, ' ').trim(), 'Pas encore testé');
    const image = tuile.locator('img.logo-img');
    assert.equal(await image.count(), 1, 'la tuile porte son icône');
    assert.match(await image.getAttribute('src'), new RegExp(`^/api/connectors/logos/${ID}\\.png`));
    assert.ok(await image.evaluate((img) => img.complete && img.naturalWidth === 48), 'l\'icône s\'affiche');
    // Rangée avec les autres services d'eau, sous « Énergie ».
    const categorie = await tuile.evaluate((e) => e.closest('.cat-block')?.querySelector('.cat-title')?.textContent.trim());
    assert.equal(categorie, 'Énergie');
    // Le compte du Store : chaque annonce livrée y est — depuis le lot 103,
    // les non faisables à part des « à venir ».
    const compte = (await page.textContent('#store-count')).trim();
    t.diagnostic(`compte du Store : ${compte}`);
    const empechees = annoncesEmpechees().length;
    // Lot 108, par décision : les non faisables (annonces et connecteurs
    // écrits) ont quitté le logiciel — le sous-titre ne les compte plus.
    assert.match(compte, new RegExp(`, ${annoncesDuDisque().length - empechees} à venir$`));
    assert.ok(ecritsEmpeches().length > 0);
    assert.deepEqual(erreursJs, [], 'aucune erreur JavaScript dans la page');
  });
