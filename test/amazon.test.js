'use strict';

/**
 * Le connecteur Amazon, et le réglage d'historique qui l'accompagne.
 *
 * Ce fichier vérifie ce qui se vérifie sans navigateur — c'est-à-dire tout ce
 * qui a coûté cher à découvrir contre le compte réel, le 10/08/2026 :
 *
 *   1. **la déduplication porte sur le numéro de commande et le rang**, jamais
 *      sur l'UUID du PDF. C'est LE piège du connecteur : Amazon régénère cet
 *      identifiant à chaque ouverture du menu, et la même facture portait
 *      `e493a771…` puis `797ae21f…` à quelques minutes d'intervalle. Une
 *      déduplication fondée dessus retéléchargerait tout, à chaque exécution ;
 *   2. **le rattachement d'un document à sa commande se fait par différence**
 *      avant / après ouverture du menu. Le menu est flottant, hors de la carte
 *      dans le DOM : remonter l'arbre ne relie rien, toutes les tentatives ont
 *      échoué ;
 *   3. **« Récapitulatif de commande imprimable » n'est pas une facture** ;
 *   4. **les années à parcourir** selon le mode d'historique — le rattrapage
 *      complet ne doit pas se répéter à chaque exécution ;
 *   5. **la détection d'une limitation d'accès** : une page qui se charge sans
 *      commande n'est pas une année vide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const amazon = require('../server/connectors/available/amazon/connector');
const history = require('../server/connectors/history');

// ---------------------------------------------------------------------------
// Repérer les commandes et leurs documents
// ---------------------------------------------------------------------------

test('le numéro de commande se lit quelle que soit la casse du libellé', () => {
  // Dans le DOM il est en minuscules ; à l'écran en capitales, par la feuille
  // de style. Chercher la version majuscule ne trouvait rien.
  for (const texte of [
    'N° de commande : 406-0000000-0000000',
    'N° DE COMMANDE : 406-0000000-0000000',
    'n° de commande 406-0000000-0000000',
    'Livré le 16 juillet · N° de commande : 406-0000000-0000000 · Total 106,52 €',
  ]) {
    assert.equal(amazon.numeroCommande(texte), '406-0000000-0000000', texte);
  }

  assert.equal(amazon.numeroCommande('aucune commande ici'), null);
  assert.equal(amazon.numeroCommande(''), null);
});

test('« Récapitulatif de commande imprimable » n\'est pas une facture', () => {
  assert.deepEqual(amazon.typeDocument('Récapitulatif de commande imprimable'), {
    type: 'ignore', rang: null,
  });
  assert.deepEqual(amazon.typeDocument('Recapitulatif de commande imprimable'), {
    type: 'ignore', rang: null,
  });

  assert.deepEqual(amazon.typeDocument('Facture'), { type: 'facture', rang: null });
  assert.deepEqual(amazon.typeDocument('Facture 1'), { type: 'facture', rang: 1 });
  assert.deepEqual(amazon.typeDocument('Facture 2'), { type: 'facture', rang: 2 });
  assert.deepEqual(amazon.typeDocument('Note de crédit'), { type: 'avoir', rang: null });

  // Un libellé inconnu ne devient pas une facture par défaut.
  assert.equal(amazon.typeDocument('Demander une facture').type, 'ignore');
  assert.equal(amazon.typeDocument('').type, 'ignore');
});

test('les documents d\'une commande sont classés, rangés et nommés', () => {
  const docs = amazon.classerDocuments([
    { libelle: 'Facture 1', href: 'https://www.amazon.fr/documents/download/aaa/invoice.pdf' },
    { libelle: 'Facture 2', href: 'https://www.amazon.fr/documents/download/bbb/invoice.pdf' },
    { libelle: 'Note de crédit', href: 'https://www.amazon.fr/documents/download/ccc/invoice.pdf' },
    { libelle: 'Récapitulatif de commande imprimable', href: 'https://www.amazon.fr/gp/css/summary' },
  ]);

  assert.equal(docs.length, 3, 'le récapitulatif est écarté');
  assert.deepEqual(docs.map((d) => d.type), ['facture', 'facture', 'avoir']);
  assert.deepEqual(docs.map((d) => d.suffixe), ['1', '2', 'avoir']);

  const numero = '406-0000000-0000000';
  assert.deepEqual(
    docs.map((d) => amazon.remoteIdPour(numero, d)),
    [`${numero}#1`, `${numero}#2`, `${numero}#avoir`]
  );
  assert.deepEqual(
    docs.map((d) => amazon.nomFichier('2026-07', numero, d)),
    [
      `2026-07_${numero}_1.pdf`,
      `2026-07_${numero}_2.pdf`,
      `2026-07_${numero}_avoir.pdf`,
    ]
  );
});

test('une commande à facture unique donne un nom sans numéro d\'ordre', () => {
  const [doc] = amazon.classerDocuments([
    { libelle: 'Facture', href: 'https://www.amazon.fr/documents/download/aaa/invoice.pdf' },
  ]);
  const numero = '405-1234567-1234567';

  assert.equal(doc.plusieurs, false);
  assert.equal(amazon.nomFichier('2026-03', numero, doc), `2026-03_${numero}.pdf`);
  // Le remoteId, lui, porte TOUJOURS son rang : c'est ce qui le rend comparable
  // le jour où une seconde facture apparaît sur la même commande.
  assert.equal(amazon.remoteIdPour(numero, doc), `${numero}#1`);
});

test('sans période lisible, le fichier le dit au lieu d\'inventer une date', () => {
  const [doc] = amazon.classerDocuments([{ libelle: 'Facture', href: 'x' }]);
  assert.equal(amazon.nomFichier(null, '405-1-1', doc), 'inconnu_405-1-1.pdf');
});

// ---------------------------------------------------------------------------
// Déduplication — le piège majeur
// ---------------------------------------------------------------------------

test('la référence d\'un document ne dépend JAMAIS de l\'UUID du PDF', () => {
  // Le fait constaté : la même facture, à quelques minutes d'intervalle.
  const numero = '406-0000000-0000000';
  const premier = amazon.classerDocuments([
    { libelle: 'Facture 1', href: `https://www.amazon.fr/documents/download/e493a771-1111-2222-3333-444455556666/invoice.pdf` },
    { libelle: 'Facture 2', href: `https://www.amazon.fr/documents/download/aaaaaaaa-1111-2222-3333-444455556666/invoice.pdf` },
  ]);
  const second = amazon.classerDocuments([
    { libelle: 'Facture 1', href: `https://www.amazon.fr/documents/download/797ae21f-9999-8888-7777-666655554444/invoice.pdf` },
    { libelle: 'Facture 2', href: `https://www.amazon.fr/documents/download/bbbbbbbb-9999-8888-7777-666655554444/invoice.pdf` },
  ]);

  assert.notDeepEqual(
    premier.map((d) => d.href),
    second.map((d) => d.href),
    'les UUID doivent bien différer, sinon ce test ne prouve rien'
  );
  assert.deepEqual(
    premier.map((d) => amazon.remoteIdPour(numero, d)),
    second.map((d) => amazon.remoteIdPour(numero, d)),
    'la même facture doit porter la même référence d\'une exécution à l\'autre'
  );

  // Et la conséquence, celle qui compte : rien n'est retéléchargé.
  const connus = new Set(premier.map((d) => amazon.remoteIdPour(numero, d)));
  assert.deepEqual(
    second.filter((d) => !connus.has(amazon.remoteIdPour(numero, d))),
    [],
    'une seconde exécution ne doit rien avoir à reprendre'
  );
});

test('deux commandes différentes ne partagent jamais une référence', () => {
  const [doc] = amazon.classerDocuments([{ libelle: 'Facture', href: 'x' }]);
  assert.notEqual(
    amazon.remoteIdPour('406-0000000-0000000', doc),
    amazon.remoteIdPour('405-1234567-1234567', doc)
  );
});

// ---------------------------------------------------------------------------
// Rattachement par différence avant / après
// ---------------------------------------------------------------------------

test('les documents d\'une commande sont ceux qui n\'étaient pas là avant', () => {
  // Le menu est flottant, hors de la carte : c'est la seule méthode qui marche.
  const avant = [
    { href: 'https://www.amazon.fr/documents/download/deja-1/invoice.pdf', libelle: 'Facture' },
  ];
  const apres = [
    { href: 'https://www.amazon.fr/documents/download/deja-1/invoice.pdf', libelle: 'Facture' },
    { href: 'https://www.amazon.fr/documents/download/neuf-1/invoice.pdf', libelle: 'Facture 1' },
    { href: 'https://www.amazon.fr/documents/download/neuf-2/invoice.pdf', libelle: 'Facture 2' },
  ];

  const nouveaux = amazon.nouveauxLiens(avant, apres);
  assert.deepEqual(nouveaux.map((l) => l.libelle), ['Facture 1', 'Facture 2']);
});

test('un menu qui ne s\'ouvre pas ne vole pas les documents du voisin', () => {
  const liens = [
    { href: 'https://www.amazon.fr/documents/download/a/invoice.pdf', libelle: 'Facture' },
  ];
  // Rien de neuf entre les deux photographies : la commande n'a aucun document,
  // et surtout pas ceux de la commande précédente restés à l'écran.
  assert.deepEqual(amazon.nouveauxLiens(liens, liens), []);
});

test('un même lien rendu deux fois ne compte qu\'une', () => {
  const apres = [
    { href: 'https://www.amazon.fr/documents/download/x/invoice.pdf', libelle: 'Facture' },
    { href: 'https://www.amazon.fr/documents/download/x/invoice.pdf', libelle: 'Facture' },
  ];
  assert.equal(amazon.nouveauxLiens([], apres).length, 1);
});

// ---------------------------------------------------------------------------
// Les années, les pages, les dates
// ---------------------------------------------------------------------------

test('les années viennent du sélecteur, dédoublonnées, et jamais du code', () => {
  // Le sélecteur apparaît parfois en double dans le document.
  const options = [
    { valeur: 'year-2026', texte: 'en 2026' },
    { valeur: 'year-2025', texte: 'en 2025' },
    { valeur: 'months-3', texte: '3 derniers mois' },
    { valeur: 'year-2026', texte: 'en 2026' },
    { valeur: 'year-2012', texte: 'en 2012' },
  ];

  const annees = amazon.anneesDepuisOptions(options);
  assert.deepEqual(annees.map((a) => a.annee), [2026, 2025, 2012], 'décroissant et sans doublon');
  assert.equal(annees[0].filtre, 'year-2026');

  // Une option sans valeur exploitable retombe sur la convention d'Amazon.
  const sansValeur = amazon.anneesDepuisOptions([{ texte: 'en 2019' }]);
  assert.deepEqual(sansValeur, [{ annee: 2019, filtre: 'year-2019' }]);

  assert.deepEqual(amazon.anneesDepuisOptions([]), []);
  assert.deepEqual(amazon.anneesDepuisOptions(null), []);
});

test('la pagination suit dix commandes par page', () => {
  assert.equal(
    amazon.urlPage('year-2026', 0),
    'https://www.amazon.fr/your-orders/orders?timeFilter=year-2026&startIndex=0'
  );
  assert.equal(
    amazon.urlPage('year-2026', 3),
    'https://www.amazon.fr/your-orders/orders?timeFilter=year-2026&startIndex=30'
  );
  assert.equal(amazon.PAR_PAGE, 10);
});

test('la période se lit sur la date de commande, et sur une date isolée à défaut', () => {
  assert.equal(
    amazon.periodeDepuisTexte('Commande effectuée le 14 juillet 2026'),
    '2026-07'
  );
  assert.equal(amazon.periodeDepuisTexte('14 juillet 2026'), '2026-07');
  assert.equal(amazon.periodeDepuisTexte('3 décembre 2025'), '2025-12');
  assert.equal(amazon.periodeDepuisTexte('1 août 2024'), '2024-08');

  // Une carte porte plusieurs dates : c'est celle de la COMMANDE qui date la
  // facture, pas la date de retour possible.
  assert.equal(
    amazon.periodeDepuisTexte(
      'Retours acceptés jusqu\'au 2 septembre 2026 · Commande effectuée le 14 juillet 2026'
    ),
    '2026-07'
  );
  assert.equal(amazon.periodeDepuisTexte('aucune date ici'), null);
});

test('le montant retenu est le total de la commande, pas le prix d\'un article', () => {
  assert.equal(amazon.montantDepuisTexte('Total : 106,52 €'), 106.52);
  assert.equal(amazon.montantDepuisTexte('TOTAL DE LA COMMANDE 1 240,00 €'), 1240);
  // Un prix d'article ne doit pas être pris pour le total.
  assert.equal(amazon.montantDepuisTexte('Brosse à dents 4,99 €'), null);
  assert.equal(amazon.montantDepuisTexte('rien'), null);
});

test('l\'adresse du compte est lue si elle est lisible, sinon « compte »', () => {
  assert.equal(
    amazon.compteDepuisTexte('Bonjour Camille · camille.dupont@exemple.fr'),
    'camille.dupont@exemple.fr'
  );
  assert.equal(amazon.compteDepuisTexte('Bonjour Camille'), 'compte');
  assert.equal(amazon.compteDepuisTexte(''), amazon.COMPTE_PAR_DEFAUT);
});

// ---------------------------------------------------------------------------
// Se faire refuser : session tombée, vérification anti-robot
// ---------------------------------------------------------------------------

test('seul le chemin dit qu\'on est retombé sur la page de connexion', () => {
  assert.equal(amazon.estPageAuthentification('https://www.amazon.fr/ap/signin'), true);
  assert.equal(amazon.estPageAuthentification('https://www.amazon.fr/ap/mfa'), true);
  // Un paramètre qui parle de connexion sur une page de commandes est normal.
  assert.equal(
    amazon.estPageAuthentification('https://www.amazon.fr/your-orders/orders?ref=nav_signin'),
    false
  );
  assert.equal(amazon.estPageAuthentification('pas une url'), false);
});

test('une vérification anti-robot est reconnue, et le message dit quoi faire', () => {
  assert.equal(
    amazon.estVerificationRobot({ url: 'https://www.amazon.fr/errors/validateCaptcha' }),
    true
  );
  assert.equal(
    amazon.estVerificationRobot({
      url: 'https://www.amazon.fr/your-orders/orders',
      texte: 'Saisissez les caractères que vous voyez ci-dessous',
    }),
    true
  );
  assert.equal(
    amazon.estVerificationRobot({
      url: 'https://www.amazon.fr/your-orders/orders',
      texte: 'Commande effectuée le 14 juillet 2026',
    }),
    false
  );

  const err = amazon.erreurVerification();
  assert.equal(err.rateLimited, true, 'le socle doit pouvoir arrêter net');
  assert.equal(err.message, 'Amazon demande une vérification. Réessayez dans quelques heures.');
});

test('la connexion expirée dit quoi faire, et prévient de la session unique', () => {
  const err = amazon.erreurSessionExpiree('redirection vers la page de connexion');
  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Se connecter à Amazon/);
  assert.match(err.message, /une connexion à la fois/);
  assert.equal(err.message.includes('capture-session'), false, 'aucune ligne de commande');
});

test('la pause entre deux pages ne descend jamais sous cinq secondes', (t) => {
  const avant = process.env.CRABE_AMAZON_PAUSE_MS;
  t.after(() => {
    if (avant === undefined) delete process.env.CRABE_AMAZON_PAUSE_MS;
    else process.env.CRABE_AMAZON_PAUSE_MS = avant;
  });

  delete process.env.CRABE_AMAZON_PAUSE_MS;
  assert.equal(amazon.pauseEntrePages(), 5000, 'le défaut');

  process.env.CRABE_AMAZON_PAUSE_MS = '12000';
  assert.equal(amazon.pauseEntrePages(), 12_000, 'on peut ralentir');

  // Le plancher : un réglage distrait ne doit pas faire bannir le compte.
  process.env.CRABE_AMAZON_PAUSE_MS = '200';
  assert.equal(amazon.pauseEntrePages(), 5000);
  process.env.CRABE_AMAZON_PAUSE_MS = 'n importe quoi';
  assert.equal(amazon.pauseEntrePages(), 5000);
});

// ---------------------------------------------------------------------------
// Le silence anormal
// ---------------------------------------------------------------------------

test('une page sans commande sur un compte déjà servi est une limitation, pas un vide', () => {
  // Le cas observé : trois parcours complets en peu de temps, puis une page qui
  // se charge normalement mais sans aucune commande, en 38 s au lieu de 123.
  const alerte = amazon.silenceAnormal({
    commandesVues: 0,
    anneesParcourues: 1,
    dejaConnues: 18,
  });
  assert.ok(alerte, 'le cas doit être signalé');
  assert.match(alerte, /limitation/i);
  assert.match(alerte, /quelques heures/);
  // Et il ne conclut surtout PAS que le compte est vide : c'est le contresens
  // que le lot demande d'éviter.
  assert.match(alerte, /pas d'un compte vide/);
});

test('trois années muettes de suite sont suspectes, même sans historique', () => {
  assert.ok(amazon.silenceAnormal({ commandesVues: 0, anneesParcourues: 3, dejaConnues: 0 }));
  // Une ou deux années vides sur un compte neuf, c'est parfaitement plausible.
  assert.equal(amazon.silenceAnormal({ commandesVues: 0, anneesParcourues: 2, dejaConnues: 0 }), null);
});

test('un parcours qui trouve des commandes ne déclenche aucune alerte', () => {
  assert.equal(
    amazon.silenceAnormal({ commandesVues: 12, anneesParcourues: 1, dejaConnues: 18 }),
    null
  );
  assert.equal(amazon.silenceAnormal({ commandesVues: 0, anneesParcourues: 0 }), null);
  assert.equal(amazon.silenceAnormal(), null);
});

// ---------------------------------------------------------------------------
// Profondeur d'historique — le réglage générique
// ---------------------------------------------------------------------------

/** Les quinze années du compte réel, telles que le sélecteur les expose. */
const QUINZE = Array.from({ length: 15 }, (_, i) => 2026 - i);

