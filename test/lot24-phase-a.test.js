'use strict';

/**
 * Lot 24, phase A — quatre connecteurs corrigés, et la rencontre de deux
 * réglages qui se contredisaient en silence.
 *
 * ─── Ce que ces tests protègent ──────────────────────────────────────────────
 *
 * 1. **Le plafond de conservation.** Le 12/08/2026, crabe a téléchargé 118
 *    factures (65 OVH, 53 SoYouStart) remontant à 2020, et l'entretien de la
 *    nuit en a effacé 149 — index ET fichiers sur le stockage local — parce que la
 *    conservation était réglée sur « 1 an ». Au matin, 2 factures OVH sur 67.
 *    Aucun des deux réglages n'était fautif seul ; c'est leur rencontre qui
 *    l'était, et elle se réglait au prix fort pour un résultat nul.
 *
 * 2. **Un lien de navigation n'est pas un document.** Chez Hetzner, crabe
 *    téléchargeait la page de facturation elle-même — 78 850 octets de HTML
 *    annoncés comme « le document hetzner-doc1 n'est pas un PDF » — et mourait
 *    dessus avant d'atteindre la moindre vraie facture.
 *
 * 3. **La pagination.** Même corrigé du reste, Hetzner n'aurait vu que 24
 *    factures sur les quatre pages de la liste.
 *
 * 4. **Les adresses mesurées.** Mistral cherchait sur une page qui rend 404 ;
 *    Infomaniak sur trois qui rendent 404 ; Anthropic sur un autre produit que
 *    celui que l'utilisateur veut suivre.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const history = require('../server/connectors/history');
const pageDocs = require('../server/connectors/documents-de-page');
const hetzner = require('../server/connectors/available/hetzner/connector');
const infomaniak = require('../server/connectors/available/infomaniak/connector');
const ovhApi = require('../server/connectors/available/ovh-api/connector');

const manifeste = (id) =>
  JSON.parse(fs.readFileSync(`server/connectors/available/${id}/manifest.json`, 'utf8'));

/** Le 13 août 2026, jour de la mesure — pour que rien ne dépende de l'horloge. */
const LE_JOUR_DU_CONSTAT = new Date('2026-08-13T10:00:00.000Z');

// ---------------------------------------------------------------------------
// 1. Le plafond de conservation
// ---------------------------------------------------------------------------

test('sans conservation, la fenêtre est exactement celle d\'avant ce lot', () => {
  // Le défaut de crabe est « Tout garder » : un compte qui n'a jamais ouvert
  // l'écran de conservation ne doit voir AUCUN changement de comportement.
  const avant = history.fenetreBrute({ valeur: 'tout', maintenant: LE_JOUR_DU_CONSTAT });
  const apres = history.fenetreDeDates({
    valeur: 'tout', maintenant: LE_JOUR_DU_CONSTAT, plafondMois: 0,
  });
  assert.equal(apres.from, null, 'aucune borne basse, comme avant');
  assert.equal(apres.plafonne, false);
  assert.equal(apres.raison, avant.raison, 'la raison affichée ne change pas non plus');
});

test('le scénario OVH du 12/08/2026, plafonné : 2020 n\'est plus demandé', () => {
  // Le réglage du connecteur dit « tout l'historique ». La conservation dit
  // « un an ». Avant ce lot, crabe demandait tout, téléchargeait 65 PDF, et en
  // perdait 63 la nuit suivante.
  const sansPlafond = history.fenetreDeDates({
    valeur: 'tout', maintenant: LE_JOUR_DU_CONSTAT,
  });
  assert.equal(sansPlafond.from, null, 'sans plafond : aucune borne, donc 2020 est listé');

  const avecPlafond = history.fenetreDeDates({
    valeur: 'tout', maintenant: LE_JOUR_DU_CONSTAT, plafondMois: 12,
  });
  assert.equal(avecPlafond.plafonne, true);
  assert.equal(
    avecPlafond.from.toISOString().slice(0, 10),
    '2025-08-13',
    'la borne est EXACTEMENT celle que le nettoyage appliquera'
  );
  // Le silence était le vrai défaut : la fenêtre rognée doit se dire.
  assert.match(avecPlafond.raison, /conservation/i);
  assert.match(avecPlafond.raison, /1 an/);
  assert.match(avecPlafond.raison, /effacerait/i);
});

