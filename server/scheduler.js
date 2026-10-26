'use strict';

/**
 * Exécution des connecteurs : pipeline de récupération + planification cron.
 *
 * Le pipeline est le même qu'il soit déclenché à la main depuis l'UI ou par
 * le scheduler ; seul le champ `trigger` de run_logs change.
 *
 * Deux corrections du lot 3 :
 *
 *   - **une tâche cron par installation réelle**, et non par connecteur du
 *     catalogue. La production armait 13 tâches pour un seul connecteur
 *     installé ; la donnée vit maintenant dans `user_connector_schedules`
 *     (voir server/schedules.js) ;
 *   - **verrou anti-exécution concurrente** : un scraping Playwright déjà en
 *     cours pour un couple (utilisateur, connecteur) ne peut pas être relancé
 *     en parallèle, ni par l'accueil, ni par le cron, ni par l'administration.
 */

const cron = require('node-cron');
const db = require('./db/db');
const registry = require('./connectors/registry');
const destinations = require('./destinations');
const invoices = require('./invoices');
const schedules = require('./schedules');
const applog = require('./applog');
const settings = require('./settings');
const notifications = require('./notifications');
const tz = require('./timezone');
const messagesEchec = require('./connectors/messages-echec');
const causeEchec = require('./connectors/cause-echec');
const rapportEchec = require('./rapport-echec');
const eteindreNavigateur = require('./connectors/eteindre-navigateur');
const profilPersistant = require('./connectors/profil-persistant');
const siteHorsLigne = require('./connectors/site-hors-ligne');
const { config } = require('./config');

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/**
 * Exécutions en cours, clé « userId:connectorId » → instant de départ.
 * Un simple verrou en mémoire suffit : crabe est un unique processus Node.
 * @type {Map<string, string>}
 */
const running = new Map();

const lockKey = (userId, connectorId) => `${userId}:${connectorId}`;

/** Une récupération est-elle déjà en cours pour ce couple ? */
function isRunning(userId, connectorId) {
  return running.has(lockKey(userId, connectorId));
}

/** Couples en cours d'exécution, pour l'affichage de l'accueil. */
function runningPairs() {
  return [...running.entries()].map(([key, startedAt]) => {
    const [userId, connectorId] = key.split(':');
    return { userId: Number(userId), connectorId, startedAt };
  });
}

// ---------------------------------------------------------------------------
// La file d'attente — une seule récupération à la fois pour tout crabe (lot 90)
// ---------------------------------------------------------------------------
//
// Le 01/10/2026 à 03:00, les 22 récupérations programmées du jour sont parties
// à la même seconde : le verrou ci-dessus ne couvre qu'un couple (utilisateur,
// connecteur), et chaque tâche cron appelait le pipeline directement. Dans les
// 4 Go du conteneur, tous ces navigateurs ouverts ensemble ont figé crabe
// 38 heures, jusqu'à ce que le noyau tue un de ses processus faute de
// mémoire ; vingt récupérations ont échoué, six autres ne sont jamais parties.
//
// Désormais TOUTE récupération passe par ici : `runForUser` dépose la demande
// dans la file, et la pompe les sert une par une, dans l'ordre d'arrivée.
// Deux règles s'ajoutent à l'ordre :
//
//   - une demande faite par UNE PERSONNE (déclencheur autre que `cron`) passe
//     devant les programmées qui attendent — certaines sessions ne vivent que
//     trente minutes après la connexion, les ranger derrière vingt programmées
//     les tuerait — mais n'interrompt jamais celle qui tourne, et reste
//     derrière les demandes de personne arrivées avant elle ;
//   - un couple (utilisateur, connecteur) ne figure qu'UNE fois : le
//     redemander pendant qu'il attend ou qu'il tourne ne l'ajoute pas, et le
//     dit (409).
//
// Ce qui attend est écrit dans `run_queue` (migration 58) : un arrêt de crabe
// ne perd pas la file, le démarrage suivant la reprend une seule fois, dans
// l'ordre. La ligne est retirée de la table AU DÉPART de l'exécution : la
// récupération qui TOURNAIT pendant un arrêt n'est jamais relancée — si c'est
// elle qui a fait tomber crabe, la relancer referait la boucle.

const PRIORITE_PROGRAMMEE = 0;
const PRIORITE_PERSONNE = 1;

/** @type {Array<object>} Les demandes en attente, dans l'ordre où elles seront servies. */
const fileAttente = [];
/** Clés `userId:connectorId` en file — le refus de doublon se lit d'un regard. */
const clesEnFile = new Set();
let pompeEnMarche = false;

const prioriteDe = (trigger) => (trigger === 'cron' ? PRIORITE_PROGRAMMEE : PRIORITE_PERSONNE);

/**
 * Ce qui passe avant une demande au rang `position` de la file : les demandes
 * devant elle, plus celle qui tourne. C'est le chiffre montré à l'écran.
 */
const devantAuRang = (position) => position + running.size;

/** L'attente d'un couple : `{ devant, enqueuedAt }`, ou null s'il n'attend pas. */
function attentePour(userId, connectorId) {
  const position = fileAttente.findIndex((e) => e.key === lockKey(userId, connectorId));
  if (position === -1) return null;
  return { devant: devantAuRang(position), enqueuedAt: fileAttente[position].enqueuedAt };
}

/** Les couples en attente, dans l'ordre de la file — pour l'affichage. */
function pairesEnAttente() {
  return fileAttente.map((e, position) => ({
    userId: e.userId,
    connectorId: e.connectorId,
    trigger: e.trigger,
    enqueuedAt: e.enqueuedAt,
    devant: devantAuRang(position),
  }));
}

/**
 * Insère selon la priorité : une demande de personne passe devant les
 * programmées qui attendent, mais derrière les demandes de personne déjà là —
 * à priorité égale, l'ordre d'arrivée reste la règle.
 */
function insererSelonPriorite(entree) {
  let position = fileAttente.length;
  if (entree.priorite > PRIORITE_PROGRAMMEE) {
    const premierMoinsPrioritaire = fileAttente.findIndex((e) => e.priorite < entree.priorite);
    if (premierMoinsPrioritaire !== -1) position = premierMoinsPrioritaire;
  }
  fileAttente.splice(position, 0, entree);
  return position;
}

/** Dépose une demande dans la file et rend la promesse de son résultat. */
function mettreEnFile(user, connectorId, trigger, options) {
  const entree = {
    key: lockKey(user.id, connectorId),
    userId: user.id,
    connectorId,
    trigger,
    options,
    priorite: prioriteDe(trigger),
    attenteDepuis: Date.now(),
    enqueuedAt: new Date().toISOString(),
  };
  entree.promesse = new Promise((resoudre, rejeter) => {
    entree.resoudre = resoudre;
    entree.rejeter = rejeter;
  });

  // La demande survit à un arrêt de crabe (R3) : écrite en base AVANT d'entrer
  // dans la file en mémoire — si l'écriture échoue, rien n'est à moitié fait.
  // Les options ne portent jamais de donnée personnelle (seul `toutLHistorique`
  // y voyage).
  entree.rowId = db
    .get()
    .prepare(
      `INSERT INTO run_queue (user_id, connector_id, trigger, priorite, options)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      connectorId,
      trigger,
      entree.priorite,
      Object.keys(options || {}).length ? JSON.stringify(options) : null
    ).lastInsertRowid;

  const position = insererSelonPriorite(entree);
  clesEnFile.add(entree.key);

  const devant = devantAuRang(position);
  applog.info(
    'scheduler',
    `${connectorId} : récupération mise en file d'attente — rang ${position + 1}, `
      + `${devant} récupération${devant > 1 ? 's' : ''} avant elle.`,
    { userId: user.id, username: user.username }
  );

  // Sans `await` : la pompe sert toute la file, pas seulement cette demande.
  // Le `.catch` est un filet — elle rejette elle-même chaque demande en échec.
  pomperLaFile().catch((err) => console.error('[scheduler] pompe de la file :', err));
  return entree.promesse;
}

/**
 * Sert la file, une demande à la fois, jusqu'à ce qu'elle soit vide. Une seule
 * pompe tourne à la fois : c'est elle, et rien d'autre, qui démarre une
 * récupération — c'est ce qui garantit « une seule en cours pour tout crabe ».
 */
async function pomperLaFile() {
  if (pompeEnMarche) return;
  pompeEnMarche = true;
  try {
    while (fileAttente.length) {
      const entree = fileAttente.shift();
      clesEnFile.delete(entree.key);
      // Bilan du 25/10/2026 : une erreur ici (écriture en base refusée, disque
      // plein) remontait de la pompe sans que personne ne l'attende — appelée
      // sans `await` —, un rejet non géré qui tuait le processus, et la
      // demande sortie de la file n'était jamais résolue. Elle est désormais
      // rejetée avec sa cause, et la pompe passe à la suivante.
      try {
        // Retirée de la table AVANT le départ : une récupération qui TOURNE au
        // moment d'un arrêt n'est pas reprise (R3) — c'est le balayage du
        // démarrage qui marque sa ligne en échec, comme avant ce lot.
        db.get().prepare('DELETE FROM run_queue WHERE id = ?').run(entree.rowId);
        await servir(entree);
      } catch (err) {
        try {
          applog.error(
            'scheduler',
            `${entree.connectorId} : la récupération n'a pas pu partir de la file d'attente — `
              + `${err?.message || err}.`,
            { userId: entree.userId }
          );
        } catch { /* le journal est en base : s'il est en panne, la console suffit */ }
        console.error('[scheduler] file d\'attente :', err);
        entree.rejeter(err);
      }
    }
  } finally {
    pompeEnMarche = false;
  }
}

/** Démarre une demande sortie de la file, et attend sa fin — sous filet. */
async function servir(entree) {
  const { key, connectorId, trigger, options } = entree;
  // Le compte se relit au vrai départ : il a pu changer pendant l'attente.
  const user = db
    .get()
    .prepare('SELECT id, username, status FROM users WHERE id = ?')
    .get(entree.userId);
  if (!user) {
    entree.rejeter(new Error(`Utilisateur ${entree.userId} introuvable.`));
    return;
  }

  const attenteMs = Date.now() - entree.attenteDepuis;
  applog.info(
    'scheduler',
    `${connectorId} : la récupération démarre — ${Math.round(attenteMs / 1000)} s d'attente, `
      + `${fileAttente.length} encore en file.`,
    { userId: user.id, username: user.username }
  );

  running.set(key, new Date().toISOString());
  const execution = runLocked(user, connectorId, trigger, options).finally(() => {
    running.delete(key);
  });

  // Attendre son tour ne fait jamais échouer une récupération : la limite du
  // lot 67 court dans runLocked, depuis le VRAI départ. Le filet ci-dessous
  // couvre l'angle que la limite ne couvre pas — les DÉPÔTS, hors de sa course
  // (un stockage qui ne répond plus jamais) : au-delà de la limite plus une
  // marge, la file continue sans l'exécution. Son verrou de couple, lui, reste
  // tenu tant qu'elle vit : rien ne peut repartir sur le même profil de
  // navigateur, et sa ligne se ferme quand (si) elle finit.
  try {
    const resultat = await courseAvecFilet(execution, filetDeFileMs());
    entree.resoudre(resultat);
  } catch (err) {
    if (err.filetDeFile) {
      applog.error(
        'scheduler',
        `${connectorId} : l'exécution ne répond plus au-delà de la limite et de sa marge — `
          + 'la file continue sans elle. Son résultat, s\'il arrive, s\'écrira dans l\'historique du service.',
        { userId: user.id, username: user.username }
      );
    }
    entree.rejeter(err);
  }

  const restent = fileAttente.length;
  applog.info(
    'scheduler',
    `${connectorId} : sortie de file — ${restent} récupération${restent > 1 ? 's' : ''} encore en attente.`,
    { userId: user.id, username: user.username }
  );
}

