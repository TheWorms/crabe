'use strict';

/**
 * Lot 99 — Alfaliquid : les factures lues dans `table.table-history`, prises
 * dans l'onglet, sans un clic.
 *
 * Ces essais tournent au VRAI Chromium sur une page RECONSTITUÉE fidèle à la
 * structure du code source enregistré par l'utilisateur le 11/10/2026
 * (test/lot99-faux-sites.js) : ils prouvent la lecture de cette forme, pas le
 * vrai site. Le connecteur ouvre son propre navigateur ; le banc ne remplace
 * que son lancement (`ouverture.lancer`). Aucune requête ne sort.
 *
 * ⚠ Valeurs inventées : références « ZZESSAI… », numéros 9 000 00x, 0,00 €.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const alfaliquid = require('../server/connectors/available/alfaliquid/connector');
const faux = require('./lot99-faux-sites');
const outils = require('./lot99-outils');

const ID = 'alfaliquid';
const HOTE = faux.ALFALIQUID;
const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', ID, 'connector.js');
const site = faux.siteAlfaliquid;

const passer = (etat, options = {}) => outils.passer(alfaliquid, { hote: HOTE, site, etat, ...options });

/** Ce que le journal d'un passage Alfaliquid ne doit jamais porter. */
const DONNEES = [/ZZESSAI/, /9000\d{3}/];

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D1 — trois commandes, une sans facture ; la copie pour petits écrans
// ---------------------------------------------------------------------------

test('D1 — trois commandes dont une sans facture : deux PDF, une commande dite sans facture ; la copie pour petits écrans présente et non comptée', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlfaliquid();
  // La page servie porte bien les deux copies : quatre liens de facture pour
  // deux factures, la copie pour petits écrans comprise.
  const page = faux.historiqueAlfaliquid(etat);
  assert.match(page, /<div class="orders table-replace-resp/);
  assert.equal((page.match(/controller=pdf-invoice/g) || []).length, 4, 'deux liens par facture : tableau ET copie');

  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ['alfaliquid-commande-9000001', 'alfaliquid-commande-9000003'],
    'l\'ancre : l\'id_order lu dans le lien');
  assert.deepEqual(resultat.invoices.map((f) => f.filename), ['alfaliquid_2026-07_ZZESSAIAA.pdf', 'alfaliquid_2025-01_ZZESSAICC.pdf'],
    'le nom : la référence de la ligne, la période de sa date');
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-07-11', '2025-01-15'], 'la date : celle de la ligne');
  assert.ok(resultat.invoices.every((f) => f.buffer.subarray(0, 5).toString('latin1') === '%PDF-'));
  assert.deepEqual(etat.compteurs.pdf, ['9000001', '9000003'], 'chaque PDF demandé une fois, jamais deux');
  assert.equal(resultat.precision, '— Alfaliquid : 3 commandes lues, 1 commande sans facture.', 'trois commandes, pas six');
  assert.equal(resultat.manquees, undefined, 'la commande sans facture n\'est pas un échec');
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].elements, 3);
  assert.deepEqual(resultat.couverture, { complete: true, detail: 'l\'historique des commandes Alfaliquid, 3 commandes' });
  assert.ok(resultat.sessionRenouvelee, 'l\'état de session d\'un passage qui a lu la liste est rendu');
  assert.match(lignes.join('\n'), /3 commande\(s\) lue\(s\) dans le tableau des commandes — 2 avec un lien de facture, 1 sans facture/);
  assert.equal(ouverts, 0, 'le connecteur a refermé son navigateur');
  // Les PDF sont demandés par le fetch de la page, dans la session.
  assert.equal(journal.requetes.filter((r) => /^fetch www\.alfaliquid\.com\/fr\/index\.php\?controller=pdf-invoice/.test(r)).length, 2);
  assert.deepEqual(journal.visites, ['www.alfaliquid.com/fr/historique-commandes'], 'une seule page visitée : la liste');
  outils.rienQueDesLectures(journal, etat);
  outils.journalSansDonnee(lignes, DONNEES);
});

