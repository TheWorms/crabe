'use strict';

/**
 * Lot 70 — le bandeau rejoint l'en-tête, et trois échecs pour trois raisons.
 *
 * Quatre acquis mordus ici :
 *
 *   1. **le bandeau d'opérations vit SUR la ligne de l'en-tête** (entre le
 *      logo et les icônes), borné à l'espace libre : il ne pousse ni l'un ni
 *      les autres, et son texte se tronque quand la place manque ;
 *   2. **un onglet vide n'est jamais la page à juger** : le 08/09/2026,
 *      Electro Dépôt ouvrait un second onglet resté `about:blank` qui devenait
 *      l'onglet actif — le choix d'onglet l'ignore, et la boucle de
 *      surveillance le referme passé un sursis ;
 *   3. **la preuve Airbnb ne se lit plus sur une page servie aux anonymes** :
 *      account-settings/payments/your-payments répond 200 à tout visiteur
 *      (mesuré au curl depuis le CT le 08/09/2026) — la preuve déménage sur
 *      /trips, dont le renvoi anonyme vers /login est mesuré et déclaré ;
 *   4. **la carte dit la limite du service** : la déclaration `precision`
 *      s'ajoute au message d'exécution, avec ou sans document descendu —
 *      « Aucune nouvelle facture » seul se lisait « il en manque » (SNCF
 *      Connect, 08/09/2026).
 *
 * ⚠ Toutes les valeurs des sondes sont INVENTÉES (exemple.test) ; les seules
 * adresses réelles sont les formes d'URL publiques d'airbnb.fr, qui sont la
 * mesure du défaut.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const permissions = require('../server/permissions');
const db = require('../server/db/db');
const remoteBrowser = require('../server/remote-browser');
const preuve = require('../server/connectors/preuve-connexion');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');

// ---------------------------------------------------------------------------
// Phase A — le bandeau vit sur la ligne de l'en-tête
// ---------------------------------------------------------------------------

test('le bandeau est DANS l\'en-tête, entre le logo et les icônes', () => {
  const iTopbar = HTML.indexOf('<div class="topbar">');
  const iLogo = HTML.indexOf('class="tb-logo"');
  const iBanner = HTML.indexOf('id="op-banner"');
  const iIcones = HTML.indexOf('class="tb-right tb-desktop-only"');
  const iContenu = HTML.indexOf('<div class="content">');

  assert.ok(iTopbar !== -1 && iLogo !== -1 && iBanner !== -1 && iIcones !== -1);
  // L'ordre sur la ligne : logo, bandeau, icônes — et tout AVANT le contenu.
  assert.ok(iTopbar < iLogo, 'le logo appartient à l\'en-tête');
  assert.ok(iLogo < iBanner, 'le bandeau vient après le logo');
  assert.ok(iBanner < iIcones, 'le bandeau vient avant les icônes');
  assert.ok(iIcones < iContenu, 'tout cela vit dans l\'en-tête, pas dans la page');
  // UN seul bandeau : le lot 65 l'exige déjà, le déménagement ne le duplique pas.
  assert.equal(HTML.indexOf('id="op-banner"', iBanner + 1), -1);
});

test('le bandeau ne pousse ni le logo ni les icônes : espace libre, jamais plus', () => {
  const zone = CSS.match(/\.op-banner\{([^}]*)\}/);
  assert.ok(zone, 'la règle .op-banner existe');
  // `flex:1` : le bandeau occupe l'espace LIBRE de la ligne ; `min-width:0`
  // l'autorise à rétrécir au lieu de pousser ses voisins.
  assert.match(zone[1], /flex:\s*1/, 'le bandeau prend l\'espace libre de la ligne');
  assert.match(zone[1], /min-width:\s*0/, 'et sait rétrécir : sans cela il pousserait les icônes');
  assert.match(zone[1], /justify-content:\s*center/, 'la pastille reste centrée dans cet espace');
  // Le bandeau appartient à la ligne : il n'est plus l'élément collant qui
  // flottait au-dessus de la page (lot 65) — retrait VOLONTAIRE.
  assert.equal(/position:\s*sticky/.test(zone[1]), false, 'plus de sticky : il vit dans l\'en-tête');

  const boite = CSS.match(/\.op-box\{([^}]*)\}/);
  assert.ok(boite);
  // La pastille se borne à l'espace du bandeau (100 % moins ses marges),
  // jamais à la fenêtre entière : c'est ce qui protège les voisins.
  assert.match(boite[1], /max-width:\s*min\(620px,\s*calc\(100% - 24px\)\)/);
  assert.equal(/100vw/.test(boite[1]), false, 'la borne est l\'en-tête, pas la fenêtre');
});

test('quand la place manque, le texte se tronque — la ligne agrégée aussi', () => {
  // La ligne simple tronquait déjà (lot 65) ; la ligne agrégée (le `summary`
  // du repli) doit le faire AUSSI maintenant que la place est comptée.
  const simple = CSS.match(/button\.op-ligne\{([^}]*)\}/);
  assert.ok(simple);
  assert.match(simple[1], /text-overflow:\s*ellipsis/);

  const agregee = CSS.match(/summary\.op-ligne\{([^}]*)\}/);
  assert.ok(agregee);
  assert.match(agregee[1], /overflow:\s*hidden/);
  assert.match(agregee[1], /text-overflow:\s*ellipsis/);
});

test('sur mobile, la pastille reste en ligne et le détail se fixe sur la largeur de l\'écran', () => {
  // Plusieurs blocs « max-width:639px » existent : on cherche celui de
  // l'en-tête, reconnaissable à la règle mobile de la liste dépliée.
  const blocs = [];
  let depuis = 0;
  for (;;) {
    const i = CSS.indexOf('@media (max-width:639px)', depuis);
    if (i === -1) break;
    blocs.push(CSS.slice(i, CSS.indexOf('\n}', i) + 2));
    depuis = i + 1;
  }
  assert.ok(blocs.length > 0);
  // Le détail déplié ne peut pas rester centré sous une pastille collée au
  // bord : il se fixe sur la largeur de l'écran, sous l'en-tête.
  const liste = blocs.map((b) => b.match(/\.op-liste\{([^}]*)\}/)).find(Boolean);
  assert.ok(liste, 'la liste dépliée a sa règle mobile');
  assert.match(liste[1], /position:\s*fixed/);
  assert.match(liste[1], /transform:\s*none/);
});

// ---------------------------------------------------------------------------
// Phase C — l'onglet à juger : jamais un onglet vide
// ---------------------------------------------------------------------------

test('un onglet vide se reconnaît — about:blank et les écrans internes du navigateur', () => {
  assert.equal(remoteBrowser.estOngletVide('about:blank'), true);
  assert.equal(remoteBrowser.estOngletVide('about:srcdoc'), true);
  assert.equal(remoteBrowser.estOngletVide('chrome://new-tab-page/'), true);
  assert.equal(remoteBrowser.estOngletVide(''), true);
  assert.equal(remoteBrowser.estOngletVide('https://exemple.test/compte'), false);
  // Un chemin qui CONTIENT « about » n'est pas un onglet vide.
  assert.equal(remoteBrowser.estOngletVide('https://exemple.test/about'), false);
});

/** Un onglet factice : juste une adresse et un état de fermeture. */
function onglet(url, { fermee = false } = {}) {
  return { url: () => url, isClosed: () => fermee };
}

