'use strict';

/**
 * Système : version, statistiques, informations d'exploitation, politique de
 * sécurité, SMTP et réglages d'affichage (fuseau, formats, Gravatar).
 *
 * Tout est réservé à l'administration, sauf /version et /settings (que le front
 * a besoin de lire pour formater les dates).
 */

const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const db = require('../db/db');
const crypto = require('../crypto');
const registry = require('../connectors/registry');
const destinations = require('../destinations');
const scheduler = require('../scheduler');
const passwordPolicy = require('../auth/password');
const settings = require('../settings');
const applog = require('../applog');
const mailer = require('../mailer');
const emailTemplates = require('../email-templates');
const { config } = require('../config');
const version = require('../version');
const {
  requirePermission,
  requireAnyAdminPermission,
  asyncHandler,
} = require('../middleware');

/** Réglages globaux : permission « Configurer la sécurité ». */
const requireSecurity = requirePermission('security.manage');

/**
 * Gravatar est le seul point de crabe qui parle à un service tiers : le
 * réglage ne s'affiche jamais sans cette phrase.
 */
const GRAVATAR_NOTICE =
  'Activer Gravatar envoie une empreinte de l\'adresse e-mail de chaque compte à ' +
  'un service tiers externe (gravatar.com), alors que crabe est autrement ' +
  'strictement confiné au réseau local. Désactivé, aucune requête ne sort.';

const router = express.Router();

/** Accessible à tous : sert à afficher la version en pied de page. */
router.get('/version', (req, res) => {
  res.json({ name: 'crabe', version: config.version });
});

// Les statistiques sont visibles dès qu'un compte a une permission
// d'administration ; chaque réglage a ensuite sa propre permission.
router.get('/', requireAnyAdminPermission, (req, res) => {
  const one = (sql, ...params) => db.get().prepare(sql).get(...params);

  const users = one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM users`
  );
  const invoices = one(
    'SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes FROM invoices'
  );
  const installs = one('SELECT COUNT(*) AS total FROM connector_installs');
  const runs = one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok
       FROM run_logs WHERE started_at > datetime('now', '-30 days')`
  );

  const reliability = runs.total ? Math.round((runs.ok / runs.total) * 1000) / 10 : 100;
  const local = destinations.publicConfig('local');

  res.json({
    version: config.version,
    node: process.version,
    env: config.env,
    uptimeSeconds: Math.floor(process.uptime()),
    hostUptimeSeconds: Math.floor(os.uptime()),
    hostname: os.hostname(),
    stats: {
      usersActive: users.active || 0,
      usersTotal: users.total || 0,
      connectorsAvailable: registry.size,
      connectorsInstalled: installs.total,
      invoicesTotal: invoices.total,
      storageBytes: invoices.bytes,
      reliability30d: reliability,
    },
    // Informations utiles à l'exploitation du LXC.
    runtime: {
      dataDir: config.dataDir,
      dbFile: config.dbFile,
      dbSizeBytes: db.fileSizeBytes(),
      diskFreeBytes: diskFreeBytes(config.dataDir),
      timezone: settings.timezone(),
      systemTimezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: new Date().toISOString(),
      cookieSecure: config.cookieSecure,
      trustProxy: config.trustProxy,
    },
    local: {
      path: local?.path || '',
      protocol: local?.protocol || 'local',
      exists: exists(local?.path),
      mounted: isMounted(local?.path),
      writable: isWritable(local?.path),
      // Résumé sans effet de bord (ni création de dossier, ni écriture de
      // sonde) : le diagnostic complet est derrière « Tester la connexion ».
      state: localState(local),
    },
    playwright: {
      available: require('../connectors/scraping').isPlaywrightAvailable(),
    },
    schemaVersion: db.get().prepare('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get().v,
    smtpConfigured: mailer.isConfigured(),
    scheduler: {
      disabled: config.schedulerDisabled,
      activeTasks: scheduler.activeTasks,
      lastCronAt: scheduler.lastCronAt,
      lastMaintenanceAt: scheduler.lastMaintenanceAt,
    },
    connectorLoadErrors: registry.errors,
  });
});

/**
 * Espace disque restant sur le système de fichiers d'un chemin.
 * @returns {number|null} octets, ou null si l'appel n'est pas disponible
 */
