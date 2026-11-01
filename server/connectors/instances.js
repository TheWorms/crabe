'use strict';

/**
 * Un autre compte sur le même site (0.2.15, lot l9).
 *
 * Choix du compte observé, le 01/11/2026. Jusqu'ici, un service n'existait qu'une fois
 * par compte crabe (`UNIQUE (user_id, connector_id)`) : un second identifiant
 * Amazon REMPLAÇAIT le premier.
 *
 * Un second compte est une installation à part entière, sous un identifiant
 * DÉRIVÉ : `amazon--2`, `amazon--3`… Il reprend le code, le manifeste et le
 * logo du service (`amazon`), et tout ce qui se range par identifiant de
 * service — configuration, planification, session, journal, documents,
 * visite d'entretien, reconnexion — lui est propre sans rien changer
 * ailleurs. Ses documents vont dans le dossier du SERVICE (« Amazon »), sous
 * leur propre dossier de compte.
 *
 * Aucun identifiant de connecteur ne contient `--` (essai : bilan-0215) : la
 * forme ne peut pas désigner un service existant.
 *
 * Pur, sauf `dans()` : le compte EN COURS d'une récupération, porté par
 * `AsyncLocalStorage`. Les connecteurs ouvrent leur profil de navigateur sous
 * leur identifiant écrit en dur (`profilPersistant.preparer(userId, ID)`) ;
 * pendant la récupération d'un second compte, `pourLeProfil` le ramène au
 * second compte — sinon il rouvrirait la connexion du premier.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const MOTIF = /^([a-z0-9]+(?:-[a-z0-9]+)*)--([1-9][0-9]{0,2})$/;

/** `{base, numero}` pour un identifiant de second compte, sinon null. */
function analyser(id) {
  const m = MOTIF.exec(String(id ?? ''));
  if (!m) return null;
  const numero = Number(m[2]);
  return numero >= 2 ? { base: m[1], numero } : null;
}

/** L'identifiant du service : `amazon` pour `amazon--2`, l'identifiant lui-même sinon. */
function baseDe(id) {
  return analyser(id)?.base || id;
}

function estInstance(id) {
  return !!analyser(id);
}

function idInstance(base, numero) {
  return `${base}--${numero}`;
}

const courant = new AsyncLocalStorage();

/** Exécute `fn` pour le compte `connectorId` (installation de base ou second compte). */
function dans(connectorId, fn) {
  return courant.run({ connectorId }, fn);
}

/**
 * L'identifiant sous lequel ouvrir un profil de navigateur : le second compte
 * en cours quand le code demande le profil de son service, l'identifiant
 * demandé sinon.
 */
function pourLeProfil(connectorId) {
  const enCours = courant.getStore()?.connectorId;
  return enCours && enCours !== connectorId && baseDe(enCours) === connectorId ? enCours : connectorId;
}

module.exports = { MOTIF, analyser, baseDe, estInstance, idInstance, dans, pourLeProfil };
