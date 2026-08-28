'use strict';

/**
 * Connecteur Airbnb (lot 35) — session capturée, reçus de séjours.
 *
 * Écrit sans compte réel (`initialStatus: pending`) : ces tests rejouent la
 * mécanique — relevé des liens `receipt-on-demand`, vérification `%PDF-`,
 * distinction session expirée / page à imprimer — contre une page et un
 * contexte simulés. Ce qu'ils protègent :
 *
 *   1. **Seuls les liens de reçu sont pris.** La route déclarée
 *      (`receipt-on-demand`) doit écarter la navigation de la page des
 *      paiements — sans quoi crabe téléchargerait un lien de menu.
 *   2. **Une redirection vers la connexion est une session expirée**, pas un
 *      « aucun reçu » — le faux « OK » que le lot 31 interdit.
 *   3. **Ce qui descend est vérifié : `%PDF-`.** Le point NON vérifié du
 *      connecteur — le lien de reçu rend-il un PDF ou une page à imprimer ? —
 *      ne doit jamais faire déposer du HTML dans le dossier des reçus.
 *   4. **Aucun jeton de reçu ne fuit au journal** : les liens portent
 *      `bill_token`/`tender_token`.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const airbnb = require('../server/connectors/available/airbnb/connector');
const sessionState = require('../server/connectors/session-state');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4 reçu factice');
const PAS_UN_PDF = Buffer.from('<!doctype html><html>reçu à imprimer</html>');

/** Une session valide : un cookie airbnb non expiré. */
function sessionValide() {
  return JSON.stringify({
    cookies: [{ name: '_airbnb_session', value: 'x', domain: '.airbnb.fr', expires: -1 }],
  });
}

/**
 * Les liens qu'une page de paiements rend : deux vrais reçus
 * (`receipt-on-demand`, avec leurs jetons) et deux pièges de navigation qui
 * portent le mot « reçu » ou « receipt » sans en être.
 */
const LIENS = [
  {
    href: 'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-AAA&tender_token=TEND-AAA&product_id=RESERVATION2024HMWX',
    texte: 'Reçu',
    ligne: '12 mars 2024 · 342,00 € · Séjour à Lyon',
  },
  {
    href: 'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-BBB&tender_token=TEND-BBB&product_id=RESERVATION2019QKZP',
    texte: 'Reçu',
    ligne: '4 août 2019 · 128,50 € · Séjour à Nice',
  },
  // Pièges : le centre d'aide « Comment obtenir un reçu » et un lien de menu.
  { href: 'https://www.airbnb.fr/help/article/2503', texte: 'Comment obtenir un reçu', ligne: 'Aide' },
  { href: 'https://www.airbnb.fr/account-settings/payments/your-payments', texte: 'Paiements', ligne: 'Menu' },
  // Piège DÉCISIF pour la route : une facture d'abonnement hôte, en `.pdf`,
  // que la voie GÉNÉRIQUE ramasserait (extension + mot « facture »), mais qui
  // n'est PAS un reçu de séjour. Sans la route `receipt-on-demand`, elle
  // passerait — c'est ce que ce fixture vérifie.
  { href: 'https://www.airbnb.fr/hosting/invoices/facture-abonnement-2024.pdf', texte: 'Facture', ligne: 'Abonnement hôte' },
];

/**
 * Une page Playwright simulée : on lui donne l'URL finale (après une éventuelle
 * redirection) et les liens que `page.evaluate(releverLiens)` doit rendre.
 */
function fakePage({ url = airbnb.URL_PAIEMENTS, liens = LIENS } = {}) {
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => url,
    // `relever` passe `pageDocs.releverLiens` à evaluate ; le test rend
    // directement les liens, sans exécuter la fonction dans un vrai DOM.
    evaluate: async () => liens,
  };
}

