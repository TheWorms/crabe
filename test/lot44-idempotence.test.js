'use strict';

/**
 * Lot 44 — un document récupéré deux fois n'écrit qu'une ligne (SNCF, OUIGO).
 *
 * ─── Le défaut que ces tests figent ──────────────────────────────────────────
 *
 * Deux passages du connecteur SNCF Connect, le 19/08/2026 à 23:28 et le
 * 20/08/2026 à 00:13, ont écrit **6 lignes pour 3 documents**, et déposé six
 * fichiers dans chacune des trois destinations. L'identifiant distant était le
 * sha256 des octets reçus, et SNCF ne sert pas un fichier archivé : il
 * REGÉNÈRE le justificatif à chaque téléchargement.
 *
 * Le test qui existait alors disait pourtant l'identifiant « stable pour un
 * même document » — parce qu'il le comparait sur DEUX FOIS LES MÊMES OCTETS.
 * Un test qui ne rejoue pas la génération ne mesure rien : ceux-ci rejouent la
 * génération.
 *
 * ─── Ce qui a été mesuré sur les fichiers réels (20/08/2026) ─────────────────
 *
 * Les six PDF ont été relus en production et comparés octet à octet, deux par
 * deux, par taille (24950, 24935, 24953 — les paires). Résultat pour la paire
 * de 24950 octets : **68 octets divergent sur 24950** (0,27 %), en 12 plages,
 * qui tombent toutes dans trois champs et trois seulement —
 * `/CreationDate(D:…)`, `<xmp:CreateDate>…</xmp:CreateDate>` et le
 * `/ID [<…><…>]` du flux XRef. Tout le reste, contenu et flux compressés
 * compris, est identique. Après normalisation, les deux versions de chacune
 * des trois paires sont identiques OCTET À OCTET (24780/24780, 24765/24765,
 * 24783/24783), et les trois documents distincts gardent trois empreintes
 * distinctes.
 *
 * Les fixtures ci-dessous ne contiennent aucune donnée de voyage : elles
 * rejouent la MÉCANIQUE mesurée — les trois champs volatils, dans leur syntaxe
 * réelle, autour d'un corps neutre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const helpers = require('./helpers');
const empreinte = require('../server/connectors/empreinte-document');
const sncf = require('../server/connectors/available/sncf-connect/connector');
const ouigo = require('../server/connectors/available/ouigo/connector');
const migrations = require('../server/db/migrations');

// ---------------------------------------------------------------------------
// Les fixtures : un même document, regénéré
// ---------------------------------------------------------------------------

/**
 * Un PDF de la forme mesurée : un corps qui ne bouge pas, et l'enveloppe datée
 * que le générateur refait à chaque exécution.
 *
 * Le corps est rembourré jusqu'à la taille des justificatifs réels (~25 ko).
 * Ce n'est pas un détail de confort : le garde-fou de `PART_VOLATILE_MAX`
 * annule la normalisation quand les champs volatils pèsent trop lourd dans le
 * document. Sur un PDF jouet de 600 octets, les 167 octets d'enveloppe font
 * 28 % du fichier et le garde-fou se déclenche — sur les 24950 octets réels,
 * ils en font 0,68 %. Une fixture qui ne pèse pas ce que pèse la vraie mesure
 * ne teste pas la vraie situation.
 *
 * @param {string} corps ce qui distingue un document d'un autre
 * @param {{date: string, xmp: string, id: string}} generation ce que le
 *   générateur repose à chaque passage
 */
function pdfGenere(corps, generation) {
  const remplissage = `\n% ${'contenu du justificatif '.repeat(20)}`.repeat(50);
  return Buffer.from(
    '%PDF-1.4\n'
      + '1 0 obj\n<</Type/Catalog>>\nendobj\n'
      + `2 0 obj\n<</Contents (${corps})>>${remplissage}\nendobj\n`
      + '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
      + '  <rdf:Description>\n'
      + '    <xmp:CreatorTool>JasperReports Library version 7.0.7-072738a8</xmp:CreatorTool>\n'
      + `    <xmp:CreateDate>${generation.xmp}</xmp:CreateDate>\n`
      + '    <pdf:Producer>OpenPDF 1.3.43.jaspersoft.1</pdf:Producer>\n'
      + '  </rdf:Description>\n'
      + '<?xpacket end="w"?>\n'
      + `trailer\n<</CreationDate(D:${generation.date})/Producer(OpenPDF 1.3.43.jaspersoft.1)`
      + `/ID [<${generation.id}><${generation.id}>]/Root 1 0 R/Size 3>>\n`
      + 'startxref\n0\n%%EOF\n',
    'latin1'
  );
}

