'use strict';

/**
 * Rendu réel des écrans d'administration, sans navigateur.
 *
 * Les fonctions de `web/admin.js` sont exécutées telles quelles dans un bac à
 * sable muni d'un DOM minimal et d'un `api()` de fixtures. On ne juge pas
 * l'apparence — impossible ici — mais on attrape ce qui casse pour de bon :
 * une variable oubliée, une donnée absente de la réponse serveur, un gabarit
 * mal fermé.
 *
 * Ce que ça ne remplace pas : la relecture à l'œil des colonnes, des largeurs
 * et des deux thèmes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { nestingErrors } = require('./html-nesting');
const { FIXTURES } = require('./fixtures-front');
const responsive = require('./responsive');

const WEB = path.resolve(__dirname, '..', 'web');
const CSS_RULES = responsive.parseCss(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'));

/**
 * Les cinq points de rupture du lot 3, avec la place réellement disponible
 * pour le contenu d'un écran.
 *
 *   gutter  — marge horizontale de `.content` à cette largeur ;
 *   sidebar — largeur prise par la colonne de navigation des Paramètres
 *             (220 px + 20 de marge + 32 de gouttière). Sous 1024 px, cette
 *             colonne devient un panneau glissant : elle ne prend plus de
 *             place, d'où 0.
 */
const BREAKPOINTS = [
  { name: 'téléphone 360', width: 360, gutter: 14, sidebar: 0 },
  { name: 'grand téléphone 640', width: 640, gutter: 16, sidebar: 0 },
  { name: 'tablette 768', width: 768, gutter: 28, sidebar: 0 },
  { name: 'ordinateur 1024', width: 1024, gutter: 28, sidebar: 272 },
  { name: 'grand écran 1440', width: 1440, gutter: 28, sidebar: 272 },
];

/** Place offerte au contenu d'un écran de Paramètres / Profil. */
function contentWidth(bp, { inSettings = false } = {}) {
  // Lot 4 : plus de colonne centrée, `.content` occupe toute la fenêtre.
  const usable = bp.width - 2 * bp.gutter;
  return usable - (inSettings ? bp.sidebar : 0);
}

/**
 * Vérifie qu'un fragment rendu ne déborde à aucun des cinq points de rupture.
 *
 * Ce que ça prouve : aucun élément n'exige une largeur en pixels supérieure à
 * la place disponible. Ce que ça ne prouve pas : que la mise en page est jolie
 * ou lisible — aucun navigateur n'est disponible ici (voir test/responsive.js).
 */
function assertFits(html, { label, inSettings = false, widthFor = null }) {
  // Un conteneur vide passerait tous les points de rupture sans rien prouver.
  assert.ok(html && html.trim().length > 40, `${label} : rien à mesurer, rendu vide`);

  for (const bp of BREAKPOINTS) {
    const available = widthFor ? widthFor(bp) : contentWidth(bp, { inSettings });
    const findings = responsive.findOverflows(html, {
      viewport: bp.width,
      available,
      rules: CSS_RULES,
    });
    assert.deepEqual(
      findings.map((f) => f.reason),
      [],
      `${label} — débordement à ${bp.name} px`
    );
  }
}

// ---------------------------------------------------------------------------
// DOM minimal
// ---------------------------------------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    // Le vrai `classList` accepte plusieurs classes d'un coup — et le lot 6
    // s'en sert (`classList.add('show', 'rb-open')`). Un double qui n'en prend
    // qu'une laissait passer un écran à moitié configuré.
    add: (...classes) => classes.forEach((c) => set.add(c)),
    remove: (...classes) => classes.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const state = on === undefined ? !set.has(c) : !!on;
      if (state) set.add(c);
      else set.delete(c);
      return state;
    },
    values: () => [...set],
  };
}

function makeElement(id) {
  return {
    id,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    disabled: false,
    selectionStart: 0,
    selectionEnd: 0,
    style: {},
    dataset: {},
    options: [],
    classList: makeClassList(),
    getAttribute: () => null,
    setAttribute() {},
    addEventListener() {},
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/**
 * Bac à sable exécutant les VRAIS fichiers du front (fmt.js, app.js,
 * admin.js) sur un DOM minimal. Seuls le réseau et les notifications sont
 * remplacés, après chargement : `api` et `showToast` sont des déclarations de
 * fonction, donc des liaisons globales réassignables.
 */
function makeSandbox(fixtures) {
  const elements = new Map();
  const calls = { toasts: [], api: [] };

  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  /**
   * Écouteurs posés sur le document. Le lot 7 en pose un (« paste ») qui fait
   * traverser le presse-papiers du poste jusqu'au navigateur distant : un
   * `addEventListener` qui ne fait rien laisserait ce pont invérifiable.
   */
  const documentListeners = new Map();

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    // Le navigateur distant interroge l'état et fait avancer son compte à
    // rebours à la seconde : sans ces deux-là, la modale du lot 6 lèverait
    // une ReferenceError dès son ouverture.
    setInterval,
    clearInterval,
    URLSearchParams,
    URL,
    TextEncoder,
    document: {
      getElementById: (id) => element(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: (nom, fn) => documentListeners.set(nom, fn),
      createElement: () => makeElement('créé'),
      body: makeElement('body'),
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { origin: 'http://crabe.local', href: 'http://crabe.local/' },
    navigator: { userAgent: 'test' },
    confirm: () => true,
    alert() {},
    fetch: async () => {
      throw new Error('aucun appel réseau ne doit sortir du bac à sable');
    },
    __fixture: async (url) => {
      calls.api.push(url);
      // La fixture la plus spécifique gagne : /tickets/1 avant /tickets.
      const key = Object.keys(fixtures)
        .filter((k) => String(url).startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`Aucune fixture pour ${url}`);
      // Structure clonée : un renderer ne doit pas muter la réponse partagée.
      return JSON.parse(JSON.stringify(fixtures[key]));
    },
    __toast: (m) => calls.toasts.push(m),
    /** Déclenche un événement de document, comme le ferait un vrai navigateur. */
    __paste: (event) => documentListeners.get('paste')?.(event),
    /**
     * Déclenche une frappe sur le document.
     *
     * Le lot 8 pose deux écouteurs de plus (« keydown », « keyup ») pour
     * détourner le pavé numérique, qui n'arrivait pas jusqu'au site. Sans ce
     * point d'entrée, la conversion serait vérifiable mais son branchement ne
     * le serait pas — or c'est le branchement qui manquait.
     */
    __touche: (nom, event) => documentListeners.get(nom)?.(event),
    /** La découverte de référence, pour les tests qui en font varier la taille. */
    FIXTURE_DECOUVERTE: fixtures['/connectors/free-mobile/discover'],
    /** L'écran « Mes documents » de référence, pour en faire varier l'état. */
    FIXTURE_DOCUMENTS: fixtures['/documents'],
    /** L'accueil de référence, pour y ajouter une destination secondaire. */
    FIXTURE_HOME: fixtures['/home'],
    /** Les préférences de référence, pour en faire varier une seule. */
    FIXTURE_PREFS: fixtures['/users/me/preferences'],
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const file of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js', 'admin.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), context, { filename: file });
  }

  // Réseau et notifications neutralisés, session posée avec tous les droits.
  vm.runInContext(
    `api = (path) => __fixture(path);
     showToast = (message) => __toast(message);
     state.me = { id: 1, username: 'camille', permissions: ['security.manage','users.manage','apps.manage','storage.manage','logs.read','support.reply','roles.manage','schedules.manage'] };`,
    context,
    { filename: 'bac-a-sable' }
  );

  return {
    context,
    elements,
    calls,
    html: (id) => element(id).innerHTML,
    run: (expression) => vm.runInContext(expression, context),
  };
}

/** Un écran rendu : pas d'exception, du HTML, et des balises bien fermées. */
function assertScreen(html, { contains = [], label }) {
  assert.ok(html && html.trim().length > 40, `${label} : rendu vide`);
  assert.deepEqual(nestingErrors(html), [], `${label} : balises mal imbriquées`);
  assert.equal(html.includes('undefined'), false, `${label} : « undefined » dans le rendu`);
  assert.equal(html.includes('[object Object]'), false, `${label} : objet affiché brut`);
  for (const needle of contains) {
    assert.ok(html.includes(needle), `${label} : « ${needle} » attendu dans le rendu`);
  }
}

/**
 * La tuile d'un service, isolée du reste de la grille.
 *
 * Découpée sur les ouvertures de `<div class="card` : les tuiles sont des
 * frères, jamais imbriqués, et `assertScreen` a déjà vérifié l'imbrication
 * générale. Ça suffit à répondre à la seule question qui compte ici — cette
 * tuile-LÀ porte-t-elle un clic ?
 */
function extraireCarte(html, nom, classe = 'card') {
  // Sur la classe SUIVIE D'UNE FRONTIÈRE — espace ou guillemet fermant. Sans
  // elle, la découpe tomberait aussi sur `card-name`, `card-desc`,
  // `app-card-head`… et rendrait une demi-tuile dans laquelle l'absence d'un
  // bouton ne prouverait rien.
  //
  // Le guillemet fermant compte autant que l'espace depuis le lot 14 : la
  // tuile d'application n'a plus de classe conditionnelle (le badge « logo
  // manquant » est parti dans le gestionnaire de logos), et s'écrit donc
  // `class="app-card"` tout court. Ne chercher que l'espace rendait alors la
  // page ENTIÈRE comme une seule tuile — et tous les boutons de toutes les
  // cartes avec elle.
  const morceaux = html.split(new RegExp(`<div class="${classe}(?=["\\s])`));
  const trouve = morceaux.find((m) => m.includes(`>${nom}<`));
  assert.ok(trouve, `tuile « ${nom} » introuvable dans la grille`);
  return trouve;
}

// ---------------------------------------------------------------------------
// Écrans réorganisés par le lot 2
// ---------------------------------------------------------------------------

test('Utilisateurs → Avatars : l\'interrupteur Gravatar et sa justification', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderAvatarSettings()');

  assertScreen(app.html('users-avatars-content'), {
    label: 'Avatars',
    contains: ['Autoriser Gravatar', 'toggleGravatar(true)', 'service tiers'],
  });
});

test('Utilisateurs : trois onglets, un seul visible à la fois', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderUsersPage()');

  const visible = (id) => app.run(`$("${id}").style.display`);
  assert.equal(visible('users-tab-comptes'), '', 'Comptes est l\'onglet par défaut');
  assert.equal(visible('users-tab-suppressions'), 'none');
  assert.equal(visible('users-tab-avatars'), 'none');

  assertScreen(app.html('users-list'), {
    label: 'Utilisateurs (comptes)',
    contains: [
      'camille',
      'openEditUserModal(',
      // Verrou administrateur de l'accueil : l'état est lisible sur la ligne,
      // et l'action est dans le menu, compte par compte.
      // Le libellé est échappé au rendu : on cherche la partie sans apostrophe.
      'Accueil verrouillé',
      'toggleHomeCustomization(1)',
      'Autoriser la personnalisation de l&#39;accueil',
      'Interdire la personnalisation de l&#39;accueil',
    ],
  });

  // La pastille annonce la demande de suppression en attente.
  assert.equal(app.run('$("users-deletion-count").textContent'), 1);
  assert.equal(app.run('$("users-deletion-count").style.display'), 'inline-flex');

  app.run('setUsersTab("suppressions")');
  assert.equal(visible('users-tab-comptes'), 'none');
  assert.equal(visible('users-tab-suppressions'), '');
  assertScreen(app.html('deletion-requests'), {
    label: 'Utilisateurs (suppressions)',
    contains: ['partante', 'sendExportZip(2)', 'revokeForDeletion(2)'],
  });

  app.run('setUsersTab("avatars")');
  assert.equal(visible('users-tab-suppressions'), 'none');
  assert.equal(visible('users-tab-avatars'), '');
});

test('Applications : les deux vues rendent les mêmes actions', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderApps()');

  const cartes = app.html('apps-list');
  assertScreen(cartes, {
    label: 'Applications (cartes)',
    contains: ['app-card', 'Free Internet', 'Gérer l\'accès', 'toggleMaintenance'],
  });

  app.run('setAppsView("list")');
  const liste = app.html('apps-list');
  assertScreen(liste, {
    label: 'Applications (liste)',
    contains: ['data-table wide', 'Free Internet', 'Gérer l\'accès', 'toggleMaintenance'],
  });

  // Aucune action ne doit disparaître en changeant de vue.
  for (const action of ['testApp(', 'openAccessModal(', 'rejectApp(', 'moveAppCategory(']) {
    assert.ok(cartes.includes(action), `vue cartes : ${action} manquant`);
    assert.ok(liste.includes(action), `vue liste : ${action} manquant`);
  }
  // La candidature en attente garde ses boutons dans les deux vues.
  assert.ok(cartes.includes('approveApp('), 'vue cartes : approbation manquante');
  assert.ok(liste.includes('approveApp('), 'vue liste : approbation manquante');
});


/**
 * Lot 9, §4 — le dépannage est passé du côté de l'administration.
 *
 * Le dépôt d'un fichier de connexion, et la ligne de commande qui l'expliquait,
 * vivaient sous « Options avancées » de la fiche utilisateur. Le geste reste
 * possible — il sauve les cas où le navigateur distant ne peut pas s'ouvrir —
 * mais il n'est plus proposé à quelqu'un qui n'a jamais ouvert un terminal.
 */
test('Applications : le dépannage n\'est offert que là où une connexion s\'enregistre', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderApps()');

  // Aucun des deux connecteurs de la fixture ne se connecte par session : pas
  // de bouton, et c'est voulu — on ne propose pas un geste sans objet.
  assert.equal(app.html('apps-list').includes('openSessionModal('), false);

  app.run(`
    admin.apps.find((c) => c.id === 'free').fields = [
      { key: 'session', label: 'Connexion à Free', type: 'session' },
    ];
    renderAppsList();
  `);
  const liste = app.html('apps-list');
  assert.ok(liste.includes("openSessionModal('free')"), 'le bouton apparaît sur ce connecteur-là');
  assert.ok(liste.includes('Dépannage'));

  await app.run('openSessionModal("free")');

  // Le compte concerné se choisit, et son état de connexion se lit sans que le
  // contenu soit jamais montré.
  const comptes = app.html('session-account');
  assert.ok(comptes.includes('camille'), 'les comptes qui ont installé le service');
  assert.match(comptes, /valable jusqu.{0,6}au 05\/02\/2027/, 'avec l\'échéance de leur connexion');
  assert.ok(comptes.includes('aucune connexion enregistrée'), 'ou son absence');
  assert.equal(comptes.includes('cookieCount'), false, 'aucun détail interne');

  // Le geste reste entier : fichier ou collage.
  assert.ok(app.elements.get('session-file'), 'le dépôt par fichier est là');
  assert.ok(app.elements.get('session-paste'), 'le collage aussi');
  assert.match(
    app.run('$("session-intro").textContent'),
    /Ne déposez une connexion ici que si/,
    'et l\'écran dit que ce n\'est pas le chemin normal'
  );
});
// ---------------------------------------------------------------------------
// Lot 8 — Applications → Logos
// ---------------------------------------------------------------------------

test('Logos : chaque connecteur, son état et ses trois gestes', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');
  // La liste reste disponible pour qui veut comparer beaucoup d'éléments ;
  // les cartes sont le défaut depuis le lot 10 (test dédié plus bas).
  app.run('setLogosView("list")');

  const html = app.html('logos-list');
  assertScreen(html, {
    label: 'Applications → Logos',
    contains: [
      'Free Internet', 'Free Mobile', 'OVH',
      // L'image réelle, servie par crabe.
      '/api/connectors/logos/free.png',
      // La pastille de repli reste TOUJOURS dans le document, sous l'image.
      'class="badge-logo logo-preview"',
      'fetchOneLogo(', 'chooseLogoFile(', 'deleteLogo(',
    ],
  });

  // Un logo envoyé à la main se voit : c'est la seule distinction qui change un
  // comportement (rien ne l'écrase).
  const blocs = html.split('<div class="logo-row');
  const ligne = (id) => blocs.find((b) => b.includes(`logo-row-${id}`));
  assert.ok(ligne('free-mobile').includes('manuel'), 'l\'envoi manuel est signalé');
  assert.equal(ligne('free').includes('>manuel<'), false);

  // Un connecteur sans logo garde sa pastille, et n'offre pas « Supprimer ».
  assert.equal(ligne('ovh').includes('<img'), false, 'aucune image pour OVH');
  assert.ok(ligne('ovh').includes('logo manquant'));
  assert.equal(ligne('ovh').includes('deleteLogo('), false, 'rien à supprimer');
  // Sans site déclaré, « Récupérer » est grisé AVEC son explication.
  assert.ok(ligne('ovh').includes('disabled'));
  assert.ok(ligne('ovh').includes('aucun site'));

  // La note dit ce que la cascade s'autorise, une fois pour toutes.
  const note = app.run('$("logos-note").textContent');
  assert.match(note, /4 logo\(s\) en place, 2 manquant/);
  assert.match(note, /jamais chez un tiers/);
});

/**
 * Lot 10 — le manque se voit au premier regard.
 *
 * « 8 logos en place, 6 manquants » ne dit pas LESQUELS : il fallait comparer
 * les lignes une à une. Le liseré rouge le dit, et sa raison avec.
 */
test('Logos : un logo manquant porte un liseré rouge — et jamais autrement', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');

  // Les cartes sont le défaut : aucun réglage à trouver pour y arriver.
  assert.equal(app.run('viewMode("logos")'), 'cards');
  const html = app.html('logos-list');
  assert.ok(html.includes('logo-card'), 'des cartes, pas des lignes');

  // L'espace compte : `logo-card-head` et `logo-card-state` commencent par la
  // même chaîne, et couperaient les cartes en morceaux.
  const cartes = html.split('<div class="logo-card ');
  const carte = (id) => cartes.find((b) => b.includes(`logo-row-${id}`));

  // OVH n'a pas de logo : liseré, libellé, et sa raison.
  assert.ok(carte('ovh').includes('missing'), 'liseré rouge sur un logo absent');
  assert.ok(carte('ovh').includes('logo manquant'));
  assert.match(carte('ovh'), /aucun site/i, 'la raison exacte, au survol');

  // Free a le sien : AUCUN liseré. Le rouge ne doit signaler qu'un vrai manque.
  assert.equal(carte('free').includes('missing'), false);
  assert.equal(carte('free').includes('logo manquant'), false);

  // Le stockage local porte une icône livrée avec crabe : ce n'est pas un manque.
  const local = carte('destination-local');
  assert.equal(local.includes('missing'), false, 'une icône interne n\'est pas un manque');
  assert.ok(local.includes('icône interne'));
});

test('Logos : la raison d\'un échec survit à la fermeture de l\'écran', async () => {
  const app = makeSandbox(FIXTURES);
  // Le serveur garde le dernier échec : sans lui, il fallait relancer une
  // récupération pour relire pourquoi Ameli et Engie résistent.
  app.run(`
    admin.logos = [{
      id: 'ameli', name: 'Ameli', site: 'ameli.fr', color: '#0c419a', letters: 'AM',
      kind: 'connector', logo: null, source: null, bytes: 0,
      lastError: 'aucune image utilisable trouvée sur le site',
      lastErrorAt: '2026-08-10T09:00:00.000Z',
    }];
  `);
  app.run('renderLogosList()');

  const html = app.html('logos-list');
  assert.ok(html.includes('missing'));
  assert.ok(html.includes('aucune image utilisable trouvée sur le site'), html);
});

test('Logos : le tri porte sur la donnée, et se mémorise', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');
  app.run('setLogosView("list")');

  // Par défaut, l'ordre alphabétique : c'est un catalogue, on y cherche un nom.
  assert.equal(app.run('JSON.stringify(sortOf("logos", LOGOS_TRI_DEFAUT))'), '{"key":"name","dir":"asc"}');

  // Une taille se trie NUMÉRIQUEMENT, même écrite « 99,3 Ko » : c'est la
  // donnée qui est comparée, jamais la chaîne affichée.
  app.run(`admin.logos = [
    { id: 'a', name: 'A', kind: 'connector', logo: 'x', bytes: 9000, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', name: 'B', kind: 'connector', logo: 'x', bytes: 101000, fetchedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'c', name: 'C', kind: 'connector', logo: 'x', bytes: 20000, fetchedAt: '2026-03-01T00:00:00.000Z' },
  ]`);
  app.run('sortLogos("bytes")');
  assert.equal(
    app.run('JSON.stringify(trierLogos(admin.logos).map((c) => c.id))'),
    JSON.stringify(['b', 'c', 'a']),
    'le plus gros d\'abord, et 101 ko passe après 9 ko en ordre croissant seulement'
  );

  // Une date se trie chronologiquement, même écrite « il y a 3 h ».
  app.run('sortLogos("fetchedAt")');
  assert.equal(
    app.run('JSON.stringify(trierLogos(admin.logos).map((c) => c.id))'),
    JSON.stringify(['b', 'c', 'a'])
  );

  // Et le choix part sur le compte, pas dans le navigateur.
  assert.equal(app.run('prefs.values["sort.logos"]'), 'fetchedAt:desc');
  assert.ok(app.calls.api.includes('/users/me/preferences'));
});

/**
 * Lot 9 — les destinations de stockage rejoignent le même écran.
 *
 * Proton Drive et pCloud sont des services comme les autres : un nom, un site,
 * une pastille. Le stockage local est le cas à part — aucun site, donc
 * aucune récupération possible et une icône livrée avec crabe.
 */
test('Logos : les destinations de stockage sont sur le même écran, dans leur groupe', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');
  app.run('setLogosView("list")');

  const html = app.html('logos-list');
  assertScreen(html, {
    label: 'Applications → Logos (destinations)',
    contains: ['Applications', 'Destinations de stockage', 'Proton Drive', 'pCloud', 'Stockage local'],
  });

  // Deux groupes, et les destinations après les applications.
  assert.equal((html.match(/logo-group-title/g) || []).length, 2);
  assert.ok(html.indexOf('Destinations de stockage') > html.indexOf('Free Internet'));

  const blocs = html.split('<div class="logo-row');
  const ligne = (id) => blocs.find((b) => b.includes(`logo-row-${id}`));

  // Proton Drive : un logo récupéré sur son site, comme un connecteur.
  assert.ok(ligne('destination-proton').includes('/api/connectors/logos/destination-proton.png'));
  assert.ok(ligne('destination-proton').includes('proton.me'));

  // Le stockage local : icône interne, aucune récupération possible, rien à supprimer.
  const local = ligne('destination-local');
  assert.ok(local.includes('/stockage-local.svg'), 'l\'icône interne s\'affiche');
  assert.ok(local.includes('logo-img interne'), 'et sans le carré blanc d\'un logo de marque');
  assert.ok(local.includes('Icône interne'));
  assert.ok(local.includes('disabled'), '« Récupérer » est grisé : aucun site');
  assert.equal(local.includes('deleteLogo('), false, 'une icône interne ne se supprime pas');
});

test('Logos : la progression se compte, et le compte rendu nomme chaque échec', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');

  // Deux connecteurs à récupérer : l'un marche, l'autre non.
  app.run(`
    api = (path, options) => {
      if (String(path).endsWith('/logo') && options?.method === 'POST') {
        return path.includes('free-mobile')
          ? Promise.resolve({ ok: false, message: 'site injoignable' })
          : Promise.resolve({ ok: true });
      }
      return __fixture(path, options);
    };
    admin.logos = [
      { id: 'free', name: 'Free Internet', site: 'free.fr', logo: null },
      { id: 'free-mobile', name: 'Free Mobile', site: 'mobile.free.fr', logo: null },
    ];
  `);

  // La pause d'une seconde entre deux requêtes est réelle en production ;
  // ici elle n'ajouterait que de l'attente (voir web/admin.js, logosEnCours).
  app.run('logosEnCours.pauseMs = 0');
  await app.run('fetchMissingLogos()');

  const rapport = app.html('logos-report');
  assert.ok(rapport.includes('1 logo(s) récupéré(s)'), rapport);
  assert.ok(rapport.includes('1 en échec'));
  // Chaque échec porte SA raison : « 1 échec » sans motif n'apprend rien.
  assert.ok(rapport.includes('Free Mobile'));
  assert.ok(rapport.includes('site injoignable'));

  // L'indicateur a bien compté, puis s'est retiré.
  assert.match(app.run('$("logos-progress-text").textContent'), /2 sur 2/);
  assert.equal(app.run('$("logos-progress").style.display'), 'none');
});

test('Logos : les requêtes sont espacées, et la récupération s\'arrête à la demande', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');

  // Une seconde entre deux requêtes : quatre-vingt-cinq appels en rafale depuis
  // une seule adresse finissent par être mal reçus.
  assert.equal(app.run('LOGOS_PAUSE_MS'), 1000);
  assert.equal(app.run('logosEnCours.pauseMs'), 1000);

  app.run(`
    logosEnCours.pauseMs = 0;
    api = (path, options) => {
      if (String(path).endsWith('/logo') && options?.method === 'POST') {
        // Le deuxième sujet déclenche l'arrêt : la boucle doit finir CELUI-LÀ,
        // puis rendre la main sans attaquer les suivants.
        if (path.includes('deux')) stopLogoFetch();
        return Promise.resolve({ ok: true });
      }
      return __fixture(path, options);
    };
    admin.logos = [
      { id: 'un', name: 'Un', site: 'un.fr', logo: null },
      { id: 'deux', name: 'Deux', site: 'deux.fr', logo: null },
      { id: 'trois', name: 'Trois', site: 'trois.fr', logo: null },
      { id: 'quatre', name: 'Quatre', site: 'quatre.fr', logo: null },
    ];
  `);

  await app.run('fetchMissingLogos()');

  const rapport = app.html('logos-report');
  assert.ok(rapport.includes('Arrêté à la demande'), rapport);
  assert.ok(rapport.includes('2 sur 4'), 'le compte traité est dit');
  assert.ok(rapport.includes('2 logo(s) récupéré(s)'));
  // Ce qui reste se rattrape : c'est le sens du « manquants ».
  assert.ok(rapport.includes('Relancer reprendra les logos encore manquants'));

  // L'état est propre : le bouton d'arrêt ne reste pas armé.
  assert.equal(app.run('logosEnCours.actif'), false);
  assert.equal(app.run('$("logos-progress").style.display'), 'none');
});

test('Logos : « manquants » ne touche pas à ceux déjà présents', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');

  const appels = [];
  app.run(`
    appelsLogo = [];
    api = (path, options) => {
      if (String(path).endsWith('/logo') && options?.method === 'POST') {
        appelsLogo.push({ path, force: options.body?.force });
        return Promise.resolve({ ok: true });
      }
      return __fixture(path, options);
    };
  `);

  // La pause d'une seconde entre deux requêtes est réelle en production ;
  // ici elle n'ajouterait que de l'attente (voir web/admin.js, logosEnCours).
  app.run('logosEnCours.pauseMs = 0');
  await app.run('fetchMissingLogos()');
  const demandes = JSON.parse(app.run('JSON.stringify(appelsLogo)'));

  // La fixture porte quatre logos en place, un connecteur sans site (OVH) et
  // une destination sans site (le stockage local) : seul pCloud reste à récupérer, et
  // rien de ce qui est déjà là n'est retouché.
  assert.deepEqual(
    demandes.map((d) => d.path),
    ['/admin/connectors/destination-pcloud/logo'],
    `un seul logo manquant à récupérer : ${JSON.stringify(demandes)}`
  );
  assert.equal(demandes[0].force, false, '« manquants » n\'écrase jamais');
  assert.equal(appels.length, 0);
});

