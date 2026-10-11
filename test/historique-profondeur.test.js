'use strict';

/**
 * Lot 17 — la profondeur d'historique, y compris pour les services à API.
 *
 * ─── Le défaut que ces tests empêchent de revenir ────────────────────────────
 *
 * Un compte OVHcloud ouvert en 2021, 67 factures, et crabe n'en remontait que
 * douze mois — quel que soit le réglage, parce qu'il n'y avait pas de réglage :
 * `DEFAULT_MONTHS_BACK = 12` partait directement dans `date.from` de
 * `/me/bill`. La fenêtre étant envoyée À L'API, les factures antérieures
 * n'étaient jamais listées : rien, côté crabe, ne pouvait les rattraper.
 *
 * Ce qui est vérifié ici :
 *
 *   - `history.fenetreDeDates()` traduit les quatre modes en bornes de dates,
 *     alignées sur les mêmes années civiles que `anneesAParcourir()` — sinon le
 *     même réglage ne dirait pas la même chose selon que le service est scrapé
 *     ou appelé en API ;
 *   - « tout » et le premier passage de « depuis » ne posent AUCUNE borne
 *     basse : c'est ce `null` qui va chercher 2021 ;
 *   - le connecteur OVH n'envoie `date.from` que quand la fenêtre en a une ;
 *   - tous les connecteurs livrés proposent le réglage, avec le même libellé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const history = require('../server/connectors/history');
const scraping = require('../server/connectors/scraping');
const ovh = require('../server/connectors/available/ovh-api/connector');
const registry = require('../server/connectors/registry');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

/** Un mardi de juin : loin du recouvrement de janvier-mars. */
const EN_JUIN = new Date('2026-06-15T10:00:00Z');
/** Février : le mois où l'année précédente reste parcourue. */
const EN_FEVRIER = new Date('2026-02-10T10:00:00Z');

const jour = (date) => (date ? date.toISOString().slice(0, 10) : null);

// ---------------------------------------------------------------------------
// history.fenetreDeDates()
// ---------------------------------------------------------------------------

test('« toutes les années » ne pose aucune borne basse', () => {
  const plan = history.fenetreDeDates({ valeur: 'tout', maintenant: EN_JUIN });
  assert.equal(plan.from, null, 'une borne, même ancienne, resterait un plafond');
  assert.equal(jour(plan.to), '2026-06-15');
  assert.equal(plan.mode, 'tout');
});

test('« les N dernières années » part du 1er janvier, pas de N×12 mois glissants', () => {
  // C'est la règle d'anneesAParcourir() : « les 2 dernières années » en juin
  // 2026, ce sont 2025 et 2026 EN ENTIER. Deux fonctions qui décriraient des
  // passés différents rendraient le réglage incompréhensible.
  const plan = history.fenetreDeDates({ valeur: 'dernieres:2', maintenant: EN_JUIN });
  assert.equal(jour(plan.from), '2025-01-01');

  const cinq = history.fenetreDeDates({ valeur: 'dernieres:5', maintenant: EN_JUIN });
  assert.equal(jour(cinq.from), '2022-01-01');
});

test('« année en cours » s\'arrête au 1er janvier', () => {
  const plan = history.fenetreDeDates({ valeur: 'courante', maintenant: EN_JUIN });
  assert.equal(jour(plan.from), '2026-01-01');
});

test('« depuis la dernière récupération » va tout chercher au premier passage', () => {
  const premier = history.fenetreDeDates({
    valeur: 'depuis',
    maintenant: EN_JUIN,
    dejaRecupere: false,
  });
  assert.equal(premier.from, null, 'le premier passage doit rattraper tout le passé');

  const ensuite = history.fenetreDeDates({
    valeur: 'depuis',
    maintenant: EN_JUIN,
    dejaRecupere: true,
  });
  assert.equal(jour(ensuite.from), '2026-01-01');
});

test('de janvier à mars, la fenêtre couvre aussi l\'année précédente', () => {
  // Une facture de décembre émise en janvier serait perdue pour toujours par
  // une fenêtre qui s'arrête au 1er janvier.
  const plan = history.fenetreDeDates({
    valeur: 'depuis',
    maintenant: EN_FEVRIER,
    dejaRecupere: true,
  });
  assert.equal(jour(plan.from), '2025-01-01');
  assert.match(plan.raison, /décembre/);
});

test('une valeur abîmée retombe sur le défaut, elle ne fait pas échouer la fenêtre', () => {
  const plan = history.fenetreDeDates({ valeur: 'n\'importe quoi', maintenant: EN_JUIN });
  assert.equal(plan.mode, history.DEFAUT);
});

test('les deux façons de décrire le passé s\'accordent sur les mêmes années', () => {
  // Le même réglage, lu par un connecteur scrapé et par un connecteur à API :
  // la borne de la fenêtre doit tomber sur la plus ancienne année retenue.
  for (const valeur of ['dernieres:3', 'courante']) {
    const annees = history.anneesAParcourir({
      valeur,
      disponibles: [2026, 2025, 2024, 2023, 2022, 2021],
      maintenant: EN_JUIN,
      dejaRecupere: true,
    }).annees;
    const fenetre = history.fenetreDeDates({ valeur, maintenant: EN_JUIN, dejaRecupere: true });

    assert.equal(
      jour(fenetre.from),
      `${Math.min(...annees)}-01-01`,
      `${valeur} : la fenêtre doit commencer à la plus ancienne année parcourue`
    );
  }
});

