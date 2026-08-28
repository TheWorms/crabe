'use strict';

/**
 * Lot 68 — les applications modernes n'ont pas de lien de déconnexion, et
 * crabe sait le prouver autrement.
 *
 * Le 28/08/2026 entre 12:56 et 12:59, trois refus d'enregistrement d'une
 * session Anthropic pourtant valide : claude.ai ne met aucun lien de
 * déconnexion dans son document, et RAMÈNE la navigation vers son accueil en
 * gardant la cible en fragment — `/settings/billing` demandé,
 * `/new#settings/billing` affiché. Le contrôle générique ne trouvait ni
 * marqueur, ni adresse « tenue » — et le message invitait à « finir de se
 * connecter » alors qu'il n'y avait rien à finir.
 *
 * Le traitement est GÉNÉRAL : `remoteLogin.renvoiAnonyme = "connexion"`
 * déclare une MESURE (le site renvoie tout anonyme de la page de contrôle
 * vers son formulaire de connexion), et ne pas y être renvoyé, en restant sur
 * le site, devient la preuve. Ces tests mordent sur : la voie de preuve
 * elle-même, ses trois gardes (renvoi vers la connexion, changement de site,
 * mur 403), le fragment qui n'est pas un chemin, la préséance sur le refus de
 * tenue, la liste blanche du schéma, et le message qui ne confond plus
 * « preuve manquante » avec « session expirée » ni « pas encore connecté ».
 *
 * ⚠ Toutes les adresses et valeurs sont INVENTÉES (exemple.test) — sauf les
 * formes d'URL de claude.ai, qui sont la mesure publique du défaut.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');
const schema = require('../server/connectors/manifest-schema');
const preuve = require('../server/connectors/preuve-connexion');

// ---------------------------------------------------------------------------
// Phase A — les aides partagées : fragment et site
// ---------------------------------------------------------------------------

test('un fragment n\'est pas un chemin : le ré-ancrage mesuré sur claude.ai ne « tient » pas', () => {
  // La forme EXACTE du 28/08/2026 : l'application ramène vers l'accueil en
  // gardant la cible en fragment. L'adresse visée n'a PAS été atteinte.
  assert.equal(
    preuve.adresseTenue('https://claude.ai/new#settings/billing', 'https://claude.ai/settings/billing'),
    false
  );
  // Un fragment AJOUTÉ à l'adresse atteinte, lui, ne change rien à la tenue.
  assert.equal(
    preuve.adresseTenue('https://claude.ai/settings/billing#factures', 'https://claude.ai/settings/billing'),
    true
  );
  assert.equal(preuve.sansFragment('https://claude.ai/new#settings/billing'), 'https://claude.ai/new');
});

test('adresse de contrôle À fragment (Electro Dépôt) : la comparaison reste entière', () => {
  // La route de l'application VIT dans le fragment (`#/order`, lot 52).
  // Écarter aveuglément les fragments accepterait n'importe quelle page du
  // compte : ce test tombe si `adresseTenue` cesse de comparer le fragment
  // déclaré.
  const controle = 'https://www.electrodepot.fr/customer/account/#/order';
  assert.equal(preuve.adresseTenue(controle, controle), true);
  assert.equal(
    preuve.adresseTenue('https://www.electrodepot.fr/customer/account/#/profile', controle),
    false
  );
});

test('memeSite : le sous-domaine du service oui, un autre site non', () => {
  assert.equal(preuve.memeSite('https://claude.ai/new', 'https://claude.ai/settings/billing'), true);
  assert.equal(preuve.memeSite('https://account.deezer.com/fr/login/', 'https://www.deezer.com/fr/account'), true);
  // Le piège du suffixe : « deezer.com.exemple.net » n'a de deezer que le début.
  assert.equal(preuve.memeSite('https://deezer.com.exemple.net/', 'https://www.deezer.com/fr/account'), false);
  assert.equal(preuve.memeSite('https://ailleurs.exemple.net/accueil', 'https://exemple.test/compte'), false);
});

// ---------------------------------------------------------------------------
// Phase B — le schéma : une mesure déclarée, jamais une supposition
// ---------------------------------------------------------------------------

function manifesteMinimal(remoteLogin) {
  return {
    id: 'exemple-lot68',
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

test('schéma : renvoiAnonyme n\'accepte que la valeur mesurée « connexion »', () => {
  const bon = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
  }));
  assert.equal(bon.ok, true, bon.errors.join(' | '));

  const inconnu = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'accueil',
  }));
  assert.equal(inconnu.ok, false, 'une valeur non mesurée ne doit pas passer');
  assert.match(inconnu.errors.join(' '), /renvoiAnonyme/);
});

test('schéma : renvoiAnonyme sans verifyUrl est refusé — aucune adresse dont mesurer le renvoi', () => {
  const resultat = schema.validate(manifesteMinimal({ renvoiAnonyme: 'connexion' }));
  assert.equal(resultat.ok, false);
  assert.match(resultat.errors.join(' '), /renvoiAnonyme sans remoteLogin\.verifyUrl/);
});

test('schéma : un chemin d\'accueil n\'est pas une page réservée', () => {
  // Par simple préfixe, « l'adresse a tenu » serait vrai de n'importe quelle
  // page du site — formulaire de connexion compris. Le manifeste est refusé.
  for (const options of [
    { verifyUrl: 'https://exemple.test/', verifyUrlTient: true },
    { verifyUrl: 'https://exemple.test/', renvoiAnonyme: 'connexion' },
  ]) {
    const resultat = schema.validate(manifesteMinimal(options));
    assert.equal(resultat.ok, false, JSON.stringify(options));
    assert.match(resultat.errors.join(' '), /chemin d'accueil/);
  }
  // Une vraie page réservée, elle, passe.
  const bon = schema.validate(manifesteMinimal({
    verifyUrl: 'https://exemple.test/compte/factures',
    verifyUrlTient: true,
  }));
  assert.equal(bon.ok, true, bon.errors.join(' | '));
});

test('schéma : la liste blanche recopie renvoiAnonyme — sans elle, la clé disparaîtrait en silence', () => {
  const charge = schema.normalize(manifesteMinimal({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
  }));
  assert.equal(charge.remoteLogin.renvoiAnonyme, 'connexion');
  // Absent du manifeste : chaîne vide, jamais undefined — comme les autres options.
  const sans = schema.normalize(manifesteMinimal({ verifyUrl: 'https://exemple.test/compte/factures' }));
  assert.equal(sans.remoteLogin.renvoiAnonyme, '');
});

test('manifestes réels : les six connecteurs au renvoi mesuré le déclarent', () => {
  // anthropic (13/08 + journaux du 28/08), deezer et soundcloud (18/08),
  // amazon et infomaniak (sondes anonymes du 28/08), mistral (13/08 : « la
  // garde précède le routage », le renvoi dit l'absence de session).
  for (const id of ['anthropic', 'deezer', 'soundcloud', 'amazon', 'infomaniak', 'mistral']) {
    const manifeste = require(`../server/connectors/available/${id}/manifest.json`);
    assert.equal(manifeste.remoteLogin.renvoiAnonyme, 'connexion', id);
    assert.ok(manifeste.remoteLogin.verifyUrl, `${id} : pas de renvoi mesurable sans adresse de contrôle`);
  }
});

test('infomaniak : l\'adresse de contrôle n\'est plus la racine', () => {
  // Mesuré le 28/08/2026 : la racine est servie à tout le monde (redirigée),
  // /v3 est chassé pour l'anonyme et rendu au connecté. Une racine rendrait
  // la preuve par renvoi vide de sens — le schéma la refuse d'ailleurs.
  const manifeste = require('../server/connectors/available/infomaniak/manifest.json');
  assert.equal(manifeste.remoteLogin.verifyUrl, 'https://manager.infomaniak.com/v3');
});

test('un oauth2/authorize final est un écran d\'authentification — le renvoi mesuré des impôts', () => {
  // La forme EXACTE du 28/08/2026 (paramètres raccourcis) : la session
  // rejouée finit sur l'IdP avec prompt=login. Sans cette reconnaissance, le
  // verdict disait « page valide, aucun marqueur » au lieu de « renvoi vers
  // l'authentification » — et le message envoyait signaler un défaut de crabe
  // au lieu d'inviter à se reconnecter.
  assert.equal(
    preuve.estUrlAuthentification(
      'https://cfspart-idp.impots.gouv.fr/oauth2/authorize?authType=sso&prompt=login&scope=openid'
    ),
    true
  );
  assert.equal(
    preuve.estUrlAuthentification('https://exemple.test/oauth/authorize?client_id=x'),
    true
  );
  // Un chemin qui ne fait que CONTENIR le mot n'est pas un écran : le domaine
  // n'est jamais examiné, et « autoriser » dans un chemin ordinaire non plus.
  assert.equal(preuve.estUrlAuthentification('https://exemple.test/compte/autorisations'), false);
});

// ---------------------------------------------------------------------------
// Doubles de système — la recette de test/lot48-verdict.test.js, avec un
// document simulé (lot 49) : les `evaluate` du contrôle exécutent la VRAIE
// fonction de production sur ce document.
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

function fakeSpawn(fs) {
  return (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fs.existants.add(`/tmp/.X11-unix/X${display}`);
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

/** La page de la FENÊTRE — juste assez pour la détection. */
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

