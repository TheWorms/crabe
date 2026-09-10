'use strict';

/**
 * Verrou « une seule à la fois » (server/connectors/inflight.js).
 *
 * La recherche de ce que porte un compte prend 20 à 60 secondes, pendant
 * lesquelles le bouton restait cliquable : un utilisateur qui trouvait que « ça
 * ne répond pas » lançait un SECOND navigateur sur le même compte, chez le même
 * fournisseur, depuis la même session.
 *
 * Griser le bouton était nécessaire mais ne suffisait pas — un deuxième onglet,
 * un rechargement, un appel direct passent à travers. Ces tests portent donc
 * sur le verrou du serveur, seul à ne pas pouvoir être contourné.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inflight = require('../server/connectors/inflight');

/** Une promesse qu'on règle à la main : c'est ce qui fabrique le « pendant ». */
function differee() {
  let resoudre;
  let rejeter;
  const promesse = new Promise((ok, ko) => {
    resoudre = ok;
    rejeter = ko;
  });
  return { promesse, resoudre, rejeter };
}

test('une seconde recherche est refusée tant que la première tourne', async () => {
  const verrou = inflight.createLock();
  const premiere = differee();

  let secondeLancee = false;
  const enCours = verrou.run('1:free-mobile', () => premiere.promesse);

  await assert.rejects(
    () =>
      verrou.run('1:free-mobile', async () => {
        secondeLancee = true;
        return 'jamais';
      }),
    (err) => {
      assert.equal(err.statusCode, 409, 'un refus, pas une panne');
      assert.equal(err.alreadyRunning, true);
      assert.match(err.message, /déjà en cours/i);
      return true;
    }
  );

  // Le point qui compte : le connecteur n'a pas été appelé une seconde fois.
  // Aucun second navigateur n'a été ouvert.
  assert.equal(secondeLancee, false, 'la seconde recherche ne doit pas démarrer du tout');

  premiere.resoudre('trouvé');
  assert.equal(await enCours, 'trouvé');
});

test('le verrou est rendu dès la fin, succès comme échec', async () => {
  const verrou = inflight.createLock();

  await verrou.run('1:free-mobile', async () => 'ok');
  assert.equal(verrou.busy('1:free-mobile'), false, 'rendu après un succès');

  await assert.rejects(() =>
    verrou.run('1:free-mobile', async () => {
      throw new Error('session expirée');
    })
  );
  assert.equal(verrou.busy('1:free-mobile'), false, 'rendu après un échec');

  // Et la recherche suivante passe : un échec ne doit pas enfermer dehors.
  assert.equal(await verrou.run('1:free-mobile', async () => 'à nouveau'), 'à nouveau');
});

test('le verrou porte sur un compte ET un connecteur, pas sur le serveur entier', async () => {
  const verrou = inflight.createLock();
  const premiere = differee();
  const enCours = verrou.run('1:free-mobile', () => premiere.promesse);

  // Un autre compte, ou un autre connecteur du même compte, n'est pas concerné.
  assert.equal(await verrou.run('2:free-mobile', async () => 'autre compte'), 'autre compte');
  assert.equal(await verrou.run('1:edf', async () => 'autre connecteur'), 'autre connecteur');

  premiere.resoudre('fini');
  await enCours;
});

test('un verrou abandonné est repris, plutôt que d\'enfermer le compte dehors', async () => {
  // Une promesse qui ne se règle JAMAIS : le navigateur figé sur un portail
  // qui ne répond ni en succès ni en erreur. Sans sursis, plus aucune recherche
  // ne serait possible jusqu'au redémarrage du service, et rien ne l'expliquerait.
  let horloge = 1_000_000;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 60_000 });

  verrou.run('1:free-mobile', () => new Promise(() => {}));
  assert.equal(verrou.busy('1:free-mobile'), true);

  horloge += 59_000;
  assert.equal(verrou.busy('1:free-mobile'), true, 'avant le sursis, le verrou tient');

  horloge += 2000;
  assert.equal(verrou.busy('1:free-mobile'), false, 'passé le sursis, il est repris');
  assert.equal(await verrou.run('1:free-mobile', async () => 'repris'), 'repris');
});

