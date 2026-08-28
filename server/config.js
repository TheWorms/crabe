'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Charge un fichier .env minimaliste (pas de dépendance dotenv).
 * Les variables déjà présentes dans process.env ne sont jamais écrasées.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

const dataDir = path.resolve(ROOT, process.env.CRABE_DATA_DIR || './data');

const config = {
  root: ROOT,
  version: require('../package.json').version,
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.CRABE_PORT || 3000),
  host: process.env.CRABE_HOST || '0.0.0.0',
  // Nombre de proxies de confiance devant crabe : sert UNIQUEMENT à connaître
  // l'IP réelle du client (X-Forwarded-For).
  trustProxy: Number(process.env.CRABE_TRUST_PROXY || 0),

  // Exiger HTTPS pour le cookie de session. Volontairement découplé de
  // trustProxy : crabe est servi en HTTP derrière Caddy sur le LAN, et un
  // cookie « Secure » ne serait jamais renvoyé par le navigateur — c'était la
  // cause du login qui bouclait indéfiniment.
  cookieSecure: /^(1|true|yes)$/i.test(String(process.env.CRABE_COOKIE_SECURE || '0')),

  dataDir,
  dbFile: path.join(dataDir, 'crabe.db'),

  // Racine de la destination locale pour une installation neuve.
  // C'est un POINT DE MONTAGE, pas un sous-dossier de dataDir : l'unité
  // systemd n'autorise l'écriture que sur /opt/crabe/data et /mnt/local.
  // Un chemin déjà personnalisé dans l'interface n'est jamais écrasé.
  localPath: process.env.CRABE_LOCAL_PATH || '/mnt/local',
  // Pas de répertoire « invoices » : les factures partent directement du
  // buffer mémoire vers les destinations, sans zone tampon sur disque — et
  // « invoices » n'apparaît donc jamais dans l'arborescence de destination.
  exportsDir: path.join(dataDir, 'exports'),

  // Diagnostics d'échec de connecteur (lot 14, §4) : HTML masqué, capture
  // d'écran, liens et contexte, réservés à l'administration.
  //
  // Sous `dataDir` et non `/var/lib/crabe` : en production, `dataDir` vaut
  // `/opt/crabe/data`, seul chemin inscriptible déclaré par l'unité systemd et
  // seul chemin repris par la sauvegarde d'avant déploiement. Des diagnostics
  // écrits ailleurs seraient hors sauvegarde, et l'unité les refuserait.
  diagnosticsDir: process.env.CRABE_DIAGNOSTICS_DIR
    ? path.resolve(process.env.CRABE_DIAGNOSTICS_DIR)
    : path.join(dataDir, 'diagnostics'),

  masterPassphrase: process.env.CRABE_MASTER_PASSPHRASE || '',
  sessionSecret: process.env.CRABE_SESSION_SECRET || '',

  allowedCidrs: (process.env.CRABE_ALLOWED_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rcloneBin: process.env.CRABE_RCLONE_BIN || 'rclone',
  rcloneConf: process.env.CRABE_RCLONE_CONF || path.join(dataDir, 'rclone.conf'),

  bootstrapAdmin: {
    username: process.env.CRABE_ADMIN_USERNAME || 'admin',
    password: process.env.CRABE_ADMIN_PASSWORD || '',
    email: process.env.CRABE_ADMIN_EMAIL || '',
  },

  schedulerDisabled: process.env.CRABE_DISABLE_SCHEDULER === '1',

  // Interdit d'ouvrir un navigateur vers un site de fournisseur.
  //
  // Ajouté au lot 5, en même temps que `playwright` en dépendance
  // optionnelle : jusque-là, la machine de développement n'avait pas
  // Playwright et les recettes de scraping retombaient d'elles-mêmes sur leur
  // mode simulé. Une fois la dépendance installée, la suite de tests se
  // mettait à ouvrir de vrais navigateurs vers EDF, Orange ou SFR avec des
  // identifiants inventés — ce qu'aucun test ne doit faire.
  //
  // `test/helpers.js` pose donc ce drapeau. En production il reste vide, et
  // rien ne change.
  scrapingDisabled: process.env.CRABE_DISABLE_SCRAPING === '1',
};

/**
 * Vérifie les variables sans lesquelles le service ne peut pas démarrer.
 * @returns {string[]} liste des erreurs bloquantes
 */
function validate() {
  const errors = [];
  if (!config.masterPassphrase) {
    errors.push(
      'CRABE_MASTER_PASSPHRASE est vide — impossible de déchiffrer les secrets stockés.'
    );
  } else if (config.masterPassphrase.length < 12) {
    errors.push('CRABE_MASTER_PASSPHRASE doit faire au moins 12 caractères.');
  }
  if (!config.sessionSecret) {
    errors.push(
      'CRABE_SESSION_SECRET est vide — générez-le avec : openssl rand -hex 32'
    );
  }
  return errors;
}

module.exports = { config, validate, loadDotEnv };
