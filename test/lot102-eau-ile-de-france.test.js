'use strict';

/**
 * Lot 102 — l'Eau d'Île-de-France : les factures de l'historique, prises une à
 * une par leur icône de téléchargement — le seul clic du connecteur.
 *
 * Ces essais tournent au VRAI Chromium sur une page RECONSTITUÉE d'après la
 * structure annoncée (test/lot102-faux-site.js), dessinée par script après un
 * délai, l'ombre synthétique de Salesforce imitée : ils prouvent la lecture
 * de cette forme, pas le vrai site. Le connecteur ouvre son propre
 * navigateur ; le banc ne remplace que son lancement (`ouverture.lancer`).
 * Aucune requête ne sort ; la page compte elle-même chaque clic.
 *
 * ⚠ Valeurs inventées : numéros « 99000… », jetons « jeton-invente-… »,
 * montants à 0,00 €, client « Client d'essai ».
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const eau = require('../server/connectors/available/eau-ile-de-france/connector');
const faux = require('./lot102-faux-site');
const outils = require('./lot99-outils');

const ID = 'eau-ile-de-france';
const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', ID, 'connector.js');
const N = (rang) => faux.numeroInvente(rang);
const ANCRES = [1, 2, 3].map((r) => `${ID}-facture-${N(r)}`);
const NOMS = [
  `${ID}_2026-09_facture-${N(1)}.pdf`,
  `${ID}_2026-03_facture-${N(2)}.pdf`,
  `${ID}_2025-09_facture-${N(3)}.pdf`,
];

const enMotif = (texte) => new RegExp(String(texte).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

/** Ce qu'aucun journal ne doit porter : numéros, jetons (encodés ou non), montants. */
const DONNEES = [
  /\d{24}/,
  ...[1, 2, 3, 999].map((r) => enMotif(faux.jetonInvente(N(r)).slice(0, 20))),
  ...[1, 2, 3, 999].map((r) => enMotif(decodeURIComponent(faux.jetonInvente(N(r))).slice(0, 20))),
  /jeton-invente/,
  /ZZ-CONTRAT/,
  /Client d'essai/,
];

/** Un passage DIRECT du connecteur sur le faux site. */
async function passer(etat, { ctxExtra = {}, horloge = null, delaiDessinMs = null, delaiDocumentMs = null } = {}) {
  const banc = faux.lanceurFaux(faux.siteEau(etat));
  const avant = { ...eau.ouverture };
  eau.ouverture.lancer = banc.lancer;
  if (horloge) eau.ouverture.maintenant = horloge;
  if (delaiDessinMs) eau.ouverture.delaiDessinMs = delaiDessinMs;
  if (delaiDocumentMs) eau.ouverture.delaiDocumentMs = delaiDocumentMs;
  const lignes = [];
  const preuves = [];
  const debut = Date.now();
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await eau.fetchInvoices(
        { session: faux.sessionInventee(), historique: 'depuis' },
        { userId: 1, log: (m) => lignes.push(String(m)), preuveDeListe: (p) => preuves.push(p), knownRemoteIds: [], ...ctxExtra }
      );
    } catch (err) {
      erreur = err;
    }
    assert.ok(banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
    return { resultat, erreur, journal: banc.journal, lignes, preuves, ouverts: banc.ouverts(), duree: Date.now() - debut };
  } finally {
    Object.assign(eau.ouverture, avant);
    await banc.fermer();
  }
}

/** Le numéro inventé que porte un PDF du banc. */
function numeroDuPdf(buffer) {
  return (/facture inventee eau (\d{24})/.exec(buffer.toString('latin1')) || [])[1] || null;
}

