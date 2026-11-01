'use strict';

/**
 * Le contrôle d'une session capturée PAR REJEU : l'état rejoué dans un
 * Chromium headless neuf, la page de contrôle déclarée par le manifeste
 * (`remoteLogin.verifyUrl`) chargée, puis jugée — confirmée, refusée, non
 * concluante, ou sans contrôle.
 *
 * Écrit pour la fenêtre de connexion (lots 14, 37, 40, 68, 73 :
 * `remote-browser.js`, `essayerSession`), sorti ici à la 0.2.8 pour servir
 * aussi la visite d'entretien (`server/entretien-sessions.js`) : un seul
 * jugement, pas deux politiques. Les cas qui ne rejouent rien (`rejeuUnique`,
 * `preuveSurFenetre`) restent dans la fenêtre : ils lisent la fenêtre vivante.
 *
 * `runtime` : `requirePlaywright` et `log`, injectables (les essais de la
 * fenêtre passent les leurs). `garderEtat` : sur une session confirmée, le
 * verdict porte `etat`, l'état du navigateur tel que le site l'a laissé.
 * `lancement` : les options de `chromium.launch` (par défaut, headless nu).
 */

const identity = require('./browser-identity');
const preuve = require('./preuve-connexion');
const releve = require('./releve-navigation');

/**
 * Patience du contrôle de session (§6 du lot 14), joué dans un Chromium à part.
 *
 * Court : ce n'est pas un parcours, c'est une page à charger et deux
 * sélecteurs à compter. Un portail qui n'a pas répondu en quinze secondes n'en
 * dira pas plus à la trentième, et l'utilisateur attend devant sa fenêtre.
 */
const CONTROLE_SESSION_TIMEOUT_MS = 15_000;

const runtimeParDefaut = {
  requirePlaywright: null,
  log: (level, message, connectorId = null) => require('../applog')[level](
    connectorId ? `controle-session:${connectorId}` : 'controle-session',
    message
  ),
};

/**
 * @returns {Promise<{verdict: 'confirmee'|'refusee'|'non-concluante'|'sans-controle',
 *                    code?: string, raison?: string, preuve?: string, etat?: object}>}
 */
