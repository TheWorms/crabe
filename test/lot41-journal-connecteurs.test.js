'use strict';

/**
 * Lot 41 — le journal des connecteurs va en base, et « Aucune nouvelle
 * facture » cesse de ressembler à une panne.
 *
 * ─── 1. Les lignes `[connector]` n'existaient que dans journalctl ────────────
 *
 * Le 19/08/2026 au soir, une soirée entière de diagnostic a été perdue : tout
 * ce que les connecteurs disaient d'eux-mêmes (`ctx.log`) partait sur la seule
 * sortie standard — ni en base, ni dans « Logs → Connecteurs ». Le run Deezer
 * de 18:09:51 n'a laissé AUCUNE trace nulle part. Ces tests mesurent, avec un
 * connecteur-sonde, que chaque ligne du journal arrive en base (source
 * `connector:<id>`, compte de l'utilisateur, texte INTACT) et que l'écran la
 * reçoit, entremêlée aux exécutions.
 *
 * ─── 2. « Aucune nouvelle facture » recouvrait deux réalités ─────────────────
 *
 * « Tout était déjà récupéré » (légitime) et « ce service ne fournit aucun
 * document téléchargeable » (qui ressemblait à une panne). Le connecteur qui
 * SAIT que la liste ne propose rien le déclare (`aucunDocument`) : sa phrase
 * remplace le message générique — et elle est ignorée dès qu'un document est
 * réellement descendu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const applog = require('../server/applog');
const permissions = require('../server/permissions');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot41';

const PHRASE_AUCUN_DOCUMENT =
  'Ce service ne délivre pas de facture téléchargeable — 26 paiements listés, '
  + 'aucun document proposé.';

/**
 * Le connecteur-sonde : il journalise comme les vrais (via `ctx.log`), dépose
 * sa preuve de liste, et son issue se pilote par la fiche (champ `mode`).
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    return { ok: true, message: 'sonde' };
  },
  async fetchInvoices(config, ctx) {
    const mode = config.mode || 'deja-recupere';
    ctx.log(\`sonde-lot41 : première ligne du journal (\${mode})\`);
    ctx.log('sonde-lot41 :', 'plusieurs', 'morceaux');
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 26 });
    if (mode === 'aucun-document') {
      return { invoices: [], aucunDocument: ${JSON.stringify(PHRASE_AUCUN_DOCUMENT)} };
    }
    if (mode === 'document-malgre-declaration') {
      return {
        invoices: [{ remoteId: 'd1', filename: 'sonde-lot41_2026-01_d1.pdf',
                     issuedOn: '2026-01-05', buffer: Buffer.from('%PDF-1.4 sonde') }],
        aucunDocument: 'ne doit jamais s\\'afficher : un document est descendu',
      };
    }
    return { invoices: [] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 41',
  category: 'energie',
  color: '#654321',
  letters: 'SJ',
  description: 'Sonde de test du lot 41 : elle journalise et déclare ses issues.',
  fields: [
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'mode', label: 'Mode de la sonde', type: 'text', required: false },
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
async function executer(mode) {
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', mode });
  return scheduler.runForUser(user.id, ID_SONDE, 'manual');
}

/** Les lignes de journal de la sonde, en base, de la plus ancienne à la plus récente. */
function lignesEnBase() {
  return db
    .get()
    .prepare('SELECT level, source, message, user_id FROM app_logs WHERE source = ? ORDER BY id')
    .all(`${applog.SOURCE_CONNECTEUR}:${ID_SONDE}`);
}

function purgerJournal() {
  db.get().prepare('DELETE FROM app_logs').run();
}

