'use strict';

/**
 * Les connexions par la fenêtre « Se connecter » (0.2.19, lot l26).
 *
 * Demande de l'utilisateur, le 01/11/2026 : une connexion par la fenêtre qui
 * n'aboutissait pas n'apparaissait nulle part — ni comme une ligne en échec
 * dans Logs › Connecteurs, ni comme un « Rapport » à envoyer, ni sur la fiche
 * du service. Ses lignes de journal (`remote-browser:<id>`) s'y mêlaient,
 * sans rien qui dise : « cette tentative-là n'a pas abouti, et voici
 * pourquoi ».
 *
 * Une ligne par fenêtre ouverte (`connexions_fenetre`, migration 75), écrite
 * par le gestionnaire de la fenêtre à l'ouverture et à l'extinction — son
 * issue, la raison affichée, le nombre de vérifications. HORS de `run_logs` :
 * l'état, les couleurs et les statistiques d'un service lisent cette table-là,
 * et une fenêtre n'est pas une récupération.
 *
 * Le rapport d'une tentative reprend le gabarit de celui d'une récupération
 * (rapport-echec.js) : l'installation, la tentative, et les lignes que la
 * fenêtre a écrites pendant qu'elle était ouverte — une seule fenêtre à la
 * fois sur une installation, ses lignes sont donc les siennes. Anonymisé de
 * la même façon.
 */

const db = require('./db/db');
const rapportEchec = require('./rapport-echec');

/** L'issue d'une fenêtre, depuis l'état final de sa session. */
const ISSUES = {
  saved: 'enregistree',
  cancelled: 'annulee',
  timeout: 'expiree',
  error: 'erreur',
};

const LIBELLES = {
  enregistree: 'connexion enregistrée',
  annulee: 'fermée sans enregistrer',
  expiree: 'fermée après le délai',
  erreur: 'en erreur',
};

/** La fenêtre s'ouvre : rend le numéro de sa ligne. */
function ouvrir(userId, connectorId) {
  return Number(db.get().prepare(
    'INSERT INTO connexions_fenetre (user_id, connector_id) VALUES (?, ?)'
  ).run(Number(userId), String(connectorId)).lastInsertRowid);
}

/** La fenêtre s'éteint : son issue, sa raison, ses vérifications. */
function fermer(id, { etat, message = '', verifications = 0 }) {
  db.get().prepare(
    `UPDATE connexions_fenetre SET fin = datetime('now'), issue = ?, message = ?, verifications = ?
      WHERE id = ? AND fin IS NULL`
  ).run(ISSUES[etat] || 'erreur', String(message || '').slice(0, 1000), Number(verifications) || 0, Number(id));
}

