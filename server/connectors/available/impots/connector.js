'use strict';

/**
 * Connecteur Impots.gouv.fr — avis d'impôt, déclarations, accusés de réception.
 *
 * Parcours **validé contre le compte réel le 10/08/2026** : dix années
 * proposées (2017 à 2026), un PDF de 164 Ko téléchargé et vérifié. C'est le
 * portail le plus simple rencontré jusqu'ici — pas de menu flottant comme
 * Amazon, pas de rattachement acrobatique, pas de pagination.
 *
 * ─── Pourquoi une session ouverte à la main ──────────────────────────────────
 *
 * Le portail demande le numéro fiscal, le mot de passe, **puis un code de
 * sécurité**. Aucun connecteur ne peut donc ouvrir la session tout seul : crabe
 * rejoue celle que l'utilisateur a ouverte dans le navigateur distant. Session
 * observée : **13 cookies, valables 182 jours**, sans aucune case à cocher — le
 * portail prolonge de lui-même.
 *
 * **Pas de FranceConnect** : le parcours direct est plus simple et plus stable,
 * et il évite de faire dépendre la récupération d'un second fournisseur
 * d'identité.
 *
 * ─── Navigation par année : triviale ─────────────────────────────────────────
 *
 *   https://cfspart.impots.gouv.fr/enp/documents.do?n=<année>
 *
 * `n=0` donne l'année courante. Les liens « Année 2026 », « Année 2025 »… sont
 * dans la page avec leur `href` (`documents.do?n=2025`) : ils sont relevés
 * **dynamiquement**, aucune année n'est écrite en dur. Dix années observées.
 *
 * ─── Les documents ───────────────────────────────────────────────────────────
 *
 * Chaque document est une ligne `LI.row.align-items-center` contenant un
 * `button` dont l'attribut **`title` porte le libellé complet** :
 *
 *   « Visualiser PDF »  Avis d'impôt 2026 sur les revenus 2025
 *   « Visualiser PDF »  Déclaration smartphone des revenus 2025 (le 11/04/2026, à 22:22)
 *   « Visualiser PDF »  Accusé de réception de déclaration smartphone des revenus 2025
 *
 * Le TEXTE du bouton ne dit que « Visualiser PDF » — sans le `title`, les
 * quatre documents d'une année seraient indiscernables. Le préfixe
 * `« Visualiser PDF »` est retiré du libellé.
 *
 * **Tous les types sont récupérés** : avis d'impôt, déclarations, accusés de
 * réception, avis de situation déclarative.
 *
 * ─── Le piège des accordéons ─────────────────────────────────────────────────
 *
 * Certains documents sont repliés dans des sections « Afficher les documents
 * liés ». Sans dépliage, ils sont **silencieusement** ratés — le pire des
 * symptômes : pas d'erreur, pas de journal, juste des documents qui n'existent
 * pas. Toutes les sections repliables sont donc dépliées avant le relevé, et le
 * journal dit combien de documents apparaissent ensuite.
 *
 * ─── Obtenir le PDF ──────────────────────────────────────────────────────────
 *
 * L'identifiant n'est **pas** dans la page : il est produit au clic. Chaque
 * document demande donc une interaction, et le clic déclenche un
 * **TÉLÉCHARGEMENT** — établi par instrumentation le 11/08/2026 :
 *
 *   [TRACE rang 0] événements: DOWNLOAD→Avis_d_impot_2026_sur_les_revenus_2025.pdf | PAGE→
 *
 * Le portail ouvrait une fenêtre surgissante lors de l'écriture du connecteur
 * (10/08/2026), et servait encore l'adresse ci-dessous. Il a changé depuis. Un
 * onglet s'ouvre toujours, mais sur `about:blank` : c'est l'onglet vide que
 * Chrome ouvre puis referme pour porter un téléchargement. Le lire donnait
 * `about:blank`, donc `null`, donc « n'a ouvert aucun document » — sur tous les
 * documents de toutes les années, alors que le PDF arrivait bel et bien.
 *
 * Les deux voies sont donc écoutées, le téléchargement d'abord. Ancienne
 * adresse, conservée pour le repli :
 *
 *   https://cfspart.impots.gouv.fr/enp/Affichage_Document_PDF?idEnsua=<64 hex>
 *
 * On intercepte la page à son ouverture, on relève son URL, on la referme
 * aussitôt, puis on télécharge par le contexte authentifié. **Le nom du fichier
 * est fourni par le serveur** (`content-disposition`), et il contient déjà
 * `.pdf` : le doubler donnait les `….pdf.pdf` du script d'exploration.
 *
 * ─── Déduplication ───────────────────────────────────────────────────────────
 *
 * Le `remoteId` est le **libellé du document plus son année** — surtout pas
 * `idEnsua`, produit au clic et probablement instable. Même piège que les UUID
 * d'Amazon : une déduplication fondée dessus retéléchargerait tout, à chaque
 * exécution, indéfiniment.
 *
 * ─── Sortie ──────────────────────────────────────────────────────────────────
 *
 *   /Impots.gouv.fr/<numéro fiscal>/2026/2026_Avis_d_impot_sur_les_revenus_2025.pdf
 */

