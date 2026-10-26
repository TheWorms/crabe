'use strict';

/**
 * Les noms de fichiers opaques remplacés par le numéro de la facture (0.2.4).
 *
 * ─── D'où ça vient ───────────────────────────────────────────────────────────
 *
 * Mesuré sur la production le 26/10/2026 : les douze factures d'Anthropic
 * étaient déposées sous des noms de la forme `anthropic_2026-08_3fa2…c9.pdf`.
 * La console les lie directement vers leur PDF Stripe, forme que crabe ne
 * reconnaissait pas : la référence tirée du lien était le jeton d'accès
 * entier, et `documents-de-page.nomFichier()` l'a remplacé, à raison, par son
 * empreinte — jamais un secret dans un nom. Le lien est désormais reconnu
 * (facture-stripe.js) et les factures NEUVES portent leur numéro. Restent
 * celles déjà déposées : c'est ce module.
 *
 * ─── Le geste ────────────────────────────────────────────────────────────────
 *
 * Le planificateur dit au connecteur quels documents connus portent un nom
 * opaque (`ctx.nomsOpaques`, leurs `remote_id`) ; le connecteur qui sait lire
 * leur numéro (Anthropic) retélécharge ces PDF-là et rend
 * `numerosRelus: { <remote_id>: <numéro> }`. Ce module renomme alors, sur
 * chaque destination où le document est déposé, `…_<empreinte>.pdf` en
 * `…_<numéro>.pdf` — dans le même dossier, période et convention du compte
 * inchangées : seule la référence change.
 *
 * Avec les gestes de l'harmonisation des noms (harmonisation.js), prouvés
 * depuis le lot 55 : son verrou (jamais pendant un chantier ni pendant une
 * synchronisation forcée), sa sauvegarde vérifiée de la base, ses mouvements
 * (ancien présent et cible libre avant, relecture après — rien n'est jamais
 * écrasé), la base en dernier, en une transaction, sur la ligne relue. Un
 * journal à part (`renommage-references-journal.jsonl`) garde chaque geste,
 * avec le nom d'avant : un retour en arrière à la main reste possible.
 *
 * Rien de tout cela ne change le résultat d'une récupération : un renommage
 * reporté ou arrêté se dit au journal, et se refait au passage suivant — un
 * mouvement déjà fait est reconnu (ancien absent, nouveau présent).
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db/db');
const { config } = require('./config');
const { propre } = require('./convention-noms');

/** Le journal persistant — jamais dans /tmp, il survit au service. */
const JOURNAL = () => path.join(config.dataDir, 'renommage-references-journal.jsonl');

/**
 * Un nom opaque : sa référence est une empreinte de douze hexadécimaux, celle
 * que `documents-de-page.nomFichier()` met à la place d'une référence trop
 * longue. Au moins une lettre : une référence de douze CHIFFRES est un vrai
 * numéro, elle ne se touche pas.
 */
const MOTIF_NOM_OPAQUE = /_((?=[0-9a-f]*[a-f])[0-9a-f]{12})\.pdf$/;

/** Ce nom de fichier est-il opaque ? */
function estNomOpaque(filename) {
  return MOTIF_NOM_OPAQUE.test(String(filename ?? ''));
}

/** Les `remote_id` des documents d'un compte et d'un connecteur déposés sous un nom opaque. */
function nomsOpaques(userId, connectorId) {
  return db.get()
    .prepare(
      'SELECT remote_id, filename FROM invoices'
        + ' WHERE user_id = ? AND connector_id = ? AND remote_id IS NOT NULL ORDER BY id'
    )
    .all(userId, connectorId)
    .filter((l) => estNomOpaque(l.filename))
    .map((l) => l.remote_id);
}

/**
 * Le nom où le numéro remplace l'empreinte, ou `null` si le numéro ne fait pas
 * une référence de nom (vide une fois nettoyé, ou plus long que les 40
 * caractères que `nomFichier()` admet).
 */
function nomAvecNumero(filename, numero) {
  const reference = propre(numero);
  if (!reference || reference.length > 40 || !estNomOpaque(filename)) return null;
  return String(filename).replace(MOTIF_NOM_OPAQUE, `_${reference}.pdf`);
}

