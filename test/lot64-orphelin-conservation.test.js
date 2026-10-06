'use strict';

/**
 * Lot 64 — l'orphelin de pCloud, et l'écran qui ne le laissait pas prévoir.
 *
 * ─── Le fait qui a ouvert le lot ─────────────────────────────────────────────
 *
 * Un fichier existait sur deux clouds qu'AUCUNE ligne de la base ne
 * revendiquait, en face d'un trou dans l'historique d'un service. L'enquête n'a
 * trouvé ni purge trop large, ni migration perdue, ni dépôt réussi sans sa
 * ligne : **l'entretien de nuit a fait exactement ce que son code dit**. La
 * conservation efface le fichier sur l'espace de crabe et la ligne d'index, et
 * ne touche jamais aux copies déposées chez des tiers (`server/retention.js`,
 * en-tête et `deleteDocument`). Un orphelin n'est donc pas un accident : c'est
 * la trace normale de tout document qui franchit la profondeur retenue.
 *
 * Ce fichier épingle les deux moitiés de l'affaire :
 *
 *   1. **le mécanisme**, pour qu'il ne change pas par accident — la copie cloud
 *      DOIT survivre au nettoyage (la supprimer serait irréversible, invisible,
 *      et prise sur le compte de quelqu'un d'autre) ;
 *   2. **ce que l'écran en dit**, parce que c'est là qu'était le vrai défaut :
 *      il promettait un plafond de récupération qui n'existe pas, et cachait le
 *      nombre de documents que la nuit allait emporter.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const retention = require('../server/retention');
const destinations = require('../server/destinations');
const db = require('../server/db/db');

const WEB = path.join(__dirname, '..', 'web');

test.before(() => helpers.setup());
test.after(() => helpers.teardown());

function neutre() {
  db.get()
    .prepare(
      `UPDATE security_policy
          SET document_retention_months = 0, document_retention_floor = NULL WHERE id = 1`
    )
    .run();
  db.get().prepare('DELETE FROM invoices').run();
}

/** Une date ISO située il y a `mois` mois. */
function ilYA(mois) {
  const d = new Date();
  d.setMonth(d.getMonth() - mois);
  return d.toISOString().slice(0, 10);
}

/**
 * Dépose une facture sur le stockage local ET sur un « cloud ».
 *
 * Le cloud est un dossier temporaire situé HORS de la racine du stockage local : c'est
 * ce qui le rend représentatif. `destinations.invoicePath()` n'accepte un
 * chemin enregistré que s'il est `isInside` de cette racine — un chemin cloud
 * ne peut donc jamais devenir candidat à l'effacement, et le test le vérifie
 * plutôt que de le supposer.
 */
