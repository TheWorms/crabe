'use strict';

/**
 * Lot 107, R2 — l'API de l'explorateur (`GET /api/documents/explorateur`).
 *
 * Une page de quarante documents au plus, du compte connecté seulement, lue
 * dans la base : pagination, tris stables, filtres, recherche PARAMÉTRÉE et
 * bornée, valeurs hors liste refusées, isolement entre comptes même avec un
 * paramètre forgé, aucun document présenté sur une destination où la base ne
 * dit pas qu'il a été déposé, et aucune lecture d'une destination.
 *
 * Données inventées : comptes nommés par leur rôle, numéros `06000000xx`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = require('./helpers');
const explorateur = require('../server/explorateur');
const preferences = require('../server/preferences');
const { LOCAL, peupler } = require('./lot107-commun');

const RACINE = process.env.CRABE_LOCAL_PATH;
let titulaire;
let voisine;
let vide;
let cloud;
let clientTitulaire;
let clientVoisine;
let idsTitulaire;
let idsVoisine;
let idsSerie;

const ins = (user, service, nom, { compte = 'defaut', taille = 1000, emission = '2026-01-01', recup = '2026-01-02 00:00:00', depots = { [LOCAL]: { state: 'ok', ok: true } } } = {}) =>
  Number(helpers.db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, service, nom, compte, taille, emission, recup, JSON.stringify(depots)).lastInsertRowid);

test.before(async () => {
  await helpers.setup();
  fs.mkdirSync(RACINE, { recursive: true });
  titulaire = await helpers.createUser({ username: 'titulaire' });
  voisine = await helpers.createUser({ username: 'voisine' });
  vide = await helpers.createUser({ username: 'vide' });
  cloud = helpers.creerCloud({ rcloneConfig: 'type = pcloud' });

  // Le jeu commun (neuf documents, stockage local seul), plus une série de
  // 95 documents « ovh » à date ÉGALE — de quoi éprouver pagination et
  // stabilité des tris — et des dépôts dans tous les états.
  idsTitulaire = peupler(titulaire, { fichiers: false });
  idsSerie = [];
  for (let i = 0; i < 95; i += 1) {
    idsSerie.push(ins(titulaire, 'scaleway', `serie_${String(i % 7)}.pdf`.replace('.pdf', `_${i}.pdf`), {
      taille: 1000 + (i % 3), emission: '2025-03-01', recup: '2025-03-02 00:00:00',
    }));
  }
  ins(titulaire, 'free', 'Échéance_essai.pdf', { emission: '2024-02-01', recup: '2024-02-02 00:00:00' });
  ins(titulaire, 'free', 'facture 9.pdf', { emission: '2023-01-01', recup: '2023-01-02 00:00:00' });
  ins(titulaire, 'free', 'facture 10.pdf', { emission: '2023-01-01', recup: '2023-01-02 00:00:00' });
  ins(titulaire, 'free', 'pourcent_100%_essai.pdf', { emission: '2023-01-01', recup: '2023-01-02 00:00:00' });
  ins(titulaire, 'free', 'taille_inconnue.pdf', { taille: 0, emission: '2023-01-01', recup: '2023-01-02 00:00:00' });
  // Dépôts : sur le cloud seulement, en échec, en attente, sans clé, ancien format.
  ins(titulaire, 'hetzner', 'cloud_seul.pdf', { depots: { [cloud]: { state: 'ok', ok: true } } });
  ins(titulaire, 'hetzner', 'local_en_echec.pdf', { depots: { [LOCAL]: { state: 'error', ok: false, message: 'refusé' } } });
  ins(titulaire, 'hetzner', 'local_en_attente.pdf', { depots: { [LOCAL]: { state: 'pending', ok: false } } });
  ins(titulaire, 'hetzner', 'sans_depot.pdf', { depots: {} });
  ins(titulaire, 'hetzner', 'ancien_reussi.pdf', { depots: { [LOCAL]: { state: 'unknown', ok: true } } });
  ins(titulaire, 'hetzner', 'ancien_douteux.pdf', { depots: { [LOCAL]: { state: 'unknown', ok: false } } });
  ins(titulaire, 'hetzner', 'ancien_faux.pdf', { depots: { [LOCAL]: false } });

  // La voisine : ses propres documents, dont un service que la titulaire n'a pas.
  idsVoisine = [
    ins(voisine, 'gandi', 'voisine_secret_gandi.pdf', { compte: 'org-voisine-0000000001' }),
    ins(voisine, 'gandi', 'voisine_secret_gandi_2.pdf', { compte: 'org-voisine-0000000002' }),
    ins(voisine, 'free', 'voisine_facture_free.pdf'),
  ];

  clientTitulaire = await helpers.startServer();
  await helpers.login(clientTitulaire, 'titulaire', 'MotDePasse1');
  clientVoisine = await helpers.startServer();
  await helpers.login(clientVoisine, 'voisine', 'MotDePasse1');
});

test.after(async () => {
  await clientTitulaire?.close();
  await clientVoisine?.close();
  helpers.teardown();
});

const lire = async (client, params = '') => {
  const r = await client.get(`/api/documents/explorateur${params}`);
  return r;
};

/** Toutes les pages d'une demande, en suivant « suite ». */
async function toutesLesPages(client, params) {
  const pages = [];
  for (let page = 1; page < 50; page += 1) {
    const r = await lire(client, `?${params}${params ? '&' : ''}page=${page}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.documents.length <= 40, 'jamais plus de 40 lignes');
    pages.push(r.body);
    if (!r.body.suite) break;
  }
  return pages;
}

test('R2 — une page de 40 au plus, « suite » tant qu\'il en reste, le compte des correspondants', async () => {
  const p1 = await lire(clientTitulaire, '?service=scaleway');
  assert.equal(p1.status, 200);
  assert.equal(p1.body.parPage, 40);
  assert.equal(p1.body.documents.length, 40);
  assert.equal(p1.body.suite, true);
  assert.equal(p1.body.correspondants, 95);
  const pages = await toutesLesPages(clientTitulaire, 'service=scaleway');
  assert.deepEqual(pages.map((p) => p.documents.length), [40, 40, 15]);
  assert.equal(pages.at(-1).suite, false);
  const ids = pages.flatMap((p) => p.documents.map((d) => d.id));
  assert.equal(new Set(ids).size, 95, 'aucun doublon, aucun oubli d\'une page à l\'autre');
  assert.deepEqual([...ids].sort((a, b) => a - b), [...idsSerie].sort((a, b) => a - b));
  // Une page au-delà de la fin : vide, pas une erreur.
  const loin = await lire(clientTitulaire, '?service=scaleway&page=9');
  assert.equal(loin.status, 200);
  assert.deepEqual(loin.body.documents, []);
  assert.equal(loin.body.suite, false);
});

for (const triDemande of ['recents', 'nom', 'periode', 'taille']) {
  test(`R4 — tri « ${triDemande} » stable : à égalité, l'identifiant départage, et les pages se suivent sans trou`, async () => {
    const a = (await toutesLesPages(clientTitulaire, `service=scaleway&tri=${triDemande}`)).flatMap((p) => p.documents);
    const b = (await toutesLesPages(clientTitulaire, `service=scaleway&tri=${triDemande}`)).flatMap((p) => p.documents);
    assert.deepEqual(a.map((d) => d.id), b.map((d) => d.id), 'deux lectures, le même ordre');
    assert.equal(new Set(a.map((d) => d.id)).size, 95);
    for (let i = 1; i < a.length; i += 1) {
      const [x, y] = [a[i - 1], a[i]];
      const egaux = {
        recents: x.recupereLe === y.recupereLe,
        nom: explorateur.cleDeNom(x.nom) === explorateur.cleDeNom(y.nom),
        periode: x.periode === y.periode,
        taille: x.taille === y.taille,
      }[triDemande];
      if (egaux) assert.ok(triDemande === 'nom' ? x.id < y.id : x.id > y.id, `égalité départagée par l'identifiant (${x.id}, ${y.id})`);
    }
  });
}

