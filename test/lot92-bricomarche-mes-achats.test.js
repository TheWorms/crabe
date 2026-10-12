'use strict';

/**
 * Lot 92 — Bricomarché : la page « Mes achats » se lit de nouveau.
 *
 * Depuis le 05/10/2026, `/my-account` aboutit sur
 * `/my-account/orders?choiceOrder=0` (mesuré deux fois au journal de production), et
 * l'entrée de menu « Mon historique d'achats » s'appelle « Mes achats ». Le
 * connecteur cherchait ce libellé, ne le trouvait pas, et disait à
 * l'utilisateur de rouvrir une connexion qui marchait.
 *
 * ─── Lot 93 : ces essais lisent maintenant la page FIDÈLE ────────────────────
 *
 * La page reconstituée du lot 92 (test/lot92-faux-sites.js) avait été écrite
 * d'après la description d'une capture : commandes en LIEN, onglets en lien
 * avec `aria-selected`, une page par commande. Le code source réel, enregistré
 * par l'utilisateur le 06/10, a montré une autre forme (aucun lien, des boutons sans
 * adresse repérés par `data-testid`, un volet déplié) — et le connecteur du
 * lot 92 y lisait « 0 commande ». Les garanties du lot 92 restent, essai par
 * essai ; celles qui lisaient la forme inventée la lisent maintenant sur la
 * page fidèle (test/lot93-faux-sites.js). Modifiés par décision, nommés dans
 * le PROGRESS du lot 93 :
 *
 *   - les six essais D5/D6 de lecture : la page fidèle, mêmes attendus, et
 *     l'onglet « En magasin » s'ouvre par SON clic (il n'a jamais d'adresse) ;
 *   - les deux essais D7 de relevé : l'élément de facture est dans le volet
 *     déplié d'une commande, plus sur une page de commande qui n'existe pas ;
 *   - l'essai D7 « par construction » : un seul clic, sur une liste fermée
 *     de repères (le détail vit dans lot93-bricomarche-vraie-page.test.js) ;
 *   - « l'onglet se suit par SON adresse » : RETIRÉ avec `adresseOnglet` —
 *     aucun onglet n'a d'adresse ; remplacé par l'essai qui le vérifie ;
 *   - le vrai planificateur : la page fidèle pour les réussites, et le mot
 *     « capture de la commande dépliée » au lieu de « de la page de la
 *     commande ».
 *
 * Les trois essais D6 de la page illisible, des onglets renommés et du
 * renvoi vers /login passaient tels quels : ils gardent la page du lot 92.
 *
 * ─── Lot 94 : « Voir mon ticket » se clique ──────────────────────────────────
 *
 * Sur la page fidèle, un achat en magasin donne désormais son ticket de caisse
 * (un PDF, annoncé par l'utilisateur le 06/10). Modifiés par décision, nommés dans le
 * PROGRESS du lot 94 :
 *
 *   - les deux essais D5 qui lisent un achat en magasin : le résumé de la page
 *     est dans la précision (le ticket pris, le planificateur dit « 1 facture
 *     récupérée »), plus dans `aucunDocument` ;
 *   - l'essai D7 « par construction » : `documentDuClic` n'est plus interdit —
 *     il sert, une seule fois, au ticket, et à lui seul.
 *
 * ⚠ Toutes les valeurs sont inventées (numéros « ZZ… » et « 0000-… »).
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../server/connectors/registry');
const scheduler = require('../server/scheduler');
const bricomarche = require('../server/connectors/available/bricomarche/connector');
const faux = require('./lot92-faux-sites');
const fidele = require('./lot93-faux-sites');

const SOURCE = path.join(__dirname, '..', 'server', 'connectors', 'available', 'bricomarche', 'connector.js');
const R = bricomarche.REPERES;

/** La capture du 05/10 : une commande en ligne, rien en magasin. */
function etatDuCinqOctobre(extra = {}) {
  return {
    enLigne: [{ numero: 'ZZTEST0001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z' }],
    enMagasin: [],
    onglets: 'liens',
    ...extra,
  };
}

