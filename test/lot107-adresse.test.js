'use strict';

/**
 * Lot 107, R3 / R4 — les onglets d'espace, la recherche, le tri et l'adresse
 * de l'explorateur, au vrai Chromium.
 *
 * Deux espaces (le stockage local des essais et un cloud inventé) ; les
 * documents de 2026 sont déposés sur les deux, les autres ont une copie en
 * échec sur le cloud — l'onglet du cloud ne doit pas les montrer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { LOCAL, NOM_LOCAL, peupler, peuplerSerie, regler } = require('./lot107-commun');

let titulaire;
let client;
let cloud;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  const base = await helpers.createUser({ username: 'habituee' });
  cloud = helpers.creerCloud({ rcloneConfig: 'type = pcloud' });
  const ok = { state: 'ok', ok: true };
  peupler(titulaire, {
    depots: (nom) => (/^2026-/.test(nom)
      ? { [LOCAL]: ok, [cloud]: ok }
      : { [LOCAL]: ok, [cloud]: { state: 'error', ok: false, message: 'refusé' } }),
  });
  peuplerSerie(titulaire, 50);
  peupler(base, { fichiers: false });
  regler(titulaire.id, 'explorer');
  regler(base.id, 'base');
  client = await helpers.startServer();
});

test.after(async () => {
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

const attendreListe = (page) => page.waitForFunction(() => {
  const l = document.getElementById('explo-liste');
  return l && l.getAttribute('aria-busy') === 'false';
});

async function ouvrir(t, chemin = '/', options = {}) {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, options.compte || 'titulaire', { chemin, ...options });
  t.after(fermer);
  if (chemin === '/' && !options.sansOuvrir) await page.evaluate(() => showView('documents'));
  if (!options.sansOuvrir) await attendreListe(page);
  return { page, erreursJs };
}

const chemin = (page) => page.evaluate(() => `${location.pathname}${location.search}`);
const noms = (page) => page.$$eval('#explo-liste .explo-nom', (l) => l.map((e) => e.textContent));

test('R3 — un onglet par espace du compte (tablist, flèches) ; un onglet ne montre que les dépôts réussis, et le dit', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrir(t);
  assert.equal(await page.getAttribute('#explo-espaces [role="tablist"]', 'aria-label'), 'Espace de stockage');
  // Le nom lu de chaque onglet : sans la pastille, tue (aria-hidden).
  const onglets = await page.$$eval('#explo-espaces [role="tab"]', (l) => l.map((b) => {
    const copie = b.cloneNode(true);
    copie.querySelectorAll('[aria-hidden="true"]').forEach((e) => e.remove());
    return [b.tagName, copie.textContent.trim(), b.getAttribute('aria-selected'), b.getAttribute('tabindex')];
  }));
  assert.deepEqual(onglets, [['BUTTON', NOM_LOCAL, 'true', '0'], ['BUTTON', 'pCloud', 'false', '-1']]);
  assert.equal(await page.getAttribute('#explo-carte', 'role'), 'tabpanel');
  assert.equal(await page.getAttribute('#explo-carte', 'aria-labelledby'), `explo-espace-${LOCAL}`);
  assert.equal(await page.textContent('.explo-aide'), `Les documents que crabe a déposés sur ${NOM_LOCAL}, d'après ce qu'il a enregistré de chaque copie : une copie qui a échoué ou qui attend encore n'y figure pas.`);

  // Flèche droite : le focus et l'onglet passent au cloud.
  await page.focus(`#explo-espace-${LOCAL}`);
  await page.keyboard.press('ArrowRight');
  await attendreListe(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), `explo-espace-${cloud}`);
  assert.equal(await page.getAttribute(`#explo-espace-${cloud}`, 'aria-selected'), 'true');
  assert.deepEqual((await noms(page)).sort(), ['2026-08_facture_essai.pdf', '2026-09_facture_essai.pdf', '2026-09_ligne_essai_a.pdf', '2026-09_ligne_essai_b.pdf']);
  assert.equal((await page.textContent('#explo-liste')).includes('2025-12_facture_essai.pdf'), false, 'copie en échec : absente');
  assert.match(await page.textContent('#explo-pied'), /4 documents · pCloud/);
  assert.deepEqual(await page.$$eval('#explo-fil .explo-fil-bouton', (l) => l.map((b) => b.textContent)), ['pCloud']);
  assert.equal(await chemin(page), `/documents?espace=${cloud}`);
  // Le téléchargement vise l'espace consulté.
  assert.match(await page.getAttribute('#explo-liste a.explo-dl >> nth=0', 'href'), new RegExp(`^/api/documents/${cloud}/\\d+/file$`));
  // Origine : retour au stockage local.
  await page.keyboard.press('Home');
  await attendreListe(page);
  assert.equal(await page.getAttribute(`#explo-espace-${LOCAL}`, 'aria-selected'), 'true');
  assert.equal(await chemin(page), '/documents');
  assert.deepEqual(erreursJs, []);
});

test('R4 — la recherche : 250 ms après la frappe, une seule demande, le focus reste dans le champ ; vidée, tout revient', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrir(t);
  const demandes = [];
  page.on('request', (r) => { if (r.url().includes('/api/documents/explorateur')) demandes.push(r.url()); });
  await page.click('#explo-q');
  await page.keyboard.type('ligne', { delay: 30 });
  await page.waitForFunction(() => /ligne/.test(location.search));
  await attendreListe(page);
  assert.equal(demandes.length, 1, `une seule demande pour cinq frappes : ${demandes.join(' | ')}`);
  assert.match(demandes[0], /[?&]q=ligne(&|$)/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'explo-q', 'le focus est resté dans le champ');
  assert.deepEqual((await noms(page)).sort(), ['2025-06_ligne_essai_a.pdf', '2026-09_ligne_essai_a.pdf', '2026-09_ligne_essai_b.pdf']);
  assert.equal(await chemin(page), '/documents?q=ligne');

  // Une frappe pendant une demande : la précédente est annulée.
  let relacher;
  const retenue = new Promise((r) => { relacher = r; });
  await page.route('**/api/documents/explorateur*', async (route) => {
    if (/[?&]q=lign(&|$)/.test(route.request().url())) { await retenue; return route.abort(); }
    return route.continue();
  });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  await page.keyboard.type('e2', { delay: 20 });
  relacher();
  await page.waitForFunction(() => /q=ligne2/.test(location.search));
  await attendreListe(page);
  await page.unroute('**/api/documents/explorateur*');
  assert.equal((await page.textContent('#explo-liste')).trim(), 'Aucun document ne correspond à cette recherche.');

  // Vidée : la première page de tout.
  await page.fill('#explo-q', '');
  await page.waitForFunction(() => location.search === '');
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);
  assert.match(await page.textContent('#explo-pied'), /59 documents · 40 affichés/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'explo-q');
  assert.deepEqual(erreursJs, []);
});

