'use strict';

/**
 * Lot 106, R3 — la modale du connecteur (accueil).
 *
 * Mesurée dans un vrai Chromium, sur un serveur d'essai et des données
 * inventées : en-tête d'état, bandeau de reconnexion, barre d'actions (dont
 * « Ajouter un autre compte », présent ou absent selon le connecteur), trois
 * onglets, AUCUN suivi d'actions, comptes masqués, pause, focus piégé puis
 * rendu, deux thèmes, téléphone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const discovery = require('../server/connectors/discovery');
const { AVEC_NAVIGATEUR, ouvrirCrabe, contraste, couleursDe, debordement, fermerNavigateur } = require('./lot106-commun');

// Des numéros visiblement faux : ils ne doivent jamais paraître en entier.
const LIGNE_A = '0600000001';
const LIGNE_B = '0600000002';
// Le stockage local des essais, nommé en un seul endroit (comme au lot 98).
const LOCAL = 'local';
const DEPOSE = JSON.stringify({ [LOCAL]: { state: 'ok' } });

let titulaire;

/** Un service installé, configuré, synchronisé il y a trois jours. */
function installer(userId, id) {
  registry.install(userId, id);
  helpers.db.get().prepare(
    `UPDATE connector_installs SET status = 'installed', config_encrypted = ?,
            last_run_at = datetime('now', '-3 days'), disabled_at = NULL
      WHERE user_id = ? AND connector_id = ?`
  ).run(helpers.crypto.encrypt(JSON.stringify({ historique: 'depuis' })), userId, id);
}

function documents(userId, id, compte, n) {
  const ins = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
     VALUES (?, ?, ?, ?, 2048, ?, datetime('now', ?), ?)`
  );
  for (let i = 1; i <= n; i += 1) {
    ins.run(userId, id, `${id}_2026-0${i}_essai-${compte.slice(-2)}-${i}.pdf`, compte, `2026-0${i}-05`, `-${i} days`, DEPOSE);
  }
}

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  installer(titulaire.id, 'free-mobile');
  documents(titulaire.id, 'free-mobile', LIGNE_A, 3);
  documents(titulaire.id, 'free-mobile', LIGNE_B, 2);
  discovery.save(titulaire.id, 'free-mobile', 'lignes', [
    { id: LIGNE_A, label: 'Camille' },
    { id: LIGNE_B, label: 'Camille' },
  ]);
  installer(titulaire.id, 'kubii');
  documents(titulaire.id, 'kubii', 'camille@exemple.fr', 1);
  installer(titulaire.id, 'aagaard');
  // Aagaard : la dernière récupération a trouvé une session expirée.
  helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message, cause)
     VALUES ('aagaard', ?, datetime('now', '-2 hours'), datetime('now', '-2 hours'), 0, 'cron', 'Session expirée', 'session-expiree')`
  ).run(titulaire.id);
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

/** Ouvre la modale d'un service depuis sa vignette de l'accueil, au clavier. */
async function ouvrirModale(page, id) {
  await page.waitForSelector(`.conn-item[onclick="openHomeConnector('${id}')"]`);
  await page.focus(`.conn-item[onclick="openHomeConnector('${id}')"]`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#qv-overlay.show #qv-dialog');
  await page.waitForFunction((nom) => document.getElementById('qv-name').textContent.length > 0 && !!nom, id);
}

const texte = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());

test('R3 — la structure : un dialogue, trois onglets, aucun suivi d\'actions dans le balisage', () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'web', 'app.html'), 'utf8');
  const modale = html.slice(html.indexOf('<div class="modal-overlay" id="qv-overlay">'), html.indexOf('<!-- ================= Gestion des accès'));
  assert.match(modale, /role="dialog" aria-modal="true" aria-labelledby="qv-name"/);
  assert.deepEqual([...modale.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]), ['Aperçu', 'Comptes', 'Destinations']);
  assert.equal((modale.match(/role="tabpanel"/g) || []).length, 3);
  const sansCommentaires = modale.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(sansCommentaires, /Suivi d['’]actions|Suivi actions|Activité|Journal/i);
});

