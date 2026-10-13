#!/usr/bin/env node
'use strict';

/**
 * Récupération des logos, en ligne de commande.
 *
 * ─── À quoi ça sert ─────────────────────────────────────────────────────────
 *
 * Exactement la même chose que Paramètres → Applications → Logos, et par le
 * MÊME code (`server/connectors/logos.js`) : même cascade, mêmes contrôles de
 * provenance, mêmes limites de taille, même refus d'écraser une image envoyée à
 * la main. Rien n'est réimplémenté ici — sans quoi les deux chemins finiraient
 * par diverger, et le compte rendu de l'un ne dirait plus rien de l'autre.
 *
 * Ce que ça ajoute : pouvoir lancer les quatre-vingt-cinq récupérations depuis
 * une session SSH, sans navigateur, et en repartir avec un compte rendu
 * copiable — « 61 récupérés, 24 manquants, et pourquoi ».
 *
 * **Ce n'est pas un automatisme.** Le fichier n'est appelé par rien : ni au
 * démarrage, ni par une planification. C'est la règle du lot 8, et elle tient —
 * une sortie vers quatre-vingts fournisseurs part toujours d'une décision.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node tools/fetch-logos.js                # les logos manquants seulement
 *   node tools/fetch-logos.js --tout         # tout reprendre, existants compris
 *   node tools/fetch-logos.js --pause 2000   # deux secondes entre deux requêtes
 *   node tools/fetch-logos.js --json         # le compte rendu en JSON
 *
 * À lancer sur la machine qui héberge crabe, sous le compte du service, avec
 * son environnement : c'est SA base et SON dossier de données qui reçoivent les
 * logos.
 *
 *   sudo -u crabe CRABE_DATA_DIR=/opt/crabe/data node tools/fetch-logos.js
 *
 * Le service peut tourner pendant ce temps : la base est en WAL, les écritures
 * de cet outil sont brèves et espacées d'une seconde, et les logos apparaissent
 * dans l'interface au rechargement de l'écran, sans redémarrage.
 */

const path = require('node:path');

/** Une seconde entre deux requêtes, comme dans l'écran d'administration. */
const PAUSE_PAR_DEFAUT = 1000;

function lireArguments(argv) {
  const options = { tout: false, pause: PAUSE_PAR_DEFAUT, json: false, seulement: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tout' || arg === '--all') options.tout = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--pause') options.pause = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--seulement') options.seulement = String(argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--aide' || arg === '-h' || arg === '--help') options.aide = true;
    else throw new Error(`Option inconnue : ${arg}`);
  }
  return options;
}

const AIDE = `Récupère les logos des services chez leurs fournisseurs.

  --tout             reprend aussi les logos déjà en place
  --seulement a,b,c  se limite à ces identifiants
  --pause <ms>       délai entre deux requêtes (défaut : ${PAUSE_PAR_DEFAUT})
  --json             compte rendu en JSON plutôt qu'en texte

Les images envoyées à la main ne sont jamais écrasées.`;

const patienter = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const options = lireArguments(process.argv.slice(2));
  if (options.aide) return void console.log(AIDE);

  // Chargé APRÈS la lecture des arguments : `server/config.js` lit
  // l'environnement au premier require, et une faute de frappe dans une option
  // ne doit pas d'abord ouvrir une base de données.
  const config = require('../server/config').config;
  const db = require('../server/db/db');
  const registry = require('../server/connectors/registry');
  const logos = require('../server/connectors/logos');

  // Volontairement SANS `crypto.init()` : un logo n'est pas un secret, et rien
  // sur ce chemin ne déchiffre quoi que ce soit. C'est aussi une sécurité — cet
  // outil se lance à la main, souvent en SSH, et n'a aucune raison de réclamer
  // la phrase de passe maîtresse pour aller chercher des images.
  db.open(config.dbFile);
  registry.load();

  if (config.scrapingDisabled) {
    console.error(
      'Les sorties vers les sites de fournisseurs sont désactivées sur cette installation '
        + '(CRABE_DISABLE_SCRAPING=1). Aucun logo ne peut être récupéré.'
    );
    process.exitCode = 2;
    return;
  }

  const sujets = logos.sujets().filter((s) => {
    if (options.seulement && !options.seulement.includes(s.id)) return false;
    // Sans site déclaré, la cascade n'a nulle part où aller : le stockage local, la
    // boutique PrestaShop générique. Ce n'est pas un échec, c'est un état.
    if (!s.site) return false;
    if (options.tout) return true;
    return !logos.lire(s.id);
  });

  if (!sujets.length) {
    console.log('Rien à récupérer : tous les logos joignables sont déjà en place.');
    return;
  }

  console.error(
    `${sujets.length} logo(s) à récupérer, ${options.pause} ms entre deux requêtes `
      + `(environ ${Math.round((sujets.length * (options.pause + 3000)) / 60000)} minutes).`
  );

  const resultats = [];
  for (const [index, sujet] of sujets.entries()) {
    const existant = logos.lire(sujet.id);
    if (existant?.source === 'manual') {
      // Le dernier mot revient à qui a regardé le résultat : une cascade n'y
      // revient pas, même sur un « tout reprendre ».
      resultats.push({ id: sujet.id, name: sujet.name, etat: 'manuel' });
      continue;
    }

    process.stderr.write(`[${index + 1}/${sujets.length}] ${sujet.name}… `);
    const resultat = await logos.recupererPour(sujet);

    if (resultat.ok) {
      logos.oublierEchec(sujet.id);
      resultats.push({
        id: sujet.id,
        name: sujet.name,
        site: sujet.site,
        etat: 'recupere',
        origine: resultat.origin,
        format: resultat.ext,
        largeur: resultat.width,
        hauteur: resultat.height,
      });
      console.error(`ok (${resultat.ext}, ${resultat.width || '?'}×${resultat.height || '?'})`);
    } else {
      // Gardée en base : c'est elle qui s'affiche au survol du liseré rouge,
      // sans forcer une nouvelle tentative pour relire la raison.
      logos.noterEchec(sujet.id, resultat.raison);
      resultats.push({
        id: sujet.id,
        name: sujet.name,
        site: sujet.site,
        etat: 'echec',
        raison: resultat.raison,
        details: resultat.details || [],
      });
      console.error(`échec — ${resultat.raison}`);
    }

    if (index < sujets.length - 1 && options.pause) await patienter(options.pause);
  }

  rendreCompte(resultats, options);
  db.close();
}

/** Le compte rendu : ce qui est arrivé, et pour chaque manque, sa raison. */
function rendreCompte(resultats, options) {
  const recuperes = resultats.filter((r) => r.etat === 'recupere');
  const echecs = resultats.filter((r) => r.etat === 'echec');
  const manuels = resultats.filter((r) => r.etat === 'manuel');

  if (options.json) {
    console.log(JSON.stringify({ recuperes, echecs, manuels }, null, 2));
    return;
  }

  console.log('');
  console.log(
    `${recuperes.length} logo(s) récupéré(s), ${echecs.length} en échec`
      + (manuels.length ? `, ${manuels.length} conservé(s) (envoyé(s) à la main)` : '')
      + '.'
  );

  if (!echecs.length) return;
  console.log('');
  console.log('Manquants, et pourquoi :');
  for (const echec of echecs) {
    console.log(`  - ${echec.name} (${echec.site}) — ${echec.raison}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  console.error('');
  console.error(AIDE);
  process.exitCode = 1;
});
