'use strict';

/**
 * §2.1 du lot 14 — chaque situation produit bien SON message.
 *
 * C'est la preuve exigée pour ce point : le tableau du prompt, ligne par
 * ligne, exercé sur la fonction de correspondance. Il n'y a pas de navigateur
 * ici, et il n'en faut pas : `situationDepuis()` est pure, elle reçoit ce qui a
 * été observé et rend une situation.
 *
 * Ce que ce fichier protège, c'est la leçon la plus chère du lot 13 : crabe a
 * affiché « Adresse électronique ou mot de passe incorrect » sur des
 * identifiants parfaitement corrects, et une session de test entière est partie
 * à les vérifier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const echecs = require('../server/connectors/messages-echec');

// ---------------------------------------------------------------------------
// Le tableau du §2.1, ligne par ligne
// ---------------------------------------------------------------------------

test('connexion non confirmée + erreur affichée par la boutique → identifiants', () => {
  const situation = echecs.situationDepuis({
    confirme: false,
    alerte: 'Authentication failed',
  });

  assert.equal(situation, 'identifiants-refuses');
  assert.match(
    echecs.messagePour(situation),
    /Adresse électronique ou mot de passe incorrect\. Corrigez-les sur la fiche du service, puis relancez\./
  );
});

test('connexion non confirmée + AUCUNE erreur affichée → refus sans raison', () => {
  const situation = echecs.situationDepuis({ confirme: false, alerte: '' });

  assert.equal(situation, 'refus-sans-raison');
  assert.match(
    echecs.messagePour(situation),
    /La boutique n'a pas accepté la connexion sans dire pourquoi\. Ce service doit être adapté — signalez-le\./
  );

  // LE point du lot : ce message-là ne parle pas de mot de passe. C'est très
  // exactement le cas de Propolia, Kubii et L'Île aux Épices en production.
  assert.doesNotMatch(
    echecs.messagePour(situation),
    /mot de passe|identifiant/i,
    'sans message de la boutique, on n\'accuse pas le mot de passe'
  );
});

test('un élément recouvre le formulaire → fenêtre du site, jamais un refus', () => {
  const situation = echecs.situationDepuis({ confirme: false, obstrue: true });

  assert.equal(situation, 'obstruction');
  assert.match(
    echecs.messagePour(situation),
    /Une fenêtre du site empêche la connexion\. Ce service doit être adapté — signalez-le\./
  );
  assert.doesNotMatch(echecs.messagePour(situation), /mot de passe|identifiant/i);

  // « bandeau de cookies » n'est pas un diagnostic générique (§2.3) :
  // l'obstacle d'Aagaard est une fenêtre promotionnelle.
  assert.doesNotMatch(
    echecs.messagePour(situation),
    /cookie/i,
    'ne nomme la régie que si elle a été reconnue'
  );
});

test('une obstruction prime sur l\'absence de message de la boutique', () => {
  // Le clic n'a jamais atteint le bouton : la boutique n'a donc rien refusé,
  // et l'absence d'alerte ne prouve rien. C'est l'inversion qui a coûté le
  // plus de temps au lot 12.
  assert.equal(
    echecs.situationDepuis({ confirme: false, obstrue: true, alerte: '' }),
    'obstruction'
  );
  // Et même si un message traîne sur la page : le clic n'a rien envoyé.
  assert.equal(
    echecs.situationDepuis({ confirme: false, obstrue: true, alerte: 'Erreur' }),
    'obstruction'
  );
});

test('connexion confirmée PUIS perdue plus loin → session interrompue', () => {
  const situation = echecs.situationDepuis({ confirme: false, apresConfirmation: true });

  assert.equal(situation, 'session-perdue');
  assert.match(
    echecs.messagePour(situation),
    /La connexion à ce service a été interrompue\. Relancez depuis la fiche du service\./
  );
  assert.doesNotMatch(
    echecs.messagePour(situation),
    /mot de passe/i,
    'une session perdue après une connexion prouvée n\'accuse pas les identifiants'
  );
});

test('page inatteignable → le site n\'a pas répondu', () => {
  const situation = echecs.situationDepuis({ injoignable: true });

  assert.equal(situation, 'injoignable');
  assert.match(echecs.messagePour(situation), /Le site n'a pas répondu\. Réessayez plus tard\./);
});

test('une connexion confirmée ne produit aucune situation d\'échec', () => {
  assert.equal(echecs.situationDepuis({ confirme: true }), null);
  assert.equal(echecs.situationDepuis({ confirme: true, apresConfirmation: true }), null);
});

// ---------------------------------------------------------------------------
// Les invariants du module
// ---------------------------------------------------------------------------

test('aucun message ne nomme de service, ni n\'interpole quoi que ce soit', () => {
  // §2.2 : un message stocké dans `last_error` finit par s'afficher ailleurs.
  // « crabe ne réessaiera pas tout seul sur Propolia » lu sur la fiche
  // d'Aagaard n'est pas une erreur d'affichage, c'est un message mal écrit.
  for (const cle of echecs.CLES) {
    const message = echecs.messagePour(cle);
    assert.doesNotMatch(message, /\$\{/, `${cle} ne doit rien interpoler`);
    assert.ok(message.length > 20, `${cle} doit dire quelque chose`);
    // Un message se termine par une phrase complète, ponctuation comprise.
    assert.match(message, /[.!]$/, `${cle} doit être une phrase finie`);
  }
});

test('chaque message porte SA propre action : il n\'y a rien à y ajouter', () => {
  // C'est l'invariant sur lequel l'interface s'appuie pour afficher le message
  // TEL QUEL. Tant qu'il tient, personne n'a de raison de compléter la phrase
  // après coup — et c'est justement ce complément qui, ajouté sans regarder la
  // cause, a fait dire « corrigez vos identifiants » à une obstruction.
  const ACTIONS = {
    'identifiants-refuses': /Corrigez-les sur la fiche du service, puis relancez\.$/,
    'refus-sans-raison': /Ce service doit être adapté — signalez-le\.$/,
    obstruction: /Ce service doit être adapté — signalez-le\.$/,
    'session-perdue': /Relancez depuis la fiche du service\.$/,
    injoignable: /Réessayez plus tard\.$/,
  };

  assert.deepEqual(
    echecs.CLES.slice().sort(),
    Object.keys(ACTIONS).sort(),
    'une situation ajoutée doit déclarer ici l\'action qu\'elle porte'
  );
  for (const [cle, action] of Object.entries(ACTIONS)) {
    assert.match(echecs.messagePour(cle), action, `${cle} doit finir par son action`);
  }
});

test('seule la cause « identifiants » a le droit de parler d\'identifiants', () => {
  for (const cle of echecs.CLES) {
    const message = echecs.messagePour(cle);
    if (cle === 'identifiants-refuses') {
      assert.match(message, /mot de passe/i, 'la seule cause qui les accuse doit les nommer');
      continue;
    }
    assert.doesNotMatch(
      message,
      /mot de passe|identifiant/i,
      `${cle} n'accuse pas les identifiants — sa première phrase les innocente`
    );
  }
});

test('chaque message dit QUOI FAIRE, jamais ce qui a planté', () => {
  const jargon = /HTTP \d|timeout|selector|locator|null|undefined|stack|exception/i;
  for (const cle of echecs.CLES) {
    assert.doesNotMatch(echecs.messagePour(cle), jargon, `${cle} ne doit pas jargonner`);
  }
});

test('`erreurPour` produit une erreur affichable, avec sa précision au journal', () => {
  const err = echecs.erreurPour('refus-sans-raison', {
    interne: 'URL finale https://propolia.com/fr/connexion?back=history',
  });

  assert.equal(err.expose, true, 'destinée à l\'utilisateur, affichable telle quelle');
  assert.equal(err.situation, 'refus-sans-raison');
  // La précision technique est PORTÉE par l'erreur, jamais collée au message.
  assert.match(err.interne, /propolia\.com/);
  assert.doesNotMatch(err.message, /propolia\.com/);
});

test('`sessionExpired` distingue ce qui se résout par une reconnexion', () => {
  // Ce drapeau décide du bouton proposé (connectors/health.js) : « Se
  // reconnecter » quand l'identité est en cause, « Réessayer » sinon.
  assert.equal(echecs.erreurPour('identifiants-refuses').sessionExpired, true);
  assert.equal(echecs.erreurPour('session-perdue').sessionExpired, true);

  // Une obstruction ne se résout PAS en se reconnectant : marquer la session
  // expirée enverrait ressaisir des identifiants parfaitement valides.
  assert.equal(echecs.erreurPour('obstruction').sessionExpired, false);
  assert.equal(echecs.erreurPour('injoignable').sessionExpired, false);
});

test('une situation inconnue lève plutôt que de choisir un message au hasard', () => {
  assert.throws(() => echecs.messagePour('peut-etre'), /Situation d'échec inconnue/);
  assert.throws(() => echecs.erreurPour(''), /Situation d'échec inconnue/);
});

// ---------------------------------------------------------------------------
// Lot 37 — plus aucun message brut d'automatisation à l'écran
//
// Les 17 et 18/08/2026, l'écran a affiché tel quel « page.fill: Timeout
// 45000ms exceeded. Call log: - waiting for locator('input#…') » pour EDF et
// Ameli. Ces tests injectent les messages RÉELS de production : si quelqu'un
// retire la traduction du point d'écriture unique, ils tombent.
// ---------------------------------------------------------------------------

const MESSAGE_BRUT_EDF =
  'page.fill: Timeout 45000ms exceeded.\nCall log:\n'
  + "  - waiting for locator('input#password2-password-field')";
const MESSAGE_BRUT_AMELI =
  'page.fill: Timeout 45000ms exceeded.\nCall log:\n'
  + "  - waiting for locator('input#connexioncompte_2nir_ass')";

test('les erreurs brutes de production (EDF, Ameli) ne peuvent plus atteindre l\'écran', () => {
  for (const brut of [MESSAGE_BRUT_EDF, MESSAGE_BRUT_AMELI]) {
    const affiche = echecs.messageJamaisVide(brut);
    assert.doesNotMatch(affiche, /page\.fill|locator|Timeout|Call log/i, affiche);
    assert.match(affiche, /signalez-le/i, 'le message dit quoi faire');
    assert.match(affiche, /écran attendu/, 'le message dit ce qui s\'est passé');
  }
});

test('le texte brut écarté part au journal, jamais perdu', () => {
  const journal = [];
  const affiche = echecs.messageJamaisVide(MESSAGE_BRUT_EDF, 'recuperation', (b) => journal.push(b));
  assert.equal(affiche, echecs.MESSAGE_ECRAN_AUTOMATISATION);
  assert.equal(journal.length, 1);
  assert.match(journal[0], /password2-password-field/, 'le sélecteur reste lisible au journal');
});

test('la garde reconnaît les autres formes brutes, et laisse passer les phrases rédigées', () => {
  const brutes = [
    'locator.click: Timeout 45000ms exceeded.',
    'page.goto: net::ERR_CONNECTION_REFUSED at https://exemple.fr/',
    'Target page, context or browser has been closed',
    'Execution context was destroyed, most likely because of a navigation',
    '<footer class="x"> from <div class="chakra-portal"> subtree intercepts pointer events',
  ];
  for (const brut of brutes) {
    assert.equal(echecs.porteDuJargon(brut), true, brut);
    assert.equal(echecs.sansJargon(brut), echecs.MESSAGE_ECRAN_AUTOMATISATION, brut);
  }

  const redigees = [
    'Votre connexion à SoundCloud a expiré. Rouvrez-la depuis la fiche du service.',
    'Connexion à Deezer valide, mais aucun paiement n\'a été reconnu.',
    'La page de connexion d\'EDF n\'a pas présenté le champ d\'identifiant attendu.',
    '',
  ];
  for (const phrase of redigees) {
    assert.equal(echecs.porteDuJargon(phrase), false, phrase);
    assert.equal(echecs.sansJargon(phrase), phrase);
  }
});

test('un journal qui lève ne fait jamais échouer la traduction', () => {
  const affiche = echecs.sansJargon(MESSAGE_BRUT_AMELI, () => { throw new Error('disque plein'); });
  assert.equal(affiche, echecs.MESSAGE_ECRAN_AUTOMATISATION);
});
