'use strict';

/**
 * Lot 88 — deux documents de même nom ne s'écrasent plus.
 *
 * La panne mesurée le 05/10/2026 (passage réel n° 640) : impots distingue les
 * titres en double par un RANG dans leur ancre (lot 86), mais le nom de
 * fichier ignorait le rang — et le dépôt se fait par nom de fichier. Les 14
 * membres de groupe déposés ont chacun remplacé, sur deux stockages, le
 * fichier de la ligne nue de leur groupe ; l'upsert `ON CONFLICT(filename)` a
 * mis la ligne à jour au lieu d'en créer une. Bilan : « 24 factures
 * récupérées », 10 lignes gagnées, 8 fichiers archivés écrasés.
 *
 * Trois remèdes, prouvés ici :
 *   - R1 : le rang entre dans le nom de fichier (impots, fonctions pures) ;
 *   - R2 : le socle porte une garde au dépôt — un nom déjà pris par une ligne
 *     d'ancre différente se journalise, et si la taille diffère aussi, le
 *     document prend le premier nom libre et sa propre ligne ;
 *   - R3 : le compte de fin de passage ne dit « récupérée » que pour une ligne
 *     NOUVELLE ; une ligne rafraîchie se dit à part.
 *
 * La preuve R2/R3 passe par le VRAI chemin du planificateur (`runForUser`),
 * sur une base SQLite temporaire et le stockage local des tests — sans réseau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const impots = require('../server/connectors/available/impots/connector');

// ---------------------------------------------------------------------------
// R1 — le rang entre dans le nom de fichier (fonctions pures d'impots)
// ---------------------------------------------------------------------------

const LIBELLE = 'Mise en demeure de payer';
const ANNEE = 2021;

/** Décide ancres ET noms pour un groupe, comme le connecteur le fait. */
function deciderNoms(membres, base) {
  const decision = impots.deciderAncresGroupe({ libelle: LIBELLE, annee: ANNEE }, membres, base);
  return decision.ancres.map((a) => ({
    ...a,
    nom: impots.nomFichier(ANNEE, LIBELLE, a.rang),
  }));
}

