'use strict';

/**
 * §1 du lot 14 — « connexion établie » ne se déclare plus sans preuve.
 *
 * Le défaut, relevé en production le 11/08/2026 :
 *
 *     02:57:10  Propolia : connexion établie.
 *     02:57:11  Propolia : la page des commandes renvoie à l'authentification.
 *
 * Une session ne meurt pas en une seconde. Ce que ces tests vérifient, c'est
 * qu'aucune des situations qui produisaient ce message ne le produit encore.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const preuve = require('../server/connectors/preuve-connexion');

/**
 * Une fausse page Playwright : une URL, et un ensemble de sélecteurs présents.
 * Assez pour exercer les deux critères, et rien de plus.
 */
function pageSimulee(url, presents = []) {
  const jeu = new Set(presents);
  return {
    url: () => url,
    locator: (selecteur) => ({
      count: async () => (jeu.has(selecteur) ? 1 : 0),
    }),
  };
}

// ---------------------------------------------------------------------------
// L'URL d'authentification
// ---------------------------------------------------------------------------

test('les formulaires de connexion sont reconnus, en français comme en anglais', () => {
  for (const url of [
    'https://propolia.com/fr/connexion',
    'https://propolia.com/fr/connexion?back=history',
    'https://www.coco-papaya.com/index.php?controller=authentication&back=history',
    'https://boutique.fr/login',
    'https://boutique.fr/signin',
    'https://boutique.fr/identification',
    'https://boutique.fr/se-connecter',
    // ⚠ LE cas manqué par le lot 13 : la forme FRANÇAISE. Fantazia et
    // Apiculture.net servent leur formulaire là, et une redirection vers cette
    // page passait pour « page des commandes atteinte ».
    'https://www.fantazia-shop.fr/authentification',
    'https://www.apiculture.net/authentification?back=my-account',
  ]) {
    assert.equal(preuve.estUrlAuthentification(url), true, url);
  }
});

test('une page de commandes n\'est pas prise pour un formulaire', () => {
  for (const url of [
    'https://propolia.com/fr/historique-commandes',
    'https://www.fantazia-shop.fr/historique-des-commandes',
    'https://www.kubii.com/fr/index.php?controller=history',
    'https://www.apiculture.net/historique-des-commandes',
    // Le DOMAINE ne décide rien : une boutique nommée « maconnexion.fr »
    // n'est pas une page de connexion.
    'https://maconnexion.fr/index.php?controller=history',
    'https://authentification-shop.fr/historique-des-commandes',
  ]) {
    assert.equal(preuve.estUrlAuthentification(url), false, url);
  }
});

// ---------------------------------------------------------------------------
// L'URL malformée de Kubii (§1.2d)
// ---------------------------------------------------------------------------

test('une adresse à deux « ? » est rendue exploitable, jamais rejouée telle quelle', () => {
  // Ce que Kubii renvoie, littéralement, en production.
  assert.equal(
    preuve.normaliserUrl('https://www.kubii.com/fr/index.php?controller=authentication?back=history'),
    'https://www.kubii.com/fr/index.php?controller=authentication&back=history'
  );

  // Une adresse correcte n'est pas touchée.
  assert.equal(
    preuve.normaliserUrl('https://boutique.fr/index.php?controller=history&page=2'),
    'https://boutique.fr/index.php?controller=history&page=2'
  );
  assert.equal(preuve.normaliserUrl('https://boutique.fr/commandes'), 'https://boutique.fr/commandes');
});

// ---------------------------------------------------------------------------
// Les DEUX marqueurs — l'objet du §1.2a
// ---------------------------------------------------------------------------

test('les deux marqueurs réunis confirment la connexion', async () => {
  const page = pageSimulee(
    'https://www.kubii.com/fr/index.php?controller=my-account',
    ['a[href*="logout"]']
  );

  const resultat = await preuve.verifier(page, { cookies: 15 });

  assert.equal(resultat.confirme, true);
  assert.equal(resultat.surFormulaire, false);
  assert.deepEqual(resultat.marqueurs, ['a[href*="logout"]']);
});

test('une URL correcte SANS marqueur de compte ne confirme rien', async () => {
  // Le cas exact de Propolia : la boutique renvoie sur une page qui n'est plus
  // le formulaire, et rien n'y dit qu'on est connecté.
  const page = pageSimulee('https://propolia.com/fr/', []);

  const resultat = await preuve.verifier(page);

  assert.equal(resultat.confirme, false, 'une preuve par l\'absence n\'en est pas une');
  assert.deepEqual(resultat.marqueurs, []);
});

