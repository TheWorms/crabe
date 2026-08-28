'use strict';

/**
 * « Récupérer tout l'historique » — le rattrapage en un geste (lot 32).
 *
 * ─── Ce que ces tests verrouillent ───────────────────────────────────────────
 *
 * La nuit du 13/08/2026, l'entretien a supprimé 149 documents à cause d'un
 * défaut du plancher de conservation, corrigé depuis. Mais le rattrapage ne se
 * faisait pas tout seul : chaque connecteur garde son réglage « depuis la
 * dernière récupération », et rattraper supposait de changer « Historique » en
 * « Toutes les années disponibles », lancer, puis remettre le réglage — trois
 * gestes techniques, inacceptables pour un public non technique.
 *
 * L'action tient quatre promesses, chacune testée ici :
 *
 *   1. le réglage « Historique » de l'utilisateur n'est JAMAIS modifié — la
 *      surcharge ne vit que le temps d'une exécution ;
 *   2. un document déjà rangé n'est pas re-téléchargé (`remote_id` fait foi) ;
 *   3. les documents rattrapés sont protégés par le plancher de conservation :
 *      l'entretien suivant ne les balaie pas — c'est LE point qui a coûté 149
 *      documents ;
 *   4. tant qu'un plancher est posé, la récupération n'est pas plafonnée
 *      (`fetchCapMonths` = 0) : le rattrapage peut remonter loin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const retention = require('../server/retention');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot32';

/**
 * Le connecteur-sonde : il enregistre la profondeur d'historique reçue et ne
 * « trouve » son vieux document de 2020 que lors d'un passage complet — comme
 * un vrai service dont l'ancien n'apparaît qu'en remontant tout l'historique.
 * Il honore `ctx.knownRemoteIds`, comme tout connecteur réel.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    return { ok: true, message: 'sonde' };
  },
  async fetchInvoices(config, ctx) {
    globalThis.__lot32.passes.push({ historique: config.historique || null });
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 1 });
    const connus = new Set(ctx.knownRemoteIds || []);
    // Depuis le lot 33, « tout l'historique a été parcouru » exige que le
    // connecteur l'ATTESTE : la sonde le fait quand elle a réellement tout vu.
    const couverture = config.historique === 'tout'
      ? { complete: true, detail: 'passage complet de la sonde' }
      : null;
    if (config.historique !== 'tout') return { invoices: [], couverture };
    if (connus.has('ancienne-2020')) return { invoices: [], couverture };
    return { couverture, invoices: [{
      remoteId: 'ancienne-2020',
      filename: 'sonde_2020-05_ancienne.pdf',
      issuedOn: '2020-05-01',
      buffer: Buffer.from('%PDF-1.4 sonde rattrapage'),
    }] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 32',
  category: 'energie',
  color: '#654321',
  letters: 'SR',
  description: 'Sonde de test du lot 32 : elle mesure la profondeur d\'historique reçue.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    {
      key: 'historique',
      label: 'Historique à récupérer',
      type: 'history',
      default: 'depuis',
      help: 'Profondeur d\'historique de la sonde.',
    },
  ],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot32', role: 'admin' });

  globalThis.__lot32 = { passes: [] };
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot32-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  // Le réglage VOLONTAIRE de l'utilisateur : « année en cours seulement ».
  // C'est lui qui doit ressortir intact de chaque rattrapage.
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', historique: 'courante' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot32;
  registry.load();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. La surcharge ne vit qu'une exécution — le réglage ressort intact
// ---------------------------------------------------------------------------

test('sans rattrapage, la profondeur reçue est celle du réglage enregistré', async () => {
  globalThis.__lot32.passes = [];
  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.ok, true, resultat.message);
  assert.deepEqual(globalThis.__lot32.passes, [{ historique: 'courante' }]);
});

test('le rattrapage impose « tout » pour UNE exécution, sans toucher au réglage', async () => {
  globalThis.__lot32.passes = [];
  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual', {
    toutLHistorique: true,
  });

  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(resultat.count, 1, 'le vieux document de 2020 doit descendre');
  // Le journal dit qu'il s'agissait d'un passage complet : « Aucune nouvelle
  // facture » tout court laisserait croire que le rattrapage n'a pas eu lieu.
  assert.match(resultat.message, /tout l'historique disponible a été parcouru/);
  assert.deepEqual(globalThis.__lot32.passes, [{ historique: 'tout' }]);

  // LA promesse : le réglage enregistré n'a pas bougé.
  assert.equal(registry.readConfig(user.id, ID_SONDE).historique, 'courante');

  // Et l'exécution suivante, ordinaire, repart bien du réglage de l'utilisateur.
  globalThis.__lot32.passes = [];
  await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.deepEqual(globalThis.__lot32.passes, [{ historique: 'courante' }]);
});

test('un document déjà rattrapé n\'est jamais re-téléchargé', async () => {
  // Le connecteur reçoit les identifiants déjà connus et rend une liste vide :
  // le second rattrapage conclut « aucune nouvelle facture », honnêtement.
  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual', {
    toutLHistorique: true,
  });
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(resultat.count, 0);
  assert.match(resultat.message, /Aucune nouvelle facture — tout l'historique disponible/);

  const lignes = db
    .get()
    .prepare('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ? AND connector_id = ?')
    .get(user.id, ID_SONDE);
  assert.equal(lignes.n, 1, 'une seule ligne pour le document de 2020, pas un doublon');
});

// ---------------------------------------------------------------------------
// 2. Le plancher de conservation protège ce qui redescend
// ---------------------------------------------------------------------------

test('l\'entretien suivant ne balaie pas les documents rattrapés — le plancher les protège', () => {
  // Le document de 2020 vient d'être récupéré AUJOURD'HUI. L'utilisateur passe
  // (ou a passé) sa conservation à « 1 an » : le plancher se pose à cet
  // instant, et tout document DÉJÀ plus vieux que la fenêtre à ce moment-là
  // est « les précédents » — protégé pour toujours, par sa date de DOCUMENT,
  // pas par sa date de récupération. C'est la correction du lot 26 : sans
  // elle, 149 documents rattrapés ont été effacés la nuit du 13/08.
  retention.setMonths(12);
  const { floor } = retention.policy();
  assert.ok(floor, 'réduire la conservation pose un plancher');

  const condamnes = retention.expired();
  assert.equal(
    condamnes.some((r) => r.connector_id === ID_SONDE),
    false,
    'le document de 2020, rattrapé aujourd\'hui, ne doit PAS être sur la liste du nettoyage'
  );

  // La preuve que c'est bien le plancher qui protège : sans lui, le même
  // document serait condamné.
  const sansPlancher = retention.expired({ ignoreFloor: true });
  assert.equal(
    sansPlancher.some((r) => r.connector_id === ID_SONDE),
    true,
    'plancher ignoré, le document de 2020 dépasse la fenêtre d\'un an — le test doit mordre'
  );

  // Et tant que le plancher tient, la récupération n'est pas plafonnée : le
  // rattrapage a le droit de remonter loin, puisque rien ne sera effacé.
  assert.equal(retention.fetchCapMonths(), 0);

  // On rend le réglage : les autres fichiers de test partent de « tout garder ».
  retention.setMonths(0);
});

// ---------------------------------------------------------------------------
// 3. Le geste existe dans l'interface, dit ce qu'il fait, sans jargon
// ---------------------------------------------------------------------------

test('la fiche porte l\'action, la confirmation dit le contrat, la route est branchée', () => {
  const front = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

  assert.ok(front.includes('Récupérer tout l\'historique'), 'le bouton doit exister');
  assert.ok(front.includes('run-historique-complet'), 'le bouton doit appeler la route du rattrapage');

  // Le texte de la confirmation est éclaté sur plusieurs chaînes concaténées,
  // apostrophes échappées : on recolle puis on déséchappe, comme le fera
  // l'écran, avant de lire les promesses.
  const recolle = front.replace(/'\s*\+\s*'/g, '').replace(/\\'/g, '\'');
  assert.ok(/n'est pas re-téléchargé/.test(recolle), 'la confirmation doit promettre l\'absence de doublons');
  assert.ok(/rien n'est supprimé/.test(recolle),
    'la confirmation doit promettre qu\'on ne supprime rien');
  assert.ok(/réglage « Historique » reste tel quel/.test(recolle),
    'la confirmation doit promettre que le réglage ne bouge pas');
  assert.ok(/prendre plusieurs minutes/.test(recolle), 'la confirmation doit prévenir de la durée');
  // Écrit pour un public non technique : pas de « fetch », pas de « backfill ».
  const debut = recolle.indexOf('async function runConnectorHistorique');
  const confirmation = recolle.slice(debut, debut + 2200);
  assert.ok(!/backfill/i.test(confirmation), 'aucun jargon « backfill » dans le geste');

  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'connectors.js'),
    'utf8'
  );
  assert.ok(routes.includes('/:id/run-historique-complet'), 'la route doit exister côté serveur');
  assert.ok(routes.includes('toutLHistorique: true'), 'la route doit demander le passage complet');
});
