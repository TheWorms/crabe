'use strict';

/**
 * Le bandeau des opérations (lot 59) — une seule route, en lecture seule.
 *
 * L'interface l'interroge régulièrement depuis toutes les pages : tout ce
 * qu'elle lit vient de la mémoire du processus ou de la base locale, jamais
 * d'un service distant (voir server/operations.js). L'appel est donc aussi
 * bon marché qu'un affichage, et peut se répéter sans arrière-pensée.
 */

const express = require('express');
const operations = require('../operations');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

/** Les opérations en cours ou récemment finies, visibles de ce compte. */
router.get('/', (req, res) => {
  res.json({ operations: operations.operationsPour(req.user) });
});

module.exports = { router };
