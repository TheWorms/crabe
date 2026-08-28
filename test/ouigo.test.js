'use strict';

/**
 * Connecteur OUIGO — une liste vide ne se déclare pas toute seule.
 *
 * L'onglet « PASSÉS » du compte de reconnaissance est VIDE : le connecteur ne
 * peut pas être validé contre un document réel, et il ne le prétend pas
 * (« initialStatus »: « pending »). Ce que ces tests verrouillent, c'est la
 * décision `etatDesReservations()` : « 0 réservation » n'est un résultat que
 * si la page des réservations a été SERVIE À CE COMPTE — l'adresse a tenu
 * (hors session, elle redirige — mesuré le 14/08/2026), aucun bouton « Se
 * connecter », et la phrase exacte de l'onglet vide. Tout le reste est un
 * échec explicite : c'est la tâche 3 de ce lot appliquée à un compte sans
 * historique.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ouigo = require('../server/connectors/available/ouigo/connector');

const URL_LISTE = 'https://ventes.ouigo.com/fr-FR/user/bookings/past-bookings';

// ---------------------------------------------------------------------------
// 1. La décision — servie, vide, ou rien du tout
// ---------------------------------------------------------------------------

test('l\'onglet vide est reconnu par sa phrase exacte, et c\'est un résultat', () => {
  const etat = ouigo.etatDesReservations({
    url: URL_LISTE,
    // Le relevé d'écran du 14/08/2026, mot pour mot.
    texte: 'Mes voyages  À VENIR  PASSÉS  Vous n\'avez pas de réservation passée.',
    boutonSeConnecter: false,
  });
  assert.equal(etat.servie, true);
  assert.equal(etat.vide, true);
});

test('une redirection hors de la page des réservations ne conclut RIEN', () => {
  // Mesuré : hors session, /user/bookings/past-bookings redirige vers /fr-FR.
  const etat = ouigo.etatDesReservations({
    url: 'https://ventes.ouigo.com/fr-FR',
    texte: 'Billets de train pas chers — réservez vos billets OUIGO',
    boutonSeConnecter: true,
  });
  assert.equal(etat.servie, false, 'l\'accueil n\'est pas la liste des réservations');
});

test('un bouton « Se connecter » sur la page des réservations = session absente', () => {
  const etat = ouigo.etatDesReservations({
    url: URL_LISTE,
    texte: 'Vous n\'avez pas de réservation passée.',
    boutonSeConnecter: true,
  });
  assert.equal(etat.servie, false);
});

test('une page qui ne montre ni réservation ni la phrase du vide ne conclut rien', () => {
  const etat = ouigo.etatDesReservations({
    url: URL_LISTE,
    texte: 'Chargement en cours…',
    boutonSeConnecter: false,
  });
  assert.equal(etat.servie, false, 'un écran d\'attente n\'est pas une liste lue');
  assert.equal(etat.vide, false);
});

test('des réservations affichées sont reconnues comme telles — par leur COMPTE de cartes', () => {
  const etat = ouigo.etatDesReservations({
    url: URL_LISTE,
    texte: 'PASSÉS — N° de réservation ABC123 Paris Nantes Retour le 12/07/2026',
    boutonSeConnecter: false,
    reservations: 5,
  });
  assert.equal(etat.servie, true);
  assert.equal(etat.vide, false);
  assert.equal(etat.reservations, 5);
  assert.match(etat.raison, /5 carte\(s\) « N° de réservation »/,
    'le nombre annoncé est le nombre vu — plus jamais trois lignes qui se contredisent');
});

test('le pied de page marketing (« Billets Paris Lyon ») ne fait plus croire à des réservations', () => {
  // Le défaut mesuré le 19/08/2026 : la liste était servie SANS carte, mais le
  // texte de la page portait les liens du pied de page — « Billets Paris
  // Marseille », « Billets Paris Lyon » — et « billet » suffisait à déclarer
  // « des réservations sont affichées » pendant que le compte rendait 0.
  const etat = ouigo.etatDesReservations({
    url: URL_LISTE,
    texte: 'PASSÉS — Billets Paris Marseille Billets Paris Lyon Référence de dossier, aide et contact',
    boutonSeConnecter: false,
    reservations: 0,
  });
  assert.equal(etat.servie, false, 'sans carte, le vocabulaire du décor ne conclut RIEN');
  assert.equal(etat.vide, false);
  assert.match(etat.raison, /ni carte de réservation/);
});

// ---------------------------------------------------------------------------
// 2. Les règles héritées du module partagé
// ---------------------------------------------------------------------------

test('le bouton d\'e-mail reste interdit de clic, comme chez SNCF Connect', () => {
  const declencheur = (texte) =>
    ouigo.MOTIF_TELECHARGER.test(texte) && !ouigo.MOTIF_ENVOI_EMAIL.test(texte);
  assert.equal(declencheur('Télécharger le justificatif'), true);
  assert.equal(declencheur('Recevoir le justificatif par e-mail'), false);
  assert.equal(declencheur('Envoyer le reçu par courriel'), false);
});

// ---------------------------------------------------------------------------
// 3. Le manifeste — publié sur des preuves, et honnête sur le chemin
// ---------------------------------------------------------------------------

/**
 * Jusqu'au lot 44, ce test verrouillait « pending » : un connecteur ne se
 * déclare pas validé sur une liste vide. La condition est levée depuis —
 * 5 billets récupérés sur 5 réservations réelles, en production, le
 * 20/08/2026 (lot 45). Ce que le test verrouille désormais, c'est l'ENSEMBLE
 * de la publication : le manifeste sans `initialStatus` (le défaut du schéma
 * est « available »), la note qui dit sur quelles preuves, ET la migration 41
 * — sans elle, la ligne de catalogue resterait « pending » pour toujours
 * (« ON CONFLICT DO NOTHING »), quoi que dise le manifeste.
 */