test('Logos : « tout resynchroniser » demande confirmation, puisque ça écrase', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderLogos()');

  app.run(`
    confirmations = [];
    confirm = (message) => { confirmations.push(message); return false; };
    appelsLogo = [];
    api = (path, options) => {
      if (String(path).endsWith('/logo') && options?.method === 'POST') {
        appelsLogo.push(path);
        return Promise.resolve({ ok: true });
      }
      return __fixture(path, options);
    };
  `);

  // La pause d'une seconde entre deux requêtes est réelle en production ;
  // ici elle n'ajouterait que de l'attente (voir web/admin.js, logosEnCours).
  app.run('logosEnCours.pauseMs = 0');
  await app.run('refetchAllLogos()');
  const messages = JSON.parse(app.run('JSON.stringify(confirmations)'));
  assert.equal(messages.length, 1, 'une confirmation est demandée');
  assert.match(messages[0], /remplacés/);
  // Et l'avertissement dit ce qui NE sera pas touché.
  assert.match(messages[0], /envoyée\(s\) à la main ne seront pas touchées/);
  assert.equal(app.run('appelsLogo.length'), 0, 'refuser n\'écrase rien');
});

test('Applications : le filtre « non actives » dégage la vue, sans effacer les autres filtres', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderApps()');

  // Filtre décoché : tout le catalogue est là — y compris le service annoncé.
  assert.equal(app.run('filteredApps().length'), 3);
  assert.equal(app.html('apps-list').includes('non active(s) masquée(s)'), false);

  // Coché : seule celle qui est réellement utilisée reste.
  await app.run('setAppsHideInactive(true)');
  assert.equal(app.run('filteredApps().length'), 1);
  assert.equal(app.run('filteredApps()[0].id'), 'free');

  const liste = app.html('apps-list');
  assert.ok(liste.includes('2 application(s) non active(s) masquée(s)'), 'compteur attendu');
  assert.ok(liste.includes('showAllApps()'), 'lien de réaffichage attendu');
  assert.equal(liste.includes('OVH'), false);

  // Le choix est mémorisé sur le compte, pas dans le navigateur.
  assert.ok(app.calls.api.includes('/users/me/preferences'));

  // Il s'ajoute aux filtres existants : une recherche qui ne vise que
  // l'application masquée ne la fait pas réapparaître.
  app.run('$("apps-search").value = "ovh"');
  app.run('renderAppsList()');
  assert.equal(app.run('filteredApps().length'), 0);

  // Et le lien « tout afficher » rend bien la main.
  app.run('$("apps-search").value = ""');
  await app.run('showAllApps()');
  assert.equal(app.run('filteredApps().length'), 3);
  assert.equal(app.run('$("apps-hide-inactive").checked'), false);
});

test('Applications : le catalogue montre les services annoncés, et sait les isoler', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderApps()');

  const liste = app.html('apps-list');
  assert.ok(liste.includes('Spotify'), 'un service annoncé figure au catalogue');
  assert.ok(liste.includes('Bientôt disponible'), 'et se voit au premier regard');
  assert.ok(
    app.run('$("apps-pending-note").textContent').includes('annoncé(s) attendent leur connecteur'),
    'le compte des annonces est dit à part de celui des candidatures'
  );

  // Rien à tester ni à approuver : il n'y a pas de code derrière.
  const tuile = extraireCarte(liste, 'Spotify', 'app-card');
  assert.equal(/testApp\(/.test(tuile), false, 'aucun test proposé');
  assert.equal(/rejectApp\(/.test(tuile), false, 'aucune candidature à rejeter');
  assert.ok(tuile.includes('openAccessModal('), 'mais l\'accès reste réglable');

  // Le filtre de statut les isole, et « Disponibles » les écarte.
  app.run('$("apps-status").value = "planned"');
  app.run('renderAppsList()');
  assert.equal(app.run('filteredApps().length'), 1);
  assert.equal(app.run('filteredApps()[0].id'), 'spotify');

  app.run('$("apps-status").value = "available"');
  app.run('renderAppsList()');
  assert.equal(app.run('filteredApps().some((c) => c.planned)'), false);
});

test('Applications : le filtre mémorisé est réappliqué au chargement', async () => {
  const memorise = JSON.parse(JSON.stringify(FIXTURES));
  memorise['/users/me/preferences'].preferences['apps.hideInactive'] = true;

  const app = makeSandbox(memorise);
  await app.run('renderApps()');

  assert.equal(app.run('admin.appsHideInactive'), true);
  assert.equal(app.run('$("apps-hide-inactive").checked'), true);
  assert.equal(app.run('filteredApps().length'), 1);
});

/**
 * Lot 10 — la bascule Cartes / Liste, sur les huit écrans qui la portent.
 *
 * Deux exigences, et elles se cassent séparément : les CARTES par défaut
 * (personne ne doit chercher un réglage pour voir l'écran normal), et la
 * mémoire PAR COMPTE — pas dans `localStorage`, qui ne suit personne d'un
 * poste à l'autre.
 */
test('Cartes par défaut sur les huit écrans, et le choix part sur le compte', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');

  const ecrans = [
    ['apps', 'renderApps()', 'setAppsView', 'apps-list', 'app-card'],
    ['logos', 'renderLogos()', 'setLogosView', 'logos-list', 'logo-card'],
    ['users', 'renderUsersPage()', 'setUsersView', 'users-list', 'user-card'],
    ['roles', 'renderRoles()', 'setRolesView', 'roles-tab-roles', 'card-grid'],
    ['support', 'renderSupport()', 'setSupportView', 'support-list', 'ticket-card'],
    ['cron', 'loadCron()', 'setCronView', 'cron-list', 'cron-card'],
    ['profil-connecteurs', 'renderProfilConnList()', 'setProfilConnView', 'profil-conn-list', 'card-grid'],
    ['profil-permissions', 'renderPermList()', 'setProfilPermView', 'perm-list', 'perm-card'],
  ];

  for (const [ecran, rendu, bascule, conteneur, marqueur] of ecrans) {
    await app.run(rendu);
    assert.equal(app.run(`viewMode('${ecran}')`), 'cards', `${ecran} : cartes par défaut`);
    assert.ok(
      app.html(conteneur).includes(marqueur),
      `${ecran} : « ${marqueur} » attendu dans la vue par défaut`
    );

    // La liste reste accessible, et le choix est mémorisé sur le compte.
    app.run(`${bascule}('list')`);
    assert.equal(app.run(`viewMode('${ecran}')`), 'list');
    assert.equal(app.run(`prefs.values['view.${ecran}']`), 'list');
  }

  assert.ok(app.calls.api.includes('/users/me/preferences'), 'la préférence part au serveur');
  // Et rien n'est écrit dans le navigateur : c'est justement ce qu'on a quitté.
  assert.equal(app.run('typeof localStorage.getItem("crabe.appsView")'), 'object');
});

test('Le mode mémorisé est réappliqué à l\'ouverture, sans passage par les cartes', async () => {
  const memorise = JSON.parse(JSON.stringify(FIXTURES));
  memorise['/users/me/preferences'].preferences['view.users'] = 'list';
  memorise['/users/me/preferences'].preferences['sort.users'] = 'invoices:desc';

  const app = makeSandbox(memorise);
  await app.run('loadPrefs()');
  await app.run('renderUsersPage()');

  assert.equal(app.run('viewMode("users")'), 'list');
  assert.ok(app.html('users-list').includes('data-table'), 'la liste, pas les cartes');

  // Le tri mémorisé aussi, et l'en-tête le dit.
  assert.equal(app.run('JSON.stringify(usersSort())'), '{"key":"invoices","dir":"desc"}');
  assert.match(app.html('users-list'), /aria-sort="descending"/);
  assert.equal(app.run('$("users-sort").value'), 'invoices');
});

test('Automatisation : la vue liste est pleine largeur et garde la sélection', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadCron()');
  app.run('setCronView("list")');

  assertScreen(app.html('cron-list'), {
    label: 'Automatisation (liste)',
    contains: ['data-table wide', 'toggleCronSelection(', 'saveSchedule(', 'runScheduleNow('],
  });
});

test('Automatisation : jamais de requête à identifiants vides', async () => {
  // Bug de production du lot 3 : l'écran émettait en rafale des
  // « PUT /api/admin/schedules// », identifiants vides, 400 à chaque fois.
  const app = makeSandbox(FIXTURES);
  await app.run('loadCron()');

  const vides = () => app.calls.api.filter((url) => String(url).includes('//'));

  // a. Cas nominal : la requête porte bien le couple (compte, connecteur).
  await app.run('saveSchedule("1:free")');
  assert.ok(app.calls.api.includes('/admin/schedules/1/free'), 'requête normale attendue');
  assert.deepEqual(vides(), []);

  // b. Identifiant inconnu : aucune requête ne part, et l'anomalie se voit.
  const avant = app.calls.api.length;
  await app.run('saveSchedule("")');
  await app.run('toggleSchedule("")');
  await app.run('saveSchedule("42:inexistant")');
  assert.deepEqual(vides(), [], 'aucune URL à segment vide');
  assert.equal(app.calls.api.length, avant, 'aucune requête ne doit partir');
  assert.match(app.calls.toasts.at(-1), /Planification introuvable/);

  // c. Une planification amputée de son couple est écartée dès le chargement :
  //    elle n'est pas rendue avec des contrôles qui n'iraient nulle part.
  const abime = JSON.parse(JSON.stringify(FIXTURES));
  abime['/admin/schedules'].schedules.push({
    ...abime['/admin/schedules'].schedules[0],
    id: ':',
    userId: null,
    connectorId: '',
    name: 'Planification cassée',
  });

  const secours = makeSandbox(abime);
  await secours.run('loadCron()');
  assert.equal(secours.run('admin.schedules.length'), 1, 'la ligne inexploitable est écartée');
  assert.equal(secours.html('cron-list').includes('Planification cassée'), false);
});

test('Stockage : une bande de statistiques, puis toutes les destinations', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderAdminStorage()');

  assertScreen(app.html('admin-storage-summary'), {
    label: 'Stockage (bande)',
    contains: ['storage-strip', 'Espace total', 'Répartition par destination', 'Fichiers', 'Comptes'],
  });

  const destinations = app.html('admin-storage-list');
  assertScreen(destinations, {
    label: 'Stockage (destinations)',
    contains: ['Stockage local', 'kDrive maison', 'pCloud boulot', 'Mon serveur',
      'saveDestination(', 'testDestination(', 'supprimerDestination('],
  });
  // ⚠ Lot 25 — ce sont les destinations qui EXISTENT, plus un catalogue figé
  // de six. Le nom affiché est celui que l'utilisateur a donné, le fournisseur
  // n'est plus qu'une étiquette à côté.
  assert.equal(
    (destinations.match(/class="dest-card"/g) || []).length,
    4,
    'Le stockage local, plus les trois clouds créés'
  );

  // Deux espaces chez des fournisseurs différents, chacun avec le sien affiché.
  assert.ok(destinations.includes('>kDrive</span>'), 'l\'étiquette du fournisseur');
  assert.ok(destinations.includes('>pCloud</span>'));

  // ⚠ INVERSÉ AU LOT 26. Le stockage local se supprimait « non », au motif d'être la
  // copie de référence — ce qui confondait « source des copies vers les
  // clouds » et « imposé à qui n'en veut pas ». Il porte donc son bouton comme
  // les autres, avec un avertissement qui lui est propre : le chemin est
  // conservé, la synchronisation vers les clouds perd sa source, et sans aucun
  // stockage actif les récupérations sont suspendues.
  assert.equal(
    /dest-card-local[\s\S]*?supprimerDestination\('local'/.test(destinations),
    true,
    'le stockage de crabe se supprime aussi, comme demandé'
  );
  // Et il n'est plus étiqueté « obligatoire », puisqu'il ne l'est plus.
  assert.equal(destinations.includes('>obligatoire</span>'), false);

  // Les formulaires à champs nommés. Ce qui est vérifié ici n'est pas la mise
  // en page mais le CONTRAT : un champ secret n'est jamais rempli d'avance, un
  // champ ordinaire l'est, et le choix libre demande d'abord un type.
  assert.ok(destinations.includes('Numéro de votre kDrive'));
  assert.ok(
    destinations.includes('value="123456"'),
    'un champ ordinaire déjà renseigné est réaffiché'
  );
  assert.equal(
    /id="dest-cloud-1a2b3c4d-champ-pass"[^>]*value="[^"]+"/.test(destinations),
    false,
    'un mot de passe enregistré n\'est JAMAIS renvoyé au navigateur'
  );
  assert.ok(
    destinations.includes('Enregistré — laisser vide pour le conserver'),
    'et son emplacement dit ce que « vide » veut dire'
  );

  // ⚠ LE DÉFAUT QUE CE LOT CORRIGE : pCloud recevait une carte SANS AUCUN
  // champ, et il fallait coller une configuration rclone faite à la main dans
  // un terminal. Ses champs viennent maintenant d'rclone, comme pour n'importe
  // quel autre type.
  assert.ok(
    destinations.includes('Your pcloud password.'),
    'un fournisseur sans formulaire écrit dans crabe tient ses champs d\'rclone'
  );

  assert.ok(destinations.includes('dest-cloud-5e4d3c2b-type'), 'le choix libre demande un type');
  assert.ok(destinations.includes('webdav — WebDAV'), 'la liste vient bien de rclone');

  // Le bloc rclone brut n'a pas disparu — il est simplement replié derrière
  // « Réglages avancés », pour ceux qui savent s'en servir.
  assert.ok(destinations.includes('Ou coller une configuration rclone toute faite'));
  // L'état du stockage local est affiché, pas seulement son chemin.
  assert.ok(destinations.includes('accessible en écriture'));
  // rclone absent : l'avertissement est visible.
  assert.ok(app.html('admin-storage-warning').includes('rclone'));

  // Et la porte d'entrée du nouveau modèle : le bouton d'ajout, toujours là.
  const tete = app.html('admin-storage-sync');
  assert.ok(tete.includes('Ajouter un cloud'), 'le bouton d\'ajout est toujours visible');
});

test('Stockage : la carte dit l\'état de l\'autorisation, et le bouton porte le geste', async () => {
  // Lot 34 — les trois familles d'états d'une destination à autorisation :
  // jamais autorisé (le bouton « Se connecter »), connecté (renouveler),
  // expiré (refaire, en rouge). Le serveur envoie `autorisation` avec la
  // destination ; l'écran ne calcule rien, il AFFICHE.
  const enrichi = JSON.parse(JSON.stringify(FIXTURES));
  const dests = enrichi['/admin/destinations'].destinations;
  const pcloud = dests.find((d) => d.id === 'cloud-9f8e7d6c');
  pcloud.autorisation = { possible: true, etat: 'jamais', echeance: null };
  const kdrive = dests.find((d) => d.id === 'cloud-1a2b3c4d');
  // kDrive (webdav) ne passe pas par une autorisation : PAS de bloc du tout.
  kdrive.autorisation = { possible: false };

  const app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  let liste = app.html('admin-storage-list');

  // 1. Jamais autorisé : la pastille et le bouton « Se connecter à pCloud ».
  assert.ok(liste.includes('Jamais autorisé'), 'l\'état est écrit sur la carte');
  assert.ok(liste.includes('Se connecter à pCloud'), 'le bouton porte le nom du service');
  assert.ok(liste.includes(`autoriserDestination('cloud-9f8e7d6c')`));
  assert.ok(liste.includes('aucun code à recopier'), 'et la promesse est dite en français');
  // Le fournisseur sans autorisation n'a NI pastille NI bouton.
  assert.equal(
    /dest-card-cloud-1a2b3c4d[\s\S]*?autoriserDestination\('cloud-1a2b3c4d'/.test(liste),
    false,
    'kDrive (mot de passe d\'application) ne reçoit pas ce bouton'
  );

  // 2. Connecté : la pastille verte, et « Renouveler » à portée de main.
  pcloud.autorisation = { possible: true, etat: 'connecte', echeance: null };
  const connecte = makeSandbox(enrichi);
  await connecte.run('renderAdminStorage()');
  liste = connecte.html('admin-storage-list');
  assert.ok(liste.includes('>Connecté<'), 'connecté, en toutes lettres');
  assert.ok(liste.includes('Renouveler l&#39;autorisation'),
    'un jeton expire : le renouvellement est un geste, pas une documentation');

  // 3. Expiré : rouge, et le message dit ce que ça coûte et quoi faire.
  pcloud.autorisation = { possible: true, etat: 'expiree', echeance: null };
  const expiree = makeSandbox(enrichi);
  await expiree.run('renderAdminStorage()');
  liste = expiree.html('admin-storage-list');
  assert.ok(liste.includes('Autorisation expirée'));
  assert.ok(liste.includes('Refaire l&#39;autorisation'));
  assert.ok(liste.includes('Les copies échoueront'), 'la conséquence est dite');

  // 4. Échéance proche : on prévient AVANT la panne, avec la date.
  pcloud.autorisation = { possible: true, etat: 'echeance', echeance: '2026-08-20T00:00:00.000Z' };
  const bientot = makeSandbox(enrichi);
  await bientot.run('renderAdminStorage()');
  liste = bientot.html('admin-storage-list');
  assert.ok(liste.includes('Expire bientôt'), 'l\'avertissement est sur la carte');
  assert.ok(liste.includes('20/08/2026'), 'avec la date, en français');
});

test('Stockage : session refusée dite en rouge, « Repartir de zéro », et les aides se replient (lot 57)', async () => {
  const enrichi = JSON.parse(JSON.stringify(FIXTURES));
  const dests = enrichi['/admin/destinations'].destinations;
  const kdrive = dests.find((d) => d.id === 'cloud-1a2b3c4d');
  const pcloud = dests.find((d) => d.id === 'cloud-9f8e7d6c');

  // Une aide longue, comme celles d'rclone ou des fournisseurs vedettes : la
  // première ligne reste visible, le reste se replie derrière « Tout lire » —
  // la carte cesse d'être un mur de texte, sans perdre un mot.
  kdrive.champs[0].help = 'Un nombre, que vous lisez dans l\'adresse de votre kDrive quand '
    + 'vous l\'ouvrez dans un navigateur : après « /kdrive/ », ou dans l\'adresse qui '
    + 'commence par « https://ksuite.infomaniak.com/kdrive/app/drive/ ».\n'
    + 'crabe compose lui-même l\'adresse de connexion à partir de ce numéro : vous n\'avez '
    + 'rien d\'autre à recopier, et cette seconde partie doit se replier.';

  // La session durable de l'incident du 25/08/2026 : présente, mais REFUSÉE
  // par le service — le serveur envoie la date du refus.
  pcloud.sessionDurable = true;
  pcloud.sessionMorteLe = '2026-08-25T17:00:00.000Z';

  const app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  let liste = app.html('admin-storage-list');

  // 1. La session refusée est dite, en rouge, avec la date et le geste — et
  //    le badge vert mensonger a disparu de cette carte.
  assert.ok(liste.includes('Session refusée par le service'), 'l\'état est écrit sur la carte');
  assert.ok(liste.includes('25/08/2026'), 'avec la date du refus');
  assert.ok(liste.includes('identifiants n\'y sont pour rien'), 'sans accuser le mot de passe');
  assert.equal(liste.includes('Session durable enregistrée'), false, 'plus de badge vert mensonger');

  // 2. « Repartir de zéro » : sur une carte configurée, jamais sur le stockage local,
  //    pas sur une carte encore vide (rien à oublier).
  assert.ok(liste.includes(`repartirDeZeroDestination('cloud-1a2b3c4d')`), 'le geste est offert');
  assert.equal(
    /dest-card-local[\s\S]*?repartirDeZeroDestination\('local'/.test(liste),
    false,
    'Le stockage local n\'a pas d\'identifiants à oublier'
  );
  assert.equal(
    liste.includes(`repartirDeZeroDestination('cloud-9f8e7d6c')`),
    false,
    'une carte jamais configurée n\'a rien à oublier'
  );

  // 3. L'aide longue se replie : la première ligne visible, « Tout lire »
  //    pour la suite — et la suite est LÀ, entière, pas supprimée.
  assert.ok(liste.includes('Tout lire'), 'le repli est offert');
  assert.ok(liste.includes('après « /kdrive/ »'), 'la première ligne guide');
  assert.ok(liste.includes('cette seconde partie doit se replier'), 'le paragraphe complet reste');
  assert.ok(
    /<details>[\s\S]*?cette seconde partie doit se replier/.test(liste),
    'et il vit bien DANS le repli'
  );

  // 4. La session vivante garde son badge vert, comme avant.
  delete pcloud.sessionMorteLe;
  const vivante = makeSandbox(enrichi);
  await vivante.run('renderAdminStorage()');
  liste = vivante.html('admin-storage-list');
  assert.ok(liste.includes('Session durable enregistrée'), 'le badge vert de la session vivante');
});

test('Stockage : trois états de session en faits datés, et la clé TOTP suggérée au bon moment (lot 58)', async () => {
  const enrichi = JSON.parse(JSON.stringify(FIXTURES));
  const dests = enrichi['/admin/destinations'].destinations;
  const carte = dests.find((d) => d.id === 'cloud-9f8e7d6c');
  carte.configured = true;

  // 1. Session refusée MAIS reconnexion automatique possible (mot de passe +
  //    clé TOTP enregistrés) : la carte dit qu'il n'y a rien à faire — pas de
  //    consigne de ressaisie pour une panne que crabe répare tout seul.
  carte.sessionDurable = true;
  carte.sessionMorteLe = '2026-08-25T21:00:00.000Z';
  carte.reconnexionAuto = true;
  carte.suggererCleTotp = false;
  let app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  let liste = app.html('admin-storage-list');
  assert.ok(liste.includes('Session refusée par le service'), 'le refus reste dit');
  assert.ok(liste.includes('se reconnectera tout seul à la prochaine opération'), 'et la suite aussi');
  assert.equal(liste.includes('saisissez votre mot de passe'), false, 'aucune ressaisie demandée pour rien');
  assert.equal(liste.includes('Pour que crabe se reconnecte'), false, 'pas de suggestion : la clé est déjà là');

  // 2. Session refusée SANS reconnexion possible, après un échec de
  //    reconnexion : le geste manuel, ET la suggestion de la clé — une ligne,
  //    pas un paragraphe de plus.
  carte.reconnexionAuto = false;
  carte.suggererCleTotp = true;
  app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  liste = app.html('admin-storage-list');
  assert.ok(liste.includes('saisissez votre mot de passe'), 'le geste manuel est dit');
  assert.ok(liste.includes('Pour que crabe se reconnecte'), 'la clé est suggérée — c\'est le bon moment');
  assert.ok(liste.includes('calculera lui-même un code frais'), 'et la promesse est dite');

  // 3. Session valide : le badge vert porte un FAIT daté, plus un espoir.
  delete carte.sessionMorteLe;
  carte.suggererCleTotp = false;
  carte.sessionEtablieLe = '2026-08-24T10:00:00.000Z';
  app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  liste = app.html('admin-storage-list');
  assert.ok(liste.includes('Session durable enregistrée'), 'le badge vert');
  assert.ok(liste.includes('Dernière connexion réussie le 24/08/2026'), 'daté, mesuré');

  // 4. Jamais connectée : l'état est écrit — l'absence d'état laissait deviner,
  //    et deviner s'est payé en réenregistrements à l'aveugle le 25/08/2026.
  carte.sessionDurable = false;
  delete carte.sessionEtablieLe;
  app = makeSandbox(enrichi);
  await app.run('renderAdminStorage()');
  liste = app.html('admin-storage-list');
  assert.ok(liste.includes('Jamais connectée'), 'l\'état est dit en toutes lettres');
  assert.ok(liste.includes('en établira une, durable'), 'avec le geste qui l\'établit');
  // Les cartes SANS notion de session (kDrive) ne reçoivent pas ce badge.
  assert.equal(
    /dest-card-cloud-1a2b3c4d[\s\S]*?Jamais connectée[\s\S]*?dest-card-local/.test(liste),
    false,
    'pas de badge de session sur un fournisseur qui n\'en a pas'
  );
});

test('Ajouter un cloud : les fournisseurs, et ce qui ne marchera pas ici', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderAdminStorage()');

  // Le contenu de la fenêtre est produit par une fonction pure, appelée ici
  // telle quelle : c'est le HTML qui est vérifié, pas la mécanique d'ouverture.
  const modale = app.run('htmlChoixFournisseur(ETAT_FOURNISSEURS)');
  assert.ok(modale.includes('pCloud'), 'les fournisseurs vedettes sont proposés');
  assert.ok(modale.includes('Dropbox'), 'et les types d\'rclone, dans la MÊME liste');

  // ⚠ Lot 28 — il n'y a plus de porte vers une seconde liste. « Autre
  // stockage » ouvrait un second menu où pCloud réapparaissait sous son nom
  // technique : le même service, deux fois, sous deux noms.
  assert.equal(modale.includes('Autre stockage'), false, 'plus de sous-menu séparé');
  assert.equal(
    (modale.match(/class="prov-card/g) || []).length,
    app.run('ETAT_FOURNISSEURS.length'),
    'une carte par service, ni plus ni moins'
  );

  // ⚠ Ce que le lot 24 a mesuré sur le conteneur : le rclone installé ne
  // fournissait ni `mega` ni `protondrive` (le lot 28 l'a mis à jour, mais une
  // autre installation peut très bien être dans ce cas). Ils restent PROPOSÉS
  // mais grisés, avec la phrase qui dit quoi faire — les retirer laisserait
  // croire que crabe ne sait pas leur parler, ce qui est faux.
  assert.ok(modale.includes('prov-card indispo'), 'un fournisseur indisponible est grisé');
  assert.ok(
    modale.includes('ne sait pas parler à MEGA'),
    'et il dit pourquoi, à la place de son résumé'
  );
  const rangMega = app.run('ETAT_FOURNISSEURS.findIndex((f) => f.id === "mega")');
  assert.equal(
    new RegExp(`onclick="choisirFournisseur\\(${rangMega}\\)"`).test(modale),
    false,
    'un fournisseur indisponible n\'est pas cliquable'
  );

  // ⚠ Lot 28 — le nom ne se demande PLUS ici. Il était réclamé avant même que
  // le service soit choisi, alors que la carte créée juste après porte depuis
  // toujours son champ « Nom de cet espace ».
  // ⚠ `id=`, pas `prov-nom` tout court : c'est aussi la classe CSS du nom de
  // chaque service, présente dans toutes les cartes.
  assert.equal(modale.includes('id="prov-nom"'), false, 'plus de champ de nom prématuré');
  assert.equal(modale.includes('Comment voulez-vous l\'appeler'), false);
  assert.ok(modale.includes('prov-filtre'), 'mais un champ de recherche, lui, est utile');
});

test('Sécurité : onglet Connexion, puis onglet Logs de connexion', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderSecurityPage()');

  assertScreen(app.html('security-content'), {
    label: 'Sécurité (Connexion)',
    contains: ['Complexité du mot de passe', 'Double authentification', 'setTwoFactorMode('],
  });
  // Ni SMTP ni Gravatar ne doivent subsister ici.
  assert.equal(app.html('security-content').includes('smtp-host'), false);
  assert.equal(app.html('security-content').toLowerCase().includes('gravatar'), false);

  app.run('admin.securityTab = "logs"');
  await app.run('renderSecurityTab()');
  assertScreen(app.html('security-content'), {
    label: 'Sécurité (Logs de connexion)',
    contains: ['Journal des connexions', 'saveRetention()', 'clearConnectionLogs()'],
  });
  assertScreen(app.html('connexions-table'), {
    label: 'Tableau des connexions',
    contains: ['camille', '10.0.0.10'],
  });
});

test('SMTP : configuration à gauche, modèles à droite', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderSmtpPage()');

  assertScreen(app.html('smtp-config'), {
    label: 'SMTP (configuration)',
    contains: ['smtp-host', 'smtp-port', 'smtp-secure', 'STARTTLS', 'smtp-from-name', 'testSmtp()'],
  });

  const modeles = app.html('smtp-templates');
  assertScreen(modeles, {
    label: 'SMTP (modèles)',
    contains: [
      'template-select',
      'template-subject',
      'template-body',
      'saveTemplate()',
      'resetTemplate()',
      'previewTemplate()',
      'sendTemplateTest()',
      'insertTemplateVariable(',
    ],
  });
  // Les variables du modèle sélectionné sont listées explicitement.
  assert.ok(modeles.includes('{{utilisateur}}'), 'variables du modèle absentes');
  assert.ok(modeles.includes('{{lien}}'));

  // Changer de modèle conserve la saisie en cours et affiche l'autre modèle.
  app.run('$("template-subject").value = "brouillon non enregistré"');
  app.run('$("template-body").value = "corps en cours"');
  app.run('selectTemplate("connector-failure")');
  assert.ok(app.html('smtp-templates').includes('{{connecteur}}'), 'second modèle non affiché');
  app.run('selectTemplate("email-change-confirm")');
  assert.ok(
    app.html('smtp-templates').includes('brouillon non enregistré'),
    'la saisie en cours doit survivre au changement de modèle'
  );
});

test('Logs : les trois onglets, pleine largeur et message tronquable', async () => {
  const app = makeSandbox(FIXTURES);

  await app.run('renderRunLogs()');
  assertScreen(app.html('logs-content'), {
    label: 'Logs (connecteurs)',
    contains: ['data-table wide', 'cell-grow', 'cell-ellipsis', 'toggleCell(this)', 'purgeLogs('],
  });

  await app.run('renderAppLogs()');
  assertScreen(app.html('logs-content'), {
    label: 'Logs (application)',
    contains: ['data-table wide', 'cell-grow', 'Écriture refusée'],
  });

  await app.run('renderStorageLogs()');
  assertScreen(app.html('logs-content'), {
    label: 'Logs (stockage)',
    contains: ['data-table wide', 'cell-grow', 'Stockage local'],
  });
});

test('Support : liste à gauche, invitation à droite tant que rien n\'est choisi', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderSupport()');

  assertScreen(app.html('support-stats'), {
    label: 'Support (statistiques)',
    contains: ['stat-card', 'setSupportFilter('],
  });
  // Lot 10 : les cartes par défaut, la liste en option — comme partout.
  assertScreen(app.html('support-list'), {
    label: 'Support (cartes)',
    contains: ['ticket-card', 'Erreur OVH', 'openSupportDetail(1)'],
  });
  app.run('setSupportView("list")');
  assertScreen(app.html('support-list'), {
    label: 'Support (liste)',
    contains: ['ticket-item', 'Erreur OVH', 'openSupportDetail(1)'],
  });
  assertScreen(app.html('support-detail'), {
    label: 'Support (invitation)',
    contains: ['col-placeholder', 'Sélectionnez une demande'],
  });

  // Ouvrir une demande remplit la colonne de droite : fil et zone de réponse.
  await app.run('openSupportDetail(1)');
  assertScreen(app.html('support-detail'), {
    label: 'Support (détail)',
    contains: [
      'Erreur OVH',
      'La synchronisation OVH échoue.',
      'support-reply',
      'sendSupportReply(1)',
      'setTicketStatus(1,\'ferme\')',
    ],
  });
});

