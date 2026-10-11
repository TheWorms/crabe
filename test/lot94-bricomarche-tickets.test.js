'use strict';

/**
 * Lot 94 — Bricomarché : les tickets de caisse.
 *
 * Depuis le lot 93, crabe lit « Mes achats » sur le vrai site (mesuré au
 * journal de production le 06/10 : 1 commande en ligne, 5 achats en
 * magasin). Chaque achat en magasin porte « Voir mon ticket ». L'utilisateur l'a cliqué
 * dans son navigateur : il TÉLÉCHARGE un PDF, le ticket de caisse (annoncé).
 * Personne n'a vu ce PDF ni la requête qui le sert.
 *
 * Ces essais tournent au VRAI Chromium sur la page reconstituée du lot 93
 * (test/lot93-faux-sites.js), dont le bouton du ticket télécharge désormais
 * un PDF inventé — par une mécanique INVENTÉE, et avec des issues inventées
 * pour éprouver l'arrêt (une fenêtre, un formulaire, une autre page, rien…).
 * Ils prouvent ce que crabe fait de CETTE forme, pas le vrai site. Chaque clic
 * est compté par la page, avec le repère de ce qui a été cliqué ; aucune
 * requête ne sort.
 *
 * Les passages « par le vrai planificateur » exécutent le VRAI connecteur
 * `bricomarche` du registre : seul son profil de navigateur est remplacé par
 * la page reconstituée (`surLeFauxProfil`) — et le vrai profil est INTERDIT
 * le reste du temps : un passage qui n'aurait pas le faux lèverait au lieu
 * d'ouvrir un navigateur (leçon du lot 93).
 *
 * ⚠ Toutes les valeurs sont inventées : numéros « ZZ… », clés de ticket
 * « ZZT… », montants d'essai.
 *
 * Lot 95 (R6), un essai modifié par décision : « D6 — une réponse qui n'est
 * pas un PDF » lisait la ligne du journal jusqu'à sa parenthèse fermante ; le
 * socle `clic-document` y ajoute désormais ce que le fichier était
 * (« [reçu : page web (HTML), 64 octets] »). Objet inchangé : rien de déposé,
 * les clics s'arrêtent, et la ligne le dit.
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
const profilMarchand = require('../server/connectors/profil-marchand');
const bricomarche = require('../server/connectors/available/bricomarche/connector');
const faux = require('./lot93-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'bricomarche', 'connector.js');
const R = bricomarche.REPERES;
const ANNEE = new Date().getFullYear();

/** Le compte du 06/10 (lot 93) : une commande en ligne, cinq achats en magasin. */
function etatDuSixOctobre(extra = {}) {
  return {
    enLigne: [{
      numero: 'ZZ00000001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z',
      etat: 'Livrée', vendeur: 'Bricomarché',
    }],
    enMagasin: [
      { mois: 'Février 2026', dateAffichee: '03/02/2026', montant: '12,34 €' },
      { mois: 'Février 2026', dateAffichee: '01/02/2026', montant: '5,00 €' },
      { mois: 'Janvier 2026', dateAffichee: '20/01/2026', montant: '1 234,56 €' },
      { mois: 'Janvier 2026', dateAffichee: '09/01/2026', montant: '0,99 €' },
      { mois: 'Décembre 2025', dateAffichee: '15/12/2025', montant: '7,10 €' },
    ],
    ...extra,
  };
}

const RESUME = 'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 5 achats en magasin. '
  + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.';
const ANCRES = [
  'bricomarche-ticket-2026-02-03-12-34EUR',
  'bricomarche-ticket-2026-02-01-5-00EUR',
  'bricomarche-ticket-2026-01-20-1234-56EUR',
  'bricomarche-ticket-2026-01-09-0-99EUR',
  'bricomarche-ticket-2025-12-15-7-10EUR',
];
const NOMS = [
  'bricomarche_2026-02_ticket-2026-02-03-12-34EUR.pdf',
  'bricomarche_2026-02_ticket-2026-02-01-5-00EUR.pdf',
  'bricomarche_2026-01_ticket-2026-01-20-1234-56EUR.pdf',
  'bricomarche_2026-01_ticket-2026-01-09-0-99EUR.pdf',
  'bricomarche_2025-12_ticket-2025-12-15-7-10EUR.pdf',
];

/** Un passage DIRECT du connecteur sur la page reconstituée. */
async function passer(etat, { config = {}, ctxExtra = {} } = {}) {
  const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etat));
  const enr = faux.contexteEnregistreur(ctxExtra);
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await faux.surLeFauxProfil(site, () => bricomarche.fetchInvoices(config, enr.ctx));
    } catch (err) {
      erreur = err;
    }
    return { resultat, erreur, journal: site.journal, lignes: enr.lignes, preuves: enr.preuves, servis: [...etat.ticketsServis] };
  } finally {
    await site.fermer();
  }
}

const repereDe = (clics) => clics.map((c) => c.testid);
const tickets = (n) => Array(n).fill(R.ticket);

/** Ce que contient le PDF inventé d'un ticket : sa clé. */
const cleDuPdf = (buffer) => /ticket invente (\S+)/.exec(buffer.toString('latin1'))?.[1] || null;

/**
 * Ce qui tient à CHAQUE passage : les quatre repères permis et rien d'autre ;
 * les tickets en dernier ; rien de saisi, d'écrit, de sorti ; rien du volet
 * déplié, rien dans une fenêtre ouverte par un ticket.
 */
