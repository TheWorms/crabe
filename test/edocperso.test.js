'use strict';

/**
 * Connecteur eDocPerso — l'arborescence ENTIÈRE, la Corbeille JAMAIS.
 *
 * Le connecteur est écrit sans compte réel (initialStatus « pending ») : ces
 * tests rejouent l'API relevée dans le code de l'application (base /edp-back,
 * jeton dans l'en-tête Set-Authorization, POST de listage paginé, POST de
 * téléchargement) contre un faux serveur en mémoire.
 *
 * Les trois garanties qui comptent :
 *
 *   1. **Tout l'arbre est parcouru.** Le tableau de bord ne montre que « Mes
 *      derniers documents » : un connecteur qui ne lirait que lui raterait
 *      l'historique — même piège que le menu des années de Materiel.net. Le
 *      test plante un document au FOND d'un sous-dossier et exige qu'il en
 *      ressorte.
 *   2. **La Corbeille n'est ni lue ni descendue**, même si l'arbre la montre.
 *   3. **Des données de paie, rien ne fuit au journal** : ni titre, ni nom de
 *      dossier (un nom d'employeur est une donnée), ni montant.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const edp = require('../server/connectors/available/edocperso/connector');

// ---------------------------------------------------------------------------
// Le faux eDocPerso
// ---------------------------------------------------------------------------

const JETON = 'jeton-de-test';

/** Un PDF minuscule mais signé comme un vrai. */
const PDF = Buffer.from('%PDF-1.4 bulletin factice');

/**
 * L'arbre servi par le faux coffre : deux employeurs sous un onglet, un
 * sous-dossier PROFOND, et une Corbeille piégée qui ne doit jamais être lue.
 */
const ARBRE = [
  {
    id: 'onglet-employeurs',
    name: 'Mes Employeurs',
    children: [
      { id: 'dossier-un', name: 'EMPLOYEUR-UN' },
      {
        id: 'dossier-deux',
        name: 'EMPLOYEUR-DEUX',
        children: [{ id: 'dossier-profond', name: 'Année 2024' }],
      },
    ],
  },
  {
    id: 'corbeille',
    name: 'Corbeille',
    children: [{ id: 'piege', name: 'Piège dans la corbeille' }],
  },
];

const DOCUMENTS = {
  'dossier-un': [{ id: 'doc-recent', title: 'Bulletins 12/2025', size: 100319 }],
  'dossier-deux': [],
  'dossier-profond': [{ id: 'doc-profond', title: 'Bulletins 01/2024', size: 99001 }],
  'onglet-employeurs': [],
  corbeille: [{ id: 'doc-supprime', title: 'Ancien bulletin', size: 1 }],
  piege: [{ id: 'doc-piege', title: 'Piège', size: 1 }],
};

function reponseJson(objet, entetes = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (nom) => entetes[nom.toLowerCase()] ?? null },
    json: async () => objet,
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

function reponseBrute(status, corps = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => corps,
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

/**
 * Monte le faux coffre sur globalThis.fetch et rend le journal des appels.
 * `options.refuserRacine` : la liste hors dossier répond 400, comme une API
 * qui ne connaît pas `folderId: null` — le connecteur doit continuer.
 */
function monterFauxCoffre({ refuserRacine = true, telechargementNonPdf = false } = {}) {
  const appels = [];
  const vraiFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const chemin = new URL(String(url)).pathname;
    const corps = options.body ? JSON.parse(options.body) : null;
    appels.push({ chemin, methode: options.method || 'GET', corps });

    if (chemin.endsWith('/api/v1/login')) {
      if (corps?.email === 'bon@exemple.fr' && corps?.password === 'correct') {
        return reponseJson({}, { 'set-authorization': JETON });
      }
      if (corps?.email === 'sso@exemple.fr') {
        return reponseBrute(401, { loginUrl: 'https://sso.exemple.fr/' });
      }
      return reponseBrute(401, { message: 'bad credentials' });
    }

    // Tout le reste exige le jeton.
    if (options.headers?.Authorization !== `Bearer ${JETON}`) {
      return reponseBrute(401, {});
    }

    if (chemin.endsWith('/api/v1/folders')) return reponseJson(ARBRE);

    if (chemin.endsWith('/api/v1/documents') && (options.method || 'GET') === 'POST') {
      if (corps.folderId === null || corps.folderId === undefined) {
        if (refuserRacine) return reponseBrute(400, { message: 'folderId requis' });
        return reponseJson({ documents: [] });
      }
      return reponseJson({ documents: DOCUMENTS[corps.folderId] || [] });
    }

    if (chemin.endsWith('/api/v1/documents/download')) {
      const contenu = telechargementNonPdf ? Buffer.from('PAS-UN-PDF') : PDF;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        arrayBuffer: async () => contenu,
      };
    }

    return reponseBrute(404, {});
  };

  return { appels, demonter: () => (globalThis.fetch = vraiFetch) };
}

