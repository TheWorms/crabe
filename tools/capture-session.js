/**
 * Capture de session de navigateur.
 *
 * ─── À quoi ça sert ─────────────────────────────────────────────────────────
 *
 * Certains portails envoient un code SMS à CHAQUE connexion : Free Mobile, par
 * exemple. Un mot de passe stocké dans crabe n'y suffit pas, et aucun robot ne
 * peut ouvrir la session tout seul. Cet outil vous laisse vous connecter à la
 * main, une fois, puis enregistre l'état de session que crabe rejouera —
 * cookies et stockage local, au format `storageState` de Playwright.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node tools/capture-session.js free-mobile \
 *        https://mobile.free.fr/account/v2/login "Mes factures"
 *
 * Le troisième argument est un MARQUEUR facultatif : un texte présent seulement
 * une fois la connexion aboutie. Depuis le lot 12 il ne BLOQUE plus rien — il
 * accélère la détection quand il tombe juste, et ne fait rien quand il tombe à
 * côté. Chaque boutique a son libellé (« Mes commandes », « Historique de mes
 * commandes », « Vos commandes »…) et on ne peut pas tous les deviner : un
 * marqueur faux faisait attendre dix minutes une connexion pourtant établie.
 *
 * Le critère générique suffit : plus de champ de mot de passe, plus de grille
 * de code, URL hors authentification — le tout confirmé deux fois, à 1,2 s
 * d'intervalle.
 *
 * Produit `sessions/<nom>.json` à la racine du dépôt (dossier ignoré par git).
 * C'est ce fichier que vous déposez dans le champ « session » du connecteur.
 *
 * ─── Repli, depuis le lot 6 ─────────────────────────────────────────────────
 *
 * crabe sait désormais ouvrir ce navigateur LUI-MÊME et l'afficher dans votre
 * onglet : « Se connecter à … » sur la fiche du connecteur, plus aucun fichier
 * à manipuler (voir server/remote-browser.js). Cet outil reste le repli, et il
 * est pleinement fonctionnel : il sert quand les paquets système du navigateur
 * distant manquent, quand le conteneur n'a pas assez de mémoire, ou quand on
 * préfère simplement capturer la session depuis son propre poste.
 *
 * La détection de connexion est partagée avec le navigateur distant
 * (server/connectors/login-detection.js) : une seule heuristique, éprouvée au
 * même endroit, plutôt que deux copies qui divergent.
 *
 * ─── Trois points à ne pas manquer ──────────────────────────────────────────
 *
 * 1. **Cochez « Se souvenir de cet appareil »** pendant la connexion. C'est
 *    cette case, et elle seule, qui fait durer la session six mois plutôt que
 *    quelques heures.
 * 2. **Ce fichier vaut vos identifiants** tant que la session est valide. Ne
 *    le partagez pas, ne le committez pas. Dans crabe il est chiffré avec la
 *    passphrase maîtresse, au même titre qu'un mot de passe.
 * 3. **Free semble n'autoriser qu'une session active à la fois.** Se
 *    reconnecter soi-même à l'espace abonné peut invalider celle de crabe.
 *    Ce point n'a pas été confirmé, mais c'est la cause la plus probable
 *    d'une expiration prématurée.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const detection = require('../server/connectors/login-detection');
const identity = require('../server/connectors/browser-identity');

/**
 * Taille de la fenêtre — 1500×950 depuis le lot 12, contre 1000×760 avant.
 *
 * Plusieurs boutiques ont un bandeau supérieur qui défile avec la page : à
 * 1000 px de large, le lien « connectez-vous » se retrouvait **hors champ**, et
 * il fallait deviner qu'il fallait faire défiler pour le rattraper. C'est le
 * genre de détail qui rend un outil inutilisable sans qu'on sache le dire.
 */