/** `surLaPageFidele` (défaut) : la page fidèle du lot 93 ; sinon la page du lot 92. */
async function passer(etat, { socle = false, ctxExtra = {}, surLaPageFidele = true } = {}) {
  const site = surLaPageFidele
    ? await fidele.ouvrirFauxSite(fidele.BRICOMARCHE, fidele.siteBricomarche(etat))
    : await faux.ouvrirFauxSite('www.bricomarche.com', faux.siteBricomarche(etat));
  const enr = faux.contexteEnregistreur(ctxExtra);
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await faux.surLeFauxProfil(site, () => bricomarche.fetchInvoices({}, enr.ctx), { socle });
    } catch (err) {
      erreur = err;
    }
    return { resultat, erreur, journal: site.journal, lignes: enr.lignes, preuves: enr.preuves };
  } finally {
    await site.fermer();
  }
}

const repereDe = (clics) => clics.map((c) => (typeof c === 'string' ? c : c.testid));

/**
 * Ce qui doit tenir à chaque passage : rien d'écrit, rien de saisi, rien de
 * sorti — et, depuis le lot 93, seuls les repères de la liste fermée se
 * cliquent (sur la page du lot 92, sans repère, rien ne se clique).
 */
function aucunGesteInterdit(journal) {
  const permis = new Set(Object.values(bricomarche.CLICS_PERMIS));
  assert.ok(repereDe(journal.clics).every((t) => permis.has(t)),
    `seuls les repères permis se cliquent — clics : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, []);
  assert.deepEqual(journal.ecritures, []);
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
}

test.before(async () => {
  await helpers.setup();
});

// ---------------------------------------------------------------------------
// D5 — la page du 05/10 est reconnue, les deux onglets sont lus
// ---------------------------------------------------------------------------

test('D5 — la page « Mes achats » du 05/10 : espace connecté reconnu, deux onglets lus, réussite à 0 document', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes, preuves } = await passer(etatDuCinqOctobre());
  assert.equal(erreur, null,
    `le passage ne doit pas échouer : ${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(resultat.invoices, [], 'aucune facture n\'est proposée : rien à déposer');
  assert.match(resultat.aucunDocument, /1 commande en ligne/, resultat.aucunDocument);
  assert.match(resultat.aucunDocument, /aucun achat en magasin/, resultat.aucunDocument);
  assert.match(resultat.aucunDocument, /aucune facture/i, resultat.aucunDocument);
  assert.doesNotMatch(resultat.aucunDocument, /rouvr|reconnect/i, 'la connexion est bonne : jamais « rouvrez »');
  assert.equal(preuves.length, 1, 'la preuve de liste reste exigée (lot 31)');
  assert.equal(preuves[0].elements, 1);
  assert.ok(journal.visites.some((v) => /choiceOrder=0&historyOrderFilter=all/.test(v)),
    'la liste est lue avec « Toutes mes commandes »');
  // Lot 93 : l'onglet « En magasin » n'a pas d'adresse sur la vraie page — il
  // s'ouvre par SON clic, et le chevron de la commande la déplie.
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin]);
  aucunGesteInterdit(journal);
  assert.match(lignes.join('\n'),
    /signes présents : adresse, titre, ongletEnLigne, ongletEnMagasin, filtre, deconnexion/);
  assert.match(lignes.join('\n'), /bilan — 1 commande\(s\) en ligne, 0 achat\(s\) en magasin, 0 élément\(s\) où une facture semble proposée, 0 détail\(s\) non déplié\(s\) ; aucun document déposé/);
});

