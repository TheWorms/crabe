'use strict';

/**
 * Harmonisation des noms des documents déjà déposés — depuis l'écran, service
 * actif (lot 56).
 *
 * ─── D'où ça vient ───────────────────────────────────────────────────────────
 *
 * Le lot 55 a écrit et prouvé un script manuel (`scripts/harmoniser-noms-
 * deposes.js`) qui exigeait le service ARRÊTÉ. Le lot 56 hisse ce travail dans
 * l'application : l'utilisateur choisit sa convention de nommage (Profil →
 * Fichiers) et lance lui-même le renommage de l'existant, pendant que crabe
 * continue de fonctionner. Les règles de dérivation sont les mêmes
 * (`convention-noms.js`) ; ce module reprend l'ordre des opérations prouvé au
 * lot 55 et le complète de ce qu'un service vivant exige.
 *
 * ─── L'ordre des opérations, et pourquoi (hérité du lot 55) ──────────────────
 *
 * Pour CHAQUE ligne : le stockage d'abord (le stockage local, puis chaque cloud), la
 * base ensuite, en une transaction. L'écriture en base est ATOMIQUE et vient
 * en DERNIER — elle sert de marqueur « cette ligne est finie ». Une
 * interruption laisse au pire une ligne dont les fichiers sont renommés et pas
 * la base ; à la relance, l'état des fichiers le dit (« déjà fait ») et la
 * base se termine.
 *
 * ─── Ce que « service actif » change, et comment c'est traité ────────────────
 *
 *   - **Une seule à la fois** : le verrou vient d'`inflight.createLock` — le
 *     mécanisme déjà utilisé pour les recherches et les profils, jamais un
 *     second système. Le refus dit quoi attendre.
 *   - **Une récupération peut survenir PENDANT le chantier.** Elle ne touche
 *     pas les fichiers existants (elle dépose des noms neufs, déjà à la
 *     convention du compte — le socle les normalise), mais elle peut écrire la
 *     ligne d'une facture. Chaque ligne du plan est donc relue à l'instant de
 *     son traitement : déjà au nom cible → « déjà fait » ; changée en autre
 *     chose → ÉCARTÉE (journalisée, comptée, re-mesurée au prochain
 *     lancement) — jamais renommée sur la foi d'un plan qui ne la décrit plus.
 *   - **La synchronisation forcée est incompatible** : elle copie des fichiers
 *     sous leur nom en base pendant qu'on les renomme. Chacune refuse de
 *     démarrer tant que l'autre tourne.
 *   - **La sauvegarde de la base est faite par l'application** (l'API de copie
 *     de SQLite, cohérente même pendant des écritures), vérifiée en la
 *     rouvrant, AVANT le premier mouvement.
 *
 * En revanche, un état du STOCKAGE qui ne correspond pas au plan (nom cible
 * déjà occupé, fichier introuvable sous l'un comme l'autre nom) reste un
 * ARRÊT IMMÉDIAT : rien n'est écrasé, jamais, et le message dit où on en est
 * et comment reprendre. La reprise est le même geste que le lancement : le
 * plan se recalcule, les lignes finies en sortent d'elles-mêmes, un mouvement
 * déjà fait est reconnu (ancien absent + nouveau présent).
 *
 * ─── Annulation ──────────────────────────────────────────────────────────────
 *
 * Chaque mouvement et chaque écriture en base laissent une ligne dans le
 * journal persistant. L'annulation le rejoue À L'ENVERS, avec les mêmes
 * garde-fous, et remet les documents dans l'état d'avant la première
 * harmonisation enregistrée ; une annulation menée au bout archive le journal
 * (le chantier suivant repart à neuf).
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db/db');
const applog = require('./applog');
const notifications = require('./notifications');
const { config } = require('./config');
const { createLock } = require('./connectors/inflight');
const { deriverNomCible, CONVENTION_PAR_DEFAUT } = require('./convention-noms');

/**
 * Le sursis du verrou : douze heures. Un chantier de ~1000 mouvements sur
 * trois destinations peut durer longtemps ; `run()` rend le verrou dans son
 * `finally` quoi qu'il arrive — le sursis ne couvre que la promesse qui ne se
 * règle jamais (un rclone figé), et reprendre trop tôt ferait deux chantiers.
 */
const VERROU_MS = 12 * 60 * 60 * 1000;
const verrou = createLock({ timeoutMs: VERROU_MS });
const CLE = 'harmonisation-noms';

/** Le journal persistant — jamais dans /tmp, il survit au service. */
const JOURNAL = () => path.join(config.dataDir, 'harmonisation-noms-journal.jsonl');

/** Délai maximal d'une opération rclone sur un dossier (comme au lot 55). */
const RCLONE_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// État visible
// ---------------------------------------------------------------------------

