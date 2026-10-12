'use strict';

/**
 * Lot 107, R1 / R9 — l'interface de base de « Mes documents » ne change pas
 * d'un octet.
 *
 * Les empreintes ci-dessous ont été relevées AVANT le lot, sur `fc7b9bd` (tag
 * `avant-explorateur-107`), par ce même fichier : le rendu de `#view-documents`
 * au vrai Chromium, horloge figée, sur le banc de `lot107-commun.js`, en cartes
 * et en liste. Après le lot, un compte réglé sur « base » — ou dont le réglage
 * est absent, ou inconnu — doit retrouver EXACTEMENT ces octets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { peupler, regler } = require('./lot107-commun');

/** Relevées sur `fc7b9bd`, avant toute ligne du lot 107. */
const AVANT = {
  cartes: '009edc5b6fd2866b9c38511ed381f37d8d3f57a21748f4e77bb21d01807e49df',
  liste: 'baad7df94cbce90845509d152279fe2122c858cdc1610c45c138be174e39abd9',
};

/** L'heure du banc : les dates relatives (« il y a 3 j ») ne bougent plus. */
const HORLOGE = new Date('2026-10-01T10:00:00Z');

let titulaire;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  peupler(titulaire);
});

test.after(async () => {
  await fermerNavigateur();
  helpers.teardown();
});

/** `documentsUi` retouché dans la réponse de /api/auth/me : `undefined` = retiré. */
const retoucherMe = (valeur) => async (page) => {
  await page.route('**/api/auth/me', async (route) => {
    const reponse = await route.fetch();
    const corps = await reponse.json();
    if (valeur === undefined) delete corps.user.documentsUi;
    else corps.user.documentsUi = valeur;
    await route.fulfill({ response: reponse, json: corps });
  });
};

async function rendu(client, vue, preparer = null) {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { preparer });
  try {
    await page.clock.setFixedTime(HORLOGE);
    await page.evaluate(() => showView('documents'));
    await page.waitForFunction(() => document.getElementById('docs-content').innerHTML.length > 200
      && !/Lecture de vos documents/.test(document.getElementById('docs-content').textContent));
    await page.evaluate((v) => setDocsView(v), vue === 'liste' ? 'list' : 'cards');
    await page.waitForTimeout(200);
    const html = await page.$eval('#view-documents', (e) => e.outerHTML);
    assert.deepEqual(erreursJs, []);
    return { html, empreinte: crypto.createHash('sha256').update(html).digest('hex') };
  } finally {
    await fermer();
  }
}

for (const vue of ['cartes', 'liste']) {
  test(`R1 — réglage « base » : « Mes documents » (${vue}) est celui d'avant le lot, octet pour octet`, AVEC_NAVIGATEUR, async (t) => {
    regler(titulaire.id, 'base');
    const client = await helpers.startServer();
    t.after(() => client.close());
    const { html, empreinte } = await rendu(client, vue);
    assert.match(html, /Free Mobile/, 'le banc est bien affiché');
    if (process.env.CRABE_LOT107_RELEVE) console.log(`EMPREINTE ${vue} ${empreinte}`);
    assert.equal(empreinte, AVANT[vue]);
  });

  for (const [cas, valeur] of [['absent', undefined], ['inconnu', 'grille']]) {
    test(`R1 — réglage ${cas} : l'interface de base (${vue}), octet pour octet`, AVEC_NAVIGATEUR, async (t) => {
      regler(titulaire.id, 'base');
      const client = await helpers.startServer();
      t.after(() => client.close());
      const { empreinte } = await rendu(client, vue, retoucherMe(valeur));
      assert.equal(empreinte, AVANT[vue]);
    });
  }
}
