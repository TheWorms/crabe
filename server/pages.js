'use strict';

/**
 * Les pages de crabe (app.html, login.html), servies avec la version dans
 * l'adresse de leurs fichiers — 0.2.2.
 *
 * ─── Ce qui a été constaté le 26/10/2026 ─────────────────────────────────────
 *
 * Au passage de la production en 0.2.1, l'écran « Logs › Connecteurs » est
 * resté l'ancien : ni numéro de récupération, ni bouton « Rapport ». Le serveur
 * était à jour ; le navigateur, lui, gardait `admin.js` — crabe laisse ses
 * fichiers d'interface une heure en cache (`maxAge`), à une adresse qui ne
 * changeait jamais. Après chaque mise à jour, n'importe quel compte pouvait
 * donc garder l'ancien écran jusqu'à une heure, ou jusqu'à Ctrl+Maj+R.
 *
 * Désormais chaque fichier local d'une page (`/admin.js`, `/style.css`…) est
 * demandé à une adresse qui porte la version (`/admin.js?v=0.2.2`) : une
 * version neuve, une adresse neuve, un fichier relu. Le cache d'une heure reste
 * entier entre deux mises à jour. La page elle-même est servie `no-cache` :
 * le navigateur la revalide à chaque ouverture (une réponse 304 si rien n'a
 * changé), c'est elle qui porte les adresses.
 *
 * 0.2.3 : la version ne suffit pas quand on redéploie la MÊME version avec une
 * retouche (constaté le 26/10 : la mise en page du statut corrigée après le
 * déploiement de la 0.2.3). L'adresse porte donc aussi l'empreinte du contenu
 * du fichier (`/admin.js?v=0.2.3-1a2b3c4d`) : tout fichier modifié est relu,
 * à version égale ou non.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Un fichier local de la racine : `src="/admin.js"`, `href="/style.css"`. */
const MOTIF_FICHIER_LOCAL = /(\b(?:src|href)=")\/([A-Za-z0-9._-]+\.(?:js|css))"/g;

/**
 * Le HTML d'une page, la version — et l'empreinte du contenu, quand elle est
 * connue — ajoutées à l'adresse de ses fichiers locaux. Pure.
 *
 * @param {string} html
 * @param {string} version
 * @param {Object<string, string>} [empreintes] fichier → empreinte courte de son contenu
 */
function versionnerLesFichiers(html, version, empreintes = {}) {
  const v = encodeURIComponent(String(version || '0'));
  return String(html ?? '').replace(MOTIF_FICHIER_LOCAL, (_, attribut, fichier) => {
    const e = /^[0-9a-f]{8}$/.test(empreintes[fichier] || '') ? `-${empreintes[fichier]}` : '';
    return `${attribut}/${fichier}?v=${v}${e}"`;
  });
}

/** L'empreinte courte (8 hexadécimaux) du contenu de chaque fichier local d'une page. */
function empreintesDesFichiers(dossier, html) {
  const empreintes = {};
  for (const [, , fichier] of String(html ?? '').matchAll(MOTIF_FICHIER_LOCAL)) {
    try {
      empreintes[fichier] = require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(dossier, fichier))).digest('hex').slice(0, 8);
    } catch {
      /* fichier absent : l'adresse garde la version seule */
    }
  }
  return empreintes;
}

/**
 * Celui qui envoie les pages d'un dossier.
 *
 * @param {string} dossier le dossier des pages (web/)
 * @param {{version: string, garder?: boolean}} options `garder` : lire chaque
 *   page une seule fois (en production) ; sinon relue à chaque demande, pour
 *   qu'une page modifiée en développement se voie sans redémarrer
 * @returns {(res: import('express').Response, nom: string, statut?: number) => void}
 */
function envoyeurDePages(dossier, { version, garder = false }) {
  const memoire = new Map();
  const lire = (nom) => {
    if (garder && memoire.has(nom)) return memoire.get(nom);
    const brut = fs.readFileSync(path.join(dossier, nom), 'utf8');
    const html = versionnerLesFichiers(brut, version, empreintesDesFichiers(dossier, brut));
    if (garder) memoire.set(nom, html);
    return html;
  };
  return (res, nom, statut = 200) => {
    res.status(statut).set('Cache-Control', 'no-cache').type('html').send(lire(nom));
  };
}

module.exports = {
  MOTIF_FICHIER_LOCAL,
  versionnerLesFichiers,
  empreintesDesFichiers,
  envoyeurDePages,
};
