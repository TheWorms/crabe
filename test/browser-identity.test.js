'use strict';

/**
 * L'identité présentée aux sites — et le contrôle de ce qui revient.
 *
 * Ce que ces tests protègent tient en deux phrases :
 *
 *   1. **aucun contexte de navigateur ne doit annoncer « HeadlessChrome »**.
 *      Vérifié le 11/08/2026 sur Fantazia : même requête, même session, `403`
 *      avec l'agent par défaut de Playwright et `200` avec un agent réaliste.
 *      Les quatre connecteurs en production tournent tous en mode invisible ;
 *      le jour où l'un de leurs portails ajoute ce filtre, il tombe sans qu'on
 *      comprenne pourquoi ;
 *   2. **un PDF se reconnaît à son contenu, jamais à son en-tête**.
 *      Apiculture.net sert ses factures en `application/octet-stream`, et un
 *      portail dont la session a expiré sert du HTML en `application/pdf`.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const identity = require('../server/connectors/browser-identity');

// ---------------------------------------------------------------------------
// L'agent utilisateur
// ---------------------------------------------------------------------------

test('l\'agent utilisateur ne contient jamais « Headless »', () => {
  const agent = identity.agentUtilisateur();
  assert.doesNotMatch(agent, /headless/i);
  assert.match(agent, /^Mozilla\/5\.0 \(X11; Linux x86_64\)/);
  assert.match(agent, /AppleWebKit\/537\.36 \(KHTML, like Gecko\)/);
  assert.match(agent, /Chrome\/\d+\.\d+\.\d+\.\d+ Safari\/537\.36$/);
});

test('la version suit le Chromium embarqué, elle n\'est pas figée en dur', () => {
  const lue = identity.versionChromiumEmbarque();

  // Playwright est une dépendance optionnelle : sur une installation qui ne
  // l'a pas, il n'y a rien à lire, et le repli fait le travail.
  if (lue === null) {
    assert.match(identity.agentUtilisateur(), new RegExp(`Chrome/${identity.VERSION_DE_REPLI} `));
    return;
  }

  // Ce que Playwright dit lui-même, lu à la source plutôt que recopié : un
  // agent qui annonce une version que le moteur ne porte pas est un mensonge
  // vérifiable — les en-têtes Sec-CH-UA de Chromium, eux, disent la vraie.
  const racine = path.dirname(require.resolve('playwright-core/package.json'));
  const registre = JSON.parse(fs.readFileSync(path.join(racine, 'browsers.json'), 'utf8'));
  const attendue = registre.browsers.find((b) => b.name === 'chromium').browserVersion;

  assert.equal(lue, `${attendue.split('.')[0]}.0.0.0`);
  assert.match(identity.agentUtilisateur(), new RegExp(`Chrome/${lue.replace(/\./g, '\\.')} `));
});

test('« 151.0.7922.34 » devient « 151.0.0.0 », comme le fait Chrome depuis la 101', () => {
  assert.equal(identity.majeureVersOnzeZeros('151.0.7922.34'), '151.0.0.0');
  assert.equal(identity.majeureVersOnzeZeros('131.0.6778.264'), '131.0.0.0');
  assert.equal(identity.majeureVersOnzeZeros('sans numéro'), null);
  assert.equal(identity.majeureVersOnzeZeros(undefined), null);
});

test('optionsContexte pose l\'agent et la langue, et laisse le dernier mot à l\'appelant', () => {
  const nu = identity.optionsContexte();
  assert.equal(nu.userAgent, identity.agentUtilisateur());
  assert.equal(nu.locale, 'fr-FR');

  const avecSession = identity.optionsContexte({ storageState: { cookies: [] }, viewport: null });
  assert.equal(avecSession.userAgent, identity.agentUtilisateur());
  assert.deepEqual(avecSession.storageState, { cookies: [] });
  assert.equal(avecSession.viewport, null);

  // Un connecteur qui aurait vraiment besoin d'un autre agent doit pouvoir
  // l'imposer : la fabrique donne un défaut, elle ne confisque rien.
  assert.equal(identity.optionsContexte({ userAgent: 'À moi' }).userAgent, 'À moi');
});

// ---------------------------------------------------------------------------
// TOUS les contextes, connecteurs existants compris
// ---------------------------------------------------------------------------

/**
 * Le vrai garde-fou de ce lot.
 *
 * Un connecteur écrit demain qui appellerait `browser.newContext({ … })` en
 * direct repartirait silencieusement avec « HeadlessChrome ». On lit donc le
 * code source : tout appel à `newContext` passe par `identity.optionsContexte`.
 */
const FICHIERS_A_CONTEXTE = [
  'server/connectors/scraping.js',
  'server/connectors/available/free/connector.js',
  'server/connectors/available/free-mobile/connector.js',
  'server/connectors/available/amazon/connector.js',
  'server/connectors/available/impots/connector.js',
  // Lot 12 : l'implémentation partagée des sept boutiques, et le connecteur
  // sur mesure de L'Atelier du Portable.
  'server/connectors/available/prestashop/connector.js',
  'server/connectors/available/atelier-du-portable/connector.js',
  'server/remote-browser.js',
  'tools/capture-session.js',
];

