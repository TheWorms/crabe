'use strict';

/**
 * Lot 46 — l'identifiant distant s'ancre sur le voyage, plus sur le fichier.
 *
 * ─── Le défaut que ces tests figent ──────────────────────────────────────────
 *
 * Le 22/08/2026, un passage des deux connecteurs a redéposé HUIT documents
 * déjà en base — trois justificatifs SNCF, cinq billets OUIGO — alors que le
 * lot 44 avait rendu l'empreinte insensible à l'enveloppe datée du PDF. La
 * mesure sur les paires rapatriées de production :
 *
 *   - SNCF tamponne la date d'édition DANS la page (« Paris, le 20/08/2026 »
 *     → « Paris, le 22/08/2026 ») : la seule ligne du texte qui change, mais
 *     elle vit dans un flux compressé — la taille du fichier bouge
 *     (24950 → 24952 octets) et aucun retrait de champ nommé ne l'atteint ;
 *   - OUIGO regénère le billet avec un nom de ressource ALÉATOIRE présent
 *     jusque dans les flux compressés, un champ opaque `/Source` et un `/ID`
 *     neufs : texte identique au caractère près, octets et tailles jamais.
 *
 * L'identifiant vient donc de ce que le document DIT : « Dossier voyage »
 * pour SNCF Connect, « Votre numéro de réservation est : » plus le passager
 * pour OUIGO — vérifié sur les 18 fichiers réels de production (chaque paire rend la
 * même identité, chaque document distinct la sienne), rejoué ici sur des
 * fixtures qui reproduisent la MÉCANIQUE mesurée sans aucune donnée réelle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const helpers = require('./helpers');
const empreinte = require('../server/connectors/empreinte-document');
const identite = require('../server/connectors/identite-voyage');
const sncf = require('../server/connectors/available/sncf-connect/connector');
const ouigo = require('../server/connectors/available/ouigo/connector');
const migrations = require('../server/db/migrations');

// ---------------------------------------------------------------------------
// Les fixtures : la forme mesurée sur les vrais fichiers, sans leurs données
// ---------------------------------------------------------------------------

/**
 * Un PDF dont le texte vit, comme sur les vrais, en littéraux `(…) Tj` dans un
 * flux FlateDecode. `lignes` devient le contenu peint ; `enveloppe` rejoue ce
 * que le générateur repose à chaque exécution (date d'édition dans la page,
 * identifiant de trailer, bourrage de longueur variable — c'est LUI qui fait
 * bouger la taille du fichier, comme le 22/08/2026).
 */
function pdfAvecTexte(lignes, { id = 'abc123', bourrage = '' } = {}) {
  const contenu = Buffer.from(
    `BT /F1 10 Tf ${lignes.map((l) => `(${l})Tj`).join(' T* ')} ET\n% ${bourrage}`,
    'latin1'
  );
  const flux = zlib.deflateSync(contenu);
  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\n'
        + `2 0 obj\n<</Length ${flux.length}/Filter/FlateDecode>>\nstream\n`,
      'latin1'
    ),
    flux,
    Buffer.from(
      '\nendstream\nendobj\n'
        + `trailer\n<</Root 1 0 R/ID [<${id}><${id}>]/Size 3>>\nstartxref\n0\n%%EOF\n`,
      'latin1'
    ),
  ]);
}

/** Un justificatif SNCF de la forme mesurée : l'aller-retour, deux sections. */
function justificatifSncf({ dossier, commande, edite, bourrage = '' }) {
  const section = [
    'JUSTIFICATIF DE VOYAGE',
    `Paris, le ${edite}`,
    'Bonjour Camille MARCHAND,',
    'Vous voudrez bien trouver ci-dessous le justificatif de voyage concernant votre commande e-billet du',
    `${commande}.`,
    'Dossier voyage',
    dossier,
    'Point de vente',
    'Agence VSC MOBILE',
  ];
  return pdfAvecTexte([...section, ...section], { id: edite.replace(/\D/g, ''), bourrage });
}

