'use strict';

/**
 * Connecteur SNCF Connect — les JUSTIFICATIFS DE VOYAGE des trajets passés.
 *
 * ─── Les deux documents, et pourquoi on ne ramène que le second ──────────────
 *
 * Le panneau « Vos justificatifs » d'un voyage porte DEUX documents de nature
 * différente (relevé d'écran du 14/08/2026) :
 *
 *   - le **justificatif d'ACHAT** — la preuve du paiement, celle qui fait
 *     office de facture — n'est PAS téléchargeable : le bouton s'appelle
 *     « Obtenir le justificatif par e-mail », et SNCF l'envoie dans la boîte
 *     de l'utilisateur (disponible jusqu'au 31/08/2027) ;
 *   - le **justificatif de VOYAGE** — la preuve que le trajet a été réalisé —
 *     se télécharge directement (« Télécharger votre justificatif »).
 *
 * crabe n'a pas de boîte aux lettres : il récupère le justificatif de voyage,
 * et DIT à chaque passage que le justificatif d'achat se demande par e-mail
 * depuis SNCF Connect (Mes voyages → le voyage → Vos justificatifs →
 * « Obtenir le justificatif par e-mail »). Il ne clique JAMAIS ce bouton :
 * déclencher un envoi d'e-mail est un geste qui appartient à l'utilisateur.
 * Et il ne fait jamais passer le justificatif de voyage pour une facture —
 * son nom de fichier dit ce qu'il est.
 *
 * Le connecteur reste tout de même à l'affût d'un téléchargement direct du
 * justificatif d'achat : si le panneau en propose un jour un, le bouton sera
 * pris comme les autres — la limite est vérifiée à CHAQUE exécution, pas
 * gravée une fois pour toutes.
 *
 * ─── Ce qui est mesuré, et ce qui ne l'est pas ───────────────────────────────
 *
 * www.sncf-connect.com est muré par une vérification anti-robot (mesurée au
 * curl ET au navigateur nu : interstitiel `captcha-delivery.com`, corps vide).
 * La structure de la page des voyages n'a donc PAS pu être vue sans compte :
 * le parcours ci-dessous suit le relevé d'écran d'un compte réel (onglets « À venir » /
 * « Passés », bouton « Voir le détail du voyage », section « Vos
 * justificatifs ») et DÉCRIT au journal ce qu'il voit quand il ne trouve pas —
 * pour que la première exécution réelle se diagnostique en une passe.
 */

const authSncf = require('../../auth-sncf');
const identity = require('../../browser-identity');
const empreinte = require('../../empreinte-document');
const identite = require('../../identite-voyage');
const ongletPdf = require('../../onglet-pdf');

const ID = 'sncf-connect';
const NOM = 'SNCF Connect';
const URL_VOYAGES = 'https://www.sncf-connect.com/app/trips';

const PAUSE_DOCUMENT_MS = 400;
/** Défilement / « voir plus » : on arrête quand la liste ne grandit plus. */
const RONDES_DEFILEMENT_MAX = 30;
const RONDES_STABLES = 3;

/** Le bouton d'ENVOI D'E-MAIL, à ne jamais cliquer. */
const MOTIF_ENVOI_EMAIL = /e-?mail|courriel/i;
/** Un déclencheur de téléchargement direct dans le panneau des justificatifs. */
const MOTIF_TELECHARGER = /t[ée]l[ée]charg/i;
/**
 * Le bouton « Accéder à vos justificatifs » (lot 45, mesuré la nuit du
 * 20/08/2026 sur les voyages 3 et 5) : il ne mène nulle part — il fait
 * APPARAÎTRE « Télécharger votre justificatif » dans le même panneau.
 */
const MOTIF_ACCEDER = /acc[ée]der/i;

/** « Passés », « PASSÉS », avec ou sans accent selon le rendu. */
const MOTIF_ONGLET_PASSES = /^\s*pass[ée]s?\s*$/i;
const MOTIF_DETAIL = /voir le d[ée]tail du voyage|d[ée]tail du voyage/i;
const MOTIF_JUSTIFICATIFS = /vos justificatifs|justificatifs/i;

/**
 * Écrit au journal ce que la page offrait quand on n'y a pas trouvé son
 * compte — libellés d'interface uniquement, jamais le contenu des voyages.
 */
async function journaliserPage(page, log, pourquoi) {
  const vue = await page.evaluate(() => {
    const court = (t) => (t || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return {
      url: location.href,
      titre: document.title,
      boutons: [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
        .map((b) => court(b.innerText)).filter(Boolean).slice(0, 20),
    };
  }).catch(() => ({ url: '?', titre: '?', boutons: [] }));
  log(`${ID} : ${pourquoi}. Page « ${vue.titre} » (${vue.url}).`);
  log(`${ID} :   boutons vus — ${vue.boutons.join(' | ') || 'aucun'}`);
}

/**
 * La page est-elle sa version DÉCONNECTÉE ?
 *
 * Mesuré le 18/08/2026 : quand la session du profil est tombée, /app/trips
 * atterrit sur /trips « Billets et titres », qui porte des boutons
 * « Se connecter » et « Créer un compte » — et évidemment aucun onglet
 * « Passés ». Conclure « onglet non reconnu » sur cette page accusait la
 * reconnaissance d'onglet alors que personne n'était connecté.
 */
async function paraitDeconnecte(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => el.offsetWidth || el.offsetHeight)
      .some((el) => /^\s*se connecter\s*$/i.test((el.innerText || '').trim()))
  ).catch(() => false);
}