test('un onglet vide n\'est jamais évalué quand il existe autre chose — le cas Electro Dépôt', () => {
  const compte = onglet('https://boutique.exemple.test/customer/account/');
  const vide = onglet('about:blank'); // le dernier-né, resté vide
  // AVANT le lot 70, « le dernier onglet vivant » rendait `vide` : c'est lui
  // qui était jugé, et la fenêtre du 08/09/2026 a été abandonnée en 45 s.
  assert.equal(remoteBrowser.choisirOnglet([compte, vide]), compte);
  // Le vide n'est choisi que s'il n'existe RIEN d'autre.
  assert.equal(remoteBrowser.choisirOnglet([vide]), vide);
  assert.equal(remoteBrowser.choisirOnglet([]), null);
});

test('avec une adresse de référence, l\'onglet du SITE est choisi parmi plusieurs — le plus récent', () => {
  const controle = 'https://boutique.exemple.test/customer/account/#/order';
  const ancien = onglet('https://boutique.exemple.test/customer/account/login/');
  const recent = onglet('https://boutique.exemple.test/customer/account/#/order');
  const ailleurs = onglet('https://idp.exemple.net/authorize'); // plus récent, autre site
  const vide = onglet('about:blank');

  assert.equal(remoteBrowser.choisirOnglet([ancien, recent, ailleurs, vide], controle), recent);
  // Fermé n'est pas vivant : un onglet clos ne compte plus.
  assert.equal(
    remoteBrowser.choisirOnglet([ancien, onglet(controle, { fermee: true })], controle),
    ancien
  );
});

