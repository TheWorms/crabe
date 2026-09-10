'use strict';

/**
 * Le connecteur PayByPhone.
 *
 * ⚠ **Le connecteur le moins vérifié du dépôt** : sa connexion est mesurée au
 * caractère près, tout ce qui suit ne l'est pas. Ces tests portent donc en
 * priorité sur les décisions qui ne dépendent PAS d'avoir vu le portail :
 *
 *   - **le mois EN COURS est écarté** — un relevé incomplet ne serait jamais
 *     regénéré, et les stationnements de la fin du mois seraient perdus ;
 *   - **on cible le portail de reçus, jamais l'application Flutter**, qui ne
 *     s'affiche pas dans un navigateur automatisé ;
 *   - **on clique le bouton d'envoi**, parce qu'ASP.NET a besoin de son
 *     nom/valeur — et parce que la page ne porte aucun bouton leurre ;
 *   - **quand il ne trouve pas, il décrit ce qu'il a vu** : c'est ce qui rendra
 *     la première exécution réelle diagnosticable.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pbp = require('../server/connectors/available/paybyphone/connector');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');
const identity = require('../server/connectors/browser-identity');

const DOSSIER = path.join(__dirname, '..', 'server', 'connectors', 'available', 'paybyphone');
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(DOSSIER, 'manifest.json'), 'utf8'));

test.before(async () => { await helpers.setup(); });
test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. Un connecteur réel, et EN ATTENTE
// ---------------------------------------------------------------------------

test('PayByPhone se charge, avec son propre code', () => {
  const chargement = registry.load();
  assert.deepEqual(chargement.errors, []);

  const entree = registry.get('paybyphone');
  assert.equal(entree.planned, false);
  assert.equal(typeof entree.module.test, 'function');
  assert.equal(typeof entree.module.fetchInvoices, 'function');
});

test('PayByPhone est en ATTENTE : jamais exercé contre un vrai compte', () => {
  assert.equal(MANIFESTE.initialStatus, 'pending');
});

test('aucun champ obligatoire ne demande d\'être déjà connecté', () => {
  const normalise = schema.normalize(MANIFESTE);
  const obligatoires = normalise.fields.filter((f) => f.required).map((f) => f.key).sort();
  assert.deepEqual(obligatoires, ['motDePasse', 'numeroMobile']);
  assert.equal(normalise.fields.some((f) => f.type === 'session'), false);
});

test('chaque aide dit où trouver la valeur, sans jargon', () => {
  const normalise = schema.normalize(MANIFESTE);
  for (const champ of normalise.fields) {
    assert.ok(champ.help && champ.help.trim().length >= 30, `${champ.key} : aide trop courte`);
    assert.equal(schema.jargonUtilisateur(champ.help), null, `${champ.key} : jargon`);
  }
  // Le numéro dit COMMENT l'écrire : c'est la question que se pose l'utilisateur
  // devant un champ qui n'accepte pas l'indicatif.
  const numero = normalise.fields.find((f) => f.key === 'numeroMobile');
  assert.match(numero.help, /sans l'indicatif/i);
  assert.match(numero.help, /612345678/, 'un exemple concret vaut mieux qu\'une règle');
});

// ---------------------------------------------------------------------------
// 2. LE BON SITE — pas celui qu'on croit
// ---------------------------------------------------------------------------

test('le connecteur vise le portail de reçus, JAMAIS l\'application Flutter', () => {
  // m.paybyphone.com ne s'affiche pas dans un navigateur automatisé : mesuré
  // quatre fois, en invisible et en visible sous Xvfb, moteur graphique chargé
  // et zone de dessin vide. Un connecteur écrit contre elle ne marcherait jamais.
  assert.match(pbp.URL_CONNEXION, /^https:\/\/secure\.paybyphone\.fr\/consumersite\/login\.aspx$/);
  assert.match(pbp.RACINE_PORTAIL, /^https:\/\/secure\.paybyphone\.fr\/consumersite\/$/);

  const source = fs.readFileSync(path.join(DOSSIER, 'connector.js'), 'utf8');
  const code = source.slice(source.indexOf('const nodeFs')); // hors commentaire d'en-tête
  assert.doesNotMatch(
    code,
    /['"`]https:\/\/m\.paybyphone\.com/,
    'aucune adresse de l\'application Flutter ne doit être utilisée par le code'
  );
});

test('une page qui renvoie au formulaire est vue comme telle', () => {
  assert.equal(pbp.estPageConnexion('https://secure.paybyphone.fr/consumersite/login.aspx'), true);
  assert.equal(
    pbp.estPageConnexion('https://secure.paybyphone.fr/consumersite/login.aspx?ReturnUrl=%2fx'),
    true
  );
  assert.equal(pbp.estPageConnexion('https://secure.paybyphone.fr/consumersite/default.aspx'), false);
});

// ---------------------------------------------------------------------------
// 3. Le mois EN COURS est écarté — la décision qui protège les données
// ---------------------------------------------------------------------------

test('le mois en cours est écarté : un relevé incomplet ne se regénère jamais', () => {
  // Un relevé d'août produit le 14 août manquerait les stationnements du 15 au
  // 31. Son identifiant étant déjà connu, il ne serait jamais redemandé : ces
  // stationnements disparaîtraient de TOUT document. Même leçon que le relevé
  // reconstitué de Bitstamp.
  const mois = pbp.moisRevolus([2026], new Date(Date.UTC(2026, 7, 14))); // 14 août 2026
  assert.equal(mois.length, 7, 'janvier à juillet, et rien d\'autre');
  assert.deepEqual(mois[0], { annee: 2026, mois: 7, debut: '2026-07-01', fin: '2026-07-31' });
  assert.equal(
    mois.some((m) => m.mois === 8),
    false,
    'août, mois en cours, ne doit PAS être proposé'
  );
});

test('le dernier jour du mois est juste, années bissextiles comprises', () => {
  const m2024 = pbp.moisRevolus([2024], new Date(Date.UTC(2026, 0, 1)));
  assert.equal(m2024.find((m) => m.mois === 2).fin, '2024-02-29', 'février 2024 a 29 jours');
  const m2026 = pbp.moisRevolus([2026], new Date(Date.UTC(2026, 11, 31)));
  assert.equal(m2026.find((m) => m.mois === 2).fin, '2026-02-28');
  assert.equal(m2026.find((m) => m.mois === 4).fin, '2026-04-30');
});

test('une année future ne produit aucun mois', () => {
  assert.deepEqual(pbp.moisRevolus([2030], new Date(Date.UTC(2026, 7, 14))), []);
});

test('sans année imposée, on couvre les douze derniers mois', () => {
  // Le portail garde environ douze mois : demander au-delà ferait parcourir
  // des mois vides pour rien.
  const mois = pbp.moisRevolus(null, new Date(Date.UTC(2026, 7, 14)));
  assert.ok(mois.length >= 12, `attendu au moins douze mois, obtenu ${mois.length}`);
  assert.equal(mois.some((m) => m.annee === 2026 && m.mois === 8), false, 'jamais le mois en cours');
});

test('le relevé est daté du dernier jour du mois qu\'il couvre', () => {
  // C'est la date à laquelle il devient complet, et c'est elle qui le range
  // dans la bonne année sur les destinations.
  const juillet = pbp.moisRevolus([2026], new Date(Date.UTC(2026, 7, 14)))[0];
  assert.equal(juillet.fin, '2026-07-31');
  assert.equal(pbp.remoteIdPour(2026, 7), 'releve-2026-07');
  assert.equal(pbp.nomFichier(2026, 7), '2026-07_stationnement.pdf');
  assert.equal(pbp.nomFichier(2026, 12), '2026-12_stationnement.pdf');
});

// ---------------------------------------------------------------------------
// 4. Le numéro, tel que le portail l'attend
// ---------------------------------------------------------------------------

test('le numéro est nettoyé de ce que le portail n\'attend pas', () => {
  // Le champ du site ne prend pas l'indicatif : celui-ci se choisit à côté.
  assert.equal(pbp.numeroPourLeSite('06 12 34 56 78'), '612345678');
  assert.equal(pbp.numeroPourLeSite('06.12.34.56.78'), '612345678');
  assert.equal(pbp.numeroPourLeSite('06-12-34-56-78'), '612345678');
  assert.equal(pbp.numeroPourLeSite('612345678'), '612345678');
});

test('un « +33 » collé devant n\'est PAS deviné à la place de l\'utilisateur', () => {
  // Corriger en silence, c'est décider du pays à la place de quelqu'un qui l'a
  // déjà choisi dans le champ prévu. Un refus lisible du portail vaut mieux
  // qu'une correction fausse et muette.
  assert.equal(pbp.numeroPourLeSite('+33612345678'), '+33612345678');
});

test('le pays inconnu retombe sur la France, pas sur rien', () => {
  assert.equal(pbp.indicatifChoisi({ indicatif: 'Suisse' }), 'Suisse');
  assert.equal(pbp.indicatifChoisi({ indicatif: 'Atlantide' }), 'France');
  assert.equal(pbp.indicatifChoisi({}), 'France');
  // Tous les pays proposés à l'écran doivent être connus du code, sinon le
  // choix de l'utilisateur serait silencieusement ignoré.
  const proposes = MANIFESTE.fields.find((f) => f.key === 'indicatif').options;
  for (const pays of proposes) {
    assert.ok(pbp.INDICATIFS[pays], `« ${pays} » est proposé à l'écran mais inconnu du code`);
  }
});

test('le dossier du compte porte le numéro, jamais « compte » s\'il y en a un', () => {
  assert.equal(pbp.compteDepuisConfig({ numeroMobile: '06 12 34 56 78' }), '0612345678');
  assert.equal(pbp.compteDepuisConfig({}), pbp.COMPTE_PAR_DEFAUT);
});

// ---------------------------------------------------------------------------
// 5. La connexion — ASP.NET veut le nom/valeur de son bouton
// ---------------------------------------------------------------------------

test('le bouton d\'envoi est CLIQUÉ : ASP.NET a besoin de son nom/valeur', async () => {
  // Contrairement à Materiel.net où l'on presse Entrée. Ce n'est pas une
  // incohérence : ici la page ne porte AUCUN <button> et un seul
  // input[type=submit], et WebForms a besoin du couple nom/valeur du bouton
  // pour savoir quel contrôle a déclenché la soumission.
  const gestes = [];
  const element = (nom) => ({
    count: async () => 1,
    fill: async (v) => { gestes.push(`fill:${nom}`); return v; },
    click: async () => gestes.push(`click:${nom}`),
    press: async (t) => gestes.push(`press:${nom}:${t}`),
    selectOption: async (o) => { gestes.push(`select:${JSON.stringify(o)}`); return ['5']; },
  });
  const page = {
    url: () => 'https://secure.paybyphone.fr/consumersite/default.aspx',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => '',
    locator: (sel) => ({ first: () => element(sel) }),
  };

  await pbp.seConnecter(page, { numeroMobile: '0612345678', motDePasse: 'x' }, () => {});

  assert.ok(gestes.some((g) => g.startsWith('click:')), 'le bouton d\'envoi est cliqué');
  assert.equal(
    gestes.some((g) => g.includes(':Enter')),
    false,
    'pas de touche Entrée ici : WebForms perdrait le nom/valeur du bouton'
  );
  // Et le pays est choisi par son LIBELLÉ, pas par le numéro d'option.
  assert.ok(
    gestes.some((g) => g.startsWith('select:') && g.includes('label')),
    'le pays se choisit par ce que le site affiche, pas par un numéro de rang'
  );
});

test('des identifiants refusés sont annoncés comme tels, sans révéler la saisie', async () => {
  const page = {
    url: () => 'https://secure.paybyphone.fr/consumersite/login.aspx',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => 'Numéro ou mot de passe incorrect',
    locator: () => ({ first: () => ({
      count: async () => 1, fill: async () => {}, click: async () => {},
      selectOption: async () => ['5'],
    }) }),
  };

  await assert.rejects(
    () => pbp.seConnecter(page, { numeroMobile: '0612345678', motDePasse: 'secret' }, () => {}),
    (err) => {
      assert.equal(err.credentialsRejected, true);
      assert.ok(err.message.startsWith(pbp.MESSAGE_IDENTIFIANTS));
      // Rien de ce que l'utilisateur a saisi ne doit se retrouver dans l'erreur.
      assert.doesNotMatch(err.message, /secret|0612345678|612345678/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Assumer de ne pas savoir : décrire ce qu'on a vu
// ---------------------------------------------------------------------------

test('un lien vers les transactions se reconnaît par son texte OU son adresse', () => {
  assert.equal(pbp.estLienTransactions({ texte: 'Transactions de stationnement', url: '/x' }), true);
  assert.equal(pbp.estLienTransactions({ texte: 'Voir', url: '/consumersite/parkingHistory.aspx' }), true);
  assert.equal(pbp.estLienTransactions({ texte: 'Mon profil', url: '/consumersite/profile.aspx' }), false);
});

test('page introuvable : le journal dit CE QU\'ON A VU, pas seulement l\'échec', async () => {
  // ⚠ Le test qui rend ce connecteur utilisable. La structure du portail après
  // connexion n'a jamais été vue : sans cette description, la première
  // exécution réelle demanderait trois allers-retours pour comprendre.
  const lignes = [];
  const page = {
    url: () => 'https://secure.paybyphone.fr/consumersite/default.aspx',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async (fn) => {
      const rendu = String(fn);
      // `decrirePage` réclame un résumé ; la recherche de liens réclame la liste.
      if (rendu.includes('titre')) {
        return {
          url: 'https://secure.paybyphone.fr/consumersite/default.aspx',
          titre: 'Mon compte',
          liens: ['Mon profil → /consumersite/profile.aspx', 'Se déconnecter → /consumersite/logout.aspx'],
          champs: ['input[text]#SearchBox'],
          boutons: ['Rechercher'],
        };
      }
      return [
        { texte: 'Mon profil', url: 'https://secure.paybyphone.fr/consumersite/profile.aspx' },
        { texte: 'Se déconnecter', url: 'https://secure.paybyphone.fr/consumersite/logout.aspx' },
      ];
    },
  };

  const cible = await pbp.allerAuxTransactions(page, (m) => lignes.push(m));
  assert.equal(cible, null, 'aucun lien de transactions dans cette page');

  const journal = lignes.join('\n');
  assert.match(journal, /aucun lien vers les transactions/i, 'l\'échec est nommé');
  assert.match(journal, /Mon compte/, 'le titre de la page est écrit');
  assert.match(journal, /profile\.aspx/, 'les liens vus sont écrits');
  assert.match(journal, /SearchBox/, 'les champs vus sont écrits');
  assert.match(journal, /Rechercher/, 'les boutons vus sont écrits');
});

test('un lien de transactions trouvé est suivi', async () => {
  const visitees = [];
  const page = {
    url: () => 'https://secure.paybyphone.fr/consumersite/transactions.aspx',
    goto: async (u) => visitees.push(u),
    waitForLoadState: async () => {},
    evaluate: async (fn) => (String(fn).includes('titre')
      ? { url: '', titre: '', liens: [], champs: [], boutons: [] }
      : [{ texte: 'Transactions de stationnement', url: 'https://secure.paybyphone.fr/consumersite/transactions.aspx' }]),
  };

  const cible = await pbp.allerAuxTransactions(page, () => {});
  assert.equal(cible, 'https://secure.paybyphone.fr/consumersite/transactions.aspx');
  assert.deepEqual(visitees, ['https://secure.paybyphone.fr/consumersite/transactions.aspx']);
});

test('une session perdue en route est annoncée comme une session, pas un mot de passe', async () => {
  // Le socle s'en sert pour décider quoi dire : confondre les deux enverrait
  // l'utilisateur changer un mot de passe qui n'a rien à se reprocher.
  const page = {
    url: () => 'https://secure.paybyphone.fr/consumersite/login.aspx',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async (fn) => (String(fn).includes('titre')
      ? { url: '', titre: '', liens: [], champs: [], boutons: [] }
      : [{ texte: 'Transactions de stationnement', url: 'https://secure.paybyphone.fr/consumersite/transactions.aspx' }]),
  };

  await assert.rejects(
    () => pbp.allerAuxTransactions(page, () => {}),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.equal(err.credentialsRejected, undefined);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 7. Le contenu fait foi, et les messages disent quoi faire
// ---------------------------------------------------------------------------

test('un relevé n\'est retenu que si c\'est vraiment un PDF', () => {
  assert.equal(identity.estPdf(Buffer.from('%PDF-1.4 ...')), true);
  assert.equal(identity.estPdf(Buffer.from('<html>login.aspx</html>')), false);
});

test('les messages d\'échec disent quoi faire, jamais ce qui a planté', () => {
  for (const message of [pbp.MESSAGE_SESSION_EXPIREE, pbp.MESSAGE_IDENTIFIANTS]) {
    assert.equal(schema.jargonUtilisateur(message), null);
    assert.match(message, /Vérifiez|refaites|relancez/i);
    assert.doesNotMatch(message, /timeout|selector|undefined|ASP\.NET|VIEWSTATE/i);
  }
});

test('sans utilisateur au contexte, on le dit plutôt que de viser un profil au hasard', async () => {
  await assert.rejects(
    () => pbp.fetchInvoices({ numeroMobile: '0612345678', motDePasse: 'x' }, { log: () => {} }),
    /ctx\.userId/
  );
});

test('sans identifiants, on demande à les renseigner — sans ouvrir de navigateur', async () => {
  await assert.rejects(
    () => pbp.fetchInvoices({}, { userId: 1, log: () => {} }),
    /Renseignez votre numéro de mobile et votre mot de passe/
  );
});

test('le profil de navigateur vit sous le répertoire de données, par utilisateur', () => {
  const profils = require('../server/connectors/profil-persistant');
  assert.match(profils.chemin(1, pbp.ID), /profils-navigateur[/\\]1[/\\]paybyphone$/);
  assert.equal(pbp.ID, MANIFESTE.id);
});
