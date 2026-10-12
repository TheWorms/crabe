'use strict';

/**
 * Helper de formatage du front (web/fmt.js).
 *
 * C'est le point d'entrée UNIQUE de l'affichage des dates et des heures : les
 * réglages d'administration (fuseau, format d'heure, format de date) doivent
 * s'y appliquer réellement, y compris sur les horodatages SQLite qui sont
 * stockés en UTC sans suffixe. C'est exactement ce qui produisait des heures
 * incohérentes quand le conteneur tournait en Etc/UTC.
 *
 * Le fichier est chargé dans un contexte isolé : il ne touche pas au DOM au
 * chargement, on peut donc le tester sans navigateur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'fmt.js'), 'utf8');
const sandbox = { Intl, Date, Number, String, Math, JSON, console };
vm.createContext(sandbox);
// Le fichier est en mode strict : ses `const` de plus haut niveau ne
// deviennent pas des propriétés du global. On les récupère explicitement.
vm.runInContext(
  `${source}\n;globalThis.exported = { fmt, esc, avatarHtml, logoHtml, applyLogo };`,
  sandbox,
  {
    filename: 'web/fmt.js',
  }
);

const { fmt, esc, avatarHtml, logoHtml, applyLogo } = sandbox.exported;

/** Horodatage tel que SQLite le rend : UTC, sans suffixe de fuseau. */
const SQLITE_STAMP = '2026-07-30 14:05:09';

