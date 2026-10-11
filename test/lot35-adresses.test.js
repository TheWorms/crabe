'use strict';

/**
 * Lot 35, phase B — chaque adresse appelée par l'interface existe côté serveur.
 *
 * ─── Le trou que ce test bouche ──────────────────────────────────────────────
 *
 * Le lot 34 a « prouvé » l'autorisation de stockage de bout en bout en
 * appelant l'orchestrateur EN DIRECT, sans jamais passer par HTTP. L'interface
 * appelait `/api/destinations/:id/autorisation` alors que le routeur est monté
 * sous `/api/admin/destinations` : la première utilisation réelle est tombée
 * sur « Route inconnue », et il a fallu deux correctifs manuels le 15/08
 * (cd2a837, ce2fb08). Ce test confronte les adresses écrites dans `web/*.js`
 * aux routes RÉELLEMENT montées par `server/index.js` — celui-là aurait vu la
 * faute avant la production.
 *
 * ─── Ce que le test sait voir ────────────────────────────────────────────────
 *
 *   - tout appel `api('…')` / api(`…`) dont l'adresse est un littéral ou un
 *     gabarit : chaque `${…}` devient un joker qui accepte n'importe quel
 *     segment ;
 *   - les adresses COMPOSÉES de la modale partagée (`${rbBase()}/ticket`,
 *     `${base}/type`…) : chaque suffixe est vérifié contre CHAQUE base connue —
 *     c'est-à-dire les deux parcours, connecteur ET stockage. C'est exactement
 *     la leçon du 15/08 : une adresse bonne pour un parcours peut être fausse
 *     pour l'autre ;
 *   - les bases elles-mêmes (`rb().base = …`), extraites du source.
 *
 * ─── Ce que le test NE SAIT PAS voir (limites assumées) ──────────────────────
 *
 *   - la MÉTHODE HTTP n'est pas confrontée : une adresse juste appelée en
 *     DELETE là où seul GET existe passerait ;
 *   - un `${…}` est un joker : une mauvaise VALEUR à l'exécution (identifiant
 *     d'un autre objet, segment vide) n'est pas détectée — seule la FORME du
 *     chemin l'est ;
 *   - les chaînes de requête (`?…`) sont ignorées ;
 *   - un appel dont l'adresse est une VARIABLE (`api(base)`) n'est pas
 *     extrait ; il n'est couvert qu'à travers les bases connues ci-dessus.
 *     Toute nouvelle forme invérifiable doit être ajoutée à la liste blanche
 *     en toute conscience — sa simple apparition fait tomber le test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');

const WEB = path.resolve(__dirname, '..', 'web');
const FICHIERS = ['app.js', 'admin.js', 'login.js'];

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// Les routes réelles, lues sur l'application Express montée
// ---------------------------------------------------------------------------

/** Le préfixe de montage d'un routeur, reconstruit depuis son expression. */
function prefixeDeMontage(layer) {
  return layer.regexp.source
    .replace(/\\\//g, '/')
    .replace(/^\^/, '')
    .replace(/\/\?\(\?=\/\|\$\)$/, '')
    .replace(/\$$/, '');
}

/** Toutes les routes de l'application, chemins complets. */
function routesReelles() {
  const { createApp } = require('../server/index');
  const app = createApp();
  const routes = [];
  const parcourir = (stack, prefixe) => {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const p of [].concat(layer.route.path)) {
          routes.push((prefixe + p).replace(/\/+$/, '') || '/');
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        parcourir(layer.handle.stack, prefixe + prefixeDeMontage(layer));
      }
    }
  };
  parcourir(app._router.stack, '');
  return routes;
}

// ---------------------------------------------------------------------------
// Les adresses écrites dans l'interface
// ---------------------------------------------------------------------------

/** Normalise une adresse extraite : requête coupée, gabarits en jokers. */
function normalise(brut) {
  const sansRequete = brut.split('?')[0];
  return sansRequete
    .split('/')
    .map((segment) => (segment.includes('${') ? ':x' : segment))
    .join('/');
}

/**
 * Extrait les adresses `api(…)` d'un source, et sépare trois familles :
 * les adresses pleines, les suffixes composés (`${base}/type`), et les
 * appels invérifiables (`api(variable)`).
 */
