'use strict';

/**
 * Lot 93, R9 — le choix des organisations Gandi, dans la fiche.
 *
 * Demande de l'utilisateur : « les lister pour choisir, cocher tous ou au choix ». Le
 * socle savait déjà présenter une liste à cocher découverte après connexion
 * (`multiselect` + `discover()`, lot 5) ; il lui manquait un « tout cocher »,
 * la différence entre « toutes » et un choix précis, et le nom en évidence.
 * Le manifeste peut désormais déclarer `toutCocher` sur ce champ : seul
 * `gandi` le déclare dans ce lot.
 *
 * La preuve d'écran se fait au VRAI Chromium, sur une instance neuve (base en
 * mémoire, aucune donnée réelle) : ce qui est VISIBLE, ce qu'un lecteur
 * d'écran reçoit (l'arbre d'accessibilité), ce que font Tab et Espace, et ce
 * qui est GARDÉ après rechargement — relevé à l'écran et en base, jamais
 * supposé.
 *
 * ⚠ Valeurs inventées : « Organisation d'essai … », identifiants de zéros.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const faux = require('./lot93-faux-sites');

const RACINE = path.join(__dirname, '..', 'server', 'connectors');
const ORG = (n) => faux.idOrganisation(n);

/**
 * Le rendu de `multiselectBox` pour un champ SANS `toutCocher`, relevé sur le
 * code du lot 92 (web/app.js, sha256 717e7c7e…) AVANT toute modification de
 * ce lot. Un autre service doit le recevoir à l'octet près.
 */
const REFERENCE_LOT92 = {
  champ: { key: 'organisations', type: 'multiselect', source: 'discover', unit: 'organisation' },
  items: [
    { id: '000001', label: 'Organisation d\'essai A', badge: 'principale', detail: '3 facture(s)', preselected: true },
    { id: '000002', label: '000002', badge: 'secondaire', detail: '', preselected: false },
  ],
  sansChoix: "<div class=\"multi-box\" data-key=\"organisations\" data-field-type=\"multiselect\" data-ready=\"1\">\n    <label class=\"multi-item\">\n      <input type=\"checkbox\" value=\"000001\" checked>\n      <span class=\"multi-text\">\n        <span class=\"multi-head\">\n          <span class=\"multi-label\">000001</span>\n          <span class=\"badge-pill green\">principale</span>\n        </span>\n        <span class=\"multi-sub\">Organisation d&#39;essai A · 3 facture(s)</span>\n      </span>\n    </label><label class=\"multi-item\">\n      <input type=\"checkbox\" value=\"000002\">\n      <span class=\"multi-text\">\n        <span class=\"multi-head\">\n          <span class=\"multi-label\">000002</span>\n          <span class=\"badge-pill gray\">secondaire</span>\n        </span>\n        \n      </span>\n    </label>\n  </div>",
};

/**
 * Lot 97 : le même champ, rendu par le code du lot 97 — chaque élément par son
 * TITRE (servi par le serveur, `registry.titrerElements` : le nom, sinon
 * « Compte n »), chaque case par son RANG. Relevé sur le code du lot 97 ; une
 * liste sans `toutCocher` doit le reproduire à l'octet près.
 */
const REFERENCE_LOT97 = {
  champ: REFERENCE_LOT92.champ,
  items: registry.titrerElements(REFERENCE_LOT92.items),
  sansChoix: "<div class=\"multi-box\" data-key=\"organisations\" data-field-type=\"multiselect\" data-ready=\"1\">\n    <label class=\"multi-item\">\n      <input type=\"checkbox\" value=\"0\" checked>\n      <span class=\"multi-text\">\n        <span class=\"multi-head\">\n          <span class=\"multi-label\">Organisation d&#39;essai A</span>\n          <span class=\"badge-pill green\">principale</span>\n        </span>\n        <span class=\"multi-sub\">3 facture(s)</span>\n      </span>\n    </label><label class=\"multi-item\">\n      <input type=\"checkbox\" value=\"1\">\n      <span class=\"multi-text\">\n        <span class=\"multi-head\">\n          <span class=\"multi-label\">Compte 1</span>\n          <span class=\"badge-pill gray\">secondaire</span>\n        </span>\n        \n      </span>\n    </label>\n  </div>",
};

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT ? false : 'Playwright n\'est pas installé : la fiche n\'est pas éprouvée au vrai Chromium sur cette machine.',
};