test('Système : colonne Logiciel et colonne Infrastructure', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderSysteme()');

  const html = app.html('systeme-content');
  assertScreen(html, {
    label: 'Système',
    contains: [
      'split-2',
      'Logiciel',
      'Infrastructure',
      'Version de crabe',
      'Node.js',
      'Uptime du service',
      'Scheduler',
      'checkUpdates()',
      'Base SQLite',
      'Disque restant',
      'Montage du stockage local',
      'Binaire rclone',
      'Playwright',
      'Utilisateurs actifs',
      'Connecteurs installés',
      'Factures récupérées',
      'Espace utilisé',
    ],
  });

  // L'état du montage est traduit, pas affiché brut.
  assert.ok(html.includes('accessible en écriture'));
  assert.equal(html.includes('>ok<'), false, 'l\'état brut ne doit pas apparaître tel quel');
  // Playwright absent : dit explicitement, sans alarmisme.
  assert.ok(html.includes('mode simulé'));
  // Les réglages de date et d'heure restent accessibles : ils vivent dans
  // une modale (app.html), et la page porte le bouton qui l'ouvre.
  assert.ok(html.includes('openDatetimeModal()'));
  assert.equal(
    html.includes('saveDisplaySettings()'),
    false,
    'le formulaire ne vit plus dans la page : il est dans la modale'
  );
  // Le bouton « Vérifier les mises à jour » vit désormais dans la ligne
  // « Version de crabe » ; le pied de colonne a disparu, et avec lui le seul
  // profil-btn de cette page.
  assert.equal(
    html.includes('profil-btn'),
    false,
    'plus de bouton en pied de colonne : la mise à jour se vérifie depuis la ligne Version'
  );
});

test('un écran qui manque une donnée du serveur échoue bruyamment', async () => {
  // Garde-fou du bac à sable lui-même : si une fixture ment, le test doit le
  // voir. Sans quoi les vérifications ci-dessus ne prouveraient rien.
  const cassé = { ...FIXTURES, '/system': { ...FIXTURES['/system'], runtime: undefined } };
  const app = makeSandbox(cassé);
  await assert.rejects(() => app.run('renderSysteme()'));
});

// ---------------------------------------------------------------------------
// Lot 3 — l'accueil configurable
// ---------------------------------------------------------------------------

