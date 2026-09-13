'use strict';

/**
 * Lot 42 — « Aucune nouvelle facture » recouvrait un TROISIÈME silence.
 *
 * Le 19/08/2026, SoundCloud a vu 26 lignes d'achat, en a reconnu 24 comme des
 * reçus imprimables, n'en a rapporté aucun — tous étaient antérieurs à 2026,
 * la période demandée dans les réglages — et l'écran a affiché « Aucune
 * nouvelle facture ». Rien n'était en panne, et rien n'était à jour non plus :
 * 24 documents attendaient derrière un réglage d'historique trop court.
 *
 * Il y a donc TROIS silences, et chacun a sa phrase :
 *
 *   1. « tout était déjà récupéré »          → « Aucune nouvelle facture »
 *      (le message générique, inchangé depuis toujours) ;
 *   2. « le service ne propose aucun document » → `aucunDocument` (lot 41) ;
 *   3. « ils existent, ils sont juste plus vieux » → `horsPeriode` (lot 42),
 *      qui dit COMBIEN et QUEL GESTE faire.
 *
 * Ces tests prouvent qu'aucun des trois ne prend la place d'un autre, et
 * qu'un document réellement descendu les fait taire tous.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const scraping = require('../server/connectors/scraping');
const permissions = require('../server/permissions');
const db = require('../server/db/db');

const ID_SONDE = 'sonde-lot42';

const PHRASE_AUCUN_DOCUMENT =
  'Ce service ne délivre pas de facture téléchargeable — 26 paiements listés, '
  + 'aucun document proposé.';

/** La phrase du cas 3, telle que le socle la formule pour 24 reçus. */
const PHRASE_HORS_PERIODE = scraping.phraseHorsPeriode(24, 'reçu');

/**
 * Une sonde qui rejoue les quatre issues possibles d'une récupération sans
 * document rapporté. Elle ne touche à aucun compte réel.
 */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const mode = config.mode || 'deja-recupere';
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 26 });
    if (mode === 'hors-periode') {
      return { invoices: [], horsPeriode: ${JSON.stringify(PHRASE_HORS_PERIODE)} };
    }
    if (mode === 'aucun-document') {
      return { invoices: [], aucunDocument: ${JSON.stringify(PHRASE_AUCUN_DOCUMENT)} };
    }
    if (mode === 'document-malgre-declaration') {
      return {
        invoices: [{ remoteId: 'd1', filename: 'sonde-lot42_2026-01_d1.pdf',
                     issuedOn: '2026-01-05', buffer: Buffer.from('%PDF-1.4 sonde') }],
        horsPeriode: ${JSON.stringify(PHRASE_HORS_PERIODE)},
        aucunDocument: 'ne doit jamais s\\'afficher : un document est descendu',
      };
    }
    return { invoices: [] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 42',
  category: 'energie',
  color: '#123456',
  letters: 'SD',
  description: 'Sonde de test du lot 42 : elle rejoue les trois silences d\'une récupération.',
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

async function executer(mode) {
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', mode });
  return scheduler.runForUser(user.id, ID_SONDE, 'manual');
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
    username: 'lot42',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, user.id);

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot42-'));
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
// Les trois silences, un test chacun
// ---------------------------------------------------------------------------

test('cas 3 — « ils existent, mais ils sont plus vieux » : la phrase le dit et donne le geste', async () => {
  const resultat = await executer('hors-periode');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.success, 1, 'des documents hors période ne sont pas une panne');
  assert.equal(ligne.message, PHRASE_HORS_PERIODE);
  // Ce que l'écran affichait le 19/08/2026, et qui était faux :
  assert.notEqual(ligne.message, 'Aucune nouvelle facture');
  // La phrase dit COMBIEN, POURQUOI et QUOI FAIRE — pour un lecteur non technique.
  assert.match(ligne.message, /24 reçus existent/);
  assert.match(ligne.message, /antérieurs à la période demandée/);
  assert.match(ligne.message, /Élargissez « Historique à récupérer »/);
  // …et ne prend jamais la place du cas 2.
  assert.notEqual(ligne.message, PHRASE_AUCUN_DOCUMENT);
});

test('cas 2 — « aucun document proposé » garde SA phrase (lot 41, inchangé)', async () => {
  const resultat = await executer('aucun-document');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.success, 1);
  assert.equal(ligne.message, PHRASE_AUCUN_DOCUMENT);
  assert.notEqual(ligne.message, PHRASE_HORS_PERIODE);
  assert.notEqual(ligne.message, 'Aucune nouvelle facture');
});

test('cas 1 — « tout était déjà récupéré » reste « Aucune nouvelle facture » (inchangé)', async () => {
  const resultat = await executer('deja-recupere');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.message, 'Aucune nouvelle facture');
  assert.notEqual(ligne.message, PHRASE_HORS_PERIODE);
  assert.notEqual(ligne.message, PHRASE_AUCUN_DOCUMENT);
});

test('un document réellement descendu fait taire les deux déclarations', async () => {
  const resultat = await executer('document-malgre-declaration');
  assert.equal(resultat.ok, true, resultat.message);

  const ligne = derniereExecution();
  assert.equal(ligne.invoice_count, 1);
  assert.equal(ligne.message, '1 facture récupérée');
});

// ---------------------------------------------------------------------------
// La phrase elle-même : elle s'accorde, et elle nomme le geste
// ---------------------------------------------------------------------------

test('la phrase « hors période » s\'accorde en nombre et en genre', () => {
  assert.match(scraping.phraseHorsPeriode(24, 'reçu'), /^24 reçus existent, tous antérieurs à la période demandée : ils n'ont pas été examinés\./);
  assert.match(scraping.phraseHorsPeriode(1, 'reçu'), /^1 reçu existe, antérieur à la période demandée : il n'a pas été examiné\./);
  assert.match(
    scraping.phraseHorsPeriode(3, 'facture', { feminin: true }),
    /^3 factures existent, toutes antérieures à la période demandée : elles n'ont pas été examinées\./
  );
  assert.match(
    scraping.phraseHorsPeriode(1, 'facture', { feminin: true }),
    /^1 facture existe, antérieure à la période demandée : elle n'a pas été examinée\./
  );
  // Le geste est toujours nommé, et il désigne le réglage tel qu'il s'appelle
  // à l'écran — pas « la fenêtre de dates » ni « le plan d'historique ».
  for (const n of [1, 2, 24]) {
    assert.match(scraping.phraseHorsPeriode(n, 'reçu'), /Élargissez « Historique à récupérer » dans les réglages du service/);
  }
});
