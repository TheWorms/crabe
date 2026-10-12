'use strict';

/**
 * Lot 97 — R7 : les chiffres de l'accueil, chacun à sa source.
 *
 * ─── Ce qui a été mesuré (06/10/2026, copie de la base de production) ───────
 *
 *   - « factures ce mois-ci » : 215, les lignes de `invoices` dont `fetched_at`
 *     tombait dans le mois UTC. Or `fetched_at` est remis à l'heure quand un
 *     document déjà archivé est redéposé (8 anciens documents comptés comme
 *     neufs), et le mois se coupait à minuit UTC. Les récupérations du mois
 *     ont annoncé 221 nouveaux documents ;
 *   - « connecteur(s) actif(s) » : 41, pour 45 vignettes — les services en
 *     défaut (session expirée) n'étaient pas comptés ;
 *   - « dernière synchronisation réussie » : le DÉBUT de la récupération, 29
 *     minutes avant sa fin ;
 *   - « Services connectés au fil du temps » : 46 pour 45 services — la ligne
 *     d'installation d'un service devenu annoncé (CAF) comptait ;
 *   - « Suivi actions » : « 6 à jour » pour 41 services à jour (la liste n'en
 *     montre que six), et la trace d'échec de CAF, devenu annoncé ;
 *   - les mois des graphiques coupés à minuit UTC.
 *
 * ─── Ce que ce fichier verrouille ────────────────────────────────────────────
 *
 * Une base temporaire aux valeurs CONNUES, construite autour du début du mois
 * à Paris : un passage terminé le 1er à 00 h 30 (heure de Paris) appartient à
 * ce mois-ci, alors qu'il appartient encore au mois d'avant en UTC. Chaque
 * chiffre est vérifié deux fois : calculé par le serveur (`home.stats`, le
 * bloc « Suivi »), puis LU À L'ÉCRAN au vrai Chromium. Les comptes attendus
 * sont faits ici, indépendamment du code de l'accueil (fuseau compris).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');

const FUSEAU = 'Europe/Paris';
const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Les composantes d'un instant à Paris — sans le code de crabe. */
function aParis(date) {
  const p = {};
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSEAU, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  for (const { type, value } of format.formatToParts(date)) p[type] = value;
  return p;
}
const moisParis = (date) => { const p = aParis(date); return `${p.year}-${p.month}`; };

/** L'instant UTC où commence, à Paris, le mois de `date` (UTC+1 l'hiver, UTC+2 l'été). */
function debutDuMoisParis(date) {
  const p = aParis(date);
  for (const decalage of [1, 2]) {
    const candidat = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, 1) - decalage * 3_600_000);
    const q = aParis(candidat);
    if (q.day === '01' && q.hour === '00' && q.minute === '00' && `${q.year}-${q.month}` === `${p.year}-${p.month}`) {
      return candidat;
    }
  }
  throw new Error('début de mois introuvable');
}

const enSqlite = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const minutes = (n) => n * 60_000;
const libelleMois = (periode) => {
  const [annee, mois] = periode.split('-');
  return `${MOIS_LONGS[Number(mois) - 1]} ${annee}`;
};

function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = playwrightOuNull();

const MAINTENANT = new Date();
const DEBUT = debutDuMoisParis(MAINTENANT);
// Le premier quart d'heure… et un peu plus : l'essai a besoin d'une heure de
// mois écoulée pour y poser ses passages sans en mettre aucun dans le futur.
const TROP_TOT = MAINTENANT.getTime() < DEBUT.getTime() + minutes(75);

