'use strict';

/**
 * Lot 71 — un échec après un succès s'appelle une expiration.
 *
 * ─── La demande ──────────────────────────────────────────────────────────────
 *
 * Le même refus brut ne veut pas dire la même chose selon ce qui a précédé.
 * Un connecteur qui a déjà réussi (une récupération passée, une session
 * confirmée à l'enregistrement) et qui se fait refuser l'accès n'échoue pas
 * sur une « première connexion » : sa connexion a expiré, et le message le
 * dit, daté. L'utilisateur ne fait pas le même geste dans les deux cas.
 *
 * Quatre situations, quatre phrases :
 *   1. jamais de réussite → le message de première connexion du connecteur ;
 *   2. réussite (ou session confirmée) puis refus → « votre connexion a
 *      expiré (dernière réussite le JJ/MM) — reconnectez-vous » ;
 *   3. le site refuse le passage automatique malgré une session valide
 *      (lot 57, `renvoiAuthentification`) → sa phrase à lui, jamais « expiré » ;
 *   4. la preuve de liste introuvable (lot 31/68) → sa phrase à elle
 *      (l'erreur ne porte pas `sessionExpired`, rien ne la réécrit).
 *
 * Toutes les valeurs sont INVENTÉES.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const messagesEchec = require('../server/connectors/messages-echec');
const db = require('../server/db/db');

// ---------------------------------------------------------------------------
// 1. La table pure : messageDeRefusExpire
// ---------------------------------------------------------------------------

test('sans aucun historique, le message du connecteur fait foi — rien n\'est réécrit', () => {
  assert.equal(messagesEchec.messageDeRefusExpire({}), null);
  assert.equal(messagesEchec.messageDeRefusExpire({ derniereReussite: '', sessionOuverteLe: null }), null);
  assert.equal(messagesEchec.messageDeRefusExpire({ derniereReussite: 'pas-une-date' }), null);
});

test('une réussite passée date le message — et la date est rendue dans le fuseau d\'affichage', () => {
  const message = messagesEchec.messageDeRefusExpire({
    derniereReussite: '2026-09-05 14:00:00',
    zone: 'Europe/Paris',
  });
  assert.match(message, /^Votre connexion a expiré \(dernière réussite le 05\/09\)/);
  assert.match(message, /reconnectez-vous depuis la fiche du service/);

  // 23:30 UTC, c'est déjà le lendemain à Paris : la date affichée doit être
  // celle que l'utilisateur a vécue, pas celle de la base.
  assert.match(
    messagesEchec.messageDeRefusExpire({ derniereReussite: '2026-09-05 23:30:00', zone: 'Europe/Paris' }),
    /le 06\/09/
  );
});

test('une session confirmée sans récupération réussie date le message par son ouverture', () => {
  const message = messagesEchec.messageDeRefusExpire({
    sessionOuverteLe: '2026-09-08T17:29:00.000Z',
    zone: 'Europe/Paris',
  });
  assert.match(message, /connexion ouverte le 08\/09/);
  // La réussite, plus parlante, prime quand les deux existent.
  assert.match(
    messagesEchec.messageDeRefusExpire({
      derniereReussite: '2026-09-05 14:00:00',
      sessionOuverteLe: '2026-09-08T17:29:00.000Z',
    }),
    /dernière réussite le 05\/09/
  );
});

// ---------------------------------------------------------------------------
// 2. Le trajet complet : même refus brut, historiques différents
// (recette du lot 70 : une sonde, le vrai planificateur, la vraie base)
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot71';

const MESSAGE_PREMIERE_CONNEXION =
  'Votre connexion à Sonde lot 71 a expiré ou n\'a jamais été ouverte. Ouvrez la fiche du '
  + 'service et cliquez « Se connecter », puis relancez la récupération.';

const MESSAGE_RENVOI =
  'Votre connexion à Sonde lot 71 est bien enregistrée, mais le site a renvoyé la lecture '
  + 'automatique vers sa page d\'authentification au lieu de servir votre espace client.';

const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const mode = config.mode || 'succes';
    if (mode === 'refus') {
      const err = new Error(${JSON.stringify(MESSAGE_PREMIERE_CONNEXION)});
      err.sessionExpired = true;
      throw err;
    }
    if (mode === 'renvoi') {
      const err = new Error(${JSON.stringify(MESSAGE_RENVOI)});
      err.sessionExpired = true;
      err.renvoiAuthentification = true;
      throw err;
    }
    if (mode === 'sans-preuve') return { invoices: [] };
    ctx.preuveDeListe?.({ session: 'marqueur de compte vu', liste: 'liste factice', elements: 0 });
    return { invoices: [] };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 71',
  category: 'energie',
  color: '#123456',
  letters: 'S7',
  description: 'Sonde de test du lot 71 : le message de refus suit l\'historique.',
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

function derniereExecution() {
  return db
    .get()
    .prepare(
      `SELECT success, message FROM run_logs
        WHERE connector_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(ID_SONDE, user.id);
}

function effacerHistorique() {
  db.get().prepare('DELETE FROM run_logs WHERE connector_id = ? AND user_id = ?')
    .run(ID_SONDE, user.id);
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({
    username: 'lot71',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot71-'));
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

test('sans réussite passée, un refus garde le message de première connexion', async () => {
  effacerHistorique();
  const resultat = await executer('refus');
  assert.equal(resultat.ok, false);
  assert.equal(derniereExecution().message, MESSAGE_PREMIERE_CONNEXION,
    'rien à dater : le message du connecteur fait foi');
});

test('le MÊME refus brut, après une réussite, devient « votre connexion a expiré », daté', async () => {
  effacerHistorique();
  const succes = await executer('succes');
  assert.equal(succes.ok, true, succes.message);

  const resultat = await executer('refus');
  assert.equal(resultat.ok, false);
  const ligne = derniereExecution();
  assert.match(ligne.message, /^Votre connexion a expiré \(dernière réussite le \d{2}\/\d{2}\)/,
    'même refus brut, historique différent : message différent');
  assert.match(ligne.message, /reconnectez-vous depuis la fiche du service/);
  assert.equal(ligne.message.includes('n\'a jamais été ouverte'), false,
    'on n\'accuse plus une première connexion qui n\'en est pas une');
});

test('le renvoi vers l\'authentification (lot 57) garde sa phrase, même avec une réussite passée', async () => {
  effacerHistorique();
  await executer('succes');

  const resultat = await executer('renvoi');
  assert.equal(resultat.ok, false);
  const ligne = derniereExecution();
  assert.equal(ligne.message, MESSAGE_RENVOI,
    'on ne dit pas « expiré » à quelqu\'un qui vient peut-être de se connecter');
});

test('la preuve introuvable (lot 31/68) garde sa phrase : ce n\'est pas un refus d\'accès', async () => {
  effacerHistorique();
  await executer('succes');

  const resultat = await executer('sans-preuve');
  assert.equal(resultat.ok, false);
  const ligne = derniereExecution();
  assert.match(ligne.message, /sans avoir pu confirmer l'accès à la liste/,
    'la phrase du lot 31 reste — rien ne la réécrit en expiration');
});
