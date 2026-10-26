'use strict';

/**
 * Le rapport d'une récupération — ce qu'un utilisateur de crabe envoie pour
 * qu'on corrige sans avoir à lui poser de questions.
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Demande du 25/10/2026, après un échec Anthropic en production : les
 * personnes qui installent crabe chez elles (l'image Docker publique) n'ont
 * jusqu'ici rien à envoyer quand une récupération échoue — ni la version, ni ce
 * que le connecteur a vu, ni l'endroit du code où il s'est arrêté. Chaque
 * signalement aurait coûté un aller-retour de questions.
 *
 * Le rapport tient en un fichier texte, téléchargé depuis « Logs →
 * Connecteurs » (bouton « Rapport » d'une récupération) :
 *
 *   - l'installation : versions de crabe, de Node.js, de Playwright et de
 *     Chromium, système, Docker ou non, schéma de la base, fuseau, mémoire ;
 *   - la récupération : service, déclencheur, durée, résultat, cause, et les
 *     résultats des cinq précédentes (sans leurs messages) ;
 *   - son journal entier : toutes les lignes écrites sous son numéro
 *     (migration 67), y compris le détail technique d'un échec — type
 *     d'erreur et endroit du code de crabe (`detailTechnique`) ;
 *   - où l'envoyer : les issues du dépôt que l'installation suit pour ses
 *     mises à jour, s'il est réglé (`adresseDeSignalement`).
 *
 * ─── Ce qui n'y entre JAMAIS ─────────────────────────────────────────────────
 *
 * Le rapport part chez un tiers : il est anonymisé à la sortie, quelle que
 * soit la ligne (`anonymiser`). Les noms de compte, adresses e-mail et numéros
 * de téléphone des comptes de l'installation sont remplacés ; toute adresse
 * e-mail, toute adresse IP et tout jeton aussi ; les adresses web sont
 * réduites à leur hôte et à leur chemin masqué (releve-navigation.js). Le
 * rapport ne lit ni les identifiants des services, ni les cookies, ni les
 * documents, ni les diagnostics (page.html et page.png montrent le compte de
 * la personne : ils restent sur sa machine).
 *
 * Le texte invite quand même à le relire avant de l'envoyer : un site peut
 * écrire un nom propre dans le titre d'une page, et aucune règle ne
 * reconnaît un nom propre.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const navigation = require('./connectors/releve-navigation');

/** La racine du code de crabe : les chemins du rapport s'écrivent à partir d'elle. */
const RACINE = path.resolve(__dirname, '..');


/** Les étapes de la pile gardées : assez pour situer, pas de quoi noyer. */
const ETAPES_MAX = 4;

/** Les drapeaux d'erreur que le socle sait lire, dans l'ordre où ils se disent. */
const DRAPEAUX = [
  ['sessionExpired', 'session à rouvrir'],
  ['expirationCertaine', 'expiration constatée'],
  ['renvoiAuthentification', 'renvoyé vers la connexion'],
  ['horsLigne', 'site hors ligne'],
  ['dureeDepassee', 'durée dépassée'],
];

// ---------------------------------------------------------------------------
// L'endroit du code et le détail technique d'un échec
// ---------------------------------------------------------------------------

/**
 * Les étapes de la pile qui sont dans le code de crabe, chemins relatifs à sa
 * racine — jamais un chemin absolu de la machine, jamais node_modules. Pure.
 *
 * « at telecharger (/srv/appli/server/x/connector.js:398:11) »
 *   → « server/x/connector.js:398 (telecharger) »
 *
 * @param {string} pile `err.stack`
 * @param {string} [racine]
 * @returns {string[]}
 */
function emplacementDansLeCode(pile, racine = RACINE) {
  const sortie = [];
  for (const ligne of String(pile ?? '').split('\n')) {
    const trouve = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?\s*$/.exec(ligne);
    if (!trouve) continue;
    const [, fonction, fichier, numero] = trouve;
    if (!fichier.startsWith(racine + path.sep)) continue;
    const relatif = path.relative(racine, fichier).split(path.sep).join('/');
    if (relatif.startsWith('node_modules/')) continue;
    // 0.2.6 : l'accroche du journal enveloppe les appels Playwright ; elle
    // n'est jamais l'endroit qui a cassé, c'est l'appelant.
    if (relatif === 'server/connectors/journal-de-passage.js') continue;
    const etape = `${relatif}:${numero}${fonction ? ` (${fonction.replace(/^async /, '')})` : ''}`;
    if (!sortie.includes(etape)) sortie.push(etape);
    if (sortie.length >= ETAPES_MAX) break;
  }
  return sortie;
}

