'use strict';

/**
 * Lot 96 — un stockage qui refuse : ce que l'utilisateur lit (R5, R6).
 *
 * ─── Ce qui s'est passé ──────────────────────────────────────────────────────
 *
 * Le 05/10/2026 au matin, pCloud a refusé 26 dépôts de suite : « couldn't list
 * files: pcloud Revoked 'access_token' provided, you need to re-authorize the
 * application. (2095) » (forme mesurée en production, chemins masqués). La
 * table des pannes ne la connaissait pas : chaque pastille disait « La copie
 * vers cette destination a échoué. Réessayez… », et la carte Stockage
 * affichait « prêt » et « Connecté » en vert. La cloche, rien.
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 *   1. (R5, D3) les trois refus de pCloud donnent leur phrase MOT POUR MOT,
 *      par le vrai chemin : dépôt, planificateur, « Tester », autorisation ;
 *   2. (R6) la série de refus se dit sur la carte — un nombre, deux dates, la
 *      phrase de la cause —, jamais le message brut (il porte un nom de
 *      fichier) ; une réussite la clôt ; les refus d'avant ce lot, écrits sous
 *      la forme « inconnue », prennent la bonne phrase ;
 *   3. (D4) au VRAI Chromium, l'écran Stockage la montre, et le reste de la
 *      carte ne change pas.
 *
 * rclone est remplacé par un faux (`CRABE_RCLONE_BIN`) ; aucune requête ne
 * part vers pCloud. Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CRABE_COPIE_DELAI_MS = '0';

const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot96-refus-'));
const ETAT_FAUX = path.join(RACINE_FAUX, 'etat-faux-rclone.json');
const JOURNAL_FAUX = path.join(RACINE_FAUX, 'journal-faux-rclone.log');
const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const CATALOGUE = require('./fixtures-rclone-production');

/** Ce que pCloud rend aux dépôts depuis le 05/10/2026 (forme mesurée, chemin inventé). */
const LIGNE_2095 = '2026/10/05 09:17:24 CRITICAL: Failed to create file system for "crabe:crabe/essai": '
  + 'couldn\'t list files: pcloud Revoked \'access_token\' provided, you need to re-authorize the '
  + 'application. (2095)';

/**
 * Le faux rclone : un pCloud qui travaille sur des dossiers locaux, ou qui
 * refuse TOUTE commande de données sur la ligne de l'état (`refus`).
 * `authorize` affiche l'adresse, puis échoue sur `erreurAuthorize`.
 */
