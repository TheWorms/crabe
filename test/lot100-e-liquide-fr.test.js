'use strict';

/**
 * Lot 100 — e-liquide-fr : le vrai formulaire de la page d'arrivée « Mon
 * compte ».
 *
 * Le 11/10/2026, l'essai réel du compte observé a échoué ainsi (journal de production,
 * mesuré) : « PagingAPIRowCount illisible dans le formulaire », puis « page 1
 * — le formulaire n'est pas parti : ReloadMode autre que 0 ». La page que
 * `PBUserAccount.asp` sert en lecture directe n'est pas celle que le lot 99
 * avait reconstituée : son `MForm` ne porte que `ActionID` (caché, 0) et
 * `DiscountCoupon` (texte, vide). Le banc (`test/lot99-faux-sites.js`) sert
 * désormais cette page, telle que l'utilisateur l'a enregistrée (structure reprise,
 * données inventées).
 *
 * Ce que ce fichier prouve, au VRAI Chromium, réseau coupé :
 *
 *   - D1 — de la page d'arrivée, UN envoi `ActionID=8` (les champs servis,
 *     `ActionID` seul changé), puis la pagination du lot 99 ; douze PDF ; par
 *     le vrai planificateur, mot pour mot ;
 *   - D2 — la règle de la page d'arrivée : code promotionnel rempli,
 *     `ReloadMode` à 1, champ inconnu… → rien ne part ; les noms des champs au
 *     journal, jamais leurs valeurs ;
 *   - D3 — l'envoi qui ne mène pas à la liste : arrêt, un seul envoi, le titre
 *     et les noms des champs reçus au journal (R3) ;
 *   - D4 — `PagingAPIRowCount` lu sur la page des commandes seulement (R2) ;
 *   - la page des commandes garde la règle du lot 99.
 *
 * Ce que la page reconstituée ne prouve pas : ce que `SubmitAction` ajoute
 * peut-être au formulaire sur le vrai site (non mesuré — le D3 dit ce que
 * crabe fera s'il manque quelque chose), la pagination réelle, l'impression des
 * vraies factures.
 *
 * ⚠ Valeurs inventées : numéros 9 200 00x, « Client d'essai »,
 * client@exemple.invalid, « ZZPROMOESSAI », « valeur-secrete-inventee ».
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
const obstructions = require('../server/connectors/obstructions');
const eliq = require('../server/connectors/available/e-liquide-fr/connector');
const faux = require('./lot99-faux-sites');
const faux93 = require('./lot93-faux-sites');
const outils = require('./lot99-outils');

const ID = 'e-liquide-fr';
const HOTE = faux.E_LIQUIDE;
const site = faux.siteELiquide;

const passer = (etat, options = {}) => outils.passer(eliq, { hote: HOTE, site, etat, ...options });

const POST = 'POST www.e-liquide-fr.com/PBUserAccount.asp';
const envoisPermis = (etat) => etat.compteurs.envois.map(() => POST);
const DONNEES = [/92000\d\d/, /Client d'essai/, /client@exemple\.invalid/, /ZZPROMOESSAI/, /valeur-secrete-inventee/];

/** Le premier envoi : les champs servis par la page d'arrivée, `ActionID` seul passé de 0 à 8. */
const ENVOI_ARRIVEE = [['ActionID', '8'], ['DiscountCoupon', '']];

/** Les envois de la page des commandes (lot 99) : seuls `ActionID` et `OrdersPageIdx` changent. */
const envoiListe = (n, extra = {}) => Object.entries({
  ActionID: '8', OrderID: '', OrdersPageIdx: String(n), ReloadMode: '0', PagingAPIRowCount: '5',
  PagingAPIHashCode: 'hash-invente-0000', ...extra,
}).filter(([, v]) => v !== null);

const ILLISIBLE = /n'a pas su lire la page de vos commandes/;

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D1 — de la page d'arrivée à douze PDF
// ---------------------------------------------------------------------------