test('le premier passage du mode « depuis » est plafonné lui aussi', () => {
  // C'est LE cas qui a coûté les 118 téléchargements : `from === null` veut
  // dire « aucune borne », donc la fenêtre la plus large qui soit. Ne pas le
  // traiter aurait laissé passer exactement le scénario qu'on répare.
  const plan = history.fenetreDeDates({
    valeur: 'depuis',
    dejaRecupere: false,
    maintenant: LE_JOUR_DU_CONSTAT,
    plafondMois: 12,
  });
  assert.equal(plan.plafonne, true);
  assert.equal(plan.from.toISOString().slice(0, 10), '2025-08-13');
});

test('le plafond ne fait JAMAIS chercher plus loin qu\'on ne demandait', () => {
  // « Année en cours » avec une conservation de deux ans : le plafond
  // remonterait à 2024, la demande s'arrête à 2026. C'est la demande qui gagne
  // — un plafond n'est pas un plancher.
  const plan = history.fenetreDeDates({
    valeur: 'courante', maintenant: LE_JOUR_DU_CONSTAT, plafondMois: 24,
  });
  assert.equal(plan.plafonne, false);
  assert.equal(plan.from.toISOString().slice(0, 10), '2026-01-01');
});

test('les années à parcourir gardent l\'année de la borne, jamais à moitié', () => {
  // Conservation d'un an au 13/08/2026 → borne en août 2025. L'année 2025 est
  // à cheval : la retirer perdrait les factures de septembre à décembre 2025,
  // qui, elles, seront bel et bien conservées.
  const plan = history.anneesAParcourir({
    valeur: 'tout',
    disponibles: [2026, 2025, 2024, 2023, 2022, 2021, 2020],
    maintenant: LE_JOUR_DU_CONSTAT,
    plafondMois: 12,
  });
  assert.deepEqual(plan.annees, [2026, 2025]);
  assert.equal(plan.plafonne, true);
  assert.match(plan.raison, /conservation/i);
});

test('sans plafond, les années restent celles du réglage', () => {
  const plan = history.anneesAParcourir({
    valeur: 'tout',
    disponibles: [2026, 2025, 2024],
    maintenant: LE_JOUR_DU_CONSTAT,
  });
  assert.deepEqual(plan.annees, [2026, 2025, 2024]);
  assert.equal(plan.plafonne, false);
});

test('ovh-api transmet le plafond, et SoYouStart passe par le même chemin', () => {
  // `ovh-api` sert OVHcloud, SoYouStart et Kimsufi : une seule implémentation,
  // donc un seul endroit à vérifier — mais il faut le vérifier POUR CHACUN,
  // parce que c'est justement ce partage qui rend une régression invisible.
  for (const connectorId of ['ovh', 'soyoustart']) {
    const config = { historique: 'tout', endpoint: `${connectorId}-eu` };

    const large = ovhApi.fenetreApi(config, { connectorId, conservationMois: 0 });
    assert.equal('date.from' in large.params, false, `${connectorId} : tout l'historique`);

    const serre = ovhApi.fenetreApi(config, { connectorId, conservationMois: 12 });
    assert.ok(serre.params['date.from'], `${connectorId} : le plafond pose une borne`);
    assert.equal(serre.plan.plafonne, true, `${connectorId} : et il le dit`);
  }
});

// ---------------------------------------------------------------------------
// 2. Un lien de navigation n'est pas un document
// ---------------------------------------------------------------------------

