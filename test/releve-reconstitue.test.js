'use strict';

/**
 * Le gabarit du relevé reconstitué.
 *
 * Ce fichier ne vérifie pas qu'une fonction « ne plante pas » : il ouvre le
 * PDF produit et regarde ce qu'il y a dedans. C'est l'exigence du lot 19, et
 * elle est la bonne — le module a une seule promesse envers l'utilisateur, et
 * c'est une promesse écrite sur le papier :
 *
 *   « ceci n'est pas un document émis par [le service] »
 *
 * Un test qui se contenterait d'appeler `construire()` laisserait passer un
 * bandeau vidé par une faute d'encodage, un bandeau posé sur la seule première
 * page, ou un bandeau perdu à la sixième. On les cherche donc octet par octet,
 * page par page.
 *
 * Deux précautions contre le test complaisant :
 *
 *   - une des vérifications ne passe PAS par l'encodeur du module. Chercher la
 *     phrase avec le même code que celui qui l'a écrite prouverait seulement
 *     que le module est d'accord avec lui-même. Un fragment purement ASCII est
 *     donc cherché tel quel, sans intermédiaire ;
 *   - la structure du fichier est contrôlée pour de bon : chaque position de
 *     la table de références doit tomber sur l'objet qu'elle annonce, et
 *     chaque flux doit déclarer sa vraie longueur. Un document dont on veut
 *     qu'il fasse foi doit d'abord s'ouvrir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const releve = require('../server/connectors/releve-reconstitue');

const COLONNES = [
  { cle: 'datetime', titre: 'Date et heure' },
  { cle: 'type', titre: 'Type' },
  { cle: 'amount', titre: 'Montant' },
  { cle: 'currency', titre: 'Devise' },
  { cle: 'reference', titre: 'Référence' },
];

/** Des opérations plausibles, dans la forme où une API de place les rend. */
function operations(nombre) {
  return Array.from({ length: nombre }, (_, i) => ({
    datetime: `2026-0${1 + (i % 8)}-1${i % 9} 14:03:0${i % 9}`,
    type: ['deposit', 'withdrawal', 'market trade', 'fee'][i % 4],
    amount: (i * 3.7).toFixed(8),
    currency: ['EUR', 'BTC', 'USDT'][i % 3],
    reference: `op-${100000 + i}`,
  }));
}

function construire(options = {}) {
  return releve.construire({
    service: 'Bitstamp',
    compte: 'ku1234567',
    periode: { du: '2026-01-01', au: '2026-08-12' },
    genereLe: new Date('2026-08-12T20:15:00Z'),
    colonnes: COLONNES,
    operations: operations(40),
    ...options,
  });
}

/** Combien de fois une suite d'octets apparaît dans le document. */
function occurrences(pdf, motif) {
  const aiguille = Buffer.isBuffer(motif) ? motif : Buffer.from(motif, 'latin1');
  let compte = 0;
  let position = 0;
  for (;;) {
    position = pdf.indexOf(aiguille, position);
    if (position === -1) return compte;
    compte += 1;
    position += 1;
  }
}

/**
 * Les flux de contenu, un par page, dans l'ordre du document.
 *
 * Le découpage se fait sur la LONGUEUR DÉCLARÉE, pas en cherchant la fin du
 * flux. Chercher « stream » à l'aveugle a un piège qui coûte cher : le mot est
 * contenu dans « endstream », donc la recherche retombe sur la fin qu'elle
 * vient de dépasser et la boucle ne s'arrête jamais. Ce test l'a appris de la
 * mauvaise façon.
 */
function fluxDePage(pdf) {
  const brut = pdf.toString('latin1');
  return [...brut.matchAll(/<< \/Length (\d+) >>\nstream\n/g)].map((entree) => {
    const debut = entree.index + entree[0].length;
    return brut.slice(debut, debut + Number(entree[1]));
  });
}

