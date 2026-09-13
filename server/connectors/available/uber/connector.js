'use strict';

/**
 * Connecteur Uber — le parcours des TRAJETS, mesuré sur la session réelle
 * (lot 73). Uber Eats et Location restent à l'étude : ce qu'ils valent sur ce
 * compte est journalisé, pas supposé.
 *
 * ─── Ce que la session RÉELLE a mesuré (09/09/2026, remesuré au lot 73-bis) ───
 *
 *   - TRAJETS : `riders.uber.com/trips` rend CHAQUE trajet comme une carte, et
 *     un seul trajet apparaît en lien direct `a[href*="/trips/"]` — c'est
 *     pourquoi le lot 73 n'avait compté qu'UN trajet, à tort. L'identifiant de
 *     chaque carte se lit sur son lien d'aide `?jobId=<uuid>` : ce `jobId` EST
 *     l'uuid du détail du trajet (vérifié : le lien direct `/trips/<uuid>` porte
 *     un jobId de la liste), et c'est sur lui que s'ancre le `remote_id` —
 *     jamais l'empreinte du PDF (leçon OUIGO du lot 46). La liste est PAGINÉE :
 *     un bouton « Plus » charge la page suivante en REMPLAÇANT le DOM (l'URL
 *     gagne un `cursor=`) — mesuré : 5, puis +10, +10, +2 = 27 trajets
 *     distincts, le bouton « Plus » disparu à la dernière page. On déroule donc
 *     TOUT en cumulant les jobId d'une page à l'autre. La vue par défaut est
 *     « Personnel » + « Toutes les courses » : c'est bien l'historique complet
 *     du profil personnel qui est lu (un profil professionnel, s'il existait,
 *     aurait son propre sélecteur — non couvert, non deviné). Le détail d'un
 *     trajet porte la DATE (lue par `documents-de-page.dateDepuisTexte`) et
 *     trois boutons de type reçu, dont « Télécharger » qui sert un vrai PDF
 *     (mesuré `%PDF-1.4`) ;
 *   - UBER EATS : `www.ubereats.com/fr/orders` renvoie le navigateur, session
 *     de trajets comprise, vers `auth.uber.com` — cette session NE COUVRE PAS
 *     Uber Eats (remesuré le 09/09/2026 : renvoi franc vers l'authentification).
 *     Les commandes Eats demandent leur propre connexion : rien n'est récupéré
 *     pour ce service ici, et le journal le dit ;
 *   - LOCATION : aucune liste de locations n'existe sur ce compte. La page
 *     Trajets porte un lien générique `m.uber.com/go/rent`, mais pas de liste
 *     de documents — rien à parcourir, et aucune adresse n'est inventée
 *     (règle 2 du lot 72).
 *
 * ─── L'authentification ──────────────────────────────────────────────────────
 *
 * Elle vit sur `auth.uber.com` (pas sur un chemin) avec reCAPTCHA et Arkose
 * montés : la connexion ne se soumet jamais en programme, fenêtre visible sur
 * profil persistant (recette des lots 30-31). C'est pourquoi `estPageAuthenti-
 * fication` reconnaît l'hôte, là où le motif de chemin générique ne le verrait
 * pas.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');

const ID = 'uber';
const NOM = 'Uber';
const CHAMP_SERVICES = 'services';

/** La liste des trajets, et le chemin d'un trajet et de sa liste. */
const TRAJETS_URL = 'https://riders.uber.com/trips';
const TRAJETS_CHEMIN = /riders\.uber\.com\/trips\/?(?:[?#]|$)/i;
/**
 * L'identifiant d'un trajet se lit sur le lien d'AIDE de sa carte
 * (`?jobId=<uuid>`) — la carte elle-même n'est pas une ancre `/trips/`, et un
 * seul trajet a un lien direct (piège du lot 73). Le `jobId` est l'uuid du
 * détail du trajet.
 */
const LIEN_AIDE = 'a[href*="help-with-a-trip"]';
/** Le bouton de pagination (mesuré : « Plus »). */
const MOTIF_PLUS = /^\s*plus\b|charger\s+plus|voir\s+plus|load\s+more|more$/i;
/** Le bouton qui télécharge le reçu (mesuré : « Télécharger »). */
const MOTIF_TELECHARGER = /télécharger|telecharger|download/i;
/** Garde-fou de pagination et délai de rendu d'une page suivante. */
const MAX_PAGES_TRAJETS = 40;
const DELAI_PAGINATION_MS = 2500;

const EATS_URL = 'https://www.ubereats.com/fr/orders';

/**
 * Les services proposés au choix. `url` : uniquement ce que la reconnaissance
 * ou la session réelle a mesuré — `location` n'a pas de liste.
 */
const SERVICES = [
  { id: 'trajets', label: 'Trajets (voiture)', url: TRAJETS_URL },
  { id: 'location', label: 'Location', url: null },
  { id: 'eats', label: 'Uber Eats', url: EATS_URL },
];

/**
 * L'authentification d'Uber vit sur SON hôte (`auth.uber.com`), pas sur un
 * chemin : le motif générique ne la verrait pas (`/v2/` ne dit rien). Les
 * pages-relais `/login-redirect` des autres hôtes comptent aussi — elles ne
 * sont qu'un rebond vers la connexion.
 */
function estPageAuthentification(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)auth\.uber\.com$/i.test(u.hostname)) return true;
    if (/\/login-redirect/i.test(u.pathname)) return true;
  } catch {
    return false;
  }
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni votre historique ni un espace connecté (${raison}) : `
      + 'impossible de dire s\'il y a des documents. Rouvrez la connexion depuis la fiche du '
      + 'service, puis relancez la récupération.'
  );
}

/** Les services retenus par la configuration — à défaut, tous. */
function servicesChoisis(config) {
  const retenus = Array.isArray(config?.[CHAMP_SERVICES]) ? config[CHAMP_SERVICES].map(String) : [];
  if (!retenus.length) return SERVICES;
  const choisis = SERVICES.filter((s) => retenus.includes(s.id));
  return choisis.length ? choisis : SERVICES;
}

/**
 * Découverte : les trois services, proposés tous cochés.
 *
 * Sans session, AUCUNE mesure ne dit lesquels sont actifs sur LE compte : les
 * trois sont cochés d'office, et c'est la première récupération qui dira
 * lesquels portent des documents. Aucun navigateur n'est ouvert ici.
 */
async function discover(config, ctx = {}) {
  const log = ctx.log || (() => {});
  log(`${ID} : 3 services proposés (trajets, location, Uber Eats), tous cochés d'office — `
    + 'la première récupération dira lesquels portent des documents sur votre compte.');
  return {
    items: SERVICES.map((service) => ({
      id: service.id,
      label: service.label,
      detail: service.id === 'trajets'
        ? 'les reçus de tous vos trajets sont récupérés (liste déroulée en entier, parcours mesuré le 09/09/2026)'
        : service.id === 'eats'
          ? 'Uber Eats demande sa propre connexion — à confirmer sur votre compte'
          : 'aucune liste de locations mesurée à ce jour : la première récupération le dira',
      preselected: true,
    })),
  };
}