/** Clique l'onglet « Passés » ; rend faux s'il est introuvable. */
async function ouvrirOngletPasses(page) {
  return page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const candidats = [...document.querySelectorAll('[role="tab"], button, a')];
    const onglet = candidats.find((el) => re.test((el.innerText || '').trim()));
    if (!onglet) return false;
    onglet.click();
    return true;
  }, MOTIF_ONGLET_PASSES.source).catch(() => false);
}

/** Compte les entrées de voyage visibles (les boutons « détail » font foi). */
async function compterVoyages(page) {
  return page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    return [...document.querySelectorAll('button, a')]
      .filter((el) => re.test((el.innerText || '').trim())).length;
  }, MOTIF_DETAIL.source).catch(() => 0);
}

/**
 * Fait apparaître TOUT l'onglet : « voir plus » cliqué s'il existe, sinon
 * défilement — et on s'arrête quand le compte ne bouge plus. Le relevé
 * d'écran ne dit pas laquelle des deux formes la page emploie : on traite
 * les deux, c'est le compte de voyages qui tranche.
 */
async function deroulerToutLOnglet(page, log) {
  let stable = 0;
  let dernier = await compterVoyages(page);

  for (let ronde = 0; ronde < RONDES_DEFILEMENT_MAX && stable < RONDES_STABLES; ronde++) {
    const aClique = await page.evaluate(() => {
      const bouton = [...document.querySelectorAll('button, a')].find((el) =>
        /voir plus|afficher plus|charger plus|voyages suivants/i.test((el.innerText || '').trim()));
      if (bouton) {
        bouton.click();
        return true;
      }
      window.scrollTo(0, document.body.scrollHeight);
      return false;
    }).catch(() => false);

    await page.waitForTimeout(aClique ? 2_000 : 1_200);
    const compte = await compterVoyages(page);
    stable = compte === dernier ? stable + 1 : 0;
    dernier = compte;
  }

  log(`${ID} : ${dernier} voyage(s) affiché(s) dans l'onglet après déroulement complet.`);
  return dernier;
}

/**
 * Exécutée DANS la page : ce que propose le PANNEAU « Vos justificatifs », et
 * lui seul (lot 42, refait sur mesure au lot 43).
 *
 * Le lot 38 collectait les boutons du DOCUMENT ENTIER. Le 18/08/2026, le
 * journal a donc listé sous « Boutons visibles » le menu du site — « Billets
 * de train », « Hôtels », « Info trafic » — et pas les boutons du panneau :
 * l'instrumentation mesurait le mauvais périmètre, et la question « le bouton
 * de téléchargement existe-t-il encore ? » restait sans réponse.
 *
 * Le lot 42 cherchait le panneau par son TITRE (le nœud le plus profond qui
 * le porte, puis remontée vers un ancêtre à déclencheur). Ça marchait sur DOM
 * simulé, pas sur la vraie page — voir le bloc de mesure du 20/08/2026 dans
 * le corps de la fonction : le panneau réel est un portail sans lien
 * d'ascendance avec le titre. Le panneau se cherche donc désormais depuis les
 * DÉCLENCHEURS eux-mêmes.
 *
 * Quand le bornage échoue, la collecte se fait sur le document entier ET
 * `perimetre` le DIT : un journal qui ment sur ce qu'il a mesuré est pire que
 * pas de journal.
 */