fs.writeFileSync(
  FAUX_RCLONE,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const ecrire = (fd, s) => { const b = Buffer.from(s); let n = 0; while (n < b.length) n += fs.writeSync(fd, b, n, b.length - n); };
const TYPES = ${JSON.stringify(CATALOGUE)};
const ETAT = ${JSON.stringify(ETAT_FAUX)};
const JOURNAL = ${JSON.stringify(JOURNAL_FAUX)};
let argv = process.argv.slice(2);
const i = argv.indexOf('--config');
if (i >= 0) argv = argv.filter((_, j) => j !== i && j !== i + 1);
if (argv.includes('providers')) { ecrire(1, JSON.stringify(TYPES)); process.exit(0); }
const cmd = argv[0];
if (cmd === 'version') { ecrire(1, 'rclone v1.75.0-faux\\n'); process.exit(0); }
if (cmd === 'obscure') { ecrire(1, 'OBSCURCI\\n'); process.exit(0); }
fs.appendFileSync(JOURNAL, cmd + '\\n');
const etat = JSON.parse(fs.readFileSync(ETAT, 'utf8'));
if (cmd === 'authorize') {
  ecrire(2, '2026/10/06 15:00:00 NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=essai96\\n');
  setTimeout(() => { ecrire(2, etat.erreurAuthorize + '\\n'); process.exit(1); }, 300);
  return;
}
if (etat.refus) { ecrire(2, etat.refus + '\\n'); process.exit(1); }
const args = [];
for (let j = 1; j < argv.length; j++) {
  if (argv[j] === '--max-depth') { j++; continue; }
  if (argv[j].startsWith('-')) continue;
  args.push(argv[j]);
}
const local = (p) => String(p).replace(/^[A-Za-z0-9_-]+:/, '');
try {
  if (cmd === 'lsd') {
    if (!fs.existsSync(local(args[0]))) fs.mkdirSync(local(args[0]), { recursive: true });
  } else if (cmd === 'mkdir') {
    fs.mkdirSync(local(args[0]), { recursive: true });
  } else if (cmd === 'copyto') {
    fs.mkdirSync(path.dirname(local(args[1])), { recursive: true });
    fs.copyFileSync(local(args[0]), local(args[1]));
  } else if (cmd === 'about') {
    ecrire(1, JSON.stringify({ total: 1000, free: 900, used: 100 }));
  }
} catch (err) {
  ecrire(2, String(err.message) + '\\n');
  process.exit(1);
}
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const erreurs = require('../server/destinations/erreurs-rclone');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const remoteBrowser = require('../server/remote-browser');

const ecrireEtat = (etat) => fs.writeFileSync(ETAT_FAUX, JSON.stringify(etat));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Les phrases, mot pour mot — celles du SUMMARY
// ---------------------------------------------------------------------------

const PHRASE_2095 = 'pCloud a retiré l\'accès de crabe : l\'autorisation enregistrée a été révoquée, et '
  + 'chaque dépôt est refusé. Reconnectez-vous depuis la carte de ce stockage (Paramètres → '
  + 'Stockage), bouton « Renouveler l\'autorisation ». Si pCloud répond alors « Invalid '
  + '\'client_id\' », c\'est qu\'il n\'accepte plus l\'application partagée par défaut : '
  + 'renseignez votre propre application pCloud sur la même carte — l\'aide du champ '
  + '« Identifiant de l\'application » dit comment l\'obtenir.';
const PHRASE_CLIENT_ID = 'pCloud refuse l\'application avec laquelle crabe se présente (« Invalid '
  + '\'client_id\' »). pCloud n\'accepte plus l\'application partagée du logiciel rclone : il '
  + 'faut votre propre application pCloud. Demandez-la sur https://docs.pcloud.com/my_apps/ '
  + '(pCloud l\'approuve à la main), déclarez-y l\'adresse de redirection '
  + 'http://localhost:53682/, puis recopiez son identifiant et son secret sur la carte de ce '
  + 'stockage (Paramètres → Stockage) et cliquez « Se connecter à pCloud ». Si c\'est déjà '
  + 'fait, vérifiez l\'identifiant recopié.';
const PHRASE_REDIRECTION = 'pCloud refuse l\'adresse de retour de crabe (« This \'redirect_uri\' '
  + 'is not autorized. »). Dans les réglages de votre application chez pCloud '
  + '(https://docs.pcloud.com/my_apps/), déclarez l\'adresse de redirection '
  + 'http://localhost:53682/ — exactement celle-ci —, puis relancez « Se connecter à pCloud » '
  + 'depuis la carte de ce stockage (Paramètres → Stockage).';

let PCLOUD;
let AUTRE;
let user;

/** Un dépôt complet — le stockage local + les clouds actifs — d'un document inventé. */
function deposer(filename) {
  return destinations.storeInvoice({
    username: 'lot96',
    userId: user.id,
    connectorId: 'edf',
    connectorName: 'EDF',
    accountId: 'client-essai',
    issuedOn: '2026-10-05',
    filename,
    buffer: Buffer.from('%PDF-1.4 faux document'),
  });
}

const journalStockage = (destId) => helpers.db.get()
  .prepare('SELECT * FROM destination_logs WHERE dest_id = ? ORDER BY id').all(destId);

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot96' });
  ecrireEtat({ refus: null });
  fs.writeFileSync(JOURNAL_FAUX, '');

  // La carte pCloud de production, à l'identique de forme : jeton et région
  // dans les champs nommés, aucune application, active.
  PCLOUD = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud' }).id;
  destinations.saveConfig(PCLOUD, {
    enabled: true,
    remoteName: 'crabe',
    basePath: path.join(RACINE_FAUX, 'pcloud'),
    valeurs: { token: '{"access_token":"JETON-ESSAI"}', hostname: 'eapi.pcloud.com' },
  }, [{ key: 'token', type: 'password' }, { key: 'hostname', type: 'text' }]);
  // Un autre cloud, qui marche : sa carte ne doit pas bouger.
  AUTRE = destinations.createCloud({ provider: 'pcloud', displayName: 'Témoin' }).id;
  destinations.saveConfig(AUTRE, {
    enabled: false,
    remoteName: 'crabe',
    basePath: path.join(RACINE_FAUX, 'temoin'),
    valeurs: { token: '{"access_token":"JETON-TEMOIN"}', hostname: 'eapi.pcloud.com' },
  }, [{ key: 'token', type: 'password' }, { key: 'hostname', type: 'text' }]);
  require('../server/destinations/backends').oublier();
});