test('un verrou de fenêtre tenu par un navigateur VIVANT tient au-delà du sursis', () => {
  // Le défaut mesuré le 23/08/2026 : la fenêtre de connexion Bricomarché est
  // restée ouverte plus de vingt minutes (un mot de passe impossible à
  // coller), très au-delà du sursis — et le verrou, jugé au chronomètre seul,
  // était « abandonné » pendant que l'utilisateur travaillait dedans : un
  // second navigateur pouvait s'ouvrir sur le même profil.
  let horloge = 1_000_000;
  let navigateurTourne = true;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 60_000 });

  verrou.acquire('1:bricomarche', inflight.PORTEUR_FENETRE, 'occupé',
    { preuveDeVie: () => navigateurTourne });

  horloge += 20 * 60 * 1000; // vingt minutes : le geste humain du 23/08/2026
  assert.equal(verrou.busy('1:bricomarche'), true,
    'un profil dont le navigateur tourne encore n\'est PAS abandonné');
  assert.equal(verrou.holder('1:bricomarche'), inflight.PORTEUR_FENETRE,
    'le refus continue de dire QUOI attendre');
  assert.throws(() => verrou.acquire('1:bricomarche', 'autre'), /déjà en cours/);

  // Le navigateur meurt (fermeture, ou `kill`) : le verrou est repris au
  // contrôle suivant — l'utilisateur n'est jamais enfermé dehors.
  navigateurTourne = false;
  assert.equal(verrou.busy('1:bricomarche'), false,
    'un verrou dont le détenteur a disparu DOIT être repris');
  verrou.acquire('1:bricomarche', 'seconde fenêtre');
  verrou.release('1:bricomarche');
});

test('un verrou de fenêtre dont le détenteur a disparu est repris, preuve à l\'appui', () => {
  let horloge = 0;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 60_000 });
  verrou.acquire('1:darty', inflight.PORTEUR_FENETRE, 'occupé', { preuveDeVie: () => false });

  horloge += 59_000;
  assert.equal(verrou.busy('1:darty'), true,
    'avant le sursis, le chronomètre suffit — la preuve n\'est même pas consultée');

  horloge += 2_000;
  assert.equal(verrou.busy('1:darty'), false, 'passé le sursis, détenteur mort : repris');
});

test('une preuve de vie qui LÈVE compte comme une mort — le doute n\'enferme jamais dehors', () => {
  let horloge = 0;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 60_000 });
  verrou.acquire('1:vistaprint', inflight.PORTEUR_FENETRE, 'occupé', {
    preuveDeVie: () => { throw new Error('profil illisible'); },
  });

  horloge += 61_000;
  assert.equal(verrou.busy('1:vistaprint'), false,
    'une preuve qui lève ne doit pas faire tenir le verrou pour toujours');
});

test('run() garde le chronomètre seul : une récupération figée est toujours reprise', () => {
  // Le compromis d'origine reste juste pour run() : sa fin est un `await`,
  // sa durée se borne — aucune preuve de vie ne s'y attache.
  let horloge = 0;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 60_000 });
  verrou.run('1:free-mobile', () => new Promise(() => {}));

  horloge += 61_000;
  assert.equal(verrou.busy('1:free-mobile'), false,
    'passé le sursis, un run() figé est repris — comportement inchangé');
});

test('le refus dit depuis combien de temps ça tourne', async () => {
  let horloge = 0;
  const verrou = inflight.createLock({ now: () => horloge });
  const premiere = differee();
  const enCours = verrou.run('1:free-mobile', () => premiere.promesse);

  horloge += 12_000;
  await assert.rejects(
    () => verrou.run('1:free-mobile', async () => null),
    (err) => {
      assert.equal(err.sinceSeconds, 12);
      return true;
    }
  );

  premiere.resoudre(null);
  await enCours;
});

test('« size » compte ce qui tourne vraiment, pas ce qui a été oublié', async () => {
  let horloge = 0;
  const verrou = inflight.createLock({ now: () => horloge, timeoutMs: 10_000 });

  verrou.run('1:free-mobile', () => new Promise(() => {}));
  verrou.run('2:free-mobile', () => new Promise(() => {}));
  assert.equal(verrou.size, 2);

  horloge += 20_000;
  assert.equal(verrou.size, 0, 'deux verrous périmés ne « tournent » plus');
});

test('le verrou des recherches est partagé par tout le processus', () => {
  // Deux requêtes HTTP ne se voient pas l'une l'autre : c'est ce verrou-là,
  // et lui seul, qui les met d'accord.
  assert.equal(typeof inflight.discovery.run, 'function');
  assert.equal(inflight.discoveryKey(7, 'free-mobile'), '7:free-mobile');
});
