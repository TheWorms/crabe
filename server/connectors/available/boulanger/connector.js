'use strict';

/**
 * Connecteur Boulanger — le premier profil marchand qui RÉCUPÈRE (lot 50).
 *
 * ─── D'où vient ce connecteur ────────────────────────────────────────────────
 *
 * Ébauche au lot 47 (reconnaissance anonyme non concluante : Akamai devant,
 * coquille d'application servie à tout le monde), preuve sur fenêtre au lot 48
 * (le contrôle headless recevait 404, cookies valides compris), adresse et
 * marqueurs corrigés au lot 49 (les commandes passées vivent sur
 * `/account/my-orders/finished`, chacune est un bloc `class="order"` au `<h3>`
 * en « N° F » suivi de chiffres). Le lot 50 écrit le parcours des documents.
 *
 * ─── Les deux pièges MESURÉS du parcours (23/08/2026) ────────────────────────
 *
 *   1. le bouton de facture est un élément personnalisé `<bl-button
 *      arialabel="Télécharger la facture de la commande numéro F…">` — ni un
 *      lien ni un `<button>` : ce que son clic déclenche n'est pas écrit dans
 *      la page. Le module partagé `clic-document` guette les trois voies
 *      possibles (téléchargement, nouvel onglet, réponse PDF) et dit laquelle
 *      a servi ;
 *   2. certaines commandes portent « Votre facture sera disponible à la
 *      délivrance de votre commande » : la facture N'EXISTE PAS ENCORE. Ce
 *      n'est pas une panne — le journal le dit dans les mots de l'utilisateur
 *      et la récupération continue sur les autres commandes.
 *
 * ─── L'ancre d'idempotence ───────────────────────────────────────────────────
 *
 * Le `remote_id` s'ancre sur le NUMÉRO DE COMMANDE lu sur la page — jamais sur
 * une empreinte du document : c'est la leçon OUIGO du lot 46, un site qui
 * regénère ses PDF change leurs octets sans changer ce qu'ils disent. Deux
 * passages sur la même commande n'écrivent qu'une ligne, et le second ne
 * clique même pas.
 */

const profilMarchand = require('../../profil-marchand');
const clicDocument = require('../../clic-document');
const documentsDePage = require('../../documents-de-page');

const ID = 'boulanger';
const NOM = 'Boulanger';
// ⚠ `/account/my-orders/in-progress` était l'erreur du lot 47-48 : ce sont les
// commandes EN COURS, vides pour un compte sans commande ouverte. Les
// commandes passées vivent sur `finished` — mesuré le 23/08/2026 sur le vrai
// compte, page affichée sous les yeux de l'utilisateur.
const URL_COMMANDES = 'https://www.boulanger.com/account/my-orders/finished';
const CHEMIN_LISTE = /\/account\/my-orders\/finished/i;

/**
 * Relevés sur la vraie page des commandes passées (23/08/2026) : chaque
 * commande est un bloc `class="order"` dont le `<h3>` porte « N° F » suivi de
 * chiffres — motifs calibrés sur la FORME, jamais sur une valeur réelle. Ces
 * marqueurs ne sont servis qu'à un compte connecté : ils valent preuve là où
 * la coquille d'application, servie à tout le monde, ne prouvait rien.
 */
const SELECTEUR_REPERE = '.order';
const MOTIF_REPERE = /n[°o]\s*F\d+/i;
const MARQUEURS_MESURES = [
  { selecteur: '.order' },
  { selecteur: 'h3', texte: 'n[°o]\\s*F\\d+' },
];

/**
 * Le bouton de facture, reconnu à son `arialabel` relevé (« Télécharger la
 * facture de la commande numéro F… ») ; et la commande dont la facture
 * n'existe pas encore, reconnue à sa phrase relevée mot pour mot.
 */
const MOTIF_BOUTON_FACTURE = /t[ée]l[ée]charger la facture/i;
const MOTIF_FACTURE_A_VENIR = /disponible [àa] la d[ée]livrance/i;
/**
 * Le numéro de commande dans le `<h3>` : « F » puis des chiffres — et
 * PARFOIS deux lettres au milieu. Mesuré sur la vraie page le 23/08/2026
 * (sonde à chiffres masqués) : trois formes coexistent, `F##########`,
 * `F###ML#####` et `F###CX#####`. Le premier motif (`F` + chiffres seuls)
 * déclarait deux commandes sur cinq « sans numéro lisible » et les privait
 * de récupération.
 */
