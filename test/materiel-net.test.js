'use strict';

/**
 * Le connecteur Materiel.net.
 *
 * Ce qui est vérifié ici est ce qui distingue ce connecteur des autres, et
 * surtout ce qui casserait en silence si on y touchait :
 *
 *   - **il est en ATTENTE**, et la ligne de catalogue le sait — un service
 *     annoncé hier porte déjà « available » au catalogue, et `initialStatus`
 *     seul ne la corrige jamais ;
 *   - **la priorité écrite des sélecteurs est respectée** — la page porte l'œil
 *     du mot de passe AVANT le bouton de connexion, et l'ordre du DOM donnerait
 *     le mauvais ;
 *   - **le formulaire est soumis par Entrée**, jamais par un clic sur un bouton ;
 *   - **la page des commandes est tentée AVANT toute connexion** — c'est ce qui
 *     tient à distance le captcha conditionnel du site ;
 *   - **le contenu fait foi**, jamais le type annoncé.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const materiel = require('../server/connectors/available/materiel-net/connector');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const identity = require('../server/connectors/browser-identity');
const migrations = require('../server/db/migrations');

const DOSSIER = path.join(
  __dirname, '..', 'server', 'connectors', 'available', 'materiel-net'
);
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(DOSSIER, 'manifest.json'), 'utf8'));

test.before(async () => {
  await helpers.setup();
});
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. Un connecteur réel, et EN ATTENTE
// ---------------------------------------------------------------------------

test('le service a son propre code, et il se charge', () => {
  const chargement = registry.load();
  assert.deepEqual(chargement.errors, [], 'le registre refuse un manifeste');

  const entree = registry.get('materiel-net');
  assert.equal(entree.planned, false, 'ce n\'est plus une annonce');
  assert.equal(typeof entree.module.test, 'function');
  assert.equal(typeof entree.module.fetchInvoices, 'function');
  assert.ok(fs.existsSync(path.join(DOSSIER, 'connector.js')), 'son propre connector.js');
});

test('l\'annonce a disparu : un service ne peut pas être annoncé ET connecté', () => {
  // Rendre un service disponible se fait en le DÉPLAÇANT. Laisser l'annonce
  // derrière soi fait apparaître le même service deux fois, et le registre le
  // signale par une erreur de chargement — celle-là même qui a été rencontrée
  // en écrivant ce connecteur.
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'server', 'connectors', 'planned', 'materiel-net')),
    false,
    'l\'annonce planned/materiel-net doit être retirée, sinon le registre refuse le doublon'
  );
});

test('le connecteur est en ATTENTE : jamais testé contre un vrai compte', () => {
  // La règle du projet : un connecteur ne passe « available » visible que testé
  // contre le vrai compte, une facture réelle récupérée. Celui-ci a été écrit
  // sur des mesures faites sans identifiants — il ne l'a donc pas été.
  assert.equal(MANIFESTE.initialStatus, 'pending');
});

test('la ligne de catalogue d\'un service ANNONCÉ est ramenée en attente', () => {
  // ─── Le piège que ce test verrouille ─────────────────────────────────────
  //
  // Materiel.net était annoncé. Le registre a donc déjà posé sa ligne de
  // catalogue avec « available » (une annonce ne déclare pas d'initialStatus),
  // et `syncCatalog()` insère en « ON CONFLICT DO NOTHING » : le
  // `initialStatus: pending` du manifeste ne la corrigerait JAMAIS.
  //
  // Vérifié sur la base de production avant d'écrire la migration 31 : la
  // ligne existait bien, status « available », published_at NULL.
  const database = new Database(':memory:');
  database.exec(fs.readFileSync(
    path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8'
  ));

  // La base telle qu'elle est sur le compte mesuré : la ligne posée du temps de l'annonce.
  migrations.MIGRATIONS
    .filter((m) => m.id < 31)
    .forEach((m) => m.up(database));
  database
    .prepare(
      `INSERT INTO connector_catalog (connector_id, category, status, published_at)
            VALUES ('materiel-net', 'shopping', 'available', NULL)
       ON CONFLICT(connector_id) DO UPDATE SET status = 'available', published_at = NULL`
    )
    .run();

  const avant = database
    .prepare('SELECT status FROM connector_catalog WHERE connector_id = ?')
    .get('materiel-net');
  assert.equal(avant.status, 'available', 'la ligne héritée porte bien « available »');

  migrations.MIGRATIONS.find((m) => m.id === 31).up(database);

  const apres = database
    .prepare('SELECT status, published_at FROM connector_catalog WHERE connector_id = ?')
    .get('materiel-net');
  assert.equal(
    apres.status,
    'pending',
    'sans cette migration, Materiel.net serait proposé à tout le monde sans avoir jamais tourné'
  );
  assert.equal(apres.published_at, null, 'une migration ne signe pas l\'approbation à la place d\'un humain');
  database.close();
});

test('une approbation humaine n\'est PAS reprise par la migration', () => {
  // La contrepartie, sans laquelle la migration serait une trahison : si un
  // administrateur a explicitement approuvé le service, sa décision tient.
  const database = new Database(':memory:');
  database.exec(fs.readFileSync(
    path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8'
  ));
  migrations.MIGRATIONS.filter((m) => m.id < 31).forEach((m) => m.up(database));
  database
    .prepare(
      `INSERT INTO connector_catalog (connector_id, category, status, published_at)
            VALUES ('materiel-net', 'shopping', 'available', '2026-08-01 10:00:00')
       ON CONFLICT(connector_id) DO UPDATE
              SET status = 'available', published_at = '2026-08-01 10:00:00'`
    )
    .run();

  migrations.MIGRATIONS.find((m) => m.id === 31).up(database);

  assert.equal(
    database.prepare('SELECT status FROM connector_catalog WHERE connector_id = ?')
      .get('materiel-net').status,
    'available',
    'un service approuvé à la main ne redescend pas en attente'
  );
  database.close();
});

// ---------------------------------------------------------------------------
// 2. Les champs — remplissables AVANT toute connexion
// ---------------------------------------------------------------------------

test('aucun champ obligatoire ne demande d\'être déjà connecté', () => {
  // Le piège `session.required`, vu trois fois sur ce projet. Ici il ne peut pas
  // se poser — aucun champ de session — mais la règle se vérifie quand même :
  // tout champ obligatoire doit pouvoir être rempli de tête, avant le premier
  // contact avec le site.
  const normalise = schema.normalize(MANIFESTE);
  const obligatoires = normalise.fields.filter((f) => f.required).map((f) => f.key);

  assert.deepEqual(obligatoires.sort(), ['email', 'motDePasse']);
  assert.equal(
    normalise.fields.some((f) => f.type === 'session'),
    false,
    'ce connecteur se connecte tout seul : aucune fenêtre de connexion à ouvrir'
  );
});

test('le site demande une ADRESSE, et le formulaire le dit', () => {
  // Materiel.net s'identifie par adresse électronique, pas par un identifiant.
  // Le champ déclare sa nature, et c'est elle qui écrit le libellé.
  const email = MANIFESTE.fields.find((f) => f.key === 'email');
  assert.equal(email.identification, 'email');
  assert.equal(email.type, 'email');

  const vue = schema.publicView(schema.normalize(MANIFESTE));
  assert.equal(vue.fields.find((f) => f.key === 'email').label, 'Adresse électronique');
});

test('chaque aide dit où trouver la valeur, sans jargon', () => {
  const normalise = schema.normalize(MANIFESTE);
  for (const champ of normalise.fields) {
    assert.ok(champ.help && champ.help.trim().length >= 30, `${champ.key} : aide trop courte`);
    assert.equal(
      schema.jargonUtilisateur(champ.help),
      null,
      `${champ.key} : l'aide contient du jargon`
    );
  }
  // Le mot de passe dit où en refaire un : c'est le geste concret que
  // l'utilisateur cherche quand il ne s'en souvient plus.
  const mdp = normalise.fields.find((f) => f.key === 'motDePasse');
  assert.match(mdp.help, /Mot de passe oublié/i);
});

test('la note technique ne sort jamais à l\'écran', () => {
  assert.ok(MANIFESTE.technicalNote.length > 1000, 'tout ce qui a été mesuré y est écrit');
  assert.equal(schema.publicView(MANIFESTE).technicalNote, undefined);
});

// ---------------------------------------------------------------------------
// 3. Les adresses mesurées
// ---------------------------------------------------------------------------

test('la connexion vit sur secure.materiel.net, pas sur la vitrine', () => {
  // www.materiel.net/client/connexion/ rend une redirection vers l'accueil, et
  // /client/ comme /login/ rendent 404 : c'est le sous-domaine qui compte.
  assert.match(materiel.URL_CONNEXION, /^https:\/\/secure\.materiel\.net\/Login\/Login/);
  assert.match(materiel.URL_COMMANDES, /^https:\/\/secure\.materiel\.net\/Orders$/);
});

test('Materiel.net : une page qui renvoie au formulaire est vue comme telle', () => {
  assert.equal(materiel.estPageConnexion('https://secure.materiel.net/Login/Login?returnUrl=%2F'), true);
  assert.equal(materiel.estPageConnexion('https://secure.materiel.net/Orders'), false);
  assert.equal(materiel.estPageConnexion('https://secure.materiel.net/Account'), false);

  // Le domaine ne doit pas décider à la place du chemin : « materiel.net » ne
  // contient aucun de ces mots, mais un sous-domaine « connexion.… » ne doit pas
  // faire conclure à tort.
  assert.equal(materiel.estPageConnexion('https://connexion.materiel.net/Orders'), false);
});

// ---------------------------------------------------------------------------
// 4. Le piège du bouton — l'œil du mot de passe est écrit AVANT « Connexion »
// ---------------------------------------------------------------------------

test('premierPresent respecte la priorité ÉCRITE, pas l\'ordre du DOM', async () => {
  // C'est LA raison d'être de cette fonction. `page.locator(union).first()`
  // rendrait le premier élément dans l'ordre du DOM — donc l'œil « afficher le
  // mot de passe », écrit avant le bouton de connexion. Le connecteur cliquerait
  // l'œil et n'enverrait rien, exactement la panne de L'Atelier du Portable.
  const vus = [];
  const page = {
    locator(sel) {
      vus.push(sel);
      return { first: () => ({ count: async () => (sel === '#Password' ? 1 : 0) }) };
    },
  };

  const trouve = await materiel.premierPresent(page, ['#Email', '#Password', 'input']);
  assert.ok(trouve, 'le sélecteur présent doit être rendu');
  assert.deepEqual(vus, ['#Email', '#Password'], 'on s\'arrête au premier qui existe, dans l\'ordre écrit');
});

test('un sélecteur illisible ne fait pas tomber la recherche', async () => {
  // `:has()` peut être refusé par un moteur CSS, et une page en cours de
  // navigation fait lever `locator`. On passe au repli plutôt qu'interrompre.
  const page = {
    locator(sel) {
      if (sel === 'form:has(input)') throw new Error('sélecteur refusé');
      return { first: () => ({ count: async () => 1 }) };
    },
  };
  assert.ok(await materiel.premierPresent(page, ['form:has(input)', '#Password']));
});

test('le formulaire est soumis par ENTRÉE, et aucun bouton n\'est cliqué', async () => {
  // Le test qui MORD vraiment : on rejoue une connexion complète sur une fausse
  // page, et on regarde ce que le connecteur a fait. Un jour où quelqu'un
  // remplacerait Entrée par un clic sur « le premier bouton », ce test tombe.
  const gestes = [];
  const champ = (nom) => ({
    count: async () => 1,
    fill: async (v) => gestes.push(`fill:${nom}:${v ? 'valeur' : 'vide'}`),
    press: async (touche) => gestes.push(`press:${nom}:${touche}`),
    check: async () => gestes.push(`check:${nom}`),
    click: async () => gestes.push(`click:${nom}`),
    isVisible: async () => true,
    innerText: async () => '',
  });
  const absent = { count: async () => 0, isVisible: async () => false, click: async () => {} };

  const page = {
    url: () => 'https://secure.materiel.net/Orders',
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => false, // aucun captcha rendu
    locator(sel) {
      if (sel === '#Email') return { first: () => champ('Email') };
      if (sel === '#Password') return { first: () => champ('Password') };
      if (sel === '#LongAuthenticationDuration') return { first: () => champ('ResterConnecte') };
      return { first: () => absent };
    },
  };

  await materiel.seConnecter(page, 'moi@exemple.fr', 'secret', () => {});

  assert.ok(gestes.includes('press:Password:Enter'), 'la soumission passe par la touche Entrée');
  assert.equal(
    gestes.some((g) => g.startsWith('click:')),
    false,
    'aucun bouton n\'est cliqué : l\'œil du mot de passe est écrit avant « Connexion »'
  );
  // Et la case « Rester connecté » est cochée : c'est elle qui espace les
  // connexions, donc qui tient le captcha conditionnel à distance.
  assert.ok(gestes.includes('check:ResterConnecte'), 'la case « Rester connecté » est cochée');
});

test('un captcha rendu arrête tout AVANT que le mot de passe soit saisi', async () => {
  // Remplir un formulaire qu'on ne pourra pas soumettre expose le mot de passe
  // à une page qu'on va quitter. Et surtout : le captcha ne se contourne pas.
  const gestes = [];
  const page = {
    url: () => 'https://secure.materiel.net/Login/Login',
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => true, // captcha présent
    locator: () => ({ first: () => ({
      count: async () => 1, isVisible: async () => false,
      fill: async () => gestes.push('fill'), click: async () => {},
    }) }),
  };

  await assert.rejects(
    () => materiel.seConnecter(page, 'moi@exemple.fr', 'secret', () => {}),
    (err) => {
      assert.equal(err.message, materiel.MESSAGE_CAPTCHA);
      assert.equal(err.sessionExpired, true, 'ce n\'est pas un mot de passe à corriger');
      return true;
    }
  );
  assert.deepEqual(gestes, [], 'aucun champ rempli : on s\'arrête avant');
});

test('le bandeau de cookies est REFUSÉ, pas accepté', async () => {
  // On ne consent pas au pistage au nom de l'utilisateur. « Refuser » d'abord,
  // les autres boutons ne servent qu'à dégager la page si celui-là manque.
  const cliques = [];
  const page = {
    waitForTimeout: async () => {},
    locator(sel) {
      const existe = sel.includes('Refuser') || sel.includes('J\'accepte');
      return { first: () => ({
        count: async () => (existe ? 1 : 0),
        isVisible: async () => existe,
        click: async () => cliques.push(sel),
      }) };
    },
  };
  await materiel.fermerBandeauCookies(page, () => {});
  assert.equal(cliques.length, 1);
  assert.match(cliques[0], /Refuser/, 'c\'est « Refuser » qui est cliqué, pas « J\'accepte »');
});

// ---------------------------------------------------------------------------
// 5. Lecture de la page
// ---------------------------------------------------------------------------

test('les commandes se lisent dans le texte de la page', () => {
  const texte = [
    'Mes commandes',
    'Commande n° 12345678 du 07/05/2026 — Expédiée',
    'Commande N° 87654321 du 12/11/2025 — Livrée',
    'Commande n° 12345678 du 07/05/2026 — Expédiée',
  ].join('\n');

  const commandes = materiel.commandesDepuisTexte(texte);
  assert.deepEqual(commandes, [
    { numero: '12345678', issuedOn: '2026-05-07' },
    { numero: '87654321', issuedOn: '2025-11-12' },
  ], 'les doublons sont écartés, et la date est remise à l\'endroit');
});

test('l\'expression globale ne saute pas une commande sur deux', () => {
  // Une expression régulière globale porte son propre curseur. La réutiliser
  // telle quelle d'un appel à l'autre reprend là où elle s'était arrêtée : le
  // deuxième appel ne verrait que la moitié des commandes.
  const texte = 'Commande n° 11111111 du 01/02/2026\nCommande n° 22222222 du 03/04/2026';
  const premier = materiel.commandesDepuisTexte(texte);
  const second = materiel.commandesDepuisTexte(texte);
  assert.equal(premier.length, 2);
  assert.deepEqual(second, premier, 'deux appels de suite donnent le même résultat');
});

test('un lien de facture se reconnaît par son texte OU par son adresse', () => {
  assert.equal(materiel.estLienDeFacture({ texte: 'Télécharger ma facture', url: '/x/y' }), true);
  assert.equal(materiel.estLienDeFacture({ texte: 'Télécharger', url: '/Orders/Invoice/12345678' }), true);
  assert.equal(materiel.estLienDeFacture({ texte: 'Suivre mon colis', url: '/Orders/Tracking' }), false);
});

test('le numéro de commande se retrouve dans l\'adresse, ou pas du tout', () => {
  assert.equal(materiel.numeroDepuisUrl('/Orders/Invoice/12345678'), '12345678');
  assert.equal(materiel.numeroDepuisUrl('/Orders/Invoice?num=AB1234567'), 'AB1234567');
  // Rendre null plutôt qu'inventer : un lien qu'on ne sait pas rattacher ne
  // doit pas être collé à la date d'une autre commande.
  assert.equal(materiel.numeroDepuisUrl('/Orders/Invoice'), null);
});

test('le fichier est nommé par sa date, et « inconnu » quand elle manque', () => {
  assert.equal(materiel.nomFichier('2026-05-07', '12345678'), '2026-05_12345678.pdf');
  assert.equal(materiel.nomFichier(null, '12345678'), 'inconnu_12345678.pdf');
  // Un numéro venu de la page ne compose pas un chemin sans être filtré.
  assert.equal(materiel.nomFichier('2026-05-07', '../../etc/passwd'), '2026-05_.._.._etc_passwd.pdf');
});

test('le dossier du compte porte l\'adresse de la fiche en priorité', () => {
  // Celle que l'utilisateur a écrite : c'est celle qu'il reconnaîtra dans
  // l'arborescence de ses documents.
  assert.equal(
    materiel.compteDepuisTexte('Bonjour autre@exemple.fr', { email: 'Moi@Exemple.FR' }),
    'moi@exemple.fr'
  );
  assert.equal(materiel.compteDepuisTexte('Bonjour lu@exemple.fr', {}), 'lu@exemple.fr');
  assert.equal(materiel.compteDepuisTexte('rien ici', {}), materiel.COMPTE_PAR_DEFAUT);
});

// ---------------------------------------------------------------------------
// 6. Le contenu fait foi
// ---------------------------------------------------------------------------

test('le format n\'étant pas établi, c\'est le contenu qui tranche', () => {
  // L'aide du site écrit « Télécharger ma facture » et jamais « PDF ». Et une
  // session qui vient d'expirer rend une page de connexion avec un type de
  // contenu parfaitement propre : s'y fier déposerait du HTML dans le dossier
  // des factures, sans que rien ne le signale.
  assert.equal(identity.estPdf(Buffer.from('%PDF-1.7\n…')), true);
  assert.equal(identity.estPdf(Buffer.from('<!DOCTYPE html><html>Connexion')), false);
  assert.equal(identity.estPdf(Buffer.from('')), false);
  assert.equal(identity.estPdf(null), false);
});

test('les messages d\'échec disent quoi faire, jamais ce qui a planté', () => {
  for (const message of [
    materiel.MESSAGE_SESSION_EXPIREE,
    materiel.MESSAGE_IDENTIFIANTS,
    materiel.MESSAGE_CAPTCHA,
  ]) {
    assert.equal(schema.jargonUtilisateur(message), null, `jargon dans « ${message} »`);
    // Un verbe d'action à l'adresse de l'utilisateur : c'est ce qui distingue
    // « quoi faire » d'un rapport de panne.
    assert.match(message, /Vérifiez|Connectez-vous|Renseignez|relancez/i);
    assert.doesNotMatch(message, /timeout|selector|undefined|null|HTTP \d|stack/i);
  }
});

test('les erreurs portent leur nature : session, identifiants — pas les deux', () => {
  // Le socle s'en sert pour décider quoi dire à l'utilisateur. Confondre les
  // deux l'enverrait changer un mot de passe qui n'a rien à se reprocher.
  assert.equal(materiel.erreurSessionExpiree().sessionExpired, true);
  assert.equal(materiel.erreurSessionExpiree().credentialsRejected, undefined);
  assert.equal(materiel.erreurIdentifiants().credentialsRejected, true);
  assert.equal(materiel.erreurIdentifiants().sessionExpired, undefined);
});

// ---------------------------------------------------------------------------
// 7. Le profil persistant — là où il vit
// ---------------------------------------------------------------------------

test('le profil de navigateur vit sous le répertoire de données, par utilisateur', () => {
  const profils = require('../server/connectors/profil-persistant');
  const chemin = profils.chemin(1, materiel.ID);
  assert.match(chemin, /profils-navigateur[/\\]1[/\\]materiel-net$/);
  assert.equal(materiel.ID, MANIFESTE.id, 'le profil suit l\'identifiant du manifeste');
});

test('sans utilisateur au contexte, on le dit plutôt que de viser un profil au hasard', async () => {
  await assert.rejects(
    () => materiel.fetchInvoices({ email: 'moi@exemple.fr', motDePasse: 'x' }, { log: () => {} }),
    /ctx\.userId/,
    'un profil visé au hasard rendrait les factures de quelqu\'un d\'autre'
  );
});

test('sans identifiants, on demande à les renseigner — sans ouvrir de navigateur', async () => {
  await assert.rejects(
    () => materiel.fetchInvoices({}, { userId: 1, log: () => {} }),
    /Renseignez votre adresse électronique et votre mot de passe/
  );
});

// ---------------------------------------------------------------------------
// Lot 32 — la page réelle, enfin vue (relevé réel du 14/08/2026)
// ---------------------------------------------------------------------------
//
// Trois exécutions de production avaient échoué sur « une page qui ne
// ressemble ni à vos commandes ni à un espace connecté » alors que la page
// CONTENAIT les commandes : la liste est chargée en AJAX après le rendu
// initial, et le connecteur lisait le texte d'arrivée. Ces tests figent la
// structure mesurée et le comportement « attendre, puis lire ».

/** La ligne de commande réelle, telle que la page la construit. */
const LIGNE_REELLE = {
  ref: 'Nº 6053014301785C',
  date: '30/05/2026',
  prix: '757€90 TTC',
  detailHref:
    '/Orders/PartialCompletedOrderContent?orderId=C071801768&orderDate=05%2F30%2F2026%2014%3A32%3A19&orderType=Web#order_C071801768',
};

