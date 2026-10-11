'use strict';

/**
 * Lot 57 — la vérification après un mouvement de renommage est PATIENTE.
 *
 * Mesuré le 25/08/2026 sur pCloud, document 582 : le mouvement était FAIT,
 * mais la relecture immédiate du dossier ne le montrait pas encore — un
 * listing en retard, pas un écart — et le chantier s'est arrêté à tort, en
 * plein milieu. La règle : après un `moveto`, la relecture retente jusqu'à
 * trois fois avec un court délai ; un listing en retard se rattrape à la
 * lecture suivante, un VRAI écart reste un écart aux trois lectures et
 * arrête toujours net.
 *
 * Le faux rclone sert les listings depuis un fichier d'états : chaque `lsf`
 * consomme le prochain, le dernier se répète — c'est exactement un cache de
 * listing qui finit par rattraper la réalité (ou pas).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RACINE_FAUX = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot57-relecture-'));
const FAUX_RCLONE = path.join(RACINE_FAUX, 'rclone');
const ETATS = path.join(RACINE_FAUX, 'listings.json');

fs.writeFileSync(
  FAUX_RCLONE,
  '#!/usr/bin/env node\n'
    + 'const fs = require("node:fs");\n'
    + 'const ecrire = (s) => { const b = Buffer.from(s); let n = 0;'
    + ' while (n < b.length) n += fs.writeSync(1, b, n, b.length - n); };\n'
    + 'const argv = process.argv.slice(2);\n'
    + 'const i = argv.indexOf("--config");\n'
    + 'const args = i >= 0 ? argv.filter((_, j) => j !== i && j !== i + 1) : argv;\n'
    + 'if (args[0] === "version") { ecrire("rclone v1.75.0-faux\\n"); process.exit(0); }\n'
    + 'if (args[0] === "lsf") {\n'
    + `  const etats = JSON.parse(fs.readFileSync(${JSON.stringify(ETATS)}, "utf8"));\n`
    + '  const listing = etats.length > 1 ? etats.shift() : etats[0];\n'
    + `  fs.writeFileSync(${JSON.stringify(ETATS)}, JSON.stringify(etats));\n`
    + '  ecrire(listing.map((n) => n + "\\n").join(""));\n'
    + '  process.exit(0);\n'
    + '}\n'
    + 'if (args[0] === "moveto") { process.exit(0); }\n'
    + 'process.exit(0);\n',
  { mode: 0o755 }
);
process.env.CRABE_RCLONE_BIN = FAUX_RCLONE;
// La patience se mesure en lectures, pas en vraies secondes d'attente.
process.env.CRABE_HARMONISATION_RELECTURE_DELAI_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const harmonisation = require('../server/harmonisation');

const CLOUD = {
  destId: 'cloud-test',
  nom: 'Cloud de test',
  // `dest` est une FONCTION depuis le lot 58 : la configuration est relue à
  // chaque commande, pour qu'une session rétablie en plein chantier joue dès
  // le geste suivant. Ce double n'a pas de session — il rend la même chose.
  dest: () => ({ remoteName: 'crabe', basePath: 'crabe', rcloneConfig: 'type = local' }),
};
const CHARGEES = { clouds: [CLOUD] };

function mouvement(dossier) {
  return {
    id: 582,
    dest: 'cloud-test',
    de: `crabe:crabe/camille/${dossier}/ancien.pdf`,
    vers: `crabe:crabe/camille/${dossier}/nouveau.pdf`,
  };
}

test.before(async () => {
  await helpers.setup();
});

test.after(() => {
  fs.rmSync(RACINE_FAUX, { recursive: true, force: true });
  helpers.teardown();
});

test('un listing en retard n\'est pas un écart : la relecture suivante le rattrape', async () => {
  harmonisation.reset();
  fs.writeFileSync(ETATS, JSON.stringify([
    ['ancien.pdf'], // avant le mouvement : l'ancien est là, la cible libre
    ['ancien.pdf'], // relecture 1 : le listing n'a pas encore suivi (pCloud, 25/08/2026)
    ['nouveau.pdf'], // relecture 2 : la réalité rattrapée — le mouvement était fait
  ]));

  const verdict = await harmonisation.executerMouvement(mouvement('a'), CHARGEES);
  assert.equal(verdict, 'fait', 'le mouvement fait est reconnu fait, pas déclaré écart');
});

test('un vrai écart reste un écart : trois lectures identiques, et l\'arrêt est net', async () => {
  harmonisation.reset();
  fs.writeFileSync(ETATS, JSON.stringify([
    ['ancien.pdf'], // avant le mouvement
    ['ancien.pdf'], // le fichier ne bouge jamais : le mouvement a réellement échoué
  ]));

  await assert.rejects(
    () => harmonisation.executerMouvement(mouvement('b'), CHARGEES),
    (err) => err.arretImmediat === true && /la relecture du dossier ne montre pas l'état attendu/.test(err.message),
    'après les relectures, l\'écart arrête net — la patience n\'est pas une indulgence'
  );
});
