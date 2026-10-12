'use strict';

/**
 * Lot 107, R2 / R7 — l'isolement vu du navigateur.
 *
 * Deux comptes de banc, chacun en explorateur : chacun ne voit que ses
 * documents, même par une adresse forgée ; l'explorateur n'appelle jamais la
 * route de l'interface de base (qui rend TOUT) et ne reçoit jamais plus de
 * quarante documents par réponse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { peupler, peuplerSerie, regler } = require('./lot107-commun');

let client;
let idsTitulaire;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  const titulaire = await helpers.createUser({ username: 'titulaire' });
  const voisine = await helpers.createUser({ username: 'voisine' });
  idsTitulaire = [...peupler(titulaire, { fichiers: false }), ...peuplerSerie(titulaire, 120)];
  peupler(voisine, {
    fichiers: false,
    jeu: [
      ['gandi', 'org-essai-voisine-1', 'voisine_gandi_essai.pdf', '2026-03-01', '2026-03-02 00:00:00', 1000],
      ['free', 'defaut', 'voisine_free_essai.pdf', '2026-04-01', '2026-04-02 00:00:00', 2000],
    ],
  });
  regler(titulaire.id, 'explorer');
  regler(voisine.id, 'explorer');
  client = await helpers.startServer();
});

test.after(async () => {
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

const attendreListe = (page) => page.waitForFunction(() => document.getElementById('explo-liste')?.getAttribute('aria-busy') === 'false');

test('R2 — la voisine ne voit que ses deux documents, même par des adresses forgées', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'voisine');
  t.after(fermer);
  const reponses = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/documents/explorateur')) reponses.push(await r.json().catch(() => null));
  });
  for (const adresse of [
    '/documents', '/documents?service=free-mobile', '/documents?service=scaleway&annee=2025', '/documents?q=essai',
    '/documents?q=serie', '/documents?tri=taille', '/documents?service=free&q=facture',
  ]) {
    await page.goto(`${client.base}${adresse}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.me && document.querySelector('.view.active'));
    await attendreListe(page);
    const texte = await page.textContent('#explo');
    for (const motif of [/titulaire/, /ligne_essai/, /facture_essai\.pdf/, /serie_essai/, /Scaleway/, /Free Mobile/]) {
      assert.equal(motif.test(texte), false, `${adresse} : ${motif}`);
    }
  }
  const ids = new Set(reponses.filter(Boolean).flatMap((r) => r.documents.map((d) => d.id)));
  for (const id of idsTitulaire) assert.equal(ids.has(id), false);
  assert.ok(reponses.filter(Boolean).every((r) => r.total <= 2));
  assert.deepEqual(erreursJs, []);
});

test('R2 — l\'explorateur ne demande jamais la liste entière : aucune réponse de plus de 40 documents, jamais la route de l\'interface de base', AVEC_NAVIGATEUR, async (t) => {
  const { page, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  const appels = [];
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/documents')) appels.push({ chemin: u.pathname, corps: await r.json().catch(() => null) });
  });
  await page.evaluate(() => showView('documents'));
  await attendreListe(page);
  for (const geste of [
    () => page.click('[data-cle="arbre-scaleway"]'),
    () => page.selectOption('#explo-tri', 'nom'),
    // Une recherche ramène à la première page : elle vient avant « Afficher plus ».
    () => page.fill('#explo-q', 'serie'),
    () => page.click('#explo-plus'),
    () => page.click('#explo-plus'),
    () => page.click('#explo-vue-icones'),
  ]) {
    await geste();
    await page.waitForTimeout(350);
    await attendreListe(page);
  }
  assert.ok(appels.length >= 5, `${appels.length} lectures`);
  for (const a of appels) {
    assert.equal(a.chemin, '/api/documents/explorateur', `aucune autre lecture : ${a.chemin}`);
    assert.ok(a.corps.documents.length <= 40, `${a.corps.documents.length} documents dans une réponse`);
  }
  assert.equal(await page.locator('#explo-liste .explo-icone').count(), 120, 'trois pages lues à la demande (40 + 40 + 40)');
});
