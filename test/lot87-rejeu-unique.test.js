'use strict';

/**
 * Lot 87 — Impots : pas de contrôle par rejeu à l'enregistrement ; la
 * récupération devient la preuve de session.
 *
 * ⚠ Erratum (lot 89) : le titre d'origine, « une connexion ne se rejoue
 * qu'une fois », est démenti — le 05/10/2026 à 11:09–11:16, sans contrôle à
 * l'enregistrement, une même capture a été rejouée trois fois en huit
 * minutes, toutes servies. Ce qui reste mesuré (05/10/2026, nuit) : avec
 * l'ancien enchaînement, le rejeu de contrôle (sur `documents.do` SANS
 * `?n=0`) suivi d'un autre rejeu 1 à 20 s plus tard renvoyait le second vers
 * `j_spring_security_logout.ex` → `/deconnexion2` → `/` (clé de requête
 * `logout`), le site fermant la session sur TOUT le portail — et la
 * récupération partie une seconde après le contrôle (passages n° 638 et 639)
 * écrivait « aucune année exposée par le site ». Cause non isolée : rejeux
 * rapprochés, ou adresse de contrôle sans `?n=0`. Le comportement testé ici
 * ne change pas ; `rejeuUnique` garde son nom, historique.
 *
 * Ces tests mordent sur :
 *   - le schéma : `remoteLogin.rejeuUnique`, booléen, recopié par la liste
 *     blanche de normalisation ;
 *   - l'enregistrement : pour un connecteur déclaré, AUCUN navigateur n'est
 *     lancé avec la capture (le double de contrôle ÉCHOUE au premier
 *     lancement : s'il était appelé, le test tomberait) — et un connecteur
 *     non déclaré garde son contrôle à l'identique ;
 *   - le jugement d'arrivée (`jugerArrivee`, fonction pure) sur les chaînes
 *     EXACTES du 05/10/2026 — morsure sur le cas `/?logout`, qui sortait
 *     « aucune année » ;
 *   - le relevé de navigation : jamais une valeur, jamais une chaîne de
 *     requête, jamais une suite de six chiffres ou plus ;
 *   - `test()` : sans navigateur, et sans « Connexion valide » jamais établi.
 *
 * ⚠ Aucune donnée réelle : les chaînes reprennent les CHEMINS mesurés
 * (publics), les cookies portent des noms publics et des valeurs inventées.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const remoteBrowser = require('../server/remote-browser');
const schema = require('../server/connectors/manifest-schema');
const navigation = require('../server/connectors/releve-navigation');
const impots = require('../server/connectors/available/impots/connector');

// ---------------------------------------------------------------------------
// Phase A — le schéma : une déclaration, pas une supposition
// ---------------------------------------------------------------------------

function manifesteMinimal(remoteLogin) {
  return {
    id: 'exemple-lot87',
    name: 'Exemple',
    category: 'shopping',
    site: 'exemple.test',
    implementation: 'scraping',
    description: 'Récupère automatiquement vos factures Exemple pour les archiver.',
    remoteLogin: {
      url: 'https://exemple.test/connexion',
      ...remoteLogin,
    },
    fields: [{ key: 'session', label: 'Connexion', type: 'session', required: false }],
    permissions: [
      { key: 'factures', scope: 'read-write', description: 'Télécharge vos factures Exemple pour les archiver.' },
    ],
  };
}

test('schéma : rejeuUnique est un booléen, rien d\'autre', () => {
  const bon = schema.validate(manifesteMinimal({ rejeuUnique: true }));
  assert.equal(bon.ok, true, bon.errors.join(' | '));

  const faux = schema.validate(manifesteMinimal({ rejeuUnique: 'oui' }));
  assert.equal(faux.ok, false, 'une chaîne ne doit pas passer pour une déclaration');
  assert.match(faux.errors.join(' '), /rejeuUnique/);
});

test('schéma : la liste blanche recopie rejeuUnique — sans elle, la clé disparaîtrait en silence', () => {
  const charge = schema.normalize(manifesteMinimal({ rejeuUnique: true }));
  assert.equal(charge.remoteLogin.rejeuUnique, true);
  // Absent du manifeste : false, jamais undefined — comme les autres options.
  const sans = schema.normalize(manifesteMinimal({}));
  assert.equal(sans.remoteLogin.rejeuUnique, false);
});

test('manifestes réels : impots déclare rejeuUnique, et lui seul', () => {
  const dossier = path.join(__dirname, '..', 'server', 'connectors', 'available');
  const declarants = [];
  for (const id of fs.readdirSync(dossier)) {
    const fichier = path.join(dossier, id, 'manifest.json');
    if (!fs.existsSync(fichier)) continue;
    const manifeste = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    if (manifeste.remoteLogin?.rejeuUnique !== undefined) declarants.push(id);
  }
  assert.deepEqual(declarants, ['impots'],
    'rejeuUnique est une mesure propre à impots (05/10/2026) — aucun autre connecteur ne change');
  const impotsManifeste = require('../server/connectors/available/impots/manifest.json');
  assert.equal(impotsManifeste.remoteLogin.rejeuUnique, true);
});

// ---------------------------------------------------------------------------
// Doubles de système — la recette de test/lot68-preuve-par-renvoi.test.js.
// Le contrôle headless est un DOUBLE QUI ÉCHOUE AU PREMIER LANCEMENT : si
// l'enregistrement d'un connecteur à rejeu unique lançait un navigateur avec
// la capture, le test tomberait ici même.
// ---------------------------------------------------------------------------

function fakeFs({ present = [] } = {}) {
  const existants = new Set(present);
  return {
    existants,
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => {
      if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`);
    },
    readdirSync: () => {
      throw new Error('ENOENT');
    },
    readFileSync: () => {
      throw new Error('ENOENT');
    },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => existants.delete(String(p)),
  };
}

function fakeSpawn(fs_) {
  return (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fs_.existants.add(`/tmp/.X11-unix/X${display}`);
    }
    return {
      command,
      args: args.map(String),
      stdout: { resume: () => {} },
      stderr: { resume: () => {} },
      on: () => {},
      kill: () => {},
    };
  };
}

/** La page de la FENÊTRE — juste assez pour la détection et la preuve. */
function pageFenetre(url) {
  return {
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    isClosed: () => false,
    locator: () => ({
      count: async () => 0,
      first: () => ({ count: async () => 0, focus: async () => {} }),
    }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async () => null,
  };
}

/** Le contrôle headless : compte les lancements, et ÉCHOUE au premier. */
function controleQuiEchoue() {
  const lancements = [];
  return {
    lancements,
    module: {
      chromium: {
        launch: async () => {
          lancements.push('launch');
          throw new Error('lancement interdit par le test — un rejeu aurait lieu ici');
        },
      },
    },
  };
}

function makeManager({ rejeuUnique = false, urlFenetre = 'https://exemple.test/apres-connexion' } = {}) {
  const journal = [];
  const fs_ = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const sonde = controleQuiEchoue();
  const manager = remoteBrowser.createManager({
    fs: fs_,
    os: {
      totalmem: () => 4096 * 1024 * 1024,
      freemem: () => 2600 * 1024 * 1024,
    },
    spawn: fakeSpawn(fs_),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, connectorId) => journal.push({ level, message, connectorId }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({
      page: pageFenetre(urlFenetre),
      storageState: async () => ({
        cookies: [{ name: 'a', value: 'x', domain: '.exemple.test', expires: -1 }],
      }),
      close: async () => {},
    }),
    requirePlaywright: () => sonde.module,
    timeoutMs: 5_000,
    pollMs: 4,
  });
  return { manager, journal, sonde, rejeuUnique };
}

function ouverture(extra = {}) {
  return {
    userId: 1,
    connectorId: 'exemple',
    connectorName: 'Exemple',
    url: 'https://exemple.test/connexion',
    marker: '',
    ...extra,
  };
}

/** Deux clics « Enregistrer » : le premier confirme l'absence de saisie. */
async function enregistrer(manager) {
  const premier = await manager.saveNow(1, 'exemple');
  assert.equal(premier.ok, false);
  assert.match(premier.error, /Rien n'a encore été saisi/);
  return manager.saveNow(1, 'exemple');
}

// ---------------------------------------------------------------------------
// Phase B — l'enregistrement sans rejeu, et la morsure dans les deux sens
// ---------------------------------------------------------------------------

test('rejeuUnique : l\'enregistrement traverse SANS lancer aucun navigateur avec la capture', async () => {
  const contexte = makeManager();
  const captures = [];

  await contexte.manager.start(ouverture({
    rejeuUnique: true,
    verifyUrl: 'https://exemple.test/compte/factures',
    verifyUrlTient: true,
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1, 'la session doit être enregistrée');
  // LA morsure : le double échoue au premier lancement. Zéro lancement = zéro rejeu.
  assert.equal(contexte.sonde.lancements.length, 0,
    'aucun navigateur ne doit être lancé avec la capture');
  // Le verdict dit la vérité : pas de contrôle par rejeu, la récupération fera foi.
  const ligne = contexte.journal.find((l) => /SANS contrôle par rejeu/.test(l.message));
  assert.ok(ligne, 'le journal doit dire que rien n\'a été rejoué');
  assert.match(ligne.message, /la récupération qui suit en fera la preuve/);
  // Rien ne prétend que la connexion a été vérifiée.
  assert.doesNotMatch(resultat.view.message || '', /validité vérifiée|Session enregistrée —/);
  assert.match(resultat.view.message, /La récupération qui démarre maintenant en fera la preuve/);
});

test('sans rejeuUnique, le contrôle par rejeu reste : le double est bien appelé (et son échec refuse)', async () => {
  const contexte = makeManager();
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false, 'un contrôle qui ne peut pas s\'exécuter ne conclut rien');
  assert.equal(captures.length, 0, 'rien ne doit être enregistré');
  // La contre-morsure : pour un connecteur ORDINAIRE, le lancement a eu lieu.
  assert.equal(contexte.sonde.lancements.length, 1,
    'le contrôle des autres connecteurs doit rester à l\'identique');
});

test('rejeuUnique : la sonde automatique ne consomme rien non plus — la fenêtre attend le clic', async () => {
  // Le même gestionnaire, mais SANS clic : la boucle de surveillance tourne
  // (pollMs 4) sur une page qui ne montre ni saisie ni preuve. Si la sonde
  // sur changement d'adresse rejouait la capture, le double tomberait.
  const contexte = makeManager({ urlFenetre: 'https://exemple.test/espace' });
  await contexte.manager.start(ouverture({
    rejeuUnique: true,
    verifyUrl: 'https://exemple.test/compte/factures',
    verifyUrlTient: true,
    onDetected: async () => ({}),
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(contexte.sonde.lancements.length, 0,
    'la sonde automatique ne doit lancer aucun navigateur pour un connecteur à rejeu unique');
  await contexte.manager.stop(1, 'exemple');
});

// ---------------------------------------------------------------------------
// Phase C — le jugement d'arrivée, sur les chaînes EXACTES du 05/10/2026
// ---------------------------------------------------------------------------

test('jugement : la liste atteinte, onglets présents — l\'adresse finale juge', () => {
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/enp/documents.do?n=0',
    chemins: ['/enp/documents.do'],
    onglets: 10,
  });
  assert.equal(verdict.verdict, 'liste');
  assert.match(verdict.raison, /10 onglet/);
});

test('jugement : le détour par l\'authentification suivi d\'un RETOUR sur la liste est un succès', () => {
  // Un premier rejeu peut passer par `/` et `oauth2/authorize` avant de
  // revenir sur la liste : on juge l'adresse FINALE, jamais les étapes.
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/enp/documents.do?n=0',
    chemins: ['/enp/documents.do', '/', '/oauth2/authorize', '/enp/documents.do'],
    onglets: 10,
  });
  assert.equal(verdict.verdict, 'liste');
});

test('jugement : la chaîne de déconnexion mesurée à 01:40:04 — session fermée par le site', () => {
  // 302 /enp/documents.do → /enp/j_spring_security_logout.ex ; 302 →
  // /deconnexion2 ; 302 → / ; 200 / avec une clé de requête logout.
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/?logout',
    chemins: [
      '/enp/documents.do', '/enp/j_spring_security_logout.ex',
      '/enp/j_spring_security_logout.ex', '/deconnexion2',
      '/deconnexion2', '/',
      '/',
    ],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'session-fermee');
});

test('jugement MORSURE : « /?logout » seul, même sans chaîne relevée, n\'est JAMAIS « aucune année »', () => {
  // Les passages n° 638 et 639 sont arrivés là et ont écrit « aucune année
  // exposée par le site ; 0 année(s) à parcourir ». Ce verdict-ci est ce qui
  // l'interdit : une page qui n'est pas la liste ne peut plus être lue vide.
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/?logout',
    chemins: [],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'session-fermee');

  const erreur = impots.erreurDArrivee(verdict);
  assert.equal(erreur.message, impots.MESSAGE_SESSION_FERMEE);
  assert.equal(erreur.sessionExpired, true);
  // Lot 71 : la phrase reste TELLE QUELLE — pas de réécriture en « votre
  // connexion a expiré » daté, faux pour une connexion ouverte deux minutes
  // plus tôt.
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(erreur.message, /Reconnectez-vous depuis la fiche du service/);
  assert.match(erreur.message, /la récupération démarre toute seule juste après/);
});

