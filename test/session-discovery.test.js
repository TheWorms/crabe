'use strict';

/**
 * Lot 5 — le socle qu'exige Free Mobile, et le connecteur lui-même.
 *
 * Ce que ces tests attrapent, et qui a réellement coûté du temps :
 *
 *   - un fichier de session corrompu, vide ou périmé accepté en silence, pour
 *     ne se révéler qu'à la première récupération planifiée, un mois plus tard ;
 *   - `?login=94994336` pris pour la page de connexion — la session serait
 *     déclarée expirée à chaque exécution alors qu'elle est parfaitement
 *     valide ;
 *   - la carte « Ma dernière facture », dont la date se lit sur une PLAGE et
 *     non sur un « Mois AAAA » : sans elle, la facture la plus récente de
 *     chaque ligne est mal nommée ;
 *   - une ligne ouverte en cours d'année jamais récupérée faute d'avoir été
 *     cochée à la main ;
 *   - des factures relevées après une bascule non confirmée, donc rangées sous
 *     le numéro d'une autre ligne, en silence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const sessionState = require('../server/connectors/session-state');
const discovery = require('../server/connectors/discovery');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const freeMobile = require('../server/connectors/available/free-mobile/connector');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

const MAINTENANT = Math.floor(Date.now() / 1000);
const JOUR = 86_400;

/** Un état de session Playwright plausible. */
function sessionFactice({ expires = MAINTENANT + 180 * JOUR, cookies = null } = {}) {
  return JSON.stringify({
    cookies: cookies || [
      { name: 'session', value: 'abc', domain: '.free.fr', path: '/', expires },
      { name: 'court', value: 'def', domain: 'mobile.free.fr', path: '/', expires: expires - 90 * JOUR },
    ],
    origins: [{ origin: 'https://mobile.free.fr', localStorage: [] }],
  });
}

// ---------------------------------------------------------------------------
// §1.1 — validation d'un fichier de session
// ---------------------------------------------------------------------------

test('une session bien formée est acceptée, avec l\'échéance du cookie le plus durable', () => {
  const echeance = MAINTENANT + 120 * JOUR;
  const result = sessionState.validate(sessionFactice({ expires: echeance }));

  assert.equal(result.ok, true, result.error);
  assert.equal(result.summary.cookieCount, 2);
  assert.equal(result.summary.originCount, 1);
  // L'échéance retenue est la PLUS LOINTAINE, pas la première rencontrée.
  assert.equal(result.summary.expiresAt, new Date(echeance * 1000).toISOString());
  assert.equal(result.summary.expired, false);
});

test('une session entièrement expirée est refusée, en disant depuis quand', () => {
  const result = sessionState.validate(sessionFactice({ expires: MAINTENANT - 10 * JOUR }));

  assert.equal(result.ok, false);
  assert.match(result.error, /expir/i);
  // Lot 9 : plus une seule ligne de commande sous les yeux de l'utilisateur —
  // ces messages arrivent tels quels dans son interface. Ils disent quoi faire.
  assert.match(result.error, /Reconnectez-vous/i);
  assert.equal(result.error.includes('capture-session'), false, 'aucune commande');
  assert.equal(result.summary, null, 'aucun résumé pour une session inutilisable');
});

test('une session à demi expirée reste valable tant qu\'un cookie tient', () => {
  const result = sessionState.validate(
    sessionFactice({
      cookies: [
        { name: 'vieux', value: 'a', domain: '.free.fr', expires: MAINTENANT - JOUR },
        { name: 'bon', value: 'b', domain: '.free.fr', expires: MAINTENANT + 30 * JOUR },
      ],
    })
  );
  assert.equal(result.ok, true, result.error);
});

test('un cookie de session (expires -1) n\'est pas un cookie expiré', () => {
  const result = sessionState.validate(
    JSON.stringify({ cookies: [{ name: 's', value: 'x', domain: '.free.fr', expires: -1 }] })
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.summary.expiresAt, null, 'aucune échéance à annoncer');
  assert.equal(result.summary.expired, false);
});

test('un fichier corrompu, vide ou étranger est refusé avec un message utile', () => {
  const cas = [
    ['', /Aucune connexion/i],
    ['{ceci n\'est pas du json', /JSON valide/i],
    ['[1, 2, 3]', /objet JSON/i],
    ['{"origins":[]}', /aucun cookie de navigateur/i],
    ['{"cookies":[]}', /vide/i],
  ];
  for (const [contenu, motif] of cas) {
    const result = sessionState.validate(contenu);
    assert.equal(result.ok, false, `« ${contenu} » aurait dû être refusé`);
    assert.match(result.error, motif);
    // Aucun de ces messages ne nomme un fichier, une commande ou un chemin :
    // ils s'affichent tels quels devant quelqu'un qui n'a jamais ouvert un
    // terminal (lot 9, §4).
    assert.equal(
      /capture-session|node |tools\/|\.js\b/.test(result.error),
      false,
      `« ${result.error} » parle encore technique`
    );
  }
});

