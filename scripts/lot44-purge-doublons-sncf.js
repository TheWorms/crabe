'use strict';

/**
 * Lot 44 (20/08/2026) — les doublons SNCF Connect déjà déposés.
 *
 * ─── Ce que ce script retire, et pourquoi c'est un script ────────────────────
 *
 * Deux passages du connecteur, le 19/08/2026 à 23:28 et le 20/08/2026 à 00:13,
 * ont écrit **6 lignes pour 3 justificatifs**, et déposé 6 fichiers dans
 * chacune des trois destinations. La cause est corrigée (l'identifiant distant
 * ne dépend plus de la date de génération du PDF — voir
 * `connectors/empreinte-document.js`) et la migration 40 a repris les lignes
 * existantes. Mais ni un correctif ni une migration n'enlèvent ce qui a déjà
 * été déposé : trois lignes et neuf fichiers restent en trop.
 *
 * ─── Comment un doublon est reconnu ──────────────────────────────────────────
 *
 * Par son IDENTIFIANT DISTANT, pas par son nom de fichier. Depuis la migration
 * 40, deux copies d'un même justificatif portent le même `remote_id` — c'est
 * l'empreinte du document, et c'est ce qui les rend justement identiques. La
 * taille en octets est reportée en second, comme corroboration : les trois
 * paires mesurées le 20/08 s'apparient aussi bien par la taille (24950, 24935,
 * 24953) que par l'empreinte, et un rapport qui montre les deux se vérifie
 * sans avoir à faire confiance au script.
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
 *   node scripts/lot44-purge-doublons-sncf.js              # dry-run : dit tout, ne touche à rien
 *   node scripts/lot44-purge-doublons-sncf.js --appliquer  # sauvegarde, puis retire
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
const CONNECTEUR = 'sncf-connect';

/** Un chemin de destination : local (le stockage local) ou adresse rclone. */
const estChemitLocal = (p) => typeof p === 'string' && p.startsWith('/');

function horodatage() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * La configuration d'un cloud, dans la forme que rclone attend.
 *
 * ⚠ `destinations.readConfig()` NE SUFFIT PAS, et ça ne se voit pas : il rend
 * bien une clé `rcloneConfig`, mais VIDE quand la destination a été remplie par
 * son formulaire plutôt que par un bloc collé. Mesuré le 20/08/2026 sur les
 * deux clouds du CT : `rcloneConfig` présent, longueur 0 — et
 * `rclone.withConfig()` répondait « Bloc de configuration rclone manquant »,
 * ce qui ressemblait à une destination cassée alors que tout allait bien.
 * C'est le PILOTE qui sait fabriquer le bloc depuis les champs saisis
 * (`normalizeConf`), et c'est par lui que passent le dépôt et la purge RGPD.
 *
 * ⚠ Quand la configuration MANQUE, elle manque pour QUATRE raisons possibles,
 * et les confondre a coûté trois heures le 20/08/2026 : le script disait
 * « destination sans configuration rclone lisible » d'un seul bloc, sans dire
 * si la ligne était absente de la base, supprimée, indéchiffrable, ou lisible
 * mais incomplète. Chaque échec porte désormais SA raison — et le repli
 * silencieux de `tryDecryptJson` (un déchiffrement en échec qui ressemble à
 * une configuration vide) est démasqué par `configIllisible()`.
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
 *
 * Sans elle, un défaut d'environnement (phrase secrète absente, sel maître
 * étranger, base lue à un état tronqué) fait conclure « destination sans
 * configuration » alors que tout va bien en base — un résultat faux avec
 * l'air d'un résultat vrai. Vérifié AVANT tout travail : un script qui ne
 * sait pas lire les destinations n'a rien à dire sur leurs fichiers.
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
  if (estChemitLocal(chemin)) {
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
    // `--stat` rend UN objet ; sans lui, rclone rend un tableau. On accepte les
    // deux : la forme de la sortie dépend de la version installée, pas du fait.
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
  if (estChemitLocal(chemin)) {
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
      `SELECT i.id, i.user_id, i.filename, i.remote_id, i.size_bytes, i.fetched_at,
              i.destinations, u.username
         FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE i.connector_id = ?
        ORDER BY i.id`
    )
    .all(CONNECTEUR);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`Doublons ${CONNECTEUR} — ${APPLIQUER ? 'APPLICATION' : 'DRY-RUN (rien ne sera touché)'}`);
  console.log('='.repeat(78));
  console.log(`\n${lignes.length} ligne(s) ${CONNECTEUR} en base.\n`);

  // ─── Les groupes : une empreinte, plusieurs lignes ────────────────────────
  const groupes = new Map();
  for (const ligne of lignes) {
    const cle = `${ligne.user_id}|${ligne.remote_id}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(ligne);
  }

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
      `    justification : même empreinte de document (${garde.remote_id})`
        + `, et ${tailles.size === 1 ? `même taille (${garde.size_bytes} octets)` : `tailles ${[...tailles].join(' / ')}`}`
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
      const ou = estChemitLocal(chemin) ? 'montage local' : 'espace distant';
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
    console.log('Pour appliquer : node scripts/lot44-purge-doublons-sncf.js --appliquer');
  }
  const total = db.get().prepare('SELECT COUNT(*) c, MAX(id) m FROM invoices').get();
  console.log(`État de la base : invoices count=${total.c} max_id=${total.m}`);
  console.log('='.repeat(78) + '\n');
  db.close?.();
})().catch((err) => {
  console.error('ÉCHEC :', err?.message || err);
  process.exit(1);
});
