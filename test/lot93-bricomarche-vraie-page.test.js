'use strict';

/**
 * Lot 93 — Bricomarché lu sur la structure de sa VRAIE page « Mes achats ».
 *
 * Le 06/10/2026, crabe a reconnu la page (cinq signes sur six), lu « 0
 * commande » dans l'onglet « En ligne », et conclu « page illisible ». Le code
 * source de la page, enregistré par l'utilisateur, dit pourquoi (A4,
 * docs/reconnaissance-lot93.md) : le titre est un `h3`, une commande n'a
 * aucun lien, son titre vit dans le `header` de sa carte, et les onglets sont
 * des boutons sans adresse.
 *
 * Ces essais tournent au VRAI Chromium sur des pages RECONSTITUÉES fidèles à
 * cette structure (test/lot93-faux-sites.js). Ils prouvent la lecture de
 * cette forme, pas le vrai site. Chaque clic est compté par la page, avec le
 * `data-testid` de ce qui a été cliqué ; aucune requête ne sort.
 *
 * ⚠ Toutes les valeurs sont inventées (numéros « ZZ… », montants à 0,00 €).
 *
 * ─── Lot 94 : « Voir mon ticket » se clique ──────────────────────────────────
 *
 * Le lot 93 verrouillait « Voir mon ticket n'est jamais cliqué » et la phrase
 * « crabe ne sait pas encore l'ouvrir ». Le lot 94 renverse exactement ces
 * deux garanties : le clic télécharge le ticket de caisse (annoncé par l'utilisateur),
 * et la page reconstituée le fait désormais. Modifiés par décision, nommés
 * dans le PROGRESS du lot 94 : `rienQueLePermis` (le ticket est permis, mais
 * seulement EN DERNIER), les trois D1 qui lisent les achats en magasin, les
 * quatre D2 (volet bouton, volet lien, « par construction », clé hors liste),
 * le D3 du chevron qui ne déplie rien, « ce que l'utilisateur lit » et le
 * vrai planificateur. Leur objet — la lecture, le relevé du volet, les trois
 * autres clics — ne change pas.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const bricomarche = require('../server/connectors/available/bricomarche/connector');
const faux = require('./lot93-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'bricomarche', 'connector.js');
const R = bricomarche.REPERES;

/**
 * Le compte du 06/10, à la forme du réel et aux valeurs inventées : une
 * commande en ligne, cinq achats en magasin — dont un de 2025, qui ne se voit
 * qu'avec « Toutes mes commandes ».
 */
function etatDuSixOctobre(extra = {}) {
  return {
    enLigne: [{
      numero: 'ZZ00000001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z',
      etat: 'Livrée', vendeur: 'Bricomarché',
    }],
    enMagasin: [
      { mois: 'Février 2026', dateAffichee: '03/02/2026' },
      { mois: 'Février 2026', dateAffichee: '01/02/2026' },
      { mois: 'Janvier 2026', dateAffichee: '20/01/2026' },
      { mois: 'Janvier 2026', dateAffichee: '09/01/2026' },
      { mois: 'Décembre 2025', dateAffichee: '15/12/2025' },
    ],
    ...extra,
  };
}

/**
 * Lot 94 : le passage du 06/10 PREND ses cinq tickets. « 5 factures
 * récupérées » vient du planificateur ; le connecteur dit ce qu'elles sont,
 * puis le résumé de la page, sans la phrase « crabe ne sait pas encore
 * l'ouvrir », qui n'existe plus.
 */
const RESUME_DU_SIX_OCTOBRE =
  'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 5 achats en magasin. '
  + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.';
const PRECISION_DU_SIX_OCTOBRE = `— ce sont les tickets de caisse de 5 achats en magasin. ${RESUME_DU_SIX_OCTOBRE}`;
const CINQ_TICKETS = Array(5).fill(bricomarche.REPERES.ticket);

