'use strict';

/**
 * L'identité que les navigateurs de crabe présentent aux sites.
 *
 * ─── Le défaut que ce module corrige ─────────────────────────────────────────
 *
 * En mode invisible (`headless: true`), Playwright annonce de lui-même un agent
 * utilisateur qui contient le mot **`HeadlessChrome`** :
 *
 *   Mozilla/5.0 (X11; Linux x86_64) … HeadlessChrome/151.0.0.0 Safari/537.36
 *
 * Certains pare-feux applicatifs le rejettent d'office, sans autre forme de
 * procès. Vérifié le 11/08/2026 contre Fantazia : **la même requête, avec la
 * même session**, renvoie `403` avec l'agent par défaut et `200` avec un agent
 * réaliste. Rien dans la réponse ne dit pourquoi — pas de page d'erreur
 * explicite, pas de redirection : un `403` sec.
 *
 * **Tous les connecteurs de crabe tournent en mode invisible en production.**
 * Ils fonctionnent aujourd'hui parce qu'aucun des quatre portails concernés
 * n'applique ce filtre ; le jour où l'un d'eux l'ajoutera, il tombera sans
 * qu'on comprenne pourquoi — et le symptôme (`403` à la récupération) ressemble
 * trait pour trait à une session expirée, ce qui enverrait chercher très loin
 * de la cause.
 *
 * D'où un seul agent, ici, pour TOUS les contextes de navigateur : les
 * connecteurs sur mesure, les recettes génériques, le navigateur distant et
 * l'outil de capture de session. Un endroit à corriger, pas sept.
 *
 * ─── Pourquoi la version n'est pas écrite en dur ─────────────────────────────
 *
 * Un agent qui annonce Chrome 131 alors que le moteur est un Chrome 151 est un
 * mensonge vérifiable : les en-têtes `Sec-CH-UA` que Chromium envoie de
 * lui-même portent sa VRAIE version, et une incohérence entre les deux est
 * exactement le genre de signal qu'un pare-feu applicatif relève. La version
 * est donc lue sur le Chromium embarqué par Playwright, et l'agent se met à
 * jour tout seul à chaque mise à niveau de la dépendance.
 *
 * La valeur figée ne sert que de repli, quand Playwright est absent — cas
 * normal en test, où aucun navigateur n'est ouvert de toute façon.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/**
 * Version de repli, utilisée quand le Chromium embarqué n'est pas lisible.
 *
 * Volontairement plausible et récente plutôt que « juste » : mieux vaut un
 * agent d'une version un peu ancienne qu'un agent qui annonce un navigateur
 * automatisé.
 */
const VERSION_DE_REPLI = '131.0.0.0';

/** La langue que les portails français attendent, sur tous les contextes. */
const LOCALE = 'fr-FR';

/**
 * L'agent utilisateur, une fois la version connue.
 *
 * La forme est celle d'un Chrome de bureau sous Linux — c'est ce que le
 * conteneur fait réellement tourner. Se faire passer pour un Windows ou un
 * macOS ajouterait une deuxième incohérence avec les en-têtes `Sec-CH-UA-*`.
 */
function agentPour(version) {
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + `Chrome/${version} Safari/537.36`
  );
}

/**
 * La version du Chromium embarqué par Playwright, ramenée à `<majeure>.0.0.0`.
 *
 * `browsers.json` est le registre que Playwright consulte lui-même pour savoir
 * quoi télécharger : c'est la source la plus fiable, et surtout la seule
 * lisible **sans lancer de navigateur**. Le fichier n'est pas exposé par les
 * `exports` du paquet, d'où la lecture par chemin plutôt que par `require`.
 *
 * Les trois derniers nombres sont remis à zéro, comme le fait Chrome depuis sa
 * version 101 : l'agent n'annonce plus le numéro de compilation exact.
 *
 * @returns {string|null}
 */
function versionChromiumEmbarque() {
  try {
    const racine = nodePath.dirname(require.resolve('playwright-core/package.json'));
    const registre = JSON.parse(
      nodeFs.readFileSync(nodePath.join(racine, 'browsers.json'), 'utf8')
    );
    // « chromium-headless-shell » porte la même version ; on vise le vrai
    // Chromium, celui que `chromium.launch()` ouvre.
    const chromium = (registre?.browsers || []).find((b) => b?.name === 'chromium');
    return majeureVersOnzeZeros(chromium?.browserVersion);
  } catch {
    // Playwright absent (le cas en test), registre déplacé par une future
    // version : le repli fait le travail.
    return null;
  }
}

/** « 151.0.7922.34 » → « 151.0.0.0 ». Renvoie null si ce n'est pas une version. */
function majeureVersOnzeZeros(brut) {
  const majeure = /^(\d+)\./.exec(String(brut || ''));
  return majeure ? `${majeure[1]}.0.0.0` : null;
}

