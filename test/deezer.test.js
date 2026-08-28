'use strict';

/**
 * Connecteur Deezer (lot 37) — la page RÉELLE, mesurée le 18/08/2026 en
 * session ouverte en production : compte → bouton « Gérer mon abonnement » →
 * nouvel onglet payment.deezer.com, bloc #subscription_invoices.
 *
 * Ce que ces tests protègent :
 *
 *   1. **Les lignes masquées comptent** : 18 lignes sur 21 portent
 *      `aria-hidden="true"` (repli « voir plus ») — un relevé du rendu
 *      visible verrait 3 paiements sur 21. Si quelqu'un filtre les masquées,
 *      ces tests tombent.
 *   2. **L'alerte bancaire fantôme ne signale rien** : `#payment-alert` est
 *      présent EN PERMANENCE, masqué, parent `data-has-error="false"`. Seul
 *      `data-has-error="true"` signale un incident réel.
 *   3. **Aucun PDF n'existe, et c'est dit ligne par ligne** — mesuré :
 *      le reçu est une page HTML « Your receipt », re-mesurée à chaque
 *      exécution pour voir si Deezer change.
 *   4. **Le jeton `cip=` ne sort jamais** : ni journal, ni message.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const deezer = require('../server/connectors/available/deezer/connector');
const preuve = require('../server/connectors/preuve-connexion');

// ---------------------------------------------------------------------------
// Fixtures — les formes MESURÉES le 18/08/2026
// ---------------------------------------------------------------------------

const JETON = 'JETON-CIP-QUI-NE-DOIT-JAMAIS-SORTIR';
const LIEN_RECU = `https://payment.deezer.com/?cip=${JETON}`;

/** 21 lignes comme mesurées : 3 visibles, 18 repliées sous « voir plus ». */
const LIGNES = [
  { ariaHidden: 'false', texte: 'Deezer Premium 11,99 € 21/02/2026', prix: '11,99 €', lienRecu: LIEN_RECU },
  { ariaHidden: 'false', texte: 'Deezer Premium 9,99 € 16/12/2016', prix: '9,99 €', lienRecu: LIEN_RECU },
  { ariaHidden: 'false', texte: 'Deezer Premium 9,99 € 16/11/2016', prix: '9,99 €', lienRecu: LIEN_RECU },
  ...Array.from({ length: 16 }, (_, i) => ({
    ariaHidden: 'true',
    texte: `Deezer Premium 9,99 € ${String(1 + (i % 12)).padStart(2, '0')}/0${1 + (i % 9)}/201${4 + (i % 3)}`,
    prix: '9,99 €',
    lienRecu: LIEN_RECU,
  })),
  { ariaHidden: 'true', texte: 'Deezer Web 4,99 € 17/02/2013', prix: '4,99 €', lienRecu: LIEN_RECU },
  { ariaHidden: 'true', texte: 'Deezer Web 4,99 € 15/01/2013', prix: '4,99 €', lienRecu: LIEN_RECU },
];

/** L'alerte FANTÔME mesurée sur une page saine : texte présent, erreur fausse. */
const ALERTE_SAINE = {
  texte: 'An error occurred with your bank details. Please check they are correct.',
  dataHasError: 'false',
};

const PDF = Buffer.from('%PDF-1.4 facture factice');
const HTML_RECU = Buffer.from('<!doctype html><title>Your receipt</title>');

