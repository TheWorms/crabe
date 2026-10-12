'use strict';

/**
 * Lot 69 — les trois en-têtes de précaution.
 *
 * `createApp()` pose sur TOUTES les réponses — page anonyme, API connectée,
 * route inconnue — les trois en-têtes qui ne dépendent d'aucune
 * configuration :
 *
 *   X-Content-Type-Options: nosniff   le navigateur ne devine pas un type ;
 *   X-Frame-Options: SAMEORIGIN       pas d'encadrement depuis un autre site ;
 *   Referrer-Policy: same-origin      l'adresse ne suit pas les liens sortants.
 *
 * Le cookie de session, lui, est déjà verrouillé par ses propres tests
 * (httpOnly, SameSite) — ici on ne regarde que les en-têtes de réponse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

const ATTENDUS = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'SAMEORIGIN'],
  ['referrer-policy', 'same-origin'],
];

function verifie(reponse, quoi) {
  for (const [entete, valeur] of ATTENDUS) {
    assert.equal(
      reponse.headers[entete],
      valeur,
      `${quoi} : l'en-tête ${entete} doit valoir « ${valeur} »`
    );
  }
}

test('les trois en-têtes de précaution couvrent toutes les réponses', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  // Page servie à un anonyme (l'écran de connexion).
  verifie(await client.get('/'), 'la page anonyme');

  // Route API inconnue : le 404 JSON les porte aussi.
  verifie(await client.get('/api/nulle-part'), 'le 404 JSON');

  // Réponse API derrière session.
  await helpers.createUser({ username: 'entetes', plainPassword: 'MotDePasse1' });
  await helpers.login(client, 'entetes', 'MotDePasse1');
  verifie(await client.get('/api/auth/me'), "l'API connectée");
});
