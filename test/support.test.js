'use strict';

/**
 * Support : fil de conversation, lu / non lu, et masquage côté utilisateur qui
 * ne fait pas disparaître l'historique côté administration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const tickets = require('../server/tickets');
const permissions = require('../server/permissions');

let user;
let admin;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'demandeur', plainPassword: 'MotDePasse1' });
  admin = await helpers.createUser({
    username: 'supportadmin',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Lu / non lu
// ---------------------------------------------------------------------------

test('une demande fraîche est non lue, et le reste jusqu\'à son ouverture', () => {
  const ticket = tickets.create(user.id, 'Sujet initial', 'Le message initial.');

  assert.equal(ticket.unread, true);
  assert.equal(ticket.readAt, null);
  assert.equal(ticket.status, 'recu');
  assert.equal(ticket.displayLabel, 'Non lu', 'libellé distinct du statut');

  const counts = tickets.counts();
  assert.ok(counts.unread >= 1);

  // Ouverture par l'administration : lue, et prise en charge.
  const opened = tickets.markRead(ticket.id);
  assert.equal(opened.unread, false);
  assert.ok(opened.readAt);
  assert.equal(opened.status, 'en-cours');
  assert.equal(opened.displayLabel, 'En cours');

  // Idempotent : une seconde ouverture ne réécrit pas la date.
  const again = tickets.markRead(ticket.id);
  assert.equal(again.readAt, opened.readAt);
});

// ---------------------------------------------------------------------------
// Fil de conversation
// ---------------------------------------------------------------------------

test('le fil conserve chaque message, il n\'écrase rien', () => {
  const ticket = tickets.create(user.id, 'Conversation', 'Première question.');

  tickets.reply(ticket.id, 'Première réponse.', { author: 'admin', username: 'supportadmin' });
  tickets.reply(ticket.id, 'Merci, mais encore une chose.', {
    author: 'user',
    userId: user.id,
    username: 'demandeur',
  });
  const final = tickets.reply(ticket.id, 'Deuxième réponse.', {
    author: 'admin',
    username: 'supportadmin',
  });

  const bodies = final.messages.map((m) => `${m.author}: ${m.body}`);
  assert.deepEqual(bodies, [
    'user: Première question.',
    'admin: Première réponse.',
    'user: Merci, mais encore une chose.',
    'admin: Deuxième réponse.',
  ]);

  for (const message of final.messages) {
    assert.ok(message.createdAt, 'chaque message est horodaté');
  }

  // Le champ historique `reply` garde la dernière réponse de l'admin.
  assert.equal(final.reply, 'Deuxième réponse.');
  assert.equal(final.status, 'repondu');
});

test('une relance de l\'utilisateur repasse la demande en non lue', () => {
  const ticket = tickets.create(user.id, 'Relance', 'Question.');
  tickets.reply(ticket.id, 'Réponse.', { author: 'admin' });
  assert.equal(tickets.getById(ticket.id).unread, false);

  const relaunched = tickets.reply(ticket.id, 'Toujours pas résolu.', {
    author: 'user',
    userId: user.id,
  });
  assert.equal(relaunched.unread, true, 'le support doit revoir la demande');
});

test('un message vide est refusé', () => {
  const ticket = tickets.create(user.id, 'Vide', 'Question.');
  assert.throws(() => tickets.reply(ticket.id, '   ', { author: 'admin' }), /vide/);
  assert.throws(() => tickets.reply(999999, 'texte', { author: 'admin' }), /introuvable/);
});

// ---------------------------------------------------------------------------
// Parcours HTTP
// ---------------------------------------------------------------------------

test('parcours complet : demande, ouverture, réponse, clôture', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'demandeur', 'MotDePasse1');
  const created = await client.post('/api/tickets', {
    subject: 'Sync OVH',
    message: 'La synchronisation échoue.',
  });
  assert.equal(created.status, 201);
  const id = created.body.ticket.id;
  assert.equal(created.body.ticket.unread, true);

  client.clearCookies();
  await helpers.login(client, 'supportadmin', 'MotDePasse1');

  const list = await client.get('/api/tickets');
  assert.equal(list.status, 200);
  assert.ok(list.body.counts.unread >= 1);
  assert.ok(list.body.statuses.length === 4);
  // Les non lues remontent en tête.
  assert.equal(list.body.tickets[0].unread, true);

  const opened = await client.get(`/api/tickets/${id}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.ticket.unread, false, 'ouvrir marque comme lu');
  assert.equal(opened.body.ticket.messages.length, 1);

  const answered = await client.post(`/api/tickets/${id}/reply`, {
    message: 'Vos identifiants OVH ont expiré.',
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.ticket.status, 'repondu');
  assert.equal(answered.body.ticket.messages.length, 2);

  const closed = await client.patch(`/api/tickets/${id}`, { status: 'ferme' });
  assert.equal(closed.body.ticket.status, 'ferme');
  assert.equal(closed.body.ticket.statusLabel, 'Clôturé');

  // L'utilisateur voit le fil complet de son côté.
  client.clearCookies();
  await helpers.login(client, 'demandeur', 'MotDePasse1');
  const mine = await client.get('/api/tickets/mine');
  const seen = mine.body.tickets.find((ti) => ti.id === id);
  assert.equal(seen.messages.length, 2);
  assert.equal(seen.messages[1].author, 'admin');
});

test('« supprimer » masque côté utilisateur et le dit honnêtement', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());

  await helpers.login(client, 'demandeur', 'MotDePasse1');
  const created = await client.post('/api/tickets', {
    subject: 'À masquer',
    message: 'Contenu.',
  });
  const id = created.body.ticket.id;

  const hidden = await client.del(`/api/tickets/${id}/mine`);
  assert.equal(hidden.status, 200);
  assert.match(hidden.body.message, /conserve la trace/);

  const mine = await client.get('/api/tickets/mine');
  assert.equal(mine.body.tickets.some((ti) => ti.id === id), false);

  client.clearCookies();
  await helpers.login(client, 'supportadmin', 'MotDePasse1');
  const adminView = await client.get(`/api/tickets/${id}`);
  assert.equal(adminView.status, 200);
  assert.equal(adminView.body.ticket.hiddenByUser, true);
  assert.equal(adminView.body.ticket.messages.length, 1, 'le fil reste complet côté admin');
});

test('un utilisateur ne peut pas répondre sur la demande d\'un autre', async (t) => {
  const other = await helpers.createUser({ username: 'curieux', plainPassword: 'MotDePasse1' });
  const ticket = tickets.create(user.id, 'Privé', 'Contenu privé.');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'curieux', 'MotDePasse1');

  const res = await client.post(`/api/tickets/${ticket.id}/messages`, { message: 'Coucou.' });
  assert.equal(res.status, 404, 'ni 403 ni fuite d\'information');
  assert.equal(tickets.getById(ticket.id).messages.length, 1);
  assert.ok(other.id);
});

test('le filtre « non lu » et les compteurs sont cohérents', () => {
  const counts = tickets.counts();
  assert.equal(tickets.listAll('unread').length, counts.unread);
  assert.equal(tickets.listAll().length, counts.all);
  assert.equal(tickets.listAll('ferme').length, counts.ferme);
  assert.equal(counts.open, counts.all - counts.ferme);
  assert.equal(
    tickets.listAll('unread').every((ti) => ti.unread),
    true
  );
});
