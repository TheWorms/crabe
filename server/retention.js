'use strict';

/**
 * Profondeur de documents conservée.
 *
 * ─── La question à laquelle ce module répond ─────────────────────────────────
 *
 * « Combien de temps crabe garde-t-il mes factures ? » Jusqu'ici : pour
 * toujours. C'est un bon défaut — on ne jette pas les papiers de quelqu'un sans
 * le lui demander — mais ce n'est pas un choix, et un compte qui accumule
 * quinze années d'Amazon finit par le regretter.
 *
 * Cinq réponses possibles, et pas une de plus : **3 mois, 6 mois, 1 an, 2 ans,
 * tout garder**. Le réglage vit dans `security_policy`, à côté de la rétention
 * des journaux, et s'applique au nettoyage quotidien de 04:15.
 *
 * ─── La règle qui gouverne tout ce fichier ───────────────────────────────────
 *
 * **Jamais rétroactivement sans confirmation explicite.**
 *
 * Choisir « 6 mois » un mardi soir ne doit pas effacer huit ans de factures
 * dans la nuit. Le réglage pose donc un PLANCHER (`document_retention_floor`) :
 * les documents déjà récupérés au moment du changement sont protégés, et seuls
 * ceux arrivés ensuite vieilliront selon la nouvelle profondeur.
 *
 * L'administrateur qui veut vraiment faire le ménage dans l'existant le demande
 * — c'est `applyNow: true`, un geste séparé, avec le nombre de documents
 * concernés annoncé AVANT. Le plancher tombe alors, et le nettoyage suivant
 * s'applique à tout.
 *
 * ─── Ce qui est supprimé, et ce qui ne l'est pas ─────────────────────────────
 *
 * Supprimé : le fichier sur **le stockage local** — l'espace que crabe administre — et
 * la ligne d'index qui le décrit.
 *
 * **Pas touché : les copies déposées sur les clouds.** Ce sont les espaces de
 * l'utilisateur, chez des tiers, et rien de ce qu'il y a rangé ne doit
 * disparaître parce qu'un réglage de crabe a changé. La suppression y serait
 * irréversible et invisible. L'écran le dit en toutes lettres plutôt que de le
 * laisser deviner.
 *
 * Conséquence assumée : un document supprimé ici et toujours présent sur un
 * cloud ne réapparaîtra pas dans « Mes documents » — il n'est plus indexé. Il
 * reste lisible depuis le cloud lui-même, ce qui est exactement ce qu'on
 * attend d'une sauvegarde.
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db/db');
const applog = require('./applog');

/**
 * Les cinq choix, dans l'ordre où ils s'affichent.
 *
 * `0` = tout garder, et c'est le défaut : une installation qui se met à jour ne
 * doit rien perdre parce que personne n'a encore ouvert cet écran.
 */
const OPTIONS = [
  { months: 3, label: '3 mois' },
  { months: 6, label: '6 mois' },
  { months: 12, label: '1 an' },
  { months: 24, label: '2 ans' },
  { months: 0, label: 'Tout garder' },
];

const MOIS_VALIDES = OPTIONS.map((o) => o.months);

/** Ce que le réglage vaut aujourd'hui. */
function policy() {
  const row = db
    .get()
    .prepare(
      'SELECT document_retention_months, document_retention_floor FROM security_policy WHERE id = 1'
    )
    .get();

  const months = Number(row?.document_retention_months || 0);
  return {
    months: MOIS_VALIDES.includes(months) ? months : 0,
    /**
     * Date en deçà de laquelle rien n'est supprimé, ou `null`.
     *
     * C'est la garantie « jamais rétroactivement » : elle est posée à l'instant
     * où la profondeur est réduite, et ne tombe que sur demande explicite.
     */
    floor: row?.document_retention_floor || null,
  };
}

/** Le libellé d'une profondeur, pour un journal ou un écran. */
function label(months) {
  return OPTIONS.find((o) => o.months === Number(months))?.label || 'Tout garder';
}