/** Un billet OUIGO de la forme mesurée : la référence, puis le passager. */
function billetOuigo({ reference, passager = 'CAMILLE MARCHAND - 1990', ressource = 'aa11', bourrage = '' }) {
  return pdfAvecTexte(
    [
      'IMPRIMEZ VOTRE BILLET OU TÉLÉCHARGEZ-LE VIA L\'APPLICATION',
      'Votre numéro de réservation est :',
      reference,
      'Vendredi 26 juin 2026',
      'VOYAGEURS, OPTIONS ET TYPE DE PLACE',
      passager,
      // Le nom de ressource que le générateur d'OUIGO tire au hasard À CHAQUE
      // téléchargement — c'est lui qui rend l'empreinte du lot 44 instable.
      `/R${ressource} Do`,
    ],
    { id: ressource.repeat(4), bourrage }
  );
}

/** Le même voyage SNCF, téléchargé à deux jours d'écart : le défaut du 22/08. */
const SNCF_PASSAGE_1 = justificatifSncf({
  dossier: 'K7M2P9', commande: '27/07/2026', edite: '20/08/2026',
});
const SNCF_PASSAGE_2 = justificatifSncf({
  dossier: 'K7M2P9', commande: '27/07/2026', edite: '22/08/2026',
  bourrage: 'la compression rend une autre taille',
});
/** Un autre voyage, téléchargé le même jour que le second passage. */
const SNCF_AUTRE = justificatifSncf({
  dossier: 'B4QXZ7', commande: '10/07/2026', edite: '22/08/2026',
});

/** La même réservation OUIGO, regénérée : autre ressource, autre taille. */
const OUIGO_PASSAGE_1 = billetOuigo({ reference: 'V3TERQ', ressource: 'aa11' });
const OUIGO_PASSAGE_2 = billetOuigo({
  reference: 'V3TERQ', ressource: 'bb2222',
  bourrage: 'le nom de ressource change la taille',
});
/** Une autre réservation. */
const OUIGO_AUTRE = billetOuigo({ reference: 'ZH8PL4', ressource: 'cc33' });

// ---------------------------------------------------------------------------
// 1. Le défaut est bien là : l'empreinte du lot 44 ne survit pas au 22/08
// ---------------------------------------------------------------------------

test('deux téléchargements du même voyage ne rendent ni les mêmes octets ni la même taille', () => {
  assert.notEqual(Buffer.compare(SNCF_PASSAGE_1, SNCF_PASSAGE_2), 0);
  assert.notEqual(SNCF_PASSAGE_1.length, SNCF_PASSAGE_2.length);
  assert.notEqual(Buffer.compare(OUIGO_PASSAGE_1, OUIGO_PASSAGE_2), 0);
  assert.notEqual(OUIGO_PASSAGE_1.length, OUIGO_PASSAGE_2.length);
});

test('remets le défaut : l\'empreinte du lot 44 rend DEUX identifiants pour UN voyage', () => {
  // C'est la chute mesurée le 22/08/2026 — huit documents redéposés. Si ce
  // test casse un jour, c'est que la normalisation suffit à nouveau… ou que
  // les fixtures ne rejouent plus le défaut : dans les deux cas, à remesurer.
  assert.notEqual(
    empreinte.empreinteStable(SNCF_PASSAGE_1, { prefixe: 'sncf-connect' }),
    empreinte.empreinteStable(SNCF_PASSAGE_2, { prefixe: 'sncf-connect' })
  );
  assert.notEqual(
    empreinte.empreinteStable(OUIGO_PASSAGE_1, { prefixe: 'ouigo' }),
    empreinte.empreinteStable(OUIGO_PASSAGE_2, { prefixe: 'ouigo' })
  );
});

// ---------------------------------------------------------------------------
// 2. L'identité métier se lit dans le document, et survit à la regénération
// ---------------------------------------------------------------------------

test('les chaînes du document se lisent avec zlib seul, dans l\'ordre où il les peint', () => {
  const chaines = identite.chainesDeTexte(SNCF_PASSAGE_1);
  assert.ok(chaines.includes('JUSTIFICATIF DE VOYAGE'));
  assert.ok(chaines.indexOf('Dossier voyage') < chaines.indexOf('K7M2P9'));
  // Ce qui n'est pas un PDF ne rend rien — jamais une erreur.
  assert.deepEqual(identite.chainesDeTexte(Buffer.from('pas un pdf')), []);
});

