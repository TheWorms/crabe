'use strict';

/**
 * Connecteur L'Atelier du Portable — pièces détachées et réparations.
 *
 * Connecteur À PART, et pas une boutique PrestaShop de plus : c'est un système
 * sur mesure posé sur WordPress, dont rien ne ressemble aux sept autres — ni
 * les URL, ni la structure de la page, ni le schéma de facture.
 *
 * **Validé le 11/08/2026** contre le compte réel : PDF de 125 Ko téléchargé et
 * ouvert.
 *
 * ─── La particularité : deux domaines, un seul compte ────────────────────────
 *
 * La connexion se fait sur **atelierduportable.com**, les commandes vivent sur
 * **piece-pc-portable.com**. Les cookies couvrent les deux : une seule session
 * suffit, et il n'y a pas de seconde connexion à faire.
 *
 *   connexion : https://www.atelierduportable.com/connexion/
 *   commandes : https://www.piece-pc-portable.com/vos-commandes-de-pieces-neuves/
 *
 * Session observée : **400 jours**.
 *
 * ─── La liste des commandes ──────────────────────────────────────────────────
 *
 * Trois sections : **non validées**, **en cours**, **terminées**. Chaque
 * commande se lit en clair :
 *
 *   Commande N° WEB070526334252 du 07/05/2026 (terminé)
 *
 * Seules celles qui ont une facture sont récupérées. En pratique ce sont les
 * terminées — mais on ne le PRÉSUME pas : on tente, et un document qui n'est
 * pas un PDF est simplement ignoré, avec sa raison au journal. Une commande
 * facturée par avance ne serait pas ratée pour autant.
 *
 * ─── La facture : construite, pas cherchée ───────────────────────────────────
 *
 * La liste ne porte PAS le lien de facture : il faut ouvrir la fiche de la
 * commande pour l'y trouver. Mais son adresse suit un schéma fixe, et le numéro
 * figure déjà dans la liste :
 *
 *   https://www.piece-pc-portable.com/inter_renvoi.php?dir=FACT&num_com=<numéro>
 *
 * Le connecteur la construit donc directement, sans ouvrir chaque fiche.
 * Vérifié : appel direct avec la session, HTTP 200, `application/pdf`, PDF
 * valide. Sur trente commandes, ça épargne trente chargements de page.
 *
 * ─── Ce qui n'est JAMAIS fait ────────────────────────────────────────────────
 *
 * **Aucune nouvelle tentative de connexion** quand la session expire. Le
 * connecteur s'arrête, passe en erreur, et prévient l'utilisateur — qui
 * recapture quand il veut.
 */

const identity = require('../../browser-identity');
const history = require('../../history');

// La connexion se fait sur le domaine des COMMANDES, pas sur celui de la
// vitrine : piece-pc-portable.com a sa propre page de connexion, et s'y
// connecter directement évite d'espérer que les cookies d'atelierduportable.com
// franchissent la frontière de domaine. Ils ne la franchissaient pas : le
// connecteur restait bloqué là, sans une ligne au journal (11/08/2026).
const URL_CONNEXION = 'https://www.piece-pc-portable.com/connexion/';
const URL_COMMANDES = 'https://www.piece-pc-portable.com/vos-commandes-de-pieces-neuves/';

/** Le schéma, invariable, de l'adresse d'une facture. */
const URL_FACTURE = 'https://www.piece-pc-portable.com/inter_renvoi.php?dir=FACT&num_com=';

const VIEWPORT = { width: 1500, height: 950 };
const NAV_TIMEOUT_MS = 45_000;
const PAUSE_DOCUMENT_MS = 350;

const CHAMP_IDENTIFIANT = 'email';
const CHAMP_MOT_DE_PASSE = 'motDePasse';
const CHAMP_HISTORIQUE = 'historique';

