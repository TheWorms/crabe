'use strict';

/**
 * La visite d'entretien des sessions (0.2.8).
 *
 * Demande de l'utilisateur, le 01/11/2026 : neuf services ont dit « session expirée »
 * en une demi-heure, au passage mensuel (Bricomarché, Boulanger, Battle.net,
 * AutoDoc, Amazon, Alfaliquid, PrestaShop Addons, OUIGO, Hetzner) — des
 * connexions ouvertes des semaines plus tôt, que rien n'avait utilisées
 * depuis. « Le but, c'est que les sessions n'expirent pas, ou peu. »
 *
 * Chaque jour, pour chaque service connecté, crabe ouvre sa page de compte
 * (`remoteLogin.verifyUrl`) avec la session enregistrée, SANS RIEN
 * RÉCUPÉRER, et juge si elle vit :
 *
 *   - état capturé et rejoué : le jugement de la fenêtre de connexion
 *     (`connectors/controle-session.js`), le navigateur ouvert comme par une
 *     récupération ; une session vivante est enregistrée telle que le site
 *     l'a prolongée (`saveConfig`, origine « entretien » : ni connexion, ni
 *     réussite, l'état du service intact) ;
 *   - profil persistant : le profil rouvert par le socle de son connecteur
 *     (`profil-marchand`, `auth-sncf`), même verrou, même Chromium visible ;
 *     le site prolonge la session dans le profil lui-même.
 *
 * Décisions du compte observé (01/11/2026, 3 h 45) : une heure tirée par service entre
 * 9 h et 21 h — jamais toutes ensemble, jamais en pleine nuit ; aucune
 * notification quand la visite trouve une session expirée (l'avertissement
 * vient de la récupération, comme avant) ; active par défaut, désactivable en
 * tout (Administration › Automatisation) et service par service.
 *
 * Ce qu'elle ne fait PAS, mesuré :
 *
 *   - elle ne sauve pas une session que le site tue en quelques heures
 *     (Darty < 2 h, Bricomarché ~3 h, Coyote < 4 h 30, impots 30 min —
 *     docs/audit-sessions-lot110.md) : une visite par jour arrive trop tard.
 *     Elle le constate, et s'arrête (ci-dessous) ;
 *   - elle ne rejoue jamais impots (`rejeuUnique` : un rejeu y a déjà coûté
 *     la session), ni Alma (son état vit aussi dans le stockage de session de
 *     l'onglet), ni un connecteur sans page de compte déclarée, ni
 *     TotalEnergies (il pose sa propre garde réseau avant toute requête) ;
 *   - elle ne revient pas sur une session vue morte avant une nouvelle
 *     connexion, ni sur un service dont la dernière récupération a dit
 *     « session expirée » ; après deux murs anti-robot de suite, elle se tait
 *     une semaine : une visite automatique de plus chaque jour ne doit pas
 *     faire juger le compte.
 *
 * Les visites vivent dans `entretiens_session` (migration 71), HORS de
 * `run_logs` : une visite ne récupère rien, elle ne compte ni comme réussite
 * ni comme échec d'un service (`cause-echec`, `health`, l'accueil).
 */

const nodeCrypto = require('node:crypto');
const cron = require('node-cron');
const db = require('./db/db');
const applog = require('./applog');
const settings = require('./settings');
const tz = require('./timezone');
const horloge = require('./horloge');
const registry = require('./connectors/registry');
const sessionState = require('./connectors/session-state');
const controleSession = require('./connectors/controle-session');
const identity = require('./connectors/browser-identity');
const preuve = require('./connectors/preuve-connexion');
const profilPersistant = require('./connectors/profil-persistant');
const inflight = require('./connectors/inflight');
const causeEchec = require('./connectors/cause-echec');

/** La plage des visites, en minutes de l'heure locale : 9 h – 21 h. */
const DEBUT_MIN = 9 * 60;
const FIN_MIN = 21 * 60;

/** Deux murs de suite : une semaine sans visite. */
const MURS_AVANT_PAUSE = 2;
const PAUSE_APRES_MURS_MS = 7 * 86_400_000;

/** Le tour des visites dues : toutes les cinq minutes. */
const TOUR_CRON = '*/5 * * * *';

/**
 * Les connecteurs à profil persistant qui ouvrent leur profil par
 * `auth-sncf` ; les autres le font par `profil-marchand` (ils exportent
 * `estPageAuthentification`). Un essai tient cette liste à jour.
 */
const PROFIL_SNCF = new Set(['ouigo', 'sncf-connect']);

