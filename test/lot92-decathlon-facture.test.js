'use strict';

/**
 * Lot 92 — Decathlon : la facture se télécharge, et rien d'autre ne se clique.
 *
 * L'utilisateur l'a vu, connecté, le 05/10/2026 : la page de détail d'un achat porte
 * « Télécharger ma facture », qui donne le PDF tout de suite. Le connecteur
 * concluait depuis le 24/08 qu'« aucun document n'est servi directement » — une
 * phrase écrite une fois, jamais relue sur la page.
 *
 * Ces essais tournent au VRAI Chromium sur des pages RECONSTITUÉES
 * (test/lot92-faux-sites.js) : ils prouvent la lecture de la forme décrite,
 * pas le vrai site. Chaque clic est compté par la page elle-même, chaque
 * saisie aussi, et chaque requête d'écriture vers le site est inscrite.
 *
 * ⚠ Toutes les valeurs sont inventées (numéros « ZZ… » et « 0000-… »).
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('../server/connectors/browser-identity');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const decathlon = require('../server/connectors/available/decathlon/connector');
const faux = require('./lot92-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'decathlon', 'connector.js');

/** Les deux achats de la capture : un en ligne, un en magasin. */
function deuxAchats(varianteEnLigne = 'telechargement', varianteMagasin = 'telechargement') {
  return [
    { numero: 'ZZ0TEST0A1', nature: 'oneom', dateAffichee: '12/03/2026', colis: [varianteEnLigne] },
    { numero: '0000-1111', nature: 'store', dateAffichee: '02/02/2026', colis: [varianteMagasin] },
  ];
}

async function passer(achats, ctxExtra = {}) {
  const site = await faux.ouvrirFauxSite('www.decathlon.fr', faux.siteDecathlon(achats));
  const enr = faux.contexteEnregistreur(ctxExtra);
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await faux.surLeFauxProfil(site, () => decathlon.fetchInvoices({}, enr.ctx));
    } catch (err) {
      erreur = err;
    }
    return { resultat, erreur, journal: site.journal, lignes: enr.lignes, preuves: enr.preuves };
  } finally {
    await site.fermer();
  }
}

/** Les clics comptés par la page, ramenés à leur libellé. */
function clicsSur(journal, libelle) {
  return journal.clics.filter((c) => c.toLowerCase() === libelle.toLowerCase()).length;
}

/** Ce qui doit tenir à CHAQUE passage, quoi que la page propose. */
function aucunGesteInterdit(journal) {
  assert.equal(clicsSur(journal, 'Faire un retour'), 0, '« Faire un retour » n\'est jamais touché');
  assert.equal(clicsSur(journal, 'Demander ma facture'), 0, '« Demander ma facture » n\'est jamais touché');
  assert.ok(journal.clics.every((c) => c === 'Télécharger ma facture'),
    `seul « Télécharger ma facture » se clique — clics : ${journal.clics.join(' | ')}`);
  assert.deepEqual(journal.saisies, [], 'aucune saisie, aucun envoi de formulaire');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture vers le site');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D1 — deux achats, deux factures ; le second passage ne reprend rien
// ---------------------------------------------------------------------------

test('D1 — un achat en ligne et un achat en magasin : deux PDF pris, ancrés sur leur numéro, deux noms', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats());
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}`);

  const factures = resultat.invoices;
  assert.equal(factures.length, 2,
    `deux factures attendues, ${factures.length} reçue(s) — message : ${resultat.aucunDocument || resultat.precision || '(aucun)'}\n${lignes.join('\n')}`);
  const parAncre = new Map(factures.map((f) => [f.remoteId, f]));
  assert.ok(parAncre.has('decathlon-ZZ0TEST0A1'), `ancres : ${[...parAncre.keys()].join(', ')}`);
  assert.ok(parAncre.has('decathlon-0000-1111'), `ancres : ${[...parAncre.keys()].join(', ')}`);
  for (const [ancre, f] of parAncre) {
    assert.ok(identity.estPdf(f.buffer), `${ancre} : le document déposé est un PDF`);
    const numero = ancre.replace('decathlon-', '');
    assert.match(f.buffer.toString('latin1'), new RegExp(`facture inventee ${numero}-1`),
      `${ancre} : c'est bien SA facture, pas celle de l'autre achat`);
  }
  assert.notEqual(factures[0].filename, factures[1].filename, 'deux factures, deux noms');
  assert.equal(parAncre.get('decathlon-ZZ0TEST0A1').filename, 'decathlon_2026-03_ZZ0TEST0A1.pdf');
  assert.equal(parAncre.get('decathlon-0000-1111').filename, 'decathlon_2026-02_0000-1111.pdf');
  assert.equal(parAncre.get('decathlon-ZZ0TEST0A1').issuedOn, '2026-03-12');
  assert.equal(parAncre.get('decathlon-0000-1111').issuedOn, '2026-02-02');

  assert.equal(clicsSur(journal, 'Télécharger ma facture'), 2, `clics : ${journal.clics.join(' | ')}`);
  assert.equal(journal.clics.length, 2, `aucun autre clic : ${journal.clics.join(' | ')}`);
  aucunGesteInterdit(journal);
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 2 factures récupérées\./);
  assert.equal(resultat.manquees, 0);
  assert.equal(resultat.precision, undefined, 'rien à ajouter quand tout est entré');
});

test('D1 — second passage : les deux factures sont dans l\'archive, rien n\'est repris ni cliqué', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats(), {
    knownRemoteIds: ['decathlon-ZZ0TEST0A1', 'decathlon-0000-1111'],
  });
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}`);
  assert.deepEqual(resultat.invoices, []);
  assert.equal(journal.clics.length, 0, `aucun clic : ${journal.clics.join(' | ')}`);
  assert.deepEqual(journal.visites.filter((v) => v.includes('orderTracking')), [],
    'un achat déjà archivé n\'est même pas rouvert');
  aucunGesteInterdit(journal);
  assert.equal(resultat.aucunDocument, undefined, '« Aucune nouvelle facture » reste la bonne lecture');
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 2 déjà dans l'archive\./);
});

