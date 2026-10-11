'use strict';

/**
 * État de l'archive Impots — LECTURE SEULE (lot 88).
 *
 * Donne, sans jamais afficher un titre ni un nom de fichier :
 *   - le nombre de lignes `impots` et le MAX(id) de la table (à relever deux
 *     fois, protocole WAL, pour s'assurer que rien ne bouge pendant la mesure) ;
 *   - les groupes de titres identiques (même année, même titre), désignés par
 *     une empreinte courte de l'ancre nue — jamais par le titre ;
 *   - les rangs présents, et les noms qui seraient portés par plusieurs lignes ;
 *   - pour chaque ligne : la taille du fichier sur le stockage local comparée à
 *     la base, et sa date de modification.
 *
 * Usage : `node scripts/lot88-etat-archive-impots.js`, lancé depuis le dossier
 * d'installation, avec l'utilisateur et l'environnement du service (la clé de
 * chiffrement n'est pas nécessaire : tout est en lecture seule, rien n'est
 * déchiffré).
 *
 * Il sert à l'essai réel du lot 88 : une passe AVANT (55 lignes, aucun groupe à
 * plusieurs lignes, les 8 fichiers de groupe avec leur date), une passe APRÈS
 * (69 lignes attendues, 8 groupes à 4, 2, 3, 2, 5, 2, 2, 2 lignes, les 8
 * fichiers d'origine à la MÊME date qu'avant).
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { config } = require('../server/config');

const db = new Database(config.dbFile, { readonly: true });

const total = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM invoices').get();
console.log(`invoices : COUNT=${total.n}, MAX(id)=${total.m}`);

const lignes = db
  .prepare(
    `SELECT id, remote_id, filename, size_bytes, issued_on, fetched_at, destinations
       FROM invoices WHERE connector_id = 'impots' ORDER BY id`
  )
  .all();
console.log(`impots : ${lignes.length} ligne(s)`);

/** L'ancre nue (sans rang) et le rang d'une ligne, depuis son `remote_id`. */
function decomposerAncre(remoteId) {
  const texte = String(remoteId || '');
  const avecRang = /^(.*)#(\d+)$/.exec(texte);
  // L'ancre nue contient déjà un « # » (AAAA#titre) : un rang est un SECOND
  // niveau de « #<chiffres> » en queue.
  if (avecRang && avecRang[1].includes('#')) {
    return { base: avecRang[1], rang: Number(avecRang[2]) };
  }
  return { base: texte, rang: null };
}

/** Une empreinte courte, muette sur le titre qu'elle recouvre. */
function empreinte(base) {
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
}

// ─── Groupes (même année, même titre) ───────────────────────────────────────
const groupes = new Map();
for (const l of lignes) {
  const { base, rang } = decomposerAncre(l.remote_id);
  if (!groupes.has(base)) groupes.set(base, []);
  groupes.get(base).push({ id: l.id, rang });
}
const multiples = [...groupes.entries()].filter(
  ([, membres]) => membres.length > 1 || membres.some((m) => m.rang !== null)
);
if (!multiples.length) {
  console.log('groupes : aucun groupe à plusieurs lignes ni à rang');
} else {
  console.log(`groupes à plusieurs lignes ou à rang : ${multiples.length}`);
  for (const [base, membres] of multiples) {
    const annee = (/^(\d{4})#/.exec(base) || [])[1] || '????';
    const rangs = membres.map((m) => (m.rang === null ? 'nue' : `#${m.rang}`)).join(', ');
    const ids = membres.map((m) => m.id).join(', ');
    console.log(`  ${annee} ${empreinte(base)} : ${membres.length} ligne(s) — ancres [${rangs}] — lignes ${ids}`);
  }
}

// ─── Noms portés par plusieurs lignes ───────────────────────────────────────
const parNom = new Map();
for (const l of lignes) {
  if (!parNom.has(l.filename)) parNom.set(l.filename, []);
  parNom.get(l.filename).push(l.id);
}
const nomsDoubles = [...parNom.values()].filter((ids) => ids.length > 1);
if (!nomsDoubles.length) {
  console.log('noms : aucun nom porté par plusieurs lignes');
} else {
  for (const ids of nomsDoubles) {
    console.log(`  ⚠ un même nom est porté par les lignes ${ids.join(', ')}`);
  }
}

// ─── Fichiers sur le stockage local ─────────────────────────────────────────
console.log('lignes (id, année, empreinte, rang, taille base / fichier local, modifié le) :');
for (const l of lignes) {
  const { base, rang } = decomposerAncre(l.remote_id);
  const annee = (/^(\d{4})#/.exec(base) || [])[1] || '????';
  let etatFichier = 'aucun chemin local noté';
  try {
    const dests = JSON.parse(l.destinations || '{}');
    const locale = Object.values(dests).find((d) => d && d.path && fs.existsSync(d.path));
    if (locale) {
      const st = fs.statSync(locale.path);
      const verdict = st.size === l.size_bytes ? 'ÉGAL' : `DIFFÉRENT (${st.size} o)`;
      etatFichier = `${verdict}, modifié ${st.mtime.toISOString()}`;
    }
  } catch (err) {
    etatFichier = `illisible (${err.code || err.message})`;
  }
  console.log(
    `  ${l.id}  ${annee}  ${empreinte(base)}  ${rang === null ? 'nue ' : `#${rang}  `}`
      + ` ${l.size_bytes} o — ${etatFichier}`
  );
}

db.close();
