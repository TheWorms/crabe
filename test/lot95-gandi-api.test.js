'use strict';

/**
 * Lot 95 — Gandi prend ses PDF par l'API de facturation.
 *
 * Mesuré le 06/10/2026 : le passage n° 708 de la production a lu les trois
 * organisations et leurs 168 factures, puis n'en a pris AUCUNE — le lien
 * « PDF », `/billing/<org>/invoices/<interne>/<numéro>/pdf`, rend une page de
 * l'application (HTML, ≈ 84 Ko), pas le fichier. Mesuré ensuite par l'utilisateur dans
 * son navigateur : le fichier vient de
 * `/billing/api/v5/billing/invoices/<interne>/pdf?lang=fr&invoice_num=<numéro>&sharing_id=<org>`,
 * dont les trois valeurs sont les trois segments du lien.
 *
 * Ces essais tournent au VRAI Chromium sur le faux Gandi mis au vrai
 * (`test/lot95-faux-sites.js`) : le lien sert une page HTML, seule l'API sert
 * le PDF, à la seule session du banc et pour les segments d'un lien existant.
 * Ils prouvent que le connecteur demande le PDF là où la mesure dit qu'il est,
 * et comment ; ils ne prouvent rien du vrai site.
 *
 * Le lancement d'un vrai navigateur est INTERDIT dans tout ce fichier (leçon du
 * lot 93) : une fonction qui lève est posée sur l'instance requise ET sur celle
 * du registre ; seul le faux lanceur, posé passage par passage, en ouvre un, et
 * chaque passage vérifie qu'il a servi.
 *
 * ⚠ Toutes les valeurs sont inventées : organisations « Organisation d'essai
 * … », identifiants faits de zéros, numéros « ZZ… », montants à 0,00 €.
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
const gandi = require('../server/connectors/available/gandi/connector');
const faux = require('./lot95-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'gandi', 'connector.js');
const HOTES = [faux.GANDI_ADMIN, faux.GANDI_ID];
const ORG = (n) => faux.idOrganisation(n);
const INTERDIT = () => {
  throw new Error('essai : lancement d\'un vrai navigateur interdit — le faux site n\'a pas été branché');
};

/** La phrase publique de la sortie anticipée (socle du lot 80), mot pour mot. */
const RENONCEMENT = 'Le parcours s\'est arrêté après 3 tentatives infructueuses de suite, toutes bloquées de la même façon : '
  + 'les documents suivants n\'ont pas été tentés, et le prochain passage reprendra depuis le début.';

/**
 * Le faux lanceur du banc, avec un compteur de PAGES par contexte : un nouvel
 * onglet ouvert par le connecteur (ou par la page) s'y verrait.
 */
function lanceurCompte(etat) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandiVrai(etat));
  const pages = [];
  return {
    banc,
    pages,
    lancer: async () => {
      const navigateur = await banc.lancer();
      const creer = navigateur.newContext.bind(navigateur);
      navigateur.newContext = async (options) => {
        const contexte = await creer(options);
        contexte.on('page', (p) => pages.push(p));
        return contexte;
      };
      return navigateur;
    },
  };
}

/** Un passage DIRECT (hors registre) d'une fonction du connecteur sur le faux site. */
async function passer(etat, { fonction = 'fetchInvoices', config = {}, ctxExtra = {} } = {}) {
  const l = lanceurCompte(etat);
  gandi.ouverture.lancer = l.lancer;
  const lignes = [];
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await gandi[fonction](
        { session: faux.sessionInventee(), historique: 'depuis', ...config },
        { userId: 1, log: (m) => lignes.push(String(m)), preuveDeListe: () => {}, knownRemoteIds: [], ...ctxExtra }
      );
    } catch (err) {
      erreur = err;
    }
    assert.ok(l.banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
    assert.equal(l.banc.ouverts(), 0, 'le connecteur a refermé son navigateur');
    return { resultat, erreur, journal: l.banc.journal, lignes, pages: l.pages };
  } finally {
    gandi.ouverture.lancer = INTERDIT;
    await l.banc.fermer();
  }
}

/**
 * Les gestes, à chaque passage : 0 clic, 0 saisie, 0 écriture, 0 fuite, aucun
 * hôte de Gandi avorté (rien n'a voulu sortir du banc vers Gandi), aucune
 * navigation vers un lien « PDF », aucun lien « PDF » demandé, aucun nouvel
 * onglet (une page par passage).
 */