const CONFIG = { email: 'bon@exemple.fr', motDePasse: 'correct', historique: 'tout' };

// ---------------------------------------------------------------------------
// 1. L'arbre entier — le test qui tombe si seul le tableau de bord est lu
// ---------------------------------------------------------------------------

test('un document au fond d\'un sous-dossier est récupéré — pas seulement les derniers', async () => {
  const coffre = monterFauxCoffre();
  try {
    const resultat = await edp.fetchInvoices(CONFIG, { log: () => {} });

    assert.deepEqual(
      resultat.invoices.map((i) => i.remoteId).sort(),
      ['edocperso-doc-profond', 'edocperso-doc-recent'],
      'le document du sous-dossier profond doit ressortir : ne lire que le tableau de bord '
        + 'ou que les dossiers de premier niveau rate l\'historique'
    );

    // Chaque dossier hors corbeille a bien été LISTÉ, y compris le profond.
    const dossiersDemandes = coffre.appels
      .filter((a) => a.chemin.endsWith('/api/v1/documents') && a.methode === 'POST')
      .map((a) => a.corps.folderId);
    for (const attendu of ['onglet-employeurs', 'dossier-un', 'dossier-deux', 'dossier-profond']) {
      assert.ok(dossiersDemandes.includes(attendu), `le dossier ${attendu} n'a jamais été listé`);
    }

    const profond = resultat.invoices.find((i) => i.remoteId === 'edocperso-doc-profond');
    assert.equal(profond.issuedOn, '2024-01-01', 'l\'année vient de la période du titre');
    assert.equal(resultat.invoices.find((i) => i.remoteId === 'edocperso-doc-recent').issuedOn, '2025-12-01');
    assert.equal(resultat.accountId, 'bon@exemple.fr');
  } finally {
    coffre.demonter();
  }
});

test('la Corbeille n\'est ni listée ni descendue, même montrée par l\'arbre', async () => {
  const coffre = monterFauxCoffre();
  try {
    const resultat = await edp.fetchInvoices(CONFIG, { log: () => {} });

    const dossiersDemandes = coffre.appels
      .filter((a) => a.chemin.endsWith('/api/v1/documents') && a.methode === 'POST')
      .map((a) => a.corps.folderId);
    assert.equal(dossiersDemandes.includes('corbeille'), false, 'la corbeille a été listée');
    assert.equal(dossiersDemandes.includes('piege'), false, 'un dossier DE la corbeille a été listé');

    const telecharges = coffre.appels
      .filter((a) => a.chemin.endsWith('/download'))
      .flatMap((a) => a.corps.documentIds);
    assert.equal(telecharges.includes('doc-supprime'), false);
    assert.equal(telecharges.includes('doc-piege'), false);
    assert.equal(resultat.invoices.some((i) => i.remoteId.includes('supprime')), false);
  } finally {
    coffre.demonter();
  }
});

test('une racine que l\'API refuse ne fait pas échouer le parcours des dossiers', async () => {
  const coffre = monterFauxCoffre({ refuserRacine: true });
  try {
    const resultat = await edp.fetchInvoices(CONFIG, { log: () => {} });
    assert.equal(resultat.invoices.length, 2);
  } finally {
    coffre.demonter();
  }
});

// ---------------------------------------------------------------------------
// 2. La preuve d'accès, et le passage sans nouveauté
// ---------------------------------------------------------------------------

test('la preuve de liste est déposée, et un passage sans nouveauté reste honnête', async () => {
  const coffre = monterFauxCoffre();
  try {
    let preuve = null;
    const ctx = {
      log: () => {},
      preuveDeListe: (p) => (preuve = p),
      knownRemoteIds: ['edocperso-doc-recent', 'edocperso-doc-profond'],
    };
    const resultat = await edp.fetchInvoices(CONFIG, ctx);

    assert.equal(resultat.invoices.length, 0, 'tout est déjà connu : aucun dépôt');
    assert.ok(preuve, 'sans preuve, le socle transformerait ce passage en échec');
    assert.equal(preuve.elements, 2, 'les deux documents ont bien été LISTÉS');
    assert.match(preuve.session, /jeton de connexion accepté/);
  } finally {
    coffre.demonter();
  }
});

test('un contenu qui n\'est pas un PDF est écarté, compté, jamais déposé', async () => {
  const coffre = monterFauxCoffre({ telechargementNonPdf: true });
  try {
    const lignes = [];
    const resultat = await edp.fetchInvoices(CONFIG, { log: (l) => lignes.push(l) });
    assert.equal(resultat.invoices.length, 0);
    assert.ok(lignes.some((l) => /écarté/.test(l) && /pas des PDF/.test(l)));
  } finally {
    coffre.demonter();
  }
});

// ---------------------------------------------------------------------------
// 3. Données de paie : rien ne fuit au journal
// ---------------------------------------------------------------------------

