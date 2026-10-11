'use strict';

/**
 * Lot 98 — R2 : le déplacement des documents Gandi déjà rangés
 * (`scripts/lot98-dossiers-gandi.js`), sur des stockages d'essai : le stockage
 * local dans un dossier temporaire, un cloud joué par un faux rclone sur un dossier
 * local — qui, comme le vrai, ÉCRASE en silence avec `moveto`.
 *
 * L'état de départ est celui de la production au 06/10/2026, en petit : trois
 * organisations, leurs documents rangés à l'IDENTIFIANT sur les deux
 * stockages, chaque copie enregistrée en base, les noms connus de la
 * découverte. Valeurs inventées : identifiants faits de zéros, noms
 * « Organisation d'essai … », numéros « ZZ… ».
 *
 * Verrouillé : l'essai à blanc ne touche rien (empreintes des deux stockages
 * et de toute la base) ; tout arrive, rien ne se perd, la base suit, chaque
 * chemin pointe un fichier de la bonne taille, le poids ne change pas,
 * l'ancien dossier est retiré ; un second passage ne fait rien ; un conflit
 * arrête ce fichier sans rien écraser ; « Synchroniser » ne redépose rien ; les
 * gardes du geste réel ; la reprise après une coupure ; aucun nom ni
 * identifiant dans ce qui s'affiche.
 */

const faux98 = require('./lot98-faux-rclone').installer();

process.env.CRABE_COPIE_DELAI_MS = '0';
process.env.CRABE_LOT98_RELECTURE_DELAI_MS = '0';

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const destinations = require('../server/destinations');
const discovery = require('../server/connectors/discovery');
const invoicesLib = require('../server/invoices');
const paths = require('../server/destinations/paths');
const sync = require('../server/destinations/sync');
const script = require('../scripts/lot98-dossiers-gandi');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOMS = ['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C'];
/** L'identifiant du stockage local, la copie de référence — le seul nommé ici. */
const LOCAL = 'local';
/** Son nom, tel que le rapport du script le dit (le catalogue). */
const NOM_LOCAL = () => require('../server/destinations/catalogue').brand(LOCAL).name;

/** Le bloc d'un stockage dans le rapport : de sa ligne de titre au titre suivant. */
function blocDe(texte, nom) {
  const debut = texte.indexOf(`  ${nom}\n`);
  assert.ok(debut >= 0, `le rapport a un bloc « ${nom} »`);
  const reste = texte.slice(debut + 3 + nom.length);
  const fin = reste.search(/\n {2}\S/);
  return `  ${nom}\n${fin >= 0 ? reste.slice(0, fin + 1) : reste}`;
}
let cloud;

test.before(async () => {
  await helpers.setup();
  destinations.restoreLocal();
  cloud = helpers.creerCloud({ provider: 'pcloud', displayName: 'pCloud d\'essai' });
});

test.after(() => {
  helpers.teardown();
  faux98.nettoyer();
});

// ---------------------------------------------------------------------------
// L'état de départ : documents à l'identifiant, sur les deux stockages
// ---------------------------------------------------------------------------

/**
 * Un compte crabe avec Gandi, ses organisations découvertes (noms connus), et
 * `combien[i]` documents par organisation rangés à l'IDENTIFIANT — comme
 * avant ce lot. Rend le compte et ses lignes.
 */
