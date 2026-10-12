'use strict';

/**
 * Lot 104 — Battle.net : l'historique des achats, lu page par page par le
 * seul geste permis (« Suivant »), et le détail de chaque achat imprimé en PDF.
 *
 * Ces essais tournent au VRAI Chromium sur des pages RECONSTITUÉES d'après la
 * structure annoncée (test/lot104-faux-sites.js), dessinées par script : ils
 * prouvent la lecture de cette forme, pas le vrai site. Aucune requête ne
 * sort ; la page compte elle-même chaque clic.
 *
 * ⚠ Valeurs inventées : commandes « ZZ9… », factures « 99… », montants à
 * 0,00 €, joueur « JoueurEssai#0000 ».
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const bnet = require('../server/connectors/available/battle-net/connector');
const faux = require('./lot104-faux-sites');
const outils = require('./lot104-outils');

const ID = 'battle-net';
const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', ID, 'connector.js');
const ACHATS = faux.compteBnet().achats;
const ANCRES = ACHATS.map((a) => `${ID}-facture-${a.facture}`);

const passer = (etat, options) => outils.passer(ID, bnet, etat, options);
const suivants = (journal) => journal.gestes.filter((g) => g.texte === 'Suivant').length;

/** Ce qui doit tenir à chaque passage : le seul geste est « Suivant ». */
function seulementSuivant(journal, etat) {
  outils.rienDInterdit(journal, etat);
  for (const g of journal.gestes) assert.equal(g.texte, 'Suivant', `un geste autre que « Suivant » : ${JSON.stringify(g)}`);
  assert.deepEqual(journal.choix, [], 'la liste « Région » n\'est jamais touchée');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// B2 / D4 — par construction : le fichier se lit
// ---------------------------------------------------------------------------

test('D4 — le fichier se LIT : un seul `.click(`, dans `cliquerSuivant`, sur le seul repère, gardes avant le clic ; aucun autre geste ; l\'attribut `user` jamais lu', () => {
  const code = outils.codeSansCommentaires(SOURCE);
  const clics = [...code.matchAll(/\.click\s*\(/g)];
  assert.equal(clics.length, 1, 'un seul clic dans tout le fichier');
  const { debut, fin, corps } = outils.corpsDe(code, 'async function cliquerSuivant(');
  assert.ok(clics[0].index > debut && clics[0].index < fin, 'et le clic est DANS cliquerSuivant');
  const clic = corps.indexOf('.click(');
  for (const garde of ['texte === geste.texte', 'exacts.length !== 1', 'isVisible()', 'JSON.stringify(encore) !== JSON.stringify(numerosLus)',
    '!== geste.texte']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < clic, `la garde « ${garde} » est présente, et avant le clic`);
  }
  assert.ok(Object.isFrozen(bnet.GESTES) && Object.isFrozen(bnet.GESTES.suivant), 'la liste des gestes est gelée');
  assert.deepEqual(Object.keys(bnet.GESTES), ['suivant']);
  assert.deepEqual({ ...bnet.GESTES.suivant }, { repere: 'div.transactions-table ul[role="menubar"] a[role="menuitem"]', texte: 'Suivant' });
  assert.equal((code.match(/cliquerSuivant\(/g) || []).length, 2, 'définie une fois, appelée une fois');
  for (const geste of [...outils.AUTRES_GESTES, /\.selectOption\s*\(/]) assert.doesNotMatch(code, geste, `aucun autre geste (${geste})`);
  assert.doesNotMatch(code, /getAttribute\(\s*['"]user['"]|\.user\b|dataset\.user/, 'l\'attribut `user` (BattleTag, courriel) n\'est jamais lu');
  assert.match(code, /hasAttribute\('authenticated'\)/);
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch/, 'aucun client HTTP hors du navigateur');
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule navigation');
  assert.match(code, /async function naviguer\(page, adresse\) \{\n\s+const mot = refusees\.motRefuse\(adresse\);/, 'qui passe d\'abord par les mots refusés');
  assert.equal((code.match(/\.pdf\s*\(/g) || []).length, 1, 'une seule impression : celle du détail');
  assert.doesNotMatch(code, /addStyleTag|addScriptTag|innerHTML\s*=|\.remove\(\)|setContent|emulateMedia/, 'la page n\'est jamais modifiée avant l\'impression');
  assert.equal((code.match(/chromium\.launch\s*\(/g) || []).length, 1, 'un seul lancement');
  assert.doesNotMatch(code, /launchPersistentContext|profilMarchand\.surLeProfil/, 'ni profil persistant, ni écran');
  assert.equal(bnet.PAGES_MAX, 50);
});

// Lot 105 (R1) : un lien `/transactions/<commande>/<facture>` qui porte une
// requête est ACCEPTÉ (chemin seul suivi) — il sort de la liste des refus ; un
// lien à requête d'une autre forme y entre. `parametres` s'ajoute au résultat.
test('l\'adresse d\'un détail : seule `https://account.battle.net/transactions/<commande>[/<facture>]` passe (avec requête : commande ET facture, lot 105)', () => {
  assert.deepEqual(bnet.adresseDuDetail('/transactions/ZZ900000001/9900000001'),
    { adresse: 'https://account.battle.net/transactions/ZZ900000001/9900000001', commande: 'ZZ900000001', facture: '9900000001', parametres: [] });
  assert.equal(bnet.adresseDuDetail('/transactions/ZZ900000001').facture, null);
  assert.equal(bnet.adresseDuDetail('/transactions/ZZ900000001/1234?x=1').adresse, 'https://account.battle.net/transactions/ZZ900000001/1234');
  for (const refus of ['', 'https://shop.battle.net/transactions/ZZ900000001/1234', 'http://account.battle.net/transactions/ZZ900000001/1234',
    '/transactions/ZZ900000001?x=1', '/transactions/ZZ900000001/1234#x', '/payment', '/logout', '/transactions/ZZ900000001/1234/checkout', '/checkout/ZZ900000001/1234',
    'javascript:alert(1)', '/transactions/zz1/1']) {
    assert.ok(bnet.adresseDuDetail(refus).refus, `refusée : ${refus}`);
  }
});

test('la pagination : « Suivant » seulement s\'il est là, sous la dernière page montrée, sous la borne ; une page identique arrête', () => {
  const p = (x) => bnet.decisionPagination({ n: 1, numeros: ['a'], suivant: true, courante: 1, pages: [1, 2], ...x });
  assert.equal(p({}), 'suivante');
  assert.equal(p({ suivant: false }), 'fin');
  assert.equal(p({ courante: 2 }), 'fin', 'la dernière page montrée, même si un lien « Suivant » y reste');
  assert.equal(p({ numeros: [] }), 'vide');
  assert.equal(p({ precedents: ['a'] }), 'identique');
  assert.equal(p({ n: 50 }), 'borne');
  assert.equal(p({ courante: null, pages: [] }), 'suivante', 'sans numéros lisibles, la présence du lien décide');
});

test('le journal : aucun numéro de commande, aucune suite de quatre chiffres', () => {
  assert.equal(bnet.pourLeJournal('commande ZZ900000001, facture 9900000001, 3 pages, /transactions/ZZ900000001/9900000001?ref=x'),
    'commande …, facture …, 3 pages, /transactions/…/…?…');
});

// ---------------------------------------------------------------------------
// D1 — douze achats sur deux pages
// ---------------------------------------------------------------------------

test('D1 — douze achats sur deux pages : un clic « Suivant », douze détails imprimés en PDF, douze ancres, douze noms', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.equal(suivants(journal), 1, 'un seul clic, sur « Suivant »');
  seulementSuivant(journal, etat);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES, 'l\'ancre : le numéro de facture de l\'adresse');
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-03-03', '2026-02-14', '2026-01-02', '2025-12-19', '2025-11-08',
    '2025-10-21', '2025-09-30', '2025-08-12', '2025-07-01', '2025-06-17', '2025-05-05', '2025-04-09'], 'la date de la ligne');
  assert.deepEqual(resultat.invoices.map((f) => f.filename).slice(0, 2), [`${ID}_2026-03_facture-${ACHATS[0].facture}.pdf`, `${ID}_2026-02_facture-${ACHATS[1].facture}.pdf`]);
  assert.equal(new Set(resultat.invoices.map((f) => f.filename)).size, 12);
  for (const f of resultat.invoices) {
    assert.equal(f.buffer.subarray(0, 5).toString('latin1'), '%PDF-', 'imprimé par le navigateur');
    assert.ok(f.buffer.length > 1000, 'une vraie page imprimée');
  }
  assert.deepEqual(etat.compteurs.details, ACHATS.map((a) => a.facture), 'chaque détail ouvert une fois, par son adresse');
  assert.equal(resultat.precision, '— Battle.net : 12 achats lus sur 2 pages de l\'historique. Battle.net ne fournit pas de facture : '
    + 'crabe enregistre en PDF la page de détail de chaque achat.');
  assert.deepEqual(resultat.couverture, { complete: true, detail: 'l\'historique des achats, 2 pages, 12 achats' });
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].elements, 12);
  assert.ok(resultat.sessionRenouvelee);
  assert.equal(ouverts, 0, 'le navigateur est refermé');
  outils.journalSansDonnee(lignes);
});

test('D1 — second passage : rien de nouveau, aucun détail rouvert', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet();
  const { resultat, erreur, journal } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(etat.compteurs.details, [], 'aucun détail ouvert');
  assert.equal(suivants(journal), 1, 'la liste est relue en entier pour le savoir');
  seulementSuivant(journal, etat);
  assert.match(resultat.precision, /12 achats lus sur 2 pages de l'historique, 12 déjà dans vos documents\./);
});

test('D1 — un lien « Suivant » resté sur la dernière page : pas de second clic (la page courante est la dernière montrée)', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ suivant: 'partout' });
  const { resultat, erreur, journal } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(suivants(journal), 1);
  assert.equal(resultat.couverture.complete, true);
});