function dossierDe(chemin) {
  return chemin.slice(0, chemin.lastIndexOf('/'));
}

function journaliser(entree) {
  const fd = fs.openSync(JOURNAL(), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify({ quand: new Date().toISOString(), ...entree })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Le plan : une entrée par ligne à renommer, avec un mouvement par
 * destination active où le document est déposé ; à part, les lignes laissées
 * telles quelles et pourquoi. Recalculé à chaque passage, depuis la base.
 *
 * @param {number} userId
 * @param {string} connectorId
 * @param {Object<string, string>} numeros `remote_id` → numéro de facture
 */
function construirePlan(userId, connectorId, numeros) {
  const actives = require('./destinations').activeDestinations();
  const d = db.get();
  const lire = d.prepare(
    'SELECT id, filename, destinations FROM invoices'
      + ' WHERE user_id = ? AND connector_id = ? AND remote_id = ? ORDER BY id'
  );
  const occupe = d.prepare('SELECT id FROM invoices WHERE user_id = ? AND connector_id = ? AND filename = ?');

  const entrees = [];
  const laissees = [];
  const cibles = new Set();
  for (const [remoteId, numero] of Object.entries(numeros || {})) {
    for (const l of lire.all(userId, connectorId, remoteId)) {
      if (!estNomOpaque(l.filename)) continue;
      const cible = nomAvecNumero(l.filename, numero);
      if (!cible) {
        laissees.push({ id: l.id, motif: 'le numéro relu ne fait pas un nom de fichier' });
        continue;
      }
      // Deux lignes pour une même facture (un doublon d'avant la 0.2.4) : la
      // première prend le nom, l'autre garde le sien — rien n'est écrasé.
      const occupant = occupe.get(userId, connectorId, cible);
      if (occupant || cibles.has(cible)) {
        laissees.push({
          id: l.id,
          motif: `le nom au numéro est déjà celui ${occupant ? `de la ligne ${occupant.id}` : 'd\'une autre ligne'}`,
        });
        continue;
      }

      let dests = {};
      try { dests = JSON.parse(l.destinations || '{}') || {}; } catch { dests = {}; }
      const mouvements = [];
      let incoherent = false;
      for (const cle of actives) {
        const depot = dests[cle];
        if (!depot || !depot.ok || !depot.path) continue;
        if (depot.path.slice(depot.path.lastIndexOf('/') + 1) !== l.filename) {
          incoherent = true;
          break;
        }
        mouvements.push({ dest: cle, de: depot.path, vers: `${dossierDe(depot.path)}/${cible}` });
      }
      if (incoherent) {
        laissees.push({ id: l.id, motif: 'un chemin enregistré porte un autre nom que la base' });
        continue;
      }
      cibles.add(cible);
      entrees.push({ id: l.id, nom: l.filename, cible, mouvements });
    }
  }
  return { entrees, laissees };
}

/**
 * Le renommage lui-même, sous le verrou de l'harmonisation. Compte dans
 * `bilan` au fil de l'eau : un arrêt net dit encore combien étaient faits.
 */
async function executer(plan, bilan, { userId, username }) {
  const harmonisation = require('./harmonisation');
  const destinationsChargees = harmonisation.chargerDestinations({ userId, username });
  const sauvegarde = await harmonisation.sauvegarderBase();
  journaliser({ type: 'debut', lignes: plan.entrees.length, sauvegarde: path.basename(sauvegarde) });

  const d = db.get();
  const lire = d.prepare('SELECT filename, destinations FROM invoices WHERE id = ?');
  const maj = d.prepare('UPDATE invoices SET filename = ?, destinations = ? WHERE id = ? AND filename = ?');

  for (const e of plan.entrees) {
    // L'état FRAIS de la ligne : la sauvegarde et les mouvements précédents
    // ont laissé passer du temps. On ne renomme jamais sur un plan périmé.
    const ligne = lire.get(e.id);
    if (!ligne || ligne.filename !== e.nom) {
      bilan.ecartes++;
      journaliser({ type: 'ecartee', id: e.id, motif: 'la ligne a changé avant son renommage' });
      continue;
    }

    for (const m of e.mouvements) {
      const resultat = await harmonisation.executerMouvement({ ...m, id: e.id }, destinationsChargees);
      journaliser({ type: 'mouvement', id: e.id, dest: m.dest, de: m.de, vers: m.vers, deja: resultat === 'deja' });
    }

    // La base en DERNIER, en une transaction, sur la ligne relue.
    let ecriture = null;
    const tx = d.transaction(() => {
      const fraiche = lire.get(e.id);
      if (!fraiche || fraiche.filename !== e.nom) return false;
      let dests = {};
      try { dests = JSON.parse(fraiche.destinations || '{}') || {}; } catch { dests = {}; }
      for (const m of e.mouvements) dests[m.dest] = { ...dests[m.dest], path: m.vers };
      const apresJson = JSON.stringify(dests);
      if (maj.run(e.cible, apresJson, e.id, e.nom).changes !== 1) return false;
      ecriture = {
        avant: { filename: e.nom, destinations: fraiche.destinations },
        apres: { filename: e.cible, destinations: apresJson },
      };
      return true;
    });
    if (tx()) {
      journaliser({ type: 'base', id: e.id, ...ecriture });
      bilan.faits++;
    } else {
      bilan.ecartes++;
      journaliser({ type: 'ecartee', id: e.id, motif: 'la ligne a changé entre les mouvements et l\'écriture en base' });
    }
  }
  journaliser({ type: 'fin', faits: bilan.faits, ecartes: bilan.ecartes });
}

/**
 * Renomme les documents dont le connecteur a relu le numéro. Ne lève jamais
 * pour une cause attendue : rend ce qui s'est passé, en une phrase prête pour
 * le journal (des nombres et des numéros de ligne, jamais un nom).
 *
 * @returns {Promise<{faits: number, laissees: number, ecartes: number, reporte: boolean, arrete: boolean, phrase: string|null}>}
 */
async function appliquer({ userId, username = null, connectorId, numeros }) {
  const plan = construirePlan(userId, connectorId, numeros);
  const bilan = { faits: 0, laissees: plan.laissees.length, ecartes: 0, reporte: false, arrete: false, phrase: null };
  const laisseesTexte = plan.laissees.length
    ? ` ; laissé(s) tel(s) quel(s) : ${plan.laissees.map((l) => `ligne ${l.id} (${l.motif})`).join(', ')}`
    : '';
  if (!plan.entrees.length) {
    if (plan.laissees.length) bilan.phrase = `aucun document renommé avec son numéro de facture${laisseesTexte}.`;
    return bilan;
  }

  const harmonisation = require('./harmonisation');
  const reporter = (raison) => {
    bilan.reporte = true;
    bilan.phrase = `${plan.entrees.length} document(s) à renommer avec leur numéro de facture — `
      + `reporté au prochain passage : ${raison}${laisseesTexte}.`;
    return bilan;
  };
  // Vérifié juste avant de prendre le verrou, sans attente entre les deux :
  // une synchronisation qui démarrerait ensuite voit le verrou et refuse.
  if (require('./destinations/sync').isRunning()) return reporter('une synchronisation des destinations est en cours');

  try {
    await harmonisation.sousLeVerrou(
      'renommage des références',
      () => executer(plan, bilan, { userId, username })
    );
    bilan.phrase = `${bilan.faits} document(s) renommé(s) avec leur numéro de facture`
      + `${bilan.ecartes ? `, ${bilan.ecartes} écarté(s) parce que leur ligne a changé pendant l'opération` : ''}`
      + `${laisseesTexte}.`;
    return bilan;
  } catch (err) {
    if (err.alreadyRunning) return reporter('un renommage des documents est en cours');
    if (err.arretImmediat) {
      bilan.arrete = true;
      bilan.phrase = `renommage avec les numéros de facture arrêté net après ${bilan.faits} document(s) : `
        + `${err.message} — rien n'a été écrasé ; le passage suivant reprend où celui-ci s'est arrêté.`;
      return bilan;
    }
    // La sauvegarde n'a pas pu être vérifiée (des documents arrivent) : rien
    // n'a bougé, on recommencera.
    return reporter(err.message);
  }
}

module.exports = {
  appliquer,
  construirePlan,
  estNomOpaque,
  nomAvecNumero,
  nomsOpaques,
  JOURNAL,
};
