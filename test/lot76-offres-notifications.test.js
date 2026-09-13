'use strict';

/**
 * Lot 76 — trois sujets, trois preuves.
 *
 * 1. **kDrive dit d'avance quelles offres il exclut.** Mesuré le 09/09/2026 :
 *    une carte kDrive correctement remplie recevait 403 dès la racine, et la
 *    cause était dans la documentation d'Infomaniak (FAQ 2408, lue le
 *    09/09/2026) — l'accès WebDAV est indisponible avec kSuite Free, kSuite
 *    Standard, my kSuite et my kSuite+ (adresses en ik.me, etik.com,
 *    ikmail.com). La carte porte désormais la ligne VISIBLE, l'adresse saisie
 *    déclenche un avertissement AVANT l'enregistrement, et la configuration
 *    déjà enregistrée est examinée aussi. Jamais un blocage.
 *
 * 2. **Les notifications ont un écran.** Quinze notifications écrites en base
 *    depuis le lot 66, toutes non lues : aucun écran ne les montrait.
 *    `lister`/`compterNonLues` côté serveur, la route « liste », et le rendu
 *    pur côté front (non-lues distinguées, lien vers l'écran concerné, ligne
 *    sur le contexte non sécurisé).
 *
 * 3. **Le message de renvoi dit des JOURS, pas des semaines.** Mesuré sur
 *    l'historique Darty du 23/08 au 08/09/2026 : réussites uniquement dans
 *    les deux heures d'une connexion fraîche, renvoi dès trois jours.
 *
 * Réintroduction des défauts : retirer `avertissementSaisie` du champ, la
 * clause `webdav` d'`avertissements()`, la `note` du preset, `lister` ou la
 * route, ou remettre « plusieurs semaines », fait échouer les assertions
 * correspondantes.
 *
 * ⚠ Toutes les valeurs de comptes sont INVENTÉES (§1bis) ; les noms d'offres
 * et les domaines sont ceux de la documentation d'Infomaniak, rien d'autre.
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
let destinations;
let destinationSync;
let presets;
let notifications;
let profilMarchand;
let userId;

test.before(async () => {
  await helpers.setup();
  db = require('../server/db/db');
  destinations = require('../server/destinations');
  destinationSync = require('../server/destinations/sync');
  presets = require('../server/destinations/presets');
  notifications = require('../server/notifications');
  profilMarchand = require('../server/connectors/profil-marchand');

  await helpers.createUser({ username: 'lot76', plainPassword: 'MotDePasse1', role: 'admin' });
  userId = db.get().prepare("SELECT id FROM users WHERE username = 'lot76'").get().id;
  client = await helpers.startServer();
  await helpers.login(client, 'lot76', 'MotDePasse1');
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

test.beforeEach(() => {
  db.get().prepare("DELETE FROM destinations_config WHERE dest_id != 'local'").run();
  db.get().prepare('DELETE FROM notifications').run();
  destinations.oublierPilotes();
  destinationSync.reset();
});

// ---------------------------------------------------------------------------
// 1a. Les domaines et la phrase — ce que la page d'Infomaniak permet de dire
// ---------------------------------------------------------------------------

test('domaineMyKsuite reconnaît les trois domaines de la page — et rien d\'autre', () => {
  assert.equal(presets.domaineMyKsuite('camille@ik.me'), 'ik.me');
  assert.equal(presets.domaineMyKsuite('  Camille@IK.ME  '), 'ik.me', 'casse et espaces indifférents');
  assert.equal(presets.domaineMyKsuite('camille@etik.com'), 'etik.com');
  assert.equal(presets.domaineMyKsuite('camille@ikmail.com'), 'ikmail.com');
  assert.equal(presets.domaineMyKsuite('camille@exemple.test'), null);
  // Un domaine qui CONTIENT ik.me sans finir par lui n'est pas my kSuite.
  assert.equal(presets.domaineMyKsuite('camille@ik.me.exemple.test'), null);
  assert.equal(presets.domaineMyKsuite(''), null);
  assert.equal(presets.domaineMyKsuite(undefined), null);
});

test('la configuration kDrive avec une adresse my kSuite est avertie — par les valeurs comme par le bloc', () => {
  const parValeurs = presets.avertissements('webdav', {
    valeurs: { kdriveId: '123456', user: 'camille@ik.me', pass: 'invente' },
  });
  assert.equal(parValeurs.length, 1);
  assert.match(parValeurs[0], /@ik\.me/);
  assert.match(parValeurs[0], /my kSuite/);
  assert.match(parValeurs[0], /la connexion sera refusée/);
  // Un avertissement, jamais un blocage : la phrase dit qu'enregistrer reste possible.
  assert.match(parValeurs[0], /tout de même enregistrer/);

  const parBloc = presets.avertissements('webdav', {
    valeurs: {},
    rcloneConfig: 'type = webdav\nurl = https://123456.connect.kdrive.infomaniak.com\n'
      + 'vendor = other\nuser = camille@etik.com',
  });
  assert.equal(parBloc.length, 1);
  assert.match(parBloc[0], /@etik\.com/);
});

test('une adresse hors my kSuite, ou un serveur WebDAV quelconque, ne sont jamais inquiétés', () => {
  assert.deepEqual(
    presets.avertissements('webdav', {
      valeurs: { kdriveId: '123456', user: 'camille@exemple.test', pass: 'invente' },
    }),
    []
  );
  // Un Nextcloud personnel dont l'identifiant est une adresse en ik.me n'est
  // pas un kDrive : le domaine de l'adresse ne dit rien de CE serveur-là.
  assert.deepEqual(
    presets.avertissements('webdav', {
      valeurs: { url: 'https://nuage.exemple.test/webdav', user: 'camille@ik.me' },
    }),
    []
  );
  // Un autre type peut avoir SES avertissements (la région pCloud, ici) —
  // mais jamais celui des offres kDrive.
  const pcloud = presets.avertissements('pcloud', { valeurs: { user: 'camille@ik.me', token: 'x' } });
  assert.equal(pcloud.some((a) => /my kSuite/.test(a)), false);
});

test('la carte ENREGISTRÉE le dit : l\'avertissement arrive jusqu\'à publicConfigComplet', async () => {
  const cree = destinations.createCloud({ provider: 'kdrive', displayName: 'kDrive essai' });
  destinations.saveConfig(
    cree.id,
    { enabled: false, valeurs: { kdriveId: '123456', user: 'camille@ik.me', pass: 'invente' } },
    presets.of('kdrive').champs
  );
  const vue = await destinations.publicConfigComplet(cree.id);
  assert.ok(
    vue.avertissements.some((a) => /my kSuite/.test(a) && /@ik\.me/.test(a)),
    'la carte porte l\'avertissement d\'offre'
  );
});

// ---------------------------------------------------------------------------
// 1b. La ligne toujours visible de la carte, et son repli
// ---------------------------------------------------------------------------

test('le preset kDrive nomme les offres d\'Infomaniak — les quatre, et aucune inventée', () => {
  const note = presets.of('kdrive').note;
  assert.ok(note?.ligne, 'la note existe');
  for (const offre of ['kSuite Free', 'kSuite Standard', 'my kSuite', 'my kSuite+']) {
    assert.ok(note.ligne.includes(offre), `la ligne visible nomme « ${offre} »`);
  }
  for (const domaine of ['@ik.me', '@etik.com', '@ikmail.com']) {
    assert.ok(note.ligne.includes(domaine), `la ligne visible nomme ${domaine}`);
  }
  // Pas de catégorie qui ne figure pas dans leur documentation.
  assert.equal(/business|professionnel|\bpro\b/i.test(note.ligne + note.detail), false);
  // Le détail cite la page et sa date de lecture ; le lien y mène.
  assert.match(note.detail, /consultée le 09\/09\/2026/);
  assert.equal(note.lien.href, 'https://www.infomaniak.com/fr/support/faq/2408');
  // La liste de choix le dit aussi, avec les mêmes noms.
  assert.match(presets.of('kdrive').resume, /kSuite Free, kSuite Standard, my kSuite et my kSuite\+/);
});

/** Une fonction du VRAI web/admin.js, extraite comme au harnais du lot 75. */
function contexteAdmin(noms) {
  const contexte = vm.createContext({ console, admin: { destinations: [] } });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  vm.runInContext(appSource.match(/^const AIDE_LONGUE = .+$/m)[0], contexte);
  const debutAide = appSource.indexOf('function fieldHelp(');
  vm.runInContext(appSource.slice(debutAide, appSource.indexOf('\n}\n', debutAide) + 3), contexte);
  for (const nom of noms) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans admin.js`);
    vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  }
  return contexte;
}

test('la ligne de la carte ne se replie pas ; le détail et le lien, si', () => {
  const contexte = contexteAdmin(['destNoteProviderHtml']);
  contexte.D = { note: presets.of('kdrive').note };
  const html = vm.runInContext('destNoteProviderHtml(D)', contexte);
  const repli = html.indexOf('<details>');
  assert.ok(repli > 0, 'le repli existe');
  const visible = html.slice(0, repli);
  assert.match(visible, /kSuite Free/, 'les offres sont AVANT le repli — toujours visibles');
  assert.match(visible, /la connexion sera refusée/);
  const replie = html.slice(repli);
  assert.match(replie, /consultée le 09\/09\/2026/);
  assert.match(replie, /href="https:\/\/www\.infomaniak\.com\/fr\/support\/faq\/2408"/);
  assert.match(replie, /rel="noopener"/);
  // Une carte sans note ne dessine rien.
  contexte.D = { note: undefined };
  assert.equal(vm.runInContext('destNoteProviderHtml(D)', contexte), '');
});

// ---------------------------------------------------------------------------
// 1c. L'avertissement à la saisie — avant l'enregistrement, jamais bloquant
// ---------------------------------------------------------------------------

test('messageAvertissementSaisie : la règle du champ, appliquée à la valeur tapée', () => {
  const contexte = contexteAdmin(['messageAvertissementSaisie']);
  contexte.C = presets.CHAMPS_KDRIVE.find((c) => c.key === 'user');
  assert.ok(contexte.C.avertissementSaisie, 'le champ adresse porte sa règle');
  const message = vm.runInContext('messageAvertissementSaisie(C, "camille@ik.me")', contexte);
  assert.match(message, /my kSuite/);
  assert.match(message, /la connexion sera refusée/);
  assert.notEqual(
    vm.runInContext('messageAvertissementSaisie(C, "  Camille@IKMAIL.COM ")', contexte),
    '',
    'casse et espaces indifférents'
  );
  assert.equal(vm.runInContext('messageAvertissementSaisie(C, "camille@exemple.test")', contexte), '');
  assert.equal(vm.runInContext('messageAvertissementSaisie(C, "")', contexte), '');
  assert.equal(
    vm.runInContext('messageAvertissementSaisie({ key: "user" }, "camille@ik.me")', contexte),
    '',
    'un champ sans règle ne dit jamais rien'
  );
});

test('le champ rendu porte sa zone d\'avertissement : remplie pour une valeur enregistrée exclue, en attente sinon', () => {
  const contexte = contexteAdmin(['messageAvertissementSaisie', 'champHtml']);
  contexte.C = { ...presets.CHAMPS_KDRIVE.find((c) => c.key === 'user'), obscurcir: undefined };

  contexte.D = { id: 'kd-essai', valeurs: { user: 'camille@ik.me' }, secretsRenseignes: [], configured: true };
  const dejaExclue = vm.runInContext('champHtml(D, C)', contexte);
  assert.match(dejaExclue, /oninput="majAvertissementSaisie\('kd-essai', 'user'\)"/);
  assert.match(dejaExclue, /id="dest-kd-essai-avert-user"/);
  const zone = dejaExclue.slice(dejaExclue.indexOf('id="dest-kd-essai-avert-user"'));
  assert.match(zone.slice(0, zone.indexOf('</div>')), /my kSuite/, 'la valeur enregistrée est avertie dès le rendu');
  assert.equal(/avert-user"[^>]*hidden/.test(dejaExclue), false);
  // Jamais un blocage : la case reste saisissable.
  assert.equal(/champ-user"[^>]*disabled/.test(dejaExclue), false);

  contexte.D = { id: 'kd-essai', valeurs: { user: 'camille@exemple.test' }, secretsRenseignes: [], configured: true };
  const neutre = vm.runInContext('champHtml(D, C)', contexte);
  assert.match(neutre, /avert-user"[^>]*\n?\s*[^>]*hidden/, 'la zone attend la frappe, cachée');

  // Un champ SANS règle ne porte ni zone ni oninput — rien ne change pour lui.
  contexte.C = { ...presets.CHAMPS_KDRIVE.find((c) => c.key === 'kdriveId'), obscurcir: undefined };
  const sansRegle = vm.runInContext('champHtml(D, C)', contexte);
  assert.equal(sansRegle.includes('majAvertissementSaisie'), false);
  assert.equal(sansRegle.includes('avert-kdriveId'), false);
});

test('le vendor reste « other » — la valeur que la documentation du binaire justifie (décision lot 76)', () => {
  const bloc = presets.of('kdrive').versChamps({
    kdriveId: '123456',
    user: 'camille@exemple.test',
    pass: 'invente',
  });
  assert.equal(bloc.vendor, 'other');
  assert.equal(bloc.url, 'https://123456.connect.kdrive.infomaniak.com');
});

// ---------------------------------------------------------------------------
// 2a. Le serveur : lister, compter, et la route de l'écran
// ---------------------------------------------------------------------------

/** Écrit une notification comme la production le fait, à une date choisie. */
function ecrireNotification({ kind = 'sweep-done', title, body = '[]', createdAt, seenAt = null }) {
  db.get()
    .prepare(
      `INSERT INTO notifications (user_id, kind, title, body, created_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, kind, title, body, createdAt, seenAt);
}

