'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const ovh = require('../server/connectors/available/ovh-api/connector');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Validation des manifests
// ---------------------------------------------------------------------------

const VALID = {
  id: 'demo',
  name: 'Démo',
  category: 'energie',
  color: '#123456',
  letters: 'DM',
  // Lot 8 : UNE phrase, ce que le service fait pour l'utilisateur. Ce qui est
  // vrai mais technique va dans « technicalNote ».
  description: 'Récupère automatiquement vos factures de démonstration.',
  fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
  // Lot 4 : les permissions sont obligatoires, avec une description propre au
  // connecteur — plus de libellés génériques hérités en silence.
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description:
        'Télécharge les factures de démonstration du fournisseur fictif et les dépose sur vos destinations.',
    },
    {
      key: 'identifiants',
      scope: 'read',
      description:
        'L\'identifiant de démonstration saisi à la configuration, chiffré au repos, utilisé pour la seule connexion simulée.',
    },
  ],
};

test('un manifest complet est accepté', () => {
  const result = schema.validate(VALID);
  assert.equal(result.ok, true, result.errors.join(' / '));
});

test('les manifests invalides sont refusés avec un message utile', () => {
  const cases = [
    [{ ...VALID, id: 'Demo Majuscule' }, /id/],
    [{ ...VALID, category: 'inexistante' }, /catégorie/],
    [{ ...VALID, color: 'bleu' }, /couleur/],
    [{ ...VALID, letters: 'TROPLONG' }, /letters/],
    [{ ...VALID, fields: [] }, /fields/],
    [{ ...VALID, fields: [{ key: 'a', label: 'A', type: 'inconnu' }] }, /type/],
    [{ ...VALID, fields: [{ key: 'a', label: 'A', type: 'select' }] }, /options/],
    [{ ...VALID, implementation: 'magie' }, /implementation/],
  ];

  for (const [manifest, pattern] of cases) {
    const result = schema.validate(manifest);
    assert.equal(result.ok, false, `attendu invalide : ${JSON.stringify(manifest).slice(0, 60)}`);
    assert.match(result.errors.join(' '), pattern);
  }
});

test('deux champs de même clé sont refusés', () => {
  const result = schema.validate({
    ...VALID,
    fields: [
      { key: 'a', label: 'A', type: 'text' },
      { key: 'a', label: 'B', type: 'text' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /dupliqué/);
});

test('publicView() ne laisse pas fuiter de valeurs de champ', () => {
  const normalized = schema.normalize({ ...VALID, fields: [{ key: 'pw', label: 'P', type: 'password', secretDefault: 'oups' }] });
  const view = schema.publicView(normalized);
  assert.equal('secretDefault' in view.fields[0], false);
});

// ---------------------------------------------------------------------------
// Chargement du registre
// ---------------------------------------------------------------------------

test('tous les connecteurs livrés se chargent sans erreur', () => {
  const result = registry.load();
  assert.equal(result.errors.length, 0, result.errors.join(' / '));
  assert.ok(result.loaded >= 12, `attendu au moins 12 connecteurs, obtenu ${result.loaded}`);
  assert.equal(registry.has('ovh'), true);
});

// `listAvailable()` et non `listAll()` : depuis le lot 11, le catalogue porte
// aussi les services ANNONCÉS, qui n'ont volontairement pas de connector.js.
// Leur demander un module reviendrait à leur reprocher d'être ce qu'ils sont.
test('chaque connecteur expose test() et fetchInvoices()', () => {
  for (const manifest of registry.listAvailable()) {
    const entry = registry.get(manifest.id);
    assert.equal(typeof entry.module.test, 'function', `${manifest.id}.test`);
    assert.equal(typeof entry.module.fetchInvoices, 'function', `${manifest.id}.fetchInvoices`);
  }
});

test('un connecteur au manifest cassé est ignoré, pas fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-conn-'));
  fs.mkdirSync(path.join(dir, 'casse'));
  fs.writeFileSync(path.join(dir, 'casse', 'manifest.json'), '{ ceci n\'est pas du JSON');

  fs.mkdirSync(path.join(dir, 'bon'));
  fs.writeFileSync(
    path.join(dir, 'bon', 'manifest.json'),
    JSON.stringify({ ...VALID, id: 'bon' })
  );
  fs.writeFileSync(
    path.join(dir, 'bon', 'connector.js'),
    'module.exports = { test: async () => ({ok:true}), fetchInvoices: async () => [] };'
  );

  const result = registry.load(dir);
  assert.equal(result.loaded, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /casse/);

  fs.rmSync(dir, { recursive: true, force: true });
  registry.load(); // on remet le vrai registre pour les tests suivants
});

