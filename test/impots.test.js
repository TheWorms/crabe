'use strict';

/**
 * Le connecteur Impots.gouv.fr, après la refonte de la page des documents
 * (lot 86). Ces tests vérifient ce qui se vérifie sans navigateur :
 *
 *   1. la LECTURE du DOM d'une seule disposition (bureau), titres et jetons ;
 *   2. les COMPTEURS « N documents » de la disposition mobile (complétude) ;
 *   3. l'ANCRAGE : forme gelée pour un titre unique, rang pour les doublons,
 *      et la reprise de l'ancre nue par la taille ;
 *   4. la GARDE : liste blanche d'adresses, et clicAutorise en second filet ;
 *   5. la non-régression des 45 lignes déjà en base.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const impots = require('../server/connectors/available/impots/connector');
const history = require('../server/connectors/history');
const schema = require('../server/connectors/manifest-schema');
const manifest = require('../server/connectors/available/impots/manifest.json');

// ---------------------------------------------------------------------------
// Une fixture écrite À LA MAIN sur la structure réelle (§2 à §6 du lot 86) :
// les DEUX dispositions, titres inventés, jetons factices, un groupe de trois
// titres identiques, un document associé dans un volet replié, un lien de
// navigation, le lien de déconnexion, un bouton « Payer » dans une carte.
// AUCUNE donnée ne vient du fichier de référence.
// ---------------------------------------------------------------------------

const J = (s) => (s + '0'.repeat(96)).slice(0, 96); // jeton factice, 96 hex
const [J1, J2, J3, J4, J5, J6] = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map(J);

const BUREAU = `
<div class="fr-hidden fr-unhidden-md">
 <div class="fr-tabs fr-transition-none" data-fr-js-tabs-group="true">
  <ul class="fr-tabs__list" role="tablist" aria-label="Années">
    <li role="presentation"><button role="tab" id="tab-1" title="2026" aria-controls="tab-1-panel" aria-selected="true">2026<span class="notifNbDoc">1</span>, 1 document non lu</button></li>
    <li role="presentation"><button role="tab" id="tab-2" title="2025" aria-controls="tab-2-panel">2025</button></li>
  </ul>
  <div id="tab-1-panel" class="fr-tabs__panel fr-tabs__panel--selected" role="tabpanel" aria-labelledby="tab-1">
    <div class="fr-grid-row" id="docs-1">
      <div id="doc-1-1" class="fr-col-12 panneau_doc unDocument" data-categories="&nbsp;fiscal tous">
        <div class="fr-card fr-card--no-icon fr-enlarge-link fr-p-3v">
          <h3 id="titre-1-1" class="fr-card__title"><a target="_blank" rel="noopener" class="extLinkDis" aria-label="Avis fictif 2026 (nouvelle fenêtre)" href="Affichage_Document_PDF?idEnsua=${J1}" onclick="return actualiserDocDSFR('1-1')">Avis fictif 2026</a></h3>
          <p class="fr-card__detail">Visualiser le document</p>
        </div>
      </div>
      <div id="doc-1-2" class="repertoire fr-col-12 panneau_doc unDocument" data-categories="&nbsp;fiscal tous">
        <div class="fr-card fr-card--no-icon fr-enlarge-link fr-p-3v">
          <h3 id="titre-1-2" class="fr-card__title"><a target="_blank" rel="noopener" class="extLinkDis" aria-label="Dossier fictif 2026 (nouvelle fenêtre)" href="Affichage_Document_PDF?idEnsua=${J2}">Dossier fictif 2026</a></h3>
          <div id="collapsed-1" data-fr-js-accordions-group="true">
            <section class="fr-accordion">
              <h4 class="fr-accordion__title"><button type="button" aria-expanded="false" id="boutonLie-1-2" aria-controls="collapseGrid-1-2" class="fr-accordion__btn">Documents associés</button></h4>
              <div id="collapseGrid-1-2" class="fr-collapse" data-fr-js-collapse="true">
                <div id="docLie-1-2-1" class="fr-col-12 unDocument" data-categories="&nbsp;fiscal tous">
                  <div class="fr-card fr-card--horizontal"><div class="fr-card__body"><div class="fr-card__content"><div class="fr-card__desc">
                    <p id="titreLie-1-2-1" class="fr-text--lg">Pièce jointe fictive 2026</p>
                    <form action="Affichage_Document_PDF" id="formulaire_lies_collapsed-1" name="formulaire" method="GET" target="_blank" rel="noopener">
                      <input type="hidden" name="idEnsua" value="${J3}">
                      <button type="submit" class="fr-btn fr-icon-eye-line" title="Visualiser Pièce jointe fictive 2026  (nouvelle fenêtre)">Voir</button>
                    </form>
                  </div></div></div></div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="tab-2-panel" class="fr-tabs__panel" role="tabpanel" aria-labelledby="tab-2">
    <div class="fr-grid-row" id="docs-2">
      <div id="doc-2-1" class="fr-col-12 panneau_doc unDocument"><div class="fr-card fr-enlarge-link"><h3 id="titre-2-1" class="fr-card__title"><a target="_blank" rel="noopener" class="extLinkDis" href="Affichage_Document_PDF?idEnsua=${J4}">Relance fictive</a></h3></div></div>
      <div id="doc-2-2" class="fr-col-12 panneau_doc unDocument"><div class="fr-card fr-enlarge-link"><h3 id="titre-2-2" class="fr-card__title"><a target="_blank" rel="noopener" class="extLinkDis" href="Affichage_Document_PDF?idEnsua=${J5}">Relance fictive</a></h3></div></div>
      <div id="doc-2-3" class="fr-col-12 panneau_doc unDocument"><div class="fr-card fr-enlarge-link"><h3 id="titre-2-3" class="fr-card__title"><a target="_blank" rel="noopener" class="extLinkDis" href="Affichage_Document_PDF?idEnsua=${J6}">Relance fictive</a></h3></div></div>
      <button type="button" class="fr-btn">Payer</button>
    </div>
  </div>
 </div>
</div>`;

const NAV = `
<nav class="fr-nav"><ul>
  <li><a class="fr-nav__link" href="/enp/accueilensupres.do">Accueil</a></li>
  <li><a class="fr-nav__link" href="/enp/interpaiements.do">Paiements</a></li>
  <li><a class="fr-nav__link" href="/enp/messagerie.do">Messagerie</a></li>
</ul></nav>
<button aria-controls="modal-deco">Se déconnecter</button>
<dialog id="modal-deco"><a href="/enp/j_spring_security_logout.ex">Se déconnecter</a></dialog>`;

const mobile = (em2026 = 2, em2025 = 3) => `
<div class="fr-accordions-group fr-hidden-md">
  <section class="fr-accordion">
    <h3 class="fr-accordion-annee"><button aria-expanded="false" aria-controls="2026" title="2026">2026</button></h3>
    <div class="fr-collapse" id="2026"><h3 class="fr-h6"><em>${em2026}&nbsp;documents</em></h3>
      <div id="docRwd-1-1"><a href="Affichage_Document_PDF?idEnsua=${J1}">Avis fictif 2026</a></div>
      <div id="docRwd-1-2" class="repertoire"><a href="Affichage_Document_PDF?idEnsua=${J2}">Dossier fictif 2026</a>
        <div id="collapsed-1b"><div id="docLieRwd-1-2-1"><p id="titreRwd-1-2-1">Pièce jointe fictive 2026</p><form action="Affichage_Document_PDF" method="GET"><input type="hidden" name="idEnsua" value="${J3}"></form></div></div>
      </div>
    </div>
  </section>
  <section class="fr-accordion">
    <h3 class="fr-accordion-annee"><button aria-expanded="false" aria-controls="2025" title="2025">2025</button></h3>
    <div class="fr-collapse" id="2025"><h3 class="fr-h6"><em>${em2025}&nbsp;documents</em></h3>
      <div id="docRwd-2-1"><a href="Affichage_Document_PDF?idEnsua=${J4}">Relance fictive</a></div>
      <div id="docRwd-2-2"><a href="Affichage_Document_PDF?idEnsua=${J5}">Relance fictive</a></div>
      <div id="docRwd-2-3"><a href="Affichage_Document_PDF?idEnsua=${J6}">Relance fictive</a></div>
    </div>
  </section>
</div>`;

const PAGE = BUREAU + NAV + mobile();

// ---------------------------------------------------------------------------
// Lecture du DOM : une seule disposition
// ---------------------------------------------------------------------------

test('lireDocumentsDuHtml lit titres et jetons de la disposition bureau', () => {
  const docs = impots.lireDocumentsDuHtml(BUREAU);
  assert.equal(docs.length, 6, '5 principaux + 1 associé');
  // Ordre DOM préservé.
  assert.deepEqual(docs.map((d) => d.titre), [
    'Avis fictif 2026', 'Dossier fictif 2026', 'Pièce jointe fictive 2026',
    'Relance fictive', 'Relance fictive', 'Relance fictive',
  ]);
  // Le titre est le TEXTE du lien, pas l'aria-label (« (nouvelle fenêtre) »).
  assert.equal(docs[0].titre, 'Avis fictif 2026');
  // Jeton du principal (href) et de l'associé (input caché), déjà présents.
  assert.equal(docs[0].jeton, J1);
  assert.equal(docs[2].lie, true);
  assert.equal(docs[2].jeton, J3);
  // Le <k> relie la carte à son onglet.
  assert.deepEqual(docs.map((d) => d.k), [1, 1, 1, 2, 2, 2]);
});

test('MORSURE : lire les DEUX dispositions compterait chaque document deux fois', () => {
  // La page entière porte 12 liens idEnsua (6 bureau + 6 mobile). Le lecteur,
  // lié aux ids de la seule disposition bureau, en rend exactement 6.
  const liens = (PAGE.match(/idEnsua/g) || []).length;
  assert.equal(liens, 12, 'la page porte bien les documents en double');
  assert.equal(impots.lireDocumentsDuHtml(PAGE).length, 6, 'une seule disposition est lue');
});

test('MORSURE : l\'ancien sélecteur ne trouve plus rien sur la nouvelle page', () => {
  // li.row.align-items-center et title="Visualiser PDF" ont disparu.
  assert.equal(/li[^>]*class="[^"]*row[^"]*align-items-center/.test(PAGE), false);
  assert.equal(/title="[^"]*Visualiser PDF/.test(PAGE), false);
  assert.equal(/documents\.do\?n=(?:19|20)\d\d/.test(PAGE), false);
  // Le nouveau lecteur, lui, trouve les documents.
  assert.ok(impots.lireDocumentsDuHtml(PAGE).length > 0);
});

test('les années viennent du title des onglets, pas d\'un lien', () => {
  assert.deepEqual(
    impots.anneesDepuisOnglets([{ title: '2026' }, { title: '2025' }, { title: '' }]),
    [2026, 2025]
  );
  // Le texte visible ajoute « , N document non lu » : seul l'attribut title compte.
  assert.deepEqual(impots.anneesDepuisOnglets([{ title: '2024' }]), [2024]);
  assert.deepEqual(impots.anneesDepuisOnglets([]), []);
});

// ---------------------------------------------------------------------------
// Compteurs de complétude (B4)
// ---------------------------------------------------------------------------

test('compteursDuHtml lit « N documents » par année dans la disposition mobile', () => {
  assert.deepEqual(impots.compteursDuHtml(mobile(2, 3)), { 2026: 2, 2025: 3 });
});

test('MORSURE : un compteur différent du nombre lu doit interdire « à jour »', () => {
  const docs = impots.lireDocumentsDuHtml(BUREAU).filter((d) => !d.lie);
  const parAnnee = { 2026: 0, 2025: 0 };
  const anneeDuK = { 1: '2026', 2: '2025' };
  for (const d of docs) parAnnee[anneeDuK[d.k]]++;
  // Page saine : les compteurs correspondent.
  const sains = impots.compteursDuHtml(mobile(2, 3));
  assert.equal(sains['2026'], parAnnee['2026']);
  assert.equal(sains['2025'], parAnnee['2025']);
  // Page faussée : 2025 annonce 4 pour 3 lus → écart détecté.
  const faux = impots.compteursDuHtml(mobile(2, 4));
  assert.notEqual(faux['2025'], parAnnee['2025']);
});

// ---------------------------------------------------------------------------
// Ancrage — le point critique (B3)
// ---------------------------------------------------------------------------

test('un titre unique dans son année garde l\'ancre nue, forme gelée', () => {
  const { ancres } = impots.deciderAncresGroupe(
    { libelle: 'Avis d\'impôt 2026 sur les revenus 2025', annee: 2026 },
    [{ domIndex: 0, taille: 164876 }],
    { bareEnBase: false, tailleBase: null }
  );
  assert.equal(ancres[0].remoteId, '2026#Avis d\'impôt 2026 sur les revenus 2025');
  assert.equal(ancres[0].repris, false);
  // Jamais un idEnsua dans l'ancre.
  assert.equal(/[0-9a-f]{32,}/i.test(ancres[0].remoteId), false);
});

test('MORSURE : sans discriminant, trois titres identiques donnent UNE seule ancre', () => {
  const libelle = 'Notification d\'avis à tiers détenteur';
  // L'ancienne ancre nue, répétée : le groupe s'effondre sur une seule clé.
  const nues = [0, 1, 2].map(() => impots.remoteIdPour(libelle, 2021));
  assert.equal(new Set(nues).size, 1, 'c\'est le défaut que le lot corrige');
  // La nouvelle décision donne trois ancres distinctes.
  const { ancres } = impots.deciderAncresGroupe(
    { libelle, annee: 2021 },
    [{ domIndex: 0 }, { domIndex: 1 }, { domIndex: 2 }],
    { bareEnBase: false, tailleBase: null }
  );
  assert.equal(new Set(ancres.map((a) => a.remoteId)).size, 3);
});

test('le rang se compte depuis le plus ancien (le bas du DOM)', () => {
  // DOM : index 0 en haut (plus récent), index 2 en bas (plus ancien).
  const { ancres } = impots.deciderAncresGroupe(
    { libelle: 'Mise en demeure de payer', annee: 2021 },
    [{ domIndex: 0 }, { domIndex: 1 }, { domIndex: 2 }],
    { bareEnBase: false, tailleBase: null }
  );
  // Le plus ancien (bas) = #1 ; le plus récent (haut) = #3.
  assert.equal(ancres[2].remoteId, '2021#Mise en demeure de payer#1');
  assert.equal(ancres[1].remoteId, '2021#Mise en demeure de payer#2');
  assert.equal(ancres[0].remoteId, '2021#Mise en demeure de payer#3');
  // Un document neuf arrive EN HAUT (#4) sans décaler #1, #2, #3.
});

test('une correspondance de taille unique fait REPRENDRE l\'ancre nue', () => {
  const libelle = 'Mise en demeure de payer';
  const { ancres, doublonPossible } = impots.deciderAncresGroupe(
    { libelle, annee: 2021 },
    [{ domIndex: 0, taille: 50000 }, { domIndex: 1, taille: 99030 }],
    { bareEnBase: true, tailleBase: 99030 }
  );
  // Le membre à 99030 octets EST la ligne déjà en base : il la reprend.
  const repris = ancres.find((a) => a.repris);
  assert.ok(repris, 'un membre reprend l\'ancre nue');
  assert.equal(repris.remoteId, '2021#Mise en demeure de payer');
  // L'autre prend son rang, et aucun doublon n'est annoncé.
  assert.equal(doublonPossible, false);
  assert.equal(ancres.filter((a) => !a.repris).length, 1);
  assert.match(ancres.find((a) => !a.repris).remoteId, /#\d+$/);
});

test('sans correspondance unique, on ne devine pas : rangs partout, doublon annoncé', () => {
  const libelle = 'Mise en demeure de payer';
  const { ancres, doublonPossible } = impots.deciderAncresGroupe(
    { libelle, annee: 2021 },
    [{ domIndex: 0, taille: 50000 }, { domIndex: 1, taille: 60000 }],
    { bareEnBase: true, tailleBase: 99030 } // aucune taille ne correspond
  );
  assert.equal(ancres.every((a) => !a.repris), true);
  assert.equal(ancres.every((a) => /#\d+$/.test(a.remoteId)), true);
  assert.equal(doublonPossible, true, 'la ligne nue reste, un doublon est possible');
});

// ---------------------------------------------------------------------------
// Garde : liste blanche d'adresses (B2)
// ---------------------------------------------------------------------------

test('la liste blanche n\'autorise que documents.do et Affichage_Document_PDF', () => {
  assert.equal(impots.adresseAutorisee('https://cfspart.impots.gouv.fr/enp/documents.do?n=0'), true);
  assert.equal(
    impots.adresseAutorisee('Affichage_Document_PDF?idEnsua=' + 'a'.repeat(96)),
    true,
    'adresse relative d\'un document'
  );
  // Tout le reste est refusé.
  for (const url of [
    'https://cfspart.impots.gouv.fr/enp/interpaiements.do',
    'https://cfspart.impots.gouv.fr/enp/messagerie.do',
    'https://cfspart.impots.gouv.fr/enp/j_spring_security_logout.ex',
    'https://cfspart.impots.gouv.fr/enp/Affichage_Document_PDF', // sans idEnsua
    'https://example.com/enp/documents.do', // mauvais domaine
    'https://cfspart-idp.impots.gouv.fr/oauth2/authorize',
  ]) {
    assert.equal(impots.adresseAutorisee(url), false, `autorisée à tort : ${url}`);
  }
});

test('formeAdresse journalise le chemin, jamais la valeur du jeton', () => {
  const forme = impots.formeAdresse('Affichage_Document_PDF?idEnsua=' + 'a'.repeat(96));
  assert.match(forme, /Affichage_Document_PDF/);
  assert.match(forme, /idEnsua=…/);
  assert.equal(/a{32,}/.test(forme), false, 'aucun jeton dans le journal');
});

// ---------------------------------------------------------------------------
// clicAutorise — le second filet, derrière la liste blanche
// ---------------------------------------------------------------------------

const DOCUMENTS_REELS = [
  'Avis d\'impôt 2026 sur les revenus 2025',
  'Déclaration smartphone des revenus 2025 (le 11/04/2026, à 22:22)',
  'Avis de situation déclarative à l\'impôt 2024 sur les revenus 2023',
  'Mise en demeure de payer',
  'Mise en demeure de payer avec majoration',
  'Impôt sur les revenus 2023 – Rejet de prélèvement',
  'Notification d\'avis à tiers détenteur',
  'Lettre de relance impôt sur les revenus',
];

const BOUTONS_PIEGES = [
  'Payer',
  'Corriger ma déclaration',
  'Télécharger et payer',
  'Déclarer mes revenus',
  'Adhérer au prélèvement à la source',
  'Valider et signer',
  'Modifier ma situation',
  'Écrire à la messagerie sécurisée',
  'Se déconnecter',
  'Déconnexion',
  '« Visualiser PDF »  Payer votre solde en ligne',
];

test('clicAutorise laisse passer les documents réels, même sans préfixe', () => {
  for (const titre of DOCUMENTS_REELS) {
    assert.equal(impots.clicAutorise(titre), true, `document refusé à tort : ${titre}`);
  }
  // « payer »/« prélèvement » au MILIEU ne sont pas des actions.
  assert.equal(impots.libelleEvoqueUneAction('Mise en demeure de payer'), false);
  assert.equal(impots.libelleEvoqueUneAction('Rejet de prélèvement'), false);
  assert.equal(impots.libelleEvoqueUneAction('Payer votre solde'), true);
  // « Déclaration » (le document) n'est pas « déclarer » (l'action).
  assert.equal(impots.libelleEvoqueUneAction('Déclaration des revenus 2024'), false);
});

test('clicAutorise refuse les boutons d\'action et de déconnexion', () => {
  for (const titre of BOUTONS_PIEGES) {
    assert.equal(impots.clicAutorise(titre), false, `autorisé à tort : ${titre}`);
  }
  assert.equal(impots.libelleEstDeconnexion('Se déconnecter'), true);
  assert.equal(impots.libelleEstDeconnexion('Déconnexion'), true);
});

// ---------------------------------------------------------------------------
// Expiration de session
// ---------------------------------------------------------------------------

test('la session expirée se reconnaît à connexion, authorize ou oauth', () => {
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/LoginAccess/connexion'), true);
  assert.equal(impots.estPageAuthentification('https://cfspart-idp.impots.gouv.fr/oauth2/authorize?client_id=x'), true);
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/oauth/token'), true);
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/enp/documents.do?n=2025'), false);
  assert.equal(impots.estPageAuthentification('https://cfspart.impots.gouv.fr/'), false);
  assert.equal(impots.estPageAuthentification(''), false);
});

test('le message de session expirée dit quoi faire, pas ce qui s\'est passé', () => {
  const err = impots.erreurSessionExpiree('redirection');
  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Se connecter à Impots\.gouv\.fr/);
  assert.match(err.message, /code de sécurité/);
});

// ---------------------------------------------------------------------------
// Nommage et identifiant de compte
// ---------------------------------------------------------------------------

test('le nom du fichier commence par l\'année et finit par .pdf, une seule fois', () => {
  assert.equal(impots.nomFichier(2026, 'Avis d\'impôt 2026 sur les revenus 2025'), '2026_Avis_d_impot_2026_sur_les_revenus_2025.pdf');
  assert.equal(impots.nomFichier(2025, 'Déclaration.pdf').endsWith('.pdf.pdf'), false);
  const noms = [impots.nomFichier(2024, 'x'), impots.nomFichier(2026, 'x'), impots.nomFichier(2025, 'x')];
  assert.deepEqual([...noms].sort(), ['2024_x.pdf', '2025_x.pdf', '2026_x.pdf']);
  // Aucun séparateur de chemin ne peut se glisser dans un nom.
  assert.equal(/[/\\]/.test(impots.nomFichier(2024, 'a/b\\c')), false);
});

test('le numéro fiscal nomme le dossier, sinon « compte »', () => {
  assert.equal(impots.compteDepuisTexte('Numéro fiscal : 1234567890123'), '1234567890123');
  assert.equal(impots.compteDepuisTexte('rien', { numeroFiscal: '12 34 56 78 90 123' }), '1234567890123');
  assert.equal(impots.compteDepuisTexte('Bonjour'), 'compte');
  assert.equal(impots.compteDepuisTexte(''), impots.COMPTE_PAR_DEFAUT);
});

// ---------------------------------------------------------------------------
// Profondeur d'historique
// ---------------------------------------------------------------------------

test('les dix années ne sont reparcourues qu\'au premier passage', () => {
  const disponibles = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];
  const juin = new Date('2026-06-15T10:00:00Z');
  assert.equal(history.anneesAParcourir({ valeur: 'depuis', disponibles, maintenant: juin, dejaRecupere: false }).annees.length, 10);
  assert.deepEqual(history.anneesAParcourir({ valeur: 'depuis', disponibles, maintenant: juin, dejaRecupere: true }).annees, [2026]);
});

// ---------------------------------------------------------------------------
// Non-régression des 45 lignes déjà en base
// ---------------------------------------------------------------------------

// Les remote_id réels en base (relevés le 04/10/2026, aucune valeur personnelle
// au-delà du couple année+libellé que le portail affiche publiquement). La
// reconstruction par remoteIdPour doit rendre EXACTEMENT la même chaîne, sinon
// dix années seraient retéléchargées.
const ANCRES_EN_BASE = [
  '2017#Avis d\'impôt 2017 sur les revenus 2016',
  '2017#Avis de situation déclarative à l\'impôt 2017 sur les revenus 2016 (le 30/05/2017, à 15:49)',
  '2018#Avis d\'impôt 2018 sur les revenus 2017',
  '2019#Mise en demeure de payer',
  '2020#Déclaration automatique : vos informations connues de l\'administration (revenus 2019)',
  '2020#Impôt sur les revenus 2020 – Rejet de prélèvement',
  '2020#Notification d\'avis à tiers détenteur',
  '2021#Avis supplémentaire d\'impôt 2021 sur les revenus 2020',
  '2023#Mise en demeure de payer avec majoration',
  '2024#Avis d\'impôt 2024 sur les revenus 2023',
  '2025#Avis de situation déclarative smartphone à l\'impôt 2025 sur les revenus 2024 (le 22/04/2025, à 14:32)',
  '2026#Avis d\'impôt 2026 sur les revenus 2025',
];

test('les ancres déjà en base restent reconnues (non-régression des 45)', () => {
  for (const ancre of ANCRES_EN_BASE) {
    const sep = ancre.indexOf('#');
    const annee = ancre.slice(0, sep);
    const libelle = ancre.slice(sep + 1);
    const reconstruite = impots.remoteIdPour(impots.libelleDepuisTitre(libelle), annee);
    assert.equal(reconstruite, ancre, `ancre reconstruite ≠ stockée : ${ancre}`);
    // Aucun identifiant technique dans la forme.
    assert.equal(/[0-9a-f]{32,}/i.test(reconstruite), false);
  }
});

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

test('le manifeste est valide, et sa description tient en une phrase', () => {
  const controle = schema.validate(manifest, 'impots/manifest.json');
  assert.equal(controle.ok, true, controle.errors.join(' · '));
  assert.equal(manifest.description, 'Récupère automatiquement vos avis d\'impôt et déclarations.');
});

test('la preuve de session passe par la tenue de documents.do', () => {
  assert.equal(manifest.remoteLogin.verifyUrl, 'https://cfspart.impots.gouv.fr/enp/documents.do');
  assert.equal(manifest.remoteLogin.verifyUrlTient, true);
  assert.equal(manifest.remoteLogin.renvoiAnonyme, 'connexion');
  assert.notEqual(new URL(manifest.remoteLogin.verifyUrl).pathname, '/');
});

test('le manifeste ouvre une connexion par navigateur, et non un mot de passe', () => {
  assert.equal(manifest.remoteLogin.url, 'https://cfspart.impots.gouv.fr/');
  assert.equal(manifest.remoteLogin.marker, 'Documents');
  const types = manifest.fields.map((f) => f.type);
  assert.ok(types.includes('session'));
  assert.ok(types.includes('history'));
  assert.equal(types.includes('password'), false);
});

test('la note technique décrit la nouvelle page, sans jeton sous les yeux de l\'utilisateur', () => {
  const factures = manifest.permissions.find((p) => p.key === 'factures');
  assert.match(factures.description, /INFORMATIONS FISCALES|informations fiscales/i);
  // La note technique dit la refonte : deux dispositions, jeton, rang.
  assert.match(manifest.technicalNote, /idEnsua/);
  assert.match(manifest.technicalNote, /title/i);
  assert.match(manifest.technicalNote, /disposition|bureau|mobile/i);
  assert.match(manifest.technicalNote, /rang|doublon|identique/i);
  // idEnsua n'est pas sous les yeux de l'utilisateur.
  assert.equal(/idEnsua/.test(manifest.description), false);
});
