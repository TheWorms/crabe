'use strict';

/**
 * Lot 98 — les documents Gandi déjà rangés passent du dossier à l'IDENTIFIANT
 * de leur organisation au dossier à son NOM, sur chaque stockage où ils sont,
 * et leurs chemins en base suivent.
 *
 * Le dossier cible est celui que décide, pour les nouveaux dépôts, la seule
 * fonction qui en décide (`server/dossier-par-nom.js`, `dossiersDesComptes`) :
 * un document déplacé et un document déposé demain vont au même endroit.
 *
 * ─── Usage (depuis le dossier d'installation, avec l'environnement du
 *     service — sa phrase secrète maîtresse comprise) ─────────────────────
 *
 *   node scripts/lot98-dossiers-gandi.js
 *       ESSAI À BLANC (le défaut) : par stockage et par organisation (par
 *       rang), les copies à déplacer, déjà en place, en conflit, introuvables.
 *       Rien ne bouge : ni fichier, ni base. Chaque cloud est lu une fois.
 *
 *   node scripts/lot98-dossiers-gandi.js --sauvegarder
 *       Sauvegarde de la base par l'API de SQLite, vérifiée en la rouvrant ;
 *       dit son chemin et son empreinte. Rien d'autre.
 *
 *   node scripts/lot98-dossiers-gandi.js --pause | --rallumer
 *       Met Gandi en pause, ou le rallume (`registry.setActivation`), et relit.
 *
 *   node scripts/lot98-dossiers-gandi.js --applique --sauvegarde <chemin> [--budget <secondes>]
 *       Le déplacement réel. REFUSE de partir sans : la sauvegarde vérifiée,
 *       Gandi en pause, aucune récupération en cours ni en file (relus avant
 *       ET après). S'arrête de lui-même passé le budget (420 s par défaut) :
 *       relancer LA MÊME COMMANDE reprend où il en était.
 *
 * ─── L'ordre des opérations (celui des lots 55 et 56) ────────────────────────
 *
 * Pour chaque copie : le stockage d'abord, la base ensuite, en une
 * transaction par ligne — l'écriture en base vient en DERNIER et sert de
 * marqueur « cette copie est faite ». Une interruption laisse au pire un
 * fichier déplacé dont la base n'a pas suivi ; à la relance, l'état du
 * stockage le dit (ancien absent + nouveau présent, même taille = déjà fait)
 * et la base se termine.
 *
 * ─── Ce qui n'arrive jamais ──────────────────────────────────────────────────
 *
 *   - **Rien n'est écrasé.** `rename` comme `rclone moveto` remplacent en
 *     silence un fichier existant : la cible est vérifiée libre AVANT chaque
 *     mouvement. Un nom déjà pris dans la cible arrête CE fichier — il reste
 *     où il est, sa ligne aussi — et c'est dit.
 *   - **Jamais une copie suivie d'un effacement.** Un renommage sur le
 *     stockage local, un `rclone moveto` sur chaque cloud.
 *   - **Aucun nom, aucun identifiant, aucun nom de fichier** dans ce qui
 *     s'affiche : des rangs et des nombres ; les messages d'erreur sont
 *     masqués.
 *
 * ─── Après ───────────────────────────────────────────────────────────────────
 *
 * Chaque passage finit par la VÉRIFICATION, stockage par stockage et
 * organisation par organisation : fichiers dans l'ancien dossier, dans le
 * nouveau, chemins en base qui pointent un fichier présent (de la bonne
 * taille), poids total. L'ancien dossier est retiré s'il est vide ; sinon il
 * reste, et ce qu'il contient encore se dit. Relancé sur un état déjà rangé,
 * le script ne fait rien.
 */

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const CONNECTEUR = 'gandi';
/** L'identifiant du stockage local, la copie de référence — le seul nommé ici. */
const LOCAL = 'local';
const BUDGET_PAR_DEFAUT_S = 420;
const RCLONE_TIMEOUT_MS = 300_000;
/** Relectures d'un cloud après les mouvements, avant de conclure à un écart (lot 57). */
const RELECTURES = 3;
/** Échecs de mouvement d'affilée sur un cloud avant de cesser d'y insister. */
const ECHECS_AVANT_ARRET = 3;
/** Le motif des sauvegardes de base que l'écran Optimisation reconnaît. */
const MOTIF_SAUVEGARDE = 'lot98-dossiers-gandi';

function delaiRelectureMs() {
  const demande = Number.parseInt(process.env.CRABE_LOT98_RELECTURE_DELAI_MS || '', 10);
  return Number.isFinite(demande) && demande >= 0 ? demande : 2000;
}