/** Les deux générations MESURÉES, dans leur syntaxe exacte. */
const GENERATION_1 = {
  date: "20260820012437+02'00'",
  xmp: '2026-08-20T01:24:37+02:00',
  id: '9bbdc98ea323a5780381197368eefc5e',
};
const GENERATION_2 = {
  date: "20260820020912+02'00'",
  xmp: '2026-08-20T02:09:12+02:00',
  id: '8cb81b7e90b96e7c6aeb9b0dcc4da4a0',
};

const VOYAGE_A = 'Paris Montparnasse - Rennes, voiture 12, place 34';
const VOYAGE_B = 'Rennes - Paris Montparnasse, voiture 4, place 71';

/** Le même justificatif, servi deux fois : deux fichiers, deux md5. */
const A_PASSAGE_1 = pdfGenere(VOYAGE_A, GENERATION_1);
const A_PASSAGE_2 = pdfGenere(VOYAGE_A, GENERATION_2);
/** Un autre justificatif, servi au même moment que le second passage. */
const B_PASSAGE_2 = pdfGenere(VOYAGE_B, GENERATION_2);

// ---------------------------------------------------------------------------
// 1. L'empreinte — stable d'un passage à l'autre, distincte d'un document
//    à l'autre
// ---------------------------------------------------------------------------

test('le défaut est bien là : deux passages ne rendent pas les mêmes octets', () => {
  // Sans quoi les tests suivants ne prouveraient rien : ils vérifieraient
  // qu'un hachage est stable sur des octets identiques — l'erreur du lot 43.
  assert.notEqual(A_PASSAGE_1.toString('latin1'), A_PASSAGE_2.toString('latin1'));
  assert.equal(A_PASSAGE_1.length, A_PASSAGE_2.length);
});

test('un justificatif regénéré garde son identifiant distant', () => {
  assert.equal(sncf.remoteIdPour(A_PASSAGE_1), sncf.remoteIdPour(A_PASSAGE_2));
  assert.match(sncf.remoteIdPour(A_PASSAGE_1), /^sncf-connect-[0-9a-f]{16}$/);
});

test('deux justificatifs différents ne se confondent pas', () => {
  assert.notEqual(sncf.remoteIdPour(A_PASSAGE_2), sncf.remoteIdPour(B_PASSAGE_2));
});

test('normalisé, un document regénéré est identique octet à octet', () => {
  const un = empreinte.normaliserPdf(A_PASSAGE_1);
  const deux = empreinte.normaliserPdf(A_PASSAGE_2);
  assert.equal(un.normalise, true);
  assert.equal(Buffer.compare(un.octets, deux.octets), 0);
  // Ce qui est retiré est l'enveloppe, pas le document : le corps survit.
  assert.match(un.octets.toString('latin1'), /Paris Montparnasse - Rennes/);
  assert.match(un.octets.toString('latin1'), /OpenPDF 1\.3\.43\.jaspersoft\.1/);
  // …et il en reste bien moins que le plafond de sécurité.
  assert.ok(un.retire > 0);
  assert.ok(un.retire < A_PASSAGE_1.length * empreinte.PART_VOLATILE_MAX);
});

test('ce qui n\'est pas un PDF n\'est pas normalisé, et garde son empreinte', () => {
  const pasUnPdf = Buffer.from('/CreationDate(D:20260820012437+02\'00\') mais pas un PDF');
  const vue = empreinte.normaliserPdf(pasUnPdf);
  assert.equal(vue.normalise, false);
  assert.equal(Buffer.compare(vue.octets, pasUnPdf), 0);
});

