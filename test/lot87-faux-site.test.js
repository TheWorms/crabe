'use strict';

/**
 * Lot 87, D2 — un faux site local, au VRAI Chromium.
 *
 * Aucune donnée réelle : un serveur HTTP de test qui imite la MÉCANIQUE
 * mesurée le 05/10/2026. La liste blanche d'adresses du connecteur n'est PAS
 * desserrée (elle n'accepte que `cfspart.impots.gouv.fr`) : on éprouve les
 * pièces du socle — le relevé de navigation et le jugement d'arrivée —
 * directement sur une page Chromium réelle, servie en local.
 *
 * Le faux site reproduit les trois cas :
 *   1. première présentation des cookies → la liste (onglets d'année) ;
 *   2. présentation suivante des MÊMES cookies → la chaîne de déconnexion en
 *      quatre réponses (logout → deconnexion2 → / ?logout) ;
 *   3. cookies inconnus → `/` puis l'écran d'authentification.
 *
 * On prouve, au vrai navigateur : le relevé des réponses de navigation (noms
 * de cookies posés/effacés, renvois) et le verdict de `jugerArrivee` dans les
 * trois cas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const navigation = require('../server/connectors/releve-navigation');
const impots = require('../server/connectors/available/impots/connector');

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
    : 'Playwright n\'est pas installé : le faux site n\'est pas éprouvé au vrai Chromium sur cette machine.',
};

// ---------------------------------------------------------------------------
// Le faux site — la mécanique du §2.4, sans aucune donnée réelle
// ---------------------------------------------------------------------------
//
// L'état « cette session a déjà été servie une fois » vit côté serveur, par
// valeur de cookie `sid`. `sid=frais` : d'abord la liste, et le serveur
// MARQUE la session comme déjà servie. La fois suivante (le même `sid`), la
// chaîne de déconnexion. `sid` absent ou inconnu : l'écran d'authentification.

function creerFauxSite() {
  const servies = new Set();
  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cookies = Object.fromEntries(
      String(req.headers.cookie || '').split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
      }).filter(([k]) => k)
    );
    const sid = cookies.sid || '';

    // La liste des documents.
    if (url.pathname === '/enp/documents.do') {
      if (!sid || sid !== 'frais') {
        // Session inconnue : renvoi vers l'accueil, puis l'authentification.
        res.writeHead(302, { location: '/' });
        return res.end();
      }
      if (servies.has(sid)) {
        // DEUXIÈME présentation : la chaîne de déconnexion. Un nouveau sid est
        // posé, comme le vrai portail (nouveau JSESSIONID sur la 1re réponse).
        res.writeHead(302, {
          location: '/enp/j_spring_security_logout.ex',
          'set-cookie': ['JSESSIONID=nouveau; Path=/enp; HttpOnly'],
        });
        return res.end();
      }
      // PREMIÈRE présentation : la liste, dix onglets d'année.
      servies.add(sid);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const onglets = [];
      for (let k = 1; k <= 10; k++) {
        onglets.push(`<button role="tab" id="tab-${k}" title="${2027 - k}">${2027 - k}</button>`);
      }
      return res.end(`<!doctype html><html><body>
        <div class="fr-hidden fr-unhidden-md"><div class="fr-tabs">${onglets.join('')}</div></div>
      </body></html>`);
    }

    // La chaîne de déconnexion (globale).
    if (url.pathname === '/enp/j_spring_security_logout.ex') {
      res.writeHead(302, {
        location: '/deconnexion2',
        'set-cookie': ['JSESSIONID=; Path=/enp; Max-Age=0', 'fsdgfippart=; Path=/; Max-Age=0'],
      });
      return res.end();
    }
    if (url.pathname === '/deconnexion2') {
      res.writeHead(302, { location: '/?logout' });
      return res.end();
    }

    // L'accueil : avec `?logout`, c'est la fin de la déconnexion ; sinon, un
    // anonyme qu'on envoie s'authentifier.
    if (url.pathname === '/') {
      if (url.searchParams.has('logout')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><body>Déconnexion en cours, veuillez patienter…</body></html>');
      }
      res.writeHead(302, { location: '/oauth2/authorize?prompt=login' });
      return res.end();
    }
    if (url.pathname === '/oauth2/authorize') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body>Authentification des particuliers'
        + '<input type="password" name="pass"></body></html>');
    }

    res.writeHead(404);
    res.end('non');
  });
  return serveur;
}

let serveur;
let base;

test.before(async () => {
  if (!PLAYWRIGHT) return;
  serveur = creerFauxSite();
  await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  if (serveur) await new Promise((resolve) => serveur.close(resolve));
});

/**
 * Ouvre une page Chromium munie d'un cookie `sid`, va sur la liste en
 * attendant l'arrivée, et rend le relevé, les onglets, l'adresse finale.
 */
