'use strict';

/**
 * Lot 25, phase B — Infomaniak et ses organisations.
 *
 * ─── Le défaut, mesuré sur le compte réel le 13/08/2026 ─────────────────────
 *
 * Le connecteur lisait UN numéro de compte — celui vers lequel la racine du
 * manager redirige — et s'arrêtait là. `GET /proxy/1/accounts` en rend
 * **trois**, toutes avec facturation, toutes joignables :
 *
 *     854637   (celle de l'URL)   67 factures
 *     880049                      12 factures
 *     2036138                      3 factures
 *
 * Quinze factures existaient et n'étaient jamais récupérées, sans qu'aucun
 * message ne le laisse soupçonner : le connecteur annonçait consciencieusement
 * le compte qu'il connaissait.
 *
 * Ce fichier ne joint pas Infomaniak : il vérifie les fonctions pures et le
 * comportement de la liste des organisations face à un faux contexte de
 * requête. Ce qui demande un compte réel — que la récupération rapporte bien
 * les factures des trois organisations — sera vérifié par l'utilisateur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const connecteur = require('../server/connectors/available/infomaniak/connector');
const manifeste = require('../server/connectors/available/infomaniak/manifest.json');
const discovery = require('../server/connectors/discovery');

/**
 * Un faux contexte Playwright : il ne rend que ce qu'on lui dit de rendre.
 *
 * @param {(url: string) => {status?: number, body?: any, illisible?: boolean}} repondre
 */