function aucunGeste(journal, etat, pages, passages = 1) {
  assert.deepEqual(journal.clics, [], `aucun clic — la page les compte : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, [], 'aucune saisie');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.ok(!journal.avortees.some((h) => /(^|\.)gandi\.net$/.test(h)), `aucun hôte de Gandi hors du banc : ${journal.avortees}`);
  assert.equal(etat.compteurs.deconnexion, 0, '/billing/api/v5/logout n\'est jamais approché');
  for (const v of journal.visites) {
    assert.doesNotMatch(v, /\/invoices\/[^/?]+\/[^/?]+\/pdf/, `aucune navigation vers un lien « PDF » : ${v}`);
    assert.doesNotMatch(v, /\/billing\/api\/v5\/billing\//, `l'API ne se visite pas, elle se demande : ${v}`);
    assert.doesNotMatch(v, /logout|cart|autorenew|settings|prepaid|orders|overview|sort=|statut=/, `visite hors du parcours : ${v}`);
  }
  assert.equal(etat.compteurs.liens, 0, 'aucun lien « PDF » demandé, ni par navigation ni par fetch');
  assert.equal(pages.length, passages, `aucun nouvel onglet : ${pages.length} page(s) pour ${passages} passage(s)`);
}

/**
 * Chaque demande d'API : par le `fetch` de la page (jamais une navigation),
 * avec le cookie de session du contexte, sans en-tête ajouté, depuis la page
 * des factures où l'on est, à une adresse au motif exact.
 */
function demandesPropres(etat) {
  const demandes = etat.compteurs.demandesApi || [];
  for (const d of demandes) {
    assert.equal(d.type, 'fetch', `une demande d'API part du fetch de la page : ${d.type}`);
    assert.ok(d.cookieSession, 'la demande porte le cookie de session du contexte');
    assert.deepEqual(d.entetes.filter((e) => !faux.ENTETES_D_UN_FETCH_SIMPLE.includes(e)), [], 'aucun en-tête ajouté');
    assert.match(new URL(d.page).pathname, /^\/billing\/[^/]+\/invoices\/?$/, `la demande part de la page des factures : ${d.page}`);
    assert.match(d.adresse, gandi.MOTIF_ADRESSE_API);
  }
  return demandes;
}

/** Ce qu'aucun journal ne doit porter : nom, identifiant, numéro, adresse d'API en clair. */
function journalMuet(texte) {
  assert.doesNotMatch(texte, /Organisation d'essai/, 'aucun nom d\'organisation au journal');
  assert.doesNotMatch(texte, /00000000-0000-4000-8000/, 'aucun identifiant d\'organisation au journal');
  assert.doesNotMatch(texte, /00000000-0000-0000-0000-/, 'aucun identifiant interne de facture au journal');
  assert.doesNotMatch(texte, /ZZ[A-C]\d{6}/, 'aucun numéro de facture au journal');
  assert.doesNotMatch(texte, /\/billing\/api\/v5\/billing\/invoices\/(?!…)/, 'aucune adresse d\'API en clair');
  assert.doesNotMatch(texte, /(?:invoice_num|sharing_id)=(?!…)/, 'aucun paramètre d\'API en clair');
}

/** Le numéro d'une facture rendue, lu dans son ancre. */
const numeroDe = (f) => f.remoteId.slice(`gandi-${f.accountId}-`.length);

test.before(async () => {
  await helpers.setup();
  gandi.ouverture.lancer = INTERDIT;
});

// ---------------------------------------------------------------------------
// D1 — la chaîne du 06/10 : chaque PDF pris à l'API, aucun au lien
// ---------------------------------------------------------------------------

