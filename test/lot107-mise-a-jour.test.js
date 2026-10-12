'use strict';

/**
 * Lot 107, R10 — la fenêtre « Vérifier les mises à jour ».
 *
 * Côté serveur : la vérification EN DÉTAIL (« coupee », « impossible »,
 * « a-jour », « disponible »), la même interrogation que la bannière — même
 * adresse, même cadence —, un échec jamais présenté comme « à jour », aucune
 * adresse de page inventée, rien d'écrit au journal. GitHub y est SIMULÉ :
 * `fetch` est remplacé dans ce processus, et tout appel sortant est relevé.
 *
 * Au vrai Chromium : les quatre états, la recherche simulée par la route
 * (aucun appel réseau réel), le bouton désactivé pendant la recherche, un
 * double clic qui ne lance qu'une recherche, le lien seulement s'il est
 * connu, Échap / clic à côté / piège du focus, aucune trace technique.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const permissions = require('../server/permissions');
const version = require('../server/version');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur, contraste, couleursDe, debordement } = require('./lot106-commun');

const VRAI_FETCH = globalThis.fetch;
const sortants = [];
let reponseGithub = null;

/** Les tags tels que GitHub les rend : un tableau de {name}. */
const tags = (noms, ok = true) => ({ ok, json: async () => noms.map((name) => ({ name })) });

let client;

test.before(async () => {
  // GitHub simulé : seul 127.0.0.1 (le serveur d'essai) passe au vrai réseau.
  globalThis.fetch = async (adresse, options) => {
    const texte = String(adresse?.url ?? adresse);
    if (texte.startsWith('http://127.0.0.1')) return VRAI_FETCH(adresse, options);
    sortants.push(texte);
    if (reponseGithub instanceof Error) throw reponseGithub;
    if (!reponseGithub) throw new Error('aucune réponse simulée');
    return reponseGithub;
  };
  await helpers.setup();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  helpers.db.get().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  await helpers.createUser({ username: 'titulaire' });
  client = await helpers.startServer();
});

test.after(async () => {
  globalThis.fetch = VRAI_FETCH;
  delete process.env.CRABE_UPDATE_REPO;
  await client?.close();
  await fermerNavigateur();
  helpers.teardown();
});

const journal = () => helpers.db.get().prepare('SELECT COUNT(*) FROM app_logs').pluck().get();

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

test('R10 — verifierEnDetail : quatre états, et la bannière n\'en lit que « disponible »', async () => {
  const appels = [];
  const faux = (r) => async (url) => { appels.push(url); if (r instanceof Error) throw r; return r; };
  const cas = [
    ['', tags(['v9.9.9']), { etat: 'coupee', installee: version.VERSION }, null],
    ['qui/quoi', tags(['v9.9.9', 'v0.0.1']), { etat: 'disponible', installee: version.VERSION, trouvee: '9.9.9' }, { version: '9.9.9' }],
    ['qui/quoi', tags([`v${version.VERSION}`, 'v0.0.1']), { etat: 'a-jour', installee: version.VERSION, trouvee: version.VERSION }, null],
    ['qui/quoi', new Error('réseau coupé'), { etat: 'impossible', installee: version.VERSION }, null],
    ['qui/quoi', tags([], false), { etat: 'impossible', installee: version.VERSION }, null],
    ['qui/quoi', tags(['brouillon']), { etat: 'impossible', installee: version.VERSION }, null],
    ['qui/quoi', { ok: true, json: async () => { throw new Error('illisible'); } }, { etat: 'impossible', installee: version.VERSION }, null],
  ];
  for (const [repo, reponse, detail, banniere] of cas) {
    version.oublierVerification();
    assert.deepEqual(await version.verifierEnDetail({ fetchImpl: faux(reponse), repo }), detail, JSON.stringify(detail));
    version.oublierVerification();
    assert.deepEqual(await version.verifierMiseAJour({ fetchImpl: faux(reponse), repo }), banniere);
  }
  // Une seule adresse, toujours la même.
  assert.ok(appels.every((u) => u === 'https://api.github.com/repos/qui/quoi/tags?per_page=100'), appels.join(' | '));
});

