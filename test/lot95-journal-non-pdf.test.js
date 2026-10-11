'use strict';

/**
 * Lot 95 (R6) — quand un document reçu n'est pas un PDF, le journal dit ce que
 * c'était, pour TOUS les connecteurs.
 *
 * Le 06/10/2026, le passage n° 708 de Gandi a écrit trois fois « le document a
 * rendu ##### octets qui ne sont pas un PDF » : le refus, jamais ce qui était
 * arrivé à la place. Les deux codes communs qui refusent un document faute de
 * `%PDF-` — `onglet-pdf` (le flux relu dans la page, la réponse déjà reçue par
 * un onglet, la relecture hors navigateur) et `clic-document` (le
 * téléchargement, la réponse au type PDF vue par la page) — ajoutent
 * désormais à leur grief un constat entre crochets : la nature du document
 * (page web, données JSON, vide, autre), son type déclaré, sa taille, la
 * redirection quand elle est connue. Jamais l'adresse, un extrait, un nom de
 * fichier.
 *
 * Ce qui ne change pas, et que ces essais verrouillent : la décision (le
 * document reste refusé), le compte, la sortie anticipée (elle compare les
 * griefs SANS leur constat), et les messages de l'utilisateur — prouvé par le
 * vrai planificateur sur un connecteur existant (Bricomarché, dont le ticket
 * téléchargé est une page d'erreur). Et, depuis la reprise du lot 95, le
 * chemin d'avant : un document accepté ne demande rien de plus à sa réponse,
 * et une réponse en erreur dont le corps ne se lit pas garde son grief d'avant.
 *
 * `onglet-pdf` est éprouvé contre un petit serveur LOCAL (la recette du lot 80 :
 * la fonction de page du socle s'exécute pour de vrai) ; `clic-document` au
 * vrai Chromium, sur une page reconstituée dont rien ne sort.
 *
 * ⚠ Valeurs inventées.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const profilMarchand = require('../server/connectors/profil-marchand');
const constatDocument = require('../server/connectors/constat-document');
const ongletPdf = require('../server/connectors/onglet-pdf');
const clicDocument = require('../server/connectors/clic-document');
const serieEchecs = require('../server/connectors/serie-echecs');
const faux = require('./lot93-faux-sites');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const HTML = Buffer.from('<!doctype html><html><body>Accès refusé à la facture 4242</body></html>', 'utf8');
const JSON_ = Buffer.from('{"erreur":"facture 4242 introuvable"}', 'utf8');
const AUTRE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** Ce qu'aucun constat ne dit : adresse, extrait, nom de fichier. */
function rienDeDit(grief) {
  assert.doesNotMatch(grief, /127\.0\.0\.1|exemple-boutique|\/fichier\/|\/document\/|\/factures/, `aucune adresse : ${grief}`);
  assert.doesNotMatch(grief, /Accès refusé|introuvable|4242|PNG|facture\.pdf|erreur"/, `aucun extrait ni nom de fichier : ${grief}`);
}

// ---------------------------------------------------------------------------
// 1. Le constat, pur
// ---------------------------------------------------------------------------

test('R6 — la nature se lit aux premiers octets non blancs : page web, données JSON, vide, autre', () => {
  const nature = (t) => constatDocument.natureDesOctets(Buffer.from(t, 'utf8'));
  assert.equal(nature('<!doctype html>'), 'html');
  assert.equal(nature('  \r\n\t<html>'), 'html');
  assert.equal(nature('﻿ <?xml version="1.0"?>'), 'html', 'marque d\'ordre des octets sautée ; une balise = page web');
  assert.equal(nature('{"a":1}'), 'json');
  assert.equal(nature('\n[1,2]'), 'json');
  assert.equal(constatDocument.natureDesOctets(Buffer.alloc(0)), 'vide');
  assert.equal(constatDocument.natureDesOctets(null), 'vide');
  assert.equal(nature('   '), 'autre', 'des blancs seuls ne sont pas « vide » : il y a des octets');
  assert.equal(nature('Erreur 500'), 'autre');
  assert.equal(constatDocument.natureDesOctets(AUTRE), 'autre');
  assert.equal(constatDocument.natureDesOctets(PDF), 'autre', 'un PDF n\'est jamais refusé par ce chemin');
});

test('R6 — le constat : nature, type déclaré sans paramètres, taille en chiffres, redirection connue — rien d\'autre', () => {
  assert.equal(constatDocument.constat(HTML, { type: 'text/html; charset=utf-8', redirige: false }),
    `[reçu : page web (HTML), type déclaré text/html, ${HTML.length} octets, sans redirection]`);
  assert.equal(constatDocument.constat(JSON_, { type: 'Application/JSON', redirige: true }),
    `[reçu : données JSON, type déclaré application/json, ${JSON_.length} octets, après redirection]`);
  assert.equal(constatDocument.constat(Buffer.alloc(0), { type: 'application/pdf', redirige: false }),
    '[reçu : vide, type déclaré application/pdf, 0 octet, sans redirection]');
  assert.equal(constatDocument.constat(AUTRE, {}), `[reçu : autre, ${AUTRE.length} octets]`, 'type et redirection inconnus : non écrits');
  assert.equal(constatDocument.constat(AUTRE, { type: null }), `[reçu : autre, aucun type déclaré, ${AUTRE.length} octets]`);
  assert.equal(constatDocument.constat(AUTRE, { type: 'n\'importe <quoi>' }), `[reçu : autre, type déclaré illisible, ${AUTRE.length} octets]`);
  assert.equal(constatDocument.constat(Buffer.from('<p>'), { taille: 84014 }), '[reçu : page web (HTML), 84014 octets]',
    'la taille entière quand seul le début est connu');
  assert.equal(constatDocument.sansConstat('a rendu 5 octets qui ne sont pas un PDF [reçu : vide, 0 octet] ; et [reçu : autre, 3 octets]'),
    'a rendu 5 octets qui ne sont pas un PDF ; et');
});

// ---------------------------------------------------------------------------
// 2. onglet-pdf — le flux relu dans la page, contre un serveur local
// ---------------------------------------------------------------------------

let serveur;
let base;
const ROUTES = {
  '/pdf': [200, { 'content-type': 'application/pdf' }, PDF],
  '/html': [200, { 'content-type': 'text/html; charset=utf-8' }, HTML],
  '/json': [200, { 'content-type': 'application/json' }, JSON_],
  '/vide': [200, { 'content-type': 'application/pdf' }, Buffer.alloc(0)],
  '/autre': [200, { 'content-type': 'image/png' }, AUTRE],
  '/sans-type': [200, {}, Buffer.from('Erreur 500', 'utf8')],
  '/redirige': [302, { location: '/html' }, Buffer.alloc(0)],
  '/401': [401, { 'content-type': 'application/json' }, Buffer.from('{"code":401}', 'utf8')],
};

test.before(async () => {
  await helpers.setup();
  serveur = http.createServer((req, res) => {
    const [statut, entetes, corps] = ROUTES[req.url] || [404, { 'content-type': 'text/plain' }, Buffer.from('?')];
    res.writeHead(statut, entetes);
    res.end(corps);
  });
  await new Promise((resoudre) => serveur.listen(0, '127.0.0.1', resoudre));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await new Promise((resoudre) => serveur.close(resoudre));
});

/** Une page dont `evaluate` exécute POUR DE VRAI la fonction du socle (recette du lot 80). */
const pageLocale = () => ({ evaluate: async (fn, arg) => fn(arg) });

test('R6 — onglet-pdf, le flux relu dans la page : la ligne de chaque nature, mot pour mot', async () => {
  const attendus = {
    '/html': `a rendu ${HTML.length} octets qui ne sont pas un PDF [reçu : page web (HTML), type déclaré text/html, ${HTML.length} octets, sans redirection]`,
    '/json': `a rendu ${JSON_.length} octets qui ne sont pas un PDF [reçu : données JSON, type déclaré application/json, ${JSON_.length} octets, sans redirection]`,
    '/vide': 'n\'a rendu aucun octet [reçu : vide, type déclaré application/pdf, 0 octet, sans redirection]',
    '/autre': `a rendu ${AUTRE.length} octets qui ne sont pas un PDF [reçu : autre, type déclaré image/png, ${AUTRE.length} octets, sans redirection]`,
    '/sans-type': 'a rendu 10 octets qui ne sont pas un PDF [reçu : autre, aucun type déclaré, 10 octets, sans redirection]',
    '/redirige': `a rendu ${HTML.length} octets qui ne sont pas un PDF [reçu : page web (HTML), type déclaré text/html, ${HTML.length} octets, après redirection]`,
    '/401': 'a rendu HTTP ### [reçu : données JSON, type déclaré application/json, 12 octets, sans redirection]',
  };
  for (const [chemin, grief] of Object.entries(attendus)) {
    const lu = await ongletPdf.fluxDeLaPage(pageLocale(), `${base}${chemin}`);
    assert.equal(lu.ok, false, `${chemin} : refusé, comme avant`);
    assert.equal(lu.grief, grief, chemin);
    rienDeDit(lu.grief);
  }
  const pris = await ongletPdf.fluxDeLaPage(pageLocale(), `${base}/pdf`);
  assert.equal(pris.ok, true, 'un PDF passe, comme avant');
  assert.deepEqual(pris.buffer, PDF);
});

test('R6 — onglet-pdf, l\'onglet : la réponse déjà reçue et la relecture hors navigateur disent ce qu\'elles ont reçu', async () => {
  const reponseRecue = {
    body: async () => HTML,
    headerValue: async (nom) => (nom === 'content-type' ? 'application/pdf' : null),
    request: () => ({ redirectedFrom: () => null }),
    url: () => `${base}/document`,
  };
  const onglet = {
    waitForLoadState: async () => {},
    url: () => `${base}/document`,
    evaluate: async (fn, arg) => {
      if (arg === undefined) return 'application/pdf';
      throw new Error('contexte détruit');
    },
    context: () => ({
      request: {
        get: async () => ({
          ok: () => true,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          url: () => `${base}/ailleurs`,
          body: async () => JSON_,
        }),
      },
    }),
    close: async () => {},
  };
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, reponseRecue);
  assert.equal(lu.ok, false);
  assert.equal(lu.grief,
    `la réponse déjà reçue a rendu ${HTML.length} octets qui ne sont pas un PDF [reçu : page web (HTML), type déclaré application/pdf, ${HTML.length} octets, sans redirection] ; `
    + 'le flux relu dans l\'onglet n\'a pas pu être lancé (contexte détruit) ; '
    + `la relecture de l'adresse de l'onglet a rendu ${JSON_.length} octets qui ne sont pas un PDF [reçu : données JSON, type déclaré application/json, ${JSON_.length} octets, après redirection]`);
  rienDeDit(lu.grief);

  // Une relecture en erreur dit aussi ce qu'elle a reçu ; son code, comme avant.
  onglet.context = () => ({
    request: {
      get: async () => ({
        ok: () => false,
        status: () => 403,
        headers: () => ({ 'content-type': 'text/html' }),
        url: () => `${base}/document`,
        body: async () => HTML,
      }),
    },
  });
  const refus = await ongletPdf.lireDocumentDeLOnglet(onglet, null);
  assert.equal(refus.grief, 'le flux relu dans l\'onglet n\'a pas pu être lancé (contexte détruit) ; '
    + `la relecture de l'adresse de l'onglet a rendu HTTP 403 [reçu : page web (HTML), type déclaré text/html, ${HTML.length} octets, sans redirection]`);
});

