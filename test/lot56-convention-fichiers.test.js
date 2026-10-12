'use strict';

/**
 * Lot 56 — le nom des fichiers est un réglage, le renommage se lance de l'écran.
 *
 * Trois étages :
 *
 *   1. la DÉRIVATION à deux conventions (server/convention-noms.js), pure :
 *      chaque forme connue, dans les deux sens, l'idempotence et l'aller-retour ;
 *   2. le RÉGLAGE (preferences) : liste fermée défendue à l'écriture, valeur
 *      abîmée ramenée à la convention en vigueur à la lecture ;
 *   3. le MOTEUR (server/harmonisation.js) sur un DOUBLE DE TEST complet —
 *      base jetable ouverte par le serveur, stockage local jetable, deux « clouds »
 *      rclone de type `local` — où il tourne POUR DE VRAI, service jamais
 *      arrêté : refus d'une destination injoignable, refus quand la sauvegarde
 *      ne peut pas s'écrire, verrou « une seule à la fois », exclusion mutuelle
 *      avec la synchronisation forcée, panne en plein milieu puis reprise,
 *      idempotence, annulation qui rend l'empreinte initiale.
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
const RACINE_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot56-'));
process.env.NODE_ENV = 'test';
process.env.CRABE_DATA_DIR = path.join(RACINE_TEST, 'data');
process.env.CRABE_MASTER_PASSPHRASE = 'passphrase-de-test-lot56-0123456789';

const Database = require('better-sqlite3');
const crypto = require('../server/crypto');
const {
  CONVENTIONS,
  CONVENTION_PAR_DEFAUT,
  deriverNomCible,
  nomDeDepot,
} = require('../server/convention-noms');
const preferences = require('../server/preferences');

const RCLONE_PRESENT = !spawnSync('rclone', ['version']).error;

test.after(() => fs.rmSync(RACINE_TEST, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. La dérivation, dans les deux conventions
// ---------------------------------------------------------------------------

test('le catalogue porte deux conventions, et le défaut est celle en vigueur', () => {
  assert.deepEqual(CONVENTIONS.map((c) => c.id), ['avec-service', 'sans-service']);
  assert.equal(CONVENTION_PAR_DEFAUT, 'avec-service');
  for (const c of CONVENTIONS) {
    assert.ok(c.titre && c.exemple && c.description, `la convention ${c.id} se présente toute seule`);
  }
});

test('sans le service : un nom moderne perd son préfixe, rien d\'autre ne bouge', () => {
  const v = deriverNomCible('fournisseur-exemple', 'fournisseur-exemple_2026-05_100042.pdf', 'sans-service');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, '2026-05_100042.pdf');
});

test('sans le service : la période en tête est déjà la forme voulue', () => {
  assert.equal(deriverNomCible('fournisseur-exemple', '2026-05_100042.pdf', 'sans-service').action, 'conforme');
  assert.equal(deriverNomCible('portail-exemple', '2024_Attestation_annuelle_12.pdf', 'sans-service').action, 'conforme');
});

test('sans le service : le préfixe doublé disparaît avec le service', () => {
  const v = deriverNomCible('boutique-exemple', 'boutique-exemple_2026-01_boutique-exemple-777.pdf', 'sans-service');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, '2026-01_777.pdf');
});

test('sans le service : la période compacte est recollée, sans ajouter le service', () => {
  const v = deriverNomCible('operateur-exemple', '202507_ref-77.pdf', 'sans-service');
  assert.equal(v.action, 'renommer');
  assert.equal(v.cible, '2025-07_ref-77.pdf');
});

test('sans période connue, le service RESTE dans les deux conventions', () => {
  assert.equal(deriverNomCible('musique-exemple', 'musique-exemple_0a1b2c3d.pdf', 'avec-service').action, 'conforme');
  assert.equal(deriverNomCible('musique-exemple', 'musique-exemple_0a1b2c3d.pdf', 'sans-service').action, 'conforme');
});

test('documents de voyage et relevés : la nature reste, le service suit la convention', () => {
  const billet = deriverNomCible('ouigo', 'ouigo_billet_2026-02-03_abcd12.pdf', 'sans-service');
  assert.equal(billet.action, 'renommer');
  assert.equal(billet.cible, 'billet_2026-02-03_abcd12.pdf');
  assert.equal(deriverNomCible('ouigo', 'billet_2026-02-03_abcd12.pdf', 'sans-service').action, 'conforme');

  const retour = deriverNomCible('ouigo', 'billet_2026-02-03_abcd12.pdf', 'avec-service');
  assert.equal(retour.action, 'renommer');
  assert.equal(retour.cible, 'ouigo_billet_2026-02-03_abcd12.pdf');

  const releve = deriverNomCible('paypal', 'paypal_releve-reconstitue_2023-08-01_2023-08-31.pdf', 'sans-service');
  assert.equal(releve.action, 'renommer');
  assert.equal(releve.cible, 'releve-reconstitue_2023-08-01_2023-08-31.pdf');
  assert.equal(
    deriverNomCible('paypal', 'releve-reconstitue_2023-08-01_2023-08-31.pdf', 'avec-service').cible,
    'paypal_releve-reconstitue_2023-08-01_2023-08-31.pdf'
  );
});

test('eDocPerso reste exclu, et une forme inconnue reste douteuse, dans les deux conventions', () => {
  for (const convention of ['avec-service', 'sans-service']) {
    assert.equal(deriverNomCible('edocperso', 'bulletins-04-2025_d1634b96.pdf', convention).action, 'exclu');
    const v = deriverNomCible('fournisseur-exemple', 'sans_forme_reconnue.pdf', convention);
    assert.equal(v.action, 'douteux');
    assert.equal(v.cible, undefined);
  }
});

test('idempotence : la cible d\'un renommage est conforme, dans les deux conventions', () => {
  const cas = [
    ['fournisseur-exemple', '2026-05_100042.pdf'],
    ['fournisseur-exemple', 'fournisseur-exemple_2026-05_100042.pdf'],
    ['boutique-exemple', 'boutique-exemple_2026-01_boutique-exemple-777.pdf'],
    ['operateur-exemple', '202507_ref-77.pdf'],
    ['ouigo', 'ouigo_billet_2026-02-03_abcd12.pdf'],
    ['paypal', 'paypal_releve-reconstitue_2023-08-01_2023-08-31.pdf'],
  ];
  for (const convention of ['avec-service', 'sans-service']) {
    for (const [connecteur, nom] of cas) {
      const v = deriverNomCible(connecteur, nom, convention);
      if (v.action !== 'renommer') continue;
      assert.equal(
        deriverNomCible(connecteur, v.cible, convention).action,
        'conforme',
        `${convention} : ${nom} → ${v.cible}`
      );
    }
  }
});

test('aller-retour : avec → sans → avec rend le nom moderne d\'origine', () => {
  const depart = 'fournisseur-exemple_2026-05_100042.pdf';
  const sans = deriverNomCible('fournisseur-exemple', depart, 'sans-service').cible;
  const retour = deriverNomCible('fournisseur-exemple', sans, 'avec-service').cible;
  assert.equal(retour, depart);
});

test('nomDeDepot : le socle renomme au dépôt selon la convention, et ne touche jamais un nom douteux', () => {
  // Un connecteur à nom « en dur » (période en tête) est ramené à la
  // convention du compte au moment du dépôt — la dette ne se recrée plus.
  assert.equal(
    nomDeDepot('fournisseur-exemple', '2026-05_100042.pdf', 'avec-service'),
    'fournisseur-exemple_2026-05_100042.pdf'
  );
  assert.equal(nomDeDepot('fournisseur-exemple', '2026-05_100042.pdf', 'sans-service'), '2026-05_100042.pdf');
  assert.equal(
    nomDeDepot('fournisseur-exemple', 'fournisseur-exemple_2026-05_100042.pdf', 'sans-service'),
    '2026-05_100042.pdf'
  );
  // Aucune règle ne reconnaît : déposé tel quel, jamais une supposition.
  assert.equal(nomDeDepot('fournisseur-exemple', 'sans_forme_reconnue.pdf', 'avec-service'), 'sans_forme_reconnue.pdf');
});

// ---------------------------------------------------------------------------
// 2. Le réglage
// ---------------------------------------------------------------------------

test('le réglage refuse une convention hors liste, avec les choix possibles', () => {
  const motif = preferences.refus('fichiers.convention', 'a-ma-facon');
  assert.ok(motif, 'une valeur inconnue est refusée');
  assert.match(motif, /avec le nom du service/i);
  assert.match(motif, /sans le nom du service/i);
  assert.equal(preferences.refus('fichiers.convention', 'sans-service'), null);
});

test('une valeur abîmée en base retombe sur la convention en vigueur', () => {
  assert.equal(preferences.coerce('fichiers.convention', 'nimporte-quoi'), 'avec-service');
  assert.equal(preferences.coerce('fichiers.convention', 'sans-service'), 'sans-service');
});

// ---------------------------------------------------------------------------
// 3. Le moteur, sur un double complet — service jamais arrêté
// ---------------------------------------------------------------------------

/** Les lignes du double : huit à renommer, un préfixe doublé, deux conformes. */
function lignesDouble() {
  const lignes = [];
  for (let i = 1; i <= 7; i++) {
    lignes.push({ connecteur: 'fournisseur-exemple', nom: `2026-0${i}_10000${i}.pdf` });
  }
  lignes.push({ connecteur: 'boutique-exemple', nom: 'boutique-exemple_2026-01_boutique-exemple-777.pdf' });
  lignes.push({ connecteur: 'fournisseur-exemple', nom: 'fournisseur-exemple_2026-09_100099.pdf' });
  lignes.push({ connecteur: 'musique-exemple', nom: 'musique-exemple_0a1b2c3d.pdf' });
  return lignes;
}