/** Les liens réellement relevés sur accounts.hetzner.com/invoice le 13/08/2026. */
const LIENS_HETZNER = [
  { href: 'https://accounts.hetzner.com/invoice', texte: 'DeutschDE', ligne: '' },
  { href: 'https://accounts.hetzner.com/invoice', texte: 'Übersicht', ligne: '' },
  { href: 'https://accounts.hetzner.com/invoice/transactions', texte: 'Transaktionen', ligne: '' },
  { href: 'https://accounts.hetzner.com/invoice/credit', texte: 'Guthaben', ligne: '' },
  {
    href: 'https://accounts.hetzner.com/invoice/083001030557/pdf',
    texte: 'PDF',
    ligne: '19.07.2026 083001030557 77,14 € ausgeglichen PDF Details',
  },
  {
    href: 'https://accounts.hetzner.com/invoice/R0024665758/csv',
    texte: 'CSV',
    ligne: '19.09.2024 R0024665758 56,16 € ausgeglichen CSV',
  },
  {
    href: 'https://accounts.hetzner.com/invoice/R0024665758/pdf',
    texte: 'PDF',
    ligne: '19.09.2024 R0024665758 56,16 € ausgeglichen PDF',
  },
  { href: 'https://accounts.hetzner.com/invoice?page=2', texte: '2', ligne: '' },
  { href: 'https://accounts.hetzner.com/invoice?page=3', texte: '3', ligne: '' },
];

test('la page qu\'on est en train de lire n\'est pas un de ses propres documents', () => {
  // Sans `pageActuelle`, ces quatre liens-là produisaient `hetzner-doc1`,
  // `hetzner-doc2` et deux `hetzner-page` — et le premier téléchargeait
  // 78 850 octets de HTML.
  const sansGarde = pageDocs.documentsDepuisLiens(LIENS_HETZNER, { prefixe: 'hetzner-' });
  assert.ok(
    sansGarde.some((d) => d.remoteId === 'hetzner-doc1'),
    'sans garde-fou, le défaut d\'origine est bien reproduit'
  );

  const avecGarde = pageDocs.documentsDepuisLiens(LIENS_HETZNER, {
    prefixe: 'hetzner-',
    pageActuelle: 'https://accounts.hetzner.com/invoice',
  });
  const ids = avecGarde.map((d) => d.remoteId);
  assert.equal(ids.includes('hetzner-doc1'), false);
  assert.equal(ids.includes('hetzner-doc2'), false);
  assert.equal(ids.includes('hetzner-page'), false, 'la pagination non plus');
});

test('la pagination est la même page, aux paramètres près', () => {
  assert.equal(
    pageDocs.memePage('https://a.fr/invoice?page=2', 'https://a.fr/invoice'),
    true
  );
  assert.equal(
    pageDocs.memePage('https://a.fr/invoice/1234/pdf', 'https://a.fr/invoice'),
    false,
    'une facture n\'est pas la page qui la liste'
  );
  assert.equal(
    pageDocs.memePage('https://autre.fr/invoice', 'https://a.fr/invoice'),
    false,
    'même chemin sur un autre domaine : pas la même page'
  );
});

test('une route déclarée écarte tout le reste, CSV compris', () => {
  const docs = pageDocs.documentsDepuisLiens(LIENS_HETZNER, {
    prefixe: 'hetzner-',
    route: hetzner.ROUTE_PDF,
  });
  assert.deepEqual(
    docs.map((d) => d.remoteId),
    ['hetzner-083001030557', 'hetzner-R0024665758']
  );
  // Le CSV portait le MÊME identifiant distant que son PDF : deux entrées pour
  // un seul document, dont une qui n'est pas un PDF.
  assert.equal(docs.filter((d) => d.url.endsWith('/csv')).length, 0);
  // Et la date et le montant sont bien relevés sur la ligne, pas sur le lien.
  assert.equal(docs[0].issuedOn, '2026-07-19');
  assert.match(docs[0].amount, /77,14/);
});

