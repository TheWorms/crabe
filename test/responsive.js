'use strict';

/**
 * Détecteur de débordement horizontal, sans navigateur.
 *
 * Aucun navigateur n'est disponible ici : impossible de mesurer une mise en
 * page. Ce module fait la seule chose vérifiable statiquement, et c'est celle
 * qui casse le plus souvent un écran étroit — **une largeur figée en pixels
 * plus grande que la place disponible**.
 *
 * Il lit `web/style.css` (media queries comprises), reconstruit l'arbre du
 * HTML rendu, résout pour chaque élément les propriétés `width`, `min-width`,
 * `max-width`, `padding` et `overflow-x` applicables à une largeur d'écran
 * donnée, puis signale tout élément qui exige plus de place qu'il n'y en a.
 *
 * Ce qu'il NE fait PAS, et qu'aucun test de ce dépôt ne peut faire :
 *   - mesurer un texte, une image ou une police ;
 *   - simuler flexbox et grid autrement que par les largeurs déclarées ;
 *   - juger de l'esthétique, des couleurs ou de la lisibilité.
 *
 * Autrement dit : il attrape « .modal fait 440 px sur un écran de 360 », pas
 * « cette colonne est trop serrée ». La relecture à l'œil reste nécessaire.
 */

const { VOID_TAGS } = require('./html-nesting');

/** Marge d'un ou deux pixels : bordures, arrondis. */
const TOLERANCE = 2;

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Découpe une liste en respectant les parenthèses (min(), calc(), repeat()). */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseDeclarations(block) {
  const declarations = {};
  for (const chunk of splitTopLevel(block, ';')) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (property) declarations[property] = value;
  }
  return declarations;
}

/** `(min-width:640px) and (max-width:1023px)` → { min: 640, max: 1023 } */
function parseMediaCondition(condition) {
  const min = /min-width\s*:\s*(\d+)px/.exec(condition);
  const max = /max-width\s*:\s*(\d+)px/.exec(condition);
  return {
    min: min ? Number(min[1]) : null,
    max: max ? Number(max[1]) : null,
    // Une media query qu'on ne sait pas lire (print, hover…) est ignorée
    // plutôt qu'appliquée à tort.
    understood: !!(min || max),
    raw: condition.trim(),
  };
}

/**
 * Analyse une feuille de style en règles plates.
 * @returns {Array<{media: object|null, selector: string, declarations: object}>}
 */
function parseCss(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];

  /** @param {string} text @param {object|null} media */
  function walk(text, media) {
    let index = 0;
    while (index < text.length) {
      const brace = text.indexOf('{', index);
      if (brace === -1) break;

      const prelude = text.slice(index, brace).trim();

      // Trouve l'accolade fermante correspondante.
      let depth = 1;
      let cursor = brace + 1;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '{') depth++;
        if (text[cursor] === '}') depth--;
        cursor++;
      }
      const body = text.slice(brace + 1, cursor - 1);
      index = cursor;

      if (prelude.startsWith('@media')) {
        walk(body, parseMediaCondition(prelude.slice(6)));
        continue;
      }
      if (prelude.startsWith('@')) continue; // @keyframes et consorts

      const declarations = parseDeclarations(body);
      for (const selector of splitTopLevel(prelude, ',')) {
        const trimmed = selector.trim();
        if (trimmed) rules.push({ media, selector: trimmed, declarations });
      }
    }
  }

  walk(clean, null);
  return rules;
}

