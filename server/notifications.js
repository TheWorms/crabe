'use strict';

/**
 * Être prévenu quand crabe a quelque chose à dire — et le prouver.
 *
 * ─── Ce que ça corrige (lot 26) ──────────────────────────────────────────────
 *
 * Un e-mail était déjà envoyé, mais **un par connecteur en échec**. Or les
 * planifications tombent en grappe — dix-neuf services sur le compte mesuré, la plupart à
 * 03:00 — et la cause la plus fréquente d'un échec est commune à tous : le
 * réseau qui a hoqueté, le serveur qui redémarrait, une coupure chez le
 * fournisseur d'accès. Une panne de trois minutes envoyait donc dix courriels
 * disant la même chose, à trois secondes d'intervalle. C'est le meilleur moyen
 * de faire ignorer les suivants — y compris le seul qui comptait vraiment.
 *
 * Les échecs d'un MÊME PASSAGE de planification partent donc en un seul
 * message, avec la liste des services concernés et le motif de chacun.
 *
 * ─── Ce que ça corrige (lot 66) ──────────────────────────────────────────────
 *
 * Le mécanisme ci-dessus marchait, et n'avait **jamais rien envoyé**. Mesuré
 * sur l'installation réelle : six exécutions planifiées depuis l'installation,
 * **toutes réussies**, donc pas un seul appel — pendant que cent soixante-neuf
 * échecs passaient par des récupérations lancées à la main, dont vingt et une
 * grappes de cinq services ou plus, l'une de vingt-cinq services sur cent
 * quatre minutes, et un renommage de trois heures treize.
 *
 * Autrement dit : les seuls moments où l'on n'est PAS devant son écran
 * n'étaient couverts par rien. C'est exactement là qu'une notification a de la
 * valeur — le bandeau d'opérations (lots 59-65) dit déjà ce qui se passe quand
 * la page est ouverte.
 *
 * Trois événements, pas trente. Mieux vaut trois messages qu'on lit que trente
 * qu'on apprend à ignorer :
 *
 *   1. **une récupération PLANIFIÉE a échoué** — regroupée par passage ;
 *   2. **une série de récupérations lancées à la main s'achève** — un seul
 *      message pour tout le chantier, avec le compte des échecs. Un service
 *      seul n'en produit aucun : son résultat est déjà sous les yeux de qui
 *      vient de cliquer ;
 *   3. **un chantier long s'achève** (renommage des documents) — et seulement
 *      s'il a duré assez longtemps pour qu'on soit parti faire autre chose.
 *
 * ─── Rien n'échoue en silence (lot 66) ───────────────────────────────────────
 *
 * Avant ce lot, `envoyer()` sortait sans un mot dans TROIS cas : canal éteint,
 * SMTP absent, adresse absente. Un utilisateur qui attendait un message n'avait
 * donc aucun moyen de savoir lequel des trois le concernait. Désormais chaque
 * issue — envoyé, refusé, impossible — laisse une ligne de source
 * `notifications` dans le journal applicatif, lisible dans l'écran Logs, avec
 * sa cause et le geste qui la lèverait. Jamais de mot de passe ni de jeton.
 *
 * ─── Deux canaux, un réglage par compte ──────────────────────────────────────
 *
 *   - **e-mail** — la voie fiable, et la seule qui atteigne quelqu'un qui n'a
 *     pas crabe ouvert. Activée par défaut : un connecteur peut tomber en panne
 *     et le rester des mois sans que personne ne s'en aperçoive. Sans SMTP
 *     configuré ou sans adresse connue, il ne se passe rien — ce n'est pas une
 *     erreur, c'est une notification impossible, et elle se dit au journal ;
 *   - **notification du navigateur** — un COMPLÉMENT, jamais un remplacement.
 *     crabe n'a ni service worker ni notification poussée : la notification ne
 *     peut apparaître que si une page de crabe est ouverte au moment où elle
 *     est relevée. Et elle exige un contexte sûr (HTTPS, ou `localhost`) :
 *     mesuré au lot 66, sur une adresse en `http://` la permission vaut
 *     « refusée » d'emblée dans Firefox comme dans Chromium, et
 *     `navigator.serviceWorker` n'existe même pas. L'écran de réglage le dit,
 *     plutôt que de laisser croire à une alerte qui suivrait partout.
 *
 * Le réglage est par compte, jamais global : deux personnes sur la même
 * installation n'ont pas les mêmes services ni la même tolérance au courriel.
 */

