'use strict';

/**
 * Lot 74 — Atma reconstitue un reçu par commande.
 *
 * Le fait qui fonde ces tests a été MESURÉ le 09/09/2026 sur la session
 * réelle : ni la liste des commandes ni le détail ne proposent de facture,
 * de reçu ni de téléchargement. Ce que ces tests protègent :
 *
 *   1. la lecture des pages suit les formes mesurées (h2[id^="order-"],
 *      lien /account/orders/<id>, « Confirmée le <date française abrégée> »,
 *      résumé borné avant « Détails de la commande ») ;
 *   2. chaque reçu produit porte le bandeau de la nature « recu » — jamais un
 *      document reconstitué sans sa mention — et NE porte PAS l'adresse ni le
 *      contact de la section écartée ;
 *   3. l'ancre est le numéro de commande : une commande déjà reconstituée
 *      n'est ni ROUVERTE ni reproduite (l'idempotence se voit au trafic) ;
 *   4. une page illisible ne produit AUCUN reçu partiel — l'ancre reste
 *      libre, le passage suivant réessaie ;
 *   5. la carte dit toujours le fait (« ne fournit pas de facture ») par le
 *      champ `precision`.
 *
 * ⚠ Toutes les valeurs (numéros, dates, articles, montants, adresses) sont
 * INVENTÉES — rien ne vient du compte réel (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const profilMarchand = require('../server/connectors/profil-marchand');
const releve = require('../server/connectors/releve-reconstitue');
const { normalizeFrenchDate } = require('../server/connectors/scraping');
const atma = require('../server/connectors/available/atma/connector');

// ---------------------------------------------------------------------------
// Fausse page multi-écrans (recette de lot72-ebauches-uber-atma.test.js,
// étendue : les extractions du lot 74 s'appellent avec un marqueur
// `{ extraction: 'liste' | 'detail' }`, la fausse page les sert depuis
// l'écran courant — et le TRAFIC est enregistré, c'est lui qui prouve
// l'idempotence)
// ---------------------------------------------------------------------------

function fakePage(ecrans, gotos) {
  let courant = ecrans[0];
  return {
    url: () => courant.url,
    goto: async (url) => {
      gotos.push(String(url));
      courant = ecrans.find((e) => String(url).startsWith(e.cle || e.url)) || courant;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object' && arg.extraction === 'liste') return courant.liste || [];
      if (arg && typeof arg === 'object' && arg.extraction === 'detail') return { titres: [], texte: courant.texte || '' };
      // fermerBandeauCookies / estMurAntiRobot n'ont pas d'argument.
      if (arg === undefined) return false;
      // chercherMarqueursMesures passe {sel, motif} et attend un booléen.
      if (arg && typeof arg === 'object' && 'sel' in arg && 'motif' in arg) return false;
      // photographier passe {motif, selecteur} et attend la vue.
      return courant.vue;
    },
    locator: () => ({ count: async () => 0 }),
  };
}

async function surProfilSimule(ecrans, gotos, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(fakePage(ecrans, gotos), {});
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

function contexteEnregistreur(knownRemoteIds = []) {
  const journal = [];
  const preuves = [];
  return {
    ctx: {
      userId: 1,
      knownRemoteIds,
      log: (m) => journal.push(String(m)),
      preuveDeListe: (info) => preuves.push(info),
    },
    journal,
    preuves,
  };
}

// ── Les écrans inventés ─────────────────────────────────────────────────────

const BOUTIQUE = 'https://shopify.com/11112222';
const URL_LISTE = `${BOUTIQUE}/account/orders`;

const DETAIL_12345 = [
  'Passer au contenu', 'Commandes', 'Profil',
  'Commande #12345',
  'Confirmée le 3 févr. 2026',
  'Acheter à nouveau', 'Retourner ma commande',
  'Statut du traitement de la commande : Livrée',
  'Résumé de la commande',
  'Articles de la commande',
  'Quantité 1',
  'La Poêle en acier - 24 cm',
  '89,00 €',
  'Totaux de la commande',
  'Sous-total 89,00 €',
  'Expédition 5,00 €',
  'Total EUR 94,00 €',
  'Taxes de 15,67 € incluses',
  'Détails de la commande',
  'Contact camille@exemple.test',
  'Expédier à Camille Exemple',
  '12 rue Imaginaire, 00000 Villexemple',
].join('\n');

const DETAIL_67890 = [
  'Commande #67890',
  'Confirmée le 18 juil. 2026',
  'Statut du traitement de la commande : Livrée',
  'Articles de la commande',
  'Quantité 2',
  'Le Torchon brodé',
  '24,00 €',
  'Totaux de la commande',
  'Total EUR 24,00 €',
  'Détails de la commande',
  'Expédier à Camille Exemple',
].join('\n');

function ecransComplets() {
  return [
    {
      url: `${URL_LISTE}?locale=fr`,
      cle: atma.URL_COMPTE,
      vue: { url: `${URL_LISTE}?locale=fr`, boutonSeConnecter: false, reperes: 2, libelles: [] },
      liste: [
        { titre: 'Commande #12345', href: '/11112222/account/orders/98765001?region_country=FR' },
        { titre: 'Commande #67890', href: '/11112222/account/orders/98765002?region_country=FR' },
      ],
    },
    { url: `${URL_LISTE}/98765001`, cle: `${URL_LISTE}/98765001`, texte: DETAIL_12345 },
    { url: `${URL_LISTE}/98765002`, cle: `${URL_LISTE}/98765002`, texte: DETAIL_67890 },
  ];
}

// ---------------------------------------------------------------------------
// 1. Les analyses pures suivent les formes mesurées
// ---------------------------------------------------------------------------

test('analyserDetail lit le numéro, la date, le statut, et borne le résumé avant l\'adresse', () => {
  const detail = atma.analyserDetail(DETAIL_12345);
  assert.equal(detail.numero, '12345');
  assert.equal(detail.confirmee, '3 févr. 2026');
  assert.equal(detail.statut, 'Livrée');
  assert.deepEqual(detail.lignes.slice(0, 3), ['Quantité 1', 'La Poêle en acier - 24 cm', '89,00 €']);
  assert.ok(detail.lignes.includes('Taxes de 15,67 € incluses'), 'les totaux affichés sont recopiés');
  assert.equal(detail.lignes.some((l) => /Camille|Villexemple|@exemple/.test(l)), false,
    'la section « Détails de la commande » (adresse, contact) n\'est PAS reprise');
});

test('les dates françaises ABRÉGÉES sont comprises — c\'est la forme de l\'espace client Shopify', () => {
  // Avant le lot 74, normalizeFrenchDate ne connaissait que les mois en toutes
  // lettres : « 3 févr. 2026 » rendait null, et aucun reçu n'aurait pu être
  // daté. La réintroduction du défaut est ce null.
  assert.equal(normalizeFrenchDate('3 févr. 2026'), '2026-02-03');
  assert.equal(normalizeFrenchDate('5 oct. 2025'), '2025-10-05');
  assert.equal(normalizeFrenchDate('26 juil. 2025'), '2025-07-26');
  assert.equal(normalizeFrenchDate('12 juillet 2026'), '2026-07-12', 'les formes longues restent comprises');
  assert.equal(normalizeFrenchDate('3 fé 2026'), null, 'sous trois lettres, on refuse de deviner');
});

test('numeroDeCommande et l\'ancre : le remote_id désigne la commande', () => {
  assert.equal(atma.numeroDeCommande('Commande #12345'), '12345');
  assert.equal(atma.numeroDeCommande('Commande sans numéro'), null);
  assert.equal(atma.remoteIdCommande('12345'), 'atma-commande-12345');
});

// ---------------------------------------------------------------------------
// 2. Le parcours complet : deux commandes, deux reçus, le bandeau dans chaque
// ---------------------------------------------------------------------------

test('deux commandes inconnues → deux reçus reconstitués, bandeau « recu » dans chaque PDF', async () => {
  const { ctx, journal, preuves } = contexteEnregistreur();
  const gotos = [];
  const resultat = await surProfilSimule(ecransComplets(), gotos, () => atma.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 2);
  assert.deepEqual(resultat.invoices.map((i) => i.remoteId), ['atma-commande-12345', 'atma-commande-67890']);
  assert.deepEqual(resultat.invoices.map((i) => i.issuedOn), ['2026-02-03', '2026-07-18']);
  assert.equal(resultat.invoices[0].filename, 'atma-kitchenware_recu-reconstitue_commande-12345.pdf');

  // La preuve de liste (lot 31) compte les commandes réellement identifiées.
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].elements, 2);

  // Le bandeau de la nature « recu », octet par octet, dans CHAQUE document —
  // et rien de la section adresse/contact écartée.
  const phrase = releve.versWinAnsi(releve.bandeau('Atma Kitchenware', 'recu'));
  for (const facture of resultat.invoices) {
    const contenu = facture.buffer.toString('latin1');
    assert.ok(contenu.includes(phrase), 'le reçu dit qu\'il est reconstitué et n\'est pas une facture émise');
    assert.ok(contenu.includes(releve.versWinAnsi('REÇU RECONSTITUÉ — DOCUMENT PRODUIT PAR CRABE')));
    assert.equal(/Camille|Villexemple|exemple\.test/.test(contenu), false,
      'ni adresse ni contact dans le reçu');
  }
  // Les montants affichés sont recopiés tels quels.
  assert.ok(resultat.invoices[0].buffer.toString('latin1').includes(releve.versWinAnsi('Total EUR 94,00 €')));

  // La carte dit le fait, quel que soit le compte de reçus.
  assert.match(resultat.precision, /ne fournit pas de\s+facture/);
  assert.match(journal.join('\n'), /2 commande\(s\) vue\(s\), 2 reçu\(s\) reconstitué\(s\)/);
});

// ---------------------------------------------------------------------------
// 3. L'idempotence se mesure au trafic : une commande connue n'est pas rouverte
// ---------------------------------------------------------------------------

test('second passage : aucune ligne ajoutée, aucun détail rouvert', async () => {
  const { ctx, journal } = contexteEnregistreur(['atma-commande-12345', 'atma-commande-67890']);
  const gotos = [];
  const resultat = await surProfilSimule(ecransComplets(), gotos, () => atma.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices, []);
  assert.equal(gotos.some((u) => /\/account\/orders\/\d+/.test(u)), false,
    'les pages de détail ne sont même pas demandées — le second passage est silencieux pour la boutique');
  assert.match(journal.join('\n'), /2 déjà reconstituée\(s\)/);
  assert.match(resultat.precision, /ne fournit pas de\s+facture/,
    'même sans document neuf, la carte dit pourquoi il n\'y a pas de facture');
});

// ---------------------------------------------------------------------------
// 4. Une page illisible ne produit rien — et le dit
// ---------------------------------------------------------------------------

test('date incomprise au détail : aucun reçu partiel, l\'ancre reste libre, le journal dit quoi', async () => {
  const ecrans = ecransComplets();
  ecrans[1].texte = ecrans[1].texte.replace('Confirmée le 3 févr. 2026', 'Confirmée le hier');
  const { ctx, journal } = contexteEnregistreur();
  const gotos = [];
  const resultat = await surProfilSimule(ecrans, gotos, () => atma.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices.map((i) => i.remoteId), ['atma-commande-67890'],
    'la commande lisible est reconstituée, l\'illisible est écartée SEULE');
  assert.match(journal.join('\n'), /la commande 12345 n'a pas pu être lue/);
  assert.match(journal.join('\n'), /la prochaine récupération réessaiera/);
});

test('carte sans numéro sur la liste : ignorée, jamais une ancre inventée', async () => {
  const ecrans = ecransComplets();
  ecrans[0].liste.push({ titre: 'Commande en préparation', href: '/11112222/account/orders/98765003' });
  const { ctx, journal, preuves } = contexteEnregistreur();
  const resultat = await surProfilSimule(ecrans, [], () => atma.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 2);
  assert.equal(preuves[0].elements, 2, 'la preuve de liste ne compte que les commandes identifiées');
  assert.match(journal.join('\n'), /sans numéro est ignorée/);
});

// ---------------------------------------------------------------------------
// 5. Renvoi vers la connexion À L'OUVERTURE D'UN DÉTAIL : session à rouvrir
// ---------------------------------------------------------------------------

test('redirigé vers l\'écran de connexion en ouvrant une commande, le connecteur dit la session', async () => {
  const ecrans = ecransComplets();
  ecrans[1] = {
    url: 'https://shopify.com/authentication/11112222/login?x=1',
    cle: `${URL_LISTE}/98765001`,
    texte: '',
  };
  const { ctx } = contexteEnregistreur();
  await assert.rejects(
    () => surProfilSimule(ecrans, [], () => atma.fetchInvoices({}, ctx)),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. La nature « recu » du gabarit : vocabulaire fermé, défauts intacts
// ---------------------------------------------------------------------------

test('le gabarit refuse une nature inconnue, et la nature par défaut reste le relevé, à l\'octet', () => {
  assert.throws(
    () => releve.construire({ service: 'X', colonnes: [{ cle: 'a' }], nature: 'attestation' }),
    /Nature de document reconstitué inconnue/
  );
  assert.equal(releve.bandeau('X'),
    'Relevé reconstitué par crabe à partir de l\'historique d\'opérations — ceci n\'est pas un document émis par X.');
  assert.equal(releve.bandeau('X', 'recu'),
    'Reçu reconstitué par crabe à partir de votre espace client — ceci n\'est pas une facture émise par X.');

  // Un relevé construit SANS le paramètre `nature` sort identique à ce qu'il
  // était : c'est la garantie « PayPal et Bitstamp inchangés ».
  const options = {
    service: 'X', colonnes: [{ cle: 'a', titre: 'A' }], operations: [{ a: '1' }],
    periode: { du: '2026-01-01', au: '2026-01-31' }, genereLe: new Date('2026-02-01T00:00:00Z'),
  };
  assert.ok(releve.construire(options).equals(releve.construire({ ...options, nature: 'releve' })));
});
