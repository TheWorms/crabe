'use strict';

/**
 * Connecteur Anthropic (abonnement Claude) — session capturée, rejouée headless.
 *
 * ─── CHANGEMENT DE PRODUIT AU LOT 24 (13/08/2026) ────────────────────────────
 *
 * Ce connecteur visait `platform.claude.com` — la console développeur, dont la
 * facturation est celle d'un usage d'API. Il vise désormais `claude.ai` :
 * l'abonnement grand public (Claude Pro / Max). Ce ne sont pas deux adresses
 * d'un même service, ce sont **deux produits différents**, avec deux
 * facturations séparées.
 *
 * ⚠ CONSÉQUENCE À CONNAÎTRE : une connexion enregistrée avant ce lot ne vaut
 * plus rien ici. Elle porte des cookies de `platform.claude.com`, et la
 * facturation demandée est sur `claude.ai`. crabe demandera de la rouvrir — ce
 * n'est pas une panne.
 *
 * ─── Ce que la reconnaissance de claude.ai a montré (aucune saisie) ──────────
 *
 * 1. `claude.ai/login` répond **200**, titre « Sign in - Claude », servi en
 *    français, avec un champ `input[type=email][data-testid=email]` et trois
 *    voies : « Continuer avec Google », « Continuer avec l'e-mail »,
 *    « Continuer avec SSO ». Les mêmes que sur la console, à la présentation
 *    près.
 *
 *    ⚠ Ceci CONTREDIT le relevé du lot 19, qui notait « claude.ai/login répond
 *    403, titre "Just a moment...", interstitiel Cloudflare » et en concluait
 *    un arrêt. Ce n'est plus vrai. C'est aussi pourquoi cet arrêt tombe.
 *
 * 2. Les pages profondes, elles, SONT gardées par Cloudflare quand le client
 *    arrive froid : `/settings/billing` et `/new` répondent 403 avec
 *    `cf-mitigated: challenge` et « Vérification de sécurité en cours ».
 *
 * 3. **Mais la garde est transportable**, mesuré en deux passes comme HeRay
 *    chez Hetzner au lot 19 :
 *
 *      - fenêtre VISIBLE sur Xvfb (les options de `remote-browser.js`) : les
 *        quatre adresses répondent 200, aucune garde à l'écran, sans aucune
 *        intervention humaine ;
 *      - le même `storageState` rejoué HEADLESS : 200 partout aussi, aucune
 *        garde. 10 cookies, sur `claude.ai`, `.claude.ai` et `.hcaptcha.com`.
 *
 *    La capture en fenêtre visible emporte donc la levée de garde, et le
 *    planificateur — qui tourne headless — la rejoue sans la redéclencher.
 *
 * 4. `/settings/billing` EXISTE, et c'est une route témoin qui le prouve :
 *    hors session elle redirige vers `/login?from=logout`, tandis que
 *    `/nawak-inexistant-temoin` rend une vraie page « Page introuvable ». Les
 *    deux réponses diffèrent — c'est ce qui manquait chez Mistral, où tout se
 *    ressemblait.
 *
 * 5. `/login` monte **2** éléments hCaptcha (contre 0 sur la console). Ça ne
 *    gêne pas la voie retenue, l'utilisateur franchissant lui-même l'envoi du
 *    formulaire ; ça confirme qu'aucune connexion scriptée n'est envisageable.
 *
 * ─── Pourquoi une session, et pas un mot de passe ────────────────────────────
 *
 * ⚠ Le lot 20 répondait « parce qu'Anthropic n'a pas de mot de passe ». C'était
 * faux, et la page réelle l'a montré au lot 21 : elle propose TROIS voies —
 * « Continuer avec Google », « Continuer avec l'adresse e-mail » (code à usage
 * unique par courriel) et « Continuer avec SSO ». Le compte concerné passe par
 * Google.
 *
 * La bonne raison est donc celle-ci : la connexion appartient à un fournisseur
 * d'identité TIERS. Aucun couple identifiant/secret à stocker, et surtout rien
 * qu'un connecteur puisse saisir tout seul — un identifiant Google se saisit
 * chez Google, derrière des protections faites exprès pour empêcher ça. La
 * session capturée est le seul état réutilisable, et elle a l'avantage de
 * couvrir les trois voies sans avoir à les distinguer.
 *
 * ⚠ Conséquence directe, traitée par `remoteLogin.keepDomains` : le parcours
 * traverse `accounts.google.com`. La photo prise en fin de connexion emporterait
 * donc la session Google de l'utilisateur — de quoi ouvrir sa boîte de courriel
 * — alors que crabe ne va jamais chez Google. Ces cookies-là sont écartés avant
 * même d'être chiffrés (voir `session-state.limiterAuxDomaines`).
 *
 * ⚠ La page de connexion pose un conteneur `data-client-attestation`
 * ("hcaptcha-invisible"), en 0×0, sans widget monté ni requête de captcha à
 * l'affichage (relevé au lot 19). Elle ne gêne pas la voie retenue —
 * l'utilisateur franchit lui-même l'envoi du formulaire dans une fenêtre
 * visible — mais elle interdit d'espérer une connexion scriptée ici, et c'est
 * la première chose à relire si le rejeu se met un jour à échouer.
 *
 * ─── Ce qui n'est toujours pas vérifié ───────────────────────────────────────
 *
 * Le contenu de la page de facturation de `claude.ai` DERRIÈRE une session :
 * personne ne l'a vu, et c'est le seul point qui reste. Le relevé passe donc
 * par `connectors/documents-de-page.js`, qui ramasse les liens plutôt que de
 * suivre des sélecteurs inventés — et qui permet de DIRE qu'on n'a rien reconnu
 * au lieu d'annoncer « 0 facture » comme un fait.
 *
 * Ce qui EST vérifié désormais, et ne l'était pas : que la levée de garde d'un
 * navigateur visible survive au rejeu headless (point 3 ci-dessus). C'était
 * « le point qui décidera de tout » du lot 21 ; il est mesuré, et il passe.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');
const factureStripe = require('../../facture-stripe');

const ID = 'anthropic';
const NOM = 'Anthropic';

/**
 * La facturation de l'abonnement Claude.
 *
 * Deux écritures existent et mènent au même endroit : `/settings/billing`, la
 * page à part entière, et `/new#settings/billing`, qui ouvre le même panneau
 * par-dessus une conversation neuve. La première est celle qu'on ouvre — un
 * fragment (`#…`) ne part jamais au serveur, et une page qui doit d'abord
 * monter une application pour lire son propre `#` est une page qu'on lira trop
 * tôt une fois sur deux.
 */