const db = require('./db/db');
const applog = require('./applog');
const mailer = require('./mailer');
const emailTemplates = require('./email-templates');
const preferences = require('./preferences');

/** Silence à observer avant de considérer qu'un passage planifié est terminé. */
const SILENCE_MS = 120_000;

/** Durée maximale d'accumulation, quoi qu'il arrive ensuite. */
const FENETRE_MAX_MS = 600_000;

/**
 * Silence à observer avant de considérer qu'une série lancée à la main est
 * terminée. Le compte à rebours ne court PAS pendant qu'une récupération
 * tourne encore (voir `armerBalayee`) : un seul service peut prendre plus
 * d'une heure — `paybyphone` a mis 71 minutes à chacune de ses exécutions
 * réussies — et le silence ne prouverait alors rien du tout.
 */
const SILENCE_BALAYEE_MS = 90_000;

/**
 * En dessous de deux services, ce n'est pas un chantier mais un geste : la
 * personne qui vient de cliquer « Lancer maintenant » lit le résultat à
 * l'écran. Le notifier serait le bruit qui fait ignorer les vrais messages.
 */
const SEUIL_BALAYEE = 2;

/**
 * Un chantier plus court que ça, on l'a regardé se faire. Ce seuil est la
 * traduction directe de la règle « une notification vaut quand on n'est pas
 * devant l'écran » : au-dessous, l'écran a déjà tout dit.
 */
const DUREE_CHANTIER_NOTIFIABLE_MS = 60_000;

/**
 * Les échecs planifiés en attente d'envoi, par compte.
 * @type {Map<number, {user: object, echecs: Array<{connectorId: string, nom: string, message: string, at: string}>, timer: NodeJS.Timeout|null, ouvertA: number}>}
 */
const enAttente = new Map();

/**
 * Les séries lancées à la main en cours de constitution, par compte.
 * @type {Map<number, {user: object, lignes: Array<{connectorId: string, nom: string, ok: boolean, message: string}>, timer: NodeJS.Timeout|null, enCours: () => boolean}>}
 */
const balayees = new Map();

/** Vrai tant que le processus tourne : coupé par `stop()` dans les tests. */
let actif = true;

/**
 * Le réglage d'un compte. Jamais d'exception : une préférence illisible ne doit
 * pas empêcher une notification, elle doit rendre le défaut.
 *
 * @returns {{email: boolean, navigateur: boolean}}
 */
function reglage(userId) {
  try {
    return {
      email: preferences.get(userId, 'notifications.echecs.email'),
      navigateur: preferences.get(userId, 'notifications.echecs.navigateur'),
    };
  } catch {
    return { email: true, navigateur: false };
  }
}

// ---------------------------------------------------------------------------
// 1. Une récupération PLANIFIÉE a échoué
// ---------------------------------------------------------------------------

/**
 * Signale l'échec d'une récupération planifiée. Ne bloque jamais l'appelant.
 *
 * @param {{id: number, username: string}} user
 * @param {string} connectorId
 * @param {string} nom      nom lisible du service
 * @param {string} message  le motif, tel qu'il sera lu
 */