test('un marqueur de compte SUR le formulaire ne confirme rien non plus', async () => {
  // Beaucoup d'en-têtes portent « Mon compte » même déconnecté : ce marqueur
  // seul ne prouve rien, et c'est pour ça qu'on en exige deux.
  const page = pageSimulee('https://propolia.com/fr/connexion?back=history', ['#my-account']);

  const resultat = await preuve.verifier(page);

  assert.equal(resultat.confirme, false);
  assert.equal(resultat.surFormulaire, true);
});

test('un écran de validation en deux temps est un formulaire, même avec un lien logout', async () => {
  // LA mesure du 14/08/2026, rejouée sur le conteneur : la page
  // accounts.hetzner.com/2fa porte deux liens logout (« preuve forte »), et
  // une demi-session — mot de passe passé, code jamais saisi — s'y faisait
  // déclarer `confirme`. C'est ce verdict qui a fermé la fenêtre de connexion
  // pendant que l'utilisateur tapait son code.
  for (const url of [
    'https://accounts.hetzner.com/2fa',
    'https://exemple.fr/otp',
    'https://exemple.fr/mfa?retour=compte',
    'https://exemple.fr/two-factor',
    'https://exemple.fr/second-factor',
  ]) {
    const page = pageSimulee(url, ['a[href*="logout"]']);
    const resultat = await preuve.verifier(page);
    assert.equal(resultat.surFormulaire, true, url);
    assert.equal(resultat.confirme, false, `${url} : un facteur manque, rien n'est confirmé`);
  }

  // Un chemin qui CONTIENT ces lettres sans être une étape n'est pas happé.
  const anodine = pageSimulee('https://exemple.fr/document-factor-2026', ['a[href*="logout"]']);
  assert.equal((await preuve.verifier(anodine)).surFormulaire, false);
});

// ---------------------------------------------------------------------------
// Les deux lignes de journal (§1.2c)
// ---------------------------------------------------------------------------

test('la ligne de confirmation porte l\'URL, le marqueur et le compte de cookies', () => {
  const ligne = preuve.ligneConfirmee('Kubii', {
    url: 'https://www.kubii.com/fr/index.php?controller=my-account',
    marqueurs: ['a[href*="logout"]'],
    cookies: 15,
  });

  assert.match(ligne, /^Kubii : connexion confirmée \(/);
  assert.match(ligne, /controller=my-account/);
  assert.match(ligne, /lien de déconnexion présent/);
  assert.match(ligne, /15 cookie\(s\)/);
});

test('la ligne d\'échec dit l\'URL finale, l\'absence de marqueur ET l\'absence de message', () => {
  // C'est CETTE ligne qui permettra de trancher au prochain incident : elle
  // doit apparaître au journal même quand l'utilisateur voit autre chose.
  const ligne = preuve.ligneNonConfirmee('Kubii', {
    url: 'https://www.kubii.com/fr/index.php?controller=authentication&back=history',
    marqueurs: [],
    cookies: 3,
  });

  assert.match(ligne, /^Kubii : connexion NON confirmée — /);
  assert.match(ligne, /controller=authentication/);
  assert.match(ligne, /aucun marqueur de compte/);
  assert.match(ligne, /aucun message d'erreur affiché par la boutique/);
});

test('la ligne d\'échec reprend le message de la boutique quand il y en a un', () => {
  const ligne = preuve.ligneNonConfirmee(
    'Coco Papaya',
    { url: 'https://www.coco-papaya.com/fr/connexion', marqueurs: [], cookies: null },
    'Échec d\'authentification'
  );

  assert.match(ligne, /message de la boutique « Échec d'authentification »/);
  assert.doesNotMatch(ligne, /cookie/, 'sans compte de cookies, on n\'en invente pas');
});

// ---------------------------------------------------------------------------
// Robustesse
// ---------------------------------------------------------------------------

test('une page qui ne répond plus ne confirme jamais, et ne lève pas', async () => {
  const morte = {
    url: () => {
      throw new Error('Target page, context or browser has been closed');
    },
    locator: () => ({
      count: async () => {
        throw new Error('page closed');
      },
    }),
  };

  const resultat = await preuve.verifier(morte);
  assert.equal(resultat.confirme, false);
  assert.deepEqual(resultat.marqueurs, []);
});
