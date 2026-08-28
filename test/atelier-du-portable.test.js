'use strict';

/**
 * Le connecteur L'Atelier du Portable.
 *
 * Ce qui est vérifié ici est ce qui distingue ce connecteur de tous les autres :
 *
 *   - la lecture des commandes dans le TEXTE de la page — les trois sections
 *     n'ont pas la même structure HTML, mais toutes écrivent la même phrase ;
 *   - l'URL de facture CONSTRUITE depuis le numéro, sans ouvrir chaque fiche ;
 *   - deux domaines pour un seul compte, et une seule session ;
 *   - « vérifie plutôt que de présumer » : une commande sans état lisible est
 *     tentée, et c'est le contenu de la réponse qui tranche.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const atelier = require('../server/connectors/available/atelier-du-portable/connector');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const identity = require('../server/connectors/browser-identity');

const DOSSIER = path.join(
  __dirname, '..', 'server', 'connectors', 'available', 'atelier-du-portable'
);
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(DOSSIER, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Un connecteur à part
// ---------------------------------------------------------------------------

test('le service est disponible, avec son propre code', () => {
  const chargement = registry.load();
  assert.deepEqual(chargement.errors, []);

  const entree = registry.get('atelier-du-portable');
  assert.equal(entree.planned, false);
  assert.equal(typeof entree.module.fetchInvoices, 'function');

  // Ce n'est PAS une boutique PrestaShop de plus : système sur mesure posé sur
  // WordPress, dont ni les URL ni la structure ne ressemblent aux sept autres.
  assert.notEqual(entree.manifest.implementation, 'prestashop');
  assert.ok(fs.existsSync(path.join(DOSSIER, 'connector.js')), 'son propre connector.js');
});

test('deux domaines, un seul compte — et une seule session', () => {
  // La connexion se fait sur atelierduportable.com, les commandes vivent sur
  // piece-pc-portable.com. Les cookies couvrent les deux.
  assert.equal(atelier.URL_CONNEXION, 'https://www.atelierduportable.com/connexion/');
  assert.match(atelier.URL_COMMANDES, /^https:\/\/www\.piece-pc-portable\.com\//);
  assert.match(atelier.URL_FACTURE, /^https:\/\/www\.piece-pc-portable\.com\//);

  // Un seul champ de session, donc une seule connexion à ouvrir.
  const sessions = MANIFESTE.fields.filter((f) => f.type === 'session');
  assert.equal(sessions.length, 1);
  assert.equal(MANIFESTE.remoteLogin.url, atelier.URL_CONNEXION);
});

// ---------------------------------------------------------------------------
// Lire les commandes
// ---------------------------------------------------------------------------

/** La page telle qu'elle se lit, avec ses trois sections. */
const PAGE = `
  Vos commandes de pièces neuves

  Commandes non validées
  Commande N° WEB120826999001 du 12/08/2026 (non validé)

  Commandes en cours
  Commande N° WEB010826445120 du 01/08/2026 (en cours de préparation)

  Commandes terminées
  Commande N° WEB070526334252 du 07/05/2026 (terminé)
  Commande N° WEB120325112233 du 12/03/2025 (terminé)

  Votre compte : camille@exemple.fr
`;

test('les commandes se lisent dans le texte, avec leur numéro et leur date', () => {
  const commandes = atelier.commandesDepuisTexte(PAGE);

  assert.equal(commandes.length, 4);
  assert.deepEqual(commandes.map((c) => c.numero), [
    'WEB120826999001', 'WEB010826445120', 'WEB070526334252', 'WEB120325112233',
  ]);
  assert.equal(commandes[2].issuedOn, '2026-05-07', '« du 07/05/2026 » → 2026-05-07');
  assert.equal(commandes[3].issuedOn, '2025-03-12');
  assert.equal(commandes[2].etat, 'terminé');
});