// ---------------------------------------------------------------------------
// Le drapeau de manifeste
// ---------------------------------------------------------------------------

test('seul gandi déclare « toutCocher » dans ce lot', () => {
  const declarants = [];
  for (const dossier of ['available', 'planned']) {
    for (const id of fs.readdirSync(path.join(RACINE, dossier))) {
      const fichier = path.join(RACINE, dossier, id, 'manifest.json');
      if (!fs.existsSync(fichier)) continue;
      const m = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      if ((m.fields || []).some((f) => f.toutCocher !== undefined)) declarants.push(id);
    }
  }
  assert.deepEqual(declarants, ['gandi']);
});

test('les quatre autres listes à cocher ne reçoivent pas même une clé de plus', async () => {
  await helpers.setup();
  for (const id of ['free-mobile', 'infomaniak', 'ameli', 'uber']) {
    const vue = schema.publicView(registry.manifest(id));
    const champ = vue.fields.find((f) => f.type === 'multiselect');
    assert.ok(champ, `${id} a bien une liste à cocher`);
    assert.equal('toutCocher' in champ, false, `${id} : aucune clé toutCocher`);
  }
  const gandi = schema.publicView(registry.manifest('gandi')).fields.find((f) => f.key === 'organisations');
  assert.equal(gandi.toutCocher, true);
});

// ---------------------------------------------------------------------------
// D7 — au vrai Chromium, sur une instance neuve
// ---------------------------------------------------------------------------