test('la route de facture Hetzner ne prend ni la liste ni ses onglets', () => {
  const dedans = 'https://accounts.hetzner.com/invoice/083001030557/pdf';
  assert.equal(hetzner.ROUTE_PDF.test(dedans), true);
  for (const dehors of [
    'https://accounts.hetzner.com/invoice',
    'https://accounts.hetzner.com/invoice?page=2',
    'https://accounts.hetzner.com/invoice/transactions',
    'https://accounts.hetzner.com/invoice/credit',
    'https://accounts.hetzner.com/invoice/083001030557/csv',
    'https://accounts.hetzner.com.exemple.net/invoice/1/pdf',
  ]) {
    assert.equal(hetzner.ROUTE_PDF.test(dehors), false, dehors);
  }
});

// ---------------------------------------------------------------------------
// 3. La pagination
// ---------------------------------------------------------------------------

test('Hetzner suit sa pagination, sans jamais revenir sur ses pas', () => {
  const suivantes = hetzner.pagesSuivantes(
    LIENS_HETZNER.map((l) => l.href),
    'https://accounts.hetzner.com/invoice'
  );
  assert.deepEqual(suivantes, [
    'https://accounts.hetzner.com/invoice?page=2',
    'https://accounts.hetzner.com/invoice?page=3',
  ]);
});

test('la page 1 n\'est jamais suivie : ce serait une boucle', () => {
  // Hetzner affiche « 1 2 3 4 » sur CHAQUE page : sans cette règle, la liste
  // des pages à visiter se remplirait indéfiniment de la page d'où l'on vient.
  const suivantes = hetzner.pagesSuivantes(
    ['https://accounts.hetzner.com/invoice?page=1', 'https://accounts.hetzner.com/invoice'],
    'https://accounts.hetzner.com/invoice'
  );
  assert.deepEqual(suivantes, []);
});

test('l\'archive Hetzner, qui rend 404, n\'est plus essayée', () => {
  assert.deepEqual(hetzner.URLS_DOCUMENTS, ['https://accounts.hetzner.com/invoice']);
});

// ---------------------------------------------------------------------------
// 4. Les adresses mesurées
// ---------------------------------------------------------------------------

test('Mistral vise l\'espace d\'administration, pas la console', () => {
  const m = manifeste('mistral');
  assert.equal(m.remoteLogin.verifyUrl, 'https://admin.mistral.ai/organization/billing');
  assert.equal(m.site, 'admin.mistral.ai');
  // console.mistral.ai/admin/billing rend un 404 session ouverte : plus aucune
  // adresse du connecteur ne doit y mener.
  const mistral = require('../server/connectors/available/mistral/connector');
  assert.deepEqual(mistral.URLS_DOCUMENTS, ['https://admin.mistral.ai/organization/billing']);
  // Le domaine gardé couvre les deux sous-domaines : le cookie est sur
  // .mistral.ai, il n'y a rien à changer de ce côté.
  assert.deepEqual(m.remoteLogin.keepDomains, ['mistral.ai']);
});

