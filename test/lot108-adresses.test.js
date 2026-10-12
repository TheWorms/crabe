'use strict';

/**
 * Lot 108, R1 — Profil et Administration en pleine page : une adresse par
 * section.
 *
 * Mesuré sur un serveur d'essai et dans un vrai Chromium : la coque est
 * servie à `/profil[/<section>]` et `/administration[/<section>]` (un compte
 * anonyme repart à la connexion, un compte sans droit d'administration à
 * l'accueil) ; une adresse directe ouvre la bonne section, avec son titre
 * d'onglet et `aria-current` ; le bouton Précédent revient à la section
 * d'avant ; une section inconnue mène à la première et remplace l'adresse ;
 * les anciennes portes (menu de l'avatar, bandeau des opérations, cloche,
 * `showView`/`showProfilPage`/`showAdminPage`) mènent à la nouvelle page.
 *
 * Aucune donnée réelle : comptes nommés par leur rôle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

/** Les sections, dans l'ordre de la navigation : nom interne, adresse, libellé. */
const PROFIL = [
  ['general', 'general', 'Général'], ['interface', 'interface', 'Interface'], ['stockage', 'stockage', 'Stockage'],
  ['fichiers', 'fichiers', 'Fichiers'], ['connecteurs', 'connecteurs', 'Connecteurs installés'],
  ['permissions', 'permissions', 'Permissions'], ['compte', 'compte', 'Compte'], ['contact', 'contact', 'Nous contacter'],
];
const ADMIN = [
  ['users', 'utilisateurs', 'Utilisateurs'], ['apps', 'applications', 'Applications'], ['roles', 'permissions', 'Permissions'],
  ['cron', 'automatisation', 'Automatisation'], ['storage', 'stockage', 'Stockage'], ['optimisation', 'optimisation', 'Optimisation'],
  ['securite', 'securite', 'Sécurité'], ['smtp', 'smtp', 'SMTP'], ['logs', 'logs', 'Logs'], ['support', 'support', 'Support'],
  ['systeme', 'systeme', 'Système'],
];

test.before(async () => {
  await helpers.setup();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  await helpers.createUser({ username: 'titulaire' });
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

/** Où en est la page : adresse, titre de l'onglet, écran, section, entrée courante. */
function etat(page) {
  return page.evaluate(() => {
    const vue = document.querySelector('.view.active');
    return {
      adresse: location.pathname,
      titre: document.title,
      vue: vue?.id || null,
      section: vue?.querySelector('.settings-page.active')?.id || null,
      courante: [...(vue?.querySelectorAll('.settings-nav-item[aria-current="page"]') || [])].map((e) => e.getAttribute('href')),
    };
  });
}

/** Attend que la section voulue soit affichée. */
async function attendreSection(page, id) {
  await page.waitForFunction((i) => document.querySelector('.view.active .settings-page.active')?.id === i, id);
}

test('R1 — le serveur sert la coque aux adresses des deux pages ; anonyme → connexion ; sans droit → accueil', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  for (const chemin of ['/profil', '/profil/interface', '/administration', '/administration/systeme']) {
    const r = await client.get(chemin);
    assert.equal(r.status, 302, `${chemin} anonyme`);
    assert.equal(r.headers.location, '/', `${chemin} anonyme → /`);
  }

  await helpers.login(client, 'titulaire', 'MotDePasse1');
  for (const chemin of ['/profil', '/profil/interface', '/profil/inconnue']) {
    const r = await client.get(chemin);
    assert.equal(r.status, 200, chemin);
    assert.match(r.body, /id="view-profil"/, `${chemin} : la coque`);
  }
  for (const chemin of ['/administration', '/administration/systeme', '/administration/logs']) {
    const r = await client.get(chemin);
    assert.equal(r.status, 302, `${chemin} sans droit`);
    assert.equal(r.headers.location, '/', `${chemin} sans droit → accueil`);
  }
  // Deux segments : aucune page.
  assert.equal((await client.get('/profil/interface/autre')).status, 404);

  client.clearCookies();
  await helpers.login(client, 'gerante', 'MotDePasse1');
  for (const chemin of ['/administration', '/administration/systeme']) {
    const r = await client.get(chemin);
    assert.equal(r.status, 200, chemin);
    assert.match(r.body, /id="view-admin"/);
  }
});

test('R1 — l\'adresse d\'une section est écrite une fois, dans le lien de son entrée', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'web', 'app.html'), 'utf8');
  for (const [vue, sections, racine] of [['ppage', PROFIL, '/profil'], ['apage', ADMIN, '/administration']]) {
    for (const [nom, adresse] of sections) {
      const motif = new RegExp(`<a class="settings-nav-item[^"]*" href="${racine}/${adresse}" data-${vue}="${nom}"[^>]*onclick="return lienDeSection\\(event, this\\)"`);
      assert.match(html, motif, `${racine}/${adresse}`);
      assert.equal((html.match(new RegExp(`href="${racine}/${adresse}"`, 'g')) || []).length, 1, `${racine}/${adresse} une seule fois`);
    }
  }
  assert.match(html, /<nav class="settings-sidebar" id="profil-sidebar" aria-label="Sections du profil">/);
  assert.match(html, /<nav class="settings-sidebar" id="admin-sidebar" aria-label="Sections de l'administration">/);
});

