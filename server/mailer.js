'use strict';

/**
 * Envoi d'e-mails (nodemailer), configuré depuis Paramètres → SMTP.
 *
 * ⚠️ Le SMTP n'a jamais été testé en conditions réelles à ce jour. Tout ce qui
 * en dépend doit donc rester utilisable sans lui : les appelants reçoivent une
 * erreur explicite plutôt qu'un échec silencieux, et un administrateur garde
 * toujours un moyen manuel de faire la même chose.
 *
 * Corollaire : aucune attente infinie. Les délais sont bornés (10 s) pour
 * qu'un serveur injoignable rende la main tout de suite, avec un message qui
 * dit ce qui a échoué — DNS, refus, authentification, certificat.
 */

const nodemailer = require('nodemailer');
const crypto = require('./crypto');
const settings = require('./settings');
const applog = require('./applog');

/** Un serveur qui ne répond pas ne doit pas bloquer une requête HTTP. */
const TIMEOUT_MS = 10_000;

/** Modes de chiffrement proposés dans l'interface. */
const SECURE_MODES = [
  { id: 'none', label: 'Aucun', help: 'Connexion en clair — à réserver à un relais local de confiance.' },
  { id: 'starttls', label: 'STARTTLS', help: 'Connexion en clair puis passage en TLS (port 587 en général).' },
  { id: 'tls', label: 'TLS', help: 'TLS dès la connexion, dit « implicite » (port 465 en général).' },
];

/** La configuration SMTP est-elle renseignée ? */
function isConfigured() {
  const policy = settings.securityPolicy();
  return !!policy?.smtp_host;
}

/** Message d'erreur unique, réutilisé partout où le SMTP manque. */
const NOT_CONFIGURED_MESSAGE =
  'Envoi impossible : serveur SMTP non configuré, contactez l\'administrateur.';

/**
 * Mode de chiffrement effectif.
 * Historiquement il était déduit du port (465 = TLS implicite) : une
 * configuration enregistrée avant ce réglage garde exactement ce comportement.
 * @returns {'none'|'starttls'|'tls'}
 */
function secureMode(policy) {
  const stored = String(policy?.smtp_secure || '').toLowerCase();
  if (SECURE_MODES.some((m) => m.id === stored)) return stored;
  return Number(policy?.smtp_port) === 465 ? 'tls' : 'starttls';
}

