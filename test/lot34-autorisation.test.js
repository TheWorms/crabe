'use strict';

/**
 * Lot 34, phase A — l'autorisation d'un espace de stockage, menée par crabe.
 *
 * ─── Ce que ces tests protègent ──────────────────────────────────────────────
 *
 * 1. **Le jeton ne fuit nulle part.** Il va de la sortie d'rclone à la
 *    configuration chiffrée : aucun journal, aucune vue publique, aucun
 *    message de fenêtre ne doit le porter. C'est vérifié sur pièce, avec un
 *    jeton reconnaissable.
 *
 * 2. **Une autorisation abandonnée ne laisse pas d'orphelin.** Un
 *    `rclone authorize` qui survit garde le port 53682 ouvert et condamne
 *    toutes les autorisations suivantes (`bind: address already in use`,
 *    mesuré). Quel que soit le chemin de sortie de la fenêtre, la commande
 *    meurt.
 *
 * 3. **Les questions préalables atteignent la commande.** Sans sa région,
 *    `rclone authorize zoho` meurt sur `Error: no region set` avant d'afficher
 *    quoi que ce soit (mesuré, v1.75.0) : la valeur enregistrée doit devenir
 *    `RCLONE_ZOHO_REGION` dans l'environnement du processus.
 *
 * 4. **La sortie d'rclone se lit sans se faire piéger.** Les lignes
 *    d'encadrement (`Paste the following…`) ont réellement piégé l'utilisateur au
 *    copier-coller (`invalid character 'S'`, 14/08/2026) ; l'extraction les
 *    ignore, et accepte les deux formes mesurées (JSON brut, blob base64).
 *
 * Le processus rclone et la fenêtre visible sont SIMULÉS : ces tests jugent la
 * mécanique d'orchestration, pas le binaire — lui a été mesuré à la main (voir
 * PROGRESS.md du lot 34).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');

const autorisation = require('../server/destinations/autorisation');
const rclone = require('../server/destinations/rclone');
const backends = require('../server/destinations/backends');

let destinations;

test.before(async () => {
  await helpers.setup();
  destinations = require('../server/destinations');
});

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Le jeton des scénarios : reconnaissable, pour être cherché PARTOUT. */
const JETON_TEMOIN = '{"access_token":"SECRET-JETON-TEMOIN-123","token_type":"bearer","refresh_token":"SECRET-RAFRAICHI-456"}';

// ---------------------------------------------------------------------------
// Les doublures : un rclone et une fenêtre qui obéissent au doigt
// ---------------------------------------------------------------------------

function fauxRclone() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (child.exitCode === null) {
      child.exitCode = 143;
      child.emit('exit', 143);
    }
  };
  child.direErreur = (ligne) => child.stderr.emit('data', `${ligne}\n`);
  child.montrerUrl = () =>
    child.direErreur('2026/08/14 19:18:02 NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=abc123');
  child.finir = (code, sortie = '') => {
    if (sortie) child.stdout.emit('data', sortie);
    child.exitCode = code;
    child.emit('exit', code);
  };
  return child;
}

function fauxManager() {
  const m = {
    demarrages: [],
    conclusions: [],
    session: null,
    indiceRegion: null,
    start: async (opts) => {
      m.demarrages.push(opts);
      m.session = { connectorId: opts.connectorId, indiceRegion: m.indiceRegion, opts };
      return { sessionId: 's1', connectorId: opts.connectorId, state: 'running', message: 'ouvert' };
    },
    conclure: async (userId, connectorId, resultat) => {
      m.conclusions.push({ userId, connectorId, ...resultat });
      m.session = null;
    },
    sessionFor: () => m.session,
  };
  return m;
}

/** Un runtime complet : rclone simulé, fenêtre simulée, journal capturé. */
function fauxRuntime({ env = {}, indiceRegion = null } = {}) {
  const enfants = [];
  const manager = fauxManager();
  manager.indiceRegion = indiceRegion;
  const journal = [];
  return {
    enfants,
    manager,
    journal,
    rt: {
      spawn: (bin, args, options) => {
        const child = fauxRclone();
        child.bin = bin;
        child.args = args;
        child.options = options;
        enfants.push(child);
        return child;
      },
      manager: () => manager,
      log: (niveau, message) => journal.push(`[${niveau}] ${message}`),
      now: () => Date.now(),
      // Le catalogue rclone local n'est pas requis pour juger la MÉCANIQUE :
      // ces deux crochets remplacent les seules fonctions qui l'interrogent.
      typeAutorisable: async () => true,
      environnement: async () => env,
    },
  };
}

