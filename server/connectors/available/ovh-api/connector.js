'use strict';

/**
 * Implémentation partagée « ovh-api » — l'API officielle du groupe OVHcloud.
 *
 * ⚠ Ce dossier porte du CODE, pas un service : **pas de `manifest.json`** ici.
 * Il ne s'affiche nulle part et rien ne s'y installe. Les connecteurs qui
 * l'utilisent déclarent `"implementation": "ovh-api"` dans leur propre
 * manifeste, et c'est le registre qui les rapproche au chargement
 * (voir connectors/registry.js, SHARED_IMPLEMENTATIONS).
 *
 * Quatre marques, un seul moteur : OVHcloud, SoYouStart, Kimsufi partagent le
 * même serveur d'API, la même signature et la même route `/me/bill`. Seule
 * l'adresse de base change — c'est ce que confirment les SDK officiels
 * `python-ovh` et `node-ovh`, qui listent ces endpoints côte à côte.
 *
 * Documentation : https://api.ovh.com/  (endpoint /me/bill)
 *
 * Authentification : signature applicative OVH.
 *   X-Ovh-Signature = "$1$" + sha1(AS + "+" + CK + "+" + METHOD + "+" + URL
 *                                  + "+" + BODY + "+" + TIMESTAMP)
 *
 * Le décalage d'horloge est corrigé une fois par exécution via /auth/time,
 * sans quoi l'API rejette les requêtes avec « Invalid signature ».
 */

const { createHash } = require('node:crypto');
const history = require('../../history');

const ENDPOINTS = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
  'soyoustart-eu': 'https://eu.api.soyoustart.com/1.0',
  'soyoustart-ca': 'https://ca.api.soyoustart.com/1.0',
  'kimsufi-eu': 'https://eu.api.kimsufi.com/1.0',
  'kimsufi-ca': 'https://ca.api.kimsufi.com/1.0',
};

const REQUEST_TIMEOUT_MS = 30_000;

/** Clé du champ de profondeur d'historique, commune à tous les manifestes. */
const CHAMP_HISTORIQUE = 'historique';

/**
 * Ce que le code partagé doit savoir de SON appelant.
 *
 * Trois choses en dépendent, et se tromper sur l'une d'elles ne casse rien
 * visiblement — c'est bien le danger :
 *
 *   - l'adresse de base, sinon on interroge OVH avec des clés SoYouStart ;
 *   - le nom affiché, sinon un utilisateur SoYouStart lit « Identifiants OVH
 *     refusés » et cherche un compte qu'il n'a pas ;
 *   - le préfixe des fichiers, sinon les factures SoYouStart se rangent sous
 *     un nom OVH et deviennent introuvables.
 *
 * `connectorId` et `manifest` viennent de `makeContext()` (registry.js). Le
 * repli sur OVH garde le connecteur historique intact si le contexte manque —
 * un appel direct depuis un test, par exemple.
 */
function marque(config, ctx = {}) {
  const connectorId = ctx.connectorId || 'ovh';
  const nom = ctx.manifest?.name || 'OVH';

  // Sans région choisie, on vise l'Europe de la MÊME marque : retomber sur
  // « ovh-eu » enverrait des clés SoYouStart au serveur d'OVHcloud, qui les
  // refuserait avec un message incompréhensible pour l'utilisateur.
  const defaut = ENDPOINTS[`${connectorId}-eu`] ? `${connectorId}-eu` : 'ovh-eu';
  const cle = config?.endpoint || defaut;
  const base = ENDPOINTS[cle];
  if (!base) throw new Error(`Région ${nom} inconnue : ${config.endpoint}`);

  return {
    base,
    nom,
    // Le nom de dossier d'un connecteur est déjà sobre ; on le vérifie quand
    // même, parce qu'il finit dans un nom de fichier déposé sur un stockage.
    prefixe: connectorId.replace(/[^a-z0-9-]/gi, '_'),
  };
}

function sign(applicationSecret, consumerKey, method, url, body, timestamp) {
  const payload = [applicationSecret, consumerKey, method, url, body, timestamp].join('+');
  return `$1$${createHash('sha1').update(payload).digest('hex')}`;
}

