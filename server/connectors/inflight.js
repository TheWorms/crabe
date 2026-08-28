'use strict';

/**
 * Verrou « une seule à la fois », pour les opérations longues d'un connecteur.
 *
 * ─── Ce qu'il empêche ────────────────────────────────────────────────────────
 *
 * La recherche de ce que porte un compte prend 20 à 60 secondes : un navigateur
 * s'ouvre, se connecte, déplie un menu et bascule sur chaque ligne. Pendant ce
 * temps, l'interface annonçait bien l'attente mais laissait le bouton
 * cliquable. Un utilisateur qui trouve que « ça ne répond pas » reclique — et
 * lançait un SECOND navigateur sur le même compte, chez le même fournisseur, à
 * partir de la même session. Free Mobile n'apprécie pas, le conteneur non plus
 * (près d'un gigaoctet par navigateur), et les deux recherches se marchent
 * dessus pour écrire la même découverte.
 *
 * Griser le bouton côté interface est nécessaire mais ne suffit pas : un
 * deuxième onglet, un rechargement de page, un appel direct à l'API passeraient
 * à travers. Le verrou est donc ICI, côté serveur, et l'interface ne fait que
 * le rendre visible.
 *
 * ─── Le sursis, et pourquoi il existe ────────────────────────────────────────
 *
 * Un verrou pris et jamais rendu enferme l'utilisateur dehors définitivement :
 * plus aucune recherche possible jusqu'au prochain redémarrage du service, sans
 * rien pour l'expliquer. Le `finally` de `run()` couvre l'échec, l'exception et
 * l'abandon — mais pas une promesse qui ne se règle jamais (un navigateur figé
 * sur un portail qui ne répond plus ni en succès ni en erreur).
 *
 * Passé `timeoutMs`, un verrou est donc considéré comme abandonné et repris. Le
 * choix est délibérément dans ce sens : reprendre trop tôt fait au pire tourner
 * deux recherches, reprendre trop tard fait un logiciel cassé.
 *
 * ─── La preuve de vie, et pourquoi le chronomètre seul ne suffisait pas ──────
 *
 * Ce compromis a été pensé pour `run()`, dont la fin est un `await` : la durée
 * d'une récupération se borne. Il ne vaut PAS pour `acquire()`, dont le cycle
 * de vie est un GESTE HUMAIN — mesuré le 23/08/2026 : la fenêtre de connexion
 * Bricomarché de l'utilisateur est restée ouverte plus de vingt minutes (un
 * mot de passe impossible à coller), très au-delà du sursis. Le verrou était
 * donc jugé abandonné PENDANT qu'il travaillait dedans, et un second
 * navigateur pouvait s'ouvrir sur le même profil — précisément ce que ce
 * module existe pour empêcher.
 *
 * D'où la `preuveDeVie` optionnelle d'`acquire()` : passé le sursis, le verrou
 * n'est repris QUE si elle dit que le détenteur est mort. Un profil dont le
 * navigateur tourne encore n'est pas abandonné, quel que soit le chronomètre ;
 * un navigateur tué (`kill`, le `SingletonLock` du profil restant avec un PID
 * mort — le geste du 23/08/2026 au matin) rend la preuve fausse, et le verrou
 * est repris : l'utilisateur n'est jamais enfermé dehors. Une preuve qui LÈVE
 * compte comme une mort : dans le doute, on garde la raison d'être du sursis.
 */

/** Cinq minutes : le double du pire cas mesuré chez Free Mobile. */
const VERROU_PERIME_MS = 5 * 60 * 1000;

/**
 * @param {{now?: () => number, timeoutMs?: number}} [options]
 */