function rienQueLePermis(journal) {
  const permis = new Set(Object.values(bricomarche.CLICS_PERMIS));
  for (const c of journal.clics) assert.ok(permis.has(c.testid), `un clic hors de la liste fermée : ${JSON.stringify(c)}`);
  const premier = journal.clics.findIndex((c) => c.testid === R.ticket);
  if (premier >= 0) {
    assert.ok(journal.clics.slice(premier).every((c) => c.testid === R.ticket), 'les tickets se demandent en dernier');
  }
  assert.ok(!journal.clics.some((c) => /facture|retourner|télécharger le pdf|fermer|envoyer/i.test(c.libelle)),
    `rien du volet ni d'une fenêtre n'est cliqué : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, [], 'rien n\'est saisi');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
}

/** Le journal ne dit jamais une date ni un montant d'achat. */
function journalMuet(lignes) {
  const texte = lignes.join('\n');
  assert.doesNotMatch(texte, /\d{2}\/\d{2}\/\d{4}|\d+,\d{2}\s*€|ZZT\d|EUR\b/, 'ni date, ni montant, ni clé, ni ancre au journal');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D4 — cinq achats : cinq PDF, cinq ancres, cinq noms ; rien de repris
// ---------------------------------------------------------------------------

test('D4 — la page du 06/10, cinq achats : cinq tickets pris, chacun sous l\'ancre de SON achat, cinq noms qui disent « ticket »', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  const { resultat, erreur, journal, lignes, servis } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 5);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES);
  assert.deepEqual(resultat.invoices.map((f) => f.filename), NOMS);
  assert.equal(new Set(resultat.invoices.map((f) => f.filename)).size, 5, 'deux tickets n\'ont jamais le même nom');
  assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-02-03', '2026-02-01', '2026-01-20', '2026-01-09', '2025-12-15']);
  // Chaque PDF est celui de SON achat : la clé inventée qu'il porte suit l'ordre de la page.
  assert.deepEqual(resultat.invoices.map((f) => cleDuPdf(f.buffer)), ['ZZT0001', 'ZZT0002', 'ZZT0003', 'ZZT0004', 'ZZT0005']);
  assert.ok(resultat.invoices.every((f) => f.buffer.subarray(0, 5).toString('latin1') === '%PDF-'));
  assert.equal(resultat.invoices.every((f) => f.accountId === undefined), true, 'aucun compte : le dossier « defaut »');
  assert.deepEqual(servis, ['ZZT0001', 'ZZT0002', 'ZZT0003', 'ZZT0004', 'ZZT0005'], 'un ticket demandé une fois, un à la fois');
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...tickets(5)]);
  assert.equal(resultat.precision, `— ce sont les tickets de caisse de 5 achats en magasin. ${RESUME}`);
  assert.equal(resultat.aucunDocument, undefined);
  assert.equal(resultat.manquees, undefined);
  assert.match(texte, /achat en magasin 1\/5 — ticket de caisse récupéré \(voie mesurée : téléchargement direct, \d+ octets ; nom proposé par le site : 18 caractère\(s\), dont 4 chiffre\(s\), plus longue suite de chiffres : 4, extension \.pdf\)\./);
  assert.match(texte, /tickets — 5 achat\(s\) avec « Voir mon ticket » : 5 pris, 0 déjà dans l'archive, 0 hors période, 0 sans repère, 0 sans ancre sûre, 0 en attente \(temps\), 0 non demandé\(s\) après un arrêt\./);
  assert.doesNotMatch(texte, /ne sait pas encore l'ouvrir|non cliqués/);
  journalMuet(lignes);
  rienQueLePermis(journal);
});

test('D4 — second passage : aucun clic sur un ticket, rien de repris, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  const { resultat, erreur, journal, lignes, servis } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(servis, [], 'aucun ticket redemandé');
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin], 'aucun clic sur « Voir mon ticket »');
  assert.equal(resultat.aucunDocument, `${RESUME} Les tickets de caisse de vos 5 achats en magasin sont déjà dans vos documents.`);
  assert.match(lignes.join('\n'), /tickets — 5 achat\(s\) avec « Voir mon ticket » : 0 pris, 5 déjà dans l'archive, /);
  rienQueLePermis(journal);
});

test('D4 — deux achats de même date et de même montant : deux ancres, deux noms, chaque PDF sous la sienne ; un troisième, plus tard, ne décale rien', faux.SANS_NAVIGATEUR, async () => {
  // La page montre les plus récents d'abord : B (plus récent) au-dessus de A.
  const A = { mois: 'Février 2026', dateAffichee: '03/02/2026', montant: '9,90 €', cle: 'ZZTA' };
  const B = { mois: 'Février 2026', dateAffichee: '03/02/2026', montant: '9,90 €', cle: 'ZZTB' };
  const autre = { mois: 'Janvier 2026', dateAffichee: '20/01/2026', montant: '9,90 €', cle: 'ZZTX' };
  const premier = await passer(etatDuSixOctobre({ enMagasin: [B, A, autre] }));
  assert.equal(premier.erreur, null, premier.erreur?.message);
  const parCle = Object.fromEntries(premier.resultat.invoices.map((f) => [cleDuPdf(f.buffer), f]));
  assert.equal(parCle.ZZTA.remoteId, 'bricomarche-ticket-2026-02-03-9-90EUR', 'le plus ancien des deux : rang 1, sans suffixe');
  assert.equal(parCle.ZZTB.remoteId, 'bricomarche-ticket-2026-02-03-9-90EUR-2', 'le plus récent : rang 2');
  assert.equal(parCle.ZZTA.filename, 'bricomarche_2026-02_ticket-2026-02-03-9-90EUR.pdf');
  assert.equal(parCle.ZZTB.filename, 'bricomarche_2026-02_ticket-2026-02-03-9-90EUR-2.pdf');
  assert.equal(parCle.ZZTX.remoteId, 'bricomarche-ticket-2026-01-20-9-90EUR', 'même montant, autre date : pas de rang');

  // Un troisième achat identique, plus récent, apparaît en tête : seul lui est pris, au rang 3.
  const C = { mois: 'Février 2026', dateAffichee: '03/02/2026', montant: '9,90 €', cle: 'ZZTC' };
  const second = await passer(etatDuSixOctobre({ enMagasin: [C, B, A, autre] }),
    { ctxExtra: { knownRemoteIds: premier.resultat.invoices.map((f) => f.remoteId) } });
  assert.equal(second.erreur, null);
  assert.deepEqual(second.resultat.invoices.map((f) => [cleDuPdf(f.buffer), f.remoteId]),
    [['ZZTC', 'bricomarche-ticket-2026-02-03-9-90EUR-3']]);
  assert.deepEqual(second.servis, ['ZZTC'], 'A et B ne sont pas redemandés');
  assert.equal(second.resultat.precision,
    '— c\'est le ticket de caisse d\'un achat en magasin ; ceux des 3 autres étaient déjà dans vos documents. '
    + 'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 4 achats en magasin. '
    + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.');
  rienQueLePermis(second.journal);
});

test('D4 — l\'ancre et le nom, fonctions pures : montants, avoirs, rangs du plus ancien au plus récent', () => {
  assert.equal(bricomarche.montantEnCentimes('12,34 €'), 1234);
  assert.equal(bricomarche.montantEnCentimes('Prix du produit: 1 234,56 €'), 123456);
  assert.equal(bricomarche.montantEnCentimes('-5,00 €'), -500);
  assert.equal(bricomarche.montantEnCentimes('12 €'), 1200);
  assert.equal(bricomarche.montantEnCentimes('0,5 €'), 50);
  assert.equal(bricomarche.montantEnCentimes('12,34 € TTC'), 1234);
  for (const illisible of ['', 'Gratuit', '12,345 €', 'environ 12 €', '€', '12,34 € (remise)']) {
    assert.equal(bricomarche.montantEnCentimes(illisible), null, illisible);
  }
  assert.equal(bricomarche.remoteIdTicket('2026-02-03', -500), 'bricomarche-ticket-2026-02-03-moins-5-00EUR');
  assert.equal(bricomarche.remoteIdTicket('2026-02-03', 0, 2), 'bricomarche-ticket-2026-02-03-0-00EUR-2');
  assert.equal(bricomarche.nomDuTicket('2026-02-03', bricomarche.remoteIdTicket('2026-02-03', 123456, 12)),
    'bricomarche_2026-02_ticket-2026-02-03-1234-56EUR-12.pdf', 'sous 40 caractères : jamais tronqué en empreinte');
  assert.notEqual(bricomarche.remoteIdTicket('2026-02-03', 1234), `${bricomarche.remoteIdCommande('ZZ1')}`,
    'un ticket ne prend jamais l\'ancre d\'une commande en ligne');

  // Plus récents d'abord (la page) : le DERNIER des identiques est le rang 1.
  const recentsDAbord = bricomarche.ancresDesTickets([
    { date: '03/02/2026', montant: '1,00 €' }, { date: '03/02/2026', montant: '1,00 €' }, { date: '01/01/2026', montant: '1,00 €' },
  ]);
  assert.deepEqual(recentsDAbord.map((a) => a.rang), [2, 1, 1]);
  // Plus anciens d'abord : lu tel quel.
  const anciensDAbord = bricomarche.ancresDesTickets([
    { date: '01/01/2026', montant: '1,00 €' }, { date: '03/02/2026', montant: '1,00 €' }, { date: '03/02/2026', montant: '1,00 €' },
  ]);
  assert.deepEqual(anciensDAbord.map((a) => a.rang), [1, 1, 2]);
  // Date ou montant illisible : pas d'ancre.
  const illisibles = bricomarche.ancresDesTickets([{ date: '', montant: '1,00 €' }, { date: '03/02/2026', montant: 'Gratuit' }]);
  assert.deepEqual(illisibles.map((a) => a.remoteId), [null, null]);
});

// ---------------------------------------------------------------------------
// D5 — les clics : quatre repères, rien d'autre
// ---------------------------------------------------------------------------

test('D5 — par construction : un seul .click( dans le fichier, la clé « ticket » au repère exact, aucun autre geste', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.equal((code.match(/\.click\s*\(/g) || []).length, 1, 'un seul .click( dans le connecteur');
  const corps = bricomarche.CLIQUER_PAR_REPERE.toString();
  assert.match(corps, /cible\.click\(\)/, 'le seul clic est celui de CLIQUER_PAR_REPERE');
  const garde = corps.indexOf("cible.getAttribute('data-testid') !== attendu");
  const carte = corps.search(/typeof carte === 'string' && norm\(cible\.closest\('li'\)/);
  const clic = corps.indexOf('cible.click()');
  assert.ok(garde >= 0 && carte >= 0 && clic >= 0 && garde < clic && carte < clic,
    'le repère ET la carte sont recontrôlés AVANT le clic');
  assert.match(corps, /el\.getAttribute\('data-testid'\) === attendu && visible\(el\)/, 'égalité stricte, boutons visibles');
  assert.match(corps, /if \(!cible \|\| cible\.disabled\) return null;/, 'un bouton désactivé ne part pas — la garde du lot 93, inchangée');
  assert.match(corps, /typeof carte === 'string' && cible\.getAttribute\('aria-disabled'\) === 'true'/,
    'aria-disabled : refusé pour le ticket seul');
  const ariaTicket = corps.indexOf("typeof carte === 'string' && cible.getAttribute('aria-disabled') === 'true'");
  assert.ok(ariaTicket >= 0 && ariaTicket < clic, 'avant le clic');
  assert.deepEqual(Object.keys(bricomarche.CLICS_PERMIS).sort(), ['deplier', 'ongletEnLigne', 'ongletEnMagasin', 'ticket']);
  assert.equal(bricomarche.CLICS_PERMIS.ticket, 'account_purchase-history_view-ticket');
  assert.ok(Object.isFrozen(bricomarche.CLICS_PERMIS));
  for (const geste of [/\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.uncheck\s*\(/, /\.selectOption\s*\(/,
    /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/, /\.hover\s*\(/,
    /\.dblclick\s*\(/, /keyboard\./, /mouse\./, /touchscreen\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.accept\s*\(/, /\.focus\s*\(/,
    /\.\$\$?\s*\(/, /waitForEvent\s*\(/]) {
    assert.doesNotMatch(code, geste, `aucun autre geste sur la page (${geste})`);
  }
  // Le document d'un clic : par le socle, une seule fois, pour le seul ticket.
  assert.equal((code.match(/documentDuClic\s*\(/g) || []).length, 1);
  assert.match(code, /documentDuClic\(page, context, \(\) => cliquer\(page, 'ticket', rang, carte\)/);
  // Une boîte native se REFUSE, une seule fois dans le fichier.
  assert.equal((code.match(/\.dismiss\s*\(/g) || []).length, 1);
  assert.match(bricomarche.cliquer.toString(), /cle === 'ticket' && typeof carte !== 'string'/, 'jamais un ticket sans sa carte');
});

test('D5 — la page compte les clics : les quatre repères permis, et rien d\'autre ; le volet et ses boutons jamais touchés', faux.SANS_NAVIGATEUR, async () => {
  const vus = new Set();
  for (const onglet of ['web', 'magasin']) {
    const { erreur, journal, resultat } = await passer(etatDuSixOctobre({ volet: 'bouton', onglet }));
    assert.equal(erreur, null);
    assert.match(resultat.precision, /Une facture semble proposée pour 1 commande\(s\) \(« Télécharger ma facture »\)/,
      'le relevé de la facture à venir ne change pas');
    assert.equal(repereDe(journal.clics).filter((t) => t === R.ticket).length, 5);
    rienQueLePermis(journal);
    for (const c of journal.clics) vus.add(c.testid);
  }
  assert.deepEqual([...vus].sort(), Object.values(bricomarche.CLICS_PERMIS).sort(),
    'arrivé sur l\'un ou l\'autre onglet : les quatre repères, et eux seuls');
});

test('D5 — piège au vrai Chromium : repère approchant, préfixé, div, caché, désactivé, carte qui ne correspond pas — seul le bon ticket part', faux.SANS_NAVIGATEUR, async () => {
  const carte = (texte) => `<li><p>01/02/2026</p><p>${texte}</p>`;
  const piege = faux.gabarit('Piège', `<ul>
    ${carte('suffixe')}<button type="button" data-testid="account_purchase-history_view-ticket-v2" onclick="window.__c.push('suffixe')">Voir mon ticket</button></li>
    ${carte('espace')}<button type="button" data-testid=" account_purchase-history_view-ticket" onclick="window.__c.push('espace')">Voir mon ticket</button></li>
    ${carte('div')}<div data-testid="account_purchase-history_view-ticket" onclick="window.__c.push('div')">Voir mon ticket</div></li>
    ${carte('cache')}<button type="button" data-testid="account_purchase-history_view-ticket" style="display:none" onclick="window.__c.push('cache')">Voir mon ticket</button></li>
    ${carte('bon')}<button type="button" data-testid="account_purchase-history_view-ticket" onclick="window.__c.push('le-bon')">Voir mon ticket</button></li>
    ${carte('grise')}<button type="button" data-testid="account_purchase-history_view-ticket" disabled onclick="window.__c.push('grise')">Voir mon ticket</button></li>
    ${carte('aria')}<button type="button" data-testid="account_purchase-history_view-ticket" aria-disabled="true" onclick="window.__c.push('aria')">Voir mon ticket</button></li>
    ${carte('autre')}<button type="button" data-testid="account_purchase-history_view-ticket" onclick="window.__c.push('autre-carte')">Voir mon ticket</button></li>
  </ul>`, { script: 'window.__c = [];' });
  const site = await faux.ouvrirFauxSite('piege.invalid', async () => ({ html: piege }));
  try {
    await site.page.goto('https://piege.invalid/');
    const p = site.page;
    const viser = (rang, texte) => p.evaluate(bricomarche.CLIQUER_PAR_REPERE,
      { attendu: bricomarche.CLICS_PERMIS.ticket, rang, deplier: false, carte: `01/02/2026 ${texte} Voir mon ticket` });
    assert.equal(await viser(0, 'bon'), 'account_purchase-history_view-ticket', 'le bon bouton, sur sa carte');
    assert.equal(await viser(1, 'grise'), null, 'désactivé : rien ne part');
    assert.equal(await viser(2, 'aria'), null, 'aria-disabled : rien ne part');
    assert.equal(await viser(3, 'une-autre-carte'), null, 'la carte ne correspond pas : rien ne part');
    assert.equal(await viser(9, 'bon'), null, 'au-delà des candidats : rien ne part');
    assert.deepEqual(await p.evaluate(() => window.__c), ['le-bon']);
    assert.deepEqual(site.journal.fuites, []);
  } finally {
    await site.fermer();
  }
});

test('R11 — les trois autres clics gardent exactement leurs gardes du lot 93 : un onglet `aria-disabled` part comme avant, seul le ticket le refuse', faux.SANS_NAVIGATEUR, async () => {
  const piege = faux.gabarit('Piège', `
    <button type="button" data-testid="account_filtered-orders_tab-instore" aria-disabled="true" onclick="window.__c.push('onglet')">En magasin</button>
    <button type="button" data-testid="account_web-order-item_toggle-details" aria-expanded="false" aria-disabled="true" onclick="window.__c.push('chevron')"></button>
    <ul><li><p>01/02/2026</p><button type="button" data-testid="account_purchase-history_view-ticket" aria-disabled="true" onclick="window.__c.push('ticket')">Voir mon ticket</button></li></ul>`,
  { script: 'window.__c = [];' });
  const site = await faux.ouvrirFauxSite('piege.invalid', async () => ({ html: piege }));
  try {
    await site.page.goto('https://piege.invalid/');
    const p = site.page;
    assert.equal(await p.evaluate(bricomarche.CLIQUER_PAR_REPERE, { attendu: bricomarche.CLICS_PERMIS.ongletEnMagasin, rang: 0, deplier: false }),
      'account_filtered-orders_tab-instore');
    assert.equal(await p.evaluate(bricomarche.CLIQUER_PAR_REPERE, { attendu: bricomarche.CLICS_PERMIS.deplier, rang: 0, deplier: true }),
      'account_web-order-item_toggle-details');
    assert.equal(await p.evaluate(bricomarche.CLIQUER_PAR_REPERE,
      { attendu: bricomarche.CLICS_PERMIS.ticket, rang: 0, deplier: false, carte: '01/02/2026 Voir mon ticket' }), null);
    assert.deepEqual(await p.evaluate(() => window.__c), ['onglet', 'chevron']);
  } finally {
    await site.fermer();
  }
});

test('D5 — « Voir mon ticket » sans son repère exact (trouvé par son texte) : jamais cliqué, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ testids: 'ticket-renomme' }));
  assert.equal(erreur, null);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin], 'aucun ticket cliqué');
  assert.equal(resultat.aucunDocument, `${RESUME} Les boutons « Voir mon ticket » de 5 achats en magasin n'ont plus leur repère habituel : `
    + 'crabe ne les a pas cliqués. Si cela se répète, signalez-le.');
  assert.match(lignes.join('\n'), /« Voir mon ticket » trouvé par son texte, sans son repère « account_purchase-history_view-ticket » : non cliqué\./);
  rienQueLePermis(journal);
});

