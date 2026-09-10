'use strict';

/**
 * Hachage des mots de passe (Argon2id) et politique de complexité.
 *
 * L'implémentation Argon2id vient de libsodium (`crypto_pwhash_str`), qui
 * produit et vérifie des chaînes au format standard `$argon2id$v=19$...`.
 * Cela évite une dépendance native compilée (node-gyp) sur le LXC.
 */

const sodium = require('libsodium-wrappers-sumo');

/** Règles par niveau, telles qu'affichées dans l'UI d'administration. */
const POLICIES = {
  low: {
    id: 'low',
    label: 'Faible (6 caractères min.)',
    minLength: 6,
    requireDigit: false,
    requireUpper: false,
    requireSymbol: false,
  },
  medium: {
    id: 'medium',
    label: 'Moyenne (8 caractères, chiffre)',
    minLength: 8,
    requireDigit: true,
    requireUpper: false,
    requireSymbol: false,
  },
  high: {
    id: 'high',
    label: 'Forte (12 caractères, majuscule, chiffre, symbole)',
    minLength: 12,
    requireDigit: true,
    requireUpper: true,
    requireSymbol: true,
  },
};

async function ready() {
  await sodium.ready;
}

/**
 * Hache un mot de passe.
 * @param {string} plain
 * @returns {Promise<string>} chaîne Argon2id complète (sel inclus)
 */
async function hash(plain) {
  await sodium.ready;
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Mot de passe vide.');
  }
  return sodium.crypto_pwhash_str(
    plain,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  );
}

/**
 * Vérifie un mot de passe contre son hash.
 * @returns {Promise<boolean>} false plutôt qu'une exception si le hash est illisible
 */
async function verify(storedHash, plain) {
  await sodium.ready;
  if (!storedHash || typeof plain !== 'string') return false;
  try {
    return sodium.crypto_pwhash_str_verify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * Applique la politique de complexité.
 * @param {string} plain
 * @param {'low'|'medium'|'high'} level
 * @returns {{ok: boolean, errors: string[]}}
 */
function check(plain, level = 'medium') {
  const policy = POLICIES[level] || POLICIES.medium;
  const errors = [];
  const value = typeof plain === 'string' ? plain : '';

  if (value.length < policy.minLength) {
    errors.push(`Le mot de passe doit faire au moins ${policy.minLength} caractères.`);
  }
  if (policy.requireDigit && !/[0-9]/.test(value)) {
    errors.push('Le mot de passe doit contenir au moins un chiffre.');
  }
  if (policy.requireUpper && !/[A-Z]/.test(value)) {
    errors.push('Le mot de passe doit contenir au moins une majuscule.');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(value)) {
    errors.push('Le mot de passe doit contenir au moins un symbole.');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Estimation de la force, pour le bloc « Sécurité du compte » du profil.
 * @returns {'Faible'|'Moyenne'|'Forte'}
 */
function strength(plain) {
  const value = typeof plain === 'string' ? plain : '';
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (value.length >= 16) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  if (score <= 2) return 'Faible';
  if (score <= 4) return 'Moyenne';
  return 'Forte';
}

module.exports = { POLICIES, ready, hash, verify, check, strength };
