'use strict';

/**
 * Lot 105 — Alma réparé d'après l'essai réel du 12/10/2026 : la page « Non
 * merci » (R3), la session du portail dans le stockage du navigateur (R4), le
 * message d'une vraie page de connexion (R5).
 *
 * Au VRAI Chromium, sur des pages RECONSTITUÉES (test/lot104-faux-sites.js) :
 * la page du choix de la lettre d'information a la structure MESURÉE sur la
 * page enregistrée ; la session « dans le stockage seulement » imite ce que le
 * script public du portail fait (mesuré) — chaque page vérifie
 * `sessionStorage`, sans quoi elle renvoie vers `/login`. Ils prouvent la
 * lecture de cette forme, pas le vrai site.
 *
 * Côté fenêtre de connexion (capture), des doubles de système — aucun
 * navigateur, aucun réseau (le modèle du lot 95).
 *
 * ⚠ Valeurs inventées : identifiants « ZZessai… », jeton « ZZjetonEssai »,
 * montants à 0,00 €, « Commerçant d'essai ».
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const sessionState = require('../server/connectors/session-state');
const schema = require('../server/connectors/manifest-schema');
const remoteBrowser = require('../server/remote-browser');
const alma = require('../server/connectors/available/alma/connector');
const faux = require('./lot104-faux-sites');
const outils = require('./lot104-outils');

const ID = 'alma';
const RACINE = path.join(__dirname, '..');
const SOURCE = path.join(RACINE, 'server', 'connectors', 'available', ID, 'connector.js');
const PAYEES = ['installment_ZZessaiEch0101', 'installment_ZZessaiEch0102', 'installment_ZZessaiEch0201', 'installment_ZZessaiEch0202'];
const ANCRES = PAYEES.map((id) => `${ID}-recu-${id}`);
const NON_PAYEE = 'installment_ZZessaiEch0103';

const passer = (etat, options) => outils.passer(ID, alma, etat, options);

/** Les gestes permis : les quatre du lot 104, et « Non merci » ; jamais « Je m'inscris ». */
function seulementLesGestesPermis(journal, etat) {
  outils.rienDInterdit(journal, etat);
  assert.deepEqual(journal.choix, []);
  for (const g of journal.gestes) {
    const permis = ['Achats en cours', 'Achats terminés', 'Non merci'].includes(g.texte)
      || PAYEES.some((id) => g.testid === `payment-schedule-line-${id}`)
      || (g.testid === 'download-receipt' && g.texte === 'Télécharger le reçu')
      || g.testid === 'modal-close-button';
    assert.ok(permis, `un geste hors de la liste : ${JSON.stringify(g)}`);
    assert.notEqual(g.texte, 'Je m\'inscris', '« Je m\'inscris » n\'est JAMAIS cliqué');
    assert.notEqual(g.testid, `payment-schedule-line-${NON_PAYEE}`);
  }
}

const nonMerci = (journal) => journal.gestes.filter((g) => g.texte === 'Non merci').length;

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// R3 — la page du choix, le cinquième geste
// ---------------------------------------------------------------------------

test('R3 — `/login/marketing-optin` n\'est pas une page de connexion ; `/login` l\'est toujours', () => {
  assert.equal(alma.estPageDuChoixDeLettre('https://portal.getalma.eu/login/marketing-optin'), true);
  assert.equal(alma.estPageDuChoixDeLettre('https://portal.getalma.eu/login/marketing-optin/'), true);
  assert.equal(alma.estPageDeConnexion('https://portal.getalma.eu/login/marketing-optin'), false);
  for (const connexion of ['https://portal.getalma.eu/login', 'https://portal.getalma.eu/login/code', 'https://portal.getalma.eu/login/marketing-optin-x',
    'https://autre.exemple.invalid/login/marketing-optin']) {
    assert.equal(alma.estPageDeConnexion(connexion), true, connexion);
  }
});