test('sans référence, la frappe vise le dernier onglet NON VIDE — la fenêtre d\'un fournisseur d\'identité', () => {
  // La raison d'être du « dernier onglet » : une fenêtre surgissante Google
  // vit sur un AUTRE domaine, et c'est ELLE que l'utilisateur remplit. La
  // préférence de domaine ne vaut que pour le verdict, jamais pour la frappe.
  const site = onglet('https://boutique.exemple.test/connexion');
  const idp = onglet('https://idp.exemple.net/authorize');
  const vide = onglet('about:blank');
  assert.equal(remoteBrowser.choisirOnglet([site, idp, vide]), idp);
});

// ---------------------------------------------------------------------------
// Phase C bis — la boucle de surveillance referme l'onglet resté vide
// (doubles de système : la recette de test/lot68-preuve-par-renvoi.test.js)
// ---------------------------------------------------------------------------

function fakeFs({ present = [] } = {}) {
  const existants = new Set(present);
  return {
    existants,
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => {
      if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`);
    },
    readdirSync: () => {
      throw new Error('ENOENT');
    },
    readFileSync: () => {
      throw new Error('ENOENT');
    },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => existants.delete(String(p)),
  };
}

function fakeSpawn(fsDouble) {
  return (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fsDouble.existants.add(`/tmp/.X11-unix/X${display}`);
    }
    return {
      command,
      args: args.map(String),
      stdout: { resume: () => {} },
      stderr: { resume: () => {} },
      on: () => {},
      kill: () => {},
    };
  };
}

/** Une page de fenêtre pilotable : adresse mutable, fermeture comptée. */
function pagePilotable(url) {
  let adresse = url;
  let fermee = false;
  return {
    url: () => adresse,
    changerAdresse: (u) => {
      adresse = u;
    },
    isClosed: () => fermee,
    close: async () => {
      fermee = true;
    },
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      count: async () => 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async () => null,
  };
}

function managerAOnglets({ onglets, delaiOngletVideMs }) {
  const journal = [];
  const fsDouble = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const manager = remoteBrowser.createManager({
    fs: fsDouble,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: fakeSpawn(fsDouble),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({
      page: onglets[0],
      context: { pages: () => onglets },
      storageState: async () => ({ cookies: [] }),
      close: async () => {},
    }),
    timeoutMs: 5_000,
    pollMs: 4,
    delaiOngletVideMs,
  });
  return { manager, journal };
}

/** Attend qu'une condition devienne vraie, sans jamais dépasser une seconde. */
async function attendre(condition) {
  const limite = Date.now() + 1_000;
  while (!condition() && Date.now() < limite) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

test('l\'onglet resté vide est refermé par la surveillance — la main revient au site', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion');
  const vide = pagePilotable('about:blank');
  const { manager, journal } = managerAOnglets({
    onglets: [origine, vide],
    delaiOngletVideMs: 15,
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    assert.equal(
      await attendre(() => vide.isClosed()),
      true,
      'l\'onglet resté vide doit être refermé après le sursis'
    );
    assert.equal(origine.isClosed(), false, 'la page du site, elle, ne se referme jamais');
    assert.ok(
      journal.some((l) => /resté vide.*refermé/.test(l.message)),
      'la fermeture est dite au journal'
    );
  } finally {
    manager.stop(1, 'exemple');
  }
});

test('une fenêtre surgissante qui REÇOIT son adresse dans le sursis n\'est pas touchée', async () => {
  const origine = pagePilotable('https://boutique.exemple.test/connexion');
  const surgissante = pagePilotable('about:blank');
  const { manager } = managerAOnglets({
    onglets: [origine, surgissante],
    delaiOngletVideMs: 300, // large : l'adresse arrive AVANT l'échéance
  });

  await manager.start({
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://boutique.exemple.test/connexion',
    marker: '',
  });
  try {
    // Le temps d'un ou deux tours de boucle, puis l'adresse OAuth arrive —
    // c'est le parcours légitime qu'un `close()` immédiat casserait.
    await new Promise((resolve) => setTimeout(resolve, 30));
    surgissante.changerAdresse('https://idp.exemple.net/authorize?client_id=x');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(surgissante.isClosed(), false, 'une fenêtre devenue réelle ne se referme pas');
  } finally {
    manager.stop(1, 'exemple');
  }
});

// ---------------------------------------------------------------------------
// Phase D — Airbnb : la preuve ne se lit plus sur une page servie aux anonymes
// ---------------------------------------------------------------------------

const MANIFESTE_AIRBNB = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'available', 'airbnb', 'manifest.json'),
    'utf8'
  )
);

test('la preuve Airbnb ne confirme pas une page servie à un anonyme', () => {
  const remote = MANIFESTE_AIRBNB.remoteLogin;
  // Mesuré le 08/09/2026 depuis le CT : your-payments répond 200 aux
  // visiteurs SANS session, sans redirection — cette page ne peut donc
  // JAMAIS prouver une session, et deux enregistrements valides ont été
  // refusés sur elle ce jour-là. Ce test tombe si la page de contrôle y revient.
  assert.equal(/your-payments/.test(remote.verifyUrl), false,
    'your-payments est servie aux anonymes : elle ne prouve rien');
  assert.equal(remote.verifyUrl, 'https://www.airbnb.fr/trips');
  // Le renvoi des anonymes est MESURÉ (302 vers /login?redirect_url=%2Ftrips,
  // témoin inexistant renvoyé vers /404 et pas vers la connexion) : déclaré.
  assert.equal(remote.renvoiAnonyme, 'connexion');
});

test('le renvoi anonyme mesuré d\'Airbnb est bien un écran d\'authentification', () => {
  // La forme EXACTE mesurée le 08/09/2026 : une session morte rejouée sur
  // /trips atterrira ici — et ce doit être un REFUS net (motif du lot 13),
  // jamais une « preuve par renvoi » (l'adresse reste sur le même site).
  assert.equal(
    preuve.estUrlAuthentification('https://www.airbnb.fr/login?redirect_url=%2Ftrips'),
    true
  );
  assert.equal(
    preuve.memeSite('https://www.airbnb.fr/login?redirect_url=%2Ftrips', 'https://www.airbnb.fr/trips'),
    true
  );
  // Et rester sur /trips, fragment ou pas, est une adresse qui « tient ».
  assert.equal(preuve.adresseTenue('https://www.airbnb.fr/trips', 'https://www.airbnb.fr/trips'), true);
});

// ---------------------------------------------------------------------------
// Phase B — la déclaration `precision` : la carte dit la limite du service
// (recette de test/lot42-message-historique.test.js : une sonde, le vrai
// planificateur, la vraie base de test)
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot70';

const PHRASE_PRECISION =
  '3 voyage(s) sur 5 ne proposent leur justificatif que par envoi d\'e-mail — '
  + 'crabe ne déclenche jamais cet envoi à votre place.';

const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const mode = config.mode || 'rien-et-precision';
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 5 });
    if (mode === 'document-et-precision') {
      return {
        invoices: [{ remoteId: 'p1', filename: 'sonde-lot70_2026-01_p1.pdf',
                     issuedOn: '2026-01-05', buffer: Buffer.from('%PDF-1.4 sonde') }],
        precision: ${JSON.stringify(PHRASE_PRECISION)},
      };
    }
    if (mode === 'sans-precision') return { invoices: [] };
    return { invoices: [], precision: ${JSON.stringify(PHRASE_PRECISION)} };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 70',
  category: 'energie',
  color: '#123456',
  letters: 'SP',
  description: 'Sonde de test du lot 70 : la limite déclarée s\'ajoute au message de la carte.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'mode', label: 'Mode de la sonde', type: 'text', required: false },
  ],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

let dossier;
let user;

async function executer(mode) {
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', mode });
  return scheduler.runForUser(user.id, ID_SONDE, 'manual');
}

function derniereExecution() {
  return db
    .get()
    .prepare(
      `SELECT success, invoice_count, message FROM run_logs
        WHERE connector_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE, user.id);
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({
    username: 'lot70',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, user.id);

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot70-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  registry.load(); // on remet le vrai registre pour ne rien laisser derrière
  helpers.teardown();
});

test('« Aucune nouvelle facture » porte la limite déclarée — le cas SNCF du 08/09', async () => {
  const resultat = await executer('rien-et-precision');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.success, 1, 'une limite du service n\'est pas une panne');
  assert.equal(ligne.message, `Aucune nouvelle facture ${PHRASE_PRECISION}`);
  // Ce que la carte disait le 08/09/2026, et qui se lisait « il en manque » :
  assert.notEqual(ligne.message, 'Aucune nouvelle facture');
});

test('un document descendu ne fait PAS taire la limite : elle vaut aussi ce jour-là', async () => {
  const resultat = await executer('document-et-precision');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.invoice_count, 1);
  assert.equal(ligne.message, `1 facture récupérée ${PHRASE_PRECISION}`);
});

test('sans déclaration, le message générique reste nu (inchangé)', async () => {
  const resultat = await executer('sans-precision');
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(derniereExecution().message, 'Aucune nouvelle facture');
});
