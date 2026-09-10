'use strict';

/**
 * Lot 51 — VistaPrint récupère.
 *
 * Ce que ces tests protègent :
 *
 *   1. la liste `/oh/` se lit par les liens de détail (`/od?orderId=…`) : la
 *      référence métier vit dans l'adresse, et deux liens vers la même
 *      commande ne font qu'UNE commande ;
 *   2. l'idempotence s'ancre sur la référence de commande lue sur la page
 *      (lot 46 — jamais une empreinte du PDF) : une commande déjà déposée
 *      n'est même pas rouverte ;
 *   3. le parcours mesuré par sonde le 23/08/2026 : le détail porte
 *      `order-info-number` et `order-info-date`, le bouton « Télécharger vos
 *      factures TVA » déclenche un téléchargement — `clic-document` lit la
 *      voie qui a servi ;
 *   4. une commande sans référence lisible, ou sans bouton de facture, est
 *      DITE et passée — jamais un trou silencieux.
 *
 * Toutes les valeurs (références, dates, adresses) sont INVENTÉES : elles ont
 * la forme du réel sans en être (§0ter).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilMarchand = require('../server/connectors/profil-marchand');
const vistaprint = require('../server/connectors/available/vistaprint/connector');

// ---------------------------------------------------------------------------
// Fabriques : page, contexte, documents
// ---------------------------------------------------------------------------

const PDF_FACTICE = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');

/** Un fichier PDF posé dans un dossier jetable, pour `download.path()`. */
function fichierTemporaire(contenu) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot51-'));
  const chemin = path.join(dossier, 'document.bin');
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

/**
 * Une page simulée pour le connecteur VistaPrint.
 *
 * `evaluate` est discriminé sur la FORME de l'argument — exactement les
 * signatures que le code réel envoie : `photographier` ({motif, selecteur}),
 * `chercherMarqueursMesures` ({sel, motif}), `lireCommandes` (la chaîne
 * `SELECTEUR_REPERE`), `lireDetail` ({selNumero, …}), `cliquerBoutonFacture`
 * (la chaîne `MOTIF_BOUTON_FACTURE.source`). La navigation vers un détail
 * (`goto`) est enregistrée : c'est elle qui prouve qu'une commande connue
 * n'est pas rouverte.
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
    locator: (selecteur) => ({
      count: async () =>
        ((vue.selecteursPresents || []).some((s) => selecteur.includes(s)) ? 1 : 0),
    }),
    evaluate: async (fn, arg) => {
      if (arg === vistaprint.SELECTEUR_REPERE) return vue.liens || [];
      if (arg === vistaprint.MOTIF_BOUTON_FACTURE.source) {
        if (!vue.detail || !vue.detail.boutonFacture) return false;
        page.clics += 1;
        if (surClic) surClic();
        return true;
      }
      if (arg && typeof arg === 'object') {
        if ('selNumero' in arg) {
          return vue.detail || { numero: null, texteDate: null, boutonFacture: false };
        }
        if ('sel' in arg && 'motif' in arg) {
          return (vue.selecteursPresents || []).some((s) => String(arg.sel || '').includes(s));
        }
        if ('motif' in arg && 'selecteur' in arg) {
          return {
            url: vue.url,
            boutonSeConnecter: false,
            reperes: vue.reperes ?? (vue.liens || []).length,
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

/** Un contexte simulé : il sait juste annoncer un nouvel onglet. */
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

/** Remplace l'ouverture du profil par la page simulée, le temps d'un appel. */
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