function LIRE_PANNEAU({ titre, telech, email }) {
  const reTitre = new RegExp(titre, 'i');
  const reTelech = new RegExp(telech, 'i');
  const reEmail = new RegExp(email, 'i');
  const texteDe = (el) => (el.innerText || '').trim();
  const estDeclencheur = (el) => {
    const t = texteDe(el);
    return !!t && (reTelech.test(t) || reEmail.test(t));
  };
  const contientNav = (el) => !!el.querySelector('header, nav, [role="navigation"]');
  const boutonsDe = (racine) =>
    [...racine.querySelectorAll('button, a, [role="button"]')]
      .map((el) => texteDe(el))
      .filter(Boolean);

  // ─── Pourquoi le panneau se cherche depuis les DÉCLENCHEURS (lot 43) ───────
  //
  // Le lot 42 partait du TITRE le plus profond et remontait vers un ancêtre
  // portant un déclencheur. Mesuré le 20/08/2026 sur la vraie page : ça ne
  // peut pas marcher. Le panneau « Vos justificatifs » est un TIROIR MUI
  // (`div[role="dialog"][aria-modal="true"]`, classes `MuiDrawer-paper…`)
  // rendu en PORTAIL, directement sous `body` — il n'est l'ancêtre d'AUCUN
  // des nœuds de la page qui portent aussi ce titre (le plus profond vivait
  // dans un `tabpanel` du détail du voyage). La remontée depuis le titre
  // croisait la navigation du site avant tout déclencheur et rendait
  // « document entier (panneau non borné) ».
  //
  // Depuis les déclencheurs, trois prises, de la plus sûre à la moins sûre :
  //   1. le dialogue (`[role="dialog"]`/`[aria-modal="true"]`) qui porte le
  //      premier déclencheur — le tiroir mesuré ;
  //   2. à défaut, le plus BAS ancêtre commun de tous les déclencheurs ;
  //   3. le candidat s'élargit ensuite d'un cran à la fois jusqu'à porter le
  //      TITRE, en s'arrêtant NET avant d'avaler la navigation du site.
  const declencheurs = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter(estDeclencheur);

  let panneau = null;
  if (declencheurs.length) {
    const dialogue = declencheurs[0].closest('[role="dialog"], [aria-modal="true"]');
    if (dialogue && !contientNav(dialogue)) {
      panneau = dialogue;
    } else {
      let commun = declencheurs[0];
      for (const d of declencheurs.slice(1)) {
        while (commun && !commun.contains(d)) commun = commun.parentElement;
      }
      panneau = commun && commun !== document.body && !contientNav(commun) ? commun : null;
    }
    while (panneau && !reTitre.test(texteDe(panneau))) {
      const parent = panneau.parentElement;
      if (!parent || parent === document.body || contientNav(parent)) break;
      panneau = parent;
    }
  }

  const racine = panneau || document.body;
  const libelles = boutonsDe(racine);
  const porteTitre = !!panneau && reTitre.test(texteDe(panneau));
  return {
    ouvert: true,
    telechargements: libelles.filter((t) => reTelech.test(t) && !reEmail.test(t)).length,
    parEmail: libelles.filter((t) => reEmail.test(t)).length,
    // Les LIBELLÉS, pour le journal d'un voyage sans téléchargement (lot 38),
    // désormais bornés au panneau (lot 42), trouvé depuis ses boutons (lot 43).
    libelles,
    // Le périmètre DIT ce qui a été mesuré — y compris le cas intermédiaire
    // d'un panneau borné qui ne porte pas le titre attendu.
    perimetre: panneau
      ? (porteTitre
        ? 'panneau « Vos justificatifs »'
        : 'panneau des justificatifs (titre hors panneau)')
      : 'document entier (panneau non borné)',
  };
}

/**
 * Clique « Accéder à vos justificatifs » s'il existe ; rend faux sinon.
 *
 * Le texte est ramené en NFC AVANT le motif : la page sert parfois ses accents
 * décomposés (piège mesuré — une ancre « Accès » en NFD ne matche pas
 * `/acc[ée]s/`, le ́ combinant s'intercale entre le e et la suite).
 */
async function cliquerAccederAuxJustificatifs(page) {
  return page.evaluate(({ acceder, justificatifs, email }) => {
    const reAcceder = new RegExp(acceder, 'i');
    const reJustif = new RegExp(justificatifs, 'i');
    const reEmail = new RegExp(email, 'i');
    const texteDe = (el) => (el.innerText || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const bouton = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
      const t = texteDe(el);
      return !!t && reAcceder.test(t) && reJustif.test(t) && !reEmail.test(t);
    });
    if (!bouton) return false;
    bouton.click();
    return true;
  }, {
    acceder: MOTIF_ACCEDER.source,
    justificatifs: MOTIF_JUSTIFICATIFS.source,
    email: MOTIF_ENVOI_EMAIL.source,
  }).catch(() => false);
}

/**
 * Ouvre le panneau des justificatifs du voyage COURANT et rapporte ce qu'il
 * propose : les déclencheurs de téléchargement direct, et la présence du
 * bouton d'envoi par e-mail — qu'on ne clique jamais.
 *
 * ─── Le clic SUPPLÉMENTAIRE (lot 45) ─────────────────────────────────────────
 *
 * Mesuré la nuit du 20/08/2026 sur les voyages 3 et 5 : leur panneau ne porte
 * d'abord AUCUN déclencheur de téléchargement, seulement « Accéder à vos
 * justificatifs » — qui ne navigue nulle part et fait apparaître
 * « Télécharger votre justificatif » dans le même panneau. Un panneau sans
 * téléchargement retente donc UNE fois, après ce clic, et le compte rendu dit
 * que le clic a eu lieu (`clicSupplementaire`) : deux voyages de plus se
 * récupèrent, et le journal sait par quel chemin.
 */
