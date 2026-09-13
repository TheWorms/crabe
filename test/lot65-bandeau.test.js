'use strict';

/**
 * Lot 65 — un seul bandeau, au centre, qui s'efface quand il n'a plus rien à
 * dire ; et des cartes de synchronisation qui cessent de se déformer.
 *
 * ─── Le défaut mesuré ────────────────────────────────────────────────────────
 *
 * Le 26/08/2026 à 12:10, sur l'écran de l'utilisateur : SIX bandeaux pleine largeur
 * empilés (un par récupération lancée ensemble) qui repoussaient l'accueil vers
 * le bas ; l'un d'eux déversait quatre lignes d'explication déjà présentes mot
 * pour mot dans la carte juste en dessous ; un autre affichait « Récupération
 * Darty : en cours — en cours ». Dans le bloc Synchronisation, la carte
 * Decathlon faisait trois fois la hauteur des autres.
 *
 * ─── Ce que ce fichier protège ───────────────────────────────────────────────
 *
 *   1. Plusieurs opérations donnent UNE ligne, pas six.
 *   2. Le dépliage montre chaque opération et son écran.
 *   3. L'ordre d'IMPORTANCE : échec, puis en cours, puis terminé — jamais
 *      l'ordre d'arrivée.
 *   4. Un succès s'efface au bout de quinze secondes ; un échec, jamais seul.
 *   5. `prefers-reduced-motion` coupe l'animation, et la pulsation d'alerte
 *      reste LENTE (jamais un clignotement).
 *   6. Le libellé n'est plus doublé.
 *   7. Un message long se replie dans sa carte, et un échec reste lisible sans
 *      déplier.
 *
 * Les fonctions d'écran sont exécutées telles quelles, découpées dans le VRAI
 * `web/app.js` : c'est le code livré qui est mesuré, pas une réécriture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');
const operations = require('../server/operations');
const harmonisation = require('../server/harmonisation');
const scheduler = require('../server/scheduler');

const WEB = path.resolve(__dirname, '..', 'web');
const APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');

let compte;

/** Remplace une fonction de lecture le temps d'un test, puis la remet. */
function patch(t, module_, prop, valeur) {
  const original = module_[prop];
  module_[prop] = valeur;
  t.after(() => {
    module_[prop] = original;
  });
}

/** L'état neutre d'un renommage : rien ne tourne, rien ne vient de finir. */
function renommageAuRepos() {
  return {
    running: false, phase: null, phaseFinie: null, userId: null,
    demarreLe: null, termineLe: null, total: 0, faites: 0,
    message: '', refus: null, arret: null,
  };
}

/** Les messages RÉELS mesurés dans `run_logs` du CT le 26/08/2026. */
const MESSAGE_DECATHLON =
  'Votre historique Decathlon a bien été lu (2 achat(s) — 1 commande(s) en ligne, 1 en magasin '
  + '— aucun document à descendre). Decathlon ne sert pas de facture directement sur ses pages : '
  + 'pour une commande en ligne, le site propose « Demander ma facture » (la demande part chez le '
  + 'vendeur, et crabe ne la déclenche pas à votre place) ; pour un achat en magasin, un '
  + 'formulaire d\'informations à remplir et à envoyer.';
