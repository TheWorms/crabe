'use strict';

/**
 * Lot 108 — ce que partagent les essais de Profil et Administration en pleine
 * page : le banc (données inventées), le relevé des contrôles d'une section, et
 * la signature d'un contrôle — celle de l'inventaire relevé avant le lot
 * (`test/lot108-inventaire.json`, voir docs/reconnaissance-lot108.md).
 *
 * Aucune donnée réelle : comptes nommés par leur rôle, demandes inventées.
 */

const path = require('node:path');

const helpers = require('./helpers');
const permissions = require('../server/permissions');

/** Les sections, dans l'ordre de la navigation, et les gestes qui déplient leurs onglets. */
const SECTIONS_PROFIL = ['general', 'interface', 'stockage', 'fichiers', 'connecteurs', 'permissions', 'compte', 'contact'];
const SECTIONS_ADMIN = ['users', 'apps', 'roles', 'cron', 'storage', 'optimisation', 'securite', 'smtp', 'logs', 'support', 'systeme'];

/** Ce qu'on ouvre dans une section pour en relever tous les contrôles (onglets, vues, détails). */
const DEPLIER = {
  permissions: ["openPermDetail('free')"],
  users: ["setUsersTab('suppressions')", "setUsersTab('avatars')", "setUsersView('list')", "setUsersView('cards')"],
  apps: ["setAppsView('list')", "setAppsView('cards')", "setAppsTab('logos')", "setAppsTab('diagnostic')"],
  roles: ["setRolesTab('matrix')"],
  cron: ["setCronView('list')", "setCronView('cards')"],
  securite: ["setSecurityTab('logs')"],
  logs: ["setLogsTab('application')", "setLogsTab('stockage')"],
  support: ['openSupportDetail(admin.tickets[0]?.id)'],
};

/**
 * Pose le banc : une administratrice (`gerante`) et une titulaire, deux
 * connecteurs installés chacune, une demande de suppression et deux demandes
 * de support. Rend le serveur d'essai.
 */
async function poserLeBanc() {
  await helpers.setup();
  const db = helpers.db.get();
  const gerante = await helpers.createUser({ username: 'gerante', role: 'admin' });
  db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(permissions.roleBySlug('admin').id, gerante.id);
  const titulaire = await helpers.createUser({ username: 'titulaire' });
  const schedules = require('../server/schedules');
  for (const u of [gerante, titulaire]) {
    for (const id of ['free', 'ovh-api']) {
      db.prepare("INSERT INTO connector_installs (user_id, connector_id, status) VALUES (?, ?, 'installed')").run(u.id, id);
      schedules.ensureForInstall(u.id, id);
    }
  }
  const client = await helpers.startServer();
  await helpers.login(client, 'titulaire', 'MotDePasse1');
  await client.post('/api/users/me/deletion', { wantsExport: true });
  await client.post('/api/tickets', { subject: 'Essai de banc', message: 'Message inventé.' });
  client.clearCookies();
  await helpers.login(client, 'gerante', 'MotDePasse1');
  await client.post('/api/tickets', { subject: 'Essai de banc (gérante)', message: 'Message inventé.' });
  client.clearCookies();
  return { client, gerante, titulaire };
}

/** Les contrôles présents dans le DOM sous `selecteurs` (cachés compris : un onglet fermé reste un réglage). */
function releverSection(page, selecteurs) {
  return page.evaluate((liste) => {
    const out = [];
    for (const sel of liste) {
      const racine = document.querySelector(sel);
      if (!racine) continue;
      for (const el of racine.querySelectorAll('button, a[href], input, select, textarea, summary, [role="switch"], [onclick], [onchange], [oninput]')) {
        const geste = ['onclick', 'onchange', 'oninput', 'onkeydown']
          .map((a) => el.getAttribute(a)).filter(Boolean).join(' | ')
          .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
        const texte = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        out.push({
          balise: el.tagName.toLowerCase(),
          id: (el.id || '').replace(/\d+/g, '#'),
          nom: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '',
          texte: el.tagName === 'SELECT' ? '' : texte.replace(/\d+/g, '#'),
          geste,
        });
      }
    }
    return out;
  }, selecteurs);
}

/**
 * La signature d'un contrôle : son geste (les identifiants de service, de
 * planification et de destination remplacés par `'…'`, les nombres par `#`),
 * sinon son identifiant, sinon son texte. Un geste répété service par service
 * n'a donc qu'une signature.
 */
function signature(c) {
  let g = String(c.geste || '').replace('event.stopPropagation(); ', '').split(' | if(event.key')[0].trim();
  if (g.startsWith('if(event.key')) g = '';
  g = g.replace(/'#:[a-z0-9-]+'/g, "'…'")
    .replace(/'destination-([a-z0-9-]+)'/g, (tout, dest) => (SERVICES.has(dest) ? "'destination-…'" : tout))
    .replace(/'([a-z0-9][a-z0-9-]*)'/g, (tout, mot) => (SERVICES.has(mot) ? "'…'" : tout));
  const id = String(c.id || '').replace(/^dest-([a-z0-9-]+?)-(path|protocol)$/, (tout, dest) => (SERVICES.has(dest) ? `dest-…-${tout.split('-').pop()}` : tout));
  if (g) return `${c.balise}|${g}`;
  if (id) return `${c.balise}#${id}`;
  return `${c.balise}~${c.texte || c.nom}`;
}