test('jugement : la chaîne « session morte » — connexion demandée', () => {
  // 302 /enp/documents.do → / ; 302 / → cfspart-idp…/oauth2/authorize ; 200.
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart-idp.impots.gouv.fr/oauth2/authorize?authType=sso&prompt=login',
    chemins: ['/enp/documents.do', '/', '/', '/oauth2/authorize', '/oauth2/authorize'],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'connexion-demandee');

  const erreur = impots.erreurDArrivee(verdict);
  assert.equal(erreur.sessionExpired, true);
  assert.match(erreur.message, /Rouvrez-la depuis la fiche du service/);
});

test('jugement : sur la liste mais sans onglets — la page a changé, pas la session', () => {
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/enp/documents.do?n=0',
    chemins: ['/enp/documents.do'],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'liste-illisible');

  const erreur = impots.erreurDArrivee(verdict);
  assert.equal(erreur.sessionExpired, undefined, 'cet échec n\'accuse pas la session');
  assert.match(erreur.message, /la page des documents d'impots\.gouv\.fr a changé/i);
  assert.match(erreur.message, /Votre connexion n'est pas en cause/);
});

test('jugement : tout le reste est une page inattendue, dite par sa forme — jamais ses paramètres', () => {
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://www.impots.gouv.fr/portail/accueil?jeton=0123456789abcdef',
    chemins: ['/portail/accueil'],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'page-inattendue');
  assert.doesNotMatch(verdict.raison, /jeton|0123456789/);

  const erreur = impots.erreurDArrivee(verdict);
  assert.equal(erreur.sessionExpired, undefined);
  assert.match(erreur.message, /page inattendue/);
});

