'use strict';

/**
 * Lot 99 — e-liquide-fr (Oxatis) : la liste servie par l'envoi ENFERMÉ du
 * formulaire « Mon compte », et chaque facture — une page du site — rendue en
 * PDF par le navigateur, sans rien y changer.
 *
 * Au VRAI Chromium, sur des pages RECONSTITUÉES fidèles à la structure du code
 * source enregistré par l'utilisateur le 11/10/2026 (test/lot99-faux-sites.js). La
 * pagination est INVENTÉE (la règle du R4, faute de mesure). La facture
 * d'essai est servie en `windows-1252`, comme la vraie : le PDF rendu est
 * RELU (tables ToUnicode, test/lot99-texte-pdf.js) pour y trouver « Facture »,
 * les accents et « € ». Aucune requête ne sort.
 *
 * Lot 100 : la page d'arrivée « Mon compte » du banc est désormais la vraie
 * (son MForm ne porte que ActionID et DiscountCoupon) ; le premier envoi est
 * comparé à ses champs, et les formes refusées sont servies sur elle. Ce que
 * chaque essai prouve ne change pas. Les essais propres au lot 100 :
 * test/lot100-e-liquide-fr.test.js.
 *
 * ⚠ Valeurs inventées : numéros 9 200 00x, « Client d'essai », 0,00 €.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const eliq = require('../server/connectors/available/e-liquide-fr/connector');
const faux = require('./lot99-faux-sites');
const faux93 = require('./lot93-faux-sites');
const outils = require('./lot99-outils');
const { texteDuPdf } = require('./lot99-texte-pdf');

const ID = 'e-liquide-fr';
const HOTE = faux.E_LIQUIDE;
const site = faux.siteELiquide;

const passer = (etat, options = {}) => outils.passer(eliq, { hote: HOTE, site, etat, ...options });

const POST = 'POST www.e-liquide-fr.com/PBUserAccount.asp';
const envoisPermis = (etat) => etat.compteurs.envois.map(() => POST);
const DONNEES = [/92000\d\d/, /Client d'essai/];

/** Les champs de MForm tels que la page « Suivi des commandes » d'essai les sert. */
const SERVIS = [
  ['ActionID', '0'], ['OrderID', ''], ['OrdersPageIdx', '1'], ['ReloadMode', '0'],
  ['PagingAPIRowCount', '5'], ['PagingAPIHashCode', 'hash-invente-0000'],
];

/**
 * Lot 100 : les champs de MForm tels que la page d'ARRIVÉE les sert (mesuré) —
 * le lot 99 lui prêtait ceux de la page des commandes (`SERVIS`).
 */
const SERVIS_ARRIVEE = [['ActionID', '0'], ['DiscountCoupon', '']];

/**
 * Chaque envoi, comparé aux champs servis. Le premier part de la page
 * d'arrivée : seul ActionID change (lot 100). Les suivants partent de la page
 * des commandes : seuls ActionID et OrdersPageIdx changent (lot 99).
 */
