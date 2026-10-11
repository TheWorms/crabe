'use strict';

/**
 * Lot 99 — ce que les trois fichiers d'essai partagent : un passage DIRECT du
 * connecteur sur son faux site, un passage par le VRAI planificateur, et ce
 * qui doit tenir à chaque passage (aucun clic, aucune saisie, rien de sorti).
 *
 * ⚠ Le registre vide `require.cache` avant de charger un connecteur (leçon du
 * lot 93) : l'instance que le planificateur exécute n'est PAS celle qu'un
 * essai obtient par `require`. Le faux lanceur se pose donc sur
 * `registry.get(id).module` pour les passages planifiés, et le lancement RÉEL y
 * est interdit par défaut (`interdireLeVraiNavigateur`) : un passage qui n'a
 * pas branché le faux site lève au lieu de partir vers la vraie boutique.
 */

const assert = require('node:assert/strict');

const faux = require('./lot99-faux-sites');

/**
 * Un passage DIRECT (hors planificateur) de `connecteur` sur le faux site.
 * Rend le résultat ou l'erreur, le journal du banc, les lignes du journal du
 * connecteur et les preuves de liste.
 */
async function passer(connecteur, { hote, site, etat, config = {}, ctxExtra = {}, horloge = null }) {
  const banc = faux.lanceurFaux([hote], site(etat));
  const lancer = connecteur.ouverture.lancer;
  const maintenant = connecteur.ouverture.maintenant;
  connecteur.ouverture.lancer = banc.lancer;
  if (horloge) connecteur.ouverture.maintenant = horloge;
  const lignes = [];
  const preuves = [];
  try {
    let resultat = null;
    let erreur = null;
    try {
      resultat = await connecteur.fetchInvoices(
        { session: faux.sessionInventee(hote), historique: 'depuis', ...config },
        {
          userId: 1,
          log: (m) => lignes.push(String(m)),
          preuveDeListe: (p) => preuves.push(p),
          knownRemoteIds: [],
          ...ctxExtra,
        }
      );
    } catch (err) {
      erreur = err;
    }
    assert.ok(banc.lancements() >= 1, 'le passage a ouvert le FAUX navigateur, aucun autre');
    return { resultat, erreur, journal: banc.journal, lignes, preuves, ouverts: banc.ouverts() };
  } finally {
    connecteur.ouverture.lancer = lancer;
    connecteur.ouverture.maintenant = maintenant;
    await banc.fermer();
  }
}

/**
 * Ce qui doit tenir à CHAQUE passage : rien de cliqué, rien de saisi, aucune
 * requête sortie sur le vrai réseau, aucune adresse interdite demandée, et
 * aucune écriture hors de celles permises (`ecritures`, les envois du R4).
 */
function rienQueDesLectures(journal, etat, { ecritures = [] } = {}) {
  assert.deepEqual(journal.clics, [], `aucun clic — la page les compte : ${JSON.stringify(journal.clics)}`);
  assert.deepEqual(journal.saisies, [], 'aucune saisie, aucun envoi de formulaire par un geste');
  assert.deepEqual(journal.fuites, [], 'aucune requête n\'est sortie sur le vrai réseau');
  assert.deepEqual(journal.ecritures, ecritures, 'aucune requête d\'écriture hors des envois permis');
  assert.deepEqual(etat.compteurs.interdits, [], 'aucune adresse interdite demandée');
  for (const v of journal.visites) {
    assert.doesNotMatch(v, /submitReorder|reOrder|ReloadOrderID|PBShoppingCart|panier|cart|order-follow|return|mylogout|logout/i,
      `visite hors du parcours : ${v}`);
  }
}

/** Le journal ne dit ni numéro, ni référence, ni montant (règle 7). */
function journalSansDonnee(lignes, interdits) {
  const texte = lignes.join('\n');
  for (const motif of interdits) assert.doesNotMatch(texte, motif, `le journal ne porte pas ${motif}`);
  assert.doesNotMatch(texte, /\d+,\d\d\s*€/, 'aucun montant au journal');
  assert.doesNotMatch(texte, /\d{6,}/, 'aucune suite de six chiffres au journal');
}