test.after(() => {
  helpers.teardown();
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R5 — la table
// ---------------------------------------------------------------------------

test('R5 — les trois refus de pCloud, mot pour mot', () => {
  assert.equal(erreurs.traduire(LIGNE_2095), PHRASE_2095);
  assert.equal(erreurs.traduire('Error: failed to get token: oauth2: cannot fetch token: 400\n'
    + 'Response: {"result":2000,"error":"Invalid \'client_id\'."}'), PHRASE_CLIENT_ID);
  assert.equal(erreurs.traduire('This \'redirect_uri\' is not autorized.'), PHRASE_REDIRECTION);
  // La bonne orthographe est reconnue aussi, si pCloud la corrigeait.
  assert.equal(erreurs.traduire('This \'redirect_uri\' is not authorized.'), PHRASE_REDIRECTION);
  // Les constantes exportées sont ces phrases.
  assert.equal(erreurs.MESSAGE_PCLOUD_JETON_REVOQUE, PHRASE_2095);
  assert.equal(erreurs.MESSAGE_PCLOUD_APPLICATION_REFUSEE, PHRASE_CLIENT_ID);
  assert.equal(erreurs.MESSAGE_PCLOUD_REDIRECTION, PHRASE_REDIRECTION);
  // Ce que la table disait avant ce lot de la même ligne : la forme inconnue.
  assert.equal(erreurs.phraseReconnue('pas une panne connue'), null);
});

test('R5 — chaque phrase relue redonne elle-même : la carte peut la reprendre sans dériver', () => {
  for (const phrase of [PHRASE_CLIENT_ID, PHRASE_REDIRECTION]) {
    assert.equal(erreurs.traduire(phrase), phrase);
  }
});

// ---------------------------------------------------------------------------
// D3 — par le vrai chemin
// ---------------------------------------------------------------------------

test('D3 — par le dépôt : la pastille, le journal des stockages et le journal applicatif disent la phrase', async () => {
  ecrireEtat({ refus: LIGNE_2095 });
  helpers.db.get().prepare('DELETE FROM app_logs').run();

  const results = await deposer('2026-10_essai-depot-1.pdf');
  assert.equal(results.local.ok, true, 'le document reste valide sur la principale');
  assert.equal(results[PCLOUD].ok, false);
  assert.equal(results[PCLOUD].message, `pCloud : ${PHRASE_2095}`);

  const derniere = journalStockage(PCLOUD).at(-1);
  assert.equal(derniere.message, `2026-10_essai-depot-1.pdf : pCloud : ${PHRASE_2095}`);
  const applog = helpers.db.get()
    .prepare("SELECT message FROM app_logs WHERE source = 'destinations' AND level = 'error' ORDER BY id DESC")
    .get();
  assert.ok(applog.message.includes(PHRASE_2095), applog.message);
});

test('D3 — par le vrai planificateur : chaque document récupéré porte la phrase pour pCloud', async () => {
  ecrireEtat({ refus: LIGNE_2095 });
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: 'client@exemple.fr', password: 'x' });

  let run;
  for (let i = 0; i < 8; i++) {
    run = await scheduler.runForUser(user.id, 'edf', 'manual');
    if (run.ok && run.count > 0) break;
  }
  assert.equal(run.ok, true, run.message);
  assert.ok(run.count > 0, 'des documents ont été récupérés');

  const lignes = helpers.db.get()
    .prepare("SELECT destinations FROM invoices WHERE user_id = ? AND connector_id = 'edf'")
    .all(user.id)
    .map((r) => JSON.parse(r.destinations));
  assert.ok(lignes.length > 0);
  for (const d of lignes) {
    assert.equal(d.local.ok, true);
    assert.equal(d[PCLOUD].ok, false);
    assert.equal(d[PCLOUD].message, `pCloud : ${PHRASE_2095}`);
  }
});

