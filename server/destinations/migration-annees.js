'use strict';

/**
 * Migration des documents déjà déposés vers l'arborescence par année.
 *
 * ─── Ce qu'elle corrige ──────────────────────────────────────────────────────
 *
 * Avant le lot 10, un document atterrissait à plat dans le dossier de son
 * compte :
 *
 *   camille/Free Internet/fbx22222222/2026-08_1111111111.pdf
 *
 * Il vit désormais sous son année (voir destinations/paths.js) :
 *
 *   camille/Free Internet/fbx22222222/2026/2026-08_1111111111.pdf
 *
 * ─── Les cinq précautions, dans l'ordre où elles comptent ────────────────────
 *
 *   1. **la base d'abord.** Le chemin enregistré dans `invoices.destinations`
 *      est mis à jour AVANT le déplacement, et restauré si celui-ci échoue.
 *      Sans cela, crabe croirait les documents disparus et les
 *      retéléchargerait — ce qui, sur un compte Amazon de quinze années, veut
 *      dire une demi-heure de sollicitation du site pour rien ;
 *   2. **déplacement, jamais copie.** `rename` sur le même volume, repli
 *      copie-puis-efface si le partage refuse le lien (EXDEV). Aucun doublon
 *      n'est créé : le nombre de fichiers sur le stockage local ne change pas ;
 *   3. **idempotence.** Un document déjà rangé est laissé tel quel et compté
 *      « ignoré ». La migration peut être rejouée autant de fois qu'on veut ;
 *   4. **destination injoignable → on ne touche à rien.** Partage non monté,
 *      racine absente, écriture refusée : on journalise, on ne marque pas la
 *      migration comme faite, et on réessaie au prochain démarrage. Surtout pas
 *      d'échec partiel silencieux ;
 *   5. **compte rendu.** Combien déplacés, combien ignorés, combien en erreur,
 *      dans les journaux d'administration.
 *
 * ─── Deux passes, parce que la base ne sait pas tout ─────────────────────────
 *
 * La première passe suit les lignes de `invoices` : c'est elle qui garde la
 * base et le disque d'accord. La seconde balaie l'arborescence à la recherche
 * de fichiers restés à plat sans ligne correspondante — un document déposé par
 * une version antérieure puis effacé de la base, une facture copiée à la main.
 * Les laisser serait pire que tout : ils seraient les seuls à ne pas être
 * rangés, et personne ne saurait pourquoi.
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('../db/db');
const applog = require('../applog');
const paths = require('./paths');
const local = require('./local');

/** Clé de la marque en base : une seule migration d'arborescence à ce jour. */
const CLE = 'arborescence-annee';

/** Profondeur d'un fichier resté à plat, sous la racine du stockage local. */
const PROFONDEUR_A_PLAT = 4; // <utilisateur>/<connecteur>/<compte>/<fichier>

// ---------------------------------------------------------------------------
// Marque en base
// ---------------------------------------------------------------------------

/** La migration a-t-elle déjà abouti ? */
function estFaite(database = db.get()) {
  try {
    return !!database
      .prepare('SELECT key FROM storage_migrations WHERE key = ? AND done_at IS NOT NULL')
      .get(CLE);
  } catch {
    // Table absente (base d'une version antérieure au lot 10) : rien n'a été
    // fait, et la migration de schéma la créera avant qu'on repasse ici.
    return false;
  }
}

/** Enregistre le compte rendu, et interdit une nouvelle exécution. */
function marquer(bilan, database = db.get()) {
  database
    .prepare(
      `INSERT INTO storage_migrations (key, done_at, moved, skipped, failed, details)
       VALUES (?, datetime('now'), ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         done_at = datetime('now'),
         moved   = excluded.moved,
         skipped = excluded.skipped,
         failed  = excluded.failed,
         details = excluded.details`
    )
    .run(CLE, bilan.moved, bilan.skipped, bilan.failed, resume(bilan));
}

/** Une phrase de compte rendu, la même dans les journaux et en base. */
function resume(bilan) {
  return (
    `${bilan.moved} fichier(s) déplacé(s), ${bilan.skipped} ignoré(s), `
    + `${bilan.failed} en erreur`
    + (bilan.orphans ? ` — dont ${bilan.orphans} sans ligne en base` : '')
  );
}

// ---------------------------------------------------------------------------
// Déplacement
// ---------------------------------------------------------------------------

