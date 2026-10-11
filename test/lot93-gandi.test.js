'use strict';

/**
 * Lot 93 — Gandi : un connecteur neuf, qui ne fait que des navigations.
 *
 * Les factures de Gandi sont de SIMPLES LIENS vers des PDF, par organisation
 * (structure lue dans le code source de deux pages enregistrées par l'utilisateur le
 * 06/10/2026). Le connecteur suit la liste des organisations, les pages de
 * factures de chaque organisation retenue, puis chaque lien `…/pdf` — sans un
 * clic, sans une saisie.
 *
 * Ces essais tournent au VRAI Chromium sur des pages RECONSTITUÉES fidèles à
 * cette structure (test/lot93-faux-sites.js) : ils prouvent la lecture de
 * cette forme, pas le vrai site. Le connecteur ouvre son propre navigateur ;
 * le banc ne remplace que son lancement (`ouverture.lancer`), et branche le
 * faux site sur chaque contexte — contrôle de session, journal de navigation
 * et fermeture sont éprouvés tels quels. Aucune requête ne sort.
 *
 * ⚠ Toutes les valeurs sont inventées : organisations « Organisation d'essai
 * … », identifiants faits de zéros, numéros « ZZ… », montants à 0,00 €.
 *
 * ─── Lot 95 : le banc dit la vérité, quatre essais modifiés par décision ─────
 *
 * Le lien « …/pdf » n'est PAS le PDF : il sert une page de l'application, et
 * le fichier vient de l'API de facturation (mesuré le 06/10/2026, passage
 * n° 708 puis sondes de l'utilisateur). Le banc (`siteGandi`) sert désormais la page au
 * lien et le PDF à l'API ; le connecteur prend le PDF à l'API. Avec le banc
 * mis au vrai et l'ancien code, 21 essais Gandi des lots 93 et 94 tombaient
 * (tous supposaient le PDF au lien) ; avec le nouveau code, 17 repassent sans
 * retouche. Les quatre suivants verrouillaient ce que le lot 95 renverse ; ils
 * sont modifiés, leur objet inchangé :
 *
 *   - « D5 — par construction » : la demande du PDF se fait à
 *     `api.adresse`, plus à `doc.adresse` (objet : aucun geste, le PDF pris
 *     dans l'onglet, aucun client HTTP à part) ;
 *   - « D5 — une réponse qui n'est pas un PDF » : la ligne du journal dit
 *     désormais la taille en chiffres et ce que le document était (R6), au
 *     lieu de « ## » (objet : rien de déposé, manquée comptée, dite) ;
 *   - « D6 — session perdue en route » et « session perdue en route puis au
 *     passage suivant » : les factures qui n'ont plus été demandées après
 *     l'arrêt comptent comme non obtenues (R4) — « 57 non obtenues » (objet :
 *     les factures prises sont gardées, l'interruption est dite, la cause est
 *     classée par le lot 91).
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const pageDocs = require('../server/connectors/documents-de-page');
const gandi = require('../server/connectors/available/gandi/connector');
const faux = require('./lot93-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'gandi', 'connector.js');
const HOTES = [faux.GANDI_ADMIN, faux.GANDI_ID];
const ORG = (n) => faux.idOrganisation(n);

/**
 * Un passage DIRECT du connecteur (hors planificateur) sur le faux site.
 * `ctxExtra` complète le contexte (knownRemoteIds, reconcile…).
 */
async function passer(etat, { config = {}, ctxExtra = {} } = {}) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandi(etat));
  const original = gandi.ouverture.lancer;
  gandi.ouverture.lancer = banc.lancer;
  const lignes = [];
  const preuves = [];
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await gandi.fetchInvoices(
        { session: faux.sessionInventee(), historique: 'depuis', ...config },
        { userId: 1, log: (m) => lignes.push(String(m)), preuveDeListe: (p) => preuves.push(p), knownRemoteIds: [], ...ctxExtra }
      );
    } catch (err) {
      erreur = err;
    }
    assert.ok(banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
    return { resultat, erreur, journal: banc.journal, lignes, preuves, ouverts: banc.ouverts() };
  } finally {
    gandi.ouverture.lancer = original;
    await banc.fermer();
  }
}

