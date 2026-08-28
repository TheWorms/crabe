'use strict';

/**
 * L'autorisation d'un espace de stockage, menée par crabe (lot 34).
 *
 * ─── Ce que ça remplace ──────────────────────────────────────────────────────
 *
 * Pour brancher pCloud, il fallait : installer rclone sur un autre ordinateur,
 * lancer `rclone authorize "pcloud"` dans un terminal, autoriser dans son
 * navigateur, recopier un bloc JSON sans attraper une ligne d'encadrement de
 * trop (`invalid character 'S'`, vécu le 14/08/2026), le coller dans crabe —
 * et deviner qu'un compte européen exige un réglage caché. Pour un logiciel
 * destiné à un public non technique, c'est un échec complet.
 *
 * Ici, tout se passe sur le serveur : crabe lance `rclone authorize` LUI-MÊME,
 * ouvre l'URL d'autorisation dans sa fenêtre visible (le Chromium sur Xvfb de
 * `remote-browser.js`), laisse l'utilisateur s'identifier chez le fournisseur,
 * et récupère le jeton sur la sortie de la commande. Le serveur de retour
 * d'rclone (127.0.0.1:53682) et le navigateur visible tournent SUR LA MÊME
 * MACHINE : la redirection OAuth aboutit nativement, sans copier-coller.
 *
 * ─── Mesures qui fondent ce module (14/08/2026, binaire v1.75.0) ─────────────
 *
 *   - le jeton sort sur STDOUT, seul, entre deux lignes d'encadrement
 *     (`Paste the following into your remote machine --->` / `<---End paste`) ;
 *     stderr ne porte que des lignes NOTICE, dont l'URL à ouvrir ;
 *   - les réponses préalables (région zoho, etc.) atteignent la commande par
 *     variables d'environnement `RCLONE_<TYPE>_<OPTION>` — sans sa région,
 *     `rclone authorize zoho` meurt sur `Error: no region set` avant même de
 *     montrer une page ;
 *   - deux autorisations en même temps : la seconde meurt sur
 *     `bind: address already in use`, et le port se libère dès la mort du
 *     processus — d'où le verrou d'unicité ET l'extinction systématique ;
 *   - jottacloud (`not supported by this backend`) et mailru (`can't
 *     authorize`) déclarent un jeton mais refusent la commande : ils sont
 *     exclus, par la mesure et non par principe.
 *
 * ─── Ce qui ne sort jamais d'ici ─────────────────────────────────────────────
 *
 * Le jeton. Il va de la sortie standard d'rclone à la configuration chiffrée,
 * et nulle part ailleurs : ni journal, ni réponse HTTP, ni message de session,
 * ni nom de fichier. Les tests le vérifient sur pièce.
 */

const { spawn: nodeSpawn } = require('node:child_process');