test('Accueil : les six blocs se rendent avec leur contenu', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const html = app.html('home-widgets');
  assertScreen(html, {
    label: 'Accueil',
    contains: [
      'Mes connecteurs',
      'Statistiques',
      'Synchronisation',
      'Suivi actions',
      'Derniers documents',
      'État des destinations',
      // Le glisser-déposer est câblé sur les cartes elles-mêmes.
      'drag-handle',
      'ondragstart',
      // Actions de chaque bloc.
      'syncAll()',
      'runHomeSync(',
      'testDestinationFromHome(',
      '/api/connectors/me/invoices/6/file',
    ],
  });

  // En-tête : salutation et date du jour, formatée selon les réglages.
  assert.equal(app.run('$("home-greeting").textContent'), 'Bonjour, camille');
  assert.equal(app.run('$("home-date").textContent'), '09/08/2026');

  // Aucune erreur récente : l'état positif, pas un bloc vide.
  // ─── Lot 25 : les trois natures du bloc « Suivi actions » ─────────────────
  //
  // Ce qui est vérifié ici n'est pas la mise en page mais le CONTRAT : les
  // trois couleurs sont rendues, et le vert existe — y compris, et surtout,
  // sur une récupération qui n'a rapporté aucun document.
  assert.ok(html.includes('err-item erreur'), 'une ligne rouge');
  assert.ok(html.includes('err-item alerte'), 'une ligne jaune');
  assert.ok(html.includes('err-item succes'), 'une ligne verte');

  // ⚠ LE POINT DU LOT : zéro document est un succès. Cette phrase-là doit
  // apparaître sur une ligne VERTE, pas jaune, pas rouge.
  const ligneOvh = html.slice(html.indexOf('OVHcloud') - 400, html.indexOf('OVHcloud') + 400);
  assert.ok(ligneOvh.includes('Aucune nouvelle facture'), 'la phrase du succès à zéro document');
  assert.ok(/err-item succes/.test(ligneOvh), 'et elle est rendue en vert');

  // Le compte rendu en tête répond à « y a-t-il quelque chose à faire ? »
  // sans lire les lignes une par une.
  assert.ok(html.includes('err-bilan'));
  assert.ok(html.includes('1 en échec'));
  assert.ok(html.includes('1 en attente'));
  assert.ok(html.includes('2 à jour'));

  // Aucune couleur figée : elles viennent toutes des variables du thème, qui
  // ont deux jeux, clair et sombre. Une valeur en dur serait illisible dans
  // l'un des deux.
  const styleSuivi = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'web', 'style.css'), 'utf8')
    .split('--- d. Suivi actions')[1]
    .split('--- e.')[0];
  for (const regle of ['.err-item.erreur', '.err-item.alerte', '.err-item.succes']) {
    assert.ok(styleSuivi.includes(regle), `${regle} doit exister`);
  }
  assert.equal(
    /#[0-9a-f]{3,8}\b/i.test(styleSuivi),
    false,
    'aucune couleur écrite en dur dans le bloc Suivi actions'
  );

  // Une seule destination activée : une carte, une pastille, et la note.
  assert.equal((html.match(/class="dest-card-home"/g) || []).length, 1);
  assert.equal((html.match(/class="dest-pill /g) || []).length, 1);
  // Le texte est échappé au rendu : on cherche la partie sans apostrophe.
  assert.ok(html.includes('Proton Drive et pCloud ne sont pas activés par'));
  // Ni carte ni pastille pour une destination non autorisée.
  assert.equal(html.includes('Proton Drive</div>'), false);

  // L'espace restant est mis en évidence, pas seulement l'espace occupé.
  assert.ok(html.includes('restants'));

  // Les aides à la revue de la maquette n'existent pas dans l'application.
  assert.equal(html.includes('toggleDemoErrors'), false);
  assert.equal(html.includes('Aides à la revue'), false);
});

// ---------------------------------------------------------------------------
// Lot 17 — pagination des deux listes, et les deux graphiques
// ---------------------------------------------------------------------------

/**
 * Un accueil chargé : 23 connecteurs, 47 documents, douze mois de statistiques.
 *
 * Les fixtures ordinaires portent UNE ligne de chaque : elles ne pourraient
 * pas montrer qu'une pagination existe, encore moins qu'elle borne quelque
 * chose. Ce jeu-là est fait pour déborder.
 */
function accueilCharge(pageSize = 10, { documentsPageSize = pageSize } = {}) {
  const base = JSON.parse(JSON.stringify(FIXTURES['/home']));
  const prefs = JSON.parse(JSON.stringify(FIXTURES['/users/me/preferences']));
  const modele = base.sync[0];
  const doc = base.documents[0];

  // Lot 20 : chaque bloc a SA taille de page, et c'est la préférence qui fait
  // foi côté navigateur (c'est elle qu'on modifie sans attendre le serveur).
  // Les deux sont posées ensemble : une fixture où elles diverge­raient ne
  // décrirait aucun état réel.
  base.syncPageSize = pageSize;
  base.documentsPageSize = documentsPageSize;
  prefs.preferences['home.sync.pageSize'] = pageSize;
  prefs.preferences['home.documents.pageSize'] = documentsPageSize;
  base.sync = Array.from({ length: 23 }, (_, i) => ({
    ...modele,
    id: `service-${i + 1}`,
    name: `Service ${i + 1}`,
  }));
  base.documents = Array.from({ length: 47 }, (_, i) => ({
    ...doc,
    id: 100 + i,
    reference: `REF-${i + 1}`,
  }));

  base.stats = {
    ...base.stats,
    invoicesTotal: 47,
    parMois: Array.from({ length: 12 }, (_, i) => ({
      periode: `2026-${String(i + 1).padStart(2, '0')}`,
      // Un mois à zéro : le graphique doit le dessiner, pas le sauter.
      count: i === 3 ? 0 : i + 1,
    })),
    parConnecteur: [
      { connectorId: 'free', name: 'Free Internet', color: '#c8102e', letters: 'FR', count: 30 },
      { connectorId: 'ovh', name: 'OVH', color: '#1c3f94', letters: 'OVH', count: 17 },
    ],
  };

  return { ...FIXTURES, '/home': base, '/users/me/preferences': prefs };
}

test('Accueil : les deux listes se paginent, dix lignes par page', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  // Les deux blocs sont mis en LISTE : c'est cette présentation-là que ce test
  // regarde, et la bascule est un réglage de compte — pas une valeur figée.
  app.run('setHomeSyncView("list")');
  app.run('setHomeDocumentsView("list")');
  const html = app.html('home-widgets');

  // Dix lignes de synchronisation, pas vingt-trois.
  assert.equal((html.match(/class="sync-row"/g) || []).length, 10);
  assert.equal((html.match(/class="doc-row/g) || []).length, 10);

  // Et la pagination dit où l'on en est, en toutes lettres.
  assert.ok(html.includes('Page 1 sur 3 · 23 connecteur(s)'), 'pagination de la synchronisation');
  assert.ok(html.includes('Page 1 sur 5 · 47 document(s)'), 'pagination des documents');

  // La page 2 des documents montre les suivants, et pas les mêmes.
  assert.ok(html.includes('REF-1<') || html.includes('REF-1 '), 'la première page part du début');
  app.run('pagerBloc("documents", 2)');
  const page2 = app.html('home-widgets');
  assert.ok(page2.includes('Page 2 sur 5'));
  assert.equal(page2.includes('réf. REF-1<'), false, 'la page 2 ne rejoue pas la page 1');
  assert.equal((page2.match(/class="doc-row/g) || []).length, 10);
});

test('Accueil : les deux blocs se paginent INDÉPENDAMMENT', async () => {
  // Le défaut que ce test empêche de revenir : le lot 18 réglait les deux
  // blocs d'un seul nombre. Régler « Synchronisation » sur 15 lignes changeait
  // « Derniers documents » du même coup, sans que rien ne l'annonce.
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('setHomeSyncView("list")');
  app.run('setHomeDocumentsView("list")');

  app.run('saveHomePageSize("sync", 25)');
  const html = app.html('home-widgets');

  assert.equal(
    (html.match(/class="sync-row"/g) || []).length,
    23,
    'les 23 connecteurs tiennent sur une page'
  );
  assert.equal(
    (html.match(/class="doc-row/g) || []).length,
    10,
    'et les documents n\'ont pas bougé'
  );
  assert.ok(html.includes('Page 1 sur 5 · 47 document(s)'), 'leur pagination non plus');
  assert.equal(app.run('prefs.values["home.documents.pageSize"]'), 10);
});

test('Accueil : la présentation d\'un bloc ne touche pas celle de l\'autre', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  app.run('setHomeSyncView("list")');
  const html = app.html('home-widgets');

  assert.ok(html.includes('class="sync-row"'), 'la synchronisation passe en liste');
  assert.ok(html.includes('home-doc-card'), 'les documents restent en cartes');
  assert.equal(app.run('prefs.values["view.home-sync"]'), 'list');
  assert.equal(app.run('prefs.values["view.home-documents"]'), 'cards');
  assert.equal(
    app.run('prefs.values["view.documents"]'),
    'cards',
    'et l\'écran « Mes documents » n\'a rien vu passer'
  );
});

test('Accueil : les deux blocs savent se présenter en cartes', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  const html = app.html('home-widgets');

  // Une carte porte ce que porte la ligne : nom du service, état, action.
  assert.ok(html.includes('class="sync-card"'), 'des cartes de synchronisation');
  assert.ok(html.includes('Service 1'), 'et le nom du service');
  assert.ok(html.includes('id="sync-btn-service-1"'), 'le bouton garde son identifiant');
  assert.ok(html.includes('id="sync-status-service-1"'), 'l\'état aussi');

  assert.ok(html.includes('home-doc-card'), 'des cartes de documents');
  assert.ok(html.includes('REF-1'), 'et leur référence');
});

test('Accueil : une page demandée au-delà de la dernière est ramenée dans les clous', async () => {
  // Sans ce recalage, supprimer des documents laisserait l'utilisateur devant
  // un bloc vide, sans rien pour en sortir.
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('setHomeDocumentsView("list")');

  app.run('pagerBloc("documents", 99)');
  const html = app.html('home-widgets');
  assert.ok(html.includes('Page 5 sur 5'), 'la dernière page existante');
  assert.ok((html.match(/class="doc-row/g) || []).length > 0, 'et elle montre quelque chose');
});

test('Accueil : chaque bloc garde sa propre taille de page', async () => {
  // Remplace le test du lot 18 (« le réglage du profil change les deux blocs à
  // la fois ») : c'est exactement le comportement que ce lot supprime.
  // 15 et 30 : deux valeurs DIFFÉRENTES, toutes deux dans la liste que le
  // serveur accepte. Une taille hors liste retomberait sur le défaut, et le
  // test croirait mesurer une pagination alors qu'il mesurerait un refus.
  const app = makeSandbox(accueilCharge(15, { documentsPageSize: 30 }));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('setHomeSyncView("list")');
  app.run('setHomeDocumentsView("list")');

  const html = app.html('home-widgets');
  assert.equal((html.match(/class="sync-row"/g) || []).length, 15, 'quinze lignes de synchronisation');
  assert.equal((html.match(/class="doc-row/g) || []).length, 30, 'et trente documents');
  assert.ok(html.includes('Page 1 sur 2 · 23 connecteur(s)'));
  assert.ok(html.includes('Page 1 sur 2 · 47 document(s)'));

  // Le changement se voit tout de suite, sans recharger la page — et sur le
  // seul bloc réglé.
  app.run('saveHomePageSize("sync", 50)');
  const apres = app.html('home-widgets');
  assert.equal((apres.match(/class="sync-row"/g) || []).length, 23, 'tout tient sur une page');
  assert.equal(
    apres.includes("pagerBloc('sync'"),
    false,
    'plus de pagination sur ce bloc — tout tient sur une page'
  );
  assert.equal((apres.match(/class="doc-row/g) || []).length, 30, 'les documents n\'ont pas bougé');
  assert.ok(apres.includes('Page 1 sur 2 · 47 document(s)'), 'leur pagination non plus');
});

test('Accueil : une seule page n\'affiche aucune pagination', async () => {
  // Un bouton mort qui prend la place de ce qu'on est venu voir.
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');
  assert.equal(app.html('home-widgets').includes('class="pager"'), false);
});

test('Accueil : les deux graphiques se dessinent, en SVG et sans couleur figée', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('renderHome()');
  const html = app.html('home-widgets');

  assert.ok(html.includes('Factures par mois'), 'le premier graphique');
  assert.ok(html.includes('Répartition par service'), 'le second');

  // Douze barres : les douze mois, y compris celui à zéro.
  const barres = [...html.matchAll(/<rect [^>]*height="\d+"/g)];
  assert.ok(barres.length >= 12, `douze barres attendues, ${barres.length} trouvées`);

  // Les couleurs de structure viennent du thème : une valeur figée serait
  // lisible dans l'un des deux thèmes et invisible dans l'autre.
  assert.ok(html.includes('fill="var(--accent)"'), 'les barres suivent le thème');
  assert.ok(html.includes('stroke="var(--border)"'), 'l\'axe aussi');

  // Sauf la couleur propre à chaque service — celle de ses pastilles ailleurs.
  assert.ok(html.includes('fill="#c8102e"') && html.includes('fill="#1c3f94"'));

  // Chaque barre porte son mois en entier et son compte, au survol.
  assert.ok(html.includes('<title>avril 2026 — 0 facture(s)</title>'), 'le mois vide se dit');
  assert.ok(html.includes('<title>décembre 2026 — 12 facture(s)</title>'));

  // Aucun nombre à virgule dans les graphiques : un compte de factures est
  // entier, et « 12,5 factures » ne veut rien dire. (L'espace occupé, lui,
  // garde ses décimales — « 593,9 Ko » est la bonne façon de l'écrire.)
  for (const valeur of html.matchAll(/class="chart-(?:row-val|max|note)"[^>]*>([^<]*)</g)) {
    assert.equal(
      /\d[.,]\d/.test(valeur[1]),
      false,
      `valeur non arrondie dans un graphique : « ${valeur[1].trim()} »`
    );
  }

  // Et aucune bibliothèque de graphiques n'est chargée.
  assert.equal(/chart\.js|d3|recharts|plotly/i.test(html), false);
});

test('Accueil : un compte sans facture le dit, au lieu de dessiner le vide', async () => {
  const vide = accueilCharge(10);
  vide['/home'].stats = {
    ...vide['/home'].stats,
    invoicesTotal: 0,
    invoicesThisMonth: 0,
    parMois: Array.from({ length: 12 }, (_, i) => ({
      periode: `2026-${String(i + 1).padStart(2, '0')}`,
      count: 0,
    })),
    parConnecteur: [],
  };

  const app = makeSandbox(vide);
  await app.run('renderHome()');
  const html = app.html('home-widgets');

  assert.ok(
    html.includes('Rien à représenter pour l\'instant'),
    'une phrase, comme les autres blocs'
  );
  assert.equal(html.includes('Factures par mois'), false, 'et pas de cadre vide et muet');
});

test('Accueil : les nouvelles présentations tiennent aux cinq points de rupture', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  // Les deux blocs en cartes — le défaut du lot 20.
  assertFits(app.html('home-widgets'), { label: 'Accueil, blocs en cartes' });

  // Puis en liste, la présentation d'origine.
  app.run('setHomeSyncView("list")');
  app.run('setHomeDocumentsView("list")');
  assertFits(app.html('home-widgets'), { label: 'Accueil, blocs en liste' });

  // Et les cinq graphiques ensemble, formes au choix comprises : c'est la
  // combinaison la plus chargée qu'un accueil puisse afficher.
  app.run("setStatsChartType('mois', 'courbe')");
  app.run("setStatsChartType('connecteurs', 'anneau')");
  for (const id of ['stockage', 'connecteurs-temps', 'executions']) {
    app.run(`toggleStatsChart('${id}', true)`);
  }
  assertFits(app.html('home-widgets'), { label: 'Accueil, cinq graphiques' });

  // Le panneau de personnalisation porte désormais deux réglages de plus.
  app.run('openHomePanel()');
  assertFits(app.html('home-panel-list'), { label: 'Panneau de personnalisation' });
});

test('Mes documents : les cartes de service tiennent aux cinq points de rupture', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');
  assertFits(app.html('docs-content'), { label: 'Mes documents, cartes de service' });

  await app.run('enterDocsConnector("free")');
  assertFits(app.html('docs-content'), { label: 'Mes documents, dans un service' });
});

test('Accueil : les graphiques restent lisibles dans les deux thèmes', async () => {
  // Aucun navigateur ici : on ne peut pas mesurer un contraste. Ce qui SE
  // vérifie, et qui est la vraie cause d'un graphique illisible en thème
  // clair, c'est qu'une couleur ait été écrite en dur ou qu'une variable
  // n'existe que d'un côté. Le thème clair redéfinit `body.light` : toute
  // variable employée par les graphiques doit y être redéfinie, sinon elle
  // garde sa valeur sombre sur fond clair.
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  // TOUS les graphiques, et les deux formes au choix : c'est le rendu le plus
  // chargé en couleurs, donc celui qui a le plus d'occasions d'en écrire une
  // en dur ou d'employer une variable qui n'existe que d'un côté.
  app.run("setStatsChartType('mois', 'courbe')");
  app.run("setStatsChartType('connecteurs', 'anneau')");
  for (const id of ['stockage', 'connecteurs-temps', 'executions']) {
    app.run(`toggleStatsChart('${id}', true)`);
  }
  const html = app.html('home-widgets');

  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const bloc = (selecteur) => css.slice(css.indexOf(selecteur), css.indexOf('}', css.indexOf(selecteur)));
  const sombre = bloc(':root{');
  const clair = bloc('body.light{');

  // Les variables employées par les graphiques, dans le HTML et dans le CSS.
  const employees = new Set([
    ...[...html.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]),
    ...[...css.slice(css.indexOf('.charts{')).matchAll(/var\((--[\w-]+)\)/g)]
      .slice(0, 40)
      .map((m) => m[1]),
  ]);

  for (const variable of employees) {
    if (variable === '--radius') continue;   // une mesure, pas une couleur
    assert.ok(sombre.includes(`${variable}:`), `${variable} manque au thème sombre`);
    assert.ok(clair.includes(`${variable}:`), `${variable} n'est pas redéfinie en thème clair`);
  }

  // Et les seules couleurs en dur du rendu sont celles des services, qui
  // viennent des manifestes et sont les mêmes partout dans l'interface.
  const enDur = [...html.matchAll(/(?:fill|stroke)="(#[0-9a-f]{3,8})"/gi)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(enDur)].sort(),
    ['#1c3f94', '#c8102e'],
    'aucune couleur figée en dehors de celles des services'
  );
});

test('Accueil chargé : rien ne déborde aux cinq points de rupture', async () => {
  // Les cinq largeurs de bloc — du quart de ligne à la ligne entière — sont
  // servies par le même HTML : c'est la grille qui change, pas le rendu. On
  // mesure donc le rendu complet à chacun des cinq points de rupture d'écran.
  const app = makeSandbox(accueilCharge(10));
  await app.run('renderHome()');

  assertFits(app.html('home-widgets'), { label: 'Accueil paginé et ses graphiques' });
});

test('Accueil : aucun bloc n\'est rendu deux fois', async () => {
  // Le lot 3 affichait « Erreurs et alertes » en double, côte à côte. Deux
  // garde-fous désormais : le serveur ne peut plus produire de doublon, et
  // l'interface ne le croit pas sur parole.
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const ids = [...app.html('home-widgets').matchAll(/data-widget="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)], ids, 'un bloc rendu plus d\'une fois');
  assert.equal(ids.length, 6);

  // Même une réponse serveur incohérente ne produit pas de doublon à l'écran.
  app.run('home.widgets = home.widgets.concat([home.widgets[3]])');
  app.run('renderHomeWidgets()');
  app.run('renderHomePanel()');

  const apres = [...app.html('home-widgets').matchAll(/data-widget="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(apres)], apres, 'le doublon a été rendu');
  assert.equal(
    (app.html('home-panel-list').match(/class="panel-item /g) || []).length,
    6,
    'le panneau non plus ne doit pas doubler un bloc'
  );
});

test('Accueil : chaque bloc porte sa largeur et son sélecteur 1 · ½ · ⅓ · ¼', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const html = app.html('home-widgets');
  // Largeurs par défaut de la maquette : quatre blocs pleine ligne, deux demis.
  assert.equal((html.match(/class="widget w-span-12"/g) || []).length, 4);
  assert.equal((html.match(/class="widget w-span-6"/g) || []).length, 2);
  // Quatre boutons de largeur par bloc, et la poignée SVG remplace « ⋮⋮ ».
  assert.equal((html.match(/setHomeWidgetSpan\(/g) || []).length, 24);
  assert.equal(html.includes('⋮⋮'), false, 'la poignée doit être l\'icône SVG');
  assert.ok(html.includes('<circle cx="9" cy="13" r="1.4"/>'), 'grille de six points attendue');

  // Choisir une largeur la reflète immédiatement et l'envoie au serveur.
  app.run('setHomeWidgetSpan("sync", 3)');
  assert.ok(app.html('home-widgets').includes('class="widget w-span-3"'));
  assert.ok(app.calls.api.includes('/home/widgets'), 'la largeur doit être enregistrée');
});

test('Accueil figé : ni poignée, ni sélecteur, ni panneau modifiable', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  // a. Verrou personnel — l'utilisateur peut le retirer lui-même.
  app.run('home.access = { adminAllowed: true, personalLock: true, canCustomize: false }');
  app.run('renderHomeWidgets()');
  app.run('renderHomePanel()');

  const fige = app.html('home-widgets');
  assert.equal(fige.includes('ondragstart'), false, 'plus de glisser-déposer');
  assert.equal(fige.includes('drag-handle'), false, 'plus de poignée');
  assert.equal(fige.includes('w-span-btn'), false, 'sélecteurs de largeur masqués');
  // Le contenu, lui, reste entier.
  assert.ok(fige.includes('Suivi actions'));

  const panneau = app.html('home-panel-list');
  assert.ok(panneau.includes('Figer mon accueil'), 'le panneau explique pourquoi');
  assert.equal((panneau.match(/disabled/g) || []).length >= 6, true, 'cases en lecture seule');

  // b. Verrou administrateur — le bouton est grisé et le dit.
  app.run('home.access = { adminAllowed: false, personalLock: false, canCustomize: false }');
  app.run('renderCustomizeButton()');
  assert.equal(app.run('$("btn-customize").disabled'), true);
  assert.match(app.run('$("btn-customize").title'), /désactivée par l'administrateur/);

  // Et le panneau refuse de s'ouvrir, même appelé directement.
  app.run('openHomePanel()');
  assert.match(app.calls.toasts.at(-1), /désactivée par l'administrateur/);
});

test('Accueil : le panneau de personnalisation liste les blocs, avec ses flèches', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');
  app.run('renderHomePanel()');

  const html = app.html('home-panel-list');
  assertScreen(html, {
    label: 'Panneau de personnalisation',
    contains: [
      'toggleHomeWidget(',
      'moveHomeWidget(',
      'type="checkbox"',
      'panel-drag',
      // Le sélecteur de largeur est TOUJOURS visible ici, contrairement à
      // celui des blocs qui n'apparaît qu'au survol.
      'setHomeWidgetSpan(',
    ],
  });
  assert.equal((html.match(/class="panel-item /g) || []).length, 6);

  // Solution tactile : les deux flèches existent pour chaque bloc, bornées
  // en tête et en fin de liste.
  assert.equal((html.match(/moveHomeWidget\(/g) || []).length, 12);
  assert.equal((html.match(/disabled aria-label="Monter/g) || []).length, 1);
  assert.equal((html.match(/disabled aria-label="Descendre/g) || []).length, 1);
});

test('Accueil : un bloc désactivé disparaît de la grille, pas du panneau', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  app.run('home.widgets.find((w) => w.id === "sync").enabled = false');
  app.run('renderHomeWidgets()');
  app.run('renderHomePanel()');

  assert.equal(app.html('home-widgets').includes('Synchronisation'), false);
  assert.ok(app.html('home-panel-list').includes('Synchronisation'));
});

test('Accueil : zéro document affiche une invitation, pas une grille vide', async () => {
  const vide = { ...FIXTURES, '/home': { ...FIXTURES['/home'], documents: [] } };
  const app = makeSandbox(vide);
  await app.run('renderHome()');

  const html = app.html('home-widgets');
  assertScreen(html, { label: 'Accueil sans document', contains: ['Aucun document pour'] });
  assert.equal(html.includes('docs-grid'), false);
});

test('Accueil : un nombre impair de documents ne laisse pas de trou', async () => {
  const impair = {
    ...FIXTURES,
    '/home': {
      ...FIXTURES['/home'],
      documents: [1, 2, 3].map((n) => ({
        ...FIXTURES['/home'].documents[0],
        id: n,
        filename: `2026-0${n}_000${n}.pdf`,
        reference: `000${n}`,
      })),
    },
  };
  const app = makeSandbox(impair);
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  // La règle du « nombre impair » est celle de la grille à deux colonnes de la
  // présentation en LISTE : les cartes, elles, se rangent d'elles-mêmes.
  app.run('setHomeDocumentsView("list")');

  const html = app.html('home-widgets');
  // La dernière ligne occupe la largeur entière : `full` une seule fois, sur
  // la dernière.
  assert.equal((html.match(/class="doc-row full"/g) || []).length, 1);
  assert.ok(html.lastIndexOf('doc-row full') > html.lastIndexOf('doc-row"'));
});

test('Accueil : une destination en échec donne une pastille rouge et « Renvoyer »', async () => {
  const enEchec = JSON.parse(JSON.stringify(FIXTURES));
  enEchec['/home'].destinations.push({
    id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
    usedBytes: 0, files: 0,
    space: { known: false, totalBytes: null, freeBytes: null, usedBytes: null,
             reason: 'Binaire rclone introuvable sur le serveur.' },
    lastTestAt: null, lastTestOk: null,
  });
  enEchec['/home'].hiddenDestinations = [{ id: 'pcloud', name: 'pCloud' }];
  enEchec['/home'].hiddenDestinationsNote = "pCloud n'est pas activé par l'administrateur.";

  enEchec['/home'].documents[0].destinations.push({
    id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
    state: 'error', at: '2026-08-09T07:02:00.000Z', message: 'quota dépassé',
    tooltip: 'Proton Drive — échec le 2026-08-09 07:02 : quota dépassé',
  });
  enEchec['/home'].documents[0].hasError = true;

  const app = makeSandbox(enEchec);
  await app.run('renderHome()');
  const html = app.html('home-widgets');

  assert.ok(html.includes('dest-pill error'), 'pastille rouge attendue');
  assert.ok(html.includes('quota dépassé'), 'message d\'erreur au survol');
  assert.ok(html.includes('resendDocument(6'), '« Renvoyer » sur le document en échec');
  // Espace non mesurable : dit explicitement, jamais un zéro trompeur.
  assert.ok(html.includes('espace restant inconnu'));
  assert.equal(html.includes('0 o restants'), false);
});

/**
 * Lot 9 — le logo d'une destination s'affiche partout où elle est nommée.
 *
 * Le lot 8 avait donné leurs vrais logos aux treize connecteurs, et laissé les
 * trois destinations avec une initiale dans un carré de couleur. Le mécanisme
 * est le même : ce test vérifie qu'il arrive jusqu'à l'écran, aux quatre
 * endroits où une destination porte un nom.
 */
test('Destinations : le logo suit partout, et l\'anneau d\'état reste lisible', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const accueil = app.html('home-widgets');
  // a. le bloc « État des destinations »
  assert.match(
    accueil,
    /class="dest-card-icon"[^>]*>S<img class="logo-img interne" src="\/stockage-local.svg"/,
    'la carte de destination porte son icône, posée sur la pastille'
  );
  // b. les pastilles de transfert d'un document : le logo dit QUELLE
  //    destination, la couleur de la pastille dit si la copie est passée.
  const pastille = accueil.match(/<span class="dest-pill ok"[^>]*>[\s\S]{0,160}?<\/span>/);
  assert.ok(pastille, 'la pastille de transfert doit être rendue');
  assert.ok(pastille[0].includes('/stockage-local.svg'), 'avec le logo de la destination');
  assert.ok(pastille[0].includes('dest-pill ok'), 'et son état, qui ne disparaît pas');

  // c. l'explorateur de documents — le sélecteur n'existe qu'à partir de deux
  //    espaces, c'est là que nommer chacun d'eux compte le plus.
  const explorateur = makeSandbox(FIXTURES);
  explorateur.run(`
    const base = JSON.parse(JSON.stringify(FIXTURE_DOCUMENTS));
    base.destinations.push({
      id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
      logo: '/api/connectors/logos/destination-proton.png?v=1', logoInterne: false,
      primary: false, available: true, reason: null,
    });
    api = (path) => (String(path).startsWith('/documents')
      ? Promise.resolve(JSON.parse(JSON.stringify(base)))
      : __fixture(path));
  `);
  await explorateur.run('renderDocuments()');
  const docs = explorateur.html('docs-content');
  assert.ok(docs.includes('/stockage-local.svg'), 'Le stockage local porte son icône dans l\'explorateur');
  assert.ok(docs.includes('destination-proton.png'), 'et Proton Drive son logo récupéré');

  // d. l'écran Stockage du profil
  const stockage = makeSandbox(FIXTURES);
  await stockage.run('renderProfilStorage()');
  assert.ok(
    stockage.html('my-storage-quota').includes('/stockage-local.svg'),
    'la répartition par destination porte les mêmes icônes'
  );
});

// ---------------------------------------------------------------------------
// Lot 3 — Automatisation par couple (compte, connecteur)
// ---------------------------------------------------------------------------

test('Automatisation : jour, heure et prochaine exécution, par compte', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadCron()');

  const cartes = app.html('cron-list');
  assertScreen(cartes, {
    label: 'Automatisation (cartes)',
    contains: [
      'camille',
      'cron-freq-1:free',
      'cron-day-1:free',
      'cron-time-1:free',
      'dernier jour du mois',
      'Prochaine exécution',
      'runScheduleNow(',
    ],
  });
  // Jours du mois : 1 à 28 seulement, plus « dernier jour du mois ».
  assert.ok(cartes.includes('<option value="28"'));
  assert.equal(cartes.includes('<option value="29"'), false);
  assert.equal(cartes.includes('<option value="31"'), false);

  app.run('setCronView("list")');
  const liste = app.html('cron-list');
  assertScreen(liste, {
    label: 'Automatisation (liste)',
    contains: ['data-table wide', 'toggleCronSelection(', 'saveSchedule(', 'data-label="Compte"'],
  });
});

test('Automatisation : aucune installation, aucune planification affichée', async () => {
  const vide = { ...FIXTURES, '/admin/schedules': { ...FIXTURES['/admin/schedules'], schedules: [] } };
  const app = makeSandbox(vide);
  await app.run('loadCron()');

  const html = app.html('cron-list');
  assert.ok(html.includes('Aucune planification'));
  assert.ok(html.includes("à l'installation d'un connecteur"));
});

// ---------------------------------------------------------------------------
// Lot 3 — écrans utilisateur
// ---------------------------------------------------------------------------

test('Store : les connecteurs et leurs boutons d\'installation', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');

  assertScreen(app.html('store-grid'), {
    label: 'Store',
    contains: ['Free Internet', 'EDF', 'openModal(', 'installFromCard(', 'uninstallFromCard('],
  });
});

/**
 * §4.1 du lot 13 — le Store ne signale plus rien.
 *
 * Le badge « logo manquant » et le cadre rouge apparaissaient sur les tuiles du
 * Store. C'est un défaut d'administration, pas une information utile à
 * quelqu'un qui cherche un service — et une pastille à initiales est un état
 * parfaitement normal. Le signalement vit désormais dans Paramètres →
 * Applications → Logos, où il y a un bouton pour y remédier.
 */
test('Store : aucune tuile ne signale un logo manquant, même pour un administrateur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');
  const html = app.html('store-grid');

  assert.ok(html.length > 100, 'la grille doit être rendue');
  assert.equal(
    html.includes('logo manquant'),
    false,
    'plus aucune mention « logo manquant » dans le Store'
  );
  assert.equal(
    html.includes('logo-missing'),
    false,
    'plus aucun cadre rouge ni badge de logo dans le Store'
  );

  // Le gestionnaire de logos, lui, le signale toujours — c'est là que ça sert.
  const admin = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'web', 'admin.js'),
    'utf8'
  );
  assert.match(admin, /logo-missing-tag/, 'le gestionnaire de logos garde son signalement');
});

// ---------------------------------------------------------------------------
// Lot 11 — les services annoncés dans le Store
// ---------------------------------------------------------------------------

test('Store : un service annoncé porte un badge, pas un bouton — et rien au clic', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');
  const html = app.html('store-grid');

  assertScreen(html, {
    label: 'Store (annoncés)',
    contains: ['Spotify', 'Bientôt disponible', 'card planned'],
  });

  // La tuile annoncée : aucun gestionnaire de clic, ni sur la carte, ni sur le
  // badge. Un bouton grisé se cliquerait quand même, et un clic sans effet
  // perceptible se lit comme une panne.
  const tuile = extraireCarte(html, 'Spotify');
  assert.equal(/onclick/.test(tuile), false, 'la tuile annoncée ne réagit à aucun clic');
  assert.equal(/install-btn/.test(tuile), false, 'et ne propose pas d\'installation');
  assert.ok(tuile.includes('planned-badge'), 'le badge remplace le bouton');

  // La tuile disponible, elle, n'a pas changé.
  const disponible = extraireCarte(html, 'EDF');
  assert.ok(disponible.includes('installFromCard('), 'un service disponible reste installable');
});

test('Store : la réserve des banques se lit sur la tuile, pas dans une infobulle', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');

  const tuile = extraireCarte(app.html('store-grid'), 'Crédit Agricole');
  assert.ok(
    tuile.includes('sa disponibilité n&#39;est pas garantie')
      || tuile.includes('sa disponibilité n\'est pas garantie'),
    'la réserve doit être visible dans le corps de la tuile'
  );
});

test('Store : l\'en-tête annonce le compte exact, tel que le serveur le donne', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');

  const entete = app.run('$("store-count").textContent');
  assert.equal(entete, '3 services disponibles, 2 à venir');
});

test('Store : « seulement les services disponibles » retire les annonces', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');
  assert.ok(app.html('store-grid').includes('Spotify'));

  app.run('setStoreAvailableOnly(true)');
  const filtre = app.html('store-grid');
  assert.equal(filtre.includes('Spotify'), false, 'l\'annonce est retirée');
  assert.equal(filtre.includes('Bientôt disponible'), false);
  assert.ok(filtre.includes('Free Internet'), 'les services disponibles restent');

  // Les pastilles suivent : une catégorie devenue vide ne doit pas rester
  // proposée — elle mènerait à une grille vide sans qu'on comprenne pourquoi.
  assert.equal(app.html('store-pills').includes('Divertissement'), false);

  app.run('setStoreAvailableOnly(false)');
  assert.ok(app.html('store-grid').includes('Spotify'), 'et le filtre se relâche');
});

test('Store : la recherche porte aussi sur les services annoncés', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderStore()');

  app.run('$("store-search").value = "spotify"');
  app.run('renderStoreGrid()');
  const trouve = app.html('store-grid');
  assert.ok(trouve.includes('Spotify'));
  assert.equal(trouve.includes('Free Internet'), false, 'et elle écarte le reste');

  // Une catégorie vide ne s'affiche pas : chercher « spotify » ne doit pas
  // laisser quatorze pastilles qui ne mènent nulle part.
  const pastilles = app.html('store-pills');
  assert.ok(pastilles.includes('Divertissement'));
  assert.equal(pastilles.includes('Énergie'), false);

  app.run('$("store-search").value = "introuvable-nulle-part"');
  app.run('renderStoreGrid()');
  assert.ok(
    app.html('store-grid').includes('Aucun service ne correspond'),
    'un résultat vide dit pourquoi'
  );
});

// ---------------------------------------------------------------------------
// Lot 5 — champ de session et sélection des éléments découverts
// ---------------------------------------------------------------------------

/**
 * Charge le catalogue puis ouvre la fiche d'un connecteur.
 *
 * `edit` ouvre la fiche en mode saisie, comme le font « Modifier » et
 * « Reconfigurer » : c'est là que vivent les champs et les options avancées
 * d'un connecteur DÉJÀ connecté. Sans ça, la fiche montre — à dessein — le
 * résumé et deux boutons, et rien d'autre.
 */
async function ouvrirFiche(app, id, { edit = false } = {}) {
  await app.run('loadConnectors()');
  app.run(`openModal('${id}', { edit: ${edit ? 'true' : 'false'} })`);
  return app.html('modal-fields');
}

test('Fiche connecteur : la connexion dit sa validité, et rien de plus', async () => {
  const app = makeSandbox(FIXTURES);
  const html = await ouvrirFiche(app, 'free-mobile', { edit: true });

  assertScreen(html, {
    label: 'Fiche Free Mobile',
    contains: [
      // Les deux seules questions qu'on se pose : jusqu'à quand ça marche, et
      // comment refaire si c'est fini.
      'Connexion enregistrée le',
      'valable jusqu\'au',
      'Se reconnecter',
    ],
  });

  // Rien de ce qui est enregistré n'est réinjecté dans le formulaire, et le
  // détail interne d'une session ne s'affiche jamais.
  assert.equal(html.includes('cookieCount'), false, 'détail interne affiché');

  // Lot 9 : le dépôt d'un fichier de session a quitté la fiche de
  // l'utilisateur pour l'administration. Il n'en reste RIEN ici.
  for (const parti of [
    'Choisir un fichier', 'Coller le contenu', 'readSessionFile(', 'toggleSessionPaste(',
    'type="file"', 'capture-session', 'Tester la connexion',
  ]) {
    assert.equal(html.includes(parti), false, `« ${parti} » ne doit plus être sur la fiche`);
  }
});

test('Fiche connecteur : les lignes découvertes sont cochables, la sélection est respectée', async () => {
  const app = makeSandbox(FIXTURES);
  const html = await ouvrirFiche(app, 'free-mobile', { edit: true });

  assertScreen(html, {
    label: 'Fiche Free Mobile → lignes',
    contains: ['0628000000', '0749000000', '12 factures', 'principale', 'secondaire', 'rediscover('],
  });

  // La ligne principale est retenue en configuration, les autres non.
  const coche = (id) => {
    const balise = new RegExp(`<input type="checkbox" value="${id}"([^>]*)>`).exec(html);
    assert.ok(balise, `aucune case pour la ligne ${id}`);
    return balise[1].includes('checked');
  };
  assert.equal(coche('0628000000'), true, 'la ligne sélectionnée doit être cochée');
  assert.equal(coche('0749000000'), false, 'une ligne non retenue reste décochée');
});

test('Fiche connecteur : sans découverte, aucune liste vide trompeuse', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  // Le même connecteur, mais rien n'a encore été découvert pour ce compte.
  app.run('state.connectors.find((c) => c.id === "free-mobile").configSummary = null');
  app.run('openModal("free-mobile", { edit: true })');

  const html = app.html('modal-fields');
  assert.ok(
    html.includes('La liste sera établie à la connexion'),
    'il faut dire pourquoi la liste est vide'
  );
  assert.ok(html.includes('data-ready="0"'), 'la clé ne doit pas partir à l\'enregistrement');
  assert.ok(html.includes('Aucune connexion enregistrée'), 'et dire qu\'aucune n\'est là');
});

// ---------------------------------------------------------------------------
// Lot 15 — le champ d'identification porte le nom que le site lui donne
//
// La fiche de L'Atelier du Portable réclamait une « Adresse électronique » là
// où le site demande un IDENTIFIANT — et la valeur enregistrée (« prenom.nom »)
// n'est pas une adresse. Le libellé venait du manifeste, écrit à la main, et le
// formulaire ramenait tout champ d'adresse à un `type="text"` sans le dire.
//
// Ce test rend le formulaire RÉEL : le manifeste du dépôt, passé par le schéma
// du serveur exactement comme l'API le sert, puis web/app.js tel qu'il tourne
// dans le navigateur. C'est la preuve du correctif, et elle est rejouable.
// ---------------------------------------------------------------------------

const schema = require('../server/connectors/manifest-schema');

/** La fiche d'un connecteur du dépôt, telle que `/api/connectors` la sert. */
function ficheReelle(id, { values = {} } = {}) {
  const brut = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'server', 'connectors', 'available', id, 'manifest.json'), 'utf8')
  );
  return {
    ...schema.publicView(schema.normalize(brut)),
    status: 'installed',
    installed: true,
    maintenance: false,
    lastRunAt: null,
    installedAt: '2026-08-11T09:00:00.000Z',
    invoiceCount: 0,
    lastInvoiceAt: null,
    configSummary: { sessions: {}, discoveries: {}, settings: {}, values },
    health: {
      code: 'ready', title: 'Connecté', detail: '', tone: 'green',
      action: { id: 'sync', label: 'Récupérer maintenant' },
      canSync: true, canReconfigure: true, connected: true, followedLabel: null,
    },
  };
}

test('Fiche L\'Atelier du Portable : le champ s\'appelle « Identifiant »', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  const fiche = ficheReelle('atelier-du-portable', { values: { email: 'prenom.nom' } });
  app.run(`state.connectors.push(${JSON.stringify(fiche)})`);
  app.run('openModal("atelier-du-portable", { edit: true })');

  const html = app.html('modal-fields');

  assertScreen(html, {
    label: 'Fiche L\'Atelier du Portable → identification',
    contains: ['<label>Identifiant</label>', 'Votre identifiant de connexion au site'],
  });

  // Le type de champ suit la nature déclarée : `text`, parce que « prenom.nom »
  // n'est pas une adresse et qu'un champ d'adresse le refuserait.
  assert.match(
    html,
    /<input type="text"[^>]*data-key="email"[^>]*value="prenom\.nom"/,
    'le champ doit être un champ texte, rempli de la valeur enregistrée'
  );

  // Le libellé erroné a disparu de la fiche, aide comprise.
  assert.equal(
    html.includes('Adresse électronique'),
    false,
    'la fiche ne doit plus réclamer d\'adresse électronique'
  );
});

test('Fiche Kubii : une boutique qui demande vraiment une adresse la demande', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run(`state.connectors.push(${JSON.stringify(ficheReelle('kubii'))})`);
  app.run('openModal("kubii", { edit: true })');

  const html = app.html('modal-fields');
  assertScreen(html, {
    label: 'Fiche Kubii → identification',
    contains: [
      '<label>Adresse électronique</label>',
      'Celle avec laquelle vous vous connectez sur Kubii.',
    ],
  });
  // Le champ retrouve le type que le formulaire lui refusait : clavier
  // d'adresse sur téléphone, et le navigateur sait ce qu'il reçoit.
  assert.match(html, /<input type="email"[^>]*data-key="email"/);
});

// ---------------------------------------------------------------------------
// Lot 22 — une aide longue ne doit pas enterrer le champ suivant
//
// Rapporté après le lot 21 : « les champs pour l'identifiant et le secret
// d'application ne sont pas visibles dans la fiche PayPal, je n'ai jamais pu ne
// serait-ce que tenter ». Le manifeste était correct et le formulaire les
// rendait bien — mesuré dans un vrai Chromium, fenêtre de 1280 × 900 : la fiche
// faisait 1 124 px de contenu dans une modale de 774. Le second champ ET le seul
// bouton tombaient sous la pliure, derrière 1 360 caractères d'aide, sans que
// rien ne signale qu'il fallait faire défiler.
//
// Ces tests ne mesurent pas des pixels — aucun navigateur ici. Ils vérifient les
// deux règles qui font tenir la fiche : une aide longue se replie sur sa
// première ligne, et la barre d'actions reste collée au bas de la modale.
// ---------------------------------------------------------------------------

test('une aide courte s\'affiche entière, une aide longue garde sa première ligne', async () => {
  const app = makeSandbox(FIXTURES);

  const courte = app.run('fieldHelp("Celle avec laquelle vous vous connectez.")');
  assert.match(courte, /^<div class="field-help">Celle avec laquelle/);
  assert.equal(courte.includes('Tout lire'), false, 'rien à replier sur une phrase');

  // Une aide longue, mais d'un seul tenant : rien à couper proprement, on la
  // laisse telle quelle plutôt que de la trancher au milieu d'une phrase.
  const monobloc = app.run(`fieldHelp(${JSON.stringify('a'.repeat(600))})`);
  assert.equal(monobloc.includes('Tout lire'), false);

  const longue = app.run(
    `fieldHelp(${JSON.stringify(`⚠ L'AVERTISSEMENT QUI COMPTE.\n${'détail. '.repeat(60)}`)})`
  );
  assert.ok(longue.includes('⚠ L&#39;AVERTISSEMENT QUI COMPTE.'), 'la première ligne reste visible');
  assert.ok(longue.includes('<summary>Tout lire</summary>'), 'et le reste se déplie');
  assert.ok(longue.includes('détail.'), 'sans rien perdre du texte');
  assert.deepEqual(nestingErrors(longue), []);
});

test('Fiche PayPal : les deux champs d\'identifiants sont là, et le bouton avec', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');

  // L'état RÉEL de la production au 13/08/2026 : installé, en échec sur un refus
  // d'identifiants. C'est la fiche réellement affichée ce jour-là.
  const fiche = {
    ...ficheReelle('paypal'),
    status: 'error',
    catalogStatus: 'pending',
    health: {
      code: 'error', title: 'Connexion refusée', detail: 'PayPal a refusé la connexion.',
      tone: 'red', action: { id: 'configure', label: 'Se reconnecter' },
      canSync: false, canReconfigure: true, connected: false, followedLabel: null,
    },
  };
  app.run(`state.connectors.push(${JSON.stringify(fiche)})`);
  app.run('openModal("paypal")');

  const corps = app.html('modal-fields');
  const premierNiveau = corps.slice(0, corps.indexOf('<div class="adv">'));

  // Les deux champs sont au PREMIER niveau : pas repliés sous « Options
  // avancées », pas absents. C'est le cœur du signalement.
  assert.match(premierNiveau, /<input type="text"[^>]*data-key="clientId"/);
  assert.match(premierNiveau, /<input type="password"[^>]*data-key="clientSecret"/);
  assert.ok(premierNiveau.includes('Identifiant d&#39;application (Client ID)'));
  assert.ok(premierNiveau.includes('Secret d&#39;application'));

  // Et l'aide de 1 360 caractères ne s'étale plus entre les deux : ce qui reste
  // à l'écran est l'avertissement, le mode d'emploi se déplie.
  // ⚠ Lot 23 : l'avertissement de tête a changé, parce que l'échec réel a
  // changé de nature. Ce n'était pas Sandbox contre Live — c'était une adresse
  // e-mail saisie à la place d'un identifiant d'application. C'est donc ÇA que
  // la première ligne doit dire, puisque c'est la seule qui reste à l'écran.
  assert.ok(
    premierNiveau.includes('NI votre adresse e-mail PayPal'),
    'l\'avertissement qui compte reste visible sans rien déplier'
  );
  assert.equal(
    (premierNiveau.match(/<summary>Tout lire<\/summary>/g) || []).length,
    2,
    'les deux aides longues de PayPal doivent être repliées'
  );

  // Le geste attendu existe et n'est pas grisé.
  const actions = app.html('modal-actions');
  assert.ok(actions.includes('Se connecter à PayPal'));
  assert.equal(actions.includes('disabled'), false);

  assertScreen(corps, { label: 'Fiche PayPal → saisie des identifiants' });
});

test('la barre d\'actions de la fiche reste collée au bas de la modale', () => {
  // La modale défile (`max-height:86vh; overflow-y:auto`) et sa barre de
  // défilement est quasi invisible sur fond sombre : un bouton poussé hors de
  // l'écran par une aide longue n'existe pas, pour qui regarde la fiche.
  const regles = CSS_RULES.filter((r) => r.selector.split(',').some((s) => s.trim() === '.modal-actions'));
  assert.ok(regles.length, '.modal-actions doit exister dans la feuille de style');

  const declarations = Object.assign({}, ...regles.map((r) => r.declarations));
  assert.equal(declarations.position, 'sticky', 'sans cela le bouton part sous la pliure');
  assert.ok(declarations.background, 'un fond opaque, sinon le texte passe au travers');
  assert.ok(declarations['z-index'], 'et au-dessus du contenu qui défile dessous');
});

// ---------------------------------------------------------------------------
// Lot 16 — la phrase finale du message d'échec
//
// Cinq connecteurs en échec en production, cinq causes correctement
// diagnostiquées par le serveur, et la MÊME phrase collée derrière les cinq :
//
//     « Une fenêtre du site empêche la connexion. Ce service doit être adapté
//       — signalez-le. — corrigez vos identifiants puis retestez. »
//
// La seconde moitié contredisait la première : rien n'accusait le mot de
// passe. La phrase d'action venait d'une chaîne fixe concaténée dans
// `saveConnector()`, sans regarder la cause.
//
// Ce test exécute `saveConnector()` — la VRAIE fonction de web/app.js — une
// fois par cause, et lit ce que la zone de résultat affiche. Le message attendu
// est lu dans `messages-echec.js`, pas recopié : les deux ne peuvent pas
// diverger sans que ce test le dise.
// ---------------------------------------------------------------------------

const echecs = require('../server/connectors/messages-echec');

for (const situation of echecs.CLES) {
  test(`Échec « ${situation} » : la fiche affiche le message de la cause, et rien de plus`, async () => {
    const attendu = echecs.messagePour(situation);

    const app = makeSandbox({
      ...FIXTURES,
      // Ce que `/connectors/:id/test` renvoie vraiment quand un connecteur
      // lève l'erreur de cette situation (registry.test() rend `err.message`).
      '/connectors/kubii/test': { ok: false, message: attendu },
    });
    await app.run('loadConnectors()');
    app.run(`state.connectors.push(${JSON.stringify(ficheReelle('kubii'))})`);
    app.run('openModal("kubii", { edit: true })');
    await app.run('saveConnector()');

    const zone = app.elements.get('modal-test-result');

    assert.equal(
      zone.textContent,
      attendu,
      'le message affiché doit être EXACTEMENT celui de la cause, sans ajout'
    );
    assert.match(zone.className, /\bfail\b/, 'un échec doit se voir comme un échec');
    assert.match(zone.className, /\bshow\b/, 'et la zone doit être visible');
  });
}

test('aucune cause autre qu\'un refus d\'identifiants ne fait parler d\'identifiants', async () => {
  // Le défaut, pris par son symptôme : les quatre causes qui n'accusent pas le
  // mot de passe ne doivent nulle part inviter à le corriger.
  for (const situation of echecs.CLES.filter((c) => c !== 'identifiants-refuses')) {
    const attendu = echecs.messagePour(situation);
    const app = makeSandbox({ ...FIXTURES, '/connectors/kubii/test': { ok: false, message: attendu } });
    await app.run('loadConnectors()');
    app.run(`state.connectors.push(${JSON.stringify(ficheReelle('kubii'))})`);
    app.run('openModal("kubii", { edit: true })');
    await app.run('saveConnector()');

    assert.doesNotMatch(
      app.elements.get('modal-test-result').textContent,
      /identifiants|mot de passe/i,
      `${situation} : le message ne doit pas renvoyer à des identifiants qu'il vient d'innocenter`
    );
  }
});

test('Écran de sélection : badge, détail et avertissement de rétention', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile")');
  await app.run('rediscover()');

  const html = app.html('modal-fields');
  assertScreen(html, {
    label: 'Sélection des lignes',
    contains: [
      // La question est posée dans la langue du fournisseur, pas dans celle du
      // programme : « Quelles lignes… », et non « éléments découverts ».
      'Quelles lignes voulez-vous suivre ?',
      '0628000000',
      '0782518125',
      'Samuel Huck',
      '3 factures',
      // L'avertissement de rétention : une perte définitive doit se voir.
      'Les lignes résiliées ne recevront plus de nouvelle facture',
      '12 dernières',
    ],
  });

  // Les boutons de l'étape de sélection remplacent ceux de la fiche.
  assert.equal(app.elements.get('modal-discovery-actions').style.display, 'flex');
  assert.equal(app.elements.get('modal-actions').style.display, 'none');
});

test('Un seul élément à choisir : l\'écran de choix ne s\'affiche pas du tout', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');

  // Un compte qui ne porte qu'une ligne n'a rien à choisir : lui présenter une
  // case unique, déjà cochée, avec un bouton « Continuer », c'est lui demander
  // de valider une évidence.
  app.run(`
    const uneSeule = JSON.parse(JSON.stringify(FIXTURE_DECOUVERTE));
    uneSeule.items = uneSeule.items.slice(0, 1);
    api = (path, options) => (String(path).endsWith('/discover')
      ? Promise.resolve(uneSeule)
      : __fixture(path, options));
  `);
  await app.run('rediscover()');

  assert.equal(
    app.elements.get('modal-discovery-actions').style.display,
    'none',
    'aucun écran de choix ne doit s\'afficher'
  );
  assert.equal(app.elements.get('modal-overlay').classList.contains('show'), false,
    'la fiche se referme et on enchaîne');
  assert.ok(
    app.calls.toasts.some((t) => /est connecté, récupération de vos factures en cours/.test(t)),
    `annonce de fin attendue, reçu : ${JSON.stringify(app.calls.toasts)}`
  );
  assert.ok(app.calls.api.includes('/connectors/free-mobile/run'), 'la récupération doit partir');
});

test('Plusieurs éléments : l\'écran de choix s\'affiche, et lui seul', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');
  await app.run('rediscover()');

  assert.equal(app.elements.get('modal-discovery-actions').style.display, 'flex');
  // Rien n'a encore été récupéré : c'est bien un choix, pas une confirmation.
  assert.equal(app.calls.api.includes('/connectors/free-mobile/run'), false);
});

/**
 * L'attente pendant la recherche — 20 à 60 secondes, pendant lesquelles le
 * bouton « Se connecter » restait cliquable.
 */
test('Pendant la recherche, le bouton laisse la place à un indicateur qui avance', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');

  // Avant : le bouton est là, et il est cliquable.
  assert.match(app.html('modal-actions'), /Se connecter à Free Mobile/);

  // Une recherche qu'on règle à la main, pour observer le « pendant ».
  app.run(`
    recherche = {};
    recherche.promesse = new Promise((ok) => { recherche.resoudre = ok; });
    api = (path, options) => (String(path).endsWith('/discover')
      ? recherche.promesse.then(() => __fixture('/connectors/free-mobile/discover'))
      : __fixture(path, options));
  `);
  const enCours = app.run('rediscover()');

  const pendant = app.html('modal-actions');
  assert.equal(
    pendant.includes('Se connecter à Free Mobile'),
    false,
    'le bouton ne doit plus être là : un bouton qui ne doit pas être cliqué ne doit pas avoir l\'air cliquable'
  );
  assert.ok(pendant.includes('attente-jauge'), 'une progression visible, pas un rond figé');
  assert.ok(pendant.includes('Connexion réussie'), 'et un texte qui dit où on en est');
  // Le texte parle la langue du fournisseur : des lignes, pas des « éléments ».
  assert.ok(
    app.run('etapesDecouverte(state.connectors.find((c) => c.id === "free-mobile")).some((e) => e.texte === "Recherche de vos lignes…")'),
    'l\'étape suivante doit nommer ce qui est cherché'
  );
  assert.ok(
    app.run('etapesDecouverte({}).some((e) => e.texte.includes("Presque fini"))'),
    '« Presque fini… » doit exister pour les recherches longues'
  );

  app.run('recherche.resoudre()');
  await enCours;

  // Après : l'écran de choix, et plus d'indicateur d'attente.
  assert.equal(app.elements.get('modal-discovery-actions').style.display, 'flex');
});

test('Une recherche qui échoue laisse « Réessayer », jamais un écran figé', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');

  app.run(`
    api = (path, options) => (String(path).endsWith('/discover')
      ? Promise.reject(new Error('Session Free Mobile expirée.'))
      : __fixture(path, options));
  `);
  await app.run('rediscover()');

  const apres = app.html('modal-actions');
  assert.ok(apres.includes('Réessayer'), 'un échec doit laisser un geste');
  assert.ok(apres.includes('relancerDecouverte('), 'et ce geste relance la recherche');
  assert.ok(apres.includes('Session Free Mobile expirée.'), 'la raison est dite');
  assert.equal(apres.includes('attente-jauge'), false, 'la progression s\'arrête');
});

test('Un refus « déjà en cours » est affiché tel quel, sans le déguiser en panne', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');

  // Le serveur refuse la seconde recherche (409) avec un message écrit POUR
  // l'utilisateur : le préfixer d'un « la recherche a échoué » le rendrait faux.
  app.run(`
    api = (path, options) => {
      if (!String(path).endsWith('/discover')) return __fixture(path, options);
      const err = new Error('Une recherche est déjà en cours sur votre compte Free Mobile — laissez-la finir.');
      err.status = 409;
      return Promise.reject(err);
    };
  `);
  await app.run('rediscover()');

  const apres = app.html('modal-actions');
  assert.ok(apres.includes('Une recherche est déjà en cours'), 'le refus du serveur est repris tel quel');
  assert.equal(apres.includes('la recherche a échoué'), false, 'et pas déguisé en panne');
  assert.ok(apres.includes('Réessayer'));
});

