'use strict';

/**
 * Lot 92, R4 — la fenêtre d'information à la configuration.
 *
 * Decathlon ne remet une facture que si l'adresse de facturation et de
 * livraison est renseignée sur le compte (dit par l'utilisateur le 05/10/2026). La
 * fiche d'un service à fenêtre ne disait rien de tel : rien à saisir, l'aide
 * repliée sous « Options avancées ». Le manifeste peut désormais déclarer
 * `informationConfiguration` ; la fiche l'ouvre dans une fenêtre quand elle
 * s'ouvre pour configurer. Seul `decathlon` la déclare dans ce lot.
 *
 * La preuve d'écran se fait au VRAI Chromium, sur une instance neuve (base en
 * mémoire, aucune donnée réelle) : ce qui est VISIBLE, ce qu'un lecteur
 * d'écran reçoit (l'arbre d'accessibilité), où va le focus, ce que font Tab,
 * Échap et le clic à côté — mots relevés à l'écran, jamais supposés.
 */

const helpers = require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = require('../server/connectors/manifest-schema');

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT ? false : 'Playwright n\'est pas installé : la fenêtre n\'est pas éprouvée au vrai Chromium sur cette machine.',
};

const RACINE = path.join(__dirname, '..', 'server', 'connectors');
const DECATHLON = require('../server/connectors/available/decathlon/manifest.json');

const MANIFESTE_MINIMAL = {
  id: 'essai-information',
  name: 'Essai',
  category: 'shopping',
  description: 'Un service inventé pour éprouver la validation.',
  fields: [{ key: 'identifiant', label: 'Identifiant', type: 'text' }],
  permissions: [{ key: 'factures', scope: 'read', description: 'Lit les factures du service inventé.' }],
};

// ---------------------------------------------------------------------------
// Le champ de manifeste
// ---------------------------------------------------------------------------

test('le champ se valide : titre et texte exigés, bornés, sans jargon, rien d\'autre', () => {
  const avec = (info) => schema.validate({ ...MANIFESTE_MINIMAL, informationConfiguration: info }, 'essai').errors;
  assert.deepEqual(avec({ titre: 'Avant de commencer', texte: 'Renseignez votre adresse sur le site.' }), []);
  assert.match(avec('une phrase').join(' '), /doit être un objet/);
  assert.match(avec({ titre: '', texte: 'x' }).join(' '), /informationConfiguration\.titre » manquant/);
  assert.match(avec({ titre: 'T', texte: 'x'.repeat(schema.INFORMATION_TEXTE_MAX + 1) }).join(' '), /caractères/);
  assert.match(avec({ titre: 'T', texte: 'Lancez npm install sur le serveur.' }).join(' '), /commande système/);
  assert.match(avec({ titre: 'T', texte: 'Texte', bouton: 'OK' }).join(' '), /ne connaît que titre et texte/);
});

test('un manifeste qui ne déclare rien ne reçoit pas même une clé vide', () => {
  const vue = schema.publicView(schema.normalize(MANIFESTE_MINIMAL));
  assert.equal('informationConfiguration' in vue, false);
  const declare = schema.publicView(schema.normalize({
    ...MANIFESTE_MINIMAL, informationConfiguration: { titre: '  Titre ', texte: ' Texte  ' },
  }));
  assert.deepEqual(declare.informationConfiguration, { titre: 'Titre', texte: 'Texte' });
});

test('seul decathlon déclare une fenêtre d\'information dans ce lot', () => {
  const declarants = [];
  for (const dossier of ['available', 'planned']) {
    for (const id of fs.readdirSync(path.join(RACINE, dossier))) {
      const fichier = path.join(RACINE, dossier, id, 'manifest.json');
      if (!fs.existsSync(fichier)) continue;
      if (JSON.parse(fs.readFileSync(fichier, 'utf8')).informationConfiguration) declarants.push(id);
    }
  }
  assert.deepEqual(declarants, ['decathlon']);
  assert.deepEqual(DECATHLON.informationConfiguration, {
    titre: 'Avant de connecter Decathlon',
    texte: 'Decathlon ne remet une facture que si votre adresse de facturation et votre adresse de '
      + 'livraison sont renseignées dans votre compte. Vérifiez-les d\'abord dans « Carnet '
      + 'd\'adresses », sur decathlon.fr : sans elles, crabe ne pourra pas récupérer vos factures.',
  });
});