test('R3 — le fichier se LIT : un cinquième geste, `nonMerci`, gelé, fait par `faireLeGeste` seul, gardé avant le clic ; « Je m\'inscris » n\'est jamais une cible', () => {
  const code = outils.codeSansCommentaires(SOURCE);
  assert.equal((code.match(/\.click\s*\(/g) || []).length, 1, 'toujours un seul clic dans tout le fichier');
  assert.deepEqual(Object.keys(alma.GESTES), ['onglet', 'ligne', 'recu', 'croix', 'nonMerci']);
  assert.ok(Object.isFrozen(alma.GESTES.nonMerci));
  assert.deepEqual({ ...alma.GESTES.nonMerci }, {
    repere: 'button[type="button"]', texte: 'Non merci', voisin: 'Je m\'inscris',
    chemin: '/login/marketing-optin', titre: 'Bienvenue sur votre portail Alma',
  });
  const { corps } = outils.corpsDe(code, 'async function faireLeGeste(');
  const clic = corps.indexOf('.click(');
  const branche = corps.indexOf('nom === \'nonMerci\'');
  assert.ok(branche >= 0 && branche < clic, 'la branche « Non merci » est avant le seul clic');
  for (const garde of ['!estPageDuChoixDeLettre(page.url())', 'vue.titre !== geste.titre', 'vue.inscription !== 1',
    'vue.nonMerci !== 1', '=== geste.texte) exacts.push(i)', 'exacts.length !== 1', '!== geste.texte']) {
    const ou = corps.indexOf(garde, branche);
    assert.ok(ou >= 0 && ou < clic, `la garde « ${garde} » est présente dans la branche, et avant le clic`);
  }
  // « Je m'inscris » n'est jamais une cible : dans `faireLeGeste`, il ne paraît
  // que dans la phrase d'un refus ; ailleurs, pour être déclaré (voisin),
  // COMPTÉ dans la lecture de la page, ou dit au journal.
  for (const ligne of corps.split('\n').filter((l) => /inscris/.test(l))) {
    assert.match(ligne, /surRefus\(/, `dans faireLeGeste, « Je m'inscris » seulement dans un refus : ${ligne.trim()}`);
  }
  assert.doesNotMatch(code, /getByText|hasText|has-text|:text\(/, 'aucune cible par texte libre');
  assert.doesNotMatch(code, /geste\.voisin|GESTES\.nonMerci\.voisin/, 'le voisin ne sert jamais de repère');
  const appels = [...code.matchAll(/faireLeGeste\(page, 'nonMerci'/g)];
  assert.equal(appels.length, 1, 'un seul appel du geste, dans l\'arrivée');
  assert.doesNotMatch(code, /initial-loader['"]\)\.remove|\.remove\(\)/, 'l\'écran de chargement n\'est jamais retiré');
});

test('R3 — « Non merci » refuse tout ailleurs : autre page, titre absent, voisin absent, deux boutons ; une cible donnée lève', async () => {
  const page = (url, vue) => ({
    url: () => url,
    evaluate: async () => vue,
    locator: () => { throw new Error('aucune cible ne doit être cherchée'); },
  });
  const bonne = { titre: 'Bienvenue sur votre portail Alma', nonMerci: 1, inscription: 1 };
  const refus = async (p) => {
    let raison = '';
    assert.equal(await alma.faireLeGeste(p, 'nonMerci', null, (r) => { raison = r; }), false);
    return raison;
  };
  assert.match(await refus(page('https://portal.getalma.eu/account/x', bonne)), /n'est pas celle du choix/);
  assert.match(await refus(page('https://portal.getalma.eu/login/marketing-optin', { ...bonne, titre: 'Connexion' })), /titre/);
  assert.match(await refus(page('https://portal.getalma.eu/login/marketing-optin', { ...bonne, inscription: 0 })), /à côté/);
  assert.match(await refus(page('https://portal.getalma.eu/login/marketing-optin', { ...bonne, nonMerci: 2 })), /un seul « Non merci »/);
  await assert.rejects(alma.faireLeGeste(page('https://portal.getalma.eu/login/marketing-optin', bonne), 'nonMerci', 'Je m\'inscris'),
    /ne prend aucune cible — rien n'a été cliqué/);
});

test('D2 — arrivée sur `/login/marketing-optin` (écran de chargement attendu) : UN clic « Non merci », jamais « Je m\'inscris », puis les quatre reçus', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ choixLettre: true, chargeurMs: 800 });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementLesGestesPermis(journal, etat);
  assert.equal(nonMerci(journal), 1, 'un seul « Non merci »');
  assert.deepEqual(etat.compteurs.choix, ['non'], 'la réponse « non », une fois');
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES);
  const texte = lignes.join('\n');
  assert.match(texte, /alma : arrivée jugée « choix-lettre » — page du choix de la lettre d'information/);
  assert.match(texte, /alma : « Non merci » cliqué sur la page du choix de la lettre d'information \(jamais « Je m'inscris »\)\./);
  assert.match(texte, /alma : après « Non merci », arrivée jugée « compte »/);
  assert.doesNotMatch(texte, /arrivée jugée « connexion »/);
  outils.journalSansDonnee(lignes);
});

test('D2 — la page du choix revient après « Non merci » : pas de second clic, la page est dite illisible', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ choixLettre: true, choixRevient: true });
  const { resultat, erreur, journal } = await passer(etat, { ouverture: { delaiApresChoixMs: 3_000 } });
  assert.equal(resultat, null);
  assert.ok(erreur);
  assert.notEqual(erreur.sessionExpired, true, 'ce n\'est pas une affaire de session');
  assert.match(erreur.precision, /la page du choix de la lettre d'information est (revenue|restée affichée) après « Non merci »/);
  assert.equal(nonMerci(journal), 1, 'un seul « Non merci » par passage');
  seulementLesGestesPermis(journal, etat);
});

test('D2 — l\'écran de chargement qui ne part pas : attendu jusqu\'à la borne, jamais retiré, et dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ choixLettre: true, chargeurMs: 60_000 });
  const { erreur, journal, lignes } = await passer(etat, { ouverture: { delaiDessinMs: 2_000 } });
  assert.ok(erreur);
  assert.match(lignes.join('\n'), /arrivée jugée « illisible » — l'écran de chargement du portail est resté affiché/);
  assert.deepEqual(journal.gestes, [], 'rien n\'est cliqué tant que l\'écran de chargement est là');
});

// ---------------------------------------------------------------------------
// R4 — la session dans le stockage du navigateur
// ---------------------------------------------------------------------------

test('R4 — la forme du stockage de session : bornée, par origine, retirée avant Playwright, jamais un nom ni une valeur au journal', () => {
  const base = { cookies: [{ name: 'a', value: 'b', domain: 'portal.getalma.eu', expires: -1 }], origins: [] };
  assert.equal(sessionState.sansStockageDeSession(base), base, 'un état sans stockage passe tel quel, à l\'identique');
  const avec = sessionState.avecStockageDeSession(base, [{ origine: 'https://portal.getalma.eu', entrees: [faux.STOCKAGE_ALMA] }]);
  assert.deepEqual(sessionState.stockageDeSession(avec, alma.ORIGINE_PORTAIL), [{ ...faux.STOCKAGE_ALMA }]);
  assert.deepEqual(sessionState.stockageDeSession(avec, 'https://autre.exemple.invalid'), []);
  assert.deepEqual(sessionState.sansStockageDeSession(avec), base);
  assert.equal(sessionState.nombreDeClesDeStockage(avec), 1);
  assert.equal(base.stockageDeSession, undefined, 'l\'état reçu n\'est pas modifié');
  assert.ok(sessionState.validate(JSON.stringify(avec)).ok, 'la connexion reste valide pour le socle');
  // Bornes et formes refusées.
  assert.equal(sessionState.origineHttps('http://portal.getalma.eu'), null);
  assert.equal(sessionState.origineHttps('https://portal.getalma.eu/compte'), null);
  assert.equal(sessionState.origineHttps('https://portal.getalma.eu/'), 'https://portal.getalma.eu');
  const beaucoup = Array.from({ length: 60 }, (_, i) => ({ name: `k${i}`, value: 'v' }));
  assert.equal(sessionState.entreesValides(beaucoup).length, sessionState.STOCKAGE_MAX_CLES);
  assert.deepEqual(sessionState.entreesValides([{ name: '', value: 'x' }, { name: 'a', value: 1 }, { name: 'b', value: 'x' }, { name: 'b', value: 'y' },
    { name: 'gros', value: 'x'.repeat(sessionState.STOCKAGE_MAX_CARACTERES) }]), [{ name: 'b', value: 'x' }]);
});

test('D2 — la session dans le stockage SEULEMENT : restaurée avant la première navigation, les quatre reçus pris, le stockage gardé en fin de passage', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ sessionDans: 'stockage' });
  const { resultat, erreur, journal, lignes } = await passer(etat, { session: faux.sessionAvecStockage() });
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementLesGestesPermis(journal, etat);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES);
  assert.equal(etat.compteurs.connexions, 0, 'jamais renvoyé vers la connexion');
  const texte = lignes.join('\n');
  assert.match(texte, /alma : stockage de session du portail — 1 clé\(s\) restaurée\(s\) avant la première navigation\./);
  assert.match(texte, /alma : stockage de session du portail — 1 clé\(s\) gardée\(s\) en fin de passage\./);
  assert.doesNotMatch(texte, /customer-portal-session|ZZjetonEssai|accessToken/, 'ni le nom ni la valeur de la clé');
  const renouvelee = JSON.parse(resultat.sessionRenouvelee);
  assert.deepEqual(sessionState.stockageDeSession(renouvelee, alma.ORIGINE_PORTAIL), [{ ...faux.STOCKAGE_ALMA }],
    'l\'état renouvelé porte encore la session du portail');
  outils.journalSansDonnee(lignes);
});