/**
 * La date d'un document : celle de son émission, à défaut celle du dépôt.
 *
 * `issued_on` est ce qui compte — c'est l'âge de la FACTURE, pas celui de sa
 * récupération. Un rattrapage de dix années d'impôts fait entrer aujourd'hui
 * des documents de 2017 : les dater d'aujourd'hui les garderait dix ans de
 * trop. Certains documents n'ont pas de date d'émission lisible (voir le
 * dossier `inconnu/`) : on retombe alors sur `fetched_at`, faute de mieux.
 */
const DATE_DOCUMENT = "COALESCE(NULLIF(i.issued_on, ''), i.fetched_at)";

/**
 * Les documents qui dépassent une profondeur donnée.
 *
 * ─── Ce que le plancher protège, et pourquoi ça a changé (lot 26) ────────────
 *
 * Le plancher disait : « ne supprime rien qui ait été RÉCUPÉRÉ avant tel
 * instant ». C'était le mauvais critère, pour deux raisons mesurées sur
 * l'installation réelle le 13/08/2026 :
 *
 * 1. **Une date de récupération se renouvelle.** Une facture de 2016
 *    re-téléchargée aujourd'hui — parce que le service a été reconfiguré, ou
 *    simplement re-synchronisé — devenait un document « arrivé après le
 *    changement », donc supprimable. La promesse affichée à l'écran (« appliquée
 *    aux seuls documents à venir, les précédents sont conservés ») se défaisait
 *    d'elle-même, service par service, à la première re-synchronisation. 149
 *    documents ont été effacés ainsi la nuit du 13/08 à 02:15, et 43 autres —
 *    PrestaShop Addons depuis 2016, Proxmox depuis 2016, Bitstamp depuis 2021 —
 *    étaient sur la liste de la nuit suivante.
 *
 * 2. **Les deux dates ne s'écrivaient pas pareil.** `fetched_at` vaut
 *    « 2026-08-11 13:48:51 » ; le plancher était enregistré au format ISO,
 *    « 2026-08-11T01:12:42.040Z ». La comparaison SQLite est alors une
 *    comparaison de CHAÎNES, où l'espace passe avant le « T » : tout document
 *    récupéré le jour même du changement était donc jugé antérieur au plancher.
 *    Une protection qui dépend de la ponctuation n'est pas une protection.
 *
 * Le critère est désormais **l'âge du document au moment où le réglage a été
 * posé** : ce qui était DÉJÀ hors de la fenêtre ce jour-là est « les
 * précédents », et le reste pour toujours. Il ne dépend que de la date du
 * document et du plancher — deux valeurs qu'aucune re-synchronisation ne
 * change. `datetime()` remet au passage les deux écritures dans la même forme.
 *
 * @param {{months?: number, floor?: string|null, ignoreFloor?: boolean}} [options]
 * @returns {Array<object>} lignes d'`invoices`, avec le nom du propriétaire
 */
function expired({ months = null, floor = undefined, ignoreFloor = false } = {}) {
  const courant = policy();
  const profondeur = months === null ? courant.months : Number(months);
  if (!MOIS_VALIDES.includes(profondeur) || profondeur === 0) return [];

  const plancher = ignoreFloor ? null : floor === undefined ? courant.floor : floor;

  const conditions = [`${DATE_DOCUMENT} < datetime('now', ?)`];
  const params = [`-${profondeur} months`];

  if (plancher) {
    conditions.push(`${DATE_DOCUMENT} >= datetime(?, ?)`);
    params.push(plancher, `-${profondeur} months`);
  }

  return db
    .get()
    .prepare(
      `SELECT i.*, u.username
         FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.id`
    )
    .all(...params);
}

