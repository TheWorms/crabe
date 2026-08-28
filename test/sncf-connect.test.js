'use strict';

/**
 * SNCF Connect et le module d'authentification partagé « Mon Identifiant
 * SNCF » (connectors/auth-sncf.js).
 *
 * La page des voyages n'a jamais été vue (mur anti-robot mesuré) : ces tests
 * figent ce qui est figeable sans compte — la reconnaissance de l'écran
 * d'identification mesuré le 14/08/2026, la détection du mur, et LA règle qui
 * ne doit jamais céder : le bouton « Obtenir le justificatif par e-mail »
 * n'est JAMAIS un déclencheur de téléchargement. Le cliquer enverrait un
 * e-mail à l'utilisateur — un geste qui lui appartient.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authSncf = require('../server/connectors/auth-sncf');
const sncf = require('../server/connectors/available/sncf-connect/connector');

// ---------------------------------------------------------------------------
// 1. Le module partagé — l'écran d'identification mesuré
// ---------------------------------------------------------------------------

test('l\'écran « Mon Identifiant SNCF » est reconnu par son adresse', () => {
  // Les deux écrans MESURÉS le 14/08/2026 (adresse bidon, navigateur réel) :
  assert.equal(
    authSncf.estPageAuthentification(
      'https://auth.monidentifiant.sncf/u/login/identifier?state=hKFo2SBN'
    ),
    true
  );
  assert.equal(
    authSncf.estPageAuthentification(
      'https://auth.monidentifiant.sncf/u/login/password?state=hKFo2SBJ'
    ),
    true
  );
  // Le domaine dédié entier, pas seulement auth. :
  assert.equal(authSncf.estPageAuthentification('https://www.monidentifiant.sncf/'), true);
  // Et les pages de service, elles, ne sont PAS des écrans d'identification.
  assert.equal(authSncf.estPageAuthentification('https://www.sncf-connect.com/app/trips'), false);
  assert.equal(
    authSncf.estPageAuthentification('https://ventes.ouigo.com/fr-FR/user/bookings/past-bookings'),
    false
  );
  assert.equal(authSncf.estPageAuthentification('pas-une-url'), false);
});

test('le message du mur anti-robot dit le geste, pas la technologie', () => {
  const message = authSncf.messageMur('SNCF Connect');
  assert.match(message, /Rouvrez la connexion/);
  assert.match(message, /vos identifiants n'y sont pour rien/);
  assert.equal(/datadome|captcha-delivery/i.test(message), false, 'pas de jargon à l\'écran');
});

test('une session absente porte le drapeau sessionExpired et le geste à faire', () => {
  const err = authSncf.erreurSessionExpiree('OUIGO', 'aucun profil');
  assert.equal(err.sessionExpired, true);
  assert.match(err.message, /Se connecter/);
  assert.match(err.message, /relancez la récupération/);
});

// ---------------------------------------------------------------------------
// 2. La règle des deux justificatifs
// ---------------------------------------------------------------------------

test('« Obtenir le justificatif par e-mail » n\'est JAMAIS un déclencheur de téléchargement', () => {
  // Les libellés exacts du relevé d'écran du 14/08/2026.
  const parEmail = 'Obtenir le justificatif par e-mail';
  const direct = 'Télécharger votre justificatif';

  // Le filtre injecté dans la page est : télécharger ET PAS e-mail.
  const declencheur = (texte) =>
    sncf.MOTIF_TELECHARGER.test(texte) && !sncf.MOTIF_ENVOI_EMAIL.test(texte);

  assert.equal(declencheur(direct), true, 'le justificatif de voyage doit se télécharger');
  assert.equal(declencheur(parEmail), false, 'cliquer ce bouton enverrait un e-mail');
  // Même un libellé hybride reste interdit dès qu'il parle d'e-mail.
  assert.equal(declencheur('Télécharger par e-mail'), false);
  assert.equal(declencheur('Recevoir par courriel'), false);
});

test('le rappel du justificatif d\'achat donne le chemin exact, et la promesse de ne rien envoyer', () => {
  assert.match(sncf.RAPPEL_ACHAT, /Mes voyages/);
  assert.match(sncf.RAPPEL_ACHAT, /Vos justificatifs/);
  assert.match(sncf.RAPPEL_ACHAT, /Obtenir le justificatif par e-mail/);
  assert.match(sncf.RAPPEL_ACHAT, /ne déclenche\s+jamais/i);
});

test('le nom de fichier dit « justificatif-voyage » — jamais « facture »', () => {
  // La règle du cahier des charges : ne pas faire passer le justificatif de
  // voyage pour une facture. Le nom du fichier est le premier endroit où le
  // mensonge pourrait s'installer.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'available', 'sncf-connect', 'connector.js'),
    'utf8'
  );
  assert.match(source, /justificatif-voyage/);
  assert.equal(/filename:\s*`[^`]*facture/i.test(source), false);
});

// ---------------------------------------------------------------------------
// 3. L'identifiant distant — l'empreinte du document
// ---------------------------------------------------------------------------

test('l\'identifiant distant est stable pour un même document, distinct sinon', () => {
  const a = Buffer.from('%PDF-1.4 justificatif A');
  const b = Buffer.from('%PDF-1.4 justificatif B');
  assert.equal(sncf.remoteIdPour(a), sncf.remoteIdPour(Buffer.from(a)));
  assert.notEqual(sncf.remoteIdPour(a), sncf.remoteIdPour(b));
  assert.match(sncf.remoteIdPour(a), /^sncf-connect-[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------------------
// 4. Le manifeste — en attente, profil persistant, session jamais requise
// ---------------------------------------------------------------------------

test('le manifeste déclare pending, un profil persistant, et le rappel de l\'achat à l\'écran', () => {
  const manifeste = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'server', 'connectors', 'available', 'sncf-connect', 'manifest.json'),
      'utf8'
    )
  );
  assert.equal(manifeste.initialStatus, 'pending', 'jamais exercé contre un compte réel');
  assert.equal(manifeste.remoteLogin.persistent, true, 'la levée du mur voyage avec le profil');
  const session = manifeste.fields.find((f) => f.type === 'session');
  assert.ok(session, 'la connexion passe par la fenêtre visible');
  assert.notEqual(session.required, true, 'le piège du champ de session obligatoire (lot 26)');
  // Le rappel exigé « dans l'interface » : l'aide de la fiche porte le chemin.
  assert.match(session.help, /justificatif d'ACHAT/i);
  assert.match(session.help, /Obtenir le justificatif par e-mail/);
});

// ---------------------------------------------------------------------------
// Lot 37 — la version déconnectée de la page des voyages est une SESSION
// ABSENTE, jamais un « onglet non reconnu »
//
// Mesuré le 18/08/2026 : session tombée, /app/trips atterrit sur /trips
// « Billets et titres », avec des boutons « Se connecter » / « Créer un
// compte » — et évidemment aucun onglet « Passés ».
// ---------------------------------------------------------------------------

test('une page qui propose « Se connecter » est vue comme déconnectée', async () => {
  const pageDeconnectee = { evaluate: async () => true };
  const pageConnectee = { evaluate: async () => false };
  const pageIllisible = { evaluate: async () => { throw new Error('détachée'); } };
  assert.equal(await sncf.paraitDeconnecte(pageDeconnectee), true);
  assert.equal(await sncf.paraitDeconnecte(pageConnectee), false);
  assert.equal(await sncf.paraitDeconnecte(pageIllisible), false, 'l\'illisible ne conclut pas');
});

// ---------------------------------------------------------------------------
// Le verrou de profil, côté récupération (lot 43) — le pendant du refus de la
// fenêtre (voir test/remote-browser.test.js) : mesuré le 19/08/2026 à 23:39,
// les deux chemins se disputaient le même profil persistant.
// ---------------------------------------------------------------------------

test('récupération pendant que la fenêtre « Se connecter » tient le profil : refus dit, rien lancé', async () => {
  const inflight = require('../server/connectors/inflight');
  const profilPersistant = require('../server/connectors/profil-persistant');
  // Un profil qui EXISTE — sinon c'est la session expirée qui parlerait.
  const dossier = profilPersistant.preparer(31, 'sncf-connect');
  const cle = inflight.profilKey(31, 'sncf-connect');
  inflight.profil.acquire(cle, inflight.PORTEUR_FENETRE);
  try {
    await assert.rejects(
      () => authSncf.surLeProfil(
        { id: 'sncf-connect', nom: 'SNCF Connect', ctx: { userId: 31 }, urlDepart: 'https://exemple.invalid/' },
        async () => { throw new Error('le navigateur ne doit JAMAIS s\'ouvrir ici'); }
      ),
      (err) => {
        assert.match(err.message, /La fenêtre « Se connecter à SNCF Connect » est ouverte sur ce serveur/);
        assert.match(err.message, /Terminez-la ou annulez-la/);
        // Jamais le message brut de Playwright ni un nom de navigateur.
        assert.doesNotMatch(err.message, /launchPersistentContext|browserType|chromium|profile is already in use/i);
        return true;
      }
    );

    // Une AUTRE récupération tient le profil : le refus dit quoi attendre.
    inflight.profil.release(cle);
    inflight.profil.acquire(cle, inflight.PORTEUR_RECUPERATION);
    await assert.rejects(
      () => authSncf.surLeProfil(
        { id: 'sncf-connect', nom: 'SNCF Connect', ctx: { userId: 31 }, urlDepart: 'https://exemple.invalid/' },
        async () => { throw new Error('le navigateur ne doit JAMAIS s\'ouvrir ici'); }
      ),
      (err) => {
        assert.match(err.message, /Une récupération SNCF Connect est déjà en cours sur ce serveur/);
        assert.match(err.message, /Attendez qu'elle se termine/);
        return true;
      }
    );
  } finally {
    inflight.profil.release(cle);
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('le code vérifie la session AVANT de chercher l\'onglet « Passés »', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const source = fs2.readFileSync(
    path2.join(__dirname, '..', 'server', 'connectors', 'available', 'sncf-connect', 'connector.js'),
    'utf8'
  );
  // Dans les deux parcours (test et récupération), paraitDeconnecte précède
  // la recherche d'onglet : si quelqu'un inverse ou retire le contrôle,
  // l'échec du 17-18/08 revient — « onglet non reconnu » sur une page
  // déconnectée.
  for (const fonction of ['async function test', 'async function fetchInvoices']) {
    const debut = source.indexOf(fonction);
    assert.ok(debut !== -1, fonction);
    const corps = source.slice(debut, source.indexOf('async function', debut + 10));
    const posSession = corps.indexOf('paraitDeconnecte(page)');
    const posOnglet = corps.indexOf('ouvrirOngletPasses(page)');
    assert.ok(posOnglet !== -1, `l'onglet est cherché dans ${fonction}`);
    assert.ok(
      posSession !== -1 && posSession < posOnglet,
      `la session se vérifie d'abord dans ${fonction}`
    );
  }
});

test('un voyage sans téléchargement décrit ses boutons — chiffres masqués, dédoublonnés, bornés', () => {
  // Le « 0 sur 11 » du 18/08/2026 : sans cette description, le journal ne
  // disait pas ce que le panneau montrait, et la question « le bouton
  // existe-t-il encore ? » restait une supposition. Ce test tombe si la
  // description disparaît, laisse passer un chiffre (une date, un numéro de
  // dossier), ou enfle sans borne.
  const texte = sncf.decrireDeclencheurs([
    'Télécharger votre justificatif',
    'Télécharger votre justificatif',
    'Obtenir le justificatif par e-mail',
    ' Voyage  du 12/07/2026 ',
    '',
  ]);
  assert.match(texte, /« Télécharger votre justificatif »/);
  assert.equal((texte.match(/Télécharger votre justificatif/g) || []).length, 1, 'dédoublonné');
  assert.match(texte, /Voyage du ##\/##\/####/, 'les chiffres sont masqués');
  assert.equal(/\d/.test(texte), false, 'aucun chiffre ne part au journal');

  assert.equal(sncf.decrireDeclencheurs([]), 'aucun bouton visible');
  assert.equal(sncf.decrireDeclencheurs(null), 'aucun bouton visible');

  const beaucoup = sncf.decrireDeclencheurs(
    Array.from({ length: 50 }, (_, i) => `Bouton ${'x'.repeat(i + 1)}`)
  );
  assert.ok(beaucoup.split(' | ').length <= 20, 'borné en nombre');

  const long = sncf.decrireDeclencheurs(['y'.repeat(200)]);
  assert.ok(long.length < 80, 'borné en longueur');
});

test('le connecteur journalise le panneau de CHAQUE voyage sans téléchargement', () => {
  // La ligne de journal est dans le code du parcours : si quelqu'un la retire,
  // le « 0 sur N » redevient muet et ce test tombe.
  const source = fs.readFileSync(
    path.join(__dirname, '../server/connectors/available/sncf-connect/connector.js'),
    'utf8'
  );
  assert.match(source, /panneau « Vos justificatifs » ouvert, aucun déclencheur/);
  assert.match(source, /decrireDeclencheurs\(panneau\.libelles\)/);
  assert.match(source, /panneau « Vos justificatifs » introuvable/);
});

// ---------------------------------------------------------------------------
// 4. L'échec de téléchargement RACONTE (lot 42)
// ---------------------------------------------------------------------------

/**
 * Le 18/08/2026, les voyages 1, 2 et 4 ont écrit « un téléchargement n'a pas
 * abouti, on continue » — et rien d'autre. Un déclencheur EXISTE, le
 * téléchargement ÉCHOUE, et rien ne dit pourquoi. Ces tests exigent que chaque
 * échec nomme TROIS choses : le déclencheur cliqué, ce qui a été tenté, et le
 * grief exact. Ce lot mesure ; il ne répare pas le téléchargement.
 */