test('D7 — chaque chiffre de l\'accueil égale le compte attendu, côté serveur puis à l\'écran (vrai Chromium)', {
  skip: TROP_TOT
    ? 'moins de 75 minutes écoulées dans le mois (heure de Paris) : l\'essai ne peut pas encore y poser ses passages'
    : PLAYWRIGHT ? false : 'Playwright absent : le parcours au vrai Chromium n\'est pas joué.',
  timeout: 180_000,
}, async (t) => {
  const registry = require('../server/connectors/registry');
  const home = require('../server/home');

  await helpers.setup();
  t.after(() => helpers.teardown());
  // Lot 108, par décision : EDF joue ici « un service désinstallé dont la
  // trace reste ». Non faisable depuis le lot 106, il a quitté l'accueil au
  // lot 108 — ce que cet essai ne regarde pas : le drapeau est levé sur le
  // registre chargé, dans ce processus seulement (comme isolation, schedules,
  // logs). Le retrait est éprouvé par test/lot108-non-faisables.
  registry.manifest('edf').unfeasible = '';
  const user = await helpers.createUser({ username: 'lot97accueil', plainPassword: 'MotDePasse1', role: 'admin' });
  const db = helpers.db.get();

  // ── Les instants de l'essai ─────────────────────────────────────────────
  const bord = new Date(DEBUT.getTime() + minutes(30)); // le 1er à 00:30, heure de Paris
  assert.notEqual(moisParis(bord), bord.toISOString().slice(0, 7), 'le bord est bien un mois plus tôt en UTC');
  const fin = MAINTENANT.getTime() - minutes(15);
  const dansLeMois = (fraction) => new Date(bord.getTime() + minutes(5) + fraction * (fin - bord.getTime() - minutes(5)));
  const moisPrecedent = new Date(DEBUT.getTime() - 10 * 86_400_000);
  const ilYa = (n) => new Date(MAINTENANT.getTime() - minutes(n));
  const aujourdHuiParis = (() => { const p = aParis(MAINTENANT); return `${p.year}-${p.month}-${p.day}`; })();
  const periode = moisParis(MAINTENANT);
  const periodePrecedente = moisParis(moisPrecedent);

  // ── Les installations ───────────────────────────────────────────────────
  const installer = (connectorId, status, installeLe, { pause = null } = {}) => db.prepare(
    `INSERT INTO connector_installs (user_id, connector_id, status, installed_at, disabled_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(user.id, connectorId, status, enSqlite(installeLe), pause ? enSqlite(pause) : null);
  for (const id of ['amazon', 'spotify', 'deezer', 'soundcloud', 'ouigo', 'airbnb', 'atma']) {
    installer(id, 'installed', moisPrecedent);
  }
  installer('ovh', 'error', moisPrecedent);
  installer('kubii', 'needs-config', moisPrecedent); // jamais configuré : pas « connecté »
  installer('free', 'installed', moisPrecedent, { pause: ilYa(30) }); // en pause
  installer('caf', 'installed', moisPrecedent); // la ligne restée d'un service devenu annoncé
  installer('boulanger', 'installed', new Date(DEBUT.getTime() + minutes(10))); // le 1er à 00:10, Paris
  assert.equal(registry.isPlanned('caf'), true, 'CAF est bien une annonce');

  // ── Les passages ────────────────────────────────────────────────────────
  const passage = (connectorId, debut, finLe, { ok = true, nouveaux = 0, declencheur = 'manual', cause = null } = {}) => db.prepare(
    `INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, invoice_count, trigger, message, cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(connectorId, user.id, enSqlite(debut), finLe ? enSqlite(finLe) : null, ok ? 1 : 0, nouveaux,
    declencheur, ok ? 'Passage d\'essai.' : 'Échec d\'essai.', ok ? null : cause);
  passage('amazon', dansLeMois(0.10), dansLeMois(0.12), { nouveaux: 3 });
  passage('boulanger', new Date(DEBUT.getTime() + minutes(20)), bord, { nouveaux: 2, declencheur: 'cron' });
  passage('atma', dansLeMois(0.15), dansLeMois(0.16));
  passage('atma', dansLeMois(0.20), dansLeMois(0.21), { nouveaux: 4, declencheur: 'test' }); // un essai : jamais compté
  passage('soundcloud', dansLeMois(0.30), dansLeMois(0.31));
  passage('soundcloud', dansLeMois(0.95), null); // en cours : ni réussi, ni échoué
  passage('ovh', dansLeMois(0.40), dansLeMois(0.41), { ok: false, cause: 'echec' });
  passage('free', dansLeMois(0.50), dansLeMois(0.51), { nouveaux: 1 });
  passage('caf', dansLeMois(0.60), dansLeMois(0.61), { ok: false, cause: 'echec' });
  passage('airbnb', dansLeMois(0.70), dansLeMois(0.71));
  passage('ouigo', moisPrecedent, new Date(moisPrecedent.getTime() + minutes(5)), { nouveaux: 7 });
  passage('edf', new Date(moisPrecedent.getTime() + 86_400_000), new Date(moisPrecedent.getTime() + 86_400_000 + minutes(2)),
    { ok: false, cause: 'echec' }); // un service désinstallé : sa trace reste
  // La dernière réussite : « spotify » a commencé AVANT « deezer » mais fini APRÈS.
  passage('spotify', ilYa(10), ilYa(1));
  passage('deezer', ilYa(3), ilYa(2));
  passage('deezer', new Date(MAINTENANT.getTime() - 40_000), new Date(MAINTENANT.getTime() - 30_000), { declencheur: 'test' });
  const derniereReussite = enSqlite(ilYa(1));

  // ── Les documents ───────────────────────────────────────────────────────
  let octets = 0;
  const documentEssai = (connectorId, nom, emisLe, arriveLe, taille) => {
    octets += taille;
    db.prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, account_id, size_bytes, issued_on, fetched_at, destinations)
       VALUES (?, ?, ?, 'defaut', ?, ?, ?, '{}')`
    ).run(user.id, connectorId, nom, taille, emisLe, enSqlite(arriveLe));
  };
  documentEssai('amazon', 'amazon-1.pdf', aujourdHuiParis, dansLeMois(0.12), 1000);
  documentEssai('amazon', 'amazon-2.pdf', `${periodePrecedente}-12`, dansLeMois(0.12), 2000);
  documentEssai('amazon', 'amazon-3.pdf', `${periodePrecedente}-03`, dansLeMois(0.12), 3000);
  documentEssai('boulanger', 'boulanger-1.pdf', null, bord, 4000); // non daté, arrivé le 1er à 00:30
  documentEssai('boulanger', 'boulanger-2.pdf', `${periodePrecedente}-20`, bord, 5000);
  documentEssai('free', 'free-1.pdf', aujourdHuiParis, dansLeMois(0.51), 6000);
  documentEssai('ouigo', 'ouigo-ancien.pdf', '2025-12-15', dansLeMois(0.80), 7000); // ancien, redéposé ce mois-ci
  for (let i = 1; i <= 4; i++) {
    documentEssai('soundcloud', `soundcloud-${i}.pdf`, `${periodePrecedente}-0${i}`, moisPrecedent, 500 * i);
  }

  // ── Les comptes ATTENDUS, faits ici ─────────────────────────────────────
  const attendu = {
    documentsCeMois: 3 + 2 + 1, // amazon, boulanger (fini le 1er à 00:30), free — ni l'essai, ni le mois d'avant
    documentsAuTotal: 11,
    octets,
    actifs: 10, // installés hors pause et hors annonce : tous les états comptent
    documentsDuMois: 3, // datés de ce mois (2), et le non daté arrivé le 1er à 00:30
    servicesConnectes: 10, // vrais connecteurs, hors « à configurer », pause comprise
    servicesConnectesMoisPrecedent: 9, // boulanger est installé le 1er à 00:10, heure de Paris
    enEchec: 2, // ovh (en défaut) et edf (désinstallé) — pas CAF, devenu annoncé
    aConfigurer: 1, // kubii
    aJour: 8,
  };
  const passagesFinis = db.prepare("SELECT started_at, success FROM run_logs WHERE trigger != 'test' AND finished_at IS NOT NULL").all();
  const duMois = passagesFinis.filter((r) => moisParis(new Date(`${r.started_at.replace(' ', 'T')}Z`)) === periode);
  attendu.reussies = duMois.filter((r) => r.success).length;
  attendu.enEchecDuMois = duMois.filter((r) => !r.success).length;
  assert.deepEqual([attendu.reussies, attendu.enEchecDuMois], [8, 2], 'le passage du 1er à 00:20 compte pour ce mois-ci');

  // ── 1. Le serveur ───────────────────────────────────────────────────────
  const s = home.stats(user);
  assert.equal(s.invoicesThisMonth, attendu.documentsCeMois, 'documents récupérés ce mois-ci : les nouveaux annoncés par les passages du mois');
  assert.equal(s.invoicesTotal, attendu.documentsAuTotal);
  assert.equal(s.bytes, attendu.octets);
  assert.equal(s.activeConnectors, attendu.actifs, 'connecteurs actifs : les vignettes, en défaut comprises');
  assert.equal(s.lastSuccessAt, derniereReussite, 'la FIN de la dernière réussite');
  assert.equal(s.parMois.at(-1).periode, periode);
  assert.equal(s.parMois.at(-1).count, attendu.documentsDuMois, 'documents du mois : le non daté du 1er à 00:30 compte');
  assert.equal(s.connecteursDansLeTemps.at(-1).count, attendu.servicesConnectes);
  assert.equal(s.connecteursDansLeTemps.at(-2).count, attendu.servicesConnectesMoisPrecedent);
  assert.deepEqual(s.executionsParMois.at(-1), { periode, ok: attendu.reussies, ko: attendu.enEchecDuMois });
  const tuiles = home.connectorTiles(user);
  assert.equal(tuiles.length, attendu.actifs, 'autant de connecteurs actifs que de vignettes');
  assert.deepEqual(home.recentErrors(user).map((e) => e.connectorId).sort(), ['edf', 'ovh']);
  // La liste reste bornée à six lignes ; la borne joue AVANT que le service en
  // pause soit écarté (comportement d'avant ce lot) : cinq lignes ici.
  const lignesVertes = home.recentSuccesses(user).length;
  assert.ok(lignesVertes <= 6 && lignesVertes < attendu.aJour, `la liste montre ${lignesVertes} ligne(s)`);
  const tableau = await home.dashboard(user);
  assert.equal(tableau.aJour.length, attendu.aJour);

  // ── 2. L'écran ──────────────────────────────────────────────────────────
  const client = await helpers.startServer();
  t.after(() => client.close());
  const reponse = await fetch(`${client.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lot97accueil', password: 'MotDePasse1' }),
  });
  const brut = (reponse.headers.getSetCookie?.() || []).find((c) => c.startsWith('crabe.sid='));
  assert.ok(brut, 'cookie de session absent');

  const navigateur = await PLAYWRIGHT.chromium.launch({ headless: true });
  t.after(() => navigateur.close());
  const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
  await contexte.addCookies([{
    name: 'crabe.sid', value: brut.split(';')[0].split('=').slice(1).join('='), domain: '127.0.0.1', path: '/',
  }]);
  const page = await contexte.newPage();
  const erreursJs = [];
  page.on('pageerror', (e) => erreursJs.push(String(e)));
  await page.goto(`${client.base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.stats-row .stat-box');

  const boites = await page.$$eval('.stats-row .stat-box', (els) => els.map((e) => ({
    valeur: e.querySelector('.stat-val').textContent.trim(),
    exact: e.querySelector('.stat-val').getAttribute('title'),
    etiquette: e.querySelector('.stat-label').textContent.trim(),
    aide: e.getAttribute('title'),
  })));
  t.diagnostic(`compteurs à l'écran : ${JSON.stringify(boites.map((b) => [b.valeur, b.etiquette]))}`);
  const poids = await page.evaluate((n) => fmt.bytes(n), attendu.octets);
  const exact = await page.evaluate((d) => fmt.exact(d), derniereReussite);
  assert.deepEqual(boites.map((b) => [b.valeur, b.etiquette]), [
    [String(attendu.documentsCeMois), 'document(s) récupéré(s) ce mois-ci'],
    [String(attendu.documentsAuTotal), 'document(s) au total'],
    [poids, 'poids de vos documents'],
    [String(attendu.actifs), 'connecteur(s) actif(s)'],
    [boites[4].valeur, 'dernière récupération réussie'],
  ]);
  assert.equal(boites[4].exact, exact, 'l\'heure exacte au survol : la fin de la dernière réussite');
  for (const b of boites.slice(0, 4)) assert.ok((b.aide || '').length > 20, `« ${b.etiquette} » dit ce qu'il compte au survol`);

  // Le bilan du « Suivi actions ».
  const bilan = await page.$$eval('.err-bilan span', (els) => els.map((e) => e.textContent.trim()));
  t.diagnostic(`bilan à l'écran : ${JSON.stringify(bilan)}`);
  assert.deepEqual(bilan, [`${attendu.enEchec} en échec`, `${attendu.aConfigurer} à configurer`, `${attendu.aJour} à jour`]);
  assert.equal((await page.textContent('.err-plus')).trim(),
    `Et ${attendu.aJour - lignesVertes} autres services à jour : leur dernière récupération a réussi.`);
  assert.equal(await page.locator('.err-item.succes').count(), lignesVertes, 'les lignes vertes montrées');

  // Les graphiques, tous allumés.
  await page.evaluate(() => {
    toggleStatsChart('stockage', true);
    toggleStatsChart('connecteurs-temps', true);
    toggleStatsChart('executions', true);
  });
  await page.waitForFunction(() => document.querySelectorAll('#home-widgets .chart').length >= 5);
  const bulles = await page.$$eval('#home-widgets .chart title', (els) => els.map((e) => e.textContent.trim()));
  const mois = libelleMois(periode);
  for (const attendue of [
    `${mois} — ${attendu.documentsDuMois} document(s) daté(s) de ce mois`,
    `${mois} — ${attendu.servicesConnectes} service(s) connecté(s)`,
    `${libelleMois(periodePrecedente)} — ${attendu.servicesConnectesMoisPrecedent} service(s) connecté(s)`,
    `${mois} — ${attendu.reussies} réussie(s)`,
    `${mois} — ${attendu.enEchecDuMois} en échec`,
  ]) {
    assert.ok(bulles.includes(attendue), `infobulle attendue : « ${attendue} »`);
  }
  const titres = await page.$$eval('#home-widgets .chart-title', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(titres.some((x) => x.startsWith('Documents par mois')), 'le graphique des mois dit « Documents »');
  assert.ok(titres.includes('Poids des documents par service'));
  assert.deepEqual(erreursJs, [], 'aucune erreur JavaScript dans la page');
});
