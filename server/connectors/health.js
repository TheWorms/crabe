'use strict';

/**
 * L'état d'un connecteur, et **l'action qui le résout**.
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Jusqu'au lot 6, un connecteur en échec proposait « Synchroniser » — quel que
 * soit l'échec. Or les trois pannes réelles ne se résolvent PAS en
 * resynchronisant :
 *
 *   - jamais configuré       → il n'y a rien à synchroniser ;
 *   - connexion expirée      → resynchroniser rejoue une session morte ;
 *   - identifiants refusés   → resynchroniser les refait refuser.
 *
 * Dans les trois cas, le bouton proposé ramenait à l'échec de départ. C'est le
 * genre de boucle qui donne l'impression que le logiciel est cassé, alors que
 * la seule chose qui manquait était de dire quoi faire.
 *
 * Ce module répond donc à une question et une seule : **cet état-là, on en
 * sort comment ?** Il est appelé par la fiche du connecteur, par l'accueil et
 * par l'écran d'erreur — les trois endroits où l'utilisateur croise l'état d'un
 * connecteur. Une seule règle, un seul vocabulaire, et rien à retenir de plus
 * d'un écran à l'autre.
 *
 * ─── Ce qu'on ne dit jamais ──────────────────────────────────────────────────
 *
 * Ni « needs-config », ni « status », ni « storageState », ni « 401 ». Les
 * `code` de ce module servent au programme ; ce qui va à l'écran, ce sont
 * `title`, `detail` et `action.label`, écrits pour quelqu'un qui n'a jamais
 * ouvert un terminal.
 */

/**
 * Ce qui, dans un message d'échec, désigne un problème d'identité plutôt qu'un
 * incident passager.
 *
 * Volontairement large : se tromper dans ce sens propose « Reconfigurer » à qui
 * aurait pu s'en tirer avec un nouvel essai — désagrément mineur. Se tromper
 * dans l'autre sens renvoie l'utilisateur vers un bouton qui échouera à coup
 * sûr, ce qui est exactement le défaut qu'on corrige ici.
 */
const ECHEC_IDENTITE =
  /identifiant|mot de passe|authentifi|connexion refus|non connect|session|expir|invalide|incorrect|refus|401|403/i;

/** Les états, dans l'ordre de gravité décroissante pour l'affichage. */
const CODES = ['error', 'session-expired', 'not-configured', 'ready', 'available', 'planned'];

/**
 * Une session enregistrée est-elle arrivée à échéance ?
 * @param {object|null} configSummary
 */
function hasExpiredSession(configSummary) {
  return Object.values(configSummary?.sessions || {}).some((s) => s && s.expired);
}

/** Nombre d'éléments retenus par la découverte (lignes, contrats, compteurs). */
function followed(configSummary) {
  for (const [, found] of Object.entries(configSummary?.discoveries || {})) {
    if (Array.isArray(found?.selection)) return found.selection.length;
    // Jamais choisi : ce qui est présélectionné fait foi, comme à la récupération.
    if (found?.items?.length) return found.items.filter((i) => i.preselected !== false).length;
  }
  return null;
}

/**
 * « ligne » → « 2 lignes suivies ». Rien à afficher quand il n'y a rien à choisir.
 *
 * Le participe s'accorde en nombre ET en genre. Le genre ne se devine pas en
 * français — « une ligne » mais « un compte », tous deux en -e — il est donc
 * déclaré par le manifeste (`unitFeminine`), masculin par défaut.
 */
function followedLabel(connector, configSummary) {
  const count = followed(configSummary);
  if (count === null) return null;
  const field = (connector.fields || []).find((f) => f.type === 'multiselect');
  const unit = field?.unit || 'élément';
  const pluriel = count > 1 ? 's' : '';
  const feminin = field?.unitFeminine ? 'e' : '';
  return `${count} ${unit}${pluriel} suivi${feminin}${pluriel}`;
}

/**
 * État complet d'un connecteur pour un compte donné.
 *
 * @param {object} connector vue publique enrichie (registry.listForUser)
 * @returns {{code: string, title: string, detail: string, tone: string,
 *            action: {id: string, label: string},
 *            canSync: boolean, canReconfigure: boolean,
 *            connected: boolean, followedLabel: string|null}}
 */
