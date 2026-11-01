'use strict';

/**
 * La reconnexion automatique (0.2.14, lot l21).
 *
 * Choix du compte observé, le 01/11/2026 : une session trouvée expirée se rouvre seule
 * avec les identifiants du service — ceux de sa fiche, ou de l'entrée du
 * carnet qu'elle suit —, sur les sites à simple identifiant et mot de passe.
 *
 * Ce qu'elle fait : un Chromium headless, lancé comme une récupération
 * (`identity.optionsLancement`), ouvre la page de connexion de la fenêtre
 * (`remoteLogin.url`), y écrit l'identifiant et le mot de passe — en une ou
 * deux pages —, valide par Entrée, puis la session obtenue est jugée par le
 * contrôle de la fenêtre (`controle-session.rejouer`). Confirmée, elle est
 * enregistrée comme une connexion (`saveConfig`, origine « reconnexion »).
 *
 * Ce qu'elle ne fait JAMAIS :
 *
 *   - passer un captcha, un mur anti-robot ou un code reçu : elle s'arrête
 *     net (`impossible`), et n'essaie plus ce service avant une connexion
 *     faite à la main ;
 *   - insister : un essai par service et par 24 h, réussi ou non — un site
 *     qui voit trois connexions ratées de suite peut bloquer le compte ;
 *   - écrire un identifiant ou un mot de passe ailleurs que dans le
 *     formulaire du site : ni journal, ni table, ni message (un message
 *     d'erreur de Playwright peut citer la valeur d'un champ — il ne remonte
 *     jamais) ;
 *   - toucher aux services exclus de la visite d'entretien pour la même
 *     raison (rejeu unique, session dans l'onglet, profil persistant).
 *
 * Deux déclencheurs : une récupération qui trouve la session expirée (le
 * planificateur réessaie alors la récupération une fois), et la visite
 * d'entretien qui la trouve morte. Active par défaut, désactivable en tout
 * (Administration › Automatisation) et service par service. Les essais vivent
 * dans `reconnexions_auto` (migration 73), hors de `run_logs`.
 */

const db = require('./db/db');
const applog = require('./applog');
const settings = require('./settings');
const horloge = require('./horloge');
const registry = require('./connectors/registry');
const sessionState = require('./connectors/session-state');
const controleSession = require('./connectors/controle-session');
const identity = require('./connectors/browser-identity');
const detection = require('./connectors/login-detection');
const obstructions = require('./connectors/obstructions');
const vueDePage = require('./connectors/vue-de-page');
const causeEchec = require('./connectors/cause-echec');

/** Un essai par service et par 24 h. */
const INTERVALLE_MS = 24 * 3_600_000;

/** Patience d'une page (chargement, envoi du formulaire). */
const PATIENCE_MS = 20_000;

/** Le temps que les cookies tardifs s'écrivent (voir login-detection.js). */
const COOKIES_TARDIFS_MS = 2500;

/** Les points remplaçables par les essais. */
const ouverture = {
  requirePlaywright: () => require('playwright'),
  lancement: () => identity.optionsLancement(),
};

// ---------------------------------------------------------------------------
// Qui peut être reconnecté, et quand
// ---------------------------------------------------------------------------

/**
 * Ce service peut-il se reconnecter seul ? Pure : lit le manifeste.
 * @returns {{ok: true, champ: string}|{ok: false, raison: string}}
 */
function eligibilite(connectorId, manifest) {
  const champ = (manifest?.fields || []).find((f) => f.type === 'session');
  const rl = manifest?.remoteLogin;
  if (!champ || !rl) return { ok: false, raison: 'pas de connexion par la fenêtre' };
  if (manifest.unfeasible) return { ok: false, raison: 'service non faisable' };
  if (!rl.url) return { ok: false, raison: 'aucune page de connexion déclarée' };
  if (!rl.verifyUrl) return { ok: false, raison: 'aucune page de compte pour vérifier la connexion' };
  if (rl.rejeuUnique) return { ok: false, raison: 'un rejeu y a déjà coûté la session' };
  if (rl.stockageDeSession) return { ok: false, raison: 'sa session vit aussi dans l\'onglet' };
  if (rl.persistent) return { ok: false, raison: 'sa connexion vit dans un profil de navigateur' };
  if (require('./connectors/instances').baseDe(connectorId) === 'totalenergies') return { ok: false, raison: 'il pose sa propre garde réseau' };
  if (!detection.champsIdentifiants(manifest)) return { ok: false, raison: 'pas de place pour des identifiants' };
  return { ok: true, champ: champ.key };
}

