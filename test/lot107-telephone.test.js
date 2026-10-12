'use strict';

/**
 * Lot 107, R5 / R6 — l'explorateur sur téléphone, au clavier, dans les deux
 * thèmes.
 *
 * À 390 px : l'arbre replié en un sélecteur « Service / Année », des lignes
 * à deux niveaux, le détail en feuille du bas, aucun défilement de côté (ni
 * de la page, ni à l'intérieur), des cibles d'au moins 44 px. Au clavier :
 * tout s'atteint, les flèches parcourent l'arbre et la liste, le focus se
 * voit. Les contrastes, mesurés au vrai Chromium, et une feuille sans couleur
 * en dur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur, contraste, couleursDe, debordement } = require('./lot106-commun');
const { LOCAL, peupler, peuplerSerie, regler } = require('./lot107-commun');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
const LOT107 = CSS.slice(CSS.indexOf('Lot 107 — l\'explorateur « Mes documents »'));

let client;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  const titulaire = await helpers.createUser({ username: 'titulaire' });
  const cloud = helpers.creerCloud({ rcloneConfig: 'type = pcloud' });
  const ok = { state: 'ok', ok: true };
  peupler(titulaire, { depots: { [LOCAL]: ok, [cloud]: ok } });
  peuplerSerie(titulaire, 50);
  regler(titulaire.id, 'explorer');
  client = await helpers.startServer();
});

test.after(async () => {
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

const attendreListe = (page) => page.waitForFunction(() => document.getElementById('explo-liste')?.getAttribute('aria-busy') === 'false');

async function ouvrir(t, options) {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', options);
  t.after(fermer);
  await page.evaluate(() => showView('documents'));
  await attendreListe(page);
  return { page, erreursJs };
}

/** Aucun conteneur de l'explorateur ne défile de côté. */
const defilementsInternes = (page) => page.$$eval('#explo, #explo *', (l) => l.filter((e) => {
  const o = getComputedStyle(e).overflowX;
  return /(auto|scroll)/.test(o) && e.scrollWidth > e.clientWidth + 1;
}).map((e) => `${e.tagName.toLowerCase()}.${e.className}`));

/** Les cibles visibles de moins de 44 px (hauteur ; largeur aussi pour une icône seule). */
const petitesCibles = (page) => page.$$eval('#explo button, #explo a, #explo select, #explo input', (l) => l.filter((e) => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') return false;
  if (e.closest('.explo-recherche') && e.tagName === 'INPUT') return e.closest('.explo-recherche').getBoundingClientRect().height < 44;
  const iconeSeule = !e.textContent.trim() || e.classList.contains('explo-detail-fermer');
  return r.height < 44 || (iconeSeule && r.width < 44);
}).map((e) => `${e.tagName.toLowerCase()}.${e.className} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`));

