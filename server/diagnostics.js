'use strict';

/**
 * Le diagnostic — ce qui rend la prochaine panne lisible sans son auteur.
 *
 * ─── Ce que ce module remplace ───────────────────────────────────────────────
 *
 * Chaque échec de récupération coûtait jusqu'ici un aller-retour complet :
 * crabe écrivait « aucune facture », et il fallait demander à l'administrateur d'aller
 * voir lui-même la page, de décrire ce qu'il y voyait, parfois de coller du
 * HTML. Le lot 13 a passé une session entière à deviner ce que le navigateur
 * avait sous les yeux. Le lot 14 arrête ça : à chaque échec, crabe garde la
 * page.
 *
 * Quatre fichiers, et pas un de plus :
 *
 *   page.html     le HTML complet, mots de passe MASQUÉS
 *   page.png      une capture pleine page
 *   liens.txt     tous les `a[href]`, un par ligne
 *   contexte.txt  URL finale, NOMS des cookies, étape atteinte, erreur interne
 *
 * ─── Ce qui n'y entre JAMAIS ─────────────────────────────────────────────────
 *
 * Aucun mot de passe, aucune valeur de cookie, aucun jeton. Les champs de type
 * `password` sont vidés dans le HTML avant écriture, les `value` des champs
 * cachés qui ressemblent à un jeton aussi, et `contexte.txt` ne porte que les
 * NOMS des cookies. C'est ce qui permet de transmettre une archive sans avoir
 * à la relire ligne à ligne.
 *
 * ─── Qui peut les lire ───────────────────────────────────────────────────────
 *
 * L'administration, et elle seule : les routes vivent sous `adminRouter`
 * (permission `apps.manage`). Un compte ordinaire ne voit ni l'onglet, ni les
 * archives, ni même qu'il en existe.
 *
 * ─── Où ils vivent ───────────────────────────────────────────────────────────
 *
 * Sous `config.diagnosticsDir`, c'est-à-dire `<dataDir>/diagnostics` par
 * défaut. Le lot 14 demandait `/var/lib/crabe/diagnostics/` ; en production
 * `dataDir` vaut `/opt/crabe/data`, seul chemin inscriptible déclaré par
 * l'unité systemd et seul chemin sauvegardé avant déploiement. Écrire ailleurs
 * aurait éparpillé l'état de crabe et laissé les diagnostics hors des
 * sauvegardes. `CRABE_DIAGNOSTICS_DIR` permet de forcer l'emplacement.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Au-delà, les plus anciens diagnostics d'un connecteur sont effacés. */
const MAX_PAR_CONNECTEUR = 20;

/** Au-delà, un diagnostic est effacé quel que soit leur nombre. */
const MAX_JOURS = 30;

/** Les quatre fichiers d'un diagnostic, dans l'ordre où on les lit. */
const FICHIERS = ['contexte.txt', 'liens.txt', 'page.html', 'page.png'];

/** Un HTML plus gros que ça n'apprend plus rien et remplit le disque. */
const HTML_MAX_OCTETS = 4 * 1024 * 1024;

/** Au-delà, la liste des liens est tronquée — avec une ligne qui le dit. */
const LIENS_MAX = 2000;

/**
 * Les noms d'attributs cachés qui portent un secret.
 *
 * PrestaShop pose un `token` dans chaque formulaire, les CMS un `_csrf` ou un
 * `nonce`. Ils ne servent à rien au diagnostic — ce qui compte est qu'ils
 * SOIENT là, pas leur valeur.
 */
const MOTIF_CHAMP_SECRET = /(token|csrf|nonce|secret|_key|apikey|authenticity)/i;

// ---------------------------------------------------------------------------
// Emplacement
// ---------------------------------------------------------------------------

/** La racine des diagnostics. Jamais créée avant qu'on en écrive un. */
function racine() {
  return require('./config').config.diagnosticsDir;
}

/** Un identifiant de connecteur utilisable comme nom de dossier. */
function dossierValide(id) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id || ''));
}

