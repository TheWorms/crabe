'use strict';

/**
 * Lot 104 — Private Sport Shop : la facture de chaque commande, choisie dans
 * « Télécharger une facture » — le seul geste du connecteur.
 *
 * Au VRAI Chromium, sur des pages RECONSTITUÉES (test/lot104-faux-sites.js) :
 * trois commandes, quatre options dont une d'un autre type. Ils prouvent la
 * lecture de cette forme, pas le vrai site.
 *
 * ⚠ Valeurs inventées : commandes « 9000000… », documents « 990000… »,
 * montants à 0,00 €, « Client d'essai ».
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const pss = require('../server/connectors/available/private-sport-shop/connector');
const faux = require('./lot104-faux-sites');
const outils = require('./lot104-outils');

const ID = 'private-sport-shop';
const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', ID, 'connector.js');
const FACTURES = ['99000011', '99000021', '99000031'];
const ANCRES = FACTURES.map((n) => `${ID}-facture-${n}`);
const VALEUR = (type, id) => JSON.stringify({ type, id: Number(id) });

const passer = (etat, options) => outils.passer(ID, pss, etat, options);

/** Ce qui doit tenir à chaque passage : aucun clic, seulement des choix de factures. */
function seulementDesFactures(journal, etat) {
  outils.rienDInterdit(journal, etat);
  assert.deepEqual(journal.gestes, [], `aucun clic : ${JSON.stringify(journal.gestes)}`);
  for (const c of journal.choix) {
    assert.equal(c.id, 'invoice-download-select');
    assert.equal(JSON.parse(c.valeur).type, 'invoice', `un choix qui n'est pas une facture : ${c.valeur}`);
  }
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// B2 / D4 — par construction
// ---------------------------------------------------------------------------

test('D4 — le fichier se LIT : aucun clic ; un seul `.selectOption(`, dans `choisirLaFacture`, gardes avant le choix ; aucun autre geste', () => {
  const code = outils.codeSansCommentaires(SOURCE);
  assert.doesNotMatch(code, /\.click\s*\(/, 'aucun clic');
  const choix = [...code.matchAll(/\.selectOption\s*\(/g)];
  assert.equal(choix.length, 1, 'un seul choix dans tout le fichier');
  const { debut, fin, corps } = outils.corpsDe(code, 'async function choisirLaFacture(');
  assert.ok(choix[0].index > debut && choix[0].index < fin, 'et le choix est DANS choisirLaFacture');
  const geste = corps.indexOf('.selectOption(');
  for (const garde of ['analyserOption(v).nature !== \'facture\' || !lues?.has?.(v)', '!== 1', 'isVisible()', 'memes !== 1']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < geste, `la garde « ${garde} » est présente, et avant le choix`);
  }
  assert.match(corps, /selectOption\(\{ value: v \}/, 'le choix se fait par la value exacte lue');
  assert.ok(Object.isFrozen(pss.GESTES) && Object.isFrozen(pss.GESTES.facture));
  assert.deepEqual({ ...pss.GESTES.facture }, { repere: 'select#invoice-download-select[data-selector-invoice-download-select]' });
  assert.equal((code.match(/choisirLaFacture\(/g) || []).length, 2, 'définie une fois, appelée une fois');
  for (const g of outils.AUTRES_GESTES) assert.doesNotMatch(code, g, `aucun autre geste (${g})`);
  assert.doesNotMatch(code, /data-selector-logout|checkout\.privatesportshop/, 'ni la déconnexion, ni le panier ne sont même nommés dans le code');
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch/);
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule navigation');
  assert.match(code, /async function naviguer\(page, adresse\) \{\n\s+const mot = refusees\.motRefuse\(adresse\);/);
  assert.match(code, /adressePermise: adresseDuSite/);
  assert.equal((code.match(/chromium\.launch\s*\(/g) || []).length, 1);
});

test('R3 — une option : facture seulement si `type` est exactement `invoice` et `id` un entier ; le reste n\'est jamais choisi', () => {
  assert.deepEqual(pss.analyserOption(VALEUR('invoice', 7)), { nature: 'facture', valeur: VALEUR('invoice', 7), id: '7' });
  assert.equal(pss.analyserOption('').nature, 'vide');
  assert.deepEqual(pss.analyserOption(VALEUR('creditmemo', 8)), { nature: 'autre', type: 'creditmemo' });
  for (const illisible of ['{', '[]', '"invoice"', '{"type":"invoice","id":"7"}', '{"type":"invoice","id":7.5}', '{"type":"invoice","id":-1}',
    '{"type":"invoice","id":7,"url":"/checkout"}', '{"type":"invoice"}']) {
    assert.equal(pss.analyserOption(illisible).nature, 'illisible', illisible);
  }
  assert.equal(pss.analyserOption('{"type":"Invoice","id":7}').nature, 'autre', 'la casse compte : exactement « invoice »');
});

test('R3 — le choix refuse une valeur qui n\'est pas une facture lue sur cette page : rien n\'est cherché', async () => {
  let cherche = 0;
  const page = { locator: () => { cherche += 1; throw new Error('aucune cible ne doit être cherchée'); } };
  await assert.rejects(pss.choisirLaFacture(page, VALEUR('invoice', 7), new Set()), /rien n'a été choisi/);
  await assert.rejects(pss.choisirLaFacture(page, VALEUR('creditmemo', 8), new Set([VALEUR('creditmemo', 8)])), /rien n'a été choisi/);
  assert.equal(cherche, 0);
});

test('les adresses : seules les deux listes et le détail d\'une commande lue ; le document seulement depuis le site', () => {
  assert.deepEqual(pss.adresseDuDetail('/historical/orders/90000001'), { adresse: 'https://www.privatesportshop.fr/historical/orders/90000001', numero: '90000001' });
  for (const refus of ['https://checkout.privatesportshop.fr/', '/ProductReturn/Front/List/', '/sales/billing_agreement/', '/historical/orders/1?x=1',
    'https://www.privatesportshop.fr.exemple.invalid/historical/orders/1', '/historical/orders/abc']) {
    assert.ok(pss.adresseDuDetail(refus).refus, refus);
  }
  assert.equal(pss.adresseDuSite('https://api.sportpursuit.com/v1/x'), true);
  assert.equal(pss.adresseDuSite('https://checkout.privatesportshop.fr/x'), false, 'jamais le panier');
  assert.equal(pss.adresseDuSite('https://cdn.sportscape.group/x.pdf'), false);
  assert.equal(pss.pourLeJournal('commande 90000001, 12,50 €, /historical/orders/90000001?x=1'), 'commande …, … €, /historical/orders/…?…');
});

// ---------------------------------------------------------------------------
// D3 — trois commandes, quatre options
// ---------------------------------------------------------------------------

test('D3 — trois commandes, quatre options dont un autre type : trois factures choisies et prises, l\'autre dite et jamais choisie', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementDesFactures(journal, etat);
  assert.deepEqual(journal.choix.map((c) => c.valeur), FACTURES.map((n) => VALEUR('invoice', n)), 'un choix par facture, dans l\'ordre');
  assert.deepEqual(etat.compteurs.documents, FACTURES.map((n) => `invoice:${n}`), 'l\'autre type n\'est jamais demandé');
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES);
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2025-12-14', '2024-06-09', '2023-04-22'], 'la date de commande');
  assert.deepEqual(resultat.invoices.map((f) => f.filename), [`${ID}_2025-12_facture-99000011.pdf`, `${ID}_2024-06_facture-99000021.pdf`,
    `${ID}_2023-04_facture-99000031.pdf`]);
  assert.deepEqual(resultat.invoices.map((f) => /facture inventee pss invoice (\d+)/.exec(f.buffer.toString('latin1'))[1]), FACTURES);
  assert.equal(resultat.precision, '— Private Sport Shop : 3 commandes lues, 3 factures proposées. 1 autre document est proposé (pas une facture) : '
    + 'crabe ne le prend pas.');
  assert.ok(lignes.some((l) => /1 autre\(s\) document\(s\) jamais choisi\(s\) \(type : creditmemo\)/.test(l)), 'l\'autre type est dit, sans identifiant');
  assert.equal(preuves[0].elements, 3);
  assert.equal(ouverts, 0);
  assert.ok(journal.visites.includes(`${faux.PSS}/sales/order/history/`), '« Mes commandes » est lue aussi');
  outils.journalSansDonnee(lignes);
});

test('D3 — second passage : rien de choisi', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss();
  const { resultat, erreur, journal } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(journal.choix, []);
  assert.match(resultat.precision, /3 factures proposées, 3 déjà dans vos documents\./);
});

test('D3 — une commande sans facture est dite, jamais comptée comme un échec', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss();
  etat.commandes[2].options = [];
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 2);
  assert.match(resultat.precision, /3 commandes lues, 2 factures proposées, 1 commande sans facture\./);
  assert.equal(resultat.manquees, undefined);
});

for (const [variante, motif] of [
  ['non-pdf', /la boutique a remis autre chose qu'une facture PDF/],
  ['ailleurs', /le document venait d'un autre site que la boutique/],
]) {
  test(`D3 — le choix ne rend pas de PDF (${variante}) : plus aucun geste pendant ce passage ; c'est dit`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.comptePss({ variante });
    const { resultat, erreur, journal, lignes } = await passer(etat, { ouverture: { delaiDocumentMs: 3_000 } });
    assert.equal(erreur, null, erreur?.message);
    seulementDesFactures(journal, etat);
    assert.equal(journal.choix.length, 1, 'un seul choix');
    assert.deepEqual(resultat.invoices, []);
    assert.match(resultat.precision, motif);
    assert.match(resultat.precision, /crabe n'a plus rien choisi pendant ce passage ; 2 autres factures n'ont pas été demandées/);
    assert.equal(resultat.manquees, 3);
    outils.journalSansDonnee(lignes);
  });
}

// ---------------------------------------------------------------------------
// D4 — les pièges ; D5 — session et temps
// ---------------------------------------------------------------------------

test('D4 — à côté, visibles : « Déconnexion », le panier, « Commander », « Retours », « Modes de paiement », « Retourner un article » — rien n\'est touché', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss();
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur, null);
  seulementDesFactures(journal, etat);
  assert.deepEqual(journal.avortees, []);
  assert.ok(journal.visites.every((v) => !v.startsWith(faux.PSS_PANIER)), 'jamais le panier');
});

test('D5 — session expirée : « session expirée », aucun geste', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss({ connecte: false });
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur?.sessionExpired, true, erreur?.message);
  assert.deepEqual(journal.choix, []);
});

