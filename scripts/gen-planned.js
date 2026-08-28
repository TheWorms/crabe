#!/usr/bin/env node
'use strict';

/**
 * Génère les manifestes des services ANNONCÉS (lot 11).
 *
 * Un service annoncé n'a pas de `connector.js` : seulement un manifeste qui le
 * décrit, rangé sous `server/connectors/planned/<id>/`. Il apparaît dans le
 * Store avec son logo et sa catégorie, mais ne s'installe pas — le registre le
 * refuse (voir server/connectors/registry.js).
 *
 * ─── Pourquoi un générateur plutôt que soixante-dix fichiers à la main ───────
 *
 * Parce que la table ci-dessous se relit d'un coup d'œil : une ligne par
 * service, et on voit immédiatement si un nom manque, si une catégorie est mal
 * choisie, si deux descriptions se ressemblent trop. Soixante-dix fichiers JSON
 * éparpillés ne se relisent pas.
 *
 * Les fichiers produits sont du **vrai code source**, committés, et destinés à
 * être édités à la main dès qu'un service devient réel. Relancer ce script les
 * écrase : c'est fait pour le premier jet, pas pour la maintenance.
 *
 * ─── Rendre un service disponible ────────────────────────────────────────────
 *
 * Déplacer son dossier de `planned/` vers `available/` et y écrire son
 * `connector.js`. Rien d'autre : ni ce script, ni le champ `status` du
 * manifeste, ni aucune liste ailleurs n'a besoin d'être touché. C'est le
 * DOSSIER qui décide.
 *
 * Usage : node scripts/gen-planned.js
 */

const fs = require('node:fs');
const path = require('node:path');

const PLANNED = path.join(__dirname, '..', 'server', 'connectors', 'planned');

/**
 * La réserve des banques traditionnelles, mot pour mot et une seule fois.
 *
 * Leur faisabilité n'est PAS acquise : la validation passe le plus souvent par
 * l'application mobile de la banque, les sessions durent quelques minutes, et
 * l'accès automatisé est généralement contraire aux conditions d'utilisation.
 * Annoncer ces quatre services sans le dire serait une promesse en l'air.
 */
const RESERVE_BANQUE =
  'La connexion à votre banque demande une validation depuis son application mobile. '
  + 'Ce service est à l\'étude, sa disponibilité n\'est pas garantie.';

/**
 * L'empêchement des banques, mesuré au lot 30 : la validation DSP2 depuis le
 * téléphone est un geste que seul le titulaire peut faire, à chaque session.
 * Depuis le lot 36, l'annonce ne promet plus « bientôt » — elle dit pourquoi
 * ce n'est pas possible aujourd'hui.
 */
const EMPECHEMENT_BANQUE =
  'La connexion à votre banque exige une validation depuis son application mobile, un geste '
  + 'que seul son titulaire peut faire : crabe ne peut pas se connecter à votre place.';

/**
 * Le catalogue annoncé.
 *
 * `description` suit la règle du lot 8 : UNE phrase, 160 caractères au plus,
 * qui dit ce que le service fait POUR l'utilisateur. Ce qui est technique va
 * dans `technicalNote` (jamais servie à l'utilisateur) ; une réserve qui le
 * concerne, lui, va dans `caveat`.
 *
 * Ni `color` ni `letters` : la pastille de repli les déduit de l'identifiant et
 * du nom, et la plupart de ces services portent de toute façon un vrai logo
 * récupéré sur leur propre site.
 */
