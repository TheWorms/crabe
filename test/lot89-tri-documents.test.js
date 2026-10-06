'use strict';

/**
 * Lot 89 — trier les documents récupérés.
 *
 * ─── Ce que ce fichier protège ───────────────────────────────────────────────
 *
 * 1. **Chaque critère fonctionne, dans les deux sens**, sur la donnée brute :
 *    accents et casse ignorés, `2` avant `10`, une taille comparée en octets.
 * 2. **Les documents sans date vont à la fin**, dans les deux sens, et les
 *    ex æquo sont départagés par un critère fixe (le nom de fichier).
 * 3. **Le sens est atteignable.** Avant ce lot, l'inversion passait par
 *    « re-choisir le même critère » dans un `<select>` — qui ne redéclenche
 *    pas `onchange` sur la valeur déjà affichée : du code mort.
 * 4. **Le défaut ne bouge pas** : sans préférence, l'ordre est celui d'avant
 *    (récupération, plus récent d'abord ; services alphabétiques), et une clé
 *    mémorisée inconnue retombe dessus sans erreur.
 * 5. **Au vrai Chromium** : le geste complet — choisir, inverser, recharger
 *    (le choix est retrouvé), et un compte qui n'a rien choisi voit l'ordre
 *    d'avant.
 *
 * Tous les documents sont inventés : aucune donnée réelle ici.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', 'web');
const FICHIERS_FRONT = ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js', 'admin.js'];

// ---------------------------------------------------------------------------
// Le bac à sable : le VRAI web/app.js, un DOM minimal
// ---------------------------------------------------------------------------

/** Recopié de test/lot27-regressions.test.js, qui ne l'exporte pas. */
function bacASable() {
  const elements = new Map();
  const faireElement = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    style: {},
    dataset: {},
    classList: {
      _c: new Set(),
      add(...n) { n.forEach((x) => this._c.add(x)); },
      remove(...n) { n.forEach((x) => this._c.delete(x)); },
      toggle(n, on) { if (on) this._c.add(n); else this._c.delete(n); },
      contains(n) { return this._c.has(n); },
    },
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    addEventListener() {},
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, faireElement(id));
    return elements.get(id);
  };

  const bac = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, URL, TextEncoder,
    document: {
      getElementById: (id) => element(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => faireElement('créé'),
      body: faireElement('body'),
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { origin: 'http://crabe.local', href: 'http://crabe.local/' },
    navigator: { userAgent: 'test' },
    confirm: () => true,
    alert() {},
    // savePref avale l'échec en silence (écriture « best effort ») : le tri
    // doit s'appliquer même sans réseau.
    fetch: async () => { throw new Error('aucun appel réseau dans ce test'); },
  };
  bac.window = bac;
  bac.globalThis = bac;

  const context = vm.createContext(bac);
  for (const fichier of FICHIERS_FRONT) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  return { context, element, run: (code) => vm.runInContext(code, context) };
}

/** Un document inventé, avec juste ce que l'écran affiche. */
function doc(filename, { period = '2026-05', sizeBytes = 1000, fetchedAt = '2026-05-02 10:00:00' } = {}) {
  return { id: 0, filename, period, sizeBytes, fetchedAt, missing: false };
}

/** Une branche de l'arbre : un service, un compte, ses documents. */
function branche(connectorId, connectorName, documents) {
  return {
    connectorId,
    connectorName,
    color: '#345678',
    letters: connectorName.slice(0, 2).toUpperCase(),
    logo: null,
    count: documents.length,
    accounts: [{ accountId: 'c1', label: 'Votre compte', accountName: null, documents }],
  };
}

/** La réponse de GET /api/documents, telle que l'écran la reçoit. */
function reponse(tree) {
  const total = tree.reduce((n, b) => n + b.count, 0);
  return {
    destinations: [{
      id: 'local', name: 'Stockage local', letter: 'S', color: '#8a5a44',
      logo: null, logoInterne: null, primary: true, available: true, reason: null,
    }],
    destination: { id: 'local', name: 'Stockage local' },
    available: true,
    reason: null,
    tree,
    filters: { connectors: tree.map((b) => ({ id: b.connectorId, name: b.connectorName })), periods: [] },
    total,
    shown: total,
  };
}

