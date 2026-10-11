'use strict';

/**
 * Lot 94 — Gandi : la liste des organisations est à `/organizations`.
 *
 * Mesuré au journal de production le 06/10/2026 : connecté, `/billing` ne
 * sert pas la liste, il renvoie vers `/billing/<organisation>`, puis vers
 * `/billing/<organisation>/organizations` (200). Le connecteur du lot 93 ne
 * reconnaissait la liste qu'à `/billing` : la découverte qui suit la
 * connexion a échoué deux fois, « page illisible » (docs/reconnaissance-lot94.md).
 *
 * Ces essais tournent au VRAI Chromium sur le faux Gandi du lot 93, servi à
 * l'adresse mesurée (test/lot94-faux-sites.js) : chaque saut se fait par la
 * page, aucune réponse n'est une redirection HTTP, rien ne sort. Ils prouvent
 * la lecture de cette forme, pas le vrai site — tout ce qui suit la liste
 * (pages de factures, pagination, PDF) reste celui des pages reconstituées du
 * lot 93.
 *
 * Le lancement d'un vrai navigateur est INTERDIT pendant les passages qui
 * vont par le registre (leçon du lot 93) : seul le faux lanceur, posé sur
 * l'instance que le registre exécute, peut en ouvrir un.
 *
 * ⚠ Toutes les valeurs sont inventées : organisations « Organisation d'essai
 * … », identifiants faits de zéros, numéros « ZZ… », montants à 0,00 €.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db/db');
const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const destinations = require('../server/destinations');
const gandi = require('../server/connectors/available/gandi/connector');
const faux = require('./lot94-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'gandi', 'connector.js');
const HOTES = [faux.GANDI_ADMIN, faux.GANDI_ID];
const ORG = (n) => faux.idOrganisation(n);

/** La ligne de jugement que la production a écrite, deux fois, le 06/10. */
const LIGNE_DU_SIX_OCTOBRE = 'gandi : arrivée jugée « page-illisible » — arrivé sur /billing/…/organizations, qui n\'est pas la facturation.';

/** Un passage DIRECT (hors registre) d'une fonction du connecteur sur le faux site. */
async function passer(etat, { fonction = 'fetchInvoices', config = {}, ctxExtra = {} } = {}) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandiMesure(etat));
  const original = gandi.ouverture.lancer;
  gandi.ouverture.lancer = banc.lancer;
  const lignes = [];
  const preuves = [];
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await gandi[fonction](
        { session: faux.sessionInventee(), historique: 'depuis', ...config },
        { userId: 1, log: (m) => lignes.push(String(m)), preuveDeListe: (p) => preuves.push(p), knownRemoteIds: [], ...ctxExtra }
      );
    } catch (err) {
      erreur = err;
    }
    assert.ok(banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
    return { resultat, erreur, journal: banc.journal, lignes, preuves, ouverts: banc.ouverts() };
  } finally {
    gandi.ouverture.lancer = original;
    await banc.fermer();
  }
}