/** Le bouton mesuré dans le panneau « Vos justificatifs ». */
const BOUTON_TELECHARGER = {
  texte: 'Télécharger votre justificatif',
  balise: 'button',
  cible: '',
  lien: '',
};

/**
 * Une page Playwright simulée pour le téléchargement : on pilote ce que le
 * clic trouve, ce que l'attente rend, et ce que le contexte voit passer.
 */
function fakePageTelechargement({
  clique = BOUTON_TELECHARGER,
  download = null,
  erreurAttente = null,
  popup = null,
  urlApres = null,
} = {}) {
  const urlDepart = 'https://www.sncf-connect.com/app/trips/detail?dossier=ABC123';
  let url = urlDepart;
  const ecouteurs = [];
  return {
    url: () => url,
    context: () => ({
      on: (evenement, fn) => {
        ecouteurs.push([evenement, fn]);
        // Le nouvel onglet, s'il y en a un, arrive juste après le clic.
        if (evenement === 'page' && popup) setImmediate(() => fn(popup));
      },
      off: () => {},
    }),
    evaluate: async () => {
      if (urlApres) url = urlApres;
      return clique;
    },
    waitForEvent: async () => {
      // Laisse le temps à l'écouteur « page » de recevoir le popup simulé.
      await new Promise((r) => setImmediate(r));
      if (erreurAttente) throw erreurAttente;
      // Le cas RÉEL mesuré le 20/08/2026 : le fichier n'arrive JAMAIS — ni
      // succès, ni timeout pendant le test. C'est la course avec l'onglet qui
      // doit conclure.
      if (download === 'jamais') return new Promise(() => {});
      if (!download) throw Object.assign(new Error('Timeout 45000ms exceeded.'), { name: 'TimeoutError' });
      return download;
    },
  };
}