test('les commandes se lisent dans la structure réelle de la liste', () => {
  const commandes = materiel.commandesDepuisLignes([LIGNE_REELLE, { ref: '', date: '' }]);
  assert.equal(commandes.length, 1);
  const [c] = commandes;
  // La référence AFFICHÉE nomme la commande — pas l'orderId de la requête.
  assert.equal(c.numero, '6053014301785C');
  assert.equal(c.issuedOn, '2026-05-30');
  assert.match(c.montant, /757/);
  // Les deux identifiants sont bien distingués : confondre l'un et l'autre
  // enverrait la requête de détail sur une commande qui n'existe pas.
  assert.equal(c.orderId, 'C071801768');
  assert.notEqual(c.numero, c.orderId);
  assert.ok(c.detailHref.includes('PartialCompletedOrderContent'));
});

test('deux lignes de même référence ne font qu\'une commande', () => {
  const commandes = materiel.commandesDepuisLignes([LIGNE_REELLE, { ...LIGNE_REELLE }]);
  assert.equal(commandes.length, 1);
});

test('le lien de facture se cherche dans le DÉTAIL, texte du bouton compris', () => {
  const fragment = `
    <div class="order-detail">
      <a href="/Orders/nav">Retour</a>
      <a class="o-btn" href="/Orders/DownloadDocument?id=9912&type=2">Télécharger ma facture</a>
      <a href="javascript:void(0)" data-href="/Orders/Facture/9913">Facture</a>
    </div>`;
  const liens = materiel.liensDeFactureDansHtml(fragment, 'https://secure.materiel.net');
  // Le premier lien est retenu par son VOISINAGE (« Télécharger ma facture »),
  // le second par son adresse ; la navigation et le javascript: sont écartés.
  assert.deepEqual(liens, [
    'https://secure.materiel.net/Orders/DownloadDocument?id=9912&type=2',
    'https://secure.materiel.net/Orders/Facture/9913',
  ]);
});