// ---------------------------------------------------------------------------
// 3. clic-document — au vrai Chromium, sur une page reconstituée
// ---------------------------------------------------------------------------

const BOUTIQUE = 'www.exemple-boutique.test';

function servirBoutique(url) {
  const fichiers = { html: [HTML, 'text/html; charset=utf-8'], json: [JSON_, 'application/json'], vide: [Buffer.alloc(0), 'application/octet-stream'], autre: [AUTRE, 'image/png'] };
  const f = /^\/fichier\/(\w+)$/.exec(url.pathname);
  if (f) {
    const [corps, type] = fichiers[f[1]];
    return { corps, entetes: { 'content-type': type, 'content-disposition': 'attachment; filename="facture.pdf"' } };
  }
  if (url.pathname === '/document/html-en-pdf') return { corps: HTML, entetes: { 'content-type': 'application/pdf' } };
  // Le téléchargement passe par un `fetch` puis un lien `download` créé par le
  // script (la mécanique du banc du lot 94) : un fichier servi directement par
  // la route au clic d'un lien est annulé par Chromium (« canceled »), mesuré.
  return {
    html: faux.gabarit('Mes factures', `<main>
      ${Object.keys(fichiers).map((n) => `<button id="t-${n}" type="button" data-fichier="/fichier/${n}">Télécharger (${n})</button>`).join('\n')}
      <button id="appel" type="button" onclick="fetch('/document/html-en-pdf')">Voir la facture</button></main>`, {
      script: `document.addEventListener('click', (e) => {
        const adresse = e.target && e.target.dataset && e.target.dataset.fichier;
        if (!adresse) return;
        fetch(adresse).then((r) => r.blob()).then((b) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'facture.pdf';
          a.click();
        });
      });`,
    }),
  };
}