function parametres(enregistrements = []) {
  return {
    userId: 1,
    destId: 'cloud-test',
    type: 'zoho',
    nom: 'Zoho essai',
    valeurs: { region: 'eu' },
    enregistrer: (jeton, indiceRegion) => enregistrements.push({ jeton, indiceRegion }),
  };
}

// ---------------------------------------------------------------------------
// 1. Le parcours complet — et le jeton ne fuit nulle part
// ---------------------------------------------------------------------------

test('le parcours complet range le jeton, et le jeton ne fuit nulle part', async () => {
  const enregistrements = [];
  const { enfants, manager, journal, rt } = fauxRuntime({
    env: { RCLONE_ZOHO_REGION: 'eu' },
  });

  const promesse = autorisation.demarrer(parametres(enregistrements), rt);
  await attendre(50);
  const child = enfants[0];
  assert.ok(child, 'rclone a été lancé');

  // 3. Les questions préalables atteignent la commande : la région est dans
  // l'environnement du processus, pas seulement dans la base.
  assert.equal(child.bin.includes('rclone'), true);
  assert.deepEqual(child.args, ['authorize', 'zoho', '--auth-no-open-browser']);
  assert.equal(child.options.env.RCLONE_ZOHO_REGION, 'eu',
    'la réponse préalable doit être dans l\'environnement d\'rclone');

  child.montrerUrl();
  const vue = await promesse;

  // La fenêtre s'est ouverte sur l'URL d'rclone, sans capture de session.
  assert.equal(manager.demarrages.length, 1);
  assert.equal(manager.demarrages[0].url, 'http://127.0.0.1:53682/auth?state=abc123');
  assert.equal(manager.demarrages[0].capture, false,
    'JAMAIS de capture : la session du fournisseur ne regarde pas crabe');
  assert.equal(vue.state, 'running');

  // rclone rend son jeton, encadré comme en vrai.
  child.finir(0, `Paste the following into your remote machine --->\n${JETON_TEMOIN}\n<---End paste\n`);
  await attendre(50);

  assert.equal(enregistrements.length, 1, 'le jeton a été rangé');
  assert.equal(enregistrements[0].jeton, JETON_TEMOIN);
  assert.equal(manager.conclusions.length, 1);
  assert.equal(manager.conclusions[0].ok, true);
  assert.equal(autorisation.enCours(), null, 'plus rien en cours');

  // ⚠ La preuve centrale : le jeton n'apparaît NI dans le journal, NI dans la
  // conclusion de la fenêtre, NI dans la vue rendue au client.
  const toutCeQuiSort = JSON.stringify({ journal, conclusions: manager.conclusions, vue });
  assert.equal(toutCeQuiSort.includes('SECRET-JETON-TEMOIN-123'), false,
    'le jeton ne doit exister nulle part hors de la configuration chiffrée');
  assert.equal(toutCeQuiSort.includes('SECRET-RAFRAICHI-456'), false);
});

// ---------------------------------------------------------------------------
// 2. Une autorisation abandonnée ne laisse pas d'orphelin
// ---------------------------------------------------------------------------

test('la fenêtre fermée tue rclone — aucun processus orphelin', async () => {
  const { enfants, manager, rt } = fauxRuntime();

  const promesse = autorisation.demarrer(parametres(), rt);
  await attendre(50);
  const child = enfants[0];
  child.montrerUrl();
  await promesse;

  assert.equal(child.exitCode, null, 'rclone tourne pendant que la fenêtre est ouverte');

  // L'utilisateur annule (ou ferme l'onglet, ou le délai tombe) : la fenêtre
  // prévient par son rappel de fin — c'est LUI qui doit tuer la commande.
  await manager.demarrages[0].onFin('cancelled');
  await attendre(20);

  assert.ok(child.kills.includes('SIGTERM'), 'rclone a reçu l\'ordre de mourir');
  assert.notEqual(child.exitCode, null, 'rclone est mort — le port 53682 est libre');
  assert.equal(autorisation.enCours(), null);
  assert.equal(manager.conclusions.length, 0,
    'pas de double conclusion : la fenêtre a déjà dit pourquoi elle s\'est fermée');
});

