'use strict';

/**
 * Lot 51 — Darty récupère, parce que la mesure l'a autorisé.
 *
 * Trois lectures de liste espacées sur 61 minutes (23/08/2026 : 11:56, 12:11,
 * 12:57 UTC) ont toutes atteint la liste et compté les mêmes commandes, sans
 * renvoi : c'est cette mesure, et elle seule, qui a fait écrire le parcours.
 *
 * Ce que ces tests protègent :
 *
 *   1. la liste se lit par les blocs `data-testid="order"` : numéro (« N° »
 *      + chiffres), texte (où vit la date), lien de détail quand il existe ;
 *   2. l'idempotence s'ancre sur le NUMÉRO DE COMMANDE lu sur la page
 *      (lot 46) : une commande déjà déposée n'est même pas rouverte ;
 *   3. le mur peut REVENIR au milieu du parcours (DataDome juge chaque
 *      passage — leçon des renvois du 23/08/2026 au matin) : la récupération
 *      s'arrête EN LE DISANT et ce qui a été lu est conservé — jamais un trou
 *      silencieux ;
 *   4. un détail sans « Justificatif de vente » est dit, et on continue.
 *
 * Toutes les valeurs (numéros, dates, adresses) sont INVENTÉES : elles ont la
 * forme du réel sans en être (§0ter).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilMarchand = require('../server/connectors/profil-marchand');
const darty = require('../server/connectors/available/darty/connector');

// ---------------------------------------------------------------------------
// Fabriques : page, contexte, documents
// ---------------------------------------------------------------------------

const PDF_FACTICE = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');

function fichierTemporaire(contenu) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot51-darty-'));
  const chemin = path.join(dossier, 'document.bin');
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

/**
 * Une page simulée pour le connecteur Darty. `evaluate` est discriminé sur la
 * FORME de l'argument — les signatures que le code réel envoie :
 * `photographier` ({motif, selecteur}), la page « Maintenance » (la chaîne
 * `MOTIF_FAUSSE_MAINTENANCE.source`), `lireCommandes` ({selOrder, …}),
 * `lireDetail` ({selFacture, …}), `cliquerJustificatif` ({selDeclencheur, …}).
 * `vue.surGoto` fait évoluer la page simulée à chaque navigation de détail.
 */
function pageSimulee(vue, { surClic = null } = {}) {
  const gestionnaires = {};
  const page = {
    clics: 0,
    gotos: [],
    url: () => vue.url,
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: (ev, cb) => {
      const liste = gestionnaires[ev] || [];
      const i = liste.indexOf(cb);
      if (i >= 0) liste.splice(i, 1);
    },
    emettre: (ev, arg) => { for (const cb of [...(gestionnaires[ev] || [])]) cb(arg); },
    waitForTimeout: async () => { await new Promise((r) => { setImmediate(r); }); },
    waitForLoadState: async () => {},
    goto: async (href) => {
      page.gotos.push(href);
      if (vue.surGoto) vue.surGoto(href);
    },
    locator: () => ({ count: async () => 0 }),
    evaluate: async (fn, arg) => {
      if (arg === darty.MOTIF_FAUSSE_MAINTENANCE.source) return !!vue.maintenance;
      if (arg && typeof arg === 'object') {
        if ('selOrder' in arg) return vue.commandes || [];
        if ('selDeclencheur' in arg) {
          if (!vue.detail || !vue.detail.justificatif) return false;
          page.clics += 1;
          if (surClic) surClic();
          return true;
        }
        if ('selFacture' in arg) {
          return vue.detail || { justificatif: false };
        }
        if ('motif' in arg && 'selecteur' in arg) {
          return {
            url: vue.url,
            boutonSeConnecter: false,
            reperes: vue.reperes ?? (vue.commandes || []).length,
            libelles: vue.libelles || [],
          };
        }
      }
      // Sans argument : le chasseur de bandeau de cookies — rien à fermer.
      return false;
    },
  };
  return page;
}

function contexteSimule() {
  const gestionnaires = {};
  return {
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: (ev, cb) => {
      const liste = gestionnaires[ev] || [];
      const i = liste.indexOf(cb);
      if (i >= 0) liste.splice(i, 1);
    },
    emettre: (ev, arg) => { for (const cb of [...(gestionnaires[ev] || [])]) cb(arg); },
  };
}