const SERVICES = [
  // --- Énergie -------------------------------------------------------------
  {
    id: 'totalenergies',
    name: 'TotalEnergies',
    category: 'energie',
    site: 'www.totalenergies.fr',
    description: 'Récupère automatiquement vos factures d\'électricité et de gaz TotalEnergies.',
  },
  {
    id: 'planete-oui',
    name: 'Planète OUI',
    category: 'energie',
    site: 'www.planete-oui.fr',
    description: 'Récupère automatiquement vos factures d\'électricité Planète OUI.',
  },
  {
    id: 'saur',
    name: 'SAUR',
    category: 'energie',
    site: 'www.saurclient.fr',
    description: 'Récupère automatiquement vos factures d\'eau SAUR.',
  },
  {
    id: 'sepig',
    name: 'SEPIG',
    category: 'energie',
    site: 'www.sepig.fr',
    description: 'Récupère automatiquement vos factures d\'eau SEPIG.',
  },

  // --- Mobile & Internet ---------------------------------------------------
  {
    id: 'flexiroam',
    name: 'Flexiroam',
    category: 'telecom',
    site: 'www.flexiroam.com',
    description: 'Récupère automatiquement vos factures de forfaits data à l\'étranger.',
    // Impraticable, mesuré au lot 36 (docs/reconnaissance-lot36.md).
    unfeasible: 'Flexiroam ne montre ses factures que dans son application mobile et les envoie par e-mail : il n\'existe pas de page web où crabe pourrait les récupérer.',
  },
  {
    id: 'samsung-plus',
    name: 'Samsung+',
    category: 'telecom',
    site: 'www.samsung.com',
    description: 'Récupère automatiquement vos factures de services et de garanties Samsung.',
    // Impraticable, mesuré au lot 36 (docs/reconnaissance-lot36.md).
    unfeasible: 'Il n\'existe pas aujourd\'hui de page web où consulter des factures « Samsung+ » en France : crabe n\'a nulle part où aller les chercher.',
  },

  // --- Cloud & hébergement -------------------------------------------------
  {
    id: 'soyoustart',
    name: 'SoYouStart',
    category: 'hebergement',
    site: 'www.soyoustart.com',
    description: 'Récupère automatiquement vos factures de serveur SoYouStart.',
  },
  {
    id: 'bunny-net',
    name: 'Bunny.net',
    category: 'hebergement',
    site: 'bunny.net',
    description: 'Récupère automatiquement vos factures d\'hébergement et de diffusion Bunny.net.',
  },

  // --- Services publics ----------------------------------------------------
  {
    id: 'france-travail',
    name: 'France Travail',
    category: 'public',
    site: 'www.francetravail.fr',
    description: 'Récupère automatiquement vos attestations et vos courriers France Travail.',
  },

  // --- Shopping — grandes enseignes ----------------------------------------
  //
  // Darty, Boulanger, Electro Dépôt, Decathlon, Bricomarché, LDLC et
  // VistaPrint sont des connecteurs réels (ébauches en attente) depuis le
  // lot 47 : leurs dossiers vivent sous available/. Leurs entrées sont
  // retirées d'ici — la régénération recréerait l'annonce par-dessus le
  // connecteur et ferait refuser le chargement (« annoncé alors qu'il existe
  // déjà »), le piège relevé pour Materiel.net au lot 36.
  {
    id: 'ikea',
    name: 'IKEA',
    category: 'shopping',
    site: 'www.ikea.com',
    description: 'Récupère automatiquement les factures de vos achats IKEA.',
  },
  // Materiel.net est un connecteur réel depuis le lot 30 : son dossier vit
  // sous available/. Cette entrée avait survécu par oubli — la régénération
  // aurait recréé l'annonce par-dessus le connecteur et fait refuser le
  // chargement (« annoncé alors qu'il existe déjà »). Retirée au lot 36.
  {
    id: 'autodoc',
    name: 'AutoDoc',
    category: 'shopping',
    site: 'www.autodoc.fr',
    description: 'Récupère automatiquement les factures de vos achats de pièces auto AutoDoc.',
  },
  {
    id: 'private-sport-shop',
    name: 'Private Sport Shop',
    category: 'shopping',
    site: 'www.privatesportshop.fr',
    description: 'Récupère automatiquement les factures de vos achats Private Sport Shop.',
  },
  {
    id: 'kubii',
    name: 'Kubii',
    category: 'shopping',
    site: 'www.kubii.com',
    description: 'Récupère automatiquement les factures de vos achats Kubii.',
  },
  // VistaPrint est parti dans available/ avec les six enseignes du lot 47
  // (voir le commentaire en tête de la section shopping).

  // --- Shopping — boutiques sous PrestaShop --------------------------------
  //
  // Dix tuiles, UNE implémentation. Chacune garde son nom, son logo et son
  // site — c'est ce qu'un utilisateur cherche —, mais toutes attendent le même
  // connecteur générique. Le jour où il est écrit, les dix deviennent
  // fonctionnelles d'un coup, sans une ligne de plus.
  ...[
    { id: 'propolia', name: 'Propolia', site: 'www.propolia.com', quoi: 'de vos achats de produits de la ruche' },
    { id: 'coco-papaya', name: 'Coco Papaya', site: 'www.cocopapaya.com', quoi: 'de vos achats Coco Papaya' },
    { id: 'atelier-du-portable', name: 'L\'Atelier du Portable', site: 'www.atelierduportable.com', quoi: 'de vos achats et réparations L\'Atelier du Portable' },
    { id: 'ile-aux-epices', name: 'L\'Île aux Épices', site: 'www.ileauxepices.com', quoi: 'de vos achats d\'épices L\'Île aux Épices' },
    { id: 'le-petit-vapoteur', name: 'Le Petit Vapoteur', site: 'www.lepetitvapoteur.com', quoi: 'de vos achats Le Petit Vapoteur' },
    { id: 'apiculture-net', name: 'Apiculture.net', site: 'www.apiculture.net', quoi: 'de vos achats de matériel apicole' },
    { id: 'semailles', name: 'Semailles', site: 'www.semailles.com', quoi: 'de vos achats de semences Semailles' },
    { id: 'fantazia', name: 'Fantazia', site: 'www.fantazia-shop.com', quoi: 'de vos achats Fantazia' },
    { id: 'aagard', name: 'Aagard', site: '', quoi: 'de vos achats Aagard' },
    // Deux adresses n'ont pas pu être confirmées — `www.aagard.fr` et
    // `www.lepetithydroculte.fr` n'existent pas, et rien de proche ne se laisse
    // identifier avec certitude. Elles restent VIDES plutôt que devinées : un
    // site faux s'afficherait sur la tuile et serait interrogé pour un logo.
    // Sans site, la tuile garde sa pastille à initiales et le gestionnaire de
    // logos grise son bouton avec sa raison, comme pour le stockage local.
  ].map((b) => ({
    id: b.id,
    name: b.name,
    category: 'shopping',
    site: b.site,
    implementation: 'prestashop',
    description: `Récupère automatiquement les factures ${b.quoi}.`,
    technicalNote:
      'Boutique sous PrestaShop : aucun code propre à écrire. Elle deviendra fonctionnelle en '
      + 'même temps que les neuf autres, le jour où le connecteur générique PrestaShop existe.',
  })),
  {
    id: 'boutique-prestashop',
    name: 'Boutique PrestaShop',
    category: 'shopping',
    // Aucun site : c'est l'utilisateur qui donnera l'adresse de SA boutique.
    // Le gestionnaire de logos grise alors son bouton « Récupérer », avec sa
    // raison, comme pour toute entrée sans site.
    description: 'Récupère automatiquement les factures d\'une boutique en ligne sous PrestaShop.',
    implementation: 'prestashop',
    caveat:
      'Cette entrée vaut pour toute boutique non listée : vous indiquerez l\'adresse du site au '
      + 'moment de la connexion.',
    technicalNote:
      'Entrée générique du connecteur PrestaShop, pour les boutiques qui n\'ont pas leur propre '
      + 'tuile. L\'adresse de la boutique sera un champ du formulaire.',
  },

  // --- IA & outils créatifs ------------------------------------------------
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'ia',
    site: 'www.anthropic.com',
    description: 'Récupère automatiquement vos factures d\'abonnement et d\'usage Anthropic.',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    category: 'ia',
    site: 'mistral.ai',
    description: 'Récupère automatiquement vos factures d\'abonnement et d\'usage Mistral.',
  },
  {
    id: 'recraft',
    name: 'Recraft',
    category: 'ia',
    site: 'www.recraft.ai',
    description: 'Récupère automatiquement vos factures d\'abonnement Recraft.',
  },
  // ⚠ Envato Market n'est PAS listé ici, et ce n'est pas un oubli. Il est bien
  // redevenu un service annoncé au lot 23, mais son manifeste est écrit à la
  // main : il porte une note technique qui résume tout ce qui a été mesuré sur
  // les deux pistes essayées (account.envato.com, themeforest.net) et qui
  // évitera au prochain lot de reprendre à zéro. Une ligne ici écraserait cette
  // note à la première exécution du générateur, sans que rien ne le signale.
  // Un service qui a déjà eu un connecteur ne repasse pas par ce premier jet.

  // Invoice Ninja a été retiré du catalogue au lot 22, et il n'a pas sa place
  // ici non plus : ce générateur recréerait une annonce pour un service
  // volontairement abandonné. La raison de l'abandon n'est pas un défaut de
  // crabe — le portail client d'Invoice Ninja a son PROPRE mot de passe,
  // distinct de celui du tableau de bord, qu'il faut se créer exprès pour un
  // seul abonnement. Le jeu n'en vaut pas la chandelle.

  // --- Divertissement ------------------------------------------------------
  {
    id: 'google-play',
    name: 'Google Play',
    category: 'divertissement',
    site: 'play.google.com',
    description: 'Récupère automatiquement les reçus de vos achats et abonnements Google Play.',
    // Impraticable, mesuré au lot 36 (docs/reconnaissance-lot36.md).
    unfeasible: 'La connexion à Google Play passe obligatoirement par le compte Google, et Google refuse cette connexion à un programme. Tant que ce refus reste en place, crabe ne peut pas récupérer ces reçus.',
  },
  // Spotify est devenu un connecteur réel au lot 36 : son dossier vit désormais
  // sous available/ avec son connector.js. On le retire de cette table pour
  // qu'une régénération ne recrée pas l'annonce par-dessus.
  // Deezer est devenu un connecteur réel au lot 36 : son dossier vit désormais
  // sous available/ avec son connector.js. On le retire de cette table pour
  // qu'une régénération ne recrée pas l'annonce par-dessus (même geste
  // qu'Airbnb au lot 35).
  // Qobuz est devenu un connecteur réel au lot 36 : son dossier vit désormais
  // sous available/ avec son connector.js. On le retire de cette table pour
  // qu'une régénération ne recrée pas l'annonce par-dessus.
  // SoundCloud est devenu un connecteur réel au lot 36 : son dossier vit
  // désormais sous available/ avec son connector.js. On le retire de cette
  // table pour qu'une régénération ne recrée pas l'annonce par-dessus.
  {
    id: 'battle-net',
    name: 'Battle.net',
    category: 'divertissement',
    site: 'www.battle.net',
    description: 'Récupère automatiquement les reçus de vos achats Battle.net.',
  },
  {
    id: 'fdj',
    name: 'FDJ',
    category: 'divertissement',
    site: 'www.fdj.fr',
    description: 'Récupère automatiquement vos relevés de compte joueur FDJ.',
    // Impraticable, mesuré au lot 36 (docs/reconnaissance-lot36.md).
    unfeasible: 'Le site de la FDJ bloque les programmes avant même sa page d\'accueil. Tant que cette protection reste en place, crabe ne peut pas y récupérer vos relevés.',
  },

  // --- Voyage & mobilité ---------------------------------------------------
  // SNCF Connect n'est plus annoncé ICI : son connecteur réel vit dans
  // available/sncf-connect/ depuis le lot 31.
  // OUIGO n'est plus annoncé ICI : son connecteur réel vit dans
  // available/ouigo/ depuis le lot 31.
  {
    id: 'volotea',
    name: 'Volotea',
    category: 'voyage',
    site: 'www.volotea.com',
    description: 'Récupère automatiquement les justificatifs de vos vols Volotea.',
  },
  // Airbnb est devenu un connecteur réel au lot 35 : son dossier vit désormais
  // sous available/ avec son connector.js. On le retire de cette table pour
  // qu'une régénération ne recrée pas l'annonce par-dessus (le geste jumeau de
  // Materiel.net au lot 30).
  {
    id: 'uber',
    name: 'Uber',
    category: 'voyage',
    site: 'www.uber.com',
    description: 'Récupère automatiquement les reçus de vos courses et commandes Uber.',
  },
  {
    id: 'coyote',
    name: 'Coyote',
    category: 'voyage',
    site: 'www.moncoyote.com',
    description: 'Récupère automatiquement vos factures d\'abonnement Coyote.',
  },

  // --- Santé & assurance ---------------------------------------------------
  {
    id: 'olivier-assurance',
    name: 'L\'Olivier',
    category: 'sante',
    site: 'www.lolivier.fr',
    description: 'Récupère automatiquement vos avis d\'échéance et attestations d\'assurance auto.',
  },
  {
    id: 'betterme',
    name: 'BetterMe',
    category: 'sante',
    site: 'betterme.world',
    description: 'Récupère automatiquement vos factures d\'abonnement BetterMe.',
  },

  // --- Banque & paiement ---------------------------------------------------
  //
  // Les quatre banques traditionnelles portent une réserve explicite : leur
  // faisabilité n'est pas acquise, et il vaut mieux le dire tout de suite que
  // de laisser quelqu'un attendre un connecteur qui n'arrivera peut-être pas.
  {
    id: 'credit-agricole',
    name: 'Crédit Agricole',
    category: 'banque',
    site: 'www.credit-agricole.fr',
    description: 'Récupère automatiquement vos relevés de compte Crédit Agricole.',
    caveat: RESERVE_BANQUE,
    unfeasible: EMPECHEMENT_BANQUE,
  },
  {
    id: 'caisse-epargne',
    name: 'Caisse d\'Épargne',
    category: 'banque',
    site: 'www.caisse-epargne.fr',
    description: 'Récupère automatiquement vos relevés de compte Caisse d\'Épargne.',
    caveat: RESERVE_BANQUE,
    unfeasible: EMPECHEMENT_BANQUE,
  },
  {
    id: 'credit-mutuel',
    name: 'Crédit Mutuel',
    category: 'banque',
    site: 'www.creditmutuel.fr',
    description: 'Récupère automatiquement vos relevés de compte Crédit Mutuel.',
    caveat: RESERVE_BANQUE,
    unfeasible: EMPECHEMENT_BANQUE,
  },
  {
    id: 'hello-bank',
    name: 'Hello Bank',
    category: 'banque',
    site: 'www.hellobank.fr',
    description: 'Récupère automatiquement vos relevés de compte Hello Bank.',
    caveat: RESERVE_BANQUE,
    unfeasible: EMPECHEMENT_BANQUE,
  },
  {
    id: 'paypal',
    name: 'PayPal',
    category: 'banque',
    site: 'www.paypal.com',
    description: 'Récupère automatiquement vos relevés d\'activité et reçus PayPal.',
  },
  {
    id: 'oney',
    name: 'Oney',
    category: 'banque',
    site: 'www.oney.fr',
    description: 'Récupère automatiquement vos échéanciers et relevés de paiement Oney.',
  },
  {
    id: 'klarna',
    name: 'Klarna',
    category: 'banque',
    site: 'www.klarna.com',
    description: 'Récupère automatiquement vos échéanciers et reçus de paiement Klarna.',
  },
  {
    id: 'scalapay',
    name: 'Scalapay',
    category: 'banque',
    site: 'www.scalapay.com',
    description: 'Récupère automatiquement vos échéanciers et reçus de paiement Scalapay.',
  },
  {
    id: 'alma',
    name: 'Alma',
    category: 'banque',
    site: 'getalma.eu',
    description: 'Récupère automatiquement vos échéanciers et reçus de paiement Alma.',
  },

  // --- Crypto-monnaies -----------------------------------------------------
  {
    id: 'kraken',
    name: 'Kraken',
    category: 'crypto',
    site: 'www.kraken.com',
    description: 'Récupère automatiquement vos relevés et justificatifs d\'opérations Kraken.',
  },
  {
    id: 'coinbase',
    name: 'Coinbase',
    category: 'crypto',
    site: 'www.coinbase.com',
    description: 'Récupère automatiquement vos relevés et justificatifs d\'opérations Coinbase.',
  },
  {
    id: 'bitstamp',
    name: 'Bitstamp',
    category: 'crypto',
    site: 'www.bitstamp.net',
    description: 'Récupère automatiquement vos relevés et justificatifs d\'opérations Bitstamp.',
  },

  // --- Administratif & éducation -------------------------------------------
  // eDocPerso n'est plus annoncé ICI : son connecteur réel vit dans
  // available/edocperso/ depuis le lot 31 — le régénérer en annonce ferait
  // refuser le chargement (« annoncé alors qu'il existe déjà »).
  {
    id: 'pronote',
    name: 'Pronote',
    category: 'administratif',
    site: 'www.index-education.com',
    description: 'Récupère automatiquement les documents de l\'espace Pronote de votre établissement.',
    caveat:
      'Chaque établissement a sa propre adresse Pronote : vous l\'indiquerez au moment de la '
      + 'connexion.',
  },

];