test('D1 — la page d\'arrivée mesurée, puis douze commandes sur trois pages : un envoi ActionID=8 (les champs servis, ActionID seul changé), puis la pagination du lot 99 ; douze PDF', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message} ${erreur?.precision || ''}\n${lignes.join('\n')}`);
  assert.equal(etat.compteurs.comptes, 1, 'la page d\'arrivée est lue une fois, à son adresse');
  assert.equal(etat.compteurs.envois.length, 3, 'trois pages, trois envois');
  assert.deepEqual(etat.compteurs.envois[0], ENVOI_ARRIVEE,
    'le premier envoi part de la page d\'arrivée : ses deux champs, dans leur ordre, rien d\'ajouté, ActionID seul changé');
  assert.deepEqual(etat.compteurs.envois[1], envoiListe(2), 'puis la page 2, par le formulaire de la page des commandes');
  assert.deepEqual(etat.compteurs.envois[2], envoiListe(3));
  assert.equal(resultat.invoices.length, 12);
  assert.equal(etat.compteurs.factures.length, 12, 'chaque page .htm ouverte une fois');
  assert.deepEqual(etat.compteurs.appelsJs, [], 'aucun « javascript: » exécuté — ni SubmitAction, ni WNDAPIOpenWindow, ni SelectItem');
  assert.equal(resultat.precision, '— e-liquide-fr : 12 commandes lues sur 3 pages.');
  assert.equal(preuves[0].elements, 12);
  assert.deepEqual(resultat.couverture, { complete: true, detail: '3 pages de commandes e-liquide-fr, 12 commandes' });
  for (const f of resultat.invoices) assert.equal(f.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(ouverts, 0, 'le navigateur est refermé');
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
  outils.journalSansDonnee(lignes, DONNEES);
});

// ---------------------------------------------------------------------------
// D2 — la règle de la page d'arrivée
// ---------------------------------------------------------------------------

test('D2 — page d\'arrivée : code promotionnel rempli, ReloadMode à 1, champ inconnu, et les autres formes — rien ne part ; les noms des champs au journal, jamais leurs valeurs', faux.SANS_NAVIGATEUR, async () => {
  const cas = [
    ['le code promotionnel rempli', { arrivee: { coupon: 'ZZPROMOESSAI' } },
      'le code promotionnel (DiscountCoupon) n\'est pas vide.'],
    ['un ReloadMode présent à 1', { formulaire: { ReloadMode: '1' } },
      'ReloadMode autre que 0.'],
    ['un champ inconnu', { arrivee: { champsEnPlus: '<input type="hidden" name="Supplement" value="valeur-secrete-inventee">' } },
      'forme de MForm inconnue (champs vus : ActionID, DiscountCoupon, Supplement).'],
    ['un OrderID non nul', { arrivee: { champsEnPlus: '<input type="hidden" name="OrderID" value="9200001">' } },
      'OrderID non nul.'],
    ['ActionID servi à 2', { formulaire: { ActionID: '2' } },
      'ActionID absent, en double ou autre que 0 sur la page d\'arrivée.'],
    ['DiscountCoupon en double', { arrivee: { champsEnPlus: '<input type="text" name="DiscountCoupon" value="">' } },
      'forme de MForm inconnue (champs vus : ActionID, DiscountCoupon, DiscountCoupon).'],
    // Le formulaire que le lot 99 avait prêté à cette page : des champs de
    // pagination sans le tableau des commandes. Ni l'une ni l'autre page.
    ['des champs de pagination sans tableau', {
      arrivee: { champsEnPlus: '<input type="hidden" name="OrdersPageIdx" value="1"><input type="hidden" name="PagingAPIRowCount" value="5">' },
    }, 'forme de MForm inconnue (champs vus : ActionID, DiscountCoupon, OrdersPageIdx, PagingAPIRowCount).'],
    // La page d'arrivée se reconnaît aussi à son conteneur mesuré.
    ['sans le tableau de bord (#maincontainer.userdashboard)', { arrivee: { classes: 'useraccount' } },
      'forme de MForm inconnue (champs vus : ActionID, DiscountCoupon).'],
  ];
  for (const [quoi, extra, raison] of cas) {
    const etat = faux.compteELiquide(extra);
    const { erreur, journal, lignes } = await passer(etat);
    assert.ok(erreur, `${quoi} : le passage s'arrête`);
    assert.match(erreur.message, ILLISIBLE, quoi);
    assert.ok(lignes.includes(`e-liquide-fr : page 1 — le formulaire n'est pas parti : ${raison}`),
      `${quoi} : la ligne du journal, mot pour mot\n${lignes.join('\n')}`);
    assert.deepEqual(etat.compteurs.envois, [], `${quoi} : rien n'est parti`);
    assert.deepEqual(journal.ecritures, [], `${quoi} : aucune requête d'écriture`);
    assert.deepEqual(etat.compteurs.appelsJs, [], `${quoi} : aucun javascript:`);
    assert.doesNotMatch(lignes.join('\n'), /PagingAPIRowCount illisible/, `${quoi} : rien n'est lu de la pagination sur la page d'arrivée`);
    outils.rienQueDesLectures(journal, etat);
    outils.journalSansDonnee(lignes, DONNEES);
  }
});

