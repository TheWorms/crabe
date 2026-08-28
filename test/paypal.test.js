'use strict';

/**
 * Connecteur PayPal — les deux bornes que l'API impose, et ce qu'on en dit.
 *
 * ─── Ce que ces tests protègent ──────────────────────────────────────────────
 *
 * PayPal refuse toute demande couvrant plus de 31 jours, et ne conserve que
 * trois ans d'historique par cette voie. Deux contraintes bêtes, deux défauts
 * silencieux si elles sont mal portées :
 *
 *   - des fenêtres qui se RECOUVRENT font apparaître deux fois les opérations
 *     de la charnière dans un relevé qui prétend être un relevé ;
 *   - une borne de trois ans appliquée sans le dire laisse croire que
 *     « depuis toujours » a été tenu. Le trou ne se découvre que le jour où on
 *     cherche une opération de 2021 — c'est-à-dire trop tard.
 *
 * ⚠ Ce qu'ils NE prouvent pas : que PayPal accepte ces appels. Aucun compte
 * réel n'a encore été essayé — le connecteur attend son premier test.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const paypal = require('../server/connectors/available/paypal/connector');
const releve = require('../server/connectors/releve-reconstitue');

const jour = (iso) => new Date(`${iso}T00:00:00Z`);

// ---------------------------------------------------------------------------
// Les fenêtres de 31 jours
// ---------------------------------------------------------------------------

test('une période courte tient dans une seule fenêtre', () => {
  const fenetres = paypal.fenetresDe31Jours(jour('2026-07-01'), jour('2026-07-15'));
  assert.equal(fenetres.length, 1);
  assert.equal(fenetres[0].du.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(fenetres[0].au.toISOString().slice(0, 10), '2026-07-15');
});

test('aucune fenêtre ne dépasse 31 jours — la borne de PayPal', () => {
  const fenetres = paypal.fenetresDe31Jours(jour('2024-01-01'), jour('2026-08-12'));
  assert.ok(fenetres.length > 1);
  for (const f of fenetres) {
    const jours = (f.au.getTime() - f.du.getTime()) / 86_400_000;
    assert.ok(jours <= 31, `fenêtre de ${jours} jours`);
  }
});

test('les fenêtres sont JOINTIVES : aucun recouvrement, aucun trou', () => {
  const fenetres = paypal.fenetresDe31Jours(jour('2026-01-01'), jour('2026-08-12'));
  for (let i = 1; i < fenetres.length; i++) {
    assert.equal(
      fenetres[i].du.getTime(),
      fenetres[i - 1].au.getTime(),
      'une fenêtre commence exactement là où la précédente s\'arrête'
    );
  }
  assert.equal(fenetres[0].du.getTime(), jour('2026-01-01').getTime());
  assert.equal(fenetres.at(-1).au.getTime(), jour('2026-08-12').getTime());
});

test('une période inversée ou absurde rend une liste vide, pas une boucle', () => {
  assert.deepEqual(paypal.fenetresDe31Jours(jour('2026-08-12'), jour('2026-01-01')), []);
  assert.deepEqual(paypal.fenetresDe31Jours(null, jour('2026-01-01')), []);
});

// ---------------------------------------------------------------------------
// Le plafond de trois ans, et ce qu'on en dit
// ---------------------------------------------------------------------------

test('« tout l\'historique » est ramené à trois ans — et c\'est DIT', () => {
  const periode = paypal.periodeAtteignable(
    { historique: 'tout' },
    {},
    new Date('2026-08-12T00:00:00Z')
  );

  assert.equal(periode.tronque, true);
  // Un jour de marge en dedans de la borne des 36 mois (hotfix du 18/08/2026) :
  // posé pile sur la ligne, start_date la franchissait pendant le trajet de la
  // requête et PayPal rendait 400.
  assert.equal(periode.du.toISOString().slice(0, 10), '2023-08-13');
  assert.ok(periode.message, 'la troncature ne doit jamais être silencieuse');
  assert.ok(/3 ans/.test(periode.message));
  assert.ok(periode.message.includes('2023-08-13'), 'le message dit où la reprise commence');
});

test('une demande qui tient dans trois ans n\'est pas tronquée, et ne dit rien', () => {
  const periode = paypal.periodeAtteignable(
    { historique: 'courante' },
    {},
    new Date('2026-08-12T00:00:00Z')
  );
  assert.equal(periode.tronque, false);
  assert.equal(periode.message, null);
  assert.equal(periode.du.toISOString().slice(0, 10), '2026-01-01');
});

test('la borne basse existe TOUJOURS : PayPal n\'accepte pas « sans date de début »', () => {
  for (const historique of ['tout', 'depuis', 'courante', 'dernieres:2']) {
    const periode = paypal.periodeAtteignable({ historique }, {}, new Date('2026-08-12T00:00:00Z'));
    assert.ok(periode.du instanceof Date, `${historique} : borne basse manquante`);
    assert.ok(periode.du.getTime() <= periode.au.getTime());
  }
});

// ---------------------------------------------------------------------------
// Lecture d'une réponse d'exemple
// ---------------------------------------------------------------------------

/** Deux lignes telles que `/v1/reporting/transactions` les rend. */
const OPERATIONS = [
  {
    transaction_info: {
      transaction_id: '8XY12345AB6789012',
      transaction_initiation_date: '2026-07-04T09:22:11+0000',
      transaction_event_code: 'T0006',
      transaction_subject: 'Abonnement mensuel',
      transaction_amount: { currency_code: 'EUR', value: '-12.99' },
      fee_amount: { currency_code: 'EUR', value: '0.00' },
      transaction_status: 'S',
    },
    payer_info: {
      email_address: 'facturation@exemple.test',
      payer_name: { given_name: 'Société', surname: 'Exemple' },
    },
  },
  {
    transaction_info: {
      transaction_id: '9ZZ98765CD4321098',
      transaction_initiation_date: '2026-08-02T11:00:00+0000',
      transaction_amount: { currency_code: 'EUR', value: '-4.50' },
    },
    payer_info: {},
  },
];

