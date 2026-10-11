'use strict';

/**
 * Connecteur Airbnb — le parcours des séjours (lot 71).
 *
 * Le lot 35 visait la page des paiements ; le lot 71 a mesuré qu'elle ne liste
 * que les paiements récents, et le parcours vise désormais la page Voyages :
 * `/trips` → détail du séjour → page de réservation → lien « Voir le reçu ».
 * Toutes les valeurs de ces fixtures sont INVENTÉES. Ce que ces tests
 * protègent :
 *
 *   1. **Les séjours viennent de `/trips`** : identifiant lu dans l'adresse,
 *      date lue sur la carte (le texte du lien, jamais le conteneur agrégé).
 *   2. **Le `remoteId` s'ancre sur le séjour**, pas sur le lien de reçu — dont
 *      la « référence » est le `user_id`, identique pour tous les reçus.
 *   3. **Un reçu déposé sous l'ancien schéma est reconnu**, pas redéposé
 *      (`indexRecuHerite`).
 *   4. **Un séjour sans reçu est un fait compté**, pas une panne.
 *   5. **Une redirection vers la connexion est une session expirée**, et ce
 *      qui descend est vérifié `%PDF-` (acquis du lot 35, non régressés).
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const airbnb = require('../server/connectors/available/airbnb/connector');
const sessionState = require('../server/connectors/session-state');

// ---------------------------------------------------------------------------
// Fixtures — toutes INVENTÉES
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4 reçu factice');
const PAS_UN_PDF = Buffer.from('<!doctype html><html>reçu à imprimer</html>');

const SEJOUR_RECENT = '1000000000000000001';
const SEJOUR_MOYEN = '1000000000000000002';
const SEJOUR_ANCIEN = '1000000000000000003';

const RECU_RECENT =
  'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-AAA&bill_version_token=V1'
  + '&tender_token=TEND-AAA&product_id=1000000000000000001&user_id=111222333';
const RECU_MOYEN =
  'https://www.airbnb.fr/receipt-on-demand?bill_token=BILL-BBB&bill_version_token=V1'
  + '&tender_token=TEND-BBB&product_id=2222222222&user_id=111222333';

/** Les liens de la page /trips : trois cartes de séjour et de la navigation. */
const LIENS_TRIPS = [
  {
    href: `https://www.airbnb.fr/trips/v1/${SEJOUR_RECENT}`,
    texte: 'Lyon12–15 mars 2024',
    // Le conteneur AGRÈGE les cartes (mesuré lot 71) : s'il servait de source
    // de date, ce séjour-ci serait daté avec les dates de celui-là.
    ligne: 'Lyon12–15 mars 2024Nice8–12 décembre 2023Rennes2–4 août 2019',
  },
  {
    href: `https://www.airbnb.fr/trips/v1/${SEJOUR_MOYEN}`,
    texte: 'Nice8–12 décembre 2023',
    // Le conteneur agrégé COMMENCE par la carte du séjour précédent : dater
    // par le conteneur donnerait « 2024-03-15 » à ce séjour de décembre 2023.
    ligne: 'Lyon12–15 mars 2024Nice8–12 décembre 2023',
  },
  {
    href: `https://www.airbnb.fr/trips/v1/${SEJOUR_ANCIEN}`,
    texte: 'Rennes2–4 août 2019',
    ligne: 'Rennes2–4 août 2019',
  },
  // Doublon du premier séjour (une carte peut porter deux liens).
  { href: `https://www.airbnb.fr/trips/v1/${SEJOUR_RECENT}`, texte: 'Lyon12–15 mars 2024', ligne: '' },
  // Navigation : ni séjours, ni reçus.
  { href: 'https://www.airbnb.fr/trips', texte: 'Voyages', ligne: 'Menu' },
  { href: 'https://www.airbnb.fr/help/article/2503', texte: 'Comment obtenir un reçu', ligne: 'Aide' },
];

/** Le détail d'un séjour porte son lien de réservation. */
const liensDetail = (tripId, code) => [
  { href: `https://www.airbnb.fr/trips/v1/${tripId}/ro/RESERVATION2_CHECKIN/${code}`, texte: 'Ma réservation', ligne: '' },
  { href: 'https://www.airbnb.fr/aircover', texte: 'AirCover', ligne: '' },
];