test('D2 — page d\'arrivée : un ReloadMode à 0 et un OrderID vide, s\'ils y sont, partent tels que servis ; absents (la page mesurée), rien n\'est ajouté', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ commandes: faux.commandesELiquide(3), formulaire: { ReloadMode: '0', OrderID: '' } });
  const { resultat, erreur, journal } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(etat.compteurs.envois, [[['ActionID', '8'], ['ReloadMode', '0'], ['OrderID', ''], ['DiscountCoupon', '']]],
    'un seul envoi : les champs servis, dans leur ordre, ActionID seul changé');
  assert.equal(resultat.invoices.length, 3);
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });

  const mesuree = faux.compteELiquide({ commandes: faux.commandesELiquide(3) });
  const r = await passer(mesuree);
  assert.equal(r.erreur, null, r.erreur?.message);
  assert.deepEqual(mesuree.compteurs.envois, [ENVOI_ARRIVEE], 'aucun ReloadMode, aucun OrderID ajouté par crabe');
});

test('D2 — page d\'arrivée : un champ changé par la page ENTRE la lecture et l\'envoi ne part pas ; une demande hors d\'ActionID non plus', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide();
  const banc = await faux93.ouvrirFauxSite([HOTE], site(etat));
  try {
    const { page } = banc;
    await page.context().addCookies([{ name: faux.COOKIE.name, value: faux.COOKIE.value, domain: HOTE, path: '/', secure: true }]);
    for (const [quoi, geste, motif] of [
      ['le code promotionnel rempli', () => { document.forms.MForm.elements.DiscountCoupon.value = 'ZZPROMOESSAI'; }, /a changé depuis sa lecture/],
      ['ActionID passé à 10 (« Recharger »)', () => { document.forms.MForm.elements.ActionID.value = '10'; }, /a changé depuis sa lecture/],
      ['un ReloadMode ajouté', () => {
        const champ = document.createElement('input');
        champ.type = 'hidden';
        champ.name = 'ReloadMode';
        champ.value = '0';
        document.forms.MForm.appendChild(champ);
      }, /a changé depuis sa lecture/],
      ['le tableau de bord retiré', () => { document.querySelector('#maincontainer').className = 'useraccount'; }, /forme de MForm inconnue/],
    ]) {
      await page.goto(eliq.URL_COMPTE);
      const vue = await page.evaluate(eliq.LIRE_LA_PAGE);
      assert.deepEqual(vue.formulaire.champs.map((c) => [c.nom, c.type, c.valeur]),
        [['ActionID', 'hidden', '0'], ['DiscountCoupon', 'text', '']], 'la page d\'arrivée est lue telle que servie');
      await page.evaluate(geste);
      const envoi = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '8' });
      assert.equal(envoi.envoye, false, quoi);
      assert.match(envoi.raison, motif, quoi);
      assert.deepEqual(etat.compteurs.envois, [], `${quoi} : rien n'est parti`);
    }
    await page.goto(eliq.URL_COMPTE);
    const vue = await page.evaluate(eliq.LIRE_LA_PAGE);
    const page2 = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '8', OrdersPageIdx: '2' });
    assert.equal(page2.envoye, false);
    assert.equal(page2.raison, 'sur la page d\'arrivée, seul ActionID change');
    const recharger = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '10' });
    assert.equal(recharger.envoye, false);
    assert.match(recharger.raison, /ActionID autre que « Suivi des commandes »/);
    assert.deepEqual(etat.compteurs.envois, [], 'toujours rien');
    // Témoin : sans geste, l'envoi part, une fois, tel que servi.
    const envoi = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '8' });
    assert.equal(envoi.envoye, true);
    assert.deepEqual(etat.compteurs.envois, [ENVOI_ARRIVEE]);
    assert.deepEqual(banc.journal.fuites, []);
    assert.deepEqual(banc.journal.clics, []);
    assert.deepEqual(banc.journal.saisies, [], 'aucun événement de saisie ni « submit » : la valeur est posée, le formulaire envoyé par le prototype');
    assert.deepEqual(etat.compteurs.appelsJs, []);
  } finally {
    await banc.fermer();
  }
});

