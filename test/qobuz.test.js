'use strict';

/**
 * Connecteur Qobuz (lot 36) — session capturée, reçus d'abonnement et d'achats.
 *
 * Écrit sans compte réel (`initialStatus: pending`) : ces tests rejouent la
 * mécanique contre une page et un contexte simulés. Ce qu'ils protègent :
 *
 *   1. **Les trois issues du profil ne se confondent jamais** : redirection
 *      vers /signin = session expirée ; page 404 rendue = ADRESSE MORTE, dite
 *      comme telle (rouvrir la connexion n'y changerait rien) ; page rendue =
 *      relevé. C'est le piège propre à Qobuz : /my-profile rend un 404
 *      applicatif à l'anonyme, personne ne sait ce qu'il rend connecté.
 *   2. **L'onglet « Mes reçus de paiement » est rejoint par son libellé**, et
 *      seuls les liens de document sont pris.
 *   3. **Ce qui descend est vérifié : `%PDF-`** — jamais de HTML déguisé.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const qobuz = require('../server/connectors/available/qobuz/connector');
const sessionState = require('../server/connectors/session-state');
const pageDocs = require('../server/connectors/documents-de-page');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4 reçu factice');
const PAS_UN_PDF = Buffer.from('<!doctype html><html>reçu à imprimer</html>');

const URL_RECUS = 'https://www.qobuz.com/my-profile/payment-receipts';

/** Une session valide : un cookie qobuz non expiré. */
function sessionValide() {
  return JSON.stringify({
    cookies: [{ name: 'qobuz_session', value: 'x', domain: '.qobuz.com', expires: -1 }],
  });
}

/** Les liens du PROFIL : l'onglet des reçus, et des pièges de navigation. */
const LIENS_PROFIL = [
  { href: URL_RECUS, texte: 'Mes reçus de paiement', ligne: 'Mon profil' },
  { href: 'https://www.qobuz.com/my-profile/subscription', texte: 'Mon abonnement', ligne: 'Menu' },
  { href: 'https://help.qobuz.com/en/articles/10198', texte: 'Puis-je obtenir une facture ?', ligne: 'Aide' },
];

/** Les liens de l'onglet des reçus : deux documents et deux pièges. */
const LIENS_RECUS = [
  {
    href: 'https://www.qobuz.com/my-profile/payment-receipts/download/QBZ-2026-0117',
    texte: 'Télécharger le reçu',
    ligne: '17 janvier 2026 · 14,99 €',
  },
  {
    href: 'https://www.qobuz.com/my-profile/payment-receipts/download/QBZ-2024-0455',
    texte: 'Télécharger le reçu',
    ligne: '3 août 2024 · 12,50 €',
  },
  { href: 'https://www.qobuz.com/my-profile/payment-methods', texte: 'Moyens de paiement', ligne: 'Menu' },
  { href: `${URL_RECUS}?page=2`, texte: 'Reçus suivants', ligne: 'Pagination' },
];

/**
 * Une page simulée à deux écrans (profil → reçus), avec un titre par page et
 * des redirections pour simuler une session tombée.
 */
