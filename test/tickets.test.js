'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const tickets = require('../server/tickets');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

test('un ticket vide est refusé', async () => {
  const user = await helpers.createUser({ username: 'nina' });
  assert.throws(() => tickets.create(user.id, '', 'message'), /obligatoires/);
  assert.throws(() => tickets.create(user.id, 'sujet', '   '), /obligatoires/);
});

test('un ticket créé part au statut « reçu »', async () => {
  const user = await helpers.createUser({ username: 'omar' });
  const ticket = tickets.create(user.id, 'Erreur OVH', 'La synchro échoue depuis hier.');

  assert.equal(ticket.status, 'recu');
  assert.equal(ticket.statusLabel, 'Reçu');
  assert.equal(ticket.displayLabel, 'Non lu', 'non lu tant qu\'aucun admin ne l\'a ouvert');
  assert.equal(ticket.reply, '');
  assert.equal(ticket.hiddenByUser, false);
  assert.equal(ticket.username, 'omar');
});

test('masquer un ticket le retire de l\'historique utilisateur mais pas de l\'admin', async () => {
  const user = await helpers.createUser({ username: 'paul' });
  const ticket = tickets.create(user.id, 'Question stockage', 'Quel est le quota ?');

  assert.equal(tickets.listForUser(user.id).length, 1);

  assert.equal(tickets.hideForUser(ticket.id, user.id), true);
  assert.equal(tickets.listForUser(user.id).length, 0, 'masqué côté utilisateur');

  const adminView = tickets.listAll().find((t) => t.id === ticket.id);
  assert.ok(adminView, 'l\'administrateur doit toujours voir la demande');
  assert.equal(adminView.hiddenByUser, true);
});

test('un utilisateur ne peut pas masquer le ticket d\'un autre', async () => {
  const owner = await helpers.createUser({ username: 'quinn' });
  const other = await helpers.createUser({ username: 'rosa' });
  const ticket = tickets.create(owner.id, 'Privé', 'Contenu.');

  assert.equal(tickets.hideForUser(ticket.id, other.id), false);
  assert.equal(tickets.listForUser(owner.id).some((t) => t.id === ticket.id), true);
});

test('la réponse admin est enregistrée avec le changement de statut', async () => {
  const user = await helpers.createUser({ username: 'sam' });
  const ticket = tickets.create(user.id, 'Ajout Vinted', 'Possible ?');

  tickets.updateStatus(ticket.id, 'en-cours');
  assert.equal(tickets.getById(ticket.id).status, 'en-cours');

  const answered = tickets.updateStatus(ticket.id, 'repondu', 'Ajouté au Store, en cours de test.');
  assert.equal(answered.status, 'repondu');
  assert.equal(answered.reply, 'Ajouté au Store, en cours de test.');

  // Un changement de statut sans réponse ne l'efface pas.
  const closed = tickets.updateStatus(ticket.id, 'ferme');
  assert.equal(closed.reply, 'Ajouté au Store, en cours de test.');
});

test('un statut inconnu est refusé', async () => {
  const user = await helpers.createUser({ username: 'tania' });
  const ticket = tickets.create(user.id, 'Sujet', 'Message');
  assert.throws(() => tickets.updateStatus(ticket.id, 'inexistant'), /Statut inconnu/);
});

test('mettre à jour un ticket inexistant lève une 404', () => {
  assert.throws(() => tickets.updateStatus(999999, 'ferme'), /introuvable/);
});

test('le filtrage par statut et les compteurs sont cohérents', () => {
  const counts = tickets.counts();
  const total = tickets.listAll().length;
  assert.equal(counts.all, total);

  for (const status of tickets.STATUSES) {
    assert.equal(tickets.listAll(status).length, counts[status], `compteur « ${status} »`);
    assert.equal(
      tickets.listAll(status).every((t) => t.status === status),
      true
    );
  }
});

test('un ticket reste visible côté support après suppression de son auteur', async () => {
  const user = await helpers.createUser({ username: 'ugo' });
  const ticket = tickets.create(user.id, 'Avant suppression', 'Contenu.');

  helpers.db.get().prepare('DELETE FROM users WHERE id = ?').run(user.id);

  const kept = tickets.getById(ticket.id);
  assert.ok(kept, 'le ticket doit survivre à la suppression du compte');
  assert.equal(kept.userId, null, 'l\'auteur est anonymisé (ON DELETE SET NULL)');
  assert.equal(kept.subject, 'Avant suppression');
});
