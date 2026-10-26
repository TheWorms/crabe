'use strict';

/**
 * Le point d'entrée de la ligne de commande (0.2.6) : `crabe recuperer
 * <service> --detail` (bin/crabe.js) demande au service EN MARCHE de lancer
 * une récupération — jamais une seconde copie de crabe à côté de lui, qui
 * ferait tourner deux fois le même connecteur.
 *
 * Trois gardes, toutes nécessaires :
 *   - la machine elle-même : l'adresse de la connexion est une adresse de
 *     bouclage, et la demande ne vient pas d'un mandataire (`X-Forwarded-For`) ;
 *   - le jeton du fichier `<données>/cli.json`, tiré au démarrage, en 600 :
 *     seul le compte qui fait tourner crabe peut le lire ;
 *   - une comparaison à temps constant.
 *
 * Monté AVANT la barrière réseau et la session : il ne connaît ni l'une ni
 * l'autre, ses gardes sont les siennes.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const db = require('../db/db');
const { config } = require('../config');

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

let jeton = null;

const fichier = () => path.join(config.dataDir, 'cli.json');

/** Tire le jeton et l'écrit, avec le port, pour la ligne de commande. */
function preparer(port = config.port) {
  jeton = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(fichier(), JSON.stringify({ port, jeton }), { mode: 0o600 });
    fs.chmodSync(fichier(), 0o600);
  } catch {
    jeton = null;
  }
  return jeton;
}

function estBouclage(adresse) {
  return /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(adresse || ''));
}

function garde(req, res, next) {
  const donne = String(req.get('x-crabe-jeton') || '');
  const ok = jeton
    && estBouclage(req.socket?.remoteAddress)
    && !req.get('x-forwarded-for')
    && donne.length === jeton.length
    && crypto.timingSafeEqual(Buffer.from(donne), Buffer.from(jeton));
  if (!ok) return res.status(403).json({ error: 'Réservé à la ligne de commande de cette machine.' });
  return next();
}

router.use(garde);

/** Lance une récupération ; rend son numéro dès qu'elle existe. */
router.post('/recuperer', async (req, res) => {
  const registry = require('../connectors/registry');
  const scheduler = require('../scheduler');
  const service = String(req.body?.service || '').trim();
  const compte = String(req.body?.compte || '').trim();
  if (!registry.has(service)) return res.status(404).json({ error: `Service inconnu : « ${service} ».` });

  const d = db.get();
  const installes = d.prepare(
    `SELECT u.id, u.username FROM connector_installs i JOIN users u ON u.id = i.user_id
      WHERE i.connector_id = ? ORDER BY u.id`
  ).all(service);
  const choisis = compte ? installes.filter((u) => u.username === compte) : installes;
  if (!choisis.length) {
    return res.status(404).json({ error: compte ? `Le compte « ${compte} » n'a pas installé ${service}.` : `Aucun compte n'a installé ${service}.` });
  }
  if (choisis.length > 1) {
    return res.status(409).json({ error: `${choisis.length} comptes ont installé ${service} : précisez lequel avec --compte <nom>.`, comptes: choisis.map((u) => u.username) });
  }
  const user = choisis[0];
  const avant = d.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM run_logs').get().m;

  // La récupération continue sans cette requête : la ligne de commande suit
  // son journal par la route suivante.
  let fini = null;
  scheduler.runForUser(user.id, service, 'manual', { detail: !!req.body?.detail })
    .then((r) => { fini = { r }; }, (err) => { fini = { err }; });

  // Le numéro existe dès que la récupération commence ; un refus (verrou,
  // pause) finit avant d'en avoir un.
  const limite = Date.now() + 30_000;
  for (;;) {
    const ligne = d.prepare('SELECT id FROM run_logs WHERE id > ? AND user_id = ? AND connector_id = ? ORDER BY id LIMIT 1')
      .get(avant, user.id, service);
    if (ligne) return res.json({ runId: ligne.id, compte: user.username });
    if (fini) {
      const message = fini.err ? fini.err.message : fini.r?.message || 'La récupération n\'a pas démarré.';
      return res.status(409).json({ error: message });
    }
    if (Date.now() > limite) return res.status(504).json({ error: 'La récupération n\'a pas démarré en 30 s.' });
    await new Promise((r) => setTimeout(r, 200));
  }
});

/** Où en est une récupération, et ses lignes de journal depuis `apres`. */
router.get('/recuperations/:id', (req, res) => {
  const id = Number(req.params.id);
  const apres = Number(req.query.apres) || 0;
  const d = db.get();
  const run = d.prepare('SELECT id, finished_at, success, message, invoice_count FROM run_logs WHERE id = ?').get(id);
  if (!run) return res.status(404).json({ error: 'Récupération inconnue.' });
  const lignes = d.prepare('SELECT id, at, level, message FROM app_logs WHERE run_id = ? AND id > ? ORDER BY id LIMIT 500')
    .all(id, apres);
  return res.json({ run, lignes });
});

/** Le rapport d'une récupération (texte, ou archive avec ses pièces). */
router.get('/recuperations/:id/rapport', (req, res) => {
  const id = Number(req.params.id);
  const rapportEchec = require('../rapport-echec');
  const sortie = rapportEchec.rapport(id, { database: db.get(), fuseau: require('../settings').timezone() });
  if (!sortie) return res.status(404).json({ error: 'Récupération inconnue.' });
  return rapportEchec.envoyer(res, sortie, id);
});

module.exports = { router, preparer, estBouclage, fichier };
