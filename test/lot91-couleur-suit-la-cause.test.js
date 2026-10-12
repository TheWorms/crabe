'use strict';

/**
 * Lot 91 — la couleur d'un échec suit sa CAUSE, jamais son rang ni son âge.
 *
 * ─── Le défaut (mesuré le 05/10/2026, A9) ────────────────────────────────────
 *
 * Le bloc « Suivi actions » de l'accueil peignait en rouge les CINQ échecs les
 * plus récents (`recentErrors`, LIMIT 5) et laissait retomber les suivants en
 * orange, sans date, parmi les « en attente ». Deux services tombés pour la
 * même raison changeaient de couleur selon le nombre d'échecs survenus après
 * eux. Et la phrase était la même pour tous — « X a refusé la connexion. » —
 * qu'une session ait vieilli ou que le site ait refusé une connexion fraîche :
 * `health.js` la devinait en passant une expression régulière sur le TEXTE du
 * message.
 *
 * ─── Ce que cet essai rejoue ─────────────────────────────────────────────────
 *
 * Le chemin réel, de bout en bout : de vraies récupérations par
 * `scheduler.runForUser` (des sondes qui échouent comme le socle
 * `profil-marchand` — même erreur, mêmes drapeaux), l'accueil calculé par
 * `home.dashboard`, puis le VRAI `web/app.js` qui le dessine dans un bac à
 * sable. La couleur d'une ligne est lue dans `web/style.css` (la variable de
 * son filet), jamais supposée.
 *
 * Sur le code d'avant ce lot, les deux essais tombent : c'est la mesure A9,
 * et la morsure de D1.
 *
 * ⚠ Toutes les valeurs sont INVENTÉES : aucun service réel, aucune donnée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const home = require('../server/home');
const db = require('../server/db/db');

const WEB = path.resolve(__dirname, '..', 'web');

/**
 * La sonde : selon `config.mode`, elle réussit (et prouve la liste, sans quoi
 * le socle refuse « aucune nouvelle facture »), ou échoue EXACTEMENT comme le
 * socle des enseignes quand le site renvoie vers son authentification.
 */
const SOURCE_SONDE = `'use strict';
const profilMarchand = require(${JSON.stringify(path.resolve(__dirname, '..', 'server', 'connectors', 'profil-marchand.js'))});
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    if (config.mode === 'renvoi') {
      throw profilMarchand.erreurRenvoiVersAuthentification(ctx.manifest?.name || 'Sonde', 'essai lot 91');
    }
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 0 });
    return { accountId: 'sonde', invoices: [] };
  },
};
`;

const manifeste = (id, nom) => ({
  id,
  name: nom,
  category: 'energie',
  color: '#345678',
  letters: 'S1',
  description: 'Sonde de test du lot 91 : elle réussit ou échoue sur commande.',
  remoteLogin: { url: 'https://sonde.invalid/connexion', marker: '' },
  fields: [
    { key: 'session', label: 'Connexion', type: 'session', required: false },
    { key: 'mode', label: 'Mode', type: 'text', required: false },
  ],
  permissions: [
    { key: 'factures', scope: 'read-write', description: 'Sonde de test : aucune facture réelle n\'est touchée.' },
  ],
});

/** Une session bien formée, au cookie valable un an : de quoi passer le contrôle de forme. */
function sessionInventee(nom) {
  return JSON.stringify({
    cookies: [{
      name: `jeton-${nom}`,
      value: 'valeur-inventee',
      domain: 'sonde.invalid',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 86400,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [],
  });
}

/** Les six services « expirés », du plus récent au plus ancien échec (minutes). */
const EXPIREES = [
  ['sonde91-a', 'Sonde Alpha', 5],
  ['sonde91-b', 'Sonde Bravo', 20],
  ['sonde91-c', 'Sonde Charlie', 50],
  ['sonde91-d', 'Sonde Delta', 120],
  ['sonde91-e', 'Sonde Echo', 24 * 60],
  ['sonde91-f', 'Sonde Foxtrot', 3 * 24 * 60],
];
/** Le service dont la connexion, toute fraîche, est refusée par le site. */
const REFUSEE = ['sonde91-r', 'Sonde Romeo'];

let dossier;
let user;
let dashboard;

/** Décale une exécution dans le passé (minutes) — la base de test seulement. */
function vieillirExecution(id, minutes) {
  db.get()
    .prepare(
      `UPDATE run_logs SET started_at = datetime('now', ?), finished_at = datetime('now', ?)
        WHERE id = ?`
    )
    .run(`-${minutes} minutes`, `-${minutes} minutes`, id);
}

/** Décale les enregistrements de connexion d'un service, s'ils sont tenus (lot 91). */
function vieillirConnexions(connectorId, minutes) {
  const existe = db
    .get()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connexions_enregistrees'")
    .get();
  if (!existe) return;
  db.get()
    .prepare("UPDATE connexions_enregistrees SET at = datetime('now', ?) WHERE connector_id = ?")
    .run(`-${minutes} minutes`, connectorId);
}

const derniereExecution = (connectorId) =>
  db.get().prepare('SELECT MAX(id) AS id FROM run_logs WHERE connector_id = ?').get(connectorId).id;

/**
 * Le VRAI `web/app.js`, sur un DOM minimal (même principe que render.test.js) :
 * on lui donne l'accueil calculé par le serveur, il rend le bloc.
 */
function rendreSuiviActions(donnees) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, options: [],
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          toggle: () => false,
        },
        getAttribute: () => null, setAttribute() {}, addEventListener() {}, focus() {},
        querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return elements.get(id);
  };
  const bac = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, TextEncoder,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
      createElement: () => element('créé'),
      body: element('body'),
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { origin: 'http://crabe.test', href: 'http://crabe.test/' },
    navigator: { userAgent: 'test' },
    confirm: () => true,
    alert() {},
    fetch: async () => { throw new Error('aucun appel réseau dans le bac à sable'); },
  };
  bac.window = bac;
  bac.globalThis = bac;
  const contexte = vm.createContext(bac);
  for (const fichier of ['fmt.js', 'keysym.js', 'ui-prefs.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, fichier), 'utf8'), contexte, { filename: fichier });
  }
  bac.__donnees = JSON.parse(JSON.stringify(donnees));
  return vm.runInContext('home.data = __donnees; widgetErrors()', contexte);
}

