'use strict';

/**
 * Lot 55 — harmonisation des noms déposés : la dérivation et le script.
 *
 * Deux étages :
 *
 *   1. la DÉRIVATION (scripts/derivation-noms-deposes.js), pure, cas par cas —
 *      c'est elle qui décide de chaque nom cible du plan ;
 *   2. le SCRIPT (scripts/harmoniser-noms-deposes.js), sur un DOUBLE DE TEST
 *      complet — base jetable, arborescence locale jetable, deux « clouds »
 *      rclone de type `local` — où il tourne POUR DE VRAI : passe à blanc qui
 *      ne touche à rien, refus sans sauvegarde, refus d'une sauvegarde qui ne
 *      correspond pas, panne en plein milieu puis reprise, mouvement déjà
 *      fait reconnu, idempotence, annulation qui rend l'empreinte initiale.
 *
 * Toutes les valeurs sont INVENTÉES : aucun nom, aucune référence, aucun
 * chemin de production. Les parties rclone se sautent proprement si le
 * binaire manque sur la machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// L'environnement se pose AVANT tout require de server/config.js.
const RACINE_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot55-'));
process.env.NODE_ENV = 'test';
process.env.CRABE_DATA_DIR = path.join(RACINE_TEST, 'data-parent');
process.env.CRABE_MASTER_PASSPHRASE = 'passphrase-de-test-lot55-0123456789';

const Database = require('better-sqlite3');
const crypto = require('../server/crypto');
const { deriverNomCible } = require('../scripts/derivation-noms-deposes');

const SCRIPT = path.resolve(__dirname, '../scripts/harmoniser-noms-deposes.js');
const RCLONE_PRESENT = !spawnSync('rclone', ['version']).error;

test.after(() => fs.rmSync(RACINE_TEST, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. La dérivation, cas par cas
// ---------------------------------------------------------------------------

test('période en tête sans service : le service s\'ajoute, le reste ne bouge pas', () => {
  const v = deriverNomCible('fournisseur-exemple', '2026-05_100042.pdf');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, 'fournisseur-exemple_2026-05_100042.pdf');
});

test('année seule en tête : même règle, la période reste une année', () => {
  const v = deriverNomCible('portail-exemple', '2024_Attestation_annuelle_12.pdf');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, 'portail-exemple_2024_Attestation_annuelle_12.pdf');
});

test('période compacte AAAAMM : recollée en AAAA-MM au passage', () => {
  const v = deriverNomCible('operateur-exemple', '202507_ref-77.pdf');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, 'operateur-exemple_2025-07_ref-77.pdf');
});

test('service répété dans la référence : la répétition se retire, rien d\'autre', () => {
  const v = deriverNomCible('boutique-exemple', 'boutique-exemple_2026-01_boutique-exemple-777.pdf');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, 'boutique-exemple_2026-01_777.pdf');
});

test('un nom déjà moderne est conforme, y compris sans période quand elle est inconnue', () => {
  assert.equal(deriverNomCible('fournisseur-exemple', 'fournisseur-exemple_2026-05_100042.pdf').action, 'conforme');
  assert.equal(deriverNomCible('musique-exemple', 'musique-exemple_0a1b2c3d.pdf').action, 'conforme');
});

test('relevés, billets et eDocPerso restent volontairement hors du renommage', () => {
  assert.equal(deriverNomCible('paypal', 'paypal_releve-reconstitue_2023-08-01_2023-08-31.pdf').action, 'conforme');
  assert.equal(deriverNomCible('ouigo', 'ouigo_billet_2026-02-03_abcd12.pdf').action, 'conforme');
  assert.equal(deriverNomCible('sncf-connect', 'sncf-connect_justificatif-voyage_2026-02-03_ef34.pdf').action, 'conforme');
  assert.equal(deriverNomCible('edocperso', 'bulletins-04-2025_d1634b96.pdf').action, 'exclu');
});

test('une forme inconnue est douteuse : aucune cible proposée, jamais de supposition', () => {
  const v = deriverNomCible('fournisseur-exemple', 'sans_forme_reconnue.pdf');
  assert.equal(v.action, 'douteux');
  assert.equal(v.cible, undefined);
});

test('la dérivation est idempotente : la cible d\'un renommage est conforme', () => {
  for (const [connecteur, nom] of [
    ['fournisseur-exemple', '2026-05_100042.pdf'],
    ['portail-exemple', '2024_Attestation_annuelle_12.pdf'],
    ['boutique-exemple', 'boutique-exemple_2026-01_boutique-exemple-777.pdf'],
  ]) {
    const v = deriverNomCible(connecteur, nom);
    assert.equal(deriverNomCible(connecteur, v.cible).action, 'conforme', `${nom} → ${v.cible}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Le double de test
// ---------------------------------------------------------------------------

/** Les lignes du double A : neuf renommages, deux conformes, un préfixe doublé. */
function lignesDoubleA() {
  const lignes = [];
  for (let i = 1; i <= 8; i++) {
    lignes.push({ connecteur: 'fournisseur-exemple', nom: `2026-0${((i - 1) % 8) + 1}_10000${i}.pdf` });
  }
  lignes.push({ connecteur: 'boutique-exemple', nom: 'boutique-exemple_2026-01_boutique-exemple-777.pdf' });
  lignes.push({ connecteur: 'fournisseur-exemple', nom: 'fournisseur-exemple_2026-09_100099.pdf' });
  lignes.push({ connecteur: 'musique-exemple', nom: 'musique-exemple_0a1b2c3d.pdf' });
  return lignes;
}