function signalerEchec(user, connectorId, nom, message) {
  if (!actif || !user?.id) return;

  const maintenant = Date.now();
  if (!enAttente.has(user.id)) {
    enAttente.set(user.id, { user, echecs: [], timer: null, ouvertA: maintenant });
  }
  const lot = enAttente.get(user.id);

  // Le même service deux fois dans le même passage : on garde le dernier
  // motif. Deux lignes identiques dans un message n'apprennent rien.
  lot.echecs = lot.echecs.filter((e) => e.connectorId !== connectorId);
  lot.echecs.push({ connectorId, nom, message, at: new Date(maintenant).toISOString() });

  if (lot.timer) clearTimeout(lot.timer);
  // La fenêtre se repousse à chaque échec, mais jamais au-delà du plafond :
  // une série qui s'étire ne doit pas ajourner l'envoi indéfiniment.
  const restant = Math.max(0, lot.ouvertA + FENETRE_MAX_MS - maintenant);
  lot.timer = setTimeout(() => { envoyer(user.id).catch(() => {}); }, Math.min(SILENCE_MS, restant));
  // Un minuteur en attente ne doit pas retenir le processus à l'arrêt.
  if (typeof lot.timer.unref === 'function') lot.timer.unref();
}

/**
 * Envoie le message groupé d'échecs planifiés d'un compte, et vide son lot.
 *
 * Exporté pour les tests, qui ne peuvent pas attendre deux minutes — et pour
 * l'arrêt du serveur, qui ne doit pas perdre ce qui est en attente.
 *
 * @returns {Promise<{envoye: boolean, connecteurs: number, canal: string|null, groupeId?: number}>}
 */
async function envoyer(userId) {
  const lot = enAttente.get(userId);
  if (!lot || !lot.echecs.length) return { envoye: false, connecteurs: 0, canal: null };
  enAttente.delete(userId);
  if (lot.timer) clearTimeout(lot.timer);

  const { user, echecs } = lot;
  const titre = echecs.length === 1
    ? `Échec de récupération : ${echecs[0].nom}`
    : `${echecs.length} récupérations ont échoué`;

  const issue = await expedier({
    userId,
    user,
    kind: 'sync-failure',
    titre,
    items: echecs.map((e) => ({ id: e.connectorId, nom: e.nom, message: e.message })),
    courriel: () =>
      emailTemplates.render('connector-failure', {
        utilisateur: user.username,
        // Le modèle attend UN connecteur : on lui donne la liste, qui se lit
        // aussi bien au singulier (« Free Internet ») qu'au pluriel.
        connecteur: echecs.map((e) => e.nom).join(', '),
        erreur: echecs.map((e) => `• ${e.nom} — ${e.message}`).join('\n'),
        date: new Date().toISOString(),
      }),
  });

  return { envoye: issue.envoye, connecteurs: echecs.length, canal: issue.canal, groupeId: issue.groupeId };
}

// ---------------------------------------------------------------------------
// 2. Une série de récupérations lancées à la main s'achève
// ---------------------------------------------------------------------------

/**
 * Verse une récupération lancée à la main — réussie OU non — dans la série en
 * cours de constitution pour ce compte.
 *
 * Le point d'accroche est le planificateur lui-même, pas une route : les séries
 * se lancent depuis plusieurs écrans, et une série reste une série
 * quel que soit le bouton qui l'a commencée.
 *
 * @param {{id: number, username: string}} user
 * @param {{connectorId: string, nom: string, ok: boolean, message: string}} ligne
 * @param {{enCours?: () => boolean}} [options] `enCours` : y a-t-il encore une
 *   récupération en train de tourner ? Injecté par l'appelant pour ne pas
 *   créer de cycle entre ce module et le planificateur.
 */
function signalerRecuperationManuelle(user, ligne, options = {}) {
  if (!actif || !user?.id || !ligne?.connectorId) return;

  if (!balayees.has(user.id)) {
    balayees.set(user.id, { user, lignes: [], timer: null, enCours: () => false });
  }
  const lot = balayees.get(user.id);
  if (typeof options.enCours === 'function') lot.enCours = options.enCours;

  // Relancer deux fois le même service dans une même série : le dernier
  // résultat fait foi, exactement comme pour un passage planifié.
  lot.lignes = lot.lignes.filter((l) => l.connectorId !== ligne.connectorId);
  lot.lignes.push({
    connectorId: ligne.connectorId,
    nom: ligne.nom || ligne.connectorId,
    ok: !!ligne.ok,
    message: ligne.message || '',
  });

  armerBalayee(user.id);
}

