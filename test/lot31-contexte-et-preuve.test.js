'use strict';

/**
 * Lot 31, phase A — les deux pannes qui ont bloqué la production le 13-14/08.
 *
 * ─── 1. Le contexte perdait l'utilisateur ────────────────────────────────────
 *
 * Le 13/08 à 23:55, materiel-net puis paybyphone ont échoué en production sur
 * « le contexte d'exécution ne porte pas l'utilisateur (ctx.userId) » — leur
 * profil de navigateur vit sous <dataDir>/profils-navigateur/<userId>/<id>,
 * introuvable sans userId. La mesure (run_logs, déclencheur `test`) a montré
 * que seul `testForUser` perdait l'utilisateur : il TIENT userId en paramètre
 * et appelait `test(connectorId, config)` sans le transmettre. Même défaut
 * dans `discoverForUser`. Les exécutions manuelle et planifiée, elles, le
 * transmettaient depuis le 12/08 (commit bbc4fc4).
 *
 * Ce fichier mesure LES QUATRE points d'entrée avec un connecteur-sonde qui
 * enregistre le contexte reçu : si l'un d'eux reperd l'utilisateur, un test
 * tombe en le nommant.
 *
 * ─── 2. « OK — Aucune nouvelle facture » sans preuve ─────────────────────────
 *
 * Le 14/08 à 00:01:51, six minutes après l'échec de contexte, materiel-net a
 * rendu « OK | Aucune nouvelle facture » en neuf secondes — sans avoir rien
 * ouvert. C'est le mode de panne le plus dangereux du produit : silencieux,
 * rassurant, et faux (même famille que les huit faux « connexion établie » du
 * lot 13).
 *
 * La règle, tenue dans `fetchInvoicesDetailed` parce que tous les chemins y
 * passent : une récupération sans AUCUN document téléchargé doit avoir déposé
 * `ctx.preuveDeListe({ session, liste, elements })` — le marqueur qui atteste
 * la session et la liste effectivement lue, fût-elle vide. Sinon : échec
 * explicite, jamais un succès à zéro document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot31';

/**
 * Le connecteur-sonde : il enregistre le contexte reçu dans
 * `globalThis.__lot31` (le registre vide `require.cache` au chargement, un
 * état de module serait perdu) et son comportement se pilote par la fiche —
 * champ `mode` — pour jouer les quatre issues qui nous intéressent.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    globalThis.__lot31.test = { userId: ctx.userId };
    return { ok: true, message: 'sonde' };
  },
  async discover(config, ctx) {
    globalThis.__lot31.discover = { userId: ctx.userId };
    return { items: [{ id: 'a', label: 'Ligne A' }] };
  },
  async fetchInvoices(config, ctx) {
    globalThis.__lot31.fetch = { userId: ctx.userId };
    const mode = config.mode || 'vide-sans-preuve';
    if (mode === 'vide-avec-preuve') {
      ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 0 });
      return { accountId: 'sonde', invoices: [] };
    }
    if (mode === 'demi-preuve') {
      // Il manque volontairement le marqueur de session.
      ctx.preuveDeListe?.({ liste: 'liste factice', elements: 0 });
      return [];
    }
    if (mode === 'document') {
      return [{ remoteId: 'd1', filename: 'sonde_2026-01.pdf', issuedOn: '2026-01-05',
                buffer: Buffer.from('%PDF-1.4 sonde') }];
    }
    return { accountId: 'sonde', invoices: [] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 31',
  category: 'energie',
  color: '#123456',
  letters: 'SL',
  description: 'Sonde de test du lot 31 : elle enregistre le contexte reçu.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'mode', label: 'Mode de la sonde', type: 'text', required: false },
    { key: 'lignes', label: 'Lignes', type: 'multiselect', required: false },
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

/** Reconfigure la sonde et relance une récupération manuelle. */
async function executer(mode, trigger = 'manual') {
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', mode });
  return scheduler.runForUser(user.id, ID_SONDE, trigger);
}

