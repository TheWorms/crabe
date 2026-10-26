'use strict';

/**
 * Ce que montrait la page quand une récupération s'est arrêtée (0.2.5).
 *
 * ─── Pourquoi ce module ──────────────────────────────────────────────────────
 *
 * Question posée le 26/10/2026 : « les logs que ça fournit sont assez
 * explicites pour corriger un bug ? » Mesuré sur une vraie erreur Playwright :
 * non, pas pour la panne la plus fréquente d'un connecteur, un site qui change
 * ou qui montre autre chose. Le rapport disait « TimeoutError —
 * locator.waitFor: Timeout 30000ms exceeded » et la ligne du connecteur ; ni
 * l'élément attendu (Playwright l'écrit à la ligne suivante, que le rapport
 * coupait), ni ce que la page montrait à la place — un captcha, un bandeau de
 * cookies, un écran de code, une refonte. Pour corriger, il fallait un compte
 * sur ce service.
 *
 * ─── Ce qui est relevé ───────────────────────────────────────────────────────
 *
 * Pour chaque page ouverte, JUSTE AVANT que le connecteur ne ferme son
 * navigateur — sur un échec, c'est l'état de la page au moment de l'arrêt :
 *
 *   - son adresse masquée (hôte et chemin, identifiants masqués) et le statut
 *     HTTP de son document ;
 *   - son titre, ses premiers intertitres et les messages qu'elle affiche en
 *     alerte — courts, nombres de quatre chiffres ou plus masqués, salutations
 *     écartées (« Bonjour … » porte un nom) ;
 *   - les obstacles connus : captcha, vérification anti-robot, bandeau de
 *     cookies, formulaire de connexion, demande de code ;
 *   - le compte de ce qui est visible : liens, boutons, formulaires, champs,
 *     cadres.
 *
 * Et le parcours du passage : les pages successives, masquées, avec leur
 * statut — « où il en était » quand il s'est arrêté.
 *
 * Jamais : la valeur d'un champ, le HTML, une capture d'écran, un cookie, la
 * requête ou le fragment d'une adresse. Le rapport repasse en plus chaque
 * ligne dans son anonymisation (noms de compte, e-mails, téléphones, IP,
 * jetons) — rapport-echec.js.
 *
 * ─── Comment, sans retoucher un seul connecteur ─────────────────────────────
 *
 * Par l'accroche que le lot 110 pose déjà sur Playwright pour chaque passage
 * (site-hors-ligne.js) : chaque contexte de navigateur ouvert pendant une
 * récupération est suivi, et sa fermeture — par le contexte ou par le
 * navigateur — relève d'abord ses pages. Hors d'une récupération suivie, rien.
 * Le relevé est borné (deux secondes par page) et ne peut jamais empêcher la
 * fermeture.
 */

const navigation = require('./releve-navigation');
const journal = require('./journal-de-passage');

/** Le temps laissé à une page pour se décrire, avant de la fermer quand même. */
const DELAI_RELEVE_MS = 2000;
/** Les dernières vues gardées pour un passage. */
const VUES_GARDEES = 3;
/** Les dernières pages du parcours gardées pour un passage. */
const PARCOURS_GARDE = 10;
/** 0.2.6 : la taille au plus d'un HTML nettoyé (caractères). */
const HTML_MAX = 600_000;
/** 0.2.6 : les pièces gardées pour un passage — à l'arrêt, et en mode détaillé. */
const PIECES_A_L_ARRET = 8;
const PIECES_EN_DETAIL = 60;
/** 0.2.6 : en mode détaillé, le temps laissé à une page chargée pour se dessiner avant sa capture. */
const DESSIN_AVANT_CAPTURE_MS = 1500;

/**
 * Exécutée DANS la page : sa description, sans aucune valeur de champ.
 * Autonome (Playwright la sérialise) : aucune variable extérieure.
 */
