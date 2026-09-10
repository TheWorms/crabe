'use strict';

/**
 * Connecteur Bitstamp — la signature, et rien d'autre de deviné.
 *
 * ─── Pourquoi ces tests existent ─────────────────────────────────────────────
 *
 * Bitstamp ne prend pas un jeton mais une signature HMAC-SHA256 sur une
 * concaténation SANS SÉPARATEUR. Une seule pièce à la mauvaise place et le
 * serveur rend une erreur d'authentification **strictement indiscernable d'une
 * clé fausse** : on cherche alors le défaut du mauvais côté — on régénère la
 * clé, on attend le courriel d'activation, on recommence — pendant que le
 * problème est dans l'ordre de deux chaînes.
 *
 * Ces tests figent cet ordre. Ils n'ont besoin d'aucun réseau, d'aucune clé
 * réelle, et ils échoueront le jour où quelqu'un déplacera une pièce.
 *
 * ⚠ Ce qu'ils NE prouvent pas : que Bitstamp accepte cette signature. Personne
 * n'a encore essayé la moindre clé réelle — le connecteur est en attente de son
 * premier test contre un vrai compte. Ce qui est prouvé ici, c'est la
 * conformité à la spécification relevée, pas la réponse du serveur.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const bitstamp = require('../server/connectors/available/bitstamp/connector');
const releve = require('../server/connectors/releve-reconstitue');

/** Des valeurs figées : aucun tirage au hasard dans un test de signature. */
const CLE = 'cle-de-test';
const SECRET = 'secret-de-test';
const NONCE = '0123abcd-4567-89ef-0123-456789abcdef';
const HORODATAGE = '1786000000000';

// ---------------------------------------------------------------------------
// La chaîne signée
// ---------------------------------------------------------------------------

test('la chaîne signée assemble les pièces dans l\'ordre exact de Bitstamp', () => {
  const chaine = bitstamp.chaineASigner({
    cle: CLE,
    verbe: 'POST',
    hote: 'www.bitstamp.net',
    chemin: '/api/v2/user_transactions/',
    requete: '',
    typeContenu: 'application/x-www-form-urlencoded',
    nonce: NONCE,
    horodatage: HORODATAGE,
    corps: 'limit=1',
  });

  assert.equal(
    chaine,
    'BITSTAMP cle-de-test'
      + 'POST'
      + 'www.bitstamp.net'
      + '/api/v2/user_transactions/'
      + ''
      + 'application/x-www-form-urlencoded'
      + NONCE
      + HORODATAGE
      + 'v2'
      + 'limit=1'
  );
});

test('le type de contenu DISPARAÎT quand le corps est vide', () => {
  // La règle la plus contre-intuitive de la spécification, et celle qui coûte
  // le plus cher : l'inclure quand même donne une signature refusée, avec un
  // message qui accuse la clé.
  const chaine = bitstamp.chaineASigner({
    cle: CLE,
    verbe: 'POST',
    hote: 'www.bitstamp.net',
    chemin: '/api/v2/balance/',
    typeContenu: 'application/x-www-form-urlencoded',
    nonce: NONCE,
    horodatage: HORODATAGE,
    corps: '',
  });

  assert.equal(chaine.includes('application/x-www-form-urlencoded'), false);
  assert.equal(chaine, `BITSTAMP ${CLE}POSTwww.bitstamp.net/api/v2/balance/${NONCE}${HORODATAGE}v2`);
});

test('l\'espace après BITSTAMP fait partie de la chaîne', () => {
  // « BITSTAMPcle » et « BITSTAMP cle » ne donnent pas la même empreinte, et
  // l'oubli d'un espace ne se voit pas à la lecture.
  const chaine = bitstamp.chaineASigner({
    cle: CLE, verbe: 'POST', hote: 'h', chemin: '/c', nonce: NONCE, horodatage: HORODATAGE,
  });
  assert.equal(chaine.startsWith('BITSTAMP cle-de-test'), true);
});

// ---------------------------------------------------------------------------
// La signature elle-même
// ---------------------------------------------------------------------------