test('un id de manifest qui ne colle pas au dossier est rejeté', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-conn-'));
  fs.mkdirSync(path.join(dir, 'dossier'));
  fs.writeFileSync(
    path.join(dir, 'dossier', 'manifest.json'),
    JSON.stringify({ ...VALID, id: 'autre' })
  );
  fs.writeFileSync(path.join(dir, 'dossier', 'connector.js'), 'module.exports={test:async()=>({}),fetchInvoices:async()=>[]};');

  const result = registry.load(dir);
  assert.equal(result.loaded, 0);
  assert.match(result.errors[0], /ne correspond pas au nom du dossier/);

  fs.rmSync(dir, { recursive: true, force: true });
  registry.load();
});

// ---------------------------------------------------------------------------
// Installation, configuration, isolation entre comptes
// ---------------------------------------------------------------------------

test('installation, configuration chiffrée et désinstallation', async () => {
  const user = await helpers.createUser({ username: 'dave' });

  registry.install(user.id, 'edf');
  assert.equal(registry.getInstall(user.id, 'edf').status, 'needs-config');

  registry.saveConfig(user.id, 'edf', { username: 'dave@test.local', password: 'secret-edf' });
  const install = registry.getInstall(user.id, 'edf');
  assert.equal(install.status, 'installed');

  // La config est illisible sans la clé maîtresse.
  assert.equal(install.config_encrypted.includes('secret-edf'), false);
  assert.match(install.config_encrypted, /^v1\./);

  const config = registry.readConfig(user.id, 'edf');
  assert.equal(config.password, 'secret-edf');

  assert.equal(registry.uninstall(user.id, 'edf'), true);
  assert.equal(registry.getInstall(user.id, 'edf'), undefined);
});

test('un champ obligatoire manquant est refusé', async () => {
  const user = await helpers.createUser({ username: 'erin' });
  registry.install(user.id, 'edf');
  assert.throws(
    () => registry.saveConfig(user.id, 'edf', { username: 'erin@test.local' }),
    /obligatoires manquants/
  );
});

test('un champ laissé vide conserve la valeur déjà enregistrée', async () => {
  const user = await helpers.createUser({ username: 'frank' });
  registry.install(user.id, 'edf');
  registry.saveConfig(user.id, 'edf', { username: 'frank@test.local', password: 'initial' });
  registry.saveConfig(user.id, 'edf', { username: 'nouveau@test.local', password: '' });

  const config = registry.readConfig(user.id, 'edf');
  assert.equal(config.username, 'nouveau@test.local');
  assert.equal(config.password, 'initial', 'le mot de passe ne devait pas être écrasé');
});

test('les installations sont strictement isolées entre comptes', async () => {
  const a = await helpers.createUser({ username: 'grace' });
  const b = await helpers.createUser({ username: 'heidi' });

  registry.install(a.id, 'free');
  registry.saveConfig(a.id, 'free', { username: 'grace', password: 'a-elle' });

  assert.equal(registry.getInstall(b.id, 'free'), undefined);
  assert.throws(() => registry.readConfig(b.id, 'free'), /non installé/);

  const listeB = registry.listForUser(b);
  assert.equal(listeB.find((c) => c.id === 'free').installed, false);
});

test('la restriction d\'accès par utilisateur est respectée', async () => {
  const allowed = await helpers.createUser({ username: 'ivan' });
  const denied = await helpers.createUser({ username: 'judy' });

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET allowed_users = ? WHERE connector_id = ?')
    .run(JSON.stringify([allowed.id]), 'orange');

  assert.equal(registry.isAllowedForUser('orange', allowed), true);
  assert.equal(registry.isAllowedForUser('orange', denied), false);

  assert.equal(registry.listForUser(denied).some((c) => c.id === 'orange'), false);
  assert.equal(registry.listForUser(allowed).some((c) => c.id === 'orange'), true);

  // L'administrateur voit tout.
  assert.equal(registry.isAllowedForUser('orange', { id: 999, role: 'admin' }), true);

  helpers.db
    .get()
    .prepare('UPDATE connector_catalog SET allowed_users = \'"all"\' WHERE connector_id = ?')
    .run('orange');
});