test('R1 — groupe de 5 : le membre repris peut être n\'importe où, personne d\'autre ne prend l\'ancre nue', () => {
  // domIndex 0 = haut du DOM (le plus récent), 4 = bas (le plus ancien).
  const tailles = [55001, 55002, 55003, 55004, 55005];
  const membres = tailles.map((taille, domIndex) => ({ domIndex, taille }));
  const bare = impots.remoteIdPour(LIBELLE, ANNEE);

  // Le membre déjà en base est tour à tour le plus récent (0), un du milieu
  // (2), le plus ancien (4) : critère R1 du lot.
  for (const indexRepris of [0, 2, 4]) {
    const base = { bareEnBase: true, tailleBase: tailles[indexRepris] };
    const ancres = deciderNoms(membres, base);

    // 5 ancres distinctes, 5 noms distincts.
    assert.equal(new Set(ancres.map((a) => a.remoteId)).size, 5, `ancres (repris=${indexRepris})`);
    assert.equal(new Set(ancres.map((a) => a.nom)).size, 5, `noms (repris=${indexRepris})`);

    // SEUL le membre reconnu par sa taille reprend l'ancre nue — et le nom simple.
    assert.equal(ancres[indexRepris].repris, true);
    assert.equal(ancres[indexRepris].remoteId, bare);
    assert.equal(ancres[indexRepris].nom, impots.nomFichier(ANNEE, LIBELLE));
    for (let i = 0; i < 5; i++) {
      if (i === indexRepris) continue;
      assert.notEqual(ancres[i].remoteId, bare, `le membre ${i} ne doit pas prendre l'ancre nue`);
      assert.match(ancres[i].remoteId, /#\d+$/);
      assert.match(ancres[i].nom, /_\d+\.pdf$/);
    }

    // Les rangs des autres sont sans trou ni collision : 1..5 moins celui du repris.
    const rangs = ancres.filter((a) => !a.repris).map((a) => a.rang).sort((a, b) => a - b);
    const attendus = [1, 2, 3, 4, 5].filter((r) => r !== 5 - indexRepris);
    assert.deepEqual(rangs, attendus, `rangs (repris=${indexRepris})`);

    // Stable : le second calcul rend exactement la même chose.
    assert.deepEqual(deciderNoms(membres, base), ancres, 'identique au second calcul');
  }
});

test('R1 — un document neuf en tête du DOM ne décale ni les rangs ni les noms', () => {
  const avant = deciderNoms(
    [{ domIndex: 0, taille: 111 }, { domIndex: 1, taille: 222 }, { domIndex: 2, taille: 333 }],
    { bareEnBase: false, tailleBase: null }
  );
  // Un document NEUF arrive en haut : les anciens glissent d'un cran dans le DOM.
  const apres = deciderNoms(
    [
      { domIndex: 0, taille: 999 },
      { domIndex: 1, taille: 111 },
      { domIndex: 2, taille: 222 },
      { domIndex: 3, taille: 333 },
    ],
    { bareEnBase: false, tailleBase: null }
  );
  for (let i = 0; i < 3; i++) {
    assert.equal(apres[i + 1].remoteId, avant[i].remoteId, `ancre du membre ${i} inchangée`);
    assert.equal(apres[i + 1].nom, avant[i].nom, `nom du membre ${i} inchangé`);
  }
  // Le nouveau prend le rang suivant, sans toucher personne.
  assert.equal(apres[0].rang, 4);
});

test('R1 — un document sans homonyme garde exactement son nom d\'aujourd\'hui', () => {
  // La forme des 55 lignes en base : AAAA_libellé.pdf, sans suffixe.
  assert.equal(
    impots.nomFichier(2026, 'Avis d\'impôt 2026 sur les revenus 2025'),
    '2026_Avis_d_impot_2026_sur_les_revenus_2025.pdf'
  );
  assert.equal(impots.nomFichier(2026, 'Avis', null), '2026_Avis.pdf', 'rang null = nom simple');
  assert.equal(impots.nomFichier(2025, 'Déclaration.pdf').endsWith('.pdf.pdf'), false);
});

test('MORSURE R1 — sans le rang dans le nom, trois membres partagent UN nom', () => {
  // L'ancienne dérivation (le nom sans rang) : c'est le défaut du 05/10/2026.
  const anciens = [1, 2, 3].map(() => impots.nomFichier(ANNEE, LIBELLE));
  assert.equal(new Set(anciens).size, 1, 'l\'ancien nom s\'effondre sur une seule valeur');
  // La nouvelle : trois noms distincts.
  const nouveaux = [1, 2, 3].map((rang) => impots.nomFichier(ANNEE, LIBELLE, rang));
  assert.equal(new Set(nouveaux).size, 3);
});

// ---------------------------------------------------------------------------
// R2 — la décision de dépôt (fonction pure du socle)
// ---------------------------------------------------------------------------

test('R2 — decisionDepot : seul « ancres différentes ET tailles différentes » renomme', () => {
  const doc = (remoteId, longueur) => ({ remoteId, buffer: Buffer.alloc(longueur) });
  const ligne = (remoteId, taille) => ({ id: 1, remote_id: remoteId, size_bytes: taille });

  // Nom libre : rien à faire.
  assert.deepEqual(scheduler.decisionDepot(undefined, doc('A', 10)),
    { autreDocument: false, renommer: false });
  // Même ancre : rafraîchissement d'un document connu.
  assert.deepEqual(scheduler.decisionDepot(ligne('A', 10), doc('A', 20)),
    { autreDocument: false, renommer: false });
  // Ancre absente d'un côté ou de l'autre : comportement d'avant.
  assert.deepEqual(scheduler.decisionDepot(ligne(null, 10), doc('B', 20)),
    { autreDocument: false, renommer: false });
  assert.deepEqual(scheduler.decisionDepot(ligne('A', 10), doc(null, 20)),
    { autreDocument: false, renommer: false });
  // Ancres différentes, MÊME taille : détecté, pas renommé.
  assert.deepEqual(scheduler.decisionDepot(ligne('A', 10), doc('B', 10)),
    { autreDocument: true, renommer: false });
  // Ancres différentes, tailles différentes : la garde renomme.
  assert.deepEqual(scheduler.decisionDepot(ligne('A', 10), doc('B', 20)),
    { autreDocument: true, renommer: true });
});

test('R2 — premierNomLibre : le premier libre, dérivé du nom d\'origine', () => {
  const pris = new Set(['doc.pdf', 'doc_2.pdf', 'doc_3.pdf']);
  assert.equal(scheduler.premierNomLibre('doc.pdf', (n) => pris.has(n)), 'doc_4.pdf');
  assert.equal(scheduler.premierNomLibre('autre.pdf', () => false), 'autre_2.pdf');
  // Sans extension : le suffixe se colle en queue.
  assert.equal(scheduler.premierNomLibre('brut', () => false), 'brut_2');
});

// ---------------------------------------------------------------------------
// D2 — la preuve au dépôt, par le vrai chemin du planificateur
// ---------------------------------------------------------------------------

const ID_IMPOTS_SONDE = 'sonde-depot-groupe';
const ID_GARDE_SONDE = 'sonde-garde-depot';

/** Un manifeste minimal de sonde. */
function manifesteSonde(id, nom) {
  return {
    id,
    name: nom,
    category: 'energie',
    color: '#123456',
    letters: 'SD',
    description: `Sonde de test du lot 88 : ${nom}.`,
    fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
    permissions: [{
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    }],
  };
}

// La sonde « groupe » rejoue la VRAIE décision d'impots (mêmes fonctions
// pures : deciderAncresGroupe + nomFichier) sur des membres inventés, avec les
// `knownRemoteIds`/`knownSizes` que le planificateur lui passe — exactement le
// chemin du passage n° 640, navigateur excepté.
const CHEMIN_IMPOTS = path.join(__dirname, '..', 'server', 'connectors', 'available', 'impots', 'connector.js');
const SOURCE_IMPOTS_SONDE = `'use strict';
const impots = require(${JSON.stringify(CHEMIN_IMPOTS)});
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const membres = globalThis.__membresDuGroupe || [];
    ctx.preuveDeListe?.({ session: 'sonde', liste: 'liste factice', elements: membres.length });
    const libelle = 'Titre en double';
    const annee = 2021;
    const connus = new Set(ctx.knownRemoteIds || []);
    const bare = impots.remoteIdPour(libelle, annee);
    const bareEnBase = connus.has(bare);
    const tailleBase = bareEnBase ? (ctx.knownSizes || {})[bare] : null;
    const decision = impots.deciderAncresGroupe(
      { libelle, annee },
      membres.map((m) => ({ domIndex: m.domIndex, taille: m.contenu.length })),
      { bareEnBase, tailleBase }
    );
    const invoices = [];
    membres.forEach((m, i) => {
      const { remoteId, repris, rang } = decision.ancres[i];
      if (repris || connus.has(remoteId)) return;
      invoices.push({
        remoteId,
        filename: impots.nomFichier(annee, libelle, rang),
        issuedOn: annee + '-01-01',
        buffer: Buffer.from(m.contenu),
      });
    });
    return { invoices };
  },
};
`;

// La sonde « garde » dépose telles quelles les factures qu'on lui donne.
const SOURCE_GARDE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    const factures = globalThis.__facturesAGarde || [];
    ctx.preuveDeListe?.({ session: 'sonde', liste: 'liste factice', elements: factures.length });
    return { invoices: factures.map((f) => ({ ...f, buffer: Buffer.from(f.contenu) })) };
  },
};
`;

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'camille-lot88' });

  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot88-'));
  for (const [id, source] of [
    [ID_IMPOTS_SONDE, SOURCE_IMPOTS_SONDE],
    [ID_GARDE_SONDE, SOURCE_GARDE_SONDE],
  ]) {
    fs.mkdirSync(path.join(dossier, id));
    fs.writeFileSync(path.join(dossier, id, 'manifest.json'),
      JSON.stringify(manifesteSonde(id, id)));
    fs.writeFileSync(path.join(dossier, id, 'connector.js'), source);
  }
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  for (const id of [ID_IMPOTS_SONDE, ID_GARDE_SONDE]) {
    registry.install(user.id, id);
    registry.saveConfig(user.id, id, { username: 'sonde' });
  }
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__membresDuGroupe;
  delete globalThis.__facturesAGarde;
  registry.load();
  helpers.teardown();
});

function lignesDe(connectorId) {
  return helpers.db
    .get()
    .prepare(
      `SELECT id, filename, remote_id, account_id, size_bytes, destinations FROM invoices
        WHERE user_id = ? AND connector_id = ? ORDER BY id`
    )
    .all(user.id, connectorId);
}

function cheminLocal(ligne) {
  const dests = JSON.parse(ligne.destinations);
  const locale = Object.values(dests).find((d) => d && d.path);
  assert.ok(locale, `un chemin local pour la ligne ${ligne.id}`);
  return locale.path;
}

function derniersAvertissements() {
  return helpers.db
    .get()
    .prepare(
      "SELECT message FROM app_logs WHERE source = 'scheduler' AND level = 'warn' ORDER BY id DESC LIMIT 5"
    )
    .all()
    .map((r) => r.message);
}

test('D2 — le membre connu n\'est pas redéposé, les autres arrivent à côté, rien n\'est remplacé', async () => {
  // ─── 1. L'état d'aujourd'hui en miniature : une ligne de groupe à ancre nue ─
  const contenuOrigine = '%PDF-origine '.padEnd(300, 'o');
  globalThis.__membresDuGroupe = [{ domIndex: 0, contenu: contenuOrigine }];
  const graine = await scheduler.runForUser(user.id, ID_IMPOTS_SONDE, 'manual');
  assert.equal(graine.ok, true, graine.message);
  assert.equal(graine.message, '1 facture récupérée');

  let lignes = lignesDe(ID_IMPOTS_SONDE);
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].remote_id, '2021#Titre en double', 'l\'ancre nue, comme en base aujourd\'hui');
  const fichierOrigine = cheminLocal(lignes[0]);
  const mtimeOrigine = fs.statSync(fichierOrigine).mtimeMs;

  // ─── 2. Un passage rend les 3 membres du groupe ────────────────────────────
  globalThis.__membresDuGroupe = [
    { domIndex: 0, contenu: '%PDF-recent '.padEnd(222, 'r') }, // le plus récent
    { domIndex: 1, contenu: '%PDF-milieu '.padEnd(111, 'm') },
    { domIndex: 2, contenu: contenuOrigine }, // le plus ancien = déjà en base
  ];
  const passage = await scheduler.runForUser(user.id, ID_IMPOTS_SONDE, 'manual');
  assert.equal(passage.ok, true, passage.message);
  // R3 : le compte dit vrai — 2 lignes nouvelles, pas « 3 récupérées ».
  assert.equal(passage.message, '2 factures récupérées');
  assert.equal(passage.count, 2);

  lignes = lignesDe(ID_IMPOTS_SONDE);
  assert.equal(lignes.length, 3, '3 lignes : la nue et les deux à rang');
  assert.equal(new Set(lignes.map((l) => l.filename)).size, 3, '3 noms distincts');
  const fichiers = lignes.map((l) => cheminLocal(l));
  assert.equal(new Set(fichiers).size, 3, '3 fichiers distincts');
  for (const f of fichiers) assert.ok(fs.existsSync(f), f);

  // Le nom découle du RANG de l'ancre (R1), pas d'un repêchage : la ligne
  // « #2 » finit en « _2.pdf », la « #3 » en « _3.pdf ». Si le connecteur
  // cessait de mettre le rang dans le nom, la garde du socle rattraperait les
  // fichiers (rien d'écrasé) mais les noms ne suivraient plus les ancres —
  // c'est cette assertion qui mord alors.
  for (const rang of [2, 3]) {
    const ligne = lignes.find((l) => l.remote_id === `2021#Titre en double#${rang}`);
    assert.ok(ligne, `la ligne de rang ${rang} existe`);
    assert.ok(ligne.filename.endsWith(`_${rang}.pdf`),
      `${ligne.filename} doit porter le rang ${rang}`);
  }

  // Le fichier d'origine est INTACT : contenu et date. C'est la panne du
  // 05/10/2026 qui ne doit plus pouvoir se produire.
  assert.equal(fs.readFileSync(fichierOrigine, 'utf8'), contenuOrigine, 'contenu d\'origine intact');
  assert.equal(fs.statSync(fichierOrigine).mtimeMs, mtimeOrigine, 'date d\'origine intacte');

  // ─── 3. Un second passage identique : rien n'est ajouté, rien n'est écrit ──
  const mtimes = fichiers.map((f) => fs.statSync(f).mtimeMs);
  const second = await scheduler.runForUser(user.id, ID_IMPOTS_SONDE, 'manual');
  assert.equal(second.ok, true, second.message);
  assert.equal(second.message, 'Aucune nouvelle facture');
  assert.equal(lignesDe(ID_IMPOTS_SONDE).length, 3, 'aucune ligne ajoutée');
  fichiers.forEach((f, i) => {
    assert.equal(fs.statSync(f).mtimeMs, mtimes[i], `aucune écriture sur ${path.basename(f)}`);
  });
});