/** Exclus par construction : la raison est dite à l'écran. */
const EXCLUS = {
  totalenergies: 'il pose sa propre garde réseau avant toute requête : une visite la contournerait',
};

/** Les points remplaçables par les essais. */
const ouverture = {
  requirePlaywright: () => require('playwright'),
  socleProfil: (connectorId) => (PROFIL_SNCF.has(require('./connectors/instances').baseDe(connectorId))
    ? require('./connectors/auth-sncf')
    : require('./connectors/profil-marchand')),
};

// ---------------------------------------------------------------------------
// Qui est visité, et quand
// ---------------------------------------------------------------------------

/**
 * Ce service peut-il être visité ? Pure : lit le manifeste et le module.
 * @returns {{ok: true, mode: 'etat'|'profil', champ: string}|{ok: false, raison: string}}
 */
function eligibilite(idInstalle, manifest, connecteur = null) {
  // 0.2.15 : un autre compte suit les règles de son service.
  const connectorId = require('./connectors/instances').baseDe(idInstalle);
  const champ = (manifest?.fields || []).find((f) => f.type === 'session');
  const rl = manifest?.remoteLogin;
  if (!champ || !rl) return { ok: false, raison: 'pas de connexion enregistrée par la fenêtre' };
  if (EXCLUS[connectorId]) return { ok: false, raison: EXCLUS[connectorId] };
  if (manifest.unfeasible) return { ok: false, raison: 'service non faisable' };
  if (!rl.verifyUrl) return { ok: false, raison: 'aucune page de compte déclarée' };
  if (rl.rejeuUnique) return { ok: false, raison: 'un rejeu y a déjà coûté la session' };
  if (rl.stockageDeSession) return { ok: false, raison: 'sa session vit aussi dans l\'onglet, qu\'une visite ne rouvre pas' };
  if (rl.persistent) {
    const socle = PROFIL_SNCF.has(connectorId)
      || typeof connecteur?.estPageAuthentification === 'function';
    if (!socle) return { ok: false, raison: 'profil ouvert par un lanceur propre au connecteur' };
    return { ok: true, mode: 'profil', champ: champ.key };
  }
  return { ok: true, mode: 'etat', champ: champ.key };
}

/** L'heure de visite d'un couple, en minutes : stable, tirée dans 9 h – 21 h. */
function heureDuCouple(userId, connectorId) {
  const h = nodeCrypto.createHash('sha256').update(`${userId}:${connectorId}`).digest();
  return DEBUT_MIN + (h.readUInt32BE(0) % (FIN_MIN - DEBUT_MIN));
}