test('les écritures du « N° » varient, la lecture non', () => {
  const variantes = atelier.commandesDepuisTexte(`
    Commande N° WEB111 du 01/01/2026 (terminé)
    Commande No WEB222 du 02/01/2026 (terminé)
    Commande n° WEB333 du 03/01/2026
    Commande N°WEB444 du 04/01/2026 (terminé)
  `);

  assert.deepEqual(variantes.map((c) => c.numero), ['WEB111', 'WEB222', 'WEB333', 'WEB444']);
  assert.equal(variantes[2].etat, '', 'un état absent n\'empêche pas la lecture');
});

test('une commande vue deux fois ne compte qu\'une fois', () => {
  const commandes = atelier.commandesDepuisTexte(
    'Commande N° WEB070526334252 du 07/05/2026 (terminé) '
    + 'Commande N° WEB070526334252 du 07/05/2026 (terminé)'
  );
  assert.equal(commandes.length, 1);
});

test('une page sans commande ne renvoie rien, plutôt que d\'inventer', () => {
  assert.deepEqual(atelier.commandesDepuisTexte('Vous n\'avez aucune commande.'), []);
  assert.deepEqual(atelier.commandesDepuisTexte(''), []);
  assert.deepEqual(atelier.commandesDepuisTexte(null), []);
});

test('deux lectures d\'affilée donnent le même résultat', () => {
  // L'expression est globale : la réutiliser telle quelle d'un appel à l'autre
  // conserverait son curseur et sauterait une commande sur deux.
  const une = atelier.commandesDepuisTexte(PAGE);
  const deux = atelier.commandesDepuisTexte(PAGE);
  assert.deepEqual(deux, une);
});

// ---------------------------------------------------------------------------
// L'URL construite plutôt que cherchée
// ---------------------------------------------------------------------------

test('l\'adresse de la facture se construit depuis le numéro de la liste', () => {
  // La liste ne porte PAS le lien : il faut ouvrir la fiche pour l'y trouver.
  // Mais le schéma est fixe, et le numéro est déjà là — trente commandes
  // coûtent donc zéro chargement de page au lieu de trente.
  assert.equal(
    atelier.urlFacture('WEB070526334252'),
    'https://www.piece-pc-portable.com/inter_renvoi.php?dir=FACT&num_com=WEB070526334252'
  );

  // Chaque commande lue donne une adresse utilisable, sans autre requête.
  for (const commande of atelier.commandesDepuisTexte(PAGE)) {
    const url = atelier.urlFacture(commande.numero);
    assert.match(url, /^https:\/\/www\.piece-pc-portable\.com\/inter_renvoi\.php\?dir=FACT&num_com=WEB\d+$/);
  }
});

test('un numéro biscornu est échappé, jamais recopié tel quel dans l\'URL', () => {
  assert.equal(
    atelier.urlFacture('WEB1&dir=AUTRE'),
    'https://www.piece-pc-portable.com/inter_renvoi.php?dir=FACT&num_com=WEB1%26dir%3DAUTRE'
  );
});

// ---------------------------------------------------------------------------
// Vérifier plutôt que présumer
// ---------------------------------------------------------------------------

test('les terminées sont tentées, les autres écartées — mais rien n\'est présumé', () => {
  const commandes = atelier.commandesDepuisTexte(PAGE);

  assert.equal(atelier.peutAvoirUneFacture(commandes[0]), false, 'non validé');
  assert.equal(atelier.peutAvoirUneFacture(commandes[1]), false, 'en cours de préparation');
  assert.equal(atelier.peutAvoirUneFacture(commandes[2]), true, 'terminé');

  // Un état illisible n'exclut PAS : on tente, et c'est le contenu de la
  // réponse qui tranche. Une commande facturée par avance ne serait pas ratée.
  assert.equal(atelier.peutAvoirUneFacture({ numero: 'WEB9', etat: '' }), true);
  assert.equal(atelier.peutAvoirUneFacture({ numero: 'WEB9' }), true);
});

test('le contenu tranche, jamais le type déclaré', () => {
  // Une commande pas encore facturée renvoie une page, avec un en-tête qui
  // peut dire n'importe quoi. Ce n'est pas une erreur : c'est un « pas encore ».
  assert.equal(identity.estPdf(Buffer.from('%PDF-1.4\nfacture', 'latin1')), true);
  assert.equal(
    identity.estPdf(Buffer.from('<!DOCTYPE html><p>Facture indisponible', 'latin1')),
    false
  );

  const source = fs.readFileSync(path.join(DOSSIER, 'connector.js'), 'utf8');
  assert.match(source, /identity\.estPdf\(buffer\)/, 'le contrôle est bien appliqué');
});

