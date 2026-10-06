'use strict';

/**
 * Relevé de navigation — la chaîne des réponses d'un passage, dicible.
 *
 * ─── Pourquoi ce module existe (lot 87) ──────────────────────────────────────
 *
 * Les passages impots n° 638 et 639 (05/10/2026) ont échoué en deux secondes
 * sans laisser UNE ligne qui dise où le navigateur était arrivé : « aucune
 * année exposée par le site », et rien d'autre. Il a fallu une nuit de sondes
 * pour mesurer que la liste n'avait jamais été atteinte — le site renvoyait
 * vers sa page de déconnexion. Ce module enregistre, pour le cadre principal,
 * chaque réponse de navigation : statut, hôte et chemin, renvoi éventuel,
 * noms des cookies posés ou effacés. De quoi comprendre un échec sans sonde.
 *
 * ─── Ce qui ne sort JAMAIS d'ici ─────────────────────────────────────────────
 *
 * Aucune valeur : pas de chaîne de requête (un `idEnsua=…` est une clé
 * d'accès), pas de valeur de cookie, pas d'empreinte de valeur. Seuls des
 * CHEMINS sans leurs paramètres, des noms, des statuts. Les suites de six
 * chiffres ou plus dans un nom ou un chemin sont masquées : un identifiant
 * glissé là serait une donnée personnelle. Le formatage est une fonction
 * pure, testée — morsure comprise (lot 87, D1).
 *
 * ─── Technique (éprouvée à la main le 05/10/2026) ────────────────────────────
 *
 * `page.on('response')`, en ne gardant que `request().isNavigationRequest()`
 * du cadre principal ; `status()`, `headers().location` pour le renvoi, et
 * `headerValues('set-cookie')` — les `headers()` ordinaires de Playwright
 * n'exposent PAS `Set-Cookie`. Pour la différence d'état en fin de passage,
 * `context.cookies()` avant/après : les valeurs ne servent qu'à la
 * comparaison en mémoire, seuls les noms sont rendus.
 *
 * Posé dans le socle pour être réutilisable, mais branché sur le seul
 * connecteur impots dans le lot 87 : aucun autre connecteur ne change.
 */

/** Masque les suites de six chiffres ou plus : jamais un identifiant au journal. */
function masquerChiffres(texte) {
  return String(texte || '').replace(/\d{6,}/g, '…');
}

/**
 * La forme dicible d'une adresse : hôte et chemin, jamais la requête ni le
 * fragment. Une adresse illisible se dit telle quelle, sans rien en recopier.
 * @returns {{hote: string, chemin: string}}
 */
function formeAdresse(url, base = undefined) {
  try {
    const u = new URL(String(url || ''), base);
    return { hote: u.hostname, chemin: masquerChiffres(u.pathname) || '/' };
  } catch {
    return { hote: '', chemin: '(adresse illisible)' };
  }
}

/**
 * Les noms portés par des en-têtes `Set-Cookie`, et si chacun pose ou efface.
 * Un cookie s'efface par `Max-Age=0` (ou négatif) ou par une échéance passée.
 * Rien de la VALEUR ne sort : le nom s'arrête au premier `=`.
 *
 * @param {string[]} enTetes les valeurs brutes de `Set-Cookie`
 * @param {number} [maintenant] epoch ms, pour juger une échéance (tests)
 * @returns {{poses: string[], effaces: string[]}}
 */
function nomsDeCookies(enTetes, maintenant = Date.now()) {
  const poses = [];
  const effaces = [];
  for (const brut of Array.isArray(enTetes) ? enTetes : []) {
    const texte = String(brut || '');
    const nom = masquerChiffres(texte.split(';')[0].split('=')[0].trim());
    if (!nom) continue;
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(texte);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(texte);
    const efface =
      (maxAge && Number(maxAge[1]) <= 0)
      || (!maxAge && expires && (() => {
        const quand = Date.parse(expires[1].trim());
        return Number.isFinite(quand) && quand <= maintenant;
      })());
    (efface ? effaces : poses).push(nom);
  }
  return { poses, effaces };
}

/**
 * Une réponse de navigation, en une ligne de journal. Fonction PURE.
 *
 * @param {{statut: number|null, url: string, renvoi?: string|null,
 *          poses?: string[], effaces?: string[]}} reponse
 * @returns {string} p. ex. « 302 hote.test /chemin → hote.test /ailleurs ;
 *          cookies posés : a, b ; effacés : c »
 */
function formaterReponse(reponse) {
  const de = formeAdresse(reponse?.url);
  let ligne = `${reponse?.statut ?? '???'} ${de.hote} ${de.chemin}`;
  if (reponse?.renvoi) {
    const vers = formeAdresse(reponse.renvoi, reponse?.url || undefined);
    ligne += ` → ${vers.hote} ${vers.chemin}`;
  }
  const poses = (reponse?.poses || []).filter(Boolean);
  const effaces = (reponse?.effaces || []).filter(Boolean);
  if (poses.length) ligne += ` ; cookies posés : ${poses.join(', ')}`;
  if (effaces.length) ligne += ` ; cookies effacés : ${effaces.join(', ')}`;
  return ligne;
}

