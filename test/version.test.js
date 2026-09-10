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
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test.beforeEach(() => version.oublierVerification());

test('sans dépôt configuré, rien ne part — coupé par défaut', async () => {
  const { impl, appels } = fauxFetch(reponseJson({ tag_name: 'v9.9.9' }));
  const resultat = await version.verifierMiseAJour({ fetchImpl: impl, repo: '' });
  assert.equal(resultat, null);
  assert.equal(appels.length, 0, 'aucune requête ne doit partir');
});

test('une version plus récente publiée est annoncée, sans son préfixe v', async () => {
  const { impl } = fauxFetch(reponseJson({ tag_name: 'v9.9.9' }));
  const resultat = await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' });
  assert.deepEqual(resultat, { version: '9.9.9' });
});

test('une version plus ancienne ou égale ne produit aucune bannière', async () => {
  const { impl } = fauxFetch(reponseJson({ tag_name: 'v0.0.1' }));
  assert.equal(await version.verifierMiseAJour({ fetchImpl: impl, repo: 'qui/quoi' }), null);

  version.oublierVerification();
  const pareil = fauxFetch(reponseJson({ tag_name: `v${version.VERSION}` }));
  assert.equal(await version.verifierMiseAJour({ fetchImpl: pareil.impl, repo: 'qui/quoi' }), null);
});

test('échec réseau, réponse en erreur, corps sans tag : silence total', async () => {
  for (const cas of [
    new Error('réseau coupé'),
    reponseJson({}, false),
    reponseJson({}),
    reponseJson({ tag_name: '' }),
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
  const { impl, appels } = fauxFetch(reponseJson({ tag_name: 'v9.9.9' }));

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