/**
 * (Ré)arme le compte à rebours de fin de série.
 *
 * Tant qu'une récupération tourne, la série n'est pas finie : on se contente de
 * repousser. C'est ce qui distingue « le chantier est terminé » de « le service
 * en cours est simplement long ».
 */
function armerBalayee(userId) {
  const lot = balayees.get(userId);
  if (!lot) return;
  if (lot.timer) clearTimeout(lot.timer);
  lot.timer = setTimeout(() => {
    let occupe = false;
    try {
      occupe = !!lot.enCours();
    } catch {
      // Un planificateur qui ne sait pas répondre ne doit pas retenir la
      // notification indéfiniment : on clôt.
    }
    if (occupe) return void armerBalayee(userId);
    cloreBalayee(userId).catch(() => {});
  }, SILENCE_BALAYEE_MS);
  if (typeof lot.timer.unref === 'function') lot.timer.unref();
}

/**
 * Clôt la série d'un compte et envoie son bilan.
 *
 * Exporté pour les tests et pour l'arrêt du serveur.
 *
 * @returns {Promise<{envoye: boolean, services: number, echecs: number, canal: string|null, ignoree?: boolean}>}
 */
async function cloreBalayee(userId) {
  const lot = balayees.get(userId);
  if (!lot || !lot.lignes.length) return { envoye: false, services: 0, echecs: 0, canal: null };
  balayees.delete(userId);
  if (lot.timer) clearTimeout(lot.timer);

  const { user, lignes } = lot;
  const echecs = lignes.filter((l) => !l.ok);

  if (lignes.length < SEUIL_BALAYEE) {
    return { envoye: false, services: lignes.length, echecs: echecs.length, canal: null, ignoree: true };
  }

  const titre = echecs.length
    ? `Récupération de ${lignes.length} services terminée — ${echecs.length} en échec`
    : `Récupération de ${lignes.length} services terminée`;

  const resume = echecs.length
    ? `${lignes.length} services demandés, ${lignes.length - echecs.length} réussis, ${echecs.length} en échec.`
    : `${lignes.length} services demandés, tous réussis.`;

  const issue = await expedier({
    userId,
    user,
    kind: 'sweep-done',
    titre,
    // Seuls les échecs sont détaillés : lister vingt-cinq réussites noierait
    // les trois lignes qui demandent quelque chose.
    items: echecs.map((e) => ({ id: e.connectorId, nom: e.nom, message: e.message })),
    courriel: () =>
      emailTemplates.render('job-finished', {
        utilisateur: user.username,
        chantier: 'Récupération de plusieurs services, lancée à la main',
        resume,
        detail: echecs.length
          ? echecs.map((e) => `• ${e.nom} — ${e.message}`).join('\n')
          : 'Aucun service en échec.',
        date: new Date().toISOString(),
      }),
  });

  return { envoye: issue.envoye, services: lignes.length, echecs: echecs.length, canal: issue.canal, groupeId: issue.groupeId };
}

// ---------------------------------------------------------------------------
// 3. Un chantier long s'achève
// ---------------------------------------------------------------------------

/**
 * Signale la fin d'un chantier long (le renommage des documents, aujourd'hui).
 *
 * Pas de fenêtre d'accumulation ici : un chantier se termine une fois, il n'y a
 * rien à regrouper.
 *
 * @param {{id: number, username: string}} user
 * @param {{chantier: string, resume: string, dureeMs?: number, echec?: boolean}} bilan
 * @returns {Promise<{envoye: boolean, canal: string|null, ignoree?: boolean}>}
 */