test('Anthropic suit l\'abonnement Claude, et le dit à qui le lira', () => {
  const m = manifeste('anthropic');
  assert.equal(m.site, 'claude.ai');
  assert.match(m.remoteLogin.url, /^https:\/\/claude\.ai\//);
  assert.match(m.remoteLogin.verifyUrl, /^https:\/\/claude\.ai\//);
  assert.equal(
    JSON.stringify(m.fields).includes('platform.claude.com'),
    false,
    'aucun champ ne doit plus parler de la console développeur comme de la cible'
  );
  // La réserve, servie à l'utilisateur, doit distinguer les deux produits :
  // c'est la seule façon qu'il a de comprendre pourquoi sa connexion enregistrée
  // ne vaut plus rien.
  assert.match(m.caveat, /claude\.ai/);
  assert.match(m.caveat, /console/i);
});

test('Infomaniak lit le numéro de compte des deux formes d\'adresse du manager', () => {
  // Deux namespaces coexistent, et le second n'a pas le nombre juste après
  // « /v3/ » : chercher « le nombre après /v3/ » aurait rendu null sur la page
  // de facturation elle-même.
  assert.equal(
    infomaniak.compteDepuisUrl('https://manager.infomaniak.com/v3/854637/ng/home'),
    '854637'
  );
  assert.equal(
    infomaniak.compteDepuisUrl('https://manager.infomaniak.com/v3/invoicing/854637/bills'),
    '854637'
  );
  assert.equal(infomaniak.compteDepuisUrl('https://manager.infomaniak.com/'), null);
});

test('une facture Infomaniak se traduit sans perdre sa date ni son montant', () => {
  // `created_at` est en SECONDES. L'oublier daterait toutes les factures de
  // janvier 1970 — donc les ferait toutes tomber hors de la fenêtre
  // d'historique, sans qu'aucun message ne le dise.
  const facture = infomaniak.factureDepuisJson({
    id: 7588884,
    pdf: 'https://api.infomaniak.com/2/invoicing/invoice/pdf/UN-JETON',
    type: 'invoice',
    status: 'paid',
    amount_incl_tax: 42.42,
    currency: 'EUR',
    created_at: 1686960000,
  });
  assert.equal(facture.remoteId, '7588884');
  assert.equal(facture.issuedOn, '2023-06-17');
  assert.equal(facture.amount, '42.42 EUR');
  assert.equal(infomaniak.nomFichier(facture), 'infomaniak_2023-06_7588884.pdf');
});

test('une facture Infomaniak sans PDF est écartée, pas plantée', () => {
  assert.equal(infomaniak.factureDepuisJson({ id: 1, created_at: 1686960000 }), null);
  assert.equal(infomaniak.factureDepuisJson(null), null);
  assert.equal(infomaniak.factureDepuisJson({ pdf: 'https://x.fr/a.pdf' }), null);
});

test('Infomaniak demande TOUTES ses factures d\'un coup', () => {
  // Sans paramètre la route rend déjà les 67 ; avec `?page=2` elle pagine à 15.
  // Demander explicitement une grande page évite d'avoir à découvrir un jour,
  // sur un compte plus fourni, que le défaut avait changé.
  assert.match(infomaniak.routeFactures('854637'), /per_page=500/);
  assert.match(infomaniak.routeFactures('854637'), /\/proxy\/2\/invoicing\/account\/854637\/invoices/);
});

// ---------------------------------------------------------------------------
// Lot 33 — l'écran de validation en deux temps est une page d'authentification
// ---------------------------------------------------------------------------

test('Hetzner : /2fa est une page d\'authentification, pas une liste sans factures', () => {
  // Mesuré le 14/08/2026 : une session à moitié capturée (mot de passe passé,
  // code jamais saisi) dépose /invoice sur accounts.hetzner.com/2fa. Sans
  // cette reconnaissance, le connecteur concluait « connexion valide, mais
  // aucune facture reconnue » — trois échecs à 14:46-47 — au lieu de dire de
  // rouvrir la connexion.
  for (const url of [
    'https://accounts.hetzner.com/2fa',
    'https://accounts.hetzner.com/otp',
    'https://accounts.hetzner.com/mfa',
    'https://accounts.hetzner.com/two-factor',
    'https://accounts.hetzner.com/login',
  ]) {
    assert.equal(hetzner.estPageAuthentification(url), true, url);
  }

  // La liste des factures et la garde HeRay gardent chacune leur statut.
  assert.equal(hetzner.estPageAuthentification('https://accounts.hetzner.com/invoice'), false);
  assert.equal(hetzner.estPageAuthentification('https://accounts.hetzner.com/_ray/pow'), false);
});
