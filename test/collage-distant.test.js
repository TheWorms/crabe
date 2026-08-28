'use strict';

/**
 * Le champ « Coller un texte » — vérifié dans un VRAI navigateur.
 *
 * ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * Ce champ a été demandé aux lots 8, 10 et 12. Il a été livré trois fois, et
 * trois fois il n'a rien saisi. La raison est la même à chaque fois : **rien ne
 * vérifiait que le texte arrivait**. Les tests posaient un double de page dont
 * la méthode `keyboard.type()` ne faisait rien, constataient qu'elle n'avait pas
 * levé d'exception, et concluaient au succès — exactement ce que faisait
 * l'interface devant l'utilisateur.
 *
 * Ici, `page` est une **vraie page Chromium** avec un **vrai formulaire**. Le
 * code de production frappe dedans, et on relit la valeur du champ. Si la
 * saisie ne passe pas, ces tests échouent.
 *
 * ─── Ce que ce fichier prouve, et ce qu'il ne prouve pas ─────────────────────
 *
 * PROUVÉ : le texte, caractères spéciaux et majuscules compris, arrive dans le
 * champ actif de la page pilotée ; l'absence de champ actif est détectée et dit
 * quoi faire ; un échec n'est jamais annoncé comme un succès ; rien du texte
 * n'entre dans un journal.
 *
 * PAS PROUVÉ : que l'image arrive à l'écran par le flux VNC, ni que le clic de
 * l'utilisateur dans la fenêtre distante donne bien le focus au champ visé.
 * Cela ne s'observe qu'à l'œil, sur le LXC. Voir PROGRESS.md.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');

// ---------------------------------------------------------------------------
// Playwright est-il utilisable ici ?
// ---------------------------------------------------------------------------

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT
    ? false
    : 'Playwright n\'est pas installé : la saisie dans la fenêtre distante n\'est pas '
      + 'vérifiée sur cette machine.',
};

/**
 * Un mot de passe qui contient TOUT ce qu'un gestionnaire de mots de passe
 * produit : majuscules, chiffres, et les seize caractères spéciaux cités par la
 * mission. C'est la chaîne qui a manqué aux lots précédents — ils testaient
 * avec des lettres.
 */
const MOT_DE_PASSE = 'Aa1@!*+-_#$%&()[]{}Zz9';

/** Un formulaire de connexion ordinaire, avec un champ qui écoute les touches. */
const FORMULAIRE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head>
<body>
  <form>
    <input type="text" id="identifiant" name="email">
    <input type="password" id="secret" name="password">
    <div id="temoin">0</div>
    <div id="temoin-input">0</div>
    <button type="button" id="ailleurs">Un bouton</button>
  </form>
  <script>
    // Beaucoup de formulaires écoutent la saisie — masque de saisie, jauge de
    // force du mot de passe. Ces deux témoins comptent ce qui arrive
    // RÉELLEMENT : les touches d'une part, les événements « input » d'autre
    // part. Une valeur posée directement dans le DOM n'en produirait aucun des
    // deux — c'est ce qui distingue une vraie saisie d'une valeur assignée.
    var n = 0;
    var i = 0;
    document.getElementById('secret').addEventListener('keydown', function () {
      document.getElementById('temoin').textContent = String(++n);
    });
    document.getElementById('secret').addEventListener('input', function () {
      document.getElementById('temoin-input').textContent = String(++i);
    });
  </script>