test('la signature est un HMAC-SHA256 en hexadécimal MAJUSCULE', () => {
  const attendu = crypto.createHmac('sha256', SECRET).update('abc', 'utf8').digest('hex').toUpperCase();
  const obtenu = bitstamp.signer(SECRET, 'abc');
  assert.equal(obtenu, attendu);
  assert.match(obtenu, /^[0-9A-F]{64}$/, 'Bitstamp refuse les minuscules');
});

test('les cinq en-têtes sont posés, et le Content-Type seulement s\'il y a un corps', () => {
  const sansCorps = bitstamp.entetes({
    cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/api/v2/balance/',
    nonce: NONCE, horodatage: HORODATAGE,
  }).entetes;

  assert.deepEqual(Object.keys(sansCorps).sort(), [
    'X-Auth', 'X-Auth-Nonce', 'X-Auth-Signature', 'X-Auth-Timestamp', 'X-Auth-Version',
  ]);
  assert.equal(sansCorps['X-Auth'], `BITSTAMP ${CLE}`);
  assert.equal(sansCorps['X-Auth-Version'], 'v2');
  assert.equal(sansCorps['X-Auth-Nonce'], NONCE);
  assert.equal(sansCorps['X-Auth-Timestamp'], HORODATAGE);

  const avecCorps = bitstamp.entetes({
    cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/api/v2/user_transactions/',
    corps: 'limit=1', nonce: NONCE, horodatage: HORODATAGE,
  }).entetes;
  assert.equal(avecCorps['Content-Type'], 'application/x-www-form-urlencoded');
});

