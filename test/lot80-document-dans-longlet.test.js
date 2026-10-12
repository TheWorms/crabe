'use strict';

/**
 * Lot 80 — le document se prend dans l'onglet, jamais en redemandant l'adresse.
 *
 * ─── Ce qui a été mesuré, et qui justifie ces verrous ────────────────────────
 *
 * Le 10/09/2026, Auto-Doc et Coyote ont vu 56 documents et n'en ont déposé
 * AUCUN. Une seule cause, cinquante-six fois : le connecteur cliquait
 * « Télécharger », un onglet s'ouvrait — le navigateur TENAIT donc le document,
 * avec sa session et son empreinte — puis le code relisait l'adresse de cet
 * onglet par `context.request.get()`, qui sort de la pile réseau de Chromium.
 * Cloudflare a répondu 403. Le document n'était pas hors de portée : il était
 * là, et il a été lâché pour aller le rechercher par une porte fermée.
 *
 * Et l'exécution s'affichait « Succès — Aucune nouvelle facture ».
 *
 * Ces tests verrouillent les deux corrections :
 *
 *   1. le flux se relit DANS le navigateur (`fetch` évalué dans la page), et la
 *      sortie hors navigateur ne sert plus qu'en dernier recours — la MORSURE
 *      du verrou est le compteur `sortiesHorsNavigateur`, qui doit rester à
 *      zéro tant que la page rend le document ;
 *   2. un échec complet ne se dit pas « Succès », et trois échecs identiques
 *      d'affilée arrêtent le parcours au lieu de le répéter cinquante fois.
 *
 * ⚠ Toutes les valeurs (numéros, adresses, jetons) sont INVENTÉES (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ongletPdf = require('../server/connectors/onglet-pdf');
const clicDocument = require('../server/connectors/clic-document');
const serieEchecs = require('../server/connectors/serie-echecs');
const profilMarchand = require('../server/connectors/profil-marchand');
const coyote = require('../server/connectors/available/coyote/connector');
const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');

// ---------------------------------------------------------------------------
// Un vrai PDF, assez gros pour franchir plusieurs tranches de base64
// ---------------------------------------------------------------------------

/**
 * 40 000 octets : `LIRE_LE_FLUX` encode par tranches de 32 768 (au-delà,
 * `String.fromCharCode` fait déborder la pile d'arguments). Un document plus
 * petit ne passerait jamais la deuxième tranche, et la boucle ne serait pas
 * éprouvée — c'est précisément là qu'une troncature silencieuse se logerait.
 */
const PDF_LONG = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'latin1'),
  Buffer.alloc(40_000 - 9 - 6, 0x41),
  Buffer.from('%%EOF\n', 'latin1'),
]);
const PAGE_403 = Buffer.from(
  '<!DOCTYPE html><html><head><title>Attention Required</title></head>'
  + '<body>Sorry, you have been blocked</body></html>',
  'latin1'
);

// ---------------------------------------------------------------------------
// Un serveur local : le `fetch` du test part pour de vrai
// ---------------------------------------------------------------------------

let serveur;
let base;
/** Ce que le serveur sert au prochain appel, et combien d'appels il a reçus. */
const servi = { statut: 200, corps: PDF_LONG, type: 'application/pdf', appels: 0 };

test.before(async () => {
  serveur = http.createServer((req, res) => {
    servi.appels += 1;
    res.writeHead(servi.statut, { 'content-type': servi.type });
    res.end(servi.corps);
  });
  await new Promise((resoudre) => serveur.listen(0, '127.0.0.1', resoudre));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await new Promise((resoudre) => serveur.close(resoudre));
});

/**
 * Un onglet simulé. Son `evaluate` exécute POUR DE VRAI la fonction du socle
 * quand elle reçoit un argument (c'est `LIRE_LE_FLUX`, et `fetch`/`btoa`
 * existent dans Node) ; sans argument, c'est la lecture de `document.contentType`
 * que le simulacre rend lui-même.
 */
