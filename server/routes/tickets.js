'use strict';

/**
 * Support (ex-SAV).
 *
 * Un utilisateur ne voit que ses propres demandes ; l'administration voit
 * tout, y compris ce que les utilisateurs ont masqué de leur côté.
 */

const express = require('express');
const tickets = require('../tickets');
const applog = require('../applog');
const { requireAuth, requirePermission, asyncHandler } = require('../middleware');

/** Administration du support : permission « Répondre au support ». */
const requireSupport = requirePermission('support.reply');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Côté utilisateur
// ---------------------------------------------------------------------------

/** Mes demandes, fil de conversation compris. */
router.get('/mine', (req, res) => {
  res.json({ tickets: tickets.listForUser(req.user.id) });
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const ticket = tickets.create(req.user.id, req.body?.subject, req.body?.message);
    applog.info('support', `Nouvelle demande #${ticket.id} — ${ticket.subject}`, {
      userId: req.user.id,
      username: req.user.username,
    });
    res.status(201).json({ ticket });
  })
);

/** Relance de l'utilisateur sur sa propre demande. */
router.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const ticket = tickets.getById(Number(req.params.id), false);
    // 404 et non 403 : ne pas révéler l'existence de la demande d'un autre.
    if (!ticket || ticket.userId !== req.user.id) {
      return res.status(404).json({ error: 'Demande introuvable.' });
    }

    const updated = tickets.reply(ticket.id, req.body?.message, {
      author: 'user',
      userId: req.user.id,
      username: req.user.username,
    });
    res.json({ ticket: updated });
  })
);

/**
 * Retire la demande de MON historique.
 * L'administration la conserve : c'est un masquage, pas une suppression.
 */
router.delete('/:id/mine', (req, res) => {
  const ok = tickets.hideForUser(Number(req.params.id), req.user.id);
  if (!ok) return res.status(404).json({ error: 'Demande introuvable.' });
  res.json({
    ok: true,
    message: 'Demande retirée de votre historique — l\'administration en conserve la trace.',
  });
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

router.get('/', requireSupport, (req, res) => {
  res.json({
    tickets: tickets.listAll(req.query.status || 'all'),
    counts: tickets.counts(),
    statuses: tickets.STATUSES.map((id) => ({ id, label: tickets.STATUS_LABELS[id] })),
  });
});

/** Ouvrir une demande la marque comme lue (et la prend en charge). */
router.get('/:id', requireSupport, (req, res) => {
  const ticket = tickets.getById(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Demande introuvable.' });

  const opened = req.query.markRead === '0' ? ticket : tickets.markRead(ticket.id);
  res.json({ ticket: opened, counts: tickets.counts() });
});

/** Réponse de l'administration : ajoutée au fil, jamais écrasée. */
router.post(
  '/:id/reply',
  requireSupport,
  asyncHandler(async (req, res) => {
    const ticket = tickets.reply(Number(req.params.id), req.body?.message, {
      author: 'admin',
      userId: req.user.id,
      username: req.user.username,
      status: req.body?.status,
    });
    applog.admin(req, `Réponse envoyée sur la demande #${ticket.id}.`);
    res.json({ ticket, counts: tickets.counts() });
  })
);

router.patch(
  '/:id',
  requireSupport,
  asyncHandler(async (req, res) => {
    const ticket = tickets.updateStatus(Number(req.params.id), req.body?.status, req.body?.reply);
    applog.admin(req, `Demande #${ticket.id} : statut ${ticket.statusLabel}.`);
    res.json({ ticket, counts: tickets.counts() });
  })
);

module.exports = { router };
