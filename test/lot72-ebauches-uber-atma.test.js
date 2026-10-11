'use strict';

/**
 * Lot 72 — deux ébauches : Uber (choix des services) et Atma Kitchenware.
 *
 * Ces connecteurs n'ont JAMAIS vu de liste de documents : la reconnaissance
 * s'est faite en visiteur anonyme (reconnaissance anonyme du lot 72). Comme au
 * lot 47, ces tests protègent l'HONNÊTETÉ du squelette :
 *
 *   1. les deux fiches existent, en attente (`pending`), avec de quoi ouvrir
 *      une connexion (remoteLogin + profil persistant), et le régime de
 *      preuve suit la mesure (verifyUrlTient : les anonymes sont éconduits,
 *      témoin à l'appui côté Atma et Uber Eats) ;
 *   2. Uber propose ses trois services SANS prétendre les avoir mesurés :
 *      tous cochés, la première récupération tranchera — et « Location »,
 *      sans adresse mesurée, n'est JAMAIS visité ;
 *   3. lancée, une ébauche dépose la preuve de liste et dit au journal et à
 *      l'écran que le parcours n'est pas écrit — jamais un « aucune nouvelle
 *      facture » muet ;
 *   4. l'authentification d'Uber vit sur SON hôte (auth.uber.com) : le motif
 *      générique de chemin ne la verrait pas.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES ou tirées de la reconnaissance anonyme —
 * aucun trajet, aucune adresse, aucune donnée de compte.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../server/connectors/registry');
const profilMarchand = require('../server/connectors/profil-marchand');

const uber = require('../server/connectors/available/uber/connector');
const atma = require('../server/connectors/available/atma/connector');

// ---------------------------------------------------------------------------
// Fausse page multi-écrans et faux profil (recette de lot47-ebauches.test.js,
// étendue : Uber visite PLUSIEURS listes sur le même profil — goto change
// d'écran, comme le ferait le navigateur)
// ---------------------------------------------------------------------------

function fakePage(ecrans) {
  let courant = ecrans[0];
  return {
    url: () => courant.url,
    goto: async (url) => {
      courant = ecrans.find((e) => String(url).startsWith(e.cle || e.url)) || courant;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      // fermerBandeauCookies / estMurAntiRobot n'ont pas d'argument.
      if (arg === undefined) return false;
      // chercherMarqueursMesures passe {sel, motif} et attend un booléen.
      if (arg && typeof arg === 'object' && 'sel' in arg && 'motif' in arg) return false;
      // photographier passe {motif, selecteur} et attend la vue.
      return courant.vue;
    },
    locator: () => ({ count: async () => 0 }),
  };
}

async function surProfilSimule(ecrans, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(fakePage(ecrans), {});
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
    ctx: {
      userId: 1,
      log: (m) => journal.push(String(m)),
      preuveDeListe: (info) => preuves.push(info),
    },
    journal,
    preuves,
  };
}

/** Un écran de liste servie au compte (l'adresse a tenu, pas de « Se connecter »). */
function ecranServi(url, reperes = 0) {
  return { url, cle: url, vue: { url, boutonSeConnecter: false, reperes, libelles: [] } };
}

// ---------------------------------------------------------------------------
// 1. Les deux fiches existent, en attente, prêtes à ouvrir une connexion
// ---------------------------------------------------------------------------