/**
 * Lot 9, §5.9 — la profondeur d'historique, réglage générique.
 *
 * Amazon expose quinze années de commandes : les parcourir toutes prend une
 * demi-heure et sollicite lourdement le site. Ça vaut le coup une fois, pas
 * tous les jours. Les libellés viennent du SERVEUR (connectors/history.js) :
 * ce sont eux qui engagent son comportement, les réécrire dans le front les
 * ferait diverger.
 */
test('Historique : quatre choix, le réglage enregistré coché, et sous les options avancées', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run(`
    const c = state.connectors.find((x) => x.id === 'free-mobile');
    c.fields.push({
      key: 'historique', label: 'Historique à récupérer', type: 'history',
      required: false, help: '', default: 'depuis',
      choices: [
        { mode: 'tout', label: 'Toutes les années disponibles', note: 'premier passage, long' },
        { mode: 'dernieres', label: 'Les {n} dernières années', note: '' },
        { mode: 'courante', label: 'Année en cours seulement', note: '' },
        { mode: 'depuis', label: 'Depuis la dernière récupération', note: 'recommandé' },
      ],
      yearRange: { min: 1, max: 15 },
    });
    c.configSummary.settings = { historique: 'dernieres:3' };
  `);
  app.run('openModal("free-mobile", { edit: true })');

  const html = app.html('modal-fields');
  assertScreen(html, {
    label: 'Profondeur d\'historique',
    contains: [
      'Historique à récupérer',
      'Toutes les années disponibles',
      'premier passage, long',
      'dernières années',
      'Année en cours seulement',
      'Depuis la dernière récupération',
      'recommandé',
    ],
  });

  // Le réglage enregistré est celui qui est coché — un seul, forcément.
  const coche = (mode) => new RegExp(`value="${mode}" checked`).test(html);
  assert.equal(coche('dernieres'), true, 'le choix enregistré doit être coché');
  for (const autre of ['tout', 'courante', 'depuis']) {
    assert.equal(coche(autre), false, `« ${autre} » ne doit pas être coché`);
  }
  assert.ok(/<option value="3" selected>3<\/option>/.test(html), 'et son nombre d\'années aussi');

  // Le sélecteur de nombre vit DANS son libellé, à sa place dans la phrase.
  const ligne = html.split('<label class="history-item">').find((b) => b.includes('history-years'));
  assert.ok(ligne, 'la ligne « Les N dernières années » doit porter son sélecteur');
  assert.ok(ligne.indexOf('Les') < ligne.indexOf('history-years'));
  assert.ok(ligne.indexOf('history-years') < ligne.indexOf('dernières années'));

  // Et le réglage est sous « Options avancées », pas devant les yeux de
  // quelqu'un qui veut juste connecter son compte : il a un défaut qui convient.
  const avant = html.slice(0, html.indexOf('adv-body'));
  assert.equal(avant.includes('Historique à récupérer'), false);
});

test('Écran de sélection : la première ligne est principale, toutes les autres secondaires', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');
  await app.run('rediscover()');

  const html = app.html('modal-fields');
  // Le bloc de CETTE ligne, et lui seul : une fenêtre approximative attraperait
  // la pastille de la ligne voisine.
  const blocs = html.split('<label class="multi-item">');
  const autour = (numero) => {
    const bloc = blocs.find((b) => b.includes(numero));
    assert.ok(bloc, `aucune ligne ${numero} dans le rendu`);
    return bloc;
  };

  assert.ok(autour('0628000000').includes('>principale<'), 'la première ligne est principale');
  for (const numero of ['0749000000', '0743000000', '0782518125']) {
    assert.ok(autour(numero).includes('>secondaire<'), `${numero} doit être secondaire`);
  }

  // Le défaut de production, en une ligne : quatre lignes, quatre « principale ».
  assert.equal(
    (html.match(/>principale</g) || []).length,
    1,
    'une seule ligne principale, c\'est tout l\'objet du lot 9'
  );

  // Le vocabulaire de Free a disparu de l'écran : il supposait de connaître ses
  // usages, et il était faux en production sur trois lignes sur quatre.
  assert.equal(html.includes('>résiliée<'), false, '« résiliée » n\'est plus un badge');
  assert.equal(html.includes('>inconnu<'), false, '« inconnu » non plus');

  // L'avertissement sur les lignes résiliées reste : il est juste, et il dit ce
  // qui se perd.
  assert.ok(html.includes('12 dernières'), 'l\'avertissement de rétention reste');
});

test('Écran de sélection : le numéro identifie, le nom complète', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile", { edit: true })');
  await app.run('rediscover()');

  const html = app.html('modal-fields');
  const bloc = html.split('<label class="multi-item">').find((b) => b.includes('0628000000'));
  assert.ok(bloc, 'la première ligne doit être rendue');

  // Le défaut du lot 8 : quatre lignes du même compte portent le MÊME nom de
  // titulaire. Mis en évidence, il ne distingue rien.
  assert.match(
    bloc,
    /<span class="multi-label">0628000000<\/span>/,
    'le numéro est en évidence'
  );
  assert.match(
    bloc,
    /<span class="multi-sub">Camille Dupont · 12 factures<\/span>/,
    'le nom et le nombre de factures passent dessous, ensemble'
  );

  // Et l'ordre à l'écran suit : le numéro AVANT le nom, pas l'inverse.
  assert.ok(
    bloc.indexOf('0628000000') < bloc.indexOf('Camille Dupont'),
    'le numéro doit précéder le nom dans le document'
  );
});

// ---------------------------------------------------------------------------
// Lot 7 — « Mes documents »
//
// L'écran rétabli. Le lot 3 avait retiré la vue « Stockage local » en même temps que
// « Mes Papiers », et l'utilisateur s'est retrouvé quatre lots durant sans
// aucun moyen de voir ses documents depuis crabe.
// ---------------------------------------------------------------------------

test('Mes documents : l\'arborescence, la taille, la date, et le téléchargement', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');
  // L'arborescence est ce que montre la présentation en LISTE. Depuis le lot
  // 20, la présentation en cartes montre d'abord les services (voir plus bas).
  app.run('setDocsView("list")');

  const html = app.html('docs-content');
  assertScreen(html, {
    label: 'Mes documents',
    contains: [
      'Free Internet',          // le connecteur
      'fbx11111111',            // le compte
      '202507_free.pdf',        // le document
      '2026-07',                // sa période
      'Télécharger',
      '/api/documents/local/6/file',
      // Recherche et filtres
      'Rechercher un document',
      'Tous les services',
      'Toutes les périodes',
    ],
  });

  // Un fichier disparu du stockage est signalé, et son téléchargement retiré :
  // proposer un bouton qui répondrait 404 serait pire que rien.
  assert.ok(html.includes('est plus présent sur cet espace de stockage'));
  assert.equal(
    html.includes('/api/documents/local/5/file'),
    false,
    'aucun téléchargement pour un fichier absent'
  );

  // Écran de CONSULTATION : rien qui touche aux fichiers.
  for (const mot of ['Supprimer', 'Renommer', 'Déplacer']) {
    assert.equal(html.includes(mot), false, `« ${mot} » n'a rien à faire ici`);
  }
});

test('Mes documents : un seul espace de stockage, donc aucun sélecteur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderDocuments()');

  // Une liste déroulante à une seule entrée est un choix qui n'en est pas un.
  assert.equal(app.html('docs-content').includes('docs-dests'), false);
});

test('Mes documents : plusieurs espaces, le principal en tête et sélectionné', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    const base = JSON.parse(JSON.stringify(FIXTURE_DOCUMENTS));
    base.destinations.push({
      id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
      primary: false, available: true, reason: null,
    });
    api = (path) => (String(path).startsWith('/documents')
      ? Promise.resolve(JSON.parse(JSON.stringify(base)))
      : __fixture(path));
  `);
  await app.run('renderDocuments()');

  const html = app.html('docs-content');
  assert.ok(html.includes('docs-dests'), 'le sélecteur apparaît dès qu\'il y a un choix');
  assert.ok(html.includes('Proton Drive'));
  assert.ok(html.includes("setDocsDestination('proton')"));
  // La principale est retenue par défaut : elle répond sans traverser le réseau.
  assert.ok(/pill active"[^>]*onclick="setDocsDestination\('local'\)/.test(html));
});

test('Espace injoignable : on le dit simplement, et on propose les autres', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    const panne = JSON.parse(JSON.stringify(FIXTURE_DOCUMENTS));
    panne.available = false;
    panne.reason = "Cet espace de stockage n'est pas connecté pour le moment.";
    panne.tree = [];
    panne.total = 0;
    panne.shown = 0;
    panne.destinations = [
      { id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
        primary: true, available: false,
        reason: "Cet espace de stockage n'est pas connecté pour le moment." },
      { id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
        primary: false, available: true, reason: null },
    ];
    panne.destination = panne.destinations[0];
    api = (path) => (String(path).startsWith('/documents')
      ? Promise.resolve(JSON.parse(JSON.stringify(panne)))
      : __fixture(path));
  `);
  await app.run('renderDocuments()');

  const html = app.html('docs-content');
  assertScreen(html, {
    label: 'Mes documents → espace injoignable',
    contains: [
      'n&#39;est pas connecté pour le moment',
      'Vos documents restent consultables ici',
      "setDocsDestination('proton')",
    ],
  });
  // Surtout pas une liste vide, qui laisserait croire à une perte.
  assert.equal(html.includes('Aucun document pour l&#39;instant'), false);
});

test('Recherche sans résultat : on distingue « rien trouvé » de « rien du tout »', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    const vide = JSON.parse(JSON.stringify(FIXTURE_DOCUMENTS));
    vide.tree = [];
    vide.shown = 0;          // la recherche ne ramène rien…
    vide.total = 2;          // …mais l'espace n'est pas vide pour autant
    api = (path) => (String(path).startsWith('/documents')
      ? Promise.resolve(JSON.parse(JSON.stringify(vide)))
      : __fixture(path));
  `);
  await app.run('renderDocuments()');

  const html = app.html('docs-content');
  assert.ok(html.includes('Aucun document ne correspond à votre recherche'));
  assert.ok(html.includes('resetDocsFilters()'), 'et de quoi en sortir');
});

test('Mes documents : l\'écran tient aux cinq points de rupture, en cartes comme en liste', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');

  // Les DEUX affichages sont mesurés : une grille de cartes se comporte
  // autrement qu'une pile de lignes, et n'en vérifier qu'un laisserait la
  // moitié de l'écran sans preuve. Les cartes d'abord — c'est le défaut.
  assertFits(app.html('docs-content'), { label: 'Mes documents (cartes)' });

  app.run('setDocsView("list")');
  assertFits(app.html('docs-content'), { label: 'Mes documents (liste)' });
});

// ---------------------------------------------------------------------------
// Lot 6 — connexion par navigateur distant
//
// Le rendu VNC lui-même ne s'observe qu'à l'œil, sur le LXC. Ce qui se vérifie
// ici, c'est tout le reste : que le bouton est le geste principal, qu'il se
// grise AVEC son explication quand les paquets manquent, que le repli par
// fichier n'a rien perdu, et que le flux part bien vers le relais de crabe avec
// son jeton.
// ---------------------------------------------------------------------------

/** Remplace la réponse de `capabilities`, puis rouvre la fiche. */
function avecPrerequis(app, caps) {
  app.run(`state.remoteLogin.caps = ${JSON.stringify(caps)}`);
  app.run('openModal("free-mobile", { edit: true })');
  // Le bouton principal vit dans `modal-actions` depuis le lot 7 ; les options
  // avancées, dans `modal-fields`. On rend les deux, c'est bien l'écran entier
  // qu'on juge.
  return app.html('modal-actions') + app.html('modal-fields');
}

test('Fiche non connectée : une phrase, un bouton, et rien d\'autre de visible', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  // Le cas de l'écran 1 de la mission : le connecteur n'est pas encore connecté.
  app.run(`
    const fm = state.connectors.find((c) => c.id === 'free-mobile');
    fm.status = 'needs-config';
    fm.configSummary = null;
    fm.health = {
      code: 'not-configured', title: 'Non connecté',
      detail: 'Free Mobile n\\'est pas encore configuré.', tone: 'amber',
      action: { id: 'connect', label: 'Se connecter à Free Mobile' },
      canSync: false, canReconfigure: true, connected: false, followedLabel: null,
    };
  `);
  app.run('openModal("free-mobile")');

  const corps = app.html('modal-fields');
  const actions = app.html('modal-actions');

  // L'état est sous le nom, pas noyé dans un cadre.
  assert.equal(app.run('$("modal-cat").textContent'), 'Non connecté');

  // Le geste principal, nommé par son fournisseur.
  assertScreen(actions, {
    label: 'Fiche Free Mobile → bouton principal',
    contains: ['Se connecter à Free Mobile', "openRemoteLogin('free-mobile')", 'btn-remote'],
  });
  assert.equal(actions.includes('disabled'), false, 'le bouton doit être cliquable');

  // Ce qui a été retiré du premier niveau, et qui faisait tout l'encombrement.
  const premierNiveau = corps.slice(0, corps.indexOf('adv-body'));
  for (const jargon of [
    'Choisir un fichier',      // le repli par fichier
    'Coller le contenu',
    'capture-session',         // la ligne de commande
    'Tester la connexion',
    'Désinstaller',
    'Lignes à récupérer',      // un cadre vide avant toute découverte
  ]) {
    assert.equal(
      premierNiveau.includes(jargon),
      false,
      `« ${jargon} » ne doit plus être visible d'emblée sur la fiche`
    );
  }

  // Le repli existe, il est annoncé, et il est replié.
  assert.ok(corps.includes('Options avancées'), 'le repli doit être annoncé');
  assert.ok(/id="adv-body" style="display:none;"/.test(corps), 'et replié par défaut');

  // Lot 9 — il ne contient plus QUE quatre choses : la validité de la
  // connexion, « Se reconnecter », le choix des éléments suivis, la
  // désinstallation. Le dépôt de fichier est passé dans l'administration, et
  // « Tester la connexion » faisait double emploi avec l'état de la fiche.
  for (const conserve of ['Se reconnecter', 'Désinstaller']) {
    assert.ok(corps.includes(conserve), `« ${conserve} » doit rester accessible`);
  }
  for (const parti of [
    'Choisir un fichier', 'readSessionFile(', 'Coller le contenu',
    'capture-session', 'Tester la connexion',
  ]) {
    assert.equal(corps.includes(parti), false, `« ${parti} » ne doit plus être sur la fiche`);
  }
});

test('Fiche connectée : ce que crabe a fait, et deux gestes', async () => {
  const app = makeSandbox(FIXTURES);
  const corps = await ouvrirFiche(app, 'free-mobile');
  const actions = app.html('modal-actions');

  // L'état et le suivi, sous le nom.
  assert.equal(app.run('$("modal-cat").textContent'), 'Connecté · 1 ligne suivie');

  assertScreen(corps, {
    label: 'Fiche Free Mobile → connectée',
    contains: ['Dernière récupération', '30 factures récupérées', 'Options avancées'],
  });

  // Récupérer, ou modifier. Pas six boutons.
  assert.ok(actions.includes('Récupérer maintenant'), 'le geste attendu');
  assert.ok(actions.includes('Modifier'), 'et de quoi revenir sur sa configuration');
  assert.ok(actions.includes("reconfigureConnector('free-mobile')"));
  assert.equal(actions.includes('Se connecter à'), false, 'inutile une fois connecté');
});

test('Prérequis manquants : bouton grisé AVEC l\'explication, repli mis en avant', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');

  const html = avecPrerequis(app, {
    available: false,
    busy: false,
    reason:
      'Connexion par navigateur indisponible — il manque : Xvfb, noVNC. '
      + 'Vous pouvez continuer avec un fichier de session.',
    missing: [{ id: 'Xvfb', label: 'Xvfb', detail: '…', remedy: 'apt install xvfb' }],
  });

  assertScreen(html, {
    label: 'Fiche Free Mobile → prérequis absents',
    contains: ['Se connecter à Free Mobile', 'il manque : Xvfb, noVNC', 'fichier de session'],
  });

  assert.ok(/class="btn-remote"[^>]*\n?\s*disabled/.test(html) || html.includes('disabled'),
    'le bouton doit être grisé');
  assert.equal(
    html.includes('id="session-fallback-session" style="display:none;"'),
    false,
    'le repli devient le seul chemin : il est déjà déplié'
  );
  // Un bouton grisé n'a pas à porter l'avertissement d'une action impossible.
  assert.equal(html.includes('rb-warn'), false);
});

test('Une connexion déjà en cours grise le bouton, pour une raison qui passera', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');

  const html = avecPrerequis(app, { available: true, busy: true, reason: null, missing: [] });

  assert.ok(html.includes('disabled'), 'le bouton doit être grisé');
  assert.ok(
    html.includes('déjà en cours sur ce serveur'),
    'dire que c\'est temporaire, pas que c\'est cassé'
  );
  assert.ok(html.includes('Réessayez dans quelques minutes'));
});

test('Un connecteur sans navigateur distant renvoie « Se reconnecter » sur la saisie', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('state.connectors.find((c) => c.id === "free-mobile").remoteLogin = null');
  app.run('openModal("free-mobile", { edit: true })');

  const html = app.html('modal-fields');
  assert.equal(html.includes('btn-remote'), false, 'aucun bouton de navigateur distant');
  // Le geste existe toujours : il repasse la fiche en saisie au lieu d'ouvrir
  // une fenêtre. Ce qui a disparu, c'est le fichier — parti dans
  // l'administration (lot 9, §4).
  assert.ok(html.includes('Se reconnecter'));
  assert.ok(html.includes("reconfigureConnector('free-mobile')"));
  assert.equal(html.includes('Choisir un fichier'), false, 'plus de dépôt de fichier ici');
  assert.equal(html.includes('capture-session'), false, 'ni de ligne de commande');
});

/**
 * Attend qu'une condition devienne vraie, ou renonce.
 *
 * Le champ « Coller un texte » se vide DEUX SECONDES après la saisie, le temps
 * que « Texte saisi » se lise. Une attente fixe rendrait le test lent et
 * fragile ; celle-ci rend la main dès que le champ est vide.
 */
