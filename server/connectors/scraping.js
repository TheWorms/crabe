'use strict';

/**
 * Socle de scraping partagé par les connecteurs sans API publique.
 *
 * ÉTAT ACTUEL — à lire avant de croire qu'un connecteur « marche » :
 *
 *   Playwright n'est PAS une dépendance de crabe (≈ 500 Mo de navigateurs à
 *   installer sur le LXC). Chaque connecteur décrit sa recette de scraping —
 *   URL de connexion, sélecteurs, page des factures — et deux chemins
 *   d'exécution sont prévus :
 *
 *   1. Playwright installé (`npm i playwright && npx playwright install chromium`)
 *      → `runRecipe*()` exécute réellement la recette.
 *      // TODO: scraping réel non validé — les sélecteurs sont plausibles mais
 *      //       n'ont été testés contre AUCUN site réel. Ils changeront ; il
 *      //       faut les vérifier fournisseur par fournisseur avec un vrai
 *      //       compte avant de considérer un connecteur comme fonctionnel.
 *
 *   2. Playwright absent (cas par défaut)
 *      → `simulate*()` renvoie un succès ou un échec aléatoire et fabrique des
 *        PDF de test valides, pour que l'UI, le scheduler, les destinations et
 *        les journaux soient testables de bout en bout.
 *
 * Les identifiants viennent toujours de la configuration chiffrée du
 * connecteur ; ils ne sont jamais journalisés.
 */

const identity = require('./browser-identity');
const cookieBanner = require('./obstructions');
const history = require('./history');

const NAV_TIMEOUT_MS = 45_000;
const SIMULATED_FAILURE_RATE = 0.15;

/** Clé du champ de profondeur d'historique, commune à tous les manifestes. */
const CHAMP_HISTORIQUE = 'historique';

/**
 * Combien de mois la simulation invente quand la fenêtre n'a pas de borne
 * basse (« toutes les années disponibles », ou premier passage du mode
 * « depuis »).
 *
 * Un portail réel rendrait tout son passé ; une simulation, elle, doit bien
 * s'arrêter quelque part. Trois ans suffisent à MONTRER que le réglage remonte
 * au-delà des douze mois d'avant le lot 17 — c'est tout ce qu'on lui demande.
 */
const MOIS_SIMULES_SANS_BORNE = 36;

/**
 * La profondeur demandée par l'utilisateur, ou `null` s'il n'a rien réglé.
 *
 * ⚠ L'ordre compte. Le réglage du compte prime TOUJOURS sur `ctx.monthsBack` :
 * le planificateur envoie `monthsBack: 12` à tout le monde, et le lire en
 * premier remettrait le plafond de douze mois que le lot 17 est venu enlever.
 * `ctx.monthsBack` ne reste qu'un repli, pour un appel direct — un test — qui
 * n'a pas de configuration à lire.
 */
