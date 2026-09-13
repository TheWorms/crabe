'use strict';

/**
 * Connecteur Bunny.net — API officielle, sans navigateur.
 *
 * Documentation : https://bunny.net/docs/api-reference/core/  (section Billing)
 *
 * Authentification : un seul en-tête, `AccessKey: <clé de compte>`. Pas
 * d'OAuth, pas de signature, pas d'horloge à synchroniser — la clé se génère
 * au tableau de bord (photo de profil › Edit account details › API Key).
 *
 * ─── Deux sources de documents, et pourquoi les deux ─────────────────────────
 *
 * Bunny.net facture de deux façons selon le compte, et un compte donné ne voit
 * en général qu'une seule des deux :
 *
 *   - **prépayé** (le cas courant) : on recharge un solde, et chaque
 *     mouvement — recharge, usage mensuel, remboursement — devient un
 *     « billing record » dans `GET /billing`, avec un document en PDF quand
 *     `InvoiceAvailable` est vrai ;
 *   - **facturation différée** : Bunny.net émet des demandes de paiement,
 *     listées par `GET /billing/payment-requests`, chacune portant sa facture.
 *
 * Ne lire que la première source rendrait le connecteur muet sur un compte
 * facturé de la seconde façon — sans la moindre erreur pour le signaler, ce
 * qui est le pire des cas. On lit donc les deux.
 *
 * ⚠ Les identifiants des deux séries sont des entiers indépendants : le
 * record 412 et la demande de paiement 412 n'ont rien à voir. Sans préfixe,
 * l'un masquerait l'autre au dédoublonnage (`knownRemoteIds`) et une facture
 * disparaîtrait silencieusement. D'où `record-412` et `paiement-412`.
 */

const identity = require('../../browser-identity');
const history = require('../../history');

const BASE = 'https://api.bunny.net';
const REQUEST_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 60_000;

/** Clé du champ de profondeur d'historique, commune à tous les manifestes. */
const CHAMP_HISTORIQUE = 'historique';

/** Les types de mouvement qui ne sont pas des documents comptables à archiver. */
const TYPES_SANS_FACTURE = new Set([5, 7]); // 5 = code promo, 7 = crédits d'affiliation

async function withTimeout(promiseFactory, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function requireCredentials(config) {
  if (!config?.accessKey) throw new Error('Clé d\'API Bunny.net manquante : accessKey');
}

/**
 * Appel de l'API, en JSON.
 *
 * Le 401 est traité à part : c'est le seul cas où l'utilisateur a quelque
 * chose à faire, et lui dire « HTTP 401 » ne lui apprendrait rien.
 */
async function bunnyRequest(config, route) {
  const res = await withTimeout((signal) =>
    fetch(`${BASE}${route}`, {
      signal,
      headers: { AccessKey: config.accessKey, Accept: 'application/json' },
    })
  );

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Clé d\'API Bunny.net refusée. Vérifiez qu\'elle est bien recopiée en entier, '
        + 'et qu\'elle donne accès à la facturation du compte.'
    );
  }
  if (!res.ok) throw new Error(`Bunny.net a répondu ${res.status} sur ${route}`);
  return res.json();
}

/** Le PDF d'un document, ou une erreur qui dit ce qui a manqué. */
async function telechargerPdf(config, url, etiquette) {
  const absolue = /^https?:\/\//i.test(url);
  const res = await withTimeout(
    (signal) =>
      fetch(absolue ? url : `${BASE}${url}`, {
        signal,
        // Une URL de document servie par Bunny.net reste derrière la clé : on
        // l'envoie même quand l'URL vient de la réponse JSON, elle est ignorée
        // par un hôte qui ne la demande pas.
        headers: { AccessKey: config.accessKey, Accept: 'application/pdf' },
      }),
    PDF_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(`Téléchargement du document ${etiquette} impossible (HTTP ${res.status})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // Le contenu fait foi, jamais le type déclaré : une réponse d'erreur en HTML
  // avec un content-type impeccable déposerait une page web dans le dossier
  // des factures sans que rien ne le signale (voir browser-identity.estPdf).
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le document ${etiquette} n'est pas un PDF (${buffer.length} octets reçus). `
        + 'La clé d\'API a peut-être perdu son accès à la facturation.'
    );
  }
  return buffer;
}

/** Date ISO (AAAA-MM-JJ) d'un horodatage Bunny.net, ou null s'il est absent. */
function dateIso(valeur) {
  if (!valeur) return null;
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * La borne basse de la fenêtre, en ISO — `null` pour « tout l'historique ».
 *
 * ⚠ Contrairement à OVHcloud, Bunny.net ne prend pas de fenêtre de dates sur
 * ses routes de facturation : `GET /billing` rend tout, et c'est crabe qui
 * filtre. La différence est invisible ici mais elle compte pour qui relit :
 * une borne oubliée ne masquerait rien côté serveur, elle ferait simplement
 * télécharger davantage.
 */
function borneHistorique(config, ctx) {
  const plan = history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant qu'un
    // plancher protège l'existant.
    plafondMois: ctx?.conservationMois || 0,
  });
  return { borne: plan.from ? plan.from.toISOString().slice(0, 10) : null, plan };
}