</body></html>`;

// ---------------------------------------------------------------------------
// Doubles de système — tout sauf le navigateur
// ---------------------------------------------------------------------------

function fauxFs(present) {
  const existants = new Set(present);
  return {
    existants,
    existsSync: (p) => existants.has(String(p)),
    accessSync: (p) => {
      if (!existants.has(String(p))) throw new Error(`ENOENT ${p}`);
    },
    readdirSync: () => [],
    readFileSync: () => {
      throw new Error('ENOENT');
    },
    writeFileSync: (p) => existants.add(String(p)),
    mkdirSync: (p) => {
      existants.add(String(p));
      return String(p);
    },
    rmSync: (p) => existants.delete(String(p)),
  };
}

function fauxSpawn(fs) {
  return (command, args) => {
    // Xvfb pose sa socket, sinon `waitForDisplay()` attend quinze secondes.
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fs.existants.add(`/tmp/.X11-unix/X${display}`);
    }
    const child = {
      stdout: { resume: () => {} },
      stderr: { resume: () => {} },
      on: () => {},
      kill: () => {},
    };
    return child;
  };
}

/**
 * Un gestionnaire dont le navigateur est RÉEL.
 *
 * Le mode invisible suffit : `page.keyboard.type()` parle au navigateur par le
 * protocole de Playwright, pas par le serveur X. Le chemin exercé est
 * exactement celui de la production — c'est le rendu à l'écran qui diffère, et
 * il n'est pas ce qu'on vérifie ici.
 */
async function ouvrirSession({ contenu = FORMULAIRE, identifiant = '' } = {}) {
  const { chromium } = PLAYWRIGHT;
  const navigateur = await chromium.launch({ headless: true });
  const contexte = await navigateur.newContext();
  const page = await contexte.newPage();
  await page.setContent(contenu);

  const fs = fauxFs([
    '/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify',
    '/usr/share/novnc/core/rfb.js',
  ]);
  const journal = [];

  const manager = remoteBrowser.createManager({
    fs,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: fauxSpawn(fs),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-collage',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message) => journal.push({ level, message }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 4))),
    launchBrowser: async () => ({
      page,
      context: contexte,
      storageState: async () => ({ cookies: [] }),
      close: async () => {},
    }),
    timeoutMs: 30_000,
    pollMs: 50,
  });

  const vue = await manager.start({
    userId: 7,
    connectorId: 'boutique-test',
    connectorName: 'Boutique de test',
    url: 'about:blank',
    identifiant,
    onDetected: async () => ({}),
  });

  return {
    manager,
    page,
    journal,
    vue,
    fermer: async () => {
      await manager.stopAll();
      await navigateur.close();
    },
  };
}

// ---------------------------------------------------------------------------
// §2 — le texte doit être RÉELLEMENT tapé
// ---------------------------------------------------------------------------

test(
  'un mot de passe à caractères spéciaux arrive entier dans le champ actif',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession();
    try {
      // Le geste de l'utilisateur : cliquer dans le champ du site pour lui
      // donner le focus. Tout le parcours en dépend, et c'est aussi ce que le
      // serveur vérifie avant de frapper.
      //
      // Le focus est ATTENDU, pas supposé : sous charge — la suite complète
      // fait tourner plusieurs Chromium à la fois — le clic peut rendre la
      // main avant que le champ n'ait réellement pris le curseur, et le test
      // échouait alors sur un défaut qui n'existe pas.
      await s.page.click('#secret');
      await s.page.waitForFunction(() => document.activeElement?.id === 'secret');

      const resultat = await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);
      assert.equal(resultat.ok, true, resultat.error);

      // LA vérification qui manquait depuis trois lots.
      assert.equal(
        await s.page.inputValue('#secret'),
        MOT_DE_PASSE,
        'le mot de passe doit arriver entier, caractères spéciaux compris'
      );

      // ─── `insertText`, pas une valeur posée dans le DOM (lot 14, §7.3b) ─
      //
      // Le lot 13 frappait caractère par caractère et comptait les touches.
      // `insertText` pose le texte d'un coup — il ne produit donc PAS de
      // `keydown` — mais il émet l'événement `input` que les formulaires
      // écoutent réellement, et c'est celui-là qu'il faut compter. Une valeur
      // assignée directement dans le DOM n'en émettrait aucun.
      assert.ok(
        Number(await s.page.textContent('#temoin-input')) > 0,
        'la saisie doit émettre l\'événement « input » que le site écoute'
      );
    } finally {
      await s.fermer();
    }
  }
);

test(
  'sans champ actif, la saisie est refusée et dit quoi faire',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession();
    try {
      // Personne n'a cliqué dans un champ : c'est le cas le plus fréquent, et
      // celui où les lots précédents annonçaient « Saisi dans la fenêtre »
      // alors que rien n'avait été saisi.
      await s.page.evaluate(() => document.activeElement?.blur?.());

      const resultat = await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);
      assert.equal(resultat.ok, false, 'un texte qui ne va nulle part n\'est pas un succès');
      assert.match(resultat.error, /Cliquez d'abord dans le champ à remplir/);

      assert.equal(await s.page.inputValue('#secret'), '', 'rien ne doit avoir été écrit');
    } finally {
      await s.fermer();
    }
  }
);

test(
  'un bouton sélectionné n\'est pas un champ : la saisie est refusée',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession();
    try {
      await s.page.focus('#ailleurs');

      const resultat = await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);
      assert.equal(resultat.ok, false);
      assert.match(resultat.error, /n'accepte pas de texte/);
      assert.equal(await s.page.inputValue('#secret'), '');
    } finally {
      await s.fermer();
    }
  }
);

test(
  'un champ que le site vide aussitôt ne passe pas pour un succès',
  SANS_NAVIGATEUR,
  async () => {
    // Le cas qui ressemble le plus à ce que l'utilisateur voyait : la frappe part, le
    // champ ne retient rien. Annoncer « Texte saisi » ici serait exactement le
    // mensonge qu'on corrige.
    const s = await ouvrirSession({
      contenu: `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>
        <input type="password" id="secret">
        <script>
          document.getElementById('secret').addEventListener('input', function (e) {
            e.target.value = '';
          });
        </script></body></html>`,
    });
    try {
      await s.page.click('#secret');
      const resultat = await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);

      assert.equal(resultat.ok, false, 'un champ resté vide n\'est pas une saisie réussie');
      assert.match(resultat.error, /ne s'est pas inscrit dans le champ/);
    } finally {
      await s.fermer();
    }
  }
);

test(
  'le texte saisi n\'apparaît dans aucun journal, à aucun niveau',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession();
    try {
      await s.page.click('#secret');
      await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);
      // Et une saisie qui échoue, dont le journal parle bien davantage.
      await s.page.focus('#ailleurs');
      await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);

      const trace = s.journal.map((l) => `${l.level} ${l.message}`).join('\n');
      assert.equal(
        trace.includes(MOT_DE_PASSE),
        false,
        'le mot de passe ne doit apparaître dans AUCUNE ligne de journal'
      );
      // La LONGUEUR, elle, est désormais journalisée — et elle seule (lot 14,
      // §7.3b). C'est ce qui manquait pour diagnostiquer un collage qui « ne
      // marche pas » sans jamais rien apprendre du secret lui-même.
      assert.match(
        trace,
        new RegExp(`${MOT_DE_PASSE.length} caractère\\(s\\)`),
        'la longueur — et rien qu\'elle — doit être journalisée'
      );
    } finally {
      await s.fermer();
    }
  }
);

test(
  'la saisie vise la page qui a la main, pas la première ouverte',
  SANS_NAVIGATEUR,
  async () => {
    // Un portail qui ouvre son formulaire dans un second onglet : frapper dans
    // le premier laisserait l'utilisateur devant un champ qui ne se remplit
    // pas, sans rien pour le comprendre.
    const s = await ouvrirSession();
    try {
      const contexte = s.page.context();
      const seconde = await contexte.newPage();
      await seconde.setContent(
        '<input type="password" id="ailleurs2"><input type="text" id="autre">'
      );
      await seconde.click('#ailleurs2');

      const resultat = await s.manager.typeText(7, 'boutique-test', 'Second@Onglet!');
      assert.equal(resultat.ok, true, resultat.error);

      assert.equal(await seconde.inputValue('#ailleurs2'), 'Second@Onglet!');
      assert.equal(await s.page.inputValue('#secret'), '', 'la première page reste intacte');
    } finally {
      await s.fermer();
    }
  }
);

/**
 * LA cause racine, isolée.
 *
 * La boucle de surveillance recadre le formulaire à chaque changement d'écran,
 * et posait le curseur dans le PREMIER champ texte de la page — y compris
 * pendant que l'utilisateur tapait. L'utilisateur cliquait dans « Mot de
 * passe », collait, et la moitié du texte finissait dans « Identifiant » sans
 * que rien à l'écran ne l'explique.
 *
 * Ce test-ci a été écrit APRÈS que le test du mot de passe complet a retrouvé
 * le défaut : le champ ne contenait qu'un « A ». Il le fige.
 */
test(
  'le recadrage du formulaire ne vole jamais le curseur de l\'utilisateur',
  SANS_NAVIGATEUR,
  async () => {
    const detection = require('../server/connectors/login-detection');
    const { chromium } = PLAYWRIGHT;
    const navigateur = await chromium.launch({ headless: true });

    try {
      const page = await navigateur.newPage();
      await page.setContent(
        '<input type="text" id="identifiant"><input type="password" id="secret">'
      );

      // L'utilisateur a choisi son champ.
      await page.click('#secret');
      await detection.focusForm(page);
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'secret',
        'le curseur choisi par l\'utilisateur doit rester où il est'
      );

      // Personne n'a rien choisi : là, le recadrage a tout son sens — la
      // fenêtre ne doit pas s'ouvrir sur une bannière.
      await page.evaluate(() => document.activeElement?.blur?.());
      await detection.focusForm(page);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'identifiant');
    } finally {
      await navigateur.close();
    }
  }
);

// ---------------------------------------------------------------------------
// §3 — l'identifiant pré-rempli
// ---------------------------------------------------------------------------

test(
  'l\'identifiant configuré est saisi tout seul, et le curseur va au mot de passe',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession({ identifiant: 'camille@exemple.fr' });
    try {
      // `preparerPage()` tourne au démarrage de la surveillance. On attend son
      // ÉTAT FINAL — le curseur posé dans le mot de passe —, et pas une étape
      // intermédiaire : l'identifiant est frappé caractère par caractère, comme
      // le mot de passe, et attendre « le champ n'est plus vide » attraperait
      // un « th » au vol.
      const fin = Date.now() + 8000;
      while (
        Date.now() < fin
        && (await s.page.evaluate(() => document.activeElement?.id)) !== 'secret'
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(
        await s.page.inputValue('#identifiant'),
        'camille@exemple.fr',
        'l\'identifiant déjà connu de crabe ne doit pas être à retaper'
      );

      // Le curseur est dans le mot de passe : c'est là que l'utilisateur va
      // coller, et lui demander un clic de plus serait manquer le but.
      assert.equal(await s.page.evaluate(() => document.activeElement?.id), 'secret');

      // JAMAIS de mot de passe pré-rempli.
      assert.equal(await s.page.inputValue('#secret'), '');

      // Et le curseur étant déjà au bon endroit, le collage marche sans autre
      // geste — c'est tout l'intérêt de l'enchaînement.
      const resultat = await s.manager.typeText(7, 'boutique-test', MOT_DE_PASSE);
      assert.equal(resultat.ok, true, resultat.error);
      assert.equal(await s.page.inputValue('#secret'), MOT_DE_PASSE);
    } finally {
      await s.fermer();
    }
  }
);

test(
  'sans champ d\'identifiant reconnu, rien ne se passe — et surtout pas d\'erreur',
  SANS_NAVIGATEUR,
  async () => {
    const s = await ouvrirSession({
      contenu: '<!doctype html><html lang="fr"><head><meta charset="utf-8"></head>'
        + '<body><p>Aucun formulaire ici.</p></body></html>',
      identifiant: 'camille@exemple.fr',
    });
    try {
      // La session doit rester ouverte et saine : un confort qui ne s'applique
      // pas ne fait jamais échouer une connexion.
      const vue = s.manager.status(7, 'boutique-test');
      assert.ok(vue);
      assert.equal(vue.error, null);
      assert.ok(['starting', 'running'].includes(vue.state), vue.state);

      // L'identifiant lui-même n'est pas journalisé : c'est une donnée
      // personnelle, et savoir qu'il a été posé suffit au diagnostic.
      const trace = s.journal.map((l) => l.message).join('\n');
      assert.equal(trace.includes('camille@exemple.fr'), false);
    } finally {
      await s.fermer();
    }
  }
);
