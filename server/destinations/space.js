'use strict';

/**
 * Espace disponible sur une destination.
 *
 * « Il reste 512 Go » est l'information la plus utile de la carte d'une
 * destination — bien plus que « 0,58 Mo utilisés ». Elle est donc mesurée pour
 * de vrai :
 *
 *   - Le stockage local : `statfs(2)` sur le point de montage. C'est bien l'espace du
 *     partage NFS, pas celui du disque du conteneur.
 *   - Proton Drive / pCloud : `rclone about --json`, qui renvoie le quota du
 *     compte.
 *
 * **Ce second chemin n'a jamais été exécuté en production** : ni Proton ni
 * pCloud n'ont jamais été configurés. Il doit donc échouer proprement — une
 * mesure indisponible renvoie `{ known: false, reason }`, jamais un zéro qui
 * ferait croire à un disque plein, jamais une exception qui casserait
 * l'accueil.
 */

const fsp = require('node:fs/promises');
const rclone = require('./rclone');

/** Résultat quand la mesure n'a pas pu être faite. */
function unknown(reason) {
  return { known: false, totalBytes: null, freeBytes: null, usedBytes: null, reason };
}

/**
 * Espace du système de fichiers portant un chemin.
 * @param {string} target
 */
async function localSpace(target) {
  if (!target) return unknown('Aucun chemin configuré.');
  if (typeof fsp.statfs !== 'function') {
    return unknown('statfs indisponible sur cette version de Node.');
  }
  try {
    const stats = await fsp.statfs(target);
    const block = Number(stats.bsize) || 0;
    const total = block * Number(stats.blocks || 0);
    // `bavail` : blocs libres pour un utilisateur non privilégié — c'est ce
    // qui reste réellement utilisable, `bfree` inclut la réserve root.
    const free = block * Number(stats.bavail || 0);
    if (!total) return unknown('Système de fichiers sans taille exploitable.');
    return { known: true, totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch (err) {
    return unknown(`Mesure impossible (${err.code || err.message}).`);
  }
}

/**
 * Quota d'un remote rclone, via `rclone about --json`.
 * @param {{remoteName: string, basePath?: string, rcloneConfig?: string}} conf
 */
async function remoteSpace(conf) {
  // Depuis le 24/08/2026, l'appelant passe la configuration NORMALISÉE : ce
  // motif ne se voit donc plus que pour un espace VRAIMENT sans configuration,
  // et la phrase peut le dire sans accuser à tort.
  if (!conf?.rcloneConfig) {
    return unknown('La configuration de cet espace n\'a pas encore été enregistrée.');
  }
  if (!(await rclone.isAvailable())) {
    return unknown('L\'outil de copie (rclone) n\'est pas installé sur le serveur.');
  }

  try {
    return await rclone.withConfig(conf, async (confFile) => {
      const { stdout } = await rclone.run(['about', `${conf.remoteName}:`, '--json'], {
        confFile,
        timeout: 30_000,
      });
      const parsed = JSON.parse(stdout);
      const total = Number(parsed.total);
      const free = Number(parsed.free);
      const used = Number(parsed.used);

      if (!Number.isFinite(total) || total <= 0) {
        // Certains backends ne publient pas de quota : c'est un cas normal,
        // pas une panne.
        return unknown('Ce remote ne publie pas de quota.');
      }
      return {
        known: true,
        totalBytes: total,
        freeBytes: Number.isFinite(free) ? free : Math.max(0, total - (used || 0)),
        usedBytes: Number.isFinite(used) ? used : null,
      };
    });
  } catch (err) {
    // ─── La mesure qui n'existe pas n'est pas une panne (lot 62) ─────────────
    //
    // Mesuré sur le binaire v1.75.0 du serveur : `rclone about` sur un espace
    // S3 répond « Failed to about: S3 root doesn't support about » — un refus
    // IMMÉDIAT, avant tout appel réseau. Le protocole S3 n'a simplement pas de
    // commande d'espace libre. Accuser la configuration ou le service ferait
    // chercher une panne qui n'existe pas : les copies, elles, fonctionnent.
    if (/doesn'?t support about/i.test(String(err.message || ''))) {
      return unknown(
        'Ce fournisseur ne sait pas annoncer l\'espace restant — cette mesure n\'existe '
          + 'pas chez lui. Ce n\'est pas une panne : les copies fonctionnent normalement.'
      );
    }
    // L'espace n'a pas répondu à la mesure : c'est l'alerte RÉELLE de cette
    // carte — elle doit se voir, avec la cause, jamais un zéro ni un silence.
    // Une erreur du chemin de reconnexion (lot 58) est déjà une phrase
    // française complète : elle se suffit, sans habillage autour.
    if (err.dejaTraduite) return unknown(err.message);
    return unknown(`Cet espace de stockage n'a pas répondu à la mesure de l'espace libre (${err.message}).`);
  }
}

module.exports = { unknown, localSpace, remoteSpace };
