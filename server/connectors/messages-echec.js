'use strict';

/**
 * Ce qu'on dit à l'utilisateur quand une connexion échoue — et rien d'autre.
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Le 11/08/2026 en production, Propolia a écrit ceci au journal :
 *
 *     02:57:10  Propolia : connexion établie.
 *     02:57:11  Propolia : la page des commandes renvoie à l'authentification
 *               — la session n'a pas tenu.
 *
 * et affiché à l'utilisateur : « Adresse électronique ou mot de passe
 * incorrect ». Les identifiants étaient bons. Une session de test entière est
 * partie à vérifier un mot de passe que rien n'accusait — c'est le message qui
 * mentait, pas le compte.
 *
 * La cause est structurelle : chaque connecteur composait ses phrases à la
 * main, au fil du code, et rien ne garantissait qu'une situation donnée
 * produise le message correspondant. Ici, la correspondance est **une table**,
 * elle est unique, et elle est testée.
 *
 * ─── Les deux règles ─────────────────────────────────────────────────────────
 *
 *   1. **« mot de passe incorrect » ne s'écrit que si la boutique l'a dit.**
 *      Sans message d'erreur affiché par le site, on ne sait pas pourquoi la
 *      connexion a été refusée — et l'inventer coûte une session de test.
 *   2. **Le message ne nomme pas le service.** Il s'affiche toujours sur la
 *      fiche du service concerné, qui porte déjà son nom en titre ; l'y
 *      répéter n'apprend rien, et un message stocké qui nomme un connecteur
 *      devient faux dès qu'il s'affiche ailleurs (§2.2 du lot 14 : « crabe ne
 *      réessaiera pas tout seul sur Propolia » lu sur la fiche d'Aagaard).
 *
 * Le détail technique — texte d'alerte de la boutique, URL finale, classes de
 * l'élément obstruant — va au JOURNAL et au diagnostic (server/diagnostics.js),
 * jamais devant quelqu'un qui n'a aucun moyen d'en faire quelque chose.
 */

/**
 * Les situations distinguées, et le message de chacune.
 *
 * L'ordre est celui du tableau du lot 14, §2.1. Chaque clé est une situation
 * DÉTECTÉE, pas une supposition : un connecteur qui ne sait pas dans laquelle
 * il est doit employer `refus-sans-raison`, qui est précisément le message
 * « on ne sait pas pourquoi ».
 */
const SITUATIONS = {
  /** La boutique a affiché une erreur d'identifiants. Elle, pas nous. */
  'identifiants-refuses': {
    sessionExpired: true,
    message:
      'Adresse électronique ou mot de passe incorrect. Corrigez-les sur la fiche du '
      + 'service, puis relancez.',
  },

  /** Connexion non confirmée, et la boutique n'a rien dit du tout. */
  'refus-sans-raison': {
    sessionExpired: false,
    message:
      'La boutique n\'a pas accepté la connexion sans dire pourquoi. Ce service doit être '
      + 'adapté — signalez-le.',
  },

  /** Une fenêtre du site recouvre le formulaire : ce n'est pas un refus. */
  obstruction: {
    sessionExpired: false,
    message:
      'Une fenêtre du site empêche la connexion. Ce service doit être adapté — '
      + 'signalez-le.',
  },

  /** Connexion CONFIRMÉE, puis perdue plus loin dans le parcours. */
  'session-perdue': {
    sessionExpired: true,
    message:
      'La connexion à ce service a été interrompue. Relancez depuis la fiche du service.',
  },

  /** Le site n'a pas répondu : ni refus, ni obstruction. */
  injoignable: {
    sessionExpired: false,
    message: 'Le site n\'a pas répondu. Réessayez plus tard.',
  },
};

/** Les identifiants de situation reconnus, pour les tests et les garde-fous. */
const CLES = Object.keys(SITUATIONS);

/**
 * Le message destiné à l'utilisateur pour une situation donnée.
 *
 * @param {string} situation une clé de `SITUATIONS`
 * @returns {string}
 * @throws {Error} sur une situation inconnue — c'est une erreur de
 *   programmation, et la laisser passer ramènerait le défaut qu'on corrige :
 *   un message choisi au hasard.
 */
function messagePour(situation) {
  const entree = SITUATIONS[situation];
  if (!entree) throw new Error(`Situation d'échec inconnue : ${situation}`);
  return entree.message;
}

