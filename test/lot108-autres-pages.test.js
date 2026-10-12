'use strict';

/**
 * Lot 108, R4 et R7 — les autres pages ne changent pas.
 *
 * L'accueil, « Mes documents » (interface de base et explorateur), « Vos
 * notifications » et « Suivi d'actions » sont rendus sur le banc du lot 107,
 * au vrai Chromium, à 1280 px, dans les deux thèmes, horloge figée. Leur
 * empreinte — le HTML de l'écran, et sa mise en page (boîte, couleurs, police
 * de chaque élément) — est celle relevée AVANT le lot, sur le code du tag
 * `avant-pleine-page-108` (`5c7882b`), deux relevés identiques.
 *
 * Un seul changement est décidé, et posé sur le relevé d'avant : la page
 * « Paramètres » s'appelle « Administration » (C3), et une phrase de l'accueil
 * qui la nomme dit désormais « Administration → Stockage ». Le Store, lui,
 * change par décision (R6) : il n'est pas ici. Les feuilles de style et les
 * gabarits communs du lot ne touchent qu'au Profil et à l'Administration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { peupler, regler } = require('./lot107-commun');
const { AUTRES_PAGES, empreinteDeLaZone } = require('./lot108-commun');

const HORLOGE = new Date('2026-10-01T10:00:00Z');
/** Relevées sur `5c7882b` (avant le lot), « Paramètres → » renommé. */
const AVANT = {
  'accueil-sombre': { html: '867d75b8bc2e3b166a171ac3fea195e4ea9861f7933f8a07f8f267e664a4f880', miseEnPage: 'fd7fb35f24e8c7debfed58e2dbb5111da64bb9ce77cc6d226bc0f7bcb70d49b7' },
  'documents-base-sombre': { html: '009edc5b6fd2866b9c38511ed381f37d8d3f57a21748f4e77bb21d01807e49df', miseEnPage: '94ef27993d0800736e75184c44a02ee57cb4a4c78ee02eb9933af7e93d37b72b' },
  'documents-explorateur-sombre': { html: 'fc69070286fcffcfc92d6fc110e2a11924c1e732d169cd61c72d931e709f6bcb', miseEnPage: '61a45bd365ecbbded3686d6246adc3c6fd8b93e9c654705fea42fd3c94137b51' },
  'notifications-sombre': { html: 'debbd1568ef062f49b3fa542c1b853ca7065f34222a7494afd463541799faa8c', miseEnPage: '8a3576e5e45ec44e5ea454b22a73bd9e7eefe66bffb43940d7bd2f99c030e3d4' },
  'suivi-sombre': { html: 'fc67632fa91533b1a83a6085c760f02cafb586c9cb1cfa6734c1bcdf6485912b', miseEnPage: '3c10237c23da5862d7f3bf49295033281f1b2620a087363f4ad22b98321afc86' },
  'accueil-clair': { html: '867d75b8bc2e3b166a171ac3fea195e4ea9861f7933f8a07f8f267e664a4f880', miseEnPage: 'be750c8868b8c305134c57b9be91597d96883008669b7bd2cd5a2870802053c1' },
  'documents-base-clair': { html: '009edc5b6fd2866b9c38511ed381f37d8d3f57a21748f4e77bb21d01807e49df', miseEnPage: 'ec79741e5d5f2e64777455a7a6b9dfbd0f530d4b0173c97a09facf71a6d71876' },
  'documents-explorateur-clair': { html: 'fc69070286fcffcfc92d6fc110e2a11924c1e732d169cd61c72d931e709f6bcb', miseEnPage: '9830613af096a70799814a7e4536f8355cf892acd01aa58e5d22037d207cc02d' },
  'notifications-clair': { html: 'debbd1568ef062f49b3fa542c1b853ca7065f34222a7494afd463541799faa8c', miseEnPage: 'b5d627643f3291ac8992cf9eeb8c30950bc8024fee7a1668486458d58853dcb9' },
  'suivi-clair': { html: 'fc67632fa91533b1a83a6085c760f02cafb586c9cb1cfa6734c1bcdf6485912b', miseEnPage: '8f80e34fc7615967e989eb4e49e0f1b8c486e89c9885504c136bb4fb28a8508a' },
};

let client;
let titulaire;

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(process.env.CRABE_LOCAL_PATH, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  peupler(titulaire);
  client = await helpers.startServer();
});

test.after(async () => {
  await fermerNavigateur();
  await client?.close();
  helpers.teardown();
});

for (const clair of [false, true]) {
  test(`R4 — thème ${clair ? 'clair' : 'sombre'}, 1280 px : l'accueil, Mes documents (base, explorateur), les notifications et le Suivi d'actions ont le rendu d'avant le lot`, AVEC_NAVIGATEUR, async (t) => {
    for (const e of AUTRES_PAGES) {
      regler(titulaire.id, e.ui);
      const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 1280, hauteur: 900, clair });
      t.after(fermer);
      await page.clock.setFixedTime(HORLOGE);
      await page.evaluate((v) => showView(v), e.vue);
      await page.waitForFunction(e.pret);
      await page.waitForTimeout(400);
      await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
      const cle = `${e.nom}-${clair ? 'clair' : 'sombre'}`;
      assert.deepEqual(await empreinteDeLaZone(page, e.zone), AVANT[cle], cle);
      assert.equal(await page.title(), 'Crabe — gestionnaire de factures', `${cle} : le titre de l'onglet`);
      assert.deepEqual(erreursJs, [], cle);
      await fermer();
    }
  });
}