/** La dernière ligne de run_logs de la sonde. */
function derniereLigne() {
  return db
    .get()
    .prepare(
      `SELECT trigger, success, invoice_count, message FROM run_logs
        WHERE connector_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE, user.id);
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot31', role: 'admin' });

  globalThis.__lot31 = {};
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot31-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  assert.equal(charge.loaded, 1);

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot31;
  registry.load(); // on remet le vrai registre pour ne rien laisser derrière
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. Le contexte porte l'utilisateur — les quatre points d'entrée
// ---------------------------------------------------------------------------

test('le test de connexion porte l\'utilisateur (le point d\'entrée en panne le 13/08)', async () => {
  globalThis.__lot31.test = null;
  const resultat = await registry.testForUser(user.id, ID_SONDE);
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(
    globalThis.__lot31.test?.userId,
    user.id,
    'testForUser tient userId en paramètre et doit le transmettre au contexte — '
      + 'sans lui, tout connecteur à profil de navigateur persistant échoue'
  );
});

test('l\'exécution manuelle porte l\'utilisateur', async () => {
  globalThis.__lot31.fetch = null;
  const resultat = await executer('vide-avec-preuve', 'manual');
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(globalThis.__lot31.fetch?.userId, user.id);
});

test('l\'exécution planifiée porte l\'utilisateur', async () => {
  globalThis.__lot31.fetch = null;
  const resultat = await executer('vide-avec-preuve', 'cron');
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(globalThis.__lot31.fetch?.userId, user.id);
  assert.equal(derniereLigne().trigger, 'cron', 'la ligne de journal doit venir du planificateur');
});

test('la découverte porte l\'utilisateur', async () => {
  globalThis.__lot31.discover = null;
  const resultat = await registry.discoverForUser(user.id, ID_SONDE);
  assert.ok(resultat.items.length >= 1);
  assert.equal(globalThis.__lot31.discover?.userId, user.id);
});

// ---------------------------------------------------------------------------
// 2. « Aucune nouvelle facture » exige une preuve
// ---------------------------------------------------------------------------

test('zéro document SANS preuve : échec explicite, jamais « Aucune nouvelle facture »', async () => {
  const resultat = await executer('vide-sans-preuve');

  assert.equal(resultat.ok, false, 'un tableau vide sans preuve ne peut pas être un succès');
  assert.notEqual(resultat.message, 'Aucune nouvelle facture');
  assert.match(
    resultat.message,
    /liste des documents/,
    'le message doit dire ce qui n\'a pas pu être fait'
  );
  assert.match(resultat.message, /relancez/i, 'le message doit dire quoi faire');

  const ligne = derniereLigne();
  assert.equal(ligne.success, 0, 'run_logs doit porter un échec, pas un succès à zéro document');

  const install = registry.getInstall(user.id, ID_SONDE);
  assert.ok(install.last_error, 'la fiche doit montrer l\'échec à l\'utilisateur');
});

test('zéro document AVEC preuve : le succès honnête reste possible', async () => {
  const resultat = await executer('vide-avec-preuve');
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(resultat.message, 'Aucune nouvelle facture');
  assert.equal(derniereLigne().success, 1);
});

test('une DEMI-preuve (sans marqueur de session) ne compte pas', async () => {
  const resultat = await executer('demi-preuve');
  assert.equal(
    resultat.ok,
    false,
    'liste sans marqueur de session : le lot 13 a montré qu\'une session non prouvée ment'
  );
});

test('un document téléchargé est sa propre preuve', async () => {
  const config = registry.readConfig(user.id, ID_SONDE);
  const resultat = await registry.fetchInvoicesDetailed(
    ID_SONDE,
    { ...config, mode: 'document' },
    { userId: user.id }
  );
  assert.equal(resultat.invoices.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Le balayage du disque — tout connecteur doit y passer
// ---------------------------------------------------------------------------
//
// La garde du registre protège l'utilisateur : sans preuve, échec explicite.
// Mais un connecteur qui NE dépose JAMAIS de preuve transformerait chaque
// passage tranquille (« tout est déjà récupéré ») en fausse alerte. Ce
// balayage attrape donc le connecteur oublié — celui d'aujourd'hui comme
// celui qu'on écrira demain sur un mauvais gabarit.

test('tout fetchInvoices du disque dépose une preuve de liste, ou délègue à qui le fait', () => {
  const fautifs = [];
  let porteurs = 0;

  for (const entree of fs.readdirSync(registry.AVAILABLE_DIR, { withFileTypes: true })) {
    if (!entree.isDirectory()) continue;
    const fichier = path.join(registry.AVAILABLE_DIR, entree.name, 'connector.js');
    // Pas de connector.js : un manifeste sur implémentation partagée, couverte
    // par le fichier de l'implémentation elle-même.
    if (!fs.existsSync(fichier)) continue;

    const source = fs.readFileSync(fichier, 'utf8');
    if (source.includes('preuveDeListe')) {
      porteurs++;
      continue;
    }
    // Les recettes délèguent leur fetchInvoices à scraping.js, qui dépose.
    if (source.includes('makeScrapingConnector')) continue;
    fautifs.push(entree.name);
  }

  assert.deepEqual(
    fautifs,
    [],
    'ces connecteurs peuvent encore conclure « aucune nouvelle facture » sans avoir '
      + 'prouvé l\'accès à la liste des documents : ajoutez ctx.preuveDeListe({ session, '
      + 'liste, elements }) au point où la liste est réellement lue'
  );
  assert.ok(
    porteurs >= 15,
    `le balayage ne trouve que ${porteurs} porteur(s) de preuve : il ne regarde pas au bon endroit`
  );

  const scraping = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'scraping.js'),
    'utf8'
  );
  assert.ok(
    (scraping.match(/preuveDeListe/g) || []).length >= 2,
    'scraping.js doit déposer la preuve sur ses DEUX chemins — réel et simulé'
  );
});

test('un appelant ne peut pas fournir sa propre preuve par le contexte', async () => {
  // Le recorder du registre est posé APRÈS la recopie du contexte appelant :
  // la preuve se constate depuis le connecteur, elle ne s'injecte pas.
  const config = registry.readConfig(user.id, ID_SONDE);
  let interceptee = false;
  await assert.rejects(
    () =>
      registry.fetchInvoicesDetailed(
        ID_SONDE,
        { ...config, mode: 'vide-sans-preuve' },
        {
          userId: user.id,
          preuveDeListe: () => {
            interceptee = true;
          },
        }
      ),
    /liste des documents/
  );
  assert.equal(interceptee, false, 'le faux enregistreur de l\'appelant ne doit jamais être appelé');
});
