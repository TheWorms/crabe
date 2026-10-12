'use strict';

/**
 * Lot 27 — les quatre défauts de ce lot, et le garde-fou de chacun.
 *
 * ─── Pourquoi un fichier de plus, et ce qu'il attrape ────────────────────────
 *
 * Les trois régressions de l'interface ont un point commun qui vaut d'être dit
 * en tête : **aucune n'était visible sans exécuter le code**. `node --check`
 * les déclarait toutes les trois valides, et elles l'étaient — un appel vers une
 * fonction absente, un attribut HTML refermé trop tôt et un rendu qu'on oublie
 * de relancer sont des défauts d'EXÉCUTION, pas de syntaxe.
 *
 * D'où le parti pris de ce fichier : chaque section attrape la CLASSE du défaut,
 * pas seulement l'occurrence corrigée. Rebaptiser une fonction, recopier un
 * bouton depuis une maquette ou ajouter un troisième verrou d'accueil doit
 * faire échouer un test, pas attendre le prochain lot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const bitstamp = require('../server/connectors/available/bitstamp/connector');
const { FIXTURES } = require('./fixtures-front');

const WEB = path.resolve(__dirname, '..', 'web');
const FICHIERS_FRONT = ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js', 'admin.js'];

// ---------------------------------------------------------------------------
// 1. `renderWidgets is not defined` — la classe entière
// ---------------------------------------------------------------------------

/**
 * Les globales que le navigateur fournit et que le front a le droit d'appeler.
 *
 * Volontairement tenue à la main plutôt que devinée : une liste qui s'élargit
 * toute seule finirait par avaler le défaut qu'on cherche. Ajouter une entrée
 * ici doit être un geste réfléchi.
 */
const GLOBALES_NAVIGATEUR = new Set([
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'alert', 'confirm',
  'prompt', 'requestAnimationFrame', 'encodeURIComponent', 'decodeURIComponent', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON',
  'Math', 'Date', 'Set', 'Map', 'Promise', 'Error', 'RegExp', 'Symbol', 'BigInt', 'URL',
  'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Intl', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'structuredClone', 'queueMicrotask', 'btoa', 'atob',
  'TextEncoder', 'TextDecoder', 'AbortController', 'Notification', 'ResizeObserver',
  'IntersectionObserver', 'MutationObserver', 'CustomEvent', 'Event', 'DOMParser',
  'XMLHttpRequest', 'getComputedStyle', 'matchMedia', 'crypto', 'import',
]);

/** Les mots du langage qu'un `(` suit sans qu'il s'agisse d'un appel. */
const MOTS_DU_LANGAGE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await',
  'else', 'do', 'try', 'delete', 'void', 'in', 'of', 'case', 'yield', 'throw', 'instanceof',
  'async', 'this', 'super',
]);

/**
 * Le CODE seul : commentaires et texte des chaînes remplacés par des espaces.
 *
 * Indispensable, et pas par souci de propreté. Sans ce nettoyage, le français
 * des libellés (« 3 document(s) », « réussie(s) ») et le CSS des gabarits
 * (`repeat(…)`, `var(--green)`) ressemblent trait pour trait à des appels de
 * fonction : le balayage rendrait trente fausses alertes, on le désarmerait, et
 * il ne servirait plus à rien le jour où un vrai appel manquant s'y glisse.
 *
 * Les expressions `${…}` des gabarits sont GARDÉES : c'est là que vivent la
 * plupart des appels de l'interface. Les numéros de ligne sont préservés.
 */