async function signalerChantier(user, bilan) {
  if (!actif || !user?.id || !bilan?.chantier) return { envoye: false, canal: null };

  // Un chantier qu'on a vu se faire n'a pas besoin d'être annoncé.
  if (Number.isFinite(bilan.dureeMs) && bilan.dureeMs < DUREE_CHANTIER_NOTIFIABLE_MS) {
    return { envoye: false, canal: null, ignoree: true };
  }

  const titre = bilan.echec ? `${bilan.chantier} — interrompu` : `${bilan.chantier} — terminé`;

  const issue = await expedier({
    userId: user.id,
    user,
    kind: 'job-done',
    titre,
    items: [{ id: 'chantier', nom: bilan.chantier, message: bilan.resume }],
    courriel: () =>
      emailTemplates.render('job-finished', {
        utilisateur: user.username,
        chantier: bilan.chantier,
        resume: bilan.resume,
        detail: bilan.echec
          ? 'Le chantier ne s\'est pas terminé normalement : ouvrez crabe pour lire le motif et, si besoin, relancer.'
          : 'Rien d\'autre à faire de votre côté.',
        date: new Date().toISOString(),
      }),
  });

  return { envoye: issue.envoye, canal: issue.canal, groupeId: issue.groupeId };
}

// ---------------------------------------------------------------------------
// Le point d'envoi UNIQUE — et la règle « rien en silence »
// ---------------------------------------------------------------------------

/**
 * Écrit la trace, puis tente l'e-mail. Chaque issue laisse une ligne au journal.
 *
 * ⚠ C'est le SEUL endroit d'où part un e-mail de notification. Un service qui
 * rend « envoyé » sans que personne ne l'appelle passe tous les tests
 * unitaires du monde sans rien envoyer : c'est précisément ce qui s'est
 * produit ici pendant deux mois. Un point unique se prouve.
 *
 * @param {{userId: number, user: object, kind: string, titre: string,
 *          items: Array<{id: string, nom: string, message: string}>,
 *          courriel: () => {subject: string, text: string}}} envoi
 */
async function expedier({ userId, user, kind, titre, items, courriel }) {
  // La trace en base sert les deux canaux : elle est ce que la notification du
  // navigateur vient relever, et elle survit à un e-mail qui n'a pas pu partir.
  const groupeId = enregistrer(userId, kind, titre, items);
  const qui = { userId, username: user?.username || null };

  if (!reglage(userId).email) {
    applog.info(
      'notifications',
      `« ${titre} » : aucun e-mail envoyé — ce compte a éteint l'envoi par e-mail `
        + '(Profil → Être prévenu). La notification reste consultable dans crabe.',
      qui
    );
    return { envoye: false, canal: null, groupeId };
  }

  try {
    if (!mailer.isConfigured()) {
      applog.warn(
        'notifications',
        `« ${titre} » : aucun e-mail envoyé — aucun serveur d'envoi n'est configuré sur cette `
          + 'installation (Paramètres → SMTP).',
        qui
      );
      return { envoye: false, canal: null, groupeId };
    }

    const row = db.get().prepare('SELECT email FROM users WHERE id = ?').get(userId);
    if (!row?.email) {
      applog.warn(
        'notifications',
        `« ${titre} » : aucun e-mail envoyé — aucune adresse e-mail n'est renseignée sur ce `
          + 'compte (Profil → Adresse e-mail).',
        qui
      );
      return { envoye: false, canal: null, groupeId };
    }

    const rendered = courriel();
    const sent = await mailer.trySend({
      to: row.email,
      subject: rendered.subject,
      text: rendered.text,
    });

    if (!sent.ok) {
      // `sent.message` vient de mailer.describeError() : une phrase qui dit
      // quoi corriger, jamais un mot de passe ni un jeton.
      applog.error('notifications', `« ${titre} » : l'envoi par e-mail a échoué — ${sent.message}`, qui);
      return { envoye: false, canal: null, groupeId };
    }

    applog.info('notifications', `« ${titre} » envoyée par e-mail à ${row.email}.`, qui);
    return { envoye: true, canal: 'email', groupeId };
  } catch (err) {
    // Rien ici ne doit faire échouer l'opération qui vient, elle, de se
    // dérouler normalement.
    applog.error('notifications', `« ${titre} » : notification non envoyée — ${err.message}`, qui);
    return { envoye: false, canal: null, groupeId };
  }
}