async function passer(sid) {
  const { chromium } = PLAYWRIGHT;
  const navigateur = await chromium.launch({ headless: true });
  try {
    const contexte = await navigateur.newContext();
    if (sid) {
      await contexte.addCookies([{
        name: 'sid', value: sid, url: base,
      }]);
    }
    const page = await contexte.newPage();
    page.setDefaultTimeout(10_000);
    const lignes = [];
    const releve = navigation.brancher(page, { log: (l) => lignes.push(l), prefixe: 'nav' });

    try {
      await page.goto(`${base}/enp/documents.do`, { waitUntil: 'domcontentloaded' });
    } catch { /* une chaîne de renvois peut avorter le goto */ }
    // Attente simple : la présence des onglets, ou une adresse stabilisée.
    let onglets = 0;
    for (let i = 0; i < 40; i++) {
      onglets = await page.locator('button[role="tab"][id^="tab-"]').count().catch(() => 0);
      if (onglets > 0) break;
      await page.waitForTimeout(50).catch(() => {});
    }
    releve.detacher();
    return { lignes, chemins: releve.chemins(), onglets, urlFinale: page.url() };
  } finally {
    await navigateur.close().catch(() => {});
  }
}

/** Le même hôte que la liste, pour que le jugement reconnaisse le faux site. */
function jugerCommeImpots({ urlFinale, chemins, onglets }) {
  const u = new URL(urlFinale);
  // On réécrit l'hôte du faux site en celui de la liste, et on dit au juge de
  // viser cet hôte : la MÉCANIQUE est éprouvée, pas la liste blanche.
  return impots.jugerArrivee({
    urlFinale: urlFinale.replace(u.host, 'cfspart.impots.gouv.fr'),
    chemins,
    onglets,
    hoteListe: 'cfspart.impots.gouv.fr',
  });
}

// ---------------------------------------------------------------------------
// Les trois cas, au vrai Chromium
// ---------------------------------------------------------------------------

test('faux site : première présentation d\'une session fraîche → la liste', SANS_NAVIGATEUR, async () => {
  const passage = await passer('frais');
  assert.ok(passage.onglets >= 10, `attendu dix onglets, reçu ${passage.onglets}`);
  const jugement = jugerCommeImpots(passage);
  assert.equal(jugement.verdict, 'liste');
  // Le relevé a bien vu la réponse 200 de la liste.
  assert.ok(passage.lignes.some((l) => /200 .* \/enp\/documents\.do/.test(l)),
    passage.lignes.join('\n'));
});

test('faux site : deuxième présentation des MÊMES cookies → la déconnexion', SANS_NAVIGATEUR, async () => {
  // Deux passages avec le même sid : le premier marque la session servie, le
  // second reçoit la chaîne de déconnexion.
  const sid = 'frais';
  await passer(sid); // consomme l'unique rejeu
  const passage = await passer(sid);

  assert.equal(passage.onglets, 0, 'pas d\'onglets sur la page de déconnexion');
  const jugement = jugerCommeImpots(passage);
  assert.equal(jugement.verdict, 'session-fermee',
    `chaîne : ${passage.chemins.join(' → ')} ; finale : ${passage.urlFinale}`);

  // Le relevé a vu la chaîne — logout, puis l'effacement des cookies.
  const texte = passage.lignes.join('\n');
  assert.match(texte, /j_spring_security_logout/);
  assert.match(texte, /cookies effacés : JSESSIONID/);
  // Et jamais une valeur de cookie ne s'y trouve.
  assert.doesNotMatch(texte, /nouveau|=/);
});

test('faux site : des cookies inconnus → l\'écran d\'authentification', SANS_NAVIGATEUR, async () => {
  const passage = await passer('inconnu');
  assert.equal(passage.onglets, 0);
  const jugement = jugerCommeImpots(passage);
  assert.equal(jugement.verdict, 'connexion-demandee',
    `chaîne : ${passage.chemins.join(' → ')} ; finale : ${passage.urlFinale}`);
  // Lot 105 (R6) : un segment de chemin qui contient un chiffre est masqué au
  // journal — « oauth2 » devient « … » ; le jugement, lui, lit les chemins
  // bruts (`chemins()`) et ne change pas.
  assert.match(passage.lignes.join('\n'), /\/…\/authorize/);
});