/**
 * Le formulaire de connexion, désigné par ce qu'il est le seul à contenir.
 *
 * JAMAIS par sa position dans la page : celle-ci porte aussi un formulaire de
 * recherche, et son bouton, écrit avant dans le DOM, serait cliqué à la place —
 * la page soumettrait alors une recherche vide au lieu de se connecter. C'est
 * exactement la panne qui a immobilisé cinq boutiques PrestaShop jusqu'au
 * 11/08/2026.
 */
const FORMULAIRE_CONNEXION = 'form:has(input[type="password"])';

/** Compte sans adresse lisible : un dossier, quand même. */
const COMPTE_PAR_DEFAUT = 'compte';

/**
 * Une commande dans la liste.
 *
 *   Commande N° WEB070526334252 du 07/05/2026 (terminé)
 *
 * Le « N° » peut s'écrire « N° », « No » ou « n° » selon les sections, et
 * l'état entre parenthèses est parfois absent. Seuls le numéro et la date sont
 * exigés — ce sont les deux seules choses dont on a besoin.
 */
const MOTIF_COMMANDE =
  /Commande\s+n[°o]?\s*[:.]?\s*(WEB\d+)\s*(?:du\s+(\d{1,2})\/(\d{1,2})\/(\d{4}))?\s*(?:\(([^)]*)\))?/gi;

/** Les états qui, en pratique, portent une facture. Vérifié plutôt que présumé. */
const ETATS_FACTURES = /termin/i;

// ---------------------------------------------------------------------------
// Fonctions pures — testables sans navigateur
// ---------------------------------------------------------------------------

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'Playwright n\'est pas installé : le connecteur L\'Atelier du Portable ne peut pas '
        + 'fonctionner. Installer avec « npm install playwright » puis '
        + '« PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright npx playwright install chromium ».'
    );
  }
}

/** Message unique de session expirée : il dit quoi faire, pas ce qui s'est passé. */
const MESSAGE_SESSION_EXPIREE =
  'Votre connexion à L\'Atelier du Portable a expiré. Rouvrez-la depuis la fiche du service, '
  + 'bouton « Se connecter à L\'Atelier du Portable ». crabe ne se reconnecte jamais tout seul : '
  + 'insister sur un formulaire de connexion peut rendre le site inaccessible même à la main.';

function erreurSessionExpiree(precision = '') {
  const err = new Error(MESSAGE_SESSION_EXPIREE + (precision ? ` (${precision})` : ''));
  err.sessionExpired = true;
  return err;
}

/**
 * L'adresse courante est-elle celle d'une page de connexion ?
 *
 * Seuls le CHEMIN et la requête sont examinés : le domaine
 * `atelierduportable.com` ne contient aucun de ces mots, mais un futur
 * sous-domaine « connexion.… » ne doit pas déclencher de faux positif.
 */
function estPageConnexion(url) {
  const texte = String(url || '');
  let cible;
  try {
    const analysee = new URL(texte);
    cible = `${analysee.pathname}${analysee.search}`;
  } catch {
    cible = texte;
  }
  return /connexion|login|authentification/i.test(cible);
}

/**
 * L'adresse de la facture d'une commande — construite, pas cherchée.
 *
 * La liste ne porte pas le lien : il faut ouvrir la fiche pour l'y trouver. Mais
 * le schéma est fixe et le numéro figure déjà dans la liste, donc trente
 * commandes coûtent zéro chargement de page au lieu de trente.
 */
function urlFacture(numero) {
  return `${URL_FACTURE}${encodeURIComponent(String(numero || ''))}`;
}

/**
 * Les commandes lues dans le texte de la page.
 *
 * Le texte plutôt que le DOM : les trois sections n'ont pas la même structure
 * HTML, mais toutes trois écrivent la même phrase, et cette phrase est ce qui
 * est réellement stable.
 *
 * @param {string} texte `document.body.innerText`
 * @returns {Array<{numero: string, issuedOn: string|null, etat: string}>}
 */
