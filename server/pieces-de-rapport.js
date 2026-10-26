'use strict';

/**
 * Les pièces du rapport d'une récupération (0.2.6) : le HTML nettoyé de la
 * page à l'arrêt, celui de ses cadres, sa capture effacée — prises par
 * connectors/vue-de-page.js, gardées ici pour une récupération en échec, ou
 * pour chaque étape d'une récupération détaillée.
 *
 * Rangées sous `<données>/rapports/<n° de récupération>/`, dossier en 700 et
 * fichiers en 600 : rien de lisible n'y est (textes remplacés par leur
 * longueur, valeurs et adresses vidées, images effacées), mais ce sont les
 * pages des comptes. Le HTML repasse en plus par l'anonymisation du rapport
 * (noms de compte, e-mails, téléphones, IP, jetons) avant d'être écrit.
 *
 * Bornées : les quarante dernières récupérations, trente jours au plus, et
 * jamais celles que le journal ne connaît plus.
 */

const fs = require('node:fs');
const path = require('node:path');

const { config } = require('./config');

const GARDEES_MAX = 40;
const AGE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const racine = () => path.join(config.dataDir, 'rapports');

function dossierDe(runId) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`numéro de récupération invalide : ${runId}`);
  return path.join(racine(), String(id));
}

/** Les comptes de l'installation, pour l'anonymisation — ou aucun si la base ne répond pas. */
function comptes() {
  try {
    return require('./db/db').get().prepare('SELECT username, email, phone FROM users').all();
  } catch {
    return [];
  }
}

/**
 * Écrit les pièces d'une récupération. Rend le nombre de pièces écrites ;
 * ne lève jamais : une pièce qui ne s'écrit pas manque au rapport, rien de
 * plus.
 *
 * @param {number} runId
 * @param {Array<{nom: string, type: string, contenu: string|Buffer, adresse?: string}>} pieces
 */
function enregistrer(runId, pieces) {
  if (!pieces?.length) return 0;
  try {
    const dossier = dossierDe(runId);
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
    fs.chmodSync(racine(), 0o700);
    const { anonymiser } = require('./rapport-echec');
    const lesComptes = comptes();
    const index = lister(runId);
    for (const piece of pieces) {
      const nom = path.basename(String(piece.nom)).replace(/[^A-Za-z0-9._-]/g, '-');
      if (!nom || nom === 'index.json' || index.some((p) => p.nom === nom)) continue;
      const contenu = typeof piece.contenu === 'string' ? anonymiser(piece.contenu, { comptes: lesComptes }) : piece.contenu;
      if (!contenu?.length) continue;
      fs.writeFileSync(path.join(dossier, nom), contenu, { mode: 0o600 });
      index.push({ nom, type: piece.type, adresse: piece.adresse || null, octets: Buffer.byteLength(contenu) });
    }
    fs.writeFileSync(path.join(dossier, 'index.json'), JSON.stringify(index), { mode: 0o600 });
    purger();
    return index.length;
  } catch {
    return 0;
  }
}

/** Les pièces d'une récupération : `[{nom, type, adresse, octets}]`, ou `[]`. */
function lister(runId) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dossierDe(runId), 'index.json'), 'utf8'));
    return Array.isArray(index) ? index : [];
  } catch {
    return [];
  }
}

/** Le contenu d'une pièce de l'index, ou null. Jamais un autre fichier. */
function lire(runId, nom) {
  const piece = lister(runId).find((p) => p.nom === nom);
  if (!piece) return null;
  try {
    return fs.readFileSync(path.join(dossierDe(runId), piece.nom));
  } catch {
    return null;
  }
}

/**
 * Les quarante plus récentes, trente jours au plus, et seulement celles dont
 * la récupération existe encore au journal (`existe`, quand on le sait).
 */
function purger({ existe = null, maintenant = Date.now() } = {}) {
  let noms = [];
  try {
    noms = fs.readdirSync(racine()).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
  } catch {
    return 0;
  }
  let retirees = 0;
  noms.forEach((nom, rang) => {
    const dossier = path.join(racine(), nom);
    let ancien = false;
    try {
      ancien = maintenant - fs.statSync(dossier).mtimeMs > AGE_MAX_MS;
    } catch {
      return;
    }
    const oubliee = typeof existe === 'function' && !existe(Number(nom));
    if (rang >= GARDEES_MAX || ancien || oubliee) {
      fs.rmSync(dossier, { recursive: true, force: true });
      retirees += 1;
    }
  });
  return retirees;
}

module.exports = {
  GARDEES_MAX,
  AGE_MAX_MS,
  racine,
  enregistrer,
  lister,
  lire,
  purger,
};
