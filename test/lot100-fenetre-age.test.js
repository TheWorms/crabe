'use strict';

/**
 * Lot 100, D5 — la confirmation d'âge d'e-liquide-fr dans la fenêtre de
 * connexion : une obstruction CONNUE, retirée sans un clic.
 *
 * Mesuré le 11/10/2026 (journal de production, ligne 5825) : à l'ouverture de la
 * fenêtre, `<div id="ngdialog1" class="ngdialog ngdialog-theme-default
 * disclamer ngdialog-flex confirm age-gate ng-scope">` recouvrait la page (le
 * clic atterrissait sur « ngdialog-overlay ») ; aucune étape à clic ne l'avait
 * fermée, Échap non plus ; le contournement forcé l'a retirée, avec son
 * avertissement « fonctionnel mais fragile ». Le module la connaît désormais.
 *
 * Le chemin éprouvé est celui de la production : le gestionnaire de la fenêtre
 * (`remote-browser`), son `preparerPage` au démarrage de la surveillance, et
 * le module `obstructions` — sur une VRAIE page Chromium, sans écran (seuls
 * Xvfb, VNC et le lanceur sont des doubles, comme dans
 * test/collage-distant.test.js). La page compte elle-même chaque clic, chaque
 * appui et chaque touche.
 *
 * La page de connexion et la fenêtre d'âge sont RECONSTITUÉES : l'élément
 * racine (identifiant, classes) est celui du journal ; son contenu est
 * inventé — dont un bouton « J'accepte », le pire cas : un libellé que l'étape
 * des libellés d'acceptation cliquerait si la fenêtre lui restait offerte. Le
 * vrai bouton de confirmation n'a pas été mesuré, et n'est jamais cliqué.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteBrowser = require('../server/remote-browser');

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT ? false : 'Playwright n\'est pas installé : la fenêtre de connexion n\'est pas éprouvée sur cette machine.',
};

// ---------------------------------------------------------------------------
// Doubles de système — tout sauf le navigateur (ceux de collage-distant)
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
    if (command === 'Xvfb') {
      const display = /^:(\d+)$/.exec(String(args[0]))?.[1];
      if (display) fs.existants.add(`/tmp/.X11-unix/X${display}`);
    }
    return { stdout: { resume: () => {} }, stderr: { resume: () => {} }, on: () => {}, kill: () => {} };
  };
}

// ---------------------------------------------------------------------------
// La page de connexion reconstituée
// ---------------------------------------------------------------------------

/** La racine mesurée de la fenêtre d'âge ; son contenu est inventé. */
const FENETRE_AGE = `
  <div id="ngdialog1" class="ngdialog ngdialog-theme-default disclamer ngdialog-flex confirm age-gate ng-scope" role="alertdialog">
    <div class="ngdialog-overlay"></div>
    <div class="ngdialog-content" role="document">
      <p>Ce site est réservé aux personnes majeures.</p>
      <button type="button" class="confirmer">J'accepte</button>
      <button type="button" class="quitter">Quitter le site</button>
    </div>
  </div>`;

/** Une fenêtre que rien ne nomme : elle doit garder l'avertissement d'avant. */
const VOILE_INCONNU = '<div id="voile-maison" class="voile-promo" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);"></div>';

/** Une fenêtre ngDialog qui N'EST PAS la confirmation d'âge : le motif est précis. */
const AUTRE_NGDIALOG = `
  <div id="ngdialog2" class="ngdialog ngdialog-theme-default newsletter ng-scope" role="alertdialog">
    <div class="ngdialog-overlay"></div>
    <div class="ngdialog-content" role="document"><p>Inscrivez-vous à notre lettre d'information.</p></div>
  </div>`;

function pageDeConnexion(voile) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Identification</title>
<meta name="generator" content="Oxatis (www.oxatis.com)">
<style>
  .ngdialog { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10000; display: flex; align-items: flex-start; justify-content: center; }
  .ngdialog-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: rgba(0, 0, 0, .4); }
  .ngdialog-content { position: relative; margin-top: 10px; width: 280px; padding: 8px; background: #fff; }
</style></head>
<body>
  <h1>Identifiez-vous</h1>
  <form name="LoginForm" method="POST" action="PBUserLogin.asp" style="margin-top: 220px;">
    <input type="text" name="Email"> <input type="password" name="Password"> <input type="submit" value="Valider">
  </form>
  ${voile}
  <script>
    // La page compte chaque geste : pointeur, souris, clic, touche.
    window.__gestes = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown']) {
      document.addEventListener(type, (e) => {
        window.__gestes.push(type + (e.key ? ':' + e.key : '') + ' ' + String((e.target && (e.target.className || e.target.tagName)) || ''));
      }, true);
    }
  </script>
