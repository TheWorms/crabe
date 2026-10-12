'use strict';

/**
 * Lot 104 — Alma : le reçu de chaque échéance payée, par les quatre gestes
 * permis (les onglets, la ligne payée, « Télécharger le reçu », la croix).
 *
 * Au VRAI Chromium, sur des pages RECONSTITUÉES (test/lot104-faux-sites.js) :
 * deux achats (un en cours, un terminé à cheval sur deux années), cinq
 * échéances dont quatre payées. Ils prouvent la lecture de cette forme, pas
 * le vrai site.
 *
 * ⚠ Valeurs inventées : identifiants « ZZessai… », montants à 0,00 €,
 * « Commerçant d'essai ».
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const alma = require('../server/connectors/available/alma/connector');
const faux = require('./lot104-faux-sites');
const outils = require('./lot104-outils');

const ID = 'alma';
const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', ID, 'connector.js');
const PAYEES = ['installment_ZZessaiEch0101', 'installment_ZZessaiEch0102', 'installment_ZZessaiEch0201', 'installment_ZZessaiEch0202'];
const NON_PAYEE = 'installment_ZZessaiEch0103';
const ANCRES = PAYEES.map((id) => `${ID}-recu-${id}`);

const passer = (etat, options) => outils.passer(ID, alma, etat, options);

/** Ce qui doit tenir à chaque passage : seulement les quatre gestes, jamais la ligne non payée. */
function seulementLesGestesPermis(journal, etat) {
  outils.rienDInterdit(journal, etat);
  assert.deepEqual(journal.choix, []);
  for (const g of journal.gestes) {
    const permis = ['Achats en cours', 'Achats terminés'].includes(g.texte)
      || PAYEES.some((id) => g.testid === `payment-schedule-line-${id}`)
      || (g.testid === 'download-receipt' && g.texte === 'Télécharger le reçu')
      || g.testid === 'modal-close-button';
    assert.ok(permis, `un geste hors de la liste : ${JSON.stringify(g)}`);
    assert.notEqual(g.testid, `payment-schedule-line-${NON_PAYEE}`, 'la ligne non payée n\'est jamais touchée');
  }
}

const compte = (journal, testid) => journal.gestes.filter((g) => g.testid === testid).length;

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// B2 / D4 — par construction
// ---------------------------------------------------------------------------