for (const clair of [false, true]) {
  test(`R5 — 390 px, thème ${clair ? 'clair' : 'sombre'} : tout s'empile, rien ne défile de côté, des cibles de 44 px`, AVEC_NAVIGATEUR, async (t) => {
    const { page, erreursJs } = await ouvrir(t, { largeur: 390, hauteur: 844, clair });
    assert.equal(await page.isVisible('#explo-arbre'), false, 'l\'arbre est replié');
    assert.equal(await page.isVisible('#explo-choix'), true);
    assert.equal(await page.isVisible('.explo-entete'), false);
    // Deux niveaux : le nom, puis service · période · taille.
    const ligne = await page.$eval('#explo-liste .explo-ligne', (li) => ({
      nom: li.querySelector('.explo-nom').textContent,
      meta: li.querySelector('.explo-meta').textContent,
      colonnes: [...li.querySelectorAll('.explo-col')].filter((c) => c.getBoundingClientRect().width > 0).length,
    }));
    assert.deepEqual(ligne, { nom: '2026-09_ligne_essai_b.pdf', meta: 'Free Mobile · Compte …0002 · 2026-09 · 21.0 Ko', colonnes: 0 });

    let d = await debordement(page);
    assert.ok(d.scroll <= d.largeur, `aucun débordement : ${d.fautifs.join(' ; ')}`);
    assert.deepEqual(await defilementsInternes(page), []);
    assert.deepEqual(await petitesCibles(page), []);

    // Le sélecteur « Service / Année » : les rangs de l'arbre, dans le même ordre.
    await page.selectOption('#explo-choix', 'free-mobile');
    await attendreListe(page);
    assert.deepEqual(await page.$$eval('#explo-choix option', (l) => l.map((o) => o.textContent)), [
      'Tous les services (59)', 'Free Internet (3)', 'Free Mobile (3)', 'Free Mobile › 2026 (2)', 'Free Mobile › 2025 (1)',
      'Hetzner (1)', 'OVH (2)', 'Scaleway (50)',
    ]);
    await page.selectOption('#explo-choix', 'free-mobile|2025');
    await attendreListe(page);
    assert.deepEqual(await page.$$eval('#explo-liste .explo-nom', (l) => l.map((e) => e.textContent)), ['2025-06_ligne_essai_a.pdf']);
    assert.equal(await page.evaluate(() => location.search), '?service=free-mobile&annee=2025');

    // Le détail : une feuille du bas, qui se ferme.
    await page.click('#explo-liste .explo-ligne-choix');
    assert.equal(await page.isVisible('#explo-detail'), true);
    assert.equal(await page.$eval('#explo-detail', (e) => getComputedStyle(e).position), 'fixed');
    d = await debordement(page);
    assert.ok(d.scroll <= d.largeur, `feuille ouverte, aucun débordement : ${d.fautifs.join(' ; ')}`);
    assert.deepEqual(await petitesCibles(page), []);
    for (const sel of ['#explo-detail-nom', '#explo-detail dt', '#explo-detail dd', '#explo-detail .explo-detail-note', '#explo-detail .explo-btn.principal', '#explo-copier']) {
      const { texte, fond } = await couleursDe(page, sel);
      assert.ok(contraste(texte, fond) >= 4.5, `${sel} : ${contraste(texte, fond).toFixed(2)}`);
    }
    await page.click('#explo-detail .explo-detail-fermer');
    assert.equal(await page.isVisible('#explo-detail'), false);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('explo-ligne-choix')), true, 'le focus revient à la ligne');
    assert.deepEqual(erreursJs, []);
  });
}

test('R5 — 768 px : l\'arbre et la liste côte à côte, le détail en feuille, aucun débordement', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrir(t, { largeur: 768, hauteur: 1024 });
  assert.equal(await page.isVisible('#explo-arbre'), true);
  assert.equal(await page.isVisible('#explo-choix'), false);
  assert.equal(await page.isVisible('#explo-detail'), false, 'aucune feuille sans sélection');
  await page.click('#explo-liste .explo-ligne-choix');
  assert.equal(await page.$eval('#explo-detail', (e) => getComputedStyle(e).position), 'fixed');
  const d = await debordement(page);
  assert.ok(d.scroll <= d.largeur, d.fautifs.join(' ; '));
  assert.deepEqual(await defilementsInternes(page), []);
});

test('R5 — au clavier : tout s\'atteint par la tabulation, les flèches parcourent l\'arbre et la liste, le focus se voit', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrir(t, { largeur: 1280, hauteur: 900 });
  await page.focus(`#explo-espace-${LOCAL}`);
  const atteints = new Set();
  for (let i = 0; i < 70; i += 1) {
    await page.keyboard.press('Tab');
    const ici = await page.evaluate(() => {
      const e = document.activeElement;
      // Le champ de recherche montre son focus sur son cadre.
      const porteur = e?.id === 'explo-q' ? e.closest('.explo-recherche') : e;
      return { cle: e?.getAttribute('data-cle') || e?.id || '', classe: String(e?.className || ''), contour: getComputedStyle(porteur).outlineStyle };
    });
    if (/explo-/.test(ici.classe) || /^explo-/.test(ici.cle)) assert.equal(ici.contour, 'solid', `focus visible sur ${ici.cle || ici.classe}`);
    atteints.add(ici.cle);
  }
  for (const cle of ['explo-q', 'explo-tri', 'explo-vue-liste', 'explo-vue-icones', 'arbre-tous', 'arbre-free-mobile', 'arbre-scaleway', 'doc-1']) {
    assert.ok([...atteints].some((c) => c === cle || c.startsWith(cle)), `${cle} atteint (${[...atteints].join(', ')})`);
  }
  // Les flèches, dans l'arbre.
  await page.focus('[data-cle="arbre-tous"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-cle')), 'arbre-free');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-cle')), 'arbre-tous');
  // Dans la liste ; Entrée choisit sans déplacer le focus.
  await page.focus('#explo-liste [data-rang="0"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-rang')), '2');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-rang')), '2');
  assert.equal(await page.getAttribute('#explo-liste [data-rang="2"]', 'aria-pressed'), 'true');
  // Les icônes : les quatre flèches.
  await page.click('#explo-vue-icones');
  await page.focus('#explo-liste [data-rang="0"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-rang')), '1');
});