/**
 * Les documents disponibles, des deux sources, sous une forme commune.
 *
 * @param {object} config
 * @param {string|null} borne date la plus ancienne retenue, ou `null` pour tout
 * @returns {Promise<Array<{remoteId, issuedOn, amount, url, etiquette}>>}
 */
async function listerDocuments(config, borne = null) {
  const documents = [];

  const facturation = await bunnyRequest(config, '/billing');
  for (const record of facturation?.BillingRecords || []) {
    if (!record?.InvoiceAvailable) continue;
    if (TYPES_SANS_FACTURE.has(record.Type)) continue;
    const issuedOn = dateIso(record.Timestamp);
    if (!issuedOn || (borne && issuedOn < borne)) continue;
    documents.push({
      remoteId: `record-${record.Id}`,
      issuedOn,
      amount: typeof record.Amount === 'number' ? record.Amount.toFixed(2) : null,
      url: record.DocumentDownloadUrl || `/billing/summary/${record.Id}/pdf`,
      etiquette: `record ${record.Id}`,
    });
  }

  const demandes = await bunnyRequest(config, '/billing/payment-requests');
  for (const demande of Array.isArray(demandes) ? demandes : []) {
    // Une demande sans facture rattachée n'a pas encore de document : elle
    // reviendra à la prochaine exécution, une fois payée.
    if (!demande?.BillingInvoiceId && !demande?.BillingInvoiceDownloadLink) continue;
    const issuedOn = dateIso(demande.DateGenerated);
    if (!issuedOn || (borne && issuedOn < borne)) continue;
    documents.push({
      remoteId: `paiement-${demande.Id}`,
      issuedOn,
      amount: typeof demande.Amount === 'number' ? demande.Amount.toFixed(2) : null,
      url:
        demande.BillingInvoiceDownloadLink
        || `/billing/payment-request-invoice/${demande.Id}/pdf`,
      etiquette: `demande de paiement ${demande.Id}`,
    });
  }

  return documents;
}

/**
 * Vérification d'authentification légère : compte les documents disponibles,
 * n'en télécharge aucun.
 */
async function test(config, ctx = {}) {
  requireCredentials(config);
  // Le test ne reçoit pas `dejaRecupere` : le mode « depuis » y vaut donc
  // « tout l'historique », et le nombre annoncé est bien celui que la première
  // récupération ira chercher.
  const { borne } = borneHistorique(config, ctx);
  const documents = await listerDocuments(config, borne);

  return {
    ok: true,
    invoiceCount: documents.length,
    // Bunny.net n'expose pas d'identifiant de compte lisible sur ses routes de
    // facturation : les factures se rangent donc sous le dossier par défaut.
    accountId: null,
    message:
      `Connexion réussie — ${documents.length} facture(s) trouvée(s)`,
  };
}

/** Liste et télécharge les factures. */
async function fetchInvoices(config, ctx = {}) {
  requireCredentials(config);
  const { borne, plan } = borneHistorique(config, ctx);
  const documents = await listerDocuments(config, borne);
  ctx.log?.(`bunny-net: historique « ${plan.mode} » — ${plan.raison}`);

  const known = new Set(ctx.knownRemoteIds || []);
  const pending = documents.filter((d) => !known.has(d.remoteId));
  ctx.log?.(
    `bunny-net: ${documents.length} document(s) listé(s), ${pending.length} à récupérer`
  );

  // Preuve d'accès (lot 31) : l'API a accepté la clé et rendu la liste des
  // documents de facturation — fût-elle vide, elle a été LUE, et c'est ce qui
  // autorise « aucune nouvelle facture ».
  ctx.preuveDeListe?.({
    session: 'clé d\'API acceptée par Bunny.net',
    liste: 'liste des documents de facturation (API billing)',
    elements: documents.length,
  });

  const invoices = [];
  for (const doc of pending) {
    const buffer = await telechargerPdf(config, doc.url, doc.etiquette);
    invoices.push({
      remoteId: doc.remoteId,
      filename: `bunny-net_${doc.issuedOn.slice(0, 7)}_${doc.remoteId}.pdf`,
      issuedOn: doc.issuedOn,
      amount: doc.amount,
      buffer,
    });
  }

  return invoices;
}

module.exports = { test, fetchInvoices, listerDocuments, borneHistorique, BASE };