const URL_FACTURATION = 'https://claude.ai/settings/billing';

/**
 * Les adresses essayées, dans l'ordre.
 *
 * La seconde est l'écriture que donne l'interface de Claude quand on arrive
 * par le menu ; elle sert de repli si la première venait à bouger, ce qui est
 * arrivé une fois déjà entre le lot 19 et celui-ci.
 */
const URLS_DOCUMENTS = [URL_FACTURATION, 'https://claude.ai/new#settings/billing'];

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;
/**
 * `claude.ai` est une application qui se peint après coup, et sa garde
 * Cloudflare se résout elle aussi en quelques secondes. Sans cette pause, on
 * lirait soit un écran de chargement, soit « Vérification de sécurité en
 * cours », et on conclurait « aucun document » sur une page qui n'était pas
 * encore là. Mesuré : la garde tombe bien en deçà de ce délai.
 */
const DELAI_RENDU_MS = 6_000;

const CHAMP_SESSION = 'session';

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      `Playwright n'est pas installé : le connecteur ${NOM} ne peut pas fonctionner. `
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à Claude a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Anthropic » — reprenez le même chemin que d\'habitude : Google, '
  + 'code reçu par courriel, ou connexion par votre organisation.';

/** Erreur reconnaissable par le socle : elle bascule le connecteur en erreur. */
function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * Seul le CHEMIN compte : `/settings/billing?returnTo=%2Flogin` serait une page
 * parfaitement authentifiée, et la déclarer expirée ferait redemander une
 * connexion à chaque exécution.
 */
function estPageAuthentification(url) {
  try {
    return /\/(login|signin|sign-in|magic-link|verify)(\/|$)/i.test(`${new URL(String(url)).pathname}/`);
  } catch {
    return false;
  }
}

function nomFichier(document) {
  return pageDocs.nomFichier(ID, document);
}

/** Distingue « aucune facture » de « aucune facture RECONNUE ». */
function messageReleveVide(pagesVisitees) {
  return (
    'Connexion à Claude valide, mais aucun document n\'a été reconnu sur '
    + `${pagesVisitees.join(', ')}. Deux explications possibles, et crabe ne sait pas trancher : `
    + 'soit votre abonnement Claude n\'a encore émis aucune facture, soit crabe ne reconnaît pas '
    + 'leur présentation. Si vous en voyez sur cette page, signalez-le — c\'est le second cas, '
    + 'et le connecteur doit être adapté.'
  );
}