const attendre = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const serveur = (module) => require(path.join(__dirname, '..', 'server', module));

// ---------------------------------------------------------------------------
// Masque : rien de nominatif ne sort
// ---------------------------------------------------------------------------

/**
 * Un masque construit sur les valeurs du plan : chaque nom de dossier, chaque
 * identifiant, chaque nom de fichier, chaque nom d'utilisateur devient « … » ;
 * puis toute forme d'UUID et tout `*.pdf` restants.
 */
function fabriquerMasque(plans) {
  const sensibles = new Set();
  for (const p of plans) {
    sensibles.add(p.username);
    for (const l of p.lignes) {
      sensibles.add(String(l.account_id || ''));
      sensibles.add(String(l.filename || ''));
    }
    for (const d of p.decisions.values()) sensibles.add(d.dossier);
    for (const m of p.mouvements) {
      sensibles.add(m.dossierDe);
      sensibles.add(m.dossierVers);
    }
  }
  const liste = [...sensibles].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
  return (texte) => {
    let t = String(texte ?? '');
    for (const s of liste) t = t.split(s).join('…');
    return t
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…')
      .replace(/[^\s/'"]*\.pdf/gi, '…')
      .split('\n')[0]
      .slice(0, 300);
  };
}

// ---------------------------------------------------------------------------
// Le plan
// ---------------------------------------------------------------------------

/**
 * Pour chaque compte crabe qui a des documents Gandi : la décision de dossier
 * de chaque organisation (la MÊME fonction que les dépôts), son rang (l'ordre
 * de sa première ligne), et chaque copie enregistrée dont le dossier n'est pas
 * le bon — un mouvement par copie.
 */
function construirePlan({ connectorId = CONNECTEUR } = {}) {
  const db = serveur('db/db');
  const registry = serveur('connectors/registry');
  const destinations = serveur('destinations');
  const invoices = serveur('invoices');
  const accountIds = serveur('connectors/account-id');
  const dossierParNom = serveur('dossier-par-nom');

  const nomDuCompte = dossierParNom.nommeur(connectorId);
  if (!nomDuCompte) {
    throw new Error(`le connecteur « ${connectorId} » ne nomme pas ses comptes : rien à ranger par nom.`);
  }
  const connectorName = registry.manifest(connectorId).name;
  const actives = destinations.activeDestinations();
  const utilisateurs = db.get()
    .prepare('SELECT DISTINCT u.id, u.username FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.connector_id = ? ORDER BY u.id')
    .all(connectorId);

  return utilisateurs.map((u) => {
    const contexte = { username: u.username, connectorName };
    const faits = dossierParNom.faitsDuConnecteur(u.id, connectorId, { ...contexte, nomDuCompte });
    const decisions = dossierParNom.dossiersDesComptes(faits);
    const rangs = new Map();
    for (const l of faits.lignes) {
      const cle = accountIds.normalize(l.account_id);
      if (cle && !rangs.has(cle)) rangs.set(cle, rangs.size + 1);
    }

    const mouvements = [];
    const enPlace = [];
    const horsForme = [];
    const inactifs = [];
    for (const l of faits.lignes) {
      const cle = accountIds.normalize(l.account_id);
      const decision = decisions.get(cle);
      const rang = rangs.get(cle);
      for (const [dest, entree] of Object.entries(invoices.parseDestinations(l.destinations))) {
        if (!entree?.ok || !entree.path) continue;
        const lu = dossierParNom.dossierDuChemin(entree.path, contexte);
        const base = { ligne: l.id, cle, rang, dest, taille: l.size_bytes, de: entree.path };
        if (!lu || !decision) {
          horsForme.push(base);
          continue;
        }
        const copie = { ...base, dossierDe: lu.dossier, dossierVers: decision.dossier, regle: decision.regle };
        if (lu.dossier === decision.dossier) {
          enPlace.push(copie);
        } else if (!actives.includes(dest)) {
          inactifs.push(copie);
        } else {
          mouvements.push({ ...copie, vers: dossierParNom.cheminDansLeDossier(entree.path, decision.dossier, contexte) });
        }
      }
    }
    return {
      userId: u.id,
      username: u.username,
      connectorName,
      contexte,
      decisions,
      rangs,
      lignes: faits.lignes,
      mouvements,
      enPlace,
      horsForme,
      inactifs,
    };
  });
}

// ---------------------------------------------------------------------------
// Les stockages
// ---------------------------------------------------------------------------

/**
 * Les clouds actifs, sous la forme que les commandes attendent — la
 * configuration RELUE à chaque commande (lot 58), avec ses rappels : un jeton
 * renouvelé est rangé, une session refusée est marquée, la reconnexion joue
 * dans un budget, comme pour l'harmonisation des noms.
 */
function chargerClouds({ noter = () => {} } = {}) {
  const destinations = serveur('destinations');
  const catalogue = serveur('destinations/catalogue');
  const budget = destinations.budgetReconnexions();
  const clouds = new Map();
  for (const id of destinations.activeDestinations()) {
    if (id === LOCAL) continue;
    const compteurs = { secretsRafraichis: 0, sessionRefusee: 0, reconnexions: 0 };
    clouds.set(id, {
      destId: id,
      nom: catalogue.brand(id).name || id,
      compteurs,
      dest: () => {
        const driver = destinations.driverFor(id);
        const conf = destinations.readConfig(id);
        const n = driver?.normalizeConf ? driver.normalizeConf(conf) : conf;
        return {
          remoteName: n?.remoteName || 'crabe',
          basePath: n?.basePath || 'crabe',
          rcloneConfig: n?.rcloneConfig,
          type: n?.type,
          onSecretsRafraichis: (c) => {
            compteurs.secretsRafraichis++;
            return n?.onSecretsRafraichis?.(c);
          },
          onSessionRefusee: (t) => {
            compteurs.sessionRefusee++;
            return n?.onSessionRefusee?.(t);
          },
          reconnexion: (texte) => destinations.preparerReconnexion(id, texte, {
            budget,
            surEvenement: (type) => {
              compteurs.reconnexions++;
              noter(`${catalogue.brand(id).name || id} : reconnexion ${type}`);
            },
          }),
          refusAvantService: n?.refusAvantService,
        };
      },
    });
  }
  return clouds;
}

/** Une commande rclone sur un cloud, configuration relue à l'instant. */
async function commande(cloud, args) {
  const rclone = serveur('destinations/rclone');
  return rclone.withConfig(cloud.dest(), (confFile) => rclone.run(args, { confFile, timeout: RCLONE_TIMEOUT_MS }));
}

/** L'adresse du dossier du connecteur sur un cloud : `remote:<base>/<utilisateur>/<Nom>`. */
function baseCloud(cloud, plan) {
  const rclone = serveur('destinations/rclone');
  const paths = serveur('destinations/paths');
  return rclone.adresse(cloud.dest(), `${paths.safeSegment(plan.username, 'inconnu')}/${paths.safeSegment(plan.connectorName, 'connecteur')}`);
}

/** Le chemin d'une copie RELATIF au dossier du connecteur, ou `null` s'il n'en est pas. */
function relatif(chemin, base) {
  const prefixe = `${base}/`;
  return String(chemin).startsWith(prefixe) ? String(chemin).slice(prefixe.length) : null;
}

/** Tout ce que le dossier du connecteur contient sur un cloud : relatif → taille. Vide s'il n'existe pas. */
async function listerCloud(cloud, plan) {
  try {
    const { stdout } = await commande(cloud, ['lsjson', '-R', '--files-only', baseCloud(cloud, plan)]);
    return new Map(JSON.parse(stdout || '[]').map((f) => [f.Path, f.Size]));
  } catch (err) {
    if (/directory not found/i.test(`${err.message}\n${err.stderr || ''}`)) return new Map();
    throw err;
  }
}

/** Le dossier du connecteur sur le stockage local : `<racine>/<utilisateur>/<Nom>`. */
function baseLocale(plan) {
  const destinations = serveur('destinations');
  const paths = serveur('destinations/paths');
  const racine = destinations.readConfig(LOCAL)?.path;
  return path.join(racine, paths.safeSegment(plan.username, 'inconnu'), paths.safeSegment(plan.connectorName, 'connecteur'));
}

/** Tout ce que le dossier du connecteur contient sur le stockage local : relatif → taille. */
function listerLocal(plan) {
  const base = baseLocale(plan);
  const trouves = new Map();
  if (!fs.existsSync(base)) return { base, trouves };
  (function parcourir(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) parcourir(path.join(dir, e.name), r);
      else trouves.set(r, fs.statSync(path.join(dir, e.name)).size);
    }
  })(base, '');
  return { base, trouves };
}

