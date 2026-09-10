'use strict';

/**
 * Modèles des e-mails envoyés par crabe.
 *
 * Objet et corps sont stockés en base (`email_templates`) et modifiables depuis
 * Paramètres → SMTP. Chaque modèle déclare les variables qu'il accepte : la
 * liste affichée à côté du champ vient d'ici, elle ne peut pas mentir.
 *
 * Deux règles pour la substitution :
 *   - une variable fournie remplace toutes ses occurrences, `{{ nom }}` avec ou
 *     sans espaces ;
 *   - un marqueur inconnu est laissé TEL QUEL. Une faute de frappe se voit dans
 *     l'aperçu au lieu de disparaître silencieusement du message.
 *
 * ⚠️ Le SMTP n'a jamais été testé en conditions réelles : rien ici ne doit
 * lever pour un modèle absent ou une variable manquante.
 */

const db = require('./db/db');

/**
 * @typedef {{key: string, label: string, description: string,
 *            variables: Array<{name: string, help: string, sample: string}>,
 *            subject: string, body: string}} TemplateDefinition
 */

/** Variables communes à tous les modèles. */
const COMMON = [
  { name: 'utilisateur', help: 'Identifiant du compte concerné', sample: 'camille' },
  { name: 'date', help: 'Date et heure de l\'événement', sample: '30/07/2026 14:05' },
];

