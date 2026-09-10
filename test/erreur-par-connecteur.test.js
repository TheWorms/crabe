'use strict';

/**
 * §2.2 du lot 14 — une erreur appartient à UN couple (utilisateur, connecteur).
 *
 * ─── Le défaut ───────────────────────────────────────────────────────────────
 *
 * En testant L'Atelier du Portable puis Aagaard, l'interface affichait :
 *
 *     « crabe ne réessaiera pas tout seul sur Propolia »
 *
 * Les journaux, eux, nommaient correctement chaque service. Le défaut avait
 * deux moitiés, et il fallait les deux :
 *
 *   1. **le message NOMMAIT un connecteur.** Une fois écrit dans `last_error`,
 *      il devenait faux partout où il s'affichait ensuite. Corrigé par
 *      `connectors/messages-echec.js`, dont aucun message ne nomme de service ;
 *   2. **le message BRUT franchissait la frontière.** L'interface le recevait
 *      et pouvait le retomber en secours. Corrigé ici : ce que le client reçoit
 *      est `health.detail`, écrit par le serveur à partir du connecteur affiché.
 *
 * La preuve exigée : provoquer une erreur sur un connecteur A, ouvrir la fiche
 * d'un connecteur B, vérifier que B n'affiche rien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');

/** Le connecteur A, en échec, et le connecteur B, parfaitement sain. */
const A = 'propolia';
const B = 'aagaard';

/** Le message tel qu'il était stocké en production le 11/08/2026. */
const MESSAGE_ANCIEN =
  'Adresse électronique ou mot de passe incorrect. Corrigez-les sur la fiche du service, '
  + 'puis relancez. crabe ne réessaiera pas tout seul sur Propolia.';

let user;
let client;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'camille', plainPassword: 'MotDePasse1' });
  client = await helpers.startServer();
  await helpers.login(client, 'camille', 'MotDePasse1');

  // Les deux connecteurs sont installés et configurés pour ce compte.
  for (const id of [A, B]) {
    await client.post(`/api/connectors/${id}/install`);
    await client.put(`/api/connectors/${id}/config`, {
      config: { email: 'camille@exemple.fr', motDePasse: 'secret' },
    });
  }

  // A tombe en erreur, avec le message d'avant le lot 14 — celui qui nommait
  // un service. C'est le pire cas : s'il ne fuit pas, rien ne fuit.
  helpers.db
    .get()
    .prepare(
      `UPDATE connector_installs SET status = 'error', last_error = ?
        WHERE user_id = ? AND connector_id = ?`
    )
    .run(MESSAGE_ANCIEN, user.id, A);
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// La preuve demandée
// ---------------------------------------------------------------------------

test('la fiche du connecteur B ne montre rien de l\'erreur du connecteur A', async () => {
  const fiche = await client.get(`/api/connectors/${B}`);

  assert.equal(fiche.status, 200);
  assert.equal(
    JSON.stringify(fiche.body).includes('Propolia'),
    false,
    `la fiche d'${B} ne doit nommer aucun autre service :\n${JSON.stringify(fiche.body)}`
  );
  assert.equal(
    JSON.stringify(fiche.body).includes('ne réessaiera pas tout seul'),
    false,
    'le message brut d\'un autre connecteur ne doit pas apparaître'
  );

  // Et B, lui, se porte bien : ce test ne passerait pas en cassant tout.
  assert.notEqual(fiche.body.connector.health.code, 'error');
});

test('le catalogue ne livre AUCUN message brut, pour aucun connecteur', async () => {
  const liste = await client.get('/api/connectors');
  assert.equal(liste.status, 200);

  // Le message brut ne franchit plus la frontière du serveur — même pour le
  // connecteur auquel il appartient. Ce que l'interface affiche, c'est la
  // phrase de `health`, écrite pour un humain et rattachée à CE connecteur.
  assert.equal(
    JSON.stringify(liste.body).includes('ne réessaiera pas tout seul'),
    false,
    'aucun message brut ne doit sortir du serveur'
  );
  for (const connecteur of liste.body.connectors) {
    assert.equal(
      'lastError' in connecteur,
      false,
      `${connecteur.id} ne doit plus porter de message brut`
    );
  }
});

test('l\'erreur de A reste attachée à A, et sa phrase nomme A', async () => {
  const fiche = await client.get(`/api/connectors/${A}`);

  assert.equal(fiche.body.connector.health.code, 'error');
  // La phrase est reconstruite par le serveur À PARTIR du connecteur affiché :
  // elle ne peut donc pas se tromper de nom.
  assert.match(fiche.body.connector.health.detail, /Propolia/);
  // …et elle ne reprend rien du message stocké.
  assert.doesNotMatch(fiche.body.connector.health.detail, /ne réessaiera pas tout seul/);
});

test('l\'erreur reste bornée au compte qui l\'a subie', async () => {
  const autre = await helpers.createUser({ username: 'autre', plainPassword: 'MotDePasse1' });
  const client2 = await helpers.startServer();
  try {
    await helpers.login(client2, 'autre', 'MotDePasse1');
    await client2.post(`/api/connectors/${A}/install`);

    const fiche = await client2.get(`/api/connectors/${A}`);
    assert.notEqual(
      fiche.body.connector.health.code,
      'error',
      'un compte neuf n\'hérite pas de l\'échec d\'un autre'
    );
    assert.ok(autre.id !== user.id);
  } finally {
    client2.close();
  }
});

// ---------------------------------------------------------------------------
// Le message est vidé quand une nouvelle tentative démarre
// ---------------------------------------------------------------------------

test('une nouvelle tentative vide l\'erreur précédente dès son démarrage', async () => {
  const lire = () =>
    registry.getInstall(user.id, A)?.last_error;

  assert.ok(lire(), 'l\'erreur de départ doit bien être là');

  // La récupération va échouer — le scraping est coupé dans les tests — mais
  // ce qui compte est qu'elle ait commencé par EFFACER l'erreur d'avant. Sans
  // ça, quelqu'un qui vient de cliquer « Réessayer » lit pendant toute la
  // durée de l'exécution le message qu'il essaie de faire disparaître.
  const scheduler = require('../server/scheduler');
  let pendant = null;
  const vrai = registry.fetchInvoicesDetailed;
  registry.fetchInvoicesDetailed = async () => {
    pendant = lire();
    throw new Error('coupé volontairement');
  };
  try {
    await scheduler.runForUser(user.id, A, 'manual');
  } finally {
    registry.fetchInvoicesDetailed = vrai;
  }

  assert.equal(pendant, null, 'l\'erreur d\'avant doit être vidée AVANT l\'exécution');
});