/**
 * Lot 20 — la règle a changé, et pour une raison qui se raconte.
 *
 * Jusqu'ici, un connecteur « en attente de test » disparaissait du Store de
 * TOUT LE MONDE, administrateur compris. Le garde-fou empêchait alors
 * exactement le geste censé le lever : sans installation, pas d'identifiants ;
 * sans identifiants, pas de test ; sans test, l'état ne changeait jamais. Le
 * connecteur `vinted` est resté dans cet état depuis le lot 3.
 *
 * Ce que le lot 20 change, et rien de plus : l'ADMINISTRATEUR le voit, marqué
 * « Pas encore testé ». Un compte ordinaire continue de ne rien voir, ce qui
 * est la promesse qui compte — un service jamais exercé n'est proposé à
 * personne.
 */
test('un connecteur en attente de test : invisible aux comptes ordinaires, visible à l\'admin', async () => {
  const user = await helpers.createUser({ username: 'ken' });
  helpers.db
    .get()
    .prepare("UPDATE connector_catalog SET status = 'pending' WHERE connector_id = ?")
    .run('amazon');

  assert.equal(
    registry.listForUser(user).some((c) => c.id === 'amazon'),
    false,
    'un compte ordinaire ne se voit jamais proposer un service jamais essayé'
  );

  const vuParAdmin = registry.listForUser({ id: 1, role: 'admin' }).find((c) => c.id === 'amazon');
  assert.ok(vuParAdmin, 'l\'admin, lui, doit pouvoir l\'installer pour le tester');
  assert.equal(
    vuParAdmin.catalogStatus,
    'pending',
    'et l\'interface doit pouvoir le marquer : ce n\'est pas une disponibilité déguisée'
  );

  // Il reste visible côté administration des applications.
  assert.equal(registry.listAll().some((c) => c.id === 'amazon'), true);

  helpers.db
    .get()
    .prepare("UPDATE connector_catalog SET status = 'available' WHERE connector_id = ?")
    .run('amazon');
});

test('installer un connecteur inconnu lève', () => {
  assert.throws(() => registry.install(1, 'connecteur-fantome'), /inconnu/);
});

// ---------------------------------------------------------------------------
// Exécution des connecteurs
// ---------------------------------------------------------------------------

test('test() renvoie un échec propre au lieu de propager une exception', async () => {
  const result = await registry.test('edf', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /manquant/i);
});