test('jugement : l\'accueil de l\'espace (accueilensupres.do) n\'est ni la liste ni une déconnexion', () => {
  const verdict = impots.jugerArrivee({
    urlFinale: 'https://cfspart.impots.gouv.fr/enp/accueilensupres.do',
    chemins: ['/enp/documents.do', '/enp/accueilensupres.do'],
    onglets: 0,
  });
  assert.equal(verdict.verdict, 'page-inattendue');
});

// ---------------------------------------------------------------------------
// Phase D — l'attente d'arrivée : stabilisée, jamais en vol
// ---------------------------------------------------------------------------

function pageArrivee({ urls, comptes }) {
  let appels = 0;
  return {
    appels: () => appels,
    url: () => urls[Math.min(appels, urls.length - 1)],
    locator: () => ({
      count: async () => {
        const valeur = comptes[Math.min(appels, comptes.length - 1)];
        appels++;
        if (valeur === 'detruit') {
          throw new Error('Execution context was destroyed, most likely because of a navigation');
        }
        return valeur;
      },
    }),
    waitForTimeout: async () => {},
  };
}

test('attente : les onglets qui apparaissent après deux pas sont attendus, pas manqués', async () => {
  const page = pageArrivee({
    urls: ['https://cfspart.impots.gouv.fr/enp/documents.do?n=0'],
    comptes: [0, 0, 10],
  });
  const arrivee = await impots.attendreArrivee(page, { delaiMs: 2_000, pasMs: 1 });
  assert.equal(arrivee.onglets, 10);
});