/**
 * Ce que Playwright attendait quand il a renoncé (0.2.5) : le « Call log » de
 * son erreur, à partir de la deuxième ligne — « waiting for
 * locator('a.facture') to be visible », « navigating to … ». C'est la ligne
 * qui dit QUEL élément manquait ; la première ne dit que « Timeout exceeded ».
 * Cherché aussi dans les causes : un connecteur qui enveloppe l'erreur dans
 * sa phrase garde l'originale en `cause`. Un sélecteur est du code, pas une
 * donnée ; les adresses sont masquées. Pure.
 *
 * @param {*} err
 * @returns {string[]} deux lignes au plus
 */
function attentePlaywright(err) {
  const sortie = [];
  const vus = new Set();
  for (let maillon = err, profondeur = 0; maillon && typeof maillon === 'object' && profondeur < 4; maillon = maillon.cause, profondeur++) {
    if (vus.has(maillon)) break;
    vus.add(maillon);
    const lignes = String(maillon.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(1);
    for (const brute of lignes) {
      const ligne = brute.trim().replace(/^-\s*/, '');
      if (!/^(waiting for |navigating to )/.test(ligne)) continue;
      const propre = navigation.masquerAdresses(ligne).slice(0, 200);
      if (!sortie.includes(propre)) sortie.push(propre);
      if (sortie.length >= 2) return sortie;
    }
  }
  return sortie;
}

/**
 * La ligne de journal qui dit ce qui a cassé, pour qui corrigera : la nature
 * de l'erreur, ses drapeaux, sa première ligne (adresses masquées), ce que
 * Playwright attendait (0.2.5) et l'endroit du code. Écrite par le
 * planificateur à chaque échec. Pure.
 *
 * @param {*} err
 * @param {{racine?: string}} [options]
 * @returns {string}
 */
function detailTechnique(err, { racine = RACINE } = {}) {
  const nature = err instanceof Error ? err.name || 'Error' : typeof err;
  const code = typeof err?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(err.code) ? ` ${err.code}` : '';
  const drapeaux = DRAPEAUX.filter(([cle]) => err?.[cle]).map(([, dit]) => dit);
  const brut = String((err instanceof Error ? err.message : err) ?? '').split('\n')[0].trim();
  const premiere = navigation.masquerAdresses(brut).slice(0, 500) || '(sans message)';
  const ou = emplacementDansLeCode(err?.stack, racine);
  const attente = attentePlaywright(err);
  return `Détail technique de l'échec : ${nature}${code}`
    + `${drapeaux.length ? ` [${drapeaux.join(', ')}]` : ''} — ${premiere}`
    + (attente.length ? ` — Playwright : ${attente.join(' ; ')}` : '')
    + (ou.length ? ` — dans ${ou.join(' ← ')}` : ' — aucun endroit du code de crabe dans la pile');
}

// ---------------------------------------------------------------------------
// L'anonymisation — à la sortie, sur chaque ligne
// ---------------------------------------------------------------------------

const MOTIF_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MOTIF_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const MOTIF_IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
/** Un mot long, lettres ET chiffres mêlés : la forme d'un jeton, d'une clé, d'un identifiant de session. */
const MOTIF_JETON = /\b(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{24,}\b/g;

/**
 * Où signaler un problème : les issues du dépôt que l'installation suit pour
 * ses mises à jour (`CRABE_UPDATE_REPO`, que le docker-compose.yml public
 * pose), ou `null`. Le code ne nomme aucun dépôt : il lit celui qu'on lui
 * donne, et seulement s'il a exactement la forme d'un dépôt GitHub — la même
 * règle que les liens de mise à jour (version.js).
 *
 * @param {string} [depot]
 * @returns {string|null}
 */
function adresseDeSignalement(depot = process.env.CRABE_UPDATE_REPO) {
  if (!require('./version').liensDeMiseAJour(depot)) return null;
  return `https://github.com/${String(depot).trim()}/issues`;
}

function echapper(texte) {
  return String(texte).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Un texte prêt à partir chez un tiers. Pure.
 *
 * @param {string} texte
 * @param {{comptes?: Array<{username?: string, email?: string, phone?: string}>}} [options]
 *   les comptes de l'installation, dont les noms, e-mails et téléphones sont
 *   remplacés partout où ils apparaissent
 * @returns {string}
 */
function anonymiser(texte, { comptes = [] } = {}) {
  let sortie = navigation.masquerAdresses(String(texte ?? ''));
  for (const compte of comptes) {
    for (const [champ, remplacement] of [['email', '[adresse e-mail]'], ['phone', '[téléphone]'], ['username', '[compte]']]) {
      const valeur = String(compte?.[champ] ?? '').trim();
      // Un nom de deux lettres remplacerait la moitié du texte : il n'est pas
      // une donnée qu'on reconnaît, et le rapport resterait illisible.
      if (valeur.length < 3) continue;
      sortie = sortie.replace(new RegExp(echapper(valeur), 'gi'), remplacement);
    }
  }
  return sortie
    .replace(MOTIF_EMAIL, '[adresse e-mail]')
    .replace(MOTIF_IPV4, '[adresse IP]')
    .replace(MOTIF_IPV6, '[adresse IP]')
    .replace(MOTIF_JETON, '[jeton]');
}

// ---------------------------------------------------------------------------
// L'installation
// ---------------------------------------------------------------------------

/** La version de Chromium que Playwright installe, ou null. */
function versionDeChromium() {
  try {
    const dossier = path.dirname(require.resolve('playwright-core/package.json'));
    const navigateurs = JSON.parse(fs.readFileSync(path.join(dossier, 'browsers.json'), 'utf8'));
    return navigateurs.browsers.find((b) => b.name === 'chromium')?.browserVersion || null;
  } catch {
    return null;
  }
}

function versionDePlaywright() {
  try {
    return require('playwright/package.json').version;
  } catch {
    return null;
  }
}

function enGo(octets) {
  return `${(octets / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

/**
 * Ce qui décrit l'installation, sans rien qui la désigne : ni nom de machine,
 * ni chemin, ni adresse.
 *
 * @param {{database?: object, fuseau?: string}} [options]
 * @returns {Array<[string, string]>}
 */
function environnement({ database = null, fuseau = '' } = {}) {
  const lignes = [
    ['crabe', require('./config').config.version],
    ['Node.js', process.version],
    ['Système', `${os.type()} ${os.release()} (${process.arch})`],
    ['Docker', fs.existsSync('/.dockerenv') ? 'oui' : 'non'],
    ['Playwright', versionDePlaywright() || 'absent'],
    ['Chromium', versionDeChromium() || 'inconnu'],
  ];
  try {
    const schema = database?.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get().v;
    if (schema !== undefined) lignes.push(['Schéma', String(schema)]);
  } catch {
    /* base illisible : le reste du rapport suffit */
  }
  if (fuseau) lignes.push(['Fuseau', fuseau]);
  lignes.push(['Mémoire', `${enGo(os.totalmem())}, ${enGo(os.freemem())} libres`]);
  return lignes;
}

// ---------------------------------------------------------------------------
// Le rapport
// ---------------------------------------------------------------------------

/**
 * La réussite PARTIELLE (0.2.2, décision du 26/10/2026) : des documents sont entrés,
 * d'autres n'ont pas été obtenus (`manquees`, lot 80). La ligne reste verte —
 * c'est pourtant là qu'une facture manque sans que rien ne soit rouge, et le
 * rapport y est proposé comme sur un échec. Le planificateur écrit la phrase
 * (`phraseNonObtenues`) ; l'écran et le rapport la relisent (`nonObtenues`) :
 * une seule source, et un essai qui tient les deux ensemble.
 */
function phraseNonObtenues(n) {
  return `${n} non ${n > 1 ? 'obtenues' : 'obtenue'} — le prochain passage les réessaiera.`;
}

const MOTIF_NON_OBTENUES = /(\d+) non obtenues? — le prochain passage les réessaiera\./;

/** Le nombre de documents non obtenus d'après le message d'une réussite, ou 0. Pure. */
function nonObtenues(message) {
  const trouve = MOTIF_NON_OBTENUES.exec(String(message ?? ''));
  return trouve ? Number(trouve[1]) : 0;
}

/** Les déclencheurs de `run_logs.trigger`, tels que le journal et le rapport les disent. */
const DECLENCHEURS = Object.freeze({ manual: 'lancée à la main', cron: 'planifiée', test: 'essai de connexion' });

/** « 2 min 8 s » entre deux dates de la base (UTC, « AAAA-MM-JJ HH:MM:SS »). */
function duree(debut, fin) {
  const ms = Date.parse(`${String(fin).replace(' ', 'T')}Z`) - Date.parse(`${String(debut).replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** Une date comme la base les écrit : « AAAA-MM-JJ HH:MM:SS », en UTC. */
function horodatageDeLaBase(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function resultat(run) {
  if (!run.finished_at) return 'en cours';
  if (!run.success) return `échec (${run.cause || 'echec'})`;
  const manquees = nonObtenues(run.message);
  return manquees ? `succès partiel — ${manquees} document(s) non obtenu(s)` : 'succès';
}

function colonnes(paires) {
  const large = Math.max(...paires.map(([cle]) => cle.length));
  return paires.map(([cle, valeur]) => `${cle.padEnd(large)} : ${valeur}`).join('\n');
}

/**
 * Le rapport d'une récupération, prêt à télécharger, ou `null` si elle
 * n'existe pas.
 *
 * @param {number} runId
 * @param {{database: object, fuseau?: string, maintenant?: Date, depot?: string}} options
 *   `depot` : le dépôt des signalements (`CRABE_UPDATE_REPO` par défaut)
 * @returns {{nomFichier: string, texte: string}|null}
 */
function rapport(runId, { database, fuseau = '', maintenant = new Date(), depot = process.env.CRABE_UPDATE_REPO }) {
  const run = database
    .prepare(
      `SELECT id, connector_id, user_id, started_at, finished_at, success, invoice_count, trigger, message, cause
         FROM run_logs WHERE id = ?`
    )
    .get(runId);
  if (!run) return null;

  const registry = require('./connectors/registry');
  const nom = registry.has(run.connector_id) ? registry.manifest(run.connector_id).name : run.connector_id;
  const comptes = database.prepare('SELECT username, email, phone FROM users').all();
  const propre = (texte) => anonymiser(texte, { comptes });

  const lignes = database
    .prepare('SELECT at, level, source, message FROM app_logs WHERE run_id = ? ORDER BY id')
    .all(run.id);
  const precedentes = database
    .prepare(
      `SELECT id, started_at, finished_at, success, cause FROM run_logs
        WHERE connector_id = ? AND user_id IS ? AND id < ? ORDER BY id DESC LIMIT 5`
    )
    .all(run.connector_id, run.user_id, run.id);

  const signalement = adresseDeSignalement(depot);
  const fin = run.finished_at ? `${run.finished_at} (UTC), ${duree(run.started_at, run.finished_at)}` : '(pas encore finie)';
  const pieces = require('./pieces-de-rapport').lister(run.id);
  const enEchec = run.finished_at && (!run.success || nonObtenues(run.message) > 0);
  const ligneDuJournal = (l) => `${String(l.at).slice(11)}  ${l.level.padEnd(5)}  ${l.source.replace(/^connector:/, '')}  `
    // Une ligne de plusieurs lignes (le « Call log » de Playwright) reste
    // lisible : la suite est en retrait sous l'heure.
    + propre(l.message).split('\n').join('\n          ');
  const texte = [
    `Rapport de la récupération n° ${run.id} — crabe`,
    '',
    'Relisez ce fichier avant de l\'envoyer. crabe en a retiré les noms de compte, les adresses',
    'e-mail, les numéros de téléphone, les adresses IP, les jetons et le détail des adresses web ;',
    'il ne contient ni identifiant, ni mot de passe, ni cookie, ni document. Un site peut toutefois',
    'écrire un nom ou un numéro de client dans ses messages, ses titres ou ses alertes (le rapport',
    'dit ce que montrait la page quand la récupération s\'est arrêtée) : si vous en voyez un,',
    'remplacez-le.',
    '',
    signalement
      ? `Pour signaler le problème : joignez ce fichier à une issue (${signalement}),\navec ce que vous attendiez.`
      : 'Pour signaler le problème : joignez ce fichier à votre signalement, avec ce que vous attendiez.',
    '',
    '## Installation',
    '',
    colonnes([...environnement({ database, fuseau }), ['Rapport fait le', `${horodatageDeLaBase(maintenant)} (UTC)`]]),
    '',
    `## Récupération n° ${run.id}`,
    '',
    colonnes([
      ['Service', `${nom} (${run.connector_id})`],
      ['Déclencheur', DECLENCHEURS[run.trigger] || run.trigger],
      ['Début', `${run.started_at} (UTC)`],
      ['Fin', fin],
      ['Résultat', resultat(run)],
      ['Documents', String(run.invoice_count ?? 0)],
      ['Message', propre(run.message || '(aucun)')],
    ]),
    '',
    ...(enEchec ? ceQuiAManque(lignes, pieces, propre) : []),
    '## Les récupérations précédentes de ce service (cinq au plus)',
    '',
    ...(precedentes.length
      ? precedentes.map((p) => `n° ${p.id}  ${p.started_at}  ${resultat(p)}`)
      : ['(aucune)']),
    '',
    ...(enEchec && lignes.length > 20
      ? ['## Les 20 dernières lignes du journal (heures UTC)', '', ...lignes.slice(-20).map(ligneDuJournal), '']
      : []),
    `## Journal de la récupération (${lignes.length} ligne(s), heures UTC)`,
    '',
    ...(lignes.length
      ? lignes.map(ligneDuJournal)
      : ['(aucune ligne : la récupération date d\'avant la version 0.2.0, ou c\'est un essai de connexion)']),
    '',
  ].join('\n');

  return { nomFichier: `crabe-rapport-${run.connector_id}-${run.id}.txt`, texte, pieces };
}

/**
 * 0.2.6 : en tête du rapport d'une lecture qui échoue, ce qu'il faut pour la
 * refaire — l'étape en échec, l'erreur exacte, ce que crabe cherchait et ce
 * qu'il a trouvé à la place, ce que montrait la page, les erreurs de la
 * console, et les pièces jointes. Tiré des lignes du journal : le rapport ne
 * dit rien que le journal ne dise.
 */
function ceQuiAManque(lignes, pieces, propre) {
  const derniere = (prefixe) => [...lignes].reverse().find((l) => l.message.startsWith(prefixe))?.message || null;
  const apres = (texte) => (texte ? propre(texte.slice(texte.indexOf(':') + 1).trim()) : null);
  const etape = derniere('Étape « ');
  const technique = derniere('Détail technique de l\'échec');
  const cherche = derniere('Ce que crabe cherchait');
  const vue = derniere('Ce que montrait la page');
  const parcours = derniere('Pages parcourues');
  const consoles = lignes.filter((l) => l.message.startsWith('Console de ')).map((l) => propre(l.message));
  const paires = [];
  if (etape) paires.push(['Étape en échec', propre(etape.replace(/^Étape /, ''))]);
  if (technique) paires.push(['Erreur', apres(technique)]);
  if (cherche) paires.push(['Attendu', apres(cherche)]);
  if (vue) paires.push(['Page à l\'arrêt', apres(vue)]);
  if (parcours) paires.push(['Parcours', apres(parcours)]);
  if (!paires.length) {
    paires.push(['Étape en échec', 'le journal ne le dit pas (récupération sans navigateur, ou d\'avant la version 0.2.6)']);
  }
  const sortie = ['## Ce qui a manqué', '', colonnes(paires), ''];
  sortie.push('## Erreurs de la console du navigateur', '', ...(consoles.length ? consoles : ['(aucune)']), '');
  sortie.push('## Pièces jointes', '');
  if (pieces.length) {
    sortie.push(
      'Dans l\'archive, avec ce fichier : la structure de chaque page à l\'arrêt (HTML où chaque texte est',
      'remplacé par sa longueur, valeurs et adresses vidées) et sa capture, où chaque texte et chaque image',
      'sont effacés.',
      '',
      ...pieces.map((p) => `pieces/${p.nom}  (${p.adresse || 'page'}, ${Math.max(1, Math.round(p.octets / 1024))} Ko)`)
    );
  } else {
    sortie.push('(aucune : la page n\'a pas pu être relevée, ou la récupération date d\'avant la version 0.2.6)');
  }
  sortie.push('');
  return sortie;
}

/**
 * 0.2.6 : envoie le rapport — le texte seul, ou, quand la récupération a des
 * pièces, une archive zip : `rapport.txt` et `pieces/…`.
 */
function envoyer(res, sortie, runId) {
  res.set('Cache-Control', 'no-store');
  if (!sortie.pieces?.length) {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${sortie.nomFichier}"`);
    return res.send(sortie.texte);
  }
  const archiver = require('archiver');
  const lecteur = require('./pieces-de-rapport');
  const zip = archiver('zip', { zlib: { level: 9 } });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${sortie.nomFichier.replace(/\.txt$/, '.zip')}"`);
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  zip.append(sortie.texte, { name: 'rapport.txt' });
  for (const piece of sortie.pieces) {
    const contenu = lecteur.lire(runId, piece.nom);
    if (contenu) zip.append(contenu, { name: `pieces/${piece.nom}` });
  }
  return zip.finalize();
}

/**
 * Le détail d'une récupération, pour l'écran (0.2.3) : ses faits, et les
 * volets que l'administration a ouverts (`settings.detailRecuperation`) — son
 * déroulé (toutes ses lignes, le détail technique marqué), ses récupérations
 * précédentes, son rapport anonymisé. Un volet fermé vaut `null` : il n'est
 * pas servi, pas seulement caché. `null` si la récupération n'existe pas.
 *
 * Le déroulé est celui du journal local, tel que Logs › Connecteurs le
 * montre déjà ; seul le rapport, fait pour partir chez un tiers, est
 * anonymisé.
 *
 * @param {number} runId
 * @param {{database: object, volets: {deroule: boolean, rapport: boolean, precedentes: boolean},
 *   fuseau?: string, depot?: string}} options
 * @returns {object|null}
 */
function detail(runId, { database, volets, fuseau = '', depot = process.env.CRABE_UPDATE_REPO }) {
  const run = database
    .prepare(
      `SELECT id, connector_id, user_id, started_at, finished_at, success, invoice_count, trigger, message, cause
         FROM run_logs WHERE id = ?`
    )
    .get(runId);
  if (!run) return null;

  const registry = require('./connectors/registry');
  const causeEchec = require('./connectors/cause-echec');
  const manquees = run.success ? nonObtenues(run.message) : 0;
  const statut = !run.finished_at ? 'en-cours' : !run.success ? 'echec' : manquees ? 'partiel' : 'ok';

  const sortie = {
    run: {
      id: run.id,
      connectorId: run.connector_id,
      service: registry.has(run.connector_id) ? registry.manifest(run.connector_id).name : run.connector_id,
      userId: run.user_id,
      declencheur: DECLENCHEURS[run.trigger] || run.trigger,
      debut: run.started_at,
      fin: run.finished_at,
      duree: run.finished_at ? duree(run.started_at, run.finished_at) : '',
      statut,
      cause: run.success || !run.finished_at ? null : causeEchec.causeDeLigne(run),
      resultat: resultat(run),
      documents: run.invoice_count ?? 0,
      nonObtenues: manquees,
      message: require('./connectors/site-hors-ligne').sansReessaiPromis(run.message || ''),
    },
    lignes: null,
    precedentes: null,
    rapport: null,
  };

  if (volets?.deroule) {
    sortie.lignes = database
      .prepare('SELECT at, level, source, message FROM app_logs WHERE run_id = ? ORDER BY id')
      .all(run.id)
      .map((l) => ({
        at: l.at,
        level: l.level,
        source: l.source.replace(/^connector:/, ''),
        message: l.message,
        // 0.2.5 : la vue de la page et le parcours sont du même détail technique.
        technique: /^(Détail technique de l'échec|Ce que montrait la page|Ce que crabe cherchait|Pages parcourues)/.test(l.message),
      }));
  }
  if (volets?.precedentes) {
    sortie.precedentes = database
      .prepare(
        `SELECT id, started_at, finished_at, success, message FROM run_logs
          WHERE connector_id = ? AND user_id IS ? AND id < ? ORDER BY id DESC LIMIT 5`
      )
      .all(run.connector_id, run.user_id, run.id)
      .map((p) => ({
        id: p.id,
        debut: p.started_at,
        statut: !p.finished_at ? 'en-cours' : !p.success ? 'echec' : nonObtenues(p.message) ? 'partiel' : 'ok',
      }));
  }
  if (volets?.rapport) sortie.rapport = rapport(run.id, { database, fuseau, depot });
  return sortie;
}

module.exports = {
  RACINE,
  detail,
  DECLENCHEURS,
  phraseNonObtenues,
  nonObtenues,
  adresseDeSignalement,
  emplacementDansLeCode,
  detailTechnique,
  attentePlaywright,
  ceQuiAManque,
  envoyer,
  anonymiser,
  environnement,
  rapport,
};
