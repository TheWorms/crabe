'use strict';

/**
 * Connecteur Infomaniak — session capturée, puis la route JSON du manager.
 *
 * ─── Ce qui a changé au lot 24 (13/08/2026) ──────────────────────────────────
 *
 * Ce connecteur cherchait ses factures sur trois adresses inventées :
 * `/v3/ng/accounts/invoices`, `/accounts/billing`, `/accounts/orders`. Les
 * TROIS rendent « Page introuvable ». Il ne pouvait donc rien trouver, et
 * disait consciencieusement « aucune nouvelle facture » à chaque exécution.
 *
 * Le lot 21 avait posé le bon avertissement — chez Infomaniak, toute adresse du
 * manager redirige vers la connexion quand on n'est pas connecté, y compris une
 * route inventée, donc une redirection ne prouve l'existence d'aucune page —
 * mais il n'avait pas pu aller plus loin faute de session ouverte. Avec la
 * session, quatre passes ont suffi.
 *
 * ─── Où sont vraiment les factures ───────────────────────────────────────────
 *
 * Pas dans le namespace Angular `/v3/<compte>/ng/…`. C'est l'accueil du manager
 * lui-même qui l'a dit, avec son lien « 3 produits à payer » pointant sur
 * `/v3/<compte>/accounts/accounting/renewal` — sans `/ng/`. De là, l'onglet
 * « Factures » mène à :
 *
 *     https://manager.infomaniak.com/v3/invoicing/<compte>/bills
 *
 * qui affiche bel et bien les 77 lignes du compte réel. Mais cette page est
 * inexploitable au relevé de liens : elle est peinte en composants maison
 * (`<ik-table-row>`, `<ik-table-cell>`) et ne contient **aucun `<a href>` vers
 * un document**. Un bouton anonyme par ligne, et c'est tout.
 *
 * ─── La route retenue, et pourquoi ───────────────────────────────────────────
 *
 * En écoutant ce que la page appelle elle-même :
 *
 *     GET manager.infomaniak.com/proxy/2/invoicing/account/<compte>/invoices
 *
 * → HTTP 200, `application/json`, 67 factures d'un coup (`per_page=500` le
 * confirme : `page 1/1, total 67`). Chaque élément porte `id`, `type`,
 * `status`, `amount_incl_tax`, `currency`, `created_at`, et surtout :
 *
 *     pdf: "https://api.infomaniak.com/2/invoicing/invoice/pdf/<jeton>"
 *
 * une adresse **pré-signée** — téléchargée sans aucun cookie, elle rend 200,
 * `application/pdf`, `%PDF-1.7`. Exactement le même mécanisme que le `pdfUrl`
 * d'OVHcloud.
 *
 * C'est plus sûr qu'un relevé de page à tous les égards : rien à deviner, une
 * date exacte plutôt que devinée d'un texte de ligne, un montant exact, et une
 * présentation qui peut changer sans rien casser.
 *
 * ─── Verdict sur l'API officielle : NON, et voici pourquoi ───────────────────
 *
 * La question posée était : faut-il remplacer la session par un jeton d'API ?
 * Trois mesures répondent non.
 *
 * 1. **La documentation publique n'a pas de facturation.**
 *    `developer.infomaniak.com/docs/api`, ouvert dans un vrai navigateur (c'est
 *    une application JavaScript, illisible autrement), liste quatorze domaines
 *    produits — AI Tools, Core, Domain & Zone, Etickets, Mail Services,
 *    Newsletter, Public Cloud, Streaming, Swiss Backup, VOD, kChat, kDrive,
 *    kMeet, Url shortener. Aucun n'est la facturation. Sa recherche interne
 *    rend **0 résultat** pour « invoice », « facture » et « billing ».
 *
 * 2. **La route existe pourtant sur le host public**, et une route témoin le
 *    prouve : `api.infomaniak.com/2/invoicing/account/<compte>/invoices` rend
 *    **401** « Authorization required », là où
 *    `/2/invoicing/account/<compte>/nawak-inexistant-temoin` rend **404**
 *    « Method not found ». Elle accepterait donc un jeton.
 *
 * 3. **Et c'est précisément pour ça qu'on ne la prend pas.** Une route
 *    qu'aucune documentation ne décrit ne permet pas de dire à l'utilisateur
 *    quel droit cocher en créant son jeton — et une aide de champ qui ne peut
 *    pas nommer le droit exact est une aide qui ne sert à rien (c'est la leçon
 *    du champ de clé OVH au lot 16). S'y ajoute qu'Infomaniak fait dépendre
 *    l'accès aux factures du rôle du compte, ce qu'un jeton ne dit pas.
 *
 * Verdict : **API existante mais hors de portée en l'état**. On garde la
 * session — et on s'en sert pour appeler la MÊME route JSON que le manager,
 * par son proxy. On gagne la robustesse de l'API sans demander à personne de
 * créer un jeton dont on ne saurait pas décrire les droits.
 *
 * ─── Pourquoi une session capturée, et pas un mot de passe ───────────────────
 *
 * Rien ne garde la porte : `login.infomaniak.com/fr/login` est un formulaire
 * Angular ordinaire, 0 captcha monté, aucun Cloudflare, aucun DataDome. Mais la
 * console vit derrière un OAuth2 avec PKCE (`/authorize?…code_challenge=…`),
 * qu'un navigateur traverse seul et qu'un script devrait refaire à la main à
 * chaque changement du flux ; et la double authentification d'Infomaniak
 * (application mobile, SMS) est répandue sans qu'on puisse savoir de
 * l'extérieur si un compte l'a activée. La session couvre les deux cas.
 *
 * ⚠ Pas de `keepDomains` ici, contrairement à Mistral ou Anthropic : le
 * parcours ne traverse aucun fournisseur d'identité tiers, tout se passe chez
 * Infomaniak. Restreindre sans tiers à écarter risquerait de jeter un cookie
 * utile sans rien protéger en échange.
 */