test('R4 — les quatre ordres : récents d\'abord, nom (accents et nombres), période la plus récente, plus lourd d\'abord', async () => {
  const lister = async (q) => (await lire(clientTitulaire, q)).body.documents;
  const recents = await lister('?tri=recents');
  for (let i = 1; i < recents.length; i += 1) assert.ok(recents[i - 1].recupereLe >= recents[i].recupereLe);

  const noms = (await lister('?service=free&tri=nom')).map((d) => d.nom);
  assert.ok(noms.indexOf('facture 9.pdf') < noms.indexOf('facture 10.pdf'), `9 avant 10 : ${noms.join(', ')}`);
  assert.ok(noms.indexOf('Échéance_essai.pdf') < noms.indexOf('facture 9.pdf'), 'É se range avec E');

  const periodes = (await lister('?tri=periode')).map((d) => d.periode);
  assert.deepEqual(periodes, [...periodes].sort().reverse());

  const tailles = (await lister('?tri=taille')).map((d) => d.taille ?? 0);
  assert.deepEqual(tailles, [...tailles].sort((x, y) => y - x));
});

test('R2 — filtres par service et par année ; compteurs de l\'arbre sur les documents du compte', async () => {
  const r = await lire(clientTitulaire, '?service=free-mobile&annee=2026');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.documents.map((d) => d.nom).sort(), ['2026-09_ligne_essai_a.pdf', '2026-09_ligne_essai_b.pdf']);
  assert.deepEqual(r.body.filtre, { service: 'free-mobile', annee: '2026', q: '', tri: 'recents' });

  const arbre = new Map(r.body.services.map((s) => [s.id, s]));
  assert.equal(arbre.get('free-mobile').nombre, 3);
  assert.deepEqual(arbre.get('free-mobile').annees, [{ annee: '2026', nombre: 2 }, { annee: '2025', nombre: 1 }]);
  assert.equal(arbre.get('scaleway').nombre, 95);
  // Les services sans document sur cet espace n'y sont pas ; la voisine non plus.
  assert.equal(arbre.has('gandi'), false);
  assert.equal(r.body.total, [...arbre.values()].reduce((n, s) => n + s.nombre, 0));
  // Rangés par nom affiché, avec leur pastille.
  assert.deepEqual(r.body.services.map((s) => s.nom), [...r.body.services.map((s) => s.nom)].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })));
  assert.ok(arbre.get('free').couleur && arbre.get('free').lettres);
});