/** Les jobId (identifiants de trajet) visibles sur la page COURANTE. */
async function jobIdsVisibles(page) {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)]
      .map((a) => { try { return new URL(a.href).searchParams.get('jobId') || ''; } catch { return ''; } })
      .filter(Boolean),
  LIEN_AIDE).catch(() => []);
}

/**
 * Clique le bouton « Plus » (pagination). Rend `false` quand il a disparu —
 * c'est le signal de fin, la liste ayant été entièrement déroulée.
 */
async function cliquerPlus(page) {
  return page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const el = [...document.querySelectorAll('button, [role="button"]')]
      .find((b) => re.test(String(b.innerText || '').trim()));
    if (!el) return false;
    try { el.scrollIntoView(); } catch { /* */ }
    el.click();
    return true;
  }, MOTIF_PLUS.source).catch(() => false);
}

/**
 * La liste ENTIÈRE des identifiants de trajets. La page pagine par un bouton
 * « Plus » qui REMPLACE le DOM (mesuré le 09/09/2026 : 5, +10, +10, +2 = 27) :
 * on cumule les jobId d'une page à l'autre, dédoublonnés, jusqu'à ce que le
 * bouton disparaisse. Un premier écran n'est jamais la liste (leçon des lots
 * précédents) : c'est le déroulé complet qui compte.
 */
async function lireTrajets(page) {
  const vus = new Set();
  (await jobIdsVisibles(page)).forEach((j) => vus.add(j));
  for (let n = 0; n < MAX_PAGES_TRAJETS; n++) {
    const encore = await cliquerPlus(page);
    if (!encore) break;
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(DELAI_PAGINATION_MS).catch(() => {});
    (await jobIdsVisibles(page)).forEach((j) => vus.add(j));
  }
  return [...vus];
}

/**
 * Clique le bouton « Télécharger » du détail d'un trajet — le geste part DANS
 * la page (comme chez Boulanger, lot 50 : un clic Playwright serait jugé sur
 * la géométrie d'un élément dont on ne sait rien), shadow DOM pris en compte.
 */
async function cliquerTelecharger(page) {
  return page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((b) => re.test(b.innerText || '') || re.test(b.getAttribute('aria-label') || ''));
    if (!el) return false;
    const interne = el.shadowRoot ? el.shadowRoot.querySelector('button, a') : null;
    (interne || el).click();
    return true;
  }, MOTIF_TELECHARGER.source).catch(() => false);
}

/** L'identifiant distant d'un trajet : son uuid lu sur l'URL (lot 46). */
function remoteIdTrajet(uuid) {
  return `${ID}-trajet-${String(uuid)}`;
}

/**
 * Récupère les reçus des trajets : énumère, puis visite chaque détail, lit la
 * date, télécharge le reçu. Idempotent — un trajet déjà déposé n'est ni
 * rouvert ni recliqué (le site regénérerait le PDF pour rien).
 */