test('aucun titre de document ni nom de dossier ne part au journal', async () => {
  const coffre = monterFauxCoffre();
  try {
    const lignes = [];
    await edp.fetchInvoices(CONFIG, { log: (l) => lignes.push(String(l)) });
    const journal = lignes.join('\n');
    for (const interdit of ['Bulletins', 'EMPLOYEUR', '12/2025', '01/2024', 'Employeurs']) {
      assert.equal(
        journal.includes(interdit),
        false,
        `« ${interdit} » a fui au journal — un titre ou un nom de dossier est une donnée de paie`
      );
    }
  } finally {
    coffre.demonter();
  }
});

// ---------------------------------------------------------------------------
// 4. La connexion — refus, délégation, session qui tombe
// ---------------------------------------------------------------------------

test('un refus d\'identifiants dit quoi vérifier, sans jargon', async () => {
  const coffre = monterFauxCoffre();
  try {
    await assert.rejects(
      () => edp.fetchInvoices({ ...CONFIG, motDePasse: 'faux' }, { log: () => {} }),
      /Vérifiez l'adresse électronique et le mot de passe/
    );
  } finally {
    coffre.demonter();
  }
});

test('un compte à connexion déléguée est expliqué, pas accusé de mauvais mot de passe', async () => {
  const coffre = monterFauxCoffre();
  try {
    await assert.rejects(
      () => edp.fetchInvoices({ ...CONFIG, email: 'sso@exemple.fr' }, { log: () => {} }),
      /FranceConnect|entreprise/
    );
  } finally {
    coffre.demonter();
  }
});

test('le test de connexion compte les dossiers sans télécharger', async () => {
  const coffre = monterFauxCoffre();
  try {
    const resultat = await edp.test(CONFIG, {});
    assert.equal(resultat.ok, true);
    assert.match(resultat.message, /dossier\(s\) dans votre coffre/);
    assert.equal(coffre.appels.some((a) => a.chemin.endsWith('/download')), false);
  } finally {
    coffre.demonter();
  }
});

// ---------------------------------------------------------------------------
// 5. Les formes tolérées de l'API — vérifiées sans réseau
// ---------------------------------------------------------------------------

test('l\'arbre s\'aplatit quelle que soit son enveloppe, corbeille écartée', () => {
  assert.deepEqual(
    edp.aplatirDossiers({ folders: ARBRE }).map((d) => d.id),
    ['onglet-employeurs', 'dossier-un', 'dossier-deux', 'dossier-profond']
  );
  assert.deepEqual(edp.aplatirDossiers([{ id: 7, name: 'Seul' }]).map((d) => d.id), [7]);
  assert.deepEqual(edp.aplatirDossiers(null), []);
  assert.deepEqual(edp.aplatirDossiers({ data: [{ id: 'a', name: 'Trash' }] }), []);
});

test('chaque dossier connaît son CHEMIN dans le coffre — c\'est lui qui range', () => {
  // Lot 38 : les dossiers du coffre remplacent le niveau d'année au dépôt.
  // Sans le chemin complet, « EMPLOYEUR-UN » perdrait son onglet parent et
  // deux employeurs homonymes se mélangeraient.
  const parId = Object.fromEntries(
    edp.aplatirDossiers({ folders: ARBRE }).map((d) => [d.id, d.chemin])
  );
  assert.deepEqual(parId['onglet-employeurs'], ['Mes Employeurs']);
  assert.deepEqual(parId['dossier-un'], ['Mes Employeurs', 'EMPLOYEUR-UN']);
  assert.deepEqual(parId['dossier-profond'], ['Mes Employeurs', 'EMPLOYEUR-DEUX', 'Année 2024']);
});

test('un document déposé porte les dossiers du coffre comme sous-chemin', async () => {
  const coffre = monterFauxCoffre();
  try {
    const resultat = await edp.fetchInvoices(CONFIG, {});
    const profond = resultat.invoices.find((i) => i.remoteId === 'edocperso-doc-profond');
    assert.ok(profond, 'le document profond doit être récupéré');
    assert.deepEqual(
      profond.sousChemin,
      ['Mes Employeurs', 'EMPLOYEUR-DEUX', 'Année 2024'],
      'le dépôt reproduit le rangement du coffre, pas une année'
    );
  } finally {
    coffre.demonter();
  }
});

test('la période se lit dans le titre — c\'est l\'exemple du cahier des charges', () => {
  assert.equal(edp.periodeDepuisTitre('Bulletins 12/2025'), '2025-12-01');
  assert.equal(edp.periodeDepuisTitre('Bulletin 1/2024'), '2024-01-01');
  assert.equal(edp.periodeDepuisTitre('Attestation 2023'), '2023-01-01');
  assert.equal(edp.periodeDepuisTitre('Sans période'), null);
  // Les champs de date de l'API prennent le relais quand le titre se tait.
  assert.equal(edp.dateDuDocument({ title: 'Sans période', addedDate: '2026-02-03T10:00:00Z' }), '2026-02-03');
  assert.equal(edp.dateDuDocument({ title: 'Sans rien' }), null);
});
