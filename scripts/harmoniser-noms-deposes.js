'use strict';

/**
 * Harmonisation des noms des documents déjà déposés — dette n°8, lot 55.
 *
 * Le plan de renommage se dérive de `scripts/derivation-noms-deposes.js` :
 * ce script-ci le montre, le vérifie, et — sur ordre explicite — l'exécute
 * sur toutes les destinations (le stockage local, et chaque cloud actif) puis dans la
 * base. SANS ARGUMENT, IL NE MODIFIE RIEN : c'est une passe à blanc.
 *
 * ─── Usage (en tant que `crabe`, depuis /opt/crabe) ──────────────────────────
 *
 *   node scripts/harmoniser-noms-deposes.js
 *       Passe à blanc : plan complet, vérification du stockage local, rien ne bouge.
 *       Le plan lisible s'écrit dans <data>/lot55-plan.tsv.
 *
 *   node scripts/harmoniser-noms-deposes.js --sonder-clouds
 *       Passe à blanc + une lecture (`rclone lsf`) par cloud pour vérifier
 *       que chaque fichier à renommer est bien là et qu'aucun nom cible
 *       n'est déjà pris. Lecture seule, une seule sonde par cloud.
 *
 *   node scripts/harmoniser-noms-deposes.js --applique --sauvegarde <chemin>
 *       Exécution réelle. REFUSE de partir sans : une sauvegarde de la base
 *       vérifiée (même nombre de lignes, même max_id), le service crabe
 *       arrêté, un plan sans cas douteux ni collision, et chaque destination
 *       joignable.
 *
 *   node scripts/harmoniser-noms-deposes.js --annuler [--applique --sauvegarde <chemin>]
 *       Rejoue le journal À L'ENVERS : chaque ligne de base restaurée, chaque
 *       fichier remis sous son ancien nom. Passe à blanc par défaut.
 *
 * ─── L'ordre des opérations, et pourquoi ─────────────────────────────────────
 *
 * Pour CHAQUE ligne : le stockage d'abord (le local, puis chaque cloud), la
 * base ensuite, en une transaction. Deux fenêtres d'incohérence étaient
 * possibles :
 *
 *   - stockage d'abord : le temps du renommage, la base pointe l'ancien nom
 *     alors que le fichier porte déjà le neuf — un téléchargement rendrait
 *     404, AUCUNE donnée n'est perdue, et l'état se MESURE : ancien absent
 *     + nouveau présent = mouvement fait ;
 *   - base d'abord : la base affirmerait des noms qui n'existent pas encore
 *     sur trois stockages distants, et c'est le stockage — la partie qui
 *     peut échouer à mi-course — qui devrait rattraper la base.
 *
 * On choisit la première : l'écriture en base est ATOMIQUE (une transaction
 * par ligne) et vient en DERNIER — elle sert de marqueur « cette ligne est
 * finie ». Une interruption laisse au pire une ligne dont les fichiers sont
 * renommés et pas la base ; à la relance, l'état des fichiers le dit
 * (« déjà fait ») et la base se termine. Et la fenêtre 404 n'existe pour
 * personne : le service doit être ARRÊTÉ, le script le vérifie.
 *
 * ─── Reprise après interruption ──────────────────────────────────────────────
 *
 * Relancer LA MÊME COMMANDE. Le plan se recalcule depuis la base : les lignes
 * déjà finies (base à jour) en sortent d'elles-mêmes ; une ligne interrompue
 * entre deux destinations est reconnue mouvement par mouvement (ancien absent
 * + nouveau présent = déjà fait) et se termine. Aucun mouvement n'est refait,
 * aucun n'est perdu.
 *
 * ─── Annulation ──────────────────────────────────────────────────────────────
 *
 * Chaque mouvement et chaque écriture en base laissent une ligne dans le
 * journal (<data>/lot55-renommage-journal.jsonl — persistant, jamais dans
 * /tmp). `--annuler` le rejoue à l'envers avec les mêmes garde-fous. En
 * dernier recours, la sauvegarde exigée avant l'exécution restaure la base,
 * et le journal donne la liste exacte des fichiers à remettre à la main.
 *
 * ─── Garde-fous ──────────────────────────────────────────────────────────────
 *
 *   - vérification AVANT chaque mouvement : l'ancien nom présent, le nom
 *     cible absent — jamais d'écrasement (un `rclone moveto` mal dirigé
 *     écrase sans un mot) ;
 *   - vérification APRÈS chaque mouvement : relecture du dossier, le nouveau
 *     nom présent, l'ancien absent ;
 *   - ARRÊT IMMÉDIAT au premier état inattendu, avec la ligne, la
 *     destination, les deux chemins, et comment reprendre ;
 *   - les cas douteux ne s'exécutent JAMAIS : ils se listent, l'administrateur tranche.
 *
 * CRABE_RENOMMAGE_PANNE_APRES=<n> (tests uniquement) : s'arrête net après n
 * lignes finies, pour prouver la reprise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { config } = require('../server/config');
const crypto = require('../server/crypto');
const rclone = require('../server/destinations/rclone');
const presets = require('../server/destinations/presets');
const { creerDestination } = require('../server/destinations/remote-rclone');
const { deriverNomCible } = require('./derivation-noms-deposes');
const Database = require('better-sqlite3');

const APPLIQUE = process.argv.includes('--applique');
const ANNULER = process.argv.includes('--annuler');
const SONDER = process.argv.includes('--sonder-clouds');
const SAUVEGARDE = (() => {
  const i = process.argv.indexOf('--sauvegarde');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const JOURNAL = path.join(config.dataDir, 'lot55-renommage-journal.jsonl');
const PLAN_TSV = path.join(config.dataDir, 'lot55-plan.tsv');
const PANNE_APRES = Number(process.env.CRABE_RENOMMAGE_PANNE_APRES || 0);

/** Arrêt immédiat : l'état, où on en est, comment reprendre. */
function arret(message) {
  console.error(`\nARRÊT IMMÉDIAT — ${message}`);
  console.error(
    'Rien d\'autre n\'a été touché. Corrigez la cause, puis relancez LA MÊME '
    + 'COMMANDE : le script reconnaît ce qui est déjà fait et reprend où il en était.'
  );
  process.exit(1);
}