/** À chaque passage : rien de cliqué, rien de saisi, rien de sorti, rien d'interdit visité. */
function rienQueDesNavigations(journal, etat) {
  assert.deepEqual(journal.clics, [], `aucun clic — la page les compte : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, [], 'aucune saisie');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.equal(etat.compteurs.deconnexion, 0, '/billing/api/v5/logout n\'est jamais approché');
  for (const v of journal.visites) {
    assert.doesNotMatch(v, /logout|cart|autorenew|settings|prepaid|orders|overview|sort=|statut=/,
      `visite hors du parcours : ${v}`);
  }
}

/** Ce qu'aucun journal ne doit porter : un nom ou un identifiant d'organisation. */
function journalMuet(texte) {
  assert.doesNotMatch(texte, /Organisation d'essai/, 'aucun nom d\'organisation au journal');
  assert.doesNotMatch(texte, /00000000-0000-4000-8000/, 'aucun identifiant d\'organisation au journal');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D1 — la chaîne mesurée : la liste est lue, les factures prises
// ---------------------------------------------------------------------------

test('D1 — la chaîne du 06/10 (session de facturation à rouvrir) : la liste à /organizations est lue, trois organisations, 62 factures prises', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ sessionFacturation: false });
  const { resultat, erreur, journal, lignes, preuves, ouverts } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  // La chaîne, dans l'ordre où la production l'a écrite.
  const chemins = lignes.filter((l) => l.startsWith('gandi : navigation — ')).map((l) => l.replace(/^gandi : navigation — \d+ /, '').replace(/ ;.*$/, ''));
  assert.deepEqual(chemins.slice(0, 7), [
    'admin.gandi.net /billing',
    'admin.gandi.net /billing/api/v5/login',
    'id.gandi.net /fr/authorize',
    'admin.gandi.net /billing/api/v5/login',
    'admin.gandi.net /billing',
    'admin.gandi.net /billing/…',
    'admin.gandi.net /billing/…/organizations',
  ]);
  assert.match(texte, /gandi : arrivée jugée « liste » — 3 organisation\(s\) affichée\(s\)\./);
  assert.doesNotMatch(texte, /page-illisible/);
  assert.equal(etat.compteurs.liste, 1, 'la liste a été servie une fois, à /organizations');
  assert.ok(journal.visites.some((v) => v.endsWith(`/billing/${ORG(1)}/organizations`)), 'la liste a bien été lue à son adresse mesurée');
  assert.equal(resultat.invoices.length, 62);
  assert.deepEqual([...new Set(resultat.invoices.map((f) => f.accountId))].sort(), [ORG(1), ORG(2), ORG(3)]);
  assert.equal(new Set(resultat.invoices.map((f) => f.filename)).size, 62);
  assert.equal(resultat.precision, '— Gandi : 3 organisations lues, 62 factures vues.');
  assert.equal(preuves.length, 1);
  assert.equal(ouverts, 0, 'le connecteur a refermé son navigateur');
  journalMuet(texte);
  rienQueDesNavigations(journal, etat);
});

test('D1 — la découverte qui suit la connexion (ce que l\'utilisateur a vu échouer) : trois organisations, par leur nom, « Moi » dit', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ sessionFacturation: false });
  const { resultat, erreur, journal, lignes } = await passer(etat, { fonction: 'discover' });
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(resultat.items.map((i) => i.label), ['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C']);
  assert.deepEqual(resultat.items.map((i) => i.id), [ORG(1), ORG(2), ORG(3)]);
  assert.equal(resultat.items[0].detail, 'Votre organisation personnelle');
  assert.match(lignes.join('\n'), /arrivée jugée « liste » — 3 organisation\(s\) affichée\(s\)\.\ngandi : 3 organisation\(s\) découverte\(s\)\./);
  journalMuet(lignes.join('\n'));
  rienQueDesNavigations(journal, etat);
});

test('D1 — le test de connexion passe aussi par la liste mesurée', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  const { resultat, erreur } = await passer(etat, { fonction: 'test' });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.ok, true);
  assert.equal(resultat.accountId, ORG(1));
  assert.match(resultat.message, /^Connexion valide — 3 organisations visibles dans votre facturation Gandi\./);
});

// ---------------------------------------------------------------------------
// D2 — /billing direct, adresse inattendue, vraie page inconnue
// ---------------------------------------------------------------------------

test('D2 — la liste servie directement à /billing (un compte servi ainsi) : lue comme au lot 93', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ liste: 'billing' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 62);
  assert.match(lignes.join('\n'), /arrivée jugée « liste » — 3 organisation\(s\) affichée\(s\)\./);
  assert.ok(!journal.visites.some((v) => /organizations/.test(v)), 'aucune étape par /organizations');
  rienQueDesNavigations(journal, etat);
});

test('D2 — une adresse inattendue dont la page EST la liste : lue quand même, et l\'écart est dit au journal', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ liste: 'inattendue' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  const texte = lignes.join('\n');
  assert.equal(erreur, null, `${erreur?.message}\n${texte}`);
  assert.equal(resultat.invoices.length, 62);
  assert.match(texte, /gandi : arrivée jugée « liste » — écart : adresse inattendue \/billing\/…\/choisir, mais la page est la liste des organisations \(titre « Choisir une organisation », titre principal « Facturation », 3 lien\(s\) d'organisation\) — lue quand même\./);
  journalMuet(texte);
  rienQueDesNavigations(journal, etat);
});

test('D2 — une vraie page inconnue (même avec un lien vers une organisation) : « page illisible », sans renvoi ni « rouvrez »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ liste: 'inconnue' });
  for (const fonction of ['fetchInvoices', 'discover']) {
    const { erreur, journal, lignes, preuves } = await passer(etat, { fonction });
    assert.ok(erreur, `${fonction} : une page inconnue n'est jamais lue comme une liste`);
    assert.match(erreur.message, /a bien ouvert votre facturation, mais crabe n'a pas su la lire/);
    assert.match(erreur.message, /Votre connexion n'est pas en cause : inutile de la rouvrir/);
    assert.notEqual(erreur.sessionExpired, true);
    assert.match(lignes.join('\n'), /arrivée jugée « page-illisible » — arrivé sur \/billing\/…\/accueil, qui n'est pas la facturation\./);
    assert.equal(preuves.length, 0);
    assert.ok(!journal.visites.some((v) => /invoices/.test(v)), `${fonction} : rien n'a été lu au-delà`);
    rienQueDesNavigations(journal, etat);
  }
});

test('D2 — la liste à /organizations sans aucune organisation reconnaissable : « page illisible »', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai({ listeIllisible: true });
  const { erreur, lignes } = await passer(etat);
  assert.ok(erreur);
  assert.match(lignes.join('\n'), /arrivée jugée « page-illisible » — la page « Facturation » ne montre aucune organisation reconnaissable\./);
});

test('D2 — le jugement, fonction pure : les deux adresses de la liste, la page qui tranche ailleurs, jamais au-delà de /billing/', () => {
  const o = ORG(1);
  const liste = { titreListe: true, h1Facturation: true };
  const juger = (chemin, organisations, page = null) => gandi.jugerArrivee({ urlFinale: `https://admin.gandi.net${chemin}`, organisations, page });
  assert.equal(juger(`/billing/${o}/organizations`, 3).verdict, 'liste', 'l\'adresse mesurée');
  assert.equal(juger(`/billing/${o}/organizations/`, 3).verdict, 'liste');
  assert.equal(juger('/billing', 3).verdict, 'liste', '/billing reste accepté');
  assert.equal(juger(`/billing/${o}/organizations`, 0).verdict, 'page-illisible', 'sans organisation, ce n\'est pas une liste');
  assert.equal(juger('/billing/api/organizations', 3).verdict, 'connexion-demandee', 'le passage de connexion n\'est jamais une liste');
  assert.equal(juger(`/billing/${o}/overview`, 1).verdict, 'organisation-unique', 'inchangé depuis le lot 93');
  // Ailleurs sous /billing/ : la page tranche.
  const ecart = juger(`/billing/${o}/choisir`, 3, liste);
  assert.equal(ecart.verdict, 'liste');
  assert.equal(ecart.ecart, true);
  assert.doesNotMatch(ecart.raison, new RegExp(o), 'l\'identifiant est masqué');
  assert.equal(juger(`/billing/${o}`, 2, { titreListe: true }).verdict, 'liste', 'le titre seul et des liens');
  assert.equal(juger(`/billing/${o}`, 2, { h1Facturation: true }).verdict, 'liste', 'le titre principal seul et des liens');
  assert.equal(juger(`/billing/${o}/accueil`, 1, { titreListe: false, h1Facturation: false }).verdict, 'page-illisible',
    'des liens seuls ne font pas une liste');
  assert.equal(juger(`/billing/${o}/choisir`, 0, liste).verdict, 'page-illisible', 'un titre sans lien non plus');
  assert.equal(juger(`/billing/${o}/choisir`, 3, null).verdict, 'page-illisible', 'sans regard sur la page, rien n\'est supposé');
  assert.equal(juger('/dashboard', 3, liste).verdict, 'page-illisible', 'hors de /billing/, jamais');
  assert.equal(gandi.jugerArrivee({ urlFinale: `https://shop.gandi.net/billing/${o}/organizations`, organisations: 3, page: liste }).verdict,
    'page-illisible', 'un autre hôte, jamais');
  assert.equal(gandi.jugerArrivee({ urlFinale: 'https://id.gandi.net/fr/login', organisations: 3, page: liste }).verdict, 'connexion-demandee');
});

// ---------------------------------------------------------------------------
// D3 — le journal muet, aucun geste
// ---------------------------------------------------------------------------

test('D3 — par construction : toujours aucun geste dans le fichier, une seule navigation, aucun client HTTP à part', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const geste of [/\.click\s*\(/, /\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/,
    /\.check\s*\(/, /\.uncheck\s*\(/, /\.selectOption\s*\(/, /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/,
    /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/, /\.hover\s*\(/, /\.focus\s*\(/, /keyboard\./,
    /mouse\./, /touchscreen\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.\$\$?\s*\(/, /\.accept\s*\(/,
    /waitForEvent\s*\(\s*['"]download/]) {
    assert.doesNotMatch(code, geste, `aucun geste sur la page (${geste})`);
  }
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'une seule fonction navigue');
  assert.doesNotMatch(code, /context\.request|request\.get|require\(['"]node:https?['"]\)|globalThis\.fetch|ctx\.fetch/);
});

test('D3 — le masquage : un identifiant d\'organisation, dans l\'adresse de la liste comme ailleurs, ne s\'écrit jamais', () => {
  assert.equal(gandi.masquer(`200 admin.gandi.net /billing/${ORG(1)}/organizations`), '200 admin.gandi.net /billing/…/organizations');
  assert.equal(gandi.masquer(`302 admin.gandi.net /billing → admin.gandi.net /billing/${ORG(1)}`), '302 admin.gandi.net /billing → admin.gandi.net /billing/…');
  assert.equal(gandi.masquer('302 admin.gandi.net /billing/api/v5/login'), '302 admin.gandi.net /billing/api/v5/login');
});

// ---------------------------------------------------------------------------
// R5 — la ponctuation qui ne se double plus
// ---------------------------------------------------------------------------

test('R5 — la précision perd son tiret quand le message du planificateur a déjà fini sa phrase', () => {
  const base = { organisationsLues: 3, facturesVues: 62, sansFacture: 0, illisibles: 0, bornePages: 0,
    restantes: 0, interruption: null, nouvellesRetenues: 0, nouvellesIgnorees: 0, disparues: 0 };
  assert.equal(gandi.precisionDuPassage(base), '— Gandi : 3 organisations lues, 62 factures vues.', 'inchangé par défaut');
  assert.equal(gandi.precisionDuPassage(base, { sansTiret: true }), 'Gandi : 3 organisations lues, 62 factures vues.');
  assert.equal(gandi.precisionDuPassage({ ...base, sansFacture: 1 }, { sansTiret: true }),
    'Gandi : 3 organisations lues, 62 factures vues. Une organisation n\'a aucune facture.');
});

test('R5 — un document qui n\'est pas un PDF : la sortie demande la phrase sans tiret', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteGandiDEssai();
  etat.pdfHtml = ['ZZB008999'];
  const { resultat, erreur } = await passer(etat);
  assert.equal(erreur, null);
  assert.equal(resultat.manquees, 1);
  assert.equal(resultat.precision, 'Gandi : 3 organisations lues, 62 factures vues.');
});

// ---------------------------------------------------------------------------
// Par le VRAI planificateur, et par la VRAIE route de découverte
// ---------------------------------------------------------------------------

/** L'instance que le REGISTRE exécute — pas celle du `require` ci-dessus (lot 93). */
const instanceDuRegistre = () => registry.get('gandi').module;

async function compteAvecGandi(nom) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, 'gandi');
  registry.saveConfig(user.id, 'gandi', { session: faux.sessionInventee() }, { origine: 'fenetre' });
  return user;
}

/** Branche le faux site sur l'instance du registre, le temps de `corps`. */
async function surLeBanc(etat, corps) {
  const banc = faux.lanceurFaux(HOTES, faux.siteGandiMesure(etat));
  const instance = instanceDuRegistre();
  const original = instance.ouverture.lancer;
  instance.ouverture.lancer = banc.lancer;
  try {
    const r = await corps();
    assert.ok(banc.lancements() >= 1, 'le FAUX navigateur a servi, aucun autre');
    rienQueDesNavigations(banc.journal, etat);
    return { r, journal: banc.journal };
  } finally {
    instance.ouverture.lancer = original;
    await banc.fermer();
  }
}

function journalDe(user) {
  return db.get().prepare("SELECT message FROM app_logs WHERE user_id = ? OR source LIKE 'connector:gandi%' OR source = 'scheduler' ORDER BY id")
    .all(user.id).map((l) => l.message).join('\n');
}

test.describe('par le vrai planificateur et la vraie route', () => {
  let lancementReel;
  let scrapingAvant;
  test.before(() => {
    const configuration = require('../server/config').config;
    scrapingAvant = configuration.scrapingDisabled;
    configuration.scrapingDisabled = false;
    lancementReel = instanceDuRegistre().ouverture.lancer;
    instanceDuRegistre().ouverture.lancer = () => {
      throw new Error('essai : lancement d\'un vrai navigateur interdit — le faux site n\'a pas été branché');
    };
    destinations.restoreLocal();
  });
  test.after(() => {
    require('../server/config').config.scrapingDisabled = scrapingAvant;
    instanceDuRegistre().ouverture.lancer = lancementReel;
  });

  test('D1 — runForUser sur la chaîne mesurée : 62 factures déposées, rangées par organisation ; le second passage ne reprend rien', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot94g1');
    let { r } = await surLeBanc(faux.compteGandiDEssai({ sessionFacturation: false }), () => scheduler.runForUser(user.id, 'gandi', 'manual'));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, '62 factures récupérées — Gandi : 3 organisations lues, 62 factures vues.');
    const lignes = db.get().prepare('SELECT filename, account_id FROM invoices WHERE user_id = ? AND connector_id = ?').all(user.id, 'gandi');
    assert.equal(lignes.length, 62);
    assert.deepEqual([...new Set(lignes.map((l) => l.account_id))].sort(), [ORG(1), ORG(2), ORG(3)]);

    ({ r } = await surLeBanc(faux.compteGandiDEssai(), () => scheduler.runForUser(user.id, 'gandi', 'manual')));
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Aucune nouvelle facture — Gandi : 3 organisations lues, 62 factures vues.');
    const texte = journalDe(user);
    assert.match(texte, /gandi : arrivée jugée « liste » — 3 organisation\(s\) affichée\(s\)\./);
    assert.doesNotMatch(texte, /page-illisible/);
    journalMuet(texte);
  });

  test('R5 — par le planificateur : « … les réessaiera. Gandi : … », la ponctuation n\'est plus doublée', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot94g2');
    const etat = faux.compteGandiDEssai();
    etat.pdfHtml = ['ZZB008999'];
    const { r } = await surLeBanc(etat, () => scheduler.runForUser(user.id, 'gandi', 'manual'));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message,
      '61 factures récupérées, 1 non obtenue — le prochain passage les réessaiera. Gandi : 3 organisations lues, 62 factures vues.');
    assert.doesNotMatch(r.message, /\. —/);
  });

  test('D1 — la VRAIE route POST /api/connectors/gandi/discover : « Connexion réussie, mais la recherche a échoué » ne se reproduit pas', faux.SANS_NAVIGATEUR, async () => {
    const user = await compteAvecGandi('lot94g3');
    const client = await helpers.startServer();
    try {
      const connexion = await helpers.login(client, 'lot94g3', 'MotDePasse1');
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      const { r } = await surLeBanc(faux.compteGandiDEssai({ sessionFacturation: false }),
        () => client.post('/api/connectors/gandi/discover'));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.items.map((i) => i.label), ['Organisation d\'essai A', 'Organisation d\'essai B', 'Organisation d\'essai C']);
      assert.equal(r.body.field.key, 'organisations');
      assert.equal(r.body.field.toutCocher, true);
      // La découverte est mémorisée : la fiche montrera les trois organisations.
      const resume = registry.configSummary(user.id, 'gandi').discoveries.organisations;
      assert.deepEqual(resume.items.map((i) => i.id), [ORG(1), ORG(2), ORG(3)]);
      journalMuet(journalDe(user));
    } finally {
      await client.close();
    }
  });

  test('D1 — la route, sur une vraie page inconnue : l\'échec est dit, sans « session expirée »', faux.SANS_NAVIGATEUR, async () => {
    await compteAvecGandi('lot94g4');
    const client = await helpers.startServer();
    try {
      await helpers.login(client, 'lot94g4', 'MotDePasse1');
      const { r } = await surLeBanc(faux.compteGandiDEssai({ liste: 'inconnue' }), () => client.post('/api/connectors/gandi/discover'));
      assert.equal(r.status, 502);
      assert.match(r.body.error, /a bien ouvert votre facturation, mais crabe n'a pas su la lire/);
      assert.equal(r.body.sessionExpired, false);
    } finally {
      await client.close();
    }
  });
});

test.after(() => {
  helpers.teardown();
});