/** Un téléchargement Playwright simulé, dont le contenu se pilote. */
function fakeDownload({ octets = Buffer.from('%PDF-1.4 justificatif'), echec = null, nom = 'justificatif.pdf' } = {}) {
  return {
    failure: async () => echec,
    suggestedFilename: () => nom,
    createReadStream: async () => (async function* () { yield octets; })(),
  };
}

test('un téléchargement qui aboutit rend le PDF, et dit quel bouton l\'a produit', async () => {
  const page = fakePageTelechargement({ download: fakeDownload() });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, true);
  assert.equal(obtenu.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(obtenu.libelle, 'Télécharger votre justificatif');
  assert.equal(obtenu.grief, null);
});

test('délai dépassé : le grief nomme le délai, et la tentative dit ce qui s\'est passé', async () => {
  const page = fakePageTelechargement({ download: null });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, false);
  assert.equal(obtenu.libelle, 'Télécharger votre justificatif');
  assert.match(obtenu.grief, /aucun fichier n'est arrivé dans le délai de \d+ secondes/);
  assert.match(obtenu.tentative, /clic sur un bouton/);
  assert.match(obtenu.tentative, /aucun nouvel onglet/);
  assert.match(obtenu.tentative, /la page n'a pas changé d'adresse/);
});

/**
 * L'onglet mesuré le 20/08/2026 : « Télécharger votre justificatif » ouvre
 * `monbillet.sncf/e-billet`, qui sert DIRECTEMENT le PDF. La réponse et le
 * document se pilotent ici.
 */
