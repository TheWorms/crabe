'use strict';

/**
 * Lot 107 — le banc de « Mes documents » : des documents INVENTÉS, posés en
 * base pour un compte, dans un ordre et à des dates fixes (les rendus se
 * comparent d'une version à l'autre).
 *
 * Aucune donnée réelle : comptes nommés par leur rôle (titulaire, voisine),
 * numéros `0600000001`/`0600000002`, noms de fichiers d'essai.
 */

const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const paths = require('../server/destinations/paths');
const registry = require('../server/connectors/registry');

// Le stockage local des essais, nommé en un seul endroit (comme au lot 98) :
// son identifiant, et le nom que l'écran lui donne.
const LOCAL = 'local';
const NOM_LOCAL = 'Stockage local';

/**
 * Le jeu fixe : quatre services, dont un à deux comptes, trois années.
 * `[service, compte, nom, émission, récupération, taille]`.
 */
const JEU = [
  ['free', 'defaut', '2026-09_facture_essai.pdf', '2026-09-03', '2026-09-05 08:00:00', 31744],
  ['free', 'defaut', '2026-08_facture_essai.pdf', '2026-08-03', '2026-08-05 08:00:00', 30720],
  ['free', 'defaut', '2025-12_facture_essai.pdf', '2025-12-03', '2025-12-05 08:00:00', 29696],
  ['free-mobile', '0600000001', '2026-09_ligne_essai_a.pdf', '2026-09-10', '2026-09-12 09:00:00', 20480],
  ['free-mobile', '0600000002', '2026-09_ligne_essai_b.pdf', '2026-09-10', '2026-09-12 09:00:01', 21504],
  ['free-mobile', '0600000001', '2025-06_ligne_essai_a.pdf', '2025-06-10', '2025-06-12 09:00:00', 19456],
  ['ovh', 'xx00000-ovh', 'Facture_essai_FR0001.pdf', '2026-07-01', '2026-07-02 07:30:00', 52224],
  ['ovh', 'xx00000-ovh', 'Facture_essai_FR0002.pdf', '2024-11-01', '2024-11-02 07:30:00', 50176],
  ['hetzner', 'defaut', 'Hetzner_essai_2026-05.pdf', '2026-05-15', '2026-05-16 06:00:00', 61440],
];

/**
 * Pose le jeu pour un compte ; `depots` : l'objet `destinations` de chaque
 * ligne. `fichiers` : les PDF d'essai sont aussi écrits sur le stockage local
 * des essais — tous sauf le dernier, que l'interface de base dit absent.
 */
function peupler(user, { depots = { [LOCAL]: { state: 'ok', ok: true } }, jeu = JEU, fichiers = true } = {}) {
  const ins = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const racine = process.env.CRABE_LOCAL_PATH;
  return jeu.map(([service, compte, nom, emission, recuperation, taille], rang) => {
    if (fichiers && rang < jeu.length - 1) {
      const chemin = paths.localPath(racine, {
        username: user.username,
        connectorName: registry.manifest(service).name,
        accountId: compte,
        issuedOn: emission,
        filename: nom,
      });
      fs.mkdirSync(path.dirname(chemin), { recursive: true });
      fs.writeFileSync(chemin, `%PDF-1.4\n% document d'essai ${rang}\n`);
    }
    return Number(
      ins.run(user.id, service, nom, compte, taille, emission, recuperation,
        JSON.stringify(typeof depots === 'function' ? depots(nom) : depots)).lastInsertRowid
    );
  });
}

/**
 * Une série de `n` documents d'essai d'un même service (pagination, charge) :
 * dates et tailles fixes, déposés sur `depots` (le stockage local par défaut).
 */
function peuplerSerie(user, n, { service = 'scaleway', depots = { [LOCAL]: { state: 'ok', ok: true } }, prefixe = 'serie_essai' } = {}) {
  const ins = helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
     VALUES (?, ?, ?, 'defaut', ?, ?, ?, ?)`
  );
  const json = JSON.stringify(depots);
  const ids = [];
  helpers.db.get().transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const mois = String((i % 12) + 1).padStart(2, '0');
      const annee = 2025 - Math.floor(i / 120);
      ids.push(Number(ins.run(user.id, service, `${prefixe}_${String(i).padStart(5, '0')}.pdf`, 4000 + (i % 97),
        `${annee}-${mois}-01`, `${annee}-${mois}-02 10:${String(i % 60).padStart(2, '0')}:00`, json).lastInsertRowid));
    }
  })();
  return ids;
}

/** Règle l'interface de « Mes documents » d'un compte, par la base (banc). */
function regler(userId, valeur) {
  helpers.db.get().prepare('UPDATE users SET documents_ui = ? WHERE id = ?').run(valeur, userId);
}

module.exports = { LOCAL, NOM_LOCAL, JEU, peupler, peuplerSerie, regler };