function deposerPartout(user, { filename, issuedOn, connector = 'free' }) {
  const racine = destinations.publicConfig('local')?.path || process.env.CRABE_LOCAL_PATH;
  const fichier = path.join(
    racine, user.username, 'Free Internet', 'compte', String(issuedOn).slice(0, 4), filename
  );
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, '%PDF-1.4\nfacture de test\n');

  const nuage = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-lot64-cloud-'));
  const surLeCloud = path.join(nuage, filename);
  fs.writeFileSync(surLeCloud, '%PDF-1.4\nfacture de test\n');

  const info = db
    .get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, destinations)
       VALUES (?, ?, ?, ?, 'compte', ?, ?, ?)`
    )
    .run(
      user.id, connector, filename, filename,
      fs.statSync(fichier).size, issuedOn,
      JSON.stringify({
        local: { state: 'ok', ok: true, path: fichier },
        'cloud-beb5c888': { state: 'ok', ok: true, path: surLeCloud },
        'cloud-860ed77f': { state: 'ok', ok: true, path: surLeCloud },
      })
    );

  return { id: info.lastInsertRowid, fichier, surLeCloud };
}

// ---------------------------------------------------------------------------
// 1. Le mécanisme : la copie cloud survit, et c'est ainsi que naît un orphelin
// ---------------------------------------------------------------------------

test('le nettoyage emporte le fichier de crabe et la ligne — jamais la copie cloud', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'orphelin' });
  const { id, fichier, surLeCloud } = deposerPartout(user, {
    filename: 'passee-a-lanniversaire.pdf',
    issuedOn: ilYA(13),
  });

  // Confirmation explicite : le plancher tombe, le document de treize mois est
  // vraiment dû. C'est le geste que l'administrateur pose en connaissance de
  // cause — la voie ordinaire (plancher posé) est couverte par le lot 26.
  retention.setMonths(12, { applyNow: true });
  assert.equal(retention.expired().length, 1, 'le document de 13 mois est bien dû');

  const rendu = retention.purge();
  assert.equal(rendu.deleted, 1);

  assert.equal(
    db.get().prepare('SELECT COUNT(*) AS n FROM invoices WHERE id = ?').get(id).n,
    0,
    'la ligne d\'index part'
  );
  assert.equal(fs.existsSync(fichier), false, 'le fichier sur l\'espace de crabe part');
  assert.equal(
    fs.existsSync(surLeCloud),
    true,
    'la copie déposée sur le cloud RESTE : c\'est le compte de quelqu\'un d\'autre, et '
      + 'l\'effacement y serait irréversible et invisible. C\'est aussi, mécaniquement, ce '
      + 'qui fabrique un fichier que plus aucune ligne ne revendique.'
  );

  fs.rmSync(path.dirname(surLeCloud), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. L'écran : il ne promet plus un plafond qui n'existe pas
// ---------------------------------------------------------------------------

/** `documentRetentionState`, extraite du VRAI `web/admin.js` et exécutée. */
function phraseEcran(vue) {
  const contexte = vm.createContext({ console });
  const source = fs.readFileSync(path.join(WEB, 'admin.js'), 'utf8');
  const debut = source.indexOf('function documentRetentionState(');
  assert.ok(debut > 0, 'documentRetentionState introuvable dans admin.js');
  const fin = source.indexOf('\n}\n', debut);
  vm.runInContext(source.slice(debut, fin + 3), contexte);
  contexte.VUE = vue;
  return vm.runInContext('documentRetentionState(VUE)', contexte);
}

const PROMESSE_PLAFOND = 'ne descendront pas plus bas que cette profondeur';
const CONSEQUENCE = 'cesse de la répertorier';

test('un plancher posé : l\'écran ne promet AUCUN plafond de récupération', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'plancher-ecran' });
  deposerPartout(user, { filename: 'ancienne.pdf', issuedOn: ilYA(120) });

  retention.setMonths(12);
  const vue = retention.view();
  assert.ok(vue.floor, 'le geste ordinaire pose bien un plancher');

  // Le serveur, lui, ne pose aucun plafond dans ce cas (décision du lot 26).
  assert.equal(
    retention.fetchCapMonths(),
    0,
    'c\'est la mesure qui condamne la phrase : plancher posé ⇒ plafond nul'
  );

  const phrase = phraseEcran(vue);
  assert.ok(
    !phrase.includes(PROMESSE_PLAFOND),
    'l\'écran affirmait « vos services ne descendront pas plus bas que cette profondeur » '
      + 'alors que le serveur n\'applique aucun plafond dès qu\'un plancher existe. C\'est '
      + 'cette promesse qui rendait incompréhensible un service allé chercher 2019 puis '
      + 'nettoyé la nuit suivante.'
  );
  assert.ok(
    phrase.includes('aussi loin que leur'),
    'et il doit dire la vérité à la place : les services remontent selon leur propre réglage'
  );
});

test('sans plancher, la promesse de plafond est vraie — et elle reste écrite', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'sans-plancher-ecran' });
  deposerPartout(user, { filename: 'ancienne.pdf', issuedOn: ilYA(120) });

  retention.setMonths(12, { applyNow: true });
  const vue = retention.view();
  assert.equal(vue.floor, null);
  assert.equal(retention.fetchCapMonths(), 12, 'là, le plafond existe pour de bon');

  assert.ok(
    phraseEcran(vue).includes(PROMESSE_PLAFOND),
    'la phrase n\'est pas fausse en soi : elle était seulement servie dans la mauvaise branche'
  );
});

test('l\'écran annonce ce qui part au prochain entretien, plancher ou pas', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'partants' });

  // ─── La géométrie réelle, et pourquoi le plancher doit dater ──────────────
  //
  // Ce que `expired()` sélectionne n'est pas « plus vieux qu'un an » : c'est
  // une BANDE bornée des deux côtés — [ plancher − profondeur ; maintenant −
  // profondeur [. Son bord bas est FIGÉ le jour du réglage ; son bord haut
  // avance d'un jour par jour.
  //
  // Un plancher posé à l'instant donne donc une bande de largeur NULLE, et
  // aucun document ne peut y tomber. La bande ne s'ouvre qu'en vieillissant :
  // c'est pour ça que le plancher est ici reculé de quinze jours, exactement
  // comme sur l'installation réelle (plancher du 11/08, mesure du 26/08).
  const quinzeJours = new Date();
  quinzeJours.setDate(quinzeJours.getDate() - 15);

  deposerPartout(user, { filename: 'protegee.pdf', issuedOn: ilYA(120) });
  retention.setMonths(12);
  db.get()
    .prepare('UPDATE security_policy SET document_retention_floor = ? WHERE id = 1')
    .run(quinzeJours.toISOString());

  // Émis il y a un an et cinq jours : sous le bord haut (un an), au-dessus du
  // bord bas (un an et quinze jours). Il est dans la bande — c'est la facture
  // récupérée le matin du 26/08/2026 à 10:07 et due à l'entretien de la nuit
  // même, sans que rien à l'écran ne l'annonce.
  const unAnEtCinqJours = new Date();
  unAnEtCinqJours.setFullYear(unAnEtCinqJours.getFullYear() - 1);
  unAnEtCinqJours.setDate(unAnEtCinqJours.getDate() - 5);
  deposerPartout(user, {
    filename: 'dans-la-bande.pdf',
    issuedOn: unAnEtCinqJours.toISOString().slice(0, 10),
  });

  const vue = retention.view();
  assert.ok(vue.floor, 'plancher posé');
  assert.equal(vue.due, 1, 'un document part bien à la prochaine passe');

  assert.ok(
    phraseEcran(vue).includes('1 document(s) partiront au prochain entretien'),
    'la branche à plancher taisait ce nombre : elle ne l\'écrivait que sans plancher, '
      + 'c\'est-à-dire dans le cas que presque personne n\'a'
  );
});

test('l\'écran dit ce que devient le document effacé, dans les deux branches', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'consequence' });
  deposerPartout(user, { filename: 'ancienne.pdf', issuedOn: ilYA(120) });

  retention.setMonths(12);
  assert.ok(
    phraseEcran(retention.view()).includes(CONSEQUENCE),
    'sans cette phrase, un fichier retrouvé sur un cloud et absent de « Mes documents » '
      + 'n\'a aucune explication — c\'est exactement le fichier qui a ouvert ce lot'
  );

  retention.setMonths(12, { applyNow: true });
  assert.ok(phraseEcran(retention.view()).includes(CONSEQUENCE));
});

test('« Tout garder » ne parle ni de partants, ni de plafond', () => {
  neutre();
  const phrase = phraseEcran(retention.view());
  assert.ok(phrase.includes('indéfiniment'));
  assert.ok(!phrase.includes(PROMESSE_PLAFOND));
  assert.ok(!phrase.includes('partiront'));
});