/**
 * Le Playwright du contrôle HEADLESS : un seul écran, décrit par son adresse
 * finale, son statut et son texte. `evaluate` exécute la vraie fonction du
 * contrôle (corps vide ?) sur un document simulé.
 */
function fauxControleHeadless(ecran) {
  const lancements = [];
  return {
    lancements,
    module: {
      chromium: {
        launch: async () => {
          lancements.push(ecran.url);
          const pageControle = {
            setDefaultTimeout: () => {},
            goto: async () => (ecran.statut ? { status: () => ecran.statut } : undefined),
            waitForLoadState: async () => {},
            url: () => ecran.url,
            locator: (selecteur) => ({ count: async () => ecran.selecteurs?.[selecteur] || 0 }),
            evaluate: async (fn, arg) => {
              global.document = { body: { innerText: ecran.texteCorps || '' } };
              try {
                return fn(arg);
              } finally {
                delete global.document;
              }
            },
          };
          return {
            newContext: async () => ({ newPage: async () => pageControle }),
            close: async () => {},
          };
        },
      },
    },
  };
}

function makeManager({ ecranControle, urlFenetre = 'https://exemple.test/apres-connexion' }) {
  const journal = [];
  const fs = fakeFs({
    present: ['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
      '/usr/share/novnc/core/rfb.js'],
  });
  const sonde = fauxControleHeadless(ecranControle);
  const manager = remoteBrowser.createManager({
    fs,
    os: {
      totalmem: () => 4096 * 1024 * 1024,
      freemem: () => 2600 * 1024 * 1024,
    },
    spawn: fakeSpawn(fs),
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
  return { manager, journal, sonde };
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
// Phase C — la voie de preuve, et ses gardes
// ---------------------------------------------------------------------------

test('renvoi mesuré : la session ré-ancrée en fragment est CONFIRMÉE — le cas Anthropic du 28/08', async () => {
  // Le contrôle atteint la page réservée ; l'application ramène vers
  // l'accueil en gardant la cible en fragment. Aucun marqueur générique,
  // aucune tenue d'adresse — seule la voie du renvoi mesuré peut conclure.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/nouveau#compte/factures',
      statut: 200,
      texteCorps: 'Votre abonnement Exemple',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1, 'la session doit être enregistrée');
  // Le journal dit la preuve ET sa nature : un comportement mesuré.
  const ligne = contexte.journal.find((l) => /connexion confirmée/.test(l.message));
  assert.ok(ligne, 'la preuve doit être journalisée');
  assert.match(ligne.message, /sans renvoi vers la connexion/);
  assert.match(ligne.message, /comportement mesuré/);
});

test('renvoi mesuré : l\'anonyme renvoyé vers la connexion reste REFUSÉ — la forme exacte du renvoi claude.ai', async () => {
  // La mesure du 13/08, revue le 28/08 dans les journaux : hors session, la
  // page de contrôle renvoie vers /login?from=logout&returnTo=… Si cette
  // adresse passait pour une preuve, la voie du renvoi enregistrerait des
  // cookies anonymes.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/login?from=logout&returnTo=%2Fcompte%2Ffactures%3F',
      statut: 200,
      texteCorps: 'Connectez-vous',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'rien ne doit être enregistré');
  assert.match(resultat.error, /pas encore terminée/);
  assert.equal(resultat.view.verdictCode, 'refus');
});

test('renvoi mesuré : un départ vers un AUTRE site ne prouve rien', async () => {
  // Une page qui répond, non vide, sans formulaire — mais ailleurs. Sans la
  // garde `memeSite`, n'importe quelle redirection sortante vaudrait preuve.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://ailleurs.exemple.net/accueil',
      statut: 200,
      texteCorps: 'Bienvenue ailleurs',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);
  assert.equal(resultat.view.verdictCode, 'sans-preuve');
});