function codeSeul(source) {
  let out = '';
  let i = 0;
  // Pile des gabarits ouverts : on y revient en sortant d'un `${…}`.
  const gabarits = [];
  let accolades = 0;

  const espace = (texte) => texte.replace(/[^\n]/g, ' ');

  /**
   * Ce `/` ouvre-t-il une expression régulière, ou est-ce une division ?
   *
   * La question n'est pas théorique : `esc()` contient `.replace(/"/g, …)`, et
   * prendre ce guillemet pour le début d'une chaîne effaçait TOUT le reste de
   * `web/fmt.js` — `logoHtml` et `comparerNoms` disparaissaient de la liste des
   * fonctions connues, et le balayage les dénonçait comme introuvables.
   *
   * La règle usuelle : un `/` qui suit une valeur (identifiant, nombre,
   * parenthèse ou crochet fermant) divise ; partout ailleurs, il ouvre une
   * expression régulière. Les mots-clés font exception — `return /x/` divise
   * quelque chose qui n'existe pas.
   */
  const ouvreUneRegex = () => {
    const avant = out.replace(/\s+$/, '');
    const dernier = avant.at(-1);
    if (!dernier) return true;
    if (!/[\w$)\]]/.test(dernier)) return true;
    const mot = /([A-Za-z_$][\w$]*)$/.exec(avant)?.[1];
    return !!mot && MOTS_DU_LANGAGE.has(mot);
  };

  while (i < source.length) {
    const c = source[i];
    const suivant = source[i + 1];

    if (c === '/' && suivant !== '/' && suivant !== '*' && ouvreUneRegex()) {
      let j = i + 1;
      let classe = false;
      while (j < source.length) {
        const k = source[j];
        if (k === '\\') { j += 2; continue; }
        if (k === '\n') break;
        if (k === '[') classe = true;
        else if (k === ']') classe = false;
        else if (k === '/' && !classe) break;
        j++;
      }
      // Le `/` fermant, puis ses drapeaux.
      let fin = j + 1;
      while (fin < source.length && /[a-z]/.test(source[fin])) fin++;
      out += espace(source.slice(i, fin));
      i = fin;
      continue;
    }

    if (c === '/' && suivant === '/') {
      const fin = source.indexOf('\n', i);
      const bout = fin === -1 ? source.length : fin;
      out += espace(source.slice(i, bout));
      i = bout;
      continue;
    }
    if (c === '/' && suivant === '*') {
      const fin = source.indexOf('*/', i + 2);
      const bout = fin === -1 ? source.length : fin + 2;
      out += espace(source.slice(i, bout));
      i = bout;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      out += espace(source.slice(i, Math.min(j + 1, source.length)));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      gabarits.push(accolades);
      accolades = 0;
      out += ' ';
      i++;
      // Texte du gabarit : tout est effacé jusqu'au prochain `${` ou au backtick.
      while (i < source.length) {
        if (source[i] === '\\') { out += espace(source.slice(i, i + 2)); i += 2; continue; }
        if (source[i] === '`') { out += ' '; i++; accolades = gabarits.pop(); break; }
        if (source[i] === '$' && source[i + 1] === '{') { out += '  '; i += 2; break; }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (c === '}' && gabarits.length && accolades === 0) {
      // Fin d'un `${…}` : on repart dans le texte du gabarit.
      out += ' ';
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { out += espace(source.slice(i, i + 2)); i += 2; continue; }
        if (source[i] === '`') { out += ' '; i++; accolades = gabarits.pop(); break; }
        if (source[i] === '$' && source[i + 1] === '{') { out += '  '; i += 2; break; }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (c === '{') accolades++;
    if (c === '}' && accolades > 0) accolades--;
    out += c;
    i++;
  }
  return out;
}

/**
 * Tout ce que les fichiers du front définissent : fonctions, constantes,
 * classes — et les PARAMÈTRES, sans lesquels un rappel (`onRefus(…)`,
 * `executer(…)`) passerait pour un appel orphelin.
 */
function definitionsDuFront(codes) {
  const noms = new Set();
  const ajouterListe = (liste) => {
    for (const m of liste.matchAll(/(?:^|[,{[(]|\.\.\.)\s*([A-Za-z_$][\w$]*)\s*(?=[,=:)\]}]|$)/g)) {
      noms.add(m[1]);
    }
  };

  for (const code of codes.values()) {
    for (const m of code.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/g)) {
      if (m[1]) noms.add(m[1]);
    }
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) noms.add(m[1]);
    for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) noms.add(m[1]);
    // Un seul paramètre sans parenthèses : `valeur => …`.
    for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) noms.add(m[1]);

    // Listes de paramètres : toute parenthèse équilibrée suivie de `=>`, et
    // toute parenthèse qui suit le mot `function`. Balayage à pile, parce
    // qu'un défaut de paramètre (`nomDe = (x) => x`) contient lui-même des
    // parenthèses et déjouerait n'importe quelle expression régulière.
    const pile = [];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '(') pile.push(i);
      else if (code[i] === ')' && pile.length) {
        const debut = pile.pop();
        const apres = code.slice(i + 1, i + 40).trimStart();
        const avant = code.slice(Math.max(0, debut - 60), debut);
        if (apres.startsWith('=>') || /\bfunction\s*\*?\s*[\w$]*\s*$/.test(avant)) {
          ajouterListe(code.slice(debut + 1, i));
        }
      }
    }
  }
  return noms;
}