async function releverJustificatifs(page) {
  const ouvert = await page.evaluate((motif) => {
    const re = new RegExp(motif, 'i');
    const section = [...document.querySelectorAll('button, a, [role="button"]')].find((el) =>
      re.test((el.innerText || '').trim()));
    if (!section) return false;
    section.click();
    return true;
  }, MOTIF_JUSTIFICATIFS.source).catch(() => false);
  if (!ouvert) {
    return { ouvert: false, telechargements: 0, parEmail: 0, libelles: [], perimetre: null };
  }

  await page.waitForTimeout(2_000);

  const lirePanneau = () =>
    page.evaluate(LIRE_PANNEAU, {
      titre: MOTIF_JUSTIFICATIFS.source,
      telech: MOTIF_TELECHARGER.source,
      email: MOTIF_ENVOI_EMAIL.source,
    }).catch(
      () => ({ ouvert: true, telechargements: 0, parEmail: 0, libelles: [], perimetre: null })
    );

  const panneau = await lirePanneau();
  if (panneau.telechargements > 0) {
    return { ...panneau, clicSupplementaire: false };
  }

  if (!(await cliquerAccederAuxJustificatifs(page))) {
    return { ...panneau, clicSupplementaire: false };
  }
  await page.waitForTimeout(2_000);
  return { ...(await lirePanneau()), clicSupplementaire: true };
}

/**
 * Décrit les déclencheurs réellement présents dans un panneau, pour le journal.
 *
 * Le 18/08/2026 à 21:56 : 11 voyages passés lus, 0 justificatif récupéré — et
 * le journal ne disait pas ce que le panneau de chaque voyage MONTRAIT. Sans
 * cette description, « le bouton de téléchargement existe-t-il encore ? »
 * reste une supposition d'une exécution à l'autre. Libellés d'interface
 * uniquement, et rien de personnel : dédoublonnés, chiffres masqués (une date
 * ou un numéro de dossier n'a rien à faire au journal), bornés en longueur
 * (60 caractères) et en nombre (20).
 */
function decrireDeclencheurs(libelles) {
  const vus = new Set();
  const propres = [];
  for (const brut of Array.isArray(libelles) ? libelles : []) {
    const texte = String(brut || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\d/g, '#')
      .slice(0, 60);
    if (!texte || vus.has(texte)) continue;
    vus.add(texte);
    propres.push(texte);
    if (propres.length >= 20) break;
  }
  return propres.length ? propres.map((t) => `« ${t} »`).join(' | ') : 'aucun bouton visible';
}

/**
 * Un texte d'interface prêt pour le journal : espaces réduits, chiffres
 * masqués (une date, un numéro de dossier ou un montant n'ont rien à y faire),
 * longueur bornée. Même règle que `decrireDeclencheurs`.
 */
function pourLeJournal(texte, longueur = 60) {
  return String(texte || '').replace(/\s+/g, ' ').trim().replace(/\d/g, '#').slice(0, longueur);
}

/**
 * L'adresse d'une page, réduite à ce qui se journalise : origine et chemin,
 * jamais la requête — c'est là que vivent les jetons (règle du lot 33).
 */