/**
 * Le PLAFOND DE RÉCUPÉRATION : jusqu'où les connecteurs doivent remonter.
 *
 * ─── Pourquoi cette fonction existe (lot 26) ─────────────────────────────────
 *
 * Le lot 24 a fait de la conservation un plafond sur ce que crabe va CHERCHER :
 * inutile de télécharger 118 PDF que l'entretien de la nuit effacera. Le
 * raisonnement était juste, mais la valeur employée ne l'était pas : c'était la
 * profondeur brute, sans regarder le plancher.
 *
 * Or le plancher change tout. Tant qu'il est posé, le nettoyage **ne touche
 * pas** aux documents plus anciens que la fenêtre : ils sont « les précédents »,
 * et ils sont conservés. Refuser d'aller les chercher revenait donc à se priver
 * de documents que crabe aurait gardés — mesuré le 13/08/2026 : Hetzner ne
 * récupérait plus que depuis août 2025 alors que le fournisseur en propose
 * depuis 2019, et Infomaniak, OVHcloud et SoYouStart étaient coupés de la même
 * façon, à la même date, sans qu'aucun message ne le dise.
 *
 * Une seule règle gouverne donc les deux gestes :
 *
 *   - **un plancher est posé** → le nettoyage épargne l'ancien, la récupération
 *     n'a aucune raison de s'en priver : plafond `0`, c'est-à-dire aucun ;
 *   - **pas de plancher** (l'administrateur a demandé d'appliquer la
 *     conservation à l'existant, en connaissance de cause) → le nettoyage
 *     effacera l'ancien, et la récupération s'arrête à la même borne.
 *
 * Le contrat tient dans une phrase : **crabe ne refuse d'aller chercher un
 * document que s'il est certain de l'effacer ensuite.**
 *
 * @returns {number} le plafond en mois, 0 = aucun
 */
function fetchCapMonths() {
  const courant = policy();
  if (!courant.months) return 0;
  return courant.floor ? 0 : courant.months;
}

/**
 * Combien de documents une profondeur emporterait, plancher IGNORÉ.
 *
 * C'est le chiffre qu'on montre AVANT de demander confirmation : « 143
 * documents dépassent déjà cette profondeur ». Sans lui, l'administrateur
 * coche une case sans savoir ce qu'elle coûte.
 */
function countBeyond(months) {
  return expired({ months, ignoreFloor: true }).length;
}

/**
 * Enregistre la profondeur.
 *
 * @param {number} months
 * @param {{applyNow?: boolean}} [options] `applyNow` retire le plancher : le
 *   nettoyage s'appliquera aussi à ce qui existe déjà. C'est la CONFIRMATION
 *   EXPLICITE, et elle ne peut venir que d'un geste de l'administrateur.
 * @returns {{months: number, floor: string|null, label: string, beyond: number}}
 */
function setMonths(months, { applyNow = false } = {}) {
  // `Number(null)` vaut 0, c'est-à-dire « tout garder » : une valeur absente
  // ne doit pas passer pour un choix. On exige un nombre, ou son écriture.
  const brut = typeof months === 'number' || (typeof months === 'string' && months.trim())
    ? Number(months)
    : NaN;
  const valeur = Number.isInteger(brut) ? brut : NaN;
  if (!MOIS_VALIDES.includes(valeur)) {
    const err = new Error('Profondeur de conservation inconnue.');
    err.statusCode = 400;
    throw err;
  }

  // « Tout garder » n'a pas de plancher à poser : il n'efface rien.
  const plancher = valeur === 0 || applyNow ? null : new Date().toISOString();

  db.get()
    .prepare(
      `UPDATE security_policy
          SET document_retention_months = ?,
              document_retention_floor  = ?,
              updated_at = datetime('now')
        WHERE id = 1`
    )
    .run(valeur, plancher);

  return { ...policy(), label: label(valeur), beyond: countBeyond(valeur) };
}

// ---------------------------------------------------------------------------
// Le nettoyage lui-même
// ---------------------------------------------------------------------------

/**
 * Efface un document : son fichier sur le stockage local, puis sa ligne d'index.
 *
 * L'ordre compte. Si l'effacement du fichier échoue, la ligne RESTE : mieux
 * vaut un document toujours listé et toujours là qu'une ligne perdue pointant
 * sur un fichier orphelin, que plus rien ne saurait retrouver ni nettoyer.
 *
 * @param {object} row ligne d'`invoices`, avec `username`
 * @returns {{ok: boolean, message?: string}}
 */