test('D3 — par « Tester la connexion » : la phrase, préfixée du nom du stockage', async () => {
  ecrireEtat({ refus: LIGNE_2095 });
  const resultat = await destinations.test(PCLOUD, user.id);
  assert.deepEqual(resultat, { ok: false, message: `pCloud : ${PHRASE_2095}` });
});

test('D3 — par l\'autorisation, si rclone rapportait une erreur de la fenêtre : la même phrase', async (t) => {
  const vrai = remoteBrowser.manager;
  t.after(() => {
    remoteBrowser.manager = vrai;
  });
  const conclusions = [];
  let session = null;
  remoteBrowser.manager = () => ({
    start: async (opts) => {
      session = { opts };
      return { state: 'running', hint: opts.hint };
    },
    conclure: async (userId, connectorId, r) => {
      conclusions.push(r);
      session = null;
    },
    sessionFor: () => session,
  });

  for (const [erreur, phrase] of [
    ['2026/10/06 15:00:01 Error: failed to get token: oauth2: cannot fetch token: 400\n'
      + 'Response: {"result":2000,"error":"Invalid \'client_id\'."}', PHRASE_CLIENT_ID],
    ['2026/10/06 15:00:01 Error: No code returned by remote server: This \'redirect_uri\' is not autorized.', PHRASE_REDIRECTION],
    [`2026/10/06 15:00:01 Error: ${LIGNE_2095}`, PHRASE_2095],
  ]) {
    conclusions.length = 0;
    ecrireEtat({ erreurAuthorize: erreur });
    const fiche = destinations.pourAutorisation(PCLOUD);
    await require('../server/destinations/autorisation').demarrer({
      userId: user.id,
      destId: PCLOUD,
      type: fiche.type,
      nom: fiche.nom,
      valeurs: fiche.valeurs,
      enregistrer: () => assert.fail('rien ne doit être enregistré'),
    });
    for (let i = 0; i < 50 && !conclusions.length; i++) await attendre(100);
    assert.deepEqual(conclusions, [{ ok: false, message: phrase }]);
  }
});

// ---------------------------------------------------------------------------
// R6 — la série de refus, côté serveur
// ---------------------------------------------------------------------------

