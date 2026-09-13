'use strict';

/**
 * Connecteur Free Internet (Freebox).
 *
 * Portail : https://subscribe.free.fr/login/ → redirige vers adsl.free.fr avec
 * un jeton de session (`idt`) placé dans l'URL. L'URL de la page des factures
 * n'est donc PAS prévisible : il faut suivre le lien « Voir toutes mes
 * factures » plutôt que d'y accéder directement.
 *
 * Les liens de téléchargement (`a.btn_download`) portent tout ce dont on a
 * besoin dans leurs paramètres :
 *   facture_pdf.pl?…&mois=202607&no_facture=1487193649
 * On lit donc la période et la référence dans l'URL, jamais dans le texte
 * affiché — beaucoup plus stable qu'un « Juillet 2026 » qui peut être
 * réécrit à tout moment.
 *
 * VALIDÉ le 30/07/2026 contre un compte réel : 6/6 factures récupérées.
 *
 * Note sur l'historique : Free n'affiche que les années présentes dans le
 * compte, sous forme de sections dépliables (`<h3 class="tab">Factures 2026`).
 * L'extraction lit tout le DOM sans filtrer sur la visibilité, donc les
 * sections repliées sont prises en compte. Ce point n'a pas pu être vérifié
 * sur un compte à plusieurs années : si Free chargeait les années anciennes en
 * AJAX au clic, il faudrait déplier chaque section avant l'extraction.
 */

const identity = require('../../browser-identity');
const cookieBanner = require('../../obstructions');
const history = require('../../history');

const LOGIN_URL = 'https://subscribe.free.fr/login/';
const INVOICES_LINK = 'Voir toutes mes factures';
const DOWNLOAD_SELECTOR = 'a.btn_download';
const NAV_TIMEOUT_MS = 45_000;
const DEFAULT_MONTHS_BACK = 12;

/** Clé du champ de profondeur d'historique, commune à tous les manifestes. */
const CHAMP_HISTORIQUE = 'historique';

const CREDENTIAL_KEYS = ['username', 'password'];

function requireCredentials(config) {
  const missing = CREDENTIAL_KEYS.filter((k) => !config?.[k]);
  if (missing.length) {
    throw new Error(`Identifiants manquants pour Free Internet : ${missing.join(', ')}`);
  }
}

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur Free ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** « 202607 » → « 2026-07 » ; null si le format est inattendu. */
function moisToYearMonth(mois) {
  return /^\d{6}$/.test(mois || '') ? `${mois.slice(0, 4)}-${mois.slice(4, 6)}` : null;
}

/** Bornes de la fenêtre d'historique, en « AAAA-MM ». */
function oldestYearMonth(monthsBack) {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Le mois le plus ancien à retenir — `null` pour « tout ce que Free affiche ».
 *
 * Le réglage du compte prime sur `ctx.monthsBack`, que le planificateur envoie
 * à douze pour tout le monde : le lire en premier remettrait le plafond que le
 * lot 17 est venu enlever. Sans réglage enregistré, on garde le comportement
 * d'avant, à l'identique.
 */
function borneHistorique(config, ctx) {
  if (!config?.[CHAMP_HISTORIQUE]) {
    const plan = { mode: 'defaut', raison: `les ${ctx.monthsBack || DEFAULT_MONTHS_BACK} derniers mois` };
    return { borne: oldestYearMonth(ctx.monthsBack || DEFAULT_MONTHS_BACK), plan };
  }

  const plan = history.fenetreDeDates({
    valeur: config[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant qu'un
    // plancher protège l'existant.
    plafondMois: ctx?.conservationMois || 0,
  });
  return { borne: plan.from ? plan.from.toISOString().slice(0, 7) : null, plan };
}

/**
 * Ouvre un navigateur, se connecte, atteint la liste des factures, puis passe
 * la main à `fn(page, context)`. Le navigateur est toujours refermé.
 */
async function withInvoicesPage(config, fn, log = () => {}) {
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : voir connectors/browser-identity.js.
  const context = await browser.newContext(identity.optionsContexte({ acceptDownloads: true }));
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // Avant toute interaction avec le formulaire, comme partout ailleurs : un
    // bandeau de cookies recouvre aussi bien les champs que le bouton, et un
    // clic intercepté ressemble trait pour trait à un mot de passe refusé.
    // Free n'en affiche pas aujourd'hui ; rien ne dit qu'il en sera de même
    // demain, et l'appel ne coûte rien quand il n'y a rien à fermer.
    await cookieBanner.fermer(page, { cible: 'form', log, prefixe: 'Free' });

    await page.getByRole('textbox', { name: 'Identifiant' }).fill(config.username);
    await page.getByRole('textbox', { name: 'Mot de passe' }).fill(config.password);
    try {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.getByRole('button', { name: 'Se connecter' }).click(),
      ]);
    } catch (err) {
      if (!cookieBanner.estClicIntercepte(err)) throw err;
      throw new Error(
        'Une fenêtre du site (bandeau de cookies) empêche la connexion à Free. '
          + 'Signalez-le, ce service doit être adapté.'
      );
    }

    // Toujours sur /login → le formulaire a été refusé.
    if (/subscribe\.free\.fr\/login/.test(page.url())) {
      throw new Error(
        'Identifiant ou mot de passe Free incorrect, ou validation supplémentaire '
          + 'demandée par le portail. Corrigez-les sur la fiche du service, puis relancez.'
      );
    }

    const link = page.getByRole('link', { name: INVOICES_LINK });
    if (!(await link.count())) {
      throw new Error(
        `Connexion établie mais le lien « ${INVOICES_LINK} » est introuvable — `
          + 'le portail Free a probablement changé, le connecteur doit être mis à jour.'
      );
    }
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      link.click(),
    ]);

    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Liste les factures visibles, sans rien télécharger.
 *
 * @param {object} page
 * @param {string|null} floor mois le plus ancien retenu (« AAAA-MM »), ou
 *                            `null` pour ne rien écarter
 * @returns {Promise<Array<{remoteId, reference, yearMonth, issuedOn, filename, href}>>}
 */