function fakeOngletPdf({
  octets = Buffer.from('%PDF-1.4 justificatif servi dans l\'onglet'),
  contentType = 'application/pdf',
} = {}) {
  const gestes = [];
  return {
    _gestes: gestes,
    url: () => 'https://monbillet.sncf/e-billet?token=SECRET-ONGLET',
    waitForLoadState: async () => {},
    evaluate: async () => contentType,
    close: async () => { gestes.push('fermé'); },
    on: (evenement, fn) => {
      if (evenement !== 'response') return;
      // La réponse du document principal arrive juste après l'ouverture.
      setImmediate(() => fn({
        headerValue: async () => contentType,
        body: async () => octets,
        url: () => 'https://monbillet.sncf/e-billet?token=SECRET-ONGLET',
      }));
    },
  };
}

test('le PDF servi dans un onglet est LU depuis sa réponse — sans attendre un téléchargement fantôme', async () => {
  const onglet = fakeOngletPdf();
  // `download: 'jamais'` : l'événement « download » ne viendra JAMAIS (le cas
  // réel). Si la course onglet/téléchargement disparaissait, ce test ne se
  // terminerait pas — c'est sa morsure.
  const page = fakePageTelechargement({ download: 'jamais', popup: onglet });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, true);
  assert.equal(obtenu.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(obtenu.grief, null);
  assert.match(obtenu.tentative, /lu depuis la réponse de l'onglet/);
  assert.match(obtenu.tentative, /monbillet\.sncf/);
  assert.match(obtenu.tentative, /l'onglet a été refermé/);
  assert.ok(onglet._gestes.includes('fermé'), 'l\'onglet est réellement refermé');
  const tout = `${obtenu.libelle} ${obtenu.tentative}`;
  assert.equal(tout.includes('SECRET-ONGLET'), false, 'le jeton de l\'adresse ne sort pas');
  assert.equal(tout.includes('token='), false, 'la requête de l\'adresse reste dehors');
});

test('un onglet qui ne sert pas un PDF : le grief le dit, l\'onglet est refermé, rien n\'est déposé', async () => {
  const onglet = fakeOngletPdf({ contentType: 'text/html' });
  const page = fakePageTelechargement({ download: null, popup: onglet });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, false);
  assert.match(obtenu.grief, /l'onglet ouvert n'a pas donné le document/);
  assert.match(obtenu.grief, /pas un PDF/);
  assert.ok(onglet._gestes.includes('fermé'), 'l\'onglet est refermé même sur échec');
});

test('un nouvel onglet et une navigation sont DITS — sans jamais la requête de l\'adresse', async () => {
  const page = fakePageTelechargement({
    download: null,
    popup: { url: () => 'https://www.sncf-connect.com/pdf/justificatif?token=SECRET-A-NE-PAS-DIRE' },
    urlApres: 'https://www.sncf-connect.com/app/trips/justificatif?dossier=ABC123',
  });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.match(obtenu.tentative, /un nouvel onglet s'est ouvert/);
  assert.match(obtenu.tentative, /la page a navigué vers/);
  const tout = `${obtenu.libelle} ${obtenu.tentative} ${obtenu.grief}`;
  assert.equal(tout.includes('SECRET-A-NE-PAS-DIRE'), false, 'aucun jeton ne part au journal');
  assert.equal(tout.includes('token='), false, 'la requête de l\'adresse reste dehors');
  assert.equal(tout.includes('ABC123'), false, 'aucun numéro de dossier non plus');
});

test('le site interrompt le téléchargement : son grief est repris tel quel', async () => {
  const page = fakePageTelechargement({ download: fakeDownload({ echec: 'net::ERR_ABORTED' }) });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, false);
  assert.match(obtenu.grief, /le site a interrompu le téléchargement/);
  assert.match(obtenu.grief, /ERR_ABORTED/);
});

test('un fichier reçu qui n\'est pas un PDF : le grief dit ce qui est arrivé', async () => {
  const page = fakePageTelechargement({
    download: fakeDownload({ octets: Buffer.from('<!doctype html><html>Erreur</html>') }),
  });
  const obtenu = await sncf.telechargerJustificatif(page, 0);

  assert.equal(obtenu.ok, false);
  assert.match(obtenu.grief, /n'est pas un PDF/);
  assert.match(obtenu.grief, /octets, commence par/);
});

test('le déclencheur a disparu entre le relevé et le clic : c\'est dit, pas deviné', async () => {
  const page = fakePageTelechargement({ clique: null });
  const obtenu = await sncf.telechargerJustificatif(page, 2);

  assert.equal(obtenu.ok, false);
  assert.equal(obtenu.libelle, 'déclencheur introuvable');
  assert.match(obtenu.tentative, /aucun clic/);
  assert.match(obtenu.grief, /ne portait plus de 3ᵉ déclencheur/);
});

test('le parcours écrit le grief au journal — jamais « on continue » tout seul', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../server/connectors/available/sncf-connect/connector.js'),
    'utf8'
  );
  assert.match(source, /Déclencheur : « \$\{obtenu\.libelle\} »/);
  assert.match(source, /Tenté : \$\{obtenu\.tentative\}/);
  assert.match(source, /Grief : \$\{obtenu\.grief\}/);
  // La ligne muette du lot 41 ne doit pas revenir.
  assert.equal(/un téléchargement n'a pas abouti, on continue\.`/.test(source), false);
});

// ---------------------------------------------------------------------------
// 5. « Boutons visibles » vise le PANNEAU, pas le site entier (lot 42)
// ---------------------------------------------------------------------------

/**
 * Le 18/08/2026, le journal listait sous « Boutons visibles » les entrées du
 * MENU DU SITE — « Billets de train », « Hôtels », « Info trafic » — et pas
 * les boutons du panneau « Vos justificatifs » : l'instrumentation mesurait
 * le mauvais périmètre. Ce test joue la lecture dans un vrai navigateur, sur
 * un document qui porte les deux, et exige que seuls les boutons du panneau
 * ressortent.
 */
function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT_SNCF = playwrightOuNull();
const SANS_NAVIGATEUR_SNCF = {
  skip: PLAYWRIGHT_SNCF
    ? false
    : 'Playwright n\'est pas installé sur cette machine : la lecture du panneau n\'est '
      + 'pas jouée. Installez-le avec « npm install playwright && npx playwright install '
      + 'chromium » pour couvrir cette chaîne.',
};

/** Un détail de voyage : le menu du site, puis le panneau des justificatifs. */
const PAGE_DETAIL_VOYAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Votre voyage - SNCF Connect</title></head><body>
  <header><nav>
    <a href="/train">Billets de train</a><a href="/hotels">Hôtels</a>
    <a href="/trafic">Info trafic</a><button>Mon compte</button>
  </nav></header>
  <main>
    <h1>Paris → Lyon</h1>
    <button>Voir le détail du voyage</button>
    <section class="panneau">
      <h2>Vos justificatifs</h2>
      <div class="lignes">
        <button>Télécharger votre justificatif</button>
        <button>Obtenir le justificatif par e-mail</button>
      </div>
    </section>
  </main>
  <footer><a href="/aide">Aide</a><a href="/cgv">Conditions générales</a></footer>
</body></html>`;

test('les « Boutons visibles » sont ceux du panneau, jamais ceux du menu du site',
  SANS_NAVIGATEUR_SNCF, async () => {
    const navigateur = await PLAYWRIGHT_SNCF.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      await page.setContent(PAGE_DETAIL_VOYAGE);

      const panneau = await page.evaluate(sncf.LIRE_PANNEAU, {
        titre: sncf.MOTIF_JUSTIFICATIFS.source,
        telech: sncf.MOTIF_TELECHARGER.source,
        email: sncf.MOTIF_ENVOI_EMAIL.source,
      });

      assert.equal(panneau.perimetre, 'panneau « Vos justificatifs »',
        'la collecte doit être bornée, et le journal doit pouvoir le dire');
      assert.deepEqual(panneau.libelles,
        ['Télécharger votre justificatif', 'Obtenir le justificatif par e-mail'],
        'seuls les boutons du panneau sont listés');
      assert.equal(panneau.telechargements, 1);
      assert.equal(panneau.parEmail, 1);

      // Le défaut exact du 18/08/2026 : le menu du site dans le journal.
      const texte = sncf.decrireDeclencheurs(panneau.libelles);
      for (const intrus of ['Billets de train', 'Hôtels', 'Info trafic', 'Mon compte',
        'Aide', 'Conditions générales', 'Voir le détail du voyage']) {
        assert.equal(texte.includes(intrus), false, `« ${intrus} » n'a rien à faire dans le journal`);
      }
      assert.match(texte, /« Télécharger votre justificatif »/);
    } finally {
      await navigateur.close();
    }
  });