test('aucun appel du front ne vise une fonction qui n\'existe pas', () => {
  const codes = new Map(
    FICHIERS_FRONT.map((f) => [f, codeSeul(fs.readFileSync(path.join(WEB, f), 'utf8'))])
  );
  const definis = definitionsDuFront(codes);
  const fautifs = [];

  for (const [fichier, code] of codes) {
    code.split('\n').forEach((ligne, i) => {
      for (const m of ligne.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const nom = m[1];
        if (definis.has(nom) || GLOBALES_NAVIGATEUR.has(nom) || MOTS_DU_LANGAGE.has(nom)) continue;
        fautifs.push(`${fichier}:${i + 1} — ${nom}()`);
      }
    });
  }

  assert.deepEqual(
    fautifs,
    [],
    'appel(s) vers une fonction jamais définie — c\'est exactement le défaut du lot 27 '
      + '(`renderWidgets()` recopié de docs/accueil-reference.html)'
  );
});

test('le balayage attrape bien le défaut qu\'il prétend attraper', () => {
  // Un garde-fou qui ne mord pas est pire qu'aucun garde-fou : on le vérifie
  // sur un cas fabriqué, sinon rien ne distingue « aucun défaut » de
  // « le balayage ne voit rien ».
  const faux = codeSeul(`
    function bonjour() { renderQuiNexistePas(); }
    const texte = 'on a trouvé 3 document(s)';
    const style = \`<div style="grid-template-columns:repeat(3,1fr);color:var(--red)">\${esc(x)}</div>\`;
  `);
  const definis = definitionsDuFront(new Map([['faux', faux]]));
  const trouves = [...faux.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((n) => !definis.has(n) && !GLOBALES_NAVIGATEUR.has(n) && !MOTS_DU_LANGAGE.has(n));

  assert.deepEqual(
    trouves.sort(),
    ['esc', 'renderQuiNexistePas'],
    'le balayage doit voir l\'appel manquant ET l\'appel réel d\'un gabarit, '
      + 'sans se laisser prendre par « document(s) », repeat() ni var()'
  );
});

test('le tri des blocs de l\'accueil appelle la fonction de rendu qui existe', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  // Sur le CODE seul : le commentaire qui raconte la panne cite forcément le
  // mauvais nom, et le chercher dans le fichier entier ferait échouer le test
  // à cause de son propre récit.
  assert.equal(
    codeSeul(app).includes('renderWidgets('),
    false,
    'renderWidgets() n\'existe pas dans le produit'
  );
  assert.match(
    app,
    /function changerTri\([^)]*\) \{\n\s*home\.data\[bloc\] = valeur;\n\s*renderHomeWidgets\(\);/,
    'changerTri() doit redessiner par renderHomeWidgets()'
  );
});

