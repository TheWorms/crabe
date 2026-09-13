'use strict';

/**
 * Le profil de navigateur PERSISTANT — où il vit, et pourquoi il existe.
 *
 * ─── Le problème qu'il résout ────────────────────────────────────────────────
 *
 * Les connecteurs à session enregistrent un `storageState` : les cookies du
 * navigateur, chiffrés en base. C'est léger, c'est sûr, et ça suffit à Free
 * Mobile comme à impots.gouv.fr.
 *
 * Ça ne suffit PAS aux sites protégés par Cloudflare. Vérifié le 11/08/2026
 * sur addons.prestashop.com : un contexte neuf nourri des mêmes cookies reste
 * bloqué sur « Performing security verification », en boucle, alors que le
 * même site s'ouvre normalement sur un profil persistant — le répertoire
 * `--user-data-dir` de Chromium.
 *
 * La différence tient à ce que la protection examine. Un `storageState` ne
 * transporte que des cookies ; un profil transporte l'état complet du
 * navigateur — stockage local, base indexée, préférences, et les jetons que
 * Cloudflare y dépose après un challenge résolu.
 *
 * ─── Ce que ça coûte, dit franchement ────────────────────────────────────────
 *
 * Un profil vit EN CLAIR sur le disque, contrairement aux sessions chiffrées.
 * Quiconque lit ce répertoire lit les cookies du compte. D'où :
 *
 *   - 0700 sur chaque répertoire, et sur la racine qui les contient ;
 *   - un dossier par couple (utilisateur, connecteur), jamais partagé ;
 *   - rangé sous `dataDir`, comme les diagnostics et les exports — donc dans
 *     ce que l'administrateur sauvegarde et protège déjà.
 *
 * Il pèse quelques mégaoctets, contre quelques kilo-octets pour une session.
 *
 * ─── Pourquoi un module à part ───────────────────────────────────────────────
 *
 * Le chemin est calculé à DEUX endroits qui ne se connaissent pas : le
 * navigateur distant, qui ouvre la fenêtre où l'utilisateur se connecte, et le
 * connecteur, qui rouvre ce même profil pour récupérer. Deux calculs
 * séparés, c'est deux occasions de viser des répertoires différents — et une
 * connexion ouverte à la main qui ne servirait à rien.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** Sous `dataDir`, à côté des diagnostics et des exports. */
const DOSSIER = 'profils-navigateur';

/**
 * Un identifiant utilisable comme nom de dossier.
 *
 * Tout ce qui n'est pas alphanumérique devient `_` : un `connectorId` vient du
 * manifeste et un `userId` de la base, mais aucun des deux n'a à composer un
 * chemin sans être filtré.
 */
function segment(valeur) {
  return String(valeur ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'inconnu';
}

/** La racine des profils. Jamais créée avant qu'on en écrive un. */
function racine() {
  return nodePath.join(require('../config').config.dataDir, DOSSIER);
}

/**
 * Le répertoire de profil d'un couple (utilisateur, connecteur).
 *
 * @param {number|string} userId
 * @param {string} connectorId
 * @returns {string} chemin absolu
 */
function chemin(userId, connectorId) {
  return nodePath.join(racine(), segment(userId), segment(connectorId));
}

/**
 * Crée le répertoire s'il manque, en 0700, et rend son chemin.
 *
 * La racine est créée en 0700 elle aussi : un répertoire parent lisible par
 * tous laisserait deviner qui utilise quel service, même si les profils
 * eux-mêmes sont fermés.
 *
 * @param {number|string} userId
 * @param {string} connectorId
 * @returns {string} chemin absolu
 */
function preparer(userId, connectorId) {
  const base = racine();
  nodeFs.mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    nodeFs.chmodSync(base, 0o700);
  } catch {
    // Racine déjà correcte, ou appartenant à un autre utilisateur : ce n'est
    // pas à ce module de trancher, et échouer ici priverait l'utilisateur
    // d'une connexion pour un droit qu'il n'a peut-être pas à changer.
  }

  const dossier = chemin(userId, connectorId);
  nodeFs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  try {
    nodeFs.chmodSync(dossier, 0o700);
  } catch {
    /* idem */
  }
  garderCookiesDeSession(dossier);
  purgerPileDOnglets(dossier);
  return dossier;
}

/**
 * Pose la préférence Chromium « reprendre où j'en étais »
 * (`session.restore_on_startup = 1`) dans le profil, AVANT son ouverture.
 *
 * Sans elle, Chromium PURGE les cookies de session — ceux sans date
 * d'expiration — à chaque fermeture propre. Mesuré le 12/08/2026 sur
 * addons.prestashop.com : le backend adosse le cookie persistant de connexion
 * à des cookies transitoires (PHPSESSID…) ; un profil qui revient sans eux est
 * déconnecté CÔTÉ SERVEUR dès la première requête
 * (302 → /fr/?logout=&oauth2Callback= → /en/), et cette déconnexion révoque
 * aussi le SSO authv2 — session entière perdue, reconnexion humaine exigée.
 * Avec la préférence, le PHPSESSID du même profil a survécu à deux cycles
 * ouverture/fermeture Playwright consécutifs (constaté en production).
 *
 * Écrite profil FERMÉ — `preparer()` précède toujours l'ouverture — pour que
 * Chromium la lise au lancement. Un fichier Preferences illisible n'est PAS
 * écrasé : un profil malade se répare à la main, pas en piétinant ce qui
 * reste.
 */
