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
const eteindreNavigateur = require('./connectors/eteindre-navigateur');
const profilPersistant = require('./connectors/profil-persistant');
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

/** L'échec d'une exécution abandonnée : ce qui s'est passé, et quoi en faire. */
function erreurDureeDepassee(ms) {
  const minutes = Math.round(ms / 60000);
  const err = new Error(
    `La récupération a été arrêtée : elle durait depuis plus de ${minutes} minute`
      + `${minutes > 1 ? 's' : ''} sans se terminer. Rien n'a été perdu — les documents déjà `
      + 'récupérés restent en place, et la prochaine récupération reprendra normalement. '
      + 'Si le message revient, signalez-le à la personne qui administre crabe : ce service '
      + 'demande plus de temps que prévu, ou son connecteur reste bloqué.'
  );
  err.dureeDepassee = true;
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
  promesse.catch(() => {});
  let minuteur = null;
  try {
    return await Promise.race([
      promesse,
      new Promise((_, rejeter) => {
        minuteur = setTimeout(() => rejeter(erreurDureeDepassee(limite)), limite);
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
        `INSERT INTO run_logs (connector_id, user_id, finished_at, success, trigger, message)
         VALUES (?, ?, datetime('now'), 0, ?, ?)`
      )
      .run(connectorId, userId, trigger, message);
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
  running.set(key, new Date().toISOString());

  try {
    return await runLocked(user, connectorId, trigger, options);
  } finally {
    running.delete(key);
  }
}

/** Corps de la récupération, verrou déjà pris. */
async function runLocked(user, connectorId, trigger, options = {}) {
  const userId = user.id;

  const logId = db
    .get()
    .prepare('INSERT INTO run_logs (connector_id, user_id, trigger) VALUES (?, ?, ?)')
    .run(connectorId, userId, trigger).lastInsertRowid;

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

  const finish = (ok, count, message) => {
    // ⚠ Un échec sans message est interdit (14/08/2026 : « ÉCHEC | "" » au
    // journal). La garde vit ICI, au point d'écriture unique, et non dans
    // chaque chemin d'erreur : un connecteur futur qui lèvera une Error('')
    // sera couvert sans que personne y pense. Même point unique pour le
    // jargon d'automatisation (lot 37) : l'écran reçoit une phrase lisible,
    // le texte brut part au journal technique.
    const texte = ok ? message : messagesEchec.messageJamaisVide(message, 'recuperation', (brut) =>
      applog.warn('scheduler', `${connectorId} : détail technique de l'échec — ${brut}`, {
        userId,
        username: user.username,
      }));
    db.get()
      .prepare(
        `UPDATE run_logs
            SET finished_at = datetime('now'), success = ?, invoice_count = ?, message = ?
          WHERE id = ?`
      )
      .run(ok ? 1 : 0, count, texte, logId);
    db.get()
      .prepare(
        `UPDATE connector_installs
            SET status = ?, last_error = ?, last_run_at = datetime('now')
          WHERE user_id = ? AND connector_id = ?`
      )
      .run(ok ? 'installed' : 'error', ok ? null : texte, userId, connectorId);

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
        // Tant qu'une récupération tourne, la série n'est pas finie : sans
        // cela, les 71 minutes de `paybyphone` couperaient une balayée en deux
        // et enverraient deux bilans au lieu d'un.
        { enCours: () => runningPairs().length > 0 }
      );
    }

    return { ok, count, message: texte };
  };

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

    let connectorConfig = registry.readConfig(userId, connectorId);
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

    const knownRemoteIds = db
      .get()
      .prepare(
        'SELECT remote_id FROM invoices WHERE user_id = ? AND connector_id = ? AND remote_id IS NOT NULL'
      )
      .all(userId, connectorId)
      .map((r) => r.remote_id);

    const fetched = await avecLimiteDeDuree(
      registry.fetchInvoicesDetailed(connectorId, connectorConfig, {
        // Les connecteurs à profil persistant (addons-prestashop) rouvrent le
        // profil du couple (utilisateur, connecteur) : il leur faut l'utilisateur.
        userId,
        knownRemoteIds,
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
          applog.info('scheduler', message, { userId, username: user.username })
        ),
      })
    );

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
        'SELECT destinations FROM invoices WHERE user_id = ? AND connector_id = ? AND filename = ?'
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

    let stored = 0;
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

      const results = await destinations.storeInvoice({
        username: user.username,
        userId: user.id,
        connectorId,
        connectorName,
        accountId: invoiceAccountId,
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
      const previous = readExisting.get(userId, connectorId, invoice.filename)?.destinations;
      const destinationsJson = invoices.mergeOutcomes(previous || '{}', results);

      db.get()
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
      stored++;
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
    const message =
      (stored === 0
        ? fetched.aucunDocument || fetched.horsPeriode || 'Aucune nouvelle facture'
        : `${stored} facture${stored > 1 ? 's' : ''} récupérée${stored > 1 ? 's' : ''}`)
      + suffixe;
    return finish(true, stored, message);
  } catch (err) {
    // Une session expirée porte déjà une phrase qui dit quoi faire : la
    // préfixer d'« Échec — » la noierait. Les autres erreurs, si — mais
    // seulement si l'erreur a un texte : « Échec — » suivi de rien passerait
    // la garde de finish() tout en ne disant rien (le préfixe la rendrait
    // non vide), et c'est exactement le message fantôme qu'on interdit.
    const brut = String(err.message || '').trim();
    const message = !brut ? '' : err.sessionExpired ? brut : `Échec — ${brut}`;

    // ─── L'abandon n'est complet que si le navigateur s'éteint (lot 67) ─────
    //
    // La ligne se referme et le verrou se rend juste en dessous ; sans ce
    // geste-ci, il resterait un Chromium vivant sur le profil du compte, et
    // la récupération SUIVANTE échouerait sur « le navigateur est déjà
    // ouvert ». On ne l'éteint QUE sur un dépassement de durée : une erreur
    // ordinaire, elle, a déjà fait passer le connecteur par son propre
    // `finally`, qui referme le navigateur proprement.
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
            applog[niveau]('scheduler', `${connectorId} : ${texte}`, {
              userId,
              username: user.username,
            }),
        }
      );
    }

    const outcome = finish(false, 0, message);

    applog.error(
      'scheduler',
      `${registry.has(connectorId) ? registry.manifest(connectorId).name : connectorId} `
        + `(${user.username}) : ${outcome.message}`,
      { userId, username: user.username }
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
  const installs = db
    .get()
    .prepare(
      `SELECT ci.user_id
         FROM connector_installs ci
         JOIN users u ON u.id = ci.user_id
        WHERE ci.connector_id = ?
          AND ci.config_encrypted IS NOT NULL
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
        skipped: !!err.alreadyRunning,
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
        `SELECT r.started_at, r.finished_at, r.success, r.invoice_count, r.message, r.trigger,
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
        `SELECT r.started_at, r.finished_at, r.success, r.invoice_count, r.message, r.trigger,
                u.username
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
    message: row.message,
    trigger: row.trigger,
    username: row.username,
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
        nextRunAt: schedules.nextRunAt(s),
        rhythm: schedules.rhythmLabel(s),
        running: isRunning(s.userId, s.connectorId),
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
    if (!s.cron || !cron.validate(s.cron)) continue;

    const task = cron.schedule(
      s.cron,
      () => {
        // « Dernier jour du mois » : l'expression cron couvre les 28 au 31,
        // c'est ici qu'on écarte les faux déclenchements.
        if (!schedules.isDueOn(s)) return;

        lastCronAt = new Date().toISOString();
        runForUser(s.userId, s.connectorId, 'cron')
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
            const level = err.alreadyRunning ? 'warn' : 'error';
            applog[level](
              'scheduler',
              `${s.name} (${s.username}) : exécution planifiée non lancée — ${err.message}`
            );
          });
      },
      { timezone }
    );

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
  const result = db
    .get()
    .prepare(
      `UPDATE run_logs
          SET finished_at = datetime('now'), success = 0, message = ?
        WHERE finished_at IS NULL`
    )
    .run(messagesEchec.messageJamaisVide('', 'interrompu'));
  if (result.changes) {
    applog.warn(
      'scheduler',
      `${result.changes} récupération(s) interrompue(s) par le dernier arrêt de crabe — `
        + 'marquée(s) en échec dans le journal des exécutions.'
    );
  }
  return result.changes;
}

function start() {
  cloreLesExecutionsInterrompues();
  const result = reload();
  startMaintenance();
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
  isRunning,
  runningPairs,
  toCronExpression: schedules.toCronExpression,
  nextRunAt: schedules.nextRunAt,
  lastRunFor,
  lastRunForUser,
  listSchedules,
  saveSchedule,
  summarize,
  reload,
  cloreLesExecutionsInterrompues,
  LIMITE_EXECUTION_MS,
  limiteExecutionMs,
  start,
  stop,
  stopAll,
  purgeOldLogs,
  get activeTasks() {
    return tasks.size;
  },
  get lastCronAt() {
    return lastCronAt;
  },
  get lastMaintenanceAt() {
    return lastMaintenanceAt;
  },
};
