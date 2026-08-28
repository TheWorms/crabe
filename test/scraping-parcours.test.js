'use strict';

/**
 * Le parcours de connexion du moteur générique (lot 37) — mesuré sur EDF et
 * Ameli le 18/08/2026.
 *
 * Ce que ces tests protègent :
 *
 *   1. **L'étape « Suivant »** : EDF demande l'e-mail seul, puis un clic,
 *      puis le mot de passe. Sans l'étape, le moteur cherchait le champ du
 *      mot de passe sur un écran qui ne l'a jamais porté — l'échec brut des
 *      17-18/08.
 *   2. **Les clics d'entrée** : Ameli cache son formulaire derrière un
 *      consentement maison et un « Connectez-vous ».
 *   3. **Le second facteur détecté et dit** : après des identifiants acceptés,
 *      Ameli présente `#BoutonGenerationOTP` — le message le dit, au lieu de
 *      laisser l'échec accuser la liste des documents plus loin.
 *   4. **Un obstacle mesuré prime sur la supposition générique** : quand EDF
 *      refuse l'écran du mot de passe, le message ne dit pas « vérifiez votre
 *      adresse » — elle n'y est pour rien (verdict anti-robot mesuré).
 *   5. **Plus jamais d'erreur brute** : un sélecteur qui ne mord pas produit
 *      une phrase française, et le sélecteur part au journal.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const scraping = require('../server/connectors/scraping');

/**
 * Une page Playwright simulée pour le parcours de connexion.
 *
 * `present` : les sélecteurs qui existent sur la page, avec leur compte.
 * `apparaitApres` : sélecteur → étape qui le fait apparaître (clic sur
 * `usernameNext` par exemple).
 */
function fakePage({ present = {}, apparaitApresSuivant = [] } = {}) {
  const etat = { ...present };
  const gestes = { clics: [], remplis: {}, journalEscape: 0 };
  const compte = (sel) => Object.entries(etat)
    .filter(([s]) => sel.split(',').map((x) => x.trim()).includes(s))
    .reduce((n, [, c]) => n + c, 0);

  const page = {
    gestes,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://exemple.fr/connexion',
    keyboard: { press: async () => {} },
    frames: () => [],
    locator: (sel) => ({
      first() { return this; },
      count: async () => compte(sel),
      click: async () => {
        if (!compte(sel)) throw new Error(`locator.click: Timeout 45000ms exceeded (${sel})`);
        gestes.clics.push(sel);
        for (const futur of apparaitApresSuivant) etat[futur] = 1;
      },
      textContent: async () => '',
    }),
    fill: async (sel, valeur) => {
      if (!compte(sel)) {
        throw new Error(`page.fill: Timeout 45000ms exceeded.\nCall log:\n  - waiting for locator('${sel}')`);
      }
      gestes.remplis[sel] = valeur;
    },
    click: async (sel) => {
      if (!compte(sel)) throw new Error(`page.click: Timeout 45000ms exceeded (${sel})`);
      gestes.clics.push(sel);
      for (const futur of apparaitApresSuivant) etat[futur] = 1;
    },
    waitForSelector: async (sel) => {
      if (!compte(sel)) throw new Error(`page.waitForSelector: Timeout (${sel})`);
      return {};
    },
    evaluate: async () => 'email#email',
  };
  return page;
}

const CONFIG = { username: 'personne@exemple.fr', password: 'motdepasse' };

// ---------------------------------------------------------------------------
// 1. L'étape « Suivant » (EDF)
// ---------------------------------------------------------------------------

test('avec usernameNext, le mot de passe est rempli APRÈS le clic qui le fait apparaître', async () => {
  const recette = {
    id: 'essai', providerName: 'Essai',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    selectors: {
      username: 'input#email',
      usernameNext: '#suivant',
      password: 'input#motdepasse',
      submit: '#envoyer',
    },
  };
  const page = fakePage({
    present: { 'input#email': 1, '#suivant': 1, '#envoyer': 1 },
    apparaitApresSuivant: ['input#motdepasse'],
  });
  await scraping.performLogin(page, recette, CONFIG);
  assert.ok(page.gestes.clics.includes('#suivant'), 'l\'étape « Suivant » est franchie');
  assert.equal(page.gestes.remplis['input#motdepasse'], 'motdepasse');
});