test('D2 — la garde seule : deux ancres, deux tailles, un seul nom → 2 lignes, 2 fichiers, un avertissement', async () => {
  globalThis.__facturesAGarde = [
    { remoteId: 'X', filename: 'collision.pdf', issuedOn: '2026-01-01', contenu: 'contenu-X-' + 'x'.repeat(10) },
  ];
  const premier = await scheduler.runForUser(user.id, ID_GARDE_SONDE, 'manual');
  assert.equal(premier.ok, true, premier.message);

  let lignes = lignesDe(ID_GARDE_SONDE);
  assert.equal(lignes.length, 1);
  const ligneX = lignes[0];
  const fichierX = cheminLocal(ligneX);
  const contenuX = fs.readFileSync(fichierX, 'utf8');

  // Un AUTRE document (ancre Y, taille différente) arrive sous le même nom.
  globalThis.__facturesAGarde = [
    { remoteId: 'Y', filename: 'collision.pdf', issuedOn: '2026-02-01', contenu: 'contenu-Y-' + 'y'.repeat(30) },
  ];
  const secours = await scheduler.runForUser(user.id, ID_GARDE_SONDE, 'manual');
  assert.equal(secours.ok, true, secours.message);
  assert.equal(secours.message, '1 facture récupérée');

  lignes = lignesDe(ID_GARDE_SONDE);
  assert.equal(lignes.length, 2, 'deux lignes : rien n\'a été fusionné');
  const ligneY = lignes.find((l) => l.remote_id === 'Y');
  assert.ok(ligneY, 'le nouveau document a sa propre ligne');
  assert.notEqual(ligneY.filename, ligneX.filename, 'sous un nom distinct');
  assert.match(ligneY.filename, /_2\.pdf$/, 'le premier nom libre, dérivé du nom d\'origine');

  // Le fichier et la ligne d'origine ne sont pas touchés.
  assert.equal(fs.readFileSync(fichierX, 'utf8'), contenuX, 'le fichier d\'origine est intact');
  const relueX = lignes.find((l) => l.id === ligneX.id);
  assert.equal(relueX.remote_id, 'X');
  assert.equal(relueX.size_bytes, ligneX.size_bytes);

  // L'avertissement désigne les lignes par leur identifiant.
  const avert = derniersAvertissements().find((m) => m.includes('deux documents différents'));
  assert.ok(avert, 'la garde se journalise');
  assert.ok(avert.includes(`ligne ${ligneX.id}`) && avert.includes(`ligne ${ligneY.id}`), avert);
});