const MESSAGE_MULTILIGNE =
  'locator.click: Timeout 45000ms exceeded.\nCall log:\n  - waiting for locator(\'#submit-login\')'
  + '\n    - locator resolved to <button type="submit">…</button>\n  - attempting click action';

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({
    username: 'bandeau65',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. Le serveur : une phrase, un ordre, deux fenêtres
// ---------------------------------------------------------------------------

test('le libellé n\'est plus doublé : une récupération en cours n\'invente aucun détail', (t) => {
  patch(t, scheduler, 'runningPairs', () => [
    { userId: compte.id, connectorId: 'darty', startedAt: '2026-08-26T10:00:00.000Z' },
  ]);

  const op = operations.operationsPour({ id: compte.id }).find((o) => o.type === 'recuperation');
  assert.ok(op);
  assert.equal(op.etat, 'en-cours');
  assert.equal(
    op.detail,
    null,
    'le mot « en cours » appartient à l\'état ; le répéter dans le détail donnait '
      + '« Récupération Darty : en cours — en cours »'
  );
});

test('le texte long d\'un connecteur est ramené à UNE phrase', () => {
  const court = operations.phraseCourte(MESSAGE_DECATHLON);
  assert.ok(court.length < MESSAGE_DECATHLON.length / 3, 'le mode d\'emploi ne descend pas au bandeau');
  assert.ok(court.length <= operations.LONGUEUR_DETAIL);
  assert.match(court, /^Votre historique Decathlon a bien été lu/);
  assert.equal(
    court.includes('Demander ma facture'),
    false,
    'ce que dit la carte du connecteur n\'est pas répété par le bandeau'
  );

  // Une pile d'appels de 31 lignes tient elle aussi sur une ligne.
  const pile = operations.phraseCourte(MESSAGE_MULTILIGNE);
  assert.equal(pile.includes('\n'), false, 'aucun saut de ligne ne descend dans le bandeau');
  assert.equal(pile, 'locator.click: Timeout 45000ms exceeded.');
});

test('le raccourcissement est APPLIQUÉ à ce que le bandeau sert vraiment', (t) => {
  // Mesurer `phraseCourte()` toute seule ne prouve rien : il faut que la vue
  // s'en serve. C'est le trajet complet — run_logs → operationsPour → détail —
  // qui est vérifié ici, avec le message réel de Decathlon (565 caractères).
  const ligne = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, invoice_count, message)
     VALUES ('decathlon', ?, datetime('now'), 1, 'manual', 0, ?)`
  ).run(compte.id, MESSAGE_DECATHLON);
  t.after(() => {
    helpers.db.get().prepare('DELETE FROM run_logs WHERE id = ?').run(ligne.lastInsertRowid);
  });

  const op = operations.operationsPour({ id: compte.id }).find((o) => o.type === 'recuperation');
  assert.ok(op, 'la récupération est bien annoncée');
  assert.ok(
    op.detail.length <= operations.LONGUEUR_DETAIL,
    `le bandeau a servi ${op.detail.length} caractères — quatre lignes déversées sous la barre du haut`
  );
  assert.equal(
    op.detail.includes('Demander ma facture'),
    false,
    'le mode d\'emploi appartient à la carte du connecteur, pas au bandeau'
  );
});

test('une phrase trop longue est coupée au MOT, jamais au milieu d\'un mot', () => {
  const sansPoint = `${'alphabet '.repeat(30)}fin`;
  const court = operations.phraseCourte(sansPoint);
  assert.ok(court.length <= operations.LONGUEUR_DETAIL + 1, 'la borne est tenue');
  assert.match(court, /…$/, 'la coupure est signalée');

  // Ce qui est gardé l'est mot pour mot, et s'arrête PILE entre deux mots.
  const garde = court.slice(0, -1);
  assert.ok(sansPoint.startsWith(garde), 'le début est conservé tel quel');
  assert.equal(
    sansPoint[garde.length],
    ' ',
    'la coupure tombe entre deux mots — jamais « alphab… » au milieu d\'un mot'
  );

  // Rien à dire ne devient pas une chaîne vide accrochée à un tiret.
  for (const rien of [null, undefined, '', '   ']) {
    assert.equal(operations.phraseCourte(rien), null);
  }
});

test('l\'ordre est celui de l\'IMPORTANCE : échec, puis en cours, puis terminé', (t) => {
  // Un échec ANCIEN et des succès FRAIS : l'ordre d'arrivée mettrait les succès
  // devant, et le bandeau annoncerait « terminées » alors qu'il y a une erreur.
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: compte.id,
    demarreLe: '2026-08-26T09:00:00.000Z',
    termineLe: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    arret: 'La destination pCloud n\'a pas répondu.',
    message: 'La destination pCloud n\'a pas répondu.',
  }));
  patch(t, scheduler, 'runningPairs', () => [
    { userId: compte.id, connectorId: 'darty', startedAt: new Date().toISOString() },
  ]);

  const insert = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, invoice_count, message)
     VALUES (?, ?, datetime('now'), 1, 'manual', 0, 'Aucune nouvelle facture')`
  );
  const ligne = insert.run('ldlc', compte.id);
  t.after(() => {
    helpers.db.get().prepare('DELETE FROM run_logs WHERE id = ?').run(ligne.lastInsertRowid);
  });

  const etats = operations.operationsPour({ id: compte.id }).map((o) => o.etat);
  assert.deepEqual(
    etats,
    ['echec', 'en-cours', 'succes'],
    'l\'état dominant affiché est le plus important, pas le plus récent'
  );
});