/**
 * L'état du chantier en cours, ou du dernier terminé — un objet en mémoire,
 * comme `destinations/sync.js` : crabe est un unique processus Node, et un
 * redémarrage se mesure au JOURNAL, pas à cet objet.
 */
let etat = repos();

function repos() {
  return {
    running: false,
    phase: null, // 'verifications' | 'renommage' | 'annulation'
    // Qui a lancé le chantier, et quelle phase vient de finir : le bandeau des
    // opérations (lot 59) ne montre un chantier qu'à son propriétaire, et doit
    // encore savoir nommer « renommage » ou « annulation » une fois `phase`
    // rendue nulle par le `finally`.
    userId: null,
    phaseFinie: null,
    convention: null,
    demarreLe: null,
    termineLe: null,
    total: 0,
    faites: 0,
    deja: 0,
    ecartees: 0,
    ligneEnCours: null,
    message: '',
    refus: null,
    arret: null,
  };
}

/** Instantané de l'état, sans référence partagée. */
function progress() {
  return { ...etat, ...bilanJournal() };
}

function isRunning() {
  return etat.running;
}

/**
 * Ce que le journal sait, indépendamment de la mémoire : un chantier commencé
 * sans ligne de fin est un chantier interrompu (coupure, redémarrage du
 * service) — l'écran doit le dire et proposer de reprendre ou d'annuler.
 */