/**
 * La différence entre deux états de cookies, EN NOMS : ajoutés, valeur
 * changée, retirés. Les valeurs ne servent qu'à la comparaison, en mémoire —
 * rien n'en sort. Fonction PURE. L'identité d'un cookie est son nom plus sa
 * portée (domaine, chemin) : deux `JSESSIONID` de chemins différents sont
 * deux cookies.
 *
 * @param {Array<{name: string, value?: string, domain?: string, path?: string}>} avant
 * @param {Array<{name: string, value?: string, domain?: string, path?: string}>} apres
 * @returns {{ajoutes: string[], changes: string[], retires: string[]}}
 */
function differenceEtats(avant, apres) {
  const cle = (c) => `${c?.name || ''}|${c?.domain || ''}|${c?.path || ''}`;
  const nom = (c) => masquerChiffres(c?.name || '');
  const avantParCle = new Map((Array.isArray(avant) ? avant : []).map((c) => [cle(c), c]));
  const apresParCle = new Map((Array.isArray(apres) ? apres : []).map((c) => [cle(c), c]));

  const ajoutes = [];
  const changes = [];
  const retires = [];
  for (const [k, c] of apresParCle) {
    const ancien = avantParCle.get(k);
    if (!ancien) ajoutes.push(nom(c));
    else if (String(ancien.value ?? '') !== String(c.value ?? '')) changes.push(nom(c));
  }
  for (const [k, c] of avantParCle) {
    if (!apresParCle.has(k)) retires.push(nom(c));
  }
  return { ajoutes, changes, retires };
}

/** La différence, en une ligne de journal. Fonction PURE. */
function formaterDifference(diff) {
  const bouts = [];
  if (diff?.ajoutes?.length) bouts.push(`ajoutés : ${diff.ajoutes.join(', ')}`);
  if (diff?.changes?.length) bouts.push(`valeur changée : ${diff.changes.join(', ')}`);
  if (diff?.retires?.length) bouts.push(`retirés : ${diff.retires.join(', ')}`);
  return bouts.length
    ? `cookies, de la capture à la fin du passage — ${bouts.join(' ; ')}`
    : 'cookies, de la capture à la fin du passage — aucun changement';
}

/**
 * Branche le relevé sur une page Playwright.
 *
 * Chaque réponse de navigation du CADRE PRINCIPAL est journalisée (via `log`)
 * et gardée pour le jugement d'arrivée (`chemins()` rend les chemins
 * traversés, sans hôte ni requête). Les iframes — la page de déconnexion
 * d'impots en ouvre quinze — ne sont pas relevées : c'est le chemin du
 * document principal qui raconte le passage.
 *
 * L'écoute ne jette JAMAIS : un relevé qui casse un passage serait pire que
 * pas de relevé. `headerValues` est asynchrone et peut échouer sur une
 * réponse déjà recyclée ; la ligne part alors sans ses cookies.
 *
 * @param {object} page une page Playwright
 * @param {{log?: (ligne: string) => void, prefixe?: string}} options
 * @returns {{chemins: () => string[], reponses: () => Array<object>, detacher: () => void}}
 */
function brancher(page, { log = () => {}, prefixe = 'navigation' } = {}) {
  const reponses = [];
  const surReponse = async (reponse) => {
    try {
      const requete = reponse.request();
      if (!requete.isNavigationRequest()) return;
      if (requete.frame() !== page.mainFrame()) return;
      let poses = [];
      let effaces = [];
      try {
        const bruts = await reponse.headerValues('set-cookie');
        ({ poses, effaces } = nomsDeCookies(bruts));
      } catch {
        /* réponse déjà recyclée : la ligne part sans ses cookies */
      }
      const entree = {
        statut: reponse.status(),
        url: reponse.url(),
        renvoi: reponse.headers()?.location || null,
        poses,
        effaces,
      };
      reponses.push(entree);
      log(`${prefixe} — ${formaterReponse(entree)}`);
    } catch {
      /* jamais une erreur de relevé ne touche le passage */
    }
  };
  page.on('response', surReponse);
  return {
    reponses: () => [...reponses],
    // Les chemins traversés : celui de chaque réponse ET celui de son renvoi —
    // un renvoi vers la déconnexion compte même si la réponse suivante n'a pas
    // pu être relevée (chaîne interrompue, navigation avortée).
    chemins: () => reponses.flatMap((r) => {
      const chemins = [];
      try {
        chemins.push(new URL(r.url).pathname);
      } catch { /* adresse illisible : rien à pousser */ }
      if (r.renvoi) {
        try {
          chemins.push(new URL(r.renvoi, r.url).pathname);
        } catch { /* renvoi illisible : rien à pousser */ }
      }
      return chemins;
    }),
    detacher: () => page.off('response', surReponse),
  };
}

module.exports = {
  brancher,
  formaterReponse,
  formaterDifference,
  differenceEtats,
  nomsDeCookies,
  formeAdresse,
  masquerChiffres,
};