/** @type {TemplateDefinition[]} */
const DEFAULTS = [
  {
    key: 'email-change-confirm',
    label: 'Confirmation de changement d\'adresse',
    description:
      'Envoyé à la NOUVELLE adresse. Son lien est le seul moyen d\'appliquer le changement.',
    variables: [
      ...COMMON,
      { name: 'lien', help: 'Lien de confirmation, valable une seule fois', sample: 'http://crabe.local/confirm-email?token=abc123' },
      { name: 'adresse', help: 'Nouvelle adresse demandée', sample: 'nouvelle@exemple.fr' },
      { name: 'heures', help: 'Durée de validité du lien, en heures', sample: '24' },
    ],
    subject: 'crabe — confirmez votre nouvelle adresse e-mail',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      'Vous avez demandé à utiliser cette adresse ({{adresse}}) pour votre compte crabe.\n' +
      'Pour confirmer, ouvrez ce lien depuis le réseau local :\n\n' +
      '{{lien}}\n\n' +
      'Ce lien est valable {{heures}} heures et ne fonctionne qu\'une fois.\n' +
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message : ' +
      'votre adresse actuelle reste inchangée.\n',
  },
  {
    key: 'email-change-notice',
    label: 'Notification à l\'ancienne adresse',
    description:
      'Envoyé à l\'adresse ACTUELLE pour signaler la demande. Son échec ne bloque jamais le parcours.',
    variables: [
      ...COMMON,
      { name: 'adresse', help: 'Nouvelle adresse demandée', sample: 'nouvelle@exemple.fr' },
    ],
    subject: 'crabe — demande de changement d\'adresse e-mail',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      'Une demande de changement d\'adresse e-mail vers « {{adresse}} » a été enregistrée ' +
      'sur votre compte crabe.\n\n' +
      'Tant que la nouvelle adresse n\'est pas confirmée, rien ne change.\n' +
      'Si vous n\'êtes pas à l\'origine de cette demande, changez votre mot de passe ' +
      'et prévenez l\'administrateur.\n',
  },
  {
    key: 'password-reset',
    label: 'Réinitialisation de mot de passe',
    description:
      'Envoyé quand un administrateur déclenche une réinitialisation. Sans SMTP, il reste ' +
      'toujours possible de communiquer le mot de passe de vive voix.',
    variables: [
      ...COMMON,
      { name: 'lien', help: 'Lien de réinitialisation', sample: 'http://crabe.local/reset?token=abc123' },
      { name: 'heures', help: 'Durée de validité du lien, en heures', sample: '2' },
    ],
    subject: 'crabe — réinitialisation de votre mot de passe',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      'Une réinitialisation de mot de passe a été demandée pour votre compte crabe.\n' +
      'Ouvrez ce lien depuis le réseau local pour choisir un nouveau mot de passe :\n\n' +
      '{{lien}}\n\n' +
      'Ce lien est valable {{heures}} heures.\n' +
      'Si vous n\'êtes pas à l\'origine de cette demande, prévenez l\'administrateur : ' +
      'votre mot de passe actuel reste valable.\n',
  },
  {
    key: 'connector-failure',
    label: 'Échec de synchronisation d\'un connecteur',
    description:
      'Envoyé après l\'échec d\'une récupération automatique. Le détail technique complet ' +
      'reste dans Paramètres → Logs.',
    variables: [
      ...COMMON,
      { name: 'connecteur', help: 'Nom lisible du connecteur', sample: 'Free Internet' },
      { name: 'erreur', help: 'Message d\'erreur remonté par le connecteur', sample: 'Identifiants refusés (HTTP 401)' },
    ],
    subject: 'crabe — échec de synchronisation : {{connecteur}}',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      'La récupération automatique des factures {{connecteur}} a échoué le {{date}}.\n\n' +
      'Motif : {{erreur}}\n\n' +
      'Les factures déjà récupérées ne sont pas affectées. Vérifiez les identifiants du ' +
      'connecteur dans crabe, puis relancez une récupération manuelle.\n',
  },
  {
    key: 'job-finished',
    label: 'Chantier terminé',
    description:
      'Envoyé quand un travail long lancé à la main s\'achève : une série de récupérations, '
      + 'un renommage des documents. Un seul message pour tout le chantier — il n\'y en a '
      + 'jamais un par service.',
    variables: [
      ...COMMON,
      { name: 'chantier', help: 'Ce qui vient de se terminer', sample: 'Récupération de plusieurs services, lancée à la main' },
      { name: 'resume', help: 'Le bilan en une phrase', sample: '25 services demandés, 22 réussis, 3 en échec.' },
      { name: 'detail', help: 'Ce qui demande quelque chose, ligne à ligne', sample: '• Darty — Votre connexion a expiré.' },
    ],
    subject: 'crabe — {{chantier}} : terminé',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      '{{chantier}} s\'est terminé le {{date}}.\n\n' +
      '{{resume}}\n\n' +
      '{{detail}}\n\n' +
      'Rien n\'a été supprimé. Le détail complet reste dans crabe, écran Logs.\n',
  },
  {
    key: 'gdpr-archive',
    label: 'Remise de l\'archive RGPD',
    description:
      'Envoyé quand l\'archive d\'un compte a été générée. L\'archive elle-même est remise ' +
      'par l\'administrateur, jamais publiée sur Internet.',
    variables: [
      ...COMMON,
      { name: 'lien', help: 'Emplacement ou lien de retrait de l\'archive', sample: 'http://crabe.local/exports/crabe-export-camille.zip' },
      { name: 'fichiers', help: 'Nombre de fichiers dans l\'archive', sample: '128' },
      { name: 'taille', help: 'Taille de l\'archive', sample: '42,3 Mo' },
    ],
    subject: 'crabe — votre archive de données personnelles',
    body:
      'Bonjour {{utilisateur}},\n\n' +
      'L\'archive de vos données personnelles a été générée le {{date}}.\n' +
      'Elle contient {{fichiers}} fichier(s), pour {{taille}}.\n\n' +
      'Retrait : {{lien}}\n\n' +
      'Elle rassemble vos factures et l\'export JSON de vos données de compte.\n' +
      'Passé le délai de conservation, elle est supprimée du serveur.\n',
  },
];

/** Index par clé, pour éviter un find() à chaque appel. */
const BY_KEY = new Map(DEFAULTS.map((t) => [t.key, t]));

/** Clés connues, dans l'ordre d'affichage du sélecteur. */
const KEYS = DEFAULTS.map((t) => t.key);

function definition(key) {
  return BY_KEY.get(key) || null;
}

/**
 * Remplace les marqueurs `{{nom}}` par leurs valeurs.
 *
 * Les marqueurs sans valeur fournie sont laissés intacts — voir l'en-tête.
 * @param {string} text
 * @param {Record<string, unknown>} values
 */