test('une opération est ramenée aux colonnes du relevé, montant recopié', () => {
  const lisible = paypal.operationLisible(OPERATIONS[0]);
  assert.equal(lisible.date, '2026-07-04');
  assert.equal(lisible.reference, '8XY12345AB6789012');
  assert.ok(lisible.nature.includes('Abonnement mensuel'));
  assert.equal(lisible.correspondant, 'Société Exemple');
  assert.equal(lisible.montant, '-12.99 EUR');
  assert.equal(lisible.frais, '0.00 EUR');
});

test('un champ absent reste vide — jamais « inconnu », qui aurait l\'air d\'une information', () => {
  const lisible = paypal.operationLisible(OPERATIONS[1]);
  assert.equal(lisible.correspondant, '');
  assert.equal(lisible.frais, '');
});

test('le montant et les frais ne sont jamais additionnés', () => {
  const lisible = paypal.operationLisible({
    transaction_info: {
      transaction_id: 'X',
      transaction_initiation_date: '2026-07-04T00:00:00+0000',
      transaction_amount: { currency_code: 'EUR', value: '-10.00' },
      fee_amount: { currency_code: 'EUR', value: '-0.35' },
    },
  });
  assert.equal(lisible.montant, '-10.00 EUR');
  assert.equal(lisible.frais, '-0.35 EUR');
  assert.equal(JSON.stringify(lisible).includes('10.35'), false);
});

// ---------------------------------------------------------------------------
// La découpe mensuelle
// ---------------------------------------------------------------------------

test('août n\'est pas produit tant qu\'août n\'est pas fini', () => {
  const mois = releve.parMoisRevolus(OPERATIONS, paypal.dateIso, new Date('2026-08-12T00:00:00Z'));
  assert.deepEqual(mois.map((m) => m.mois), ['2026-07']);
});

test('l\'identifiant d\'un relevé mensuel est stable', () => {
  assert.equal(paypal.remoteIdDuMois('2026-07'), 'paypal-releve-2026-07');
});

// ---------------------------------------------------------------------------
// Le document produit — et son bandeau
// ---------------------------------------------------------------------------