test('deux fenêtres : un succès s\'efface vite, un échec attend une décision', (t) => {
  const ilYA = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // Un succès de cinq minutes n'est plus « ce qui vient de se passer ».
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: compte.id,
    termineLe: ilYA(5),
    message: '324 documents renommés.',
  }));
  assert.equal(
    operations.operationsPour({ id: compte.id }).find((o) => o.type === 'renommage'),
    undefined,
    `un succès de 5 min est hors de la fenêtre de ${operations.FENETRE_SUCCES_MIN} min`
  );

  // Le MÊME instant, en échec, s'annonce toujours : il demande une décision.
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: compte.id,
    termineLe: ilYA(5),
    arret: 'La destination pCloud n\'a pas répondu.',
    message: 'La destination pCloud n\'a pas répondu.',
  }));
  const echec = operations.operationsPour({ id: compte.id }).find((o) => o.type === 'renommage');
  assert.ok(echec, 'un échec de 5 min est toujours annoncé');
  assert.equal(echec.etat, 'echec');

  // Mais il ne s'accumule pas indéfiniment : passé la fenêtre, il appartient
  // au journal et à la fiche — sans quoi chaque échec de la nuit accueillerait
  // l'utilisateur au petit déjeuner comme une alerte fraîche.
  patch(t, harmonisation, 'progress', () => ({
    ...renommageAuRepos(),
    phaseFinie: 'renommage',
    userId: compte.id,
    termineLe: ilYA(operations.FENETRE_ECHEC_MIN + 10),
    arret: 'La destination pCloud n\'a pas répondu.',
    message: 'La destination pCloud n\'a pas répondu.',
  }));
  assert.equal(
    operations.operationsPour({ id: compte.id }).find((o) => o.type === 'renommage'),
    undefined
  );
});

