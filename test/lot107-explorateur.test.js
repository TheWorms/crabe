'use strict';

/**
 * Lot 107, R3 — l'explorateur « Mes documents », au vrai Chromium.
 *
 * La coque (arbre, chemin, liste, icônes, « Afficher plus »), le détail, les
 * onglets d'espace, la recherche, le tri et l'adresse ; les états de
 * chargement, vide et d'erreur. Banc de `lot107-commun.js` : données
 * inventées, comptes nommés par leur rôle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { LOCAL, NOM_LOCAL, peupler, peuplerSerie, regler } = require('./lot107-commun');

const HORLOGE = new Date('2026-10-01T10:00:00Z');
let titulaire;
let voisine;
let gerante;
let client;
let idVoisine;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });
  peupler(titulaire);
  peuplerSerie(titulaire, 50);
  [idVoisine] = peupler(voisine, { jeu: [['gandi', 'org-essai-voisine', 'voisine_document_essai.pdf', '2026-01-01', '2026-01-02 00:00:00', 1000]], fichiers: false });
  // La gérante (droit de gérer le stockage) : un document de taille inconnue.
  gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  peupler(gerante, { jeu: [['ovh', 'xx00000-ovh', 'taille_inconnue_essai.pdf', '2026-02-01', '2026-02-02 00:00:00', 0]], fichiers: false });
  regler(titulaire.id, 'explorer');
  regler(voisine.id, 'explorer');
  regler(gerante.id, 'explorer');
  client = await helpers.startServer();
});

test.after(async () => {
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

/** Ouvre « Mes documents » en explorateur, première page lue. */
async function ouvrirExplorateur(t, options = {}) {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, options.compte || 'titulaire', options);
  t.after(fermer);
  await page.clock.setFixedTime(HORLOGE);
  if (!options.sansOuvrir) {
    await page.evaluate(() => showView('documents'));
    await attendreListe(page);
  }
  return { page, erreursJs };
}

const attendreListe = (page) => page.waitForFunction(() => {
  const l = document.getElementById('explo-liste');
  return l && l.getAttribute('aria-busy') === 'false';
});

/** Les rangs de l'arbre : nom et nombre (la pastille est tue). */
const nœuds = (page, sel = '#explo-arbre .explo-noeud') => page.$$eval(sel, (l) => l.map((e) =>
  `${e.querySelector('.explo-noeud-nom').textContent} ${e.querySelector('.explo-noeud-nb').textContent}`));

