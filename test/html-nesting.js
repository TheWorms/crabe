'use strict';

/**
 * Vérification d'imbrication de balises, partagée par les tests du front.
 *
 * Un `</div>` en trop ou en moins casse toute une mise en page sans qu'aucun
 * autre contrôle ne s'en aperçoive — et aucun navigateur n'est disponible ici
 * pour le voir.
 */

/** Balises sans fermeture (HTML et SVG confondus). */
const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'col', 'source',
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop',
]);

/**
 * @param {string} html fragment à contrôler
 * @returns {string[]} anomalies trouvées, vide si tout est bien imbriqué
 */
function nestingErrors(html) {
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');

  const stack = [];
  const errors = [];

  for (const m of cleaned.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, , selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (!closing) {
      stack.push(tag);
      continue;
    }
    if (!stack.length) errors.push(`</${tag}> sans ouverture`);
    else if (stack[stack.length - 1] !== tag) errors.push(`</${tag}> ferme un <${stack.pop()}>`);
    else stack.pop();
  }

  for (const tag of stack) errors.push(`<${tag}> jamais fermé`);
  return errors;
}

module.exports = { nestingErrors, VOID_TAGS };