async function passer(etat, { socle = false, ctxExtra = {} } = {}) {
  const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etat));
  const enr = faux.contexteEnregistreur(ctxExtra);
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await faux.surLeFauxProfil(site, () => bricomarche.fetchInvoices({}, enr.ctx), { socle });
    } catch (err) {
      erreur = err;
    }
    return { resultat, erreur, journal: site.journal, lignes: enr.lignes, preuves: enr.preuves };
  } finally {
    await site.fermer();
  }
}

const repereDe = (clics) => clics.map((c) => c.testid);

/**
 * Ce qui doit tenir à CHAQUE passage : les seuls clics permis, rien de saisi,
 * rien de sorti. Lot 94 : « Voir mon ticket » est permis, mais seulement EN
 * DERNIER — après lui, plus aucun autre clic.
 */
function rienQueLePermis(journal) {
  const permis = new Set(Object.values(bricomarche.CLICS_PERMIS));
  for (const c of journal.clics) {
    assert.ok(permis.has(c.testid), `un clic hors de la liste fermée : ${JSON.stringify(c)}`);
  }
  const premierTicket = journal.clics.findIndex((c) => c.testid === R.ticket);
  if (premierTicket >= 0) {
    assert.ok(journal.clics.slice(premierTicket).every((c) => c.testid === R.ticket),
      `les tickets se demandent en dernier : ${JSON.stringify(journal.clics.map((c) => c.testid))}`);
  }
  assert.ok(!journal.clics.some((c) => /facture|retourner/i.test(c.libelle)),
    'rien du volet déplié n\'est cliqué');
  assert.deepEqual(journal.saisies, [], 'rien n\'est saisi');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D1 — la page fidèle : six signes, une commande, cinq achats, 0 document
// ---------------------------------------------------------------------------

test('D1 — la page fidèle au code source du 06/10 : six signes, 1 commande en ligne, 5 achats en magasin, leurs 5 tickets (lot 94)', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes, preuves } = await passer(etatDuSixOctobre());
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 5, 'aucune facture n\'est proposée, mais les 5 tickets de caisse sont pris (lot 94)');
  assert.equal(resultat.aucunDocument, undefined);
  assert.equal(resultat.precision, PRECISION_DU_SIX_OCTOBRE);
  assert.match(texte, /signes présents : adresse, titre, ongletEnLigne, ongletEnMagasin, filtre, deconnexion \(/);
  assert.doesNotMatch(texte, /reconnus par leur texte seulement/, 'tous les repères sont là');
  assert.match(texte, /onglet « En ligne » — 1 commande\(s\)\./);
  assert.match(texte, /commande 1\/1 — numéro lu \(2 lettre\(s\), 8 chiffre\(s\)\), date lue \(attribut datetime\), état « Livrée », vendeur lu\./);
  assert.match(texte, /commande 1\/1 — détail déplié : rien n'y évoque une facture\./);
  assert.match(texte, /onglet « En magasin » — cliqué par son repère, devenu l'actif, contenu changé\./);
  assert.match(texte, /onglet « En magasin » — 5 achat\(s\) : 5 date\(s\) et 5 montant\(s\) lus, 5 bouton\(s\) « Voir mon ticket »\./);
  assert.doesNotMatch(texte, /ZZ\d/, 'aucun numéro de commande au journal');
  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].elements, 6, '1 commande + 5 achats');
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...CINQ_TICKETS],
    `le chevron, l'onglet, puis les cinq tickets (lot 94) : ${JSON.stringify(journal.clics)}`);
  assert.ok(journal.visites.some((v) => /choiceOrder=0&historyOrderFilter=all/.test(v)),
    'la liste est lue avec « Toutes mes commandes »');
  rienQueLePermis(journal);
});