test('un panneau introuvable retombe sur le document ENTIER — et le dit',
  SANS_NAVIGATEUR_SNCF, async () => {
    const navigateur = await PLAYWRIGHT_SNCF.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      // Le titre du panneau est là, mais aucun déclencheur ne l'accompagne :
      // le bornage échoue, et le journal ne doit pas prétendre le contraire.
      await page.setContent(`<!doctype html><html><body>
        <header><nav><a href="/train">Billets de train</a></nav></header>
        <main><h2>Vos justificatifs</h2><p>Aucun document pour ce voyage.</p></main>
      </body></html>`);

      const panneau = await page.evaluate(sncf.LIRE_PANNEAU, {
        titre: sncf.MOTIF_JUSTIFICATIFS.source,
        telech: sncf.MOTIF_TELECHARGER.source,
        email: sncf.MOTIF_ENVOI_EMAIL.source,
      });

      assert.equal(panneau.perimetre, 'document entier (panneau non borné)');
      assert.equal(panneau.telechargements, 0);
    } finally {
      await navigateur.close();
    }
  });

/**
 * La page RÉELLE, mesurée le 20/08/2026 par sonde sur une session réelle :
 * le panneau « Vos justificatifs » est un TIROIR MUI rendu en PORTAIL,
 * directement sous body (`div[role="dialog"][aria-modal="true"]`, classes
 * `MuiDrawer-paper…`). Le titre le plus profond de la page vit AILLEURS (dans
 * le `tabpanel` du détail), et la remontée du lot 42 croisait la navigation
 * avant tout déclencheur : « document entier (panneau non borné) ». Ce DOM-ci
 * reproduit cette structure : balises, rôles et classes relevés, aucun
 * contenu personnel.
 */