test('un connecteur simulé produit des PDF exploitables', async () => {
  const invoices = await registry.fetchInvoices(
    'edf',
    { username: 'x', password: 'y' },
    { forceOutcome: 'ok', monthsBack: 3 }
  );

  assert.equal(invoices.length, 3);
  const ids = invoices.map((i) => i.remoteId);
  assert.equal(new Set(ids).size, ids.length, 'les identifiants distants doivent être uniques');

  for (const invoice of invoices) {
    assert.match(invoice.filename, /^edf_\d{4}-\d{2}\.pdf$/);
    assert.equal(invoice.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(invoice.buffer.includes(Buffer.from('%%EOF')));
  }
});

test('les factures déjà connues ne sont pas re-téléchargées', async () => {
  const first = await registry.fetchInvoices(
    'edf',
    { username: 'x', password: 'y' },
    { forceOutcome: 'ok', monthsBack: 4 }
  );
  const second = await registry.fetchInvoices(
    'edf',
    { username: 'x', password: 'y' },
    { forceOutcome: 'ok', monthsBack: 4, knownRemoteIds: first.map((i) => i.remoteId) }
  );
  assert.equal(second.length, 0);
});

// ---------------------------------------------------------------------------
// Implémentation partagée « ovh-api » (partie hors réseau)
// ---------------------------------------------------------------------------

test('la signature OVH suit le format documenté', () => {
  const signature = ovh.sign('AS', 'CK', 'GET', 'https://eu.api.ovh.com/1.0/me', '', '1234567890');
  assert.match(signature, /^\$1\$[0-9a-f]{40}$/);

  // Déterministe, et sensible au moindre changement d'entrée.
  const same = ovh.sign('AS', 'CK', 'GET', 'https://eu.api.ovh.com/1.0/me', '', '1234567890');
  const other = ovh.sign('AS', 'CK', 'GET', 'https://eu.api.ovh.com/1.0/me', '', '1234567891');
  assert.equal(signature, same);
  assert.notEqual(signature, other);
});

test('OVH refuse de partir sans identifiants complets', async () => {
  const result = await registry.test('ovh', { applicationKey: 'seulement-ca' });
  assert.equal(result.ok, false);
  assert.match(result.message, /manquant/);
});

test('les sept régions du groupe OVH sont connues', () => {
  assert.deepEqual(Object.keys(ovh.ENDPOINTS).sort(), [
    'kimsufi-ca',
    'kimsufi-eu',
    'ovh-ca',
    'ovh-eu',
    'ovh-us',
    'soyoustart-ca',
    'soyoustart-eu',
  ]);
});

/**
 * Un faux serveur d'API OVH, en mémoire.
 *
 * Le connecteur appelle le `fetch` global : on le remplace le temps d'un test.
 * La résolution est dynamique à chaque appel, donc la substitution est vue
 * même par un module déjà chargé — et `urls` garde la trace de QUI a été
 * appelé, ce qui est précisément la question quand une marque en emprunte
 * une autre.
 */
function fauxServeurOvh(urls) {
  return async (url) => {
    urls.push(String(url));
    const reponse = (data) => ({ ok: true, status: 200, json: async () => data });

    if (String(url).endsWith('/auth/time')) {
      return { ok: true, status: 200, text: async () => String(Math.floor(Date.now() / 1000)) };
    }
    if (String(url).includes('/me/bill/')) {
      return reponse({
        pdfUrl: 'https://pdf.example/facture',
        date: '2026-03-14T09:00:00+00:00',
        priceWithTax: { text: '12,00 €' },
      });
    }
    if (String(url).includes('/me/bill')) return reponse(['FR1234']);
    if (String(url).endsWith('/me')) return reponse({ nichandle: 'sys12345-ovh' });
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('%PDF-1.4 x') };
  };
}