test('l\'identité SNCF : le dossier et la date de commande, jamais la date d\'édition', () => {
  const un = identite.identiteSncfConnect(SNCF_PASSAGE_1);
  const deux = identite.identiteSncfConnect(SNCF_PASSAGE_2);
  assert.deepEqual(un, { dossier: 'K7M2P9', commandeDu: '2026-07-27' });
  // La date d'édition a changé entre les deux passages ; l'identité, non.
  assert.deepEqual(deux, un);
  assert.deepEqual(
    identite.identiteSncfConnect(SNCF_AUTRE),
    { dossier: 'B4QXZ7', commandeDu: '2026-07-10' }
  );
});

test('l\'identité OUIGO : la référence et le passager, quels que soient les octets', () => {
  const un = identite.identiteOuigo(OUIGO_PASSAGE_1);
  assert.deepEqual(un, { reservation: 'V3TERQ', passager: 'CAMILLE MARCHAND - 1990' });
  assert.deepEqual(identite.identiteOuigo(OUIGO_PASSAGE_2), un);
});

test('un justificatif regénéré garde son identifiant distant, même sous une autre taille', () => {
  assert.equal(sncf.remoteIdPour(SNCF_PASSAGE_1), 'sncf-connect-K7M2P9');
  assert.equal(sncf.remoteIdPour(SNCF_PASSAGE_2), 'sncf-connect-K7M2P9');
  assert.equal(ouigo.remoteIdPour(OUIGO_PASSAGE_1), ouigo.remoteIdPour(OUIGO_PASSAGE_2));
  assert.match(ouigo.remoteIdPour(OUIGO_PASSAGE_1), /^ouigo-V3TERQ-[0-9a-f]{8}$/);
});

test('deux voyages distincts gardent deux identifiants distincts', () => {
  assert.notEqual(sncf.remoteIdPour(SNCF_PASSAGE_2), sncf.remoteIdPour(SNCF_AUTRE));
  assert.notEqual(ouigo.remoteIdPour(OUIGO_PASSAGE_2), ouigo.remoteIdPour(OUIGO_AUTRE));
});

test('le passager fait partie de l\'identité OUIGO : deux billets d\'une même réservation ne se confondent pas', () => {
  // Une réservation à deux voyageurs sert un billet PAR passager. La référence
  // seule leur donnerait le même identifiant, et le second disparaîtrait sans
  // bruit — la seule erreur qui ne se rattrape pas.
  const camille = billetOuigo({ reference: 'ZH8PL4', passager: 'CAMILLE MARCHAND - 1990' });
  const dominique = billetOuigo({ reference: 'ZH8PL4', passager: 'DOMINIQUE MARCHAND - 1988' });
  assert.notEqual(ouigo.remoteIdPour(camille), ouigo.remoteIdPour(dominique));
  // Et le nom lui-même ne sort pas dans l'identifiant : il est haché.
  assert.doesNotMatch(ouigo.remoteIdPour(camille), /CAMILLE|MARCHAND/);
});

// ---------------------------------------------------------------------------
// 3. Ce qui ne se lit pas retombe sur l'empreinte — le doublon, jamais la perte
// ---------------------------------------------------------------------------

test('un document sans identité lisible retombe sur l\'empreinte du lot 44', () => {
  const muet = Buffer.from('%PDF-1.4 un document sans dossier ni réservation');
  assert.equal(identite.remoteIdSncfConnect(muet), null);
  assert.equal(identite.remoteIdOuigo(muet), null);
  assert.match(sncf.remoteIdPour(muet), /^sncf-connect-[0-9a-f]{16}$/);
  assert.match(ouigo.remoteIdPour(muet), /^ouigo-[0-9a-f]{16}$/);
});

test('deux dossiers différents dans un même fichier : on ne devine pas, on retombe', () => {
  // Un document composite jamais rencontré (les aller-retour réels portent
  // DEUX FOIS LE MÊME dossier) : rendre l'un des deux codes serait confondre.
  const composite = pdfAvecTexte([
    'Dossier voyage', 'K7M2P9', 'Dossier voyage', 'B4QXZ7',
  ]);
  assert.equal(identite.remoteIdSncfConnect(composite), null);
});

test('un billet qui nomme plusieurs passagers ne choisit pas à leur place', () => {
  const ambigu = pdfAvecTexte([
    'Votre numéro de réservation est :', 'ZH8PL4',
    'CAMILLE MARCHAND - 1990', 'DOMINIQUE MARCHAND - 1988',
  ]);
  assert.deepEqual(
    identite.identiteOuigo(ambigu),
    { reservation: 'ZH8PL4', passager: null }
  );
  assert.equal(identite.remoteIdOuigo(ambigu), null);
});

