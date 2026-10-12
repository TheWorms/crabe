'use strict';

/**
 * Lot 105 (R6) — le journal de la fenêtre de connexion ne dit plus
 * d'identifiant : toute adresse écrite n'y garde que son hôte et un chemin
 * MASQUÉ (tout segment qui contient un chiffre, ou qui ressemble à un
 * identifiant, devient « … »), sans requête ni fragment.
 *
 * Mesuré le 12/10/2026 : la ligne de capture d'Alma écrivait l'adresse
 * complète de la page du compte, identifiant de compte compris.
 *
 * Trois services par le vrai chemin de la capture (doubles de système du
 * lot 95 : aucun navigateur, aucun réseau) : Alma (preuve lue dans la
 * fenêtre, marqueur mesuré), Battle.net (preuve par le lien de déconnexion),
 * et un service existant dont la page porte un identifiant dans son chemin.
 *
 * ⚠ Valeurs inventées : identifiants « ZZessai… », commandes « ZZ9… »,
 * factures « 99… », UUID « aaaaaaaa-1111-… », jeton « ZZjeton… ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const releve = require('../server/connectors/releve-navigation');
const preuve = require('../server/connectors/preuve-connexion');
const remoteBrowser = require('../server/remote-browser');

/** Ce qu'aucune ligne du journal des essais ne doit porter. */
const IDENTIFIANTS = [/customer_account_ZZ/, /payment_ZZ/, /installment_ZZ/, /ZZ9\d+/, /99\d{6,}/, /aaaaaaaa-1111/, /ZZjeton/,
  /https?:\/\//, /\?[a-z]+=/i, /#[a-z]/i];

function sansIdentifiant(texte) {
  for (const motif of IDENTIFIANTS) assert.doesNotMatch(texte, motif, `le journal ne porte pas ${motif}`);
}

// ---------------------------------------------------------------------------
// La règle, pure
// ---------------------------------------------------------------------------

test('R6 — l\'adresse au journal : l\'hôte et le chemin masqué, ni requête ni fragment — Alma, Battle.net, un service existant', () => {
  const cas = {
    'https://portal.getalma.eu/account/customer_account_ZZessaiCompte01': 'portal.getalma.eu/account/…',
    'https://portal.getalma.eu/payment_ZZessaiAchat01?onglet=1#recu': 'portal.getalma.eu/…',
    'https://portal.getalma.eu/login/marketing-optin': 'portal.getalma.eu/login/marketing-optin',
    'https://portal.getalma.eu/': 'portal.getalma.eu/',
    'https://account.battle.net/transactions': 'account.battle.net/transactions',
    'https://account.battle.net/transactions/ZZ900000001/9900000001?page=2&region=zz': 'account.battle.net/transactions/…/…',
    'https://riders.uber.com/trips/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa': 'riders.uber.com/trips/…',
    'https://admin.gandi.net/billing': 'admin.gandi.net/billing',
    'https://ventes.exemple.fr/fr-FR/user/bookings/past-bookings': 'ventes.exemple.fr/fr-FR/user/bookings/past-bookings',
    'https://exemple.invalid/compte/jean.dupont@exemple.invalid/x': 'exemple.invalid/compte/…/x',
    'https://exemple.invalid/a/%41%42/b': 'exemple.invalid/a/…/b',
    'https://exemple.invalid/jeton/AbCdEfGhIjKlMn': 'exemple.invalid/jeton/…',
    'https://exemple.invalid/compte_client-AbCdEfGhIjKlMn/factures': 'exemple.invalid/…/factures',
    'https://utilisateur:secret@exemple.invalid/x': 'exemple.invalid/x',
  };
  for (const [adresse, attendu] of Object.entries(cas)) assert.equal(releve.adresseMasquee(adresse), attendu, adresse);
  assert.equal(releve.adresseMasquee('pas une adresse'), '(adresse illisible)');
  assert.equal(releve.adresseMasquee('javascript:alert(1)'), '(adresse non web)');
  // Les segments ordinaires restent lisibles : le journal garde son sens.
  for (const ordinaire of ['transactions', 'marketing-optin', 'my-orders', 'in-progress', 'documents.do', 'fr-FR', 'espace-particuliers']) {
    assert.equal(releve.segmentIdentifiant(ordinaire), false, ordinaire);
  }
});

test('R6 — dans un texte : chaque adresse masquée, la ponctuation et le reste du texte inchangés', () => {
  assert.equal(
    releve.masquerAdresses('Alma : la fenêtre affiche https://portal.getalma.eu/account/customer_account_ZZessaiCompte01 (l\'adresse a tenu). '
      + 'Puis https://account.battle.net/transactions/ZZ900000001/9900000001?page=2, enfin http://exemple.invalid/x#y.'),
    'Alma : la fenêtre affiche portal.getalma.eu/account/… (l\'adresse a tenu). Puis account.battle.net/transactions/…/…, '
      + 'enfin exemple.invalid/x.'
  );
  assert.equal(releve.masquerAdresses('aucune adresse ici : 3 cookie(s).'), 'aucune adresse ici : 3 cookie(s).');
});

test('R6 — « navigation — … » : la même règle (l\'ancien masque ne voyait que six chiffres de suite)', () => {
  assert.equal(releve.formaterReponse({ statut: 200, url: 'https://portal.getalma.eu/account/customer_account_ZZessaiCompte01?x=1' }),
    '200 portal.getalma.eu /account/…');
  assert.equal(releve.formaterReponse({ statut: 302, url: 'https://account.battle.net/transactions/ZZ900000001/9900000001',
    renvoi: '/login/fr/?ref=transactions' }), '302 account.battle.net /transactions/…/… → account.battle.net /login/fr/');
  // Le chemin sert au JUGEMENT tel qu'il est : seul le journal est masqué.
  assert.deepEqual(releve.formeAdresse('https://exemple.invalid/compte/12345'), { hote: 'exemple.invalid', chemin: '/compte/…' });
});

test('R6 — les lignes de preuve du socle (« URL finale … ») suivent la règle', () => {
  const confirmee = preuve.ligneConfirmee('Battle.net', { url: 'https://account.battle.net/transactions?ref=ZZ9000', preuvesFortes: ['a[href*="logout"]'], cookies: 15 });
  assert.equal(confirmee, 'Battle.net : connexion confirmée (URL finale account.battle.net/transactions, lien de déconnexion présent, 15 cookie(s)).');
  const refusee = preuve.ligneNonConfirmee('Alma', { url: 'https://portal.getalma.eu/payment_ZZessaiAchat01', marqueurs: [], cookies: 7 });
  assert.match(refusee, /URL finale portal\.getalma\.eu\/…, aucun marqueur de compte/);
  sansIdentifiant(`${confirmee}\n${refusee}`);
});

// ---------------------------------------------------------------------------
// Par le vrai chemin de la capture — trois services
// ---------------------------------------------------------------------------

function fauxSysteme() {
  const existants = new Set(['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify', '/usr/share/novnc/core/rfb.js']);
  return {
    fs: {
      existsSync: (p) => existants.has(String(p)),
      accessSync: (p) => { if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`); },
      readdirSync: () => { throw new Error('ENOENT'); },
      readFileSync: () => { throw new Error('ENOENT'); },
      writeFileSync: (p) => existants.add(String(p)),
      mkdirSync: (p) => { existants.add(String(p)); return String(p); },
      rmSync: (p) => existants.delete(String(p)),
    },
    spawn: (command, args) => {
      if (command === 'Xvfb') {
        const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
        if (display) existants.add(`/tmp/.X11-unix/X${display}`);
      }
      return { command, args: args.map(String), stdout: { resume: () => {} }, stderr: { resume: () => {} }, on: () => {}, kill: () => {} };
    },
  };
}

/** La page de la fenêtre : son adresse, et les sélecteurs qu'elle porte. */
function pageFenetre(url, selecteurs = []) {
  return {
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    isClosed: () => false,
    locator: (sel) => ({
      count: async () => (selecteurs.includes(sel) ? 1 : 0),
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async () => null,
  };
}

async function capturer({ ouverture, page, onDetected = null }) {
  const journal = [];
  const systeme = fauxSysteme();
  const cookies = Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, value: 'x', domain: new URL(ouverture.url).hostname, expires: -1 }));
  const manager = remoteBrowser.createManager({
    fs: systeme.fs,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: systeme.spawn,
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, id) => journal.push({ level, message, id }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({ page, storageState: async () => ({ cookies, origins: [] }), close: async () => {} }),
    timeoutMs: 5_000,
    pollMs: 4,
  });
  await manager.start({
    userId: 1,
    marker: '',
    ...ouverture,
    onDetected: onDetected || (async (etat) => ({ fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } })),
  });
  let resultat = await manager.saveNow(1, ouverture.connectorId);
  if (!resultat.ok) resultat = await manager.saveNow(1, ouverture.connectorId);
  await manager.stop?.(1, ouverture.connectorId);
  return { resultat, journal };
}

test('D3 — Alma : « la fenêtre affiche portal.getalma.eu/account/… » — plus l\'identifiant du compte', async () => {
  const { resultat, journal } = await capturer({
    ouverture: {
      connectorId: 'alma', connectorName: 'Alma', url: 'https://portal.getalma.eu/', verifyUrl: 'https://portal.getalma.eu/',
      preuveSurFenetre: true, marqueursFenetre: [{ selecteur: '[data-testid="account-logged-in-button"]' }],
    },
    page: pageFenetre('https://portal.getalma.eu/account/customer_account_ZZessaiCompte01', ['[data-testid="account-logged-in-button"]']),
  });
  assert.equal(resultat.ok, true, resultat.error);
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.equal(ligne.message, 'Session Alma capturée par navigateur distant pour le compte 1 — 7 cookie(s), validité vérifiée (Alma : '
    + 'connexion confirmée — la fenêtre affiche portal.getalma.eu/account/… (l\'adresse de contrôle a tenu) et son marqueur mesuré '
    + '([data-testid="account-logged-in-button"]), lu sans requête supplémentaire).');
  sansIdentifiant(journal.map((l) => l.message).join('\n'));
});

test('D3 — Battle.net : « URL finale account.battle.net/transactions », sans « https:// »', async () => {
  const { resultat, journal } = await capturer({
    ouverture: {
      connectorId: 'battle-net', connectorName: 'Battle.net', url: 'https://account.battle.net/transactions',
      verifyUrl: 'https://account.battle.net/transactions', preuveSurFenetre: true,
      marqueursFenetre: [{ selecteur: 'blz-nav-battlenet[authenticated]' }],
    },
    page: pageFenetre('https://account.battle.net/transactions?ref=ZZ900000001', ['a[href*="logout"]']),
  });
  assert.equal(resultat.ok, true, resultat.error);
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.match(ligne.message, /validité vérifiée \(Battle\.net : connexion confirmée \(URL finale account\.battle\.net\/transactions, lien de déconnexion présent\)\)\.$/);
  sansIdentifiant(journal.map((l) => l.message).join('\n'));
});

test('D3 — un service existant dont la page porte un identifiant dans son chemin : « riders.uber.com/trips/… »', async () => {
  const { resultat, journal } = await capturer({
    ouverture: {
      connectorId: 'uber', connectorName: 'Uber', url: 'https://riders.uber.com/trips', verifyUrl: 'https://riders.uber.com/trips',
      preuveSurFenetre: true,
    },
    page: pageFenetre('https://riders.uber.com/trips/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa?tab=receipt', ['a[href*="logout"]']),
  });
  assert.equal(resultat.ok, true, resultat.error);
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.match(ligne.message, /\(URL finale riders\.uber\.com\/trips\/…, lien de déconnexion présent\)/);
  sansIdentifiant(journal.map((l) => l.message).join('\n'));
});

test('D3 — le filet : un message d\'erreur qui porte une adresse (navigateur, socle) est masqué lui aussi', async () => {
  const { resultat, journal } = await capturer({
    ouverture: { connectorId: 'alma', connectorName: 'Alma', url: 'https://portal.getalma.eu/', verifyUrl: '' },
    page: pageFenetre('https://portal.getalma.eu/account/customer_account_ZZessaiCompte01'),
    onDetected: async () => {
      throw new Error('page.goto: net::ERR_ABORTED at https://portal.getalma.eu/payment_ZZessaiAchat01?jeton=ZZjetonEssai');
    },
  });
  assert.ok(resultat, 'l\'enregistrement a été tenté');
  const ligne = journal.find((l) => /Enregistrement de session impossible/.test(l.message));
  assert.equal(ligne.message, 'Enregistrement de session impossible — page.goto: net::ERR_ABORTED at portal.getalma.eu/…');
  sansIdentifiant(journal.map((l) => l.message).join('\n'));
});