test('R10 — la même cadence : une interrogation par jour, partagée entre la fenêtre et la bannière', async () => {
  version.oublierVerification();
  const appels = [];
  const faux = async (url) => { appels.push(url); return tags(['v9.9.9']); };
  const debut = 1_000_000_000_000;
  await version.verifierEnDetail({ fetchImpl: faux, repo: 'qui/quoi', maintenant: debut });
  assert.deepEqual(await version.verifierMiseAJour({ fetchImpl: faux, repo: 'qui/quoi', maintenant: debut + 60_000 }), { version: '9.9.9' });
  assert.equal(appels.length, 1);
});

test('R10 — la route : l\'état en détail, un échec jamais « à jour », aucun lien inventé, rien au journal', async () => {
  const c = await helpers.startServer();
  try {
    await helpers.login(c, 'gerante', 'MotDePasse1');
    const avant = journal();

    delete process.env.CRABE_UPDATE_REPO;
    let r = await c.post('/api/system/update-check');
    assert.deepEqual([r.status, r.body.etat, r.body.upToDate, r.body.lien], [200, 'coupee', null, null]);

    process.env.CRABE_UPDATE_REPO = 'qui/quoi';
    for (const [reponse, etat, aJour, trouvee] of [
      [tags(['v9.9.9']), 'disponible', false, '9.9.9'],
      [tags([`v${version.VERSION}`]), 'a-jour', true, version.VERSION],
      [new Error('réseau coupé'), 'impossible', null, null],
      [tags([], false), 'impossible', null, null],
    ]) {
      reponseGithub = reponse;
      r = await c.post('/api/system/update-check');
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.etat, r.body.upToDate, r.body.trouvee, r.body.installee, r.body.lien], [etat, aJour, trouvee, version.VERSION, null]);
      if (etat === 'impossible') assert.equal(/à jour/.test(r.body.message), false, 'un échec ne se dit jamais « à jour »');
    }
    assert.ok(sortants.length >= 4);
    assert.ok(sortants.every((u) => u === 'https://api.github.com/repos/qui/quoi/tags?per_page=100'), sortants.join(' | '));
    assert.equal(journal(), avant, 'rien de nouveau au journal');

    // Toujours une porte d'administrateur.
    const ordinaire = await helpers.startServer();
    try {
      await helpers.login(ordinaire, 'titulaire', 'MotDePasse1');
      assert.equal((await ordinaire.post('/api/system/update-check')).status, 403);
    } finally {
      await ordinaire.close();
    }
  } finally {
    delete process.env.CRABE_UPDATE_REPO;
    reponseGithub = null;
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

/** Ouvre Administration › Système ; la route de vérification est simulée. */
async function ouvrirSysteme(t, options = {}) {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'gerante', options);
  t.after(fermer);
  const appels = [];
  let reponse = { etat: 'a-jour', installee: '0.1.7', trouvee: '0.1.7', lien: null };
  let retenue = null;
  await page.route('**/api/system/update-check', async (route) => {
    appels.push(route.request().method());
    if (retenue) await retenue;
    if (reponse === 'erreur') return route.fulfill({ status: 500, json: { error: 'Erreur interne' } });
    if (reponse === 'coupure') return route.abort('internetdisconnected');
    return route.fulfill({ json: reponse });
  });
  await page.evaluate(() => { showView('admin'); showAdminPage('systeme', document.querySelector('[data-apage="systeme"]')); });
  await page.waitForSelector('#systeme-verifier-maj');
  return {
    page,
    erreursJs,
    appels,
    repondre: (r) => { reponse = r; },
    retenir: () => { let relacher; retenue = new Promise((ok) => { relacher = ok; }); return () => { retenue = null; relacher(); }; },
  };
}

const corps = (page) => page.$eval('#maj-corps', (e) => e.innerText.replace(/\s+/g, ' ').trim());
const attendreFin = (page) => page.waitForFunction(() => !document.getElementById('maj-dialog').hasAttribute('aria-busy'));

/** Aucun mot technique, aucune adresse, aucune trace à l'écran. */
function sansTechnique(texte) {
  for (const mot of [/dépôt/i, /\bAPI\b/, /timeout/i, /CRABE_UPDATE_REPO/, /colis/i, /https?:/, /Erreur interne/, /github\.com/i, /\bLXC\b/]) {
    assert.equal(mot.test(texte), false, `« ${mot} » à l'écran : ${texte}`);
  }
}

