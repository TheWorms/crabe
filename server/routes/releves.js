'use strict';

/**
 * Relever un site pour proposer un service (1.0.0) — les routes.
 *
 * Réservées à qui gère les applications (« apps.manage », 1.0.0) : l'écran vit
 * dans Administration › Applications, et c'est ICI que le refus se joue. Chacun
 * ne voit que SES relevés : la liste, l'archive, l'envoi et la suppression
 * passent par le dossier du compte (`releve-site.chemin`), jamais par un
 * identifiant de relevé seul. La fenêtre, elle, est celle de
 * `remote-browser.js` : même flux, même jeton à usage unique, même relais.
 *
 * Rien de ce que le compte tape ne passe au journal : ni l'adresse complète
 * (le nom du site seulement), ni les mots à retirer de l'archive, ni le texte
 * saisi dans la fenêtre, ni le message joint à un envoi.
 */

const express = require('express');
const path = require('node:path');

const releve = require('../releve-site');
const remoteBrowser = require('../remote-browser');
const { STREAM_PATH } = require('./remote-login');
const applog = require('../applog');
const { config } = require('../config');
const mailer = require('../mailer');
const { requireAuth, requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission('apps.manage'));

/** Ce que l'écran sait de l'envoi : s'il est possible, jamais où il va. */
const envoi = () => ({ possible: mailer.isConfigured(), fois: releve.ENVOIS_MAX, message: releve.MESSAGE_MAX });

const qui = (req) => ({ userId: req.user.id, username: req.user.username });
const fenetre = () => remoteBrowser.manager();

/** Les relevés du compte, si l'envoi est possible, et si un relevé est en cours. */
router.get('/', (req, res) => {
  res.json({
    envoi: envoi(),
    version: config.version,
    limites: { releves: releve.MAX_RELEVES, jours: releve.MAX_JOURS },
    enCours: !!releve.enCours(req.user.id),
    releves: releve.lister(req.user.id),
  });
});

/** Ouvre la fenêtre sur le site et commence le relevé. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const vue = await releve.demarrer({
      userId: req.user.id,
      adresse: req.body?.adresse,
      masquer: req.body?.masquer,
    });
    applog.info('releve', `Relevé de site ouvert sur ${vue.releve?.hote || 'un site'}.`, qui(req));
    res.json({ ...vue, streamPath: STREAM_PATH });
  })
);

/** Où en est le relevé — interrogé en boucle par l'écran. */
router.get('/fenetre', (req, res) => {
  const vue = releve.etatDuReleve(req.user.id);
  if (!vue) return res.status(404).json({ error: 'Aucun relevé en cours.' });
  res.json({ ...vue, streamPath: STREAM_PATH });
});

/** Un jeton de flux neuf, pour rebrancher un écran tombé. */
router.post('/fenetre/ticket', (req, res) => {
  const vue = fenetre().status(req.user.id, releve.ID_FENETRE, { withTicket: true });
  if (!vue) return res.status(404).json({ error: 'Aucun relevé en cours.' });
  // La vue porte son propre `error` (souvent nul) : le refus passe APRÈS, pour se lire.
  if (!vue.token) return res.status(409).json({ ...vue, error: 'Ce relevé est terminé.' });
  // Les étapes déjà vues partent avec le jeton : le panneau se redessine d'emblée.
  res.json({ ...vue, releve: releve.etatDuReleve(req.user.id)?.releve || null, streamPath: STREAM_PATH });
});

/** Un geste dans la fenêtre : les dix minutes d'inactivité repartent. */
router.post('/fenetre/activite', (req, res) => {
  const vue = fenetre().activite(req.user.id, releve.ID_FENETRE);
  if (!vue) return res.status(404).json({ error: 'Aucun relevé en cours.' });
  res.json({ ok: true, remainingMs: vue.remainingMs });
});

/** Un texte frappé dans le champ actif de la fenêtre — jamais journalisé, jamais relevé. */
router.post(
  '/fenetre/type',
  asyncHandler(async (req, res) => {
    const resultat = await fenetre().typeText(req.user.id, releve.ID_FENETRE, req.body?.text);
    if (!resultat.ok) return res.status(409).json({ error: resultat.error });
    res.json({ ok: true, pressePapiers: !!resultat.pressePapiers });
  })
);

/** Un texte déposé dans le presse-papiers de la fenêtre, sans être frappé. */
router.post(
  '/fenetre/presse-papiers',
  asyncHandler(async (req, res) => {
    const resultat = await fenetre().deposerTexte(req.user.id, releve.ID_FENETRE, req.body?.text);
    if (!resultat.ok) return res.status(409).json({ error: resultat.error });
    res.json({ ok: true });
  })
);

/** « Relever cette page maintenant ». */
router.post(
  '/fenetre/copie',
  asyncHandler(async (req, res) => {
    res.json(await releve.releverMaintenant(req.user.id));
  })
);

/** « Terminer le relevé » : la fenêtre se ferme, l'archive est rangée. */
router.post(
  '/fenetre/terminer',
  asyncHandler(async (req, res) => {
    const entree = await releve.terminer(req.user.id);
    applog.info(
      'releve',
      `Relevé de ${entree.site} enregistré : ${entree.pages} page(s), ${entree.documents} document(s)`
        + `${entree.complet ? '' : ' — incomplet'}.`,
      qui(req)
    );
    res.json({ releve: entree, envoi: envoi() });
  })
);

/** « Fermer / Abandonner » : la fenêtre s'éteint, rien n'est rangé. */
router.delete(
  '/fenetre',
  asyncHandler(async (req, res) => {
    const vue = await releve.abandonner(req.user.id);
    if (!vue) return res.status(404).json({ error: 'Aucun relevé en cours.' });
    res.json(vue);
  })
);

/**
 * L'archive `.zip` d'un relevé du compte. Assemblée à la volée : quelques
 * centaines de kilo-octets de texte ne justifient pas un fichier temporaire.
 */
router.get(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const dossier = releve.chemin(req.user.id, req.params.id);
    if (!dossier) return res.status(404).json({ error: 'Relevé introuvable.' });

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.type('application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${releve.nomDArchive(req.params.id)}"`);
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    for (const nom of releve.fichiers(dossier)) archive.file(path.join(dossier, nom), { name: nom });
    await archive.finalize();
    applog.info('releve', `Archive du relevé ${req.params.id.slice(20)} téléchargée.`, qui(req));
  })
);

/**
 * « Envoyer » : crabe envoie lui-même l'archive, avec qui demande, le site et
 * le message. Le journal dit qu'elle est partie — ni où, ni le message.
 */
router.post(
  '/:id/envoyer',
  asyncHandler(async (req, res) => {
    const entree = await releve.envoyer(req.user.id, req.params.id, {
      message: req.body?.message,
      demandeur: { username: req.user.username, email: req.user.email },
      version: config.version,
    });
    applog.info('releve', `Relevé de ${entree.site} envoyé : demande d'ajout d'un connecteur.`, qui(req));
    res.json({ releve: entree, envoi: envoi() });
  })
);

/** Efface un relevé du compte. */
router.delete('/:id', (req, res) => {
  if (!releve.effacer(req.user.id, req.params.id)) return res.status(404).json({ error: 'Relevé introuvable.' });
  res.json({ ok: true });
});

module.exports = { router };