/** Ce qui doit tenir à CHAQUE passage : aucun piège, aucune saisie, rien de sorti. */
function rienQueLePermis(journal, etat) {
  assert.deepEqual(journal.saisies, [], 'aucune saisie, aucun envoi de formulaire');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.deepEqual(etat.compteurs.pieges, [], 'aucun piège touché');
  for (const clic of journal.clics) {
    assert.equal(clic.zone, 'historique', `un clic hors des icônes de l'historique : ${JSON.stringify(clic)}`);
    assert.ok(etat.factures.some((f) => f.numero === clic.numero && (f.numeroIcone ?? f.numero) === f.numero),
      `un clic sur une icône dont le numéro n'a pas été lu : ${JSON.stringify(clic)}`);
  }
  for (const e of journal.ecritures) {
    assert.match(e, /^POST connexion\.leaudiledefrance\.fr\/espace-particuliers\/s\/sfsites\/aura$/,
      `seuls les appels que la page fait d'elle-même après le clic : ${e}`);
  }
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D2 — par construction : un seul clic, une seule cible, aucune lecture dans la page
// ---------------------------------------------------------------------------

test('D2 — le fichier se LIT : un seul `.click(`, dans la seule fonction qui clique, sur le seul repère ; aucun autre geste', () => {
  const code = outils.codeSansCommentaires(SOURCE);
  const clics = [...code.matchAll(/\.click\s*\(/g)];
  assert.equal(clics.length, 1, 'un seul clic dans tout le fichier');
  const debut = code.indexOf('async function cliquerLeTelechargement(');
  const fin = code.indexOf('\n}\n', debut);
  assert.ok(debut >= 0 && fin > debut, 'la fonction qui clique existe');
  assert.ok(clics[0].index > debut && clics[0].index < fin, 'et le clic est DANS elle');
  const corps = code.slice(debut, fin);
  // Ses gardes sont toutes AVANT le clic (indexOf >= 0 : une garde disparue ne passe pas pour « avant »).
  const clic = corps.indexOf('.click(');
  for (const garde of ['!NUMERO_FACTURE.test(n) || !lus?.has?.(n)', '`${REPERE_CLIC}[data-numfacture="${n}"]`',
    'nombre !== 1', 'isVisible()', 'getAttribute(\'data-numfacture\'']) {
    const ou = corps.indexOf(garde);
    assert.ok(ou >= 0 && ou < clic, `la garde « ${garde} » est présente, et avant le clic`);
  }
  assert.equal(eau.REPERE_CLIC, 'c-icl-contrat-factures-histo div.download[data-numfacture]', 'le repère du R4, exact');
  assert.equal((code.match(/cliquerLeTelechargement\(/g) || []).length, 2, 'définie une fois, appelée une fois');
  for (const geste of [/\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.uncheck\s*\(/,
    /\.selectOption\s*\(/, /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.requestSubmit\s*\(/, /\.submit\b/, /\.tap\s*\(/,
    /\.hover\s*\(/, /\.focus\s*\(/, /keyboard\./, /mouse\./, /touchscreen\./, /\.accept\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/,
    /scrollIntoView/]) {
    assert.doesNotMatch(code, geste, `aucun autre geste (${geste})`);
  }
  // Rien n'est lu ni cherché dans le monde de la page (l'ombre synthétique de LWC le filtre).
  assert.doesNotMatch(code, /\.evaluate\s*\(|\.\$\$?\s*\(|querySelector|getElementsBy/, 'aucune lecture par le document de la page');
  assert.doesNotMatch(code, /data-url/, 'le jeton n\'est jamais lu');
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch/,
    'aucun client HTTP hors du navigateur');
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule navigation');
  assert.match(code, /await page\.goto\(URL_FACTURES, \{ waitUntil: 'domcontentloaded' \}\)/, 'vers la page des factures, par son adresse');
  assert.equal((code.match(/chromium\.launch\s*\(/g) || []).length, 1, 'un seul lancement');
  assert.match(code, /lancer: \(\) => requirePlaywright\(\)\.chromium\.launch\(identity\.optionsLancement\(\)\)/);
  assert.doesNotMatch(code, /launchPersistentContext|profilMarchand\.surLeProfil/, 'ni profil persistant, ni écran');
  assert.match(code, /adressePermise: adresseDuSite/, 'le document se prend avec la règle des domaines du site');
});

test('D2 — un numéro qui n\'a pas été lu sur une ligne : rien ne part, le passage s\'arrête net', async () => {
  let compte = 0;
  const page = { locator: () => { compte += 1; throw new Error('aucune cible ne doit être cherchée'); } };
  await assert.rejects(eau.cliquerLeTelechargement(page, N(999), new Set([N(1)])), /n'a pas été lu sur une ligne de l'historique — rien n'a été cliqué/);
  await assert.rejects(eau.cliquerLeTelechargement(page, '12345', new Set(['12345'])), /rien n'a été cliqué/);
  await assert.rejects(eau.cliquerLeTelechargement(page, `${N(1)}"]`, new Set([`${N(1)}"]`])), /rien n'a été cliqué/,
    'un numéro qui n\'a pas la forme exacte ne se glisse jamais dans un sélecteur');
  assert.equal(compte, 0);
});

// ---------------------------------------------------------------------------
// D1 — trois factures, trois voies du banc, trois PDF chaque fois
// ---------------------------------------------------------------------------

for (const [variante, voie] of [
  ['telechargement', /téléchargement direct/],
  ['onglet', /nouvel onglet — réponse déjà reçue par l'onglet/],
  ['reponse', /réponse PDF de la page/],
]) {
  test(`D1 — le clic sert le PDF par « ${variante} » : trois PDF, trois ancres, trois noms ; un clic par facture, sur son icône`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.compteEau({ variante });
    const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
    assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
    assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES, 'l\'ancre : le numéro lu');
    assert.deepEqual(resultat.invoices.map((f) => f.filename), NOMS, 'le nom : la période de la date de la ligne, le numéro');
    assert.deepEqual(resultat.invoices.map((f) => f.issuedOn), ['2026-09-12', '2026-03-14', '2025-09-10']);
    assert.deepEqual(resultat.invoices.map((f) => numeroDuPdf(f.buffer)), [N(1), N(2), N(3)], 'chaque ancre porte SON document');
    assert.ok(resultat.invoices.every((f) => f.buffer.subarray(0, 5).toString('latin1') === '%PDF-'));
    assert.deepEqual(journal.clics.map((c) => c.numero), [N(1), N(2), N(3)], 'un clic par facture, dans l\'ordre, sur son icône');
    assert.ok(journal.clics.every((c) => c.pages === 1), `au moment de chaque clic, une seule page ouverte : l'onglet précédent est refermé (${JSON.stringify(journal.clics)})`);
    assert.equal(resultat.precision, '— Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.');
    assert.equal(resultat.manquees, undefined);
    assert.deepEqual(resultat.couverture, { complete: true, detail: 'l\'historique des factures du contrat affiché, 3 factures' });
    assert.equal(preuves.length, 1);
    assert.equal(preuves[0].elements, 3);
    assert.ok(resultat.sessionRenouvelee, 'l\'état de session d\'un passage qui a lu l\'historique est rendu');
    assert.equal(lignes.filter((l) => voie.test(l) && /— récupérée \(voie mesurée/.test(l)).length, 3, `la voie mesurée est dite : ${lignes.join('\n')}`);
    assert.deepEqual(journal.visites.filter((v) => v.startsWith(faux.HOTE)), [`${faux.HOTE}${faux.CHEMIN_FACTURES}`],
      'une seule page du site visitée : celle des factures, par son adresse');
    assert.equal(ouverts, 0, 'le connecteur a refermé son navigateur');
    rienQueLePermis(journal, etat);
    outils.journalSansDonnee(lignes, DONNEES);
  });
}

test('D1 — les deux autres formes mesurées sur le banc : un onglet ouvert droit sur le PDF (il arrive en téléchargement), une réponse lue en blob (le flux est relu dans la page)', faux.SANS_NAVIGATEUR, async () => {
  for (const [variante, voie, servis] of [
    ['onglet-pdf', /téléchargement direct/, 3],
    ['reponse-blob', /réponse PDF de la page, flux relu dans la page/, 6],
  ]) {
    const etat = faux.compteEau({ variante });
    const { resultat, erreur, journal, lignes } = await passer(etat);
    assert.equal(erreur, null, `${variante} : ${erreur?.message}`);
    assert.deepEqual(resultat.invoices.map((f) => numeroDuPdf(f.buffer)), [N(1), N(2), N(3)], variante);
    assert.equal(lignes.filter((l) => voie.test(l)).length, 3, `${variante} : ${lignes.join('\n')}`);
    assert.equal(etat.compteurs.pdf.length, servis, `${variante} : ${servis} PDF servis`);
    assert.ok(journal.clics.every((c) => c.pages === 1), `${variante} : l'onglet resté vide est refermé avant le clic suivant`);
    rienQueLePermis(journal, etat);
  }
});

test('D1 — second passage : rien de recliqué, rien de redemandé, et l\'archive est dite', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau();
  const { resultat, erreur, journal } = await passer(etat, { ctxExtra: { knownRemoteIds: ANCRES } });
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.deepEqual(journal.clics, [], 'aucun clic');
  assert.deepEqual(etat.compteurs.pdf, [], 'aucun PDF demandé');
  assert.equal(resultat.precision, '— Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, 3 déjà dans vos documents.');
  assert.equal(resultat.aucunDocument, undefined, 'des factures existent : ce n\'est pas « aucun document »');
});

// ---------------------------------------------------------------------------
// D2 — les pièges, à côté, visibles : jamais touchés
// ---------------------------------------------------------------------------

test('D2 — à côté des icônes : « PAYER MA FACTURE » actif, l\'attestation, une icône hors de l\'historique au numéro d\'une vraie facture, une icône au numéro non lu, le menu, la bulle — rien de cela n\'est touché', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau();
  const page = faux.pageFactures(etat);
  // Les pièges sont bien dans la page servie.
  for (const piege of ['PAYER MA FACTURE', 'Télécharger une attestation de contrat', 'Signaler un changement', 'Modifier mes coordonnées',
    'Comprendre mon solde', 'J\'emménage / Je déménage', 'data-menu-item-label="Déconnexion"', 'data-menu-item-label="Mon profil"',
    'helpButtonEnabled', 'data-piege="icône hors de l\'historique"', 'icône au numéro non lu', N(999)]) {
    assert.ok(page.includes(piege), `piège présent : ${piege}`);
  }
  assert.ok(!/<button[^>]*data-piege="payer"[^>]*disabled/.test(page), '« PAYER MA FACTURE » est ACTIF sur le banc');
  const { resultat, erreur, journal } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 3);
  assert.deepEqual(journal.clics.map((c) => `${c.zone}:${c.numero}`), [1, 2, 3].map((r) => `historique:${N(r)}`),
    'trois clics, tous sur une icône de l\'historique au numéro lu');
  assert.ok(!journal.clics.some((c) => c.numero === N(999)), 'l\'icône au numéro non lu n\'est jamais touchée');
  assert.ok(!journal.clics.some((c) => c.zone === 'ailleurs'), 'l\'icône hors de l\'historique n\'est jamais touchée');
  assert.deepEqual(etat.compteurs.pieges, []);
  rienQueLePermis(journal, etat);
});

// ---------------------------------------------------------------------------
// D3 — tout le reste arrête : un clic, puis plus aucun
// ---------------------------------------------------------------------------

const ISSUES = [
  ['erreur-aura', /un message d'erreur de Salesforce s'est affiché/, /a affiché un message d'erreur au lieu de la remettre : crabe n'a plus rien cliqué/],
  ['toast-erreur', /un message d'erreur de Salesforce s'est affiché/, /a affiché un message d'erreur au lieu de la remettre/],
  ['fenetre', /une fenêtre s'est ouverte à la place de la facture, sans être touchée/, /a ouvert une fenêtre au lieu de la remettre : crabe n'y a rien rempli, n'a plus rien cliqué/],
  ['native', /une boîte de dialogue du navigateur s'est ouverte — refusée/, /une boîte de dialogue du navigateur s'est ouverte au lieu de la facture : crabe l'a refusée/],
  ['page', /une autre page s'est affichée à la place de la facture/, /a affiché une autre page au lieu de la remettre/],
  ['rien', /le clic n'a déclenché ni téléchargement, ni nouvel onglet, ni réponse PDF en 3 s/, /n'a rien remis — ni téléchargement, ni onglet, ni document/],
  ['non-pdf', /le fichier téléchargé n'est pas un PDF \(\d+ octets\) \[reçu : page web \(HTML\)/, /a remis autre chose qu'une facture PDF : rien n'a été déposé/],
  ['onglet-blob', /un onglet s'est ouvert mais la page de l'onglet sert « text\/html », pas un PDF/, /a remis autre chose qu'une facture PDF/],
  ['onglet-ailleurs', /le téléchargement venait de documents\.exemple\.invalid, hors des domaines permis : rien n'en a été lu/,
    /un onglet s'est ouvert sur un autre site que celui de l'Eau d'Île-de-France : crabe n'en a rien lu, n'a plus rien cliqué/],
  ['onglet-ailleurs-html', /l'onglet ouvert par le clic venait de documents\.exemple\.invalid, hors des domaines permis : rien n'en a été lu/,
    /un onglet s'est ouvert sur un autre site/],
];

for (const [variante, ligne, renoncement] of ISSUES) {
  test(`D3 — « ${variante} » sur la deuxième facture : un clic, plus aucun ; la première gardée, rien d'autre déposé, dit`, faux.SANS_NAVIGATEUR, async () => {
    const etat = faux.compteEau();
    etat.factures[1].variante = variante;
    const { resultat, erreur, journal, lignes } = await passer(etat, { delaiDocumentMs: 3_000 });
    assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
    assert.deepEqual(resultat.invoices.map((f) => f.remoteId), [ANCRES[0]], 'la facture déjà prise est gardée, rien d\'autre');
    assert.deepEqual(resultat.invoices.map((f) => numeroDuPdf(f.buffer)), [N(1)]);
    assert.deepEqual(journal.clics.map((c) => c.numero), [N(1), N(2)], 'un clic sur la deuxième, puis plus AUCUN');
    assert.equal(resultat.manquees, 2, 'la deuxième manquée, la troisième jamais demandée');
    assert.match(lignes.join('\n'), new RegExp(`facture 2 sur 3 — clic sur l'icône, pas de PDF \\(${ligne.source}`));
    assert.match(lignes.join('\n'), /Plus aucun clic pendant ce passage ; rien n'a été rempli\./);
    assert.match(resultat.renoncement, renoncement);
    assert.match(resultat.renoncement, /L'autre facture n'a pas été demandée : elle le sera au prochain passage\. Si cela se répète, signalez-le\.$/);
    assert.equal(resultat.precision, 'Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.',
      'le message du planificateur finit sa phrase : pas de tiret');
    if (variante.startsWith('onglet-ailleurs')) {
      assert.ok(etat.compteurs.ailleurs.length >= 1, 'le site a bien ouvert l\'autre domaine (servi par le banc)');
    }
    rienQueLePermis(journal, etat);
    outils.journalSansDonnee(lignes, DONNEES);
  });
}

test('D3 — la page de connexion à la place de la facture : la session est tombée en route, ce qui est pris est gardé, dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau();
  etat.factures[1].variante = 'connexion';
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), [ANCRES[0]]);
  assert.deepEqual(journal.clics.map((c) => c.numero), [N(1), N(2)]);
  assert.equal(resultat.manquees, 2);
  assert.equal(resultat.renoncement, undefined);
  assert.equal(resultat.precision, 'Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché. '
    + 'La lecture s\'est interrompue — l\'Eau d\'Île-de-France a demandé de vous reconnecter : les factures déjà prises sont gardées. '
    + 'Reconnectez-vous depuis la fiche de l\'Eau d\'Île-de-France pour récupérer la suite.');
  assert.match(lignes.join('\n'), /renvoyé vers la connexion en prenant les factures : 1 facture déjà prise est gardée\./);
  assert.equal(resultat.sessionRenouvelee, undefined, 'jamais après un renvoi vers la connexion');
  rienQueLePermis(journal, etat);
});

test('D3 — le PREMIER clic sans PDF : aucune facture, un clic et plus aucun ; la page de connexion au premier clic est un renvoi', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau({ variante: 'erreur-aura' });
  const premier = await passer(etat);
  assert.equal(premier.erreur, null, premier.erreur?.message);
  assert.deepEqual(premier.resultat.invoices, []);
  assert.deepEqual(premier.journal.clics.map((c) => c.numero), [N(1)]);
  assert.equal(premier.resultat.manquees, 3);
  assert.match(premier.resultat.renoncement, /Les 2 autres factures n'ont pas été demandées : elles le seront au prochain passage\./);

  const connexion = faux.compteEau({ variante: 'connexion' });
  const second = await passer(connexion);
  assert.ok(second.erreur);
  assert.equal(second.erreur.sessionExpired, true, 'aucune facture prise : c\'est un renvoi vers la connexion (lot 91)');
  assert.deepEqual(second.journal.clics.map((c) => c.numero), [N(1)]);
});

// ---------------------------------------------------------------------------
// D4 — l'historique vide, la page de connexion, le chargement sans fin
// ---------------------------------------------------------------------------

test('D4 — un historique dessiné sans ligne : « aucune facture », sans échec ni clic', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau({ historique: 'vide' });
  const { resultat, erreur, journal, preuves } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices, []);
  assert.equal(resultat.aucunDocument, 'Votre historique de factures Eau d\'Île-de-France a bien été lu : il ne contient aucune facture pour l\'instant.');
  assert.equal(preuves[0].elements, 0, 'la liste a été lue, vide');
  assert.deepEqual(journal.clics, []);
});

test('D4 — la page de connexion à la place de l\'historique : un renvoi vers la connexion, marqué pour le lot 91, jamais « page illisible »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau({ connecte: false });
  const { erreur, journal, lignes, preuves } = await passer(etat);
  assert.ok(erreur);
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.doesNotMatch(erreur.message, /n'a pas su lire/);
  assert.match(lignes.join('\n'), /arrivée jugée « connexion » — renvoyé vers \/espace-particuliers\/s\/login\/, une page de connexion/);
  assert.equal(preuves.length, 0);
  assert.deepEqual(journal.clics, []);
  assert.deepEqual(journal.fuites, []);
});

test('D4 — une page qui ne finit jamais de charger : échec dit, dans la borne de temps, sans un clic', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau({ chargement: 'sans-fin' });
  const { erreur, journal, lignes, duree } = await passer(etat, { delaiDessinMs: 3_000 });
  assert.ok(erreur);
  assert.notEqual(erreur.sessionExpired, true);
  assert.equal(erreur.message, 'La page des factures de l\'Eau d\'Île-de-France est restée en cours de chargement plus de 3 secondes : '
    + 'crabe n\'a rien pu lire, et n\'a rien cliqué. La prochaine récupération réessaiera d\'elle-même ; si cela se répète, signalez-le.');
  assert.match(lignes.join('\n'), /arrivée jugée « chargement » — encore en cours de chargement après 3 s/);
  assert.ok(duree < 3_000 + 12_000, `la borne tient (lancement du navigateur compris) : ${duree} ms`);
  assert.deepEqual(journal.clics, []);
});

test('D4 — le message d\'erreur de Salesforce à la place de l\'historique : échec dit, sans un clic', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau({ erreurAuChargement: true });
  const { erreur, journal, lignes } = await passer(etat, { delaiDessinMs: 10_000 });
  assert.ok(erreur);
  assert.match(erreur.message, /^L'Eau d'Île-de-France a affiché un message d'erreur au lieu de l'historique de vos factures : crabe n'a rien pu lire, et n'a rien cliqué\./);
  assert.match(lignes.join('\n'), /arrivée jugée « erreur »/);
  assert.deepEqual(journal.clics, []);
});

test('D4 — la borne par défaut : 45 s, celle d\'une navigation ; le budget : les 2/3 de la limite du planificateur', () => {
  assert.equal(eau.DELAI_DESSIN_MS, 45_000);
  assert.equal(eau.ouverture.delaiDessinMs, eau.DELAI_DESSIN_MS);
  assert.equal(eau.LIMITE_EXECUTION_DEFAUT_MS, scheduler.LIMITE_EXECUTION_MS, 'la même limite que le planificateur');
  return outils.avecLimite(30 * 60 * 1000, () => assert.equal(eau.budgetMs(), 20 * 60 * 1000));
});

// ---------------------------------------------------------------------------
// D5 — un numéro d'icône différent du texte : la ligne est écartée, dite
// ---------------------------------------------------------------------------

test('D5 — `data-numfacture` différent du numéro de la ligne : la ligne est écartée, jamais cliquée, et c\'est dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteEau();
  etat.factures[1].numeroIcone = N(42);
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), [ANCRES[0], ANCRES[2]]);
  assert.deepEqual(journal.clics.map((c) => c.numero), [N(1), N(3)], 'la ligne écartée n\'est pas cliquée');
  assert.match(lignes.join('\n'), /ligne 3 sur 4 écartée — le numéro porté par l'icône diffère de celui de la ligne ; aucun clic\./);
  assert.equal(resultat.precision, '— Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché. '
    + 'Une ligne a été écartée : son numéro de facture ne se lisait pas de façon sûre, crabe ne l\'a pas cliquée.');
  outils.journalSansDonnee(lignes, DONNEES);
});

test('R3 — lire une ligne : l\'en-tête, une facture, un numéro illisible, en double, absent de l\'icône ; la date JJ/MM/AAAA', () => {
  const ligne = (extra) => ({ visible: true, texte: '', dateTexte: '', icones: 1, numeroIcone: N(1), ...extra });
  assert.deepEqual(eau.analyserLigne(ligne({ icones: 0, texte: 'Date Numéro de facture Montant Statut Téléchargement' })), { nature: 'entete' });
  assert.deepEqual(eau.analyserLigne(ligne({ texte: `12/09/2026 ${N(1)} 0,00 € Payée`, dateTexte: '12/09/2026' })),
    { nature: 'facture', numero: N(1), issuedOn: '2026-09-12' });
  assert.equal(eau.analyserLigne(ligne({ texte: `12/09/2026 ${N(2)} 0,00 €` })).raison, 'le numéro porté par l\'icône diffère de celui de la ligne');
  assert.equal(eau.analyserLigne(ligne({ texte: '12/09/2026 0,00 €' })).raison, 'le numéro de facture de la ligne ne se lit pas');
  assert.equal(eau.analyserLigne(ligne({ texte: `${N(1)} ${N(2)}` })).raison, 'la ligne porte plusieurs numéros de facture');
  assert.equal(eau.analyserLigne(ligne({ texte: N(1), numeroIcone: '' })).raison, 'l\'icône ne porte pas un numéro de facture lisible');
  assert.equal(eau.analyserLigne(ligne({ texte: N(1), icones: 2 })).nature, 'ecartee');
  assert.deepEqual(eau.analyserLigne(ligne({ texte: `${N(1)} Payée`, icones: 0 })), { nature: 'sans-icone' });
  assert.deepEqual(eau.analyserLigne(ligne({ visible: false, texte: N(1) })), { nature: 'cachee' });
  assert.equal(eau.analyserLigne(ligne({ texte: `${N(1)}5` })).raison, 'le numéro de facture de la ligne ne se lit pas', '25 chiffres ne sont pas un numéro');
  const lecture = eau.lireLesFactures([
    ligne({ icones: 0, texte: 'Date Numéro de facture Montant Statut Téléchargement' }),
    ligne({ texte: `12/09/2026 ${N(1)}` }),
    ligne({ texte: `14/03/2026 ${N(1)}` }),
    ligne({ texte: `10/09/2025 ${N(3)}`, numeroIcone: N(3) }),
    ligne({ texte: `01/01/2025 ${N(4)}`, icones: 0 }),
  ]);
  assert.deepEqual(lecture.factures.map((f) => f.numero), [N(3)]);
  assert.deepEqual(lecture.ecartees.map((e) => e.raison), ['le même numéro de facture figure sur plusieurs lignes',
    'le même numéro de facture figure sur plusieurs lignes'], 'un numéro en double n\'est cliqué nulle part : sa cible ne serait pas unique');
  assert.equal(lecture.sansIcone, 1);
  assert.equal(lecture.lues, 4, 'l\'en-tête n\'est pas une facture');
});

// ---------------------------------------------------------------------------
// R6, R8 — l'ancre, le nom, le journal
// ---------------------------------------------------------------------------

test('R6 — l\'ancre et le nom : le numéro, la période de la date ; jamais deux fois le même nom', () => {
  assert.equal(eau.remoteIdFacture(N(1)), ANCRES[0]);
  assert.deepEqual(eau.nommer([
    { numero: N(1), issuedOn: '2026-09-12' },
    { numero: N(2), issuedOn: '2026-09-30' },
    { numero: N(1), issuedOn: '2026-09-12' },
    { numero: N(3), issuedOn: null },
  ]), [NOMS[0], `${ID}_2026-09_facture-${N(2)}.pdf`, `${ID}_2026-09_facture-${N(1)}-2.pdf`, `${ID}_facture-${N(3)}.pdf`]);
});

test('R8 — le journal : aucun numéro, aucun jeton, aucune requête d\'adresse ; les noms de composants gardés', () => {
  const j = eau.pourLeJournal;
  assert.equal(j(`locator.click: strict mode violation: locator('c-icl-contrat-factures-histo div.download[data-numfacture="${N(1)}"]')`),
    'locator.click: strict mode violation: locator(\'c-icl-contrat-factures-histo div.download[data-numfacture="…"]\')');
  assert.equal(j(`page.goto: net::ERR_ABORTED at https://x.exemple.invalid/apex/Vue?jeton=${faux.jetonInvente(N(1))}`),
    'page.goto: net::ERR_ABORTED at https://x.exemple.invalid/apex/…');
  assert.equal(j(`le jeton ${decodeURIComponent(faux.jetonInvente(N(2)))} au milieu`), 'le jeton … au milieu');
  assert.equal(j('200 connexion.leaudiledefrance.fr /espace-particuliers/s/factures ; cookies posés : sid'),
    '200 connexion.leaudiledefrance.fr /espace-particuliers/s/factures ; cookies posés : sid');
  assert.equal(j('arrivée jugée « historique » — dessiné en 2.7 s (c-icl-contrat-factures-histo).'),
    'arrivée jugée « historique » — dessiné en 2.7 s (c-icl-contrat-factures-histo).');
  assert.equal(j('/sfc/servlet.shepherd/document/download/068ZZ0000012345AAA'), '/sfc/servlet.shepherd/document/download/###ZZ##########AAA');
});

test('R8 — les phrases : ce qui a été lu, ce qui est déjà là, ce qui a bloqué ; sans numéro ni montant', () => {
  const b = { lues: 3, deja: 1, sansIcone: 0, ecartees: 0, restantes: 0, interruption: null };
  assert.equal(eau.precisionDuPassage(b), '— Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, 1 déjà dans vos documents.');
  assert.equal(eau.precisionDuPassage({ ...b, lues: 1, deja: 0 }), '— Eau d\'Île-de-France : 1 facture lue dans l\'historique du contrat affiché.');
  assert.equal(eau.precisionDuPassage({ ...b, sansIcone: 2, ecartees: 2 }, { sansTiret: true }),
    'Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, 1 déjà dans vos documents, 2 sans icône de téléchargement. '
    + '2 lignes ont été écartées : leur numéro de facture ne se lisait pas de façon sûre, crabe ne les a pas cliquées.');
  assert.equal(eau.precisionDuPassage({ ...b, interruption: 'temps', restantes: 2 }, { sansCompte: true }),
    'La récupération a pris tout le temps permis : 2 factures attendent encore ; elles viendront au prochain passage. '
    + 'Rien de ce qui a été pris n\'est perdu.');
  assert.equal(eau.phraseArret('rien', 0), 'Après un clic sur l\'icône de téléchargement d\'une facture, l\'Eau d\'Île-de-France n\'a rien remis '
    + '— ni téléchargement, ni onglet, ni document : crabe n\'a plus rien cliqué et s\'est arrêté là. Si cela se répète, signalez-le.');
});

test('R4 — les domaines du site : rien n\'est lu d\'ailleurs', () => {
  for (const hote of eau.DOMAINES_DU_SITE) assert.equal(eau.adresseDuSite(`https://${hote}/x?y=1`), true, hote);
  assert.deepEqual([...eau.DOMAINES_DU_SITE], ['connexion.leaudiledefrance.fr', 'rock-vedif.my.site.com', 'rock-vedif.my.salesforce.com',
    'rock-vedif.file.force.com', 'rock-vedif--c.visualforce.com'], 'ceux du §2.1, et eux seuls');
  assert.equal(eau.adresseDuSite('blob:https://connexion.leaudiledefrance.fr/0000-aaaa'), true, 'un fichier fabriqué par une page du site');
  assert.equal(eau.adresseDuSite(''), true, 'un onglet resté vide : rien à y lire');
  assert.equal(eau.adresseDuSite('about:blank'), true);
  assert.equal(eau.adresseDuSite('data:application/pdf;base64,JVBERi0='), true, 'un document fabriqué par la page elle-même');
  for (const non of ['http://connexion.leaudiledefrance.fr/x', 'https://documents.exemple.invalid/f.pdf', 'https://leaudiledefrance.fr.exemple.invalid/',
    'https://evil-rock-vedif.file.force.com/x', 'blob:https://documents.exemple.invalid/0000', 'javascript:void(0)', 'chrome-error://chromewebdata/', 'n\'importe quoi']) {
    assert.equal(eau.adresseDuSite(non), false, non);
  }
});

test('R1 — la page de connexion se reconnaît à son adresse (socle et Salesforce), la page des factures non', () => {
  assert.equal(eau.estPageDeConnexion('https://connexion.leaudiledefrance.fr/espace-particuliers/s/login/?startURL=%2Fespace-particuliers%2Fs%2Ffactures'), true);
  assert.equal(eau.estPageDeConnexion('https://connexion.leaudiledefrance.fr/espace-particuliers/CommunitiesLogin'), true);
  assert.equal(eau.estPageDeConnexion('https://connexion.leaudiledefrance.fr/espace-particuliers/secur/login_portal.jsp'), true);
  assert.equal(eau.estPageDeConnexion(eau.URL_FACTURES), false, 'l\'hôte « connexion. » ne compte pas : seul le chemin est jugé');
  assert.equal(eau.estPageDeConnexion('https://connexion.leaudiledefrance.fr/espace-particuliers/s/'), false);
});

test('une session vide ou expirée ne lance aucun navigateur : « connexion expirée »', () => {
  assert.throws(() => eau.lireSession({}), (err) => err.sessionExpired === true);
  assert.throws(() => eau.lireSession({ session: JSON.stringify({ cookies: [] }) }), (err) => err.sessionExpired === true);
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur : messages mot pour mot (D1, D3, D4), cause (D4), temps (D6), journal (D7)
// ---------------------------------------------------------------------------

test.describe('par le vrai planificateur', () => {
  let restaurer;
  test.before(() => {
    restaurer = outils.interdireLeVraiNavigateur(registry, ID);
    destinations.restoreLocal();
  });
  test.after(() => restaurer());

  async function passage(user, etat, { horloge = null, delaiDocumentMs = null } = {}) {
    const banc = faux.lanceurFaux(faux.siteEau(etat));
    const instance = outils.instanceDuRegistre(registry, ID);
    const avant = { ...instance.ouverture };
    instance.ouverture.lancer = banc.lancer;
    if (horloge) instance.ouverture.maintenant = horloge;
    if (delaiDocumentMs) instance.ouverture.delaiDocumentMs = delaiDocumentMs;
    try {
      const r = await scheduler.runForUser(user.id, ID, 'manual');
      assert.ok(banc.lancements() >= 1, `le planificateur a ouvert le FAUX navigateur, aucun autre (${r.message})`);
      rienQueLePermis(banc.journal, etat);
      return { r, journal: banc.journal };
    } finally {
      Object.assign(instance.ouverture, avant);
      await banc.fermer();
    }
  }

  for (const variante of ['telechargement', 'onglet', 'reponse']) {
    test(`D1 — par « ${variante} », les messages mot pour mot : trois factures, puis rien de nouveau ; trois lignes, trois noms, rien de repris`, faux.SANS_NAVIGATEUR, async () => {
      const user = await outils.compteAvec(helpers, registry, ID, `lot102p1${variante.slice(0, 3)}`, faux.HOTE);
      let { r, journal } = await passage(user, faux.compteEau({ variante }));
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '3 factures récupérées — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.');
      assert.equal(journal.clics.length, 3);
      assert.deepEqual(outils.documents(db, user, ID).map((l) => l.filename), NOMS);
      ({ r, journal } = await passage(user, faux.compteEau({ variante })));
      assert.equal(r.message, 'Aucune nouvelle facture — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, '
        + '3 déjà dans vos documents.');
      assert.deepEqual(journal.clics, [], 'le second passage ne clique rien');
      assert.equal(outils.documents(db, user, ID).length, 3);
    });
  }

  test('D1 — les messages, mot pour mot : trois factures, puis rien de nouveau ; trois lignes, trois noms, rien de repris', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p1', faux.HOTE);
    let { r, journal } = await passage(user, faux.compteEau());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '3 factures récupérées — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.');
    assert.equal(journal.clics.length, 3);
    const lignes = outils.documents(db, user, ID);
    assert.deepEqual(lignes.map((l) => l.remote_id), ANCRES);
    assert.deepEqual(lignes.map((l) => l.filename), NOMS);
    assert.deepEqual(lignes.map((l) => l.issued_on), ['2026-09-12', '2026-03-14', '2025-09-10']);

    ({ r, journal } = await passage(user, faux.compteEau()));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Aucune nouvelle facture — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, '
      + '3 déjà dans vos documents.');
    assert.deepEqual(journal.clics, [], 'le second passage ne clique rien');
    assert.equal(outils.documents(db, user, ID).length, 3, 'le second passage ne reprend rien');
    outils.journalApplicatifSansDonnee(db, DONNEES);
  });

  test('D3 — un clic sans PDF au milieu : le message dit ce qui est pris, ce qui manque, ce qui a bloqué', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p2', faux.HOTE);
    const etat = faux.compteEau();
    etat.factures[1].variante = 'erreur-aura';
    const { r } = await passage(user, etat);
    assert.equal(r.ok, true, 'des documents sont entrés : c\'est une réussite partielle');
    assert.equal(r.message, '1 facture récupérée, 2 non obtenues — le prochain passage les réessaiera. '
      + 'Après un clic sur l\'icône de téléchargement d\'une facture, l\'Eau d\'Île-de-France a affiché un message d\'erreur au lieu de la remettre : '
      + 'crabe n\'a plus rien cliqué et s\'est arrêté là. L\'autre facture n\'a pas été demandée : elle le sera au prochain passage. '
      + 'Si cela se répète, signalez-le. Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.');
    assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id), [ANCRES[0]], 'rien d\'autre n\'est déposé');

    // Le passage suivant, le site remis : la suite, sans recliquer la première.
    const { r: suite, journal } = await passage(user, faux.compteEau());
    assert.equal(suite.message, '2 factures récupérées — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, '
      + '1 déjà dans vos documents.');
    assert.deepEqual(journal.clics.map((c) => c.numero), [N(2), N(3)]);
    assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id), ANCRES);
  });

  test('D3 — le premier clic sans PDF : un échec, qui le dit', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p3', faux.HOTE);
    const { r } = await passage(user, faux.compteEau({ variante: 'rien' }), { delaiDocumentMs: 3_000 });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'Aucun document n\'a pu être récupéré — 3 vous étaient proposés, aucun n\'a pu être téléchargé. '
      + 'Le détail de ce qui a bloqué est dans le journal de cette exécution. Après un clic sur l\'icône de téléchargement d\'une facture, '
      + 'l\'Eau d\'Île-de-France n\'a rien remis — ni téléchargement, ni onglet, ni document : crabe n\'a plus rien cliqué et s\'est arrêté là. '
      + 'Les 2 autres factures n\'ont pas été demandées : elles le seront au prochain passage. Si cela se répète, signalez-le. '
      + 'Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché.');
    assert.equal(outils.documents(db, user, ID).length, 0);
  });

  test('D4 — l\'historique vide : « aucune facture », une réussite', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p4', faux.HOTE);
    const { r } = await passage(user, faux.compteEau({ historique: 'vide' }));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'Votre historique de factures Eau d\'Île-de-France a bien été lu : il ne contient aucune facture pour l\'instant.');
  });

  test('D4 — la page de connexion à la place de l\'historique, après une connexion qui a marché : « session expirée »', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p5', faux.HOTE);
    let { r } = await passage(user, faux.compteEau());
    assert.equal(r.ok, true, r.message);
    ({ r } = await passage(user, faux.compteEau({ connecte: false })));
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree', 'orange, lot 91 — jamais « page illisible »');
    assert.equal(outils.documents(db, user, ID).length, 3, 'rien n\'est perdu');
  });

  test('D6 — le temps permis écoulé au milieu : ce qui est pris est en base, le passage suivant prend le reste', faux.SANS_NAVIGATEUR, async () => {
    const user = await outils.compteAvec(helpers, registry, ID, 'lot102p6', faux.HOTE);
    await outils.avecLimite(30 * 60 * 1000, async () => {
      // L'horloge du connecteur n'avance qu'à chaque PDF servi : 25 minutes.
      // Budget 20 minutes (2/3 de 30) : la première facture, puis l'arrêt.
      let t = 0;
      const etat = faux.compteEau({ surPdf: () => { t += 25 * 60 * 1000; } });
      let { r, journal } = await passage(user, etat, { horloge: () => t });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '1 facture récupérée — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché. '
        + 'La récupération a pris tout le temps permis : 2 factures attendent encore ; elles viendront au prochain passage. '
        + 'Rien de ce qui a été pris n\'est perdu.');
      assert.deepEqual(journal.clics.map((c) => c.numero), [N(1)], 'le temps écoulé, plus aucun clic');
      assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id), [ANCRES[0]], 'la facture prise est EN BASE');

      t = 0;
      ({ r, journal } = await passage(user, faux.compteEau(), { horloge: () => t }));
      assert.equal(r.ok, true, r.message);
      assert.equal(r.message, '2 factures récupérées — Eau d\'Île-de-France : 3 factures lues dans l\'historique du contrat affiché, '
        + '1 déjà dans vos documents.');
      assert.deepEqual(journal.clics.map((c) => c.numero), [N(2), N(3)], 'la première n\'est pas recliquée');
      assert.deepEqual(outils.documents(db, user, ID).map((l) => l.remote_id), ANCRES, 'le reste, au passage suivant');
      outils.journalApplicatifSansDonnee(db, DONNEES);
    });
  });
});

test.after(() => {
  helpers.teardown();
});