function diskFreeBytes(target) {
  try {
    const stats = fs.statfsSync(target);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Le chemin du stockage local est-il un point de montage, ou juste un dossier local ?
 * Même détection que le driver, qui fait autorité (destinations/local.js).
 */
const isMounted = destinations.DRIVERS.local.isMountPoint;

function exists(target) {
  if (!target) return false;
  return fs.existsSync(target);
}

/** État résumé de la destination locale (le driver fait autorité). */
const localState = destinations.DRIVERS.local.quickState;

function isWritable(target) {
  if (!target) return false;
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Le binaire rclone est-il disponible, et dans quelle version ? */
router.get(
  '/rclone',
  requireAnyAdminPermission,
  asyncHandler(async (req, res) => {
    const version = await new Promise((resolve) => {
      execFile(config.rcloneBin, ['version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).split('\n')[0].trim());
      });
    });
    res.json({ available: !!version, version, binary: config.rcloneBin });
  })
);

// ---------------------------------------------------------------------------
// Réglages d'affichage (fuseau horaire, formats, Gravatar)
// ---------------------------------------------------------------------------

/**
 * Lisible par tout compte authentifié : le front en a besoin pour formater
 * TOUTES les dates et heures de l'interface au même endroit.
 */
router.get('/settings', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  res.json({
    settings: settings.publicSettings(),
    timeFormats: settings.TIME_FORMATS,
    dateFormats: settings.DATE_FORMATS,
    // Affichée à côté de l'interrupteur Gravatar (Paramètres → Utilisateurs →
    // Avatars) : le choix ne se fait pas sans sa justification.
    gravatarNotice: GRAVATAR_NOTICE,
    // La liste IANA complète n'est utile qu'à l'administration.
    timezones: require('../permissions').userHas(req.user, 'security.manage')
      ? settings.timezones()
      : undefined,
  });
});

router.put(
  '/settings',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const updated = settings.updateAppSettings(req.body || {});
    // Les tâches planifiées suivent le fuseau : on les reconstruit.
    if (req.body?.timezone !== undefined) scheduler.reload();

    applog.admin(
      req,
      `Réglages d'affichage : fuseau ${updated.timezone}, heure ${updated.timeFormat} h, ` +
        `date ${updated.dateFormat}, Gravatar ${updated.gravatarEnabled ? 'autorisé' : 'désactivé'}.`
    );
    res.json({ ok: true, settings: updated });
  })
);

/**
 * Vérification de mise à jour.
 * Aucun serveur de publication n'existe pour crabe : la route répond
 * honnêtement plutôt que de simuler une réponse distante.
 */
router.post('/update-check', requireAnyAdminPermission, async (req, res) => {
  const depot = (process.env.CRABE_UPDATE_REPO || '').trim();

  if (!depot) {
    return res.json({
      current: version.VERSION,
      latest: null,
      upToDate: null,
      message:
        'Vérification coupée : CRABE_UPDATE_REPO est vide. Renseignez cette ' +
        'variable dans votre docker-compose.yml pour interroger les versions publiées.',
    });
  }

  // Un clic d'administrateur vaut consentement : la cadence quotidienne de
  // version.js est court-circuitée pour cette vérification-là.
  version.oublierVerification();
  const maj = await version.verifierMiseAJour();

  if (maj) {
    return res.json({
      current: version.VERSION,
      latest: maj.version,
      upToDate: false,
      message:
        `La version ${maj.version} est disponible (installée : v${version.VERSION}). ` +
        'Pour mettre à jour : docker compose pull && docker compose up -d.',
    });
  }

  // null ne distingue pas « à jour » d'un dépôt muet : le message le dit,
  // plutôt que d'affirmer ce que la route ne sait pas.
  res.json({
    current: version.VERSION,
    latest: version.VERSION,
    upToDate: true,
    message:
      `Aucune version plus récente connue : crabe (v${version.VERSION}) est à jour ` +
      "— ou le dépôt interrogé n'a pas répondu (l'échec réseau est silencieux, par principe).",
  });
});

// ---------------------------------------------------------------------------
// Politique de sécurité
// ---------------------------------------------------------------------------

function policyRow() {
  return db.get().prepare('SELECT * FROM security_policy WHERE id = 1').get();
}

router.get('/security', requireSecurity, (req, res) => {
  const p = policyRow();
  res.json({
    twoFactorMode: settings.twoFactorMode(p),
    twoFactorModes: settings.TWO_FACTOR_MODES,
    passwordComplexity: p.password_complexity,
    passwordLevels: Object.values(passwordPolicy.POLICIES).map((l) => ({
      id: l.id,
      label: l.label,
    })),
    logRetentionDays: p.log_retention_days,
    retentionOptions: require('./logs').RETENTION_OPTIONS,
    // Rétention des DOCUMENTS — à ne pas confondre avec celle des journaux
    // au-dessus : l'une jette des lignes de trace, l'autre des factures.
    documentRetention: require('../retention').view(),
    // Gravatar se règle désormais dans Utilisateurs → Avatars, le SMTP dans son
    // propre menu (GET /system/smtp) ; les deux valeurs restent exposées ici
    // pour ne casser aucun appelant existant.
    gravatarEnabled: settings.publicSettings().gravatarEnabled,
    gravatarNotice: GRAVATAR_NOTICE,
    smtp: smtpView(p),
  });
});