test('une valeur d\'historique abîmée retombe sur le défaut, jamais sur une erreur', () => {
  assert.deepEqual(history.parse('depuis'), { mode: 'depuis', annees: 2 });
  assert.deepEqual(history.parse('dernieres:5'), { mode: 'dernieres', annees: 5 });
  assert.deepEqual(history.parse('n\'importe quoi'), { mode: 'depuis', annees: 2 });
  assert.deepEqual(history.parse(null), { mode: 'depuis', annees: 2 });
  // Les bornes du sélecteur sont tenues côté serveur, pas seulement à l'écran.
  assert.equal(history.parse('dernieres:0').annees, 1);
  assert.equal(history.parse('dernieres:900').annees, 15);

  assert.equal(history.format('dernieres:3'), 'dernieres:3');
  assert.equal(history.format({ mode: 'dernieres', annees: 3 }), 'dernieres:3');
  assert.equal(history.format('tout'), 'tout');
  assert.equal(history.format('bidon'), 'depuis');
});

test('« toutes les années » les prend toutes, « les N dernières » en prend N', () => {
  const tout = history.anneesAParcourir({ valeur: 'tout', disponibles: QUINZE });
  assert.equal(tout.annees.length, 15);
  assert.equal(tout.annees[0], 2026, 'de la plus récente à la plus ancienne');
  assert.equal(tout.annees[14], 2012);

  const deux = history.anneesAParcourir({ valeur: 'dernieres:2', disponibles: QUINZE });
  assert.deepEqual(deux.annees, [2026, 2025]);
});