// ---------------------------------------------------------------------------
// Le bandeau — la seule chose que ce module promet
// ---------------------------------------------------------------------------

test('le bandeau d\'avertissement est littéralement dans le PDF produit', () => {
  const pdf = construire();
  const phrase = releve.bandeau('Bitstamp');

  assert.equal(
    phrase,
    "Relevé reconstitué par crabe à partir de l'historique d'opérations "
      + '— ceci n\'est pas un document émis par Bitstamp.'
  );
  assert.ok(
    occurrences(pdf, releve.versWinAnsi(phrase)) >= 1,
    'la phrase d\'avertissement doit se retrouver telle quelle dans les octets du fichier'
  );
});

test('la preuve ne passe pas par l\'encodeur du module : un fragment ASCII est cherché tel quel', () => {
  const pdf = construire();
  // Aucun caractère accentué ici, donc aucune conversion possible : ces octets
  // sont ceux d'une lecture naïve du fichier, avec `grep` ou `strings`.
  assert.ok(pdf.includes(Buffer.from("ceci n'est pas un document", 'ascii')));
  assert.ok(pdf.includes(Buffer.from('Bitstamp', 'ascii')));
});

test('le bandeau est en tête de CHAQUE page, pas seulement de la première', () => {
  const pdf = construire({ operations: operations(400) });
  const flux = fluxDePage(pdf);
  const phrase = releve.versWinAnsi(releve.bandeau('Bitstamp'));

  assert.ok(flux.length >= 5, `le jeu d'essai doit déborder sur plusieurs pages (${flux.length})`);
  flux.forEach((contenu, index) => {
    assert.ok(
      contenu.includes(phrase),
      `page ${index + 1} sur ${flux.length} : le bandeau manque`
    );
    assert.ok(
      contenu.includes(releve.versWinAnsi(releve.BANDEAU_TITRE)),
      `page ${index + 1} : le titre du cadre manque`
    );
  });
  assert.equal(occurrences(pdf, phrase), flux.length);
});

test('un relevé sans aucune opération reste un document daté, avec son bandeau', () => {
  const pdf = construire({ operations: [] });
  const flux = fluxDePage(pdf);

  assert.equal(flux.length, 1);
  assert.ok(flux[0].includes(releve.versWinAnsi(releve.bandeau('Bitstamp'))));
  assert.ok(flux[0].includes(releve.versWinAnsi('Aucune opération sur la période couverte.')));
});

test('le nom du service voyage jusque dans le bandeau, quel qu\'il soit', () => {
  for (const service of ['PayPal', 'Bitstamp', 'Un Service Au Nom Particulièrement Long']) {
    const pdf = construire({ service, operations: operations(3) });
    assert.ok(
      pdf.includes(Buffer.from(releve.versWinAnsi(releve.bandeau(service)), 'latin1')),
      `bandeau introuvable pour « ${service} »`
    );
  }
});

// ---------------------------------------------------------------------------
// Ce que le document ne doit PAS être
// ---------------------------------------------------------------------------

test('le document n\'imite aucune facture : les mots du fournisseur n\'y sont pas', () => {
  const pdf = construire().toString('latin1').toLowerCase();
  for (const interdit of ['facture', 'invoice', 'reçu', 'duplicata', 'à payer', 'total ttc']) {
    assert.ok(
      !pdf.includes(releve.versWinAnsi(interdit)),
      `le relevé ne doit pas contenir « ${interdit} » : ce n'est pas un document du fournisseur`
    );
  }
});

test('aucun total n\'est calculé : le document ne fait qu\'énumérer', () => {
  const pdf = construire({
    operations: [
      { datetime: '2026-01-01', type: 'deposit', amount: '10.00', currency: 'EUR', reference: 'a' },
      { datetime: '2026-01-02', type: 'deposit', amount: '32.00', currency: 'EUR', reference: 'b' },
    ],
  }).toString('latin1');

  assert.ok(pdf.includes('10.00') && pdf.includes('32.00'));
  // 42,00 n'a jamais été communiqué par le service : il ne doit venir de nulle part.
  assert.ok(!pdf.includes('42.00'), 'le module a additionné deux montants');
  assert.ok(pdf.includes(releve.versWinAnsi("n'additionne rien")));
});

