'use strict';

/**
 * Lot 106, R1 — le menu de l'avatar.
 *
 * L'avatar ouvre Mon profil, Administration (selon les droits d'aujourd'hui)
 * et Déconnexion ; l'engrenage et le bouton de déconnexion ont quitté la
 * barre. Mesuré dans un vrai Chromium, sur un serveur d'essai : ouverture au
 * clic et au clavier, fermeture à Échap, au clic à côté et au choix d'une
 * entrée, focus rendu à l'avatar, droits, déconnexion, téléphone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const { AVEC_NAVIGATEUR, ouvrirCrabe, contraste, couleursDe, debordement, fermerNavigateur } = require('./lot106-commun');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.html'), 'utf8');

test.before(async () => {
  await helpers.setup();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, gerante.id);
  await helpers.createUser({ username: 'titulaire' });
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

/** L'en-tête de la page, de la barre jusqu'au contenu. */
function enTete() {
  return APP_HTML.slice(APP_HTML.indexOf('<div class="topbar">'), APP_HTML.indexOf('<div class="content">'))
    .replace(/<!--[\s\S]*?-->/g, '');
}

test('R1 — la barre ne porte plus ni l\'engrenage, ni le bouton de déconnexion ; l\'avatar est un bouton de menu', () => {
  const barre = enTete();
  assert.doesNotMatch(barre, /id="tb-admin"/, 'l\'engrenage a quitté la barre');
  assert.doesNotMatch(barre, /id="tb-mobile-admin"/, 'et le panneau du téléphone');
  // Une seule déconnexion dans tout l'en-tête : l'entrée du menu du compte.
  assert.equal((barre.match(/Déconnexion/g) || []).length, 1);
  assert.equal((barre.match(/logout\(\)/g) || []).length, 0, 'aucun bouton de la barre n\'appelle logout()');
  assert.match(barre, /choisirMenuCompte\('deconnexion'\)[^>]*>[\s\S]*?Déconnexion/);
  const avatar = /<button[^>]*id="tb-profil"[^>]*>/.exec(barre)?.[0] || '';
  assert.match(avatar, /aria-haspopup="menu"/);
  assert.match(avatar, /aria-expanded="false"/);
  assert.match(avatar, /aria-controls="menu-compte"/);
  assert.match(avatar, /aria-label="Menu du compte"/);
  assert.match(barre, /id="menu-compte" role="menu" aria-labelledby="tb-profil" hidden/);
  assert.equal((barre.match(/role="menuitem"/g) || []).length, 3);
  // L'avatar n'est plus dans le bloc caché sous 640 px.
  const droite = barre.slice(barre.indexOf('class="tb-right tb-desktop-only"'));
  assert.ok(droite.indexOf('id="tb-profil"') > droite.indexOf('</div>'), 'l\'avatar est hors de .tb-right');
});

test('R1 — au vrai Chromium : ouverture, fermeture, focus, flèches (administratrice)', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante');
  t.after(fermer);

  const ouvert = () => page.$eval('#menu-compte', (m) => !m.hidden);
  const expanded = () => page.getAttribute('#tb-profil', 'aria-expanded');
  const focus = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

  assert.equal(await ouvert(), false);
  await page.click('#tb-profil');
  assert.equal(await ouvert(), true);
  assert.equal(await expanded(), 'true');
  assert.equal(await page.textContent('#menu-compte-nom'), 'gerante');
  assert.equal(await page.textContent('#menu-compte-role'), 'Administrateur');
  const visibles = await page.$$eval('#menu-compte [role="menuitem"]', (l) => l.filter((e) => !e.hidden && e.offsetParent).map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(visibles, ['Mon profil', 'Administration', 'Déconnexion']);
  assert.equal(await focus(), 'menu-compte-profil', 'le focus va sur la première entrée');

  // Les flèches, Origine, Fin — et la boucle.
  await page.keyboard.press('ArrowDown');
  assert.equal(await focus(), 'menu-compte-admin');
  await page.keyboard.press('End');
  assert.equal(await focus(), 'menu-compte-deconnexion');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focus(), 'menu-compte-profil');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focus(), 'menu-compte-deconnexion');
  await page.keyboard.press('Home');
  assert.equal(await focus(), 'menu-compte-profil');

  // Échap : fermé, focus rendu à l'avatar.
  await page.keyboard.press('Escape');
  assert.equal(await ouvert(), false);
  assert.equal(await expanded(), 'false');
  assert.equal(await focus(), 'tb-profil');

  // Au clavier depuis l'avatar : Entrée, Espace, flèche haut (dernière entrée).
  await page.keyboard.press('Enter');
  assert.equal(await ouvert(), true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  assert.equal(await ouvert(), true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  assert.equal(await ouvert(), true);
  assert.equal(await focus(), 'menu-compte-deconnexion');
  await page.keyboard.press('Escape');

  // Clic à côté : fermé.
  await page.click('#tb-profil');
  await page.mouse.click(400, 600);
  assert.equal(await ouvert(), false);
  assert.equal(await focus(), 'tb-profil');

  // Le choix d'une entrée : fermé, focus rendu, et l'écran voulu.
  await page.click('#tb-profil');
  await page.click('#menu-compte-profil');
  assert.equal(await ouvert(), false);
  assert.equal(await focus(), 'tb-profil');
  assert.equal(await page.$eval('#view-profil', (v) => v.classList.contains('active')), true);
  await page.click('#tb-profil');
  await page.click('#menu-compte-admin');
  assert.equal(await page.$eval('#view-admin', (v) => v.classList.contains('active')), true);

  // Le menu se ferme aussi quand on change d'écran autrement.
  await page.click('#tb-profil');
  await page.evaluate(() => showView('home'));
  assert.equal(await ouvert(), false);

  assert.deepEqual(erreursJs, []);
});