const fs = require('fs');
const sessionState = require('../../session-state');
const history = require('../../history');
const identity = require('../../browser-identity');

const URL_PORTAIL = 'https://cfspart.impots.gouv.fr/';
const URL_DOCUMENTS = 'https://cfspart.impots.gouv.fr/enp/documents.do';
const VIEWPORT = { width: 1600, height: 900 };
const LOCALE = 'fr-FR';

const NAV_TIMEOUT_MS = 45_000;

/** Attente de la fenêtre surgissante ouverte par le clic sur un document. */
const DELAI_POPUP_MS = 15_000;

/** Pause entre deux documents : le portail est public, on ne le bouscule pas. */
const PAUSE_DOCUMENT_MS = 400;

const CHAMP_SESSION = 'session';
const CHAMP_HISTORIQUE = 'historique';

/** Compte sans numéro fiscal lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/** Le préfixe que le portail colle devant chaque libellé de document. */
const PREFIXE_TITRE = /^\s*«?\s*Visualiser\s+(?:le\s+)?PDF\s*»?\s*[:–-]?\s*/i;

/** Une ligne de document dans la liste. */
const SELECTEUR_LIGNE = 'li.row.align-items-center';

/** Adresse d'un document affiché par la fenêtre surgissante. */
const MOTIF_PDF = 'Affichage_Document_PDF';

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur Impots.gouv.fr ne peut pas fonctionner. '
        + 'Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à impots.gouv.fr a expiré. Rouvrez-la depuis la fiche du service, '
  + 'bouton « Se connecter à Impots.gouv.fr ». Le portail redemandera votre numéro fiscal, '
  + 'votre mot de passe et un code de sécurité.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle celle d'une page d'authentification ?
 *
 * Trois marqueurs observés sur les redirections du portail : `connexion`,
 * `authorize` et `oauth`. Seuls le CHEMIN et la requête comptent — le domaine
 * `cfspart.impots.gouv.fr` contient le mot « impots », pas ceux-là.
 */
function estPageAuthentification(url) {
  const texte = String(url || '');
  let cible;
  try {
    const analysee = new URL(texte);
    cible = `${analysee.pathname}${analysee.search}`;
  } catch {
    cible = texte;
  }
  return /connexion|authorize|oauth/i.test(cible);
}

/** L'adresse d'une page de documents, pour une année donnée (`0` = courante). */
function urlAnnee(annee) {
  const valeur = Number.parseInt(annee, 10);
  return `${URL_DOCUMENTS}?n=${Number.isFinite(valeur) ? valeur : 0}`;
}

/**
 * Les années exposées par la page, relevées dans les `href` des liens.
 *
 * Les libellés sont « Année 2026 », « Année 2025 »… et leur `href` porte le
 * paramètre `n`. On croise les deux : un lien dont le libellé annonce 2025 et
 * dont le `href` dit `n=2025` est sans ambiguïté. Un lien `n=0` désigne l'année
 * courante, qu'on ne peut pas nommer sans l'horloge : il est retenu seulement
 * si son libellé porte une année.
 *
 * @param {Array<{href?: string, texte?: string}>} liens
 * @returns {number[]} décroissant, dédoublonné
 */