// ---------------------------------------------------------------------------
// La page des commandes garde la règle du lot 99
// ---------------------------------------------------------------------------

test('la page des commandes garde la règle du lot 99 : servie avec ReloadMode à 1, un OrderID, ou changée entre la lecture et l\'envoi, la page suivante ne part pas ; la page 1 est gardée', faux.SANS_NAVIGATEUR, async () => {
  for (const [quoi, liste, raison] of [
    ['ReloadMode à 1', { formulaire: { ReloadMode: '1' } }, 'ReloadMode autre que 0.'],
    ['ReloadMode absent', { formulaire: { ReloadMode: null } }, 'ReloadMode autre que 0.'],
    ['un OrderID', { formulaire: { OrderID: '9200001' } }, 'OrderID non nul.'],
  ]) {
    const etat = faux.compteELiquide({ liste });
    const { resultat, erreur, journal, lignes } = await passer(etat);
    assert.equal(erreur, null, `${quoi} : ${erreur?.message}`);
    assert.deepEqual(etat.compteurs.envois, [ENVOI_ARRIVEE], `${quoi} : seul l'envoi de la page d'arrivée est parti`);
    assert.equal(resultat.invoices.length, 5, `${quoi} : la page 1 est gardée`);
    assert.ok(lignes.includes(`e-liquide-fr : page 2 — le formulaire n'est pas parti : ${raison}`), `${quoi}\n${lignes.join('\n')}`);
    assert.equal(resultat.precision, '— e-liquide-fr : 5 commandes lues sur 1 page. Pages suivantes non lues : '
      + 'la page suivante n\'a pas pu être obtenue. Signalez-le pour que la lecture soit mise à jour.');
    assert.equal(resultat.couverture.complete, false);
    outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
  }

  // Un champ changé entre la lecture de la page des commandes et l'envoi de la suivante.
  const etat = faux.compteELiquide();
  const banc = await faux93.ouvrirFauxSite([HOTE], site(etat));
  try {
    const { page } = banc;
    await page.context().addCookies([{ name: faux.COOKIE.name, value: faux.COOKIE.value, domain: HOTE, path: '/', secure: true }]);
    const gestes = [
      ['ReloadMode passé à 1', () => { document.forms.MForm.elements.ReloadMode.value = '1'; }],
      ['OrderID rempli', () => { document.forms.MForm.elements.OrderID.value = '9200001'; }],
    ];
    for (const [quoi, geste] of gestes) {
      await page.goto(eliq.URL_COMPTE);
      const arrivee = await page.evaluate(eliq.LIRE_LA_PAGE);
      assert.equal((await eliq.envoyerLeFormulaire(page, arrivee.formulaire, { ActionID: '8' })).envoye, true);
      const liste = await page.evaluate(eliq.LIRE_LA_PAGE);
      assert.ok(liste.tableau, 'la page des commandes est servie');
      await page.evaluate(geste);
      const envoi = await eliq.envoyerLeFormulaire(page, liste.formulaire, { ActionID: '8', OrdersPageIdx: '2' });
      assert.equal(envoi.envoye, false, quoi);
      assert.match(envoi.raison, /a changé depuis sa lecture/, quoi);
    }
    assert.equal(etat.compteurs.envois.length, gestes.length, 'seuls les envois de la page d\'arrivée sont partis');
    assert.ok(etat.compteurs.envois.every((e) => JSON.stringify(e) === JSON.stringify(ENVOI_ARRIVEE)));
    assert.deepEqual(banc.journal.fuites, []);
    assert.deepEqual(banc.journal.clics, []);
  } finally {
    await banc.fermer();
  }
});