/**
 * Fabrique un double complet : base, stockage local jetable, deux clouds `local`.
 * Chaque ligne a son fichier sur les trois destinations, au nom de la base.
 */
async function construireDouble(nomDouble, lignes) {
  const racine = path.join(RACINE_TEST, nomDouble);
  const dataDir = path.join(racine, 'data');
  const stockageLocal = path.join(racine, 'stockage-local');
  const cloud1 = path.join(racine, 'cloud1');
  const cloud2 = path.join(racine, 'cloud2');
  for (const d of [dataDir, stockageLocal, cloud1, cloud2]) fs.mkdirSync(d, { recursive: true });

  if (!crypto.isReady) await crypto.init();
  // Le sel du parent sert à tous les doubles : les enfants déchiffreront.
  fs.copyFileSync(path.join(process.env.CRABE_DATA_DIR, 'master.salt'), path.join(dataDir, 'master.salt'));

  // Le schéma vient des VRAIES migrations : le `db.open()` que le script fait
  // en exécution réelle n'a alors plus rien à migrer — comme en production.
  const dbServeur = require('../server/db/db');
  dbServeur.open(path.join(dataDir, 'crabe.db'));
  dbServeur.close();

  const db = new Database(path.join(dataDir, 'crabe.db'));
  // Les lignes d'invoices exigent leur utilisateur (clé étrangère).
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'camille', 'hachage-invente')").run();
  db.prepare("INSERT OR REPLACE INTO destinations_config (dest_id, enabled, path, protocol) VALUES ('local', 1, ?, 'local')").run(stockageLocal);
  const poserCloud = db.prepare(
    "INSERT INTO destinations_config (dest_id, enabled, provider, display_name, config_encrypted) VALUES (?, 1, 'autre', ?, ?)"
  );
  poserCloud.run('cloud-un', 'Cloud Un', crypto.encrypt({ type: 'local', basePath: cloud1, valeurs: {} }));
  poserCloud.run('cloud-deux', 'Cloud Deux', crypto.encrypt({ type: 'local', basePath: cloud2, valeurs: {} }));

  const inserer = db.prepare(
    'INSERT INTO invoices (id, user_id, connector_id, filename, remote_id, destinations) VALUES (?, 1, ?, ?, ?, ?)'
  );
  let id = 0;
  for (const l of lignes) {
    id++;
    const relatif = `camille/${l.connecteur}/compte/2026/${l.nom}`;
    const chemins = {
      local: { ok: true, path: path.join(stockageLocal, relatif) },
      'cloud-un': { ok: true, path: `crabe:${cloud1}/${relatif}` },
      'cloud-deux': { ok: true, path: `crabe:${cloud2}/${relatif}` },
    };
    for (const base of [stockageLocal, cloud1, cloud2]) {
      const complet = path.join(base, relatif);
      fs.mkdirSync(path.dirname(complet), { recursive: true });
      fs.writeFileSync(complet, `document invente ${id}\n`);
    }
    inserer.run(id, l.connecteur, l.nom, `${l.connecteur}-ref-${id}`, JSON.stringify(chemins));
  }
  db.close();
  return { racine, dataDir, stockageLocal, cloud1, cloud2 };
}