/** Les identifiants d'un service (fiche, ou carnet suivi), ou null. Jamais journalisés. */
function identifiantsDe(userId, connectorId, manifest) {
  const champs = detection.champsIdentifiants(manifest);
  if (!champs) return null;
  let config = null;
  try {
    config = registry.readConfig(userId, connectorId);
  } catch {
    return null; // entrée du carnet illisible : on ne tape rien de faux
  }
  const motDePasse = String(config?.[champs.cleMotDePasse] ?? '');
  const identifiant = champs.cleIdentifiant ? String(config?.[champs.cleIdentifiant] ?? '').trim() : '';
  if (!motDePasse || !identifiant || /[\r\n]/.test(identifiant)) return null;
  return { identifiant, motDePasse };
}

function versSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function depuisSql(texte) {
  return texte ? new Date(`${String(texte).replace(' ', 'T')}Z`) : null;
}

function dernierEssai(userId, connectorId) {
  return db.get().prepare(
    `SELECT at, issue, code, raison FROM reconnexions_auto
      WHERE user_id = ? AND connector_id = ? ORDER BY at DESC, id DESC LIMIT 1`
  ).get(userId, connectorId) || null;
}

/**
 * Pourquoi ce service ne se reconnecte PAS maintenant (null : il peut).
 * Ne lance rien.
 */
function pasMaintenant(userId, connectorId, maintenant = horloge.maintenant()) {
  if (!settings.reconnexionAuto()) return 'reconnexion automatique arrêtée pour tous les services';
  let manifest = null;
  try {
    manifest = registry.manifest(connectorId);
  } catch {
    return 'service inconnu';
  }
  const e = eligibilite(connectorId, manifest);
  if (!e.ok) return e.raison;
  const install = db.get().prepare(
    'SELECT reconnexion_off, disabled_at FROM connector_installs WHERE user_id = ? AND connector_id = ?'
  ).get(userId, connectorId);
  if (!install) return 'service non installé';
  if (install.disabled_at) return 'service en pause';
  if (install.reconnexion_off) return 'reconnexion automatique désactivée pour ce service';
  if (!identifiantsDe(userId, connectorId, manifest)) return 'aucun identifiant ni mot de passe enregistré';
  const dernier = dernierEssai(userId, connectorId);
  if (dernier) {
    if (dernier.issue === 'impossible' && !causeEchec.connexionApres(userId, connectorId, dernier.at)) {
      return `le site a demandé ${dernier.raison || 'une vérification'} : plus d'essai avant une connexion faite à la main`;
    }
    if (maintenant.getTime() - depuisSql(dernier.at).getTime() < INTERVALLE_MS) {
      return 'déjà essayée dans les dernières 24 h';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// L'essai
// ---------------------------------------------------------------------------

/** Ce qui arrête net : un captcha, un mur, un code. Lu par vue-de-page. */
async function obstacleDe(page) {
  const lu = await page.evaluate(vueDePage.lireLaPage).catch(() => null);
  for (const o of lu?.obstacles || []) {
    if (/^captcha|robot/i.test(o)) return { code: 'captcha', raison: 'un captcha' };
    if (/anti-robot/i.test(o)) return { code: 'mur', raison: 'une vérification anti-robot' };
    if (/demande de code/i.test(o)) return { code: 'code', raison: 'un code de validation' };
  }
  return null;
}

/** Le premier champ VISIBLE qui répond à l'un des sélecteurs, ou null. */
async function champVisible(page, selecteurs) {
  for (const selecteur of selecteurs) {
    const champ = page.locator(selecteur).first();
    if (!(await champ.count().catch(() => 0))) continue;
    if (!(await champ.isVisible().catch(() => false))) continue;
    return champ;
  }
  return null;
}

async function patienter(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: PATIENCE_MS }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: PATIENCE_MS }).catch(() => {});
}

/**
 * Remplit et envoie le formulaire, en une ou deux pages. Rend ce qui s'est
 * passé, jamais une valeur.
 * @returns {Promise<{envoye: boolean, code?: string, raison?: string}>}
 */
