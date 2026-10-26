#!/usr/bin/env node
'use strict';

/**
 * La ligne de commande de crabe (0.2.6).
 *
 *   node bin/crabe.js recuperer <service> [--detail] [--compte <nom>] [--sortie <dossier>]
 *
 * Demande au service EN MARCHE une récupération du service donné, suit son
 * journal ligne par ligne, puis enregistre son rapport (le texte, ou
 * l'archive avec ses pièces). `--detail` : journal détaillé et capture de
 * chaque étape, même réussie. `--compte` : quand plusieurs comptes ont
 * installé le service.
 *
 * À lancer avec le compte qui fait tourner crabe : c'est lui qui peut lire le
 * jeton de `<données>/cli.json` (server/routes/local.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const AIDE = [
  'Usage : node bin/crabe.js recuperer <service> [--detail] [--compte <nom>] [--sortie <dossier>]',
  '',
  '  <service>          l\'identifiant du service (private-sport-shop, anthropic…)',
  '  --detail           journal détaillé et capture de chaque étape, même réussie',
  '  --compte <nom>     le compte qui a installé le service, s\'ils sont plusieurs',
  '  --sortie <dossier> où enregistrer le rapport (par défaut : <données>/rapports/<n°>/)',
].join('\n');

function lireArguments(argv) {
  const sortie = { commande: null, service: null, detail: false, compte: null, sortie: null, erreur: null };
  const reste = [...argv];
  while (reste.length) {
    const a = reste.shift();
    if (a === '--detail') sortie.detail = true;
    else if (a === '--compte' || a === '--sortie') {
      const v = reste.shift();
      if (!v || v.startsWith('--')) sortie.erreur = `${a} attend une valeur.`;
      else sortie[a.slice(2)] = v;
    } else if (a === '--aide' || a === '--help' || a === '-h') sortie.commande = 'aide';
    else if (a.startsWith('--')) sortie.erreur = `option inconnue : ${a}`;
    else if (!sortie.commande) sortie.commande = a;
    else if (!sortie.service) sortie.service = a;
    else sortie.erreur = `argument en trop : ${a}`;
  }
  return sortie;
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv, { dataDir = null, ecrire = console.log, erreur = console.error } = {}) {
  const args = lireArguments(argv);
  if (args.commande === 'aide') {
    ecrire(AIDE);
    return 0;
  }
  if (args.erreur || args.commande !== 'recuperer' || !args.service) {
    erreur(args.erreur ? `crabe : ${args.erreur}\n\n${AIDE}` : AIDE);
    return 2;
  }

  const donnees = dataDir || require('../server/config').config.dataDir;
  const fichier = path.join(donnees, 'cli.json');
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  } catch {
    erreur(`crabe : ${fichier} est illisible — crabe ne tourne pas, ou ce compte n'est pas celui de crabe `
      + '(lancez la commande avec lui : runuser -u crabe -- …).');
    return 1;
  }
  const appeler = (methode, chemin, corps) => fetch(`http://127.0.0.1:${conf.port}/api/local${chemin}`, {
    method: methode,
    headers: { 'content-type': 'application/json', 'x-crabe-jeton': conf.jeton },
    body: corps ? JSON.stringify(corps) : undefined,
  });

  let reponse;
  try {
    reponse = await appeler('POST', '/recuperer', { service: args.service, compte: args.compte, detail: args.detail });
  } catch (err) {
    erreur(`crabe : le service ne répond pas sur le port ${conf.port} (${err.cause?.code || err.message}).`);
    return 1;
  }
  const lancee = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    erreur(`crabe : ${lancee.error || `refus (HTTP ${reponse.status})`}`);
    if (lancee.comptes) erreur(`comptes : ${lancee.comptes.join(', ')}`);
    return 1;
  }
  const { runId } = lancee;
  ecrire(`Récupération n° ${runId} lancée : ${args.service}, compte ${lancee.compte}${args.detail ? ', détaillée' : ''}.`);

  let apres = 0;
  let run = null;
  for (;;) {
    const suivi = await (await appeler('GET', `/recuperations/${runId}?apres=${apres}`)).json();
    for (const l of suivi.lignes || []) {
      ecrire(`${String(l.at).slice(11)}  ${l.message}`);
      apres = l.id;
    }
    run = suivi.run;
    if (run?.finished_at) break;
    await attendre(1500);
  }
  ecrire(run.success ? `Succès — ${run.message}` : `Échec — ${run.message}`);

  const rapport = await appeler('GET', `/recuperations/${runId}/rapport`);
  const nom = /filename="([^"]+)"/.exec(rapport.headers.get('content-disposition') || '')?.[1] || `crabe-rapport-${runId}.txt`;
  const dossier = args.sortie || path.join(donnees, 'rapports', String(runId));
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const cible = path.join(dossier, path.basename(nom));
  fs.writeFileSync(cible, Buffer.from(await rapport.arrayBuffer()), { mode: 0o600 });
  ecrire(`Rapport : ${cible}`);
  ecrire(`(aussi dans Administration › Logs › Connecteurs, ligne n° ${runId}, bouton « Rapport »)`);
  return run.success ? 0 : 3;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`crabe : ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, lireArguments, AIDE };
