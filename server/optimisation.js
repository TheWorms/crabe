'use strict';

/**
 * L'écran « Optimisation » (lot 60) : crabe sait entretenir ses réserves.
 *
 * ─── Le fait mesuré qui justifie ce module (26/08/2026, en production) ────
 *
 * Le dossier de données pesait 513 Mo, dont 465 Mo de profils de navigateur — et
 * sur les 110 Mo du plus gros profil, 103 Mo étaient du pur cache Chromium
 * (`Default/Code Cache` 86 Mo + `Default/Cache` 17 Mo). S'y ajoutaient ~19 Mo
 * de sauvegardes de base jamais purgées, sept configurations de destinations
 * supprimées subsistant en base et 24 traces d'échec vers des destinations
 * disparues. **Rien ne purgeait jamais rien.**
 *
 * ─── Cinq volets, une règle chacun ───────────────────────────────────────────
 *
 *   - **cache** : le cache reconstructible des profils de navigateur — et LUI
 *     SEUL. Liste BLANCHE mesurée, jamais une liste noire : un fichier inconnu
 *     reste (une session marchande vit dans le profil, la jeter oblige à
 *     repasser des murs anti-robot qui ont coûté des lots entiers).
 *   - **profils** : les profils entiers dont plus rien ne se sert — connecteur
 *     désinstallé, ou endormi depuis plus d'un an (fait DATÉ, mesuré en base).
 *   - **cloud** : les configurations supprimées (coquilles sans identifiants)
 *     et les traces d'échec qui pointent encore vers elles. Les deux se
 *     nettoient ENSEMBLE ou pas du tout : les coquilles nomment les pastilles
 *     de l'historique (voir destinations/catalogue.js), les effacer seules
 *     afficherait un identifiant nu à la place d'un nom.
 *   - **sauvegardes** : LISTE et demande — ce volet ne supprime JAMAIS rien
 *     seul, même en automatique (exigence explicite du propriétaire de l'installation). La cause amont
 *     est traitée à la création : `limiterSauvegardes()` garde les dernières
 *     d'un même motif.
 *   - **globale** : un LANCEMENT GROUPÉ des quatre autres, dans l'ordre sûr.
 *     Pas un réglage qui les pilote : piloter réécrirait leurs réglages — deux
 *     vérités pour un même volet, une ambiguïté inacceptable sur un écran qui
 *     supprime des fichiers. Chaque volet garde son réglage propre ; la
 *     globale n'est qu'un raccourci qui les exécute, chacun avec SES
 *     garde-fous, et l'écran le dit.
 *
 * Chaque volet a un mode (manuel / automatique) et une récurrence (1, 3, 6,
 * 12 ou 24 mois). **Tout naît en manuel** : rien ne se déclenche tant que
 * l'administrateur n'a pas choisi.
 *
 * ─── Garde-fous communs ──────────────────────────────────────────────────────
 *
 *   - jamais pendant qu'un renommage ou une synchronisation tourne ;
 *   - jamais sur un profil dont un Chromium vit (`navigateurVivant`, lot 51)
 *     ou qu'une fenêtre / récupération occupe (verrou `inflight`) ;
 *   - tout chemin supprimé est vérifié SOUS la racine attendue — un chemin qui
 *     en sort est refusé, pas corrigé ;
 *   - tout passage est journalisé (`app_logs`, source « optimisation ») :
 *     combien libéré, quoi supprimé, et ce qui a été EMPÊCHÉ — un volet sans
 *     rien à faire le dit aussi ;
 *   - ce que l'écran annonce est MESURÉ (octets comptés), jamais estimé.
 *
 * ─── Le filet au seuil (indépendant des récurrences) ─────────────────────────
 *
 * Sous 1 Gio d'espace libre sur le volume de données, l'entretien quotidien
 * fait le nettoyage SÛR (cache seul) et le dit. 1 Gio ≈ 8 % du disque de
 * 12 Go du serveur : en dessous, la base (journal WAL), les dépôts de
 * documents et les sauvegardes commenceraient à échouer ensemble. Ce filet
 * évite la panne sèche, il ne remplace pas l'entretien régulier.
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db/db');
const applog = require('./applog');
const { config } = require('./config');
const profilPersistant = require('./connectors/profil-persistant');
const inflight = require('./connectors/inflight');

// ---------------------------------------------------------------------------
// Constantes de conduite
// ---------------------------------------------------------------------------

/** Les cinq volets, dans l'ordre d'affichage — et l'ordre du lancement groupé. */
const VOLETS = ['globale', 'cache', 'profils', 'cloud', 'sauvegardes'];