test('le suffixe du nom de fichier dit l\'identité métier, et rien d\'autre', () => {
  assert.equal(sncf.suffixeDeFichier('sncf-connect-K7M2P9'), 'K7M2P9');
  assert.equal(ouigo.suffixeDeFichier('ouigo-V3TERQ-1a2b3c4d'), 'V3TERQ-1a2b3c4d');
  // Le repli : la fin de l'empreinte, la forme des noms déjà déposés.
  assert.equal(sncf.suffixeDeFichier('0123456789abcdef'), '89abcdef');
});

// ---------------------------------------------------------------------------
// 4. En base : deux passages, une seule ligne — même quand la taille change
// ---------------------------------------------------------------------------

let utilisateur;
let racine;

test.before(async () => {
  await helpers.setup();
  utilisateur = await helpers.createUser({ username: 'camille', plainPassword: 'MotDePasse1' });
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot46-'));
});

test.after(() => {
  fs.rmSync(racine, { recursive: true, force: true });
  helpers.teardown();
});

/**
 * Rejoue ce que fait le socle autour d'un connecteur : les identifiants déjà
 * en base (`knownRemoteIds`, voir scheduler.js), le filtre du connecteur, puis
 * l'écriture de ce qui reste.
 */
function passage(connecteur, connectorId, documents) {
  const base = helpers.db.get();
  const connus = new Set(
    base
      .prepare(
        `SELECT remote_id FROM invoices
          WHERE user_id = ? AND connector_id = ? AND remote_id IS NOT NULL`
      )
      .all(utilisateur.id, connectorId)
      .map((r) => r.remote_id)
  );
  const inserer = base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                           size_bytes, issued_on, destinations)
     VALUES (?, ?, ?, ?, 'defaut', ?, NULL, '{}')`
  );
  let ecrites = 0;
  for (const octets of documents) {
    const remoteId = connecteur.remoteIdPour(octets);
    if (connus.has(remoteId)) continue;
    connus.add(remoteId);
    inserer.run(
      utilisateur.id, connectorId,
      `${connectorId}_${connecteur.suffixeDeFichier(remoteId)}.pdf`, remoteId, octets.length
    );
    ecrites++;
  }
  return ecrites;
}

const compter = (connectorId) =>
  helpers.db
    .get()
    .prepare('SELECT COUNT(*) c FROM invoices WHERE user_id = ? AND connector_id = ?')
    .get(utilisateur.id, connectorId).c;

test('SNCF : deux passages sur le même voyage n\'écrivent qu\'une ligne, le PDF eût-il changé de taille', () => {
  assert.equal(passage(sncf, 'sncf-connect', [SNCF_PASSAGE_1]), 1);
  // Le second passage reçoit le document REGÉNÉRÉ : autre date d'édition dans
  // la page, autre taille. C'est ce passage-là qui, le 22/08/2026, a redéposé
  // trois justificatifs déjà en base.
  assert.equal(passage(sncf, 'sncf-connect', [SNCF_PASSAGE_2]), 0);
  assert.equal(compter('sncf-connect'), 1);
  // Deux voyages distincts, eux, écrivent bien deux lignes.
  assert.equal(passage(sncf, 'sncf-connect', [SNCF_PASSAGE_2, SNCF_AUTRE]), 1);
  assert.equal(compter('sncf-connect'), 2);
});

test('OUIGO : deux passages sur la même réservation n\'écrivent qu\'une ligne', () => {
  assert.equal(passage(ouigo, 'ouigo', [OUIGO_PASSAGE_1]), 1);
  assert.equal(passage(ouigo, 'ouigo', [OUIGO_PASSAGE_2]), 0);
  assert.equal(compter('ouigo'), 1);
  assert.equal(passage(ouigo, 'ouigo', [OUIGO_PASSAGE_2, OUIGO_AUTRE]), 1);
  assert.equal(compter('ouigo'), 2);
});

// ---------------------------------------------------------------------------
// 5. La migration 42 — les lignes existantes reprennent l'identité métier
// ---------------------------------------------------------------------------

test('la migration ancre les lignes existantes sur le voyage, et pose la date SNCF', () => {
  const base = helpers.db.get();
  const cheminSncf = path.join(racine, 'justificatif.pdf');
  const cheminOuigo = path.join(racine, 'billet.pdf');
  fs.writeFileSync(cheminSncf, SNCF_PASSAGE_1);
  fs.writeFileSync(cheminOuigo, OUIGO_PASSAGE_1);

  const inserer = base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                           size_bytes, issued_on, destinations)
     VALUES (?, ?, ?, ?, 'defaut', ?, NULL, ?)`
  );
  // Les lignes telles que le lot 45 les écrivait : l'empreinte normalisée.
  const idSncf = inserer.run(
    utilisateur.id, 'sncf-connect', 'sncf_date-inconnue_ancien.pdf',
    empreinte.empreinteStable(SNCF_PASSAGE_1, { prefixe: 'sncf-connect' }),
    SNCF_PASSAGE_1.length,
    JSON.stringify({ local: { state: 'ok', ok: true, path: cheminSncf } })
  ).lastInsertRowid;
  const idOuigo = inserer.run(
    utilisateur.id, 'ouigo', 'ouigo_ancien.pdf',
    empreinte.empreinteStable(OUIGO_PASSAGE_1, { prefixe: 'ouigo' }),
    OUIGO_PASSAGE_1.length,
    JSON.stringify({ local: { state: 'ok', ok: true, path: cheminOuigo } })
  ).lastInsertRowid;

  const reprises = migrations.reprendreIdentitesMetier(base);
  assert.ok(reprises >= 2);

  const sncfApres = base
    .prepare('SELECT remote_id, issued_on, filename FROM invoices WHERE id = ?')
    .get(idSncf);
  // L'identifiant inscrit est EXACTEMENT celui que rendra le prochain
  // téléchargement du même justificatif — regénéré, sous une autre taille.
  assert.equal(sncfApres.remote_id, sncf.remoteIdPour(SNCF_PASSAGE_2));
  // La date de commande, imprimée sur le document, remplit issued_on…
  assert.equal(sncfApres.issued_on, '2026-07-27');
  // …mais le fichier déjà déposé garde son nom : le renommer désaccorderait
  // la base des destinations qui le portent.
  assert.equal(sncfApres.filename, 'sncf_date-inconnue_ancien.pdf');

  const ouigoApres = base
    .prepare('SELECT remote_id, issued_on FROM invoices WHERE id = ?')
    .get(idOuigo);
  assert.equal(ouigoApres.remote_id, ouigo.remoteIdPour(OUIGO_PASSAGE_2));
  assert.equal(ouigoApres.issued_on, null);

  // Rejouée, elle ne change plus rien : une migration se rejoue sans dégât.
  assert.equal(migrations.reprendreIdentitesMetier(base), 0);
});

