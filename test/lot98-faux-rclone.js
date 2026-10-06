'use strict';

/**
 * Lot 98 — un faux `rclone` qui joue un cloud sur un dossier local.
 *
 * `remote:<chemin>` vit dans `<racine>/<remote>/<chemin>`. Il sait ce que le
 * dépôt et le déplacement des dossiers demandent : `copyto`, `moveto`,
 * `lsjson`, `lsf`, `rmdirs` (et `version`). Comme le vrai :
 *
 *   - `moveto` REMPLACE en silence un fichier déjà présent à la cible — c'est
 *     ce qui rend la garde « rien n'est écrasé » prouvable : sans elle, un
 *     essai voit le fichier de la cible changer ;
 *   - `moveto` crée les dossiers manquants de la cible ;
 *   - lister un dossier absent rend « directory not found » (code 3) ;
 *   - `rmdirs` ne retire que des dossiers vides, la racine comprise si elle
 *     l'est (sauf `--leave-root`).
 *
 * Chaque commande s'inscrit dans un journal (une ligne JSON) : un essai sait
 * ainsi qu'aucun `moveto` n'a été joué par un essai à blanc. Un état
 * (`panneApres`) fait échouer tout `moveto` après N réussites, pour éprouver
 * la reprise.
 *
 * À charger AVANT `./helpers` : `CRABE_RCLONE_BIN` est lu au chargement de la
 * configuration.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function installer() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot98-faux-rclone-'));
  const racine = path.join(dossier, 'clouds');
  const journal = path.join(dossier, 'journal.jsonl');
  const etat = path.join(dossier, 'etat.json');
  const bin = path.join(dossier, 'rclone');
  fs.mkdirSync(racine, { recursive: true });
  fs.writeFileSync(etat, '{}');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RACINE = ${JSON.stringify(racine)};
const JOURNAL = ${JSON.stringify(journal)};
const ETAT = ${JSON.stringify(etat)};
const ecrire = (fd, s) => { const b = Buffer.from(s); let n = 0; while (n < b.length) n += fs.writeSync(fd, b, n, b.length - n); };
const sortir = (code, message) => { if (message) ecrire(2, message + '\\n'); process.exit(code); };
let argv = process.argv.slice(2);
const i = argv.indexOf('--config');
if (i >= 0) argv = argv.filter((_, j) => j !== i && j !== i + 1);
const cmd = argv[0];
if (cmd === 'version') { ecrire(1, 'rclone v1.75.0-faux\\n'); process.exit(0); }
const options = argv.slice(1).filter((a) => a.startsWith('-'));
const args = argv.slice(1).filter((a) => !a.startsWith('-'));
fs.appendFileSync(JOURNAL, JSON.stringify({ cmd, args, options }) + '\\n');
function local(adresse) {
  const k = adresse.indexOf(':');
  if (k < 1) sortir(1, 'ERROR : adresse sans remote');
  const rel = adresse.slice(k + 1);
  if (rel.split('/').includes('..')) sortir(1, 'ERROR : remontée interdite');
  return path.join(RACINE, adresse.slice(0, k), rel);
}
function fichiers(dir, rel, recursif, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (recursif) fichiers(path.join(dir, e.name), r, recursif, out); }
    else out.push({ Path: r, Name: e.name, Size: fs.statSync(path.join(dir, e.name)).size, IsDir: false });
  }
  return out;
}
function retirerVides(dir, racine) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) retirerVides(path.join(dir, e.name), false);
  }
  if (fs.readdirSync(dir).length === 0 && !(racine && options.includes('--leave-root'))) fs.rmdirSync(dir);
}
const etat = JSON.parse(fs.readFileSync(ETAT, 'utf8'));
switch (cmd) {
  case 'copyto': {
    const d = local(args[1]);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(args[0], d);
    process.exit(0);
  }
  case 'moveto': {
    if (Number.isInteger(etat.panneApres)) {
      etat.movetoReussis = (etat.movetoReussis || 0);
      if (etat.movetoReussis >= etat.panneApres) sortir(1, 'ERROR : panne simulée du service');
    }
    const s = local(args[0]);
    const d = local(args[1]);
    if (!fs.existsSync(s)) sortir(3, 'ERROR : object not found');
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.renameSync(s, d);
    if (Number.isInteger(etat.panneApres)) {
      etat.movetoReussis++;
      fs.writeFileSync(ETAT, JSON.stringify(etat));
    }
    process.exit(0);
  }
  case 'lsjson': {
    const d = local(args[0]);
    if (!fs.existsSync(d)) sortir(3, 'ERROR : error listing: directory not found');
    ecrire(1, JSON.stringify(fichiers(d, '', options.includes('-R'), [])));
    process.exit(0);
  }
  case 'lsf': {
    const d = local(args[0]);
    if (!fs.existsSync(d)) sortir(3, 'ERROR : error listing: directory not found');
    const lignes = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !options.includes('--files-only')) lignes.push(e.name + '/');
      if (!e.isDirectory() && !options.includes('--dirs-only')) lignes.push(e.name);
    }
    ecrire(1, lignes.map((l) => l + '\\n').join(''));
    process.exit(0);
  }
  case 'rmdirs': {
    const d = local(args[0]);
    if (!fs.existsSync(d)) sortir(3, 'ERROR : directory not found');
    retirerVides(d, true);
    process.exit(0);
  }
  default:
    process.exit(0);
}
`,
    { mode: 0o755 }
  );
  process.env.CRABE_RCLONE_BIN = bin;
  return {
    bin,
    racine,
    /** Les commandes jouées depuis le début (ou depuis `depuis`). */
    commandes(depuis = 0) {
      if (!fs.existsSync(journal)) return [];
      return fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).slice(depuis).map((l) => JSON.parse(l));
    },
    etat(valeur) {
      fs.writeFileSync(etat, JSON.stringify(valeur || {}));
    },
    /** Le chemin local d'une adresse `remote:…`. */
    local(adresse) {
      const k = adresse.indexOf(':');
      return path.join(racine, adresse.slice(0, k), adresse.slice(k + 1));
    },
    nettoyer() {
      fs.rmSync(dossier, { recursive: true, force: true });
    },
  };
}

module.exports = { installer };