/**
 * L'erreur à lever pour une situation donnée.
 *
 * `expose` la marque comme rédigée pour l'utilisateur (elle traverse les
 * routes telle quelle), `sessionExpired` dit à `connectors/health.js` s'il
 * faut proposer « Se reconnecter » plutôt que « Réessayer ».
 *
 * @param {string} situation
 * @param {{interne?: string}} [options] `interne` : la précision technique,
 *   conservée sur l'erreur pour le JOURNAL — jamais concaténée au message.
 */
function erreurPour(situation, { interne = '' } = {}) {
  const entree = SITUATIONS[situation];
  if (!entree) throw new Error(`Situation d'échec inconnue : ${situation}`);

  const err = new Error(entree.message);
  err.expose = true;
  err.situation = situation;
  err.sessionExpired = entree.sessionExpired;
  if (interne) err.interne = interne;
  return err;
}

/**
 * Quelle situation, d'après ce qui a été observé après la soumission ?
 *
 * Fonction PURE : elle ne regarde pas la page, elle reçoit ce qu'on y a lu.
 * C'est ce qui la rend testable sans navigateur, et c'est elle que le test du
 * §2.1 exerce cas par cas.
 *
 * @param {object} observation
 * @param {boolean} observation.confirme la connexion est prouvée (§1.2a)
 * @param {boolean} [observation.obstrue] un élément recouvre le formulaire
 * @param {boolean} [observation.injoignable] la page n'a pas répondu
 * @param {string}  [observation.alerte] le message d'erreur AFFICHÉ par le site
 * @param {boolean} [observation.apresConfirmation] l'échec survient après une
 *   connexion déjà confirmée (session perdue en cours de route)
 * @returns {string|null} la clé de situation, ou null si rien n'a échoué
 */
function situationDepuis({
  confirme = false,
  obstrue = false,
  injoignable = false,
  alerte = '',
  apresConfirmation = false,
} = {}) {
  // L'injoignabilité prime : sans réponse, aucune des autres questions n'a de
  // sens — on n'a pas de page à regarder.
  if (injoignable) return 'injoignable';

  // Une obstruction constatée explique l'échec à elle seule : le clic n'a
  // jamais atteint le bouton, donc la boutique n'a rien refusé.
  if (obstrue) return 'obstruction';

  // La connexion avait été CONFIRMÉE, et c'est la suite qui casse : c'est une
  // session perdue, pas un mot de passe faux. C'est très exactement le cas que
  // Propolia affichait à l'envers.
  if (apresConfirmation) return confirme ? null : 'session-perdue';

  if (confirme) return null;

  // Non confirmée. Le seul cas où l'on a le droit de parler de mot de passe est
  // celui où la boutique l'a dit elle-même.
  return String(alerte || '').trim() ? 'identifiants-refuses' : 'refus-sans-raison';
}

/**
 * Un échec ne peut JAMAIS être enregistré sans message.
 *
 * Le 14/08/2026, le journal affichait « soyoustart | ÉCHEC | "" » pendant
 * que l'écran affichait « aucune nouvelle facture » : c'était une ligne
 * d'exécution EN COURS, pas encore terminée, que les lecteurs affichaient
 * comme un échec au message vide. L'affichage est corrigé ailleurs — les
 * lecteurs distinguent désormais « en cours » — mais l'épisode a montré ce que
 * vaut un mot rouge sans explication : l'utilisateur relance, se méfie du
 * produit, et personne ne peut reconstituer ce qui s'est passé.
 *
 * D'où cette règle de socle : quand un échec doit être écrit et qu'aucun texte
 * n'a été produit, on en FABRIQUE un qui dit ce qui était en cours et quoi
 * faire ensuite. Jamais une chaîne vide, jamais un message technique brut.
 * Les trois gestes distingués gardent chacun leur phrase : les mutualiser
 * ferait dire « relancez la synchronisation » à un test de connexion.
 */
const ECHECS_SANS_MESSAGE = {
  /** Une récupération de factures s'est arrêtée sans produire d'explication. */
  recuperation:
    'La récupération s\'est arrêtée sans dire pourquoi. Réessayez ; si cela se '
    + 'reproduit, signalez-le.',

  /** Un test de connexion s'est arrêté sans produire d'explication. */
  test:
    'Le test de connexion s\'est arrêté sans dire pourquoi. Réessayez ; si cela '
    + 'se reproduit, signalez-le.',

  /** Ligne restée « en cours » après un arrêt du service : close au démarrage. */
  interrompu:
    'La récupération a été interrompue par un arrêt de crabe avant la fin. '
    + 'Relancez la synchronisation depuis la fiche du service.',
};

