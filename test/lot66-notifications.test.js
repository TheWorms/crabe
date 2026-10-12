'use strict';

/**
 * Lot 66 — les notifications n'arrivaient pas. Elles arrivent.
 *
 * Cinq maillons pouvaient rompre la chaîne, et l'enquête en a trouvé quatre
 * abîmés à des degrés divers sur l'installation réelle. Les tests ci-dessous
 * mordent là où une erreur coûte quelque chose :
 *
 *   - **un événement notifiable produit vraiment un envoi.** Le piège de ce
 *     lot est précisément là : un service d'envoi impeccable que personne
 *     n'appelle passe tous les tests unitaires du monde sans rien envoyer.
 *     C'est ce qui s'est produit pendant deux mois. On appelle donc le VRAI
 *     planificateur, et on regarde si la série se constitue ;
 *   - **rien n'échoue en silence.** Chacune des quatre issues qui n'envoient
 *     pas doit nommer sa cause au journal ;
 *   - **aucun secret dans les traces** ;
 *   - **la permission du navigateur n'est jamais demandée au chargement**, et
 *     l'écran dit l'état RÉEL — y compris « ici, c'est impossible ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');
const notifications = require('../server/notifications');
const emailTemplates = require('../server/email-templates');
const preferences = require('../server/preferences');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const registry = require('../server/connectors/registry');
const db = require('../server/db/db');

const WEB = path.resolve(__dirname, '..', 'web');

/** Adresse d'essai — jamais une adresse réelle dans un test (§1bis). */
const ADRESSE = 'camille@exemple.fr';

/** Mot de passe d'essai : on prouve qu'il ne fuit NULLE PART dans les journaux. */
const MOT_DE_PASSE_SMTP = 'ceci-ne-doit-jamais-para1tre';

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'lot66', role: 'admin' });
  registry.load();
  registry.syncCatalog();
  destinations.restoreLocal();
  db.get().prepare('UPDATE users SET email = ? WHERE id = ?').run(ADRESSE, compte.id);
});

test.after(() => {
  notifications.stop();
  helpers.teardown();
});

/** Les lignes de journal de source `notifications`, du plus récent au plus vieux. */
function journalNotifications(limite = 20) {
  return db
    .get()
    .prepare("SELECT level, message FROM app_logs WHERE source = 'notifications' ORDER BY id DESC LIMIT ?")
    .all(limite);
}

function viderJournal() {
  db.get().prepare("DELETE FROM app_logs WHERE source IN ('notifications', 'mailer')").run();
}

/** Coupe le SMTP : c'est l'état par défaut d'une installation. */
function sansSmtp() {
  db.get().prepare('UPDATE security_policy SET smtp_host = NULL WHERE id = 1').run();
}

/**
 * Un SMTP qui répond « connexion refusée » tout de suite, avec un mot de passe
 * enregistré. Le port 1 n'écoute nulle part : l'échec est instantané et n'ouvre
 * aucune connexion vers l'extérieur.
 */
function smtpQuiRefuse() {
  const crypto = require('../server/crypto');
  db.get()
    .prepare(
      `UPDATE security_policy
          SET smtp_host = '127.0.0.1', smtp_port = 1, smtp_user = ?, smtp_from = ?,
              smtp_secure = 'none', smtp_pass_encrypted = ?
        WHERE id = 1`
    )
    .run(ADRESSE, ADRESSE, crypto.encrypt(MOT_DE_PASSE_SMTP));
}

// ===========================================================================
// 1. Un événement notifiable produit VRAIMENT un envoi
// ===========================================================================