test('D1 — second passage : rien de repris, rien de redemandé, et l\'archive est dite', faux.SANS_NAVIGATEUR, async () => {
  const premier = await passer(faux.compteAlfaliquid());
  const connus = premier.resultat.invoices.map((f) => f.remoteId);
  const etat = faux.compteAlfaliquid();
  const second = await passer(etat, { ctxExtra: { knownRemoteIds: connus } });
  assert.equal(second.erreur, null, second.erreur?.message);
  assert.deepEqual(second.resultat.invoices, []);
  assert.deepEqual(etat.compteurs.pdf, [], 'aucun PDF redemandé');
  assert.equal(second.resultat.precision,
    '— Alfaliquid : 3 commandes lues, 2 factures déjà dans vos documents, 1 commande sans facture.');
  assert.equal(second.resultat.aucunDocument, undefined, 'des factures existent : ce n\'est pas « aucun document »');
  outils.rienQueDesLectures(second.journal, etat);
});

test('un compte sans commande : « aucune commande », sans échec ; des commandes sans aucune facture : dit, sans échec', faux.SANS_NAVIGATEUR, async () => {
  const vide = await passer(faux.compteAlfaliquid({ commandes: [] }));
  assert.equal(vide.erreur, null, vide.erreur?.message);
  assert.equal(vide.resultat.aucunDocument, 'Votre compte Alfaliquid a bien été lu : aucune commande pour l\'instant.');
  const etat = faux.compteAlfaliquid();
  for (const c of etat.commandes) c.facture = false;
  const sans = await passer(etat);
  assert.equal(sans.erreur, null, sans.erreur?.message);
  assert.equal(sans.resultat.aucunDocument, 'Votre compte Alfaliquid a bien été lu : 3 commandes, aucune n\'a encore de facture.');
  assert.equal(sans.resultat.manquees, undefined);
});

test('le tableau des commandes absent alors que la page porte des commandes : « page illisible », jamais « 0 »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlfaliquid();
  const servir = faux.siteAlfaliquid(etat);
  const site = () => async (url, requete) => {
    const r = await servir(url, requete);
    if (url.pathname === '/fr/historique-commandes' && r.html) {
      return { ...r, html: r.html.replace(/table-history/g, 'table-commandes') };
    }
    return r;
  };
  const { erreur } = await outils.passer(alfaliquid, { hote: HOTE, site, etat });
  assert.ok(erreur);
  assert.match(erreur.message, /n'a pas su lire la page de vos commandes/);
  assert.notEqual(erreur.sessionExpired, true, 'ce n\'est pas une session expirée');
});

test('un document qui n\'est pas un PDF : rien de déposé, une non obtenue, dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlfaliquid({ nonPdf: ['9000001'] });
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ['alfaliquid-commande-9000003']);
  assert.equal(resultat.manquees, 1);
  assert.equal(resultat.precision, 'Alfaliquid : 3 commandes lues, 1 commande sans facture.',
    'le message du planificateur finit sa phrase : pas de tiret');
  assert.match(lignes.join('\n'), /une facture n'a pas pu être prise : le document a rendu \d+ octets qui ne sont pas un PDF \[reçu : page web \(HTML\)/);
});

// ---------------------------------------------------------------------------
// D5 — une adresse interdite, même dans un lien de facture
// ---------------------------------------------------------------------------

test('D5 — un lien de facture qui porte « submitReorder » est écarté sans être suivi, et dit ; « Commander à nouveau » n\'est jamais demandé', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlfaliquid();
  etat.commandes[0].lienFacture = 'https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=9000001&submitReorder=1';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ['alfaliquid-commande-9000003']);
  assert.deepEqual(etat.compteurs.pdf, ['9000003'], 'le lien interdit n\'a pas été demandé');
  assert.equal(resultat.precision, '— Alfaliquid : 3 commandes lues, 1 commande sans facture. '
    + 'Un lien a été écarté : il ne menait pas à une facture de la boutique.');
  assert.match(lignes.join('\n'), /un lien de facture a été écarté sans être suivi — il porte le mot interdit « submitReorder »/);
  assert.ok(!journal.requetes.some((r) => /submitReorder/.test(r)), 'aucune requête ne porte le mot interdit');
  outils.rienQueDesLectures(journal, etat);
});

// ---------------------------------------------------------------------------
// D6 — la page de connexion servie à la place de la liste
// ---------------------------------------------------------------------------