function planHistorique(config, ctx) {
  if (!config?.[CHAMP_HISTORIQUE]) return null;
  return history.fenetreDeDates({
    valeur: config[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    // Le plafond de conservation (lot 24) : inutile d'aller chercher 2020 si
    // l'entretien de cette nuit efface tout ce qui dépasse un an.
    plafondMois: ctx?.conservationMois || 0,
  });
}

/**
 * Une date ISO tombe-t-elle dans la fenêtre retenue ?
 *
 * Un document SANS date passe toujours — même règle que les boutiques
 * PrestaShop. Ne pas savoir dater une facture n'est pas une raison de la
 * perdre : elle sera dédoublonnée par son identifiant distant.
 */
function dansLaFenetre(issuedOn, plan) {
  if (!plan || !plan.from || !issuedOn) return true;
  return String(issuedOn) >= plan.from.toISOString().slice(0, 10);
}

/**
 * « Des documents existent, mais tous sont plus vieux que la période demandée »
 * — la phrase, et le geste qui l'ouvre.
 *
 * Le 19/08/2026, SoundCloud a vu 24 reçus, n'en a rapporté aucun (tous
 * antérieurs à 2026, l'année demandée) et l'écran a affiché « Aucune nouvelle
 * facture » : le contraire de la vérité, puisque 24 factures attendaient. Ce
 * cas est le TROISIÈME, distinct des deux connus :
 *
 *   - « tout était déjà récupéré » → le message générique, inchangé ;
 *   - « le service ne propose aucun document » → `aucunDocument` (lot 41) ;
 *   - ici → des documents récupérables existent, aucun n'est dans la fenêtre.
 *
 * @param {number} nombre combien de documents ont été vus hors période
 * @param {string} mot comment les nommer (« reçu », « facture »…)
 * @param {{feminin?: boolean}} options le genre du mot, pour que la phrase
 *   s'accorde : « 3 factures existent, toutes antérieures… ».
 * @returns {string} phrase complète, prête pour l'écran
 */
function phraseHorsPeriode(nombre, mot = 'document', { feminin = false } = {}) {
  const n = Math.max(1, Number(nombre) || 1);
  const s = n > 1 ? 's' : '';
  const e = feminin ? 'e' : '';
  const sujet = n > 1 ? (feminin ? 'elles' : 'ils') : (feminin ? 'elle' : 'il');
  const anterieurs = n > 1 ? `tou${feminin ? 'tes' : 's'} antérieur${e}s` : `antérieur${e}`;
  return (
    `${n} ${mot}${s} existe${n > 1 ? 'nt' : ''}, ${anterieurs} à la période demandée : `
    + `${sujet} n'${n > 1 ? 'ont' : 'a'} pas été examiné${e}${s}. `
    + 'Élargissez « Historique à récupérer » dans les réglages du service pour '
    + `${n > 1 ? 'les' : (feminin ? 'la' : 'le')} récupérer.`
  );
}

/**
 * Playwright est-il utilisable dans ce déploiement ?
 *
 * `CRABE_DISABLE_SCRAPING=1` répond non même si la dépendance est installée :
 * c'est ce que pose `test/helpers.js`. Sans lui, depuis que `playwright` est
 * une dépendance optionnelle (lot 5), la suite de tests ouvrirait de vrais
 * navigateurs vers EDF, Orange ou SFR avec des identifiants inventés — les
 * onze recettes de ce module n'ayant jamais été validées, ce serait à la fois
 * lent, aléatoire, et impoli.
 */
function isPlaywrightAvailable() {
  if (require('../config').config.scrapingDisabled) return false;
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Fabrique un PDF minimal mais valide (ouvrable par n'importe quel lecteur).
 * @param {string[]} lines lignes de texte à afficher
 */
function fakePdf(lines) {
  const rows = Array.isArray(lines) ? lines : [String(lines)];
  const escaped = rows.map((l) => String(l).replace(/([()\\])/g, '\\$1'));
  const text = escaped
    .map((line, i) => `BT /F1 12 Tf 60 ${760 - i * 20} Td (${line}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Les `count` derniers mois, du plus récent au plus ancien : ['2026-07', …].
 *
 * L'arithmétique se fait sur (année, mois) et non par `setMonth()` sur la date
 * du jour : reculer d'un mois depuis un 29, 30 ou 31 déborde sur le mois
 * suivant (29 juillet -> 29 février inexistant -> 1er mars) et produit deux
 * fois le même mois.
 */
function recentMonths(count) {
  const months = [];
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-11

  for (let i = 0; i < count; i++) {
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Chemin simulé (Playwright absent)
// ---------------------------------------------------------------------------

/**
 * Décide de l'issue d'une exécution simulée.
 * `ctx.forceOutcome` ('ok' | 'fail') rend le comportement déterministe pour
 * les tests automatisés.
 */
function rollOutcome(ctx, failureRate) {
  if (ctx?.forceOutcome === 'ok') return true;
  if (ctx?.forceOutcome === 'fail') return false;
  return Math.random() >= failureRate;
}

function simulateTest(recipe, ctx) {
  if (!rollOutcome(ctx, recipe.failureRate)) {
    return {
      ok: false,
      simulated: true,
      message: `[SIMULATION] Échec — identifiants refusés par ${recipe.providerName}`,
    };
  }
  const count = recipe.monthsBack;
  return {
    ok: true,
    simulated: true,
    invoiceCount: count,
    message:
      `[SIMULATION] Connexion réussie sur ${recipe.loginUrl} — ${count} facture(s) visible(s). ` +
      'Scraping réel non implémenté : installez Playwright et validez les sélecteurs.',
  };
}

/**
 * Combien de mois séparent la borne basse de la fenêtre d'aujourd'hui.
 *
 * Sert à la SIMULATION seule : le scraping réel, lui, filtre les lignes du
 * portail sur leur date (voir `dansLaFenetre`).
 */
function moisDeLaFenetre(plan) {
  if (!plan.from) return MOIS_SIMULES_SANS_BORNE;
  const to = plan.to;
  const ecart =
    (to.getFullYear() - plan.from.getUTCFullYear()) * 12
    + (to.getMonth() - plan.from.getUTCMonth());
  // Au moins le mois en cours : une fenêtre ouverte le 1er janvier ne doit pas
  // rendre une liste vide.
  return Math.max(1, ecart + 1);
}

function simulateFetch(recipe, config, ctx) {
  if (!rollOutcome(ctx, recipe.failureRate)) {
    throw new Error(
      `[SIMULATION] Échec de récupération sur ${recipe.providerName} — identifiants refusés`
    );
  }

  const known = new Set(ctx.knownRemoteIds || []);
  const plan = planHistorique(config, ctx);
  const months = recentMonths(plan ? moisDeLaFenetre(plan) : ctx.monthsBack || recipe.monthsBack);

  // La preuve d'accès à la liste (lot 31), déposée AVANT le filtre des
  // documents déjà connus : en régime établi, tout est connu, le tableau
  // ressort vide, et sans ce dépôt chaque passage tranquille deviendrait un
  // faux échec « liste non confirmée ». La simulation s'affiche comme telle.
  ctx.preuveDeListe?.({
    session: '[SIMULATION] connexion simulée',
    liste: '[SIMULATION] liste de factures simulée',
    elements: months.length,
  });

  return months
    .map((month) => {
      const amount = (Math.round((15 + Math.random() * 85) * 100) / 100).toFixed(2);
      return {
        remoteId: `${recipe.id}-${month}`,
        filename: `${recipe.id}_${month}.pdf`,
        issuedOn: `${month}-05`,
        amount: `${amount} EUR`,
        simulated: true,
        buffer: fakePdf([
          `${recipe.providerName} — facture ${month}`,
          '',
          `Reference : ${recipe.id}-${month}`,
          `Date d'emission : ${month}-05`,
          `Montant TTC : ${amount} EUR`,
          '',
          'DOCUMENT DE DEMONSTRATION',
          'Genere par crabe : le scraping reel n est pas implemente.',
          `Portail concerne : ${recipe.loginUrl}`,
        ]),
      };
    })
    .filter((inv) => !known.has(inv.remoteId));
}