function adressePourLeJournal(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`.replace(/\d/g, '#');
  } catch {
    return 'adresse illisible';
  }
}

/**
 * Lit le document que sert un ONGLET ouvert par un déclencheur.
 *
 * La mécanique a quitté ce fichier au lot 44 : OUIGO en a besoin mot pour mot
 * (même écran d'arrivée, même `application/pdf`, même absence de
 * « download »), et deux copies d'une mécanique aussi tatillonne
 * divergeraient au premier correctif. Elle vit dans `connectors/onglet-pdf.js`
 * et reste exportée ici, sous le même nom, pour les tests qui la visent.
 */
const lireDocumentDeLOnglet = ongletPdf.lireDocumentDeLOnglet;

/**
 * Clique le n-ième déclencheur de téléchargement du panneau et attend le
 * fichier. Le bouton d'e-mail est écarté par son texte AVANT le clic.
 *
 * ─── Pourquoi cette fonction RACONTE au lieu de lever (lot 42) ───────────────
 *
 * Le 18/08/2026, sur 11 voyages, les voyages 1, 2 et 4 ont écrit au journal
 * « un téléchargement n'a pas abouti, on continue » — et rien d'autre. Un
 * déclencheur EXISTE, le téléchargement ÉCHOUE, et personne ne peut dire
 * pourquoi : ni quel bouton, ni ce qui a été tenté, ni ce qui a manqué. Ce lot
 * MESURE cet échec ; il ne le répare pas — le suivant corrigera sur des faits.
 *
 * Elle ne lève donc plus : elle rend toujours un compte rendu.
 *
 * @returns {Promise<{ok: boolean, buffer?: Buffer, nomPropose?: string,
 *   libelle: string, tentative: string, grief: string|null}>}
 *   `libelle` = le déclencheur cliqué, `tentative` = ce qui s'est produit
 *   après le clic (nouvel onglet ? navigation ?), `grief` = ce qui a manqué.
 */
async function telechargerJustificatif(page, rang) {
  const contexte = page.context?.() || null;
  const urlAvant = page.url?.() || '';

  // Un nouvel onglet est une PISTE, pas un échec — et depuis le lot 43, c'est
  // LE chemin mesuré : le 20/08/2026, « Télécharger votre justificatif » est
  // un lien `target="_blank"` vers monbillet.sncf, et la page d'arrivée EST le
  // PDF (contentType `application/pdf`, ni formulaire ni bouton). Le fichier
  // n'arrive jamais en « download » : il se lit dans la RÉPONSE du site.
  // L'écouteur de réponses se pose dès que l'onglet naît, sans quoi la
  // réponse du document principal serait déjà passée.
  let nouvelOnglet = null;
  let reponsePdf = null;
  const surReponse = async (reponse) => {
    try {
      if (reponsePdf) return;
      const type = (await reponse.headerValue('content-type')) || '';
      if (/pdf/i.test(type)) reponsePdf = reponse;
    } catch { /* réponse déjà close : l'onglet reste lisible par ailleurs */ }
  };
  const surNouvellePage = (p) => {
    if (nouvelOnglet) return;
    nouvelOnglet = p;
    p.on?.('response', surReponse);
  };
  contexte?.on?.('page', surNouvellePage);

  try {
    const attente = page.waitForEvent('download', { timeout: authSncf.NAV_TIMEOUT_MS });
    // Le clic rapporte le LIBELLÉ exact du bouton actionné : sans lui, « un
    // téléchargement n'a pas abouti » ne désigne rien.
    const clique = await page.evaluate(({ telech, email, cible }) => {
      const reTelech = new RegExp(telech, 'i');
      const reEmail = new RegExp(email, 'i');
      const boutons = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter((el) => {
          const texte = (el.innerText || '').trim();
          return texte && reTelech.test(texte) && !reEmail.test(texte);
        });
      const bouton = boutons[cible];
      if (!bouton) return null;
      const vu = {
        texte: (bouton.innerText || '').trim(),
        balise: bouton.tagName.toLowerCase(),
        cible: bouton.getAttribute('target') || '',
        lien: bouton.tagName.toLowerCase() === 'a' ? (bouton.getAttribute('href') || '') : '',
      };
      bouton.click();
      return vu;
    }, { telech: MOTIF_TELECHARGER.source, email: MOTIF_ENVOI_EMAIL.source, cible: rang })
      .catch((err) => ({ erreur: String(err?.message || err) }));

    if (!clique || clique.erreur) {
      attente.catch(() => {});
      return {
        ok: false,
        libelle: 'déclencheur introuvable',
        tentative: 'aucun clic : le bouton n\'était plus dans la page au moment de l\'actionner',
        grief: clique?.erreur
          ? `la page a refusé le clic (${pourLeJournal(clique.erreur, 120)})`
          : `le panneau ne portait plus de ${rang + 1}ᵉ déclencheur de téléchargement`,
      };
    }

    const libelle = pourLeJournal(clique.texte) || 'sans libellé';
    // `href` peut porter un jeton : on ne dit QUE la nature du lien.
    const nature = clique.lien
      ? (/^blob:|^data:/i.test(clique.lien) ? 'un lien de fichier fabriqué par la page'
        : 'un lien vers une adresse du site')
      : 'aucun lien porté par le bouton';

    let download = null;
    let grief = null;
    // Le document peut arriver par DEUX chemins : l'événement « download »
    // (jamais vu sur 11 voyages) ou la réponse PDF d'un onglet ouvert par le
    // lien — le chemin RÉEL, mesuré le 20/08/2026. Le premier des deux gagne :
    // plus d'attente de 45 secondes pour un fichier qui n'arrivera jamais.
    await Promise.race([
      attente.then((d) => { download = d; })
        .catch((err) => {
          grief = /timeout/i.test(String(err?.message || ''))
            ? `aucun fichier n'est arrivé dans le délai de ${Math.round(authSncf.NAV_TIMEOUT_MS / 1000)} secondes`
            : `l'attente du fichier a échoué (${pourLeJournal(err?.message, 120)})`;
        }),
      (async () => {
        const fin = Date.now() + authSncf.NAV_TIMEOUT_MS;
        while (Date.now() < fin && !reponsePdf) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })(),
    ]);

    // Ce qui s'est passé après le clic, quoi qu'il arrive : c'est la moitié du
    // renseignement — un PDF ouvert dans un onglet n'est pas un téléchargement.
    const urlApres = page.url?.() || '';
    const tentative = [
      `clic sur ${clique.balise === 'a' ? 'un lien' : 'un bouton'} (${nature}`
        + `${clique.cible ? `, ouverture « ${pourLeJournal(clique.cible, 20)} »` : ''})`,
      nouvelOnglet
        ? `un nouvel onglet s'est ouvert (${adressePourLeJournal(nouvelOnglet.url?.() || '')})`
        : 'aucun nouvel onglet',
      urlApres && urlApres !== urlAvant
        ? `la page a navigué vers ${adressePourLeJournal(urlApres)}`
        : 'la page n\'a pas changé d\'adresse',
    ].join(' ; ');

    if (!download) {
      // Le chemin de l'onglet (lot 43) : le PDF servi par la page d'arrivée.
      if (nouvelOnglet) {
        const depuisOnglet = await lireDocumentDeLOnglet(nouvelOnglet, reponsePdf);
        if (depuisOnglet.ok) {
          return {
            ok: true,
            buffer: depuisOnglet.buffer,
            nomPropose: '',
            libelle,
            tentative: `${tentative} ; le PDF a été lu depuis la réponse de l'onglet `
              + `(${adressePourLeJournal(depuisOnglet.adresse)}), puis l'onglet a été refermé`,
            grief: null,
          };
        }
        const griefOnglet = `l'onglet ouvert n'a pas donné le document (${depuisOnglet.grief})`;
        return {
          ok: false,
          libelle,
          tentative,
          grief: grief ? `${grief} ; ${griefOnglet}` : griefOnglet,
        };
      }
      return { ok: false, libelle, tentative, grief: grief || 'ni fichier ni onglet après le clic' };
    }

    // Le site peut interrompre un téléchargement commencé : il le dit lui-même.
    const echecDuSite = await download.failure?.().catch(() => null);
    if (echecDuSite) {
      return {
        ok: false,
        libelle,
        tentative,
        grief: `le site a interrompu le téléchargement (${pourLeJournal(echecDuSite, 120)})`,
      };
    }

    let buffer;
    try {
      const flux = await download.createReadStream();
      const morceaux = [];
      for await (const morceau of flux) morceaux.push(morceau);
      buffer = Buffer.concat(morceaux);
    } catch (err) {
      return {
        ok: false,
        libelle,
        tentative,
        grief: `le fichier annoncé n'a pas pu être lu (${pourLeJournal(err?.message, 120)})`,
      };
    }

    // Un fichier arrivé qui n'est pas un PDF : le grief nomme ce qui est venu.
    if (!identity.estPdf(buffer)) {
      return {
        ok: false,
        libelle,
        tentative,
        grief:
          `le fichier reçu n'est pas un PDF (${buffer.length} octets, commence par `
          + `« ${pourLeJournal(buffer.subarray(0, 12).toString('latin1'), 12)} »)`,
      };
    }

    return {
      ok: true,
      buffer,
      nomPropose: download.suggestedFilename?.() || '',
      libelle,
      tentative,
      grief: null,
    };
  } finally {
    contexte?.off?.('page', surNouvellePage);
  }
}