/** L'état d'une copie devant le stockage : où est le fichier, de quelle taille. */
function etatDe(m, trouves, base) {
  const de = relatif(m.de, base);
  const vers = relatif(m.vers, base);
  if (de === null || vers === null) return 'hors-forme';
  const deLa = trouves.has(de);
  const versLa = trouves.has(vers);
  if (deLa && !versLa) return 'a-faire';
  if (!deLa && versLa) return trouves.get(vers) === m.taille ? 'deja' : 'taille-differente';
  if (deLa && versLa) return 'conflit';
  return 'introuvable';
}

// ---------------------------------------------------------------------------
// La base
// ---------------------------------------------------------------------------

/**
 * Le chemin d'UNE copie suit son fichier : une transaction, la ligne relue,
 * l'entrée de ce stockage changée si — et seulement si — elle porte encore
 * l'ancien chemin. Tout le reste de la colonne est rendu tel quel.
 */
function suivreEnBase(m) {
  const db = serveur('db/db');
  return db.get().transaction(() => {
    const row = db.get().prepare('SELECT destinations FROM invoices WHERE id = ?').get(m.ligne);
    if (!row) return false;
    let d;
    try {
      d = JSON.parse(row.destinations || '{}');
    } catch {
      return false;
    }
    if (!d?.[m.dest] || d[m.dest].path !== m.de) return false;
    d[m.dest] = { ...d[m.dest], path: m.vers };
    db.get().prepare('UPDATE invoices SET destinations = ? WHERE id = ?').run(JSON.stringify(d), m.ligne);
    return true;
  })();
}

