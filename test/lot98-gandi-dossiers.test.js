'use strict';

/**
 * Lot 98 — R1 : un dépôt Gandi va dans le dossier au NOM de son organisation.
 *
 * Par le VRAI planificateur, au vrai Chromium, sur le banc Gandi des lots 93
 * à 95 (pages reconstituées, réseau coupé — aucune requête ne sort), vers deux
 * stockages d'essai : le stockage local dans un dossier temporaire, et un cloud joué
 * par un faux rclone sur un dossier local (test/lot98-faux-rclone.js).
 *
 * Verrouillé ici : le dossier nommé sur les DEUX stockages, `account_id`
 * inchangé ; un nom à `/`, `:` ou point final rendu sûr ; deux homonymes,
 * deux dossiers ; sans nom, l'identifiant comme avant, dit au journal sous sa
 * forme ; et deux autres connecteurs — Infomaniak et Free Mobile, qui
 * découvrent eux aussi des comptes nommés — déposent à l'octet comme avant.
 *
 * ⚠ Valeurs inventées : identifiants faits de zéros, noms « Organisation
 * d'essai … », numéros « ZZ… ».
 */

const faux98 = require('./lot98-faux-rclone').installer();

process.env.CRABE_COPIE_DELAI_MS = '0';

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const paths = require('../server/destinations/paths');
const dossierParNom = require('../server/dossier-par-nom');
const faux = require('./lot93-faux-sites');

const HOTES = [faux.GANDI_ADMIN, faux.GANDI_ID];
/** L'identifiant du stockage local, la copie de référence — le seul nommé ici. */
const LOCAL = 'local';
const ORG = (n) => faux.idOrganisation(n);
const instanceDuRegistre = () => registry.get('gandi').module;

let cloud;
let enLigneScraping;
let lancementReel;

test.before(async () => {
  await helpers.setup();
  destinations.restoreLocal();
  cloud = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud d\'essai' });
  const configuration = require('../server/config').config;
  enLigneScraping = configuration.scrapingDisabled;
  configuration.scrapingDisabled = false;
  lancementReel = instanceDuRegistre().ouverture.lancer;
  instanceDuRegistre().ouverture.lancer = () => {
    throw new Error('essai : lancement d\'un vrai navigateur interdit — le faux site n\'a pas été branché');
  };
});

test.after(() => {
  require('../server/config').config.scrapingDisabled = enLigneScraping;
  instanceDuRegistre().ouverture.lancer = lancementReel;
  helpers.teardown();
  faux98.nettoyer();
});

async function compteAvecGandi(nom) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, 'gandi');
  registry.saveConfig(user.id, 'gandi', { session: faux.sessionInventee() }, { origine: 'fenetre' });
  return user;
}

/** Un passage par `runForUser`, sur le faux site ; le faux navigateur seul, rien ne sort. */
async function parLePlanificateur(user, etat) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandi(etat));
  const instance = instanceDuRegistre();
  const original = instance.ouverture.lancer;
  instance.ouverture.lancer = banc.lancer;
  try {
    const r = await scheduler.runForUser(user.id, 'gandi', 'manual');
    assert.ok(banc.lancements() >= 1, `le planificateur a ouvert le FAUX navigateur (${r.message})`);
    assert.deepEqual(banc.journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
    return r;
  } finally {
    instance.ouverture.lancer = original;
    await banc.fermer();
  }
}

/** Un compte d'essai réduit : quelques factures par organisation suffisent. */
function compteReduit(noms, combien = [2, 1, 2]) {
  const etat = faux.compteGandiDEssai();
  etat.organisations.forEach((o, i) => {
    o.nom = noms[i];
    o.factures = faux.facturesInventees(String.fromCharCode(65 + i), combien[i]);
  });
  return etat;
}

function lignes(user) {
  return db.get().prepare('SELECT id, account_id, filename, size_bytes, destinations FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id')
    .all(user.id, 'gandi');
}