/** Les récurrences proposées, en mois. */
const RECURRENCES_MOIS = [1, 3, 6, 12, 24];

/**
 * Liste BLANCHE du cache d'un profil Chromium — uniquement ce qui a été MESURÉ
 * reconstructible en production le 26/08/2026 (le plus gros profil,
 * 110 Mo) : Chromium recrée ces entrées à la prochaine ouverture, sans aucune
 * session dedans. Tout nom absent de ces listes RESTE, quoi qu'il pèse —
 * Cookies, Local Storage, Session Storage, Sessions, Network, Service Worker
 * et les jetons anti-robot vivent ailleurs que dans ces dossiers.
 */
const CACHE_DANS_DEFAULT = ['Code Cache', 'Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache'];
const CACHE_A_LA_RACINE = ['GPUPersistentCache', 'component_crx_cache', 'extensions_crx_cache', 'BrowserMetrics-spare.pma'];

/**
 * Un profil INSTALLÉ n'est candidat à la suppression qu'après ce sommeil,
 * mesuré sur des faits datés (dernière exécution réussie, dernier dépôt,
 * installation). Généreux exprès : un connecteur à facture annuelle dort des
 * mois avec une session valide, et la jeter oblige à repasser les murs.
 */
const SOMMEIL_PROFIL_MOIS = 12;

/** Sauvegardes gardées par motif à la CRÉATION (six « purge-doublons » pour un
 * seul chantier le 25/08/2026 : rien ne limitait l'accumulation). */
const SAUVEGARDES_GARDEES_PAR_MOTIF = 3;

/** Le filet : en dessous de cet espace libre, nettoyage sûr (cache seul). */
const SEUIL_ESPACE_LIBRE_OCTETS = 1024 * 1024 * 1024;

/** Motif d'un nom de sauvegarde de base : `crabe…avant-<motif>-<horodatage>`. */
const MOTIF_SAUVEGARDE = /^crabe(?:\.db\.|-(?:coherente-)?)avant-(.+)-(\d{8}-\d{6})(\.db)?(-wal|-shm|\.db-wal|\.db-shm)?$/;

// ---------------------------------------------------------------------------
// État visible (même modèle que destinations/sync.js : un objet en mémoire)
// ---------------------------------------------------------------------------

let etat = repos();

function repos() {
  return {
    running: false,
    volet: null,
    demarreLe: null,
    termineLe: null,
    faites: 0,
    total: 0,
    message: '',
    echec: false,
    /** Compte rendu détaillé du dernier passage, volet par volet. */
    details: [],
  };
}

/** Instantané de l'état, sans référence partagée. */
function progress() {
  return { ...etat, details: [...etat.details] };
}

function isRunning() {
  return etat.running;
}

/** Remise au repos — réservé aux tests. */
function reset() {
  etat = repos();
}

// ---------------------------------------------------------------------------
// Réglages (table optimisation_reglages, migration 50)
// ---------------------------------------------------------------------------

/** Les réglages des cinq volets — les lignes manquantes naissent en manuel. */
function reglages() {
  const lignes = new Map(
    db.get().prepare('SELECT volet, mode, recurrence_mois, dernier_passage FROM optimisation_reglages')
      .all()
      .map((r) => [r.volet, r])
  );
  const vue = {};
  for (const volet of VOLETS) {
    const l = lignes.get(volet);
    vue[volet] = {
      mode: l?.mode === 'automatique' ? 'automatique' : 'manuel',
      recurrenceMois: RECURRENCES_MOIS.includes(l?.recurrence_mois) ? l.recurrence_mois : 6,
      dernierPassage: l?.dernier_passage || null,
    };
  }
  return vue;
}

/** Règle un volet. Refuse toute valeur hors des choix proposés. */
function reglerVolet(volet, { mode, recurrenceMois }) {
  if (!VOLETS.includes(volet)) {
    throw erreur(400, 'Volet inconnu.');
  }
  if (!['manuel', 'automatique'].includes(mode)) {
    throw erreur(400, 'Mode inconnu : « manuel » ou « automatique ».');
  }
  const mois = Number(recurrenceMois);
  if (!RECURRENCES_MOIS.includes(mois)) {
    throw erreur(400, 'Récurrence inconnue : 1, 3, 6, 12 ou 24 mois.');
  }
  db.get()
    .prepare(
      `INSERT INTO optimisation_reglages (volet, mode, recurrence_mois, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(volet) DO UPDATE SET mode = excluded.mode,
         recurrence_mois = excluded.recurrence_mois, updated_at = datetime('now')`
    )
    .run(volet, mode, mois);
  return reglages()[volet];
}

