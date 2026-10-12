'use strict';

/**
 * Lot 97 — R1 : plus d'identifiant de compte affiché, ni sur la carte d'un
 * service, ni dans sa fiche.
 *
 * ─── Ce qui a été vu, puis mesuré ────────────────────────────────────────────
 *
 * Remarque a du lot 96 : la carte d'un service (Profil → Connecteurs
 * installés) disait « Compte : nom · identifiant », ou l'identifiant seul.
 * Mesuré le 06/10/2026 en production, par forme : 23 cartes sur 45 — onze
 * adresses e-mail, deux numéros de 13 chiffres (sécurité sociale, numéro
 * fiscal), un numéro de téléphone, des UUID d'organisation. Et la fiche
 * montrait en évidence l'identifiant de chaque élément découvert (le numéro
 * d'une ligne, celui d'une organisation), qu'elle portait aussi dans la valeur
 * de chaque case (l'UUID d'une organisation Gandi).
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 *   1. le serveur donne à chaque compte et à chaque élément découvert son
 *      TITRE, par la règle de « Mes documents » (lot 96) — le même titre sur
 *      les deux écrans ; un « nom » qui contient l'identifiant n'en est pas un ;
 *   2. (D1) au VRAI Chromium : aucun identifiant d'essai nulle part dans la
 *      page — la carte, la liste, la fiche, l'écran de choix —, et les titres
 *      sont ceux de « Mes documents » ;
 *   3. l'enregistrement d'une sélection garde les IDENTIFIANTS, à l'octet :
 *      seule la case a changé (elle porte un rang) ;
 *   4. rien ne change en base ni sur le stockage.
 *
 * Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const faux = require('./lot93-faux-sites');
const documents = require('../server/documents');
const registry = require('../server/connectors/registry');

// Des identifiants inventés, de la forme de ceux de la production.
const NIR = '1990199123456';
const FISCAL = '3010000000042';
const COURRIEL = 'camille.essai@exemple.fr';
const UUID_A = 'aaaaaaaa-1111-4222-8333-444444444441';
const UUID_A2 = 'cccccccc-9999-4aaa-8bbb-cccccccc0003';
const UUID_B = 'bbbbbbbb-5555-4666-8777-888888888882';
const LIGNE_1 = '0600000001';
const LIGNE_2 = '0600000002';
const LIGNE_3 = '0611119999';
const STATIONNEMENT = '0600000009';
const ORGA_NOMMEE = '9123456';
const ORGA_SANS_NOM = '9876543';
const FBX = 'fbx91111234';
const IDENTIFIANTS = [NIR, FISCAL, COURRIEL, UUID_A, UUID_A2, UUID_B, LIGNE_1, LIGNE_2, LIGNE_3,
  STATIONNEMENT, ORGA_NOMMEE, ORGA_SANS_NOM, FBX];

// ---------------------------------------------------------------------------
// La règle, côté serveur
// ---------------------------------------------------------------------------

test('R1 — un « nom » qui contient l\'identifiant entier n\'en est pas un (« Organisation 9876543 »)', () => {
  const seul = documents.titresDesDossiers([{ cle: ORGA_SANS_NOM, nom: `Organisation ${ORGA_SANS_NOM}` }]);
  assert.equal(seul.get(ORGA_SANS_NOM), 'Votre compte');
  const deux = documents.titresDesDossiers([
    { cle: ORGA_NOMMEE, nom: 'Société Essai' },
    { cle: ORGA_SANS_NOM, nom: `Organisation ${ORGA_SANS_NOM}` },
  ]);
  assert.deepEqual([...deux.values()], ['Société Essai', 'Compte 1']);
  // Un identifiant de moins de quatre caractères ne dit rien de personnel : le nom reste.
  assert.equal(documents.titresDesDossiers([{ cle: '12', nom: 'Atelier 12' }]).get('12'), 'Atelier 12');
});

test('R1 — titresDesComptes range comme « Mes documents » : un compte porte le même titre sur les deux écrans', () => {
  const comptes = [
    { cle: LIGNE_3, nom: 'Dominique Essai' },
    { cle: LIGNE_2, nom: 'Camille Essai' },
    { cle: LIGNE_1, nom: 'Camille Essai' },
  ];
  const titres = documents.titresDesComptes(comptes);
  const arbre = documents.toTree(comptes.map((c) => ({
    connectorId: 'free-mobile', connectorName: 'Free Mobile', accountId: c.cle, filename: `${c.cle}.pdf`,
  })), new Map([['free-mobile', new Map(comptes.map((c) => [c.cle, c.nom]))]]));
  for (const dossier of arbre[0].accounts) {
    assert.equal(titres.get(dossier.accountId), dossier.label, `${dossier.label} : même titre sur les deux écrans`);
  }
  assert.deepEqual([LIGNE_1, LIGNE_2, LIGNE_3].map((c) => titres.get(c)),
    ['Camille Essai (…0001)', 'Camille Essai (…0002)', 'Dominique Essai']);
});

test('R1 — titrerElements : le titre de chaque élément découvert, l\'identifiant gardé dans l\'objet', () => {
  const items = registry.titrerElements([
    { id: UUID_A, label: 'Organisation Essai A', detail: 'Votre organisation personnelle' },
    { id: UUID_A2, label: 'Organisation Essai A', detail: '' },
    { id: UUID_B, label: UUID_B, detail: '' },
  ]);
  assert.deepEqual(items.map((i) => i.titre), ['Organisation Essai A (…4441)', 'Organisation Essai A (…0003)', 'Compte …8882']);
  assert.deepEqual(items.map((i) => i.id), [UUID_A, UUID_A2, UUID_B], 'l\'identifiant reste, pour enregistrer la sélection');
  assert.deepEqual(registry.titrerElements(undefined), []);
});

// ---------------------------------------------------------------------------
// D1 — au vrai Chromium
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();

test('D1 — au vrai Chromium : la carte, la liste, la fiche et l\'écran de choix sans aucun identifiant ; la sélection garde les identifiants',
  { skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.', timeout: 180_000 },
  async (t) => {
    const destinations = require('../server/destinations');
    const discovery = require('../server/connectors/discovery');

    await helpers.setup();
    t.after(() => helpers.teardown());
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot97-r1-'));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    destinations.saveConfig('local', { path: racine, protocol: 'local' });

    const user = await helpers.createUser({ username: 'lot97r1', plainPassword: 'MotDePasse1', role: 'admin' });
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
    for (const id of ['ameli', 'impots', 'kubii', 'gandi', 'free-mobile', 'infomaniak', 'paybyphone', 'free']) {
      registry.install(user.id, id);
    }
    // Une connexion inventée pour les trois services à découverte : sans
    // configuration enregistrée, une fiche n'a pas de liste à montrer.
    for (const id of ['gandi', 'free-mobile', 'infomaniak']) {
      registry.saveConfig(user.id, id, { session: faux.sessionInventee() }, { origine: 'fenetre' });
    }
    poser('ameli', NIR, 'ameli_2026-09_attestation-essai.pdf');
    poser('impots', FISCAL, 'impots_2026_avis-essai.pdf');
    poser('kubii', COURRIEL, 'kubii_2026-09_essai.pdf');
    poser('gandi', UUID_A, 'gandi_2026-09_essai-1.pdf');
    poser('gandi', UUID_A2, 'gandi_2026-09_essai-2.pdf');
    poser('gandi', UUID_B, 'gandi_2026-09_essai-3.pdf');
    poser('free-mobile', LIGNE_1, 'free-mobile_2026-09_essai-1.pdf');
    poser('free-mobile', LIGNE_2, 'free-mobile_2026-09_essai-2.pdf');
    poser('free-mobile', LIGNE_3, 'free-mobile_2026-09_essai-3.pdf');
    poser('infomaniak', ORGA_NOMMEE, 'infomaniak_2026-09_essai-1.pdf');
    poser('infomaniak', ORGA_SANS_NOM, 'infomaniak_2026-09_essai-2.pdf');
    poser('free', FBX, 'free_2026-09_essai.pdf');
    // Un compte enregistré à l'installation, sans aucun document encore rangé.
    helpers.db.get().prepare("UPDATE connector_installs SET account_id = ? WHERE user_id = ? AND connector_id = 'paybyphone'")
      .run(STATIONNEMENT, user.id);
    // Ce que les découvertes auraient relevé, comme en production.
    discovery.save(user.id, 'gandi', registry.discoveryField('gandi').key, [
      { id: UUID_A, label: 'Organisation Essai A', detail: 'Votre organisation personnelle', preselected: true },
      { id: UUID_A2, label: 'Organisation Essai A', detail: '', preselected: true },
      { id: UUID_B, label: 'Organisation Essai B', detail: '', preselected: true },
    ]);
    discovery.save(user.id, 'free-mobile', registry.discoveryField('free-mobile').key, [
      { id: LIGNE_1, label: 'Camille Essai', detail: '12 factures', preselected: true },
      { id: LIGNE_2, label: 'Camille Essai', detail: '12 factures', preselected: false },
      { id: LIGNE_3, label: 'Dominique Essai', detail: '3 factures', preselected: false },
    ]);
    discovery.save(user.id, 'infomaniak', registry.discoveryField('infomaniak').key, [
      { id: ORGA_NOMMEE, label: 'Société Essai', detail: '7 facture(s)', preselected: true },
      { id: ORGA_SANS_NOM, label: `Organisation ${ORGA_SANS_NOM}`, detail: '2 facture(s)', preselected: true },
    ]);

    // ── Le serveur : des titres, et l'identifiant seulement là où il sert ────
    const vue = new Map(registry.listForUser(user).map((c) => [c.id, c]));
    assert.deepEqual(vue.get('ameli').accounts.map((a) => a.titre), ['Votre compte']);
    assert.deepEqual(vue.get('kubii').accounts.map((a) => a.titre), ['Votre compte']);
    assert.equal(vue.get('paybyphone').accountTitre, 'Votre compte', 'le compte enregistré, sans document');
    assert.equal(vue.get('ameli').accountTitre, null, 'un service qui a des documents n\'en a pas besoin');
    assert.deepEqual(vue.get('free').accounts.map((a) => a.titre), ['Votre compte']);

    const client = await helpers.startServer();
    t.after(() => client.close());
    const reponse = await fetch(`${client.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lot97r1', password: 'MotDePasse1' }),
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

    const aucunIdentifiant = async (vueTestee) => {
      const html = await page.content();
      for (const id of IDENTIFIANTS) {
        assert.equal(html.includes(id), false, `${vueTestee} : l'identifiant « ${id} » est dans la page`);
      }
    };

    // ── Profil → Connecteurs installés, en cartes ────────────────────────────
    await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { showView('profil'); showProfilPage('connecteurs', document.querySelector('[data-ppage=connecteurs]')); });
    await page.waitForSelector('#profil-conn-list .app-card');
    const cartes = await page.$$eval('#profil-conn-list .app-card', (els) => els.map((e) => {
      const fait = [...e.querySelectorAll('.app-card-facts > div')]
        .find((d) => /^Comptes?$/.test(d.querySelector('.fact-label')?.textContent.trim() || ''));
      return {
        service: e.querySelector('.app-card-name').textContent.trim(),
        etiquette: fait?.querySelector('.fact-label').textContent.trim(),
        texte: fait?.querySelector('.fact-value').textContent.trim(),
        infobulle: fait?.querySelector('.fact-value').getAttribute('title'),
      };
    }));
    const carte = (service) => cartes.find((c) => c.service === service);
    t.diagnostic(`cartes : ${JSON.stringify(cartes.map((c) => [c.service, c.texte]))}`);
    assert.deepEqual(carte('Ameli'), { service: 'Ameli', etiquette: 'Compte', texte: 'Votre compte', infobulle: 'Votre compte' },
      'le numéro de sécurité sociale n\'est plus affiché');
    assert.equal(carte('Impots.gouv.fr').texte, 'Votre compte');
    assert.equal(carte('Kubii').texte, 'Votre compte', 'l\'adresse e-mail n\'est plus affichée');
    assert.equal(carte('PayByPhone').texte, 'Votre compte', 'le numéro de téléphone enregistré non plus');
    assert.equal(carte('Free Internet').texte, 'Votre compte');
    // Plusieurs comptes : les titres de « Mes documents », deux sur la carte, tous dans
    // l'infobulle. L'ORDRE de la carte n'a pas changé (le plus fourni d'abord, puis
    // l'ordre de la base à égalité) : comparé ici sans lui.
    const tries = (texte) => texte.split(', ').sort();
    assert.equal(carte('Free Mobile').etiquette, 'Comptes');
    assert.deepEqual(tries(carte('Free Mobile').infobulle), ['Camille Essai (…0001)', 'Camille Essai (…0002)', 'Dominique Essai']);
    assert.match(carte('Free Mobile').texte, /^[^,]+, [^,]+ \+1$/, 'deux comptes sur la carte, puis « +1 »');
    assert.deepEqual(tries(carte('Gandi').infobulle), ['Organisation Essai A (…0003)', 'Organisation Essai A (…4441)', 'Organisation Essai B']);
    assert.deepEqual(tries(carte('Infomaniak').infobulle), ['Compte 1', 'Société Essai'], 'un nom qui contient l\'identifiant n\'est pas un nom');
    await aucunIdentifiant('cartes');

    // ── En liste ─────────────────────────────────────────────────────────────
    await page.evaluate(() => setProfilConnView('list'));
    await page.waitForSelector('#profil-conn-list .installed-row');
    await aucunIdentifiant('liste');

    // ── Les fiches, connectée et en saisie, options avancées comprises ───────
    for (const [id, options] of [
      ['gandi', {}], ['gandi', { edit: true }], ['free-mobile', { edit: true }], ['free-mobile', {}],
      ['infomaniak', { edit: true }], ['ameli', {}], ['impots', {}], ['kubii', {}], ['paybyphone', {}], ['free', {}],
    ]) {
      await page.evaluate(([i, o]) => { closeModal(); openModal(i, o); }, [id, options]);
      await page.locator('#modal-overlay.show').waitFor();
      await aucunIdentifiant(`fiche ${id}${options.edit ? ' (saisie)' : ''}`);
    }

    // La liste de Gandi (« tout cocher ») : les titres, et des cases par rang.
    await page.evaluate(() => { closeModal(); openModal('gandi'); });
    const gandi = await page.$$eval('#modal-fields .multi-box[data-tout-cocher="1"] label.multi-item:not(.multi-all)', (els) => els.map((e) => ({
      titre: e.querySelector('.multi-label').textContent.trim(),
      valeur: e.querySelector('input').value,
      sous: e.querySelector('.multi-sub')?.textContent.trim() || '',
    })));
    assert.deepEqual(gandi, [
      { titre: 'Organisation Essai A (…4441)', valeur: '0', sous: 'Votre organisation personnelle' },
      { titre: 'Organisation Essai A (…0003)', valeur: '1', sous: '' },
      { titre: 'Organisation Essai B', valeur: '2', sous: '' },
    ], 'deux organisations du même nom se distinguent par la fin de l\'identifiant, jamais par l\'identifiant');

    // La liste de Free Mobile (sous « Options avancées ») : titres, pastilles, détail.
    await page.evaluate(() => { closeModal(); openModal('free-mobile', { edit: true }); });
    const lignes = await page.$$eval('#modal-fields .multi-box[data-key="lignes"] label.multi-item', (els) => els.map((e) => ({
      titre: e.querySelector('.multi-label').textContent.trim(),
      valeur: e.querySelector('input').value,
      sous: e.querySelector('.multi-sub')?.textContent.trim() || '',
    })));
    assert.deepEqual(lignes, [
      { titre: 'Camille Essai (…0001)', valeur: '0', sous: '12 factures' },
      { titre: 'Camille Essai (…0002)', valeur: '1', sous: '12 factures' },
      { titre: 'Dominique Essai', valeur: '2', sous: '3 factures' },
    ]);

    // ── L'enregistrement garde les IDENTIFIANTS ───────────────────────────────
    await page.evaluate(() => toggleAdvanced());
    await page.locator('#modal-fields .multi-box[data-key="lignes"] input[value="2"]').check();
    assert.deepEqual(await page.evaluate(() => readModalFields().lignes), [LIGNE_1, LIGNE_3],
      'readModalFields retraduit les rangs en identifiants');
    await page.evaluate(() => saveConnectorOnly());
    for (let i = 0; i < 50 && !Array.isArray(registry.readConfig(user.id, 'free-mobile').lignes); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(registry.readConfig(user.id, 'free-mobile').lignes, [LIGNE_1, LIGNE_3], 'en base : les identifiants, à l\'octet');

    // ── L'écran de choix qui suit une connexion, avec les éléments servis ────
    await page.evaluate(() => {
      closeModal();
      openModal('infomaniak', { edit: true });
      const c = state.connectors.find((x) => x.id === 'infomaniak');
      const champ = c.fields.find((f) => f.type === 'multiselect');
      renderDiscovery({ field: champ, items: c.configSummary.discoveries[champ.key].items, selection: null });
    });
    await page.waitForSelector('.discovery-title');
    const choix = await page.$$eval('#modal-fields .multi-box label.multi-item .multi-label', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(choix, ['Société Essai', 'Compte 1']);
    await aucunIdentifiant('écran de choix');

    // ── Rien n'a bougé en base ni sur le stockage ───────────────────────────
    assert.equal(helpers.db.get()
      .prepare("SELECT account_id FROM invoices WHERE filename = 'ameli_2026-09_attestation-essai.pdf'").get().account_id, NIR);
    assert.ok(fs.existsSync(path.join(racine, 'lot97r1', 'Ameli', NIR, 'ameli_2026-09_attestation-essai.pdf')));
    assert.deepEqual(erreursJs, [], 'aucune erreur JavaScript dans la page');
  });