function seulsLesDeuxChampsChangent(envois) {
  envois.forEach((champs, i) => {
    if (i === 0) {
      assert.deepEqual(champs, SERVIS_ARRIVEE.map(([k, v]) => [k, k === 'ActionID' ? '8' : v]),
        'envoi 1, depuis la page d\'arrivée : les champs servis, seul ActionID passé de 0 à 8');
      return;
    }
    assert.deepEqual(champs.map(([k]) => k), SERVIS.map(([k]) => k), `envoi ${i + 1} : les mêmes champs, dans le même ordre`);
    const attendus = SERVIS.map(([k, v]) => [k, k === 'ActionID' ? '8' : k === 'OrdersPageIdx' ? String(i + 1) : v]);
    assert.deepEqual(champs, attendus, `envoi ${i + 1} : seuls ActionID (8) et OrdersPageIdx (${i + 1}) changent`);
  });
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D3 — douze commandes sur trois pages, douze PDF rendus depuis les pages .htm
// ---------------------------------------------------------------------------

test('D3 — douze commandes sur trois pages : douze PDF rendus depuis les pages .htm ; un PDF relu porte « Facture », les accents et un « € » correct', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide();
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message} ${erreur?.precision || ''}\n${lignes.join('\n')}`);
  assert.equal(resultat.invoices.length, 12);
  assert.equal(etat.compteurs.envois.length, 3, 'trois pages, trois envois');
  seulsLesDeuxChampsChangent(etat.compteurs.envois);
  assert.equal(etat.compteurs.factures.length, 12, 'chaque page .htm ouverte une fois');
  assert.deepEqual(etat.compteurs.appelsJs, [], 'aucun « javascript: » exécuté — ni WNDAPIOpenWindow, ni SelectItem');
  assert.equal(resultat.precision, '— e-liquide-fr : 12 commandes lues sur 3 pages.');
  assert.equal(preuves[0].elements, 12);
  assert.deepEqual(resultat.couverture, { complete: true, detail: '3 pages de commandes e-liquide-fr, 12 commandes' });

  // L'ancre : le numéro lu dans le nom du fichier .htm ; le nom ; la date de la ligne.
  assert.equal(resultat.invoices[0].remoteId, 'e-liquide-fr-facture-2026-09-9200001');
  assert.equal(resultat.invoices[0].filename, 'e-liquide-fr_2026-09_2026-09-9200001.pdf');
  assert.equal(resultat.invoices[0].issuedOn, '2026-09-01', '« 1 sept. 2026 »');
  assert.equal(resultat.invoices[1].issuedOn, '2026-08-02', '« 2 août 2026 »');
  assert.equal(new Set(resultat.invoices.map((f) => f.filename)).size, 12, 'jamais deux fois le même nom');

  // Le PDF, relu : c'est la page du vendeur, rendue par le navigateur.
  for (const f of resultat.invoices) assert.equal(f.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  const texte = texteDuPdf(resultat.invoices[0].buffer, { colle: true });
  assert.match(texte, /^Facture ZZ-9200001/, 'le titre « Facture »');
  assert.match(texte, /Désignation/, 'les accents (é = 0xE9 en windows-1252)');
  assert.match(texte, /Quantité/);
  assert.match(texte, /pêche/);
  assert.match(texte, /0,00 €/, 'un « € » correct (0x80 en windows-1252)');
  assert.doesNotMatch(texte, /�/, 'aucun caractère mal lu');

  assert.equal(ouverts, 0, 'le navigateur est refermé ; chaque onglet de facture aussi');
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
  outils.journalSansDonnee(lignes, DONNEES);
});

test('D3 — le relecteur discrimine : la même facture servie à tort en utf-8 sort cassée, et l\'essai le voit', faux.SANS_NAVIGATEUR, async () => {
  // Calibrage (A4) : la balise <meta> dit windows-1252, l'en-tête dit utf-8 ;
  // l'en-tête l'emporte, les octets sont mal lus. La relecture le dit.
  const etat = faux.compteELiquide({ commandes: faux.commandesELiquide(1), enteteFacture: 'text/html; charset=utf-8' });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  const texte = texteDuPdf(resultat.invoices[0].buffer, { colle: true });
  assert.match(texte, /^Facture ZZ-9200001/);
  assert.match(texte, /�/, 'les octets windows-1252 lus en utf-8 : U+FFFD');
  assert.doesNotMatch(texte, /0,00 €/);
});

test('D3 — une page 2 identique à la page 1 : arrêt, « pages suivantes non lues », la page 1 gardée', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ pagination: 'ignoree' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(etat.compteurs.envois.length, 2, 'la page 1, puis UNE demande de la suivante');
  seulsLesDeuxChampsChangent(etat.compteurs.envois);
  assert.equal(resultat.invoices.length, 5, 'les factures de la page 1 sont prises');
  assert.equal(resultat.precision, '— e-liquide-fr : 5 commandes lues sur 1 page. '
    + 'Pages suivantes non lues : quand crabe a demandé la page suivante, la boutique a renvoyé la même. '
    + 'Signalez-le pour que la lecture soit mise à jour.');
  assert.equal(resultat.couverture.complete, false);
  assert.match(lignes.join('\n'), /page 2 — identique à la précédente \(mêmes numéros\) : arrêt, pages suivantes non lues\./);
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
});

test('D3 — une facture .htm qui n\'est pas une facture : refusée, rien de déposé à sa place, dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ pasUneFacture: ['9200003'] });
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 11);
  assert.ok(!resultat.invoices.some((f) => f.remoteId.endsWith('-9200003')), 'rien de déposé pour elle');
  assert.equal(resultat.manquees, 1);
  assert.equal(resultat.precision, 'e-liquide-fr : 12 commandes lues sur 3 pages.');
  assert.match(lignes.join('\n'), /une facture n'a pas pu être prise : la page n'est pas une facture — la page n'a pas le titre « Facture » ni le tableau #InvoiceBody — rien n'est déposé à sa place\./);
});

test('D3 — dix commandes : deux pages pleines, la troisième vide ; fin de la liste, rien de « non lu »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ commandes: faux.commandesELiquide(10) });
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(etat.compteurs.envois.length, 3, 'la troisième page est demandée : la deuxième était pleine');
  assert.equal(resultat.invoices.length, 10);
  assert.equal(resultat.precision, '— e-liquide-fr : 10 commandes lues sur 2 pages.');
  assert.match(lignes.join('\n'), /page 3 — aucune commande : fin de la liste\./);
});

test('D3 — la borne : une pagination sans fin s\'arrête à 50 pages, et le dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ pagination: 'infinie' });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(etat.compteurs.envois.length, eliq.PAGES_MAX, 'cinquante envois, pas un de plus');
  assert.equal(resultat.aucunDocument, 'Votre compte e-liquide-fr a bien été lu : 250 commandes, aucune n\'a encore de facture.');
  assert.equal(resultat.precision, 'Pages suivantes non lues : crabe s\'arrête à 50 pages de commandes. '
    + 'Signalez-le, la limite est trop basse pour ce compte.');
});

test('une commande sans lien « facture » est dite, jamais comptée comme un échec', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ commandes: faux.commandesELiquide(4, { sansFacture: [1] }) });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 3);
  assert.equal(resultat.manquees, undefined);
  assert.equal(resultat.precision, '— e-liquide-fr : 4 commandes lues sur 1 page, 1 commande sans facture.');
});

// ---------------------------------------------------------------------------
// D4 — l'envoi du formulaire, enfermé
// ---------------------------------------------------------------------------

test('D4 — un formulaire servi avec ReloadMode à 1, un OrderID, une autre adresse, une autre méthode, une autre fenêtre : rien ne part', faux.SANS_NAVIGATEUR, async () => {
  // Lot 100 : ces formes sont servies sur la page d'ARRIVÉE (le banc les y
  // pose aussi) : c'est d'elle que part le premier envoi. Elle ne porte pas
  // de ReloadMode : le doublon y est servi en deux exemplaires.
  const cas = [
    ['ReloadMode à 1', { formulaire: { ReloadMode: '1' } }, /ReloadMode autre que 0/],
    ['OrderID non nul', { formulaire: { OrderID: '9200001' } }, /OrderID non nul/],
    ['vers le panier', { action: 'PBShoppingCart.asp' }, /adresse d'envoi différente/],
    ['vers un autre site', { action: 'https://www.exemple.invalid/PBUserAccount.asp' }, /adresse d'envoi différente/],
    ['dans une autre fenêtre', { cible: '_blank' }, /envoi vers une autre fenêtre/],
    ['un ReloadMode en double', { champsEnPlus: '<input type="hidden" name="ReloadMode" value="0"><input type="hidden" name="ReloadMode" value="0">' }, /ReloadMode autre que 0/],
  ];
  for (const [quoi, extra, motif] of cas) {
    const etat = faux.compteELiquide(extra);
    const { erreur, journal, lignes } = await passer(etat);
    assert.ok(erreur, quoi);
    assert.match(erreur.message, /n'a pas su lire la page de vos commandes/, quoi);
    assert.match(lignes.join('\n'), motif, quoi);
    assert.deepEqual(etat.compteurs.envois, [], `${quoi} : aucun envoi n'est parti`);
    assert.deepEqual(journal.ecritures, [], `${quoi} : aucune requête d'écriture`);
    assert.deepEqual(etat.compteurs.interdits, [], `${quoi} : le panier n'est jamais demandé`);
  }
});

