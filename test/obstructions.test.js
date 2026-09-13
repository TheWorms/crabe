'use strict';

/**
 * Le module partagé de fermeture des bandeaux de cookies.
 *
 * Ce fichier couvre ce qui se teste **sans navigateur** : la reconnaissance des
 * libellés, celle d'un clic intercepté, la description d'un obstacle, et le
 * parcours des cadres. Le comportement dans une vraie page — clic dans une
 * iframe, détection du recouvrement, seconde tentative — est vérifié contre un
 * vrai Chromium dans test/boutique-parcours.test.js.
 *
 * ─── Ce qui doit tenir, et pourquoi ──────────────────────────────────────────
 *
 * Le lot 12 accusait le mot de passe de l'utilisateur quand un bandeau
 * recouvrait le bouton de connexion. Le tri des libellés est donc le point
 * sensible : cliquer « Refuser » ou « Personnaliser » remplacerait un obstacle
 * par un autre, en silence, et on serait exactement au même point.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const cookieBanner = require('../server/connectors/obstructions');

// ---------------------------------------------------------------------------
// Les libellés
// ---------------------------------------------------------------------------

test('un libellé d\'acceptation est reconnu sans casse, sans accents, sans apostrophe', () => {
  for (const libelle of [
    'Accepter',
    'ACCEPTER',
    'accepter',
    'Tout accepter',
    'TOUT ACCEPTER',
    'J\'accepte',
    'J’accepte',           // apostrophe typographique — les sites mélangent
    'J\'ACCEPTE',
    'Accepter tous les cookies',
    'Autoriser tous les cookies',
    'Accepter et continuer',
    'Tout accepter et fermer',  // le libellé n'est pas toujours exact
    '  Accepter  ✓  ',
    'OK',
    'Continuer',
  ]) {
    assert.equal(cookieBanner.libelleAccepte(libelle), true, `« ${libelle} » doit être accepté`);
  }
});

/**
 * Le tri par l'inverse : ce qu'il ne faut SURTOUT pas cliquer.
 *
 * Une simple inclusion (« le texte contient “accepter” ») ferait passer « Ne
 * pas accepter » et « Refuser puis accepter les essentiels ». D'où la
 * comparaison par PRÉFIXE.
 */
test('un libellé qui n\'accepte pas est écarté, même s\'il contient le mot', () => {
  for (const libelle of [
    'Refuser',
    'Tout refuser',
    'Ne pas accepter',
    'Refuser puis accepter les essentiels',
    'Personnaliser',
    'Paramétrer mes choix',
    'Gérer mes préférences',
    'En savoir plus',
    '',
    '   ',
    null,
    undefined,
  ]) {
    assert.equal(
      cookieBanner.libelleAccepte(libelle),
      false,
      `« ${libelle} » ne doit PAS être cliqué`
    );
  }
});

/**
 * « Continuer » ferme des bandeaux — c'est même le libellé du refus poli
 * (« Continuer sans accepter »). Mais c'est AUSSI le bouton de soumission de la
 * moitié des connexions en deux temps, Amazon le premier.
 *
 * Le cliquer dans toute la page soumettrait le formulaire avant que crabe n'ait
 * rien rempli, sur un site où tout allait bien : on remplacerait un défaut par
 * un pire. Ces libellés-là ne sont donc essayés que DANS un conteneur qui se
 * présente comme un bandeau de consentement.
 */
test('les libellés génériques sont reconnus, mais marqués comme tels', () => {
  for (const libelle of ['OK', 'Continuer', 'Continuer sans accepter', 'ok']) {
    assert.equal(cookieBanner.libelleAccepte(libelle), true, libelle);
    assert.equal(
      cookieBanner.libelleGenerique(libelle),
      true,
      `« ${libelle} » ne doit être cliqué que dans un bandeau`
    );
  }

  // Les libellés explicites, eux, sont cliquables partout : aucun formulaire de
  // connexion ne porte un bouton « Tout accepter ».
  for (const libelle of ['Accepter', 'Tout accepter', 'J\'accepte', 'Accepter et continuer']) {
    assert.equal(cookieBanner.libelleGenerique(libelle), false, libelle);
  }

  // Le sélecteur de conteneur nomme les racines que les régies emploient.
  for (const mot of ['cookie', 'consent', 'didomi', 'rgpd', 'axeptio']) {
    assert.ok(
      cookieBanner.CONTENEURS_CONSENTEMENT.includes(`[id*="${mot}" i]`),
      `le conteneur « ${mot} » doit être reconnu`
    );
  }
});