const sessionState = require('../../session-state');
const identity = require('../../browser-identity');
const scraping = require('../../scraping');
const pageDocs = require('../../documents-de-page');

const ID = 'infomaniak';
const NOM = 'Infomaniak';

const MANAGER = 'https://manager.infomaniak.com';

/**
 * L'adresse qui révèle le numéro de compte.
 *
 * La racine du manager redirige vers `/v3/<compte>/ng/home` : c'est la seule
 * façon mesurée d'apprendre ce numéro, et il est indispensable — il entre dans
 * la route des factures ET nomme le dossier de destination.
 */
const URL_RACINE = `${MANAGER}/`;

/**
 * La route JSON des ORGANISATIONS du compte connecté.
 *
 * ─── Mesurée le 13/08/2026 sur le compte réel, et elle change tout ──────────
 *
 * Jusqu'au lot 24, ce connecteur lisait UN numéro de compte — celui vers lequel
 * la racine du manager redirige — et s'arrêtait là. Sur le compte de
 * production, cette route rend **trois organisations**, toutes les trois avec
 * de la facturation, et toutes les trois joignables :
 *
 *     854637   (celle de l'URL)   67 factures   2023-06 → 2026-06
 *     880049                      12 factures   2023-08 → 2026-05
 *     2036138                      3 factures   2026-06 → 2026-08
 *
 * Autrement dit, quinze factures existaient et n'étaient jamais récupérées,
 * sans qu'aucun message ne le laisse soupçonner : le connecteur annonçait
 * consciencieusement le compte qu'il connaissait.
 *
 * ⚠ C'est `/proxy/1/…` et non `/proxy/2/…`. Les deux répondent 200, mais la
 * version 2 rend un objet sans liste exploitable — un détail qui coûte une
 * demi-heure si on suppose que le numéro de version suit celui de la
 * facturation.
 */
const ROUTE_ORGANISATIONS = `${MANAGER}/proxy/1/accounts`;