/** La dernière ligne d'exécution de la sonde. */
function derniereExecution() {
  return db
    .get()
    .prepare(
      `SELECT success, invoice_count, message FROM run_logs
        WHERE connector_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE, user.id);
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({
    username: 'lot41',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, user.id);

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot41-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  registry.load(); // on remet le vrai registre pour ne rien laisser derrière
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// 1. Le journal du connecteur va en base
// ---------------------------------------------------------------------------

test('ce qu\'un connecteur journalise arrive en base — source, compte, texte intact', async () => {
  purgerJournal();
  const resultat = await executer('deja-recupere');
  assert.equal(resultat.ok, true, resultat.message);

  const lignes = lignesEnBase();
  // Deux lignes de la sonde + celle du socle (« liste des documents
  // confirmée », écrite par fetchInvoicesDetailed après la preuve).
  assert.ok(lignes.length >= 3, `${lignes.length} ligne(s) en base — le journal n'y va pas`);

  const premiere = lignes.find((l) => l.message.includes('première ligne du journal'));
  assert.ok(premiere, 'la ligne du connecteur doit exister en base');
  // Le TEXTE est celui d'avant, à l'octet près : ni préfixe, ni troncature.
  assert.equal(premiere.message, 'sonde-lot41 : première ligne du journal (deja-recupere)');
  assert.equal(premiere.level, 'info');
  assert.equal(premiere.source, `connector:${ID_SONDE}`);
  assert.equal(premiere.user_id, user.id, 'la ligne porte le compte pour qui le connecteur travaillait');

  // Plusieurs arguments se formatent comme console.log l'aurait fait.
  assert.ok(
    lignes.some((l) => l.message === 'sonde-lot41 : plusieurs morceaux'),
    'un appel multi-arguments garde le texte que console.log aurait produit'
  );
});

test('l\'écran « Logs → Connecteurs » reçoit le journal, attribué à son service', async (t) => {
  purgerJournal();
  await executer('deja-recupere');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'lot41', 'MotDePasse1');

  const tout = await client.get('/api/admin/logs/runs?connector=all&result=all&q=');
  assert.equal(tout.status, 200);
  assert.ok(Array.isArray(tout.body.journal), 'la réponse porte le journal des connecteurs');
  const ligne = tout.body.journal.find((j) => j.message.includes('première ligne du journal'));
  assert.ok(ligne, 'la ligne du connecteur doit arriver à l\'écran');
  assert.equal(ligne.kind, 'journal');
  assert.equal(ligne.connector_id, ID_SONDE);
  assert.equal(ligne.connectorName, 'Sonde lot 41');
  assert.ok(ligne.started_at, 'la ligne porte sa date, la même colonne que les exécutions');

  // Le filtre par connecteur s'applique au journal comme aux exécutions.
  const filtre = await client.get(`/api/admin/logs/runs?connector=${ID_SONDE}&result=all&q=`);
  assert.ok(filtre.body.journal.length >= 2);
  assert.ok(filtre.body.journal.every((j) => j.connector_id === ID_SONDE));
  assert.ok(
    tout.body.filters.some((f) => f.id === ID_SONDE),
    'un service qui n\'a que du journal doit apparaître dans le filtre'
  );

  // « Succès »/« Échecs » filtrent des RÉSULTATS : le journal, qui n'en est
  // pas un, s'efface — il ne doit jamais passer pour un échec (ni un succès).
  const echecs = await client.get('/api/admin/logs/runs?connector=all&result=failure&q=');
  assert.deepEqual(echecs.body.journal, []);

  // La purge de l'onglet emporte ce que l'onglet affiche : exécutions ET journal.
  const purge = await client.delete('/api/admin/logs/runs');
  assert.equal(purge.status, 200);
  assert.equal(lignesEnBase().length, 0, 'la purge doit emporter le journal des connecteurs');
});

// ---------------------------------------------------------------------------
// 2. « Aucune nouvelle facture » ne se dit que quand c'est vrai
// ---------------------------------------------------------------------------

test('« aucun document proposé » : la phrase du connecteur remplace « Aucune nouvelle facture »', async () => {
  const resultat = await executer('aucun-document');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.success, 1, 'atteindre une liste sans document n\'est pas une panne');
  assert.equal(ligne.message, PHRASE_AUCUN_DOCUMENT);
  assert.notEqual(ligne.message, 'Aucune nouvelle facture');
});

test('« tout était déjà récupéré » reste « Aucune nouvelle facture »', async () => {
  const resultat = await executer('deja-recupere');
  assert.equal(resultat.ok, true, resultat.message);
  assert.equal(derniereExecution().message, 'Aucune nouvelle facture');
});

test('un document réellement descendu fait taire la déclaration « aucun document »', async () => {
  const resultat = await executer('document-malgre-declaration');
  assert.equal(resultat.ok, true, resultat.message);
  const ligne = derniereExecution();
  assert.equal(ligne.invoice_count, 1);
  assert.equal(ligne.message, '1 facture récupérée');
});
