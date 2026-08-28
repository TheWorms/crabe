'use strict';

/**
 * Connecteur SoundCloud (lot 37) — la page RÉELLE, mesurée le 18/08/2026 en
 * session ouverte en production : soundcloud.com/you/subscriptions, section
 * « Historique des achats ».
 *
 * Ce que ces tests protègent :
 *
 *   1. **La distinction lien-PDF / bouton-modale ne se perd jamais** : une
 *      ligne avec `a.sc-button[href]` est une facture PDF ; une ligne avec
 *      `button.consumerSubscriptionReceiptModalButton` n'a AUCUN PDF
 *      atteignable (mesuré au clic : zéro requête, zéro lien) et le connecteur
 *      le dit ligne par ligne, sans jamais déposer autre chose.
 *   2. **L'essai gratuit n'est jamais un échec** : la ligne du 5 août 2016 n'a
 *      ni prix ni bouton — ce n'est pas un document manquant.
 *   3. **Le jeton `?ht=` du lien Recurly ne sort jamais** : ni identifiant, ni
 *      nom de fichier, ni journal.
 *   4. **Les trois issues de la page ne se confondent jamais** (session
 *      expirée / adresse morte / relevé) — le piège du 404, partagé avec Qobuz.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const soundcloud = require('../server/connectors/available/soundcloud/connector');
const sessionState = require('../server/connectors/session-state');
const preuve = require('../server/connectors/preuve-connexion');

// ---------------------------------------------------------------------------
// Fixtures — les formes MESURÉES le 18/08/2026
// ---------------------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4 facture factice');
const PAS_UN_PDF = Buffer.from('<!doctype html><html>reçu à consulter</html>');
const JETON = 'JETON-QUI-NE-DOIT-JAMAIS-SORTIR';

/** La seule ligne du faux historique à porter une facture PDF : un abonnement annuel. */
const LIGNE_PDF = {
  date: '15 janv. 2023',
  libelle: 'Yearly Artist Pro plan',
  prix: '99,00 €',
  texte: '15 janv. 2023 Yearly Artist Pro plan 99,00 € Afficher le reçu',
  lienRecu: `https://soundcloud.recurly.com/account/invoices/FR26322.pdf?ht=${JETON}`,
  texteLien: 'Afficher le reçu',
  boutonModale: false,
};

/** Le cas majoritaire (24 lignes sur 26) : reçu en modale, aucun PDF. */
const LIGNE_MODALE = {
  date: '23 mars 2023',
  libelle: 'Abonnement SoundCloud Go+ mensuel',
  prix: '4,99 €',
  texte: '23 mars 2023 Abonnement SoundCloud Go+ mensuel 4,99 € Afficher le reçu',
  lienRecu: null,
  texteLien: '',
  boutonModale: true,
};

/** La dernière ligne mesurée : essai gratuit, ni prix ni bouton. */
const LIGNE_ESSAI = {
  date: '5 août 2016',
  libelle: 'Monthly Go Plus plan',
  prix: '',
  texte: '5 août 2016 Monthly Go Plus plan Essai gratuit',
  lienRecu: null,
  texteLien: '',
  boutonModale: false,
};

/** Piège lot 33 : un lien dont le texte est un ENVOI d'e-mail. Jamais pris. */
const LIGNE_ENVOI_EMAIL = {
  date: '21 févr. 2023',
  libelle: 'Abonnement SoundCloud Go+ mensuel',
  prix: '4,99 €',
  texte: '21 févr. 2023 Abonnement SoundCloud Go+ mensuel 4,99 € Send invoice by email',
  lienRecu: 'https://soundcloud.com/billing/send-invoice',
  texteLien: 'Send invoice by email',
  boutonModale: false,
};

/** Une session valide : un cookie soundcloud non expiré. */
function sessionValide() {
  return JSON.stringify({
    cookies: [{ name: 'oauth_token', value: 'x', domain: '.soundcloud.com', expires: -1 }],
  });
}

/** Une page Playwright simulée : URL finale, titre, lignes extraites. */
function fakePage({
  url = soundcloud.URL_FACTURATION,
  titre = 'Paramètres de l\'abonnement - SoundCloud',
  lignes = [LIGNE_MODALE, LIGNE_PDF, LIGNE_ESSAI],
} = {}) {
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => url,
    title: async () => titre,
    evaluate: async (fn) => {
      if (fn === soundcloud.EXTRAIRE_LIGNES) return lignes;
      return { titre, boutons: ['Abonnements actuels', 'Historique des achats'] };
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
// 1. Les trois issues de la page d'historique
// ---------------------------------------------------------------------------

test('une redirection vers /signin est une session expirée, jamais « aucune ligne »', async () => {
  await assert.rejects(
    () => soundcloud.relever(fakePage({ url: 'https://soundcloud.com/signin?next=%2Fyou' })),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /connexion à SoundCloud a expiré/);
      return true;
    }
  );
});