test('D4 — un champ changé par la page ENTRE la lecture et l\'envoi : rien ne part ; inchangé, un seul envoi, fidèle', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide();
  const banc = await faux93.ouvrirFauxSite([HOTE], site(etat));
  try {
    const { page } = banc;
    await page.context().addCookies([{ name: faux.COOKIE.name, value: faux.COOKIE.value, domain: HOTE, path: '/', secure: true }]);
    await page.goto(eliq.URL_COMPTE);
    // Lot 100 : la page d'arrivée ne porte que ActionID et DiscountCoupon —
    // ce sont eux qu'un script changerait (la même garde vaut pour la page
    // des commandes : test/lot100-e-liquide-fr.test.js).
    for (const [quoi, geste] of [
      ['le code promotionnel rempli', () => { document.forms.MForm.elements.DiscountCoupon.value = 'ZZPROMO'; }],
      ['ActionID passé à 10 (« Recharger »)', () => { document.forms.MForm.elements.ActionID.value = '10'; }],
      ['un champ ajouté', () => {
        const champ = document.createElement('input');
        champ.type = 'hidden';
        champ.name = 'Supplement';
        champ.value = 'x';
        document.forms.MForm.appendChild(champ);
      }],
      ['l\'adresse changée', () => { document.forms.MForm.setAttribute('action', 'PBShoppingCart.asp'); }],
    ]) {
      await page.goto(eliq.URL_COMPTE);
      const vue = await page.evaluate(eliq.LIRE_LA_PAGE);
      assert.ok(vue.formulaire, 'le formulaire est lu');
      await page.evaluate(geste); // ce qu'un script du site ferait entre la lecture et l'envoi
      const envoi = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '8' });
      assert.equal(envoi.envoye, false, quoi);
      assert.match(envoi.raison, /a changé depuis sa lecture|adresse d'envoi différente/, quoi);
      assert.deepEqual(etat.compteurs.envois, [], `${quoi} : rien n'est parti`);
    }
    // Témoin : la même chose sans geste part, une fois, telle que servie.
    await page.goto(eliq.URL_COMPTE);
    const vue = await page.evaluate(eliq.LIRE_LA_PAGE);
    const envoi = await eliq.envoyerLeFormulaire(page, vue.formulaire, { ActionID: '8' });
    assert.equal(envoi.envoye, true);
    assert.equal(etat.compteurs.envois.length, 1);
    seulsLesDeuxChampsChangent(etat.compteurs.envois);
    // Et une modification hors des deux champs permis n'est jamais demandée.
    await page.goto(eliq.URL_COMPTE);
    const vue2 = await page.evaluate(eliq.LIRE_LA_PAGE);
    const refus = await eliq.envoyerLeFormulaire(page, vue2.formulaire, { ActionID: '8', ReloadMode: '0' });
    assert.equal(refus.envoye, false);
    assert.match(refus.raison, /modification d'un champ non permis/);
    const autre = await eliq.envoyerLeFormulaire(page, vue2.formulaire, { ActionID: '9' });
    assert.equal(autre.envoye, false);
    assert.match(autre.raison, /ActionID autre que « Suivi des commandes »/);
    assert.equal(etat.compteurs.envois.length, 1, 'toujours un seul envoi');
    assert.deepEqual(banc.journal.fuites, []);
    assert.deepEqual(banc.journal.clics, []);
  } finally {
    await banc.fermer();
  }
});