/**
 * Le filet de la file : la limite d'exécution, plus une marge large. Il ne
 * devrait JAMAIS se tendre — la limite du lot 67 borne déjà la récupération
 * elle-même — mais sans lui, une exécution qui ne rendrait jamais la main
 * (hors de la course de la limite) bloquerait toutes les suivantes pour
 * toujours : c'est exactement la panne du 01/10 sous une autre forme.
 */
function filetDeFileMs() {
  const demande = Number.parseInt(process.env.CRABE_FILET_FILE_MS || '', 10);
  if (Number.isFinite(demande) && demande > 0) return demande;
  const limite = limiteExecutionMs();
  return limite + Math.max(60000, limite);
}

/** Attend une exécution, mais jamais au-delà du filet. */
async function courseAvecFilet(promesse, ms) {
  // Même précaution qu'`avecLimiteDeDuree` : le `.catch()` se pose sur la
  // promesse d'origine AVANT la course, sinon un rejet tardif sans preneur
  // ferait tomber le processus.
  promesse.catch(() => {});
  let minuteur = null;
  try {
    return await Promise.race([
      promesse,
      new Promise((_, rejeter) => {
        minuteur = setTimeout(() => {
          const err = new Error(
            'La récupération ne répond plus — crabe passe à la suivante. '
              + 'Son résultat, s\'il arrive, sera visible dans l\'historique du service.'
          );
          err.filetDeFile = true;
          // Lot 110 — au réveil d'un gel (01/10/2026 : 38 h), la limite de
          // 45 min et ce filet sont en souffrance ENSEMBLE : le filet cède un
          // tour, la limite conclut d'abord et la ligne se clôt proprement ;
          // s'il reste seul, il rejette au tour suivant.
          setImmediate(() => rejeter(err));
        }, ms);
        minuteur.unref?.();
      }),
    ]);
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }
}

/**
 * Reprend, au démarrage, ce qui ATTENDAIT son tour au dernier arrêt de crabe.
 *
 * Chaque ligne relue repasse par `runForUser` entier — gardes comprises (pause,
 * stockage, compte actif) : ce qui n'a plus le droit de partir ne part pas, et
 * le dit. La table est vidée d'abord : chaque demande ne repart qu'UNE fois.
 * La récupération qui TOURNAIT, elle, n'est plus dans la table (retirée à son
 * départ) : `cloreLesExecutionsInterrompues` a marqué sa ligne en échec, et
 * elle n'est pas relancée.
 */
function reprendreLaFile() {
  const lignes = db
    .get()
    .prepare(
      `SELECT id, user_id, connector_id, trigger, options
         FROM run_queue ORDER BY priorite DESC, id`
    )
    .all();
  if (!lignes.length) return 0;
  db.get().prepare('DELETE FROM run_queue').run();

  applog.info(
    'scheduler',
    `${lignes.length} récupération${lignes.length > 1 ? 's' : ''} attendai${lignes.length > 1 ? 'ent' : 't'} `
      + 'leur tour au dernier arrêt de crabe — reprise maintenant, dans le même ordre.'
  );

  for (const ligne of lignes) {
    let options = {};
    try {
      options = ligne.options ? JSON.parse(ligne.options) : {};
    } catch {
      options = {};
    }
    runForUser(ligne.user_id, ligne.connector_id, ligne.trigger, options)
      .then((resultat) => {
        applog[resultat.ok ? 'info' : 'error'](
          'scheduler',
          `${ligne.connector_id} : récupération reprise après un arrêt de crabe — ${resultat.message}`
        );
      })
      .catch((err) => {
        applog.warn(
          'scheduler',
          `${ligne.connector_id} : la récupération en attente n'a pas pu repartir — ${err.message}`
        );
      });
  }
  return lignes.length;
}

// ---------------------------------------------------------------------------
// Pipeline de récupération
// ---------------------------------------------------------------------------

/**
 * Durée au-delà de laquelle une exécution de connecteur est ABANDONNÉE.
 *
 * ─── Pourquoi une limite, et pourquoi générale ───────────────────────────────
 *
 * Le 26/08/2026, `paybyphone` a tenu son verrou 71 minutes et 20 secondes en
 * n'écrivant pas une seule ligne de journal pendant 71 minutes et 16 d'entre
 * elles. Personne ne pouvait dire, en la regardant, si elle travaillait ou si
 * elle était morte — et par prudence DEUX lots (65 et 66) ont renoncé à
 * déployer, parce qu'un redémarrage aurait interrompu ce qu'on croyait être un
 * travail en cours. C'est ce doute-là qui coûte, plus que la lenteur.
 *
 * Avant ce lot, RIEN dans le socle ne bornait une exécution :
 * `registry.fetchInvoicesDetailed()` était attendu sans course contre quoi que
 * ce soit. Un connecteur qui ne rendait jamais la main gardait pour toujours
 * son verrou, sa ligne de `run_logs` et son navigateur.
 *
 * ─── Pourquoi QUARANTE-CINQ MINUTES, et pas un autre chiffre ─────────────────
 *
 * Le chiffre sort des 437 exécutions terminées de la base, pas d'une intuition :
 *
 *     p50 = 5 s     p90 = 104 s     p95 = 296 s     p99 = 1058 s
 *
 *   - la plus longue exécution **légitime** jamais mesurée dure **1805 s**
 *     (30 min, `impots`, et elle a échoué) ;
 *   - la plus longue **réussie** dure 600 s (10 min, `amazon`, 149 documents) ;
 *   - il n'existe RIEN entre 1805 s et 4279 s : le trou est franc, et de
 *     l'autre côté il n'y a que les trois `paybyphone` à ~4280 s.
 *
 * 45 minutes, c'est donc 1,5 fois la plus longue exécution jamais vue, 4,5 fois
 * la plus longue réussie, 2,6 fois le 99ᵉ centile — et en dessous des 71 minutes
 * qu'il s'agit d'arrêter. Au rythme mesuré d'`amazon` (4 s par document), la
 * limite laisse la place à plus de six cents documents en une seule exécution,
 * quand le plus gros compte du parc en compte 83.
 *
 * ⚠ **Par EXÉCUTION, jamais par série.** Les deux longues durées connues du
 * projet ne sont pas des exécutions et ne sont donc pas concernées : la grappe
 * de 25 services sur 104 minutes est une *suite* d'exécutions courtes, et le
 * renommage de 3 h 13 est `harmonisation.js`, qui a son propre verrou et ne
 * passe pas par ici.
 */
const LIMITE_EXECUTION_MS = 45 * 60 * 1000;

/**
 * La limite effective, en millisecondes.
 *
 * Réglable par l'environnement — et c'est ce qui rend la limite PROUVABLE :
 * un test qui l'attendrait vraiment durerait quarante-cinq minutes et ne serait
 * donc jamais lancé. Les tests la ramènent à quelques dizaines de
 * millisecondes et regardent le temps passer pour de bon.
 */
function limiteExecutionMs() {
  const demande = Number.parseInt(process.env.CRABE_LIMITE_EXECUTION_MS || '', 10);
  return Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_MS;
}

/**
 * Au-delà de ce retard, le minuteur de la limite n'a pas joué à l'heure : crabe
 * lui-même était bloqué (lot 110). Une minute : bien au-dessus de la gigue
 * d'une boucle d'événements saine, bien en dessous des 38 h du 01/10/2026.
 */
const SEUIL_RETARD_MS = 60 * 1000;