for (const [nature, octets, ligne] of [
  ['html', HTML, `[reçu : page web (HTML), ${HTML.length} octets]`],
  ['json', JSON_, `[reçu : données JSON, ${JSON_.length} octets]`],
  ['vide', Buffer.alloc(0), '[reçu : vide, 0 octet]'],
  ['autre', AUTRE, `[reçu : autre, ${AUTRE.length} octets]`],
]) {
  test(`R6 — clic-document, un téléchargement « ${nature} » : refusé, et le journal dit ce que c'était`, faux.SANS_NAVIGATEUR, async () => {
    const site = await faux.ouvrirFauxSite(BOUTIQUE, servirBoutique);
    try {
      await site.page.goto(`https://${BOUTIQUE}/factures`);
      const obtenu = await clicDocument.documentDuClic(site.page, site.contexte, async () => {
        await site.page.click(`#t-${nature}`);
        return true;
      }, { delaiMs: 10_000 });
      assert.equal(obtenu.ok, false, 'refusé, comme avant');
      assert.equal(obtenu.grief, `le fichier téléchargé n'est pas un PDF (${octets.length} octets) ${ligne}`);
      rienDeDit(obtenu.grief);
      assert.deepEqual(site.journal.fuites, []);
      assert.deepEqual(site.journal.avortees, []);
    } finally {
      await site.fermer();
    }
  });
}