/** La route JSON des factures, une fois le numéro de compte connu. */
const routeFactures = (compte) =>
  `${MANAGER}/proxy/2/invoicing/account/${encodeURIComponent(compte)}/invoices?per_page=500`;

/** La page que l'utilisateur, lui, ouvre pour voir ses factures. */
const pageFactures = (compte) => `${MANAGER}/v3/invoicing/${encodeURIComponent(compte)}/bills`;

const VIEWPORT = { width: 1600, height: 900 };
const NAV_TIMEOUT_MS = 45_000;
const DELAI_TELECHARGEMENT_MS = 60_000;
/**
 * Le manager est une application Angular : la page répond avant d'avoir quoi
 * que ce soit à montrer, et l'adresse elle-même n'est réécrite qu'une fois
 * l'application montée. Sans cette pause, on lirait la racine au lieu de
 * `/v3/<compte>/ng/home` et le numéro de compte resterait introuvable.
 */
const DELAI_RENDU_MS = 5_000;

const CHAMP_SESSION = 'session';
const CHAMP_ORGANISATIONS = 'organisations';

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
  'Votre connexion à Infomaniak a expiré. Rouvrez-la depuis la fiche du service, bouton '
  + '« Se connecter à Infomaniak » — double authentification comprise, comme sur le site.';

/** Erreur reconnaissable par le socle : elle bascule le connecteur en erreur. */
function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle une page d'authentification ?
 *
 * `login.infomaniak.com` tout entier compte : c'est là que mène la garde du
 * manager, que ce soit vers `/fr/login` ou vers `/authorize?…`. Le second n'a
 * aucun mot d'authentification dans son chemin — le chercher là ne suffirait
 * pas, et une session tombée passerait pour une liste de factures vide.
 */
function estPageAuthentification(url) {
  const texte = String(url || '');
  if (/(^|\/\/|\.)login\.infomaniak\.com/i.test(texte)) return true;
  try {
    return /\/(login|signin|authorize|oauth2?)(\/|$)/i.test(`${new URL(texte).pathname}/`);
  } catch {
    return false;
  }
}

/**
 * Le numéro de compte porté par une adresse du manager, ou `null`.
 *
 * Deux formes existent et se valent : `/v3/<compte>/ng/home` (les écrans
 * Angular) et `/v3/invoicing/<compte>/bills` (la facturation, servie à part).
 * On ne retient donc pas « le nombre après /v3/ » mais « le premier nombre du
 * chemin » — sinon la seconde forme rendrait `null`.
 */
function compteDepuisUrl(url) {
  const chemin = (() => {
    try {
      return new URL(String(url)).pathname;
    } catch {
      return String(url || '');
    }
  })();
  const trouve = /\/(\d{3,})(?:\/|$)/.exec(chemin);
  return trouve ? trouve[1] : null;
}

/**
 * Une facture de la réponse JSON, traduite dans le contrat de crabe.
 *
 * `created_at` est un horodatage Unix en SECONDES — le multiplier par 1000 est
 * la seule conversion de ce fichier, et l'oublier daterait toutes les factures
 * de janvier 1970, donc les ferait toutes tomber hors de la fenêtre
 * d'historique sans qu'aucun message ne le dise.
 *
 * Le montant est recopié tel que l'API le donne, jamais recalculé : crabe range
 * des documents, il ne fait pas de comptabilité.
 *
 * @param {object} brut un élément de `data`
 * @returns {{remoteId: string, url: string, issuedOn: string|null,
 *   amount: string|null}|null} `null` si l'élément n'est pas exploitable
 */
function factureDepuisJson(brut) {
  if (!brut || !brut.pdf || brut.id === undefined || brut.id === null) return null;
  const secondes = Number(brut.created_at);
  const issuedOn = Number.isFinite(secondes) && secondes > 0
    ? new Date(secondes * 1000).toISOString().slice(0, 10)
    : null;
  const montant = brut.amount_incl_tax;

  return {
    remoteId: String(brut.id),
    url: String(brut.pdf),
    issuedOn,
    amount: montant === undefined || montant === null
      ? null
      : `${montant} ${brut.currency || ''}`.trim(),
  };
}