/**
 * Inscrit la notification en base, non lue.
 *
 * C'est ce que la notification du navigateur vient relever, et c'est aussi la
 * trace qui reste quand aucun e-mail n'a pu partir : sans elle, un compte sans
 * SMTP configuré n'aurait strictement aucun signal.
 */
function enregistrer(userId, kind, titre, items) {
  const info = db
    .get()
    .prepare(
      `INSERT INTO notifications (user_id, kind, title, body, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(userId, kind, titre, JSON.stringify(items || []));
  return info.lastInsertRowid;
}

/**
 * Les notifications qu'un compte n'a pas encore vues.
 *
 * Bornée à dix : au-delà, ce n'est plus une notification mais un journal, et
 * « Suivi actions » sur l'accueil fait ce travail-là mieux.
 */
function nonLues(userId, limite = 10) {
  return db
    .get()
    .prepare(
      `SELECT id, kind, title, body, created_at
         FROM notifications
        WHERE user_id = ? AND seen_at IS NULL
        ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limite)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      createdAt: r.created_at,
      // Un corps illisible ne doit pas casser l'écran qui l'affiche.
      items: (() => {
        try {
          const parsed = JSON.parse(r.body);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    }));
}

/** Marque comme vues les notifications d'un compte (toutes, ou certaines). */
function marquerVues(userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    const marques = ids.map(() => '?').join(',');
    return db
      .get()
      .prepare(
        `UPDATE notifications SET seen_at = datetime('now')
          WHERE user_id = ? AND seen_at IS NULL AND id IN (${marques})`
      )
      .run(userId, ...ids).changes;
  }
  return db
    .get()
    .prepare("UPDATE notifications SET seen_at = datetime('now') WHERE user_id = ? AND seen_at IS NULL")
    .run(userId).changes;
}

/** Vide les notifications d'un compte (suppression RGPD, désinstallation). */
function oublier(userId) {
  return db.get().prepare('DELETE FROM notifications WHERE user_id = ?').run(userId).changes;
}

/**
 * Envoie tout ce qui est en attente, sans attendre le silence.
 *
 * Appelé à l'arrêt du serveur : un lot resté en mémoire au moment d'un
 * redémarrage serait perdu, et l'échec ne serait jamais signalé. Une série en
 * cours part aussi : mieux vaut un bilan partiel, qui dit ce qui a été fait
 * avant le redémarrage, que rien du tout.
 */
async function viderTout() {
  const ids = new Set([...enAttente.keys(), ...balayees.keys()]);
  for (const id of ids) {
    await envoyer(id).catch(() => {});
    await cloreBalayee(id).catch(() => {});
  }
  return ids.size;
}

/** Coupe l'accumulation — pour les tests, qui ne veulent pas de minuteur. */
function stop() {
  actif = false;
  for (const lot of enAttente.values()) if (lot.timer) clearTimeout(lot.timer);
  for (const lot of balayees.values()) if (lot.timer) clearTimeout(lot.timer);
  enAttente.clear();
  balayees.clear();
}

function start() {
  actif = true;
}

module.exports = {
  SILENCE_MS,
  FENETRE_MAX_MS,
  SILENCE_BALAYEE_MS,
  SEUIL_BALAYEE,
  DUREE_CHANTIER_NOTIFIABLE_MS,
  reglage,
  signalerEchec,
  envoyer,
  signalerRecuperationManuelle,
  cloreBalayee,
  signalerChantier,
  nonLues,
  marquerVues,
  oublier,
  viderTout,
  stop,
  start,
  // Exposé pour les tests : combien de comptes ont un lot en attente.
  get enAttenteSize() {
    return enAttente.size;
  },
  /** Combien de comptes ont une série de récupérations en cours. */
  get balayeesSize() {
    return balayees.size;
  },
};