/**
 * Déplace un fichier, jamais ne le copie en laissant l'original.
 *
 * `rename` est atomique sur un même volume, ce qui est le cas ici : la source
 * et la cible ne diffèrent que d'un niveau de dossier. Le repli copie-puis-
 * efface ne sert qu'aux montages exotiques qui refusent le lien (EXDEV), et il
 * n'efface la source qu'une fois la copie écrite.
 *
 * @throws si le déplacement n'aboutit pas
 */
function deplacer(source, cible) {
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  try {
    fs.renameSync(source, cible);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(source, cible);
    fs.unlinkSync(source);
  }
}

/** Le fichier existe-t-il ? (une racine illisible ne doit pas lever) */
function existe(chemin) {
  try {
    return !!chemin && fs.existsSync(chemin);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Passe 1 — les lignes de `invoices`
// ---------------------------------------------------------------------------

/**
 * Met à jour le chemin du stockage local enregistré sur une facture.
 * @returns {string} l'ancienne valeur de la colonne, pour pouvoir la restaurer
 */
function ecrireChemin(database, invoiceId, brut, cible) {
  let objet;
  try {
    objet = JSON.parse(brut || '{}');
  } catch {
    objet = {};
  }
  if (!objet || typeof objet !== 'object' || Array.isArray(objet)) objet = {};

  // On ne fabrique pas un état de réussite qui n'a pas eu lieu : si le stockage local
  // n'a jamais rien enregistré pour cette facture, on ne fait que poser le
  // chemin, sans toucher à `state`.
  objet.local = { ...(objet.local || {}), path: cible };

  database
    .prepare('UPDATE invoices SET destinations = ? WHERE id = ?')
    .run(JSON.stringify(objet), invoiceId);

  return brut;
}

/**
 * Range les documents connus de la base.
 * @param {string} root racine du stockage local
 * @param {Set<string>} vus chemins déjà traités, pour ne pas les reprendre
 */
function passeBase(root, vus) {
  const database = db.get();
  const bilan = { moved: 0, skipped: 0, failed: 0 };

  const lignes = database
    .prepare(
      `SELECT i.id, i.connector_id, i.account_id, i.filename, i.issued_on, i.destinations,
              u.username
         FROM invoices i JOIN users u ON u.id = i.user_id
        ORDER BY i.id`
    )
    .all();

  for (const ligne of lignes) {
    const parts = {
      username: ligne.username,
      connectorName: nomConnecteur(ligne.connector_id),
      accountId: ligne.account_id,
      issuedOn: ligne.issued_on,
      filename: ligne.filename,
    };

    const cible = local.targetPath(root, parts);
    const ancien = local.legacyTargetPath(root, parts);

    let enregistre = null;
    try {
      const brut = JSON.parse(ligne.destinations || '{}')?.local?.path;
      if (brut && paths.isInside(root, brut)) enregistre = brut;
    } catch {
      /* colonne illisible : les chemins reconstruits suffisent */
    }

    vus.add(cible);
    if (enregistre) vus.add(enregistre);
    vus.add(ancien);

    // Déjà rangé : on remet seulement la base d'aplomb si son chemin a vieilli.
    if (existe(cible)) {
      if (enregistre !== cible) ecrireChemin(database, ligne.id, ligne.destinations, cible);
      bilan.skipped++;
      continue;
    }

    const source = [enregistre, ancien].find((c) => c && c !== cible && existe(c));
    if (!source) {
      // Ni à sa place, ni là où il était : il n'y a rien à déplacer. Ce n'est
      // pas une erreur de migration — le fichier a disparu avant elle.
      bilan.skipped++;
      continue;
    }

    // La base d'abord, et restaurée si le déplacement échoue.
    const avant = ecrireChemin(database, ligne.id, ligne.destinations, cible);
    try {
      deplacer(source, cible);
      bilan.moved++;
    } catch (err) {
      database
        .prepare('UPDATE invoices SET destinations = ? WHERE id = ?')
        .run(avant, ligne.id);
      bilan.failed++;
      applog.error(
        'migrations',
        `Arborescence par année : ${source} n'a pas pu être déplacé vers ${cible} — ${err.message}`
      );
    }
  }

  return bilan;
}

/** Nom lisible d'un connecteur, ou son identifiant s'il a quitté le disque. */
function nomConnecteur(connectorId) {
  try {
    return require('../connectors/registry').manifest(connectorId).name;
  } catch {
    return connectorId;
  }
}

// ---------------------------------------------------------------------------
// Passe 2 — les fichiers restés à plat, sans ligne en base
// ---------------------------------------------------------------------------

/**
 * Les fichiers situés exactement à `<racine>/<user>/<connecteur>/<compte>/`.
 *
 * Un fichier plus profond est déjà dans un dossier d'année : on n'y touche pas.
 * Un fichier moins profond n'appartient pas à l'arborescence des documents (une
 * sonde d'écriture, un `.DS_Store`) : on n'y touche pas non plus.
 */
function fichiersAPlat(root) {
  const trouves = [];

  const descendre = (dossier, profondeur) => {
    let entrees;
    try {
      entrees = fs.readdirSync(dossier, { withFileTypes: true });
    } catch {
      return; // dossier illisible : il sera signalé par le contrôle de racine
    }
    for (const entree of entrees) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) {
        if (profondeur < PROFONDEUR_A_PLAT - 1) descendre(complet, profondeur + 1);
        continue;
      }
      if (profondeur === PROFONDEUR_A_PLAT - 1 && !entree.name.startsWith('.')) {
        trouves.push(complet);
      }
    }
  };

  descendre(root, 0);
  return trouves;
}

