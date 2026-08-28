'use strict';

/**
 * Lot 47 — sept ébauches de connecteurs marchands.
 *
 * Ces connecteurs n'ont JAMAIS vu la liste des commandes de leur enseigne : la
 * reconnaissance s'est faite en visiteur anonyme (docs/reconnaissance-lot47.md).
 * Ce que ces tests protègent, c'est l'HONNÊTETÉ du squelette :
 *
 *   1. les sept fiches existent, en attente (`pending`), avec de quoi ouvrir
 *      une connexion (remoteLogin + profil persistant) — et l'administrateur
 *      les voit dans le Store ;
 *   2. lancée, une ébauche DÉCLARE la liste (preuveDeListe) et dit au journal
 *      et à l'écran que le parcours des documents n'est pas écrit — jamais un
 *      « aucune nouvelle facture » muet ;
 *   3. une session absente se dit comme telle (sessionExpired), selon le
 *      régime que la mesure autorise : redirection mesurée (Decathlon, LDLC,
 *      Electro Dépôt, VistaPrint — et, depuis les sondes du lot 48, Darty et
 *      Bricomarché) ou preuve forte exigée (Boulanger, dont la coquille
 *      d'application est servie à tout le monde) ;
 *   4. le mur de Darty — un 403 habillé en page « Maintenance » — est reconnu
 *      comme le mur, pas comme une panne du site.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const profilMarchand = require('../server/connectors/profil-marchand');

/**
 * Les sept enseignes, avec l'écran d'authentification MESURÉ de chacune et le
 * régime de preuve que la reconnaissance autorise (`redirigeMesure`).
 */
const SERVICES = [
  { id: 'decathlon', urlAuth: 'https://login.decathlon.net/?client_id=x&ui_locales=fr_FR#/sign-in', redirigeMesure: true },
  // Lot 48 : le mur de Darty s'est levé pour la sonde anonyme — la redirection
  // de /espace_client/mes-commandes vers /authentification/login est MESURÉE,
  // témoin 404 franc.
  { id: 'darty', urlAuth: 'https://www.darty.com/authentification/login?goto=x', redirigeMesure: true },
  { id: 'boulanger', urlAuth: 'https://www.boulanger.com/connexion', redirigeMesure: false },
  { id: 'ldlc', urlAuth: 'https://secure2.ldlc.com/fr-fr/Login/Login?returnUrl=%2Ffr-fr%2FOrders', redirigeMesure: true },
  { id: 'electro-depot', urlAuth: 'https://www.electrodepot.fr/customer/account/login/', redirigeMesure: true },
  // Lot 48 : /connexion est un 404 — la vraie page est /login, et /my-account
  // redirige les anonymes (mesuré).
  { id: 'bricomarche', urlAuth: 'https://www.bricomarche.com/login', redirigeMesure: true },
  { id: 'vistaprint', urlAuth: 'https://account.vista.com/login?state=abc', redirigeMesure: true },
];

const connecteurs = Object.fromEntries(
  SERVICES.map((s) => [s.id, require(`../server/connectors/available/${s.id}/connector`)])
);

let admin;
let client;

test.before(async () => {
  await helpers.setup();
  admin = await helpers.createUser({ username: 'lot47', role: 'admin' });
  client = await helpers.startServer();
  await helpers.login(client, 'lot47', 'MotDePasse1');
});

test.after(async () => {
  await client.close();
  helpers.teardown();
});

// ---------------------------------------------------------------------------
// Fausse page et faux profil
// ---------------------------------------------------------------------------

/**
 * Une page simulée : `photographier` reçoit la vue telle quelle, le contrôle
 * de fausse maintenance (Darty) reçoit `vue.fausseMaintenance`, et
 * `preuve-connexion` compte ses sélecteurs dans `vue.selecteursPresents`.
 */
