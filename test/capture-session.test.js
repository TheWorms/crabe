'use strict';

/**
 * L'outil de capture de session — les trois corrections du lot 12.
 *
 * `tools/capture-session.js` ouvre une vraie fenêtre : il ne se teste pas de
 * bout en bout sans navigateur. Ce qui SE teste, et qui est exactement ce qui
 * a été corrigé :
 *
 *   1. la détection, qui vit dans `connectors/login-detection.js` et est
 *      partagée avec le navigateur distant. Le marqueur ne bloque plus côté
 *      outil ; il bloque toujours côté navigateur distant, et c'est voulu ;
 *   2. la pause anti-cookies-tardifs, une constante partagée, et le
 *      rechargement qui l'accompagne dans l'outil ;
 *   3. la taille de la fenêtre.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const detection = require('../server/connectors/login-detection');

const OUTIL = fs.readFileSync(path.join(__dirname, '..', 'tools', 'capture-session.js'), 'utf8');

// ---------------------------------------------------------------------------
// Une page simulée, réduite à ce que `inspect()` lui demande
// ---------------------------------------------------------------------------

function page({ url, motDePasse = 0, champsCode = 0, marqueur = false }) {
  return {
    url: () => url,
    locator: (selecteur) => ({
      count: async () =>
        (selecteur === detection.SELECTEUR_MOT_DE_PASSE ? motDePasse : 0)
        + (selecteur === detection.SELECTEUR_CHAMP_CODE ? champsCode : 0),
    }),
    getByText: () => ({ count: async () => (marqueur ? 1 : 0) }),
  };
}

/** La page d'historique de commandes d'une boutique, connexion aboutie. */
const BOUTIQUE_CONNECTEE = {
  url: 'https://www.fantazia-shop.fr/historique-des-commandes',
  marqueur: false,
};

// ---------------------------------------------------------------------------
// 1. Le marqueur ne bloque plus l'outil
// ---------------------------------------------------------------------------

test('un marqueur absent ne bloque plus la capture : le critère générique suffit', async () => {
  // Le cas réel : on a passé « Mes commandes » en marqueur, la boutique
  // écrit « Historique de mes commandes ». Rien à l'écran ne correspond, et
  // pourtant la connexion est parfaitement aboutie.
  const etat = await detection.inspect(page(BOUTIQUE_CONNECTEE), {
    marker: 'Mes commandes',
    markerRequired: false,
  });

  assert.equal(etat.ok, true);
  assert.match(etat.reason, /aucun écran d'authentification visible/);
});

test('un marqueur qui tombe juste confirme tout de suite', async () => {
  const etat = await detection.inspect(page({ ...BOUTIQUE_CONNECTEE, marqueur: true }), {
    marker: 'Historique de mes commandes',
    markerRequired: false,
  });

  assert.equal(etat.ok, true);
  assert.match(etat.reason, /marqueur/);
});

test('assoupli ne veut pas dire aveugle : les trois garde-fous tiennent', async () => {
  const commun = { marker: 'Mes commandes', markerRequired: false };

  const surLaConnexion = await detection.inspect(
    page({ url: 'https://www.fantazia-shop.fr/authentification' }),
    commun
  );
  assert.equal(surLaConnexion.ok, false, 'URL d\'authentification');

  const motDePasseAffiche = await detection.inspect(
    page({ url: 'https://www.fantazia-shop.fr/mon-compte', motDePasse: 1 }),
    commun
  );
  assert.equal(motDePasseAffiche.ok, false, 'champ de mot de passe encore à l\'écran');

  const grilleDeCode = await detection.inspect(
    page({ url: 'https://www.fantazia-shop.fr/etape-2', champsCode: 6 }),
    commun
  );
  assert.equal(grilleDeCode.ok, false, 'grille de code de validation');
});

test('le navigateur distant, lui, continue d\'EXIGER son marqueur', async () => {
  // Un connecteur livré déclare le sien, et c'est le seul contrôle fiable sur
  // un portail à validation en deux temps : Free Mobile, impots.gouv.fr.
  // Assouplir des deux côtés aurait fait enregistrer des sessions à moitié
  // authentifiées, qui n'échouent que des jours plus tard.
  const etat = await detection.inspect(page(BOUTIQUE_CONNECTEE), { marker: 'Mes factures' });

  assert.equal(etat.ok, false);
  assert.match(etat.reason, /en attente du marqueur/);

  const parDefaut = await detection.inspect(page(BOUTIQUE_CONNECTEE), {
    marker: 'Mes factures',
    markerRequired: undefined,
  });
  assert.equal(parDefaut.ok, false, 'exiger le marqueur est le DÉFAUT');
});

test('la confirmation en deux lectures reste en place, marqueur ou pas', async () => {
  const pauses = [];
  let lectures = 0;

  // Deuxième lecture : une redirection a ramené un formulaire de connexion.
  const changeante = {
    url: () => (lectures++ ? 'https://boutique.fr/connexion' : 'https://boutique.fr/commandes'),
    locator: () => ({ count: async () => 0 }),
    getByText: () => ({ count: async () => 0 }),
  };

  const etat = await detection.confirm(changeante, {
    marker: 'Mes commandes',
    markerRequired: false,
    pause: async (ms) => pauses.push(ms),
  });

  assert.equal(etat.ok, false, 'un faux positif de redirection ne passe pas');
  assert.match(etat.reason, /confirmation non tenue/);
  assert.deepEqual(pauses, [detection.DELAI_CONFIRMATION_MS]);
  assert.equal(detection.DELAI_CONFIRMATION_MS, 1200, '1,2 s entre les deux lectures');
});

test('l\'outil demande bien la détection assouplie', () => {
  assert.match(OUTIL, /markerRequired:\s*false/);
});

// ---------------------------------------------------------------------------
// 2. La pause anti-cookies-tardifs
// ---------------------------------------------------------------------------

test('la pause avant la photo est de 2,5 secondes, et suivie d\'un rechargement', () => {
  assert.equal(detection.DELAI_COOKIES_TARDIFS_MS, 2500);

  // PrestaShop pose des cookies complémentaires juste après la redirection de
  // fin de connexion : 12 enregistrés au lieu de 15, puis 403 au
  // téléchargement — un échec entièrement silencieux.
  assert.match(OUTIL, /DELAI_COOKIES_TARDIFS_MS/);
  assert.match(OUTIL, /page\.reload\(/);

  // Le rechargement doit précéder la photo, sinon il ne sert à rien.
  assert.ok(
    OUTIL.indexOf('page.reload(') < OUTIL.indexOf('context.storageState()'),
    'le rechargement doit venir AVANT storageState()'
  );

  // Un rechargement refusé ne doit pas faire perdre la session capturée.
  assert.match(OUTIL, /page\.reload\([\s\S]{0,80}\)\s*\.catch\(/);
});

test('le navigateur distant applique la même pause', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'remote-browser.js'),
    'utf8'
  );
  assert.match(source, /sleep\(detection\.DELAI_COOKIES_TARDIFS_MS\)/);
});

// ---------------------------------------------------------------------------
// 3. La fenêtre large
// ---------------------------------------------------------------------------

test('la fenêtre fait 1500×950 : le lien « connectez-vous » reste dans le champ', () => {
  assert.match(OUTIL, /const FENETRE = \{ width: 1500, height: 950 \}/);
  assert.match(OUTIL, /--window-size=\$\{FENETRE\.width\},\$\{FENETRE\.height\}/);
  assert.doesNotMatch(OUTIL, /1000,760/, 'l\'ancienne taille ne doit plus traîner');
});