/** Lance le script dans le double, et rend {status, stdout, stderr}. */
function lancer(double, args, envSupplement = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, CRABE_DATA_DIR: double.dataDir, ...envSupplement },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Empreinte des trois arborescences + du contenu de la table invoices. */
function empreinte(double) {
  const morceaux = [];
  for (const base of [double.stockageLocal, double.cloud1, double.cloud2]) {
    const pile = [base];
    const fichiers = [];
    while (pile.length) {
      const d = pile.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const complet = path.join(d, e.name);
        if (e.isDirectory()) pile.push(complet);
        else fichiers.push(`${path.relative(base, complet)}=${fs.readFileSync(complet, 'utf8')}`);
      }
    }
    morceaux.push(fichiers.sort().join('|'));
  }
  const db = new Database(path.join(double.dataDir, 'crabe.db'), { readonly: true });
  morceaux.push(JSON.stringify(db.prepare('SELECT id, filename, destinations FROM invoices ORDER BY id').all()));
  db.close();
  return nodeCrypto.createHash('sha256').update(morceaux.join('\n')).digest('hex');
}

function nomsStockageLocal(double) {
  const noms = [];
  const pile = [double.stockageLocal];
  while (pile.length) {
    const d = pile.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) pile.push(path.join(d, e.name));
      else noms.push(e.name);
    }
  }
  return noms.sort();
}