async function monterAvantLeLot(nom, { combien = [3, 1, 4], noms = NOMS } = {}) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, 'gandi');
  discovery.save(user.id, 'gandi', 'organisations', noms.map((n, i) => ({ id: ID(i + 1), label: n })));
  const racine = destinations.readConfig(LOCAL).path;
  const inserer = db.get().prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id, size_bytes, issued_on, destinations)
     VALUES (?, 'gandi', ?, ?, ?, ?, ?, ?)`
  );
  combien.forEach((n, o) => {
    for (let k = 0; k < n; k++) {
      const annee = 2016 + ((o + k) % 3);
      const filename = `gandi_${annee}-0${1 + k}_ZZ${'ABC'[o]}${String(9000 - k).padStart(6, '0')}.pdf`;
      const contenu = Buffer.from(`%PDF-1.4 essai ${nom} ${o} ${k} ${'x'.repeat(10 * (o + 1) + k)}`);
      const parts = { username: user.username, connectorName: 'Gandi', accountId: ID(o + 1), issuedOn: `${annee}-0${1 + k}-15`, filename };
      const e = paths.localPath(racine, parts);
      fs.mkdirSync(path.dirname(e), { recursive: true });
      fs.writeFileSync(e, contenu);
      const c = `pcloud:crabe/${paths.relativePath(parts)}`;
      fs.mkdirSync(path.dirname(faux98.local(c)), { recursive: true });
      fs.writeFileSync(faux98.local(c), contenu);
      const dests = invoicesLib.mergeOutcomes('{}', { [LOCAL]: { ok: true, path: e }, [cloud]: { ok: true, path: c } }, '2026-10-06T12:30:00.000Z');
      inserer.run(user.id, filename, `gandi-${ID(o + 1)}-ZZ${o}${k}`, ID(o + 1), contenu.length, `${annee}-0${1 + k}-15`, dests);
    }
  });
  return user;
}

const lignesDe = (user) => db.get().prepare('SELECT * FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id').all(user.id, 'gandi');

/** Empreinte d'un arbre de fichiers : chemin relatif → sha256 (dossiers vides compris). */
function arbre(dossier) {
  const out = {};
  if (!fs.existsSync(dossier)) return out;
  (function parcourir(d, rel) {
    const entrees = fs.readdirSync(d, { withFileTypes: true });
    if (!entrees.length) out[`${rel}/`] = 'dossier vide';
    for (const e of entrees) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) parcourir(path.join(d, e.name), r);
      else out[r] = nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  })(dossier, '');
  return out;
}

/** Empreinte de TOUTE la base : chaque table, chaque ligne. */
function empreinteBase() {
  const h = nodeCrypto.createHash('sha256');
  for (const { name } of db.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    const lignes = db.get().prepare(`SELECT * FROM "${name}"`).all().map((l) => JSON.stringify(l)).sort();
    h.update(`${name}\n${lignes.join('\n')}\n`);
  }
  return h.digest('hex');
}

const etat = () => ({ stockageLocal: arbre(destinations.readConfig(LOCAL).path), cloud: arbre(faux98.racine), base: empreinteBase() });

const planDe = (user) => script.construirePlan().filter((p) => p.userId === user.id);

/** La commande, ses lignes rendues. */
async function commande(argv) {
  const sortie = [];
  const code = await script.principal(['node', 'lot98-dossiers-gandi.js', ...argv], {
    ecrire: (t) => sortie.push(String(t)),
    ecrireErreur: (t) => sortie.push(String(t)),
  });
  return { code, texte: sortie.join('\n') };
}

/** Rien de nominatif dans ce qui s'affiche. */
function rienDeNominatif(texte, user) {
  for (const n of NOMS) assert.ok(!texte.includes(n), 'aucun nom d\'organisation');
  assert.doesNotMatch(texte, /00000000-0000-4000-8000/, 'aucun identifiant d\'organisation');
  assert.doesNotMatch(texte, /gandi_\d{4}/, 'aucun nom de fichier');
  assert.ok(!texte.includes(user.username), 'aucun nom de compte');
}

const dossierDe = (user, chemin) => require('../server/dossier-par-nom')
  .dossierDuChemin(chemin, { username: user.username, connectorName: 'Gandi' }).dossier;

// ---------------------------------------------------------------------------
// Les essais
// ---------------------------------------------------------------------------

let principalUser;
let sauvegarde;

test('l\'essai à blanc compte par stockage et par organisation, et ne touche RIEN — stockages et base à l\'octet', async () => {
  principalUser = await monterAvantLeLot('lot98a');
  const avant = etat();
  const depuis = faux98.commandes().length;
  const { code, texte } = await commande([]);
  assert.equal(code, 0, texte);
  assert.deepEqual(etat(), avant, 'les deux stockages et toute la base, inchangés');
  const jouees = faux98.commandes(depuis).map((c) => c.cmd);
  assert.deepEqual([...new Set(jouees)], ['lsjson'], 'une lecture, rien d\'autre');
  assert.match(texte, /ESSAI À BLANC/);
  assert.match(blocDe(texte, NOM_LOCAL()), /^ {2}.*\n {4}organisation 1 : aDeplacer 3\n {4}organisation 2 : aDeplacer 1\n {4}organisation 3 : aDeplacer 4/);
  assert.match(texte, /pCloud d'essai\n {4}organisation 1 : aDeplacer 3\n {4}organisation 2 : aDeplacer 1\n {4}organisation 3 : aDeplacer 4/);
  assert.match(texte, /avant : 8 fichier\(s\), \d+ octets ; org\. 1 : 3 à l'identifiant, 0 au dossier décidé \(au nom\) ; org\. 2 : 1 à l'identifiant, 0 au dossier décidé \(au nom\) ; org\. 3 : 4 à l'identifiant, 0 au dossier décidé \(au nom\) ; chemins en base 8\/8 pointent un fichier présent de la bonne taille/);
  rienDeNominatif(texte, principalUser);
});

test('le geste réel REFUSE sans sauvegarde vérifiée, sans pause de Gandi, avec une récupération en cours ou en file — et ne touche rien', async () => {
  const avant = etat();
  let r = await commande(['--applique']);
  assert.equal(r.code, 2);
  assert.match(r.texte, /Refusé : sauvegarde introuvable/);
  assert.match(r.texte, /Gandi n'est pas en pause/);

  r = await commande(['--sauvegarder']);
  assert.equal(r.code, 0, r.texte);
  sauvegarde = /Sauvegarde vérifiée : (\S+)/.exec(r.texte)[1];
  assert.ok(path.basename(sauvegarde).startsWith('crabe.db.avant-lot98-dossiers-gandi-'));
  assert.match(r.texte, /sha256 [0-9a-f]{64} — \d+ octets — invoices \d+ \/ MAX\(id\) \d+ — 8 lignes Gandi/);
  assert.equal(fs.statSync(sauvegarde).mode & 0o777, 0o600);

  r = await commande(['--pause']);
  assert.match(r.texte, /Gandi en pause depuis/);
  assert.ok(registry.getInstall(principalUser.id, 'gandi').disabled_at);

  const ouverte = db.get().prepare("INSERT INTO run_logs (connector_id, user_id, trigger) VALUES ('edf', ?, 'manual')").run(principalUser.id).lastInsertRowid;
  r = await commande(['--applique', '--sauvegarde', sauvegarde]);
  assert.equal(r.code, 2);
  assert.match(r.texte, /Refusé : 1 récupération\(s\) en cours, 0 en file/);
  db.get().prepare("UPDATE run_logs SET finished_at = datetime('now'), success = 1 WHERE id = ?").run(ouverte);

  const enFile = db.get().prepare("INSERT INTO run_queue (user_id, connector_id) VALUES (?, 'edf')").run(principalUser.id).lastInsertRowid;
  r = await commande(['--applique', '--sauvegarde', sauvegarde]);
  assert.equal(r.code, 2);
  assert.match(r.texte, /Refusé : 0 récupération\(s\) en cours, 1 en file/);
  db.get().prepare('DELETE FROM run_queue WHERE id = ?').run(enFile);

  r = await commande(['--applique', '--sauvegarde', '/tmp/nimporte-quoi.db']);
  assert.equal(r.code, 2);
  // Les deux stockages n'ont pas bougé (la base a reçu la pause et les lignes d'essai, défaites).
  const apres = etat();
  assert.deepEqual(apres.stockageLocal, avant.stockageLocal);
  assert.deepEqual(apres.cloud, avant.cloud);
});

test('le geste réel : tout arrive, rien ne se perd, la base suit, chaque chemin pointe un fichier de la bonne taille, le poids ne change pas', async () => {
  const user = principalUser;
  const avantLignes = lignesDe(user);
  const contenus = new Map();
  for (const l of avantLignes) {
    const d = JSON.parse(l.destinations);
    contenus.set(`${l.id}|local`, fs.readFileSync(d[LOCAL].path));
    contenus.set(`${l.id}|cloud`, fs.readFileSync(faux98.local(d[cloud].path)));
  }
  const poidsAvant = avantLignes.reduce((n, l) => n + l.size_bytes, 0);

  const { code, texte } = await commande(['--applique', '--sauvegarde', sauvegarde]);
  assert.equal(code, 0, texte);
  assert.match(texte, /DÉPLACEMENT RÉEL/);
  assert.match(texte, /Avant : 0 récupération\(s\) en cours, 0 en file/);
  assert.match(texte, /Après : 0 récupération\(s\) en cours, 0 en file/);
  rienDeNominatif(texte, user);

  const apresLignes = lignesDe(user);
  assert.equal(apresLignes.length, avantLignes.length);
  for (const [i, l] of apresLignes.entries()) {
    const avant = avantLignes[i];
    assert.equal(l.account_id, avant.account_id, 'account_id ne change pas');
    assert.equal(l.filename, avant.filename);
    assert.equal(l.fetched_at, avant.fetched_at);
    const d = JSON.parse(l.destinations);
    const da = JSON.parse(avant.destinations);
    const nom = NOMS[Number(l.account_id.slice(-1)) - 1];
    assert.equal(dossierDe(user, d[LOCAL].path), nom);
    assert.equal(dossierDe(user, d[cloud].path), nom);
    // Seul le chemin a changé dans la colonne.
    assert.deepEqual({ ...d[LOCAL], path: null }, { ...da[LOCAL], path: null });
    assert.deepEqual({ ...d[cloud], path: null }, { ...da[cloud], path: null });
    // Le même fichier, à l'octet, sous son nouveau chemin ; plus rien sous l'ancien.
    assert.ok(fs.readFileSync(d[LOCAL].path).equals(contenus.get(`${l.id}|local`)));
    assert.ok(fs.readFileSync(faux98.local(d[cloud].path)).equals(contenus.get(`${l.id}|cloud`)));
    assert.ok(!fs.existsSync(da[LOCAL].path));
    assert.ok(!fs.existsSync(faux98.local(da[cloud].path)));
  }
  // Les anciens dossiers : retirés, sur les deux stockages.
  const gandiE = path.join(destinations.readConfig(LOCAL).path, user.username, 'Gandi');
  assert.deepEqual(fs.readdirSync(gandiE).sort(), [...NOMS].sort());
  assert.deepEqual(fs.readdirSync(path.join(faux98.racine, 'pcloud', 'crabe', user.username, 'Gandi')).sort(), [...NOMS].sort());
  assert.match(texte, /ancien dossier de l'organisation 1 : vide : retiré/);
  // La vérification dite : 0 à l'identifiant, le compte d'avant au dossier décidé, 8/8 chemins, même poids.
  for (const stockage of [NOM_LOCAL(), 'pCloud d\'essai']) {
    const bloc = blocDe(texte, stockage);
    assert.match(bloc, new RegExp(`après : 8 fichier\\(s\\), ${poidsAvant} octets ; org\\. 1 : 0 à l'identifiant, 3 au dossier décidé \\(déjà employé\\) ; org\\. 2 : 0 à l'identifiant, 1 au dossier décidé \\(déjà employé\\) ; org\\. 3 : 0 à l'identifiant, 4 au dossier décidé \\(déjà employé\\) ; chemins en base 8/8`));
  }
  // Le journal de l'application : des nombres.
  const ligne = db.get().prepare("SELECT message FROM app_logs WHERE source = 'destinations' ORDER BY id DESC LIMIT 1").get().message;
  assert.equal(ligne, `Dossiers de Gandi (lot 98) : 16 copie(s) rangée(s) dans le dossier au nom de leur organisation (${NOM_LOCAL()} 8, pCloud d'essai 8), chemins en base suivis ; 0 conflit(s), rien d'écrasé.`);
});