test('la migration laisse intactes les lignes dont le document est hors de portée', () => {
  const base = helpers.db.get();
  const cheminMuet = path.join(racine, 'muet.pdf');
  fs.writeFileSync(cheminMuet, Buffer.from('%PDF-1.4 sans dossier lisible'));

  const inserer = base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                           size_bytes, issued_on, destinations)
     VALUES (?, ?, ?, ?, 'defaut', 100, NULL, ?)`
  );
  // Un fichier parti au cloud : aucun chemin local, rien à relire.
  const auCloud = inserer.run(
    utilisateur.id, 'sncf-connect', 'parti-au-cloud.pdf', 'sncf-connect-0123456789abcdef',
    JSON.stringify({ 'cloud-x': { state: 'ok', ok: true, path: 'crabe:crabe/x.pdf' } })
  ).lastInsertRowid;
  // Un document relisible mais sans identité : l'empreinte reste un
  // identifiant valide, simplement moins durable — on ne devine pas.
  const muet = inserer.run(
    utilisateur.id, 'sncf-connect', 'muet.pdf', 'sncf-connect-fedcba9876543210',
    JSON.stringify({ local: { state: 'ok', ok: true, path: cheminMuet } })
  ).lastInsertRowid;

  migrations.reprendreIdentitesMetier(base);
  assert.equal(
    base.prepare('SELECT remote_id FROM invoices WHERE id = ?').get(auCloud).remote_id,
    'sncf-connect-0123456789abcdef'
  );
  assert.equal(
    base.prepare('SELECT remote_id FROM invoices WHERE id = ?').get(muet).remote_id,
    'sncf-connect-fedcba9876543210'
  );
});