async function remplirEtEnvoyer(page, identifiants, log) {
  let envoye = false;
  for (let etape = 1; etape <= 2; etape++) {
    const obstacle = await obstacleDe(page);
    if (obstacle) return { envoye, ...obstacle, impossible: true };
    await obstructions.fermer(page, { cible: 'input[type="password"], form, button', log, prefixe: '' })
      .catch(() => {});

    const motDePasse = await champVisible(page, [detection.SELECTEUR_MOT_DE_PASSE]);
    // Sans mot de passe à l'écran, seuls les champs qui se NOMMENT identifiant
    // comptent : le premier champ texte venu peut être une recherche.
    const identifiant = await champVisible(page, motDePasse
      ? detection.SELECTEURS_IDENTIFIANT
      : detection.SELECTEURS_IDENTIFIANT.filter((s) => s !== 'input[type="text"]'));
    if (!motDePasse && !identifiant) {
      return etape === 1
        ? { envoye, code: 'sans-formulaire', raison: 'aucun formulaire de connexion sur la page' }
        : { envoye };
    }
    try {
      // `fill` et non la frappe : le même geste que la fenêtre (0.2.11).
      if (identifiant && !(await identifiant.inputValue().catch(() => ''))) await identifiant.fill(identifiants.identifiant);
      if (motDePasse) await motDePasse.fill(identifiants.motDePasse);
      await (motDePasse || identifiant).press('Enter');
    } catch {
      // ⚠ Le message de Playwright peut citer la valeur d'un champ : jamais remonté.
      return { envoye, code: 'saisie', raison: 'le formulaire n\'a pas accepté la saisie' };
    }
    envoye = true;
    log(`identifiants envoyés (page ${etape}${motDePasse ? ', mot de passe compris' : ', identifiant seul'}).`);
    await patienter(page);
    if (motDePasse) break;
  }
  const obstacle = await obstacleDe(page);
  if (obstacle) return { envoye, ...obstacle, impossible: true };
  if (await champVisible(page, [detection.SELECTEUR_MOT_DE_PASSE])) {
    return { envoye, code: 'refus', raison: 'le formulaire de connexion est revenu (identifiants refusés ?)' };
  }
  return { envoye };
}

/** Écrit la ligne de l'essai. */
function noter(userId, connectorId, origine, r, dureeMs) {
  db.get().prepare(
    `INSERT INTO reconnexions_auto (user_id, connector_id, at, origine, issue, code, raison, duree_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, connectorId, versSql(horloge.maintenant()), origine, r.issue, r.code || null,
    r.raison ? String(r.raison).slice(0, 300) : null, dureeMs);
}

/**
 * Essaie de reconnecter un service. Ne lève jamais.
 *
 * @param {number} userId
 * @param {string} connectorId
 * @param {{origine?: 'recuperation'|'entretien', log?: Function}} [options]
 * @returns {Promise<{issue: 'reussie'|'echouee'|'impossible'|'non-tentee', code?: string, raison: string}>}
 */
async function tenter(userId, connectorId, { origine = 'recuperation', log = null } = {}) {
  const pourquoi = pasMaintenant(userId, connectorId);
  if (pourquoi) return { issue: 'non-tentee', raison: pourquoi };

  const manifest = registry.manifest(connectorId);
  const rl = manifest.remoteLogin;
  const { champ } = eligibilite(connectorId, manifest);
  const dire = (message) => {
    const ligne = `${manifest.name} : reconnexion automatique — ${message}`;
    if (log) log(ligne);
    else applog.info('reconnexion', ligne);
  };
  const debut = Date.now();
  let r;
  let navigateur = null;
  try {
    const identifiants = identifiantsDe(userId, connectorId, manifest);
    const brut = registry.readConfig(userId, connectorId)?.[champ];
    const ancien = sessionState.validate(brut);

    const playwright = ouverture.requirePlaywright();
    navigateur = await playwright.chromium.launch(ouverture.lancement());
    // L'ancien état accompagne la connexion : un site qui « se souvient de cet
    // appareil » ne redemande alors pas de code.
    const contexte = await navigateur.newContext(identity.optionsContexte(
      ancien?.ok ? { storageState: ancien.state } : {}
    ));
    const page = await contexte.newPage();
    page.setDefaultTimeout(PATIENCE_MS);
    const { exigerAdresseVisitable } = require('./remote-browser');
    exigerAdresseVisitable(rl.url, manifest.name);
    dire('ouverture de la page de connexion.');
    await page.goto(rl.url, { waitUntil: 'domcontentloaded' });
    await patienter(page);

    const envoi = await remplirEtEnvoyer(page, identifiants, dire);
    if (envoi.impossible) {
      r = { issue: 'impossible', code: envoi.code, raison: envoi.raison };
    } else if (envoi.code && envoi.code !== 'sans-formulaire') {
      r = { issue: 'echouee', code: envoi.code, raison: envoi.raison };
    } else {
      // Sans formulaire, le site nous a peut-être reconnus d'emblée : le
      // contrôle tranche. Sinon, le temps que les cookies tardifs s'écrivent.
      if (envoi.envoye) await page.waitForTimeout(COOKIES_TARDIFS_MS);
      const etat = await contexte.storageState();
      await navigateur.close().catch(() => {});
      navigateur = null;
      const verdict = await controleSession.rejouer({
        connectorId,
        connectorName: manifest.name,
        verifyUrl: rl.verifyUrl,
        verifyUrlTient: !!rl.verifyUrlTient,
        renvoiAnonyme: rl.renvoiAnonyme || '',
        domaineEspaceClient: rl.domaineEspaceClient || '',
      }, etat, {
        garderEtat: true,
        lancement: ouverture.lancement(),
        runtime: { requirePlaywright: ouverture.requirePlaywright, log: (niveau, message) => dire(message) },
      });
      if (verdict.verdict === 'confirmee' && verdict.etat) {
        const { state: trie } = sessionState.limiterAuxDomaines(verdict.etat, rl.keepDomains);
        registry.saveConfig(userId, connectorId, { [champ]: JSON.stringify(trie) }, { origine: 'reconnexion' });
        r = { issue: 'reussie', code: 'confirmee', raison: 'session rouverte et vérifiée' };
      } else if (verdict.code === 'mur') {
        r = { issue: 'impossible', code: 'mur', raison: 'une vérification anti-robot' };
      } else {
        r = {
          issue: 'echouee',
          code: envoi.code || verdict.code || 'non-confirmee',
          raison: envoi.code ? envoi.raison : `la connexion n'a pas pu être vérifiée (${verdict.raison || verdict.verdict})`,
        };
      }
    }
  } catch (err) {
    // Le détail technique, jamais un champ : la première ligne du message
    // suffit, et il est coupé.
    r = { issue: 'echouee', code: 'erreur', raison: `essai interrompu (${String(err?.message || err).split('\n')[0].slice(0, 160)})` };
  } finally {
    await navigateur?.close?.().catch(() => {});
  }
  const dureeMs = Date.now() - debut;
  try {
    noter(userId, connectorId, origine, r, dureeMs);
  } catch (err) {
    applog.warn('reconnexion', `${manifest.name} : essai non noté (${err.message}).`);
  }
  dire(`${LIBELLES[r.issue]}${r.raison ? ` (${r.raison})` : ''}, en ${Math.round(dureeMs / 1000)} s.`);
  return r;
}