const MOTIF_NUMERO = /\bF\d[A-Z\d]{4,}\b/i;

/** `/connexion` relevé sur le site, plus le motif générique en filet. */
function estPageAuthentification(url) {
  return profilMarchand.estPageAuthentification(url);
}

function erreurPageInconnue(raison) {
  return new Error(
    `${NOM} a affiché une page qui n'est ni vos commandes ni un espace connecté (${raison}) : `
      + 'impossible de dire s\'il y a des documents. Rouvrez la connexion depuis la fiche du '
      + 'service, puis relancez la récupération.'
  );
}

/** L'ossature commune de `test` et `fetchInvoices` : atteindre et juger. */
async function surLaListe(ctx, fn) {
  return profilMarchand.surLeProfil(
    { id: ID, nom: NOM, ctx, urlDepart: URL_COMMANDES, estAuthentification: estPageAuthentification },
    async (page, context) => {
      const { vue, etat } = await profilMarchand.jugerLaListe(page, {
        cheminListe: CHEMIN_LISTE,
        estAuthentification: estPageAuthentification,
        // La redirection des anonymes n'a PAS pu être mesurée (coquille
        // identique pour tous, témoin compris) : une preuve DANS la page est
        // exigée — les marqueurs relevés sur le vrai compte (lot 49), le lien
        // de déconnexion générique en filet.
        redirigeLesAnonymes: false,
        marqueursMesures: MARQUEURS_MESURES,
        selecteurRepere: SELECTEUR_REPERE,
        motifRepere: MOTIF_REPERE,
      });
      if (!etat.servie) {
        (ctx.log || (() => {}))(`${ID} : ${etat.raison}.`);
        // Le profil existe (surLeProfil l'a vérifié) : une page qui renvoie à
        // l'authentification est un renvoi MALGRÉ session — dire « expirée ou
        // jamais ouverte » à quelqu'un qui vient de se connecter était le
        // mensonge mesuré le 23/08/2026 (lot 50).
        if (etat.sessionAbsente) throw profilMarchand.erreurRenvoiVersAuthentification(NOM, etat.raison);
        throw erreurPageInconnue(etat.raison);
      }
      return fn(etat, vue, page, context);
    }
  );
}

// ---------------------------------------------------------------------------
// La lecture de la liste : chaque bloc `.order`, ramassé en une passe
// ---------------------------------------------------------------------------

/**
 * Ce que chaque commande MONTRE : son numéro (le `<h3>` « N° F… »), son texte
 * (où vit la date de commande), la présence du bouton de facture, et la phrase
 * « facture à venir » le cas échéant. Le numéro sert d'ancre d'idempotence en
 * base et le texte sert à lire la date — aucune de ces valeurs ne part au
 * journal.
 */
async function lireCommandes(page) {
  return page.evaluate(({ selOrder, motifNumero, motifBouton, motifAttente }) => {
    const reNumero = new RegExp(motifNumero, 'i');
    const reBouton = new RegExp(motifBouton, 'i');
    const reAttente = new RegExp(motifAttente, 'i');
    const libelleBouton = (b) =>
      b.getAttribute('arialabel') || b.getAttribute('aria-label') || b.innerText || '';
    return [...document.querySelectorAll(selOrder)].map((bloc) => {
      const texte = (bloc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      // Le numéro vit dans le <h3> du bloc (relevé du 23/08/2026) ; le texte
      // entier du bloc reste en filet si la structure bouge d'un cran.
      const enTetes = [...bloc.querySelectorAll('h3')]
        .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim());
      const porteur = enTetes.find((t) => reNumero.test(t)) || texte;
      const numero = (reNumero.exec(porteur) || [null])[0];
      // Le bouton de facture est un élément personnalisé <bl-button> : ni un
      // lien ni un <button> — on le reconnaît à son libellé d'accessibilité.
      const boutonFacture = [...bloc.querySelectorAll('bl-button, button, [role="button"]')]
        .some((b) => reBouton.test(libelleBouton(b)));
      return {
        numero: numero ? numero.toUpperCase() : null,
        texte,
        boutonFacture,
        factureAVenir: reAttente.test(texte),
      };
    });
  }, {
    selOrder: SELECTEUR_REPERE,
    motifNumero: MOTIF_NUMERO.source,
    motifBouton: MOTIF_BOUTON_FACTURE.source,
    motifAttente: MOTIF_FACTURE_A_VENIR.source,
  }).catch(() => []);
}