const textes = (page, sel) => page.$$eval(sel, (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

test('R3 — la coque : l\'explorateur remplace les cartes, l\'arbre dit les services du compte et leurs nombres', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrirExplorateur(t);
  assert.equal(await page.locator('#explo').count(), 1);
  assert.equal(await page.locator('#docs-content .docs-filters').count(), 0, 'rien de l\'interface de base');
  assert.equal(await page.getAttribute('#explo-arbre', 'aria-label'), 'Services');
  assert.deepEqual(await nœuds(page), [
    'Tous les services 59', 'Free Internet 3', 'Free Mobile 3', 'Hetzner 1', 'OVH 2', 'Scaleway 50',
  ]);
  assert.equal(await page.getAttribute('[data-cle="arbre-tous"]', 'aria-current'), 'true');
  // La voisine et ses services n'existent pas ici.
  assert.equal((await page.textContent('#explo')).includes('voisine'), false);
  assert.equal(await page.locator('[data-cle="arbre-gandi"]').count(), 0);
  // Chaque élément est un vrai bouton ; les pastilles sont celles des services.
  assert.equal(await page.locator('#explo-arbre button.explo-noeud').count(), 6);
  assert.equal(await page.locator('#explo-arbre .conn-icon.explo-pastille').count(), 5);
  assert.deepEqual(erreursJs, []);
});

test('R3 — un service s\'ouvre sur ses années ; une année filtre ; le chemin se remonte à chaque niveau', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrirExplorateur(t);
  await page.click('[data-cle="arbre-free-mobile"]');
  await attendreListe(page);
  assert.equal(await page.getAttribute('[data-cle="arbre-free-mobile"]', 'aria-expanded'), 'true');
  assert.equal(await page.getAttribute('[data-cle="arbre-free-mobile"]', 'aria-current'), 'true');
  assert.deepEqual(await nœuds(page, '#explo-arbre .explo-annee'), ['2026 2', '2025 1']);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 3);
  // Le focus est resté sur le service cliqué (zone redessinée).
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-cle')), 'arbre-free-mobile');

  await page.click('[data-cle="arbre-free-mobile-2026"]');
  await attendreListe(page);
  assert.equal(await page.getAttribute('[data-cle="arbre-free-mobile-2026"]', 'aria-current'), 'true');
  assert.deepEqual((await textes(page, '#explo-liste .explo-nom')).sort(), ['2026-09_ligne_essai_a.pdf', '2026-09_ligne_essai_b.pdf']);
  assert.deepEqual(await textes(page, '#explo-fil .explo-fil-bouton'), [NOM_LOCAL, 'Free Mobile', '2026']);
  assert.equal(await page.getAttribute('[data-cle="fil-annee"]', 'aria-current'), 'location');
  assert.equal(await page.locator('#explo-fil button').count(), 3, 'chaque niveau est un bouton');

  await page.click('[data-cle="fil-service"]');
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 3);
  assert.deepEqual(await textes(page, '#explo-fil .explo-fil-bouton'), [NOM_LOCAL, 'Free Mobile']);

  await page.click('[data-cle="fil-espace"]');
  await attendreListe(page);
  assert.deepEqual(await textes(page, '#explo-fil .explo-fil-bouton'), [NOM_LOCAL]);
  assert.equal(await page.locator('#explo-arbre .explo-annee').count(), 0);
  assert.deepEqual(erreursJs, []);
});

test('R3 — la liste : Nom, Service · compte (le compte là seulement où il y en a plusieurs), Période, Taille, Récupéré, téléchargement', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t);
  assert.deepEqual(await textes(page, '.explo-entete span'), ['Nom', 'Service · compte', 'Période', 'Taille', 'Récupéré', '']);
  const premiere = await page.$$eval('#explo-liste .explo-ligne', (l) => l.slice(0, 3).map((li) => ({
    nom: li.querySelector('.explo-nom').textContent,
    service: li.querySelector('.explo-col-service').textContent,
    periode: li.querySelector('.explo-col-periode').textContent,
    taille: li.querySelector('.explo-col-taille').textContent,
    recupere: li.querySelector('.explo-col-recupere').textContent,
    lien: li.querySelector('a.explo-dl').getAttribute('href'),
    nomLien: li.querySelector('a.explo-dl').getAttribute('aria-label'),
  })));
  assert.deepEqual(premiere[0], {
    nom: '2026-09_ligne_essai_b.pdf', service: 'Free Mobile · Compte …0002', periode: '2026-09', taille: '21.0 Ko',
    recupere: 'il y a 19 j', lien: premiere[0].lien, nomLien: 'Télécharger 2026-09_ligne_essai_b.pdf',
  });
  assert.match(premiere[0].lien, new RegExp(`^/api/documents/${LOCAL}/\\d+/file$`));
  assert.equal(premiere[2].service, 'Free Internet', 'un seul compte : le service seul');
  // Aucun identifiant de compte entier à l'écran.
  assert.equal((await page.textContent('#explo')).includes('0600000002'), false);
  // Les lignes sont des boutons à bascule.
  assert.equal(await page.getAttribute('#explo-liste .explo-ligne-choix >> nth=0', 'aria-pressed'), 'false');
});