test('la normalisation ramène un libellé à sa forme comparable', () => {
  assert.equal(cookieBanner.normaliserLibelle('  TOUT   ACCÉPTER  '), 'tout accepter');
  assert.equal(cookieBanner.normaliserLibelle('J’ACCEPTE'), 'j\'accepte');
  assert.equal(cookieBanner.normaliserLibelle(null), '');
});

// ---------------------------------------------------------------------------
// Les régies connues
// ---------------------------------------------------------------------------

test('les sept régies répandues sont déclarées, Didomi en tête', () => {
  const parRegie = new Map(cookieBanner.REGIES.map((r) => [r.regie, r.selecteur]));

  // Didomi d'abord : c'est elle qui bloquait Propolia, et la plus répandue en
  // France. L'ordre compte peu en pratique (un site n'installe qu'une régie),
  // mais un identifiant absent, lui, coûte une connexion.
  assert.equal(cookieBanner.REGIES[0].regie, 'Didomi');

  assert.deepEqual(
    [...parRegie.entries()],
    [
      ['Didomi', '#didomi-notice-agree-button'],
      ['OneTrust', '#onetrust-accept-btn-handler'],
      ['Axeptio', '#axeptio_btn_acceptAll'],
      ['Complianz', '.cmplz-accept'],
      ['Tarteaucitron', '#tarteaucitronPersonalize2'],
      ['Cookiebot', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'],
      ['Sirdata', '.sd-cmp-JI3lB'],
    ]
  );
});

// ---------------------------------------------------------------------------
// Le clic intercepté — LE diagnostic du lot 13
// ---------------------------------------------------------------------------

test('un clic intercepté est reconnu, et ne se confond pas avec autre chose', () => {
  // Le message relevé en production sur Propolia, mot pour mot.
  const propolia = new Error(
    'locator.click: Timeout 45000ms exceeded.\n'
    + '<div id="didomi-popup" class="didomi-popup-backdrop didomi-notice-popup">…</div>\n'
    + 'from <div id="didomi-host" class="didomi-host">…</div>\n'
    + 'subtree intercepts pointer events'
  );
  assert.equal(cookieBanner.estClicIntercepte(propolia), true);

  assert.equal(
    cookieBanner.estClicIntercepte(new Error('<div>…</div> intercepts pointer events')),
    true
  );
  assert.equal(cookieBanner.estClicIntercepte('element is not visible'), true);

  // Ce qui n'est PAS un recouvrement : un site injoignable, un sélecteur
  // obsolète, une session tombée. Les confondre remettrait le mauvais message.
  for (const autre of [
    new Error('net::ERR_NAME_NOT_RESOLVED'),
    new Error('net::ERR_CONNECTION_REFUSED'),
    new Error('Timeout 30000ms exceeded waiting for selector "#submit-login"'),
    new Error('Target page, context or browser has been closed'),
    null,
    undefined,
  ]) {
    assert.equal(cookieBanner.estClicIntercepte(autre), false, String(autre));
  }
});

// ---------------------------------------------------------------------------
// La description d'un obstacle — ce qui rend une régie inconnue ajoutable
// ---------------------------------------------------------------------------

test('un obstacle est décrit par son identifiant et ses classes', () => {
  assert.equal(
    cookieBanner.decrireObstacle({
      tag: 'div',
      id: 'didomi-host',
      classes: 'didomi-host',
      cible: 'didomi-host',
    }),
    '<div id="didomi-host" class="didomi-host">'
  );

  // Une racine anonyme : l'élément exact qui mangerait le clic est ajouté,
  // sans quoi la ligne de journal ne dirait rien d'exploitable.
  assert.equal(
    cookieBanner.decrireObstacle({
      tag: 'div',
      id: '',
      classes: 'cmp-voile',
      cible: 'cmp-bouton-regler',
    }),
    '<div class="cmp-voile"> (le clic atterrirait sur « cmp-bouton-regler »)'
  );

  assert.equal(cookieBanner.decrireObstacle(null), '');
});

// ---------------------------------------------------------------------------
// Les cadres
// ---------------------------------------------------------------------------

test('le cadre principal n\'est jamais interrogé deux fois', () => {
  // `page.frames()[0]` EST le cadre principal, que `fermer()` interroge déjà
  // directement : le compter deux fois doublerait le coût de chaque connexion.
  const principal = { nom: 'principal' };
  const enfant = { nom: 'enfant' };
  const page = { frames: () => [principal, enfant] };

  assert.deepEqual(cookieBanner.cadresDe(page), [enfant]);

  // Une page sans cadres, ou qui n'expose pas la méthode : jamais d'erreur.
  assert.deepEqual(cookieBanner.cadresDe({ frames: () => [principal] }), []);
  assert.deepEqual(cookieBanner.cadresDe({}), []);
  assert.deepEqual(
    cookieBanner.cadresDe({
      frames: () => {
        throw new Error('page détachée');
      },
    }),
    []
  );
});

// ---------------------------------------------------------------------------
// Le parcours, avec une page simulée
// ---------------------------------------------------------------------------

/**
 * Une page dont on décide ce qu'elle contient et ce qui recouvre la cible.
 *
 * `obstacles` est la suite des réponses de `elementFromPoint` : la première
 * pour le premier passage, la seconde pour le second. C'est ce qui permet de
 * jouer « le bandeau est arrivé après le chargement » sans horloge.
 */
function pageSimulee({ boutons = {}, obstacles = [null] } = {}) {
  const clics = [];
  let passage = 0;

  const locator = (selecteur) => ({
    count: async () => (boutons[selecteur] ? 1 : 0),
    first: () => ({
      count: async () => (boutons[selecteur] ? 1 : 0),
      isVisible: async () => true,
      click: async () => {
        clics.push(selecteur);
        // Un bouton d'acceptation retire le bandeau : sans ça, le contrôle de
        // recouvrement resterait bloqué et la simulation ne dirait rien.
        if (boutons[selecteur] === 'ferme') obstacles[passage] = null;
      },
    }),
  });

  return {
    clics,
    locator,
    getByRole: () => ({ count: async () => 0, nth: () => ({}) }),
    frames: () => [],
    waitForTimeout: async () => {
      passage += 1;
    },
    evaluate: async () => obstacles[Math.min(passage, obstacles.length - 1)] || null,
  };
}

test('un bandeau reconnu est fermé, et le journal le dit', async () => {
  const lignes = [];
  const page = pageSimulee({
    boutons: { '#didomi-notice-agree-button': 'ferme' },
    obstacles: [{ tag: 'div', id: 'didomi-host', classes: 'didomi-host' }],
  });

  const resultat = await cookieBanner.fermer(page, {
    cible: '#submit-login',
    log: (m) => lignes.push(m),
    prefixe: 'Propolia',
  });

  assert.equal(resultat.ferme, true);
  assert.equal(resultat.regie, 'Didomi');
  assert.equal(resultat.obstacle, null);
  assert.deepEqual(page.clics, ['#didomi-notice-agree-button']);
  // Le journal nomme désormais L'ÉTAPE qui a levé l'obstruction (lot 14, §5) :
  // « bandeau de cookies fermé » mentait dès que l'obstacle n'en était pas un.
  assert.match(
    lignes.join('\n'),
    /Propolia : obstruction levée à l'étape « régie connue » \(Didomi\)/
  );
});

test('le bandeau promotionnel de Bricomarché est fermé proprement par son bouton mesuré', async () => {
  // Mesuré le 23/08/2026 sur la page de connexion : le bloc
  // <div class="cms-slot contents"> (injecté par ESI) recouvre le formulaire,
  // et son bouton de fermeture n'a ni libellé, ni aria-label, ni classe
  // « close » — avant ce motif, le produit ne passait que par le
  // contournement forcé, « fonctionnel mais fragile » de son propre aveu.
  const lignes = [];
  const page = pageSimulee({
    boutons: { '.cms-slot.contents button': 'ferme' },
    obstacles: [{ tag: 'div', id: '', classes: 'cms-slot contents', cible: 'a' }],
  });

  const resultat = await cookieBanner.fermer(page, {
    cible: 'form',
    log: (m) => lignes.push(m),
    prefixe: 'Bricomarché',
  });

  assert.equal(resultat.ferme, true);
  assert.equal(resultat.etape, 'bouton de fermeture',
    'la fermeture propre — plus jamais le contournement forcé pour cet obstacle');
  assert.equal(resultat.force, false);
  assert.deepEqual(page.clics, ['.cms-slot.contents button']);
  assert.match(lignes.join('\n'), /obstruction levée à l'étape « bouton de fermeture »/);
});

test('sans bandeau ni obstacle, la fonction ne fait rien et ne dit rien', async () => {
  const lignes = [];
  const page = pageSimulee({ obstacles: [null] });

  const resultat = await cookieBanner.fermer(page, {
    cible: '#submit-login',
    log: (m) => lignes.push(m),
  });

  assert.equal(resultat.ferme, false);
  assert.equal(resultat.regie, null);
  assert.equal(resultat.obstacle, null);
  assert.equal(resultat.tentatives, 1, 'un seul passage quand rien ne gêne');
  assert.deepEqual(page.clics, [], 'aucun clic à l\'aveugle');
  assert.deepEqual(lignes, [], 'une absence de bandeau n\'est pas un événement');
});

test('un obstacle qui persiste après deux passages est journalisé, puis on s\'arrête', async () => {
  const lignes = [];
  const obstacle = { tag: 'div', id: 'cmp-maison', classes: 'cmp-voile', cible: 'cmp-regler' };
  const page = pageSimulee({ obstacles: [obstacle, obstacle] });

  const resultat = await cookieBanner.fermer(page, {
    cible: '#submit-login',
    log: (m) => lignes.push(m),
    prefixe: 'Boutique',
  });

  assert.equal(resultat.ferme, false);
  assert.deepEqual(resultat.obstacle, obstacle);
  // Deux passages, pas plus : on ne s'acharne pas sur un site.
  assert.equal(resultat.tentatives, 2);

  const trace = lignes.join('\n');
  assert.match(trace, /cmp-maison/, 'l\'identifiant doit être au journal');
  assert.match(trace, /cmp-voile/, 'les classes doivent être au journal');
  assert.match(trace, /obstructions\.js/, 'le journal doit dire où ajouter la régie');
});

test('un bandeau arrivé après le chargement est rattrapé au second passage', async () => {
  // Le cas de Propolia : rien au premier coup d'œil, le bandeau une fraction de
  // seconde plus tard. Sans seconde tentative, la fermeture préventive ne sert
  // à rien sur les régies chargées en asynchrone — c'est-à-dire la plupart.
  const lignes = [];
  const page = pageSimulee({
    boutons: { '#onetrust-accept-btn-handler': 'ferme' },
    obstacles: [
      { tag: 'div', id: 'onetrust-consent-sdk', classes: 'otFlat' },
      { tag: 'div', id: 'onetrust-consent-sdk', classes: 'otFlat' },
    ],
  });

  const resultat = await cookieBanner.fermer(page, {
    cible: '#submit-login',
    log: (m) => lignes.push(m),
  });

  assert.equal(resultat.ferme, true);
  assert.equal(resultat.regie, 'OneTrust');
  assert.equal(resultat.obstacle, null);
  assert.equal(resultat.tentatives, 2);
});

test('`fermerSiObstacle` ne coûte rien quand rien ne gêne', async () => {
  const page = pageSimulee({
    boutons: { '#didomi-notice-agree-button': 'ferme' },
    obstacles: [null],
  });

  assert.equal(await cookieBanner.fermerSiObstacle(page, { cible: '#submit-login' }), null);
  assert.deepEqual(page.clics, [], 'aucun clic tant que rien ne recouvre la cible');
});
