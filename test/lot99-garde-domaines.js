'use strict';

/**
 * Lot 99, D8 — la sentinelle de TOUTE la suite d'essais : aucune requête ne
 * part vers un vrai domaine des trois boutiques.
 *
 * Chargée par `NODE_OPTIONS="--require <ce fichier>"` avec
 * `CRABE_GARDE_DOMAINES=<fichier de relevé>`, elle tourne dans chaque
 * processus de `npm test` (un par fichier d'essai) et s'accroche à chaque
 * Chromium lancé par Playwright — navigateur, contexte, contexte persistant.
 * Elle note, dans le relevé :
 *
 *   - `lancement <pid>` / `persistant <pid>` : un navigateur est parti ;
 *   - `vue <pid> <hôte>` : une requête vers l'un des trois domaines a été
 *     émise (servie par un banc, ou non) ;
 *   - `FUITE <pid> <hôte> <adresse>` : une réponse de l'un des trois domaines
 *     est VENUE DU RÉSEAU — elle porte une adresse de serveur, ce qu'une
 *     réponse servie par un banc (`route.fulfill`) n'a jamais (lot 92).
 *
 * Le relevé d'une suite saine : des `vue`, AUCUNE `FUITE`. Sans la variable,
 * ce fichier ne fait rien ; il n'est jamais chargé par l'application.
 */

const fs = require('node:fs');

const RELEVE = process.env.CRABE_GARDE_DOMAINES;
// Le motif se remplace pour l'ÉTALONNAGE seulement (un serveur local joue la
// fuite, sans toucher aucun vrai site) : la suite tourne avec les trois domaines
// — et, depuis le lot 102, ceux de l'Eau d'Île-de-France et de Salesforce, où
// son espace client et ses documents sont servis ; depuis le lot 104, ceux de
// Battle.net, d'Alma et de Private Sport Shop (et de leurs fournisseurs).
const DOMAINES = process.env.CRABE_GARDE_DOMAINES_MOTIF
  ? new RegExp(process.env.CRABE_GARDE_DOMAINES_MOTIF, 'i')
  : /(^|\.)(alfaliquid\.com|lepetitvapoteur\.com|e-liquide-fr\.com|leaudiledefrance\.fr|salesforce\.com|force\.com|site\.com|visualforce\.com|battle\.net|blizzard\.com|akamaized\.net|getalma\.eu|almapay\.com|privatesportshop\.fr|sportpursuit\.com|sportscape\.group)$/i;

function noter(ligne) {
  try {
    fs.appendFileSync(RELEVE, `${ligne}\n`);
  } catch {
    /* un relevé illisible ne doit pas casser la suite qu'il observe */
  }
}

function hoteDe(adresse) {
  try {
    return new URL(adresse).hostname;
  } catch {
    return '';
  }
}

function surveiller(contexte) {
  contexte.on('request', (requete) => {
    const hote = hoteDe(requete.url());
    if (DOMAINES.test(hote)) noter(`vue ${process.pid} ${hote}`);
  });
  contexte.on('response', async (reponse) => {
    const hote = hoteDe(reponse.url());
    if (!DOMAINES.test(hote)) return;
    const serveur = await reponse.serverAddr().catch(() => null);
    if (serveur) noter(`FUITE ${process.pid} ${hote} ${serveur.ipAddress}:${serveur.port}`);
  });
}

if (RELEVE) {
  let playwright = null;
  try {
    playwright = require('playwright');
  } catch {
    playwright = null;
  }
  if (playwright) {
    const { chromium } = playwright;
    const lancer = chromium.launch.bind(chromium);
    chromium.launch = async (...args) => {
      const navigateur = await lancer(...args);
      noter(`lancement ${process.pid}`);
      const creerContexte = navigateur.newContext.bind(navigateur);
      navigateur.newContext = async (...options) => {
        const contexte = await creerContexte(...options);
        surveiller(contexte);
        return contexte;
      };
      const creerPage = navigateur.newPage.bind(navigateur);
      navigateur.newPage = async (...options) => {
        const page = await creerPage(...options);
        surveiller(page.context());
        return page;
      };
      return navigateur;
    };
    const persistant = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async (...args) => {
      const contexte = await persistant(...args);
      noter(`persistant ${process.pid}`);
      surveiller(contexte);
      return contexte;
    };
  }
}
