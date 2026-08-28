-- =====================================================================
-- crabe — schéma SQLite
--
-- Ce fichier décrit l'état CIBLE du schéma, appliqué en entier à chaque
-- démarrage (CREATE TABLE IF NOT EXISTS) : il crée une base neuve complète.
--
-- Sur une base DÉJÀ EXISTANTE, `CREATE TABLE IF NOT EXISTS` ne fait rien et
-- n'ajoute aucune colonne : c'est le rôle de db/migrations.js, qui rattrape
-- l'écart de façon versionnée et non destructive. Les deux doivent toujours
-- converger vers le même état — toute modification ici s'accompagne d'une
-- migration correspondante.
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Rôles et permissions
--
-- `admin` et `user` sont intégrés (builtin = 1) : ni supprimables, ni
-- renommables. Les rôles personnalisés portent un sous-ensemble de
-- permissions atomiques, réellement vérifiées côté serveur.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- ---------------------------------------------------------------------
-- Comptes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  email          TEXT,
  phone          TEXT,
  password_hash  TEXT    NOT NULL,
  -- secret TOTP chiffré (crypto.js) ; NULL tant que la 2FA n'est pas configurée.
  -- Un compte neuf n'a JAMAIS de secret : la 2FA est strictement opt-in.
  totp_secret    TEXT,
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  -- `role` reste la nature du compte (garde-fou « au moins un admin ») ;
  -- `role_id` porte le rôle réel, éventuellement personnalisé.
  role           TEXT    NOT NULL DEFAULT 'user'   CHECK (role   IN ('admin','user')),
  role_id        INTEGER REFERENCES roles(id),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  landing_page   TEXT    NOT NULL DEFAULT 'apps'   CHECK (landing_page IN ('apps','local','papiers')),
  avatar_color   TEXT,
  -- Verrous de l'accueil (voir server/home.js) — à ne pas confondre :
  --   home_locked       : « Figer mon accueil », posé et retiré par l'utilisateur ;
  --   home_customizable : autorisation de l'administrateur, lui seul la retire.
  home_locked       INTEGER NOT NULL DEFAULT 0,
  home_customizable INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at  TEXT,
  password_changed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
-- L'index sur role_id est posé par la migration 1 : sur une base existante, la
-- colonne n'existe pas encore quand ce fichier est appliqué.

-- Demandes de changement d'adresse e-mail (jeton haché, usage unique, 24 h).
CREATE TABLE IF NOT EXISTS email_change_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email   TEXT    NOT NULL,
  token_hash  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_emailchg_user  ON email_change_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_emailchg_token ON email_change_requests(token_hash);