test('les deux ébauches sont chargées : pending, remoteLogin persistant, verifyUrlTient mesuré', () => {
  registry.load();
  for (const id of ['uber', 'atma']) {
    const manifest = registry.manifest(id);
    assert.ok(manifest, `${id} doit être chargé depuis available/`);
    assert.equal(manifest.initialStatus, 'pending',
      `${id} : jamais validé contre un compte réel, il naît en attente`);
    assert.equal(manifest.remoteLogin.persistent, true,
      `${id} : la session vit dans un profil de navigateur persistant`);
    assert.match(manifest.remoteLogin.verifyUrl, /^https:\/\//);
    assert.equal(manifest.remoteLogin.verifyUrlTient, true,
      `${id} : la redirection des anonymes est MESURÉE (reconnaissance du 08/09/2026)`);
    const session = manifest.fields.find((f) => f.type === 'session');
    assert.ok(session, `${id} : la capture doit avoir où s'enregistrer`);
    assert.equal(session.required, false);
    const module_ = registry.get(id).module;
    assert.equal(typeof module_.test, 'function');
    assert.equal(typeof module_.fetchInvoices, 'function');
  }
  // La note technique d'Uber dit ce qui reste À RELEVER (depuis le lot 73 :
  // Uber Eats, Location) ; celle d'Atma dit depuis le lot 74 que le parcours
  // est MESURÉ sur la session réelle — et ce qui reste à surveiller.
  assert.match(registry.manifest('uber').technicalNote, /RELEVER/i);
  assert.match(registry.manifest('atma').technicalNote, /MESURÉ .* SUR LA SESSION/i);
});

// ---------------------------------------------------------------------------
// 2. Uber : trois services proposés, aucun prétendu mesuré
// ---------------------------------------------------------------------------

test('discover() propose les trois services, tous cochés, sans ouvrir de navigateur', async () => {
  const { ctx, journal } = contexteEnregistreur();
  const { items } = await uber.discover({}, ctx);
  assert.deepEqual(items.map((i) => i.id), ['trajets', 'location', 'eats']);
  assert.ok(items.every((i) => i.preselected === true),
    'sans mesure, on ne décoche RIEN : la première récupération tranchera');
  assert.match(journal.join('\n'), /première récupération/,
    'le journal dit que le choix par défaut n\'est pas une mesure');
});

test('le manifeste Uber déclare le champ multiselect alimenté par la découverte', () => {
  const champ = registry.manifest('uber').fields.find((f) => f.key === uber.CHAMP_SERVICES);
  assert.ok(champ, 'le champ « services » doit exister');
  assert.equal(champ.type, 'multiselect');
  assert.equal(champ.source || 'discover', 'discover');
});

// Le comportement de récupération d'Uber — trajets parcourus, Uber Eats et
// Location journalisés — a changé au lot 73 : il est testé dans
// test/lot73-uber-trajets.test.js. Ici ne restent que les invariants d'ébauche
// conservés : multiselect, découverte, hôte d'authentification, renvoi.

test('l\'authentification d\'Uber se reconnaît à son HÔTE — le motif générique ne voit pas auth.uber.com', () => {
  assert.equal(uber.estPageAuthentification('https://auth.uber.com/v2/?next_url=x'), true,
    'auth.uber.com est l\'écran de connexion, quel que soit son chemin');
  assert.equal(uber.estPageAuthentification('https://m.uber.com/login-redirect/'), true,
    'les pages-relais /login-redirect ne sont qu\'un rebond vers la connexion');
  assert.equal(uber.estPageAuthentification('https://riders.uber.com/trips'), false);
  assert.equal(profilMarchand.estPageAuthentification('https://auth.uber.com/v2/'), false,
    'et c\'est bien pour ça que le connecteur porte le sien');
});

test('renvoyé vers auth.uber.com, l\'ébauche dit le renvoi malgré session — jamais « rien à récupérer »', async () => {
  const { ctx } = contexteEnregistreur();
  const ecrans = [{
    url: 'https://auth.uber.com/v2/?next_url=x',
    cle: 'https://riders.uber.com/trips',
    vue: { url: 'https://auth.uber.com/v2/?next_url=x', boutonSeConnecter: false, reperes: 0, libelles: [] },
  }];
  await assert.rejects(
    () => surProfilSimule(ecrans, () => uber.fetchInvoices({ [uber.CHAMP_SERVICES]: ['trajets'] }, ctx)),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.equal(err.renvoiAuthentification, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Atma : l'espace client Shopify, jugé sur la mesure
// ---------------------------------------------------------------------------

// Le comportement de récupération d'Atma — la liste lue, un reçu reconstitué
// par commande — a été écrit au lot 74, sur la mesure de la session réelle :
// il est testé dans test/lot74-atma-recus.test.js. Ici ne restent que les
// invariants d'ébauche conservés : chemin du compte, renvoi vers la connexion.

test('le chemin du compte Atma ne prend JAMAIS un écran de connexion pour l\'espace client', () => {
  assert.equal(atma.CHEMIN_COMPTE.test('https://atmakitchenware.fr/account'), true);
  assert.equal(atma.CHEMIN_COMPTE.test('https://shopify.com/11112222/account?locale=fr'), true);
  assert.equal(atma.CHEMIN_COMPTE.test('https://atmakitchenware.fr/account/login'), false,
    '« /account/login » commence comme « /account » — l\'ancre l\'écarte (leçon electro-depot, lot 52)');
  assert.equal(atma.CHEMIN_COMPTE.test('https://shopify.com/authentication/11112222/login?x=1'), false);
  assert.equal(atma.estPageAuthentification('https://shopify.com/authentication/11112222/login?x=1'), true,
    'l\'écran de connexion Shopify est couvert par le motif générique (/authentication, /login)');
});

test('renvoyé vers la connexion Shopify, Atma dit le renvoi malgré session', async () => {
  const { ctx } = contexteEnregistreur();
  const ecrans = [{
    url: 'https://shopify.com/authentication/11112222/login?x=1',
    cle: atma.URL_COMPTE,
    vue: {
      url: 'https://shopify.com/authentication/11112222/login?x=1',
      boutonSeConnecter: false, reperes: 0, libelles: [],
    },
  }];
  await assert.rejects(
    () => surProfilSimule(ecrans, () => atma.fetchInvoices({}, ctx)),
    (err) => {
      assert.equal(err.sessionExpired, true);
      return true;
    }
  );
});