/** Une date « 12 juillet 2026 » ou « 12/07/2026 » lue près du voyage courant. */
async function dateDuVoyage(page) {
  const texte = await page.evaluate(() =>
    (document.body?.innerText || '').slice(0, 6_000)).catch(() => '');
  const moisLongs = require('../../scraping').normalizeFrenchDate;
  for (const morceau of texte.split('\n')) {
    const date = moisLongs(morceau);
    if (date) return date;
  }
  return null;
}

/**
 * L'identifiant distant s'ancre sur le VOYAGE, plus sur le fichier (lot 46).
 *
 * ─── Deux leçons, payées à deux jours d'écart ────────────────────────────────
 *
 * Lot 44 : l'empreinte des octets bruts ne tenait pas — SNCF regénère le
 * justificatif à chaque téléchargement (6 lignes pour 3 documents les 19 et
 * 20/08/2026). L'empreinte s'est prise sur le document privé de son enveloppe
 * datée (`connectors/empreinte-document.js`).
 *
 * Lot 46 : cette empreinte-là ne tenait pas non plus. Le 22/08/2026, les trois
 * mêmes justificatifs sont revenus sous une TAILLE différente : SNCF tamponne
 * la date d'édition DANS la page (« Paris, le 20/08/2026 » → « Paris, le
 * 22/08/2026 » — seule ligne du texte qui change, mesurée sur les paires
 * réelles). Elle vit dans un flux compressé : aucun retrait de champ nommé ne
 * peut l'atteindre.
 *
 * L'identifiant vient donc de ce que le document DIT : le code « Dossier
 * voyage » imprimé sur le justificatif (`connectors/identite-voyage.js`, qui
 * porte la mesure). Un justificatif dont le dossier ne se lit pas retombe sur
 * l'empreinte du lot 44 : le doublon possible — rattrapable —, jamais la
 * confusion de deux documents.
 */
function remoteIdPour(buffer) {
  return identite.remoteIdSncfConnect(buffer)
    || empreinte.empreinteStable(buffer, { prefixe: ID });
}

/**
 * Le suffixe du nom de fichier : le code du dossier quand l'identifiant est
 * métier (`sncf-connect-K7M2P9` → `K7M2P9`), la fin de l'empreinte sinon —
 * la forme des noms déjà déposés.
 */
function suffixeDeFichier(remoteId) {
  return remoteId.startsWith(`${ID}-`) ? remoteId.slice(ID.length + 1) : remoteId.slice(-8);
}