test('le relevé produit porte son bandeau, littéralement', () => {
  const pdf = releve.construire({
    service: 'PayPal',
    periode: { du: '2026-07-01', au: '2026-07-31' },
    genereLe: new Date('2026-08-01T08:00:00Z'),
    colonnes: paypal.COLONNES,
    operations: OPERATIONS.map(paypal.operationLisible),
    mentions: ['Source : API PayPal, GET /v1/reporting/transactions'],
  });

  const octets = pdf.toString('latin1');
  assert.ok(octets.includes(releve.versWinAnsi(releve.bandeau('PayPal'))));
  assert.equal(octets.slice(0, 5), '%PDF-');
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

test('un 401 parle des identifiants, et du piège Live / Sandbox', () => {
  const message = paypal.messageDeRefus(401, '{"error":"invalid_client"}');
  assert.ok(/Live/.test(message));
  assert.ok(/Sandbox/.test(message));
});

test('un 403 parle de « Transaction Search », des neuf heures, et du compte professionnel', () => {
  // Les deux causes se ressemblent à s'y méprendre chez PayPal et n'appellent
  // pas la même action : corriger une clé, ou attendre. Les confondre fait
  // régénérer une clé pour rien et recommencer l'attente depuis le début.
  const message = paypal.messageDeRefus(403, '{"name":"NOT_AUTHORIZED"}');
  assert.ok(/Transaction Search/.test(message));
  assert.ok(/neuf heures/.test(message));
  assert.ok(/professionnel/.test(message));
});

test('un appel sans identifiants refuse tout de suite, en français', async () => {
  await assert.rejects(
    () => paypal.test({}),
    /Identifiants PayPal manquants.*identifiant d'application.*secret d'application/s
  );
});

// ---------------------------------------------------------------------------
// L'échec réel du 12/08/2026 : « identifiant ou secret refusé »
// ---------------------------------------------------------------------------

/**
 * Ce que ces tests protègent : la différence entre suggérer une cause et
 * l'établir. Le message du lot 20 disait « vérifiez que vous les avez copiés
 * depuis l'onglet Live » — c'était la bonne piste, et l'essai a échoué quand
 * même. Un logiciel public ne peut pas se contenter de donner la liste des
 * causes possibles : quand il peut trancher, il tranche.
 */
test('le refus prudent nomme les deux confusions possibles', () => {
  const message = paypal.messageDeRefus(401, '{"error":"invalid_client"}');
  assert.match(message, /Live/);
  assert.match(message, /Sandbox/);
  assert.match(message, /MÊME application/i, 'un couple dépareillé donne le même refus');
});

test('un refus de permission ne parle jamais du bac à sable', () => {
  // Une permission fraîche n'a rien à voir avec l'onglet : y envoyer quelqu'un
  // lui ferait régénérer une application pour rien, et attendre neuf heures
  // de plus.
  const message = paypal.messageDeRefus(403, '{"name":"NOT_AUTHORIZED"}');
  assert.match(message, /Transaction Search/);
  assert.match(message, /neuf heures/i);
  assert.equal(/Sandbox/.test(message), false);
});

test('le message d\'identifiants d\'essai AFFIRME, il ne demande pas de vérifier', () => {
  const message = paypal.MESSAGE_IDENTIFIANTS_SANDBOX;
  assert.match(message, /crabe vient de le vérifier/i);
  assert.match(message, /Live/);
  assert.equal(/vérifiez que/i.test(message), false, 'plus de diagnostic renvoyé à l\'utilisateur');
});

test('le bac à sable visé est bien celui de PayPal, et lui seul', () => {
  // Ce diagnostic envoie des identifiants à une seconde adresse : elle doit
  // rester un domaine de PayPal, et cette ligne est là pour qu'un changement
  // d'adresse ne passe jamais inaperçu.
  assert.equal(paypal.BASE_ESSAI, 'https://api-m.sandbox.paypal.com');
  assert.match(paypal.BASE_ESSAI, /^https:\/\/[a-z0-9.-]+\.paypal\.com$/);
});

/** Des valeurs de la BONNE FORME : 80 et 64 caractères, comme PayPal en délivre. */
const ID_PLAUSIBLE = `A${'x'.repeat(79)}`;
const SECRET_PLAUSIBLE = `E${'y'.repeat(63)}`;

test('l\'identifiant et le secret perdent les espaces du copier-coller', () => {
  assert.deepEqual(
    paypal.identifiants({ clientId: ` ${ID_PLAUSIBLE}\n`, clientSecret: `\t${SECRET_PLAUSIBLE} ` }),
    { cle: ID_PLAUSIBLE, secret: SECRET_PLAUSIBLE }
  );
  assert.throws(
    () => paypal.identifiants({ clientId: '  ', clientSecret: SECRET_PLAUSIBLE }),
    /identifiant d'application/
  );
});

// ---------------------------------------------------------------------------
// La forme de ce qui est saisi — lot 23
//
// L'échec réel : deux tentatives, le même refus, et une explication (« vos
// identifiants sont ceux du bac à sable ») que la sonde du lot 23 a démentie.
// Ce qui était enregistré mesurait 14 et 19 caractères : une adresse e-mail et
// un mot de passe de compte. PayPal répond « invalid_client » à ça exactement
// comme à un identifiant Sandbox — mesuré, huit variantes, réponse identique au
// caractère près. Rien ne vient donc du réseau : seule la FORME distingue les
// cas, et elle se lit avant d'appeler qui que ce soit.
// ---------------------------------------------------------------------------

test('une adresse e-mail à la place de l\'identifiant est reconnue comme telle', () => {
  const defaut = paypal.defautDeForme('camille@exemple.fr', 'MonMotDePasse!42');

  assert.match(defaut, /adresse e-mail et au mot de passe de votre compte/i);
  assert.match(defaut, /developer\.paypal\.com/);
  assert.match(defaut, /80 caractères/);
  assert.match(defaut, /Transaction Search/);
  // Le message est lu par quelqu'un qui découvre le service : il dit quoi
  // faire, il ne renvoie pas la faute.
  assert.match(defaut, /ce n'est pas de votre faute/i);
});

test('une valeur trop courte est refusée en disant ce qu\'elle mesure', () => {
  const defaut = paypal.defautDeForme('abc', 'def');
  assert.match(defaut, /3 et 3 caractères/);
});

test('des identifiants de la bonne forme passent sans être inquiétés', () => {
  assert.equal(paypal.defautDeForme(ID_PLAUSIBLE, SECRET_PLAUSIBLE), null);
  assert.doesNotThrow(
    () => paypal.identifiants({ clientId: ID_PLAUSIBLE, clientSecret: SECRET_PLAUSIBLE })
  );
});

test('le contrôle de forme s\'applique AVANT le moindre appel à PayPal', async () => {
  // Deux raisons, et la seconde n'est pas la moindre : un mot de passe de compte
  // PayPal ne doit pas partir sur une route qui n'en attend pas. Ici, une base
  // volontairement inatteignable — si un appel réseau était tenté, le test
  // échouerait sur autre chose que le message de forme.
  await assert.rejects(
    () => paypal.test({ clientId: 'camille@exemple.fr', clientSecret: 'motdepasse' }),
    /adresse e-mail et au mot de passe/i
  );
});

test('la demande de jeton part en Basic, avec le bon type de contenu', async () => {
  const http = require('node:http');
  const serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (m) => { corps += m; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ chemin: req.url, entetes: req.headers, corps }));
    });
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${serveur.address().port}`;
    const reponse = await paypal.demanderJeton(base, 'mon-id', 'mon-secret');
    const vu = JSON.parse(reponse.texte);

    assert.equal(vu.chemin, '/v1/oauth2/token');
    assert.equal(
      vu.entetes.authorization,
      `Basic ${Buffer.from('mon-id:mon-secret').toString('base64')}`
    );
    assert.equal(vu.entetes['content-type'], 'application/x-www-form-urlencoded');
    assert.match(vu.corps, /grant_type=client_credentials/);
    assert.match(vu.corps, /reporting%2Fsearch%2Fread/, 'le périmètre demandé est en lecture seule');
  } finally {
    serveur.close();
  }
});

// ---------------------------------------------------------------------------
// L'identifiant de compte — lisible, jamais le Client ID (lot 38)
// ---------------------------------------------------------------------------

test('l\'identifiant de compte est « releves-paypal » — jamais le Client ID', () => {
  // Le Client ID d'application fait 80 caractères : affiché comme libellé de
  // compte et posé en nom de dossier, il est illisible et expose une valeur
  // technique. L'API ne donne pas l'adresse du compte (mesuré le 18/08/2026 :
  // /v1/identity/oauth2/userinfo ne porte que user_id/sub) : le compte est un
  // libellé stable et lisible.
  assert.equal(paypal.COMPTE, 'releves-paypal');

  const accountIds = require('../server/connectors/account-id');
  const manifest = require('../server/connectors/available/paypal/manifest.json');
  const config = { clientId: 'A'.repeat(80), clientSecret: 'B'.repeat(64) };

  // La déduction depuis la configuration est REFUSÉE par le manifeste : sans
  // ça, le premier champ texte — le Client ID — redeviendrait l'identifiant.
  assert.equal(manifest.accountIdField, false);
  assert.equal(accountIds.fromConfig(manifest, config), null);

  // Et même avec un ancien Client ID enregistré en base, ce que le connecteur
  // remonte prime.
  assert.equal(
    accountIds.resolve({ manifest, config, reported: paypal.COMPTE, stored: 'A'.repeat(80) }),
    'releves-paypal'
  );
});