/**
 * Une organisation, traduite en élément de l'écran de sélection.
 *
 * ⚠ Aucun badge n'est posé ici, et c'est la règle du lot 9 : le rang vient de
 * l'INDEX, décidé par le socle (`connectors/discovery.js`). Le premier élément
 * remonté est le principal, les suivants sont secondaires — sans exception,
 * sans analyse du libellé. Un `badge` remonté par un connecteur est ignoré.
 *
 * Reste à la charge de ce fichier ce qu'il est seul à savoir : le nom que
 * l'utilisateur reconnaîtra, et le nombre de factures — sans lequel l'écran de
 * sélection ne l'aide pas à choisir.
 *
 * @param {{id: string|number, name?: string}} organisation
 * @param {number|null} [nombreFactures] `null` = non compté
 * @param {number} [index] position dans la découverte
 */
function enElementDecouvert(organisation, nombreFactures = null, index = 0) {
  const id = String(organisation?.id ?? '');
  // ⚠ VIDE, et surtout pas une phrase (lot 26). `discovery.merge()` garde
  // l'ancien détail quand le nouveau est vide — c'est ainsi qu'un comptage fait
  // une fois survit aux récupérations suivantes, qui ne comptent pas. Avec
  // « nombre de factures non mesuré », le nouveau détail était une chaîne
  // non vide : la première synchronisation écrasait donc « 77 facture(s) » par
  // cette phrase, et l'écran de sélection cessait d'aider à choisir. Mesuré sur
  // le compte réel : les trois organisations affichaient « non mesuré » alors
  // qu'elles avaient été comptées une heure plus tôt.
  const detail = nombreFactures === null ? '' : `${nombreFactures} facture(s)`;
  return {
    id,
    label: String(organisation?.name || '').trim() || `Organisation ${id}`,
    detail,
    // ⚠ TOUTES cochées d'office, à la différence de Free Mobile qui ne coche
    // que la première. Ce n'est pas une hésitation : chez Free, les lignes
    // secondaires sont un choix qu'on peut vouloir refuser ; ici, chaque
    // organisation émet SES factures, et n'en cocher qu'une reviendrait à
    // reproduire exactement le défaut que ce lot corrige.
    preselected: true,
  };
}

/**
 * L'ordre de la découverte : l'organisation courante d'abord.
 *
 * Celle vers laquelle le manager redirige est la seule que crabe récupérait
 * avant ce lot : ses factures sont déjà rangées sous son numéro. La mettre en
 * tête lui laisse le rang « principale » qu'elle avait de fait, et évite qu'un
 * changement d'ordre côté Infomaniak ne renomme le dossier de référence.
 */
function ordonnerOrganisations(organisations, compteCourant) {
  const courant = String(compteCourant ?? '');
  const liste = [...(organisations || [])];
  const rang = liste.findIndex((o) => String(o?.id ?? '') === courant);
  if (rang > 0) liste.unshift(...liste.splice(rang, 1));
  return liste;
}

/**
 * `infomaniak_2026-06_1234567.pdf` — la période d'abord, pour un tri par nom.
 *
 * Délégué au module partagé depuis le lot 32 : la copie locale reproduisait la
 * même recette SANS la borne de longueur, et c'est le test transverse « aucun
 * connecteur ne laisse passer un jeton dans un nom » qui l'a montrée. Les
 * numéros Infomaniak font sept chiffres, la borne ne les concerne pas — elle
 * est là pour le jour où un identifiant opaque arriverait ici.
 */
function nomFichier({ issuedOn, remoteId }) {
  return require('../../documents-de-page').nomFichier(ID, { issuedOn, remoteId });
}