test('R4 — le tri : quatre ordres, dits dans l\'adresse', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrir(t);
  assert.deepEqual(await page.$$eval('#explo-tri option', (l) => l.map((o) => [o.value, o.textContent])), [
    ['recents', 'Récupérés récemment'], ['nom', 'Nom'], ['periode', 'Période'], ['taille', 'Taille'],
  ]);
  await page.selectOption('#explo-tri', 'taille');
  await page.waitForFunction(() => /tri=taille/.test(location.search));
  await attendreListe(page);
  const tailles = await page.$$eval('#explo-liste .explo-col-taille', (l) => l.map((e) => parseFloat(e.textContent)));
  assert.deepEqual(tailles, [...tailles].sort((a, b) => b - a));
  assert.equal(tailles[0], 60);
  await page.selectOption('#explo-tri', 'nom');
  await page.waitForFunction(() => /tri=nom/.test(location.search));
  await attendreListe(page);
  assert.equal((await noms(page))[0], '2025-06_ligne_essai_a.pdf');
});

test('R4 — une adresse arrive déjà filtrée : service, année, recherche, tri, vue', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrir(t, '/documents?service=free-mobile&annee=2026&q=ligne&tri=nom&vue=icones');
  assert.equal(await page.isVisible('#view-documents'), true);
  assert.equal(await page.getAttribute('[data-cle="arbre-free-mobile-2026"]', 'aria-current'), 'true');
  assert.equal(await page.inputValue('#explo-q'), 'ligne');
  assert.equal(await page.inputValue('#explo-tri'), 'nom');
  assert.equal(await page.getAttribute('#explo-vue-icones', 'aria-pressed'), 'true');
  assert.deepEqual(await page.$$eval('#explo-liste .explo-icone-nom', (l) => l.map((e) => e.textContent)), ['2026-09_ligne_essai_a.pdf', '2026-09_ligne_essai_b.pdf']);
  assert.equal(await chemin(page), '/documents?service=free-mobile&annee=2026&q=ligne&tri=nom&vue=icones');
  // Quitter l'écran rend l'adresse de la coque.
  await page.evaluate(() => showView('home'));
  assert.equal(await chemin(page), '/');
  assert.deepEqual(erreursJs, []);
});