test('les valeurs sont recopiées telles quelles, sans reformatage', () => {
  const pdf = construire({
    operations: [{
      datetime: '2026-01-02T14:03:00.000Z',
      type: 'market trade',
      amount: '0.00010000',
      currency: 'BTC',
      reference: 'REF/2026-000123',
    }],
  }).toString('latin1');

  // Un montant à huit décimales reste à huit décimales : le passer par un
  // Number le ramènerait à « 0.0001 », et le relevé mentirait sur la précision
  // que la place a annoncée.
  assert.ok(pdf.includes('0.00010000'));
  assert.ok(pdf.includes('2026-01-02T14:03:00.000Z'));
  assert.ok(pdf.includes('REF/2026-000123'));
});

test('une valeur absente laisse une case vide, elle n\'invente rien', () => {
  const pdf = construire({
    operations: [{ datetime: '2026-01-02', type: null, amount: undefined, currency: 'EUR', reference: '' }],
  }).toString('latin1');

  for (const invente of ['null', 'undefined', 'NaN', 'inconnu']) {
    assert.ok(!pdf.includes(invente), `« ${invente} » ne doit pas apparaître dans le tableau`);
  }
});

// ---------------------------------------------------------------------------
// Le fichier doit s'ouvrir : structure, encodage, échappement
// ---------------------------------------------------------------------------

test('le PDF est structurellement valide : en-tête, fin, et table de références juste', () => {
  const pdf = construire({ operations: operations(200) });
  const brut = pdf.toString('latin1');

  assert.ok(brut.startsWith('%PDF-1.4\n'));
  assert.ok(brut.trimEnd().endsWith('%%EOF'));

  const depart = Number(brut.slice(brut.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
  assert.ok(brut.slice(depart, depart + 4) === 'xref', 'startxref ne pointe pas sur la table');

  // Chaque position annoncée doit tomber exactement sur « N 0 obj ».
  const table = brut.slice(depart).split('\n');
  const total = Number(table[1].split(' ')[1]);
  for (let numero = 1; numero < total; numero++) {
    const position = Number(table[1 + numero + 1].slice(0, 10));
    assert.ok(
      brut.startsWith(`${numero} 0 obj`, position),
      `objet ${numero} : la table annonce ${position}, où commence « ${brut.slice(position, position + 12)} »`
    );
  }
});

test('chaque flux déclare sa longueur réelle, accents compris', () => {
  const pdf = construire({
    // Un caractère hors du jeu de la police : s'il était compté sur deux
    // octets ici et écrit sur un seul là, toutes les positions du fichier
    // glisseraient et le document deviendrait illisible.
    operations: [{ datetime: '2026-01-02', type: '取引', amount: '1,00 €', currency: 'JPY', reference: 'été' }],
  });
  const brut = pdf.toString('latin1');

  const declarations = [...brut.matchAll(/<< \/Length (\d+) >>\nstream\n/g)];
  assert.ok(declarations.length >= 1);
  for (const declaration of declarations) {
    const debut = declaration.index + declaration[0].length;
    const fin = brut.indexOf('\nendstream', debut);
    assert.equal(fin - debut, Number(declaration[1]), 'longueur de flux déclarée à tort');
  }
});

test('une parenthèse ou un antislash dans une valeur ne casse pas le document', () => {
  const pdf = construire({
    operations: [{
      datetime: '2026-01-02', type: 'trade (partiel)', amount: '1.00',
      currency: 'EUR', reference: 'C:\\lot\\19 (essai)',
    }],
  });
  const brut = pdf.toString('latin1');

  assert.ok(brut.includes('trade \\(partiel\\)'), 'la parenthèse doit être échappée');
  assert.ok(brut.includes('C:\\\\lot\\\\19 \\(essai\\)'), 'l\'antislash doit être échappé');
  // Et le document reste équilibré : autant de flux ouverts que fermés.
  assert.equal(occurrences(pdf, '>>\nstream\n'), occurrences(pdf, '\nendstream\n'));
});

test('les accents et le tiret cadratin sortent en Windows-1252, pas en UTF-8', () => {
  assert.equal(releve.versWinAnsi('é').charCodeAt(0), 0xe9);
  assert.equal(releve.versWinAnsi('—').charCodeAt(0), 0x97);
  assert.equal(releve.versWinAnsi('œ').charCodeAt(0), 0x9c);
  assert.equal(releve.versWinAnsi("'").charCodeAt(0), 0x27);
  // Hors du jeu : remplacé, jamais laissé passer sur deux octets.
  assert.equal(releve.versWinAnsi('取'), '?');
  assert.equal(releve.versWinAnsi('日本').length, 2);
});

test('le titre du document, lui, s\'écrit en UTF-16 : ce n\'est pas le même encodage', () => {
  const brut = construire().toString('latin1');
  // Une métadonnée suit « PDFDocEncoding », où 0x97 n'est pas le tiret
  // cadratin. Écrite comme le contenu des pages, elle s'afficherait de travers
  // dans la barre du lecteur — d'où la chaîne hexadécimale à marque d'ordre.
  const titre = brut.match(/\/Title (<[0-9A-F]+>|\([^)]*\))/);
  assert.ok(titre, 'le document doit porter un titre');
  assert.ok(titre[1].startsWith('<FEFF'), `titre écrit sans marque d'ordre : ${titre[1]}`);
  const points = titre[1].slice(5, -1).match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16)));
  assert.equal(points.join(''), 'Relevé reconstitué — Bitstamp');
});