test('le formulaire embarqué web-auth compte aussi comme page d\'authentification', () => {
  assert.equal(soundcloud.estPageAuthentification('https://secure.soundcloud.com/web-auth?client_id=x'), true);
  assert.equal(soundcloud.estPageAuthentification(soundcloud.URL_FACTURATION), false);
  assert.equal(
    soundcloud.estPageAuthentification('https://soundcloud.com/you/subscriptions?next=%2Fsignin'),
    false
  );
});

test('une page 404 rendue est une ADRESSE MORTE — jamais une session expirée', async () => {
  await assert.rejects(
    () => soundcloud.relever(fakePage({ titre: 'Page not found - SoundCloud', lignes: [] })),
    (err) => {
      assert.equal(err.sessionExpired, undefined);
      assert.match(err.message, /n'existe plus à l'adresse/);
      assert.match(err.message, /inutile de la refaire/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 2. La distinction lien-PDF / bouton-modale — le test qui mord
// ---------------------------------------------------------------------------

test('seule la ligne au lien PDF devient un document ; la modale part en file d\'impression', async () => {
  const journal = [];
  const releve = await soundcloud.relever(fakePage(), (m) => journal.push(m));

  // Trois lignes vues, UNE seule facture PDF : si quelqu'un compte les lignes
  // à modale comme des documents (ou l'inverse), ce test tombe.
  assert.equal(releve.lignes.length, 3);
  assert.equal(releve.documents.length, 1, 'un seul document : la ligne au lien direct');
  assert.equal(releve.documents[0].remoteId, 'soundcloud-FR26322');
  assert.equal(releve.documents[0].issuedOn, '2023-01-15', 'la date française abrégée est lue');
  assert.equal(releve.documents[0].amount, '99,00 €');

  // Le reçu en modale n'est PAS un document du relevé : il s'imprimera.
  assert.equal(releve.modales.length, 1);
  assert.equal(releve.sansRecu.length, 0);

  // L'attestation compte les lignes vues, pas les PDF obtenus.
  const texte = journal.join('\n');
  assert.match(texte, /3 ligne\(s\) d'achat vue\(s\) — 1 avec facture PDF, 1 avec reçu en modale/);
});

test('le jeton ?ht= du lien Recurly ne sort JAMAIS : ni identifiant, ni fichier, ni journal', async () => {
  const journal = [];
  const releve = await soundcloud.relever(fakePage(), (m) => journal.push(m));
  const doc = releve.documents[0];

  assert.ok(!doc.remoteId.includes(JETON));
  assert.ok(!soundcloud.nomFichier({ issuedOn: doc.issuedOn, remoteId: doc.remoteId }).includes(JETON));
  assert.ok(!journal.join('\n').includes(JETON), 'le jeton ne va pas au journal');
  assert.ok(!journal.join('\n').includes('ht='), 'même le nom du paramètre reste dehors');
  // L'URL de téléchargement, elle, garde le jeton : c'est sa seule raison d'être.
  assert.ok(doc.url.includes(JETON));
});

test('un lien dont le texte est un envoi d\'e-mail n\'est jamais un document (règle lot 33)', async () => {
  const journal = [];
  const releve = await soundcloud.relever(
    fakePage({ lignes: [LIGNE_ENVOI_EMAIL, LIGNE_PDF] }),
    (m) => journal.push(m)
  );
  assert.equal(releve.documents.length, 1);
  assert.equal(releve.documents[0].remoteId, 'soundcloud-FR26322');
  assert.doesNotMatch(
    JSON.stringify(releve.documents),
    /send-invoice/,
    'le déclencheur d\'e-mail n\'est jamais pris'
  );
});

// ---------------------------------------------------------------------------
// 3. L'essai gratuit n'est jamais un échec — le test qui mord
// ---------------------------------------------------------------------------

test('la ligne « Essai gratuit » ne produit ni document, ni manque, ni erreur', async () => {
  const journal = [];
  // Rien que l'essai gratuit : le relevé doit rester serein.
  const releve = await soundcloud.relever(fakePage({ lignes: [LIGNE_ESSAI] }), (m) => journal.push(m));

  assert.equal(releve.lignes.length, 1);
  assert.equal(releve.documents.length, 0);
  assert.equal(releve.gratuits.length, 1, 'l\'essai gratuit est reconnu comme tel');
  assert.equal(releve.modales.length, 0, 'il n\'est PAS compté comme un reçu à imprimer');
  assert.equal(releve.sansRecu.length, 0, 'ni comme un achat sans reçu');
  const texte = journal.join('\n');
  assert.match(texte, /essai gratuit/);
  assert.match(texte, /ce n'est pas un échec/);
  assert.doesNotMatch(texte, /n'offre ni facture PDF/);
});

// ---------------------------------------------------------------------------
// 3 bis. L'impression des reçus en modale (lot 41) — mesurée le 19/08/2026
// ---------------------------------------------------------------------------

const ID_TRANSACTION = 'a1b2c3d4e5f6470899aabbccddeeff00';

/** La modale MESURÉE : « Facture », ID de transaction, TVA, Total, émetteur. */
const MODALE_COMPLETE = {
  idTransaction: ID_TRANSACTION,
  aTotal: true,
  apercu: 'Facture 23 mars 2023 … ID de transaction … Total : 4,99 €',
};

/** Un PDF « rendu » plausible : signature %PDF- et un poids au-dessus du seuil. */
const PDF_MODALE = Buffer.concat([
  Buffer.from('%PDF-1.4 reçu imprimé '),
  Buffer.alloc(soundcloud.SEUIL_PDF_OCTETS + 2_000, 0x20),
]);

/**
 * Une page simulée pour la file d'impression : les clics sur les boutons de
 * modale, les lectures de LIRE_MODALE_RECU et le masquage se pilotent ici.
 */
/** La SOURCE que rend l'isolation d'un vrai reçu : le reçu, et rien que lui. */
const SOURCE_ISOLEE = 'Facture 23 mars 2023 Facturer à Camille Dupont ID de transaction '
  + `${ID_TRANSACTION} Abonnement SoundCloud Go+ mensuel Prix HT 4,16 € VAT (20.0%) 0,83 € `
  + 'Total : 4,99 € SoundCloud Global Limited & Co. KG, Karl-Marx-Strasse 101, 12043 Berlin';

const ISOLATION = { largeur: 640, hauteur: 339, source: SOURCE_ISOLEE };

/** Le contraste du reçu RÉEL : texte blanc sur fond sombre, tout se lit. */
const CONTRASTE_LISIBLE = {
  texte: 'rgb(255, 255, 255)',
  fond: 'rgb(33, 33, 33)',
  ratio: 12.63,
  caracteres: { lisibles: 220, illisibles: 0 },
};

function fakePageImpression({
  modales = [MODALE_COMPLETE], pdf = PDF_MODALE, isolation = ISOLATION,
  contraste = CONTRASTE_LISIBLE,
} = {}) {
  let ouverte = -1;
  const gestes = [];
  return {
    waitForTimeout: async () => {},
    keyboard: { press: async (touche) => { gestes.push(`clavier:${touche}`); } },
    locator: (sel) => ({
      nth: (i) => ({
        click: async () => {
          assert.equal(sel, soundcloud.SELECTEUR_BOUTON_MODALE);
          ouverte = i;
          gestes.push(`modale:${i}`);
        },
      }),
    }),
    evaluate: async (fn) => {
      if (fn === soundcloud.LIRE_MODALE_RECU) return modales[ouverte] ?? null;
      if (fn === soundcloud.ISOLER_LE_RECU) { gestes.push('isoler'); return isolation; }
      if (fn === soundcloud.MESURER_LE_CONTRASTE) { gestes.push('contraste'); return contraste; }
      if (fn === soundcloud.RETABLIR_LE_RECU) { gestes.push('retablir'); return true; }
      return null;
    },
    pdf: async (options) => {
      gestes.push(`pdf:${options.width}x${options.height}:${options.printBackground}`);
      return pdf;
    },
    _gestes: gestes,
  };
}

test('un reçu en modale s\'imprime : isolé, page taillée à sa boîte, puis tout est rétabli', async () => {
  const journal = [];
  const page = fakePageImpression();
  const releve = { modales: [{ ...LIGNE_MODALE, index: 0 }] };
  const { invoices, offertes } = await soundcloud.imprimerLesModales(page, releve, {
    log: (m) => journal.push(m),
  });

  assert.equal(offertes, 1);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].remoteId, `soundcloud-${ID_TRANSACTION}`);
  assert.equal(invoices[0].issuedOn, '2023-03-23');
  assert.equal(invoices[0].filename, `soundcloud_2023-03_${ID_TRANSACTION}.pdf`);
  assert.equal(invoices[0].buffer.subarray(0, 5).toString(), '%PDF-');
  // Le geste complet, dans l'ordre : ouvrir, isoler, MESURER LE CONTRASTE
  // (lot 43 — avant le moindre octet rendu), imprimer À LA TAILLE DU REÇU
  // (jamais un A4 où le reste de la page tiendrait), rétablir, fermer.
  assert.deepEqual(page._gestes,
    ['modale:0', 'isoler', 'contraste', 'pdf:642pxx341px:true', 'retablir', 'clavier:Escape']);
  assert.match(journal.join('\n'), /imprimé en PDF depuis sa modale/);
});

// ---------------------------------------------------------------------------
// 3 ter. Le rendu du lot 42 : une page, le reçu seul, cadré
// ---------------------------------------------------------------------------

test('le décor du site dans la page isolée : l\'impression est REFUSÉE, rien n\'est déposé', async () => {
  const page = fakePageImpression({
    isolation: {
      largeur: 640,
      hauteur: 2200,
      // Ce que le lot 41 laissait passer : la barre de navigation et le lecteur.
      source: `Accueil Fil d'actualités Bibliothèque Uploader ${SOURCE_ISOLEE}`,
    },
  });
  const releve = { modales: [{ ...LIGNE_MODALE, index: 0 }] };
  await assert.rejects(
    () => soundcloud.imprimerLesModales(page, releve, {}),
    (err) => {
      assert.match(err.message, /le décor du site/);
      assert.match(err.message, /Fil d'actualités/);
      assert.match(err.message, /Uploader/);
      assert.match(err.message, /Bibliothèque/);
      assert.match(err.message, /Rien n'a été déposé/);
      return true;
    }
  );
  assert.ok(!page._gestes.some((g) => g.startsWith('pdf:')), 'aucun PDF n\'est produit');
  assert.ok(page._gestes.includes('retablir'), 'la page est rétablie même quand le rendu est refusé');
});

test('une page isolée qui a perdu le reçu lui-même : refusée aussi', async () => {
  const page = fakePageImpression({
    isolation: { largeur: 640, hauteur: 339, source: 'Paramètres de l\'abonnement' },
  });
  await assert.rejects(
    () => soundcloud.imprimerLesModales(page, { modales: [{ ...LIGNE_MODALE, index: 0 }] }, {}),
    (err) => {
      assert.match(err.message, /ne portait plus le reçu lui-même/);
      return true;
    }
  );
});

test('un texte indiscernable de son fond REFUSE le dépôt — le grief dit les couleurs', async () => {
  const page = fakePageImpression({
    // Le défaut du 19/08/2026 au soir, tel que MESURER_LE_CONTRASTE l'aurait
    // rendu : les valeurs blanches sur le fond blanchi par l'isolation.
    contraste: {
      texte: 'rgb(255, 255, 255)',
      fond: 'rgb(255, 255, 255)',
      ratio: 1,
      caracteres: { lisibles: 40, illisibles: 180 },
    },
  });
  await assert.rejects(
    () => soundcloud.imprimerLesModales(page, { modales: [{ ...LIGNE_MODALE, index: 0 }] }, {}),
    (err) => {
      assert.match(err.message, /indiscernable du fond/);
      assert.match(err.message, /rgb\(255, 255, 255\)/);
      assert.match(err.message, /Rien n'a été déposé/);
      return true;
    }
  );
  assert.ok(!page._gestes.some((g) => g.startsWith('pdf:')), 'pas un octet n\'est rendu');
  assert.ok(page._gestes.includes('retablir'), 'la page est rétablie malgré le refus');
});

test('le verdict de contraste : lisible, indiscernable, majorité qui se confond, mesure absente', () => {
  assert.equal(soundcloud.controlerContraste(CONTRASTE_LISIBLE), null);
  assert.match(soundcloud.controlerContraste(null), /n'a pas pu être mesurée/);
  // Le texte principal se lit, mais la plus grande partie du reçu se confond.
  const majorite = soundcloud.controlerContraste({
    texte: 'rgb(153, 153, 153)', fond: 'rgb(255, 255, 255)', ratio: 2.85,
    caracteres: { lisibles: 60, illisibles: 160 },
  });
  assert.match(majorite, /160 caractères sur 220/);
  // Un gris pâle sur blanc — « clair sur clair » — tombe sous le seuil.
  assert.match(
    soundcloud.controlerContraste({
      texte: 'rgb(204, 204, 204)', fond: 'rgb(255, 255, 255)', ratio: 1.61,
      caracteres: { lisibles: 220, illisibles: 0 },
    }),
    /indiscernable du fond/
  );
});

test('le contrôle de la source isolée : décor absent, reçu et émetteur présents', () => {
  const bon = soundcloud.controlerSourceIsolee(SOURCE_ISOLEE);
  assert.deepEqual(bon.decor, [], 'aucun libellé de décor dans un reçu isolé');
  assert.equal(bon.aRecu, true, '« ID de transaction » est là');
  assert.equal(bon.aTotal, true, '« Total » est là');
  assert.equal(bon.aEmetteur, true, 'l\'émetteur est là');

  const mauvais = soundcloud.controlerSourceIsolee(`Fil d'actualités Uploader ${SOURCE_ISOLEE}`);
  assert.deepEqual(mauvais.decor, ['Fil d\'actualités', 'Uploader']);
  // Les trois libellés du décor sont ceux mesurés sur le PDF fautif du lot 41.
  assert.deepEqual(soundcloud.TERMES_DECOR, ['Fil d\'actualités', 'Uploader', 'Bibliothèque']);
});

test('un reçu hors de la période demandée est COMPTÉ, pas oublié', async () => {
  const page = fakePageImpression();
  // La fenêtre demandée commence en 2026 ; la ligne mesurée date de 2023.
  const plan = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-08-19T00:00:00Z') };
  const { invoices, offertes, horsPeriode } = await soundcloud.imprimerLesModales(
    page,
    { modales: [{ ...LIGNE_MODALE, index: 0 }, { ...LIGNE_MODALE, date: '5 janv. 2019', index: 1 }] },
    { plan }
  );

  assert.equal(invoices.length, 0, 'rien n\'est imprimé hors de la période demandée');
  assert.equal(offertes, 0, 'aucun reçu n\'a été ouvert : rien n\'était dans la fenêtre');
  assert.equal(horsPeriode, 2, 'les deux reçus écartés sont comptés — c\'est ce compte qui parle');
  assert.deepEqual(page._gestes, [], 'aucune modale n\'est ouverte pour rien');
});

test('un reçu isolé plus petit qu\'une facture est refusé (rendu vide)', async () => {
  const page = fakePageImpression({ isolation: { largeur: 640, hauteur: 12, source: SOURCE_ISOLEE } });
  await assert.rejects(
    () => soundcloud.imprimerLesModales(page, { modales: [{ ...LIGNE_MODALE, index: 0 }] }, {}),
    (err) => {
      assert.match(err.message, /640×12 points/);
      return true;
    }
  );
});

test('une modale qui n\'est pas un reçu complet : son contenu est DIT, rien n\'est déposé', async () => {
  const journal = [];
  const page = fakePageImpression({
    modales: [{ idTransaction: null, aTotal: false, apercu: 'Gérer votre abonnement Passer à Go+' }],
  });
  const releve = { modales: [{ ...LIGNE_MODALE, index: 0 }] };
  const { invoices, offertes } = await soundcloud.imprimerLesModales(page, releve, {
    log: (m) => journal.push(m),
  });

  assert.equal(invoices.length, 0, 'rien n\'est fabriqué à la place du reçu manquant');
  assert.equal(offertes, 0, 'une modale sans reçu n\'est pas un document proposé');
  const texte = journal.join('\n');
  assert.match(texte, /n'est pas un\s+reçu complet/);
  assert.match(texte, /Gérer votre abonnement/, 'le journal dit ce que la modale contenait');
  assert.ok(!page._gestes.includes('masquer'), 'aucune impression tentée');
});

test('un reçu en modale déjà récupéré est sauté — mais compte comme proposé', async () => {
  const journal = [];
  const page = fakePageImpression();
  const releve = { modales: [{ ...LIGNE_MODALE, index: 0 }] };
  const { invoices, offertes } = await soundcloud.imprimerLesModales(page, releve, {
    connus: new Set([`soundcloud-${ID_TRANSACTION}`]),
    log: (m) => journal.push(m),
  });

  assert.equal(invoices.length, 0);
  assert.equal(offertes, 1, 'le document était bien proposé : « déjà récupéré », pas « rien à télécharger »');
  assert.match(journal.join('\n'), /déjà récupéré/);
});

test('un rendu blanc de modale est un ÉCHEC dit à voix haute, jamais un dépôt', async () => {
  const page = fakePageImpression({ pdf: Buffer.from('%PDF-1.4 vide') });
  const releve = { modales: [{ ...LIGNE_MODALE, index: 0 }] };
  await assert.rejects(
    () => soundcloud.imprimerLesModales(page, releve, {}),
    (err) => {
      assert.match(err.message, /pas produit un PDF exploitable/);
      assert.match(err.message, /octets rendus/);
      return true;
    }
  );
  assert.ok(page._gestes.includes('retablir'), 'la page est rétablie même quand le rendu échoue');
});

test('deux lignes qui rendent la MÊME modale : la seconde est sautée, rien en double', async () => {
  const journal = [];
  const page = fakePageImpression({ modales: [MODALE_COMPLETE, MODALE_COMPLETE] });
  const releve = {
    modales: [
      { ...LIGNE_MODALE, index: 0 },
      { ...LIGNE_MODALE, date: '23 avr. 2023', index: 1 },
    ],
  };
  const { invoices } = await soundcloud.imprimerLesModales(page, releve, {
    log: (m) => journal.push(m),
  });
  assert.equal(invoices.length, 1);
  assert.match(journal.join('\n'), /déjà lu pendant ce passage/);
});

// ---------------------------------------------------------------------------
// 3 quater. Le rendu, joué pour de vrai dans Chromium (lot 42)
// ---------------------------------------------------------------------------

/**
 * Les fausses pages ci-dessus prouvent la MÉCANIQUE ; elles ne peuvent rien
 * dire du RENDU. Or c'est le rendu qui était faux au lot 41 : deux pages,
 * décor en travers, reçu non cadré. Ce test-ci imprime pour de bon, dans le
 * navigateur qui imprime en production, une page qui reproduit la structure
 * mesurée le 19/08/2026 — barre de navigation fixe, lecteur audio fixe, fond
 * gris, modale du reçu — et compte les pages du PDF obtenu.
 *
 * Le témoin est DANS le test : la même page, imprimée sans isolation comme le
 * faisait le lot 41, doit sortir à deux pages. Si un jour l'isolation cesse
 * d'agir, le témoin et la mesure se rejoindront et le test tombera.
 */
function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT
    ? false
    : 'Playwright n\'est pas installé sur cette machine : le rendu du reçu n\'est pas '
      + 'joué. Installez-le avec « npm install playwright && npx playwright install '
      + 'chromium » pour couvrir cette chaîne.',
};

/** La page d'abonnement, telle que mesurée : décor compris. */
const PAGE_AVEC_DECOR = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Paramètres de l'abonnement - SoundCloud</title><style>
  body { margin:0; background:#f2f2f2; font-family:sans-serif; }
  .header { position:fixed; top:0; left:0; right:0; height:46px; background:#fff; z-index:1000; }
  .header a { display:inline-block; padding:14px 12px; }
  .page { padding:70px 40px 140px; min-height:1400px; }
  .playbar { position:fixed; bottom:0; left:0; right:0; height:50px; background:#333; color:#fff; z-index:1000; }
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:2000;
           display:flex; align-items:center; justify-content:center; }
  .modal__content { background:#fff; width:640px; max-height:80vh; overflow:auto; padding:24px; }
  /* Le reçu réel est SOMBRE : valeurs blanches, libellés gris. C'est cette
     décoration que le lot 42 écrasait (fond blanchi → texte blanc invisible,
     mesuré le 19/08/2026 au soir sur un compte réel) : elle doit survivre à l'isolation. */
  .consumerSubscriptionReceipt { background:#212121; color:#fff; padding:24px; }
  .consumerSubscriptionReceipt__row { display:flex; justify-content:space-between; padding:6px 0; }
  .consumerSubscriptionReceipt__row span:first-child { color:#999; }
  .consumerSubscriptionReceipt__footer { color:#999; }
</style></head><body>
  <div class="header"><a href="/">Accueil</a><a href="/feed">Fil d'actualités</a>
    <a href="/library">Bibliothèque</a><a href="/upload">Uploader</a></div>
  <div class="page"><h1>Paramètres de l'abonnement</h1>
    <p class="subscriptions__sectionTitle">Historique des achats</p></div>
  <div class="playbar">En cours de lecture : un titre, un artiste</div>
  <div class="modal" role="dialog"><div class="modal__content">
    <div class="consumerSubscriptionReceipt">
      <div class="consumerSubscriptionReceipt__title">Facture</div>
      <div class="consumerSubscriptionReceipt__row"><span>Date</span><span>23 mars 2023</span></div>
      <div class="consumerSubscriptionReceipt__row"><span>ID de transaction</span><span>${ID_TRANSACTION}</span></div>
      <div class="consumerSubscriptionReceipt__row"><span>Description</span><span>Abonnement SoundCloud Go+ mensuel</span></div>
      <div class="consumerSubscriptionReceipt__row"><span>Prix HT</span><span>4,16 €</span></div>
      <div class="consumerSubscriptionReceipt__row"><span>VAT (20.0%)</span><span>0,83 €</span></div>
      <div class="consumerSubscriptionReceipt__row"><span>Total :</span><span>4,99 €</span></div>
      <div class="consumerSubscriptionReceipt__footer">SoundCloud Global Limited &amp; Co. KG,
        Karl-Marx-Strasse 101, 12043 Berlin, Germany, USt.-Id: DE326379178</div>
    </div></div></div>
</body></html>`;

/**
 * Combien de pages ce PDF porte-t-il ? Comptage LITTÉRAL des objets `/Type
 * /Page` de la structure du fichier — le `[^s]` écarte le `/Type /Pages` du
 * nœud racine, qui n'est pas une page. Aucune impression de confiance.
 */
function pagesDuPdf(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

test('le reçu isolé s\'imprime sur UNE page, sans décor et cadré', SANS_NAVIGATEUR, async () => {
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const page = await navigateur.newPage({ viewport: { width: 1600, height: 900 } });
    await page.setContent(PAGE_AVEC_DECOR);

    // TÉMOIN : la page entière en A4, comme le lot 41 l'imprimait.
    const temoin = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    assert.ok(pagesDuPdf(temoin) > 1, 'témoin : sans isolation, le PDF déborde d\'une page');

    // (c) le contenu attendu est là AVANT le rendu, (b) le décor n'y est plus.
    const isole = await page.evaluate(soundcloud.ISOLER_LE_RECU);
    assert.ok(isole, 'le reçu a été trouvé et isolé');
    const controle = soundcloud.controlerSourceIsolee(isole.source);
    assert.deepEqual(controle.decor, [], 'aucun libellé du décor ne survit à l\'isolation');
    assert.ok(isole.source.includes('ID de transaction'));
    assert.ok(isole.source.includes(ID_TRANSACTION));
    assert.ok(isole.source.includes('Total'));
    assert.ok(isole.source.includes('SoundCloud Global Limited'), 'l\'émetteur est imprimé');
    assert.ok(!isole.source.includes('Historique des achats'), 'la page d\'origine a disparu');

    // (d) lot 43 : la décoration du reçu a SURVÉCU à l'isolation — le texte
    // blanc se lit toujours sur le fond sombre du reçu, mesuré dans la page.
    const contraste = await page.evaluate(soundcloud.MESURER_LE_CONTRASTE);
    assert.equal(soundcloud.controlerContraste(contraste), null,
      'le reçu isolé reste lisible : aucune décoration n\'a été écrasée');
    assert.equal(contraste.texte, 'rgb(255, 255, 255)', 'les valeurs sont restées blanches');
    assert.equal(contraste.fond, 'rgb(33, 33, 33)', 'le fond sombre du reçu est resté sien');
    assert.ok(contraste.ratio >= 4, `texte blanc sur fond sombre, ratio ${contraste.ratio}`);
    assert.equal(contraste.caracteres.illisibles, 0, 'pas un caractère ne se confond avec le fond');

    // (a) une seule page, à la taille du reçu.
    const rendu = Buffer.from(await page.pdf({
      width: `${isole.largeur + 2}px`,
      height: `${isole.hauteur + 2}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
    }));
    assert.equal(pagesDuPdf(rendu), 1, 'le reçu tient sur UNE page, une seule fois');
    assert.equal(rendu.subarray(0, 5).toString(), '%PDF-');
    assert.ok(rendu.length > soundcloud.SEUIL_PDF_OCTETS, 'le rendu n\'est pas blanc');
    // Le reçu occupe la page : ni A4 (595×842 pt), ni une bande résiduelle.
    assert.ok(isole.largeur >= 400 && isole.hauteur >= 100, `boîte mesurée ${isole.largeur}×${isole.hauteur}`);

    // La page est rendue à son état d'origine : la ligne suivante la retrouve
    // entière. La preuve porte sur les styles CALCULÉS — ce qui décide du rendu
    // — et non sur l'attribut `style`, que Chromium garde vide une fois touché.
    await page.evaluate(soundcloud.RETABLIR_LE_RECU);
    const apres = await page.evaluate(() => {
      const calcul = (sel, props) => {
        const s = getComputedStyle(document.querySelector(sel));
        return Object.fromEntries(props.map((p) => [p, s[p]]));
      };
      return {
        marqueurs: document.querySelectorAll('[data-crabe-style-avant]').length,
        declarations: [...document.querySelectorAll('.modal, .modal__content, .consumerSubscriptionReceipt, body')]
          .map((n) => n.style.length),
        header: calcul('.header', ['display', 'position']),
        modale: calcul('.modal', ['display', 'position']),
        recu: calcul('.consumerSubscriptionReceipt', ['position', 'width', 'background-color']),
        corps: calcul('body', ['background-color', 'margin-top']),
        texte: document.body.innerText.replace(/\s+/g, ' '),
      };
    });
    assert.equal(apres.marqueurs, 0, 'aucun marqueur de crabe ne reste dans la page');
    assert.deepEqual(apres.declarations, [0, 0, 0, 0], 'plus une seule propriété posée par crabe');
    assert.deepEqual(apres.header, { display: 'block', position: 'fixed' },
      'la barre de navigation est revenue, fixe comme le site la veut');
    assert.deepEqual(apres.modale, { display: 'flex', position: 'fixed' },
      'la modale a retrouvé sa mise en page d\'origine');
    assert.equal(apres.recu.position, 'static', 'le reçu a retrouvé sa position d\'origine');
    assert.equal(apres.recu['background-color'], 'rgb(33, 33, 33)',
      'le fond sombre du reçu est celui du site — crabe n\'y a jamais touché');
    assert.equal(apres.corps['background-color'], 'rgb(242, 242, 242)', 'le fond gris du site est revenu');
    assert.ok(apres.texte.includes('Fil d\'actualités'), 'la page a retrouvé sa barre de navigation');
  } finally {
    await navigateur.close();
  }
});

/**
 * MORSURE de la garde de contraste : rejouer, dans le même Chromium, le geste
 * exact du lot 42 — blanchir le fond du reçu — et vérifier que la mesure le
 * voit. Ce contrôle aurait attrapé le défaut du 19/08/2026 au soir.
 */
test('la garde de contraste attrape le défaut du 19/08 : fond blanchi, texte invisible', SANS_NAVIGATEUR, async () => {
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const page = await navigateur.newPage({ viewport: { width: 1600, height: 900 } });
    await page.setContent(PAGE_AVEC_DECOR);
    assert.ok(await page.evaluate(soundcloud.ISOLER_LE_RECU), 'le reçu est isolé');

    // Aujourd'hui : l'isolation ne touche pas aux couleurs, le reçu se lit.
    const lisible = await page.evaluate(soundcloud.MESURER_LE_CONTRASTE);
    assert.equal(soundcloud.controlerContraste(lisible), null, 'le reçu isolé se lit');

    // Hier : ISOLER posait `background: #fff` sur le reçu lui-même. Reposé
    // tel quel, la garde doit refuser — blanc sur blanc, mesuré.
    await page.evaluate(() => {
      document.querySelector('.consumerSubscriptionReceipt')
        .style.setProperty('background', '#fff', 'important');
    });
    const casse = await page.evaluate(soundcloud.MESURER_LE_CONTRASTE);
    const grief = soundcloud.controlerContraste(casse);
    assert.ok(grief, 'la garde refuse le texte devenu invisible');
    assert.match(grief, /indiscernable du fond/);
    assert.equal(casse.texte, 'rgb(255, 255, 255)', 'les valeurs sont blanches');
    assert.equal(casse.fond, 'rgb(255, 255, 255)', 'le fond mesuré derrière elles est blanc');
    assert.ok(casse.ratio < soundcloud.CONTRASTE_MINIMAL, `ratio ${casse.ratio} : indiscernable`);
  } finally {
    await navigateur.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Les dates françaises abrégées
// ---------------------------------------------------------------------------

test('les dates françaises de SoundCloud, abréviations comprises, deviennent ISO', () => {
  const cas = [
    ['23 mars 2023', '2023-03-23'],
    ['21 févr. 2023', '2023-02-21'],
    ['5 janv. 2019', '2019-01-05'],
    ['14 août 2018', '2018-08-14'],
    ['15 déc. 2016', '2016-12-15'],
    ['19 juin 2017', '2017-06-19'],
    ['15 juil. 2018', '2018-07-15'],
    ['4 sept. 2016', '2016-09-04'],
  ];
  for (const [entree, attendu] of cas) {
    assert.equal(soundcloud.dateFrancaiseEnIso(entree), attendu, entree);
  }
  assert.equal(soundcloud.dateFrancaiseEnIso('gribouillis'), null);
  assert.equal(soundcloud.dateFrancaiseEnIso(''), null);
});

test('la référence de facture vient du chemin du lien, jamais de sa requête', () => {
  assert.equal(soundcloud.referenceDuLien(LIGNE_PDF.lienRecu), 'FR26322');
  assert.equal(soundcloud.referenceDuLien('pas une url'), null);
});

// ---------------------------------------------------------------------------
// 5. Le téléchargement : le contenu fait foi
// ---------------------------------------------------------------------------

test('une facture PDF descend ; un contenu non-PDF ne dépose RIEN et le dit', async () => {
  const doc = { remoteId: 'soundcloud-FR26322', url: LIGNE_PDF.lienRecu };

  const buffer = await soundcloud.telecharger(fakeContext({ body: PDF }), doc);
  assert.ok(buffer.subarray(0, 5).toString() === '%PDF-');

  await assert.rejects(
    () => soundcloud.telecharger(fakeContext({ body: PAS_UN_PDF }), doc),
    (err) => {
      assert.match(err.message, /n'est pas arrivée sous forme de PDF/);
      assert.match(err.message, /rien n'a été déposé à sa place/);
      assert.equal(err.sessionExpired, undefined);
      return true;
    }
  );
});

test('un 403 sur une facture est une session expirée, pas une panne de téléchargement', async () => {
  const doc = { remoteId: 'soundcloud-FR26322', url: LIGNE_PDF.lienRecu };
  await assert.rejects(
    () => soundcloud.telecharger(fakeContext({ status: 403 }), doc),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. La session est contrôlée avant tout
// ---------------------------------------------------------------------------

test('une session absente ou vide est refusée avant d\'ouvrir un navigateur', () => {
  assert.throws(() => soundcloud.lireSession({}), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  assert.throws(() => soundcloud.lireSession({ session: '{"cookies":[]}' }), (err) => {
    assert.equal(err.sessionExpired, true);
    return true;
  });
  const etat = soundcloud.lireSession({ session: sessionValide() });
  assert.ok(Array.isArray(etat.cookies));
  assert.equal(sessionState.validate(sessionValide()).ok, true);
});

// ---------------------------------------------------------------------------
// 7. Le marqueur de compte du contrôle strict (phase A)
// ---------------------------------------------------------------------------

test('le bouton de profil SoundCloud est une preuve forte — mesuré présent connecté, absent anonyme', () => {
  assert.ok(
    preuve.PREUVES_FORTES.includes('.header__userNavUsernameButton'),
    'sans ce marqueur, la politique stricte refuserait toute session SoundCloud valide'
  );
});

// ---------------------------------------------------------------------------
// 8. Une page muette est journalisée — jamais un échec silencieux
// ---------------------------------------------------------------------------

test('zéro ligne : la page est journalisée et le message distingue les deux explications', async () => {
  const journal = [];
  const releve = await soundcloud.relever(fakePage({ lignes: [] }), (m) => journal.push(m));
  assert.equal(releve.lignes.length, 0);
  assert.match(journal.join('\n'), /aucune ligne d'achat reconnue/);
  assert.match(journal.join('\n'), /libellés vus/);

  const message = soundcloud.messageReleveVide([soundcloud.URL_FACTURATION]);
  assert.match(message, /aucune ligne d'achat n'a été reconnue/);
  assert.match(message, /par e-mail/);
  assert.match(message, /signalez-le/i);
});