/** Un contexte simulé : sa `request.get` rend ce qu'on lui dit. */
function fakeContext(reponse) {
  return {
    request: {
      get: async () => ({
        status: () => reponse.status ?? 200,
        ok: () => (reponse.status ?? 200) < 400,
        body: async () => reponse.body ?? PDF,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. La route écarte la navigation
// ---------------------------------------------------------------------------

test('seuls les liens receipt-on-demand sont relevés — la navigation est écartée', async () => {
  const journal = [];
  const { documents } = await airbnb.relever(fakePage(), (m) => journal.push(m));

  assert.equal(documents.length, 2, 'deux reçus, pas les deux pièges de navigation');
  for (const doc of documents) {
    assert.match(doc.url, /receipt-on-demand/, 'chaque document est bien un lien de reçu');
  }
  // Le remoteId vient de l'adresse (referenceDepuisLien) : stable d'un passage
  // à l'autre, contrairement au rang dans la liste.
  assert.notEqual(documents[0].remoteId, documents[1].remoteId, 'deux reçus distincts');
});

// ---------------------------------------------------------------------------
// 2. Une redirection vers la connexion = session expirée
// ---------------------------------------------------------------------------

test('une redirection vers /login est une session expirée, jamais « aucun reçu »', async () => {
  await assert.rejects(
    () => airbnb.relever(fakePage({ url: 'https://www.airbnb.fr/login?returnTo=%2Faccount-settings' })),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /connexion à Airbnb a expiré/);
      assert.match(err.message, /pas par « Google »/);
      return true;
    }
  );
});

test('estPageAuthentification ne se laisse pas piéger par un returnTo', () => {
  assert.equal(airbnb.estPageAuthentification('https://www.airbnb.fr/login'), true);
  assert.equal(airbnb.estPageAuthentification('https://www.airbnb.fr/account-settings/payments/your-payments'), false);
  // Une page authentifiée dont la query CONTIENT le mot login n'est pas une
  // page de connexion : seul le chemin compte.
  assert.equal(
    airbnb.estPageAuthentification('https://www.airbnb.fr/account-settings/payments?returnTo=%2Flogin'),
    false
  );
});

// ---------------------------------------------------------------------------
// 3. Ce qui descend est vérifié : %PDF-
// ---------------------------------------------------------------------------

test('un reçu PDF descend ; une page à imprimer est refusée avec un message qui le dit', async () => {
  const doc = { remoteId: 'airbnb-BILL-AAA', url: 'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-AAA' };

  const buffer = await airbnb.telecharger(fakeContext({ body: PDF }), doc);
  assert.ok(buffer.subarray(0, 5).toString() === '%PDF-', 'un vrai PDF est rendu tel quel');

  await assert.rejects(
    () => airbnb.telecharger(fakeContext({ body: PAS_UN_PDF }), doc),
    (err) => {
      assert.match(err.message, /n'est pas arrivé sous forme de PDF/);
      assert.match(err.message, /page à imprimer/);
      assert.equal(err.sessionExpired, undefined, 'ce n\'est pas une session expirée, c\'est un format');
      return true;
    }
  );
});

test('un 403 sur un reçu est une session expirée, pas une panne de téléchargement', async () => {
  const doc = { remoteId: 'airbnb-BILL-AAA', url: 'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-AAA' };
  await assert.rejects(
    () => airbnb.telecharger(fakeContext({ status: 403 }), doc),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Aucun jeton de reçu ne fuit
// ---------------------------------------------------------------------------

test('les jetons de reçu (bill_token, tender_token) ne fuient ni au journal ni au message', async () => {
  const journal = [];
  const { documents } = await airbnb.relever(fakePage(), (m) => journal.push(m));

  // Le message d'échec de format cite l'identifiant TRONQUÉ, jamais l'URL.
  let messageErreur = '';
  try {
    await airbnb.telecharger(fakeContext({ body: PAS_UN_PDF }), documents[0]);
  } catch (err) {
    messageErreur = err.message;
  }

  const tout = journal.join('\n') + '\n' + messageErreur;
  assert.equal(tout.includes('BILL-AAA'), false, 'le bill_token entier ne doit jamais apparaître');
  assert.equal(tout.includes('TEND-AAA'), false, 'ni le tender_token');
});

// ---------------------------------------------------------------------------
// 5. La session est contrôlée avant tout
// ---------------------------------------------------------------------------

test('une session absente ou vide est refusée avant d\'ouvrir un navigateur', () => {
  assert.throws(() => airbnb.lireSession({}), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  assert.throws(() => airbnb.lireSession({ session: '{"cookies":[]}' }), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  // Une session valide passe le contrôle et rend l'état.
  const etat = airbnb.lireSession({ session: sessionValide() });
  assert.ok(Array.isArray(etat.cookies), 'l\'état de session est rendu tel quel');
  // Cohérence avec le validateur du socle.
  assert.equal(sessionState.validate(sessionValide()).ok, true);
});
