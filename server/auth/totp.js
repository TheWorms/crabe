'use strict';

/**
 * Double authentification TOTP (RFC 6238).
 *
 * Le secret est généré côté serveur, chiffré avant stockage (crypto.js) et
 * n'est renvoyé au client qu'une seule fois, au moment du setup, avec le
 * QR code correspondant.
 */

const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = 'crabe';

// Tolérance d'une fenêtre de 30 s avant/après, pour les horloges qui dérivent.
authenticator.options = { window: 1 };

/** Génère un nouveau secret base32. */
function generateSecret() {
  return authenticator.generateSecret();
}

/** URI otpauth:// à encoder dans le QR code. */
function keyUri(username, secret) {
  return authenticator.keyuri(username, ISSUER, secret);
}

/**
 * Génère le QR code de setup.
 * @returns {Promise<string>} data URI PNG
 */
async function qrDataUrl(username, secret) {
  return QRCode.toDataURL(keyUri(username, secret), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });
}

/**
 * Vérifie un code à 6 chiffres.
 * @param {string} token saisi par l'utilisateur (espaces tolérés)
 * @param {string} secret secret base32 déchiffré
 */
function verify(token, secret) {
  if (!token || !secret) return false;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, secret);
  } catch {
    return false;
  }
}

/** Code courant — utilisé uniquement par les tests. */
function currentToken(secret) {
  return authenticator.generate(secret);
}

module.exports = { ISSUER, generateSecret, keyUri, qrDataUrl, verify, currentToken };
