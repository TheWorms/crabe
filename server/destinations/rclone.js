'use strict';

/**
 * Enveloppe autour du binaire `rclone` (pas de bibliothèque npm).
 *
 * La configuration rclone n'est jamais stockée en clair : elle vit chiffrée
 * en base (destinations_config.config_encrypted) et n'est matérialisée dans
 * un fichier temporaire, en 0600, que le temps d'une commande.
 */

const { execFile } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../config');

const DEFAULT_TIMEOUT_MS = 120_000;

/** Le binaire rclone est-il présent et exécutable ? */
function isAvailable() {
  return new Promise((resolve) => {
    execFile(config.rcloneBin, ['version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

function run(args, { timeout = DEFAULT_TIMEOUT_MS, confFile, stdin = null } = {}) {
  const fullArgs = confFile ? ['--config', confFile, ...args] : args;
  return new Promise((resolve, reject) => {
    const enfant = execFile(
      config.rcloneBin,
      fullArgs,
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const message =
            err.code === 'ENOENT'
              ? `Binaire rclone introuvable (${config.rcloneBin}). Installez-le sur le serveur.`
              : (stderr || err.message || '').trim();
          const wrapped = new Error(message);
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          return reject(wrapped);
        }
        resolve({ stdout, stderr });
      }
    );

    // Une valeur passée par l'ENTRÉE STANDARD, jamais en argument : la ligne de
    // commande d'un processus est lisible par n'importe qui sur la machine
    // (`ps`), et c'est par là que passent les mots de passe qu'on obscurcit.
    if (stdin !== null) {
      enfant.stdin.end(String(stdin));
    }
  });
}

/**
 * Obscurcit un secret comme le fait `rclone obscure`.
 *
 * ─── Pourquoi crabe le fait à la place de l'utilisateur ──────────────────────
 *
 * rclone REFUSE un mot de passe écrit en clair dans sa configuration : il exige
 * la forme obscurcie. Ce n'est pas du chiffrement — c'est réversible, avec une
 * clé publiquement connue, et ça ne protège de rien — mais c'est obligatoire.
 *
 * Demander à l'utilisateur de lancer `rclone obscure` dans un terminal avant de
 * remplir un formulaire, c'est lui demander exactement ce que ce lot cherche à
 * ne plus demander. crabe s'en charge : on saisit son mot de passe, point.
 *
 * Le vrai secret, lui, est protégé par le chiffrement de crabe, comme tous les
 * autres identifiants — l'obscurcissement d'rclone n'y ajoute ni ne retire rien.
 */
async function obscure(secret) {
  const texte = String(secret ?? '');
  if (!texte) return '';
  const { stdout } = await run(['obscure', '-'], { timeout: 15_000, stdin: texte });
  return stdout.trim();
}

/**
 * La clé d'obscurcissement d'rclone — PUBLIQUE, recopiée de sa source
 * (lib/obscure). C'est toute la démonstration que l'obscurcissement n'est pas
 * un chiffrement : n'importe qui la connaît, rclone doit bien relire ses
 * propres mots de passe. Le vrai secret reste protégé par le chiffrement de
 * crabe, qui enveloppe la configuration entière.
 */
const CLE_OBSCURE = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
  0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

/**
 * L'inverse d'`obscure()`, en JS pur (lot 33).
 *
 * Pourquoi pas `rclone reveal` ? Mesuré en production : il n'accepte PAS la
 * convention `-` (entrée standard) qu'`obscure` accepte — il faudrait passer
 * la valeur en ARGUMENT, donc l'exposer dans `ps`, ce que ce fichier interdit
 * précisément. AES-256-CTR avec la clé publique ci-dessus, IV en tête,
 * base64 URL : vérifié contre une paire produite par le vrai binaire v1.75.
 *
 * Sert à EXAMINER la forme d'un secret enregistré (la clé de validation
 * Proton qui contient un code à six chiffres, panne du 14/08/2026) — jamais à
 * l'afficher.
 *
 * @throws {Error} si la valeur n'est pas une forme obscurcie lisible
 */
function reveal(obscurci) {
  const texte = String(obscurci ?? '').trim();
  if (!texte) return '';
  const brut = Buffer.from(texte.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (brut.length < 16) throw new Error('valeur obscurcie illisible');
  const dechiffreur = nodeCrypto.createDecipheriv('aes-256-ctr', CLE_OBSCURE, brut.subarray(0, 16));
  return Buffer.concat([dechiffreur.update(brut.subarray(16)), dechiffreur.final()]).toString('utf8');
}

/**
 * Écrit un rclone.conf temporaire à partir d'une config déchiffrée, exécute
 * `fn`, puis efface le fichier.
 * @param {{remoteName: string, rcloneConfig: string}} dest
 */
async function withConfig(dest, fn) {
  if (!dest?.remoteName) throw new Error('Nom de remote rclone manquant.');
  if (!dest?.rcloneConfig) throw new Error('Bloc de configuration rclone manquant.');

  // ─── Le refus qui n'a pas besoin du service (lot 58) ───────────────────────
  //
  // Quand la reconnexion est impossible PAR CONSTRUCTION — session refusée par
  // le service, compte à validation en deux étapes, aucune clé pour calculer
  // un code —, jouer le bloc ne peut produire qu'un échec de connexion de
  // plus. C'est précisément la rafale d'échecs de login que Proton a payée en
  // révocations le 25/08/2026 : chaque mesure d'espace, chaque dépôt tentait
  // un login voué à l'échec. Le pilote pose la phrase (`normalizeConf`), et on
  // s'arrête ICI, sans solliciter le service, avec le message qui dit le vrai
  // manque et le geste qui répare.
  if (dest.refusAvantService) {
    const refus = new Error(dest.refusAvantService);
    refus.dejaTraduite = true;
    // La marque qui dit sa nature : ce refus est DÉFINITIF tant que la
    // configuration ne change pas, et il n'a coûté aucun appel au service.
    // Les boucles de tentatives (lot 61) s'arrêtent dessus au lieu de
    // promettre un « nouvel essai » qui rendrait trois fois la même phrase.
    refus.refusAvantService = true;
    throw refus;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-rclone-'));
  const confFile = path.join(dir, 'rclone.conf');
  const body = `[${dest.remoteName}]\n${dest.rcloneConfig.trim()}\n`;
  fs.writeFileSync(confFile, body, { mode: 0o600 });

  try {
    return await fn(confFile);
  } catch (err) {
    // ─── Une session que le service ne reconnaît plus se DIT (lot 57) ────────
    //
    // L'incident du 25/08/2026 : la session durable Proton, révoquée côté
    // service, était rejouée à chaque opération (« 401 Invalid access token »
    // → « 400 Invalid refresh token »), et rien ne la marquait morte — chaque
    // chemin retombait sur le même refus, et l'écran accusait le mot de passe.
    // Le rappel reçoit le texte complet de l'échec ; c'est LUI qui décide si
    // c'est une mort de session, et il n'a pas le droit de masquer l'erreur
    // d'origine.
    const texteEchec = `${err.message || ''}\n${err.stderr || ''}`;
    try {
      if (typeof dest.onSessionRefusee === 'function') {
        dest.onSessionRefusee(texteEchec);
      }
    } catch {
      /* le verdict de l'opération prime toujours sur le marquage */
    }

    // ─── La reconnexion en plein geste (lot 58) ──────────────────────────────
    //
    // L'incident du 25/08/2026 au soir, APRÈS le lot 57 : « Tester » réussit,
    // « Renommer maintenant » échoue — Proton avait révoqué la session ENTRE
    // les deux. Le lot 57 marque la session morte au premier refus, si bien
    // que le geste SUIVANT repart proprement ; mais le geste qui a essuyé le
    // refus, lui, s'arrêtait. Le rappel `reconnexion` (posé par le pilote)
    // décide : il rend une configuration FRAÎCHE — relue de la base, session
    // morte écartée, donc mot de passe + code calculé depuis la clé TOTP — et
    // l'opération se REJOUE dessus, UNE seule fois par refus. Il rend null
    // quand le refus n'est pas une mort de session, et il LÈVE (en français)
    // quand la reconnexion est impossible ou que le plafond du chantier est
    // atteint — se reconnecter en rafale contre un service qui révoque, c'est
    // se faire bloquer pour de bon.
    if (typeof dest.reconnexion === 'function') {
      const tentative = dest.reconnexion(texteEchec);
      if (tentative) {
        try {
          // La configuration fraîche perd son propre rappel : UNE tentative
          // par refus, jamais une récursion de reconnexions.
          const resultat = await withConfig({ ...tentative.dest, reconnexion: undefined }, fn);
          if (typeof tentative.surReussite === 'function') tentative.surReussite();
          return resultat;
        } catch (err2) {
          throw (typeof tentative.surEchec === 'function' && tentative.surEchec(err2)) || err2;
        }
      }
    }
    throw err;
  } finally {
    // ─── Ce qu'rclone écrit dans la conf jetable ne part pas à la poubelle ───
    //
    // Deux comportements mesurés sur le binaire v1.75.0 (lot 34) :
    //
    //   - face à un jeton OAuth expiré, rclone le renouvelle tout seul
    //     (`grant_type=refresh_token`) et RÉÉCRIT `token` dans son fichier de
    //     configuration (« Automatically upgraded OAuth config. ») ;
    //   - après CHAQUE authentification Proton Drive réussie, son
    //     `authHandler` écrit `client_uid`, `client_access_token`,
    //     `client_refresh_token` et `client_salted_key_pass` — la session
    //     durable qui permet de se reconnecter SANS mot de passe ni code 2FA
    //     (`UseReusableLogin`, vérifié dans la source du backend).
    //
    // Or ce fichier-ci est jetable : sans ce relevé, chaque valeur réécrite
    // disparaîtrait avec lui — jeton rafraîchi perdu (les fournisseurs qui
    // font tourner leur refresh_token finiraient par invalider la session),
    // et session Proton recapturée puis jetée à CHAQUE opération, condamnant
    // le compte à exiger un code 2FA éternellement.
    //
    // Le relevé ne doit JAMAIS faire échouer l'opération qui vient de réussir :
    // tout est avalé, et le rappel décide seul de ce qu'il en fait.
    try {
      if (typeof dest.onSecretsRafraichis === 'function') {
        const relu = fs.readFileSync(confFile, 'utf8');
        const changements = {};
        for (const cle of CLES_ECRITES_PAR_RCLONE) {
          const motif = new RegExp(`^${cle}\\s*=\\s*(.+)$`, 'm');
          const apres = relu.match(motif)?.[1]?.trim() || '';
          const avant = body.match(motif)?.[1]?.trim() || '';
          if (apres && apres !== avant) changements[cle] = apres;
        }
        if (Object.keys(changements).length) dest.onSecretsRafraichis(changements);
      }
    } catch {
      /* le fichier a pu disparaître — l'opération, elle, a rendu son verdict */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Les clés qu'rclone écrit LUI-MÊME dans sa configuration, et que crabe doit
 * relever avant de jeter le fichier : le jeton OAuth (tous les fournisseurs à
 * autorisation), et la session durable de Proton Drive. Rien d'autre — on ne
 * moissonne pas ce qu'on ne comprend pas.
 */
const CLES_ECRITES_PAR_RCLONE = [
  'token',
  'client_uid',
  'client_access_token',
  'client_refresh_token',
  'client_salted_key_pass',
];

/**
 * La session durable Proton Drive, seule : les quatre clés que son authHandler
 * écrit après une connexion réussie. C'est CE bloc qui, présent, remplace mot
 * de passe et code 2FA — et c'est donc lui qu'il faut écarter quand
 * l'utilisateur ressaisit de quoi rouvrir une connexion (lot 57 : trois
 * réenregistrements corrects sont restés sans effet parce que la session morte
 * primait sur les saisies neuves).
 */
const CLES_SESSION_PROTON = [
  'client_uid',
  'client_access_token',
  'client_refresh_token',
  'client_salted_key_pass',
];

/**
 * L'adresse d'un fichier sur le remote : `remote:<base>/<relatif>`.
 *
 * ─── Le défaut que cette fonction remplace (lot 24) ──────────────────────────
 *
 * `upload()` et `download()` composaient l'adresse à coups de remplacements de
 * chaînes, dont un `.replace(':/', ':')`. Il servait un cas réel — un dossier
 * de base vide donne `remote:` puis `remote:/fichier`, et rclone veut
 * `remote:fichier` — mais il mangeait aussi la barre d'un chemin ABSOLU.
 *
 * Personne ne l'avait vu parce que les deux seules destinations existantes
 * avaient `crabe` comme dossier de base. Le mode générique change ça : un
 * remote de type `local` ou `sftp` a très bien le droit d'avoir `/mnt/quelque
 * chose` comme racine. Mesuré sur le conteneur : un document annoncé déposé
 * dans `essai:/opt/crabe/data/essai/…` atterrissait en réalité dans
 * `essai:opt/crabe/data/essai/…`, c'est-à-dire relativement au dossier de
 * travail du service. Le dépôt répondait « ok », le fichier était introuvable.
 *
 * Pire : `testRemote()`, lui, ne faisait PAS ce remplacement. Le test de
 * connexion écrivait donc au bon endroit et le dépôt à un autre — la meilleure
 * façon de rendre un défaut invisible.
 *
 * On assemble maintenant par morceaux, sans jamais toucher à la barre qui suit
 * les deux-points.
 *
 * @param {{remoteName: string, basePath?: string}} dest
 * @param {string} [relatif] chemin relatif au dossier de base
 */
function adresse(dest, relatif = '') {
  const racine = String(dest.basePath || '').replace(/\/+$/, '');
  const chemin = [racine, String(relatif || '')]
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
  return `${dest.remoteName}:${chemin}`;
}

/** Vérifie que le remote répond et qu'on peut y écrire. */
async function testRemote(dest) {
  return withConfig(dest, async (confFile) => {
    const base = adresse(dest);

    // `lsd` valide l'authentification et l'accès en lecture.
    //
    // ─── Un dossier absent n'est pas une panne (lot 35) ──────────────────────
    //
    // Mesuré en production le 15/08/2026, première connexion pCloud d'un compte
    // qui n'avait jamais rien reçu : « ERROR : error listing: directory not
    // found ». L'espace était parfaitement joignable, le jeton valide — seul le
    // dossier de crabe n'existait pas encore, puisque rien n'y avait jamais été
    // déposé. Répondre « échec » à l'état NORMAL d'une destination neuve, en
    // anglais d'rclone, c'était le double manquement. On crée donc le dossier
    // (`mkdir`, idempotent — mesuré v1.75.0 : deux appels de suite réussissent)
    // et on poursuit : l'écriture-témoin qui suit prouve mieux qu'un listing.
    // Toute AUTRE erreur de `lsd` (jeton refusé, réseau…) reste une vraie panne.
    let dossierCree = false;
    try {
      await run(['lsd', base, '--max-depth', '1'], { confFile, timeout: 60_000 });
    } catch (err) {
      if (!/directory not found/i.test(`${err.message || ''}\n${err.stderr || ''}`)) throw err;
      await run(['mkdir', base], { confFile, timeout: 60_000 });
      dossierCree = true;
    }

    // Un aller-retour d'écriture confirme les droits réels.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-probe-'));
    const probeFile = path.join(probeDir, '.crabe-write-test');
    fs.writeFileSync(probeFile, `crabe write test ${new Date().toISOString()}\n`);
    const temoin = adresse(dest, '.crabe-write-test');
    try {
      await run(['copyto', probeFile, temoin], { confFile });
      await run(['deletefile', temoin], { confFile }).catch(() => {});
      return {
        ok: true,
        message: dossierCree
          ? 'L\'espace est prêt : le dossier de crabe vient d\'être créé, et l\'accès en écriture est vérifié.'
          : 'L\'espace de stockage répond — accès en écriture vérifié.',
      };
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });
}

/**
 * Crée le dossier de base de crabe sur le remote (lot 35).
 *
 * Appelé à la fin d'une autorisation réussie : une ÉCRITURE qui aboutit est la
 * meilleure preuve du jeton — un listing qui passe ne prouve pas le droit
 * d'écrire. Le bloc de configuration employé est EXACTEMENT celui des copies
 * (`withConfig` + `adresse`, hostname de région compris) : un mkdir joué sur un
 * autre bloc prouverait autre chose que ce que la copie fera.
 *
 * `mkdir` est idempotent (mesuré v1.75.0) : sur un espace déjà garni, rien ne
 * casse et rien n'est modifié.
 */
async function creerDossierDeBase(dest) {
  return withConfig(dest, (confFile) =>
    run(['mkdir', adresse(dest)], { confFile, timeout: 60_000 })
  );
}

/**
 * Copie un fichier local vers le remote.
 * @param {object} dest config déchiffrée
 * @param {string} localFile
 * @param {string} remoteRelPath chemin relatif à basePath
 */
async function upload(dest, localFile, remoteRelPath) {
  return withConfig(dest, async (confFile) => {
    const target = adresse(dest, remoteRelPath);
    await run(['copyto', localFile, target], { confFile });
    return target;
  });
}

/**
 * Rapatrie un fichier du remote vers un fichier local.
 *
 * Symétrique d'`upload()`, et pour la même raison : rclone travaille sur des
 * fichiers, pas sur des flux mémoire. Sert à « Mes documents » quand la
 * destination consultée n'est pas le stockage local.
 *
 * @param {object} dest config déchiffrée
 * @param {string} remoteRelPath chemin relatif à basePath
 * @param {string} localFile
 */
async function download(dest, remoteRelPath, localFile) {
  return withConfig(dest, async (confFile) => {
    await run(['copyto', adresse(dest, remoteRelPath), localFile], { confFile });
    return localFile;
  });
}

module.exports = {
  isAvailable, run, obscure, reveal, adresse, withConfig, testRemote, creerDossierDeBase,
  upload, download,
  CLES_ECRITES_PAR_RCLONE,
  CLES_SESSION_PROTON,
};