test('R3 — « Icônes » / « Liste » : bascule dite (aria-pressed), retenue par le navigateur', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t);
  assert.equal(await page.getAttribute('#explo-vue-liste', 'aria-pressed'), 'true');
  await page.click('#explo-vue-icones');
  assert.equal(await page.getAttribute('#explo-vue-icones', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#explo-vue-liste', 'aria-pressed'), 'false');
  assert.equal(await page.locator('#explo-liste .explo-icone').count(), 40);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('crabe.documents.vue')), 'icones');
  // Rechargée, la page revient en icônes.
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Comme `ouvrirCrabe` : `boot()` ouvre l'accueil APRÈS avoir posé `state.me`.
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.me && document.querySelector('.view.active'));
  await page.evaluate(() => showView('documents'));
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-icone').count(), 40);
  await page.click('#explo-vue-liste');
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);
});

test('R3 — sans stockage local permis, la page marche (vue en liste)', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrirExplorateur(t, {
    sansOuvrir: true,
    preparer: (p) => p.addInitScript(() => {
      const refus = () => { throw new Error('stockage refusé'); };
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => ({ getItem: (k) => (k === 'crabe.theme' ? 'dark' : refus()), setItem: refus, removeItem: refus }) });
    }),
  });
  await page.evaluate(() => showView('documents'));
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);
  await page.click('#explo-vue-icones');
  assert.equal(await page.locator('#explo-liste .explo-icone').count(), 40);
  assert.deepEqual(erreursJs, []);
});

test('R2/R3 — 40 lignes au plus ; « Afficher plus » lit la page suivante et donne le focus à la première ligne neuve', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);
  assert.ok((await page.textContent('#explo-pied')).includes(`59 documents · 40 affichés · ${NOM_LOCAL}`));
  await page.click('#explo-plus');
  await page.waitForFunction(() => document.querySelectorAll('#explo-liste .explo-ligne').length === 59);
  assert.equal(await page.locator('#explo-plus').count(), 0, 'plus rien à lire');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-rang')), '40');
  assert.equal((await page.textContent('#explo-pied .explo-compte')).trim(), `59 documents · ${NOM_LOCAL}`);
});

test('R3 — états : « Chargement… » à la place de la liste, erreur dite avec « Réessayer », vide dit', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrirExplorateur(t);
  // Chargement : la réponse retenue, la liste dit qu'elle charge et garde sa hauteur.
  let relacher;
  const retenue = new Promise((r) => { relacher = r; });
  await page.route('**/api/documents/explorateur*', async (route) => { await retenue; await route.continue(); });
  const hauteur = await page.$eval('#explo-liste', (e) => e.offsetHeight);
  await page.evaluate(() => { explorateurService('ovh'); });
  await page.waitForFunction(() => /Chargement…/.test(document.getElementById('explo-liste').textContent));
  assert.equal(await page.getAttribute('#explo-liste', 'aria-busy'), 'true');
  assert.ok(await page.$eval('#explo-liste', (e) => e.offsetHeight) >= hauteur - 1, 'la liste garde sa place');
  relacher();
  await attendreListe(page);
  await page.unroute('**/api/documents/explorateur*');
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 2);

  // Erreur du serveur : une phrase qui dit quoi faire, et « Réessayer ».
  await page.route('**/api/documents/explorateur*', (route) => route.fulfill({ status: 500, json: { error: 'Erreur interne' } }));
  await page.evaluate(() => explorateurService(''));
  await page.waitForSelector('#explo-liste [role="alert"]');
  assert.match(await page.textContent('#explo-liste'), /Impossible de lire vos documents pour le moment\. Vérifiez que le serveur de crabe répond, puis réessayez\./);
  assert.equal((await page.textContent('#explo-liste')).includes('Erreur interne'), false, 'aucun détail technique');
  await page.unroute('**/api/documents/explorateur*');
  await page.click('#explo-liste .explo-reessayer');
  await attendreListe(page);
  assert.equal(await page.locator('#explo-liste .explo-ligne').count(), 40);

  // Réseau coupé : la même phrase.
  await page.route('**/api/documents/explorateur*', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => explorateurService('ovh'));
  await page.waitForSelector('#explo-liste [role="alert"]');
  assert.match(await page.textContent('#explo-liste'), /Vérifiez que le serveur de crabe répond/);
  await page.unroute('**/api/documents/explorateur*');

  // Vide : rien ne correspond.
  await page.evaluate(() => { explo.filtre.q = 'aucun-document-de-ce-nom'; return chargerExplorateur(); });
  await attendreListe(page);
  assert.equal((await page.textContent('#explo-liste')).trim(), 'Aucun document ne correspond à cette recherche.');
  // Rien à sélectionner : le panneau de détail n'invite pas à choisir (vu à la capture, D1).
  assert.equal(await page.$eval('#explo-detail', (e) => e.innerHTML.trim()), '');
  assert.equal(await page.isVisible('#explo-detail'), false);
  assert.deepEqual(erreursJs, []);
});