test('le planificateur alimente lui-même la série : ce n\'est pas au test de le faire', async () => {
  // ⚠ LE test du lot. `signalerRecuperationManuelle()` peut être parfait et ne
  // servir à rien si personne ne l'appelle — c'est exactement l'état des lieux
  // trouvé à l'entrée : un `signalerEchec()` irréprochable, branché sur le seul
  // déclencheur `cron`, qui n'avait jamais eu une seule occasion de tirer.
  //
  // On passe donc par la VRAIE fonction du planificateur, sur le chemin
  // d'échec le plus court qui soit (compte inactif), et on regarde si la série
  // s'est constituée toute seule.
  notifications.start();
  await notifications.cloreBalayee(compte.id);

  const dormant = await helpers.createUser({ username: 'lot66-dormant', role: 'admin' });
  db.get().prepare("UPDATE users SET status = 'inactive' WHERE id = ?").run(dormant.id);

  assert.equal(notifications.balayeesSize, 0, 'rien en attente au départ');
  await scheduler.runForUser(dormant.id, 'free', 'manual');
  assert.equal(notifications.balayeesSize, 1, 'une récupération manuelle ouvre une série');

  // Un déclencheur `test` n'est pas un chantier : il ne doit rien alimenter.
  await scheduler.runForUser(dormant.id, 'amazon', 'test');
  const bilanTest = await notifications.cloreBalayee(dormant.id);
  assert.equal(bilanTest.services, 1, 'l\'essai est resté dehors, seule la manuelle compte');
});

test('une série lancée à la main donne UN message, et n\'y détaille que les échecs', async () => {
  notifications.start();
  sansSmtp();
  const user = { id: compte.id, username: compte.username };

  notifications.signalerRecuperationManuelle(user, { connectorId: 'free', nom: 'Free Internet', ok: true, message: '3 factures récupérées' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'darty', nom: 'Darty', ok: false, message: 'Votre connexion a expiré.' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'edf', nom: 'EDF', ok: false, message: 'Site gardé par un dispositif anti-robot.' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'ovh', nom: 'OVHcloud', ok: true, message: 'Aucune nouvelle facture' });

  const bilan = await notifications.cloreBalayee(compte.id);
  assert.equal(bilan.services, 4);
  assert.equal(bilan.echecs, 2);

  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, 'Récupération de 4 services terminée — 2 en échec');
  assert.deepEqual(
    notif.items.map((i) => i.nom),
    ['Darty', 'EDF'],
    'les vingt réussites d\'une balayée noieraient les deux lignes qui demandent quelque chose'
  );
  assert.equal(notif.items[0].message, 'Votre connexion a expiré.', 'le motif voyage avec le service');
  notifications.marquerVues(compte.id);
});

test('une série sans aucun échec se dit quand même — un chantier de deux heures a une fin', async () => {
  notifications.start();
  const user = { id: compte.id, username: compte.username };
  notifications.signalerRecuperationManuelle(user, { connectorId: 'free', nom: 'Free Internet', ok: true, message: 'ok' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'ovh', nom: 'OVHcloud', ok: true, message: 'ok' });

  const bilan = await notifications.cloreBalayee(compte.id);
  assert.equal(bilan.echecs, 0);
  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, 'Récupération de 2 services terminée');
  assert.deepEqual(notif.items, [], 'aucun échec à détailler');
  notifications.marquerVues(compte.id);
});

test('UN service lancé seul ne notifie rien : son résultat est déjà à l\'écran', async () => {
  notifications.start();
  notifications.signalerRecuperationManuelle(
    { id: compte.id, username: compte.username },
    { connectorId: 'free', nom: 'Free Internet', ok: false, message: 'Identifiants refusés' }
  );
  const bilan = await notifications.cloreBalayee(compte.id);
  assert.equal(bilan.ignoree, true);
  assert.equal(bilan.envoye, false);
  assert.equal(notifications.nonLues(compte.id).length, 0, 'pas même une trace : ce serait du bruit');
});

test('le même service relancé deux fois dans la série ne compte qu\'une fois', async () => {
  notifications.start();
  const user = { id: compte.id, username: compte.username };
  notifications.signalerRecuperationManuelle(user, { connectorId: 'darty', nom: 'Darty', ok: false, message: 'Première tentative' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'darty', nom: 'Darty', ok: true, message: 'Deuxième tentative : 2 factures' });
  notifications.signalerRecuperationManuelle(user, { connectorId: 'free', nom: 'Free Internet', ok: true, message: 'ok' });

  const bilan = await notifications.cloreBalayee(compte.id);
  assert.equal(bilan.services, 2, 'deux services, pas trois');
  assert.equal(bilan.echecs, 0, 'la deuxième tentative a réussi : le dernier résultat fait foi');
  notifications.marquerVues(compte.id);
});