/**
 * Clique le bouton de facture de la n-ième commande.
 *
 * `<bl-button>` est un élément personnalisé : si son shadow DOM abrite un
 * vrai bouton, c'est lui qu'on clique — l'événement, composé, remonte aussi à
 * l'hôte ; sinon l'hôte lui-même. Le clic part DANS la page : un clic
 * Playwright serait jugé sur la géométrie d'un élément dont on ne sait rien.
 */
async function cliquerBoutonFacture(page, rang) {
  return page.evaluate(({ selOrder, motifBouton, cible }) => {
    const reBouton = new RegExp(motifBouton, 'i');
    const bloc = document.querySelectorAll(selOrder)[cible];
    if (!bloc) return false;
    const bouton = [...bloc.querySelectorAll('bl-button, button, [role="button"]')]
      .find((b) => reBouton.test(
        b.getAttribute('arialabel') || b.getAttribute('aria-label') || b.innerText || ''
      ));
    if (!bouton) return false;
    const interne = bouton.shadowRoot ? bouton.shadowRoot.querySelector('button, a') : null;
    (interne || bouton).click();
    return true;
  }, { selOrder: SELECTEUR_REPERE, motifBouton: MOTIF_BOUTON_FACTURE.source, cible: rang })
    .catch(() => false);
}