async function recupererTrajets(page, context, log, connus, invoices) {
  const ids = await lireTrajets(page);
  log(`${ID} : ${ids.length} trajet(s) dans la liste des trajets.`);
  let deja = 0;
  let sansRecu = 0;
  for (let i = 0; i < ids.length; i++) {
    const uuid = ids[i];
    const remoteId = remoteIdTrajet(uuid);
    if (connus.has(remoteId)) {
      // L'ancre d'idempotence : trajet déjà déposé, on ne clique même pas.
      deja++;
      continue;
    }
    const urlDetail = `${TRAJETS_URL}/${uuid}`;
    await profilMarchand.atteindreLaPage(page, {
      id: ID, nom: NOM, log, urlDepart: urlDetail, estAuthentification: estPageAuthentification,
    });
    const texte = await page.evaluate(() => (document.body ? document.body.innerText || '' : '')).catch(() => '');
    const issuedOn = documentsDePage.dateDepuisTexte(texte);
    const obtenu = await clicDocument.documentDuClic(
      page, context, () => cliquerTelecharger(page)
    );
    if (obtenu.ok) {
      connus.add(remoteId);
      invoices.push({
        remoteId,
        filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
        issuedOn,
        buffer: obtenu.buffer,
      });
      log(`${ID} : trajet ${i + 1}/${ids.length} — reçu lu `
        + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
    } else {
      sansRecu++;
      log(`${ID} : trajet ${i + 1}/${ids.length} — aucun reçu téléchargeable (${obtenu.grief}). `
        + 'On continue avec les suivants.');
    }
  }
  if (deja) {
    log(`${ID} : ${deja} trajet(s) déjà déposé(s) — reconnu(s) à leur identifiant, rien n'a `
      + 'été retéléchargé.');
  }
  log(`${ID} : ${ids.length} course(s) vue(s), ${invoices.length} reçu(s) récupéré(s)`
    + `${sansRecu ? `, ${sansRecu} sans reçu téléchargeable` : ''}`
    + `${deja ? `, ${deja} déjà déposé(s)` : ''}.`);
}

/**
 * Atteint la page des trajets, la juge (la preuve de session), et passe la
 * main — l'ossature commune de `test` et `fetchInvoices`.
 */
async function surLesTrajets(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: TRAJETS_URL, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: TRAJETS_CHEMIN,
        estAuthentification: estPageAuthentification,
        // Mesuré : riders.uber.com/trips éconduit les anonymes vers
        // auth.uber.com — y rester sans « Se connecter » prouve.
        redirigeLesAnonymes: true,
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw erreurPageInconnue(etat.raison);
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la page des trajets est servie. */
async function test(config, ctx = {}) {
  return surLesTrajets(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — votre page de trajets Uber est servie à votre compte. `
      + 'Les reçus de trajets sont récupérés ; Uber Eats et Location sont à l\'étude.',
  }));
}

/**
 * Récupère les reçus des services choisis. Trajets est parcouru (et sert la
 * preuve de session) ; Uber Eats et Location journalisent leur état mesuré.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const choisis = servicesChoisis(config);
  const veutTrajets = choisis.some((s) => s.id === 'trajets');
  const veutEats = choisis.some((s) => s.id === 'eats');
  const veutLocation = choisis.some((s) => s.id === 'location');

  return surLesTrajets(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) — lue sur la page des trajets.
    ctx.preuveDeListe?.({
      session: `page des trajets servie au compte connecté (${etat.raison})`,
      liste: TRAJETS_URL,
      elements: etat.reperes,
    });

    const invoices = [];

    if (veutTrajets) {
      await recupererTrajets(page, context, log, connus, invoices);
    } else {
      log(`${ID} : Trajets non retenu dans vos choix — page servie, mais rien récupéré.`);
    }

    if (veutEats) {
      await page.goto(EATS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      const urlEats = (() => { try { return page.url(); } catch { return ''; } })();
      if (estPageAuthentification(urlEats)) {
        log(`${ID} : Uber Eats renvoie vers la connexion Uber — cette connexion (vos trajets) `
          + 'ne couvre pas Uber Eats (mesuré le 09/09/2026). Les commandes Uber Eats demandent '
          + 'leur propre connexion ; rien n\'a été récupéré pour ce service ici.');
      } else {
        log(`${ID} : Uber Eats — page servie, mais le parcours de ses commandes n'est pas `
          + 'encore écrit. Rien récupéré pour ce service.');
      }
    }

    if (veutLocation) {
      log(`${ID} : Location — aucune liste de locations n'a été relevée sur ce compte (un lien `
        + 'générique « louer » existe sur la page des trajets, mais pas de liste de documents). '
        + 'Rien n\'a été récupéré ; aucune adresse de liste n\'est inventée.');
    }

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  discover,
  // exportés pour les tests unitaires
  estPageAuthentification,
  servicesChoisis,
  remoteIdTrajet,
  lireTrajets,
  jobIdsVisibles,
  cliquerPlus,
  SERVICES,
  CHAMP_SERVICES,
  TRAJETS_URL,
  TRAJETS_CHEMIN,
  EATS_URL,
  LIEN_AIDE,
  MOTIF_PLUS,
  MOTIF_TELECHARGER,
};
