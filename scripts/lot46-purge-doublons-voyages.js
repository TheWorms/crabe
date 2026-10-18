'use strict';

/**
 * Lot 46 (22/08/2026) — les doublons SNCF Connect ET OUIGO déjà déposés.
 *
 * ─── Ce que ce script retire, et pourquoi le lot 44 ne suffisait pas ─────────
 *
 * Le 22/08/2026, un passage des deux connecteurs a redéposé HUIT documents
 * déjà en base : trois justificatifs SNCF et cinq billets OUIGO. L'empreinte
 * normalisée du lot 44 n'a pas tenu — le contenu même des fichiers change
 * d'un téléchargement à l'autre (date d'édition tamponnée dans la page pour
 * SNCF, nom de ressource aléatoire pour OUIGO), et `lot44-purge-doublons-sncf`
 * appariait sur des `remote_id` identiques, ce que des empreintes divergentes
 * ne sont jamais.
 *
 * Depuis la migration 42, l'identifiant distant est MÉTIER : le code
 * « Dossier voyage » pour SNCF Connect, la référence de réservation et le
 * passager haché pour OUIGO — lus dans le document lui-même
 * (`connectors/identite-voyage.js`). Deux lignes d'un même voyage portent
 * donc à nouveau le même `remote_id`, quels que soient leurs octets et leurs
 * tailles : c'est sur cet identifiant-là que ce script apparie.
 *
 * ─── Comment un doublon est reconnu ──────────────────────────────────────────
 *
 * Par l'identifiant MÉTIER, et par lui seul. Une ligne dont le `remote_id` n'a
 * pas la forme métier (une empreinte restée là parce que son document ne se
 * relisait pas) est DITE hors appariement et n'est jamais touchée : apparier
 * des empreintes, c'est le défaut du lot 44, pas une purge.
 *
 * Les tailles sont reportées en corroboration, mais À L'ENVERS du lot 44 :
 * elles DIFFÈRENT au sein d'une paire (124449 / 124711 octets…), et c'est
 * précisément le défaut mesuré — un rapport qui montrerait des tailles égales
 * décrirait un autre défaut que celui qu'on purge.
 *
 * Dans chaque groupe, la ligne la PLUS ANCIENNE (le plus petit `id`) reste.
 * Les suivantes partent. Garder la plus ancienne, c'est garder celle dont les
 * copies ont eu le plus de temps pour aboutir, et celle que « Mes documents »
 * montre déjà.
 *
 * ─── Ce que le script ne fait pas ────────────────────────────────────────────
 *
 * Il ne devine rien. Un fichier absent d'une destination est DIT absent et
 * n'est pas compté comme retiré. Un fichier dont le chemin manque dans la
 * ligne `invoices` est DIT sans chemin : le script ne reconstruit pas une
 * adresse par déduction — se tromper d'adresse, ici, effacerait un document
 * qui n'a rien demandé.
 *
 * Il n'efface une ligne qu'APRÈS ses fichiers, et seulement si tous ceux qui
 * étaient là sont partis. Une ligne effacée alors qu'un fichier reste laisse
 * un orphelin que plus rien ne sait retrouver ; l'inverse — un fichier parti,
 * une ligne encore là — se voit à l'écran et se rejoue.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/lot46-purge-doublons-voyages.js              # dry-run : dit tout, ne touche à rien
 *   node scripts/lot46-purge-doublons-voyages.js --appliquer  # sauvegarde, puis retire
 *
 * Le dry-run INTERROGE réellement les destinations (listage seul) : dire « ce
 * fichier serait retiré » sans avoir vérifié qu'il est là ne vaut rien.
 * Rejouable : ce qui a déjà été retiré est reconnu absent et sauté.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const RACINE = nodePath.join(__dirname, '..');
const crypto = require(nodePath.join(RACINE, 'server/crypto'));
const db = require(nodePath.join(RACINE, 'server/db/db'));
const destinations = require(nodePath.join(RACINE, 'server/destinations'));
const rclone = require(nodePath.join(RACINE, 'server/destinations/rclone'));

const APPLIQUER = process.argv.includes('--appliquer');
const CONNECTEURS = ['sncf-connect', 'ouigo'];

/**
 * La forme MÉTIER d'un identifiant, par connecteur — celle que pose la
 * migration 42. Tout le reste (les empreintes en 16 hexadécimaux) est hors
 * appariement.
 */