function lireLaPage() {
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
    } catch {
      return false;
    }
  };
  const tous = (selecteur) => {
    try {
      return [...document.querySelectorAll(selecteur)];
    } catch {
      return [];
    }
  };
  const visibles = (selecteur) => tous(selecteur).filter(visible);
  const SALUTATION = /^(bonjour|bonsoir|salut|hello|hi|hey|bienvenue|welcome)\b/i;
  const court = (texte, max) => {
    const t = String(texte || '').replace(/\s+/g, ' ').trim().replace(/\d{4,}/g, '####');
    if (!t || SALUTATION.test(t) || t.includes('@')) return null;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const textes = (elements, nombre, max) => {
    const sortie = [];
    for (const el of elements) {
      const t = court(el.innerText || el.textContent, max);
      if (t && !sortie.includes(t)) sortie.push(t);
      if (sortie.length >= nombre) break;
    }
    return sortie;
  };

  const obstacles = [];
  const cadres = tous('iframe');
  const decritCadre = (f) => `${f.getAttribute('src') || ''} ${f.getAttribute('title') || ''}`;
  const CAPTCHAS = [
    ['reCAPTCHA', /recaptcha/i, '.g-recaptcha'],
    ['hCaptcha', /hcaptcha/i, '.h-captcha'],
    ['Turnstile', /turnstile|challenges\.cloudflare\.com/i, '.cf-turnstile'],
    ['Arkose', /arkoselabs|funcaptcha/i, '#arkose, [data-arkose]'],
    ['DataDome', /datadome|captcha-delivery/i, '#ddChallenge'],
    ['GeeTest', /geetest/i, '.geetest_holder'],
    ['PerimeterX', /perimeterx|px-captcha/i, '#px-captcha'],
  ];
  for (const [nom, motif, selecteur] of CAPTCHAS) {
    if (cadres.some((f) => motif.test(decritCadre(f))) || tous(selecteur).length) obstacles.push(`captcha (${nom})`);
  }
  const corps = (document.body && (document.body.innerText || document.body.textContent)) || '';
  if (!obstacles.length && /captcha|pas un robot|not a robot|êtes(-vous)? (un )?humain|are you (a )?human|verify you are human/i.test(corps)) {
    obstacles.push('demande de prouver qu\'on n\'est pas un robot');
  }
  if (/just a moment|un instant|attention required|checking your browser|vérification de (votre )?navigateur/i.test(document.title || '')
      || tous('#challenge-form, #cf-challenge-running, script[src*="challenge-platform"]').length) {
    obstacles.push('vérification anti-robot (Cloudflare)');
  }
  const BANDEAUX = '#onetrust-banner-sdk, #didomi-host, #didomi-popup, #axeptio_overlay, #tarteaucitronRoot, '
    + '#CybotCookiebotDialog, #usercentrics-root, .qc-cmp2-container, [id*="cookie" i], [class*="cookie" i], '
    + '[id*="consent" i], [class*="consent" i]';
  if (tous(BANDEAUX).some((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 120 && r.height > 40;
  })) obstacles.push('bandeau de cookies');
  if (visibles('input[type="password"]').length) obstacles.push('formulaire de connexion (mot de passe demandé)');
  const codes = visibles('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], '
    + 'input[name*="totp" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]')
    // Un code postal ou un code promo n'est pas une validation en deux étapes.
    .filter((el) => !/post|zip|promo|coupon|cadeau|gift|voucher/i.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`))
    .filter((el) => el.getAttribute('autocomplete') === 'one-time-code'
      || (Number(el.getAttribute('maxlength')) > 0 && Number(el.getAttribute('maxlength')) <= 8));
  if (codes.length) obstacles.push('demande de code (validation en deux étapes)');
  // Presque rien à lire ET rien à toucher : un écran de code a peu de texte,
  // mais un champ.
  if (corps.replace(/\s+/g, '').length < 20 && !visibles('input, button, a[href], iframe, img, canvas').length) {
    obstacles.push('page presque vide');
  }

  return {
    titre: court(document.title, 120),
    intertitres: textes(visibles('h1, h2'), 4, 80),
    alertes: textes(visibles('[role="alert"], [role="alertdialog"], [aria-live="assertive"], .alert-danger, '
      + '.alert-error, .error-message, .message-error, .flash-error, .notification-error, .invalid-feedback'), 3, 120),
    obstacles,
    langue: (document.documentElement.getAttribute('lang') || '').slice(0, 10),
    compte: {
      liens: visibles('a[href]').length,
      boutons: visibles('button, [role="button"], input[type="submit"], input[type="button"]').length,
      formulaires: visibles('form').length,
      champs: visibles('input:not([type="hidden"]), select, textarea').length,
      cadres: cadres.filter(visible).length,
    },
  };
}

/**
 * Exécutée DANS la page (0.2.6) : chaque sélecteur que le connecteur y a
 * cherché, compté ; pour un sélecteur absent, ce qui lui ressemble — les
 * éléments dont une classe, l'identifiant ou un nom d'attribut porte l'un de
 * ses mots (« table.orders absente ; 3 div.order-card »). Autonome.
 */
function examinerLesSelecteurs(selecteurs) {
  const GENERIQUES = new Set(['data', 'selector', 'select', 'type', 'href', 'name', 'class', 'value', 'true', 'false',
    'none', 'html', 'body', 'button', 'input', 'table', 'span', 'form', 'link', 'item', 'list', 'text', 'title', 'main',
    'content', 'wrapper', 'container', 'first', 'last', 'child', 'visible', 'hidden', 'role', 'aria', 'label',
    'option', 'checked', 'disabled', 'contains', 'internal', 'control', 'enter', 'frame']);
  const masque = (v) => String(v).replace(/\d{4,}/g, '####');
  const elements = [...document.querySelectorAll('*')].slice(0, 8000).map((el) => {
    const tag = el.tagName.toLowerCase();
    const parts = [];
    for (const c of el.classList || []) parts.push(['.', c]);
    if (el.id) parts.push(['#', el.id]);
    for (const a of el.getAttributeNames()) if (a !== 'class' && a !== 'id' && a !== 'style') parts.push(['[', a]);
    return { tag, parts };
  });
  const proches = (selecteur) => {
    const mots = [...new Set((String(selecteur).match(/[A-Za-z][A-Za-z0-9]*/g) || [])
      .flatMap((m) => m.split(/(?=[A-Z])/))
      .map((m) => m.toLowerCase())
      .filter((m) => m.length >= 4 && !GENERIQUES.has(m)))];
    const racines = mots.map((m) => m.slice(0, 5));
    if (!racines.length) return [];
    const comptes = new Map();
    for (const { tag, parts } of elements) {
      for (const [genre, nom] of parts) {
        const bas = nom.toLowerCase();
        if (!racines.some((r) => bas.includes(r))) continue;
        const cle = genre === '[' ? `${tag}[${masque(nom)}]` : `${tag}${genre}${masque(nom)}`;
        comptes.set(cle, (comptes.get(cle) || 0) + 1);
        break;
      }
    }
    return [...comptes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cle, n]) => ({ cle, n }));
  };
  return selecteurs.map((s) => {
    let n = null;
    try {
      n = document.querySelectorAll(s).length;
    } catch {
      return { s, n: null, invalide: true };
    }
    return { s, n, proches: n === 0 ? proches(s) : [] };
  });
}

/** Exécutée DANS un cadre : le compte de chaque sélecteur. Autonome. */
function compterLesSelecteurs(selecteurs) {
  return selecteurs.map((s) => {
    try {
      return document.querySelectorAll(s).length;
    } catch {
      return null;
    }
  });
}

/**
 * Exécutée DANS la page (0.2.6) : sa structure, sans rien de ce qu'elle dit.
 * Chaque texte devient sa longueur (« [12 car.] ») ; les valeurs, adresses
 * (`href`, `src`…), `data-*` et attributs inconnus sont vidés — leur NOM
 * reste, c'est lui qui sert de repère ; balises, classes, identifiants, rôles
 * et `aria-label` sont gardés, nombres de quatre chiffres ou plus masqués.
 * Scripts et styles deviennent leur longueur. Autonome.
 */
function htmlNettoye(max) {
  const GARDES = new Set(['id', 'class', 'name', 'type', 'role', 'for', 'tabindex', 'method', 'target', 'rel', 'lang', 'charset',
    'dir', 'colspan', 'rowspan', 'scope', 'autocomplete', 'inputmode', 'maxlength', 'minlength', 'multiple', 'required',
    'readonly', 'disabled', 'checked', 'selected', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'aria-selected',
    'aria-live', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-current', 'aria-haspopup', 'aria-modal',
    'aria-busy', 'aria-disabled', 'aria-checked', 'aria-pressed', 'aria-level', 'aria-orientation']);
  const EN_LONGUEUR = new Set(['title', 'alt', 'placeholder', 'aria-description', 'aria-valuetext', 'aria-placeholder',
    'label', 'summary']);
  const SANS_FIN = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const EN_BLOC = new Set(['script', 'style', 'noscript', 'template', 'textarea']);
  const masque = (v) => String(v).replace(/\d{4,}/g, '####');
  const echapper = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let sortie = '';
  let tronque = false;
  const ajouter = (t) => {
    if (sortie.length + t.length > max) {
      tronque = true;
      return false;
    }
    sortie += t;
    return true;
  };
  const attributs = (el) => el.getAttributeNames().map((nom) => {
    const bas = nom.toLowerCase();
    const v = el.getAttribute(nom) ?? '';
    if (bas === 'aria-label') return ` ${nom}="${echapper(masque(v).replace(/\S+@\S+/g, '[e-mail]').slice(0, 120))}"`;
    if (GARDES.has(bas)) return v === '' ? ` ${nom}` : ` ${nom}="${echapper(masque(v).slice(0, 200))}"`;
    if (EN_LONGUEUR.has(bas)) return ` ${nom}="[${v.length} car.]"`;
    return ` ${nom}=""`;
  }).join('');
  const parcourir = (noeud, profondeur) => {
    if (tronque || profondeur > 80) return;
    if (noeud.nodeType === 3) {
      const t = (noeud.nodeValue || '').trim();
      if (t) ajouter(`[${t.length} car.]`);
      return;
    }
    if (noeud.nodeType !== 1) return;
    const tag = noeud.tagName.toLowerCase();
    if (!ajouter(`\n${' '.repeat(Math.min(profondeur, 40))}<${tag}${attributs(noeud)}>`)) return;
    if (SANS_FIN.has(tag)) return;
    if (EN_BLOC.has(tag)) {
      const t = noeud.textContent || '';
      if (t.length) ajouter(`[${t.length} car.]`);
    } else if (tag === 'svg') {
      ajouter('[dessin]');
    } else {
      for (const enfant of noeud.childNodes) parcourir(enfant, profondeur + 1);
      if (noeud.shadowRoot) {
        ajouter('<!-- racine fantôme -->');
        for (const enfant of noeud.shadowRoot.childNodes) parcourir(enfant, profondeur + 1);
      }
    }
    ajouter(`</${tag}>`);
  };
  parcourir(document.documentElement, 0);
  return `<!doctype html>\n<!-- crabe : la structure de la page, textes remplacés par leur longueur, valeurs et adresses vidées -->${sortie}${tronque ? '\n<!-- … tronqué -->' : ''}\n`;
}

/** 0.2.6 : la feuille qui efface, le temps d'une capture, chaque texte et chaque image. */
const STYLE_EFFACE = [
  '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important;',
  '  text-shadow: none !important; caret-color: transparent !important; background-image: none !important; }',
  // Une image : son contenu sort de sa boîte, la boîte reste en aplat gris.
  // Un filtre ne suffit pas (essayé : une silhouette garde la forme des
  // lettres d'un logo, et un cadre au fond transparent laissait lire son
  // texte) ; les cadres reçoivent donc cette même feuille.
  'img, video { object-position: -100000px -100000px !important; background: #d8d8d8 !important; }',
  'svg, canvas, embed, object { opacity: 0 !important; }',
  'iframe { background: #eeeeee !important; }',
  '::marker { color: transparent !important; }',
  '::placeholder { color: transparent !important; }',
].join('\n');

/** `evaluate` sans passer par le journal : les lectures de crabe ne sont pas celles du connecteur. */
function evaluerSansCompter(cadre, fonction, arg) {
  const original = journal.ORIGINAUX.evaluateDeCadre;
  return original ? original.call(cadre, fonction, arg) : cadre.evaluate(fonction, arg);
}

/**
 * 0.2.6 : la capture de la page où chaque texte et chaque image sont effacés —
 * la mise en page reste (blocs, bordures, fonds, emplacements des images),
 * rien n'y est lisible. Une vraie capture montrerait des noms et des
 * commandes.
 */
async function captureEffacee(page) {
  let cadres = [];
  try {
    cadres = page.frames().slice(0, 20);
  } catch {
    cadres = [page.mainFrame()];
  }
  const poses = await Promise.all(cadres.map((cadre) => borne(evaluerSansCompter(cadre, (css) => {
    const s = document.createElement('style');
    s.id = '__crabe_efface__';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return true;
  }, STYLE_EFFACE), 1500).catch(() => null)));
  try {
    // Un cadre qui n'a pas reçu la feuille laisserait lire son texte : pas de capture.
    if (poses.some((p) => p !== true)) return null;
    return await borne(page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000, animations: 'disabled', caret: 'hide' }), 5000);
  } finally {
    await Promise.all(cadres.map((cadre) => borne(evaluerSansCompter(cadre, () => document.getElementById('__crabe_efface__')?.remove()), 1500).catch(() => {})));
  }
}

/** Les cadres web d'une page (iframe), au plus `max`. */
function cadresDe(page, max = 5) {
  try {
    return page.frames()
      .filter((f) => f !== page.mainFrame())
      .filter((f) => /^https?:/.test(f.url()))
      .slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 0.2.6 : les pièces d'une page — son HTML nettoyé, celui de ses cadres, sa
 * capture effacée. Ne lève jamais ; une pièce illisible manque, simplement.
 */
async function piecesDeLaPage(page, vue, passage, moment) {
  passage.rangPieces = (passage.rangPieces || 0) + 1;
  const base = `${String(passage.rangPieces).padStart(2, '0')}-${moment}-${journal.natureDeLaPage(vue.adresse, vue)}`;
  const pieces = [];
  try {
    const html = await borne(evaluerSansCompter(page.mainFrame(), htmlNettoye, HTML_MAX), 5000);
    if (typeof html === 'string') pieces.push({ nom: `${base}.html`, type: 'text/html; charset=utf-8', contenu: html, adresse: vue.adresse });
  } catch { /* page tombée */ }
  let i = 0;
  for (const cadre of cadresDe(page, 3)) {
    i += 1;
    try {
      const html = await borne(evaluerSansCompter(cadre, htmlNettoye, Math.floor(HTML_MAX / 3)), 3000);
      if (typeof html === 'string') {
        pieces.push({ nom: `${base}-cadre-${i}.html`, type: 'text/html; charset=utf-8', contenu: html, adresse: navigation.adresseMasquee(cadre.url()) });
      }
    } catch { /* cadre tombé */ }
  }
  try {
    const image = await captureEffacee(page);
    if (image) pieces.push({ nom: `${base}.jpg`, type: 'image/jpeg', contenu: image, adresse: vue.adresse });
  } catch { /* capture impossible */ }
  return pieces;
}

/** Une promesse qui ne dure pas plus de `ms` (rend `null` au-delà), sans retenir le processus. */
function borne(promesse, ms) {
  let minuterie;
  const delai = new Promise((resoudre) => {
    minuterie = setTimeout(() => resoudre(null), ms);
    minuterie.unref?.();
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuterie));
}

/**
 * La vue d'une page ouverte. Ne lève jamais. `selecteurs` (0.2.6) : ce que le
 * connecteur a cherché sur cette page — compté, avec ce qui lui ressemble
 * quand il manque, et sa présence dans les cadres.
 */
async function capturer(page, { statut = null, delaiMs = DELAI_RELEVE_MS, selecteurs = [] } = {}) {
  let adresse = '(adresse illisible)';
  try {
    adresse = navigation.adresseMasquee(page.url());
  } catch { /* adresse illisible */ }
  let lu = null;
  try {
    lu = await borne(evaluerSansCompter(page.mainFrame(), lireLaPage), delaiMs);
  } catch {
    lu = null;
  }
  const vue = { adresse, statut, ...(lu || { illisible: true }) };
  // 0.2.6 : les textes de la page réduits à leurs mots usuels — un titre peut
  // porter le nom d'une organisation, une alerte celui d'une personne.
  if (lu) {
    const hote = adresse.split('/')[0];
    const repere = (t) => (t ? journal.texteDeRepere(t, { hote }) : t);
    vue.titre = repere(vue.titre);
    vue.intertitres = (vue.intertitres || []).map(repere).filter((t, i, tous) => t && t !== '…' && tous.indexOf(t) === i);
    vue.alertes = (vue.alertes || []).map(repere).filter((t, i, tous) => t && t !== '…' && tous.indexOf(t) === i);
  }
  if (lu && selecteurs.length) {
    try {
      const examen = await borne(evaluerSansCompter(page.mainFrame(), examinerLesSelecteurs, selecteurs), delaiMs);
      if (Array.isArray(examen)) {
        for (const cadre of cadresDe(page)) {
          const comptes = await borne(evaluerSansCompter(cadre, compterLesSelecteurs, selecteurs), 1500).catch(() => null);
          if (!Array.isArray(comptes)) continue;
          comptes.forEach((n, i) => {
            if (n > 0) (examen[i].cadres ??= []).push({ adresse: navigation.adresseMasquee(cadre.url()), n });
          });
        }
        vue.selecteurs = examen;
      }
    } catch { /* examen impossible : la vue reste */ }
  }
  return vue;
}

function garderLesDerniers(liste, max) {
  while (liste.length > max) liste.shift();
}

/**
 * Relève chaque page d'un contexte avant sa fermeture. Ne lève jamais.
 * 0.2.6 : la visite en cours de chaque page part d'abord au journal
 * (journal-de-passage.clore), puis la vue et les pièces sont prises — sur un
 * échec, c'est l'état de la page à l'arrêt. Les pièces restent en mémoire ;
 * le registre ne les garde que pour une récupération en échec, ou détaillée.
 */
async function releverAvantFermeture(contexte, passage) {
  if (!passage || !contexte || contexte.__crabeReleve) return;
  try {
    Object.defineProperty(contexte, '__crabeReleve', { value: true });
  } catch { /* objet gelé : on relève quand même */ }
  let lus = new Map();
  try {
    lus = await journal.clore(contexte, passage);
  } catch { /* le journal des pages manque : la vue reste */ }
  let pages = [];
  try {
    pages = contexte.pages?.() || [];
  } catch {
    pages = [];
  }
  passage.vues ??= [];
  passage.pieces ??= [];
  for (const page of pages) {
    try {
      if (page.isClosed?.()) continue;
      if (/^about:/.test(page.url())) continue;
    } catch {
      continue;
    }
    const vue = await capturer(page, { statut: contexte.__crabeStatuts?.get(page) ?? null, selecteurs: lus.get(page) || [] });
    passage.vues.push(vue);
    garderLesDerniers(passage.vues, VUES_GARDEES);
    // Les pièces coûtent jusqu'à une seconde : seulement quand la page a un
    // sélecteur absent ou en erreur — le cas d'une lecture qui échoue —, quand
    // on ne sait rien de ce qu'elle cherchait, ou en mode détaillé. Une
    // récupération qui a tout trouvé n'en paie pas le prix.
    const manque = !vue.selecteurs?.length || vue.selecteurs.some((x) => x.invalide || x.n === 0);
    if (!vue.illisible && (manque || passage.detail) && passage.pieces.length < (passage.detail ? PIECES_EN_DETAIL : PIECES_A_L_ARRET)) {
      passage.pieces.push(...await piecesDeLaPage(page, vue, passage, 'arret'));
    }
  }
}

/**
 * 0.2.6, mode détaillé (`crabe recuperer <service> --detail`) : à chaque page
 * chargée, après un court temps de dessin, sa vue au journal et ses pièces.
 */
async function captureDEtape(page, passage, { immediate = false, visite = null } = {}) {
  if (!passage?.detail) return;
  passage.pieces ??= [];
  if (passage.pieces.length >= PIECES_EN_DETAIL) return;
  if (!immediate) {
    await new Promise((r) => setTimeout(r, DESSIN_AVANT_CAPTURE_MS).unref?.());
    if (page.isClosed?.()) return;
    // Entre-temps, la page a pu être quittée (et capturée à son départ) ou
    // changer : on ne capture que la visite qui a déclenché l'attente.
    if (visite && journal.visiteCourante(page) !== visite) return;
    if (!journal.marquerLaCapture(page)) return;
  }
  const vue = await capturer(page, { selecteurs: journal.selecteursDeLaPage(page) });
  if (vue.illisible) return;
  for (const ligne of [phraseDeVue(vue).replace('à l\'arrêt', 'à cette étape'), phraseDesSelecteurs(vue)].filter(Boolean)) {
    try {
      passage.log?.(ligne);
    } catch { /* journal fermé */ }
  }
  passage.pieces.push(...await piecesDeLaPage(page, vue, passage, 'etape'));
}

/**
 * Suit un contexte de navigateur pour un passage : le parcours (navigation
 * de la page principale, statut de son document) et, à la fermeture, la vue
 * de ses pages. Une accroche ne doit jamais empêcher un navigateur de servir.
 */
function suivre(contexte, passage) {
  if (!passage || !contexte?.on || contexte.__crabeVue) return contexte;
  // 0.2.6 : le journal page par page (journal-de-passage.js), par la même accroche.
  try {
    journal.suivreContexte(contexte, passage);
  } catch { /* le journal est un plus, jamais une condition */ }
  try {
    Object.defineProperty(contexte, '__crabeVue', { value: true });
    Object.defineProperty(contexte, '__crabeStatuts', { value: new WeakMap() });
  } catch {
    return contexte;
  }
  passage.parcours ??= [];
  const statuts = contexte.__crabeStatuts;

  const suivrePage = (page) => {
    try {
      page.on('framenavigated', (cadre) => {
        try {
          if (cadre !== page.mainFrame()) return;
          const adresse = navigation.adresseMasquee(cadre.url());
          if (adresse === '(adresse non web)' || adresse === '(adresse illisible)') return;
          const statut = statuts.get(page) ?? null;
          const dernier = passage.parcours.at(-1);
          if (dernier && dernier.adresse === adresse) {
            dernier.statut = statut ?? dernier.statut;
            return;
          }
          passage.parcours.push({ adresse, statut });
          garderLesDerniers(passage.parcours, PARCOURS_GARDE);
        } catch { /* une navigation illisible ne compte pas */ }
      });
    } catch { /* page sans évènements */ }
  };

  try {
    for (const page of contexte.pages?.() || []) suivrePage(page);
    contexte.on('page', suivrePage);
    contexte.on('response', (reponse) => {
      try {
        const requete = reponse.request();
        if (!requete.isNavigationRequest()) return;
        const cadre = requete.frame();
        const page = cadre.page();
        if (cadre === page.mainFrame()) statuts.set(page, reponse.status());
      } catch { /* une réponse illisible ne compte pas */ }
    });
  } catch { /* contexte sans évènements */ }

  if (typeof contexte.close === 'function') {
    const fermer = contexte.close.bind(contexte);
    contexte.close = async (...options) => {
      await releverAvantFermeture(contexte, passage);
      return fermer(...options);
    };
  }
  return contexte;
}

/**
 * La même chose pour un navigateur entier : `browser.close()` ferme ses
 * contextes sans passer par leur `close()`, il faut donc relever avant.
 */
function suivreNavigateur(navigateur, passageCourant) {
  if (!navigateur || typeof navigateur.close !== 'function' || navigateur.__crabeVue) return navigateur;
  try {
    Object.defineProperty(navigateur, '__crabeVue', { value: true });
  } catch {
    return navigateur;
  }
  const fermer = navigateur.close.bind(navigateur);
  navigateur.close = async (...options) => {
    const passage = passageCourant();
    if (passage) {
      let contextes = [];
      try {
        contextes = navigateur.contexts?.() || [];
      } catch {
        contextes = [];
      }
      for (const contexte of contextes) await releverAvantFermeture(contexte, passage);
    }
    return fermer(...options);
  };
  return navigateur;
}

// ---------------------------------------------------------------------------
// Les phrases du journal
// ---------------------------------------------------------------------------

const citer = (t) => `« ${t} »`;

/** Une vue, en une ligne de journal. */
function phraseDeVue(vue) {
  const morceaux = [`${vue.adresse}${vue.statut ? ` (HTTP ${vue.statut})` : ''}`];
  if (vue.illisible) {
    morceaux.push('la page n\'a pas pu être lue (fermée, figée ou plantée)');
    return `Ce que montrait la page à l'arrêt : ${morceaux.join(' — ')}.`;
  }
  if (vue.titre) morceaux.push(`titre ${citer(vue.titre)}`);
  if (vue.intertitres?.length) morceaux.push(`intertitres ${vue.intertitres.map(citer).join(', ')}`);
  morceaux.push(vue.obstacles?.length ? `obstacle(s) : ${vue.obstacles.join(', ')}` : 'aucun obstacle connu (captcha, cookies, connexion, code)');
  if (vue.alertes?.length) morceaux.push(`message(s) affiché(s) ${vue.alertes.map(citer).join(', ')}`);
  const c = vue.compte || {};
  morceaux.push(`${c.liens ?? 0} lien(s), ${c.boutons ?? 0} bouton(s), ${c.formulaires ?? 0} formulaire(s), `
    + `${c.champs ?? 0} champ(s), ${c.cadres ?? 0} cadre(s) visibles`);
  if (vue.langue) morceaux.push(`langue ${vue.langue}`);
  return `Ce que montrait la page à l'arrêt : ${morceaux.join(' — ')}.`;
}

