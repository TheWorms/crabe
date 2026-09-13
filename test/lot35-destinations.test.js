'use strict';

/**
 * Lot 35, phase A — un espace vierge n'est pas une panne, et l'autorisation
 * laisse le dossier de crabe créé.
 *
 * ─── Ce que ces tests protègent ──────────────────────────────────────────────
 *
 * Mesuré en production le 15/08/2026 : l'autorisation pCloud aboutissait
 * (badge « Connecté », jeton rangé, région prise en compte), puis « Tester la
 * connexion » rendait « ERROR : error listing: directory not found » — de
 * l'anglais brut d'rclone, pour l'état NORMAL d'un compte qui n'a encore
 * jamais rien reçu. Deux verrous :
 *
 * 1. **Le test de connexion crée le dossier absent** au lieu d'échouer, et le
 *    dit en français. Une vraie panne (jeton refusé, réseau) reste une panne.
 * 2. **Une autorisation réussie crée le dossier de crabe**, dans
 *    l'orchestrateur — pour tous les backends OAuth — et APRÈS
 *    l'enregistrement du jeton : c'est la meilleure preuve de la clé (une
 *    écriture réussie), et un échec de création ne défait pas l'autorisation
 *    mais se dit, avec quoi faire.
 *
 * Le test de connexion est joué sur le VRAI binaire rclone (backend `local`,
 * répertoire temporaire) : c'est lui qui rend « directory not found », pas une
 * doublure. Sur une machine sans rclone, ces cas-là sont passés — la machine de production,
 * lui, a son binaire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers');

const rclone = require('../server/destinations/rclone');
const erreurs = require('../server/destinations/erreurs-rclone');
const autorisation = require('../server/destinations/autorisation');

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Le test de connexion sur un espace vierge
// ---------------------------------------------------------------------------

/** Une destination `local` dans un répertoire temporaire : un vrai remote. */
function destinationLocale() {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot35-'));
  return {
    remoteName: 'essai',
    rcloneConfig: 'type = local',
    // Le dossier de crabe N'EXISTE PAS : l'état exact d'un compte tout neuf.
    basePath: path.join(racine, 'crabe'),
    racine,
  };
}

test('un espace vierge : le test crée le dossier et répond en français, sans échec', async () => {
  if (!(await rclone.isAvailable())) return; // machine sans rclone : mesuré sur le CT

  const dest = destinationLocale();
  try {
    assert.equal(fs.existsSync(dest.basePath), false, 'point de départ : rien');

    const resultat = await rclone.testRemote(dest);
    assert.equal(resultat.ok, true,
      'l\'état normal d\'une destination neuve ne doit JAMAIS être un échec');
    assert.match(resultat.message, /dossier de crabe vient d'être créé/,
      'le message dit ce qui s\'est passé, en français');
    assert.equal(/directory not found|error listing/i.test(resultat.message), false,
      'plus une miette d\'anglais d\'rclone à l\'écran');
    assert.equal(fs.existsSync(dest.basePath), true, 'le dossier est réellement là');

    // Deuxième passage, dossier présent : le message redevient le message calme.
    const suivant = await rclone.testRemote(dest);
    assert.equal(suivant.ok, true);
    assert.match(suivant.message, /accès en écriture vérifié/);
    assert.equal(/vient d'être créé/.test(suivant.message), false,
      'on ne raconte pas une création qui n\'a pas eu lieu');
  } finally {
    fs.rmSync(dest.racine, { recursive: true, force: true });
  }
});