// ---------------------------------------------------------------------------
// Mise en page : ce qui se lit encore quand le tableau déborde
// ---------------------------------------------------------------------------

test('une opération n\'est jamais coupée par un saut de page', () => {
  // Chaque opération porte une référence trop longue pour sa colonne : elle
  // occupe donc DEUX lignes, un début et une fin reconnaissables. Si un saut de
  // page tombait entre les deux, une page montrerait un début sans sa fin.
  //
  // Les repères sont numérotés sur trois chiffres, et c'est nécessaire : avec
  // « D1 », la recherche trouverait aussi « D10 » et « D119 », et le test
  // passerait pour de mauvaises raisons.
  const jeu = Array.from({ length: 120 }, (_, i) => {
    const rang = String(i).padStart(3, '0');
    return {
      datetime: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`,
      type: 'trade',
      amount: '1.00',
      currency: 'EUR',
      reference: `D${rang} ${'x'.repeat(90)} F${rang}`,
    };
  });
  const colonnes = [...COLONNES.slice(0, 4), { cle: 'reference', titre: 'Réf' }];
  const pdf = construire({ operations: jeu, colonnes });
  const flux = fluxDePage(pdf);

  assert.ok(flux.length >= 2, 'le jeu d\'essai doit tenir sur plusieurs pages');
  // Le montage n'a de sens que si la référence déborde vraiment : sans cela,
  // le test ne vérifierait plus rien.
  const largeurs = releve.largeursColonnes(colonnes, jeu);
  assert.ok(
    releve.lignesOperation(jeu[0], colonnes, largeurs).length >= 2,
    'la référence doit tenir sur au moins deux lignes pour que ce test ait un sens'
  );

  for (const [index, contenu] of flux.entries()) {
    for (let i = 0; i < jeu.length; i++) {
      const rang = String(i).padStart(3, '0');
      assert.equal(
        contenu.includes(`D${rang} `),
        contenu.includes(` F${rang}`),
        `page ${index + 1} : l'opération ${i} est à cheval sur deux pages`
      );
    }
  }
});