async function surProfilSimule(page, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(page, contexteSimule());
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

function contexteEnregistreur(knownRemoteIds = []) {
  const journal = [];
  const preuves = [];
  return {
    journal,
    preuves,
    ctx: {
      userId: 1,
      knownRemoteIds,
      log: (m) => journal.push(m),
      preuveDeListe: (p) => preuves.push(p),
    },
  };
}

/** La vue d'une liste servie au compte (l'adresse tient, elle fait preuve). */
function vueListe(commandes, extra = {}) {
  return {
    url: darty.URL_COMMANDES,
    commandes,
    libelles: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. La liste : numéro, texte, lien — et l'ancre d'idempotence
// ---------------------------------------------------------------------------

test('Darty : l\'ancre d\'idempotence est le numéro de commande lu sur la page', () => {
  assert.equal(darty.remoteIdPour('123456789'), 'darty-123456789',
    'jamais une empreinte du PDF (lot 46) : le numéro, stable entre passages');
  assert.equal(darty.MOTIF_NUMERO.exec('N° 987654321')[1], '987654321');
  assert.equal(darty.urlDetail('987654321'),
    'https://www.darty.com/espace_client/mes-commandes/987654321/0',
    'la forme du détail relevée à l\'écran le 23/08/2026');
});

// ---------------------------------------------------------------------------
// 2. L'idempotence : une commande déjà déposée n'est même pas rouverte
// ---------------------------------------------------------------------------

test('Darty : une commande connue n\'est ni rouverte ni cliquée — la nouvelle est récupérée', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = vueListe([
    { numero: '111222333', texte: 'N° 111222333 Commandé le 02/05/2026', href: null },
    { numero: '444555666', texte: 'N° 444555666 Commandé le 11/07/2026', href: null },
  ]);
  vue.surGoto = () => {
    vue.detail = { justificatif: true };
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur(['darty-111222333']);

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.deepEqual(page.gotos, [darty.urlDetail('444555666')],
    'le détail de la commande connue ne doit même pas être ouvert');
  assert.equal(page.clics, 1);
  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.invoices[0].remoteId, 'darty-444555666');
  assert.equal(resultat.invoices[0].issuedOn, '2026-07-11',
    'la date vient du texte du bloc, lu sur la liste');
  assert.match(journal.join('\n'), /1 document\(s\) déjà déposé\(s\)/);
});

// ---------------------------------------------------------------------------
// 3. Le parcours complet — et la preuve de liste
// ---------------------------------------------------------------------------

test('Darty : le parcours complet — détail ouvert par le lien du bloc, justificatif lu', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = vueListe([
    {
      numero: '777888999',
      texte: 'N° 777888999 Commandé le 28/02/2026',
      href: 'https://www.darty.com/espace_client/mes-commandes/777888999/0',
    },
  ]);
  vue.surGoto = () => {
    vue.detail = { justificatif: true };
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal, preuves } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].liste, darty.URL_COMMANDES);
  assert.deepEqual(page.gotos, ['https://www.darty.com/espace_client/mes-commandes/777888999/0'],
    'le bloc porte un lien : c\'est LUI qu\'on suit, pas une adresse reconstruite');
  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.invoices[0].remoteId, 'darty-777888999');
  assert.deepEqual(resultat.invoices[0].buffer, PDF_FACTICE);
  assert.ok(resultat.invoices[0].filename.startsWith('darty_'));
  assert.match(journal.join('\n'), /voie mesurée : téléchargement direct/);
});

// ---------------------------------------------------------------------------
// 4. Le mur qui revient au milieu du parcours : dit, et rien de perdu
// ---------------------------------------------------------------------------

test('Darty : la page « Maintenance » au milieu du parcours arrête EN LE DISANT — l\'acquis est conservé', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = vueListe([
    { numero: '101010101', texte: 'N° 101010101 Commandé le 03/03/2026', href: null },
    { numero: '202020202', texte: 'N° 202020202 Commandé le 04/04/2026', href: null },
    { numero: '303030303', texte: 'N° 303030303 Commandé le 05/05/2026', href: null },
  ]);
  vue.surGoto = (href) => {
    if (/202020202/.test(href)) {
      // DataDome reprend la main : la page « Maintenance » au deuxième détail.
      vue.maintenance = true;
      vue.detail = { justificatif: false };
    } else {
      vue.detail = { justificatif: true };
    }
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1, 'ce qui a été lu avant le mur est conservé');
  assert.equal(resultat.invoices[0].remoteId, 'darty-101010101');
  assert.equal(page.gotos.length, 2,
    'le parcours s\'arrête au mur : la troisième commande n\'est pas tentée pour ce passage');
  assert.match(journal.join('\n'),
    /page « Maintenance ».*au milieu du parcours/s,
    'le journal dit le mur dans les mots du produit — jamais un trou silencieux');
  assert.match(journal.join('\n'), /1 document\(s\) déjà lu\(s\) sont conservés/);
});

test('Darty : le renvoi vers l\'authentification au milieu du parcours arrête aussi, en le disant', async () => {
  let page;
  const vue = vueListe([
    { numero: '606060606', texte: 'N° 606060606 Commandé le 06/06/2026', href: null },
  ]);
  vue.surGoto = () => {
    vue.url = 'https://www.darty.com/authentification/login?goto=commande';
    vue.detail = { justificatif: true };
  };
  page = pageSimulee(vue);
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices, []);
  assert.equal(page.clics, 0, 'on ne clique rien sur un écran de connexion');
  assert.match(journal.join('\n'), /renvoyé la lecture vers son écran de connexion/);
});

// ---------------------------------------------------------------------------
// 5. Ce qui manque se DIT
// ---------------------------------------------------------------------------

test('Darty : un détail sans « Justificatif de vente » est dit, et la récupération continue', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = vueListe([
    { numero: '121212121', texte: 'N° 121212121 Commandé le 07/07/2026', href: null },
    { numero: '343434343', texte: 'N° 343434343 Commandé le 08/08/2026', href: null },
  ]);
  vue.surGoto = (href) => {
    vue.detail = { justificatif: !/121212121/.test(href) };
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.invoices[0].remoteId, 'darty-343434343');
  assert.match(journal.join('\n'), /aucun « Justificatif de\s+vente » sur son détail/);
  assert.match(journal.join('\n'), /1 sans justificatif sur leur détail/);
});

test('Darty : une commande sans numéro lisible est passée pour ne pas risquer un doublon', async () => {
  const page = pageSimulee(vueListe([
    { numero: null, texte: 'Commande sans numéro visible', href: null },
  ]));
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => darty.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(page.gotos, [], 'sans ancre d\'idempotence, on n\'ouvre rien');
  assert.match(journal.join('\n'), /numéro n'a pas pu être lu/);
});