test('D1 — la facture s\'ouvre dans un onglet : elle est prise là aussi, et l\'onglet refermé', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('onglet', 'onglet'));
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}`);
  assert.equal(resultat.invoices.length, 2, lignes.join('\n'));
  assert.ok(resultat.invoices.every((f) => identity.estPdf(f.buffer)));
  assert.equal(journal.clics.length, 2);
  aucunGesteInterdit(journal);
});

test('D1 — un achat à deux colis : deux factures, deux ancres, deux noms', faux.SANS_NAVIGATEUR, async () => {
  const achats = [{ numero: 'ZZ0TEST0B2', nature: 'oneom', dateAffichee: '20/03/2026', colis: ['telechargement', 'telechargement'] }];
  const { resultat, erreur, journal } = await passer(achats);
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}`);
  const ancres = resultat.invoices.map((f) => f.remoteId).sort();
  assert.deepEqual(ancres, ['decathlon-ZZ0TEST0B2', 'decathlon-ZZ0TEST0B2-colis-2']);
  const noms = new Set(resultat.invoices.map((f) => f.filename));
  assert.equal(noms.size, 2, `deux noms distincts : ${[...noms].join(', ')}`);
  const colis2 = resultat.invoices.find((f) => f.remoteId.endsWith('-colis-2'));
  assert.match(colis2.buffer.toString('latin1'), /facture inventee ZZ0TEST0B2-2/, 'le colis 2 porte SA facture');
  assert.equal(journal.clics.length, 2);
  aucunGesteInterdit(journal);
});

// ---------------------------------------------------------------------------
// D2 — le clic enfermé
// ---------------------------------------------------------------------------

test('D2 — « Demander ma facture » : AUCUN clic (compté), aucune demande envoyée, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('demander', 'telechargement'));
  assert.equal(erreur, null, `le passage ne doit pas échouer : ${erreur?.message}`);
  assert.equal(clicsSur(journal, 'Demander ma facture'), 0, `clics : ${journal.clics.join(' | ')}`);
  assert.deepEqual(journal.ecritures, [], 'la demande n\'est jamais partie (POST compté par le faux site)');
  assert.equal(resultat.invoices.length, 1, 'l\'achat en magasin, lui, donne sa facture');
  assert.equal(resultat.invoices[0].remoteId, 'decathlon-0000-1111');
  assert.match(resultat.precision, /1 achat\(s\) propose\(nt\) « Demander ma facture » au lieu de « Télécharger ma facture »/);
  assert.match(resultat.precision, /crabe ne clique jamais un bouton qui envoie une demande/);
  assert.match(lignes.join('\n'), /pas de « Télécharger ma facture », mais « Demander ma facture » : non cliqué/);
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 1 facture récupérée, 1 avec un autre bouton, non cliqué\./);
  aucunGesteInterdit(journal);
});