/**
 * Le journal APPLICATIF (table `app_logs`, ce que l'administration lit) ne
 * porte ni numéro, ni référence, ni montant après un passage planifié (R7).
 */
function journalApplicatifSansDonnee(db, interdits) {
  const lignes = db.get().prepare('SELECT message FROM app_logs').all().map((l) => String(l.message));
  assert.ok(lignes.length > 0, 'le passage a écrit au journal applicatif');
  journalSansDonnee(lignes, interdits);
}

/** L'instance qu'exécute le planificateur (voir l'en-tête). */
function instanceDuRegistre(registry, id) {
  return registry.get(id).module;
}

/**
 * Lève le verrou des essais (`CRABE_DISABLE_SCRAPING`) le temps d'un bloc,
 * mais INTERDIT le vrai navigateur : seul le faux lanceur, posé passage par
 * passage, peut en ouvrir un. Rend la fonction qui restaure tout.
 */
function interdireLeVraiNavigateur(registry, id) {
  const configuration = require('../server/config').config;
  const enLigne = configuration.scrapingDisabled;
  configuration.scrapingDisabled = false;
  const instance = instanceDuRegistre(registry, id);
  const lancementReel = instance.ouverture.lancer;
  instance.ouverture.lancer = () => {
    throw new Error('essai : lancement d\'un vrai navigateur interdit — le faux site n\'a pas été branché');
  };
  return () => {
    configuration.scrapingDisabled = enLigne;
    instance.ouverture.lancer = lancementReel;
  };
}

/** Installe le vrai connecteur pour un compte neuf, connexion enregistrée par la fenêtre. */
async function compteAvec(helpers, registry, id, nom, hote) {
  const user = await helpers.createUser({ username: nom, role: 'admin' });
  registry.install(user.id, id);
  registry.saveConfig(user.id, id, { session: faux.sessionInventee(hote) }, { origine: 'fenetre' });
  return user;
}

/** Un passage par `scheduler.runForUser`, sur le faux site. */
async function parLePlanificateur({ registry, scheduler, id, hote, site, etat, user, horloge = null, ecritures = [] }) {
  const banc = faux.lanceurFaux([hote], site(etat));
  const instance = instanceDuRegistre(registry, id);
  const lancer = instance.ouverture.lancer;
  const maintenant = instance.ouverture.maintenant;
  instance.ouverture.lancer = banc.lancer;
  if (horloge) instance.ouverture.maintenant = horloge;
  try {
    const r = await scheduler.runForUser(user.id, id, 'manual');
    assert.ok(banc.lancements() >= 1, `le planificateur a ouvert le FAUX navigateur, aucun autre (${r.message})`);
    rienQueDesLectures(banc.journal, etat, { ecritures: typeof ecritures === 'function' ? ecritures(etat) : ecritures });
    return { r, journal: banc.journal };
  } finally {
    instance.ouverture.lancer = lancer;
    instance.ouverture.maintenant = maintenant;
    await banc.fermer();
  }
}

/** Le nombre de documents d'un compte, pour un connecteur. */
function documents(db, user, id) {
  return db.get().prepare('SELECT filename, remote_id, issued_on FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id')
    .all(user.id, id);
}

/** Pose `CRABE_LIMITE_EXECUTION_MS` le temps de `corps`, puis la remet. */
async function avecLimite(ms, corps) {
  const avant = process.env.CRABE_LIMITE_EXECUTION_MS;
  process.env.CRABE_LIMITE_EXECUTION_MS = String(ms);
  try {
    return await corps();
  } finally {
    if (avant === undefined) delete process.env.CRABE_LIMITE_EXECUTION_MS;
    else process.env.CRABE_LIMITE_EXECUTION_MS = avant;
  }
}

/** Le code d'un connecteur, sans ses commentaires — pour les essais qui lisent le fichier. */
function codeSansCommentaires(source) {
  return require('node:fs').readFileSync(source, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

module.exports = {
  passer,
  rienQueDesLectures,
  journalSansDonnee,
  journalApplicatifSansDonnee,
  instanceDuRegistre,
  interdireLeVraiNavigateur,
  compteAvec,
  parLePlanificateur,
  documents,
  avecLimite,
  codeSansCommentaires,
};