/** La vue d'une liste servie au compte : marqueur mesuré présent. */
function vueListe(liens, extra = {}) {
  return {
    url: vistaprint.URL_COMMANDES,
    liens,
    selecteursPresents: ['order-history-application'],
    libelles: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. La liste : la référence vit dans l'adresse, et se dédoublonne
// ---------------------------------------------------------------------------

test('VistaPrint : deux liens vers la même commande ne font qu\'une commande — la casse comprise', async () => {
  const page = pageSimulee(vueListe([
    { reference: 'VP_ABC123XY', href: 'https://www.vistaprint.fr/od?orderId=VP_ABC123XY' },
    { reference: 'vp_abc123xy', href: 'https://www.vistaprint.fr/od?orderId=vp_abc123xy' },
    { reference: 'VP_ZZZ999AA', href: 'https://www.vistaprint.fr/od?orderId=VP_ZZZ999AA' },
  ]));
  const commandes = await vistaprint.lireCommandes(page);
  assert.equal(commandes.length, 2,
    'une même commande peut porter plusieurs liens vers son détail — une seule doit rester');
  assert.equal(commandes[0].reference, 'VP_ABC123XY');
  assert.equal(commandes[1].reference, 'VP_ZZZ999AA');
});

test('VistaPrint : l\'ancre d\'idempotence est la référence de commande, en majuscules', () => {
  assert.equal(vistaprint.remoteIdPour('vp_abc123xy'), 'vistaprint-VP_ABC123XY',
    'jamais une empreinte du PDF (lot 46) : la référence lue sur la page, stable entre passages');
});

// ---------------------------------------------------------------------------
// 2. L'idempotence : une commande déjà déposée n'est même pas rouverte
// ---------------------------------------------------------------------------

test('VistaPrint : une commande connue n\'est ni rouverte ni cliquée — la nouvelle est récupérée', async () => {
  const detailNeuf = {
    numero: 'Numéro de commande: VP_NEUF00AA',
    texteDate: 'Date de la commande: 12 juin 2026',
    boutonFacture: true,
  };
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  page = pageSimulee(vueListe([
    { reference: 'VP_CONNU11BB', href: 'https://www.vistaprint.fr/od?orderId=VP_CONNU11BB' },
    { reference: 'VP_NEUF00AA', href: 'https://www.vistaprint.fr/od?orderId=VP_NEUF00AA' },
  ], { detail: detailNeuf }), {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur(['vistaprint-VP_CONNU11BB']);

  const resultat = await surProfilSimule(page, () => vistaprint.fetchInvoices({}, ctx));

  assert.deepEqual(page.gotos, ['https://www.vistaprint.fr/od?orderId=VP_NEUF00AA'],
    'le détail de la commande connue ne doit même pas être ouvert — le site regénérerait le document pour rien');
  assert.equal(page.clics, 1);
  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.invoices[0].remoteId, 'vistaprint-VP_NEUF00AA');
  assert.match(journal.join('\n'), /1 document\(s\) déjà déposé\(s\)/);
});

// ---------------------------------------------------------------------------
// 3. Le parcours mesuré : détail, marqueurs, clic, téléchargement
// ---------------------------------------------------------------------------

test('VistaPrint : le parcours complet — détail ouvert par son adresse, date lue, facture téléchargée', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  page = pageSimulee(vueListe([
    { reference: 'VP_ABC123XY', href: 'https://www.vistaprint.fr/od?orderId=VP_ABC123XY' },
  ], {
    detail: {
      numero: 'Numéro de commande: VP_ABC123XY',
      texteDate: 'Date de la commande: 3 juillet 2026',
      boutonFacture: true,
    },
  }), {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal, preuves } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => vistaprint.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].liste, vistaprint.URL_COMMANDES);
  assert.equal(resultat.invoices.length, 1);
  const facture = resultat.invoices[0];
  assert.equal(facture.remoteId, 'vistaprint-VP_ABC123XY');
  assert.equal(facture.issuedOn, '2026-07-03', 'la date vient du marqueur order-info-date du détail');
  assert.deepEqual(facture.buffer, PDF_FACTICE);
  assert.ok(facture.filename.startsWith('vistaprint_'), `nom inattendu : ${facture.filename}`);
  assert.match(journal.join('\n'), /voie mesurée : téléchargement direct/,
    'le journal dit la voie qui a servi — c\'est elle qui a été mesurée par sonde le 23/08/2026');
});

// ---------------------------------------------------------------------------
// 4. Ce qui manque se DIT — jamais un trou silencieux
// ---------------------------------------------------------------------------

test('VistaPrint : une commande sans référence lisible est passée, et le journal le dit', async () => {
  const page = pageSimulee(vueListe([
    { reference: null, href: 'https://www.vistaprint.fr/od?orderId=' },
  ]));
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => vistaprint.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(page.gotos, [], 'sans référence, pas d\'ancre d\'idempotence : on ne clique rien');
  assert.match(journal.join('\n'), /référence n'a pas pu être\s+lue/);
  assert.match(journal.join('\n'), /1 sans référence lisible/);
});

test('VistaPrint : un détail sans bouton de facture est dit, et la récupération continue', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let detailCourant = { numero: null, texteDate: null, boutonFacture: false };
  let page;
  const vue = vueListe([
    { reference: 'VP_SANSBOUTON', href: 'https://www.vistaprint.fr/od?orderId=VP_SANSBOUTON' },
    { reference: 'VP_AVEC000CD', href: 'https://www.vistaprint.fr/od?orderId=VP_AVEC000CD' },
  ]);
  vue.surGoto = (href) => {
    detailCourant = /VP_AVEC000CD/.test(href)
      ? {
        numero: 'Numéro de commande: VP_AVEC000CD',
        texteDate: 'Date de la commande: 28 février 2026',
        boutonFacture: true,
      }
      : { numero: null, texteDate: null, boutonFacture: false };
    vue.detail = detailCourant;
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => vistaprint.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1, 'la commande au bouton présent est récupérée quand même');
  assert.equal(resultat.invoices[0].remoteId, 'vistaprint-VP_AVEC000CD');
  assert.match(journal.join('\n'), /aucun bouton « Télécharger\s+vos factures TVA »/);
});