const PAGE_DETAIL_TIROIR_MUI = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Votre voyage - SNCF Connect</title></head><body>
  <div id="racine">
    <header><nav>
      <a href="/train">Billets de train</a><a href="/hotels">Hôtels</a>
      <a href="/trafic">Info trafic</a><button>Mon compte</button>
    </nav></header>
    <main role="main" class="css-3bq6eb">
      <h1>Paris → Lyon</h1>
      <div role="tabpanel" data-test="panel-INWARD" class="">
        <div class="MuiContainer-root MuiContainer-maxWidthXl">
          <div class="MuiGrid-root MuiGrid-container">
            <div class="MuiGrid-root MuiGrid-grid-md-8">
              <h2 class="MuiTypography-root MuiTypography-h3">Vos justificatifs</h2>
              <p>Retrouvez ici les justificatifs de votre trajet retour.</p>
            </div>
          </div>
        </div>
      </div>
    </main>
    <footer><a href="/aide">Aide</a><a href="/cgv">Conditions générales</a></footer>
  </div>
  <div class="MuiDrawer-root MuiDrawer-anchorRight MuiDrawer-modal MuiModal-root">
    <div class="MuiPaper-root MuiDrawer-paper" role="dialog" aria-modal="true">
      <h2 class="MuiTypography-root MuiTypography-h3">Vos justificatifs</h2>
      <div class="css-1s291sm">
        <div class="MuiPaper-root MuiCard-root">
          <button class="MuiButtonBase-root MuiCardActionArea-root" type="button">Obtenir le justificatif par e-mail</button>
        </div>
        <div class="css-j7qwjs">
          <a class="MuiButtonBase-root MuiButton-root MuiButton-contained" target="_blank"
             rel="noopener" href="https://monbillet.sncf/e-billet?dossier=XY12">Télécharger votre justificatif</a>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