async function withTimeout(promiseFactory, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Décalage entre l'horloge locale et celle du serveur d'API, en secondes. */
async function serverTimeDelta(cible) {
  const url = `${cible.base}/auth/time`;
  const res = await withTimeout((signal) => fetch(url, { signal }));
  if (!res.ok) {
    throw new Error(`${cible.nom} injoignable (/auth/time a répondu ${res.status})`);
  }
  const remote = Number(await res.text());
  if (!Number.isFinite(remote)) throw new Error('Réponse /auth/time illisible');
  return remote - Math.floor(Date.now() / 1000);
}

/**
 * Appel signé de l'API.
 * @param {object} config identifiants du connecteur
 * @param {{base: string, nom: string}} cible marque et adresse de base résolues
 * @param {string} method
 * @param {string} route ex. '/me/bill'
 * @param {number} delta décalage d'horloge
 */
async function apiRequest(config, cible, method, route, delta, query = null) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `${cible.base}${route}${search}`;
  const timestamp = String(Math.floor(Date.now() / 1000) + delta);
  const body = '';

  const res = await withTimeout((signal) =>
    fetch(url, {
      method,
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Ovh-Application': config.applicationKey,
        'X-Ovh-Consumer': config.consumerKey,
        'X-Ovh-Timestamp': timestamp,
        'X-Ovh-Signature': sign(
          config.applicationSecret,
          config.consumerKey,
          method,
          url,
          body,
          timestamp
        ),
      },
    })
  );

  if (res.status === 401 || res.status === 403) {
    let detail = '';
    try {
      detail = (await res.json())?.message || '';
    } catch {
      /* réponse non JSON */
    }
    throw new Error(
      `Identifiants ${cible.nom} refusés (${res.status})${detail ? ` — ${detail}` : ''}. ` +
        'Vérifiez la Consumer Key et son droit GET /me/bill*.'
    );
  }
  if (!res.ok) {
    throw new Error(`${cible.nom} a répondu ${res.status} sur ${route}`);
  }
  return res.json();
}

function requireCredentials(config, cible) {
  for (const key of ['applicationKey', 'applicationSecret', 'consumerKey']) {
    if (!config?.[key]) throw new Error(`Identifiant ${cible.nom} manquant : ${key}`);
  }
}

/**
 * Les paramètres de fenêtre à envoyer à `/me/bill`, selon le réglage du compte.
 *
 * ⚠ Le piège que cette fonction remplace, et qui a tenu jusqu'au lot 17 : la
 * fenêtre est envoyée **à l'API**, elle n'est pas un filtre appliqué après
 * coup. Une borne à douze mois ne « masque » donc pas les factures plus
 * anciennes : OVH ne les liste jamais, et aucun réglage de crabe n'y pouvait
 * quoi que ce soit. Un compte de 67 factures ouvert en 2021 n'en remontait que
 * la dernière année, silencieusement.
 *
 * Pas de borne basse = **aucun `date.from` envoyé**. C'est volontaire :
 * `/me/bill` sans paramètre rend la totalité de l'historique, ce qu'attendent
 * « toutes les années disponibles » et le premier passage du mode « depuis ».
 * Envoyer une date très ancienne à la place marcherait aussi, mais il faudrait
 * en choisir une — et toute date choisie est un plafond de plus, qui finirait
 * par se voir.
 *
 * `date.to` reste toujours envoyé : il borne la réponse à aujourd'hui, sans
 * dépendre de l'horloge du serveur d'OVH.
 */
function fenetreApi(config, ctx) {
  const plan = history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation (lot 24). C'est ce connecteur-ci qui a payé
    // l'addition : le 12/08/2026 il a listé et téléchargé 65 factures OVH
    // depuis 2020, dont 63 ont été effacées — index et fichiers — par
    // l'entretien de 02:15, parce que la conservation était réglée sur un an.
    // Une fenêtre plafonnée aurait demandé 9 factures et les aurait gardées.
    plafondMois: ctx?.conservationMois || 0,
  });

  const params = { 'date.to': plan.to.toISOString() };
  if (plan.from) params['date.from'] = plan.from.toISOString();
  return { params, plan };
}

/**
 * Vérification d'authentification légère : liste les identifiants de factures
 * mais ne télécharge aucun PDF.
 */
async function test(config, ctx = {}) {
  const cible = marque(config, ctx);
  requireCredentials(config, cible);
  const delta = await serverTimeDelta(cible);

  // /me valide la Consumer Key ; /me/bill valide le droit sur les factures.
  const me = await apiRequest(config, cible, 'GET', '/me', delta);

  // Le test ne reçoit pas `dejaRecupere` : le mode « depuis » y vaut donc
  // « tout l'historique », et c'est exactement ce qu'il faut annoncer. Le
  // nombre affiché ici est ce que la première récupération ira chercher.
  const { params } = fenetreApi(config, ctx);
  const bills = await apiRequest(config, cible, 'GET', '/me/bill', delta, params);

  return {
    ok: true,
    invoiceCount: bills.length,
    // Le nichandle est l'identifiant de compte : il devient le dossier de
    // destination (voir server/connectors/account-id.js).
    accountId: me.nichandle || me.email || null,
    message:
      `Connexion réussie — ${identiteLisible(me, cible)} · `
      + `${bills.length} facture(s) trouvée(s)${fenetreDite(config, ctx)}`,
  };
}

/**
 * Qui est ce compte, en clair — pour que « ce n'est pas le bon » se vérifie.
 *
 * ─── Ce que ça corrige (lot 26) ──────────────────────────────────────────────
 *
 * Signalé sur OVHcloud : « le compte affiché par crabe n'est pas le bon ».
 * crabe n'affichait qu'un nichandle — `ab1234-ovh` —, et un nichandle ne se
 * reconnaît pas : il ne dit ni le nom, ni l'adresse, ni la marque atteinte.
 * Impossible, devant lui, de savoir si les clés d'API saisies désignent le
 * compte qu'on croit, ou un autre compte du même groupe.
 *
 * Trois marques partagent ce moteur — OVHcloud, SoYouStart, Kimsufi —, un même
 * client y a souvent plusieurs comptes, et une clé créée sur la mauvaise
 * console répond parfaitement… en parlant d'un autre compte. La phrase nomme
 * donc les quatre choses qui permettent de trancher : l'identifiant, la
 * personne ou la société, l'adresse électronique, et la marque réellement
 * jointe.
 */