const LIBELLES = {
  reussie: 'reconnecté',
  echouee: 'échec',
  impossible: 'arrêtée',
  'non-tentee': 'non tentée',
};

// ---------------------------------------------------------------------------
// Ce que l'administration affiche
// ---------------------------------------------------------------------------

/** Un service par la fenêtre et sa reconnexion : possible ou pas, et le dernier essai. */
function etat(maintenant = horloge.maintenant()) {
  const actif = settings.reconnexionAuto();
  const lignes = db.get().prepare(
    `SELECT ci.user_id, ci.connector_id, ci.reconnexion_off, u.username
       FROM connector_installs ci JOIN users u ON u.id = ci.user_id
      WHERE ci.config_encrypted IS NOT NULL AND ci.status != 'needs-config'
      ORDER BY u.username, ci.connector_id`
  ).all();
  const services = [];
  for (const l of lignes) {
    let manifest = null;
    try {
      manifest = registry.manifest(l.connector_id);
    } catch {
      continue;
    }
    if (!(manifest.fields || []).some((f) => f.type === 'session')) continue;
    const e = eligibilite(l.connector_id, manifest);
    const dernier = dernierEssai(l.user_id, l.connector_id);
    services.push({
      userId: l.user_id,
      compte: l.username,
      connectorId: l.connector_id,
      nom: manifest.name,
      possible: e.ok,
      active: !l.reconnexion_off,
      identifiants: e.ok ? !!identifiantsDe(l.user_id, l.connector_id, manifest) : false,
      pourquoi: pasMaintenant(l.user_id, l.connector_id, maintenant),
      dernier: dernier ? { at: dernier.at, issue: dernier.issue, libelle: LIBELLES[dernier.issue], code: dernier.code, raison: dernier.raison } : null,
    });
  }
  return { actif, services };
}

module.exports = {
  eligibilite,
  identifiantsDe,
  pasMaintenant,
  tenter,
  etat,
  ouverture,
  INTERVALLE_MS,
};
