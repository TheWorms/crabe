'use strict';

/**
 * Le carnet d'identifiants du compte connecté (0.2.13) — Profil › Identifiants.
 * Chaque route n'agit que sur le carnet de `req.user` ; le mot de passe entre
 * (création, modification) mais ne ressort jamais.
 */

const express = require('express');
const carnet = require('../carnet');
const applog = require('../applog');
const { requireAuth, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ entrees: carnet.lister(req.user.id) });
});

router.post('/', asyncHandler(async (req, res) => {
  const id = carnet.creer(req.user.id, req.body || {});
  applog.info('carnet', `Carnet du compte ${req.user.id} : entrée n° ${id} créée.`);
  res.status(201).json({ id, entrees: carnet.lister(req.user.id) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  carnet.modifier(req.user.id, req.params.id, req.body || {});
  applog.info('carnet', `Carnet du compte ${req.user.id} : entrée n° ${Number(req.params.id)} modifiée${req.body?.motDePasse ? ' (mot de passe changé)' : ''}.`);
  res.json({ entrees: carnet.lister(req.user.id) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  carnet.supprimer(req.user.id, req.params.id);
  applog.info('carnet', `Carnet du compte ${req.user.id} : entrée n° ${Number(req.params.id)} supprimée.`);
  res.json({ entrees: carnet.lister(req.user.id) });
}));

module.exports = { router };