/** Ce qui doit tenir à CHAQUE passage : rien de cliqué, rien de saisi, rien de sorti, rien d'interdit visité. */
function rienQueDesNavigations(journal, etat) {
  assert.deepEqual(journal.clics, [], `aucun clic — la page les compte : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, [], 'aucune saisie');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.equal(etat.compteurs.deconnexion, 0, '/billing/api/v5/logout n\'est jamais approché');
  for (const v of journal.visites) {
    assert.doesNotMatch(v, /logout|cart|autorenew|settings|prepaid|orders|overview|sort=|statut=/,
      `visite hors du parcours : ${v}`);
  }
}

const NOM_ATTENDU = /^gandi_\d{4}-\d{2}_ZZ[A-Z]\d{6}(-\d+)?\.pdf$/;

let enLigneScraping;

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D4 — pages fidèles : trois organisations, cinq pages, tout est pris
// ---------------------------------------------------------------------------

test('D4 — trois organisations, liens relatifs et absolus, cinq pages : les 62 factures prises, ancrées sur le numéro, nommées sans collision, datées', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 62, '47 + 3 + 12');
  assert.equal(etat.compteurs.pdf.length, 62, 'chaque PDF demandé une fois');

  // L'ancre : l'organisation et le numéro lus dans le lien — uniques.
  const ancres = resultat.invoices.map((f) => f.remoteId);
  assert.equal(new Set(ancres).size, 62);
  assert.ok(ancres.every((a) => /^gandi-00000000-0000-4000-8000-0{11}[123]-ZZ[ABC]\d{6}$/.test(a)), ancres[0]);
  // Le nom : jamais deux fois le même, la période d'après la colonne « Date ».
  const noms = resultat.invoices.map((f) => f.filename);
  assert.equal(new Set(noms).size, 62, 'aucune collision de nom');
  assert.ok(noms.every((n) => NOM_ATTENDU.test(n)), noms.find((n) => !NOM_ATTENDU.test(n)));
  // Les mois abrégés : la première facture de A est d'octobre 2026, la neuvième de février.
  const deA = resultat.invoices.filter((f) => f.accountId === ORG(1));
  assert.equal(deA.length, 47);
  assert.equal(deA[0].issuedOn, '2026-10-01');
  assert.equal(deA[0].filename, 'gandi_2026-10_ZZA009000.pdf');
  assert.equal(deA[8].issuedOn, '2026-02-09', '« 9 févr. 2026 »');
  assert.equal(deA[1].issuedOn, '2026-09-02', '« 2 sept. 2026 »');
  assert.equal(deA[2].issuedOn, '2026-08-03', '« 3 août 2026 »');
  assert.equal(deA[3].issuedOn, '2026-07-04', '« 4 juil. 2026 »');
  // Le rangement : chaque facture dans le dossier de SON organisation.
  assert.deepEqual([...new Set(resultat.invoices.map((f) => f.accountId))].sort(), [ORG(1), ORG(2), ORG(3)]);
  assert.ok(resultat.invoices.every((f) => f.buffer.subarray(0, 5).toString('latin1') === '%PDF-'));

  // La pagination : cinq pages pour A, deux pour C, sans paramètre de plus.
  const pagesDeA = journal.visites.filter((v) => v.includes(`/billing/${ORG(1)}/invoices`));
  assert.deepEqual(pagesDeA.map((v) => v.replace(/^.*invoices/, '')), ['', '?page=2', '?page=3', '?page=4', '?page=5']);
  assert.match(texte, /organisation 1\/3 — 47 facture\(s\) vue\(s\) sur 5 page\(s\)\./);
  assert.match(texte, /organisation 3\/3 — 12 facture\(s\) vue\(s\) sur 2 page\(s\)\./);
  assert.equal(resultat.precision, '— Gandi : 3 organisations lues, 62 factures vues.');
  assert.deepEqual(resultat.couverture, { complete: true, detail: '3 organisations, toutes leurs pages de factures' });
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].elements, 62);
  assert.equal(resultat.accountId, ORG(1), 'le compte de repli : l\'organisation « Moi »');
  assert.ok(resultat.sessionRenouvelee, 'l\'état de session d\'un passage qui a lu la facturation est rendu');
  // Aucun nom d'organisation, aucun identifiant au journal.
  assert.doesNotMatch(texte, /Organisation d'essai|00000000-0000-4000/);
  assert.equal(ouverts, 0, 'le connecteur a refermé son navigateur');
  rienQueDesNavigations(journal, etat);
});

test('D4 — second passage : rien de repris, rien de redemandé', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const premier = await passer(etat);
  const connus = premier.resultat.invoices.map((f) => f.remoteId);
  const etat2 = faux.compteGandiDEssai();
  const second = await passer(etat2, { ctxExtra: { knownRemoteIds: connus } });
  assert.equal(second.erreur, null, second.erreur?.message);
  assert.deepEqual(second.resultat.invoices, []);
  assert.equal(etat2.compteurs.pdf.length, 0, 'aucun PDF redemandé');
  assert.equal(second.resultat.precision, '— Gandi : 3 organisations lues, 62 factures vues.');
  assert.equal(second.resultat.aucunDocument, undefined, 'des factures existent : ce n\'est pas « aucun document »');
  rienQueDesNavigations(second.journal, etat2);
});

test('D4 — deux organisations portant le même numéro : deux ancres, deux fichiers', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  etat.organisations[1].factures = [{ ...etat.organisations[0].factures[0], interne: '00000000-0000-0000-0000-000000000099' }];
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null);
  const memes = resultat.invoices.filter((f) => f.filename.startsWith('gandi_2026-10_ZZA009000'));
  assert.deepEqual(memes.map((f) => f.filename), ['gandi_2026-10_ZZA009000.pdf', 'gandi_2026-10_ZZA009000-2.pdf']);
  assert.notEqual(memes[0].remoteId, memes[1].remoteId);
  assert.notEqual(memes[0].accountId, memes[1].accountId);
});

test('D4 — la date : « jour mois-abrégé année », espaces insécables compris', () => {
  const cas = {
    '12 févr. 2026': '2026-02-12', '3 sept. 2025': '2025-09-03', '5 août 2024': '2024-08-05',
    '1 juil. 2023': '2023-07-01', '30 oct. 2022': '2022-10-30', '7 déc. 2021': '2021-12-07',
    '15 janv. 2026': '2026-01-15', '2 avr. 2026': '2026-04-02', '9 mai 2026': '2026-05-09',
    '4 juin 2026': '2026-06-04', '11 nov. 2025': '2025-11-11', '20 mars 2026': '2026-03-20',
    '12 févr. 2026': '2026-02-12',
  };
  for (const [texte, iso] of Object.entries(cas)) assert.equal(pageDocs.dateDepuisTexte(texte), iso, texte);
  for (const m of faux.MOIS_ABREGES) assert.ok(pageDocs.dateDepuisTexte(`1 ${m} 2026`), m);
});

// ---------------------------------------------------------------------------
// D5 — aucun clic, aucune saisie ; ce qui n'est pas un PDF n'est pas déposé
// ---------------------------------------------------------------------------

test('D5 — par construction : le fichier du connecteur ne porte AUCUN clic, aucune saisie, aucun geste', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const geste of [/\.click\s*\(/, /\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/,
    /\.check\s*\(/, /\.uncheck\s*\(/, /\.selectOption\s*\(/, /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/,
    /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/, /\.hover\s*\(/, /\.focus\s*\(/, /keyboard\./,
    /mouse\./, /touchscreen\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.\$\$?\s*\(/, /\.accept\s*\(/,
    /waitForEvent\s*\(\s*['"]download/]) {
    assert.doesNotMatch(code, geste, `aucun geste sur la page (${geste})`);
  }
  // Les seules navigations : `page.goto`, dans `naviguer`.
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule fonction navigue');
  // Le PDF se prend dans l'onglet, jamais par un client HTTP à part — à
  // l'adresse d'API construite depuis le lien (lot 95), plus au lien.
  assert.match(code, /ongletPdf\.fluxDeLaPage\(page, api\.adresse\)/);
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch|ctx\.fetch/,
    'aucun client HTTP hors du navigateur');
});

test('D5 — la page compte : 0 clic, 0 saisie ; « ⋮ », « Exporter une période », filtres, panier et déconnexion jamais approchés', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur, null);
  rienQueDesNavigations(journal, etat);
  assert.ok(!journal.requetes.some((r) => /shop\.gandi\.net/.test(r)), 'le panier n\'est pas demandé');
});

test('D5 — une réponse qui n\'est pas un PDF : rien de déposé, manquée comptée, dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  etat.pdfHtml = ['ZZB008999'];
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null);
  assert.equal(resultat.invoices.length, 61);
  assert.ok(!resultat.invoices.some((f) => f.remoteId.endsWith('ZZB008999')), 'la page d\'erreur n\'est pas déposée');
  assert.equal(resultat.manquees, 1);
  // Lot 95 (R6) : la taille en chiffres, et ce que le document était.
  assert.match(lignes.join('\n'), /une facture n'a pas pu être prise : le document a rendu \d+ octets qui ne sont pas un PDF \[reçu : page web \(HTML\), type déclaré application\/pdf, \d+ octets, sans redirection\]/);
  assert.equal(resultat.couverture.complete, false);
});

// ---------------------------------------------------------------------------
// D6 — organisations sans facture, décochées, disparues, nouvelles ; session
// ---------------------------------------------------------------------------

for (const forme of ['sans-tableau', 'tableau-vide']) {
  test(`D6 — une organisation sans facture (${forme}) : pas un échec, et c'est dit`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.compteGandiDEssai({ sansFactureForme: forme });
    etat.organisations[1].factures = [];
    const { resultat, erreur, journal } = await passer(etat);
    assert.equal(erreur, null, erreur?.message);
    assert.equal(resultat.invoices.length, 59);
    assert.equal(resultat.precision, '— Gandi : 3 organisations lues, 59 factures vues. Une organisation n\'a aucune facture.');
    rienQueDesNavigations(journal, etat);
  });
}