test('D1 — la lecture elle-même : le numéro dans le span du h2, la date de l\'attribut datetime, l\'état, le vendeur ; les achats en magasin', faux.SANS_NAVIGATEUR, async () => {
  const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etatDuSixOctobre({ onglet: 'magasin' })));
  try {
    await site.page.goto('https://www.bricomarche.com/my-account/orders?choiceOrder=0&historyOrderFilter=all');
    const magasin = await site.page.evaluate(bricomarche.LIRE_EN_MAGASIN, {
      reperes: R, motifFacture: bricomarche.MOTIF_FACTURE.source, motifVide: bricomarche.MOTIF_VIDE.source,
    });
    assert.equal(magasin.achats.length, 5);
    assert.equal(magasin.commandesEnLigne, 0);
    assert.deepEqual(magasin.achats.map((a) => a.date),
      ['03/02/2026', '01/02/2026', '20/01/2026', '09/01/2026', '15/12/2025']);
    assert.ok(magasin.achats.every((a) => a.montantLu && a.ticket?.parRepere && !a.factures.length));

    await site.page.goto('https://www.bricomarche.com/my-account/orders?choiceOrder=0&historyOrderFilter=all&x=web');
    await site.page.evaluate(() => document.getElementById('onglet-web').click());
    await site.page.waitForFunction(() => document.querySelector('h2 span'));
    const enLigne = await site.page.evaluate(bricomarche.LIRE_EN_LIGNE, {
      reperes: R, motifFacture: bricomarche.MOTIF_FACTURE.source, motifVide: bricomarche.MOTIF_VIDE.source,
    });
    assert.equal(enLigne.commandes.length, 1);
    const [c] = enLigne.commandes;
    assert.equal(c.numero, 'ZZ00000001', 'le numéro est le span du h2');
    assert.equal(c.datetime, '2026-03-12T09:30:00.000Z', 'la date est l\'attribut datetime');
    assert.equal(c.etat, 'Livrée');
    assert.equal(c.vendeur, 'Bricomarché');
    assert.deepEqual(c.chevron, { rang: 0, deplie: false, controle: 'order-details-ZZ00000001' });
    assert.deepEqual(site.journal.fuites, []);
  } finally {
    await site.fermer();
  }
});

test('D1 — trois commandes sur deux mois, dont une de 2025 : toutes comptées et dépliées, grâce à « Toutes mes commandes »', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({
    enLigne: [
      { numero: 'ZZ00000001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z' },
      { numero: 'ZZ00000002', mois: 'Mars 2026', dateAffichee: '02/03/2026', iso: '2026-03-02T09:30:00.000Z' },
      { numero: 'ZZ00000003', mois: 'Novembre 2025', dateAffichee: '20/11/2025', iso: '2025-11-20T09:30:00.000Z' },
    ],
  }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.match(resultat.precision, /3 commandes en ligne et 5 achats en magasin/);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.deplier, R.deplier, R.ongletEnMagasin, ...CINQ_TICKETS]);
  rienQueLePermis(journal);
});

test('D1 — arrivée sur l\'onglet « En magasin » : lu d\'abord, puis « En ligne » par SON clic', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ onglet: 'magasin' }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.equal(resultat.precision, PRECISION_DU_SIX_OCTOBRE);
  assert.match(lignes.join('\n'), /onglet actif à l'arrivée : « En magasin »/);
  // Lot 94 : les tickets se demandent en dernier — l'onglet « En magasin » est rouvert pour eux.
  assert.match(lignes.join('\n'), /onglet « En magasin » — rouvert par son repère pour les tickets\./);
  assert.deepEqual(repereDe(journal.clics), [R.ongletEnLigne, R.deplier, R.ongletEnMagasin, ...CINQ_TICKETS]);
  rienQueLePermis(journal);
});

test('D1 — deux panneaux qui se disent vides : réussite, « aucune commande en ligne et aucun achat en magasin »', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ enLigne: [], enMagasin: [] }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.equal(resultat.aucunDocument,
    'Votre espace client Bricomarché a bien été lu : aucune commande en ligne et aucun achat en magasin. '
    + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.');
  assert.deepEqual(repereDe(journal.clics), [R.ongletEnMagasin]);
  rienQueLePermis(journal);
});

