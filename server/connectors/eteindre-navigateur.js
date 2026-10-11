'use strict';

/**
 * Éteindre le navigateur d'une exécution qu'on vient d'abandonner.
 *
 * ─── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Le lot 67 pose une limite de durée sur les exécutions de connecteur
 * (`scheduler.LIMITE_EXECUTION_MS`). Quand elle tombe, le socle referme la
 * ligne de `run_logs` et rend le verrou — mais la promesse du connecteur, elle,
 * continue de tourner, et **son Chromium avec**. Sans ce module, l'abandon
 * serait un demi-abandon : le verrou logiciel libéré, et un navigateur
 * fantôme toujours vivant sur le profil du compte.
 *
 * ─── La poignée, choisie APRÈS mesure et pas avant ───────────────────────────
 *
 * Le premier candidat était `profil-persistant.navigateurVivant()`, qui lit le
 * lien `SingletonLock` du profil (lot 51). **Mesuré le 27/08/2026 sur le
 * le serveur de production : il ne marche pas ici.** Un `launchPersistentContext` *headless*
 * n'écrit AUCUN fichier `Singleton*` — c'est une machinerie de navigateur
 * visible, et les connecteurs, eux, tournent en invisible :
 *
 *     PREUVE A — SingletonLock = ABSENT (ENOENT)
 *     PREUVE A — navigateurVivant() = false   ← le Chromium tournait pourtant
 *
 * La poignée qui marche, mesurée le même jour, tient en deux faits :
 *
 *   1. **le navigateur de premier rang est un enfant DIRECT de ce processus**
 *      (`PPid` = le pid de node), alors que ses moteurs de rendu ont pour
 *      parent le navigateur lui-même ;
 *   2. **lui seul porte `--user-data-dir`** sur sa ligne de commande ; ses
 *      enfants ne le portent pas.
 *
 * Ces deux conditions ensemble désignent exactement un navigateur, et jamais
 * un de ses moteurs. Et un `SIGTERM` sur ce processus-là emporte toute sa
 * descendance — mesuré : six processus disparus d'un coup, sans toucher au
 * second navigateur ouvert à côté.
 *
 * ─── Ce que ce module refuse de faire ────────────────────────────────────────
 *
 * Deux familles de connecteurs coexistent, et elles ne se reconnaissent pas de
 * la même façon :
 *
 *   - **profil persistant** (paybyphone, materiel-net, addons-prestashop) :
 *     `--user-data-dir` vaut le répertoire du couple (utilisateur, connecteur).
 *     L'attribution est CERTAINE, même si trois autres exécutions tournent en
 *     même temps ;
 *   - **profil jetable** (les seize autres, `chromium.launch()`) : Playwright
 *     fabrique un `/tmp/playwright_chromiumdev_profile-XXXX` qui ne dit rien du
 *     connecteur. Rien, dans la ligne de commande, ne rattache ce navigateur à
 *     SON exécution.
 *
 * Pour la seconde famille, ce module ne devine pas : il n'éteint un profil
 * jetable **que si l'exécution abandonnée était la seule en cours**. Dans ce
 * cas seulement, aucun autre navigateur ne peut lui appartenir. Sinon il les
 * laisse tous vivre et le dit au journal.
 *
 * C'est délibérément prudent, et le calcul est asymétrique : un navigateur
 * fantôme de profil JETABLE ne bloque rien — le suivant s'en fabriquera un
 * autre — tandis que tuer celui d'une exécution voisine ferait échouer un
 * travail parfaitement sain. Le fantôme qui coûte vraiment, c'est celui d'un
 * profil PERSISTANT, parce qu'il garde le répertoire du compte ouvert et fait
 * échouer la récupération suivante sur « le navigateur est déjà ouvert » — et
 * celui-là, on l'attrape toujours.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** Le drapeau qui porte le profil, et qui ne figure que sur le premier rang. */
const DRAPEAU_PROFIL = '--user-data-dir=';

/** Un profil jetable fabriqué par Playwright pour un `chromium.launch()`. */
const MOTIF_PROFIL_JETABLE = /playwright.*profile/i;

/**
 * Délai avant d'escalader `SIGTERM` en `SIGKILL`.
 *
 * Même second rideau qu'à l'extinction d'une session de navigateur distant
 * (lot 35) : un navigateur qui ignore le premier signal garderait le profil.
 */
const ESCALADE_MS = 3_000;

/**
 * Tout ce qui touche au système passe par ici, pour que les tests puissent
 * poser un double sans jamais lire le vrai `/proc` ni tuer un vrai processus.
 */
function runtimeParDefaut() {
  return {
    fs: nodeFs,
    procDir: () => '/proc',
    monPid: () => process.pid,
    kill: (pid, signal) => process.kill(pid, signal),
    differer: (fn, ms) => setTimeout(fn, ms).unref?.(),
    log: () => {},
  };
}