test('D6 — aucune facture nulle part : « aucun document », sans échec', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  for (const o of etat.organisations) o.factures = [];
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null);
  assert.equal(resultat.aucunDocument, 'Votre compte Gandi a bien été lu : 3 organisations, aucune facture pour l\'instant.');
  assert.equal(resultat.precision, undefined);
});

test('D6 — une organisation décochée (choix précis) n\'est pas même visitée', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const { resultat, erreur, journal } = await passer(etat, { config: { organisations: [ORG(1), ORG(3)] } });
  assert.equal(erreur, null);
  assert.equal(resultat.invoices.length, 59);
  assert.ok(!journal.requetes.some((r) => r.includes(ORG(2))), 'aucune requête vers l\'organisation décochée');
  rienQueDesNavigations(journal, etat);
});

test('D6 — aucune organisation cochée : rien n\'est récupéré, et la fiche le dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const { resultat, erreur, journal } = await passer(etat, { config: { organisations: [] } });
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices, []);
  assert.match(resultat.aucunDocument, /^Aucune organisation n'est cochée dans la fiche de Gandi/);
  assert.ok(!journal.visites.some((v) => /invoices/.test(v)));
});

test('D6 — session perdue en route : les factures prises sont GARDÉES, l\'interruption est dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ sessionMeurtApresPdf: 5 });
  const { resultat, erreur, lignes, journal } = await passer(etat);
  assert.equal(erreur, null, 'rien ne se perd : pas d\'exception une fois des factures prises');
  assert.equal(resultat.invoices.length, 5);
  assert.match(resultat.precision, /La lecture s'est interrompue — Gandi a demandé de vous reconnecter : les factures déjà prises sont gardées/);
  assert.equal(resultat.sessionRenouvelee, undefined, 'jamais l\'état d\'une session renvoyée vers la connexion');
  // Lot 95 (R4) : un arrêt avant la fin — ici la session tombée — laisse
  // 57 factures non demandées ; elles comptent comme non obtenues.
  assert.equal(resultat.manquees, 57, 'les factures non demandées après l\'arrêt sont non obtenues (lot 95)');
  assert.match(lignes.join('\n'), /les 5 déjà prise\(s\) sont gardées/);
  assert.deepEqual(journal.fuites, []);
});