test('attente : « Execution context was destroyed » ne fait plus tomber un passage', async () => {
  const page = pageArrivee({
    urls: ['https://cfspart.impots.gouv.fr/enp/documents.do?n=0'],
    comptes: ['detruit', 'detruit', 10],
  });
  const arrivee = await impots.attendreArrivee(page, { delaiMs: 2_000, pasMs: 1 });
  assert.equal(arrivee.onglets, 10);
});

test('attente : une adresse stable HORS de la liste rend la main sans attendre le délai entier', async () => {
  const page = pageArrivee({
    urls: ['https://cfspart.impots.gouv.fr/?logout'],
    comptes: [0, 0, 0, 0],
  });
  const debut = Date.now();
  const arrivee = await impots.attendreArrivee(page, { delaiMs: 60_000, pasMs: 1 });
  assert.equal(arrivee.onglets, 0);
  assert.ok(Date.now() - debut < 5_000, 'deux lectures identiques suffisent');
});

// ---------------------------------------------------------------------------
// Phase E — le relevé de navigation : des formes, jamais des valeurs
// ---------------------------------------------------------------------------

test('relevé : une réponse se dit par statut, hôte, chemin et renvoi — la requête n\'en sort JAMAIS', () => {
  const ligne = navigation.formaterReponse({
    statut: 302,
    url: 'https://cfspart.impots.gouv.fr/enp/documents.do?idEnsua=0123456789abcdef0123456789abcdef',
    renvoi: '/enp/j_spring_security_logout.ex',
    poses: ['JSESSIONID'],
    effaces: [],
  });
  assert.match(ligne, /^302 cfspart\.impots\.gouv\.fr \/enp\/documents\.do → cfspart\.impots\.gouv\.fr \/enp\/j_spring_security_logout\.ex/);
  assert.match(ligne, /cookies posés : JSESSIONID/);
  // LA morsure : rien de la clé d'accès ne sort — ni le nom du paramètre, ni
  // sa valeur, ni le moindre fragment d'hexadécimal long.
  assert.doesNotMatch(ligne, /idEnsua|0123456789abcdef|\?|=/);
});