// ---------------------------------------------------------------------------
// D6 — tout le reste arrête ; le non-PDF ; le temps
// ---------------------------------------------------------------------------

test('D6 — un clic qui ouvre une fenêtre : ce clic-là et plus aucun, rien de rempli ni de refermé, les tickets déjà pris gardés', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  etat.enMagasin[2].ticket = 'fenetre';
  const { resultat, erreur, journal, lignes, servis } = await passer(etat);
  assert.equal(erreur, null, 'rien ne se perd : pas d\'exception une fois des tickets pris');
  assert.deepEqual(resultat.invoices.map((f) => cleDuPdf(f.buffer)), ['ZZT0001', 'ZZT0002'], 'les deux premiers sont gardés');
  assert.deepEqual(servis, ['ZZT0001', 'ZZT0002']);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...tickets(3)], 'un clic sur le troisième, puis plus aucun');
  assert.equal(resultat.manquees, 3, 'le ticket qui a bloqué et les deux qui n\'ont plus été demandés');
  assert.equal(resultat.renoncement,
    'Après un clic sur « Voir mon ticket », Bricomarché a ouvert une fenêtre au lieu de remettre le ticket : crabe n\'y a '
    + 'rien rempli, n\'a plus rien cliqué et s\'est arrêté là. Signalez-le, avec ce que montre cette fenêtre : c\'est ce qui '
    + 'permettra d\'écrire la suite. Les 2 autres tickets n\'ont pas été demandés : ils le seront au prochain passage.');
  assert.equal(resultat.precision, `Les 2 documents récupérés sont les tickets de caisse de 2 achats en magasin. ${RESUME}`,
    'le message du planificateur finit déjà sa phrase : pas de tiret');
  assert.match(lignes.join('\n'), /achat en magasin 3\/5 — « Voir mon ticket » demandé, pas de PDF \(une fenêtre ou un formulaire s'est ouvert à la place du ticket, sans être touché\)\. Plus aucun ticket ne sera demandé pendant ce passage ; rien n'a été rempli\./);
  rienQueLePermis(journal);
});

