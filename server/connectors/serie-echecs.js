'use strict';

/**
 * Renoncer quand la même cause se répète — la sortie anticipée (lot 80).
 *
 * ─── Ce qui a été mesuré le 10/09/2026 ───────────────────────────────────────
 *
 * Coyote a listé 55 factures, en a tenté 55, en a manqué 55 — le MÊME grief,
 * mot pour mot, cinquante-cinq fois, de 00:51 à 01:18. Vingt-sept minutes pour
 * zéro document, à trente secondes de délai par tentative, contre une butée
 * d'exécution à quarante-cinq minutes. Répéter un échec identique cinquante
 * fois n'apprend rien de plus qu'au troisième et coûte l'exécution entière.
 *
 * ─── Pourquoi TROIS, et pourquoi seulement avant le premier document ─────────
 *
 * Trois est le plus petit nombre qui ne peut pas passer pour une coïncidence :
 * deux documents d'affilée peuvent être abîmés chacun de leur côté, trois
 * échecs consécutifs portant le MÊME grief désignent une cause commune. Le coût
 * du doute tombe ainsi à une minute et demie au lieu de vingt-sept.
 *
 * Et le renoncement ne joue QUE tant qu'aucun document n'a encore été obtenu.
 * Une série d'échecs au milieu d'un parcours qui, lui, rapporte, ne prive
 * personne : le parcours continue et les documents suivants entrent. On ne
 * renonce qu'à ce qui n'a jamais rien donné.
 *
 * ─── « La même cause », c'est le grief aux chiffres près ─────────────────────
 *
 * Les griefs portent des tailles et des codes (« a rendu 4 217 octets ») : deux
 * échecs de même nature ne s'écrivent pas caractère pour caractère. Les chiffres
 * sont donc masqués avant comparaison — la même règle que les textes
 * d'interface du journal.
 */

/** Trois échecs consécutifs de même cause, avant tout document obtenu. */
const SEUIL_RENONCEMENT = 3;

/** Le grief ramené à sa forme : chiffres masqués, espaces réduits, borné. */
function empreinteDeGrief(grief) {
  return String(grief || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d+/g, '#')
    .slice(0, 200);
}

/**
 * Un compteur de série, à tenir le long d'un parcours de documents.
 *
 * @param {{seuil?: number}} [options]
 * @returns {{reussite: () => void, echec: (grief: string) => boolean,
 *   compte: () => number, raison: () => string}}
 *   `echec()` rend `true` quand il faut renoncer ; `raison()` dit pourquoi,
 *   en une phrase destinée au journal.
 */
function suiteDEchecs({ seuil = SEUIL_RENONCEMENT } = {}) {
  let empreinte = null;
  let compte = 0;
  let dernierGrief = '';
  let auMoinsUnObtenu = false;

  return {
    /** Un document est entré : la série repart de zéro, et pour de bon. */
    reussite() {
      auMoinsUnObtenu = true;
      empreinte = null;
      compte = 0;
    },
    /** Un document a manqué. Rend `true` s'il faut arrêter le parcours. */
    echec(grief) {
      const forme = empreinteDeGrief(grief);
      if (forme === empreinte) compte += 1;
      else { empreinte = forme; compte = 1; }
      dernierGrief = String(grief || '');
      return !auMoinsUnObtenu && compte >= seuil;
    },
    /** La longueur de la série en cours. */
    compte: () => compte,
    /** La phrase du journal — elle porte la cause, pas seulement le compte. */
    raison: () =>
      `${compte} document(s) de suite ont échoué pour la même raison (${dernierGrief}) `
      + 'et aucun n\'a encore pu être récupéré : le parcours s\'arrête là plutôt que de '
      + 'répéter le même échec sur tous les suivants.',
    /**
     * La phrase de l'écran — le grief technique reste au journal. Elle dit ce
     * qui s'est passé et ce qu'il faut en attendre, à quelqu'un qui n'ouvrira
     * jamais le détail de l'exécution.
     */
    phrasePublique: () =>
      `Le parcours s'est arrêté après ${compte} tentatives infructueuses de suite, toutes `
      + 'bloquées de la même façon : les documents suivants n\'ont pas été tentés, et le '
      + 'prochain passage reprendra depuis le début.',
  };
}

module.exports = {
  suiteDEchecs,
  empreinteDeGrief,
  SEUIL_RENONCEMENT,
};