const { config } = require('../config');
const applog = require('../applog');
const remoteBrowser = require('../remote-browser');
const backends = require('./backends');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * Les backends qui déclarent un jeton OAuth mais refusent `rclone authorize`.
 * Mesuré un par un sur le binaire v1.75.0 (voir l'en-tête). Une liste figée
 * plutôt qu'une sonde à chaque affichage : la réponse ne dépend que du
 * binaire, et le checkup du lot suivant la re-mesurera si le binaire change.
 */
const NON_AUTORISABLES = new Set(['jottacloud', 'mailru']);

/** L'attente maximale de l'URL d'autorisation sur la sortie d'rclone. */
const DELAI_URL_MS = 20_000;

/**
 * L'attente maximale du jeton, une fois la fenêtre ouverte. Aligné sur le
 * délai de la fenêtre visible (dix minutes) plus une marge : c'est la fenêtre
 * qui rythme, ce délai n'est qu'un filet si elle disparaissait sans prévenir.
 */
const DELAI_JETON_MS = 11 * 60 * 1000;

/** Ce qu'on garde de stderr pour diagnostiquer — jamais le jeton (stdout). */
const STDERR_MAX_LIGNES = 50;

// ---------------------------------------------------------------------------
// Ce que le module sait dire d'un type de stockage
// ---------------------------------------------------------------------------

/**
 * Ce type accepte-t-il l'autorisation menée par crabe ?
 *
 * Un type l'accepte quand son catalogue déclare un champ `token` de type
 * OAuth ET que la mesure n'a pas montré de refus (voir NON_AUTORISABLES).
 * Sans catalogue (rclone absent), on ne sait pas — et on le dit, plutôt que
 * de montrer un bouton qui échouera.
 */
async function typeAutorisable(type) {
  const nom = String(type || '').trim();
  if (!nom || NON_AUTORISABLES.has(nom)) return false;
  const champs = await backends.champsBrutsDuType(nom);
  if (!champs) return false;
  const token = champs.find((c) => c.key === 'token');
  return !!token && /OAuth/i.test(String(token.help || ''));
}

/**
 * L'état de l'autorisation d'une destination, lu dans son jeton enregistré.
 *
 * ⚠ Ne juge que le JETON : l'appelant a la charge de distinguer
 * « déchiffrement échoué » de « pas de jeton » (piège du lot 29 — le repli de
 * `tryDecryptJson` ressemble à une configuration vide).
 *
 * Les règles, dans l'ordre :
 *   - pas de jeton                → `jamais`   (jamais autorisé)
 *   - jeton illisible             → `invalide` (à refaire, le bouton répare)
 *   - un refresh_token est là     → `connecte` (rclone renouvelle tout seul,
 *     mesuré : `grant_type=refresh_token` envoyé spontanément sur un jeton
 *     expiré, configuration réécrite avec le jeton neuf)
 *   - pas de refresh_token :
 *       - pas d'échéance          → `connecte` (cas pCloud : jeton sans fin)
 *       - échéance passée         → `expiree`
 *       - échéance sous 7 jours   → `echeance` (avertir AVANT la panne)
 *       - sinon                   → `connecte`
 */
function etatDuJeton(tokenBrut) {
  const texte = String(tokenBrut || '').trim();
  if (!texte) return { etat: 'jamais', echeance: null };

  let jeton;
  try {
    jeton = JSON.parse(texte);
  } catch {
    return { etat: 'invalide', echeance: null };
  }
  if (!jeton || typeof jeton !== 'object' || !String(jeton.access_token || '').trim()) {
    return { etat: 'invalide', echeance: null };
  }

  if (String(jeton.refresh_token || '').trim()) return { etat: 'connecte', echeance: null };

  const echeance = Date.parse(String(jeton.expiry || ''));
  // Une date absente ou l'an 1 (« 0001-01-01 », le zéro de Go) : pas de fin.
  if (!Number.isFinite(echeance) || echeance < Date.parse('1971-01-01T00:00:00Z')) {
    return { etat: 'connecte', echeance: null };
  }
  const maintenant = Date.now();
  if (echeance <= maintenant) return { etat: 'expiree', echeance: new Date(echeance).toISOString() };
  if (echeance - maintenant < 7 * 24 * 3600 * 1000) {
    return { etat: 'echeance', echeance: new Date(echeance).toISOString() };
  }
  return { etat: 'connecte', echeance: new Date(echeance).toISOString() };
}

// ---------------------------------------------------------------------------
// La mécanique
// ---------------------------------------------------------------------------

/**
 * Extrait le jeton de la sortie standard d'`rclone authorize`.
 *
 * Formes mesurées (v1.75.0) :
 *   - sans argument : le JSON brut entre les deux lignes d'encadrement —
 *     exactement les lignes qui avaient piégé l'utilisateur au copier-coller ;
 *   - avec un blob en argument : un base64 SANS bourrage de
 *     `{"token":"<json>"}` entre les mêmes lignes.
 *
 * On cherche d'abord entre les marqueurs, sinon dans tout le texte ; on
 * accepte les deux formes. Ne rend JAMAIS un morceau de la sortie dans son
 * message d'erreur : elle pourrait contenir le jeton.
 */
function extraireJeton(sortie) {
  const texte = String(sortie || '');

  const entre = texte.match(/Paste the following into your remote machine --->\s*\n([\s\S]*?)\n\s*<---End paste/);
  const candidat = (entre ? entre[1] : texte).trim();

  // Forme JSON : du premier `{` à son accolade fermante équilibrée.
  const debut = candidat.indexOf('{');
  if (debut !== -1) {
    let profondeur = 0;
    let enChaine = false;
    let echappe = false;
    for (let i = debut; i < candidat.length; i += 1) {
      const c = candidat[i];
      if (echappe) { echappe = false; continue; }
      if (c === '\\') { echappe = true; continue; }
      if (c === '"') enChaine = !enChaine;
      if (enChaine) continue;
      if (c === '{') profondeur += 1;
      if (c === '}') {
        profondeur -= 1;
        if (profondeur === 0) {
          const brut = candidat.slice(debut, i + 1);
          try {
            const objet = JSON.parse(brut);
            // Forme enveloppée : {"token":"<json>"} — on range le JSON interne.
            if (typeof objet.token === 'string' && objet.token.trim().startsWith('{')) {
              JSON.parse(objet.token);
              return { ok: true, jeton: objet.token.trim() };
            }
            if (String(objet.access_token || '').trim()) return { ok: true, jeton: brut };
            return { ok: false, erreur: 'La sortie d\'rclone ne contient pas de jeton d\'accès.' };
          } catch {
            return { ok: false, erreur: 'La sortie d\'rclone n\'est pas un jeton lisible.' };
          }
        }
      }
    }
  }

  // Forme base64 (blob sans bourrage) : une seule « ligne » compacte.
  const blob = candidat.match(/[A-Za-z0-9+/]{40,}={0,2}/);
  if (blob) {
    try {
      const objet = JSON.parse(Buffer.from(blob[0], 'base64').toString('utf8'));
      if (typeof objet.token === 'string' && objet.token.trim().startsWith('{')) {
        JSON.parse(objet.token);
        return { ok: true, jeton: objet.token.trim() };
      }
    } catch {
      /* pas un blob : on tombe sur le refus commun */
    }
  }

  return { ok: false, erreur: 'rclone n\'a pas rendu de jeton.' };
}

/**
 * Traduit une fin prématurée d'rclone en phrase française.
 *
 * `lignes` vient de stderr — qui, mesuré, ne porte jamais le jeton. On cite
 * la ligne d'erreur d'rclone entre parenthèses : c'est le seul indice
 * technique utile, et il est sans danger.
 */
function expliquerEchec(lignes, nomService) {
  const texte = lignes.join('\n');
  if (/bind: address already in use/.test(texte)) {
    return 'Une autre autorisation est déjà en cours sur ce serveur — une seule est possible '
      + 'à la fois. Attendez qu\'elle se termine (ou annulez-la), puis réessayez.';
  }
  if (/no region set/i.test(texte)) {
    return `La région de votre compte ${nomService} n'est pas renseignée. Choisissez-la dans `
      + 'le formulaire, enregistrez, puis relancez la connexion.';
  }
  if (/not supported by this backend|can't authorize/i.test(texte)) {
    return `${nomService} ne passe pas par ce type d'autorisation : sa fiche demande `
      + 'd\'autres renseignements.';
  }
  if (/access_denied|denied/i.test(texte)) {
    return `L'accès a été refusé chez ${nomService} — l'autorisation n'a pas été accordée. `
      + 'Vous pouvez recommencer quand vous voulez.';
  }
  const erreur = [...lignes].reverse().find((l) => /Error:|Fatal error/.test(l));
  const detail = erreur ? ` (${erreur.replace(/^.*(Error:|Fatal error:)\s*/, '').trim()})` : '';
  return `La connexion à ${nomService} n'a pas abouti${detail}. Rien n'a été modifié — `
    + 'vous pouvez réessayer.';
}

/**
 * Les réponses préalables qui doivent atteindre la commande, en variables
 * d'environnement `RCLONE_<TYPE>_<OPTION>` (la règle d'rclone : majuscules,
 * tout ce qui n'est pas alphanumérique devient `_`).
 *
 * Seules partent les valeurs DÉJÀ enregistrées qui correspondent à une option
 * déclarée par le catalogue du type, hors secrets et hors machinerie OAuth :
 * la région zoho, le `hostname` pCloud, le `scope` Drive… Un secret obscurci
 * n'aurait aucun sens en clair ici, et le jeton, c'est ce qu'on vient chercher.
 */
async function environnementPrealable(type, valeurs) {
  const env = {};
  const champs = (await backends.champsBrutsDuType(type)) || [];
  const machinerie = new Set(['token', 'auth_url', 'token_url', 'client_id', 'client_secret', 'client_credentials']);
  const prefixe = `RCLONE_${String(type).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;

  for (const [cle, valeur] of Object.entries(valeurs || {})) {
    const texte = String(valeur ?? '').trim();
    if (!texte) continue;
    if (machinerie.has(cle)) continue;
    const declare = champs.find((c) => c.key === cle);
    if (!declare || declare.type === 'password') continue;
    env[prefixe + String(cle).toUpperCase().replace(/[^A-Z0-9]/g, '_')] = texte;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Le parcours
// ---------------------------------------------------------------------------

/** L'autorisation en cours — une seule sur toute l'instance, comme la fenêtre. */
let courante = null;

function defaultRuntime() {
  return {
    spawn: nodeSpawn,
    manager: () => remoteBrowser.manager(),
    log: (niveau, message, meta) => applog[niveau]?.('autorisation', message, meta),
    now: () => Date.now(),
  };
}

/** L'identifiant de session côté fenêtre visible, unique par destination. */
function idFenetre(destId) {
  return `destination:${destId}`;
}

/**
 * Démarre l'autorisation d'une destination : lance `rclone authorize`, ouvre
 * l'URL dans la fenêtre visible, et branche la conclusion sur la sortie de la
 * commande. Rend la vue publique de la fenêtre (celle qu'attend le client
 * noVNC), comme le ferait une connexion de connecteur.
 *
 * @param {object} p
 * @param {number} p.userId
 * @param {string} p.destId
 * @param {string} p.type       le type rclone (pcloud, dropbox…)
 * @param {string} p.nom        le nom affiché de la destination
 * @param {object} p.valeurs    la configuration déchiffrée (réponses préalables)
 * @param {(jeton: string, indiceRegion: string|null) => void} p.enregistrer
 *   range le jeton (et l'indice de région s'il y en a un) dans la
 *   configuration chiffrée. C'est l'appelant qui sait écrire — ce module ne
 *   touche jamais la base lui-même.
 * @param {() => Promise<void>} [p.creerDossier]
 *   crée le dossier de base de crabe sur la destination, APRÈS l'enregistrement
 *   du jeton (lot 35). Fourni par l'appelant pour la même raison
 *   qu'`enregistrer` : c'est lui qui sait relire la configuration — et la
 *   relire APRÈS l'écriture garantit que le mkdir emploie le bloc exact des
 *   copies, jeton neuf et région compris. Une écriture qui réussit est la
 *   meilleure preuve du jeton ; son échec ne défait pas l'autorisation, mais
 *   la conclusion le dit, avec quoi faire.
 */
async function demarrer({ userId, destId, type, nom, valeurs, enregistrer, creerDossier }, rt = defaultRuntime()) {
  if (courante) {
    const err = new Error(
      'Une autorisation est déjà en cours sur ce serveur — une seule est possible à la fois. '
      + 'Terminez-la ou annulez-la, puis réessayez.'
    );
    err.statusCode = 409;
    err.expose = true;
    throw err;
  }
  // `rt.typeAutorisable` et `rt.environnement` : les deux seuls points qui
  // interrogent le catalogue rclone local — remplaçables par les tests, qui
  // jugent la mécanique et pas le binaire (lui a été mesuré à la main).
  if (!(await (rt.typeAutorisable || typeAutorisable)(type))) {
    const err = new Error(`« ${nom} » ne passe pas par ce type d'autorisation.`);
    err.statusCode = 400;
    err.expose = true;
    throw err;
  }

  // L'environnement de la commande : le strict nécessaire, plus les réponses
  // préalables. Pas d'héritage complet — un HOME inscriptible suffit à rclone
  // pour chercher (et ne pas trouver) sa configuration, et rien d'autre du
  // service n'a de raison de fuiter vers ce processus.
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    ...(await (rt.environnement || environnementPrealable)(type, valeurs)),
  };

  const etat = {
    userId,
    destId,
    type,
    nom,
    processus: null,
    stdout: '',
    stderr: [],
    tue: false,
    conclu: false,
    filet: null,
  };
  courante = etat;

  const conclure = async (ok, message) => {
    if (etat.conclu) return;
    etat.conclu = true;
    if (etat.filet) clearTimeout(etat.filet);
    if (courante === etat) courante = null;
    await rt.manager().conclure(userId, idFenetre(destId), { ok, message });
  };

  const tuerRclone = () => {
    etat.tue = true;
    try {
      etat.processus?.kill('SIGTERM');
    } catch { /* déjà mort */ }
    // SIGKILL en second rideau : un authorize orphelin garde le port 53682
    // ouvert, et avec lui toutes les autorisations suivantes en échec.
    setTimeout(() => {
      try {
        if (etat.processus && etat.processus.exitCode === null) etat.processus.kill('SIGKILL');
      } catch { /* déjà mort */ }
    }, 3000).unref?.();
  };

  try {
    etat.processus = rt.spawn(config.rcloneBin, ['authorize', type, '--auth-no-open-browser'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    courante = null;
    throw new Error(`Impossible de lancer rclone : ${err.message}`);
  }

  // ⚠ stdout est LE canal du jeton : accumulé en mémoire, jamais journalisé,
  // jamais cité dans un message. Borné : un processus fou n'a pas à remplir
  // la mémoire du service.
  etat.processus.stdout.on('data', (morceau) => {
    if (etat.stdout.length < 1024 * 1024) etat.stdout += String(morceau);
  });
  etat.processus.stderr.on('data', (morceau) => {
    for (const ligne of String(morceau).split('\n')) {
      if (!ligne.trim()) continue;
      etat.stderr.push(ligne);
      if (etat.stderr.length > STDERR_MAX_LIGNES) etat.stderr.shift();
    }
  });

  // 1. L'URL d'autorisation, sur stderr. Sans elle dans les 20 s, on éteint.
  // Attente ÉVÉNEMENTIELLE, pas un sondage : chaque ligne de stderr est
  // regardée à son arrivée, la mort du processus conclut, et le délai est une
  // minuterie franche — nettoyée dans tous les cas, pour ne rien laisser
  // pendre dans la boucle d'événements.
  const url = await new Promise((resoudre) => {
    let fini = false;
    const conclureAttente = (resultat) => {
      if (fini) return;
      fini = true;
      clearTimeout(delai);
      etat.processus.stderr.removeListener('data', surLigne);
      etat.processus.removeListener('exit', surMort);
      resoudre(resultat);
    };
    const surLigne = () => {
      const trouve = etat.stderr.join('\n').match(/Please go to the following link: (https?:\/\/\S+)/);
      if (trouve) conclureAttente({ ok: true, url: trouve[1] });
    };
    const surMort = () => conclureAttente({ ok: false });
    const delai = setTimeout(() => conclureAttente({ ok: false, delai: true }), DELAI_URL_MS);
    etat.processus.stderr.on('data', surLigne);
    etat.processus.on('exit', surMort);
    surLigne();
  });

  if (!url.ok) {
    tuerRclone();
    courante = null;
    const err = new Error(
      url.delai
        ? `rclone n'a pas fourni d'adresse d'autorisation pour ${nom} dans le délai imparti.`
        : expliquerEchec(etat.stderr, nom)
    );
    err.statusCode = 502;
    err.expose = true;
    throw err;
  }

  // 2. La fenêtre visible, ouverte sur cette URL. Sans capture : rien à
  // photographier, et surtout pas la session du FOURNISSEUR — l'utilisateur
  // se connecte chez pCloud ou Google dans cette fenêtre, et cette session-là
  // ne regarde pas crabe.
  let vue;
  try {
    vue = await rt.manager().start({
      userId,
      connectorId: idFenetre(destId),
      connectorName: nom,
      url: url.url,
      capture: false,
      hint: `Connectez-vous à ${nom} dans cette fenêtre, puis autorisez l'accès. `
        + 'La fenêtre se fermera toute seule — la clé d\'accès est rangée chiffrée, '
        + 'elle ne s\'affiche jamais.',
      // Quel que soit le chemin de sortie de la fenêtre (annulation, délai,
      // onglet fermé, arrêt du service), rclone ne doit pas survivre : un
      // authorize orphelin garde le port 53682 et condamne les suivantes.
      onFin: async () => {
        if (etat.processus && etat.processus.exitCode === null) tuerRclone();
        if (courante === etat) courante = null;
      },
    });
  } catch (err) {
    tuerRclone();
    courante = null;
    throw err;
  }

  // 3. La conclusion, branchée sur la mort d'rclone. Un code 0 porte le jeton.
  // `finTraitee` : l'événement `exit` a pu partir PENDANT l'ouverture de la
  // fenêtre — on rejoue alors la conclusion à la main, mais jamais deux fois.
  const surFinRclone = (code) => {
    if (etat.finTraitee) return;
    etat.finTraitee = true;
    (async () => {
      if (etat.tue) return; // la fenêtre a déjà dit pourquoi

      if (code === 0) {
        const resultat = extraireJeton(etat.stdout);
        if (!resultat.ok) {
          rt.log('warn', `Autorisation ${nom} : sortie d'rclone sans jeton lisible.`, { userId });
          return conclure(false,
            `La connexion à ${nom} semblait aboutir, mais la clé d'accès reçue est `
            + 'illisible. Réessayez ; si cela persiste, c\'est un défaut de crabe.');
        }
        // L'indice de région vu passer par la fenêtre (pCloud) : la redirection
        // porte `hostname=eapi.pcloud.com` pour un compte européen, et le jeton
        // ne le porte pas. On le range avec le jeton — c'est lui qui évite
        // « Invalid 'access_token' (2094) » sur un compte européen.
        const fenetre = rt.manager().sessionFor(userId, idFenetre(destId));
        const indiceRegion = fenetre?.indiceRegion || null;
        try {
          enregistrer(resultat.jeton, indiceRegion);
        } catch (err) {
          rt.log('error', `Autorisation ${nom} : le jeton n'a pas pu être enregistré (${err.message}).`, { userId });
          return conclure(false,
            `La clé d'accès de ${nom} a bien été reçue mais n'a pas pu être enregistrée `
            + `(${err.message}).`);
        }
        rt.log('info', `Autorisation ${nom} enregistrée par la fenêtre de crabe.`, { userId });

        // ─── Le dossier de crabe, créé dans la foulée (lot 35) ──────────────
        //
        // Mesuré le 15/08/2026 : un compte pCloud vierge autorisé sans faute
        // rendait ensuite « directory not found » au premier test — le dossier
        // de crabe n'existait pas, et rien ne le créait. On le crée ICI, pour
        // tous les backends OAuth : c'est en plus la vraie preuve du jeton,
        // une écriture réussie — là où un listing ne prouve pas ce droit.
        // L'échec du mkdir ne défait PAS l'autorisation (le jeton est bon et
        // rangé) : la conclusion le dit, avec le geste qui répare.
        if (typeof creerDossier === 'function') {
          try {
            await creerDossier();
          } catch (err) {
            rt.log('warn',
              `Autorisation ${nom} : jeton rangé, mais la création du dossier de crabe a échoué (${err.message}).`,
              { userId });
            return conclure(true,
              `${nom} est connecté et la clé d'accès est rangée, chiffrée — mais la création `
              + `du dossier de crabe a échoué. ${require('./erreurs-rclone').traduire(err.message)} `
              + 'Puis utilisez « Tester » sur la carte de cette destination pour vérifier.');
          }
          return conclure(true, `${nom} est connecté : le dossier de crabe est créé, l'accès `
            + 'en écriture est vérifié. La clé d\'accès est rangée, chiffrée — vous pouvez fermer.');
        }

        return conclure(true, `${nom} est connecté. La clé d'accès est rangée, chiffrée — `
          + 'vous pouvez fermer.');
      }

      return conclure(false, expliquerEchec(etat.stderr, nom));
    })().catch((err) => {
      rt.log('error', `Autorisation ${nom} : conclusion impossible (${err.message}).`, { userId });
    });
  };
  etat.processus.on('exit', surFinRclone);
  if (etat.processus.exitCode !== null) surFinRclone(etat.processus.exitCode);

  // 4. Le filet : si tout le reste se taisait, rclone ne tourne pas éternellement.
  etat.filet = setTimeout(() => {
    if (etat.processus && etat.processus.exitCode === null) {
      tuerRclone();
      conclure(false, `L'autorisation de ${nom} a dépassé le temps imparti — recommencez.`);
    }
  }, DELAI_JETON_MS);
  etat.filet.unref?.();

  return vue;
}

/** Pour les tests et le diagnostic : y a-t-il une autorisation en cours ? */
function enCours() {
  return courante ? { destId: courante.destId, userId: courante.userId } : null;
}

module.exports = {
  demarrer,
  typeAutorisable,
  etatDuJeton,
  extraireJeton,
  environnementPrealable,
  expliquerEchec,
  enCours,
  idFenetre,
  NON_AUTORISABLES,
  defaultRuntime,
};