for (const [variante, nature] of [['formulaire', 'fenetre'], ['native', 'fenetre'], ['page', 'page']]) {
  test(`D6 — un clic qui donne ${variante === 'native' ? 'une boîte du navigateur' : variante === 'page' ? 'une autre page' : 'un formulaire'} : arrêt au premier clic, rien de rempli`, faux.SANS_NAVIGATEUR, async () => {
    const { resultat, erreur, journal, servis } = await passer(etatDuSixOctobre({ ticket: variante }));
    assert.equal(erreur, null);
    assert.deepEqual(resultat.invoices, []);
    assert.deepEqual(servis, []);
    assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, R.ticket], 'un seul clic de ticket');
    assert.equal(resultat.manquees, 5);
    assert.equal(resultat.precision, RESUME, 'le résumé de la page reste dit');
    assert.match(resultat.renoncement, nature === 'page'
      ? /^Après un clic sur « Voir mon ticket », Bricomarché a affiché une autre page au lieu de remettre le ticket/
      : /^Après un clic sur « Voir mon ticket », Bricomarché a ouvert une fenêtre au lieu de remettre le ticket/);
    assert.match(resultat.renoncement, /Les 4 autres tickets n'ont pas été demandés : ils le seront au prochain passage\.$/);
    rienQueLePermis(journal);
  });
}