test('tout contexte de navigateur passe par l\'identité partagée', () => {
  const racine = path.join(__dirname, '..');
  let vus = 0;

  for (const relatif of FICHIERS_A_CONTEXTE) {
    const source = fs.readFileSync(path.join(racine, relatif), 'utf8');
    for (const appel of source.match(/newContext\([\s\S]{0,200}/g) || []) {
      vus++;
      assert.match(
        appel,
        /identity\.optionsContexte|browserIdentity\.optionsContexte/,
        `${relatif} : un newContext() n'utilise pas l'identité partagée — `
          + 'il annoncerait « HeadlessChrome » en mode invisible'
      );
    }
  }

  assert.ok(vus >= FICHIERS_A_CONTEXTE.length, `${vus} contexte(s) trouvés, c'est trop peu`);
});

test('plus aucun agent utilisateur écrit à la main dans un connecteur', () => {
  const racine = path.join(__dirname, '..');
  for (const relatif of FICHIERS_A_CONTEXTE) {
    const source = fs.readFileSync(path.join(racine, relatif), 'utf8');
    assert.doesNotMatch(
      source,
      /userAgent\s*:\s*['"`]/,
      `${relatif} : agent utilisateur en dur — il vieillira sans que personne ne le voie`
    );
  }
});

// ---------------------------------------------------------------------------
// Le contenu, pas l'en-tête
// ---------------------------------------------------------------------------

test('un PDF se reconnaît à ses cinq premiers octets', () => {
  assert.equal(identity.estPdf(Buffer.from('%PDF-1.4\n…reste…', 'latin1')), true);
  assert.equal(identity.estPdf(Buffer.from('%PDF-1.7', 'latin1')), true);
});

// ---------------------------------------------------------------------------
// Le lancement headless — le drapeau qui franchit HeRay (lot 34)
// ---------------------------------------------------------------------------

test('optionsLancement porte le drapeau anti-automatisation', () => {
  // Mesuré sur le CT le 14/08/2026 : sans ce drapeau, un navigateur headless
  // reste bloqué sur la preuve de travail HeRay (/_ray/pow) au-delà de 60 s ;
  // avec, il la franchit en 1 s. C'est la cause de l'« expiration en quelques
  // heures » des lots 32-33 — le connecteur rejouait la session SANS lui.
  const options = identity.optionsLancement();
  assert.equal(options.headless, true);
  assert.ok(
    options.args.includes('--disable-blink-features=AutomationControlled'),
    'sans ce drapeau, navigator.webdriver trahit le pilotage et HeRay re-challenge'
  );
  // Les drapeaux du conteneur : /dev/shm minuscule, bac à sable interdit au LXC.
  assert.ok(options.args.includes('--disable-dev-shm-usage'));
  assert.ok(options.args.includes('--no-sandbox'));
});

test('optionsLancement laisse le connecteur ajouter ses propres drapeaux, sans perdre les siens', () => {
  const options = identity.optionsLancement({ args: ['--mute-audio'] });
  assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'),
    'le drapeau du socle survit à un ajout du connecteur');
  assert.ok(options.args.includes('--mute-audio'));
});

test('le connecteur Hetzner lance son navigateur par optionsLancement — pas un launch nu', () => {
  // La garde qui empêche le défaut de revenir : Hetzner est le connecteur qui
  // affronte HeRay, et un `chromium.launch({ headless: true })` nu le
  // rebloquerait dès la prochaine expiration de levée.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'available', 'hetzner', 'connector.js'),
    'utf8'
  );
  assert.match(source, /chromium\.launch\(\s*identity\.optionsLancement\(/,
    'le connecteur Hetzner doit lancer par identity.optionsLancement()');
  assert.doesNotMatch(source, /chromium\.launch\(\s*\{\s*headless:\s*true\s*\}\s*\)/,
    'plus aucun launch headless nu, qui n\'aurait pas le drapeau HeRay');
});

test('un PDF servi en application/octet-stream reste un PDF (Apiculture.net)', () => {
  // La boutique annonce « application/octet-stream » sur une facture
  // parfaitement valide. Refuser sur le type déclaré perdrait le document.
  const reponse = {
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('%PDF-1.4\nfacture', 'latin1'),
  };
  assert.equal(identity.estPdf(reponse.body), true);
});

test('du HTML servi en application/pdf n\'est pas un PDF (session tombée)', () => {
  // Le cas inverse, et le plus dangereux : le portail a laissé la session
  // expirer et renvoie sa page de connexion avec un en-tête impeccable.
  const reponse = {
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.from('<!DOCTYPE html><html><body>Connexion</body></html>', 'latin1'),
  };
  assert.equal(identity.estPdf(reponse.body), false);
});

test('rien, du vide ou trop court ne passe pas pour un PDF', () => {
  assert.equal(identity.estPdf(null), false);
  assert.equal(identity.estPdf(undefined), false);
  assert.equal(identity.estPdf(Buffer.alloc(0)), false);
  assert.equal(identity.estPdf(Buffer.from('%PD', 'latin1')), false);
  assert.equal(identity.estPdf('%PDF-1.4'), false, 'une chaîne n\'est pas un tampon');
});