test('D1 — la chaîne du 06/10, trois organisations (42, 5, 121) sur 19 pages : les 168 factures prises à l\'API, aucune au lien', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteDuSixOctobre();
  const { resultat, erreur, journal, lignes, pages } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 168);
  const parOrg = {};
  for (const f of resultat.invoices) parOrg[f.accountId] = (parOrg[f.accountId] || 0) + 1;
  assert.deepEqual(parOrg, { [ORG(1)]: 42, [ORG(2)]: 5, [ORG(3)]: 121 });
  for (const f of resultat.invoices) {
    const numero = numeroDe(f);
    assert.match(numero, /^ZZ[ABC]\d{6}$/, 'l\'ancre reste celle du lot 93 : gandi-<organisation>-<numéro>, tirée du lien');
    assert.match(f.filename, new RegExp(`^gandi_\\d{4}-\\d{2}_${numero}(-\\d+)?\\.pdf$`), 'le nom reste celui du lot 93');
    assert.equal(f.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(f.buffer.toString('latin1').includes(`facture inventee ${numero}`), 'le PDF est celui de CETTE facture');
  }
  assert.equal(new Set(resultat.invoices.map((f) => f.filename)).size, 168);
  assert.equal(resultat.precision, '— Gandi : 3 organisations lues, 168 factures vues.');
  assert.equal(resultat.manquees, undefined);
  assert.equal(resultat.couverture.complete, true);
  assert.equal(demandesPropres(etat).length, 168, 'une demande d\'API par facture, pas une de plus');
  assert.equal(etat.compteurs.pdf.length, 168);
  assert.match(texte, /gandi : bilan — 3 organisation\(s\) lue\(s\), 168 facture\(s\) vue\(s\), 168 prise\(s\), 0 manquée\(s\), 0 hors période, 0 en attente\./);
  journalMuet(texte);
  aucunGeste(journal, etat, pages);
});

test('D1 — un seul passage par le lien de chaque facture : l\'adresse d\'API demandée est celle des TROIS segments de SON lien', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteDuSixOctobre();
  const { erreur } = await passer(etat);
  assert.equal(erreur, null);
  const attendues = etat.organisations.flatMap((o) => o.factures.map((f) => faux.adresseApiDe(o, f)));
  assert.deepEqual(etat.compteurs.demandesApi.map((d) => d.adresse).sort(), attendues.sort());
});

// ---------------------------------------------------------------------------
// D2 — l'adresse d'API : une seule fonction, un motif exact, rien d'altéré
// ---------------------------------------------------------------------------

const LIEN = {
  organisation: ORG(1),
  interne: '00000000-0000-0000-0000-006500000001',
  numero: 'ZZA009000',
};
const CHEMIN_LIEN = `/billing/${LIEN.organisation}/invoices/${LIEN.interne}/${LIEN.numero}/pdf`;
const ADRESSE = `https://admin.gandi.net/billing/api/v5/billing/invoices/${LIEN.interne}/pdf?lang=fr&invoice_num=${LIEN.numero}&sharing_id=${LIEN.organisation}`;

test('D2 — l\'adresse d\'API se construit depuis le lien, relatif ou absolu : hôte, chemin, exactement trois paramètres égaux aux segments', () => {
  for (const lien of [CHEMIN_LIEN, `https://admin.gandi.net${CHEMIN_LIEN}`, `${CHEMIN_LIEN}/`]) {
    const api = gandi.adresseApiDuPdf(lien);
    assert.equal(api.ok, true, api.raison);
    assert.equal(api.adresse, ADRESSE);
    const u = new URL(api.adresse);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.hostname, 'admin.gandi.net');
    assert.equal(u.pathname, `/billing/api/v5/billing/invoices/${LIEN.interne}/pdf`);
    assert.deepEqual([...u.searchParams.keys()], ['lang', 'invoice_num', 'sharing_id']);
    assert.equal(u.searchParams.get('lang'), 'fr');
    assert.equal(u.searchParams.get('invoice_num'), LIEN.numero);
    assert.equal(u.searchParams.get('sharing_id'), LIEN.organisation);
    assert.match(api.adresse, gandi.MOTIF_ADRESSE_API);
    assert.deepEqual(gandi.verifierAdresseApi(api.adresse, api), { ok: true });
  }
});