test('D4 — le fichier se LIT : un seul `.click(`, dans `faireLeGeste` ; la liste des gestes est fermée et gelée ; aucun autre geste', () => {
  const code = outils.codeSansCommentaires(SOURCE);
  const clics = [...code.matchAll(/\.click\s*\(/g)];
  assert.equal(clics.length, 1, 'un seul clic dans tout le fichier');
  const { debut, fin, corps } = outils.corpsDe(code, 'async function faireLeGeste(');
  assert.ok(clics[0].index > debut && clics[0].index < fin, 'et le clic est DANS faireLeGeste');
  const clic = corps.indexOf('.click(');
  for (const garde of ['!geste || !Object.prototype.hasOwnProperty.call(GESTES, nom)', '!geste.textes.includes(attendu)',
    '!ID_ECHEANCE.test(id)', '!morceaux.includes(\'Payé\')', '!morceaux.includes(attendu.dateTexte)',
    'fen.date !== attendu?.dateTexte', '!== geste.texte', 'isVisible()']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < clic, `la garde « ${garde} » est présente, et avant le clic`);
  }
  assert.ok(Object.isFrozen(alma.GESTES));
  for (const g of Object.values(alma.GESTES)) assert.ok(Object.isFrozen(g));
  // Lot 105 (R3) : un cinquième geste, « Non merci » — un seul, gardé à part
  // (test/lot105-alma.test.js) ; les quatre du lot 104 n'ont pas bougé.
  assert.deepEqual(Object.keys(alma.GESTES), ['onglet', 'ligne', 'recu', 'croix', 'nonMerci']);
  assert.deepEqual([...alma.GESTES.onglet.textes], ['Achats en cours', 'Achats terminés']);
  assert.equal(alma.GESTES.recu.repere, '[role="dialog"][data-testid="reactModal"] [data-testid="download-receipt"]');
  assert.equal(alma.GESTES.croix.repere, '[role="dialog"][data-testid="reactModal"] [data-testid="modal-close-button"]');
  for (const geste of [...outils.AUTRES_GESTES, /\.selectOption\s*\(/]) assert.doesNotMatch(code, geste, `aucun autre geste (${geste})`);
  assert.doesNotMatch(code, /customer_account_[A-Za-z0-9]{4,}/, 'aucun identifiant de compte écrit dans le code');
  assert.doesNotMatch(code, /_[a-zA-Z]+_[a-z0-9]{5}_\d+/, 'aucune classe générée (instable) n\'est lue');
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch/);
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule navigation');
  assert.match(code, /async function naviguer\(page, adresse\) \{\n\s+const mot = refusees\.motRefuse\(adresse\);/);
  assert.match(code, /adressePermise: adresseAlma/);
  assert.equal((code.match(/chromium\.launch\s*\(/g) || []).length, 1);
});

test('un geste hors de la liste, un onglet inconnu, une échéance qui n\'a pas la forme lue : rien n\'est cherché, rien n\'est cliqué', async () => {
  let cherche = 0;
  const page = { locator: () => { cherche += 1; throw new Error('aucune cible ne doit être cherchée'); }, evaluate: async () => { cherche += 1; return null; } };
  await assert.rejects(alma.faireLeGeste(page, 'payer', null), /hors de la liste — rien n'a été cliqué/);
  await assert.rejects(alma.faireLeGeste(page, '__proto__', null), /hors de la liste/);
  await assert.rejects(alma.faireLeGeste(page, 'onglet', 'Mon compte'), /onglet hors de la liste/);
  await assert.rejects(alma.faireLeGeste(page, 'ligne', { id: 'installment_x"]', dateTexte: '1 mars' }), /pas été lue/);
  assert.equal(cherche, 0);
});

test('R2 — la règle de l\'année : la première échéance le jour de l\'achat, les suivantes après, l\'année passe en janvier', () => {
  assert.deepEqual(alma.datesDesEcheances('2026-03-10', ['10 mars', '10 avril', '10 mai']), ['2026-03-10', '2026-04-10', '2026-05-10']);
  assert.deepEqual(alma.datesDesEcheances('2025-12-20', ['20 décembre', '20 janvier', '20 février']), ['2025-12-20', '2026-01-20', '2026-02-20']);
  assert.deepEqual(alma.datesDesEcheances('2025-11-30', ['30 nov.', '30 déc.', '30 janv.', '28 févr.']),
    ['2025-11-30', '2025-12-30', '2026-01-30', '2026-02-28'], 'mois abrégés');
  assert.deepEqual(alma.datesDesEcheances('2026-01-31', ['31 janvier', 'n\'importe quoi', '31 mars']), ['2026-01-31', null, '2026-03-31'],
    'une date illisible ne déplace pas la suivante');
  assert.deepEqual(alma.datesDesEcheances(null, ['1 mars']), [null], 'sans date d\'achat, aucune année inventée');
  assert.equal(alma.dateDAchat('Détails de l\'achat\nCommerçant\nCommerçant d\'essai\nDate\n20 décembre 2025\nRéférence'), '2025-12-20');
});

test('les identifiants : lus dans les data-testid, jamais inventés ; le journal les masque', () => {
  assert.equal(alma.achatDeLaCarte('customer-portal-card-payment_ZZessaiAchat01'), 'payment_ZZessaiAchat01');
  assert.equal(alma.achatDeLaCarte('customer-portal-card-payment_x"]'), null);
  assert.equal(alma.adresseDeLAchat('payment_ZZessaiAchat01'), 'https://portal.getalma.eu/payment_ZZessaiAchat01');
  assert.equal(alma.adresseDeLAchat('../logout'), null);
  assert.equal(alma.echeanceDeLaLigne('payment-schedule-line-installment_ZZessaiEch0101'), 'installment_ZZessaiEch0101');
  assert.equal(alma.pourLeJournal('payment_ZZessaiAchat01 installment_ZZessaiEch0101 customer_account_ZZx 12,50 € /a?b=1'),
    'payment_… installment_… customer_account_… … € /a?…');
  assert.equal(alma.adresseAlma('https://api.getalma.eu/v1/x'), true);
  assert.equal(alma.adresseAlma('blob:https://portal.getalma.eu/abc'), true);
  assert.equal(alma.adresseAlma('https://documents.exemple.invalid/recu.pdf'), false);
  assert.equal(alma.adresseAlma('http://api.getalma.eu/v1/x'), false);
});

// ---------------------------------------------------------------------------
// D2 — deux achats, cinq échéances, quatre reçus
// ---------------------------------------------------------------------------

test('D2 — deux achats, cinq échéances dont quatre payées : quatre reçus, la ligne non payée jamais touchée, l\'année juste à cheval sur deux années', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementLesGestesPermis(journal, etat);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES, 'l\'ancre : l\'identifiant de l\'échéance');
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-03-10', '2026-04-10', '2025-12-20', '2026-01-20']);
  assert.deepEqual(resultat.invoices.map((f) => f.filename), ['alma_2026-03_recu-saiEch0101.pdf', 'alma_2026-04_recu-saiEch0102.pdf',
    'alma_2025-12_recu-saiEch0201.pdf', 'alma_2026-01_recu-saiEch0202.pdf']);
  assert.deepEqual(resultat.invoices.map((f) => /recu invente alma (installment_\w+)/.exec(f.buffer.toString('latin1'))[1]), PAYEES,
    'chaque ancre porte SON reçu');
  assert.deepEqual(etat.compteurs.recus, PAYEES, 'un reçu demandé par échéance payée, aucun autre');
  assert.equal(compte(journal, 'download-receipt'), 4);
  assert.equal(compte(journal, 'modal-close-button'), 4, 'chaque fenêtre refermée par sa croix');
  assert.equal(journal.gestes.filter((g) => /^Achats /.test(g.texte)).length, 2, 'les deux onglets, une fois chacun');
  assert.equal(resultat.precision, '— Alma : 2 achats lus, 4 échéances payées, 1 échéance pas encore payée (pas de reçu pour l\'instant).');
  assert.equal(resultat.couverture.complete, true);
  assert.equal(preuves[0].elements, 2);
  assert.equal(ouverts, 0);
  assert.ok(journal.visites.every((v) => !v.includes(faux.COMPTE_ALMA) || v === `${faux.ALMA}/account/${faux.COMPTE_ALMA}`));
  outils.journalSansDonnee(lignes);
});

test('D2 — second passage : aucune ligne cliquée, aucun reçu demandé', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma();
  const { resultat, erreur, journal } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(journal.gestes.map((g) => g.texte), ['Achats en cours', 'Achats terminés'], 'seulement les deux onglets');
  assert.deepEqual(etat.compteurs.recus, []);
  assert.match(resultat.precision, /4 échéances payées, 4 déjà dans vos documents/);
});