/** Les lignes du détail : `[étiquette, valeur]`. */
const faitsDuDetail = (page) => page.$$eval('#explo-detail .explo-faits dt', (l) => l.map((dt) => [
  dt.textContent, dt.nextElementSibling.querySelector('.explo-chemin')?.textContent ?? dt.nextElementSibling.textContent,
]));

test('R3 — le détail : la sélection l\'ouvre sans déplacer le focus, une seconde sélection le referme, Échap aussi', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs } = await ouvrirExplorateur(t);
  assert.equal((await page.textContent('#explo-detail')).trim(), `Sélectionnez un document pour voir son détail, le télécharger ou copier le chemin de son dossier sur ${NOM_LOCAL}.`);
  const ligne = page.locator('#explo-liste .explo-ligne-choix').first();
  await ligne.focus();
  await page.keyboard.press('Enter');
  assert.equal(await ligne.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-rang')), '0', 'le focus reste sur la ligne');
  assert.equal(await page.textContent('#explo-detail-nom'), '2026-09_ligne_essai_b.pdf');
  assert.deepEqual(await faitsDuDetail(page), [
    ['Service', 'Free Mobile'], ['Compte', 'Compte …0002'], ['Période', '2026-09'], ['Taille', '21.0 Ko'],
    ['Récupéré', 'il y a 19 j'], ['Dossier', 'titulaire/Free Mobile'],
  ]);
  assert.equal((await page.textContent('#explo-detail .explo-detail-note')).trim(), `Le dossier du service, depuis le dossier de crabe sur ${NOM_LOCAL}.`);
  // Deux gestes, jamais deux boutons identiques : aucune adresse de dossier n'est connue.
  assert.deepEqual(await page.$$eval('#explo-detail .explo-gestes > *', (l) => l.map((e) => [e.tagName, e.textContent.trim()])),
    [['A', 'Télécharger'], ['BUTTON', 'Copier le chemin']]);
  assert.equal(await page.locator('#explo-detail [target="_blank"]').count(), 0);

  // Seconde sélection : refermé, focus inchangé.
  await page.keyboard.press('Enter');
  assert.equal(await ligne.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#explo-detail-nom').count(), 0);
  // Échap referme le détail et rend le focus à la ligne.
  await page.keyboard.press('Enter');
  await page.focus('#explo-copier');
  await page.keyboard.press('Escape');
  assert.equal(await ligne.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-rang')), '0');
  assert.deepEqual(erreursJs, []);
});

test('R3 — un champ que la base ne porte pas n\'a pas de ligne ; la racine se montre à qui gère le stockage', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t, { compte: 'gerante' });
  assert.equal(await page.textContent('#explo-liste .explo-col-taille'), '—');
  await page.click('#explo-liste .explo-ligne-choix');
  const faits = await faitsDuDetail(page);
  assert.deepEqual(faits.map(([e]) => e), ['Service', 'Période', 'Récupéré', 'Dossier'], 'ni compte (un seul), ni taille (inconnue)');
  assert.equal(faits[3][1], `${process.env.CRABE_LOCAL_PATH.replace(/\/+$/, '')}/gerante/OVH`);
  assert.equal(await page.textContent('#explo-detail .explo-detail-note'), `Le dossier du service sur ${NOM_LOCAL}.`);
});

