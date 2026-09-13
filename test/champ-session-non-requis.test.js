'use strict';

/**
 * Le piège circulaire du champ « session », fermé À LA SOURCE.
 *
 * ─── Le cercle ───────────────────────────────────────────────────────────────
 *
 * Un champ de type `session` ne se remplit jamais à la main : il est écrit par
 * la CAPTURE, à la fin d'une connexion que l'utilisateur a ouverte lui-même
 * dans une fenêtre de navigateur. Le bouton « Se connecter à … » enregistre
 * d'abord la fiche, puis ouvre la fenêtre (`enregistrerPuisOuvrirConnexion`,
 * web/app.js) — et il retire volontairement le champ de session de ce qu'il
 * envoie, pour ne pas écraser une connexion encore valable par une valeur vide.
 *
 * Si ce champ est déclaré `required: true`, cet enregistrement est refusé :
 * « Champs obligatoires manquants : Connexion à … ». La fenêtre ne s'ouvre
 * jamais. Il faudrait donc être déjà connecté pour pouvoir se connecter — le
 * connecteur ne peut PLUS JAMAIS être configuré, par personne.
 *
 * ─── Pourquoi ce fichier a été renforcé (lot 26) ─────────────────────────────
 *
 * La version précédente balayait `registry.listAvailable()`, et c'était trop
 * peu. Elle laissait passer trois choses :
 *
 *   1. **un manifeste qui ne dit rien.** `normalizeField()` posait
 *      `required: true` par défaut : un champ de session sans mention explicite
 *      sortait donc obligatoire, et le piège naissait d'un OUBLI, pas d'une
 *      erreur qu'on puisse relire ;
 *   2. **un connecteur qui ne se charge pas.** Un manifeste illisible ou refusé
 *      par le schéma n'est dans aucune des deux tables du registre : le test
 *      passait sans l'avoir regardé, et le défaut réapparaissait le jour où
 *      quelqu'un réparait le manifeste ;
 *   3. **un service seulement annoncé.** `planned/` n'était pas balayé — et
 *      rendre un service disponible se fait en DÉPLAÇANT son dossier, sans
 *      toucher à son contenu. Le piège voyageait donc avec.
 *
 * Ce fichier ferme désormais la porte des trois côtés : la règle sur les
 * fichiers du disque (tous, chargés ou non), la garantie structurelle de
 * `normalize()`, et le comportement réel du registre.
 *
 * ⚠ La garantie qui compte est la deuxième. Un test n'attrape que ce qui existe
 * le jour où on le lance ; `normalize()`, lui, est sur le chemin de tout le
 * monde, tout le temps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const registry = require('../server/connectors/registry');
const schema = require('../server/connectors/manifest-schema');

/** Tous les connecteurs du catalogue qui font ouvrir une connexion à la main. */
function connecteursASession() {
  return registry
    .listAvailable()
    .map((c) => registry.manifest(c.id))
    .filter((m) => (m.fields || []).some((f) => f.type === 'session'));
}

/**
 * Tous les manifestes du disque, LUS DIRECTEMENT — chargés ou non, annoncés ou
 * disponibles.
 *
 * Volontairement en `fs` plutôt qu'en passant par le registre : c'est ce qui
 * fait que le balayage n'a aucun trou. Un dossier ajouté demain y entre sans
 * que personne n'ait à inscrire son nom quelque part.
 */
function tousLesManifestesDuDisque() {
  const trouves = [];
  for (const racine of [registry.AVAILABLE_DIR, registry.PLANNED_DIR]) {
    if (!fs.existsSync(racine)) continue;
    for (const entree of fs.readdirSync(racine, { withFileTypes: true })) {
      if (!entree.isDirectory()) continue;
      const fichier = path.join(racine, entree.name, 'manifest.json');
      // Pas de manifeste : c'est une implémentation partagée (du code, pas un
      // service). Elle n'a pas de champ, donc pas de piège possible.
      if (!fs.existsSync(fichier)) continue;
      let brut;
      try {
        brut = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      } catch {
        // Un manifeste illisible est le problème d'un autre test ; ici il n'a
        // pas de champ de session déclarable, donc rien à vérifier.
        continue;
      }
      trouves.push({ dossier: entree.name, racine: path.basename(racine), manifeste: brut });
    }
  }
  return trouves;
}

let compte;

test.before(async () => {
  await helpers.setup();
  compte = await helpers.createUser({ username: 'session-non-requise', role: 'admin' });
  registry.load();
  registry.syncCatalog();
});

test.after(() => helpers.teardown());

// ---------------------------------------------------------------------------
// 1. La règle, sur TOUS les fichiers du disque
// ---------------------------------------------------------------------------

test('aucun manifeste du disque ne déclare un champ de session obligatoire', () => {
  const fautifs = [];

  for (const { dossier, racine, manifeste } of tousLesManifestesDuDisque()) {
    for (const champ of (manifeste.fields || []).filter((f) => f?.type === 'session')) {
      if (champ.required) fautifs.push(`${racine}/${dossier}.${champ.key}`);
    }
  }

  assert.deepEqual(
    fautifs,
    [],
    'un champ de session obligatoire rend son connecteur impossible à configurer : '
      + 'il ne peut être rempli qu\'APRÈS une connexion réussie, que la validation du '
      + 'formulaire empêche d\'atteindre. Le chargement le corrige désormais tout seul, '
      + 'mais la ligne doit disparaître du manifeste avant d\'être recopiée ailleurs'
  );
});

