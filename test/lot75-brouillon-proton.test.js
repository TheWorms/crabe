'use strict';

/**
 * Lot 75 — le brouillon Proton Drive se remplace au SECOND essai.
 *
 * ─── L'incident mesuré du 09/09/2026 ─────────────────────────────────────────
 *
 * Un envoi vers Proton Drive interrompu laisse un « draft » côté service, et
 * chaque envoi suivant du même fichier bute dessus : « a draft exist - usually
 * this means a file is being uploaded at another client, or, there was a
 * failed upload attempt » — le même document en échec de 09:00 à 12:17, sans
 * autre issue qu'une intervention manuelle. Le binaire (v1.75.0) documente
 * `--protondrive-replace-existing-draft` : à true, le brouillon est remplacé
 * et l'envoi repart.
 *
 * Les règles vérifiées ici, sur un FAUX rclone qui joue le brouillon :
 *
 *   1. l'option n'est PAS posée au premier essai (la documentation du binaire
 *      prévient : deux clients au même endroit au même instant, « behavior is
 *      currently unknown » — on n'écrase pas en aveugle) ;
 *   2. l'échec qui porte la signature du brouillon fait rejouer l'envoi UNE
 *      fois, avec l'option — et le dépôt aboutit ;
 *   3. un AUTRE échec Proton ne déclenche aucun second essai ;
 *   4. un backend qui n'est pas Proton Drive n'est jamais concerné.
 *
 * Réintroduction du défaut : retirer le second essai d'`upload()` fait échouer
 * le test 2 — c'est exactement l'état de production du 09/09/2026.
 *
 * Toutes les valeurs sont INVENTÉES (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// L'environnement se pose AVANT tout require de server/config.js, et le faux
// rclone AVANT tout require de crabe (config.rcloneBin est lu au chargement).
const RACINE_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot75a-'));
process.env.NODE_ENV = 'test';
process.env.CRABE_DATA_DIR = path.join(RACINE_TEST, 'data');
process.env.CRABE_MASTER_PASSPHRASE = 'passphrase-de-test-lot75-0123456789';

const JOURNAL_FAUX = path.join(RACINE_TEST, 'journal-faux-rclone.log');
process.env.CRABE_FAUX_JOURNAL = JOURNAL_FAUX;

const FAUX_RCLONE = path.join(RACINE_TEST, 'rclone');

/**
 * Le faux rclone : son `copyto` répond la signature MESURÉE du brouillon tant
 * que `--protondrive-replace-existing-draft=true` n'est pas passé — sauf si la
 * cible contient « sans-brouillon » (dépôt propre) ou « autre-panne » (un
 * échec qui n'est pas un brouillon). Chaque invocation laisse une ligne au
 * journal : c'est lui qui prouve le NOMBRE d'essais et les drapeaux joués.
 */