/** Règles applicables à une largeur d'écran donnée. */
function activeRules(rules, viewport) {
  return rules.filter(({ media }) => {
    if (!media) return true;
    if (!media.understood) return false;
    if (media.min !== null && viewport < media.min) return false;
    if (media.max !== null && viewport > media.max) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sélecteurs
// ---------------------------------------------------------------------------

/** `div.a.b#c:hover` → { tag, ids, classes } ; les pseudo-classes sont ignorées. */
function parseCompound(text) {
  const compound = { tag: null, ids: [], classes: [], nots: [], unsupported: false };

  // :not(.x) est pris en compte ; les autres pseudo-classes / éléments sont
  // retirés — ils restreignent l'application, jamais l'inverse.
  let rest = text.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    compound.nots.push(inner.trim());
    return '';
  });
  rest = rest.replace(/::?[a-z-]+(\([^)]*\))?/g, '');

  for (const token of rest.match(/[.#]?[^.#[\]]+|\[[^\]]*\]/g) || []) {
    if (token.startsWith('[')) {
      // Sélecteur d'attribut : on ne sait pas le résoudre ici.
      compound.unsupported = true;
    } else if (token.startsWith('.')) compound.classes.push(token.slice(1));
    else if (token.startsWith('#')) compound.ids.push(token.slice(1));
    else if (token.trim()) compound.tag = token.trim().toLowerCase();
  }
  return compound;
}

function matchesCompound(compound, node) {
  if (compound.unsupported) return false;
  if (compound.tag && compound.tag !== '*' && compound.tag !== node.tag) return false;
  if (compound.ids.some((id) => id !== node.id)) return false;
  if (compound.classes.some((c) => !node.classes.has(c))) return false;
  for (const not of compound.nots) {
    if (matchesCompound(parseCompound(not), node)) return false;
  }
  return true;
}

/**
 * Le sélecteur s'applique-t-il au nœud ?
 * `>` est traité comme un descendant : approximation volontairement
 * permissive, elle ne peut que faire remonter plus d'alertes, jamais moins.
 */
function matchesSelector(selector, node) {
  const parts = selector
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s*\+\s*/g, ' ')
    .replace(/\s*~\s*/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(parseCompound);

  if (!parts.length) return false;
  if (!matchesCompound(parts[parts.length - 1], node)) return false;

  let current = node.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (current) {
      if (matchesCompound(parts[i], current)) {
        found = true;
        current = current.parent;
        break;
      }
      current = current.parent;
    }
    if (!found) return false;
  }
  return true;
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length;
  const tags = selector.split(/[\s>+~]+/).filter((p) => /^[a-zA-Z]/.test(p)).length;
  return ids * 10000 + classes * 100 + tags;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Construit l'arbre d'un fragment HTML. Les balises SVG sont ignorées. */
function parseHtml(html) {
  const root = { tag: ':root', id: null, classes: new Set(), inline: {}, parent: null, children: [] };
  const stack = [root];
  let inSvg = 0;

  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');

  for (const match of cleaned.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, attributes, selfClosing] = match;
    const tag = rawTag.toLowerCase();

    if (tag === 'svg') {
      if (closing) inSvg = Math.max(0, inSvg - 1);
      else if (!selfClosing) inSvg++;
      continue;
    }
    if (inSvg) continue;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const node = {
      tag,
      id: /\bid\s*=\s*"([^"]*)"/.exec(attributes)?.[1] || null,
      classes: new Set(
        (/\bclass\s*=\s*"([^"]*)"/.exec(attributes)?.[1] || '')
          .split(/\s+/)
          .filter(Boolean)
      ),
      inline: parseDeclarations(/\bstyle\s*=\s*"([^"]*)"/.exec(attributes)?.[1] || ''),
      parent: stack[stack.length - 1],
      children: [],
    };
    node.parent.children.push(node);
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(node);
  }

  return root;
}

function walkNodes(node, visit) {
  for (const child of node.children) {
    visit(child);
    walkNodes(child, visit);
  }
}

// ---------------------------------------------------------------------------
// Résolution des largeurs
// ---------------------------------------------------------------------------

/** Style calculé d'un nœud : cascade simplifiée, puis style inline. */
function computeStyle(node, rules) {
  const applicable = rules
    .filter((rule) => matchesSelector(rule.selector, node))
    .sort((a, b) => specificity(a.selector) - specificity(b.selector));

  const style = {};
  for (const rule of applicable) Object.assign(style, rule.declarations);
  Object.assign(style, node.inline);
  return style;
}

/**
 * Valeur de largeur en pixels, ou null si elle s'adapte.
 *
 * `min()`, `%`, `vw`, `auto`, `calc()` et `max-content` s'adaptent par
 * construction : ils ne peuvent pas déborder d'un conteneur plus étroit.
 */