/**
 * La garde Cloudflare est-elle à l'écran ?
 *
 * Elle se distingue d'une session expirée, et le dire compte : les identifiants
 * n'y sont pour rien, c'est le NAVIGATEUR que Cloudflare examine. La mesure du
 * lot 24 montre qu'elle tombe toute seule dans une fenêtre visible et que sa
 * levée voyage avec la session — donc si elle réapparaît ici, c'est que la
 * session est trop vieille ou a été capturée autrement, et le geste qui répare
 * est le même : rouvrir la connexion.
 */
async function estGardeCloudflare(page) {
  return page.evaluate(() => (
    /Un instant|Just a moment|V[ée]rification de s[ée]curit[ée]|Checking your browser/i
      .test(document.body.innerText || '')
    || !!document.querySelector('input[name="cf-turnstile-response"]')
  )).catch(() => false);
}

/** Le message d'un retour de la garde, qui dit ce qu'il faut essayer. */
const MESSAGE_GARDE =
  'Claude a présenté sa vérification de sécurité Cloudflare au lieu de votre page de '
  + 'facturation. Cette vérification juge le navigateur, pas votre compte : vos identifiants '
  + 'n\'y sont pour rien. Rouvrez la connexion depuis la fiche du service — la fenêtre visible '
  + 'de crabe sait la franchir — puis relancez la récupération.';

function erreurGarde(precision = '') {
  const err = new Error(MESSAGE_GARDE + (precision ? ` (${precision})` : ''));
  // Traitée comme une session à rouvrir : c'est bien le geste qui la corrige.
  err.sessionExpired = true;
  return err;
}

/** Contrôle du fichier de session avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la session enregistrée et passe la main.
 *
 * La session est contrôlée AVANT le lancement du navigateur : inutile de payer
 * un démarrage de Chromium pour se faire rediriger vers la page de connexion,
 * et une session vide ou périmée se voit sans sortir de la machine.
 */
async function surLaConsole(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  // `optionsLancement()` porte --disable-blink-features=AutomationControlled
  // (lot 35). Les échecs des 7 derniers jours disent « Claude a présenté sa
  // vérification de sécurité Cloudflare au lieu de votre page de facturation »
  // — la famille exacte de la panne Hetzner du lot 34 : la session est
  // capturée dans la fenêtre visible (qui porte le drapeau depuis le lot 21),
  // puis rejouée ICI dans un navigateur qui annonçait navigator.webdriver.
  // Cloudflare juge le navigateur : l'identité du rejeu doit être celle de la
  // capture. Mesuré par ailleurs (sonde du 15/08, deux passes sans session) :
  // le drapeau ne change rien à la page de connexion publique — il ne casse
  // donc rien — mais le rejeu de session, lui, n'est mesurable qu'avec une
  // session valide.
  const browser = await chromium.launch(identity.optionsLancement());
  try {
    const context = await browser.newContext(
      identity.optionsContexte({ storageState: session, viewport: VIEWPORT, acceptDownloads: true })
    );
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** @returns {Promise<{documents: object[], pagesVisitees: string[]}>} */
async function relever(page, log = () => {}) {
  const pagesVisitees = [];
  const documents = [];
  const vus = new Set();

  for (const url of URLS_DOCUMENTS) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    // L'application se peint après coup, et la garde Cloudflare se résout dans
    // le même temps : lire tout de suite reviendrait à lire un écran d'attente.
    await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});
    pagesVisitees.push(url);

    // La garde AVANT la session : les deux mènent à une page sans factures, et
    // seule la première a une cause qui n'est pas le compte de l'utilisateur.
    if (await estGardeCloudflare(page)) throw erreurGarde(`en ouvrant ${url}`);
    if (estPageAuthentification(page.url())) {
      throw erreurSessionExpiree(`redirection vers la connexion en ouvrant ${url}`);
    }

    const liens = await page.evaluate(pageDocs.releverLiens).catch(() => []);
    for (const doc of pageDocs.documentsDepuisLiens(liens, {
      prefixe: `${ID}-`,
      // L'entrée « Facturation » du menu de Claude ramène à la page qu'on lit :
      // sans ce garde-fou, crabe téléchargerait la page pour une facture, comme
      // il l'a fait chez Hetzner (voir documents-de-page.js).
      pageActuelle: page.url(),
    })) {
      if (vus.has(doc.remoteId)) continue;
      vus.add(doc.remoteId);
      documents.push(doc);
    }
    log(`${ID} : ${documents.length} document(s) reconnu(s) après ${url}`);
    if (documents.length) break;
  }

  return { documents, pagesVisitees };
}