/** Range les fichiers restés à plat que la base ne connaît pas. */
function passeOrphelins(root, vus) {
  const bilan = { moved: 0, skipped: 0, failed: 0, orphans: 0 };

  for (const source of fichiersAPlat(root)) {
    if (vus.has(source)) continue; // déjà traité (ou tenté) par la passe 1

    const annee = paths.normalizeYear(paths.yearFor({ filename: path.basename(source) }));
    const cible = path.join(path.dirname(source), annee, path.basename(source));

    if (existe(cible)) {
      // Un homonyme est déjà rangé : on ne l'écrase pas, et on ne perd pas non
      // plus l'original — il reste à plat et la ligne de journal le dit.
      bilan.skipped++;
      applog.warn(
        'migrations',
        `Arborescence par année : ${source} laissé en place, un fichier du même nom existe déjà dans ${cible}.`
      );
      continue;
    }

    try {
      deplacer(source, cible);
      bilan.moved++;
      bilan.orphans++;
    } catch (err) {
      bilan.failed++;
      applog.error(
        'migrations',
        `Arborescence par année : ${source} n'a pas pu être déplacé vers ${cible} — ${err.message}`
      );
    }
  }

  return bilan;
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * Range TOUS les documents sous leur année.
 *
 * @param {{root?: string, force?: boolean}} [options]
 *   `root` force la racine (tests) ; `force` rejoue même si la marque est posée.
 * @returns {{ok: boolean, ran: boolean, moved: number, skipped: number,
 *            failed: number, orphans: number, message: string}}
 */
function migrer({ root = null, force = false } = {}) {
  if (!force && estFaite()) {
    return { ok: true, ran: false, moved: 0, skipped: 0, failed: 0, orphans: 0, message: 'déjà faite' };
  }

  const conf = root
    ? { path: root, protocol: 'local' }
    : require('./index').readConfig('local');
  const racine = conf?.path;

  // Destination injoignable : on ne migre RIEN, on ne marque RIEN, et on
  // réessaiera au prochain démarrage. Un demi-déplacement serait pire que pas
  // de déplacement du tout.
  const etat = local.quickState(conf);
  if (!racine || etat !== 'ok') {
    const message =
      `Arborescence par année : rien n'a été déplacé — la destination locale n'est pas `
      + `exploitable (${racine ? `${racine}, état « ${etat} »` : 'aucun chemin configuré'}). `
      + 'Nouvelle tentative au prochain démarrage du service.';
    applog.warn('migrations', message);
    return { ok: false, ran: false, moved: 0, skipped: 0, failed: 0, orphans: 0, message };
  }

  const vus = new Set();
  const base = passeBase(racine, vus);
  const orphelins = passeOrphelins(racine, vus);

  const bilan = {
    moved: base.moved + orphelins.moved,
    skipped: base.skipped + orphelins.skipped,
    failed: base.failed + orphelins.failed,
    orphans: orphelins.orphans,
  };

  // La marque n'est posée QUE si tout est passé : un échec laisse la migration
  // à refaire, plutôt que de la déclarer faite à moitié.
  if (!bilan.failed) marquer(bilan);

  const message = `Arborescence par année : ${resume(bilan)}.`;
  applog[bilan.failed ? 'error' : 'info'](
    'migrations',
    bilan.failed
      ? `${message} La migration sera retentée au prochain démarrage.`
      : message
  );

  return { ok: !bilan.failed, ran: true, ...bilan, message };
}

module.exports = { CLE, migrer, estFaite, marquer, resume, fichiersAPlat, deplacer };