function anneesDepuisLiens(liens) {
  const vues = new Set();

  for (const lien of Array.isArray(liens) ? liens : []) {
    const href = String(lien?.href || '');
    const texte = String(lien?.texte || '').trim();

    const depuisTexte = /(?:^|\s)((?:19|20)\d\d)\s*$/.exec(texte);
    const depuisHref = /[?&]n=((?:19|20)\d\d)\b/.exec(href);

    const annee = depuisHref?.[1] || depuisTexte?.[1];
    // Un lien vers documents.do, ou au moins un libellé « Année AAAA » : sans
    // l'un des deux, ce n'est pas un sélecteur d'année.
    if (!annee) continue;
    if (!/documents\.do/i.test(href) && !/ann[ée]e/i.test(texte)) continue;

    vues.add(Number.parseInt(annee, 10));
  }

  return [...vues].sort((a, b) => b - a);
}

/**
 * Le libellé d'un document, débarrassé du préfixe du portail.
 *
 * « « Visualiser PDF »  Avis d'impôt 2026 sur les revenus 2025 »
 *   → « Avis d'impôt 2026 sur les revenus 2025 »
 */
function libelleDepuisTitre(titre) {
  return String(titre || '')
    .replace(/\s+/g, ' ')
    .replace(PREFIXE_TITRE, '')
    .trim();
}

/**
 * La référence stable d'un document : son libellé et son année.
 *
 * **Jamais `idEnsua`** — produit au clic, et probablement régénéré à chaque
 * ouverture comme les UUID d'Amazon. Le libellé, lui, décrit le document
 * (« Avis d'impôt 2026 sur les revenus 2025 ») et ne bouge pas.
 */
function remoteIdPour(libelle, annee) {
  return `${annee}#${libelle}`;
}

/**
 * Nom du fichier déposé : l'année, puis le nom d'origine du serveur.
 *
 * Le nom fourni par le portail **contient déjà `.pdf`** — le doubler donnait
 * les `Avis_d_impot….pdf.pdf` du script d'exploration. Un nom absent ou
 * inexploitable retombe sur le libellé du document.
 *
 * @param {number|string} annee
 * @param {string|null} nomServeur nom lu dans `content-disposition`
 * @param {string} libelle repli si le serveur n'en donne pas
 */
function nomFichier(annee, nomServeur, libelle) {
  const propre = String(nomServeur || '')
    .replace(/\s+/g, '_')
    .replace(/[^\w.@()+-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

  const base = propre || `${String(libelle || 'document').replace(/[^\w]+/g, '_')}.pdf`;
  // Une seule extension, jamais deux.
  const avecExtension = /\.pdf$/i.test(base) ? base : `${base}.pdf`;

  return `${annee}_${avecExtension}`;
}

/**
 * Le nom de fichier annoncé par le serveur, ou `null`.
 *
 * Deux en-têtes le portent, et le portail renseigne les deux :
 *   content-disposition: inline;filename=Avis_d_impot_2026_sur_les_revenus_2025.pdf
 *   content-type: application/pdf; name=Avis_d_impot_2026_sur_les_revenus_2025.pdf
 */
function nomDepuisEntetes(entetes = {}) {
  const lire = (cle) => {
    const trouve = Object.entries(entetes).find(([k]) => k.toLowerCase() === cle);
    return trouve ? String(trouve[1] || '') : '';
  };

  const disposition = lire('content-disposition');
  const parDisposition =
    /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
    || /filename="?([^";]+)"?/i.exec(disposition);
  if (parDisposition) return decodeURIComponent(parDisposition[1].trim());

  const parType = /name="?([^";]+)"?/i.exec(lire('content-type'));
  return parType ? parType[1].trim() : null;
}

/** Le numéro fiscal porté par un texte, ou « compte ». */
function compteDepuisTexte(texte, config = {}) {
  const declare = String(config?.numeroFiscal || '').replace(/\s+/g, '');
  if (/^\d{13}$/.test(declare)) return declare;

  const trouve = /\b(\d{13})\b/.exec(String(texte || '').replace(/\s+/g, ''));
  return trouve ? trouve[1] : COMPTE_PAR_DEFAUT;
}

