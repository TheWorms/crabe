'use strict';

/**
 * Le champ par lequel un site reconnaît son visiteur — et son libellé.
 *
 * ─── Le défaut que ces tests figent ──────────────────────────────────────────
 *
 * La fiche de L'Atelier du Portable réclamait une « Adresse électronique ». Le
 * site demande un IDENTIFIANT, et la valeur enregistrée (« prenom.nom ») n'est
 * pas une adresse. Le libellé était écrit à la main dans le manifeste, le
 * formulaire l'affichait tel quel, et rien dans le programme ne pouvait le
 * démentir.
 *
 * Ce qui est vérifié ici : le libellé, l'aide et le type de champ HTML viennent
 * de la NATURE déclarée par le manifeste (`identification`), un manifeste qui se
 * contredit est refusé au chargement, et les vingt-trois connecteurs livrés
 * déclarent bien ce que leur site demande.
 *
 * Le rendu réel du formulaire — la preuve à l'écran — est dans
 * test/render.test.js, qui exécute web/app.js sur le manifeste réel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = require('../server/connectors/manifest-schema');
const identification = require('../server/connectors/identification');
const detection = require('../server/connectors/login-detection');

const AVAILABLE = path.resolve(__dirname, '..', 'server', 'connectors', 'available');

/** Les manifestes réellement livrés, tels que le registre les charge. */
function manifestesLivres() {
  return fs
    .readdirSync(AVAILABLE)
    .map((id) => ({ id, fichier: path.join(AVAILABLE, id, 'manifest.json') }))
    // `available/prestashop/` ne porte que du code : c'est l'implémentation
    // partagée des boutiques, pas un service.
    .filter(({ fichier }) => fs.existsSync(fichier))
    .map(({ id, fichier }) => ({
      id,
      brut: JSON.parse(fs.readFileSync(fichier, 'utf8')),
    }));
}

/** Le champ d'identification d'un manifeste normalisé, ou null. */
function champIdentification(manifest) {
  return (manifest.fields || []).find((f) => f.identification) || null;
}

