'use strict';

/**
 * Lot 107, R1 — le choix de l'interface devient réel.
 *
 * Un compte neuf (qui n'a jamais ouvert son Profil) voit l'interface de
 * base ; la carte « Interface explorateur » du Profil se choisit et « Mes
 * documents » la suit ; le lien « Interface de base », au pied de
 * l'explorateur, ramène à la base sans rien à restaurer ; l'interface de base
 * ne reçoit aucun lien nouveau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { peupler } = require('./lot107-commun');

let client;
let neuve;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  neuve = await helpers.createUser({ username: 'neuve' });
  peupler(neuve, { fichiers: false });
  client = await helpers.startServer();
});

test.after(async () => {
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

const reglage = () => helpers.db.get().prepare('SELECT documents_ui FROM users WHERE id = ?').pluck().get(neuve.id);
const chemin = (page) => page.evaluate(() => `${location.pathname}${location.search}`);

test('R1 — un compte neuf voit l\'interface de base ; Profil › Interface › explorateur, puis le lien « Interface de base » : l\'aller et le retour', AVEC_NAVIGATEUR, async (t) => {
  assert.equal(reglage(), 'base', 'le défaut de la colonne');
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'neuve');
  t.after(fermer);

  // Sans jamais avoir ouvert son Profil : la base.
  await page.evaluate(() => showView('documents'));
  await page.waitForSelector('#docs-content .docs-filters');
  assert.equal(await page.locator('#explo').count(), 0);
  // La base ne reçoit aucun lien nouveau : rien n'y parle de l'explorateur.
  assert.equal(/explorateur/i.test(await page.textContent('#view-documents')), false);
  assert.equal(await page.locator('#view-documents [onclick*="Interface"], #view-documents [onclick*="explor"]').count(), 0);

  // Le Profil : la carte se choisit.
  await page.click('#tb-profil');
  await page.click('#menu-compte-profil');
  await page.click('[data-ppage="interface"]');
  await page.click('#interface-explorer');
  await page.waitForFunction(() => /Interface explorateur — enregistrée sur votre compte/.test(document.getElementById('interface-etat').textContent));
  assert.equal(reglage(), 'explorer');

  // « Mes documents » la suit.
  await page.click('#tb-documents');
  await page.waitForFunction(() => document.getElementById('explo-liste')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#explo').count(), 1);
  assert.equal(await chemin(page), '/documents');

  // Le secours, au pied de la carte.
  const lien = page.locator('#explo-pied .explo-lien-base');
  assert.equal(await lien.evaluate((b) => b.tagName), 'BUTTON');
  assert.equal((await lien.textContent()).trim(), 'Interface de base');
  await lien.click();
  await page.waitForSelector('#docs-content .docs-filters');
  assert.equal(reglage(), 'base');
  assert.equal(await page.locator('#explo').count(), 0);
  assert.equal(await chemin(page), '/', 'l\'interface de base n\'a pas d\'adresse');
  await page.waitForFunction(() => /Interface de base — enregistrée sur votre compte\. L'explorateur se choisit dans Profil › Interface\./.test(document.getElementById('toast').textContent));

  // Et le Profil le dit.
  await page.evaluate(() => { showView('profil'); showProfilPage('interface', document.querySelector('[data-ppage="interface"]')); });
  assert.equal(await page.getAttribute('#interface-base', 'aria-checked'), 'true');
  assert.equal(await page.getAttribute('#interface-explorer', 'aria-checked'), 'false');
  assert.deepEqual(erreursJs, []);
});

test('R1 — le retour à la base qui échoue (serveur muet) le dit, et l\'explorateur reste', AVEC_NAVIGATEUR, async (t) => {
  helpers.db.get().prepare("UPDATE users SET documents_ui = 'explorer' WHERE id = ?").run(neuve.id);
  t.after(() => helpers.db.get().prepare("UPDATE users SET documents_ui = 'base' WHERE id = ?").run(neuve.id));
  const { page, fermer } = await ouvrirCrabe(client, 'neuve');
  t.after(fermer);
  await page.evaluate(() => showView('documents'));
  await page.waitForFunction(() => document.getElementById('explo-liste')?.getAttribute('aria-busy') === 'false');
  await page.route('**/api/auth/profile', (route) => route.fulfill({ status: 503, json: { error: 'Le serveur ne répond pas pour le moment. Réessayez dans un instant.' } }));
  await page.click('#explo-pied .explo-lien-base');
  await page.waitForFunction(() => /Réessayez dans un instant/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('#explo').count(), 1);
  assert.equal(await page.isEnabled('#explo-pied .explo-lien-base'), true);
  assert.equal(reglage(), 'explorer');
});
