'use strict';

/**
 * Découverte : les éléments d'un compte fournisseur, choisis un par un.
 *
 * Certains comptes ne portent pas un abonnement mais plusieurs — quatre lignes
 * chez Free Mobile, plusieurs points de livraison chez EDF, plusieurs comptes
 * dans une banque. L'utilisateur doit pouvoir choisir lesquels crabe récupère,
 * et cette liste n'est connue qu'APRÈS connexion : elle ne peut pas figurer
 * dans le manifeste.
 *
 * D'où le trio :
 *   - `discover(config, ctx)` côté connecteur, facultatif, qui remonte les
 *     éléments trouvés (voir registry.js pour le contrat complet) ;
 *   - un champ de manifeste de type `multiselect`, dont les options viennent
 *     de cette découverte et non du fichier ;
 *   - cette table de correspondance, qui garde en mémoire ce qui a DÉJÀ été vu
 *     pour un couple (utilisateur, connecteur).
 *
 * Pourquoi mémoriser les éléments vus, alors que la sélection est déjà dans la
 * configuration chiffrée : sans cette mémoire, une ligne volontairement
 * décochée par l'utilisateur ressemblerait à une nouveauté au passage suivant
 * et serait recochée d'office. Ce qui est nouveau, c'est ce qui n'a jamais été
 * vu — pas ce qui n'est pas sélectionné.
 *
 * Les libellés (nom du titulaire, numéro de ligne) sont des données
 * personnelles : ils sont **chiffrés au repos**, comme la configuration.
 */

const db = require('../db/db');
const crypto = require('../crypto');

/**
 * Le rang d'un élément découvert : deux mots, et l'index seul les décide.
 *
 * ─── Deux lots à se tromper ──────────────────────────────────────────────────
 *
 * Les lots 7 et 8 ont tous deux tenté de LIRE le rang sur le panneau du
 * fournisseur : d'abord la position du titre de section dans le document, puis
 * la remontée d'ancêtres jusqu'au premier titre frère. Les deux fois, la
 * production a affiché « principale » sur les quatre lignes du compte.
 *
 * La cause n'est pas un motif mal écrit : c'est que le rang n'est PAS une
 * information du document. Le panneau porte une seconde copie repliée du menu,
 * ses titres sont posés par la feuille de style, et rien ne garantit qu'un
 * titre précède les entrées auxquelles il se rapporte. Une heuristique de plus
 * ne ferait que déplacer l'endroit où elle se trompe.
 *
 * ─── Ce qui est vrai, et vérifiable ─────────────────────────────────────────
 *
 * L'ORDRE. La découverte parcourt le panneau de haut en bas, et la ligne
 * principale y figure toujours en tête. Le premier élément remonté est donc le
 * principal, tous les suivants sont secondaires — sans exception, sans cas
 * indéterminé, sans badge à inventer.
 *
 * La règle vit ici, dans le socle, et non dans un connecteur : elle vaut pour
 * toute découverte, et aucun connecteur n'a plus à décider d'un badge. Un
 * `badge` remonté par un connecteur est donc ignoré.
 */
const RANG_PRINCIPAL = 'principale';
const RANG_SECONDAIRE = 'secondaire';

/** Le rang d'un élément, d'après sa seule position dans la découverte. */
function rangPourIndex(index) {
  return index === 0 ? RANG_PRINCIPAL : RANG_SECONDAIRE;
}

/** Un identifiant d'élément reste une chaîne courte et imprimable. */
function normalizeId(value) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean && clean.length <= 120 ? clean : null;
}

/**
 * Met un élément découvert en forme, en ignorant ce qui est inexploitable.
 *
 * Le `badge` n'est PAS lu ici : il est posé par `normalizeItems()`, qui seul
 * connaît la position de l'élément dans la liste (voir `rangPourIndex`).
 *
 * @param {*} raw
 * @param {number} [index] position dans la découverte, qui décide du rang
 * @returns {{id: string, label: string, badge: string, detail: string, preselected: boolean}|null}
 */
function normalizeItem(raw, index = 0) {
  const id = normalizeId(raw?.id);
  if (!id) return null;
  return {
    id,
    label: String(raw?.label ?? id).trim().slice(0, 200) || id,
    badge: rangPourIndex(index),
    detail: String(raw?.detail ?? '').trim().slice(0, 200),
    preselected: raw?.preselected !== false,
  };
}

/**
 * Liste d'éléments mise en forme, sans doublon, dans l'ordre remonté.
 *
 * L'ordre est le contrat : c'est lui, et lui seul, qui porte le rang. Les
 * doublons sont écartés AVANT que l'index ne soit attribué, sans quoi un
 * deuxième passage du même identifiant décalerait tout ce qui suit.
 */
function normalizeItems(raw) {
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = normalizeId(entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(normalizeItem(entry, items.length));
  }
  return items;
}

/** Identifiants pré-cochés d'une découverte. */
function preselectedIds(items) {
  return normalizeItems(items).filter((i) => i.preselected).map((i) => i.id);
}