fs.writeFileSync(
  FAUX_RCLONE,
  `#!/usr/bin/env node
const fs = require('node:fs');
let argv = process.argv.slice(2);
const i = argv.indexOf('--config');
if (i >= 0) argv = argv.filter((_, j) => j !== i && j !== i + 1);
fs.appendFileSync(process.env.CRABE_FAUX_JOURNAL, JSON.stringify(argv) + '\\n');
const cmd = argv[0];
if (cmd === 'version') { process.stdout.write('rclone v1.75.0-faux\\n'); process.exit(0); }
if (cmd === 'copyto') {
  const cible = argv[2] || '';
  if (/autre-panne/.test(cible)) {
    process.stderr.write('2026/09/09 09:00:55 ERROR : quota exceeded, insufficient storage\\n');
    process.exit(1);
  }
  if (/sans-brouillon/.test(cible) || argv.includes('--protondrive-replace-existing-draft=true')) {
    process.exit(0);
  }
  process.stderr.write(
    '2026/09/09 10:17:27 ERROR : fichier.pdf: Failed to copy: a draft exist - '
    + 'usually this means a file is being uploaded at another client, or, there '
    + 'was a failed upload attempt. Can use --protondrive-replace-existing-draft=true to override\\n'
  );
  process.exit(1);
}
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;

const rclone = require('../server/destinations/rclone');

const FICHIER_LOCAL = path.join(RACINE_TEST, 'document.pdf');
fs.writeFileSync(FICHIER_LOCAL, 'contenu invente\n');

function lireJournalFaux() {
  if (!fs.existsSync(JOURNAL_FAUX)) return [];
  return fs
    .readFileSync(JOURNAL_FAUX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test.beforeEach(() => {
  fs.rmSync(JOURNAL_FAUX, { force: true });
});

test.after(() => {
  fs.rmSync(RACINE_TEST, { recursive: true, force: true });
});

const DEST_PROTON = {
  remoteName: 'crabe',
  basePath: 'crabe',
  type: 'protondrive',
  rcloneConfig: 'type = protondrive\nusername = camille@exemple.test',
};

test('la signature du brouillon est celle du message mesuré en production', () => {
  assert.match(
    'a draft exist - usually this means a file is being uploaded at another '
      + 'client, or, there was a failed upload attempt',
    rclone.SIGNATURE_BROUILLON_PROTON
  );
  // Et pas n'importe quel échec : une panne de quota n'est pas un brouillon.
  assert.equal(rclone.SIGNATURE_BROUILLON_PROTON.test('quota exceeded'), false);
});

test('le brouillon qui bloque fait rejouer l\'envoi UNE fois, avec le remplacement — et le dépôt aboutit', async () => {
  const cible = await rclone.upload(DEST_PROTON, FICHIER_LOCAL, 'camille/Exemple/2025/doc.pdf');
  assert.equal(cible, 'crabe:crabe/camille/Exemple/2025/doc.pdf');

  const copies = lireJournalFaux().filter((argv) => argv[0] === 'copyto');
  assert.equal(copies.length, 2, 'deux essais : le premier nu, le second avec le remplacement');
  assert.equal(
    copies[0].includes('--protondrive-replace-existing-draft=true'),
    false,
    'le PREMIER essai n\'écrase jamais en aveugle : à cet instant, un autre client '
      + 'envoie peut-être vraiment, et le binaire annonce un comportement inconnu'
  );
  assert.ok(
    copies[1].includes('--protondrive-replace-existing-draft=true'),
    'le second essai remplace le brouillon — à ce moment-là, le blocage est un fait mesuré'
  );
});

test('un dépôt propre ne joue JAMAIS l\'option : un seul essai, sans drapeau', async () => {
  await rclone.upload(DEST_PROTON, FICHIER_LOCAL, 'camille/Exemple/2025/sans-brouillon.pdf');
  const copies = lireJournalFaux().filter((argv) => argv[0] === 'copyto');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].some((a) => a.includes('replace-existing-draft')), false);
});

test('un AUTRE échec Proton ne déclenche pas de second essai : le remplacement ne répond qu\'au brouillon', async () => {
  await assert.rejects(
    () => rclone.upload(DEST_PROTON, FICHIER_LOCAL, 'camille/Exemple/2025/autre-panne.pdf'),
    /quota/i
  );
  assert.equal(lireJournalFaux().filter((argv) => argv[0] === 'copyto').length, 1);
});

test('un backend qui n\'est pas Proton Drive n\'est jamais concerné, même sur la signature', async () => {
  const destWebdav = {
    remoteName: 'crabe',
    basePath: 'crabe',
    type: 'webdav',
    rcloneConfig: 'type = webdav\nurl = https://serveur.exemple.test/dav',
  };
  await assert.rejects(
    () => rclone.upload(destWebdav, FICHIER_LOCAL, 'camille/Exemple/2025/doc.pdf'),
    /a draft exist/
  );
  assert.equal(
    lireJournalFaux().filter((argv) => argv[0] === 'copyto').length,
    1,
    'l\'option est un réglage du backend protondrive : la passer à un autre backend '
      + 'serait un argument inconnu, jamais un remède'
  );
});