test('D6 — la page de connexion à la place de la liste : un renvoi vers la connexion, marqué pour la règle du lot 91', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlfaliquid({ connecte: false });
  const { erreur, journal, lignes, preuves } = await passer(etat);
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(lignes.join('\n'), /arrivée jugée « connexion-demandee » — renvoyé vers \/fr\/connexion, la page de connexion/);
  assert.equal(preuves.length, 0, 'aucune liste lue, aucune preuve déposée');
  assert.deepEqual(etat.compteurs.pdf, []);
  assert.deepEqual(journal.fuites, []);
});

test('une session vide ou expirée ne lance aucun navigateur : « connexion expirée »', () => {
  assert.throws(() => alfaliquid.lireSession({}), (err) => err.sessionExpired === true);
  assert.throws(() => alfaliquid.lireSession({ session: JSON.stringify({ cookies: [] }) }), (err) => err.sessionExpired === true);
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('le lien de facture : sur la boutique, controller=pdf-invoice, un id_order ; rien d\'autre', () => {
  const ok = alfaliquid.lienDeFacture('https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=42');
  assert.deepEqual(ok, { adresse: 'https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=42', idOrder: '42' });
  assert.equal(alfaliquid.lienDeFacture('/fr/index.php?controller=pdf-invoice&id_order=42').idOrder, '42', 'relatif, résolu sur la liste');
  for (const autre of [
    'https://www.alfaliquid.com/fr/index.php?controller=order-detail&id_order=42',
    'https://www.alfaliquid.com/fr/index.php?controller=pdf-order-return&id_order=42',
    'https://www.alfaliquid.com/fr/index.php?controller=pdf-delivery-slip&id_order=42',
    'https://www.exemple.invalid/fr/index.php?controller=pdf-invoice&id_order=42',
    'http://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=42',
    'https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice',
    'https://www.alfaliquid.com/fr/commande?submitReorder=1&id_order=42',
    'javascript:void(0)',
    '',
  ]) {
    assert.equal(alfaliquid.lienDeFacture(autre), null, autre);
  }
  assert.deepEqual(alfaliquid.lienDeFacture('https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=42&return=1'), { refus: 'return' });
});

test('l\'adresse revérifiée juste avant la demande : la forme, et l\'id_order de la ligne', () => {
  const a = 'https://www.alfaliquid.com/fr/index.php?controller=pdf-invoice&id_order=42';
  assert.deepEqual(alfaliquid.verifierAdresse(a, '42'), { ok: true });
  assert.equal(alfaliquid.verifierAdresse(a, '43').ok, false);
  assert.equal(alfaliquid.verifierAdresse(`${a}&panier=1`, '42').ok, false);
});

test('l\'arrivée : la liste (body#history), la connexion, le mur, ailleurs', () => {
  const j = (vue) => alfaliquid.jugerArrivee(vue).verdict;
  assert.equal(j({ url: alfaliquid.URL_LISTE, bodyId: 'history' }), 'liste');
  assert.equal(j({ url: 'https://www.alfaliquid.com/fr/connexion?back=historique-commandes', bodyId: 'authentication' }), 'connexion-demandee');
  assert.equal(j({ url: 'https://www.alfaliquid.com/fr/index.php?controller=authentication&back=history', bodyId: '' }), 'connexion-demandee');
  assert.equal(j({ url: alfaliquid.URL_LISTE, bodyId: 'history', motDePasse: true }), 'connexion-demandee');
  assert.equal(j({ url: alfaliquid.URL_LISTE, bodyId: 'history', mur: true }), 'mur');
  assert.equal(j({ url: 'https://www.alfaliquid.com/fr/', bodyId: 'index' }), 'page-illisible');
  assert.equal(j({ url: 'https://www.exemple.invalid/fr/historique-commandes', bodyId: 'history' }), 'page-illisible');
});

test('les noms : jamais deux fois le même ; la référence, à défaut l\'id_order', () => {
  const noms = alfaliquid.nommer([
    { issuedOn: '2026-07-11', reference: 'ZZESSAIAA', idOrder: '1' },
    { issuedOn: '2026-07-20', reference: 'ZZESSAIAA', idOrder: '2' },
    { issuedOn: null, reference: null, idOrder: '3' },
  ]);
  assert.deepEqual(noms, ['alfaliquid_2026-07_ZZESSAIAA.pdf', 'alfaliquid_2026-07_ZZESSAIAA-2.pdf', 'alfaliquid_3.pdf']);
  assert.equal(alfaliquid.referenceSure(' ZZ ESSAI '), 'ZZESSAI');
  assert.equal(alfaliquid.referenceSure('réf. avec accents'), null);
});

test('le journal masque chaque chiffre d\'un chemin', () => {
  assert.equal(alfaliquid.masquer('200 www.alfaliquid.com /fr/commande-123/x ; cookies posés : a1'),
    '200 www.alfaliquid.com /fr/commande-###/x ; cookies posés : a1');
});

test('le budget de temps : les 2/3 de la limite du planificateur, réglable comme elle', () => {
  assert.equal(alfaliquid.LIMITE_EXECUTION_DEFAUT_MS, scheduler.LIMITE_EXECUTION_MS, 'la même limite que le planificateur');
  return outils.avecLimite(30 * 60 * 1000, () => assert.equal(alfaliquid.budgetMs(), 20 * 60 * 1000));
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur : D9 (messages), D6 (cause), D7 (temps)
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  const passage = (user, etat, extra = {}) => outils.parLePlanificateur({ registry, scheduler, id: ID, hote: HOTE, site, etat, user, ...extra });

  test('D9 — les messages, mot pour mot : deux factures, puis rien de nouveau ; deux lignes, rien de repris', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99a1', HOTE);
    let { r } = await passage(user, faux.compteAlfaliquid());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '2 factures récupérées — Alfaliquid : 3 commandes lues, 1 commande sans facture.');
    const lignes = outils.documents(db, user, ID);
    assert.deepEqual(lignes.map((l) => l.remote_id), ['alfaliquid-commande-9000001', 'alfaliquid-commande-9000003']);
    assert.equal(new Set(lignes.map((l) => l.filename)).size, 2);

    ({ r } = await passage(user, faux.compteAlfaliquid()));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Aucune nouvelle facture — Alfaliquid : 3 commandes lues, 2 factures déjà dans vos documents, 1 commande sans facture.');
    assert.equal(outils.documents(db, user, ID).length, 2, 'le second passage ne reprend rien');
    outils.journalApplicatifSansDonnee(db, DONNEES);
  });

  test('D6 — la page de connexion à la place de la liste, après une connexion qui a marché : « session expirée »', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99a2', HOTE);
    let { r } = await passage(user, faux.compteAlfaliquid());
    assert.equal(r.ok, true, r.message);
    ({ r } = await passage(user, faux.compteAlfaliquid({ connecte: false })));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree', 'orange, lot 91 — pas « page illisible »');
    assert.equal(outils.documents(db, user, ID).length, 2, 'rien n\'est perdu');
  });

  test('D7 — le temps permis écoulé au milieu : ce qui est pris est en base, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99a3', HOTE);
    await outils.avecLimite(30 * 60 * 1000, async () => {
      // L'horloge du connecteur n'avance qu'à chaque PDF servi : 25 minutes.
      // Budget 20 minutes (2/3 de 30) : la première facture, puis l'arrêt.
      let t = 0;
      const etat = faux.compteAlfaliquid({ surPdf: () => { t += 25 * 60 * 1000; } });
      let { r } = await passage(user, etat, { horloge: () => t });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '1 facture récupérée — Alfaliquid : 3 commandes lues, 1 commande sans facture. '
        + 'La récupération a pris tout le temps permis : 1 facture attend encore ; elle viendra au prochain passage. '
        + 'Rien de ce qui a été pris n\'est perdu.');
      assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id), ['alfaliquid-commande-9000001'], 'la facture prise est EN BASE');

      t = 0;
      ({ r } = await passage(user, faux.compteAlfaliquid(), { horloge: () => t }));
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '1 facture récupérée — Alfaliquid : 3 commandes lues, 1 facture déjà dans vos documents, 1 commande sans facture.');
      assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id),
        ['alfaliquid-commande-9000001', 'alfaliquid-commande-9000003'], 'le reste, au passage suivant');
    });
  });
});

test.after(() => {
  helpers.teardown();
});