/** Contrôle du fichier de session avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

/**
 * Distingue « aucune facture » de « aucune facture RECONNUE ».
 *
 * Beaucoup moins probable qu'avant ce lot — la route rend une liste ou une
 * erreur, pas une page à interpréter — mais toujours possible si Infomaniak
 * change la forme de sa réponse. Dans ce cas, le dire vaut mieux qu'annoncer
 * « 0 facture » sur une réponse qu'on n'a pas comprise.
 */
function messageReleveVide(compte) {
  return (
    `Connexion à ${NOM} valide, mais aucune facture n'a été trouvée pour le compte ${compte}. `
    + `Si vous en voyez sur ${pageFactures(compte)}, signalez-le : Infomaniak a changé la forme `
    + 'de sa réponse, et le connecteur doit être adapté.'
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Ouvre un navigateur sur la session enregistrée et passe la main.
 *
 * La session est contrôlée AVANT le lancement du navigateur : inutile de payer
 * un démarrage de Chromium pour se faire rediriger vers la page de connexion.
 */
async function surLeManager(config, ctx, fn) {
  const session = lireSession(config);
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
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

/**
 * Le numéro de compte, lu sur l'adresse où le manager nous emmène.
 *
 * C'est la seule étape qui a besoin d'un navigateur : le reste passe par des
 * appels JSON. Elle sert aussi de contrôle de session — si le manager renvoie
 * vers `login.infomaniak.com`, inutile d'aller plus loin.
 */
async function numeroDeCompte(page) {
  await page.goto(URL_RACINE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(DELAI_RENDU_MS).catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('le manager a renvoyé vers la page de connexion');
  }

  const compte = compteDepuisUrl(page.url());
  if (!compte) {
    throw new Error(
      `Le manager ${NOM} n'a pas indiqué de numéro de compte — crabe ne sait pas où chercher `
      + 'vos factures. Signalez-le : Infomaniak a changé la forme de ses adresses.'
    );
  }
  return compte;
}

/**
 * Les organisations auxquelles ce compte donne accès.
 *
 * Un échec ici n'est PAS une panne : un compte à une seule organisation doit
 * continuer de fonctionner exactement comme avant ce lot, même si Infomaniak
 * change cette route. On retombe alors sur l'organisation lue dans l'URL, et
 * on le dit dans les journaux plutôt que d'interrompre la récupération.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function listerOrganisations(context, compteCourant, log = () => {}) {
  const repli = [{ id: String(compteCourant), name: '' }];
  try {
    const reponse = await context.request.get(ROUTE_ORGANISATIONS, { timeout: NAV_TIMEOUT_MS });
    if (reponse.status() === 401 || reponse.status() === 403) {
      throw erreurSessionExpiree(`HTTP ${reponse.status()} sur la liste des organisations`);
    }
    if (!reponse.ok()) {
      log(`${ID} : liste des organisations indisponible (HTTP ${reponse.status()}) — `
        + 'seule l\'organisation courante sera traitée');
      return repli;
    }
    const corps = await reponse.json();
    const brutes = Array.isArray(corps?.data) ? corps.data : [];
    const utilisables = brutes
      // Une organisation à laquelle le compte n'a pas accès, ou bloquée, ne
      // rendra jamais de facture : la proposer ferait une case à cocher qui ne
      // peut qu'échouer.
      .filter((o) => o && o.id !== undefined && !o.no_access && !o.is_blocked)
      .map((o) => ({ id: String(o.id), name: String(o.name || '').trim() }));

    if (!utilisables.length) {
      log(`${ID} : aucune organisation exploitable rendue — repli sur l'organisation courante`);
      return repli;
    }
    return ordonnerOrganisations(utilisables, compteCourant);
  } catch (err) {
    // Une session expirée doit remonter telle quelle : c'est une cause connue,
    // avec son message et son geste de réparation.
    if (err?.sessionExpired) throw err;
    log(`${ID} : liste des organisations illisible (${err.message}) — `
      + 'seule l\'organisation courante sera traitée');
    return repli;
  }
}

/**
 * La liste des factures du compte, telle que le manager se la sert à lui-même.
 *
 * @returns {Promise<Array<object>>} factures au contrat de crabe, sans les PDF
 */
async function listerFactures(context, compte) {
  const reponse = await context.request.get(routeFactures(compte), { timeout: NAV_TIMEOUT_MS });

  // Un 401/403 ici veut dire que la session ne vaut plus rien : le dire
  // autrement enverrait chercher un défaut de facturation qui n'existe pas.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(`HTTP ${reponse.status()} sur la liste des factures`);
  }
  if (!reponse.ok()) {
    throw new Error(`${NOM} a répondu ${reponse.status()} en listant vos factures.`);
  }

  let corps;
  try {
    corps = await reponse.json();
  } catch {
    throw new Error(
      `${NOM} a rendu une réponse illisible en listant vos factures. Signalez-le.`
    );
  }

  const brutes = Array.isArray(corps?.data) ? corps.data : [];
  return brutes.map(factureDepuisJson).filter(Boolean);
}

async function telecharger(context, facture) {
  // L'adresse est pré-signée : elle porte son propre droit d'accès et se
  // télécharge même sans cookie. On passe quand même par le contexte, pour
  // hériter de ses délais et de son identité de navigateur.
  const reponse = await context.request.get(facture.url, { timeout: DELAI_TELECHARGEMENT_MS });
  // Identifiant TRONQUÉ dans les messages (règle du projet, lot 31) : un
  // identifiant de document entier n'a rien à faire dans un journal.
  if (reponse.status() === 401 || reponse.status() === 403) {
    throw erreurSessionExpiree(
      `HTTP ${reponse.status()} sur la facture ${pageDocs.idPourJournal(facture.remoteId)}`
    );
  }
  if (!reponse.ok()) {
    throw new Error(
      `Téléchargement de la facture ${pageDocs.idPourJournal(facture.remoteId)} impossible `
        + `(HTTP ${reponse.status()}).`
    );
  }
  const buffer = Buffer.from(await reponse.body());
  if (!identity.estPdf(buffer)) {
    throw new Error(
      `La facture ${pageDocs.idPourJournal(facture.remoteId)} n'est pas arrivée sous forme de PDF `
        + `(${buffer.length} octets reçus). Signalez-le : ce service doit être adapté.`
    );
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

async function test(config, ctx = {}) {
  return surLeManager(config, ctx, async (page, context) => {
    const compte = await numeroDeCompte(page);
    const organisations = await listerOrganisations(context, compte, ctx.log);

    let total = 0;
    for (const org of organisations) {
      total += (await listerFactures(context, org.id)).length;
    }

    // Le message dit combien d'organisations ont été vues, et c'est ce qui
    // permet à l'utilisateur de reconnaître son cas d'un coup d'œil : une
    // seule, et rien ne change ; plusieurs, et l'écran de sélection s'affiche.
    const pluriel = organisations.length > 1
      ? `${organisations.length} organisations`
      : `compte ${compte}`;

    return {
      ok: true,
      invoiceCount: total,
      // Le numéro de compte nomme le dossier de destination : deux comptes
      // Infomaniak distincts ne se mélangent pas.
      accountId: compte,
      message: total
        ? `Connexion réussie — ${pluriel} · ${total} facture(s) trouvée(s)`
        : messageReleveVide(compte),
    };
  });
}

/**
 * Découverte : les organisations du compte, avec leur nombre de factures.
 *
 * Rapide, contrairement à celle de Free Mobile : une requête JSON par
 * organisation, aucune navigation, aucune bascule d'interface. C'est le
 * bénéfice de la route relevée au lot 24 — la même qui sert à récupérer.
 */
async function discover(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return surLeManager(config, ctx, async (page, context) => {
    const compte = await numeroDeCompte(page);
    const organisations = await listerOrganisations(context, compte, log);

    const items = [];
    for (const [index, org] of organisations.entries()) {
      let nombre = null;
      try {
        nombre = (await listerFactures(context, org.id)).length;
      } catch (err) {
        // Une organisation qu'on n'arrive pas à compter reste proposée : le
        // détail dira « non mesuré » plutôt que de la faire disparaître de la
        // liste, ce qui donnerait à croire qu'elle n'existe pas.
        log(`${ID} : organisation ${org.id} — comptage impossible (${err.message})`);
      }
      items.push(enElementDecouvert(org, nombre, index));
    }

    log(`${ID} : ${items.length} organisation(s) découverte(s)`);
    return { items };
  });
}

async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});
  const plan = scraping.planHistorique(config, ctx);
  if (plan) log(`${ID} : historique « ${plan.mode} » — ${plan.raison}`);

  return surLeManager(config, ctx, async (page, context) => {
    const compte = await numeroDeCompte(page);
    const organisations = await listerOrganisations(context, compte, log);

    // Rapprochement avec ce qui est enregistré : une organisation jamais vue
    // rejoint la sélection d'office, une organisation disparue est conservée
    // mais ignorée. Hors socle (test direct), on retombe sur la configuration
    // telle quelle, et à défaut sur TOUTES — jamais sur une seule, sinon on
    // reproduirait le défaut que ce lot corrige.
    const decouverts = organisations.map((o, index) => enElementDecouvert(o, null, index));
    const retenues = ctx.reconcile
      ? ctx.reconcile(CHAMP_ORGANISATIONS, decouverts).selection
      : Array.isArray(config?.[CHAMP_ORGANISATIONS]) && config[CHAMP_ORGANISATIONS].length
        ? config[CHAMP_ORGANISATIONS]
        : organisations.map((o) => o.id);

    const choisies = organisations.filter((o) => retenues.map(String).includes(String(o.id)));
    if (organisations.length > 1) {
      log(`${ID} : ${choisies.length} organisation(s) retenue(s) sur ${organisations.length}`);
    }

    const invoices = [];
    let listees = 0;

    for (const org of choisies) {
      const factures = await listerFactures(context, org.id);
      listees += factures.length;

      for (const facture of factures) {
        if (connus.has(facture.remoteId)) continue;
        if (!scraping.dansLaFenetre(facture.issuedOn, plan)) continue;
        invoices.push({
          remoteId: facture.remoteId,
          filename: nomFichier(facture),
          issuedOn: facture.issuedOn,
          amount: facture.amount,
          // ⚠ Le dossier de destination est celui de l'ORGANISATION, pas du
          // compte connecté. Sans cette ligne, les factures de trois
          // organisations atterriraient dans le même dossier, et rien à
          // l'arrivée ne dirait laquelle a émis quoi.
          accountId: org.id,
          buffer: await telecharger(context, facture),
        });
      }
    }

    // Preuve d'accès (lot 31) : le numéro de compte a été lu dans le manager
    // et chaque organisation retenue a rendu sa liste de factures — une liste
    // vide a tout de même été LUE, ce qui autorise le succès à zéro nouveauté.
    if (organisations.length > 0) {
      ctx.preuveDeListe?.({
        session: `compte ${compte} affiché dans le manager, `
          + `${organisations.length} organisation(s) listée(s)`,
        liste: 'factures des organisations (API du manager Infomaniak)',
        elements: listees,
      });
    }

    if (!listees) {
      log(messageReleveVide(compte));
      return { accountId: compte, invoices: [] };
    }

    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${listees} listée(s)`);
    // L'organisation courante reste l'identifiant de repli du connecteur : les
    // factures, elles, portent chacune la leur.
    return { accountId: compte, invoices };
  });
}

module.exports = {
  test,
  discover,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurSessionExpiree,
  messageReleveVide,
  compteDepuisUrl,
  factureDepuisJson,
  nomFichier,
  lireSession,
  routeFactures,
  pageFactures,
  listerOrganisations,
  enElementDecouvert,
  ordonnerOrganisations,
  ROUTE_ORGANISATIONS,
  MESSAGE_SESSION_EXPIREE,
  MANAGER,
  URL_RACINE,
};