/** Contrôle de la connexion enregistrée avant d'ouvrir quoi que ce soit. */
function lireSession(config) {
  const controle = sessionState.validate(config?.[CHAMP_SESSION]);
  if (!controle.ok) throw erreurSessionExpiree(controle.error);
  return controle.state;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Ouvre un navigateur sur la connexion enregistrée et passe la main. */
async function surLeCompte(config, fn) {
  const session = lireSession(config);

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : voir connectors/browser-identity.js.
  const context = await browser.newContext(
    identity.optionsContexte({
      storageState: session,
      viewport: VIEWPORT,
      locale: LOCALE,
      acceptDownloads: true,
    })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await aller(page, urlAnnee(0));
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Va sur une page et vérifie qu'on n'a pas été renvoyé à la connexion. */
async function aller(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageAuthentification(page.url())) {
    throw erreurSessionExpiree('redirection vers la page de connexion');
  }

  return page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
}

/** Les années proposées par la page, relevées dans les liens. */
async function anneesDisponibles(page, log = () => {}) {
  const liens = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => ({
      href: a.getAttribute('href') || '',
      texte: (a.textContent || '').replace(/\s+/g, ' ').trim(),
    }))
  );

  const annees = anneesDepuisLiens(liens);
  log(
    annees.length
      ? `impots : ${annees.length} année(s) proposée(s) — de ${annees[annees.length - 1]} `
        + `à ${annees[0]}`
      : 'impots : aucune année lisible dans la page des documents'
  );
  return annees;
}

/**
 * Déplie toutes les sections repliables de la page.
 *
 * Le piège signalé sur un compte réel : des documents vivent sous « Afficher les
 * documents liés », et sans dépliage ils sont ratés **en silence**. On clique
 * tout ce qui ressemble à un accordéon replié — bouton `aria-expanded="false"`,
 * lien `data-toggle="collapse"`, libellé « Afficher … » — puis on laisse la
 * page se peupler.
 *
 * @returns {Promise<number>} nombre de sections dépliées
 */
async function deplierTout(page) {
  const declencheurs = await page.$$(
    '[aria-expanded="false"], [data-toggle="collapse"], [data-bs-toggle="collapse"]'
  );

  let depliees = 0;
  for (const declencheur of declencheurs) {
    // Un accordéon déjà ouvert ne doit pas être refermé par notre propre clic.
    const ouvert = await declencheur.getAttribute('aria-expanded').catch(() => null);
    if (ouvert === 'true') continue;
    try {
      await declencheur.click({ timeout: 3000 });
      depliees++;
      await page.waitForTimeout(150);
    } catch {
      /* élément masqué ou remplacé : les autres sections restent à déplier */
    }
  }

  if (depliees) await page.waitForTimeout(400);
  return depliees;
}

/**
 * Les documents d'une année, une fois les accordéons dépliés.
 *
 * Le libellé vient de l'attribut `title` du bouton — le texte, lui, ne dit que
 * « Visualiser PDF ». Chaque bouton est MARQUÉ dans le DOM
 * (`data-crabe-document`) : c'est ce qui permet de recliquer un document précis
 * depuis Node sans réécrire la recherche en sélecteurs Playwright.
 */
