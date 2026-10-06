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

const { SESSION_EXPIREE, CONNEXION_REFUSEE } = require('./cause-echec');

/**
 * Ce qui, dans le message d'un AUTRE échec, laisse penser que c'est le compte
 * qu'il faut reprendre plutôt que réessayer.
 *
 * ⚠ Depuis le lot 91, cette expression ne décide PLUS d'aucune cause, d'aucune
 * couleur ni d'aucun mot : la session expirée et la connexion refusée sont
 * calculées par connectors/cause-echec.js, à partir de l'historique. Elle ne
 * sert qu'à choisir le BOUTON d'un échec « autre » dont le connecteur n'a pas
 * marqué le refus (une clé d'API refusée, par exemple) : y proposer
 * « Réessayer » ramènerait au même refus.
 *
 * Volontairement large : se tromper dans ce sens propose « Se reconnecter » à
 * qui aurait pu s'en tirer avec un nouvel essai — désagrément mineur.
 */
const ECHEC_IDENTITE =
  /identifiant|mot de passe|authentifi|connexion refus|non connect|session|expir|invalide|incorrect|refus|401|403/i;

/** Les états, dans l'ordre de gravité décroissante pour l'affichage. */
const CODES = [
  'connexion-refusee', 'error', 'session-expired', 'not-configured', 'ready', 'available', 'planned',
];

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

  // ─── Les trois issues d'un échec (lot 91) ───────────────────────────────
  //
  // `connector.defaut` vient de connectors/cause-echec.js : la cause de la
  // dernière exécution si elle a échoué et qu'aucune connexion n'a été
  // enregistrée depuis. La couleur et les mots en découlent — jamais du rang
  // d'un échec dans une liste, jamais du texte de son message. Un même
  // vocabulaire partout : « session expirée », « connexion refusée ».
  const defaut = connector.defaut || null;
  const reconnexion = { id: parNavigateur ? 'connect' : 'configure', label: 'Se reconnecter' };

  if (defaut?.cause === CONNEXION_REFUSEE) {
    // Rouge : la récupération qui a suivi l'enregistrement de la connexion a
    // été renvoyée vers l'écran de connexion. Recommencer tout de suite n'y
    // changerait rien ; se reconnecter plus tard, si.
    return build({
      code: 'connexion-refusee',
      title: 'Connexion refusée',
      detail: `${nom} refuse la connexion qui vient d'être enregistrée : inutile de recommencer `
        + 'tout de suite, réessayez dans quelques heures.',
      tone: 'red',
      action: reconnexion,
      canSync: false,
      canReconfigure: true,
      connected: false,
      followedLabel: followedLabel(connector, summary),
    });
  }

  if (defaut?.cause === SESSION_EXPIREE || hasExpiredSession(summary)) {
    // Orange : la connexion a vécu, puis vieilli — ou son échéance est
    // passée. Le cas ordinaire : on se reconnecte, la récupération repart.
    return build({
      code: 'session-expired',
      title: 'Session expirée',
      detail: `Votre session sur ${nom} a expiré : reconnectez-vous, la récupération repartira `
        + 'toute seule.',
      tone: 'amber',
      action: reconnexion,
      canSync: false,
      canReconfigure: true,
      connected: false,
      followedLabel: followedLabel(connector, summary),
    });
  }

  if (defaut || connector.status === 'error') {
    // Un AUTRE échec — site muet, limite de durée, page illisible, arrêt de
    // crabe : réessayer est en général la bonne réponse. Seule exception, un
    // refus que le connecteur n'a pas marqué comme tel (voir ECHEC_IDENTITE) :
    // le bouton propose alors de reprendre le compte.
    const identite = ECHEC_IDENTITE.test(String(connector.lastError || ''));
    return build({
      code: 'error',
      title: 'Dernière récupération en échec',
      detail: `La dernière récupération de ${nom} n'a pas abouti.`,
      tone: 'red',
      action: identite ? reconnexion : { id: 'sync', label: 'Réessayer' },
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