test('une valeur trop longue passe à la ligne : rien n\'est perdu', () => {
  const morceaux = releve.couper('reference-tres-longue-qui-deborde-de-sa-colonne', 12);
  assert.ok(morceaux.length > 1);
  assert.equal(morceaux.join(''), 'reference-tres-longue-qui-deborde-de-sa-colonne');
  for (const morceau of morceaux) assert.ok(morceau.length <= 12);
});

test('la coupe préfère une espace quand il y en a une', () => {
  assert.deepEqual(releve.couper('paiement de service', 12), ['paiement de', 'service']);
});

test('les colonnes sont dimensionnées sur le contenu réel, et la ligne ne déborde jamais', () => {
  const jeu = [{ a: 'x'.repeat(200), b: 'court', c: 'moyen' }];
  const colonnes = [{ cle: 'a', titre: 'A' }, { cle: 'b', titre: 'B' }, { cle: 'c', titre: 'C' }];
  const largeurs = releve.largeursColonnes(colonnes, jeu);

  const total = largeurs.reduce((s, l) => s + l, 0) + 2 * (colonnes.length - 1);
  assert.ok(total <= releve.budgetCaracteres(), `ligne de ${total} caractères, budget dépassé`);
  for (const ligne of releve.lignesOperation(jeu[0], colonnes, largeurs)) {
    assert.ok(ligne.length <= releve.budgetCaracteres(), `ligne trop longue : ${ligne.length}`);
  }
});

test('un titre de colonne plus large que ses valeurs reste lisible en entier', () => {
  const colonnes = [{ cle: 'a', titre: 'Date et heure de l\'opération' }];
  const largeurs = releve.largeursColonnes(colonnes, [{ a: 'x' }]);
  assert.equal(largeurs[0], 'Date et heure de l\'opération'.length);
});

// ---------------------------------------------------------------------------
// Le fichier déposé
// ---------------------------------------------------------------------------

test('le nom du fichier dit ce qu\'il est, avant même qu\'on l\'ouvre', () => {
  assert.equal(
    releve.nomFichier({ service: 'Bitstamp', du: '2026-01-01', au: '2026-08-12' }),
    'bitstamp_releve-reconstitue_2026-01-01_2026-08-12.pdf'
  );
  // Un accent ou une espace dans le nom du service ne doit pas se retrouver
  // dans un nom de fichier : il traversera des partages réseau et des
  // synchronisations qui n'en veulent pas.
  assert.equal(
    releve.nomFichier({ service: 'Société Générale', du: '2026-01-01', au: '2026-01-31' }),
    'societe-generale_releve-reconstitue_2026-01-01_2026-01-31.pdf'
  );
  // Une borne absente se dit en toutes lettres, pas avec la ponctuation du
  // document : un nom de fichier se retape à la main.
  assert.equal(
    releve.nomFichier({ service: 'PayPal', du: null, au: '2026-01-31' }),
    'paypal_releve-reconstitue_debut_2026-01-31.pdf'
  );
});

test('un relevé sans service ou sans colonnes est refusé, et dit pourquoi', () => {
  assert.throws(() => releve.construire({ colonnes: COLONNES }), /nommer le service/);
  assert.throws(() => releve.construire({ service: 'Bitstamp' }), /colonnes/);
  assert.throws(() => releve.construire({ service: 'Bitstamp', colonnes: [] }), /colonnes/);
});

test('deux exécutions du même relevé rendent le même document', () => {
  // Sans date de génération figée, deux appels différeraient d'une seconde et
  // le document déposé changerait à chaque exécution — de quoi faire croire à
  // un nouveau relevé à chaque passage du planificateur.
  const premier = construire();
  const second = construire();
  assert.ok(premier.equals(second));
});