// ---------------------------------------------------------------------------
// D5 — adresses interdites, même dans un WNDAPIOpenWindow ; aucun javascript:
// ---------------------------------------------------------------------------

test('D5 — un WNDAPIOpenWindow qui pointe le panier est écarté sans être suivi ; « Recharger » n\'est jamais demandé ; aucun javascript: exécuté', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ commandes: faux.commandesELiquide(3) });
  etat.commandes[1].appelFacture = 'javascript:WNDAPIOpenWindow(\'InvoiceView\',\'PBShoppingCart.asp?ReloadOrderID=9200002\',800,600)';
  etat.commandes[2].appelFacture = 'javascript:WNDAPIOpenWindow(\'InvoiceView\',\'https://www.exemple.invalid/Files/1/Orders/2/Invoice-2026-07-3.htm\',800,600)';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ['e-liquide-fr-facture-2026-09-9200001']);
  assert.match(lignes.join('\n'), /il porte le mot interdit « ReloadOrderID »/, 'le premier mot de la liste qu\'elle porte');
  assert.match(lignes.join('\n'), /son adresse n'a pas la forme d'une facture de la boutique/);
  assert.equal(resultat.precision, '— e-liquide-fr : 3 commandes lues sur 1 page. '
    + '2 liens ont été écartés : ils ne menaient pas à une facture de la boutique.');
  assert.deepEqual(etat.compteurs.appelsJs, []);
  assert.ok(!journal.requetes.some((r) => /PBShoppingCart|ReloadOrderID|exemple\.invalid/.test(r)), 'rien n\'est demandé');
  outils.rienQueDesLectures(journal, etat, { ecritures: envoisPermis(etat) });
});