const FENETRE = { width: 1500, height: 950 };

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright est absent : installez-le avec');
  console.error('  npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const [name, startUrl, marqueur] = process.argv.slice(2);

if (!name || !startUrl) {
  console.error('Usage : node tools/capture-session.js <nom> <url-de-connexion> [marqueur]');
  console.error('');
  console.error('Le marqueur est facultatif : un texte présent seulement une fois connecté.');
  console.error('Il accélère la détection quand il tombe juste ; sans lui, le critère générique');
  console.error('suffit (plus de mot de passe, plus de grille de code, URL hors connexion).');
  console.error('');
  console.error('Exemples :');
  console.error('  node tools/capture-session.js free-mobile https://mobile.free.fr/account/v2/login "Mes factures"');
  console.error('  node tools/capture-session.js free https://subscribe.free.fr/login/ "Voir toutes mes factures"');
  process.exit(1);
}

// À la racine du dépôt, pas dans tools/ : la commande documentée se lance
// depuis la racine, et `sessions/` y est ignoré par git.
const OUT_DIR = path.join(__dirname, '..', 'sessions');
const OUT_FILE = path.join(OUT_DIR, `${name}.json`);
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min pour se connecter, largement suffisant
const POLL_MS = 400;

/** Bandeau affiché dans la page elle-même. */
async function overlay(page, texte, variante = 'attente') {
  await page.evaluate(({ texte, variante }) => {
    let el = document.getElementById('__crabe_overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = '__crabe_overlay';
      el.style.cssText = `
        position:fixed; inset:0; z-index:2147483647;
        background:rgba(12,14,18,.92); backdrop-filter:blur(3px);
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        font-family:system-ui,-apple-system,Segoe UI,sans-serif; color:#e9eaec;
      `;
      document.body.appendChild(el);
      const style = document.createElement('style');
      style.textContent = '@keyframes __crabe_spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    const spinner = variante === 'attente'
      ? `<div style="width:44px;height:44px;border:4px solid #3a2620;border-top-color:#e0693a;
           border-radius:50%;animation:__crabe_spin .8s linear infinite;margin-bottom:20px"></div>`
      : `<div style="width:44px;height:44px;border-radius:50%;background:#1a2b22;color:#4caf7d;
           display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:20px">✓</div>`;
    el.innerHTML = `${spinner}<div style="font-size:16px;font-weight:500">${texte}</div>`;
  }, { texte, variante });
}

/**
 * Défilement jusqu'au formulaire et curseur dans le premier champ.
 *
 * Toute la détection de connexion vit dans
 * `server/connectors/login-detection.js`, partagé avec le navigateur distant :
 * étapes d'authentification reconnues au CHEMIN de l'URL (« ?login=94994336 »
 * est un paramètre de ligne, pas une page de connexion), champ de mot de passe
 * encore présent, grille de code à six chiffres — qui n'a ni champ
 * « password » ni « otp » dans son URL — et enfin le marqueur, le seul
 * contrôle réellement fiable.
 */
const cadrerFormulaire = (page) => detection.focusForm(page);

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: [`--window-size=${FENETRE.width},${FENETRE.height}`, '--window-position=60,30'],
  });
  const context = await browser.newContext(
    identity.optionsContexte({ viewport: { width: FENETRE.width - 20, height: FENETRE.height - 60 } })
  );
  const page = await context.newPage();

  try {
    console.log(`\n→ Ouverture de ${startUrl}`);
    console.log('  Connecte-toi dans la fenêtre, jusqu\'au bout :');
    console.log('    1. identifiant + mot de passe');
    console.log('    2. code de validation si demandé');
    console.log('    3. ⚠ COCHE « Se souvenir de cet appareil » — c\'est cette case qui');
    console.log('       détermine combien de temps la session restera valable');
    if (marqueur) {
      console.log(`\n  Détection : le texte « ${marqueur} » confirmera tout de suite ;`);
      console.log('  à défaut, le critère générique prendra le relais.');
    } else {
      console.log('\n  Détection : plus de champ de mot de passe, plus de grille de code,');
      console.log('  URL hors connexion — confirmé deux fois à 1,2 s d\'intervalle.');
    }
    console.log('  La fenêtre se fermera toute seule une fois la connexion confirmée.\n');

    // Le parcours enchaîne plusieurs écrans (mot de passe, puis code de
    // validation). Sans recadrage à chaque étape, la page OTP s'ouvre sur le
    // haut du document et il faut faire défiler à la main.
    page.on('load', () => { cadrerFormulaire(page).catch(() => {}); });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) cadrerFormulaire(page).catch(() => {});
    });

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await cadrerFormulaire(page);

    // --- Attente active de la connexion -----------------------------------
    const debut = Date.now();
    let connecte = false;
    let dernierPoint = 0;
    let derniereSignature = '';

    while (Date.now() - debut < TIMEOUT_MS) {
      // Confirmation : deux lectures espacées, pour éviter un faux positif
      // pendant une redirection intermédiaire.
      const etat = await detection.confirm(page, {
        marker: marqueur,
        // Le marqueur ne BLOQUE plus (lot 12) : il accélère la détection quand
        // il tombe juste, et ne fait rien quand il tombe à côté. Voir le
        // commentaire d'en-tête et connectors/login-detection.js.
        markerRequired: false,
        pause: (ms) => page.waitForTimeout(ms),
      });
      if (etat.ok) { connecte = true; break; }

      // Application monopage : l'écran change sans événement de navigation.
      // On recadre dès que la signature des champs visibles évolue.
      const signature = await detection.fieldSignature(page);
      if (signature && signature !== derniereSignature) {
        derniereSignature = signature;
        await cadrerFormulaire(page);
      }

      const secondes = Math.floor((Date.now() - debut) / 1000);
      if (secondes - dernierPoint >= 10) {
        dernierPoint = secondes;
        process.stdout.write(`  … en attente (${secondes}s)\r`);
      }
      await page.waitForTimeout(POLL_MS);
    }

    if (!connecte) {
      throw new Error('Délai dépassé : connexion non détectée au bout de 10 minutes.');
    }

    console.log('\n→ Connexion détectée, enregistrement…');

    // --- Cookies tardifs ---------------------------------------------------
    // PrestaShop pose des cookies complémentaires JUSTE APRÈS la redirection de
    // fin de connexion. Sans cette pause et ce rechargement, la capture en
    // oublie une partie et la session rejouée échoue en silence — 12 cookies au
    // lieu de 15, puis 403 au téléchargement (voir DELAI_COOKIES_TARDIFS_MS).
    await page.waitForTimeout(detection.DELAI_COOKIES_TARDIFS_MS);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {
      // Un rechargement refusé (page qui redemande un envoi de formulaire, par
      // exemple) n'est pas une raison de perdre la session : la pause seule a
      // déjà fait l'essentiel.
    });
    await page.waitForLoadState('networkidle').catch(() => {});

    await overlay(page, 'Enregistrement des informations…', 'attente').catch(() => {});
    await page.waitForTimeout(500);

    const state = await context.storageState();
    fs.writeFileSync(OUT_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

    await overlay(page, 'Session enregistrée', 'ok').catch(() => {});
    await page.waitForTimeout(800);

    // --- Compte rendu ------------------------------------------------------
    const domaines = [...new Set(state.cookies.map((c) => c.domain))];
    const expirations = state.cookies.map((c) => c.expires).filter((e) => e > 0).sort((a, b) => b - a);

    console.log(`\n✓ Session enregistrée : ${OUT_FILE}`);
    console.log(`  URL finale : ${page.url()}`);
    console.log(`  ${state.cookies.length} cookie(s) · ${domaines.join(', ')}`);
    if (expirations.length) {
      const fin = new Date(expirations[0] * 1000);
      const jours = Math.round((fin - Date.now()) / 86400000);
      console.log(`  valable jusqu'au ${fin.toLocaleDateString('fr-FR')} (~${jours} jours)`);
      if (jours <= 1) {
        console.log('  ⚠ ATTENTION : session valable moins de 24 h — ce portail ne garde');
        console.log('    probablement pas l\'authentification dans les cookies (jeton dans');
        console.log('    l\'URL, par exemple). La capture de session ne sera pas exploitable.');
      }
    } else {
      console.log('  ⚠ aucun cookie persistant — session probablement très courte');
    }
    console.log('\n→ Dans crabe : Store → le connecteur → champ « session », déposez ce fichier.');
    console.log('  ⚠ Ce fichier vaut vos identifiants : ne le partagez pas, ne le committez pas.');
  } catch (err) {
    console.error('\nERREUR :', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