test('R10 — recherche, puis « à jour » : le bouton désactivé pendant la recherche, un dialogue modal titré', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, appels, retenir } = await ouvrirSysteme(t);
  const relacher = retenir();
  await page.click('#systeme-verifier-maj');
  assert.equal(await page.isVisible('#maj-dialog'), true);
  assert.deepEqual(await page.$eval('#maj-dialog', (d) => [d.getAttribute('role'), d.getAttribute('aria-modal'), document.getElementById(d.getAttribute('aria-labelledby')).textContent]),
    ['dialog', 'true', 'Vérifier les mises à jour']);
  assert.equal(await corps(page), 'Recherche d\'une mise à jour…');
  assert.equal(await page.isDisabled('#systeme-verifier-maj'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'maj-fermer', 'le focus entre dans la fenêtre');
  relacher();
  await attendreFin(page);
  assert.equal(await corps(page), 'crabe est à jour Version installée : v0.1.7');
  assert.equal(await page.isDisabled('#systeme-verifier-maj'), false);
  assert.deepEqual(appels, ['POST']);
  sansTechnique(await corps(page));
  assert.deepEqual(erreursJs, []);
});

test('R10 — « Une mise à jour est disponible » : les deux versions, le lien seulement s\'il est connu (nouvel onglet, sans référent)', AVEC_NAVIGATEUR, async (t) => {
  const { page, repondre } = await ouvrirSysteme(t);
  repondre({ etat: 'disponible', installee: '0.1.7', trouvee: '0.1.8', lien: null });
  await page.click('#systeme-verifier-maj');
  await attendreFin(page);
  assert.equal(await corps(page), 'Une mise à jour est disponible Version installée v0.1.7 Version trouvée v0.1.8 crabe ne se met pas à jour tout seul : la personne qui gère ce serveur installe la nouvelle version.');
  assert.equal(await page.locator('#maj-corps a').count(), 0, 'aucune adresse connue : aucun lien');
  assert.equal(await page.locator('#maj-corps button').count(), 0, 'rien à lancer, rien à installer');
  sansTechnique(await corps(page));
  await page.keyboard.press('Escape');

  // Une adresse connue (simulée) : le bouton-lien.
  repondre({ etat: 'disponible', installee: '0.1.7', trouvee: '0.1.8', lien: 'https://exemple.invalid/versions/v0.1.8' });
  await page.click('#systeme-verifier-maj');
  await attendreFin(page);
  assert.deepEqual(await page.$eval('#maj-corps a', (a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
    ['Voir la version sur GitHub', 'https://exemple.invalid/versions/v0.1.8', '_blank', 'noopener noreferrer']);
  await page.keyboard.press('Escape');

  // Une adresse qui n'est pas https, ou un lien sans version trouvée : rien.
  for (const r of [
    { etat: 'disponible', installee: '0.1.7', trouvee: '0.1.8', lien: 'javascript:alert(1)' },
    { etat: 'a-jour', installee: '0.1.7', trouvee: '0.1.7', lien: 'https://exemple.invalid/versions' },
    { etat: 'disponible', installee: '0.1.7', trouvee: '', lien: 'https://exemple.invalid/versions' },
  ]) {
    repondre(r);
    await page.click('#systeme-verifier-maj');
    await attendreFin(page);
    assert.equal(await page.locator('#maj-corps a').count(), 0, JSON.stringify(r));
    await page.keyboard.press('Escape');
  }
});

test('R10 — « Impossible de vérifier » : erreur, réseau coupé, réponse inconnue, délai dépassé — avec « Réessayer » ; jamais « à jour »', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, appels, repondre, retenir } = await ouvrirSysteme(t);
  const attendu = 'Impossible de vérifier pour le moment Réessayez plus tard, et vérifiez que le serveur de crabe a bien accès à Internet. Réessayer';
  for (const r of ['erreur', 'coupure', { etat: 'bizarre' }, { etat: 'impossible', installee: '0.1.7' }, { etat: 'a-jour' }]) {
    repondre(r);
    await page.click('#systeme-verifier-maj');
    await attendreFin(page);
    assert.equal(await corps(page), attendu, JSON.stringify(r));
    assert.equal(/à jour/.test(await corps(page)), false);
    sansTechnique(await corps(page));
    await page.keyboard.press('Escape');
  }
  // La durée maximale : au-delà, l'état 4 (borne réduite pour l'essai).
  const relacher = retenir();
  await page.evaluate(() => ouvrirVerificationMiseAJour({ declencheur: document.getElementById('systeme-verifier-maj'), delai: 300 }));
  await attendreFin(page);
  assert.equal(await corps(page), attendu);
  relacher();
  // « Réessayer » : une nouvelle recherche, qui aboutit.
  repondre({ etat: 'a-jour', installee: '0.1.7', trouvee: '0.1.7', lien: null });
  const avant = appels.length;
  await page.click('#maj-reessayer');
  await attendreFin(page);
  assert.equal(await corps(page), 'crabe est à jour Version installée : v0.1.7');
  assert.equal(appels.length, avant + 1);
  await page.keyboard.press('Escape');

  // Coupée sur ce serveur : dit, sans « Réessayer » (rien n'y changerait).
  repondre({ etat: 'coupee', installee: '0.1.7', trouvee: null, lien: null, message: 'Vérification coupée : CRABE_UPDATE_REPO est vide.' });
  await page.click('#systeme-verifier-maj');
  await attendreFin(page);
  assert.equal(await corps(page), 'Impossible de vérifier pour le moment La recherche des mises à jour n\'est pas activée sur ce serveur : la personne qui l\'a installé peut l\'activer.');
  sansTechnique(await corps(page));
  assert.deepEqual(erreursJs, []);
});