test('R3 — au vrai Chromium : en-tête, actions, onglets, comptes masqués, destinations ; pas de suivi d\'actions ; focus piégé et rendu', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);

  await ouvrirModale(page, 'free-mobile');
  assert.equal(await page.textContent('#qv-name'), 'Free Mobile');
  assert.match(await texte(page, '#qv-etat'), /^Connecté · dernière synchronisation il y a 3 j/);
  assert.equal(await page.innerHTML('#qv-bandeau'), '', 'aucun bandeau quand tout va bien');

  // La barre d'actions.
  assert.deepEqual(await page.$$eval('#qv-actions > *', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ').trim())),
    ['Synchroniser maintenant', 'Ouvrir le site ↗ (nouvel onglet)', 'Mettre en pause', '+ Ajouter un autre compte']);
  const site = await page.$eval('#qv-site', (a) => ({ tag: a.tagName, href: a.href, target: a.target, rel: a.rel }));
  assert.deepEqual(site, { tag: 'A', href: 'https://mobile.free.fr/', target: '_blank', rel: 'noopener noreferrer' });

  // Les onglets.
  assert.deepEqual(await page.$$eval('[role="tab"]', (l) => l.filter((e) => e.closest('#qv-dialog')).map((e) => [e.innerText.trim(), e.getAttribute('aria-selected')])),
    [['Aperçu', 'true'], ['Comptes (2)', 'false'], ['Destinations', 'false']]);
  // Aperçu : les TROIS derniers documents, chacun téléchargeable.
  assert.equal(await page.$$eval('#qv-docs .qv-doc', (l) => l.length), 3);
  assert.equal(await page.$$eval('#qv-docs a.doc-dl[download][aria-label^="Télécharger "]', (l) => l.length), 3);
  assert.equal(await page.isVisible('#qv-panel-apercu .qv-open-btn'), true);
  assert.deepEqual(await page.$$eval('#qv-liens .mc-lien-titre', (l) => l.map((e) => e.textContent)), ['Modifier', 'Voir dans le Store']);

  // Au clavier : flèche droite → Comptes.
  await page.focus('#qv-tab-apercu');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qv-tab-comptes');
  assert.equal(await page.isVisible('#qv-panel-comptes'), true);
  assert.equal(await page.isVisible('#qv-panel-apercu'), false);
  const comptes = await page.$$eval('#qv-panel-comptes .mc-rang', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.equal(comptes.length, 2);
  assert.match(comptes.join(' | '), /••••0001/);
  assert.match(comptes.join(' | '), /••••0002/);
  assert.equal(await page.isVisible('#qv-panel-comptes .mc-ajout'), true);
  assert.equal(await texte(page, '#qv-panel-comptes .mc-ajout'), '+ Ajouter un compte Free Mobile');

  // Destinations.
  await page.click('#qv-tab-destinations');
  const dest = await texte(page, '#qv-panel-destinations');
  assert.match(dest, /Où crabe range les documents de ce service\./);
  assert.match(dest, /dans le dossier de crabe : titulaire\/Free Mobile/);
  assert.match(dest, /À jour · 5 document\(s\)/);
  assert.equal(await texte(page, '#qv-panel-destinations .btn-dossier'), 'Copier le chemin');

  // Aucun identifiant entier, dans le texte comme dans les attributs.
  const balisage = await page.$eval('#qv-dialog', (e) => e.outerHTML);
  assert.equal(balisage.includes(LIGNE_A), false);
  assert.equal(balisage.includes(LIGNE_B), false);
  // AUCUN suivi d'actions : ni onglet, ni ligne, ni message de récupération.
  const tout = await page.$eval('#qv-dialog', (e) => e.textContent);
  const trouve = /.{0,40}(Suivi d['’]actions|Suivi actions|Activité|Journal|nouveau\(x\) document|Aucune nouvelle facture).{0,40}/is.exec(tout.replace(/\s+/g, ' '));
  assert.equal(trouve, null, `suivi d'actions dans la modale : « ${trouve?.[0]} »`);
  assert.equal(await page.$$eval('#qv-dialog .err-item, #qv-dialog .sync-ligne', (l) => l.length), 0);

  // Le focus reste dans la modale.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => document.getElementById('qv-dialog').contains(document.activeElement)), true, `Tab n°${i + 1}`);
  }
  // Échap : fermée, le focus revient sur la vignette.
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#qv-overlay', (o) => o.classList.contains('show')), false);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('onclick')), 'openHomeConnector(\'free-mobile\')');

  // Le clic à côté la ferme aussi, et rend le focus.
  await ouvrirModale(page, 'free-mobile');
  await page.mouse.click(4, 4);
  assert.equal(await page.$eval('#qv-overlay', (o) => o.classList.contains('show')), false);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('onclick')), 'openHomeConnector(\'free-mobile\')');

  assert.deepEqual(erreursJs, []);
});