test('relancé, il ne fait RIEN : ni mouvement, ni retrait, ni écriture — pas même sa ligne de journal', async () => {
  const avant = etat();
  const depuis = faux98.commandes().length;
  const { code, texte } = await commande(['--applique', '--sauvegarde', sauvegarde]);
  assert.equal(code, 0, texte);
  const jouees = faux98.commandes(depuis).map((c) => c.cmd);
  assert.ok(!jouees.includes('moveto') && !jouees.includes('rmdirs'), jouees.join(','));
  // Les deux stockages ET toute la base, journal de l'application compris.
  assert.deepEqual(etat(), avant);
  assert.match(texte, /Journal : rien n'a bougé, rien n'est écrit\./);
  assert.ok(planDe(principalUser)[0].mouvements.length === 0, 'plus rien à déplacer');
});

test('après le déplacement, « Synchroniser » ne redépose rien', async () => {
  assert.equal(sync.pendingFor(cloud, principalUser.id).length, 0, 'rien ne manque au cloud');
  const depuis = faux98.commandes().length;
  const r = await sync.syncDestination(cloud, { userId: principalUser.id });
  assert.deepEqual(r, { copied: 0, failed: 0, stopped: false });
  assert.equal(faux98.commandes(depuis).length, 0, 'aucune commande vers le cloud');
});

