'use strict';

/**
 * Lot 54 — la mesure d'espace est gardée quelques minutes, sans jamais mentir.
 *
 * Le fait mesuré au lot 53-bis : depuis que `spaceFor()` fonctionne, chaque
 * affichage de l'accueil ou de la page Stockage lançait une vraie mesure par
 * cloud. La nuit du 24 au 25/08/2026, l'un des espaces cloud a servi la première mesure
 * puis refusé d'un 401 la seconde, lancée quelques secondes après : l'écran
 * clignotait entre « mesuré » et « n'a pas répondu » au gré des rechargements.
 *
 * Les deux versants, tous deux obligatoires :
 *   - une mesure récente n'est PAS refaite (le service distant n'est plus
 *     sollicité à chaque vue) ;
 *   - le cache ne masque JAMAIS une panne durable : une mesure en échec se
 *     garde bien moins longtemps qu'une réussie, et une panne survenue après
 *     un succès finit d'être dite à l'écran.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const destinations = require('../server/destinations');
const space = require('../server/destinations/space');

test.before(async () => {
  await helpers.setup();
});

test.after(() => helpers.teardown());

/** Un cloud de test configuré par formulaire, comme l'écran Stockage le fait. */
function cloudDeTest(nom) {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: nom }).id;
  destinations.saveConfig(id, {
    enabled: true,
    valeurs: { username: 'camille@exemple.test', password: 'FausseValeur1' },
  });
  return id;
}

test('une mesure récente est réutilisée : deux affichages, une seule sonde', async (t) => {
  const id = cloudDeTest('pCloud de Camille');

  let sondes = 0;
  const original = space.remoteSpace;
  space.remoteSpace = async () => {
    sondes += 1;
    return { known: true, totalBytes: 1000, freeBytes: 400, usedBytes: 600 };
  };
  t.after(() => { space.remoteSpace = original; });

  const premiere = await destinations.spaceFor(id);
  const seconde = await destinations.spaceFor(id);

  assert.equal(sondes, 1, 'le second affichage est servi par le cache, sans sonde');
  assert.equal(premiere.known, true);
  assert.equal(seconde.freeBytes, 400, 'la valeur servie est celle de la mesure');
  assert.ok(premiere.measuredAt, 'la mesure dit de quand elle date');
  assert.equal(seconde.measuredAt, premiere.measuredAt, 'la valeur en cache garde sa date d\'origine');
});

test('une panne survenue après un succès finit d\'être dite, malgré le cache', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = cloudDeTest('pCloud qui tombera');

  let sondes = 0;
  let panne = false;
  const original = space.remoteSpace;
  space.remoteSpace = async () => {
    sondes += 1;
    if (panne) return space.unknown('Cet espace de stockage n\'a pas répondu à la mesure de l\'espace libre (401).');
    return { known: true, totalBytes: 1000, freeBytes: 400, usedBytes: 600 };
  };
  t.after(() => { space.remoteSpace = original; });

  assert.equal((await destinations.spaceFor(id)).known, true);
  assert.equal(sondes, 1);

  // Le service tombe. Quatre minutes plus tard, le cache sert encore le
  // succès — c'est le prix assumé d'une validité de cinq minutes…
  panne = true;
  t.mock.timers.tick(4 * 60_000);
  assert.equal((await destinations.spaceFor(id)).known, true, 'à 4 min, la mesure réussie est encore servie');
  assert.equal(sondes, 1);

  // …mais passé cinq minutes, la mesure repart pour de vrai et la panne
  // est DITE : jamais une bonne nouvelle périmée au-delà de sa validité.
  t.mock.timers.tick(90_000);
  const apres = await destinations.spaceFor(id);
  assert.equal(sondes, 2, 'la validité expirée, une vraie sonde repart');
  assert.equal(apres.known, false, 'la panne est dite');
  assert.match(apres.reason, /n'a pas répondu/, 'avec la phrase honnête du lot 53-bis');
});

test('une mesure en échec se garde bien moins longtemps qu\'une réussie', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = cloudDeTest('pCloud qui se relèvera');

  let sondes = 0;
  let panne = true;
  const original = space.remoteSpace;
  space.remoteSpace = async () => {
    sondes += 1;
    if (panne) return space.unknown('Cet espace de stockage n\'a pas répondu à la mesure de l\'espace libre (401).');
    return { known: true, totalBytes: 1000, freeBytes: 400, usedBytes: 600 };
  };
  t.after(() => { space.remoteSpace = original; });

  assert.equal((await destinations.spaceFor(id)).known, false);
  assert.equal(sondes, 1);

  // Trente secondes après le refus : pas de nouvelle sonde — c'est le
  // martèlement de sondes rapprochées que le service a refusé d'un 401.
  t.mock.timers.tick(30_000);
  assert.equal((await destinations.spaceFor(id)).known, false);
  assert.equal(sondes, 1, 'un refus tout frais n\'est pas re-sondé dans la minute');

  // Passé la minute, la mesure repart : un service revenu re-réussit vite,
  // bien avant les cinq minutes d'une mesure réussie.
  panne = false;
  t.mock.timers.tick(45_000);
  const retabli = await destinations.spaceFor(id);
  assert.equal(sondes, 2, 'passé la minute, une vraie sonde repart');
  assert.equal(retabli.known, true, 'le rétablissement se voit sans attendre cinq minutes');
});

test('enregistrer la configuration rend une mesure fraîche possible, sans attendre', async (t) => {
  const id = cloudDeTest('pCloud reconfiguré');

  let sondes = 0;
  const original = space.remoteSpace;
  space.remoteSpace = async () => {
    sondes += 1;
    return { known: true, totalBytes: 1000, freeBytes: 400, usedBytes: 600 };
  };
  t.after(() => { space.remoteSpace = original; });

  await destinations.spaceFor(id);
  await destinations.spaceFor(id);
  assert.equal(sondes, 1, 'prémisse : la seconde vue est servie par le cache');

  // Le geste explicite : la configuration vient d'être enregistrée, la mesure
  // en cache portait sur l'ancienne.
  destinations.saveConfig(id, { enabled: true, valeurs: { username: 'camille@exemple.test' } });
  await destinations.spaceFor(id);
  assert.equal(sondes, 2, 'après l\'enregistrement, la vue suivante mesure à neuf');
});

test('deux vues simultanées partagent la même sonde au lieu d\'en lancer deux', async (t) => {
  const id = cloudDeTest('pCloud sondé une fois');

  let sondes = 0;
  const original = space.remoteSpace;
  space.remoteSpace = async () => {
    sondes += 1;
    // Une vraie sonde prend du temps : laisser la seconde vue arriver pendant
    // que la première mesure est en cours.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { known: true, totalBytes: 1000, freeBytes: 400, usedBytes: 600 };
  };
  t.after(() => { space.remoteSpace = original; });

  const [a, b] = await Promise.all([destinations.spaceFor(id), destinations.spaceFor(id)]);
  assert.equal(sondes, 1, 'les deux vues attendent la même sonde — la paire rapprochée est ce que le service refusait');
  assert.equal(a.known, true);
  assert.equal(b.measuredAt, a.measuredAt);
});