test('R3 — « Ajouter un compte » ouvre le formulaire du multi-compte existant : la fiche, sur sa liste de lignes', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  await ouvrirModale(page, 'free-mobile');
  await page.click('#qv-ajouter');
  await page.waitForSelector('#modal-overlay.show');
  assert.equal(await page.$eval('#qv-overlay', (o) => o.classList.contains('show')), false);
  assert.equal(await page.isVisible('#modal-fields [data-key="lignes"]'), true, 'la liste des lignes est dépliée et visible');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Relancer la découverte');
  assert.deepEqual(erreursJs, []);
});

test('R3 — un connecteur qui ne relie qu\'un identifiant : pas de bouton d\'ajout, la phrase dit pourquoi', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  await ouvrirModale(page, 'kubii');
  assert.equal(await page.locator('#qv-ajouter').count(), 0);
  await page.click('#qv-tab-comptes');
  assert.equal(await page.locator('#qv-panel-comptes .mc-ajout').count(), 0);
  const phrase = await texte(page, '#qv-panel-comptes');
  assert.match(phrase, /Un seul compte est relié à ce service\./);
  assert.match(phrase, /crabe relie un seul identifiant Kubii à votre compte : en saisir un autre remplacerait celui-ci\. Pour suivre un second compte Kubii, il faut aujourd'hui un autre compte crabe\./);
  assert.match(phrase, /c•••@•••\.fr/);
  assert.equal((await page.$eval('#qv-dialog', (e) => e.outerHTML)).includes('camille@exemple.fr'), false);
  assert.deepEqual(erreursJs, []);
});

test('R3 — la pause : « Mettre en pause » puis « Reprendre », par la route du lot 82 ; synchroniser n\'est plus offert en pause', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  const pause = () => helpers.db.get().prepare("SELECT disabled_at FROM connector_installs WHERE user_id = ? AND connector_id = 'kubii'").get(titulaire.id).disabled_at;

  await ouvrirModale(page, 'kubii');
  await page.click('#qv-pause');
  await page.waitForFunction(() => document.getElementById('qv-pause')?.innerText.trim() === 'Reprendre');
  assert.ok(pause(), 'disabled_at posé');
  assert.equal(await texte(page, '#qv-etat'), 'En pause · aucune récupération planifiée');
  assert.equal(await page.$eval('#qv-synchroniser', (b) => b.disabled), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qv-pause', 'le focus reste sur le geste');

  await page.click('#qv-pause');
  await page.waitForFunction(() => document.getElementById('qv-pause')?.innerText.trim() === 'Mettre en pause');
  assert.equal(pause(), null);
  assert.equal(await page.$eval('#qv-synchroniser', (b) => b.disabled), false);

  // « Synchroniser maintenant » passe par la route existante (la file).
  let appels = 0;
  await page.route('**/api/connectors/kubii/run', (route) => {
    appels += 1;
    route.fulfill({ json: { ok: true, count: 0, message: 'Aucune nouvelle facture — vous êtes à jour.' } });
  });
  await page.click('#qv-synchroniser');
  await page.waitForFunction(() => /Kubii — Aucune nouvelle facture/.test(document.getElementById('toast').textContent));
  assert.equal(appels, 1);
  assert.deepEqual(erreursJs, []);
});

