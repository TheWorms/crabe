'use strict';

/**
 * Destination « Stockage local » — la copie de référence, quand elle est active
 * (« au moins une destination active » a remplacé « le stockage local obligatoire »
 * au lot 38).
 *
 * Écriture sur un chemin de système de fichiers local. Le partage SMB ou NFS
 * est monté par l'hôte (fstab / systemd.mount) : crabe ne monte rien lui-même,
 * il écrit dans le point de montage. Le champ `protocol` est déclaratif, il
 * documente ce qu'il y a derrière le chemin.
 *
 * Arborescence :
 *   <racine>/<utilisateur>/<Nom du connecteur>/<compte>/<année>/<fichier>
 * La racine est déjà un emplacement dédié à crabe côté serveur de
 * fichiers : aucun dossier « crabe » ni « invoices » n'est ajouté ici.
 *
 * Un montage NFS en all_squash donne le même compte Unix à tous les
 * fichiers. L'isolation entre utilisateurs de crabe
 * est donc APPLICATIVE (voir routes/connectors.js), elle ne peut pas reposer
 * sur les permissions du système de fichiers.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const paths = require('./paths');

const ID = 'local';
const NAME = 'Stockage local';

/** Neutralise tout ce qui pourrait faire sortir du répertoire de destination. */
const safeSegment = paths.safeSegment;

/**
 * <racine>/<utilisateur>/<Nom du connecteur>/<compte>/<année>/<fichier>
 *
 * Forme objet depuis le lot 10 : six segments positionnels dont un facultatif
 * au milieu, personne ne les compte juste.
 *
 * @param {string} root
 * @param {{username: string, connectorName: string, accountId?: string,
 *          year?: string|number, issuedOn?: string, filename: string}} parts
 */
function targetPath(root, parts) {
  return paths.localPath(root, parts);
}

/** Le même chemin sans niveau d'année — l'arborescence d'avant le lot 10. */
function legacyTargetPath(root, parts) {
  return paths.legacyLocalPath(root, parts);
}

/**
 * Le chemin est-il un point de montage, ou un simple dossier ?
 *
 * On compare l'identifiant de périphérique avec celui du parent — c'est ce que
 * fait `mountpoint(1)`, sans dépendre du binaire ni de /proc/mounts.
 */
function isMountPoint(target) {
  if (!target) return false;
  try {
    const resolved = path.resolve(target);
    const here = fs.statSync(resolved);
    const parent = fs.statSync(path.dirname(resolved));
    return here.dev !== parent.dev;
  } catch {
    return false;
  }
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * État résumé de la racine, SANS effet de bord : ni création de dossier, ni
 * sonde d'écriture. C'est ce qui alimente les pastilles des pages Stockage et
 * Système, appelées à chaque affichage ; le diagnostic complet reste derrière
 * le bouton « Tester la connexion ».
 *
 * @returns {'unset'|'missing'|'not-directory'|'not-mounted'|'read-only'|'ok'}
 */
function quickState(conf) {
  const target = conf?.path;
  if (!target) return 'unset';

  const stats = statOrNull(target);
  if (!stats) return 'missing';
  if (!stats.isDirectory()) return 'not-directory';

  const protocol = (conf.protocol || 'local').toLowerCase();
  if ((protocol === 'smb' || protocol === 'nfs') && !isMountPoint(target)) return 'not-mounted';

  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return 'read-only';
  }
  return 'ok';
}

/**
 * Diagnostic détaillé de la racine du stockage local.
 *
 * Un « écriture impossible » générique n'aide personne : les quatre situations
 * qui se produisent réellement demandent quatre gestes différents.
 *
 * @param {{path?: string, protocol?: string}} conf
 * @returns {Promise<{ok: boolean, state: string, message: string,
 *                    path: string, protocol: string, mounted: boolean}>}
 *   state ∈ 'unset' | 'missing' | 'not-directory' | 'not-mounted' |
 *           'read-only' | 'ok'
 */