for (const clair of [false, true]) {
  test(`R6 — thème ${clair ? 'clair' : 'sombre'} : chaque texte de l'explorateur se lit (≥ 4,5:1)`, AVEC_NAVIGATEUR, async (t) => {
    const { page } = await ouvrir(t, { largeur: 1280, hauteur: 900, clair });
    await page.click('[data-cle="arbre-free-mobile"]');
    await attendreListe(page);
    await page.click('#explo-liste .explo-ligne-choix');
    const selecteurs = [
      '.explo-espace.active', '.explo-espace:not(.active)', '.explo-aide', '.explo-fil-bouton:not([aria-current])',
      '.explo-fil-bouton[aria-current]', '.explo-tri', '#explo-tri', '#explo-q', '.explo-vue.active', '.explo-vue:not(.active)',
      '.explo-noeud[aria-current="true"] .explo-noeud-nom', '.explo-noeud:not([aria-current]) .explo-noeud-nom',
      '.explo-noeud:not([aria-current]) .explo-noeud-nb', '.explo-entete span', '.explo-ligne.choisie .explo-nom',
      '.explo-ligne.choisie .explo-col', '.explo-ligne:not(.choisie) .explo-nom', '.explo-ligne:not(.choisie) .explo-col',
      '.explo-pdf', '.explo-compte', '.explo-lien-base', '#explo-detail-nom', '#explo-detail dt', '#explo-detail dd',
      '#explo-detail .explo-detail-note', '#explo-detail .explo-btn.principal', '#explo-copier',
    ];
    for (const sel of selecteurs) {
      const { texte, fond } = await couleursDe(page, sel);
      assert.ok(contraste(texte, fond) >= 4.5, `${sel} : ${contraste(texte, fond).toFixed(2)}`);
    }
    // L'indication du champ de recherche.
    const indication = await page.$eval('#explo-q', (e) => getComputedStyle(e, '::placeholder').color);
    const { fond } = await couleursDe(page, '.explo-recherche');
    assert.ok(contraste(indication, fond) >= 4.5, `indication : ${contraste(indication, fond).toFixed(2)}`);
    // Les icônes.
    await page.click('#explo-vue-icones');
    for (const sel of ['.explo-icone-nom', '.explo-icone-meta', '.explo-icone .explo-pdf']) {
      const c = await couleursDe(page, sel);
      assert.ok(contraste(c.texte, c.fond) >= 4.5, `${sel} : ${contraste(c.texte, c.fond).toFixed(2)}`);
    }
  });
}

test('R6 — la feuille du lot 107 n\'écrit aucune couleur en dur, ne nomme aucune police nouvelle, et chaque élément cliquable a son focus', () => {
  assert.ok(LOT107.length > 3000, 'le bloc du lot 107 est en fin de feuille');
  const sansCommentaires = LOT107.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(sansCommentaires.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  for (const c of sansCommentaires.match(/rgba?\([^)]*\)/g) || []) assert.match(c, /^rgba\(0,0,0,\.(35|12)\)$/, `${c} : seule l'ombre des panneaux`);
  for (const police of sansCommentaires.match(/font-family:[^;}]+/g) || []) assert.match(police, /^font-family:'Space Grotesk',sans-serif$/);
  for (const classe of [
    '.explo-espace', '.explo-tri select', '.explo-fil-bouton', '.explo-vue', '.explo-noeud', '.explo-dl', '.explo-icone',
    '.explo-plus', '.explo-reessayer', '.explo-btn', '.explo-detail-fermer', '.explo-lien-base', '.explo-choix select', '.explo-ligne-choix',
  ]) {
    const motif = new RegExp(`${classe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible[^{]*\\{[^}]*outline:2px solid var\\(--accent\\)`);
    const enListe = new RegExp(`${classe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible,`);
    assert.ok(motif.test(sansCommentaires) || enListe.test(sansCommentaires), `${classe} : focus visible`);
  }
});