const RAPPEL_ACHAT =
  'Le justificatif d\'ACHAT (celui qui fait office de facture) n\'est pas téléchargeable : '
  + 'SNCF l\'envoie par e-mail. Pour l\'obtenir : SNCF Connect → Mes voyages → le voyage → '
  + '« Vos justificatifs » → « Obtenir le justificatif par e-mail ». crabe ne déclenche '
  + 'jamais cet envoi à votre place.';

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, et l'onglet des voyages répond. */
async function test(config, ctx = {}) {
  const log = ctx.log || (() => {});
  return authSncf.surLeProfil({ id: ID, nom: NOM, ctx, urlDepart: URL_VOYAGES }, async (page) => {
    // La session d'abord : une page déconnectée n'a pas d'onglet à chercher.
    if (await paraitDeconnecte(page)) {
      throw authSncf.erreurSessionExpiree(NOM, 'la page des voyages propose « Se connecter »');
    }
    const ongletTrouve = await ouvrirOngletPasses(page);
    await page.waitForTimeout(2_000);
    const voyages = ongletTrouve ? await compterVoyages(page) : 0;
    if (!ongletTrouve) await journaliserPage(page, log, 'onglet « Passés » introuvable');
    return {
      ok: true,
      accountId: null,
      invoiceCount: voyages,
      message: ongletTrouve
        ? `Connexion valide — ${voyages} voyage(s) dans l'onglet Passés. ${RAPPEL_ACHAT}`
        : 'Connexion valide, mais l\'onglet « Passés » n\'a pas été reconnu — le journal '
          + 'décrit ce que la page montrait. Signalez-le.',
    };
  });
}

