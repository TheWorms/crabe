'use strict';

/**
 * Les vrais logos des services (server/connectors/logos.js).
 *
 * Trois choses doivent tenir, et elles sont toutes défensives :
 *
 *   1. **le logo vient du site du fournisseur**, jamais d'un tiers. Demander à
 *      un agrégateur le logo d'EDF, c'est lui annoncer que l'utilisateur a un
 *      compte EDF — et, service après service, lui livrer la maison. Une
 *      redirection ne doit pas non plus servir de porte dérobée ;
 *   2. **au moindre doute, pas d'image.** Une bannière, un fichier de trois
 *      mégaoctets, un HTML servi à la place d'un PNG : chacun doit faire
 *      passer au candidat suivant, pas atterrir dans une pastille ;
 *   3. **une image envoyée à la main n'est jamais écrasée.** C'est le dernier
 *      mot de quelqu'un qui a regardé le résultat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const logos = require('../server/connectors/logos');

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// Images de laboratoire
// ---------------------------------------------------------------------------

/** Un PNG dont l'en-tête déclare les dimensions demandées. */
function png(largeur = 180, hauteur = 180, remplissage = 200) {
  const tete = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tete, 0);
  tete.writeUInt32BE(13, 8);
  tete.write('IHDR', 12);
  tete.writeUInt32BE(largeur, 16);
  tete.writeUInt32BE(hauteur, 20);
  return Buffer.concat([tete, Buffer.alloc(remplissage)]);
}

/** Un JPEG avec un cadre SOF0 aux dimensions demandées. */
function jpeg(largeur = 200, hauteur = 200) {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2); // longueur du segment
  sof.writeUInt8(8, 4); // précision
  sof.writeUInt16BE(hauteur, 5);
  sof.writeUInt16BE(largeur, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), sof, Buffer.alloc(64)]);
}

/** Un ICO à une entrée. */
function ico(cote = 32) {
  const buffer = Buffer.alloc(6 + 16 + 64);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt8(cote === 256 ? 0 : cote, 6);
  buffer.writeUInt8(cote === 256 ? 0 : cote, 7);
  return buffer;
}

/** Un WebP « lossy » (VP8) aux dimensions demandées. */
function webp(largeur = 128, hauteur = 128) {
  const buffer = Buffer.alloc(64);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(56, 4);
  buffer.write('WEBP', 8);
  buffer.write('VP8 ', 12);
  buffer.writeUInt16LE(largeur, 26);
  buffer.writeUInt16LE(hauteur, 28);
  return buffer;
}

const svg = (attributs = 'width="64" height="64"') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attributs}><circle r="10"/></svg>`);

// ---------------------------------------------------------------------------
// Reconnaissance et contrôles
// ---------------------------------------------------------------------------

test('les cinq formats acceptés sont reconnus, avec leurs dimensions', () => {
  assert.deepEqual(logos.reconnaitreImage(png(180, 180)), {
    format: 'png', width: 180, height: 180,
  });
  assert.deepEqual(logos.reconnaitreImage(jpeg(200, 150)), {
    format: 'jpeg', width: 200, height: 150,
  });
  assert.deepEqual(logos.reconnaitreImage(ico(64)), { format: 'ico', width: 64, height: 64 });
  assert.deepEqual(logos.reconnaitreImage(webp(128, 96)), {
    format: 'webp', width: 128, height: 96,
  });
  assert.deepEqual(logos.reconnaitreImage(svg()), { format: 'svg', width: 64, height: 64 });
});

test('un SVG sans dimensions reste accepté : il se met à l\'échelle', () => {
  const sansTaille = logos.analyserImage(svg('viewBox="0 0 24 24"'));
  assert.equal(sansTaille.ok, true);
  assert.deepEqual([sansTaille.width, sansTaille.height], [24, 24], 'lues dans le viewBox');

  const rien = logos.analyserImage(svg(''));
  assert.equal(rien.ok, true, 'un logo vectoriel sans dimensions n\'est pas un problème');
  assert.equal(rien.ext, 'svg');
});

test('ce qui n\'est pas une image est refusé, sans deviner', () => {
  // Le cas le plus fréquent : une page d'erreur HTML servie à la place du PNG.
  const html = Buffer.from('<!DOCTYPE html><html><body>404</body></html>');
  assert.equal(logos.analyserImage(html).ok, false);
  assert.match(logos.analyserImage(html).raison, /pas une image/);

  assert.equal(logos.analyserImage(Buffer.alloc(0)).ok, false);
  assert.match(logos.analyserImage(Buffer.alloc(0)).raison, /vide/);

  // Un GIF est bien une image, mais pas un format accepté.
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
  assert.equal(logos.analyserImage(gif).ok, false);
});

test('trop lourd, trop petit, trop grand : trois refus qui disent la mesure', () => {
  const lourd = logos.analyserImage(png(180, 180, logos.TAILLE_MAX + 10));
  assert.equal(lourd.ok, false);
  assert.match(lourd.raison, /trop lourd/);
  assert.match(lourd.raison, /Ko/);

  const minuscule = logos.analyserImage(png(8, 8));
  assert.equal(minuscule.ok, false);
  assert.match(minuscule.raison, /trop petite \(8×8\)/);

  const enorme = logos.analyserImage(png(4000, 4000));
  assert.equal(enorme.ok, false);
  assert.match(enorme.raison, /trop grande \(4000×4000\)/);
});

test('une og:image qui est une bannière est refusée, une carrée passe', () => {
  // Presque toutes les og:image sont des bannières 1200×630 : en faire une
  // pastille ronde donnerait un bout d'image sans rapport avec un logo.
  const banniere = logos.analyserImage(png(1200, 630), { source: 'og:image' });
  assert.equal(banniere.ok, false);
  assert.match(banniere.raison, /pas assez carrée/);

  const trop = logos.analyserImage(png(1500, 1500), { source: 'og:image' });
  assert.equal(trop.ok, false);
  assert.match(trop.raison, /trop grande pour un logo/);

  assert.equal(logos.analyserImage(png(512, 512), { source: 'og:image' }).ok, true);

  // La même bannière venue d'un apple-touch-icon reste refusée sur sa taille,
  // mais un 1200×630 en favicon n'est pas jugé sur son rapport.
  assert.equal(logos.analyserImage(png(1200, 630), { source: 'favicon' }).ok, true);
});

// ---------------------------------------------------------------------------
// La cascade
// ---------------------------------------------------------------------------

const PAGE = `<!DOCTYPE html><html><head>
  <link rel="icon" href="/favicon-16.png" sizes="16x16">
  <link rel="apple-touch-icon" sizes="120x120" href="/touch-120.png">
  <link rel="apple-touch-icon" sizes="180x180" href="https://static.exemple.fr/touch-180.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta property="og:image" content="/og.png">
