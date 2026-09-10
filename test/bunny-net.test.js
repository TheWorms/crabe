'use strict';

/**
 * Le connecteur Bunny.net — tout ce qui se vérifie sans joindre l'API.
 *
 * Bunny.net facture de deux façons selon le compte (solde prépayé d'un côté,
 * demandes de paiement de l'autre), et le connecteur lit les deux sources. Ce
 * fichier garde les quatre décisions qui en découlent :
 *
 *   1. **les identifiants des deux séries sont préfixés** — ce sont deux
 *      suites d'entiers indépendantes, et sans préfixe le record 412 et la
 *      demande de paiement 412 se confondraient au dédoublonnage : une
 *      facture disparaîtrait sans une ligne d'erreur ;
 *   2. **un mouvement sans document n'est pas une facture** — un code promo
 *      ou un crédit d'affiliation n'a rien à archiver ;
 *   3. **le contenu fait foi, jamais le type déclaré** — une page HTML servie
 *      avec un `content-type: application/pdf` impeccable se déposerait dans
 *      le dossier des factures sans que rien ne le signale ;
 *   4. **la fenêtre de récupération est respectée**, sinon chaque exécution
 *      redemanderait l'historique entier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bunny = require('../server/connectors/available/bunny-net/connector');

const CLE = { accessKey: 'clé-de-test' };

/**
 * Un faux api.bunny.net. `reponses` donne le corps de chaque route, `appels`
 * garde la trace des URL demandées — c'est ce qui prouve QUEL document a été
 * réclamé, la seule question qui vaille quand deux séries d'identifiants se
 * ressemblent.
 */
function fauxBunny({ billing = {}, demandes = [], pdf = Buffer.from('%PDF-1.7 réel') }) {
  const appels = [];
  return {
    appels,
    fetch: async (url) => {
      const u = String(url);
      appels.push(u);
      if (u.endsWith('/billing')) return { ok: true, status: 200, json: async () => billing };
      if (u.endsWith('/billing/payment-requests')) {
        return { ok: true, status: 200, json: async () => demandes };
      }
      return { ok: true, status: 200, arrayBuffer: async () => pdf };
    },
  };
}

async function avec(faux, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = faux.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Un horodatage à N mois d'ici, au format que rend l'API. */
function ilYA(mois) {
  const d = new Date();
  d.setMonth(d.getMonth() - mois);
  return d.toISOString();
}

test('les deux sources de documents sont lues, avec des identifiants distincts', async () => {
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        { Id: 412, Timestamp: ilYA(1), Amount: 12.5, Type: 3, InvoiceAvailable: true },
      ],
    },
    demandes: [{ Id: 412, DateGenerated: ilYA(2), Amount: 30, BillingInvoiceId: 99 }],
  });

  const documents = await avec(faux, () => bunny.listerDocuments(CLE, 12));
  assert.deepEqual(
    documents.map((d) => d.remoteId).sort(),
    ['paiement-412', 'record-412'],
    'le même entier des deux côtés doit donner deux documents, pas un'
  );
});

test('un mouvement sans document disponible est ignoré', async () => {
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        { Id: 1, Timestamp: ilYA(1), Amount: 10, Type: 3, InvoiceAvailable: false },
        { Id: 2, Timestamp: ilYA(1), Amount: -5, Type: 5, InvoiceAvailable: true }, // code promo
        { Id: 3, Timestamp: ilYA(1), Amount: 20, Type: 0, InvoiceAvailable: true },
      ],
    },
  });

  const documents = await avec(faux, () => bunny.listerDocuments(CLE, 12));
  assert.deepEqual(documents.map((d) => d.remoteId), ['record-3']);
});