test('R4 — « Voir les documents de ce service » (la modale) arrive filtré sur le service', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrir(t, '/', { sansOuvrir: true });
  await page.evaluate(() => { explo.filtre.q = 'reste-d-une-visite'; state.currentConnectorId = 'ovh'; openDocsForConnector(); });
  await attendreListe(page);
  assert.equal(await chemin(page), '/documents?service=ovh');
  assert.deepEqual((await noms(page)).sort(), ['Facture_essai_FR0001.pdf', 'Facture_essai_FR0002.pdf']);
  assert.equal(await page.inputValue('#explo-q'), '', 'la recherche d\'une visite précédente est effacée');
});

test('R4 — les valeurs de l\'adresse sont validées et échappées : rien ne s\'écrit tel quel dans la page', AVEC_NAVIGATEUR, async (t) => {
  const piege = '"><img src=x onerror="window.__piege=1">';
  const adresse = `/documents?q=${encodeURIComponent(piege)}&service=${encodeURIComponent('<script>')}&annee=20x6&tri=__proto__&vue=grille&espace=${encodeURIComponent('../x')}`;
  const { page, erreursJs } = await ouvrir(t, adresse);
  let dialogues = 0;
  page.on('dialog', (d) => { dialogues += 1; d.dismiss(); });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__piege), undefined);
  assert.equal(await page.locator('#explo img[src="x"]').count(), 0);
  assert.equal(await page.inputValue('#explo-q'), piege.trim(), 'le texte, tel qu\'écrit, dans le champ — pas dans la page');
  assert.equal(await page.inputValue('#explo-tri'), 'recents');
  assert.equal(await page.getAttribute('#explo-vue-liste', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('[data-cle="arbre-tous"]', 'aria-current'), 'true', 'service douteux ignoré');
  assert.equal(dialogues, 0);
  assert.deepEqual(erreursJs, []);
  // Un service bien formé mais inconnu du serveur : refusé (400), et l'écran revient à tout.
  await page.goto(`${client.base}/documents?service=service-de-personne`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Ce filtre n'existe plus/.test(document.getElementById('toast').textContent));
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);
  assert.equal(await chemin(page), '/documents');
});

test('R1 — l\'adresse /documents : la coque pour un compte connecté, l\'écran de connexion sinon ; l\'interface de base n\'en tient pas compte', AVEC_NAVIGATEUR, async (t) => {
  const anonyme = await fetch(`${client.base}/documents?service=ovh`, { redirect: 'manual' });
  assert.equal(anonyme.status, 302);
  assert.equal(anonyme.headers.get('location'), '/');
  const { page } = await ouvrir(t, '/documents?service=ovh&q=x', { compte: 'habituee', sansOuvrir: true });
  await page.waitForFunction(() => document.getElementById('docs-content').innerHTML.length > 200);
  assert.equal(await page.locator('#explo').count(), 0, 'l\'interface de base');
  assert.equal(await page.locator('#docs-content .docs-filters').count(), 1);
  assert.equal(await chemin(page), '/', 'l\'interface de base n\'a pas d\'adresse');
});