</head><body>Bonjour</body></html>`;

test('la cascade est ordonnée, et la plus grande apple-touch-icon gagne', () => {
  const candidats = logos.candidatsDepuisPage(PAGE, 'https://exemple.fr/');
  const sources = candidats.map((c) => c.source);

  assert.deepEqual(sources.slice(0, 2), ['apple-touch-icon', 'apple-touch-icon']);
  assert.equal(
    candidats[0].url,
    'https://static.exemple.fr/touch-180.png',
    '180 px avant 120 px : la meilleure source d\'abord'
  );
  assert.equal(sources[2], 'manifest');
  assert.equal(sources[3], 'og:image');

  // Le reste de la cascade, dans l'ordre du lot 14 : les icônes déclarées, le
  // logo d'en-tête, /favicon.ico, puis les chemins conventionnels PrestaShop.
  // Chacun n'est atteint que si tous les précédents ont échoué.
  assert.deepEqual(
    [...new Set(sources.slice(4))],
    ['favicon', 'chemin conventionnel'],
    `cascade inattendue : ${sources.join(' → ')}`
  );

  // /favicon.ico est toujours essayée, déclarée ou non — et avant les chemins
  // conventionnels, qui sont le tout dernier recours.
  const urls = candidats.map((c) => c.url);
  assert.ok(urls.includes('https://exemple.fr/favicon.ico'));
  assert.ok(
    urls.indexOf('https://exemple.fr/favicon.ico')
      < urls.indexOf('https://exemple.fr/img/logo.png'),
    'le favicon passe avant les chemins devinés'
  );
  assert.equal(candidats.at(-1).source, 'chemin conventionnel');
});

test('les adresses relatives sont résolues, les doublons écartés', () => {
  const candidats = logos.candidatsDepuisPage(
    '<link rel="apple-touch-icon" href="icone.png"><link rel="apple-touch-icon" href="/icone.png">',
    'https://exemple.fr/fr/accueil'
  );
  const urls = candidats.map((c) => c.url);
  assert.ok(urls.includes('https://exemple.fr/fr/icone.png'));
  assert.ok(urls.includes('https://exemple.fr/icone.png'));
  assert.equal(new Set(urls).size, urls.length, 'aucune adresse récupérée deux fois');
});

test('les icônes d\'un manifeste web sortent de la plus grande à la plus petite', () => {
  const candidats = logos.candidatsDepuisManifesteWeb(
    { icons: [{ src: '/i-48.png', sizes: '48x48' }, { src: '/i-512.png', sizes: '512x512' }] },
    'https://exemple.fr/site.webmanifest'
  );
  assert.deepEqual(candidats.map((c) => c.url), [
    'https://exemple.fr/i-512.png',
    'https://exemple.fr/i-48.png',
  ]);
  assert.deepEqual(logos.candidatsDepuisManifesteWeb({}, 'https://exemple.fr/'), []);
});

test('le contrôle de provenance accepte les sous-domaines, et rien d\'autre', () => {
  const base = 'https://mobile.free.fr/';
  assert.equal(logos.memeFournisseur('https://mobile.free.fr/a.png', base), true);
  assert.equal(logos.memeFournisseur('https://static.mobile.free.fr/a.png', base), true);
  assert.equal(logos.memeFournisseur('https://free.fr/a.png', base), true, 'le domaine parent');
  assert.equal(logos.memeFournisseur('https://www.free.fr/a.png', base), true);

  // Le point entier du lot : jamais un tiers.
  assert.equal(logos.memeFournisseur('https://logo.clearbit.com/free.fr', base), false);
  assert.equal(logos.memeFournisseur('https://cdn.exemple.net/free.png', base), false);
  assert.equal(logos.memeFournisseur('https://free.fr.attaquant.example/a.png', base), false);
});

test('un hôte qui n\'est pas un site public est écarté', () => {
  for (const url of [
    'http://localhost/favicon.ico',
    'http://127.0.0.1/a.png',
    'http://10.0.0.230/a.png',
    'http://nas.local/a.png',
    'http://intranet/a.png',
  ]) {
    assert.equal(logos.hoteSuspect(url), true, url);
  }
  assert.equal(logos.hoteSuspect('https://mobile.free.fr/'), false);
});

test('« mobile.free.fr » sans protocole devient une URL https', () => {
  assert.equal(logos.urlDuSite('mobile.free.fr').toString(), 'https://mobile.free.fr/');
  assert.equal(logos.urlDuSite('https://edf.fr/clients').origin, 'https://edf.fr');
  assert.equal(logos.urlDuSite(''), null);
  assert.equal(logos.urlDuSite('ftp://exemple.fr'), null);
});

// ---------------------------------------------------------------------------
// Récupération de bout en bout, avec un réseau simulé
// ---------------------------------------------------------------------------

/**
 * Un faux réseau : une table d'adresses, et la trace de ce qui a été demandé.
 *
 * Aucun test ne sort de la machine — c'est la règle de tout le dépôt, et elle
 * compte doublement ici : ces requêtes-là partiraient vers de vrais sites de
 * fournisseurs.
 */
function reseau(routes) {
  const demandes = [];
  return {
    demandes,
    runtime: {
      now: () => Date.now(),
      // Le réseau est simulé de bout en bout : rien ne sort de la machine,
      // c'est le double qui répond.
      sortiesAutorisees: () => true,
      fetch: async (url) => {
        demandes.push(url);
        const reponse = routes[url];
        if (!reponse) return { ok: false, status: 404, url };
        if (reponse.erreur) throw Object.assign(new Error('boum'), { name: reponse.erreur });
        return {
          ok: true,
          status: 200,
          url: reponse.finale || url,
          text: async () => String(reponse.texte ?? ''),
          arrayBuffer: async () => reponse.buffer,
        };
      },
    },
  };
}

const MANIFEST = { id: 'demo', name: 'Démo', site: 'exemple.fr' };

test.beforeEach(() => logos.supprimer('demo'));

test('cascade heureuse : l\'apple-touch-icon est retenue, et rien de plus n\'est demandé', async () => {
  const { runtime, demandes } = reseau({
    'https://exemple.fr/': { texte: PAGE },
    'https://static.exemple.fr/touch-180.png': { buffer: png(180, 180) },
  });

  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.ok, true, resultat.raison);
  assert.equal(resultat.origin, 'https://static.exemple.fr/touch-180.png');
  assert.equal(resultat.ext, 'png');

  // On s'arrête au premier résultat correct : ni manifeste, ni og:image, ni
  // favicon n'ont été demandés.
  assert.deepEqual(demandes, ['https://exemple.fr/', 'https://static.exemple.fr/touch-180.png']);

  // Le fichier est là, et l'adresse servie est LOCALE.
  assert.ok(fs.existsSync(logos.chemin('demo')));
  assert.match(logos.publicUrl('demo'), /^\/api\/connectors\/logos\/demo\.png\?v=\d+$/);
  assert.equal(logos.lire('demo').source, 'fetched');
});

test('chaque échec fait passer au candidat suivant, jusqu\'au favicon', async () => {
  const { runtime } = reseau({
    'https://exemple.fr/': { texte: PAGE },
    // 180 px : injoignable.
    'https://static.exemple.fr/touch-180.png': { erreur: 'TypeError' },
    // 120 px : une page d'erreur HTML servie à la place du PNG.
    'https://exemple.fr/touch-120.png': { buffer: Buffer.from('<html>404</html>') },
    // manifeste : illisible.
    'https://exemple.fr/site.webmanifest': { texte: 'ceci n’est pas du JSON' },
    // og:image : une bannière.
    'https://exemple.fr/og.png': { buffer: png(1200, 630) },
    // favicon déclarée : trop petite.
    'https://exemple.fr/favicon-16.png': { buffer: png(8, 8) },
    // dernier recours : celle-là est bonne.
    'https://exemple.fr/favicon.ico': { buffer: ico(64) },
  });

  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.ok, true, resultat.raison);
  assert.equal(resultat.origin, 'https://exemple.fr/favicon.ico');
  assert.equal(resultat.ext, 'ico');
});

test('le manifeste web est lu, et ses icônes rejoignent la cascade', async () => {
  const { runtime } = reseau({
    'https://exemple.fr/': {
      texte: '<link rel="manifest" href="/site.webmanifest">',
    },
    'https://exemple.fr/site.webmanifest': {
      texte: JSON.stringify({ icons: [{ src: '/i-192.png', sizes: '192x192' }] }),
    },
    'https://exemple.fr/i-192.png': { buffer: png(192, 192) },
  });

  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.ok, true, resultat.raison);
  assert.equal(resultat.origin, 'https://exemple.fr/i-192.png');
});

test('un candidat hébergé chez un tiers n\'est même pas demandé', async () => {
  const { runtime, demandes } = reseau({
    'https://exemple.fr/': {
      texte: '<link rel="apple-touch-icon" href="https://logo.clearbit.com/exemple.fr">',
    },
    'https://exemple.fr/favicon.ico': { buffer: ico(32) },
  });

  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.ok, true);
  assert.equal(resultat.origin, 'https://exemple.fr/favicon.ico');
  assert.equal(
    demandes.some((u) => u.includes('clearbit')),
    false,
    'aucune requête vers un tiers : ce serait lui annoncer les services de la maison'
  );
});

test('une redirection vers un tiers ne sert pas de porte dérobée', async () => {
  const { runtime } = reseau({
    'https://exemple.fr/': {
      texte: '<link rel="apple-touch-icon" href="/touch.png">',
    },
    // Le fournisseur redirige son icône vers un CDN qui n'est pas à lui.
    'https://exemple.fr/touch.png': {
      buffer: png(180, 180),
      finale: 'https://cdn.tiers.example/touch.png',
    },
    'https://exemple.fr/favicon.ico': { buffer: ico(32) },
  });

  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.origin, 'https://exemple.fr/favicon.ico', 'l\'image redirigée est écartée');
});

test('site injoignable : /favicon.ico est quand même tentée, puis on renonce', async () => {
  const avecFavicon = reseau({ 'https://exemple.fr/favicon.ico': { buffer: ico(48) } });
  assert.equal((await logos.recupererPour(MANIFEST, avecFavicon.runtime)).ok, true);

  logos.supprimer('demo');
  const rien = reseau({});
  const resultat = await logos.recupererPour(MANIFEST, rien.runtime);
  assert.equal(resultat.ok, false);
  assert.ok(resultat.raison, 'un échec porte toujours une raison lisible');
  assert.equal(logos.publicUrl('demo'), null, 'la pastille à initiales reprend sa place');
});

test('un délai dépassé se dit en français, pas en nom d\'exception', async () => {
  const { runtime } = reseau({ 'https://exemple.fr/': { erreur: 'AbortError' } });
  const resultat = await logos.recupererPour(MANIFEST, runtime);
  assert.equal(resultat.ok, false);
  assert.match(resultat.raison, /injoignable/);
  assert.equal(/AbortError/.test(resultat.raison), false);
});

test('un connecteur sans adresse le dit, plutôt que d\'inventer une adresse', async () => {
  const { runtime, demandes } = reseau({});
  const resultat = await logos.recupererPour({ id: 'demo', name: 'Démo', site: '' }, runtime);
  assert.equal(resultat.ok, false);
  assert.match(resultat.raison, /aucune adresse de site déclarée/);
  assert.deepEqual(demandes, [], 'aucune requête n\'a été tentée');
});

/**
 * §4.2 — la question posée au lot 13 : d'où part la recherche du logo ?
 *
 * De l'ADRESSE, jamais du nom. Chercher « Propolia » dans un moteur de
 * recherche rendrait n'importe quoi et livrerait à un tiers la liste des
 * services installés.
 */
test('la cascade part de l\'adresse, et jamais du nom du service', async () => {
  const { runtime, demandes } = reseau({
    'https://propolia.com/': { texte: '<link rel="apple-touch-icon" href="/logo.png">' },
    'https://propolia.com/logo.png': { buffer: png(180, 180) },
  });

  // Un nom qui n'a rien à voir avec le domaine : s'il servait à quoi que ce
  // soit, la récupération partirait ailleurs — ou nulle part.
  const resultat = await logos.recupererPour(
    { id: 'demo', name: 'Un Nom Qui N\'Est Pas Un Domaine', site: 'propolia.com' },
    runtime
  );

  assert.equal(resultat.ok, true, resultat.raison);
  assert.ok(
    demandes.every((d) => d.startsWith('https://propolia.com/')),
    `toutes les requêtes doivent viser le site déclaré : ${demandes.join(' | ')}`
  );

  // La garantie est structurelle, pas seulement comportementale : le CODE du
  // module ne lit jamais le nom du service. (Les commentaires, eux, en parlent
  // — c'est même l'un des points documentés du lot 13.)
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'server', 'connectors', 'logos.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    code,
    /manifest\??\.name/,
    'aucune fonction de logos.js ne doit lire le NOM du service'
  );
});

/**
 * §4.2 — « Quand un connecteur déclare des URL de connexion et de commandes, en
 * extraire le domaine plutôt que d'utiliser un champ `site` éventuellement
 * absent ou approximatif. »
 */
test('sans champ « site », le domaine est déduit des adresses déclarées', async () => {
  const parAdresse = logos.adresseDuManifeste({
    id: 'coco-papaya',
    urls: {
      login: 'https://www.coco-papaya.com/fr/connexion?back=my-account',
      orders: 'https://www.coco-papaya.com/fr/historique-commandes',
    },
  });
  assert.equal(parAdresse.url.toString(), 'https://www.coco-papaya.com/');
  assert.match(parAdresse.source, /adresse de connexion/);

  // Une page profonde est ramenée à la racine : c'est là que se déclarent
  // l'apple-touch-icon et le manifeste web, qu'une page de connexion omet.
  const parNavigateur = logos.adresseDuManifeste({
    id: 'atelier',
    remoteLogin: { url: 'https://www.atelierduportable.com/connexion/' },
  });
  assert.equal(parNavigateur.url.toString(), 'https://www.atelierduportable.com/');

  // Le champ « site » garde la priorité : il est déclaré pour ça.
  const parSite = logos.adresseDuManifeste({
    id: 'propolia',
    site: 'propolia.com',
    urls: { login: 'https://autre.example/connexion' },
  });
  assert.equal(parSite.url.toString(), 'https://propolia.com/');
  assert.match(parSite.source, /champ « site »/);

  assert.equal(logos.adresseDuManifeste({ id: 'rien' }), null);
});

/**
 * Un échec de logo doit dire OÙ crabe est allé frapper, pas seulement que ça
 * n'a pas marché : sans l'adresse interrogée, rien n'est diagnosticable.
 */
test('un échec journalise l\'adresse interrogée ET la raison', async () => {
  const { runtime } = reseau({});
  const resultat = await logos.recupererPour(
    { id: 'demo', name: 'Démo', urls: { login: 'https://boutique.example/fr/connexion' } },
    runtime
  );

  assert.equal(resultat.ok, false);
  assert.equal(resultat.base, 'https://boutique.example/');
  const detail = (resultat.details || []).join(' ; ');
  assert.match(detail, /https:\/\/boutique\.example\//, `l'adresse doit être dite : ${detail}`);
  assert.match(detail, /adresse de connexion déclarée/, detail);
});

