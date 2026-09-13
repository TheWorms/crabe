'use strict';

/**
 * Le connecteur Impots.gouv.fr.
 *
 * Ce fichier vérifie ce qui se vérifie sans navigateur — c'est-à-dire tout ce
 * qui a coûté cher à découvrir contre le compte réel, le 10/08/2026 :
 *
 *   1. **le libellé vit dans l'attribut `title`**, pas dans le texte du bouton,
 *      qui ne dit que « Visualiser PDF ». Sans lui, les quatre documents d'une
 *      année sont indiscernables ;
 *   2. **le nom du fichier vient du serveur et contient déjà `.pdf`** : le
 *      doubler donnait les `….pdf.pdf` du script d'exploration ;
 *   3. **la déduplication porte sur le libellé et l'année**, jamais sur
 *      `idEnsua`, produit au clic et probablement instable — même piège que les
 *      UUID d'Amazon ;
 *   4. **les années sont relevées dynamiquement** dans les `href`, aucune n'est
 *      écrite en dur ;
 *   5. **l'expiration de session** se reconnaît à `connexion`, `authorize` ou
 *      `oauth` dans l'adresse — et pas au mot « impots », qui est dans le
 *      domaine de toutes les pages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const impots = require('../server/connectors/available/impots/connector');
const history = require('../server/connectors/history');
const schema = require('../server/connectors/manifest-schema');
const manifest = require('../server/connectors/available/impots/manifest.json');

// ---------------------------------------------------------------------------
// Le libellé, qui n'est PAS le texte du bouton
// ---------------------------------------------------------------------------

test('le libellé se lit dans l\'attribut title, débarrassé de son préfixe', () => {
  assert.equal(
    impots.libelleDepuisTitre('« Visualiser PDF »  Avis d\'impôt 2026 sur les revenus 2025'),
    'Avis d\'impôt 2026 sur les revenus 2025'
  );
  assert.equal(
    impots.libelleDepuisTitre(
      '« Visualiser PDF » Déclaration smartphone des revenus 2025 (le 11/04/2026, à 22:22)'
    ),
    'Déclaration smartphone des revenus 2025 (le 11/04/2026, à 22:22)'
  );
  assert.equal(
    impots.libelleDepuisTitre('Visualiser PDF : Accusé de réception de déclaration smartphone'),
    'Accusé de réception de déclaration smartphone'
  );

  // Un libellé déjà propre n'est pas amputé.
  assert.equal(
    impots.libelleDepuisTitre('Avis de situation déclarative à l\'impôt 2026'),
    'Avis de situation déclarative à l\'impôt 2026'
  );
});

test('les quatre documents d\'une même année restent distincts', () => {
  const titres = [
    '« Visualiser PDF »  Avis d\'impôt 2026 sur les revenus 2025',
    '« Visualiser PDF »  Déclaration smartphone des revenus 2025 (le 11/04/2026, à 22:22)',
    '« Visualiser PDF »  Accusé de réception de déclaration smartphone des revenus 2025',
    '« Visualiser PDF »  Avis de situation déclarative smartphone à l\'impôt 2026',
  ];
  const refs = titres.map((t) => impots.remoteIdPour(impots.libelleDepuisTitre(t), 2026));
  assert.equal(new Set(refs).size, 4, 'quatre références différentes');
});

// ---------------------------------------------------------------------------
// Déduplication : jamais idEnsua
// ---------------------------------------------------------------------------

test('la référence est le libellé et l\'année, jamais idEnsua', () => {
  const ref = impots.remoteIdPour('Avis d\'impôt 2026 sur les revenus 2025', 2026);
  assert.equal(ref, '2026#Avis d\'impôt 2026 sur les revenus 2025');

  // 64 caractères hexadécimaux : c'est la forme d'idEnsua, produite au clic.
  assert.equal(/[0-9a-f]{32,}/i.test(ref), false, 'aucun identifiant technique dans la référence');

  // Le même document, relevé deux fois, donne la même référence — c'est tout
  // ce qui empêche de retélécharger dix années à chaque exécution.
  assert.equal(ref, impots.remoteIdPour('Avis d\'impôt 2026 sur les revenus 2025', 2026));

  // La même intitulé sur deux années reste deux documents.
  assert.notEqual(
    impots.remoteIdPour('Déclaration des revenus', 2025),
    impots.remoteIdPour('Déclaration des revenus', 2024)
  );
});

// ---------------------------------------------------------------------------
// Nommage : année, puis nom d'origine — et UNE seule extension
// ---------------------------------------------------------------------------

test('le nom du serveur est repris tel quel, sans doubler le « .pdf »', () => {
  assert.equal(
    impots.nomFichier(2026, 'Avis_d_impot_2026_sur_les_revenus_2025.pdf', 'peu importe'),
    '2026_Avis_d_impot_2026_sur_les_revenus_2025.pdf'
  );
  // Le défaut du script d'exploration : « ….pdf.pdf ».
  assert.equal(
    impots.nomFichier(2026, 'Avis_d_impot_2026_sur_les_revenus_2025.pdf', 'x').endsWith('.pdf.pdf'),
    false
  );
  // Un serveur qui oublie l'extension : on la pose, une fois.
  assert.equal(impots.nomFichier(2025, 'Declaration_2025', 'x'), '2025_Declaration_2025.pdf');
});

test('sans nom de serveur, le libellé prend le relais', () => {
  const nom = impots.nomFichier(2024, null, 'Avis de situation déclarative');
  assert.match(nom, /^2024_/);
  assert.match(nom, /\.pdf$/);
  assert.equal(nom.endsWith('.pdf.pdf'), false);
  // Aucun séparateur de chemin ne peut se glisser dans un nom de fichier.
  assert.equal(/[/\\]/.test(nom), false);
});

test('le nom du fichier commence par son année : le tri chronologique est gratuit', () => {
  const noms = [
    impots.nomFichier(2024, 'Avis.pdf', 'x'),
    impots.nomFichier(2026, 'Avis.pdf', 'x'),
    impots.nomFichier(2025, 'Avis.pdf', 'x'),
  ];
  assert.deepEqual([...noms].sort(), ['2024_Avis.pdf', '2025_Avis.pdf', '2026_Avis.pdf']);
});

test('le nom du fichier se lit dans les en-têtes, sous ses deux formes', () => {
  assert.equal(
    impots.nomDepuisEntetes({
      'content-disposition': 'inline;filename=Avis_d_impot_2026_sur_les_revenus_2025.pdf',
    }),
    'Avis_d_impot_2026_sur_les_revenus_2025.pdf'
  );
  // Le portail renseigne aussi `name=` dans le content-type.
  assert.equal(
    impots.nomDepuisEntetes({
      'Content-Type': 'application/pdf; name=Avis_d_impot_2026_sur_les_revenus_2025.pdf',
    }),
    'Avis_d_impot_2026_sur_les_revenus_2025.pdf'
  );
  assert.equal(impots.nomDepuisEntetes({}), null);
});

// ---------------------------------------------------------------------------
// Navigation par année
// ---------------------------------------------------------------------------

test('l\'adresse d\'une année est documents.do?n=<année>, et n=0 l\'année courante', () => {
  assert.equal(impots.urlAnnee(2025), 'https://cfspart.impots.gouv.fr/enp/documents.do?n=2025');
  assert.equal(impots.urlAnnee(0), 'https://cfspart.impots.gouv.fr/enp/documents.do?n=0');
  assert.equal(impots.urlAnnee(undefined), 'https://cfspart.impots.gouv.fr/enp/documents.do?n=0');
});

test('les années sont relevées dynamiquement, aucune n\'est écrite en dur', () => {
  // Ce que porte réellement la page : dix années, 2017 à 2026.
  const liens = [];
  for (let annee = 2017; annee <= 2026; annee++) {
    liens.push({ href: `documents.do?n=${annee}`, texte: `Année ${annee}` });
  }
  // Du bruit : la page porte aussi de vrais liens de navigation.
  liens.push({ href: '/enp/accueil.do', texte: 'Accueil' });
  liens.push({ href: 'https://www.impots.gouv.fr/', texte: 'impots.gouv.fr' });

  const annees = impots.anneesDepuisLiens(liens);
  assert.equal(annees.length, 10);
  assert.equal(annees[0], 2026, 'la plus récente en tête');
  assert.equal(annees[annees.length - 1], 2017);
});

test('un sélecteur d\'année en double ne fait pas parcourir deux fois la même', () => {
  const annees = impots.anneesDepuisLiens([
    { href: 'documents.do?n=2026', texte: 'Année 2026' },
    { href: 'documents.do?n=2026', texte: 'Année 2026' },
    { href: 'documents.do?n=2025', texte: 'Année 2025' },
  ]);
  assert.deepEqual(annees, [2026, 2025]);
});

test('une page sans sélecteur d\'année ne fabrique pas d\'année', () => {
  assert.deepEqual(impots.anneesDepuisLiens([{ href: '/enp/accueil.do', texte: 'Accueil' }]), []);
  assert.deepEqual(impots.anneesDepuisLiens([]), []);
  assert.deepEqual(impots.anneesDepuisLiens(null), []);
});

// ---------------------------------------------------------------------------
// Expiration de session
// ---------------------------------------------------------------------------

test('la session expirée se reconnaît à connexion, authorize ou oauth', () => {
  assert.equal(
    impots.estPageAuthentification('https://cfspart.impots.gouv.fr/LoginAccess/connexion'),
    true
  );
  assert.equal(
    impots.estPageAuthentification('https://idp.impots.gouv.fr/oauth2/authorize?client_id=x'),
    true
  );
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/oauth/token'), true);

  // Les pages normales du portail ne doivent JAMAIS être prises pour la
  // connexion : déclarer expirée une session valide renverrait l'utilisateur
  // ouvrir un navigateur pour rien.
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/enp/documents.do?n=2025'), false);
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/'), false);
  assert.equal(
    impots.estPageAuthentification(
      'https://cfspart.impots.gouv.fr/enp/Affichage_Document_PDF?idEnsua=' + 'a'.repeat(64)
    ),
    false
  );
  assert.equal(impots.estPageAuthentification(''), false);
});

test('le message de session expirée dit quoi faire, pas ce qui s\'est passé', () => {
  const err = impots.erreurSessionExpiree('redirection');
  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Se connecter à Impots\.gouv\.fr/);
  assert.match(err.message, /code de sécurité/);
});

// ---------------------------------------------------------------------------
// Identifiant de compte
// ---------------------------------------------------------------------------

test('le numéro fiscal nomme le dossier, sinon « compte »', () => {
  assert.equal(impots.compteDepuisTexte('Numéro fiscal : 1234567890123'), '1234567890123');
  // Le numéro saisi dans la fiche prime : il est sûr, la page ne l'est pas.
  assert.equal(
    impots.compteDepuisTexte('rien ici', { numeroFiscal: '12 34 56 78 90 123' }),
    '1234567890123'
  );
  assert.equal(impots.compteDepuisTexte('Bonjour'), 'compte');
  assert.equal(impots.compteDepuisTexte(''), impots.COMPTE_PAR_DEFAUT);
});

// ---------------------------------------------------------------------------
// Profondeur d'historique — le réglage générique du lot 9
// ---------------------------------------------------------------------------

test('les dix années ne sont reparcourues qu\'au premier passage', () => {
  const disponibles = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];
  const juin = new Date('2026-06-15T10:00:00Z');

  const premier = history.anneesAParcourir({
    valeur: 'depuis',
    disponibles,
    maintenant: juin,
    dejaRecupere: false,
  });
  assert.equal(premier.annees.length, 10, 'premier passage : tout le passé, une fois');

  const suivant = history.anneesAParcourir({
    valeur: 'depuis',
    disponibles,
    maintenant: juin,
    dejaRecupere: true,
  });
  assert.deepEqual(suivant.annees, [2026], 'ensuite, l\'année en cours seulement');
});

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

test('le manifeste est valide, et sa description tient en une phrase', () => {
  const controle = schema.validate(manifest, 'impots/manifest.json');
  assert.equal(controle.ok, true, controle.errors.join(' · '));
  assert.equal(manifest.description, 'Récupère automatiquement vos avis d\'impôt et déclarations.');
});

test('le manifeste ouvre une connexion par navigateur, et non un mot de passe', () => {
  assert.equal(manifest.remoteLogin.url, 'https://cfspart.impots.gouv.fr/');
  assert.equal(manifest.remoteLogin.marker, 'Documents');

  const types = manifest.fields.map((f) => f.type);
  assert.ok(types.includes('session'), 'une session capturée au navigateur');
  assert.ok(types.includes('history'), 'le réglage générique de profondeur');
  assert.equal(types.includes('password'), false, 'aucun mot de passe conservé');
});

test('les permissions préviennent que ces documents sont fiscaux', () => {
  const factures = manifest.permissions.find((p) => p.key === 'factures');
  assert.match(factures.description, /INFORMATIONS FISCALES|informations fiscales/i);

  // Le détail technique n'a rien à faire sous les yeux de l'utilisateur : il
  // vit dans le champ réservé à l'administration.
  assert.match(manifest.technicalNote, /idEnsua/);
  assert.match(manifest.technicalNote, /title/i);
  assert.match(manifest.technicalNote, /repli|replié|dépliage/i);
  assert.equal(/idEnsua/.test(manifest.description), false);
});
