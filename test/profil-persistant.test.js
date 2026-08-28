'use strict';

/**
 * Le profil de navigateur persistant — et la préférence qui garde les cookies
 * de session en vie.
 *
 * Ce que ces tests protègent : Chromium purge les cookies de session à chaque
 * fermeture propre, et le backend d'addons.prestashop.com déconnecte CÔTÉ
 * SERVEUR (302 → /fr/?logout=&oauth2Callback=) toute session qui revient sans
 * ses cookies transitoires — en révoquant aussi le SSO authv2, donc en
 * exigeant une reconnexion humaine. Mesuré le 12/08/2026 en production :
 * PHPSESSID purgé entre deux ouvertures Playwright sans la préférence,
 * conservé sur deux cycles complets avec elle. `preparer()` doit donc poser
 * `session.restore_on_startup = 1` avant CHAQUE ouverture, sans jamais
 * écraser le reste des préférences — le profil transporte notamment
 * `intl.accept_languages`, dont la disparition a déjà coûté une session
 * (commit 5908b58).
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const profil = require('../server/connectors/profil-persistant');

/** @returns {object|null} le module, ou null si la dépendance manque */
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
    : 'Playwright n\'est pas installé sur cette machine : les deux cycles '
      + 'ouverture/fermeture ne sont pas joués. Installez-le avec « npm install '
      + 'playwright && npx playwright install chromium » pour couvrir cette chaîne.',
};

function lirePreferences(dossier) {
  return JSON.parse(fs.readFileSync(path.join(dossier, 'Default', 'Preferences'), 'utf8'));
}

test('preparer pose « reprendre où j\'en étais » dans un profil neuf', () => {
  const dossier = profil.preparer(42, 'addons-prestashop');
  assert.equal(lirePreferences(dossier).session.restore_on_startup, 1);
});

test('preparer complète un profil existant sans piétiner ses préférences', () => {
  const dossier = profil.chemin(43, 'addons-prestashop');
  fs.mkdirSync(path.join(dossier, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(dossier, 'Default', 'Preferences'),
    JSON.stringify({
      intl: { accept_languages: 'fr-FR,fr,en-US,en' },
      session: { startup_urls: ['https://exemple.fr/'] },
    })
  );

  profil.preparer(43, 'addons-prestashop');

  const prefs = lirePreferences(dossier);
  assert.equal(prefs.session.restore_on_startup, 1);
  // Le reste du bloc session et les autres préférences survivent.
  assert.deepEqual(prefs.session.startup_urls, ['https://exemple.fr/']);
  assert.equal(prefs.intl.accept_languages, 'fr-FR,fr,en-US,en');
});

test('un fichier Preferences illisible n\'est jamais écrasé', () => {
  const dossier = profil.chemin(44, 'addons-prestashop');
  const fichier = path.join(dossier, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, '{corrompu');

  profil.preparer(44, 'addons-prestashop');

  assert.equal(fs.readFileSync(fichier, 'utf8'), '{corrompu');
});

test('preparer purge la pile d\'onglets sans toucher au reste du profil', () => {
  const dossier = profil.chemin(46, 'sncf-connect');
  const sessions = path.join(dossier, 'Default', 'Sessions');
  fs.mkdirSync(sessions, { recursive: true });
  // Les noms réels constatés en production le 19/08/2026 : un horodatage
  // Chromium après chaque préfixe.
  fs.writeFileSync(path.join(sessions, 'Session_13391858734628941'), 'pile');
  fs.writeFileSync(path.join(sessions, 'Tabs_13391858734628947'), 'onglets');
  fs.writeFileSync(path.join(dossier, 'Default', 'Cookies'), 'cookies-simules');
  fs.writeFileSync(
    path.join(dossier, 'Default', 'Preferences'),
    JSON.stringify({ intl: { accept_languages: 'fr-FR,fr' } })
  );

  profil.preparer(46, 'sncf-connect');

  // La pile est partie, les cookies et les préférences sont restés.
  assert.deepEqual(fs.readdirSync(sessions), []);
  assert.equal(fs.readFileSync(path.join(dossier, 'Default', 'Cookies'), 'utf8'), 'cookies-simules');
  const prefs = lirePreferences(dossier);
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.intl.accept_languages, 'fr-FR,fr');
});