test('D2 — un libellé approchant (« … rectificative ») ne se clique pas', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal } = await passer(deuxAchats('voisin', 'voisin'));
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices, []);
  assert.equal(journal.clics.length, 0, `clics : ${journal.clics.join(' | ')}`);
  assert.match(resultat.precision, /« Télécharger ma facture rectificative »/);
  aucunGesteInterdit(journal);
});

test('D2 — le bon bouton ouvre un FORMULAIRE : aucun second clic, aucune saisie, l\'achat suivant n\'est pas touché', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('formulaire', 'telechargement'));
  assert.equal(erreur, null, `le passage rend ce qu'il a vu, il ne lève pas : ${erreur?.message}`);
  assert.equal(journal.clics.length, 1, `UN clic, le premier, et plus rien : ${journal.clics.join(' | ')}`);
  assert.equal(clicsSur(journal, 'Valider'), 0);
  assert.equal(clicsSur(journal, 'Fermer'), 0, 'la boîte n\'est pas refermée en cliquant');
  assert.deepEqual(resultat.invoices, [], 'rien n\'est déposé');
  assert.equal(journal.visites.filter((v) => v.includes('transactionId')).length, 0,
    'le détail de l\'achat suivant n\'est même pas ouvert');
  assert.equal(resultat.manquees, 1);
  assert.match(resultat.renoncement, /Decathlon a affiché un formulaire au lieu de la facture/);
  assert.match(resultat.renoncement, /n'y a rien rempli, n'a plus rien cliqué/);
  assert.match(resultat.renoncement, /Carnet d'adresses/);
  assert.match(resultat.renoncement, /1 autre\(s\) achat\(s\) seront examinés au prochain passage/);
  assert.match(lignes.join('\n'), /Plus aucun clic pendant ce passage/);
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 1 clic sans PDF, 1 non examiné \(clics arrêtés\)\./);
  aucunGesteInterdit(journal);
});

test('D2 — une réponse qui n\'est pas un PDF : rien n\'est déposé, et les clics s\'arrêtent', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('non-pdf', 'telechargement'));
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices, [], 'une page d\'erreur ne se dépose jamais en .pdf');
  assert.equal(journal.clics.length, 1, `clics : ${journal.clics.join(' | ')}`);
  assert.equal(resultat.manquees, 1);
  assert.match(resultat.renoncement, /Decathlon n'a pas remis de PDF/);
  assert.match(lignes.join('\n'), /n'est pas un PDF/);
  aucunGesteInterdit(journal);
});

test('D2 — un bouton grisé ne se clique pas : la facture n\'est pas proposée', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('grise', 'grise'));
  assert.equal(erreur, null);
  assert.deepEqual(resultat.invoices, []);
  assert.equal(journal.clics.length, 0);
  assert.match(lignes.join('\n'), /affiché mais grisé : pas de clic/);
  assert.match(resultat.aucunDocument, /Carnet d'adresses/);
  aucunGesteInterdit(journal);
});