-- ---------------------------------------------------------------------
-- Catalogue des connecteurs (vision administrateur)
-- Alimenté depuis les manifests au démarrage, puis surchargeable en base.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_catalog (
  connector_id  TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  maintenance   INTEGER NOT NULL DEFAULT 0,
  -- '"all"' ou un tableau JSON d'IDs utilisateurs : ex. '[1,4]'
  allowed_users TEXT NOT NULL DEFAULT '"all"',
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','pending')),
  -- Date de mise à disposition EXPLICITE dans le Store (approbation par un
  -- administrateur). NULL = disponible par défaut, sans décision de personne.
  published_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Installations par utilisateur (isolation stricte multi-compte)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_installs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id     TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'needs-config'
                     CHECK (status IN ('needs-config','installed','error')),
  -- JSON chiffré des identifiants du connecteur ; NULL tant que non configuré
  config_encrypted TEXT,
  -- Identifiant de compte chez le fournisseur (nichandle OVH, identifiant
  -- d'abonné Free, numéro client EDF…). Sert de niveau d'arborescence sur les
  -- destinations : renseigné au premier test()/fetchInvoices() réussi.
  account_id       TEXT,
  last_error       TEXT,
  last_run_at      TEXT,
  installed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_installs_user ON connector_installs(user_id);
CREATE INDEX IF NOT EXISTS idx_installs_conn ON connector_installs(connector_id);

-- ---------------------------------------------------------------------
-- Destinations de stockage — configuration GLOBALE (admin uniquement).
-- Singleton : une ligne par destination, jamais par utilisateur.
-- ---------------------------------------------------------------------
-- ⚠ PAS de « CHECK (dest_id IN (…)) » ici, et c'est une correction du lot 24.
-- La liste fermée qui s'y trouvait — local, proton, pcloud — a refusé
-- l'ajout de MEGA, kDrive et du mode générique. En SILENCE : l'amorçage insère
-- en « INSERT OR IGNORE », qui avale aussi bien un doublon qu'une violation de
-- contrainte. Les destinations existaient dans le code, dans le catalogue et
-- dans les écrans, mais leur ligne de configuration n'était jamais créée, et
-- rien nulle part ne le disait.
--
-- Depuis le lot 25, il n'y a plus de liste du tout : cette table EST la liste.
-- Le stockage local est la seule ligne que crabe crée lui-même ; chaque autre ligne est
-- un cloud que l'utilisateur a ajouté depuis l'écran Stockage, avec le nom
-- qu'il lui a donné. Deux comptes pCloud sont deux lignes, et livrer un
-- fournisseur de plus ne demande plus une version de crabe.
CREATE TABLE IF NOT EXISTS destinations_config (
  -- « local », un identifiant hérité d'avant le lot 25 (proton, pcloud…),
  -- ou « cloud-<8 caractères> » pour tout ce qui est créé depuis. Cet
  -- identifiant se retrouve dans invoices.destinations et dans les préférences
  -- de chaque compte : il ne change JAMAIS une fois posé.
  dest_id          TEXT PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 0,
  -- Le nom donné par l'utilisateur (« pCloud perso »). Vide pour le stockage local, qui
  -- porte le sien.
  display_name     TEXT,
  -- Le fournisseur choisi dans la liste (destinations/presets.js) : il décide
  -- du logo, de la couleur et du formulaire, jamais du mécanisme.
  provider         TEXT,
  -- Le stockage local : chemin réseau + protocole (smb / nfs / local)
  path             TEXT,
  protocol         TEXT,
  -- Les autres : bloc de config rclone (ou champs nommés), chiffré
  config_encrypted TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- Supprimée : la ligne reste, vidée de ses identifiants, pour que les
  -- factures déjà copiées gardent le nom de l'endroit où elles sont parties.
  deleted_at       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS destination_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dest_id   TEXT    NOT NULL,
  user_id   INTEGER,
  at        TEXT    NOT NULL DEFAULT (datetime('now')),
  success   INTEGER NOT NULL,
  message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_destlogs_dest ON destination_logs(dest_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_destlogs_at   ON destination_logs(at DESC);

-- ---------------------------------------------------------------------
-- Factures récupérées
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id  TEXT    NOT NULL,
  filename      TEXT    NOT NULL,
  -- identifiant fournisseur (numéro de facture) pour la déduplication
  remote_id     TEXT,
  -- identifiant de compte au moment du dépôt : permet de retrouver le fichier
  -- même après un changement d'abonnement (nouveau dossier)
  account_id    TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  issued_on     TEXT,
  fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  -- État de transfert DÉTAILLÉ, une entrée par destination (lot 3) :
  --   { "local": {"state":"ok","ok":true,"at":"2026-…","path":"/mnt/…"},
  --     "proton":   {"state":"error","ok":false,"at":"2026-…","message":"…"} }
  -- state ∈ 'ok' | 'error' | 'pending' | 'unknown'. Une destination absente
  -- de l'objet est « en attente » si elle est activée : voir server/invoices.js.
  destinations  TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (user_id, connector_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_conn ON invoices(connector_id);

-- ---------------------------------------------------------------------
-- Journaux
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id  TEXT    NOT NULL,
  user_id       INTEGER,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  success       INTEGER NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT    NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','cron','test')),
  message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runlogs_conn ON run_logs(connector_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runlogs_user ON run_logs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS connection_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER,
  username TEXT,
  date     TEXT NOT NULL DEFAULT (datetime('now')),
  os       TEXT,
  browser  TEXT,
  ip       TEXT,
  success  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_connlogs_date ON connection_logs(date DESC);
CREATE INDEX IF NOT EXISTS idx_connlogs_user ON connection_logs(user_id, date DESC);

-- Journal applicatif : tout ce qui n'est ni une connexion, ni une exécution
-- de connecteur (démarrages, migrations, opérations d'administration,
-- échecs de destination, entretien planifié).
CREATE TABLE IF NOT EXISTS app_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  level    TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  source   TEXT NOT NULL,
  message  TEXT NOT NULL,
  user_id  INTEGER,
  username TEXT
);

CREATE INDEX IF NOT EXISTS idx_applogs_at    ON app_logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_applogs_level ON app_logs(level, at DESC);

-- ---------------------------------------------------------------------
-- Support (ex-SAV)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject        TEXT    NOT NULL,
  message        TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'recu'
                   CHECK (status IN ('recu','en-cours','repondu','ferme')),
  -- Dernière réponse admin, conservée pour compatibilité ; le fil complet
  -- vit dans ticket_messages.
  reply          TEXT    NOT NULL DEFAULT '',
  -- Lu / non lu, indépendant du statut : NULL tant qu'aucun admin n'a ouvert
  -- la demande.
  read_at        TEXT,
  -- masqué côté utilisateur, mais TOUJOURS conservé côté admin
  hidden_by_user INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user   ON tickets(user_id);

-- Fil de conversation : message initial + réponses successives horodatées.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT    NOT NULL CHECK (author IN ('user','admin')),
  user_id    INTEGER,
  username   TEXT,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticketmsg_ticket ON ticket_messages(ticket_id, created_at);

-- ---------------------------------------------------------------------
-- Suppression de compte (RGPD)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  wants_export       INTEGER NOT NULL DEFAULT 0,
  export_sent        INTEGER NOT NULL DEFAULT 0,
  export_path        TEXT,
  revoked            INTEGER NOT NULL DEFAULT 0,
  requested_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at         TEXT,
  scheduled_delete_at TEXT   NOT NULL
);

-- ---------------------------------------------------------------------
-- Politique de sécurité globale (singleton, id = 1)
--
-- 2FA : allow_2fa = 0 signifie « désactivée par l'administrateur » — c'est le
-- défaut. require_2fa = 1 implique allow_2fa = 1. Aucun compte n'est jamais
-- enfermé dehors : voir routes/auth.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_policy (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  allow_2fa           INTEGER NOT NULL DEFAULT 0,
  require_2fa         INTEGER NOT NULL DEFAULT 0,
  password_complexity TEXT    NOT NULL DEFAULT 'medium'
                        CHECK (password_complexity IN ('low','medium','high')),
  log_retention_days  INTEGER NOT NULL DEFAULT 365,
  -- Profondeur de DOCUMENTS conservée, en mois. 0 = tout garder (le défaut).
  -- Valeurs proposées : 3, 6, 12, 24 (voir server/retention.js).
  document_retention_months INTEGER NOT NULL DEFAULT 0,
  -- Plancher anti-rétroactif : rien de récupéré avant cette date n'est jamais
  -- supprimé automatiquement. NULL = le nettoyage s'applique à tout, ce qui ne
  -- peut venir que d'une confirmation explicite de l'administrateur.
  document_retention_floor  TEXT,
  smtp_host           TEXT,
  smtp_port           INTEGER,
  smtp_user           TEXT,
  smtp_pass_encrypted TEXT,
  smtp_from           TEXT,
  smtp_from_name      TEXT,
  -- 'none' | 'starttls' | 'tls' ; NULL = déduit du port (465 = TLS implicite).
  smtp_secure         TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Modèles des e-mails envoyés par crabe (objet + corps), modifiables
-- depuis Paramètres → SMTP. Les valeurs par défaut sont posées au
-- démarrage par email-templates.seedDefaults().
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  key        TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Réglages d'affichage et d'exploitation (singleton, id = 1)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  timezone         TEXT NOT NULL DEFAULT 'Europe/Paris',
  time_format      TEXT NOT NULL DEFAULT '24'         CHECK (time_format IN ('24','12')),
  date_format      TEXT NOT NULL DEFAULT 'DD/MM/YYYY'
                     CHECK (date_format IN ('DD/MM/YYYY','YYYY-MM-DD','MM/DD/YYYY')),
  -- Gravatar interroge un service tiers : désactivé par défaut.
  gravatar_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Réglages de l'écran Optimisation (lot 60) : une ligne par volet.
-- Tout naît en MANUEL — rien ne se déclenche tant que l'administrateur
-- n'a pas choisi ; la récurrence n'a d'effet qu'en mode automatique.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS optimisation_reglages (
  volet           TEXT PRIMARY KEY
                    CHECK (volet IN ('globale','cache','profils','cloud','sauvegardes')),
  mode            TEXT NOT NULL DEFAULT 'manuel'
                    CHECK (mode IN ('manuel','automatique')),
  recurrence_mois INTEGER NOT NULL DEFAULT 6
                    CHECK (recurrence_mois IN (1,3,6,12,24)),
  dernier_passage TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Planification par connecteur — GABARIT uniquement (lot 3).
--
-- Cette table ne déclenche plus rien : elle sert de valeurs par défaut
-- proposées quand un utilisateur installe un connecteur. L'exécution réelle
-- est pilotée par `user_connector_schedules`, une ligne par installation
-- réelle — c'est ce qui a corrigé le « 13 planifications actives » alors
-- qu'un seul connecteur était installé.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_schedules (
  connector_id TEXT PRIMARY KEY,
  frequency    TEXT    NOT NULL DEFAULT 'monthly'
                 CHECK (frequency IN ('daily','weekly','monthly','disabled')),
  -- heure d'exécution au format HH:MM
  time_of_day  TEXT    NOT NULL DEFAULT '03:00',
  -- 0 = dimanche … 6 = samedi (weekly) ; 1-28 (monthly)
  day_of_week  INTEGER NOT NULL DEFAULT 1,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Planification RÉELLE : une ligne par couple (utilisateur, connecteur)
-- effectivement installé. Créée à l'installation, retirée à la
-- désinstallation (ON DELETE CASCADE sur le compte, nettoyage explicite
-- côté registry pour la désinstallation d'un connecteur).
--
-- `day_of_month` reste borné à 1-28 pour ne jamais sauter février ;
-- `last_day_of_month = 1` demande explicitement le dernier jour du mois.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_connector_schedules (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id      TEXT    NOT NULL,
  frequency         TEXT    NOT NULL DEFAULT 'monthly'
                      CHECK (frequency IN ('daily','weekly','monthly',
                                           'quarterly','half-yearly','disabled')),
  time_of_day       TEXT    NOT NULL DEFAULT '03:00',
  day_of_week       INTEGER NOT NULL DEFAULT 1,
  day_of_month      INTEGER NOT NULL DEFAULT 1,
  last_day_of_month INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- Mois de la première exécution d'une fréquence pluri-mensuelle (1-12).
  -- NULL pour toutes les autres : une mensuelle n'a pas de mois à sauter, et
  -- lui en inventer un serait une donnée fausse de plus (lot 14, §9).
  anchor_month      INTEGER,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_usched_conn ON user_connector_schedules(connector_id);

-- ---------------------------------------------------------------------
-- Accueil configurable : un bloc activable / réordonnable par utilisateur.
-- Absence de ligne = disposition par défaut (voir server/home.js).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_home_widgets (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_id  TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  -- Largeur en colonnes sur une grille de 12 : 12 (ligne entière), 6 (½),
  -- 4 (⅓) ou 3 (¼). NULL = largeur par défaut du bloc, voir server/home.js.
  span       INTEGER,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, widget_id)
);

-- ---------------------------------------------------------------------
-- Préférences d'interface par compte (clé / valeur).
-- Ce qui n'a pas de raison d'occuper une colonne de `users` : filtres
-- d'écran, vues mémorisées. Par compte, jamais par navigateur.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------
-- Découverte : éléments d'un compte fournisseur (lignes mobiles, points de
-- livraison, comptes bancaires…), remontés par `discover()` après connexion.
-- Mémorise ce qui a DÉJÀ été vu, pour distinguer une vraie nouveauté d'un
-- élément volontairement décoché (voir server/connectors/discovery.js).
-- Libellés = données personnelles : colonne chiffrée, comme la configuration.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_discoveries (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id    TEXT    NOT NULL,
  field_key       TEXT    NOT NULL,
  items_encrypted TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, connector_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_discoveries_conn ON connector_discoveries(connector_id);

-- ---------------------------------------------------------------------
-- Sessions (store express-session sur SQLite)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------
-- Migrations appliquées (voir db/migrations.js)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Migrations qui déplacent des FICHIERS sur les destinations (lot 10 :
-- l'arborescence par année). Elles ne peuvent pas être des migrations de
-- schéma : le partage peut être démonté, et il faut pouvoir réessayer au
-- démarrage suivant. Cette table est leur marque — voir
-- server/destinations/migration-annees.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_migrations (
  key     TEXT PRIMARY KEY,
  done_at TEXT,
  moved   INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed  INTEGER NOT NULL DEFAULT 0,
  details TEXT
);

-- ---------------------------------------------------------------------
-- Dernier échec de récupération d'un logo (lot 10). Séparée de
-- `connector_logos`, qui décrit un logo QUI EXISTE : un échec concerne
-- justement un logo qui n'existe pas. C'est ce qui permet au gestionnaire
-- de dire pourquoi un logo manque, plutôt que seulement combien.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logo_failures (
  connector_id TEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
