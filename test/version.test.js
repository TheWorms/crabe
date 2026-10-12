'use strict';

/**
 * La version embarquée et la vérification de mise à jour (server/version.js).
 *
 * Le test central est la comparaison NUMÉRIQUE : « 1.10.0 » est plus récente
 * que « 1.2.0 », alors que la comparaison lexicale dit l'inverse. C'est le
 * piège classique, et c'est lui qui déciderait d'afficher — ou non — la
 * bannière de mise à jour.
 *
 * L'autre contrat : un échec réseau est un silence total, et rien ne part
 * vers GitHub sans `CRABE_UPDATE_REPO` — coupé par défaut.
 *
 * Le canal interroge les TAGS du dépôt, pas `/releases/latest` : la
 * publication de crabe pose des tags, jamais de Release GitHub, et sur un
 * dépôt sans Release `/releases/latest` répond 404 à perpétuité. Les tests
 * gardent aussi ce choix-là : une liste de tags non triée, des tags qui ne
 * sont pas des versions, et la plus récente qui se CALCULE.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const version = require('../server/version');

// ---------------------------------------------------------------------------
// La comparaison
// ---------------------------------------------------------------------------

test('1.10.0 est plus récente que 1.2.0 — comparaison numérique, pas lexicale', () => {
  assert.ok(version.comparerVersions('1.10.0', '1.2.0') > 0, '1.10 > 1.2');
  assert.ok(version.comparerVersions('1.2.0', '1.10.0') < 0, 'et dans l\'autre sens');
  // Le témoin lexical : en texte, '1.10.0' < '1.2.0'. Si ce test casse un
  // jour, c'est que quelqu'un a remis une comparaison de chaînes.
  assert.ok('1.10.0' < '1.2.0', 'le piège existe bien en comparaison de chaînes');
});

test('égalité, préfixe v, segments manquants et segments illisibles', () => {
  assert.equal(version.comparerVersions('1.2.3', '1.2.3'), 0);
  assert.equal(version.comparerVersions('v1.2.3', '1.2.3'), 0, 'le tag GitHub porte un v');
  assert.equal(version.comparerVersions('1.2', '1.2.0'), 0, 'segment manquant = 0');
  assert.ok(version.comparerVersions('2', '1.9.9') > 0);
  assert.ok(version.comparerVersions('1.2.x', '1.2.1') < 0, 'segment illisible = 0, jamais NaN');
});

// ---------------------------------------------------------------------------
// La version embarquée
// ---------------------------------------------------------------------------

test('VERSION est celle du fichier embarqué, et elle est comparable', () => {
  const fichier = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
  assert.equal(version.VERSION, fichier);
  assert.match(version.VERSION, /^\d+\.\d+\.\d+$/, 'X.Y.Z, rien d\'autre');
});

// ---------------------------------------------------------------------------
// La vérification de mise à jour
// ---------------------------------------------------------------------------

/** Un faux fetch qui rend la réponse donnée, et compte ses appels. */
function fauxFetch(reponse) {
  const appels = [];
  const impl = async (url, options) => {
    appels.push({ url, options });
    if (reponse instanceof Error) throw reponse;
    return reponse;
  };
  return { impl, appels };
}

function reponseJson(corps, ok = true) {
  return { ok, json: async () => corps };
}

/** La forme que GitHub donne à /repos/<repo>/tags : un tableau de {name}. */
function reponseTags(noms, ok = true) {
  return reponseJson(noms.map((name) => ({ name })), ok);
}

test.beforeEach(() => version.oublierVerification());

test('sans dépôt configuré, rien ne part — coupé par défaut', async () => {
  const { impl, appels } = fauxFetch(reponseTags(['v9.9.9']));
  const resultat = await version.verifierMiseAJour({ fetchImpl: impl, repo: '' });
  assert.equal(resultat, null);
  assert.equal(appels.length, 0, 'aucune requête ne doit partir');
});