test('le panneau en TIROIR (portail sous body, page mesurée le 20/08) est borné, et le périmètre le dit',
  SANS_NAVIGATEUR_SNCF, async () => {
    const navigateur = await PLAYWRIGHT_SNCF.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      await page.setContent(PAGE_DETAIL_TIROIR_MUI);

      const panneau = await page.evaluate(sncf.LIRE_PANNEAU, {
        titre: sncf.MOTIF_JUSTIFICATIFS.source,
        telech: sncf.MOTIF_TELECHARGER.source,
        email: sncf.MOTIF_ENVOI_EMAIL.source,
      });

      assert.equal(panneau.perimetre, 'panneau « Vos justificatifs »',
        'le tiroir MUI est reconnu comme LE panneau — le défaut du 19/08 est réparé');
      assert.deepEqual(panneau.libelles,
        ['Obtenir le justificatif par e-mail', 'Télécharger votre justificatif'],
        'seuls les boutons du tiroir sont listés');
      assert.equal(panneau.telechargements, 1);
      assert.equal(panneau.parEmail, 1);

      const texte = sncf.decrireDeclencheurs(panneau.libelles);
      for (const intrus of ['Billets de train', 'Hôtels', 'Info trafic', 'Mon compte',
        'Aide', 'Conditions générales']) {
        assert.equal(texte.includes(intrus), false, `« ${intrus} » n'a rien à faire dans le journal`);
      }
    } finally {
      await navigateur.close();
    }
  });

test('le journal dit sur QUEL périmètre il a compté', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../server/connectors/available/sncf-connect/connector.js'),
    'utf8'
  );
  assert.match(source, /Boutons visibles \(\$\{panneau\.perimetre/);
});

// ---------------------------------------------------------------------------
// 6. Le clic supplémentaire « Accéder à vos justificatifs » (lot 45)
// ---------------------------------------------------------------------------

/**
 * Mesuré la nuit du 20/08/2026 sur les voyages 3 et 5 : le panneau ne porte
 * d'abord AUCUN déclencheur de téléchargement, seulement « Accéder à vos
 * justificatifs » — qui ne navigue nulle part et fait APPARAÎTRE
 * « Télécharger votre justificatif » dans le même panneau.
 *
 * ⚠ Le libellé « Accéder » est écrit ici en NFD (e + ́ combinant), parce que
 * la page sert parfois ses accents décomposés : un motif `/acc[ée]der/` testé
 * sur le texte brut ne matche PAS cette forme — le ́ s'intercale entre le e et
 * le d. Le connecteur doit normaliser en NFC avant le motif, et ce test échoue
 * si cette normalisation disparaît.
 */