async function telecharger(context, document) {
  // La console lie la PAGE Stripe de la facture ; le PDF est servi ailleurs
  // (pay.stripe.com). Télécharger le lien tel quel rendait 745 octets de HTML
  // — l'échec mesuré du 14/08. Voir documents-de-page.urlDeTelechargement.
  const reponse = await context.request.get(pageDocs.urlDeTelechargement(document.url), {
    timeout: DELAI_TELECHARGEMENT_MS,
  });
  // Un 401 ou un 403 sur un document n'est pas une panne de téléchargement :
  // c'est la session qui vient de tomber. Le dire autrement enverrait
  // l'utilisateur chercher un défaut qui n'existe pas.
  //
  // L'identifiant est TRONQUÉ dans tous ces messages : celui des factures
  // Stripe est un jeton d'accès, il n'a rien à faire entier dans un journal.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(
      `HTTP ${reponse.status()} sur le document ${pageDocs.idPourJournal(document.remoteId)}`
    );
  }
  if (!reponse.ok()) {
    throw new Error(
      `Téléchargement du document ${pageDocs.idPourJournal(document.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `Le document ${pageDocs.idPourJournal(document.remoteId)} n'est pas un PDF `
        + `(${buffer.length} octets reçus) : crabe a probablement pris un lien de la console `
        + `${NOM} pour une facture. Signalez-le.`
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLaConsole(config, ctx, async (page) => {
    const { documents, pagesVisitees } = await relever(page, ctx.log);
    return {
      ok: true,
      invoiceCount: documents.length,
      accountId: null,
      message: documents.length
        ? `Connexion valide — ${documents.length} document(s) trouvé(s) sur votre console ${NOM}`
        : messageReleveVide(pagesVisitees),
    };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLaConsole(config, ctx, async (page, context) => {
    const { documents, pagesVisitees } = await relever(page, log);
    if (!documents.length) {
      // Zéro document reconnu, aucun marqueur positif de session : conclure
      // « aucune nouvelle facture » serait le faux « OK » que le lot 31
      // interdit. On échoue en reprenant le message qui dit déjà les deux
      // explications possibles et le geste à faire.
      throw new Error(messageReleveVide(pagesVisitees));
    }

    // Preuve d'accès (lot 31) : des documents de facturation reconnus sur la
    // console n'existent que pour une session ouverte — c'est le marqueur ET
    // la liste. Déposée avant le tri des déjà-connus, pour qu'un passage sans
    // nouveauté reste un succès honnête.
    ctx.preuveDeListe?.({
      session: `${documents.length} document(s) de facturation affiché(s) sur la console`,
      liste: pagesVisitees.join(', '),
      elements: documents.length,
    });

    const invoices = [];
    for (const doc of documents) {
      if (connus.has(doc.remoteId)) continue;
      if (!scraping.dansLaFenetre(doc.issuedOn, plan)) continue;
      const buffer = await telecharger(context, doc);
      // Le PDF en main, on lui prend son numéro et sa date d'émission
      // (lot 32). La liste, elle, ne fournit pas le numéro — et la date qu'elle
      // affiche est parfois celle du PAIEMENT : mesuré le 14/08, « 13/08 » à
      // l'écran pour une facture émise le 9 mai. Le nom du fichier et le
      // classement suivent le document. `remoteId`, lui, ne bouge pas : c'est
      // l'empreinte calculée au listage qui dédoublonne (facture-stripe.js).
      const releve = factureStripe.estPageFactureStripe(doc.url)
        ? factureStripe.analyserPdf(buffer)
        : { numero: null, dateEmission: null };
      const issuedOn = releve.dateEmission || doc.issuedOn;
      invoices.push({
        remoteId: doc.remoteId,
        filename: nomFichier({ issuedOn, remoteId: releve.numero || doc.remoteId }),
        issuedOn,
        amount: doc.amount,
        buffer,
      });
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${documents.length} listée(s)`);
    return invoices;
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  telecharger,
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  nomFichier,
  lireSession,
  erreurGarde,
  estGardeCloudflare,
  MESSAGE_SESSION_EXPIREE,
  MESSAGE_GARDE,
  URL_FACTURATION,
  URLS_DOCUMENTS,
};
