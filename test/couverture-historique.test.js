'use strict';

/**
 * « Tout l'historique disponible a été parcouru » ne s'écrit que si c'est
 * vrai (lot 33, tâche 9).
 *
 * Le 14/08/2026 à 14:52:55, après un « Récupérer tout l'historique » sur
 * Materiel.net, le journal a écrit : « Aucune nouvelle facture — tout
 * l'historique disponible a été parcouru ». C'était faux : seuls les six
 * derniers mois — la période servie par défaut par le site — avaient été
 * lus, et cinq années de commandes n'avaient jamais été ouvertes. La phrase
 * venait du socle de rattrapage du lot 32, qui l'ajoutait dès que l'option
 * « tout l'historique » était demandée, sans jamais vérifier ce qui avait
 * été réellement couvert.
 *
 * La règle, testée ici pour TOUT connecteur : la phrase exige une
 * ATTESTATION du connecteur (`couverture.complete`). Une couverture
 * partielle est écrite telle quelle, avec son détail. Aucune déclaration =
 * aucune affirmation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');

const ID_SONDE = 'sonde-couverture';

/** La couverture rendue se règle par test : c'est elle qu'on éprouve. */
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test(config, ctx) {
    return { ok: true, message: 'sonde' };
  },
  async fetchInvoices(config, ctx) {
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    return { invoices: [], couverture: globalThis.__couverture };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde couverture',
  category: 'energie',
  color: '#123456',
  letters: 'SC',
  description: 'Sonde de test du lot 33 : la couverture d\'historique attestée.',
  fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'couverture', role: 'admin' });

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot33c-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);

  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__couverture;
  registry.load();
  helpers.teardown();
});

async function rattrapage() {
  return scheduler.runForUser(user.id, ID_SONDE, 'manual', { toutLHistorique: true });
}

test('sans attestation du connecteur, la phrase « tout l\'historique » ne s\'écrit pas', async () => {
  globalThis.__couverture = undefined;
  const resultat = await rattrapage();
  assert.equal(resultat.ok, true, resultat.message);
  assert.doesNotMatch(resultat.message, /tout l'historique disponible a été parcouru/);
  assert.equal(resultat.message, 'Aucune nouvelle facture');
});

test('une couverture attestée complète autorise la phrase', async () => {
  globalThis.__couverture = { complete: true, detail: 'passage complet' };
  const resultat = await rattrapage();
  assert.match(resultat.message, /tout l'historique disponible a été parcouru/);
});

test('une couverture partielle écrit son détail — jamais la phrase complète', async () => {
  globalThis.__couverture = {
    complete: false,
    detail: 'les 6 derniers mois ; hors de portée cette fois : 2021, 2020',
  };
  const resultat = await rattrapage();
  assert.doesNotMatch(resultat.message, /tout l'historique disponible a été parcouru/);
  assert.match(resultat.message, /parcouru : les 6 derniers mois ; hors de portée cette fois : 2021, 2020/);
});

test('hors rattrapage, aucun suffixe — le message ordinaire reste ce qu\'il était', async () => {
  globalThis.__couverture = { complete: true, detail: 'passage complet' };
  const resultat = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(resultat.message, 'Aucune nouvelle facture');
});

test('un connecteur ne peut pas fabriquer une attestation par un objet difforme', async () => {
  // `complete` doit être TRUE au sens strict : une chaîne « true », un 1, un
  // objet — rien de tout ça n'autorise la phrase.
  for (const complete of ['true', 1, {}, []]) {
    globalThis.__couverture = { complete, detail: 'x' };
    const resultat = await rattrapage();
    assert.doesNotMatch(
      resultat.message,
      /tout l'historique disponible a été parcouru/,
      `complete=${JSON.stringify(complete)}`
    );
  }
});