async function attendreQue(condition, { limiteMs = 4000 } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Ouvre la modale du navigateur distant avec un client noVNC simulé.
 *
 * Le double retient tout ce que crabe lui demande — écouteurs, focus, touches
 * envoyées, presse-papiers poussé — parce que c'est précisément là que se joue
 * l'utilisabilité du lot 7 : sans clavier au premier plan et sans collage, la
 * fenêtre est jolie et inutilisable.
 */
async function ouvrirNavigateur(app) {
  app.run(`
    fluxNovnc = [];
    rbDouble = null;
    loadNovnc = async () => function FauxRFB(cible, url, options) {
      fluxNovnc.push({ url, options });
      this.ecouteurs = {};
      this.touches = [];
      this.presses = [];
      this.focus = () => fluxNovnc.push({ focus: true });
      this.sendKey = (keysym) => this.touches.push(keysym);
      // Le nom de la méthode dépend de la version de noVNC installée sur le
      // LXC : le double porte celui de la branche récente, et un test vérifie
      // que son absence n'empêche rien.
      this.clipboardPaste = (texte) => this.presses.push(texte);
      this.addEventListener = (nom, fn) => { this.ecouteurs[nom] = fn; };
      this.disconnect = () => fluxNovnc.push({ ferme: true });
      rbDouble = this;
    };
  `);
  await app.run('openRemoteLogin("free-mobile")');
}

test('Modale du navigateur : le flux part vers le relais de crabe, avec son jeton', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    const flux = app.run('fluxNovnc[0]');
    assert.ok(flux, 'le client noVNC doit avoir été branché');

    // Le flux passe par crabe — jamais en direct sur websockify — et porte le
    // jeton à usage unique délivré par le serveur.
    assert.match(flux.url, /^ws:\/\//);
    assert.ok(
      flux.url.includes('/api/connectors/remote-login/stream'),
      `relais attendu, reçu : ${flux.url}`
    );
    assert.ok(flux.url.includes('token=jeton-de-test'), 'le jeton doit accompagner le flux');
    assert.ok(flux.url.includes('connector=free-mobile'));
    // Le mot de passe VNC voyage en identifiant RFB, pas dans l'URL.
    assert.equal(flux.options.credentials.password, 'mdp-vnc-de-test');
    assert.equal(flux.url.includes('mdp-vnc-de-test'), false);

    // La modale est ouverte, en mode large.
    const overlay = app.elements.get('rb-overlay');
    assert.ok(overlay.classList.contains('show'));
    assert.ok(overlay.classList.contains('rb-open'), 'la classe du plein écran sous 1024 px');
    assert.equal(app.run('$("rb-name").textContent'), 'Se connecter à Free Mobile');
    // UN SEUL bandeau depuis le lot 14 (§7.4) : il en portait deux, qui
    // disaient la même chose. Celui qui reste dit la seule information utile —
    // la fenêtre se ferme seule, la connexion dure — et n'ajoute l'indice du
    // manifeste que s'il apprend autre chose.
    const bandeau = app.run('$("rb-banner").textContent');
    assert.match(bandeau, /la fenêtre se fermera d'elle-même/i);
    assert.match(bandeau, /valable environ un an/i);
    assert.match(bandeau, /Se souvenir de cet appareil/, 'l\'indice propre au service est gardé');

    // Le compte à rebours affiche le temps restant, pas un compteur muet.
    assert.match(app.run('$("rb-countdown").textContent'), /^\d+:\d\d$/);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Annuler ferme la modale et éteint le navigateur côté serveur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  await app.run('cancelRemoteLogin()');

  const overlay = app.elements.get('rb-overlay');
  assert.equal(overlay.classList.contains('show'), false);
  assert.equal(overlay.classList.contains('rb-open'), false);
  assert.ok(app.run('fluxNovnc.some((f) => f.ferme)'), 'le flux doit être coupé');
  assert.equal(app.run('state.remoteLogin.connectorId'), null);
  assert.ok(
    app.calls.api.includes('/connectors/free-mobile/remote-login'),
    'le serveur doit être prévenu'
  );
});

test('Le clavier répond dès l\'ouverture, sans avoir à cliquer dans la fenêtre', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Le voile ne se lève qu'à la connexion effective du flux…
    assert.equal(app.run('$("rb-veil").className'), 'rb-veil');

    app.run('rbDouble.ecouteurs.connect()');

    assert.equal(app.run('$("rb-veil").className'), 'rb-veil hidden');
    assert.ok(
      app.run('fluxNovnc.some((f) => f.focus)'),
      'le focus doit être donné au flux : sans lui, on tape dans le vide'
    );
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

/**
 * Le pavé numérique — le défaut bloquant constaté en production.
 *
 * Un code de validation SMS à six chiffres se saisit au pavé. Les frappes
 * partaient bien, mais en keysyms de pavé, dont la valeur dépend du verrou
 * numérique du serveur X : éteint sur un `Xvfb` neuf, où `KP_0` vaut « Inser ».
 * Résultat : rien à l'écran, rien dans les journaux.
 */
test('Le pavé numérique arrive jusqu\'au site, sous sa forme ordinaire', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    const frappe = (code, key) =>
      app.run(`(() => {
        const evenement = {
          code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, location: 3,
          target: { tagName: 'CANVAS' },
          defaut: 0, arret: 0,
          preventDefault() { this.defaut++; },
          stopImmediatePropagation() { this.arret++; },
        };
        __touche('keydown', evenement);
        return { defaut: evenement.defaut, arret: evenement.arret };
      })()`);

    // Les six chiffres d'un code de validation, tapés au pavé.
    for (const chiffre of '481952') frappe(`Numpad${chiffre}`, chiffre);

    const touches = JSON.parse(app.run('JSON.stringify(rbDouble.touches)'));
    assert.deepEqual(
      touches,
      [...'481952'].map((c) => c.codePointAt(0)),
      'chaque chiffre du pavé doit partir comme celui de la rangée du haut'
    );

    // La frappe est confisquée à noVNC : sans ça, la touche part deux fois —
    // une fois juste, une fois en keysym de pavé.
    const dernier = frappe('NumpadEnter', 'Enter');
    assert.equal(dernier.defaut, 1, 'l\'action par défaut du navigateur est coupée');
    assert.equal(dernier.arret, 1, 'et l\'événement n\'atteint pas le clavier de noVNC');
    assert.equal(app.run('rbDouble.touches.at(-1)'), 0xff0d, 'XK_Return');

    // Le relâchement est avalé lui aussi, sans rien envoyer de plus : `sendKey`
    // a déjà émis l'appui ET le relâchement.
    const avant = app.run('rbDouble.touches.length');
    app.run(`__touche('keyup', {
      code: 'Numpad4', key: '4', location: 3, target: { tagName: 'CANVAS' },
      preventDefault() {}, stopImmediatePropagation() {},
    })`);
    assert.equal(app.run('rbDouble.touches.length'), avant, 'aucune touche en trop au relâchement');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Le champ « Coller un mot de passe » garde son propre pavé numérique', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Le champ de collage vit dans la même modale : y taper des chiffres au
    // pavé doit rester possible, sinon on répare une fenêtre en cassant l'autre.
    const resultat = app.run(`(() => {
      const evenement = {
        code: 'Numpad7', key: '7', location: 3,
        target: { tagName: 'INPUT' },
        defaut: 0,
        preventDefault() { this.defaut++; },
        stopImmediatePropagation() {},
      };
      __touche('keydown', evenement);
      return evenement.defaut;
    })()`);

    assert.equal(resultat, 0, 'la frappe destinée à un champ de crabe n\'est pas détournée');
    assert.equal(app.run('rbDouble.touches.length'), 0, 'et rien ne part vers la fenêtre');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Modale fermée, le clavier n\'est plus détourné', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);
  await app.run('cancelRemoteLogin()');

  // L'écouteur vit pour la page entière : il ne doit rien faire hors session.
  app.run(`__touche('keydown', {
    code: 'Numpad7', key: '7', location: 3, target: { tagName: 'CANVAS' },
    preventDefault() {}, stopImmediatePropagation() {},
  })`);
  assert.equal(app.run('rbDouble.touches.length'), 0);
});

test('Coller un texte : le champ est visible d\'emblée, sans rien à déplier', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Lot 10 : plus aucun repli. Ctrl+V ne traverse pas jusqu'au navigateur
    // distant, ce champ est donc la voie PRINCIPALE — la cacher derrière un
    // lien revenait à rendre la fenêtre inutilisable pour qui range ses mots
    // de passe dans un gestionnaire.
    assert.notEqual(app.run('$("rb-paste").style.display'), 'none');
    assert.equal(app.run('typeof toggleRemotePaste'), 'undefined', 'plus de bascule');

    const texte = app.run('$("rb-paste-note").textContent')
      + app.run('$("rb-paste-send").textContent');
    assert.match(texte, /Envoyer/);
    assert.match(texte, /Ctrl\+V/);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('« Envoyer » fait frapper le texte par le SERVEUR, et il ne traîne pas', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    app.run('$("rb-paste-input").value = "Mot2Passé!"');
    await app.run('pasteIntoRemote()');

    // Lot 12 : la frappe passe par le serveur, qui parle directement au
    // navigateur (Playwright). Elle ne dépend plus ni de la version de noVNC
    // installée sur le LXC, ni de la table de keysyms d'un Xvfb frais, ni du
    // focus de la toile — les trois raisons pour lesquelles le chemin noVNC
    // échouait EN SILENCE, en annonçant quand même « Saisi dans la fenêtre ».
    assert.ok(
      app.calls.api.includes('/connectors/free-mobile/remote-login/type'),
      'la saisie doit passer par le serveur'
    );
    assert.equal(app.run('rbDouble.touches.length'), 0, 'plus de keysyms quand le serveur répond');

    // Le presse-papiers distant est servi EN COMPLÉMENT (pour qui préfère Ctrl+V).
    assert.equal(app.run('JSON.stringify(rbDouble.presses)'), JSON.stringify(['Mot2Passé!']));

    // Lot 13 : « Texte saisi » pendant deux secondes, puis le champ se vide.
    assert.equal(app.run('$("rb-paste-send").disabled'), false);
    assert.match(app.run('$("rb-paste-note").textContent'), /Texte saisi/);

    assert.ok(
      await attendreQue(() => app.run('$("rb-paste-input").value') === ''),
      'un mot de passe ne reste pas dans un champ du DOM'
    );
    assert.match(app.run('$("rb-paste-note").textContent'), /Cliquez d'abord/);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Le texte collé n\'est jamais journalisé, ni en URL ni en notification', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  const secret = 'S3cr3t-Qu-On-Ne-Doit-Jamais-Voir!';
  try {
    app.run(`$("rb-paste-input").value = ${JSON.stringify(secret)}`);
    await app.run('pasteIntoRemote()');

    // L'URL finit dans les journaux d'accès du serveur web : le texte part
    // dans le CORPS de la requête, jamais dans le chemin ni la requête.
    for (const url of app.calls.api) {
      assert.ok(!String(url).includes(secret), `le texte apparaît dans l'URL ${url}`);
    }
    for (const toast of app.calls.toasts) {
      assert.ok(!String(toast).includes(secret), 'le texte apparaît dans une notification');
    }

    // Ni dans le champ, ni dans la consigne affichée en dessous.
    assert.ok(await attendreQue(() => app.run('$("rb-paste-input").value') === ''));
    assert.ok(!app.run('$("rb-paste-note").textContent').includes(secret));
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Si le serveur ne peut pas frapper, les keysyms prennent le relais', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Serveur d'une version ANTÉRIEURE, et lui seul : la route n'existe pas
    // (404). Le chemin historique reste là et fait le travail.
    //
    // Lot 13 : ce repli ne se déclenche plus sur n'importe quelle erreur. Un
    // refus motivé du serveur (409 « cliquez d'abord dans le champ ») doit être
    // AFFICHÉ, pas contourné par des keysyms qui repartiront dans le vide en
    // annonçant un succès — c'est ce qui rendait ce champ inutilisable.
    app.run(`
      const apiDeBase = api;
      api = (chemin, options) => {
        if (String(chemin).endsWith('/remote-login/type')) {
          const err = new Error('Cannot POST');
          err.status = 404;
          throw err;
        }
        return apiDeBase(chemin, options);
      };
    `);
    app.run('$("rb-paste-input").value = "Mot2Passé!"');
    await app.run('pasteIntoRemote()');

    const touches = JSON.parse(app.run('JSON.stringify(rbDouble.touches)'));
    assert.equal(touches.length, 'Mot2Passé!'.length, 'un keysym par caractère');
    assert.equal(touches[0], 'M'.codePointAt(0), 'ASCII : le keysym vaut le point de code');
    // « é » (U+00E9) reste en Latin-1 ; au-delà, la convention X11 décale.
    assert.equal(touches[8], 0xe9);
    assert.match(app.run('$("rb-paste-note").textContent'), /Texte saisi/);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Un noVNC sans méthode de presse-papiers n\'empêche pas la saisie', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Le paquet `novnc` du LXC n'est pas celui du dépôt : selon la version, la
    // méthode s'appelle `clipboardPasteFrom`, `clipboardPaste`, ou n'existe
    // pas du tout. Aucun de ces cas ne doit empêcher la saisie — et c'est
    // précisément pour cela qu'elle ne passe plus par lui.
    app.run('delete rbDouble.clipboardPaste');
    app.run('$("rb-paste-input").value = "1234"');
    await app.run('pasteIntoRemote()');

    assert.ok(app.calls.api.includes('/connectors/free-mobile/remote-login/type'));
    assert.match(app.run('$("rb-paste-note").textContent'), /Texte saisi/);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Envoyer sans avoir rien collé le dit, plutôt que de ne rien faire', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    await app.run('pasteIntoRemote()');
    assert.match(app.run('$("rb-paste-note").textContent'), /Collez d'abord/);
    assert.equal(app.run('rbDouble.touches.length'), 0);
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Le presse-papiers du poste est poussé vers la fenêtre au collage', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Complément du champ « Coller un texte » : quand le navigateur laisse
    // passer l'événement, on pousse aussi le presse-papiers de l'autre côté.
    app.run(`__paste({
      target: { tagName: 'CANVAS' },
      clipboardData: { getData: () => 'depuis-mon-gestionnaire' },
    })`);
    assert.equal(
      app.run('JSON.stringify(rbDouble.presses)'),
      JSON.stringify(['depuis-mon-gestionnaire'])
    );
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Un collage DANS le champ de crabe ne part pas au serveur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    app.run(`__paste({
      target: { tagName: 'INPUT' },
      clipboardData: { getData: () => 'mon-mot-de-passe' },
    })`);
    assert.equal(app.run('rbDouble.presses.length'), 0, 'c\'est « Envoyer » qui décide');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Ctrl+A, Ctrl+C et Ctrl+X partent à noVNC avec leur modificateur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Une combinaison ne doit JAMAIS être détournée par le relais du pavé :
    // `sendKey` n'envoie qu'un keysym nu, et renvoyer « 4 » à la place de
    // « Ctrl+4 » perdrait le raccourci en silence. noVNC, lui, sait
    // transmettre les modificateurs — on le laisse faire.
    for (const key of ['a', 'c', 'x']) {
      app.run(`__touche('keydown', {
        code: 'Key${key.toUpperCase()}', key: '${key}', ctrlKey: true,
        target: { tagName: 'CANVAS' },
        preventDefault() {}, stopImmediatePropagation() {},
      })`);
    }
    // Même au pavé numérique, où le relais serait normalement compétent.
    app.run(`__touche('keydown', {
      code: 'Numpad4', key: '4', location: 3, ctrlKey: true,
      target: { tagName: 'CANVAS' },
      preventDefault() {}, stopImmediatePropagation() {},
    })`);

    assert.equal(app.run('rbDouble.touches.length'), 0, 'aucune touche renvoyée sans modificateur');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Échec d\'ouverture : une consigne, un bouton Réessayer, et pas de jargon', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('state.remoteLogin.connectorId = "free-mobile"');

  // Incident serveur : l'utilisateur n'a rien à faire du détail technique, qui
  // part au journal d'administration (voir middleware.errorHandler).
  app.run(`
    const incident = new Error('spawn Xvfb ENOENT');
    incident.status = 500;
    failRemoteLogin(incident);
  `);

  assert.equal(
    app.run('$("rb-result").textContent'),
    'La fenêtre de connexion n\'a pas pu s\'ouvrir. Réessayez dans un instant.'
  );
  assert.equal(app.run('$("rb-veil-text").textContent').includes('ENOENT'), false);
  assert.equal(app.run('$("rb-retry").style.display'), 'block', 'Réessayer doit apparaître');
  assert.equal(app.run('$("rb-cancel").textContent'), 'Fermer');
});

test('Refus expliqué par le serveur : c\'est LUI qu\'on affiche, pas une phrase creuse', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  app.run('state.remoteLogin.connectorId = "free-mobile"');

  // 409 et 503 sont rédigés à l'intention de l'utilisateur : ils portent une
  // consigne (attendre, libérer de la mémoire, installer un paquet).
  for (const status of [409, 503]) {
    app.run(`
      failRemoteLogin(Object.assign(
        new Error('Une autre connexion par navigateur est en cours sur ce serveur.'),
        { status: ${status} }
      ));
    `);
    assert.equal(
      app.run('$("rb-result").textContent'),
      'Une autre connexion par navigateur est en cours sur ce serveur.',
      `statut ${status} : le message du serveur doit être conservé`
    );
  }
});

test('Le voile annonce une progression, pas un rond qui tourne indéfiniment', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');

  // Les étapes sont déclarées, ordonnées, et la première est immédiate.
  const etapes = JSON.parse(app.run('JSON.stringify(RB_ETAPES)'));
  assert.ok(etapes.length >= 2, 'au moins deux étapes annoncées');
  assert.equal(etapes[0].apres, 0);
  assert.match(etapes[0].texte, /Ouverture du navigateur/);
  assert.match(etapes[1].texte, /Chargement du site/);
  for (let i = 1; i < etapes.length; i++) {
    assert.ok(etapes[i].apres > etapes[i - 1].apres, 'les étapes avancent dans le temps');
  }

  app.run('startRemoteStages()');
  assert.equal(app.run('$("rb-veil-text").textContent'), 'Ouverture du navigateur…');
  app.run('stopRemoteStages()');
  assert.equal(app.run('state.remoteLogin.stages'), null);
});

test('Session détectée : la modale se referme et la fiche enchaîne sur la découverte', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  // Ce que le serveur renvoie une fois la session capturée et chiffrée.
  await app.run(`finishRemoteLogin({
    state: 'saved', done: true, connectorId: 'free-mobile',
    message: 'Session enregistrée.',
    result: { fieldKey: 'session', discovery: true,
              summary: { expiresAt: '2027-02-05T21:40:00.000Z', cookieCount: 7 } },
  })`);

  assert.equal(app.elements.get('rb-overlay').classList.contains('show'), false);

  // Et on enchaîne sur l'écran de choix — il y a quatre lignes à départager.
  const html = app.html('modal-fields');
  assertScreen(html, {
    label: 'Après connexion → sélection des lignes',
    contains: ['Quelles lignes voulez-vous suivre ?', '0628000000', 'Les lignes résiliées'],
  });
  assert.equal(app.elements.get('modal-discovery-actions').style.display, 'flex');
});

// ---------------------------------------------------------------------------
// Lot 48 — « Enregistrer » cesse d'être muet, et la fenêtre sait renoncer.
//
// Le 22/08/2026 au soir : sept connexions réussies côté sites, une seule
// session enregistrée, et un bouton « Enregistrer » qui « n'a rien fait ».
// Ces tests MORDENT : retirez l'affichage du verdict (échec, succès ou
// indéterminé), la rangée « renoncer » ou le bouton de sortie permanent, et
// ils tombent.
// ---------------------------------------------------------------------------

test('« Enregistrer » en échec : le verdict du serveur est affiché, tel quel', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    app.run(`
      api = async (path) => {
        if (String(path).endsWith('/remote-login/save')) {
          const refus = new Error(
            'La page qui sert à vérifier votre connexion n\\'existe pas à '
            + 'l\\'adresse prévue. Ce service a besoin d\\'être corrigé — signalez-le.'
          );
          refus.status = 409;
          throw refus;
        }
        return __fixture(path);
      };
    `);
    await app.run('saveRemoteSession()');

    const verdict = app.run('$("rb-result").textContent');
    assert.match(verdict, /n'existe pas à l'adresse prévue/,
      'le verdict doit être à l\'écran — le bouton muet est LE défaut du 22/08/2026');
    assert.match(verdict, /signalez-le/, 'et il dit quoi faire');
    assert.equal(app.run('$("rb-result").className'), 'test-result show fail');
  } finally {
    app.run('api = (path) => __fixture(path)');
    await app.run('cancelRemoteLogin()');
  }
});

test('« Enregistrer » en échec sans message serveur : l\'écran dit QUAND MÊME quelque chose', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Le cas du 22/08/2026 : la route écrasait le verdict, le client recevait
    // `error: null` et fabriquait « Erreur 409 ». Même si ça se reproduisait,
    // l'écran ne doit plus rester générique et inutile.
    app.run(`
      api = async (path) => {
        if (String(path).endsWith('/remote-login/save')) {
          const refus = new Error('Erreur 409');
          refus.status = 409;
          throw refus;
        }
        return __fixture(path);
      };
    `);
    await app.run('saveRemoteSession()');

    const verdict = app.run('$("rb-result").textContent');
    assert.notEqual(verdict, '', 'jamais un écran vide après un clic');
    assert.notEqual(verdict, 'Erreur 409', 'jamais un code brut comme seul verdict');
    assert.match(verdict, /Réessayez|fermez la fenêtre/,
      'à défaut de verdict serveur, une consigne');
  } finally {
    app.run('api = (path) => __fixture(path)');
    await app.run('cancelRemoteLogin()');
  }
});

test('Trois vérifications infructueuses : l\'écran propose explicitement de renoncer', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    // Deux échecs : on continue d'essayer, pas de proposition de sortie.
    app.run(`applyRemoteView({
      state: 'running', message: 'En attente', attenteManuelle: true, echecsVerification: 2,
    })`);
    assert.equal(app.run('$("rb-renoncer-row").style.display'), 'none');

    // Trois : la sortie est proposée, à côté d'« Enregistrer ».
    app.run(`applyRemoteView({
      state: 'running', message: 'En attente', attenteManuelle: true, echecsVerification: 3,
    })`);
    assert.equal(app.run('$("rb-renoncer-row").style.display'), 'flex',
      'après trois échecs, l\'écran doit offrir de renoncer');
    assert.equal(app.run('$("rb-save-row").style.display'), 'flex',
      '« Enregistrer » reste disponible : renoncer est un choix, pas une sanction');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Session enregistrée : le verdict de réussite est affiché, avec le compte de cookies', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  await app.run(`finishRemoteLogin({
    state: 'saved', done: true, connectorId: 'free-mobile',
    message: 'Session enregistrée — 7 cookie(s) gardé(s).',
    result: { fieldKey: 'session', discovery: true,
              summary: { expiresAt: '2027-02-05T21:40:00.000Z', cookieCount: 7 } },
  })`);

  assert.equal(app.elements.get('rb-overlay').classList.contains('show'), false,
    'la fenêtre se ferme sur un succès');
  assert.ok(
    app.calls.toasts.some((t) => /7 cookie\(s\) gardé\(s\)/.test(t)),
    'le succès est DIT, pas seulement déduit de la fermeture'
  );
});

test('« Fermer / Abandonner » est offert dès l\'ouverture, pas seulement après un échec', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadConnectors()');
  await ouvrirNavigateur(app);

  try {
    assert.equal(app.run('$("rb-cancel").textContent'), 'Fermer / Abandonner',
      'la sortie est permanente : la fenêtre ne retient jamais l\'utilisateur');
  } finally {
    await app.run('cancelRemoteLogin()');
  }
});

test('Modale du navigateur : elle tient aux cinq points de rupture', async () => {
  const app = makeSandbox(FIXTURES);
  const html = await ouvrirFiche(app, 'free-mobile');

  // Le champ de session porte désormais un bouton pleine largeur, un
  // avertissement et un repli replié : rien de tout cela ne doit déborder.
  assertFits(html, { label: 'Fiche Free Mobile (lot 6)' });
});

test('Profil : stockage, connecteurs, permissions et demandes', async () => {
  const app = makeSandbox(FIXTURES);

  await app.run('renderProfilStorage()');
  assertScreen(app.html('my-storage-rows'), {
    label: 'Profil → Stockage',
    contains: ['Factures récupérées ce mois-ci', 'Total de factures stockées'],
  });

  // Le quota depuis le lot 59 : le poids des documents, la phrase qui dit que
  // chaque destination reçoit une copie complète, puis la répartition — et
  // AUCUN total cumulé, aucune barre, aucun pourcentage global.
  const quota = app.html('my-storage-quota');
  assertScreen(quota, {
    label: 'Profil → Stockage (quota)',
    contains: [
      'quota-used',
      'quota-note',
      'copie complète',
      'Répartition par destination active',
      'Stockage local',
    ],
  });
  // 608 174 octets → « 593.9 Ko » : l'unité suit la valeur.
  assert.ok(quota.includes('593.9 Ko'), 'le poids des documents en tête');
  assert.ok(quota.includes('vos 6 documents'), 'le nombre de documents qualifie le chiffre');
  // La capacité des destinations ne s'additionne plus : 550 Go est celle du
  // stockage local SEUL, elle n'apparaît que sur sa ligne de répartition.
  assert.equal(quota.includes('sur 550.00 Go'), false, 'aucun total cumulé en tête');
  assert.equal(quota.includes('quota-bar'), false, 'aucune barre globale');
  assert.equal(quota.includes('% occupé au total'), false, 'aucun pourcentage global');
  assert.ok(quota.includes('467.35 Go disponibles'), 'l\'espace libre se dit sur la destination');
  assert.ok(quota.includes('mesuré'), 'la mesure d\'espace est datée (lot 54)');
});

test('Profil → Stockage : sans capacité mesurable, rien n\'est inventé', async () => {
  // `rclone about` indisponible, partage non monté, remote sans quota : le
  // poids des documents s'affiche seul, et la carte de la destination dit
  // pourquoi son espace est inconnu. Surtout pas un chiffre inventé.
  const sansTotal = JSON.parse(JSON.stringify(FIXTURES));
  sansTotal['/connectors/me/storage'].destinations[0].space = {
    known: false,
    totalBytes: null,
    freeBytes: null,
    usedBytes: null,
    reason: 'Mesure impossible (ENOENT).',
  };

  const app = makeSandbox(sansTotal);
  await app.run('renderProfilStorage()');
  const quota = app.html('my-storage-quota');

  assert.ok(quota.includes('593.9 Ko'), 'le poids des documents reste affiché');
  assert.ok(quota.includes('Mesure impossible'), 'la raison est dite');
  assert.equal(quota.includes('quota-bar'), false, 'aucune barre trompeuse');
  assert.equal(quota.includes('Disponible :'), false, 'aucun disponible inventé');
  // La répartition par destination reste utile, avec sa capacité inconnue.
  assert.ok(quota.includes('capacité inconnue'));
});

test('Profil : connecteurs, permissions et demandes', async () => {
  const app = makeSandbox(FIXTURES);

  await app.run('renderProfilConnList()');
  assertScreen(app.html('profil-conn-list'), {
    label: 'Profil → Connecteurs',
    // Lot 7 : « Reconfigurer » remplace « Configurer », et « Lancer
    // maintenant » ne s'affiche que là où une exécution aboutirait.
    contains: ['Free Internet', 'reconfigureConnector(', 'runConnectorNow('],
  });

  app.run('renderPermList()');
  assertScreen(app.html('perm-list'), {
    label: 'Profil → Permissions',
    contains: ['Free Internet', 'openPermDetail('],
  });

  // Détail : bandeau honnête en tête, puis une ligne dépliable par donnée.
  await app.run('openPermDetail("free")');
  const detail = app.html('perm-detail');
  assertScreen(detail, {
    label: 'Profil → Permissions (détail)',
    contains: [
      'Droit d&#39;accès limité',
      'destinations de stockage',
      'Factures',
      'Lecture et écriture',
      'Identifiants du connecteur',
      'Lecture seule',
      'Informations de compte',
      // Chaque ligne est dépliable, et son explication est propre à Free.
      '<details class="perm-item">',
      'perm-item-detail',
      'abonnement Freebox',
      'fbx',
    ],
  });
  assert.equal((detail.match(/<details class="perm-item">/g) || []).length, 3);

  await app.run('renderMyTickets()');
  assertScreen(app.html('my-tickets'), {
    label: 'Profil → Nous contacter',
    contains: ['Erreur OVH', 'replyToMyTicket(', 'hideMyTicket('],
  });
});

// ---------------------------------------------------------------------------
// Lot 3 — aucun débordement aux cinq points de rupture
// ---------------------------------------------------------------------------

test('la coque de l\'application tient aux cinq points de rupture', () => {
  assertFits(fs.readFileSync(path.join(WEB, 'app.html'), 'utf8'), {
    label: 'app.html',
    widthFor: (bp) => bp.width,
  });
});

test('l\'écran de connexion tient aux cinq points de rupture', () => {
  assertFits(fs.readFileSync(path.join(WEB, 'login.html'), 'utf8'), {
    label: 'login.html',
    widthFor: (bp) => bp.width,
  });
});

test('chaque écran rendu tient aux cinq points de rupture', async () => {
  const app = makeSandbox(FIXTURES);

  // Écrans utilisateur : toute la largeur de contenu.
  await app.run('renderHome()');
  assertFits(app.html('home-widgets'), { label: 'Accueil' });
  app.run('renderHomePanel()');
  // Le panneau fait 400 px au plus (élargi au lot 4 pour loger le sélecteur
  // de largeur), et 90 vw sur un téléphone.
  assertFits(app.html('home-panel-list'), {
    label: 'Panneau de personnalisation',
    widthFor: (bp) => Math.min(400, bp.width * 0.9) - 24,
  });

  await app.run('renderStore()');
  assertFits(app.html('store-grid'), { label: 'Store' });

  // Fiche de connecteur et écran de sélection : ils vivent dans la modale,
  // qui fait `min(440px, 100%)` moins ses 22 px de marge de chaque côté.
  const dansLaModale = (bp) => Math.min(440, bp.width) - 44;
  await app.run('loadConnectors()');
  app.run('openModal("free-mobile")');
  assertFits(app.html('modal-fields'), {
    label: 'Fiche connecteur (session + lignes)',
    widthFor: dansLaModale,
  });
  await app.run('rediscover()');
  assertFits(app.html('modal-fields'), {
    label: 'Écran de sélection des lignes',
    widthFor: dansLaModale,
  });

  await app.run('renderProfilStorage()');
  assertFits(app.html('my-storage-rows'), { label: 'Profil → Stockage', inSettings: true });
  await app.run('renderProfilConnList()');
  assertFits(app.html('profil-conn-list'), { label: 'Profil → Connecteurs', inSettings: true });
  app.run('renderPermList()');
  assertFits(app.html('perm-list'), { label: 'Profil → Permissions', inSettings: true });
  await app.run('renderMyTickets()');
  assertFits(app.html('my-tickets'), { label: 'Profil → Nous contacter', inSettings: true });

  // Écrans d'administration : la colonne de navigation prend sa place au-delà
  // de 1024 px, plus rien en dessous.
  const ecrans = [
    ['Utilisateurs', 'renderUsersPage()', ['users-list', 'deletion-requests', 'users-avatars-content']],
    ['Applications (cartes)', 'renderApps()', ['apps-list']],
    ['Applications → Logos', 'renderLogos()', ['logos-list']],
    ['Permissions', 'renderRoles()', ['roles-tab-roles', 'roles-tab-matrix']],
    ['Automatisation (cartes)', 'loadCron()', ['cron-list']],
    ['Stockage', 'renderAdminStorage()', ['admin-storage-summary', 'admin-storage-list']],
    ['Sécurité', 'renderSecurityPage()', ['security-content']],
    ['SMTP', 'renderSmtpPage()', ['smtp-config', 'smtp-templates']],
    ['Logs (connecteurs)', 'renderRunLogs()', ['logs-content']],
    ['Logs (application)', 'renderAppLogs()', ['logs-content']],
    ['Logs (stockage)', 'renderStorageLogs()', ['logs-content']],
    ['Support', 'renderSupport()', ['support-stats', 'support-list', 'support-detail']],
    ['Système', 'renderSysteme()', ['systeme-content']],
  ];

  for (const [label, expression, conteneurs] of ecrans) {
    await app.run(expression);
    for (const id of conteneurs) {
      assertFits(app.html(id), { label: `${label} → #${id}`, inSettings: true });
    }
  }

  // Les vues « liste » de TOUS les écrans à bascule (huit depuis le lot 10) :
  // c'est là que les tableaux les plus larges apparaissent, et donc là que la
  // mise en pile sous 768 px se casserait sans qu'on le voie.
  const bascules = [
    ['Applications', 'setAppsView("list")', 'apps-list'],
    ['Applications → Logos', 'setLogosView("list")', 'logos-list'],
    ['Utilisateurs', 'setUsersView("list")', 'users-list'],
    ['Permissions', 'setRolesView("list")', 'roles-tab-roles'],
    ['Support', 'setSupportView("list")', 'support-list'],
    ['Profil → Connecteurs', 'setProfilConnView("list")', 'profil-conn-list'],
    ['Profil → Permissions', 'setProfilPermView("list")', 'perm-list'],
  ];
  for (const [label, expression, id] of bascules) {
    await app.run(expression);
    assertFits(app.html(id), { label: `${label} (liste)`, inSettings: true });
  }

  await app.run('loadCron()');
  app.run('setCronView("list")');
  assertFits(app.html('cron-list'), { label: 'Automatisation (liste)', inSettings: true });

  // Sécurité → Logs de connexion.
  app.run('admin.securityTab = "logs"');
  await app.run('renderSecurityTab()');
  assertFits(app.html('connexions-table'), { label: 'Logs de connexion', inSettings: true });
});