test('la liste est ATTENDUE avant d\'être lue — lire trop tôt rendait le faux échec du 14/08', async () => {
  // Une page dont la liste n'arrive qu'APRÈS l'attente : c'est le comportement
  // AJAX mesuré. Si le lecteur n'attend pas, il voit une page vide.
  let listeArrivee = false;
  const page = {
    waitForSelector: async (selecteur) => {
      assert.equal(selecteur, materiel.SELECTEUR_LIGNES);
      listeArrivee = true;
      return {};
    },
    evaluate: async () => (listeArrivee ? [LIGNE_REELLE] : []),
  };

  const commandes = await materiel.lireLesCommandes(page, () => {});
  assert.equal(commandes.length, 1, 'la liste doit être lue APRÈS son arrivée');
  assert.equal(commandes[0].numero, '6053014301785C');
});

test('une liste qui n\'arrive jamais rend zéro commande, sans erreur — le garde-fou du lot 31 tranche', async () => {
  const page = {
    waitForSelector: async () => { throw new Error('délai dépassé'); },
    evaluate: async () => [],
  };
  const journal = [];
  const commandes = await materiel.lireLesCommandes(page, (m) => journal.push(m));
  assert.deepEqual(commandes, []);
  assert.ok(journal.some((m) => /n'est pas apparue/.test(m)), journal.join(' | '));
});

// ---------------------------------------------------------------------------
// Lot 33 — la profondeur au-delà des 6 mois : les périodes du site, toutes,
// et rien qu'elles
// ---------------------------------------------------------------------------

/** La réponse RÉELLE de /Orders/CompletedOrdersPeriodSelection, 14/08/2026. */
const PERIODES_REELLES = [
  { duration: 'Year', value: 2026 },
  { duration: 'Year', value: 2021 },
  { duration: 'Year', value: 2020 },
  { duration: 'Year', value: 2019 },
  { duration: 'Year', value: 2018 },
];

test('les périodes viennent du site, trous compris — jamais des années inventées', () => {
  const periodes = materiel.periodesDepuisJson(PERIODES_REELLES);
  assert.deepEqual(periodes.map((p) => p.value), [2026, 2021, 2020, 2019, 2018]);

  // Un JSON abîmé ne devient pas une boucle sur undefined.
  assert.deepEqual(materiel.periodesDepuisJson(null), []);
  assert.deepEqual(materiel.periodesDepuisJson([{ duration: '', value: 2020 }, { value: 'x' }]), []);
  // Un doublon du site ne fait pas ouvrir deux fois la même liste.
  assert.equal(
    materiel.periodesDepuisJson([...PERIODES_REELLES, { duration: 'Year', value: 2020 }]).length,
    5
  );
});

test('« tout l\'historique » ouvre TOUTES les périodes proposées, une période vide n\'arrête rien', () => {
  // Le plan « tout » retient toutes les années disponibles : chaque période
  // du menu doit être ouverte. C'est LE test qui tombe si le connecteur se
  // remet à ne lire que la période par défaut, ou s'arrête à un trou.
  const plan = { mode: 'tout', annees: [2026, 2021, 2020, 2019, 2018] };
  const aParcourir = materiel.periodesAParcourir(materiel.periodesDepuisJson(PERIODES_REELLES), plan);
  assert.deepEqual(aParcourir.map((p) => p.value), [2026, 2021, 2020, 2019, 2018]);

  // Une fenêtre réduite n'ouvre que ses années — sans jamais en inventer :
  // 2024 est demandée mais absente du menu, elle n'apparaît pas.
  const fenetre = materiel.periodesAParcourir(PERIODES_REELLES, { mode: 'depuis', annees: [2026, 2024] });
  assert.deepEqual(fenetre.map((p) => p.value), [2026]);
});

test('la couverture ne dit « complète » que si tout a été vu, sans un seul échec', () => {
  const toutVu = materiel.couverturePour(
    PERIODES_REELLES,
    [
      { value: 2026, commandes: 1 }, { value: 2021, commandes: 2 },
      { value: 2020, commandes: 1 }, { value: 2019, commandes: 2 },
      { value: 2018, commandes: 1 },
    ]
  );
  assert.equal(toutVu.complete, true);
  assert.match(toutVu.detail, /2021 \(2 commandes\)/);

  // Une seule période lue : la couverture nomme ce qui reste hors de portée.
  const partiel = materiel.couverturePour(PERIODES_REELLES, [{ value: 2026, commandes: 1 }]);
  assert.equal(partiel.complete, false);
  assert.match(partiel.detail, /hors de portée cette fois : 2021, 2020, 2019, 2018/);

  // Un échec de liste interdit « complète », même si tout le reste a été vu.
  const avecEchec = materiel.couverturePour(
    PERIODES_REELLES,
    [
      { value: 2026, commandes: 1 }, { value: 2021, commandes: 2 },
      { value: 2020, commandes: 1 }, { value: 2019, commandes: 2 },
    ],
    [2018]
  );
  assert.equal(avecEchec.complete, false);
  assert.match(avecEchec.detail, /n'a pas répondu pour : 2018/);

  // Aucune période proposée (route muette) : on ne peut rien affirmer.
  assert.equal(materiel.couverturePour([], []).complete, false);
});

test('le fragment d\'une période est lu avec les mêmes champs que la liste par défaut', async () => {
  // La page reçoit le HTML du fragment et le lit dans un élément détaché ;
  // ici, le « navigateur » applique la lecture sur des lignes préparées.
  const fauxContexte = {
    request: {
      post: async (url, options) => {
        assert.equal(url, materiel.URL_LISTE_PERIODE);
        assert.deepEqual(options.form, { duration: 'Year', value: '2021' });
        return { ok: () => true, status: () => 200, text: async () => '<fragment>' };
      },
    },
  };
  const fauxPage = {
    evaluate: async (fn, args) => {
      assert.equal(args.fragment, '<fragment>');
      assert.equal(args.selecteur, materiel.SELECTEUR_LIGNES_FRAGMENT);
      return [{ ref: 'Nº 21AB34CD56EF', date: '07/05/2021', prix: '99,99 €', detailHref: '/Orders/PartialCompletedOrderContent?orderId=x21' }];
    },
  };
  const commandes = await materiel.lireCommandesDePeriode(fauxPage, fauxContexte, { duration: 'Year', value: 2021 });
  assert.equal(commandes.length, 1);
  assert.equal(commandes[0].numero, '21AB34CD56EF');
  assert.equal(commandes[0].issuedOn, '2021-05-07');

  // Une route qui ne répond pas rend null — distinct d'une période vide.
  const contexteMort = { request: { post: async () => { throw new Error('réseau'); } } };
  assert.equal(await materiel.lireCommandesDePeriode(fauxPage, contexteMort, PERIODES_REELLES[0]), null);
});
