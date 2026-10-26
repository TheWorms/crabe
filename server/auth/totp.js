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

/**
 * Dernier pas de temps TOTP accepté, par compte.
 *
 * Un code reste valide 30 à 90 s (fenêtre ±1) : sans trace du dernier code
 * servi, le même code rejoué dans cet intervalle était accepté une seconde
 * fois. On retient le pas de temps (numéro de tranche de 30 s) du dernier code
 * accepté et on refuse tout code d'un pas déjà atteint. En mémoire : crabe est
 * un unique processus, et la fenêtre de rejeu (90 s) ne survit pas à un
 * redémarrage. La table reste bornée au nombre de comptes.
 */
const dernierPasAccepte = new Map();

/** Pas de temps (tranche de 30 s depuis l'époque) à l'instant présent. */
function pasActuel() {
  return Math.floor(Date.now() / 1000 / 30);
}

/**
 * Comme `verify`, mais à usage unique : un code accepté pour un compte ne peut
 * pas resservir tant que son pas de temps n'est pas passé. À utiliser à la
 * connexion, où le rejeu est un risque (pas à l'enrôlement, qui est unique).
 * @param {string} token saisi par l'utilisateur
 * @param {string} secret secret base32 déchiffré
 * @param {number} userId compte concerné
 */
function verifyOnce(token, secret, userId) {
  if (!verify(token, secret)) return false;
  let delta = null;
  try {
    delta = authenticator.checkDelta(String(token).replace(/\s+/g, ''), secret);
  } catch {
    delta = null;
  }
  if (delta === null) return false; // ne devrait pas arriver après verify()
  const pas = pasActuel() + delta;
  const dernier = dernierPasAccepte.get(userId);
  if (dernier !== undefined && pas <= dernier) return false; // code déjà servi
  dernierPasAccepte.set(userId, pas);
  return true;
}

/** Code courant — utilisé uniquement par les tests. */
function currentToken(secret) {
  return authenticator.generate(secret);
}

/** Remet à zéro la mémoire des pas acceptés — utilisé uniquement par les tests. */
function _resetReplayGuard() {
  dernierPasAccepte.clear();
}

module.exports = {
  ISSUER,
  generateSecret,
  keyUri,
  qrDataUrl,
  verify,
  verifyOnce,
  currentToken,
  _resetReplayGuard,
};