test('relevé : les noms de cookies sortent, leurs valeurs jamais — pose et effacement distingués', () => {
  const { poses, effaces } = navigation.nomsDeCookies([
    'JSESSIONID=VALEURSECRETE abc; Path=/enp; HttpOnly',
    'fsdgfippart=autrevaleur; Domain=.cfspart.impots.gouv.fr; Max-Age=0',
    'ensu=encoreune; Expires=Mon, 01 Jan 1990 00:00:00 GMT',
  ]);
  assert.deepEqual(poses, ['JSESSIONID']);
  assert.deepEqual(effaces, ['fsdgfippart', 'ensu']);
  const tout = JSON.stringify({ poses, effaces });
  assert.doesNotMatch(tout, /VALEURSECRETE|autrevaleur|encoreune/);
});

test('relevé : les suites de six chiffres ou plus sont masquées, dans un chemin comme dans un nom', () => {
  assert.equal(navigation.masquerChiffres('/dossier/1234567890/avis'), '/dossier/…/avis');
  assert.equal(navigation.masquerChiffres('compte-12345'), 'compte-12345', 'cinq chiffres restent lisibles');
  const ligne = navigation.formaterReponse({
    statut: 200,
    url: 'https://exemple.test/compte/9876543210/documents',
  });
  assert.doesNotMatch(ligne, /9876543210/);
  assert.match(ligne, /\/compte\/…\/documents/);
});