test('D6 — un clic qui ne rend rien : un clic, l\'attente bornée du socle, puis plus aucun', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuSixOctobre({ ticket: 'rien' }));
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, R.ticket]);
  assert.match(resultat.renoncement, /^Après un clic sur « Voir mon ticket », Bricomarché n'a pas remis de PDF : crabe n'a plus rien cliqué et s'est arrêté là\. Si cela se répète, signalez-le\. Les 4 autres tickets/);
  assert.match(lignes.join('\n'), /pas de PDF \(le clic n'a déclenché ni téléchargement, ni nouvel onglet, ni réponse PDF en 30 s\)/);
  rienQueLePermis(journal);
});

test('D6 — une réponse qui n\'est pas un PDF : rien de déposé, les clics s\'arrêtent', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  etat.enMagasin[1].ticket = 'non-pdf';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices.map((f) => cleDuPdf(f.buffer)), ['ZZT0001'], 'la page d\'erreur n\'est pas déposée');
  assert.equal(resultat.manquees, 4);
  // Lot 95 (R6) : la ligne dit aussi ce que le fichier était.
  assert.match(lignes.join('\n'), /achat en magasin 2\/5 — « Voir mon ticket » demandé, pas de PDF \(le fichier téléchargé n'est pas un PDF \(\d+ octets\) \[reçu : page web \(HTML\), \d+ octets\]\)/);
  assert.match(resultat.renoncement, /n'a pas remis de PDF/);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, ...tickets(2)]);
  rienQueLePermis(journal);
});

test('D6 — les autres voies d\'un PDF (la page part vers le document, un nouvel onglet) : prises, et la voie est dite', faux.SANS_NAVIGATEUR, async () => {
  for (const variante of ['navigation', 'onglet']) {
    const { resultat, erreur, lignes, journal } = await passer(etatDuSixOctobre({ ticket: variante }));
    assert.equal(erreur, null, `${variante} : ${erreur?.message}`);
    assert.deepEqual(resultat.invoices.map((f) => cleDuPdf(f.buffer)), ['ZZT0001', 'ZZT0002', 'ZZT0003', 'ZZT0004', 'ZZT0005'], variante);
    assert.match(lignes.join('\n'), /ticket de caisse récupéré \(voie mesurée : /, variante);
    rienQueLePermis(journal);
  }
});

test('D6 — l\'onglet « En magasin » qui cesse d\'être affiché : le ticket suivant n\'est pas demandé', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  etat.enMagasin[0].ticket = 'bascule';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices.map((f) => cleDuPdf(f.buffer)), ['ZZT0001']);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin, R.ticket], 'aucun ticket demandé hors de son onglet');
  assert.match(lignes.join('\n'), /achat en magasin 2\/5 — l'onglet « En magasin » n'est plus l'onglet affiché : aucun ticket de plus n'est demandé\./);
  assert.match(resultat.renoncement, /^Au moment de demander un ticket, l'onglet « En magasin » n'était plus celui qui est affiché/);
  assert.equal(resultat.manquees, 4);
});

