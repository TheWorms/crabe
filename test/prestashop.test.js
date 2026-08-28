'use strict';

/**
 * Le connecteur PrestaShop — un seul code, sept boutiques.
 *
 * Ce qui est vérifié ici est ce qui a réellement coûté du temps pendant
 * l'exploration des 10-11/08/2026 :
 *
 *   - les DEUX schémas de lien de facture, et l'ordre dans lequel on les
 *     cherche ;
 *   - l'exclusion des liens sans rapport, qui sont légion sur une page de
 *     boutique — et qui se trient sur l'URL, jamais sur le texte ;
 *   - la lecture du numéro, de la date et du montant AUTOUR du lien, sans
 *     déborder sur la commande voisine ;
 *   - une boutique servie par son manifeste, une autre par une adresse saisie.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prestashop = require('../server/connectors/available/prestashop/connector');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');

const AVAILABLE = path.join(__dirname, '..', 'server', 'connectors', 'available');
const PLANNED = path.join(__dirname, '..', 'server', 'connectors', 'planned');

/**
 * Les sept boutiques validées.
 *
 * L'entrée générique « boutique-prestashop » y figurait jusqu'au lot 17. Elle
 * demandait à l'utilisateur de taper l'adresse de sa boutique et de savoir
 * qu'elle tourne sous PrestaShop — deux choses qu'un public non technique n'a
 * aucune raison de savoir. Jamais installée, aucune facture, aucun journal :
 * elle a été retirée. Le connecteur partagé, lui, sait toujours déduire ses
 * adresses d'un site saisi (voir plus bas) ; c'est la tuile du catalogue qui
 * disparaît, pas la capacité.
 */
const BOUTIQUES = [
  'fantazia', 'aagaard', 'coco-papaya', 'ile-aux-epices',
  'kubii', 'propolia', 'apiculture-net',
];

/**
 * Un manifeste sans adresses, comme celui que servait l'entrée générique.
 *
 * Écrit ici plutôt que lu sur le disque : ce qui est vérifié est le
 * COMPORTEMENT du connecteur partagé face à un service dont l'adresse vient de
 * la configuration, et il ne doit pas dépendre de la présence d'une tuile.
 */
const SANS_ADRESSES = { id: 'boutique-generique', name: 'Ma boutique' };

