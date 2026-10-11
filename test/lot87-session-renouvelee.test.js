'use strict';

/**
 * Lot 87, R4 — l'état de session survit à un passage réussi.
 *
 * Un connecteur à session fragile et sans contrôle par rejeu (impots —
 * « ne se rejoue qu'une fois » est un erratum du lot 89, voir
 * docs/reconnaissance-lot87.md) rend
 * l'état de son navigateur EN FIN de passage réussi (`sessionRenouvelee`,
 * une chaîne JSON de `storageState`). Le planificateur l'enregistre par
 * `saveConfig` — contrôle de forme, chiffrement, `__meta` — pour que le
 * passage suivant parte de l'état le plus récent plutôt que de la capture
 * d'origine.
 *
 * Trois règles, testées ici sur une sonde :
 *   - l'état rendu REMPLACE la session enregistrée ;
 *   - un état illisible ne change JAMAIS le résultat du passage : l'échec
 *     d'écriture se journalise, la récupération reste ce qu'elle était ;
 *   - un connecteur qui ne rend rien ne change pas d'un octet — l'option est
 *     déclarative, aucun des autres connecteurs n'est touché.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');

const ID_SONDE = 'sonde-renouvellement';

const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    return { ok: true, message: 'sonde' };
  },
  async fetchInvoices(config, ctx) {
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    const sortie = { invoices: [] };
    if (globalThis.__renouvellement !== undefined) {
      sortie.sessionRenouvelee = globalThis.__renouvellement;
    }
    return sortie;
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde renouvellement',
  category: 'energie',
  color: '#123456',
  letters: 'SR',
  description: 'Sonde de test du lot 87 : l\'état de session renouvelé après le passage.',
  fields: [
    { key: 'session', label: 'Connexion', type: 'session', required: false },
    { key: 'username', label: 'Identifiant', type: 'text' },
  ],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

function etatDeSession(nom, valeur) {
  return JSON.stringify({
    cookies: [{
      name: nom,
      value: valeur,
      domain: '.exemple.test',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    }],
    origins: [],
  });
}

const SESSION_INITIALE = etatDeSession('jeton', 'etat-initial');
const SESSION_RENOUVELEE = etatDeSession('jeton', 'etat-renouvele');

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'renouvellement', role: 'admin' });

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot87r-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde', session: SESSION_INITIALE });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__renouvellement;
  registry.load();
  helpers.teardown();
});

test('un état rendu par le passage remplace la session enregistrée', async () => {
  globalThis.__renouvellement = SESSION_RENOUVELEE;
  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.ok, true, resultat.message);

  const config = registry.readConfig(user.id, ID_SONDE);
  assert.equal(config.session, SESSION_RENOUVELEE,
    'le passage suivant doit partir de l\'état le plus récent');
});

test('un état illisible ne change JAMAIS le résultat du passage', async () => {
  registry.saveConfig(user.id, ID_SONDE, { session: SESSION_INITIALE });
  globalThis.__renouvellement = 'ceci n\'est pas un état de session';

  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.ok, true,
    `l'échec d'écriture ne doit pas toucher la récupération : ${resultat.message}`);

  const config = registry.readConfig(user.id, ID_SONDE);
  assert.equal(config.session, SESSION_INITIALE, 'la session enregistrée reste intacte');
});

test('un connecteur qui ne rend rien ne change pas d\'un octet — l\'option est déclarative', async () => {
  registry.saveConfig(user.id, ID_SONDE, { session: SESSION_INITIALE });
  delete globalThis.__renouvellement;

  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.ok, true, resultat.message);

  const config = registry.readConfig(user.id, ID_SONDE);
  assert.equal(config.session, SESSION_INITIALE);
});

test('une chaîne vide ou un type inattendu ne passent pas pour un état', async () => {
  // Le socle filtre avant le planificateur : rien à enregistrer, rien d'écrit.
  for (const valeur of ['', '   ', 42, { cookies: [] }]) {
    globalThis.__renouvellement = valeur;
    const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
    assert.equal(resultat.ok, true, resultat.message);
    const config = registry.readConfig(user.id, ID_SONDE);
    assert.equal(config.session, SESSION_INITIALE, `valeur refusée : ${JSON.stringify(valeur)}`);
  }
});