async function listInvoices(page, floor) {
  const hrefs = await page.$$eval(DOWNLOAD_SELECTOR, (as) => as.map((a) => a.href));

  const invoices = [];
  for (const href of hrefs) {
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const yearMonth = moisToYearMonth(url.searchParams.get('mois'));
    const reference = url.searchParams.get('no_facture');
    if (!yearMonth || !reference) continue;
    if (floor && yearMonth < floor) continue;

    invoices.push({
      remoteId: reference,
      reference,
      yearMonth,
      issuedOn: `${yearMonth}-01`,
      filename: `${yearMonth}_${reference}.pdf`,
      href,
    });
  }

  // Plus récentes d'abord, doublons éventuels écartés.
  const seen = new Set();
  return invoices
    .filter((i) => (seen.has(i.remoteId) ? false : seen.add(i.remoteId)))
    .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
}

/**
 * Vérification d'authentification : se connecte et compte les factures, sans
 * télécharger aucun PDF.
 */
async function test(config, ctx = {}) {
  requireCredentials(config);
  const { borne } = borneHistorique(config, ctx);

  return withInvoicesPage(config, async (page) => {
    const invoices = await listInvoices(page, borne);
    const latest = invoices[0];
    return {
      ok: true,
      invoiceCount: invoices.length,
      // L'identifiant de connexion (ex. fbx22222222) EST l'identifiant de
      // compte : il devient le dossier de destination.
      accountId: config.username,
      message:
        `Connexion réussie — compte ${config.username} · ${invoices.length} facture(s) visible(s)`
        + (latest ? ` · plus récente : ${latest.yearMonth}` : ''),
    };
  }, ctx.log);
}

/**
 * Télécharge les factures non encore connues.
 *
 * Le téléchargement passe par le contexte authentifié (`context.request`)
 * plutôt que par un clic + événement « download » : c'est plus fiable, et les
 * cookies de session sont réutilisés tels quels.
 */
async function fetchInvoices(config, ctx = {}) {
  requireCredentials(config);
  const { borne, plan } = borneHistorique(config, ctx);
  const known = new Set((ctx.knownRemoteIds || []).map(String));

  return withInvoicesPage(config, async (page, context) => {
    const all = await listInvoices(page, borne);
    const pending = all.filter((i) => !known.has(i.remoteId));

    ctx.log?.(`free: historique « ${plan.mode} » — ${plan.raison}`);
    ctx.log?.(`free: ${all.length} facture(s) listée(s), ${pending.length} à récupérer`);

    // Preuve d'accès (lot 31), déposée seulement si des factures sont bien
    // listées : les liens « no_facture » n'existent que dans l'espace abonné
    // connecté. Un compte Freebox reçoit une facture par mois — zéro ligne ne
    // serait pas un compte vide mais une page qui n'a pas été lue, et le socle
    // doit alors refuser de conclure.
    if (all.length > 0) {
      ctx.preuveDeListe?.({
        session: `${all.length} facture(s) listée(s) dans l'espace abonné`,
        liste: 'page des factures de l\'espace abonné Free',
        elements: all.length,
      });
    }

    const invoices = [];
    for (const inv of pending) {
      const res = await context.request.get(inv.href, { timeout: NAV_TIMEOUT_MS });
      if (!res.ok()) {
        ctx.log?.(`free: facture ${inv.reference} — HTTP ${res.status()}, ignorée`);
        continue;
      }
      const buffer = Buffer.from(await res.body());
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        ctx.log?.(
          `free: facture ${inv.reference} — le contenu reçu n'est pas un PDF `
            + `(${buffer.length} o), session probablement expirée`
        );
        continue;
      }

      invoices.push({
        remoteId: inv.remoteId,
        filename: inv.filename,
        issuedOn: inv.issuedOn,
        amount: null, // non exposé par le portail sur cette page
        buffer,
      });
    }

    return { accountId: config.username, invoices };
  }, ctx.log);
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  listInvoices,
  moisToYearMonth,
  oldestYearMonth,
  LOGIN_URL,
  DOWNLOAD_SELECTOR,
};