// ─── Journal persistant ───────────────────────────────────────────────────────

let journalFd = null;
function journaliser(entree) {
  if (journalFd === null) journalFd = fs.openSync(JOURNAL, 'a');
  fs.writeSync(journalFd, `${JSON.stringify({ quand: new Date().toISOString(), ...entree })}\n`);
  fs.fsyncSync(journalFd);
}

// ─── Destinations ─────────────────────────────────────────────────────────────

/**
 * Les destinations actives : le stockage local (sa racine) et chaque cloud (sa
 * configuration déchiffrée, normalisée par le MÊME pilote que le dépôt).
 * L'objet passé à rclone en passe à blanc est NU (aucun rappel d'écriture) ;
 * en exécution réelle il garde `onSecretsRafraichis`, comme en production —
 * un jeton rafraîchi par rclone pendant le chantier ne doit pas se perdre.
 */
function chargerDestinations(dbc, { avecRappel }) {
  const lignes = dbc
    .prepare("SELECT dest_id, display_name, provider, path, config_encrypted FROM destinations_config WHERE (deleted_at IS NULL) AND enabled = 1")
    .all();

  const locale = lignes.find((l) => l.dest_id === 'local');
  if (!locale || !locale.path) arret('la destination locale est introuvable en base — rien à faire sans elle.');

  const clouds = [];
  for (const l of lignes) {
    if (l.dest_id === 'local') continue;
    const conf = crypto.decryptJson(l.config_encrypted);
    const preset = presets.of(l.provider) || presets.of('autre');
    const driver = creerDestination({
      id: l.dest_id, name: l.display_name || preset.label, defaultRemote: 'crabe',
      backend: preset.backend, champs: preset.champs || [],
      versChamps: preset.versChamps || ((v) => v),
    });
    const normalise = driver.normalizeConf(conf);
    const dest = {
      remoteName: normalise.remoteName || 'crabe',
      basePath: normalise.basePath || 'crabe',
      rcloneConfig: normalise.rcloneConfig,
    };
    if (avecRappel) dest.onSecretsRafraichis = normalise.onSecretsRafraichis;
    clouds.push({ destId: l.dest_id, nom: l.display_name || preset.label, dest });
  }
  return { racineLocale: locale.path, clouds };
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

function dossierDe(chemin) {
  return chemin.slice(0, chemin.lastIndexOf('/'));
}

/**
 * Le plan complet, depuis la base : une entrée par ligne, avec son verdict et,
 * pour un renommage, un mouvement par destination revendiquée. Les collisions
 * se cherchent sur les noms FINAUX, dossier par dossier : deux lignes qui
 * aboutiraient au même nom, ou un nom cible déjà porté par une ligne qui ne
 * bouge pas, sont des cas douteux — jamais des exécutions.
 */
function construirePlan(dbc, destinations) {
  const lignes = dbc
    .prepare('SELECT id, connector_id, filename, destinations FROM invoices ORDER BY id')
    .all();

  const entrees = [];
  const douteux = [];
  const finaux = new Map(); // `<dest>|<dossier>` -> Map(nom final -> [ids])

  for (const l of lignes) {
    const verdict = deriverNomCible(l.connector_id, l.filename);
    let dests = {};
    try { dests = JSON.parse(l.destinations || '{}') || {}; } catch { dests = {}; }

    const revendiques = [];
    for (const cle of ['local', ...destinations.clouds.map((c) => c.destId)]) {
      const d = dests[cle];
      if (!d || !d.ok || !d.path) continue;
      const nomPorte = d.path.slice(d.path.lastIndexOf('/') + 1);
      if (nomPorte !== l.filename) {
        douteux.push({ id: l.id, motif: `le chemin « ${cle} » porte « ${nomPorte} » mais la base dit « ${l.filename} » — état incohérent, à trancher avant tout renommage` });
      }
      revendiques.push({ dest: cle, chemin: d.path });
    }

    const entree = {
      id: l.id,
      connecteur: l.connector_id,
      action: verdict.action,
      motif: verdict.motif,
      nom: l.filename,
      cible: verdict.cible || null,
      mouvements: verdict.action === 'renommer'
        ? revendiques.map((r) => ({ dest: r.dest, de: r.chemin, vers: `${dossierDe(r.chemin)}/${verdict.cible}` }))
        : [],
      revendiques,
    };
    if (verdict.action === 'douteux') douteux.push({ id: l.id, motif: `${verdict.motif} (« ${l.filename} »)` });
    entrees.push(entree);

    const nomFinal = verdict.action === 'renommer' ? verdict.cible : l.filename;
    for (const r of revendiques) {
      const cle = `${r.dest}|${dossierDe(r.chemin)}`;
      if (!finaux.has(cle)) finaux.set(cle, new Map());
      const m = finaux.get(cle);
      if (!m.has(nomFinal)) m.set(nomFinal, []);
      m.get(nomFinal).push(l.id);
    }
  }

  const collisions = [];
  for (const [cle, m] of finaux) {
    for (const [nom, ids] of m) {
      if (ids.length > 1) collisions.push({ ou: cle, nom, ids });
    }
  }

  return { entrees, douteux, collisions };
}

// ─── Lecture d'un dossier cloud (avec cache) ──────────────────────────────────

const cacheDossiers = new Map(); // `<destId>|<dossier>` -> Set(noms de fichiers)

async function listerDossierCloud(cloud, dossier, { fraiche = false } = {}) {
  const cle = `${cloud.destId}|${dossier}`;
  if (!fraiche && cacheDossiers.has(cle)) return cacheDossiers.get(cle);
  try {
    const { stdout } = await rclone.withConfig(cloud.dest, (confFile) =>
      rclone.run(['lsf', '--files-only', dossier], { confFile, timeout: 300_000 })
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

// ─── Mouvements ───────────────────────────────────────────────────────────────

/**
 * Un mouvement, avec ses trois vérifications : avant (ancien présent, cible
 * absente), pendant (le geste), après (relecture : cible présente, ancien
 * absent). Rend `fait`, `deja` (reprise), ou arrête tout.
 */
async function executerMouvement(mouvement, destinations, { annulation = false } = {}) {
  const de = annulation ? mouvement.vers : mouvement.de;
  const vers = annulation ? mouvement.de : mouvement.vers;
  const contexte = `ligne ${mouvement.id}, destination ${mouvement.dest}\n  de   : ${de}\n  vers : ${vers}`;

  if (mouvement.dest === 'local') {
    const deLa = fs.existsSync(de);
    const versLa = fs.existsSync(vers);
    if (!deLa && versLa) return 'deja';
    if (!deLa && !versLa) arret(`fichier introuvable sous l'un comme l'autre nom — ${contexte}`);
    if (deLa && versLa) arret(`le nom cible est DÉJÀ occupé — rien n'est écrasé, jamais — ${contexte}`);
    fs.renameSync(de, vers);
    if (!fs.existsSync(vers) || fs.existsSync(de)) arret(`le renommage ne se relit pas comme attendu — ${contexte}`);
    return 'fait';
  }

  const cloud = destinations.clouds.find((c) => c.destId === mouvement.dest);
  if (!cloud) arret(`destination inconnue « ${mouvement.dest} » — ${contexte}`);
  const dossier = dossierDe(de);
  const noms = await listerDossierCloud(cloud, dossier);
  const nomDe = de.slice(de.lastIndexOf('/') + 1);
  const nomVers = vers.slice(vers.lastIndexOf('/') + 1);
  const deLa = noms.has(nomDe);
  const versLa = noms.has(nomVers);
  if (!deLa && versLa) return 'deja';
  if (!deLa && !versLa) arret(`fichier introuvable sous l'un comme l'autre nom — ${contexte}`);
  if (deLa && versLa) arret(`le nom cible est DÉJÀ occupé — rien n'est écrasé, jamais — ${contexte}`);

  await rclone.withConfig(cloud.dest, (confFile) =>
    rclone.run(['moveto', de, vers], { confFile, timeout: 300_000 })
  );
  const relu = await listerDossierCloud(cloud, dossier, { fraiche: true });
  if (!relu.has(nomVers) || relu.has(nomDe)) {
    arret(`après le mouvement, la relecture du dossier ne montre pas l'état attendu — ${contexte}`);
  }
  return 'fait';
}

// ─── Préalables de l'exécution réelle ────────────────────────────────────────

function verifierSauvegarde(dbc) {
  if (!SAUVEGARDE) {
    arret('aucune sauvegarde fournie. L\'exécution réelle exige --sauvegarde <chemin> — '
      + `copier la base À FROID (service arrêté) : cp ${config.dbFile} ${config.dbFile}.avant-renommage`);
  }
  if (!fs.existsSync(SAUVEGARDE)) arret(`la sauvegarde « ${SAUVEGARDE} » n'existe pas.`);
  if (path.resolve(SAUVEGARDE) === path.resolve(config.dbFile)) arret('la « sauvegarde » EST la base — il en faut une copie.');
  let copie;
  try {
    copie = new Database(SAUVEGARDE, { readonly: true, fileMustExist: true });
  } catch (err) {
    arret(`la sauvegarde ne s'ouvre pas comme une base SQLite (${err.message}).`);
  }
  const s = copie.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
  copie.close();
  const v = dbc.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
  if (s.c !== v.c || s.m !== v.m) {
    arret(`la sauvegarde ne correspond pas à la base vivante (sauvegarde ${s.c} lignes / max ${s.m}, base ${v.c} / ${v.m}) — refaire la copie MAINTENANT, service arrêté.`);
  }
  console.log(`Sauvegarde vérifiée : ${SAUVEGARDE} (${s.c} lignes, max_id ${s.m}).`);
}

function verifierServiceArrete() {
  const r = spawnSync('systemctl', ['is-active', '--quiet', 'crabe']);
  if (r.error) {
    console.log('systemctl indisponible ici : vérifiez vous-même que le service est arrêté avant de continuer.');
    return;
  }
  if (r.status === 0) {
    arret('le service crabe TOURNE. L\'arrêter d\'abord (systemctl stop crabe) : personne ne doit lire ou écrire pendant le chantier.');
  }
  console.log('Service crabe arrêté : personne ne lit ni n\'écrit pendant le chantier.');
}

async function verifierCloudsJoignables(destinations) {
  for (const cloud of destinations.clouds) {
    try {
      await rclone.withConfig(cloud.dest, (confFile) =>
        rclone.run(['lsf', '--dirs-only', '--max-depth', '1', rclone.adresse(cloud.dest)], { confFile, timeout: 120_000 })
      );
      console.log(`${cloud.nom} : joignable.`);
    } catch (err) {
      arret(`${cloud.nom} ne répond pas (${String(err.message).slice(0, 200)}). Toutes les destinations doivent répondre AVANT de commencer : un chantier à moitié fait sur l'une d'elles est exactement ce qu'on refuse.`);
    }
  }
}

// ─── Passe à blanc ────────────────────────────────────────────────────────────

function ecrirePlanTsv(entrees) {
  const lignes = ['id\tconnecteur\taction\tmotif\tnom actuel\tnom cible\tchemins'];
  for (const e of entrees) {
    const chemins = (e.action === 'renommer' ? e.mouvements : e.revendiques)
      .map((m) => (m.vers ? `${m.dest}: ${m.de} → ${m.vers}` : `${m.dest}: ${m.chemin}`))
      .join(' | ');
    lignes.push([e.id, e.connecteur, e.action, e.motif, e.nom, e.cible || '', chemins].join('\t'));
  }
  fs.writeFileSync(PLAN_TSV, `${lignes.join('\n')}\n`);
}

async function passeABlanc(dbc, destinations, plan) {
  const renommages = plan.entrees.filter((e) => e.action === 'renommer');
  const parAction = {};
  for (const e of plan.entrees) parAction[e.action] = (parAction[e.action] || 0) + 1;

  console.log('\n── Le plan (rien ne bouge dans cette passe) ──');
  console.log(`  ${plan.entrees.length} lignes lues, dont :`);
  for (const [a, n] of Object.entries(parAction)) console.log(`    ${String(n).padStart(4)}  ${a}`);
  console.log(`  Mouvements de fichiers : ${renommages.reduce((s, e) => s + e.mouvements.length, 0)} (sur ${destinations.clouds.length + 1} destinations).`);

  // Stockage local : chaque fichier à renommer est là, aucun nom cible n'est pris.
  let ecarts = 0;
  for (const e of renommages) {
    for (const m of e.mouvements.filter((m) => m.dest === 'local')) {
      if (!fs.existsSync(m.de)) { ecarts++; console.log(`  ÉCART stockage local : ligne ${e.id}, fichier absent : ${m.de}`); }
      else if (fs.existsSync(m.vers)) { ecarts++; console.log(`  ÉCART stockage local : ligne ${e.id}, nom cible déjà pris : ${m.vers}`); }
    }
  }
  console.log(`  Stockage local : ${ecarts === 0 ? 'chaque fichier à renommer est présent, aucun nom cible n\'est pris.' : `${ecarts} écart(s) — À RÉGLER AVANT TOUTE EXÉCUTION.`}`);

  if (SONDER) {
    for (const cloud of destinations.clouds) {
      console.log(`  ${cloud.nom} : une lecture complète (lecture seule)…`);
      try {
        const { stdout } = await rclone.withConfig(cloud.dest, (confFile) =>
          rclone.run(['lsf', '-R', '--files-only', rclone.adresse(cloud.dest)], { confFile, timeout: 600_000 })
        );
        const prefixe = `${cloud.dest.remoteName}:${cloud.dest.basePath}/`;
        const presents = new Set(stdout.split('\n').filter(Boolean).map((rel) => `${prefixe}${rel}`));
        let e2 = 0;
        for (const e of renommages) {
          for (const m of e.mouvements.filter((m) => m.dest === cloud.destId)) {
            if (!presents.has(m.de)) { e2++; console.log(`  ÉCART ${cloud.nom} : ligne ${e.id}, fichier absent : ${m.de}`); }
            else if (presents.has(m.vers)) { e2++; console.log(`  ÉCART ${cloud.nom} : ligne ${e.id}, nom cible déjà pris : ${m.vers}`); }
          }
        }
        console.log(`  ${cloud.nom} : ${presents.size} fichiers présents, ${e2 === 0 ? 'aucun écart avec le plan.' : `${e2} écart(s) — À RÉGLER AVANT TOUTE EXÉCUTION.`}`);
      } catch (err) {
        console.log(`  ${cloud.nom} : LA SONDE A ÉCHOUÉ (${String(err.message).slice(0, 200)}) — cette destination DEVRA répondre et être vérifiée avant toute exécution.`);
      }
    }
  } else {
    console.log('  Clouds : non sondés dans cette passe (ajouter --sonder-clouds pour une lecture seule).');
  }

  if (plan.douteux.length) {
    console.log(`\n  ${plan.douteux.length} CAS DOUTEUX — ils ne s'exécuteront jamais, c'est à l'administrateur de trancher :`);
    for (const d of plan.douteux) console.log(`    ligne ${d.id} : ${d.motif}`);
  }
  if (plan.collisions.length) {
    console.log(`\n  ${plan.collisions.length} COLLISION(S) — deux lignes aboutiraient au même nom :`);
    for (const c of plan.collisions) console.log(`    ${c.ou} : « ${c.nom} » pour les lignes ${c.ids.join(', ')}`);
  }

  ecrirePlanTsv(plan.entrees);
  console.log(`\nPlan complet écrit : ${PLAN_TSV}`);
  console.log('Passe à blanc terminée — RIEN n\'a été modifié. Exécution réelle : --applique --sauvegarde <chemin>.');
}

// ─── Exécution réelle ─────────────────────────────────────────────────────────

async function appliquer(dbc, destinations, plan) {
  if (plan.douteux.length || plan.collisions.length) {
    arret(`${plan.douteux.length} cas douteux et ${plan.collisions.length} collision(s) au plan — l'exécution ne démarre pas tant qu'il en reste un seul (les voir avec la passe à blanc).`);
  }
  verifierSauvegarde(dbc);
  verifierServiceArrete();
  if (!fs.existsSync(destinations.racineLocale) || !fs.readdirSync(destinations.racineLocale).length) {
    arret(`la racine du stockage local « ${destinations.racineLocale} » est absente ou vide — montage à vérifier.`);
  }
  await verifierCloudsJoignables(destinations);

  const renommages = plan.entrees
    .filter((e) => e.action === 'renommer')
    .sort((a, b) => {
      const da = a.mouvements[0]?.de || '';
      const db2 = b.mouvements[0]?.de || '';
      return da < db2 ? -1 : da > db2 ? 1 : a.id - b.id;
    });

  console.log(`\n${renommages.length} ligne(s) à renommer. Journal : ${JOURNAL}`);
  journaliser({ type: 'debut', mode: 'applique', lignes: renommages.length });

  const maj = dbc.prepare('UPDATE invoices SET filename = ?, destinations = ? WHERE id = ? AND filename = ?');
  let faites = 0;

  for (const e of renommages) {
    // L'état FRAIS de la ligne : une reprise a pu la finir à la passe d'avant.
    const ligne = dbc.prepare('SELECT filename, destinations FROM invoices WHERE id = ?').get(e.id);
    if (!ligne) arret(`la ligne ${e.id} a disparu de la base depuis le calcul du plan.`);
    if (ligne.filename === e.cible) { faites++; continue; }
    if (ligne.filename !== e.nom) arret(`la ligne ${e.id} porte « ${ligne.filename} », le plan disait « ${e.nom} » — la base a changé sous le chantier.`);

    for (const m of e.mouvements) {
      const resultat = await executerMouvement({ ...m, id: e.id }, destinations);
      journaliser({ type: 'mouvement', id: e.id, dest: m.dest, de: m.de, vers: m.vers, deja: resultat === 'deja' });
    }

    const dests = JSON.parse(ligne.destinations || '{}') || {};
    for (const m of e.mouvements) dests[m.dest] = { ...dests[m.dest], path: m.vers };
    const apresJson = JSON.stringify(dests);
    const tx = dbc.transaction(() => {
      const r = maj.run(e.cible, apresJson, e.id, e.nom);
      if (r.changes !== 1) throw new Error(`l'écriture en base n'a touché aucune ligne (id ${e.id})`);
    });
    try {
      tx();
    } catch (err) {
      arret(`${err.message} — les fichiers de cette ligne SONT renommés ; à la relance, ils seront reconnus « déjà faits » et la base se terminera.`);
    }
    journaliser({ type: 'base', id: e.id, avant: { filename: e.nom, destinations: ligne.destinations }, apres: { filename: e.cible, destinations: apresJson } });

    faites++;
    console.log(`  ligne ${e.id} (${e.connecteur}) : ${e.nom} → ${e.cible}  [${faites}/${renommages.length}]`);
    if (PANNE_APRES && faites >= PANNE_APRES) {
      journaliser({ type: 'panne-de-test', apres: faites });
      console.error(`PANNE DE TEST après ${faites} ligne(s) (CRABE_RENOMMAGE_PANNE_APRES).`);
      process.exit(97);
    }
  }

  journaliser({ type: 'fin', faites });
  console.log(`\nTerminé : ${faites}/${renommages.length} ligne(s) au nom harmonisé, base à jour.`);
}

// ─── Annulation ───────────────────────────────────────────────────────────────

async function annuler(dbc, destinations) {
  if (!fs.existsSync(JOURNAL)) arret(`aucun journal (${JOURNAL}) : rien à annuler.`);
  const entrees = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gestes = entrees.filter((x) => (x.type === 'mouvement' && !x.deja) || x.type === 'base').reverse();
  console.log(`${gestes.length} geste(s) au journal, à rejouer à l'envers.`);

  if (!APPLIQUE) {
    for (const g of gestes.slice(0, 20)) {
      if (g.type === 'base') console.log(`  base   : ligne ${g.id} — « ${g.apres.filename} » redeviendrait « ${g.avant.filename} »`);
      else console.log(`  fichier: ligne ${g.id} (${g.dest}) — ${g.vers} redeviendrait ${g.de}`);
    }
    if (gestes.length > 20) console.log(`  … et ${gestes.length - 20} autres.`);
    console.log('Passe à blanc de l\'annulation — RIEN n\'a été modifié. Pour agir : --annuler --applique --sauvegarde <chemin>.');
    return;
  }

  verifierSauvegarde(dbc);
  verifierServiceArrete();
  const maj = dbc.prepare('UPDATE invoices SET filename = ?, destinations = ? WHERE id = ? AND filename = ?');
  for (const g of gestes) {
    if (g.type === 'base') {
      const ligne = dbc.prepare('SELECT filename FROM invoices WHERE id = ?').get(g.id);
      if (ligne.filename === g.avant.filename) continue; // déjà annulée
      const r = maj.run(g.avant.filename, g.avant.destinations, g.id, g.apres.filename);
      if (r.changes !== 1) arret(`la ligne ${g.id} ne porte ni le nom d'avant ni celui d'après — état à examiner à la main.`);
      journaliser({ type: 'annulation-base', id: g.id, filename: g.avant.filename });
    } else {
      const resultat = await executerMouvement({ ...g }, destinations, { annulation: true });
      journaliser({ type: 'annulation-mouvement', id: g.id, dest: g.dest, de: g.vers, vers: g.de, deja: resultat === 'deja' });
    }
  }
  console.log('Annulation terminée : chaque geste du journal a été rejoué à l\'envers.');
}

// ─── Point d'entrée ───────────────────────────────────────────────────────────

async function principal() {
  await crypto.init();
  // En exécution réelle, la base SERVEUR s'ouvre aussi : c'est par elle que
  // `onSecretsRafraichis` range un jeton qu'rclone aurait renouvelé pendant le
  // chantier (saveConfig) — sans elle, ce relevé serait avalé en silence.
  if (APPLIQUE) require('../server/db/db').open();
  const dbc = new Database(config.dbFile, { readonly: !APPLIQUE, fileMustExist: true });
  const tete = dbc.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
  console.log(`Base : ${config.dbFile} — ${tete.c} lignes, max_id ${tete.m}.`);

  const destinations = chargerDestinations(dbc, { avecRappel: APPLIQUE });
  console.log(`Destinations actives : stockage local (${destinations.racineLocale})${destinations.clouds.map((c) => `, ${c.nom}`).join('')}.`);

  if (ANNULER) return annuler(dbc, destinations);

  const plan = construirePlan(dbc, destinations);
  if (!APPLIQUE) return passeABlanc(dbc, destinations, plan);
  return appliquer(dbc, destinations, plan);
}

principal().catch((err) => {
  console.error(`Échec : ${err.stack || err}`);
  process.exit(1);
});
