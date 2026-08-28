'use strict';

/**
 * L'écran Optimisation (lot 60) — administration, permission `storage.manage` :
 * le nettoyage touche la machine (profils, sauvegardes, base), pas un compte.
 *
 * Tout ce que GET renvoie est MESURÉ à l'instant de l'appel (parcours du
 * disque local et de la base — aucun service distant sollicité). Les
 * suppressions passent par POST : un lancement de volet respecte les
 * garde-fous du module, et les sauvegardes exigent leur propre geste.
 */

const express = require('express');
const optimisation = require('../optimisation');
const { requirePermission } = require('../middleware');

const router = express.Router();
router.use(requirePermission('storage.manage'));

/** La photographie : réglages, mesures, état du nettoyage en cours. */
router.get('/', (req, res) => {
  res.json({
    volets: optimisation.VOLETS,
    recurrences: optimisation.RECURRENCES_MOIS,
    reglages: optimisation.reglages(),
    mesures: optimisation.mesurer(),
    enCours: optimisation.progress(),
  });
});

/** Mode et récurrence d'un volet. Ne déclenche rien : c'est un réglage. */
router.put('/volets/:volet', (req, res) => {
  const reglage = optimisation.reglerVolet(req.params.volet, {
    mode: req.body?.mode,
    recurrenceMois: req.body?.recurrenceMois,
  });
  res.json({ ok: true, reglage });
});

/** « Lancer maintenant » — un volet, ou la globale (lancement groupé). */
router.post('/volets/:volet/lancer', (req, res) => {
  const resultat = optimisation.lancer(req.params.volet, {
    actor: { userId: req.user.id, username: req.user.username },
    declencheur: 'manuel',
  });
  res.json(resultat);
});

/**
 * Le geste explicite sur les sauvegardes : suppression des fichiers NOMMÉS,
 * et d'eux seuls. Le volet, lui, ne supprime jamais rien.
 */
router.post('/sauvegardes/suppression', (req, res) => {
  const resultat = optimisation.supprimerSauvegardes(req.body?.noms, {
    userId: req.user.id,
    username: req.user.username,
  });
  res.json({ ok: true, ...resultat });
});

module.exports = { router };
