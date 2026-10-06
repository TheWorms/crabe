'use strict';

/**
 * Lot 52 — LDLC compte ce qu'il faut, et récupère.
 *
 * Le lot 48 avait ancré le repère de commande sur le NUMÉRO DE SUIVI DU
 * TRANSPORTEUR (mesuré le 24/08/2026 : la « référence » calibrée était celle
 * du bloc « Suivi colis ») — et la valeur réelle était en dur dans le dépôt.
 * Ce que ces tests protègent :
 *
 *   1. l'ancre d'idempotence est l'IDENTIFIANT D'ADRESSE (une lettre puis
 *      neuf chiffres, porté par les liens de détail ET de facture) — un
 *      numéro de suivi (deux lettres … deux lettres) ne passe JAMAIS, ni
 *      comme ancre ni comme repère : c'est la morsure de ce lot ;
 *   2. aucune valeur à la forme d'un numéro de suivi n'existe dans les
 *      sources des connecteurs — la réparation du lot 48 ne doit pas revenir ;
 *   3. le parcours lit toutes les périodes proposées, prend le lien de
 *      facture de la ligne quand le rendu serveur l'y a mis, rouvre
 *      « Détails » sinon (liste rafraîchie en AJAX, mesuré le 24/08/2026) ;
 *   4. un menu de périodes muet, une période qui ne s'affiche pas, un renvoi
 *      vers l'authentification au milieu du parcours : tout se DIT, et
 *      l'acquis est conservé.
 *
 * Toutes les valeurs (identifiants, dates, libellés) sont INVENTÉES : elles
 * ont la forme du réel sans en être (§0ter).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilMarchand = require('../server/connectors/profil-marchand');
const ldlc = require('../server/connectors/available/ldlc/connector');

// ---------------------------------------------------------------------------
// Fabriques : page, contexte, documents
// ---------------------------------------------------------------------------

const PDF_FACTICE = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');

function fichierTemporaire(contenu) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot52-ldlc-'));
  const chemin = path.join(dossier, 'document.bin');
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

const urlDetailPour = (id) =>
  `https://secure2.ldlc.com/fr-fr/Orders/PartialCompletedOrderContent?orderId=${id}`
  + '&orderDate=01/02/2026 10:11:12&orderType=Web';
const urlFacturePour = (id) =>
  `https://secure2.ldlc.com/fr-fr/Orders/DownloadOrderInvoice?orderId=${id}`
  + '&orderDate=01/02/2026 10:11:12&orderType=Web';

/**
 * Une page simulée pour le connecteur LDLC. `evaluate` est discriminé sur la
 * FORME de l'argument — les signatures que le code réel envoie :
 * `photographier` ({motif, selecteur}), `lireCommandes` ({selOrder, …}),
 * `lirePeriodes` ({ouvrirMenu} puis {lireOptions}), `fermerMenuPeriodes`
 * ({fermerMenu}), `choisirPeriode` ({choisir} puis {libellePeriode}),
 * `ouvrirDetail` ({selDetail, id}), `factureVisible` ({selFacture, id}),
 * `cliquerFacture` ({selCliquerFacture, id}).
 */
