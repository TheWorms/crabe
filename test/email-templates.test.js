'use strict';

/**
 * Modèles d'e-mail : substitution des variables, personnalisation, aperçu, et
 * dégradation propre quand aucun serveur SMTP n'est joignable.
 *
 * Rappel de contrainte : le SMTP n'a jamais tourné en conditions réelles. Rien
 * ici ne doit planter faute de serveur — l'utilisateur reçoit un message qui
 * dit ce qui a échoué, et le reste de crabe continue de fonctionner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const templates = require('../server/email-templates');
const mailer = require('../server/mailer');
const permissions = require('../server/permissions');

let admin;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({
    username: 'postier',
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
// Substitution
// ---------------------------------------------------------------------------

test('les variables sont remplacées, avec ou sans espaces dans le marqueur', () => {
  const text = 'Bonjour {{utilisateur}}, voici {{ lien }} — {{utilisateur}} encore.';
  assert.equal(
    templates.substitute(text, { utilisateur: 'camille', lien: 'http://crabe.local/x' }),
    'Bonjour camille, voici http://crabe.local/x — camille encore.'
  );
});

test('un marqueur inconnu reste visible tel quel', () => {
  // Une faute de frappe doit se voir dans l'aperçu, pas disparaître du message.
  assert.equal(
    templates.substitute('Bonjour {{utilisateurr}}', { utilisateur: 'camille' }),
    'Bonjour {{utilisateurr}}'
  );
});

test('une valeur nulle ou absente ne vide pas le message', () => {
  assert.equal(templates.substitute('a {{x}} b', { x: null }), 'a {{x}} b');
  assert.equal(templates.substitute('a {{x}} b', {}), 'a {{x}} b');
  assert.equal(templates.substitute('a {{x}} b', { x: 0 }), 'a 0 b');
  assert.equal(templates.substitute('a {{x}} b', { x: '' }), 'a  b');
});

test('la substitution ne casse pas sur une entrée vide', () => {
  assert.equal(templates.substitute(undefined, { x: 1 }), '');
  assert.equal(templates.substitute('', {}), '');
});

// ---------------------------------------------------------------------------
// Modèles livrés
// ---------------------------------------------------------------------------

test('les six modèles demandés existent et sont complets', () => {
  // `job-finished` est arrivé au lot 66 : c'est lui qui porte le bilan d'un
  // chantier lancé à la main — une série de récupérations, un renommage. Sans
  // modèle, aucun de ces bilans ne peut partir, et la liste ci-dessous est le
  // seul endroit qui s'en apercevrait.
  const attendus = [
    'email-change-confirm',
    'email-change-notice',
    'password-reset',
    'connector-failure',
    'job-finished',
    'gdpr-archive',
  ];
  assert.deepEqual(templates.KEYS, attendus);

  for (const key of attendus) {
    const t = templates.get(key);
    assert.ok(t.subject.trim(), `${key} : objet non vide`);
    assert.ok(t.body.trim(), `${key} : corps non vide`);
    assert.ok(t.variables.length, `${key} : au moins une variable documentée`);
    assert.equal(t.customized, false, `${key} : livré non personnalisé`);
  }
});

test('chaque variable utilisée dans un modèle est documentée', () => {
  for (const t of templates.list()) {
    const utilisées = new Set(
      [...`${t.subject}\n${t.body}`.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1])
    );
    const documentées = new Set(t.variables.map((v) => v.name));
    for (const nom of utilisées) {
      assert.ok(documentées.has(nom), `${t.key} utilise {{${nom}}} sans le documenter`);
    }
  }
});

test('l\'aperçu remplit le modèle avec les valeurs d\'exemple', () => {
  const rendu = templates.preview('email-change-confirm');
  assert.match(rendu.text, /camille/);
  assert.match(rendu.text, /confirm-email\?token=/);
  assert.equal(/\{\{/.test(rendu.text), false, 'aucun marqueur ne survit à l\'aperçu');
  assert.equal(/\{\{/.test(rendu.subject), false);
});

test('un objet peut lui aussi porter une variable', () => {
  const rendu = templates.preview('connector-failure');
  assert.match(rendu.subject, /Free Internet/);
});

// ---------------------------------------------------------------------------
// Personnalisation
// ---------------------------------------------------------------------------

test('un modèle enregistré remplace le modèle par défaut, et se réinitialise', () => {
  const avant = templates.get('password-reset');

  const modifié = templates.save('password-reset', {
    subject: 'Nouveau mot de passe pour {{utilisateur}}',
    body: 'Bonjour {{utilisateur}}, voici votre lien : {{lien}}',
  });
  assert.equal(modifié.customized, true);
  assert.equal(modifié.subject, 'Nouveau mot de passe pour {{utilisateur}}');

  const rendu = templates.render('password-reset', { utilisateur: 'camille', lien: 'http://x' });
  assert.equal(rendu.subject, 'Nouveau mot de passe pour camille');
  assert.equal(rendu.text, 'Bonjour camille, voici votre lien : http://x');

  const restauré = templates.reset('password-reset');
  assert.equal(restauré.customized, false);
  assert.equal(restauré.subject, avant.subject);
  assert.equal(restauré.body, avant.body);
});

test('un modèle vide est refusé, un modèle inconnu aussi', () => {
  assert.throws(() => templates.save('password-reset', { subject: ' ', body: 'x' }), /obligatoires/);
  assert.throws(() => templates.save('password-reset', { subject: 'x', body: '  ' }), /obligatoires/);
  assert.throws(() => templates.save('nexiste-pas', { subject: 'x', body: 'y' }), /inconnu/);
  assert.throws(() => templates.render('nexiste-pas'), /inconnu/);
});

test('réenregistrer le texte par défaut n\'affiche pas « personnalisé »', () => {
  const base = templates.get('gdpr-archive');
  const saved = templates.save('gdpr-archive', { subject: base.subject, body: base.body });
  assert.equal(saved.customized, false);
});

// ---------------------------------------------------------------------------
// Le changement d'adresse utilise bien les modèles
// ---------------------------------------------------------------------------

test('le changement d\'adresse e-mail passe par les modèles modifiables', async (t) => {
  const outbox = [];
  const vraiSend = mailer.send;
  const vraiTrySend = mailer.trySend;
  const vraiIsConfigured = mailer.isConfigured;

  mailer.isConfigured = () => true;
  mailer.send = async (m) => {
    outbox.push(m);
    return { ok: true };
  };
  mailer.trySend = async (m) => {
    outbox.push(m);
    return { ok: true };
  };
  t.after(() => {
    mailer.send = vraiSend;
    mailer.trySend = vraiTrySend;
    mailer.isConfigured = vraiIsConfigured;
    templates.reset('email-change-confirm');
  });

  templates.save('email-change-confirm', {
    subject: 'Objet sur mesure pour {{utilisateur}}',
    body: 'Lien : {{lien}} (valable {{heures}} h)',
  });

  const emailChange = require('../server/email-change');
  const user = await helpers.createUser({ username: 'destinataire', plainPassword: 'MotDePasse1' });
  await emailChange.request(user, 'ailleurs@test.local', { baseUrl: 'http://crabe.local' });

  assert.equal(outbox[0].subject, 'Objet sur mesure pour destinataire');
  assert.match(outbox[0].text, /^Lien : http:\/\/crabe\.local\/confirm-email\?token=[0-9a-f]{64} \(valable 24 h\)$/);
});

// ---------------------------------------------------------------------------
// Dégradation sans serveur SMTP
// ---------------------------------------------------------------------------

test('sans SMTP configuré, l\'erreur est explicite et porte un code', () => {
  assert.equal(mailer.isConfigured(), false);
  assert.throws(() => mailer.transport(), (err) => {
    assert.equal(err.code, 'SMTP_NOT_CONFIGURED');
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /non configuré/);
    return true;
  });
});

test('le mode de chiffrement se déduit du port tant qu\'il n\'est pas choisi', () => {
  assert.equal(mailer.secureMode({ smtp_port: 465 }), 'tls');
  assert.equal(mailer.secureMode({ smtp_port: 587 }), 'starttls');
  assert.equal(mailer.secureMode({ smtp_port: 465, smtp_secure: 'starttls' }), 'starttls');
  assert.equal(mailer.secureMode({ smtp_port: 587, smtp_secure: 'none' }), 'none');
  assert.equal(mailer.secureMode({ smtp_secure: 'valeur-invalide' }), 'starttls');
});

test('chaque famille d\'échec SMTP donne un message actionnable', () => {
  const ctx = { host: 'smtp.exemple.fr', port: 587 };
  const cas = [
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, /DNS/],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, /refusée/],
    [{ code: 'ETIMEDOUT', message: 'timeout' }, /Délai dépassé/],
    [{ code: 'EAUTH', message: 'Invalid login' }, /Authentification refusée/],
    [{ code: 'ESOCKET', message: 'self signed certificate' }, /TLS/],
    [{ code: 'EENVELOPE', message: 'Recipient rejected' }, /Adresse refusée/],
    [{ message: 'quelque chose d\'inattendu' }, /Échec de l'envoi/],
  ];

  for (const [err, attendu] of cas) {
    const message = mailer.describeError(err, ctx);
    assert.match(message, attendu);
    // Toujours une phrase lisible, jamais « [object Object] » ni du vide.
    assert.ok(message.length > 20, `message trop court : ${message}`);
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('l\'écran SMTP reçoit configuration, modes de chiffrement et modèles', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'postier', 'MotDePasse1');

  const res = await client.get('/api/system/smtp');
  assert.equal(res.status, 200);
  assert.equal(res.body.smtp.ready, false, 'aucun hôte configuré au départ');
  assert.equal(res.body.smtp.configured, false);
  assert.equal('password' in res.body.smtp, false, 'le mot de passe ne sort jamais');
  assert.deepEqual(
    res.body.secureModes.map((m) => m.id),
    ['none', 'starttls', 'tls']
  );
  assert.equal(res.body.templates.length, templates.KEYS.length);
  assert.ok(res.body.templates[0].variables.length);
});

test('la configuration SMTP s\'enregistre, mot de passe conservé si laissé vide', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'postier', 'MotDePasse1');

  const saved = await client.put('/api/system/smtp', {
    host: 'smtp.exemple.fr',
    port: '465',
    secure: 'tls',
    user: 'crabe',
    password: 'secret-smtp',
    from: 'crabe@exemple.fr',
    fromName: 'crabe',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.smtp.host, 'smtp.exemple.fr');
  assert.equal(saved.body.smtp.secure, 'tls');
  assert.equal(saved.body.smtp.fromName, 'crabe');
  assert.equal(saved.body.smtp.configured, true);

  // Le mot de passe est chiffré au repos.
  const row = helpers.db.get().prepare('SELECT * FROM security_policy WHERE id = 1').get();
  assert.equal(row.smtp_pass_encrypted.includes('secret-smtp'), false);
  assert.equal(helpers.crypto.decrypt(row.smtp_pass_encrypted), 'secret-smtp');

  // Deuxième enregistrement sans mot de passe : l'ancien est conservé (c'est
  // le seul champ que le formulaire ne peut pas réafficher).
  const relu = await client.put('/api/system/smtp', {
    host: 'smtp.exemple.fr',
    port: '587',
    secure: 'starttls',
    user: 'crabe',
    from: 'crabe@exemple.fr',
    fromName: 'crabe',
  });
  assert.equal(relu.body.smtp.secure, 'starttls');
  const après = helpers.db.get().prepare('SELECT * FROM security_policy WHERE id = 1').get();
  assert.equal(helpers.crypto.decrypt(après.smtp_pass_encrypted), 'secret-smtp');

  // Le nom d'expéditeur habille l'adresse.
  assert.equal(mailer.sender(après), 'crabe <crabe@exemple.fr>');

  const refus = await client.put('/api/system/smtp', { host: 'x', secure: 'magique' });
  assert.equal(refus.status, 400);
});

test('un test d\'envoi vers un serveur injoignable répond, sans planter', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'postier', 'MotDePasse1');

  // 127.0.0.1 sur un port fermé : refus immédiat, pas d'attente de 10 s.
  await client.put('/api/system/smtp', { host: '127.0.0.1', port: '9', secure: 'none' });

  const res = await client.post('/api/system/smtp/test', { to: 'quelquun@test.local' });
  assert.equal(res.status, 200, 'la route répond toujours 200 avec un verdict');
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /refusée|Délai dépassé|TLS|Échec/);

  // Sans adresse saisie, on retombe sur celle du profil…
  const parDéfaut = await client.post('/api/system/smtp/test', { to: '' });
  assert.equal(parDéfaut.status, 200);
  assert.equal(parDéfaut.body.ok, false, 'serveur injoignable, mais destinataire trouvé');

  // …et si le profil n'en a pas non plus, le message le dit.
  helpers.db.get().prepare('UPDATE users SET email = NULL WHERE username = ?').run('postier');
  t.after(() =>
    helpers.db
      .get()
      .prepare('UPDATE users SET email = ? WHERE username = ?')
      .run('postier@test.local', 'postier')
  );
  const sansDestinataire = await client.post('/api/system/smtp/test', { to: '' });
  assert.equal(sansDestinataire.status, 400);
  assert.match(sansDestinataire.body.message, /destinataire/);

  const modèleInconnu = await client.post('/api/system/smtp/test', {
    to: 'x@test.local',
    template: 'nexiste-pas',
  });
  assert.equal(modèleInconnu.status, 404);
});

test('les modèles s\'éditent, se prévisualisent et se réinitialisent par l\'API', async (t) => {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'postier', 'MotDePasse1');

  const liste = await client.get('/api/system/email-templates');
  assert.equal(liste.status, 200);
  assert.equal(liste.body.templates.length, templates.KEYS.length);

  const enregistré = await client.put('/api/system/email-templates/connector-failure', {
    subject: 'Panne {{connecteur}}',
    body: '{{utilisateur}} : {{erreur}} le {{date}}',
  });
  assert.equal(enregistré.status, 200);
  assert.equal(enregistré.body.template.customized, true);

  // Aperçu du texte à l'écran, AVANT enregistrement.
  const aperçu = await client.post('/api/system/email-templates/connector-failure/preview', {
    subject: 'Brouillon {{connecteur}}',
    body: 'Corps {{erreur}}',
  });
  assert.equal(aperçu.status, 200);
  assert.equal(aperçu.body.preview.subject, 'Brouillon Free Internet');
  assert.match(aperçu.body.preview.body, /^Corps /);
  assert.ok(aperçu.body.values.connecteur, 'les valeurs d\'exemple sont renvoyées');

  // Aperçu sans brouillon : c'est le modèle enregistré qui est rendu.
  const aperçuEnregistré = await client.post(
    '/api/system/email-templates/connector-failure/preview',
    {}
  );
  assert.equal(aperçuEnregistré.body.preview.subject, 'Panne Free Internet');

  const vide = await client.put('/api/system/email-templates/connector-failure', {
    subject: '',
    body: '',
  });
  assert.equal(vide.status, 400);

  const inconnu = await client.put('/api/system/email-templates/nexiste-pas', {
    subject: 'x',
    body: 'y',
  });
  assert.equal(inconnu.status, 404);

  const réinit = await client.post('/api/system/email-templates/connector-failure/reset', {});
  assert.equal(réinit.status, 200);
  assert.equal(réinit.body.template.customized, false);
  assert.match(réinit.body.template.subject, /échec de synchronisation/i);
});

test('les modèles sont réservés à « Configurer la sécurité »', async (t) => {
  await helpers.createUser({ username: 'sans-droit', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'sans-droit', 'MotDePasse1');

  assert.equal((await client.get('/api/system/smtp')).status, 403);
  assert.equal((await client.get('/api/system/email-templates')).status, 403);
  assert.equal(
    (await client.put('/api/system/email-templates/password-reset', { subject: 'a', body: 'b' }))
      .status,
    403
  );
});