/** Monte l'écran dans le bac : réponse posée, préférences posées, rendu fait. */
function ecran(tree, { prefsValues = {} } = {}) {
  const bac = bacASable();
  bac.context.__reponse = reponse(tree);
  bac.context.__prefs = { 'view.documents': 'list', ...prefsValues };
  bac.run('docs.data = __reponse; prefs.values = __prefs; prefs.loaded = true;');
  bac.run('redessinerDocs()');
  return bac;
}

/** Les noms de fichiers, dans l'ordre où l'écran les a rendus. */
function nomsAffiches(bac) {
  const html = bac.element('docs-content').innerHTML;
  return [...html.matchAll(/docs-file-name">([^<]*)</g)].map((m) => m[1]);
}

/** Les noms de services, dans l'ordre des branches rendues. */
function servicesAffiches(bac) {
  const html = bac.element('docs-content').innerHTML;
  return [...html.matchAll(/docs-branch-name">([^<]*)</g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// 1. Chaque critère, dans les deux sens, sur la donnée brute
// ---------------------------------------------------------------------------

/** Quatre fichiers faits exprès : accent, casse, et `2` contre `10`. */
const PAR_NOM = [
  doc('zebre.pdf'),
  doc('Electricite-10.pdf'),
  doc('École.pdf'),
  doc('electricite-2.pdf'),
];

test('nom de fichier : accents et casse ignorés, 2 avant 10, deux sens', () => {
  const asc = ecran([branche('svc', 'Service', PAR_NOM)], {
    prefsValues: { 'sort.documents': 'filename:asc' },
  });
  // ⚠ « École » avec les E (pas après Z), « -2 » avant « -10 ».
  assert.deepEqual(nomsAffiches(asc),
    ['École.pdf', 'electricite-2.pdf', 'Electricite-10.pdf', 'zebre.pdf']);

  const desc = ecran([branche('svc', 'Service', PAR_NOM)], {
    prefsValues: { 'sort.documents': 'filename:desc' },
  });
  assert.deepEqual(nomsAffiches(desc),
    ['zebre.pdf', 'Electricite-10.pdf', 'electricite-2.pdf', 'École.pdf']);
});

test('taille : comparée en octets, deux sens', () => {
  const documents = [
    doc('moyen.pdf', { sizeBytes: 99_300 }),
    doc('gros.pdf', { sizeBytes: 9_000_000 }),
    doc('petit.pdf', { sizeBytes: 2_048 }),
  ];
  const grand = ecran([branche('svc', 'Service', documents)], {
    prefsValues: { 'sort.documents': 'sizeBytes:desc' },
  });
  // « 9 Mo » après « 99,3 Ko » serait le signe d'un tri sur le texte affiché.
  assert.deepEqual(nomsAffiches(grand), ['gros.pdf', 'moyen.pdf', 'petit.pdf']);

  const petit = ecran([branche('svc', 'Service', documents)], {
    prefsValues: { 'sort.documents': 'sizeBytes:asc' },
  });
  assert.deepEqual(nomsAffiches(petit), ['petit.pdf', 'moyen.pdf', 'gros.pdf']);
});

test('date du document : sans date à la FIN, dans les deux sens', () => {
  const documents = [
    doc('fevrier.pdf', { period: '2026-02' }),
    doc('sans-date.pdf', { period: '' }),
    doc('aout.pdf', { period: '2026-08' }),
  ];
  for (const dir of ['asc', 'desc']) {
    const bac = ecran([branche('svc', 'Service', documents)], {
      prefsValues: { 'sort.documents': `period:${dir}` },
    });
    const noms = nomsAffiches(bac);
    assert.equal(noms.at(-1), 'sans-date.pdf', `sans date doit finir dernier (${dir})`);
    assert.deepEqual(noms.slice(0, 2),
      dir === 'asc' ? ['fevrier.pdf', 'aout.pdf'] : ['aout.pdf', 'fevrier.pdf']);
  }
});

test('date de récupération : deux sens, date illisible à la fin', () => {
  const documents = [
    doc('janvier.pdf', { fetchedAt: '2026-01-10 08:00:00' }),
    doc('mars.pdf', { fetchedAt: '2026-03-10 08:00:00' }),
    doc('illisible.pdf', { fetchedAt: null }),
  ];
  const recent = ecran([branche('svc', 'Service', documents)], {
    prefsValues: { 'sort.documents': 'fetchedAt:desc' },
  });
  assert.deepEqual(nomsAffiches(recent), ['mars.pdf', 'janvier.pdf', 'illisible.pdf']);

  const ancien = ecran([branche('svc', 'Service', documents)], {
    prefsValues: { 'sort.documents': 'fetchedAt:asc' },
  });
  assert.deepEqual(nomsAffiches(ancien), ['janvier.pdf', 'mars.pdf', 'illisible.pdf']);
});

test('ex æquo : départagés par le nom de fichier, le même ordre quel que soit le sens', () => {
  const documents = [
    doc('beta.pdf', { period: '2026-05' }),
    doc('alpha.pdf', { period: '2026-05' }),
  ];
  for (const dir of ['asc', 'desc']) {
    const bac = ecran([branche('svc', 'Service', documents)], {
      prefsValues: { 'sort.documents': `period:${dir}` },
    });
    assert.deepEqual(nomsAffiches(bac), ['alpha.pdf', 'beta.pdf'],
      `même période : alpha avant beta, sens ${dir}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Le critère « service » ordonne les groupes
// ---------------------------------------------------------------------------

const TROIS_SERVICES = () => [
  branche('zeta', 'Zeta', [doc('z-vieux.pdf', { fetchedAt: '2026-01-01 08:00:00' }),
    doc('z-neuf.pdf', { fetchedAt: '2026-06-01 08:00:00' })]),
  branche('ecole', 'École', [doc('e.pdf')]),
  branche('api', 'api', [doc('a.pdf')]),
];

test('service : les groupes s\'ordonnent À LA FRANÇAISE, dans les deux sens', () => {
  const az = ecran(TROIS_SERVICES(), { prefsValues: { 'sort.documents': 'connector:asc' } });
  assert.deepEqual(servicesAffiches(az), ['api', 'École', 'Zeta']);

  const za = ecran(TROIS_SERVICES(), { prefsValues: { 'sort.documents': 'connector:desc' } });
  assert.deepEqual(servicesAffiches(za), ['Zeta', 'École', 'api']);
});

test('service : les documents d\'un compte gardent alors le défaut (plus récent d\'abord)', () => {
  const bac = ecran(TROIS_SERVICES(), { prefsValues: { 'sort.documents': 'connector:desc' } });
  assert.deepEqual(nomsAffiches(bac).slice(0, 2), ['z-neuf.pdf', 'z-vieux.pdf']);
});

test('sous les autres critères, les groupes restent dans l\'ordre servi (alphabétique)', () => {
  // Le serveur envoie l'arbre déjà alphabétique ; l'écran ne doit pas le
  // rebattre sous « taille » — sinon le défaut non plus ne serait pas sûr.
  const bac = ecran(TROIS_SERVICES(), { prefsValues: { 'sort.documents': 'sizeBytes:desc' } });
  assert.deepEqual(servicesAffiches(bac), ['Zeta', 'École', 'api'],
    'l\'ordre des branches est celui de la réponse, intouché');
});

// ---------------------------------------------------------------------------
// 3. Le défaut ne bouge pas, la clé inconnue retombe dessus
// ---------------------------------------------------------------------------

test('sans préférence : récupération, plus récent d\'abord — l\'ordre d\'avant le lot', () => {
  const documents = [
    doc('vieux.pdf', { fetchedAt: '2026-01-10 08:00:00' }),
    doc('neuf.pdf', { fetchedAt: '2026-09-10 08:00:00' }),
    doc('moyen.pdf', { fetchedAt: '2026-04-10 08:00:00' }),
  ];
  const bac = ecran([branche('svc', 'Service', documents)]);
  assert.deepEqual(nomsAffiches(bac), ['neuf.pdf', 'moyen.pdf', 'vieux.pdf']);
  // Et l'écran l'affiche : critère sélectionné + sens en toutes lettres.
  const html = bac.element('docs-content').innerHTML;
  assert.match(html, /selected>\s*Trier : date de récupération/);
  assert.match(html, /Du plus récent au plus ancien/);
});

test('clé mémorisée inconnue : le défaut, sans erreur', () => {
  const documents = [
    doc('vieux.pdf', { fetchedAt: '2026-01-10 08:00:00' }),
    doc('neuf.pdf', { fetchedAt: '2026-09-10 08:00:00' }),
  ];
  const bac = ecran([branche('svc', 'Service', documents)], {
    prefsValues: { 'sort.documents': 'nimporte-quoi:desc' },
  });
  assert.deepEqual(nomsAffiches(bac), ['neuf.pdf', 'vieux.pdf']);
  assert.match(bac.element('docs-content').innerHTML,
    /selected>\s*Trier : date de récupération/,
    'le sélecteur n\'affiche pas une option fantôme');
});

// ---------------------------------------------------------------------------
// 4. Les gestes : choisir applique le sens naturel, le bouton inverse
// ---------------------------------------------------------------------------

test('choisir un critère applique son sens naturel, et se mémorise', () => {
  const bac = ecran([branche('svc', 'Service', PAR_NOM)]);

  bac.run('sortDocuments("filename")');
  assert.equal(bac.run('prefs.values["sort.documents"]'), 'filename:asc');
  assert.deepEqual(nomsAffiches(bac).slice(0, 1), ['École.pdf']);
  assert.match(bac.element('docs-content').innerHTML, /De A à Z/);

  bac.run('sortDocuments("sizeBytes")');
  assert.equal(bac.run('prefs.values["sort.documents"]'), 'sizeBytes:desc',
    'une taille se choisit « du plus grand au plus petit » d\'abord');
  assert.match(bac.element('docs-content').innerHTML, /Du plus grand au plus petit/);
});

test('le bouton inverse le sens — LE geste impossible avant ce lot — et se mémorise', () => {
  const bac = ecran([branche('svc', 'Service', PAR_NOM)], {
    prefsValues: { 'sort.documents': 'filename:asc' },
  });
  assert.equal(nomsAffiches(bac)[0], 'École.pdf');

  bac.run('inverserTriDocuments()');
  assert.equal(bac.run('prefs.values["sort.documents"]'), 'filename:desc');
  assert.equal(nomsAffiches(bac)[0], 'zebre.pdf', 'l\'ordre affiché a réellement changé');
  assert.match(bac.element('docs-content').innerHTML, /De Z à A/);

  bac.run('inverserTriDocuments()');
  assert.equal(bac.run('prefs.values["sort.documents"]'), 'filename:asc');
  assert.equal(nomsAffiches(bac)[0], 'École.pdf');
});

test('une clé inconnue passée au geste retombe sur le défaut, jamais une erreur', () => {
  const bac = ecran([branche('svc', 'Service', PAR_NOM)]);
  bac.run('sortDocuments("__proto__")');
  assert.equal(bac.run('prefs.values["sort.documents"]'), 'fetchedAt:desc');
});

// ---------------------------------------------------------------------------
// 5. Le parcours complet, au vrai Chromium
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT
    ? false
    : 'Playwright n\'est pas installé sur cette machine : le parcours complet '
      + 'n\'est pas joué. Installez-le avec « npm install playwright && npx playwright '
      + 'install chromium » pour couvrir cette chaîne.',
};

test('au vrai Chromium : choisir, inverser, recharger — et le compte sans choix garde l\'ordre d\'avant',
  { ...SANS_NAVIGATEUR, timeout: 120_000 }, async (t) => {
    const helpers = require('./helpers');
    const destinations = require('../server/destinations');

    await helpers.setup();
    t.after(() => helpers.teardown());

    const racine = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crabe-lot89-'));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    destinations.saveConfig('local', { path: racine, protocol: 'local' });

    const trieuse = await helpers.createUser({ username: 'trieuse', plainPassword: 'MotDePasse1' });
    const temoin = await helpers.createUser({ username: 'temoin', plainPassword: 'MotDePasse1' });

    // Trois documents inventés dont le tri par nom (A→Z, Z→A) et le défaut
    // (récupération, récent d'abord) donnent TROIS ordres différents : un tri
    // qui ne ferait rien ne peut pas passer.
    const seed = (user, filename, fetchedAt, issuedOn) => {
      helpers.db.get().prepare(
        `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                               size_bytes, issued_on, fetched_at, destinations)
         VALUES (?, 'free', ?, NULL, 'c1', 2048, ?, ?, ?)`
      ).run(user.id, filename, issuedOn, fetchedAt,
        JSON.stringify({ local: { state: 'ok', ok: true, at: fetchedAt } }));
      const dossier = path.join(racine, user.username, 'Free Internet', 'c1');
      fs.mkdirSync(dossier, { recursive: true });
      fs.writeFileSync(path.join(dossier, filename), 'PDF');
    };
    for (const user of [trieuse, temoin]) {
      seed(user, 'bravo.pdf', '2026-03-10 08:00:00', '2026-03-01');
      seed(user, 'alpha.pdf', '2026-01-10 08:00:00', '2026-01-01');
      seed(user, 'charlie.pdf', '2026-02-10 08:00:00', '2026-02-01');
    }
    const DEFAUT = ['bravo.pdf', 'charlie.pdf', 'alpha.pdf'];

    const client = await helpers.startServer();
    t.after(() => client.close());

    const browser = await PLAYWRIGHT.chromium.launch();
    t.after(() => browser.close());

    /** Se connecte et ouvre « Mes documents » en liste. */
    async function ouvrirDocuments(page, username) {
      await page.goto(`${client.base}/`);
      await page.fill('#login-username', username);
      await page.fill('#login-password', 'MotDePasse1');
      await page.click('#login-submit');
      await page.waitForSelector('#tb-documents');
      await page.click('#tb-documents');
      await page.waitForSelector('#view-documents-list');
      await page.click('#view-documents-list');
      await page.waitForSelector('.docs-file-name');
    }
    const noms = (page) =>
      page.$$eval('.docs-file-name', (els) => els.map((e) => e.textContent.trim()));

    // ── Le compte qui trie ──────────────────────────────────────────────────
    const page = await (await browser.newContext()).newPage();
    await ouvrirDocuments(page, 'trieuse');
    assert.deepEqual(await noms(page), DEFAUT, 'avant tout choix : l\'ordre d\'avant le lot');

    // On choisit un critère : l'ordre change, l'indicateur le montre.
    await page.selectOption('#docs-sort', 'filename');
    await page.waitForFunction(() =>
      document.querySelector('.docs-file-name')?.textContent.includes('alpha'));
    assert.deepEqual(await noms(page), ['alpha.pdf', 'bravo.pdf', 'charlie.pdf']);
    assert.equal((await page.textContent('#docs-sens')).trim(), 'De A à Z');

    // On inverse le sens.
    await page.click('#docs-sens');
    await page.waitForFunction(() =>
      document.querySelector('.docs-file-name')?.textContent.includes('charlie'));
    assert.deepEqual(await noms(page), ['charlie.pdf', 'bravo.pdf', 'alpha.pdf']);
    assert.equal((await page.textContent('#docs-sens')).trim(), 'De Z à A');

    // L'écriture de la préférence est asynchrone (« best effort ») : on
    // l'attend AVANT de recharger, sinon la course ferait un test fragile.
    const preferences = require('../server/preferences');
    for (let i = 0; i < 50 && preferences.get(trieuse.id, 'sort.documents') !== 'filename:desc'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(preferences.get(trieuse.id, 'sort.documents'), 'filename:desc',
      'MORSURE : sans la mémorisation côté serveur, le rechargement ne peut pas retrouver le choix');

    // On recharge la page : le choix est retrouvé.
    await page.reload();
    await page.waitForSelector('#tb-documents');
    await page.click('#tb-documents');
    await page.waitForSelector('.docs-file-name');
    assert.deepEqual(await noms(page), ['charlie.pdf', 'bravo.pdf', 'alpha.pdf'],
      'après rechargement : toujours Z→A, pas le défaut');
    assert.equal(await page.inputValue('#docs-sort'), 'filename');
    assert.equal((await page.textContent('#docs-sens')).trim(), 'De Z à A');

    // ── Le compte qui n'a rien choisi ──────────────────────────────────────
    const temoinPage = await (await browser.newContext()).newPage();
    await ouvrirDocuments(temoinPage, 'temoin');
    assert.deepEqual(await noms(temoinPage), DEFAUT,
      'un compte qui n\'a rien choisi voit l\'ordre d\'avant');
    assert.equal(await temoinPage.inputValue('#docs-sort'), 'fetchedAt');
  });