function garderCookiesDeSession(dossier) {
  const fichier = nodePath.join(dossier, 'Default', 'Preferences');
  let prefs = {};
  try {
    const lu = JSON.parse(nodeFs.readFileSync(fichier, 'utf8'));
    if (!lu || typeof lu !== 'object' || Array.isArray(lu)) return;
    prefs = lu;
  } catch (err) {
    if (err?.code !== 'ENOENT') return;
  }
  if (prefs.session?.restore_on_startup === 1) return;
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
  nodeFs.mkdirSync(nodePath.dirname(fichier), { recursive: true, mode: 0o700 });
  nodeFs.writeFileSync(fichier, JSON.stringify(prefs));
}

/**
 * Retire la pile d'onglets mémorisée, sans toucher aux cookies.
 *
 * `restore_on_startup = 1` a un effet de bord : Chromium mémorise la pile
 * d'onglets de la dernière session dans `Default/Sessions/{Session_*,Tabs_*}`
 * et la RESTAURE à l'ouverture suivante. Après une récupération qui a visité
 * des dizaines de pages, la fenêtre de connexion s'ouvre sur cette pile —
 * constaté en production le 19/08/2026 (~30 onglets sur sncf-connect).
 *
 * Les cookies vivent ailleurs (`Default/Cookies`) : supprimer ces fichiers
 * n'y touche pas, et la préférence — qui, elle, protège les cookies de
 * session (voir garderCookiesDeSession) — reste posée. Appelée profil FERMÉ,
 * avant chaque ouverture, fenêtre comme récupération : restaurer une pile
 * ne sert personne.
 */
function purgerPileDOnglets(dossier) {
  const sessions = nodePath.join(dossier, 'Default', 'Sessions');
  let entrees = [];
  try {
    entrees = nodeFs.readdirSync(sessions);
  } catch {
    return; // Pas de dossier Sessions : rien à purger.
  }
  for (const nom of entrees) {
    if (!nom.startsWith('Session_') && !nom.startsWith('Tabs_')) continue;
    try {
      nodeFs.rmSync(nodePath.join(sessions, nom), { force: true });
    } catch {
      // Un fichier récalcitrant ne doit pas priver l'utilisateur de sa
      // fenêtre : au pire, la pile revient une fois de plus.
    }
  }
}

/**
 * Ce profil a-t-il déjà servi ?
 *
 * Un répertoire créé mais vide n'est pas une connexion : Chromium y écrit
 * `Default/Cookies` dès la première session. C'est ce fichier qu'on cherche,
 * pas le dossier.
 *
 * @param {number|string} userId
 * @param {string} connectorId
 */
function existe(userId, connectorId) {
  const dossier = chemin(userId, connectorId);
  for (const relatif of ['Default/Cookies', 'Default/Preferences']) {
    if (nodeFs.existsSync(nodePath.join(dossier, relatif))) return true;
  }
  return false;
}

/**
 * Un Chromium tourne-t-il ENCORE sur ce profil ?
 *
 * C'est la preuve de vie du verrou de fenêtre (lot 51) : la fenêtre de
 * connexion vit le temps d'un geste humain dont la durée ne se devine pas —
 * mesuré le 23/08/2026, plus de vingt minutes sur un mot de passe impossible
 * à coller. Un chronomètre seul jugeait ce verrou abandonné pendant que
 * l'utilisateur travaillait dedans.
 *
 * Le témoin est celui de Chromium lui-même : le lien symbolique
 * `SingletonLock` du profil, dont la cible est `<hôte>-<pid>`. Trois cas :
 *
 *   - pas de lien → aucun navigateur (fermeture propre : Chromium le retire) ;
 *   - lien vers un PID mort → navigateur TUÉ (`kill` — le geste du matin du
 *     23/08/2026 : les processus meurent, le lien reste) : pas vivant ;
 *   - lien vers un PID vivant dont le nom de processus est bien un Chromium →
 *     vivant. Le nom est vérifié parce qu'un PID se recycle : un autre
 *     processus qui hérite du numéro ne doit pas faire tenir le verrou — le
 *     doute enferme l'utilisateur dehors, et c'est le pire des deux défauts.
 *
 * @param {string} dossier le répertoire du profil (`chemin(userId, connectorId)`)
 * @returns {boolean}
 */
function navigateurVivant(dossier) {
  let cible;
  try {
    cible = nodeFs.readlinkSync(nodePath.join(dossier, 'SingletonLock'));
  } catch {
    return false; // pas de lien : aucun navigateur sur ce profil
  }
  const pid = Number((/-(\d+)$/.exec(String(cible)) || [])[1]);
  if (!pid) return false;
  let nom;
  try {
    nom = nodeFs.readFileSync(`/proc/${pid}/comm`, 'utf8');
  } catch {
    return false; // processus mort : le lien a survécu au kill
  }
  return /chrom/i.test(nom);
}

/**
 * Efface le profil d'un couple (utilisateur, connecteur).
 *
 * Appelé à la désinstallation d'un connecteur : les cookies d'un service qu'on
 * retire n'ont aucune raison de survivre sur le disque.
 *
 * @returns {boolean} vrai si quelque chose a été effacé
 */
function effacer(userId, connectorId) {
  const dossier = chemin(userId, connectorId);
  if (!nodeFs.existsSync(dossier)) return false;
  nodeFs.rmSync(dossier, { recursive: true, force: true });
  return true;
}

module.exports = {
  DOSSIER,
  segment,
  racine,
  chemin,
  preparer,
  garderCookiesDeSession,
  purgerPileDOnglets,
  existe,
  navigateurVivant,
  effacer,
};