function extraire(source) {
  const pleines = [];
  const composees = [];
  const invérifiables = [];

  for (const m of source.matchAll(/\bapi\(\s*(['"`])([^'"`]*?)\1/g)) {
    const adresse = m[2];
    if (adresse.startsWith('${')) {
      // `${base}/type`, `${rbBase()}/ticket` : le préfixe est une base connue.
      const coupe = adresse.replace(/^\$\{[^}]*\}/, '');
      composees.push(normalise(coupe));
    } else if (adresse.startsWith('/')) {
      pleines.push(normalise(adresse));
    } else {
      invérifiables.push(adresse);
    }
  }

  // Les appels dont l'argument est une expression nue : api(base), api(rb().base)…
  for (const m of source.matchAll(/\bapi\(\s*([a-zA-Z_$][\w$]*(?:\(\)|\.[\w$]+)*)\s*[,)]/g)) {
    invérifiables.push(m[1].trim());
  }

  return { pleines, composees, invérifiables };
}

/** Les bases de la modale partagée, extraites du source — jamais recopiées. */
function basesConnues(sourceApp) {
  const bases = [];
  for (const m of sourceApp.matchAll(/rb\(\)\.base\s*=\s*`([^`]+)`/g)) {
    bases.push(normalise(m[1]));
  }
  // Le repli de rbBase() quand `rb().base` n'est pas posé : le parcours
  // connecteur historique. On vérifie que le source le contient toujours —
  // s'il bouge, ce test doit être ajusté en conscience, pas ignoré.
  assert.match(sourceApp, /return rb\(\)\.connectorId \? `\/connectors\/\$\{rb\(\)\.connectorId\}\/remote-login` : null;/,
    'le repli de rbBase() a changé de forme : mettre à jour basesConnues()');
  bases.push('/connectors/:x/remote-login');
  return [...new Set(bases)];
}

/** Une adresse (jokers `:x`) correspond-elle à une route (`:param`) ? */
function correspond(adresse, route) {
  const a = adresse.split('/').filter(Boolean);
  const r = route.split('/').filter(Boolean);
  if (a.length !== r.length) return false;
  return a.every((seg, i) => r[i].startsWith(':') || seg === ':x' || seg === r[i]);
}

// ---------------------------------------------------------------------------
// Le test
// ---------------------------------------------------------------------------

test('chaque adresse appelée par l\'interface correspond à une route montée', () => {
  const routes = routesReelles();
  assert.ok(routes.length > 50, `l'introspection doit voir les routes (vu : ${routes.length})`);

  const sources = Object.fromEntries(
    FICHIERS.map((f) => [f, fs.readFileSync(path.join(WEB, f), 'utf8')])
  );
  const bases = basesConnues(sources['app.js']);
  assert.ok(bases.length >= 2, 'les deux parcours de la modale doivent être vus');

  const orphelines = [];
  for (const [fichier, source] of Object.entries(sources)) {
    const { pleines, composees } = extraire(source);
    assert.ok(pleines.length > 0, `${fichier} : l'extraction doit voir des adresses`);

    for (const adresse of pleines) {
      if (!routes.some((r) => correspond(`/api${adresse}`, r))) {
        orphelines.push(`${fichier} : ${adresse}`);
      }
    }
    // Un suffixe composé doit exister derrière CHAQUE base : la modale est
    // partagée, les deux parcours l'empruntent (la leçon du 15/08).
    for (const suffixe of composees) {
      for (const base of bases) {
        const adresse = `${base}${suffixe}`;
        if (!routes.some((r) => correspond(`/api${adresse}`, r))) {
          orphelines.push(`${fichier} : ${adresse} (composée : base « ${base} » + « ${suffixe} »)`);
        }
      }
    }
    // Et chaque base est elle-même une route (POST d'ouverture, DELETE, GET).
    for (const base of bases) {
      if (!routes.some((r) => correspond(`/api${base}`, r))) {
        orphelines.push(`${fichier} : ${base} (base de la modale)`);
      }
    }
  }

  assert.deepEqual(orphelines, [],
    'Ces adresses appelées par l\'interface ne correspondent à AUCUNE route montée '
    + '— c\'est la faute du 15/08 (adresse sans /admin) qui se reproduit :\n'
    + orphelines.join('\n'));
});

test('les appels invérifiables sont connus, listés, et rien de plus', () => {
  // La liste BLANCHE des expressions passées à api() sans littéral : chacune a
  // été lue et couverte autrement (les bases de la modale sont vérifiées
  // ci-dessus). Une entrée NOUVELLE ici doit être examinée, pas ignorée :
  // c'est peut-être la prochaine adresse fantôme.
  const ATTENDUS = new Set([
    'rb().base',   // openAutorisationStockage : POST sur la base stockage
    'base',        // startRemotePolling / cancelRemoteLogin : GET et DELETE sur rbBase()
    'path',        // le relais générique de login.js/app.js s'il apparaît
  ]);

  const vus = new Set();
  for (const fichier of FICHIERS) {
    const source = fs.readFileSync(path.join(WEB, fichier), 'utf8');
    for (const expr of extraire(source).invérifiables) vus.add(expr);
  }

  const inconnus = [...vus].filter((e) => !ATTENDUS.has(e));
  assert.deepEqual(inconnus, [],
    'Nouvel appel api() dont l\'adresse n\'est ni un littéral ni une base connue — '
    + 'à examiner puis à documenter ici :\n' + inconnus.join('\n'));
});