function pageSimulee(vue, { surClic = null } = {}) {
  const gestionnaires = {};
  const page = {
    clics: [],
    detailsOuverts: [],
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
    locator: () => ({ count: async () => 0 }),
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object') {
        if ('selOrder' in arg) return vue.lignes || [];
        if ('ouvrirMenu' in arg) return vue.menu !== null && vue.menu !== undefined;
        if ('lireOptions' in arg) return vue.menu || [];
        if ('fermerMenu' in arg) return undefined;
        if ('choisir' in arg) {
          const existe = (vue.menu || []).some((o) => o.libelle === arg.choisir);
          if (existe && vue.surChoix) vue.surChoix(arg.choisir);
          return existe;
        }
        if ('libellePeriode' in arg) return vue.periodeAffichee || '';
        if ('selDetail' in arg && 'id' in arg) {
          page.detailsOuverts.push(arg.id);
          if (vue.surOuvrirDetail) vue.surOuvrirDetail(arg.id);
          return vue.detailsOuvrables !== false;
        }
        if ('selFacture' in arg && 'id' in arg) {
          return (vue.facturesVisibles || []).includes(arg.id);
        }
        if ('selCliquerFacture' in arg) {
          if (!(vue.facturesVisibles || []).includes(arg.id)) return false;
          page.clics.push(arg.id);
          if (surClic) surClic(arg.id);
          return true;
        }
        if ('motif' in arg && 'selecteur' in arg) {
          return {
            url: vue.url,
            boutonSeConnecter: false,
            reperes: (vue.lignes || []).length,
            libelles: [],
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

/** Une ligne de commande telle que la liste rendue côté serveur la porte. */
function ligne(id, { facture = true, date = '01/02/2026' } = {}) {
  return {
    detailHref: urlDetailPour(id),
    factureHref: facture ? urlFacturePour(id) : null,
    dateTexte: date,
  };
}

// ---------------------------------------------------------------------------
// 1. L'ancre : l'identifiant d'adresse — JAMAIS le numéro de suivi (morsure)
// ---------------------------------------------------------------------------

test('LDLC : l\'ancre est l\'identifiant que portent les adresses — un numéro de suivi ne passe JAMAIS', () => {
  assert.equal(ldlc.orderIdDepuisHref(urlDetailPour('B123456789')), 'B123456789',
    'l\'identifiant se lit dans l\'adresse du lien « Détails »');
  assert.equal(ldlc.orderIdDepuisHref(urlFacturePour('B123456789')), 'B123456789',
    'et dans celle du lien de facture — c\'est le même, c\'est ce qui en fait l\'ancre');
  assert.equal(ldlc.remoteIdPour('B123456789'), 'ldlc-B123456789');

  // La MORSURE de ce lot : la forme d'un numéro de suivi transporteur (deux
  // lettres, neuf chiffres, deux lettres — valeur INVENTÉE) ne doit jamais
  // redevenir une ancre ni un repère. Un motif recalibré comme au lot 48
  // ferait chuter ces assertions.
  assert.equal(ldlc.MOTIF_ORDER_ID.test('KL987654321KL'), false,
    'l\'ancre du lot 48 était le numéro de suivi : ce motif ne doit JAMAIS l\'accepter');
  assert.equal(ldlc.orderIdDepuisHref(urlDetailPour('KL987654321KL')), null,
    'même porté par une adresse, un identifiant à la forme d\'un suivi est refusé');
  assert.equal(ldlc.MOTIF_REPERE.test('Expédiée le 01/02/2026 Suivi colis : KL987654321KL'), false,
    'le filet de comptage ne compte pas un bloc « Suivi colis »');
  assert.equal(ldlc.MOTIF_REPERE.test('Nº commande 1234567890123A'), true,
    'il compte la forme du « Nº commande » affiché : treize chiffres puis une lettre');
});

test('LDLC : aucune valeur à la forme d\'un numéro de suivi dans les sources des connecteurs', () => {
  // La réparation du lot 48 : la valeur réelle a été retirée du dépôt, et ce
  // balayage empêche toute valeur de cette forme d'y revenir — dans le code
  // des connecteurs comme dans leurs manifestes.
  const racine = path.join(__dirname, '..', 'server', 'connectors');
  const suspects = [];
  (function balayer(dossier) {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) {
        balayer(chemin);
      } else if (/\.(js|json)$/.test(entree.name)) {
        if (/\b[A-Z]{2}\d{9}[A-Z]{2}\b/.test(fs.readFileSync(chemin, 'utf8'))) {
          suspects.push(path.relative(racine, chemin));
        }
      }
    }
  })(racine);
  assert.deepEqual(suspects, [],
    'une valeur à la forme d\'un numéro de suivi transporteur traîne dans les sources');
});

// ---------------------------------------------------------------------------
// 2. Le parcours : lien de la ligne, périodes, détail rouvert, idempotence
// ---------------------------------------------------------------------------

test('LDLC : le parcours complet — la ligne connue n\'est pas rouverte, les périodes sont toutes lues', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = {
    url: ldlc.URL_COMMANDES,
    // Le rendu serveur initial : les lignes portent leur lien de facture.
    lignes: [
      ligne('A111222333'),
      ligne('B444555666', { date: '11/07/2026' }),
      // Une ligne dont l'adresse porte un identifiant à la forme d'un suivi :
      // elle doit être PASSÉE (sans détail ouvert), pas ancrée de travers.
      ligne('KL987654321KL'),
    ],
    menu: [
      { libelle: 'Depuis les 6 derniers mois', selectionnee: true },
      { libelle: 'Une période plus ancienne', selectionnee: false },
    ],
    facturesVisibles: ['A111222333', 'B444555666'],
    surChoix: (libelle) => {
      // Le rafraîchissement AJAX mesuré le 24/08/2026 : la nouvelle liste ne
      // porte PLUS le lien de facture sur la ligne.
      vue.periodeAffichee = libelle;
      vue.lignes = [ligne('C777888999', { facture: false, date: '03/03/2025' })];
    },
    surOuvrirDetail: (id) => {
      // « Détails » recharge le bloc #order_<id> avec son lien bill-link.
      vue.facturesVisibles = [...vue.facturesVisibles, id];
    },
    periodeAffichee: 'Depuis les 6 derniers mois',
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal, preuves } = contexteEnregistreur(['ldlc-A111222333']);

  const resultat = await surProfilSimule(page, () => ldlc.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].liste, ldlc.URL_COMMANDES);

  assert.deepEqual(page.clics, ['B444555666', 'C777888999'],
    'la commande déjà déposée n\'est pas recliquée ; celle de l\'autre période l\'est');
  assert.deepEqual(page.detailsOuverts, ['C777888999'],
    'seul le détail de la ligne SANS lien de facture (liste rafraîchie) est rouvert');
  assert.equal(resultat.invoices.length, 2);
  assert.deepEqual(resultat.invoices.map((i) => i.remoteId),
    ['ldlc-B444555666', 'ldlc-C777888999']);
  assert.equal(resultat.invoices[0].issuedOn, '2026-07-11',
    'la date vient de la cellule de date de la ligne');
  assert.equal(resultat.invoices[1].issuedOn, '2025-03-03');
  assert.deepEqual(resultat.invoices[0].buffer, PDF_FACTICE);
  assert.ok(resultat.invoices[0].filename.startsWith('ldlc_'));

  const lignes = journal.join('\n');
  assert.match(lignes, /2 période\(s\) d'historique — toutes\s+sont parcourues/,
    'le journal dit que les périodes proposées ont toutes été lues');
  assert.match(lignes, /1 document\(s\) déjà déposé\(s\)/);
  assert.match(lignes, /1 commande\(s\) sans identifiant lisible/,
    'la ligne à l\'identifiant illisible (forme de suivi) est dite, jamais ancrée de travers');
  assert.match(lignes, /voie mesurée : téléchargement direct/);
});