/** « 14 h 05 ». */
function heureLisible(minutes) {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** Le jour et la minute locaux (fuseau réglé) d'un instant. */
function ici(instant) {
  const p = tz.partsInZone(instant, settings.timezone());
  const jour = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { jour, minutes: p.hour * 60 + p.minute };
}

/** « 2026-11-01 08:00:00 » (UTC, comme la base) → Date. */
function depuisSql(texte) {
  return texte ? new Date(`${String(texte).replace(' ', 'T')}Z`) : null;
}

function dernieresVisites(userId, connectorId, n = MURS_AVANT_PAUSE) {
  return db.get().prepare(
    `SELECT at, verdict, code FROM entretiens_session
      WHERE user_id = ? AND connector_id = ? ORDER BY at DESC, id DESC LIMIT ?`
  ).all(userId, connectorId, n);
}

/**
 * Pourquoi ce couple n'est PAS dû maintenant (null : il l'est). Lit la base ;
 * ne lance rien.
 */
function pasMaintenant(userId, connectorId, maintenant = horloge.maintenant()) {
  const { jour, minutes } = ici(maintenant);
  const heure = heureDuCouple(userId, connectorId);
  const [derniere, avant] = dernieresVisites(userId, connectorId);
  if (derniere && ici(depuisSql(derniere.at)).jour === jour) return 'déjà visité aujourd\'hui';
  if (minutes < heure) return `prévu à ${heureLisible(heure)}`;
  if (derniere?.verdict === 'refusee' && !causeEchec.connexionApres(userId, connectorId, derniere.at)) {
    return 'session vue expirée : plus de visite avant une nouvelle connexion';
  }
  const defaut = causeEchec.defautActuel(userId, connectorId);
  if (defaut && (defaut.cause === 'session-expiree' || defaut.cause === 'connexion-refusee')) {
    return 'la dernière récupération a trouvé la session expirée : plus de visite avant une nouvelle connexion';
  }
  if (derniere?.code === 'mur' && avant?.code === 'mur'
    && maintenant.getTime() - depuisSql(derniere.at).getTime() < PAUSE_APRES_MURS_MS) {
    return 'deux murs anti-robot de suite : une semaine sans visite';
  }
  return null;
}

/**
 * Les services qui PEUVENT être visités (réglages, état, manifeste), avec ce
 * qu'il faut pour les visiter. Les visites dues sont filtrées ensuite.
 */
function candidats() {
  if (!settings.entretienSessions()) return [];
  const lignes = db.get().prepare(
    `SELECT ci.user_id, ci.connector_id
       FROM connector_installs ci JOIN users u ON u.id = ci.user_id
      WHERE u.status = 'active' AND ci.status != 'needs-config'
        AND ci.config_encrypted IS NOT NULL
        AND ci.disabled_at IS NULL AND ci.entretien_off = 0
      ORDER BY ci.user_id, ci.connector_id`
  ).all();
  const sortie = [];
  for (const l of lignes) {
    let manifest = null;
    let connecteur = null;
    try {
      manifest = registry.manifest(l.connector_id);
      connecteur = registry.get(l.connector_id)?.module || null;
    } catch {
      continue; // connecteur retiré : rien à visiter
    }
    const e = eligibilite(l.connector_id, manifest, connecteur);
    if (e.ok) sortie.push({ userId: l.user_id, connectorId: l.connector_id, manifest, ...e });
  }
  return sortie;
}

// ---------------------------------------------------------------------------
// La visite
// ---------------------------------------------------------------------------

/** Ce que les cookies annoncent, jamais une valeur. */
function releveCookies(cookies) {
  const liste = Array.isArray(cookies) ? cookies : [];
  const dates = liste.map((c) => Number(c.expires)).filter((e) => Number.isFinite(e) && e > 0);
  return {
    cookies: liste.length,
    cookiesSansDate: liste.length - dates.length,
    expireAuPlusTard: dates.length ? new Date(Math.max(...dates) * 1000).toISOString() : null,
  };
}

/** Une session capturée, rejouée comme par une récupération, jugée par la fenêtre. */
async function visiterEtat(c, log) {
  const brut = registry.readConfig(c.userId, c.connectorId)?.[c.champ];
  const valide = sessionState.validate(brut);
  if (!valide?.ok) {
    return { verdict: 'refusee', code: 'session-absente', raison: valide?.error || 'aucune session lisible enregistrée' };
  }
  const { state } = valide;
  const rl = c.manifest.remoteLogin;
  const session = {
    connectorId: c.connectorId,
    connectorName: c.manifest.name,
    verifyUrl: rl.verifyUrl,
    verifyUrlTient: !!rl.verifyUrlTient,
    renvoiAnonyme: rl.renvoiAnonyme || '',
    domaineEspaceClient: rl.domaineEspaceClient || '',
  };
  const resultat = await controleSession.rejouer(session, state, {
    garderEtat: true,
    lancement: identity.optionsLancement(),
    runtime: {
      requirePlaywright: ouverture.requirePlaywright,
      log: (niveau, message) => log(niveau, message),
    },
  });
  const { etat, ...verdict } = resultat;
  if (verdict.verdict !== 'confirmee' || !etat) return { ...verdict, ...releveCookies(state.cookies) };

  // La connexion a-t-elle changé pendant la visite (fenêtre, récupération) ?
  // Alors l'état prolongé est plus VIEUX que celui enregistré : on n'écrit pas.
  const maintenant = registry.readConfig(c.userId, c.connectorId)?.[c.champ];
  if (maintenant !== brut) {
    return { ...verdict, code: 'remplacee', prolongee: false, ...releveCookies(etat.cookies) };
  }
  const { state: trie } = sessionState.limiterAuxDomaines(etat, rl.keepDomains);
  try {
    registry.saveConfig(c.userId, c.connectorId, { [c.champ]: JSON.stringify(trie) }, { origine: 'entretien' });
  } catch (err) {
    // Plus aucun cookie valable, ou configuration illisible : la session n'est
    // pas réécrite, la visite le dit.
    return { ...verdict, code: 'non-enregistree', prolongee: false, raison: err.message, ...releveCookies(trie.cookies) };
  }
  return { ...verdict, prolongee: true, ...releveCookies(trie.cookies) };
}

/** Un profil persistant, rouvert par le socle de son connecteur. */
async function visiterProfil(c, log, connecteur) {
  if (!profilPersistant.existe(c.userId, c.connectorId)) {
    return { verdict: 'refusee', code: 'profil-absent', raison: 'aucun profil de navigateur sur ce serveur' };
  }
  const rl = c.manifest.remoteLogin;
  const socle = ouverture.socleProfil(c.connectorId);
  try {
    return await socle.surLeProfil({
      id: c.connectorId,
      nom: c.manifest.name,
      ctx: { userId: c.userId, log: (m) => log('info', m) },
      urlDepart: rl.verifyUrl,
      ...(typeof connecteur?.estPageAuthentification === 'function'
        ? { estAuthentification: connecteur.estPageAuthentification }
        : {}),
    }, async (page, contexte) => {
      const cookies = releveCookies(await contexte.cookies().catch(() => []));
      const url = String(page.url() || '');
      if (rl.verifyUrlTient && rl.renvoiAnonyme !== 'connexion' && !preuve.adresseTenue(url, rl.verifyUrl)) {
        return { verdict: 'refusee', code: 'renvoi', raison: 'la page de compte a renvoyé ailleurs, comme pour un visiteur sans session', ...cookies };
      }
      const lu = await preuve.verifier(page, { cookies: cookies.cookies }).catch(() => null);
      if (lu?.surFormulaire) {
        return { verdict: 'refusee', code: 'refus', raison: 'la page de compte montre un formulaire de connexion', ...cookies };
      }
      return { verdict: 'confirmee', code: 'page-servie', prolongee: true, ...cookies };
    });
  } catch (err) {
    if (err?.sessionExpired) return { verdict: 'refusee', code: 'refus', raison: 'le site a renvoyé vers sa page de connexion' };
    if (/vérification de sécurité/.test(String(err?.message))) {
      return { verdict: 'non-concluante', code: 'mur', raison: 'le site a présenté sa vérification de sécurité' };
    }
    if (inflight.profil.busy(inflight.profilKey(c.userId, c.connectorId))) {
      return { verdict: 'non-concluante', code: 'occupe', raison: 'le profil était ouvert par la fenêtre ou une récupération' };
    }
    throw err;
  }
}

/** Visite UN service, écrit sa ligne, la rend. */
async function visiter(c) {
  const debut = Date.now();
  const log = (niveau, message) => applog[niveau === 'warn' ? 'warn' : 'info']('entretien', `${c.manifest.name} : ${message}`);
  let r;
  try {
    const connecteur = registry.get(c.connectorId)?.module || null;
    r = c.mode === 'profil' ? await visiterProfil(c, log, connecteur) : await visiterEtat(c, log);
  } catch (err) {
    r = { verdict: 'erreur', code: 'erreur', raison: String(err?.message || err).slice(0, 300) };
  }
  // 0.2.14 : une session trouvée morte se rouvre seule quand le service s'y
  // prête (reconnexion-auto.js) — la visite le dit dans sa raison.
  if (r.verdict === 'refusee' && c.mode === 'etat') {
    const essai = await require('./reconnexion-auto').tenter(c.userId, c.connectorId, {
      origine: 'entretien',
      log: (ligne) => applog.info('entretien', ligne),
    }).catch(() => null);
    if (essai && essai.issue !== 'non-tentee') {
      r = { ...r, raison: `${r.raison ? `${r.raison} ; ` : ''}reconnexion automatique : ${essai.issue === 'reussie' ? 'session rouverte' : essai.raison}` };
    }
  }
  const ligne = {
    verdict: r.verdict,
    code: r.code || null,
    raison: r.raison ? String(r.raison).slice(0, 500) : null,
    prolongee: r.prolongee ? 1 : 0,
    duree_ms: Date.now() - debut,
    cookies: r.cookies ?? null,
    cookies_sans_date: r.cookiesSansDate ?? null,
    expire_au_plus_tard: r.expireAuPlusTard || null,
  };
  db.get().prepare(
    `INSERT INTO entretiens_session (user_id, connector_id, at, verdict, code, raison, prolongee, duree_ms,
                                     cookies, cookies_sans_date, expire_au_plus_tard)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(c.userId, c.connectorId, horloge.maintenant().toISOString().slice(0, 19).replace('T', ' '), ligne.verdict, ligne.code, ligne.raison,
    ligne.prolongee, ligne.duree_ms, ligne.cookies, ligne.cookies_sans_date, ligne.expire_au_plus_tard);
  applog.info('entretien', `${c.manifest.name} : visite d'entretien — ${LIBELLES[ligne.verdict] || ligne.verdict}`
    + `${ligne.prolongee ? ', session prolongée' : ''}${ligne.raison ? ` (${ligne.raison})` : ''}.`);
  return ligne;
}

const LIBELLES = {
  confirmee: 'session vivante',
  refusee: 'session expirée',
  'non-concluante': 'rien de sûr',
  'sans-controle': 'pas de contrôle possible',
  erreur: 'visite interrompue',
};

// ---------------------------------------------------------------------------
// Le tour
// ---------------------------------------------------------------------------

/** crabe est-il libre ? Une visite ne passe jamais devant une récupération. */
function occupe(c) {
  const scheduler = require('./scheduler');
  if (scheduler.enAttente > 0 || scheduler.runningPairs().length) return true;
  const fenetre = require('./remote-browser').manager().status(c.userId, c.connectorId);
  return fenetre?.state === 'running' || fenetre?.state === 'starting';
}

let enCours = false;

/** Visite, une à une, ce qui est dû. Ne lève jamais. */
async function tour(maintenant = horloge.maintenant()) {
  if (enCours) return [];
  enCours = true;
  const faites = [];
  try {
    for (const c of candidats()) {
      if (pasMaintenant(c.userId, c.connectorId, maintenant)) continue;
      if (occupe(c)) break; // le tour suivant reprendra là
      faites.push({ ...c, ligne: await visiter(c) });
    }
  } catch (err) {
    applog.warn('entretien', `Le tour des visites d'entretien s'est interrompu : ${err.message}`);
  } finally {
    enCours = false;
  }
  return faites;
}

let tache = null;

function demarrer() {
  if (tache) return;
  tache = cron.schedule(TOUR_CRON, () => { tour().catch(() => {}); }, { timezone: settings.timezone() });
}

function arreter() {
  tache?.stop?.();
  tache = null;
}

// ---------------------------------------------------------------------------
// Ce que l'administration affiche
// ---------------------------------------------------------------------------

/**
 * Un service connecté et sa visite : l'heure, la dernière visite, et pourquoi
 * il n'est pas visité quand il ne l'est pas.
 */
function etat(maintenant = horloge.maintenant()) {
  const actif = settings.entretienSessions();
  const lignes = db.get().prepare(
    `SELECT ci.user_id, ci.connector_id, ci.disabled_at, ci.entretien_off, u.username
       FROM connector_installs ci JOIN users u ON u.id = ci.user_id
      WHERE ci.config_encrypted IS NOT NULL AND ci.status != 'needs-config'
      ORDER BY u.username, ci.connector_id`
  ).all();
  const sortie = [];
  for (const l of lignes) {
    let manifest = null;
    let connecteur = null;
    try {
      manifest = registry.manifest(l.connector_id);
      connecteur = registry.get(l.connector_id)?.module || null;
    } catch {
      continue;
    }
    if (!(manifest.fields || []).some((f) => f.type === 'session')) continue;
    const e = eligibilite(l.connector_id, manifest, connecteur);
    const [derniere] = db.get().prepare(
      `SELECT at, verdict, code, raison, prolongee, cookies, cookies_sans_date, expire_au_plus_tard
         FROM entretiens_session WHERE user_id = ? AND connector_id = ? ORDER BY at DESC, id DESC LIMIT 1`
    ).all(l.user_id, l.connector_id);
    let pourquoi = null;
    if (!actif) pourquoi = 'visite d\'entretien arrêtée pour tous les services';
    else if (!e.ok) pourquoi = e.raison;
    else if (l.disabled_at) pourquoi = 'service en pause';
    else if (l.entretien_off) pourquoi = 'visite désactivée pour ce service';
    else pourquoi = pasMaintenant(l.user_id, l.connector_id, maintenant);
    sortie.push({
      userId: l.user_id,
      compte: l.username,
      connectorId: l.connector_id,
      nom: manifest.name,
      visitable: e.ok,
      active: !l.entretien_off,
      heure: heureLisible(heureDuCouple(l.user_id, l.connector_id)),
      pourquoi,
      derniere: derniere ? {
        at: derniere.at,
        verdict: derniere.verdict,
        libelle: LIBELLES[derniere.verdict] || derniere.verdict,
        code: derniere.code,
        raison: derniere.raison,
        prolongee: !!derniere.prolongee,
        cookies: derniere.cookies,
        cookiesSansDate: derniere.cookies_sans_date,
        expireAuPlusTard: derniere.expire_au_plus_tard,
      } : null,
    });
  }
  return { actif, services: sortie };
}

module.exports = {
  eligibilite,
  heureDuCouple,
  heureLisible,
  pasMaintenant,
  candidats,
  releveCookies,
  visiter,
  tour,
  demarrer,
  arreter,
  etat,
  ouverture,
  PROFIL_SNCF,
  DEBUT_MIN,
  FIN_MIN,
};