const ACCEDER_NFD = 'Accéder à vos justificatifs';
const PAGE_VOYAGE_ACCEDER = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Votre voyage - SNCF Connect</title></head><body>
  <header><nav><a href="/train">Billets de train</a><button>Mon compte</button></nav></header>
  <main>
    <h1>Paris → Lyon</h1>
    <button>Vos justificatifs</button>
  </main>
  <div class="MuiDrawer-root MuiDrawer-modal">
    <div class="MuiPaper-root MuiDrawer-paper" role="dialog" aria-modal="true">
      <h2>Vos justificatifs</h2>
      <div id="lignes">
        <button>Obtenir le justificatif par e-mail</button>
        <button id="acceder" type="button">${ACCEDER_NFD}</button>
      </div>
    </div>
  </div>
  <script>
    document.getElementById('acceder').addEventListener('click', () => {
      const lien = document.createElement('a');
      lien.href = 'https://monbillet.sncf/e-billet?dossier=XY34';
      lien.target = '_blank';
      lien.textContent = 'Télécharger votre justificatif';
      document.getElementById('lignes').appendChild(lien);
    });
  </script>
</body></html>`;

test('« Accéder à vos justificatifs » (en NFD) est cliqué, et le téléchargement apparaît',
  SANS_NAVIGATEUR_SNCF, async () => {
    const navigateur = await PLAYWRIGHT_SNCF.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      await page.setContent(PAGE_VOYAGE_ACCEDER);

      const panneau = await sncf.releverJustificatifs(page);

      assert.equal(panneau.ouvert, true);
      assert.equal(panneau.clicSupplementaire, true,
        'le compte rendu dit que le chemin est passé par le clic supplémentaire');
      assert.equal(panneau.telechargements, 1,
        'le déclencheur apparu après le clic est compté');
      assert.equal(panneau.parEmail, 1, 'le bouton d\'e-mail reste vu — et jamais cliqué');
      assert.match(panneau.libelles.join(' | '), /Télécharger votre justificatif/);
    } finally {
      await navigateur.close();
    }
  });

/** Le même voyage, mais dont le panneau offre le téléchargement d'emblée. */
const PAGE_VOYAGE_DIRECT = PAGE_VOYAGE_ACCEDER.replace(
  `<button id="acceder" type="button">${ACCEDER_NFD}</button>`,
  '<a href="https://monbillet.sncf/e-billet?dossier=XY56" target="_blank">Télécharger votre justificatif</a>'
);

test('un panneau qui offre déjà le téléchargement ne subit AUCUN clic supplémentaire',
  SANS_NAVIGATEUR_SNCF, async () => {
    const navigateur = await PLAYWRIGHT_SNCF.chromium.launch({ headless: true });
    try {
      const page = await navigateur.newPage();
      await page.setContent(PAGE_VOYAGE_DIRECT);

      const panneau = await sncf.releverJustificatifs(page);

      assert.equal(panneau.telechargements, 1);
      assert.equal(panneau.clicSupplementaire, false,
        'le chemin direct reste le chemin direct : pas de clic en trop');
    } finally {
      await navigateur.close();
    }
  });

test('« Accéder » n\'est jamais confondu avec un envoi d\'e-mail', () => {
  // Le garde-fou absolu du connecteur vaut aussi pour le nouveau chemin : un
  // bouton qui parle d'e-mail n'est JAMAIS cliqué, même s'il parle d'accès.
  const libelle = 'Accéder au justificatif par e-mail';
  assert.equal(sncf.MOTIF_ACCEDER.test(libelle) && !sncf.MOTIF_ENVOI_EMAIL.test(libelle), false);
});

test('le message final dit le plafond réel — jamais une panne déguisée', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../server/connectors/available/sncf-connect/connector.js'),
    'utf8'
  );
  // Les deux phrases qui portent la vérité du « 5 sur 11 » : le nombre de
  // voyages qui OFFRENT le téléchargement, et le fait que l'e-mail seul n'est
  // pas une panne. L'empreinte, elle, reste celle du lot 44 : le chemin du
  // clic supplémentaire aboutit au même `remoteIdPour`, dans la même boucle —
  // deux passages n'écrivent toujours qu'une ligne (test/lot44-idempotence).
  // ⚠ Les apostrophes du source sont échappées (`n\'est`) : le motif accepte
  // les deux formes — le piège connu des ancres cherchées dans un fichier JS.
  assert.match(source, /offrent le téléchargement direct/);
  assert.match(source, /plafond réel/);
  assert.match(source, /ce n\\?'est pas une panne/);
});
