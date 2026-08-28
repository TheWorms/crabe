'use strict';

/**
 * Lot 52 — Decathlon trouve sa liste, Électro Dépôt dit son vide.
 *
 * Decathlon (mesuré le 24/08/2026 sur une session réelle) : l'historique vit
 * sur /account/myPurchase — le lot 48 visait le tableau de bord et comptait 0
 * à tort. La liste est peinte en JavaScript (on attend un marqueur, on ne
 * compte jamais dans le vide), et AUCUN document n'est servi directement :
 * « Demander ma facture » (commande en ligne) DÉPOSE une demande chez le
 * vendeur dès le clic, « Télécharger ma facture » (achat en magasin) ouvre un
 * formulaire d'informations client à valider. Le connecteur compte, prouve,
 * et DIT ce que le site propose — il ne clique rien.
 *
 * Électro Dépôt (mesuré le 24/08/2026) : l'espace client réel vit sur
 * /customer/account/#/order ; le compte n'a AUCUNE commande en ligne (les
 * achats en magasin ne remontent pas sur le site) — le comptage 0 est EXACT
 * et se dit comme un fait, pas comme une panne. Pas de parcours écrit : rien
 * ne pourrait le prouver.
 *
 * Toutes les valeurs sont INVENTÉES : la forme du réel, jamais le réel (§0ter).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const profilMarchand = require('../server/connectors/profil-marchand');
const decathlon = require('../server/connectors/available/decathlon/connector');
const electro = require('../server/connectors/available/electro-depot/connector');

// ---------------------------------------------------------------------------
// Fabriques
// ---------------------------------------------------------------------------

/**
 * Une page simulée pour les deux connecteurs. `evaluate` est discriminé sur
 * la FORME de l'argument : `attendreLaListePeinte` ({selPeinture}),
 * `compterParNature` ({selArticle}), `attendreLEspacePeint` ({motifPeinture}),
 * `etatVideAffiche` ({motifVide}), `photographier` ({motif, selecteur}).
 */
function pageSimulee(vue) {
  return {
    url: () => vue.url,
    waitForTimeout: async () => { await new Promise((r) => { setImmediate(r); }); },
    waitForLoadState: async () => {},
    locator: () => ({ count: async () => 0 }),
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object') {
        if ('selPeinture' in arg) return vue.peinte !== false;
        if ('selArticle' in arg) return vue.natures || null;
        if ('motifPeinture' in arg) return vue.peinte !== false;
        if ('motifVide' in arg) return vue.vide === true;
        if ('motif' in arg && 'selecteur' in arg) {
          return {
            url: vue.url,
            boutonSeConnecter: false,
            reperes: vue.reperes || 0,
            libelles: vue.libelles || [],
          };
        }
      }
      return false;
    },
  };
}