function substitute(text, values = {}) {
  return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (marker, name) => {
    const value = values[name];
    if (value === undefined || value === null) return marker;
    return String(value);
  });
}

/**
 * Comparaison de deux textes de modèle : les fins de ligne du navigateur
 * (CRLF) et un saut de ligne final en trop ne font pas un modèle « modifié ».
 */
function sameText(a, b) {
  const normalize = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();
  return normalize(a) === normalize(b);
}

/** Modèle courant : la version enregistrée, ou le modèle par défaut. */
function get(key) {
  const base = definition(key);
  if (!base) return null;

  let row = null;
  try {
    row = db.get().prepare('SELECT * FROM email_templates WHERE key = ?').get(key);
  } catch {
    // Base pas encore migrée : le modèle par défaut fait parfaitement l'affaire.
  }

  const subject = row?.subject ?? base.subject;
  const body = row?.body ?? base.body;
  return {
    key,
    label: base.label,
    description: base.description,
    variables: base.variables,
    subject,
    body,
    // « Modifié » se juge sur le contenu, pas sur la présence d'une ligne :
    // réenregistrer le texte par défaut ne doit pas afficher « personnalisé ».
    customized: !sameText(subject, base.subject) || !sameText(body, base.body),
    defaults: { subject: base.subject, body: base.body },
  };
}

/** Tous les modèles, dans l'ordre du sélecteur. */
function list() {
  return KEYS.map(get).filter(Boolean);
}

/** Enregistre un modèle. Objet et corps sont obligatoires (un e-mail vide n'a pas de sens). */
function save(key, { subject, body }) {
  if (!definition(key)) {
    const err = new Error(`Modèle d'e-mail inconnu : ${key}`);
    err.statusCode = 404;
    throw err;
  }
  const cleanSubject = String(subject ?? '').trim();
  // Le corps est enregistré tel quel : sa mise en forme (lignes vides,
  // saut de ligne final) fait partie du message.
  const cleanBody = String(body ?? '').replace(/\r\n/g, '\n');
  if (!cleanSubject || !cleanBody.trim()) {
    const err = new Error('L\'objet et le corps du modèle sont obligatoires.');
    err.statusCode = 400;
    throw err;
  }

  db.get()
    .prepare(
      `INSERT INTO email_templates (key, subject, body, updated_at)
            VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE
            SET subject = excluded.subject,
                body = excluded.body,
                updated_at = datetime('now')`
    )
    .run(key, cleanSubject, cleanBody);

  return get(key);
}

/** Revient au modèle livré avec crabe. */
function reset(key) {
  const base = definition(key);
  if (!base) {
    const err = new Error(`Modèle d'e-mail inconnu : ${key}`);
    err.statusCode = 404;
    throw err;
  }
  return save(key, { subject: base.subject, body: base.body });
}

/** Valeurs d'exemple d'un modèle, pour l'aperçu et l'envoi de test. */
function sampleValues(key) {
  const base = definition(key);
  if (!base) return {};
  return Object.fromEntries(base.variables.map((v) => [v.name, v.sample]));
}

/**
 * Rend un modèle.
 * @param {string} key
 * @param {Record<string, unknown>} values
 * @returns {{key: string, subject: string, text: string}}
 */
function render(key, values = {}) {
  const template = get(key);
  if (!template) {
    const err = new Error(`Modèle d'e-mail inconnu : ${key}`);
    err.statusCode = 404;
    throw err;
  }
  return {
    key,
    subject: substitute(template.subject, values),
    text: substitute(template.body, values),
  };
}

/** Rendu avec les valeurs d'exemple (bouton « Aperçu »). */
function preview(key) {
  return render(key, sampleValues(key));
}

/** Insère les modèles par défaut manquants (migration et démarrage). */
function seedDefaults(database) {
  const insert = database.prepare(
    'INSERT OR IGNORE INTO email_templates (key, subject, body) VALUES (?, ?, ?)'
  );
  for (const template of DEFAULTS) insert.run(template.key, template.subject, template.body);
}

module.exports = {
  DEFAULTS,
  KEYS,
  definition,
  substitute,
  get,
  list,
  save,
  reset,
  render,
  preview,
  sampleValues,
  seedDefaults,
};
