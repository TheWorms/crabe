'use strict';

/**
 * §8 du lot 14 — l'identifiant est réaffiché quand on rouvre une configuration.
 *
 * ─── Le défaut ───────────────────────────────────────────────────────────────
 *
 * En rouvrant la fiche d'un service déjà configuré, le champ « Adresse
 * électronique » revenait vide. Rien ne disait quel compte était enregistré :
 * il fallait croire qu'on devait tout ressaisir, mot de passe compris — et
 * ressaisir un mot de passe qu'on n'a pas sous la main, c'est une connexion
 * qu'on ne refait pas.
 *
 * Ce que ce fichier protège, c'est l'équilibre entre les deux moitiés :
 * l'identifiant revient, le mot de passe jamais, et un champ de mot de passe
 * laissé vide CONSERVE l'ancien au lieu de l'écraser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');

const CONNECTEUR = 'kubii';
const EMAIL = 'camille@exemple.fr';
const MOT_DE_PASSE = 'Mot2Passe!Initial';

let user;
let client;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'camille', plainPassword: 'MotDePasse1' });
  client = await helpers.startServer();
  await helpers.login(client, 'camille', 'MotDePasse1');

  await client.post(`/api/connectors/${CONNECTEUR}/install`);
  await client.put(`/api/connectors/${CONNECTEUR}/config`, {
    config: { email: EMAIL, motDePasse: MOT_DE_PASSE },
  });
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Ce qui revient
// ---------------------------------------------------------------------------

test('la fiche rouverte porte l\'adresse électronique enregistrée', async () => {
  const fiche = await client.get(`/api/connectors/${CONNECTEUR}`);

  assert.equal(fiche.status, 200);
  assert.equal(
    fiche.body.connector.configSummary.values.email,
    EMAIL,
    'sans ça, on ne sait pas quel compte est enregistré'
  );
});

test('le mot de passe ne ressort JAMAIS, sous aucune forme', async () => {
  const fiche = await client.get(`/api/connectors/${CONNECTEUR}`);
  const liste = await client.get('/api/connectors');

  for (const reponse of [fiche.body, liste.body]) {
    assert.equal(
      JSON.stringify(reponse).includes(MOT_DE_PASSE),
      false,
      'le mot de passe ne doit franchir aucune route'
    );
  }

  // Et pas davantage sous sa clé, même vide : sa seule présence apprendrait
  // au client qu'il y a quelque chose à lire là.
  const valeurs = fiche.body.connector.configSummary.values;
  assert.equal('motDePasse' in valeurs, false);
});

test('la liste positive tient : aucun type secret n\'y figure', () => {
  // Un type ajouté demain sera secret par défaut. C'est le bon sens du refus :
  // l'inverse ferait fuiter le premier type qu'on oublierait d'inscrire.
  for (const secret of ['password', 'session']) {
    assert.equal(
      registry.TYPES_RELISIBLES.includes(secret),
      false,
      `« ${secret} » ne doit jamais être relisible`
    );
  }
});

// ---------------------------------------------------------------------------
// Ce qui est conservé
// ---------------------------------------------------------------------------

test('enregistrer avec le mot de passe vide CONSERVE l\'ancien', async () => {
  const reponse = await client.put(`/api/connectors/${CONNECTEUR}/config`, {
    // Exactement ce que l'interface envoie quand on n'a touché qu'à l'adresse :
    // le champ de mot de passe est vide, parce qu'il n'a jamais été rempli.
    config: { email: 'nouvelle@adresse.fr', motDePasse: '' },
  });
  assert.equal(reponse.status, 200);

  const config = registry.readConfig(user.id, CONNECTEUR);
  assert.equal(config.motDePasse, MOT_DE_PASSE, 'un champ vide ne doit rien écraser');
  assert.equal(config.email, 'nouvelle@adresse.fr', 'la nouvelle adresse, elle, est prise');

  // Et l'interface relit bien la nouvelle adresse.
  const fiche = await client.get(`/api/connectors/${CONNECTEUR}`);
  assert.equal(fiche.body.connector.configSummary.values.email, 'nouvelle@adresse.fr');
});

test('un mot de passe réellement fourni, lui, remplace l\'ancien', async () => {
  await client.put(`/api/connectors/${CONNECTEUR}/config`, {
    config: { motDePasse: 'Mot2Passe!Nouveau' },
  });

  const config = registry.readConfig(user.id, CONNECTEUR);
  assert.equal(config.motDePasse, 'Mot2Passe!Nouveau');
  // Et l'adresse n'a pas bougé au passage : un champ absent n'efface rien.
  assert.equal(config.email, 'nouvelle@adresse.fr');
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('un autre compte ne lit pas l\'adresse enregistrée par celui-ci', async () => {
  await helpers.createUser({ username: 'voisin', plainPassword: 'MotDePasse1' });
  const autre = await helpers.startServer();
  try {
    await helpers.login(autre, 'voisin', 'MotDePasse1');
    await autre.post(`/api/connectors/${CONNECTEUR}/install`);

    const fiche = await autre.get(`/api/connectors/${CONNECTEUR}`);
    assert.equal(
      JSON.stringify(fiche.body).includes('nouvelle@adresse.fr'),
      false,
      'la configuration d\'un compte ne franchit jamais la frontière d\'un autre'
    );
  } finally {
    autre.close();
  }
});