/**
 * Fabrique le double : la base OUVERTE PAR LE SERVEUR (le moteur tourne dans
 * le processus, comme en production), un stockage local jetable, deux clouds
 * `local`. Chaque ligne a son fichier sur les trois destinations.
 */
async function construireDouble(lignes) {
  const racine = path.join(RACINE_TEST, 'double');
  const stockageLocal = path.join(racine, 'stockage-local');
  const cloud1 = path.join(racine, 'cloud1');
  const cloud2 = path.join(racine, 'cloud2');
  for (const d of [stockageLocal, cloud1, cloud2]) fs.mkdirSync(d, { recursive: true });

  if (!crypto.isReady) await crypto.init();
  const dbServeur = require('../server/db/db');
  dbServeur.open();

  const d = dbServeur.get();
  d.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'camille', 'hachage-invente')").run();
  d.prepare("INSERT OR REPLACE INTO destinations_config (dest_id, enabled, path, protocol) VALUES ('local', 1, ?, 'local')").run(stockageLocal);
  const poserCloud = d.prepare(
    "INSERT INTO destinations_config (dest_id, enabled, provider, display_name, config_encrypted) VALUES (?, 1, 'autre', ?, ?)"
  );
  poserCloud.run('cloud-un', 'Cloud Un', crypto.encrypt({ type: 'local', basePath: cloud1, valeurs: {} }));
  poserCloud.run('cloud-deux', 'Cloud Deux', crypto.encrypt({ type: 'local', basePath: cloud2, valeurs: {} }));

  const inserer = d.prepare(
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
  return { racine, stockageLocal, cloud1, cloud2 };
}

