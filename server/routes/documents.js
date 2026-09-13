'use strict';

/**
 * « Mes documents » — consultation, et rien d'autre.
 *
 * Aucune route d'écriture ici : ni suppression, ni renommage, ni déplacement.
 * crabe produit ces fichiers, il ne les gère pas.
 *
 * Isolation : tout est borné à `req.user`. Le montage NFS du stockage local est en
 * all_squash — tous les fichiers appartiennent au même compte Unix — donc rien
 * ne peut reposer sur les permissions du système de fichiers. La propriété est
 * vérifiée ICI, par `user_id`, et le chemin est reconstruit par le serveur :
 * un identifiant deviné renvoie 404, sans révéler si le document existe.
 */

const express = require('express');

const documents = require('../documents');
const destinations = require('../destinations');
const db = require('../db/db');
const applog = require('../applog');
const { requireAuth, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

/** L'écran entier : destinations proposées, arborescence, filtres. */
router.get('/', (req, res) => {
  res.json(
    documents.browse(req.user, {
      destination: req.query.destination,
      q: req.query.q,
      connector: req.query.connector,
      period: req.query.period,
    })
  );
});

/**
 * Téléchargement d'un document depuis la destination consultée.
 *
 * Le stockage local est servi directement ; une destination distante est rapatriée par
 * rclone dans un fichier temporaire, effacé une fois la réponse partie.
 */
router.get(
  '/:destination/:invoiceId/file',
  asyncHandler(async (req, res) => {
    const invoice = db
      .get()
      .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
      .get(Number(req.params.invoiceId), req.user.id);

    if (!invoice) return res.status(404).json({ error: 'Document introuvable.' });

    const destId = req.params.destination;
    if (!destinations.activeDestinations().includes(destId)) {
      return res.status(404).json({ error: 'Espace de stockage inconnu ou non activé.' });
    }

    const result = await destinations.fetchInvoice(destId, invoice, req.user.username);
    if (!result.ok) {
      // Le détail technique (chemin, message rclone) reste dans les journaux
      // d'administration ; l'utilisateur reçoit ce qu'il peut en faire.
      applog.warn(
        'documents',
        `Lecture de ${invoice.filename} sur ${destId} impossible — ${result.message}`,
        { userId: req.user.id, username: req.user.username }
      );
      return res.status(404).json({
        error:
          'Ce document n\'est plus lisible sur cet espace de stockage. '
          + 'Essayez un autre espace, ou relancez une récupération.',
      });
    }

    res.download(result.file, invoice.filename, () => result.cleanup?.());
  })
);

module.exports = { router };