/** Récupère les justificatifs de voyage de TOUS les trajets passés. */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return authSncf.surLeProfil({ id: ID, nom: NOM, ctx, urlDepart: URL_VOYAGES }, async (page) => {
    // La session d'abord (mesuré le 18/08/2026) : la version déconnectée de la
    // page n'a pas d'onglet « Passés », et le dire en ces termes envoyait
    // chercher un défaut de reconnaissance là où il fallait se reconnecter.
    if (await paraitDeconnecte(page)) {
      throw authSncf.erreurSessionExpiree(NOM, 'la page des voyages propose « Se connecter »');
    }
    if (!(await ouvrirOngletPasses(page))) {
      await journaliserPage(page, log, 'onglet « Passés » introuvable');
      throw new Error(
        `${NOM} a bien ouvert vos voyages, mais l'onglet « Passés » n'a pas été reconnu : `
          + 'aucun justificatif n\'a pu être cherché. Le journal décrit la page — signalez-le.'
      );
    }
    await page.waitForTimeout(2_000);

    // L'onglet EN ENTIER : défilement ou « voir plus », jusqu'à stabilité.
    const voyages = await deroulerToutLOnglet(page, log);

    // La preuve exigée par le socle (lot 31) : la page des voyages est rendue
    // (ni mur, ni écran d'identification — vérifiés par surLeProfil), l'onglet
    // « Passés » existe et sa liste a été déroulée puis comptée.
    ctx.preuveDeListe?.({
      session: 'espace « Mes voyages » rendu, onglet « Passés » ouvert',
      liste: 'liste des voyages passés de SNCF Connect',
      elements: voyages,
    });

    const invoices = [];
    let sansPanneau = 0;
    // Le compte qui dit la vérité du plafond (lot 45) : combien de voyages
    // OFFRENT un téléchargement direct, et combien ne proposent leur
    // justificatif que par envoi d'e-mail — que crabe ne déclenche jamais.
    // Sans ces deux nombres, « 5 récupérés sur 11 voyages » ressemble à une
    // panne alors que 5 est le plafond réel.
    let voyagesTelechargeables = 0;
    let voyagesEmailSeul = 0;

    for (let rang = 0; rang < voyages; rang++) {
      // La liste est rejouée à chaque tour : le détail s'ouvre sur la même
      // adresse pour tous les voyages, revenir en arrière re-peint l'onglet.
      if (rang > 0) {
        await page.goto(URL_VOYAGES, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(2_000);
        await authSncf.fermerBandeauCookies(page, log);
        if (!(await ouvrirOngletPasses(page))) break;
        await page.waitForTimeout(1_500);
        await deroulerToutLOnglet(page, () => {});
      }

      const ouvert = await page.evaluate(({ motif, cible }) => {
        const re = new RegExp(motif, 'i');
        const boutons = [...document.querySelectorAll('button, a')]
          .filter((el) => re.test((el.innerText || '').trim()));
        if (boutons[cible]) {
          boutons[cible].click();
          return true;
        }
        return false;
      }, { motif: MOTIF_DETAIL.source, cible: rang }).catch(() => false);
      if (!ouvert) continue;

      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2_500);

      const issuedOn = await dateDuVoyage(page);
      const panneau = await releverJustificatifs(page);
      if (!panneau.ouvert) {
        sansPanneau++;
        // Ce que la page du voyage montrait à la place du panneau — pour que
        // « introuvable » soit un fait décrit, pas un mystère (lot 38).
        await journaliserPage(page, log, `voyage ${rang + 1} : panneau « Vos justificatifs » introuvable`);
        continue;
      }
      if (panneau.telechargements > 0) {
        voyagesTelechargeables++;
        if (panneau.clicSupplementaire) {
          log(
            `${ID} : voyage ${rang + 1} — le téléchargement est apparu après le clic sur `
              + '« Accéder à vos justificatifs » (le chemin mesuré la nuit du 20/08/2026).'
          );
        }
      } else if (panneau.parEmail > 0) {
        voyagesEmailSeul++;
      }

      // Le « 0 sur 11 » du 18/08/2026, instrumenté : un voyage qui n'offre
      // AUCUN téléchargement décrit ce que son panneau proposait réellement.
      // La prochaine exécution répondra « le bouton de téléchargement
      // existe-t-il encore ? » sur des faits.
      if (panneau.telechargements === 0) {
        log(
          `${ID} : voyage ${rang + 1} — panneau « Vos justificatifs » ouvert, aucun déclencheur `
            + `de téléchargement${panneau.clicSupplementaire
              ? ' (même après le clic sur « Accéder à vos justificatifs »)' : ''}, `
            + `${panneau.parEmail} bouton(s) d'envoi par e-mail. `
            + `Boutons visibles (${panneau.perimetre || 'périmètre inconnu'}) : `
            + `${decrireDeclencheurs(panneau.libelles)}.`
        );
      }

      for (let doc = 0; doc < panneau.telechargements; doc++) {
        const obtenu = await telechargerJustificatif(page, doc);
        if (!obtenu.ok) {
          // Le lot 41 disait « un téléchargement n'a pas abouti, on continue »
          // et s'arrêtait là. Depuis le lot 42, le journal DIT quel bouton, ce
          // qui a été tenté, et ce qui a manqué — de quoi corriger sur des
          // faits au lot suivant.
          log(
            `${ID} : voyage ${rang + 1} — le téléchargement n'a pas abouti. `
              + `Déclencheur : « ${obtenu.libelle} ». Tenté : ${obtenu.tentative}. `
              + `Grief : ${obtenu.grief}. On continue avec les voyages suivants.`
          );
          continue;
        }

        const remoteId = remoteIdPour(obtenu.buffer);
        if (connus.has(remoteId)) continue;
        connus.add(remoteId);

        // La date d'émission : « votre commande e-billet du JJ/MM/AAAA »,
        // imprimée sur le justificatif — la seule date COMPLÈTE et stable du
        // document (les heures des trajets n'ont pas d'année, et « Paris,
        // le … » est la date d'édition, qui change à chaque téléchargement).
        // La date lue sur la page du voyage reste le second recours.
        const dateEmission = identite.identiteSncfConnect(obtenu.buffer).commandeDu || issuedOn;

        invoices.push({
          remoteId,
          filename: `${ID}_justificatif-voyage_${dateEmission || 'date-inconnue'}_${suffixeDeFichier(remoteId)}.pdf`,
          issuedOn: dateEmission,
          buffer: obtenu.buffer,
        });
        await page.waitForTimeout(PAUSE_DOCUMENT_MS);
      }
    }

    if (sansPanneau) {
      log(`${ID} : ${sansPanneau} voyage(s) sans panneau « Vos justificatifs » reconnu.`);
    }
    // ─── La vérité du plafond, dite sans laisser croire à une panne (lot 45) ──
    //
    // Mesuré : 5 voyages sur 11 offrent un téléchargement direct. Les autres ne
    // proposent leur justificatif que par envoi d'e-mail — et crabe ne clique
    // jamais un bouton d'envoi d'e-mail : ce geste appartient à l'utilisateur.
    // « 5 sur 11 » sans ces phrases ressemblerait à six échecs.
    if (voyagesEmailSeul) {
      log(
        `${ID} : ${voyagesEmailSeul} voyage(s) sur ${voyages} ne proposent leur justificatif que `
          + 'par envoi d\'e-mail — ce n\'est pas une panne : crabe ne déclenche jamais un envoi '
          + 'd\'e-mail à votre place. ' + RAPPEL_ACHAT
      );
    }
    log(
      `${ID} : ${invoices.length} justificatif(s) de voyage récupéré(s) — `
        + `${voyagesTelechargeables} voyage(s) sur ${voyages} offrent le téléchargement direct, `
        + 'et c\'est le plafond réel de ce service.'
    );

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  paraitDeconnecte,
  MOTIF_ENVOI_EMAIL,
  MOTIF_TELECHARGER,
  MOTIF_ACCEDER,
  releverJustificatifs,
  cliquerAccederAuxJustificatifs,
  MOTIF_ONGLET_PASSES,
  MOTIF_DETAIL,
  MOTIF_JUSTIFICATIFS,
  decrireDeclencheurs,
  telechargerJustificatif,
  lireDocumentDeLOnglet,
  pourLeJournal,
  adressePourLeJournal,
  LIRE_PANNEAU,
  remoteIdPour,
  suffixeDeFichier,
  RAPPEL_ACHAT,
};