/** Empreinte des trois arborescences + du contenu de la table invoices. */
function empreinte(double) {
  const morceaux = [];
  for (const base of [double.stockageLocal, double.cloud1, double.cloud2]) {
    const pile = [base];
    const fichiers = [];
    while (pile.length) {
      const dossier = pile.pop();
      for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
        const complet = path.join(dossier, e.name);
        if (e.isDirectory()) pile.push(complet);
        else fichiers.push(`${path.relative(base, complet)}=${fs.readFileSync(complet, 'utf8')}`);
      }
    }
    morceaux.push(fichiers.sort().join('|'));
  }
  const d = require('../server/db/db').get();
  morceaux.push(JSON.stringify(d.prepare('SELECT id, filename, destinations FROM invoices ORDER BY id').all()));
  return nodeCrypto.createHash('sha256').update(morceaux.join('\n')).digest('hex');
}

/** Attend la fin de la tâche détachée du moteur — jamais plus de 60 s. */
async function attendreFin(harmonisation) {
  const limite = Date.now() + 60_000;
  while (harmonisation.progress().running) {
    if (Date.now() > limite) throw new Error('le chantier ne se termine pas');
    await new Promise((r) => setTimeout(r, 120));
  }
  return harmonisation.progress();
}

test('le moteur : mesures, refus, verrou, panne, reprise, annulation', { skip: RCLONE_PRESENT ? false : 'rclone absent de cette machine' }, async (t) => {
  const double = await construireDouble(lignesDouble());
  const harmonisation = require('../server/harmonisation');
  const destinationSync = require('../server/destinations/sync');
  const empreinteInitiale = empreinte(double);
  const journalPath = path.join(process.env.CRABE_DATA_DIR, 'harmonisation-noms-journal.jsonl');
  const lireJournal = () => fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  await t.test('les mesures comptent sans rien toucher', () => {
    const avec = harmonisation.mesurerConvention(1, 'avec-service');
    assert.deepEqual(
      { total: avec.total, aRenommer: avec.aRenommer, conformes: avec.conformes, douteux: avec.douteux },
      { total: 10, aRenommer: 8, conformes: 2, douteux: 0 }
    );
    const sans = harmonisation.mesurerConvention(1, 'sans-service');
    // Sans le service : les 7 formes « période en tête » sont déjà bonnes ;
    // le nom moderne et le préfixe doublé seraient à renommer ; le nom sans
    // période garde son service.
    assert.deepEqual(
      { total: sans.total, aRenommer: sans.aRenommer, conformes: sans.conformes },
      { total: 10, aRenommer: 2, conformes: 8 }
    );
    const plan = harmonisation.construirePlan(1, 'avec-service');
    assert.equal(plan.entrees.length, 8);
    assert.equal(plan.douteux.length, 0);
    assert.equal(plan.collisions.length, 0);
    assert.equal(plan.entrees.reduce((n, e) => n + e.mouvements.length, 0), 24, 'trois destinations par ligne');
    assert.equal(empreinte(double), empreinteInitiale, 'mesurer ne touche à rien');
  });

  await t.test('une destination injoignable refuse tout le chantier, rien ne bouge', async () => {
    const d = require('../server/db/db').get();
    // Un troisième cloud dont le chemin vit sous un dossier VERROUILLÉ : la
    // sonde d'écriture du contrôle de santé échoue — comme un jeton mort.
    const mur = path.join(double.racine, 'mur');
    fs.mkdirSync(mur, { recursive: true });
    fs.chmodSync(mur, 0o555);
    d.prepare(
      "INSERT INTO destinations_config (dest_id, enabled, provider, display_name, config_encrypted) VALUES ('cloud-mur', 1, 'autre', 'Cloud Mur', ?)"
    ).run(crypto.encrypt({ type: 'local', basePath: path.join(mur, 'sous'), valeurs: {} }));

    try {
      harmonisation.demarrer({ userId: 1, username: 'camille' });
      const fin = await attendreFin(harmonisation);
      assert.ok(fin.refus, 'le chantier est refusé');
      assert.match(fin.refus, /Cloud Mur/);
      assert.match(fin.refus, /Toutes les destinations doivent répondre/);
      assert.equal(empreinte(double), empreinteInitiale, 'aucun fichier, aucune ligne ne bouge');
    } finally {
      fs.chmodSync(mur, 0o755);
      d.prepare("DELETE FROM destinations_config WHERE dest_id = 'cloud-mur'").run();
    }
  });

  await t.test('sans sauvegarde vérifiée, rien ne démarre', async () => {
    const d = require('../server/db/db').get();
    const proto = Object.getPrototypeOf(d);
    const backupOriginal = proto.backup;
    // La copie de la base échoue (disque plein, droit manquant…) : le chantier
    // doit refuser AVANT le premier mouvement, pas continuer sans filet.
    proto.backup = async () => { throw new Error('la copie de la base a échoué (panne simulée)'); };
    try {
      harmonisation.demarrer({ userId: 1, username: 'camille' });
      const fin = await attendreFin(harmonisation);
      assert.ok(fin.refus, 'le chantier est refusé');
      assert.match(fin.refus, /panne simulée/);
      assert.equal(empreinte(double), empreinteInitiale, 'aucun fichier, aucune ligne ne bouge');
    } finally {
      proto.backup = backupOriginal;
    }
  });

  await t.test('une panne en plein milieu laisse un état mesurable ; pendant le chantier, le verrou et la synchronisation refusent', async () => {
    process.env.CRABE_HARMONISATION_PANNE_APRES = '3';
    try {
      harmonisation.demarrer({ userId: 1, username: 'camille' });

      // Le verrou : un second lancement est refusé en 409, tout de suite.
      assert.throws(
        () => harmonisation.demarrer({ userId: 1, username: 'camille' }),
        (err) => err.statusCode === 409 && /déjà en cours/.test(err.message)
      );
      // Et la synchronisation forcée refuse tant que le chantier tourne.
      assert.throws(
        () => destinationSync.start({ destinationIds: ['cloud-un'] }),
        (err) => err.statusCode === 409 && /renommage des documents est en cours/.test(err.message)
      );

      const fin = await attendreFin(harmonisation);
      assert.ok(fin.arret, 'la panne de test arrête net');
      assert.equal(lireJournal().filter((e) => e.type === 'base').length, 3, 'trois lignes finies avant la panne');
      assert.ok(fin.journal.interrompu, 'le journal dit le chantier interrompu');

      // La sauvegarde a été faite par l'application AVANT le premier mouvement.
      const sauvegardes = fs.readdirSync(process.env.CRABE_DATA_DIR)
        .filter((n) => n.startsWith('crabe.db.avant-harmonisation-'));
      assert.ok(sauvegardes.length >= 1, 'une sauvegarde de la base existe');
      const copie = new Database(path.join(process.env.CRABE_DATA_DIR, sauvegardes[0]), { readonly: true });
      const s = copie.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
      copie.close();
      assert.deepEqual(s, { c: 10, m: 10 }, 'la sauvegarde porte la base d\'avant le chantier');
    } finally {
      delete process.env.CRABE_HARMONISATION_PANNE_APRES;
    }
  });

  await t.test('la reprise est le même geste : le plan se recalcule et termine', async () => {
    harmonisation.demarrer({ userId: 1, username: 'camille' });
    const fin = await attendreFin(harmonisation);
    assert.ok(!fin.refus && !fin.arret, fin.message);
    assert.equal(lireJournal().filter((e) => e.type === 'base').length, 8, 'les huit lignes sont finies');

    const d = require('../server/db/db').get();
    for (const l of d.prepare('SELECT connector_id, filename, destinations FROM invoices').all()) {
      assert.equal(deriverNomCible(l.connector_id, l.filename, 'avec-service').action !== 'renommer', true);
      const dests = JSON.parse(l.destinations);
      for (const cle of ['local', 'cloud-un', 'cloud-deux']) {
        assert.ok(dests[cle].path.endsWith(`/${l.filename}`), `le chemin « ${cle} » suit le nom (${l.filename})`);
      }
    }
  });

  await t.test('relancer ne refait rien : le chantier est idempotent', async () => {
    const avant = empreinte(double);
    harmonisation.demarrer({ userId: 1, username: 'camille' });
    const fin = await attendreFin(harmonisation);
    assert.match(fin.message, /Rien à renommer/);
    assert.equal(empreinte(double), avant);
  });

  await t.test('l\'annulation rejoue le journal à l\'envers et rend l\'empreinte initiale', async () => {
    harmonisation.annuler({ userId: 1, username: 'camille' });
    const fin = await attendreFin(harmonisation);
    assert.ok(!fin.refus && !fin.arret, fin.message);
    assert.equal(empreinte(double), empreinteInitiale, 'chaque fichier et chaque ligne sont revenus');
    assert.ok(!fs.existsSync(journalPath), 'le journal est archivé : le prochain chantier repart à neuf');
    assert.ok(
      fs.readdirSync(process.env.CRABE_DATA_DIR).some((n) => n.startsWith('harmonisation-noms-journal-annule-')),
      'l\'archive du journal existe'
    );
  });

  await t.test('sans rien au journal, il n\'y a rien à annuler', () => {
    assert.throws(
      () => harmonisation.annuler({ userId: 1, username: 'camille' }),
      (err) => err.statusCode === 400 && /rien à annuler/i.test(err.message)
    );
  });
});