async function diagnose(conf) {
  const root = conf?.path || '';
  const protocol = (conf?.protocol || 'local').toLowerCase();
  // Un partage réseau est monté par l'hôte : crabe ne doit ni le créer, ni
  // faire semblant que le dossier local sous-jacent fait l'affaire.
  const networkShare = protocol === 'smb' || protocol === 'nfs';
  const base = { path: root, protocol, mounted: false };

  if (!root) {
    return {
      ...base,
      ok: false,
      state: 'unset',
      message:
        'Aucun chemin configuré pour le stockage local — renseignez le point de montage ' +
        '(par défaut /mnt/local) puis enregistrez.',
    };
  }

  let stats = statOrNull(root);

  // Dossier local absent : le créer est légitime (c'est crabe qui le possède).
  if (!stats && !networkShare) {
    try {
      await fsp.mkdir(root, { recursive: true });
      stats = statOrNull(root);
    } catch {
      /* on tombe dans le diagnostic « missing » ci-dessous */
    }
  }

  if (!stats) {
    return {
      ...base,
      ok: false,
      state: 'missing',
      message: networkShare
        ? `${root} n'existe pas : le partage ${protocol.toUpperCase()} n'est pas monté. ` +
          'Le montage est à la charge de l\'hôte (fstab ou systemd.mount), crabe ne monte rien.'
        : `${root} n'existe pas et n'a pas pu être créé. Créez-le puis donnez-le à crabe : ` +
          `sudo install -d -o crabe -g crabe ${root} — et vérifiez que le chemin est bien ` +
          'listé en ReadWritePaths dans l\'unité systemd.',
    };
  }

  if (!stats.isDirectory()) {
    return {
      ...base,
      ok: false,
      state: 'not-directory',
      message: `${root} existe mais n'est pas un dossier : corrigez le chemin de destination.`,
    };
  }

  const mounted = isMountPoint(root);

  if (networkShare && !mounted) {
    return {
      ...base,
      mounted,
      ok: false,
      state: 'not-mounted',
      message:
        `${root} est un dossier ordinaire, pas un point de montage, alors que le protocole ` +
        `déclaré est ${protocol.toUpperCase()} : le partage n'est pas monté et les factures ` +
        'seraient écrites sur le disque local du conteneur. Montez le partage (fstab ou ' +
        'systemd.mount) avant d\'utiliser cette destination.',
    };
  }

  const probe = path.join(root, '.crabe-write-test');
  try {
    await fsp.writeFile(probe, `crabe write test ${new Date().toISOString()}\n`);
    await fsp.unlink(probe);
  } catch (err) {
    return {
      ...base,
      mounted,
      ok: false,
      state: 'read-only',
      message: mounted
        ? `${root} est bien monté mais refuse l'écriture (${err.code || err.message}) : ` +
          'vérifiez les droits côté serveur de fichiers (uid/gid exporté, all_squash, ' +
          'export en lecture seule).'
        : `Écriture refusée dans ${root} (${err.code || err.message}) : vérifiez le ` +
          `propriétaire du dossier (chown crabe:crabe ${root}) et la présence de ce chemin ` +
          'en ReadWritePaths dans l\'unité systemd.',
    };
  }

  return {
    ...base,
    mounted,
    ok: true,
    state: 'ok',
    message:
      `Le stockage local accessible en écriture — ${root} (${protocol}, ` +
      `${mounted ? 'point de montage' : 'dossier local'})`,
  };
}

/**
 * Vérifie que la racine existe et est accessible en écriture.
 * @param {{path: string, protocol?: string}} conf
 */
async function test(conf) {
  return diagnose(conf);
}

/**
 * Dépose une facture.
 * @returns {Promise<{ok: boolean, path?: string, message?: string}>}
 */
async function store(conf, { username, connectorName, accountId, year, issuedOn, filename, buffer, sousChemin, cheminRelatif }) {
  const root = conf?.path;
  if (!root) return { ok: false, message: 'Stockage local non configuré.' };

  // Une REPRISE passe le chemin réel de la copie de référence, qui prime sur
  // le calcul — mais jamais au point de sortir de la racine.
  const repris = cheminRelatif ? path.join(root, cheminRelatif) : null;
  const dest = repris && paths.isInside(root, repris)
    ? repris
    : targetPath(root, { username, connectorName, accountId, year, issuedOn, filename, sousChemin });
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buffer);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, message: `Écriture de ${dest} impossible : ${err.message}` };
  }
}

/** Supprime tous les fichiers d'un utilisateur (purge RGPD). */
async function purgeUser(conf, username) {
  const root = conf?.path;
  if (!root) return { ok: false, removed: 0 };
  const dir = path.join(root, safeSegment(username));
  if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
  const before = countFiles(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true, removed: before };
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

module.exports = {
  ID,
  NAME,
  test,
  diagnose,
  quickState,
  isMountPoint,
  store,
  purgeUser,
  targetPath,
  legacyTargetPath,
  safeSegment,
};