const FORMES_METIER = {
  'sncf-connect': /^sncf-connect-[A-Z0-9]{6}$/,
  ouigo: /^ouigo-[A-Z0-9]{6}-[0-9a-f]{8}$/,
};

/** Un chemin de destination : local (le stockage local) ou adresse rclone. */
const estCheminLocal = (p) => typeof p === 'string' && p.startsWith('/');

function horodatage() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * La configuration d'un cloud, dans la forme que rclone attend — le pilote
 * fabrique le bloc depuis les champs saisis (`normalizeConf`), et chaque
 * absence porte SA raison (les quatre cas mesurés au lot 44).
 *
 * @returns {{config: object}|{config: null, raison: string}}
 */
function configurationCloud(destId) {
  const conf = destinations.readConfig(destId);
  if (!conf) {
    return { config: null, raison: `destination ${destId} inconnue en base (aucune ligne)` };
  }
  if (destinations.configIllisible(destId)) {
    return {
      config: null,
      raison:
        `destination ${destId} : configuration présente mais INDÉCHIFFRABLE `
        + '(phrase secrète maîtresse absente ou différente de celle qui a chiffré)',
    };
  }
  const pilote = destinations.driverFor(destId);
  if (!pilote?.normalizeConf) {
    return {
      config: null,
      raison: `destination ${destId} supprimée ou sans pilote — pas de normalizeConf`,
    };
  }
  const normalise = pilote.normalizeConf(conf);
  if (!normalise?.rcloneConfig) {
    return {
      config: null,
      raison:
        `destination ${destId} : configuration déchiffrée mais sans bloc rclone `
        + `(clés lues : ${Object.keys(conf).join(', ') || 'aucune'})`,
    };
  }
  return { config: normalise };
}

/**
 * La garde d'entrée : PROUVER que les destinations se lisent, ou s'arrêter.
 * Un script qui ne sait pas lire les destinations n'a rien à dire sur leurs
 * fichiers (leçon du lot 44, règle du lot 45).
 */
function garantirDestinationsLisibles() {
  for (const id of destinations.cloudIds()) {
    if (destinations.configIllisible(id)) {
      throw new Error(`destination ${id} illisible — script interrompu`);
    }
    const { config, raison } = configurationCloud(id);
    if (!config) {
      throw new Error(`${raison} — script interrompu`);
    }
  }
}

/**
 * Le fichier est-il RÉELLEMENT là ? Listage seul, jamais d'écriture.
 * @returns {Promise<{present: boolean|null, detail: string}>}
 *   `present: null` = la destination n'a pas répondu, on ne conclut pas.
 */
async function estPresent(destId, chemin) {
  if (estCheminLocal(chemin)) {
    try {
      const stat = nodeFs.statSync(chemin);
      return { present: true, detail: `${stat.size} octets` };
    } catch {
      return { present: false, detail: 'absent du montage' };
    }
  }

  const { config, raison } = configurationCloud(destId);
  if (!config) {
    return { present: null, detail: raison };
  }
  try {
    const sortie = await rclone.withConfig(config, (confFile) =>
      rclone.run(['lsjson', '--stat', chemin], { confFile, timeout: 60_000 })
    );
    const texte = typeof sortie === 'string' ? sortie : sortie?.stdout || '';
    const vu = JSON.parse(texte || 'null');
    const entree = Array.isArray(vu) ? vu[0] : vu;
    if (!entree) return { present: false, detail: 'absent de la destination' };
    return { present: true, detail: `${entree.Size} octets` };
  } catch (err) {
    const message = `${err?.message || err}`;
    if (/not found|directory not found|object not found/i.test(message)) {
      return { present: false, detail: 'absent de la destination' };
    }
    return { present: null, detail: `la destination n'a pas répondu (${message.slice(0, 120)})` };
  }
}