// ---------------------------------------------------------------------------
// D6 — la page de connexion à la place de la liste
// ---------------------------------------------------------------------------

test('D6 — la page de connexion à la place de « Mon compte », puis à la place de la liste : un renvoi, marqué pour le lot 91', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteELiquide({ connecte: false });
  const avant = await passer(etat);
  assert.ok(avant.erreur);
  assert.equal(avant.erreur.sessionExpired, true);
  assert.equal(avant.erreur.renvoiAuthentification, true);
  assert.match(avant.lignes.join('\n'), /arrivée jugée « connexion-demandee » — renvoyé vers \/PBUserLogin\.asp, la page de connexion/);
  assert.deepEqual(etat.compteurs.envois, [], 'rien n\'est envoyé sans « Mon compte »');

  // La session tombe entre « Mon compte » et la liste : le POST rend la connexion.
  const etat2 = faux.compteELiquide();
  const servir = site(etat2);
  const tombe = () => async (url, requete) => {
    if (requete.method() === 'POST') etat2.connecte = false;
    return servir(url, requete);
  };
  const pendant = await outils.passer(eliq, { hote: HOTE, site: tombe, etat: etat2 });
  assert.ok(pendant.erreur);
  assert.equal(pendant.erreur.sessionExpired, true);
  assert.equal(pendant.preuves.length, 0);
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('l\'appel du lien « facture », lu comme un texte : seul InvoiceView donne un chemin', () => {
  assert.equal(eliq.cheminDeLAppel('javascript:WNDAPIOpenWindow(\'InvoiceView\',\'Files/1/Orders/2/Invoice-2026-03-3.htm\',800,600)'),
    'Files/1/Orders/2/Invoice-2026-03-3.htm');
  assert.equal(eliq.cheminDeLAppel('javascript: WNDAPIOpenWindow( "InvoiceView" , "Files/1/x.htm" )'), 'Files/1/x.htm');
  assert.equal(eliq.cheminDeLAppel('javascript:WNDAPIOpenWindow(\'InvoiceWnd\',\'PBRenderInvoice.asp?PBLangID=0&OrderID=2\',800,600)'), null);
  assert.equal(eliq.cheminDeLAppel('javascript:SelectItem(2,9)'), null);
  assert.equal(eliq.cheminDeLAppel('/PBShoppingCart.asp?ReloadOrderID=2'), null);
});

test('l\'adresse d\'une facture : sur la boutique, sous /Files/, en .htm, sans paramètre ni « .. » ni mot interdit', () => {
  assert.deepEqual(eliq.adresseDeFacture('Files/1/Orders/2/Invoice-2026-03-3.htm'), {
    adresse: 'https://www.e-liquide-fr.com/Files/1/Orders/2/Invoice-2026-03-3.htm',
    numeroFacture: '2026-03-3',
    mois: '2026-03',
  });
  assert.equal(eliq.adresseDeFacture('/Files/1/Orders/2/facture.htm').numeroFacture, null, 'un autre nom : pas de numéro, l\'adresse reste valable');
  for (const mauvaise of [
    'Files/1/Orders/2/Invoice-2026-03-3.html',
    'Files/1/Orders/2/Invoice-2026-03-3.htm?x=1',
    'Files/1/Orders/2/Invoice-2026-03-3.htm#haut',
    'Docs/1/Invoice-2026-03-3.htm',
    'Files/../PBUserAccount.htm',
    'https://www.exemple.invalid/Files/1/Invoice-2026-03-3.htm',
    'http://www.e-liquide-fr.com/Files/1/Invoice-2026-03-3.htm',
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(eliq.adresseDeFacture(mauvaise), null, mauvaise);
  }
  assert.deepEqual(eliq.adresseDeFacture('PBShoppingCart.asp?ReloadOrderID=2'), { refus: 'ReloadOrderID' });
  assert.deepEqual(eliq.adresseDeFacture('Files/panier/Invoice-1.htm'), { refus: 'panier' });
});

test('les trois jugements : « Mon compte », la liste, la facture', () => {
  const compte = { url: eliq.URL_COMPTE, connecte: true, formulaire: { champs: [] } };
  assert.equal(eliq.jugerCompte(compte).verdict, 'compte');
  assert.equal(eliq.jugerCompte({ ...compte, connecte: false }).verdict, 'connexion-demandee', 'sans is-user-logged');
  assert.equal(eliq.jugerCompte({ ...compte, url: 'https://www.e-liquide-fr.com/PBUserLogin.asp?CCode=33' }).verdict, 'connexion-demandee');
  assert.equal(eliq.jugerCompte({ ...compte, formulaire: null }).verdict, 'page-illisible');
  assert.equal(eliq.jugerCompte({ ...compte, mur: true }).verdict, 'mur');
  assert.equal(eliq.jugerListe({ ...compte, tableau: true }).verdict, 'liste');
  assert.equal(eliq.jugerListe({ ...compte, tableau: false }).verdict, 'page-illisible');
  assert.equal(eliq.jugerListe({ ...compte, connecte: false, tableau: true }).verdict, 'connexion-demandee');
  const adresse = 'https://www.e-liquide-fr.com/Files/1/Orders/2/Invoice-2026-03-3.htm';
  assert.equal(eliq.jugerFacture({ url: adresse, titre: 'Facture', corps: true }, adresse).verdict, 'facture');
  assert.equal(eliq.jugerFacture({ url: adresse, titre: 'Erreur', corps: true }, adresse).verdict, 'pas-une-facture');
  assert.equal(eliq.jugerFacture({ url: adresse, titre: 'Facture', corps: false }, adresse).verdict, 'pas-une-facture');
  assert.equal(eliq.jugerFacture({ url: 'https://www.e-liquide-fr.com/PBUserLogin.asp', titre: 'Identification' }, adresse).verdict, 'connexion-demandee');
  assert.equal(eliq.jugerFacture({ url: 'https://www.e-liquide-fr.com/', titre: 'Facture', corps: true }, adresse).verdict, 'pas-une-facture');
});

test('la pagination : pleine → la suivante ; plus courte, vide, identique, la borne → arrêt', () => {
  const d = (o) => eliq.decisionPagination({ lignesParPage: 5, ...o });
  assert.equal(d({ n: 1, lues: 5, numeros: ['a', 'b', 'c', 'd', 'e'] }), 'suivante');
  assert.equal(d({ n: 2, lues: 2, numeros: ['f', 'g'], precedents: ['a', 'b', 'c', 'd', 'e'] }), 'fin');
  assert.equal(d({ n: 2, lues: 0, numeros: [], precedents: ['a', 'b', 'c', 'd', 'e'] }), 'vide');
  assert.equal(d({ n: 2, lues: 5, numeros: ['a', 'b', 'c', 'd', 'e'], precedents: ['a', 'b', 'c', 'd', 'e'] }), 'identique');
  assert.equal(d({ n: 2, lues: 6, numeros: ['a', 'b', 'c', 'd', 'e', 'f'] }), 'fin', 'plus que PagingAPIRowCount : pas « autant »');
  assert.equal(d({ n: eliq.PAGES_MAX, lues: 5, numeros: ['v', 'w', 'x', 'y', 'z'] }), 'borne');
  assert.equal(eliq.lignesParPageDe({ champs: [{ nom: 'PagingAPIRowCount', valeur: '5' }] }), 5);
  assert.equal(eliq.lignesParPageDe({ champs: [{ nom: 'PagingAPIRowCount', valeur: 'cinq' }] }), null);
  assert.equal(eliq.lignesParPageDe(null), null);
});

test('l\'ancre et le nom : le numéro du fichier, à défaut celui de la commande ; jamais deux fois le même nom', () => {
  assert.equal(eliq.remoteIdDe({ numeroFacture: '2026-03-3', numeroCommande: '3' }), 'e-liquide-fr-facture-2026-03-3');
  assert.equal(eliq.remoteIdDe({ numeroFacture: null, numeroCommande: '3' }), 'e-liquide-fr-commande-3');
  assert.deepEqual(eliq.nommer([
    { issuedOn: '2026-03-07', numeroFacture: '2026-03-3' },
    { issuedOn: '2026-03-07', numeroFacture: '2026-03-3' },
    { issuedOn: null, numeroFacture: null, numeroCommande: '4' },
  ]), ['e-liquide-fr_2026-03_2026-03-3.pdf', 'e-liquide-fr_2026-03_2026-03-3-2.pdf', 'e-liquide-fr_4.pdf']);
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

  const passage = (user, etat, extra = {}) => outils.parLePlanificateur({
    registry, scheduler, id: ID, hote: HOTE, site, etat, user, ecritures: envoisPermis, ...extra,
  });

  test('D9 — les messages, mot pour mot : douze factures sur trois pages, puis rien de nouveau ; une page 2 identique', faux.SANS_NAVIGATEUR, async () => {
    const u1 = await outils.compteAvec(helpers, registry, ID, 'lot99e1', HOTE);
    let { r } = await passage(u1, faux.compteELiquide());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '12 factures récupérées — e-liquide-fr : 12 commandes lues sur 3 pages.');
    const lignes = outils.documents(db, u1, ID);
    assert.equal(lignes.length, 12);
    assert.equal(new Set(lignes.map((l) => l.filename)).size, 12);
    ({ r } = await passage(u1, faux.compteELiquide()));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Aucune nouvelle facture — e-liquide-fr : 12 commandes lues sur 3 pages, 12 factures déjà dans vos documents.');
    assert.equal(outils.documents(db, u1, ID).length, 12, 'le second passage ne reprend rien');

    const u2 = await outils.compteAvec(helpers, registry, ID, 'lot99e2', HOTE);
    ({ r } = await passage(u2, faux.compteELiquide({ pagination: 'ignoree' })));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '5 factures récupérées — e-liquide-fr : 5 commandes lues sur 1 page. '
      + 'Pages suivantes non lues : quand crabe a demandé la page suivante, la boutique a renvoyé la même. '
      + 'Signalez-le pour que la lecture soit mise à jour.');
    outils.journalApplicatifSansDonnee(db, DONNEES);
  });

  test('D6 — après une connexion qui a marché, la page de connexion à la place de « Mon compte » : « session expirée »', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99e3', HOTE);
    let { r } = await passage(user, faux.compteELiquide({ commandes: faux.commandesELiquide(2) }));
    assert.equal(r.ok, true, r.message);
    ({ r } = await passage(user, faux.compteELiquide({ connecte: false })));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree');
  });

  test('D7 — le temps permis écoulé au milieu : ce qui est pris est en base, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot99e4', HOTE);
    await outils.avecLimite(30 * 60 * 1000, async () => {
      // 4 minutes par facture servie, budget 20 minutes : six factures, puis l'arrêt.
      let t = 0;
      let { r } = await passage(user, faux.compteELiquide({ surFacture: () => { t += 4 * 60 * 1000; } }), { horloge: () => t });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '6 factures récupérées — e-liquide-fr : 12 commandes lues sur 3 pages. '
        + 'La récupération a pris tout le temps permis : 6 factures attendent encore ; elles viendront au prochain passage. '
        + 'Rien de ce qui a été pris n\'est perdu.');
      assert.equal(outils.documents(db, user, ID).length, 6, 'les six factures prises sont EN BASE');
      t = 0;
      ({ r } = await passage(user, faux.compteELiquide(), { horloge: () => t }));
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '6 factures récupérées — e-liquide-fr : 12 commandes lues sur 3 pages, 6 factures déjà dans vos documents.');
      assert.equal(outils.documents(db, user, ID).length, 12, 'le reste, au passage suivant');
    });
  });
});

test.after(() => {
  helpers.teardown();
});