test('un échec de récupération n\'est jamais évincé par des succès plus frais', (t) => {
  // La balayée du 26/08 a produit 25 lignes en une demi-heure. Si la requête
  // rendait les cinq plus récentes, l'échec de Darty aurait disparu derrière
  // les succès qui l'ont suivi.
  const insert = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, invoice_count, message)
     VALUES (?, ?, datetime('now', ?), ?, 'manual', 0, ?)`
  );
  const lignes = [insert.run('darty', compte.id, '-40 minutes', 0, 'Le site a renvoyé la lecture vers sa page d\'authentification.')];
  for (let i = 0; i < 12; i += 1) {
    lignes.push(insert.run(`succes-${i}`, compte.id, '-10 seconds', 1, 'Aucune nouvelle facture'));
  }
  t.after(() => {
    const del = helpers.db.get().prepare('DELETE FROM run_logs WHERE id = ?');
    for (const l of lignes) del.run(l.lastInsertRowid);
  });

  const ops = operations.operationsPour({ id: compte.id }).filter((o) => o.type === 'recuperation');
  const rouge = ops.find((o) => o.etat === 'echec');
  assert.ok(rouge, 'l\'échec de 40 min survit à douze succès plus frais');
  assert.equal(ops[0].etat, 'echec', 'et il passe devant');
  assert.ok(ops.length <= operations.MAX_FINIES, 'la borne est tenue');
});

// ---------------------------------------------------------------------------
// 2. L'écran : le VRAI web/app.js, dans un bac à sable
// ---------------------------------------------------------------------------

/**
 * Découpe et exécute les morceaux de `web/app.js` dont ce fichier a besoin.
 *
 * `web/fmt.js` est chargé en entier — c'est lui qui porte `esc()`. Le reste est
 * découpé entre marqueurs : `app.js` appelle des API de navigateur au
 * chargement, et on ne garde que le bandeau et les cartes de synchronisation.
 */
function bacASable({ maintenant = Date.now() } = {}) {
  const zone = { innerHTML: '' };
  const stockage = new Map();

  const horloge = class extends Date {
    static now() { return maintenant; }
  };

  const contexte = vm.createContext({
    console, Number, String, Array, Math, JSON, Intl, RegExp, Object,
    Date: horloge,
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: { getElementById: () => null },
    sessionStorage: {
      getItem: (k) => (stockage.has(k) ? stockage.get(k) : null),
      setItem: (k, v) => stockage.set(k, v),
    },
    // Le bandeau et les cartes n'ont besoin que de ces deux-là.
    $: (id) => (id === 'op-banner' ? zone : null),
    logoHtml: () => '',
    home: { data: { sync: [] } },
  });

  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);

  const morceau = (debut, fin) => {
    const i = APP.indexOf(debut);
    const j = APP.indexOf(fin);
    assert.ok(i !== -1 && j > i, `marqueur introuvable dans web/app.js : ${debut} → ${fin}`);
    return APP.slice(i, j);
  };

  // Les cartes de synchronisation : de `syncEtat` à `runHomeSync`.
  vm.runInContext(morceau('function syncEtat(c) {', 'async function runHomeSync('), contexte);
  // Le bandeau : de son état à la section « Démarrage ».
  vm.runInContext(morceau('const opsBandeau = {', '\n// Démarrage\n'), contexte);

  return { contexte, zone };
}

/** Le même bac à sable, avec le bandeau garni d'opérations. */
function bandeauSur(operationsJson, options = {}) {
  const { contexte, zone } = bacASable(options);
  contexte.charge = operationsJson;
  vm.runInContext('opsBandeau.operations = charge; majBandeauOperations();', contexte);
  return { contexte, zone, html: zone.innerHTML };
}

/**
 * L'instant de référence des jeux d'essai : 26/08/2026 10:32:25 UTC, quelques
 * secondes après le démarrage de `paybyphone` (run_logs 420) mesuré sur le CT.
 */
const MAINTENANT = Date.parse('2026-08-26T10:32:25.000Z');

/**
 * Six opérations comme celles de la balayée du 26/08 : trois échecs (les vrais
 * — Darty, Bricomarché, EDF), une récupération en cours, deux succès frais.
 *
 * ⚠ Les succès sont datés DANS leur fenêtre de quinze secondes. Un jeu d'essai
 * daté à la louche verrait ses succès s'effacer, et le bandeau n'aurait plus
 * que deux lignes à agréger — c'est arrivé à la première écriture de ce
 * fichier, et c'est le test qui l'a dit.
 */
function sixOperations() {
  const iso = (decalageMs) => new Date(MAINTENANT + decalageMs).toISOString();

  const echecs = [
    ['Darty', 'Le site a renvoyé la lecture automatique vers sa page d\'authentification.'],
    ['Bricomarché', 'Votre connexion à Bricomarché est bien enregistrée, mais le site a refusé le passage.'],
    ['EDF', 'EDF a refusé la connexion automatisée : son site est gardé par un dispositif anti-robot.'],
  ].map(([nom, detail], i) => ({
    cle: `recuperation:${nom.toLowerCase()}:${iso(-(20 + i) * 60 * 1000)}`,
    type: 'recuperation',
    titre: `Récupération ${nom}`,
    etat: 'echec',
    detail,
    faites: null,
    total: null,
    ecran: 'home',
    demarreLe: iso(-(25 + i) * 60 * 1000),
    termineLe: iso(-(20 + i) * 60 * 1000),
  }));

  const encours = {
    cle: 'recuperation:paybyphone:2026-08-26T10:32:23.000Z',
    type: 'recuperation',
    titre: 'Récupération PayByPhone',
    etat: 'en-cours',
    detail: null,
    faites: null,
    total: null,
    ecran: 'home',
    demarreLe: '2026-08-26T10:32:23.000Z',
    termineLe: null,
  };

  const succes = ['LDLC', 'Vistaprint'].map((nom, i) => ({
    cle: `recuperation:${nom.toLowerCase()}:${iso(-(i + 2) * 1000)}`,
    type: 'recuperation',
    titre: `Récupération ${nom}`,
    etat: 'succes',
    detail: 'Aucune nouvelle facture',
    faites: null,
    total: null,
    ecran: 'home',
    demarreLe: iso(-60 * 1000),
    termineLe: iso(-(i + 2) * 1000),
  }));

  // L'ordre d'importance est celui que le serveur produit (`RANG_ETAT`).
  return [...echecs, encours, ...succes];
}

/** La seule récupération qui TOURNE dans le jeu des six. */
function enCours() {
  return sixOperations().find((o) => o.etat === 'en-cours');
}

test('six opérations donnent UNE ligne agrégée, pas six bandeaux', () => {
  const { html } = bandeauSur(sixOperations(), { maintenant: MAINTENANT });

  assert.equal(
    (html.match(/class="op-box/g) || []).length,
    1,
    'un seul bandeau — six barres empilées repoussaient l\'accueil vers le bas'
  );
  assert.match(html, /6 opérations — 3 en échec/, 'la ligne dit combien, et l\'état dominant');
  assert.match(html, /class="op-box echec"/, 'l\'erreur commande la couleur du bandeau');
  assert.match(html, /role="alert"/);
  assert.match(html, /<details class="op-detail"/, 'le détail se déplie');

  // Le mode d'emploi du connecteur n'est nulle part dans le bandeau.
  assert.equal(html.includes('Demander ma facture'), false);
});

test('le dépliage montre chaque opération, et chacune mène à son écran', () => {
  const { html } = bandeauSur(sixOperations(), { maintenant: MAINTENANT });

  const lignes = html.match(/class="op-item [^"]+"/g) || [];
  assert.equal(lignes.length, 6, 'une ligne par opération dans le repli');

  for (const titre of ['Darty', 'Bricomarché', 'EDF', 'PayByPhone', 'LDLC', 'Vistaprint']) {
    assert.ok(html.includes(`Récupération ${titre}`), `${titre} est dans le détail`);
  }
  assert.equal(
    (html.match(/ouvrirEcranOperation\(/g) || []).length,
    6,
    'chaque ligne du détail mène à son écran'
  );
});

test('une seule opération : la ligne dit laquelle, sans dépliage inutile', () => {
  const { html } = bandeauSur([enCours()], { maintenant: MAINTENANT });

  assert.equal(html.includes('<details'), false, 'rien à déplier pour une seule opération');
  assert.match(html, /Récupération PayByPhone/);
  assert.match(html, /class="op-box encours"/);
  assert.match(html, /ouvrirEcranOperation\(/);
});

test('« en cours — en cours » a disparu : le tiret n\'apparaît qu\'avec un détail', () => {
  const { html } = bandeauSur([enCours()], { maintenant: MAINTENANT });
  assert.equal(html.includes('en cours — en cours'), false, 'le libellé n\'est plus doublé');
  assert.match(html, /Récupération PayByPhone<\/b> : en cours\s*</);
});

test('un succès s\'efface au bout de quinze secondes ; un échec, jamais', () => {
  const fini = '2026-08-26T10:30:00.000Z';
  const instant = Date.parse(fini);
  const succes = {
    cle: 'recuperation:ldlc:fin', type: 'recuperation', titre: 'Récupération LDLC',
    etat: 'succes', detail: 'Aucune nouvelle facture', faites: null, total: null,
    ecran: 'home', demarreLe: fini, termineLe: fini,
  };
  const echec = { ...succes, cle: 'recuperation:darty:fin', titre: 'Récupération Darty', etat: 'echec' };

  // 14 secondes : encore là.
  assert.match(
    bandeauSur([succes], { maintenant: instant + 14000 }).html,
    /Récupération LDLC/,
    'le compte rendu a le temps d\'être lu'
  );
  // 16 secondes : parti tout seul.
  assert.equal(
    bandeauSur([succes], { maintenant: instant + 16000 }).html,
    '',
    'un succès s\'efface tout seul — c\'est le délai de dix minutes du lot 59 qui empilait l\'écran'
  );
  // Le même instant, en échec : toujours là, et il le reste.
  for (const age of [16000, 3600 * 1000]) {
    assert.match(
      bandeauSur([echec], { maintenant: instant + age }).html,
      /Récupération Darty/,
      'une erreur demande une décision : elle ne part pas toute seule'
    );
  }
});

test('mélange : une opération en erreur et une terminée — le bandeau reste, l\'erreur commande', () => {
  const fini = '2026-08-26T10:30:00.000Z';
  const instant = Date.parse(fini);
  const base = {
    type: 'recuperation', detail: 'Aucune nouvelle facture', faites: null, total: null,
    ecran: 'home', demarreLe: fini, termineLe: fini,
  };
  const melange = [
    { ...base, cle: 'a', titre: 'Récupération Darty', etat: 'echec' },
    { ...base, cle: 'b', titre: 'Récupération LDLC', etat: 'succes' },
  ];

  // Passé le délai, le succès est parti ; l'erreur tient le bandeau seule.
  const { html } = bandeauSur(melange, { maintenant: instant + 30000 });
  assert.match(html, /class="op-box echec"/);
  assert.match(html, /Récupération Darty/);
  assert.equal(html.includes('Récupération LDLC'), false, 'le succès s\'est effacé, l\'erreur non');
  assert.equal(html.includes('<details'), false, 'il n\'en reste qu\'une : plus rien à déplier');
});

test('la croix n\'acquitte que ce qui est FINI — une opération qui tourne reste', () => {
  const { contexte, zone } = bacASable({ maintenant: MAINTENANT });
  contexte.charge = sixOperations();
  vm.runInContext('opsBandeau.operations = charge; majBandeauOperations(); fermerOperationsFinies();', contexte);

  assert.match(zone.innerHTML, /Récupération PayByPhone/, 'ce qui tourne ne se ferme pas');
  assert.equal(zone.innerHTML.includes('Récupération Darty'), false, 'la fin est acquittée');
  assert.equal(zone.innerHTML.includes('<details'), false, 'il ne reste qu\'une opération');
});

// ---------------------------------------------------------------------------
// 3. La feuille de style : lente, et coupée par le réglage système
// ---------------------------------------------------------------------------

test('l\'alerte pulse LENTEMENT — jamais un clignotement', () => {
  const regle = CSS.match(/\.op-box\.echec\{[^}]*animation:\s*op-alerte\s+([\d.,]+)s/);
  assert.ok(regle, 'l\'état rouge porte bien une pulsation');

  const secondes = Number(regle[1].replace(',', '.'));
  assert.ok(
    secondes >= 1.5,
    `un cycle de ${secondes}s : au-delà de trois flashs par seconde, c'est un risque réel `
      + 'pour les personnes photosensibles'
  );

  // Le texte reste lisible : la pulsation porte sur le halo, pas sur l'opacité
  // de la pastille entière.
  const trame = CSS.slice(CSS.indexOf('@keyframes op-alerte'), CSS.indexOf('@keyframes op-alerte') + 260);
  assert.match(trame, /box-shadow/);
  assert.equal(/opacity/.test(trame), false, 'jamais le texte : il doit rester lisible en permanence');
});