// ---------------------------------------------------------------------------
// Dépôt et déduplication
// ---------------------------------------------------------------------------

test('le remoteId est le numéro WEB…, stable d\'une exécution à l\'autre', () => {
  assert.equal(atelier.remoteIdPour('WEB070526334252'), 'commande-WEB070526334252');
  assert.equal(
    atelier.remoteIdPour('web070526334252'),
    'commande-WEB070526334252',
    'la casse ne doit pas créer un doublon'
  );
});

test('le fichier se nomme AAAA-MM_<numéro>.pdf', () => {
  assert.equal(
    atelier.nomFichier('2026-05-07', 'WEB070526334252'),
    '2026-05_WEB070526334252.pdf'
  );
  assert.equal(atelier.nomFichier(null, 'WEB1'), 'inconnu_WEB1.pdf');
});

test('le dossier porte l\'adresse électronique, lue sur la page ou déclarée', () => {
  assert.equal(atelier.compteDepuisTexte(PAGE, {}), 'camille@exemple.fr');
  assert.equal(atelier.compteDepuisTexte(PAGE, { email: 'Autre@Exemple.fr' }), 'autre@exemple.fr');
  assert.equal(atelier.compteDepuisTexte('rien ici', {}), 'compte');
});

// ---------------------------------------------------------------------------
// Session expirée : on s'arrête
// ---------------------------------------------------------------------------

test('une redirection vers la connexion est reconnue, sans faux positif', () => {
  assert.equal(atelier.estPageConnexion('https://www.atelierduportable.com/connexion/'), true);
  assert.equal(atelier.estPageConnexion('https://x.fr/wp-login.php'), true);
  assert.equal(
    atelier.estPageConnexion('https://www.piece-pc-portable.com/vos-commandes-de-pieces-neuves/'),
    false
  );
  // Le domaine ne compte pas : seuls le chemin et la requête sont examinés.
  assert.equal(atelier.estPageConnexion('https://connexion.exemple.fr/commandes'), false);
});

test('une session expirée s\'arrête là, et dit quoi faire', () => {
  const err = atelier.erreurSessionExpiree('redirection vers la page de connexion');

  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Rouvrez-la depuis la fiche du service/);
  assert.match(err.message, /jamais tout seul/);

  // La règle du lot 12, valable pour tous les connecteurs : insister sur un
  // formulaire de connexion peut rendre le site inaccessible même à la main.
  const source = fs.readFileSync(path.join(DOSSIER, 'connector.js'), 'utf8');
  assert.match(source, /aucune reconnexion automatique|Aucune nouvelle tentative/i);
});

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

test('le manifeste passe la validation, et parle à l\'utilisateur', () => {
  const rendu = schema.validate(MANIFESTE, 'atelier-du-portable');
  assert.deepEqual(rendu.errors, []);

  assert.equal(schema.compterPhrases(MANIFESTE.description), 1);
  assert.ok(MANIFESTE.description.length <= schema.DESCRIPTION_MAX);
  assert.doesNotMatch(MANIFESTE.description, /session|cookie|scraping|WordPress/i,
    'la description ne parle pas de technique');

  // Le technique va dans la note d'administration, et n'en sort pas.
  assert.match(MANIFESTE.technicalNote, /piece-pc-portable\.com/);
  assert.equal(schema.publicView(schema.normalize(MANIFESTE)).technicalNote, undefined);
});

test('les quatre permissions disent ce que ce connecteur fait, et pas un autre', () => {
  assert.ok(MANIFESTE.permissions.length >= 4);
  for (const p of MANIFESTE.permissions) {
    assert.ok(schema.vocabulary.has(p.key), `${p.key} hors vocabulaire`);
    assert.ok(p.description.length >= 80, `${p.key} : description trop courte`);
    assert.equal(schema.isGenericDescription(p.description, p.key), false, p.key);
  }
});
