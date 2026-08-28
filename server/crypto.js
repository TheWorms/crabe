'use strict';

/**
 * Chiffrement au repos des secrets de crabe.
 *
 * - Primitive : libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305, AEAD).
 * - Clé maîtresse : dérivée de CRABE_MASTER_PASSPHRASE via `crypto_pwhash`
 *   (Argon2id), avec un sel persisté dans <dataDir>/master.salt.
 * - La passphrase n'est jamais écrite sur disque ; seul le sel l'est.
 *
 * Format d'un secret chiffré (chaîne stockée en base) :
 *     v1.<nonce base64>.<ciphertext base64>
 */

const fs = require('node:fs');
const path = require('node:path');
const sodium = require('libsodium-wrappers-sumo');
const { config } = require('./config');

const PREFIX = 'v1';

let masterKey = null;
let ready = false;

/** Charge le sel maître, en le générant au premier démarrage. */
function loadOrCreateSalt(dataDir) {
  const saltFile = path.join(dataDir, 'master.salt');
  if (fs.existsSync(saltFile)) {
    const salt = fs.readFileSync(saltFile);
    if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
      throw new Error(
        `Sel maître corrompu (${salt.length} octets au lieu de ${sodium.crypto_pwhash_SALTBYTES}) : ${saltFile}`
      );
    }
    return salt;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const salt = Buffer.from(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
  fs.writeFileSync(saltFile, salt, { mode: 0o600 });
  return salt;
}

/**
 * Initialise le module. À appeler une fois au démarrage, avant tout
 * appel à encrypt/decrypt.
 * @param {{passphrase?: string, dataDir?: string}} [opts]
 */
async function init(opts = {}) {
  await sodium.ready;

  const passphrase = opts.passphrase ?? config.masterPassphrase;
  const dataDir = opts.dataDir ?? config.dataDir;

  if (!passphrase) {
    throw new Error('CRABE_MASTER_PASSPHRASE manquante : impossible de dériver la clé maîtresse.');
  }

  const salt = loadOrCreateSalt(dataDir);

  masterKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  ready = true;
}

function assertReady() {
  if (!ready) throw new Error('crypto.init() n\'a pas été appelé.');
}

/**
 * Chiffre une chaîne (ou un objet, sérialisé en JSON).
 * @param {string|object|null|undefined} value
 * @returns {string|null}
 */
function encrypt(value) {
  assertReady();
  if (value === null || value === undefined) return null;
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    sodium.from_string(plaintext),
    nonce,
    masterKey
  );
  return `${PREFIX}.${Buffer.from(nonce).toString('base64')}.${Buffer.from(cipher).toString('base64')}`;
}

/**
 * Déchiffre une chaîne produite par encrypt().
 * @param {string|null|undefined} blob
 * @returns {string|null}
 * @throws si le blob est altéré ou la clé maîtresse incorrecte
 */
function decrypt(blob) {
  assertReady();
  if (blob === null || blob === undefined || blob === '') return null;
  const parts = String(blob).split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new Error('Format de secret chiffré invalide.');
  }
  const nonce = Buffer.from(parts[1], 'base64');
  const cipher = Buffer.from(parts[2], 'base64');
  let plain;
  try {
    plain = sodium.crypto_secretbox_open_easy(cipher, nonce, masterKey);
  } catch {
    throw new Error(
      'Déchiffrement impossible : passphrase maîtresse incorrecte ou donnée altérée.'
    );
  }
  return sodium.to_string(plain);
}

/** Comme decrypt(), mais renvoie un objet JSON. */
function decryptJson(blob) {
  const plain = decrypt(blob);
  if (plain === null) return null;
  try {
    return JSON.parse(plain);
  } catch {
    throw new Error('Secret déchiffré illisible (JSON invalide).');
  }
}

/** Comme decryptJson(), mais renvoie `fallback` au lieu de lever. */
function tryDecryptJson(blob, fallback = null) {
  try {
    return decryptJson(blob);
  } catch {
    return fallback;
  }
}

/** Jeton aléatoire hexadécimal (identifiants d'export, reset, etc.). */
function randomToken(bytes = 32) {
  assertReady();
  return Buffer.from(sodium.randombytes_buf(bytes)).toString('hex');
}

/** Comparaison à temps constant de deux chaînes. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return require('node:crypto').timingSafeEqual(bufA, bufB);
}

module.exports = {
  init,
  encrypt,
  decrypt,
  decryptJson,
  tryDecryptJson,
  randomToken,
  timingSafeEqual,
  get isReady() {
    return ready;
  },
};