test('rallumé, Gandi reprend — et c\'est relu', async () => {
  const r = await commande(['--rallumer']);
  assert.match(r.texte, /Gandi en service/);
  assert.equal(registry.getInstall(principalUser.id, 'gandi').disabled_at, null);
});

test('un nom déjà pris dans la cible ARRÊTE ce fichier : rien n\'est écrasé, sa ligne ne bouge pas, l\'ancien dossier reste', async () => {
  const user = await monterAvantLeLot('lot98b', { combien: [2, 1, 1] });
  const [visee] = lignesDe(user);
  const d0 = JSON.parse(visee.destinations);
  // Un fichier DIFFÉRENT occupe déjà le nom cible, sur les deux stockages.
  const intrus = Buffer.from('%PDF-1.4 un autre document, déjà là');
  const cibleE = d0[LOCAL].path.replace(`/${ID(1)}/`, `/${NOMS[0]}/`);
  const cibleC = faux98.local(d0[cloud].path.replace(`/${ID(1)}/`, `/${NOMS[0]}/`));
  for (const f of [cibleE, cibleC]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, intrus);
  }
  const rapport = await script.passer(planDe(user), { applique: true });
  const texte = [];
  script.ecrireRapport(rapport, (t) => texte.push(t));
  const t = texte.join('\n');
  // L'intrus est intact, la source aussi, la ligne n'a pas bougé.
  assert.ok(fs.readFileSync(cibleE).equals(intrus), 'stockage local : rien d\'écrasé');
  assert.ok(fs.readFileSync(cibleC).equals(intrus), 'cloud : rien d\'écrasé');
  assert.ok(fs.existsSync(d0[LOCAL].path) && fs.existsSync(faux98.local(d0[cloud].path)), 'la source reste où elle est');
  assert.equal(lignesDe(user)[0].destinations, visee.destinations, 'sa ligne ne bouge pas');
  assert.match(blocDe(t, NOM_LOCAL()), /^ {2}.*\n {4}organisation 1 : aDeplacer 1, deplaces 1, conflits 1, baseSuivie 1/);
  assert.match(t, /pCloud d'essai\n {4}organisation 1 : aDeplacer 1, deplaces 1, conflits 1, baseSuivie 1/);
  assert.match(t, /ancien dossier de l'organisation 1 : garde 1 fichier\(s\) : il reste/);
  // La vérification relit CE compte : le fichier arrêté à l'identifiant, l'intrus et le déplacé au dossier décidé.
  assert.match(blocDe(t, NOM_LOCAL()), /^ {2}.*\n(?:.*\n){4}    après : 5 fichier\(s\), \d+ octets ; org\. 1 : 1 à l'identifiant, 2 au dossier décidé \(déjà employé\) ; org\. 2 : 0 à l'identifiant, 1 au dossier décidé \(déjà employé\) ; org\. 3 : 0 à l'identifiant, 1 au dossier décidé \(déjà employé\) ; chemins en base 4\/4/);
  assert.match(t, /ancien dossier de l'organisation 2 : vide : retiré/);
  // Les autres ont suivi.
  for (const l of lignesDe(user).slice(1)) {
    assert.equal(dossierDe(user, JSON.parse(l.destinations)[LOCAL].path), NOMS[Number(l.account_id.slice(-1)) - 1]);
  }
  // Relancé : le conflit reste un conflit, toujours rien d'écrasé.
  const encore = await script.passer(planDe(user), { applique: true });
  const c = encore.comptes[0].parStockage[LOCAL].parOrganisation.get(1);
  assert.equal(c.conflits, 1);
  assert.equal(c.deplaces, 0);
  assert.ok(fs.readFileSync(cibleE).equals(intrus));
});

test('coupé en route (panne du service), relancé : il reprend où il en était, rien n\'est perdu ni doublé', async () => {
  const user = await monterAvantLeLot('lot98c', { combien: [3, 2, 2] });
  faux98.etat({ panneApres: 2 });
  const premier = await script.passer(planDe(user), { applique: true });
  const s = premier.comptes[0].parStockage[cloud];
  const total = [...s.parOrganisation.values()].reduce((n, x) => n + x.deplaces, 0);
  const echecs = [...s.parOrganisation.values()].reduce((n, x) => n + x.echecs, 0);
  const attente = [...s.parOrganisation.values()].reduce((n, x) => n + x.enAttente, 0);
  assert.equal(total, 2, 'deux mouvements avant la panne');
  assert.equal(echecs, 3, 'trois échecs d\'affilée, puis plus rien n\'est demandé');
  assert.equal(attente, 2);
  assert.ok(s.erreurs.some((e) => /3 échecs d'affilée/.test(e)));
  // La base n'a suivi QUE les deux fichiers réellement déplacés.
  const suivis = lignesDe(user).filter((l) => dossierDe(user, JSON.parse(l.destinations)[cloud].path) !== l.account_id).length;
  assert.equal(suivis, 2);
  faux98.etat({});
  await script.passer(planDe(user), { applique: true });
  for (const l of lignesDe(user)) {
    const d = JSON.parse(l.destinations);
    const nom = NOMS[Number(l.account_id.slice(-1)) - 1];
    assert.equal(dossierDe(user, d[cloud].path), nom);
    assert.equal(fs.statSync(faux98.local(d[cloud].path)).size, l.size_bytes);
  }
  const fichiers = Object.keys(arbre(path.join(faux98.racine, 'pcloud', 'crabe', user.username))).filter((k) => !k.endsWith('/'));
  assert.equal(fichiers.length, 7, 'ni perdu ni doublé');
});

test('passé le budget de temps, le passage s\'arrête de lui-même ; le suivant finit', async () => {
  const user = await monterAvantLeLot('lot98e', { combien: [2, 2, 2] });
  let horloge = 0;
  const maintenant = () => (horloge += 1000);
  const premier = await script.passer(planDe(user), { applique: true, budgetMs: 4500, maintenant });
  const ecu = [...premier.comptes[0].parStockage[LOCAL].parOrganisation.values()];
  const attente = ecu.reduce((n, x) => n + x.enAttente, 0) + [...premier.comptes[0].parStockage[cloud].parOrganisation.values()].reduce((n, x) => n + x.enAttente, 0);
  assert.ok(attente > 0, 'des mouvements attendent le passage suivant');
  assert.match(script.phraseDuJournal(premier), /en attente du passage suivant/);
  await script.passer(planDe(user), { applique: true });
  assert.equal(planDe(user)[0].mouvements.length, 0, 'tout est rangé');
});

test('un mot sur ce qui s\'affiche : le masque retire noms, identifiants et noms de fichier d\'un message d\'erreur', () => {
  const plans = planDe(principalUser);
  const masque = script.fabriquerMasque(plans);
  const brut = `ERROR : ${NOMS[0]}/2016/gandi_2016-01_ZZA009000.pdf: pcloud:crabe/${principalUser.username}/Gandi/${ID(1)}/x failed\nsuite`;
  const m = masque(brut);
  rienDeNominatif(m, principalUser);
  assert.ok(!m.includes('\n'), 'une ligne');
});