test('R3 — « Ouvrir le dossier » n\'existe qu\'avec une adresse https, en nouvel onglet sans référent, à côté de « Copier le chemin »', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t);
  await page.click('#explo-liste .explo-ligne-choix');
  const gestes = async (adresse) => page.evaluate((a) => {
    for (const s of explo.donnees.services) s.dossier = { ...s.dossier, adresse: a };
    dessinerDetailExplorateur();
    return [...document.querySelectorAll('#explo-detail .explo-gestes > *')].map((e) => ({
      balise: e.tagName, texte: e.textContent.trim(), href: e.getAttribute('href'), cible: e.getAttribute('target'), rel: e.getAttribute('rel'),
    }));
  }, adresse);
  const avec = await gestes('https://exemple.invalid/dossier');
  assert.deepEqual(avec.map((g) => [g.balise, g.texte]), [['A', 'Télécharger'], ['A', `Ouvrir le dossier dans ${NOM_LOCAL}`], ['BUTTON', 'Copier le chemin']]);
  assert.deepEqual([avec[1].href, avec[1].cible, avec[1].rel], ['https://exemple.invalid/dossier', '_blank', 'noopener noreferrer']);
  for (const autre of ['javascript:alert(1)', 'http://exemple.invalid', 'file:///mnt', null]) {
    assert.deepEqual((await gestes(autre)).map((g) => g.texte), ['Télécharger', 'Copier le chemin'], String(autre));
  }
});

test('R3 — « Télécharger » : la route de toujours, et sa garde', AVEC_NAVIGATEUR, async (t) => {
  const { page } = await ouvrirExplorateur(t);
  await page.click('#explo-liste .explo-ligne-choix');
  const href = await page.getAttribute('#explo-detail a.principal', 'href');
  assert.match(href, new RegExp(`^/api/documents/${LOCAL}/\\d+/file$`));
  assert.equal(href, await page.getAttribute('#explo-liste .explo-ligne >> nth=0 >> a.explo-dl', 'href'));
  const reponse = await page.request.get(`${client.base}${href}`);
  assert.equal(reponse.status(), 200);
  assert.match((await reponse.body()).toString('latin1'), /^%PDF-1\.4/);
  // Le document d'un autre compte : 404, comme toujours.
  const forge = await page.request.get(`${client.base}/api/documents/${LOCAL}/${idVoisine}/file`);
  assert.equal(forge.status(), 404);
});

for (const sur of [true, false]) {
  test(`R3 — « Copier le chemin », ${sur ? 'presse-papiers du navigateur' : 'presse-papiers indisponible : le chemin sélectionné'}`, AVEC_NAVIGATEUR, async (t) => {
    const { page, erreursJs } = await ouvrirExplorateur(t);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: client.base });
    if (!sur) {
      await page.evaluate(() => {
        Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
        document.execCommand = () => false;
      });
    }
    await page.evaluate(() => navigator.clipboard.writeText('rien'));
    await page.click('#explo-liste .explo-ligne-choix');
    await page.click('#explo-copier');
    if (sur) {
      await page.waitForFunction((nom) => document.getElementById('toast').textContent === `Chemin copié (depuis le dossier de crabe sur ${nom}) : titulaire/Free Mobile`, NOM_LOCAL);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'titulaire/Free Mobile');
      assert.equal((await page.textContent('#explo-copier')).trim(), 'Chemin copié');
    } else {
      await page.waitForFunction((nom) => document.getElementById('toast').textContent === `La copie n'est pas possible dans ce navigateur. Le chemin (depuis le dossier de crabe sur ${nom}) : titulaire/Free Mobile`, NOM_LOCAL);
      assert.equal(await page.evaluate(() => window.getSelection().toString()), 'titulaire/Free Mobile', 'le chemin est sélectionné');
      assert.match(await page.textContent('#explo-copie-aide'), /le chemin est sélectionné ci-dessus, copiez-le/);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'rien', 'rien n\'a été copié en douce');
    }
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'explo-copier', 'le focus reste sur le bouton');
    assert.deepEqual(erreursJs, []);
  });
}