test.beforeEach(() => {
  fmt.configure({
    timezone: 'Europe/Paris',
    timeFormat: '24',
    dateFormat: 'DD/MM/YYYY',
    gravatarEnabled: false,
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('un horodatage SQLite est lu comme de l\'UTC, pas comme une heure locale', () => {
  const parsed = fmt.parse(SQLITE_STAMP);
  assert.equal(parsed.toISOString(), '2026-07-30T14:05:09.000Z');

  // Une date déjà ISO est respectée telle quelle.
  assert.equal(fmt.parse('2026-07-30T14:05:09Z').toISOString(), '2026-07-30T14:05:09.000Z');
  assert.equal(fmt.parse(null), null);
  assert.equal(fmt.parse('pas une date'), null);
});

// ---------------------------------------------------------------------------
// Formats de date
// ---------------------------------------------------------------------------

test('les trois formats de date demandés sont respectés', () => {
  assert.equal(fmt.date(SQLITE_STAMP), '30/07/2026');

  fmt.configure({ dateFormat: 'YYYY-MM-DD' });
  assert.equal(fmt.date(SQLITE_STAMP), '2026-07-30');

  fmt.configure({ dateFormat: 'MM/DD/YYYY' });
  assert.equal(fmt.date(SQLITE_STAMP), '07/30/2026');
});

test('une date absente rend un tiret, pas « Invalid Date »', () => {
  assert.equal(fmt.date(null), '—');
  assert.equal(fmt.dateTime(''), '—');
  assert.equal(fmt.time(undefined), '—');
  assert.equal(fmt.date(null, 'jamais'), 'jamais');
});

// ---------------------------------------------------------------------------
// Formats d'heure et fuseau
// ---------------------------------------------------------------------------

test('le format d\'heure 24 h et 12 h AM/PM', () => {
  // 14:05 UTC = 16:05 à Paris en été.
  assert.equal(fmt.time(SQLITE_STAMP), '16:05');

  fmt.configure({ timeFormat: '12' });
  assert.match(fmt.time(SQLITE_STAMP), /^4:05\s?PM$/);
});

test('le fuseau configuré s\'applique réellement', () => {
  assert.equal(fmt.dateTime(SQLITE_STAMP), '30/07/2026 16:05');

  fmt.configure({ timezone: 'UTC' });
  assert.equal(fmt.dateTime(SQLITE_STAMP), '30/07/2026 14:05');

  // Fuseau très décalé : la date elle-même change, pas seulement l'heure.
  fmt.configure({ timezone: 'Pacific/Auckland' });
  assert.equal(fmt.dateTime(SQLITE_STAMP), '31/07/2026 02:05');
});

test('l\'heure d\'hiver et l\'heure d\'été ne sont pas figées', () => {
  assert.equal(fmt.time('2026-07-30 12:00:00'), '14:00', 'été : UTC+2');
  assert.equal(fmt.time('2026-01-30 12:00:00'), '13:00', 'hiver : UTC+1');
});

test('minuit s\'affiche 00:00 et non 24:00', () => {
  fmt.configure({ timezone: 'UTC' });
  assert.equal(fmt.time('2026-07-30 00:00:00'), '00:00');
});

test('l\'infobulle exacte mentionne le fuseau', () => {
  assert.equal(fmt.exact(SQLITE_STAMP), '30/07/2026 16:05 (Europe/Paris)');
  assert.equal(fmt.exact(null), '');
});

// ---------------------------------------------------------------------------
// Relatif
// ---------------------------------------------------------------------------

test('le relatif reste lisible, et sait dire « jamais »', () => {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();

  assert.equal(fmt.relative(ago(10 * 1000)), "à l'instant");
  assert.equal(fmt.relative(ago(5 * 60 * 1000)), 'il y a 5 min');
  assert.equal(fmt.relative(ago(3 * 3600 * 1000)), 'il y a 3 h');
  assert.equal(fmt.relative(ago(26 * 3600 * 1000)), 'hier');
  assert.equal(fmt.relative(ago(5 * 86400 * 1000)), 'il y a 5 j');
  assert.equal(fmt.relative(ago(70 * 86400 * 1000)), 'il y a 2 mois');
  assert.equal(fmt.relative(ago(800 * 86400 * 1000)), 'il y a 2 ans');
  assert.equal(fmt.relative(null), 'jamais');
  assert.equal(fmt.relative(null, 'aucun'), 'aucun');

  // Une échéance à venir (expiration d'un lien, prochaine exécution). La marge
  // d'une minute évite de basculer à « 2 h » à cause du temps d'exécution.
  const soon = new Date(now + 3 * 3600 * 1000 + 60 * 1000).toISOString();
  assert.equal(fmt.relative(soon), 'dans 3 h');
});

// ---------------------------------------------------------------------------
// Tailles, durées, échappement
// ---------------------------------------------------------------------------

test('les tailles et durées sont lisibles', () => {
  assert.equal(fmt.bytes(512), '512 o');
  assert.equal(fmt.bytes(2048), '2.0 Ko');
  assert.equal(fmt.bytes(5 * 1024 ** 2), '5.0 Mo');
  assert.equal(fmt.bytes(3 * 1024 ** 3), '3.00 Go');
  assert.equal(fmt.bytes(2 * 1024 ** 4), '2.00 To');

  assert.equal(fmt.duration(90), '1 min');
  assert.equal(fmt.duration(3700), '1 h 1 min');
  assert.equal(fmt.duration(200000), '2 j 7 h');
});

test('esc() neutralise le HTML venu de la base', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(esc(null), '');
});

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

test('sans Gravatar, l\'avatar est fait d\'initiales colorées', () => {
  const html = avatarHtml({ initials: 'CA', avatarColor: '#e0693a' }, { size: 42 });
  assert.match(html, /class="avatar/);
  assert.match(html, />CA</);
  assert.match(html, /#e0693a/);
  assert.equal(html.includes('<img'), false, 'aucune requête sortante');
});

test('avec Gravatar, l\'image se replie sur les initiales en cas d\'échec', () => {
  const html = avatarHtml({
    initials: 'CA',
    gravatarUrl: 'https://www.gravatar.com/avatar/abc?s=160&d=404',
  });
  assert.match(html, /<img/);
  assert.match(html, /onerror="this\.remove\(\)"/, 'repli automatique sur les initiales');
  assert.match(html, /loading="lazy"/, 'ne bloque jamais le rendu de la page');
  assert.match(html, />CA</, 'les initiales restent dessous');
});

test('un identifiant sans initiales fournies reste affichable', () => {
  assert.match(avatarHtml({ username: 'camille' }), />CA</);
  assert.match(avatarHtml(null), />··</);
});
