'use strict';

/**
 * Lot 91 (R10) — la fenêtre « Se connecter » de PrestaShop Addons sans langue
 * forcée.
 *
 * ─── Ce qui a été mesuré (05/10/2026, instance d'essai, Chromium 151) ───────
 *
 * Sur authv2.prestashop.com, le bouton « Se connecter » est grisé dès
 * l'arrivée tant que la vérification Turnstile (invisible) n'a pas rendu son
 * jeton. Avec la surcharge `locale: 'fr-FR'` que la fenêtre posait
 * (`identity.optionsContexte`), cette vérification échoue (erreur 600010, jeton
 * vide) : bouton grisé, 4 essais sur 4, et 3 sur 3 par le vrai gestionnaire de
 * fenêtre. Sans la surcharge, jeton reçu et bouton actif. Le français reste
 * acquis par l'environnement du navigateur (LANGUAGE/LANG) : en-tête
 * « fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7 », 3 sur 3.
 *
 * Ces essais verrouillent la plomberie : le manifeste déclare
 * `remoteLogin.langueNative`, la normalisation le garde, la route le
 * transmet, le gestionnaire le passe au lanceur, et le lanceur n'envoie plus
 * la surcharge tout en donnant au navigateur son français natif. Les autres
 * services ne changent pas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const identity = require('../server/connectors/browser-identity');
const remoteBrowser = require('../server/remote-browser');

test.before(async () => {
  await helpers.setup();
});

test.after(() => {
  helpers.teardown();
});

test('le manifeste d\'addons-prestashop déclare la langue native, et la normalisation la garde', () => {
  assert.equal(registry.manifest('addons-prestashop').remoteLogin.langueNative, true);
  // Les autres services ne changent pas : la surcharge reste leur règle.
  for (const id of ['darty', 'hetzner', 'impots', 'boulanger']) {
    assert.equal(registry.manifest(id).remoteLogin.langueNative, false, id);
  }
});

test('les options de lancement donnent au navigateur son français natif, et seulement sur demande', () => {
  const commun = { display: 99, screen: remoteBrowser.SCREEN, home: '/tmp/maison' };
  const natif = remoteBrowser.browserLaunchOptions({ ...commun, env: { LANG: 'C', PATH: '/usr/bin' }, langueNative: true });
  assert.equal(natif.env.LANGUAGE, 'fr_FR:fr');
  assert.equal(natif.env.LANG, 'fr_FR.UTF-8', 'le LANG=C du service est remplacé pour CE navigateur');
  assert.equal(natif.env.PATH, '/usr/bin');

  const ordinaire = remoteBrowser.browserLaunchOptions({ ...commun, env: { LANG: 'C' } });
  assert.equal(ordinaire.env.LANG, 'C', 'sans la déclaration, rien ne change');
  assert.equal(ordinaire.env.LANGUAGE, undefined);
});

test('sans langue forcée : l\'agent reste, la surcharge part — les connecteurs gardent la leur', () => {
  const sans = identity.optionsSansLangueForcee({ viewport: null });
  assert.equal('locale' in sans, false);
  assert.equal(sans.userAgent, identity.agentUtilisateur());
  assert.equal(sans.viewport, null);
  assert.equal(identity.optionsContexte({}).locale, 'fr-FR', 'optionsContexte est inchangée');
});

/**
 * Le VRAI lanceur de profil persistant, avec un Playwright remplacé qui ne
 * fait que retenir ce qu'on lui demande.
 */
async function optionsDuLanceur({ langueNative }) {
  const cle = require.resolve('playwright');
  const vrai = require.cache[cle];
  let demande = null;
  const page = { goto: async () => {}, close: async () => {} };
  require.cache[cle] = {
    id: cle, filename: cle, loaded: true,
    exports: {
      chromium: {
        launchPersistentContext: async (profil, options) => {
          demande = options;
          return { pages: () => [page], newPage: async () => page, storageState: async () => ({}), close: async () => {} };
        },
      },
    },
  };
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot91-profil-'));
  try {
    await remoteBrowser.persistentLauncher({
      display: 99, url: 'https://sonde.invalid/connexion', screen: remoteBrowser.SCREEN,
      home: profil, profil, langueNative,
    });
  } finally {
    if (vrai) require.cache[cle] = vrai;
    else delete require.cache[cle];
    fs.rmSync(profil, { recursive: true, force: true });
  }
  return demande;
}

test('le lanceur de profil persistant n\'envoie plus la surcharge quand la langue est native', async () => {
  const natif = await optionsDuLanceur({ langueNative: true });
  assert.equal('locale' in natif, false, 'la surcharge qui fait échouer Turnstile n\'est plus envoyée');
  assert.equal(natif.env.LANGUAGE, 'fr_FR:fr', 'le français vient de l\'environnement');
  assert.ok(natif.args.includes('--disable-blink-features=AutomationControlled'), 'le drapeau du lot 22 reste');

  const ordinaire = await optionsDuLanceur({ langueNative: false });
  assert.equal(ordinaire.locale, 'fr-FR', 'les autres services gardent la surcharge');
});

test('la route de la fenêtre transmet la déclaration, et le gestionnaire la passe au lanceur', async () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'remote-login.js'), 'utf8');
  assert.match(route, /langueNative: !!remoteLogin\.langueNative/);

  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'remote-browser.js'), 'utf8');
  assert.match(source, /langueNative: !!session\.langueNative/, 'openBrowser transmet au lanceur');
  assert.match(source, /if \(profil\) return persistentLauncher\(\{[^}]*langueNative \}\)/,
    'le lanceur par défaut délègue avec la déclaration');
});