function commandesDepuisTexte(texte) {
  const propre = String(texte || '').replace(/\s+/g, ' ');
  const vues = new Set();
  const sortie = [];

  // `matchAll` sur une expression globale : elle porte son propre curseur, et
  // la réutiliser telle quelle d'un appel à l'autre sauterait une commande sur
  // deux (lastIndex conservé). D'où la copie.
  const motif = new RegExp(MOTIF_COMMANDE.source, 'gi');

  for (const trouve of propre.matchAll(motif)) {
    const numero = trouve[1].toUpperCase();
    if (vues.has(numero)) continue;
    vues.add(numero);

    sortie.push({
      numero,
      issuedOn: trouve[2]
        ? `${trouve[4]}-${trouve[3].padStart(2, '0')}-${trouve[2].padStart(2, '0')}`
        : null,
      etat: (trouve[5] || '').trim(),
    });
  }

  return sortie;
}

/**
 * Cette commande a-t-elle une facture ?
 *
 * « En pratique les terminées, mais vérifie plutôt que de présumer » : une
 * commande sans état lisible est TENTÉE quand même. Si la réponse n'est pas un
 * PDF, elle est ignorée avec sa raison — ce qui coûte une requête et ne rate
 * rien.
 */
function peutAvoirUneFacture(commande) {
  if (!commande?.etat) return true;
  return ETATS_FACTURES.test(commande.etat);
}

/** La référence stable d'une commande : son numéro `WEB…`. */
function remoteIdPour(numero) {
  return `commande-${String(numero || '').toUpperCase()}`;
}

/** Nom du fichier déposé : `AAAA-MM_<numéro de commande>.pdf`. */
function nomFichier(issuedOn, numero) {
  const mois = /^(\d{4})-(\d{2})/.exec(String(issuedOn || ''));
  const prefixe = mois ? `${mois[1]}-${mois[2]}` : 'inconnu';
  return `${prefixe}_${String(numero || 'commande').replace(/[^\w.-]/g, '_')}.pdf`;
}

/** L'adresse électronique du compte, qui nomme son dossier. */
function compteDepuisTexte(texte, config = {}) {
  const declare = String(config?.email || '').trim().toLowerCase();
  if (declare.includes('@')) return declare;

  const trouve = /\b([\w.+-]+@[\w-]+\.[\w.-]+)\b/.exec(String(texte || ''));
  return trouve ? trouve[1].toLowerCase() : COMPTE_PAR_DEFAUT;
}

/**
 * Message d'identifiants refusés : il dit quoi faire, pas ce qui s'est passé.
 *
 * Et il ne parle de mot de passe QUE parce que c'en est réellement un : le
 * connecteur a atteint le formulaire, l'a rempli, l'a soumis, et le site l'a
 * réaffiché. Accuser les identifiants sur une obstruction ou une session
 * perdue serait envoyer l'utilisateur corriger ce qui n'a rien à se reprocher.
 */
const MESSAGE_IDENTIFIANTS =
  'Identifiant ou mot de passe incorrect sur L\'Atelier du Portable. Corrigez-les sur la fiche '
  + 'du service, puis relancez. crabe ne réessaie jamais tout seul : insister sur un formulaire '
  + 'de connexion peut faire bloquer le compte.';

function erreurIdentifiants(precision = '') {
  const err = new Error(MESSAGE_IDENTIFIANTS + (precision ? ` (${precision})` : ''));
  err.credentialsRejected = true;
  return err;
}