test('une seule autorisation à la fois, et le refus parle français', async () => {
  const { enfants, manager, rt } = fauxRuntime();

  const promesse = autorisation.demarrer(parametres(), rt);
  await attendre(50);
  enfants[0].montrerUrl();
  await promesse;

  await assert.rejects(
    autorisation.demarrer(parametres(), fauxRuntime().rt),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /déjà en cours/);
      assert.match(err.message, /une seule/i);
      return true;
    }
  );

  await manager.demarrages[0].onFin('cancelled');
  await attendre(20);
});

// ---------------------------------------------------------------------------
// 3. Les échecs parlent français, et n'enregistrent rien
// ---------------------------------------------------------------------------

test('un refus chez le fournisseur conclut en français, sans rien ranger', async () => {
  const enregistrements = [];
  const { enfants, manager, rt } = fauxRuntime();

  const promesse = autorisation.demarrer(parametres(enregistrements), rt);
  await attendre(50);
  const child = enfants[0];
  child.montrerUrl();
  await promesse;

  child.direErreur('Error: failed to get token: oauth2: "access_denied"');
  child.finir(1);
  await attendre(50);

  assert.equal(enregistrements.length, 0, 'rien n\'a été enregistré');
  assert.equal(manager.conclusions.length, 1);
  assert.equal(manager.conclusions[0].ok, false);
  assert.match(manager.conclusions[0].message, /refusé/);
  assert.match(manager.conclusions[0].message, /recommencer/i);
  assert.equal(autorisation.enCours(), null);
});

test('une région manquante est expliquée avant même d\'ouvrir la fenêtre', async () => {
  const { enfants, manager, rt } = fauxRuntime();

  const promesse = autorisation.demarrer(parametres(), rt);
  await attendre(50);
  const child = enfants[0];
  child.direErreur('Error: no region set');
  child.finir(2);

  await assert.rejects(promesse, (err) => {
    assert.match(err.message, /région/);
    assert.match(err.message, /formulaire/);
    return true;
  });
  assert.equal(manager.demarrages.length, 0, 'aucune fenêtre ouverte pour rien');
  assert.equal(autorisation.enCours(), null);
});

// ---------------------------------------------------------------------------
// 4. La lecture de la sortie d'rclone — les deux formes mesurées
// ---------------------------------------------------------------------------

test('l\'extraction ignore les lignes d\'encadrement qui ont piégé le copier-coller', () => {
  // La forme EXACTE mesurée sur le binaire v1.75.0, lignes d'encadrement
  // comprises — celles réellement attrapées en trop.
  const sortie = `Paste the following into your remote machine --->\n${JETON_TEMOIN}\n<---End paste\n`;
  const lu = autorisation.extraireJeton(sortie);
  assert.equal(lu.ok, true);
  assert.equal(lu.jeton, JETON_TEMOIN);

  // Sans encadrement (par prudence : la forme a déjà changé entre versions).
  const brut = autorisation.extraireJeton(JETON_TEMOIN);
  assert.equal(brut.ok, true);
  assert.equal(brut.jeton, JETON_TEMOIN);

  // La forme « blob base64 » (invocation avec argument) : base64 STANDARD de
  // {"token":"<json>"} — le jeton interne est déballé.
  const blob = Buffer.from(JSON.stringify({ token: JETON_TEMOIN })).toString('base64').replace(/=+$/, '');
  const deballe = autorisation.extraireJeton(
    `Paste the following into your remote machine --->\n${blob}\n<---End paste\n`
  );
  assert.equal(deballe.ok, true);
  assert.equal(deballe.jeton, JETON_TEMOIN);

  // Du bruit sans jeton : un refus net, qui ne cite pas la sortie.
  const refus = autorisation.extraireJeton('NOTICE: rien du tout');
  assert.equal(refus.ok, false);
  assert.equal(refus.erreur.includes('NOTICE'), false);

  // Un objet sans access_token n'est pas un jeton.
  assert.equal(autorisation.extraireJeton('{"expiry":"2026-01-01"}').ok, false);
});

// ---------------------------------------------------------------------------
// 5. L'état d'une autorisation, lu dans son jeton
// ---------------------------------------------------------------------------