test('D6 — le temps permis écoulé au milieu : les tickets pris sont rendus, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
  const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
  const horloge = bricomarche.horloge.maintenant;
  process.env.CRABE_LIMITE_EXECUTION_MS = String(30 * 60 * 1000);
  try {
    // Budget : 20 minutes (2/3 de 30). L'horloge avance de 8 minutes par ticket servi.
    let t = 0;
    bricomarche.horloge.maintenant = () => t;
    const premier = await passer(etatDuSixOctobre({ surTicket: () => { t += 8 * 60 * 1000; } }));
    assert.equal(premier.erreur, null, premier.erreur?.message);
    assert.equal(premier.resultat.invoices.length, 3, 'trois tickets dans le budget, puis l\'arrêt');
    assert.equal(premier.resultat.manquees, undefined, 'le temps n\'est pas un échec');
    assert.equal(premier.resultat.precision,
      '— ce sont les tickets de caisse de 3 achats en magasin. La récupération a pris tout le temps permis : '
      + `2 tickets attendent encore ; ils viendront au prochain passage. Rien de ce qui a été pris n'est perdu. ${RESUME}`);

    t = 0;
    const second = await passer(etatDuSixOctobre({ surTicket: () => { t += 8 * 60 * 1000; } }),
      { ctxExtra: { knownRemoteIds: premier.resultat.invoices.map((f) => f.remoteId) } });
    assert.equal(second.erreur, null);
    assert.deepEqual(second.servis, ['ZZT0004', 'ZZT0005'], 'le reste, au passage suivant');
    assert.equal(second.resultat.precision,
      `— ce sont les tickets de caisse de 2 achats en magasin ; ceux des 3 autres étaient déjà dans vos documents. ${RESUME}`);
  } finally {
    bricomarche.horloge.maintenant = horloge;
    if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
  }
});

test('D6 — le budget de temps : les 2/3 de la limite du planificateur, réglable comme elle', () => {
  const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
  try {
    delete process.env.CRABE_LIMITE_EXECUTION_MS;
    assert.equal(bricomarche.LIMITE_EXECUTION_DEFAUT_MS, scheduler.LIMITE_EXECUTION_MS);
    assert.equal(bricomarche.budgetMs(), 30 * 60 * 1000);
    process.env.CRABE_LIMITE_EXECUTION_MS = '3000';
    assert.equal(bricomarche.budgetMs(), 2000);
  } finally {
    if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
  }
});