// ---------------------------------------------------------------------------
// Chemin Playwright (si la dépendance est installée)
// ---------------------------------------------------------------------------

async function withBrowser(fn) {
  const { chromium } = require('playwright');
  // `optionsLancement()` porte le drapeau anti-automatisation (lot 35) : sans
  // lui, le navigateur s'annonce piloté (navigator.webdriver) et Ameli ignore
  // silencieusement l'envoi du formulaire — mesuré le 18/08/2026 : la même
  // saisie, le même clic, et le POST ne partait qu'avec le drapeau.
  const browser = await chromium.launch(identity.optionsLancement({ headless: true }));
  try {
    // Agent utilisateur réaliste, aligné sur le Chromium embarqué : sans lui,
    // Playwright annonce « HeadlessChrome » et certains pare-feux applicatifs
    // renvoient 403 sans rien expliquer (voir connectors/browser-identity.js).
    const context = await browser.newContext(
      identity.optionsContexte({ acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}

/**
 * Déroule la phase de connexion d'une recette.
 * @throws si le formulaire est refusé ou si la page attendue n'apparaît pas
 */
async function performLogin(page, recipe, config, log = () => {}) {
  const { selectors } = recipe;
  await page.goto(recipe.loginUrl, { waitUntil: 'domcontentloaded' });

  // Le sélecteur déclaré par la recette d'abord — il est écrit pour CE site,
  // donc plus sûr que n'importe quelle heuristique. Puis le module partagé,
  // qui couvre les sept régies répandues, cherche dans les cadres et vérifie
  // qu'il ne reste rien devant le formulaire.
  if (selectors.cookieAccept) {
    const banner = page.locator(selectors.cookieAccept);
    if (await banner.count()) await banner.first().click({ timeout: 5000 }).catch(() => {});
  }
  await cookieBanner.fermer(page, {
    cible: selectors.submit || 'form',
    log,
    prefixe: recipe.providerName,
  });

  // ─── Les clics d'entrée (lot 37) ──────────────────────────────────────────
  //
  // Certains sites n'affichent pas leur formulaire d'emblée : Ameli ouvre sur
  // un écran de consentement maison (#idWAaccepter) puis un « Connectez-vous »
  // (mesurés le 18/08/2026). La recette déclare ces étapes dans l'ordre ; une
  // étape absente de la page est simplement sautée — elle peut avoir déjà été
  // franchie (consentement mémorisé par le site).
  for (const etape of selectors.preambule || []) {
    const element = page.locator(etape).first();
    if (await element.count().catch(() => 0)) {
      await element.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1_500).catch(() => {});
    }
  }

  // ⚠ Plus jamais d'erreur brute (lot 37) : « page.fill: Timeout 45000ms
  // exceeded » masquait le vrai problème — le sélecteur ne mord plus. Chaque
  // étape qui échoue est dite en français ; le sélecteur, détail technique,
  // va au JOURNAL par `log`, jamais dans le message.
  await page.fill(selectors.username, config[recipe.usernameField]).catch(() => {
    log(`${recipe.providerName} : le champ d'identifiant (${selectors.username}) est introuvable`);
    throw new Error(
      `La page de connexion de ${recipe.providerName} n'a pas présenté le champ `
        + 'd\'identifiant attendu. La présentation du site a probablement changé : '
        + 'signalez-le, le connecteur doit être adapté.'
    );
  });

  // ─── L'étape « Suivant » (lot 37) ─────────────────────────────────────────
  //
  // EDF demande l'e-mail SEUL, puis un clic « Suivant », et alors seulement le
  // mot de passe (espace-client.edf.fr/sso/XUI, mesuré le 18/08/2026). C'est
  // précisément ce qui manquait aux échecs des 17-18/08 : le moteur cherchait
  // le champ du mot de passe sur un écran qui ne l'a jamais porté.
  if (selectors.usernameNext) {
    await page.click(selectors.usernameNext).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    const champVu = await page
      .waitForSelector(selectors.password, { timeout: NAV_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!champVu) {
      const visibles = await page.evaluate(() =>
        [...document.querySelectorAll('input')]
          .filter((i) => i.offsetWidth || i.offsetHeight)
          .map((i) => `${i.type}#${i.id || i.name || '?'}`)
          .slice(0, 10)
          .join(', ')).catch(() => 'illisible');
      log(`${recipe.providerName} : après l'étape « Suivant », le champ du mot de passe `
        + `(${selectors.password}) n'est pas apparu — champs visibles : ${visibles || 'aucun'}`);
      // Un obstacle MESURÉ prime sur la supposition générique : EDF, par
      // exemple, refuse ici toute connexion automatisée (verdict du
      // 18/08/2026) — dire « vérifiez votre adresse » enverrait l'utilisateur
      // vérifier un compte qui n'a rien fait de mal.
      throw new Error(
        recipe.obstacleEcranSuivant
          || `${recipe.providerName} n'a pas présenté l'écran du mot de passe après `
            + 'l\'identifiant. Vérifiez sur le site que votre adresse de connexion est bien '
            + 'reconnue ; si elle l\'est, signalez-le — la présentation du site a changé.'
      );
    }
  }

  await page.fill(selectors.password, config[recipe.passwordField]).catch(() => {
    log(`${recipe.providerName} : le champ du mot de passe (${selectors.password}) est introuvable`);
    throw new Error(
      `La page de connexion de ${recipe.providerName} n'a pas présenté le champ du mot `
        + 'de passe attendu. La présentation du site a probablement changé : signalez-le, '
        + 'le connecteur doit être adapté.'
    );
  });
  // Un clic qui suit la saisie de trop près part dans le vide : le site n'a
  // pas fini d'armer son formulaire (mesuré sur Ameli le 18/08/2026 — même
  // geste, même page : le POST ne partait qu'avec un temps de pose).
  await page.waitForTimeout(1_000).catch(() => {});
  try {
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click(selectors.submit),
    ]);
  } catch (err) {
    // Un clic intercepté n'est PAS un refus d'identifiants : le confondre a
    // envoyé chercher des mots de passe parfaitement corrects (voir le lot 13).
    if (!cookieBanner.estClicIntercepte(err)) throw err;
    throw new Error(
      `Une fenêtre du site (bandeau de cookies) empêche la connexion à ${recipe.providerName}. `
        + 'Signalez-le, ce service doit être adapté.'
    );
  }

  // ─── L'envoi est VÉRIFIÉ, jamais supposé (lot 37) ─────────────────────────
  //
  // Mesuré sur Ameli le 18/08/2026 : le clic sur le bouton-image « réussit »
  // au sens de l'automatisation, mais AUCUNE requête ne part — la page reste
  // sur le formulaire, et l'échec filait accuser la liste des documents plus
  // loin. Si le champ du mot de passe est toujours là après le clic, on
  // retente une fois par la touche Entrée, et on le journalise.
  await page.waitForTimeout(3_000).catch(() => {});
  const formulaireEncoreLa = async () => {
    try {
      return (await page.locator(selectors.password).count()) > 0;
    } catch {
      return false;
    }
  };
  if (await formulaireEncoreLa()) {
    log(`${recipe.providerName} : le clic d'envoi n'a rien déclenché — nouvel essai par la touche Entrée`);
    try {
      await page.focus(selectors.password);
      await page.keyboard.press('Enter');
    } catch {
      /* une page qui ne sait pas recevoir la frappe n'empêche pas la suite */
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3_000).catch(() => {});
  }

  // ─── Le second facteur, détecté et DIT (lot 37) ───────────────────────────
  //
  // Ameli accepte les identifiants puis présente un bouton de génération de
  // code à usage unique (#BoutonGenerationOTP, mesuré le 18/08/2026) : un
  // code que crabe ne peut pas recevoir. Sans cette détection, l'échec
  // arriverait plus loin avec un message qui accuse la liste des documents.
  if (selectors.otpMarker) {
    // Le bouton de génération du code se peint quelques secondes APRÈS la
    // réponse du site (mesuré le 18/08/2026 : un contrôle immédiat le rate,
    // et l'échec file accuser la liste des documents) : on l'attend.
    const otpVu = await page
      .waitForSelector(selectors.otpMarker, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (otpVu) {
      throw new Error(
        recipe.obstacleOtp
          || `${recipe.providerName} demande un code à usage unique après les identifiants — `
            + 'un code que crabe ne peut pas recevoir à votre place. La récupération '
            + 'automatique n\'est pas possible aujourd\'hui.'
      );
    }
  }

  if (selectors.loginError) {
    const error = page.locator(selectors.loginError);
    if (await error.count()) {
      const text = (await error.first().textContent())?.trim();
      throw new Error(`Connexion refusée par ${recipe.providerName}${text ? ` — ${text}` : ''}`);
    }
  }

  if (selectors.loginSuccess) {
    await page
      .waitForSelector(selectors.loginSuccess, { timeout: NAV_TIMEOUT_MS })
      .catch(() => {
        throw new Error(
          `Connexion à ${recipe.providerName} non confirmée (page attendue absente). ` +
            'Sélecteur obsolète ou 2FA demandée côté fournisseur.'
        );
      });
  }
}

async function runRecipeTest(recipe, config, ctx = {}) {
  return withBrowser(async (page) => {
    await performLogin(page, recipe, config, ctx.log);
    let count = 0;
    if (recipe.invoicesUrl && recipe.selectors.invoiceRow) {
      await page.goto(recipe.invoicesUrl, { waitUntil: 'domcontentloaded' });
      count = await page.locator(recipe.selectors.invoiceRow).count();
    }
    return {
      ok: true,
      invoiceCount: count,
      message: `Connexion réussie — ${count} facture(s) visible(s) sur ${recipe.providerName}`,
    };
  });
}

async function runRecipeFetch(recipe, config, ctx) {
  return withBrowser(async (page) => {
    await performLogin(page, recipe, config, ctx.log);
    await page.goto(recipe.invoicesUrl, { waitUntil: 'domcontentloaded' });

    const known = new Set(ctx.knownRemoteIds || []);
    const plan = planHistorique(config, ctx);
    if (plan) ctx.log?.(`${recipe.id}: historique « ${plan.mode} » — ${plan.raison}`);

    const rows = page.locator(recipe.selectors.invoiceRow);
    // ⚠ Jusqu'au lot 17, cette borne valait `Math.min(nombre de lignes, 12)` :
    // les douze PREMIÈRES lignes du tableau, ce qui n'a jamais rien eu à voir
    // avec des mois. Un portail affichant tout son historique sur une page
    // s'arrêtait donc à la douzième facture, sans que rien ne le dise. C'est le
    // réglage de l'utilisateur qui décide maintenant, et il décide par DATE.
    const total = plan ? await rows.count() : Math.min(await rows.count(), ctx.monthsBack || 12);

    // Preuve d'accès à la liste (lot 31), déposée seulement si quelque chose de
    // POSITIF a été constaté : le repère d'espace connecté de la recette
    // (attendu par `performLogin`), ou des lignes de facture bien présentes.
    // Une recette sans repère devant une page sans ligne n'a rien vu — déposer
    // une preuve là-dessus referait le faux « OK » que le lot 31 supprime.
    if (recipe.selectors.loginSuccess || total > 0) {
      ctx.preuveDeListe?.({
        session: recipe.selectors.loginSuccess
          ? `repère d'espace connecté « ${recipe.selectors.loginSuccess} » attendu et trouvé`
          : `${total} ligne(s) de facture affichée(s) dans l'espace client`,
        liste: `page des factures ${recipe.invoicesUrl}`,
        elements: total,
      });
    }

    const invoices = [];

    for (let i = 0; i < total; i++) {
      const row = rows.nth(i);
      const rawDate = recipe.selectors.invoiceDate
        ? (await row.locator(recipe.selectors.invoiceDate).first().textContent())?.trim()
        : null;
      const issuedOn = recipe.parseDate ? recipe.parseDate(rawDate) : normalizeFrenchDate(rawDate);
      const remoteId = `${recipe.id}-${issuedOn || i}`;
      if (known.has(remoteId)) continue;
      if (!dansLaFenetre(issuedOn, plan)) continue;

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: NAV_TIMEOUT_MS }),
        row.locator(recipe.selectors.invoiceLink).first().click(),
      ]);

      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);

      invoices.push({
        remoteId,
        filename: `${recipe.id}_${issuedOn || `doc${i}`}.pdf`,
        issuedOn: issuedOn || new Date().toISOString().slice(0, 10),
        buffer: Buffer.concat(chunks),
      });
    }

    return invoices;
  });
}

