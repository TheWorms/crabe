'use strict';

/**
 * Lot 75 — trois faits mesurés le 09/09/2026, et leurs remèdes.
 *
 * 1. **La garde du lot 74 ne couvrait que l'enregistrement.** La carte kDrive
 *    sans numéro, enregistrée AVANT la garde, restait active en base : chaque
 *    « Tester » et chaque copie répondait « unsupported protocol scheme » en
 *    anglais, et rien sur la carte ne disait le champ à remplir. Le motif
 *    (`motifAdresseWebdav`) arme désormais le refus avant service du pilote,
 *    l'avertissement de la carte, et le refus de synchronisation.
 *
 * 2. **Le journal de stockage résolvait le nom à l'affichage.** Deux lignes
 *    MEGA du 26/08 s'affichaient sous « cloud-1f2e3d4c » : la destination
 *    supprimée, sa coquille nettoyée (volet « Cloud non utilisé », lot 60), le
 *    nom n'avait plus rien pour se résoudre. Le nom s'écrit désormais AVEC la
 *    ligne (`dest_name`), la migration 53 remplit ce qui peut l'être encore,
 *    et l'écran nomme l'état actuel de la destination (supprimée, désactivée).
 *
 * 3. **Un masquage trop court n'est pas un masquage.** Un mot de passe
 *    d'application a fui dans une sortie de diagnostic au lot 74 (masque plat
 *    et partiel). `masquerSecrets` descend partout et remplace EN ENTIER ; les
 *    identifiants glissés dans une URL sont masqués jusque dans les détails
 *    d'erreur.
 *
 * Réintroduction des défauts : sans le refus avant service, les tests de la
 * partie 1 voient un « store » qui tente la copie ; sans `dest_name`, la
 * partie 2 revoit l'identifiant technique ; un masque partiel (préfixe
 * conservé) fait échouer les assertions « aucun fragment ».
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
let destinations;
let destinationSync;
let presets;
let erreurs;
let diagnostics;
let migrations;

test.before(async () => {
  await helpers.setup();
  db = require('../server/db/db');
  destinations = require('../server/destinations');
  destinationSync = require('../server/destinations/sync');
  presets = require('../server/destinations/presets');
  erreurs = require('../server/destinations/erreurs-rclone');
  diagnostics = require('../server/diagnostics');
  migrations = require('../server/db/migrations');

  await helpers.createUser({ username: 'lot75', plainPassword: 'MotDePasse1', role: 'admin' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot75', 'MotDePasse1');
});

test.after(() => {
  client?.close();
  helpers.teardown();
});

test.beforeEach(() => {
  db.get().prepare("DELETE FROM destinations_config WHERE dest_id != 'local'").run();
  db.get().prepare('DELETE FROM destination_logs').run();
  destinations.oublierPilotes();
  destinationSync.reset();
});

/**
 * La carte kDrive de l'incident : e-mail et mot de passe, PAS de numéro,
 * et pourtant ACTIVE — l'état exact d'une carte enregistrée avant la garde
 * du lot 74. `saveConfig` refuse désormais de produire cet état : il s'écrit
 * donc directement en base, comme le temps l'a écrit en production.
 */
function carteKdriveSansNumero({ displayName = 'kDrive perdu' } = {}) {
  const cree = destinations.createCloud({ provider: 'kdrive', displayName });
  destinations.saveConfig(
    cree.id,
    { enabled: false, valeurs: { user: 'camille@exemple.test', pass: 'invente' } },
    presets.of('kdrive').champs
  );
  db.get()
    .prepare('UPDATE destinations_config SET enabled = 1 WHERE dest_id = ?')
    .run(cree.id);
  destinations.oublierPilotes();
  return cree.id;
}

// ---------------------------------------------------------------------------
// 1. La configuration inutilisable se refuse partout, en nommant le champ
// ---------------------------------------------------------------------------

