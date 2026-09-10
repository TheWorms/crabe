'use strict';

/**
 * Lot 71 — le bandeau ne garde plus un échec périmé.
 *
 * ─── Le défaut mesuré (08/09/2026) ───────────────────────────────────────────
 *
 * Electro Dépôt : 19:28 récupération refusée (session expirée), 19:30 l'utilisateur se
 * reconnecte, 19:31 récupération réussie. À 19:33, le bandeau affichait encore
 * « Récupération Electro Dépôt : arrêtée sur un échec » : la fenêtre d'une
 * heure des échecs (lot 65) servait TOUTES les fins de la fenêtre, sans
 * dédoublonner par connecteur — un succès postérieur de trois minutes
 * n'effaçait pas l'échec antérieur.
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 *
 * Pour un même connecteur, seule la DERNIÈRE exécution compte. Un succès qui
 * suit un échec le remplace (puis s'efface selon sa propre fenêtre de deux
 * minutes) ; la fenêtre d'une heure vaut pour un échec NON SUIVI. Une
 * exécution en cours masque de même les fins antérieures de son connecteur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const operations = require('../server/operations');
const scheduler = require('../server/scheduler');

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({
    username: 'bandeau71',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
});

test.after(() => helpers.teardown());

/** Remplace une fonction de lecture le temps d'un test, puis la remet. */
function patch(t, module_, prop, valeur) {
  const original = module_[prop];
  module_[prop] = valeur;
  t.after(() => {
    module_[prop] = original;
  });
}

/** Insère une fin d'exécution et rend son id (nettoyée par le test). */
function fin(t, connecteur, { ilYA, ok, message }) {
  const ligne = helpers.db.get().prepare(
    `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, invoice_count, message)
     VALUES (?, ?, datetime('now', ?), ?, 'manual', 0, ?)`
  ).run(connecteur, compte.id, ilYA, ok ? 1 : 0, message);
  t.after(() => {
    helpers.db.get().prepare('DELETE FROM run_logs WHERE id = ?').run(ligne.lastInsertRowid);
  });
  return ligne.lastInsertRowid;
}

const recuperations = () =>
  operations.operationsPour({ id: compte.id }).filter((o) => o.type === 'recuperation');

test('un succès qui suit un échec du même connecteur remplace l\'échec dans le bandeau', (t) => {
  // La chronologie mesurée : échec à −5 min, succès à −1 min.
  fin(t, 'electro-depot', { ilYA: '-5 minutes', ok: false, message: 'Electro Dépôt a refusé la connexion.' });
  fin(t, 'electro-depot', { ilYA: '-1 minute', ok: true, message: 'Aucune commande — vous êtes à jour.' });

  const ops = recuperations();
  assert.equal(ops.length, 1, 'une seule fin par connecteur : la dernière');
  assert.equal(ops[0].etat, 'succes', 'et c\'est le succès, pas l\'échec périmé');
  assert.equal(ops[0].detail.includes('refusé'), false, 'le message d\'échec a disparu avec lui');
});

test('le succès remplaçant s\'efface ensuite selon SA fenêtre : le connecteur sort du bandeau', (t) => {
  // Échec à −10 min, succès à −5 min : l'échec est remplacé, ET le succès est
  // sorti de sa fenêtre de deux minutes — plus rien à annoncer. Avant le
  // lot 71, l'échec serait revenu occuper le bandeau pendant une heure.
  fin(t, 'electro-depot', { ilYA: '-10 minutes', ok: false, message: 'Electro Dépôt a refusé la connexion.' });
  fin(t, 'electro-depot', { ilYA: '-5 minutes', ok: true, message: 'Aucune commande — vous êtes à jour.' });

  assert.equal(recuperations().length, 0, 'rien : le succès a remplacé l\'échec, puis s\'est effacé');
});

test('un échec NON SUIVI reste annoncé une heure — l\'acquis du lot 65 tient', (t) => {
  fin(t, 'boulanger', { ilYA: '-40 minutes', ok: false, message: 'Le site a refoulé la lecture.' });

  const ops = recuperations();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].etat, 'echec', 'sans succès postérieur, l\'échec demande toujours sa décision');
});

test('un échec qui suit un succès est bien celui qui compte — la règle joue dans les deux sens', (t) => {
  fin(t, 'boulanger', { ilYA: '-30 minutes', ok: true, message: 'Aucune nouvelle facture' });
  fin(t, 'boulanger', { ilYA: '-20 minutes', ok: false, message: 'Le site a refoulé la lecture.' });

  const ops = recuperations();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].etat, 'echec');
});

test('une exécution EN COURS masque la fin précédente de son connecteur', (t) => {
  fin(t, 'electro-depot', { ilYA: '-5 minutes', ok: false, message: 'Electro Dépôt a refusé la connexion.' });
  patch(t, scheduler, 'runningPairs', () => [
    { userId: compte.id, connectorId: 'electro-depot', startedAt: new Date().toISOString() },
  ]);

  const ops = recuperations();
  assert.equal(ops.length, 1, 'une seule ligne pour ce connecteur');
  assert.equal(ops[0].etat, 'en-cours',
    'la dernière exécution est celle qui tourne — l\'échec d\'avant n\'est plus « ce qui vient de se passer »');
});

test('deux connecteurs restent deux lignes : le dédoublonnage est PAR connecteur', (t) => {
  fin(t, 'electro-depot', { ilYA: '-5 minutes', ok: false, message: 'Electro Dépôt a refusé la connexion.' });
  fin(t, 'boulanger', { ilYA: '-1 minute', ok: true, message: 'Aucune nouvelle facture' });

  const ops = recuperations();
  assert.equal(ops.length, 2, 'le succès de l\'un n\'efface pas l\'échec de l\'autre');
  assert.equal(ops[0].etat, 'echec', 'et l\'échec passe devant (ordre d\'importance du lot 65)');
});