function fakePage({
  urlInitiale = qobuz.URL_PROFIL,
  titres = { [qobuz.URL_PROFIL]: 'Qobuz - Mon profil', [URL_RECUS]: 'Qobuz - Mes reçus' },
  liensParPage = { [qobuz.URL_PROFIL]: LIENS_PROFIL, [URL_RECUS]: LIENS_RECUS },
  redirections = {},
} = {}) {
  let courante = urlInitiale;
  return {
    goto: async (url) => { courante = redirections[url] || url; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => courante,
    title: async () => titres[courante.split('?')[0]] ?? titres[courante] ?? 'Qobuz',
    evaluate: async (fn, arg) => {
      if (fn === pageDocs.releverLiens) {
        const sansQuery = courante.split('?')[0];
        return liensParPage[sansQuery] || liensParPage[courante] || [];
      }
      if (typeof arg === 'string') return false;
      return { titre: 'Profil Qobuz simulé', boutons: ['Mon profil', 'Abonnement'] };
    },
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
// 1. Les trois issues du profil
// ---------------------------------------------------------------------------

test('une redirection vers /signin est une session expirée, jamais « aucun reçu »', async () => {
  await assert.rejects(
    () => qobuz.relever(fakePage({
      redirections: { [qobuz.URL_PROFIL]: 'https://www.qobuz.com/signin?redirect=%2Fmy-profile' },
      titres: { 'https://www.qobuz.com/signin': 'Qobuz - Connexion' },
    })),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /connexion à Qobuz a expiré/);
      return true;
    }
  );
});

test('une page 404 rendue est une ADRESSE MORTE — jamais une session expirée', async () => {
  await assert.rejects(
    () => qobuz.relever(fakePage({
      titres: { [qobuz.URL_PROFIL]: 'Page introuvable – Erreur 404' },
      liensParPage: { [qobuz.URL_PROFIL]: [] },
    })),
    (err) => {
      assert.equal(err.sessionExpired, undefined,
        'rouvrir la connexion n\'y changerait rien : ce n\'est PAS une session expirée');
      assert.match(err.message, /n'existe plus à l'adresse/);
      assert.match(err.message, /inutile de la refaire/);
      assert.match(err.message, /signalez-le/i);
      return true;
    }
  );
});

test('estPageAuthentification reconnaît /signin, pas un redirect= piégé', () => {
  assert.equal(qobuz.estPageAuthentification('https://www.qobuz.com/signin'), true);
  assert.equal(qobuz.estPageAuthentification(qobuz.URL_PROFIL), false);
  assert.equal(
    qobuz.estPageAuthentification('https://www.qobuz.com/my-profile?redirect=%2Fsignin'),
    false
  );
});

// ---------------------------------------------------------------------------
// 2. L'onglet des reçus est rejoint, les pièges sont écartés
// ---------------------------------------------------------------------------

test('l\'onglet « Mes reçus de paiement » est suivi, et seuls les documents sont relevés', async () => {
  const journal = [];
  const page = fakePage();
  const { documents, pagesVisitees } = await qobuz.relever(page, (m) => journal.push(m));

  assert.equal(page.url(), URL_RECUS, 'l\'onglet des reçus a bien été rejoint');
  assert.deepEqual(pagesVisitees, [qobuz.URL_PROFIL, URL_RECUS]);
  assert.equal(documents.length, 2, 'deux reçus — ni les moyens de paiement, ni la pagination');
  for (const doc of documents) {
    assert.match(doc.url, /payment-receipts\/download/, 'chaque document est un lien de reçu');
  }
  assert.notEqual(documents[0].remoteId, documents[1].remoteId);
  assert.equal(documents[0].issuedOn, '2026-01-17', 'la date vient de la ligne');
  assert.equal(documents[0].amount, '14,99 €', 'le montant vient de la ligne');
});

test('sans lien ni onglet, la page est journalisée — jamais un échec muet', async () => {
  const journal = [];
  const { documents } = await qobuz.relever(fakePage({
    liensParPage: { [qobuz.URL_PROFIL]: [] },
  }), (m) => journal.push(m));

  assert.equal(documents.length, 0);
  assert.match(journal.join('\n'), /ni lien ni onglet/);
  assert.match(journal.join('\n'), /libellés vus/);
});

// ---------------------------------------------------------------------------
// 3. Ce qui descend est vérifié : %PDF-
// ---------------------------------------------------------------------------

test('un reçu PDF descend ; une page à imprimer est refusée avec un message qui le dit', async () => {
  const doc = { remoteId: 'qobuz-QBZ-2026-0117', url: 'https://www.qobuz.com/my-profile/payment-receipts/download/QBZ-2026-0117' };

  const buffer = await qobuz.telecharger(fakeContext({ body: PDF }), doc);
  assert.ok(buffer.subarray(0, 5).toString() === '%PDF-');

  await assert.rejects(
    () => qobuz.telecharger(fakeContext({ body: PAS_UN_PDF }), doc),
    (err) => {
      assert.match(err.message, /n'est pas arrivé sous forme de PDF/);
      assert.match(err.message, /page à imprimer/);
      assert.equal(err.sessionExpired, undefined);
      return true;
    }
  );
});

test('un 403 sur un reçu est une session expirée, pas une panne de téléchargement', async () => {
  const doc = { remoteId: 'qobuz-QBZ-2026-0117', url: 'https://www.qobuz.com/my-profile/payment-receipts/download/QBZ-2026-0117' };
  await assert.rejects(
    () => qobuz.telecharger(fakeContext({ status: 403 }), doc),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. La session est contrôlée avant tout
// ---------------------------------------------------------------------------

test('une session absente ou vide est refusée avant d\'ouvrir un navigateur', () => {
  assert.throws(() => qobuz.lireSession({}), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  assert.throws(() => qobuz.lireSession({ session: '{"cookies":[]}' }), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  const etat = qobuz.lireSession({ session: sessionValide() });
  assert.ok(Array.isArray(etat.cookies));
  assert.equal(sessionState.validate(sessionValide()).ok, true);
});

// ---------------------------------------------------------------------------
// 5. Le message de relevé vide distingue les deux explications
// ---------------------------------------------------------------------------

test('le message de relevé vide nomme les pages visitées et l\'angle mort des boutiques', () => {
  const message = qobuz.messageReleveVide([qobuz.URL_PROFIL, URL_RECUS]);
  assert.match(message, /aucun reçu n'a été reconnu/);
  assert.match(message, /App Store|Google Play/);
  assert.match(message, /signalez-le/i);
});