test('le motif nomme le champ à remplir — et se tait sur une configuration qui tient debout', () => {
  const casse = carteKdriveSansNumero();
  assert.match(destinations.motifConfigInutilisable(casse), /Numéro de votre kDrive/);

  destinations.saveConfig(casse, { valeurs: { kdriveId: '123456' } }, presets.of('kdrive').champs);
  assert.equal(destinations.motifConfigInutilisable(casse), null,
    'le numéro renseigné, la destination redevient jouable — rien d\'autre à faire');

  // Et les types qui ne sont pas WebDAV ne sont jamais inquiétés.
  const mega = destinations.createCloud({ provider: 'mega', displayName: 'MEGA' });
  destinations.saveConfig(
    mega.id,
    { enabled: true, valeurs: { user: 'camille@exemple.test', pass: 'invente' } },
    presets.of('mega').champs
  );
  assert.equal(destinations.motifConfigInutilisable(mega.id), null);
});

test('la carte le DIT : l\'avertissement porte le champ à remplir, avant toute tentative', async () => {
  const casse = carteKdriveSansNumero();
  const vue = await destinations.publicConfigComplet(casse);
  assert.ok(vue.avertissements.length >= 1, 'la carte cassée porte au moins un avertissement');
  assert.match(vue.avertissements[0], /Numéro de votre kDrive/);

  destinations.saveConfig(casse, { valeurs: { kdriveId: '123456' } }, presets.of('kdrive').champs);
  const reparee = await destinations.publicConfigComplet(casse);
  assert.equal(
    reparee.avertissements.some((a) => /Numéro de votre kDrive/.test(a)),
    false,
    'réparée, la carte cesse d\'avertir'
  );
});

test('« Tester » refuse AVANT le service, en français — plus jamais « unsupported protocol scheme »', async () => {
  const casse = carteKdriveSansNumero();
  const resultat = await destinations.test(casse);
  assert.equal(resultat.ok, false);
  assert.match(resultat.message, /kDrive perdu : /, 'le nom de la carte ouvre le message');
  assert.match(resultat.message, /Numéro de votre kDrive/);
  assert.equal(/unsupported protocol/i.test(resultat.message), false);
});

test('une copie refuse de même — définitivement : pas trois tentatives contre un échec certain', async () => {
  const casse = carteKdriveSansNumero();
  const driver = destinations.driverFor(casse);
  const resultat = await driver.store(destinations.readConfig(casse), {
    username: 'camille',
    connectorName: 'Exemple',
    accountId: 'defaut',
    issuedOn: '2026-01-15',
    filename: 'doc-invente.pdf',
    buffer: Buffer.from('contenu invente'),
  });
  assert.equal(resultat.ok, false);
  assert.equal(resultat.definitif, true,
    'le refus est structurel tant que la configuration ne change pas : la boucle de dépôt s\'arrête');
  assert.match(resultat.message, /Numéro de votre kDrive/);
});

test('« Synchroniser » cette destination est refusé net, avec le champ à remplir', () => {
  const casse = carteKdriveSansNumero();
  assert.throws(
    () => destinationSync.start({ destinationIds: [casse] }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Numéro de votre kDrive/);
      return true;
    }
  );
});