test('D7 — la fiche de Gandi : organisations par nom, « Toutes mes organisations », clavier, lecteur d\'écran, choix gardé ; rien de neuf ailleurs', SANS_NAVIGATEUR, async (t) => {
  await helpers.setup();
  const user = await helpers.createUser({ username: 'lot93d7', plainPassword: 'MotDePasse1', role: 'admin' });
  registry.install(user.id, 'gandi');
  registry.saveConfig(user.id, 'gandi', { session: faux.sessionInventee() }, { origine: 'fenetre' });
  // Ce que la découverte aurait mémorisé : trois organisations, par le vrai
  // rapprochement (« toutes » : aucune sélection n'est écrite).
  registry.makeReconciler(user.id, 'gandi')('organisations', [
    { id: ORG(1), label: 'Organisation d\'essai A', detail: 'Votre organisation personnelle', preselected: true },
    { id: ORG(2), label: 'Organisation d\'essai B', detail: '', preselected: true },
    { id: ORG(3), label: 'Organisation d\'essai C', detail: '', preselected: true },
  ]);
  assert.equal(registry.readConfig(user.id, 'gandi').organisations, undefined);

  const client = await helpers.startServer();
  const reponse = await fetch(`${client.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lot93d7', password: 'MotDePasse1' }),
  });
  const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
  assert.ok(brut, 'cookie de session absent');
  const valeur = brut.split(';')[0].split('=').slice(1).join('=');

  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
    await contexte.addCookies([{ name: 'crabe.sid', value: valeur, domain: '127.0.0.1', path: '/' }]);
    const page = await contexte.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e)));
    const ouvrirLaFiche = async (options = {}) => {
      await page.goto(client.base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Array.isArray(state?.connectors) && state.connectors.some((c) => c.id === 'gandi'));
      await page.evaluate((o) => openModal('gandi', o), options);
      await page.locator('#modal-overlay.show').waitFor();
    };
    const boite = page.locator('#modal-fields .multi-box[data-tout-cocher="1"]');
    const maitre = boite.locator('input[data-tout="1"]');
    const cases = boite.locator('input[type="checkbox"]:not([data-tout])');

    // ── La fiche connectée : la liste est DANS la fiche, par nom ─────────────
    await ouvrirLaFiche();
    assert.ok(await boite.isVisible(), 'la liste se voit sans rien déplier');
    assert.equal(await page.locator('#adv-body .multi-box').count(), 0, 'elle n\'est pas sous « Options avancées »');
    const mots = (await boite.innerText()).replace(/\s+/g, ' ').trim();
    t.diagnostic(`mots relevés à l'écran : ${mots}`);
    assert.equal(mots, 'Toutes mes organisations y compris celles qui s\'ajouteront plus tard '
      + 'Organisation d\'essai A Votre organisation personnelle Organisation d\'essai B Organisation d\'essai C');
    assert.doesNotMatch(mots, /00000000|principale|secondaire/, 'ni identifiant ni pastille de rang');
    assert.equal(await maitre.isChecked(), true, '« toutes » : la case est cochée');
    assert.deepEqual(await cases.evaluateAll((l) => l.map((c) => c.checked)), [true, true, true]);
    assert.ok(await page.getByRole('button', { name: 'Enregistrer mon choix' }).isVisible());
    assert.ok(await page.getByRole('button', { name: 'Mettre à jour la liste' }).isVisible());

    // ── Ce qu'un lecteur d'écran reçoit ──────────────────────────────────────
    let arbre = await boite.ariaSnapshot();
    t.diagnostic(`arbre d'accessibilité : ${arbre.replace(/\n/g, ' ⏎ ')}`);
    assert.match(arbre, /checkbox "Toutes mes organisations y compris celles qui s'ajouteront plus tard" \[checked\]/);
    assert.match(arbre, /group "Organisations à récupérer"/);
    assert.match(arbre, /checkbox "Organisation d'essai A Votre organisation personnelle" \[checked\]/);
    assert.match(arbre, /checkbox "Organisation d'essai B" \[checked\]/);

    // ── Le clavier : Tab jusqu'à B, Espace la décoche — « toutes » passe à moitié
    await maitre.focus();
    await page.keyboard.press('Tab');
    // Lot 97 : une case porte son RANG, plus l'identifiant de l'organisation —
    // l'enregistrement, lui, garde les identifiants (vérifié plus bas en base).
    assert.equal(await page.evaluate(() => document.activeElement?.value), '0', 'Tab : la première organisation');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.value), '1');
    await page.keyboard.press('Space');
    assert.deepEqual(await cases.evaluateAll((l) => l.map((c) => c.checked)), [true, false, true]);
    assert.equal(await maitre.evaluate((c) => c.indeterminate), true, 'une partie seulement : à moitié');
    arbre = await boite.ariaSnapshot();
    assert.match(arbre, /checkbox "Toutes mes organisations[^"]*" \[checked=mixed\]/, 'annoncée « mixte »');

    // ── Enregistrer, recharger : le choix précis est gardé ──────────────────
    await page.getByRole('button', { name: 'Enregistrer mon choix' }).click();
    await page.locator('#modal-overlay.show').waitFor({ state: 'hidden' });
    assert.deepEqual(registry.readConfig(user.id, 'gandi').organisations, [ORG(1), ORG(3)], 'en base : un choix précis');
    assert.ok(registry.readConfig(user.id, 'gandi').session, 'la connexion n\'est pas touchée');
    await ouvrirLaFiche();
    assert.deepEqual(await cases.evaluateAll((l) => l.map((c) => c.checked)), [true, false, true], 'gardé après rechargement');
    assert.equal(await maitre.evaluate((c) => c.indeterminate), true);

    // ── « Toutes mes organisations » au clavier : tout se coche, « toutes » s'enregistre
    await maitre.focus();
    await page.keyboard.press('Space');
    assert.deepEqual(await cases.evaluateAll((l) => l.map((c) => c.checked)), [true, true, true]);
    assert.equal(await maitre.isChecked(), true);
    await page.keyboard.press('Space');
    assert.deepEqual(await cases.evaluateAll((l) => l.map((c) => c.checked)), [false, false, false], 'et tout se décoche');
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Enregistrer mon choix' }).click();
    await page.locator('#modal-overlay.show').waitFor({ state: 'hidden' });
    assert.equal(registry.readConfig(user.id, 'gandi').organisations, undefined, '« toutes » : plus aucun choix précis en base');
    await ouvrirLaFiche();
    assert.equal(await maitre.isChecked(), true, 'gardé après rechargement');

    // ── En saisie (« Modifier ») : la liste est là aussi ─────────────────────
    await page.evaluate(() => { closeModal(); openModal('gandi', { edit: true }); });
    assert.ok(await boite.isVisible(), 'en saisie aussi');

    // ── L'écran de choix qui suit la connexion, par la VRAIE route ───────────
    // `POST /connectors/gandi/discover` ouvre le navigateur du connecteur : il
    // est branché sur le faux Gandi (instance du registre, lancement réel
    // interdit hors de ce bloc — voir lot93-gandi.test.js).
    const etatGandi = faux.compteGandiDEssai();
    const banc = faux.lanceurFaux([faux.GANDI_ADMIN, faux.GANDI_ID], faux.siteGandi(etatGandi));
    const instance = registry.get('gandi').module;
    const lancementReel = instance.ouverture.lancer;
    const configuration = require('../server/config').config;
    const scrapingAvant = configuration.scrapingDisabled;
    instance.ouverture.lancer = banc.lancer;
    configuration.scrapingDisabled = false;
    try {
      await page.evaluate(() => runDiscovery('gandi', { progress: () => {}, failure: (m) => { window.__echecDecouverte = m; } }));
      await page.locator('.discovery-title').waitFor();
      assert.equal(await page.evaluate(() => window.__echecDecouverte || null), null);
      assert.ok(banc.lancements() >= 1, 'la découverte a ouvert le FAUX navigateur');
      assert.deepEqual(banc.journal.fuites, []);
      assert.deepEqual(banc.journal.clics, [], 'la découverte ne clique rien chez Gandi');
    } finally {
      instance.ouverture.lancer = lancementReel;
      configuration.scrapingDisabled = scrapingAvant;
      await banc.fermer();
    }
    assert.equal((await page.locator('.discovery-title').innerText()).trim(), 'Quelles organisations voulez-vous suivre ?');
    assert.ok(await boite.isVisible(), 'l\'écran de choix porte « Toutes mes organisations »');
    assert.equal(await maitre.isChecked(), true);
    assert.equal((await boite.innerText()).replace(/\s+/g, ' ').trim(),
      'Toutes mes organisations y compris celles qui s\'ajouteront plus tard '
      + 'Organisation d\'essai A Votre organisation personnelle Organisation d\'essai B Organisation d\'essai C');
    assert.deepEqual(await page.evaluate(() => readModalFields()), { organisations: 'toutes' });
    await cases.nth(2).click();
    assert.deepEqual(await page.evaluate(() => readModalFields()), { organisations: [ORG(1), ORG(2)] });

    // ── Rien de neuf ailleurs ────────────────────────────────────────────────
    const autres = await page.evaluate(() => state.connectors.filter((c) => c.id !== 'gandi' && !c.planned).map((c) => c.id));
    assert.ok(autres.length > 10, `des services à comparer (${autres.length})`);
    for (const id of autres) {
      await page.evaluate((i) => { closeModal(); openModal(i); }, id);
      assert.equal(await page.locator('[data-tout-cocher], .multi-all, input[data-tout]').count(), 0, `${id} : rien de neuf`);
      assert.equal(await page.locator('#modal-fields > .sheet-form .multi-box, #modal-fields .sheet-form .multi-box').count(), 0,
        `${id} : une liste à cocher reste sous « Options avancées »`);
    }
    const memeRendu = await page.evaluate((ref) => ({
      sansChoix: multiselectBox(ref.champ, ref.items, null),
    }), REFERENCE_LOT97);
    assert.equal(memeRendu.sansChoix, REFERENCE_LOT97.sansChoix, 'une liste sans toutCocher se rend à l\'octet près comme au lot 97');
    assert.equal(memeRendu.sansChoix.includes('000001') || memeRendu.sansChoix.includes('000002'), false,
      'aucun identifiant dans la liste (lot 97)');
    assert.deepEqual(erreurs, [], 'aucune erreur JavaScript');
    await contexte.close();
  } finally {
    await navigateur.close().catch(() => {});
    await client.close?.();
  }

  const journal = db.get().prepare('SELECT message FROM app_logs').all().map((l) => l.message).join('\n');
  assert.doesNotMatch(journal, /Organisation d'essai/, 'aucun nom d\'organisation au journal');
});

test.after(() => {
  helpers.teardown();
});
