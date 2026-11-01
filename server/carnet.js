'use strict';

/**
 * Le carnet d'identifiants (0.2.13) — Profil › Identifiants.
 *
 * Demande de l'utilisateur du 01/11/2026 : « évite le doublon ». Ses décisions :
 *   - le carnet est propre à chaque compte crabe ;
 *   - les fiches existantes ne bougent pas : rien n'y entre d'office, une
 *     fiche ne suit une entrée que si on l'y relie (« choisir dans le
 *     carnet ») ;
 *   - tout reste séparé : « Enregistrer ces identifiants » (0.2.12) range
 *     dans la fiche seulement, et délie le service de son entrée ;
 *   - une entrée reliée à plusieurs services se change en un seul endroit.
 *
 * Chaque secret ({identifiant, motDePasse}) est chiffré et LIÉ à son compte et
 * à son entrée (`crypto.chiffrerLie`, XChaCha20-Poly1305) : recopié sur une
 * autre ligne, il ne se déchiffre pas. Le mot de passe ne sort jamais de ce
 * module vers une vue : `lister` rend l'identifiant (l'adresse), jamais le
 * mot de passe.
 */

const db = require('./db/db');
const crypto = require('./crypto');

const LIBELLE_MAX = 60;
const IDENTIFIANT_MAX = 254;
const MOT_DE_PASSE_MAX = 1024;

const contexte = (userId, id) => `crabe:carnet:compte ${Number(userId)}:entrée ${Number(id)}`;