test('l\'état de la carte suit le jeton : jamais, connecté, expiré, échéance', () => {
  const dans = (jours) => new Date(Date.now() + jours * 24 * 3600 * 1000).toISOString();

  assert.equal(autorisation.etatDuJeton('').etat, 'jamais');
  assert.equal(autorisation.etatDuJeton('pas du json').etat, 'invalide');
  assert.equal(autorisation.etatDuJeton('{"expiry":"2026-01-01"}').etat, 'invalide');

  // Un refresh_token : rclone renouvelle tout seul (mesuré) — connecté, même
  // avec une échéance dépassée.
  assert.equal(
    autorisation.etatDuJeton(`{"access_token":"a","refresh_token":"r","expiry":"${dans(-30)}"}`).etat,
    'connecte'
  );
  // Pas d'échéance du tout (pCloud) : connecté.
  assert.equal(autorisation.etatDuJeton('{"access_token":"a"}').etat, 'connecte');
  // Le zéro de Go (« 0001-01-01 ») veut dire « pas de fin », pas « expiré ».
  assert.equal(
    autorisation.etatDuJeton('{"access_token":"a","expiry":"0001-01-01T00:00:00Z"}').etat,
    'connecte'
  );
  // Sans refresh_token, l'échéance fait foi : passée, bientôt, lointaine.
  assert.equal(autorisation.etatDuJeton(`{"access_token":"a","expiry":"${dans(-1)}"}`).etat, 'expiree');
  const bientot = autorisation.etatDuJeton(`{"access_token":"a","expiry":"${dans(3)}"}`);
  assert.equal(bientot.etat, 'echeance');
  assert.ok(bientot.echeance, 'l\'échéance est donnée, pour être affichée');
  assert.equal(autorisation.etatDuJeton(`{"access_token":"a","expiry":"${dans(60)}"}`).etat, 'connecte');
});

// ---------------------------------------------------------------------------
// 6. Les réponses préalables, depuis le vrai catalogue
// ---------------------------------------------------------------------------

test('la région enregistrée devient RCLONE_ZOHO_REGION — depuis le vrai catalogue', async () => {
  // Sur une machine sans rclone, le catalogue est vide et l'environnement
  // aussi : c'est une information, pas un échec — le CT, lui, a son binaire.
  const catalogue = await backends.champsBrutsDuType('zoho');
  const env = await autorisation.environnementPrealable('zoho', {
    region: 'eu',
    token: '{"access_token":"NE-DOIT-PAS-PARTIR"}',
    inconnu: 'jamais',
  });

  if (!catalogue) {
    assert.deepEqual(env, {}, 'sans catalogue, rien ne part — et rien ne casse');
    return;
  }
  assert.equal(env.RCLONE_ZOHO_REGION, 'eu');
  assert.equal(Object.values(env).some((v) => String(v).includes('NE-DOIT-PAS-PARTIR')), false,
    'le jeton (machinerie OAuth) ne part JAMAIS en environnement');
  assert.equal('RCLONE_ZOHO_INCONNU' in env, false, 'une clé hors catalogue ne part pas');
});

// ---------------------------------------------------------------------------
// 7. Le jeton rafraîchi ne meurt pas avec la configuration jetable
// ---------------------------------------------------------------------------

test('un jeton réécrit par rclone dans la conf jetable est reversé', async () => {
  // Mesuré (v1.75.0) : sur jeton expiré, rclone rafraîchit et RÉÉCRIT son
  // rclone.conf. La conf de crabe étant jetable, le relevé d'après-opération
  // est la seule chose qui sépare « session durable » de « panne dans un mois ».
  const releves = [];
  const dest = {
    remoteName: 'essai',
    rcloneConfig: 'type = yandex\ntoken = {"access_token":"VIEUX"}',
    onSecretsRafraichis: (changements) => releves.push(changements),
  };

  await rclone.withConfig(dest, async (confFile) => {
    // rclone, joué par le test : il régénère sa configuration avec le neuf.
    fs.writeFileSync(confFile, '[essai]\ntype = yandex\ntoken = {"access_token":"NEUF"}\n');
  });
  assert.deepEqual(releves, [{ token: '{"access_token":"NEUF"}' }]);

  // Rien ne change → pas de relevé : pas d'écriture en base pour rien.
  const immobile = [];
  await rclone.withConfig(
    { ...dest, onSecretsRafraichis: (c) => immobile.push(c) },
    async () => {}
  );
  assert.deepEqual(immobile, []);
});