test('D2 — par construction : ce fichier ne porte qu\'UN clic, dans la fonction qui recontrôle le libellé', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const clics = code.match(/\.click\s*\(/g) || [];
  assert.equal(clics.length, 1, `un seul .click( dans le connecteur, trouvé ${clics.length}`);
  const corps = decathlon.LIRE_OU_DECLENCHER.toString();
  assert.match(corps, /cible\.click\(\)/, 'le clic vit dans LIRE_OU_DECLENCHER');
  const garde = corps.indexOf('norm(cible.innerText) !== attendu');
  assert.ok(garde >= 0 && garde < corps.indexOf('cible.click()'), 'le libellé est recontrôlé AVANT le clic');
  assert.match(corps, /\.filter\(\(el\) => visible\(el\) && norm\(el\.innerText\) === attendu\)/,
    'seuls les éléments VISIBLES au libellé EXACT sont candidats');
  for (const geste of [/\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.selectOption\s*\(/,
    /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/,
    /keyboard\./, /mouse\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.accept\s*\(/, /fermerBandeauCookies/]) {
    assert.doesNotMatch(code, geste, `aucun autre geste sur la page (${geste})`);
  }
  assert.equal(decathlon.LIBELLE_TELECHARGER, 'Télécharger ma facture');
});

test('D2 — la garde, au vrai Chromium : seul le libellé exact est déclenché, quel que soit le rang demandé', faux.SANS_NAVIGATEUR, async () => {
  const site = await faux.ouvrirFauxSite('www.decathlon.fr', async () => ({
    html: `<!doctype html><html><body><main>
      <button onclick="1">Demander ma facture</button>
      <button onclick="1">Faire un retour</button>
      <a href="#x">Télécharger ma facture rectificative</a>
      <button onclick="1" style="display:none">Télécharger ma facture</button>
      <div role="button"><button onclick="1">  TÉLÉCHARGER   ma facture </button></div>
      </main></body></html>`,
  }));
  try {
    await site.page.goto('https://www.decathlon.fr/account/orderTracking?orderId=ZZ&type=oneom');
    const lecture = await site.page.evaluate(decathlon.LIRE_OU_DECLENCHER, {
      libelle: decathlon.LIBELLE_TELECHARGER, motifVoisin: 'factur', rang: 0,
    });
    assert.equal(lecture.boutons.length, 1, 'un seul bouton exact et visible (le caché ne compte pas, l\'englobant non plus)');
    for (const rang of [2, 3, 9]) {
      const r = await site.page.evaluate(decathlon.LIRE_OU_DECLENCHER, {
        libelle: decathlon.LIBELLE_TELECHARGER, motifVoisin: 'factur', rang,
      });
      assert.equal(r.clique, false, `rang ${rang} : rien n'existe à ce rang, rien n'est cliqué`);
    }
    assert.equal(site.journal.clics.length, 0);
    const r = await site.page.evaluate(decathlon.LIRE_OU_DECLENCHER, {
      libelle: decathlon.LIBELLE_TELECHARGER, motifVoisin: 'factur', rang: 1,
    });
    assert.equal(r.clique, true);
    await site.page.waitForTimeout(100);
    assert.deepEqual(site.journal.clics, ['TÉLÉCHARGER ma facture'], 'casse et espaces normalisés, rien de plus');
  } finally {
    await site.fermer();
  }
});

test('D2 — la session tombe au premier détail : rien d\'obtenu, c\'est un renvoi — la règle du lot 91 le classera', faux.SANS_NAVIGATEUR, async () => {
  const achats = deuxAchats();
  achats[0].renvoi = true;
  const { resultat, erreur, journal } = await passer(achats);
  assert.equal(resultat, null);
  assert.equal(erreur?.sessionExpired, true, erreur?.message);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.equal(journal.clics.length, 0);
  aucunGesteInterdit(journal);
});

test('D2 — la session tombe APRÈS une facture prise : l\'acquis est gardé, et l\'interruption est dite', faux.SANS_NAVIGATEUR, async () => {
  const achats = deuxAchats();
  achats[1].renvoi = true;
  const { resultat, erreur, journal } = await passer(achats);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.invoices[0].remoteId, 'decathlon-ZZ0TEST0A1');
  assert.equal(resultat.precision,
    '— La lecture s\'est interrompue — Decathlon a renvoyé vers sa page de connexion : les factures '
    + 'déjà prises sont gardées, 1 achat(s) seront examinés au prochain passage.');
  aucunGesteInterdit(journal);
});

// ---------------------------------------------------------------------------
// D3 — l'achat sans bouton, et le bilan par issue
// ---------------------------------------------------------------------------

test('D3 — aucun achat ne propose de facture : réussite à 0 document, le message rappelle l\'adresse', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes, preuves } = await passer(deuxAchats('absent', 'absent'));
  assert.equal(erreur, null, `pas un échec : ${erreur?.message}`);
  assert.deepEqual(resultat.invoices, []);
  assert.equal(resultat.manquees, 0, 'rien n\'a été tenté sans être obtenu : ce n\'est pas un échec');
  assert.equal(resultat.aucunDocument,
    'Votre historique Decathlon a bien été lu (2 achat(s)) : aucun ne propose encore « Télécharger '
    + 'ma facture ». Decathlon ne remet une facture que si votre adresse de facturation et votre '
    + 'adresse de livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet '
    + 'd\'adresses », sur decathlon.fr. Puis relancez la récupération.');
  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 2 sans facture proposée\./);
  assert.equal(journal.clics.length, 0);
  aucunGesteInterdit(journal);
});