/** Message d'identifiants absents de la fiche. */
function erreurIdentifiantsManquants() {
  return new Error(
    'Renseignez votre identifiant et votre mot de passe L\'Atelier du Portable sur la fiche '
      + 'du service.'
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Le premier élément qui existe, sélecteur par sélecteur, dans l'ordre.
 *
 * ⚠ Surtout pas `page.locator(union).first()` : Playwright y rend le premier
 * élément dans l'ordre du DOM, pas le premier sélecteur qui correspond. La
 * priorité écrite ne serait alors qu'un commentaire décoratif.
 *
 * Le `catch` couvre la page en cours de navigation ET un moteur CSS qui
 * refuserait `:has()` — on passe au repli plutôt que d'interrompre.
 */
async function premierPresent(page, selecteurs) {
  for (const selecteur of selecteurs) {
    try {
      const candidat = page.locator(selecteur).first();
      if (await candidat.count()) return candidat;
    } catch {
      /* sélecteur inutilisable ici */
    }
  }
  return null;
}

/**
 * Se connecte avec l'identifiant et le mot de passe enregistrés.
 *
 * ─── Pourquoi plus de navigateur distant ────────────────────────────────────
 *
 * Le formulaire ne demande qu'un identifiant et un mot de passe : ni captcha,
 * ni code, ni seconde étape (revérifié à la main le 11/08/2026). La fenêtre
 * imposait donc un geste manuel pour rien, et traînait ses propres pannes.
 *
 * ─── La preuve de connexion ─────────────────────────────────────────────────
 *
 * Ce n'est PAS un marqueur de compte dans l'en-tête : le site n'affiche pas de
 * lien de déconnexion sur toutes ses pages, et un lien « Mon compte » s'affiche
 * aussi bien déconnecté. C'est la page des COMMANDES réellement servie qui fait
 * foi — d'où `aller()`, qui lève si le site renvoie au formulaire.
 *
 * Une seule soumission, jamais deux : insister sur un formulaire de connexion
 * peut faire bloquer le compte.
 */
async function seConnecter(page, identifiant, motDePasse, log) {
  await page.goto(URL_CONNEXION, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  // Formulaire WordPress standard, relevé sur le site le 11/08/2026 :
  //     <input type="text"     name="log"  id="user_login">
  //     <input type="password" name="pwd"  id="user_pass">
  //     <input type="submit"   name="wp-submit" id="wp-submit" value="Se connecter">
  // Les identifiants propres au site viennent en tête ; les replis génériques
  // ne servent qu'au jour où le thème changerait.
  const champIdentifiant = await premierPresent(page, [
    '#user_login',
    'input[name="log"]',
    `${FORMULAIRE_CONNEXION} input[type="text"]`,
  ]);
  const champMotDePasse = await premierPresent(page, [
    '#user_pass',
    'input[name="pwd"]',
    'input[type="password"]',
  ]);

  if (!champMotDePasse || !champIdentifiant) {
    throw new Error(
      'Le formulaire de connexion de L\'Atelier du Portable est introuvable à l\'adresse '
        + `${URL_CONNEXION}. Le site a peut-être changé : signalez-le.`
    );
  }

  // `fill` et non `type` : aucun champ caché du formulaire n'est touché — les
  // jetons `redirect_to` et `testcookie` que la page y pose partent avec le
  // POST tels qu'elle les a écrits.
  await champIdentifiant.fill(identifiant);
  await champMotDePasse.fill(motDePasse);

  // ⚠ Soumission par la touche Entrée, et non par un clic.
  //
  // Le bouton est un `input[type="submit"]`, pas un `<button>` — et la page
  // porte un `<button type="button">` sans texte (l'œil qui montre le mot de
  // passe) écrit AVANT lui dans le DOM. Un sélecteur de bouton mal ajusté
  // expirait au bout de vingt secondes sans rien soumettre. Entrée depuis le
  // champ mot de passe soumet le formulaire qui le contient, sans avoir à
  // désigner quoi que ce soit.
  //
  // Ce n'est pas contradictoire avec la règle PrestaShop, où l'on CLIQUE : là
  // c'est le bouton qui porte le champ `submitLogin` décisif. Ici, aucun champ
  // n'est porté par le bouton.
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    champMotDePasse.press('Enter'),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Toujours sur le formulaire : le site a refusé, et il l'a fait sans
  // forcément écrire quoi que ce soit à l'écran.
  if (estPageConnexion(page.url())) {
    throw erreurIdentifiants(`URL finale ${page.url()}`);
  }

  log(`atelier-du-portable : connexion établie (URL finale ${page.url()}).`);
}

/** Ouvre un navigateur, se connecte, atteint les commandes, et passe la main. */
async function surLeCompte(config, fn, log = () => {}) {
  const identifiant = String(config?.[CHAMP_IDENTIFIANT] || '').trim();
  const motDePasse = String(config?.[CHAMP_MOT_DE_PASSE] || '');
  if (!identifiant || !motDePasse) throw erreurIdentifiantsManquants();

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  // Agent utilisateur réaliste : voir connectors/browser-identity.js.
  const context = await browser.newContext(
    identity.optionsContexte({
      viewport: VIEWPORT,
      acceptDownloads: true,
    })
  );
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    await seConnecter(page, identifiant, motDePasse, log);

    // Les cookies couvrent les deux domaines : une seule connexion suffit pour
    // passer sur piece-pc-portable.com. `aller()` lève si le site nous y
    // renvoie au formulaire, plutôt que de rapporter zéro facture en silence.
    const texte = await aller(page, URL_COMMANDES);
    log(`atelier-du-portable : page des commandes atteinte (${URL_COMMANDES}).`);
    return await fn(page, context, texte);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Va sur une page et vérifie qu'on n'a pas été renvoyé à la connexion. */
async function aller(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (estPageConnexion(page.url())) {
    throw erreurSessionExpiree('redirection vers la page de connexion');
  }

  return page.evaluate(() => document.body?.innerText?.slice(0, 40000) || '');
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la connexion tient-elle, et voit-on des commandes ? */
async function test(config, ctx = {}) {
  return surLeCompte(config, async (page, context, texte) => {
    const commandes = commandesDepuisTexte(texte);
    const facturables = commandes.filter(peutAvoirUneFacture);
    const compte = compteDepuisTexte(texte, config);

    ctx.log?.(
      `atelier-du-portable : ${commandes.length} commande(s) lue(s), `
        + `${facturables.length} susceptible(s) d'avoir une facture`
    );

    return {
      ok: true,
      accountId: compte,
      invoiceCount: facturables.length,
      message:
        'Connexion valide'
        + (compte !== COMPTE_PAR_DEFAUT ? ` — ${compte}` : '')
        + ` · ${commandes.length} commande(s), ${facturables.length} avec facture attendue.`,
    };
  }, ctx.log);
}

/** Récupère les factures des commandes qui en ont une. */
async function fetchInvoices(config, ctx = {}) {
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const log = ctx.log || (() => {});

  return surLeCompte(config, async (page, context, texte) => {
    const compte = compteDepuisTexte(texte, config);
    const commandes = commandesDepuisTexte(texte);

    // Preuve d'accès (lot 31). Ce site n'affiche pas de lien de déconnexion
    // (voir seConnecter) : la session est attestée soit par les commandes
    // elles-mêmes, soit par la connexion au formulaire qui vient d'aboutir —
    // ce connecteur se connecte à CHAQUE passage, et le site réaffiche le
    // formulaire quand il refuse (revérifié à la main le 11/08/2026).
    ctx.preuveDeListe?.({
      session: commandes.length
        ? `${commandes.length} commande(s) affichée(s) dans l'espace client`
        : 'connexion par le formulaire acceptée à l\'instant, page des commandes servie',
      liste: 'page des commandes de L\'Atelier du Portable',
      elements: commandes.length,
    });

    if (!commandes.length) {
      log(
        'atelier-du-portable : aucune commande lue sur la page. Soit le compte n\'en a pas '
          + 'encore, soit le libellé « Commande N° WEB… du JJ/MM/AAAA » a changé.'
      );
      return { accountId: compte, invoices: [] };
    }

    const disponibles = [
      ...new Set(
        commandes.map((c) => Number(String(c.issuedOn || '').slice(0, 4))).filter(Boolean)
      ),
    ].sort((a, b) => b - a);

    const plan = history.anneesAParcourir({
      valeur: config?.[CHAMP_HISTORIQUE],
      disponibles,
      dejaRecupere: ctx.dejaRecupere ?? connus.size > 0,
      // Le plafond de conservation, posé par le socle (lot 26). Vaut 0 tant
      // qu'un plancher protège l'existant : on ne se prive alors de rien.
      plafondMois: ctx?.conservationMois || 0,
    });

    log(
      `atelier-du-portable : ${commandes.length} commande(s) — historique « ${plan.mode} », `
        + plan.raison
    );

    const invoices = [];
    let sansFacture = 0;

    for (const commande of commandes) {
      const remoteId = remoteIdPour(commande.numero);
      if (connus.has(remoteId)) continue;
      if (!peutAvoirUneFacture(commande)) {
        sansFacture++;
        continue;
      }
      // Une commande sans date reste tentée : elle finira dans `inconnu/`.
      if (commande.issuedOn && plan.annees.length
          && !plan.annees.includes(Number(commande.issuedOn.slice(0, 4)))) {
        continue;
      }

      const url = urlFacture(commande.numero);
      const res = await context.request.get(url, { timeout: NAV_TIMEOUT_MS }).catch(() => null);

      if (!res || !res.ok()) {
        log(
          `atelier-du-portable : ${commande.numero} — HTTP `
            + `${res ? res.status() : 'sans réponse'}, ignorée pour cette fois`
        );
        continue;
      }

      const buffer = Buffer.from(await res.body());

      // Le CONTENU fait foi, pas l'en-tête. Une commande pas encore facturée
      // renvoie une page, pas un PDF : ce n'est pas une erreur, c'est un
      // « pas encore » — et c'est ce qui permet de tenter sans présumer.
      if (!identity.estPdf(buffer)) {
        sansFacture++;
        log(
          `atelier-du-portable : ${commande.numero} (${commande.etat || 'état inconnu'}) — `
            + `pas de facture disponible (${buffer.length} o, type annoncé `
            + `« ${res.headers()['content-type'] || 'inconnu'} »)`
        );
        continue;
      }

      connus.add(remoteId);
      invoices.push({
        accountId: compte,
        remoteId,
        filename: nomFichier(commande.issuedOn, commande.numero),
        issuedOn: commande.issuedOn || null,
        reference: commande.numero,
        buffer,
      });

      await page.waitForTimeout(PAUSE_DOCUMENT_MS);
    }

    // L'ÉCART entre les deux chiffres dit où la chaîne casse : « 8 commandes,
    // 0 document » désigne le téléchargement, « 0 commande » désigne la lecture
    // de la page. Sans les deux, un échec silencieux ne dit rien.
    log(
      `atelier-du-portable : ${invoices.length} document(s) téléchargé(s) sur `
        + `${commandes.length} commande(s) lue(s)`
        + (sansFacture ? `, ${sansFacture} sans facture disponible` : '')
        + '.'
    );

    return { accountId: compte, invoices };
  }, log);
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageConnexion,
  urlFacture,
  commandesDepuisTexte,
  peutAvoirUneFacture,
  remoteIdPour,
  nomFichier,
  compteDepuisTexte,
  erreurSessionExpiree,
  MESSAGE_SESSION_EXPIREE,
  erreurIdentifiants,
  MESSAGE_IDENTIFIANTS,
  premierPresent,
  FORMULAIRE_CONNEXION,
  URL_CONNEXION,
  URL_COMMANDES,
  URL_FACTURE,
  COMPTE_PAR_DEFAUT,
};