test('R6 — clic-document, une réponse au type PDF qui n\'en est pas un : les deux lectures disent ce qu\'elles ont reçu', faux.SANS_NAVIGATEUR, async () => {
  const site = await faux.ouvrirFauxSite(BOUTIQUE, servirBoutique);
  try {
    await site.page.goto(`https://${BOUTIQUE}/factures`);
    const obtenu = await clicDocument.documentDuClic(site.page, site.contexte, async () => {
      await site.page.click('#appel');
      return true;
    }, { delaiMs: 10_000 });
    const constat = `[reçu : page web (HTML), type déclaré application/pdf, ${HTML.length} octets, sans redirection]`;
    assert.equal(obtenu.ok, false);
    assert.equal(obtenu.grief, `une réponse au type PDF est passée mais ne se relit pas (${HTML.length} octets) ${constat} `
      + `et le flux relu dans la page a rendu ${HTML.length} octets qui ne sont pas un PDF ${constat}`);
    rienDeDit(obtenu.grief);
    assert.deepEqual(site.journal.fuites, []);
  } finally {
    await site.fermer();
  }
});

// ---------------------------------------------------------------------------
// 3 bis. Le chemin d'avant (reprise du lot 95, relecture du travail trouvé)
// ---------------------------------------------------------------------------
//
// Le constat n'existe que pour le journal. Deux écarts relevés à la reprise :
// le corps d'une réponse en erreur se lisait sans garde (s'il ne se lisait
// pas, le grief devenait « n'a pas pu être lancé (…) » au lieu de « a rendu
// HTTP ### », et la sortie anticipée, qui compare les griefs, pouvait décider
// autrement) ; et le type déclaré se redemandait à la réponse avant de savoir
// s'il servirait — y compris quand le document était accepté.