function transport(policy = settings.securityPolicy()) {
  if (!policy?.smtp_host) {
    const err = new Error(NOT_CONFIGURED_MESSAGE);
    err.statusCode = 503;
    err.code = 'SMTP_NOT_CONFIGURED';
    // L'utilisateur doit lire ce message tel quel, pas « erreur interne ».
    err.expose = true;
    throw err;
  }

  const pass = policy.smtp_pass_encrypted ? crypto.decrypt(policy.smtp_pass_encrypted) : undefined;
  const mode = secureMode(policy);

  return nodemailer.createTransport({
    host: policy.smtp_host,
    port: policy.smtp_port || 587,
    secure: mode === 'tls',
    // STARTTLS exigé : on refuse de retomber en clair sans le dire.
    requireTLS: mode === 'starttls',
    ignoreTLS: mode === 'none',
    auth: policy.smtp_user ? { user: policy.smtp_user, pass } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

/** Adresse d'expédition, avec le nom d'expéditeur s'il est renseigné. */
function sender(policy = settings.securityPolicy()) {
  const address = policy?.smtp_from || policy?.smtp_user || 'crabe@localhost';
  const name = String(policy?.smtp_from_name || '').trim();
  return name ? `${name} <${address}>` : address;
}

/**
 * Traduit une erreur nodemailer en phrase actionnable.
 *
 * Un « Échec de l'envoi — connect ECONNREFUSED 10.0.0.1:587 » ne dit pas quoi
 * corriger ; « le serveur a refusé la connexion » avec la piste correspondante,
 * si.
 *
 * @param {Error & {code?: string, command?: string, responseCode?: number}} err
 * @param {{host?: string, port?: number|string}} [context]
 * @returns {string}
 */
function describeError(err, context = {}) {
  const where = context.host ? `${context.host}:${context.port || 587}` : 'le serveur SMTP';
  const raw = String(err?.message || 'erreur inconnue');
  const code = String(err?.code || '');

  if (code === 'SMTP_NOT_CONFIGURED') return NOT_CONFIGURED_MESSAGE;

  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return (
      `Hôte introuvable : le nom « ${context.host || '?'} » n'a pas pu être résolu (DNS). ` +
      'Vérifiez l\'orthographe, ou utilisez directement une adresse IP.'
    );
  }
  if (code === 'ECONNREFUSED') {
    return (
      `Connexion refusée par ${where} : rien n'écoute sur ce port. ` +
      'Vérifiez le port (587 pour STARTTLS, 465 pour TLS, 25 pour un relais local).'
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || /timeout|timed out/i.test(raw)) {
    return (
      `Délai dépassé en contactant ${where} (${TIMEOUT_MS / 1000} s) : ` +
      'serveur injoignable, ou trafic bloqué par un pare-feu.'
    );
  }
  if (code === 'EAUTH' || err?.responseCode === 535 || err?.responseCode === 534) {
    return (
      'Authentification refusée par le serveur : identifiant ou mot de passe incorrect. ' +
      `Réponse du serveur : ${raw}`
    );
  }
  if (/certificate|self.signed|altname|CERT_|SSL/i.test(raw) || code === 'ESOCKET') {
    return (
      `Échec TLS avec ${where} : ${raw}. ` +
      'Certificat auto-signé ou nom d\'hôte qui ne correspond pas — vérifiez le mode de ' +
      'chiffrement choisi (aucun / STARTTLS / TLS).'
    );
  }
  if (code === 'EENVELOPE') {
    return `Adresse refusée par le serveur : ${raw}`;
  }
  if (code === 'EMESSAGE') {
    return `Message refusé par le serveur : ${raw}`;
  }
  return `Échec de l'envoi — ${raw}`;
}

/**
 * Envoie un message.
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{ok: true}>}
 * @throws {Error} avec `code = 'SMTP_NOT_CONFIGURED'` si rien n'est configuré
 */
async function send({ to, subject, text }) {
  const policy = settings.securityPolicy();
  const target = String(to || '').trim();
  if (!target) {
    const err = new Error('Aucun destinataire.');
    err.statusCode = 400;
    throw err;
  }

  const mail = transport(policy);
  try {
    await mail.sendMail({ from: sender(policy), to: target, subject, text });
  } catch (err) {
    // Le message brut de nodemailer reste dans le journal ; l'appelant, lui,
    // reçoit une phrase qui dit quoi corriger.
    const explained = new Error(
      describeError(err, { host: policy.smtp_host, port: policy.smtp_port })
    );
    explained.statusCode = 502;
    explained.expose = true;
    explained.cause = err;
    throw explained;
  }
  applog.info('mailer', `E-mail « ${subject} » envoyé à ${target}.`);
  return { ok: true };
}

/**
 * Envoi « best effort » : ne fait pas échouer l'appelant.
 * Utilisé pour les notifications secondaires (prévenir l'ancienne adresse d'un
 * changement, par exemple) : leur échec ne doit pas bloquer le parcours.
 *
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
async function trySend(message) {
  try {
    await send(message);
    return { ok: true };
  } catch (err) {
    applog.warn('mailer', `E-mail « ${message.subject} » non envoyé — ${err.message}`);
    return { ok: false, message: err.message };
  }
}

module.exports = {
  isConfigured,
  send,
  trySend,
  transport,
  sender,
  secureMode,
  describeError,
  SECURE_MODES,
  TIMEOUT_MS,
  NOT_CONFIGURED_MESSAGE,
};
