'use strict';

/**
 * Lot 102 — la retouche du socle `clic-document` : l'option `adressePermise`.
 *
 * Mesuré sur un banc local (11/10/2026, Playwright 1.62.1, sans écran) : un
 * `window.open` vers un PDF arrive comme un TÉLÉCHARGEMENT sur la page qui a
 * cliqué, l'onglet restant à l'adresse vide. Pour que « rien n'est lu d'un
 * onglet sur un autre domaine » (R4) tienne, l'adresse de ce qui serait lu est
 * jugée avant toute lecture. Ces essais prouvent, sur des objets simulés :
 *
 *   1. SANS l'option, le chemin d'avant, inchangé — c'est celui des dix autres
 *      connecteurs, qui ne la passent pas (un essai le vérifie) ;
 *   2. AVEC l'option, une adresse refusée n'est pas lue : ni fichier, ni
 *      corps de réponse, ni évaluation dans l'onglet ; l'onglet est refermé,
 *      le fichier effacé, le grief dit l'hôte et rien d'autre ;
 *   3. AVEC une option qui permet tout, le résultat est celui d'avant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const clicDocument = require('../server/connectors/clic-document');

const PDF = Buffer.from('%PDF-1.4\n% document simulé du lot 102\n%%EOF\n', 'latin1');
const AILLEURS = 'https://documents.exemple.invalid/facture.pdf?jeton=jeton-invente-0001';
const DU_SITE = 'https://rock-vedif.file.force.com/sfc/servlet.shepherd/document/download/ZZ';
const permise = (adresse) => !adresse || adresse.startsWith('https://rock-vedif.');

let dossier;
test.before(() => { dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot102-clic-')); });
test.after(() => fs.rmSync(dossier, { recursive: true, force: true }));

/** Un émetteur minimal : `on`, `off`, `emettre`. */
function emetteur(extra = {}) {
  const ecoutes = {};
  return {
    on: (ev, cb) => { (ecoutes[ev] = ecoutes[ev] || []).push(cb); },
    off: (ev, cb) => { const l = ecoutes[ev] || []; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); },
    emettre: (ev, arg) => { for (const cb of [...(ecoutes[ev] || [])]) cb(arg); },
    ...extra,
  };
}

function pageSimulee() {
  const page = emetteur({
    evaluations: 0,
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    evaluate: async () => { page.evaluations += 1; return null; },
    url: () => 'https://connexion.leaudiledefrance.fr/espace-particuliers/s/factures',
  });
  return page;
}

function telechargementSimule(adresse) {
  const chemin = path.join(dossier, `t-${Math.random().toString(16).slice(2)}.pdf`);
  fs.writeFileSync(chemin, PDF);
  const t = {
    lu: 0,
    efface: 0,
    url: () => adresse,
    path: async () => { t.lu += 1; return chemin; },
    failure: async () => null,
    delete: async () => { t.efface += 1; fs.rmSync(chemin, { force: true }); },
  };
  return t;
}

function reponseSimulee(adresse) {
  const r = {
    lue: 0,
    url: () => adresse,
    headerValue: async () => 'application/pdf',
    body: async () => { r.lue += 1; return PDF; },
    request: () => ({ redirectedFrom: () => null }),
  };
  return r;
}

function ongletSimule(adresse) {
  const o = emetteur({
    ferme: false,
    evaluations: 0,
    url: () => adresse,
    waitForLoadState: async () => {},
    evaluate: async () => { o.evaluations += 1; return 'application/pdf'; },
    close: async () => { o.ferme = true; },
    context: () => ({ request: { get: async () => { throw new Error('aucune relecture hors navigateur ici'); } } }),
  });
  return o;
}

/** Un clic qui déclenche `effet` (après le retour, comme une vraie page). */
function clicQui(effet) {
  return async () => { setTimeout(effet, 5); return true; };
}

// ---------------------------------------------------------------------------
// 1. Sans l'option : le chemin d'avant
// ---------------------------------------------------------------------------

