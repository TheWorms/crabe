'use strict';

/**
 * Lot 21 — les connexions qui passent par quelqu'un d'autre.
 *
 * ─── Ce qui change, et pourquoi ça méritait du code ──────────────────────────
 *
 * Jusqu'à ce lot, toutes les connexions ouvertes à la main restaient chez le
 * fournisseur : on se connecte à Free Mobile sur le site de Free Mobile, à
 * Hetzner sur celui de Hetzner. Trois services arrivent qui n'ont pas cette
 * politesse — Mistral, Anthropic et Envato acceptent « Se connecter avec
 * Google », et les comptes concernés n'ont pas d'autre voie.
 *
 * Le navigateur traverse donc `accounts.google.com` au milieu du parcours. Or
 * la photo prise en fin de connexion est celle du navigateur ENTIER : elle
 * emporterait, en plus de la session du service, de quoi ouvrir la boîte de
 * courriel de l'utilisateur. Chiffré, certes. Mais crabe ne va jamais chez
 * Google : il va chercher une facture chez Mistral.
 *
 * Ce qui n'est pas conservé ne peut pas fuiter. Ces tests vérifient que le tri
 * garde ce qu'il faut, jette le reste, et ne se laisse pas prendre au piège
 * classique du « ce domaine contient mistral.ai ».
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const sessionState = require('../server/connectors/session-state');
const schema = require('../server/connectors/manifest-schema');
const proxmox = require('../server/connectors/available/proxmox/connector');
const mistral = require('../server/connectors/available/mistral/connector');
const infomaniak = require('../server/connectors/available/infomaniak/connector');

/** Un état de session tel que Playwright le rend, Google compris. */
function etatAvecGoogle() {
  return {
    cookies: [
      { name: 'ory_session', domain: '.mistral.ai', value: 'x' },
      { name: 'flow', domain: 'v2.auth.mistral.ai', value: 'y' },
      { name: 'SID', domain: '.google.com', value: 'SECRET' },
      { name: 'SAPISID', domain: 'accounts.google.com', value: 'SECRET' },
      { name: 'piege', domain: 'mistral.ai.exemple.net', value: 'z' },
    ],
    origins: [
      { origin: 'https://console.mistral.ai', localStorage: [{ name: 'a', value: '1' }] },
      { origin: 'https://accounts.google.com', localStorage: [{ name: 'b', value: '2' }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Le tri des domaines
// ---------------------------------------------------------------------------

test('la session Google ne survit pas à la capture', () => {
  const { state, retires, gardes } = sessionState.limiterAuxDomaines(etatAvecGoogle(), ['mistral.ai']);

  assert.deepEqual(state.cookies.map((c) => c.domain), ['.mistral.ai', 'v2.auth.mistral.ai']);
  assert.equal(gardes, 2);
  assert.equal(retires, 3);

  // Et rien de Google ne subsiste nulle part, pas même dans le stockage local.
  assert.equal(JSON.stringify(state).includes('google'), false);
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
});

test('un domaine qui COMMENCE par le bon nom n\'est pas le bon domaine', () => {
  // `mistral.ai.exemple.net` appartient à exemple.net, pas à Mistral. Une
  // comparaison par « contient » l'aurait gardé — et aurait gardé du même coup
  // n'importe quel domaine fabriqué pour ressembler au bon.
  const { state } = sessionState.limiterAuxDomaines(etatAvecGoogle(), ['mistral.ai']);
  assert.equal(state.cookies.some((c) => c.domain.includes('exemple.net')), false);

  assert.equal(sessionState.domaineAutorise('mistral.ai.exemple.net', ['mistral.ai']), false);
  assert.equal(sessionState.domaineAutorise('evil-mistral.ai', ['mistral.ai']), false);
  assert.equal(sessionState.domaineAutorise('.mistral.ai', ['mistral.ai']), true);
  assert.equal(sessionState.domaineAutorise('v2.auth.mistral.ai', ['mistral.ai']), true);
});

test('sans liste déclarée, rien n\'est touché', () => {
  // Les connecteurs écrits avant ce lot ne déclarent pas de domaines : leur
  // comportement ne doit pas bouger d'un cookie.
  const avant = etatAvecGoogle();
  const { state, retires } = sessionState.limiterAuxDomaines(avant, []);
  assert.equal(retires, 0);
  assert.deepEqual(state, avant);
});

// Le cas à plusieurs domaines vient d'Envato — on se connecte sur
// account.envato.com et on facture sur themeforest.net — et il reste vrai après
// le retour d'Envato dans les services annoncés (lot 23) : c'est le tri qui est
// vérifié ici, pas ce connecteur-là.
test('plusieurs domaines : se connecter ici, facturer ailleurs', () => {
  const etat = {
    cookies: [
      { name: 'a', domain: '.account.envato.com' },
      { name: 'b', domain: '.themeforest.net' },
      { name: 'c', domain: '.codecanyon.net' },
      { name: 'd', domain: '.facebook.com' },
      { name: 'e', domain: 'appleid.apple.com' },
    ],
    origins: [],
  };
  const { state } = sessionState.limiterAuxDomaines(etat, ['envato.com', 'themeforest.net', 'codecanyon.net']);
  assert.deepEqual(state.cookies.map((c) => c.name), ['a', 'b', 'c']);
});

test('une session vidée par le tri reste une session refusée par le contrôle', () => {
  // Le garde-fou de dernier recours : si un jour une liste de domaines ne
  // correspond à rien, la session ne doit pas être enregistrée comme valide.
  // Elle échouerait alors à la première récupération, des jours plus tard.
  const { state } = sessionState.limiterAuxDomaines(etatAvecGoogle(), ['service-qui-nexiste-pas.fr']);
  assert.equal(state.cookies.length, 0);
  assert.equal(sessionState.validate(state).ok, false);
});

test('une origine illisible n\'est pas conservée par défaut', () => {
  const { state } = sessionState.limiterAuxDomaines(
    { cookies: [], origins: [{ origin: 'pas-une-url' }, { origin: 'https://console.mistral.ai' }] },
    ['mistral.ai']
  );
  assert.deepEqual(state.origins.map((o) => o.origin), ['https://console.mistral.ai']);
});

// ---------------------------------------------------------------------------
// Le manifeste refuse une déclaration qui ne garderait rien
// ---------------------------------------------------------------------------

/** Un manifeste minimal valide, auquel on greffe le bloc à éprouver. */
function manifesteAvec(keepDomains) {
  return {
    id: 'essai',
    name: 'Essai',
    category: 'divers',
    description: 'Service d\'essai.',
    fields: [{ key: 'session', label: 'Connexion', type: 'session' }],
    permissions: [{
      key: 'factures',
      scope: 'read-write',
      description: 'Ouvre votre espace de facturation pour y lister et télécharger vos factures, '
        + 'puis les dépose sur vos destinations de stockage.',
    }],
    remoteLogin: {
      url: 'https://exemple.fr/login',
      verifyUrl: 'https://exemple.fr/factures',
      keepDomains,
    },
  };
}

test('une liste de domaines vide est refusée, pas ignorée', () => {
  // Une liste vide ne garderait AUCUN cookie : la session serait enregistrée
  // inutilisable, et personne ne saurait pourquoi. Mieux vaut refuser le
  // manifeste au chargement.
  const erreurs = schema.validate(manifesteAvec([])).errors;
  assert.ok(erreurs.some((e) => /keepDomains/.test(e)), erreurs.join(' / '));
});

test('un domaine qui n\'en est pas un est refusé', () => {
  for (const mauvais of [['pas un domaine'], ['https://mistral.ai'], ['']]) {
    const erreurs = schema.validate(manifesteAvec(mauvais)).errors;
    assert.ok(erreurs.some((e) => /keepDomains/.test(e)), `${JSON.stringify(mauvais)}`);
  }
});

test('une liste correcte traverse la normalisation du manifeste', () => {
  // Le piège maison : la normalisation est une LISTE BLANCHE, et une clé
  // oubliée disparaît en silence. C'est exactement ce qui était arrivé à
  // « persistent » le 12/08/2026. Ici, l'oubli ne casserait rien de visible —
  // il se contenterait de garder les cookies Google pour toujours.
  const declare = manifesteAvec(['mistral.ai', ' anthropic.com ']);
  assert.deepEqual(schema.validate(declare).errors, [], 'le manifeste doit d\'abord être valide');

  const charge = schema.normalize(declare);
  assert.deepEqual(charge.remoteLogin.keepDomains, ['mistral.ai', 'anthropic.com']);

  // Et un connecteur qui n'en déclare pas obtient une liste vide, pas
  // « undefined » : le tri se lit alors « rien à écarter », sans avoir à
  // se demander si la clé existe.
  const sansListe = manifesteAvec(undefined);
  delete sansListe.remoteLogin.keepDomains;
  assert.deepEqual(schema.normalize(sansListe).remoteLogin.keepDomains, []);
});

// ---------------------------------------------------------------------------
// Les connecteurs refondus : plus une ligne de mot de passe scripté
// ---------------------------------------------------------------------------

test('Mistral ne sait plus remplir de formulaire de connexion', () => {
  // La refonte serait cosmétique si le code de connexion scriptée était resté
  // là, prêt à resservir. Ce fichier ne doit plus contenir aucun sélecteur de
  // mot de passe ni aucune saisie. (Envato subissait le même contrôle jusqu'au
  // lot 23, qui a retiré son connecteur du catalogue.)
  const fs = require('node:fs');
  for (const chemin of [
    'server/connectors/available/mistral/connector.js',
  ]) {
    const code = fs.readFileSync(chemin, 'utf8');
    assert.equal(/input\[name="password"\]/.test(code), false, `${chemin} : sélecteur de mot de passe`);
    assert.equal(/\.fill\(/.test(code), false, `${chemin} : saisie de formulaire`);
    assert.equal(/CHAMP_MOT_DE_PASSE/.test(code), false, `${chemin} : champ de mot de passe`);
  }
});

test('Mistral reconnaît son domaine d\'authentification, pas seulement ses chemins', () => {
  // Le retour d'Ory se fait sur `v2.auth.mistral.ai/login?flow=<uuid>` : le
  // domaine est le repère stable, les étapes changent de nom plus souvent.
  assert.equal(mistral.estPageAuthentification('https://auth.mistral.ai/self-service/login/browser'), true);
  assert.equal(mistral.estPageAuthentification('https://v2.auth.mistral.ai/login?flow=abc'), true);
  assert.equal(mistral.estPageAuthentification('https://console.mistral.ai/admin/billing'), false);
  // Le piège du paramètre : une page authentifiée qui porte « login » dans sa
  // requête reste une page authentifiée.
  assert.equal(
    mistral.estPageAuthentification('https://console.mistral.ai/admin/billing?return_to=%2Flogin'),
    false
  );
});

// ⚠ Deux tests d'Envato vivaient ici — l'adresse du relevé construite à partir
// du nom d'utilisateur, et la distinction entre « rien acheté » et « nom
// d'utilisateur faux ». Ils sont partis avec le connecteur au lot 23 : ni la
// piste account.envato.com ni la piste themeforest.net n'ayant abouti, le
// service est redevenu une simple annonce. Ce qui a été mesuré est conservé
// dans la note technique de son manifeste, sous `planned/envato/`, pour que la
// reprise ne reparte pas de zéro.

// ---------------------------------------------------------------------------
// Proxmox — une boutique WHMCS, mesurée et pas supposée
// ---------------------------------------------------------------------------

test('le numéro de facture se lit dans les deux formes de lien de WHMCS', () => {
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/viewinvoice.php?id=4212'), '4212');
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/dl.php?type=i&id=4212'), '4212');
  // `type=invoice` n'est jamais servi par la boutique, mais s'il ressort d'une
  // page un jour il désigne bien une facture : toléré à la LECTURE (lot 22).
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/dl.php?type=invoice&id=4212'), '4212');
  // Le même `dl.php` sert les devis et les fichiers joints : prendre le numéro
  // sans regarder le type ferait passer un devis pour une facture.
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/dl.php?type=q&id=9'), null);
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/dl.php?type=f&id=9'), null);
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/dl.php?type=attachment&id=9'), null);
  assert.equal(proxmox.numeroDeFacture('https://shop.proxmox.com/cart.php?id=7'), null);
  assert.equal(proxmox.numeroDeFacture(''), null);
});

test('une facture listée deux fois ne donne qu\'un document', () => {
  // Chaque ligne du tableau porte « Voir » et « Télécharger » : deux liens, une
  // seule facture. Sans dédoublonnage, chaque facture serait déposée deux fois.
  const docs = proxmox.facturesDepuisLiens([
    { href: 'https://shop.proxmox.com/viewinvoice.php?id=42', texte: 'View', ligne: 'Facture 42 12/03/2026 220,00 EUR' },
    { href: 'https://shop.proxmox.com/dl.php?type=i&id=42', texte: 'PDF', ligne: 'Facture 42 12/03/2026 220,00 EUR' },
    { href: 'https://shop.proxmox.com/announcements.php', texte: 'Annonces', ligne: '' },
  ]);

  assert.equal(docs.length, 1);
  assert.equal(docs[0].remoteId, 'proxmox-facture-42');
  assert.equal(docs[0].url, 'https://shop.proxmox.com/dl.php?type=i&id=42');
  assert.equal(docs[0].issuedOn, '2026-03-12');
});

test('le PDF est toujours demandé à la route de téléchargement, jamais à la page', () => {
  // `viewinvoice.php` rend une page HTML : la déposer sous un nom en « .pdf »
  // donnerait un fichier illisible que personne n'ouvrirait avant des mois.
  const docs = proxmox.facturesDepuisLiens([
    { href: 'https://shop.proxmox.com/viewinvoice.php?id=7', texte: 'View', ligne: '' },
  ]);
  assert.match(docs[0].url, /dl\.php\?type=i&id=7$/);
  assert.equal(proxmox.urlPdf('7'), 'https://shop.proxmox.com/dl.php?type=i&id=7');
});

test('le PDF se demande à « type=i », jamais à « type=invoice » (lot 22)', () => {
  // ─── Ce que ce test empêche de revenir ────────────────────────────────────
  //
  // Le lot 21 écrivait `type=invoice`, en l'appelant « la route standard de
  // WHMCS ». Mesuré derrière une vraie session le 13/08/2026 : cette adresse
  // rend 200, `text/html`, 22 721 octets — la page d'ACCUEIL de l'espace
  // client, et pour toutes les factures. `type=i` rend `application/pdf`,
  // 93 424 octets, `content-disposition: attachment; filename="Facture-…pdf"`.
  //
  // Ce n'était donc pas une facture en défaut, c'était la route : la 23366
  // n'avait rien de particulier, elle était simplement la première de la liste.
  const url = proxmox.urlPdf('23366');
  assert.equal(url, 'https://shop.proxmox.com/dl.php?type=i&id=23366');
  assert.doesNotMatch(url, /type=invoice/, 'cette adresse rend la page d\'accueil, pas le PDF');

  // Et le numéro reste échappé : une valeur venue d'une page ne compose pas
  // l'adresse suivante sans passer par l'encodage.
  assert.equal(proxmox.urlPdf('7&x=1'), 'https://shop.proxmox.com/dl.php?type=i&id=7%26x%3D1');
});

test('une facture qui ne descend pas n\'emporte plus les autres (lot 22)', () => {
  // On lit le source : monter un vrai navigateur ici n'est pas possible, et ce
  // qui compte est la FORME de la boucle. Jusqu'au lot 22, `await telecharger()`
  // était appelé directement dans le `push` — la première erreur remontait, et
  // les neuf factures suivantes n'étaient jamais tentées. Le compte rendu
  // accusait alors une facture d'une panne qui les concernait toutes.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'server', 'connectors', 'available', 'proxmox', 'connector.js'),
    'utf8'
  );
  const boucle = /for \(const doc of documents\)[\s\S]*?\n    }/.exec(source)?.[0] || '';

  assert.ok(boucle, 'la boucle de récupération doit rester repérable');
  assert.match(boucle, /try \{[\s\S]*telecharger\(/, 'chaque téléchargement doit être isolé');
  assert.doesNotMatch(
    boucle,
    /buffer:\s*await telecharger\(/,
    'un téléchargement dans le push fait échouer toute la récupération sur la première erreur'
  );
  // Et zéro document récupéré alors qu'il y en avait à prendre reste un ÉCHEC :
  // une récupération « réussie » à zéro laisserait croire qu'il n'y avait rien.
  assert.match(source, /if \(candidates && !invoices\.length\)[\s\S]{0,200}throw new Error/);
});

test('Proxmox reconnaît sa page de connexion, qui vit dans un PARAMÈTRE', () => {
  // WHMCS renvoie vers `index.php?rp=/login` : le chemin ne dit rien, c'est la
  // requête qui porte l'étape. C'est l'exception à la règle « jamais la
  // requête », et elle est mesurée sur le portail réel.
  assert.equal(proxmox.estPageAuthentification('https://shop.proxmox.com/index.php?rp=/login'), true);
  assert.equal(proxmox.estPageAuthentification('https://shop.proxmox.com/login.php'), true);
  assert.equal(proxmox.estPageAuthentification('https://shop.proxmox.com/clientarea.php?action=invoices'), false);
  assert.equal(proxmox.estPageAuthentification('https://shop.proxmox.com/'), false);
});

test('Proxmox dit de quel compte il parle, et des deux qu\'il ne demande pas', async () => {
  await assert.rejects(
    () => proxmox.test({}),
    /Identifiants de la boutique Proxmox manquants.*adresse électronique.*mot de passe/s
  );
});

// ---------------------------------------------------------------------------
// Infomaniak — ce qu'on ne sait pas, on le dit
// ---------------------------------------------------------------------------

test('Infomaniak reconnaît le retour vers la connexion, y compris « authorize »', () => {
  // Le flux OAuth renvoie vers `login.infomaniak.com/authorize?…`, dont le
  // chemin ne contient aucun mot d'authentification évident. Sans ce contrôle,
  // une session tombée passerait pour une page de factures vide.
  assert.equal(infomaniak.estPageAuthentification('https://login.infomaniak.com/authorize?scope=x'), true);
  assert.equal(infomaniak.estPageAuthentification('https://login.infomaniak.com/fr/login'), true);
  assert.equal(
    infomaniak.estPageAuthentification('https://manager.infomaniak.com/v3/ng/accounts/invoices'),
    false
  );
});

test('Infomaniak nomme la page des factures au lieu d\'annoncer qu\'il n\'y en a pas', () => {
  // Le lot 21 ne savait PAS où vivaient les factures : son message demandait à
  // l'utilisateur de le lui apprendre, et c'était la bonne réponse à
  // l'ignorance du moment. Le lot 24 les a trouvées — le message nomme donc la
  // page exacte, et ne demande plus qu'une chose : qu'on le signale s'il s'y
  // trompe. Ce qui ne change pas, et qui était l'essentiel : jamais un
  // « 0 facture » annoncé comme un fait sur une réponse qu'on n'a pas comprise.
  const message = infomaniak.messageReleveVide('854637');
  assert.match(message, /aucune facture n'a été trouvée/i);
  assert.match(message, /manager\.infomaniak\.com\/v3\/invoicing\/854637\/bills/);
  assert.match(message, /signalez-le/i);
  assert.equal(/0 facture/.test(message), false);
});

test('la liste des domaines ne descend pas jusqu\'au navigateur', () => {
  // C'est un réglage de capture, appliqué côté serveur. Le front n'en fait
  // rien — et ce que l'utilisateur doit savoir est écrit en français dans
  // l'aide du champ, pas dans une clé technique qu'il ne verra jamais.
  const vue = schema.publicView(schema.normalize(manifesteAvec(['mistral.ai'])));
  assert.equal('keepDomains' in vue.remoteLogin, false);
  assert.equal(JSON.stringify(vue).includes('keepDomains'), false);

  // Le reste du bloc, lui, continue de descendre : le front en a besoin pour
  // ouvrir la fenêtre au bon endroit.
  assert.equal(vue.remoteLogin.url, 'https://exemple.fr/login');
  assert.equal(vue.remoteLogin.verifyUrl, 'https://exemple.fr/factures');
});

test('un connecteur réel n\'expose pas ses domaines dans sa fiche', () => {
  // Le manifeste livré de Mistral, lu sur le disque et passé par la même
  // chaîne que le serveur : contrôle, normalisation, vue publique.
  const brut = JSON.parse(
    require('node:fs').readFileSync('server/connectors/available/mistral/manifest.json', 'utf8')
  );
  assert.deepEqual(schema.validate(brut, 'mistral').errors, []);

  const charge = schema.normalize(brut);
  assert.deepEqual(charge.remoteLogin.keepDomains, ['mistral.ai'], 'le serveur, lui, les connaît');
  assert.equal('keepDomains' in schema.publicView(charge).remoteLogin, false);
});

// ---------------------------------------------------------------------------
// Ce que devient un mot de passe devenu inutile (lot 21)
// ---------------------------------------------------------------------------

/**
 * Envato et Mistral demandaient un mot de passe avant ce lot. Les comptes qui
 * les avaient configurés ont donc un mot de passe chiffré en base, pour un
 * champ qui n'existe plus.
 *
 * La question n'est pas théorique : un secret qu'on garde est un secret qu'on
 * peut perdre. On vérifie donc que l'enregistrement suivant s'en débarrasse,
 * plutôt que de le supposer d'après la lecture du code.
 */
test('une clé de configuration qui n\'est plus déclarée ne survit pas au prochain enregistrement', async () => {
  const helpers = require('./helpers');
  const registry = require('../server/connectors/registry');

  // `setup()` est idempotent ; on ne appelle PAS `teardown()` en retour, qui
  // effacerait le répertoire de données partagé par tout le fichier. Le
  // processus de test s'en charge en s'arrêtant.
  await helpers.setup();
  {
    const user = await helpers.createUser({ username: 'lot21-purge' });
    registry.install(user.id, 'edf');
    registry.saveConfig(user.id, 'edf', { username: 'camille@exemple.fr', password: 'mot-de-passe' });

    // On simule l'état d'avant-refonte : une clé en trop, écrite du temps où
    // le manifeste la déclarait.
    const crypto = require('../server/crypto');
    const db = helpers.db.get();
    const ligne = db
      .prepare('SELECT config_encrypted FROM connector_installs WHERE user_id = ? AND connector_id = ?')
      .get(user.id, 'edf');
    const config = crypto.tryDecryptJson(ligne.config_encrypted, {});
    config.motDePasseDUnChampDisparu = 'SECRET-QUI-NE-SERT-PLUS';
    db.prepare('UPDATE connector_installs SET config_encrypted = ? WHERE user_id = ? AND connector_id = ?')
      .run(crypto.encrypt(JSON.stringify(config)), user.id, 'edf');

    assert.equal(
      registry.readConfig(user.id, 'edf').motDePasseDUnChampDisparu,
      'SECRET-QUI-NE-SERT-PLUS',
      'la mise en situation doit être effective, sinon le test ne prouve rien'
    );

    // Le geste ordinaire : l'utilisateur réenregistre sa configuration.
    registry.saveConfig(user.id, 'edf', { username: 'camille@exemple.fr', password: 'mot-de-passe' });

    const apres = registry.readConfig(user.id, 'edf');
    assert.equal(apres.motDePasseDUnChampDisparu, undefined, 'la clé disparue doit être purgée');
    assert.equal(apres.username, 'camille@exemple.fr', 'les champs déclarés, eux, restent');
  }
});