function troisNotifications() {
  ecrireNotification({
    kind: 'sync-failure',
    title: 'Échec de récupération : Fournisseur Essai',
    body: JSON.stringify([{ id: 'fournisseur-essai', nom: 'Fournisseur Essai', message: 'Le site n\'a pas répondu.' }]),
    createdAt: '2026-09-01 01:00:00',
  });
  ecrireNotification({
    kind: 'job-done',
    title: 'Renommage des documents — terminé',
    body: JSON.stringify([{ id: 'chantier', nom: 'Renommage des documents', message: '12 fichiers renommés.' }]),
    createdAt: '2026-09-02 08:00:00',
    seenAt: '2026-09-02 09:00:00',
  });
  // Un corps illisible ne doit pas casser l'écran (même garantie que nonLues).
  ecrireNotification({
    kind: 'sweep-done',
    title: 'Récupération de 3 services terminée',
    body: '{corps illisible',
    createdAt: '2026-09-03 10:00:00',
  });
}

test('lister : tout l\'historique, la plus récente en tête, lues comprises, corps illisible toléré', () => {
  troisNotifications();
  const liste = notifications.lister(userId);
  assert.equal(liste.length, 3);
  assert.deepEqual(
    liste.map((n) => n.createdAt),
    ['2026-09-03 10:00:00', '2026-09-02 08:00:00', '2026-09-01 01:00:00']
  );
  assert.equal(liste[1].seenAt, '2026-09-02 09:00:00', 'les lues restent dans l\'historique');
  assert.deepEqual(liste[0].items, [], 'le corps illisible rend une liste vide, jamais une exception');
  assert.equal(liste[2].items[0].nom, 'Fournisseur Essai');
  assert.equal(notifications.compterNonLues(userId), 2);

  notifications.marquerVues(userId);
  assert.equal(notifications.compterNonLues(userId), 0);
  assert.equal(notifications.lister(userId).length, 3, 'marquer lu ne supprime RIEN');
});