test('l\'écran du mot de passe qui ne vient pas : phrase française, sélecteur au journal', async () => {
  const recette = {
    id: 'essai', providerName: 'Essai',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    selectors: {
      username: 'input#email',
      usernameNext: '#suivant',
      password: 'input#motdepasse',
      submit: '#envoyer',
    },
  };
  const page = fakePage({ present: { 'input#email': 1, '#suivant': 1, '#envoyer': 1 } });
  const journal = [];
  await assert.rejects(
    () => scraping.performLogin(page, recette, CONFIG, (m) => journal.push(m)),
    (err) => {
      assert.doesNotMatch(err.message, /locator|Timeout|page\./, 'jamais de jargon dans le message');
      assert.match(err.message, /n'a pas présenté l'écran du mot de passe/);
      return true;
    }
  );
  assert.match(journal.join('\n'), /input#motdepasse/, 'le sélecteur, détail technique, va au journal');
});

test('un obstacle MESURÉ remplace la supposition générique (le verdict EDF)', async () => {
  const recette = {
    id: 'edf-essai', providerName: 'EDF',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    obstacleEcranSuivant:
      'EDF a refusé la connexion automatisée : son site est gardé par un dispositif anti-robot.',
    selectors: {
      username: 'input#email', usernameNext: '#suivant',
      password: 'input#motdepasse', submit: '#envoyer',
    },
  };
  const page = fakePage({ present: { 'input#email': 1, '#suivant': 1 } });
  await assert.rejects(
    () => scraping.performLogin(page, recette, CONFIG),
    (err) => {
      assert.match(err.message, /dispositif anti-robot/);
      assert.doesNotMatch(err.message, /vérifiez.*votre adresse/i, 'on n\'accuse pas le compte');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 2. Les clics d'entrée (Ameli)
// ---------------------------------------------------------------------------

test('les clics d\'entrée sont franchis dans l\'ordre, et une étape absente est sautée', async () => {
  const recette = {
    id: 'essai', providerName: 'Essai',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    selectors: {
      preambule: ['#consentement', '#deja-franchi', '#connectez-vous'],
      username: 'input#user', password: 'input#pass', submit: '#envoyer',
    },
  };
  const page = fakePage({
    present: { '#consentement': 1, '#connectez-vous': 1, 'input#user': 1, 'input#pass': 1, '#envoyer': 1 },
  });
  await scraping.performLogin(page, recette, CONFIG);
  assert.deepEqual(
    page.gestes.clics.filter((c) => c.startsWith('#c')),
    ['#consentement', '#connectez-vous'],
    'les étapes présentes sont cliquées dans l\'ordre, l\'absente est sautée sans échec'
  );
});

// ---------------------------------------------------------------------------
// 3. Le second facteur détecté et dit (Ameli)
// ---------------------------------------------------------------------------

test('le bouton de code à usage unique après l\'envoi : le message le dit, sans accuser', async () => {
  const recette = {
    id: 'ameli-essai', providerName: 'Ameli',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    obstacleOtp:
      'Ameli a bien reconnu vos identifiants, mais demande ensuite un code à usage unique '
      + 'que crabe ne peut pas recevoir à votre place.',
    selectors: {
      username: 'input#user', password: 'input#pass', submit: '#envoyer',
      otpMarker: '#BoutonGenerationOTP',
    },
  };
  const page = fakePage({
    present: { 'input#user': 1, 'input#pass': 1, '#envoyer': 1 },
    apparaitApresSuivant: ['#BoutonGenerationOTP'],
  });
  await assert.rejects(
    () => scraping.performLogin(page, recette, CONFIG),
    (err) => {
      assert.match(err.message, /code à usage unique/);
      assert.match(err.message, /reconnu vos identifiants/, 'le compte n\'est pas accusé');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Plus jamais d'erreur brute pour un champ introuvable
// ---------------------------------------------------------------------------

test('un champ d\'identifiant introuvable produit une phrase, jamais le page.fill brut', async () => {
  const recette = {
    id: 'essai', providerName: 'Essai',
    loginUrl: 'https://exemple.fr/connexion',
    usernameField: 'username', passwordField: 'password',
    selectors: { username: 'input#disparu', password: 'input#pass', submit: '#envoyer' },
  };
  const page = fakePage({ present: { 'input#pass': 1, '#envoyer': 1 } });
  const journal = [];
  await assert.rejects(
    () => scraping.performLogin(page, recette, CONFIG, (m) => journal.push(m)),
    (err) => {
      assert.doesNotMatch(err.message, /page\.fill|locator|Timeout/);
      assert.match(err.message, /champ d'identifiant attendu/);
      return true;
    }
  );
  assert.match(journal.join('\n'), /input#disparu/);
});
