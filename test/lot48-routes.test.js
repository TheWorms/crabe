'use strict';

/**
 * Lot 48 — les deux routes qui ont rendu la soirée du 22/08/2026 muette.
 *
 * 1. `POST …/remote-login/save` construisait sa réponse 409 par
 *    `{ error, …vue }` : la vue publique porte un champ `error` (nul tant que
 *    la session vit) qui ÉCRASAIT le verdict. Le client recevait
 *    `error: null`, affichait « Erreur 409 », et l'utilisateur voyait un
 *    bouton mort.
 * 2. `GET /api/admin/logs/runs` ne montrait que les sources `connector:%` : tout ce
 *    que la fenêtre de connexion écrivait dormait sous `remote-browser`, dans
 *    un autre onglet, et la soirée s'est diagnostiquée à l'aveugle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const remoteBrowser = require('../server/remote-browser');
const applog = require('../server/applog');

let server;
let admin;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'verdicteur',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(require('../server/permissions').roleBySlug('admin').id, admin.id);
  server = await helpers.startServer();
  await helpers.login(server, 'verdicteur', 'MotDePasse1');
});

test.after(async () => {
  await server.close();
  helpers.teardown();
});

test('la réponse 409 de /save porte le verdict — la vue publique ne l\'écrase pas', async (t) => {
  // Le gestionnaire est remplacé LE TEMPS DU TEST : ce qu'on vérifie ici est
  // la construction de la réponse HTTP, pas le cycle de vie de la session
  // (couvert par lot48-verdict.test.js).
  const vrai = remoteBrowser.manager;
  t.after(() => {
    remoteBrowser.manager = vrai;
  });
  remoteBrowser.manager = () => ({
    saveNow: async () => ({
      ok: false,
      error: 'La page qui sert à vérifier votre connexion n\'existe pas à l\'adresse prévue. '
        + 'Ce service a besoin d\'être corrigé — signalez-le.',
      view: {
        // Le champ assassin : `publicView` rend `error: null` tant que la
        // session vit. Avant le lot 48, ce nul écrasait le verdict.
        error: null,
        state: 'running',
        attenteManuelle: true,
        echecsVerification: 2,
        verdictCode: 'adresse-morte',
      },
    }),
  });

  const reponse = await server.post('/api/connectors/free/remote-login/save');

  assert.equal(reponse.status, 409);
  assert.match(String(reponse.body.error), /n'existe pas à l'adresse prévue/,
    'le verdict doit survivre à la vue publique — c\'est LE défaut du 22/08/2026');
  assert.equal(reponse.body.attenteManuelle, true, 'la vue accompagne le verdict');
  assert.equal(reponse.body.echecsVerification, 2);
});

test('« Logs → Connecteurs » montre ce que la fenêtre de connexion a écrit', async () => {
  applog.info('remote-browser:free', 'La fenêtre de connexion Free a dit ceci (essai lot 48).');
  applog.connector('free', 'Le connecteur free a dit cela (essai lot 48).');

  const reponse = await server.get('/api/admin/logs/runs');
  assert.equal(reponse.status, 200);

  const fenetre = reponse.body.journal.find((j) => /fenêtre de connexion Free a dit/.test(j.message));
  assert.ok(fenetre, 'la ligne de la fenêtre doit être dans le journal des connecteurs');
  assert.equal(fenetre.connector_id, 'free', 'attribuée à son service, comme les autres');

  // Le filtre par service la garde ; un autre service l'écarte.
  const filtre = await server.get('/api/admin/logs/runs?connector=free');
  assert.ok(filtre.body.journal.some((j) => /fenêtre de connexion Free a dit/.test(j.message)));
  const autre = await server.get('/api/admin/logs/runs?connector=ldlc');
  assert.equal(
    autre.body.journal.some((j) => /fenêtre de connexion Free a dit/.test(j.message)),
    false
  );

  // Et le service apparaît dans la liste des filtres même sans exécution.
  assert.ok(reponse.body.filters.some((f) => f.id === 'free'));
});

test('la purge du journal des connecteurs emporte aussi les lignes de la fenêtre', async () => {
  applog.info('remote-browser:free', 'Ligne à purger (essai lot 48).');

  const purge = await server.del('/api/admin/logs/runs');
  assert.equal(purge.status, 200);

  const restes = helpers.db
    .get()
    .prepare("SELECT COUNT(*) AS n FROM app_logs WHERE source LIKE 'remote-browser:%'")
    .get();
  assert.equal(restes.n, 0, 'l\'écran vidé ne doit pas garder des lignes invisibles');
});
