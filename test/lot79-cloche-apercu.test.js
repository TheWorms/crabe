'use strict';

/**
 * Lot 79 — la cloche s'ouvre sur un aperçu, et les notifications se
 * suppriment.
 *
 * 1. **Côté serveur** : `supprimer` (la croix, unitaire, sur SON compte
 *    seulement) et la route `/me/notifications/supprimer` — où le TOUT est un
 *    choix explicite (`tout: true`) : un corps vide ne supprime RIEN, jamais
 *    la symétrie de `seen`.
 *
 * 2. **Côté front (rendu pur, prouvé hors navigateur comme au lot 76)** :
 *    l'aperçu sous la cloche montre les dernières non lues (titre, ligne de
 *    détail, ancienneté), une croix par ligne, et le lien vers l'écran
 *    complet ; l'écran complet gagne la croix par ligne et « Tout
 *    supprimer » (qui, lui, demande confirmation côté conduite).
 *
 * Réintroduction des défauts : retirer `supprimer` ou la route, faire du
 * corps vide un « tout supprimer », retirer la croix ou le lien du panneau,
 * fait échouer les assertions correspondantes.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');

const WEB = path.resolve(__dirname, '..', 'web');

let client;
let db;
let notifications;
let userId;
let autreId;

test.before(async () => {
  await helpers.setup();
  db = require('../server/db/db');
  notifications = require('../server/notifications');

  await helpers.createUser({ username: 'lot79', plainPassword: 'MotDePasse1', role: 'admin' });
  await helpers.createUser({ username: 'lot79bis', plainPassword: 'MotDePasse1', role: 'admin' });
  userId = db.get().prepare("SELECT id FROM users WHERE username = 'lot79'").get().id;
  autreId = db.get().prepare("SELECT id FROM users WHERE username = 'lot79bis'").get().id;
  client = await helpers.startServer();
  await helpers.login(client, 'lot79', 'MotDePasse1');
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

test.beforeEach(() => {
  db.get().prepare('DELETE FROM notifications').run();
});

/** Une notification posée directement en base, comme `enregistrer` le fait. */
function poser(proprietaire, titre, { lue = false } = {}) {
  const info = db
    .get()
    .prepare(
      `INSERT INTO notifications (user_id, kind, title, body, created_at, seen_at)
       VALUES (?, 'sync-failure', ?, ?, datetime('now'), ${lue ? "datetime('now')" : 'NULL'})`
    )
    .run(proprietaire, titre, JSON.stringify([
      { id: 'fournisseur-essai', nom: 'Fournisseur Essai', message: 'Le site n\'a pas répondu.' },
    ]));
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// 1. Le serveur : supprimer, unitaire et cloisonné ; le tout, explicite
// ---------------------------------------------------------------------------

test('supprimer : la croix ne touche que les ids demandés, et que SON compte', () => {
  const mienne = poser(userId, 'Échec de récupération : Fournisseur Essai');
  const autreMienne = poser(userId, 'Récupération de 3 services terminée');
  const dAutrui = poser(autreId, 'Échec de récupération : Fournisseur Essai');

  assert.equal(notifications.supprimer(userId, [mienne, dAutrui]), 1,
    'une seule ligne supprimée : celle du compte, jamais celle du voisin');
  assert.equal(notifications.lister(userId).length, 1);
  assert.equal(notifications.lister(userId)[0].id, autreMienne);
  assert.equal(notifications.lister(autreId).length, 1, 'le voisin garde la sienne');
});

test('supprimer : sans ids lisibles, RIEN ne part — le vide ne veut pas dire tout', () => {
  poser(userId, 'Échec de récupération : Fournisseur Essai');
  assert.equal(notifications.supprimer(userId, []), 0);
  assert.equal(notifications.supprimer(userId, null), 0);
  assert.equal(notifications.supprimer(userId, undefined), 0);
  assert.equal(notifications.lister(userId).length, 1);
});

test('la route : ids supprime, le corps vide ne supprime rien, tout=true vide — et la réponse porte les non-lues', async () => {
  const a = poser(userId, 'Échec de récupération : Fournisseur Essai');
  poser(userId, 'Récupération de 3 services terminée');
  poser(userId, 'Renommage des documents — terminé', { lue: true });

  const unitaire = await client.post('/api/users/me/notifications/supprimer', { ids: [a] });
  assert.equal(unitaire.status, 200);
  assert.equal(unitaire.body.supprimees, 1);
  assert.equal(unitaire.body.nonLues, 1, 'la pastille se met à jour avec la réponse');

  const vide = await client.post('/api/users/me/notifications/supprimer', {});
  assert.equal(vide.body.supprimees, 0, 'un corps vide ne supprime RIEN');
  assert.equal(notifications.lister(userId).length, 2);

  const tout = await client.post('/api/users/me/notifications/supprimer', { tout: true });
  assert.equal(tout.body.supprimees, 2, 'tout=true emporte lues ET non lues');
  assert.equal(tout.body.nonLues, 0);
  assert.equal(notifications.lister(userId).length, 0);
});

// ---------------------------------------------------------------------------
// 2. Le front : rendu pur de l'aperçu et de l'écran augmenté
// ---------------------------------------------------------------------------

/** Les fonctions de rendu du VRAI web/app.js, extraites dans un vm. */
function contexteFront() {
  const contexte = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const borne = source.match(/const APERCU_NOTIFS_MAX = \d+;/);
  assert.ok(borne, 'APERCU_NOTIFS_MAX introuvable dans app.js');
  vm.runInContext(borne[0], contexte);
  for (const nom of ['cibleNotification', 'notificationHtml', 'apercuNotificationsHtml', 'noteContexteNotifications', 'notificationsHtml']) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans app.js`);
    vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  }
  return contexte;
}

/** Une non-lue d'il y a treize heures, comme dans le modèle du compte observé. */
function nonLueDe13h() {
  return {
    id: 7,
    kind: 'sync-failure',
    title: 'Échec de récupération : Fournisseur Essai',
    createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString(),
    seenAt: null,
    items: [{ id: 'fournisseur-essai', nom: 'Fournisseur Essai', message: 'Le site n\'a pas répondu.' }],
  };
}

test('l\'aperçu : les non-lues seulement, avec titre, détail, ancienneté, croix — et le lien vers l\'écran', () => {
  const contexte = contexteFront();
  contexte.LISTE = [
    nonLueDe13h(),
    { id: 8, kind: 'job-done', title: 'Renommage des documents — terminé', createdAt: '2026-09-02 08:00:00', seenAt: '2026-09-02 09:00:00', items: [] },
  ];
  const html = vm.runInContext('apercuNotificationsHtml(LISTE, 1)', contexte);

  assert.match(html, />Notifications</, 'le panneau porte son titre');
  assert.match(html, /ouvrirHistoriqueNotifications\(\)/, 'le lien mène à l\'écran complet');
  assert.match(html, /Tout l'historique/);
  assert.match(html, /notif-pan-titre">Échec de récupération : Fournisseur Essai</);
  assert.match(html, /Fournisseur Essai — Le site n&#39;a pas répondu\./, 'une ligne de détail, échappée');
  assert.match(html, /il y a 13 h/, 'l\'ancienneté, comme dans le modèle');
  assert.match(html, /supprimerNotifications\(\[7\]\)/, 'la croix supprime CETTE ligne');
  assert.match(html, /Supprimer cette notification/);
  assert.equal(html.includes('Renommage des documents'), false, 'une lue ne figure pas dans l\'aperçu');
});

test('l\'aperçu : borné, le surplus est dit ; sans non-lue, il le dit aussi', () => {
  const contexte = contexteFront();
  const borne = Number(vm.runInContext('APERCU_NOTIFS_MAX', contexte));
  contexte.LISTE = Array.from({ length: borne + 2 }, (_, i) => ({
    ...nonLueDe13h(), id: i + 1, title: `Échec de récupération : Service ${i + 1}`,
  }));
  const plein = vm.runInContext(`apercuNotificationsHtml(LISTE, ${borne + 2})`, contexte);
  assert.equal((plein.match(/notif-pan-item/g) || []).length, borne, 'jamais plus que la borne');
  assert.match(plein, /et 2 autre\(s\) non lue\(s\)/, 'le surplus renvoie à l\'historique');

  const vide = vm.runInContext('apercuNotificationsHtml([], 0)', contexte);
  assert.match(vide, /Rien de non lu\./);
  assert.match(vide, /Tout l'historique/, 'le lien reste là même sans non-lue');
});

test('l\'écran : chaque ligne a sa croix, et « Tout supprimer » n\'apparaît que s\'il y a quelque chose', () => {
  const contexte = contexteFront();
  contexte.UNE = nonLueDe13h();
  const ligne = vm.runInContext('notificationHtml(UNE)', contexte);
  assert.match(ligne, /supprimerNotifications\(\[7\]\)/, 'la croix de l\'écran');
  assert.match(ligne, /Supprimer cette notification/);

  contexte.LISTE = [nonLueDe13h()];
  const ecran = vm.runInContext('notificationsHtml(LISTE, 1, true)', contexte);
  assert.match(ecran, /supprimerToutesNotifications\(\)/);
  assert.match(ecran, /Tout supprimer/);

  const sansRien = vm.runInContext('notificationsHtml([], 0, true)', contexte);
  assert.equal(sansRien.includes('Tout supprimer'), false, 'rien à supprimer, pas de bouton');
});

test('la conduite du « tout » demande confirmation ; la croix, non — c\'est écrit dans le code livré', () => {
  // Ces gestes vivent dans le navigateur (confirm, api) : on prouve ici que le
  // code LIVRÉ les porte — le test de rendu ci-dessus prouve qui appelle quoi.
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const tout = source.slice(source.indexOf('async function supprimerToutesNotifications('));
  assert.match(tout.slice(0, 400), /confirm\(/, 'le tout-supprimer confirme AVANT');
  assert.match(tout.slice(0, 400), /définitive/, 'et dit que c\'est définitif');
  const croix = source.slice(source.indexOf('async function supprimerNotifications('));
  assert.equal(croix.slice(0, croix.indexOf('\n}\n')).includes('confirm('), false,
    'la croix est un geste unitaire : pas de confirmation');
});
