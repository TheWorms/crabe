'use strict';

/**
 * Migrations de schéma versionnées, non destructives.
 *
 * Contexte : la base de production contient déjà un compte administrateur et
 * des connecteurs installés. Aucune migration ne doit supprimer une colonne,
 * réécrire une table ou perdre une ligne.
 *
 * Règles :
 *   - chaque migration porte un `id` entier strictement croissant, jamais
 *     réutilisé, et est enregistrée dans `schema_migrations` ;
 *   - elle est écrite pour être rejouable sans dommage (ajouts conditionnels) ;
 *   - `schema.sql` décrit l'état cible pour une base neuve, ces migrations
 *     rattrapent une base existante : les deux doivent converger.
 *
 * `apply()` est appelé par db.open(), juste après `schema.sql`.
 */

const path = require('node:path');
const permissions = require('../permissions');

/** La table existe-t-elle ? */
function hasTable(database, table) {
  return !!database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

/** La colonne existe-t-elle ? (évite un ALTER TABLE en erreur) */
function hasColumn(database, table, column) {
  if (!hasTable(database, table)) return false;
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

/** Ajoute une colonne si elle manque. */
function addColumn(database, table, column, definition) {
  if (!hasTable(database, table) || hasColumn(database, table, column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * @typedef {{id: number, name: string, up: (db: import('better-sqlite3').Database) => void}} Migration
 * @type {Migration[]}
 */
const MIGRATIONS = [
  {
    id: 1,
    name: 'rôles et permissions',
    up(database) {
      database.exec(`
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
      `);

      addColumn(database, 'users', 'role_id', 'INTEGER REFERENCES roles(id)');
      database.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id)');

      permissions.seedBuiltinRoles(database);

      // Les comptes existants gardent exactement leurs droits : le compte
      // admin de production reste administrateur.
      const adminRole = database.prepare('SELECT id FROM roles WHERE slug = ?').get('admin');
      const userRole = database.prepare('SELECT id FROM roles WHERE slug = ?').get('user');
      database
        .prepare("UPDATE users SET role_id = ? WHERE role_id IS NULL AND role = 'admin'")
        .run(adminRole.id);
      database
        .prepare("UPDATE users SET role_id = ? WHERE role_id IS NULL AND role != 'admin'")
        .run(userRole.id);
    },
  },

  {
    id: 2,
    name: '2FA optionnelle (allow_2fa) et nettoyage des secrets orphelins',
    up(database) {
      addColumn(database, 'security_policy', 'allow_2fa', 'INTEGER NOT NULL DEFAULT 0');

      const policy = database.prepare('SELECT * FROM security_policy WHERE id = 1').get();
      if (policy) {
        // La 2FA était exigée par DÉFAUT (require_2fa DEFAULT 1), sans que
        // personne ne l'ait choisie : c'est ce qui a enfermé l'administrateur
        // dehors. On repart d'une politique franchement optionnelle, en
        // laissant la 2FA autorisée si au moins un compte s'en sert déjà.
        const enrolled = database
          .prepare('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1 AND totp_secret IS NOT NULL')
          .get().n;
        database
          .prepare("UPDATE security_policy SET require_2fa = 0, allow_2fa = ?, updated_at = datetime('now') WHERE id = 1")
          .run(enrolled > 0 ? 1 : 0);
      }

      // Secret généré mais jamais confirmé : il ne doit rien bloquer.
      database.prepare('UPDATE users SET totp_secret = NULL WHERE totp_enabled = 0').run();
    },
  },

  {
    id: 3,
    name: 'identifiant de compte sur les installations et les factures',
    up(database) {
      addColumn(database, 'connector_installs', 'account_id', 'TEXT');
      addColumn(database, 'invoices', 'account_id', 'TEXT');
    },
  },

  {
    id: 4,
    name: 'journal applicatif',
    up(database) {
      database.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_connlogs_user ON connection_logs(user_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_destlogs_at   ON destination_logs(at DESC);
      `);
    },
  },

  {
    id: 5,
    name: 'support : fil de conversation et lu / non lu',
    up(database) {
      database.exec(`
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
      `);
      addColumn(database, 'tickets', 'read_at', 'TEXT');

      // Reprise de l'historique existant dans le fil : message initial, puis
      // la réponse admin si elle existe. Rien n'est effacé.
      const tickets = database
        .prepare(
          `SELECT t.id, t.user_id, t.message, t.reply, t.status, t.created_at, t.updated_at,
                  u.username
             FROM tickets t LEFT JOIN users u ON u.id = t.user_id`
        )
        .all();
      const already = database.prepare(
        'SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?'
      );
      const insert = database.prepare(
        `INSERT INTO ticket_messages (ticket_id, author, user_id, username, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      for (const t of tickets) {
        if (already.get(t.id).n > 0) continue;
        insert.run(t.id, 'user', t.user_id, t.username, t.message, t.created_at);
        if (t.reply && t.reply.trim()) {
          insert.run(t.id, 'admin', null, null, t.reply, t.updated_at || t.created_at);
        }
      }

      // Un ticket déjà traité a forcément été lu.
      database
        .prepare(
          "UPDATE tickets SET read_at = COALESCE(updated_at, created_at) WHERE read_at IS NULL AND status != 'recu'"
        )
        .run();
    },
  },

  {
    id: 6,
    name: 'réglages date / heure et Gravatar',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          id               INTEGER PRIMARY KEY CHECK (id = 1),
          timezone         TEXT NOT NULL DEFAULT 'Europe/Paris',
          time_format      TEXT NOT NULL DEFAULT '24'         CHECK (time_format IN ('24','12')),
          date_format      TEXT NOT NULL DEFAULT 'DD/MM/YYYY'
                             CHECK (date_format IN ('DD/MM/YYYY','YYYY-MM-DD','MM/DD/YYYY')),
          gravatar_enabled INTEGER NOT NULL DEFAULT 0,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: 7,
    name: "demandes de changement d'adresse e-mail",
    up(database) {
      database.exec(`
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
      `);
    },
  },

  {
    id: 8,
    name: 'chemin du stockage local : point de montage au lieu de <dataDir>/local',
    up(database) {
      const { config } = require('../config');
      fixLegacyLocalPath(database, {
        legacy: path.join(config.dataDir, 'local'),
        target: config.localPath,
      });
    },
  },

  {
    id: 9,
    name: 'SMTP : chiffrement, nom d\'expéditeur et modèles d\'e-mail',
    up(database) {
      // Le chiffrement était déduit du port (465 = TLS) ; il se choisit
      // maintenant explicitement. NULL = « comme avant », déduit du port.
      addColumn(database, 'security_policy', 'smtp_secure', 'TEXT');
      addColumn(database, 'security_policy', 'smtp_from_name', 'TEXT');

      database.exec(`
        CREATE TABLE IF NOT EXISTS email_templates (
          key        TEXT PRIMARY KEY,
          subject    TEXT NOT NULL,
          body       TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Les modèles par défaut sont posés ici : l'écran SMTP n'a jamais à
      // afficher une liste vide, même sur une base déjà en production.
      require('../email-templates').seedDefaults(database);
    },
  },

  {
    id: 10,
    name: "accueil configurable : préférences de blocs par utilisateur",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_home_widgets (
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          widget_id  TEXT    NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          enabled    INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, widget_id)
        );
      `);
      // Aucune ligne n'est créée : un compte sans préférence reçoit la
      // disposition par défaut. Rien à reprendre, rien à perdre.
    },
  },

  {
    id: 11,
    name: 'planification par utilisateur, limitée aux connecteurs installés',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_connector_schedules (
          user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connector_id      TEXT    NOT NULL,
          frequency         TEXT    NOT NULL DEFAULT 'monthly'
                              CHECK (frequency IN ('daily','weekly','monthly','disabled')),
          time_of_day       TEXT    NOT NULL DEFAULT '03:00',
          day_of_week       INTEGER NOT NULL DEFAULT 1,
          day_of_month      INTEGER NOT NULL DEFAULT 1,
          last_day_of_month INTEGER NOT NULL DEFAULT 0,
          enabled           INTEGER NOT NULL DEFAULT 1,
          updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, connector_id)
        );
        CREATE INDEX IF NOT EXISTS idx_usched_conn ON user_connector_schedules(connector_id);
      `);

      // Reprise : chaque installation réelle hérite du réglage global qui la
      // concernait, sinon des valeurs par défaut. La table
      // `connector_schedules` n'est ni vidée ni supprimée — elle devient le
      // gabarit proposé aux prochaines installations.
      if (!hasTable(database, 'connector_installs')) return;

      const globals = new Map(
        (hasTable(database, 'connector_schedules')
          ? database.prepare('SELECT * FROM connector_schedules').all()
          : []
        ).map((r) => [r.connector_id, r])
      );

      const insert = database.prepare(
        `INSERT INTO user_connector_schedules
           (user_id, connector_id, frequency, time_of_day, day_of_week, day_of_month, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, connector_id) DO NOTHING`
      );

      for (const install of database.prepare('SELECT * FROM connector_installs').all()) {
        const g = globals.get(install.connector_id);
        insert.run(
          install.user_id,
          install.connector_id,
          g?.frequency || 'monthly',
          g?.time_of_day || '03:00',
          g?.day_of_week ?? 1,
          Math.min(Math.max(g?.day_of_month ?? 1, 1), 28),
          g && g.enabled === 0 ? 0 : 1
        );
      }
    },
  },

  {
    id: 12,
    name: 'état de transfert détaillé par destination sur les factures',
    up(database) {
      normalizeInvoiceDestinations(database);
    },
  },

  {
    id: 13,
    name: 'largeur réglable des blocs de l\'accueil',
    up(database) {
      // Colonne NULLABLE, volontairement : NULL veut dire « largeur par défaut
      // du bloc » (12 pour Mes connecteurs, 6 pour Synchronisation…). Poser un
      // NOT NULL DEFAULT 12 aurait élargi d'un coup les blocs demi-ligne des
      // comptes qui ont déjà rangé leur accueil. Rien ne bouge tant que
      // l'utilisateur n'a pas choisi une largeur.
      addColumn(database, 'user_home_widgets', 'span', 'INTEGER');
    },
  },

  {
    id: 14,
    name: 'verrouillage de l\'accueil : verrou personnel et verrou administrateur',
    up(database) {
      // Deux verrous distincts, jamais confondus :
      //   home_locked       — posé par l'utilisateur, retirable par lui ;
      //   home_customizable — posé par l'administrateur, lui seul le retire.
      // Les deux défauts reconduisent l'état actuel : accueil personnalisable.
      addColumn(database, 'users', 'home_locked', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'users', 'home_customizable', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: 15,
    name: 'préférences d\'interface par utilisateur (clé / valeur)',
    up(database) {
      // Un fourre-tout assumé, pour les réglages d'affichage qui n'ont pas de
      // raison d'occuper une colonne de `users` : le filtre « masquer les
      // applications non actives » y range son état. Par compte, pas par
      // navigateur — un administrateur retrouve son filtre d'un poste à
      // l'autre, ce que localStorage ne sait pas faire.
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key        TEXT    NOT NULL,
          value      TEXT    NOT NULL,
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, key)
        );
      `);
    },
  },

  {
    id: 16,
    name: 'catalogue : date de mise à disposition explicite dans le Store',
    up(database) {
      // NULL = jamais publiée explicitement. Les connecteurs livrés avec crabe
      // sont « disponibles » par défaut, ce qui n'est pas une décision d'un
      // administrateur : c'est cette distinction qui permet au filtre
      // « masquer les applications non actives » d'avoir un sens.
      addColumn(database, 'connector_catalog', 'published_at', 'TEXT');
    },
  },

  {
    id: 17,
    name: 'découverte : éléments d\'un compte fournisseur, chiffrés au repos',
    up(database) {
      // Un compte fournisseur peut porter plusieurs abonnements (quatre lignes
      // Free Mobile, plusieurs points de livraison EDF…). La liste n'est
      // connue qu'après connexion : elle ne peut pas vivre dans le manifeste.
      //
      // On mémorise ce qui a DÉJÀ été vu, et pas seulement ce qui est
      // sélectionné : sans cette distinction, une ligne volontairement décochée
      // par l'utilisateur repasserait pour une nouveauté au passage suivant et
      // serait recochée d'office (voir connectors/discovery.js).
      //
      // Les libellés portent des données personnelles (nom du titulaire,
      // numéro de ligne) : la colonne est chiffrée avec la passphrase
      // maîtresse, au même titre que la configuration du connecteur.
      database.exec(`
        CREATE TABLE IF NOT EXISTS connector_discoveries (
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connector_id    TEXT    NOT NULL,
          field_key       TEXT    NOT NULL,
          items_encrypted TEXT,
          updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, connector_id, field_key)
        );
      `);
      database.exec(
        'CREATE INDEX IF NOT EXISTS idx_discoveries_conn ON connector_discoveries(connector_id)'
      );
    },
  },

  {
    id: 18,
    name: 'logos de connecteurs : provenance, format et date de récupération',
    up(database) {
      // Le fichier lui-même vit sous CRABE_DATA_DIR/logos/<id>.<ext> ; cette
      // table dit ce qu'il est et d'où il vient.
      //
      // `source` porte la seule distinction qui change un comportement :
      //
      //   'fetched' — récupéré chez le fournisseur, remplaçable par une
      //               resynchronisation ;
      //   'manual'  — envoyé à la main par un administrateur. Prime sur toute
      //               récupération automatique et n'est JAMAIS écrasé : c'est le
      //               dernier mot de quelqu'un qui a regardé le résultat.
      //
      // Rien de personnel là-dedans : un logo de marque est public, la colonne
      // n'est donc pas chiffrée. `origin` garde l'adresse d'où il vient, pour
      // pouvoir répondre « et ça sort d'où, ça ? » sans relancer une requête.
      //
      // Aucune donnée n'est détruite ni déplacée : une installation qui n'a
      // jamais récupéré de logo continue d'afficher ses pastilles à initiales.
      database.exec(`
        CREATE TABLE IF NOT EXISTS connector_logos (
          connector_id TEXT    PRIMARY KEY,
          extension    TEXT    NOT NULL,
          source       TEXT    NOT NULL DEFAULT 'fetched',
          origin       TEXT,
          bytes        INTEGER NOT NULL DEFAULT 0,
          width        INTEGER,
          height       INTEGER,
          fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: 19,
    name: 'marque des migrations de fichiers (arborescence par année)',
    up(database) {
      // Une migration de SCHÉMA tourne dans une transaction et ne touche que la
      // base ; celle qui déplace des fichiers sur le stockage local ne peut pas en être
      // une : le partage peut être démonté, l'écriture refusée, et il faut
      // pouvoir réessayer au démarrage suivant sans rien avoir cassé.
      //
      // Cette table est donc la MARQUE de ces migrations-là — celles qui
      // touchent le stockage. Elle ne porte aucune donnée personnelle : une
      // clé, une date, trois compteurs et une phrase de compte rendu.
      database.exec(`
        CREATE TABLE IF NOT EXISTS storage_migrations (
          key     TEXT PRIMARY KEY,
          done_at TEXT,
          moved   INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          failed  INTEGER NOT NULL DEFAULT 0,
          details TEXT
        );
      `);
    },
  },

  {
    id: 20,
    name: 'dernier échec de récupération d\'un logo, pour le dire au survol',
    up(database) {
      // Le gestionnaire annonçait « 8 logos en place, 6 manquants » sans jamais
      // dire POURQUOI les six manquaient. La raison existait — « aucune image
      // trouvée sur le site », « site injoignable », « format refusé » — mais
      // elle disparaissait dès qu'on quittait l'écran.
      //
      // Table séparée de `connector_logos`, et non deux colonnes de plus :
      // celle-ci décrit un logo QUI EXISTE (son extension est NOT NULL), et un
      // échec concerne justement un logo qui n'existe pas.
      //
      // Rien de personnel : un nom de service et un message d'erreur technique.
      database.exec(`
        CREATE TABLE IF NOT EXISTS logo_failures (
          connector_id TEXT PRIMARY KEY,
          reason       TEXT NOT NULL,
          at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: 21,
    name: 'profondeur de documents conservée, et son plancher anti-rétroactif',
    up(database) {
      // 0 = tout garder, et c'est le DÉFAUT : une installation qui se met à
      // jour ne doit rien perdre parce que personne n'a encore ouvert l'écran.
      // Les quatre autres valeurs sont 3, 6, 12 et 24 mois (server/retention.js).
      addColumn(database, 'security_policy', 'document_retention_months',
        'INTEGER NOT NULL DEFAULT 0');

      // Le plancher : les documents récupérés AVANT cette date ne sont jamais
      // supprimés par le nettoyage automatique. Posé au moment où la
      // profondeur est réduite, retiré seulement sur confirmation explicite de
      // l'administrateur.
      //
      // Sans lui, choisir « 6 mois » un mardi soir effacerait huit ans de
      // factures dans la nuit, sans que personne ait demandé ça — et sans
      // qu'aucune sauvegarde de crabe ne permette de revenir en arrière.
      addColumn(database, 'security_policy', 'document_retention_floor', 'TEXT');
    },
  },
  {
    id: 22,
    name: 'mois d\'ancrage des planifications trimestrielles et semestrielles',
    up(database) {
      // « Tous les 3 mois » et « tous les 6 mois » (lot 14, §9) ne se décrivent
      // pas par un jour seul : il faut savoir DE QUEL MOIS on part. Sans
      // ancrage, une planification trimestrielle enregistrée en février
      // tomberait en janvier/avril/juillet/octobre — le calendrier de quelqu'un
      // d'autre.
      //
      // NULL par défaut, et posé à la première écriture d'une fréquence qui en
      // a besoin : une planification mensuelle ou hebdomadaire n'en a que
      // faire, et lui en inventer un serait une donnée fausse de plus.
      addColumn(database, 'user_connector_schedules', 'anchor_month', 'INTEGER');

      // ─── La contrainte CHECK, qui n'accepte pas encore les deux rythmes ──
      //
      // SQLite ne sait pas modifier une contrainte : il faut reconstruire la
      // table. Le chemin officiel — table neuve, recopie, bascule — est suivi
      // à la lettre, y compris la reconstruction de l'index, qui suit le nom
      // de la table et disparaîtrait avec l'ancienne.
      //
      // Sans ça, choisir « tous les 3 mois » échouerait sur un `CHECK
      // constraint failed` au moment de l'enregistrement, c'est-à-dire au pire
      // endroit : après que l'utilisateur a cliqué.
      const contrainte = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('user_connector_schedules')?.sql || '';
      if (contrainte.includes('half-yearly')) return;

      database.exec(`
        CREATE TABLE user_connector_schedules_neuve (
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
          anchor_month      INTEGER,
          updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, connector_id)
        );

        INSERT INTO user_connector_schedules_neuve
          (user_id, connector_id, frequency, time_of_day, day_of_week,
           day_of_month, last_day_of_month, enabled, anchor_month, updated_at)
        SELECT user_id, connector_id, frequency, time_of_day, day_of_week,
               day_of_month, last_day_of_month, enabled, anchor_month, updated_at
          FROM user_connector_schedules;

        DROP TABLE user_connector_schedules;
        ALTER TABLE user_connector_schedules_neuve RENAME TO user_connector_schedules;
        CREATE INDEX IF NOT EXISTS idx_usched_conn
          ON user_connector_schedules(connector_id);
      `);
    },
  },

  {
    id: 23,
    name: 'sept connecteurs écrits mais jamais testés : remis en attente au catalogue',
    up(database) {
      // ─── Le piège que cette migration désamorce ───────────────────────────
      //
      // Ces sept services étaient ANNONCÉS (dossier `planned/`) jusqu'au lot
      // 20. Le registre inscrit toute entrée du disque dans
      // `connector_catalog`, annonces comprises, avec le statut
      // `initialStatus || 'available'` — et une annonce ne déclare pas
      // d'`initialStatus`. Leur ligne porte donc déjà « available », ce qui ne
      // gênait personne : le dossier `planned/` suffisait à refuser toute
      // installation.
      //
      // Le lot 20 les déplace dans `available/` avec `initialStatus: pending`,
      // parce qu'ils sont ÉCRITS mais n'ont jamais été exercés contre un compte
      // réel. Sauf que `syncCatalog()` insère en `ON CONFLICT DO NOTHING` : la
      // ligne existant déjà, le nouveau statut ne serait JAMAIS appliqué. Les
      // sept apparaîtraient d'un coup, disponibles pour tout le monde, sur la
      // seule foi d'un code que personne n'a vu tourner.
      //
      // ⚠ `published_at IS NULL` est la condition qui protège une décision
      // humaine : si un administrateur a explicitement approuvé l'un de ces
      // services (bouton « Approuver », qui pose `published_at`), cette
      // migration ne le lui reprend pas. Elle ne corrige que les lignes posées
      // d'office par le registre.
      const ids = [
        'mistral', 'invoice-ninja', 'envato', 'bitstamp', 'paypal', 'anthropic', 'hetzner',
      ];
      if (!hasTable(database, 'connector_catalog')) return;

      const remettre = database.prepare(
        `UPDATE connector_catalog
            SET status = 'pending', updated_at = datetime('now')
          WHERE connector_id = ? AND published_at IS NULL AND status <> 'pending'`
      );
      for (const id of ids) remettre.run(id);
    },
  },

  {
    id: 24,
    name: 'accueil : la pagination partagée devient une pagination par bloc',
    up(database) {
      // ─── Ce qu'il ne faut surtout pas perdre ──────────────────────────────
      //
      // `home.pageSize` (lot 18) réglait d'un seul nombre les deux blocs de
      // l'accueil, « Synchronisation » et « Derniers documents ». Le lot 20 les
      // sépare : chaque bloc a désormais sa clé.
      //
      // Quelqu'un qui avait choisi 30 lignes doit les retrouver SUR LES DEUX
      // BLOCS. Repartir du défaut serait une régression silencieuse — l'accueil
      // change d'aspect après une mise à jour, personne ne comprend pourquoi, et
      // le réglage a l'air de ne pas tenir.
      //
      // `DO NOTHING` en cas de conflit : si une valeur existe déjà sur une des
      // nouvelles clés (base rejouée, réglage posé entre-temps), c'est elle qui
      // fait foi — une migration ne repasse pas devant un choix explicite.
      if (!hasTable(database, 'user_preferences')) return;

      database.exec(`
        INSERT INTO user_preferences (user_id, key, value, updated_at)
          SELECT user_id, 'home.sync.pageSize', value, datetime('now')
            FROM user_preferences WHERE key = 'home.pageSize'
        ON CONFLICT(user_id, key) DO NOTHING;

        INSERT INTO user_preferences (user_id, key, value, updated_at)
          SELECT user_id, 'home.documents.pageSize', value, datetime('now')
            FROM user_preferences WHERE key = 'home.pageSize'
        ON CONFLICT(user_id, key) DO NOTHING;
      `);

      // ─── Et on efface l'ancienne clé ──────────────────────────────────────
      //
      // Décision assumée, prise APRÈS la recopie : plus aucun code ne lit
      // `home.pageSize`, et `preferences.js` refuse désormais cette clé. La
      // laisser en base poserait une seconde vérité — une valeur que rien
      // n'applique, mais qu'un lecteur futur croirait déterminante, et qu'il
      // essaierait de faire respecter. Ce lot en a précisément corrigé une du
      // même genre côté catalogue (migration 23).
      //
      // La suppression est sans risque : la valeur vient d'être recopiée sur
      // les deux clés qui la remplacent, dans la même transaction.
      database.prepare("DELETE FROM user_preferences WHERE key = 'home.pageSize'").run();
    },
  },

  {
    id: 25,
    name: 'Invoice Ninja retiré du catalogue : ce qu\'il laissait derrière lui',
    up(database) {
      // ─── Pourquoi ce service disparaît ────────────────────────────────────
      //
      // Ce n'est pas un défaut de crabe, et le code était correct : le portail
      // client d'Invoice Ninja a son PROPRE mot de passe, distinct de celui du
      // tableau de bord, que la plupart des comptes n'ont jamais défini. Il
      // faut s'en créer un exprès, pour un seul abonnement. Décision prise au
      // lot 22 : le service est retiré plutôt que maintenu à moitié.
      //
      // ─── Ce que le simple effacement du dossier NE ferait pas ─────────────
      //
      // `syncCatalog()` n'insère que : il ne retire jamais. Un connecteur dont
      // le dossier disparaît laisse donc en base sa ligne de catalogue, sa
      // ligne d'installation — **avec sa configuration chiffrée, mot de passe
      // compris** — et sa planification. Rien de tout cela n'est visible :
      // l'interface ne montre que ce que le disque porte, et le planificateur
      // écarte les planifications sans connecteur (scheduler.listSchedules).
      //
      // C'est exactement le travers corrigé au lot 21 sur les clés de
      // configuration : un secret dont plus rien n'a l'usage n'a rien à faire
      // en base. On efface donc, dans l'ordre des dépendances.
      //
      // Les `run_logs`, eux, RESTENT. Ce sont trois lignes d'histoire — ce qui
      // a été tenté, quand, et avec quel résultat — et l'écran des journaux
      // sait afficher un identifiant de connecteur qu'il ne reconnaît plus.
      // Réécrire le passé pour faire propre serait le contraire d'un journal.
      const ID = 'invoice-ninja';

      if (hasTable(database, 'user_connector_schedules')) {
        database.prepare('DELETE FROM user_connector_schedules WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_schedules')) {
        database.prepare('DELETE FROM connector_schedules WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_discoveries')) {
        database.prepare('DELETE FROM connector_discoveries WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_installs')) {
        database.prepare('DELETE FROM connector_installs WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_catalog')) {
        database.prepare('DELETE FROM connector_catalog WHERE connector_id = ?').run(ID);
      }
    },
  },

  {
    id: 26,
    name: 'Envato Market redevient un service annoncé : ce qu\'il laissait installé',
    up(database) {
      // ─── Pourquoi ce service recule ───────────────────────────────────────
      //
      // Décision de l'utilisateur au lot 23 : aucune des deux pistes essayées
      // n'est retenue. Le connecteur écrit au lot 21 n'a jamais rien récupéré
      // — le premier essai réel s'est arrêté sur la double authentification, et
      // la refonte en session capturée qui a suivi n'a jamais été exercée. Son
      // dossier repasse dans `planned/` : le service reste ANNONCÉ, il n'est
      // plus installable.
      //
      // ─── Ce que le seul déplacement de dossier NE ferait pas ──────────────
      //
      // La ligne d'installation, elle, survit au déplacement — avec sa
      // configuration chiffrée et sa planification. Personne ne la verrait :
      // `listForUser` ignore l'installation d'un service annoncé (elle ne
      // pourrait venir que d'une base abîmée), et le planificateur écarte les
      // planifications qu'il ne sait pas exécuter. Elle resterait donc là,
      // muette, prête à ressortir le jour où le service reviendrait — avec des
      // valeurs saisies pour un connecteur qui n'existe plus.
      //
      // Même geste qu'au lot 22 pour Invoice Ninja, et même limite : les
      // `run_logs` ne sont pas touchés. Ce qui a été tenté le 12/08/2026, et
      // pourquoi ça a échoué, fait partie de l'histoire du compte.
      const ID = 'envato';

      if (hasTable(database, 'user_connector_schedules')) {
        database.prepare('DELETE FROM user_connector_schedules WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_schedules')) {
        database.prepare('DELETE FROM connector_schedules WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_discoveries')) {
        database.prepare('DELETE FROM connector_discoveries WHERE connector_id = ?').run(ID);
      }
      if (hasTable(database, 'connector_installs')) {
        database.prepare('DELETE FROM connector_installs WHERE connector_id = ?').run(ID);
      }

      // ─── La ligne de catalogue RESTE, mais cesse de dire « en attente » ────
      //
      // Contrairement à Invoice Ninja, Envato ne disparaît pas : il redevient
      // une annonce, et une annonce a besoin de sa ligne de catalogue pour
      // s'afficher (c'est elle qui porte l'ouverture aux comptes,
      // `isAllowedForUser`). Mais son statut est resté « pending », posé quand
      // le connecteur existait — et `isAllowedForUser` refuse une ligne
      // « pending » à tout compte ordinaire. Envato disparaîtrait donc du Store
      // au lieu d'y afficher « Bientôt disponible » comme les cinquante autres
      // services annoncés.
      //
      // On remet donc la valeur qu'une annonce reçoit naturellement du
      // registre : « available » — qui ne veut pas dire « installable » ici,
      // puisque c'est le DOSSIER `planned/` qui décide de ça, et lui seul.
      //
      // ⚠ POUR LE JOUR OÙ ENVATO REVIENDRA : `syncCatalog()` insère en
      // « ON CONFLICT DO NOTHING ». Un manifeste qui redeviendrait
      // `initialStatus: pending` ne corrigerait donc PAS cette ligne, et le
      // service serait proposé à tout le monde sans avoir jamais été essayé.
      // Il faudra une migration qui le remette en attente — exactement ce que
      // fait la migration 23 pour les sept connecteurs du lot 20.
      if (hasTable(database, 'connector_catalog')) {
        database
          .prepare(
            `UPDATE connector_catalog
                SET status = 'available', updated_at = datetime('now')
              WHERE connector_id = ? AND status = 'pending'`
          )
          .run(ID);
      }
    },
  },

  {
    id: 27,
    name: 'Bitstamp publié : quatre factures réelles ont été récupérées',
    up(database) {
      // ─── Ce qui est prouvé, et par quoi ───────────────────────────────────
      //
      // Bitstamp est sorti du lot 20 en « pending » : écrit, mais jamais exercé
      // contre un vrai compte. Il l'a été le 13/08/2026 à 07:29 — clé d'API
      // acceptée, 891 lignes de solde lues, **4 factures récupérées**
      // (run_logs). C'est exactement la condition qui lève l'attente.
      //
      // ─── Pourquoi retirer `initialStatus` du manifeste ne suffit pas ──────
      //
      // `syncCatalog()` insère en « ON CONFLICT DO NOTHING » : la ligne de
      // catalogue existe déjà, avec « pending » écrit dedans depuis le lot 20.
      // Aucune modification du manifeste ne la corrigera jamais. Sans cette
      // migration, Bitstamp resterait invisible à tout compte ordinaire, pour
      // toujours, alors que le manifeste dit le contraire — et personne ne
      // verrait la contradiction, puisque les deux vivent à des endroits
      // différents.
      //
      // ⚠ `published_at` n'est PAS posé. Cette colonne porte une décision
      // humaine — le bouton « Approuver » de l'administration — et une
      // migration n'a pas à signer à la place de quelqu'un. Ce qu'on fait ici
      // est plus modeste et suffit : aligner la ligne sur ce que le manifeste
      // déclare désormais, c'est-à-dire sur ce qu'une installation neuve de
      // crabe produirait.
      if (!hasTable(database, 'connector_catalog')) return;

      database
        .prepare(
          `UPDATE connector_catalog
              SET status = 'available', updated_at = datetime('now')
            WHERE connector_id = 'bitstamp' AND status = 'pending'`
        )
        .run();
    },
  },

  {
    id: 28,
    name: 'destinations_config : la liste fermée de dest_id disparaît',
    up(database) {
      // ─── Le défaut, et pourquoi il était invisible ────────────────────────
      //
      // `destinations_config.dest_id` portait
      // « CHECK (dest_id IN ('local','proton','pcloud')) ». Le lot 24 ajoute
      // MEGA, kDrive et le mode générique : leurs lignes de configuration
      // étaient refusées par la base.
      //
      // Et refusées SANS UN MOT, parce que l'amorçage insère en
      // « INSERT OR IGNORE » — qui avale aussi bien un doublon (ce qu'on
      // voulait) qu'une violation de contrainte (ce qu'on ne voulait pas). Les
      // trois destinations existaient dans le code, dans le catalogue et dans
      // les écrans ; leur ligne n'était jamais créée ; `publicConfig()` rendait
      // `null` ; elles disparaissaient de l'interface. Aucun journal, aucune
      // erreur, rien à chercher.
      //
      // ─── Pourquoi on retire la contrainte au lieu de l'allonger ───────────
      //
      // Parce qu'allonger une liste fermée impose une migration de table à
      // CHAQUE destination ajoutée — SQLite ne sait pas modifier un CHECK, il
      // faut reconstruire la table entière, comme ici. Et parce que cette
      // liste est déjà tenue à un endroit qui fait autorité :
      // `destinations/catalogue.js`, d'où la lisent l'amorçage et le refus
      // d'une destination inconnue dans `saveConfig()`. La répéter en base ne
      // protégeait de rien de plus.
      //
      // ─── La reconstruction ────────────────────────────────────────────────
      //
      // Table neuve, copie, échange. Les données sont recopiées telles quelles,
      // y compris les blocs `config_encrypted` : rien n'est déchiffré ici, et
      // cette migration n'a besoin d'aucune clé.
      if (!hasTable(database, 'destinations_config')) return;

      // Idempotence : si la contrainte n'est plus là, il n'y a rien à faire.
      const definition = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'destinations_config'")
        .get()?.sql || '';
      if (!/CHECK\s*\(\s*dest_id/i.test(definition)) return;

      database.exec(`
        CREATE TABLE destinations_config_neuve (
          dest_id          TEXT PRIMARY KEY,
          enabled          INTEGER NOT NULL DEFAULT 0,
          path             TEXT,
          protocol         TEXT,
          config_encrypted TEXT,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO destinations_config_neuve
              (dest_id, enabled, path, protocol, config_encrypted, updated_at)
        SELECT dest_id, enabled, path, protocol, config_encrypted, updated_at
          FROM destinations_config;

        DROP TABLE destinations_config;
        ALTER TABLE destinations_config_neuve RENAME TO destinations_config;
      `);

      // Les lignes des destinations neuves ne sont PAS créées ici : c'est le
      // rôle de `seedSingletons()`, qui tourne juste après les migrations et
      // les crée toutes, à chaque démarrage, de façon idempotente. Les créer
      // ici aussi ferait deux endroits à tenir d'accord.
    },
  },

  {
    id: 29,
    name: 'destinations : un cloud n\'est plus une entrée du code, c\'est une ligne',
    up: migrerDestinationsALaDemande,
  },
  {
    id: 30,
    name: 'notifications : les échecs planifiés laissent une trace, groupée par passage',
    up: creerNotifications,
  },
  {
    id: 31,
    name: 'Materiel.net : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreMaterielNetEnAttente,
  },
  {
    id: 32,
    name: 'eDocPerso : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('edocperso'),
  },
  {
    id: 33,
    name: 'SNCF Connect : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('sncf-connect'),
  },
  {
    id: 34,
    name: 'OUIGO : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('ouigo'),
  },
  {
    id: 35,
    name: 'Airbnb : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('airbnb'),
  },
  {
    id: 36,
    name: 'Deezer : une annonce devenue connecteur repart en attente, pas en vitrine',
    // Vérifié sur la base de production le 17/08/2026 avant d'écrire cette
    // migration : la ligne existe, status = 'available', published_at = NULL,
    // aucune installation. Sixième occurrence du piège (23, 31, 32-35).
    up: remettreEnAttente('deezer'),
  },
  {
    id: 37,
    name: 'Spotify : une annonce devenue connecteur repart en attente, pas en vitrine',
    // Vérifié sur la base de production le 17/08/2026 (même relevé que la 36) :
    // status = 'available', published_at = NULL, aucune installation.
    up: remettreEnAttente('spotify'),
  },
  {
    id: 38,
    name: 'Qobuz : une annonce devenue connecteur repart en attente, pas en vitrine',
    // Vérifié sur la base de production le 17/08/2026 (même relevé que la 36) :
    // status = 'available', published_at = NULL, aucune installation.
    up: remettreEnAttente('qobuz'),
  },
  {
    id: 39,
    name: 'SoundCloud : une annonce devenue connecteur repart en attente, pas en vitrine',
    // Vérifié sur la base de production le 17/08/2026 (même relevé que la 36) :
    // status = 'available', published_at = NULL, aucune installation.
    up: remettreEnAttente('soundcloud'),
  },
  {
    id: 40,
    name: 'SNCF Connect : l\'identifiant distant repris sur le document, pas sur ses octets',
    up: reprendreEmpreintesSncf,
  },
  {
    id: 41,
    name: 'OUIGO publié : cinq billets réels ont été récupérés',
    up(database) {
      // ─── Ce qui est prouvé, et par quoi ───────────────────────────────────
      //
      // OUIGO est resté « pending » depuis le lot 31 : écrit, mais jamais
      // validé — l'onglet « Passés » du compte de reconnaissance était vide.
      // Il l'a été le 20/08/2026, en production : **5 billets récupérés sur
      // 5 réservations passées** d'un compte réel (lignes 885 à 889, dépôt
      // « ok » sur les trois destinations pour chacune). C'est exactement la
      // condition qui lève l'attente — la même que Bitstamp à la migration 27.
      //
      // ─── Pourquoi retirer `initialStatus` du manifeste ne suffit pas ──────
      //
      // `syncCatalog()` insère en « ON CONFLICT DO NOTHING » : la ligne de
      // catalogue existe déjà, avec « pending » écrit dedans (posé par la
      // migration 34, quand l'annonce est devenue connecteur). Aucune
      // modification du manifeste ne la corrigera jamais. Sans cette
      // migration, OUIGO resterait invisible à tout compte ordinaire, pour
      // toujours, alors que le manifeste dit le contraire.
      //
      // ⚠ `published_at` n'est PAS posé : cette colonne porte une décision
      // humaine — le bouton « Approuver » de l'administration — et une
      // migration ne signe pas à la place de quelqu'un.
      if (!hasTable(database, 'connector_catalog')) return;

      database
        .prepare(
          `UPDATE connector_catalog
              SET status = 'available', updated_at = datetime('now')
            WHERE connector_id = 'ouigo' AND status = 'pending'`
        )
        .run();
    },
  },
  {
    id: 42,
    name: 'SNCF Connect et OUIGO : l\'identifiant distant ancré sur le voyage, plus sur le fichier',
    up: reprendreIdentitesMetier,
  },
  // ─── Lot 47 : sept annonces deviennent des ébauches de connecteurs ────────
  //
  // Vérifié sur la base de production le 22/08/2026 avant d'écrire ces sept
  // migrations : les sept lignes existent, status = 'available',
  // published_at = NULL, aucune installation. Occurrences 7 à 13 du piège des
  // migrations 23, 31 et 32-39 — une annonce naît « available » au catalogue,
  // et syncCatalog (« ON CONFLICT DO NOTHING ») n'appliquerait jamais le
  // « pending » du manifeste neuf.
  {
    id: 43,
    name: 'Decathlon : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('decathlon'),
  },
  {
    id: 44,
    name: 'Darty : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('darty'),
  },
  {
    id: 45,
    name: 'Boulanger : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('boulanger'),
  },
  {
    id: 46,
    name: 'LDLC : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('ldlc'),
  },
  {
    id: 47,
    name: 'Electro Dépôt : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('electro-depot'),
  },
  {
    id: 48,
    name: 'Bricomarché : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('bricomarche'),
  },
  {
    id: 49,
    name: 'VistaPrint : une annonce devenue connecteur repart en attente, pas en vitrine',
    up: remettreEnAttente('vistaprint'),
  },
  {
    id: 50,
    name: 'optimisation : les réglages des cinq volets naissent en manuel',
    // Aucun comportement ne change : tout est en manuel, la récurrence par
    // défaut (6 mois) ne vaut que si l'administrateur passe en automatique.
    up: creerOptimisationReglages,
  },
];

/** Migration 50 — la table des réglages de l'écran Optimisation (lot 60). */
function creerOptimisationReglages(database) {
  database.exec(`
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
  `);
  const insert = database.prepare(
    'INSERT OR IGNORE INTO optimisation_reglages (volet) VALUES (?)'
  );
  for (const volet of ['globale', 'cache', 'profils', 'cloud', 'sauvegardes']) {
    insert.run(volet);
  }
}

/**
 * Migration 40 — les identifiants distants SNCF, recalculés sur les fichiers
 * déjà déposés.
 *
 * ─── Pourquoi une correction du code ne suffisait pas ────────────────────────
 *
 * Le lot 44 fait dériver l'identifiant distant SNCF du document débarrassé de
 * sa date de génération (voir `connectors/empreinte-document.js`). Les lignes
 * déjà en base, elles, portent l'ANCIENNE forme : le sha256 des octets reçus
 * ce jour-là. Or ces octets ne reviendront jamais — SNCF regénère le PDF à
 * chaque téléchargement, avec une date et un identifiant de document neufs.
 * L'ancien identifiant n'est donc pas recalculable depuis un téléchargement
 * futur : sans cette migration, le connecteur corrigé ne reconnaîtrait AUCUNE
 * des lignes existantes et le prochain passage en ajouterait autant de neuves.
 * La correction aurait aggravé ce qu'elle répare.
 *
 * Ce que la migration fait : pour chaque justificatif SNCF, elle relit le
 * fichier là où il a été déposé — le chemin est écrit dans `destinations` —,
 * en recalcule l'empreinte stable, et l'inscrit. Ces octets-là sont exactement
 * ceux qui ont été téléchargés : leur empreinte normalisée est celle que
 * rendra le prochain téléchargement du même justificatif (vérifié sur les
 * trois paires du 19 et du 20/08/2026, identiques octet à octet après
 * normalisation).
 *
 * Ce qu'elle ne fait pas : elle ne touche ni aux fichiers, ni aux noms de
 * fichiers, ni aux lignes en double. Renommer un fichier déjà copié dans trois
 * destinations désaccorderait la base de ce qu'elle décrit ; et le sort des
 * doublons est une décision, pas une migration.
 *
 * Une ligne dont le fichier n'est pas relisible — destination distante,
 * montage absent, poste de développement — est laissée intacte : une migration
 * qui devine vaut moins qu'une migration qui s'abstient.
 */
function reprendreEmpreintesSncf(database) {
  if (!hasTable(database, 'invoices')) return 0;

  const fs = require('node:fs');
  const empreinte = require('../connectors/empreinte-document');

  const lignes = database
    .prepare(
      `SELECT id, remote_id, destinations FROM invoices
        WHERE connector_id = 'sncf-connect' AND remote_id IS NOT NULL`
    )
    .all();
  const majRemoteId = database.prepare('UPDATE invoices SET remote_id = ? WHERE id = ?');

  let reprises = 0;
  for (const ligne of lignes) {
    // Le chemin LOCAL du dépôt : celui du stockage local (un montage), jamais celui
    // d'un cloud (`crabe:crabe/…`, qui n'est pas un chemin de fichier).
    let chemin = null;
    try {
      const depots = JSON.parse(ligne.destinations || '{}');
      for (const depot of Object.values(depots)) {
        const p = depot && typeof depot.path === 'string' ? depot.path : '';
        if (p.startsWith('/')) { chemin = p; break; }
      }
    } catch { chemin = null; }
    if (!chemin) continue;

    let octets = null;
    try { octets = fs.readFileSync(chemin); } catch { octets = null; }
    if (!octets || !empreinte.estPdf(octets)) continue;

    const neuf = empreinte.empreinteStable(octets, { prefixe: 'sncf-connect' });
    if (neuf === ligne.remote_id) continue;
    majRemoteId.run(neuf, ligne.id);
    reprises++;
  }
  return reprises;
}

/**
 * Migration 42 — les identifiants SNCF Connect et OUIGO s'ancrent sur le
 * voyage, plus sur le fichier.
 *
 * ─── Pourquoi la migration 40 n'a pas suffi ──────────────────────────────────
 *
 * Elle reposait sur une mesure vraie le 20/08/2026 : le document regénéré
 * était identique une fois son enveloppe datée retirée. Le 22/08/2026, les
 * deux services ont redéposé HUIT documents déjà en base — la taille même des
 * fichiers avait changé. Mesuré sur les paires rapatriées : SNCF tamponne la
 * date d'édition DANS la page (« Paris, le 22/08/2026 »), OUIGO regénère son
 * billet avec un nom de ressource aléatoire jusque dans les flux compressés.
 * Aucune normalisation par retrait de champs nommés ne peut suivre.
 *
 * Le lot 46 ancre donc l'identifiant sur ce que le document DIT : le code
 * « Dossier voyage » pour SNCF Connect, le numéro de réservation et le
 * passager pour OUIGO (`connectors/identite-voyage.js`, vérifié sur les 18
 * fichiers réels de production). Comme au lot 44 : sans cette reprise des
 * lignes existantes, le connecteur corrigé ne reconnaîtrait AUCUNE d'entre
 * elles et le passage suivant en ajouterait autant de neuves.
 *
 * Au passage, la date d'émission des justificatifs SNCF — « votre commande
 * e-billet du JJ/MM/AAAA », imprimée sur le document — remplit `issued_on`,
 * jusque-là toujours vide (d'où des noms en « date-inconnue » et un rangement
 * sous « inconnu »). Seule la COLONNE est remplie : les fichiers déjà déposés
 * gardent leur nom et leur place — les renommer désaccorderait la base des
 * trois destinations qui les portent déjà.
 *
 * Ce qu'elle ne fait pas, comme la 40 : elle ne touche ni aux fichiers, ni aux
 * noms, ni aux lignes en double (leur sort est une décision, pas une
 * migration) ; et une ligne dont le fichier ne se relit pas, ou dont
 * l'identité ne se lit pas dans le document, reste INTACTE — elle garde son
 * empreinte, qui reste un identifiant valide, simplement moins durable.
 */
function reprendreIdentitesMetier(database) {
  if (!hasTable(database, 'invoices')) return 0;

  const fs = require('node:fs');
  const identite = require('../connectors/identite-voyage');

  const lignes = database
    .prepare(
      `SELECT id, connector_id, remote_id, issued_on, destinations FROM invoices
        WHERE connector_id IN ('sncf-connect', 'ouigo') AND remote_id IS NOT NULL`
    )
    .all();
  const majLigne = database.prepare(
    'UPDATE invoices SET remote_id = ?, issued_on = ? WHERE id = ?'
  );

  let reprises = 0;
  for (const ligne of lignes) {
    // Le chemin LOCAL du dépôt : celui du stockage local (un montage), jamais
    // celui d'un cloud (`crabe:crabe/…`, qui n'est pas un chemin de fichier).
    let chemin = null;
    try {
      const depots = JSON.parse(ligne.destinations || '{}');
      for (const depot of Object.values(depots)) {
        const p = depot && typeof depot.path === 'string' ? depot.path : '';
        if (p.startsWith('/')) { chemin = p; break; }
      }
    } catch { chemin = null; }
    if (!chemin) continue;

    let octets = null;
    try { octets = fs.readFileSync(chemin); } catch { octets = null; }
    if (!octets || !identite.estPdf(octets)) continue;

    let remoteId = null;
    let issuedOn = ligne.issued_on;
    if (ligne.connector_id === 'sncf-connect') {
      const vu = identite.identiteSncfConnect(octets);
      remoteId = vu.dossier ? `sncf-connect-${vu.dossier}` : null;
      if (remoteId && !issuedOn && vu.commandeDu) issuedOn = vu.commandeDu;
    } else {
      remoteId = identite.remoteIdOuigo(octets);
    }
    if (!remoteId) continue;
    if (remoteId === ligne.remote_id && issuedOn === ligne.issued_on) continue;

    majLigne.run(remoteId, issuedOn, ligne.id);
    reprises++;
  }
  return reprises;
}

/**
 * Le même piège que les migrations 27 et 31, généralisé — parce qu'il
 * reviendra à CHAQUE annonce qui devient connecteur (SNCF Connect et OUIGO
 * sont les prochains sur la liste).
 *
 * Une annonce (`planned/`) est inscrite au catalogue avec « available »
 * puisqu'elle ne déclare pas d'`initialStatus` — sans conséquence tant que le
 * dossier `planned/` refuse l'installation. Le jour où le connecteur réel
 * arrive dans `available/` avec `initialStatus: pending`, `syncCatalog()`
 * (« ON CONFLICT DO NOTHING ») laisse la vieille ligne en vitrine : le
 * connecteur jamais exercé contre un compte réel serait proposé à tout le
 * monde. La fabrique ci-dessous rend la migration d'une ligne, dans le moule
 * de la 31 : le statut repasse « pending » sauf si un administrateur a déjà
 * approuvé la publication (`published_at`), décision humaine qu'une migration
 * ne défait pas.
 */
function remettreEnAttente(connectorId) {
  return (database) => {
    if (!hasTable(database, 'connector_catalog')) return;
    database
      .prepare(
        `UPDATE connector_catalog
            SET status = 'pending', updated_at = datetime('now')
          WHERE connector_id = ?
            AND status = 'available'
            AND published_at IS NULL`
      )
      .run(connectorId);
  };
}

/**
 * Migration 31 — Materiel.net, annoncé hier, connecté aujourd'hui.
 *
 * ─── Le piège, pour la troisième fois ────────────────────────────────────────
 *
 * Materiel.net était un service ANNONCÉ (dossier `planned/`) jusqu'au lot 30.
 * Le registre inscrit toute entrée du disque dans `connector_catalog`, annonces
 * comprises, avec le statut `initialStatus || 'available'` — et une annonce ne
 * déclare pas d'`initialStatus`. Sa ligne porte donc déjà « available », ce qui
 * ne gênait personne : le dossier `planned/` suffisait à refuser toute
 * installation.
 *
 * Le lot 30 écrit le vrai connecteur et le pose dans `available/` avec
 * `initialStatus: pending`, parce qu'il n'a **jamais été exercé contre un
 * compte réel** — la reconnaissance s'est faite sur les pages publiques, sans
 * identifiants. Sauf que `syncCatalog()` insère en « ON CONFLICT DO NOTHING » :
 * la ligne existant déjà, le nouveau statut ne serait JAMAIS appliqué.
 * Materiel.net apparaîtrait d'un coup, disponible pour tout le monde, sur la
 * seule foi d'un code que personne n'a vu tourner.
 *
 * **Vérifié sur la base de production le 14/08/2026**, avant d'écrire cette
 * migration : la ligne existe bien, `status = 'available'`,
 * `published_at = NULL`. Ce n'était donc pas une précaution théorique.
 *
 * C'est exactement ce que la migration 23 fait pour les sept connecteurs du lot
 * 20, et ce que l'avertissement laissé dans la migration 25 annonçait pour « le
 * jour où ». Ce jour-là est arrivé.
 *
 * ⚠ `published_at IS NULL` protège une décision humaine : si un administrateur
 * a explicitement approuvé ce service (bouton « Approuver », qui pose
 * `published_at`), cette migration ne le lui reprend pas. Elle ne corrige que
 * la ligne posée d'office par le registre.
 *
 * ⚠ `published_at` n'est pas posé non plus : une migration ne signe pas à la
 * place de quelqu'un. Materiel.net passera « available » le jour où une facture
 * réelle en sera descendue, par une migration qui le dira.
 */
function remettreMaterielNetEnAttente(database) {
  if (!hasTable(database, 'connector_catalog')) return;
  database
    .prepare(
      `UPDATE connector_catalog
          SET status = 'pending', updated_at = datetime('now')
        WHERE connector_id = 'materiel-net'
          AND status = 'available'
          AND published_at IS NULL`
    )
    .run();
}

/**
 * Migration 30 — la table des notifications.
 *
 * Un échec de récupération planifiée n'était signalé que par un e-mail. Sans
 * SMTP configuré — ce qui est le cas par défaut, et le restera pour beaucoup —
 * il ne laissait donc AUCUN signal : ni bandeau, ni pastille, rien. Il fallait
 * penser à ouvrir « Suivi actions » pour découvrir qu'un service était en panne
 * depuis trois semaines.
 *
 * La ligne écrite ici est ce signal. Elle sert les deux canaux : la
 * notification du navigateur vient la relever, et elle reste quand aucun
 * courriel n'a pu partir.
 *
 * `seen_at` plutôt qu'une suppression à la lecture : une notification acquittée
 * garde sa trace, et l'accueil peut la remontrer si la panne persiste.
 */
function creerNotifications(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    seen_at    TEXT
  )`);
  // L'écran ne demande jamais que « ce que CE compte n'a pas vu » : c'est
  // exactement l'index qu'il faut, et le seul.
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_user_unseen ON notifications(user_id, seen_at)'
  );
}

/**
 * Migration 29 — le passage des six destinations en dur aux clouds à la demande.
 *
 * ─── Ce que cette migration NE FAIT PAS, et c'est le point important ─────────
 *
 * Elle **ne renomme aucun `dest_id`**. C'était la tentation évidente — donner
 * aux anciennes destinations le nouveau format `cloud-xxxxxxxx` pour
 * l'uniformité — et c'était le meilleur moyen de tout casser. Cet identifiant
 * n'est pas une clé locale : on le retrouve dans `invoices.destinations` (une
 * entrée par copie, sur des milliers de factures), dans `destination_logs`,
 * dans la préférence `destinations.desactivees` de chaque compte, et dans les
 * pastilles de trois écrans. Le réécrire partout sans en oublier un est un pari
 * qu'on n'a aucune raison de prendre : une destination configurée garde donc
 * son identifiant à vie, `proton` reste `proton`, et tout ce qui le désigne
 * continue de fonctionner sans être touché.
 *
 * Ce qu'elle ajoute, c'est ce qui manquait à ces lignes pour exister dans le
 * nouveau modèle : un nom affichable, un fournisseur, une date de création.
 *
 * ─── Ce qu'elle supprime, et à quelle condition seulement ────────────────────
 *
 * Les lignes que `seedSingletons()` a créées pour des destinations que
 * PERSONNE n'a jamais configurées. Sur l'installation d'origine, c'est le cas de
 * cinq lignes sur six : elles n'existent que parce que le code déclarait six
 * destinations, et ce sont précisément elles qui doivent disparaître pour qu'il
 * ne reste que le stockage local (voir le lot 25, §4).
 *
 * « Jamais configurée » ne se déduit pas de `enabled` : activer une destination
 * depuis l'écran écrivait un `config_encrypted` vide mais bien présent. La
 * question se pose donc au contenu déchiffré — y a-t-il un bloc rclone, ou au
 * moins un champ rempli ? — et **le doute profite toujours à la ligne** : un
 * bloc qu'on n'arrive pas à déchiffrer (clé changée, format inattendu) est
 * gardé, pas supprimé. Perdre une destination configurée est irréparable ;
 * garder une ligne vide de trop se corrige d'un clic sur « Supprimer ».
 */
function migrerDestinationsALaDemande(database) {
  if (!hasTable(database, 'destinations_config')) return;

  addColumn(database, 'destinations_config', 'display_name', 'TEXT');
  addColumn(database, 'destinations_config', 'provider', 'TEXT');
  addColumn(database, 'destinations_config', 'deleted_at', 'TEXT');
  // Sans valeur par défaut : SQLite refuse `DEFAULT (datetime('now'))` sur un
  // ALTER TABLE (le défaut doit être constant). La colonne est donc remplie
  // juste après, depuis `updated_at` — la seule date que ces lignes portent.
  addColumn(database, 'destinations_config', 'created_at', 'TEXT');
  database
    .prepare("UPDATE destinations_config SET created_at = updated_at WHERE created_at IS NULL")
    .run();

  const crypto = require('../crypto');
  const presets = require('../destinations/presets');
  const libelles = {
    proton: 'Proton Drive',
    pcloud: 'pCloud',
    mega: 'MEGA',
    kdrive: 'kDrive',
    rclone: 'Autre stockage',
  };

  for (const [ancienId, providerId] of Object.entries(presets.HERITAGE)) {
    const ligne = database
      .prepare('SELECT dest_id, config_encrypted, display_name FROM destinations_config WHERE dest_id = ?')
      .get(ancienId);
    if (!ligne) continue;

    // `null` en repli veut dire « je n'ai pas réussi à lire » — et se distingue
    // ainsi d'un objet vide, qui veut dire « lu, et il n'y a rien dedans ».
    const conf = ligne.config_encrypted
      ? crypto.tryDecryptJson(ligne.config_encrypted, null)
      : {};

    const illisible = conf === null;
    const configuree = illisible
      || !!String(conf.rcloneConfig || '').trim()
      || Object.values(conf.valeurs || {}).some((v) => String(v ?? '').trim());

    if (!configuree) {
      database.prepare('DELETE FROM destinations_config WHERE dest_id = ?').run(ancienId);
      continue;
    }

    database
      .prepare(
        `UPDATE destinations_config
            SET display_name = COALESCE(NULLIF(display_name, ''), ?),
                provider     = COALESCE(NULLIF(provider, ''), ?)
          WHERE dest_id = ?`
      )
      .run(libelles[ancienId] || ancienId, providerId, ancienId);
  }
}

/**
 * Donne une forme explicite à `invoices.destinations`.
 *
 * Avant le lot 3, la colonne ne portait qu'un `{ok, path}` posé au moment du
 * dépôt : ni horodatage, ni distinction entre « pas encore tenté » et
 * « échoué ». On complète chaque entrée existante SANS rien inventer :
 * `state = 'unknown'`, `at = null`. Les six factures de production ont bien
 * été écrites sur le stockage local, mais personne n'a mesuré leur copie ailleurs et
 * aucune date de copie n'a été conservée — les afficher « OK » serait une
 * affirmation que rien ne soutient. La prochaine synchronisation réussie
 * remplace ces « inconnu » par un état daté.
 *
 * `ok` et `path` sont conservés tels quels : la comptabilité de stockage et la
 * résolution du chemin de téléchargement continuent de fonctionner.
 *
 * @param {import('better-sqlite3').Database} database
 * @returns {number} nombre de factures réécrites
 */
function normalizeInvoiceDestinations(database) {
  if (!hasTable(database, 'invoices')) return 0;

  const rows = database.prepare('SELECT id, destinations FROM invoices').all();
  const update = database.prepare('UPDATE invoices SET destinations = ? WHERE id = ?');
  let changed = 0;

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.destinations || '{}');
    } catch {
      parsed = {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

    let touched = false;
    for (const [destId, outcome] of Object.entries(parsed)) {
      if (!outcome || typeof outcome !== 'object') {
        parsed[destId] = { state: 'unknown', ok: !!outcome, at: null };
        touched = true;
        continue;
      }
      if (outcome.state) continue;
      parsed[destId] = { ...outcome, state: 'unknown', at: outcome.at ?? null };
      touched = true;
    }

    if (!touched) continue;
    update.run(JSON.stringify(parsed), row.id);
    changed++;
  }

  return changed;
}

/**
 * Ramène la destination locale sur le point de montage réel.
 *
 * Le premier défaut construisait le chemin depuis dataDir
 * (/opt/crabe/data/local) : ce dossier n'existe pas et n'est pas
 * inscriptible, alors que le vrai point de montage est /mnt/local — d'où le
 * « écriture impossible » affiché en production.
 *
 * Seule la valeur encore égale à cet ancien défaut est corrigée : un chemin
 * choisi par l'administrateur n'est jamais touché.
 *
 * @param {import('better-sqlite3').Database} database
 * @param {{legacy: string, target: string}} paths
 * @returns {number} nombre de lignes corrigées
 */
function fixLegacyLocalPath(database, { legacy, target }) {
  if (!target || legacy === target) return 0;
  if (!hasTable(database, 'destinations_config')) return 0;

  return database
    .prepare(
      `UPDATE destinations_config
          SET path = ?, updated_at = datetime('now')
        WHERE dest_id = 'local' AND path = ?`
    )
    .run(target, legacy).changes;
}

/**
 * Applique les migrations manquantes, dans l'ordre, chacune dans sa
 * transaction : une migration qui échoue n'en laisse pas la moitié en place.
 *
 * @param {import('better-sqlite3').Database} database
 * @returns {{applied: Array<{id: number, name: string}>, current: number}}
 */
function apply(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const done = new Set(
    database.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id)
  );
  const record = database.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');
  const applied = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    database.transaction(() => {
      migration.up(database);
      record.run(migration.id, migration.name);
    })();
    applied.push({ id: migration.id, name: migration.name });
  }

  return {
    applied,
    current: MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].id : 0,
  };
}

module.exports = {
  MIGRATIONS,
  apply,
  hasTable,
  hasColumn,
  addColumn,
  fixLegacyLocalPath,
  normalizeInvoiceDestinations,
  reprendreEmpreintesSncf,
  reprendreIdentitesMetier,
};