function erreur(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function ligne(userId, id) {
  const l = db.get().prepare('SELECT * FROM carnet_identifiants WHERE id = ? AND user_id = ?').get(Number(id), Number(userId));
  if (!l) throw erreur('Cette entrée du carnet n\'existe pas.', 404);
  return l;
}

function secretDe(l) {
  return JSON.parse(crypto.dechiffrerLie(l.secret, contexte(l.user_id, l.id)));
}

function nettoyer({ libelle, identifiant, motDePasse }, { motDePasseRequis }) {
  const l = String(libelle ?? '').trim();
  const i = String(identifiant ?? '').trim();
  const m = motDePasse === undefined || motDePasse === null ? '' : String(motDePasse);
  if (!l) throw erreur('Donnez un nom à cette entrée (par exemple « Perso »).');
  if (l.length > LIBELLE_MAX) throw erreur(`Le nom tient en ${LIBELLE_MAX} caractères.`);
  if (i.length > IDENTIFIANT_MAX || /[\r\n]/.test(i)) throw erreur('Cet identifiant n\'est pas valable.');
  if (motDePasseRequis && !m) throw erreur('Le mot de passe est obligatoire.');
  if (m.length > MOT_DE_PASSE_MAX) throw erreur('Ce mot de passe est trop long.');
  return { libelle: l, identifiant: i, motDePasse: m };
}

/** Les services d'un compte reliés à chaque entrée : { idEntrée: [connectorId] }. */
function reliesParEntree(userId) {
  const par = new Map();
  for (const r of db.get().prepare(
    'SELECT carnet_id, connector_id FROM connector_installs WHERE user_id = ? AND carnet_id IS NOT NULL ORDER BY connector_id'
  ).all(Number(userId))) {
    if (!par.has(r.carnet_id)) par.set(r.carnet_id, []);
    par.get(r.carnet_id).push(r.connector_id);
  }
  return par;
}

/** Les entrées d'un compte : nom, identifiant (l'adresse), services reliés. Jamais le mot de passe. */
function lister(userId) {
  const relies = reliesParEntree(userId);
  return db.get().prepare('SELECT * FROM carnet_identifiants WHERE user_id = ? ORDER BY libelle COLLATE NOCASE, id')
    .all(Number(userId))
    .map((l) => {
      let identifiant = '';
      let lisible = true;
      try {
        identifiant = secretDe(l).identifiant || '';
      } catch {
        lisible = false;
      }
      return { id: l.id, libelle: l.libelle, identifiant, lisible, services: relies.get(l.id) || [], misAJour: l.updated_at };
    });
}

function creer(userId, valeurs) {
  const v = nettoyer(valeurs, { motDePasseRequis: true });
  const base = db.get();
  return base.transaction(() => {
    // Le secret est lié à l'entrée : il s'écrit une fois son numéro connu.
    const { lastInsertRowid } = base.prepare(
      "INSERT INTO carnet_identifiants (user_id, libelle, secret) VALUES (?, ?, '')"
    ).run(Number(userId), v.libelle);
    const id = Number(lastInsertRowid);
    base.prepare('UPDATE carnet_identifiants SET secret = ? WHERE id = ?')
      .run(crypto.chiffrerLie({ identifiant: v.identifiant, motDePasse: v.motDePasse }, contexte(userId, id)), id);
    return id;
  })();
}

/** Mot de passe vide : celui de l'entrée est gardé. */
function modifier(userId, id, valeurs) {
  const l = ligne(userId, id);
  const v = nettoyer(valeurs, { motDePasseRequis: false });
  const ancien = secretDe(l);
  const secret = { identifiant: v.identifiant, motDePasse: v.motDePasse || ancien.motDePasse };
  db.get().prepare("UPDATE carnet_identifiants SET libelle = ?, secret = ?, updated_at = datetime('now') WHERE id = ?")
    .run(v.libelle, crypto.chiffrerLie(secret, contexte(userId, l.id)), l.id);
}

/** Refusé tant qu'un service y est relié : on ne laisse pas une fiche sans identifiants en silence. */
function supprimer(userId, id) {
  const l = ligne(userId, id);
  const services = reliesParEntree(userId).get(l.id) || [];
  if (services.length) {
    throw erreur(`Cette entrée sert encore à ${services.join(', ')} : choisissez d'abord d'autres identifiants pour ce${services.length > 1 ? 's' : ''} service${services.length > 1 ? 's' : ''}.`, 409);
  }
  db.get().prepare('DELETE FROM carnet_identifiants WHERE id = ?').run(l.id);
}

/** Relie un service à une entrée du compte, ou le délie (`id` null). */
function relier(userId, connectorId, id) {
  if (id !== null && id !== undefined && id !== '') ligne(userId, id);
  db.get().prepare('UPDATE connector_installs SET carnet_id = ? WHERE user_id = ? AND connector_id = ?')
    .run(id === null || id === undefined || id === '' ? null : Number(id), Number(userId), connectorId);
}

/** L'entrée reliée à un service : `{ id, libelle, identifiant }`, ou null. */
function entreeDe(userId, connectorId) {
  const r = db.get().prepare('SELECT carnet_id FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(Number(userId), connectorId);
  if (!r?.carnet_id) return null;
  const l = db.get().prepare('SELECT * FROM carnet_identifiants WHERE id = ? AND user_id = ?').get(r.carnet_id, Number(userId));
  if (!l) return null;
  try {
    return { id: l.id, libelle: l.libelle, identifiant: secretDe(l).identifiant || '' };
  } catch {
    return { id: l.id, libelle: l.libelle, identifiant: '', illisible: true };
  }
}

/**
 * Les identifiants d'un service relié, pour sa configuration (registry.
 * readConfig) : `{ identifiant, motDePasse }`, ou null s'il n'est pas relié.
 * Lève si l'entrée ne se déchiffre pas : un service ne part jamais avec des
 * identifiants faux en silence.
 */
function identifiantsDe(userId, connectorId) {
  const r = db.get().prepare('SELECT carnet_id FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(Number(userId), connectorId);
  if (!r?.carnet_id) return null;
  const l = db.get().prepare('SELECT * FROM carnet_identifiants WHERE id = ? AND user_id = ?').get(r.carnet_id, Number(userId));
  if (!l) return null;
  try {
    return secretDe(l);
  } catch {
    throw erreur('Les identifiants de ce service (carnet) ne se déchiffrent pas : choisissez-les de nouveau dans sa fiche.', 409);
  }
}

module.exports = { lister, creer, modifier, supprimer, relier, entreeDe, identifiantsDe, contexte };