test('la série ne se clôt PAS tant qu\'une récupération tourne encore', async (t) => {
  // Sans cette règle, les 71 minutes mesurées de `paybyphone` couperaient une
  // balayée en deux et enverraient deux bilans au lieu d'un.
  notifications.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let occupe = true;
    const user = { id: compte.id, username: compte.username };
    notifications.signalerRecuperationManuelle(
      user,
      { connectorId: 'free', nom: 'Free Internet', ok: true, message: 'ok' },
      { enCours: () => occupe }
    );
    notifications.signalerRecuperationManuelle(
      user,
      { connectorId: 'ovh', nom: 'OVHcloud', ok: true, message: 'ok' },
      { enCours: () => occupe }
    );

    // Dix fois le délai de silence : tant que quelque chose tourne, rien ne part.
    t.mock.timers.tick(notifications.SILENCE_BALAYEE_MS * 10);
    assert.equal(notifications.balayeesSize, 1, 'la série attend le service en cours');
    assert.equal(notifications.nonLues(compte.id).length, 0);

    // Le dernier service se termine : le silence prend enfin son sens.
    occupe = false;
    t.mock.timers.tick(notifications.SILENCE_BALAYEE_MS + 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(notifications.balayeesSize, 0, 'la série est close');
  } finally {
    t.mock.timers.reset();
  }
  const [notif] = notifications.nonLues(compte.id);
  assert.ok(notif, 'et le bilan a bien été écrit');
  assert.match(notif.title, /2 services terminée/);
  notifications.marquerVues(compte.id);
});

test('un chantier long se dit ; un chantier qu\'on a regardé se faire, non', async () => {
  notifications.start();
  const user = { id: compte.id, username: compte.username };

  const court = await notifications.signalerChantier(user, {
    chantier: 'Renommage des documents',
    resume: 'Rien à renommer.',
    dureeMs: 4_000,
  });
  assert.equal(court.ignoree, true, 'quatre secondes : l\'écran l\'a déjà dit');
  assert.equal(notifications.nonLues(compte.id).length, 0);

  // Le renommage réel mesuré : 3 h 13 pour 330 documents.
  await notifications.signalerChantier(user, {
    chantier: 'Renommage des documents',
    resume: '330 document(s) renommé(s). Les noms suivent maintenant la convention choisie.',
    dureeMs: 3 * 3600_000 + 13 * 60_000,
  });
  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, 'Renommage des documents — terminé');
  assert.match(notif.items[0].message, /330 document/);
  notifications.marquerVues(compte.id);
});

test('un chantier interrompu le dit dans son titre', async () => {
  notifications.start();
  await notifications.signalerChantier(
    { id: compte.id, username: compte.username },
    { chantier: 'Renommage des documents', resume: 'Arrêté net.', dureeMs: 900_000, echec: true }
  );
  const [notif] = notifications.nonLues(compte.id);
  assert.equal(notif.title, 'Renommage des documents — interrompu');
  notifications.marquerVues(compte.id);
});