test('R1 — au vrai Chromium : chaque section par son adresse directe (titre, aria-current), Précédent, section inconnue', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante', { chemin: '/profil/fichiers' });
  t.after(fermer);

  await attendreSection(page, 'ppage-fichiers');
  for (const [vue, sections, racine, titre, prefixe] of [
    ['view-profil', PROFIL, '/profil', 'Profil', 'ppage'],
    ['view-admin', ADMIN, '/administration', 'Administration', 'apage'],
  ]) {
    for (const [nom, adresse, libelle] of sections) {
      await page.goto(`${client.base}${racine}/${adresse}`, { waitUntil: 'domcontentloaded' });
      await attendreSection(page, `${prefixe}-${nom}`);
      const e = await etat(page);
      assert.equal(e.adresse, `${racine}/${adresse}`);
      assert.equal(e.vue, vue);
      assert.equal(e.titre, `${titre} › ${libelle} — Crabe`);
      assert.deepEqual(e.courante, [`${racine}/${adresse}`], 'une seule entrée courante');
    }
  }

  // Une section choisie ajoute une entrée ; Précédent revient à celle d'avant.
  await page.goto(`${client.base}/profil/interface`, { waitUntil: 'domcontentloaded' });
  await attendreSection(page, 'ppage-interface');
  await page.click('[data-ppage="stockage"]');
  await attendreSection(page, 'ppage-stockage');
  assert.equal((await etat(page)).adresse, '/profil/stockage');
  await page.click('[data-ppage="contact"]');
  await attendreSection(page, 'ppage-contact');
  await page.goBack();
  await attendreSection(page, 'ppage-stockage');
  assert.equal((await etat(page)).adresse, '/profil/stockage');
  await page.goBack();
  await attendreSection(page, 'ppage-interface');
  assert.deepEqual((await etat(page)).courante, ['/profil/interface']);
  await page.goForward();
  await attendreSection(page, 'ppage-stockage');

  // Quitter la page pour l'accueil, puis Précédent : retour à la section.
  await page.click('.tb-logo');
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-home');
  const accueil = await etat(page);
  assert.equal(accueil.adresse, '/');
  assert.equal(accueil.titre, 'Crabe — gestionnaire de factures', 'le titre de la coque revient');
  await page.goBack();
  await attendreSection(page, 'ppage-stockage');

  // De l'Administration au Profil, et retour.
  await page.goto(`${client.base}/administration/securite`, { waitUntil: 'domcontentloaded' });
  await attendreSection(page, 'apage-securite');
  await page.click('[data-apage="smtp"]');
  await attendreSection(page, 'apage-smtp');
  await page.goBack();
  await attendreSection(page, 'apage-securite');
  assert.equal((await etat(page)).adresse, '/administration/securite');

  // Une section inconnue mène à la première et remplace l'adresse.
  for (const [chemin, attendu, section] of [
    ['/profil/inconnue', '/profil/general', 'ppage-general'],
    ['/profil', '/profil/general', 'ppage-general'],
    ['/administration/inconnue', '/administration/utilisateurs', 'apage-users'],
    ['/administration', '/administration/utilisateurs', 'apage-users'],
  ]) {
    await page.goto(`${client.base}${chemin}`, { waitUntil: 'domcontentloaded' });
    await attendreSection(page, section);
    assert.equal((await etat(page)).adresse, attendu, chemin);
    // Précédent quitte la coque (l'entrée d'avant est un autre chargement) :
    // jamais l'adresse inconnue, qui a été remplacée.
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.me && document.querySelector('.view.active'));
    assert.notEqual(await page.evaluate(() => location.pathname), chemin, `${chemin} : remplacée, pas d'entrée qui y ramène`);
  }

  // Ctrl+clic : le lien suit son cours (le navigateur l'ouvrirait ailleurs).
  const suit = await page.evaluate(() => lienDeSection({ ctrlKey: true, button: 0, preventDefault() { throw new Error('empêché'); } }, document.querySelector('[data-ppage="compte"]')));
  assert.equal(suit, true);

  assert.deepEqual(erreursJs, []);
});