test('deux appels au même instant ne portent pas le même nonce', () => {
  // Bitstamp refuse un nonce déjà vu dans une fenêtre de 150 secondes : deux
  // appels d'une même récupération se marcheraient dessus.
  const a = bitstamp.entetes({ cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/c' });
  const b = bitstamp.entetes({ cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/c' });
  assert.notEqual(a.nonce, b.nonce);
});

test('le nonce fait exactement 36 caractères minuscules', () => {
  const valeur = bitstamp.nonce();
  assert.equal(valeur.length, 36);
  assert.equal(valeur, valeur.toLowerCase());
});

test('la signature de la RÉPONSE suit sa propre chaîne, plus courte', () => {
  // nonce + horodatage de la REQUÊTE, puis type de contenu et corps de la
  // RÉPONSE. Reprendre la chaîne de la requête ici ferait rejeter toutes les
  // réponses, y compris parfaitement légitimes.
  const attendue = bitstamp.signatureAttendueDeLaReponse({
    secret: SECRET, nonce: NONCE, horodatage: HORODATAGE,
    typeContenu: 'application/json', corps: '[]',
  });
  assert.equal(attendue, bitstamp.signer(SECRET, `${NONCE}${HORODATAGE}application/json[]`));
});

// ---------------------------------------------------------------------------
// Lecture d'une réponse d'exemple
// ---------------------------------------------------------------------------

/**
 * Deux lignes telles que `user_transactions` les rend : toutes les devises du
 * compte à chaque ligne, la plupart à zéro.
 */
const OPERATIONS = [
  {
    id: 4413221, datetime: '2026-07-03 09:12:44.000000', type: '0',
    eur: '250.00', usd: '0.00', btc: '0.00000000', fee: '0.00',
  },
  {
    id: 4413955, datetime: '2026-07-18 14:02:01.000000', type: '2',
    eur: '-100.00', usd: '0.00', btc: '0.00093110', btc_eur: '107400.00', fee: '0.50',
  },
];

test('une opération est ramenée aux colonnes du relevé, sans rien inventer', () => {
  const lisible = bitstamp.operationLisible(OPERATIONS[1]);

  assert.equal(lisible.date, '2026-07-18');
  assert.equal(lisible.reference, '4413955');
  assert.equal(lisible.nature, 'Opération de marché (2)', 'le code brut reste visible');
  assert.equal(lisible.frais, '0.50');
  // Les montants nuls sont écartés — sinon la colonne serait pleine de zéros —
  // mais aucun montant n'est additionné ni converti.
  assert.equal(lisible.montants.includes('-100.00 EUR'), true);
  assert.equal(lisible.montants.includes('0.00093110 BTC'), true);
  assert.equal(lisible.montants.includes('USD'), false, 'les zéros ne remplissent pas la colonne');
  assert.equal(lisible.montants.includes('150'), false, 'aucune addition');
});

test('un type inconnu s\'affiche tel quel plutôt que de disparaître', () => {
  const lisible = bitstamp.operationLisible({ id: 1, datetime: '2026-07-01 00:00:00', type: '99' });
  assert.equal(lisible.nature, 'Type 99');
});

test('une opération sans aucun montant garde une cellule marquée, pas vide', () => {
  const lisible = bitstamp.operationLisible({ id: 2, datetime: '2026-07-01 00:00:00', type: '0' });
  assert.equal(lisible.montants, '—');
});

// ---------------------------------------------------------------------------
// La découpe mensuelle, et l'identifiant qui la rend idempotente
// ---------------------------------------------------------------------------

test('les mois RÉVOLUS seulement : le mois en cours attend d\'être fini', () => {
  const mois = releve.parMoisRevolus(
    OPERATIONS.concat([{ id: 9, datetime: '2026-08-05 10:00:00', type: '0' }]),
    (o) => bitstamp.dateIso(o.datetime),
    new Date('2026-08-12T00:00:00Z')
  );

  assert.deepEqual(mois.map((m) => m.mois), ['2026-07']);
  assert.equal(mois[0].du, '2026-07-01');
  assert.equal(mois[0].au, '2026-07-31');
  assert.equal(mois[0].operations.length, 2);
});

test('février bissextile se termine bien le 29', () => {
  const mois = releve.parMoisRevolus(
    [{ datetime: '2024-02-15 00:00:00' }],
    (o) => bitstamp.dateIso(o.datetime),
    new Date('2024-04-01T00:00:00Z')
  );
  assert.equal(mois[0].au, '2024-02-29');
});

test('une opération sans date n\'est rangée dans aucun mois', () => {
  const mois = releve.parMoisRevolus(
    [{ datetime: null }, { datetime: '2026-07-02 00:00:00' }],
    (o) => bitstamp.dateIso(o.datetime),
    new Date('2026-08-12T00:00:00Z')
  );
  assert.equal(mois.length, 1);
  assert.equal(mois[0].operations.length, 1);
});

test('l\'identifiant d\'un relevé mensuel est stable — il ne se produit qu\'une fois', () => {
  assert.equal(bitstamp.remoteIdDuMois('2026-07'), 'bitstamp-releve-2026-07');
  assert.equal(bitstamp.remoteIdDuMois('2026-07'), bitstamp.remoteIdDuMois('2026-07'));
});

test('le nom de fichier annonce ce qu\'est le document, avant même de l\'ouvrir', () => {
  const nom = releve.nomFichier({ service: 'Bitstamp', du: '2026-07-01', au: '2026-07-31' });
  assert.equal(nom, 'bitstamp_releve-reconstitue_2026-07-01_2026-07-31.pdf');
});

// ---------------------------------------------------------------------------
// Le document produit — et son bandeau
// ---------------------------------------------------------------------------

test('le relevé produit porte son bandeau, littéralement, sur chaque page', () => {
  const pdf = releve.construire({
    service: 'Bitstamp',
    periode: { du: '2026-07-01', au: '2026-07-31' },
    genereLe: new Date('2026-08-01T08:00:00Z'),
    colonnes: bitstamp.COLONNES,
    operations: OPERATIONS.map(bitstamp.operationLisible),
    mentions: ['Source : API Bitstamp v2'],
  });

  const octets = pdf.toString('latin1');
  const phrase = releve.versWinAnsi(releve.bandeau('Bitstamp'));
  assert.ok(octets.includes(phrase), 'le bandeau doit être lisible dans les octets du fichier');
  assert.equal(octets.slice(0, 5), '%PDF-');
});

test('le relevé n\'imite pas une facture', () => {
  const pdf = releve.construire({
    service: 'Bitstamp',
    periode: { du: '2026-07-01', au: '2026-07-31' },
    genereLe: new Date('2026-08-01T08:00:00Z'),
    colonnes: bitstamp.COLONNES,
    operations: OPERATIONS.map(bitstamp.operationLisible),
  });
  const texte = pdf.toString('latin1').toLowerCase();
  for (const mot of ['facture', 'invoice', 'duplicata', 'à payer', 'total ttc']) {
    assert.equal(texte.includes(mot), false, `le mot « ${mot} » n'a rien à faire dans un relevé`);
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

test('le refus de clé nomme les trois causes, sans jargon', () => {
  const message = bitstamp.messageDeRefus('{"status":"error","reason":"Invalid signature"}');
  assert.ok(message.includes('Invalid signature'), 'le motif du serveur est repris');
  assert.ok(/activ[ée]e? par le lien reçu par courriel/i.test(message));
  assert.ok(/permissions de lecture/i.test(message));
  assert.ok(/adresse IP/i.test(message));
  assert.equal(/HTTP \d{3}/.test(message), false, 'aucun code technique nu');
});

test('un appel sans clé ni secret refuse tout de suite, en français', async () => {
  await assert.rejects(
    () => bitstamp.test({}),
    /Identifiants Bitstamp manquants.*clé d'API.*secret d'API/s
  );
});

// ---------------------------------------------------------------------------
// Ce que le serveur REÇOIT — l'échec réel du 12/08/2026
// ---------------------------------------------------------------------------

/**
 * Le lot 20 vérifiait déjà que le connecteur ne pose pas de type de contenu
 * quand le corps est vide. Ce test-là disait vrai, et Bitstamp a quand même
 * répondu « Content-Type header should not be present » au premier essai réel.
 *
 * Parce qu'il examinait NOS en-têtes. Ceux que la couche réseau ajoute par
 * dessus, personne ne les regardait — et c'est là que l'en-tête interdit était.
 *
 * D'où cet écho : un serveur local qui rend ce qu'il a réellement reçu. Il ne
 * simule rien, il constate. Aucun réseau ne sort de la machine, aucune clé
 * réelle n'est employée.
 */
function avecEcho(fn) {
  const http = require('node:http');
  const serveur = http.createServer((req, res) => {
    let recu = '';
    req.on('data', (morceau) => { recu += morceau; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ entetes: req.headers, corps: recu }));
    });
  });
  return new Promise((resoudre, rejeter) => {
    serveur.listen(0, '127.0.0.1', async () => {
      try {
        resoudre(await fn(`http://127.0.0.1:${serveur.address().port}/`));
      } catch (err) {
        rejeter(err);
      } finally {
        serveur.close();
      }
    });
  });
}

test('LE PIÈGE : un corps de chaîne VIDE se voit quand même coller un type de contenu', async () => {
  const recu = await avecEcho(async (base) => {
    const reponse = await fetch(base, { method: 'POST', headers: { 'X-Auth': 'BITSTAMP x' }, body: '' });
    return reponse.json();
  });

  // Ce n'est pas une bizarrerie de Node : la spécification de fetch attribue
  // « text/plain » à tout corps de type chaîne, et ne fait aucune exception
  // pour la chaîne vide. C'est très exactement l'en-tête que Bitstamp a refusé.
  assert.equal(
    recu.entetes['content-type'],
    'text/plain;charset=UTF-8',
    'si cette ligne casse un jour, la correction ci-dessous a cessé d\'être nécessaire'
  );
});

test('les options d\'un appel SANS paramètre n\'emportent aucun type de contenu', async () => {
  const { entetes: enTetes } = bitstamp.entetes({
    cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/api/v2/balance/', corps: '',
    nonce: NONCE, horodatage: HORODATAGE,
  });

  const recu = await avecEcho(async (base) => {
    const reponse = await fetch(base, bitstamp.optionsDeRequete({ entetes: enTetes, corps: '' }));
    return reponse.json();
  });

  assert.equal(recu.entetes['content-type'], undefined, 'Content-Type header should not be present');
  assert.equal(recu.corps, '', 'aucun corps n\'est envoyé');
  assert.equal(recu.entetes['x-auth'], `BITSTAMP ${CLE}`, 'les en-têtes signés partent bien');
  assert.equal(recu.entetes['x-auth-nonce'], NONCE);
});

test('un appel AVEC paramètres emporte le type de contenu signé, et son corps', async () => {
  const corps = 'limit=1&sort=desc';
  const { entetes: enTetes } = bitstamp.entetes({
    cle: CLE, secret: SECRET, verbe: 'POST', chemin: '/api/v2/user_transactions/', corps,
    nonce: NONCE, horodatage: HORODATAGE,
  });

  const recu = await avecEcho(async (base) => {
    const reponse = await fetch(base, bitstamp.optionsDeRequete({ entetes: enTetes, corps }));
    return reponse.json();
  });

  assert.equal(recu.entetes['content-type'], bitstamp.TYPE_CONTENU);
  assert.equal(recu.corps, corps);
});

test('la clé et le secret perdent les espaces que le copier-coller emporte', () => {
  // « Wrong API key format », le premier grief du 12/08/2026 : un retour à la
  // ligne invisible suffit à le déclencher.
  assert.deepEqual(
    bitstamp.identifiants({ apiKey: '  ma-cle\n', apiSecret: '\tmon-secret ' }),
    { cle: 'ma-cle', secret: 'mon-secret' }
  );
});

test('une clé faite d\'espaces est traitée comme absente, pas comme fausse', () => {
  assert.throws(() => bitstamp.identifiants({ apiKey: '   ', apiSecret: 'x' }), /clé d'API/);
});

test('un grief de requête n\'envoie plus personne vérifier sa clé', () => {
  const message = bitstamp.messageDeRefus(
    '{"status":"error","reason":"Content-Type header should not be present","code":"API0004"}'
  );
  assert.match(message, /bien reconnu votre clé/i);
  assert.match(message, /défaut de crabe/i);
  assert.equal(/Trois choses à vérifier/.test(message), false, 'ne renvoie pas vers la clé');

  // Et l'inverse tient : une clé inconnue reste une affaire de clé.
  assert.match(
    bitstamp.messageDeRefus('{"status":"error","reason":"API key not found"}'),
    /activ[ée]e? par le lien reçu par courriel/i
  );
});

test('« aucun en-tête reçu » est un défaut de crabe, malgré le mot « key »', () => {
  assert.equal(bitstamp.natureDuRefus('Missing key, signature and nonce parameters'), 'requete');
  assert.equal(bitstamp.natureDuRefus('Wrong API key format'), 'cle');
  assert.equal(bitstamp.natureDuRefus('X-Auth-Nonce header is invalid'), 'requete');
  assert.equal(bitstamp.natureDuRefus(''), 'cle');
});

// ---------------------------------------------------------------------------
// La fenêtre d'historique — lot 31, tâche 7
// ---------------------------------------------------------------------------
//
// Séquence relevée en production le 13/08/2026 à 19:12:54, dans la même
// seconde : « Clé d'API acceptée (891 ligne(s) de solde lue(s)) » puis
// « Failed to convert since_timestamp parameter ». La valeur envoyée était la
// borne basse en MILLISECONDES (Date.getTime()) là où Bitstamp attend des
// secondes — et la mesure du 13/08 a montré pire : Bitstamp refuse toute borne
// de plus de 30 jours, donc le paramètre corrigé aurait été refusé onze mois
// sur douze (« since_timestamp parameter must be higher than … »).
//
// Le correctif ne convertit donc pas : il SUPPRIME le paramètre, et la fenêtre
// s'applique côté crabe sur les dates que Bitstamp renvoie. Ces tests figent
// les deux moitiés de ce contrat, sur plusieurs fenêtres dont une antérieure à
// 2020 — si quelqu'un remet un jour une borne dans la requête, le premier test
// tombe en nommant la valeur fautive.

/**
 * Rejoue `fetchInvoices` contre un faux Bitstamp local qui signe ses réponses
 * comme le vrai (même chaîne nonce + horodatage + type + corps), et rend les
 * corps de requête REÇUS pour qu'on puisse jurer de ce qui est parti.
 */
async function rejouerFetch({ historique, operations }) {
  const corpsRecus = [];
  const vraiFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const corps = String(options?.body || '');
    corpsRecus.push({ url: String(url), corps });

    const chemin = new URL(String(url)).pathname;
    const texte = chemin.includes('user_transactions') ? JSON.stringify(operations) : '{}';
    const typeContenu = 'application/json';
    const signature = bitstamp.signatureAttendueDeLaReponse({
      secret: SECRET,
      nonce: options.headers['X-Auth-Nonce'],
      horodatage: options.headers['X-Auth-Timestamp'],
      typeContenu,
      corps: texte,
    });

    return {
      ok: true,
      status: 200,
      headers: {
        get: (nom) => {
          if (nom.toLowerCase() === 'content-type') return typeContenu;
          if (nom.toLowerCase() === 'x-server-auth-signature') return signature;
          return null;
        },
      },
      text: async () => texte,
    };
  };

  try {
    const invoices = await bitstamp.fetchInvoices(
      { apiKey: CLE, apiSecret: SECRET, historique },
      { log: () => {} }
    );
    return { corpsRecus, invoices };
  } finally {
    globalThis.fetch = vraiFetch;
  }
}

/** Trois opérations : 2019, janvier 2026, et une du mois courant. */
function operationsDEssai() {
  const maintenant = new Date();
  const moisCourant = maintenant.toISOString().slice(0, 7);
  return [
    { datetime: '2019-05-14 10:00:00', id: 1, type: '2', eur: '-100.00' },
    { datetime: '2026-01-15 09:30:00', id: 2, type: '2', eur: '-50.00' },
    { datetime: `${moisCourant}-01 08:00:00`, id: 3, type: '2', eur: '-25.00' },
  ];
}

test('aucune requête ne porte since_timestamp, quelle que soit la fenêtre', async () => {
  // Trois fenêtres : tout l'historique, une borne ANTÉRIEURE À 2020
  // (dernieres:15 → 1er janvier 2012), et l'année courante.
  for (const historique of ['tout', 'dernieres:15', 'courante']) {
    const { corpsRecus } = await rejouerFetch({ historique, operations: operationsDEssai() });
    assert.ok(corpsRecus.length >= 1, `${historique} : aucun appel n'est parti`);
    for (const { corps } of corpsRecus) {
      assert.equal(
        corps.includes('since_timestamp'),
        false,
        `${historique} : la requête porte encore une borne — « ${corps} » — que Bitstamp `
          + 'refuse (millisecondes, et de toute façon jamais plus de 30 jours)'
      );
    }
  }
});

test('la fenêtre s\'applique côté crabe : une borne de 2026 écarte 2019, « tout » le garde', async () => {
  // Fenêtre « année courante » : l'opération de 2019 et celle de janvier 2026
  // (si nous ne sommes plus en janvier) ne doivent produire aucun relevé de
  // leur mois. Le mois courant, lui, n'est pas révolu : aucun relevé non plus.
  const bornee = await rejouerFetch({ historique: 'courante', operations: operationsDEssai() });
  assert.equal(
    bornee.invoices.some((i) => i.filename.includes('2019')),
    false,
    'une opération de 2019 a produit un relevé malgré la fenêtre « année courante »'
  );

  // Fenêtre « tout » : 2019 est bien là — la preuve que l'antérieur à 2020
  // passe correctement quand la fenêtre le demande.
  const complete = await rejouerFetch({ historique: 'tout', operations: operationsDEssai() });
  assert.equal(
    complete.invoices.some((i) => i.filename.includes('2019-05')),
    true,
    'l\'opération de 2019 devait produire son relevé mensuel en fenêtre « tout »'
  );
});
