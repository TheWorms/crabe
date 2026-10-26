'use strict';

/**
 * Les refus de démarrer (bilan de santé du 25/10/2026).
 *
 * Certaines situations ne se rattrapent pas en démarrant quand même : une clé
 * qui ne correspond pas à la base, une base mise à jour par une version plus
 * récente de crabe, une mise à jour de la base qui n'a pas pu être sauvegardée
 * avant. Démarrer, c'est alors écrire dans la base avec de mauvaises règles ou
 * une mauvaise clé. crabe s'arrête, sans rien écrire, et dit quoi faire.
 *
 * Le code de sortie 78 (`EX_CONFIG`) est celui qu'attend
 * `RestartPreventExitStatus=78` dans l'unité systemd : un refus n'est pas une
 * panne, systemd ne le relance pas toutes les cinq secondes.
 */

const CODE_REFUS = 78;

/**
 * @param {string} message ce qui se passe et quoi faire, en clair
 * @returns {Error & {refusDeDemarrage: true, exitCode: number}}
 */
function refusDeDemarrage(message) {
  const err = new Error(message);
  err.refusDeDemarrage = true;
  err.exitCode = CODE_REFUS;
  return err;
}

module.exports = { CODE_REFUS, refusDeDemarrage };