test('ce sont les tags du dépôt qui sont interrogés, jamais /releases/latest', async () => {
  const { impl, appels } = fauxFetch(reponseTags([]));
  await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' });
  assert.equal(appels.length, 1);
  assert.match(appels[0].url, /\/repos\/qui\/quoi\/tags\b/, 'la publication pose des tags');
  assert.doesNotMatch(appels[0].url, /releases/, '404 à perpétuité sur un dépôt sans Release');
});

test('une version plus récente publiée est annoncée, sans son préfixe v', async () => {
  const { impl } = fauxFetch(reponseTags(['v9.9.9']));
  const resultat = await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' });
  assert.deepEqual(resultat, { version: '9.9.9' });
});

test('la plus récente se calcule : liste non triée, tags non-version ignorés', async () => {
  // « v9.10.0 » est plus petite que « v9.9.0 » en texte : si ce test casse,
  // c'est que l'ordre de la liste (ou une comparaison lexicale) a repris la main.
  const { impl } = fauxFetch(reponseTags(['v9.9.0', 'beta', 'v9.10.0', 'v9.10.0-rc1']));
  const resultat = await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' });
  assert.deepEqual(resultat, { version: '9.10.0' });
});

test('une version plus ancienne ou égale ne produit aucune bannière', async () => {
  const { impl } = fauxFetch(reponseTags(['v0.0.1']));
  assert.equal(await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' }), null);

  version.oublierVerification();
  const pareil = fauxFetch(reponseTags([`v${version.VERSION}`]));
  assert.equal(await version.verifierMiseAJour({ fetchImpl: pareil.impl, repo: 'qui/quoi' }), null);
});

test('échec réseau, réponse en erreur, liste vide ou illisible : silence total', async () => {
  for (const cas of [
    new Error('réseau coupé'),
    reponseTags([], false),
    reponseTags([]),
    reponseTags(['brouillon', 'jalon-2']),
    reponseJson({ message: 'Not Found' }),
  ]) {
    version.oublierVerification();
    const { impl } = fauxFetch(cas);
    assert.equal(
      await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' }),
      null,
      'jamais une erreur, jamais une bannière'
    );
  }
});

test('une interrogation par jour au plus — même après un échec', async () => {
  const debut = 1_000_000_000_000;
  const { impl, appels } = fauxFetch(reponseTags(['v9.9.9']));

  await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi', maintenant: debut });
  assert.equal(appels.length, 1);

  // Une heure plus tard : la réponse du jour est resservie, rien ne part.
  const rejoue = await version.verifierMiseAJour({
    fetchImpl: impl, repo: 'qui/quoi', maintenant: debut + 3_600_000,
  });
  assert.equal(appels.length, 1, 'pas de seconde requête dans la journée');
  assert.deepEqual(rejoue, { version: '9.9.9' }, 'et la bannière du jour reste connue');

  // Le lendemain : une nouvelle interrogation est permise.
  await version.verifierMiseAJour({
    fetchImpl: impl, repo: 'qui/quoi', maintenant: debut + 25 * 3_600_000,
  });
  assert.equal(appels.length, 2);
});

test('une installation en 0.1.0 face au tag v0.1.3 se voit annoncer 0.1.3', async (t) => {
  // Le module lit VERSION à côté de lui au chargement : pour incarner une
  // installation en retard, une COPIE du module part dans un dossier
  // temporaire avec son propre fichier VERSION — le vrai code, une autre
  // version embarquée, aucun module-mock.
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-version-'));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  fs.mkdirSync(path.join(racine, 'server'));
  fs.copyFileSync(
    path.join(__dirname, '..', 'server', 'version.js'),
    path.join(racine, 'server', 'version.js')
  );
  fs.writeFileSync(path.join(racine, 'VERSION'), '0.1.0\n');

  const enRetard = require(path.join(racine, 'server', 'version.js'));
  assert.equal(enRetard.VERSION, '0.1.0');

  const { impl } = fauxFetch(reponseTags(['v0.1.3', 'v0.1.2', 'v0.1.0']));
  const resultat = await enRetard.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' });
  assert.deepEqual(resultat, { version: '0.1.3' }, 'la mise à jour est positivement connue');
});