test('sans `adressePermise` : un téléchargement venu d\'un autre domaine est lu, comme avant le lot 102', async () => {
  const page = pageSimulee();
  const t = telechargementSimule(AILLEURS);
  const r = await clicDocument.documentDuClic(page, emetteur(), clicQui(() => page.emettre('download', t)));
  assert.equal(r.ok, true);
  assert.equal(r.voie, 'téléchargement direct');
  assert.deepEqual(r.buffer, PDF);
  assert.equal(t.lu, 1);
  assert.equal(t.efface, 0);
});

test('sans `adressePermise` : un onglet d\'un autre domaine est lu, puis refermé, comme avant', async () => {
  const page = pageSimulee();
  const contexte = emetteur();
  const onglet = ongletSimule(AILLEURS);
  const reponse = reponseSimulee(AILLEURS);
  const r = await clicDocument.documentDuClic(page, contexte, clicQui(() => {
    contexte.emettre('page', onglet);
    onglet.emettre('response', reponse);
  }));
  assert.equal(r.ok, true);
  assert.match(r.voie, /^nouvel onglet — réponse déjà reçue/);
  assert.equal(reponse.lue, 1);
  assert.equal(onglet.ferme, true);
});

// ---------------------------------------------------------------------------
// 2. Avec l'option : rien n'est lu d'une adresse refusée
// ---------------------------------------------------------------------------

test('avec `adressePermise` : un téléchargement venu d\'un autre domaine n\'est pas lu, il est effacé, le grief dit l\'hôte seul', async () => {
  const page = pageSimulee();
  const t = telechargementSimule(AILLEURS);
  const r = await clicDocument.documentDuClic(page, emetteur(), clicQui(() => page.emettre('download', t)), { adressePermise: permise });
  assert.equal(r.ok, false);
  assert.equal(r.horsDomaine, true);
  assert.equal(r.grief, 'le téléchargement venait de documents.exemple.invalid, hors des domaines permis : rien n\'en a été lu');
  assert.equal(t.lu, 0, 'le fichier n\'est jamais ouvert');
  assert.equal(t.efface, 1, 'le fichier reçu par le navigateur est effacé');
  assert.doesNotMatch(r.grief, /jeton|facture\.pdf|\?/, 'ni chemin, ni requête');
});

test('avec `adressePermise` : un onglet d\'un autre domaine est refermé sans rien y évaluer ni lire, et sans attendre', async () => {
  const page = pageSimulee();
  const contexte = emetteur();
  const onglet = ongletSimule('https://documents.exemple.invalid/visionneuse?jeton=jeton-invente-0002');
  const debut = Date.now();
  const r = await clicDocument.documentDuClic(page, contexte, clicQui(() => contexte.emettre('page', onglet)),
    { adressePermise: permise, delaiMs: 30_000 });
  assert.equal(r.ok, false);
  assert.equal(r.horsDomaine, true);
  assert.equal(r.grief, 'l\'onglet ouvert par le clic venait de documents.exemple.invalid, hors des domaines permis : rien n\'en a été lu');
  assert.equal(onglet.ferme, true);
  assert.equal(onglet.evaluations, 0, 'rien n\'est évalué dans l\'onglet');
  assert.ok(Date.now() - debut < 5_000, 'l\'onglet refusé n\'attend pas les trente secondes d\'un document');
});