/**
 * L'agent utilisateur de crabe.
 *
 * Mémoïsé : le registre de Playwright ne change pas en cours d'exécution, et
 * cette fonction est appelée à chaque ouverture de contexte.
 *
 * @returns {string}
 */
function agentUtilisateur() {
  if (agentUtilisateur.cache) return agentUtilisateur.cache;
  agentUtilisateur.cache = agentPour(versionChromiumEmbarque() || VERSION_DE_REPLI);
  return agentUtilisateur.cache;
}

/** Oublie la valeur mémoïsée — réservé aux tests. */
function oublier() {
  agentUtilisateur.cache = null;
}

/**
 * Options de `browser.newContext()`, identité comprise.
 *
 * **C'est cette fonction qu'un connecteur appelle**, plutôt que de recopier
 * `userAgent` et `locale` : le jour où il faudra ajouter un en-tête ou un
 * fuseau, il y aura un seul endroit à toucher. Ce que l'appelant fournit a le
 * dernier mot — un connecteur peut imposer son `storageState`, son `viewport`
 * ou, s'il le fallait vraiment, son propre agent.
 *
 * @param {object} [options] options propres au connecteur
 * @returns {object}
 */
function optionsContexte(options = {}) {
  return {
    userAgent: agentUtilisateur(),
    locale: LOCALE,
    ...options,
  };
}

/**
 * Options de `chromium.launch()` pour un navigateur HEADLESS de connecteur.
 *
 * ─── Le drapeau qui décide si un pare-feu applicatif re-challenge (lot 34) ───
 *
 * `--disable-blink-features=AutomationControlled` retire `navigator.webdriver`,
 * le marqueur que Chromium expose de lui-même quand il est piloté. La fenêtre
 * visible du socle le porte depuis le lot 21 (Google refusait sinon
 * d'afficher son formulaire). Les connecteurs HEADLESS, eux, lançaient
 * `chromium.launch({ headless: true })` SANS lui — et personne ne pouvait s'en
 * apercevoir tant qu'un portail ne jugeait pas le navigateur lui-même.
 *
 * Hetzner en juge un : sa garde « HeRay » (une preuve de travail sur
 * `/_ray/pow`). Mesuré le 14/08/2026 sur le CT, deux navigateurs headless
 * neufs, sans identifiants, chargeant la page de connexion :
 *
 *     sans le drapeau  → bloqué sur /_ray/pow au-delà de 60 s (jamais le formulaire)
 *     avec le drapeau  → /login atteint en 1 s, HeRay franchi
 *
 * C'est l'explication de l'« expiration en quelques heures » relevée aux lots
 * 32 et 33 : la fenêtre visible (qui porte le drapeau) obtient une levée, la
 * session est capturée, mais le connecteur la rejoue headless SANS le drapeau.
 * Tant que la levée capturée vaut (quelques heures, côté serveur), ça passe ;
 * dès qu'elle expire, HeRay re-challenge — et le navigateur headless
 * automation-marqué ne sait pas refaire la preuve de travail. Avec le drapeau,
 * le connecteur franchit HeRay LUI-MÊME à chaque exécution, et ne dépend plus
 * de la durée de vie d'une levée.
 *
 * Les autres drapeaux visent le conteneur : `/dev/shm` minuscule (Chromium y
 * meurt), et le bac à sable que le LXC non privilégié n'autorise pas.
 *
 * @param {object} [options] options propres au connecteur (fusionnées ensuite)
 * @returns {object} à passer tel quel à `chromium.launch()`
 */
function optionsLancement(options = {}) {
  const { args = [], ...reste } = options;
  return {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...args,
    ],
    ...reste,
  };
}

/**
 * Ce document est-il un PDF ?
 *
 * **On regarde le CONTENU, jamais l'en-tête.** Apiculture.net sert ses factures
 * en `application/octet-stream` : refuser sur le type déclaré perdrait des
 * documents parfaitement valides. À l'inverse, un portail qui a laissé la
 * session expirer renvoie une page HTML de connexion avec un
 * `content-type: application/pdf` bien propre — s'y fier ferait déposer du HTML
 * dans le dossier des factures, sans que rien ne le signale.
 *
 * Les cinq premiers octets d'un PDF sont `%PDF-`, et c'est vrai de toutes les
 * versions du format.
 *
 * @param {Buffer|Uint8Array|null} buffer
 * @returns {boolean}
 */
function estPdf(buffer) {
  if (!buffer || typeof buffer.subarray !== 'function' || buffer.length < 5) return false;
  return Buffer.from(buffer.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/** Le préfixe qui fait foi, exporté pour que les tests ne le réinventent pas. */
const SIGNATURE_PDF = '%PDF-';

module.exports = {
  LOCALE,
  SIGNATURE_PDF,
  VERSION_DE_REPLI,
  agentPour,
  agentUtilisateur,
  versionChromiumEmbarque,
  majeureVersOnzeZeros,
  optionsContexte,
  optionsLancement,
  estPdf,
  oublier,
};