// ---------------------------------------------------------------------------
// D3 — l'envoi qui ne mène pas à la liste (R3)
// ---------------------------------------------------------------------------

test('D3 — l\'envoi ActionID=8 rend une page sans tableau : arrêt, un seul envoi, rien de renvoyé ; le journal dit le titre et les noms des champs reçus', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ reponseSuivi: 'compte' });
  const { erreur, journal, lignes, preuves } = await passer(etat);
  assert.ok(erreur);
  assert.match(erreur.message, ILLISIBLE);
  assert.equal(erreur.sessionExpired, undefined, 'ce n\'est pas un renvoi vers la connexion');
  assert.deepEqual(etat.compteurs.envois, [ENVOI_ARRIVEE], 'un seul envoi, rien de renvoyé');
  assert.deepEqual(etat.compteurs.factures, [], 'aucune facture demandée');
  assert.equal(preuves.length, 0, 'aucune preuve de liste : la liste n\'a pas été lue');
  assert.ok(lignes.includes('e-liquide-fr : page 1 — l\'envoi « Suivi des commandes » (ActionID=8) n\'a pas mené à la liste des commandes : '
    + 'la page servie ne porte pas le tableau des commandes (table.PBTable) ; page « Mon Compte », champs de MForm : ActionID, DiscountCoupon. '
    + 'Rien n\'est renvoyé.'), lignes.join('\n'));
  assert.doesNotMatch(lignes.join('\n'), /PagingAPIRowCount illisible/);
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
  outils.journalSansDonnee(lignes, DONNEES);
});

test('ce que le journal dit d\'une page reçue et de ses champs : des noms, jamais une valeur, aucun numéro, aucune adresse électronique', () => {
  assert.equal(eliq.pageRecue({ titre: 'Mon Compte', formulaire: { champs: [{ nom: 'ActionID', valeur: '0' }, { nom: 'DiscountCoupon', valeur: 'ZZPROMOESSAI' }] } }),
    'page « Mon Compte », champs de MForm : ActionID, DiscountCoupon');
  assert.equal(eliq.pageRecue({ titre: '', formulaire: null }), 'page « sans titre », aucun formulaire MForm');
  assert.equal(eliq.pageRecue({ titre: 'Commande 9200001 de client@exemple.invalid', formulaire: { champs: [] } }),
    'page « Commande ####### de … », champs de MForm : aucun');
  assert.equal(eliq.nomsDicibles(['ActionID', 'Champ 9200001', 'a"b<c>', '']), 'ActionID, Champ?#, a?b?c?, (sans nom)');
  const beaucoup = Array.from({ length: 35 }, (_, i) => `C${i}`);
  assert.match(eliq.nomsDicibles(beaucoup), /^C0, C1, .*, C29, … \(35 en tout\)$/);
  assert.equal(eliq.nomsDicibles([]), 'aucun');
});