function ongletSimule({
  type = 'application/pdf',
  adresse = '/facture.pdf',
  fluxImpossible = false,
  reponseHorsNavigateur = null,
} = {}) {
  const onglet = {
    ferme: false,
    sortiesHorsNavigateur: 0,
    waitForLoadState: async () => {},
    url: () => `${base}${adresse}`,
    evaluate: async (fn, arg) => {
      if (arg === undefined) return type;
      if (fluxImpossible) throw new Error('Execution context was destroyed');
      return fn(arg);
    },
    context: () => ({
      request: {
        get: async () => {
          onglet.sortiesHorsNavigateur += 1;
          if (!reponseHorsNavigateur) return { ok: () => false, status: () => 403 };
          return reponseHorsNavigateur;
        },
      },
    }),
    close: async () => { onglet.ferme = true; },
  };
  return onglet;
}

/** Une page ordinaire : elle sait évaluer le flux, elle n'est pas un onglet. */
function pageRelaisSimulee({ fluxImpossible = false } = {}) {
  return {
    evaluate: async (fn, arg) => {
      if (arg === undefined) return '';
      if (fluxImpossible) throw new Error('page fermée');
      return fn(arg);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Le flux relu DANS le navigateur — la correction, et sa morsure
// ---------------------------------------------------------------------------

test('le flux relu dans la page rend le document entier, tranches comprises', async () => {
  servi.statut = 200; servi.corps = PDF_LONG; servi.type = 'application/pdf';
  const page = pageRelaisSimulee();
  const lu = await ongletPdf.fluxDeLaPage(page, `${base}/facture.pdf`);
  assert.equal(lu.ok, true, lu.grief);
  assert.equal(lu.buffer.length, PDF_LONG.length, 'aucune troncature au passage du pont');
  assert.deepEqual(lu.buffer, PDF_LONG, 'octet pour octet, y compris après la 2e tranche');
});

test('un refus HTTP est rapporté avec son code, jamais déposé', async () => {
  servi.statut = 403; servi.corps = PAGE_403; servi.type = 'text/html';
  const lu = await ongletPdf.fluxDeLaPage(pageRelaisSimulee(), `${base}/facture.pdf`);
  assert.equal(lu.ok, false);
  assert.match(lu.grief, /HTTP #/, 'le code est dit, chiffres masqués pour le journal');
});

test('une page d\'erreur servie en 200 n\'est PAS prise pour un PDF', async () => {
  // Le pire résultat possible serait silencieux : un HTML de blocage déposé
  // sous un nom en .pdf. C'est l'en-tête qui tranche, pas le code HTTP.
  servi.statut = 200; servi.corps = PAGE_403; servi.type = 'application/pdf';
  const lu = await ongletPdf.fluxDeLaPage(pageRelaisSimulee(), `${base}/facture.pdf`);
  assert.equal(lu.ok, false);
  assert.match(lu.grief, /ne sont pas un PDF/);
});

test('un transfert tronqué est refusé — la longueur annoncée est revérifiée', async () => {
  // La page annonce 40 000 octets et n'en rend que quelques-uns : c'est le
  // symptôme d'un pont qui coupe, et il ne doit jamais passer pour un document.
  const pageMenteuse = {
    evaluate: async () => ({ base64: PDF_LONG.subarray(0, 500).toString('base64'), octets: 40_000 }),
  };
  const lu = await ongletPdf.fluxDeLaPage(pageMenteuse, `${base}/facture.pdf`);
  assert.equal(lu.ok, false);
  assert.match(lu.grief, /transfert tronqué/);
});

test('un fichier réduit à son en-tête est refusé — la signature ne suffit pas', async () => {
  const juge = ongletPdf.jugerLesOctets(Buffer.from('%PDF-', 'latin1'));
  assert.equal(juge.ok, false);
  assert.match(juge.grief, /en-tête sans document/);
});

test('MORSURE — tant que la page rend le document, on NE SORT PAS du navigateur', async () => {
  // C'est le verrou du lot 80. Réintroduire la relecture d'adresse en tête de
  // `lireDocumentDeLOnglet` ferait passer ce compteur à 1 et tomber ce test.
  servi.statut = 200; servi.corps = PDF_LONG; servi.type = 'application/pdf';
  const onglet = ongletSimule();
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, null, {
    pageRelais: pageRelaisSimulee(),
  });
  assert.equal(lu.ok, true, lu.grief);
  assert.deepEqual(lu.buffer, PDF_LONG);
  assert.equal(onglet.sortiesHorsNavigateur, 0, 'aucune requête hors du navigateur');
  assert.match(lu.voie, /flux relu dans l'onglet/);
  assert.equal(onglet.ferme, true, 'l\'onglet est refermé derrière soi');
});

test('quand l\'onglet ne peut pas évaluer, c\'est la page qui a cliqué qui relit', async () => {
  servi.statut = 200; servi.corps = PDF_LONG; servi.type = 'application/pdf';
  const onglet = ongletSimule({ fluxImpossible: true });
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, null, {
    pageRelais: pageRelaisSimulee(),
  });
  assert.equal(lu.ok, true, lu.grief);
  assert.equal(onglet.sortiesHorsNavigateur, 0);
  assert.match(lu.voie, /flux relu dans la page qui a cliqué/);
});

test('la réponse déjà reçue passe AVANT tout : aucune requête n\'est refaite', async () => {
  servi.appels = 0;
  const onglet = ongletSimule();
  const lu = await ongletPdf.lireDocumentDeLOnglet(
    onglet,
    { body: async () => PDF_LONG, url: () => `${base}/facture.pdf` },
    { pageRelais: pageRelaisSimulee() }
  );
  assert.equal(lu.ok, true, lu.grief);
  assert.match(lu.voie, /réponse déjà reçue/);
  assert.equal(servi.appels, 0, 'le document tenu n\'est jamais redemandé');
  assert.equal(onglet.sortiesHorsNavigateur, 0);
});

test('la sortie hors navigateur reste le DERNIER recours, et elle sert encore', async () => {
  // Un onglet d'un autre domaine que la page (OUIGO sert ses billets depuis
  // pasngr.com) : le `fetch` de la page s'y heurterait à la barrière d'origine.
  // Cette voie doit donc rester ouverte — mais après les autres.
  servi.statut = 500; servi.corps = PAGE_403; servi.type = 'text/html';
  const onglet = ongletSimule({
    fluxImpossible: true,
    reponseHorsNavigateur: { ok: () => true, status: () => 200, body: async () => PDF_LONG },
  });
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, null, { pageRelais: null });
  assert.equal(lu.ok, true, lu.grief);
  assert.equal(lu.voie, 'relecture hors navigateur');
  assert.equal(onglet.sortiesHorsNavigateur, 1);
});

test('quand tout échoue, le grief dit ce que CHAQUE voie a rendu', async () => {
  servi.statut = 403; servi.corps = PAGE_403; servi.type = 'text/html';
  const onglet = ongletSimule();
  const lu = await ongletPdf.lireDocumentDeLOnglet(onglet, null, {
    pageRelais: pageRelaisSimulee(),
  });
  assert.equal(lu.ok, false);
  assert.match(lu.grief, /le flux relu dans l'onglet/);
  assert.match(lu.grief, /le flux relu dans la page qui a cliqué/);
  assert.match(lu.grief, /la relecture de l'adresse de l'onglet/);
});

test('clic-document passe la page qui a cliqué à l\'onglet, et remonte la voie', async () => {
  servi.statut = 200; servi.corps = PDF_LONG; servi.type = 'application/pdf';
  const onglet = ongletSimule();
  const page = {
    on: () => {}, off: () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (arg === undefined) return '';
      return fn(arg);
    },
  };
  const gestionnaires = {};
  const contexte = {
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: () => {},
  };
  const resultat = await clicDocument.documentDuClic(page, contexte, async () => {
    for (const cb of gestionnaires.page || []) cb(onglet);
    return true;
  });
  assert.equal(resultat.ok, true, resultat.grief);
  assert.deepEqual(resultat.buffer, PDF_LONG);
  assert.match(resultat.voie, /nouvel onglet — flux relu/);
  assert.equal(onglet.sortiesHorsNavigateur, 0);
});

// ---------------------------------------------------------------------------
// 2. La sortie anticipée — trois fois la même cause suffisent
// ---------------------------------------------------------------------------

test('trois échecs de même cause arrêtent le parcours — deux ne suffisent pas', async () => {
  const serie = serieEchecs.suiteDEchecs();
  assert.equal(serie.echec('un onglet s\'est ouvert mais HTTP 403 (12 octets)'), false);
  assert.equal(serie.echec('un onglet s\'est ouvert mais HTTP 403 (98 octets)'), false);
  assert.equal(serie.echec('un onglet s\'est ouvert mais HTTP 403 (7 octets)'), true,
    'les chiffres masqués, les trois griefs sont la MÊME cause');
});

test('des causes différentes ne font pas une série', async () => {
  const serie = serieEchecs.suiteDEchecs();
  assert.equal(serie.echec('le déclencheur n\'était plus dans la page'), false);
  assert.equal(serie.echec('un onglet s\'est ouvert mais HTTP 403'), false);
  assert.equal(serie.echec('la page de l\'onglet sert « text/html »'), false);
});

test('un document obtenu désarme le renoncement pour de bon', async () => {
  // On ne renonce qu'à ce qui n'a JAMAIS rien donné : un parcours qui rapporte
  // ne doit pas s'interrompre parce que trois documents d'affilée manquent.
  const serie = serieEchecs.suiteDEchecs();
  serie.reussite();
  assert.equal(serie.echec('même cause'), false);
  assert.equal(serie.echec('même cause'), false);
  assert.equal(serie.echec('même cause'), false);
});

test('Coyote s\'arrête après trois échecs au lieu d\'en tenter dix', async () => {
  const lignes = Array.from({ length: 10 }, (_, i) => ({
    numero: `FR000000${i}`,
    dateTexte: '12/03/2026',
  }));
  const journal = [];
  let tentatives = 0;

  const originalProfil = profilMarchand.surLeProfil;
  const originalJuger = profilMarchand.jugerLaListe;
  const originalClic = clicDocument.documentDuClic;
  profilMarchand.surLeProfil = async (options, fn) => fn({ evaluate: async (f, arg) => {
    if (f === coyote.EXTRAIRE_LIGNES) return lignes;
    return arg === undefined ? [] : 0;
  }, waitForTimeout: async () => {} }, {});
  profilMarchand.jugerLaListe = async () => ({
    vue: {}, etat: { servie: true, raison: 'espace client servi', reperes: lignes.length },
  });
  clicDocument.documentDuClic = async () => {
    tentatives += 1;
    return { ok: false, grief: `un onglet s'est ouvert mais HTTP 403 (${tentatives} octets)` };
  };

  try {
    const rendu = await coyote.fetchInvoices({}, { log: (l) => journal.push(l) });
    assert.equal(tentatives, 3, '3 tentatives, pas 10 — le parcours s\'est arrêté');
    assert.equal(rendu.invoices.length, 0);
    assert.equal(rendu.manquees, 3, 'ce qui a été TENTÉ et manqué, pas ce qui était listé');
    assert.match(rendu.renoncement, /arrêté après 3 tentatives/);
    assert.doesNotMatch(rendu.renoncement, /HTTP/, 'le grief technique reste au journal');
    assert.match(journal.join('\n'), /HTTP 403/, '…et il y est bien');
  } finally {
    profilMarchand.surLeProfil = originalProfil;
    profilMarchand.jugerLaListe = originalJuger;
    clicDocument.documentDuClic = originalClic;
  }
});

// ---------------------------------------------------------------------------
// 3. Trois situations, trois phrases — « Succès » ne recouvre plus un échec
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot80';
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) {
    ctx.preuveDeListe?.({ session: 'marqueur vu', liste: 'liste factice', elements: 3 });
    const b = globalThis.__lot80 || {};
    return {
      invoices: (b.deposees || []).map((n, i) => ({
        remoteId: 'sonde-' + n + '-' + i,
        filename: 'sonde-2026-09-' + n + '-' + i + '.pdf',
        issuedOn: '2026-09-01',
        buffer: Buffer.from('%PDF-1.4\\ncontenu de sonde\\n%%EOF\\n', 'latin1'),
      })),
      manquees: b.manquees,
      renoncement: b.renoncement,
    };
  },
};
`;

const MANIFESTE_SONDE = {
  id: ID_SONDE,
  name: 'Sonde lot 80',
  category: 'energie',
  color: '#123456',
  letters: 'S8',
  description: 'Sonde de test du lot 80 : les trois situations d\'une récupération.',
  fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
  permissions: [
    {
      key: 'factures',
      scope: 'read-write',
      description: 'Sonde de test : aucune facture réelle n\'est touchée.',
    },
  ],
};

let dossier;
let user;

test.before(async () => {
  await helpers.setup();
  user = await helpers.createUser({ username: 'lot80', role: 'admin' });
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot80-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify(MANIFESTE_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });
});

test.after(() => {
  fs.rmSync(dossier, { recursive: true, force: true });
  delete globalThis.__lot80;
  registry.load();
  helpers.teardown();
});

test('RIEN DE NOUVEAU : sans manquée, la phrase d\'avant est inchangée', async () => {
  globalThis.__lot80 = { deposees: [], manquees: 0 };
  const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Aucune nouvelle facture');
});

test('ÉCHEC : tout tenté, rien obtenu — ce n\'est PAS « Aucune nouvelle facture »', async () => {
  globalThis.__lot80 = { deposees: [], manquees: 55 };
  const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(r.ok, false, 'un échec complet ne se dit pas « Succès »');
  assert.doesNotMatch(r.message, /Aucune nouvelle facture/);
  assert.match(r.message, /Aucun document n'a pu être récupéré/);
  assert.match(r.message, /55 vous étaient proposés/);
});

test('ÉCHEC : la fiche passe en erreur, et le journal garde l\'exécution ratée', async () => {
  globalThis.__lot80 = { deposees: [], manquees: 4 };
  await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  const db = require('../server/db/db');
  const ligne = db.get()
    .prepare('SELECT success, invoice_count, message FROM run_logs WHERE connector_id = ? ORDER BY id DESC LIMIT 1')
    .get(ID_SONDE);
  assert.equal(ligne.success, 0);
  assert.equal(ligne.invoice_count, 0);
  assert.match(ligne.message, /Aucun document n'a pu être récupéré/);
  const install = db.get()
    .prepare('SELECT status FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(user.id, ID_SONDE);
  assert.equal(install.status, 'error', 'la fiche dit qu\'il y a quelque chose à regarder');
});

test('PARTIEL : ce qui est entré se dit, ce qui a manqué aussi', async () => {
  globalThis.__lot80 = { deposees: ['a', 'b'], manquees: 3 };
  const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(r.ok, true, 'des documents sont bien arrivés : c\'est un succès');
  assert.match(r.message, /2 factures récupérées, 3 non obtenues/);
  assert.match(r.message, /le prochain passage les réessaiera/);
});

test('le renoncement est dit à l\'écran, sans jargon', async () => {
  globalThis.__lot80 = {
    deposees: [],
    manquees: 3,
    renoncement: 'Le parcours s\'est arrêté après 3 tentatives infructueuses de suite, toutes '
      + 'bloquées de la même façon : les documents suivants n\'ont pas été tentés, et le '
      + 'prochain passage reprendra depuis le début.',
  };
  const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(r.ok, false);
  assert.match(r.message, /arrêté après 3 tentatives infructueuses/);
});

test('un connecteur qui ne compte rien garde EXACTEMENT le comportement d\'avant', async () => {
  // Les 55 autres connecteurs ne remontent pas `manquees` : leur message et
  // leur statut ne doivent pas bouger d'un caractère.
  globalThis.__lot80 = { deposees: ['seule'] };
  const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
  assert.equal(r.ok, true);
  assert.equal(r.message, '1 facture récupérée');
});