test('le catalogue en porte bien, sinon ce fichier ne vérifierait rien', () => {
  // Garde-fou du garde-fou : si un jour plus aucun connecteur n'a de champ de
  // session, le test ci-dessus passerait sans rien avoir regardé.
  assert.ok(
    connecteursASession().length >= 5,
    `attendu au moins cinq connecteurs à session, trouvé ${connecteursASession().length}`
  );
  assert.ok(
    tousLesManifestesDuDisque().length >= 40,
    'le balayage du disque ne trouve presque rien : il ne regarde pas au bon endroit'
  );
});

// ---------------------------------------------------------------------------
// 2. La garantie STRUCTURELLE — celle qui n'a besoin de personne
// ---------------------------------------------------------------------------

test('un manifeste qui EXIGE la session est ramené à « pas obligatoire »', () => {
  // Le cas que le test de la section 1 signale : ici on vérifie qu'il ne peut
  // plus faire de dégât en attendant d'être corrigé.
  const normalise = schema.normalize({
    id: 'faux-service',
    name: 'Faux Service',
    category: 'autre',
    fields: [{ key: 'session', label: 'Connexion à Faux Service', type: 'session', required: true }],
  });

  assert.equal(
    normalise.fields[0].required,
    false,
    'un manifeste peut se tromper ; le chargement, lui, ne doit pas laisser passer'
  );
});

test('un manifeste qui NE DIT RIEN ne rend pas la session obligatoire', () => {
  // La vraie origine du défaut : `required: true` était le défaut de tous les
  // champs. Le piège se refermait donc sur un simple oubli, invisible à la
  // relecture puisqu'il n'y avait rien à relire.
  const normalise = schema.normalize({
    id: 'faux-service',
    name: 'Faux Service',
    category: 'autre',
    fields: [{ key: 'session', label: 'Connexion à Faux Service', type: 'session' }],
  });

  assert.equal(
    normalise.fields[0].required,
    false,
    'un champ de session muet doit sortir facultatif : c\'est un oubli qui a créé le piège'
  );
});

test('les autres champs gardent leur obligation — la règle ne déborde pas', () => {
  // La contrepartie, sans laquelle la correction précédente serait une brèche :
  // un identifiant ou un mot de passe reste exigé.
  const normalise = schema.normalize({
    id: 'faux-service',
    name: 'Faux Service',
    category: 'autre',
    fields: [
      { key: 'identifiant', label: 'Identifiant', type: 'text', required: true },
      { key: 'motDePasse', label: 'Mot de passe', type: 'password', required: true },
    ],
  });

  assert.deepEqual(
    normalise.fields.map((f) => f.required),
    [true, true],
    'seuls les champs qu\'aucune saisie ne peut remplir sont dispensés'
  );
});

// ---------------------------------------------------------------------------
// 3. Le comportement — ce que fait vraiment « Se connecter à … »
// ---------------------------------------------------------------------------

test('chaque connecteur à session accepte d\'être enregistré AVANT la connexion', () => {
  // Exactement ce que le bouton « Se connecter » envoie : la fiche telle qu'elle
  // est remplie, moins le champ de session, qu'il retire lui-même.
  for (const manifeste of connecteursASession()) {
    const saisie = {};
    for (const champ of manifeste.fields) {
      if (champ.type === 'session' || champ.type === 'history') continue;
      if (champ.type === 'multiselect') continue;
      if (champ.required) saisie[champ.key] = 'valeur-de-test';
    }

    registry.install(compte.id, manifeste.id);
    assert.doesNotThrow(
      () => registry.saveConfig(compte.id, manifeste.id, saisie),
      `${manifeste.id} : la fiche est refusée tant qu'aucune connexion n'a été ouverte — `
        + 'or c\'est cet enregistrement qui ouvre la fenêtre de connexion'
    );
    registry.uninstall(compte.id, manifeste.id);
  }
});

test('une session déjà enregistrée n\'est pas effacée par un enregistrement sans elle', () => {
  // L'autre moitié de la promesse : `required: false` ne doit pas devenir
  // « le champ n'a pas d'importance ». Une connexion capturée survit à toutes
  // les modifications ultérieures de la fiche.
  const manifeste = connecteursASession()[0];
  const champ = manifeste.fields.find((f) => f.type === 'session');
  const etat = JSON.stringify({ cookies: [{ name: 'a', value: 'b', domain: '.exemple.fr', path: '/' }], origins: [] });

  registry.install(compte.id, manifeste.id);
  registry.saveConfig(compte.id, manifeste.id, { [champ.key]: etat });
  const apresCapture = registry.readConfig(compte.id, manifeste.id);
  assert.ok(apresCapture[champ.key], `${manifeste.id} : la session n'a pas été enregistrée`);

  registry.saveConfig(compte.id, manifeste.id, { historique: 'depuis' });
  const apresModification = registry.readConfig(compte.id, manifeste.id);
  assert.equal(
    apresModification[champ.key],
    apresCapture[champ.key],
    `${manifeste.id} : la connexion capturée a été perdue en modifiant la fiche`
  );

  registry.uninstall(compte.id, manifeste.id);
});