// ---------------------------------------------------------------------------
// D4 — la pagination se lit là où elle est (R2)
// ---------------------------------------------------------------------------

test('D4 — aucune ligne « PagingAPIRowCount illisible » sur la page d\'arrivée ; elle sort encore si la page des commandes la perd', faux.SANS_NAVIGATEUR, async () => {
  const arrivee = await passer(faux.compteELiquide());
  assert.equal(arrivee.erreur, null);
  assert.doesNotMatch(arrivee.lignes.join('\n'), /PagingAPIRowCount illisible/, 'la page d\'arrivée n\'en porte pas, et rien n\'en est dit');
  assert.ok(arrivee.lignes.includes('e-liquide-fr : page 1 — 5 commande(s) lue(s), autant que PagingAPIRowCount (5) : la suivante est demandée.'),
    'la valeur est lue sur la page des commandes');

  const LIGNE = 'e-liquide-fr : PagingAPIRowCount illisible dans le formulaire de la page des commandes — 5 lignes par page retenues (valeur mesurée).';
  for (const [quoi, valeur] of [['absent', null], ['illisible', 'cinq']]) {
    const etat = faux.compteELiquide({ liste: { formulaire: { PagingAPIRowCount: valeur } } });
    const { resultat, erreur, journal, lignes } = await passer(etat);
    assert.equal(erreur, null, `${quoi} : ${erreur?.message}`);
    assert.equal(lignes.filter((l) => l === LIGNE).length, 1, `${quoi} : la ligne sort, une fois\n${lignes.join('\n')}`);
    assert.ok(lignes.indexOf(LIGNE) > lignes.findIndex((l) => /arrivée jugée « compte »/.test(l)), `${quoi} : après l'arrivée, à la page des commandes`);
    assert.equal(resultat.invoices.length, 12, `${quoi} : la valeur mesurée (5) sert, trois pages lues`);
    assert.equal(etat.compteurs.envois.length, 3);
    assert.deepEqual(etat.compteurs.envois[1], envoiListe(2, { PagingAPIRowCount: valeur }), `${quoi} : les champs tels que servis`);
    outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
  }
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur : D1, D3
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  const passage = (user, etat, extra = {}) => outils.parLePlanificateur({
    registry, scheduler, id: ID, hote: HOTE, site, etat, user, ecritures: envoisPermis, ...extra,
  });

  test('D1 — par le vrai planificateur, mot pour mot : douze factures depuis la page d\'arrivée, puis rien de nouveau', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot100e1', HOTE);
    const etat = faux.compteELiquide();
    let { r } = await passage(user, etat);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '12 factures récupérées — e-liquide-fr : 12 commandes lues sur 3 pages.');
    assert.deepEqual(etat.compteurs.envois[0], ENVOI_ARRIVEE, 'le premier envoi part de la page d\'arrivée');
    assert.equal(etat.compteurs.envois.length, 3);
    const lignes = outils.documents(db, user, ID);
    assert.equal(lignes.length, 12);
    assert.equal(new Set(lignes.map((l) => l.filename)).size, 12);
    const second = faux.compteELiquide();
    ({ r } = await passage(user, second));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Aucune nouvelle facture — e-liquide-fr : 12 commandes lues sur 3 pages, 12 factures déjà dans vos documents.');
    assert.equal(outils.documents(db, user, ID).length, 12, 'le second passage ne reprend rien');
    const journalApp = db.get().prepare('SELECT message FROM app_logs').all().map((l) => String(l.message)).join('\n');
    assert.doesNotMatch(journalApp, /PagingAPIRowCount illisible|ReloadMode autre que 0/, 'les deux lignes du 11/10 ne sortent plus');
    outils.journalApplicatifSansDonnee(db, DONNEES);
  });

  test('D3 — par le vrai planificateur : l\'envoi qui ne mène pas à la liste est un échec dit, rien n\'est déposé', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot100e2', HOTE);
    const etat = faux.compteELiquide({ reponseSuivi: 'compte' });
    const { r } = await passage(user, etat);
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'echec', 'ni « session expirée », ni « connexion refusée » : la page n\'est pas lue');
    assert.match(r.message, ILLISIBLE);
    assert.deepEqual(etat.compteurs.envois, [ENVOI_ARRIVEE], 'un seul envoi');
    assert.equal(outils.documents(db, user, ID).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Par construction : le code se LIT
// ---------------------------------------------------------------------------

test('par construction : la règle de la page d\'arrivée est dans la seule fonction d\'envoi, avant l\'envoi ; la fenêtre d\'âge se retire avant toute étape qui clique, sans clic', () => {
  const code = outils.codeSansCommentaires(path.join(__dirname, '..', 'server', 'connectors', 'available', 'e-liquide-fr', 'connector.js'));
  const debut = code.indexOf('const ENVOYER_LE_FORMULAIRE = ');
  const fin = code.indexOf('\n};', debut);
  assert.ok(debut >= 0 && fin > debut);
  const corps = code.slice(debut, fin);
  const envoi = corps.indexOf('HTMLFormElement.prototype.submit.call(form)');
  assert.ok(envoi >= 0);
  for (const garde of ["'#maincontainer.userdashboard'", "'table.PBTable'", 'champsPagination', 'champsArrivee',
    "coupon[0] !== ''", "actions[0] !== '0'", "'forme de MForm inconnue', noms", 'JSON.stringify(actuels) !== JSON.stringify(servis)']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < envoi, `la garde « ${garde} » est présente, et avant l'envoi`);
  }
  assert.equal((code.match(/\.submit\b/g) || []).length, 1, 'toujours un seul envoi dans tout le fichier');
  assert.deepEqual([...eliq.CHAMPS_ARRIVEE], ['ActionID', 'DiscountCoupon', 'ReloadMode', 'OrderID']);
  assert.deepEqual([...eliq.CHAMPS_PAGINATION], ['OrdersPageIdx', 'PagingAPIRowCount', 'PagingAPIHashCode']);
  assert.ok(Object.isFrozen(eliq.CHAMPS_ARRIVEE) && Object.isFrozen(eliq.CHAMPS_PAGINATION));

  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'connectors', 'obstructions.js'), 'utf8');
  const retirer = source.slice(source.indexOf('async function retirerLesConnues('), source.indexOf('\n}\n', source.indexOf('async function retirerLesConnues(')));
  assert.ok(retirer.length > 0);
  assert.doesNotMatch(retirer, /\.click\s*\(|keyboard|mouse|\.press\s*\(|\.dispatchEvent\s*\(|\.locator\s*\(/, 'le retrait ne clique pas, ne frappe rien');
  const fermer = source.slice(source.indexOf('async function fermer('), source.indexOf('\n}\n', source.indexOf('async function fermer(')));
  const zero = fermer.indexOf('await retirerLesConnues(page)');
  const clics = fermer.indexOf('await fermerDansUnCadre(cadre)');
  assert.ok(zero >= 0 && clics >= 0 && zero < clics, 'l\'étape 0 vient avant toute étape qui clique');
  assert.deepEqual(obstructions.RETRAITS_CONNUS.map((m) => ({ ...m })), [
    { nom: 'fenêtre de confirmation d\'âge', selecteur: '.ngdialog.age-gate', journal: 'fenêtre de confirmation d\'âge fermée' },
  ]);
  assert.ok(Object.isFrozen(obstructions.RETRAITS_CONNUS) && Object.isFrozen(obstructions.RETRAITS_CONNUS[0]));
});

test.after(() => {
  helpers.teardown();
});
