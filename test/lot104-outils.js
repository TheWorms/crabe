'use strict';

/**
 * Lot 104 — ce que les essais des trois connecteurs partagent : un passage
 * DIRECT sur le faux site, un passage par le VRAI planificateur, ce qui doit
 * tenir à chaque passage, ce qu'aucun journal ne doit porter.
 *
 * ⚠ Aucune donnée réelle : les valeurs du banc (test/lot104-faux-sites.js).
 */

const assert = require('node:assert/strict');

const faux = require('./lot104-faux-sites');
const outils99 = require('./lot99-outils');

const SITES = { 'battle-net': faux.siteBnet, alma: faux.siteAlma, 'private-sport-shop': faux.sitePss };

/** Ce qu'aucun journal ne doit porter : numéros, identifiants, montants, joueur, courriel. */
const DONNEES = [
  /ZZ9\d+/,
  /99\d{6,}/,
  /9000000\d/,
  /ZZessai/,
  /ZZREF/,
  new RegExp(faux.JOUEUR.replace(/[#]/g, '\\$&')),
  /JoueurEssai/,
  /essai@exemple/,
  /0,00 €/,
  /Client d'essai/,
  /Commerçant d'essai/,
  /Article d'essai/,
];

/**
 * Pose `valeurs` sur `connecteur.ouverture` le temps de `corps`, puis remet
 * tout : le lanceur du banc, l'horloge, les délais.
 */
async function avecOuverture(connecteur, valeurs, corps) {
  const avant = { ...connecteur.ouverture };
  Object.assign(connecteur.ouverture, valeurs);
  try {
    return await corps();
  } finally {
    Object.assign(connecteur.ouverture, avant);
  }
}

/** Un passage DIRECT de `connecteur` (`id`) sur son faux site. */
async function passer(id, connecteur, etat, { ctxExtra = {}, ouverture = {}, appel = 'fetchInvoices', session = null } = {}) {
  const banc = faux.lanceurFaux(SITES[id](etat), faux.HOTES[id]);
  const lignes = [];
  const preuves = [];
  try {
    return await avecOuverture(connecteur, { lancer: banc.lancer, ...ouverture }, async () => {
      let resultat = null;
      let erreur = null;
      try {
        resultat = await connecteur[appel](
          // Lot 105 : une session donnée par l'essai (Alma : avec son stockage de session).
          { session: session || faux.sessionInventee(faux.DOMAINE_SESSION[id]), historique: 'depuis' },
          { userId: 1, log: (m) => lignes.push(String(m)), preuveDeListe: (p) => preuves.push(p), knownRemoteIds: [], ...ctxExtra }
        );
      } catch (err) {
        erreur = err;
      }
      assert.ok(banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
      return { resultat, erreur, journal: banc.journal, lignes, preuves, ouverts: banc.ouverts() };
    });
  } finally {
    await banc.fermer();
  }
}

/** Ce qui doit tenir à CHAQUE passage, quel que soit le connecteur. */
function rienDInterdit(journal, etat) {
  assert.deepEqual(journal.saisies, [], `aucune saisie, aucun envoi de formulaire : ${JSON.stringify(journal.saisies)}`);
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.deepEqual(journal.ecritures, [], 'aucune requête d\'écriture');
  assert.deepEqual(etat.compteurs.pieges, [], `aucun piège touché : ${JSON.stringify(etat.compteurs.pieges)}`);
  assert.deepEqual(etat.compteurs.interdits, [], `aucune adresse hors du parcours : ${JSON.stringify(etat.compteurs.interdits)}`);
  for (const g of journal.gestes) assert.equal(g.piege, '', `un geste sur un piège : ${JSON.stringify(g)}`);
  for (const v of journal.visites) {
    assert.doesNotMatch(v, /checkout|ProductReturn|billing_agreement|logout|payment-methods|\/payment$|reschedule|cart|panier|return/i,
      `visite hors du parcours : ${v}`);
  }
}

function journalSansDonnee(lignes) {
  outils99.journalSansDonnee(lignes, DONNEES);
  assert.doesNotMatch(lignes.join('\n'), /\d{4,}/, 'aucune suite de quatre chiffres au journal');
}

/** Un passage par `scheduler.runForUser` sur le faux site, l'instance du registre branchée. */
async function parLePlanificateur({ registry, scheduler, id, etat, user, ouverture = {} }) {
  const banc = faux.lanceurFaux(SITES[id](etat), faux.HOTES[id]);
  const instance = outils99.instanceDuRegistre(registry, id);
  try {
    return await avecOuverture(instance, { lancer: banc.lancer, ...ouverture }, async () => {
      const r = await scheduler.runForUser(user.id, id, 'manual');
      assert.ok(banc.lancements() >= 1, `le planificateur a ouvert le FAUX navigateur, aucun autre (${r.message})`);
      rienDInterdit(banc.journal, etat);
      return { r, journal: banc.journal };
    });
  } finally {
    await banc.fermer();
  }
}

/** Installe le vrai connecteur pour un compte neuf, connexion enregistrée par la fenêtre. */
async function compteAvec(helpers, registry, id, nom) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, id);
  registry.saveConfig(user.id, id, { session: faux.sessionInventee(faux.DOMAINE_SESSION[id]) }, { origine: 'fenetre' });
  return user;
}

/** Une horloge qui saute de deux heures quand `saut()` est appelé. */
function horlogeASaut() {
  let decalage = 0;
  return { maintenant: () => Date.now() + decalage, saut: () => { decalage += 2 * 60 * 60 * 1000; } };
}

/** Le code d'un fichier sans ses commentaires, et le corps d'une de ses fonctions. */
function corpsDe(code, debutTexte) {
  const debut = code.indexOf(debutTexte);
  const fin = code.indexOf('\n}\n', debut);
  assert.ok(debut >= 0 && fin > debut, `la fonction « ${debutTexte} » existe`);
  return { debut, fin, corps: code.slice(debut, fin) };
}

/** Les gestes qu'aucun des trois fichiers ne porte (hors du geste permis, compté à part). */
const AUTRES_GESTES = [/\.dblclick\s*\(/, /\.fill\s*\(/, /\.type\s*\(/, /\.press\s*\(/, /\.check\s*\(/, /\.uncheck\s*\(/,
  /\.setInputFiles\s*\(/, /\.dispatchEvent\s*\(/, /\.requestSubmit\s*\(/, /\.submit\b/, /\.tap\s*\(/, /\.hover\s*\(/,
  /\.focus\s*\(/, /keyboard\./, /mouse\./, /touchscreen\./, /\.accept\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/,
  /\.click\s*\(\s*\)/, /scrollIntoView/, /\.value\s*=/, /setAttribute/];

module.exports = {
  DONNEES,
  passer,
  rienDInterdit,
  journalSansDonnee,
  parLePlanificateur,
  compteAvec,
  horlogeASaut,
  corpsDe,
  AUTRES_GESTES,
  codeSansCommentaires: outils99.codeSansCommentaires,
  documents: outils99.documents,
  interdireLeVraiNavigateur: outils99.interdireLeVraiNavigateur,
  journalApplicatifSansDonnee: (db) => outils99.journalApplicatifSansDonnee(db, DONNEES),
};