// ---------------------------------------------------------------------------
// Envoi manuel — ce qui ne doit jamais être écrasé
// ---------------------------------------------------------------------------

test('une image envoyée à la main subit exactement les mêmes contrôles', () => {
  const banniere = logos.enregistrerManuel('demo', png(3000, 1200));
  assert.equal(banniere.ok, false, 'un fichier choisi à la main peut aussi être une bannière');
  assert.match(banniere.raison, /trop grande/);

  const pasUneImage = logos.enregistrerManuel('demo', Buffer.from('bonjour'));
  assert.equal(pasUneImage.ok, false);

  assert.equal(logos.publicUrl('demo'), null, 'rien n\'a été enregistré');
});

test('changer de format ne laisse pas l\'ancien fichier derrière lui', () => {
  logos.enregistrerManuel('demo', png(64, 64));
  const enPng = logos.chemin('demo');
  assert.ok(fs.existsSync(enPng));

  logos.enregistrerManuel('demo', svg());
  assert.equal(fs.existsSync(enPng), false, 'le .png a été effacé');
  assert.ok(logos.chemin('demo').endsWith('.svg'));
  assert.match(logos.publicUrl('demo'), /demo\.svg/);
});

test('supprimer un logo rend sa pastille au connecteur', () => {
  logos.enregistrerManuel('demo', png(64, 64));
  const file = logos.chemin('demo');

  assert.equal(logos.supprimer('demo'), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(logos.lire('demo'), null);
  assert.equal(logos.publicUrl('demo'), null);
  assert.equal(logos.supprimer('demo'), false, 'supprimer deux fois ne lève pas');
});

test('un identifiant qui n\'en est pas un ne touche à aucun fichier', () => {
  for (const id of ['../../etc/passwd', 'Demo', 'demo/../autre', '', '.']) {
    assert.throws(() => logos.enregistrer(id, png(), { ext: 'png', source: 'manual' }));
  }
  // Et le dossier ne contient rien d'autre que ce qu'on y a mis.
  const dossier = logos.dossier();
  if (fs.existsSync(dossier)) {
    for (const nom of fs.readdirSync(dossier)) {
      assert.match(nom, /^[a-z0-9-]+\.(png|jpg|webp|ico|svg)$/, `fichier inattendu : ${nom}`);
    }
  }
});

test('une data URL est lue, tout le reste est refusé', () => {
  const attendu = png(64, 64);
  const lue = logos.depuisDataUrl(`data:image/png;base64,${attendu.toString('base64')}`);
  assert.deepEqual(lue, attendu);

  for (const valeur of ['', null, 'https://exemple.fr/a.png', 'data:image/png,pastrop']) {
    assert.equal(logos.depuisDataUrl(valeur), null, String(valeur));
  }
});

test('les logos sont rangés sous CRABE_DATA_DIR, et nulle part ailleurs', () => {
  logos.enregistrerManuel('demo', png(64, 64));
  const attendu = path.join(require('../server/config').config.dataDir, 'logos', 'demo.png');
  assert.equal(logos.chemin('demo'), attendu);
});

// ---------------------------------------------------------------------------
// Les routes d'administration
//
// Aucune de ces requêtes ne sort de la machine : `CRABE_DISABLE_SCRAPING=1` est
// posé par test/helpers.js et coupe toute sortie vers un site de fournisseur,
// logos compris. C'est ce qui permet d'exercer la route de récupération sans
// aller réellement frapper chez Free, EDF ou Amazon.
// ---------------------------------------------------------------------------

async function clientAdmin(t) {
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'patron-logos', 'MotDePasse1');
  return client;
}

