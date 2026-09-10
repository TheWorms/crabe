'use strict';

/**
 * Connecteur Ameli — deux services au choix, sur session ouverte par la
 * fenêtre (lot 78).
 *
 * ─── Pourquoi la connexion passe par la FENÊTRE, plus par les identifiants ───
 *
 * Le verdict du 18/08/2026, re-confirmé le 09/09/2026 (essai réel, 15:48 UTC) :
 * Ameli accepte les identifiants puis exige un code à usage unique
 * (`#BoutonGenerationOTP`) que crabe ne peut pas recevoir à la place de
 * l'utilisateur. La connexion se fait donc dans la fenêtre visible de crabe
 * (profil de navigateur persistant, recette des lots 30-31 et des enseignes du
 * lot 47) : l'utilisateur saisit son numéro de sécurité sociale, son code
 * personnel ET le code à usage unique lui-même ; la session vit ensuite dans
 * le profil, et c'est elle que ce connecteur rouvre.
 *
 * ─── Ce que la MESURE du 09/09/2026 a établi (sonde anonyme, le serveur de production) ─────────
 *
 * Les deux adresses relevées par l'utilisateur (captures du 09/09) :
 *
 *   - `assure.ameli.fr/compte/aspm/releves-mensuels` — une carte par mois (les
 *     12 derniers), la plupart marquées « Aucun paiement », et un bouton
 *     « Afficher plus de relevés » en bas ;
 *   - `assure.ameli.fr/compte/asdo/attestation-droits` — un sélecteur de
 *     bénéficiaire et un bouton « Télécharger l'attestation de droits ».
 *
 * Sonde anonyme (profil jetable, Chromium du socle) : les DEUX adresses
 * redirigent un visiteur sans session vers `ameliconnect.ameli.fr/oauth2/
 * authorize` — l'écran d'authentification (NIR + code, « Me connecter »).
 * Le témoin inventé (`/compte/nawak-…`) rend un « Request Rejected » du pare-feu,
 * PAS ce renvoi : le renvoi est bien la garde de session. Aucune garde
 * anti-robot vue. D'où `redirigeLesAnonymes: true` : rester sur l'adresse,
 * sans bouton « Se connecter », prouve la session (raisonnement du lot 40).
 *
 * ⚠ AUCUNE session enregistrée au moment où ce parcours a été écrit : la forme
 * des cartes de mois, du bouton de pagination et du bouton d'attestation vient
 * des captures d'écran relevées par l'utilisateur, PAS d'une lecture connectée. Tout ce
 * qui est « dans la page » est à CONFIRMER SUR SESSION ; les motifs sont des
 * libellés relevés, le journal dit ce qui ne se retrouve pas.
 *
 * ─── L'ancre de l'attestation de droits (décision écrite, lot 78) ────────────
 *
 * L'attestation est REGÉNÉRÉE à chaque téléchargement : sa date d'édition est
 * celle du jour, son empreinte change à chaque fois (le piège OUIGO du lot 46,
 * en pire). L'ancre ne peut donc venir NI du fichier NI de son contenu — et la
 * page, jamais vue connectée, n'a pas encore livré d'identifiant stable.
 *
 * L'ancre retenue est le MOIS CIVIL de récupération (UTC) :
 * `ameli-attestation-AAAA-MM`. Justification :
 *   - au plus UN document par mois — personne ne veut une attestation par
 *     exécution, et deux passages dans le même mois ne produisent qu'une ligne
 *     (le second ne navigue même pas vers la page : zéro clic, zéro
 *     génération côté serveur pour rien) ;
 *   - le mois plutôt que l'année : une attestation sert à prouver des droits
 *     COURANTS, et un document annuel serait périmé dès qu'une situation
 *     change ; une par mois suffit et reste fraîche ;
 *   - si la première session révèle un repère stable meilleur (période de
 *     validité, date de mise à jour des droits), l'ancre pourra être re-jugée
 *     — c'est écrit dans la note technique du manifeste.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');
const history = require('../../history');

const ID = 'ameli';
const NOM = 'Ameli';
const CHAMP_SERVICES = 'services';
const CHAMP_HISTORIQUE = 'historique';

/** Les deux adresses relevées par l'utilisateur (captures du 09/09/2026). */
const RELEVES_URL = 'https://assure.ameli.fr/compte/aspm/releves-mensuels';
const ATTESTATION_URL = 'https://assure.ameli.fr/compte/asdo/attestation-droits';
const CHEMIN_RELEVES = /assure\.ameli\.fr\/compte\/aspm\/releves-mensuels(?:[/?#]|$)/i;
const CHEMIN_ATTESTATION = /assure\.ameli\.fr\/compte\/asdo\/attestation-droits(?:[/?#]|$)/i;

/**
 * Les libellés relevés sur les captures du 09/09/2026 — à confirmer sur
 * session. Des FORMES, jamais des valeurs (§0ter).
 */
const MOTIF_PLUS = /afficher\s+plus\s+de\s+relev/i;
const MOTIF_AUCUN_PAIEMENT = /aucun\s+paiement/i;
const MOTIF_TELECHARGER_ATTESTATION = /t[ée]l[ée]charger\s+l['’]attestation/i;
/** Le déclencheur d'un relevé dans sa carte : téléchargement ou PDF. */
const MOTIF_TELECHARGER_RELEVE = /t[ée]l[ée]charg|\bpdf\b/i;

/**
 * Un libellé de mois : « août 2026 », « Février 2025 »… La carte d'un relevé
 * mensuel porte son mois en toutes lettres (capture du 09/09/2026).
 */
const MOTIF_MOIS =
  /\b(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\s+(\d{4})\b/i;

const MOIS_FRANCAIS = new Map([
  ['janvier', '01'], ['fevrier', '02'], ['mars', '03'], ['avril', '04'],
  ['mai', '05'], ['juin', '06'], ['juillet', '07'], ['aout', '08'],
  ['septembre', '09'], ['octobre', '10'], ['novembre', '11'], ['decembre', '12'],
]);

/** Garde-fou de pagination et délai de rendu (mêmes ordres que Uber, lot 73). */
const MAX_PAGES_RELEVES = 40;
const DELAI_PAGINATION_MS = 2500;

/**
 * Les services proposés au choix — le modèle Uber (lot 72) : la découverte ne
 * dit rien du compte tant qu'aucune session n'est ouverte, les deux sont
 * cochés d'office.
 */
const SERVICES = [
  { id: 'releves-mensuels', label: 'Relevés mensuels', url: RELEVES_URL },
  { id: 'attestation-droits', label: 'Attestation de droits', url: ATTESTATION_URL },
];

/**
 * L'authentification d'Ameli vit sur SON hôte (`ameliconnect.ameli.fr`) et sur
 * le chemin `/oauth2/authorize` (mesurés le 09/09/2026 — et `oauth2/authorize`
 * EST un écran d'authentification, leçon du lot 68). Le motif de chemin
 * générique complète.
 */
function estPageAuthentification(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)ameliconnect\.ameli\.fr$/i.test(u.hostname)) return true;
    if (/\/oauth2\/authorize/i.test(u.pathname)) return true;
  } catch {
    return false;
  }
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni vos relevés ni un espace connecté (${raison}) : `
      + 'impossible de dire s\'il y a des documents. Rouvrez la connexion depuis la fiche du '
      + 'service, puis relancez la récupération.'
  );
}

/** Les services retenus par la configuration — à défaut, tous (modèle Uber). */
function servicesChoisis(config) {
  const retenus = Array.isArray(config?.[CHAMP_SERVICES]) ? config[CHAMP_SERVICES].map(String) : [];
  if (!retenus.length) return SERVICES;
  const choisis = SERVICES.filter((s) => retenus.includes(s.id));
  return choisis.length ? choisis : SERVICES;
}

/**
 * Découverte : les deux services, proposés tous cochés. Aucun navigateur
 * n'est ouvert ici — sans session, rien ne dit ce que LE compte porte.
 */
async function discover(config, ctx = {}) {
  const log = ctx.log || (() => {});
  log(`${ID} : 2 services proposés (relevés mensuels, attestation de droits), tous cochés `
    + 'd\'office — la première récupération dira ce que votre compte porte.');
  return {
    items: SERVICES.map((service) => ({
      id: service.id,
      label: service.label,
      detail: service.id === 'releves-mensuels'
        ? 'un relevé par mois quand des paiements ont eu lieu — un mois « Aucun paiement » ne produit pas de document'
        : 'une attestation par mois au plus, régénérée par Ameli à chaque téléchargement',
      preselected: true,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lecture des relevés mensuels — extraction DANS la page, analyse PURE
// ---------------------------------------------------------------------------

/** « août 2026 » → « 2026-08 » ; tout le reste → null. Fonction pure. */
function moisDepuisLibelle(texte) {
  const m = MOTIF_MOIS.exec(String(texte || ''));
  if (!m) return null;
  const nom = m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const numero = MOIS_FRANCAIS.get(nom);
  return numero ? `${m[2]}-${numero}` : null;
}

/**
 * Ce que la page des relevés montre : pour chaque nœud le PLUS PROFOND qui
 * porte un libellé de mois, le texte de son conteneur proche. Le conteneur est
 * cherché en remontant jusqu'à englober soit « Aucun paiement », soit un
 * élément cliquable — la forme exacte des cartes n'a jamais été vue connectée,
 * c'est le journal qui dira ce que le premier passage réel trouve.
 */
const EXTRAIRE_CARTES = ({ motifMois, motifAucun }) => {
  const reMois = new RegExp(motifMois, 'i');
  const reAucun = new RegExp(motifAucun, 'i');
  const profonds = [...document.querySelectorAll('*')].filter((el) =>
    !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
    && reMois.test(el.innerText || '')
    && ![...el.children].some((enfant) => reMois.test(enfant.innerText || '')));
  return profonds.map((noeud) => {
    let conteneur = noeud;
    for (let n = 0; n < 6 && conteneur.parentElement; n++) {
      const texte = conteneur.innerText || '';
      if (reAucun.test(texte) || conteneur.querySelector('a, button, [role="button"]')) break;
      conteneur = conteneur.parentElement;
    }
    const texteConteneur = (conteneur.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      libelle: (noeud.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      aucunPaiement: reAucun.test(texteConteneur),
      cliquables: [...conteneur.querySelectorAll('a, button, [role="button"]')]
        .map((el) => ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))
          .replace(/\s+/g, ' ').trim().slice(0, 80))
        .filter(Boolean).slice(0, 5),
    };
  });
};

/**
 * Les cartes brutes ramenées aux mois qu'elles désignent, dédoublonnées, avec
 * leur fait : « Aucun paiement » ou non. Fonction pure, testée.
 */
function analyserCartes(brutes) {
  const parMois = new Map();
  for (const carte of Array.isArray(brutes) ? brutes : []) {
    const mois = moisDepuisLibelle(carte?.libelle);
    if (!mois) continue;
    const existante = parMois.get(mois);
    // Deux nœuds peuvent porter le même mois (titre + rappel) : le fait
    // « Aucun paiement » gagne s'il est vu sur l'un d'eux.
    parMois.set(mois, {
      mois,
      aucunPaiement: (existante?.aucunPaiement || false) || !!carte?.aucunPaiement,
    });
  }
  return [...parMois.values()].sort((a, b) => (a.mois < b.mois ? 1 : -1));
}

/** L'ancre d'un relevé : son MOIS, jamais l'empreinte du fichier (lot 46). */
function remoteIdReleve(mois) {
  return `${ID}-releve-${mois}`;
}

/** L'ancre de l'attestation : le mois civil de récupération (voir l'en-tête). */
function remoteIdAttestation(mois) {
  return `${ID}-attestation-${mois}`;
}

/** Le mois civil UTC d'un instant : « 2026-09 ». */
function moisCourant(maintenant = new Date()) {
  const d = maintenant instanceof Date ? maintenant : new Date(maintenant);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Clique « Afficher plus de relevés » dans la page. Rend `false` quand le
 * bouton a disparu — la liste est déroulée (le geste Uber du lot 73 : un
 * premier écran n'est jamais la liste).
 */
async function cliquerAfficherPlus(page) {
  return page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((b) => b.offsetWidth || b.offsetHeight)
      .find((b) => re.test(String(b.innerText || '').replace(/\s+/g, ' ').trim()));
    if (!el) return false;
    try { el.scrollIntoView(); } catch { /* */ }
    el.click();
    return true;
  }, MOTIF_PLUS.source).catch(() => false);
}

/**
 * Déroule la liste des mois : clique « Afficher plus de relevés » jusqu'à ce
 * que le bouton disparaisse, que la fenêtre d'historique soit couverte, ou
 * que la page cesse de donner du neuf. Rend les cartes analysées.
 */
async function deroulerLesMois(page, log, borneFrom) {
  const borneMois = borneFrom ? borneFrom.toISOString().slice(0, 7) : null;
  let cartes = analyserCartes(await page.evaluate(EXTRAIRE_CARTES, {
    motifMois: MOTIF_MOIS.source, motifAucun: MOTIF_AUCUN_PAIEMENT.source,
  }).catch(() => []));

  for (let n = 0; n < MAX_PAGES_RELEVES; n++) {
    const plusAncien = cartes.length ? cartes[cartes.length - 1].mois : null;
    if (borneMois && plusAncien && plusAncien < borneMois) break;
    const encore = await cliquerAfficherPlus(page);
    if (!encore) break;
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(DELAI_PAGINATION_MS).catch(() => {});
    const suivantes = analyserCartes(await page.evaluate(EXTRAIRE_CARTES, {
      motifMois: MOTIF_MOIS.source, motifAucun: MOTIF_AUCUN_PAIEMENT.source,
    }).catch(() => []));
    if (suivantes.length <= cartes.length) {
      // Le clic n'a rien ajouté : on le journalise et on s'arrête plutôt que
      // de marteler un bouton dont l'effet réel reste à confirmer sur session.
      log(`${ID} : « Afficher plus de relevés » cliqué sans nouveau mois affiché — arrêt.`);
      cartes = suivantes.length ? suivantes : cartes;
      break;
    }
    cartes = suivantes;
  }
  return cartes;
}

/**
 * Clique le déclencheur de téléchargement DANS la carte d'un mois donné : le
 * cliquable de son conteneur dont le libellé évoque un téléchargement, sinon
 * le premier cliquable de la carte. Le geste part dans la page (leçon
 * Boulanger, lot 50).
 */
async function cliquerTelechargementDuMois(page, libelleMois) {
  return page.evaluate(({ motifMois, libelle, motifTelecharger }) => {
    const reMois = new RegExp(motifMois, 'i');
    const reTelecharger = new RegExp(motifTelecharger, 'i');
    const profonds = [...document.querySelectorAll('*')].filter((el) =>
      !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)
      && reMois.test(el.innerText || '')
      && ![...el.children].some((enfant) => reMois.test(enfant.innerText || '')));
    const noeud = profonds.find((el) =>
      (el.innerText || '').replace(/\s+/g, ' ').includes(libelle));
    if (!noeud) return false;
    let conteneur = noeud;
    for (let n = 0; n < 6 && conteneur.parentElement; n++) {
      if (conteneur.querySelector('a, button, [role="button"]')) break;
      conteneur = conteneur.parentElement;
    }
    const cliquables = [...conteneur.querySelectorAll('a, button, [role="button"]')];
    if (!cliquables.length) return false;
    const cible = cliquables.find((el) =>
      reTelecharger.test((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')))
      || cliquables[0];
    try { cible.scrollIntoView(); } catch { /* */ }
    cible.click();
    return true;
  }, {
    motifMois: MOTIF_MOIS.source,
    libelle: String(libelleMois),
    motifTelecharger: MOTIF_TELECHARGER_RELEVE.source,
  }).catch(() => false);
}

/** Le libellé français d'un mois « AAAA-MM », pour viser sa carte. */
function libelleDuMois(mois) {
  const noms = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
    'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const [annee, numero] = String(mois).split('-').map(Number);
  return numero >= 1 && numero <= 12 ? `${noms[numero - 1]} ${annee}` : String(mois);
}

/** La borne basse de la fenêtre, d'après le réglage d'historique du compte. */
function borneHistorique(config, ctx) {
  return history.fenetreDeDates({
    valeur: config?.[CHAMP_HISTORIQUE],
    dejaRecupere: ctx?.dejaRecupere ?? (ctx?.knownRemoteIds || []).length > 0,
    plafondMois: ctx?.conservationMois || 0,
  });
}

/**
 * Récupère les relevés mensuels : déroule la liste, puis pour chaque mois qui
 * porte des paiements et que la base ne connaît pas, télécharge son document.
 * Un mois « Aucun paiement » N'EST PAS un échec : c'est un fait, journalisé,
 * et aucun document n'est créé pour lui.
 */
async function recupererReleves(page, context, log, connus, invoices, fenetre) {
  const cartes = await deroulerLesMois(page, log, fenetre.from);
  if (!cartes.length) {
    log(`${ID} : aucune carte de mois reconnue sur la page des relevés — la forme relevée `
      + 'sur les captures du 09/09/2026 ne s\'est pas retrouvée, à confirmer sur session. '
      + 'Rien n\'a été récupéré pour ce service.');
    return { vus: 0, sansPaiement: 0, deja: 0, sansDocument: 0 };
  }

  const borneMois = fenetre.from ? fenetre.from.toISOString().slice(0, 7) : null;
  let sansPaiement = 0;
  let deja = 0;
  let sansDocument = 0;
  let horsFenetre = 0;

  for (const carte of cartes) {
    if (borneMois && carte.mois < borneMois) { horsFenetre += 1; continue; }
    if (carte.aucunPaiement) {
      // Le fait, pas un échec : ce mois n'a pas de relevé à produire.
      sansPaiement += 1;
      continue;
    }
    const remoteId = remoteIdReleve(carte.mois);
    if (connus.has(remoteId)) { deja += 1; continue; }

    const obtenu = await clicDocument.documentDuClic(
      page, context, () => cliquerTelechargementDuMois(page, libelleDuMois(carte.mois))
    );
    if (obtenu.ok) {
      connus.add(remoteId);
      invoices.push({
        remoteId,
        filename: documentsDePage.nomFichier(ID, { issuedOn: `${carte.mois}-01`, remoteId }),
        issuedOn: `${carte.mois}-01`,
        buffer: obtenu.buffer,
      });
      log(`${ID} : relevé de ${libelleDuMois(carte.mois)} — document lu `
        + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
    } else {
      sansDocument += 1;
      log(`${ID} : relevé de ${libelleDuMois(carte.mois)} — aucun document obtenu `
        + `(${obtenu.grief}). On continue avec les mois suivants.`);
    }
  }

  log(`${ID} : ${cartes.length} mois affiché(s), ${invoices.length} relevé(s) récupéré(s), `
    + `${sansPaiement} mois sans paiement (aucun document à produire : c'est un fait, pas un échec)`
    + `${deja ? `, ${deja} déjà déposé(s)` : ''}`
    + `${horsFenetre ? `, ${horsFenetre} hors de la période demandée` : ''}`
    + `${sansDocument ? `, ${sansDocument} sans document lisible` : ''}.`);
  return { vus: cartes.length, sansPaiement, deja, sansDocument };
}

/**
 * Récupère l'attestation de droits — au plus UNE par mois civil (l'ancre,
 * voir l'en-tête). Si l'ancre du mois est déjà connue, RIEN n'est ouvert ni
 * cliqué : le document est regénéré par Ameli à chaque téléchargement, et un
 * clic pour rien serait une génération pour rien.
 */
async function recupererAttestation(page, context, log, connus, invoices) {
  const mois = moisCourant();
  const remoteId = remoteIdAttestation(mois);
  if (connus.has(remoteId)) {
    log(`${ID} : l'attestation de droits de ce mois-ci est déjà déposée — rien n'est recliqué `
      + '(le document serait regénéré pour rien).');
    return;
  }

  await profilMarchand.atteindreLaPage(page, {
    id: ID, nom: NOM, log, urlDepart: ATTESTATION_URL, estAuthentification: estPageAuthentification,
  });
  if (!CHEMIN_ATTESTATION.test(page.url())) {
    log(`${ID} : la page de l'attestation n'est pas servie (adresse : ${page.url()}) — `
      + 'rien récupéré pour ce service.');
    return;
  }

  // Le sélecteur de bénéficiaire (capture du 09/09/2026) est laissé sur son
  // choix par défaut : rien n'a été mesuré sur un compte à plusieurs
  // bénéficiaires, et le journal le dit plutôt que de le deviner.
  log(`${ID} : page de l'attestation servie — le bénéficiaire proposé par défaut est conservé `
    + '(la lecture d\'autres bénéficiaires reste à mesurer sur un compte qui en a).');

  const obtenu = await clicDocument.documentDuClic(page, context, () =>
    page.evaluate((motif) => {
      const re = new RegExp(motif, 'i');
      const el = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
        .filter((b) => b.offsetWidth || b.offsetHeight)
        .find((b) => re.test(((b.innerText || b.value || '') + ' '
          + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ')));
      if (!el) return false;
      try { el.scrollIntoView(); } catch { /* */ }
      el.click();
      return true;
    }, MOTIF_TELECHARGER_ATTESTATION.source).catch(() => false));

  if (obtenu.ok) {
    connus.add(remoteId);
    const issuedOn = new Date().toISOString().slice(0, 10);
    invoices.push({
      remoteId,
      filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
      issuedOn,
      buffer: obtenu.buffer,
    });
    log(`${ID} : attestation de droits téléchargée (voie mesurée : ${obtenu.voie}, `
      + `${obtenu.buffer.length} octets) — la prochaine sera prise le mois prochain.`);
  } else {
    log(`${ID} : le bouton « Télécharger l'attestation de droits » n'a pas servi de document `
      + `(${obtenu.grief}) — à confirmer sur session, rien n'a été déposé pour ce service.`);
  }
}

/**
 * Atteint la page des relevés, la juge (la preuve de session), et passe la
 * main — l'ossature commune de `test` et `fetchInvoices` (modèle Uber).
 */
async function surLesReleves(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: RELEVES_URL, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_RELEVES,
        estAuthentification: estPageAuthentification,
        // Mesuré le 09/09/2026 : l'adresse éconduit les anonymes vers
        // ameliconnect.ameli.fr/oauth2/authorize — y rester prouve.
        redirigeLesAnonymes: true,
        motifRepere: MOTIF_MOIS,
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

/** Vérification légère : la session tient, la page des relevés est servie. */
async function test(config, ctx = {}) {
  return surLesReleves(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      'Connexion valide — votre page de relevés mensuels Ameli est servie à votre compte. '
      + 'Les relevés et l\'attestation de droits seront récupérés selon vos choix.',
  }));
}

/**
 * Récupère les documents des services choisis. Les relevés mensuels servent
 * la preuve de session ; l'attestation de droits suit, ancrée sur le mois.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));
  const choisis = servicesChoisis(config);
  const veutReleves = choisis.some((s) => s.id === 'releves-mensuels');
  const veutAttestation = choisis.some((s) => s.id === 'attestation-droits');
  const fenetre = borneHistorique(config, ctx);

  return surLesReleves(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) — lue sur la page des relevés.
    ctx.preuveDeListe?.({
      session: `page des relevés mensuels servie au compte connecté (${etat.raison})`,
      liste: RELEVES_URL,
      elements: etat.reperes,
    });

    const invoices = [];
    let bilanReleves = null;

    if (veutReleves) {
      log(`${ID} : historique « ${fenetre.mode} » — ${fenetre.raison}`);
      bilanReleves = await recupererReleves(page, context, log, connus, invoices, fenetre);
    } else {
      log(`${ID} : Relevés mensuels non retenus dans vos choix — page servie, rien récupéré `
        + 'pour ce service.');
    }

    if (veutAttestation) {
      await recupererAttestation(page, context, log, connus, invoices);
    }

    const moisSansPaiement = bilanReleves?.sansPaiement || 0;
    return {
      accountId: null,
      invoices,
      precision: moisSansPaiement
        ? `— ${moisSansPaiement} mois affichés « Aucun paiement » n'appellent aucun document : `
          + 'c\'est ce que la page montre, pas un échec.'
        : undefined,
      aucunDocument: !invoices.length && bilanReleves && bilanReleves.vus > 0
        && bilanReleves.vus === moisSansPaiement + (bilanReleves.deja || 0)
        ? 'Tous les mois affichés sont soit « Aucun paiement », soit déjà déposés : il n\'y a '
          + 'rien de nouveau à récupérer.'
        : undefined,
    };
  });
}

module.exports = {
  test,
  fetchInvoices,
  discover,
  // exportés pour les tests unitaires
  estPageAuthentification,
  servicesChoisis,
  moisDepuisLibelle,
  analyserCartes,
  remoteIdReleve,
  remoteIdAttestation,
  moisCourant,
  libelleDuMois,
  borneHistorique,
  SERVICES,
  CHAMP_SERVICES,
  RELEVES_URL,
  ATTESTATION_URL,
  CHEMIN_RELEVES,
  CHEMIN_ATTESTATION,
  MOTIF_PLUS,
  MOTIF_AUCUN_PAIEMENT,
  MOTIF_TELECHARGER_ATTESTATION,
  MOTIF_MOIS,
};
