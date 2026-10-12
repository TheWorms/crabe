'use strict';

/**
 * Lot 106, R6 — le thème ne change pas, l'accessibilité suit.
 *
 * Lu dans les fichiers livrés : la feuille du lot 106 n'écrit aucune couleur
 * en dur (les variables du thème, et l'ombre du panneau de la cloche, la même
 * à l'identique) ; chaque élément cliquable neuf a un focus visible ; aucune
 * police, aucune bibliothèque, aucun CDN de plus dans la page ; les boutons à
 * icône seule portent leur nom. Les contrastes, mesurés au vrai Chromium dans
 * les deux thèmes, sont dans les essais de chaque écran (menu, Interface,
 * modale, Suivi d'actions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(WEB, 'app.html'), 'utf8');
const LOT106 = CSS.slice(CSS.indexOf('Lot 106 — refonte de l\'interface, premier temps'));

test('R6 — la feuille du lot 106 existe, et n\'écrit aucune couleur en dur', () => {
  assert.ok(LOT106.length > 2000, 'le bloc du lot 106 est en fin de feuille');
  const sansCommentaires = LOT106.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(sansCommentaires.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'aucun #hexadécimal');
  // L'ombre des panneaux ancrés est celle de la cloche (lot 79), à l'identique.
  const rgb = sansCommentaires.match(/rgba?\([^)]*\)/g) || [];
  for (const c of rgb) assert.match(c, /^rgba\(0,0,0,\.(35|12)\)$/, `${c} : seule l'ombre de la cloche`);
  assert.match(CSS, /\.notif-panneau\{[^}]*box-shadow:0 12px 28px rgba\(0,0,0,\.35\)/);
  // Aucune police nouvelle : seules celles du thème sont nommées.
  for (const police of sansCommentaires.match(/font-family:[^;}]+/g) || []) {
    assert.match(police, /^font-family:'Space Grotesk',sans-serif$/, police);
  }
});

test('R6 — chaque élément cliquable neuf a un focus visible', () => {
  for (const classe of [
    '.tb-compte-btn', '.menu-compte-item', 'button.settings-nav-item', '.interface-carte', '.btn-dossier',
    '.mc-onglet', '.mc-lien', '.mc-action', '.mc-reconnecter', '.qv-open-btn', '.suivi-filtre',
    '.suivi-puce-croix', '.w-title-lien', '.modale-connecteur .modal-close',
  ]) {
    const motif = new RegExp(`${classe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::not\\([^)]*\\))?:focus-visible[^{]*\\{[^}]*outline:2px solid var\\(--accent\\)`);
    const enListe = new RegExp(`${classe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible[,\\s][^{]*\\{[^}]*outline:2px solid var\\(--accent\\)`);
    assert.ok(motif.test(LOT106) || enListe.test(LOT106), `${classe} : focus visible`);
  }
});

test('R6 — aucune police, aucune bibliothèque, aucun CDN de plus dans la page', () => {
  const externes = [...HTML.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).host);
  assert.deepEqual([...new Set(externes)].sort(), ['fonts.googleapis.com', 'fonts.gstatic.com'], 'les deux hôtes des polices du thème, rien d\'autre');
  assert.equal((HTML.match(/family=Space\+Grotesk:wght@500;700&family=Inter:wght@400;500;600/g) || []).length, 1);
  const scripts = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['/fmt.js', '/keysym.js', '/ui-prefs.js', '/app.js', '/admin.js']);
});

test('R6 — les boutons à icône seule portent leur nom ; les surcouches neuves se disent', () => {
  assert.match(HTML, /id="tb-profil"[^>]*aria-label="Menu du compte"/);
  assert.match(HTML, /<button type="button" class="modal-close" onclick="closeQuickview\(\)" aria-label="Fermer">/);
  assert.match(HTML, /id="menu-compte" role="menu"/);
  assert.match(HTML, /id="qv-dialog" role="dialog" aria-modal="true" aria-labelledby="qv-name"/);
  assert.match(HTML, /id="toast" role="status" aria-live="polite"/);
  // Les icônes décoratives des éléments neufs sont tues.
  const menu = HTML.slice(HTML.indexOf('id="menu-compte"'), HTML.indexOf('<div class="tb-scrim"'));
  assert.equal((menu.match(/<svg/g) || []).length, (menu.match(/<svg[^>]*aria-hidden="true"/g) || []).length);
});