test('R6 — reprise : une réponse en erreur dont le corps ne se lit pas (coupé, ou trop lent) garde le grief d\'avant, mot pour mot', async () => {
  const prises = new Set();
  const local = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"code":');
    // « /coupe » : la connexion tombe en plein corps ; « /lent » : le corps ne
    // vient jamais (la connexion reste ouverte jusqu'au ménage).
    if (req.url === '/coupe') setTimeout(() => res.destroy(), 20);
  });
  local.on('connection', (prise) => prises.add(prise));
  await new Promise((resoudre) => local.listen(0, '127.0.0.1', resoudre));
  const ici = `http://127.0.0.1:${local.address().port}`;
  try {
    for (const chemin of ['/coupe', '/lent']) {
      const lu = await ongletPdf.fluxDeLaPage(pageLocale(), `${ici}${chemin}`, { delaiCorpsErreurMs: 300 });
      assert.deepEqual(lu, { ok: false, grief: 'a rendu HTTP ###' }, `${chemin} : le grief du lot 80, sans constat`);
    }
  } finally {
    for (const prise of prises) prise.destroy();
    await new Promise((resoudre) => local.close(resoudre));
  }
  assert.equal(ongletPdf.DELAI_CORPS_ERREUR_MS, 5_000, 'le délai par défaut, borné');
});

test('R6 — reprise : un document accepté par l\'onglet (voie 1) ne demande rien de plus à sa réponse', async () => {
  const demandes = [];
  const reponseRecue = {
    body: async () => PDF,
    headerValue: async (nom) => { demandes.push(`headerValue(${nom})`); return 'application/pdf'; },
    request: () => { demandes.push('request()'); return { redirectedFrom: () => null }; },
    url: () => `${base}/document`,
  };
  const onglet = {
    waitForLoadState: async () => {},
    url: () => `${base}/document`,
    evaluate: async () => { throw new Error('rien d\'autre ne doit être lu'); },
    close: async () => {},
  };
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, reponseRecue);
  assert.equal(lu.ok, true);
  assert.equal(lu.voie, 'réponse déjà reçue par l\'onglet');
  assert.deepEqual(lu.buffer, PDF);
  assert.deepEqual(demandes, [], 'le type et la redirection ne se demandent qu\'au refus');
});

test('R6 — reprise : une réponse au type PDF relue avec succès (clic-document) ne demande rien de plus qu\'avant', async () => {
  const ecouteurs = {};
  const demandes = [];
  const reponse = {
    headerValue: async (nom) => { demandes.push(`headerValue(${nom})`); return 'application/pdf'; },
    body: async () => HTML,
    url: () => `${base}/pdf`,
    request: () => { demandes.push('request()'); return { redirectedFrom: () => null }; },
  };
  // La page : ses écouteurs, et un `evaluate` qui exécute POUR DE VRAI la
  // relecture du socle contre le serveur local, qui sert le PDF.
  const page = {
    on: (evenement, fn) => { ecouteurs[evenement] = fn; },
    off: () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => fn(arg),
  };
  const obtenu = await clicDocument.documentDuClic(page, null, async () => {
    await ecouteurs.response(reponse);
    return true;
  }, { delaiMs: 2_000 });
  assert.equal(obtenu.ok, true, obtenu.grief);
  assert.equal(obtenu.voie, 'réponse PDF de la page, flux relu dans la page');
  assert.deepEqual(obtenu.buffer, PDF);
  assert.deepEqual(demandes, ['headerValue(content-type)'],
    'seule la reconnaissance du type PDF, comme avant le lot 95 : le constat ne se prépare qu\'au refus');
});

// ---------------------------------------------------------------------------
// 4. La décision ne change pas : la sortie anticipée compare sans le constat
// ---------------------------------------------------------------------------