test('R3 — une session expirée : la modale s\'ouvre (plus la fiche), le bandeau dit quoi faire et « Se reconnecter » ouvre la connexion existante', AVEC_NAVIGATEUR, async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire');
  t.after(fermer);
  await ouvrirModale(page, 'aagaard');
  assert.match(await texte(page, '#qv-etat'), /^Session expirée · dernière synchronisation/);
  const bandeau = await texte(page, '#qv-bandeau');
  assert.match(bandeau, /^Session expirée\. Votre session sur Aagaard a expiré : reconnectez-vous, la récupération repartira toute seule\. Se reconnecter$/);
  assert.equal(await page.$eval('#qv-synchroniser', (b) => b.disabled), true);
  await page.click('#qv-bandeau .mc-reconnecter');
  // Sans fenêtre de navigateur pour ce service : la fiche en saisie, comme avant.
  await page.waitForSelector('#modal-overlay.show');
  assert.equal(await page.evaluate(() => state.modalEdit), true);
  assert.deepEqual(erreursJs, []);
});

for (const clair of [false, true]) {
  test(`R6 — la modale sur téléphone (390 px), thème ${clair ? 'clair' : 'sombre'} : rien ne déborde, tout se lit`, AVEC_NAVIGATEUR, async (t) => {
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 390, hauteur: 844, clair });
    t.after(fermer);
    await ouvrirModale(page, 'aagaard');
    // Le point d'état reste sur la ligne de son texte (vu à la capture : il
    // tombait seul sur une ligne à 390 px).
    const ecart = await page.evaluate(() => Math.abs(document.getElementById('qv-point').getBoundingClientRect().top
      - document.getElementById('qv-etat').getBoundingClientRect().top));
    assert.ok(ecart < 10, `point et texte sur la même ligne (écart ${ecart.toFixed(1)} px)`);
    for (const onglet of ['apercu', 'comptes', 'destinations']) {
      await page.click(`#qv-tab-${onglet}`);
      const largeur = await page.$eval('#qv-dialog', (d) => ({ client: d.clientWidth, scroll: d.scrollWidth }));
      assert.ok(largeur.scroll <= largeur.client + 1, `${onglet} : ${largeur.scroll} > ${largeur.client}`);
      const d = await debordement(page);
      assert.ok(d.scroll <= d.largeur, `${onglet} : ${d.fautifs.join(' ; ')}`);
    }
    for (const sel of ['#qv-name', '#qv-etat', '#qv-bandeau .mc-bandeau-texte', '#qv-tab-apercu', '#qv-tab-comptes', '#qv-pause', '#qv-panel-destinations .mc-rang-sous']) {
      const { texte: t1, fond } = await couleursDe(page, sel);
      assert.ok(contraste(t1, fond) >= 4.5, `${sel} : ${contraste(t1, fond).toFixed(2)}`);
    }
    assert.deepEqual(erreursJs, []);
  });
}

test('R3 — « plusieursComptes » : déclaré par les trois services dont la liste porte des comptes, gardé par le registre chargé, validé', () => {
  const schema = require('../server/connectors/manifest-schema');
  // Lu sur le manifeste CHARGÉ (normalisé) : c'est lui que la route sert.
  assert.equal(registry.manifest('free-mobile').plusieursComptes, 'lignes');
  assert.equal(registry.manifest('infomaniak').plusieursComptes, 'organisations');
  assert.equal(registry.manifest('gandi').plusieursComptes, 'organisations');
  const porteurs = registry.listAll().filter((m) => m.plusieursComptes).map((m) => m.id).sort();
  assert.deepEqual(porteurs, ['free-mobile', 'gandi', 'infomaniak'], 'Ameli et Uber listent des catégories, pas des comptes');

  const base = {
    id: 'essai', name: 'Essai', category: 'divers', description: 'Récupère vos factures.',
    fields: [
      { key: 'email', identification: 'email', type: 'email', required: true },
      { key: 'lignes', label: 'Lignes à récupérer', type: 'multiselect', source: 'discover' },
      { key: 'note', label: 'Note', type: 'text', help: 'Une note libre, sans effet sur la récupération.' },
    ],
    permissions: [{ key: 'factures', scope: 'read', description: 'Lit vos factures pour les ranger.' }],
  };
  const erreurs = (m) => schema.validate(m, 'essai').errors.filter((e) => /plusieursComptes/.test(e));
  assert.deepEqual(erreurs({ ...base, plusieursComptes: 'lignes' }), []);
  assert.equal(erreurs({ ...base, plusieursComptes: 'absent' }).length, 1);
  assert.equal(erreurs({ ...base, plusieursComptes: 'note' }).length, 1);
  assert.equal(erreurs({ ...base, plusieursComptes: 3 }).length, 1);
});