router.put(
  '/security',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const { twoFactorMode, passwordComplexity } = req.body || {};
    let changed = false;

    if (twoFactorMode !== undefined) {
      settings.setTwoFactorMode(twoFactorMode);
      const label = settings.TWO_FACTOR_MODES.find((m) => m.id === twoFactorMode)?.label;
      applog.admin(req, `Politique de double authentification : ${label}.`);
      changed = true;
    }

    if (passwordComplexity !== undefined) {
      if (!passwordPolicy.POLICIES[passwordComplexity]) {
        return res.status(400).json({ error: 'Niveau de complexité inconnu.' });
      }
      db.get()
        .prepare(
          "UPDATE security_policy SET password_complexity = ?, updated_at = datetime('now') WHERE id = 1"
        )
        .run(passwordComplexity);
      applog.admin(req, `Complexité de mot de passe exigée : ${passwordComplexity}.`);
      changed = true;
    }

    if (req.body?.documentRetentionMonths !== undefined) {
      const retention = require('../retention');
      // `applyNow` est la CONFIRMATION EXPLICITE que la mission exige : sans
      // elle, un plancher protège tout ce qui a déjà été récupéré, et seuls
      // les documents arrivés ensuite vieilliront selon la nouvelle
      // profondeur. Voir server/retention.js.
      const rendu = retention.setMonths(req.body.documentRetentionMonths, {
        applyNow: !!req.body.applyRetentionNow,
      });
      // ⚠ « à venir » se disait ici de la date de RÉCUPÉRATION, et se lisait
      // comme la date d'ÉMISSION. Le 12/08/2026, un compte protégé par ce
      // plancher a récupéré 118 factures anciennes (OVH, SoYouStart) et les a
      // vues effacées la nuit suivante : elles avaient été récupérées APRÈS le
      // plancher, donc elles n'étaient pas « les précédentes ». La phrase était
      // vraie et trompeuse à la fois. Elle dit maintenant sur quoi elle porte.
      applog.admin(
        req,
        `Conservation des documents : ${rendu.label}`
          + (rendu.floor
            ? ' — les documents DÉJÀ récupérés sont conservés quelle que soit leur date. '
              + 'Le nettoyage ne portera que sur ceux récupérés à partir de maintenant, '
              + 'y compris s\'ils sont anciens.'
            : rendu.months
              ? ` — appliquée aussi à l'existant (${rendu.beyond} document(s) concerné(s)).`
              : '.')
      );
      changed = true;
    }

    if (req.body?.gravatarEnabled !== undefined) {
      settings.updateAppSettings({ gravatarEnabled: !!req.body.gravatarEnabled });
      applog.admin(
        req,
        `Gravatar ${req.body.gravatarEnabled ? 'autorisé' : 'désactivé'} pour tous les comptes.`
      );
      changed = true;
    }

    if (!changed) return res.status(400).json({ error: 'Aucune modification fournie.' });
    res.json({
      ok: true,
      twoFactorMode: settings.twoFactorMode(),
      gravatarEnabled: settings.publicSettings().gravatarEnabled,
    });
  })
);

// ---------------------------------------------------------------------------
// SMTP : configuration du serveur d'envoi et modèles d'e-mail
//
// Le SMTP n'a jamais été testé en conditions réelles : chaque route doit se
// dégrader proprement (message explicite, jamais de plantage) quand aucun
// serveur n'est joignable.
// ---------------------------------------------------------------------------

/** Vue de la configuration SMTP — le mot de passe n'en sort jamais. */
function smtpView(p = policyRow()) {
  return {
    host: p.smtp_host || '',
    port: p.smtp_port || null,
    user: p.smtp_user || '',
    from: p.smtp_from || '',
    fromName: p.smtp_from_name || '',
    secure: mailer.secureMode(p),
    // Le mot de passe SMTP n'est jamais renvoyé, seulement sa présence.
    configured: !!p.smtp_pass_encrypted,
    // « Prêt à envoyer » ne dépend que de l'hôte : un relais local peut se
    // passer d'authentification.
    ready: !!p.smtp_host,
  };
}

router.get('/smtp', requireSecurity, (req, res) => {
  res.json({
    smtp: smtpView(),
    secureModes: mailer.SECURE_MODES,
    templates: emailTemplates.list(),
  });
});