// ---------------------------------------------------------------------------
// 2. Un attribut de gestionnaire ne transporte qu'un identifiant
// ---------------------------------------------------------------------------

test('aucun gestionnaire inline ne reçoit une valeur pouvant contenir un guillemet', () => {
  const fautifs = [];
  for (const fichier of FICHIERS_FRONT) {
    const source = fs.readFileSync(path.join(WEB, fichier), 'utf8');
    source.split('\n').forEach((ligne, i) => {
      // `JSON.stringify()` rend une chaîne AVEC ses guillemets doubles. Posée
      // dans un attribut délimité par des guillemets doubles, elle le referme :
      // le gestionnaire compilé est tronqué, et le clic ne fait plus rien.
      if (/\bon[a-z]+="[^"]*\$\{[^}]*JSON\.stringify/.test(ligne)) {
        fautifs.push(`${fichier}:${i + 1} — ${ligne.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(
    fautifs,
    [],
    'JSON.stringify() dans un attribut on…="…" : c\'est le défaut qui a tué les deux boutons '
      + '« Supprimer » de l\'écran Stockage'
  );
});

test('le bouton « Supprimer » d\'une destination ne transporte que son identifiant', () => {
  const admin = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');

  const appels = [...admin.matchAll(/onclick="supprimerDestination\(([^"]*)\)"/g)].map((m) => m[1]);
  assert.ok(appels.length >= 2, 'les deux boutons Supprimer (le stockage local et cloud) doivent exister');
  for (const args of appels) {
    assert.equal(
      args.includes(','),
      false,
      `le bouton passe encore plusieurs arguments : supprimerDestination(${args})`
    );
    assert.match(args, /^'\$\{esc\(d\.id\)\}'$/, 'seul l\'identifiant échappé doit être passé');
  }

  // Et le nom se relit dans l'état du client, comme les planifications du lot 4.
  assert.match(admin, /admin\.destinations = data\.destinations \|\| \[\];/);
  assert.match(admin, /async function supprimerDestination\(id\) \{/);
});

test('l\'écran Stockage rendu : chaque bouton « Supprimer » COMPILE et agit', async () => {
  // La preuve la plus proche du navigateur qu'on puisse produire sans lui : on
  // rend l'écran pour de vrai, on extrait l'attribut `onclick` du HTML obtenu,
  // et on le COMPILE — c'est exactement ce que fait un navigateur au premier
  // clic. Le défaut du lot 27 produisait un fragment qui ne compile pas.
  //
  // Le nom d'épreuve porte des guillemets doubles, le pire cas et celui que les
  // noms réels mesurés ne couvraient pas : c'est précisément ce caractère qui
  // refermait l'attribut.
  const bac = bacASable();
  const donnees = JSON.parse(JSON.stringify(FIXTURES['/admin/destinations']));
  const cloud = donnees.destinations.find((d) => d.id !== 'local');
  assert.ok(cloud, 'la fixture doit contenir au moins un cloud');
  cloud.displayName = 'Mon "grand" cloud';
  cloud.name = 'Mon "grand" cloud';

  bac.run(`
    __appels = [];
    api = async (chemin, options) => {
      __appels.push(\`\${options?.method || 'GET'} \${chemin}\`);
      if (chemin === '/admin/destinations') return ${JSON.stringify(donnees)};
      if (chemin.startsWith('/admin/destinations/backends')) return { types: [], champs: [] };
      return { restant: 1 };
    };
    confirm = () => true;
  `);
  await bac.run('renderAdminStorage()');

  const html = bac.element('admin-storage-list').innerHTML;
  const boutons = [...html.matchAll(/<button[^>]*class="btn-mini danger"[^>]*onclick="([^"]*)"/g)]
    .map((m) => m[1]);
  assert.ok(boutons.length >= 2, `deux boutons « Supprimer » attendus, ${boutons.length} trouvé(s)`);

  for (const code of boutons) {
    // Compilation, puis exécution : les deux doivent aboutir.
    assert.doesNotThrow(
      () => bac.run(`new Function(${JSON.stringify(code)})`),
      `gestionnaire de clic qui ne compile pas : ${code}`
    );
    await bac.run(`(new Function(${JSON.stringify(code)}))()`);
  }

  const appels = JSON.parse(bac.run('JSON.stringify(__appels)'));
  const suppressions = appels.filter((a) => a.startsWith('DELETE /admin/destinations/'));
  assert.equal(
    suppressions.length,
    boutons.length,
    `chaque bouton doit émettre sa suppression — obtenu : ${JSON.stringify(appels)}`
  );
});

test('un écran périmé ne supprime rien au hasard', async () => {
  const bac = bacASable();
  bac.run(`
    __appels = [];
    __toasts = [];
    admin.destinations = [{ id: 'local', displayName: 'Stockage local' }];
    api = async (chemin, options) => { __appels.push(\`\${options?.method || 'GET'} \${chemin}\`); return {}; };
    showToast = (m) => __toasts.push(m);
    confirm = () => true;
  `);
  await bac.run('supprimerDestination("partie-entre-temps")');

  assert.deepEqual(JSON.parse(bac.run('JSON.stringify(__appels)')), [], 'aucune requête ne doit partir');
  const toasts = JSON.parse(bac.run('JSON.stringify(__toasts)'));
  assert.match(toasts.join(' '), /n'est plus dans la liste/);
});

// ---------------------------------------------------------------------------
// 3. Figer / défiger : le comportement change tout de suite
// ---------------------------------------------------------------------------

/**
 * Un DOM minimal, juste assez pour que `web/app.js` s'exécute.
 *
 * Recopié plutôt que partagé avec test/render.test.js, qui ne l'exporte pas :
 * ce qu'on mesure ici — le CONTENU de deux conteneurs avant et après un geste —
 * n'a besoin de presque rien d'autre.
 */
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
    fetch: async () => { throw new Error('aucun appel réseau dans ce test'); },
    __toasts: [],
  };
  bac.window = bac;
  bac.globalThis = bac;

  const context = vm.createContext(bac);
  for (const fichier of FICHIERS_FRONT) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  vm.runInContext('showToast = (m) => __toasts.push(m);', context);
  return { context, element, run: (code) => vm.runInContext(code, context) };
}

/** L'accueil chargé, avec deux blocs et un compte qui a tous les droits. */
const ACCUEIL = {
  user: { username: 'camille' },
  today: '2026-08-13',
  widgets: [
    { id: 'connecteurs', title: 'Mes connecteurs', icon: 'plug', enabled: true, span: 12 },
    { id: 'documents', title: 'Derniers documents', icon: 'doc', enabled: true, span: 12 },
  ],
  connectors: [{ id: 'free', name: 'Free', color: '#c00', letters: 'FR' }],
  documents: [],
  connecteursTri: 'nom',
  syncTri: 'nom',
  trisCatalog: [
    { id: 'nom', label: 'Nom' },
    { id: 'ajout', label: 'Ajout le plus récent' },
  ],
  access: { adminAllowed: true, personalLock: false, canCustomize: true },
};

test('figer l\'accueil prend effet TOUT DE SUITE, sans rouvrir le panneau', async () => {
  const bac = bacASable();
  bac.run(`
    home.data = ${JSON.stringify(ACCUEIL)};
    home.widgets = home.data.widgets;
    home.access = home.data.access;
    state.me = { id: 1, username: 'camille', home: home.data.access, permissions: [] };
    renderHomeWidgets();
    renderHomePanel();
  `);

  const grille = bac.element('home-widgets');
  const panneau = bac.element('home-panel-list');
  assert.ok(grille.innerHTML.includes('draggable="true"'), 'départ : les blocs se déplacent');
  assert.ok(panneau.innerHTML.includes('Accueil modifiable'), 'départ : le panneau le dit');
  assert.equal(grille.classList.contains('locked'), false);

  // Le serveur répond ce qu'il répond réellement : le profil complet, verrou posé.
  bac.run(`
    api = async () => ({
      user: { id: 1, username: 'camille',
        home: { adminAllowed: true, personalLock: true, canCustomize: false } },
    });
  `);

  // Le geste de l'utilisateur — rien d'autre. Aucune réouverture de panneau.
  await bac.run('toggleHomeLock()');

  assert.equal(
    grille.innerHTML.includes('draggable="true"'),
    false,
    'après le clic, les blocs ne doivent plus se déplacer — sans rouvrir le panneau'
  );
  assert.equal(grille.classList.contains('locked'), true, 'la grille porte la classe locked');
  assert.ok(
    panneau.innerHTML.includes('Accueil figé'),
    'le panneau affiche le nouvel état sans être rouvert'
  );
  assert.ok(
    panneau.innerHTML.includes('Votre accueil est figé'),
    'la note d\'explication apparaît elle aussi tout de suite'
  );
  assert.ok(panneau.innerHTML.includes('disabled'), 'les cases du panneau sont inertes');

  // Et le geste inverse, tout aussi immédiat.
  bac.run(`
    api = async () => ({
      user: { id: 1, username: 'camille',
        home: { adminAllowed: true, personalLock: false, canCustomize: true } },
    });
  `);
  await bac.run('toggleHomeLock()');
  assert.ok(grille.innerHTML.includes('draggable="true"'), 'défiger rend la main immédiatement');
  assert.ok(panneau.innerHTML.includes('Accueil modifiable'));
});

test('les menus de tri de l\'accueil réordonnent, et le choix est enregistré', async () => {
  const bac = bacASable();
  const donnees = JSON.parse(JSON.stringify(ACCUEIL));
  donnees.widgets = [
    { id: 'connecteurs', title: 'Mes connecteurs', icon: 'plug', enabled: true, span: 12 },
    { id: 'sync', title: 'Synchronisation', icon: 'sync', enabled: true, span: 12 },
  ];
  // Rangés comme le serveur les envoie : par nom. `installedAt` les met dans
  // l'ordre INVERSE, pour qu'un changement de menu se voie sans ambiguïté.
  donnees.connectors = [
    { id: 'b', name: 'Alpha', color: '#222', letters: 'AL', installedAt: '2026-01-01' },
    { id: 'a', name: 'Zorro', color: '#111', letters: 'ZO', installedAt: '2026-08-01' },
  ];
  donnees.sync = [
    { id: 'b', name: 'Alpha', color: '#222', letters: 'AL', lastRunAt: '2026-01-02T08:00:00Z',
      status: 'ok', statusLabel: 'À jour', destinations: [] },
    { id: 'a', name: 'Zorro', color: '#111', letters: 'ZO', lastRunAt: '2026-08-02T08:00:00Z',
      status: 'ok', statusLabel: 'À jour', destinations: [] },
  ];
  donnees.syncPageSize = 10;
  donnees.documentsPageSize = 10;
  donnees.pageSizes = [10, 15, 20, 25, 30, 50];

  bac.run(`
    home.data = ${JSON.stringify(donnees)};
    home.widgets = home.data.widgets;
    home.access = home.data.access;
    prefs.values = {};
    __enregistres = [];
    api = async (chemin, options) => { __enregistres.push([chemin, options?.body]); return {}; };
    renderHomeWidgets();
  `);

  const grille = bac.element('home-widgets');
  /** Le HTML d'UN bloc : les deux listent les mêmes noms, il faut les séparer. */
  const bloc = (id) => {
    const morceaux = grille.innerHTML.split(/<div class="widget /);
    const trouve = morceaux.find((m) => m.includes(`data-widget="${id}"`));
    assert.ok(trouve, `bloc « ${id} » introuvable dans la grille`);
    return trouve;
  };
  const rang = (id, nom) => bloc(id).indexOf(`>${nom}<`);

  assert.ok(
    rang('connecteurs', 'Alpha') < rang('connecteurs', 'Zorro'),
    'départ : l\'ordre du serveur, alphabétique'
  );

  // Le geste exact du menu déroulant : `onchange="setConnecteursTri(this.value)"`.
  bac.run('setConnecteursTri("ajout")');
  assert.ok(
    rang('connecteurs', 'Zorro') < rang('connecteurs', 'Alpha'),
    'ajout le plus récent : Zorro (août) passe devant Alpha (janvier) — c\'est CE '
      + 'réordonnancement qui ne se produisait plus'
  );
  bac.run('setConnecteursTri("nom")');
  assert.ok(
    rang('connecteurs', 'Alpha') < rang('connecteurs', 'Zorro'),
    'retour à l\'ordre alphabétique'
  );

  bac.run('setSyncTri("synchro")');
  assert.ok(
    rang('sync', 'Zorro') < rang('sync', 'Alpha'),
    'Synchronisation : la plus récente en tête'
  );
  // Et le bloc voisin n'a pas bougé : deux clés, deux ordres (leçon du lot 25).
  assert.ok(
    rang('connecteurs', 'Alpha') < rang('connecteurs', 'Zorro'),
    'régler un bloc ne dérègle pas l\'autre'
  );

  // Le choix doit aussi être MÉMORISÉ : l'appel d'enregistrement suivait la
  // ligne qui levait, il ne partait donc jamais non plus.
  const enregistres = bac.run('JSON.stringify(__enregistres)');
  const clefs = JSON.parse(enregistres).flatMap(([, body]) => Object.keys(body?.preferences || {}));
  assert.ok(clefs.includes('home.connecteurs.tri'), 'l\'ordre de « Mes connecteurs » est enregistré');
  assert.ok(clefs.includes('home.sync.tri'), 'l\'ordre de « Synchronisation » est enregistré');

  // Le troisième menu de l'accueil — le nombre de lignes de « Derniers
  // documents », réglé depuis le panneau — passe par le même rendu.
  assert.doesNotThrow(() => bac.run('saveHomePageSize("documents", 25)'));
});

// ---------------------------------------------------------------------------
// 4. Bitstamp — la fenêtre est appliquée par crabe, pas par `since_timestamp`
// ---------------------------------------------------------------------------

/**
 * Un faux Bitstamp qui SIGNE ses réponses comme le vrai.
 *
 * Sans cette signature, `appel()` refuse tout et le test ne mesurerait que son
 * propre garde-fou. Le nonce et l'horodatage se lisent dans les en-têtes de la
 * requête : c'est exactement ce que fait le serveur.
 */
function faussebourse({ secret, operations }) {
  const recues = [];
  const faux = async (url, options) => {
    const corps = String(options.body || '');
    const params = new URLSearchParams(corps);
    recues.push(Object.fromEntries(params));

    const offset = Number(params.get('offset') || 0);
    const limit = Number(params.get('limit') || 100);
    const page = operations.slice(offset, offset + limit);
    const texte = JSON.stringify(page);
    const typeContenu = 'application/json';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${options.headers['X-Auth-Nonce']}${options.headers['X-Auth-Timestamp']}${typeContenu}${texte}`, 'utf8')
      .digest('hex')
      .toUpperCase();

    return {
      status: 200,
      ok: true,
      headers: {
        get: (nom) => (nom.toLowerCase() === 'content-type'
          ? typeContenu
          : nom.toLowerCase() === 'x-server-auth-signature'
            ? signature
            : null),
      },
      text: async () => texte,
    };
  };
  return { faux, recues };
}

test('Bitstamp : plus aucun since_timestamp, et la fenêtre tenue par crabe', async () => {
  const secret = 'secret-de-test-bitstamp';
  const operations = [
    { id: 1, datetime: '2024-03-05 10:00:00.000000', type: 2, eur: '10.00', fee: '0.1' },
    { id: 2, datetime: '2025-11-20 11:00:00.000000', type: 2, eur: '20.00', fee: '0.2' },
    { id: 3, datetime: '2026-02-10 12:00:00.000000', type: 2, eur: '30.00', fee: '0.3' },
    { id: 4, datetime: '2026-07-04 13:00:00.000000', type: 2, eur: '40.00', fee: '0.4' },
  ];
  const { faux, recues } = faussebourse({ secret, operations });
  const vraiFetch = globalThis.fetch;
  globalThis.fetch = faux;

  try {
    const documents = await bitstamp.fetchInvoices(
      { apiKey: 'cle-de-test', apiSecret: secret, historique: 'courante' },
      { knownRemoteIds: [], conservationMois: 0 }
    );

    assert.ok(recues.length >= 1, 'au moins un appel doit partir');
    for (const envoi of recues) {
      assert.equal(
        'since_timestamp' in envoi,
        false,
        'since_timestamp ne doit plus JAMAIS partir : Bitstamp le plafonne à 30 jours, '
          + 'et les fenêtres de crabe tombent sur un 1er janvier'
      );
      assert.equal(envoi.sort, 'asc', 'le tri asc est ce qui rend la pagination par offset stable');
    }

    // « Année en cours » en 2026 : 2024 et 2025 sont écartés PAR CRABE, et les
    // deux mois révolus de 2026 produisent chacun leur relevé.
    const mois = documents.map((d) => d.remoteId).sort();
    assert.deepEqual(mois, ['bitstamp-releve-2026-02', 'bitstamp-releve-2026-07']);
  } finally {
    globalThis.fetch = vraiFetch;
  }
});

test('Bitstamp : sans borne, tout l\'historique est repris', async () => {
  const secret = 'secret-de-test-bitstamp';
  const operations = [
    { id: 1, datetime: '2021-02-28 10:00:00.000000', type: 2, eur: '10.00', fee: '0.1' },
    { id: 2, datetime: '2026-01-15 11:00:00.000000', type: 2, eur: '20.00', fee: '0.2' },
  ];
  const { faux } = faussebourse({ secret, operations });
  const vraiFetch = globalThis.fetch;
  globalThis.fetch = faux;

  try {
    const documents = await bitstamp.fetchInvoices(
      { apiKey: 'cle-de-test', apiSecret: secret, historique: 'tout' },
      { knownRemoteIds: [], conservationMois: 0 }
    );
    assert.deepEqual(
      documents.map((d) => d.remoteId).sort(),
      ['bitstamp-releve-2021-02', 'bitstamp-releve-2026-01']
    );
  } finally {
    globalThis.fetch = vraiFetch;
  }
});

test('Bitstamp : un relevé déjà déposé n\'est pas reproduit', async () => {
  const secret = 'secret-de-test-bitstamp';
  const operations = [
    { id: 1, datetime: '2026-01-15 11:00:00.000000', type: 2, eur: '20.00', fee: '0.2' },
    { id: 2, datetime: '2026-02-15 11:00:00.000000', type: 2, eur: '25.00', fee: '0.2' },
  ];
  const { faux } = faussebourse({ secret, operations });
  const vraiFetch = globalThis.fetch;
  globalThis.fetch = faux;

  try {
    const documents = await bitstamp.fetchInvoices(
      { apiKey: 'cle-de-test', apiSecret: secret, historique: 'tout' },
      { knownRemoteIds: ['bitstamp-releve-2026-01'], conservationMois: 0 }
    );
    assert.deepEqual(documents.map((d) => d.remoteId), ['bitstamp-releve-2026-02']);
  } finally {
    globalThis.fetch = vraiFetch;
  }
});