for (const [variante, nature, motif] of [
  ['non-pdf', 'sans-pdf', /Alma a remis autre chose qu'un reçu PDF/],
  ['ailleurs', 'ailleurs', /le reçu venait d'un autre site qu'Alma/],
  ['rien', 'rien', /Alma n'a rien remis/],
]) {
  test(`D2 — « Télécharger le reçu » ne rend pas de PDF (${variante}) : plus aucun geste, pas même la croix ; c'est dit`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.compteAlma({ variante });
    const { resultat, erreur, journal, lignes } = await passer(etat, { ouverture: { delaiDocumentMs: 3_000 } });
    assert.equal(erreur, null, erreur?.message);
    seulementLesGestesPermis(journal, etat);
    assert.deepEqual(resultat.invoices, []);
    assert.equal(compte(journal, 'download-receipt'), 1, 'un seul essai');
    assert.equal(compte(journal, 'modal-close-button'), 0, 'plus aucun geste, pas même la croix');
    assert.equal(journal.gestes.filter((g) => g.testid.startsWith('payment-schedule-line-')).length, 1);
    assert.match(resultat.precision, motif);
    assert.match(resultat.precision, /crabe n'a plus rien cliqué pendant ce passage ; 3 autres reçus n'ont pas été demandés/);
    assert.equal(resultat.manquees, 4);
    // La page ouvre elle-même l'autre domaine (le navigateur le demande) ; crabe n'en lit rien (lot 102).
    if (variante === 'ailleurs') assert.ok(lignes.some((l) => /hors des domaines permis : rien n'en a été lu/.test(l)), lignes.join('\n'));
    assert.ok(lignes.some((l) => l.includes(`gestes arrêtés (${nature})`)), lignes.join('\n'));
    outils.journalSansDonnee(lignes);
  });
}

// ---------------------------------------------------------------------------
// D4 — les pièges ; D5 — session et temps
// ---------------------------------------------------------------------------

test('D4 — à côté, visibles : « Payer maintenant », « Modifier mes échéances », « Demander un retour », « Changer de moyen de paiement » dans la fenêtre, « Se déconnecter » — rien n\'est touché', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma();
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur, null);
  seulementLesGestesPermis(journal, etat);
  assert.deepEqual(journal.avortees, []);
});

test('D5 — session expirée : « session expirée », aucun geste', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ connecte: false });
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur?.sessionExpired, true, erreur?.message);
  assert.deepEqual(journal.gestes, []);
});

test('D5 — la session tombe au milieu : les reçus pris sont gardés', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ sessionMeurtApresRecus: 2 });
  const { resultat, erreur, journal } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  seulementLesGestesPermis(journal, etat);
  assert.equal(resultat.invoices.length, 2);
  assert.match(resultat.precision, /Alma a demandé de vous reconnecter : les reçus déjà pris sont gardés/);
});

test('D5 — le temps permis s\'écoule au milieu : ce qui est pris est gardé', faux.SANS_NAVIGATEUR, async () => {
  const h = outils.horlogeASaut();
  const etat = faux.compteAlma({ surPdf: (n) => { if (n === 3) h.saut(); } });
  const { resultat, erreur } = await passer(etat, { ouverture: { maintenant: h.maintenant } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 3);
  assert.match(resultat.precision, /La récupération a pris tout le temps permis : 1 reçu attend encore/);
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

  test('D6 — quatre reçus rangés, puis rien de nouveau ; le journal applicatif ne porte aucune donnée', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot104alma');
    let { r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteAlma(), user });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '4 factures récupérées — Alma : 2 achats lus, 4 échéances payées, 1 échéance pas encore payée (pas de reçu pour l\'instant).');
    assert.deepEqual(outils.documents(db, user, ID).map((d) => d.remote_id), ANCRES);
    ({ r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteAlma(), user }));
    assert.equal(r.message, 'Aucune nouvelle facture — Alma : 2 achats lus, 4 échéances payées, 4 déjà dans vos documents, '
      + '1 échéance pas encore payée (pas de reçu pour l\'instant).');
    assert.equal(outils.documents(db, user, ID).length, 4);
    outils.journalApplicatifSansDonnee(db);
  });
});