test('R10 — un double clic ne lance qu\'une recherche ; Échap et le clic à côté ferment, le focus revient au bouton ; la tabulation reste dans la fenêtre', AVEC_NAVIGATEUR, async (t) => {
  const { page, appels, retenir, repondre } = await ouvrirSysteme(t);
  repondre({ etat: 'disponible', installee: '0.1.7', trouvee: '0.1.8', lien: 'https://exemple.invalid/v' });
  const relacher = retenir();
  await page.dblclick('#systeme-verifier-maj', { force: true });
  await page.evaluate(() => { checkUpdates(document.getElementById('systeme-verifier-maj')); });
  relacher();
  await attendreFin(page);
  assert.equal(appels.length, 1, 'une seule recherche');

  // Tabulation : du lien au ✕, et retour.
  await page.focus('#maj-fermer');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'maj-lien');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'maj-fermer');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'maj-lien');

  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#maj-dialog'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'systeme-verifier-maj');

  await page.click('#systeme-verifier-maj');
  await attendreFin(page);
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible('#maj-dialog'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'systeme-verifier-maj');

  // Fermée pendant la recherche : le bouton revient, et rouvrir se raccroche à la même recherche.
  const relacher2 = retenir();
  await page.click('#systeme-verifier-maj');
  await page.keyboard.press('Escape');
  assert.equal(await page.isDisabled('#systeme-verifier-maj'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'systeme-verifier-maj');
  await page.click('#systeme-verifier-maj');
  relacher2();
  await attendreFin(page);
  assert.equal(appels.length, 3, 'une recherche par ouverture, aucune de plus');
});

for (const clair of [false, true]) {
  test(`R10 — thème ${clair ? 'clair' : 'sombre'}, 390 px : la fenêtre se lit et tient dans l'écran`, AVEC_NAVIGATEUR, async (t) => {
    const { page, repondre } = await ouvrirSysteme(t, { largeur: 390, hauteur: 844, clair });
    for (const r of [{ etat: 'disponible', installee: '0.1.7', trouvee: '0.1.8', lien: 'https://exemple.invalid/v' }, 'erreur']) {
      repondre(r);
      await page.evaluate(() => checkUpdates(document.getElementById('systeme-verifier-maj')));
      await attendreFin(page);
      const d = await debordement(page);
      assert.ok(d.scroll <= d.largeur, d.fautifs.join(' ; '));
      for (const sel of ['#maj-titre', '.maj-annonce', '.maj-texte', '#maj-fermer', r === 'erreur' ? '#maj-reessayer' : '.maj-lien']) {
        const { texte, fond } = await couleursDe(page, sel);
        assert.ok(contraste(texte, fond) >= 4.5, `${sel} : ${contraste(texte, fond).toFixed(2)}`);
      }
      await page.keyboard.press('Escape');
    }
  });
}
