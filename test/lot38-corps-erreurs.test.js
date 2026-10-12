'use strict';

/**
 * Lot 38, phase D — le corps des erreurs, ENTIER au journal.
 *
 * Le 18/08/2026, le 400 de PayPal a été diagnostiqué deux fois à l'aveugle :
 * le champ `issue` — qui nommait la règle violée — vivait au-delà de ce que
 * l'écran garde (200 caractères) ET au-delà de ce que le journal acceptait
 * (2000 caractères, le plafond d'applog). Règle générale désormais :
 *
 *   - au journal technique (`applog`) : le corps COMPLET, toujours, secrets
 *     masqués s'il en contient ;
 *   - à l'écran : le message court, en français.
 *
 * Ces tests tombent si l'un ou l'autre est retronqué.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const applog = require('../server/applog');
const paypal = require('../server/connectors/available/paypal/connector');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

test('applog ne tronque JAMAIS un message — même très long', () => {
  const marqueur = 'FIN-DU-CORPS-INTACTE';
  const corps = `${'x'.repeat(10_000)} ${marqueur}`;
  applog.error('lot38-test', corps);

  const [entree] = applog.list({ q: marqueur, limit: 1 });
  assert.ok(entree, 'l\'entrée doit se retrouver par son marqueur FINAL');
  assert.equal(entree.message.length, corps.length, 'pas un caractère de moins');
  assert.ok(entree.message.endsWith(marqueur));
});

test('un refus PayPal à corps long : tout au journal, phrase courte à l\'écran', async () => {
  // Le corps réel du 18/08 : un 400 dont le champ `issue` vit au-delà des 200
  // caractères de l'écran. Ici, il vit aussi au-delà des 2000 de l'ancien
  // plafond du journal.
  const corps = JSON.stringify({
    name: 'INVALID_REQUEST',
    message: 'Request is not well-formed, syntactically incorrect, or violates schema.',
    bourrage: 'z'.repeat(2_500),
    details: [{ field: 'start_date', issue: 'START_DATE_TROP_ANCIENNE_MARQUEUR' }],
  });

  const vraiFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => corps,
    json: async () => JSON.parse(corps),
  });

  try {
    await assert.rejects(
      () =>
        paypal.fetchInvoices(
          { clientId: 'A'.repeat(80), clientSecret: 'B'.repeat(64) },
          {}
        ),
      (err) => {
        // L'écran : une phrase courte, jamais le corps entier.
        assert.ok(err.message.length < 500, `message d'écran trop long : ${err.message.length}`);
        assert.equal(err.message.includes('START_DATE_TROP_ANCIENNE_MARQUEUR'), false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = vraiFetch;
  }

  // Le journal : le corps COMPLET, champ `issue` compris.
  const [entree] = applog.list({ q: 'START_DATE_TROP_ANCIENNE_MARQUEUR', limit: 1 });
  assert.ok(entree, 'le corps complet doit être au journal technique');
  assert.ok(entree.message.includes('"issue"'), 'le champ qui nomme la règle violée est lisible');
  assert.ok(
    entree.message.includes('z'.repeat(2_500)),
    'au-delà de l\'ancien plafond de 2000 caractères : rien n\'est coupé'
  );
});

test('un secret qui traînerait dans un corps est masqué avant le journal', async () => {
  const corps = JSON.stringify({ error: 'x', access_token: 'SECRET-A-NE-PAS-JOURNALISER' });
  const vraiFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => corps, json: async () => ({}) });
  try {
    await assert.rejects(() =>
      paypal.fetchInvoices({ clientId: 'A'.repeat(80), clientSecret: 'B'.repeat(64) }, {})
    );
  } finally {
    globalThis.fetch = vraiFetch;
  }
  assert.equal(applog.list({ q: 'SECRET-A-NE-PAS-JOURNALISER', limit: 1 }).length, 0);
  assert.ok(applog.list({ q: '<masqué>', limit: 5 }).length >= 1);
});