</body></html>`;
}

/**
 * Ouvre la fenêtre de connexion d'e-liquide-fr sur `contenu` — le vrai
 * gestionnaire, un vrai Chromium — et attend que son `preparerPage` ait fini
 * (le curseur posé dans le champ d'identifiant, son dernier geste).
 */
async function ouvrirLaFenetre(contenu) {
  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  const contexte = await navigateur.newContext();
  const page = await contexte.newPage();
  await page.setContent(contenu);
  const fs = fauxFs(['/usr/bin/Xvfb', '/usr/bin/x11vnc', '/usr/bin/websockify', '/usr/share/novnc/core/rfb.js']);
  const journal = [];
  const manager = remoteBrowser.createManager({
    fs,
    os: { totalmem: () => 4096 * 1024 * 1024, freemem: () => 2600 * 1024 * 1024 },
    spawn: fauxSpawn(fs),
    kill: () => {},
    pathDirs: () => ['/usr/bin'],
    runDir: () => '/tmp/crabe-lot100-age',
    procDir: () => '/proc',
    x11SocketDir: () => '/tmp/.X11-unix',
    novncDirs: () => ['/usr/share/novnc'],
    log: (level, message) => journal.push({ level, message: String(message) }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 4))),
    launchBrowser: async () => ({ page, context: contexte, storageState: async () => ({ cookies: [] }), close: async () => {} }),
    timeoutMs: 30_000,
    pollMs: 50,
  });
  const fermer = async () => {
    await manager.stopAll().catch(() => {});
    await navigateur.close().catch(() => {});
  };
  try {
    await manager.start({
      userId: 7,
      connectorId: 'e-liquide-fr',
      connectorName: 'e-liquide-fr',
      url: 'about:blank',
      onDetected: async () => ({}),
    });
    const fin = Date.now() + 15_000;
    while (Date.now() < fin && (await page.evaluate(() => document.activeElement?.name || '')) !== 'Email') {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(await page.evaluate(() => document.activeElement?.name || ''), 'Email',
      'la fenêtre est prête : preparerPage a posé le curseur dans le champ d\'identifiant');
  } catch (err) {
    await fermer();
    throw err;
  }
  return {
    page,
    journal,
    lignes: () => journal.map((l) => l.message),
    gestes: () => page.evaluate(() => window.__gestes),
    fermer,
  };
}

// ---------------------------------------------------------------------------
// D5
// ---------------------------------------------------------------------------

test('D5 — la fenêtre de confirmation d\'âge est retirée à l\'ouverture de la fenêtre de connexion, SANS UN CLIC ni une touche, et le journal la nomme', SANS_NAVIGATEUR, async () => {
  const f = await ouvrirLaFenetre(pageDeConnexion(FENETRE_AGE));
  try {
    const ligne = 'e-liquide-fr : fenêtre de confirmation d\'âge fermée — retirée de la page, sans un clic '
      + '(<div id="ngdialog1" class="ngdialog ngdialog-theme-default disclamer ngdialog-flex confirm age-gate ng-scope">).';
    assert.deepEqual(f.journal.filter((l) => l.message === ligne).map((l) => l.level), ['info'], `la ligne, une fois\n${f.lignes().join('\n')}`);
    assert.doesNotMatch(f.lignes().join('\n'), /contournement forcé|fonctionnel mais fragile|obstruction levée|touche Échap|recouvre encore/,
      'plus d\'avertissement « fragile » : l\'obstruction est connue, et aucune autre étape n\'a servi');
    assert.equal(await f.page.evaluate(() => document.querySelectorAll('.age-gate, .ngdialog-overlay').length), 0, 'la fenêtre est retirée de la page');
    assert.deepEqual(await f.gestes(), [], 'aucun clic, aucun appui, aucune touche — pas même sur « J\'accepte »');
    assert.equal(await f.page.evaluate(() => !!document.querySelector('form[name="LoginForm"] input[type="password"]')), true,
      'le formulaire de connexion est intact');
  } finally {
    await f.fermer();
  }
});

test('D5 — une obstruction inconnue garde l\'avertissement d\'avant, mot pour mot ; une autre fenêtre ngDialog aussi', SANS_NAVIGATEUR, async () => {
  for (const [quoi, voile, racine] of [
    ['un voile sans nom', VOILE_INCONNU, '<div id="voile-maison" class="voile-promo">'],
    ['une fenêtre ngDialog qui n\'est pas la confirmation d\'âge', AUTRE_NGDIALOG,
      '<div id="ngdialog2" class="ngdialog ngdialog-theme-default newsletter ng-scope"> (le clic atterrirait sur « ngdialog-overlay »)'],
  ]) {
    const f = await ouvrirLaFenetre(pageDeConnexion(voile));
    try {
      const ligne = `e-liquide-fr : contournement forcé — l'élément obstruant a été retiré de la page (${racine}). `
        + 'C\'est fonctionnel mais fragile : ajoutez son motif à server/connectors/obstructions.js pour le fermer proprement.';
      assert.ok(f.lignes().includes(ligne), `${quoi} : l'avertissement d'avant\n${f.lignes().join('\n')}`);
      assert.doesNotMatch(f.lignes().join('\n'), /fenêtre de confirmation d'âge/, `${quoi} : rien n'est nommé à tort`);
    } finally {
      await f.fermer();
    }
  }
});