/** « 38 h 17 min », « 12 min » : une durée dite simplement. */
function dureeLisible(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const heures = Math.floor(minutes / 60);
  if (!heures) return `${minutes} min`;
  return `${heures} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/**
 * L'échec d'une exécution abandonnée : ce qui s'est passé, et quoi en faire.
 *
 * `retardMs` (lot 110) : le minuteur a joué EN RETARD — la limite n'a pas pu
 * arrêter la récupération à l'heure, parce que crabe ne tournait plus. C'est
 * exactement le 01/10/2026 : 22 récupérations parties ensemble, le conteneur
 * saturé de mémoire 38 h jusqu'à ce que le noyau tue un navigateur, et les
 * 19 minuteurs de 45 minutes qui jouent tous à la première seconde où node
 * reprend la main. Le message le dit au lieu de laisser croire à 38 h de
 * travail.
 */
function erreurDureeDepassee(ms, retardMs = 0) {
  const minutes = Math.round(ms / 60000);
  const enRetard = retardMs > SEUIL_RETARD_MS;
  const err = new Error(
    `La récupération a été arrêtée : elle durait depuis plus de ${minutes} minute`
      + `${minutes > 1 ? 's' : ''} sans se terminer`
      + (enRetard
        ? `, et crabe lui-même est resté bloqué ${dureeLisible(retardMs)} de plus avant de pouvoir `
          + 'l\'arrêter — le serveur était saturé'
        : '')
      + '. Rien n\'a été perdu — les documents déjà '
      + 'récupérés restent en place, et la prochaine récupération reprendra normalement. '
      + 'Si le message revient, signalez-le à la personne qui administre crabe : ce service '
      + 'demande plus de temps que prévu, ou son connecteur reste bloqué.'
  );
  err.dureeDepassee = true;
  if (enRetard) err.retardMs = retardMs;
  return err;
}

/**
 * Attend une récupération, mais pas indéfiniment.
 *
 * ⚠ La promesse abandonnée CONTINUE de tourner : on ne peut pas interrompre du
 * code qui ne s'est pas donné de point d'interruption. Deux conséquences, et
 * les deux sont traitées ici :
 *
 *   - elle pourrait rejeter plus tard, quand plus personne ne l'attend, et une
 *     promesse rejetée sans preneur fait tomber le processus Node. D'où le
 *     `.catch()` posé AVANT la course — sur la promesse d'origine, pas sur une
 *     dérivée, sinon le filet ne couvrirait rien ;
 *   - elle pourrait aussi RÉUSSIR plus tard. Son résultat n'est alors lu par
 *     personne : la suite de `runLocked` vit après ce `await`, et un `await`
 *     qui a rejeté ne reprend jamais. Aucun document ne peut donc être déposé
 *     deux fois, ni déposé sur une ligne déjà refermée.
 */
async function avecLimiteDeDuree(promesse) {
  const limite = limiteExecutionMs();
  const depart = Date.now();
  promesse.catch(() => {});
  let minuteur = null;
  try {
    return await Promise.race([
      promesse,
      new Promise((_, rejeter) => {
        // Lot 110 : le retard du minuteur se mesure à l'échéance — un minuteur
        // ne joue jamais pendant que node est figé, il joue APRÈS.
        minuteur = setTimeout(() => rejeter(erreurDureeDepassee(limite, Date.now() - depart - limite)), limite);
        minuteur.unref?.();
      }),
    ]);
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }
}

/**
 * Récupère les factures d'un connecteur pour un utilisateur, les dépose sur
 * les destinations actives, et journalise le tout.
 *
 * @param {number} userId
 * @param {string} connectorId
 * @param {'manual'|'cron'|'test'} trigger
 * @param {{toutLHistorique?: boolean}} [options] `toutLHistorique` : cette
 *   exécution-ci porte sur TOUT l'historique disponible, quel que soit le
 *   réglage « Historique » du compte — qui, lui, n'est jamais modifié. C'est
 *   l'action « Récupérer tout l'historique » de la fiche (lot 32) : après la
 *   perte du 13/08 (149 documents effacés par l'entretien), rattraper exigeait
 *   de changer le réglage, lancer, puis le remettre — trois gestes techniques
 *   pour ce qui n'en est qu'un.
 * @returns {Promise<{ok: boolean, count: number, message: string}>}
 * @throws {Error} 409 si une récupération est déjà en cours pour ce couple
 */
async function runForUser(userId, connectorId, trigger = 'manual', options = {}) {
  const user = db.get().prepare('SELECT id, username, status FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`Utilisateur ${userId} introuvable.`);

  // ─── En pause ⇒ il ne travaille plus, quel que soit le déclencheur (lot 82) ─
  //
  // Le planificateur n'arme déjà aucune tâche pour lui (voir `reload`), et
  // l'interface grise « Lancer maintenant ». Ce refus-ci est la troisième
  // barrière, celle qui tient quand les deux autres sont contournées : un
  // second onglet resté ouvert sur l'écran d'avant, un appel direct à l'API.
  //
  // ⚠ Rien n'est écrit nulle part — ni run_logs, ni journal applicatif. Une
  // pause est un état voulu, pas un incident : elle ne doit pas remplir le
  // journal de lignes rouges, ce qui est exactement le défaut que la
  // migration 55 corrigeait pour CAF.
  const enPause = db
    .get()
    .prepare('SELECT disabled_at FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(userId, connectorId)?.disabled_at;
  if (enPause) {
    const err = new Error(
      'Ce service est en pause : il ne récupère plus rien pour le moment. '
      + 'Rallumez-le depuis votre profil pour qu\'il reprenne son travail.'
    );
    err.statusCode = 409;
    err.enPause = true;
    throw err;
  }

  // ─── Rien où déposer ⇒ on ne va rien chercher (lot 26) ────────────────────
  //
  // Depuis que l'espace de stockage de crabe se supprime comme un cloud, il est
  // possible de n'avoir plus aucune destination. Une récupération irait alors
  // se connecter au fournisseur, rejouer une session, télécharger des PDF — et
  // les jetterait. Le journal annoncerait « 12 factures récupérées » et il n'y
  // aurait rien nulle part.
  //
  // ⚠ Le refus vaut pour TOUS les déclenchements, planifiés comme manuels, et
  // c'est délibéré : le geste est aussi vain dans les deux cas. Il est
  // seulement plus visible en manuel, où l'utilisateur lit la phrase tout de
  // suite. Un test de connexion, lui, reste possible — il ne dépose rien.
  const stockage = require('./destinations').aucunStockageActif();
  if (stockage.bloque) {
    // La garde « jamais de message vide » s'applique à CHAQUE écriture d'échec
    // du fichier, même quand le message semble garanti : c'est structurel.
    const message = messagesEchec.messageJamaisVide(stockage.message);
    db.get()
      .prepare(
        `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, message, cause)
         VALUES (?, ?, datetime('now'), 0, ?, ?, ?)`
      )
      .run(connectorId, userId, trigger, message, causeEchec.ECHEC);
    applog.warn('scheduler', `${connectorId} (${user.username}) : ${message}`, {
      userId,
      username: user.username,
    });
    const err = new Error(message);
    err.statusCode = 409;
    err.aucunStockage = true;
    throw err;
  }

  const key = lockKey(userId, connectorId);
  if (running.has(key)) {
    const err = new Error(
      'Une synchronisation est déjà en cours pour ce connecteur — attendez qu\'elle se termine.'
    );
    err.statusCode = 409;
    err.alreadyRunning = true;
    throw err;
  }
  // ─── Déjà en file ⇒ on ne l'ajoute pas, et on le dit (lot 90) ──────────────
  //
  // Un couple ne figure qu'une fois dans la file : la redemander pendant
  // qu'elle attend répondrait deux récupérations pour un seul geste.
  if (clesEnFile.has(key)) {
    const attente = attentePour(userId, connectorId);
    const devant = attente ? attente.devant : 0;
    const err = new Error(
      'Cette récupération est déjà en attente'
        + (devant
          ? ` — ${devant} récupération${devant > 1 ? 's passent' : ' passe'} avant elle`
          : '')
        + '. Elle partira à son tour, rien d\'autre à faire.'
    );
    err.statusCode = 409;
    err.enFile = true;
    throw err;
  }

  // Toute récupération passe par la file (lot 90) : une seule à la fois pour
  // tout crabe, les autres attendent leur tour. La promesse rendue ne se
  // résout qu'à la fin réelle de l'exécution — le contrat des appelants ne
  // change pas.
  return mettreEnFile(user, connectorId, trigger, options);
}

// ---------------------------------------------------------------------------
// Garde du dépôt — deux documents différents ne partagent pas un fichier (lot 88)
// ---------------------------------------------------------------------------

/**
 * Que faire d'un document qui arrive sous un nom déjà pris par une ligne ?
 *
 * Le 05/10/2026, impots a déposé 14 documents sous des noms déjà pris par des
 * lignes d'ANCRE DIFFÉRENTE : chacun a remplacé, sur deux stockages, le fichier
 * d'un autre document, et l'upsert a mis la ligne à jour au lieu d'en créer une
 * — 8 fichiers archivés perdus localement, « 24 factures récupérées » pour 10
 * lignes. L'inventaire du lot 88 (docs/reconnaissance-lot88.md, §5) montre
 * qu'aucun connecteur ne produit ce cas en fonctionnement normal : la garde
 * vaut donc pour tous, et ne peut mordre que sur une vraie collision.
 *
 * Fonction PURE. Deux verdicts :
 *   - `autreDocument` : la ligne et le document portent chacun une ancre, et
 *     elles diffèrent — ce nom recouvre DEUX documents. Toujours journalisé.
 *   - `renommer` : en plus, les tailles diffèrent — déposer sous ce nom
 *     remplacerait le fichier d'un autre document. Le dépôt prend un nom libre
 *     et sa propre ligne ; rien d'existant n'est touché.
 *
 * Tout le reste — même ancre (rafraîchissement d'un document connu), ancre
 * absente d'un côté ou de l'autre, ou même taille — garde le comportement
 * d'avant : mise à jour de la ligne, fichier réécrit à l'identique de taille.
 *
 * @param {{remote_id?: string|null, size_bytes?: number}|undefined} ligne la
 *   ligne qui porte déjà ce nom, si elle existe
 * @param {{remoteId?: string|null, buffer: Buffer}} invoice le document qui arrive
 * @returns {{autreDocument: boolean, renommer: boolean}}
 */
function decisionDepot(ligne, invoice) {
  const ancreLigne = ligne?.remote_id == null ? null : String(ligne.remote_id);
  const ancreDoc = invoice?.remoteId == null ? null : String(invoice.remoteId);
  if (!ligne || !ancreLigne || !ancreDoc || ancreLigne === ancreDoc) {
    return { autreDocument: false, renommer: false };
  }
  return {
    autreDocument: true,
    renommer: Number(ligne.size_bytes) !== invoice.buffer.length,
  };
}

/**
 * Le premier nom LIBRE dérivé d'un nom d'origine : `nom_2.pdf`, `nom_3.pdf`…
 * Décidé une seule fois, avant toute écriture : le document portera ce même
 * nom sur tous les stockages et dans la base.
 *
 * @param {string} filename le nom d'origine, déjà pris
 * @param {(nom: string) => boolean} estPris un nom est-il déjà porté ?
 * @returns {string}
 */
function premierNomLibre(filename, estPris) {
  const decoupe = /^(.*?)(\.[A-Za-z0-9]+)$/.exec(String(filename));
  const racine = decoupe ? decoupe[1] : String(filename);
  const extension = decoupe ? decoupe[2] : '';
  for (let i = 2; ; i++) {
    const candidat = `${racine}_${i}${extension}`;
    if (!estPris(candidat)) return candidat;
  }
}

/** Corps de la récupération, verrou déjà pris. */
async function runLocked(user, connectorId, trigger, options = {}) {
  const userId = user.id;

  const logId = db
    .get()
    .prepare('INSERT INTO run_logs (connector_id, user_id, trigger) VALUES (?, ?, ?)')
    .run(connectorId, userId, trigger).lastInsertRowid;

  // ─── Le numéro de la récupération sur chaque ligne (migration 67) ─────────
  //
  // Tout ce que ce passage écrit au journal — le connecteur par `ctx.log`, le
  // socle ici — porte son numéro : le rapport d'échec (rapport-echec.js)
  // retrouve la récupération entière, et elle seule. La première et la
  // dernière ligne disent ce qu'un rapport doit dire d'emblée : qui l'a
  // lancée, avec quelle version, combien de temps elle a duré, comment elle a
  // fini.
  const qui = { userId, username: user.username, runId: logId };
  const debutMs = Date.now();
  applog.connector(
    connectorId,
    `Récupération commencée (${rapportEchec.DECLENCHEURS[trigger] || trigger}), crabe ${config.version}.`,
    qui
  );

  // Lot 110 — la dernière erreur d'AVANT ce passage : un site hors ligne ne
  // la change pas, elle est remise telle quelle si le passage finit ainsi.
  const erreurAvant = db
    .get()
    .prepare('SELECT last_error FROM connector_installs WHERE user_id = ? AND connector_id = ?')
    .get(userId, connectorId)?.last_error ?? null;

  // ─── L'erreur précédente est vidée AU DÉMARRAGE (lot 14, §2.2) ────────────
  //
  // Elle ne l'était qu'à la fin, en cas de succès. Pendant les vingt à
  // soixante secondes d'une récupération, la fiche continuait donc d'afficher
  // l'échec de la fois d'avant — un utilisateur qui vient de cliquer
  // « Réessayer » lit alors le message qu'il essaie précisément de faire
  // disparaître, et croit que rien ne s'est passé.
  db.get()
    .prepare(
      `UPDATE connector_installs SET last_error = NULL
        WHERE user_id = ? AND connector_id = ?`
    )
    .run(userId, connectorId);

  // `cause` (lot 91) : celle d'un échec, décidée par connectors/cause-echec.js
  // — « échec » par défaut, la session expirée et la connexion refusée ne
  // sortant que du `catch` ci-dessous, seul à connaître `err.sessionExpired`.
  const finish = (ok, count, message, cause = causeEchec.ECHEC) => {
    // ⚠ Un échec sans message est interdit (14/08/2026 : « ÉCHEC | "" » au
    // journal). La garde vit ICI, au point d'écriture unique, et non dans
    // chaque chemin d'erreur : un connecteur futur qui lèvera une Error('')
    // sera couvert sans que personne y pense. Même point unique pour le
    // jargon d'automatisation (lot 37) : l'écran reçoit une phrase lisible,
    // le texte brut part au journal technique.
    const texte = ok ? message : messagesEchec.messageJamaisVide(message, 'recuperation', (brut) =>
      applog.warn('scheduler', `${connectorId} : détail technique de l'échec — ${brut}`, qui));
    db.get()
      .prepare(
        `UPDATE run_logs
            SET finished_at = datetime('now'), success = ?, invoice_count = ?, message = ?,
                cause = ?
          WHERE id = ?`
      )
      .run(ok ? 1 : 0, count, texte, ok ? null : cause, logId);
    const secondes = Math.round((Date.now() - debutMs) / 1000);
    applog.connector(
      connectorId,
      `Récupération terminée en ${secondes < 60 ? `${secondes} s` : dureeLisible(secondes * 1000)} : `
        + `${ok ? 'succès' : `échec (${cause})`} — ${texte}`,
      { ...qui, level: ok ? 'info' : 'warn' }
    );
    if (!ok && cause === causeEchec.HORS_LIGNE) {
      // ─── Un site hors ligne ne met pas le service en erreur (lot 110) ─────
      //
      // Le statut ne bouge pas, la dernière erreur redevient celle d'avant ce
      // passage (vidée au démarrage, ci-dessus), et la date du dernier passage
      // ne change pas : rien n'a été lu, aucun historique ne doit croire le
      // contraire. Seule la ligne de `run_logs` dit ce qui s'est passé.
      db.get()
        .prepare(
          `UPDATE connector_installs SET last_error = ?
            WHERE user_id = ? AND connector_id = ?`
        )
        .run(erreurAvant, userId, connectorId);
    } else {
      db.get()
        .prepare(
          `UPDATE connector_installs
              SET status = ?, last_error = ?, last_run_at = datetime('now')
            WHERE user_id = ? AND connector_id = ?`
        )
        .run(ok ? 'installed' : 'error', ok ? null : texte, userId, connectorId);
    }

    // ─── La série lancée à la main se constitue ICI (lot 66) ────────────────
    //
    // Ce point d'écriture est le seul par lequel passe TOUTE récupération,
    // quelle que soit la route qui l'a demandée — bouton d'une fiche, action
    // groupée des planifications, ou une future. Y accrocher la série, plutôt
    // qu'à une route, c'est la seule façon de couvrir les vingt et une grappes
    // mesurées, dont une de vingt-cinq services sur cent quatre minutes.
    //
    // Le déclencheur `test` reste dehors : un essai n'est pas un chantier, son
    // résultat est déjà sous les yeux de qui l'a lancé.
    if (trigger === 'manual') {
      notifications.signalerRecuperationManuelle(
        user,
        {
          connectorId,
          nom: registry.has(connectorId) ? registry.manifest(connectorId).name : connectorId,
          ok,
          message: texte,
        },
        // Tant qu'une récupération tourne — ou ATTEND son tour dans la file
        // (lot 90) — la série n'est pas finie : sans cela, les 71 minutes de
        // `paybyphone` couperaient une balayée en deux et enverraient deux
        // bilans au lieu d'un.
        { enCours: () => runningPairs().length > 0 || fileAttente.length > 0 }
      );
    }

    return { ok, count, message: texte, cause: ok ? null : cause };
  };

  // Déclarée hors du `try` : le `catch` la relit pour savoir si une session a
  // été confirmée (`__meta`, lot 71) quand il compose un message de refus.
  let connectorConfig = null;

  try {
    if (user.status !== 'active') {
      return finish(false, 0, 'Compte inactif — récupération ignorée.');
    }

    const catalog = db
      .get()
      .prepare('SELECT maintenance FROM connector_catalog WHERE connector_id = ?')
      .get(connectorId);
    if (catalog?.maintenance) {
      return finish(false, 0, 'Connecteur en maintenance — récupération ignorée.');
    }

    connectorConfig = registry.readConfig(userId, connectorId);
    const connectorName = registry.manifest(connectorId).name;

    // ─── « Récupérer tout l'historique » (lot 32) ─────────────────────────
    //
    // La surcharge se fait sur la COPIE en mémoire de la configuration, jamais
    // sur ce qui est enregistré : le réglage « Historique » de l'utilisateur
    // ressort intact de cette exécution. Passer par la configuration — et non
    // par un champ de contexte — couvre d'un coup tous les connecteurs : ceux
    // qui lisent `planHistorique(config, …)` comme ceux qui appellent
    // directement `history.anneesAParcourir({ valeur: config.historique })`.
    if (options.toutLHistorique) {
      const { CHAMP_HISTORIQUE } = require('./connectors/scraping');
      connectorConfig = { ...connectorConfig, [CHAMP_HISTORIQUE]: 'tout' };
    }

    const dejaEnBase = db
      .get()
      .prepare(
        'SELECT remote_id, size_bytes FROM invoices WHERE user_id = ? AND connector_id = ? AND remote_id IS NOT NULL'
      )
      .all(userId, connectorId);
    const knownRemoteIds = dejaEnBase.map((r) => r.remote_id);
    // La taille de chaque document déjà déposé, par `remote_id`. Un connecteur
    // peut s'en servir pour rattacher une ancienne ligne au bon document quand
    // plusieurs partagent le même libellé (impots, lot 86) — les tailles
    // seulement, jamais le contenu.
    const knownSizes = {};
    for (const r of dejaEnBase) knownSizes[r.remote_id] = r.size_bytes;

    const fetched = await avecLimiteDeDuree(
      registry.fetchInvoicesDetailed(connectorId, connectorConfig, {
        // Les connecteurs à profil persistant (addons-prestashop) rouvrent le
        // profil du couple (utilisateur, connecteur) : il leur faut l'utilisateur.
        userId,
        // Le numéro de la récupération, pour les lignes de `ctx.log` (migration 67).
        runId: logId,
        // 0.2.6 : `crabe recuperer <service> --detail` — chaque étape capturée.
        detail: !!options.detail,
        knownRemoteIds,
        knownSizes,
        // Les documents déjà déposés sous un nom opaque (0.2.4) : le connecteur
        // qui sait lire leur numéro de facture le rend, et le socle les
        // renomme après le dépôt (renommage-references.js).
        nomsOpaques: require('./renommage-references').nomsOpaques(userId, connectorId),
        monthsBack: 12,
        // Profondeur d'historique : un connecteur qui expose quinze années doit
        // savoir si un rattrapage complet a déjà eu lieu, sans quoi il le
        // referait tous les jours (voir connectors/history.js).
        lastRunAt: registry.getInstall(userId, connectorId)?.last_run_at || null,
        dejaRecupere: knownRemoteIds.length > 0,
        // Rapprochement des éléments découverts (lignes mobiles, points de
        // livraison…) : le connecteur annonce ce qu'il a vu, le socle mémorise,
        // ajoute les nouveautés à la sélection et signale les disparitions.
        reconcile: registry.makeReconciler(userId, connectorId, (message) =>
          applog.info('scheduler', message, qui)
        ),
      })
    );

    // ─── L'état de session renouvelé après le passage (lot 87) ─────────────
    //
    // Déclaratif : seul un connecteur qui rend `sessionRenouvelee` est
    // concerné (impots — pas de contrôle par rejeu à l'enregistrement, et
    // l'état final du navigateur d'un passage réussi est plus récent que la
    // capture d'origine). L'écriture passe par `saveConfig` — contrôle de forme,
    // chiffrement, `__meta` — et ne peut JAMAIS changer le résultat du
    // passage : un échec se journalise, rien de plus. Le connecteur ne rend
    // cet état qu'après un passage qui a ATTEINT la liste, jamais après une
    // session fermée ou une connexion demandée.
    if (fetched.sessionRenouvelee) {
      try {
        const champSession = (registry.manifest(connectorId).fields || [])
          .find((f) => f.type === 'session');
        if (champSession) {
          // 0.2.3 : le même tri qu'à la connexion (`remoteLogin.keepDomains`,
          // lot 21) — un état renouvelé ne garde jamais plus de domaines
          // qu'une connexion enregistrée, quel que soit le connecteur.
          const { state, retires } = require('./connectors/session-state').limiterAuxDomaines(
            JSON.parse(fetched.sessionRenouvelee),
            registry.manifest(connectorId).remoteLogin?.keepDomains
          );
          registry.saveConfig(
            userId,
            connectorId,
            { [champSession.key]: JSON.stringify(state) },
            // Pas une connexion enregistrée (lot 91) : personne ne s'est
            // connecté, c'est l'état d'un passage réussi.
            { origine: 'renouvellement' }
          );
          applog.info(
            'scheduler',
            `${connectorId} (${user.username}) : état de session renouvelé après le passage`
              + `${retires ? ` (${retires} cookie(s) hors des domaines du service écarté(s))` : ''}.`,
            qui
          );
        }
      } catch (err) {
        applog.warn(
          'scheduler',
          `${connectorId} (${user.username}) : l'état de session n'a pas pu être `
            + `renouvelé (${err.message}) — le passage reste ce qu'il était.`,
          qui
        );
      }
    }

    // Identifiant de compte : ce que le connecteur remonte, sinon la config,
    // sinon ce qui était déjà connu, sinon « defaut ».
    const accountId = registry.accountIdFor(
      userId,
      connectorId,
      connectorConfig,
      fetched.accountId
    );
    registry.recordAccountId(userId, connectorId, accountId);

    const readExisting = db
      .get()
      .prepare(
        'SELECT id, remote_id, size_bytes, destinations FROM invoices'
          + ' WHERE user_id = ? AND connector_id = ? AND filename = ?'
      );

    // ─── Le nom de dépôt suit la convention du compte (lot 56) ────────────
    //
    // C'est ICI, et nulle part ailleurs, que la convention s'applique : le
    // socle est le seul endroit qui voit à la fois le nom produit par le
    // connecteur et le compte qui reçoit le document. Les connecteurs qui
    // fabriquent encore leur nom à l'ancienne (période en tête sans le
    // service — Amazon, impôts, Free, la famille PrestaShop…) sont ramenés à
    // la convention à chaque dépôt : la dette mesurée au lot 55 ne peut plus
    // se recréer, quel que soit le connecteur, y compris ceux qui restent à
    // écrire. Un nom qu'aucune règle ne reconnaît est déposé tel quel — on ne
    // renomme jamais sur une supposition.
    const conventionNoms = require('./preferences').get(userId, 'fichiers.convention');
    const { nomDeDepot } = require('./convention-noms');

    // ─── Le dossier du compte (lot 98) ────────────────────────────────────
    //
    // Un connecteur qui sait NOMMER ses comptes — Gandi seul, par
    // `nomDuCompte` — range chacun dans un dossier à son nom ; `null` pour
    // tous les autres, qui gardent leur identifiant exactement comme avant.
    // Décidé une fois, ici, après la récupération : la découverte vient
    // d'être rafraîchie par ce passage même (`ctx.reconcile`). `account_id`
    // reste l'identifiant ; seul le dossier des stockages change.
    //
    // Une décision impossible (base illisible…) ne coûte jamais un document :
    // le passage dépose alors à l'identifiant, comme avant, et le dit.
    let dossiers = null;
    try {
      dossiers = require('./dossier-par-nom').pourLePassage(userId, connectorId, {
        username: user.username,
        connectorName,
      });
    } catch (err) {
      applog.warn(
        'scheduler',
        `${connectorId} (${user.username}) : le dossier au nom des comptes n'a pas pu être décidé `
          + `(${err.message}) — les documents de ce passage vont dans le dossier à l'identifiant, comme avant.`,
        qui
      );
    }

    let nouvelles = 0;
    let misesAJour = 0;
    for (const invoice of fetched.invoices) {
      if (!invoice?.buffer) continue;
      invoice.filename = nomDeDepot(connectorId, invoice.filename, conventionNoms);
      // Une facture peut porter son propre identifiant de compte (plusieurs
      // abonnements sur un même identifiant fournisseur).
      const invoiceAccountId = registry.accountIdFor(
        userId,
        connectorId,
        connectorConfig,
        invoice.accountId || accountId
      );

      // ─── La garde du dépôt (lot 88) — AVANT toute écriture ────────────────
      //
      // Elle se décide ici, le nom une fois fixé et avant `storeInvoice` : il
      // ne doit exister aucun instant où le fichier d'un autre document est
      // remplacé sur un stockage. Un nom déjà pris par une ligne d'ancre
      // différente se journalise toujours ; si les tailles diffèrent aussi, le
      // document prend le premier nom libre et sa propre ligne.
      let existante = readExisting.get(userId, connectorId, invoice.filename);
      const conflit = decisionDepot(existante, invoice);
      const ligneEnConflit = conflit.autreDocument ? existante : null;
      if (conflit.renommer) {
        invoice.filename = premierNomLibre(
          invoice.filename,
          (nom) => Boolean(readExisting.get(userId, connectorId, nom))
        );
        // Le nom choisi est libre : ce dépôt crée sa propre ligne.
        existante = undefined;
      }

      const results = await destinations.storeInvoice({
        username: user.username,
        userId: user.id,
        connectorId,
        connectorName,
        accountId: invoiceAccountId,
        dossierDuCompte: dossiers ? dossiers.dossier(invoiceAccountId).dossier : undefined,
        // L'année du dossier vient de la date d'émission quand le connecteur la
        // remonte, sinon de la période lue dans le nom du fichier.
        issuedOn: invoice.issuedOn || null,
        filename: invoice.filename,
        buffer: invoice.buffer,
        // Le rangement du connecteur (dossiers du coffre eDocPerso, lot 38),
        // quand il en fournit un — sinon le niveau d'année habituel.
        sousChemin: invoice.sousChemin || null,
      });

      // L'état de transfert est FUSIONNÉ avec ce qui était déjà connu : une
      // copie réussie sur une destination désactivée depuis ne disparaît pas
      // de l'historique de la facture.
      const destinationsJson = invoices.mergeOutcomes(existante?.destinations || '{}', results);

      const ecriture = db.get()
        .prepare(
          `INSERT INTO invoices
             (user_id, connector_id, filename, remote_id, account_id, size_bytes, issued_on, destinations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, connector_id, filename)
           DO UPDATE SET destinations = excluded.destinations,
                         size_bytes   = excluded.size_bytes,
                         account_id   = excluded.account_id,
                         fetched_at   = datetime('now')`
        )
        .run(
          userId,
          connectorId,
          invoice.filename,
          invoice.remoteId || null,
          invoiceAccountId,
          invoice.buffer.length,
          invoice.issuedOn || null,
          destinationsJson
        );
      if (existante) misesAJour++;
      else nouvelles++;

      // La détection se dit TOUJOURS, garde ou pas — par identifiants de
      // ligne, jamais par noms de fichiers (un nom part dans le journal lisible
      // par l'administrateur, pas la peine d'y répéter des titres).
      if (ligneEnConflit && conflit.renommer) {
        applog.warn(
          'scheduler',
          `${connectorId} (${user.username}) : deux documents différents se présentaient `
            + `sous le même nom de fichier — la ligne ${ligneEnConflit.id} garde le sien, `
            + `le nouveau document est déposé sous un nom distinct (ligne ${ecriture.lastInsertRowid}). `
            + 'Rien n\'a été remplacé.',
          qui
        );
      } else if (ligneEnConflit) {
        applog.warn(
          'scheduler',
          `${connectorId} (${user.username}) : un document d'ancre différente mais de même `
            + `taille s'est déposé sous le nom de la ligne ${ligneEnConflit.id} — la ligne a été `
            + 'mise à jour : à taille égale, c\'est vraisemblablement le même document vu sous deux ancres.',
          qui
        );
      }
    }
    const stored = nouvelles + misesAJour;

    // ─── Les noms opaques remplacés par le numéro de facture (0.2.4) ───────
    //
    // APRÈS les dépôts du passage, et sans jamais changer son résultat : un
    // renommage reporté ou arrêté se dit au journal et se refait au passage
    // suivant. Mêmes gestes que l'harmonisation des noms, sous son verrou.
    if (Object.keys(fetched.numerosRelus || {}).length) {
      try {
        const renommage = await require('./renommage-references').appliquer({
          userId,
          username: user.username,
          connectorId,
          numeros: fetched.numerosRelus,
        });
        if (renommage.phrase) {
          const niveau = !renommage.arrete && (renommage.faits || renommage.reporte) ? 'info' : 'warn';
          applog[niveau]('scheduler', `${connectorId} (${user.username}) : ${renommage.phrase}`, qui);
        }
      } catch (err) {
        applog.warn(
          'scheduler',
          `${connectorId} (${user.username}) : le renommage avec les numéros de facture n'a pas pu `
            + `se faire (${err.message}) — le passage reste ce qu'il était.`,
          qui
        );
      }
    }

    // Où les documents de ce passage sont allés, dit au journal (lot 98) :
    // des nombres et des règles, jamais un nom ni un identifiant.
    const bilanDossiers = dossiers?.bilan();
    if (bilanDossiers) {
      applog.info('scheduler', `${connectorId} (${user.username}) : ${bilanDossiers}`, qui);
    }

    // ─── Le rattrapage dit ce qu'il a VRAIMENT couvert (lot 33) ──────────────
    //
    // « Tout l'historique disponible a été parcouru » ne s'écrit que si le
    // connecteur l'ATTESTE (`couverture.complete`). Le 14/08/2026,
    // materiel-net a produit cette phrase après n'avoir lu que les six
    // derniers mois — la période servie par défaut : rassurant, et faux. Un
    // connecteur qui déclare une couverture partielle voit son détail écrit
    // tel quel ; un connecteur qui ne déclare rien n'autorise aucune
    // affirmation — le message reste nu plutôt que de promettre.
    let suffixe = '';
    if (options.toutLHistorique) {
      if (fetched.couverture?.complete) {
        suffixe = ' — tout l\'historique disponible a été parcouru';
      } else if (fetched.couverture?.detail) {
        suffixe = ` — parcouru : ${fetched.couverture.detail}`;
      }
    }
    // « Aucune nouvelle facture » ne se dit que quand c'est la bonne lecture :
    // tout ce que le service propose a déjà été récupéré. Les deux autres
    // lectures ont chacune leur phrase, déclarée par le connecteur qui SAIT :
    //
    //   - `aucunDocument` (lot 41) : le service ne propose aucun document —
    //     sinon l'écran ressemble à une panne, et le vrai motif dort dans le
    //     journal ;
    //   - `horsPeriode` (lot 42) : des documents existent, tous plus vieux que
    //     la période demandée — le geste à faire est d'élargir l'historique.
    //
    // Les trois cas s'excluent, et l'ordre les départage sans ambiguïté : un
    // service qui ne propose RIEN ne peut rien avoir hors période.
    // ─── Un échec complet ne se dit pas « Succès » (lot 80) ──────────────────
    //
    // Le 10/09/2026, Coyote a listé 55 factures, les a toutes tentées, n'en a
    // obtenu AUCUNE — et l'exécution s'est affichée « Succès : Aucune nouvelle
    // facture ». C'est faux, et c'est trompeur pour qui ne lira jamais le
    // journal : « rien de nouveau » et « rien n'a marché » sont deux nouvelles
    // opposées. Le connecteur qui compte ce qu'il a MANQUÉ (`manquees`)
    // départage désormais trois situations :
    //
    //   - RIEN DE NOUVEAU — aucune manquée : les phrases d'avant, inchangées ;
    //   - PARTIEL — des documents sont entrés ET d'autres ont manqué : la
    //     réussite se dit, le reste aussi, et l'exécution reste un succès
    //     puisque des documents sont bien arrivés ;
    //   - ÉCHEC — des documents ont été tentés et AUCUN n'est entré : c'est un
    //     échec, la fiche passe en erreur, et la phrase dit ce qui s'est passé.
    //
    // Un connecteur qui ne compte rien (`manquees` absent) garde exactement le
    // comportement d'avant : aucun des 55 autres connecteurs ne change.
    const manquees = Math.max(0, Number(fetched.manquees) || 0);
    const echecComplet = stored === 0 && manquees > 0;
    // ─── Le compte annoncé dit vrai (lot 88) ────────────────────────────────
    //
    // « Récupérée » = une ligne NOUVELLE dans l'archive, rien d'autre. Le
    // 05/10/2026, « 24 factures récupérées » recouvrait 10 lignes ajoutées et
    // 14 dépôts qui n'avaient fait que mettre à jour des lignes existantes :
    // le chiffre rassurait, l'archive n'avait pas ce qu'il promettait. Une
    // ligne rafraîchie se dit maintenant à part, simplement, et
    // `invoice_count` ne compte que les nouvelles.
    const sN = nouvelles > 1 ? 's' : '';
    const sM = misesAJour > 1 ? 's' : '';
    let tete;
    if (echecComplet) {
      tete = `Aucun document n'a pu être récupéré — ${manquees} vous `
        + `${manquees > 1 ? 'étaient proposés' : 'était proposé'}, aucun n'a pu être téléchargé. `
        + 'Le détail de ce qui a bloqué est dans le journal de cette exécution.';
    } else if (stored === 0) {
      tete = fetched.aucunDocument || fetched.horsPeriode || 'Aucune nouvelle facture';
    } else {
      const morceaux = [
        nouvelles > 0
          ? `${nouvelles} facture${sN} récupérée${sN}`
          : 'Aucune nouvelle facture',
      ];
      if (misesAJour > 0) {
        morceaux.push(`${misesAJour} document${sM} déjà archivé${sM} mis à jour`);
      }
      if (manquees > 0) {
        // La phrase vit dans rapport-echec.js : l'écran des journaux et le
        // rapport la reconnaissent pour proposer le rapport d'une réussite
        // partielle (0.2.2).
        morceaux.push(rapportEchec.phraseNonObtenues(manquees));
      }
      tete = morceaux.join(', ');
    }

    const message = tete
      + suffixe
      // Le parcours écourté (lot 80) se dit, sinon le compte des documents
      // tentés passerait pour le compte de ce que le service propose.
      + (fetched.renoncement ? ` ${String(fetched.renoncement)}` : '')
      // La limite déclarée par le connecteur (`precision`, lot 70) s'ajoute
      // TOUJOURS : « Aucune nouvelle facture » comme « 1 facture récupérée »
      // laissaient croire que tout était à portée, alors que SNCF Connect ne
      // propose une partie de ses justificatifs que par envoi d'e-mail.
      + (fetched.precision ? ` ${fetched.precision}` : '');
    return finish(!echecComplet, nouvelles, message);
  } catch (err) {
    // Le détail technique, pour qui corrigera (rapport-echec.js) : la nature
    // de l'erreur, ses drapeaux et l'endroit du code de crabe. Il part au
    // journal de la récupération, donc dans son rapport ; l'écran garde sa
    // phrase.
    applog.connector(connectorId, rapportEchec.detailTechnique(err), { ...qui, level: 'error' });
    // 0.2.5 : où il en était et ce que la page montrait à l'arrêt — de quoi
    // corriger un connecteur sans compte sur le service (vue-de-page.js).
    for (const ligne of require('./connectors/vue-de-page').lignesDuPassage(err?.passageVu)) {
      applog.connector(connectorId, ligne, { ...qui, level: 'error' });
    }

    // Une session expirée porte déjà une phrase qui dit quoi faire : la
    // préfixer d'« Échec — » la noierait. Les autres erreurs, si — mais
    // seulement si l'erreur a un texte : « Échec — » suivi de rien passerait
    // la garde de finish() tout en ne disant rien (le préfixe la rendrait
    // non vide), et c'est exactement le message fantôme qu'on interdit.
    const brut = String(err.message || '').trim();
    let message = !brut ? '' : err.sessionExpired ? brut : `Échec — ${brut}`;

    // ─── Le site n'a jamais répondu (lot 110) ───────────────────────────────
    //
    // Verdict posé par le registre (`err.horsLigne`, connectors/site-hors-ligne.js) :
    // une erreur réseau vers le domaine du service, et aucune réponse du site
    // pendant tout le passage. Ni un refus, ni une panne du connecteur : la
    // phrase le dit, la cause est « hors ligne » (gris), le statut ne change
    // pas, et le détail technique part au journal sans adresse complète.
    if (err.horsLigne) {
      const nom = registry.has(connectorId) ? registry.manifest(connectorId).name : connectorId;
      applog.warn('scheduler', `${connectorId} : ${siteHorsLigne.ligneDeJournal(err.horsLigne, brut)}`, qui);
      const outcome = finish(false, 0, siteHorsLigne.messageHorsLigne(nom, err.horsLigne), causeEchec.HORS_LIGNE);
      applog.warn('scheduler', `${nom} (${user.username}) : ${outcome.message}`, qui);
      if (trigger === 'cron') notifications.signalerEchec(user, connectorId, nom, outcome.message);
      return outcome;
    }

    // ─── La cause, puis les mots (lot 91) ───────────────────────────────────
    //
    // Un échec d'authentification (`err.sessionExpired`) est l'une de deux
    // choses, et la règle de connectors/cause-echec.js tranche, à partir de
    // l'historique et jamais du texte :
    //
    //   - CONNEXION REFUSÉE (rouge) — c'est la récupération qui a suivi
    //     immédiatement l'enregistrement d'une connexion : le site refuse
    //     alors même qu'on vient de se connecter. Son texte dit d'attendre
    //     avant de réessayer. Seule exception : un site qui a DIT que les
    //     identifiants étaient faux garde sa phrase, qui dit quoi corriger ;
    //   - SESSION EXPIRÉE (orange) — tout le reste, et dans le doute. Le
    //     texte est daté dès que l'historique le permet (lot 71 : un refus
    //     après un succès s'appelle une expiration). Le renvoi vers
    //     l'authentification malgré une session enregistrée (lot 57,
    //     `renvoiAuthentification`) ne fait plus deviner l'utilisateur entre
    //     deux issues : il reçoit lui aussi le texte de la session expirée.
    //
    // Sans rien de daté ni de renvoi, le message du connecteur reste : c'est
    // une première connexion qui échoue, et il le dit mieux que nous.
    const echecConnexion = !!err.sessionExpired;
    let cause = causeEchec.ECHEC;
    try {
      const debut = db.get().prepare('SELECT started_at FROM run_logs WHERE id = ?').get(logId)?.started_at;
      cause = causeEchec.causePour({
        userId,
        connectorId,
        runId: logId,
        debut,
        echecConnexion,
        // Lot 105 — le connecteur a constaté que la session n'existe plus
        // (Alma : le stockage du portail manque) : orange, jamais « refusée ».
        expirationCertaine: !!err.expirationCertaine,
      });
    } catch (erreurCause) {
      // La cause ne doit jamais empêcher d'écrire l'échec : dans le doute,
      // une session expirée pour un refus d'authentification, un échec sinon.
      cause = echecConnexion ? causeEchec.SESSION_EXPIREE : causeEchec.ECHEC;
      applog.warn('scheduler', `${connectorId} : cause de l'échec indécidable (${erreurCause.message}).`, qui);
    }

    if (echecConnexion && brut) {
      if (cause === causeEchec.CONNEXION_REFUSEE) {
        if (err.situation !== 'identifiants-refuses') message = messagesEchec.messageConnexionRefusee();
      } else {
        const derniereReussite = db
          .get()
          .prepare(
            `SELECT MAX(finished_at) AS quand FROM run_logs
              WHERE user_id = ? AND connector_id = ? AND success = 1
                AND finished_at IS NOT NULL AND trigger != 'test'`
          )
          .get(userId, connectorId)?.quand || null;
        const meta = connectorConfig?.__meta || {};
        const sessionOuverteLe =
          causeEchec.derniereConnexionAvant(userId, connectorId, '9999-12-31 23:59:59')
          || Object.values(meta).find((m) => m?.type === 'session' && m.savedAt)?.savedAt
          || null;
        const expiration = messagesEchec.messageDeRefusExpire({
          derniereReussite,
          sessionOuverteLe,
          zone: settings.timezone(),
        });
        if (expiration) message = expiration;
        else if (err.renvoiAuthentification) message = messagesEchec.messageSessionExpiree();
      }
    }

    // ─── L'abandon n'est complet que si le navigateur s'éteint (lot 67) ─────
    //
    // La ligne se referme et le verrou se rend juste en dessous ; sans ce
    // geste-ci, il resterait un Chromium vivant sur le profil du compte, et
    // la récupération SUIVANTE échouerait sur « le navigateur est déjà
    // ouvert ». On ne l'éteint QUE sur un dépassement de durée : une erreur
    // ordinaire, elle, a déjà fait passer le connecteur par son propre
    // `finally`, qui referme le navigateur proprement.
    if (err.dureeDepassee && err.retardMs) {
      applog.warn(
        'scheduler',
        `${connectorId} : la limite de durée a joué avec ${dureeLisible(err.retardMs)} de retard — `
          + 'crabe était bloqué (processus ou serveur saturé) et n\'a pu arrêter la récupération '
          + 'qu\'à son réveil.',
        qui
      );
    }
    if (err.dureeDepassee) {
      // Ce couple-ci tient encore son verrou (`running.delete` vit dans le
      // `finally` de runForUser, qui n'a pas encore joué) : s'il est seul dans
      // la table, aucune autre exécution ne peut revendiquer un navigateur.
      const seul = runningPairs().every(
        (p) => p.userId === userId && p.connectorId === connectorId
      );
      eteindreNavigateur.eteindre(
        { profil: profilPersistant.chemin(userId, connectorId), seul },
        {
          ...eteindreNavigateur.runtimeParDefaut(),
          log: (niveau, texte) =>
            applog[niveau]('scheduler', `${connectorId} : ${texte}`, qui),
        }
      );
    }

    const outcome = finish(false, 0, message, cause);

    applog.error(
      'scheduler',
      `${registry.has(connectorId) ? registry.manifest(connectorId).name : connectorId} `
        + `(${user.username}) : ${outcome.message}`,
      qui
    );

    // Une récupération automatique qui échoue doit se voir : sans notification,
    // un connecteur peut tomber en panne et le rester des mois sans que
    // personne ne s'en aperçoive.
    //
    // ⚠ On ne fait qu'ANNONCER l'échec (lot 26) : l'envoi, lui, attend que le
    // passage de planification se termine, pour ne pas expédier dix courriels
    // identiques quand le réseau a hoqueté trois minutes. Voir
    // server/notifications.js. Un test manuel ne notifie rien : son résultat
    // est déjà sous les yeux de celui qui l'a lancé.
    if (trigger === 'cron') {
      notifications.signalerEchec(
        user,
        connectorId,
        registry.has(connectorId) ? registry.manifest(connectorId).name : connectorId,
        outcome.message
      );
    }

    return outcome;
  }
}