// ⚠ Services RETIRÉS du catalogue sur décision (11-12/08/2026) : sofidial,
// homebox, ulule, prestashop (l'abonnement à la plateforme), le-petit-hydroculte,
// emoa. Ne pas les remettre dans la table ci-dessus : ce script est fait pour
// le premier jet, et les y remettre les ressusciterait dans le Store au
// prochain passage. La suppression complète d'un service, c'est : son dossier
// planned/, sa ligne ici, et le nettoyage des lignes orphelines que
// syncCatalog() fait désormais tout seul au démarrage (lot 31).

/** Le manifeste écrit sur le disque, clés dans un ordre stable et lisible. */
function manifestFor(service) {
  const manifest = {
    id: service.id,
    name: service.name,
    category: service.category,
  };
  if (service.site) manifest.site = service.site;
  if (service.implementation) manifest.implementation = service.implementation;
  manifest.description = service.description;
  if (service.caveat) manifest.caveat = service.caveat;
  // L'empêchement mesuré (lot 36) : la tuile montre « Pas possible
  // aujourd'hui » et cette raison, à la place de « Bientôt disponible ».
  if (service.unfeasible) manifest.unfeasible = service.unfeasible;
  if (service.technicalNote) manifest.technicalNote = service.technicalNote;
  // Redit ce que le dossier dit déjà. Utile à qui ouvre le fichier seul ;
  // ignoré au chargement, pour qu'un déplacement de dossier suffise à rendre
  // le service disponible (voir connectors/manifest-schema.js, STATUSES).
  manifest.status = 'planned';
  return manifest;
}

function main() {
  const schema = require('../server/connectors/manifest-schema');
  const vus = new Set();
  let ecrits = 0;

  for (const service of SERVICES) {
    if (vus.has(service.id)) throw new Error(`Identifiant en double : ${service.id}`);
    vus.add(service.id);

    const manifest = manifestFor(service);
    // Validé ici plutôt qu'au démarrage du serveur : une description trop
    // longue ou une catégorie inconnue doit se voir en écrivant la table, pas
    // dans les journaux d'un service en production.
    const { ok, errors } = schema.validate(manifest, service.id, { planned: true });
    if (!ok) throw new Error(errors.join('\n'));

    const dir = path.join(PLANNED, service.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    ecrits++;
  }

  console.log(`${ecrits} service(s) annoncé(s) écrit(s) dans ${PLANNED}`);
}

main();