test('R2 — la recherche : nom du fichier (accents pliés), nom du service, libellé du compte — jamais l\'identifiant brut', async () => {
  const noms = async (q) => (await lire(clientTitulaire, `?q=${encodeURIComponent(q)}`)).body.documents.map((d) => d.nom).sort();
  assert.deepEqual(await noms('echeance'), ['Échéance_essai.pdf']);
  assert.deepEqual(await noms('ÉCHÉANCE'), ['Échéance_essai.pdf']);
  // Le nom du service : « Hetzner » trouve aussi les documents qui ne le nomment pas.
  assert.ok((await noms('hetzner')).includes('ancien_reussi.pdf'));
  // Le libellé d'un compte (service à deux comptes) : « Compte …0002 ».
  assert.deepEqual(await noms('…0002'), ['2026-09_ligne_essai_b.pdf']);
  // L'identifiant brut n'est pas cherchable (il n'est pas à l'écran).
  assert.deepEqual(await noms('0600000002'), []);
  // Une recherche vide remet tout.
  const tout = await lire(clientTitulaire, '?q=');
  assert.equal(tout.body.filtre.q, '');
  assert.equal(tout.body.correspondants, tout.body.total);
});

test('R2 — la recherche est PARAMÉTRÉE : guillemets, jokers et morceaux de SQL sont du texte', async () => {
  for (const q of ["%' OR 1=1 --", "x') OR user_id <> 0 --", "' UNION SELECT filename FROM invoices --", '"; DROP TABLE invoices; --']) {
    const r = await lire(clientTitulaire, `?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, q);
    assert.deepEqual(r.body.documents, [], `« ${q} » ne correspond à rien`);
  }
  // `%` et `_` ne sont pas des jokers.
  assert.deepEqual((await lire(clientTitulaire, '?q=%25')).body.documents.map((d) => d.nom), ['pourcent_100%_essai.pdf']);
  const souligne = (await lire(clientTitulaire, '?q=_&service=hetzner')).body.documents.map((d) => d.nom);
  assert.ok(souligne.every((n) => n.includes('_')));
  assert.equal(helpers.db.get().prepare('SELECT COUNT(*) FROM invoices').pluck().get() > 100, true, 'la table est intacte');
});

test('R2 — bornes : 100 caractères de recherche au plus', async () => {
  assert.equal((await lire(clientTitulaire, `?q=${'a'.repeat(100)}`)).status, 200);
  const trop = await lire(clientTitulaire, `?q=${'a'.repeat(101)}`);
  assert.equal(trop.status, 400);
  assert.match(trop.body.error, /100 caractères au plus/);
});

test('R2 — valeurs hors liste : refusées en 400, avec leur raison', async () => {
  for (const [params, motif] of [
    ['?tri=bidon', /Tri inconnu/], ['?tri=__proto__', /Tri inconnu/], ['?tri=constructor', /Tri inconnu/],
    ['?tri=nom%20DESC', /Tri inconnu/], ['?tri=nom&tri=taille', /plusieurs fois/],
    ['?annee=99', /Année inconnue/], ['?annee=2026x', /Année inconnue/], ['?annee=1066', /Année inconnue/],
    ['?service=..%2Fx', /Service inconnu/], ['?service=FREE', /Service inconnu/], ['?service=service-de-personne', /Service inconnu/],
    ['?page=0', /Page inconnue/], ['?page=-1', /Page inconnue/], ['?page=abc', /Page inconnue/], ['?page=10001', /Page inconnue/],
    ['?espace=nulle-part', /Espace de stockage inconnu/], [`?espace[]=${LOCAL}`, /plusieurs fois/],
  ]) {
    const r = await lire(clientTitulaire, params);
    assert.equal(r.status, 400, `${params} : ${r.status}`);
    assert.match(r.body.error, motif, params);
  }
});

test('R2 — isolement : un compte ne voit jamais les documents d\'un autre, même avec un paramètre forgé', async () => {
  const brut = async (client, params) => JSON.stringify((await lire(client, params)).body);
  // La titulaire forge le service de la voisine, ses comptes, ses recherches.
  for (const params of [
    '', '?service=gandi', '?service=gandi&annee=2026', '?q=voisine', '?q=secret', '?q=gandi',
    '?account_id=org-voisine-0000000001', `?user_id=${voisine.id}`, `?user=${voisine.id}`, '?compte=org-voisine-0000000001',
    `?espace=${cloud}`, `?espace=${cloud}&q=voisine`,
  ]) {
    const corps = await brut(clientTitulaire, params);
    assert.equal(/voisine/i.test(corps.replace(/"q":"[^"]*"/, '')), false, `${params} : ${corps.slice(0, 300)}`);
    assert.equal(corps.includes('org-voisine'), false, params);
  }
  const forge = await lire(clientTitulaire, '?service=gandi');
  assert.equal(forge.status, 200, 'un service du catalogue : liste vide, pas d\'indice');
  assert.deepEqual(forge.body.documents, []);

  // Et dans l'autre sens : la voisine ne voit que ses trois documents.
  const v = await lire(clientVoisine, '');
  assert.deepEqual(v.body.documents.map((d) => d.id).sort((a, b) => a - b), [...idsVoisine].sort((a, b) => a - b));
  assert.equal(v.body.total, 3);
  for (const id of idsTitulaire) assert.equal(v.body.documents.some((d) => d.id === id), false);

  // Sans session : refusé.
  const anonyme = await helpers.startServer();
  try {
    const r = await anonyme.get('/api/documents/explorateur');
    assert.equal(r.status, 401);
  } finally {
    await anonyme.close();
  }
});

test('R2 — téléchargement : la garde de toujours (un document d\'un autre compte : 404)', async () => {
  for (const id of idsVoisine) {
    const r = await clientTitulaire.get(`/api/documents/${LOCAL}/${id}/file`);
    assert.equal(r.status, 404);
    assert.equal(JSON.stringify(r.body).includes('voisine'), false);
  }
});

test('R3 — présent sur un espace seulement si la base y dit un dépôt réussi', async () => {
  const local = (await toutesLesPages(clientTitulaire, 'service=hetzner')).flatMap((p) => p.documents).map((d) => d.nom).sort();
  assert.deepEqual(local, ['Hetzner_essai_2026-05.pdf', 'ancien_reussi.pdf']);
  const surLeCloud = (await lire(clientTitulaire, `?espace=${cloud}`)).body;
  assert.equal(surLeCloud.espace.id, cloud);
  assert.deepEqual(surLeCloud.documents.map((d) => d.nom), ['cloud_seul.pdf']);
  assert.deepEqual(surLeCloud.services.map((s) => s.id), ['hetzner']);
  // Les fonctions elles-mêmes.
  assert.equal(explorateur.estDepose(JSON.stringify({ [LOCAL]: { state: 'ok' } }), LOCAL), true);
  assert.equal(explorateur.estDepose(JSON.stringify({ [LOCAL]: { state: 'unknown', ok: false } }), LOCAL), false);
  assert.equal(explorateur.estDepose(JSON.stringify({ [LOCAL]: false }), LOCAL), false);
  assert.equal(explorateur.estDepose(JSON.stringify({ [LOCAL]: { state: 'ok' } }), cloud), false, 'une clé absente : absent');
  assert.equal(explorateur.estDepose('illisible', LOCAL), false);
});

test('R3 — les espaces : ceux du compte ; un cloud refusé par le compte n\'est pas un onglet', async () => {
  const avant = (await lire(clientTitulaire, '')).body;
  assert.deepEqual(avant.espaces.map((e) => e.id), [LOCAL, cloud]);
  assert.equal(avant.espace.id, LOCAL, 'le stockage local par défaut');
  preferences.set(titulaire.id, 'destinations.desactivees', [cloud]);
  try {
    const apres = (await lire(clientTitulaire, '')).body;
    assert.deepEqual(apres.espaces.map((e) => e.id), [LOCAL]);
    assert.equal((await lire(clientTitulaire, `?espace=${cloud}`)).status, 400);
  } finally {
    preferences.set(titulaire.id, 'destinations.desactivees', []);
  }
});

test('R2 — les champs : rien d\'inventé, aucun identifiant de compte entier, la taille nulle n\'est pas une taille', async () => {
  const r = await lire(clientTitulaire, '?service=free&tri=nom');
  const inconnue = r.body.documents.find((d) => d.nom === 'taille_inconnue.pdf');
  assert.equal(inconnue.taille, null);
  assert.deepEqual(Object.keys(inconnue).sort(), ['compte', 'id', 'nom', 'periode', 'recupereLe', 'service', 'taille']);
  // Un seul compte chez Free : pas de libellé.
  assert.ok(r.body.documents.every((d) => d.compte === null));
  // Deux comptes chez Free Mobile : un libellé, jamais le numéro entier.
  const fm = await lire(clientTitulaire, '?service=free-mobile');
  assert.deepEqual(fm.body.documents.map((d) => d.compte).sort(), ['Compte …0001', 'Compte …0001', 'Compte …0002']);
  assert.equal(JSON.stringify(fm.body).includes('0600000001'), false);
  // Le dossier est celui du service, depuis le dossier de crabe (compte ordinaire).
  assert.deepEqual(fm.body.services.find((s) => s.id === 'free-mobile').dossier, { chemin: 'titulaire/Free Mobile', depuisLaRacine: false, adresse: null });
});

test('R2 — un compte sans document, une installation sans espace : des réponses dites, jamais une erreur', async () => {
  const c = await helpers.startServer();
  try {
    await helpers.login(c, 'vide', 'MotDePasse1');
    const r = await c.get('/api/documents/explorateur');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.total, r.body.documents.length, r.body.services.length], [0, 0, 0]);
  } finally {
    await c.close();
  }
  void vide;

  // Aucun espace activé (le stockage local éteint, le cloud aussi) : la raison.
  const eteindre = helpers.db.get().prepare('UPDATE destinations_config SET enabled = ? WHERE dest_id = ?');
  eteindre.run(0, LOCAL);
  eteindre.run(0, cloud);
  try {
    const r = await lire(clientTitulaire, '');
    assert.equal(r.status, 200);
    assert.equal(r.body.espace, null);
    assert.equal(r.body.raison, 'Aucun espace de stockage n\'est activé par l\'administrateur.');
    assert.deepEqual(r.body.documents, []);
  } finally {
    eteindre.run(1, LOCAL);
    eteindre.run(1, cloud);
  }
  assert.equal((await lire(clientTitulaire, '')).body.espace.id, LOCAL);
});

test('§1.9 — l\'explorateur ne lit aucune destination : ni fichier du stockage local, ni rclone', async () => {
  const destinations = require('../server/destinations');
  const rclone = require('../server/destinations/rclone');
  const touches = [];
  const espions = [];
  const espionner = (objet, nom, etiquette) => {
    const original = objet[nom];
    if (typeof original !== 'function') return;
    objet[nom] = function espion(...args) {
      const premier = String(args[0] ?? '');
      if (!etiquette.startsWith('fs.') || premier.startsWith(RACINE)) touches.push(`${etiquette}(${premier})`);
      return original.apply(this, args);
    };
    espions.push(() => { objet[nom] = original; });
  };
  for (const nom of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'accessSync', 'openSync']) espionner(fs, nom, `fs.${nom}`);
  for (const nom of Object.keys(rclone)) espionner(rclone, nom, `rclone.${nom}`);
  for (const nom of ['fetchInvoice', 'store', 'testDestination']) espionner(destinations, nom, `destinations.${nom}`);
  try {
    for (const params of ['', `?espace=${cloud}`, '?q=essai&tri=nom', '?service=free-mobile&annee=2026', '?page=2']) {
      const r = await lire(clientTitulaire, params);
      assert.equal(r.status, 200);
    }
  } finally {
    for (const rendre of espions) rendre();
  }
  assert.deepEqual(touches, []);
});
