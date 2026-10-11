'use strict';

/**
 * Lot 99 — Le Petit Vapoteur : les factures des blocs `div.item-cmd`, à une
 * adresse MAL FORMÉE (`controller=pdf-invoice?id_order=…`) dont le sort sur le
 * vrai site n'est pas mesuré.
 *
 * Au VRAI Chromium, sur une page RECONSTITUÉE fidèle à la structure du code
 * source enregistré par l'utilisateur le 11/10/2026 (test/lot99-faux-sites.js). Ce que
 * le site fait de l'adresse mal formée est INVENTÉ en trois variantes, faute de
 * mesure : elle sert le PDF ; elle ne le sert pas mais sa forme corrigée oui ;
 * aucune ne le sert. Aucune requête ne sort.
 *
 * ⚠ Valeurs inventées : numéros « ZZ91000… », id_order 9 100 00x, 0,00 €.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const lpv = require('../server/connectors/available/le-petit-vapoteur/connector');
const faux = require('./lot99-faux-sites');
const outils = require('./lot99-outils');

const ID = 'le-petit-vapoteur';
const HOTE = faux.PETIT_VAPOTEUR;
const site = faux.sitePetitVapoteur;

const passer = (etat, options = {}) => outils.passer(lpv, { hote: HOTE, site, etat, ...options });

const DONNEES = [/ZZ9100/, /9100\d{3}/];

const FACTURES = ['9100001', '9100002', '9100004', '9100005'];
const NOMS = [
  'le-petit-vapoteur_2026-09_ZZ9100001.pdf',
  'le-petit-vapoteur_2026-08_ZZ9100002.pdf',
  'le-petit-vapoteur_2025-12_ZZ9100004.pdf',
  'le-petit-vapoteur_2025-02_ZZ9100005.pdf',
];

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D2 — cinq commandes, quatre factures, trois variantes du banc
// ---------------------------------------------------------------------------

test('D2 (1) — l\'adresse mal formée sert le PDF : elle est demandée D\'ABORD, retenue, dite ; la forme corrigée n\'est jamais demandée', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ variante: 'donnee' });
  const { resultat, erreur, journal, lignes, preuves } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(etat.compteurs.donnee, FACTURES, 'chaque facture à l\'adresse telle que la page la donne');
  assert.deepEqual(etat.compteurs.corrigee, [], 'la forme corrigée n\'a pas servi : elle n\'est pas demandée');
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), FACTURES.map((n) => `le-petit-vapoteur-commande-${n}`));
  assert.deepEqual(resultat.invoices.map((f) => f.filename), NOMS);
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-09-03', '2026-08-21', '2025-12-30', '2025-02-08']);
  assert.equal(resultat.precision, '— Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
    + 'Les factures ont été prises à l\'adresse que donne la boutique.');
  const dites = lignes.filter((l) => /adresse des factures —/.test(l));
  assert.deepEqual(dites, ['le-petit-vapoteur : adresse des factures — la forme donnée par la page sert le PDF : retenue pour ce passage.'],
    'dit UNE fois au journal');
  assert.equal(preuves[0].elements, 5);
  outils.rienQueDesLectures(journal, etat);
  outils.journalSansDonnee(lignes, DONNEES);
});

test('D2 (2) — elle ne le sert pas, la forme corrigée oui : un essai de chaque sur la première facture, puis la corrigée seule ; dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ variante: 'corrigee' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(etat.compteurs.donnee, ['9100001'], 'la forme donnée n\'est essayée qu\'une fois');
  assert.deepEqual(etat.compteurs.corrigee, FACTURES, 'puis la forme corrigée, retenue pour tout le passage');
  assert.deepEqual(resultat.invoices.map((f) => f.filename), NOMS);
  assert.equal(resultat.manquees, undefined, 'l\'essai de la forme donnée n\'est pas une facture manquée');
  assert.equal(resultat.precision, '— Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
    + 'L\'adresse de facture que donne la boutique ne servait pas le PDF : crabe a pris les factures à cette adresse, corrigée.');
  const dites = lignes.filter((l) => /adresse des factures —/.test(l));
  assert.equal(dites.length, 2);
  assert.match(dites[0], /la forme donnée par la page n'a pas servi de PDF \(le document a rendu \d+ octets qui ne sont pas un PDF \[reçu : page web \(HTML\)/);
  assert.equal(dites[1], 'le-petit-vapoteur : adresse des factures — la forme corrigée (« &id_order= ») sert le PDF : retenue pour ce passage.');
  outils.rienQueDesLectures(journal, etat);
});

test('D2 (3) — aucune ne le sert : arrêt pour cette boutique sur la première facture, dit ; les quatre comptent comme non obtenues', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ variante: 'aucune' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(etat.compteurs.donnee, ['9100001']);
  assert.deepEqual(etat.compteurs.corrigee, ['9100001'], 'les deux formes, une fois, puis plus rien');
  assert.deepEqual(resultat.invoices, []);
  assert.equal(resultat.manquees, 4, 'quatre factures étaient proposées, aucune n\'est obtenue');
  assert.equal(resultat.precision, 'Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
    + 'La boutique n\'a servi aucune facture, ni à l\'adresse qu\'elle donne, ni à cette adresse corrigée : '
    + 'crabe s\'est arrêté là pour cette boutique. Signalez-le pour que la lecture soit mise à jour.');
  assert.match(lignes.join('\n'), /aucune forme de l'adresse ne sert de PDF — .* Arrêt pour cette boutique : aucune autre facture n'est demandée\./);
  assert.equal(resultat.couverture.complete, false);
  outils.rienQueDesLectures(journal, etat);
});

test('D2 — un lien déjà bien formé : une seule forme, demandée telle quelle', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ variante: 'corrigee' });
  for (const c of etat.commandes) c.lienFacture = `https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice&id_order=${c.idOrder}`;
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(etat.compteurs.donnee, [], 'aucune adresse mal formée sur la page');
  assert.deepEqual(etat.compteurs.corrigee, FACTURES);
  assert.equal(resultat.invoices.length, 4);
  assert.match(resultat.precision, /Les factures ont été prises à l'adresse que donne la boutique\.$/);
});

test('D2 — second passage : rien de repris, rien de redemandé', faux.SANS_NAVIGATEUR, async () => {
  const premier = await passer(faux.comptePetitVapoteur());
  const etat = faux.comptePetitVapoteur();
  const second = await passer(etat, { ctxExtra: { knownRemoteIds: premier.resultat.invoices.map((f) => f.remoteId) } });
  assert.equal(second.erreur, null, second.erreur?.message);
  assert.deepEqual(second.resultat.invoices, []);
  assert.deepEqual([...etat.compteurs.donnee, ...etat.compteurs.corrigee], [], 'aucune adresse de facture demandée');
  assert.equal(second.resultat.precision,
    '— Le Petit Vapoteur : 5 commandes lues, 4 factures déjà dans vos documents, 1 commande sans facture.');
});

// ---------------------------------------------------------------------------
// D5 — adresses interdites ; seuls les liens de facture d'un bloc sont suivis
// ---------------------------------------------------------------------------

test('D5 — un lien de facture qui porte « reOrder » est écarté, dit ; « Voir la commande » et « Acheter à nouveau » ne sont jamais suivis', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur();
  etat.commandes[1].lienFacture = 'https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=9100002&reOrder=1';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId).sort(),
    ['9100001', '9100004', '9100005'].map((n) => `le-petit-vapoteur-commande-${n}`));
  assert.match(lignes.join('\n'), /il porte le mot interdit « reOrder »/);
  assert.match(resultat.precision, /Un lien a été écarté : il ne menait pas à une facture de la boutique\./);
  assert.ok(!journal.requetes.some((r) => /reOrder|submitReorder|order-detail/i.test(r)), 'aucune autre adresse du bloc n\'est demandée');
  outils.rienQueDesLectures(journal, etat);
});

// ---------------------------------------------------------------------------
// D6 — la page de connexion à la place de la liste
// ---------------------------------------------------------------------------

test('D6 — la page de connexion à la place de la liste : un renvoi vers la connexion, marqué pour le lot 91', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ connecte: false });
  const { erreur, lignes, preuves, journal } = await passer(etat);
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(lignes.join('\n'), /arrivée jugée « connexion-demandee » — renvoyé vers \/fr\/authentification, la page de connexion/);
  assert.equal(preuves.length, 0);
  assert.deepEqual(journal.fuites, []);
});

test('D6 — la session tombe pendant le choix de la forme : un renvoi, jamais « la boutique ne sert pas ses factures »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.comptePetitVapoteur({ variante: 'donnee', sessionMeurtApresListe: true });
  const { erreur, lignes } = await passer(etat);
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true, lignes.join('\n'));
  assert.deepEqual(etat.compteurs.donnee, ['9100001'], 'la liste a été lue, la première facture demandée');
  assert.deepEqual(etat.compteurs.corrigee, ['9100001'], 'puis sa forme corrigée');
  assert.equal(etat.compteurs.listes, 2, 'puis la liste, relue une fois : elle renvoie à la connexion');
  assert.doesNotMatch(lignes.join('\n'), /aucune forme de l'adresse ne sert de PDF/);
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('le lien de facture : les deux formes, la mal formée telle quelle et sa correction', () => {
  const mal = lpv.lienDeFacture('https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=42');
  assert.deepEqual(mal, {
    telleQuelle: 'https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=42',
    corrigee: 'https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice&id_order=42',
    idOrder: '42',
  });
  const bien = lpv.lienDeFacture('/fr/index.php?controller=pdf-invoice&id_order=42');
  assert.equal(bien.telleQuelle, bien.corrigee, 'bien formée : une seule forme');
  for (const autre of [
    'https://www.lepetitvapoteur.com/fr/index.php?controller=order-detail&id_order=42',
    'https://www.lepetitvapoteur.com/fr/commande?submitReorder=&id_order=42',
    'https://www.exemple.invalid/fr/index.php?controller=pdf-invoice?id_order=42',
    'https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice',
    '/?mylogout',
    '#reOrder',
  ]) {
    assert.equal(lpv.lienDeFacture(autre), null, autre);
  }
});

test('l\'adresse revérifiée : l\'une des deux formes, l\'id_order du bloc', () => {
  assert.deepEqual(lpv.verifierAdresse('https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice?id_order=42', '42'), { ok: true });
  assert.deepEqual(lpv.verifierAdresse('https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice&id_order=42', '42'), { ok: true });
  assert.equal(lpv.verifierAdresse('https://www.lepetitvapoteur.com/fr/index.php?controller=pdf-invoice&id_order=42', '41').ok, false);
});

test('l\'arrivée : body#history = la liste ; /fr/authentification = la connexion', () => {
  assert.equal(lpv.jugerArrivee({ url: lpv.URL_LISTE, bodyId: 'history' }).verdict, 'liste');
  assert.equal(lpv.jugerArrivee({ url: 'https://www.lepetitvapoteur.com/fr/authentification?back=/fr/', bodyId: 'authentication' }).verdict, 'connexion-demandee');
  assert.equal(lpv.jugerArrivee({ url: 'https://www.lepetitvapoteur.com/fr/', bodyId: 'index' }).verdict, 'page-illisible');
});

test('le numéro de commande dans le nom : « N° » retiré, accents refusés', () => {
  assert.equal(lpv.referenceSure('N° ZZ9100001'), 'ZZ9100001');
  assert.equal(lpv.referenceSure('ZZ9100001'), 'ZZ9100001');
  assert.equal(lpv.referenceSure('numéro'), null);
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur : D9, D6, D7
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  const passage = (user, etat, extra = {}) => outils.parLePlanificateur({ registry, scheduler, id: ID, hote: HOTE, site, etat, user, ...extra });

  test('D9 — les messages des trois variantes, mot pour mot ; le second passage ne reprend rien', faux.SANS_NAVIGATEUR, async () => {
    const u1 = await outils.compteAvec(helpers, registry, ID, 'lot99v1', HOTE);
    let { r } = await passage(u1, faux.comptePetitVapoteur({ variante: 'donnee' }));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '4 factures récupérées — Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
      + 'Les factures ont été prises à l\'adresse que donne la boutique.');
    assert.equal(outils.documents(db, u1, ID).length, 4);
    ({ r } = await passage(u1, faux.comptePetitVapoteur({ variante: 'donnee' })));
    assert.equal(r.message, 'Aucune nouvelle facture — Le Petit Vapoteur : 5 commandes lues, 4 factures déjà dans vos documents, 1 commande sans facture.');
    assert.equal(outils.documents(db, u1, ID).length, 4);

    const u2 = await outils.compteAvec(helpers, registry, ID, 'lot99v2', HOTE);
    ({ r } = await passage(u2, faux.comptePetitVapoteur({ variante: 'corrigee' })));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '4 factures récupérées — Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
      + 'L\'adresse de facture que donne la boutique ne servait pas le PDF : crabe a pris les factures à cette adresse, corrigée.');

    const u3 = await outils.compteAvec(helpers, registry, ID, 'lot99v3', HOTE);
    ({ r } = await passage(u3, faux.comptePetitVapoteur({ variante: 'aucune' })));
    assert.equal(r.ok, false, 'rien n\'est entré : un échec, dit');
    assert.equal(r.message, 'Aucun document n\'a pu être récupéré — 4 vous étaient proposés, aucun n\'a pu être téléchargé. '
      + 'Le détail de ce qui a bloqué est dans le journal de cette exécution. '
      + 'Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
      + 'La boutique n\'a servi aucune facture, ni à l\'adresse qu\'elle donne, ni à cette adresse corrigée : '
      + 'crabe s\'est arrêté là pour cette boutique. Signalez-le pour que la lecture soit mise à jour.');
    assert.equal(r.cause, 'echec', 'ce n\'est pas une affaire de connexion');
    assert.equal(outils.documents(db, u3, ID).length, 0);
    outils.journalApplicatifSansDonnee(db, DONNEES);
  });

  test('D6 — après une connexion qui a marché, la page de connexion à la place de la liste : « session expirée »', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99v4', HOTE);
    let { r } = await passage(user, faux.comptePetitVapoteur());
    assert.equal(r.ok, true, r.message);
    ({ r } = await passage(user, faux.comptePetitVapoteur({ connecte: false })));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree');
  });

  test('D7 — le temps permis écoulé au milieu : ce qui est pris est en base, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99v5', HOTE);
    await outils.avecLimite(30 * 60 * 1000, async () => {
      // 8 minutes par PDF servi, budget 20 minutes : trois factures, puis l'arrêt.
      let t = 0;
      let { r } = await passage(user, faux.comptePetitVapoteur({ surPdf: () => { t += 8 * 60 * 1000; } }), { horloge: () => t });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '3 factures récupérées — Le Petit Vapoteur : 5 commandes lues, 1 commande sans facture. '
        + 'Les factures ont été prises à l\'adresse que donne la boutique. '
        + 'La récupération a pris tout le temps permis : 1 facture attend encore ; elle viendra au prochain passage. '
        + 'Rien de ce qui a été pris n\'est perdu.');
      assert.equal(outils.documents(db, user, ID).length, 3, 'les trois factures prises sont EN BASE');
      t = 0;
      ({ r } = await passage(user, faux.comptePetitVapoteur(), { horloge: () => t }));
      assert.equal(r.ok, true, r.message);
      assert.match(r.message, /^1 facture récupérée — Le Petit Vapoteur : 5 commandes lues, 3 factures déjà dans vos documents/);
      assert.equal(outils.documents(db, user, ID).length, 4, 'le reste, au passage suivant');
    });
  });
});

test.after(() => {
  helpers.teardown();
});