test('le manifeste est publié, dit ses preuves, et la migration 41 aligne le catalogue', () => {
  const manifeste = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'server', 'connectors', 'available', 'ouigo', 'manifest.json'),
      'utf8'
    )
  );
  assert.equal(manifeste.initialStatus, undefined,
    'publié comme Bitstamp : plus d\'initialStatus, le défaut du schéma est « available »');
  assert.match(manifeste.technicalNote, /PUBLIÉ/);
  assert.match(manifeste.technicalNote, /5 billets/);
  // L'histoire reste : la note d'avant-validation est une mesure, pas un brouillon.
  assert.match(manifeste.technicalNote, /JAMAIS VALIDÉ/i);
  assert.match(manifeste.technicalNote, /Vous n'avez pas de réservation passée/);
  assert.equal(manifeste.remoteLogin.persistent, true);
  const session = manifeste.fields.find((f) => f.type === 'session');
  assert.notEqual(session?.required, true);
});

test('la migration 41 fait passer la ligne « pending » du catalogue à « available »', () => {
  const Database = require('better-sqlite3');
  const migrations = require('../server/db/migrations');
  const base = new Database(':memory:');
  base.exec(`CREATE TABLE connector_catalog (
    connector_id TEXT PRIMARY KEY, status TEXT, published_at TEXT, updated_at TEXT
  )`);
  base.prepare(
    "INSERT INTO connector_catalog (connector_id, status) VALUES ('ouigo', 'pending')"
  ).run();

  const m41 = migrations.MIGRATIONS.find((m) => m.id === 41);
  assert.ok(m41, 'la migration 41 existe');
  m41.up(base);

  const ligne = base.prepare(
    "SELECT status, published_at FROM connector_catalog WHERE connector_id = 'ouigo'"
  ).get();
  assert.equal(ligne.status, 'available',
    'sans cette migration, OUIGO resterait invisible à tout compte ordinaire');
  assert.equal(ligne.published_at, null,
    'published_at reste une décision humaine — la migration ne signe pas');
  base.close();
});

// ---------------------------------------------------------------------------
// Lot 37 — la redirection avec « Se connecter » est une SESSION ABSENTE
//
// Mesuré le 18/08/2026 sur le compte réel mesuré : hors session, la page des
// réservations renvoie vers l'accueil /fr-FR, qui propose « Se connecter ».
// Le connecteur disait « une page qui n'est ni vos réservations passées ni un
// espace connecté » — exact mais inutile : le geste attendu est de se
// reconnecter, et le message doit le dire.
// ---------------------------------------------------------------------------

test('renvoyé vers l\'accueil qui propose « Se connecter » : session absente, dite comme telle', () => {
  const etat = ouigo.etatDesReservations({
    url: 'https://ventes.ouigo.com/fr-FR',
    texte: 'OUIGO Mes voyages Se connecter RECHERCHER',
    boutonSeConnecter: true,
  });
  assert.equal(etat.servie, false);
  assert.equal(etat.sessionAbsente, true, 'le verdict doit être la session, pas la page');
  assert.match(etat.raison, /Se connecter/);
});