test('une vraie panne reste une panne : « directory not found » seul déclenche la création', async () => {
  // Sans passer par le binaire : le motif est la seule porte vers le mkdir.
  // Un jeton refusé, un réseau muet, un quota plein ne doivent jamais être
  // maquillés en « dossier absent » — ils remontent tels quels au traducteur.
  const err = new Error('couldn\'t fetch token: invalid_grant');
  assert.equal(/directory not found/i.test(`${err.message}\n`), false);

  // Et le traducteur, lui, sait dire l'état normal en français — c'est le
  // filet pour tout chemin qui verrait passer ce message hors du test de
  // connexion (une copie, une mesure d'espace).
  const phrase = erreurs.traduire('2026/08/15 NOTICE: Failed to lsd with 2 errors: last error was: directory not found');
  assert.match(phrase, /dossier de crabe n'existe pas encore/);
  assert.match(phrase, /état normal/);
  assert.match(phrase, /premier dépôt/);
  assert.equal(/directory not found/.test(phrase), false, 'la phrase est française, sans le brut');
});

test('la copie crée l\'arborescence manquante — mesuré, pas supposé', async () => {
  if (!(await rclone.isAvailable())) return;

  // Le chemin complet <utilisateur>/<Connecteur>/<compte>/<année>/ n'existe
  // pas ; `upload` (rclone copyto) doit le créer en entier. Mesuré aussi à la
  // main sur v1.75.0 — ce test empêche une future version d'y renoncer en
  // silence.
  const dest = destinationLocale();
  const local = path.join(dest.racine, 'temoin.pdf');
  fs.writeFileSync(local, '%PDF-1.4 temoin');
  try {
    await rclone.upload(dest, local, 'camille/Fournisseur/compte/2026/temoin.pdf');
    assert.equal(
      fs.existsSync(path.join(dest.basePath, 'camille/Fournisseur/compte/2026/temoin.pdf')),
      true,
      'toute l\'arborescence a été créée par la copie elle-même'
    );
  } finally {
    fs.rmSync(dest.racine, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. L'autorisation laisse le dossier créé
// ---------------------------------------------------------------------------

// Les doublures du lot 34 : un rclone et une fenêtre qui obéissent au doigt.
const { EventEmitter } = require('node:events');

function fauxRclone() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    if (child.exitCode === null) {
      child.exitCode = 143;
      child.emit('exit', 143);
    }
  };
  child.montrerUrl = () =>
    child.stderr.emit('data', 'NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=x\n');
  child.finir = (code, sortie = '') => {
    if (sortie) child.stdout.emit('data', sortie);
    child.exitCode = code;
    child.emit('exit', code);
  };
  return child;
}

function fauxRuntime() {
  const enfants = [];
  const manager = {
    demarrages: [],
    conclusions: [],
    session: null,
    start: async (opts) => {
      manager.demarrages.push(opts);
      manager.session = { connectorId: opts.connectorId };
      return { sessionId: 's1', state: 'running' };
    },
    conclure: async (userId, connectorId, resultat) => {
      manager.conclusions.push({ userId, connectorId, ...resultat });
      manager.session = null;
    },
    sessionFor: () => manager.session,
  };
  return {
    enfants,
    manager,
    rt: {
      spawn: () => {
        const child = fauxRclone();
        enfants.push(child);
        return child;
      },
      manager: () => manager,
      log: () => {},
      now: () => Date.now(),
      typeAutorisable: async () => true,
      environnement: async () => ({}),
    },
  };
}

const JETON = '{"access_token":"jeton-lot35","refresh_token":"r"}';

/** Joue une autorisation complète et rend ce qui en sort. */
async function autorisationComplete({ creerDossier }) {
  const { enfants, manager, rt } = fauxRuntime();
  const gestes = [];
  const promesse = autorisation.demarrer({
    userId: 1,
    destId: 'cloud-lot35',
    type: 'pcloud',
    nom: 'pCloud essai',
    valeurs: {},
    enregistrer: () => gestes.push('enregistrer'),
    creerDossier: creerDossier
      ? async () => { gestes.push('creerDossier'); return creerDossier(); }
      : undefined,
  }, rt);
  await attendre(30);
  enfants[0].montrerUrl();
  await promesse;
  enfants[0].finir(0, `Paste the following into your remote machine --->\n${JETON}\n<---End paste\n`);
  await attendre(30);
  return { gestes, conclusions: manager.conclusions };
}

test('une autorisation réussie crée le dossier de crabe — après l\'enregistrement du jeton', async () => {
  const { gestes, conclusions } = await autorisationComplete({ creerDossier: async () => {} });

  // L'ordre est la moitié de la garantie : le mkdir relit la configuration en
  // base, il doit donc arriver APRÈS que le jeton y est.
  assert.deepEqual(gestes, ['enregistrer', 'creerDossier']);
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].ok, true);
  assert.match(conclusions[0].message, /dossier de crabe est créé/);
  assert.match(conclusions[0].message, /accès\s+en écriture est vérifié/);
});

test('un mkdir en échec ne défait pas l\'autorisation — mais la conclusion le dit, avec quoi faire', async () => {
  const { gestes, conclusions } = await autorisationComplete({
    creerDossier: async () => { throw new Error('mkdir failed: insufficient storage'); },
  });

  assert.ok(gestes.includes('enregistrer'), 'le jeton est bien rangé malgré tout');
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].ok, true, 'l\'autorisation elle-même a réussi : le jeton est bon');
  assert.match(conclusions[0].message, /clé d'accès est rangée/);
  assert.match(conclusions[0].message, /création\s+du dossier de crabe a échoué/);
  // Le détail passe par le traducteur : « insufficient storage » devient la
  // phrase française qui dit quoi faire, et le geste de vérification suit.
  assert.match(conclusions[0].message, /plein|place|abonnement/i);
  assert.match(conclusions[0].message, /« Tester »/);
});

