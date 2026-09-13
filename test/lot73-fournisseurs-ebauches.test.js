'use strict';

/**
 * Lot 73 — trois fournisseurs SANS identifiants, en ébauche : Sepig,
 * Atlantic'eau (STGS), Mint Énergie.
 *
 * La reconnaissance s'est faite en visiteur anonyme uniquement
 * (reconnaissance anonyme du lot 73) : aucune n'a de liste de factures mesurée.
 * Ces tests figent l'HONNÊTETÉ des fiches :
 *
 *   1. les trois sont chargées depuis available/, en attente (pending), avec
 *      une connexion par fenêtre (remoteLogin) mais SANS verifyUrl
 *      (« sans-controle », mesuré tel quel) ;
 *   2. lancée, chaque ébauche ne récupère RIEN et le dit — jamais un « aucune
 *      nouvelle facture » muet, jamais une adresse de liste inventée ;
 *   3. Sepig est bien SORTI de l'annonce (planned/) et n'y est plus recréé par
 *      gen-planned.js, et la migration 52 le remet en attente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../server/connectors/registry');

const IDS = ['sepig', 'atlanticeau', 'mint-energie'];

test('les trois ébauches sont chargées : pending, remoteLogin sans verifyUrl (sans-controle)', () => {
  registry.load();
  for (const id of IDS) {
    const manifest = registry.manifest(id);
    assert.ok(manifest, `${id} doit être chargé depuis available/`);
    assert.equal(manifest.initialStatus, 'pending', `${id} : jamais exercé, il naît en attente`);
    assert.ok(manifest.remoteLogin && manifest.remoteLogin.url, `${id} : connexion par fenêtre`);
    assert.match(manifest.remoteLogin.url, /^https:\/\//);
    assert.ok(!manifest.remoteLogin.verifyUrl,
      `${id} : aucun renvoi d'anonyme discriminant mesuré — pas de verifyUrl (sans-controle)`);
    const session = manifest.fields.find((f) => f.type === 'session');
    assert.ok(session && session.required === false, `${id} : la capture a où s'enregistrer, non requise`);
    const module_ = registry.get(id).module;
    assert.equal(typeof module_.test, 'function');
    assert.equal(typeof module_.fetchInvoices, 'function');
    assert.match(manifest.technicalNote, /RELEVER/i, `${id} : la note dit ce qui reste à relever`);
    assert.match(manifest.technicalNote, /sans-controle/i, `${id} : la note dit « sans-controle »`);
  }
});

test('Sepig a quitté planned/ et n\'y est plus recréé par gen-planned.js', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server/connectors/planned/sepig')), false,
    'le dossier planned/sepig ne doit plus exister');
  const genPlanned = fs.readFileSync(path.join(__dirname, '..', 'scripts/gen-planned.js'), 'utf8');
  assert.equal(/id:\s*'sepig'/.test(genPlanned), false,
    'relancer gen-planned.js ne doit pas recréer l\'annonce SEPIG');
});

test('la migration 52 remet SEPIG en attente (le piège catalogue des annonces devenues connecteurs)', () => {
  const { MIGRATIONS } = require('../server/db/migrations');
  const m52 = MIGRATIONS.find((m) => m.id === 52);
  assert.ok(m52, 'la migration 52 doit exister');
  assert.match(m52.name, /SEPIG/i);
  // Elle repose une ligne de catalogue « available » (héritée de l'annonce) en
  // « pending », sans toucher une publication déjà approuvée.
  const appels = [];
  const db = {
    prepare: (sql) => { appels.push(sql); return { run: () => {} }; },
    exec: () => {},
  };
  // hasTable est interne : on simule la présence de la table via sqlite_master.
  db.prepare = (sql) => {
    appels.push(sql);
    return { get: () => (/sqlite_master/.test(sql) ? { name: 'connector_catalog' } : undefined), run: () => {} };
  };
  m52.up(db);
  const sqlUpdate = appels.find((s) => /UPDATE connector_catalog/i.test(s));
  assert.ok(sqlUpdate, 'la migration doit mettre à jour connector_catalog');
  assert.match(sqlUpdate, /status\s*=\s*'pending'/i);
  assert.match(sqlUpdate, /published_at IS NULL/i);
});

for (const id of IDS) {
  test(`${id} : lancée, l'ébauche REFUSE en le disant (jamais une liste vide sans preuve)`, async () => {
    // Lot 73-bis : le socle (lot 31) n'accepte « aucune nouvelle facture » que
    // preuve de liste à l'appui. Cette ébauche ne lit aucune liste : rendre
    // `{ invoices: [] }` ferait lever la garde du registre avec son message
    // générique (« relancez la récupération ») — faux ici. Elle échoue donc
    // explicitement, avec SON message, prêt pour l'écran.
    const connector = registry.get(id).module;
    const journal = [];
    const ctx = { userId: 1, log: (m) => journal.push(String(m)), knownRemoteIds: [] };
    await assert.rejects(
      () => connector.fetchInvoices({}, ctx),
      (err) => {
        assert.match(err.message, /pas encore écrite dans crabe/);
        assert.match(err.message, /première connexion d'un compte réel/);
        return true;
      }
    );
    assert.match(journal.join('\n'), /ébauche \(lot 73\)/);
    assert.match(journal.join('\n'), /Rien n'a été récupéré/);
  });
}