test('renvoyé ailleurs SANS « Se connecter » : page inconnue, pas une session accusée à tort', () => {
  const etat = ouigo.etatDesReservations({
    url: 'https://ventes.ouigo.com/fr-FR/maintenance',
    texte: 'Le service est momentanément indisponible.',
    boutonSeConnecter: false,
  });
  assert.equal(etat.servie, false);
  assert.notEqual(etat.sessionAbsente, true, 'sans « Se connecter », on ne conclut pas à la session');
});

// ---------------------------------------------------------------------------
// Lot 43 — la page RÉELLE des réservations passées, mesurée le 20/08/2026
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT_OUIGO = playwrightOuNull();
const SANS_NAVIGATEUR_OUIGO = {
  skip: PLAYWRIGHT_OUIGO
    ? false
    : 'Playwright n\'est pas installé sur cette machine : la lecture de la page des '
      + 'réservations n\'est pas jouée. Installez-le avec « npm install playwright && '
      + 'npx playwright install chromium » pour couvrir cette chaîne.',
};

/**
 * La liste des passés, telle que MESURÉE : 5 cartes « N° de réservation »
 * (classes générées, un seul bouton sans libellé par carte), les onglets
 * A VENIR / PASSÉS, et le pied de page marketing qui piégeait l'ancien motif.
 * Références fictives, aucun contenu personnel.
 */
const PAGE_PASSES_MESUREE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>OUIGO</title></head><body>
  <header><button>Mes voyages</button><button>C Camille</button></header>
  <main>
    <a href="/fr-FR/user/bookings/upcoming-bookings">A VENIR</a>
    <a class="active" href="/fr-FR/user/bookings/past-bookings">PASSÉS</a>
    ${[1, 2, 3, 4, 5].map((n) => `
    <div class="sc-fwPIEZ nRIah">
      <div class="sc-iKqsjz eNMRYi">
        <p>N° de réservation FICTIF${n}</p>
        <p>Paris Nantes</p><p>Retour le 0${n}/07/2026</p>
      </div>
      <button class="sc-itktkY iRcpOd" aria-label=""></button>
    </div>`).join('')}
  </main>
  <footer>
    <a href="https://www.ouigo.com/train-paris-marseille">Billets Paris Marseille</a>
    <a href="https://www.ouigo.com/train-paris-lyon">Billets Paris Lyon</a>
    <a href="https://www.ouigo.com/faq">Aide et contact</a>
  </footer>
</body></html>`;

test('la photographie compte les 5 cartes de la page mesurée — le pied de page ne compte pas',
  SANS_NAVIGATEUR_OUIGO, async () => {
    const navigateur = await PLAYWRIGHT_OUIGO.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      await page.goto('about:blank');
      await page.setContent(PAGE_PASSES_MESUREE);
      // `photographier` lit location.href : on la simule sur l'adresse réelle.
      const brut = await page.evaluate(
        ([motifCarte]) => {
          const texte = (document.body?.innerText || '').slice(0, 30_000);
          const reCarte = new RegExp(motifCarte, 'i');
          return {
            texte,
            reservations: [...document.querySelectorAll('*')].filter((el) =>
              reCarte.test(el.innerText || '')
              && ![...el.children].some((enfant) => reCarte.test(enfant.innerText || ''))).length,
          };
        },
        [ouigo.MOTIF_CARTE_RESERVATION.source]
      );
      assert.equal(brut.reservations, 5, 'le nombre compté est le nombre de cartes à l\'écran');

      const etat = ouigo.etatDesReservations({
        url: URL_LISTE,
        texte: brut.texte,
        boutonSeConnecter: false,
        reservations: brut.reservations,
      });
      assert.equal(etat.servie, true);
      assert.equal(etat.reservations, 5);
      assert.match(etat.raison, /5 carte\(s\)/);
    } finally {
      await navigateur.close();
    }
  });

test('renvoyé vers l\'accueil connecté : « Mes voyages » puis « PASSÉS » ramènent sur la liste',
  SANS_NAVIGATEUR_OUIGO, async () => {
    const navigateur = await PLAYWRIGHT_OUIGO.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      // L'accueil /fr-FR d'un compte CONNECTÉ, tel que mesuré le 20/08/2026 :
      // pas de « Se connecter », un bouton « Mes voyages ». Les clics rejouent
      // la navigation de l'application (pushState + rendu). La page est servie
      // par une route simulée pour que l'origine soit réelle — `pushState`
      // exige une origine, `about:blank` n'en a pas.
      await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
      await page.goto('https://ouigo.exemple/fr-FR');
      await page.setContent(`<!doctype html><html><body>
        <header><button id="voyages">Mes voyages</button><button>C Camille</button></header>
        <main id="contenu">Accueil — réservez vos billets</main>
        <script>
          document.getElementById('voyages').addEventListener('click', () => {
            history.pushState({}, '', '/fr-FR/user/bookings/upcoming-bookings');
            document.getElementById('contenu').innerHTML =
              '<a id="passes" href="#">PASSÉS</a><p>Aucun voyage à venir</p>';
            document.getElementById('passes').addEventListener('click', () => {
              history.pushState({}, '', '/fr-FR/user/bookings/past-bookings');
              document.getElementById('contenu').innerHTML +=
                '<div><p>N° de réservation FICTIF9</p><button aria-label=""></button></div>';
            });
          });
        </script>
      </body></html>`);

      await ouigo.ramenerSurLesPasses(page);
      assert.match(page.url(), /\/user\/bookings\/past-bookings/,
        'le geste de l\'utilisateur ramène sur l\'onglet des passés');
      const photo = await ouigo.photographier(page);
      assert.equal(photo.reservations, 1, 'la liste re-servie se photographie normalement');
    } finally {
      await navigateur.close();
    }
  });

test('le connecteur parcourt le chemin mesuré jusqu\'au billet', () => {
  // Le lot 43 disait au journal « un chemin que crabe ne parcourt pas encore ».
  // Le lot 44 l'a mesuré de bout en bout et le parcourt : la promesse et le
  // code doivent bouger ensemble, sans quoi le journal ment dans un sens ou
  // dans l'autre.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'available', 'ouigo', 'connector.js'),
    'utf8'
  );
  assert.equal(/parcourt pas encore/.test(source), false,
    'le connecteur ne doit plus annoncer un chemin qu\'il ne suivrait pas');
  for (const etape of ['ouvrirReservation', 'ouvrirEcranDesBillets',
    'libellesDesPassagers', 'billetDuPassager']) {
    assert.equal(typeof ouigo[etape], 'function', `l'étape ${etape} manque`);
  }
  // Le billet se lit dans l'onglet servi, jamais par un événement « download »
  // — mesuré : il n'en arrive aucun (même mécanique que SNCF Connect).
  assert.match(source, /onglet-pdf/);
  assert.equal(/waitForEvent\('download'/.test(source), false);
});

