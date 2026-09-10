'use strict';

/**
 * Lot 79 — le verrou sur la régression du lot 78 : la liste Bricomarché ne
 * rend son tableau QUE si son adresse porte ses deux paramètres
 * (`choiceOrder=0&historyOrderFilter=all`, mesuré par l'utilisateur le 09/09/2026).
 * Cette régression a traversé deux lots ; un changement d'adresse de liste
 * qui ferait retomber le comptage à zéro doit faire chuter un test — ceux-ci.
 */

const test = require('node:test');
const assert = require('node:assert');

const bricomarche = require('../server/connectors/available/bricomarche/connector');

test('Bricomarché : la liste se vise TOUJOURS avec ses deux paramètres mesurés', () => {
  // Le href nu du menu (journalisé au lot 78) doit ressortir paramétré.
  const adresse = bricomarche.adresseHistorique('/my-account/orders', 'https://www.bricomarche.com/my-account');
  const url = new URL(adresse);
  assert.equal(url.origin + url.pathname, 'https://www.bricomarche.com/my-account/orders');
  assert.equal(url.searchParams.get('choiceOrder'), '0',
    'sans choiceOrder=0, la page servie filtre sur autre chose que « Mes achats sur le site »');
  assert.equal(url.searchParams.get('historyOrderFilter'), 'all',
    'sans historyOrderFilter=all, la page filtre sur « De 2026 » et le tableau ne se rend pas');
});

test('Bricomarché : sans href du menu, le repli vise la même adresse paramétrée', () => {
  assert.equal(
    bricomarche.adresseHistorique(),
    'https://www.bricomarche.com/my-account/orders?choiceOrder=0&historyOrderFilter=all'
  );
});

test('Bricomarché : des paramètres déjà portés par le lien ne sont pas écrasés', () => {
  // Si le site met lui-même ses filtres dans le lien, on suit le site.
  const adresse = bricomarche.adresseHistorique(
    '/my-account/orders?choiceOrder=1&historyOrderFilter=all',
    'https://www.bricomarche.com/my-account'
  );
  const url = new URL(adresse);
  assert.equal(url.searchParams.get('choiceOrder'), '1');
  assert.equal(url.searchParams.get('historyOrderFilter'), 'all');
});

test('Bricomarché : une adresse déjà complète est reconnue comme telle (pas de re-navigation)', () => {
  const complete = bricomarche.adresseHistorique();
  assert.equal(bricomarche.adresseHistorique(complete), complete);
});

test('Bricomarché : le verrou du lot 79 — les paramètres mesurés ne bougent pas en silence', () => {
  // Quiconque retire ou renomme un paramètre doit passer par ici et dire pourquoi.
  assert.deepEqual(bricomarche.PARAMETRES_HISTORIQUE, { choiceOrder: '0', historyOrderFilter: 'all' });
  assert.equal(bricomarche.CHEMIN_HISTORIQUE, '/my-account/orders');
});