test('D6 — date ou montant illisible : pas d\'ancre sûre, le ticket n\'est pas demandé, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = etatDuSixOctobre();
  etat.enMagasin[1].montant = 'Offert';
  const { resultat, journal, lignes } = await passer(etat);
  assert.equal(resultat.invoices.length, 4);
  assert.ok(!resultat.invoices.some((f) => cleDuPdf(f.buffer) === 'ZZT0002'));
  assert.equal(repereDe(journal.clics).filter((x) => x === R.ticket).length, 4);
  assert.match(lignes.join('\n'), /achat en magasin 2\/5 — sa date ou son montant ne se lit pas : son ticket n'est pas demandé \(aucune ancre sûre\)\./);
  assert.match(resultat.precision, /Le ticket d'un achat en magasin n'a pas été demandé : sa date ou son montant n'a pas pu être lu/);
});

test('D6 — l\'historique choisi : « l\'année en cours » laisse les tickets plus anciens, et le dit ; « depuis » prend tout ce qui manque', faux.SANS_NAVIGATEUR, async () => {
  const etat = () => etatDuSixOctobre({ enMagasin: [
    { mois: 'Cette année', dateAffichee: `02/01/${ANNEE}`, montant: '1,00 €' },
    { mois: 'Il y a trois ans', dateAffichee: `02/01/${ANNEE - 3}`, montant: '2,00 €' },
  ] });
  const courante = await passer(etat(), { config: { historique: 'courante' } });
  assert.equal(courante.resultat.invoices.length, 1);
  assert.match(courante.resultat.precision, /Le ticket d'un achat en magasin, antérieur à la période choisie dans « Historique à récupérer », n'a pas été demandé\./);
  // « depuis », alors qu'un document existe déjà : les tickets anciens manquants viennent quand même.
  const depuis = await passer(etat(), { config: { historique: 'depuis' }, ctxExtra: { knownRemoteIds: ['bricomarche-autre'] } });
  assert.equal(depuis.resultat.invoices.length, 2);
  assert.match(depuis.lignes.join('\n'), /tickets — historique « depuis » — tous les tickets pas encore dans l'archive\./);
});

// ---------------------------------------------------------------------------
// D7 — par le VRAI planificateur et le VRAI connecteur : les mots de R10
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let surLeProfilReel;
  let scrapingAvant;
  test.before(() => {
    // Le vrai profil de navigateur est INTERDIT : seul le faux, posé passage
    // par passage par `surLeFauxProfil`, peut servir une page.
    surLeProfilReel = profilMarchand.surLeProfil;
    profilMarchand.surLeProfil = async () => {
      throw new Error('essai : vrai profil de navigateur interdit — la page reconstituée n\'a pas été branchée');
    };
    const configuration = require('../server/config').config;
    scrapingAvant = configuration.scrapingDisabled;
    configuration.scrapingDisabled = false;
    destinations.restoreLocal();
  });
  test.after(() => {
    profilMarchand.surLeProfil = surLeProfilReel;
    require('../server/config').config.scrapingDisabled = scrapingAvant;
  });

  async function compteAvecBricomarche(nom) {
    const user = await helpers.createUser({ username: nom, role: 'admin' });
    registry.install(user.id, 'bricomarche');
    registry.saveConfig(user.id, 'bricomarche', { historique: 'depuis' }, { origine: 'fenetre' });
    return user;
  }

  /** Un passage par `runForUser`, le vrai connecteur sur la page reconstituée. */
  async function lire(user, etat) {
    const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etat));
    try {
      const r = await faux.surLeFauxProfil(site, () => scheduler.runForUser(user.id, 'bricomarche', 'manual'));
      assert.ok(site.journal.visites.length > 0, `la page reconstituée a bien servi (${r.message})`);
      rienQueLePermis(site.journal);
      return { r, journal: site.journal, servis: [...etat.ticketsServis] };
    } finally {
      await site.fermer();
    }
  }

  const lignesDe = (user) => db.get().prepare(
    'SELECT filename, remote_id, account_id, issued_on FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id'
  ).all(user.id, 'bricomarche');

  test('R10 — premier passage : « 5 factures récupérées — ce sont les tickets de caisse… », cinq lignes, rangées sous « defaut/<année> » ; le second ne reprend rien', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecBricomarche('lot94b1');
    let { r } = await lire(user, etatDuSixOctobre());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, `5 factures récupérées — ce sont les tickets de caisse de 5 achats en magasin. ${RESUME}`);
    const lignes = lignesDe(user);
    assert.deepEqual(lignes.map((l) => l.remote_id), ANCRES);
    assert.deepEqual(lignes.map((l) => l.filename), NOMS, 'la convention par défaut garde le service : les noms du connecteur');
    assert.ok(lignes.every((l) => l.account_id === 'defaut'));
    const racine = process.env.CRABE_LOCAL_PATH;
    for (const l of lignes) {
      const fichier = path.join(racine, 'lot94b1', 'Bricomarché', 'defaut', l.issued_on.slice(0, 4), l.filename);
      assert.ok(fs.existsSync(fichier), `déposé : ${path.relative(racine, fichier)}`);
      assert.equal(fs.readFileSync(fichier).subarray(0, 5).toString('latin1'), '%PDF-');
    }

    let servis;
    ({ r, servis } = await lire(user, etatDuSixOctobre()));
    assert.equal(r.ok, true);
    assert.equal(r.message, `${RESUME} Les tickets de caisse de vos 5 achats en magasin sont déjà dans vos documents.`);
    assert.deepEqual(servis, [], 'aucun ticket redemandé');
    assert.equal(lignesDe(user).length, 5);

    // Un achat de plus, le plus récent, en tête de la page.
    const avecUnDePlus = etatDuSixOctobre();
    avecUnDePlus.enMagasin.unshift({ mois: 'Mars 2026', dateAffichee: '02/03/2026', montant: '3,30 €', cle: 'ZZT0006' });
    ({ r, servis } = await lire(user, avecUnDePlus));
    assert.equal(r.message,
      '1 facture récupérée — c\'est le ticket de caisse d\'un achat en magasin ; ceux des 5 autres étaient déjà dans vos documents. '
      + 'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 6 achats en magasin. '
      + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.');
    assert.deepEqual(servis, ['ZZT0006']);
    const journal = db.get().prepare("SELECT message FROM app_logs WHERE source LIKE 'connector:bricomarche%' ORDER BY id")
      .all().map((l) => l.message);
    journalMuet(journal);
  });

  test('R10 — bloqué au premier ticket : « Aucun document n\'a pu être récupéré… », ce qui a bloqué, ce qui attend, le résumé de la page', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecBricomarche('lot94b2');
    const { r, servis } = await lire(user, etatDuSixOctobre({ ticket: 'fenetre' }));
    assert.equal(r.ok, false, 'rien n\'est entré : un échec, que la fiche montre');
    assert.equal(r.cause, 'echec');
    assert.equal(r.message,
      'Aucun document n\'a pu être récupéré — 5 vous étaient proposés, aucun n\'a pu être téléchargé. Le détail de ce qui '
      + 'a bloqué est dans le journal de cette exécution. Après un clic sur « Voir mon ticket », Bricomarché a ouvert une '
      + 'fenêtre au lieu de remettre le ticket : crabe n\'y a rien rempli, n\'a plus rien cliqué et s\'est arrêté là. '
      + 'Signalez-le, avec ce que montre cette fenêtre : c\'est ce qui permettra d\'écrire la suite. Les 4 autres tickets '
      + `n'ont pas été demandés : ils le seront au prochain passage. ${RESUME}`);
    assert.deepEqual(servis, []);
    assert.equal(lignesDe(user).length, 0);
  });

  test('R10 — bloqué après deux tickets : les deux sont gardés, la ponctuation ne se double pas', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecBricomarche('lot94b3');
    const etat = etatDuSixOctobre();
    etat.enMagasin[2].ticket = 'non-pdf';
    const { r } = await lire(user, etat);
    assert.equal(r.ok, true, 'des tickets sont entrés : une réussite partielle');
    assert.equal(r.message,
      '2 factures récupérées, 3 non obtenues — le prochain passage les réessaiera. Après un clic sur « Voir mon ticket », '
      + 'Bricomarché n\'a pas remis de PDF : crabe n\'a plus rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le. '
      + 'Les 2 autres tickets n\'ont pas été demandés : ils le seront au prochain passage. Les 2 documents récupérés sont '
      + `les tickets de caisse de 2 achats en magasin. ${RESUME}`);
    assert.doesNotMatch(r.message, /\. —/);
    assert.equal(lignesDe(user).length, 2, 'rien de ce qui a été pris n\'est perdu');
  });

  test('R10 — le temps permis écoulé : ce qui est pris est en base, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecBricomarche('lot94b4');
    const instance = registry.get('bricomarche').module;
    const horloge = instance.horloge.maintenant;
    const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
    process.env.CRABE_LIMITE_EXECUTION_MS = String(30 * 60 * 1000);
    try {
      let t = 0;
      instance.horloge.maintenant = () => t;
      let { r } = await lire(user, etatDuSixOctobre({ surTicket: () => { t += 8 * 60 * 1000; } }));
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message,
        '3 factures récupérées — ce sont les tickets de caisse de 3 achats en magasin. La récupération a pris tout le temps '
        + `permis : 2 tickets attendent encore ; ils viendront au prochain passage. Rien de ce qui a été pris n'est perdu. ${RESUME}`);
      assert.equal(lignesDe(user).length, 3, 'les trois tickets pris sont en base');
      t = 0;
      ({ r } = await lire(user, etatDuSixOctobre({ surTicket: () => { t += 8 * 60 * 1000; } })));
      assert.equal(r.message,
        `2 factures récupérées — ce sont les tickets de caisse de 2 achats en magasin ; ceux des 3 autres étaient déjà dans vos documents. ${RESUME}`);
      assert.deepEqual(lignesDe(user).map((l) => l.remote_id).sort(), [...ANCRES].sort());
    } finally {
      instance.horloge.maintenant = horloge;
      if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
      else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
    }
  });

  test('R10 — la commande en ligne et la facture à venir : leurs mots ne changent pas', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecBricomarche('lot94b5');
    const { r } = await lire(user, etatDuSixOctobre({ volet: 'bouton', enMagasin: [] }));
    assert.equal(r.message,
      'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et aucun achat en magasin. '
      + 'Une facture semble proposée pour 1 commande(s) (« Télécharger ma facture ») : crabe ne sait pas encore la récupérer '
      + 'et n\'y a pas touché. Signalez-le, avec le libellé du bouton, ce que fait son clic et une capture de la commande '
      + 'dépliée : c\'est ce qui permettra d\'écrire la suite.');
  });
});

test.after(() => {
  helpers.teardown();
});