test('la synchronisation GLOBALE n\'attend pas la carte cassée : les jouables partent, la cassée est dite', async () => {
  const casse = carteKdriveSansNumero();
  const valide = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud sain' });
  destinations.DRIVERS[valide] = {
    ID: valide,
    NAME: 'pCloud sain',
    normalizeConf: (conf) => ({ ...conf, rcloneConfig: 'type = pcloud' }),
    store: async () => ({ ok: true, path: 'invente' }),
    test: async () => ({ ok: true, message: 'ok' }),
  };
  try {
    destinationSync.start({ destinationIds: [valide, casse] });
    for (let i = 0; i < 200 && destinationSync.progress().running; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const etat = destinationSync.progress();
    assert.equal(etat.running, false);
    assert.deepEqual(etat.destinationIds, [valide],
      'seules les destinations jouables sont synchronisées');
    assert.ok(
      etat.errors.some((e) => e.destId === casse && /non synchronisée/.test(e.message)
        && /Numéro de votre kDrive/.test(e.message)),
      'la carte cassée est dite dans le compte rendu, avec le champ à remplir'
    );
  } finally {
    delete destinations.DRIVERS[valide];
    destinationSync.reset();
  }
});

// ---------------------------------------------------------------------------
// 2. Le journal nomme ce qui a été supprimé
// ---------------------------------------------------------------------------

test('le nom s\'écrit AVEC la ligne de journal — au moment où il est encore connu', async () => {
  const casse = carteKdriveSansNumero({ displayName: 'kDrive perdu' });
  await destinations.test(casse); // écrit une ligne de journal (refus français)
  const ligne = db.get()
    .prepare('SELECT dest_name FROM destination_logs WHERE dest_id = ? ORDER BY id DESC LIMIT 1')
    .get(casse);
  assert.equal(ligne.dest_name, 'kDrive perdu');
});

test('migration 53 : ce qui peut encore être nommé l\'est, ce qui est perdu le reste — sans invention', () => {
  const inserer = db.get().prepare(
    'INSERT INTO destination_logs (dest_id, user_id, success, message) VALUES (?, NULL, 0, ?)'
  );
  inserer.run('local', 'ligne inventée');
  inserer.run('proton', 'identifiant hérité de l\'ancien modèle');
  inserer.run('cloud-fantome99', 'coquille nettoyée : le nom est déjà perdu');

  const migration53 = migrations.MIGRATIONS.find((m) => m.id === 53);
  assert.ok(migration53, 'la migration 53 existe');
  migration53.up(db.get());
  migration53.up(db.get()); // idempotente : la rejouer ne change rien

  const nomDe = (id) => db.get()
    .prepare('SELECT dest_name FROM destination_logs WHERE dest_id = ? ORDER BY id DESC LIMIT 1')
    .get(id).dest_name;
  assert.equal(nomDe('local'), 'Stockage local');
  assert.equal(nomDe('proton'), 'Proton Drive');
  assert.equal(nomDe('cloud-fantome99'), null,
    'un nom perdu reste perdu : le journal le dira en français, il ne l\'invente pas');
});

test('l\'écran reçoit le nom écrit, l\'état actuel de la destination — et jamais un identifiant technique', async () => {
  const coupee = helpers.creerCloud({
    provider: 'pcloud', displayName: 'pCloud coupé', enabled: false,
  });
  const inserer = db.get().prepare(
    'INSERT INTO destination_logs (dest_id, dest_name, user_id, success, message) VALUES (?, ?, NULL, 0, ?)'
  );
  // La destination supprimée DUR (coquille nettoyée), nom écrit à l'époque.
  inserer.run('cloud-fantome42', 'MEGA', 'échec d\'époque, destination depuis supprimée');
  // La même, mais d'avant la migration : le nom est perdu.
  inserer.run('cloud-fantome43', null, 'échec d\'époque, nom perdu');
  // Une destination désactivée, et une active.
  inserer.run(coupee, 'pCloud coupé', 'échec vers une destination désactivée');
  inserer.run('local', 'Stockage local', 'dépôt de contrôle');

  const rendu = await client.get('/api/admin/logs/storage?dest=all&result=all');
  assert.equal(rendu.status, 200);
  const par = (message) => rendu.body.logs.find((l) => l.message.includes(message));

  const supprimeeNommee = par('destination depuis supprimée');
  assert.equal(supprimeeNommee.destName, 'MEGA');
  assert.equal(supprimeeNommee.destEtat, 'supprimee');

  const supprimeeAnonyme = par('nom perdu');
  assert.equal(supprimeeAnonyme.destName, null,
    'aucun nom connu : le serveur ne renvoie pas l\'identifiant technique comme nom');
  assert.equal(supprimeeAnonyme.destEtat, 'supprimee');

  const desactivee = par('destination désactivée');
  assert.equal(desactivee.destName, 'pCloud coupé');
  assert.equal(desactivee.destEtat, 'desactivee');

  const active = par('dépôt de contrôle');
  assert.equal(active.destName, 'Stockage local');
  assert.equal(active.destEtat, 'active');
});

/**
 * La cellule « Destination » du VRAI `web/admin.js` : les fonctions sont
 * extraites et exécutées telles quelles (même règle que les lots 29 et 35 —
 * on exécute le code déployé, on ne recopie pas sa logique dans le test).
 */
function cellulesRendues(lignes) {
  const contexte = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const debut = source.indexOf('function destLogCell(');
  assert.ok(debut > 0, 'destLogCell introuvable dans admin.js');
  vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  contexte.LIGNES = lignes;
  return vm.runInContext('LIGNES.map((l) => destLogCell(l))', contexte);
}

test('la ligne affichée : « MEGA — destination supprimée », « désactivée », ou la mention seule', () => {
  const [nommee, anonyme, coupee, active, renommage] = cellulesRendues([
    { destName: 'MEGA', destEtat: 'supprimee' },
    { destName: null, destEtat: 'supprimee', dest_id: 'cloud-fantome42' },
    { destName: 'pCloud coupé', destEtat: 'desactivee' },
    { destName: 'Stockage local', destEtat: 'active' },
    { destName: 'Renommage des documents' },
  ]);
  assert.match(nommee, /MEGA/);
  assert.match(nommee, /destination supprimée/);
  assert.match(anonyme, /Destination supprimée/);
  assert.equal(anonyme.includes('cloud-fantome42'), false,
    'l\'identifiant technique ne s\'affiche jamais : c\'est lui qui a fait croire à des tentatives en cours');
  assert.match(coupee, /pCloud coupé/);
  assert.match(coupee, /désactivée/);
  assert.equal(active, 'Stockage local');
  assert.equal(renommage, 'Renommage des documents');
});

// ---------------------------------------------------------------------------
// 3. Le masquage des secrets : entier, récursif, jusque dans les URL
// ---------------------------------------------------------------------------

test('masquerSecrets descend partout et remplace EN ENTIER — aucun fragment ne survit', () => {
  const config = {
    provider: 'kdrive',
    config: {
      valeurs: {
        kdriveId: '123456',
        user: 'camille@exemple.test',
        pass: 'MotDePasseAppli789',
        otp_secret_key: 'CLETOTPINVENTEE234567',
      },
      rcloneConfig: 'type = webdav\nurl = https://123456.connect.exemple.test\npass = AbCdEfGh',
    },
    sessions: [{ client_access_token: 'JetonSession456', '2fa': 987654 }],
  };
  const masque = diagnostics.masquerSecrets(config);
  const texte = JSON.stringify(masque);

  // Le remplacement est TOTAL : même un préfixe de quatre caractères trahirait
  // la valeur — c'est un masque « trop court » qui a fait fuiter un mot de
  // passe d'application le 09/09/2026.
  for (const fragment of ['MotD', 'AbCd', 'CLET', 'Jeto', '987654']) {
    assert.equal(texte.includes(fragment), false, `le fragment « ${fragment} » a fui`);
  }
  assert.equal(masque.config.valeurs.pass, '[masqué]');
  assert.equal(masque.sessions[0].client_access_token, '[masqué]');
  assert.equal(masque.sessions[0]['2fa'], '[masqué]',
    'un code rangé comme NOMBRE est masqué aussi');
  assert.match(masque.config.rcloneConfig, /pass = \[masqué\]/,
    'les lignes secrètes d\'un bloc collé partent aussi');

  // Ce qui n'est pas secret reste lisible : un diagnostic tout noir ne sert à rien.
  assert.equal(masque.config.valeurs.kdriveId, '123456');
  assert.equal(masque.config.valeurs.user, 'camille@exemple.test');
  assert.match(masque.config.rcloneConfig, /url = https:\/\/123456\.connect\.exemple\.test/);
  // Et l'original n'est jamais modifié.
  assert.equal(config.config.valeurs.pass, 'MotDePasseAppli789');
});

test('les identifiants glissés dans une URL sont masqués jusque dans le détail d\'erreur', () => {
  const sortie = '2026/09/09 10:18:12 ERROR : Propfind '
    + '"https://camille:MotDePasseWebdav@serveur.exemple.test/dav": 500 Internal Server Error';
  const detail = erreurs.detailUtile(sortie);
  assert.equal(detail.includes('MotDePasseWebdav'), false, 'le mot de passe a fui dans le journal');
  assert.match(detail, /https:\/\/\[masqué\]@serveur\.exemple\.test/);

  // Et dans le message qui cite une adresse incomplète : jamais le mot de passe.
  const motif = destinations.motifAdresseWebdav('autre', {
    valeurs: { url: 'camille:MotDePasseWebdav@serveur.exemple.test/dav' },
  });
  assert.match(motif, /incomplète/);
  assert.equal(motif.includes('MotDePasseWebdav'), false);
  assert.match(motif, /\[masqué\]@serveur\.exemple\.test/);
});

// ---------------------------------------------------------------------------
// 4. La carte kDrive tient en trois champs : l'aide se replie, l'exemple se voit
// ---------------------------------------------------------------------------

/**
 * Le HTML d'un champ, produit par le VRAI `web/admin.js` (même harnais que le
 * lot 29 : `fieldHelp` vient d'app.js, les deux fichiers partagent la page).
 */
function champRendu(champ) {
  const contexte = vm.createContext({ CHAMPS_TYPE: {}, console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'fmt.js'), 'utf8'), contexte);
  const appSource = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  vm.runInContext(appSource.match(/^const AIDE_LONGUE = .+$/m)[0], contexte);
  const debutAide = appSource.indexOf('function fieldHelp(');
  vm.runInContext(appSource.slice(debutAide, appSource.indexOf('\n}\n', debutAide) + 3), contexte);
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const debut = source.indexOf('function champHtml(');
  vm.runInContext(source.slice(debut, source.indexOf('\n}\n', debut) + 3), contexte);
  contexte.D = { id: 'kd-essai', valeurs: {}, secretsRenseignes: [], configured: false };
  contexte.C = { ...champ, obscurcir: undefined };
  return vm.runInContext('champHtml(D, C)', contexte);
}