test('R6 — la série : un nombre, deux dates, la phrase ; jamais le message brut ni le nom d\'un fichier', async () => {
  const refus = destinations.refusDesDepots(PCLOUD);
  assert.ok(refus, 'la série est dite');
  assert.ok(refus.nombre >= destinations.REFUS_DE_SUITE_MIN, `nombre : ${refus.nombre}`);
  assert.equal(refus.message, PHRASE_2095);
  assert.match(refus.premier, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(refus.dernier, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(refus).sort(), ['dernier', 'message', 'nombre', 'premier']);
  assert.equal(JSON.stringify(refus).includes('.pdf'), false, 'aucun nom de fichier');

  // La carte du stockage qui refuse le porte ; celle du témoin, rien — sa vue
  // n'a même pas la clé.
  const carte = await destinations.publicConfigComplet(PCLOUD);
  assert.deepEqual(carte.refusDepots, refus);
  const temoin = await destinations.publicConfigComplet(AUTRE);
  assert.equal('refusDepots' in temoin, false);
});

test('R6 — un « Tester » réussi clôt la série, et un dépôt réussi aussi', async () => {
  // Un test réussi.
  ecrireEtat({ refus: null });
  const ok = await destinations.test(PCLOUD, user.id);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(destinations.refusDesDepots(PCLOUD), null);

  // Trois refus de dépôt de suite : la série revient — un test en échec entre
  // deux ne compte pas comme dépôt, et ne la coupe pas.
  ecrireEtat({ refus: LIGNE_2095 });
  await deposer('2026-10_essai-serie-1.pdf');
  await destinations.test(PCLOUD, user.id);
  await deposer('2026-10_essai-serie-2.pdf');
  assert.equal(destinations.refusDesDepots(PCLOUD), null, 'deux refus : sous le seuil');
  await deposer('2026-10_essai-serie-3.pdf');
  assert.equal(destinations.refusDesDepots(PCLOUD).nombre, 3);

  // Un dépôt réussi (rien dans destination_logs : c'est l'état de copie du
  // document qui le dit) clôt la série.
  ecrireEtat({ refus: null });
  await attendre(1100); // l'horodatage de la base est à la seconde
  const reussi = await deposer('2026-10_essai-serie-4.pdf');
  assert.equal(reussi[PCLOUD].ok, true, reussi[PCLOUD].message);
  helpers.db.get()
    .prepare('INSERT INTO invoices (user_id, connector_id, filename, size_bytes, destinations) VALUES (?, ?, ?, 1, ?)')
    .run(user.id, 'edf', '2026-10_essai-serie-4.pdf',
      JSON.stringify({ [PCLOUD]: { state: 'ok', ok: true, at: new Date().toISOString() } }));
  assert.equal(destinations.refusDesDepots(PCLOUD), null);
});

/** Les 26 refus du 05/10/2026, sous la forme qu'ils ont en production (fichiers inventés). */
function poserLesRefusDu5Octobre(destId, nom = 'pCloud') {
  const ancienne = 'La copie vers cette destination a échoué. Réessayez ; si cela se reproduit, '
    + 'signalez-le en joignant ce détail technique : « couldn\'t list files: pcloud Revoked '
    + '\'access_token\' provided, you need to re-authorize the application. (2095) ».';
  const inserer = helpers.db.get().prepare(
    'INSERT INTO destination_logs (dest_id, dest_name, user_id, at, success, message) VALUES (?, ?, ?, ?, 0, ?)'
  );
  const debut = Date.parse('2026-10-05T07:17:24Z');
  for (let i = 0; i < 26; i++) {
    const at = new Date(debut + i * 26_000).toISOString().replace('T', ' ').slice(0, 19);
    inserer.run(destId, nom, user.id, at, `2026-0${(i % 9) + 1}_facture-essai-${i}.pdf : ${nom} : ${ancienne}`);
  }
  // Puis un « Tester », en échec lui aussi.
  inserer.run(destId, nom, user.id, '2026-10-05 07:44:40', `${nom} : ${ancienne}`);
}

test('R6 — les refus d\'avant ce lot (forme « inconnue ») prennent la phrase du jeton révoqué', () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud' }).id;
  poserLesRefusDu5Octobre(id);
  assert.deepEqual(destinations.refusDesDepots(id), {
    nombre: 26,
    premier: '2026-10-05T07:17:24.000Z',
    dernier: '2026-10-05T07:28:14.000Z',
    message: PHRASE_2095,
  });
});

test('R6 — une cause non reconnue : pas de phrase inventée, et toujours aucun détail', () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud' }).id;
  const inserer = helpers.db.get().prepare(
    'INSERT INTO destination_logs (dest_id, dest_name, user_id, success, message) VALUES (?, ?, ?, 0, ?)'
  );
  for (let i = 0; i < 3; i++) {
    inserer.run(id, 'pCloud', user.id, `facture-${i}.pdf : pCloud : La copie vers cette destination a échoué. `
      + 'Réessayez ; si cela se reproduit, signalez-le en joignant ce détail technique : « panne inédite '
      + `facture-${i}.pdf ».`);
  }
  const refus = destinations.refusDesDepots(id);
  assert.equal(refus.nombre, 3);
  assert.equal(refus.message, null, 'la carte dira où lire le détail, sans le recopier');
  assert.equal(JSON.stringify(refus).includes('facture-'), false);
});

// ---------------------------------------------------------------------------
// D4 — au vrai Chromium
// ---------------------------------------------------------------------------

/**
 * Une session ouverte par l'API (second facteur compris, s'il est demandé),
 * rendue sous la forme du cookie que Chromium recevra.
 */
