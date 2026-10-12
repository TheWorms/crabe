'use strict';

/**
 * Lot 108, R1 et R3 — les droits ne s'élargissent jamais.
 *
 * L'Administration en pleine page reste gardée côté serveur exactement comme
 * avant, section par section. Un compte sans aucune permission
 * d'administration n'obtient aucune section, ni par la page (l'adresse le
 * renvoie à l'accueil) ni par l'API (chaque route de chaque section → 403) ;
 * une déléguée qui n'a que « Répondre au support » ne voit que Support et
 * Système, une adresse d'une autre section la mène à la première permise, et
 * aucune donnée d'une section interdite ne lui parvient — même pas demandée.
 *
 * Aucune donnée réelle : comptes nommés par leur rôle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');

/** Les lectures de chaque section, telles que l'écran les fait. */
const LECTURES = {
  Utilisateurs: ['/api/users', '/api/users/deletion/requests'],
  Applications: ['/api/admin/connectors', '/api/admin/connectors/logos', '/api/admin/connectors/free/diagnostics'],
  Permissions: ['/api/admin/roles'],
  Automatisation: ['/api/admin/schedules'],
  Stockage: ['/api/admin/destinations', '/api/admin/destinations/backends', '/api/system/storage'],
  Optimisation: ['/api/admin/optimisation'],
  Sécurité: ['/api/system/security', '/api/admin/logs/connections'],
  SMTP: ['/api/system/smtp', '/api/system/email-templates'],
  Logs: ['/api/admin/logs/runs', '/api/admin/logs/app', '/api/admin/logs/storage'],
  Support: ['/api/tickets?status=all'],
  Système: ['/api/system', '/api/system/rclone'],
};

let client;

test.before(async () => {
  await helpers.setup();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  await helpers.createUser({ username: 'titulaire' });
  const deleguee = await helpers.createUser({ username: 'deleguee' });
  const role = permissions.createRole('Support seulement', ['support.reply']);
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role.id, deleguee.id);
  client = await helpers.startServer();
});

test.after(async () => {
  await fermerNavigateur();
  await client?.close();
  helpers.teardown();
});

test('R3 — un compte sans droit : chaque lecture de chaque section est refusée par le serveur (403), et l\'adresse le renvoie à l\'accueil', async (t) => {
  const c = await helpers.startServer();
  t.after(() => c.close());
  await helpers.login(c, 'titulaire', 'MotDePasse1');
  for (const [section, routes] of Object.entries(LECTURES)) {
    for (const route of routes) {
      const r = await c.get(route);
      assert.equal(r.status, 403, `${section} : ${route}`);
      assert.equal(JSON.stringify(r.body).length < 200, true, `${section} : ${route} — aucune donnée`);
    }
  }
  assert.equal((await c.post('/api/system/update-check')).status, 403);
  for (const chemin of ['/administration', '/administration/utilisateurs', '/administration/systeme']) {
    const r = await c.get(chemin);
    assert.deepEqual([r.status, r.headers.location], [302, '/'], chemin);
  }
});

test('R3 — la déléguée « Support seulement » : Support et Système, rien d\'autre, par la page comme par l\'API', async (t) => {
  const c = await helpers.startServer();
  t.after(() => c.close());
  await helpers.login(c, 'deleguee', 'MotDePasse1');
  for (const [section, routes] of Object.entries(LECTURES)) {
    const permise = section === 'Support' || section === 'Système';
    for (const route of routes) {
      const r = await c.get(route);
      if (permise) assert.equal(r.status, 200, `${section} : ${route}`);
      else assert.equal(r.status, 403, `${section} : ${route}`);
    }
  }
  assert.equal((await c.get('/administration/utilisateurs')).status, 200, 'la coque : elle a un écran d\'administration');
});

test('R1, R3 — au vrai Chromium, la déléguée : deux entrées seulement, une section interdite mène à la première permise, aucune donnée interdite demandée', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'deleguee', {
    chemin: '/administration/utilisateurs',
    preparer: async (p) => {
      p.demandes = [];
      p.on('request', (r) => { if (r.url().includes('/api/')) p.demandes.push(new URL(r.url()).pathname); });
    },
  });
  t.after(fermer);
  await page.waitForFunction(() => document.querySelector('#view-admin .settings-page.active')?.id === 'apage-support');
  assert.equal(await page.evaluate(() => location.pathname), '/administration/support', 'l\'adresse interdite est remplacée');
  const visibles = await page.$$eval('#admin-sidebar .settings-nav-item', (l) => l.filter((e) => e.offsetParent).map((e) => e.dataset.apage));
  assert.deepEqual(visibles, ['support', 'systeme']);
  // Chaque adresse interdite, tapée : la section permise, jamais l'autre.
  for (const adresse of ['applications', 'permissions', 'automatisation', 'stockage', 'optimisation', 'securite', 'smtp', 'logs']) {
    await page.goto(`${client.base}/administration/${adresse}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#view-admin .settings-page.active')?.id === 'apage-support');
    assert.equal(await page.evaluate(() => location.pathname), '/administration/support', adresse);
  }
  await page.waitForTimeout(300);
  // `/api/users/me/…` : ses propres réglages (préférences, notifications).
  const interdites = page.demandes.filter((p) => /^\/api\/(users(?!\/me\/)|admin\/|system\/(security|smtp|email-templates|storage))/.test(p));
  assert.ok(page.demandes.some((p) => p.startsWith('/api/tickets')), 'la section permise, elle, a lu ses données');
  assert.deepEqual(interdites, [], 'aucune donnée d\'une section interdite n\'est même demandée');
  assert.deepEqual(erreursJs, []);
});

test('R1 — au vrai Chromium, un compte sans droit : le Profil est à lui, l\'Administration n\'existe pas', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { chemin: '/profil/interface' });
  t.after(fermer);
  await page.waitForFunction(() => document.querySelector('#view-profil .settings-page.active')?.id === 'ppage-interface');
  assert.equal(await page.evaluate(() => sectionsAdminPermises().length), 0);
  assert.equal(await page.locator('#menu-compte-admin').isHidden(), true);
  // Même appelée à la main, l'Administration ne s'ouvre pas : on reste là.
  await page.evaluate(() => showView('admin', { section: 'users' }));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#view-admin.active').count(), 0);
  assert.equal(await page.locator('#view-profil.active').count(), 1);
  assert.equal(await page.evaluate(() => location.pathname), '/profil/interface', 'aucune adresse d\'administration écrite');
  assert.match(await page.innerText('#toast'), /Aucun écran d'administration accessible/);
  assert.deepEqual(erreursJs, []);
});