/** « 12 juillet 2026 » ou « 12/07/2026 » → « 2026-07-12 ». */
function normalizeFrenchDate(raw) {
  if (!raw) return null;
  const slash = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slash) {
    return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  }
  const months = {
    janvier: '01', février: '02', mars: '03', avril: '04', mai: '05', juin: '06',
    juillet: '07', août: '08', septembre: '09', octobre: '10', novembre: '11', décembre: '12',
  };
  const long = raw.toLowerCase().match(/(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})/);
  if (long && months[long[2]]) {
    return `${long[3]}-${months[long[2]]}-${long[1].padStart(2, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fabrique
// ---------------------------------------------------------------------------

/**
 * Construit un connecteur { test, fetchInvoices } à partir d'une recette.
 *
 * @param {object} recipe
 * @param {string} recipe.id
 * @param {string} recipe.providerName     nom affiché dans les messages
 * @param {string} recipe.loginUrl
 * @param {string} [recipe.invoicesUrl]
 * @param {object} [recipe.selectors]      sélecteurs CSS de la recette
 * @param {string} [recipe.usernameField]  clé de config portant l'identifiant
 * @param {string} [recipe.passwordField]  clé de config portant le secret
 * @param {string[]} [recipe.credentialKeys] champs exigés avant tout appel
 * @param {number} [recipe.monthsBack]     profondeur d'historique
 * @param {number} [recipe.failureRate]    taux d'échec simulé (0–1)
 */
function makeScrapingConnector(recipe) {
  const withDefaults = {
    usernameField: 'username',
    passwordField: 'password',
    providerName: recipe.id,
    monthsBack: 3,
    failureRate: SIMULATED_FAILURE_RATE,
    selectors: {},
    ...recipe,
  };

  const credentialKeys = withDefaults.credentialKeys || [
    withDefaults.usernameField,
    withDefaults.passwordField,
  ];

  function requireCredentials(config) {
    const missing = credentialKeys.filter((k) => !config?.[k]);
    if (missing.length) {
      throw new Error(
        `Identifiants manquants pour ${withDefaults.providerName} : ${missing.join(', ')}`
      );
    }
  }

  return {
    recipe: withDefaults,
    credentialKeys,
    /** true tant que le scraping réel n'a pas été validé pour ce connecteur. */
    get simulated() {
      return !isPlaywrightAvailable();
    },

    async test(config, ctx = {}) {
      requireCredentials(config);
      if (!isPlaywrightAvailable()) {
        ctx.log?.(`${withDefaults.id}: Playwright absent — test simulé`);
        return simulateTest(withDefaults, ctx);
      }
      return runRecipeTest(withDefaults, config, ctx);
    },

    async fetchInvoices(config, ctx = {}) {
      requireCredentials(config);
      if (!isPlaywrightAvailable()) {
        ctx.log?.(`${withDefaults.id}: Playwright absent — récupération simulée`);
        return simulateFetch(withDefaults, config, ctx);
      }
      return runRecipeFetch(withDefaults, config, ctx);
    },
  };
}

module.exports = {
  makeScrapingConnector,
  isPlaywrightAvailable,
  // exporté pour les tests unitaires (parcours de connexion, lot 37)
  performLogin,
  normalizeFrenchDate,
  fakePdf,
  recentMonths,
  rollOutcome,
  planHistorique,
  dansLaFenetre,
  phraseHorsPeriode,
  moisDeLaFenetre,
  CHAMP_HISTORIQUE,
  SIMULATED_FAILURE_RATE,
};