/** Les identifiants des services et des destinations : ce qui varie d'un banc à l'autre. */
const SERVICES = new Set();
function connaitreLesServices() {
  const registry = require('../server/connectors/registry');
  for (const c of registry.listAll()) SERVICES.add(c.id);
  for (const d of require('../server/destinations/catalogue').list()) SERVICES.add(d.id);
}

/** Ouvre une section (le code d'avant le lot et celui d'après ont les mêmes portes) et relève ses contrôles. */
async function releverLaSection(page, vue, nom) {
  await page.evaluate(([v, n]) => {
    showView(v === 'profil' ? 'profil' : 'admin');
    if (v === 'profil') showProfilPage(n, document.querySelector(`[data-ppage="${n}"]`));
    else showAdminPage(n, document.querySelector(`[data-apage="${n}"]`));
  }, [vue, nom]);
  await page.waitForTimeout(700);
  const ou = vue === 'profil' ? [`#ppage-${nom}`, ...(nom === 'general' ? ['.profil-aside'] : [])] : [`#apage-${nom}`];
  const tous = [...await releverSection(page, ou)];
  for (const geste of DEPLIER[nom] || []) {
    await page.evaluate((g) => { try { (0, eval)(g); } catch { /* un geste absent se verra au relevé */ } }, geste);
    await page.waitForTimeout(500);
    tous.push(...await releverSection(page, ou));
  }
  return tous;
}

// ---------------------------------------------------------------------------
// Les autres pages (R4, R7) : leur rendu ne bouge pas.
// ---------------------------------------------------------------------------

/** Les écrans comparés, sur le banc de « Mes documents » du lot 107. `ui` : le réglage du compte. */
const AUTRES_PAGES = [
  { nom: 'accueil', ui: 'base', vue: 'home', zone: '#view-home', pret: "document.getElementById('home-widgets').innerHTML.length > 200" },
  { nom: 'documents-base', ui: 'base', vue: 'documents', zone: '#view-documents', pret: "document.getElementById('docs-content').innerHTML.length > 200 && !/Lecture de vos documents/.test(document.getElementById('docs-content').textContent)" },
  { nom: 'documents-explorateur', ui: 'explorer', vue: 'documents', zone: '#view-documents', pret: "!!document.querySelector('.explo-ligne-choix, .explo-icone')" },
  { nom: 'notifications', ui: 'base', vue: 'notifications', zone: '#view-notifications', pret: "document.getElementById('notifs-content').innerHTML.length > 20" },
  { nom: 'suivi', ui: 'base', vue: 'suivi', zone: '#view-suivi', pret: "document.getElementById('suivi-liste').innerHTML.length > 20" },
];

/**
 * L'empreinte d'un écran ouvert : son HTML, et sa MISE EN PAGE — pour chaque
 * élément, sa boîte (arrondie au pixel), sa couleur, son fond, sa police, sa
 * taille de texte, son affichage. Les mesures du disque de l'essai bougent
 * d'une passe à l'autre (« 7.10 Go restants », « Volume occupé à 8 % », sa
 * jauge, « (mesuré dans 11 j) » — l'heure réelle du serveur face à l'horloge
 * figée) : elles sont neutralisées dans la page avant la mesure. Le reste vient
 * de l'horloge figée du navigateur.
 */
async function empreinteDeLaZone(page, zone) {
  const crypto = require('node:crypto');
  const { html, styles } = await page.evaluate((sel) => {
    const racine = document.querySelector(sel);
    const marcheur = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
    while (marcheur.nextNode()) {
      const n = marcheur.currentNode;
      n.nodeValue = n.nodeValue
        .replace(/\d+(?:[.,]\d+)? ?(?:[KMGT]?o) restants/g, '0.00 Go restants')
        .replace(/\(mesuré [^)]*\)/g, '(mesuré)');
    }
    for (const el of racine.querySelectorAll('[title]')) {
      el.setAttribute('title', el.getAttribute('title')
        .replace(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/g, 'JJ/MM/AAAA HH:MM')
        .replace(/Volume occupé à \d+ %/g, 'Volume occupé à N %'));
    }
    for (const el of racine.querySelectorAll('.dest-space-fill')) el.style.width = '0%';
    const styles = [];
    for (const el of [racine, ...racine.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      styles.push([el.tagName, el.id, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
        c.color, c.backgroundColor, c.fontFamily, c.fontSize, c.fontWeight, c.display, c.borderTopColor]);
    }
    return { html: racine.outerHTML, styles };
  }, zone);
  const h = (x) => crypto.createHash('sha256').update(x).digest('hex');
  return {
    html: h(html),
    miseEnPage: h(JSON.stringify(styles)),
  };
}

module.exports = {
  AUTRES_PAGES,
  empreinteDeLaZone,
  SECTIONS_PROFIL,
  SECTIONS_ADMIN,
  DEPLIER,
  poserLeBanc,
  releverSection,
  releverLaSection,
  signature,
  connaitreLesServices,
  racine: path.join(__dirname, '..'),
};