test('les blocs les plus étroits de l\'accueil tiennent dans un quart de ligne', async () => {
  // Un bloc peut désormais être réduit au quart de la ligne. Au-delà de
  // 1280 px c'est un vrai quart ; entre 768 et 1279, ¼ se replie en ½ ; en
  // dessous, tout est pleine largeur. On mesure le pire cas de chaque palier.
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const colonne = (bp) => {
    const total = bp.width - 2 * bp.gutter;
    // 16 px de gouttière entre colonnes, 32 px de padding interne du bloc.
    if (bp.width >= 1280) return (total - 3 * 16) / 4 - 32;
    if (bp.width >= 768) return (total - 16) / 2 - 32;
    return total - 32;
  };

  assertFits(app.run('widgetSync()'), { label: 'Bloc Synchronisation', widthFor: colonne });
  assertFits(app.run('widgetErrors()'), { label: 'Bloc Erreurs', widthFor: colonne });
  assertFits(app.run('widgetStats()'), { label: 'Bloc Statistiques', widthFor: colonne });
});

test('le détecteur de débordement attrape bien une largeur figée', () => {
  // Sans cette vérification, les tests précédents pourraient passer à vide.
  const trouve = (html, available) =>
    responsive.findOverflows(html, { viewport: 360, available, rules: CSS_RULES });

  assert.equal(trouve('<div style="width:900px"></div>', 332).length, 1);
  assert.equal(trouve('<div style="min-width:800px"></div>', 332).length, 1);
  assert.equal(
    trouve('<div style="display:grid;grid-template-columns:repeat(7,84px);gap:10px"></div>', 332).length,
    1
  );
  // Bornés : rien à signaler.
  assert.deepEqual(trouve('<div style="width:900px;max-width:100%"></div>', 332), []);
  assert.deepEqual(trouve('<div style="width:min(900px,100%)"></div>', 332), []);
  // Un conteneur à défilement horizontal assume la largeur de son contenu.
  assert.deepEqual(
    trouve('<div class="matrix-wrap"><table class="data-table matrix"></table></div>', 332),
    []
  );
});

// ---------------------------------------------------------------------------
// Lot 12 — les arriérés visibles à l'accueil et dans « Mes documents »
// ---------------------------------------------------------------------------

test('Destinations : chaque carte porte « Synchroniser », le stockage local grisé avec sa raison', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('renderHome()');

  const accueil = app.html('home-widgets');

  // Le défaut corrigé : sur une installation où seul le stockage local est activé — le
  // cas par défaut — l'accueil ne portait AUCUN bouton, et ne disait pas
  // pourquoi. Un bouton absent ne s'explique pas.
  assert.match(accueil, /id="dest-sync-local"[^>]*disabled/,
    'la carte du stockage local porte son bouton, grisé');
  assert.match(accueil, /copie de référence/,
    'et la raison, au survol : c\'est d\'elle que partent les autres copies');

  // Le bouton global aussi, avec le chemin à suivre.
  assert.match(accueil, /id="dest-sync-all"[^>]*disabled/);
  assert.match(accueil, /Tout synchroniser vers les clouds/);
  assert.match(accueil, /Paramètres → Stockage/,
    'l\'écran dit où activer un cloud, plutôt que de faire disparaître le bouton');
});

test('Destinations : un cloud activé rend les deux boutons cliquables', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    const base = JSON.parse(JSON.stringify(FIXTURE_HOME));
    base.destinations.push({
      id: 'proton', name: 'Proton Drive', letter: 'P', color: '#6c5ce7',
      logo: null, logoInterne: false,
      usedBytes: 1024, files: 3, yourFiles: 3, pending: 4, canSync: true,
      space: { known: false, reason: 'espace non mesuré' },
      lastTestAt: null, lastTestOk: null,
    });
    api = (chemin) => (String(chemin) === '/home'
      ? Promise.resolve(JSON.parse(JSON.stringify(base)))
      : __fixture(chemin));
  `);
  await app.run('renderHome()');

  const accueil = app.html('home-widgets');
  assert.match(accueil, /id="dest-sync-proton"(?![^>]*disabled)/, 'Proton Drive est synchronisable');
  assert.match(accueil, /id="dest-sync-all"(?![^>]*disabled)/, 'le bouton global aussi');
  assert.match(accueil, /4 document\(s\) en attente de copie/, 'et la note dit ce qui reste');
  assert.match(accueil, /id="dest-sync-local"[^>]*disabled/, 'Le stockage local reste grisé');
});

test('Mes documents : un compte seul se replie aussi, et le repli est mémorisé', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');
  // Le repli vit dans l'arborescence : on entre donc dans le service, ce qui
  // est exactement ce que fait un clic sur sa carte. Le geste recharge l'écran,
  // d'où l'attente — sans elle, on mesurerait le « Lecture de vos documents… ».
  await app.run('enterDocsConnector("free")');

  // Le défaut corrigé : un compte SEUL dans son connecteur était déplié
  // d'office et ne pouvait pas se refermer. C'est le cas ordinaire — un
  // abonnement Free, un compte Amazon — et avec 186 documents l'écran devenait
  // une liste ininterrompue.
  const avant = app.html('docs-content');
  assert.match(avant, /aria-expanded="true"/, 'déplié au premier affichage');
  assert.match(avant, /toggleDocsAccount\('free\/fbx11111111'\)/);

  app.run('toggleDocsAccount("free/fbx11111111")');
  const apres = app.html('docs-content');
  assert.match(apres, /aria-expanded="false"/, 'et il se replie');
  // Le repli ne dépend pas de l'affichage : c'est le conteneur des documents
  // qui se cache, qu'il porte des cartes (le défaut depuis le lot 18) ou des
  // lignes. Un compte fermé en cartes doit rester fermé en liste.
  assert.match(apres, /class="docs-cards" style="display:none;"/);
  app.run('setDocsView("list")');
  assert.match(app.html('docs-content'), /class="docs-files" style="display:none;"/);
  app.run('setDocsView("cards")');

  // Mémorisé sur le COMPTE, pas dans le navigateur : d'un poste à l'autre.
  assert.deepEqual(
    JSON.parse(app.run('JSON.stringify(prefs.values["documents.collapsed"])')),
    ['free/fbx11111111']
  );
  assert.ok(
    app.calls.api.includes('/users/me/preferences'),
    'la préférence part vers le serveur'
  );

  app.run('toggleDocsAccount("free/fbx11111111")');
  assert.match(app.html('docs-content'), /aria-expanded="true"/, 'et il se rouvre');
});

test('Mes documents : un compte replié le reste au rechargement de l\'écran', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    const base = JSON.parse(JSON.stringify(FIXTURE_PREFS));
    base.preferences['documents.collapsed'] = ['free/fbx11111111'];
    api = (chemin, options) => (String(chemin).startsWith('/users/me/preferences') && !options
      ? Promise.resolve(JSON.parse(JSON.stringify(base)))
      : __fixture(chemin));
  `);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');
  await app.run('enterDocsConnector("free")');

  assert.match(app.html('docs-content'), /aria-expanded="false"/);
});

test('Logos : le filtre isole les manquants, et compte chaque état', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderLogos()');

  // Le compteur annonçait « en place / manquants » sans laisser isoler les
  // seconds — or on n'ouvre cet écran que pour combler des manques.
  const filtres = app.html('logos-filter');
  assert.match(filtres, /id="logos-filter-tous"/);
  assert.match(filtres, /id="logos-filter-sans"/);
  assert.match(filtres, /id="logos-filter-avec"/);
  assert.match(filtres, /Sans logo \(\d+\)/, 'chaque pastille annonce son compte');

  const tous = app.html('logos-list');

  app.run('setLogosFilter("sans")');
  const sans = app.html('logos-list');
  assert.notEqual(sans, tous, 'le filtre change bien la liste');
  assert.equal(app.run('prefs.values["logos.filter"]'), 'sans', 'et il est mémorisé');

  // Le stockage local porte une icône livrée avec crabe : elle s'affiche, elle ne
  // manque pas. Même règle que le liseré rouge, sinon les deux se contredisent.
  assert.ok(!sans.includes('Stockage local'), 'une icône interne n\'est pas un manque');

  app.run('setLogosFilter("avec")');
  assert.ok(app.html('logos-list').includes('Stockage local'));

  app.run('setLogosFilter("tous")');
  assert.equal(app.html('logos-list'), tous, 'et « Tous » remet tout');
});

test('Logos : un filtre qui ne laisse rien passer le dit, avec la sortie', async () => {
  const app = makeSandbox(FIXTURES);
  app.run(`
    api = (chemin, options) => (String(chemin) === '/admin/connectors/logos'
      ? Promise.resolve({
          connectors: [
            { id: 'free', name: 'Free Internet', kind: 'connector', color: '#c8102e',
              letters: 'FR', logo: '/api/connectors/logos/free.png', source: 'fetched',
              bytes: 1200, fetchedAt: '2026-08-10T09:00:00.000Z', site: 'free.fr' },
          ],
          limits: { maxBytes: 512000 },
        })
      : __fixture(chemin, options));
  `);
  await app.run('loadPrefs()');
  await app.run('renderLogos()');
  app.run('setLogosFilter("sans")');

  const vide = app.html('logos-list');
  assert.match(vide, /Aucun logo ne manque/);
  assert.match(vide, /setLogosFilter\('tous'\)/, 'et de quoi revenir en un clic');
});

// ---------------------------------------------------------------------------
// Lot 18 — « Mes documents » en cartes, la pagination réglable, et le choix
// des graphiques
// ---------------------------------------------------------------------------

/**
 * Un service EN ATTENTE DE TEST, tel que le serveur le sert à un
 * administrateur : `catalogStatus: 'pending'`, avec sa réserve.
 */
function storeAvecEnAttente() {
  const store = JSON.parse(JSON.stringify(FIXTURES['/connectors']));
  const modele = store.connectors.find((c) => c.id === 'edf');
  store.connectors = [
    ...store.connectors,
    {
      ...modele,
      id: 'mistral',
      name: 'Mistral',
      category: 'ia',
      categoryLabel: 'IA & outils créatifs',
      site: 'console.mistral.ai',
      description: 'Récupère automatiquement vos factures d\'abonnement et d\'usage Mistral.',
      caveat: 'Ce service n\'a encore été essayé sur aucun compte réel : la connexion et la '
        + 'page de facturation restent à confirmer.',
      catalogStatus: 'pending',
      installed: false,
      planned: false,
    },
  ];
  store.counts = { available: 3, pending: 1, planned: 0 };
  return { ...FIXTURES, '/connectors': store };
}

test('Store : un service « pas encore testé » est marqué comme tel, pas proposé comme prêt', async () => {
  // Ce que ce test empêche : qu'un connecteur écrit mais jamais exercé contre
  // un compte réel ressemble, dans la grille, à un service validé. Le serveur
  // ne le montre déjà qu'à un administrateur (registry.voitLesEnAttente) — il
  // faut encore qu'il le SACHE avant de cliquer, pas après une récupération
  // ratée.
  const app = makeSandbox(storeAvecEnAttente());
  await app.run('loadPrefs()');
  await app.run('renderStore()');
  const html = app.html('store-grid');

  assert.ok(html.includes('Mistral'), 'la tuile est bien là');
  assert.ok(html.includes('Pas encore testé'), 'et elle le dit');
  assert.ok(html.includes('status-dot amber'), 'avec la pastille des états à surveiller');
  // Elle reste INSTALLABLE : c'est tout l'objet du lot, sans quoi ce service ne
  // pourrait jamais quitter cet état.
  assert.ok(html.includes("installFromCard('mistral')"), 'et elle s\'installe');

  // Le compte annoncé ne les fond PAS dans les services disponibles.
  const compte = app.run('document.getElementById("store-count").textContent');
  assert.ok(/1 pas encore testé/.test(compte), `compte annoncé : ${compte}`);
  assert.equal(/4 services disponibles/.test(compte), false, 'jamais additionnés');
});

test('Store : la fiche prévient AVANT les champs, et porte la réserve du service', async () => {
  const app = makeSandbox(storeAvecEnAttente());
  await app.run('loadPrefs()');
  await app.run('renderStore()');
  app.run("openModal('mistral')");
  const html = app.html('modal-fields');

  assert.ok(
    html.includes('n\'a encore été essayé sur aucun compte réel'),
    'l\'avertissement est là'
  );
  assert.ok(html.includes('dites ce qui se passe'), 'et il dit ce qu\'on attend de la personne');
  assert.ok(
    html.indexOf('n\'a encore été essayé') < html.indexOf('sheet-form'),
    'AVANT les champs : le découvrir après avoir saisi ses identifiants serait une surprise'
  );
  // La note technique, elle, ne sort jamais vers l'utilisateur.
  assert.equal(html.includes('JAMAIS EXERCÉ'), false);
});

test('Mes documents : en cartes, UNE CARTE PAR SERVICE', async () => {
  // ─── Le défaut que ce test empêche de revenir (lot 18 → lot 20) ──────────
  //
  // Le lot 18 avait posé la bascule au mauvais niveau de l'arborescence : la
  // vue « Cartes » rendait des cartes de DOCUMENTS, mais toujours à
  // l'intérieur de la liste hiérarchique service → compte → documents. On
  // obtenait donc la liste ET les cartes en même temps, c'est-à-dire ni l'une
  // ni l'autre. Cet écran montre d'abord des SERVICES.
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');

  const html = app.html('docs-content');

  assert.match(html, /class="docs-conn-cards"/, 'une grille de services');
  assert.match(html, /class="docs-conn-card"/, 'et une carte par service');
  assert.equal(
    html.includes('class="docs-tree"'),
    false,
    'la liste hiérarchique ne se superpose pas aux cartes'
  );
  assert.equal(html.includes('class="doc-card'), false, 'et pas de carte de document non plus');

  // Ce que porte une carte de service : logo, nom, nombre de documents, comptes.
  assert.match(html, /Free Internet/, 'le nom du service');
  assert.match(html, /conn-icon/, 'son logo');
  assert.match(html, />2 documents</, 'son nombre de documents');
  assert.match(html, /fbx11111111/, 'et ses comptes');

  // La bascule est là pour en sortir, avec les deux mêmes boutons qu'ailleurs.
  assert.match(html, /id="view-documents-cards"/, 'le bouton Cartes');
  assert.match(html, /id="view-documents-list"/, 'le bouton Liste');
  assert.match(html, /class="pill active"\s+id="view-documents-cards"/, 'Cartes est le mode actif');
});

test('Mes documents : entrer dans un service montre ses documents, et le retour', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');
  await app.run('enterDocsConnector("free")');

  const html = app.html('docs-content');

  // Le détail, tel qu'il était : l'arborescence du service, et ses cartes de
  // documents avec tout ce que la ligne montrait.
  assert.match(html, /class="docs-tree"/, 'l\'arborescence du service');
  assert.match(html, /class="doc-card/, 'la carte de document existe');
  assert.match(html, /202507_free\.pdf/, 'le nom de fichier');
  assert.match(html, />Période</, 'la période');
  assert.match(html, />Taille</, 'la taille');
  assert.match(html, />Récupéré</, 'la date de récupération');
  assert.match(html, /\/api\/documents\/local\/6\/file/, 'et le téléchargement');

  // Et de quoi revenir : sans lui, on entre dans un service sans en sortir.
  assert.match(html, /docs-back/, 'le retour vers tous les services');
  await app.run('setDocsFilter("connector", "")');
  assert.match(app.html('docs-content'), /class="docs-conn-cards"/, 'et il ramène aux services');
});

test('Mes documents : les deux règles de l\'écran tiennent dans les deux affichages', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');

  for (const mode of ['cards', 'list']) {
    app.run(`setDocsView("${mode}")`);
    // En cartes, les documents vivent DANS le service : on y entre, comme le
    // ferait un clic sur la carte.
    if (mode === 'cards') await app.run('enterDocsConnector("free")');
    const html = app.html('docs-content');

    // Un fichier disparu du stockage est signalé, et n'est PAS proposé au
    // téléchargement : un bouton qui répondrait 404 serait pire que rien.
    assert.ok(
      html.includes('est plus présent sur cet espace de stockage'),
      `${mode} : le fichier disparu est signalé`
    );
    assert.equal(
      html.includes('/api/documents/local/5/file'),
      false,
      `${mode} : et son téléchargement est retiré`
    );

    // Écran de CONSULTATION : aucune carte ne fait ce que la liste ne fait pas.
    for (const mot of ['Supprimer', 'Renommer', 'Déplacer']) {
      assert.equal(html.includes(mot), false, `${mode} : « ${mot} » n'a rien à faire ici`);
    }
  }
});

test('Mes documents : la bascule est mémorisée sur le compte, pas dans le navigateur', async () => {
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');

  app.run('setDocsView("list")');
  const enListe = app.html('docs-content');
  assert.match(enListe, /class="docs-files"/, 'la liste remplace les cartes');
  assert.equal(enListe.includes('class="docs-cards"'), false);
  // Le tri reste celui du sélecteur : basculer de vue ne rebat pas l'ordre.
  assert.match(enListe, /<option value="fetchedAt" selected>/);

  assert.equal(app.run('prefs.values["view.documents"]'), 'list');
  assert.ok(
    app.calls.api.includes('/users/me/preferences'),
    'la préférence part vers le serveur, pas dans localStorage'
  );

  app.run('setDocsView("cards")');
  assert.match(
    app.html('docs-content'),
    /class="docs-conn-cards"/,
    'et on revient aux cartes — c\'est-à-dire aux services'
  );
});

test('Accueil : les six tailles de page proposées sont celles que le serveur accepte', async () => {
  // Le réglage a quitté le profil au lot 20 : il est PAR BLOC, et vit donc
  // dans le panneau qui règle déjà les blocs. Deux endroits pour régler la
  // même page, c'était un de trop.
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('openHomePanel()');
  app.run('setHomeSyncView("list")');

  const panneau = app.html('home-panel-list');
  for (const taille of [10, 15, 20, 25, 30, 50]) {
    assert.match(panneau, new RegExp(`value="${taille}"`), `${taille} est proposé`);
  }
  // Le 5 du lot 17 a disparu du menu en même temps que du serveur : proposer
  // une valeur que l'enregistrement refuserait serait un piège à clic.
  assert.equal(/value="5"/.test(panneau), false, 'le 5 n\'est plus proposé');
  // Et les DEUX blocs paginés ont leur réglage, pas un seul pour les deux.
  assert.match(panneau, /saveHomePageSize\('sync'/, 'le réglage de la synchronisation');
  assert.match(panneau, /saveHomePageSize\('documents'/, 'et celui des documents');

  // Chaque taille se voit tout de suite sur le bloc réglé.
  for (const [taille, lignes, pages] of [[15, 15, 2], [25, 23, 1], [50, 23, 1]]) {
    app.run(`saveHomePageSize('sync', ${taille})`);
    const html = app.html('home-widgets');
    assert.equal(
      (html.match(/class="sync-row"/g) || []).length,
      lignes,
      `${taille} par page : ${lignes} connecteurs sur 23`
    );
    if (pages > 1) assert.ok(html.includes(`sur ${pages} · 23 connecteur(s)`));
  }
});

test('Accueil : une taille hors liste est refusée, et l\'affichage ne bouge pas', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('setHomeSyncView("list")');
  const avant = (app.html('home-widgets').match(/class="sync-row"/g) || []).length;
  assert.equal(avant, 10);

  // Le serveur est le seul à faire loi, mais l'interface ne propose pas non
  // plus ce qu'il refuserait : elle le dit, en toutes lettres.
  app.run("saveHomePageSize('sync', 7)");
  assert.equal(
    (app.html('home-widgets').match(/class="sync-row"/g) || []).length,
    10,
    'l\'affichage garde la valeur d\'avant'
  );
  assert.equal(app.run('prefs.values["home.sync.pageSize"]'), 10, 'et la mémoire aussi');
  assert.ok(
    app.calls.toasts.some((t) => /10, 15, 20, 25, 30 ou 50/.test(t)),
    `le refus dit ce qui est possible — vu : ${JSON.stringify(app.calls.toasts)}`
  );
});

test('Accueil : la forme d\'un graphique se choisit, et se voit', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  // Par défaut, les dessins du lot 18 : des barres dans les deux cas.
  const barres = app.html('home-widgets');
  assert.match(barres, /<rect [^>]*fill="var\(--accent\)"/, 'factures par mois en barres');
  assert.equal(barres.includes('chart-donut'), false, 'et pas d\'anneau');

  app.run("setStatsChartType('mois', 'courbe')");
  const courbe = app.html('home-widgets');
  assert.match(courbe, /<polyline points="/, 'la courbe est tracée');
  assert.match(
    courbe,
    /vector-effect="non-scaling-stroke"/,
    'et son épaisseur ne suit pas l\'étirement du bloc'
  );

  app.run("setStatsChartType('connecteurs', 'anneau')");
  const anneau = app.html('home-widgets');
  assert.match(anneau, /class="chart-donut"/, 'l\'anneau est dessiné');
  assert.match(anneau, /stroke-dasharray="/, 'par des tirets, pas des arcs calculés');
  assert.match(anneau, /class="chart-legend"/, 'avec sa légende en HTML');
  assert.match(anneau, /viewBox="0 0 100 100"/, 'dans un repère carré, pour ne pas l\'aplatir');

  // Le choix est mémorisé sur le COMPTE, comme les autres réglages d'accueil.
  assert.equal(app.run('prefs.values["home.stats.type.mois"]'), 'courbe');
  assert.equal(app.run('prefs.values["home.stats.type.connecteurs"]'), 'anneau');
  assert.ok(app.calls.api.includes('/users/me/preferences'));
});

test('Accueil : une forme inconnue n\'est jamais dessinée', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  app.run("setStatsChartType('mois', 'camembert')");
  assert.equal(
    app.run('prefs.values["home.stats.type.mois"]'),
    'barres',
    'une forme hors liste ne remplace rien'
  );
});

test('Accueil : les trois statistiques ajoutées se dessinent quand on les coche', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  for (const [id, titre] of [
    ['stockage', 'Espace occupé par service'],
    ['connecteurs-temps', 'Services connectés'],
    ['executions', 'Récupérations'],
  ]) {
    app.run(`toggleStatsChart('${id}', true)`);
    assert.ok(
      app.html('home-widgets').includes(titre),
      `${id} : « ${titre} » attendu à l'écran`
    );
  }

  const html = app.html('home-widgets');
  // Chacune montre bien SA donnée, et pas celle d'un voisin.
  // L'unité est écrite en clair : « 594 » tout seul ne voudrait rien dire dans
  // un graphique qui compte par ailleurs des factures et des exécutions.
  assert.match(html, /Espace occupé par service[\s\S]*?(o|Ko|Mo|Go)<\/span>/, 'avec son unité');
  assert.match(html, /service\(s\) connect/, 'la courbe des services porte son infobulle');
  assert.match(html, /r[ée]ussie/, 'et les récupérations distinguent les réussites');
});

test('Accueil : une statistique sans donnée le DIT, au lieu d\'un cadre vide', async () => {
  const vide = accueilCharge(10);
  vide['/home'].stats = {
    ...vide['/home'].stats,
    executionsParMois: Array.from({ length: 12 }, (_, i) => ({
      periode: `2026-${String(i + 1).padStart(2, '0')}`,
      ok: 0,
      ko: 0,
    })),
  };

  const app = makeSandbox(vide);
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run("toggleStatsChart('executions', true)");
  const html = app.html('home-widgets');

  // Le cadre reste, avec son titre — et il explique son vide. Les autres
  // graphiques, eux, continuent de se dessiner : le vide se juge graphique par
  // graphique, pas « y a-t-il des factures ? ».
  assert.ok(html.includes('Récupérations réussies et échouées'), 'le cadre garde son titre');
  assert.ok(html.includes('Aucune récupération lancée'), 'et il dit pourquoi il est vide');
  assert.ok(html.includes('Factures par mois'), 'les autres graphiques ne disparaissent pas');
});

