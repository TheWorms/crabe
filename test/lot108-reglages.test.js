'use strict';

/**
 * Lot 108, R7 — aucun réglage perdu.
 *
 * L'inventaire de chaque section du Profil et de l'Administration a été relevé
 * AVANT le lot, au vrai Chromium sur le banc de `lot108-commun.js`
 * (`test/lot108-inventaire.json` : chaque contrôle — bouton, champ, liste,
 * case, interrupteur, entrée de menu d'actions —, onglets et vues dépliés,
 * réduit à sa signature : son geste, sinon son identifiant, sinon son texte).
 * Cet essai rejoue le même banc sur le code d'aujourd'hui et retrouve chaque
 * signature dans la NOUVELLE page, à l'adresse de sa section. Les gestes des
 * dix-huit non faisables, qui ont quitté le logiciel (R6), ne sont pas dans
 * l'inventaire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const commun = require('./lot108-commun');

const INVENTAIRE = JSON.parse(fs.readFileSync(path.join(__dirname, 'lot108-inventaire.json'), 'utf8')).sections;
const ADRESSES = {
  profil: Object.fromEntries(commun.SECTIONS_PROFIL.map((n) => [n, `/profil/${n}`])),
  admin: {
    users: '/administration/utilisateurs', apps: '/administration/applications', roles: '/administration/permissions',
    cron: '/administration/automatisation', storage: '/administration/stockage', optimisation: '/administration/optimisation',
    securite: '/administration/securite', smtp: '/administration/smtp', logs: '/administration/logs',
    support: '/administration/support', systeme: '/administration/systeme',
  },
};

let banc;

test.before(async () => {
  banc = await commun.poserLeBanc();
  commun.connaitreLesServices();
});

test.after(async () => {
  await fermerNavigateur();
  await banc?.client.close();
  helpers.teardown();
});

test('R7 — l\'inventaire relevé avant le lot couvre les dix-neuf sections', () => {
  assert.deepEqual(Object.keys(INVENTAIRE.profil), commun.SECTIONS_PROFIL);
  assert.deepEqual(Object.keys(INVENTAIRE.admin), commun.SECTIONS_ADMIN);
  const total = Object.values(INVENTAIRE).flatMap((v) => Object.values(v)).flat().length;
  assert.ok(total > 200, `${total} signatures`);
});

for (const vue of ['profil', 'admin']) {
  test(`R7 — chaque réglage et chaque action ${vue === 'profil' ? 'du Profil' : 'de l\'Administration'} se retrouvent dans la nouvelle page`, AVEC_NAVIGATEUR, async (t) => {
    const { page, erreursJs, fermer } = await ouvrirCrabe(banc.client, 'gerante');
    t.after(fermer);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const manquants = [];
    for (const [nom, attendues] of Object.entries(INVENTAIRE[vue])) {
      // La section s'ouvre par son ADRESSE : c'est la nouvelle page qu'on lit.
      await page.goto(`${banc.client.base}${ADRESSES[vue][nom]}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((id) => document.querySelector('.view.active .settings-page.active')?.id === id,
        `${vue === 'profil' ? 'ppage' : 'apage'}-${nom}`);
      const trouvees = new Set((await commun.releverLaSection(page, vue, nom)).map(commun.signature));
      for (const s of attendues) if (!trouvees.has(s)) manquants.push(`${vue}/${nom} : ${s}`);
    }
    assert.deepEqual(manquants, [], 'aucun réglage, aucune action perdus');
    assert.deepEqual(erreursJs, []);
  });
}