test('avec `adressePermise` : un onglet du site dont la RÉPONSE vient d\'ailleurs, et arrive APRÈS le premier contrôle, n\'est pas lu non plus', async () => {
  // La réponse arrive pendant l'attente de l'onglet, une fois le premier
  // contrôle passé (l'onglet était alors du site) : c'est le second contrôle,
  // juste avant la lecture, qui la refuse (morsure M5 du lot 102).
  const page = pageSimulee();
  const contexte = emetteur();
  const onglet = ongletSimule(DU_SITE);
  const reponse = reponseSimulee(AILLEURS);
  const r = await clicDocument.documentDuClic(page, contexte, clicQui(() => {
    contexte.emettre('page', onglet);
    setTimeout(() => onglet.emettre('response', reponse), 150);
  }), { adressePermise: permise });
  assert.equal(r.ok, false);
  assert.equal(r.horsDomaine, true);
  assert.match(r.grief, /^la réponse de l'onglet venait de documents\.exemple\.invalid/);
  assert.equal(reponse.lue, 0);
  assert.equal(onglet.ferme, true);
});

test('avec `adressePermise` : une réponse PDF de la page venue d\'ailleurs n\'est pas lue', async () => {
  const page = pageSimulee();
  const reponse = reponseSimulee(AILLEURS);
  const r = await clicDocument.documentDuClic(page, emetteur(), clicQui(() => page.emettre('response', reponse)), { adressePermise: permise });
  assert.equal(r.ok, false);
  assert.match(r.grief, /^la réponse de la page venait de documents\.exemple\.invalid/);
  assert.equal(reponse.lue, 0);
  assert.equal(page.evaluations, 0, 'aucun flux relu dans la page');
});

// ---------------------------------------------------------------------------
// 3. Avec une option qui permet : le résultat d'avant
// ---------------------------------------------------------------------------

test('avec une `adressePermise` qui permet : téléchargement, onglet et réponse rendent exactement ce qu\'ils rendaient sans elle', async () => {
  for (const avecOption of [false, true]) {
    const options = avecOption ? { adressePermise: () => true } : {};
    const page = pageSimulee();
    const t = telechargementSimule(DU_SITE);
    const r1 = await clicDocument.documentDuClic(page, emetteur(), clicQui(() => page.emettre('download', t)), options);
    assert.deepEqual({ ok: r1.ok, voie: r1.voie, octets: r1.buffer.length }, { ok: true, voie: 'téléchargement direct', octets: PDF.length });

    const contexte = emetteur();
    const onglet = ongletSimule(DU_SITE);
    const r2 = await clicDocument.documentDuClic(pageSimulee(), contexte, clicQui(() => {
      contexte.emettre('page', onglet);
      onglet.emettre('response', reponseSimulee(DU_SITE));
    }), options);
    assert.equal(r2.ok, true);
    assert.equal(r2.voie, 'nouvel onglet — réponse déjà reçue par l\'onglet');

    const page3 = pageSimulee();
    const r3 = await clicDocument.documentDuClic(page3, emetteur(), clicQui(() => page3.emettre('response', reponseSimulee(DU_SITE))), options);
    assert.equal(r3.ok, true);
    assert.equal(r3.voie, 'réponse PDF de la page');
  }
});

test('l\'hôte dit d\'une adresse refusée : jamais son chemin ni sa requête', () => {
  assert.equal(clicDocument.hoteDit('https://documents.exemple.invalid/a/b?jeton=x'), 'documents.exemple.invalid');
  assert.equal(clicDocument.hoteDit('blob:https://documents.exemple.invalid/0000-aaaa'), 'documents.exemple.invalid');
  assert.equal(clicDocument.hoteDit('data:application/pdf;base64,AAAA'), 'data:');
  assert.equal(clicDocument.hoteDit(''), 'adresse vide');
  assert.equal(clicDocument.hoteDit('n\'importe quoi'), 'adresse illisible');
});

test('aucun autre usager du socle ne passe l\'option : l\'Eau d\'Île-de-France (lot 102), Alma et Private Sport Shop (lot 104)', () => {
  const racine = path.join(__dirname, '..', 'server');
  const employeurs = [];
  const parcourir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const chemin = path.join(d, e.name);
      if (e.isDirectory()) parcourir(chemin);
      else if (e.name.endsWith('.js') && /adressePermise/.test(fs.readFileSync(chemin, 'utf8'))) {
        employeurs.push(path.relative(racine, chemin));
      }
    }
  };
  parcourir(racine);
  // Lot 104 : Alma et Private Sport Shop prennent leur document par le socle,
  // limités aux domaines de leur site — l'option telle qu'elle est.
  assert.deepEqual(employeurs.sort(), ['connectors/available/alma/connector.js', 'connectors/available/eau-ile-de-france/connector.js',
    'connectors/available/private-sport-shop/connector.js', 'connectors/clic-document.js']);
});