/**
 * Ce qui trahit une erreur BRUTE d'automatisation — jamais devant
 * l'utilisateur (lot 37).
 *
 * Les 17 et 18/08/2026, l'écran a affiché tel quel :
 *
 *     page.fill: Timeout 45000ms exceeded.
 *     Call log:
 *       - waiting for locator('input#password2-password-field')
 *
 * C'est du jargon pur, et il MASQUE le vrai problème (le sélecteur ne mord
 * plus). La liste ci-dessous reconnaît les formes produites par l'outil
 * d'automatisation : appels d'API, délais dépassés, journaux d'appel, pannes
 * réseau bas niveau, contexte détruit.
 */
const MOTIF_JARGON_AUTOMATISATION = new RegExp(
  [
    'page\\.(fill|click|goto|type|press|check|selectOption|waitFor\\w*)',
    'locator\\(', 'locator\\.', 'getBy(Role|Text|Label|TestId)\\(',
    'Timeout \\d+\\s*ms exceeded', 'Call log:', 'waiting for (locator|element|navigation|selector)',
    'net::ERR_', 'Target (page|context|browser)', 'browser has been closed',
    'Execution context was destroyed', 'elementHandle\\.', 'frame\\.(fill|click|goto)',
    'Navigation (failed|timeout)', 'strict mode violation',
    'intercepts pointer events', 'ERR_CONNECTION', 'Protocol error',
  ].join('|'),
  'i'
);

/** Ce que l'écran dit à la place — ce qui s'est passé, et quoi faire. */
const MESSAGE_ECRAN_AUTOMATISATION =
  'Le site n\'a pas présenté l\'écran attendu : quelque chose que crabe cherchait '
  + 'n\'est jamais apparu. Réessayez plus tard ; si cela se reproduit, signalez-le — '
  + 'la présentation du site a probablement changé.';

/** Ce message est-il une erreur brute d'automatisation ? */
function porteDuJargon(message) {
  return MOTIF_JARGON_AUTOMATISATION.test(String(message == null ? '' : message));
}

/**
 * Rien de brut à l'écran (lot 37). Une erreur d'automatisation est remplacée
 * par une phrase qui dit ce qui s'est passé et quoi faire ; le texte original
 * est remis à `surJargon`, à charge pour l'appelant de l'écrire AU JOURNAL —
 * c'est là que vit le détail technique, jamais dans l'interface.
 *
 * @param {unknown} message
 * @param {(brut: string) => void} [surJargon] reçoit le texte technique écarté
 * @returns {string} un texte montrable, éventuellement vide
 */
function sansJargon(message, surJargon = null) {
  const texte = String(message == null ? '' : message).trim();
  if (!porteDuJargon(texte)) return texte;
  if (typeof surJargon === 'function') {
    try {
      surJargon(texte);
    } catch {
      /* le journal ne doit jamais faire échouer le message */
    }
  }
  return MESSAGE_ECRAN_AUTOMATISATION;
}

/**
 * Le message d'échec à enregistrer : celui qui a été produit s'il existe,
 * sinon la phrase de secours du geste concerné. C'est le POINT D'ÉCRITURE
 * UNIQUE des échecs : la traduction du jargon d'automatisation vit ici, pour
 * qu'un connecteur futur qui laisse fuir une erreur brute soit couvert sans
 * que personne y pense (même logique que la garde « jamais vide »).
 *
 * @param {unknown} message ce que l'exécution a produit — peut être vide
 * @param {'recuperation'|'test'|'interrompu'} [geste]
 * @param {(brut: string) => void} [surJargon] reçoit le texte technique écarté
 * @returns {string} jamais vide, jamais brut
 */
function messageJamaisVide(message, geste = 'recuperation', surJargon = null) {
  const texte = sansJargon(message, surJargon);
  if (texte) return texte;
  return ECHECS_SANS_MESSAGE[geste] || ECHECS_SANS_MESSAGE.recuperation;
}

module.exports = {
  SITUATIONS,
  CLES,
  ECHECS_SANS_MESSAGE,
  MESSAGE_ECRAN_AUTOMATISATION,
  MOTIF_JARGON_AUTOMATISATION,
  messagePour,
  erreurPour,
  situationDepuis,
  porteDuJargon,
  sansJargon,
  messageJamaisVide,
};