test.before(async () => {
  // ⚠ Ce fichier déclare DEUX `before` racine, et le second ne peut pas
  // supposer que le premier est terminé : node:test les démarre l'un après
  // l'autre, mais celui-ci reprend la main dès que le premier attend quelque
  // chose. `setup()` mémorise sa promesse — l'attendre à nouveau ici ne
  // reprépare rien, ça se contente d'arriver après.
  await helpers.setup();
  const permissions = require('../server/permissions');
  const admin = await helpers.createUser({
    username: 'patron-logos',
    plainPassword: 'MotDePasse1',
    role: 'admin',
  });
  helpers.db
    .get()
    .prepare('UPDATE users SET role_id = ? WHERE id = ?')
    .run(permissions.roleBySlug('admin').id, admin.id);
});

test('la liste dit, pour chaque connecteur, ce qu\'il a et d\'où ça vient', async (t) => {
  const client = await clientAdmin(t);
  logos.enregistrerManuel('free', png(120, 120));
  t.after(() => logos.supprimer('free'));

  const reponse = await client.get('/api/admin/connectors/logos');
  assert.equal(reponse.status, 200);

  const free = reponse.body.connectors.find((c) => c.id === 'free');
  assert.match(free.logo, /^\/api\/connectors\/logos\/free\.png\?v=\d+$/);
  assert.equal(free.source, 'manual');
  assert.equal(free.width, 120);
  assert.ok(free.fetchedAt, 'la date de dernière récupération est là');

  // Un connecteur sans logo n'invente rien : c'est la pastille qui parle.
  const edf = reponse.body.connectors.find((c) => c.id === 'edf');
  assert.equal(edf.logo, null);
  assert.equal(edf.source, null);

  assert.equal(reponse.body.limits.maxBytes, logos.TAILLE_MAX);
});