// ---------------------------------------------------------------------------
// 3. Ce qui ne répond pas se DIT — jamais un historique partiel silencieux
// ---------------------------------------------------------------------------

test('LDLC : un menu de périodes muet est dit — l\'historique peut être incomplet, jamais en silence', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = {
    url: ldlc.URL_COMMANDES,
    lignes: [ligne('D101010101')],
    menu: null,
    facturesVisibles: ['D101010101'],
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => ldlc.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1, 'la période affichée par défaut est quand même lue');
  assert.match(journal.join('\n'), /menu des périodes n'a pas répondu/);
  assert.match(journal.join('\n'), /INCOMPLET/,
    'un historique partiel qui se présenterait comme complet serait un mensonge');
});

test('LDLC : une période qui ne s\'affiche pas est passée EN LE DISANT, les autres continuent', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = {
    url: ldlc.URL_COMMANDES,
    lignes: [ligne('E121212121')],
    menu: [
      { libelle: 'Depuis les 6 derniers mois', selectionnee: true },
      { libelle: 'Une période têtue', selectionnee: false },
    ],
    facturesVisibles: ['E121212121'],
    // Le clic sur l'option « réussit », mais le widget n'affiche jamais la
    // période demandée : sans la vérification, on relirait la MÊME liste en
    // la croyant d'une autre période.
    surChoix: () => {},
    periodeAffichee: 'Depuis les 6 derniers mois',
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => ldlc.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1);
  assert.match(journal.join('\n'), /n'a pas pu être affichée/);
  assert.match(journal.join('\n'), /INCOMPLET/);
});

test('LDLC : le renvoi vers l\'authentification au milieu du parcours arrête EN LE DISANT — l\'acquis est conservé', async () => {
  const chemin = fichierTemporaire(PDF_FACTICE);
  let page;
  const vue = {
    url: ldlc.URL_COMMANDES,
    lignes: [
      ligne('F202020202'),
      // La seconde ligne n'a plus son lien : le parcours rouvre « Détails »,
      // et c'est là que le site renvoie vers l'authentification.
      ligne('G303030303', { facture: false }),
      ligne('H404040404'),
    ],
    menu: [{ libelle: 'Depuis les 6 derniers mois', selectionnee: true }],
    facturesVisibles: ['F202020202', 'H404040404'],
    detailsOuvrables: false,
    surOuvrirDetail: () => {
      vue.url = 'https://secure2.ldlc.com/fr-fr/Login/Login?returnUrl=%2Ffr-fr%2FOrders';
    },
  };
  page = pageSimulee(vue, {
    surClic: () => {
      page.emettre('download', { path: async () => chemin, failure: async () => null });
    },
  });
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(page, () => ldlc.fetchInvoices({}, ctx));

  assert.equal(resultat.invoices.length, 1, 'ce qui a été lu avant le renvoi est conservé');
  assert.equal(resultat.invoices[0].remoteId, 'ldlc-F202020202');
  assert.deepEqual(page.clics, ['F202020202'],
    'le parcours s\'arrête au renvoi : la troisième commande n\'est pas tentée pour ce passage');
  assert.match(journal.join('\n'), /écran de connexion au milieu du\s+parcours/);
  assert.match(journal.join('\n'), /1\s+document\(s\) déjà lu\(s\) sont conservés/);
});

// ---------------------------------------------------------------------------
// 4. test() : le verdict léger compte ce que la page montre
// ---------------------------------------------------------------------------

test('LDLC : test() compte les commandes de la période par défaut, sans rien télécharger', async () => {
  const vue = {
    url: ldlc.URL_COMMANDES,
    lignes: [ligne('J505050505'), ligne('K606060606')],
    menu: [{ libelle: 'Depuis les 6 derniers mois', selectionnee: true }],
    facturesVisibles: [],
  };
  const page = pageSimulee(vue);
  const resultat = await surProfilSimule(page, () => ldlc.test({}, { userId: 1, log: () => {} }));

  assert.equal(resultat.ok, true);
  assert.equal(resultat.invoiceCount, 2);
  assert.deepEqual(page.clics, [], 'test() ne clique rien');
});