// ---------------------------------------------------------------------------
// Le connecteur OVH — ce qui part réellement vers l'API
// ---------------------------------------------------------------------------

test('sans borne basse, aucun date.from n\'est envoyé à l\'API OVH', () => {
  // /me/bill sans date.from rend TOUT l'historique : c'est ce comportement,
  // et lui seul, qui va chercher les factures de 2021.
  const { params } = ovh.fenetreApi({ historique: 'tout' }, {});
  assert.equal('date.from' in params, false);
  assert.ok(params['date.to'], 'la borne haute reste envoyée');
});

test('une profondeur limitée se traduit bien en date.from', () => {
  const { params, plan } = ovh.fenetreApi({ historique: 'courante' }, {});
  assert.ok(params['date.from'], 'sans date.from, OVH renverrait tout');
  assert.equal(params['date.from'].slice(5), '01-01T00:00:00.000Z');
  assert.equal(plan.mode, 'courante');
});

test('le connecteur OVH ne plafonne plus à douze mois, quoi qu\'envoie le planificateur', () => {
  // Le planificateur envoie `monthsBack: 12` à tout le monde. Ce contexte ne
  // doit plus rien plafonner : c'est le réglage du compte qui décide.
  const { params } = ovh.fenetreApi({}, { monthsBack: 12 });
  assert.equal(
    'date.from' in params,
    false,
    'le défaut « depuis » au premier passage doit aller chercher tout le passé'
  );

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'available', 'ovh-api', 'connector.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /DEFAULT_MONTHS_BACK/, 'le plafond en dur ne doit pas revenir');
});

test('une récupération déjà faite resserre la fenêtre sur l\'année en cours', () => {
  const { params } = ovh.fenetreApi({ historique: 'depuis' }, { knownRemoteIds: ['FR1'] });
  assert.ok(params['date.from'], 'le rattrapage complet n\'a lieu qu\'une fois');
});

// ---------------------------------------------------------------------------
// Le socle de scraping générique
// ---------------------------------------------------------------------------

test('sans réglage enregistré, le socle de scraping garde son comportement d\'avant', () => {
  // Un appel direct — un test — n'a pas de configuration à lire : il doit
  // continuer de fonctionner comme avant le lot 17.
  assert.equal(scraping.planHistorique({ username: 'x' }, { monthsBack: 3 }), null);
});

test('le réglage du compte prime sur le monthsBack du planificateur', () => {
  const plan = scraping.planHistorique({ historique: 'tout' }, { monthsBack: 12 });
  assert.equal(plan.from, null);
});

test('un document sans date n\'est jamais écarté par la fenêtre', () => {
  // Ne pas savoir dater une facture n'est pas une raison de la perdre : elle
  // sera dédoublonnée par son identifiant distant.
  const plan = history.fenetreDeDates({ valeur: 'courante', maintenant: EN_JUIN });
  assert.equal(scraping.dansLaFenetre(null, plan), true);
  assert.equal(scraping.dansLaFenetre('', plan), true);
  assert.equal(scraping.dansLaFenetre('2026-03-01', plan), true);
  assert.equal(scraping.dansLaFenetre('2025-12-31', plan), false);
});

test('la simulation reflète la profondeur demandée, sans jamais être infinie', () => {
  const tout = history.fenetreDeDates({ valeur: 'tout', maintenant: EN_JUIN });
  const mois = scraping.moisDeLaFenetre(tout);
  assert.ok(mois > 12, 'une fenêtre ouverte doit remonter plus loin que l\'ancien plafond');
  assert.ok(Number.isFinite(mois) && mois <= 60, 'mais une simulation doit s\'arrêter');

  const courante = history.fenetreDeDates({ valeur: 'courante', maintenant: EN_JUIN });
  assert.equal(scraping.moisDeLaFenetre(courante), 6, 'janvier à juin');
});

// ---------------------------------------------------------------------------
// Le catalogue : le même choix partout
// ---------------------------------------------------------------------------

/**
 * Free Mobile est la seule exception, et elle est du côté du fournisseur :
 * Free ne conserve que les douze dernières factures de la ligne. Un réglage de
 * profondeur y proposerait un choix que le portail ne peut pas honorer.
 */
const SANS_HISTORIQUE = new Set(['free-mobile']);

test('chaque connecteur livré propose le réglage de profondeur, avec le même libellé', () => {
  registry.load();

  const manquants = [];
  for (const manifest of registry.listAvailable()) {
    const champ = (manifest.fields || []).find((f) => f.type === 'history');

    if (!champ) {
      if (!SANS_HISTORIQUE.has(manifest.id)) manquants.push(manifest.id);
      continue;
    }

    // Les mêmes mots partout : quelqu'un qui a réglé sa boutique PrestaShop
    // doit reconnaître le réglage sur son hébergeur sans y réfléchir.
    assert.equal(champ.key, 'historique', `${manifest.id} : clé du champ`);
    assert.equal(champ.label, 'Historique à récupérer', `${manifest.id} : libellé du champ`);
    assert.equal(champ.default, 'depuis', `${manifest.id} : le défaut est l'incrémental`);
    assert.ok(champ.help, `${manifest.id} : le champ doit dire ce qu'il fait`);
  }

  assert.deepEqual(manquants, [], 'ces connecteurs plafonnent encore sans le dire');
});

test('les quatre choix offerts sont ceux du socle, jamais réécrits par un connecteur', () => {
  const modes = history.choix().map((c) => c.mode);
  assert.deepEqual(modes, ['tout', 'dernieres', 'courante', 'depuis']);
});