test('renvoi mesuré : un mur 403 ne conclut toujours rien — la garde froide de Cloudflare', async () => {
  // Une session qui a perdu sa levée de garde reçoit un 403 d'interstitiel,
  // adresse tenue, corps non vide (« Just a moment... »). La voie du renvoi
  // ne doit PAS transformer ce mur en preuve.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/compte/factures',
      statut: 403,
      texteCorps: 'Just a moment...',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);
  assert.equal(resultat.view.verdictCode, 'mur');
});

test('renvoi mesuré : un 401 qui répond une page ne conclut rien — le statut mesuré des anonymes SoundCloud', async () => {
  // Mesuré le 18/08/2026 : hors session, /you/subscriptions répond 401. Un
  // 401 peut servir une page d'excuse non vide, sans formulaire, à la bonne
  // adresse : sans la garde de statut, la voie du renvoi le prendrait pour
  // une preuve — et enregistrerait une session morte.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/compte/factures',
      statut: 401,
      texteCorps: 'Oups, quelque chose a mal tourné.',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0, 'un 401 ne doit jamais enregistrer');
  assert.equal(resultat.view.verdictCode, 'sans-preuve');
});

test('tenue déclarée ET renvoi mesuré : le ré-ancrage ne passe plus pour « éconduit »', async () => {
  // Avec verifyUrlTient seul, une adresse qui ne tient pas conclut « c'est
  // ainsi que le site éconduit les visiteurs sans session » — FAUX pour une
  // application qui ré-ancre ses connectés. Quand le renvoi est mesuré, c'est
  // lui qui tranche : pas de renvoi vers la connexion = confirmé.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/nouveau#compte/factures',
      statut: 200,
      texteCorps: 'Votre abonnement Exemple',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    verifyUrlTient: true,
    renvoiAnonyme: 'connexion',
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: 1 } };
    },
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, true, `attendu : enregistré — reçu : ${resultat.error || 'ok'}`);
  assert.equal(captures.length, 1);
});