/** La dernière tentative d'un service, pour sa fiche : `{ id, at, issue, libelle, message }` ou null. */
function derniere(userId, connectorId) {
  const l = db.get().prepare(
    `SELECT id, debut, fin, issue, message FROM connexions_fenetre
      WHERE user_id = ? AND connector_id = ? AND fin IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get(Number(userId), String(connectorId));
  if (!l) return null;
  return { id: l.id, at: l.fin, issue: l.issue, libelle: LIBELLES[l.issue] || l.issue, message: l.message || '' };
}

/** Les tentatives pour Logs › Connecteurs, au format d'une ligne de l'écran. */
function pourLeJournal({ connectorId = null, resultat = 'all', recherche = '', limite = 200 } = {}) {
  const clauses = ['c.fin IS NOT NULL'];
  const params = [];
  if (connectorId && connectorId !== 'all') {
    clauses.push('c.connector_id = ?');
    params.push(connectorId);
  }
  if (resultat === 'success') clauses.push("c.issue = 'enregistree'");
  else if (resultat === 'failure') clauses.push("c.issue != 'enregistree'");
  else if (resultat !== 'all') return [];
  if (recherche) {
    clauses.push('(c.message LIKE ? OR u.username LIKE ?)');
    params.push(`%${recherche}%`, `%${recherche}%`);
  }
  params.push(limite);
  return db.get().prepare(
    `SELECT c.id, c.connector_id, c.debut, c.fin, c.issue, c.message, c.verifications,
            COALESCE(u.username, '(compte supprimé)') AS username
       FROM connexions_fenetre c LEFT JOIN users u ON u.id = c.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.debut DESC, c.id DESC LIMIT ?`
  ).all(...params).map((c) => ({
    kind: 'fenetre',
    id: c.id,
    connector_id: c.connector_id,
    started_at: c.debut,
    finished_at: c.fin,
    success: c.issue === 'enregistree' ? 1 : 0,
    issue: c.issue,
    libelle: LIBELLES[c.issue] || c.issue,
    message: c.message,
    verifications: c.verifications,
    username: c.username,
  }));
}

/**
 * Le rapport d'une tentative : `{ nomFichier, texte }`, ou null. `userId`
 * restreint au compte (la fiche) ; sans lui, l'administration.
 */
function rapport(id, { userId = null, fuseau = '', maintenant = new Date() } = {}) {
  const database = db.get();
  const c = database.prepare(
    `SELECT id, user_id, connector_id, debut, fin, issue, message, verifications
       FROM connexions_fenetre WHERE id = ?${userId === null ? '' : ' AND user_id = ?'}`
  ).get(...(userId === null ? [Number(id)] : [Number(id), Number(userId)]));
  if (!c || !c.fin) return null;

  const registry = require('./connectors/registry');
  const nom = registry.has(c.connector_id) ? registry.manifest(c.connector_id).name : c.connector_id;
  const comptes = database.prepare('SELECT username, email, phone FROM users').all();
  const propre = (texte) => rapportEchec.anonymiser(texte, { comptes });
  // Les lignes de LA fenêtre : écrites pendant qu'elle était ouverte, sous sa
  // source (`remote-browser:<id>`) ou celle du gestionnaire (`remote-browser`).
  const lignes = database.prepare(
    `SELECT at, level, source, message FROM app_logs
      WHERE source IN (?, 'remote-browser') AND at >= ? AND at <= datetime(?, '+5 seconds')
      ORDER BY id`
  ).all(`remote-browser:${c.connector_id}`, c.debut, c.fin);
  const precedentes = database.prepare(
    `SELECT id, debut, issue FROM connexions_fenetre
      WHERE user_id = ? AND connector_id = ? AND id < ? AND fin IS NOT NULL ORDER BY id DESC LIMIT 5`
  ).all(c.user_id, c.connector_id, c.id);

  const signalement = rapportEchec.adresseDeSignalement();
  const texte = [
    `Rapport de la connexion par la fenêtre n° ${c.id} — crabe`,
    '',
    'Relisez ce fichier avant de l\'envoyer. crabe en a retiré les noms de compte, les adresses',
    'e-mail, les numéros de téléphone, les adresses IP, les jetons et le détail des adresses web ;',
    'il ne contient ni identifiant, ni mot de passe, ni cookie. Ce que vous avez TAPÉ dans la',
    'fenêtre n\'y est jamais : seulement le nombre de caractères.',
    '',
    signalement
      ? `Pour signaler le problème : joignez ce fichier à une issue (${signalement}),\navec ce que vous attendiez.`
      : 'Pour signaler le problème : joignez ce fichier à votre signalement, avec ce que vous attendiez.',
    '',
    '## Installation',
    '',
    rapportEchec.colonnes([...rapportEchec.environnement({ database, fuseau }),
      ['Rapport fait le', `${maintenant.toISOString().slice(0, 19).replace('T', ' ')} (UTC)`]]),
    '',
    `## Connexion par la fenêtre n° ${c.id}`,
    '',
    rapportEchec.colonnes([
      ['Service', `${nom} (${c.connector_id})`],
      ['Ouverte', `${c.debut} (UTC)`],
      ['Fermée', `${c.fin} (UTC)`],
      ['Issue', LIBELLES[c.issue] || c.issue],
      ['Vérifications', `${c.verifications} sans preuve`],
      ['Message', propre(c.message || '(aucun)')],
    ]),
    '',
    '## Les tentatives précédentes de ce service (cinq au plus)',
    '',
    ...(precedentes.length ? precedentes.map((p) => `n° ${p.id}  ${p.debut}  ${LIBELLES[p.issue] || p.issue}`) : ['(aucune)']),
    '',
    `## Journal de la fenêtre (${lignes.length} ligne(s), heures UTC)`,
    '',
    ...(lignes.length
      ? lignes.map((l) => `${String(l.at).slice(11)}  ${l.level.padEnd(5)}  ${l.source.replace(/^remote-browser:?/, 'fenêtre')}  `
        + propre(l.message).split('\n').join('\n          '))
      : ['(aucune ligne)']),
    '',
  ].join('\n');
  return { nomFichier: `crabe-connexion-${c.connector_id}-${c.id}.txt`, texte };
}

module.exports = { ouvrir, fermer, derniere, pourLeJournal, rapport, ISSUES, LIBELLES };