test('D3 — un achat avec facture, un sans : la facture entre, l\'autre se dit avec le rappel d\'adresse', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(deuxAchats('telechargement', 'absent'));
  assert.equal(erreur, null);
  assert.equal(resultat.invoices.length, 1);
  assert.equal(resultat.precision,
    '— 1 achat(s) ne propose(nt) pas encore « Télécharger ma facture ». Decathlon ne remet une '
    + 'facture que si votre adresse de facturation et votre adresse de livraison sont renseignées '
    + 'dans votre compte : vérifiez-les dans « Carnet d\'adresses », sur decathlon.fr.');
  assert.match(lignes.join('\n'), /bilan — 2 achat\(s\) : 1 facture récupérée, 1 sans facture proposée\./);
  aucunGesteInterdit(journal);
});

// ---------------------------------------------------------------------------
// Les fonctions pures : ancre, numéro, bilan
// ---------------------------------------------------------------------------

test('l\'ancre vient du numéro lu, jamais de l\'adresse ; le deuxième colis a la sienne', () => {
  assert.equal(decathlon.ancreFacture('ZZ0TEST0A1'), 'decathlon-ZZ0TEST0A1');
  assert.equal(decathlon.ancreFacture('0000-1111', 1), 'decathlon-0000-1111');
  assert.equal(decathlon.ancreFacture('0000-1111', 2), 'decathlon-0000-1111-colis-2');
  const achat = decathlon.analyserAchat({
    numero: '0000-1111',
    adresse: `${faux.DECATHLON}/account/orderTracking?transactionId=ffffffff-0000-0000-0000-000000001111&type=store`,
    texte: 'Terminée Numéro de commande : 0000-1111 02/02/2026 1 produit(s) 0,00 € Voir les détails',
  });
  assert.equal(achat.numero, '0000-1111');
  assert.equal(achat.nature, 'en magasin');
  assert.equal(achat.issuedOn, '2026-02-02');
  assert.equal(decathlon.nettoyerNumero('sans chiffre'), '', 'un numéro sans chiffre n\'en est pas un');
});

test('le bilan ne dit que ce qui est arrivé', () => {
  assert.equal(decathlon.phraseBilan(0, { recuperee: 0 }), '0 achat(s).');
  assert.equal(
    decathlon.phraseBilan(3, { recuperee: 1, archivee: 1, nonProposee: 1, autreLibelle: 0, sansPdf: 0 }),
    '3 achat(s) : 1 facture récupérée, 1 déjà dans l\'archive, 1 sans facture proposée.'
  );
});