test('le résumé ne laisse jamais fuir le contenu de la session', () => {
  const summary = sessionState.validate(sessionFactice()).summary;
  const serialise = JSON.stringify(summary);
  assert.equal(serialise.includes('abc'), false, 'valeur de cookie exposée');
  assert.equal(serialise.includes('def'), false, 'valeur de cookie exposée');
});

// ---------------------------------------------------------------------------
// §1.1 — le champ « session » dans une configuration de connecteur
// ---------------------------------------------------------------------------

test('enregistrer une session la chiffre et n\'en ressort que la date et l\'échéance', async () => {
  const user = await helpers.createUser({ username: 'sessionnaire' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', { session: sessionFactice() });

  const install = registry.getInstall(user.id, 'free-mobile');
  assert.ok(install.config_encrypted, 'la configuration doit être chiffrée');
  assert.equal(
    install.config_encrypted.includes('cookies'),
    false,
    'le contenu ne doit jamais apparaître en clair en base'
  );

  const summary = registry.configSummary(user.id, 'free-mobile');
  assert.ok(summary.sessions.session.savedAt, 'date d\'enregistrement attendue');
  assert.ok(summary.sessions.session.expiresAt, 'échéance attendue');
  assert.equal(summary.sessions.session.expired, false);
  assert.equal(
    JSON.stringify(summary).includes('abc'),
    false,
    'le résumé ne doit contenir aucune valeur de cookie'
  );
});

test('une session invalide est refusée à l\'enregistrement, en 400', async () => {
  const user = await helpers.createUser({ username: 'maladroit' });
  registry.install(user.id, 'free-mobile');

  assert.throws(
    () => registry.saveConfig(user.id, 'free-mobile', { session: '{"cookies":[]}' }),
    (err) => err.statusCode === 400 && /vide/i.test(err.message)
  );
  assert.equal(
    registry.getInstall(user.id, 'free-mobile').config_encrypted,
    null,
    'rien ne doit être enregistré après un refus'
  );
});

test('un champ session laissé vide conserve celle déjà enregistrée', async () => {
  const user = await helpers.createUser({ username: 'fidele' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', { session: sessionFactice() });
  const avant = registry.readConfig(user.id, 'free-mobile').session;

  registry.saveConfig(user.id, 'free-mobile', { session: '' });
  assert.equal(registry.readConfig(user.id, 'free-mobile').session, avant);
});

test('la vue publique d\'un manifeste ne laisse pas fuir un champ de session', () => {
  const publique = schema.publicView(registry.manifest('free-mobile'));
  const champ = publique.fields.find((f) => f.key === 'session');
  assert.equal(champ.type, 'session');
  assert.equal(publique.discovery, true, 'le front doit savoir qu\'une découverte suit');
  assert.equal(JSON.stringify(publique).includes('config_encrypted'), false);
});

// ---------------------------------------------------------------------------
// §1.2 / §1.3 — découverte et sélection
// ---------------------------------------------------------------------------

const LIGNES = [
  { id: '0628000000', label: 'Camille Dupont', badge: 'principale', detail: '12 factures', preselected: true },
  { id: '0749000000', label: 'Camille Dupont', badge: 'résiliée', detail: '12 factures', preselected: false },
];

test('à la première découverte, seuls les éléments pré-cochés partent en sélection', () => {
  const outcome = discovery.reconcile({ known: null, discovered: LIGNES, selection: null });
  assert.deepEqual(outcome.selection, ['0628000000']);
  assert.deepEqual(outcome.added, [], 'rien n\'est « nouveau » au premier passage');
  assert.deepEqual(outcome.missing, []);
});

test('un élément jamais vu rejoint la sélection tout seul', () => {
  const nouvelle = { id: '0612345678', label: 'Camille Dupont', badge: 'principale' };
  const outcome = discovery.reconcile({
    known: LIGNES,
    discovered: [...LIGNES, nouvelle],
    selection: ['0628000000'],
  });

  assert.deepEqual(outcome.added, ['0612345678']);
  assert.ok(outcome.selection.includes('0612345678'), 'la nouvelle ligne doit être récupérée');
  assert.ok(outcome.selection.includes('0628000000'), 'la sélection existante est conservée');
});

test('un élément connu mais décoché reste décoché — ce n\'est pas une nouveauté', () => {
  // Le point qui justifie de mémoriser les éléments VUS, et pas seulement les
  // éléments SÉLECTIONNÉS : sans cela, la ligne résiliée décochée par
  // l'utilisateur serait recochée d'office à chaque exécution.
  const outcome = discovery.reconcile({
    known: LIGNES,
    discovered: LIGNES,
    selection: ['0628000000'],
  });
  assert.deepEqual(outcome.added, []);
  assert.deepEqual(outcome.selection, ['0628000000']);
});

test('un élément disparu est conservé en configuration, mais ignoré', () => {
  const outcome = discovery.reconcile({
    known: LIGNES,
    discovered: [LIGNES[0]],
    selection: ['0628000000', '0749000000'],
  });

  assert.deepEqual(outcome.missing, ['0749000000']);
  assert.ok(outcome.selection.includes('0749000000'), 'la sélection n\'est pas amputée');
  assert.deepEqual(outcome.active.map((i) => i.id), ['0628000000'], 'mais rien n\'est relevé pour elle');
});

test('le rapprochement écrit la sélection élargie dans la configuration chiffrée', async () => {
  const user = await helpers.createUser({ username: 'multiligne' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', {
    session: sessionFactice(),
    lignes: ['0628000000'],
  });
  discovery.save(user.id, 'free-mobile', 'lignes', LIGNES);

  const journal = [];
  const reconcile = registry.makeReconciler(user.id, 'free-mobile', (m) => journal.push(m));
  const outcome = reconcile('lignes', [
    ...LIGNES,
    { id: '0612345678', label: 'Camille Dupont', badge: 'principale' },
  ]);

  assert.deepEqual(outcome.added, ['0612345678']);
  assert.deepEqual(
    registry.readConfig(user.id, 'free-mobile').lignes.sort(),
    ['0612345678', '0628000000']
  );
  assert.equal(
    journal.some((m) => m.includes('nouvelle ligne 0612345678 détectée et ajoutée')),
    true,
    'l\'ajout automatique doit être signalé dans les journaux'
  );
});

test('une récupération ne fait pas disparaître le détail des éléments déjà connus', async () => {
  // Le connecteur redécouvre ses lignes en cours de récupération, mais sans
  // compter leurs factures : cela coûterait une bascule de plus par ligne. Sans
  // fusion, la fiche perdrait ses « 12 factures » à la première synchronisation.
  const user = await helpers.createUser({ username: 'detaille' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', { session: sessionFactice(), lignes: ['0628000000'] });
  discovery.save(user.id, 'free-mobile', 'lignes', LIGNES);

  const reconcile = registry.makeReconciler(user.id, 'free-mobile');
  reconcile('lignes', LIGNES.map((l) => ({ ...l, detail: '' })));

  const apres = discovery.read(user.id, 'free-mobile', 'lignes').items;
  assert.equal(apres.find((i) => i.id === '0628000000').detail, '12 factures');
  assert.equal(apres.find((i) => i.id === '0749000000').label, 'Camille Dupont');
});

test('une sélection vide est une valeur, pas une absence de valeur', async () => {
  const user = await helpers.createUser({ username: 'refusetout' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', { session: sessionFactice(), lignes: ['0628000000'] });

  registry.saveConfig(user.id, 'free-mobile', { lignes: [] });
  assert.deepEqual(registry.readConfig(user.id, 'free-mobile').lignes, []);

  // Non fourni du tout : la sélection précédente est conservée.
  registry.saveConfig(user.id, 'free-mobile', { lignes: ['0749000000'] });
  registry.saveConfig(user.id, 'free-mobile', {});
  assert.deepEqual(registry.readConfig(user.id, 'free-mobile').lignes, ['0749000000']);
});

test('les éléments découverts sont chiffrés au repos', async () => {
  const user = await helpers.createUser({ username: 'discret' });
  discovery.save(user.id, 'free-mobile', 'lignes', LIGNES);

  const brut = helpers.db
    .get()
    .prepare('SELECT items_encrypted FROM connector_discoveries WHERE user_id = ?')
    .get(user.id).items_encrypted;

  assert.equal(brut.includes('Camille'), false, 'le nom du titulaire ne doit pas être en clair');
  assert.equal(brut.includes('0628000000'), false, 'le numéro ne doit pas être en clair');
  assert.deepEqual(discovery.read(user.id, 'free-mobile', 'lignes').items.map((i) => i.id), [
    '0628000000',
    '0749000000',
  ]);
});

test('désinstaller un connecteur oublie ce qu\'il avait découvert', async () => {
  const user = await helpers.createUser({ username: 'oublieux' });
  registry.install(user.id, 'free-mobile');
  discovery.save(user.id, 'free-mobile', 'lignes', LIGNES);

  registry.uninstall(user.id, 'free-mobile');
  assert.equal(discovery.read(user.id, 'free-mobile', 'lignes'), null);
});

test('une nouveauté vue à la découverte reste acquise, même sans validation', async () => {
  // L'utilisateur peut quitter l'écran de sélection par « Retour ». Si la
  // découverte ne persistait rien, la ligne nouvellement vue cesserait d'être
  // « jamais vue » sans avoir rejoint la sélection : elle serait perdue pour
  // de bon.
  const user = await helpers.createUser({ username: 'hesitant' });
  registry.install(user.id, 'free-mobile');
  registry.saveConfig(user.id, 'free-mobile', { session: sessionFactice(), lignes: ['0628000000'] });
  discovery.save(user.id, 'free-mobile', 'lignes', LIGNES);

  const reconcile = registry.makeReconciler(user.id, 'free-mobile');
  reconcile('lignes', [...LIGNES, { id: '0612345678', label: 'Camille Dupont', badge: 'principale' }]);

  // Aucune validation côté interface : la sélection a quand même été élargie.
  assert.ok(registry.readConfig(user.id, 'free-mobile').lignes.includes('0612345678'));

  // Et le passage suivant ne la re-signale pas comme nouvelle.
  const second = reconcile('lignes', [
    ...LIGNES,
    { id: '0612345678', label: 'Camille Dupont', badge: 'principale' },
  ]);
  assert.deepEqual(second.added, []);
});

test('un connecteur avec découverte est reconnu comme tel, les autres non', () => {
  assert.equal(registry.hasDiscovery('free-mobile'), true);
  assert.equal(registry.hasDiscovery('free'), false);
  assert.equal(registry.discoveryField('free-mobile').key, 'lignes');
});

test('un manifeste qui promet une découverte sans discover() est refusé', () => {
  // La règle est vérifiée au chargement (registry.load) : ici on contrôle que
  // le manifeste de free-mobile la satisfait bien, et que le champ est
  // reconnu comme alimenté dynamiquement.
  const champs = schema.discoveredFields(registry.manifest('free-mobile'));
  assert.equal(champs.length, 1);
  assert.equal(champs[0].source, 'discover');
  assert.equal(champs[0].required, false, 'un multiselect ne peut pas être obligatoire');
  assert.equal(typeof registry.get('free-mobile').module.discover, 'function');
});

// ---------------------------------------------------------------------------
// §1.4 / §2 — le connecteur Free Mobile
// ---------------------------------------------------------------------------

test('« ?login= » n\'est PAS une page de connexion — seul le chemin compte', () => {
  const normales = [
    'https://mobile.free.fr/account/v2',
    'https://mobile.free.fr/account/v2?login=94994336',
    'https://mobile.free.fr/account/v2?login=94994336&onglet=factures',
    'https://mobile.free.fr/account/v2/factures?otp=1',
  ];
  for (const url of normales) {
    assert.equal(freeMobile.estPageAuthentification(url), false, `${url} est une URL normale`);
  }

  const expirees = [
    'https://mobile.free.fr/account/v2/login',
    'https://mobile.free.fr/account/v2/login/',
    'https://mobile.free.fr/account/v2/login?redirect=/factures',
    'https://mobile.free.fr/account/v2/otp',
    'https://mobile.free.fr/account/v2/otp/saisie',
  ];
  for (const url of expirees) {
    assert.equal(freeMobile.estPageAuthentification(url), true, `${url} signale une expiration`);
  }
});

test('les deux formats de date de la page « Mes factures » sont convertis', () => {
  // Cartes de l'historique.
  assert.equal(freeMobile.periodeDepuisTexte('Juillet 2026'), '2026-07');
  assert.equal(freeMobile.periodeDepuisTexte('Facture Décembre 2025 · 19,99 €'), '2025-12');
  assert.equal(freeMobile.periodeDepuisTexte('Aout 2026'), '2026-08', 'sans accent aussi');

  // Carte « Ma dernière facture » : le mois de FIN de période.
  assert.equal(
    freeMobile.periodeDepuisTexte('Facture mensuelle du 31/07/2026 au 31/08/2026'),
    '2026-08'
  );
  assert.equal(
    freeMobile.periodeDepuisTexte('Ma dernière facture Facture mensuelle du 1/1/2026 au 31/1/2026 Régularisée'),
    '2026-01',
    'un mois sur un seul chiffre reste valide'
  );

  // La plage l'emporte : sinon un « Mois AAAA » présent ailleurs sur la carte
  // ferait nommer la facture avec le mois de DÉBUT.
  assert.equal(
    freeMobile.periodeDepuisTexte('Août 2026 Facture mensuelle du 31/07/2026 au 31/08/2026'),
    '2026-08'
  );

  assert.equal(freeMobile.periodeDepuisTexte('aucune date ici'), null);
  assert.equal(freeMobile.nomFichier('2026-07', '2222222222'), '2026-07_2222222222.pdf');
  assert.equal(freeMobile.nomFichier(null, '2222222222'), 'inconnu_2222222222.pdf');
});

test('les numéros de ligne sont normalisés dans les deux sens', () => {
  assert.equal(freeMobile.numeroNormalise('07 49 00 00 00'), '0749000000');
  assert.equal(freeMobile.numeroNormalise('07.49.00.00.00'), '0749000000');
  assert.equal(freeMobile.numeroNormalise('Camille Dupont07 49 00 00 00'), '0749000000');
  assert.equal(freeMobile.numeroNormalise('123'), null);
  assert.equal(freeMobile.numeroEspace('0628000000'), '06 28 00 00 00');
});

/**
 * Le rang des lignes — faux en production, deux lots de suite.
 *
 * Le lot 7 lisait le titre de section par sa position globale dans le
 * document ; le lot 8 remontait les ancêtres jusqu'au premier titre frère. Les
 * deux ont affiché « principale » sur les QUATRE lignes du compte.
 *
 * La détection a été retirée, pas corrigée : ce n'est pas le motif qui était
 * mauvais, c'est l'idée de lire le rang sur un panneau qui porte une seconde
 * copie repliée de son menu et met ses titres en capitales par la feuille de
 * style. Ce qui est vrai et vérifiable, c'est l'ORDRE — la principale vient en
 * tête. Le socle en tire le badge, et un connecteur n'en pose plus aucun.
 */
test('quatre éléments découverts : un principal, trois secondaires', () => {
  const items = discovery.normalizeItems([
    { id: '0628000000', label: 'Camille Dupont' },
    { id: '0749000000', label: 'Camille Dupont' },
    { id: '0743000000', label: 'Camille Dupont' },
    { id: '0782518125', label: 'Samuel Huck' },
  ]);

  assert.deepEqual(
    items.map((i) => i.badge),
    ['principale', 'secondaire', 'secondaire', 'secondaire'],
    'exactement le cas qui affichait « principale » partout en production'
  );
  assert.equal(items.filter((i) => i.badge === 'principale').length, 1);
});

test('un badge remonté par un connecteur est ignoré : seul l\'index décide', () => {
  // Un connecteur qui se tromperait — ou une découverte enregistrée avant le
  // lot 9 — ne peut plus imposer son verdict au socle.
  const items = discovery.normalizeItems([
    { id: 'a', badge: 'principale' },
    { id: 'b', badge: 'principale' },
    { id: 'c', badge: 'résiliée' },
  ]);
  assert.deepEqual(items.map((i) => i.badge), ['principale', 'secondaire', 'secondaire']);
});

test('un doublon ne décale pas les rangs de ce qui suit', () => {
  // Le doublon est écarté AVANT l'attribution de l'index : sans ça, la
  // deuxième occurrence de « a » ferait glisser tout le reste d'un cran.
  const items = discovery.normalizeItems([
    { id: 'a' }, { id: 'a' }, { id: 'b' },
  ]);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(items.map((i) => i.badge), ['principale', 'secondaire']);
});

test('un compte mono-ligne : un seul élément, et il est principal', () => {
  const items = discovery.normalizeItems([{ id: '0628000000' }]);
  assert.deepEqual(items.map((i) => i.badge), ['principale']);
});

test('le rang survit à l\'enregistrement et à la fusion', () => {
  const connus = discovery.normalizeItems([
    { id: '0628000000', label: 'Camille Dupont', detail: '12 factures' },
    { id: '0749000000', label: 'Camille Dupont', detail: '3 factures' },
  ]);
  // Une récupération redécouvre sans recompter : la fusion garde les détails,
  // et le rang reste celui de l'ordre remonté.
  const fusion = discovery.merge(connus, [
    { id: '0628000000', label: 'Camille Dupont' },
    { id: '0749000000', label: 'Camille Dupont' },
  ]);
  assert.deepEqual(fusion.map((i) => i.badge), ['principale', 'secondaire']);
  assert.deepEqual(fusion.map((i) => i.detail), ['12 factures', '3 factures']);
});

test('free-mobile ne pose plus de badge, et ne coche que la première ligne', () => {
  const lignes = [
    { numero: '0628000000', nom: 'Camille Dupont' },
    { numero: '0749000000', nom: 'Camille Dupont' },
  ];
  const elements = lignes.map((l, i) => freeMobile.enElementDecouvert(l, 12, i));

  assert.deepEqual(elements.map((e) => e.badge), [undefined, undefined],
    'le rang n\'est plus l\'affaire du connecteur');
  assert.deepEqual(elements.map((e) => e.preselected), [true, false]);
  assert.deepEqual(elements.map((e) => e.detail), ['12 factures', '12 factures']);

  // Et une fois passés par le socle, les rangs sont posés.
  assert.deepEqual(
    discovery.normalizeItems(elements).map((i) => i.badge),
    ['principale', 'secondaire']
  );
});

test('le détail des factures est écrit au singulier comme au pluriel', () => {
  const ligne = { numero: '0612345678', nom: 'X' };
  assert.equal(freeMobile.enElementDecouvert(ligne, 3).detail, '3 factures');
  assert.equal(freeMobile.enElementDecouvert(ligne, 1).detail, '1 facture');

  // Sans comptage (une récupération redécouvre sans recompter), pas de détail
  // inventé — la fusion conserve celui de la dernière découverte.
  assert.equal(freeMobile.enElementDecouvert(ligne).detail, '');
});

test('rien n\'est relevé après une bascule non confirmée', async () => {
  const releves = [];
  const journal = [];

  const resultats = await freeMobile.parcourirLignes({
    lignes: [
      { numero: '0628000000', statut: 'principale' },
      { numero: '0749000000', statut: 'résiliée' },
    ],
    // La seconde bascule échoue : le titre n'affiche pas le bon numéro.
    basculer: async (ligne) =>
      ligne.numero === '0749000000'
        ? { ok: false, raison: 'le titre affiche 0628000000 au lieu de 0749000000' }
        : { ok: true },
    relever: async (ligne) => {
      releves.push(ligne.numero);
      return [{ remoteId: '1', reference: '1' }];
    },
    log: (m) => journal.push(m),
  });

  assert.deepEqual(releves, ['0628000000'], 'la ligne non confirmée ne doit pas être relevée');
  assert.equal(resultats[1].ok, false);
  assert.deepEqual(resultats[1].factures, []);
  assert.equal(
    journal.some((m) => m.includes('0749000000') && m.includes('aucune facture relevée')),
    true,
    'l\'abandon doit être journalisé'
  );
});

test('l\'attente du titre abandonne au bout du délai, sans boucler', async () => {
  let lectures = 0;
  const attente = await freeMobile.attendreValeur({
    lire: async () => { lectures++; return '0628000000'; },
    attendu: '0749000000',
    delaiMs: 30,
    pause: async () => {},
  });

  assert.equal(attente.ok, false);
  assert.equal(attente.vu, '0628000000', 'ce qui a été vu est remonté, pour le journal');
  assert.ok(lectures >= 1);

  const bonne = await freeMobile.attendreValeur({
    lire: async () => '0749000000',
    attendu: '0749000000',
    delaiMs: 1000,
    pause: async () => {},
  });
  assert.equal(bonne.ok, true);
});

test('une session expirée porte un message qui dit quoi faire', () => {
  const err = freeMobile.erreurSessionExpiree('redirection vers la page de connexion');
  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /connexion à Free Mobile a expiré/);
  // Le geste à faire est un bouton, et le message envoie là où on peut agir.
  assert.match(err.message, /Se connecter à Free Mobile/);
  assert.match(err.message, /Rouvrez-la/);
  // Lot 9 : le repli par fichier existe toujours, mais dans l'administration.
  // Le proposer ici reviendrait à envoyer l'utilisateur vers un terminal.
  assert.equal(err.message.includes('capture-session'), false, 'aucune commande');
});

test('une session inutilisable est refusée AVANT d\'ouvrir un navigateur', async () => {
  // Le connecteur n'a pas de mode simulé : si le contrôle de session ne se
  // faisait pas en amont, ce test lancerait un vrai Chromium.
  await assert.rejects(
    () => freeMobile.fetchInvoices({ session: '{"cookies":[]}' }, {}),
    (err) => err.sessionExpired === true && /connexion à Free Mobile a expiré/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('la fiche renvoyée au navigateur décrit la session sans la livrer', async (t) => {
  const user = await helpers.createUser({ username: 'routeur' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'routeur', 'MotDePasse1');

  await client.post('/api/connectors/free-mobile/install');
  const enregistre = await client.put('/api/connectors/free-mobile/config', {
    config: { session: sessionFactice() },
  });
  assert.equal(enregistre.status, 200);

  const liste = await client.get('/api/connectors');
  const fiche = liste.body.connectors.find((c) => c.id === 'free-mobile');

  assert.equal(fiche.discovery, true, 'le front doit savoir qu\'une étape de sélection suit');
  assert.ok(fiche.configSummary.sessions.session.expiresAt, 'l\'échéance doit être annoncée');
  assert.equal(
    JSON.stringify(liste.body).includes('abc'),
    false,
    'aucune valeur de cookie ne doit sortir du serveur'
  );

  // Le champ de session n'a pas de valeur dans la description du formulaire.
  const champ = fiche.fields.find((f) => f.key === 'session');
  assert.equal(champ.type, 'session');
  assert.equal('value' in champ, false);
  assert.equal(user.id > 0, true);

  // La fixture qui nourrit test/render.test.js doit avoir la forme de cette
  // réponse : sans ce rapprochement, l'écran pourrait « passer » les tests de
  // rendu tout en cassant en production.
  const { FIXTURES } = require('./fixtures-front');
  const modele = FIXTURES['/connectors'].connectors.find((c) => c.id === 'free-mobile');
  const manquants = champsManquants(modele, fiche);
  assert.deepEqual(manquants, [], 'champs de la fixture absents de la réponse réelle');
});

/** Compare récursivement les CLÉS (pas les valeurs) de deux objets. */
function champsManquants(attendu, reel, chemin = '') {
  if (attendu === null || typeof attendu !== 'object') return [];
  if (Array.isArray(attendu)) {
    if (!Array.isArray(reel)) return [`${chemin} devrait être un tableau`];
    return attendu.length && reel.length ? champsManquants(attendu[0], reel[0], `${chemin}[]`) : [];
  }
  const erreurs = [];
  for (const [cle, valeur] of Object.entries(attendu)) {
    const sousChemin = chemin ? `${chemin}.${cle}` : cle;
    if (!(cle in (reel || {}))) {
      erreurs.push(sousChemin);
      continue;
    }
    if (reel[cle] === null) continue;
    erreurs.push(...champsManquants(valeur, reel[cle], sousChemin));
  }
  return erreurs;
}

test('un fichier de session illisible est refusé par la route, en 400', async (t) => {
  await helpers.createUser({ username: 'brouillon' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'brouillon', 'MotDePasse1');

  await client.post('/api/connectors/free-mobile/install');
  const refus = await client.put('/api/connectors/free-mobile/config', {
    config: { session: 'ceci n\'est pas du json' },
  });

  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /JSON valide/i);
});

test('la découverte n\'est proposée que par les connecteurs qui l\'implémentent', async (t) => {
  await helpers.createUser({ username: 'curieux' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'curieux', 'MotDePasse1');

  await client.post('/api/connectors/free/install');
  const refus = await client.post('/api/connectors/free/discover');
  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /pas d'étape de découverte/i);

  // Sur un connecteur qui l'implémente, l'échec remonte tel quel plutôt que
  // de faire tomber la requête en 500 : ici, le scraping est coupé.
  await client.post('/api/connectors/free-mobile/install');
  await client.put('/api/connectors/free-mobile/config', { config: { session: sessionFactice() } });
  const echec = await client.post('/api/connectors/free-mobile/discover');
  assert.equal(echec.status, 502);
  assert.match(echec.body.error, /scraping est désactivé/i);
});

/**
 * Le verrou de recherche, vu depuis la route.
 *
 * `test/inflight.test.js` couvre le verrou lui-même ; ici on vérifie qu'il est
 * bien BRANCHÉ — c'est-à-dire qu'une seconde requête HTTP, celle d'un
 * deuxième onglet ou d'un utilisateur qui reclique, n'ouvre pas un second
 * navigateur sur le même compte.
 */
test('deux recherches simultanées : la seconde est refusée, et rien n\'est relancé', async (t) => {
  await helpers.createUser({ username: 'impatient' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'impatient', 'MotDePasse1');

  await client.post('/api/connectors/free-mobile/install');
  await client.put('/api/connectors/free-mobile/config', { config: { session: sessionFactice() } });

  // Une recherche qu'on règle à la main, pour tenir le verrou pendant qu'une
  // seconde requête frappe à la porte.
  const vraie = registry.discoverForUser;
  let appels = 0;
  let liberer;
  const attente = new Promise((resoudre) => {
    liberer = resoudre;
  });
  registry.discoverForUser = async () => {
    appels++;
    await attente;
    return {
      field: registry.discoveryField('free-mobile'),
      items: LIGNES,
      selection: ['0628000000'],
      added: [],
      missing: [],
    };
  };
  t.after(() => {
    registry.discoverForUser = vraie;
  });

  const premiere = client.post('/api/connectors/free-mobile/discover');
  // La seconde part pendant que la première tourne encore.
  const seconde = await client.post('/api/connectors/free-mobile/discover');

  assert.equal(seconde.status, 409, 'un refus, pas une panne ni une seconde recherche');
  assert.equal(seconde.body.alreadyRunning, true);
  assert.match(seconde.body.error, /déjà en cours/i);
  assert.match(seconde.body.error, /Free Mobile/, 'le refus nomme le service, pas un identifiant');

  liberer();
  const reponse = await premiere;
  assert.equal(reponse.status, 200);
  assert.equal(appels, 1, 'un seul navigateur a été ouvert');

  // Le verrou est rendu : la recherche suivante passe.
  const apres = await client.post('/api/connectors/free-mobile/discover');
  assert.equal(apres.status, 200);
  assert.equal(appels, 2);
});

test('la recherche annonce le nom de ce qu\'elle a trouvé, pour que l\'attente le dise', async (t) => {
  await helpers.createUser({ username: 'nommeur' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'nommeur', 'MotDePasse1');

  await client.post('/api/connectors/free-mobile/install');
  await client.put('/api/connectors/free-mobile/config', { config: { session: sessionFactice() } });

  const vraie = registry.discoverForUser;
  registry.discoverForUser = async () => ({
    field: registry.discoveryField('free-mobile'),
    items: LIGNES,
    selection: [],
    added: [],
    missing: [],
  });
  t.after(() => {
    registry.discoverForUser = vraie;
  });

  const reponse = await client.post('/api/connectors/free-mobile/discover');
  assert.equal(reponse.status, 200);
  // « Recherche de vos lignes… » plutôt que « Recherche en cours… » : le mot
  // vient du manifeste, il ne se devine pas.
  assert.equal(reponse.body.field.unit, 'ligne');
  assert.equal(reponse.body.field.unitFeminine, true);
});

// ---------------------------------------------------------------------------
// Lot 9, §4 — le dépôt d'une connexion passe dans l'administration
//
// Le geste n'a pas disparu du produit : il sauve les cas où le navigateur
// distant ne peut pas s'ouvrir. Mais c'est un outil d'administrateur, et il
// vit désormais avec les outils d'administrateur — plus dans la fiche d'un
// utilisateur qui n'a jamais ouvert un terminal.
// ---------------------------------------------------------------------------

test('un administrateur voit qui a installé le connecteur, et l\'état de leur connexion', async (t) => {
  const patron = await helpers.createUser({ username: 'patron-session', role: 'admin' });
  const simple = await helpers.createUser({ username: 'depanne' });
  registry.install(simple.id, 'free-mobile');
  registry.saveConfig(simple.id, 'free-mobile', { session: sessionFactice() });

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patron-session', 'MotDePasse1');

  const reponse = await client.get('/api/admin/connectors/free-mobile/sessions');
  assert.equal(reponse.status, 200);
  assert.equal(reponse.body.field.key, 'session');

  const compte = reponse.body.accounts.find((a) => a.username === 'depanne');
  assert.ok(compte, 'le compte qui a installé le connecteur doit être proposé');
  assert.ok(compte.session.expiresAt, 'son échéance est annoncée');
  // Le contenu, lui, ne sort jamais — pas plus ici qu'ailleurs.
  assert.equal(JSON.stringify(reponse.body).includes('abc'), false);

  // Un connecteur qui se connecte par mot de passe n'a rien à dépanner.
  const sansSession = await client.get('/api/admin/connectors/ovh/sessions');
  assert.equal(sansSession.status, 400);
  assert.match(sansSession.body.error, /rien à déposer/);
  assert.equal(patron.id > 0, true);
});

test('un dépôt administrateur passe par les mêmes contrôles, et se trace', async (t) => {
  await helpers.createUser({ username: 'patron-depot', role: 'admin' });
  const simple = await helpers.createUser({ username: 'depanne-2' });
  registry.install(simple.id, 'free-mobile');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patron-depot', 'MotDePasse1');

  // Un contenu inexploitable est refusé exactement comme côté utilisateur.
  const refus = await client.put(`/api/admin/connectors/free-mobile/sessions/${simple.id}`, {
    value: '{"cookies":[]}',
  });
  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /vide/i);

  const depot = await client.put(`/api/admin/connectors/free-mobile/sessions/${simple.id}`, {
    value: sessionFactice(),
  });
  assert.equal(depot.status, 200);
  assert.ok(depot.body.session.expiresAt, 'l\'échéance revient, jamais le contenu');

  // Et le compte la retrouve sur sa propre fiche, chiffrée comme la sienne.
  const resume = registry.configSummary(simple.id, 'free-mobile');
  assert.ok(resume.sessions.session.savedAt);
  assert.equal(
    helpers.db.get().prepare('SELECT config_encrypted FROM connector_installs WHERE user_id = ?')
      .get(simple.id).config_encrypted.includes('abc'),
    false,
    'la connexion est chiffrée au repos, comme celle de l\'utilisateur'
  );

  // Un compte qui n'a pas installé le connecteur n'est pas une cible.
  const autre = await helpers.createUser({ username: 'sans-connecteur' });
  const perdu = await client.put(`/api/admin/connectors/free-mobile/sessions/${autre.id}`, {
    value: sessionFactice(),
  });
  assert.equal(perdu.status, 404);
});

test('un compte ordinaire ne dépose de connexion pour personne', async (t) => {
  const simple = await helpers.createUser({ username: 'curieux-session' });
  registry.install(simple.id, 'free-mobile');

  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'curieux-session', 'MotDePasse1');

  assert.equal((await client.get('/api/admin/connectors/free-mobile/sessions')).status, 403);
  assert.equal(
    (await client.put(`/api/admin/connectors/free-mobile/sessions/${simple.id}`, {
      value: sessionFactice(),
    })).status,
    403
  );
});