/** Une page Playwright simulée sur le parcours compte → paiements. */
function fakePage({
  urlDepart = deezer.URL_COMPTE,
  urlApresClic = LIEN_RECU,
  boutonPresent = true,
  croixPresente = true,
  surPaiements = true,
  lignes = LIGNES,
  alerte = ALERTE_SAINE,
  titre = 'Deezer',
} = {}) {
  let urlCourante = urlDepart;
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => urlCourante,
    locator: (sel) => ({
      first() { return this; },
      count: async () => {
        if (sel === deezer.SELECTEUR_BOUTON_ABONNEMENT) return boutonPresent ? 1 : 0;
        if (sel === deezer.SELECTEUR_CROIX_INCITATION) return croixPresente ? 1 : 0;
        return 0;
      },
      click: async () => {
        if (sel === deezer.SELECTEUR_BOUTON_ABONNEMENT) urlCourante = urlApresClic;
      },
    }),
    evaluate: async (fn) => {
      if (fn === deezer.EXTRAIRE_LIGNES) return lignes;
      if (fn === deezer.LIRE_ALERTE) return alerte;
      if (String(fn).includes('subscription_invoices')) return surPaiements;
      return { titre, boutons: ['Payment history', 'Switch accounts'] };
    },
  };
}

/** Un contexte simulé : pas de nouvel onglet, une réponse de reçu sur demande. */
function fakeContext(reponse = { type: 'text/html; charset=UTF-8', body: HTML_RECU }) {
  return {
    waitForEvent: async () => { throw new Error('aucun onglet ne vient'); },
    request: {
      get: async () => ({
        status: () => 200,
        ok: () => true,
        headers: () => ({ 'content-type': reponse.type }),
        body: async () => reponse.body,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Le chemin d'entrée et ses trois sorties dites
// ---------------------------------------------------------------------------

test('une redirection vers la connexion est une session expirée, dite comme telle', async () => {
  await assert.rejects(
    () => deezer.relever(fakePage({ urlDepart: 'https://account.deezer.com/fr/login/' }), fakeContext()),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /connexion à Deezer a expiré/);
      return true;
    }
  );
});

test('le bouton « Gérer mon abonnement » introuvable : un message qui dit où on était', async () => {
  const journal = [];
  await assert.rejects(
    () => deezer.relever(fakePage({ boutonPresent: false }), fakeContext(), (m) => journal.push(m)),
    (err) => {
      assert.equal(err.sessionExpired, undefined);
      assert.match(err.message, /bouton « Gérer mon abonnement »/);
      assert.match(err.message, /signalez-le/i);
      return true;
    }
  );
  assert.match(journal.join('\n'), /libellés vus/);
});

test('la page atteinte sans historique des paiements : dite, avec son adresse SANS jeton', async () => {
  await assert.rejects(
    () => deezer.relever(fakePage({ surPaiements: false }), fakeContext()),
    (err) => {
      assert.match(err.message, /n'est pas l'historique des paiements/);
      assert.match(err.message, /adresse servie est https:\/\/payment\.deezer\.com\//);
      assert.ok(!err.message.includes(JETON), 'le jeton cip= ne sort jamais dans un message');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 2. Les lignes masquées comptent — le test qui mord
// ---------------------------------------------------------------------------

test('les 21 lignes sont prises, dont les 18 repliées sous « voir plus »', async () => {
  const journal = [];
  const releve = await deezer.relever(fakePage(), fakeContext(), (m) => journal.push(m));

  assert.equal(releve.lignes.length, 21, 'toutes les lignes du DOM, jamais le seul rendu visible');
  assert.equal(releve.paiements.length, 21);
  // Une ligne MASQUÉE doit être là comme les autres : si quelqu'un filtre
  // les aria-hidden, la plus ancienne (17/01/2013, repliée) disparaît et ce
  // test tombe.
  assert.ok(
    releve.paiements.some((p) => p.date === '2013-01-15'),
    'le paiement replié du 15/01/2013 doit être dans le relevé'
  );
  assert.match(journal.join('\n'), /21 paiement\(s\) vu\(s\) \(dont 18 replié\(s\)/);
});

test('les dates JJ/MM/AAAA deviennent ISO, sans jamais lever', () => {
  assert.equal(deezer.dateSlashEnIso('Deezer Premium 11,99 € 21/02/2026'), '2026-02-21');
  assert.equal(deezer.dateSlashEnIso('15/01/2013'), '2013-01-15');
  assert.equal(deezer.dateSlashEnIso('gribouillis'), null);
});

// ---------------------------------------------------------------------------
// 3. L'alerte bancaire fantôme — le test qui mord
// ---------------------------------------------------------------------------

test('une page saine avec le bloc d\'alerte masqué ne produit AUCUN signalement bancaire', async () => {
  const journal = [];
  const releve = await deezer.relever(fakePage(), fakeContext(), (m) => journal.push(m));
  // Le texte d'erreur EST dans le DOM (fixture mesurée) : seul
  // data-has-error tranche. Si quelqu'un conclut sur le texte, ce test tombe.
  assert.equal(releve.incident, null);
  assert.doesNotMatch(journal.join('\n'), /moyen de paiement|bancaire/);
});

test('data-has-error="true" : l\'incident est signalé, en français, sans jargon', async () => {
  const alerte = { ...ALERTE_SAINE, dataHasError: 'true' };
  const releve = await deezer.relever(fakePage({ alerte }), fakeContext());
  assert.match(releve.incident, /problème avec votre moyen de paiement/);
  assert.match(releve.incident, /crabe ne peut pas le faire pour vous/);
  assert.doesNotMatch(releve.incident, /bank details/, 'le texte anglais du site ne sort pas tel quel');

  assert.equal(deezer.incidentBancaire(null), null);
  assert.equal(deezer.incidentBancaire(ALERTE_SAINE), null);
});

// ---------------------------------------------------------------------------
// 4. L'impression du reçu français (lot 41) — le cœur, sans navigateur
// ---------------------------------------------------------------------------

/** Un PDF « rendu » plausible : signature %PDF- et un poids au-dessus du seuil. */
const PDF_RENDU = Buffer.concat([
  Buffer.from('%PDF-1.4 reçu imprimé '),
  Buffer.alloc(deezer.SEUIL_PDF_OCTETS + 2_000, 0x20),
]);

/** Le PDF d'un rendu BLANC : signature correcte, poids d'une page vide. */
const PDF_BLANC = Buffer.from('%PDF-1.4 page vide');

/**
 * Une page de REÇU simulée : les lectures successives de LIRE_RECU se
 * pilotent par le scénario (anglais d'abord, français après la bascule…).
 */
function fakePageRecu(scenario) {
  let lecture = 0;
  const gotos = [];
  return {
    goto: async (url) => { gotos.push(url); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://payment.deezer.com/',
    evaluate: async (fn) => {
      if (fn === deezer.LIRE_RECU) {
        return scenario.lectures[Math.min(lecture++, scenario.lectures.length - 1)];
      }
      return null;
    },
    pdf: async (options) => { scenario.optionsPdf = options; return scenario.pdf ?? PDF_RENDU; },
    close: async () => { scenario.fermee = true; },
    _gotos: gotos,
  };
}

/** Un contexte d'impression : `newPage()` rend la page de reçu du scénario. */
function fakeContexteImpression(scenario) {
  return { newPage: async () => fakePageRecu(scenario) };
}

const RECU_FRANCAIS = { numero: 'GGL_I_0123456789', aTotalTTC: true, urlFrancais: null };

test('un reçu français s\'imprime : numéro lu dans la SOURCE, A4, fonds compris', async () => {
  const scenario = { lectures: [RECU_FRANCAIS] };
  const resultat = await deezer.imprimerRecu(fakeContexteImpression(scenario), LIEN_RECU);

  assert.equal(resultat.ok, true);
  assert.equal(resultat.numero, 'GGL_I_0123456789', 'le remoteId est le numéro de reçu');
  assert.equal(resultat.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(resultat.buffer.length >= deezer.SEUIL_PDF_OCTETS);
  // C'est bien le geste du bouton « Imprimer » : A4, fonds imprimés.
  assert.equal(scenario.optionsPdf.format, 'A4');
  assert.equal(scenario.optionsPdf.printBackground, true);
  assert.equal(scenario.fermee, true, 'la page du reçu est refermée');
});

test('un reçu servi en anglais bascule vers la version française avant l\'impression', async () => {
  const journal = [];
  const urlFrancais = 'https://payment.deezer.com/?cip=AUTRE-JETON-FRANCAIS';
  const scenario = {
    lectures: [
      { numero: 'GGL_I_0123456789', aTotalTTC: false, urlFrancais },
      RECU_FRANCAIS,
    ],
  };
  const pageTenue = [];
  const contexte = { newPage: async () => { const p = fakePageRecu(scenario); pageTenue.push(p); return p; } };
  const resultat = await deezer.imprimerRecu(contexte, LIEN_RECU, (m) => journal.push(m));

  assert.equal(resultat.ok, true);
  assert.equal(pageTenue[0]._gotos.length, 2, 'deux navigations : le reçu, puis sa version française');
  assert.equal(pageTenue[0]._gotos[1], urlFrancais);
  const texte = journal.join('\n');
  assert.match(texte, /bascule vers la version française/);
  assert.ok(!texte.includes('AUTRE-JETON-FRANCAIS'), 'le jeton de la version française ne sort pas');
});

test('pas de version française atteignable : rien n\'est déposé, la raison est dite', async () => {
  const scenario = {
    lectures: [{ numero: 'GGL_I_0123456789', aTotalTTC: false, urlFrancais: null }],
  };
  const resultat = await deezer.imprimerRecu(fakeContexteImpression(scenario), LIEN_RECU);
  assert.equal(resultat.ok, false);
  assert.match(resultat.raison, /version française/);
  assert.match(resultat.raison, /rien n'est déposé à sa place/);
});

test('une page de reçu sans numéro lisible : rien n\'est déposé, la raison est dite', async () => {
  const scenario = { lectures: [{ numero: null, aTotalTTC: true, urlFrancais: null }] };
  const resultat = await deezer.imprimerRecu(fakeContexteImpression(scenario), LIEN_RECU);
  assert.equal(resultat.ok, false);
  assert.match(resultat.raison, /Numéro de reçu/);
});

test('un rendu blanc est un ÉCHEC dit à voix haute, jamais un dépôt', async () => {
  const scenario = { lectures: [RECU_FRANCAIS], pdf: PDF_BLANC };
  await assert.rejects(
    () => deezer.imprimerRecu(fakeContexteImpression(scenario), LIEN_RECU),
    (err) => {
      assert.match(err.message, /pas produit un PDF exploitable/);
      assert.match(err.message, /octets rendus/);
      return true;
    }
  );
});

test('ligne par ligne : imprimé, déjà connu, ou sans reçu — et le jeton cip= ne sort jamais', async () => {
  const journal = [];
  const releve = await deezer.relever(fakePage(), fakeContext(), (m) => journal.push(m));

  // Trois destins : la 1re ligne s'imprime, la 2e est déjà connue, et une
  // ligne SANS lien ni bouton n'offre rien à imprimer.
  releve.paiements[2].lienRecu = null;
  releve.paiements[2].boutonRecu = false;
  let compteur = 0;
  const contexte = {
    newPage: async () => fakePageRecu({
      lectures: [{ numero: `GGL_I_${String(++compteur).padStart(4, '0')}`, aTotalTTC: true, urlFrancais: null }],
    }),
  };
  const { invoices, sansLien } = await deezer.imprimerLesRecus(releve, contexte, {
    connus: new Set(['GGL_I_0002']),
    log: (m) => journal.push(m),
  });

  assert.equal(invoices.length, 19, '21 lignes − 1 déjà connue − 1 sans reçu');
  assert.equal(sansLien, 1);
  assert.equal(invoices[0].remoteId, 'GGL_I_0001');
  // Le nom du fichier : deezer_<AAAA-MM>_<numéro>.pdf, période de la LIGNE.
  assert.equal(invoices[0].filename, 'deezer_2026-02_GGL_I_0001.pdf');
  const texte = journal.join('\n');
  assert.match(texte, /reçu GGL_I_0001 .* imprimé en PDF, version française/);
  assert.match(texte, /reçu GGL_I_0002 déjà récupéré/);
  assert.match(texte, /n'offre aucun reçu à imprimer/);
  assert.ok(!texte.includes(JETON), 'le jeton ne va pas au journal');
  assert.ok(!texte.includes('cip='), 'même le nom du paramètre reste dehors');
});

test('le repli mesurable : l\'icône cliquée, l\'adresse d\'arrivée lue, le retour fait', async () => {
  const clics = [];
  let urlCourante = 'https://payment.deezer.com/liste';
  const cible = {
    url: () => urlCourante,
    locator: () => ({
      nth: () => ({ locator: () => ({ first: () => ({ click: async () => { urlCourante = LIEN_RECU; clics.push('icone'); } }) }) }),
    }),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    goBack: async () => { urlCourante = 'https://payment.deezer.com/liste'; clics.push('retour'); },
  };
  const lien = await deezer.lienParClic(cible, 0);
  assert.equal(lien, LIEN_RECU, 'l\'adresse d\'arrivée est le lien du reçu');
  assert.deepEqual(clics, ['icone', 'retour']);
  assert.equal(cible.url(), 'https://payment.deezer.com/liste', 'la liste est retrouvée');
});

test('le type du reçu est re-mesuré : HTML aujourd\'hui, et si un PDF descend un jour, c\'est dit', async () => {
  const journal = [];
  const html = await deezer.mesurerTypeDeRecu(fakeContext(), LIEN_RECU, (m) => journal.push(m));
  assert.equal(html.estPdf, false);
  assert.match(html.contentType, /text\/html/);
  assert.equal(journal.length, 0, 'un reçu HTML est le cas mesuré : rien à signaler');

  const pdf = await deezer.mesurerTypeDeRecu(
    fakeContext({ type: 'application/pdf', body: PDF }),
    LIEN_RECU,
    (m) => journal.push(m)
  );
  assert.equal(pdf.estPdf, true);
  assert.match(journal.join('\n'), /Deezer a changé/);
  assert.match(journal.join('\n'), /[Ss]ignalez-le/);

  assert.equal(await deezer.mesurerTypeDeRecu(fakeContext(), null), null);
});

// ---------------------------------------------------------------------------
// 5. Le marqueur de compte du contrôle strict (phase A)
// ---------------------------------------------------------------------------

test('le bouton de profil Deezer est une preuve forte — mesuré présent connecté, absent anonyme', () => {
  assert.ok(
    preuve.PREUVES_FORTES.includes('[data-testid="topbar-profile"]'),
    'sans ce marqueur, la politique stricte refuserait toute session Deezer valide'
  );
});

// ---------------------------------------------------------------------------
// 6. Divers gardés du lot 36
// ---------------------------------------------------------------------------

test('les adresses d\'authentification sont reconnues au chemin, jamais au domaine', () => {
  assert.equal(deezer.estPageAuthentification('https://account.deezer.com/fr/login/'), true);
  assert.equal(deezer.estPageAuthentification('https://account.deezer.com/fr/signup/?origin=x'), true);
  assert.equal(deezer.estPageAuthentification(deezer.URL_COMPTE), false);
  assert.equal(deezer.estPageAuthentification('https://www.deezer.com/fr/account?back=%2Flogin'), false);
});

test('une session absente ou vide est refusée avant d\'ouvrir un navigateur', () => {
  assert.throws(() => deezer.lireSession({}), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  const etat = deezer.lireSession({
    session: JSON.stringify({
      cookies: [{ name: 'sid', value: 'x', domain: '.deezer.com', expires: -1 }],
    }),
  });
  assert.ok(Array.isArray(etat.cookies));
});

test('le message de relevé vide distingue les deux explications et demande le signalement', () => {
  const message = deezer.messageReleveVide([deezer.URL_COMPTE]);
  assert.match(message, /aucun paiement n'a été reconnu/);
  assert.match(message, /signalez-le/i);
});