test('D1 — une page suivante identique : la lecture s\'arrête, et l\'écran le dit ; les achats lus sont pris', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ suivant: 'identique' });
  const { resultat, erreur, journal, lignes } = await passer(etat, { ouverture: { delaiPageSuivanteMs: 3_000 } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(suivants(journal), 1, 'un seul clic : jamais de second essai');
  seulementSuivant(journal, etat);
  assert.equal(resultat.invoices.length, 10, 'la première page est prise');
  assert.match(resultat.precision, /Pages suivantes non lues : après le clic sur « Suivant », Battle\.net a montré les mêmes achats\./);
  assert.equal(resultat.couverture.complete, false);
  outils.journalSansDonnee(lignes);
});

// ---------------------------------------------------------------------------
// D4 — les pièges ; D5 — session et temps
// ---------------------------------------------------------------------------

test('D4 — à côté, visibles : la boutique, « Se déconnecter », « Moyens de paiement », « Jeux et abonnements », les autres onglets, la région, « Commander à nouveau » — rien n\'est touché', faux.SANS_NAVIGATEUR, async () => {
  const page = faux.pageListeBnet(faux.compteBnet());
  for (const piege of ['boutique', 'déconnexion', 'moyens de paiement', 'abonnements', 'onglet cadeaux', 'onglet porte-monnaie', 'région']) {
    assert.ok(page.includes(`data-piege="${piege}"`), `le piège « ${piege} » est dans la page`);
  }
  const etat = faux.compteBnet();
  const { erreur, journal } = await passer(etat);
  assert.equal(erreur, null);
  seulementSuivant(journal, etat);
  assert.deepEqual(journal.avortees, [], 'aucune requête vers un autre site');
});