test('une normalisation qui retirerait trop s\'annule au lieu de confondre', () => {
  // Un document minuscule presque entièrement fait de champs volatils : le
  // retrait dépasse le plafond, on repart des octets bruts. C'est le garde-fou
  // contre le seul défaut qui ne se rattrape pas — deux documents différents
  // ramenés à la même empreinte, donc une facture qui disparaît sans bruit.
  const presqueVide = Buffer.from(
    `%PDF-\n/ID [<${GENERATION_1.id}><${GENERATION_1.id}>]\n`, 'latin1'
  );
  const vue = empreinte.normaliserPdf(presqueVide);
  assert.equal(vue.normalise, false);
  assert.equal(vue.retire, 0);
  assert.equal(Buffer.compare(vue.octets, presqueVide), 0);
});

// ---------------------------------------------------------------------------
// 2. En base : deux passages, une seule ligne
// ---------------------------------------------------------------------------

let utilisateur;
let racine;

test.before(async () => {
  await helpers.setup();
  utilisateur = await helpers.createUser({ username: 'camille', plainPassword: 'MotDePasse1' });
  racine = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot44-'));
});

test.after(() => {
  fs.rmSync(racine, { recursive: true, force: true });
  helpers.teardown();
});

/**
 * Rejoue ce que fait le socle autour du connecteur : il lui donne les
 * identifiants distants DÉJÀ en base (`knownRemoteIds`, voir scheduler.js),
 * le connecteur écarte ce qu'il reconnaît, et ce qui reste est inscrit.
 *
 * @returns {number} le nombre de lignes écrites par ce passage
 */
function passageDuConnecteur(documents) {
  const base = helpers.db.get();
  const connus = new Set(
    base
      .prepare(
        `SELECT remote_id FROM invoices
          WHERE user_id = ? AND connector_id = 'sncf-connect' AND remote_id IS NOT NULL`
      )
      .all(utilisateur.id)
      .map((r) => r.remote_id)
  );

  const inserer = base.prepare(
    `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                           size_bytes, issued_on, destinations)
     VALUES (?, 'sncf-connect', ?, ?, 'defaut', ?, NULL, '{}')`
  );

  let ecrites = 0;
  for (const octets of documents) {
    // Exactement le geste du connecteur : l'empreinte, puis le filtre.
    const remoteId = sncf.remoteIdPour(octets);
    if (connus.has(remoteId)) continue;
    connus.add(remoteId);
    inserer.run(
      utilisateur.id,
      `sncf-connect_justificatif-voyage_date-inconnue_${remoteId.slice(-8)}.pdf`,
      remoteId,
      octets.length
    );
    ecrites++;
  }
  return ecrites;
}

const compterEnBase = () =>
  helpers.db
    .get()
    .prepare(
      "SELECT COUNT(*) c FROM invoices WHERE user_id = ? AND connector_id = 'sncf-connect'"
    )
    .get(utilisateur.id).c;

test('deux passages sur le même justificatif n\'écrivent qu\'une ligne', () => {
  assert.equal(passageDuConnecteur([A_PASSAGE_1]), 1);
  assert.equal(compterEnBase(), 1);

  // Le second passage reçoit le document REGÉNÉRÉ — d'autres octets, d'autres
  // md5. C'est ce passage-là qui, au lot 43, ajoutait une ligne de plus.
  assert.equal(passageDuConnecteur([A_PASSAGE_2]), 0);
  assert.equal(compterEnBase(), 1);
});

test('un second justificatif écrit bien sa propre ligne', () => {
  assert.equal(passageDuConnecteur([A_PASSAGE_2, B_PASSAGE_2]), 1);
  assert.equal(compterEnBase(), 2);

  const identifiants = helpers.db
    .get()
    .prepare(
      "SELECT remote_id FROM invoices WHERE user_id = ? AND connector_id = 'sncf-connect'"
    )
    .all(utilisateur.id)
    .map((r) => r.remote_id);
  assert.equal(new Set(identifiants).size, 2);
});

// ---------------------------------------------------------------------------
// 3. La migration 40 — les lignes déjà en base reprennent la nouvelle empreinte
// ---------------------------------------------------------------------------