test('le bouton du passager se reconnaît, la navigation du site est écartée', () => {
  // Les libellés MESURÉS le 20/08/2026 sur l'écran « Téléchargement des
  // billets ». Un seul est le passager ; les trois autres sont le site.
  assert.equal(ouigo.MOTIF_BOUTON_PASSAGER.test('CAMILLE MARCHAND'), true);
  assert.equal(ouigo.MOTIF_BOUTON_PASSAGER.test('Mes voyages'), false);
  assert.equal(ouigo.MOTIF_BOUTON_PASSAGER.test('T le compte réelault'), false);
  assert.equal(ouigo.MOTIF_BOUTON_PASSAGER.test('Accentuer les contrastes'), false);
});

test('un billet regénéré garde son identifiant distant, deux billets ne se confondent pas', () => {
  // Le défaut payé sur SNCF Connect au même lot : six lignes pour trois
  // documents. Ici l'empreinte ignore l'enveloppe datée DÈS LA PREMIÈRE
  // écriture — la fixture rejoue une régénération, pas une copie.
  const corps = (voyage) => `%PDF-1.4\n<</Contents (${voyage})>>${'\n% billet OUIGO'.repeat(900)}\n`;
  const enveloppe = (quand, id) =>
    `<xmp:CreateDate>${quand}</xmp:CreateDate>\ntrailer\n<</CreationDate(D:${id})`
    + `/ID [<${id.padEnd(32, '0')}><${id.padEnd(32, '0')}>]>>\n%%EOF\n`;
  const passage1 = Buffer.from(corps('Paris Nantes') + enveloppe('2026-08-20T01:24:37+02:00', 'aaaaaaaaaaaaaaaa'), 'latin1');
  const passage2 = Buffer.from(corps('Paris Nantes') + enveloppe('2026-08-20T02:09:12+02:00', 'bbbbbbbbbbbbbbbb'), 'latin1');
  const autre = Buffer.from(corps('Nantes Paris') + enveloppe('2026-08-20T02:09:12+02:00', 'bbbbbbbbbbbbbbbb'), 'latin1');

  assert.notEqual(passage1.toString('latin1'), passage2.toString('latin1'));
  assert.equal(ouigo.remoteIdPour(passage1), ouigo.remoteIdPour(passage2));
  assert.notEqual(ouigo.remoteIdPour(passage2), ouigo.remoteIdPour(autre));
  assert.match(ouigo.remoteIdPour(passage1), /^ouigo-[0-9a-f]{16}$/);
});
