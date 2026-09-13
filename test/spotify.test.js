'use strict';

/**
 * Connecteur Spotify (lot 36) — session capturée, reçus d'abonnement.
 *
 * Écrit sans compte réel (`initialStatus: pending`) : ces tests rejouent la
 * mécanique — relevé générique de l'historique des paiements, vérification
 * `%PDF-`, session expirée distinguée du relevé vide, couverture jamais
 * « complète » — contre une page et un contexte simulés. Ce qu'ils protègent :
 *
 *   1. **Seuls les liens de reçu sont pris** — la navigation du compte
 *      (« Paramètres de facturation », l'aide, la pagination qui ramène à la
 *      page) est écartée.
 *   2. **Une redirection vers la connexion — ou vers un challenge — est une
 *      session expirée**, jamais « aucun reçu ».
 *   3. **Ce qui descend est vérifié : `%PDF-`** — jamais de HTML déguisé.
 *   4. **La couverture n'est JAMAIS complète** : Spotify ne garde que 2 ans de
 *      reçus, et « tout l'historique » serait un mensonge (lot 33).
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const spotify = require('../server/connectors/available/spotify/connector');
const sessionState = require('../server/connectors/session-state');
const pageDocs = require('../server/connectors/documents-de-page');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4 reçu factice');
const PAS_UN_PDF = Buffer.from('<!doctype html><html>reçu à imprimer</html>');

/** Une session valide : un cookie spotify non expiré. */
function sessionValide() {
  return JSON.stringify({
    cookies: [{ name: 'sp_dc', value: 'x', domain: '.spotify.com', expires: -1 }],
  });
}

/**
 * Les liens qu'un historique des paiements rend : deux vrais reçus et trois
 * pièges — l'aide qui porte le mot « reçu », les paramètres de facturation,
 * et la pagination qui ramène à la page elle-même (la panne Hetzner).
 */
const LIENS = [
  {
    href: 'https://www.spotify.com/fr/account/payment-history/receipt/2026-03-8412',
    texte: 'Reçu',
    ligne: '12 mars 2026 · 10,99 €',
  },
  {
    href: 'https://www.spotify.com/fr/account/payment-history/receipt/2025-11-7301',
    texte: 'Reçu',
    ligne: '12 novembre 2025 · 10,99 €',
  },
  { href: 'https://support.spotify.com/fr/article/view-receipts/', texte: 'Consulter vos reçus', ligne: 'Aide' },
  { href: 'https://www.spotify.com/fr/account/subscription/', texte: 'Paramètres de facturation', ligne: 'Menu' },
  { href: 'https://www.spotify.com/fr/account/payment-history/?page=2', texte: 'Reçus suivants', ligne: 'Pagination' },
];

/** Une page Playwright simulée : URL finale et liens rendus par `releverLiens`. */
function fakePage({ url = spotify.URL_PAIEMENTS, liens = LIENS } = {}) {
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => url,
    evaluate: async (fn) => {
      if (fn === pageDocs.releverLiens) return liens;
      // `journaliserPage` : un état d'interface minimal.
      return { titre: 'Compte Spotify simulé', boutons: ['Profil', 'Abonnement'] };
    },
  };
}