test('R1 — les anciennes portes mènent à la nouvelle page, avec son adresse', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante');
  t.after(fermer);

  // Le menu de l'avatar (lot 106).
  await page.click('#tb-profil');
  await page.click('#menu-compte-profil');
  await attendreSection(page, 'ppage-general');
  assert.equal((await etat(page)).adresse, '/profil/general');
  await page.click('#tb-profil');
  await page.click('#menu-compte-admin');
  await attendreSection(page, 'apage-users');
  assert.equal((await etat(page)).adresse, '/administration/utilisateurs');

  // Le bandeau des opérations : la section, sans s'arrêter sur la première.
  await page.evaluate(() => showView('home'));
  await page.evaluate(() => ouvrirEcranOperation('admin-optimisation'));
  await attendreSection(page, 'apage-optimisation');
  assert.equal((await etat(page)).adresse, '/administration/optimisation');
  await page.evaluate(() => ouvrirEcranOperation('profil-fichiers'));
  await attendreSection(page, 'ppage-fichiers');
  assert.equal((await etat(page)).adresse, '/profil/fichiers');
  await page.goBack();
  await attendreSection(page, 'apage-optimisation');

  // La cloche (un chantier de fichiers) et « Signaler un problème ».
  await page.evaluate(() => showView('home'));
  await page.evaluate(() => ouvrirCibleNotification('chantier'));
  await attendreSection(page, 'ppage-fichiers');
  assert.equal((await etat(page)).adresse, '/profil/fichiers');
  await page.evaluate(() => showProfilPage('general', document.querySelector('[data-ppage=general]')));
  await page.click('#ppage-general ~ * button:has-text("Signaler un problème"), #view-profil button:has-text("Signaler un problème")');
  await attendreSection(page, 'ppage-contact');
  assert.equal((await etat(page)).adresse, '/profil/contact');

  // Les appels d'avant, tels que les essais et le code les font.
  await page.evaluate(() => { showView('admin'); showAdminPage('systeme', document.querySelector('[data-apage="systeme"]')); });
  await attendreSection(page, 'apage-systeme');
  assert.equal((await etat(page)).adresse, '/administration/systeme');
  await page.evaluate(() => { showView('profil'); showProfilPage('connecteurs', document.querySelector('[data-ppage=connecteurs]')); });
  await attendreSection(page, 'ppage-connecteurs');
  assert.equal((await etat(page)).adresse, '/profil/connecteurs');

  assert.deepEqual(erreursJs, []);
});

test('R1 — un compte sans droit d\'administration : aucune section, même si la coque lui arrivait à cette adresse', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { chemin: '/administration/systeme' });
  t.after(fermer);
  // Le serveur l'a renvoyé à l'accueil.
  assert.equal((await etat(page)).adresse, '/');
  assert.equal((await etat(page)).vue, 'view-home');
  // Et si l'adresse lui parvenait quand même (historique) : l'accueil.
  await page.evaluate(() => { history.pushState(null, '', '/administration/systeme'); ouvrirSelonAdresse({ historique: 'aucun' }); });
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-home');
  assert.equal((await etat(page)).adresse, '/');
  assert.equal(await page.locator('#view-admin.active').count(), 0);
  assert.deepEqual(erreursJs, []);
});