test('une resynchronisation n\'écrase JAMAIS une image envoyée à la main', async (t) => {
  const client = await clientAdmin(t);
  logos.enregistrerManuel('free', svg('width="96" height="96"'));
  t.after(() => logos.supprimer('free'));
  const avant = fs.readFileSync(logos.chemin('free'));

  // « Tout resynchroniser » passe `force` : même comme ça, c'est refusé.
  const refus = await client.post('/api/admin/connectors/free/logo', { force: true });
  assert.equal(refus.status, 409);
  assert.equal(refus.body.skipped, true);
  assert.match(refus.body.error, /envoyé à la main/);
  assert.match(refus.body.error, /Supprimez-le d'abord/);

  assert.deepEqual(fs.readFileSync(logos.chemin('free')), avant, 'le fichier n\'a pas bougé');
  assert.equal(logos.lire('free').source, 'manual');
});

test('« logos manquants » ne touche pas à ce qui est déjà là', async (t) => {
  const client = await clientAdmin(t);
  logos.enregistrerManuel('free', png(64, 64));
  t.after(() => logos.supprimer('free'));

  // Sans `force`, un logo déjà présent est laissé tel quel — et rien ne sort.
  logos.supprimer('free');
  logos.enregistrer('free', png(64, 64), { ext: 'png', source: 'fetched', origin: 'https://free.fr/f.png' });

  const reponse = await client.post('/api/admin/connectors/free/logo', {});
  assert.equal(reponse.status, 200);
  assert.equal(reponse.body.skipped, true);
  assert.equal(logos.lire('free').origin, 'https://free.fr/f.png', 'inchangé');
});

test('un échec de récupération est une information, pas une panne', async (t) => {
  const client = await clientAdmin(t);
  // Les sorties sont coupées dans les tests : la route doit répondre 200 avec
  // « ok: false » et une raison lisible, et surtout pas une 500.
  const reponse = await client.post('/api/admin/connectors/edf/logo', { force: true });
  assert.equal(reponse.status, 200);
  assert.equal(reponse.body.ok, false);
  assert.ok(reponse.body.message, 'un échec porte toujours une raison');
  assert.equal(logos.publicUrl('edf'), null, 'la pastille reste');
});

test('envoi manuel puis suppression, par les routes', async (t) => {
  const client = await clientAdmin(t);
  t.after(() => logos.supprimer('edf'));

  const envoi = await client.put('/api/admin/connectors/edf/logo', {
    dataUrl: `data:image/png;base64,${png(96, 96).toString('base64')}`,
  });
  assert.equal(envoi.status, 200);
  assert.match(envoi.body.logo, /edf\.png/);
  assert.equal(logos.lire('edf').source, 'manual');

  // Une image refusée le dit, et n'enregistre rien.
  const refus = await client.put('/api/admin/connectors/edf/logo', {
    dataUrl: `data:image/png;base64,${png(3000, 3000).toString('base64')}`,
  });
  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /n'a pas été acceptée/);
  assert.equal(logos.lire('edf').width, 96, 'l\'ancienne image est intacte');

  const vide = await client.put('/api/admin/connectors/edf/logo', { dataUrl: 'bonjour' });
  assert.equal(vide.status, 400);

  const suppression = await client.del('/api/admin/connectors/edf/logo');
  assert.equal(suppression.status, 200);
  assert.equal(suppression.body.removed, true);
  assert.equal(logos.publicUrl('edf'), null);
});

test('le logo est servi par crabe, à un compte connecté, et à lui seul', async (t) => {
  const client = await clientAdmin(t);
  logos.enregistrerManuel('free', png(64, 64));
  t.after(() => logos.supprimer('free'));

  const servi = await client.get('/api/connectors/logos/free.png');
  assert.equal(servi.status, 200);

  // Une extension qui n'est pas celle enregistrée ne donne rien : le chemin est
  // reconstruit par le serveur, jamais repris de la requête.
  assert.equal((await client.get('/api/connectors/logos/free.svg')).status, 404);
  assert.equal((await client.get('/api/connectors/logos/inconnu.png')).status, 404);
  assert.equal((await client.get('/api/connectors/logos/..%2F..%2Fetc%2Fpasswd')).status, 404);

  // Sans session, rien du tout — crabe ne sert pas de fichiers à un inconnu.
  const anonyme = await helpers.startServer();
  t.after(() => anonyme.close());
  assert.equal((await anonyme.get('/api/connectors/logos/free.png')).status, 401);
});

test('un compte ordinaire ne gère pas les logos', async (t) => {
  await helpers.createUser({ username: 'simple-logos', plainPassword: 'MotDePasse1' });
  const client = await helpers.startServer();
  t.after(() => client.close());
  await helpers.login(client, 'simple-logos', 'MotDePasse1');

  assert.equal((await client.get('/api/admin/connectors/logos')).status, 403);
  assert.equal((await client.post('/api/admin/connectors/free/logo', {})).status, 403);
  assert.equal((await client.del('/api/admin/connectors/free/logo')).status, 403);
});

test('le catalogue de l\'utilisateur porte l\'adresse du logo, jamais une adresse externe', async (t) => {
  const client = await clientAdmin(t);
  logos.enregistrer('free', png(64, 64), {
    ext: 'png', source: 'fetched', origin: 'https://free.fr/apple-touch-icon.png',
  });
  t.after(() => logos.supprimer('free'));

  const reponse = await client.get('/api/connectors');
  const free = reponse.body.connectors.find((c) => c.id === 'free');
  assert.match(free.logo, /^\/api\/connectors\/logos\/free\.png/);
  assert.equal(
    JSON.stringify(reponse.body).includes('https://free.fr/apple-touch-icon.png'),
    false,
    'la provenance reste dans l\'administration : aucun écran ne recharge depuis l\'extérieur'
  );
});

// ---------------------------------------------------------------------------
// Lot 9 — les destinations de stockage portent un logo, elles aussi
//
// Proton Drive et pCloud s'affichent aux mêmes endroits que les connecteurs,
// avec les mêmes pastilles à initiales : elles méritaient le même mécanisme et
// le même écran. Le stockage local est le cas à part — aucun site, donc
// rien à interroger et une icône livrée dans le dépôt.
// ---------------------------------------------------------------------------

test('les identifiants de destination et de connecteur ne se mélangent pas', () => {
  assert.equal(logos.idDeDestination('proton'), 'destination-proton');
  assert.equal(logos.destinationDeId('destination-proton'), 'proton');
  // Un identifiant de connecteur n'est jamais lu comme une destination : c'est
  // le préfixe, et lui seul, qui les sépare.
  assert.equal(logos.destinationDeId('proton'), null);
  assert.equal(logos.destinationDeId('free-mobile'), null);
  // Et il reste un nom de fichier sûr, sans quoi rien ne serait servi.
  assert.match(logos.idDeDestination('pcloud'), /^[a-z0-9][a-z0-9-]*$/);
});

test('les sujets de logo réunissent les connecteurs et les destinations existantes', () => {
  // ⚠ Ce que ce test verrouille a changé de nature au lot 25 : la liste des
  // destinations n'est plus celle du CODE mais celle de la BASE. Sur une
  // installation neuve il n'y a que le stockage local, et un cloud ajouté apparaît ici
  // aussitôt — avec le site de son fournisseur, donc avec un logo à récupérer.
  const proton = helpers.creerCloud({ provider: 'proton', displayName: 'Proton perso' });
  const autre = helpers.creerCloud({ provider: 'autre', displayName: 'Mon serveur' });

  const sujets = logos.sujets();
  const connecteurs = sujets.filter((s) => s.kind === 'connector');
  const destinations = sujets.filter((s) => s.kind === 'destination');
  assert.ok(connecteurs.length >= 13, `${connecteurs.length} connecteur(s) attendu(s)`);
  assert.deepEqual(
    destinations.map((d) => d.id),
    ['destination-local', `destination-${autre}`, `destination-${proton}`],
    'Le stockage local en tête, puis les clouds par nom'
  );

  // Le site vient du FOURNISSEUR, jamais du nom donné par l'utilisateur :
  // chercher un logo pour « Proton perso » dans un moteur rendrait n'importe
  // quoi, et enverrait à un tiers la liste des espaces de stockage installés.
  assert.equal(logos.sujet(`destination-${proton}`).site, 'proton.me');

  // « Autre stockage » n'est le service de personne : comme le stockage local, il n'a
  // pas de site où chercher un logo, et porte une icône interne au dépôt. Lui
  // donner un site reviendrait à emprunter le logo d'une marque au hasard.
  assert.equal(logos.sujet(`destination-${autre}`).site, '');
  assert.equal(logos.sujet(`destination-${autre}`).interne, '/stockage-autre.svg');

  // Le stockage local n'a nulle part où le chercher, et c'est structurel.
  assert.equal(logos.sujet('destination-local').site, '');
  assert.equal(logos.sujet('destination-local').interne, '/stockage-local.svg');
  assert.equal(logos.sujet('service-inexistant'), null);
});

test('Le stockage local ne déclenche aucune sortie : sans site, la cascade refuse', async () => {
  // Le contrôle qui compte : si cette récupération partait, elle partirait
  // vers on ne sait quoi. Le faux `fetch` le prouverait.
  let sorties = 0;
  const resultat = await logos.recupererPour(logos.sujet('destination-local'), {
    fetch: () => {
      sorties++;
      throw new Error('aucune requête ne doit partir pour le stockage local');
    },
    now: () => Date.now(),
    sortiesAutorisees: () => true,
  });

  assert.equal(resultat.ok, false);
  assert.match(resultat.raison, /aucune adresse de site/);
  assert.equal(sorties, 0, 'aucune requête ne doit sortir pour une destination locale');
});

test('le logo d\'une destination se range et se sert comme celui d\'un connecteur', async (t) => {
  const catalogue = require('../server/destinations/catalogue');
  const client = await clientAdmin(t);

  const proton = helpers.creerCloud({ provider: 'proton', displayName: 'Proton Drive' });

  // Avant toute récupération : l'icône interne pour le stockage local, rien pour le cloud.
  assert.deepEqual(catalogue.logoOf('local'), { logo: '/stockage-local.svg', logoInterne: true });
  assert.deepEqual(catalogue.logoOf(proton), { logo: null, logoInterne: false });

  logos.enregistrer(logos.idDeDestination(proton), png(180, 180), {
    ext: 'png', source: 'fetched', origin: 'https://proton.me/apple-touch-icon.png',
  });
  t.after(() => logos.supprimer(logos.idDeDestination(proton)));

  const pose = catalogue.logoOf(proton);
  assert.match(pose.logo, new RegExp(`^/api/connectors/logos/destination-${proton}\\.png`));
  assert.equal(pose.logoInterne, false, 'un logo récupéré n\'est pas une icône interne');

  // Servi par crabe, et par personne d'autre.
  const fichier = await client.get(pose.logo);
  assert.equal(fichier.status, 200);

  // Et le connecteur qui porterait le même identifiant n'existe pas : le
  // préfixe empêche toute collision entre les deux espaces de noms.
  assert.equal(logos.lire(proton), null);

  const liste = await client.get('/api/admin/connectors/logos');
  const ligne = liste.body.connectors.find((c) => c.id === `destination-${proton}`);
  assert.equal(ligne.kind, 'destination');
  assert.equal(ligne.name, 'Proton Drive', 'le NOM donné par l\'utilisateur');
  assert.match(ligne.logo, new RegExp(`destination-${proton}\\.png`));

  const local = liste.body.connectors.find((c) => c.id === 'destination-local');
  assert.equal(local.source, 'internal');
  assert.equal(local.logo, '/stockage-local.svg');
  assert.equal(local.site, '', 'aucun site : le bouton « Récupérer » sera grisé');
});

test('un logo de destination se supprime, et l\'icône interne reprend sa place', async (t) => {
  const catalogue = require('../server/destinations/catalogue');
  const client = await clientAdmin(t);

  logos.enregistrer(logos.idDeDestination('local'), png(96, 96), {
    ext: 'png', source: 'manual', origin: null,
  });
  assert.equal(catalogue.logoOf('local').logoInterne, false, 'l\'image posée prime');

  const retrait = await client.del('/api/admin/connectors/destination-local/logo');
  assert.equal(retrait.status, 200);
  assert.equal(retrait.body.removed, true);
  assert.deepEqual(catalogue.logoOf('local'), { logo: '/stockage-local.svg', logoInterne: true });

  // Un sujet qui n'existe pas reste un 404, préfixe ou pas.
  assert.equal((await client.del('/api/admin/connectors/destination-inconnue/logo')).status, 404);
});