test('D5 — plusieurs commandes sur plusieurs mois, et des achats en magasin : tout est compté', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({
    enLigne: [
      { numero: 'ZZTEST0001', mois: 'Mars 2026', dateAffichee: '12/03/2026', iso: '2026-03-12T09:30:00.000Z' },
      { numero: 'ZZTEST0002', mois: 'Mars 2026', dateAffichee: '02/03/2026', iso: '2026-03-02T09:30:00.000Z' },
      { numero: 'ZZTEST0003', mois: 'Novembre 2025', dateAffichee: '20/11/2025', iso: '2025-11-20T09:30:00.000Z' },
    ],
    enMagasin: [{ mois: 'Février 2026', dateAffichee: '02/02/2026' }],
  }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  // Lot 94 : le ticket de l'achat en magasin est pris — le résumé passe dans la précision.
  assert.equal(resultat.invoices.length, 1, 'le ticket de caisse de l\'achat en magasin');
  assert.match(resultat.precision, /3 commandes en ligne et 1 achat en magasin/,
    'la commande de 2025 compte : le filtre « Toutes mes commandes » est posé');
  aucunGesteInterdit(journal);
});

test('D5 — l\'onglet « En magasin » sans adresse : UN clic, sur lui seul, et ses achats sont lus', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({
    enMagasin: [{ mois: 'Février 2026', dateAffichee: '03/02/2026' }],
  }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.equal(repereDe(journal.clics).filter((t) => t === R.ongletEnMagasin).length, 1,
    `un seul clic sur l'onglet : ${JSON.stringify(journal.clics)}`);
  // Lot 94 : le ticket de l'achat en magasin est pris — le résumé passe dans la précision.
  assert.match(resultat.precision, /1 commande en ligne et 1 achat en magasin/);
  aucunGesteInterdit(journal);
});

test('D5 — « Toutes mes commandes » qui ne se pose pas : c\'est dit, sans échec', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal } = await passer(etatDuCinqOctobre({ filtreFige: true }));
  assert.equal(erreur, null);
  assert.match(resultat.aucunDocument, /Le filtre « Toutes mes commandes » n'a pas pu être vérifié/);
  aucunGesteInterdit(journal);
});

// ---------------------------------------------------------------------------
// D6 — un signe qui change, une vraie page de connexion, une page illisible
// ---------------------------------------------------------------------------

test('D6 — une entrée de menu renommée ne change rien : la page n\'en dépend plus', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({ menuRenomme: true }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.match(resultat.aucunDocument, /1 commande en ligne/);
  aucunGesteInterdit(journal);
});

test('D6 — le titre change : un signe sur six manque, la page est toujours reconnue', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({ titreChange: true }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.match(lignes.join('\n'), /absents : titre/);
  assert.match(resultat.aucunDocument, /1 commande en ligne/);
  aucunGesteInterdit(journal);
});