test('D2 — les cas qui ne changent pas : même ancre, ancre absente, même taille → mise à jour', async () => {
  const lignesAvant = lignesDe(ID_GARDE_SONDE);
  const ligneX = lignesAvant.find((l) => l.remote_id === 'X');

  // Même ancre : rafraîchissement du document connu.
  globalThis.__facturesAGarde = [
    { remoteId: 'X', filename: 'collision.pdf', issuedOn: '2026-01-01', contenu: 'contenu-X-rafraichi' },
  ];
  const meme = await scheduler.runForUser(user.id, ID_GARDE_SONDE, 'manual');
  assert.equal(meme.ok, true, meme.message);
  // R3 : une mise à jour n'est pas une « facture récupérée ».
  assert.equal(meme.message, 'Aucune nouvelle facture, 1 document déjà archivé mis à jour');
  assert.equal(meme.count, 0);
  let lignes = lignesDe(ID_GARDE_SONDE);
  assert.equal(lignes.length, lignesAvant.length, 'aucune ligne ajoutée');
  assert.equal(lignes.find((l) => l.id === ligneX.id).size_bytes, 'contenu-X-rafraichi'.length);

  // Ancre absente du document qui arrive : comportement d'avant (mise à jour).
  globalThis.__facturesAGarde = [
    { remoteId: null, filename: 'collision.pdf', issuedOn: '2026-01-01', contenu: 'sans-ancre' },
  ];
  const sansAncre = await scheduler.runForUser(user.id, ID_GARDE_SONDE, 'manual');
  assert.equal(sansAncre.ok, true, sansAncre.message);
  lignes = lignesDe(ID_GARDE_SONDE);
  assert.equal(lignes.length, lignesAvant.length, 'aucune ligne ajoutée');
  const relue = lignes.find((l) => l.id === ligneX.id);
  assert.equal(relue.remote_id, 'X', 'la ligne garde son ancre, comme avant');
  assert.equal(relue.size_bytes, 'sans-ancre'.length);

  // Ancres différentes mais MÊME taille : mise à jour, avec l'avertissement.
  globalThis.__facturesAGarde = [
    { remoteId: 'Z', filename: 'collision.pdf', issuedOn: '2026-01-01', contenu: 'x'.repeat('sans-ancre'.length) },
  ];
  const memeTaille = await scheduler.runForUser(user.id, ID_GARDE_SONDE, 'manual');
  assert.equal(memeTaille.ok, true, memeTaille.message);
  lignes = lignesDe(ID_GARDE_SONDE);
  assert.equal(lignes.length, lignesAvant.length, 'aucune ligne ajoutée');
  assert.equal(lignes.find((l) => l.id === ligneX.id).remote_id, 'X',
    'le remote_id de la ligne reste l\'ancien — le comportement d\'aujourd\'hui');
  const avert = derniersAvertissements().find((m) => m.includes('même') && m.includes('taille'));
  assert.ok(avert, 'la détection se dit toujours, même quand la garde ne renomme pas');
  assert.ok(avert.includes(`ligne ${ligneX.id}`), avert);
});