/** Un contexte simulé : sa `request.get` rend ce qu'on lui dit. */
function fakeContext(reponse) {
  return {
    request: {
      get: async () => ({
        status: () => reponse.status ?? 200,
        ok: () => (reponse.status ?? 200) < 400,
        body: async () => reponse.body ?? PDF,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Le relevé écarte la navigation
// ---------------------------------------------------------------------------

test('seuls les liens de reçu sont relevés — aide, paramètres et pagination sont écartés', async () => {
  const journal = [];
  const { documents } = await spotify.relever(fakePage(), (m) => journal.push(m));

  assert.equal(documents.length, 2, 'deux reçus, pas les trois pièges');
  for (const doc of documents) {
    assert.match(doc.url, /\/receipt\//, 'chaque document est un lien de reçu');
  }
  assert.notEqual(documents[0].remoteId, documents[1].remoteId, 'deux reçus distincts');
  // La date et le montant viennent de la LIGNE du reçu.
  assert.equal(documents[0].issuedOn, '2026-03-12');
  assert.equal(documents[0].amount, '10,99 €');
});

test('une page muette est journalisée — jamais un échec silencieux', async () => {
  const journal = [];
  const { documents } = await spotify.relever(fakePage({ liens: [] }), (m) => journal.push(m));

  assert.equal(documents.length, 0);
  const tout = journal.join('\n');
  assert.match(tout, /aucun reçu atteint sur l'historique des paiements/);
  assert.match(tout, /libellés vus/, 'les libellés de la page sont journalisés pour le diagnostic');
});

// ---------------------------------------------------------------------------
// 2. Une redirection vers la connexion = session expirée
// ---------------------------------------------------------------------------

test('une redirection vers accounts.spotify.com/login est une session expirée', async () => {
  await assert.rejects(
    () => spotify.relever(fakePage({
      url: 'https://accounts.spotify.com/fr/login?continue=https%3A%2F%2Fwww.spotify.com%2Ffr%2Faccount',
    })),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /connexion à Spotify a expiré/);
      assert.match(err.message, /adresse e-mail/, 'le message dit comment se reconnecter');
      return true;
    }
  );
});

test('estPageAuthentification reconnaît login et challenge, pas un continue= piégé', () => {
  assert.equal(spotify.estPageAuthentification('https://accounts.spotify.com/fr/login'), true);
  assert.equal(spotify.estPageAuthentification('https://challenge.spotify.com/fr/challenge/abc'), true);
  assert.equal(spotify.estPageAuthentification(spotify.URL_PAIEMENTS), false);
  // Une page authentifiée dont la query CONTIENT le mot login n'est pas une
  // page de connexion : seul le chemin compte.
  assert.equal(
    spotify.estPageAuthentification('https://www.spotify.com/fr/account/payment-history/?continue=%2Flogin'),
    false
  );
});

// ---------------------------------------------------------------------------
// 3. Ce qui descend est vérifié : %PDF-
// ---------------------------------------------------------------------------

test('un reçu PDF descend ; une page à imprimer est refusée avec un message qui le dit', async () => {
  const doc = { remoteId: 'spotify-2026-03-8412', url: 'https://www.spotify.com/fr/account/payment-history/receipt/2026-03-8412' };

  const buffer = await spotify.telecharger(fakeContext({ body: PDF }), doc);
  assert.ok(buffer.subarray(0, 5).toString() === '%PDF-', 'un vrai PDF est rendu tel quel');

  await assert.rejects(
    () => spotify.telecharger(fakeContext({ body: PAS_UN_PDF }), doc),
    (err) => {
      assert.match(err.message, /n'est pas arrivé sous forme de PDF/);
      assert.match(err.message, /page à imprimer/);
      assert.equal(err.sessionExpired, undefined, 'ce n\'est pas une session expirée, c\'est un format');
      return true;
    }
  );
});

test('un 403 sur un reçu est une session expirée, pas une panne de téléchargement', async () => {
  const doc = { remoteId: 'spotify-2026-03-8412', url: 'https://www.spotify.com/fr/account/payment-history/receipt/2026-03-8412' };
  await assert.rejects(
    () => spotify.telecharger(fakeContext({ status: 403 }), doc),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. La couverture n'est jamais complète : Spotify ne garde que 2 ans
// ---------------------------------------------------------------------------

test('la couverture déclarée n\'est jamais complète, et dit pourquoi', () => {
  const declaration = spotify.couverture();
  assert.equal(declaration.complete, false, '« tout l\'historique » serait un mensonge : 2 ans au plus');
  assert.match(declaration.detail, /2 dernières années/, 'la limite de Spotify est nommée');
});

test('le message de relevé vide porte la limite des 2 ans et l\'angle mort des tiers', () => {
  const message = spotify.messageReleveVide([spotify.URL_PAIEMENTS]);
  assert.match(message, /aucun reçu n'a été reconnu/);
  assert.match(message, /2 dernières années/);
  assert.match(message, /opérateur|App Store/);
  assert.match(message, /signalez-le/i, 'le message dit quoi faire');
});

// ---------------------------------------------------------------------------
// 5. Le menu « Gérer » → « Afficher le reçu » (mesuré le 19/08/2026)
// ---------------------------------------------------------------------------

const UUID_RECU = '3fc0d4f8-1894-45ba-b9a7-efdda0393380';
const URL_RECU = `https://www.spotify.com/fr/account/payment-history/receipt/${UUID_RECU}`;

/**
 * Une page simulée sur le parcours mesuré : des lignes de paiement SANS lien
 * direct, chacune avec son bouton « Gérer » dont le menu se pilote par le test.
 */
function fakePageAvecMenus({
  url = spotify.URL_PAIEMENTS,
  lignesGerer = [{ texte: '12 août 2026 Abonnement Premium 10,99 €' }],
  menus = [{ href: URL_RECU }],
  urlApresClicEntree = null,
} = {}) {
  let urlCourante = url;
  let menuOuvert = -1;
  const clics = [];
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    goBack: async () => { urlCourante = url; clics.push('retour'); },
    keyboard: { press: async () => {} },
    url: () => urlCourante,
    evaluate: async (fn) => {
      if (fn === pageDocs.releverLiens) return [];
      if (fn === spotify.LIRE_LIGNES_GERER) return lignesGerer;
      if (fn === spotify.LIRE_MENU_RECU) return menus[menuOuvert] ?? { libelles: [] };
      return { titre: 'Compte Spotify simulé', boutons: [] };
    },
    locator: (sel) => ({
      nth: (i) => ({
        click: async () => {
          assert.equal(sel, spotify.SELECTEUR_BOUTON_GERER);
          menuOuvert = i;
          clics.push(`gerer:${i}`);
        },
      }),
      first: () => ({
        click: async () => {
          assert.equal(sel, spotify.SELECTEUR_ENTREE_RECU);
          clics.push('entree');
          if (urlApresClicEntree) urlCourante = urlApresClicEntree;
        },
      }),
    }),
    _clics: clics,
  };
}

test('le reçu s\'atteint par le menu « Gérer » → « Afficher le reçu », uuid et date compris', async () => {
  const journal = [];
  const page = fakePageAvecMenus();
  const { documents } = await spotify.relever(page, (m) => journal.push(m));

  assert.equal(documents.length, 1, 'la ligne sans lien direct livre son reçu par le menu');
  const doc = documents[0];
  assert.equal(doc.remoteId, UUID_RECU, 'le remoteId est l\'uuid du reçu');
  assert.equal(doc.url, URL_RECU);
  assert.equal(doc.issuedOn, '2026-08-12', 'la date vient de la ligne de paiement');
  // Le nom de fichier : spotify_<AAAA-MM>_<uuid8>.pdf.
  assert.equal(
    spotify.nomFichier({ issuedOn: doc.issuedOn, remoteId: doc.fileRef }),
    'spotify_2026-08_3fc0d4f8.pdf'
  );
  assert.deepEqual(page._clics, ['gerer:0'], 'un lien dans le menu suffit : aucun clic d\'entrée, aucun retour');
});

test('repli mesurable : une entrée qui n\'est pas un lien est cliquée, l\'adresse d\'arrivée est lue', async () => {
  const page = fakePageAvecMenus({
    menus: [{ cliquer: true }],
    urlApresClicEntree: URL_RECU,
  });
  const { documents } = await spotify.relever(page, () => {});

  assert.equal(documents.length, 1);
  assert.equal(documents[0].remoteId, UUID_RECU, 'l\'uuid vient de l\'adresse d\'arrivée');
  assert.ok(page._clics.includes('entree'), 'l\'entrée du menu a été cliquée');
  assert.ok(page._clics.includes('retour'), 'la page revient sur l\'historique pour la ligne suivante');
  assert.equal(page.url(), spotify.URL_PAIEMENTS);
});

test('un menu sans « Afficher le reçu » : le journal le dit, rien n\'est inventé', async () => {
  const journal = [];
  const page = fakePageAvecMenus({
    lignesGerer: [{ texte: '12 août 2026 Abonnement Premium 10,99 €' }],
    menus: [{ libelles: ['Modifier le mode de paiement', 'Annuler l\'abonnement'] }],
  });
  const { documents } = await spotify.relever(page, (m) => journal.push(m));

  assert.equal(documents.length, 0, 'aucun document n\'est fabriqué à la place du reçu manquant');
  const tout = journal.join('\n');
  assert.match(tout, /n'offre pas\s+« Afficher le reçu »/);
  assert.match(tout, /Modifier le mode de paiement/, 'le journal dit ce que le menu proposait à la place');
});

test('un reçu vu par lien direct ET par menu ne fait qu\'un document', async () => {
  const page = fakePageAvecMenus();
  // Le même reçu arrive AUSSI en lien direct : releverLiens le rend.
  page.evaluate = ((original) => async (fn) => {
    if (fn === pageDocs.releverLiens) {
      return [{ href: URL_RECU, texte: 'Reçu', ligne: '12 août 2026 · 10,99 €' }];
    }
    return original(fn);
  })(page.evaluate);

  const { documents } = await spotify.relever(page, () => {});
  assert.equal(documents.length, 1, 'les deux voies mènent au même document, dédoublonné');
});

// ---------------------------------------------------------------------------
// 6. La session est contrôlée avant tout
// ---------------------------------------------------------------------------

test('une session absente ou vide est refusée avant d\'ouvrir un navigateur', () => {
  assert.throws(() => spotify.lireSession({}), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  assert.throws(() => spotify.lireSession({ session: '{"cookies":[]}' }), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  const etat = spotify.lireSession({ session: sessionValide() });
  assert.ok(Array.isArray(etat.cookies), 'l\'état de session est rendu tel quel');
  assert.equal(sessionState.validate(sessionValide()).ok, true);
});