// ---------------------------------------------------------------------------
// Ce que l'utilisateur lit, mot pour mot — par le VRAI planificateur
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot92-decathlon';
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) { return globalThis.__lot92(config, ctx); },
};
`;

test('ce que l\'utilisateur lit, mot pour mot, pour chaque issue (vrai planificateur)', faux.SANS_NAVIGATEUR, async () => {
  const user = await helpers.createUser({ username: 'lot92', role: 'admin' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot92-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify({
    id: ID_SONDE,
    name: 'Sonde lot 92',
    category: 'shopping',
    description: 'Sonde de test : le résultat du vrai connecteur Decathlon, sur des pages reconstituées.',
    fields: [{ key: 'username', label: 'Identifiant', type: 'text' }],
    permissions: [{ key: 'factures', scope: 'read-write', description: 'Sonde de test : aucune facture réelle.' }],
  }));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  registry.install(user.id, ID_SONDE);
  registry.saveConfig(user.id, ID_SONDE, { username: 'sonde' });

  const lire = async (achats) => {
    const site = await faux.ouvrirFauxSite('www.decathlon.fr', faux.siteDecathlon(achats));
    globalThis.__lot92 = (config, ctx) => faux.surLeFauxProfil(site, () => decathlon.fetchInvoices(config, ctx));
    try {
      const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
      aucunGesteInterdit(site.journal);
      return r;
    } finally {
      await site.fermer();
    }
  };

  try {
    // L'ordre compte : les deux premières factures entrent, puis l'archive les connaît.
    let r = await lire(deuxAchats());
    assert.equal(r.ok, true);
    assert.equal(r.message, '2 factures récupérées');

    r = await lire(deuxAchats());
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Aucune nouvelle facture', 'second passage : rien de repris');

    const neufs = (enLigne, magasin) => [
      { numero: 'ZZ0TEST0C3', nature: 'oneom', dateAffichee: '01/04/2026', colis: [enLigne] },
      { numero: '0000-3333', nature: 'store', dateAffichee: '02/04/2026', colis: [magasin] },
    ];

    r = await lire(neufs('absent', 'absent'));
    assert.equal(r.ok, true, 'aucune facture proposée : une réussite');
    assert.equal(r.message,
      'Votre historique Decathlon a bien été lu (2 achat(s)) : aucun ne propose encore « Télécharger '
      + 'ma facture ». Decathlon ne remet une facture que si votre adresse de facturation et votre '
      + 'adresse de livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet '
      + 'd\'adresses », sur decathlon.fr. Puis relancez la récupération.');

    r = await lire(neufs('demander', 'absent'));
    assert.equal(r.ok, true);
    assert.equal(r.message,
      'Aucune nouvelle facture — 1 achat(s) ne propose(nt) pas encore « Télécharger ma facture ». '
      + 'Decathlon ne remet une facture que si votre adresse de facturation et votre adresse de '
      + 'livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet d\'adresses », sur '
      + 'decathlon.fr. 1 achat(s) propose(nt) « Demander ma facture » au lieu de « Télécharger ma '
      + 'facture » : crabe ne clique jamais un bouton qui envoie une demande. Faites-la vous-même sur '
      + 'decathlon.fr si vous avez besoin de cette facture : crabe la récupérera quand elle sera '
      + 'proposée au téléchargement.');

    r = await lire(neufs('formulaire', 'telechargement'));
    assert.equal(r.ok, false, 'un clic sans PDF et rien d\'obtenu : un échec, dit');
    assert.equal(r.cause, 'echec');
    assert.equal(r.message,
      'Aucun document n\'a pu être récupéré — 1 vous était proposé, aucun n\'a pu être téléchargé. '
      + 'Le détail de ce qui a bloqué est dans le journal de cette exécution. Après un clic sur '
      + '« Télécharger ma facture », Decathlon a affiché un formulaire au lieu de la facture : crabe '
      + 'n\'y a rien rempli, n\'a plus rien cliqué et s\'est arrêté là. C\'est ce que le site montre '
      + 'quand l\'adresse manque. Decathlon ne remet une facture que si votre adresse de facturation '
      + 'et votre adresse de livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet '
      + 'd\'adresses », sur decathlon.fr. Puis relancez la récupération. 1 autre(s) achat(s) seront '
      + 'examinés au prochain passage.');

    r = await lire(neufs('non-pdf', 'telechargement'));
    assert.equal(r.ok, false);
    assert.equal(r.message,
      'Aucun document n\'a pu être récupéré — 1 vous était proposé, aucun n\'a pu être téléchargé. '
      + 'Le détail de ce qui a bloqué est dans le journal de cette exécution. Après un clic sur '
      + '« Télécharger ma facture », Decathlon n\'a pas remis de PDF : crabe n\'a plus rien cliqué '
      + 'et s\'est arrêté là. Si cela se répète, signalez-le. 1 autre(s) achat(s) seront examinés au '
      + 'prochain passage.');

    r = await lire(neufs('telechargement', 'absent'));
    assert.equal(r.ok, true);
    assert.equal(r.message,
      '1 facture récupérée — 1 achat(s) ne propose(nt) pas encore « Télécharger ma facture ». '
      + 'Decathlon ne remet une facture que si votre adresse de facturation et votre adresse de '
      + 'livraison sont renseignées dans votre compte : vérifiez-les dans « Carnet d\'adresses », sur '
      + 'decathlon.fr.');
  } finally {
    delete globalThis.__lot92;
    fs.rmSync(dossier, { recursive: true, force: true });
    registry.load();
  }
});

test.after(() => {
  helpers.teardown();
});