/**
 * Fusionne une découverte avec ce qui était connu, sans appauvrir l'affichage.
 *
 * Une récupération redécouvre les éléments au passage, mais sans en calculer
 * le détail : compter les factures de chaque ligne coûterait une bascule
 * supplémentaire par ligne, pour une information qui ne sert qu'à l'écran de
 * sélection. Écraser bêtement l'existant ferait donc disparaître les
 * « 12 factures » de la fiche à la première synchronisation.
 *
 * Règle : ce qui vient d'être vu fait foi, sauf pour les champs d'affichage
 * laissés vides — label et détail retombent alors sur la dernière valeur
 * connue.
 *
 * @param {Array<object>|null} known
 * @param {Array<object>} discovered
 */
function merge(known, discovered) {
  const previous = new Map(normalizeItems(known || []).map((i) => [i.id, i]));
  return normalizeItems(discovered).map((item) => {
    const old = previous.get(item.id);
    if (!old) return item;
    return {
      ...item,
      label: item.label === item.id && old.label !== old.id ? old.label : item.label,
      detail: item.detail || old.detail,
    };
  });
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

/**
 * Éléments déjà connus pour un couple, ou `null` si aucune découverte n'a
 * jamais été enregistrée.
 *
 * La distinction compte : « jamais découvert » et « découvert, liste vide »
 * n'appellent pas le même comportement.
 *
 * @returns {{items: Array<object>, updatedAt: string}|null}
 */
function read(userId, connectorId, fieldKey) {
  const row = db
    .get()
    .prepare(
      `SELECT items_encrypted, updated_at FROM connector_discoveries
        WHERE user_id = ? AND connector_id = ? AND field_key = ?`
    )
    .get(userId, connectorId, fieldKey);

  if (!row) return null;
  const items = crypto.tryDecryptJson(row.items_encrypted, null);
  if (!Array.isArray(items)) return null;
  return { items: normalizeItems(items), updatedAt: row.updated_at };
}

/** Enregistre (ou remplace) la dernière découverte connue. */
function save(userId, connectorId, fieldKey, items) {
  const clean = normalizeItems(items);
  db.get()
    .prepare(
      `INSERT INTO connector_discoveries (user_id, connector_id, field_key, items_encrypted, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, connector_id, field_key)
       DO UPDATE SET items_encrypted = excluded.items_encrypted,
                     updated_at      = datetime('now')`
    )
    .run(userId, connectorId, fieldKey, crypto.encrypt(clean));
  return clean;
}

/** Oublie les découvertes d'un compte (suppression RGPD, désinstallation). */
function forget(userId, connectorId = null) {
  const database = db.get();
  return connectorId
    ? database
        .prepare('DELETE FROM connector_discoveries WHERE user_id = ? AND connector_id = ?')
        .run(userId, connectorId).changes
    : database.prepare('DELETE FROM connector_discoveries WHERE user_id = ?').run(userId).changes;
}

// ---------------------------------------------------------------------------
// Rapprochement
// ---------------------------------------------------------------------------

/**
 * Confronte ce qui vient d'être découvert à ce qui était connu.
 *
 * Trois cas, et une règle pour chacun :
 *
 *   - **élément jamais vu** → ajouté d'office à la sélection. Une nouvelle
 *     ligne mobile ouverte en cours d'année doit être sauvegardée sans que
 *     personne ait à y penser ; c'est signalé dans les journaux ;
 *   - **élément connu, décoché** → laissé décoché. C'est un choix explicite ;
 *   - **élément disparu de chez le fournisseur** → conservé en configuration,
 *     mais ignoré pour cette exécution, avec un avertissement. Il peut s'agir
 *     d'un affichage incomplet côté fournisseur, pas forcément d'une
 *     résiliation : effacer la sélection serait une perte sèche.
 *
 * Fonction pure : c'est `reconciler()` qui écrit en base.
 *
 * @param {{known: Array<object>|null, discovered: Array<object>, selection: string[]|null}} input
 * @returns {{selection: string[], added: string[], missing: string[], active: Array<object>}}
 */
function reconcile({ known, discovered, selection }) {
  const found = normalizeItems(discovered);
  const foundIds = new Set(found.map((i) => i.id));
  const knownIds = new Set(normalizeItems(known || []).map((i) => i.id));

  // Aucune sélection enregistrée : c'est la première exécution, tout ce qui
  // est pré-coché part sur les rails, et rien n'est « nouveau ».
  const first = !Array.isArray(selection);
  const current = first ? preselectedIds(found) : selection.map(normalizeId).filter(Boolean);

  const chosen = new Set(current);
  const added = [];
  if (!first) {
    for (const item of found) {
      if (knownIds.has(item.id) || chosen.has(item.id)) continue;
      chosen.add(item.id);
      added.push(item.id);
    }
  }

  const missing = [...chosen].filter((id) => !foundIds.has(id));

  return {
    // Ordre stable : celui de la découverte, puis les éléments disparus.
    selection: [...found.filter((i) => chosen.has(i.id)).map((i) => i.id), ...missing],
    added,
    missing,
    active: found.filter((i) => chosen.has(i.id)),
  };
}

module.exports = {
  RANG_PRINCIPAL,
  RANG_SECONDAIRE,
  rangPourIndex,
  normalizeId,
  normalizeItem,
  normalizeItems,
  preselectedIds,
  merge,
  read,
  save,
  forget,
  reconcile,
};