async function rejouer(session, state, { runtime = runtimeParDefaut, garderEtat = false, lancement = null } = {}) {
  const { exigerAdresseVisitable } = require('../remote-browser');
  if (!session.verifyUrl) {
    return {
      verdict: 'sans-controle',
      code: 'sans-controle',
      raison: 'aucune page de contrôle déclarée par le connecteur',
      preuve: 'aucune page de contrôle déclarée par le connecteur',
    };
  }

  // ⚠ `findPlaywright()` rend un BOOLÉEN — test de présence écrit pour
  // `checkPrerequisites`, pas un chargeur de module. `true?.chromium` vaut
  // `undefined`, la condition passait, et le contrôle se sautait. À chaque
  // fois : `runtime.requirePlaywright` n'est défini nulle part, la branche de
  // gauche n'était jamais prise. Conséquence : aucune session capturée n'a
  // jamais été essayée avant d'être enregistrée — exactement la panne que ce
  // contrôle devait empêcher (huit cookies à 03:07:16, session morte à
  // 03:07:19, lot 12).
  let playwright = null;
  try {
    playwright = runtime.requirePlaywright ? runtime.requirePlaywright() : require('playwright');
  } catch {
    // Playwright réellement absent : le navigateur distant n'aurait pas pu
    // s'ouvrir, on n'en serait pas là. On laisse passer plutôt que de perdre
    // une connexion que l'utilisateur vient d'établir à la main.
    playwright = null;
  }
  if (!playwright?.chromium) {
    return {
      verdict: 'sans-controle',
      code: 'sans-controle',
      raison: 'l\'outil de contrôle est indisponible, rien ne peut être prouvé',
      preuve: 'outil de contrôle indisponible, contrôle sauté',
    };
  }

  let navigateur = null;
  let contexte = null;
  // 0.2.8 : la visite d'entretien emporte l'état du navigateur prolongé par
  // le site — seulement sur une session confirmée.
  //
  // ⚠ `return await`, jamais `return` seul (0.2.14) : sans `await`, le
  // `finally` ci-dessous fermait le navigateur AVANT que l'état soit lu, et
  // chaque visite confirmée finissait en « Protocol error » — la session
  // prolongée n'était jamais enregistrée.
  const confirmee = async (verdict) => (garderEtat && contexte
    ? { ...verdict, etat: await contexte.storageState() }
    : verdict);
  try {
    // `lancement` : la visite d'entretien ouvre le navigateur comme une
    // récupération (`identity.optionsLancement`) ; la fenêtre garde le sien.
    navigateur = await playwright.chromium.launch(lancement || { headless: true });
    contexte = await navigateur.newContext(
      identity.optionsContexte({ storageState: state })
    );
    const page = await contexte.newPage();
    page.setDefaultTimeout(CONTROLE_SESSION_TIMEOUT_MS);

    // La garde du lot 77 : une adresse de contrôle réduite à un `null` ne se
    // visite pas — on le dit comme un défaut de configuration, jamais comme
    // un verdict de session (elle atteint ici après le filtre `!verifyUrl`,
    // donc elle est non vide : reste à écarter un `/null` littéral).
    exigerAdresseVisitable(session.verifyUrl, session.connectorName);
    const reponse = await page.goto(session.verifyUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // ─── Le code de réponse est lu (lot 37) ──────────────────────────────
    //
    // L'erreur du 18/08/2026, à la lettre : la page de contrôle SoundCloud
    // répondait 404, et le contrôle — qui ne regardait que le contenu —
    // concluait « la page répond et n'est pas un formulaire de connexion ».
    // Une adresse morte ou un site en panne ne disent RIEN de la session :
    // verdict non concluant, jamais acceptation.
    const statut = typeof reponse?.status === 'function' ? reponse.status() : null;
    if (statut === 404 || (typeof statut === 'number' && statut >= 500)) {
      return {
        verdict: 'non-concluante',
        code: statut === 404 ? 'adresse-morte' : 'erreur-site',
        raison: statut === 404
          ? 'la page de contrôle n\'existe pas à cette adresse (réponse 404) — '
            + 'rien ne peut être conclu sur la session'
          : `le site a répondu par une erreur (réponse ${statut}) — `
            + 'rien ne peut être conclu sur la session',
      };
    }

    // ─── L'URL a tenu (lot 40) ───────────────────────────────────────────
    //
    // Certains sites n'affichent aucun marqueur générique de compte mais
    // REDIRIGENT les anonymes hors de la page de contrôle : y rester est
    // alors LE signe de session. Mesuré le 14/08/2026 sur OUIGO — hors
    // session, la page des réservations passées renvoie à l'accueil. Le
    // connecteur le déclare (`verifyUrlTient`), et le jugement reste
    // prudent : une page vide ou un formulaire de connexion resté sur
    // place ne prouvent rien — ces cas retombent sur le contrôle générique
    // ci-dessous, qui les refuse ou ne conclut pas.
    // Un 403 qui GARDE l'adresse n'est pas une page qui « tient » : c'est la
    // signature des murs anti-robot qui habillent leur refus en page
    // d'excuse sans rediriger (Darty, « FNAC DARTY - Maintenance », mesuré
    // au lot 47). Le raccourci « l'URL a tenu » exige une vraie réponse.
    // ─── L'espace client vit sur un AUTRE domaine (lot 73) ───────────────
    //
    // Mesuré sur Atma le 08/09/2026 : un connecté qui demande
    // `atmakitchenware.fr/account` est renvoyé vers
    // `shopify.com/<boutique>/account/orders` — les comptes clients Shopify
    // sont hébergés sur shopify.com, pas sur la boutique. Le lot 68 jugerait
    // ce renvoi « vers un autre site » et refuserait (garde `memeSite`).
    // Quand le connecteur DÉCLARE ce domaine (`domaineEspaceClient`), un
    // renvoi VERS lui est la preuve — à condition que ce ne soit pas un
    // écran de connexion (l'anonyme, lui, finit sur
    // `shopify.com/authentication/…/login`, capté par estUrlAuthentification)
    // et que la page ne soit pas vide. Le statut ≥ 400 est déjà écarté par la
    // garde de cette branche : une session morte reçoit un 401/403, jamais
    // une page d'espace client.
    if (session.domaineEspaceClient && (statut === null || statut < 400)) {
      const urlFinale = String(page.url() || '');
      if (preuve.surDomaine(urlFinale, session.domaineEspaceClient)
        && !preuve.estUrlAuthentification(urlFinale)) {
        let corpsVide = false;
        try {
          corpsVide = Boolean(await page.evaluate(
            () => !document.body || !document.body.innerText.trim()
          ));
        } catch {
          corpsVide = false; // illisible n'est pas vide : on ne conclut pas ici
        }
        if (!corpsVide) {
          return await confirmee({
            verdict: 'confirmee',
            preuve: `${session.connectorName} : connexion confirmée — la page de contrôle a `
              + `renvoyé vers l'espace client hébergé sur ${session.domaineEspaceClient} `
              + `(URL finale ${releve.adresseMasquee(urlFinale)}), hors écran de connexion, or ce domaine ne sert `
              + `une page de compte qu'à une session établie `
              + `(${(state.cookies || []).length} cookie(s)).`,
          });
        }
      }
      // Hors du domaine déclaré, sur un écran de connexion, ou page vide : on
      // ne conclut pas ici — les gardes ci-dessous (tenue, renvoi, mur,
      // contrôle générique) tranchent, et refusent un renvoi vers la
      // connexion Shopify.
    }

    if (session.verifyUrlTient && (statut === null || statut < 400)) {
      const urlFinale = String(page.url() || '');
      // La tenue se juge SANS le fragment de l'adresse finale (lot 68) : un
      // fragment n'est pas un chemin. Voir `preuve.adresseTenue`.
      if (!preuve.adresseTenue(urlFinale, session.verifyUrl)) {
        // Être ramené AILLEURS SUR LE SITE n'est pas être éconduit quand le
        // manifeste atteste que le site éconduit vers sa page de connexion :
        // le renvoi mesuré tranche plus bas, pas la tenue (lot 68).
        if (session.renvoiAnonyme !== 'connexion') {
          return {
            verdict: 'refusee',
            code: 'refus',
            raison: `la page de contrôle a renvoyé vers ${releve.adresseMasquee(urlFinale)} — c'est ainsi que `
              + 'le site éconduit les visiteurs sans session : session non établie',
            // Lot 110 : l'adresse masquée, pour dire la raison à l'écran.
            adresse: releve.adresseMasquee(urlFinale),
          };
        }
      } else {
        let corpsVide = false;
        try {
          corpsVide = Boolean(await page.evaluate(
            () => !document.body || !document.body.innerText.trim()
          ));
        } catch {
          corpsVide = false; // illisible n'est pas vide : on ne conclut pas ici
        }
        const tenue = await preuve.verifier(page, { cookies: (state.cookies || []).length });
        if (!corpsVide && !tenue.surFormulaire) {
          return await confirmee({
            verdict: 'confirmee',
            preuve: `${session.connectorName} : connexion confirmée — l'adresse de contrôle `
              + `${releve.adresseMasquee(session.verifyUrl)} a tenu, or le site en redirige les anonymes `
              + `(${(state.cookies || []).length} cookie(s)).`,
          });
        }
      }
    }

    const resultat = await preuve.verifier(page, { cookies: (state.cookies || []).length });
    if (resultat.confirme) {
      return await confirmee({
        verdict: 'confirmee',
        preuve: preuve.ligneConfirmee(session.connectorName, resultat),
      });
    }

    // ─── Le refus certain : la page renvoie au formulaire ────────────────
    //
    // C'est EXACTEMENT ce qui s'est passé le 11/08/2026 — le connecteur a
    // signalé « redirection vers la page de connexion » trois secondes après
    // la capture. Aucun doute possible : la session ne vaut rien.
    if (resultat.surFormulaire) {
      return {
        verdict: 'refusee',
        code: 'refus',
        raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
      };
    }

    // ─── La page vide : rien à juger ─────────────────────────────────────
    //
    // Une page sans le moindre texte n'est ni un espace connecté ni un
    // formulaire : le site n'a rien montré, on ne conclut rien. Une page
    // illisible (navigation en cours) n'est pas déclarée vide pour autant.
    let pageVide = false;
    try {
      pageVide = Boolean(await page.evaluate(
        () => !document.body || !document.body.innerText.trim()
      ));
    } catch {
      pageVide = false;
    }
    if (pageVide) {
      return {
        verdict: 'non-concluante',
        code: 'page-vide',
        raison: 'la page de contrôle s\'est affichée vide — rien ne permet de trancher',
      };
    }

    // ─── Le 403 sans preuve ni formulaire : un mur, pas un verdict ─────────
    //
    // Le site a répondu, mais en refusant : c'est presque toujours une garde
    // anti-robot qui juge le contrôleur headless, pas la session. Conclure
    // « refusée » accuserait l'utilisateur ; conclure « confirmée » (le cas
    // verifyUrlTient, écarté plus haut) enregistrerait n'importe quoi. On ne
    // sait pas, et on le dit.
    if (statut === 403) {
      return {
        verdict: 'non-concluante',
        code: 'mur',
        raison: 'le site a refusé de montrer la page de contrôle (réponse 403, '
          + 'probablement une vérification de sécurité) — rien ne peut être conclu',
      };
    }

    // ─── Le renvoi des anonymes est la preuve (lot 68) ───────────────────
    //
    // Arrivé ici, la page a répondu (< 400), n'est ni vide, ni un formulaire,
    // ni un mur — et ne porte aucun marqueur générique. Quand le manifeste
    // ATTESTE que le site renvoie tout anonyme vers sa page de connexion
    // (`renvoiAnonyme: "connexion"`, mesuré — claude.ai : hors session,
    // `/settings/billing` renvoie vers `/login?from=logout`, relevé le
    // 13/08/2026 et revu dans les journaux du 28/08/2026), rester sur le
    // site sans y être renvoyé EST la preuve — même quand l'application a
    // réécrit le chemin en gardant la cible en fragment. Le principe du
    // lot 67 (Free Mobile), déclaré au manifeste au lieu d'être recodé
    // connecteur par connecteur. Un départ vers un AUTRE site, lui, ne
    // prouve rien : `memeSite` ferme cette porte.
    if (session.renvoiAnonyme === 'connexion'
      && (statut === null || statut < 400)
      && preuve.memeSite(page.url(), session.verifyUrl)) {
      return await confirmee({
        verdict: 'confirmee',
        preuve: `${session.connectorName} : connexion confirmée — la page est restée sur le `
          + `site (URL finale ${releve.adresseMasquee(resultat.url)}) sans renvoi vers la connexion, or c'est ainsi `
          + `que ce site éconduit les visiteurs sans session — comportement mesuré `
          + `(${(state.cookies || []).length} cookie(s)).`,
      });
    }

    // ─── Page valide, aucun marqueur : la preuve MANQUE ──────────────────
    //
    // Jusqu'au lot 37, ce cas n'était un refus que si le manifeste déclarait
    // `verifyStrict` ; sinon la session était « acceptée » avec un simple
    // avertissement au journal. C'est ce chemin qui a enregistré la session
    // SoundCloud morte du 18/08/2026. Il n'existe plus : une page qui répond
    // sans montrer de compte connecté ne prouve pas la session.
    //
    // Mais depuis le lot 68, ce cas porte son propre code : `sans-preuve`.
    // La session n'est PAS forcément mauvaise — Anthropic, 28/08/2026 :
    // trois refus d'une session valide, et un message qui invitait à
    // « finir de se connecter » alors qu'il n'y avait rien à finir. Dire
    // « session non établie » ici serait une supposition, pas une mesure :
    // on dit que la preuve manque, et le message de `save()` dit quoi faire.
    return {
      verdict: 'refusee',
      code: 'sans-preuve',
      raison: preuve.ligneNonConfirmee(session.connectorName, resultat),
    };
  } catch (err) {
    // Un contrôle qui ne peut pas s'exécuter ne conclut RIEN : ni
    // acceptation (l'erreur du 18/08/2026), ni refus net (la session est
    // peut-être bonne). La fenêtre reste ouverte, et le détail technique va
    // au journal — jamais à l'écran.
    runtime.log(
      'warn',
      `Contrôle de session ${session.connectorName} : détail technique — ${err.message}`,
      session.connectorId
    );
    return {
      verdict: 'non-concluante',
      code: 'interrompu',
      raison: 'le contrôle n\'a pas pu s\'exécuter jusqu\'au bout '
        + '(le site n\'a pas répondu, ou la vérification s\'est interrompue)',
    };
  } finally {
    await navigateur?.close?.().catch(() => {});
  }
}

module.exports = { rejouer, CONTROLE_SESSION_TIMEOUT_MS };