/** La couleur d'une nature de ligne, lue dans la feuille de style (variable du filet). */
function couleurDeNature(nature) {
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const motif = new RegExp(`\\.err-item\\.${nature}\\{border-left:3px solid var\\(--([a-z-]+)\\)`);
  const trouve = motif.exec(css);
  return trouve ? trouve[1] : null;
}

/** Les lignes du bloc rendu : nom du service → { nature, couleur, phrase }. */
function lignesRendues(html) {
  const lignes = new Map();
  const motif = /<div class="err-item ([a-z-]+)">([\s\S]*?)<\/div>\s*<\/div>/g;
  for (const [, nature, corps] of html.matchAll(motif)) {
    const nom = /<div class="err-name">([^<]*)<\/div>/.exec(corps)?.[1];
    const phrase = /<div class="err-msg"[^>]*>([^<]*)<\/div>/.exec(corps)?.[1];
    if (nom) lignes.set(nom, { nature, couleur: couleurDeNature(nature), phrase });
  }
  return lignes;
}

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot91', role: 'admin' });
  destinations.restoreLocal();

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot91-'));
  for (const [id, nom] of [...EXPIREES, REFUSEE]) {
    fs.mkdirSync(path.join(dossier, id));
    fs.writeFileSync(path.join(dossier, id, 'manifest.json'), JSON.stringify(manifeste(id, nom)));
    fs.writeFileSync(path.join(dossier, id, 'connector.js'), SOURCE_SONDE);
  }
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));

  // Les six « expirés » : connexion enregistrée il y a huit jours, une
  // réussite il y a sept jours, puis l'échec — à six âges différents.
  for (const [id, , ageMinutes] of EXPIREES) {
    registry.install(user.id, id);
    registry.saveConfig(user.id, id, { session: sessionInventee(id), mode: 'ok' });
    const ok = await scheduler.runForUser(user.id, id, 'manual');
    assert.equal(ok.ok, true, ok.message);
    vieillirExecution(derniereExecution(id), 7 * 24 * 60);
    vieillirConnexions(id, 8 * 24 * 60);

    registry.saveConfig(user.id, id, { mode: 'renvoi' });
    const ko = await scheduler.runForUser(user.id, id, 'manual');
    assert.equal(ko.ok, false);
    vieillirExecution(derniereExecution(id), ageMinutes);
  }

  // Le « refusé » : la connexion vient d'être enregistrée, et la récupération
  // qui la suit est renvoyée vers l'authentification. Jamais de réussite.
  const [idR] = REFUSEE;
  registry.install(user.id, idR);
  registry.saveConfig(user.id, idR, { session: sessionInventee(idR), mode: 'renvoi' });
  const refus = await scheduler.runForUser(user.id, idR, 'manual');
  assert.equal(refus.ok, false);

  dashboard = await home.dashboard(user);
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  registry.load();
  helpers.teardown();
});

test('même cause, âges différents : six sessions expirées sortent toutes de la MÊME couleur', () => {
  const lignes = lignesRendues(rendreSuiviActions(dashboard));
  const couleurs = EXPIREES.map(([, nom]) => [nom, lignes.get(nom)?.couleur ?? 'absente']);
  const distinctes = new Set(couleurs.map(([, c]) => c));
  assert.equal(
    distinctes.size,
    1,
    `six échecs de même cause rendus en ${[...distinctes].join(' et ')} : ${JSON.stringify(couleurs)}`
  );
  // …et cette couleur n'est pas le rouge : une session qui a vieilli est orange.
  assert.equal([...distinctes][0], 'amber', JSON.stringify(couleurs));
});

test('deux causes différentes : deux phrases différentes, et le rouge pour la connexion refusée', () => {
  const lignes = lignesRendues(rendreSuiviActions(dashboard));
  const expiree = lignes.get('Sonde Alpha');
  const refusee = lignes.get('Sonde Romeo');
  assert.ok(expiree && refusee, `lignes absentes : ${JSON.stringify([...lignes.keys()])}`);
  const sansNom = (phrase, nom) => String(phrase).replaceAll(nom, 'X');
  assert.notEqual(
    sansNom(expiree.phrase, 'Sonde Alpha'),
    sansNom(refusee.phrase, 'Sonde Romeo'),
    `même phrase pour deux causes : « ${expiree.phrase} » / « ${refusee.phrase} »`
  );
  assert.equal(refusee.couleur, 'red', `connexion refusée rendue en ${refusee.couleur}`);
});