function createLock({ now = () => Date.now(), timeoutMs = VERROU_PERIME_MS } = {}) {
  /** @type {Map<string, {depuis: number, label: string, preuveDeVie: (() => boolean)|null}>} */
  const enCours = new Map();

  /** Le verrou est-il pris, et encore valable ? */
  function busy(key) {
    const pris = enCours.get(key);
    if (!pris) return false;
    if (now() - pris.depuis < timeoutMs) return true;
    // Sursis épuisé. Si le détenteur a laissé une preuve de vie, c'est ELLE
    // qui tranche : un geste humain ne se borne pas au chronomètre (la
    // fenêtre Bricomarché du 23/08/2026, vingt minutes de mot de passe). Une
    // preuve qui lève compte comme une mort — le sursis garde sa raison
    // d'être : ne jamais enfermer l'utilisateur dehors.
    if (typeof pris.preuveDeVie === 'function') {
      let vivant = false;
      try {
        vivant = !!pris.preuveDeVie();
      } catch {
        vivant = false;
      }
      if (vivant) return true;
    }
    // Abandonné : on le reprend plutôt que d'enfermer le compte dehors.
    enCours.delete(key);
    return false;
  }

  /** Depuis quand, en secondes. Sert à écrire un refus qui dit quelque chose. */
  function since(key) {
    const pris = enCours.get(key);
    return pris ? Math.max(0, Math.round((now() - pris.depuis) / 1000)) : null;
  }

  /**
   * QUI tient le verrou — l'étiquette posée à la prise (« fenêtre de
   * connexion », « récupération »…), ou null s'il est libre. C'est elle qui
   * permet d'écrire un refus qui dit QUOI attendre, pas juste « occupé ».
   */
  function holder(key) {
    return busy(key) ? enCours.get(key).label || null : null;
  }

  /** Le refus, toujours de la même forme : 409, `alreadyRunning`, l'ancienneté. */
  function refus(key, message) {
    const err = new Error(message);
    err.statusCode = 409;
    err.alreadyRunning = true;
    err.sinceSeconds = since(key);
    return err;
  }

  /**
   * Exécute `fn` sous le verrou `key`.
   *
   * @param {string} key
   * @param {() => Promise<*>} fn
   * @param {string} [message] refus affiché à l'utilisateur si le verrou est pris
   * @param {string} [label] qui prend le verrou — relu par `holder()`
   * @returns {Promise<*>}
   * @throws {Error} avec `statusCode = 409` et `alreadyRunning` si déjà pris
   */
  async function run(key, fn, message = 'Une opération est déjà en cours — attendez qu\'elle se termine.', label = '') {
    if (busy(key)) throw refus(key, message);

    enCours.set(key, { depuis: now(), label, preuveDeVie: null });
    try {
      return await fn();
    } finally {
      enCours.delete(key);
    }
  }

  /**
   * Prend le verrou SANS l'encadrer — pour les usages dont la fin n'est pas
   * un `await` : la fenêtre de connexion vit jusqu'au geste de l'utilisateur,
   * pas jusqu'au bout d'une promesse. À rendre soi-même par `release()`,
   * depuis le point de sortie UNIQUE du cycle de vie ; le sursis de
   * `timeoutMs` couvre, comme pour `run()`, le cas où ce point n'est jamais
   * atteint.
   *
   * La durée d'un geste humain ne se devine pas : le détenteur qui SAIT dire
   * s'il est encore vivant passe une `preuveDeVie` — consultée seulement une
   * fois le sursis épuisé. Tant qu'elle rend vrai, le verrou tient ; dès
   * qu'elle rend faux (ou lève), il est repris. Voir l'en-tête du fichier.
   *
   * @param {string} key
   * @param {string} [label] qui prend le verrou — relu par `holder()`
   * @param {string} [message] refus affiché à l'utilisateur si déjà pris
   * @param {{preuveDeVie?: () => boolean}} [options] le détenteur est-il
   *   encore là ? (le Chromium de la fenêtre tourne-t-il toujours ?)
   * @throws {Error} avec `statusCode = 409` et `alreadyRunning` si déjà pris
   */
  function acquire(key, label = '', message = 'Une opération est déjà en cours — attendez qu\'elle se termine.', { preuveDeVie = null } = {}) {
    if (busy(key)) throw refus(key, message);
    enCours.set(key, { depuis: now(), label, preuveDeVie: typeof preuveDeVie === 'function' ? preuveDeVie : null });
  }

  /** Libère un verrou de force. Réservé à l'arrêt du service et aux tests. */
  function release(key) {
    return enCours.delete(key);
  }

  return {
    run,
    busy,
    since,
    holder,
    acquire,
    release,
    get size() {
      // Les verrous périmés ne comptent pas : `size` doit dire ce qui tourne
      // vraiment, pas ce qui a été oublié.
      return [...enCours.keys()].filter((key) => busy(key)).length;
    },
  };
}

/** Le verrou des recherches (« découverte »), partagé par tout le processus. */
const discovery = createLock();

/** Clé d'une recherche : un compte, un connecteur. */
const discoveryKey = (userId, connectorId) => `${userId}:${connectorId}`;

/**
 * Un profil de navigateur persistant ne supporte qu'UN Chromium à la fois :
 * le second à l'ouvrir meurt sur le verrou de Chromium lui-même
 * (« ProcessSingleton »), avec un message technique brut. Mesuré le
 * 19/08/2026 à 23:39 : une récupération SNCF tenait le profil pendant qu'une
 * fenêtre de connexion tentait de s'y ouvrir. Ce verrou-ci arbitre AVANT
 * d'ouvrir quoi que ce soit, des deux côtés — fenêtre de connexion
 * (remote-browser.js) comme récupération (auth-sncf.js) — et le refus dit
 * quoi attendre, en français.
 *
 * Le sursis est plus long que celui des recherches : une récupération sur
 * profil visite des dizaines de pages, avec des attentes de 45 secondes.
 */
const PROFIL_PERIME_MS = 15 * 60 * 1000;
const profil = createLock({ timeoutMs: PROFIL_PERIME_MS });

/** Clé d'un profil : un compte, un connecteur — comme le dossier sur disque. */
const profilKey = (userId, connectorId) => `${userId}:${connectorId}`;

/** Les étiquettes des porteurs du verrou de profil, relues par `holder()`. */
const PORTEUR_FENETRE = 'fenêtre de connexion';
const PORTEUR_RECUPERATION = 'récupération';

module.exports = {
  VERROU_PERIME_MS,
  PROFIL_PERIME_MS,
  createLock,
  discovery,
  discoveryKey,
  profil,
  profilKey,
  PORTEUR_FENETRE,
  PORTEUR_RECUPERATION,
};
