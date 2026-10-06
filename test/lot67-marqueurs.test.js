'use strict';

/**
 * Lot 67 — deux connecteurs qui visaient à côté, chacun à sa façon.
 *
 *   - **PayByPhone** écrivait ses dates dans les champs CACHÉS d'ASP.NET, et y
 *     perdait 180 s par mois à attendre qu'un `type=hidden` devienne visible ;
 *   - **Free Mobile** ne pouvait plus prouver sa propre session, faute de lien
 *     de déconnexion dans un espace abonné devenu une application React.
 *
 * Les deux défauts ont la même forme : un marqueur choisi sans être mesuré.
 * Les tests ci-dessous figent la MESURE, pour que la prochaine modification
 * bute dessus.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const paybyphone = require('../server/connectors/available/paybyphone/connector');
const preuve = require('../server/connectors/preuve-connexion');
const manifesteFreeMobile = require('../server/connectors/available/free-mobile/manifest.json');

// ---------------------------------------------------------------------------
// PayByPhone — le sélecteur de période
// ---------------------------------------------------------------------------

/**
 * Les six éléments que le sélecteur attrapait, dans l'ORDRE DU DOM relevé sur
 * `tranrpt1.aspx` le 27/08/2026. C'est l'ordre qui fait le défaut : le
 * connecteur écrit dans `nth(0)` et `nth(1)`.
 */
const CHAMPS_MESURES = [
  { id: '__VIEWSTATE', visible: false },
  { id: 'ctl00_MainContent_GridDisplaySelectionState', visible: false },
  { id: 'ctl00_MainContent_recent_start_date', visible: true },
  { id: 'ctl00_MainContent_recent_end_date', visible: true },
  { id: '__VIEWSTATEGENERATOR', visible: false },
  { id: '__VIEWSTATEENCRYPTED', visible: false },
];

test('PayByPhone : chaque branche du sélecteur de dates exige :visible', () => {
  const branches = paybyphone.SELECTEUR_CHAMPS_DATE.split(',').map((s) => s.trim());
  assert.equal(branches.length, 3);
  for (const branche of branches) {
    assert.ok(
      branche.endsWith(':visible'),
      `« ${branche} » sans :visible ramènerait les champs cachés d'ASP.NET, et avec eux `
        + 'les 45 s d\'attente par écriture qui ont fait les 71 minutes du 26/08'
    );
  }
});

test('PayByPhone : le piège est réel — les champs cachés d\'ASP.NET contiennent bien « ate »', () => {
  // `input[id*="ate" i]` est une recherche de SOUS-CHAÎNE. Ce test fige
  // pourquoi le filtre de visibilité est indispensable : sans lui, ce n'est
  // pas un cas tordu, c'est le cas NOMINAL d'une page WebForms.
  const caches = CHAMPS_MESURES.filter((c) => !c.visible);
  assert.equal(caches.length, 4, 'quatre champs cachés relevés sur la vraie page');
  for (const champ of caches) {
    assert.ok(
      champ.id.toLowerCase().includes('ate'),
      `${champ.id} doit bien matcher [id*="ate" i] — c'est ça, le piège`
    );
  }
});

test('PayByPhone : les deux VRAIS champs ne sont ni en tête ni en queue du DOM', () => {
  const visibles = CHAMPS_MESURES.map((c, i) => ({ ...c, i })).filter((c) => c.visible);
  assert.deepEqual(visibles.map((c) => c.i), [2, 3]);
  // C'est LA raison pour laquelle prendre `nth(0)`/`nth(1)` sur la liste non
  // filtrée ne pouvait pas marcher : les vrais champs sont au milieu.
  assert.notEqual(visibles[0].i, 0, 'nth(0) non filtré tombait sur __VIEWSTATE');
});

// ---------------------------------------------------------------------------
// Free Mobile — la preuve de session
// ---------------------------------------------------------------------------

/** Une page Playwright réduite à ce dont `preuve.verifier()` a besoin. */
function faussePage(url, selecteursPresents = []) {
  return {
    url: () => url,
    locator: (selecteur) => ({
      count: async () => (selecteursPresents.includes(selecteur) ? 1 : 0),
    }),
  };
}

test('Free Mobile : le manifeste déclare verifyUrlTient, et une adresse dont juger la tenue', () => {
  const remote = manifesteFreeMobile.remoteLogin;
  assert.equal(remote.verifyUrlTient, true);
  assert.equal(remote.verifyUrl, 'https://mobile.free.fr/account/v2');
  assert.ok(remote.verifyUrl.startsWith('https://'), 'on y rejoue une session : jamais en clair');
});

test('Free Mobile : l\'espace abonné connecté n\'a AUCUNE preuve forte — d\'où le refus du 27/08', async () => {
  // Mesuré : pas un seul lien de déconnexion dans le document. C'est ce qui
  // faisait échouer l'enregistrement alors que la session était bonne.
  const page = faussePage('https://mobile.free.fr/account/v2', []);
  const resultat = await preuve.verifier(page, { cookies: 8 });

  assert.equal(resultat.surFormulaire, false, 'la page de compte n\'est pas un formulaire');
  assert.deepEqual(resultat.preuvesFortes, []);
  assert.equal(
    resultat.confirme,
    false,
    'les marqueurs génériques seuls ne confirment plus rien ici : c\'est pour ça '
      + 'que le manifeste doit déclarer verifyUrlTient'
  );
});

test('Free Mobile : la page servie à un anonyme est reconnue comme un formulaire', async () => {
  // L'adresse EXACTE mesurée le 27/08 en visiteur anonyme.
  const page = faussePage(
    'https://mobile.free.fr/account/v2/login?redirect=http%3A%2F%2Fmobile.free.fr%2Faccount%2Fv2',
    []
  );
  const resultat = await preuve.verifier(page, { cookies: 0 });

  assert.equal(resultat.surFormulaire, true, 'sans ça, verifyUrlTient laisserait passer un anonyme');
  assert.equal(resultat.confirme, false);
});

test('Free Mobile : le paramètre ?login= d\'une URL normale ne la fait pas passer pour un formulaire', () => {
  // Piège documenté par le connecteur : `?login=…` est un PARAMÈTRE, pas un
  // chemin d'authentification. Le confondre ferait échouer une session saine.
  assert.equal(
    preuve.estUrlAuthentification('https://mobile.free.fr/account/v2?login=12345678'),
    false
  );
  assert.equal(
    preuve.estUrlAuthentification('https://mobile.free.fr/account/v2/login?redirect=x'),
    true
  );
});