/** Le parcours, en une ligne de journal, ou null. */
function phraseDeParcours(parcours) {
  if (!parcours?.length) return null;
  return `Pages parcourues (${parcours.length} dernière(s)) : `
    + `${parcours.map((p) => `${p.adresse}${p.statut ? ` (${p.statut})` : ''}`).join(' → ')}.`;
}

/**
 * 0.2.6 : ce que crabe cherchait sur la page, et ce qu'il a trouvé à la place
 * — « table.orders → 0 (à la place : 3 div.order-card) ». Null sans sélecteur.
 */
function phraseDesSelecteurs(vue) {
  if (!vue?.selecteurs?.length) return null;
  const morceaux = vue.selecteurs.map((s) => {
    const nom = journal.selecteurPropre(s.s, { hote: vue.adresse.split('/')[0] });
    if (s.invalide) return `${nom} → illisible par le navigateur`;
    let t = `${nom} → ${s.n}`;
    if (s.n === 0 && s.proches?.length) t += ` (à la place : ${s.proches.map((p) => `${p.n} ${p.cle}`).join(', ')})`;
    if (s.cadres?.length) t += ` (dans ${s.cadres.map((c) => `le cadre ${c.adresse} : ${c.n}`).join(', ')})`;
    return t;
  });
  return `Ce que crabe cherchait sur ${vue.adresse} : ${morceaux.join(' ; ')}.`;
}

/** Les lignes que le planificateur ajoute au journal d'une récupération en échec. */
function lignesDuPassage({ vues = [], parcours = [] } = {}) {
  const lignes = [];
  const chemin = phraseDeParcours(parcours);
  if (chemin) lignes.push(chemin);
  for (const vue of vues) {
    lignes.push(phraseDeVue(vue));
    const cherche = phraseDesSelecteurs(vue);
    if (cherche) lignes.push(cherche);
  }
  return lignes;
}

module.exports = {
  DELAI_RELEVE_MS,
  VUES_GARDEES,
  PARCOURS_GARDE,
  lireLaPage,
  examinerLesSelecteurs,
  htmlNettoye,
  STYLE_EFFACE,
  captureEffacee,
  piecesDeLaPage,
  captureDEtape,
  phraseDesSelecteurs,
  capturer,
  releverAvantFermeture,
  suivre,
  suivreNavigateur,
  phraseDeVue,
  phraseDeParcours,
  lignesDuPassage,
};