test('D2 — un lien altéré n\'est pas demandé, et la raison dit la FORME de l\'écart, jamais une valeur', () => {
  const cas = [
    ['segment manquant', `/billing/${LIEN.organisation}/invoices/${LIEN.numero}/pdf`, /n'a pas la forme d'un lien « PDF »/],
    ['segment en trop', `/billing/${LIEN.organisation}/invoices/${LIEN.interne}/${LIEN.numero}/copie/pdf`, /n'a pas la forme d'un lien « PDF »/],
    ['autre hôte', `https://autre-hote.invalid${CHEMIN_LIEN}`, /n'a pas la forme d'un lien « PDF »/],
    ['http', `http://admin.gandi.net${CHEMIN_LIEN}`, /n'a pas la forme d'un lien « PDF »/],
    ['numéro qui surprend', `/billing/${LIEN.organisation}/invoices/${LIEN.interne}/${LIEN.numero}+1/pdf`,
      /^le lien surprend : segment « numéro » de 11 caractère\(s\), dont 1 hors de l'alphabet attendu \(« \+ »\)$/],
    ['interne qui surprend (barre encodée)', `/billing/${LIEN.organisation}/invoices/a%2Fb/${LIEN.numero}/pdf`,
      /^le lien surprend : segment « interne » de 3 caractère\(s\), dont 1 hors de l'alphabet attendu \(« \/ »\)$/],
    // `%2E%2E` est un segment « .. » pour l'analyseur d'adresses : le chemin
    // remonte, et ce n'est plus un lien de facture.
    ['remontée de chemin', `/billing/${LIEN.organisation}/invoices/%2E%2E/${LIEN.numero}/pdf`, /n'a pas la forme d'un lien « PDF »/],
    ['organisation qui surprend', `/billing/org.perso/invoices/${LIEN.interne}/${LIEN.numero}/pdf`,
      /^le lien surprend : segment « organisation » de 9 caractère\(s\), dont 1 hors de l'alphabet attendu \(« \. »\)$/],
    ['espace dans le numéro', `/billing/${LIEN.organisation}/invoices/${LIEN.interne}/ZZ%20A/pdf`,
      /segment « numéro » de 4 caractère\(s\), dont 1 hors de l'alphabet attendu \(espace\)/],
    ['lettre accentuée : comptée, jamais nommée', `/billing/${LIEN.organisation}/invoices/${LIEN.interne}/ZZ%C3%89/pdf`,
      /^le lien surprend : segment « numéro » de 3 caractère\(s\), dont 1 hors de l'alphabet attendu$/],
  ];
  for (const [nom, lien, raison] of cas) {
    const api = gandi.adresseApiDuPdf(lien);
    assert.equal(api.ok, false, `${nom} : refusé`);
    assert.equal(api.adresse, undefined, `${nom} : aucune adresse construite`);
    assert.match(api.raison, raison, nom);
    assert.doesNotMatch(api.raison, /ZZA|0000|org\.perso|autre-hote/, `${nom} : aucune valeur dans la raison`);
  }
  assert.equal(gandi.formeDuSegment('..'), 'fait seulement de points');
  assert.equal(gandi.formeDuSegment(''), 'vide');
  assert.equal(gandi.formeDuSegment('Z'.repeat(81)), 'de 81 caractères, au-delà de 80');
  // L'organisation d'un AUTRE lien : l'adresse construite pour l'un ne vaut pas pour l'autre.
  const autre = { ...LIEN, organisation: ORG(2) };
  const api = gandi.adresseApiDuPdf(CHEMIN_LIEN);
  const refus = gandi.verifierAdresseApi(api.adresse, autre);
  assert.equal(refus.ok, false);
  assert.equal(refus.raison, 'adresse d\'API dont les paramètres ne sont pas les segments du lien de cette facture');
});

test('D2 — le motif exact, revérifié avant la demande : paramètre en plus ou en moins, ordre, langue, hôte, chemin, fragment — tout est refusé', () => {
  const refusees = [
    ['paramètre en plus', `${ADRESSE}&extra=1`],
    ['paramètre en tête', ADRESSE.replace('?lang=fr', '?x=1&lang=fr')],
    ['paramètre en moins', ADRESSE.replace(`&sharing_id=${LIEN.organisation}`, '')],
    ['autre ordre', ADRESSE.replace(`lang=fr&invoice_num=${LIEN.numero}`, `invoice_num=${LIEN.numero}&lang=fr`)],
    ['autre langue', ADRESSE.replace('lang=fr', 'lang=en')],
    ['http', ADRESSE.replace('https:', 'http:')],
    ['autre hôte', ADRESSE.replace('admin.gandi.net', 'autre-hote.invalid')],
    ['hôte suffixé', ADRESSE.replace('admin.gandi.net', 'admin.gandi.net.autre-hote.invalid')],
    ['autre version', ADRESSE.replace('/v5/', '/v4/')],
    ['segment en plus', ADRESSE.replace('/pdf?', '/pdf/copie?')],
    ['remontée de chemin', ADRESSE.replace(LIEN.interne, '..')],
    ['fragment', `${ADRESSE}#x`],
    ['paramètre répété', `${ADRESSE}&sharing_id=${LIEN.organisation}`],
  ];
  for (const [nom, adresse] of refusees) {
    const r = gandi.verifierAdresseApi(adresse, LIEN);
    assert.equal(r.ok, false, `${nom} : refusée`);
    assert.match(r.raison, /^adresse d'API hors du motif attendu \(/, nom);
    assert.doesNotMatch(r.raison, /ZZA|0000|autre-hote/, `${nom} : la forme, jamais une valeur`);
  }
  assert.equal(
    gandi.verifierAdresseApi(`${ADRESSE}&extra=1`, LIEN).raison,
    'adresse d\'API hors du motif attendu (https://admin.gandi.net/billing/api/v5/billing/invoices/…/pdf?lang=fr&invoice_num=…&sharing_id=…&…=…)'
  );
  assert.equal(
    gandi.verifierAdresseApi(ADRESSE.replace('admin.gandi.net', 'autre-hote.invalid'), LIEN).raison,
    'adresse d\'API hors du motif attendu ([autre hôte]/billing/api/v5/billing/invoices/…/pdf?lang=fr&invoice_num=…&sharing_id=…)'
  );
  assert.deepEqual(gandi.verifierAdresseApi(ADRESSE, LIEN), { ok: true });
});

test('D2 — par le banc : des liens altérés dans la page ne sont pas demandés, et le journal le dit sous sa forme', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteDuSixOctobre({
    liensAlteres: {
      ZZA009000: 'manquant',
      ZZA008999: 'en-trop',
      ZZA008998: 'autre-hote',
      ZZA008997: 'autre-organisation',
      ZZA008996: 'surprenant',
    },
  });
  const { resultat, erreur, journal, lignes, pages } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  // Les quatre liens qui n'en sont plus : ni vus, ni demandés, dits.
  assert.match(texte, /gandi : organisation 1\/3 — 4 ligne\(s\) sans lien de PDF reconnu, non prise\(s\)\./);
  // Le lien bien formé dont un segment surprend : vu, pas demandé, dit.
  assert.ok(lignes.includes('gandi : une facture n\'a pas pu être prise : elle n\'a pas été demandée — le lien surprend : '
    + 'segment « numéro » de 11 caractère(s), dont 1 hors de l\'alphabet attendu (« + »).'), texte);
  assert.equal(resultat.invoices.length, 163);
  assert.equal(resultat.manquees, 1);
  assert.equal(resultat.precision, 'Gandi : 3 organisations lues, 164 factures vues.');
  const demandees = demandesPropres(etat).map((d) => d.adresse).join('\n');
  for (const n of Object.keys(etat.liensAlteres)) assert.doesNotMatch(demandees, new RegExp(`invoice_num=${n.replace('+', '\\+')}`), `${n} jamais demandé`);
  assert.equal(etat.compteurs.demandesApi.length, 163);
  assert.ok(!journal.avortees.includes('autre-hote.invalid'), 'le lien vers un autre hôte n\'a pas même été tenté');
  journalMuet(texte);
  aucunGeste(journal, etat, pages);
});

// ---------------------------------------------------------------------------
// B3 / R3 — par construction : aucun geste, un seul endroit qui demande un PDF
// ---------------------------------------------------------------------------

test('R3 — par construction : aucun geste, aucune navigation vers un lien « PDF », un seul endroit qui demande un PDF', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  for (const geste of [/\.click\s*\(/, /\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /keyboard\./,
    /mouse\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.check\s*\(/, /\.selectOption\s*\(/, /\.setInputFiles\s*\(/,
    /\.dispatchEvent\s*\(/, /\.tap\s*\(/, /\.hover\s*\(/, /\.focus\s*\(/, /touchscreen\./, /\.\$\$?\s*\(/,
    /window\.open/, /waitForEvent\s*\(/]) {
    assert.doesNotMatch(code, geste, `aucun geste sur la page (${geste})`);
  }
  // Les navigations : `page.goto` une seule fois, dans `naviguer` ; et `naviguer`
  // ne reçoit que l'adresse de la facturation, d'une page de liste, ou de la
  // liste d'une facture — jamais le lien d'une facture ni l'API.
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule fonction navigue');
  const navigations = [...code.matchAll(/naviguer\(page, ([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(navigations)].sort(), ['URL_FACTURATION', 'adresse', 'adresseListe'].sort(),
    `naviguer ne reçoit que des adresses de liste : ${navigations}`);
  assert.doesNotMatch(code, /naviguer\([^)]*(doc\.|api\.|lien\.)/, 'jamais le lien d\'une facture ni l\'API en navigation');
  assert.doesNotMatch(code, /\bnewPage\s*\([^)]*\)[\s\S]*\bnewPage\s*\(/, 'une seule page ouverte par passage');
  // Un seul endroit demande un PDF : à l'adresse d'API, revérifiée.
  assert.equal((code.match(/fluxDeLaPage\s*\(/g) || []).length, 1, 'un seul endroit demande un PDF');
  assert.match(code, /const lu = await ongletPdf\.fluxDeLaPage\(page, api\.adresse\);/);
  assert.equal((code.match(/adresseApiDuPdf\(doc\.adresse\)/g) || []).length, 1);
  assert.match(code, /const controle = api\.ok \? verifierAdresseApi\(api\.adresse, doc\) : api;\s*if \(!controle\.ok\) \{/);
  assert.ok(code.indexOf('verifierAdresseApi(api.adresse, doc)') >= 0
    && code.indexOf('verifierAdresseApi(api.adresse, doc)') < code.indexOf('ongletPdf.fluxDeLaPage(page, api.adresse)'),
  'la vérification précède la demande');
  // Une seule fonction construit l'adresse : le chemin de l'API n'est employé
  // qu'une fois (hors de la liste des exports).
  const horsExports = code.slice(0, code.indexOf('module.exports'));
  assert.equal((horsExports.match(/\bCHEMIN_API_PDF\b/g) || []).length, 2, 'déclaré, puis employé une seule fois');
  const corps = /function adresseApiDuPdf\([\s\S]*?\n}\n/.exec(code)[0];
  assert.match(corps, /\$\{CHEMIN_API_PDF\}/, 'employé dans adresseApiDuPdf');
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch|ctx\.fetch|acceptDownloads: false/,
    'aucun client HTTP hors du navigateur');
});

// ---------------------------------------------------------------------------
// D3 — l'API qui ne rend pas un PDF : refus, journal R6, arrêt, vrai compte
// ---------------------------------------------------------------------------

/** La ligne R6 attendue, par nature, pour la réponse du banc (sa taille mesurée sur le banc lui-même). */
function griefAttendu(nature) {
  const n = faux.apiNonPdf(nature).corps.length;
  return {
    html: `a rendu ${n} octets qui ne sont pas un PDF [reçu : page web (HTML), type déclaré text/html, ${n} octets, sans redirection]`,
    json: `a rendu ${n} octets qui ne sont pas un PDF [reçu : données JSON, type déclaré application/json, ${n} octets, sans redirection]`,
    vide: 'n\'a rendu aucun octet [reçu : vide, type déclaré application/pdf, 0 octet, sans redirection]',
    autre: `a rendu ${n} octets qui ne sont pas un PDF [reçu : autre, type déclaré image/gif, ${n} octets, sans redirection]`,
    401: `a rendu HTTP ### [reçu : données JSON, type déclaré application/json, ${n} octets, sans redirection]`,
  }[nature];
}

for (const nature of ['html', 'json', 'vide', 'autre', '401']) {
  test(`D3 — l'API rend ${nature === '401' ? 'un 401' : `« ${nature} »`} : refusée, le journal dit ce que c'était, arrêt après trois, 168 non obtenues`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.compteDuSixOctobre({ apiNonPdf: { '*': nature } });
    const { resultat, erreur, journal, lignes, pages } = await passer(etat);
    const texte = lignes.join('\n');
    assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
    const grief = griefAttendu(nature);
    const refus = lignes.filter((l) => l.includes('n\'a pas pu être prise'));
    assert.deepEqual(refus, Array(3).fill(`gandi : une facture n'a pas pu être prise : le document ${grief}.`));
    assert.ok(lignes.includes(`gandi : 3 document(s) de suite ont échoué pour la même raison (${grief}) et aucun n'a encore pu être `
      + 'récupéré : le parcours s\'arrête là plutôt que de répéter le même échec sur tous les suivants.'), texte);
    assert.ok(lignes.includes('gandi : bilan — 3 organisation(s) lue(s), 168 facture(s) vue(s), 0 prise(s), 3 manquée(s), '
      + '0 hors période, 165 en attente — arrêt avant la fin : ces 165 non demandée(s) comptent comme non obtenues, 168 au total.'), texte);
    assert.equal(resultat.invoices.length, 0);
    assert.equal(resultat.manquees, 168, 'les factures non demandées après l\'arrêt comptent comme non obtenues (R4)');
    assert.equal(resultat.renoncement, RENONCEMENT);
    assert.equal(resultat.precision, 'Gandi : 3 organisations lues, 168 factures vues.');
    assert.equal(resultat.couverture.complete, false);
    assert.equal(demandesPropres(etat).length, 3, 'trois demandes, puis plus aucune');
    assert.doesNotMatch(texte, /#{4,}/, 'les tailles s\'écrivent en chiffres');
    journalMuet(texte);
    aucunGeste(journal, etat, pages);
  });
}

test('D3 — une seule facture refusée, sans arrêt : elle seule est non obtenue, le compte ne change pas', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteDuSixOctobre({ apiNonPdf: { ZZB008999: 'json' } });
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null);
  assert.equal(resultat.invoices.length, 167);
  assert.equal(resultat.manquees, 1);
  assert.equal(resultat.renoncement, undefined);
  assert.equal(resultat.precision, 'Gandi : 3 organisations lues, 168 factures vues.');
});

test('D3 — le temps écoulé ne change pas (lot 93) : ce qui attend n\'est pas « non obtenu »', faux.SANS_NAVIGATEUR, async () => {
  const horloge = gandi.ouverture.maintenant;
  const limite = process.env.CRABE_LIMITE_EXECUTION_MS;
  process.env.CRABE_LIMITE_EXECUTION_MS = String(30 * 60 * 1000);
  let t = 0;
  gandi.ouverture.maintenant = () => t;
  try {
    const etat = faux.compteDuSixOctobre({ surPdf: () => { t += 60 * 1000; } });
    const { resultat, erreur, lignes } = await passer(etat);
    assert.equal(erreur, null);
    assert.equal(resultat.invoices.length, 21);
    assert.equal(resultat.manquees, undefined, 'le temps n\'est pas un refus');
    assert.equal(resultat.precision, '— Gandi : 3 organisations lues, 168 factures vues. La récupération a pris tout le temps permis : '
      + '147 factures attendent encore ; elles viendront au prochain passage. Rien de ce qui a été pris n\'est perdu.');
    assert.ok(lignes.includes('gandi : bilan — 3 organisation(s) lue(s), 168 facture(s) vue(s), 21 prise(s), 0 manquée(s), '
      + '0 hors période, 147 en attente (interrompu : temps).'), lignes.join('\n'));
  } finally {
    gandi.ouverture.maintenant = horloge;
    if (limite === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = limite;
  }
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur
// ---------------------------------------------------------------------------

/** L'instance que le REGISTRE exécute — pas celle du `require` ci-dessus (lot 93). */
const instanceDuRegistre = () => registry.get('gandi').module;

async function compteAvecGandi(nom) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, 'gandi');
  registry.saveConfig(user.id, 'gandi', { session: faux.sessionInventee() }, { origine: 'fenetre' });
  return user;
}

/** Branche le faux site sur l'instance du registre, le temps de `corps`. */
async function surLeBanc(etat, corps) {
  const l = lanceurCompte(etat);
  const instance = instanceDuRegistre();
  instance.ouverture.lancer = l.lancer;
  try {
    const r = await corps();
    assert.ok(l.banc.lancements() >= 1, 'le FAUX navigateur a servi, aucun autre');
    aucunGeste(l.banc.journal, etat, l.pages, l.banc.lancements());
    demandesPropres(etat);
    return { r, journal: l.banc.journal };
  } finally {
    instance.ouverture.lancer = INTERDIT;
    await l.banc.fermer();
  }
}

function journalDe(user) {
  return db.get().prepare("SELECT message FROM app_logs WHERE user_id = ? OR source LIKE 'connector:gandi%' ORDER BY id")
    .all(user.id).map((l) => l.message).join('\n');
}

const dernierPassage = (user) => db.get().prepare(
  "SELECT success, cause, invoice_count, message FROM run_logs WHERE user_id = ? AND connector_id = 'gandi' ORDER BY id DESC LIMIT 1"
).get(user.id);

test.describe('par le vrai planificateur', () => {
  let lancementReel;
  let scrapingAvant;
  test.before(() => {
    const configuration = require('../server/config').config;
    scrapingAvant = configuration.scrapingDisabled;
    configuration.scrapingDisabled = false;
    lancementReel = instanceDuRegistre().ouverture.lancer;
    instanceDuRegistre().ouverture.lancer = INTERDIT;
    destinations.restoreLocal();
  });
  test.after(() => {
    require('../server/config').config.scrapingDisabled = scrapingAvant;
    instanceDuRegistre().ouverture.lancer = lancementReel;
  });

  test('D1 — premier passage : « 168 factures récupérées — … », 168 lignes en trois dossiers ; second passage : « Aucune nouvelle facture — … », rien de redemandé', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot95g1');
    let etat = faux.compteDuSixOctobre();
    let { r } = await surLeBanc(etat, () => scheduler.runForUser(user.id, 'gandi', 'manual'));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '168 factures récupérées — Gandi : 3 organisations lues, 168 factures vues.');
    const lignes = db.get().prepare('SELECT filename, account_id, remote_id FROM invoices WHERE user_id = ? AND connector_id = ?')
      .all(user.id, 'gandi');
    assert.equal(lignes.length, 168);
    assert.deepEqual([...new Set(lignes.map((l) => l.account_id))].sort(), [ORG(1), ORG(2), ORG(3)]);
    assert.ok(lignes.every((l) => l.remote_id === `gandi-${l.account_id}-${l.remote_id.slice(`gandi-${l.account_id}-`.length)}`));
    assert.equal(etat.compteurs.demandesApi.length, 168);

    etat = faux.compteDuSixOctobre();
    ({ r } = await surLeBanc(etat, () => scheduler.runForUser(user.id, 'gandi', 'manual')));
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Aucune nouvelle facture — Gandi : 3 organisations lues, 168 factures vues.');
    assert.equal((etat.compteurs.demandesApi || []).length, 0, 'rien n\'est redemandé');
    journalMuet(journalDe(user));
  });

  test('D3 — échec complet par le planificateur : « 168 vous étaient proposés », mot pour mot', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot95g2');
    const { r } = await surLeBanc(faux.compteDuSixOctobre({ apiNonPdf: { '*': 'html' } }),
      () => scheduler.runForUser(user.id, 'gandi', 'manual'));
    assert.equal(r.ok, false);
    assert.equal(r.message,
      'Aucun document n\'a pu être récupéré — 168 vous étaient proposés, aucun n\'a pu être téléchargé. Le détail de ce qui '
      + 'a bloqué est dans le journal de cette exécution. Le parcours s\'est arrêté après 3 tentatives infructueuses de suite, '
      + 'toutes bloquées de la même façon : les documents suivants n\'ont pas été tentés, et le prochain passage reprendra '
      + 'depuis le début. Gandi : 3 organisations lues, 168 factures vues.');
    const ligne = dernierPassage(user);
    assert.equal(ligne.success, 0);
    assert.equal(ligne.cause, 'echec');
    assert.equal(ligne.invoice_count, 0);
    assert.equal(ligne.message, r.message);
    journalMuet(journalDe(user));
  });

  test('D3 — réussite partielle suivie d\'un arrêt (l\'API répond 401, la session est tombée) : les 5 prises gardées, « 163 non obtenues », mot pour mot', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot95g3');
    const { r } = await surLeBanc(faux.compteDuSixOctobre({ sessionMeurtApresPdf: 5 }),
      () => scheduler.runForUser(user.id, 'gandi', 'manual'));
    assert.equal(r.ok, true, 'des factures sont entrées : une réussite partielle');
    assert.equal(r.message,
      '5 factures récupérées, 163 non obtenues — le prochain passage les réessaiera. Gandi : 3 organisations lues, '
      + '168 factures vues. La lecture s\'est interrompue — Gandi a demandé de vous reconnecter : les factures déjà prises '
      + 'sont gardées. Reconnectez-vous depuis la fiche de Gandi pour récupérer la suite.');
    assert.equal(db.get().prepare('SELECT COUNT(*) n FROM invoices WHERE user_id = ? AND connector_id = ?').get(user.id, 'gandi').n, 5);
    const texte = journalDe(user);
    assert.match(texte, new RegExp(`gandi : une facture n'a pas pu être prise : le document ${griefAttendu('401').replace(/[[\]().]/g, '\\$&')}\\.`));
    assert.match(texte, /gandi : renvoyé vers la connexion en prenant les factures : les 5 déjà prise\(s\) sont gardées\./);
    assert.match(texte, /5 prise\(s\), 0 manquée\(s\), 0 hors période, 163 en attente \(interrompu : session\) — arrêt avant la fin : ces 163 non demandée\(s\) comptent comme non obtenues, 163 au total\./);
    journalMuet(texte);
  });
});

test.after(() => {
  helpers.teardown();
});