/**
 * Exécute un connecteur pour tous les utilisateurs qui l'ont configuré.
 * Les échecs individuels — verrou compris — n'interrompent pas la boucle.
 */
async function runForAllUsers(connectorId, trigger = 'cron') {
  // Un connecteur déclaré non faisable (lot 106) ne se lance pour personne.
  if (registry.has(connectorId) && registry.nonFaisable(connectorId)) return [];
  const installs = db
    .get()
    .prepare(
      `SELECT ci.user_id
         FROM connector_installs ci
         JOIN users u ON u.id = ci.user_id
        WHERE ci.connector_id = ?
          AND ci.config_encrypted IS NOT NULL
          AND ci.disabled_at IS NULL
          AND u.status = 'active'`
    )
    .all(connectorId);

  const results = [];
  for (const { user_id: userId } of installs) {
    try {
      results.push({ userId, ...(await runForUser(userId, connectorId, trigger)) });
    } catch (err) {
      results.push({
        userId,
        ok: false,
        count: 0,
        message: err.message,
        skipped: !!err.alreadyRunning || !!err.enFile,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Planification
// ---------------------------------------------------------------------------

/**
 * Dernier résultat connu pour un connecteur, tous comptes confondus.
 *
 * ⚠ Seules les exécutions TERMINÉES comptent (`finished_at IS NOT NULL`).
 * Une ligne de run_logs naît au démarrage de l'exécution avec `success = 0`
 * et sans message : la prendre pour « dernier résultat » faisait afficher
 * « Échec » sur une récupération en cours (14/08/2026, soyoustart). Le
 * « dernier résultat » d'une exécution qui n'a pas fini est celui d'avant.
 */
function lastRunFor(connectorId) {
  return normalizeRun(
    db
      .get()
      .prepare(
        `SELECT r.id, r.user_id, r.connector_id, r.started_at, r.finished_at, r.success,
                r.invoice_count, r.message, r.trigger, r.cause,
                COALESCE(u.username, '(compte supprimé)') AS username
           FROM run_logs r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.connector_id = ? AND r.finished_at IS NOT NULL
          ORDER BY r.started_at DESC, r.id DESC LIMIT 1`
      )
      .get(connectorId)
  );
}

/** Dernier résultat pour un couple (utilisateur, connecteur). Terminées seules. */
function lastRunForUser(userId, connectorId) {
  return normalizeRun(
    db
      .get()
      .prepare(
        `SELECT r.id, r.user_id, r.connector_id, r.started_at, r.finished_at, r.success,
                r.invoice_count, r.message, r.trigger, r.cause, u.username
           FROM run_logs r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.user_id = ? AND r.connector_id = ? AND r.finished_at IS NOT NULL
          ORDER BY r.started_at DESC, r.id DESC LIMIT 1`
      )
      .get(userId, connectorId)
  );
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    at: row.started_at,
    finishedAt: row.finished_at,
    success: !!row.success,
    invoiceCount: row.invoice_count,
    // Lot 111 : sans la promesse d'un réessai qui n'existe pas.
    message: siteHorsLigne.sansReessaiPromis(row.message),
    trigger: row.trigger,
    username: row.username,
    // Lot 91 : la cause d'un échec, servie par la règle unique — jamais
    // devinée à l'écran à partir du message.
    cause: causeEchec.causeDeLigne(row),
  };
}

/**
 * Planifications réelles : une par installation, enrichie du connecteur et du
 * dernier résultat. C'est ce que consomme l'écran « Automatisation ».
 */
function listSchedules() {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));

  return schedules
    .listInstallations()
    .filter((s) => catalog.has(s.connectorId))
    .map((s) => {
      const connector = catalog.get(s.connectorId);
      return {
        ...s,
        id: `${s.userId}:${s.connectorId}`,
        name: connector.name,
        color: connector.color,
        letters: connector.letters,
        logo: connector.logo || null,
        maintenance: !!connector.maintenance,
        cron: schedules.toCronExpression(s),
        // ⚠ Un connecteur en pause n'a pas de prochaine exécution — et le dire
        // serait un mensonge d'écran : aucune tâche n'est armée pour lui.
        nextRunAt: s.disabledAt ? null : schedules.nextRunAt(s),
        rhythm: schedules.rhythmLabel(s),
        running: isRunning(s.userId, s.connectorId),
        waiting: attentePour(s.userId, s.connectorId),
        lastRun: lastRunForUser(s.userId, s.connectorId),
      };
    });
}

function saveSchedule(userId, connectorId, values) {
  if (!registry.has(connectorId)) throw new Error(`Connecteur inconnu : ${connectorId}`);
  if (!registry.getInstall(userId, connectorId)) {
    const err = new Error('Ce connecteur n\'est pas installé pour ce compte.');
    err.statusCode = 404;
    throw err;
  }

  schedules.save(userId, connectorId, values);
  reload();
  return listSchedules().find((s) => s.userId === userId && s.connectorId === connectorId);
}

// ---------------------------------------------------------------------------
// Les tirages manqués (bilan de santé du 25/10/2026, constat 6)
//
// Un tirage planifié se perdait sans trace en base ni rattrapage : node-cron
// n'accordait qu'une seconde de retard, et toutes les planifications tombent
// à la même seconde — un blocage de 2,2 s en faisait sauter cinq sur six
// (mesuré par script). En production, le 02/10 (processus bloqué plus d'un
// jour, puis tué faute de mémoire) et le 16/10 à 03:00. Avec un rythme
// mensuel, le service attendait le mois suivant sans que personne le sache.
// Désormais :
//   - TOLERANCE_TIRAGE_MS de retard est accepté ;
//   - un tirage déclaré manqué part quand même, et le journal le dit ;
//   - au démarrage, une échéance passée pendant l'arrêt est rattrapée une fois.
// ---------------------------------------------------------------------------

const TOLERANCE_TIRAGE_MS = 5 * 60 * 1000;

/** Une échéance plus ancienne que ce délai n'est plus rattrapée au démarrage. */
const RATTRAPAGE_MAX_MS = 3 * 24 * 60 * 60 * 1000;

/** « 01/10/2026 à 03:00 », dans le fuseau de l'application. */
function horodatageLisible(date) {
  const zone = tz.isValid(settings.timezone()) ? settings.timezone() : 'Europe/Paris';
  const p = tz.partsInZone(date, zone);
  const deux = (n) => String(n).padStart(2, '0');
  return `${deux(p.day)}/${deux(p.month)}/${p.year} à ${deux(p.hour)}:${deux(p.minute)}`;
}

/** `Date` → la forme des colonnes datées de SQLite (`datetime('now')`, UTC). */
function enDateSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Lance une récupération planifiée, et dit au journal comment elle a fini. */
function lancerPlanifiee(s) {
  lastCronAt = new Date().toISOString();
  return runForUser(s.userId, s.connectorId, 'cron')
    .then((result) => {
      // Une exécution planifiée en échec ne doit pas se ranger parmi
      // les lignes vertes du journal : c'est ainsi qu'un connecteur
      // tombe en panne des mois durant sans que personne ne le voie.
      applog[result.ok ? 'info' : 'error'](
        'scheduler',
        `${s.name} (${s.username}) : exécution planifiée — ${result.message}.`
      );
    })
    .catch((err) => {
      // Déjà en cours ou déjà en file : rien d'anormal, la demande vit.
      const level = err.alreadyRunning || err.enFile ? 'warn' : 'error';
      applog[level](
        'scheduler',
        `${s.name} (${s.username}) : exécution planifiée non lancée — ${err.message}`
      );
    });
}

/** La dernière échéance d'une planification au plus tard à `maintenant`, dans la fenêtre de rattrapage. */
function derniereEcheance(s, maintenant) {
  let curseur = new Date(maintenant.getTime() - RATTRAPAGE_MAX_MS);
  let derniere = null;
  for (let pas = 0; pas < 100; pas++) {
    const suivante = schedules.nextRunAt(s, curseur);
    if (!suivante) break;
    const date = new Date(suivante);
    if (date > maintenant) break;
    derniere = date;
    curseur = new Date(date.getTime() + 1000);
  }
  return derniere;
}

/**
 * Au démarrage : les échéances passées pendant que crabe était arrêté.
 *
 * Une échéance est rattrapée, une seule fois, si elle tombe dans les
 * RATTRAPAGE_MAX_MS passés, qu'aucune récupération du couple n'a commencé
 * depuis, que le couple en avait déjà eu une AVANT (il tournait déjà), et que
 * sa planification n'a pas été modifiée après l'échéance — jamais une
 * échéance d'avant l'installation. La récupération coupée par l'arrêt compte
 * comme commencée : elle n'est pas relancée (choix du lot 90, voir
 * cloreLesExecutionsInterrompues).
 *
 * @param {Date} [maintenant]
 * @returns {Array<{userId: number, connectorId: string, echeance: string}>} ce qui est lancé
 */
function rattraperLesEcheancesManquees(maintenant = new Date()) {
  if (config.schedulerDisabled) return [];
  const lances = [];
  for (const { s, echeance } of echeancesARattraper(maintenant)) {
    applog.warn(
      'scheduler',
      `${s.name} (${s.username}) : l'échéance du ${horodatageLisible(echeance)} n'a pas eu lieu `
        + '(crabe était arrêté) — elle est rattrapée maintenant.'
    );
    lancerPlanifiee(s);
    lances.push({ userId: s.userId, connectorId: s.connectorId, echeance: echeance.toISOString() });
  }
  return lances;
}

/**
 * Le choix seul, sans rien lancer : les planifications armées dont la dernière
 * échéance est à rattraper (règles ci-dessus).
 * @param {Date} maintenant
 * @param {{armee?: (s: object) => boolean}} [options] `armee` remplace « la tâche cron est armée » (essais)
 * @returns {Array<{s: object, echeance: Date}>}
 */
function echeancesARattraper(maintenant, { armee = (s) => tasks.has(s.id) } = {}) {
  const depuis = db.get().prepare(
    'SELECT 1 FROM run_logs WHERE user_id = ? AND connector_id = ? AND started_at >= ? LIMIT 1'
  );
  const avant = db.get().prepare(
    'SELECT 1 FROM run_logs WHERE user_id = ? AND connector_id = ? AND started_at < ? LIMIT 1'
  );
  const choisies = [];
  for (const s of listSchedules()) {
    if (!armee(s)) continue; // seules les planifications armées
    const echeance = derniereEcheance(s, maintenant);
    if (!echeance || !schedules.isDueOn(s, echeance)) continue;
    const sql = enDateSql(echeance);
    if (s.updatedAt && s.updatedAt >= sql) continue;
    if (depuis.get(s.userId, s.connectorId, sql)) continue;
    if (!avant.get(s.userId, s.connectorId, sql)) continue;
    choisies.push({ s, echeance });
  }
  return choisies;
}

/** Arrête toutes les tâches cron enregistrées. */
function stopAll() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}

/**
 * (Re)construit les tâches cron depuis la base.
 *
 * Une tâche n'est armée que si le couple est **réellement exécutable** :
 * connecteur installé ET configuré, compte actif, planification activée.
 *
 * @returns {{scheduled: number, disabled: boolean, details: string[]}}
 */
function reload() {
  stopAll();
  if (config.schedulerDisabled) return { scheduled: 0, disabled: true, details: [] };

  // Le fuseau vient des réglages applicatifs, pas de la variable TZ du
  // conteneur : c'est ce qui garantit que « 03:00 » veut bien dire 03:00 à
  // Paris même si le LXC est en Etc/UTC.
  const timezone = tz.isValid(settings.timezone()) ? settings.timezone() : 'Europe/Paris';
  const details = [];

  for (const s of listSchedules()) {
    if (!s.configured || !s.userActive) continue;
    // ─── Déclaré non faisable (lot 106) ─────────────────────────────────────
    //
    // Aucune tâche n'est armée : aucun ordonnancement ne le lance. La
    // planification reste enregistrée ; retirer `unfeasible` du manifeste la
    // réarme au démarrage suivant.
    if (registry.has(s.connectorId) && registry.nonFaisable(s.connectorId)) continue;
    // ─── Mis en pause par son utilisateur (lot 82) ────────────────────────
    //
    // Aucune tâche n'est armée : c'est ÇA, la pause. La planification reste
    // enregistrée intacte, elle sera réarmée telle quelle au rallumage —
    // sans rattrapage de ce qui a été manqué, le mode « depuis » du
    // connecteur s'en charge tout seul au premier passage.
    if (s.disabledAt) continue;
    if (!s.cron || !cron.validate(s.cron)) continue;

    const task = cron.schedule(
      s.cron,
      () => {
        // « Dernier jour du mois » : l'expression cron couvre les 28 au 31,
        // c'est ici qu'on écarte les faux déclenchements.
        if (!schedules.isDueOn(s)) return;
        lancerPlanifiee(s);
      },
      // Bilan du 25/10/2026 : node-cron n'accordait qu'une seconde de retard.
      { timezone, missedExecutionTolerance: TOLERANCE_TIRAGE_MS }
    );

    // Au-delà de la tolérance, node-cron déclare le tirage manqué (processus
    // bloqué, mesuré le 02/10 et le 16/10) : il est lancé quand même, et dit.
    // Plusieurs tirages manqués d'une même rafale ne lancent qu'une fois.
    let dernierManque = 0;
    task.on('execution:missed', (contexte) => {
      const date = contexte?.date instanceof Date ? contexte.date : new Date();
      if (!schedules.isDueOn(s, date)) return;
      if (Date.now() - dernierManque < 60_000) return;
      dernierManque = Date.now();
      applog.warn(
        'scheduler',
        `${s.name} (${s.username}) : le tirage prévu le ${horodatageLisible(date)} a été manqué `
          + '(crabe était occupé ou bloqué) — il est lancé maintenant.'
      );
      lancerPlanifiee(s);
    });

    tasks.set(s.id, task);
    details.push(schedules.describe(s, { connectorId: s.connectorId, next: s.nextRunAt }));
  }

  return { scheduled: tasks.size, disabled: false, details };
}

/**
 * Résumé du démarrage : le détail plutôt qu'un compte brut.
 *   « 1 planification — free (camille, mensuel, jour 5 à 03:00, prochaine le 05/08/2026) »
 */
function summarize(result) {
  if (result.disabled) return 'désactivé (CRABE_DISABLE_SCHEDULER=1)';
  if (!result.scheduled) return 'aucune planification — aucun connecteur installé et configuré';
  const noun = result.scheduled > 1 ? 'planifications' : 'planification';
  return `${result.scheduled} ${noun} — ${result.details.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Tâches d'entretien quotidiennes
// ---------------------------------------------------------------------------

let maintenanceTask = null;
/** Derniers passages, exposés par la page « Système ». */
let lastCronAt = null;
let lastMaintenanceAt = null;

/**
 * Purge de TOUS les journaux selon la rétention configurée : connexions,
 * exécutions de connecteurs, journal applicatif et opérations de stockage.
 *
 * @returns {{days: number, connections: number, runs: number, app: number, storage: number, total: number}}
 */
function purgeOldLogs() {
  const policy = db.get().prepare('SELECT log_retention_days FROM security_policy WHERE id = 1').get();
  const days = policy?.log_retention_days || 365;
  const cutoff = `-${days} days`;

  const connections = db
    .get()
    .prepare("DELETE FROM connection_logs WHERE date < datetime('now', ?)")
    .run(cutoff).changes;
  const runs = db
    .get()
    .prepare("DELETE FROM run_logs WHERE started_at < datetime('now', ?)")
    .run(cutoff).changes;
  const storage = db
    .get()
    .prepare("DELETE FROM destination_logs WHERE at < datetime('now', ?)")
    .run(cutoff).changes;
  const app = applog.purge(days);

  return {
    days,
    connections,
    runs,
    app,
    storage,
    total: connections + runs + app + storage,
  };
}

function startMaintenance() {
  if (config.schedulerDisabled || maintenanceTask) return;
  // Tous les jours à 04:15 : purge des logs + suppressions RGPD arrivées à terme.
  maintenanceTask = cron.schedule(
    '15 4 * * *',
    async () => {
      try {
        const purged = purgeOldLogs();
        if (purged.total) {
          applog.info(
            'scheduler',
            `Entretien : ${purged.total} ligne(s) de journal purgée(s) au-delà de ${purged.days} jours ` +
              `(connexions ${purged.connections}, exécutions ${purged.runs}, application ${purged.app}, stockage ${purged.storage}).`
          );
        }
        require('./email-change').purgeExpired();

        // Profondeur de documents conservée. Ne s'applique jamais à ce qui
        // existait avant le réglage, sauf confirmation explicite de
        // l'administrateur (voir server/retention.js).
        const documents = require('./retention').purge();
        if (documents.deleted || documents.failed) {
          applog.info(
            'scheduler',
            `Entretien : ${documents.deleted} document(s) supprimé(s) au-delà de `
              + `${require('./retention').label(documents.months)}`
              + (documents.failed ? `, ${documents.failed} en échec` : '')
              + '.'
          );
        }

        // Chargement tardif : deletion.js dépend du scheduler pour les runs.
        const deletion = require('./deletion');
        const done = await deletion.processDueDeletions();
        if (done.length) {
          applog.warn('scheduler', `${done.length} compte(s) purgé(s) définitivement (RGPD).`);
        }

        // Optimisation (lot 60) : le filet au seuil d'espace libre, puis les
        // volets en mode automatique dont la récurrence est échue. Tout naît
        // en manuel : tant que l'administrateur n'a rien choisi, seul le
        // filet peut agir — cache seul, journalisé. Ne lève jamais.
        require('./optimisation').entretienQuotidien();

        lastMaintenanceAt = new Date().toISOString();
      } catch (err) {
        applog.error('scheduler', `Entretien quotidien en échec : ${err.message}`);
      }
    },
    { timezone: tz.isValid(settings.timezone()) ? settings.timezone() : 'Europe/Paris' }
  );
}

/**
 * Clôt les exécutions restées « en cours » après un arrêt brutal de crabe.
 *
 * Une ligne de run_logs naît au démarrage de l'exécution et n'est complétée
 * qu'à la fin ; si le processus meurt entre les deux, elle reste sans
 * `finished_at` pour toujours. Les écrans la montrent « en cours » — un
 * mensonge permanent. Au démarrage, aucune exécution ne peut être
 * légitimement en cours (le verrou `running` est en mémoire, il meurt avec le
 * processus) : toute ligne inachevée est donc un vestige, qu'on transforme en
 * échec honnête, avec une phrase qui dit quoi faire.
 *
 * ⚠ À n'appeler QU'AU démarrage, jamais depuis reload() : reload() se relance
 * à chaque installation de connecteur, et clorait une exécution bien réelle.
 */
function cloreLesExecutionsInterrompues() {
  // ─── Sa vraie fin, pas l'heure du redémarrage (lot 110) ───────────────────
  //
  // Jusqu'ici la ligne était close à `datetime('now')` : le 01/10/2026, celle
  // de paypal a affiché 137 829 s (38 h) alors que plus rien ne s'était écrit
  // depuis 01:00:19. La fin d'un travail interrompu, c'est sa DERNIÈRE TRACE
  // au journal applicatif — une ligne du planificateur ou du connecteur, pour
  // ce couple, depuis son départ — ou, sans trace, son départ lui-même.
  const ouvertes = db
    .get()
    .prepare('SELECT id, user_id, connector_id, started_at FROM run_logs WHERE finished_at IS NULL ORDER BY id')
    .all();
  if (!ouvertes.length) return 0;
  const maintenant = db.get().prepare("SELECT datetime('now') AS t").get().t;
  const derniereTrace = db.get().prepare(
    `SELECT MAX(at) AS at FROM app_logs
      WHERE at >= ? AND at <= ? AND (user_id IS NULL OR user_id = ?)
        AND (source = ? OR (source = 'scheduler' AND message LIKE ?))`
  );
  const clore = db.get().prepare(
    `UPDATE run_logs SET finished_at = ?, success = 0, message = ?, cause = 'echec'
      WHERE id = ? AND finished_at IS NULL`
  );
  const zone = settings.timezone();
  let closes = 0;
  for (const ligne of ouvertes) {
    let trace = null;
    try {
      trace = derniereTrace.get(
        ligne.started_at,
        maintenant,
        ligne.user_id,
        `connector:${ligne.connector_id}`,
        `${ligne.connector_id} %`
      )?.at || null;
    } catch {
      trace = null; // journal illisible : la ligne se clôt quand même, à son départ
    }
    const fin = trace && trace > ligne.started_at ? trace : ligne.started_at;
    const message = messagesEchec.messageJamaisVide(
      messagesEchec.messageInterrompue({ derniereTrace: trace ? fin : null, zone }),
      'interrompu'
    );
    closes += clore.run(fin, message, ligne.id).changes;
  }
  if (closes) {
    applog.warn(
      'scheduler',
      `${closes} récupération(s) interrompue(s) par le dernier arrêt de crabe — `
        + 'marquée(s) en échec dans le journal des exécutions, closes à leur dernière trace.'
    );
  }
  return closes;
}

function start() {
  // L'ordre compte : les lignes restées « en cours » se ferment d'abord (la
  // récupération qui tournait à l'arrêt devient un échec dit, jamais une
  // relance), puis ce qui ATTENDAIT son tour reprend, une seule fois (lot 90).
  cloreLesExecutionsInterrompues();
  const result = reload();
  startMaintenance();
  reprendreLaFile();
  // Après la file : une demande qui attendait déjà n'est pas doublée (elle
  // refuserait d'ailleurs le doublon, « déjà en file »).
  rattraperLesEcheancesManquees();
  return result;
}

function stop() {
  stopAll();
  if (maintenanceTask) {
    maintenanceTask.stop();
    maintenanceTask = null;
  }
}

module.exports = {
  runForUser,
  runForAllUsers,
  decisionDepot,
  premierNomLibre,
  isRunning,
  runningPairs,
  attentePour,
  pairesEnAttente,
  reprendreLaFile,
  courseAvecFilet,
  toCronExpression: schedules.toCronExpression,
  nextRunAt: schedules.nextRunAt,
  lastRunFor,
  lastRunForUser,
  listSchedules,
  saveSchedule,
  summarize,
  reload,
  cloreLesExecutionsInterrompues,
  rattraperLesEcheancesManquees,
  echeancesARattraper,
  derniereEcheance,
  TOLERANCE_TIRAGE_MS,
  RATTRAPAGE_MAX_MS,
  erreurDureeDepassee,
  dureeLisible,
  SEUIL_RETARD_MS,
  LIMITE_EXECUTION_MS,
  limiteExecutionMs,
  start,
  stop,
  stopAll,
  purgeOldLogs,
  get activeTasks() {
    return tasks.size;
  },
  get enAttente() {
    return fileAttente.length;
  },
  get lastCronAt() {
    return lastCronAt;
  },
  get lastMaintenanceAt() {
    return lastMaintenanceAt;
  },
};