function faussContexte(repondre) {
  return {
    request: {
      async get(url) {
        const r = repondre(url) || {};
        const status = r.status ?? 200;
        return {
          status: () => status,
          ok: () => status >= 200 && status < 300,
          async json() {
            if (r.illisible) throw new Error('réponse illisible');
            return r.body;
          },
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// La route, et rien d'autre
// ---------------------------------------------------------------------------

test('la route des organisations est celle qui a été mesurée', () => {
  // ⚠ /proxy/1/ et non /proxy/2/. Les deux répondent 200 sur le compte réel,
  // mais la version 2 rend un objet sans liste exploitable. C'est le genre de
  // détail qui coûte une demi-heure si on suppose que le numéro de version
  // suit celui de la facturation.
  assert.equal(connecteur.ROUTE_ORGANISATIONS, 'https://manager.infomaniak.com/proxy/1/accounts');
});

// ---------------------------------------------------------------------------
// La liste des organisations
// ---------------------------------------------------------------------------

test('les organisations sont rendues, l\'organisation courante en tête', async () => {
  const contexte = faussContexte(() => ({
    body: {
      data: [
        { id: 880049, name: 'Entreprise' },
        { id: 854637, name: 'Perso' },
        { id: 2036138, name: 'Association' },
      ],
    },
  }));

  const orgs = await connecteur.listerOrganisations(contexte, '854637');
  assert.deepEqual(orgs.map((o) => o.id), ['854637', '880049', '2036138']);

  // Celle de l'URL passe en tête, et c'est ce qui lui laisse le rang
  // « principale » que le socle donne au premier élément (lot 9). Ses factures
  // sont déjà rangées sous son numéro : un changement d'ordre chez Infomaniak
  // ne doit pas renommer le dossier de référence.
  assert.equal(orgs[0].id, '854637');
});

test('une organisation inaccessible ou bloquée n\'est pas proposée', async () => {
  const contexte = faussContexte(() => ({
    body: {
      data: [
        { id: 1, name: 'Vivante' },
        { id: 2, name: 'Sans accès', no_access: true },
        { id: 3, name: 'Bloquée', is_blocked: true },
      ],
    },
  }));

  const orgs = await connecteur.listerOrganisations(contexte, '1');
  // Elle ne rendrait jamais de facture : la proposer ferait une case à cocher
  // qui ne peut qu'échouer, et l'utilisateur croirait à un défaut de crabe.
  assert.deepEqual(orgs.map((o) => o.id), ['1']);
});

test('un échec de la route ne coupe RIEN : on retombe sur le compte de l\'URL', async () => {
  const dits = [];
  const log = (m) => dits.push(m);

  for (const panne of [{ status: 500 }, { illisible: true }, { body: { data: [] } }]) {
    const orgs = await connecteur.listerOrganisations(faussContexte(() => panne), '854637', log);
    assert.deepEqual(
      orgs.map((o) => o.id),
      ['854637'],
      'un compte à une seule organisation doit fonctionner comme avant ce lot'
    );
  }
  // Et ça se dit dans les journaux : un repli silencieux se transformerait en
  // « pourquoi ne récupère-t-il plus qu'un compte sur trois ? » sans réponse.
  assert.equal(dits.length, 3);
  for (const m of dits) assert.match(m, /organisation courante/);
});

test('une session expirée remonte telle quelle, avec son geste de réparation', async () => {
  const contexte = faussContexte(() => ({ status: 401 }));
  await assert.rejects(
    () => connecteur.listerOrganisations(contexte, '854637'),
    (err) => {
      assert.equal(err.sessionExpired, true, 'le socle doit reconnaître la cause');
      assert.match(err.message, /Rouvrez-la depuis la fiche du service/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// L'écran de sélection
// ---------------------------------------------------------------------------

test('un élément découvert porte un nom, un compte, et AUCUN badge', () => {
  const item = connecteur.enElementDecouvert({ id: 854637, name: 'Perso' }, 67, 0);
  assert.equal(item.id, '854637');
  assert.equal(item.label, 'Perso');
  assert.match(item.detail, /67 facture/);

  // ⚠ La règle du lot 9 : le rang vient de l'INDEX, décidé par le socle. Un
  // badge posé ici serait ignoré, et le poser inviterait à croire qu'il compte.
  assert.equal('badge' in item, false);

  // Une organisation sans nom reste reconnaissable par son numéro.
  assert.equal(connecteur.enElementDecouvert({ id: 42 }, 0, 1).label, 'Organisation 42');

  // ⚠ NON MESURÉE = DÉTAIL VIDE, et c'est un correctif du lot 26. La phrase
  // « nombre de factures non mesuré » écrite ici passait pour un vrai détail :
  // `discovery.merge()` ne conserve l'ancien que si le nouveau est VIDE, et la
  // première synchronisation venue — qui ne compte pas, à dessein — écrasait
  // donc « 77 facture(s) » par cette phrase. Mesuré sur le compte réel : les
  // trois organisations affichaient « non mesuré » une heure après avoir été
  // comptées, et l'écran de sélection n'aidait plus à choisir.
  assert.equal(connecteur.enElementDecouvert({ id: 42 }, null, 1).detail, '');
});

test('toutes les organisations sont cochées d\'office', () => {
  const items = [
    connecteur.enElementDecouvert({ id: 1, name: 'A' }, 10, 0),
    connecteur.enElementDecouvert({ id: 2, name: 'B' }, 5, 1),
    connecteur.enElementDecouvert({ id: 3, name: 'C' }, 3, 2),
  ];
  // ⚠ À la différence de Free Mobile, qui ne coche que la première ligne. Ce
  // n'est pas une hésitation : chez Free, les lignes secondaires sont un choix
  // qu'on peut vouloir refuser ; ici, chaque organisation émet SES factures, et
  // n'en cocher qu'une reproduirait exactement le défaut que ce lot corrige.
  assert.deepEqual(items.map((i) => i.preselected), [true, true, true]);
});

test('le socle range les organisations, et c\'est l\'index qui fait le rang', () => {
  const decouverts = [
    connecteur.enElementDecouvert({ id: 854637, name: 'Perso' }, 67, 0),
    connecteur.enElementDecouvert({ id: 880049, name: 'Entreprise' }, 12, 1),
  ];
  const bilan = discovery.reconcile({ known: null, discovered: decouverts, selection: null });

  // « Entreprise » est plus long, plus « officiel », et arrive quand même
  // second : aucune analyse de libellé, jamais — c'est l'index qui décide.
  assert.deepEqual(bilan.active.map((i) => i.badge), ['principale', 'secondaire']);
  assert.deepEqual(bilan.selection, ['854637', '880049'], 'les deux sont retenues d\'office');
});

// ---------------------------------------------------------------------------
// Le manifeste
// ---------------------------------------------------------------------------

test('le champ de sélection est déclaré comme celui de Free Mobile', () => {
  const champ = manifeste.fields.find((f) => f.key === 'organisations');
  assert.ok(champ, 'le champ doit exister');
  assert.equal(champ.type, 'multiselect');
  assert.equal(champ.source, 'discover', 'la liste vient de la découverte, pas d\'une saisie');
  assert.equal(champ.required, false, 'un compte à une seule organisation ne coche rien');

  // Il se place entre la connexion et l'historique : l'ordre de la fiche suit
  // l'ordre des gestes — on se connecte, on choisit quoi récupérer, on dit
  // jusqu'où remonter.
  assert.deepEqual(manifeste.fields.map((f) => f.key), ['session', 'organisations', 'historique']);

  // Ce que l'aide doit dire, parce que c'est la question qu'on se pose devant :
  // ce qui arrive quand on décoche.
  assert.match(champ.notice, /ne supprime rien/i);
});

test('le connecteur expose bien une étape de découverte', () => {
  assert.equal(typeof connecteur.discover, 'function');
});