test('la fenêtre de récupération borne les deux sources', async () => {
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        { Id: 1, Timestamp: ilYA(1), Amount: 10, Type: 3, InvoiceAvailable: true },
        { Id: 2, Timestamp: ilYA(30), Amount: 10, Type: 3, InvoiceAvailable: true },
      ],
    },
    demandes: [{ Id: 7, DateGenerated: ilYA(24), Amount: 5, BillingInvoiceId: 1 }],
  });

  // Depuis le lot 17, la borne est une DATE et non un nombre de mois : c'est le
  // réglage « Historique à récupérer » du compte qui la fixe, et « tout
  // l'historique » se dit `null`.
  const borne = ilYA(12).slice(0, 10);
  const documents = await avec(faux, () => bunny.listerDocuments(CLE, borne));
  assert.deepEqual(documents.map((d) => d.remoteId), ['record-1']);

  const sansBorne = await avec(faux, () => bunny.listerDocuments(CLE, null));
  assert.deepEqual(
    sansBorne.map((d) => d.remoteId).sort(),
    ['paiement-7', 'record-1', 'record-2'],
    'sans borne, les documents anciens doivent tous remonter'
  );
});

test('le réglage du compte fixe la borne, pas un plafond codé en dur', () => {
  // Le défaut « depuis » au premier passage va chercher TOUT le passé : c'est
  // la correction du lot 17, un compte ouvert il y a cinq ans doit se rattraper.
  assert.equal(bunny.borneHistorique({}, {}).borne, null);
  assert.equal(bunny.borneHistorique({ historique: 'tout' }, {}).borne, null);

  const courante = bunny.borneHistorique({ historique: 'courante' }, {});
  assert.equal(courante.borne, `${new Date().getFullYear()}-01-01`);
});

test('les factures déjà connues ne sont pas retéléchargées', async () => {
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        { Id: 1, Timestamp: ilYA(1), Amount: 10, Type: 3, InvoiceAvailable: true },
        { Id: 2, Timestamp: ilYA(2), Amount: 10, Type: 3, InvoiceAvailable: true },
      ],
    },
  });

  const invoices = await avec(faux, () =>
    bunny.fetchInvoices(CLE, { knownRemoteIds: ['record-1'] })
  );
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].remoteId, 'record-2');
  assert.match(invoices[0].filename, /^bunny-net_\d{4}-\d{2}_record-2\.pdf$/);
  assert.ok(
    faux.appels.some((u) => u.includes('/billing/summary/2/pdf')),
    `le PDF du record 2 doit être demandé : ${faux.appels.join(', ')}`
  );
  assert.equal(
    faux.appels.some((u) => u.includes('/billing/summary/1/pdf')),
    false,
    'et celui du record 1, jamais'
  );
});

test('un document qui n\'est pas un PDF est refusé, avec ce qu\'il faut faire', async () => {
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        { Id: 5, Timestamp: ilYA(1), Amount: 10, Type: 3, InvoiceAvailable: true },
      ],
    },
    // Le piège : une page d'erreur, servie avec les honneurs.
    pdf: Buffer.from('<!DOCTYPE html><title>Access denied</title>'),
  });

  await assert.rejects(
    () => avec(faux, () => bunny.fetchInvoices(CLE, {})),
    /n'est pas un PDF/
  );
});

test('une clé refusée dit quoi vérifier, pas un code HTTP', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const resultat = await bunny.test(CLE).catch((err) => err);
    assert.match(resultat.message, /Clé d'API Bunny\.net refusée/);
    assert.match(resultat.message, /recopiée en entier/);
    assert.equal(/401/.test(resultat.message), false, 'aucun code HTTP servi à l\'utilisateur');
  } finally {
    globalThis.fetch = original;
  }
});

test('sans clé, le connecteur ne part pas au réseau', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('aucun appel ne doit partir');
  };
  try {
    await assert.rejects(() => bunny.test({}), /Clé d'API Bunny\.net manquante/);
  } finally {
    globalThis.fetch = original;
  }
});

test('un lien de document absolu fourni par l\'API est suivi tel quel', async () => {
  // Bunny.net peut renvoyer une URL de document toute faite : la refabriquer
  // à partir de l'identifiant marcherait aujourd'hui et casserait le jour où
  // le service déplace ses documents.
  const faux = fauxBunny({
    billing: {
      BillingRecords: [
        {
          Id: 9,
          Timestamp: ilYA(1),
          Amount: 10,
          Type: 3,
          InvoiceAvailable: true,
          DocumentDownloadUrl: 'https://api.bunny.net/billing/document/abcdef/pdf',
        },
      ],
    },
  });

  await avec(faux, () => bunny.fetchInvoices(CLE, {}));
  assert.ok(faux.appels.includes('https://api.bunny.net/billing/document/abcdef/pdf'));
});