test('la session durable Proton déposée dans la conf jetable est moissonnée', async () => {
  // Vérifié dans la source d'rclone v1.75.0 : après CHAQUE authentification
  // Proton réussie, `authHandler` écrit client_uid, client_access_token,
  // client_refresh_token et client_salted_key_pass dans la configuration —
  // et leur présence déclenche `UseReusableLogin` : plus de mot de passe, plus
  // de code 2FA. Sans cette moisson, crabe capturait puis JETAIT la session à
  // chaque opération, condamnant le compte au code éternel.
  const releves = [];
  const dest = {
    remoteName: 'proton',
    rcloneConfig: 'type = protondrive\nusername = camille@exemple.fr\npassword = obscurci',
    onSecretsRafraichis: (changements) => releves.push(changements),
  };

  await rclone.withConfig(dest, async (confFile) => {
    fs.writeFileSync(confFile, '[proton]\ntype = protondrive\nusername = camille@exemple.fr\n'
      + 'password = obscurci\nclient_uid = UID-TEMOIN\nclient_access_token = ACCES-TEMOIN\n'
      + 'client_refresh_token = RAFRAICHI-TEMOIN\nclient_salted_key_pass = SEL-TEMOIN\n');
  });
  assert.deepEqual(releves, [{
    client_uid: 'UID-TEMOIN',
    client_access_token: 'ACCES-TEMOIN',
    client_refresh_token: 'RAFRAICHI-TEMOIN',
    client_salted_key_pass: 'SEL-TEMOIN',
  }]);

  // Une clé étrangère à la liste blanche n'est PAS moissonnée : on ne range
  // pas ce qu'on ne comprend pas.
  const etranger = [];
  await rclone.withConfig(
    { ...dest, onSecretsRafraichis: (c) => etranger.push(c) },
    async (confFile) => {
      fs.writeFileSync(confFile, '[proton]\ntype = protondrive\nusername = camille@exemple.fr\n'
        + 'password = obscurci\nchose_inconnue = valeur\n');
    }
  );
  assert.deepEqual(etranger, []);
});

test('la session durable rangée rend la carte honnête : avis adaptés, booléen sans secret', async () => {
  const presets = require('../server/destinations/presets');

  // Sans session : le code seul avertit (« Tester MAINTENANT »), comme au lot 33.
  const sansSession = presets.avertissements('protondrive', { valeurs: { '2fa': '123456' } });
  assert.equal(sansSession.length, 1);
  assert.match(sansSession[0], /trentaine de secondes/);
  assert.match(sansSession[0], /Tester/);

  // Avec la session : le code a fait son travail, plus rien à signaler.
  assert.deepEqual(
    presets.avertissements('protondrive', {
      valeurs: { '2fa': '123456', client_uid: 'u', client_access_token: 'a' },
    }),
    []
  );

  // La fausse clé (le cas réel de la production) : deux vérités selon la
  // session. Sans elle, « chaque copie échouera » ; avec elle, les copies
  // MARCHENT et le message le dit — c'est la reconnexion future qui paierait.
  const fausseCle = { otp_secret_key: '654321' };
  assert.match(presets.avertissements('protondrive', { valeurs: fausseCle })[0], /chaque copie échouera/);
  const avecSession = presets.avertissements('protondrive', {
    valeurs: { ...fausseCle, client_uid: 'u', client_access_token: 'a' },
  });
  assert.match(avecSession[0], /copies marchent/);
  assert.match(avecSession[0], /effacez-la/i);

  // Le booléen sur la carte — et JAMAIS les valeurs de session.
  const id = destinations.createCloud({ provider: 'proton', displayName: 'Proton témoin' }).id;
  destinations.saveConfig(id, { valeurs: {
    username: 'camille@exemple.fr',
    client_uid: 'UID-SECRET-XYZ',
    client_access_token: 'ACCES-SECRET-XYZ',
    client_refresh_token: 'RAFRAICHI-SECRET-XYZ',
    client_salted_key_pass: 'SEL-SECRET-XYZ',
  } });
  const carte = await destinations.publicConfigComplet(id);
  assert.equal(carte.sessionDurable, true);
  const json = JSON.stringify(carte);
  for (const temoin of ['UID-SECRET-XYZ', 'ACCES-SECRET-XYZ', 'RAFRAICHI-SECRET-XYZ', 'SEL-SECRET-XYZ']) {
    assert.equal(json.includes(temoin), false, `la vue publique ne doit pas porter ${temoin}`);
  }

  // Et sans les client_* : sessionDurable est false, jamais « indéfini » pour
  // un Proton — c'est ce qui permet à l'écran de faire la différence avec un
  // fournisseur que la session ne concerne pas.
  const nu = destinations.createCloud({ provider: 'proton', displayName: 'Proton nu' }).id;
  const carteNue = await destinations.publicConfigComplet(nu);
  assert.equal(carteNue.sessionDurable, false);
  const pcloudCarte = await destinations.publicConfigComplet(
    destinations.createCloud({ provider: 'pcloud', displayName: 'pas concerné' }).id
  );
  assert.equal(pcloudCarte.sessionDurable, undefined);
});