router.put('/smtp', requireSecurity, (req, res) => {
  const { host, port, user, from, fromName, secure, password: pass } = req.body || {};
  const previous = policyRow();

  if (secure !== undefined && secure !== null && secure !== '') {
    if (!mailer.SECURE_MODES.some((m) => m.id === secure)) {
      return res.status(400).json({ error: 'Mode de chiffrement inconnu.' });
    }
  }

  db.get()
    .prepare(
      `UPDATE security_policy
          SET smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_from = ?,
              smtp_from_name = ?, smtp_secure = ?, smtp_pass_encrypted = ?,
              updated_at = datetime('now')
        WHERE id = 1`
    )
    .run(
      String(host || '').trim() || null,
      port ? Number(port) : null,
      String(user || '').trim() || null,
      String(from || '').trim() || null,
      String(fromName || '').trim() || null,
      secure || null,
      // Champ laissé vide : on garde le mot de passe déjà enregistré.
      pass ? crypto.encrypt(String(pass)) : previous.smtp_pass_encrypted
    );

  applog.admin(req, `Configuration SMTP enregistrée (${String(host || '').trim() || 'aucun hôte'}).`);
  res.json({ ok: true, smtp: smtpView() });
});

/**
 * Envoi de test. Ne lève jamais : une configuration fausse doit produire un
 * message lisible (DNS, refus, authentification, délai, certificat), pas une
 * 500 muette.
 */
router.post(
  '/smtp/test',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const p = policyRow();
    const to = String(req.body?.to || req.user.email || '').trim();
    if (!to) {
      return res.status(400).json({
        ok: false,
        message:
          'Aucun destinataire : saisissez une adresse de test, ou renseignez ' +
          'une adresse e-mail sur votre profil.',
      });
    }

    // Modèle demandé : on envoie le vrai modèle rempli de valeurs d'exemple.
    const key = req.body?.template;
    let message;
    if (key) {
      if (!emailTemplates.definition(key)) {
        return res.status(404).json({ ok: false, message: 'Modèle d\'e-mail inconnu.' });
      }
      const rendered = emailTemplates.preview(key);
      message = { subject: rendered.subject, text: rendered.text };
    } else {
      message = {
        subject: 'crabe — test d\'envoi SMTP',
        text:
          'Ceci est un message de test envoyé par crabe.\n\n' +
          'Si vous le recevez, la configuration SMTP est fonctionnelle : les ' +
          'confirmations de changement d\'adresse e-mail partiront correctement.\n',
      };
    }

    try {
      const transport = mailer.transport(p);
      await transport.verify();
      await transport.sendMail({ from: mailer.sender(p), to, ...message });
      applog.admin(req, `Test SMTP réussi vers ${to}${key ? ` (modèle ${key})` : ''}.`);
      res.json({ ok: true, message: `E-mail de test envoyé à ${to}` });
    } catch (err) {
      const explained = mailer.describeError(err, { host: p.smtp_host, port: p.smtp_port });
      applog.admin(req, `Test SMTP en échec — ${err.message}`, 'warn');
      res.json({ ok: false, message: explained });
    }
  })
);

// --- Modèles d'e-mail ------------------------------------------------------

router.get('/email-templates', requireSecurity, (req, res) => {
  res.json({ templates: emailTemplates.list() });
});

router.put(
  '/email-templates/:key',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const saved = emailTemplates.save(req.params.key, req.body || {});
    applog.admin(req, `Modèle d'e-mail « ${saved.label} » enregistré.`);
    res.json({ ok: true, template: saved });
  })
);

router.post(
  '/email-templates/:key/reset',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const restored = emailTemplates.reset(req.params.key);
    applog.admin(req, `Modèle d'e-mail « ${restored.label} » réinitialisé.`);
    res.json({ ok: true, template: restored });
  })
);

/**
 * Aperçu : rendu du modèle avec des valeurs d'exemple.
 * Le corps envoyé (s'il y en a un) est prévisualisé tel quel, avant
 * enregistrement — on juge ce qu'on est en train d'écrire.
 */
router.post(
  '/email-templates/:key/preview',
  requireSecurity,
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    if (!emailTemplates.definition(key)) {
      return res.status(404).json({ error: 'Modèle d\'e-mail inconnu.' });
    }

    const values = emailTemplates.sampleValues(key);
    const draft = req.body || {};
    const source =
      draft.subject !== undefined || draft.body !== undefined
        ? { subject: draft.subject ?? '', body: draft.body ?? '' }
        : { subject: emailTemplates.get(key).subject, body: emailTemplates.get(key).body };

    res.json({
      preview: {
        subject: emailTemplates.substitute(source.subject, values),
        body: emailTemplates.substitute(source.body, values),
      },
      values,
    });
  })
);

// ---------------------------------------------------------------------------
// Stockage global (repris par la page « Stockage » de l'administration)
// ---------------------------------------------------------------------------

router.get('/storage', requirePermission('storage.manage'), (req, res) => {
  const usage = destinations.usageByDestination();
  res.json({
    totalBytes: usage.reduce((sum, u) => sum + u.bytes, 0),
    destinations: usage,
  });
});

module.exports = { router };
