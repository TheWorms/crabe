'use strict';
/**
 * Lot 66 — 1d : l'API Notification existe-t-elle sur l'adresse réellement
 * servie à l'utilisateur ?
 *
 *     node scripts/lot66-sonde-navigateur.js http://mon-crabe.exemple/
 *
 * Mesure, pas déduction. Deux origines dans le MÊME navigateur :
 *   - l'adresse passée en argument — celle que l'on ouvre vraiment ;
 *   - `http://127.0.0.1:<port>/` — localhost, contexte sûr par exception, qui
 *     sert de TÉMOIN : sans lui, un « refusé » partout ne prouverait rien
 *     d'autre que le fait que la sonde elle-même est bancale.
 *
 * Aucun clic, aucune session, aucune donnée : on lit `typeof Notification`,
 * `isSecureContext` et `Notification.permission` sur la page telle qu'elle est
 * servie.
 */
const http = require('http');
const { chromium, firefox } = require('playwright');
const identity = require('../server/connectors/browser-identity');

const PAGE = '<!doctype html><meta charset="utf-8"><title>sonde</title><p>sonde</p>';

/** L'adresse à mesurer — celle qu'on tape dans son navigateur. */
const ADRESSE = process.argv[2];
if (!ADRESSE) {
  console.error('Usage : node scripts/lot66-sonde-navigateur.js <adresse de crabe>');
  process.exit(2);
}

function lire(page) {
  return page.evaluate(() => ({
    origine: location.origin,
    contexteSur: window.isSecureContext,
    notificationDefinie: typeof Notification !== 'undefined',
    permission: typeof Notification !== 'undefined' ? Notification.permission : null,
    requestPermissionDefinie:
      typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function',
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: typeof PushManager !== 'undefined',
  }));
}

(async () => {
  const temoin = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => temoin.listen(0, '127.0.0.1', r));
  const port = temoin.address().port;

  const cibles = [
    [ADRESSE, 'ce que l\'utilisateur ouvre'],
    [`http://127.0.0.1:${port}/`, 'localhost — contexte sûr par exception'],
  ];

  // Les DEUX moteurs, pour montrer que le constat ne tient pas à l'un d'eux —
  // `connection_logs` dit lequel est réellement utilisé sur une installation
  // donnée. `channel: 'chromium'` : le vrai navigateur, pas le shell headless.
  const moteurs = [
    ['Firefox', () => firefox.launch()],
    ['Chromium', () => chromium.launch({ channel: 'chromium' })],
  ];

  for (const [nom, lancer] of moteurs) {
    const nav = await lancer();
    // Même identité que celle des connecteurs (§6 du lot 13 : aucun contexte
    // sans agent explicite). Elle ne change rien à ce qu'on mesure ici —
    // `isSecureContext` et la permission dépendent de l'ORIGINE, pas de
    // l'agent — mais un contexte nu dans le dépôt serait un précédent.
    const ctx = await nav.newContext(identity.optionsContexte());
    const page = await ctx.newPage();
    console.log('\n########## ' + nom + ' ' + nav.version() + ' ##########');
    for (const [url, quoi] of cibles) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const m = await lire(page);
        console.log('\n' + url + '  (' + quoi + ')');
        console.log('  isSecureContext            = ' + m.contexteSur);
        console.log('  typeof Notification        = ' + (m.notificationDefinie ? 'objet' : 'undefined'));
        console.log('  Notification.permission    = ' + m.permission);
        console.log('  requestPermission définie  = ' + m.requestPermissionDefinie);
        console.log('  navigator.serviceWorker    = ' + m.serviceWorker);
        console.log('  PushManager                = ' + m.pushManager);
      } catch (e) {
        console.log('\n' + url + ' : ' + e.message.split('\n')[0]);
      }
    }
    await nav.close();
  }

  temoin.close();
})().catch((e) => { console.error('ERREUR ' + e.message); process.exit(1); });