function noterPassage(volet) {
  db.get()
    .prepare(
      `INSERT INTO optimisation_reglages (volet, dernier_passage, updated_at)
       VALUES (?, datetime('now'), datetime('now'))
       ON CONFLICT(volet) DO UPDATE SET dernier_passage = datetime('now'),
         updated_at = datetime('now')`
    )
    .run(volet);
}

function erreur(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// ---------------------------------------------------------------------------
// Outils de mesure et de suppression sûre
// ---------------------------------------------------------------------------

/** Poids d'un fichier ou d'un dossier, en octets — compté, jamais estimé. */
function poids(chemin) {
  let st;
  try {
    st = fs.lstatSync(chemin);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let entrees = [];
  try {
    entrees = fs.readdirSync(chemin);
  } catch {
    return 0;
  }
  for (const e of entrees) total += poids(path.join(chemin, e));
  return total;
}

/**
 * Supprime un chemin, à la SEULE condition qu'il soit sous la racine attendue.
 *
 * Un `rm -rf` sur un chemin construit est irréversible : tout chemin qui
 * s'échappe de sa racine (lien, `..`, segment vide) est refusé — l'appelant
 * journalise le refus, il ne le contourne pas.
 *
 * @returns {number} les octets libérés (0 si refusé ou absent)
 */
function supprimerSous(racine, chemin) {
  const racineReelle = path.resolve(racine);
  const cible = path.resolve(chemin);
  if (cible !== racineReelle && !cible.startsWith(racineReelle + path.sep)) {
    throw new Error(`Chemin hors de la racine attendue, suppression refusée : ${cible}`);
  }
  const octets = poids(cible);
  if (!octets && !fs.existsSync(cible)) return 0;
  fs.rmSync(cible, { recursive: true, force: true });
  return octets;
}

/** L'espace libre du volume de données, ou null si l'appel n'existe pas. */
function espaceLibreDonnees() {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const st = fs.statfsSync(config.dataDir);
    return { libre: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Les profils : inventaire commun aux volets cache et profils
// ---------------------------------------------------------------------------

/**
 * Tous les profils de navigateur présents sur le disque, avec ce que la base
 * SAIT de chacun : installation, dernière exécution réussie, dernier dépôt,
 * vivacité. C'est sur ces faits datés que les volets décident — jamais sur
 * une intuition.
 */
function inventaireProfils() {
  const racine = profilPersistant.racine();
  let dossiersUtilisateurs = [];
  try {
    dossiersUtilisateurs = fs.readdirSync(racine);
  } catch {
    return []; // aucune racine : aucun profil
  }

  const derniereReussite = new Map(
    db.get()
      .prepare(
        `SELECT user_id, connector_id, MAX(finished_at) AS quand
           FROM run_logs WHERE success = 1 GROUP BY user_id, connector_id`
      )
      .all()
      .map((r) => [`${r.user_id}:${r.connector_id}`, r.quand])
  );
  const dernierDepot = new Map(
    db.get()
      .prepare(
        `SELECT user_id, connector_id, MAX(fetched_at) AS quand
           FROM invoices GROUP BY user_id, connector_id`
      )
      .all()
      .map((r) => [`${r.user_id}:${r.connector_id}`, r.quand])
  );
  const installs = new Map(
    db.get()
      .prepare('SELECT user_id, connector_id, installed_at FROM connector_installs')
      .all()
      .map((r) => [`${r.user_id}:${r.connector_id}`, r.installed_at])
  );

  const profils = [];
  for (const u of dossiersUtilisateurs) {
    const dossierU = path.join(racine, u);
    let connecteurs = [];
    try {
      if (!fs.lstatSync(dossierU).isDirectory()) continue;
      connecteurs = fs.readdirSync(dossierU);
    } catch {
      continue;
    }
    for (const c of connecteurs) {
      const dossier = path.join(dossierU, c);
      try {
        if (!fs.lstatSync(dossier).isDirectory()) continue;
      } catch {
        continue;
      }
      const cle = `${u}:${c}`;
      profils.push({
        userId: Number(u) || u,
        connectorId: c,
        dossier,
        octets: poids(dossier),
        installe: installs.has(cle),
        installeLe: installs.get(cle) || null,
        derniereReussite: derniereReussite.get(cle) || null,
        dernierDepot: dernierDepot.get(cle) || null,
        vivant: profilPersistant.navigateurVivant(dossier),
        occupe: inflight.profil.busy(inflight.profilKey(u, c)),
      });
    }
  }
  return profils;
}

/** Les entrées de cache d'UN profil (liste blanche), avec leur poids. */
function entreesCacheDuProfil(dossier) {
  const entrees = [];
  for (const nom of CACHE_A_LA_RACINE) {
    const chemin = path.join(dossier, nom);
    if (fs.existsSync(chemin)) entrees.push({ chemin, octets: poids(chemin) });
  }
  const defaut = path.join(dossier, 'Default');
  for (const nom of CACHE_DANS_DEFAULT) {
    const chemin = path.join(defaut, nom);
    if (fs.existsSync(chemin)) entrees.push({ chemin, octets: poids(chemin) });
  }
  return entrees;
}

/** Le dernier signe de vie daté d'un profil, pour mesurer son sommeil. */
function dernierSigne(profil) {
  const dates = [profil.derniereReussite, profil.dernierDepot, profil.installeLe]
    .filter(Boolean)
    .map((d) => Date.parse(String(d).replace(' ', 'T').replace(/(?<!Z)$/, 'Z')))
    .filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : null;
}

/** Un profil installé dort-il depuis plus de SOMMEIL_PROFIL_MOIS ? */
function sommeilDepasse(profil, maintenant = Date.now()) {
  const signe = dernierSigne(profil);
  if (signe === null) return false; // aucun fait daté : on ne devine pas
  const limite = SOMMEIL_PROFIL_MOIS * 30.44 * 24 * 3600 * 1000;
  return maintenant - signe > limite;
}

// ---------------------------------------------------------------------------
// Les coquilles cloud : inventaire commun mesure/nettoyage
// ---------------------------------------------------------------------------

/**
 * Les configurations supprimées et les traces qui pointent encore vers elles.
 *
 * Une trace d'ÉCHEC (`ok` faux) vers une destination disparue est du bruit :
 * elle raconte qu'une copie n'a PAS eu lieu vers un espace qui n'existe plus.
 * Une trace de copie RÉUSSIE, elle, raconte un fichier bien réel déposé chez
 * un tiers : elle reste, et la coquille qui la nomme reste avec elle.
 */
function inventaireCloud() {
  const coquilles = db.get()
    .prepare(
      `SELECT dest_id, display_name, provider, deleted_at
         FROM destinations_config WHERE deleted_at IS NOT NULL`
    )
    .all();
  const supprimees = new Set(coquilles.map((c) => c.dest_id));

  const traces = [];
  const referencesRestantes = new Set();
  for (const row of db.get().prepare("SELECT id, destinations FROM invoices WHERE destinations IS NOT NULL AND destinations != ''").all()) {
    let dests;
    try {
      dests = JSON.parse(row.destinations);
    } catch {
      continue; // illisible : on n'y touche pas
    }
    for (const [destId, resultat] of Object.entries(dests)) {
      if (!supprimees.has(destId)) continue;
      if (resultat?.ok) {
        referencesRestantes.add(destId); // copie réelle : la coquille nomme encore
      } else {
        traces.push({ invoiceId: row.id, destId });
      }
    }
  }

  return coquilles.map((c) => ({
    destId: c.dest_id,
    nom: c.display_name || c.dest_id,
    provider: c.provider,
    supprimeeLe: c.deleted_at,
    traces: traces.filter((t) => t.destId === c.dest_id),
    copiesReussies: referencesRestantes.has(c.dest_id),
  }));
}

// ---------------------------------------------------------------------------
// Les sauvegardes : inventaire commun liste/limite/suppression
// ---------------------------------------------------------------------------

/**
 * Les sauvegardes de base connues : `dataDir/sauvegardes/*` et les
 * `crabe.db.avant-*` de la racine des données. Les fichiers `-wal`/`-shm`
 * sont rattachés à leur base : ils partent (ou restent) avec elle.
 */
function inventaireSauvegardes() {
  const emplacements = [
    path.join(config.dataDir, 'sauvegardes'),
    config.dataDir,
  ];
  const entrees = [];
  for (const dossier of emplacements) {
    let noms = [];
    try {
      noms = fs.readdirSync(dossier);
    } catch {
      continue;
    }
    for (const nom of noms) {
      const m = MOTIF_SAUVEGARDE.exec(nom);
      if (!m) continue;
      if (/(-wal|-shm)$/.test(nom)) continue; // rattaché à sa base plus bas
      const chemin = path.join(dossier, nom);
      let st;
      try {
        st = fs.statSync(chemin);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const annexes = [`${chemin}-wal`, `${chemin}-shm`].filter((a) => fs.existsSync(a));
      entrees.push({
        nom,
        chemin,
        motif: m[1],
        horodatage: m[2],
        octets: st.size + annexes.reduce((n, a) => n + poids(a), 0),
        modifieLe: st.mtime.toISOString(),
        annexes,
      });
    }
  }
  return entrees.sort((a, b) => b.horodatage.localeCompare(a.horodatage));
}

/**
 * La cause amont : à la CRÉATION d'une sauvegarde, ne garder que les
 * SAUVEGARDES_GARDEES_PAR_MOTIF dernières du même motif. Appelée par le code
 * qui crée des sauvegardes (harmonisation), jamais par le volet — le volet,
 * lui, ne supprime rien sans geste explicite.
 *
 * @param {string} motif ex. « harmonisation »
 * @returns {{supprimees: number, octets: number}}
 */
function limiterSauvegardes(motif, garder = SAUVEGARDES_GARDEES_PAR_MOTIF) {
  const memesMotif = inventaireSauvegardes().filter((s) => s.motif === motif);
  const excedent = memesMotif.slice(garder);
  let octets = 0;
  for (const s of excedent) {
    octets += supprimerSous(config.dataDir, s.chemin);
    for (const a of s.annexes) octets += supprimerSous(config.dataDir, a);
  }
  if (excedent.length) {
    applog.info(
      'optimisation',
      `Sauvegardes « ${motif} » : ${excedent.length} ancienne(s) retirée(s) à la création `
        + `d'une nouvelle (${Math.round(octets / 1024)} Ko) — les ${garder} plus récentes sont gardées.`
    );
  }
  return { supprimees: excedent.length, octets };
}

// ---------------------------------------------------------------------------
// Mesure : ce que chaque volet libérerait, sans rien toucher
// ---------------------------------------------------------------------------

/** La photographie complète que l'écran affiche. Lecture seule. */
function mesurer() {
  const profils = inventaireProfils();

  const cache = profils.map((p) => ({
    connectorId: p.connectorId,
    userId: p.userId,
    octets: entreesCacheDuProfil(p.dossier).reduce((n, e) => n + e.octets, 0),
    empeche: p.vivant ? 'navigateur ouvert' : p.occupe ? 'opération en cours' : null,
  }));

  const candidatsProfils = profils.map((p) => {
    const signe = dernierSigne(p);
    return {
      connectorId: p.connectorId,
      userId: p.userId,
      octets: p.octets,
      installe: p.installe,
      dernierSigne: signe ? new Date(signe).toISOString() : null,
      candidat: !p.vivant && !p.occupe && (!p.installe || sommeilDepasse(p)),
      motif: !p.installe
        ? 'connecteur désinstallé'
        : sommeilDepasse(p)
          ? `aucune activité depuis plus de ${SOMMEIL_PROFIL_MOIS} mois`
          : null,
      empeche: p.vivant ? 'navigateur ouvert' : p.occupe ? 'opération en cours' : null,
    };
  });

  const cloud = inventaireCloud();
  const sauvegardes = inventaireSauvegardes();

  return {
    cache: {
      octets: cache.reduce((n, p) => n + (p.empeche ? 0 : p.octets), 0),
      profils: cache,
    },
    profils: {
      octets: candidatsProfils.filter((p) => p.candidat).reduce((n, p) => n + p.octets, 0),
      candidats: candidatsProfils.filter((p) => p.candidat),
      dormants: candidatsProfils.filter((p) => !p.candidat),
      sommeilMois: SOMMEIL_PROFIL_MOIS,
    },
    cloud: {
      coquilles: cloud,
      nettoyables: cloud.filter((c) => !c.copiesReussies).length,
      traces: cloud.reduce((n, c) => n + c.traces.length, 0),
    },
    sauvegardes: {
      octets: sauvegardes.reduce((n, s) => n + s.octets, 0),
      fichiers: sauvegardes,
    },
    disque: { ...module.exports.espaceLibreDonnees(), seuil: SEUIL_ESPACE_LIBRE_OCTETS },
  };
}

// ---------------------------------------------------------------------------
// Les nettoyages eux-mêmes
// ---------------------------------------------------------------------------

/**
 * Volet cache : vide la liste blanche de chaque profil ni vivant ni occupé.
 * Les cookies, sessions et jetons anti-robot ne sont pas dans la liste : ils
 * ne sont JAMAIS touchés.
 */
function nettoyerCache() {
  const racine = profilPersistant.racine();
  let libere = 0;
  let vides = 0;
  const empeches = [];

  for (const p of inventaireProfils()) {
    if (p.vivant || p.occupe) {
      empeches.push(`${p.connectorId} (${p.vivant ? 'navigateur ouvert' : 'opération en cours'})`);
      continue;
    }
    let duProfil = 0;
    for (const entree of entreesCacheDuProfil(p.dossier)) {
      duProfil += supprimerSous(racine, entree.chemin);
    }
    if (duProfil) vides++;
    libere += duProfil;
  }

  const phrase = libere
    ? `Cache des profils : ${fmtMo(libere)} libérés sur ${vides} profil(s).`
    : 'Cache des profils : rien à libérer.';
  return { libere, phrase, empeches };
}

/** Volet profils : supprime les profils candidats (désinstallés ou endormis). */
function nettoyerProfils() {
  const racine = profilPersistant.racine();
  let libere = 0;
  const supprimes = [];
  const empeches = [];

  for (const p of inventaireProfils()) {
    const candidat = !p.installe || sommeilDepasse(p);
    if (!candidat) continue;
    if (p.vivant || p.occupe) {
      empeches.push(`${p.connectorId} (${p.vivant ? 'navigateur ouvert' : 'opération en cours'})`);
      continue;
    }
    const signe = dernierSigne(p);
    const sommeilJours = signe ? Math.round((Date.now() - signe) / 86400000) : null;
    const octets = supprimerSous(racine, p.dossier);
    libere += octets;
    supprimes.push({ connectorId: p.connectorId, octets, sommeilJours, installe: p.installe });
    applog.info(
      'optimisation',
      `Profil ${p.connectorId} supprimé (${fmtMo(octets)}, `
        + `${p.installe ? `endormi depuis ${sommeilJours} jour(s)` : 'connecteur désinstallé'}).`
    );
  }

  const phrase = supprimes.length
    ? `Profils non utilisés : ${supprimes.length} profil(s) supprimé(s), ${fmtMo(libere)} libérés.`
    : 'Profils non utilisés : rien à supprimer — tous les profils servent encore.';
  return { libere, phrase, empeches };
}

/**
 * Volet cloud : retire ENSEMBLE les traces d'échec vers les destinations
 * supprimées et les coquilles que plus rien ne référence. Une coquille encore
 * nommée par une copie réussie reste — elle nomme un fichier bien réel.
 */
function nettoyerCloud() {
  const inventaire = inventaireCloud();
  let tracesRetirees = 0;
  let coquillesRetirees = 0;

  const transaction = db.get().transaction(() => {
    for (const c of inventaire) {
      for (const t of c.traces) {
        const row = db.get().prepare('SELECT destinations FROM invoices WHERE id = ?').get(t.invoiceId);
        if (!row) continue;
        let dests;
        try {
          dests = JSON.parse(row.destinations);
        } catch {
          continue;
        }
        if (!(c.destId in dests) || dests[c.destId]?.ok) continue;
        delete dests[c.destId];
        db.get().prepare('UPDATE invoices SET destinations = ? WHERE id = ?')
          .run(JSON.stringify(dests), t.invoiceId);
        tracesRetirees++;
      }
      if (!c.copiesReussies) {
        db.get().prepare('DELETE FROM destinations_config WHERE dest_id = ? AND deleted_at IS NOT NULL')
          .run(c.destId);
        coquillesRetirees++;
      }
    }
  });
  transaction();
  if (coquillesRetirees) require('./destinations/catalogue').oublier();

  const gardees = inventaire.filter((c) => c.copiesReussies).length;
  const phrase = coquillesRetirees || tracesRetirees
    ? `Cloud non utilisé : ${coquillesRetirees} configuration(s) supprimée(s) et `
      + `${tracesRetirees} trace(s) d'échec retirée(s) ensemble`
      + (gardees ? ` — ${gardees} gardée(s) : des copies réussies portent encore leur nom.` : '.')
    : 'Cloud non utilisé : rien à nettoyer.';
  return { libere: 0, phrase, empeches: [] };
}

/**
 * Volet sauvegardes : fait le POINT, ne supprime rien — jamais sans le geste
 * explicite de l'administrateur (`supprimerSauvegardes`), même en automatique.
 */
function pointSauvegardes() {
  const fichiers = inventaireSauvegardes();
  const octets = fichiers.reduce((n, s) => n + s.octets, 0);
  const phrase = fichiers.length
    ? `Sauvegardes : ${fichiers.length} fichier(s), ${fmtMo(octets)} — rien n'est supprimé sans votre accord, la liste attend votre geste sur l'écran Optimisation.`
    : 'Sauvegardes : aucune sur le disque.';
  return { libere: 0, phrase, empeches: [] };
}

/**
 * Le geste explicite : supprime les sauvegardes NOMMÉES par l'administrateur.
 * Chaque nom doit être une sauvegarde connue de l'inventaire — pas un chemin.
 */
function supprimerSauvegardes(noms, actor = {}) {
  if (!Array.isArray(noms) || !noms.length) {
    throw erreur(400, 'Aucune sauvegarde désignée.');
  }
  const connues = new Map(inventaireSauvegardes().map((s) => [s.nom, s]));
  const inconnues = noms.filter((n) => !connues.has(n));
  if (inconnues.length) {
    throw erreur(400, `Sauvegarde inconnue : ${inconnues.join(', ')}. Rien n'a été supprimé.`);
  }

  let octets = 0;
  for (const nom of noms) {
    const s = connues.get(nom);
    octets += supprimerSous(config.dataDir, s.chemin);
    for (const a of s.annexes) octets += supprimerSous(config.dataDir, a);
  }
  applog.info(
    'optimisation',
    `Sauvegardes : ${noms.length} fichier(s) supprimé(s) sur demande (${fmtMo(octets)}) — ${noms.join(', ')}.`,
    actor
  );
  return { supprimees: noms.length, octets };
}

function fmtMo(octets) {
  if (octets >= 1024 * 1024) return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
  if (octets >= 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${octets} octet(s)`;
}

// ---------------------------------------------------------------------------
// Le lancement d'un volet (et le lancement groupé)
// ---------------------------------------------------------------------------

const ACTIONS = {
  cache: nettoyerCache,
  profils: nettoyerProfils,
  cloud: nettoyerCloud,
  sauvegardes: pointSauvegardes,
};

/**
 * Lance un volet (ou la globale). Synchrone du point de vue de l'appelant HTTP
 * court : ces nettoyages sont des parcours de disque local et de base — pas de
 * réseau — mais l'état `progress()` est tenu pour le bandeau (lot 59).
 *
 * @throws {Error} 409 si un nettoyage, un renommage ou une synchronisation tourne
 */
function lancer(volet, { actor = {}, declencheur = 'manuel' } = {}) {
  if (!VOLETS.includes(volet)) throw erreur(400, 'Volet inconnu.');
  if (etat.running) throw erreur(409, 'Un nettoyage est déjà en cours — attendez qu\'il se termine.');
  if (require('./harmonisation').isRunning()) {
    throw erreur(409, 'Un renommage des documents est en cours — le nettoyage attendra qu\'il se termine.');
  }
  if (require('./destinations/sync').isRunning()) {
    throw erreur(409, 'Une synchronisation des destinations est en cours — le nettoyage attendra qu\'elle se termine.');
  }

  const voletsAFaire = volet === 'globale' ? ['cache', 'profils', 'cloud', 'sauvegardes'] : [volet];
  etat = {
    ...repos(),
    running: true,
    volet,
    demarreLe: new Date().toISOString(),
    total: voletsAFaire.length,
    message: 'Nettoyage en cours…',
  };

  try {
    let libere = 0;
    const phrases = [];
    const empeches = [];
    for (const v of voletsAFaire) {
      const resultat = ACTIONS[v]();
      etat.faites++;
      etat.details.push({ volet: v, ...resultat });
      libere += resultat.libere;
      phrases.push(resultat.phrase);
      empeches.push(...resultat.empeches);
      noterPassage(v);
    }
    if (volet === 'globale') noterPassage('globale');

    etat.message = phrases.join(' ');
    if (empeches.length) {
      etat.message += ` Non touchés : ${empeches.join(', ')}.`;
    }
    applog.info(
      'optimisation',
      `Optimisation (${volet}, ${declencheur}) : ${etat.message}`,
      actor
    );
  } catch (err) {
    etat.echec = true;
    etat.message = `Nettoyage arrêté : ${err.message}`;
    applog.error('optimisation', etat.message, actor);
  } finally {
    etat.running = false;
    etat.termineLe = new Date().toISOString();
  }
  return progress();
}

// ---------------------------------------------------------------------------
// L'entretien quotidien : récurrences et filet au seuil
// ---------------------------------------------------------------------------

/** Un passage est-il dû, au vu du réglage et du dernier passage ? */
function passageDu(reglage, maintenant = Date.now()) {
  if (reglage.mode !== 'automatique') return false;
  if (!reglage.dernierPassage) return true;
  const dernier = Date.parse(String(reglage.dernierPassage).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
  if (!Number.isFinite(dernier)) return true;
  return maintenant - dernier > reglage.recurrenceMois * 30.44 * 24 * 3600 * 1000;
}

/**
 * Appelé par l'entretien quotidien de 04:15 (scheduler.startMaintenance).
 *
 * D'abord le filet : sous le seuil d'espace libre, le nettoyage SÛR (cache
 * seul) part tout de suite, quel que soit le mode des volets, et le dit.
 * Ensuite les récurrences : chaque volet en automatique dont le dernier
 * passage est plus vieux que sa récurrence. La globale en automatique lance
 * le groupe. Ne lève jamais : un nettoyage en échec ne doit pas emporter le
 * reste de l'entretien.
 */
function entretienQuotidien() {
  const bilan = { filet: false, lances: [] };
  try {
    // Via module.exports : les tests remplacent la mesure d'espace sans
    // monter un vrai disque plein.
    const disque = module.exports.espaceLibreDonnees();
    if (disque && disque.libre < SEUIL_ESPACE_LIBRE_OCTETS && !etat.running) {
      applog.warn(
        'optimisation',
        `Espace libre sous le seuil (${fmtMo(disque.libre)} < ${fmtMo(SEUIL_ESPACE_LIBRE_OCTETS)}) : `
          + 'nettoyage sûr du cache lancé — le filet évite la panne sèche, il ne remplace pas l\'entretien régulier.'
      );
      lancer('cache', { declencheur: 'seuil' });
      bilan.filet = true;
    }

    const vue = reglages();
    if (passageDu(vue.globale)) {
      lancer('globale', { declencheur: 'récurrence' });
      bilan.lances.push('globale');
      return bilan; // la globale vient de passer les quatre : rien d'autre à faire
    }
    for (const volet of ['cache', 'profils', 'cloud', 'sauvegardes']) {
      if (!passageDu(vue[volet])) continue;
      if (etat.running) break; // un volet à la fois : le suivant attendra demain
      lancer(volet, { declencheur: 'récurrence' });
      bilan.lances.push(volet);
    }
  } catch (err) {
    applog.error('optimisation', `Entretien d'optimisation en échec : ${err.message}`);
  }
  return bilan;
}

// ---------------------------------------------------------------------------
// Le bandeau (lot 59)
// ---------------------------------------------------------------------------

/**
 * L'optimisation au bandeau des opérations — pour les comptes qui voient
 * l'écran (permission storage.manage) : le nettoyage touche la machine, pas
 * un compte.
 */
function operationsPour(user, ops, { recent }) {
  if (!require('./permissions').userHas(user, 'storage.manage')) return;
  const o = progress();

  if (o.running) {
    ops.push({
      cle: `optimisation:${o.demarreLe}`,
      type: 'optimisation',
      titre: 'Optimisation de l\'installation',
      etat: 'en-cours',
      detail: o.total > 1 ? `${o.faites} sur ${o.total} volets` : o.message,
      faites: o.total > 1 ? o.faites : null,
      total: o.total > 1 ? o.total : null,
      ecran: 'admin-optimisation',
      demarreLe: o.demarreLe,
      termineLe: null,
    });
    return;
  }

  // La fenêtre d'annonce dépend de l'état (lot 65) : un succès s'efface tout
  // seul, un échec attend une décision. `recent` a donc besoin des deux.
  const etat = o.echec ? 'echec' : 'succes';
  if (!recent(o.termineLe, etat)) return;
  ops.push({
    cle: `optimisation:${o.demarreLe}`,
    type: 'optimisation',
    titre: 'Optimisation de l\'installation',
    etat,
    detail: o.message || 'Terminé.',
    faites: null,
    total: null,
    ecran: 'admin-optimisation',
    demarreLe: o.demarreLe,
    termineLe: o.termineLe,
  });
}

module.exports = {
  VOLETS,
  RECURRENCES_MOIS,
  CACHE_DANS_DEFAULT,
  CACHE_A_LA_RACINE,
  SOMMEIL_PROFIL_MOIS,
  SAUVEGARDES_GARDEES_PAR_MOTIF,
  SEUIL_ESPACE_LIBRE_OCTETS,
  reglages,
  reglerVolet,
  mesurer,
  lancer,
  supprimerSauvegardes,
  limiterSauvegardes,
  inventaireProfils,
  inventaireCloud,
  inventaireSauvegardes,
  entretienQuotidien,
  operationsPour,
  progress,
  isRunning,
  reset,
  // Exposés pour les tests : la sûreté du chemin et l'espace libre se
  // remplacent sans monter un disque plein.
  supprimerSous,
  espaceLibreDonnees,
};