test('D2 — une connexion enregistrée SANS le stockage (celle du 12/10) : vraie page de connexion, « session expirée », aucun geste', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteAlma({ sessionDans: 'stockage' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(resultat, null);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.expirationCertaine, true);
  assert.equal(erreur.message, 'Votre session Alma a expiré : le portail demande de vous reconnecter. Reconnectez-vous depuis '
    + 'la fiche d\'Alma : la récupération repartira toute seule.');
  assert.doesNotMatch(erreur.message, /réessayez dans quelques heures/);
  assert.deepEqual(journal.gestes, []);
  assert.match(lignes.join('\n'), /aucune clé dans la connexion enregistrée .* le portail demandera de se reconnecter/);
  assert.match(lignes.join('\n'), /arrivée jugée « connexion » — renvoyé vers une page de connexion/);
});

// ---------------------------------------------------------------------------
// R4 — la capture dans la fenêtre (doubles de système, aucun navigateur)
// ---------------------------------------------------------------------------

function fauxSysteme() {
  const existants = new Set(['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify', '/usr/share/novnc/core/rfb.js']);
  const fsFaux = {
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => { if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`); },
    readdirSync: () => { throw new Error('ENOENT'); },
    readFileSync: () => { throw new Error('ENOENT'); },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => { existants.add(String(p)); return String(p); },
    rmSync: (p) => existants.delete(String(p)),
  };
  const spawn = (command, args) => {
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) existants.add(`/tmp/.X11-unix/X${display}`);
    }
    return { command, args: args.map(String), stdout: { resume: () => {} }, stderr: { resume: () => {} }, on: () => {}, kill: () => {} };
  };
  return { fsFaux, spawn };
}

/** La page de la fenêtre : son adresse, et son stockage de session (lu seulement par la fonction du socle). */
function pageFenetre(url, entrees) {
  const lectures = [];
  return {
    lectures,
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    isClosed: () => false,
    locator: () => ({ count: async () => 0, first: () => ({ count: async () => 0, focus: async () => {} }) }),
    getByText: () => ({ count: async () => 0 }),
    keyboard: { type: async () => {} },
    evaluate: async (fn) => {
      if (fn === sessionState.LIRE_STOCKAGE_DE_SESSION) {
        lectures.push('stockage');
        return { origine: new URL(url).origin, entrees };
      }
      return null;
    },
  };
}

async function capturer({ stockageDeSession, connectorId, connectorName }) {
  const journal = [];
  const { fsFaux, spawn } = fauxSysteme();
  const cookies = Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, value: 'x', domain: 'portal.getalma.eu', expires: -1 }));
  const etatNavigateur = { cookies, origins: [{ origin: 'https://portal.getalma.eu', localStorage: [{ name: 'l', value: 'v' }] }] };
  const page = pageFenetre('https://portal.getalma.eu/account/customer_account_ZZessaiCompte01', [{ ...faux.STOCKAGE_ALMA }]);
  const captures = [];
  const manager = remoteBrowser.createManager({
    fs: fsFaux,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn,
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-run',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message, id) => journal.push({ level, message, id }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    launchBrowser: async () => ({ page, storageState: async () => JSON.parse(JSON.stringify(etatNavigateur)), close: async () => {} }),
    timeoutMs: 5_000,
    pollMs: 4,
  });
  await manager.start({
    userId: 1,
    connectorId,
    connectorName,
    url: 'https://portal.getalma.eu/',
    marker: '',
    verifyUrl: '',
    ...(stockageDeSession ? { stockageDeSession } : {}),
    onDetected: async (etat) => {
      captures.push(etat);
      return { fieldKey: 'session', summary: { cookieCount: (etat.cookies || []).length } };
    },
  });
  let resultat = await manager.saveNow(1, connectorId);
  if (!resultat.ok) resultat = await manager.saveNow(1, connectorId);
  await manager.stop?.(1, connectorId);
  return { resultat, captures, journal, page, etatNavigateur };
}

test('R4 — la fenêtre d\'Alma capture le stockage de session avec les cookies ; le journal dit le NOMBRE de clés', async () => {
  const { resultat, captures, journal, page } = await capturer({
    stockageDeSession: ['https://portal.getalma.eu'], connectorId: 'alma', connectorName: 'Alma',
  });
  assert.equal(resultat.ok, true, resultat.error);
  assert.equal(captures.length, 1);
  assert.deepEqual(sessionState.stockageDeSession(captures[0], 'https://portal.getalma.eu'), [{ ...faux.STOCKAGE_ALMA }]);
  assert.equal(captures[0].cookies.length, 7, 'les cookies, inchangés');
  assert.deepEqual(captures[0].origins, [{ origin: 'https://portal.getalma.eu', localStorage: [{ name: 'l', value: 'v' }] }]);
  assert.ok(page.lectures.length >= 1);
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.match(ligne.message, /^Session Alma capturée par navigateur distant pour le compte 1 — 7 cookie\(s\), 1 clé\(s\) du stockage de session, /);
  assert.doesNotMatch(journal.map((l) => l.message).join('\n'), /customer-portal-session|ZZjetonEssai|accessToken/);
});

test('R4 — sans déclaration (tout autre service) : rien n\'est lu, l\'état capturé est celui de Playwright à l\'octet, la ligne ne change pas', async () => {
  const { resultat, captures, journal, page, etatNavigateur } = await capturer({ connectorId: 'exemple', connectorName: 'Exemple' });
  assert.equal(resultat.ok, true, resultat.error);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0], etatNavigateur, 'l\'état enregistré est exactement celui de Playwright');
  assert.equal(JSON.stringify(captures[0]), JSON.stringify(etatNavigateur));
  assert.deepEqual(page.lectures, [], 'le stockage de session n\'est jamais lu');
  const ligne = journal.find((l) => /capturée par navigateur distant/.test(l.message));
  assert.equal(ligne.message, 'Session Exemple capturée par navigateur distant pour le compte 1 — 7 cookie(s), '
    + 'enregistrée sur votre confirmation — aucun contrôle possible pour ce site.');
});

test('R4 — le manifeste : Alma déclare son origine ; le schéma refuse une liste vide, une adresse, un http ; aucun autre connecteur ne le déclare', () => {
  const manifeste = JSON.parse(fs.readFileSync(path.join(RACINE, 'server', 'connectors', 'available', ID, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifeste.remoteLogin.stockageDeSession, ['https://portal.getalma.eu']);
  assert.match(manifeste.remoteLogin.hint, /cliquez « Non merci »/);
  assert.deepEqual(schema.validate(manifeste).errors || [], []);
  for (const mauvais of [[], ['https://portal.getalma.eu/compte'], ['http://portal.getalma.eu'], 'https://portal.getalma.eu', [3]]) {
    const essai = { ...manifeste, remoteLogin: { ...manifeste.remoteLogin, stockageDeSession: mauvais } };
    assert.ok((schema.validate(essai).errors || []).some((e) => /stockageDeSession/.test(e)), JSON.stringify(mauvais));
  }
  const declarants = [];
  const dossier = path.join(RACINE, 'server', 'connectors', 'available');
  for (const id of fs.readdirSync(dossier)) {
    const chemin = path.join(dossier, id, 'manifest.json');
    if (fs.existsSync(chemin) && JSON.parse(fs.readFileSync(chemin, 'utf8')).remoteLogin?.stockageDeSession) declarants.push(id);
  }
  assert.deepEqual(declarants, ['alma']);
  // Le manifeste CHARGÉ (normalisé par une liste blanche) garde la clé — pour
  // Alma seul ; les autres restent sans elle (la première version du lot l'y
  // perdait : trouvé au chargement du registre, avant tout redémarrage).
  registry.load();
  assert.deepEqual(registry.manifest(ID).remoteLogin.stockageDeSession, ['https://portal.getalma.eu']);
  const chargesAvec = registry.listAll().filter((s) => !s.planned && registry.manifest(s.id).remoteLogin?.stockageDeSession).map((s) => s.id);
  assert.deepEqual(chargesAvec, ['alma']);
  assert.equal('stockageDeSession' in registry.manifest('battle-net').remoteLogin, false, 'aucune clé ajoutée aux autres');
  const route = fs.readFileSync(path.join(RACINE, 'server', 'routes', 'remote-login.js'), 'utf8');
  assert.match(route, /stockageDeSession: Array\.isArray\(remoteLogin\.stockageDeSession\) \? remoteLogin\.stockageDeSession : \[\]/);
});

// ---------------------------------------------------------------------------
// R5 — par le vrai planificateur : la cause et le message
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  let restaurerBnet;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    restaurerBnet = outils.interdireLeVraiNavigateur(registry, 'battle-net');
    destinations.restoreLocal();
  });
  test.after(() => {
    restaurerBnet();
    restaurer();
  });

  const derniere = (user, id) => db.get().prepare('SELECT message, cause FROM run_logs WHERE user_id = ? AND connector_id = ? ORDER BY id DESC LIMIT 1')
    .get(user.id, id);

  test('R5 — vraie page de connexion juste après l\'enregistrement : « session expirée » (orange), se reconnecter — jamais « réessayez dans quelques heures »', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot105almaexpire');
    const { r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteAlma({ connecte: false }), user });
    assert.equal(r.ok, false);
    const ligne = derniere(user, ID);
    assert.equal(ligne.cause, 'session-expiree');
    assert.match(ligne.message, /^Votre session a expiré \(connexion enregistrée le \d\d\/\d\d\)\. Reconnectez-vous depuis la fiche du service : la récupération repartira toute seule\.$/);
    assert.doesNotMatch(ligne.message, /réessayez dans quelques heures|a refusé la connexion/);
  });

  test('R5 — sans effet ailleurs : Battle.net, même situation, reste « connexion refusée » (la règle du lot 91)', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, 'battle-net', 'lot105bnetrefus');
    const { r } = await outils.parLePlanificateur({ registry, scheduler, id: 'battle-net', etat: faux.compteBnet({ connecte: false }), user });
    assert.equal(r.ok, false);
    const ligne = derniere(user, 'battle-net');
    assert.equal(ligne.cause, 'connexion-refusee');
    assert.match(ligne.message, /^Le site a refusé la connexion que vous venez d'enregistrer/);
  });

  test('D2 — par le planificateur, la session dans le stockage : quatre reçus rangés, puis le passage suivant repart de l\'état RENOUVELÉ (stockage compris)', faux.SANS_NAVIGATEUR, async () => {
    const user = await helpers.createUser({ username: 'lot105almastockage', role: 'admin' });
    registry.install(user.id, ID);
    registry.saveConfig(user.id, ID, { session: faux.sessionAvecStockage() }, { origine: 'fenetre' });
    let { r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteAlma({ sessionDans: 'stockage' }), user });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(outils.documents(db, user, ID).map((d) => d.remote_id).sort(), [...ANCRES].sort());
    const relue = registry.readConfig(user.id, ID);
    assert.equal(sessionState.nombreDeClesDeStockage(JSON.parse(relue.session)), 1, 'l\'état renouvelé garde la clé');
    ({ r } = await outils.parLePlanificateur({ registry, scheduler, id: ID, etat: faux.compteAlma({ sessionDans: 'stockage' }), user }));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /^Aucune nouvelle facture/);
    outils.journalApplicatifSansDonnee(db);
    const journalApp = db.get().prepare('SELECT message FROM app_logs').all().map((l) => l.message).join('\n');
    assert.doesNotMatch(journalApp, /customer-portal-session|ZZjetonEssai|accessToken|customer_account_ZZ/);
  });
});