test('D5 — session expirée : « session expirée », aucun geste', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ connecte: false });
  const { erreur, journal } = await passer(etat);
  assert.ok(erreur, 'le passage échoue');
  assert.equal(erreur.sessionExpired, true);
  assert.match(erreur.message, /renvoyé la lecture automatique vers sa page d'authentification/);
  assert.deepEqual(journal.gestes, []);
  assert.throws(() => bnet.lireSession({}), (err) => err.sessionExpired === true);
});

test('D5 — la session tombe au milieu : ce qui est pris est gardé, la suite est dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ sessionMeurtApresDetails: 3 });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 3);
  assert.equal(resultat.manquees, 9);
  assert.match(resultat.precision, /Battle\.net a demandé de vous reconnecter : les documents déjà pris sont gardés/);
  assert.equal(resultat.sessionRenouvelee, undefined, 'jamais d\'état de session après un renvoi');
});

test('D5 — le temps permis s\'écoule au milieu : ce qui est pris est gardé', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet();
  const h = outils.horlogeASaut();
  let n = 0;
  const maintenant = () => { if (etat.compteurs?.details?.length >= 4 && n++ === 0) h.saut(); return h.maintenant(); };
  const { resultat, erreur } = await passer(etat, { ouverture: { maintenant } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 4);
  assert.match(resultat.precision, /La récupération a pris tout le temps permis : 8 achats attendent encore/);
  assert.equal(resultat.manquees, undefined, 'le temps ne manque rien : la suite vient au passage suivant');
});

// ---------------------------------------------------------------------------
// D6 — par le vrai planificateur : le message, le journal applicatif
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  test('D6 — douze documents rangés, puis rien de nouveau ; le journal applicatif ne porte aucune donnée', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot104bnet');
    let { r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteBnet(), user });
    assert.equal(r.ok, true, r.message);
    // Le socle dit « factures » pour tout document (comme chez Deezer) : il n'est pas touché.
    assert.equal(r.message, '12 factures récupérées — Battle.net : 12 achats lus sur 2 pages de l\'historique. Battle.net ne '
      + 'fournit pas de facture : crabe enregistre en PDF la page de détail de chaque achat.');
    const docs = outils.documents(db, user, ID);
    assert.deepEqual(docs.map((d) => d.remote_id), ANCRES);
    ({ r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteBnet(), user }));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Aucune nouvelle facture — Battle.net : 12 achats lus sur 2 pages de l\'historique, 12 déjà dans '
      + 'vos documents. Battle.net ne fournit pas de facture : crabe enregistre en PDF la page de détail de chaque achat.');
    assert.equal(outils.documents(db, user, ID).length, 12);
    outils.journalApplicatifSansDonnee(db);
  });
});