// ---------------------------------------------------------------------------
// D2 — les clics : trois repères, rien d'autre
// ---------------------------------------------------------------------------

test('D2 — un bouton de facture dans le volet déplié : relevé, 0 clic, dit à l\'utilisateur', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ volet: 'bouton' }));
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 5, 'les cinq tickets (lot 94), aucune facture');
  assert.match(texte, /commande 1\/1 — un élément évoque une facture : « Télécharger ma facture », bouton sans adresse\. Non cliqué/);
  assert.equal(resultat.precision,
    '— ce sont les tickets de caisse de 5 achats en magasin. '
    + 'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 5 achats en magasin. '
    + 'Une facture semble proposée pour 1 commande(s) (« Télécharger ma facture ») : crabe ne sait pas encore '
    + 'la récupérer et n\'y a pas touché. Signalez-le, avec le libellé du bouton, ce que fait son clic et une '
    + 'capture de la commande dépliée : c\'est ce qui permettra d\'écrire la suite.');
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...CINQ_TICKETS], 'le bouton de facture n\'est pas cliqué');
  rienQueLePermis(journal);
});

test('D2 — un lien de facture dans le volet : relevé tel quel, jamais suivi', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ volet: 'lien' }));
  assert.equal(erreur, null);
  assert.deepEqual(journal.requetes.filter((r) => /invoice/.test(r)), [], 'le lien de facture n\'est pas suivi');
  assert.match(lignes.join('\n'), /« Facture \(PDF\) », lien avec adresse, marqué « télécharger »\. Non cliqué/);
  assert.match(resultat.precision, /Une facture semble proposée pour 1 commande\(s\) \(« Facture \(PDF\) »\)/);
  rienQueLePermis(journal);
});