/** L'identifiant distant : le numéro de commande lu sur la page (lot 46). */
function remoteIdPour(numero) {
  return `${ID}-${String(numero).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// La boîte de choix — une commande peut porter PLUSIEURS factures
// ---------------------------------------------------------------------------

/**
 * MESURÉ le 23/08/2026 par sonde sur le vrai compte : sur certaines commandes
 * (numéro à lettres médianes), le bouton de facture ne télécharge rien — il
 * ouvre une boîte `<section class="popin--container">` listant les factures de
 * la commande, chacune sur un `<bl-button>` au texte « Facture N° » suivi de
 * chiffres (l'arialabel, lui, répète le numéro de COMMANDE : c'est le texte
 * visible qui distingue les entrées). Chaque entrée, cliquée, sert son
 * document. Les sélecteurs génériques de boîte restent en filet.
 */
const SELECTEUR_BOITE_FACTURES = '.popin--container, [role="dialog"], dialog';
const MOTIF_REFERENCE_FACTURE = /n[°o]\s*(\d+)/i;

/** La boîte de factures est-elle à l'écran ? (l'« autre issue » du clic) */
async function boiteDeFacturesVisible(page) {
  return page.evaluate((sel) => {
    const boite = [...document.querySelectorAll(sel)]
      .find((el) => el.offsetWidth || el.offsetHeight);
    return !!boite && /facture/i.test(boite.innerText || '');
  }, SELECTEUR_BOITE_FACTURES).catch(() => false);
}

/** Les entrées de la boîte : rang de clic et référence de facture lue. */
async function lireBoiteDeFactures(page) {
  return page.evaluate(({ selBoite, motifReference }) => {
    const reReference = new RegExp(motifReference, 'i');
    const boite = [...document.querySelectorAll(selBoite)]
      .find((el) => el.offsetWidth || el.offsetHeight);
    if (!boite) return [];
    return [...boite.querySelectorAll('bl-button, button, a, [role="button"]')]
      .map((el, rang) => ({ rang, texte: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
      .filter((e) => /facture/i.test(e.texte))
      .map((e) => ({
        rang: e.rang,
        reference: (reReference.exec(e.texte) || [null, null])[1],
      }));
  }, { selBoite: SELECTEUR_BOITE_FACTURES, motifReference: MOTIF_REFERENCE_FACTURE.source })
    .catch(() => []);
}

/** Clique la n-ième entrée de la boîte — même geste shadow que le bouton. */
async function cliquerFactureDeBoite(page, rang) {
  return page.evaluate(({ selBoite, cible }) => {
    const boite = [...document.querySelectorAll(selBoite)]
      .find((el) => el.offsetWidth || el.offsetHeight);
    if (!boite) return false;
    const entree = [...boite.querySelectorAll('bl-button, button, a, [role="button"]')][cible];
    if (!entree) return false;
    const interne = entree.shadowRoot ? entree.shadowRoot.querySelector('button, a') : null;
    (interne || entree).click();
    return true;
  }, { selBoite: SELECTEUR_BOITE_FACTURES, cible: rang }).catch(() => false);
}

// ---------------------------------------------------------------------------
// Contrat de connecteur
// ---------------------------------------------------------------------------

/** Vérification légère : la session tient, la page des commandes répond. */
async function test(config, ctx = {}) {
  return surLaListe(ctx, async (etat) => ({
    ok: true,
    accountId: null,
    invoiceCount: etat.reperes,
    message:
      `Connexion valide — ${etat.reperes} commande(s) visible(s) sur la page des `
      + `commandes ${NOM}.`,
  }));
}

/**
 * Récupère les factures des commandes passées.
 *
 * Le parcours reste SUR la liste : chaque bloc `.order` porte son propre
 * bouton de facture, aucune page de détail à ouvrir. Après chaque document, si
 * le clic a navigué ailleurs, la liste est rejouée avant la commande suivante.
 */
async function fetchInvoices(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const connus = new Set((ctx.knownRemoteIds || []).map(String));

  return surLaListe(ctx, async (etat, vue, page, context) => {
    // La preuve exigée par le socle (lot 31) : la page des commandes est
    // servie AU COMPTE — marqueurs relevés sur le vrai compte, jamais servis
    // aux anonymes (ce site sert la même coquille à tout le monde, mesuré).
    ctx.preuveDeListe?.({
      session: `page des commandes servie au compte connecté (${etat.raison})`,
      liste: URL_COMMANDES,
      elements: etat.reperes,
    });

    const commandes = await lireCommandes(page);
    log(`${ID} : ${commandes.length} commande(s) lue(s) sur la page `
      + `(sélecteur ${SELECTEUR_REPERE}, relevé du 23/08/2026).`);

    const invoices = [];
    let dejaDeposees = 0;
    let facturesAVenir = 0;
    let sansNumero = 0;
    let sansBouton = 0;

    for (let rang = 0; rang < commandes.length; rang++) {
      const commande = commandes[rang];

      if (!commande.numero) {
        sansNumero++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — son numéro n'a pas pu être lu `
          + 'sur la page, elle est passée pour ne pas risquer un doublon. Signalez-le si cela '
          + 'se répète.');
        continue;
      }

      const remoteId = remoteIdPour(commande.numero);
      if (connus.has(remoteId)) {
        // L'ancre d'idempotence : la commande est déjà déposée, on ne clique
        // même pas — le site regénérerait le document pour rien.
        dejaDeposees++;
        continue;
      }

      if (commande.factureAVenir && !commande.boutonFacture) {
        facturesAVenir++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — sa facture n'existe pas encore `
          + '(« disponible à la délivrance de votre commande », écrit par le site). Ce n\'est '
          + 'pas une panne : elle sera récupérée à un prochain passage, une fois la commande '
          + 'délivrée.');
        continue;
      }
      if (!commande.boutonFacture) {
        sansBouton++;
        log(`${ID} : commande ${rang + 1}/${commandes.length} — aucun bouton « Télécharger la `
          + 'facture » sur son bloc. Rien n\'a été récupéré pour celle-ci ; signalez-le si '
          + 'cela se répète.');
        continue;
      }

      const issuedOn = documentsDePage.dateDepuisTexte(commande.texte);
      const obtenu = await clicDocument.documentDuClic(
        page, context, () => cliquerBoutonFacture(page, rang),
        // Le clic peut ouvrir la boîte de choix au lieu de servir un document
        // (mesuré le 23/08/2026) : la guetter évite d'épuiser le délai devant
        // une boîte déjà ouverte.
        { autreIssue: () => boiteDeFacturesVisible(page) }
      );
      let boiteTraitee = false;

      if (obtenu.ok) {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — facture lue `
          + `(voie mesurée : ${obtenu.voie}, ${obtenu.buffer.length} octets).`);
        connus.add(remoteId);
        invoices.push({
          remoteId,
          filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId }),
          issuedOn,
          buffer: obtenu.buffer,
        });
      } else if (obtenu.autreIssue) {
        // La boîte de choix : cette commande porte PLUSIEURS factures, une
        // entrée chacune. L'identifiant de chaque document est le couple
        // (numéro de commande, référence de facture lue dans la boîte) — deux
        // passages n'écrivent toujours qu'une ligne par facture.
        boiteTraitee = true;
        const entrees = await lireBoiteDeFactures(page);
        log(`${ID} : commande ${rang + 1}/${commandes.length} — le bouton ouvre une boîte de `
          + `choix (mesuré) : ${entrees.length} facture(s) listée(s) pour cette commande.`);
        for (const entree of entrees) {
          const idFacture = `${remoteId}-${entree.reference || entree.rang + 1}`;
          if (connus.has(idFacture)) {
            dejaDeposees++;
            continue;
          }
          const doc = await clicDocument.documentDuClic(
            page, context, () => cliquerFactureDeBoite(page, entree.rang)
          );
          if (!doc.ok) {
            log(`${ID} : commande ${rang + 1}/${commandes.length} — une facture de la boîte `
              + `n'a pas été lue (${doc.grief}). On continue.`);
            continue;
          }
          log(`${ID} : commande ${rang + 1}/${commandes.length} — facture de la boîte lue `
            + `(voie mesurée : ${doc.voie}, ${doc.buffer.length} octets).`);
          connus.add(idFacture);
          invoices.push({
            remoteId: idFacture,
            filename: documentsDePage.nomFichier(ID, { issuedOn, remoteId: idFacture }),
            issuedOn,
            buffer: doc.buffer,
          });
        }
      } else {
        log(`${ID} : commande ${rang + 1}/${commandes.length} — la facture n'a pas été lue `
          + `(${obtenu.grief}). On continue avec les suivantes.`);
        continue;
      }

      // Si le clic a emmené la page ailleurs — ou laissé la boîte de choix
      // ouverte —, la liste se rejoue avant la commande suivante : les rangs
      // comptent sur elle, et une boîte restée à l'écran recouvrirait le
      // prochain bouton.
      const urlCourante = (() => { try { return page.url(); } catch { return ''; } })();
      if (rang + 1 < commandes.length && (boiteTraitee || !CHEMIN_LISTE.test(urlCourante))) {
        log(`${ID} : retour à la liste des commandes avant la suivante.`);
        await page.goto(URL_COMMANDES, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(profilMarchand.DELAI_RENDU_MS).catch(() => {});
        await profilMarchand.fermerBandeauCookies(page, () => {});
      }
    }

    if (dejaDeposees) {
      log(`${ID} : ${dejaDeposees} document(s) déjà déposé(s) — reconnu(s) à leur numéro, `
        + 'rien n\'a été retéléchargé.');
    }
    if (facturesAVenir) {
      log(`${ID} : ${facturesAVenir} commande(s) dont la facture n'est pas encore disponible.`);
    }
    log(`${ID} : ${invoices.length} facture(s) récupérée(s) sur ${commandes.length} commande(s)`
      + `${sansNumero ? `, ${sansNumero} sans numéro lisible` : ''}`
      + `${sansBouton ? `, ${sansBouton} sans bouton de facture` : ''}.`);

    return { accountId: null, invoices };
  });
}

module.exports = {
  test,
  fetchInvoices,
  // exportés pour les tests unitaires
  estPageAuthentification,
  erreurPageInconnue,
  lireCommandes,
  cliquerBoutonFacture,
  boiteDeFacturesVisible,
  lireBoiteDeFactures,
  cliquerFactureDeBoite,
  remoteIdPour,
  SELECTEUR_BOITE_FACTURES,
  MOTIF_REFERENCE_FACTURE,
  URL_COMMANDES,
  CHEMIN_LISTE,
  SELECTEUR_REPERE,
  MOTIF_REPERE,
  MARQUEURS_MESURES,
  MOTIF_BOUTON_FACTURE,
  MOTIF_FACTURE_A_VENIR,
  MOTIF_NUMERO,
};