test('MORSURE D2 — l\'ancienne séquence de dépôt, elle, remplace le fichier : la panne du 05/10/2026', async () => {
  // On rejoue EXACTEMENT ce que le code d'avant faisait d'un nom déjà pris :
  // écrire le fichier sur le stockage, puis l'upsert `ON CONFLICT(filename)`.
  // Si la garde disparaissait du planificateur, c'est ce qui se reproduirait —
  // et les assertions « fichier intact » des tests ci-dessus échoueraient.
  const lignes = lignesDe(ID_GARDE_SONDE);
  const ligneX = lignes.find((l) => l.remote_id === 'X');
  const fichierX = cheminLocal(ligneX);
  const contenuAvant = fs.readFileSync(fichierX, 'utf8');

  await destinations.storeInvoice({
    username: user.username,
    userId: user.id,
    connectorId: ID_GARDE_SONDE,
    // Le même nom lisible que le pipeline : le chemin du fichier en dépend.
    connectorName: registry.manifest(ID_GARDE_SONDE).name,
    accountId: ligneX.account_id,
    issuedOn: '2026-01-01',
    filename: ligneX.filename,
    buffer: Buffer.from('un AUTRE document, déposé sous le même nom'),
  });
  helpers.db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id, size_bytes, issued_on, destinations)
       VALUES (?, ?, ?, 'W', 'defaut', 42, '2026-01-01', '{}')
       ON CONFLICT(user_id, connector_id, filename)
       DO UPDATE SET size_bytes = excluded.size_bytes, fetched_at = datetime('now')`
    )
    .run(user.id, ID_GARDE_SONDE, ligneX.filename);

  // Le fichier d'un autre document a été remplacé, aucune ligne n'est née, et
  // la ligne garde son ancienne ancre : « 24 récupérées » pour 10 lignes.
  assert.notEqual(fs.readFileSync(fichierX, 'utf8'), contenuAvant, 'le fichier a été écrasé');
  assert.equal(lignesDe(ID_GARDE_SONDE).length, lignes.length, 'aucune ligne nouvelle');
  const relue = lignesDe(ID_GARDE_SONDE).find((l) => l.id === ligneX.id);
  assert.equal(relue.remote_id, 'X', 'l\'ancre de la ligne ment sur ce que contient le fichier');
  assert.equal(relue.size_bytes, 42, 'la ligne décrit le document qui a écrasé');
});