test('D2 — par construction : un seul .click( dans le fichier, dans CLIQUER_PAR_REPERE, sur une liste fermée de repères exacts (quatre depuis le lot 94)', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const clics = code.match(/\.click\s*\(/g) || [];
  assert.equal(clics.length, 1, `un seul .click( dans le connecteur, trouvé ${clics.length}`);
  const corps = bricomarche.CLIQUER_PAR_REPERE.toString();
  assert.match(corps, /cible\.click\(\)/, 'le seul clic est celui de CLIQUER_PAR_REPERE');
  const garde = corps.indexOf("cible.getAttribute('data-testid') !== attendu");
  const clic = corps.indexOf('cible.click()');
  assert.ok(garde >= 0 && clic >= 0 && garde < clic, 'le repère est recontrôlé AVANT le clic');
  assert.match(corps, /el\.getAttribute\('data-testid'\) === attendu && visible\(el\)/,
    'les candidats : le repère EXACT (égalité stricte, jamais un motif) et visibles');
  assert.match(corps, /querySelectorAll\('button'\)/, 'seuls des boutons sont candidats');
  assert.match(corps, /deplier && cible\.getAttribute\('aria-expanded'\) !== 'false'/, 'un chevron déplié n\'est jamais recliqué');
  assert.deepEqual(Object.keys(bricomarche.CLICS_PERMIS).sort(), ['deplier', 'ongletEnLigne', 'ongletEnMagasin', 'ticket']);
  assert.deepEqual(Object.values(bricomarche.CLICS_PERMIS).sort(), [
    'account_filtered-orders_tab-instore',
    'account_filtered-orders_tab-web',
    'account_purchase-history_view-ticket',
    'account_web-order-item_toggle-details',
  ]);
  assert.ok(Object.isFrozen(bricomarche.CLICS_PERMIS), 'la liste est gelée');
  assert.equal(bricomarche.CLICS_PERMIS.ticket, R.ticket, 'lot 94 : « Voir mon ticket » y est, par son repère exact');
  for (const geste of [/\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.selectOption\s*\(/,
    /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/,
    /keyboard\./, /mouse\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.accept\s*\(/, /\.focus\s*\(/]) {
    assert.doesNotMatch(code, geste, `aucun autre geste sur la page (${geste})`);
  }
  // L'appel du clic côté Node : la clé est contrôlée contre la liste fermée.
  const cote = bricomarche.cliquer.toString();
  assert.match(cote, /hasOwnProperty\.call\(CLICS_PERMIS, cle\)/);
  assert.match(cote, /clique !== attendu/, 'le repère rendu est revérifié côté Node');
});

test('D2 — une clé hors de la liste fermée est refusée avant tout geste', async () => {
  let evaluations = 0;
  const pageEspionne = { evaluate: async () => { evaluations++; return null; } };
  for (const cle of ['menuAchats', 'deconnexion', '__proto__', 'constructor', 'toString']) {
    await assert.rejects(() => bricomarche.cliquer(pageEspionne, cle), /n'est pas un clic permis/);
  }
  // Lot 94 : « ticket » est permis, mais jamais sans la carte de son achat.
  await assert.rejects(() => bricomarche.cliquer(pageEspionne, 'ticket', 0), /qu'avec la carte de son achat/);
  assert.equal(evaluations, 0, 'la page n\'a même pas été interrogée');
});

test('D2 — CLIQUER_PAR_REPERE, au vrai Chromium : seul le bouton au repère EXACT, visible et actif part ; un chevron déplié ne se replie jamais', faux.SANS_NAVIGATEUR, async () => {
  const piege = faux.gabarit('Piège', `
    <button type="button" data-testid="account_filtered-orders_tab-instore-v2" onclick="window.__c.push('suffixe')">En magasin</button>
    <button type="button" data-testid=" account_filtered-orders_tab-instore" onclick="window.__c.push('espace')">En magasin</button>
    <div data-testid="account_filtered-orders_tab-instore" onclick="window.__c.push('div')">En magasin</div>
    <button type="button" data-testid="account_filtered-orders_tab-instore" style="display:none" onclick="window.__c.push('cache')">En magasin</button>
    <button type="button" data-testid="account_filtered-orders_tab-instore" onclick="window.__c.push('le-bon')">En magasin</button>
    <button type="button" data-testid="account_filtered-orders_tab-instore" disabled onclick="window.__c.push('grise')">En magasin</button>
    <button type="button" data-testid="account_web-order-item_toggle-details" aria-expanded="true" onclick="window.__c.push('deja-deplie')"></button>
    <button type="button" data-testid="account_purchase-history_view-ticket" onclick="window.__c.push('ticket')">Voir mon ticket</button>`,
  { script: 'window.__c = [];' });
  const site = await faux.ouvrirFauxSite('piege.invalid', async () => ({ html: piege }));
  try {
    await site.page.goto('https://piege.invalid/');
    const p = site.page;
    const magasin = await p.evaluate(bricomarche.CLIQUER_PAR_REPERE, { attendu: bricomarche.CLICS_PERMIS.ongletEnMagasin, rang: 0, deplier: false });
    assert.equal(magasin, 'account_filtered-orders_tab-instore');
    const deplie = await p.evaluate(bricomarche.CLIQUER_PAR_REPERE, { attendu: bricomarche.CLICS_PERMIS.deplier, rang: 0, deplier: true });
    assert.equal(deplie, null, 'un chevron déjà déplié n\'est pas recliqué');
    const grise = await p.evaluate(bricomarche.CLIQUER_PAR_REPERE, { attendu: bricomarche.CLICS_PERMIS.ongletEnMagasin, rang: 1, deplier: false });
    assert.equal(grise, null, 'un bouton désactivé ne se clique pas');
    assert.deepEqual(await p.evaluate(() => window.__c), ['le-bon']);
    assert.deepEqual(site.journal.fuites, []);
  } finally {
    await site.fermer();
  }
});

// ---------------------------------------------------------------------------
// D3 — un repère qui change, un onglet qui ne bascule pas
// ---------------------------------------------------------------------------

test('D3 — tous les data-testid renommés : la page reste lue par ses textes, la commande comptée ; rien ne se clique, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ testids: 'tous-renommes' }));
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.match(texte, /signes présents : adresse, titre, ongletEnLigne, ongletEnMagasin, filtre, deconnexion \(/,
    'l\'identifiant du select et le lien /logout sont restés : six signes, dont deux par le texte');
  assert.match(texte, /reconnus par leur texte seulement, leur repère manque : ongletEnLigne, ongletEnMagasin\./);
  assert.match(texte, /pas de chevron sous son repère « account_web-order-item_toggle-details » : détail non déplié, rien n'a été cliqué/);
  assert.match(texte, /son repère « account_filtered-orders_tab-instore » est absent de la page : rien n'a été cliqué/);
  assert.equal(resultat.aucunDocument,
    'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et un onglet « En magasin » qui '
    + 'n\'a pas pu être lu. Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe '
    + 'vous le signalera ici. Le détail de 1 commande(s) n\'a pas pu être déplié : une facture qui s\'y '
    + 'trouverait n\'a pas pu être cherchée. Si cela se répète, signalez-le.');
  assert.deepEqual(journal.clics, [], 'aucun repère exact : aucun clic');
  rienQueLePermis(journal);
});

test('D3 — seul le repère de l\'onglet « En magasin » renommé : la commande est lue et dépliée, l\'onglet est « non lu », jamais « 0 achat »', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal } = await passer(etatDuSixOctobre({ testids: 'onglet-magasin-renomme' }));
  assert.equal(erreur, null);
  assert.match(resultat.aucunDocument, /1 commande en ligne et un onglet « En magasin » qui n'a pas pu être lu/);
  assert.doesNotMatch(resultat.aucunDocument, /aucun achat|0 achat/);
  assert.deepEqual(repereDe(journal.clics), [R.deplier]);
  rienQueLePermis(journal);
});

test('D3 — l\'onglet « En magasin » cliqué mais qui ne devient pas l\'actif : « non lu », jamais « 0 achat »', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ ongletInerte: true }));
  assert.equal(erreur, null);
  assert.match(lignes.join('\n'), /onglet « En magasin » — cliqué, mais il n'est pas devenu l'onglet actif : les achats en magasin ne sont pas lus \(jamais comptés « 0 »\)/);
  assert.match(resultat.aucunDocument, /un onglet « En magasin » qui n'a pas pu être lu/);
  assert.doesNotMatch(resultat.aucunDocument, /aucun achat|0 achat|Voir mon ticket/);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin], 'un seul clic sur l\'onglet, pas d\'insistance');
  rienQueLePermis(journal);
});

test('D3 — le contenu change mais l\'onglet ne devient pas l\'actif : non lu', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, lignes } = await passer(etatDuSixOctobre({ classesFigees: true }));
  assert.match(lignes.join('\n'), /cliqué, mais il n'est pas devenu l'onglet actif/);
  assert.match(resultat.aucunDocument, /un onglet « En magasin » qui n'a pas pu être lu/);
});