// ---------------------------------------------------------------------------
// D4 — au vrai Chromium, sur une instance neuve
// ---------------------------------------------------------------------------

test('D4 — la fenêtre s\'ouvre à la configuration de decathlon SEUL, se lit, se ferme, rend le focus', SANS_NAVIGATEUR, async (t) => {
  await helpers.setup();
  await helpers.createUser({ username: 'lot92d4', plainPassword: 'MotDePasse1', role: 'admin' });
  const client = await helpers.startServer();
  const reponse = await fetch(`${client.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lot92d4', password: 'MotDePasse1' }),
  });
  const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
  assert.ok(brut, 'cookie de session absent');
  const valeur = brut.split(';')[0].split('=').slice(1).join('=');

  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const ouvrir = async (viewport) => {
      const contexte = await navigateur.newContext({ viewport });
      await contexte.addCookies([{ name: 'crabe.sid', value: valeur, domain: '127.0.0.1', path: '/' }]);
      const page = await contexte.newPage();
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e)));
      await page.goto(client.base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => Array.isArray(state?.connectors) && state.connectors.length > 0);
      return { contexte, page, erreurs };
    };
    const { contexte, page, erreurs } = await ouvrir({ width: 1280, height: 900 });
    const fenetre = page.locator('#info-config-overlay');
    const dialogue = page.getByRole('dialog', { name: 'Avant de connecter Decathlon' });
    const fiche = page.locator('#modal-overlay');

    // Seul decathlon porte le champ, côté écran aussi.
    const porteurs = await page.evaluate(() => state.connectors.filter((c) => c.informationConfiguration).map((c) => c.id));
    assert.deepEqual(porteurs, ['decathlon']);

    // ── Ouverture à la configuration ────────────────────────────────────────
    await page.evaluate(() => openModal('decathlon'));
    await dialogue.waitFor({ state: 'visible' });
    assert.equal(await fiche.evaluate((el) => el.classList.contains('show')), true, 'la fiche est dessous, ouverte');
    const mots = (await page.locator('#info-config-overlay .info-config').innerText()).replace(/\s+/g, ' ').trim();
    t.diagnostic(`mots relevés à l'écran : ${mots}`);
    assert.equal(mots, `Avant de connecter Decathlon ✕ ${DECATHLON.informationConfiguration.texte} J'ai compris`);
    const arbre = await fenetre.ariaSnapshot();
    t.diagnostic(`arbre d'accessibilité : ${arbre.replace(/\n/g, ' ⏎ ')}`);
    assert.match(arbre, /dialog "Avant de connecter Decathlon"/, 'le lecteur d\'écran annonce une fenêtre, par son titre');
    assert.match(arbre, /button "Fermer"/);
    assert.match(arbre, /button "J'ai compris"/);
    assert.equal(await dialogue.getAttribute('aria-modal'), 'true');
    const decrit = await page.evaluate(() => {
      const d = document.querySelector('#info-config-overlay [role="dialog"]');
      return document.getElementById(d.getAttribute('aria-describedby'))?.textContent;
    });
    assert.equal(decrit, DECATHLON.informationConfiguration.texte, 'le texte est la description de la fenêtre');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'info-config-ok', 'le focus est sur « J\'ai compris »');

    // ── Le clavier ──────────────────────────────────────────────────────────
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Fermer', 'Tab tourne dans la fenêtre');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'info-config-ok');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Fermer');
    await page.keyboard.press('Escape');
    await dialogue.waitFor({ state: 'hidden' });
    assert.equal(await fiche.evaluate((el) => el.classList.contains('show')), true, 'Échap ferme la fenêtre, PAS la fiche');
    // Le focus revient DANS la fiche : sur « Se connecter à Decathlon » quand
    // le serveur peut ouvrir la fenêtre de connexion, sur la croix de la fiche
    // quand ce bouton est grisé (cette instance d'essai n'a pas Xvfb).
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const geste = document.querySelector('#modal-actions button');
      return {
        dansLaFiche: !!el?.closest('#modal-overlay'),
        texte: el?.textContent?.replace(/\s+/g, ' ').trim(),
        croix: el === document.querySelector('#modal-overlay .modal-close'),
        gesteActif: !!geste && !geste.disabled,
      };
    });
    t.diagnostic(`focus après Échap : ${JSON.stringify(focus)}`);
    assert.equal(focus.dansLaFiche, true, 'le focus revient dans la fiche, pas sur le corps de la page');
    if (focus.gesteActif) assert.equal(focus.texte, 'Se connecter à Decathlon');
    else assert.equal(focus.croix, true, 'bouton grisé : le focus va à la croix de la fiche');

    // La même chose avec la fenêtre de connexion DISPONIBLE, comme sur le
    // serveur de production : le focus revient sur « Se connecter à Decathlon ».
    await page.evaluate(() => { rb().caps = { available: true, busy: false }; closeModal(); openModal('decathlon'); });
    await dialogue.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialogue.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim()),
      'Se connecter à Decathlon', 'bouton actif : le focus revient au geste de la fiche');

    // ── « J'ai compris », puis le clic à côté ───────────────────────────────
    await page.evaluate(() => { closeModal(); openModal('decathlon', { edit: true }); });
    await dialogue.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'J\'ai compris' }).click();
    await dialogue.waitFor({ state: 'hidden' });
    assert.equal(await fiche.evaluate((el) => el.classList.contains('show')), true);
    await page.evaluate(() => { closeModal(); openModal('decathlon'); });
    await dialogue.waitFor({ state: 'visible' });
    await page.mouse.click(8, 8);
    await dialogue.waitFor({ state: 'hidden' });

    // ── Rien ailleurs, ni sur une fiche déjà connectée ──────────────────────
    const autres = await page.evaluate(() => state.connectors.filter((c) => c.id !== 'decathlon' && !c.planned).map((c) => c.id));
    assert.ok(autres.length > 10, `des services à comparer (${autres.length})`);
    for (const id of autres) {
      await page.evaluate((i) => { closeModal(); openModal(i); }, id);
      assert.equal(await fenetre.evaluate((el) => el.classList.contains('show')), false, `${id} : aucune fenêtre`);
    }
    await page.evaluate(() => {
      closeModal();
      const c = state.connectors.find((x) => x.id === 'decathlon');
      c.health = { ...(c.health || {}), connected: true };
      openModal('decathlon');
    });
    assert.equal(await fenetre.evaluate((el) => el.classList.contains('show')), false,
      'fiche d\'un service connecté, ouverte pour regarder : pas de fenêtre');
    assert.deepEqual(erreurs, [], 'aucune erreur JavaScript');
    await contexte.close();

    // ── Écran étroit : une petite fenêtre, entière, centrée ─────────────────
    const etroit = await ouvrir({ width: 390, height: 844 });
    await etroit.page.evaluate(() => openModal('decathlon'));
    const boite = etroit.page.locator('#info-config-overlay .info-config');
    await boite.waitFor({ state: 'visible' });
    const r = await boite.boundingBox();
    t.diagnostic(`390 px : boîte ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    assert.ok(r.x >= 0 && r.x + r.width <= 390 && r.y >= 0 && r.y + r.height <= 844, 'la fenêtre tient dans l\'écran');
    assert.ok(r.height < 844 * 0.8, 'quelques lignes ne prennent pas l\'écran entier');
    assert.ok(await etroit.page.getByRole('button', { name: 'J\'ai compris' }).isVisible());
    assert.deepEqual(etroit.erreurs, []);
    await etroit.contexte.close();
  } finally {
    await navigateur.close().catch(() => {});
    await client.close?.();
  }
});

test.after(() => {
  helpers.teardown();
});
