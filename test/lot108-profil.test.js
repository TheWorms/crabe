'use strict';

/**
 * Lot 108, R2 — le Profil en pleine page : celui du compte connecté, et lui
 * seul ; les identifiants restent masqués comme avant.
 *
 * Deux comptes de banc. Dans chacune des huit sections du Profil (et la carte
 * « Sécurité du compte » à côté), au vrai Chromium : rien de l'autre compte —
 * ni son nom, ni son adresse, ni son téléphone, ni le libellé de son compte de
 * service. Les identifiants de compte chez un service ne s'affichent jamais en
 * entier (lot 97) ; l'adresse e-mail du compte s'affiche à son titulaire, en
 * clair, comme avant. Une écriture du Profil ne touche que le compte connecté.
 *
 * Aucune donnée réelle : comptes nommés par leur rôle, valeurs visiblement
 * inventées.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { SECTIONS_PROFIL } = require('./lot108-commun');

const IDENTIFIANT_TITULAIRE = 'fbx91111234';
const IDENTIFIANT_VOISINE = 'fbx92222345';
let client;
let titulaire;
let voisine;

test.before(async () => {
  await helpers.setup();
  const db = helpers.db.get();
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });
  db.prepare("UPDATE users SET phone = '0600000001' WHERE id = ?").run(titulaire.id);
  db.prepare("UPDATE users SET phone = '0600000002', email = 'voisine@exemple.invalid' WHERE id = ?").run(voisine.id);
  const schedules = require('../server/schedules');
  for (const [u, compte] of [[titulaire, IDENTIFIANT_TITULAIRE], [voisine, IDENTIFIANT_VOISINE]]) {
    db.prepare("INSERT INTO connector_installs (user_id, connector_id, status, account_id) VALUES (?, 'free', 'installed', ?)").run(u.id, compte);
    schedules.ensureForInstall(u.id, 'free');
    db.prepare(`INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
                VALUES (?, 'free', ?, ?, 1000, '2026-09', datetime('now'), '{}')`).run(u.id, `free_2026-09_${compte}.pdf`, compte);
  }
  await (async () => {
    const c = await helpers.startServer();
    await helpers.login(c, 'voisine', 'MotDePasse1');
    await c.post('/api/tickets', { subject: 'Demande de la voisine', message: 'Message inventé de la voisine.' });
    await c.close();
  })();
  client = await helpers.startServer();
});

test.after(async () => {
  await fermerNavigateur();
  await client?.close();
  helpers.teardown();
});

test('R2 — au vrai Chromium : chaque section du Profil ne montre que le compte connecté, et aucun identifiant entier', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { chemin: '/profil/general' });
  t.after(fermer);
  const interdits = ['voisine', '0600000002', IDENTIFIANT_VOISINE, 'Demande de la voisine', IDENTIFIANT_TITULAIRE];
  for (const nom of SECTIONS_PROFIL) {
    await page.goto(`${client.base}/profil/${nom}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => document.querySelector('#view-profil .settings-page.active')?.id === id, `ppage-${nom}`);
    await page.waitForTimeout(500);
    if (nom === 'permissions') {
      await page.evaluate(() => openPermDetail('free'));
      await page.waitForTimeout(300);
    }
    // Ce que la page affiche ET ce qu'elle porte (attributs compris).
    const html = await page.$eval('#view-profil', (v) => v.outerHTML);
    for (const motif of interdits) assert.equal(html.includes(motif), false, `${nom} : « ${motif} » n'apparaît pas`);
  }
  // Son adresse et son téléphone, à elle, comme avant.
  await page.goto(`${client.base}/profil/general`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('profil-username')?.textContent === 'titulaire');
  assert.equal(await page.textContent('#profil-email'), 'titulaire@test.local', 'l\'adresse s\'affiche en clair à son titulaire');
  assert.equal(await page.inputValue('#profil-phone'), '0600000001');
  assert.deepEqual(erreursJs, []);
});

test('R2 — une écriture du Profil ne touche que le compte connecté', async (t) => {
  const c = await helpers.startServer();
  t.after(() => c.close());
  await helpers.login(c, 'titulaire', 'MotDePasse1');
  const r = await c.patch('/api/auth/profile', { phone: '0600000003', documentsUi: 'explorer', userId: voisine.id, id: voisine.id });
  assert.equal(r.status, 200);
  const lire = (id) => helpers.db.get().prepare('SELECT phone, documents_ui FROM users WHERE id = ?').get(id);
  assert.deepEqual(lire(titulaire.id), { phone: '0600000003', documents_ui: 'explorer' });
  assert.deepEqual(lire(voisine.id), { phone: '0600000002', documents_ui: 'base' }, 'la voisine n\'a pas bougé');
  // Les lectures du Profil : les siennes.
  const moi = (await c.get('/api/auth/me')).body.user;
  assert.equal(moi.username, 'titulaire');
  const demandes = (await c.get('/api/tickets/mine')).body.tickets;
  assert.equal(demandes.some((d) => /voisine/.test(d.subject)), false);
  const connecteurs = (await c.get('/api/connectors')).body.connectors.filter((x) => x.installed);
  assert.equal(JSON.stringify(connecteurs).includes(IDENTIFIANT_VOISINE), false);
});