test('le modèle d\'e-mail « chantier terminé » existe et se remplit', () => {
  assert.ok(emailTemplates.definition('job-finished'), 'sans lui, aucun bilan ne peut partir');
  const rendu = emailTemplates.render('job-finished', {
    utilisateur: 'camille',
    chantier: 'Renommage des documents',
    resume: '330 document(s) renommé(s).',
    detail: 'Rien d\'autre à faire de votre côté.',
    date: '26/08/2026 23:09',
  });
  assert.match(rendu.subject, /Renommage des documents/);
  assert.match(rendu.text, /330 document/);
  assert.doesNotMatch(rendu.text, /\{\{/, 'aucun marqueur laissé en place : toutes les variables sont fournies');
});

// ===========================================================================
// 2. Rien n'échoue en silence
// ===========================================================================

test('canal e-mail éteint : la trace existe, et le journal dit POURQUOI rien n\'est parti', async () => {
  notifications.start();
  viderJournal();
  preferences.set(compte.id, 'notifications.echecs.email', false);

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'ovh', 'OVHcloud', 'Clé refusée');
  const envoi = await notifications.envoyer(compte.id);

  assert.equal(envoi.envoye, false);
  assert.ok(envoi.groupeId, 'la trace en base reste : c\'est le seul signal qui subsiste');

  const [ligne] = journalNotifications();
  assert.ok(ligne, 'AUCUNE ligne de journal = exactement le silence qu\'on corrige');
  assert.match(ligne.message, /éteint l'envoi par e-mail/);
  assert.match(ligne.message, /Profil/, 'le journal dit où le rallumer, pas seulement que c\'est éteint');

  preferences.set(compte.id, 'notifications.echecs.email', true);
  notifications.marquerVues(compte.id);
});

test('aucun SMTP configuré : le journal le dit, et dit où le configurer', async () => {
  notifications.start();
  viderJournal();
  sansSmtp();

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'free', 'Free Internet', 'Panne');
  await notifications.envoyer(compte.id);

  const [ligne] = journalNotifications();
  assert.equal(ligne.level, 'warn', 'ce n\'est pas une information anodine : personne n\'est prévenu');
  assert.match(ligne.message, /aucun serveur d'envoi n'est configuré/);
  assert.match(ligne.message, /SMTP/);
  notifications.marquerVues(compte.id);
});

test('aucune adresse sur le compte : le journal le dit', async () => {
  notifications.start();
  viderJournal();
  smtpQuiRefuse();
  db.get().prepare('UPDATE users SET email = NULL WHERE id = ?').run(compte.id);

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'free', 'Free Internet', 'Panne');
  await notifications.envoyer(compte.id);

  const [ligne] = journalNotifications();
  assert.equal(ligne.level, 'warn');
  assert.match(ligne.message, /aucune adresse e-mail n'est renseignée/);

  db.get().prepare('UPDATE users SET email = ? WHERE id = ?').run(ADRESSE, compte.id);
  notifications.marquerVues(compte.id);
});

test('le SMTP refuse : l\'échec est journalisé en ERREUR, avec sa cause — jamais avalé', async () => {
  notifications.start();
  viderJournal();
  smtpQuiRefuse();

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'darty', 'Darty', 'Session expirée');
  const envoi = await notifications.envoyer(compte.id);
  assert.equal(envoi.envoye, false);

  const lignes = journalNotifications();
  const erreur = lignes.find((l) => l.level === 'error');
  assert.ok(erreur, 'un envoi refusé qui ne laisse aucune erreur au journal est un envoi perdu');
  assert.match(erreur.message, /l'envoi par e-mail a échoué/);
  assert.match(erreur.message, /ECONNREFUSED|refus/i, 'la cause est nommée, pas « erreur »');
  notifications.marquerVues(compte.id);
});

test('AUCUN secret dans les traces : ni mot de passe SMTP, ni passphrase', async () => {
  notifications.start();
  viderJournal();
  smtpQuiRefuse();

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'free', 'Free Internet', 'Panne');
  await notifications.envoyer(compte.id);

  const toutes = db
    .get()
    .prepare("SELECT message FROM app_logs WHERE source IN ('notifications', 'mailer')")
    .all()
    .map((r) => r.message)
    .join('\n');
  assert.ok(toutes.length > 0, 'il y a bien quelque chose à inspecter');
  assert.ok(!toutes.includes(MOT_DE_PASSE_SMTP), 'le mot de passe SMTP ne doit apparaître nulle part');
  assert.ok(
    !toutes.includes(process.env.CRABE_MASTER_PASSPHRASE),
    'la passphrase maîtresse ne doit apparaître nulle part'
  );
  notifications.marquerVues(compte.id);
});

test('l\'arrêt du serveur n\'oublie ni les échecs en attente ni la série en cours', async () => {
  // DEUX comptes, et c'est le point : avec un seul, vider les échecs planifiés
  // viderait la série au passage sans qu'on puisse s'en apercevoir. Ici le
  // second compte n'a QUE la série — si l'arrêt ne regarde pas les séries, elle
  // est perdue pour de bon.
  notifications.start();
  sansSmtp();
  const autre = await helpers.createUser({ username: 'lot66-arret', role: 'admin' });

  notifications.signalerEchec({ id: compte.id, username: compte.username }, 'free', 'Free Internet', 'Panne');
  const surAutre = { id: autre.id, username: autre.username };
  notifications.signalerRecuperationManuelle(surAutre, { connectorId: 'darty', nom: 'Darty', ok: false, message: 'Expirée' });
  notifications.signalerRecuperationManuelle(surAutre, { connectorId: 'ovh', nom: 'OVHcloud', ok: true, message: 'ok' });

  assert.equal(notifications.enAttenteSize, 1);
  assert.equal(notifications.balayeesSize, 1);
  await notifications.viderTout();
  assert.equal(notifications.enAttenteSize, 0);
  assert.equal(notifications.balayeesSize, 0);

  assert.deepEqual(
    notifications.nonLues(compte.id).map((n) => n.title),
    ['Échec de récupération : Free Internet'],
    'le passage planifié est parti'
  );
  const [bilan] = notifications.nonLues(autre.id);
  assert.ok(bilan, 'la série d\'un compte qui n\'a rien d\'autre en attente ne doit pas être perdue');
  assert.match(bilan.title, /2 services terminée/, 'un bilan partiel vaut mieux que rien');

  notifications.marquerVues(compte.id);
  notifications.marquerVues(autre.id);
});