test('relevé : la différence d\'états compare les valeurs EN MÉMOIRE et ne rend que des noms', () => {
  const avant = [
    { name: 'JSESSIONID', value: 'ancienne', domain: 'cfspart.impots.gouv.fr', path: '/enp' },
    { name: 'fsdgfippart', value: 'pareille', domain: '.cfspart.impots.gouv.fr', path: '/' },
    { name: 'ensu', value: 'x', domain: 'cfspart.impots.gouv.fr', path: '/' },
  ];
  const apres = [
    { name: 'JSESSIONID', value: 'nouvelle', domain: 'cfspart.impots.gouv.fr', path: '/enp' },
    { name: 'fsdgfippart', value: 'pareille', domain: '.cfspart.impots.gouv.fr', path: '/' },
    { name: 'cfsotp', value: 'y', domain: 'cfspart-idp.impots.gouv.fr', path: '/' },
  ];
  const diff = navigation.differenceEtats(avant, apres);
  assert.deepEqual(diff, { ajoutes: ['cfsotp'], changes: ['JSESSIONID'], retires: ['ensu'] });

  const ligne = navigation.formaterDifference(diff);
  assert.match(ligne, /ajoutés : cfsotp/);
  assert.match(ligne, /valeur changée : JSESSIONID/);
  assert.match(ligne, /retirés : ensu/);
  assert.doesNotMatch(ligne, /ancienne|nouvelle|pareille/);

  assert.match(
    navigation.formaterDifference(navigation.differenceEtats(avant, avant)),
    /aucun changement/
  );
});

test('relevé : deux cookies de même nom et de portées différentes sont deux cookies', () => {
  const avant = [{ name: 'JSESSIONID', value: 'a', domain: 'h.test', path: '/enp' }];
  const apres = [
    { name: 'JSESSIONID', value: 'a', domain: 'h.test', path: '/enp' },
    { name: 'JSESSIONID', value: 'b', domain: 'h.test', path: '/' },
  ];
  const diff = navigation.differenceEtats(avant, apres);
  assert.deepEqual(diff.ajoutes, ['JSESSIONID']);
  assert.deepEqual(diff.changes, []);
});

// ---------------------------------------------------------------------------
// Phase F — test() : honnête, et sans navigateur
// ---------------------------------------------------------------------------

function sessionValide() {
  return JSON.stringify({
    cookies: [{
      name: 'exemple',
      value: 'inventee',
      domain: '.impots.gouv.fr',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
    }],
    origins: [],
  });
}

test('test() : une session enregistrée rend un verdict honnête — jamais « Connexion valide »', async () => {
  const lignes = [];
  const resultat = await impots.test(
    { session: sessionValide(), numeroFiscal: '1 234 567 890 123' },
    { log: (l) => lignes.push(l) }
  );
  assert.equal(resultat.ok, true);
  assert.equal(resultat.accountId, '1234567890123');
  assert.doesNotMatch(resultat.message, /Connexion valide/);
  assert.match(resultat.message, /Connexion enregistrée/);
  assert.match(resultat.message, /la prochaine récupération en fera la preuve/);
  assert.match(lignes.join(' '), /pas de contrôle par rejeu/);
});

test('test() : sans session, le verdict dit quoi faire — toujours sans navigateur', async () => {
  const resultat = await impots.test({}, {});
  assert.equal(resultat.ok, false);
  assert.match(resultat.message, /impots\.gouv\.fr/i);
});

// ---------------------------------------------------------------------------
// Phase G — les compteurs « N documents » : toute espace, et jamais bloquants
// ---------------------------------------------------------------------------

test('compteurs : l\'espace insécable, littérale ou en entité, est acceptée', () => {
  const cas = [
    '<div id="2026"><em>4&nbsp;documents</em></div>',
    '<div id="2026"><em>4 documents</em></div>',
    '<div id="2026"><em>4 documents</em></div>',
    '<div id="2026"><em>4&#160;documents</em></div>',
    '<div id="2026"><em>4&#8239;documents</em></div>',
    '<div id="2026"><em>4 documents</em></div>',
    '<div id="2026"><em>1 document</em></div>',
  ];
  for (const html of cas) {
    const compteurs = impots.compteursDuHtml(html);
    assert.ok(compteurs['2026'] >= 1, `compteur illisible dans : ${html}`);
  }
});

test('compteurs : un libellé inconnu ne rend rien — et ce vide n\'est jamais une erreur', () => {
  const compteurs = impots.compteursDuHtml('<div id="2026"><em>4 fichiers</em></div>');
  assert.deepEqual(compteurs, {}, 'un libellé inattendu ne se devine pas');
});