/**
 * Les navigateurs de PREMIER RANG lancés par ce processus.
 *
 * Un moteur de rendu a pour parent le navigateur, pas node, et ne porte pas
 * `--user-data-dir` : les deux conditions le tiennent dehors. On ne renvoie
 * donc que des processus qu'un `SIGTERM` fera disparaître avec leur descendance.
 *
 * @returns {Array<{pid: number, nom: string, profil: string}>}
 */
function navigateursDeCeProcessus(runtime = runtimeParDefaut()) {
  const moi = runtime.monPid();
  let pids;
  try {
    pids = runtime.fs.readdirSync(runtime.procDir()).filter((n) => /^\d+$/.test(n));
  } catch {
    // Pas de /proc (macOS, test sans double) : rien à éteindre, et surtout pas
    // de quoi faire échouer l'abandon lui-même.
    return [];
  }

  const sortie = [];
  for (const pid of pids) {
    const lire = (fichier) =>
      String(runtime.fs.readFileSync(nodePath.join(runtime.procDir(), pid, fichier)));
    let nom;
    let argv;
    let ppid;
    try {
      nom = lire('comm').trim();
      if (!/chrom/i.test(nom)) continue;
      argv = lire('cmdline').split('\0').filter(Boolean);
      ppid = Number((/^PPid:\s*(\d+)/m.exec(lire('status')) || [])[1]);
    } catch {
      continue; // processus disparu entre le listing et la lecture
    }
    if (ppid !== moi) continue;
    const profil = (argv.find((a) => a.startsWith(DRAPEAU_PROFIL)) || '').slice(DRAPEAU_PROFIL.length);
    if (!profil) continue;
    sortie.push({ pid: Number(pid), nom, profil });
  }
  return sortie;
}

/**
 * Éteint le navigateur d'une exécution abandonnée.
 *
 * @param {object} quoi
 * @param {string|null} quoi.profil  le répertoire de profil persistant du couple
 *   (utilisateur, connecteur), quand ce connecteur en utilise un ; `null` sinon
 * @param {boolean} quoi.seul  l'exécution abandonnée était-elle la SEULE en
 *   cours ? Si non, aucun profil jetable n'est touché (voir l'en-tête).
 * @param {object} [runtime]
 * @returns {{tues: Array<{pid: number, motif: string}>, epargnes: number}}
 */
function eteindre({ profil = null, seul = false } = {}, runtime = runtimeParDefaut()) {
  const vivants = navigateursDeCeProcessus(runtime);
  const tues = [];
  let epargnes = 0;

  for (const nav of vivants) {
    let motif = null;
    if (profil && nav.profil === profil) {
      motif = 'profil du connecteur';
    } else if (seul && MOTIF_PROFIL_JETABLE.test(nav.profil)) {
      motif = 'profil jetable, seule exécution en cours';
    }
    if (!motif) {
      epargnes++;
      continue;
    }
    try {
      runtime.kill(nav.pid, 'SIGTERM');
      tues.push({ pid: nav.pid, motif });
    } catch (err) {
      // ESRCH : il vient de mourir tout seul, tant mieux.
      if (err.code !== 'ESRCH') {
        runtime.log('warn', `Navigateur ${nav.pid} non arrêté — ${err.message}`);
      }
    }
  }

  if (tues.length) {
    runtime.log(
      'warn',
      `Exécution abandonnée : ${tues.length} navigateur(s) éteint(s) — `
        + tues.map((t) => `pid ${t.pid} (${t.motif})`).join(', ')
        + (epargnes ? ` ; ${epargnes} navigateur(s) laissé(s) à d'autres exécutions.` : '.')
    );
    // Second rideau : un navigateur qui ignore SIGTERM garderait le profil du
    // compte ouvert, et la récupération suivante échouerait sur « déjà ouvert ».
    runtime.differer(() => {
      for (const t of tues) {
        try {
          if (!runtime.fs.existsSync(nodePath.join(runtime.procDir(), String(t.pid)))) continue;
          runtime.kill(t.pid, 'SIGKILL');
          runtime.log('warn', `Navigateur ${t.pid} : SIGTERM ignoré — SIGKILL envoyé.`);
        } catch {
          /* mort entre-temps : tant mieux */
        }
      }
    }, ESCALADE_MS);
  } else if (epargnes) {
    runtime.log(
      'warn',
      `Exécution abandonnée : ${epargnes} navigateur(s) laissé(s) en vie — aucun n'a pu lui être `
        + 'rattaché avec certitude (profil jetable et d\'autres exécutions en cours).'
    );
  }

  return { tues, epargnes };
}

module.exports = {
  DRAPEAU_PROFIL,
  MOTIF_PROFIL_JETABLE,
  ESCALADE_MS,
  runtimeParDefaut,
  navigateursDeCeProcessus,
  eteindre,
};
