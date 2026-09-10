'use strict';

/**
 * Accueil — routes de l'utilisateur connecté.
 *
 * Tout est borné à `req.user` : la disposition, les documents, les
 * statistiques. Seul le test d'une destination touche une ressource partagée,
 * et il est volontairement ouvert à tous les comptes : il vérifie qu'un dépôt
 * serait possible, sans exposer ni chemin, ni identifiants.
 */

const express = require('express');
const home = require('../home');
const destinations = require('../destinations');
const destinationSync = require('../destinations/sync');
const applog = require('../applog');
const { requireAuth, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

/** Tableau de bord complet, en un seul appel. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await home.dashboard(req.user));
  })
);

/**
 * Refus d'une modification de disposition, verrous appliqués côté serveur.
 *
 * Masquer les boutons ne protège de rien : c'est ici que le verrou
 * administrateur (« Autoriser la personnalisation de l'accueil ») et le verrou
 * personnel (« Figer mon accueil ») sont réellement opposés à la requête.
 *
 * @returns {boolean} vrai si la requête peut continuer
 */
function allowCustomization(req, res) {
  const refusal = home.customizationRefusal(req.user);
  if (!refusal) return true;
  res.status(403).json({ error: refusal, access: home.accessFor(req.user) });
  return false;
}

/** Disposition des blocs — enregistrée en base, jamais dans le navigateur. */
router.get('/widgets', (req, res) => {
  res.json({ widgets: home.preferencesFor(req.user.id), access: home.accessFor(req.user) });
});

router.put('/widgets', (req, res) => {
  if (!allowCustomization(req, res)) return;
  const widgets = home.savePreferences(req.user.id, req.body?.widgets);
  res.json({ ok: true, widgets, access: home.accessFor(req.user) });
});

router.post('/widgets/reset', (req, res) => {
  if (!allowCustomization(req, res)) return;
  res.json({
    ok: true,
    widgets: home.resetPreferences(req.user.id),
    access: home.accessFor(req.user),
  });
});

/**
 * Test d'une destination depuis l'accueil.
 *
 * Refusé si la destination n'est pas activée : elle n'existe pas pour
 * l'utilisateur, il ne doit pas pouvoir la sonder en devinant son identifiant.
 */
router.post(
  '/destinations/:id/test',
  asyncHandler(async (req, res) => {
    if (!destinations.activeDestinations().includes(req.params.id)) {
      return res.status(404).json({ error: 'Destination inconnue ou non activée.' });
    }

    const result = await destinations.test(req.params.id, req.user.id);
    applog.info(
      'destinations',
      `Test de ${req.params.id} depuis l'accueil : ${result.ok ? 'succès' : 'échec'} — ${result.message}`,
      { userId: req.user.id, username: req.user.username }
    );
    res.json(result);
  })
);

/**
 * Synchronisation forcée depuis l'accueil.
 *
 * Bornée aux documents de `req.user` : c'est SA page, ce sont SES documents.
 * Un compte ne déclenche jamais le transfert des fichiers d'un autre — la
 * version qui traite tout le monde vit dans l'administration, derrière la
 * permission `storage.manage` (voir routes/destinations.js).
 *
 * Aucun scraping : le PDF est relu depuis le stockage local et redéposé. C'est ce qui
 * rend ce bouton relançable sans risque.
 */
router.post(
  '/destinations/sync',
  asyncHandler(async (req, res) => {
    // ⚠ Les destinations de CE compte, pas toutes les actives (lot 24).
    // Sans ça, quelqu'un qui a désactivé MEGA dans son profil verrait le
    // bouton « Tout synchroniser » lui en envoyer quand même l'intégralité de
    // ses documents — un choix contredit par un bouton, c'est-à-dire un choix
    // qui ne veut rien dire.
    const permises = destinations.destinationsForUser(req.user.id);
    const demandee = req.body?.destinationId;
    if (demandee && !permises.includes(demandee)) {
      return res.status(404).json({ error: 'Destination inconnue ou non activée.' });
    }

    const cibles = demandee ? [demandee] : permises.filter((id) => id !== 'local');

    const lance = destinationSync.start({
      destinationIds: cibles,
      userId: req.user.id,
      actor: { userId: req.user.id, username: req.user.username },
    });
    res.json(lance);
  })
);

/** Avancement de la synchronisation en cours, ou compte rendu de la dernière. */
router.get('/destinations/sync', (req, res) => {
  res.json(destinationSync.progress());
});

module.exports = { router };