async function documentsDeLaPage(page, selecteurLigne) {
  return page.evaluate((selecteur) => {
    const lignes = [...document.querySelectorAll(selecteur)];
    // Repli : certaines années rendent les documents hors de `li.row`. On
    // reprend alors tous les boutons porteurs d'un `title`, ce qui revient au
    // même ensemble sans dépendre de la classe de la ligne.
    const boutons = lignes.length
      ? lignes.flatMap((li) => [...li.querySelectorAll('button[title], a[title]')])
      : [...document.querySelectorAll('button[title], a[title]')];

    const sortie = [];
    let rang = 0;

    for (const bouton of boutons) {
      const titre = (bouton.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (!titre) continue;
      // Seuls les déclencheurs de PDF nous intéressent : le portail porte aussi
      // des boutons d'aide et de navigation, eux aussi pourvus d'un `title`.
      if (!/visualiser|pdf/i.test(titre)) continue;

      bouton.setAttribute('data-crabe-document', String(rang));
      sortie.push({ rang, titre });
      rang++;
    }

    return sortie;
  }, selecteurLigne);
}

/**
 * Clique un document et rapporte ce que le portail a servi.
 *
 * TROIS voies possibles, écoutées en parallèle — le premier arrivé gagne :
 *
 *   - TÉLÉCHARGEMENT (voie actuelle) : le fichier est déjà sur le disque, on
 *     le rend tel quel. Le relire par une requête risquerait de tomber sur un
 *     `idEnsua` à usage unique, produit au clic.
 *   - FENÊTRE SURGISSANTE (voie de l'époque) : on lit son URL et on la ferme.
 *     Une page sur `about:blank` ne compte pas — c'est l'onglet vide qui porte
 *     un téléchargement, pas un document.
 *   - MÊME ONGLET : l'URL courante devient celle d'un document.
 *
 * @returns {Promise<string|{fichier: object, nom: string}|null>} l'adresse du
 *   PDF, l'objet de téléchargement, ou null
 */
async function urlDuDocument(page, context, rang) {
  const bouton = page.locator(`[data-crabe-document="${rang}"]`).first();
  if (!(await bouton.count())) return null;

  // Les deux écoutes sont posées AVANT le clic : un téléchargement qui
  // arriverait pendant qu'on installe l'écouteur serait perdu.
  const attenteTelechargement = page
    .waitForEvent('download', { timeout: DELAI_POPUP_MS })
    .then((d) => ({ type: 'download', valeur: d }))
    .catch(() => null);
  const attentePage = context
    .waitForEvent('page', { timeout: DELAI_POPUP_MS })
    .then((p) => ({ type: 'page', valeur: p }))
    .catch(() => null);

  await bouton.click({ timeout: 5000 }).catch(() => {});

  const arrive = await Promise.race([
    attenteTelechargement,
    attentePage,
    // Troisième voie : le document rendu dans l'onglet courant. Sans elle, il
    // faudrait attendre les deux délais complets avant seulement d'y penser.
    (async () => {
      // `.catch` indispensable : quand une autre voie gagne, cette attente
      // continue de tourner, et la fermeture du navigateur en fin de
      // récupération la fait lever — « Target page, context or browser has been
      // closed », affiché tel quel à l'utilisateur (run_logs id 121). Une voie
      // qui échoue n'a rien à dire : les deux autres répondent.
      const encore = await page.waitForTimeout(2000).then(() => true).catch(() => false);
      if (!encore) return null;
      try {
        return page.url().includes(MOTIF_PDF) ? { type: 'onglet' } : null;
      } catch {
        return null;
      }
    })(),
  ]);

  if (arrive?.type === 'download') {
    return { fichier: arrive.valeur, nom: arrive.valeur.suggestedFilename?.() || '' };
  }

  if (arrive?.type === 'onglet') {
    const courante = page.url();
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return courante;
  }

  if (arrive?.type === 'page') {
    const surgissante = arrive.valeur;
    let url = null;
    try {
      await surgissante.waitForLoadState('domcontentloaded').catch(() => {});
      url = surgissante.url();
    } finally {
      await surgissante.close().catch(() => {});
    }
    // `about:blank` n'est pas un document : c'est l'onglet vide qui porte un
    // téléchargement. Si c'est lui, le téléchargement arrive peut-être encore.
    if (url && url !== 'about:blank') return url;

    const retard = await attenteTelechargement;
    if (retard?.type === 'download') {
      return { fichier: retard.valeur, nom: retard.valeur.suggestedFilename?.() || '' };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/**
 * Vérification légère : la connexion est-elle encore acceptée ?
 * Une seule page, aucun clic, aucun téléchargement.
 */
async function test(config, ctx = {}) {
  return surLeCompte(config, async (page) => {
    const texte = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
    const annees = await anneesDisponibles(page, ctx.log);
    const compte = compteDepuisTexte(texte, config);

    return {
      ok: true,
      accountId: compte,
      invoiceCount: undefined,
      message:
        'Connexion valide'
        + (compte !== COMPTE_PAR_DEFAUT ? ` — numéro fiscal ${compte}` : '')
        + (annees.length
          ? ` · ${annees.length} année(s) de documents, de ${annees[annees.length - 1]} `
            + `à ${annees[0]}`
          : ' · aucune année de documents lisible'),
    };
  });
}

/**
 * Récupère les documents des années retenues.
 *
 * **Reprise :** les documents déjà récupérés sont connus (`ctx.knownRemoteIds`)
 * et ne sont ni rouverts ni retéléchargés. Un rattrapage complet — dix années,
 * quatre à dix documents chacune — demande plusieurs minutes puisque chaque
 * document exige un clic ; une exécution interrompue reprend donc là où elle
 * en est.
 */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeCompte(config, async (page, context) => {
    const texteAccueil = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
    const compte = compteDepuisTexte(texteAccueil, config);
    const disponibles = await anneesDisponibles(page, log);

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles,
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant
      // qu'un plancher protège l'existant : dix ans d'avis d'imposition
      // continuent donc de remonter comme avant.
      plafondMois: ctx?.conservationMois || 0,
    });

    log(
      `impots : historique « ${plan.mode} » — ${plan.raison} ; `
        + `${plan.annees.length} année(s) à parcourir, ${connus.size} document(s) déjà récupérés`
    );

    // Preuve d'accès (lot 31) : le menu des années n'existe que dans l'espace
    // documents d'un compte connecté, et c'est LUI la liste de premier niveau
    // — un rattrapage déjà complet (zéro année à parcourir) reste un succès
    // honnête parce que ce menu a été lu.
    if (disponibles.length > 0) {
      ctx.preuveDeListe?.({
        session: `menu des années affiché dans l'espace documents (${disponibles.length} année(s))`,
        liste: 'espace « Mes documents » d\'impots.gouv.fr',
        elements: disponibles.length,
      });
    }

    const invoices = [];

    for (const annee of plan.annees) {
      await aller(page, urlAnnee(annee));

      // Les accordéons AVANT le relevé : sans cela, les documents liés
      // manquent en silence.
      const avant = (await documentsDeLaPage(page, SELECTEUR_LIGNE)).length;
      const depliees = await deplierTout(page);
      const documents = await documentsDeLaPage(page, SELECTEUR_LIGNE);

      log(
        `impots : ${annee} — ${documents.length} document(s) après dépliage de ${depliees} `
          + `section(s) (${avant} avant)`
      );

      for (const doc of documents) {
        const libelle = libelleDepuisTitre(doc.titre);
        if (!libelle) continue;

        const remoteId = remoteIdPour(libelle, annee);
        if (connus.has(remoteId)) continue;

        const ouvert = await urlDuDocument(page, context, doc.rang);
        if (!ouvert) {
          log(`impots : ${annee} — « ${libelle} » n'a ouvert aucun document, ignoré pour cette fois`);
          continue;
        }

        // Deux voies, un seul contrôle ensuite. Le TÉLÉCHARGEMENT rend un
        // fichier déjà obtenu : le relire par une requête risquerait de tomber
        // sur un `idEnsua` à usage unique, produit au clic.
        let buffer = null;
        let nomServeur = '';

        if (typeof ouvert === 'object' && ouvert.fichier) {
          const chemin = await ouvert.fichier.path().catch(() => null);
          buffer = chemin ? await fs.promises.readFile(chemin).catch(() => null) : null;
          if (!buffer) {
            log(
              `impots : « ${libelle} » — le fichier téléchargé n'a pas pu être lu, ignoré pour `
                + 'cette fois ; il sera repris à la prochaine exécution'
            );
            continue;
          }
          nomServeur = ouvert.nom;
        } else {
          const res = await context.request.get(ouvert, { timeout: NAV_TIMEOUT_MS }).catch(() => null);
          if (!res || !res.ok()) {
            log(
              `impots : « ${libelle} » — HTTP ${res ? res.status() : 'sans réponse'}, ignoré pour `
                + 'cette fois ; il sera repris à la prochaine exécution'
            );
            continue;
          }
          buffer = Buffer.from(await res.body());
          nomServeur = nomDepuisEntetes(res.headers());
        }
        if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
          // Un HTML à la place d'un PDF, c'est la page de connexion : la
          // session vient de tomber. Inutile de continuer les autres années.
          throw erreurSessionExpiree(`réponse non-PDF pour « ${libelle} » (${buffer.length} o)`);
        }

        connus.add(remoteId);
        invoices.push({
          accountId: compte,
          remoteId,
          filename: nomFichier(annee, nomServeur, libelle),
          // Le portail ne date pas ses documents autrement que par leur année :
          // on ne s'invente pas un jour et un mois. L'année suffit au rangement.
          issuedOn: `${annee}-01-01`,
          buffer,
        });

        await page.waitForTimeout(PAUSE_DOCUMENT_MS);
      }
    }

    log(
      `impots : ${plan.annees.length} année(s) parcourue(s), `
        + `${invoices.length} document(s) récupéré(s)`
    );

    return { accountId: compte, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  urlAnnee,
  anneesDepuisLiens,
  libelleDepuisTitre,
  remoteIdPour,
  nomFichier,
  nomDepuisEntetes,
  compteDepuisTexte,
  erreurSessionExpiree,
  MESSAGE_SESSION_EXPIREE,
  URL_PORTAIL,
  URL_DOCUMENTS,
  SELECTEUR_LIGNE,
  COMPTE_PAR_DEFAUT,
  DELAI_POPUP_MS,
};