test('D6 — session tombée avant toute facture : un renvoi, marqué pour la règle du lot 91', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ connecte: false });
  const { erreur, journal, lignes, preuves } = await passer(etat);
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(lignes.join('\n'), /arrivée jugée « connexion-demandee » — renvoyé vers id\.gandi\.net\/fr\/login/);
  assert.equal(preuves.length, 0);
  assert.deepEqual(journal.fuites, []);
});

// ---------------------------------------------------------------------------
// R7, R11 — l'arrivée, la page illisible, le temps
// ---------------------------------------------------------------------------

test('R7 — la session de facturation se rouvre par Gandi ID : le détour par l\'autorisation qui revient est un succès', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ sessionFacturation: false });
  const { resultat, erreur, lignes, journal } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.equal(etat.compteurs.autorisations, 1, 'un seul passage par l\'autorisation');
  assert.equal(resultat.invoices.length, 62);
  assert.match(lignes.join('\n'), /navigation — .*id\.gandi\.net \/fr\/authorize/);
  assert.match(lignes.join('\n'), /arrivée jugée « liste »/);
  rienQueDesNavigations(journal, etat);
});

test('R11 — la facturation méconnaissable : « page illisible », sans renvoi ni « rouvrez »', faux.SANS_NAVIGATEUR, async () => {
  const { erreur } = await passer(faux.compteGandiDEssai({ listeIllisible: true }));
  assert.ok(erreur);
  assert.match(erreur.message, /a bien ouvert votre facturation, mais crabe n'a pas su la lire/);
  assert.match(erreur.message, /Votre connexion n'est pas en cause : inutile de la rouvrir/);
  assert.notEqual(erreur.sessionExpired, true);
});

test('R11 — la page de factures d\'UNE organisation méconnaissable : dite, les autres lues', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ facturesIllisibles: [ORG(3)] });
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null);
  assert.equal(resultat.invoices.length, 50);
  assert.match(resultat.precision, /La page des factures de 1 organisation n'a pas pu être lue/);
  assert.match(lignes.join('\n'), /organisation 3\/3 — page de factures illisible \(un tableau inattendu/);
  assert.equal(resultat.couverture.complete, false);
});