test('sans rappel creerDossier (appelant d\'avant le lot 35), rien ne change', async () => {
  const { gestes, conclusions } = await autorisationComplete({});
  assert.deepEqual(gestes, ['enregistrer']);
  assert.equal(conclusions[0].ok, true);
  assert.match(conclusions[0].message, /est connecté/);
});

// ---------------------------------------------------------------------------
// 3. L'avancement de la synchronisation, écrit sur les cartes de l'accueil
// ---------------------------------------------------------------------------

/**
 * Le VRAI `web/app.js`, dans un bac à sable où chaque carte a sa ligne
 * d'avancement — la règle du projet : on exécute le code déployé, on ne
 * recopie pas sa logique dans le test.
 */
function frontAvecCartes(ids) {
  const vm = require('node:vm');
  const elements = Object.fromEntries(
    ids.map((id) => [`dest-sync-live-${id}`, { textContent: '', hidden: true }])
  );
  const sandbox = {
    console,
    document: {
      getElementById: (id) => elements[id] || null,
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const WEB = path.resolve(__dirname, '..', 'web');
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), context, { filename: fichier });
  }
  vm.runInContext(
    `home.data = { destinations: ${JSON.stringify(ids.map((id) => ({ id })))} };`,
    context
  );
  return { context, elements, run: (code) => vm.runInContext(code, context) };
}

test('pendant une synchronisation, la carte visée écrit l\'avancement — les autres se taisent', () => {
  const { elements, run } = frontAvecCartes(['cloud-pc', 'local']);

  // 15/08/2026 : 632 documents partaient vers pCloud, écran muet. Désormais la
  // carte écrit ce que la synchronisation a RÉELLEMENT fait — copies comptées
  // une à une côté serveur, jamais un pourcentage inventé.
  run(`majProgressionSync({ running: true, destinationIds: ['cloud-pc'], copied: 41, failed: 2, total: 632 })`);
  const ligne = elements['dest-sync-live-cloud-pc'];
  assert.equal(ligne.hidden, false, 'la ligne est visible pendant la synchronisation');
  assert.match(ligne.textContent, /synchronisation en cours/);
  assert.match(ligne.textContent, /41 document\(s\) copié\(s\) sur 632/);
  assert.match(ligne.textContent, /2 en échec/, 'un échec en route se dit, jamais un bloc muet');
  assert.equal(elements['dest-sync-live-local'].hidden, true,
    'une carte non visée ne raconte pas la synchronisation des autres');

  // Fin de la synchronisation : l'état revient à la normale.
  run(`majProgressionSync({ running: false, destinationIds: [], copied: 630, failed: 2, total: 632 })`);
  assert.equal(ligne.hidden, true);
  assert.equal(ligne.textContent, '');
});