// ---------------------------------------------------------------------------
// 8. Le jeton se range là où la configuration vit
// ---------------------------------------------------------------------------

test('enregistrerJeton écrit dans le bloc collé quand c\'est lui qui fait foi', async () => {
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud bloc' }).id;

  // Une configuration par BLOC : c'est elle qui prime à l'exécution
  // (`normalizeConf`) — un jeton rangé à côté serait ignoré en silence.
  destinations.saveConfig(id, { rcloneConfig: 'type = pcloud\ntoken = {"access_token":"VIEUX"}' });
  destinations.enregistrerJeton(id, '{"access_token":"NEUF"}', 'eapi.pcloud.com');

  const conf = destinations.readConfig(id);
  assert.match(conf.rcloneConfig, /token = \{"access_token":"NEUF"\}/);
  assert.match(conf.rcloneConfig, /hostname = eapi\.pcloud\.com/, 'la région suit le jeton');
  assert.equal(conf.rcloneConfig.includes('VIEUX'), false);

  // Et la forme « champs nommés » : le jeton va dans `valeurs`.
  const id2 = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud champs' }).id;
  destinations.enregistrerJeton(id2, '{"access_token":"NEUF2"}', 'eapi.pcloud.com');
  const conf2 = destinations.readConfig(id2);
  assert.equal(conf2.valeurs.token, '{"access_token":"NEUF2"}');
  assert.equal(conf2.valeurs.hostname, 'eapi.pcloud.com');
});

// ---------------------------------------------------------------------------
// Phase B — la région pCloud, et la règle transverse « saisi ⇒ dans le bloc »
// ---------------------------------------------------------------------------

/**
 * Verdict de la tâche 6, mesuré en production le 14/08/2026 (cloud-a19497a4) :
 * hypothèse A — la configuration ne contenait QU'UNE clé (`token`), jamais de
 * `hostname` : personne n'avait posé la question de la région. Le bloc généré
 * portait fidèlement tout ce qui était en base ; rien n'était « jeté en
 * route ». Ces tests verrouillent les deux moitiés du correctif : la carte
 * AVERTIT tant que la région manque, et tout réglage saisi arrive dans le
 * bloc — pour tout backend, présent ou futur.
 */