test('l\'aide kDrive se replie : une ligne courte visible par champ, le reste derrière le dépliant', () => {
  for (const cle of ['kdriveId', 'pass']) {
    const champ = presets.CHAMPS_KDRIVE.find((c) => c.key === cle);
    const html = champRendu(champ);
    assert.match(html, /<details>/, `l'aide de ${cle} porte son dépliant`);
    const visible = html.slice(0, html.indexOf('<details>'));
    const texteVisible = visible.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.ok(
      texteVisible.length < 220,
      `la part toujours visible de ${cle} reste une ligne courte — mesurée à ${texteVisible.length} caractères`
    );
  }
});

test('le piège du mot de passe reste en PREMIÈRE ligne : ce n\'est pas celui du compte', () => {
  const champ = presets.CHAMPS_KDRIVE.find((c) => c.key === 'pass');
  const html = champRendu(champ);
  const visible = html.slice(0, html.indexOf('<details>'));
  assert.match(visible, /PAS le mot de passe de votre compte Infomaniak/);
});

test('l\'exemple visuel du numéro : la forme de l\'adresse kDrive, en filigrane et dans l\'aide — jamais une valeur réelle', () => {
  const champ = presets.CHAMPS_KDRIVE.find((c) => c.key === 'kdriveId');
  const html = champRendu(champ);
  assert.match(html, /placeholder="par exemple : 123456"/);
  const visible = html.slice(0, html.indexOf('<details>'));
  assert.match(visible, /https:\/\/123456\.connect\.kdrive\.infomaniak\.com/,
    'la ligne visible montre la forme mesurée au lot 74 : le numéro dans le nom d\'hôte');
});

test('rien n\'est retiré : déplié, le mode d\'emploi complet est toujours là', () => {
  const aides = Object.fromEntries(presets.CHAMPS_KDRIVE.map((c) => [c.key, String(c.help || '')]));
  // Où lire le numéro, et le fait que crabe compose l'adresse tout seul.
  assert.match(aides.kdriveId, /\/kdrive\//);
  assert.match(aides.kdriveId, /compose lui-même l'adresse/);
  // Le chemin complet de création du mot de passe d'application.
  assert.match(aides.pass, /manager\.infomaniak\.com/);
  assert.match(aides.pass, /Mot\(s\) de passe d'application/);
  assert.match(aides.pass, /montrée qu'une seule fois/);
});