// ===========================================================================
// 3. L'écran : l'autorisation, et la vérité
// ===========================================================================

/**
 * Le VRAI `web/app.js`, dans un bac à sable où l'on choisit le contexte du
 * navigateur. On exécute le code déployé, on ne recopie pas sa logique.
 */
function ecranProfil({ securise = true, permission = 'default', reglages = {}, smtp = true, email = ADRESSE } = {}) {
  const zone = { innerHTML: '' };
  const toasts = [];
  const compteur = { demandes: 0 };

  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === 'profil-notifications' ? zone : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { classList: { add() {}, remove() {}, contains: () => false } },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/', hash: '', search: '' },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    isSecureContext: securise,
  };
  if (permission !== null) {
    const Notif = function () {};
    Notif.permission = permission;
    Notif.requestPermission = async () => {
      compteur.demandes += 1;
      return Notif.permission;
    };
    sandbox.Notification = Notif;
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  vm.runInContext('showToast = (m) => { __toasts.push(m); };', Object.assign(context, { __toasts: toasts }));
  vm.runInContext(
    `state.smtpConfigured = ${JSON.stringify(smtp)};`
    + `state.me = ${JSON.stringify({ email, username: 'camille' })};`
    + `prefs.values = ${JSON.stringify(reglages)};`,
    context
  );
  return {
    zone,
    toasts,
    compteur,
    run: (code) => vm.runInContext(code, context),
    rendre() {
      vm.runInContext('renderNotificationsReglage()', context);
      return zone.innerHTML;
    },
  };
}

test('l\'autorisation n\'est JAMAIS demandée au chargement de la page', () => {
  // Un navigateur moderne refuse une demande qui ne suit pas un geste — et une
  // question surgie toute seule est de toute façon une question à laquelle on
  // répond « non ».
  const ecran = ecranProfil({ securise: true, permission: 'default' });
  assert.equal(ecran.compteur.demandes, 0, 'le seul chargement de app.js n\'a rien demandé');
  ecran.rendre();
  assert.equal(ecran.compteur.demandes, 0, 'dessiner l\'écran non plus');
});

test('contexte sûr, jamais demandée : un bouton, et il ne tire QUE sur le clic', async () => {
  const ecran = ecranProfil({ securise: true, permission: 'default' });
  const html = ecran.rendre();
  assert.match(html, /Autoriser les notifications/, 'le geste doit exister quelque part');
  assert.match(html, /onclick="demanderAutorisationNotifications\(this\)"/);
  assert.equal(ecran.compteur.demandes, 0);

  await ecran.run('demanderAutorisationNotifications(null)');
  assert.equal(ecran.compteur.demandes, 1, 'le clic, et le clic seul, pose la question');
});