test('la migration reprend l\'empreinte depuis le fichier déjà déposé', () => {
  const base = helpers.db.get();
  const chemin = path.join(racine, 'justificatif-ancien.pdf');
  fs.writeFileSync(chemin, A_PASSAGE_1);

  // Une ligne telle que le lot 43 l'écrivait : l'empreinte des octets bruts.
  const ancien = 'sncf-connect-'
    + require('node:crypto').createHash('sha256').update(A_PASSAGE_1).digest('hex').slice(0, 16);
  const id = base
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'sncf-connect', 'ancien.pdf', ?, 'defaut', ?, NULL, ?)`
    )
    .run(
      utilisateur.id, ancien, A_PASSAGE_1.length,
      JSON.stringify({ local: { state: 'ok', ok: true, path: chemin } })
    ).lastInsertRowid;

  const reprises = migrations.reprendreEmpreintesSncf(base);
  assert.ok(reprises >= 1);

  const apres = base.prepare('SELECT remote_id FROM invoices WHERE id = ?').get(id).remote_id;
  assert.notEqual(apres, ancien);
  // Et surtout : l'empreinte inscrite est celle que rendra le PROCHAIN
  // téléchargement du même justificatif, donc la version regénérée.
  assert.equal(apres, sncf.remoteIdPour(A_PASSAGE_2));

  // Rejouée, elle ne change plus rien : une migration se rejoue sans dégât.
  assert.equal(migrations.reprendreEmpreintesSncf(base) === 0, true);
});

test('la migration laisse intacte une ligne dont le fichier est hors de portée', () => {
  const base = helpers.db.get();
  const id = base
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'sncf-connect', 'parti-au-cloud.pdf', 'sncf-connect-0123456789abcdef',
               'defaut', 100, NULL, ?)`
    )
    .run(
      utilisateur.id,
      JSON.stringify({ 'cloud-beb5c888': { state: 'ok', ok: true, path: 'crabe:crabe/x.pdf' } })
    ).lastInsertRowid;

  migrations.reprendreEmpreintesSncf(base);
  assert.equal(
    base.prepare('SELECT remote_id FROM invoices WHERE id = ?').get(id).remote_id,
    'sncf-connect-0123456789abcdef'
  );
});

// ---------------------------------------------------------------------------
// 4. OUIGO — la même leçon, tenue DÈS LA PREMIÈRE ÉCRITURE
// ---------------------------------------------------------------------------

test('deux passages OUIGO sur le même billet n\'écrivent qu\'une ligne', () => {
  // Le connecteur OUIGO a été écrit APRÈS le défaut SNCF, en le sachant : son
  // identifiant distant est idempotent d'emblée, il n'y a pas de migration de
  // rattrapage à écrire. Ce test le vérifie sur le chemin réel — l'empreinte
  // du connecteur, puis le filtre `knownRemoteIds` du socle.
  const base = helpers.db.get();
  const compter = () =>
    base
      .prepare("SELECT COUNT(*) c FROM invoices WHERE user_id = ? AND connector_id = 'ouigo'")
      .get(utilisateur.id).c;

  const passage = (documents) => {
    const connus = new Set(
      base
        .prepare(
          `SELECT remote_id FROM invoices
            WHERE user_id = ? AND connector_id = 'ouigo' AND remote_id IS NOT NULL`
        )
        .all(utilisateur.id)
        .map((r) => r.remote_id)
    );
    const inserer = base.prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, 'ouigo', ?, ?, 'defaut', ?, NULL, '{}')`
    );
    let ecrites = 0;
    for (const octets of documents) {
      const remoteId = ouigo.remoteIdPour(octets);
      if (connus.has(remoteId)) continue;
      connus.add(remoteId);
      inserer.run(utilisateur.id, `ouigo_billet_${remoteId.slice(-8)}.pdf`, remoteId, octets.length);
      ecrites++;
    }
    return ecrites;
  };

  assert.equal(passage([A_PASSAGE_1]), 1);
  assert.equal(compter(), 1);
  // Le billet REGÉNÉRÉ du second passage : d'autres octets, d'autre md5.
  assert.equal(passage([A_PASSAGE_2]), 0);
  assert.equal(compter(), 1);
  // Un second billet, lui, s'écrit.
  assert.equal(passage([A_PASSAGE_2, B_PASSAGE_2]), 1);
  assert.equal(compter(), 2);
});