async function surProfilSimule(page, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(page, {});
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

function contexteEnregistreur() {
  const journal = [];
  const preuves = [];
  return {
    journal,
    preuves,
    ctx: {
      userId: 1,
      log: (m) => journal.push(m),
      preuveDeListe: (p) => preuves.push(p),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Decathlon : la liste est au bon endroit, et elle attend d'être peinte
// ---------------------------------------------------------------------------

test('Decathlon : le connecteur vise l\'historique des achats — plus jamais le tableau de bord', () => {
  assert.equal(decathlon.URL_COMMANDES, 'https://www.decathlon.fr/account/myPurchase',
    'l\'historique mesuré le 24/08/2026 — /account/dashboard ne liste rien et comptait 0 à tort');
  assert.ok(decathlon.CHEMIN_LISTE.test('https://www.decathlon.fr/account/myPurchase'));
  assert.equal(decathlon.CHEMIN_LISTE.test('https://www.decathlon.fr/account/dashboard'), false,
    'le tableau de bord ne doit plus passer pour la liste');
  assert.equal(decathlon.SELECTEUR_REPERE, 'article.my-purchase',
    'chaque achat est un article.my-purchase (relevé le 24/08/2026)');
});

test('Decathlon : l\'historique est compté par nature, et le journal dit ce que le site propose — sans rien cliquer', async () => {
  const vue = {
    url: decathlon.URL_COMMANDES,
    reperes: 2,
    natures: { total: 2, enLigne: 1, enMagasin: 1 },
  };
  const { ctx, journal, preuves } = contexteEnregistreur();

  const resultat = await surProfilSimule(pageSimulee(vue), () => decathlon.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].liste, decathlon.URL_COMMANDES);
  assert.equal(preuves[0].elements, 2);
  assert.deepEqual(resultat.invoices, [], 'aucun document n\'est servi directement : rien à descendre');
  assert.match(resultat.aucunDocument, /ne sert pas de facture directement/,
    'l\'écran dit le fait mesuré, pas « aucune nouvelle facture »');
  assert.match(resultat.aucunDocument, /2 achat\(s\) — 1 commande\(s\) en ligne, 1 en magasin/);

  const lignes = journal.join('\n');
  assert.match(lignes, /2 achat\(s\) sur l'historique — 1 commande\(s\)\s+en ligne, 1 achat\(s\) en magasin/);
  assert.match(lignes, /Demander ma facture(.|\n)*crabe ne\s+déclenche pas/,
    'le journal dit pourquoi crabe ne clique pas la demande — elle part chez le vendeur');
  assert.match(lignes, /formulaire d'informations à valider(.|\n)*crabe ne remplit pas/);
});

test('Decathlon : une liste jamais peinte ARRÊTE en le disant — compter une coquille vide dirait 0 à tort', async () => {
  const vue = { url: decathlon.URL_COMMANDES, peinte: false, reperes: 0 };
  const { ctx, preuves } = contexteEnregistreur();

  await assert.rejects(
    () => surProfilSimule(pageSimulee(vue), () => decathlon.fetchInvoices({}, ctx)),
    /n'a pas affiché votre historique/
  );
  assert.equal(preuves.length, 0, 'aucune preuve de liste sur une liste jamais montrée');
});

test('Decathlon : test() compte sans conclure au-delà de ce que la mesure autorise', async () => {
  const vue = { url: decathlon.URL_COMMANDES, reperes: 3, natures: { total: 3, enLigne: 3, enMagasin: 0 } };
  const resultat = await surProfilSimule(pageSimulee(vue),
    () => decathlon.test({}, { userId: 1, log: () => {} }));
  assert.equal(resultat.ok, true);
  assert.equal(resultat.invoiceCount, 3);
  assert.match(resultat.message, /ne sert pas de facture directement/);
});

// ---------------------------------------------------------------------------
// 2. Électro Dépôt : la bonne adresse, et le vide dit comme un fait
// ---------------------------------------------------------------------------

test('Électro Dépôt : l\'espace client réel est visé, et la page de connexion ne passe pas pour la liste', () => {
  assert.equal(electro.URL_COMMANDES, 'https://www.electrodepot.fr/customer/account/#/order',
    'l\'adresse mesurée le 24/08/2026 — /sales/order/history répond mais ne liste rien');
  assert.ok(electro.CHEMIN_LISTE.test('https://www.electrodepot.fr/customer/account/#/order'));
  assert.ok(electro.CHEMIN_LISTE.test('https://www.electrodepot.fr/customer/account'));
  // Le piège du préfixe : /customer/account/login/ commence pareil — le
  // prendre pour la liste ferait dire « connecté » à un écran de connexion.
  assert.equal(electro.CHEMIN_LISTE.test('https://www.electrodepot.fr/customer/account/login/'), false,
    'la page de connexion ne doit JAMAIS matcher le chemin de la liste');
});

test('Électro Dépôt : un compte sans commande en ligne se dit comme un FAIT — comptage 0 exact, pas une panne', async () => {
  const vue = { url: electro.URL_COMMANDES, reperes: 0, vide: true };
  const { ctx, journal, preuves } = contexteEnregistreur();

  const resultat = await surProfilSimule(pageSimulee(vue), () => electro.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].elements, 0);
  assert.deepEqual(resultat.invoices, []);
  assert.match(resultat.aucunDocument, /aucune commande en ligne/,
    'l\'écran dit le fait : les achats en magasin ne remontent pas sur le site');
  assert.match(resultat.aucunDocument, /pas une erreur/);
  assert.match(journal.join('\n'), /comptage 0 est exact/);
});

test('Électro Dépôt : un compte garni un jour retombera sur l\'ébauche honnête — parcours à écrire, et dit', async () => {
  const vue = { url: electro.URL_COMMANDES, reperes: 2, vide: false, libelles: [] };
  const { ctx, journal } = contexteEnregistreur();

  const resultat = await surProfilSimule(pageSimulee(vue), () => electro.fetchInvoices({}, ctx));

  assert.deepEqual(resultat.invoices, []);
  assert.match(resultat.aucunDocument, /n'est pas encore écrite dans crabe/);
  assert.match(journal.join('\n'), /jamais\s+.{0,30}vérifié sur un compte réel/,
    'le compte de repères reste un indice tant qu\'aucun compte garni ne l\'a prouvé');
});

test('Électro Dépôt : test() sur un compte vide dit « aucune commande en ligne »', async () => {
  const vue = { url: electro.URL_COMMANDES, reperes: 0, vide: true };
  const resultat = await surProfilSimule(pageSimulee(vue),
    () => electro.test({}, { userId: 1, log: () => {} }));
  assert.equal(resultat.ok, true);
  assert.equal(resultat.invoiceCount, 0);
  assert.match(resultat.message, /n'affiche aucune commande en ligne/);
});