test(
  'la survie des cookies de session ne dépend pas des fichiers Sessions (deux cycles)',
  SANS_NAVIGATEUR,
  async () => {
    const dossier = profil.preparer(47, 'addons-prestashop');
    const { chromium } = PLAYWRIGHT;

    // `channel: 'chromium'` : le VRAI Chromium, en invisible. Mesuré le
    // 19/08/2026 sur cette machine : le shell headless par défaut de
    // Playwright — un binaire distinct — purge les cookies de session à la
    // fermeture propre même avec `restore_on_startup = 1`, alors que le
    // Chromium complet, celui que la production ouvre, les garde. C'est le
    // comportement du binaire de production que ce test mesure.
    const options = { headless: true, channel: 'chromium' };

    // Premier cycle : un cookie de session — sans date d'expiration, comme le
    // PHPSESSID du 12/08/2026 — est posé, puis fermeture propre.
    let contexte = await chromium.launchPersistentContext(dossier, options);
    await contexte.addCookies([
      { name: 'PHPSESSID', value: 'cycle-un', domain: 'exemple.fr', path: '/' },
    ]);
    await contexte.close();

    // Entre les deux : la pile d'onglets (simulée si Chromium n'en a pas
    // écrite en invisible) est purgée par preparer(), comme avant chaque
    // ouverture réelle.
    const sessions = path.join(dossier, 'Default', 'Sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'Session_13391858734628941'), 'pile');
    profil.preparer(47, 'addons-prestashop');
    assert.equal(fs.existsSync(path.join(sessions, 'Session_13391858734628941')), false);

    // Second cycle : le cookie de session est toujours là.
    contexte = await chromium.launchPersistentContext(dossier, options);
    const cookies = await contexte.cookies();
    await contexte.close();
    const survivant = cookies.find((c) => c.name === 'PHPSESSID');
    assert.ok(survivant, 'le cookie de session doit survivre à la purge de la pile d\'onglets');
    assert.equal(survivant.value, 'cycle-un');
  }
);

// ---------------------------------------------------------------------------
// La preuve de vie du verrou de fenêtre (lot 51) : navigateurVivant
// ---------------------------------------------------------------------------

const { spawn } = require('node:child_process');

/** Pose le lien `SingletonLock` de Chromium : cible `<hôte>-<pid>`. */
function poserSingletonLock(dossier, pid) {
  fs.mkdirSync(dossier, { recursive: true });
  const lien = path.join(dossier, 'SingletonLock');
  fs.rmSync(lien, { force: true });
  fs.symlinkSync(`hote-de-test-${pid}`, lien);
}

test('navigateurVivant : sans SingletonLock, aucun navigateur — fermeture propre', () => {
  const dossier = profil.chemin(60, 'bricomarche');
  fs.mkdirSync(dossier, { recursive: true });
  assert.equal(profil.navigateurVivant(dossier), false);
});

test('navigateurVivant : un vrai processus au nom de Chromium fait foi — et sa mort au kill aussi', async () => {
  // Le cas mesuré le 23/08/2026 au matin : un Chromium tué au `kill` laisse
  // le SingletonLock du profil derrière lui, avec un PID mort. Le test joue
  // la chaîne ENTIÈRE : un processus dont le nom est « chromium » (une copie
  // de sleep — c'est le nom que /proc rapporte, pas le binaire, qui compte),
  // vivant puis tué.
  const dossier = profil.chemin(61, 'bricomarche');
  fs.mkdirSync(dossier, { recursive: true });
  const fauxChromium = path.join(dossier, 'chromium');
  fs.copyFileSync('/bin/sleep', fauxChromium);
  fs.chmodSync(fauxChromium, 0o755);

  const processus = spawn(fauxChromium, ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => { setTimeout(r, 100); });
    poserSingletonLock(dossier, processus.pid);
    assert.equal(profil.navigateurVivant(dossier), true,
      'un profil dont le navigateur tourne encore n\'est pas abandonné');

    processus.kill('SIGKILL');
    await new Promise((resolve) => { processus.on('exit', resolve); });
    // Le lien, lui, est toujours là — c'est exactement le piège du kill.
    assert.equal(fs.existsSync(path.join(dossier, 'SingletonLock')), false,
      'le lien est pendouillant (sa cible n\'existe pas) : existsSync le suit et dit faux');
    assert.equal(profil.navigateurVivant(dossier), false,
      'PID mort : le verrou doit pouvoir être repris — jamais enfermer dehors');
  } finally {
    try { processus.kill('SIGKILL'); } catch { /* déjà mort */ }
  }
});

test('navigateurVivant : un PID recyclé par un AUTRE processus ne fait pas tenir le verrou', () => {
  // Le processus de test lui-même est vivant, mais son nom est « node », pas
  // un Chromium : dans le doute, la preuve dit mort — reprendre trop tôt fait
  // au pire deux navigateurs, reprendre jamais fait un logiciel cassé.
  const dossier = profil.chemin(62, 'bricomarche');
  poserSingletonLock(dossier, process.pid);
  assert.equal(profil.navigateurVivant(dossier), false);
});

test('un JSON valide mais qui n\'est pas un objet est laissé tel quel', () => {
  const dossier = profil.chemin(45, 'addons-prestashop');
  const fichier = path.join(dossier, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, '[1,2,3]');

  profil.preparer(45, 'addons-prestashop');

  assert.equal(fs.readFileSync(fichier, 'utf8'), '[1,2,3]');
});