test('D3 — l\'onglet devient l\'actif mais le contenu ne change pas : non lu', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, lignes } = await passer(etatDuSixOctobre({ contenuFige: true }));
  assert.match(lignes.join('\n'), /il est devenu l'onglet actif, mais le contenu affiché n'a pas changé/);
  assert.match(resultat.aucunDocument, /un onglet « En magasin » qui n'a pas pu être lu/);
});

test('D3 — un chevron qui ne déplie rien : la commande compte, son détail est dit non lu', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ voletAbsent: true }));
  assert.equal(erreur, null);
  assert.match(lignes.join('\n'), /commande 1\/1 — chevron déplié, mais aucun détail ne s'est affiché : détail non lu\./);
  assert.match(resultat.precision, /1 commande en ligne et 5 achats en magasin/);
  assert.match(resultat.precision, /Le détail de 1 commande\(s\) n'a pas pu être déplié/);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...CINQ_TICKETS], 'le chevron n\'est cliqué qu\'une fois');
  rienQueLePermis(journal);
});

// ---------------------------------------------------------------------------
// R6 — « page illisible » reste, pour les vraies ; le renvoi reste un renvoi
// ---------------------------------------------------------------------------

test('R6 — une page connectée vraiment illisible : « page illisible », sans renvoi ni « rouvrez »', faux.SANS_NAVIGATEUR, async () => {
  const { erreur, journal, preuves } = await passer(etatDuSixOctobre({ page: 'illisible' }));
  assert.ok(erreur, 'une page qu\'on ne sait pas lire ne passe pas pour une liste vide');
  assert.match(erreur.message, /n'a pas su y lire vos achats/);
  assert.match(erreur.message, /Votre connexion n'est pas en cause : inutile de la rouvrir/);
  assert.doesNotMatch(erreur.message, /Rouvrez la connexion/);
  assert.notEqual(erreur.sessionExpired, true);
  assert.equal(preuves.length, 0);
  assert.deepEqual(journal.clics, []);
  rienQueLePermis(journal);
});

test('R6 — renvoyé vers /login : un renvoi vers l\'authentification, marqué pour la règle du lot 91', faux.SANS_NAVIGATEUR, async () => {
  const { erreur, journal, lignes } = await passer(etatDuSixOctobre({ page: 'connexion' }), { socle: true });
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(lignes.join('\n'), /renvoyé vers https:\/\/www\.bricomarche\.com\/login — lecture 2/);
  rienQueLePermis(journal);
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('l\'onglet actif : font-bold ET une classe en -selected (mesuré) ; un attribut d\'accessibilité s\'il apparaît', () => {
  assert.equal(bricomarche.ongletActif({ classes: ['btn', 'font-bold', 'btn-tab-selected'] }), true);
  assert.equal(bricomarche.ongletActif({ classes: ['btn', 'font-bold'] }), false, 'gras seul : pas actif');
  assert.equal(bricomarche.ongletActif({ classes: ['btn', 'btn-tab-selected'] }), false, '-selected seul : pas actif');
  assert.equal(bricomarche.ongletActif({ classes: ['btn', 'font-bold', 'selected-x'] }), false);
  assert.equal(bricomarche.ongletActif({ classes: [], ariaSelected: 'true' }), true);
  assert.equal(bricomarche.ongletActif({ classes: [], ariaPressed: 'true' }), true);
  assert.equal(bricomarche.ongletActif({ classes: [], ariaCurrent: 'false' }), false);
  assert.equal(bricomarche.ongletActif(null), false);
});

test('ce que l\'utilisateur lit : détails non dépliés, factures en ligne et en magasin — et plus jamais « ne sait pas encore l\'ouvrir » (lot 94)', () => {
  const base = { enLigne: 1, enMagasin: 1, factures: 0, libelles: [], filtreVerifie: true };
  for (const tickets of [0, 1, 2]) {
    assert.doesNotMatch(bricomarche.messageDuPassage({ ...base, enMagasin: Math.max(1, tickets), tickets }), /ticket|ne sait pas encore l'ouvrir/,
      'les tickets se disent par leurs propres phrases');
  }
  assert.match(bricomarche.messageDuPassage({ ...base, factures: 1, facturesMagasin: 1, libelles: ['Facture'] }),
    /pour 1 commande\(s\) et 1 achat\(s\) en magasin \(« Facture »\)/);
  assert.match(bricomarche.messageDuPassage({ ...base, facturesMagasin: 2, libelles: ['Facture'] }),
    /pour 2 achat\(s\) en magasin/);
  // Le message du lot 92, à l'identique, quand rien de neuf n'est vu.
  assert.equal(bricomarche.messageDuPassage({ enLigne: 1, enMagasin: 0, factures: 0, libelles: [], filtreVerifie: true }),
    'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et aucun achat en magasin. '
    + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.');
});

test('le journal d\'une commande dit ce qui a été lu, jamais la valeur', () => {
  const ligne = bricomarche.ligneCommande(
    { numero: 'ZZ12345678', datetime: '2026-03-12T09:30:00.000Z', etat: 'Livrée le 12/03', vendeur: 'Vendeur' }, 0, 1);
  assert.equal(ligne, 'bricomarche : commande 1/1 — numéro lu (2 lettre(s), 8 chiffre(s)), date lue (attribut datetime), état « Livrée le ##/## », vendeur lu.');
  assert.doesNotMatch(ligne, /ZZ|12345678|2026|Vendeur/);
  assert.match(bricomarche.ligneCommande({ numero: null, datetime: '', phraseDate: '', etat: '', vendeur: '' }, 1, 2),
    /commande 2\/2 — numéro NON lu, date NON lue, état NON lu, vendeur NON lu\./);
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur : les mots, et les causes du lot 91
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot93-bricomarche';
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) { return globalThis.__lot93b(config, ctx); },
};
`;

test('par le vrai planificateur : le message mot pour mot, l\'onglet non lu, la page illisible en « échec », le renvoi en « connexion refusée »', faux.SANS_NAVIGATEUR, async () => {
  const user = await helpers.createUser({ username: 'lot93b', role: 'admin' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot93b-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify({
    id: ID_SONDE,
    name: 'Bricomarché',
    category: 'shopping',
    description: 'Sonde de test : le résultat du vrai connecteur Bricomarché, sur des pages reconstituées.',
    remoteLogin: { url: 'https://service-invente.invalid/login', marker: '' },
    fields: [{ key: 'session', label: 'Connexion', type: 'session', required: false }],
    permissions: [{ key: 'factures', scope: 'read-write', description: 'Sonde de test : aucune facture réelle.' }],
  }));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  registry.install(user.id, ID_SONDE);
  const seConnecter = () => registry.saveConfig(user.id, ID_SONDE, {
    session: JSON.stringify({
      cookies: [{ name: 'jeton-invente', value: 'valeur-inventee', domain: 'service-invente.invalid', path: '/',
        expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [],
    }),
  }, { origine: 'fenetre' });

  const lire = async (etat, { socle = false } = {}) => {
    const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etat));
    globalThis.__lot93b = (config, ctx) => faux.surLeFauxProfil(site, () => bricomarche.fetchInvoices(config, ctx), { socle });
    try {
      const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
      rienQueLePermis(site.journal);
      return r;
    } finally {
      await site.fermer();
    }
  };

  try {
    seConnecter();
    let r = await lire(etatDuSixOctobre());
    assert.equal(r.ok, true, 'la connexion est bonne, la page est lue : une RÉUSSITE');
    assert.equal(r.message, `5 factures récupérées ${PRECISION_DU_SIX_OCTOBRE}`);

    r = await lire(etatDuSixOctobre({ ongletInerte: true }));
    assert.equal(r.ok, true, 'un onglet non lu ne fait pas échouer ce qui a été lu');
    assert.equal(r.message,
      'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et un onglet « En magasin » qui '
      + 'n\'a pas pu être lu. Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe '
      + 'vous le signalera ici.');

    r = await lire(etatDuSixOctobre({ page: 'illisible' }));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'echec', 'une page illisible est un échec — pas un refus de connexion');
    assert.match(r.message, /^Échec — Bricomarché a bien ouvert votre espace client, mais crabe n'a pas su y lire vos achats/);

    seConnecter();
    r = await lire(etatDuSixOctobre({ page: 'connexion' }), { socle: true });
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'connexion-refusee', 'renvoyé juste après une connexion enregistrée');
  } finally {
    delete globalThis.__lot93b;
    fs.rmSync(dossier, { recursive: true, force: true });
    registry.load();
  }
});

test.after(() => {
  helpers.teardown();
});