/** Le dossier de compte de chaque copie d'une ligne, et le fichier présent de la bonne taille. */
function dossiersDe(user, ligne) {
  const d = JSON.parse(ligne.destinations);
  const ctx = { username: user.username, connectorName: 'Gandi' };
  assert.equal(d[LOCAL]?.ok, true, 'copie du stockage local');
  assert.equal(d[cloud]?.ok, true, 'copie cloud');
  assert.equal(fs.statSync(d[LOCAL].path).size, ligne.size_bytes, 'le fichier du stockage local est là');
  assert.equal(fs.statSync(faux98.local(d[cloud].path)).size, ligne.size_bytes, 'le fichier du cloud est là');
  const e = dossierParNom.dossierDuChemin(d[LOCAL].path, ctx).dossier;
  const c = dossierParNom.dossierDuChemin(d[cloud].path, ctx).dossier;
  assert.equal(e, c, 'le même dossier sur les deux stockages');
  return e;
}

function journal() {
  return db.get().prepare("SELECT message FROM app_logs WHERE source = 'scheduler' ORDER BY id").all().map((l) => l.message).join('\n');
}

test('un nouveau dépôt va dans le dossier au NOM de son organisation, sur les deux stockages ; account_id reste l\'identifiant', faux.SANS_NAVIGATEUR, async () => {
  const user = await compteAvecGandi('lot98d1');
  const r = await parLePlanificateur(user, compteReduit(['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C']));
  assert.equal(r.ok, true, r.message);
  const ls = lignes(user);
  assert.equal(ls.length, 5);
  const parOrg = new Map();
  for (const l of ls) parOrg.set(l.account_id, dossiersDe(user, l));
  assert.deepEqual(Object.fromEntries(parOrg), {
    [ORG(1)]: 'Organisation d\'essai A',
    [ORG(2)]: 'Organisation d\'essai B',
    [ORG(3)]: 'Organisation d\'essai C',
  });
  for (const l of ls) {
    for (const n of [1, 2, 3]) assert.ok(!l.destinations.includes(ORG(n)), 'aucun identifiant dans un chemin de dépôt');
  }
  // Rien à l'identifiant sur les stockages.
  const gandiE = paths.localPath(destinations.readConfig(LOCAL).path, { username: user.username, connectorName: 'Gandi', accountId: 'x', filename: 'x' })
    .split('/x/')[0];
  assert.deepEqual(fs.readdirSync(gandiE).sort(), ['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C']);
  // Le journal dit la règle, sous sa forme : ni nom, ni identifiant.
  const j = journal();
  assert.match(j, /gandi \(lot98d1\) : dossiers de dépôt : au nom — 3 organisations, 5 document\(s\)\./);
  assert.doesNotMatch(j, /Organisation d'essai/);
  assert.doesNotMatch(j, /00000000-0000-4000-8000/);

  // Le passage suivant ne redépose rien, et ne crée aucun autre dossier.
  const suite = await parLePlanificateur(user, compteReduit(['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C']));
  assert.match(suite.message, /^Aucune nouvelle facture/);
  assert.equal(lignes(user).length, 5);
  assert.equal(fs.readdirSync(gandiE).length, 3);
});

test('un nom à « / », « : » ou point final devient un dossier sûr ; les accents restent', faux.SANS_NAVIGATEUR, async () => {
  const user = await compteAvecGandi('lot98d2');
  const r = await parLePlanificateur(user, compteReduit(['Société / Essai : Sud.', 'Atelier\\Nord', 'Fin de phrase...'], [1, 1, 1]));
  assert.equal(r.ok, true, r.message);
  const dossiers = Object.fromEntries(lignes(user).map((l) => [l.account_id, dossiersDe(user, l)]));
  assert.deepEqual(dossiers, {
    [ORG(1)]: 'Société _ Essai _ Sud',
    [ORG(2)]: 'Atelier_Nord',
    [ORG(3)]: 'Fin de phrase',
  });
});

test('deux organisations du même nom : deux dossiers distincts, au suffixe de « Mes documents »', faux.SANS_NAVIGATEUR, async () => {
  const user = await compteAvecGandi('lot98d3');
  const r = await parLePlanificateur(user, compteReduit(['Organisation d\'essai A', 'Organisation jumelle', 'Organisation jumelle']));
  assert.equal(r.ok, true, r.message);
  const dossiers = Object.fromEntries(lignes(user).map((l) => [l.account_id, dossiersDe(user, l)]));
  assert.deepEqual(dossiers, {
    [ORG(1)]: 'Organisation d\'essai A',
    [ORG(2)]: 'Organisation jumelle (…0002)',
    [ORG(3)]: 'Organisation jumelle (…0003)',
  });
  assert.match(journal(), /gandi \(lot98d3\) : dossiers de dépôt : au nom — 1 organisation, 2 document\(s\) ; au nom suivi de la fin de l'identifiant \(homonymes\) — 2 organisations, 3 document\(s\)\./);
});

test('une organisation sans nom garde son identifiant, comme avant — et c\'est dit au journal, sous sa forme', faux.SANS_NAVIGATEUR, async () => {
  const user = await compteAvecGandi('lot98d4');
  const r = await parLePlanificateur(user, compteReduit(['Organisation d\'essai A', '', 'Organisation d\'essai C']));
  assert.equal(r.ok, true, r.message);
  const dossiers = Object.fromEntries(lignes(user).map((l) => [l.account_id, dossiersDe(user, l)]));
  assert.deepEqual(dossiers, {
    [ORG(1)]: 'Organisation d\'essai A',
    [ORG(2)]: ORG(2),
    [ORG(3)]: 'Organisation d\'essai C',
  });
  const j = journal();
  assert.match(j, /gandi \(lot98d4\) : dossiers de dépôt : au nom — 2 organisations, 4 document\(s\) ; à l'identifiant, comme avant \(aucun nom connu\) — 1 organisation, 1 document\(s\)\./);
  // La fiche, elle, n'a pas changé : « Organisation sans nom ».
  const resume = registry.configSummary(user.id, 'gandi').discoveries.organisations;
  assert.equal(resume.items.find((i) => i.id === ORG(2)).label, 'Organisation sans nom');
});

test('une organisation renommée chez Gandi GARDE son dossier : rien n\'est dispersé, et c\'est dit au journal', faux.SANS_NAVIGATEUR, async () => {
  const user = await compteAvecGandi('lot98d6');
  let r = await parLePlanificateur(user, compteReduit(['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C'], [1, 1, 1]));
  assert.equal(r.ok, true, r.message);
  // Plus tard : l'organisation 1 a changé de nom, et une facture neuve est arrivée.
  const plusTard = compteReduit(['Nouveau nom de A', 'Organisation d\'essai B', 'Organisation d\'essai C'], [2, 1, 1]);
  r = await parLePlanificateur(user, plusTard);
  assert.equal(r.ok, true, r.message);
  const deA = lignes(user).filter((l) => l.account_id === ORG(1));
  assert.equal(deA.length, 2);
  for (const l of deA) assert.equal(dossiersDe(user, l), 'Organisation d\'essai A', 'la facture neuve rejoint le dossier déjà employé');
  const j = journal();
  assert.match(j, /gandi \(lot98d6\) : dossiers de dépôt : dans le dossier déjà employé, gardé — le nom ne le donnerait plus : rien n'est dispersé — 1 organisation, 1 document\(s\)\./);
  assert.doesNotMatch(j, /Nouveau nom de A/);
});

test('un nom introuvable — aucune découverte — garde l\'identifiant ; un connecteur qui ne nomme pas ses comptes n\'est pas concerné', async () => {
  const user = await compteAvecGandi('lot98d5');
  const passage = dossierParNom.pourLePassage(user.id, 'gandi', { username: user.username, connectorName: 'Gandi' });
  assert.deepEqual(passage.dossier(ORG(7)), { dossier: ORG(7), regle: 'identifiant', raison: 'absent de la découverte' });
  assert.match(passage.bilan(), /à l'identifiant, comme avant \(absent de la découverte\) — 1 organisation, 1 document\(s\)/);
  for (const autre of ['infomaniak', 'free-mobile', 'edf', 'amazon']) {
    assert.equal(dossierParNom.pourLePassage(user.id, autre, { username: user.username, connectorName: autre }), null, autre);
  }
});

// ---------------------------------------------------------------------------
// Deux autres connecteurs : à l'octet, comme avant
// ---------------------------------------------------------------------------

test.describe('deux autres connecteurs, qui découvrent eux aussi des comptes NOMMÉS', () => {
  const vraiFetch = registry.fetchInvoicesDetailed;
  test.after(() => {
    registry.fetchInvoicesDetailed = vraiFetch;
  });

  const CAS = [
    {
      id: 'infomaniak',
      champ: 'organisations',
      elements: [{ id: '900001', label: 'Entreprise d\'essai Un' }, { id: '900002', label: 'Entreprise d\'essai Deux' }],
      factures: [
        { accountId: '900001', filename: 'infomaniak_2026-03_ZZ1.pdf', issuedOn: '2026-03-04' },
        { accountId: '900002', filename: 'infomaniak_2025-11_ZZ2.pdf', issuedOn: '2025-11-02' },
      ],
    },
    {
      id: 'free-mobile',
      champ: 'lignes',
      elements: [{ id: '0600000001', label: 'Camille Essai' }, { id: '0600000002', label: 'Camille Essai' }],
      factures: [
        { accountId: '0600000001', filename: 'free-mobile_2026-02_ZZ3.pdf', issuedOn: '2026-02-01' },
        { accountId: '0600000002', filename: 'free-mobile_2026-01_ZZ4.pdf', issuedOn: '2026-01-01' },
      ],
    },
  ];

  for (const cas of CAS) {
    test(`${cas.id} : le dossier reste l'identifiant, chemin et contenu à l'octet de la règle d'avant`, async () => {
      const user = await helpers.createUser({ username: `lot98-${cas.id}`, role: 'admin' });
      registry.install(user.id, cas.id);
      registry.saveConfig(user.id, cas.id, { session: faux.sessionInventee() }, { origine: 'fenetre' });
      const contenus = new Map(cas.factures.map((f, i) => [f.filename, Buffer.from(`%PDF-1.4 essai ${cas.id} ${i}`)]));
      registry.fetchInvoicesDetailed = async (id, config, ctx) => {
        ctx.reconcile(cas.champ, cas.elements);
        return {
          accountId: cas.factures[0].accountId,
          invoices: cas.factures.map((f) => ({ ...f, remoteId: `ref-${f.filename}`, buffer: contenus.get(f.filename) })),
        };
      };
      const r = await scheduler.runForUser(user.id, cas.id, 'manual');
      registry.fetchInvoicesDetailed = vraiFetch;
      assert.equal(r.ok, true, r.message);

      const connectorName = registry.manifest(cas.id).name;
      const racine = destinations.readConfig(LOCAL).path;
      const rangees = db.get().prepare('SELECT account_id, filename, issued_on, destinations FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id')
        .all(user.id, cas.id);
      assert.equal(rangees.length, 2);
      for (const l of rangees) {
        const parts = { username: user.username, connectorName, accountId: l.account_id, issuedOn: l.issued_on, filename: l.filename };
        const d = JSON.parse(l.destinations);
        // La règle d'avant le lot, recalculée : le chemin enregistré lui est égal À L'OCTET.
        assert.equal(d[LOCAL].path, paths.localPath(racine, parts));
        assert.equal(d[cloud].path, `pcloud:crabe/${paths.relativePath(parts)}`);
        assert.ok(d[LOCAL].path.includes(`/${l.account_id}/`), 'le dossier est l\'identifiant');
        assert.ok(fs.readFileSync(d[LOCAL].path).equals(contenus.get(l.filename)));
        assert.ok(fs.readFileSync(faux98.local(d[cloud].path)).equals(contenus.get(l.filename)));
      }
      assert.doesNotMatch(journal(), new RegExp(`${cas.id} \\(lot98-${cas.id}\\) : dossiers de dépôt`), 'aucune décision de dossier pour lui');
    });
  }
});