/** Un manifeste minimal valide, dont on ne fait varier que le champ étudié. */
function manifesteAvec(champ) {
  return {
    id: 'exemple',
    name: 'Exemple',
    category: 'shopping',
    description: 'Récupère automatiquement les factures de vos commandes.',
    fields: [champ],
    permissions: [
      {
        key: 'factures',
        scope: 'read-write',
        description: 'Télécharge les factures PDF des commandes passées sur la boutique Exemple.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Le vocabulaire : deux natures, et ce que chacune impose
// ---------------------------------------------------------------------------

test('le vocabulaire distingue une adresse électronique d\'un identifiant', () => {
  assert.deepEqual(identification.KEYS, ['email', 'identifiant']);

  assert.equal(identification.NATURES.email.label, 'Adresse électronique');
  assert.equal(identification.NATURES.email.inputType, 'email');
  assert.equal(identification.NATURES.identifiant.label, 'Identifiant');
  // `text`, et c'est le fond de l'affaire : « prenom.nom » n'entre pas dans un
  // champ que le navigateur valide comme une adresse.
  assert.equal(identification.NATURES.identifiant.inputType, 'text');
});

test('l\'aide est écrite dans la langue du service, pas dans celle du programme', () => {
  assert.deepEqual(identification.defauts({ identification: 'email' }, 'Kubii'), {
    label: 'Adresse électronique',
    help: 'Celle avec laquelle vous vous connectez sur Kubii.',
  });
  assert.deepEqual(
    identification.defauts({ identification: 'identifiant' }, 'L\'Atelier du Portable'),
    {
      label: 'Identifiant',
      help: 'Celui avec lequel vous vous connectez sur L\'Atelier du Portable.',
    }
  );

  // Un champ qui ne déclare rien n'hérite de rien : mot de passe, adresse de
  // boutique et profondeur d'historique gardent leurs textes.
  assert.deepEqual(identification.defauts({ type: 'password' }, 'Kubii'), {});
});

// ---------------------------------------------------------------------------
// Ce que le manifeste n'écrit plus, et ce qu'il garde le droit d'écrire
// ---------------------------------------------------------------------------

test('un champ qui déclare sa nature n\'écrit plus ni libellé ni aide', () => {
  const brut = manifesteAvec({ key: 'email', identification: 'identifiant', type: 'text' });
  const controle = schema.validate(brut, 'exemple');
  assert.deepEqual(controle.errors, [], 'un champ sans libellé doit être accepté');

  const champ = champIdentification(schema.normalize(brut));
  assert.equal(champ.label, 'Identifiant');
  assert.equal(champ.help, 'Celui avec lequel vous vous connectez sur Exemple.');
  assert.equal(champ.inputType, 'text');
});

test('le libellé propre à un site garde le dernier mot', () => {
  const brut = manifesteAvec({
    key: 'numeroFiscal',
    identification: 'identifiant',
    label: 'Numéro fiscal',
    type: 'text',
    help: '13 chiffres, en haut de votre dernier avis.',
  });
  const champ = champIdentification(schema.normalize(brut));

  // « Numéro fiscal » est un fait du site, pas un synonyme à unifier.
  assert.equal(champ.label, 'Numéro fiscal');
  assert.equal(champ.help, '13 chiffres, en haut de votre dernier avis.');
  // La nature reste déclarée : c'est elle qui fixe le type de champ.
  assert.equal(champ.inputType, 'text');
});

test('un champ ordinaire doit toujours écrire son libellé', () => {
  const controle = schema.validate(
    manifesteAvec({ key: 'motDePasse', type: 'password' }),
    'exemple'
  );
  assert.equal(controle.ok, false);
  assert.match(controle.errors.join(' | '), /fields\[0\]\.label manquant/);
});

// ---------------------------------------------------------------------------
// Les manifestes qui se contredisent sont refusés au chargement
// ---------------------------------------------------------------------------

test('une nature inconnue fait refuser le manifeste', () => {
  const controle = schema.validate(
    manifesteAvec({ key: 'email', identification: 'adresse-postale', type: 'text' }),
    'exemple'
  );
  assert.equal(controle.ok, false);
  assert.match(
    controle.errors.join(' | '),
    /identification « adresse-postale » inconnue \(attendu : email, identifiant\)/
  );
});

test('un type de champ qui contredit la nature fait refuser le manifeste', () => {
  // Le défaut exact de L'Atelier du Portable : un identifiant dans un champ
  // que le navigateur valide comme une adresse.
  const controle = schema.validate(
    manifesteAvec({ key: 'email', identification: 'identifiant', type: 'email' }),
    'exemple'
  );
  assert.equal(controle.ok, false);
  assert.match(
    controle.errors.join(' | '),
    /type « email » contredit identification « identifiant » \(attendu : text\)/
  );
});

test('deux champs d\'identification sont refusés : un site n\'en demande qu\'un', () => {
  const brut = manifesteAvec({ key: 'email', identification: 'email', type: 'email' });
  brut.fields.push({ key: 'login', identification: 'identifiant', type: 'text' });

  const controle = schema.validate(brut, 'exemple');
  assert.equal(controle.ok, false);
  assert.match(controle.errors.join(' | '), /2 champs déclarent « identification »/);
});

test('un libellé vide n\'est pas une façon de dire « prends celui de la nature »', () => {
  const controle = schema.validate(
    manifesteAvec({ key: 'email', identification: 'email', label: '  ', type: 'email' }),
    'exemple'
  );
  assert.equal(controle.ok, false);
  assert.match(controle.errors.join(' | '), /label est vide : retirez-le/);
});

// ---------------------------------------------------------------------------
// Ce que le formulaire reçoit
// ---------------------------------------------------------------------------

test('publicView sert la nature ET le type de champ HTML', () => {
  const vue = schema.publicView(
    schema.normalize(manifesteAvec({ key: 'email', identification: 'email', type: 'email' }))
  );
  const champ = champIdentification(vue);

  assert.equal(champ.identification, 'email');
  assert.equal(champ.inputType, 'email');
  assert.equal(champ.label, 'Adresse électronique');
});

test('un champ sans nature garde son type comme type de champ HTML', () => {
  const brut = manifesteAvec({ key: 'site', label: 'Adresse de la boutique', type: 'text' });
  const champ = schema.publicView(schema.normalize(brut)).fields[0];

  assert.equal(champ.identification, undefined);
  assert.equal(champ.inputType, 'text');
});

// ---------------------------------------------------------------------------
// Les vingt-trois connecteurs livrés
// ---------------------------------------------------------------------------

test('L\'Atelier du Portable demande un identifiant, pas une adresse', () => {
  const brut = manifestesLivres().find((m) => m.id === 'atelier-du-portable').brut;
  const champ = champIdentification(schema.normalize(brut));

  assert.equal(champ.label, 'Identifiant');
  assert.equal(champ.inputType, 'text');
  assert.equal(champ.type, 'text');
  // L'aide ne parle plus d'adresse : c'était le second mensonge de la fiche.
  assert.equal(/adresse/i.test(champ.help), false, `aide encore trompeuse : ${champ.help}`);
  assert.match(champ.help, /identifiant/i);

  // La clé de configuration, elle, ne bouge pas : « prenom.nom » est déjà
  // enregistré sous `email`, et le pré-remplissage de la fenêtre de connexion
  // le retrouve toujours.
  assert.equal(champ.key, 'email');
  assert.equal(
    detection.identifiantDeConfig(schema.normalize(brut), { email: 'prenom.nom' }),
    'prenom.nom'
  );
});

test('les boutiques PrestaShop gardent leur adresse électronique', () => {
  const boutiques = manifestesLivres().filter((m) => m.brut.implementation === 'prestashop');
  // Sept depuis le lot 17 : l'entrée générique « boutique-prestashop », qui
  // demandait son adresse à l'utilisateur, a été retirée du catalogue.
  assert.ok(boutiques.length >= 7, 'les boutiques du lot 12 doivent être là');

  for (const { id, brut } of boutiques) {
    const champ = champIdentification(schema.normalize(brut));
    assert.equal(champ?.identification, 'email', `${id} : nature attendue « email »`);
    assert.equal(champ.label, 'Adresse électronique', `${id} : libellé`);
    assert.equal(champ.inputType, 'email', `${id} : type de champ HTML`);
  }
});

test('chaque connecteur livré déclare ce que son site demande', () => {
  // Un champ que le navigateur valide comme une adresse SANS nature déclarée,
  // c'est le défaut de départ qui revient par la porte d'un nouveau manifeste.
  for (const { id, brut } of manifestesLivres()) {
    const controle = schema.validate(brut, id);
    assert.deepEqual(controle.errors, [], `${id} : manifeste refusé`);

    for (const champ of brut.fields || []) {
      if (champ.type !== 'email') continue;
      assert.equal(
        champ.identification,
        'email',
        `${id} : le champ « ${champ.key} » réclame une adresse sans le déclarer`
      );
    }
  }
});

test('les connecteurs sans champ à saisir n\'inventent pas d\'identification', () => {
  // Amazon et Free Mobile se connectent par navigateur, OVH et Scaleway par
  // clés d'API : aucun n'a de champ d'identification, et leur en faire déclarer
  // un serait une déclaration fausse.
  const attendus = ['amazon', 'free-mobile', 'ovh', 'scaleway'];
  for (const { id, brut } of manifestesLivres().filter((m) => attendus.includes(m.id))) {
    assert.equal(champIdentification(schema.normalize(brut)), null, `${id} : rien à déclarer`);
  }
});