test('R1 — un compte sans accès à l\'Administration ne la voit nulle part ; la route reste gardée', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);

  await page.click('#tb-profil');
  assert.equal(await page.textContent('#menu-compte-role'), 'Utilisateur');
  assert.equal(await page.$eval('#menu-compte-admin', (e) => e.hidden), true);
  assert.equal(await page.isVisible('#menu-compte-admin'), false);
  const visibles = await page.$$eval('#menu-compte [role="menuitem"]', (l) => l.filter((e) => !e.hidden && e.offsetParent).map((e) => e.innerText.trim()));
  assert.deepEqual(visibles, ['Mon profil', 'Déconnexion']);
  // Et nulle part ailleurs sur la page : aucune entrée « Administration »
  // visible (lien, bouton, titre), aucun engrenage. Lot 108 (modifié par
  // décision) : la page a pris ce nom, et les phrases qui la désignaient comme
  // « Paramètres → Stockage » disent désormais « Administration → Stockage »
  // — une phrase n'est pas une porte.
  const ailleurs = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.offsetParent && e.children.length === 0 && /^\s*Administration\s*$/.test(e.textContent)).length);
  assert.equal(ailleurs, 0);
  const portes = await page.evaluate(() => [...document.querySelectorAll('a, button, [role="menuitem"]')]
    .filter((e) => e.offsetParent && /Administration/.test(e.textContent)).length);
  assert.equal(portes, 0);
  assert.equal(await page.locator('#tb-admin').count(), 0);
  // Les flèches sautent l'entrée cachée.
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-compte-deconnexion');

  // La route, elle, refuse comme avant.
  const r = await page.evaluate(async () => (await fetch('/api/admin/destinations')).status);
  assert.equal(r, 403);
  assert.deepEqual(erreursJs, []);
});

test('R1 — la déconnexion fait ce qu\'elle faisait : la session est détruite, retour à l\'écran de connexion', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);

  await page.click('#tb-profil');
  await Promise.all([
    page.waitForURL(`${client.base}/`),
    page.click('#menu-compte-deconnexion'),
  ]);
  await page.waitForSelector('#login-username');
  const statut = await page.evaluate(async () => (await fetch('/api/auth/me')).status);
  assert.equal(statut, 401);
});

for (const clair of [false, true]) {
  test(`R1, R6 — sur téléphone (390 px), thème ${clair ? 'clair' : 'sombre'} : l'avatar est là, le menu tient dans l'écran, le texte se lit`, AVEC_NAVIGATEUR, async (t) => {
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante', { largeur: 390, hauteur: 844, clair });
    t.after(fermer);

    assert.equal(await page.isVisible('#tb-profil'), true, 'l\'avatar est visible sur téléphone');
    await page.click('#tb-profil');
    const boite = await page.$eval('#menu-compte', (m) => m.getBoundingClientRect().toJSON());
    assert.ok(boite.left >= 0 && boite.right <= 390, `menu dans l'écran : ${boite.left} → ${boite.right}`);
    assert.ok(boite.bottom <= 844);
    for (const sel of ['#menu-compte-profil', '#menu-compte-admin', '#menu-compte-deconnexion', '#menu-compte-nom']) {
      const { texte, fond } = await couleursDe(page, sel);
      assert.ok(contraste(texte, fond) >= 4.5, `${sel} : contraste ${contraste(texte, fond).toFixed(2)}`);
    }
    const role = await couleursDe(page, '#menu-compte-role');
    assert.ok(contraste(role.texte, role.fond) >= 4.5, `rôle : ${contraste(role.texte, role.fond).toFixed(2)}`);
    // Le panneau latéral ne porte plus le compte.
    const panneau = await page.textContent('#tb-mobile-menu');
    assert.doesNotMatch(panneau, /Déconnexion|Paramètres|Profil/);
    const d = await debordement(page);
    assert.ok(d.scroll <= d.largeur, `aucun débordement : ${d.scroll} > ${d.largeur} — ${d.fautifs.join(' ; ')}`);
    assert.deepEqual(erreursJs, []);
  });
}
