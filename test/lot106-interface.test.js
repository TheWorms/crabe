'use strict';

/**
 * Lot 106, R2 (écran) — l'entrée « Interface » du Profil.
 *
 * Juste après « Général » ; deux cartes à choix unique, chacune enregistrée
 * au clic et dite.
 *
 * Modifié par décision au lot 107 : l'explorateur est livré — sa carte perd
 * « Arrive bientôt » et se choisit, et « Mes documents » suit le réglage
 * (l'interface de base, inchangée à l'octet : lot107-base-inchangee).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, contraste, couleursDe, debordement, fermerNavigateur } = require('./lot106-commun');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.html'), 'utf8');

// Le stockage local des essais, nommé en un seul endroit (comme au lot 98).
const LOCAL = 'local';
const DEPOSE = JSON.stringify({ [LOCAL]: { state: 'ok' } });

let titulaire;

test.before(async () => {
  await helpers.setup();
  titulaire = await helpers.createUser({ username: 'titulaire' });
  // L'espace de stockage local des essais doit exister
  // pour que « Mes documents » le lise.
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  // Deux documents inventés, pour que « Mes documents » ait quelque chose à montrer.
  const ins = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, destinations)
     VALUES (?, 'free', ?, 'defaut', 2048, ?, ?)`
  );
  ins.run(titulaire.id, '2026-09_facture_essai_a.pdf', '2026-09-03', DEPOSE);
  ins.run(titulaire.id, '2026-08_facture_essai_b.pdf', '2026-08-03', DEPOSE);
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

const regler = (valeur) =>
  helpers.db.get().prepare('UPDATE users SET documents_ui = ? WHERE id = ?').run(valeur, titulaire.id);

test('R2 — « Interface » est la deuxième entrée du Profil, juste après « Général », et c\'est un lien (lot 108 : une adresse par section)', () => {
  const nav = APP_HTML.slice(APP_HTML.indexOf('id="profil-sidebar"'), APP_HTML.indexOf('<div class="settings-content">'));
  const entrees = [...nav.matchAll(/data-ppage="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(entrees.slice(0, 3), ['general', 'interface', 'stockage']);
  // Lot 108 (modifié par décision) : l'entrée était un `<button>` ; elle est
  // devenue un vrai lien, qui porte l'adresse de la section.
  assert.match(nav, /<a class="settings-nav-item" href="\/profil\/interface" data-ppage="interface" onclick="return lienDeSection\(event, this\)">Interface<\/a>/);
  assert.match(APP_HTML, /id="interface-choix" role="radiogroup" aria-label="Interface des documents"/);
});

for (const clair of [false, true]) {
  test(`R2 — au vrai Chromium, thème ${clair ? 'clair' : 'sombre'} : deux cartes, chacune enregistrée au clic et dite (lot 107 : l'explorateur se choisit)`, AVEC_NAVIGATEUR, async (t) => {
    regler('base');
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { clair });
    t.after(fermer);

    await page.click('#tb-profil');
    await page.click('#menu-compte-profil');
    await page.click('[data-ppage="interface"]');
    assert.equal(await page.isVisible('#ppage-interface'), true);
    assert.equal(await page.textContent('#profil-menu-label'), 'Interface');

    const cartes = await page.$$eval('#interface-choix [role="radio"]', (l) => l.map((c) => ({
      id: c.id, coche: c.getAttribute('aria-checked'), inactive: c.disabled, texte: c.innerText.replace(/\s+/g, ' ').trim(),
    })));
    assert.equal(cartes.length, 2);
    assert.deepEqual(cartes.map((c) => [c.id, c.coche, c.inactive]), [
      ['interface-base', 'true', false],
      ['interface-explorer', 'false', false],
    ]);
    assert.match(cartes[0].texte, /Interface de base.*Les documents rangés par service, en cartes : l'affichage actuel de crabe\./);
    assert.match(cartes[1].texte, /Interface explorateur.*arbre des services et des années/);
    assert.equal(cartes[1].texte.includes('Arrive bientôt'), false, 'lot 107 : l\'explorateur est livré');
    assert.equal(await page.textContent('#interface-etat'), 'Actuellement : Interface de base.');

    // L'explorateur, au clic : enregistré, et dit (lot 107).
    let appels = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/auth/profile')) appels += 1; });
    await page.click('#interface-explorer');
    await page.waitForFunction(() => /Interface explorateur — enregistrée sur votre compte/.test(document.getElementById('interface-etat').textContent));
    assert.equal(appels, 1);
    assert.equal(await page.getAttribute('#interface-explorer', 'aria-checked'), 'true');

    // La base, au clic : enregistrée, et dite.
    await page.click('#interface-base');
    await page.waitForFunction(() => /Interface de base — enregistrée sur votre compte/.test(document.getElementById('interface-etat').textContent));
    assert.equal(appels, 2);
    assert.equal(await page.textContent('#interface-etat'), 'Interface de base — enregistrée sur votre compte.');
    await page.waitForFunction(() => /Interface des documents : Interface de base \(enregistrée sur votre compte\)/.test(document.getElementById('toast').textContent));

    // Lisible dans le thème : titres, aides, croquis, phrase d'état.
    for (const sel of ['#interface-base .interface-titre', '#interface-base .interface-aide', '#interface-explorer .interface-aide', '#interface-explorer .interface-croquis', '#interface-etat']) {
      const { texte, fond } = await couleursDe(page, sel);
      assert.ok(contraste(texte, fond) >= 4.5, `${sel} : ${contraste(texte, fond).toFixed(2)}`);
    }
    assert.deepEqual(erreursJs, []);
  });
}

test('R2 — un compte réglé sur « explorer » (par la route) le voit coché, et l\'écran le dit (lot 107 : sans « en attendant »)', AVEC_NAVIGATEUR, async (t) => {
  regler('explorer');
  t.after(() => regler('base'));
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 390, hauteur: 844 });
  t.after(fermer);
  await page.evaluate(() => { showView('profil'); showProfilPage('interface', document.querySelector('[data-ppage="interface"]')); });
  assert.equal(await page.getAttribute('#interface-explorer', 'aria-checked'), 'true');
  assert.equal(await page.getAttribute('#interface-base', 'aria-checked'), 'false');
  assert.equal(await page.textContent('#interface-etat'), 'Actuellement : Interface explorateur.');
  const d = await debordement(page);
  assert.ok(d.scroll <= d.largeur, `aucun débordement à 390 : ${d.fautifs.join(' ; ')}`);
});

test('R2 — « Mes documents » suit le réglage (lot 107) : la base en cartes, l\'explorateur sinon', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const rendu = async (valeur) => {
    regler(valeur);
    const { page, fermer } = await ouvrirCrabe(client, 'titulaire');
    try {
      await page.evaluate(() => showView('documents'));
      await page.waitForFunction(() => document.getElementById('docs-content').innerHTML.length > 200);
      await page.waitForTimeout(300);
      return await page.$eval('#docs-content', (e) => e.innerHTML);
    } finally {
      await fermer();
    }
  };
  const base = await rendu('base');
  const explorateur = await rendu('explorer');
  regler('base');
  assert.ok(base.length > 200);
  assert.match(base, /Free/, `les documents de l'essai sont rangés sous leur service : ${base.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 900)}`);
  // Modifié par décision au lot 107 : les deux réglages ne donnent plus le
  // même écran. L'interface de base, elle, est comparée à l'octet à celle
  // d'avant le lot par lot107-base-inchangee.
  assert.notEqual(explorateur, base);
  assert.match(base, /docs-filters/);
  assert.match(explorateur, /id="explo"/);
  assert.equal(explorateur.includes('docs-filters'), false);
});
