'use strict';

/**
 * Le dossier d'un compte — et d'un service — sur une destination (lot 106, R4).
 *
 * Le bouton « Ouvrir le dossier » de l'accueil et de la modale du connecteur
 * l'utilise. Deux comportements, et le texte du bouton dit lequel :
 *
 *   - une ADRESSE WEB du dossier, quand l'interface web du fournisseur en a
 *     une stable et déductible de ce que crabe sait : le bouton l'ouvre dans
 *     un nouvel onglet ;
 *   - sinon, le CHEMIN : le bouton le copie (« Copier le chemin »).
 *
 * ─── Aucune adresse n'est inventée (mesuré au lot 106) ───────────────────────
 *
 * Pour aucun type de destination l'adresse web d'un dossier n'est déductible
 * de façon sûre : pCloud, Proton Drive, MEGA et kDrive désignent un dossier de
 * leur interface web par un identifiant interne que crabe ne connaît pas ; S3
 * et WebDAV n'ont pas d'interface web commune ; le stockage local est un
 * point de montage du SERVEUR, qu'aucun navigateur ne peut ouvrir. Les adresses que
 * crabe connaît (point d'accès d'API, adresse WebDAV) ne s'ouvrent pas comme
 * un dossier, et certaines s'accompagnent d'identifiants. `adresse` vaut donc
 * `null` partout, et le bouton copie le chemin. Le jour où un fournisseur
 * offre une adresse stable, elle se calcule ici — sans appel réseau, sans
 * secret.
 *
 * ─── Le chemin, et qui voit la racine ───────────────────────────────────────
 *
 * L'arborescence est celle des dépôts (`paths.relativeParts`) :
 * `<racine>/<utilisateur>/<service>/…`. La racine (le chemin du stockage
 * local sur le serveur, le dossier de base d'un cloud) est un réglage de
 * l'administration : seul un compte qui gère le stockage (`storage.manage`)
 * la voit, comme dans Paramètres › Stockage. Les autres reçoivent le chemin
 * DEPUIS le dossier de crabe — leurs droits ne s'élargissent pas.
 */

const paths = require('./paths');
const permissions = require('../permissions');

/** Ce compte voit-il la racine des destinations (droit de l'écran Stockage) ? */
function voitLaRacine(user) {
  try {
    return permissions.permissionsForUser(user).includes('storage.manage');
  } catch {
    return false;
  }
}

/** La racine d'une destination, telle que l'administration l'a réglée — ou ''. */
function racineDe(destId) {
  const destinations = require('./index');
  try {
    if (destId === 'local') return String(destinations.readConfig('local')?.path || '');
    // Une configuration illisible (clé absente) ne donne pas de racine : le
    // chemin depuis le dossier de crabe reste vrai.
    if (destinations.configIllisible(destId)) return '';
    const conf = destinations.readConfig(destId) || {};
    const driver = destinations.driverFor(destId);
    const normalise = driver?.normalizeConf ? driver.normalizeConf(conf) : conf;
    return String(normalise?.basePath || 'crabe');
  } catch {
    return '';
  }
}

/**
 * @param {string} destId
 * @param {{user: object, connectorName?: string|null}} options
 * @returns {{chemin: string, depuisLaRacine: boolean, adresse: null}}
 */
function dossierDe(destId, { user, connectorName = null }) {
  const segments = [paths.safeSegment(user?.username, 'inconnu')];
  if (connectorName) segments.push(paths.safeSegment(connectorName, 'connecteur'));
  const relatif = segments.join('/');

  const racine = voitLaRacine(user) ? racineDe(destId).replace(/\/+$/, '') : '';
  return {
    chemin: racine ? `${racine}/${relatif}` : relatif,
    // Faux : le chemin part du dossier de crabe sur cette destination.
    depuisLaRacine: !!racine,
    adresse: null,
  };
}

/**
 * Les destinations d'un compte vues depuis UN service (onglet « Destinations »
 * de la modale du connecteur) : où ses documents sont rangés, et où en sont
 * leurs copies. Lu en base seulement — aucun appel réseau, aucune mesure
 * d'espace.
 *
 * @returns {Array<{id, name, letter, color, logo, logoInterne, documents: number,
 *   copies: number, enAttente: number, enEchec: number, dossier: object}>}
 */
function destinationsDuService(user, connectorId) {
  const destinations = require('./index');
  const catalogue = require('./catalogue');
  const invoices = require('../invoices');
  const db = require('../db/db');

  let connectorName = connectorId;
  try {
    connectorName = require('../connectors/registry').manifest(connectorId).name;
  } catch {
    /* service retiré du disque : son identifiant nomme le dossier */
  }

  const actives = destinations.destinationsForUser(user.id);
  const lignes = db
    .get()
    .prepare('SELECT destinations FROM invoices WHERE user_id = ? AND connector_id = ?')
    .all(user.id, connectorId);
  const etats = new Map(actives.map((id) => [id, { copies: 0, enAttente: 0, enEchec: 0 }]));
  for (const ligne of lignes) {
    for (const etat of invoices.statesFor(ligne.destinations, actives)) {
      const compte = etats.get(etat.id);
      if (etat.state === 'error') compte.enEchec += 1;
      else if (etat.state === 'pending') compte.enAttente += 1;
      // « unknown » : copie réussie d'avant le suivi détaillé — elle est là.
      else compte.copies += 1;
    }
  }

  return actives.map((id) => {
    const style = catalogue.brand(id);
    return {
      id,
      name: style.name,
      letter: style.letter,
      color: style.color,
      logo: style.logo,
      logoInterne: style.logoInterne,
      documents: lignes.length,
      ...etats.get(id),
      dossier: dossierDe(id, { user, connectorName }),
    };
  });
}

module.exports = { dossierDe, voitLaRacine, racineDe, destinationsDuService };