function evaluate(connector) {
  const nom = connector?.name || 'Ce service';
  const summary = connector?.configSummary || null;
  const parNavigateur = !!connector?.remoteLogin?.url;

  // Le geste de (re)configuration ne porte pas le même nom selon la façon dont
  // on se connecte chez ce fournisseur : « Se connecter à Free Mobile » ouvre
  // une fenêtre, « Configurer » ouvre un formulaire.
  const seConnecter = {
    id: parNavigateur ? 'connect' : 'configure',
    label: parNavigateur ? `Se connecter à ${nom}` : 'Configurer',
  };

  // Annoncé, pas encore branché (lot 11). Cet état-là ne se « résout » pas :
  // il n'y a rien à faire, et proposer une action serait mentir. C'est la
  // seule branche de ce module dont `action` vaut null — les écrans qui
  // affichent un bouton doivent donc le vérifier plutôt que le supposer.
  if (connector?.planned) {
    return build({
      code: 'planned',
      title: 'Bientôt disponible',
      detail: `${nom} est annoncé : sa connexion arrivera dans une prochaine version de crabe.`,
      tone: 'gray',
      action: null,
      canSync: false,
      canReconfigure: false,
      connected: false,
      followedLabel: null,
    });
  }

  // Pas encore installé : du point de vue de l'utilisateur, c'est exactement
  // « non connecté ». L'installation n'est pas une étape à lui faire franchir —
  // elle se fait toute seule au premier enregistrement, comme à l'ouverture
  // d'une connexion par navigateur.
  if (!connector?.installed) {
    return build({
      code: 'available',
      title: 'Non connecté',
      detail: `${nom} n'est pas encore configuré.`,
      tone: 'gray',
      action: seConnecter,
      canSync: false,
      canReconfigure: false,
      connected: false,
      followedLabel: null,
    });
  }

  if (connector.status === 'needs-config' || connector.status === 'pending') {
    return build({
      code: 'not-configured',
      title: 'Non connecté',
      detail: `${nom} n'est pas encore configuré.`,
      tone: 'amber',
      action: seConnecter,
      canSync: false,
      canReconfigure: true,
      connected: false,
      followedLabel: null,
    });
  }

  if (hasExpiredSession(summary)) {
    return build({
      code: 'session-expired',
      title: 'Connexion expirée',
      detail: `Votre connexion à ${nom} a expiré.`,
      tone: 'amber',
      action: {
        id: parNavigateur ? 'connect' : 'configure',
        label: 'Se reconnecter',
      },
      canSync: false,
      canReconfigure: true,
      connected: false,
      followedLabel: followedLabel(connector, summary),
    });
  }

  if (connector.status === 'error') {
    // Identifiants refusés : resynchroniser les referait refuser. Incident
    // passager (réseau, portail en panne, destination injoignable) : réessayer
    // est au contraire la bonne réponse.
    const identite = ECHEC_IDENTITE.test(String(connector.lastError || ''));
    return build({
      code: 'error',
      title: identite ? 'Connexion refusée' : 'Dernière récupération en échec',
      detail: identite
        ? `${nom} a refusé la connexion.`
        : `La dernière récupération de ${nom} n'a pas abouti.`,
      tone: 'red',
      action: identite
        ? { id: parNavigateur ? 'connect' : 'configure', label: 'Se reconnecter' }
        : { id: 'sync', label: 'Réessayer' },
      // Une seule règle : on ne propose « Synchroniser » que quand ça a une
      // chance d'aboutir.
      canSync: !identite,
      canReconfigure: true,
      connected: !identite,
      followedLabel: followedLabel(connector, summary),
    });
  }

  return build({
    code: 'ready',
    title: 'Connecté',
    detail: '',
    tone: 'green',
    action: { id: 'sync', label: 'Récupérer maintenant' },
    canSync: true,
    canReconfigure: true,
    connected: true,
    followedLabel: followedLabel(connector, summary),
  });
}

/** Garde-fou : un état inconnu ne doit jamais sortir d'ici. */
function build(state) {
  if (!CODES.includes(state.code)) throw new Error(`État de connecteur inconnu : ${state.code}`);
  return state;
}

/**
 * Résumé d'une ligne de l'accueil ou d'un écran d'erreur.
 *
 * Le message d'échec brut du fournisseur est utile à l'administrateur, pas à
 * l'utilisateur : on garde la phrase de `detail`, et le brut reste dans les
 * journaux.
 */
function summarize(connector) {
  const state = evaluate(connector);
  return {
    code: state.code,
    title: state.title,
    detail: state.detail,
    tone: state.tone,
    action: state.action,
    canSync: state.canSync,
    canReconfigure: state.canReconfigure,
    connected: state.connected,
    followedLabel: state.followedLabel,
  };
}

module.exports = {
  CODES,
  ECHEC_IDENTITE,
  hasExpiredSession,
  followed,
  followedLabel,
  evaluate,
  summarize,
};