// ---------------------------------------------------------------------------
// Les gardes du geste réel
// ---------------------------------------------------------------------------

function recuperationsEnCours() {
  const db = serveur('db/db');
  return {
    ouvertes: db.get().prepare('SELECT COUNT(*) AS n FROM run_logs WHERE finished_at IS NULL').get().n,
    enFile: db.get().prepare('SELECT COUNT(*) AS n FROM run_queue').get().n,
  };
}

function gandiEnPause(plans, connectorId = CONNECTEUR) {
  const db = serveur('db/db');
  return plans.map((p) => {
    const r = db.get().prepare('SELECT disabled_at FROM connector_installs WHERE user_id = ? AND connector_id = ?')
      .get(p.userId, connectorId);
    return { userId: p.userId, installe: !!r, enPause: !r || !!r.disabled_at, depuis: r?.disabled_at || null };
  });
}

function empreinte(fichier) {
  return nodeCrypto.createHash('sha256').update(fs.readFileSync(fichier)).digest('hex');
}

/** Sauvegarde de la base, vérifiée en la rouvrant (même principe que l'harmonisation). */
async function sauvegarder() {
  const db = serveur('db/db');
  const { config } = serveur('config');
  const Database = require('better-sqlite3');
  const horodatage = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const chemin = path.join(config.dataDir, `crabe.db.avant-${MOTIF_SAUVEGARDE}-${horodatage}`);
  const compte = (base) => base.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM invoices').get();
  const lignesGandi = (base) => base.prepare("SELECT id, account_id, destinations FROM invoices WHERE connector_id = ? ORDER BY id").all(CONNECTEUR);
  for (let essai = 0; essai < 2; essai++) {
    const avant = compte(db.get());
    const gandiAvant = JSON.stringify(lignesGandi(db.get()));
    await db.get().backup(chemin);
    fs.chmodSync(chemin, 0o600);
    const copie = new Database(chemin, { readonly: true, fileMustExist: true });
    const integrite = copie.pragma('integrity_check', { simple: true });
    const sauve = compte(copie);
    const gandiSauve = JSON.stringify(lignesGandi(copie));
    copie.close();
    const apres = compte(db.get());
    if (integrite === 'ok' && sauve.c === avant.c && sauve.m === avant.m && sauve.c === apres.c && sauve.m === apres.m
      && gandiSauve === gandiAvant) {
      return { chemin, sha256: empreinte(chemin), octets: fs.statSync(chemin).size, invoices: sauve, lignesGandi: JSON.parse(gandiSauve).length };
    }
  }
  fs.rmSync(chemin, { force: true });
  throw new Error('la sauvegarde n\'a pas pu être vérifiée : des documents arrivaient pendant la copie. Relancez une fois les récupérations finies.');
}