/** Un horodatage de dossier : « 2026-08-11T03-07-16-482Z ». */
function horodatage(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** `2026-08-11T03-07-16-482Z` → l'instant ISO d'origine, ou null. */
function instantDe(nom) {
  const propre = String(nom || '');
  const trouve = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(propre);
  if (!trouve) return null;
  const [, jour, h, m, s, ms] = trouve;
  const iso = `${jour}T${h}:${m}:${s}.${ms}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// ---------------------------------------------------------------------------
// Masquage — avant toute écriture, jamais après
// ---------------------------------------------------------------------------

/**
 * Vide les valeurs sensibles d'un HTML.
 *
 * Trois passes, sur le texte plutôt que sur un DOM : le HTML capturé peut être
 * malformé, et un analyseur qui refuserait de le lire nous priverait justement
 * du diagnostic dont on a besoin. Le masquage est donc TEXTUEL, et volontaire-
 * ment large — mieux vaut masquer un champ anodin qu'en laisser passer un.
 *
 * @param {string} html
 * @returns {string}
 */
function masquer(html) {
  let sortie = String(html || '');

  // 1. Tout champ de type password : sa valeur part, sa présence reste.
  sortie = sortie.replace(/<input\b[^>]*>/gi, (balise) => {
    const estMotDePasse = /type\s*=\s*["']?password["']?/i.test(balise);
    const nom = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(balise)?.[1] || '';
    const estSecret = MOTIF_CHAMP_SECRET.test(nom)
      || MOTIF_CHAMP_SECRET.test(/\bid\s*=\s*["']?([^"'\s>]+)/i.exec(balise)?.[1] || '');

    if (!estMotDePasse && !estSecret) return balise;
    // La valeur est remplacée, pas retirée : la structure du formulaire reste
    // lisible, et c'est elle qu'on vient examiner.
    return balise.replace(/\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'value="[masqué]"');
  });

  // 2. Les mêmes clés dans un JSON embarqué (`var config = {...}` en ligne).
  sortie = sortie.replace(
    /("(?:[^"]*(?:token|csrf|nonce|secret|password|passwd|api_?key)[^"]*)"\s*:\s*)"[^"]*"/gi,
    '$1"[masqué]"'
  );

  // 3. Un `document.cookie = "…"` posé en ligne par le site.
  sortie = sortie.replace(/document\.cookie\s*=\s*("[^"]*"|'[^']*')/gi, 'document.cookie = "[masqué]"');

  return sortie;
}

/**
 * Les noms des cookies, **jamais leurs valeurs**.
 * @param {Array<{name?: string, domain?: string}>} cookies
 */
function nomsDeCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .map((c) => String(c?.name || '').trim())
    .filter(Boolean)
    .sort();
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Enregistre un diagnostic.
 *
 * **Ne lève jamais.** Un diagnostic qui ferait échouer la récupération qu'il
 * documente serait pire que pas de diagnostic du tout : l'appelant est déjà en
 * train de traiter un échec.
 *
 * @param {object} options
 * @param {string} options.connectorId
 * @param {object} [options.page] page Playwright, pour le HTML et la capture
 * @param {object} [options.context] contexte Playwright, pour les cookies
 * @param {string} options.etape ce qu'on essayait de faire (« connexion »,
 *   « page des commandes »…)
 * @param {string} [options.erreur] le message d'erreur INTERNE
 * @param {object} [options.extra] lignes supplémentaires de contexte.txt
 * @returns {Promise<{ok: boolean, dossier: string|null, fichiers: string[], raison?: string}>}
 */
async function enregistrer({
  connectorId,
  page = null,
  context = null,
  etape = 'inconnue',
  erreur = '',
  extra = {},
} = {}) {
  if (!dossierValide(connectorId)) {
    return { ok: false, dossier: null, fichiers: [], raison: 'identifiant de connecteur invalide' };
  }

  const nom = horodatage();
  const dossier = path.join(racine(), connectorId, nom);
  const ecrits = [];

  try {
    fs.mkdirSync(dossier, { recursive: true });
  } catch (err) {
    return { ok: false, dossier: null, fichiers: [], raison: err.message };
  }

  // --- contexte.txt : écrit en premier, il est le seul indispensable --------
  let cookies = [];
  try {
    cookies = (await context?.cookies?.()) || [];
  } catch {
    /* contexte fermé */
  }

  let url = '';
  try {
    url = String(page?.url?.() || '');
  } catch {
    /* page fermée */
  }

  const lignes = [
    `connecteur   : ${connectorId}`,
    `horodatage   : ${new Date().toISOString()}`,
    `étape        : ${etape}`,
    `URL finale   : ${url || '(inconnue)'}`,
    `erreur       : ${erreur || '(aucune)'}`,
    `cookies (${cookies.length}) : ${nomsDeCookies(cookies).join(', ') || '(aucun)'}`,
    '',
    '# Les VALEURS des cookies ne sont jamais enregistrées, et les champs de',
    '# type « password » sont masqués dans page.html.',
  ];
  for (const [cle, valeur] of Object.entries(extra || {})) {
    lignes.splice(5, 0, `${String(cle).padEnd(13)}: ${valeur}`);
  }
  ecrire(dossier, 'contexte.txt', lignes.join('\n') + '\n', ecrits);

  // --- page.html ------------------------------------------------------------
  try {
    const html = await page?.content?.();
    if (typeof html === 'string') {
      ecrire(dossier, 'page.html', masquer(html).slice(0, HTML_MAX_OCTETS), ecrits);
    }
  } catch {
    /* page en cours de navigation : les autres fichiers suffiront */
  }

  // --- liens.txt ------------------------------------------------------------
  try {
    const liens = await page?.evaluate?.(() =>
      [...document.querySelectorAll('a[href]')].map((a) => {
        const telecharger = a.getAttribute('download');
        return a.href + (telecharger ? `\t[download=${telecharger}]` : '');
      })
    );
    if (Array.isArray(liens)) {
      const bornes = liens.slice(0, LIENS_MAX);
      const texte = bornes.join('\n')
        + (liens.length > LIENS_MAX ? `\n… ${liens.length - LIENS_MAX} lien(s) de plus, non listés\n` : '\n');
      ecrire(dossier, 'liens.txt', texte, ecrits);
    }
  } catch {
    /* idem */
  }

  // --- page.png -------------------------------------------------------------
  try {
    await page?.screenshot?.({ path: path.join(dossier, 'page.png'), fullPage: true });
    if (fs.existsSync(path.join(dossier, 'page.png'))) ecrits.push('page.png');
  } catch {
    /* capture impossible (page fermée, navigateur mort) : sans gravité */
  }

  purger(connectorId);
  return { ok: true, dossier, fichiers: ecrits };
}

/** Écrit un fichier du diagnostic. Un échec n'arrête pas les suivants. */
function ecrire(dossier, nom, contenu, ecrits) {
  try {
    fs.writeFileSync(path.join(dossier, nom), contenu, 'utf8');
    ecrits.push(nom);
  } catch {
    /* disque plein, permission : le diagnostic reste partiel, pas absent */
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Les diagnostics d'un connecteur, du plus récent au plus ancien.
 * @returns {Array<{id: string, at: string|null, fichiers: string[], octets: number}>}
 */
function lister(connectorId) {
  if (!dossierValide(connectorId)) return [];
  const base = path.join(racine(), connectorId);
  let noms = [];
  try {
    noms = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  return noms
    .map((nom) => {
      const dossier = path.join(base, nom);
      let fichiers = [];
      let octets = 0;
      try {
        fichiers = fs.readdirSync(dossier).filter((f) => FICHIERS.includes(f));
        for (const f of fichiers) octets += fs.statSync(path.join(dossier, f)).size;
      } catch {
        /* dossier effacé entre-temps */
      }
      return { id: nom, at: instantDe(nom), fichiers: fichiers.sort(), octets };
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/** Les connecteurs qui ont au moins un diagnostic. */
function connecteurs() {
  try {
    return fs.readdirSync(racine(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && dossierValide(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Le chemin absolu d'un diagnostic, ou null.
 *
 * Le chemin est RECONSTRUIT à partir de composants validés, jamais concaténé
 * depuis la requête : c'est la même règle que pour les logos et les factures.
 */
function chemin(connectorId, id) {
  if (!dossierValide(connectorId)) return null;
  if (!instantDe(id)) return null;
  const dossier = path.join(racine(), connectorId, id);
  return fs.existsSync(dossier) ? dossier : null;
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

/**
 * Efface ce qui dépasse : plus de 20 diagnostics, ou plus de 30 jours.
 *
 * Appelée après chaque écriture — c'est le seul moment où le nombre peut
 * augmenter, et ça évite une tâche de fond de plus.
 *
 * @returns {number} nombre de diagnostics effacés
 */
function purger(connectorId, { maintenant = Date.now() } = {}) {
  const tous = lister(connectorId);
  if (!tous.length) return 0;

  const limite = maintenant - MAX_JOURS * 24 * 60 * 60 * 1000;
  let efface = 0;

  tous.forEach((entree, rang) => {
    const tropVieux = entree.at ? Date.parse(entree.at) < limite : false;
    const tropNombreux = rang >= MAX_PAR_CONNECTEUR;
    if (!tropVieux && !tropNombreux) return;
    try {
      fs.rmSync(path.join(racine(), connectorId, entree.id), { recursive: true, force: true });
      efface++;
    } catch {
      /* déjà parti */
    }
  });

  return efface;
}

/** Efface tous les diagnostics d'un connecteur (bouton « Tout effacer »). */
function effacerTout(connectorId) {
  if (!dossierValide(connectorId)) return 0;
  const combien = lister(connectorId).length;
  try {
    fs.rmSync(path.join(racine(), connectorId), { recursive: true, force: true });
  } catch {
    return 0;
  }
  return combien;
}

module.exports = {
  MAX_PAR_CONNECTEUR,
  MAX_JOURS,
  FICHIERS,
  MOTIF_CHAMP_SECRET,
  racine,
  dossierValide,
  horodatage,
  instantDe,
  masquer,
  nomsDeCookies,
  enregistrer,
  lister,
  connecteurs,
  chemin,
  purger,
  effacerTout,
};