test('« année en cours » ne parcourt que celle-là', () => {
  const courante = history.anneesAParcourir({
    valeur: 'courante',
    disponibles: QUINZE,
    maintenant: new Date('2026-08-10T12:00:00Z'),
  });
  assert.deepEqual(courante.annees, [2026]);

  // Et si le site ne propose pas l'année en cours, on ne l'invente pas.
  const absente = history.anneesAParcourir({
    valeur: 'courante',
    disponibles: [2024, 2023],
    maintenant: new Date('2026-08-10T12:00:00Z'),
  });
  assert.deepEqual(absente.annees, []);
  assert.match(absente.raison, /n'est pas proposée/);
});

test('« depuis la dernière récupération » rattrape tout au premier passage', () => {
  const premier = history.anneesAParcourir({
    valeur: 'depuis',
    disponibles: QUINZE,
    maintenant: new Date('2026-08-10T12:00:00Z'),
    dejaRecupere: false,
  });
  assert.equal(premier.annees.length, 15, 'le premier passage va chercher le passé');
  assert.match(premier.raison, /premier passage/);
});

test('« depuis la dernière récupération » ne suit ensuite que l\'année en cours', () => {
  const ensuite = history.anneesAParcourir({
    valeur: 'depuis',
    disponibles: QUINZE,
    maintenant: new Date('2026-08-10T12:00:00Z'),
    dejaRecupere: true,
  });
  assert.deepEqual(ensuite.annees, [2026], 'un rattrapage complet ne se répète pas');
});

test('de janvier à mars, l\'année précédente reste parcourue', () => {
  // Une facture de décembre est souvent émise en janvier : s'arrêter au 1er
  // janvier la manquerait pour toujours.
  for (const mois of ['01', '02', '03']) {
    const plan = history.anneesAParcourir({
      valeur: 'depuis',
      disponibles: QUINZE,
      maintenant: new Date(`2026-${mois}-15T12:00:00Z`),
      dejaRecupere: true,
    });
    assert.deepEqual(plan.annees, [2026, 2025], `en ${mois}, l'année précédente compte encore`);
    assert.match(plan.raison, /décembre/);
  }

  const avril = history.anneesAParcourir({
    valeur: 'depuis',
    disponibles: QUINZE,
    maintenant: new Date('2026-04-01T12:00:00Z'),
    dejaRecupere: true,
  });
  assert.deepEqual(avril.annees, [2026], 'en avril, le recouvrement est terminé');
});

test('un site qui n\'expose aucune année ne fait échouer personne', () => {
  const plan = history.anneesAParcourir({ valeur: 'tout', disponibles: [] });
  assert.deepEqual(plan.annees, []);
  assert.match(plan.raison, /aucune année/);
});

test('les années du site sont dédoublonnées et remises dans l\'ordre', () => {
  const plan = history.anneesAParcourir({
    valeur: 'dernieres:3',
    disponibles: ['2024', 2026, '2026', 2025, 2023],
  });
  assert.deepEqual(plan.annees, [2026, 2025, 2024]);
});