/** La sauvegarde annoncée : présente, intègre, avec les mêmes lignes Gandi que la base. */
function verifierSauvegarde(chemin) {
  const db = serveur('db/db');
  const Database = require('better-sqlite3');
  if (!chemin || !fs.existsSync(chemin)) return `sauvegarde introuvable (${chemin ? 'chemin absent' : 'aucun chemin donné'})`;
  if (!path.basename(chemin).startsWith(`crabe.db.avant-${MOTIF_SAUVEGARDE}-`)) return 'ce fichier n\'est pas une sauvegarde de ce lot';
  let copie;
  try {
    copie = new Database(chemin, { readonly: true, fileMustExist: true });
    if (copie.pragma('integrity_check', { simple: true }) !== 'ok') return 'sauvegarde non intègre';
    const ids = (base) => base.prepare('SELECT id FROM invoices WHERE connector_id = ? ORDER BY id').all(CONNECTEUR).map((r) => r.id).join(',');
    if (ids(copie) !== ids(db.get())) return 'la sauvegarde ne porte pas les mêmes lignes Gandi que la base';
  } catch (err) {
    return `sauvegarde illisible (${err.code || 'erreur'})`;
  } finally {
    copie?.close();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Le passage : état, mouvements, base, ancien dossier, vérification
// ---------------------------------------------------------------------------

function compteur() {
  return { aDeplacer: 0, deplaces: 0, dejaFaits: 0, conflits: 0, introuvables: 0, tailleDifferente: 0, horsForme: 0, enAttente: 0, echecs: 0, baseSuivie: 0, baseNonSuivie: 0 };
}

/**
 * Un passage complet. À blanc (`applique: false`) : rien n'est écrit, ni
 * fichier ni base — l'état se lit, se compte, se rend. Réel : chaque copie
 * « à faire » se déplace (cible vérifiée libre juste avant), la base suit.
 *
 * Un cloud se lit UNE fois avant (Proton Drive : ≈ 28 s pour l'arbre de
 * Gandi), puis se relit après les mouvements — patiemment, trois fois au plus
 * — et cette dernière lecture sert aussi à juger l'ancien dossier et à la
 * vérification.
 *
 * @returns {Promise<object>} le rapport — rangs et nombres seulement
 */
async function passer(plans, { applique = false, budgetMs = BUDGET_PAR_DEFAUT_S * 1000, noter = () => {}, maintenant = Date.now } = {}) {
  const debut = maintenant();
  const masque = fabriquerMasque(plans);
  const rapport = { applique, comptes: [] };

  for (const plan of plans) {
    const clouds = chargerClouds({ noter });
    const parStockage = {};
    const ordreStockages = [LOCAL, ...clouds.keys()];
    const nomDe = (dest) => serveur('destinations/catalogue').brand(dest).name || dest;
    const dernieres = new Map(); // stockage → { lecture, base } la plus récente

    for (const dest of ordreStockages) {
      const ici = plan.mouvements.filter((m) => m.dest === dest);
      const concerne = ici.length || plan.enPlace.some((m) => m.dest === dest) || plan.horsForme.some((m) => m.dest === dest);
      if (!concerne) continue;
      const parOrg = new Map([...plan.rangs.values()].map((r) => [r, compteur()]));
      const c = (m) => parOrg.get(m.rang) || parOrg.set(m.rang, compteur()).get(m.rang);
      for (const m of plan.horsForme.filter((x) => x.dest === dest)) c(m).horsForme++;
      const s = { nom: nomDe(dest), parOrganisation: parOrg, avant: null, apres: null, ancienDossier: {}, erreurs: [] };
      parStockage[dest] = s;
      const cloud = clouds.get(dest);
      const lire = async () => (dest === LOCAL ? listerLocal(plan).trouves : listerCloud(cloud, plan));
      const base = dest === LOCAL ? baseLocale(plan) : baseCloud(cloud, plan);

      // ── L'état avant ──
      let lecture;
      try {
        lecture = await lire();
      } catch (err) {
        s.erreurs.push(`lecture impossible : ${masque(err.message)}`);
        continue;
      }
      s.avant = photographie(plan, dest, lecture, base);
      const etats = new Map(ici.map((m) => [m, etatDe(m, lecture, base)]));
      for (const [m, e] of etats) {
        if (e === 'a-faire') c(m).aDeplacer++;
        else if (e === 'deja') c(m).dejaFaits++;
        else if (e === 'conflit') c(m).conflits++;
        else if (e === 'introuvable') c(m).introuvables++;
        else if (e === 'taille-differente') c(m).tailleDifferente++;
        else c(m).horsForme++;
      }
      if (!applique) continue;

      // ── Les mouvements : la cible relue libre, rien d'écrasé ──
      const aVerifier = [];
      let echecsDeSuite = 0;
      for (const [m, e] of etats) {
        if (e === 'deja') {
          aVerifier.push(m);
          continue;
        }
        if (e !== 'a-faire') continue;
        if (maintenant() - debut > budgetMs || echecsDeSuite >= ECHECS_AVANT_ARRET) {
          c(m).aDeplacer--;
          c(m).enAttente++;
          continue;
        }
        try {
          if (dest === LOCAL) {
            // Relue JUSTE AVANT : `rename` remplacerait en silence.
            if (fs.existsSync(m.vers)) {
              c(m).aDeplacer--;
              c(m).conflits++;
              continue;
            }
            fs.mkdirSync(path.dirname(m.vers), { recursive: true });
            fs.renameSync(m.de, m.vers);
          } else {
            // La cible a été lue libre par la lecture de ce passage ; rien
            // d'autre n'écrit dans ce dossier pendant le geste (Gandi en
            // pause, aucune récupération en cours ni en file).
            await commande(cloud, ['moveto', m.de, m.vers]);
          }
          c(m).deplaces++;
          echecsDeSuite = 0;
          aVerifier.push(m);
        } catch (err) {
          c(m).echecs++;
          echecsDeSuite++;
          if (s.erreurs.length < 5) s.erreurs.push(`organisation ${m.rang} : ${masque(err.message)}`);
          if (echecsDeSuite === ECHECS_AVANT_ARRET) {
            s.erreurs.push(`${ECHECS_AVANT_ARRET} échecs d'affilée : ce stockage n'est plus sollicité pendant ce passage`);
          }
        }
      }

      // ── La relecture (patiente pour un cloud, lot 57), puis la base ──
      const vu = (relu, m) => relu.get(relatif(m.vers, base)) === m.taille && !relu.has(relatif(m.de, base));
      let relu = null;
      const lectures = dest === LOCAL ? 1 : RELECTURES;
      for (let i = 1; i <= lectures; i++) {
        try {
          relu = await lire();
        } catch (err) {
          relu = null;
          s.erreurs.push(`relecture impossible : ${masque(err.message)}`);
        }
        if (relu && aVerifier.every((m) => vu(relu, m))) break;
        if (i < lectures) await attendre(delaiRelectureMs());
      }
      for (const m of aVerifier) {
        if (relu && vu(relu, m) && suivreEnBase(m)) c(m).baseSuivie++;
        else c(m).baseNonSuivie++;
      }

      // ── L'ancien dossier : retiré s'il est vide, sinon il reste ──
      const anciens = new Map();
      for (const m of ici) anciens.set(m.dossierDe, m.rang);
      for (const [dossier, rang] of anciens) {
        if (!relu) {
          s.ancienDossier[rang] = 'non relu : laissé tel quel';
          continue;
        }
        const restants = [...relu.keys()].filter((r) => r.startsWith(`${dossier}/`)).length;
        if (restants) {
          s.ancienDossier[rang] = `garde ${restants} fichier(s) : il reste`;
          continue;
        }
        try {
          if (dest === LOCAL) {
            const chemin = path.join(base, dossier);
            if (!fs.existsSync(chemin)) {
              s.ancienDossier[rang] = 'déjà absent';
              continue;
            }
            retirerDossiersVides(chemin);
          } else {
            await commande(cloud, ['rmdirs', `${base}/${dossier}`]);
          }
          s.ancienDossier[rang] = 'vide : retiré';
        } catch (err) {
          s.ancienDossier[rang] = /directory not found/i.test(`${err.message}\n${err.stderr || ''}`)
            ? 'déjà absent'
            : `vide, mais non retiré (${masque(err.message)})`;
        }
      }
      if (relu) dernieres.set(dest, { lecture: relu, base });
    }

    // ── La vérification : la dernière lecture de chaque stockage, la base relue ──
    if (applique) {
      const recharge = construirePlan().find((p) => p.userId === plan.userId) || plan;
      for (const [dest, s] of Object.entries(parStockage)) {
        const d = dernieres.get(dest);
        s.apres = d ? photographie(recharge, dest, d.lecture, d.base) : null;
      }
    }
    for (const [dest, s] of Object.entries(parStockage)) s.compteurs = clouds.get(dest)?.compteurs || null;
    rapport.comptes.push({ userId: plan.userId, organisations: plan.rangs.size, parStockage, inactifs: plan.inactifs.length });
  }
  return rapport;
}

/**
 * Une photographie du dossier du connecteur sur un stockage, rapportée aux
 * organisations : par rang, les fichiers dans le dossier à l'identifiant et
 * dans le dossier décidé ; les chemins en base qui pointent un fichier
 * présent de la bonne taille ; le poids total.
 */
function photographie(plan, dest, trouves, base) {
  const paths = serveur('destinations/paths');
  const invoices = serveur('invoices');
  const parRang = {};
  for (const [cle, rang] of plan.rangs) {
    const decision = plan.decisions.get(cle);
    const identifiant = paths.safeSegment(cle, 'defaut');
    const compter = (dossier) => [...trouves.keys()].filter((r) => r.startsWith(`${dossier}/`)).length;
    parRang[rang] = {
      dossierIdentifiant: compter(identifiant),
      dossierDecide: decision && decision.dossier !== identifiant ? compter(decision.dossier) : null,
      regle: decision?.regle || null,
    };
  }
  let enBase = 0;
  let presents = 0;
  for (const l of plan.lignes) {
    const e = invoices.parseDestinations(l.destinations)[dest];
    if (!e?.ok || !e.path) continue;
    enBase++;
    const r = relatif(e.path, base);
    if (r !== null && trouves.get(r) === l.size_bytes) presents++;
  }
  let poids = 0;
  for (const t of trouves.values()) poids += t;
  return { fichiers: trouves.size, poids, parRang, cheminsEnBase: enBase, cheminsQuiPointentUnFichier: presents };
}

/** Retire un dossier et ses sous-dossiers s'ils sont vides — jamais un fichier. */
function retirerDossiersVides(dossier) {
  if (!fs.existsSync(dossier)) return;
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (e.isDirectory()) retirerDossiersVides(path.join(dossier, e.name));
  }
  fs.rmdirSync(dossier);
}

// ---------------------------------------------------------------------------
// Le rapport, lisible
// ---------------------------------------------------------------------------

/** La règle de `dossiersDesComptes`, dite en mots. */
const REGLES = {
  nom: 'au nom',
  homonyme: 'au nom, homonyme',
  'deja-employe': 'déjà employé',
  identifiant: 'identifiant, faute de nom',
};

function ecrireRapport(rapport, ecrire = console.log) {
  ecrire(rapport.applique ? '— DÉPLACEMENT RÉEL —' : '— ESSAI À BLANC : rien n\'est déplacé, rien n\'est écrit —');
  for (const compte of rapport.comptes) {
    ecrire(`Compte crabe n° ${compte.userId} : ${compte.organisations} organisation(s)${compte.inactifs ? `, ${compte.inactifs} copie(s) sur un stockage inactif, non touchées` : ''}.`);
    for (const s of Object.values(compte.parStockage)) {
      ecrire(`  ${s.nom}`);
      for (const [rang, c] of s.parOrganisation) {
        const morceaux = Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
        ecrire(`    organisation ${rang} : ${morceaux.join(', ') || 'rien à faire'}`);
      }
      for (const [nom, photo] of [['avant', s.avant], ['après', s.apres]]) {
        if (!photo) continue;
        const orgs = Object.entries(photo.parRang)
          .map(([rang, p]) => `org. ${rang} : ${p.dossierIdentifiant} à l'identifiant, ${p.dossierDecide ?? '—'} au dossier décidé (${REGLES[p.regle] || p.regle})`)
          .join(' ; ');
        ecrire(`    ${nom} : ${photo.fichiers} fichier(s), ${photo.poids} octets ; ${orgs} ; chemins en base ${photo.cheminsQuiPointentUnFichier}/${photo.cheminsEnBase} pointent un fichier présent de la bonne taille`);
      }
      for (const [rang, etat] of Object.entries(s.ancienDossier)) ecrire(`    ancien dossier de l'organisation ${rang} : ${etat}`);
      if (s.compteurs) ecrire(`    session : ${s.compteurs.secretsRafraichis} jeton(s) renouvelé(s) et rangé(s), ${s.compteurs.sessionRefusee} refus, ${s.compteurs.reconnexions} reconnexion(s)`);
      for (const e of s.erreurs) ecrire(`    ⚠ ${e}`);
    }
  }
}

/**
 * Les nombres d'un rapport, pour le journal de l'application : jamais un nom.
 * `null` quand le passage n'a RIEN fait ni rien trouvé à dire — relancé sur un
 * état rangé, le script n'écrit pas même cette ligne.
 */
function phraseDuJournal(rapport) {
  let deplaces = 0;
  let conflits = 0;
  let attente = 0;
  let ecarts = 0;
  const parNom = [];
  for (const compte of rapport.comptes) {
    for (const s of Object.values(compte.parStockage)) {
      let ici = 0;
      for (const c of s.parOrganisation.values()) {
        deplaces += c.baseSuivie;
        ici += c.baseSuivie;
        conflits += c.conflits;
        attente += c.enAttente + c.aDeplacer - c.deplaces;
        ecarts += c.introuvables + c.tailleDifferente + c.horsForme + c.baseNonSuivie;
      }
      ecarts += s.erreurs.length;
      parNom.push(`${s.nom} ${ici}`);
    }
  }
  if (!deplaces && !conflits && !attente && !ecarts) return null;
  return `Dossiers de Gandi (lot 98) : ${deplaces} copie(s) rangée(s) dans le dossier au nom de leur organisation `
    + `(${parNom.join(', ')}), chemins en base suivis ; ${conflits} conflit(s), rien d'écrasé`
    + `${attente > 0 ? ` ; ${attente} en attente du passage suivant` : ''}.`;
}

// ---------------------------------------------------------------------------
// La ligne de commande
// ---------------------------------------------------------------------------

function argument(argv, nom) {
  const i = argv.indexOf(nom);
  return i >= 0 ? argv[i + 1] : null;
}

/**
 * La commande. `argv` et `ecrire` se remplacent dans les essais : la base y
 * est déjà ouverte (`db.open` rend celle qui l'est), la clé déjà dérivée.
 * Rend le code de sortie : 0, ou 2 pour un refus (rien n'a été touché).
 */
async function principal(argv = process.argv, { ecrire = console.log, ecrireErreur = console.error } = {}) {
  const crypto = serveur('crypto');
  const db = serveur('db/db');
  await crypto.init();
  db.open();
  const registry = serveur('connectors/registry');
  registry.load();

  if (argv.includes('--sauvegarder')) {
    const s = await sauvegarder();
    ecrire(`Sauvegarde vérifiée : ${s.chemin}`);
    ecrire(`  sha256 ${s.sha256} — ${s.octets} octets — invoices ${s.invoices.c} / MAX(id) ${s.invoices.m} — ${s.lignesGandi} lignes Gandi`);
    return 0;
  }

  const plans = construirePlan();
  if (argv.includes('--pause') || argv.includes('--rallumer')) {
    const actif = argv.includes('--rallumer');
    for (const p of plans) registry.setActivation(p.userId, CONNECTEUR, actif);
    for (const e of gandiEnPause(plans)) {
      ecrire(`Compte crabe n° ${e.userId} : Gandi ${e.enPause ? `en pause depuis ${e.depuis} (UTC)` : 'en service'}.`);
    }
    return 0;
  }

  const applique = argv.includes('--applique');
  if (applique) {
    const refus = [];
    const motif = verifierSauvegarde(argument(argv, '--sauvegarde'));
    if (motif) refus.push(motif);
    const pauses = gandiEnPause(plans);
    if (pauses.some((p) => !p.enPause)) refus.push('Gandi n\'est pas en pause (--pause d\'abord)');
    const avant = recuperationsEnCours();
    if (avant.ouvertes || avant.enFile) refus.push(`${avant.ouvertes} récupération(s) en cours, ${avant.enFile} en file`);
    if (refus.length) {
      ecrireErreur(`Refusé : ${refus.join(' ; ')}. Rien n'a été touché.`);
      return 2;
    }
    ecrire(`Avant : ${avant.ouvertes} récupération(s) en cours, ${avant.enFile} en file ; Gandi en pause ; sauvegarde vérifiée.`);
  }

  const budget = Number.parseInt(argument(argv, '--budget') || '', 10);
  const rapport = await passer(plans, {
    applique,
    budgetMs: (Number.isFinite(budget) && budget > 0 ? budget : BUDGET_PAR_DEFAUT_S) * 1000,
    noter: (t) => ecrire(`  … ${t}`),
  });
  ecrireRapport(rapport, ecrire);

  if (applique) {
    const apres = recuperationsEnCours();
    ecrire(`Après : ${apres.ouvertes} récupération(s) en cours, ${apres.enFile} en file.`);
    const phrase = phraseDuJournal(rapport);
    if (phrase) {
      serveur('applog').info('destinations', phrase, {});
      ecrire(`Journal : ${phrase}`);
    } else {
      ecrire('Journal : rien n\'a bougé, rien n\'est écrit.');
    }
  }
  return 0;
}

if (require.main === module) {
  principal()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`ARRÊT — ${String(err.message).split('\n')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '…').replace(/[^\s/'"]*\.pdf/gi, '…')}`);
      console.error('Relancez LA MÊME COMMANDE une fois la cause réglée : ce qui est fait est reconnu, rien n\'est refait.');
      process.exit(1);
    });
}

module.exports = {
  CONNECTEUR,
  LOCAL,
  MOTIF_SAUVEGARDE,
  principal,
  construirePlan,
  passer,
  sauvegarder,
  verifierSauvegarde,
  gandiEnPause,
  recuperationsEnCours,
  ecrireRapport,
  phraseDuJournal,
  fabriquerMasque,
  etatDe,
  relatif,
};