test('la route de l\'écran : l\'historique et le compte des non-lues, sur son propre compte', async () => {
  troisNotifications();
  const reponse = await client.get('/api/users/me/notifications/liste');
  assert.equal(reponse.status, 200);
  assert.equal(reponse.body.nonLues, 2);
  assert.equal(reponse.body.notifications.length, 3);
  assert.equal(reponse.body.notifications[0].title, 'Récupération de 3 services terminée');
});

// ---------------------------------------------------------------------------
// 2b. Le front : rendu pur de l'écran, prouvé hors navigateur
// ---------------------------------------------------------------------------

/** Les fonctions de rendu du VRAI web/app.js, extraites dans un vm. */
function contexteNotifications() {
  const contexte = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  for (const nom of ['noteContexteNotifications', 'cibleNotification', 'notificationHtml', 'notificationsHtml']) {
    const debut = source.indexOf(`function ${nom}(`);
    assert.ok(debut > 0, `${nom} introuvable dans app.js`);
    vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  }
  return contexte;
}

test('une non-lue se distingue et se marque ; une lue le dit ; chaque ligne mène quelque part', () => {
  const contexte = contexteNotifications();
  contexte.NONLUE = {
    id: 7,
    kind: 'sync-failure',
    title: 'Échec de récupération : Fournisseur Essai',
    createdAt: '2026-09-01 01:00:00',
    seenAt: null,
    items: [{ id: 'fournisseur-essai', nom: 'Fournisseur Essai', message: 'Le site n\'a pas répondu.' }],
  };
  const nonLue = vm.runInContext('notificationHtml(NONLUE)', contexte);
  assert.match(nonLue, /notif-item non-lue/);
  assert.match(nonLue, /marquerNotificationsLues\(\[7\]\)/);
  assert.match(nonLue, /Marquer comme lu/);
  // L'apostrophe arrive échappée : le message traverse esc(), comme tout texte.
  assert.match(nonLue, /Fournisseur Essai — Le site n&#39;a pas répondu\./);
  assert.match(nonLue, /ouvrirCibleNotification\('connecteur', 'fournisseur-essai'\)/);
  assert.match(nonLue, /Ouvrir la fiche du service/);

  contexte.LUE = {
    id: 8,
    kind: 'job-done',
    title: 'Renommage des documents — terminé',
    createdAt: '2026-09-02 08:00:00',
    seenAt: '2026-09-02 09:00:00',
    items: [{ id: 'chantier', nom: 'Renommage des documents', message: '12 fichiers renommés.' }],
  };
  const lue = vm.runInContext('notificationHtml(LUE)', contexte);
  assert.equal(lue.includes('non-lue'), false);
  assert.equal(lue.includes('Marquer comme lu'), false);
  assert.match(lue, />Lue</);
  assert.match(lue, /ouvrirCibleNotification\('chantier', ''\)/);
  assert.match(lue, /Voir les chantiers de fichiers/);
});

test('l\'écran : la ligne du contexte non sécurisé quand elle est vraie, le geste global quand il sert', () => {
  const contexte = contexteNotifications();
  contexte.LISTE = [
    { id: 2, kind: 'sweep-done', title: 'Récupération de 2 services terminée', createdAt: '2026-09-03 10:00:00', seenAt: null, items: [] },
  ];

  const enHttp = vm.runInContext('notificationsHtml(LISTE, 1, false)', contexte);
  assert.match(enHttp, /http:\/\//);
  assert.match(enHttp, /https:\/\//);
  assert.match(enHttp, /pas de\s+crabe lui-même/, 'le geste est du ressort de l\'hébergement, et on le dit');
  assert.match(enHttp, /1 notification\(s\) non lue\(s\)/);
  assert.match(enHttp, /Tout marquer comme lu/);

  const enHttps = vm.runInContext('notificationsHtml(LISTE, 0, true)', contexte);
  assert.equal(/les navigateurs les réservent/.test(enHttps), false, 'en contexte sûr, pas de ligne d\'excuse');
  assert.equal(enHttps.includes('Tout marquer comme lu'), false, 'rien à marquer, pas de bouton');
  assert.match(enHttps, /Rien de non lu/);

  const vide = vm.runInContext('notificationsHtml([], 0, true)', contexte);
  assert.match(vide, /Aucune notification pour l'instant/);
});

test('rien ne ment : une notification dont l\'objet a disparu reste entière — le nom fut écrit avec elle', () => {
  const contexte = contexteNotifications();
  contexte.ORPHELINE = {
    id: 9,
    kind: 'sync-failure',
    title: 'Échec de récupération : Service Disparu',
    createdAt: '2026-09-01 01:00:00',
    seenAt: null,
    items: [{ id: 'service-disparu', nom: 'Service Disparu', message: 'Identifiants refusés.' }],
  };
  const html = vm.runInContext('notificationHtml(ORPHELINE)', contexte);
  // Le rendu est PUR : aucune résolution d'identifiant, le nom vient du corps.
  assert.match(html, /Service Disparu — Identifiants refusés\./);
});

// ---------------------------------------------------------------------------
// 3. Darty : le message de renvoi parle en jours, comme la mesure
// ---------------------------------------------------------------------------

test('le renvoi vers l\'authentification annonce des JOURS — des semaines, c\'était attendre une expiration déjà consommée', () => {
  const err = profilMarchand.erreurRenvoiVersAuthentification('Sonde lot 76');
  assert.match(err.message, /date de plusieurs jours/);
  assert.equal(/plusieurs semaines/.test(err.message), false);
  assert.equal(err.renvoiAuthentification, true, 'le marqueur du lot 71 tient toujours');
});