test('tenue déclarée SANS renvoi mesuré : la redirection reste un refus — le cas OUIGO inchangé', async () => {
  // OUIGO renvoie ses anonymes vers l'ACCUEIL, pas vers un formulaire : là,
  // seule la tenue stricte discrimine, et la relâcher enregistrerait des
  // cookies anonymes. Ce test fige le comportement du lot 40.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/accueil',
      statut: 200,
      texteCorps: 'Bienvenue sur Exemple',
    },
  });
  const captures = [];

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/reservations',
    verifyUrlTient: true,
    onDetected: async (etat) => void captures.push(etat),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(captures.length, 0);
  assert.match(resultat.error, /pas encore terminée/);
});

// ---------------------------------------------------------------------------
// Phase D — le message quand la preuve manque : trois situations, trois phrases
// ---------------------------------------------------------------------------

test('preuve manquante : le message ne dit NI « expiré » NI seulement « finissez de vous connecter »', async () => {
  // Page valide, aucun marqueur, aucun renvoi mesuré déclaré : crabe ne sait
  // pas prouver la session. Elle n'est PAS forcément mauvaise — c'est le cas
  // Anthropic d'avant ce lot. Dire « expiré » enverrait se reconnecter en
  // boucle (le piège Darty du lot 51) ; dire seulement « finissez de vous
  // connecter » accuserait l'utilisateur d'un défaut de crabe.
  const contexte = makeManager({
    ecranControle: {
      url: 'https://exemple.test/compte/factures',
      statut: 200,
      texteCorps: 'Votre abonnement Exemple',
    },
  });

  await contexte.manager.start(ouverture({
    verifyUrl: 'https://exemple.test/compte/factures',
    onDetected: async () => ({}),
  }));

  const resultat = await enregistrer(contexte.manager);
  assert.equal(resultat.ok, false);
  assert.equal(resultat.view.verdictCode, 'sans-preuve');
  // La phrase est VRAIE : elle dit que la vérification est impossible, pas
  // que la session est mauvaise.
  assert.match(resultat.error, /ne montre rien qui permette de vérifier/);
  assert.match(resultat.error, /pas un problème d'identifiants/);
  assert.match(resultat.error, /signalez-le/);
  // Et elle ne ment dans aucun des deux sens.
  assert.equal(/expir/i.test(resultat.error), false,
    'la session n\'est pas expirée : le dire enverrait se reconnecter en boucle');
  assert.equal(/^La connexion n'est pas encore terminée/.test(resultat.error), false,
    'le refus générique accuserait l\'utilisateur d\'un défaut de crabe');
});

test('les trois situations restent trois phrases distinctes', () => {
  // 1. Renvoi vers l'authentification (pas encore connecté) — message du refus.
  // 2. Preuve manquante (connecté mais rien à lire) — message du lot 68.
  // 3. Session expirée (échéance dépassée) — message de session-state.
  const sessionState = require('../server/connectors/session-state');
  const expiree = sessionState.validate(JSON.stringify({
    cookies: [{ name: 'seul', value: 'x', domain: '.exemple.test', expires: 1000 }],
  }), { now: 2000 });
  assert.equal(expiree.ok, false);
  assert.match(expiree.error, /expiré/);
  assert.match(expiree.error, /Reconnectez-vous/);
  // Les trois textes ne partagent aucune phrase : chacun envoie vers le bon
  // geste — finir de se connecter, signaler, se reconnecter.
  const manquante = 'La page ne montre rien qui permette de vérifier votre connexion.';
  const pasFinie = 'La connexion n\'est pas encore terminée.';
  assert.notEqual(manquante, pasFinie);
  assert.equal(expiree.error.includes(manquante), false);
  assert.equal(expiree.error.includes(pasFinie), false);
});