test('D5 — la session tombe au milieu : les factures prises sont gardées', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePss({ sessionMeurtApresDocuments: 1 });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 1);
  assert.match(resultat.precision, /Private Sport Shop a demandé de vous reconnecter : les factures déjà prises sont gardées/);
});

test('D5 — le temps permis s\'écoule au milieu : ce qui est pris est gardé', faux.SANS_NAVIGATEUR, async () => {
  const h = outils.horlogeASaut();
  const etat = faux.comptePss({ surPdf: (n) => { if (n === 2) h.saut(); } });
  const { resultat, erreur } = await passer(etat, { ouverture: { maintenant: h.maintenant } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 2);
  assert.match(resultat.precision, /La récupération a pris tout le temps permis/);
});

// ---------------------------------------------------------------------------
// D6 — par le vrai planificateur
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  test('D6 — trois factures rangées, puis rien de nouveau ; le journal applicatif ne porte aucune donnée', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot104pss');
    let { r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.comptePss(), user });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '3 factures récupérées — Private Sport Shop : 3 commandes lues, 3 factures proposées. 1 autre document est '
      + 'proposé (pas une facture) : crabe ne le prend pas.');
    assert.deepEqual(outils.documents(db, user, ID).map((d) => d.remote_id), ANCRES);
    ({ r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.comptePss(), user }));
    assert.equal(r.message, 'Aucune nouvelle facture — Private Sport Shop : 3 commandes lues, 3 factures proposées, 3 déjà dans vos '
      + 'documents. 1 autre document est proposé (pas une facture) : crabe ne le prend pas.');
    assert.equal(outils.documents(db, user, ID).length, 3);
    outils.journalApplicatifSansDonnee(db);
  });
});