function fakePage(vue) {
  return {
    url: () => vue.url,
    evaluate: async (fn, arg) => {
      // Le contrôle de fausse maintenance (Darty) passe SON motif et attend un
      // booléen ; le chercheur de marqueurs mesurés (lot 49) passe {sel, motif}
      // et attend un booléen lui aussi — il se juge sur `selecteursPresents`,
      // comme les sélecteurs de preuve-connexion. Tout le reste est
      // `photographier`, qui reçoit la vue telle quelle.
      if (arg === connecteurs.darty.MOTIF_FAUSSE_MAINTENANCE.source) {
        return !!vue.fausseMaintenance;
      }
      if (arg && typeof arg === 'object' && 'sel' in arg && 'motif' in arg) {
        return (vue.selecteursPresents || []).some((s) => String(arg.sel || '').includes(s));
      }
      return vue;
    },
    locator: (selecteur) => ({
      count: async () =>
        (vue.selecteursPresents || []).some((s) => selecteur.includes(s)) ? 1 : 0,
    }),
  };
}

/** Remplace l'ouverture du profil par la page simulée, le temps d'un appel. */
async function surProfilSimule(vue, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(fakePage(vue), {});
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

/** Un contexte d'exécution qui enregistre journal et preuve de liste. */
function contexteEnregistreur() {
  const journal = [];
  const preuves = [];
  return {
    ctx: {
      userId: 1,
      log: (m) => journal.push(String(m)),
      preuveDeListe: (info) => preuves.push(info),
    },
    journal,
    preuves,
  };
}

// ---------------------------------------------------------------------------
// 1. Les sept fiches existent, en attente, prêtes à ouvrir une connexion
// ---------------------------------------------------------------------------

test('les sept ébauches sont chargées : pending, remoteLogin persistant, session facultative', () => {
  registry.load();
  for (const { id } of SERVICES) {
    const manifest = registry.manifest(id);
    assert.ok(manifest, `${id} doit être chargé depuis available/`);
    assert.equal(manifest.initialStatus, 'pending',
      `${id} : jamais validé contre un compte réel, il naît en attente`);
    assert.ok(manifest.remoteLogin, `${id} : sans remoteLogin, pas de bouton « Se connecter »`);
    assert.equal(manifest.remoteLogin.persistent, true,
      `${id} : la session vit dans un profil de navigateur persistant`);
    assert.match(manifest.remoteLogin.verifyUrl, /^https:\/\//,
      `${id} : sans page de contrôle, l'enregistrement de session est refusé (hotfix du 18/08)`);
    const session = manifest.fields.find((f) => f.type === 'session');
    assert.ok(session, `${id} : la capture doit avoir où s'enregistrer`);
    assert.equal(session.required, false,
      `${id} : un champ que seule la capture remplit ne peut pas être exigé`);
    const module_ = registry.get(id).module;
    assert.equal(typeof module_.test, 'function');
    assert.equal(typeof module_.fetchInvoices, 'function');
  }
});

test('les sept régimes de preuve suivent la mesure : verifyUrlTient là où la redirection est mesurée', () => {
  for (const { id, redirigeMesure } of SERVICES) {
    assert.equal(registry.manifest(id).remoteLogin.verifyUrlTient, redirigeMesure,
      `${id} : « rester sur la page prouve la session » ne se déclare que mesuré — et se `
        + 'déclare quand il l\'est (sinon le contrôle retombe sur des marqueurs que ces sites '
        + 'n\'affichent peut-être pas)');
  }
});

test('les annonces des sept ont bien quitté planned/ — sinon le registre refuserait le connecteur', () => {
  const planned = path.join(__dirname, '..', 'server', 'connectors', 'planned');
  for (const { id } of SERVICES) {
    assert.equal(fs.existsSync(path.join(planned, id)), false,
      `${id} : une annonce résiduelle ressusciterait au prochain gen-planned et casserait le chargement`);
  }
  // Et gen-planned ne sait plus les régénérer.
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gen-planned.js'), 'utf8');
  for (const { id } of SERVICES) {
    assert.equal(new RegExp(`id: '${id}'`).test(source), false,
      `${id} : l'entrée de gen-planned.js doit être purgée (piège Materiel.net, lot 36)`);
  }
});

test('l\'administrateur voit les sept fiches dans le Store, avec de quoi se connecter', async () => {
  const res = await client.get('/api/connectors');
  assert.equal(res.status, 200);
  for (const { id } of SERVICES) {
    const fiche = (res.body.connectors || []).find((c) => c.id === id);
    assert.ok(fiche, `${id} : la fiche doit apparaître pour l'administrateur`);
    assert.equal(fiche.planned, false, `${id} : ce n'est plus une annonce`);
    assert.equal(fiche.catalogStatus, 'pending', `${id} : en attente, invisible aux comptes ordinaires`);
    assert.ok(fiche.remoteLogin && fiche.remoteLogin.url,
      `${id} : c'est remoteLogin qui fait naître le bouton « Se connecter à … » sur la fiche`);
  }
});

// ---------------------------------------------------------------------------
// 2. Lancée, l'ébauche déclare la liste et dit que le parcours n'est pas écrit
// ---------------------------------------------------------------------------

test('chaque ébauche dépose la preuve de liste et s\'arrête en le disant — jamais un « aucune nouvelle facture » muet', async () => {
  for (const { id, redirigeMesure } of SERVICES) {
    // Boulanger n'est PLUS une ébauche : le lot 50 a écrit son parcours des
    // documents, ses tests vivent dans lot50-recuperation-et-verite.test.js.
    if (id === 'boulanger') continue;
    // VistaPrint non plus : le lot 51 a écrit le sien (mesuré par sonde le
    // 23/08/2026), ses tests vivent dans lot51-vistaprint-recupere.test.js.
    if (id === 'vistaprint') continue;
    // Darty non plus : trois lectures de liste espacées sur 61 minutes ont
    // tenu (23/08/2026) et le lot 51 a écrit son parcours — ses tests vivent
    // dans lot51-darty-recupere.test.js.
    if (id === 'darty') continue;
    // LDLC non plus : le lot 52 a réparé son ancre (l'identifiant d'adresse,
    // jamais le numéro de suivi) et écrit son parcours — ses tests vivent
    // dans lot52-ldlc-recupere.test.js.
    if (id === 'ldlc') continue;
    // Decathlon n'est plus une ébauche muette : le lot 52 a trouvé sa liste
    // (/account/myPurchase) et MESURÉ qu'aucun document n'est servi
    // directement — ses tests vivent dans lot52-decathlon-electro.test.js.
    if (id === 'decathlon') continue;
    const connecteur = connecteurs[id];
    const { ctx, journal, preuves } = contexteEnregistreur();
    const vue = {
      url: connecteur.URL_COMMANDES,
      boutonSeConnecter: false,
      reperes: 3,
      libelles: ['Mes commandes', 'Se déconnecter'],
      // Le régime « preuve dans la page » exige un marqueur (le lien de
      // déconnexion générique suffit ici) ; le régime « redirection mesurée »
      // n'en a pas besoin.
      selecteursPresents: redirigeMesure ? [] : ['logout'],
    };
    const resultat = await surProfilSimule(vue, () => connecteur.fetchInvoices({}, ctx));

    assert.deepEqual(resultat.invoices, [], `${id} : une ébauche ne récupère RIEN`);
    assert.equal(preuves.length, 1,
      `${id} : sans preuveDeListe, le socle refuserait ce zéro-document — et il aurait raison`);
    assert.equal(preuves[0].liste, connecteur.URL_COMMANDES);
    assert.equal(preuves[0].elements, 3);
    assert.match(resultat.aucunDocument, /n'est pas encore écrite dans crabe/,
      `${id} : l'écran doit dire pourquoi rien n'est descendu, pas « aucune nouvelle facture »`);
    const lignes = journal.join('\n');
    assert.match(lignes, /parcours des documents n'est pas encore écrit/,
      `${id} : le journal doit le dire à chaque passage`);
    assert.match(lignes, /jamais\s+.{0,20}vérifié sur un compte réel/,
      `${id} : le compte de repères est un indice, le journal ne doit pas le vendre pour une mesure`);
  }
});

test('test() rend le même verdict honnête : connexion valide, récupération pas écrite', async () => {
  // Bricomarché est la dernière ébauche au message générique : LDLC récupère
  // (lot 52), Decathlon et Électro Dépôt disent leur situation mesurée.
  const connecteur = connecteurs.bricomarche;
  const vue = { url: connecteur.URL_COMMANDES, boutonSeConnecter: false, reperes: 2, libelles: [] };
  const resultat = await surProfilSimule(vue, () => connecteur.test({}, { userId: 1, log: () => {} }));
  assert.equal(resultat.ok, true);
  assert.match(resultat.message, /n'est pas encore écrite/);
});

// ---------------------------------------------------------------------------
// 3. Une session absente se dit comme telle, selon le régime mesuré
// ---------------------------------------------------------------------------

test('renvoyé vers son écran de connexion, chaque ébauche dit « session expirée » — jamais « rien à récupérer »', async () => {
  for (const { id, urlAuth } of SERVICES) {
    const connecteur = connecteurs[id];
    const { ctx, preuves } = contexteEnregistreur();
    const vue = { url: urlAuth, boutonSeConnecter: false, reperes: 0, libelles: [] };
    await assert.rejects(
      () => surProfilSimule(vue, () => connecteur.fetchInvoices({}, ctx)),
      (err) => {
        assert.equal(err.sessionExpired, true,
          `${id} : le geste attendu est « Se connecter », le message doit le porter`);
        assert.match(err.message, /Se connecter|connexion/i);
        return true;
      }
    );
    assert.equal(preuves.length, 0, `${id} : aucune preuve de liste sur une liste non atteinte`);
  }
});

test('quand la redirection n\'a pas pu être mesurée, rester sur l\'adresse ne suffit PAS : preuve forte ou refus', async () => {
  // Lot 48 : Darty et Bricomarché sont passés au régime « redirection
  // mesurée » (sondes du 23/08/2026) — seul Boulanger, dont la coquille
  // d'application est servie à tout le monde, exige encore la preuve forte.
  for (const id of ['boulanger']) {
    const connecteur = connecteurs[id];
    // La page tient l'adresse, aucun bouton « Se connecter »… et AUCUN lien de
    // déconnexion : exactement ce qu'une coquille d'application sert à un
    // anonyme. Conclure « connecté » ici serait le faux positif de Kubii.
    const vue = {
      url: connecteur.URL_COMMANDES,
      boutonSeConnecter: false,
      reperes: 0,
      libelles: [],
      selecteursPresents: [],
    };
    await assert.rejects(
      () => surProfilSimule(vue, () => connecteur.fetchInvoices({}, { userId: 1, log: () => {} })),
      (err) => {
        assert.equal(err.sessionExpired, true, `${id} : sans preuve forte, la session n'est pas établie`);
        return true;
      }
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Le mur de Darty : un 403 habillé en « Maintenance »
// ---------------------------------------------------------------------------

test('la fausse maintenance de Darty est reconnue comme le mur, pas comme une panne du site', async () => {
  const darty = connecteurs.darty;
  const { ctx, journal } = contexteEnregistreur();
  const vue = {
    url: darty.URL_COMMANDES,
    fausseMaintenance: true,
    boutonSeConnecter: false,
    reperes: 0,
    libelles: [],
    selecteursPresents: ['logout'],
  };
  await assert.rejects(
    () => surProfilSimule(vue, () => darty.fetchInvoices({}, ctx)),
    (err) => {
      assert.match(err.message, /vérification de sécurité/,
        'le message public dit le mur et le geste, pas « site en panne »');
      assert.equal(err.sessionExpired, undefined,
        'rouvrir la connexion n\'est pas le premier geste face au mur : le message le dit autrement');
      return true;
    }
  );
  assert.match(journal.join('\n'), /refus DataDome/,
    'le journal nomme le mur mesuré, pour que l\'incident suivant se diagnostique sans re-mesurer');
});

test('le motif de fausse maintenance colle au texte mesuré, pas à un mot vague', () => {
  assert.match('Malheureusement notre site n\'est actuellement pas disponible.',
    connecteurs.darty.MOTIF_FAUSSE_MAINTENANCE);
  assert.doesNotMatch('Maintenance de votre chaudière : pensez à commander.',
    connecteurs.darty.MOTIF_FAUSSE_MAINTENANCE);
});

// ---------------------------------------------------------------------------
// 5. Chaque écran d'authentification est reconnu — et l'espace client, jamais
// ---------------------------------------------------------------------------

test('chaque ébauche reconnaît SON écran de connexion, et ne prend pas ses commandes pour lui', () => {
  for (const { id, urlAuth } of SERVICES) {
    const connecteur = connecteurs[id];
    assert.equal(connecteur.estPageAuthentification(urlAuth), true,
      `${id} : l'écran mesuré (${urlAuth}) doit être reconnu`);
    assert.equal(connecteur.estPageAuthentification(connecteur.URL_COMMANDES), false,
      `${id} : la page des commandes n'est pas un écran de connexion`);
  }
  // Les deux SSO sur hôte dédié — un chemin ne les décrit pas.
  assert.equal(connecteurs.decathlon.estPageAuthentification('https://login.decathlon.net/'), true);
  assert.equal(connecteurs.vistaprint.estPageAuthentification('https://account.vista.com/login'), true);
  // Une page du site qui PARLE de connexion dans sa requête n'en est pas une.
  assert.equal(
    connecteurs.ldlc.estPageAuthentification('https://secure2.ldlc.com/fr-fr/Orders?retour=%2FLogin'),
    false
  );
});

// ---------------------------------------------------------------------------
// 6. Le module partagé : les gardes d'entrée du profil
// ---------------------------------------------------------------------------

test('sans utilisateur au contexte, le profil ne peut pas être retrouvé — et le message vise l\'exploitant', async () => {
  await assert.rejects(
    () => profilMarchand.surLeProfil({ id: 'ldlc', nom: 'LDLC', ctx: {}, urlDepart: 'https://x' }, async () => {}),
    /ctx\.userId/
  );
});

test('sans profil sur le disque, la connexion n\'a jamais été ouverte : session expirée, pas une panne', async () => {
  await assert.rejects(
    () => profilMarchand.surLeProfil(
      { id: 'ldlc-jamais-connecte', nom: 'LDLC', ctx: { userId: 424242 }, urlDepart: 'https://x' },
      async () => {}
    ),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /Se connecter/);
      return true;
    }
  );
});

test('etatDeLaListe : les quatre issues ne se confondent jamais', () => {
  const options = { cheminListe: /\/fr-fr\/Orders/i };
  // 1. Renvoyé vers la connexion.
  let etat = profilMarchand.etatDeLaListe(
    { url: 'https://secure2.ldlc.com/fr-fr/Login/Login', boutonSeConnecter: false }, options);
  assert.equal(etat.servie, false);
  assert.equal(etat.sessionAbsente, true);
  // 2. Renvoyé ailleurs, avec un bouton « Se connecter ».
  etat = profilMarchand.etatDeLaListe(
    { url: 'https://www.ldlc.com/', boutonSeConnecter: true }, options);
  assert.equal(etat.sessionAbsente, true);
  // 3. Adresse tenue mais bouton « Se connecter » : session absente aussi.
  etat = profilMarchand.etatDeLaListe(
    { url: 'https://secure2.ldlc.com/fr-fr/Orders', boutonSeConnecter: true }, options);
  assert.equal(etat.servie, false);
  assert.equal(etat.sessionAbsente, true);
  // 4. Adresse tenue, pas de bouton : servie, avec ses repères.
  etat = profilMarchand.etatDeLaListe(
    { url: 'https://secure2.ldlc.com/fr-fr/Orders', boutonSeConnecter: false, reperes: 4 }, options);
  assert.equal(etat.servie, true);
  assert.equal(etat.reperes, 4);
});

test('le message d\'écran de l\'ébauche dit ce qui s\'est passé et ce qui viendra', () => {
  const message = profilMarchand.messageParcoursNonEcrit('LDLC', 3);
  assert.match(message, /rien n'a été récupéré/);
  assert.match(message, /3 commande\(s\)/);
  assert.match(message, /prochaine version/);
  // Sans repère compté, pas de faux chiffre à l'écran.
  assert.doesNotMatch(profilMarchand.messageParcoursNonEcrit('LDLC', 0), /0 commande/);
});