async function avecFauxServeur(fn) {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fauxServeurOvh(urls);
  try {
    return { resultat: await fn(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

const CLES = { applicationKey: 'AK', applicationSecret: 'AS', consumerKey: 'CK' };

test('le nom de fichier suit le connecteur, pas la marque du code partagé', async () => {
  // Sans cela, une facture SoYouStart se rangerait sous un nom OVH et
  // deviendrait introuvable — deux marques, un seul moteur d'API.
  const { resultat } = await avecFauxServeur(() =>
    ovh.fetchInvoices(
      { ...CLES, endpoint: 'soyoustart-eu' },
      { connectorId: 'soyoustart', manifest: { name: 'SoYouStart' } }
    )
  );
  assert.equal(resultat.invoices[0].filename, 'soyoustart_2026-03_FR1234.pdf');

  const { resultat: chezOvh } = await avecFauxServeur(() => ovh.fetchInvoices(CLES, {}));
  assert.equal(chezOvh.invoices[0].filename, 'ovh_2026-03_FR1234.pdf');
});

test('sans région choisie, on interroge le serveur de SA marque', async () => {
  // Retomber sur « ovh-eu » enverrait des clés SoYouStart chez OVHcloud, qui
  // les refuserait — et l'utilisateur chercherait longtemps pourquoi.
  const { urls } = await avecFauxServeur(() =>
    ovh.test(CLES, { connectorId: 'soyoustart', manifest: { name: 'SoYouStart' } })
  );
  assert.ok(
    urls.every((u) => u.startsWith('https://eu.api.soyoustart.com/')),
    `aucun appel ne doit sortir vers une autre marque : ${urls.join(', ')}`
  );

  const { urls: chezOvh } = await avecFauxServeur(() => ovh.test(CLES, {}));
  assert.ok(chezOvh.every((u) => u.startsWith('https://eu.api.ovh.com/')));
});

test('un identifiant manquant nomme la marque du connecteur, pas OVH', async () => {
  await assert.rejects(
    () => ovh.test({ applicationKey: 'seulement-ca' }, { manifest: { name: 'SoYouStart' } }),
    /Identifiant SoYouStart manquant/
  );
});

test('une région inconnue est refusée avec le nom de la marque', async () => {
  await assert.rejects(
    () =>
      ovh.test(
        { ...CLES, endpoint: 'soyoustart-xx' },
        { connectorId: 'soyoustart', manifest: { name: 'SoYouStart' } }
      ),
    /Région SoYouStart inconnue/
  );
});

test('le manifeste OVH pointe vers l\'implémentation partagée, sans code à lui', () => {
  // La bascule du lot 16 : `available/ovh/` n'a plus de connector.js, il vit
  // dans `available/ovh-api/`. Si l'un des deux bouge sans l'autre, le
  // connecteur en production cesse de se charger — d'où ce garde-fou.
  const dirOvh = path.join(registry.AVAILABLE_DIR, 'ovh');
  assert.equal(fs.existsSync(path.join(dirOvh, 'connector.js')), false);
  assert.equal(registry.manifest('ovh').implementation, 'ovh-api');
  assert.ok(registry.SHARED_IMPLEMENTATIONS.has('ovh-api'));

  const partage = path.join(registry.AVAILABLE_DIR, 'ovh-api');
  assert.ok(fs.existsSync(path.join(partage, 'connector.js')));
  assert.equal(
    fs.existsSync(path.join(partage, 'manifest.json')),
    false,
    'une implémentation partagée ne doit JAMAIS porter de manifeste : elle deviendrait un service'
  );
  assert.equal(registry.has('ovh-api'), false, 'et ne doit apparaître dans aucun catalogue');
  assert.equal(registry.isPlanned('ovh-api'), false);
});

// ---------------------------------------------------------------------------
// Lot 4 — permissions : vocabulaire commun et descriptions spécifiques
// ---------------------------------------------------------------------------

test('un manifeste sans permissions est refusé', () => {
  const { permissions, ...sansPermissions } = VALID;
  const result = schema.validate(sansPermissions);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /« permissions » doit être un tableau non vide/);

  assert.equal(schema.validate({ ...VALID, permissions: [] }).ok, false);
});

test('une permission hors vocabulaire est refusée', () => {
  const result = schema.validate({
    ...VALID,
    permissions: [
      { key: 'contacts', scope: 'read', description: 'Une description parfaitement spécifique et longue.' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /hors vocabulaire/);
  // Le message liste le vocabulaire admis : on n'oblige personne à fouiller.
  for (const cle of schema.vocabulary.KEYS) {
    assert.ok(result.errors.join(' ').includes(cle), `« ${cle} » attendu dans le message`);
  }
});

test('une portée inconnue est refusée', () => {
  const result = schema.validate({
    ...VALID,
    permissions: [
      { key: 'factures', scope: 'Lecture et écriture', description: 'Description spécifique et suffisamment longue.' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /scope .* invalide/);
});

test('la même donnée déclarée deux fois est refusée', () => {
  const result = schema.validate({
    ...VALID,
    permissions: [VALID.permissions[0], { ...VALID.permissions[0] }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /déclarée deux fois/);
});

test('un connecteur qui se contente des libellés génériques est refusé', () => {
  // C'est exactement ce que faisaient les treize manifestes du lot 3.
  const generiques = [
    'Factures',
    'Identifiants du connecteur',
    'Lecture et écriture',
    'Lecture seule — stockés chiffrés',
  ];

  for (const texte of generiques) {
    const result = schema.validate({
      ...VALID,
      permissions: [{ key: 'factures', scope: 'read-write', description: texte }],
    });
    assert.equal(result.ok, false, `« ${texte} » aurait dû être refusé`);
  }

  // La recopie de la description par défaut du vocabulaire ne passe pas non plus.
  const parDefaut = schema.vocabulary.VOCABULARY.factures.defaultDescription;
  const recopie = schema.validate({
    ...VALID,
    permissions: [{ key: 'factures', scope: 'read-write', description: parDefaut }],
  });
  assert.equal(recopie.ok, false);
  assert.match(recopie.errors.join(' '), /texte générique/);

  // Une description absente ou trop courte est refusée avec un message clair.
  assert.match(
    schema.validate({
      ...VALID,
      permissions: [{ key: 'factures', scope: 'read-write' }],
    }).errors.join(' '),
    /description manquante/
  );
  assert.match(
    schema.validate({
      ...VALID,
      permissions: [{ key: 'factures', scope: 'read-write', description: 'Des factures.' }],
    }).errors.join(' '),
    /trop courte/
  );
});

// Idem : un service annoncé ne manipule aucune donnée tant qu'aucun code ne
// tourne, il n'a donc rien à déclarer. Les permissions redeviennent obligatoires
// le jour où son dossier passe dans available/.
test('chaque connecteur livré déclare des permissions spécifiques', () => {
  registry.load();
  const vocabulary = schema.vocabulary;

  for (const manifest of registry.listAvailable()) {
    assert.ok(
      Array.isArray(manifest.permissions) && manifest.permissions.length,
      `${manifest.id} : aucune permission déclarée`
    );

    const vues = manifest.permissionDetails;
    assert.equal(vues.length, manifest.permissions.length, `${manifest.id} : permission inconnue`);

    for (const vue of vues) {
      assert.ok(vocabulary.has(vue.key), `${manifest.id} : « ${vue.key} » hors vocabulaire`);
      assert.ok(vue.icon, `${manifest.id}/${vue.key} : icône manquante`);
      assert.ok(vue.scopeLabel, `${manifest.id}/${vue.key} : portée non traduite`);
      assert.equal(vue.generic, false, `${manifest.id}/${vue.key} : description générique`);
      assert.ok(
        vue.description.length >= 30,
        `${manifest.id}/${vue.key} : description trop courte`
      );
    }

    // Tout connecteur lit des identifiants et écrit des factures : c'est le
    // socle commun, sous peine de décrire un connecteur qui ne fait rien.
    const cles = vues.map((v) => v.key);
    assert.ok(cles.includes('factures'), `${manifest.id} : « factures » attendue`);
    assert.ok(cles.includes('identifiants'), `${manifest.id} : « identifiants » attendue`);
  }
});

test('deux connecteurs ne décrivent pas la même donnée avec le même texte', () => {
  // Le but du lot 4 : que la description soit propre au connecteur. Si deux
  // manifestes disent mot pour mot la même chose, elle n'apprend rien.
  registry.load();
  const vus = new Map();

  for (const manifest of registry.listAll()) {
    for (const p of manifest.permissionDetails) {
      const empreinte = `${p.key}::${p.description}`;
      assert.equal(
        vus.has(empreinte),
        false,
        `${manifest.id} et ${vus.get(empreinte)} décrivent « ${p.key} » avec le même texte`
      );
      vus.set(empreinte, manifest.id);
    }
  }
});

test('le bandeau dit honnêtement ce qui sort de crabe', () => {
  const { NOTICE } = schema.vocabulary;
  assert.match(NOTICE, /Droit d'accès limité/);
  // Le texte de référence de Twake (« les données ne quittent pas votre
  // appareil ») serait faux ici : les factures partent vers les destinations.
  assert.match(NOTICE, /destinations de stockage/);
  assert.equal(/ne quitte(nt)? (jamais|pas) (votre|cette)/.test(NOTICE), false);
});

// ---------------------------------------------------------------------------
// Lot 8 — une phrase pour l'utilisateur, le reste dans l'administration
// ---------------------------------------------------------------------------

/**
 * Le texte que ces tests interdisent est réel. La fiche Free Mobile affichait :
 *
 *   « Récupère les factures de toutes les lignes d'un compte Free Mobile, y
 *     compris les lignes résiliées. Free Mobile exigeant un code SMS à chaque
 *     connexion, ce connecteur rejoue une session ouverte par vous : cliquez
 *     … Parcours validé contre un compte réel le 09/08/2026. »
 *
 * Une note d'implémentation, à un public qui n'a jamais entendu parler de
 * session ni de parcours validé.
 */
test('une description de plus d\'une phrase est refusée', () => {
  const result = schema.validate({
    ...VALID,
    description:
      'Récupère vos factures. Ce connecteur rejoue une session ouverte par vous.',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /UNE phrase/);
  assert.match(result.errors.join(' '), /technicalNote/);
});

test('une description trop longue est refusée, avec la mesure', () => {
  const result = schema.validate({ ...VALID, description: `Récupère ${'x'.repeat(200)}` });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), new RegExp(`${schema.DESCRIPTION_MAX} au plus`));
});

test('une description absente est refusée : un connecteur muet ne se choisit pas', () => {
  const { description, ...sansTexte } = VALID;
  const result = schema.validate(sansTexte);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /description/);
});

test('un point d\'abréviation ou d\'URL ne compte pas pour une phrase', () => {
  // « mobile.free.fr » et « etc. » ne terminent pas une phrase : la règle ne
  // doit pas refuser un texte parfaitement correct.
  for (const texte of [
    'Récupère automatiquement vos factures depuis mobile.free.fr.',
    'Récupère vos factures, attestations, etc. de la CAF.',
    'Récupère automatiquement vos factures Freebox.',
  ]) {
    assert.equal(schema.compterPhrases(texte), 1, texte);
    assert.equal(schema.validate({ ...VALID, description: texte }).ok, true, texte);
  }
});

test('la note technique est acceptée, aussi longue soit-elle', () => {
  const result = schema.validate({
    ...VALID,
    technicalNote: 'API officielle /me/bill. '.repeat(40),
  });
  assert.equal(result.ok, true, result.errors.join(' / '));
  assert.equal(schema.validate({ ...VALID, technicalNote: 42 }).ok, false);
});

test('la note technique ne sort JAMAIS vers l\'utilisateur', () => {
  const normalized = schema.normalize({
    ...VALID,
    technicalNote: 'Exige un jeu de clés API généré sur api.ovh.com.',
  });
  assert.equal(normalized.technicalNote, 'Exige un jeu de clés API généré sur api.ovh.com.');

  const vue = schema.publicView(normalized);
  assert.equal('technicalNote' in vue, false, 'la vue publique ne doit pas la porter');
  assert.equal(
    JSON.stringify(vue).includes('api.ovh.com'),
    false,
    'ni nulle part ailleurs dans la réponse'
  );
  // La phrase, elle, part bien : c'est elle que la fiche affiche.
  assert.equal(vue.description, 'Récupère automatiquement vos factures de démonstration.');
});

test('les 14 manifestes livrés respectent la règle', () => {
  const registry = require('../server/connectors/registry');
  registry.load();

  for (const manifest of registry.listAll()) {
    const description = String(manifest.description || '');
    assert.ok(description, `${manifest.id} : description manquante`);
    assert.ok(
      description.length <= schema.DESCRIPTION_MAX,
      `${manifest.id} : ${description.length} caractères`
    );
    assert.equal(schema.compterPhrases(description), 1, `${manifest.id} : une phrase attendue`);

    // Aucune trace de jargon ni de date de validation dans ce qui est montré.
    for (const interdit of [/session/i, /valid[ée]/i, /scraping/i, /\bAPI\b/, /\d{2}\/\d{2}\/\d{4}/]) {
      assert.equal(
        interdit.test(description),
        false,
        `${manifest.id} : « ${description} » contient une précision technique`
      );
    }
  }
});

/**
 * Lot 9, §4 — plus aucune ligne de commande sous les yeux de l'utilisateur.
 *
 * Le lot 8 laissait ceci sous « Options avancées » de Free Mobile :
 *
 *   « Le repli reste possible avec « node tools/capture-session.js free-mobile
 *     https://mobile.free.fr/account/v2/login "Mes factures" », qui produit un
 *     fichier à déposer ici. »
 *
 * crabe s'adresse à des gens qui n'ont jamais ouvert un terminal. Le fait que
 * ce texte soit replié n'y change rien : on finit toujours par ouvrir le repli
 * quand on cherche, et on y trouve un mur.
 *
 * Ce test tient la règle pour TOUS les manifestes, présents et à venir, sur
 * tout ce que la vue publique laisse passer — c'est elle, et elle seule, qui
 * arrive dans l'interface.
 */
test('aucun manifeste ne montre une commande, un fichier ou un chemin à l\'utilisateur', () => {
  registry.load();

  // La liste de ce qu'on ne veut voir NULLE PART vit dans le schéma depuis le
  // lot 17 : elle a deux appelants, et la tenir à deux endroits, c'est la voir
  // diverger (voir manifest-schema.jargonUtilisateur).
  for (const manifest of registry.listAll()) {
    const vue = schema.publicView(manifest);
    // Tout ce qui peut atteindre un écran : la phrase, l'aide et l'avertissement
    // de chaque champ, le conseil du navigateur distant, les permissions.
    const textes = [
      ['description', vue.description],
      ['remoteLogin.hint', vue.remoteLogin?.hint],
      ...(vue.fields || []).flatMap((f) => [
        [`fields.${f.key}.label`, f.label],
        [`fields.${f.key}.help`, f.help],
        [`fields.${f.key}.notice`, f.notice],
      ]),
      ...(vue.permissionDetails || []).map((p) => [`permissions.${p.key}`, p.description]),
    ];

    for (const [ou, texte] of textes) {
      if (!texte) continue;
      const trouve = schema.jargonUtilisateur(texte);
      assert.equal(trouve, null, `${manifest.id} → ${ou} montre ${trouve} : « ${texte} »`);
    }
  }
});

/**
 * Lot 17, §5 — l'aide qui manquait, et la règle qui a failli l'interdire.
 *
 * Un utilisateur réel n'est pas parvenu à créer ses clés OVH et SoYouStart seul : l'aide
 * disait « Créée sur https://api.ovh.com/createToken/ » et rien de plus. Ni
 * les droits à cocher, ni la validité à choisir, ni le fait qu'une clé
 * OVHcloud est refusée par SoYouStart.
 *
 * En réécrivant ces aides, une question s'est posée : le garde-fou ci-dessus
 * refuse les chemins techniques — allait-il refuser une adresse web au
 * passage ? Non, mais de peu : `tools/` et `/etc/` se seraient reconnus dans
 * une URL de console tout à fait légitime. D'où la mise à l'écart des adresses
 * avant l'examen des chemins, et ce test qui la tient.
 */
test('une adresse où créer sa clé est acceptée, un chemin technique reste refusé', () => {
  const bonnes = [
    'Créez votre clé sur https://api.ovh.com/createToken/ avec votre compte OVHcloud.',
    'Dans « Rights », ajoutez GET /me et GET /me/bill* — l\'astérisque comprise.',
    'Ouvrez https://console.example.com/tools/api-keys puis créez une clé.',
    'Choisissez la validité « Unlimited », sinon la récupération s\'arrêtera.',
  ];
  for (const texte of bonnes) {
    assert.equal(schema.jargonUtilisateur(texte), null, `refusé à tort : « ${texte} »`);
  }

  const mauvaises = [
    ['Lancez node tools/capture-session.js free-mobile', 'une commande à taper'],
    ['Installez-le avec npm install playwright', 'une commande système'],
    ['Déposez le fichier dans /etc/crabe/', 'un chemin technique'],
    ['Le fichier de session se dépose ici.', 'un fichier de session'],
  ];
  for (const [texte, quoi] of mauvaises) {
    assert.equal(schema.jargonUtilisateur(texte), quoi, `laissé passer : « ${texte} »`);
  }
});

test('chaque champ d\'identifiant dit à quoi il sert, et où le trouver', () => {
  registry.load();

  // Un champ qu'on ne sait pas remplir est un connecteur qu'on n'installe pas.
  //
  // C'est l'aide EFFECTIVE qui est vérifiée — celle qui arrive à l'écran, donc
  // après normalisation. Un champ d'identification n'écrit rien : il tient sa
  // phrase de sa nature, qui y met le nom du service (« Celle avec laquelle
  // vous vous connectez sur Kubii. »). L'exiger dans le manifeste reviendrait à
  // la réécrire sept fois, moins bien.
  for (const manifest of registry.listAvailable()) {
    for (const field of schema.publicView(manifest).fields || []) {
      if (!['password', 'text', 'email'].includes(field.type)) continue;
      assert.ok(
        field.help && field.help.trim().length >= 30,
        `${manifest.id} → ${field.key} : aucune aide digne de ce nom`
      );
    }
  }
});

test('les précisions techniques restent dans le champ réservé à l\'administration', () => {
  registry.load();
  const fm = registry.listAll().find((c) => c.id === 'free-mobile');

  // `technicalNote` a le droit de tout dire : elle ne sort jamais de
  // Paramètres → Applications (voir manifest-schema.publicView).
  assert.match(fm.technicalNote, /capture-session/);
  assert.equal(schema.publicView(fm).technicalNote, undefined, 'et elle ne sort pas');
});