function manifeste(id) {
  return JSON.parse(fs.readFileSync(path.join(AVAILABLE, id, 'manifest.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Une implémentation, plusieurs tuiles
// ---------------------------------------------------------------------------

test('les huit boutiques sont disponibles, et partagent un seul code', () => {
  const chargement = registry.load();
  assert.deepEqual(chargement.errors, [], 'aucune erreur de chargement');

  const modules = new Set();
  for (const id of BOUTIQUES) {
    const entree = registry.get(id);
    assert.equal(entree.planned, false, `${id} doit être disponible`);
    assert.equal(entree.manifest.implementation, 'prestashop');
    assert.equal(typeof entree.module.fetchInvoices, 'function');
    modules.add(entree.module);
  }

  // Un seul module en mémoire pour les huit tuiles — pas huit copies du même
  // fichier. Ce n'est pas une coquetterie : le registre vide `require.cache`
  // avant chaque chargement pour relire le disque, ce qui est juste pour un
  // connecteur et faux pour du code commun.
  assert.equal(modules.size, 1, 'un seul module pour les huit tuiles');

  // Et c'est bien l'implémentation PrestaShop, reconnaissable à ce qu'elle
  // expose. (Pas une égalité de référence : le registre relit le fichier au
  // chargement, l'instance du registre et celle de ce test sont deux objets.)
  const partage = [...modules][0];
  for (const cle of Object.keys(prestashop)) {
    assert.ok(cle in partage, `l'implémentation partagée doit exposer ${cle}`);
  }
  assert.equal(partage.MOTIF_STANDARD.source, prestashop.MOTIF_STANDARD.source);
});

test('le dossier d\'implémentation n\'est pas un service : il ne s\'installe pas', () => {
  registry.load();

  // `available/prestashop/` porte du code et pas de manifeste. Il ne doit
  // apparaître ni dans le Store, ni dans le catalogue d'administration.
  assert.ok(
    fs.existsSync(path.join(AVAILABLE, 'prestashop', 'connector.js')),
    'le code partagé est bien là'
  );
  assert.ok(
    !fs.existsSync(path.join(AVAILABLE, 'prestashop', 'manifest.json')),
    'et il n\'a volontairement pas de manifeste'
  );

  // Le service « PrestaShop » — l'abonnement à la plateforme — était annoncé
  // dans planned/. Il a été retiré du catalogue au lot 16, addons-prestashop
  // couvrant le besoin réel. Le nom `prestashop` ne désigne donc plus qu'une
  // chose : ce dossier de code. Il ne doit apparaître dans AUCUN catalogue —
  // si un manifeste réapparaissait ici, l'implémentation partagée deviendrait
  // un service installable, et les huit boutiques se mettraient à charger un
  // module qui n'est pas fait pour ça.
  assert.equal(registry.isPlanned('prestashop'), false);
  assert.equal(registry.has('prestashop'), false, 'ni disponible, ni annoncé');
  assert.equal(
    fs.existsSync(path.join(PLANNED, 'prestashop')),
    false,
    'et son dossier d\'annonce a bien disparu'
  );
});

test('chaque boutique garde son nom, son site et ses adresses', () => {
  const attendu = {
    fantazia: 'https://www.fantazia-shop.fr/historique-des-commandes',
    aagaard: 'https://www.aagaard.fr/historique-commandes',
    'coco-papaya': 'https://www.coco-papaya.com/fr/historique-commandes',
    'ile-aux-epices': 'https://ileauxepices.com/historique-commandes',
    kubii: 'https://www.kubii.com/fr/index.php?controller=history',
    propolia: 'https://propolia.com/fr/historique-commandes',
    'apiculture-net': 'https://www.apiculture.net/historique-des-commandes',
  };

  for (const [id, orders] of Object.entries(attendu)) {
    const m = manifeste(id);
    assert.equal(m.urls.orders, orders, `${id} : page des commandes`);
    assert.match(m.urls.login, /^https:\/\//, `${id} : connexion en HTTPS`);
    assert.ok(m.name && m.site, `${id} : nom et site`);
  }

  // Chaque boutique est une TUILE avec ses adresses : plus aucune n'attend que
  // l'utilisateur tape la sienne depuis le retrait de l'entrée générique.
  for (const id of BOUTIQUES) {
    assert.equal(
      manifeste(id).fields.some((f) => f.key === 'site'),
      false,
      `${id} : une boutique nommée ne demande pas son adresse à l'utilisateur`
    );
  }
});

test('Le Petit Vapoteur reste annoncé, et n\'est pas déclaré PrestaShop', () => {
  // Protection Cloudflare qui ferme la connexion avant même la saisie : le
  // déclarer le rendrait installable, et il échouerait à tous les coups.
  registry.load();
  assert.equal(registry.isPlanned('le-petit-vapoteur'), true);

  const m = registry.manifest('le-petit-vapoteur');
  assert.notEqual(m.implementation, 'prestashop');
  assert.match(m.caveat, /anti-robot|Cloudflare|filtre/i, 'la réserve est dite à l\'utilisateur');
});

test('une adresse de manifeste en clair est refusée au chargement', () => {
  const enClair = { ...manifeste('propolia'), urls: { login: 'http://propolia.com/fr/connexion' } };
  const rendu = schema.validate(enClair, 'propolia');

  assert.equal(rendu.ok, false);
  assert.ok(rendu.errors.some((e) => /HTTPS/.test(e)), 'on y saisit un mot de passe');
});

// ---------------------------------------------------------------------------
// Les deux schémas de facture
// ---------------------------------------------------------------------------

test('le schéma standard est reconnu — six boutiques sur sept', () => {
  const liens = [
    'https://propolia.com/index.php?controller=pdf-invoice&id_order=1042',
    'https://www.kubii.com/fr/index.php?controller=pdf-invoice&id_order=520390768',
    // L'ordre des paramètres n'est pas garanti d'une boutique à l'autre.
    'https://www.aagaard.fr/index.php?id_order=77&controller=pdf-invoice',
  ];

  for (const href of liens) {
    assert.equal(prestashop.schemaDuLien(href), 'standard', href);
    assert.equal(prestashop.estLienFacture(href), true);
  }

  assert.equal(prestashop.numeroDepuisLien(liens[0]), '1042');
  assert.equal(prestashop.numeroDepuisLien(liens[1]), '520390768');
  assert.equal(prestashop.numeroDepuisLien(liens[2]), '77');
});

test('le schéma module est reconnu — Apiculture.net', () => {
  const href = 'https://www.apiculture.net/modules/eggsodoo/pdf-invoice.php?id_order=8891';

  assert.equal(prestashop.schemaDuLien(href), 'module');
  assert.equal(prestashop.estLienFacture(href), true);
  assert.equal(prestashop.numeroDepuisLien(href), '8891');

  // Le nom du module n'est pas écrit en dur : une autre boutique pourrait en
  // utiliser un autre, avec le même fichier.
  assert.equal(
    prestashop.schemaDuLien('https://x.fr/modules/autremodule/pdf-invoice.php?id_order=1'),
    'module'
  );
});

test('les liens sans rapport sont écartés — sur l\'URL, jamais sur le texte', () => {
  // Tous ces liens existent réellement sur une page d'historique de commandes.
  const parasites = [
    'https://www.avis-verifies.com/avis-clients/propolia.com',
    'https://propolia.com/blog/comment-lire-sa-facture',
    'https://propolia.com/index.php?controller=order-detail&id_order=1042',
    'https://propolia.com/index.php?controller=order-return&id_order=1042',
    'https://propolia.com/contactez-nous',
    'https://www.facebook.com/propolia',
  ];

  for (const href of parasites) {
    assert.equal(prestashop.estLienFacture(href), false, href);
  }

  // Le piège : un lien dont le TEXTE dit « Facture » sans en être une. Le tri
  // porte sur l'adresse, et cette adresse-là n'est pas un schéma de facture.
  assert.equal(
    prestashop.estLienFacture('https://propolia.com/index.php?controller=order-detail&id_order=7'),
    false
  );
});

test('le filet de diagnostic ne se déclenche que sur l\'adresse', () => {
  // Quand aucun schéma connu ne répond, on relève ce qui ressemble à une
  // facture pour que la boutique soit diagnosticable — mais toujours sur
  // l'URL, et jamais sur le domaine.
  assert.equal(prestashop.estLienSuspect('https://x.fr/telecharger/facture-2026.pdf'), true);
  assert.equal(prestashop.estLienSuspect('https://x.fr/my-invoices/42'), true);
  assert.equal(prestashop.estLienSuspect('https://facturation.example.com/accueil'), false,
    'le domaine ne compte pas');
  assert.equal(prestashop.estLienSuspect('https://x.fr/contactez-nous'), false);
  assert.equal(prestashop.estLienSuspect(''), false);
});

// ---------------------------------------------------------------------------
// Numéro, date, montant
// ---------------------------------------------------------------------------

test('Kubii : tout est dans la ligne, et tout est lu', () => {
  // « 520390768 11/07/2026 25,50 € Commande livrée et payée »
  const infos = prestashop.infosDepuisTexte(
    '520390768 11/07/2026 25,50 € Commande livrée et payée Facture'
  );

  assert.equal(infos.issuedOn, '2026-07-11');
  assert.equal(infos.amount, '25,50 EUR');
  assert.equal(infos.reference, '520390768');
});

test('Fantazia : la référence à neuf lettres, et un montant à quatre chiffres', () => {
  const infos = prestashop.infosDepuisTexte(
    'Commande KHZLQWXTR du 03/02/2026 — Total 1 249,00 € — Paiement accepté'
  );

  assert.equal(infos.issuedOn, '2026-02-03');
  assert.equal(infos.amount, '1249,00 EUR');
  assert.equal(infos.reference, 'KHZLQWXTR');
});

test('une date sur un seul chiffre passe, un texte sans date ne ment pas', () => {
  assert.equal(prestashop.infosDepuisTexte('le 7/3/2026').issuedOn, '2026-03-07');

  const vide = prestashop.infosDepuisTexte('Commande en cours de préparation');
  assert.equal(vide.issuedOn, null);
  assert.equal(vide.amount, null);
});

test('sans date, le document part dans « inconnu » plutôt que d\'échouer', () => {
  assert.equal(prestashop.nomFichier('2026-07-11', '1042'), '2026-07_1042.pdf');
  assert.equal(prestashop.nomFichier(null, '1042'), 'inconnu_1042.pdf');
  assert.equal(prestashop.nomFichier('', '1042'), 'inconnu_1042.pdf');
  // Le mois en tête : l'ordre alphabétique est l'ordre chronologique.
  assert.ok(prestashop.nomFichier('2026-01-05', 'a') < prestashop.nomFichier('2026-11-05', 'b'));
});

test('le remoteId est le numéro de commande, stable d\'une visite à l\'autre', () => {
  // Le piège d'Amazon : un identifiant régénéré à chaque visite fait
  // retélécharger tout l'historique à chaque exécution, indéfiniment.
  assert.equal(prestashop.remoteIdPour('1042'), 'commande-1042');
  assert.equal(
    prestashop.remoteIdPour(
      prestashop.numeroDepuisLien('https://x.fr/index.php?controller=pdf-invoice&id_order=1042')
    ),
    'commande-1042'
  );
});

test('un même numéro vu deux fois ne donne qu\'une commande', () => {
  const commandes = prestashop.commandesDepuisLiens([
    { href: 'https://x.fr/index.php?controller=pdf-invoice&id_order=12', texte: 'du 01/06/2026 10,00 €' },
    // Le même lien, dans un menu déplié plus bas dans la page.
    { href: 'https://x.fr/index.php?controller=pdf-invoice&id_order=12', texte: 'Facture' },
    { href: 'https://x.fr/index.php?controller=pdf-invoice&id_order=13', texte: 'du 02/07/2026 20,00 €' },
  ]);

  assert.equal(commandes.length, 2);
  assert.deepEqual(commandes.map((c) => c.numero), ['12', '13']);
  assert.equal(commandes[0].issuedOn, '2026-06-01', 'le premier vu garde son contexte');
});

test('un lien de facture sans numéro reçoit quand même un nom', () => {
  const commandes = prestashop.commandesDepuisLiens([
    { href: 'https://x.fr/modules/m/pdf-invoice.php', texte: 'du 01/06/2026' },
  ]);
  assert.equal(commandes.length, 1);
  assert.match(commandes[0].numero, /^sans-numero-/);
});

// ---------------------------------------------------------------------------
// Quelle boutique ?
// ---------------------------------------------------------------------------

test('une boutique validée tire ses adresses de son manifeste', () => {
  const adresses = prestashop.adressesBoutique(manifeste('propolia'), {});

  assert.equal(adresses.login, 'https://propolia.com/fr/connexion');
  assert.equal(adresses.orders, 'https://propolia.com/fr/historique-commandes');
  assert.equal(adresses.nom, 'Propolia');
});

test('un manifeste sans adresses déduit les siennes de ce que l\'utilisateur saisit', () => {
  for (const saisie of ['maboutique.fr', 'https://maboutique.fr', 'https://maboutique.fr/fr/']) {
    const adresses = prestashop.adressesBoutique(SANS_ADRESSES, { site: saisie });
    // Les deux chemins qui fonctionnent même quand les jolies adresses sont
    // désactivées — ce que « /historique-commandes » ne garantit pas.
    assert.equal(adresses.login, 'https://maboutique.fr/index.php?controller=authentication');
    assert.equal(adresses.orders, 'https://maboutique.fr/index.php?controller=history');
  }

  // Toujours en HTTPS : on y saisit un mot de passe.
  assert.match(prestashop.racineDepuisSite('http://maboutique.fr'), /^https:/);
});

test('une adresse absente ou absurde le dit, et dit quoi faire', () => {
  for (const mauvaise of ['', '   ', 'maboutique', 'http://']) {
    assert.throws(
      () => prestashop.adressesBoutique(SANS_ADRESSES, { site: mauvaise }),
      /adresse de la boutique/i,
      JSON.stringify(mauvaise)
    );
  }
});

test('le dossier porte l\'adresse électronique du compte, ou « compte »', () => {
  assert.equal(prestashop.compteDepuisConfig({ email: 'Camille@Exemple.FR' }), 'camille@exemple.fr');
  assert.equal(prestashop.compteDepuisConfig({ email: 'pas-une-adresse' }), 'compte');
  assert.equal(prestashop.compteDepuisConfig({}), 'compte');
});

// ---------------------------------------------------------------------------
// Ce qu'on ne fait jamais
// ---------------------------------------------------------------------------

test('une connexion refusée s\'arrête là, et le dit sans jargon', () => {
  const echecs = require('../server/connectors/messages-echec');
  const err = echecs.erreurPour('identifiants-refuses');

  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Adresse électronique ou mot de passe incorrect/);

  // La règle vaut pour tous les connecteurs : insister sur un formulaire de
  // connexion renforce les soupçons des protections anti-robot.
  const source = fs.readFileSync(
    path.join(AVAILABLE, 'prestashop', 'connector.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /for\s*\([^)]*tentative/i, 'aucune boucle de nouvelle tentative');
  assert.match(source, /Aucune nouvelle tentative/i);
});

/**
 * Le connecteur ne fabrique plus ses messages (lot 14, §2.1).
 *
 * Ils venaient d'ici, et deux défauts en sont sortis : le mauvais message
 * (Propolia recevait « mot de passe incorrect » sur une session qui n'avait
 * jamais existé) et le mauvais service (« … sur Propolia » lu sur la fiche
 * d'Aagaard). La table partagée règle les deux — et ce test vérifie que le
 * connecteur n'en reconstruit pas une en douce.
 */
test('le connecteur ne fabrique plus ses propres messages d\'échec', () => {
  const source = fs.readFileSync(path.join(AVAILABLE, 'prestashop', 'connector.js'), 'utf8');

  assert.match(source, /require\('\.\.\/\.\.\/messages-echec'\)/, 'la table partagée est requise');
  for (const disparu of ['erreurIdentifiants', 'erreurBandeau', 'erreurInjoignable']) {
    assert.doesNotMatch(
      source,
      new RegExp(`function ${disparu}\\b`),
      `${disparu} ne doit plus exister : son message nommait le connecteur`
    );
  }

  // Aucun message affiché à l'utilisateur ne doit interpoler un nom de
  // service : c'est ce qui rendait `last_error` faux dès qu'il s'affichait
  // ailleurs que sur la fiche d'origine.
  const echecs = require('../server/connectors/messages-echec');
  for (const cle of echecs.CLES) {
    assert.doesNotMatch(
      echecs.messagePour(cle),
      /\$\{|Propolia|Aagaard|Kubii/,
      `le message « ${cle} » ne doit nommer aucun service`
    );
  }
});

/**
 * §5.a — une connexion « réussie » ne suffit pas : la page des commandes doit
 * être atteignable. Une boutique qui accepte le formulaire puis renvoie à
 * l'authentification donnait zéro facture sans le moindre message.
 */
test('un renvoi vers l\'authentification est reconnu, sans confondre le domaine', () => {
  for (const url of [
    'https://propolia.com/fr/connexion',
    'https://www.coco-papaya.com/index.php?controller=authentication&back=history',
    'https://boutique.fr/login',
  ]) {
    assert.equal(prestashop.estRenvoyeALAuthentification(url), true, url);
  }

  for (const url of [
    'https://propolia.com/fr/historique-commandes',
    'https://www.kubii.com/index.php?controller=history',
    // Le DOMAINE ne doit rien décider : une boutique nommée « maconnexion.fr »
    // n'est pas une page de connexion.
    'https://maconnexion.fr/index.php?controller=history',
  ]) {
    assert.equal(prestashop.estRenvoyeALAuthentification(url), false, url);
  }
});

test('la profondeur d\'historique écarte les années non demandées, jamais les sans-date', () => {
  assert.equal(prestashop.dansLaFenetre('2026-07-11', [2026]), true);
  assert.equal(prestashop.dansLaFenetre('2024-07-11', [2026]), false);
  // Sans date, on garde : mieux vaut un document de trop dans `inconnu/`
  // qu'un document perdu parce qu'on n'a pas su le dater.
  assert.equal(prestashop.dansLaFenetre(null, [2026]), true);
  assert.equal(prestashop.dansLaFenetre('2020-01-01', []), true, 'aucun filtre = tout passe');
});

/**
 * Le connecteur ne tient plus sa propre liste de libellés : il appelle le
 * module partagé, qui reconnaît sept régies et cherche aussi dans les cadres.
 * Trois listes séparées, c'était trois niveaux de qualité — et le bandeau de
 * Propolia passait au travers des trois.
 */
test('le bandeau de cookies est confié au module partagé, avant toute saisie', () => {
  const source = fs.readFileSync(path.join(AVAILABLE, 'prestashop', 'connector.js'), 'utf8');

  assert.match(source, /require\('\.\.\/\.\.\/obstructions'\)/, 'le module partagé est requis');
  assert.doesNotMatch(
    source,
    /const BOUTONS_COOKIES/,
    'plus de liste de libellés propre au connecteur'
  );

  // La fermeture doit précéder le `fill` du formulaire, pas seulement le clic :
  // un bandeau recouvre aussi bien le champ que le bouton.
  const fermeture = source.indexOf('cookieBanner.fermer(');
  const saisie = source.indexOf('await email.fill(');
  assert.ok(fermeture > 0 && saisie > 0);
  assert.ok(fermeture < saisie, 'le bandeau est fermé AVANT la saisie du formulaire');
});

// ---------------------------------------------------------------------------
// Manifestes
// ---------------------------------------------------------------------------

test('chaque boutique décrit ce qu\'elle fait en UNE phrase, sans jargon', () => {
  for (const id of BOUTIQUES) {
    const m = manifeste(id);
    assert.ok(m.description.length <= schema.DESCRIPTION_MAX, `${id} : description trop longue`);
    assert.equal(schema.compterPhrases(m.description), 1, `${id} : une seule phrase`);
    assert.match(m.description, /^Récupère automatiquement/, id);

    // Le technique va dans la note d'administration, jamais sous les yeux de
    // l'utilisateur.
    assert.ok(m.technicalNote.length > 200, `${id} : la note technique dit ce qu'il faut`);
    assert.ok(
      !schema.publicView(schema.normalize(m)).technicalNote,
      `${id} : la note technique ne sort pas vers le client`
    );
  }
});

test('les permissions sont détaillées, et propres à chaque boutique', () => {
  for (const id of BOUTIQUES) {
    const m = manifeste(id);
    const rendu = schema.validate(m, id);
    assert.deepEqual(rendu.errors, [], `${id} : manifeste refusé`);

    assert.ok(m.permissions.length >= 4, `${id} : au moins quatre permissions`);
    for (const p of m.permissions) {
      assert.ok(p.description.length >= 80, `${id}/${p.key} : description trop courte`);
      assert.equal(
        schema.isGenericDescription(p.description, p.key),
        false,
        `${id}/${p.key} : description générique`
      );
    }
  }
});

test('le mot de passe est un champ secret, jamais renvoyé au client', () => {
  for (const id of BOUTIQUES) {
    const m = schema.normalize(manifeste(id));
    const champ = m.fields.find((f) => f.key === 'motDePasse');
    assert.equal(champ.type, 'password', `${id}`);
    assert.ok(schema.SECRET_FIELD_TYPES.includes(champ.type));

    // `publicView` ne renvoie que la description des champs, jamais de valeur.
    const publique = schema.publicView(m);
    assert.ok(!JSON.stringify(publique).includes('storageState'));
  }
});