test('Accueil : les quatre combinaisons de graphiques, sans bloc vide et muet', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');

  // Les compteurs du bloc ne dépendent d'AUCUN graphique : c'est eux qui
  // empêchent le bloc de devenir vide et muet quand on décoche tout.
  const compteurs = ['factures ce mois-ci', 'factures au total', 'espace occupé'];

  const combinaisons = [
    { choix: ['mois', 'connecteurs'], mois: true, connecteurs: true },
    { choix: ['mois'], mois: true, connecteurs: false },
    { choix: ['connecteurs'], mois: false, connecteurs: true },
    { choix: [], mois: false, connecteurs: false },
  ];

  for (const cas of combinaisons) {
    app.run(`prefs.values["home.stats.charts"] = ${JSON.stringify(cas.choix)}`);
    app.run('renderHomeWidgets()');
    const html = app.html('home-widgets');
    const nom = cas.choix.length ? cas.choix.join('+') : 'aucun';

    assert.equal(html.includes('Factures par mois'), cas.mois, `${nom} : graphique des mois`);
    assert.equal(
      html.includes('Répartition par service'),
      cas.connecteurs,
      `${nom} : graphique des services`
    );

    // Dans les quatre cas, le bloc dit quelque chose.
    for (const compteur of compteurs) {
      assert.ok(html.includes(compteur), `${nom} : « ${compteur} » reste affiché`);
    }
    // Et jamais un cadre de graphiques vide.
    assert.equal(
      /class="charts[^"]*">\s*<\/div>/.test(html),
      false,
      `${nom} : aucun cadre de graphiques vide`
    );
  }

  // Un seul graphique prend toute la largeur : la grille à deux colonnes
  // laisserait sinon une moitié de bloc vide à côté de lui.
  app.run('prefs.values["home.stats.charts"] = ["mois"]');
  app.run('renderHomeWidgets()');
  assert.match(app.html('home-widgets'), /class="charts seul"/);
});

test('Accueil : le choix des graphiques se règle dans le panneau, et s\'enregistre', async () => {
  const app = makeSandbox(accueilCharge(10));
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('renderHomePanel()');

  // Le réglage vit SOUS le bloc qu'il concerne, dans le panneau qui règle déjà
  // l'accueil — pas dans un second écran de réglages à découvrir.
  const panneau = app.html('home-panel-list');
  assert.match(panneau, /Graphiques affichés/);
  assert.match(panneau, /toggleStatsChart\('mois', this\.checked\)/);
  assert.match(panneau, /toggleStatsChart\('connecteurs', this\.checked\)/);
  // Les cases portent le nom exact des graphiques qu'elles allument.
  assert.match(panneau, /Factures par mois/);
  assert.match(panneau, /Répartition par service/);
  // Et le bloc n'est pas devenu deux blocs de plus dans la liste : « Factures
  // par mois » est un réglage interne, pas un septième bloc d'accueil.
  assert.equal((panneau.match(/data-widget="/g) || []).length, 6);

  app.run('toggleStatsChart("connecteurs", false)');
  assert.deepEqual(
    JSON.parse(app.run('JSON.stringify(prefs.values["home.stats.charts"])')),
    ['mois']
  );
  const apres = app.html('home-widgets');
  assert.equal(apres.includes('Répartition par service'), false, 'le graphique disparaît');
  assert.ok(apres.includes('Factures par mois'), 'l\'autre reste');
  assert.ok(app.calls.api.includes('/users/me/preferences'), 'et le choix part vers le serveur');

  // Décocher le second ne vide pas le bloc : les compteurs tiennent.
  app.run('toggleStatsChart("mois", false)');
  const vide = app.html('home-widgets');
  assert.ok(vide.includes('factures au total'), 'le bloc garde ses chiffres');
  assert.equal(vide.includes('class="charts'), false, 'et plus aucun cadre de graphique');
});

test('Accueil : un accueil figé refuse aussi le choix des graphiques', async () => {
  const fige = accueilCharge(10);
  fige['/home'] = {
    ...fige['/home'],
    access: { adminAllowed: true, personalLock: true, canCustomize: false },
  };

  const app = makeSandbox(fige);
  await app.run('loadPrefs()');
  await app.run('renderHome()');
  app.run('renderHomePanel()');

  // Le réglage reste LISIBLE — le masquer ferait oublier ce qu'on y avait
  // choisi — mais il est grisé, comme le reste du panneau.
  const panneau = app.html('home-panel-list');
  assert.match(panneau, /Graphiques affichés/);
  assert.match(panneau, /toggleStatsChart\('mois', this\.checked\)[^>]*/);
  assert.match(panneau, /class="panel-sub-item">\s*<input type="checkbox"[^>]*disabled/);

  // Et l'appel direct est refusé, avec la raison — masquer un bouton ne
  // protège de rien.
  app.run('toggleStatsChart("mois", false)');
  assert.deepEqual(
    JSON.parse(app.run('JSON.stringify(prefs.values["home.stats.charts"])')),
    ['mois', 'connecteurs'],
    'rien n\'a changé'
  );
  assert.ok(app.calls.toasts.some((t) => /figé/.test(t)), 'et la raison est dite');
});

test('Mes documents : les cartes restent lisibles dans les deux thèmes', async () => {
  // Même raisonnement que pour les graphiques de l'accueil : aucun navigateur
  // ici, donc aucun contraste mesurable. Ce qui SE vérifie, et qui est la vraie
  // cause d'un écran illisible en thème clair, c'est qu'une variable employée
  // par les cartes n'existe que d'un seul côté.
  const app = makeSandbox(FIXTURES);
  await app.run('loadPrefs()');
  await app.run('renderDocuments()');

  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const bloc = (selecteur) => css.slice(css.indexOf(selecteur), css.indexOf('}', css.indexOf(selecteur)));
  const sombre = bloc(':root{');
  const clair = bloc('body.light{');

  // Les variables employées par le bloc de styles des cartes de document.
  const debut = css.indexOf('.docs-cards{');
  assert.ok(debut > 0, 'le bloc de styles des cartes existe');
  const employees = new Set(
    [...css.slice(debut, css.indexOf('/* Téléphone', debut)).matchAll(/var\((--[\w-]+)\)/g)]
      .map((m) => m[1])
  );
  assert.ok(employees.size >= 4, 'des variables de thème sont bien employées');

  for (const variable of employees) {
    assert.ok(sombre.includes(`${variable}:`), `${variable} manque au thème sombre`);
    assert.ok(clair.includes(`${variable}:`), `${variable} n'est pas redéfinie en thème clair`);
  }

  // Et la seule couleur en dur d'une carte est celle du service, qui vient de
  // son manifeste et est la même partout ailleurs dans l'interface.
  const html = app.html('docs-content');
  const enDur = [...html.matchAll(/background:(#[0-9a-f]{3,8})/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(enDur)], ['#c8102e'], 'aucune couleur figée hors celle du service');
});


// ---------------------------------------------------------------------------
// Lot 59 — le bandeau des opérations, sur toutes les pages
// (refondu au lot 65 : UNE pastille centrée, une ligne agrégée dépliable, et
//  un succès qui s'efface tout seul au bout de quinze secondes)
// ---------------------------------------------------------------------------

/** Un instant de fin assez frais pour que le succès soit encore annoncé. */
function finFraiche(ilYaMs = 1000) {
  return new Date(Date.now() - ilYaMs).toISOString();
}

/** Une opération telle que GET /api/operations la décrit. */
function opDeTest(surcharge = {}) {
  return {
    cle: 'renommage:2026-08-26T00:00:00.000Z',
    type: 'renommage',
    titre: 'Renommage des documents',
    etat: 'en-cours',
    detail: '',
    faites: 100,
    total: 324,
    ecran: 'profil-fichiers',
    demarreLe: '2026-08-26T00:00:00.000Z',
    termineLe: null,
    ...surcharge,
  };
}

function poserOperations(app, operations) {
  app.run(`opsBandeau.operations = ${JSON.stringify(operations)}; majBandeauOperations();`);
}

test('Bandeau des opérations : orange tant que ça tourne, où ça en est, et le lien', () => {
  const app = makeSandbox(FIXTURES);

  poserOperations(app, [opDeTest()]);
  const html = app.html('op-banner');
  assertScreen(html, {
    label: 'Bandeau (en cours)',
    contains: [
      'op-box encours',
      'Renommage des documents',
      'en cours — 100 sur 324',
      "ouvrirEcranOperation('profil-fichiers', 'renommage:2026-08-26T00:00:00.000Z', event)",
    ],
  });
  // Une seule opération : elle se nomme directement, sans dépliage inutile.
  assert.equal(html.includes('<details'), false, 'rien à déplier pour une seule opération');
  // La couleur DOUBLE le texte : l'état est écrit, pas seulement teinté.
  assert.equal(html.includes('op-close'), false, 'pas de croix tant que ça tourne : le bandeau reste');
  assert.equal(html.includes('succes'), false);
  assert.equal(html.includes('echec'), false);
});

test('Bandeau des opérations : vert au succès, rouge sur échec — jamais « en cours »', () => {
  const app = makeSandbox(FIXTURES);

  // ⚠ Des fins FRAÎCHES : depuis le lot 65, un succès s'efface tout seul au
  // bout de quinze secondes. Daté à la louche, il ne serait déjà plus là.
  poserOperations(app, [
    opDeTest({
      cle: 'renommage:fin', etat: 'echec',
      detail: 'La destination pCloud n\'a pas répondu.', faites: null, total: null,
      termineLe: finFraiche(2000),
    }),
    opDeTest({
      cle: 'sync:fin', type: 'synchronisation', titre: 'Synchronisation vers les destinations',
      etat: 'succes', detail: '98 documents copiés.', faites: null, total: null,
      ecran: 'home', termineLe: finFraiche(1000),
    }),
  ]);

  const html = app.html('op-banner');
  assertScreen(html, {
    label: 'Bandeau (fins)',
    contains: [
      // Deux opérations : UNE ligne agrégée, et l'erreur commande la couleur.
      'op-box echec',
      '2 opérations — 1 en échec',
      // Le détail de chacune est dans le repli.
      'op-item succes',
      'terminée — 98 documents copiés.',
      'op-item echec',
      'arrêtée sur un échec — La destination pCloud n&#39;a pas répondu.',
      'op-close',
    ],
  });
  assert.equal(html.includes('op-box encours'), false, 'une opération finie n\'est plus « en cours »');
  assert.equal(html.includes('en cours —'), false);
});

test('Bandeau des opérations : rien à annoncer, rien d\'affiché — et la croix ferme une fin', () => {
  const app = makeSandbox(FIXTURES);

  poserOperations(app, []);
  assert.equal(app.html('op-banner'), '', 'aucune opération : le bandeau disparaît');

  poserOperations(app, [opDeTest({ cle: 'sync:fin', etat: 'succes', detail: 'Terminé.', termineLe: finFraiche() })]);
  assert.ok(app.html('op-banner').includes('op-box succes'));

  app.run('fermerOperationsFinies()');
  assert.equal(app.html('op-banner'), '', 'la croix ferme le compte rendu pour la session');

  // Mais une opération EN COURS ne se ferme pas : sa clé fermée est ignorée.
  poserOperations(app, [opDeTest({ cle: 'sync:fin', etat: 'en-cours' })]);
  assert.ok(
    app.html('op-banner').includes('op-box encours'),
    'tant que ça tourne, le bandeau reste — croix ou pas'
  );
});

test('Bandeau des opérations : le clic mène à l\'écran de l\'opération', () => {
  const app = makeSandbox(FIXTURES);

  // Les fonctions de navigation sont des liaisons globales réassignables : on
  // les remplace par un enregistreur, la destination du clic devient mesurable
  // sans monter tous les écrans traversés.
  app.run(`
    __nav = [];
    showView = (v) => __nav.push('view:' + v);
    showProfilPage = (p) => __nav.push('ppage:' + p);
    showAdminPage = (p) => __nav.push('apage:' + p);
    ouvrirEcranOperation('profil-fichiers');
    ouvrirEcranOperation('home');
    ouvrirEcranOperation('admin-optimisation');
  `);

  const nav = JSON.parse(app.run('JSON.stringify(__nav)'));
  assert.deepEqual(
    nav.slice(0, 3),
    ['view:profil', 'ppage:fichiers', 'view:home'],
    'renommage → Profil (Fichiers), synchronisation et récupérations → accueil'
  );
  assert.ok(nav.includes('view:admin'), 'optimisation → Paramètres');
});

// ---------------------------------------------------------------------------
// Lot 60 — l'écran Optimisation
// ---------------------------------------------------------------------------

/** La photographie que GET /admin/optimisation renvoie, représentative du CT. */
function fixtureOptimisation(surcharge = {}) {
  return {
    volets: ['globale', 'cache', 'profils', 'cloud', 'sauvegardes'],
    recurrences: [1, 3, 6, 12, 24],
    reglages: {
      globale: { mode: 'manuel', recurrenceMois: 6, dernierPassage: null },
      cache: { mode: 'manuel', recurrenceMois: 6, dernierPassage: '2026-08-20 04:15:00' },
      profils: { mode: 'manuel', recurrenceMois: 6, dernierPassage: null },
      cloud: { mode: 'manuel', recurrenceMois: 6, dernierPassage: null },
      sauvegardes: { mode: 'manuel', recurrenceMois: 6, dernierPassage: null },
    },
    mesures: {
      cache: {
        octets: 108 * 1024 * 1024,
        profils: [
          { connectorId: 'boutique-voyage', userId: 1, octets: 103 * 1024 * 1024, empeche: null },
          { connectorId: 'boutique-electro', userId: 1, octets: 5 * 1024 * 1024, empeche: 'navigateur ouvert' },
        ],
      },
      profils: {
        octets: 9 * 1024 * 1024,
        candidats: [
          { connectorId: 'vieux-marchand', userId: 1, octets: 9 * 1024 * 1024, installe: false, dernierSigne: null, motif: 'connecteur désinstallé' },
        ],
        dormants: [],
        sommeilMois: 12,
      },
      cloud: {
        coquilles: [
          { destId: 'cloud-a', nom: 'pCloud de Camille', provider: 'pcloud', supprimeeLe: '2026-08-15 08:03:43', traces: [{ invoiceId: 1, destId: 'cloud-a' }], copiesReussies: false },
          { destId: 'cloud-b', nom: 'Proton de Camille', provider: 'proton', supprimeeLe: '2026-08-15 08:03:46', traces: [], copiesReussies: true },
        ],
        nettoyables: 1,
        traces: 1,
      },
      sauvegardes: {
        octets: 19 * 1024 * 1024,
        fichiers: [
          { nom: 'crabe.db.avant-harmonisation-20260825-195646', chemin: '/x', motif: 'harmonisation', horodatage: '20260825-195646', octets: 3 * 1024 * 1024, modifieLe: '2026-08-25T19:56:46.000Z', annexes: [] },
        ],
      },
      disque: { libre: 6 * 1024 ** 3, total: 12 * 1024 ** 3, seuil: 1024 ** 3 },
    },
    enCours: {
      running: false, volet: null, demarreLe: null, termineLe: null,
      faites: 0, total: 0, message: '', echec: false, details: [],
    },
    ...surcharge,
  };
}

test('Optimisation : cinq volets, mesures datées, et rien qui se déclenche tout seul', async () => {
  const app = makeSandbox({ ...FIXTURES, '/admin/optimisation': fixtureOptimisation() });
  await app.run('renderOptimisation()');
  const html = app.html('optimisation-content');

  assertScreen(html, {
    label: 'Paramètres → Optimisation',
    contains: [
      'Optimisation globale',
      'Cache des navigateurs',
      'Profils non utilisés',
      'Cloud non utilisé',
      'Sauvegardes de la base',
      // Ce que chaque volet libérerait, mesuré.
      '108.0 Mo',
      'boutique-electro (navigateur ouvert)',
      'connecteur désinstallé',
      // Le lancement, le mode et la récurrence de chaque volet.
      "lancerVoletOptimisation('cache')",
      'opt-mode-globale',
      'opt-rec-sauvegardes',
      'Tous les 2 ans',
      // Les sauvegardes : une liste cochable qui ATTEND un geste.
      'opt-sauvegarde',
      'Supprimer la sélection',
      'sans votre accord',
      // Le filet, expliqué avec son seuil.
      'nettoyage sûr',
    ],
  });
  // Tout est en manuel, et une coquille protégée par une copie réussie le dit.
  assert.equal((html.match(/badge-pill/g) || []).length >= 5, true);
  assert.ok(html.includes('Proton de Camille'), 'la coquille gardée est nommée');
  assert.equal(html.includes('Automatique</span>'), false, 'aucun volet automatique par défaut');
});

test('Optimisation : l\'encart d\'état porte les trois couleurs, chacune par sa situation', async () => {
  // En cours → orange.
  let app = makeSandbox({
    ...FIXTURES,
    '/admin/optimisation': fixtureOptimisation({
      enCours: { running: true, volet: 'globale', demarreLe: '2026-08-26T02:00:00.000Z', termineLe: null, faites: 2, total: 4, message: 'Nettoyage en cours…', echec: false, details: [] },
    }),
  });
  await app.run('renderOptimisation()');
  assert.ok(app.html('optimisation-content').includes('op-item encours'));
  assert.ok(app.html('optimisation-content').includes('2 volet(s) sur 4'));

  // Fini avec succès → vert.
  app = makeSandbox({
    ...FIXTURES,
    '/admin/optimisation': fixtureOptimisation({
      enCours: { running: false, volet: 'cache', demarreLe: '2026-08-26T02:00:00.000Z', termineLe: '2026-08-26T02:00:05.000Z', faites: 1, total: 1, message: 'Cache des profils : 103.0 Mo libérés sur 1 profil(s).', echec: false, details: [] },
    }),
  });
  await app.run('renderOptimisation()');
  assert.ok(app.html('optimisation-content').includes('op-item succes'));
  assert.ok(app.html('optimisation-content').includes('103.0 Mo libérés'));

  // Arrêté sur échec → rouge, et le texte le dit.
  app = makeSandbox({
    ...FIXTURES,
    '/admin/optimisation': fixtureOptimisation({
      enCours: { running: false, volet: 'profils', demarreLe: '2026-08-26T02:00:00.000Z', termineLe: '2026-08-26T02:00:05.000Z', faites: 0, total: 1, message: 'Nettoyage arrêté : chemin hors de la racine attendue.', echec: true, details: [] },
    }),
  });
  await app.run('renderOptimisation()');
  const html = app.html('optimisation-content');
  assert.ok(html.includes('op-item echec'));
  assert.ok(html.includes('arrêté sur un échec') || html.includes('Nettoyage arrêté'), 'le texte double la couleur');
  assert.equal(html.includes('op-item encours'), false, 'un échec n\'est pas « en cours »');
});

// ---------------------------------------------------------------------------
// Lot 61 — l'écran Optimisation se lit en blocs
// ---------------------------------------------------------------------------

test('Optimisation : des cartes au gabarit des destinations, l\'état dit avant le contenu', async () => {
  const app = makeSandbox({ ...FIXTURES, '/admin/optimisation': fixtureOptimisation() });
  await app.run('renderOptimisation()');
  const html = app.html('optimisation-content');

  // La globale garde son rang à part : son cadre au-dessus de la grille, et
  // jamais une cinquième carte dedans.
  const posGlobale = html.indexOf('opt-globale');
  const posGrille = html.indexOf('opt-grid');
  assert.ok(posGlobale >= 0 && posGrille >= 0, 'le cadre de la globale et la grille existent');
  assert.ok(posGlobale < posGrille, 'la globale est au-dessus de la grille');
  assert.equal(
    html.slice(posGrille).includes('Optimisation globale'),
    false,
    'la globale n\'est pas une carte de la grille'
  );
  assert.equal((html.match(/dest-card opt-card/g) || []).length, 4, 'quatre volets, quatre cartes');

  // L'état de chaque carte se voit avant de la lire — couleur ET texte, comme
  // au bandeau du lot 59. La fixture atteint deux des trois états : « à
  // libérer » (orange, avec le volume mesuré) et le volet qui ne supprime
  // jamais seul (bleu).
  assert.ok(html.includes('badge-pill amber">108.0 Mo à libérer'), 'cache : volume mesuré, en orange');
  assert.ok(html.includes('badge-pill amber">1 profil(s) — 9.0 Mo à libérer'), 'profils : orange');
  assert.ok(html.includes('badge-pill amber">1 configuration(s) à retirer'), 'cloud : orange');
  assert.ok(/badge-pill blue">1 sauvegarde\(s\), 19\.0 Mo — votre geste décide/.test(html),
    'sauvegardes : bleu, jamais « à libérer »');

  // Rien n'a été retiré : mode, récurrence, bouton et dernier passage restent
  // sur chaque volet, la globale comprise.
  for (const volet of ['globale', 'cache', 'profils', 'cloud', 'sauvegardes']) {
    assert.ok(html.includes(`opt-mode-${volet}`), `mode de ${volet}`);
    assert.ok(html.includes(`opt-rec-${volet}`), `récurrence de ${volet}`);
    assert.ok(html.includes(`lancerVoletOptimisation('${volet}')`), `bouton de ${volet}`);
  }
  assert.ok(html.includes('dernier passage'), 'le dernier passage du cache reste daté');

  // Les explications longues se replient (mécanisme du lot 57), jamais ne se
  // suppriment : le texte est LÀ, derrière « Tout lire ».
  assert.ok(html.includes('Tout lire'));
  assert.ok(html.includes('Les deux se nettoient ensemble'));
  assert.ok(html.includes('sans rien\n       supprimer') || /faire le point sans rien\s+supprimer/.test(html),
    'l\'explication de la globale n\'a pas disparu');

  // Le bandeau d'espace libre reste en tête : avant la globale.
  assert.ok(html.indexOf('Espace libre sur le volume de données') < posGlobale);
});

test('Optimisation : une machine sans rien à libérer le dit en vert, carte par carte', async () => {
  const app = makeSandbox({
    ...FIXTURES,
    '/admin/optimisation': fixtureOptimisation({
      mesures: {
        cache: { octets: 0, profils: [] },
        profils: { octets: 0, candidats: [], dormants: [], sommeilMois: 12 },
        cloud: { coquilles: [], nettoyables: 0, traces: 0 },
        sauvegardes: { octets: 0, fichiers: [] },
        disque: { libre: 6 * 1024 ** 3, total: 12 * 1024 ** 3, seuil: 1024 ** 3 },
      },
    }),
  });
  await app.run('renderOptimisation()');
  const html = app.html('optimisation-content');

  assert.equal((html.match(/badge-pill green">rien à faire/g) || []).length, 4,
    'les quatre cartes disent « rien à faire », en vert');
  assert.equal(html.includes('badge-pill amber'), false, 'aucun état orange fantôme');
  assert.equal(html.includes('votre geste décide'), false, 'aucune sauvegarde à décider');
});

// ---------------------------------------------------------------------------
// Lot 63 — les listes déroulantes prennent le thème
// ---------------------------------------------------------------------------

/**
 * Jusqu'ici, seuls les <select> posés dans un conteneur stylé (.field,
 * .toolbar-field…) suivaient le thème ; les autres — réglages d'Optimisation,
 * cellules de tableaux — gardaient le rendu système, clair au milieu d'une
 * interface sombre. Le remède est UNE règle partagée sur les variables de
 * thème, en fin de feuille. Retirer cette règle fait chuter ce test.
 */
test('Listes déroulantes : une seule règle partagée, au thème, dans les deux thèmes', async () => {
  // La règle partagée existe, nue (pas posée écran par écran), et sur les
  // variables de thème — aucune couleur en dur.
  const base = CSS_RULES.filter((r) => !r.media && r.selector === 'select')
    .find((r) => r.declarations.background);
  assert.ok(base, 'la règle partagée `select` de style.css a disparu');
  assert.equal(base.declarations.background, 'var(--bg-elev-2)', 'le fond vient du thème');
  assert.ok(base.declarations.border.includes('var(--border-strong)'), 'la bordure vient du thème');
  assert.equal(base.declarations.color, 'var(--text)', 'le texte vient du thème');
  // La flèche et la liste dépliée restent NATIVES (clavier, lecteurs d'écran,
  // liste système sur mobile) : c'est color-scheme qui les met au thème.
  assert.equal(base.declarations['color-scheme'], 'dark', 'color-scheme suit le thème sombre');
  assert.equal('appearance' in base.declarations, false, 'le select reste natif, flèche comprise');
  // Un libellé long (« Manuel — seulement quand je le lance ») ne déborde pas
  // de sa carte : le select est borné à son conteneur.
  assert.equal(base.declarations['max-width'], '100%', 'borné à son conteneur');

  const clair = CSS_RULES.find((r) => !r.media && r.selector === 'body.light select');
  assert.equal(clair && clair.declarations['color-scheme'], 'light',
    'le thème clair ramène les listes natives en clair');

  // Le focus reste visible au clavier, et l'état désactivé se voit.
  const focus = CSS_RULES.find((r) => r.selector === 'select:focus-visible');
  assert.ok(focus && focus.declarations.outline.includes('var(--accent)'),
    'le focus clavier a disparu');
  const inactif = CSS_RULES.find((r) => r.selector === 'select:disabled');
  assert.ok(inactif && inactif.declarations.opacity, 'l\'état désactivé ne se voit plus');

  // La cascade qui rend le focus effectif : à spécificité égale, la règle la
  // plus tardive gagne — select:focus-visible doit donc venir APRÈS les
  // conteneurs qui posent outline:none sans redonner de focus.
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const posFocus = css.indexOf('select:focus-visible');
  for (const conteneur of ['.toolbar-field select', '.app-card-facts select', '.docs-filters select']) {
    assert.ok(posFocus > css.indexOf(conteneur),
      `select:focus-visible doit rester après ${conteneur}`);
  }

  // Chaque variable employée par la règle existe dans LES DEUX thèmes : une
  // variable d'un seul côté rendrait l'autre thème illisible.
  const blocVars = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
  const sombre = blocVars(':root{');
  const lumineux = blocVars('body.light{');
  for (const variable of ['--bg-elev-2', '--border-strong', '--text', '--accent']) {
    assert.ok(sombre.includes(`${variable}:`), `${variable} manque au thème sombre`);
    assert.ok(lumineux.includes(`${variable}:`), `${variable} n'est pas redéfinie en thème clair`);
  }
});

test('Listes déroulantes : les écrans à selects nus les rendent en vrais <select>', async () => {
  // Optimisation — le constat du lot : mode et récurrence sur chaque volet et
  // sur la globale, en <select> natifs (aucun conteneur stylé autour, c'est la
  // règle partagée qui les habille).
  const app = makeSandbox({ ...FIXTURES, '/admin/optimisation': fixtureOptimisation() });
  await app.run('renderOptimisation()');
  const opt = app.html('optimisation-content');
  const rendus = (opt.match(/<select /g) || []).length;
  assert.equal(rendus, 10, `2 selects × (4 volets + globale) attendus, ${rendus} rendus`);
  assert.ok(opt.includes('Manuel — seulement quand je le lance'),
    'le libellé long du mode manuel est intact');
  assert.ok(opt.includes('Tous les 2 ans'), 'les récurrences sont intactes');

  // Applications en vue liste : la catégorie se change dans une cellule de
  // tableau, select nu là aussi.
  const apps = makeSandbox(FIXTURES);
  await apps.run('renderApps()');
  apps.run('setAppsView("list")');
  assert.match(apps.html('apps-list'), /<td data-label="Catégorie"><select onchange="moveAppCategory\(/,
    'le sélecteur de catégorie de la vue liste reste un <select>');

  // Permissions : le rôle s'assigne dans la matrice, select nu en cellule.
  // La fixture commune n'a aucun compte dans la matrice : on lui en donne un.
  const roles = makeSandbox({
    ...FIXTURES,
    '/admin/roles': {
      ...FIXTURES['/admin/roles'],
      users: [{ id: 7, username: 'camille', roleId: 1, status: 'active', permissions: [] }],
    },
  });
  await roles.run('renderRoles()');
  assert.match(roles.html('roles-tab-matrix'), /<select onchange="assignRole\(/,
    'le sélecteur de rôle de la matrice reste un <select>');

  // Stockage : le type d'un espace est dans un .field — le conteneur garde ses
  // tailles, la règle partagée n'a rien cassé de l'existant.
  const stockage = makeSandbox(FIXTURES);
  await stockage.run('renderAdminStorage()');
  assert.match(stockage.html('admin-storage-list'), /<select id="dest-[^"]*-type"/,
    'le sélecteur de type d\'un espace reste un <select>');
  assert.ok(CSS_RULES.some((r) => !r.media && r.selector === '.field select'),
    'la règle .field select (tailles des formulaires) existe toujours');
});