test('pCloud avec jeton mais sans région : la carte avertit, et dit quoi faire', () => {
  const presets = require('../server/destinations/presets');

  // Le cas exact de la production : un jeton, rien d'autre.
  const commeEnProd = presets.avertissements('pcloud', {
    valeurs: { token: '{"access_token":"x"}' },
  });
  assert.equal(commeEnProd.length, 1, 'un avertissement, pas zéro');
  assert.match(commeEnProd[0], /région/);
  assert.match(commeEnProd[0], /Europe/);
  assert.match(commeEnProd[0], /échouera/);
  assert.match(commeEnProd[0], /Où est hébergé votre compte pCloud/);

  // La région choisie : plus rien à signaler.
  assert.deepEqual(
    presets.avertissements('pcloud', {
      valeurs: { token: '{"access_token":"x"}', hostname: 'eapi.pcloud.com' },
    }),
    []
  );

  // Un bloc collé compte aussi : le jeton et la région peuvent vivre dedans.
  assert.equal(
    presets.avertissements('pcloud', {
      rcloneConfig: 'type = pcloud\ntoken = {"access_token":"x"}\nhostname = eapi.pcloud.com',
    }).length,
    0
  );
  assert.match(
    presets.avertissements('pcloud', {
      rcloneConfig: 'type = pcloud\ntoken = {"access_token":"x"}',
    })[0],
    /région/
  );

  // Sans jeton : c'est le bouton qui est montré, plus le collage manuel.
  const sansJeton = presets.avertissements('pcloud', { valeurs: {} });
  assert.match(sansJeton[0], /jeton d'accès/i);
  assert.match(sansJeton[0], /Se connecter à pCloud/);
});

test('la destination de production se répare sans être recréée', () => {
  // La forme EXACTE mesurée sur le CT : remoteName/basePath/type, un bloc
  // vide, et `valeurs` réduit au jeton. Choisir la région puis enregistrer
  // doit suffire — sans toucher au jeton, sans recréer la destination.
  const id = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud prod' }).id;
  destinations.saveConfig(id, { valeurs: { token: '{"access_token":"jeton-de-prod"}' } },
    [{ key: 'token', type: 'password' }]);

  const avant = destinations.driverFor(id).normalizeConf(destinations.readConfig(id));
  assert.equal(/^hostname\s*=/m.test(avant.rcloneConfig), false, 'le défaut de départ');

  // Le geste de réparation : la région, et rien d'autre (jeton laissé vide =
  // « garde celui d'avant », la règle de toujours).
  destinations.saveConfig(id, { valeurs: { hostname: 'eapi.pcloud.com', token: '' } },
    [{ key: 'hostname', type: 'text' }, { key: 'token', type: 'password' }]);

  const apres = destinations.driverFor(id).normalizeConf(destinations.readConfig(id));
  assert.match(apres.rcloneConfig, /^hostname = eapi\.pcloud\.com$/m, 'la région atteint le bloc');
  assert.match(apres.rcloneConfig, /^token = \{"access_token":"jeton-de-prod"\}$/m,
    'et le jeton n\'a pas bougé');
});

test('un réglage saisi dans le formulaire arrive dans le bloc rclone — pour tout backend', async () => {
  // La règle transverse de la tâche 7 : ce que l'utilisateur saisit et que
  // crabe enregistre DOIT se retrouver dans le bloc généré. Le témoin est la
  // VALEUR, pas la clé : un preset a le droit de transformer ses champs
  // (kDrive fabrique une URL avec le numéro saisi), pas d'en perdre.

  // 1. Un fournisseur au formulaire ÉCRIT, avec transformation (kDrive).
  const kdrive = destinations.createCloud({ provider: 'kdrive', displayName: 'kDrive témoin' }).id;
  const champsK = await destinations.champsDe(kdrive);
  destinations.saveConfig(kdrive, {
    valeurs: { kdriveId: '424242', user: 'temoin@exemple.fr', pass: 'motdepasse-temoin' },
  }, champsK);
  const blocK = destinations.driverFor(kdrive).normalizeConf(destinations.readConfig(kdrive)).rcloneConfig;
  for (const temoin of ['424242', 'temoin@exemple.fr', 'motdepasse-temoin']) {
    assert.ok(blocK.includes(temoin), `kDrive : la valeur saisie « ${temoin} » doit être dans le bloc`);
  }

  // 2. Un fournisseur aux champs d'rclone (pCloud) — tous les champs texte
  // remplis d'une valeur témoin, listes strictes servies dans leur liste.
  const pcloud = destinations.createCloud({ provider: 'pcloud', displayName: 'pCloud témoin' }).id;
  const champsP = await destinations.champsDe(pcloud);
  if (!champsP.length) return; // machine sans rclone : mesuré ailleurs (CT)
  const valeurs = {};
  champsP.filter((c) => c.type !== 'password').forEach((c, i) => {
    valeurs[c.key] = c.options?.length ? c.options[0].value : `temoin-${i}`;
  });
  destinations.saveConfig(pcloud, { valeurs }, champsP);
  const blocP = destinations.driverFor(pcloud).normalizeConf(destinations.readConfig(pcloud)).rcloneConfig;
  for (const [cle, valeur] of Object.entries(valeurs)) {
    if (!String(valeur).trim()) continue;
    assert.ok(blocP.includes(String(valeur)),
      `pCloud : la valeur du champ « ${cle} » doit être dans le bloc généré`);
  }
  assert.match(blocP, /^hostname = eapi\.pcloud\.com$/m,
    'et la région — le champ du verdict — y est en toutes lettres');
});