test('R11 — les pages de factures de TOUTES les organisations méconnaissables : « page illisible »', faux.SANS_NAVIGATEUR, async () => {
  const { erreur } = await passer(faux.compteGandiDEssai({ facturesIllisibles: [ORG(1), ORG(2), ORG(3)] }));
  assert.ok(erreur);
  assert.match(erreur.message, /n'a pas su la lire/);
  assert.notEqual(erreur.sessionExpired, true);
});

test('R11 — le temps : passé les 2/3 de la limite, le passage s\'arrête et rend ce qu\'il a pris ; le suivant reprend', faux.SANS_NAVIGATEUR, async () => {
  const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
  const horloge = gandi.ouverture.maintenant;
  process.env.CRABE_LIMITE_EXECUTION_MS = String(30 * 60 * 1000);
  try {
    // L'horloge n'avance qu'à chaque PDF servi : 4 minutes par facture. Budget
    // 20 minutes (2/3 de 30) : cinq factures, puis l'arrêt.
    let t = 0;
    gandi.ouverture.maintenant = () => t;
    const etat = faux.compteGandiDEssai({ surPdf: () => { t += 4 * 60 * 1000; } });
    const premier = await passer(etat);
    assert.equal(premier.erreur, null, premier.erreur?.message);
    assert.equal(premier.resultat.invoices.length, 6, 'cinq factures dans le budget, la sixième le dépasse et est gardée');
    assert.match(premier.resultat.precision,
      /La récupération a pris tout le temps permis : 56 factures attendent encore ; elles viendront au prochain passage\. Rien de ce qui a été pris n'est perdu\./);
    assert.equal(premier.resultat.couverture.complete, false);

    // Le passage suivant reprend où le premier s'est arrêté, même en
    // « Depuis la dernière récupération » : les plus anciennes ne sont pas perdues.
    t = 0;
    const etat2 = faux.compteGandiDEssai({ surPdf: () => { t += 10 * 1000; } });
    const second = await passer(etat2, { ctxExtra: { knownRemoteIds: premier.resultat.invoices.map((f) => f.remoteId) } });
    assert.equal(second.erreur, null);
    assert.equal(second.resultat.invoices.length, 56, 'le reste, au passage suivant');
    assert.equal(new Set([...premier.resultat.invoices, ...second.resultat.invoices].map((f) => f.remoteId)).size, 62);
  } finally {
    gandi.ouverture.maintenant = horloge;
    if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
  }
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('les adresses : organisation, facture, pagination — relatives ou absolues, rien d\'autre', () => {
  const o = ORG(1);
  assert.equal(gandi.organisationDepuisAdresse(`/billing/${o}/overview`), o);
  assert.equal(gandi.organisationDepuisAdresse(`https://admin.gandi.net/billing/${o}/overview`), o);
  assert.equal(gandi.organisationDepuisAdresse(`https://admin.gandi.net/billing/${o}/invoices?page=2`), o);
  assert.equal(gandi.organisationDepuisAdresse(`https://shop.gandi.net/billing/${o}/overview`), null, 'un autre hôte');
  assert.equal(gandi.organisationDepuisAdresse('/billing/api/v5/logout'), null);
  assert.equal(gandi.organisationDepuisAdresse(`/billing/${o}/settings`), null);

  const f = gandi.factureDepuisAdresse(`/billing/${o}/invoices/00000000-0000-0000-0000-000000000001/ZZA000001/pdf`);
  assert.deepEqual(f, {
    organisation: o, interne: '00000000-0000-0000-0000-000000000001', numero: 'ZZA000001',
    adresse: `https://admin.gandi.net/billing/${o}/invoices/00000000-0000-0000-0000-000000000001/ZZA000001/pdf`,
  });
  assert.equal(gandi.factureDepuisAdresse(`/billing/${o}/invoices/x/ZZA000001/csv`), null, 'pas un PDF');
  assert.equal(gandi.factureDepuisAdresse(`http://admin.gandi.net/billing/${o}/invoices/x/ZZA000001/pdf`), null, 'pas en HTTPS');

  const liste = `https://admin.gandi.net/billing/${o}/invoices`;
  assert.deepEqual(gandi.pagesSuivantes([
    `/billing/${o}/invoices?page=1`, '?page=3', '?page=2&sort=-date', `/billing/${o}/invoices?page=2`,
    `/billing/${ORG(2)}/invoices?page=4`, 'https://autre.invalid/?page=5', '?page=abc',
  ], `${liste}?page=1`), [`${liste}?page=2`, `${liste}?page=3`],
  'la page 1 n\'est jamais suivie, un autre paramètre est retiré, une autre liste ignorée');
});

test('l\'arrivée : liste, connexion demandée, page illisible, organisation unique', () => {
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://admin.gandi.net/billing', organisations: 3 }).verdict, 'liste');
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://admin.gandi.net/billing', organisations: 0 }).verdict, 'page-illisible');
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://id.gandi.net/fr/login?redirect=x' }).verdict, 'connexion-demandee');
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://admin.gandi.net/billing/api/v5/login?redirect=x' }).verdict, 'connexion-demandee');
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://admin.gandi.net/dashboard' }).verdict, 'page-illisible');
  assert.deepEqual(gandi.jugerArrivee({ urlFinale: `https://admin.gandi.net/billing/${ORG(1)}/overview` }), {
    verdict: 'organisation-unique', raison: 'la facturation s\'est ouverte directement sur une organisation', organisation: ORG(1),
  });
});

test('le journal ne porte ni identifiant d\'organisation ni longue suite de chiffres', () => {
  assert.equal(gandi.masquer('200 admin.gandi.net /billing/a1b2c3d4-e5f6-11e6-a548-00163e60d80f/invoices'),
    '200 admin.gandi.net /billing/…/invoices');
  assert.equal(gandi.masquer('302 admin.gandi.net /billing/api/v5/login'), '302 admin.gandi.net /billing/api/v5/login');
  assert.equal(gandi.masquer('n° 1234567'), 'n° …');
});

test('ce que l\'écran lit, selon le passage — des nombres, jamais un nom', () => {
  const base = { organisationsLues: 3, facturesVues: 62, sansFacture: 0, illisibles: 0, bornePages: 0,
    restantes: 0, interruption: null, nouvellesRetenues: 0, nouvellesIgnorees: 0, disparues: 0 };
  assert.equal(gandi.precisionDuPassage(base), '— Gandi : 3 organisations lues, 62 factures vues.');
  assert.match(gandi.precisionDuPassage({ ...base, nouvellesRetenues: 1 }),
    /Une organisation est apparue sur votre compte depuis la dernière récupération : elle est lue avec les autres/);
  assert.match(gandi.precisionDuPassage({ ...base, nouvellesIgnorees: 2 }),
    /2 organisations sont apparues sur votre compte : comme vous avez choisi vos organisations une par une, elle n'est pas récupérée\. Cochez-la/);
  assert.match(gandi.precisionDuPassage({ ...base, disparues: 1 }),
    /Une organisation que vous aviez cochée n'apparaît plus sur votre compte Gandi : elle est ignorée, les autres ont été lues/);
  assert.match(gandi.precisionDuPassage({ ...base, interruption: 'temps', restantes: 0, lectureInterrompue: true }),
    /La récupération a pris tout le temps permis : la suite viendra au prochain passage\./);
  assert.equal(gandi.precisionDuPassage({ ...base, organisationsLues: 1, facturesVues: 1 }),
    '— Gandi : 1 organisation lue, 1 facture vue.');
});

test('le budget de temps : les 2/3 de la limite du planificateur, réglable comme elle', () => {
  const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
  try {
    delete process.env.CRABE_LIMITE_EXECUTION_MS;
    assert.equal(gandi.LIMITE_EXECUTION_DEFAUT_MS, scheduler.LIMITE_EXECUTION_MS, 'la même limite que le planificateur');
    assert.equal(gandi.budgetMs(), 30 * 60 * 1000);
    process.env.CRABE_LIMITE_EXECUTION_MS = '3000';
    assert.equal(gandi.budgetMs(), 2000);
  } finally {
    if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
  }
});

test('une organisation devient un élément de la fiche : son nom, « Moi », cochée d\'office', () => {
  assert.deepEqual(gandi.enElementDecouvert({ id: ORG(1), nom: 'Organisation d\'essai A', moi: true }), {
    id: ORG(1), label: 'Organisation d\'essai A', detail: 'Votre organisation personnelle', preselected: true,
  });
  assert.equal(gandi.enElementDecouvert({ id: ORG(2), nom: '' }).label, 'Organisation sans nom');
});

test('R12 — Gandi au catalogue : en attente d\'essai, sa description, sa réserve, son aide, sa pastille ; la note technique ne sort pas', () => {
  const ligne = db.get().prepare('SELECT category, status FROM connector_catalog WHERE connector_id = ?').get('gandi');
  assert.deepEqual(ligne, { category: 'hebergement', status: 'pending' }, 'jamais essayé sur un compte réel : en attente');
  const schema = require('../server/connectors/manifest-schema');
  const vue = schema.publicView(registry.manifest('gandi'));
  assert.equal(vue.name, 'Gandi');
  assert.equal(vue.site, 'www.gandi.net', 'le logo se prend sur le site de Gandi (logos.js)');
  assert.equal(vue.letters, 'G');
  assert.match(vue.color, /^#[0-9a-f]{6}$/i);
  assert.match(vue.description, /^Récupère les factures de vos organisations Gandi/);
  // Lot 101 : Gandi a rangé ses factures sur un vrai compte (mesuré en
  // production) — la réserve ne le nie plus, et garde la connexion par fenêtre.
  assert.doesNotMatch(vue.caveat, /Pas encore essayé/);
  assert.match(vue.caveat, /^Vous ouvrez la connexion vous-même, dans une fenêtre/);
  assert.equal(vue.technicalNote, undefined, 'la note technique reste à l\'administration');
  assert.equal(vue.remoteLogin.url, 'https://id.gandi.net/fr/login');
  assert.match(vue.remoteLogin.hint, /cliquez sur Enregistrer/);
  assert.equal(vue.discovery, true, 'une étape de choix après la connexion');
  for (const champ of vue.fields) assert.ok(champ.help, `aide du champ ${champ.key}`);
  assert.deepEqual(vue.fields.map((f) => f.key), ['session', 'organisations', 'historique']);
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur et le vrai manifeste : dépôt, rangement, choix
// ---------------------------------------------------------------------------

/** Installe le vrai Gandi pour un compte neuf, connexion enregistrée. */
async function compteAvecGandi(nom) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, 'gandi');
  registry.saveConfig(user.id, 'gandi', { session: faux.sessionInventee() }, { origine: 'fenetre' });
  return user;
}

/**
 * L'instance du connecteur que le REGISTRE exécute. ⚠ Ce n'est pas celle du
 * `require` en tête de ce fichier : le registre vide `require.cache` avant
 * chaque chargement. Mesuré à l'écriture de ces essais (06/10/2026) : remplacer
 * le lancement sur l'autre instance laissait le planificateur ouvrir un VRAI
 * Chromium vers le vrai admin.gandi.net — six passages, renvoyés vers la page
 * de connexion publique de Gandi ID. D'où le lancement réel INTERDIT par
 * défaut ci-dessous, et la preuve, à chaque passage, que le faux a servi.
 */
const instanceDuRegistre = () => registry.get('gandi').module;

/** Un passage par `runForUser`, sur le faux site. */
async function parLePlanificateur(user, etat) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandi(etat));
  const instance = instanceDuRegistre();
  const original = instance.ouverture.lancer;
  instance.ouverture.lancer = banc.lancer;
  try {
    const r = await scheduler.runForUser(user.id, 'gandi', 'manual');
    assert.ok(banc.lancements() >= 1, `le planificateur a ouvert le FAUX navigateur, aucun autre (${r.message})`);
    rienQueDesNavigations(banc.journal, etat);
    return { r, journal: banc.journal };
  } finally {
    instance.ouverture.lancer = original;
    await banc.fermer();
  }
}

function journalDe(user) {
  return db.get().prepare("SELECT message FROM app_logs WHERE user_id = ? OR source = 'scheduler' ORDER BY id")
    .all(user.id).map((l) => l.message).join('\n');
}

test.describe('par le vrai planificateur', () => {
  let lancementReel;
  test.before(() => {
    // Les essais ouvrent un vrai Chromium sur le faux site : le verrou des
    // essais (CRABE_DISABLE_SCRAPING) est levé le temps de ces passages —
    // mais le lancement RÉEL est interdit : seul le faux lanceur, posé passage
    // par passage, peut ouvrir un navigateur.
    const configuration = require('../server/config').config;
    enLigneScraping = configuration.scrapingDisabled;
    configuration.scrapingDisabled = false;
    lancementReel = instanceDuRegistre().ouverture.lancer;
    instanceDuRegistre().ouverture.lancer = () => {
      throw new Error('essai : lancement d\'un vrai navigateur interdit — le faux site n\'a pas été branché');
    };
    destinations.restoreLocal();
  });
  test.after(() => {
    require('../server/config').config.scrapingDisabled = enLigneScraping;
    instanceDuRegistre().ouverture.lancer = lancementReel;
  });

  test('62 factures déposées, une ligne chacune, rangées par organisation ; le second passage ne reprend rien', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot93g1');
    let { r } = await parLePlanificateur(user, faux.compteGandiDEssai());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '62 factures récupérées — Gandi : 3 organisations lues, 62 factures vues.');
    const lignes = db.get().prepare('SELECT filename, remote_id, account_id FROM invoices WHERE user_id = ? AND connector_id = ?')
      .all(user.id, 'gandi');
    assert.equal(lignes.length, 62);
    assert.deepEqual([...new Set(lignes.map((l) => l.account_id))].sort(), [ORG(1), ORG(2), ORG(3)]);
    assert.equal(new Set(lignes.map((l) => l.filename)).size, 62);

    ({ r } = await parLePlanificateur(user, faux.compteGandiDEssai()));
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Aucune nouvelle facture — Gandi : 3 organisations lues, 62 factures vues.');
    assert.equal(db.get().prepare('SELECT COUNT(*) n FROM invoices WHERE user_id = ?').get(user.id).n, 62);
    assert.doesNotMatch(journalDe(user), /Organisation d'essai/, 'aucun nom d\'organisation au journal');
  });

  test('« toutes » (le défaut) : rien n\'est enregistré comme choix, et une organisation NOUVELLE est récupérée et dite', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot93g2');
    const etat = faux.compteGandiDEssai();
    etat.organisations.pop();
    let { r } = await parLePlanificateur(user, etat);
    assert.equal(r.ok, true, r.message);
    assert.equal(registry.readConfig(user.id, 'gandi').organisations, undefined, '« toutes » ne s\'écrit pas comme un choix');

    const avecNouvelle = faux.compteGandiDEssai();
    ({ r } = await parLePlanificateur(user, avecNouvelle));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /^12 factures récupérées — Gandi : 3 organisations lues, 62 factures vues\. Une organisation est apparue sur votre compte depuis la dernière récupération : elle est lue avec les autres/);
    assert.equal(registry.readConfig(user.id, 'gandi').organisations, undefined, 'toujours « toutes »');
    assert.match(journalDe(user), /gandi : 1 organisation\(s\) apparue\(s\) depuis la dernière fois — retenue\(s\) d'office : toutes sont choisies/);
    assert.doesNotMatch(journalDe(user), new RegExp(ORG(3)), 'aucun identifiant d\'organisation au journal');
  });

  test('un choix précis : l\'organisation décochée n\'est pas visitée, une nouvelle n\'est PAS prise mais dite, une disparue est dite', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot93g3');
    const etat = faux.compteGandiDEssai();
    etat.organisations.pop();
    await parLePlanificateur(user, etat); // la découverte mémorise A et B
    // L'utilisateur coche A seule (comme l'écran l'enregistre).
    registry.saveConfig(user.id, 'gandi', { organisations: [ORG(1)] });

    const { r, journal } = await parLePlanificateur(user, faux.compteGandiDEssai());
    assert.equal(r.ok, true, r.message);
    assert.ok(!journal.requetes.some((q) => q.includes(ORG(2)) || q.includes(ORG(3))), 'ni B (décochée) ni C (nouvelle) visitées');
    assert.match(r.message, /Une organisation est apparue sur votre compte : comme vous avez choisi vos organisations une par une, elle n'est pas récupérée\. Cochez-la dans la fiche de Gandi/);
    assert.deepEqual(registry.readConfig(user.id, 'gandi').organisations, [ORG(1)], 'le choix précis n\'est pas élargi');
    const resume = registry.configSummary(user.id, 'gandi').discoveries.organisations;
    assert.deepEqual(resume.items.map((i) => i.id), [ORG(1), ORG(2), ORG(3)], 'la fiche montre aussi la nouvelle…');
    assert.deepEqual(resume.selection, [ORG(1)], '… décochée');

    // A disparaît du compte : dite, ignorée, sans faire échouer le passage.
    registry.saveConfig(user.id, 'gandi', { organisations: [ORG(1), ORG(2)] });
    const sansA = faux.compteGandiDEssai();
    sansA.organisations.shift();
    const suite = await parLePlanificateur(user, sansA);
    assert.equal(suite.r.ok, true, suite.r.message);
    assert.match(suite.r.message, /Une organisation que vous aviez cochée n'apparaît plus sur votre compte Gandi : elle est ignorée, les autres ont été lues/);
  });

  test('« toutes » se réenregistre depuis la fiche : la valeur « toutes » efface le choix précis', async () => {
    const user = await compteAvecGandi('lot93g4');
    registry.saveConfig(user.id, 'gandi', { organisations: [ORG(1)] });
    assert.deepEqual(registry.readConfig(user.id, 'gandi').organisations, [ORG(1)]);
    registry.saveConfig(user.id, 'gandi', { organisations: 'toutes' });
    assert.equal(registry.readConfig(user.id, 'gandi').organisations, undefined);
    assert.ok(registry.readConfig(user.id, 'gandi').session, 'la connexion n\'est pas touchée');
  });

  test('session perdue en route puis au passage suivant : les factures prises restent, la cause est classée par le lot 91', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot93g5');
    let { r } = await parLePlanificateur(user, faux.compteGandiDEssai({ sessionMeurtApresPdf: 5 }));
    assert.equal(r.ok, true, 'des factures sont entrées : une réussite partielle');
    // Lot 95 (R4) : les 57 factures non demandées après l'arrêt sont dites non obtenues.
    assert.match(r.message, /^5 factures récupérées, 57 non obtenues — le prochain passage les réessaiera\. Gandi : .*La lecture s'est interrompue — Gandi a demandé de vous reconnecter/);
    assert.equal(db.get().prepare('SELECT COUNT(*) n FROM invoices WHERE user_id = ?').get(user.id).n, 5);

    ({ r } = await parLePlanificateur(user, faux.compteGandiDEssai({ connecte: false })));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree', 'une réussite a suivi la connexion : c\'est une expiration');
    assert.equal(db.get().prepare('SELECT COUNT(*) n FROM invoices WHERE user_id = ?').get(user.id).n, 5, 'rien n\'est perdu');
  });

  test('renvoyé vers la connexion juste après l\'avoir enregistrée : « connexion refusée »', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot93g6');
    const { r } = await parLePlanificateur(user, faux.compteGandiDEssai({ connecte: false }));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'connexion-refusee');
  });
});

test.after(() => {
  helpers.teardown();
});