/** Retire un fichier. N'est appelé qu'en mode `--appliquer`. */
async function retirer(destId, chemin) {
  if (estCheminLocal(chemin)) {
    nodeFs.rmSync(chemin);
    return;
  }
  const { config, raison } = configurationCloud(destId);
  if (!config) throw new Error(raison);
  await rclone.withConfig(config, (confFile) =>
    rclone.run(['deletefile', chemin], { confFile, timeout: 120_000 })
  );
}

(async () => {
  await crypto.init();
  db.open();
  garantirDestinationsLisibles();

  const lignes = db
    .get()
    .prepare(
      `SELECT i.id, i.user_id, i.connector_id, i.filename, i.remote_id, i.size_bytes,
              i.fetched_at, i.destinations, u.username
         FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE i.connector_id IN (${CONNECTEURS.map(() => '?').join(', ')})
        ORDER BY i.id`
    )
    .all(...CONNECTEURS);

  console.log(`\n${'='.repeat(78)}`);
  console.log(
    `Doublons de voyages (${CONNECTEURS.join(', ')}) — `
      + `${APPLIQUER ? 'APPLICATION' : 'DRY-RUN (rien ne sera touché)'}`
  );
  console.log('='.repeat(78));
  console.log(`\n${lignes.length} ligne(s) en base pour ces connecteurs.\n`);

  // ─── Les groupes : un identifiant MÉTIER, plusieurs lignes ────────────────
  const groupes = new Map();
  let horsAppariement = 0;
  for (const ligne of lignes) {
    if (!FORMES_METIER[ligne.connector_id].test(ligne.remote_id || '')) {
      horsAppariement++;
      console.log(
        `  id ${ligne.id} (${ligne.connector_id}) : identifiant non métier `
          + `(${ligne.remote_id || 'aucun'}) — hors appariement, jamais touchée.`
      );
      continue;
    }
    const cle = `${ligne.user_id}|${ligne.connector_id}|${ligne.remote_id}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(ligne);
  }
  if (horsAppariement) console.log('');

  const aRetirer = [];
  console.log('APPARIEMENT');
  console.log('-'.repeat(78));
  for (const [, membres] of groupes) {
    if (membres.length < 2) {
      const seul = membres[0];
      console.log(`  ${seul.remote_id} — 1 seule ligne (id ${seul.id}) : rien à faire.`);
      continue;
    }
    const [garde, ...doublons] = membres; // triés par id : le plus ancien d'abord
    const tailles = new Set(membres.map((m) => m.size_bytes));
    console.log(`  ${garde.remote_id}`);
    console.log(
      `    GARDÉE   id ${garde.id} — ${garde.size_bytes} octets — récupérée le ${garde.fetched_at} UTC`
    );
    for (const d of doublons) {
      console.log(
        `    RETIRÉE  id ${d.id} — ${d.size_bytes} octets — récupérée le ${d.fetched_at} UTC`
      );
      aRetirer.push({ ...d, gardee: garde });
    }
    console.log(
      `    justification : même identifiant métier, et des tailles `
        + `${tailles.size === 1
          ? `égales (${garde.size_bytes} octets)`
          : `DIFFÉRENTES (${[...tailles].join(' / ')}) — le défaut mesuré le 22/08/2026 : `
            + 'le document est regénéré, ses octets changent, son voyage non'}`
    );
  }

  if (!aRetirer.length) {
    console.log('\nAucun doublon : il n\'y a rien à retirer.\n');
    db.close?.();
    return;
  }

  // ─── La sauvegarde, avant tout geste ─────────────────────────────────────
  if (APPLIQUER) {
    const dossier = nodePath.join(RACINE, 'data', 'sauvegardes');
    nodeFs.mkdirSync(dossier, { recursive: true });
    const cible = nodePath.join(dossier, `crabe-avant-purge-doublons-${horodatage()}.db`);
    await db.get().backup(cible);
    console.log(`\nSauvegarde de la base écrite : ${cible}`);
  }

  console.log(`\n${'-'.repeat(78)}`);
  console.log(`DÉTAIL — ${aRetirer.length} ligne(s), destination par destination`);
  console.log('-'.repeat(78));

  const supprimerLigne = db.get().prepare('DELETE FROM invoices WHERE id = ?');
  let lignesRetirees = 0;
  let fichiersRetires = 0;

  for (const ligne of aRetirer) {
    console.log(`\n  Ligne id ${ligne.id} — « ${ligne.filename} »`);
    console.log(`    doublon de la ligne id ${ligne.gardee.id} (« ${ligne.gardee.filename} »)`);

    let depots = {};
    try {
      depots = JSON.parse(ligne.destinations || '{}');
    } catch {
      depots = {};
    }
    const entrees = Object.entries(depots);
    if (!entrees.length) console.log('    aucune destination consignée sur cette ligne.');

    let tousPartis = true;
    for (const [destId, depot] of entrees) {
      const chemin = depot && typeof depot.path === 'string' ? depot.path : '';
      if (!chemin) {
        console.log(`    ${destId.padEnd(16)} : aucun chemin consigné — rien ne sera touché.`);
        tousPartis = false;
        continue;
      }

      const vu = await estPresent(destId, chemin);
      const ou = estCheminLocal(chemin) ? 'montage local' : 'espace distant';
      if (vu.present === false) {
        console.log(`    ${destId.padEnd(16)} : déjà absent (${ou}) — ${chemin}`);
        continue;
      }
      if (vu.present === null) {
        console.log(`    ${destId.padEnd(16)} : INDÉCIDABLE — ${vu.detail} — ${chemin}`);
        tousPartis = false;
        continue;
      }

      if (!APPLIQUER) {
        console.log(`    ${destId.padEnd(16)} : SERAIT RETIRÉ (${ou}, ${vu.detail}) — ${chemin}`);
        continue;
      }
      try {
        await retirer(destId, chemin);
        fichiersRetires++;
        console.log(`    ${destId.padEnd(16)} : retiré (${ou}) — ${chemin}`);
      } catch (err) {
        tousPartis = false;
        console.log(`    ${destId.padEnd(16)} : ÉCHEC — ${String(err?.message || err).slice(0, 140)}`);
      }
    }

    if (!APPLIQUER) {
      console.log('    ligne : SERAIT SUPPRIMÉE de invoices (après ses fichiers).');
      continue;
    }
    if (!tousPartis) {
      console.log('    ligne : CONSERVÉE — tous ses fichiers ne sont pas partis. Rejouez le script.');
      continue;
    }
    supprimerLigne.run(ligne.id);
    lignesRetirees++;
    console.log('    ligne : supprimée de invoices.');
  }

  console.log(`\n${'='.repeat(78)}`);
  if (APPLIQUER) {
    console.log(`Terminé : ${fichiersRetires} fichier(s) retiré(s), ${lignesRetirees} ligne(s) supprimée(s).`);
  } else {
    console.log(
      `Dry-run terminé : ${aRetirer.length} ligne(s) seraient supprimées, `
        + 'aucun fichier et aucune ligne n\'ont été touchés.'
    );
    console.log('Pour appliquer : node scripts/lot46-purge-doublons-voyages.js --appliquer');
  }
  const total = db.get().prepare('SELECT COUNT(*) c, MAX(id) m FROM invoices').get();
  console.log(`État de la base : invoices count=${total.c} max_id=${total.m}`);
  console.log('='.repeat(78) + '\n');
  db.close?.();
})().catch((err) => {
  console.error('ÉCHEC :', err?.message || err);
  process.exit(1);
});