/** La page de réservation porte — ou non — le lien « Voir le reçu ». */
const liensReservation = (recu) => [
  ...(recu ? [{ href: recu, texte: 'Voir le reçu', ligne: '' }] : []),
  { href: 'https://www.airbnb.fr/help/home', texte: 'Aide', ligne: '' },
];

/**
 * Une page Playwright simulée qui sert des liens différents selon l'adresse
 * ouverte — le parcours du lot 71 traverse trois pages par séjour.
 */
function fakePage(routes, { urlFinale = null } = {}) {
  let courante = 'about:blank';
  return {
    goto: async (u) => { courante = urlFinale || u; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => courante,
    evaluate: async () => {
      const route = routes.find((r) => r.match.test(courante));
      return route ? route.liens : [];
    },
  };
}

/**
 * Les routes d'un compte à trois séjours : deux reçus, un séjour ancien sans.
 * Les routes de réservation viennent en premier : l'adresse d'une réservation
 * contient celle du détail, la plus précise doit gagner.
 */
function routesCompletes() {
  return [
    { match: new RegExp(`/trips/v1/${SEJOUR_RECENT}/ro/`), liens: liensReservation(RECU_RECENT) },
    { match: new RegExp(`/trips/v1/${SEJOUR_MOYEN}/ro/`), liens: liensReservation(RECU_MOYEN) },
    { match: new RegExp(`/trips/v1/${SEJOUR_ANCIEN}/ro/`), liens: liensReservation(null) },
    { match: new RegExp(`/trips/v1/${SEJOUR_RECENT}$`), liens: liensDetail(SEJOUR_RECENT, 'HMFICTIF1') },
    { match: new RegExp(`/trips/v1/${SEJOUR_MOYEN}$`), liens: liensDetail(SEJOUR_MOYEN, 'HMFICTIF2') },
    { match: new RegExp(`/trips/v1/${SEJOUR_ANCIEN}$`), liens: liensDetail(SEJOUR_ANCIEN, 'HMFICTIF3') },
    { match: /\/trips\/?$/, liens: LIENS_TRIPS },
  ];
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

/** Une session valide : un cookie airbnb non expiré. */
function sessionValide() {
  return JSON.stringify({
    cookies: [{ name: '_airbnb_session', value: 'x', domain: '.airbnb.fr', expires: -1 }],
  });
}

// ---------------------------------------------------------------------------
// 1. Les séjours viennent de /trips
// ---------------------------------------------------------------------------

test('sejoursDepuisLiens : identifiant lu dans l\'adresse, date lue sur la carte, doublons écartés', () => {
  const sejours = airbnb.sejoursDepuisLiens(LIENS_TRIPS);

  assert.equal(sejours.length, 3, 'trois séjours, ni le doublon ni la navigation');
  assert.deepEqual(sejours.map((s) => s.tripId), [SEJOUR_RECENT, SEJOUR_MOYEN, SEJOUR_ANCIEN],
    'dans l\'ordre de la page — le plus récent d\'abord');
  // La date est celle de FIN du séjour, lue sur le TEXTE du lien : le
  // conteneur agrégé du premier séjour porte aussi « août 2019 », qui ne doit
  // pas dater ce séjour-ci.
  assert.equal(sejours[0].issuedOn, '2024-03-15');
  assert.equal(sejours[1].issuedOn, '2023-12-12');
  assert.equal(sejours[2].issuedOn, '2019-08-04');
});

// ---------------------------------------------------------------------------
// 2. Le relevé traverse séjour → réservation → reçu
// ---------------------------------------------------------------------------

test('relever : un reçu par séjour qui en propose, remoteId ancré sur le séjour, sans-reçu compté', async () => {
  const journal = [];
  const { sejours, documents, sansRecu } = await airbnb.relever(
    fakePage(routesCompletes()), (m) => journal.push(m)
  );

  assert.equal(sejours.length, 3);
  assert.equal(documents.length, 2, 'deux reçus proposés');
  assert.equal(sansRecu, 1, 'le séjour ancien sans reçu est compté, pas tu');
  // L'identifiant est celui du SÉJOUR — jamais tiré du lien de reçu, dont la
  // « référence » (user_id) est identique pour tous les reçus du compte.
  assert.deepEqual(documents.map((d) => d.remoteId),
    [`airbnb-${SEJOUR_RECENT}`, `airbnb-${SEJOUR_MOYEN}`]);
  assert.notEqual(documents[0].remoteId, documents[1].remoteId);
  assert.equal(documents[0].issuedOn, '2024-03-15', 'daté par la carte du séjour');
  // Le journal dit le compte d'une phrase : séjours vus, avec reçu, sans reçu
  // — et pourquoi l'écart avec les réservations n'est pas une panne (lot 72).
  const compte = journal.join('\n');
  assert.match(compte, /3 séjour\(s\) vus sur la page Voyages — 2 avec reçu, 1 sans reçu proposé par Airbnb/);
  assert.match(compte, /la liste entière/);
});

test('un séjour sans lien de réservation compte comme sans reçu, sans faire échouer le relevé', async () => {
  const routes = routesCompletes()
    .filter((r) => !r.match.test(`https://www.airbnb.fr/trips/v1/${SEJOUR_ANCIEN}`));
  // Le détail du séjour ancien ne rend plus rien : ni réservation, ni reçu.
  const { documents, sansRecu } = await airbnb.relever(fakePage(routes), () => {});
  assert.equal(documents.length, 2);
  assert.equal(sansRecu, 1);
});

// ---------------------------------------------------------------------------
// 3. L'ancien schéma est reconnu, pas redéposé
// ---------------------------------------------------------------------------

test('indexRecuHerite : un reçu déposé sous airbnb-<user_id> désigne le séjour le plus récent', () => {
  const documents = [
    { remoteId: `airbnb-${SEJOUR_RECENT}`, url: RECU_RECENT },
    { remoteId: `airbnb-${SEJOUR_MOYEN}`, url: RECU_MOYEN },
  ];
  // L'ancien remoteId : referenceDepuisLien sur le lien de reçu → user_id.
  assert.equal(airbnb.indexRecuHerite(documents, new Set(['airbnb-111222333'])), 0,
    'le reçu hérité est le PREMIER — celui du séjour le plus récent avec reçu');
  assert.equal(airbnb.indexRecuHerite(documents, new Set(['airbnb-999999999'])), -1,
    'un identifiant inconnu ne reconnaît rien');
  assert.equal(airbnb.indexRecuHerite([], new Set(['airbnb-111222333'])), -1);
  // Le nouveau schéma ne passe PAS par la reconnaissance héritée : il est déjà
  // dans `connus` sous son propre identifiant.
  assert.equal(airbnb.indexRecuHerite(documents, new Set([`airbnb-${SEJOUR_MOYEN}`])), -1);
});

// ---------------------------------------------------------------------------
// 4. Session expirée et vérification %PDF- (acquis du lot 35)
// ---------------------------------------------------------------------------

test('une redirection vers /login est une session expirée, jamais « aucun séjour »', async () => {
  await assert.rejects(
    () => airbnb.relever(fakePage([], { urlFinale: 'https://www.airbnb.fr/login?redirect_url=%2Ftrips' })),
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
  assert.equal(airbnb.estPageAuthentification('https://www.airbnb.fr/trips'), false);
  assert.equal(
    airbnb.estPageAuthentification('https://www.airbnb.fr/trips?returnTo=%2Flogin'),
    false
  );
});

test('un reçu PDF descend ; une page à imprimer est refusée avec un message qui le dit', async () => {
  const doc = { remoteId: `airbnb-${SEJOUR_RECENT}`, url: RECU_RECENT };

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
  const doc = { remoteId: `airbnb-${SEJOUR_RECENT}`, url: RECU_RECENT };
  await assert.rejects(
    () => airbnb.telecharger(fakeContext({ status: 403 }), doc),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 5. Aucun jeton de reçu ne fuit
// ---------------------------------------------------------------------------

test('les jetons de reçu (bill_token, tender_token) ne fuient ni au journal ni au message', async () => {
  const journal = [];
  const { documents } = await airbnb.relever(fakePage(routesCompletes()), (m) => journal.push(m));

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
// 6. La session est contrôlée avant tout
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
  const etat = airbnb.lireSession({ session: sessionValide() });
  assert.ok(Array.isArray(etat.cookies), 'l\'état de session est rendu tel quel');
  assert.equal(sessionState.validate(sessionValide()).ok, true);
});