function identiteLisible(me, cible) {
  const nichandle = me?.nichandle || null;
  const qui = [me?.organisation, [me?.firstname, me?.name].filter(Boolean).join(' ')]
    .map((v) => String(v || '').trim())
    .filter(Boolean)[0] || null;

  const precisions = [qui, me?.email].filter(Boolean).join(', ');
  const identifiant = nichandle || me?.email || 'identifiant inconnu';

  return `compte ${identifiant}${precisions ? ` (${precisions})` : ''} chez ${cible.nom}`;
}

/**
 * « , tout l'historique » ou « , depuis janvier 2025 » — jamais un compte nu.
 *
 * Un nombre de factures sans la fenêtre qui l'a produit ne veut rien dire, et
 * c'est ce qui a fait croire à un mauvais compte : 2 factures affichées pour un
 * compte qui en porte 67, sans un mot sur la borne qui expliquait l'écart.
 */
function fenetreDite(config, ctx) {
  try {
    const { plan } = fenetreApi(config, ctx);
    if (!plan?.from) return ' sur tout l\'historique';
    return ` sur la période demandée (depuis ${plan.from.toISOString().slice(0, 10)})`;
  } catch {
    return '';
  }
}

/**
 * Liste et télécharge les factures.
 *
 * Renvoie la forme détaillée `{ accountId, invoices }` : le nichandle sert de
 * dossier de destination, ce qui garde séparés deux comptes distincts.
 *
 * @returns {Promise<{accountId: string|null, invoices: Array<{remoteId, filename, issuedOn, buffer, amount}>}>}
 */
async function fetchInvoices(config, ctx = {}) {
  const cible = marque(config, ctx);
  requireCredentials(config, cible);
  const delta = await serverTimeDelta(cible);
  const { params, plan } = fenetreApi(config, ctx);

  const me = await apiRequest(config, cible, 'GET', '/me', delta);
  const ids = await apiRequest(config, cible, 'GET', '/me/bill', delta, params);
  const known = new Set(ctx.knownRemoteIds || []);
  const pending = ids.filter((id) => !known.has(String(id)));

  ctx.log?.(`${cible.prefixe}: historique « ${plan.mode} » — ${plan.raison}`);
  ctx.log?.(`${cible.prefixe}: ${ids.length} facture(s) listée(s), ${pending.length} à récupérer`);

  // Preuve d'accès (lot 31) : `/me` a répondu avec l'identité du compte — une
  // API qui accepte la signature est une session attestée — et `/me/bill`
  // vient de rendre sa liste, fût-elle vide sur la fenêtre demandée.
  ctx.preuveDeListe?.({
    session: `API authentifiée, compte ${me.nichandle || me.email || 'sans identifiant'}`,
    liste: `API /me/bill de ${cible.nom}`,
    elements: ids.length,
  });

  const invoices = [];
  for (const billId of pending) {
    const bill = await apiRequest(
      config,
      cible,
      'GET',
      `/me/bill/${encodeURIComponent(billId)}`,
      delta
    );
    if (!bill.pdfUrl) {
      ctx.log?.(`${cible.prefixe}: facture ${billId} sans PDF, ignorée`);
      continue;
    }

    // pdfUrl est une URL pré-signée : téléchargement direct, sans en-tête signé.
    const res = await withTimeout((signal) => fetch(bill.pdfUrl, { signal }), 60_000);
    if (!res.ok) {
      throw new Error(`Téléchargement du PDF ${billId} impossible (HTTP ${res.status})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const issuedOn = (bill.date || new Date().toISOString()).slice(0, 10);

    invoices.push({
      remoteId: String(billId),
      filename: `${cible.prefixe}_${issuedOn.slice(0, 7)}_${billId}.pdf`,
      issuedOn,
      amount: bill.priceWithTax?.text || null,
      buffer,
    });
  }

  return {
    accountId: me.nichandle || me.email || null,
    invoices,
    // La couverture attestée (lot 33) : sans borne basse, `/me/bill` rend la
    // totalité de l'historique — c'est mesuré, pas supposé (65 factures OVH,
    // 67 SoYouStart le 14/08/2026). Avec une borne, le connecteur dit la
    // fenêtre plutôt que de laisser le socle promettre « tout ».
    couverture: plan.from
      ? { complete: false, detail: `les factures depuis le ${plan.from.toISOString().slice(0, 10)}` }
      : { complete: true, detail: 'toutes les factures que l\'API propose' },
  };
}

module.exports = { test, fetchInvoices, fenetreApi, ENDPOINTS, sign, CHAMP_HISTORIQUE };