function fixedPixels(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (/min\(|%|vw|auto|calc\(|inherit|none|fit-content|max-content|min-content/.test(text)) {
    return null;
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(text);
  return px ? Number(px[1]) : null;
}

/** Somme des marges intérieures gauche + droite déclarées en pixels. */
function horizontalPadding(style) {
  let left = 0;
  let right = 0;

  if (style.padding) {
    const parts = style.padding.trim().split(/\s+/);
    const value = (index) => fixedPixels(parts[index]) || 0;
    if (parts.length === 1) left = right = value(0);
    else if (parts.length === 2) left = right = value(1);
    else if (parts.length === 3) left = right = value(1);
    else {
      right = value(1);
      left = value(3);
    }
  }
  if (style['padding-left']) left = fixedPixels(style['padding-left']) || 0;
  if (style['padding-right']) right = fixedPixels(style['padding-right']) || 0;
  return left + right;
}

/** `repeat(7, 84px)` ou `120px 240px` → place minimale exigée par la grille. */
function gridMinimumWidth(style) {
  const value = style['grid-template-columns'];
  if (!value || /minmax|auto|fr|min\(|%/.test(value)) return null;

  const repeat = /^repeat\(\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(value.trim());
  const gap = fixedPixels(style.gap?.split(/\s+/).pop()) || 0;
  if (repeat) {
    const count = Number(repeat[1]);
    return count * Number(repeat[2]) + (count - 1) * gap;
  }

  const columns = value.trim().split(/\s+/).map(fixedPixels);
  if (columns.length < 2 || columns.some((c) => c === null)) return null;
  return columns.reduce((sum, c) => sum + c, 0) + (columns.length - 1) * gap;
}

function isScrollable(style) {
  return /auto|scroll/.test(style['overflow-x'] || style.overflow || '');
}

/**
 * Cherche les éléments qui exigent plus de place que le conteneur n'en offre.
 *
 * @param {string} html fragment rendu
 * @param {{viewport: number, available: number, rules: Array}} context
 * @returns {Array<{selector: string, need: number, available: number, reason: string}>}
 */
function findOverflows(html, { viewport, available, rules }) {
  const active = activeRules(rules, viewport);
  const root = parseHtml(html);
  const findings = [];

  /** @param {object} node @param {number} space place offerte par le parent */
  function visit(node, space, scrollable) {
    const style = computeStyle(node, active);
    const label =
      (node.id ? `#${node.id}` : '') +
      (node.classes.size ? `.${[...node.classes].join('.')}` : '') ||
      `<${node.tag}>`;

    const maxWidth = fixedPixels(style['max-width']);
    // Un max-width relatif (100 %, min(), vw) borne déjà l'élément.
    const boundedByMax =
      (style['max-width'] && fixedPixels(style['max-width']) === null) ||
      (maxWidth !== null && maxWidth <= space + TOLERANCE);

    const candidates = [
      ['width', fixedPixels(style.width)],
      ['min-width', fixedPixels(style['min-width'])],
      ['grid-template-columns', gridMinimumWidth(style)],
    ];

    for (const [property, need] of candidates) {
      if (need === null) continue;
      // `min-width` n'est pas borné par `max-width` : il gagne.
      if (property === 'width' && boundedByMax) continue;
      if (need <= space + TOLERANCE) continue;
      if (scrollable) continue; // conteneur à défilement horizontal assumé
      findings.push({
        selector: label,
        property,
        need,
        available: space,
        reason: `${label} exige ${need} px (${property}) pour ${space} px disponibles`,
      });
    }

    const own = fixedPixels(style.width);
    let inner = own !== null && own < space ? own : space;
    if (maxWidth !== null && maxWidth < inner) inner = maxWidth;
    inner -= horizontalPadding(style);

    const childScrollable = scrollable || isScrollable(style);
    for (const child of node.children) visit(child, Math.max(0, inner), childScrollable);
  }

  for (const child of root.children) visit(child, available, false);
  return findings;
}

module.exports = {
  TOLERANCE,
  parseCss,
  activeRules,
  parseHtml,
  computeStyle,
  fixedPixels,
  horizontalPadding,
  gridMinimumWidth,
  findOverflows,
  walkNodes,
  matchesSelector,
};