function bilanJournal() {
  let entrees = [];
  try {
    entrees = fs.readFileSync(JOURNAL(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { journal: { gestes: 0, lignesFinies: 0, interrompu: false, annulable: false } };
  }
  const gestes = entrees.filter((e) => (e.type === 'mouvement' && !e.deja) || e.type === 'base').length;
  const lignesFinies = entrees.filter((e) => e.type === 'base').length;
  const derniere = entrees.at(-1);
  const interrompu = !etat.running && !!derniere
    && !['fin', 'refus', 'annulation-fin'].includes(derniere.type);
  return {
    journal: {
      gestes,
      lignesFinies,
      // `arret` est volontaire (écart mesuré) mais laisse bien un chantier à
      // reprendre : il compte comme interrompu aux yeux de l'écran.
      interrompu,
      annulable: gestes > 0,
    },
  };
}

let journalFd = null;
function journaliser(entree) {
  if (journalFd === null) journalFd = fs.openSync(JOURNAL(), 'a');
  fs.writeSync(journalFd, `${JSON.stringify({ quand: new Date().toISOString(), ...entree })}\n`);
  fs.fsyncSync(journalFd);
}

function fermerJournal() {
  if (journalFd !== null) {
    try { fs.closeSync(journalFd); } catch { /* déjà fermé */ }
    journalFd = null;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function dossierDe(chemin) {
  return chemin.slice(0, chemin.lastIndexOf('/'));
}

/**
 * Les compteurs d'une convention sur les documents d'un compte — les chiffres
 * que l'écran affiche. MESURÉS sur les lignes, jamais estimés.
 */
function mesurerConvention(userId, convention) {
  const lignes = db.get()
    .prepare('SELECT connector_id, filename FROM invoices WHERE user_id = ?')
    .all(userId);
  const compte = { total: lignes.length, conformes: 0, aRenommer: 0, exclus: 0, douteux: 0 };
  for (const l of lignes) {
    const v = deriverNomCible(l.connector_id, l.filename, convention);
    if (v.action === 'conforme') compte.conformes++;
    else if (v.action === 'renommer') compte.aRenommer++;
    else if (v.action === 'exclu') compte.exclus++;
    else compte.douteux++;
  }
  return compte;
}

/**
 * Le plan complet d'un compte vers une convention : une entrée par ligne à
 * renommer, avec un mouvement par destination revendiquée ; les cas douteux et
 * les collisions à part — ils ne s'exécutent JAMAIS.
 *
 * Recalculé à CHAQUE lancement, depuis la base : jamais rejoué depuis un
 * fichier périmé.
 */
function construirePlan(userId, convention) {
  const destinations = require('./destinations');
  const actives = destinations.activeDestinations();
  const lignes = db.get()
    .prepare('SELECT id, connector_id, filename, destinations FROM invoices WHERE user_id = ? ORDER BY id')
    .all(userId);

  const entrees = [];
  const douteux = [];
  const finaux = new Map(); // `<dest>|<dossier>` -> Map(nom final -> [ids])

  for (const l of lignes) {
    const verdict = deriverNomCible(l.connector_id, l.filename, convention);
    let dests = {};
    try { dests = JSON.parse(l.destinations || '{}') || {}; } catch { dests = {}; }

    const revendiques = [];
    for (const cle of actives) {
      const d = dests[cle];
      if (!d || !d.ok || !d.path) continue;
      const nomPorte = d.path.slice(d.path.lastIndexOf('/') + 1);
      if (nomPorte !== l.filename) {
        douteux.push({
          id: l.id,
          filename: l.filename,
          motif: `le chemin enregistré sur « ${cle} » porte un autre nom que la base — état incohérent, à examiner avant tout renommage`,
        });
      }
      revendiques.push({ dest: cle, chemin: d.path });
    }

    if (verdict.action === 'douteux') {
      douteux.push({ id: l.id, filename: l.filename, motif: verdict.motif });
    }
    if (verdict.action === 'renommer') {
      entrees.push({
        id: l.id,
        connecteur: l.connector_id,
        nom: l.filename,
        cible: verdict.cible,
        mouvements: revendiques.map((r) => ({
          dest: r.dest,
          de: r.chemin,
          vers: `${dossierDe(r.chemin)}/${verdict.cible}`,
        })),
      });
    }

    const nomFinal = verdict.action === 'renommer' ? verdict.cible : l.filename;
    for (const r of revendiques) {
      const cleDossier = `${r.dest}|${dossierDe(r.chemin)}`;
      if (!finaux.has(cleDossier)) finaux.set(cleDossier, new Map());
      const m = finaux.get(cleDossier);
      if (!m.has(nomFinal)) m.set(nomFinal, []);
      m.get(nomFinal).push(l.id);
    }
  }

  const collisions = [];
  for (const [ou, m] of finaux) {
    for (const [nom, ids] of m) {
      if (ids.length > 1) collisions.push({ ou, nom, ids });
    }
  }

  return { entrees, douteux, collisions };
}

// ---------------------------------------------------------------------------
// Destinations : configuration normalisée + joignabilité
// ---------------------------------------------------------------------------

/**
 * Les destinations actives, sous la forme que les mouvements attendent :
 * le stockage local (sa racine) et chaque cloud, dont la configuration est RELUE À
 * CHAQUE commande (`dest()` est une fonction, plus un objet — lot 58) : une
 * session rétablie par une reconnexion, ou un jeton tourné par rclone, doivent
 * jouer dès la commande suivante — l'objet figé du lot 56 aurait rejoué le
 * bloc du départ jusqu'à la fin du chantier.
 *
 * Le chantier entier partage un BUDGET de reconnexions (plafond justifié dans
 * `destinations/index.js`), et chaque tentative se journalise ici : dans
 * app_logs (source `harmonisation`, l'écran Logs) ET dans le journal
 * persistant du chantier.
 */
function chargerDestinations({ userId = null, username = null } = {}) {
  const destinations = require('./destinations');
  const actives = destinations.activeDestinations();
  const racineLocale = actives.includes('local')
    ? destinations.readConfig('local')?.path || null
    : null;

  const catalogue = require('./destinations/catalogue');
  const budget = destinations.budgetReconnexions();
  const clouds = [];
  for (const id of actives) {
    if (id === 'local') continue;
    const surEvenement = (type, message) => {
      const niveau = type === 'tentee' || type === 'reussie' ? 'info' : 'error';
      applog[niveau]('harmonisation', message, { userId, username });
      try {
        journaliser({ type: 'reconnexion', issue: type, dest: id, motif: message });
      } catch { /* le journal du chantier peut être fermé (préalables) — app_logs a la ligne */ }
    };
    clouds.push({
      destId: id,
      nom: catalogue.brand(id).name || id,
      dest: () => {
        const driver = destinations.driverFor(id);
        const conf = destinations.readConfig(id);
        const normalise = driver?.normalizeConf ? driver.normalizeConf(conf) : conf;
        return {
          remoteName: normalise?.remoteName || 'crabe',
          basePath: normalise?.basePath || 'crabe',
          rcloneConfig: normalise?.rcloneConfig,
          onSecretsRafraichis: normalise?.onSecretsRafraichis,
          // Une session refusée pendant le chantier est marquée morte (lot 57)…
          onSessionRefusee: normalise?.onSessionRefusee,
          // …puis la reconnexion se tente DANS le geste (lot 58) : le budget du
          // chantier borne les tentatives, le journal dit chacune d'elles.
          reconnexion: (texteEchec) => destinations.preparerReconnexion(id, texteEchec, {
            budget,
            surEvenement,
          }),
          refusAvantService: normalise?.refusAvantService,
        };
      },
    });
  }
  return { actives, racineLocale, clouds };
}

// ---------------------------------------------------------------------------
// Sauvegarde de la base, par l'application
// ---------------------------------------------------------------------------

/**
 * Copie la base par l'API de sauvegarde de SQLite (cohérente même pendant des
 * écritures), puis VÉRIFIE la copie en la rouvrant : mêmes lignes, même
 * `max_id` que la base vivante. Si des documents arrivent exactement pendant
 * la copie, on la refait une fois ; si ça bouge encore, on refuse — une
 * sauvegarde qu'on ne peut pas vérifier n'est pas une sauvegarde.
 *
 * @returns {Promise<string>} le chemin de la sauvegarde vérifiée
 */
async function sauvegarderBase() {
  const Database = require('better-sqlite3');
  const horodatage = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const chemin = path.join(config.dataDir, `crabe.db.avant-harmonisation-${horodatage}`);

  for (let essai = 0; essai < 2; essai++) {
    const avant = db.get().prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
    await db.get().backup(chemin);
    const copie = new Database(chemin, { readonly: true, fileMustExist: true });
    const sauve = copie.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
    copie.close();
    const apres = db.get().prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
    if (sauve.c === avant.c && sauve.m === avant.m && sauve.c === apres.c && sauve.m === apres.m) {
      // La cause amont de l'accumulation (lot 60) : à chaque sauvegarde neuve,
      // seules les dernières du même motif sont gardées. Meilleur effort — une
      // limite qui échoue ne doit pas priver le chantier de sa sauvegarde.
      try {
        require('./optimisation').limiterSauvegardes('harmonisation');
      } catch { /* la sauvegarde neuve est là, c'est elle qui compte */ }
      return chemin;
    }
  }
  fs.rmSync(chemin, { force: true });
  throw new Error(
    'La sauvegarde de la base n\'a pas pu être vérifiée : des documents sont en train '
    + 'd\'arriver. Attendez la fin des récupérations en cours et relancez.'
  );
}

// ---------------------------------------------------------------------------
// Mouvements (repris du lot 55, prouvés là-bas)
// ---------------------------------------------------------------------------

/** Cache des dossiers cloud déjà lus — une lecture par dossier et par chantier. */
let cacheDossiers = new Map();

/**
 * Une commande rclone sur un cloud du chantier, avec la configuration RELUE à
 * l'instant même (lot 58). Une erreur du chemin de session — reconnexion
 * impossible sans la clé, plafond de reconnexions atteint — arrive déjà en
 * français et décrit un chantier À REPRENDRE : elle devient un arrêt immédiat,
 * qui porte la phrase telle quelle et laisse le journal dire où on en est.
 */
async function commandeCloud(cloud, fn) {
  const rclone = require('./destinations/rclone');
  try {
    return await rclone.withConfig(cloud.dest(), fn);
  } catch (err) {
    if (err.dejaTraduite) throw arret(err.message);
    throw err;
  }
}

async function listerDossierCloud(cloud, dossier, { fraiche = false } = {}) {
  const rclone = require('./destinations/rclone');
  const cle = `${cloud.destId}|${dossier}`;
  if (!fraiche && cacheDossiers.has(cle)) return cacheDossiers.get(cle);
  try {
    const { stdout } = await commandeCloud(cloud, (confFile) =>
      rclone.run(['lsf', '--files-only', dossier], { confFile, timeout: RCLONE_TIMEOUT_MS })
    );
    const noms = new Set(stdout.split('\n').filter(Boolean));
    cacheDossiers.set(cle, noms);
    return noms;
  } catch (err) {
    if (/directory not found/i.test(String(err.message))) {
      const vide = new Set();
      cacheDossiers.set(cle, vide);
      return vide;
    }
    throw err;
  }
}

/** L'arrêt immédiat : une erreur qui porte l'état, où on en est, comment reprendre. */
function arret(message) {
  const err = new Error(message);
  err.arretImmediat = true;
  return err;
}

/**
 * Un mouvement, avec ses trois vérifications : avant (l'ancien présent, la
 * cible absente), pendant (le geste), après (relecture). Rend `fait`, `deja`,
 * ou lève un arrêt immédiat. RIEN n'est jamais écrasé.
 */
async function executerMouvement(mouvement, destinationsChargees, { annulation = false } = {}) {
  const rclone = require('./destinations/rclone');
  const de = annulation ? mouvement.vers : mouvement.de;
  const vers = annulation ? mouvement.de : mouvement.vers;
  const contexte = `document ${mouvement.id}, destination ${mouvement.dest} (${de} → ${vers})`;

  if (mouvement.dest === 'local') {
    const deLa = fs.existsSync(de);
    const versLa = fs.existsSync(vers);
    if (!deLa && versLa) return 'deja';
    if (!deLa && !versLa) throw arret(`fichier introuvable sous l'un comme l'autre nom — ${contexte}`);
    if (deLa && versLa) throw arret(`le nom cible est déjà occupé — rien n'est écrasé, jamais — ${contexte}`);
    fs.renameSync(de, vers);
    if (!fs.existsSync(vers) || fs.existsSync(de)) {
      throw arret(`le renommage ne se relit pas comme attendu — ${contexte}`);
    }
    return 'fait';
  }

  const cloud = destinationsChargees.clouds.find((c) => c.destId === mouvement.dest);
  if (!cloud) throw arret(`destination inconnue « ${mouvement.dest} » — ${contexte}`);
  const dossier = dossierDe(de);
  const noms = await listerDossierCloud(cloud, dossier);
  const nomDe = de.slice(de.lastIndexOf('/') + 1);
  const nomVers = vers.slice(vers.lastIndexOf('/') + 1);
  const deLa = noms.has(nomDe);
  const versLa = noms.has(nomVers);
  if (!deLa && versLa) return 'deja';
  if (!deLa && !versLa) throw arret(`fichier introuvable sous l'un comme l'autre nom — ${contexte}`);
  if (deLa && versLa) throw arret(`le nom cible est déjà occupé — rien n'est écrasé, jamais — ${contexte}`);

  await commandeCloud(cloud, (confFile) =>
    rclone.run(['moveto', de, vers], { confFile, timeout: RCLONE_TIMEOUT_MS })
  );
  // ─── La vérification est patiente, l'écart arrête toujours net (lot 57) ────
  //
  // Mesuré le 25/08/2026 sur pCloud, document 582 : le mouvement FAIT, la
  // relecture immédiate du dossier ne le montrait pas encore — un listing en
  // retard, pas un écart — et le chantier s'est arrêté à tort. On relit donc
  // jusqu'à trois fois, avec un court délai entre deux : un listing en retard
  // se rattrape à la deuxième lecture, un VRAI écart reste un écart aux trois
  // et arrête net, comme avant.
  let relu;
  for (let lecture = 1; ; lecture++) {
    relu = await listerDossierCloud(cloud, dossier, { fraiche: true });
    if (relu.has(nomVers) && !relu.has(nomDe)) return 'fait';
    if (lecture >= RELECTURES_APRES_MOUVEMENT) break;
    await new Promise((r) => setTimeout(r, delaiRelectureMs()));
  }
  throw arret(`après le mouvement, la relecture du dossier ne montre pas l'état attendu — ${contexte}`);
}

/** Relectures du dossier après un mouvement, avant de conclure à un écart. */
const RELECTURES_APRES_MOUVEMENT = 3;

/** Attente entre deux relectures. Réduite à zéro par les tests. */
function delaiRelectureMs() {
  const demande = Number.parseInt(process.env.CRABE_HARMONISATION_RELECTURE_DELAI_MS || '', 10);
  return Number.isFinite(demande) && demande >= 0 ? demande : 2000;
}

// ---------------------------------------------------------------------------
// Préalables — chacun avec sa phrase de refus
// ---------------------------------------------------------------------------

/**
 * Vérifie tout ce qui doit l'être AVANT le premier mouvement. Lève avec une
 * phrase lisible si un préalable manque — le chantier ne démarre pas à moitié.
 */
async function verifierPrealables(plan, destinationsChargees) {
  const destinations = require('./destinations');

  if (plan.douteux.length || plan.collisions.length) {
    const morceaux = [];
    if (plan.douteux.length) morceaux.push(`${plan.douteux.length} document(s) dont le nom ne se laisse pas dériver`);
    if (plan.collisions.length) morceaux.push(`${plan.collisions.length} collision(s) de noms`);
    throw new Error(
      `Le renommage ne démarre pas : ${morceaux.join(' et ')}. `
      + 'Ces cas ne sont jamais tranchés automatiquement — la liste est affichée sur cette page.'
    );
  }

  if (!destinationsChargees.racineLocale) {
    throw new Error('L\'espace de stockage de crabe n\'est pas actif : rien ne peut être renommé sans lui.');
  }
  if (!fs.existsSync(destinationsChargees.racineLocale)
      || !fs.readdirSync(destinationsChargees.racineLocale).length) {
    throw new Error(
      'L\'espace de stockage de crabe est vide ou inaccessible — son montage est '
      + 'à vérifier avant tout renommage.'
    );
  }

  // Chaque cloud actif doit répondre MAINTENANT : un chantier à moitié fait
  // sur l'une des destinations est exactement ce qu'on refuse. Le contrôle est
  // celui du bouton « Tester » — même sonde, mêmes phrases d'erreur.
  for (const cloud of destinationsChargees.clouds) {
    const resultat = await destinations.test(cloud.destId);
    if (!resultat.ok) {
      throw new Error(
        `« ${cloud.nom} » ne répond pas : ${resultat.message} `
        + 'Toutes les destinations doivent répondre avant de commencer — corrigez-la, ou désactivez-la, puis relancez.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Le chantier
// ---------------------------------------------------------------------------

/**
 * Lance l'harmonisation (ou la REPREND : c'est le même geste — le plan se
 * recalcule, les lignes finies en sortent d'elles-mêmes).
 *
 * L'appel rend la main tout de suite, comme la synchronisation forcée : les
 * vérifications elles-mêmes sondent les clouds et peuvent prendre du temps.
 * L'écran suit `progress()` ; un refus de préalable s'y lit en toutes lettres.
 *
 * @param {{userId: number, username?: string}} demandeur
 * @returns {object} l'instantané de départ
 * @throws {Error} 409 si un chantier est déjà en cours, ou si une
 *   synchronisation forcée tourne
 */
function demarrer({ userId, username = null }) {
  const destinationSync = require('./destinations/sync');
  if (destinationSync.isRunning()) {
    const err = new Error(
      'Une synchronisation des destinations est en cours — elle copie des fichiers sous '
      + 'leur nom actuel. Attendez qu\'elle se termine avant de renommer.'
    );
    err.statusCode = 409;
    throw err;
  }

  const preferences = require('./preferences');
  const convention = preferences.get(userId, 'fichiers.convention') || CONVENTION_PAR_DEFAUT;

  return lancerSousVerrou({
    userId,
    username,
    label: 'renommage des documents',
    phase: 'renommage',
    convention,
    tache: () => executerChantier(userId, username, convention),
  });
}

/**
 * Lance l'ANNULATION : le journal rejoué à l'envers, avec les mêmes
 * garde-fous. Remet les documents dans l'état d'avant la première
 * harmonisation enregistrée au journal.
 */
function annuler({ userId, username = null }) {
  const destinationSync = require('./destinations/sync');
  if (destinationSync.isRunning()) {
    const err = new Error(
      'Une synchronisation des destinations est en cours — attendez qu\'elle se termine avant d\'annuler.'
    );
    err.statusCode = 409;
    throw err;
  }
  const { journal } = bilanJournal();
  if (!journal.annulable) {
    const err = new Error('Aucun renommage au journal : il n\'y a rien à annuler.');
    err.statusCode = 400;
    throw err;
  }

  return lancerSousVerrou({
    userId,
    username,
    label: 'annulation du renommage',
    phase: 'annulation',
    convention: null,
    tache: () => executerAnnulation(userId, username),
  });
}

/** Le tronc commun : verrou, état, tâche détachée, refus lisibles. */
function lancerSousVerrou({ userId, username, label, phase, convention, tache }) {
  // `acquire` lève un 409 « déjà en cours » si le verrou est pris — par cette
  // page dans un autre onglet, ou par quelqu'un d'autre sur l'installation.
  verrou.acquire(
    CLE,
    label,
    'Un renommage des documents est déjà en cours — attendez qu\'il se termine. '
    + 'Sa progression s\'affiche sur cette page.'
  );

  etat = {
    ...repos(),
    running: true,
    phase,
    userId,
    convention,
    demarreLe: new Date().toISOString(),
    message: 'Vérifications avant de commencer…',
  };
  cacheDossiers = new Map();

  // Détaché : la requête HTTP ne l'attend pas. AUCUN chemin ne sort d'ici
  // sans rendre le verrou.
  (async () => {
    try {
      await tache();
    } catch (err) {
      // Refus de préalable ou arrêt immédiat : la phrase est déjà écrite pour
      // l'utilisateur ; elle se lit sur l'écran, et reste au journal.
      if (err.arretImmediat) {
        etat.arret = `${err.message} Rien d'autre n'a été touché. Corrigez la cause puis relancez : `
          + 'le chantier reconnaît ce qui est déjà fait et reprend où il en était.';
        applog.error('harmonisation', `Renommage arrêté net : ${err.message}`, { userId, username });
      } else {
        etat.refus = err.message;
        applog.warn('harmonisation', `Renommage refusé : ${err.message}`, { userId, username });
      }
      // Meilleur effort : si c'est le disque de données lui-même qui refuse
      // d'écrire, le refus doit quand même se lire à l'écran — l'état en
      // mémoire suffit, le journal n'a encore enregistré aucun geste.
      try {
        journaliser({ type: err.arretImmediat ? 'arret' : 'refus', motif: err.message });
      } catch { /* l'état en mémoire porte déjà le message */ }
      etat.message = etat.arret || etat.refus;
    } finally {
      etat.running = false;
      etat.phaseFinie = etat.phase;
      etat.phase = null;
      etat.ligneEnCours = null;
      etat.termineLe = new Date().toISOString();
      fermerJournal();
      verrou.release(CLE);

      // ─── Prévenir que le chantier est fini (lot 66) ──────────────────────
      //
      // Ici, et pas dans `executerChantier` : c'est le seul endroit par lequel
      // passent LES DEUX issues — le renommage qui va au bout, et celui qui
      // s'arrête net ou se voit refuser. Un renommage mesuré a duré 3 h 13
      // pour 330 documents : personne n'attend devant l'écran, et c'est
      // précisément ce qui rend ce message utile.
      //
      // Jamais bloquant : une notification qui échoue ne doit pas être ce qui
      // reste d'un chantier qui, lui, s'est bien terminé.
      const dureeMs = Date.parse(etat.termineLe) - Date.parse(etat.demarreLe);
      notifications
        .signalerChantier(
          { id: userId, username },
          {
            chantier: etat.phaseFinie === 'annulation'
              ? 'Annulation du renommage des documents'
              : 'Renommage des documents',
            resume: etat.message || 'Terminé.',
            dureeMs,
            echec: !!(etat.arret || etat.refus),
          }
        )
        .catch(() => {});
    }
  })();

  return progress();
}

/** Le chantier lui-même — préalables, puis ligne à ligne. */
async function executerChantier(userId, username, convention) {
  const plan = construirePlan(userId, convention);
  const destinationsChargees = chargerDestinations({ userId, username });

  await verifierPrealables(plan, destinationsChargees);

  if (!plan.entrees.length) {
    etat.message = 'Rien à renommer : tous les documents portent déjà la convention choisie.';
    journaliser({ type: 'debut', mode: 'renommage', convention, lignes: 0 });
    journaliser({ type: 'fin', faites: 0, deja: 0, ecartees: 0 });
    applog.info('harmonisation', 'Renommage lancé : rien à faire, tout était déjà en place.', { userId, username });
    return;
  }

  // Une REPRISE se dit comme telle (lot 58) : le journal porte des lignes déjà
  // finies, le plan recalculé ne les compte plus — l'écran Logs doit dire
  // « on continue », pas laisser croire à un chantier qui recommence.
  const dejaAuJournal = bilanJournal().journal.lignesFinies;
  if (dejaAuJournal > 0) {
    journaliser({ type: 'reprise', dejaFaites: dejaAuJournal });
    applog.info(
      'harmonisation',
      `Reprise du renommage : ${dejaAuJournal} document(s) déjà fait(s) au journal, `
        + `${plan.entrees.length} restant(s) au plan recalculé.`,
      { userId, username }
    );
  }

  const sauvegarde = await sauvegarderBase();
  const mouvementsPrevus = plan.entrees.reduce((n, e) => n + e.mouvements.length, 0);
  applog.info(
    'harmonisation',
    `Renommage lancé : ${plan.entrees.length} document(s), ${mouvementsPrevus} mouvement(s) `
      + `vers la convention « ${convention} » — sauvegarde : ${path.basename(sauvegarde)}.`,
    { userId, username }
  );

  etat.phase = 'renommage';
  etat.total = plan.entrees.length;
  etat.message = 'Renommage en cours…';
  journaliser({ type: 'debut', mode: 'renommage', convention, lignes: plan.entrees.length, sauvegarde });

  const d = db.get();
  const lire = d.prepare('SELECT filename, destinations FROM invoices WHERE id = ?');
  const maj = d.prepare('UPDATE invoices SET filename = ?, destinations = ? WHERE id = ? AND filename = ?');

  // Trié par chemin, comme au lot 55 : les mouvements d'un même dossier se
  // suivent, et le cache de lecture des dossiers cloud sert vraiment.
  const entrees = [...plan.entrees].sort((a, b) => {
    const da = a.mouvements[0]?.de || '';
    const db2 = b.mouvements[0]?.de || '';
    return da < db2 ? -1 : da > db2 ? 1 : a.id - b.id;
  });

  for (const e of entrees) {
    // L'état FRAIS de la ligne : une récupération a pu passer, une reprise a
    // pu la finir. On ne renomme jamais sur la foi d'un plan qui ne décrit
    // plus la ligne.
    const ligne = lire.get(e.id);
    if (!ligne || (ligne.filename !== e.nom && ligne.filename !== e.cible)) {
      etat.ecartees++;
      journaliser({
        type: 'ecartee',
        id: e.id,
        motif: ligne ? 'la ligne a changé pendant le chantier' : 'la ligne a disparu pendant le chantier',
      });
      continue;
    }
    if (ligne.filename === e.cible) {
      etat.deja++;
      etat.faites++;
      continue;
    }

    etat.ligneEnCours = e.nom;
    for (const m of e.mouvements) {
      const resultat = await executerMouvement({ ...m, id: e.id }, destinationsChargees);
      journaliser({ type: 'mouvement', id: e.id, dest: m.dest, de: m.de, vers: m.vers, deja: resultat === 'deja' });
    }

    // La base en DERNIER, en une transaction, sur l'état relu à l'instant
    // même : si une récupération a réécrit la ligne entre les mouvements et
    // ici, on n'écrase pas son travail — la ligne est écartée, ses fichiers
    // déjà renommés seront reconnus « déjà faits » au prochain lancement.
    let ecriture = null;
    const tx = d.transaction(() => {
      const fraiche = lire.get(e.id);
      if (!fraiche || fraiche.filename !== e.nom) return false;
      let dests = {};
      try { dests = JSON.parse(fraiche.destinations || '{}') || {}; } catch { dests = {}; }
      for (const m of e.mouvements) dests[m.dest] = { ...dests[m.dest], path: m.vers };
      const apresJson = JSON.stringify(dests);
      const r = maj.run(e.cible, apresJson, e.id, e.nom);
      if (r.changes !== 1) return false;
      ecriture = { avant: { filename: e.nom, destinations: fraiche.destinations }, apres: { filename: e.cible, destinations: apresJson } };
      return true;
    });
    if (tx()) {
      journaliser({ type: 'base', id: e.id, ...ecriture });
      etat.faites++;
    } else {
      etat.ecartees++;
      journaliser({ type: 'ecartee', id: e.id, motif: 'la ligne a changé entre les mouvements et l\'écriture en base' });
    }

    if (process.env.CRABE_HARMONISATION_PANNE_APRES
        && etat.faites >= Number(process.env.CRABE_HARMONISATION_PANNE_APRES)) {
      // Tests uniquement : simule une coupure franche APRÈS n lignes finies,
      // pour prouver la reprise — le journal reste, la fin n'est pas écrite.
      journaliser({ type: 'panne-de-test', apres: etat.faites });
      throw arret(`panne de test après ${etat.faites} ligne(s) (CRABE_HARMONISATION_PANNE_APRES)`);
    }
  }

  journaliser({ type: 'fin', faites: etat.faites, deja: etat.deja, ecartees: etat.ecartees });
  etat.message = etat.ecartees
    ? `${etat.faites} document(s) renommé(s) ; ${etat.ecartees} écarté(s) parce qu'ils ont changé pendant l'opération — relancez pour les re-mesurer.`
    : `${etat.faites} document(s) renommé(s). Les noms suivent maintenant la convention choisie.`;
  applog.info('harmonisation', `Renommage terminé : ${etat.message}`, { userId, username });
}

/** L'annulation — le journal à l'envers, mêmes garde-fous. */
async function executerAnnulation(userId, username) {
  const destinationsChargees = chargerDestinations({ userId, username });
  await verifierPrealables({ douteux: [], collisions: [] }, destinationsChargees);

  const entrees = fs.readFileSync(JOURNAL(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gestes = entrees.filter((x) => (x.type === 'mouvement' && !x.deja) || x.type === 'base').reverse();

  const sauvegarde = await sauvegarderBase();
  etat.phase = 'annulation';
  etat.total = gestes.length;
  etat.message = 'Annulation en cours…';
  journaliser({ type: 'annulation-debut', gestes: gestes.length, sauvegarde });
  applog.info('harmonisation', `Annulation du renommage : ${gestes.length} geste(s) à rejouer à l'envers.`, { userId, username });

  const d = db.get();
  const lire = d.prepare('SELECT filename FROM invoices WHERE id = ?');
  const maj = d.prepare('UPDATE invoices SET filename = ?, destinations = ? WHERE id = ? AND filename = ?');

  for (const g of gestes) {
    if (g.type === 'base') {
      const ligne = lire.get(g.id);
      if (ligne && ligne.filename === g.avant.filename) { etat.faites++; etat.deja++; continue; }
      const r = ligne ? maj.run(g.avant.filename, g.avant.destinations, g.id, g.apres.filename) : { changes: 0 };
      if (r.changes !== 1) {
        throw arret(`le document ${g.id} ne porte ni le nom d'avant ni celui d'après — état à examiner à la main`);
      }
      journaliser({ type: 'annulation-base', id: g.id, filename: g.avant.filename });
    } else {
      const resultat = await executerMouvement({ ...g }, destinationsChargees, { annulation: true });
      journaliser({ type: 'annulation-mouvement', id: g.id, dest: g.dest, de: g.vers, vers: g.de, deja: resultat === 'deja' });
      if (resultat === 'deja') etat.deja++;
    }
    etat.faites++;
  }

  journaliser({ type: 'annulation-fin', faites: etat.faites });
  // L'annulation menée au bout archive le journal : le prochain chantier
  // repart à neuf, et « annuler » ne rejouera plus un passé déjà défait.
  fermerJournal();
  const archive = JOURNAL().replace(/\.jsonl$/, `-annule-${Date.now()}.jsonl`);
  fs.renameSync(JOURNAL(), archive);
  etat.message = 'Annulation terminée : chaque geste du journal a été rejoué à l\'envers.';
  applog.info('harmonisation', `Annulation terminée (journal archivé : ${path.basename(archive)}).`, { userId, username });
}

/** Remet l'état au repos — réservé aux tests. */
function reset() {
  etat = repos();
  cacheDossiers = new Map();
  fermerJournal();
  verrou.release(CLE);
}

module.exports = {
  mesurerConvention,
  construirePlan,
  demarrer,
  annuler,
  progress,
  isRunning,
  reset,
  // Exporté pour les tests du lot 57 : la vérification après mouvement est
  // patiente (un listing cloud en retard n'est pas un écart), et cette
  // patience se prouve sur le mouvement seul, sans monter tout un chantier.
  executerMouvement,
};
