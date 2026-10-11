'use strict';

/**
 * Lot 96 — le titre d'un dossier dans « Mes documents » (R8).
 *
 * ─── Ce qui a été vu, puis mesuré ────────────────────────────────────────────
 *
 * Le 06/10/2026, sous Gandi, chaque dossier s'affichait « Nom de
 * l'organisation · identifiant » — un UUID de 36 caractères. Mesuré le même
 * jour en production, par forme : trois services en « nom · identifiant »,
 * dix-neuf en identifiant seul (le numéro de sécurité sociale d'Ameli, le
 * numéro fiscal, onze adresses e-mail…), vingt et un en « defaut ».
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 *   1. le NOM seul quand il est connu ; deux dossiers du même nom se
 *      distinguent par la fin de l'identifiant (« Nom (…5678) ») ;
 *   2. sans nom : « Votre compte » pour un dossier seul, « Compte …5678 » à
 *      plusieurs, « Compte non identifié » pour le dossier de repli à côté
 *      d'autres ; un numéro quand la fin ne suffit pas ; JAMAIS l'identifiant
 *      entier ;
 *   3. l'ordre des dossiers est celui d'avant, à l'octet ; l'identifiant reste
 *      là où il sert (stockage, recherche, repli mémorisé) ;
 *   4. (D8) au VRAI Chromium : aucun identifiant d'essai nulle part dans la
 *      page — texte, infobulles, attributs —, en cartes comme en liste, et le
 *      repli marche toujours.
 *
 * Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const documents = require('../server/documents');
const tri = require('../server/connectors/tri');

// Des identifiants inventés, de la forme de ceux de la production.
const UUID_A = 'aaaaaaaa-1111-4222-8333-444444444441';
const UUID_B = 'bbbbbbbb-5555-4666-8777-888888888882';
const LIGNE_1 = '0600000001';
const LIGNE_2 = '0600000002';
const LIGNE_3 = '0611119999';
const NIR = '1990199123456';
const FBX_1 = 'fbx91111234';
const FBX_2 = 'fbx92225678';
const IDENTIFIANTS = [UUID_A, UUID_B, LIGNE_1, LIGNE_2, LIGNE_3, NIR, FBX_1, FBX_2];

const doc = (connectorId, connectorName, accountId, filename) =>
  ({ connectorId, connectorName, accountId, filename, period: '2026-09' });
const noms = new Map([
  ['gandi', new Map([[UUID_A, 'Organisation Essai A'], [UUID_B, 'Organisation Essai B']])],
  ['free-mobile', new Map([[LIGNE_1, 'Camille Essai'], [LIGNE_2, 'Camille Essai'], [LIGNE_3, 'Dominique Essai']])],
]);
const titresDe = (arbre, connectorId) =>
  arbre.find((b) => b.connectorId === connectorId).accounts.map((c) => c.label);

// ---------------------------------------------------------------------------
// Les règles
// ---------------------------------------------------------------------------

test('R8 — un nom connu : le nom seul (Gandi)', () => {
  const arbre = documents.toTree([
    doc('gandi', 'Gandi', UUID_B, 'b.pdf'),
    doc('gandi', 'Gandi', UUID_A, 'a.pdf'),
  ], noms);
  assert.deepEqual(titresDe(arbre, 'gandi'), ['Organisation Essai A', 'Organisation Essai B']);
  // L'identifiant reste dans l'arbre : il nomme le dossier sur le stockage et
  // sert le repli mémorisé — il n'est plus dans le titre.
  assert.deepEqual(arbre[0].accounts.map((c) => c.accountId), [UUID_A, UUID_B]);
  assert.deepEqual(arbre[0].accounts.map((c) => c.accountName), ['Organisation Essai A', 'Organisation Essai B']);
});

test('R8 — deux dossiers du même nom : le nom et la fin de l\'identifiant, jamais l\'identifiant entier', () => {
  const arbre = documents.toTree([
    doc('free-mobile', 'Free Mobile', LIGNE_3, 'c.pdf'),
    doc('free-mobile', 'Free Mobile', LIGNE_2, 'b.pdf'),
    doc('free-mobile', 'Free Mobile', LIGNE_1, 'a.pdf'),
  ], noms);
  assert.deepEqual(titresDe(arbre, 'free-mobile'),
    ['Camille Essai (…0001)', 'Camille Essai (…0002)', 'Dominique Essai']);
});

test('R8 — sans nom : « Votre compte » seul (le numéro d\'Ameli n\'est plus affiché), « Compte …XXXX » à plusieurs', () => {
  const arbre = documents.toTree([
    doc('ameli', 'Ameli', NIR, 'attestation.pdf'),
    doc('free', 'Free Internet', FBX_2, 'b.pdf'),
    doc('free', 'Free Internet', FBX_1, 'a.pdf'),
  ], new Map());
  assert.deepEqual(titresDe(arbre, 'ameli'), ['Votre compte']);
  assert.deepEqual(titresDe(arbre, 'free'), ['Compte …1234', 'Compte …5678']);
  assert.equal(JSON.stringify(arbre.map((b) => b.accounts.map((c) => c.label))).includes(NIR), false);
});

test('R8 — quand la fin ne distingue pas, ou que l\'identifiant est court : un numéro', () => {
  // Deux adresses du même domaine : mêmes quatre derniers caractères.
  const memeFin = documents.toTree([
    doc('kubii', 'Kubii', 'alice@exemple.fr', 'a.pdf'),
    doc('kubii', 'Kubii', 'bruno@exemple.fr', 'b.pdf'),
  ], new Map());
  assert.deepEqual(titresDe(memeFin, 'kubii'), ['Compte 1', 'Compte 2']);
  // Des identifiants trop courts pour qu'une fin n'en dise pas l'essentiel.
  const courts = documents.toTree([
    doc('ile', 'L\'Île', 'z', 'z.pdf'),
    doc('ile', 'L\'Île', 'a', 'a.pdf'),
  ], new Map());
  assert.deepEqual(titresDe(courts, 'ile'), ['Compte 1', 'Compte 2']);
  assert.deepEqual(courts[0].accounts.map((c) => c.accountId), ['a', 'z'], 'numérotés dans l\'ordre du service');
  // Même nom, identifiants courts : le nom et un numéro.
  const titres = documents.titresDesDossiers([{ cle: '854637', nom: 'Koody' }, { cle: '880049', nom: 'Koody' }]);
  assert.deepEqual([...titres.values()], ['Koody (compte 1)', 'Koody (compte 2)']);
});

test('R8 — « defaut » et vide : « Votre compte » seul, « Compte non identifié » à côté d\'autres', () => {
  const seul = documents.toTree([doc('amazon', 'Amazon', 'defaut', 'a.pdf')], new Map());
  assert.deepEqual(titresDe(seul, 'amazon'), ['Votre compte'], 'jamais « defaut »');
  const vide = documents.toTree([doc('mistral', 'Mistral', '', 'a.pdf')], new Map());
  assert.deepEqual(titresDe(vide, 'mistral'), ['Votre compte']);
  const avecAutres = documents.toTree([
    doc('free-mobile', 'Free Mobile', LIGNE_3, 'c.pdf'),
    doc('free-mobile', 'Free Mobile', 'defaut', 'd.pdf'),
  ], noms);
  assert.deepEqual(titresDe(avecAutres, 'free-mobile'), ['Compte non identifié', 'Dominique Essai']);
});

test('R8 — l\'ordre des dossiers d\'un service est celui d\'avant le lot, à l\'octet', () => {
  const docs = [
    doc('free-mobile', 'Free Mobile', LIGNE_3, 'c.pdf'),
    doc('free-mobile', 'Free Mobile', 'defaut', 'd.pdf'),
    doc('free-mobile', 'Free Mobile', LIGNE_2, 'b.pdf'),
    doc('free-mobile', 'Free Mobile', '0699990000', 'e.pdf'),
    doc('free-mobile', 'Free Mobile', LIGNE_1, 'a.pdf'),
    doc('gandi', 'Gandi', UUID_B, 'g2.pdf'),
    doc('gandi', 'Gandi', UUID_A, 'g1.pdf'),
  ];
  // L'ordre d'avant : l'ancien libellé (« nom · identifiant », ou l'identifiant), trié par tri.parNom.
  const ancien = (connectorId) => {
    const cles = [...new Set(docs.filter((d) => d.connectorId === connectorId).map((d) => d.accountId))];
    const libelle = (cle) => {
      const nom = noms.get(connectorId)?.get(cle);
      return nom ? `${nom} · ${cle}` : cle || 'Votre compte';
    };
    return tri.parNom(cles, libelle);
  };
  const arbre = documents.toTree(docs, noms);
  for (const branche of arbre) {
    assert.deepEqual(branche.accounts.map((c) => c.accountId), ancien(branche.connectorId), branche.connectorId);
  }
});

test('R8 — l\'identifiant sert toujours la recherche (sans s\'afficher)', () => {
  const docs = [
    { ...doc('free', 'Free Internet', FBX_1, 'a.pdf'), reference: 'a' },
    { ...doc('free', 'Free Internet', FBX_2, 'b.pdf'), reference: 'b' },
  ];
  assert.deepEqual(documents.applyFilters(docs, { q: '1234' }).map((d) => d.filename), ['a.pdf']);
});

// ---------------------------------------------------------------------------
// D8 — au vrai Chromium
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();

test('D8 — au vrai Chromium : les titres, aucun identifiant dans la page, et le repli marche',
  { skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.', timeout: 120_000 },
  async (t) => {
    const destinations = require('../server/destinations');
    const discovery = require('../server/connectors/discovery');
    const registry = require('../server/connectors/registry');
    const preferences = require('../server/preferences');

    await helpers.setup();
    t.after(() => helpers.teardown());
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot96-docs-'));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    destinations.saveConfig('local', { path: racine, protocol: 'local' });

    const user = await helpers.createUser({ username: 'lot96docs', plainPassword: 'MotDePasse1' });
    const poser = (connectorId, accountId, filename) => {
      helpers.db.get().prepare(
        `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                               size_bytes, issued_on, fetched_at, destinations)
         VALUES (?, ?, ?, NULL, ?, 2048, '2026-09-01', '2026-09-10 08:00:00', ?)`
      ).run(user.id, connectorId, filename, accountId,
        JSON.stringify({ local: { state: 'ok', ok: true, at: '2026-09-10T08:00:00.000Z' } }));
      const dossier = path.join(racine, user.username, registry.manifest(connectorId).name, accountId);
      fs.mkdirSync(dossier, { recursive: true });
      fs.writeFileSync(path.join(dossier, filename), '%PDF-1.4 essai');
    };
    poser('gandi', UUID_A, 'gandi_2026-09_essai-1.pdf');
    poser('gandi', UUID_B, 'gandi_2026-09_essai-2.pdf');
    poser('free-mobile', LIGNE_1, 'free-mobile_2026-09_essai-1.pdf');
    poser('free-mobile', LIGNE_2, 'free-mobile_2026-09_essai-2.pdf');
    poser('free-mobile', LIGNE_3, 'free-mobile_2026-09_essai-3.pdf');
    poser('ameli', NIR, 'ameli_2026-09_attestation-essai.pdf');
    poser('amazon', 'defaut', 'amazon_2026-09_essai.pdf');
    poser('free', FBX_1, 'free_2026-09_essai-1.pdf');
    poser('free', FBX_2, 'free_2026-09_essai-2.pdf');
    // Les noms relevés par la découverte, comme en production.
    discovery.save(user.id, 'gandi', registry.discoveryField('gandi').key, [
      { id: UUID_A, label: 'Organisation Essai A' },
      { id: UUID_B, label: 'Organisation Essai B' },
    ]);
    discovery.save(user.id, 'free-mobile', registry.discoveryField('free-mobile').key, [
      { id: LIGNE_1, label: 'Camille Essai' },
      { id: LIGNE_2, label: 'Camille Essai' },
      { id: LIGNE_3, label: 'Dominique Essai' },
    ]);

    const client = await helpers.startServer();
    t.after(() => client.close());
    const reponse = await fetch(`${client.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lot96docs', password: 'MotDePasse1' }),
    });
    const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
    assert.ok(brut, 'cookie de session absent');

    const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
    t.after(() => navigateur.close());
    const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
    await contexte.addCookies([{
      name: 'crabe.sid', value: brut.split(';')[0].split('=').slice(1).join('='), domain: '127.0.0.1', path: '/',
    }]);
    const page = await contexte.newPage();
    const erreursJs = [];
    page.on('pageerror', (e) => erreursJs.push(String(e)));

    const aucunIdentifiant = async (vue) => {
      const html = await page.content();
      for (const id of IDENTIFIANTS) {
        assert.equal(html.includes(id), false, `${vue} : l'identifiant « ${id} » est dans la page`);
      }
    };

    // ── Vue en cartes (le défaut) : une carte par service, ses dossiers ──────
    await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
    await page.click('#tb-documents');
    await page.waitForSelector('.docs-conn-card');
    const cartes = await page.$$eval('.docs-conn-card', (els) => els.map((e) => ({
      service: e.querySelector('.docs-conn-card-name').textContent.trim(),
      dossiers: [...e.querySelectorAll('.docs-conn-account-name')].map((n) => [n.textContent.trim(), n.getAttribute('title')]),
    })));
    const dossiersDe = (service) => cartes.find((c) => c.service === service).dossiers;
    assert.deepEqual(dossiersDe('Gandi'), [
      ['Organisation Essai A', 'Organisation Essai A'],
      ['Organisation Essai B', 'Organisation Essai B'],
    ], 'le nom seul, en texte comme en infobulle');
    assert.deepEqual(dossiersDe('Free Mobile').map(([texte]) => texte),
      ['Camille Essai (…0001)', 'Camille Essai (…0002)', 'Dominique Essai']);
    assert.deepEqual(dossiersDe('Ameli'), [['Votre compte', 'Votre compte']]);
    assert.deepEqual(dossiersDe('Amazon'), [['Votre compte', 'Votre compte']]);
    assert.deepEqual(dossiersDe('Free Internet').map(([texte]) => texte), ['Compte …1234', 'Compte …5678']);
    await aucunIdentifiant('cartes');

    // ── Vue en liste : les têtes de compte, et le repli ──────────────────────
    await page.click('#view-documents-list');
    await page.waitForSelector('.docs-account-head');
    const tetes = await page.$$eval('.docs-account-head', (els) => els.map((e) => ({
      titre: e.querySelector('.docs-account-name').textContent.trim(),
      infobulle: e.getAttribute('title'),
      geste: e.getAttribute('onclick'),
    })));
    // Les services par leur nom, puis leurs dossiers dans l'ordre d'avant.
    assert.deepEqual(tetes.map((x) => x.titre), [
      'Votre compte', // Amazon
      'Votre compte', // Ameli
      'Compte …1234', 'Compte …5678', // Free Internet
      'Camille Essai (…0001)', 'Camille Essai (…0002)', 'Dominique Essai', // Free Mobile
      'Organisation Essai A', 'Organisation Essai B', // Gandi
    ]);
    for (const tete of tetes) {
      assert.match(tete.geste, /^toggleDocsAccountAuRang\(\d+\)$/, 'le geste porte un rang, pas l\'identifiant');
      assert.equal(tete.infobulle, `Replier ${tete.titre}`);
    }
    await aucunIdentifiant('liste');

    // Le repli : un clic sur la tête de la ligne « …0002 » la replie, et la
    // préférence mémorisée garde la clé d'avant ce lot (service/identifiant).
    const rang = tetes.findIndex((x) => x.titre === 'Camille Essai (…0002)');
    assert.ok(rang >= 0);
    await page.locator('.docs-account-head').nth(rang).click();
    await page.waitForFunction((r) =>
      document.querySelectorAll('.docs-account-head')[r]?.getAttribute('aria-expanded') === 'false', rang);
    for (let i = 0; i < 50 && !(preferences.get(user.id, 'documents.collapsed') || []).length; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(preferences.get(user.id, 'documents.collapsed'), [`free-mobile/${LIGNE_2}`]);
    await aucunIdentifiant('liste, après repli');
    // Et il se rouvre.
    await page.locator('.docs-account-head').nth(rang).click();
    await page.waitForFunction((r) =>
      document.querySelectorAll('.docs-account-head')[r]?.getAttribute('aria-expanded') === 'true', rang);

    // Ce qui n'a pas bougé : l'identifiant en base, et le chemin sur le stockage.
    assert.equal(helpers.db.get()
      .prepare("SELECT account_id FROM invoices WHERE filename = 'ameli_2026-09_attestation-essai.pdf'").get().account_id, NIR);
    assert.ok(fs.existsSync(path.join(racine, 'lot96docs', 'Ameli', NIR, 'ameli_2026-09_attestation-essai.pdf')));
    assert.deepEqual(erreursJs, [], 'aucune erreur JavaScript dans la page');
  });