test('D6 — une page réellement illisible se dit « illisible » — jamais « rouvrez la connexion »', faux.SANS_NAVIGATEUR, async () => {
  const { erreur, journal, preuves } = await passer(etatDuCinqOctobre({ page: 'illisible' }), { surLaPageFidele: false });
  assert.ok(erreur, 'une page qu\'on ne sait pas lire ne passe pas pour une liste vide');
  assert.match(erreur.message, /n'a pas su y lire vos achats/);
  assert.match(erreur.message, /Votre connexion n'est pas en cause : inutile de la rouvrir/);
  assert.match(erreur.message, /Signalez-le/);
  assert.doesNotMatch(erreur.message, /Rouvrez la connexion/);
  assert.notEqual(erreur.sessionExpired, true, 'ce n\'est pas un refus de connexion : la cause sera « échec »');
  assert.equal(preuves.length, 0, 'aucune preuve de liste sur une liste jamais lue');
  aucunGesteInterdit(journal);
});

test('D6 — titre ET onglets changés : trois signes sur six, ce n\'est plus « Mes achats »', faux.SANS_NAVIGATEUR, async () => {
  const { erreur, journal } = await passer(etatDuCinqOctobre({ titreChange: true, onglets: 'renommes' }), { surLaPageFidele: false });
  assert.ok(erreur);
  assert.match(erreur.message, /n'a pas su y lire vos achats/);
  aucunGesteInterdit(journal);
});

test('D6 — la vraie page de connexion : un renvoi vers l\'authentification, marqué pour la règle du lot 91', faux.SANS_NAVIGATEUR, async () => {
  const { erreur, journal, lignes } = await passer(etatDuCinqOctobre({ page: 'connexion' }), { socle: true, surLaPageFidele: false });
  assert.ok(erreur, 'renvoyé vers /login : pas de liste');
  assert.equal(erreur.sessionExpired, true);
  assert.equal(erreur.renvoiAuthentification, true);
  assert.match(lignes.join('\n'), /renvoyé vers https:\/\/www\.bricomarche\.com\/login — lecture 2/);
  aucunGesteInterdit(journal);
});

// ---------------------------------------------------------------------------
// D7 — le futur bouton de facture : relevé, jamais cliqué
// ---------------------------------------------------------------------------

test('D7 — un bouton de facture dans le détail d\'une commande : AUCUN clic, libellé et nature relevés, dit à l\'utilisateur', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({ volet: 'bouton' }));
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  assert.deepEqual(repereDe(journal.clics), [R.deplier, R.ongletEnMagasin],
    `le bouton de facture n'est pas cliqué : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(resultat.invoices, []);
  const journalTexte = lignes.join('\n');
  assert.match(journalTexte, /un élément évoque une facture : « Télécharger ma facture », bouton sans adresse\. Non cliqué/);
  assert.doesNotMatch(journalTexte, /ZZTEST/, 'aucun numéro de commande au journal');
  assert.match(resultat.aucunDocument, /Une facture semble proposée pour 1 commande\(s\) \(« Télécharger ma facture »\)/);
  assert.match(resultat.aucunDocument, /crabe ne sait pas encore la récupérer et n'y a pas touché/);
  assert.match(resultat.aucunDocument, /le libellé du bouton, ce que fait son clic et une capture de la commande dépliée/);
  aucunGesteInterdit(journal);
});

test('D7 — un lien de facture avec adresse : relevé tel quel, jamais suivi', faux.SANS_NAVIGATEUR, async () => {
  const { resultat, erreur, journal, lignes } = await passer(etatDuCinqOctobre({ volet: 'lien' }));
  assert.equal(erreur, null);
  assert.deepEqual(journal.requetes.filter((v) => /invoice/.test(v)), [], 'le lien de facture n\'est pas suivi');
  assert.match(lignes.join('\n'), /« Facture \(PDF\) », lien avec adresse, marqué « télécharger »\. Non cliqué/);
  assert.match(resultat.aucunDocument, /Une facture semble proposée pour 1 commande\(s\) \(« Facture \(PDF\) »\)/);
  aucunGesteInterdit(journal);
});

test('D7 — par construction : ce fichier ne porte qu\'UN clic, sur une liste fermée de repères ; le document d\'un clic, pour le seul ticket (lot 94)', () => {
  const code = fs.readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const clics = code.match(/\.click\s*\(/g) || [];
  assert.equal(clics.length, 1, `un seul .click( dans le connecteur, trouvé ${clics.length}`);
  const corps = bricomarche.CLIQUER_PAR_REPERE.toString();
  assert.match(corps, /cible\.click\(\)/);
  const garde = corps.indexOf("cible.getAttribute('data-testid') !== attendu");
  assert.ok(garde >= 0 && garde < corps.indexOf('cible.click()'), 'le repère est recontrôlé AVANT le clic');
  for (const geste of [/\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.selectOption\s*\(/,
    /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.tap\s*\(/,
    /keyboard\./, /mouse\./, /\.locator\s*\(/, /getBy[A-Z]/, /\.accept\s*\(/]) {
    assert.doesNotMatch(code, geste, `aucun autre geste sur la page (${geste})`);
  }
  // Lot 94 : le document d'un clic se prend par le socle, une seule fois, pour le ticket seul.
  assert.equal((code.match(/documentDuClic\s*\(/g) || []).length, 1, 'un seul appel au socle du clic');
  assert.match(code, /documentDuClic\(page, context, \(\) => cliquer\(page, 'ticket', rang, carte\)/);
  assert.equal(bricomarche.ONGLET_EN_MAGASIN, 'En magasin');
  assert.ok(Object.values(bricomarche.CLICS_PERMIS).includes('account_filtered-orders_tab-instore'));
});

// ---------------------------------------------------------------------------
// Les fonctions pures
// ---------------------------------------------------------------------------

test('reconnaître « Mes achats » : quatre signes sur six suffisent, trois ne suffisent pas', () => {
  const tous = { adresse: true, titre: true, ongletEnLigne: true, ongletEnMagasin: true, filtre: true, deconnexion: true };
  assert.equal(bricomarche.reconnaitre(tous).reconnue, true);
  assert.equal(bricomarche.reconnaitre({ ...tous, titre: false }).reconnue, true);
  assert.equal(bricomarche.reconnaitre({ ...tous, titre: false, filtre: false }).reconnue, true);
  assert.equal(bricomarche.reconnaitre({ ...tous, titre: false, filtre: false, deconnexion: false }).reconnue, false);
  assert.equal(bricomarche.reconnaitre({}).reconnue, false);
});

test('aucun onglet ne se suit par une adresse devinée : la seule adresse composée est celle de la liste (lot 93)', faux.SANS_NAVIGATEUR, async () => {
  assert.equal(bricomarche.adresseOnglet, undefined, 'plus d\'adresse d\'onglet : la vraie page n\'en a pas');
  const { journal } = await passer(etatDuCinqOctobre({ enMagasin: [{ mois: 'Février 2026', dateAffichee: '03/02/2026' }] }));
  assert.deepEqual(journal.visites.filter((v) => /choiceOrder=(?!0)/.test(v)), [], 'aucun choiceOrder deviné');
  assert.ok(journal.visites.every((v) => /\/my-account(\/orders)?(\?|$)/.test(v.replace(/^[^/]+/, ''))),
    `seules l'entrée et la liste sont visitées : ${journal.visites.join(' | ')}`);
});

test('ce que l\'utilisateur lit, selon ce qui a été vu', () => {
  assert.equal(
    bricomarche.messageDuPassage({ enLigne: 1, enMagasin: 0, factures: 0, libelles: [], filtreVerifie: true }),
    'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et aucun achat en magasin. '
      + 'Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous le signalera ici.'
  );
  assert.match(
    bricomarche.messageDuPassage({ enLigne: 2, enMagasin: null, factures: 0, libelles: [], filtreVerifie: true }),
    /2 commandes en ligne et un onglet « En magasin » qui n'a pas pu être lu/
  );
});

// ---------------------------------------------------------------------------
// Ce que l'utilisateur lit, mot pour mot — par le VRAI planificateur, causes
// du lot 91 comprises
// ---------------------------------------------------------------------------

const ID_SONDE = 'sonde-lot92-bricomarche';
const SOURCE_SONDE = `'use strict';
module.exports = {
  async test() { return { ok: true, message: 'sonde' }; },
  async fetchInvoices(config, ctx) { return globalThis.__lot92b(config, ctx); },
};
`;

test('par le vrai planificateur : la réussite, la page illisible, et le renvoi classé par la règle du lot 91', faux.SANS_NAVIGATEUR, async () => {
  const db = require('../server/db/db');
  const user = await helpers.createUser({ username: 'lot92b', role: 'admin' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot92b-'));
  fs.mkdirSync(path.join(dossier, ID_SONDE));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'manifest.json'), JSON.stringify({
    id: ID_SONDE,
    name: 'Bricomarché',
    category: 'shopping',
    description: 'Sonde de test : le résultat du vrai connecteur Bricomarché, sur des pages reconstituées.',
    remoteLogin: { url: 'https://service-invente.invalid/login', marker: '' },
    fields: [{ key: 'session', label: 'Connexion', type: 'session', required: false }],
    permissions: [{ key: 'factures', scope: 'read-write', description: 'Sonde de test : aucune facture réelle.' }],
  }));
  fs.writeFileSync(path.join(dossier, ID_SONDE, 'connector.js'), SOURCE_SONDE);
  const charge = registry.load(dossier);
  assert.equal(charge.errors.length, 0, charge.errors.join(' / '));
  registry.install(user.id, ID_SONDE);
  const seConnecter = () => registry.saveConfig(user.id, ID_SONDE, {
    session: JSON.stringify({
      cookies: [{ name: 'jeton-invente', value: 'valeur-inventee', domain: 'service-invente.invalid', path: '/',
        expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [],
    }),
  }, { origine: 'fenetre' });

  const lire = async (etat, { socle = false, surLaPageFidele = true } = {}) => {
    const site = surLaPageFidele
      ? await fidele.ouvrirFauxSite(fidele.BRICOMARCHE, fidele.siteBricomarche(etat))
      : await faux.ouvrirFauxSite('www.bricomarche.com', faux.siteBricomarche(etat));
    globalThis.__lot92b = (config, ctx) => faux.surLeFauxProfil(site, () => bricomarche.fetchInvoices(config, ctx), { socle });
    try {
      const r = await scheduler.runForUser(user.id, ID_SONDE, 'manual');
      aucunGesteInterdit(site.journal);
      return r;
    } finally {
      await site.fermer();
    }
  };

  try {
    // La connexion vient d'être enregistrée (comme le 05/10 à 20:24:18).
    seConnecter();
    let r = await lire(etatDuCinqOctobre());
    assert.equal(r.ok, true, 'la connexion est bonne, la page est lue : une RÉUSSITE');
    assert.equal(r.message,
      'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et aucun achat en '
      + 'magasin. Aucune facture n\'y est encore proposée : quand une facture apparaîtra, crabe vous '
      + 'le signalera ici.');

    r = await lire(etatDuCinqOctobre({ volet: 'bouton' }));
    assert.equal(r.ok, true);
    assert.equal(r.message,
      'Votre espace client Bricomarché a bien été lu : 1 commande en ligne et aucun achat en '
      + 'magasin. Une facture semble proposée pour 1 commande(s) (« Télécharger ma facture ») : crabe '
      + 'ne sait pas encore la récupérer et n\'y a pas touché. Signalez-le, avec le libellé du bouton, '
      + 'ce que fait son clic et une capture de la commande dépliée : c\'est ce qui permettra '
      + 'd\'écrire la suite.');

    r = await lire(etatDuCinqOctobre({ page: 'illisible' }), { surLaPageFidele: false });
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'echec', 'une page illisible est un échec — pas un refus de connexion');
    assert.equal(r.message,
      'Échec — Bricomarché a bien ouvert votre espace client, mais crabe n\'a pas su y lire vos '
      + 'achats : la page ne ressemble plus à celle qu\'il connaît (« Mes achats », avec les onglets '
      + '« En ligne » et « En magasin »). Votre connexion n\'est pas en cause : inutile de la '
      + 'rouvrir. Signalez-le pour que la lecture soit mise à jour ; la prochaine récupération '
      + 'réessaiera d\'elle-même.');

    // Une connexion enregistrée à l'instant, puis le renvoi : connexion refusée.
    seConnecter();
    r = await lire(etatDuCinqOctobre({ page: 'connexion' }), { socle: true, surLaPageFidele: false });
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'connexion-refusee');

    // La même, vieillie de neuf jours après une réussite : session expirée.
    db.get().prepare('UPDATE connexions_enregistrees SET at = datetime(at, ?) WHERE connector_id = ?')
      .run('-9 days', ID_SONDE);
    db.get().prepare('UPDATE run_logs SET started_at = datetime(started_at, ?), finished_at = datetime(finished_at, ?) WHERE connector_id = ?')
      .run('-8 days', '-8 days', ID_SONDE);
    r = await lire(etatDuCinqOctobre({ page: 'connexion' }), { socle: true, surLaPageFidele: false });
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'session-expiree');
  } finally {
    delete globalThis.__lot92b;
    fs.rmSync(dossier, { recursive: true, force: true });
    registry.load();
  }
});

test.after(() => {
  helpers.teardown();
});
