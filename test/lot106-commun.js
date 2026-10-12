'use strict';

/**
 * Lot 106 — ce que partagent les essais de la refonte de l'interface : une
 * session ouverte par la vraie route de connexion (pour la poser dans un vrai
 * Chromium), Playwright quand il est installé, et la mesure du contraste
 * (WCAG 2.x) entre deux couleurs CALCULÉES par le navigateur.
 *
 * Aucune donnée réelle : les comptes des essais portent des noms de rôle
 * (titulaire, voisine, gerante), les valeurs sont inventées.
 */

const assert = require('node:assert/strict');

/** La valeur du cookie `crabe.sid` d'un compte, connecté par la vraie route. */
async function sessionDe(client, username, motDePasse = 'MotDePasse1') {
  const totp = require('../server/auth/totp');
  let cookie = '';
  const appel = async (chemin, corps) => {
    const r = await fetch(`${client.base}${chemin}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(corps || {}),
    });
    const brut = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
    if (brut) cookie = brut.split(';')[0];
    return r.json();
  };
  const etape = await appel('/api/auth/login', { username, password: motDePasse });
  if (etape.step === '2fa-setup') {
    const reglage = await appel('/api/auth/2fa/setup');
    await appel('/api/auth/2fa/confirm', { code: totp.currentToken(reglage.secret) });
  }
  assert.ok(cookie, 'cookie de session absent');
  return cookie.split('=').slice(1).join('=');
}

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const AVEC_NAVIGATEUR = {
  skip: PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.',
  timeout: 180_000,
};

/**
 * Ouvre crabe dans un vrai Chromium, connecté sous `username`, au thème voulu.
 *
 * @returns {Promise<{page, erreursJs: string[], fermer: () => Promise<void>}>}
 */
/**
 * UN navigateur par fichier d'essai, un contexte neuf (cookies, stockage) par
 * ouverture : lancer Chromium à chaque essai coûtait une minute à la suite
 * entière (mesuré au lot 106). Chaque fichier le referme par `fermerNavigateur`
 * (`test.after`), sans quoi le processus ne finirait pas.
 */
let navigateurPartage = null;

async function navigateur() {
  if (!navigateurPartage) navigateurPartage = PLAYWRIGHT.chromium.launch({ headless: true });
  return navigateurPartage;
}

async function fermerNavigateur() {
  if (!navigateurPartage) return;
  const n = await navigateurPartage.catch(() => null);
  navigateurPartage = null;
  await n?.close().catch(() => {});
}

async function ouvrirCrabe(client, username, { largeur = 1280, hauteur = 900, clair = false, chemin = '/', preparer = null } = {}) {
  const contexte = await (await navigateur()).newContext({ viewport: { width: largeur, height: hauteur } });
  await contexte.addCookies([{
    name: 'crabe.sid', value: await sessionDe(client, username), domain: '127.0.0.1', path: '/',
  }]);
  // Le thème se lit au démarrage dans `localStorage` (applyTheme, web/app.js).
  await contexte.addInitScript((leClair) => {
    try { localStorage.setItem('crabe.theme', leClair ? 'light' : 'dark'); } catch { /* rien */ }
  }, clair);
  const page = await contexte.newPage();
  // Lot 107 : un essai peut poser ses interceptions AVANT le premier appel
  // (réponse de /api/auth/me retouchée, par exemple).
  if (preparer) await preparer(page);
  const erreursJs = [];
  page.on('pageerror', (e) => erreursJs.push(String(e)));
  await page.goto(`${client.base}${chemin}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.me && document.querySelector('.view.active'));
  return { page, erreursJs, fermer: () => contexte.close().catch(() => {}) };
}

/** Luminance relative d'une couleur `rgb(a)` calculée par le navigateur. */
function luminance(css) {
  const [r, g, b] = String(css).match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs. */
function contraste(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Le texte et le fond EFFECTIFS d'un élément : le premier ancêtre au fond non
 * transparent donne le fond.
 */
async function couleursDe(page, selecteur) {
  return page.$eval(selecteur, (el) => {
    const texte = getComputedStyle(el).color;
    let n = el;
    let fond = 'rgba(0, 0, 0, 0)';
    while (n && n.nodeType === 1) {
      const f = getComputedStyle(n).backgroundColor;
      if (f && !/rgba\(0, 0, 0, 0\)|transparent/.test(f)) { fond = f; break; }
      n = n.parentElement;
    }
    return { texte, fond };
  });
}

/** Rien ne déborde à droite : la page entière tient dans la fenêtre. */
async function debordement(page) {
  return page.evaluate(() => {
    const largeur = document.documentElement.clientWidth;
    const fautifs = [];
    // Le panneau latéral du téléphone attend HORS de l'écran (translateX) :
    // c'est voulu, il n'élargit pas la page. Un conteneur qui défile lui-même
    // (tableau large) non plus.
    const horsJeu = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (n.id === 'tb-mobile-menu') return true;
        if (/(auto|scroll|hidden)/.test(getComputedStyle(n).overflowX)) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.id === 'tb-mobile-menu' || horsJeu(el)) continue;
      if (r.right > largeur + 1) fautifs.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className || '').split(' ')[0]} → ${Math.round(r.right)}`);
    }
    return { largeur, scroll: document.documentElement.scrollWidth, fautifs: fautifs.slice(0, 10) };
  });
}

module.exports = {
  sessionDe,
  PLAYWRIGHT,
  AVEC_NAVIGATEUR,
  ouvrirCrabe,
  fermerNavigateur,
  contraste,
  couleursDe,
  debordement,
};