function deleteDocument(row) {
  const destinations = require('./destinations');
  const fichier = destinations.invoicePath(row, row.username);

  try {
    if (fichier && fs.existsSync(fichier)) {
      fs.rmSync(fichier);
      elaguerDossiersVides(fichier);
    }
  } catch (err) {
    return { ok: false, message: err.message };
  }

  db.get().prepare('DELETE FROM invoices WHERE id = ?').run(row.id);
  return { ok: true };
}

/**
 * Retire les dossiers devenus vides au-dessus d'un fichier effacé.
 *
 * L'arborescence est `<compte>/<service>/<compte fournisseur>/<année>/` : sans
 * élagage, les années vides s'accumulent indéfiniment et « Mes documents »
 * finirait par montrer des dossiers qui ne contiennent rien.
 *
 * `rmdirSync` échoue sur un dossier non vide, et c'est exactement le garde-fou
 * qu'on veut : on remonte tant que ça marche, on s'arrête dès que ça résiste.
 * Trois niveaux au plus — jamais jusqu'à la racine du stockage local.
 */
function elaguerDossiersVides(fichier, niveaux = 3) {
  let dossier = path.dirname(fichier);
  for (let i = 0; i < niveaux; i++) {
    try {
      fs.rmdirSync(dossier);
    } catch {
      return;
    }
    dossier = path.dirname(dossier);
  }
}

/**
 * Passe le nettoyage : supprime ce qui dépasse la profondeur retenue.
 *
 * Appelé par l'entretien quotidien de 04:15. Ne lève jamais : un nettoyage en
 * échec ne doit pas emporter la purge des journaux ni les suppressions RGPD.
 *
 * @param {{actor?: object}} [options]
 * @returns {{months: number, deleted: number, failed: number, freedBytes: number}}
 */
function purge({ actor = null } = {}) {
  const { months } = policy();
  if (!months) return { months: 0, deleted: 0, failed: 0, freedBytes: 0 };

  const candidats = expired();
  let deleted = 0;
  let failed = 0;
  let freedBytes = 0;

  for (const row of candidats) {
    const rendu = deleteDocument(row);
    if (rendu.ok) {
      deleted++;
      freedBytes += row.size_bytes || 0;
    } else {
      failed++;
      applog.warn(
        'retention',
        `Document « ${row.filename} » non supprimé : ${rendu.message}`,
        actor || {}
      );
    }
  }

  if (deleted || failed) {
    applog.info(
      'retention',
      `Conservation « ${label(months)} » : ${deleted} document(s) supprimé(s)`
        + (failed ? `, ${failed} en échec` : '')
        + '. Les copies déposées sur vos clouds ne sont pas touchées.',
      actor || {}
    );
  }

  return { months, deleted, failed, freedBytes };
}

/** Vue servie à l'administration. */
function view() {
  const courant = policy();
  return {
    months: courant.months,
    label: label(courant.months),
    options: OPTIONS,
    // La date à partir de laquelle le nettoyage s'applique, ou null s'il
    // s'applique à tout. C'est elle qui matérialise « jamais rétroactivement ».
    floor: courant.floor,
    // Ce que le réglage actuel emporterait s'il n'y avait pas de plancher :
    // c'est le chiffre à annoncer avant de proposer de l'appliquer à l'existant.
    beyond: countBeyond(courant.months),
    // Ce que le prochain nettoyage emportera vraiment, plancher compris.
    due: expired().length,
  };
}

module.exports = {
  OPTIONS,
  MOIS_VALIDES,
  DATE_DOCUMENT,
  policy,
  label,
  expired,
  fetchCapMonths,
  countBeyond,
  setMonths,
  deleteDocument,
  elaguerDossiersVides,
  purge,
  view,
};