test('R6 — la sortie anticipée : trois refus de même cause restent la même cause, quelle que soit la nature reçue', () => {
  const nu = 'a rendu 84014 octets qui ne sont pas un PDF';
  const griefs = [
    `${nu} ${constatDocument.constat(HTML, { type: 'text/html', redirige: false })}`,
    `a rendu 61 octets qui ne sont pas un PDF ${constatDocument.constat(JSON_, { type: 'application/json', redirige: true })}`,
    `a rendu 7 octets qui ne sont pas un PDF ${constatDocument.constat(AUTRE, {})}`,
  ];
  for (const g of griefs) assert.equal(serieEchecs.empreinteDeGrief(g), serieEchecs.empreinteDeGrief(nu));
  const avant = serieEchecs.suiteDEchecs();
  const apres = serieEchecs.suiteDEchecs();
  const decisions = (serie, liste) => liste.map((g) => serie.echec(g));
  assert.deepEqual(decisions(apres, griefs), decisions(avant, [nu, 'a rendu 61 octets qui ne sont pas un PDF', 'a rendu 7 octets qui ne sont pas un PDF']));
  assert.deepEqual(decisions(serieEchecs.suiteDEchecs(), griefs), [false, false, true], 'l\'arrêt au troisième, comme avant');
  // Le journal, lui, garde le constat.
  const s = serieEchecs.suiteDEchecs();
  for (const g of griefs) s.echec(g);
  assert.match(s.raison(), /\(a rendu 7 octets qui ne sont pas un PDF \[reçu : autre, 12 octets\]\)/);
});

// ---------------------------------------------------------------------------
// 5. Par le VRAI planificateur, un connecteur existant : le message ne bouge pas
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur, un connecteur existant (Bricomarché)', () => {
  let surLeProfilReel;
  let scrapingAvant;
  test.before(() => {
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

  const RESUME = 'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et 5 achats en magasin. '
    + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.';

  test('R6 — un ticket téléchargé qui est une page d\'erreur : le message de l\'utilisateur est celui du lot 94, mot pour mot ; seul le journal gagne le constat', faux.SANS_NAVIGATEUR, async () => {
    const user = await helpers.createUser({ username: 'lot95r6', role: 'admin' });
    registry.install(user.id, 'bricomarche');
    registry.saveConfig(user.id, 'bricomarche', { historique: 'depuis' }, { origine: 'fenetre' });
    const etat = {
      enLigne: [{
        numero: 'ZZ00000001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z',
        etat: 'Livrée', vendeur: 'Bricomarché',
      }],
      enMagasin: [
        { mois: 'Février 2026', dateAffichee: '03/02/2026', montant: '12,34 €' },
        { mois: 'Février 2026', dateAffichee: '01/02/2026', montant: '5,00 €' },
        { mois: 'Janvier 2026', dateAffichee: '20/01/2026', montant: '1 234,56 €', ticket: 'non-pdf' },
        { mois: 'Janvier 2026', dateAffichee: '09/01/2026', montant: '0,99 €' },
        { mois: 'Décembre 2025', dateAffichee: '15/12/2025', montant: '7,10 €' },
      ],
    };
    const site = await faux.ouvrirFauxSite(faux.BRICOMARCHE, faux.siteBricomarche(etat));
    let r;
    try {
      r = await faux.surLeFauxProfil(site, () => scheduler.runForUser(user.id, 'bricomarche', 'manual'));
      assert.ok(site.journal.visites.length > 0, 'la page reconstituée a bien servi');
      assert.deepEqual(site.journal.fuites, []);
    } finally {
      await site.fermer();
    }
    // Le message EXACT du lot 94 (test/lot94-bricomarche-tickets.test.js, « bloqué après deux tickets »).
    assert.equal(r.ok, true);
    assert.equal(r.message,
      '2 factures récupérées, 3 non obtenues — le prochain passage les réessaiera. Après un clic sur « Voir mon ticket », '
      + 'Bricomarché n\'a pas remis de PDF : crabe n\'a plus rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le. '
      + 'Les 2 autres tickets n\'ont pas été demandés : ils le seront au prochain passage. Les 2 documents récupérés sont '
      + `les tickets de caisse de 2 achats en magasin. ${RESUME}`);
    const journal = db.get().prepare("SELECT message FROM app_logs WHERE source = 'connector:bricomarche' ORDER BY id")
      .all().map((l) => l.message).join('\n');
    assert.match(journal, /« Voir mon ticket » demandé, pas de PDF \(le fichier téléchargé n'est pas un PDF \(64 octets\) \[reçu : page web \(HTML\), 64 octets\]\)/);
  });
});

test.after(() => {
  helpers.teardown();
});