async function sessionDe(client, username) {
  const totp = require('../server/auth/totp');
  let cookie = '';
  const appel = async (chemin, corps) => {
    const r = await fetch(`${client.base}${chemin}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(corps || {}),
    });
    const brut = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
    if (brut) cookie = brut.split(';')[0];
    return r.json();
  };
  const etape = await appel('/api/auth/login', { username, password: 'MotDePasse1' });
  if (etape.step === '2fa-setup') {
    const reglage = await appel('/api/auth/2fa/setup');
    await appel('/api/auth/2fa/confirm', { code: totp.currentToken(reglage.secret) });
  }
  assert.ok(cookie, 'cookie de session absent');
  return cookie.split('=').slice(1).join('=');
}

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();

test('D4 — au vrai Chromium : la carte Stockage dit la phrase, et le reste de la carte ne bouge pas',
  { skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.', timeout: 120_000 },
  async (t) => {
    // La base de l'écran : la carte pCloud de production à l'identique de forme
    // (éteinte côté administration, 26 refus du 05/10 et un « Tester »), et la
    // carte témoin. Le pCloud des essais précédents est retiré de l'écran.
    destinations.deleteCloud(PCLOUD);
    const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud' }).id;
    destinations.saveConfig(id, {
      enabled: false,
      remoteName: 'crabe',
      basePath: 'crabe',
      valeurs: { token: '{"access_token":"JETON-ESSAI"}', hostname: 'eapi.pcloud.com' },
    }, [{ key: 'token', type: 'password' }, { key: 'hostname', type: 'text' }]);
    poserLesRefusDu5Octobre(id);

    const admin = await helpers.createUser({ username: 'lot96ecran', plainPassword: 'MotDePasse1', role: 'admin' });
    helpers.db.get()
      .prepare('UPDATE users SET role_id = ? WHERE id = ?')
      .run(require('../server/permissions').roleBySlug('admin').id, admin.id);
    const client = await helpers.startServer();
    t.after(() => client.close());
    const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
    t.after(() => navigateur.close());

    const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
    await contexte.addCookies([{
      name: 'crabe.sid', value: await sessionDe(client, 'lot96ecran'), domain: '127.0.0.1', path: '/',
    }]);
    const page = await contexte.newPage();
    const erreursJs = [];
    page.on('pageerror', (e) => erreursJs.push(String(e)));
    await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tb-admin', { state: 'visible' });
    await page.click('#tb-admin');
    await page.click('.settings-nav-item[data-apage="storage"]');
    await page.waitForSelector(`#dest-card-${id}`);

    const phrase = (await page.textContent(`#dest-${id}-refus`)).trim();
    assert.equal(phrase, `⚠ pCloud refuse les dépôts : les 26 derniers ont été refusés, du 05/10/2026 09:17 `
      + `au 05/10/2026 09:28. ${PHRASE_2095} Une fois la cause réglée, « Tester la connexion » le `
      + 'vérifie, et « Synchroniser » envoie les documents qui manquent.');
    // Visible, en rouge, et à sa place : sous les avertissements, dans la carte.
    assert.equal(await page.isVisible(`#dest-${id}-refus`), true);

    // Le reste de la carte : le badge d'état et celui de l'autorisation sont
    // ceux d'avant (R6 n'y touche pas).
    const carte = await page.textContent(`#dest-card-${id}`);
    assert.match(carte, /ne reçoit plus rien/);
    assert.match(carte, /Connecté/);
    // La ligne d'aide de pCloud sans application, près du bouton (R7).
    assert.equal((await page.textContent(`#dest-${id}-application`)).trim(),
      '⚠ Renseignez d\'abord l\'identifiant et le secret de votre propre application pCloud, '
      + 'ci-dessous : sans eux, pCloud refuse aujourd\'hui la connexion. L\'aide du champ '
      + '« Identifiant de l\'application » dit comment l\'obtenir.');

    // La carte témoin : aucune phrase.
    assert.equal(await page.$(`#dest-${AUTRE}-refus`), null);

    // Aucun nom de fichier dans la page.
    const html = await page.content();
    assert.equal(html.includes('facture-essai'), false);
    assert.equal(html.includes('.pdf'), false);
    assert.deepEqual(erreursJs, [], 'aucune erreur JavaScript dans la page');
  });