test('le double de test : passe à blanc, refus, panne, reprise, annulation', { skip: RCLONE_PRESENT ? false : 'rclone absent de cette machine' }, async (t) => {
  const double = await construireDouble('double-a', lignesDoubleA());
  const empreinteInitiale = empreinte(double);

  await t.test('la passe à blanc ne touche à rien et écrit le plan', () => {
    const r = lancer(double, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /9\s+renommer/, 'neuf renommages au plan');
    assert.match(r.stdout, /RIEN n'a été modifié/);
    assert.equal(empreinte(double), empreinteInitiale, 'aucun fichier, aucune ligne ne bouge');
    assert.ok(fs.existsSync(path.join(double.dataDir, 'lot55-plan.tsv')), 'le plan lisible est écrit');
  });

  await t.test('sans sauvegarde, l\'exécution réelle refuse de partir', () => {
    const r = lancer(double, ['--applique']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sauvegarde/i);
    assert.equal(empreinte(double), empreinteInitiale);
  });

  await t.test('une sauvegarde qui ne correspond pas à la base est refusée', () => {
    const copie = path.join(double.racine, 'sauvegarde-fausse.db');
    fs.copyFileSync(path.join(double.dataDir, 'crabe.db'), copie);
    const db = new Database(copie);
    db.prepare('DELETE FROM invoices WHERE id = 1').run();
    db.close();
    const r = lancer(double, ['--applique', '--sauvegarde', copie]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ne correspond pas/);
    assert.equal(empreinte(double), empreinteInitiale);
  });

  const sauvegarde = path.join(double.racine, 'sauvegarde.db');
  fs.copyFileSync(path.join(double.dataDir, 'crabe.db'), sauvegarde);

  await t.test('une panne en plein milieu laisse un état mesurable, la reprise termine', () => {
    const panne = lancer(double, ['--applique', '--sauvegarde', sauvegarde], { CRABE_RENOMMAGE_PANNE_APRES: '3' });
    assert.equal(panne.status, 97, panne.stderr);
    assert.ok(fs.existsSync(path.join(double.dataDir, 'lot55-renommage-journal.jsonl')), 'le journal existe');

    // Trois lignes finies, pas une de plus : le journal les compte.
    const lireJournal = () => fs.readFileSync(path.join(double.dataDir, 'lot55-renommage-journal.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lireJournal().filter((e) => e.type === 'base').length, 3, 'trois lignes finies avant la panne');

    const reprise = lancer(double, ['--applique', '--sauvegarde', sauvegarde]);
    assert.equal(reprise.status, 0, reprise.stderr);
    assert.equal(lireJournal().filter((e) => e.type === 'base').length, 9, 'les neuf lignes sont finies après reprise');

    // Tout est au nom cible, sur les trois destinations comme en base.
    const noms = nomsStockageLocal(double);
    assert.equal(noms.filter((n) => /^\d{4}-\d{2}_/.test(n)).length, 0, 'plus aucun nom sans service sur le stockage local');
    assert.ok(noms.includes('boutique-exemple_2026-01_777.pdf'), 'le préfixe doublé est retombé');
    const db2 = new Database(path.join(double.dataDir, 'crabe.db'), { readonly: true });
    for (const l of db2.prepare('SELECT filename, destinations FROM invoices').all()) {
      const dests = JSON.parse(l.destinations);
      for (const cle of ['local', 'cloud-un', 'cloud-deux']) {
        assert.ok(dests[cle].path.endsWith(`/${l.filename}`), `le chemin « ${cle} » suit le nom (${l.filename})`);
      }
    }
    db2.close();
  });

  await t.test('rejouer ne refait rien : le chantier est idempotent', () => {
    const avant = empreinte(double);
    const r = lancer(double, ['--applique', '--sauvegarde', sauvegarde]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 ligne\(s\) à renommer/);
    assert.equal(empreinte(double), avant);
  });

  await t.test('l\'annulation rejoue le journal à l\'envers et rend l\'empreinte initiale', () => {
    const aBlanc = lancer(double, ['--annuler']);
    assert.equal(aBlanc.status, 0, aBlanc.stderr);
    assert.match(aBlanc.stdout, /RIEN n'a été modifié/);

    const r = lancer(double, ['--annuler', '--applique', '--sauvegarde', sauvegarde]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(empreinte(double), empreinteInitiale, 'chaque fichier et chaque ligne sont revenus');
  });
});

test('un mouvement déjà fait est reconnu, jamais refait ni cassé', { skip: RCLONE_PRESENT ? false : 'rclone absent de cette machine' }, async () => {
  const double = await construireDouble('double-b', [
    { connecteur: 'fournisseur-exemple', nom: '2026-03_200001.pdf' },
    { connecteur: 'fournisseur-exemple', nom: '2026-04_200002.pdf' },
  ]);

  // La ligne 1 a déjà ses trois fichiers au nom cible — comme si un premier
  // passage avait été interrompu entre le stockage et la base.
  const de = 'camille/fournisseur-exemple/compte/2026/2026-03_200001.pdf';
  const vers = 'camille/fournisseur-exemple/compte/2026/fournisseur-exemple_2026-03_200001.pdf';
  for (const base of [double.stockageLocal, double.cloud1, double.cloud2]) {
    fs.renameSync(path.join(base, de), path.join(base, vers));
  }

  const sauvegarde = path.join(double.racine, 'sauvegarde.db');
  fs.copyFileSync(path.join(double.dataDir, 'crabe.db'), sauvegarde);
  const r = lancer(double, ['--applique', '--sauvegarde', sauvegarde]);
  assert.equal(r.status, 0, r.stderr);

  const journal = fs.readFileSync(path.join(double.dataDir, 'lot55-renommage-journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(journal.filter((e) => e.type === 'mouvement' && e.deja).length, 3, 'les trois mouvements déjà faits sont journalisés comme tels');
  assert.equal(journal.filter((e) => e.type === 'mouvement' && !e.deja).length, 3, 'les trois de l\'autre ligne sont faits');

  const db = new Database(path.join(double.dataDir, 'crabe.db'), { readonly: true });
  const noms = db.prepare('SELECT filename FROM invoices ORDER BY id').all().map((x) => x.filename);
  db.close();
  assert.deepEqual(noms, [
    'fournisseur-exemple_2026-03_200001.pdf',
    'fournisseur-exemple_2026-04_200002.pdf',
  ]);
});