test('« moins d\'animations » coupe TOUTES les animations du bandeau', () => {
  const i = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(i !== -1, 'la préférence système est honorée');
  const bloc = CSS.slice(i, CSS.indexOf('}', CSS.indexOf('animation:none', i)));

  assert.match(bloc, /\.op-box\.echec/, 'la pulsation de l\'alerte s\'arrête');
  assert.match(bloc, /op-dot/, 'le point de l\'opération en cours aussi');
  assert.match(bloc, /animation:\s*none/);
});

test('la pastille est centrée et ne prend pas toute la ligne', () => {
  const bandeau = CSS.match(/\.op-banner\{([^}]*)\}/);
  assert.ok(bandeau);
  assert.match(bandeau[1], /justify-content:\s*center/, 'centré dans l\'en-tête');

  const boite = CSS.match(/\.op-box\{([^}]*)\}/);
  assert.ok(boite);
  assert.match(boite[1], /max-width:\s*min\(/, 'une largeur bornée, pas la ligne entière');
  assert.match(boite[1], /width:\s*max-content/, 'elle ne s\'étale pas au-delà de son texte');

  // Les trois états gardent leur couleur, et la couleur DOUBLE le texte.
  for (const etat of ['encours', 'succes', 'echec']) {
    assert.match(CSS, new RegExp(`\\.op-box\\.${etat}\\{background:var\\(--`), `état ${etat}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Phase 2bis — les cartes de synchronisation gardent leur hauteur
// ---------------------------------------------------------------------------

/** Rend une carte de synchronisation avec le VRAI `syncCard` de web/app.js. */
function carteSync(service) {
  const { contexte } = bacASable();
  contexte.service = service;
  return vm.runInContext('syncCard(service)', contexte);
}

const SERVICES_MELES = [
  { id: 'ldlc', name: 'LDLC', color: '#111', letters: 'LD', lastMessage: 'Aucune nouvelle facture', lastOk: true },
  { id: 'decathlon', name: 'Decathlon', color: '#222', letters: 'DE', lastMessage: MESSAGE_DECATHLON, lastOk: true },
  {
    id: 'darty',
    name: 'Darty',
    color: '#333',
    letters: 'DA',
    lastOk: false,
    lastMessage:
      'Votre connexion à Darty est bien enregistrée, mais le site a renvoyé la lecture automatique '
      + 'vers sa page d\'authentification au lieu de servir votre espace client. Si cette connexion '
      + 'date de plusieurs semaines, elle a probablement expiré : rouvrez-la depuis la fiche du service.',
  },
  { id: 'ovh', name: 'OVH', color: '#444', letters: 'OV', lastRunAt: '2026-08-26T10:32:13.000Z' },
];

test('un message long se replie : la carte n\'affiche qu\'une ligne', () => {
  const carte = carteSync(SERVICES_MELES[1]);

  assert.match(carte, /<details class="sync-plus">/, 'le mécanisme de repli du lot 57, réutilisé');
  assert.equal(carte.includes(' open'), false, 'replié au repos — c\'est ce qui égalise les hauteurs');

  // Ce qui est VISIBLE est une ligne ; le texte entier n'est que dans le repli.
  const resume = carte.match(/<span class="sync-resume">([\s\S]*?)<\/span>/);
  assert.ok(resume, 'la ligne visible existe');
  assert.ok(resume[1].length <= 120, `ligne visible de ${resume[1].length} caractères`);
  assert.equal(resume[1].includes('Demander ma facture'), false);

  // Et le texte entier est bien là, une fois déplié.
  const corps = carte.match(/<div class="sync-plus-corps">([\s\S]*?)<\/div>/);
  assert.ok(corps);
  assert.ok(corps[1].includes('Demander ma facture'), 'rien n\'est perdu : tout est dans le repli');
});

test('un message court ne se replie pas — pas de « Tout lire » qu\'il ne mérite pas', () => {
  const carte = carteSync(SERVICES_MELES[0]);
  assert.equal(carte.includes('<details'), false);
  assert.match(carte, /<span class="sync-ligne">Aucune nouvelle facture<\/span>/);
});

test('un échec se lit SANS déplier : personne ne clique pour découvrir un échec', () => {
  const carte = carteSync(SERVICES_MELES[2]);

  const resume = carte.match(/<span class="sync-resume">([\s\S]*?)<\/span>/);
  assert.ok(resume, 'même long, l\'échec a une ligne visible');
  assert.match(resume[1], /class="sync-echec">Échec<\/b>/, 'le mot « Échec » ouvre la ligne');
  assert.match(resume[1], /connexion à Darty/, 'et la ligne dit POURQUOI, en une phrase');

  // Le détail complet reste disponible dans le repli.
  assert.match(carte, /<div class="sync-plus-corps">[\s\S]*rouvrez-la depuis la fiche/);
});

test('« Échec » n\'est pas écrit deux fois quand le connecteur le dit déjà', () => {
  const carte = carteSync({
    id: 'edf', name: 'EDF', color: '#555', letters: 'ED', lastOk: false,
    lastMessage: 'Échec — EDF a refusé la connexion automatisée : son site est gardé par un '
      + 'dispositif anti-robot. Ce n\'est pas un problème avec votre compte.',
  });
  const resume = carte.match(/<span class="sync-resume">([\s\S]*?)<\/span>/)[1];
  assert.equal((resume.match(/Échec/g) || []).length, 1, 'une seule fois — leçon du lot 65 sur les doublons');
});

test('la règle vaut pour TOUS les connecteurs : au repos, toutes les cartes ont la même structure', () => {
  const cartes = SERVICES_MELES.map(carteSync);

  for (const [i, carte] of cartes.entries()) {
    const nom = SERVICES_MELES[i].name;
    // Exactement une ligne d'état visible par carte — courte, longue ou en échec.
    assert.equal(
      (carte.match(/class="sync-ligne"/g) || []).length,
      1,
      `${nom} : une seule ligne d'état au repos`
    );
    assert.equal(carte.includes(' open'), false, `${nom} : rien n'est déplié au repos`);
    // Et le même squelette : en-tête, état, action.
    for (const bloc of ['sync-card-head', 'sync-card-state', 'sync-card-actions']) {
      assert.ok(carte.includes(bloc), `${nom} : ${bloc}`);
    }
  }

  // La hauteur ne se mesure pas sans navigateur : ce qui la garantit, c'est que
  // la ligne visible est coupée par la feuille de style. On vérifie la règle.
  const ligne = CSS.match(/\.sync-ligne\{([^}]*)\}/);
  assert.ok(ligne, 'la règle qui coupe la ligne existe');
  for (const propriete of ['white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']) {
    assert.ok(ligne[1].includes(propriete), `.sync-ligne doit porter ${propriete}`);
  }
  // Déplié, le texte reprend ses droits : sans quoi le repli ne montrerait
  // qu'une ligne coupée, et cliquer n'apprendrait rien.
  assert.match(CSS, /\.sync-plus-corps\{[^}]*white-space:normal/);
});

test('la carte porte le compte rendu d\'une récupération, sans redessiner le bloc', () => {
  const { contexte } = bacASable();
  const zone = { innerHTML: '' };
  contexte.home = { data: { sync: [{ id: 'decathlon', name: 'Decathlon', running: true }] } };
  contexte.zoneCarte = zone;
  contexte.$ = (id) => (id === 'sync-status-decathlon' ? zone : null);
  contexte.messageLong = MESSAGE_DECATHLON;

  vm.runInContext('majEtatSync("decathlon", messageLong, true)', contexte);

  assert.match(zone.innerHTML, /<details class="sync-plus">/, 'le compte rendu arrive replié');
  assert.equal(
    vm.runInContext('home.data.sync[0].running', contexte),
    false,
    'la carte cesse d\'annoncer « en cours… » quand la récupération est finie'
  );
});