test('adresse en http:// : l\'écran le dit franchement, et ne promet rien', () => {
  // L'état RÉEL mesuré sur le compte observé : Firefox 153 et Chromium 151 rendent tous
  // deux `isSecureContext = false` et `permission = "denied"` sur
  // http://crabe.local — le navigateur refuse AVANT de poser la question.
  const ecran = ecranProfil({ securise: false, permission: 'denied' });
  const html = ecran.rendre();

  assert.match(html, /ne peuvent pas fonctionner/, 'le constat se dit en toutes lettres');
  assert.match(html, /https:\/\//, 'et la condition qui le lèverait est nommée');
  assert.match(html, /passerelle/, 'ainsi que l\'endroit où elle se règle — hors de crabe');
  assert.doesNotMatch(
    html,
    /vous demandera l'autorisation/,
    'promettre une question qui ne viendra jamais est pire que se taire'
  );
  assert.doesNotMatch(
    html,
    /réautorisez-les dans ses réglages/,
    'accuser les réglages du navigateur pour un problème d\'adresse envoie chercher au mauvais endroit'
  );
  assert.doesNotMatch(html, /Autoriser les notifications<\/button>/, 'aucun bouton qui ne peut pas aboutir');
});

test('basculer l\'interrupteur sur une adresse non sûre ne demande rien au navigateur', async () => {
  // `requestPermission()` rendrait « refusée » sans rien afficher : l'appeler
  // laisserait croire que la question a été posée.
  const ecran = ecranProfil({ securise: false, permission: 'denied' });
  ecran.run('api = async () => ({ preferences: { "notifications.echecs.navigateur": true } });');
  await ecran.run('basculerNotification("navigateur", true)');
  assert.equal(ecran.compteur.demandes, 0);
});

test('refus en contexte sûr : l\'écran renvoie aux réglages du site, sans bouton', () => {
  const ecran = ecranProfil({ securise: true, permission: 'denied' });
  const html = ecran.rendre();
  assert.match(html, /a refusé les notifications pour ce site/);
  assert.match(html, /ne peut plus vous le redemander/, 'un refus ne se redemande pas : les navigateurs l\'interdisent');
  assert.match(html, /réglages du site/);
  assert.doesNotMatch(html, /Autoriser les notifications<\/button>/);
});

test('autorisation accordée : l\'écran le dit, et ne redemande rien', () => {
  const ecran = ecranProfil({
    securise: true,
    permission: 'granted',
    reglages: { 'notifications.echecs.navigateur': true },
  });
  const html = ecran.rendre();
  assert.match(html, /accordée/);
  assert.equal(ecran.compteur.demandes, 0);
  assert.match(html, /Vous serez prévenu/, 'les deux canaux fonctionnent : le verdict est positif');
});

test('l\'état du compte observé, tel quel : l\'écran dit qu\'AUCUNE notification ne peut arriver', () => {
  // Mesuré en base le 26/08/2026 : e-mail éteint, navigateur allumé, adresse
  // en http://. Deux interrupteurs qui semblent en ordre, et rien qui parte.
  const ecran = ecranProfil({
    securise: false,
    permission: 'denied',
    smtp: true,
    reglages: {
      'notifications.echecs.email': false,
      'notifications.echecs.navigateur': true,
    },
  });
  const html = ecran.rendre();
  assert.match(html, /Aujourd'hui, aucune notification ne peut vous parvenir/);
  assert.match(html, /l'envoi par e-mail est éteint ci-dessous/, 'le canal rattrapable est nommé le premier');
  assert.match(html, /impossible sur une adresse en http:\/\//);
});

test('SMTP absent : le verdict le dit, même interrupteur allumé', () => {
  const ecran = ecranProfil({ securise: false, permission: 'denied', smtp: false, reglages: {} });
  const html = ecran.rendre();
  assert.match(html, /Aujourd'hui, aucune notification ne peut vous parvenir/);
  assert.match(html, /aucun serveur d'envoi n'est configuré/);
});

test('aucune adresse sur le compte : le verdict le dit', () => {
  const ecran = ecranProfil({ securise: true, permission: 'default', smtp: true, email: '' });
  const html = ecran.rendre();
  assert.match(html, /Aujourd'hui, aucune notification ne peut vous parvenir/);
  assert.match(html, /aucune adresse e-mail n'est renseignée/);
});

test('l\'écran annonce les trois événements couverts, et seulement eux', () => {
  const ecran = ecranProfil({ securise: true, permission: 'granted', reglages: { 'notifications.echecs.navigateur': true } });
  const html = ecran.rendre();
  assert.match(html, /automatique/, 'les récupérations planifiées');
  assert.match(html, /série de récupérations lancée à la main/);
  assert.match(html, /renommage des\s+documents/);
  assert.match(html, /Rien pour une récupération réussie lancée depuis cet\s+écran/,
    'la promesse de ne PAS inonder fait partie de ce qu\'on affiche');
});
