'use strict';

/**
 * Connecteurs, côté utilisateur.
 *
 * Toutes les routes sont bornées à `req.user` : un compte ne peut ni lire ni
 * déclencher les connecteurs d'un autre, même en devinant un identifiant.
 */

const express = require('express');
const fs = require('node:fs');
const db = require('../db/db');
const registry = require('../connectors/registry');
const inflight = require('../connectors/inflight');
const logos = require('../connectors/logos');
const scheduler = require('../scheduler');
const destinations = require('../destinations');
const invoicesLib = require('../invoices');
const schedules = require('../schedules');
const applog = require('../applog');
const diagnostics = require('../diagnostics');
const { requireAuth, requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

/**
 * Catalogue visible par l'utilisateur courant, avec son état d'installation.
 *
 * `categories` accompagne la liste depuis le lot 11 : le Store affichait
 * jusque-là cinq pastilles écrites en dur dans le front, qui auraient dû être
 * tenues à jour à la main à chaque catégorie ajoutée. L'ordre et les libellés
 * viennent maintenant du serveur — une seule liste, dans
 * connectors/manifest-schema.js, et le front n'a plus qu'à écarter les
 * catégories qu'aucun service ne remplit.
 *
 * `counts` dit combien de services sont réellement disponibles et combien sont
 * annoncés, sur le périmètre de CE compte : un connecteur réservé à quelqu'un
 * d'autre ne doit pas gonfler un compte affiché à tout le monde.
 */
router.get('/', (req, res) => {
  const connectors = registry.listForUser(req.user);
  res.json({
    connectors,
    categories: Object.entries(require('../connectors/manifest-schema').CATEGORIES).map(
      ([id, label]) => ({ id, label })
    ),
    counts: {
      // ⚠ Les services EN ATTENTE DE TEST sont comptés à part, jamais dans les
      // « disponibles ». Un administrateur les voit depuis le lot 20 (voir
      // registry.voitLesEnAttente) : les fondre dans le total annoncerait
      // « 34 services disponibles » alors que sept n'ont jamais été essayés,
      // c'est-à-dire précisément le mensonge que le mécanisme `pending` existe
      // pour éviter.
      available: connectors.filter((c) => !c.planned && c.catalogStatus !== 'pending').length,
      pending: connectors.filter((c) => !c.planned && c.catalogStatus === 'pending').length,
      planned: connectors.filter((c) => c.planned).length,
    },
  });
});

/**
 * Le logo d'un service, servi par crabe.
 *
 * Monté AVANT `GET /:id` : deux segments, donc aucune ambiguïté, mais l'ordre
 * reste explicite pour qui ajoutera une route demain.
 *
 * **Toujours local.** Un logo récupéré est un fichier sur le disque : aucun
 * écran ne redemande quoi que ce soit au fournisseur à l'affichage. Sans cette
 * règle, ouvrir l'accueil reviendrait à annoncer à treize services qu'on est
 * là — c'est exactement ce que le lot voulait éviter en refusant les
 * agrégateurs.
 */
router.get('/logos/:file', (req, res) => {
  const trouve = /^([a-z0-9][a-z0-9-]*)\.([a-z]{3,4})$/.exec(String(req.params.file || ''));
  if (!trouve) return res.status(404).end();

  const [, connectorId, ext] = trouve;
  const ligne = logos.lire(connectorId);
  // L'extension demandée doit être CELLE enregistrée, et le chemin est
  // reconstruit par le serveur — jamais repris de la requête.
  if (!ligne || ligne.extension !== ext) return res.status(404).end();

  const file = logos.chemin(connectorId);
  if (!file || !fs.existsSync(file)) return res.status(404).end();

  res.type(logos.TYPES_PAR_EXT[ext] || 'application/octet-stream');
  // Un an : l'adresse porte un horodatage, une resynchronisation change donc
  // l'adresse et le navigateur recharge de lui-même.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(file);
});

/**
 * Ce compte a-t-il le droit de toucher à ce connecteur ?
 *
 * `agir` distingue les deux usages. **Regarder** un service annoncé est normal
 * — c'est même tout l'objet du lot 11, il est là pour être vu dans le Store.
 * **Agir** dessus ne l'est pas : rien n'existe derrière son manifeste.
 *
 * Le contrôle est ici plutôt que dans chaque route parce que l'oubli est trop
 * facile : une route ajoutée demain hérite du refus sans que personne y pense.
 *
 * @param {object} req
 * @param {string} connectorId
 * @param {{agir?: boolean|string}} [options] `agir` : le geste tenté
 *   (« installé », « testé »…), ou `true` pour le mot par défaut.
 */
function assertAllowed(req, connectorId, { agir = false } = {}) {
  if (!registry.has(connectorId)) {
    const err = new Error('Connecteur inconnu.');
    err.statusCode = 404;
    throw err;
  }
  if (!registry.isAllowedForUser(connectorId, req.user)) {
    const err = new Error('Ce connecteur n\'est pas disponible pour votre compte.');
    err.statusCode = 403;
    throw err;
  }
  if (agir) registry.assertInstallable(connectorId, agir === true ? 'utilisé' : agir);
}

/** Détail d'un connecteur + aperçu de ses dernières factures (quickview). */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id);
    const manifest = registry.listForUser(req.user).find((c) => c.id === req.params.id);

    const invoices = db
      .get()
      .prepare(
        `SELECT id, filename, issued_on, fetched_at, size_bytes FROM invoices
          WHERE user_id = ? AND connector_id = ?
          ORDER BY fetched_at DESC LIMIT 6`
      )
      .all(req.user.id, req.params.id);

    // Terminées seulement : la ligne d'une exécution en cours (success = 0,
    // pas de message) passerait pour le dernier résultat — un faux « Échec ».
    const lastRun = db
      .get()
      .prepare(
        `SELECT started_at, success, message FROM run_logs
          WHERE user_id = ? AND connector_id = ? AND finished_at IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`
      )
      .get(req.user.id, req.params.id);

    res.json({ connector: manifest, invoices, lastRun: lastRun || null });
  })
);

router.post(
  '/:id/install',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'installé' });
    const install = registry.install(req.user.id, req.params.id);
    // La planification suit l'installation : le scheduler doit en tenir
    // compte immédiatement, sans attendre un redémarrage du service.
    scheduler.reload();
    res.json({ ok: true, status: install.status });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'désinstallé' });
    const removed = registry.uninstall(req.user.id, req.params.id);
    scheduler.reload();
    res.json({ ok: removed });
  })
);

/** Enregistre la configuration (chiffrée) et active le connecteur. */
router.put(
  '/:id/config',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'configuré' });
    registry.install(req.user.id, req.params.id);
    const install = registry.saveConfig(req.user.id, req.params.id, req.body?.config || {});
    // Le connecteur devient exécutable : sa tâche cron peut être armée.
    scheduler.reload();
    res.json({ ok: true, status: install.status });
  })
);

/**
 * Test de connexion.
 * Accepte une configuration transmise dans la requête (formulaire en cours de
 * saisie, pas encore enregistré) ou, à défaut, celle déjà stockée.
 */
router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'testé' });

    const draft = req.body?.config;
    if (draft && Object.values(draft).some((v) => v !== '' && v !== null && v !== undefined)) {
      const stored = registry.getInstall(req.user.id, req.params.id)?.config_encrypted
        ? registry.readConfig(req.user.id, req.params.id)
        : {};
      // Les champs laissés vides retombent sur la valeur déjà enregistrée.
      const merged = { ...stored };
      for (const [k, v] of Object.entries(draft)) {
        if (v !== '' && v !== null && v !== undefined) merged[k] = v;
      }
      return res.json(await registry.test(req.params.id, merged, { userId: req.user.id }));
    }

    res.json(await registry.testForUser(req.user.id, req.params.id));
  })
);

/**
 * Découverte des éléments d'un compte (lot 5, §1.2).
 *
 * Longue par nature — un navigateur s'ouvre, se connecte, déplie un menu et
 * bascule sur chaque ligne pour compter ses factures : 20 à 60 secondes chez
 * Free Mobile. L'interface affiche un état d'attente explicite pendant ce
 * temps ; un formulaire qui semblerait figé serait déroutant.
 *
 * Le résultat est mémorisé (connectors/discovery.js) et la sélection proposée
 * tient compte de ce qui était déjà enregistré.
 *
 * **Une seule recherche à la fois par compte et par connecteur.** Griser le
 * bouton dans l'interface est nécessaire mais ne suffit pas : un deuxième
 * onglet, un rechargement, un appel direct à l'API passeraient à travers, et
 * ouvriraient un second navigateur sur le même compte chez le même fournisseur
 * (voir connectors/inflight.js).
 */
router.post(
  '/:id/discover',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'exploré' });
    if (!registry.hasDiscovery(req.params.id)) {
      return res.status(400).json({
        error: 'Ce connecteur n\'a pas d\'étape de découverte.',
      });
    }

    const nom = registry.manifest(req.params.id).name;
    try {
      const found = await inflight.discovery.run(
        inflight.discoveryKey(req.user.id, req.params.id),
        () => registry.discoverForUser(req.user.id, req.params.id),
        `Une recherche est déjà en cours sur votre compte ${nom} — laissez-la finir, `
          + 'elle demande de vingt secondes à une minute.'
      );

      res.json({
        field: {
          key: found.field.key,
          label: found.field.label,
          help: found.field.help || '',
          notice: found.field.notice || '',
          // Le nom de ce qu'on cherche, pour écrire « Recherche de vos
          // lignes… » plutôt que « Recherche en cours… ».
          unit: found.field.unit || '',
          unitFeminine: !!found.field.unitFeminine,
        },
        items: found.items,
        selection: found.selection,
        added: found.added,
        missing: found.missing,
      });
    } catch (err) {
      // Un échec de découverte n'est pas une erreur de programmation : la
      // session a pu expirer, le portail changer, une recherche tourner déjà.
      // On le dit tel quel, avec le code que l'appelant a posé.
      res.status(err.statusCode || 502).json({
        error: err.message,
        sessionExpired: !!err.sessionExpired,
        alreadyRunning: !!err.alreadyRunning,
      });
    }
  })
);

/** Récupération manuelle immédiate. */
router.post(
  '/:id/run',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'exécuté' });
    const result = await scheduler.runForUser(req.user.id, req.params.id, 'manual');
    res.json(result);
  })
);

/**
 * Rattrapage : UNE exécution sur tout l'historique disponible (lot 32).
 *
 * Le réglage « Historique » du compte n'est jamais modifié — la surcharge ne
 * vit que le temps de cette exécution (voir scheduler.runForUser). Ce qui est
 * déjà rangé n'est pas re-téléchargé (`remote_id` fait foi), et rien n'est
 * jamais supprimé : les documents rattrapés sont protégés par le plancher de
 * conservation, comme tout document plus ancien que la fenêtre au moment où
 * elle a été posée (voir server/retention.js).
 */
router.post(
  '/:id/run-historique-complet',
  asyncHandler(async (req, res) => {
    assertAllowed(req, req.params.id, { agir: 'exécuté' });
    const result = await scheduler.runForUser(req.user.id, req.params.id, 'manual', {
      toutLHistorique: true,
    });
    res.json(result);
  })
);

/** Permissions détaillées d'un connecteur installé. */
router.get(
  '/:id/permissions',
  asyncHandler(async (req, res) => {
    // Un service annoncé ne déclare aucune permission : il ne manipule rien.
    // Ouvrir sa fiche de permissions n'aurait qu'une page vide à montrer.
    assertAllowed(req, req.params.id, { agir: 'consulté en détail' });
    const manifest = registry.manifest(req.params.id);
    const vocabulary = require('../connectors/permission-vocabulary');
    res.json({
      connector: { id: manifest.id, name: manifest.name, color: manifest.color, letters: manifest.letters },
      // Icône et libellé viennent du vocabulaire commun, la description est
      // propre au connecteur : c'est ce qui rend le consentement éclairé.
      permissions: manifest.permissionDetails || vocabulary.describeAll(manifest.permissions),
      note: vocabulary.NOTICE,
    });
  })
);

/** Usage de stockage du compte courant (page « Stockage » du profil). */
router.get(
  '/me/storage',
  asyncHandler(async (req, res) => {
    res.json(await destinations.storageOverviewForUser(req.user.id));
  })
);

/**
 * Toutes les factures du compte courant, du plus récent au plus ancien.
 * Filtrée par user_id : jamais un document d'un autre compte.
 *
 * L'accueil n'en affiche que les dix dernières (voir GET /api/home) ; cette
 * route reste la vue exhaustive, et sert de garde-fou d'isolation dans les
 * tests (test/isolation.test.js).
 */
router.get('/me/invoices', (req, res) => {
  const catalog = new Map(registry.listAll().map((c) => [c.id, c]));

  const invoices = db
    .get()
    .prepare(
      `SELECT id, connector_id, filename, account_id, issued_on, fetched_at, size_bytes
         FROM invoices WHERE user_id = ?
        ORDER BY fetched_at DESC, id DESC`
    )
    .all(req.user.id)
    .map((row) => ({
      ...row,
      connectorName: catalog.get(row.connector_id)?.name || row.connector_id,
      color: catalog.get(row.connector_id)?.color || '#63666e',
      letters: catalog.get(row.connector_id)?.letters || '?',
      logo: catalog.get(row.connector_id)?.logo || null,
    }));

  res.json({ invoices });
});

/**
 * Téléchargement d'une facture.
 *
 * Isolation applicative : le montage NFS est en all_squash (tous les fichiers
 * appartiennent au même compte Unix), donc rien ne peut reposer sur les
 * permissions du système de fichiers. La propriété est vérifiée ICI, par
 * `user_id`, et le chemin est reconstruit par le serveur — un identifiant
 * deviné renvoie 404, sans révéler si la facture existe.
 */
router.get(
  '/me/invoices/:invoiceId/file',
  asyncHandler(async (req, res) => {
    const invoice = db
      .get()
      .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
      .get(Number(req.params.invoiceId), req.user.id);

    if (!invoice) return res.status(404).json({ error: 'Document introuvable.' });

    const file = destinations.invoicePath(invoice, req.user.username);
    if (!file || !fs.existsSync(file)) {
      return res.status(404).json({
        error: 'Le fichier n\'est plus présent sur le stockage — relancez une récupération.',
      });
    }

    res.download(file, invoice.filename);
  })
);

/**
 * « Renvoyer » : recopie une facture vers les destinations où elle manque,
 * **sans repasser par le fournisseur**.
 *
 * Le PDF est relu depuis le stockage local — la copie de référence, obligatoire — puis
 * redéposé sur les seules destinations autorisées dont l'état n'est pas « ok ».
 * Aucun scraping, aucune reconnexion au portail : c'est un simple transfert
 * de fichier, qui peut donc être relancé sans risque.
 */
router.post(
  '/me/invoices/:invoiceId/resend',
  asyncHandler(async (req, res) => {
    const invoice = db
      .get()
      .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
      .get(Number(req.params.invoiceId), req.user.id);

    if (!invoice) return res.status(404).json({ error: 'Document introuvable.' });

    const enabled = destinations.activeDestinations();
    const missing = invoicesLib.missingDestinations(invoice.destinations, enabled);
    if (!missing.length) {
      return res.json({
        ok: true,
        copied: [],
        message: 'Ce document est déjà présent sur toutes les destinations activées.',
      });
    }

    const source = destinations.invoicePath(invoice, req.user.username);
    if (!source || !fs.existsSync(source)) {
      return res.status(409).json({
        error:
          'Le fichier n\'est plus lisible sur le stockage local : un renvoi est impossible sans le ' +
          'récupérer à nouveau chez le fournisseur. Lancez une synchronisation du connecteur.',
      });
    }

    const connectorName = registry.has(invoice.connector_id)
      ? registry.manifest(invoice.connector_id).name
      : invoice.connector_id;

    const results = await destinations.copyToDestinations({
      destinationIds: missing,
      userId: req.user.id,
      username: req.user.username,
      target: {
        username: req.user.username,
        connectorName,
        accountId: invoice.account_id,
        issuedOn: invoice.issued_on,
        filename: invoice.filename,
        buffer: fs.readFileSync(source),
        // Le miroir copie le rangement RÉEL de la copie de référence (lot 38).
        cheminRelatif: destinations.cheminRelatifDepuisLocal(source),
      },
    });

    invoicesLib.saveDestinations(
      invoice.id,
      invoicesLib.mergeOutcomes(invoice.destinations, results)
    );

    const succeeded = Object.entries(results).filter(([, r]) => r.ok).map(([id]) => id);
    const failed = Object.entries(results).filter(([, r]) => !r.ok);

    res.json({
      ok: failed.length === 0,
      copied: succeeded,
      message: failed.length
        ? `Renvoi partiel — ${failed.map(([id, r]) => `${id} : ${r.message}`).join(' ; ')}`
        : `Document recopié sur ${succeeded.length} destination(s).`,
    });
  })
);

// ===========================================================================
// Administration des applications (page « Applications » des paramètres)
// ===========================================================================

const adminRouter = express.Router();
// La planification a sa propre permission : les routes /schedules la vérifient
// une seconde fois, plus finement.
adminRouter.use(requirePermission('apps.manage'));

/** Catalogue complet, y compris les candidatures en attente de test. */
adminRouter.get('/', (req, res) => {
  const installCounts = new Map(
    db
      .get()
      .prepare('SELECT connector_id, COUNT(*) AS n FROM connector_installs GROUP BY connector_id')
      .all()
      .map((r) => [r.connector_id, r.n])
  );

  const connectors = registry.listAll().map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    letters: c.letters,
    category: c.category,
    categoryLabel: c.categoryLabel,
    implementation: c.implementation,
    description: c.description,
    // Annoncé, pas branché : ce catalogue est le seul écran, avec le Store, où
    // un service annoncé a le droit d'apparaître (lot 11, §2.3).
    planned: !!c.planned,
    // Réservée à cet écran : la méthode d'accès, les particularités du portail,
    // la date de validation du parcours. L'utilisateur n'en reçoit jamais rien
    // (voir manifest-schema.publicView).
    technicalNote: c.technicalNote || '',
    logo: c.logo || null,
    site: c.site,
    maintenance: c.maintenance,
    allowedUsers: c.allowedUsers,
    catalogStatus: c.catalogStatus,
    publishedAt: c.publishedAt,
    installCount: installCounts.get(c.id) || 0,
    // « Active » : réellement utilisée par au moins un compte, OU mise à
    // disposition explicitement dans le Store par un administrateur. Les
    // connecteurs simplement livrés avec crabe ne le sont pas — c'est ce qui
    // permet au filtre de dégager la vue quand un seul est utilisé.
    active: (installCounts.get(c.id) || 0) > 0 || (!!c.publishedAt && c.catalogStatus === 'available'),
    fields: c.fields.map(({ key, label, type }) => ({ key, label, type })),
  }));

  res.json({
    connectors,
    activeCount: connectors.filter((c) => c.active).length,
    pendingCount: connectors.filter((c) => c.catalogStatus === 'pending').length,
    plannedCount: connectors.filter((c) => c.planned).length,
    // Liste minimale des comptes, pour la modale « Gérer l'accès » : un rôle
    // qui gère les applications n'a pas besoin de la permission utilisateurs.
    users: db
      .get()
      .prepare('SELECT id, username, role FROM users ORDER BY username')
      .all()
      .map((u) => ({ id: u.id, username: u.username, role: u.role })),
    categories: Object.entries(require('../connectors/manifest-schema').CATEGORIES).map(
      ([id, label]) => ({ id, label })
    ),
    loadErrors: registry.errors,
  });
});

// ---------------------------------------------------------------------------
// Logos (Paramètres → Applications → Logos)
//
// Aucune récupération automatique nulle part : ni au démarrage, ni à
// l'installation d'un connecteur, ni à l'affichage d'un écran. Ces quatre
// routes sont les SEULES qui sortent vers un fournisseur pour un logo, et
// chacune exige une action explicite d'un administrateur.
// ---------------------------------------------------------------------------

/** La liste, avec l'état de chaque logo et sa date de récupération. */
adminRouter.get('/logos', (req, res) => {
  res.json({
    // Connecteurs ET destinations de stockage : même mécanisme, même écran.
    // Le `kind` sert à les regrouper à l'affichage, rien de plus — une
    // destination sans site (le stockage local) se comporte exactement comme un
    // connecteur sans site : bouton « Récupérer » grisé, avec sa raison.
    connectors: logos.sujets().map((c) => {
      const ligne = logos.lire(c.id);
      // Pourquoi ce logo manque, quand il manque. Sans cette raison, l'écran
      // annonce « 6 manquants » et laisse chercher.
      const echec = logos.dernierEchec(c.id);
      return {
        id: c.id,
        kind: c.kind,
        name: c.name,
        color: c.color,
        letters: c.letters,
        site: c.site || '',
        // À défaut de logo enregistré, l'icône interne du stockage local : elle
        // s'affiche, mais elle ne vient de nulle part et ne s'écrase pas.
        logo: logos.publicUrl(c.id) || c.interne || null,
        logoInterne: !logos.publicUrl(c.id) && !!c.interne,
        // « manual » ne sera jamais écrasé par une resynchronisation : c'est la
        // seule distinction qui change un comportement, elle doit se voir.
        // « internal » désigne l'icône livrée avec crabe.
        source: ligne?.source || (c.interne ? 'internal' : null),
        origin: ligne?.origin || null,
        bytes: ligne?.bytes || 0,
        width: ligne?.width || null,
        height: ligne?.height || null,
        fetchedAt: ligne?.fetched_at || null,
        lastError: echec?.reason || null,
        lastErrorAt: echec?.at || null,
      };
    }),
    // Ce que la cascade s'autorise, dit une fois plutôt que répété à l'écran.
    limits: {
      maxBytes: logos.TAILLE_MAX,
      minSide: logos.COTE_MIN,
      maxSide: logos.COTE_MAX,
      timeoutMs: logos.DELAI_MS,
    },
  });
});

/**
 * Récupère le logo d'UN connecteur.
 *
 * La progression d'une récupération groupée (« 3 sur 13… ») est bâtie par
 * l'interface, qui appelle cette route connecteur par connecteur. C'est plus
 * simple qu'un flux d'événements, ça donne une raison lisible par échec, et ça
 * permet d'arrêter net.
 */
adminRouter.post(
  '/:id/logo',
  asyncHandler(async (req, res) => {
    // Un sujet, pas un connecteur : les destinations de stockage portent un
    // logo au même titre, sous un identifiant préfixé (connectors/logos.js).
    const sujet = logos.sujet(req.params.id);
    if (!sujet) return res.status(404).json({ error: 'Service inconnu.' });

    const existant = logos.lire(req.params.id);
    if (existant?.source === 'manual') {
      return res.status(409).json({
        ok: false,
        skipped: true,
        error:
          'Ce logo a été envoyé à la main : une récupération automatique ne l\'écrase pas. '
          + 'Supprimez-le d\'abord si vous voulez repartir du site du fournisseur.',
      });
    }
    if (existant && !req.body?.force) {
      return res.json({ ok: true, skipped: true, message: 'Logo déjà présent.' });
    }

    const resultat = await logos.recupererPour(sujet);

    // Échec silencieux et journalisé : l'administrateur voit le compte rendu,
    // et le détail reste dans le journal pour qui veut creuser.
    if (!resultat.ok) {
      applog.warn(
        'logos',
        `Logo de ${sujet.name} non récupéré — ${resultat.raison}`
          + (resultat.details?.length ? ` (${resultat.details.join(' ; ')})` : '')
      );
      // Gardée en base : c'est elle qui s'affichera au survol du liseré rouge,
      // plutôt que de forcer une nouvelle tentative pour relire la raison.
      logos.noterEchec(req.params.id, resultat.raison);
      return res.json({ ok: false, message: resultat.raison });
    }

    logos.oublierEchec(req.params.id);
    applog.admin(req, `Logo de ${sujet.name} récupéré depuis ${resultat.origin}.`);
    res.json({ ok: true, logo: logos.publicUrl(req.params.id), origin: resultat.origin });
  })
);

/**
 * Envoi manuel d'une image.
 *
 * Elle prime sur toute récupération automatique et n'est jamais écrasée par une
 * resynchronisation. Le contrôle est le MÊME que pour une image récupérée —
 * format, poids, dimensions — parce qu'un fichier choisi à la main peut aussi
 * être une bannière de 3 Mo.
 */
adminRouter.put('/:id/logo', (req, res) => {
  const sujet = logos.sujet(req.params.id);
  if (!sujet) return res.status(404).json({ error: 'Service inconnu.' });

  const buffer = logos.depuisDataUrl(req.body?.dataUrl);
  if (!buffer) {
    return res.status(400).json({ error: 'Aucune image reçue. Choisissez un fichier image.' });
  }

  const resultat = logos.enregistrerManuel(req.params.id, buffer);
  if (!resultat.ok) {
    return res.status(400).json({ error: `Cette image n'a pas été acceptée : ${resultat.raison}.` });
  }

  applog.admin(req, `Logo de ${sujet.name} envoyé à la main.`);
  res.json({ ok: true, logo: logos.publicUrl(req.params.id) });
});

/** Supprime un logo : la pastille à initiales reprend sa place. */
adminRouter.delete('/:id/logo', (req, res) => {
  const sujet = logos.sujet(req.params.id);
  if (!sujet) return res.status(404).json({ error: 'Service inconnu.' });
  const retire = logos.supprimer(req.params.id);
  if (retire) applog.admin(req, `Logo de ${sujet.name} supprimé.`);
  res.json({ ok: true, removed: retire });
});

// ---------------------------------------------------------------------------
// Dépannage : déposer une connexion enregistrée (Paramètres → Applications)
//
// ─── Pourquoi c'est ici, et plus dans la fiche de l'utilisateur ──────────────
//
// Jusqu'au lot 8, la fiche d'un connecteur offrait, sous « Options avancées »,
// de déposer un fichier de session — avec la ligne de commande qui le produit.
// crabe s'adresse à des gens qui n'ont jamais ouvert un terminal : ce n'était
// pas une option de repli, c'était un mur.
//
// Le geste reste POSSIBLE, parce qu'il sauve les cas où le navigateur distant
// ne peut pas s'ouvrir (paquets manquants, mémoire insuffisante, portail qui
// refuse le navigateur embarqué). Mais c'est un outil d'administrateur, et il
// vit désormais là où vivent les outils d'administrateur.
//
// La permission est celle de la page : `apps.manage`, posée sur tout ce
// routeur. Un compte ordinaire n'atteint aucune de ces deux routes.
// ---------------------------------------------------------------------------

/** Le champ de connexion enregistrée d'un connecteur, ou `null`. */
function sessionFieldOf(connectorId) {
  return registry.manifest(connectorId).fields.find((f) => f.type === 'session') || null;
}

/** Comptes ayant installé ce connecteur, et l'état de leur connexion. */
adminRouter.get('/:id/sessions', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  if (refuseSiAnnonce(req, res, 'connecté')) return;

  const field = sessionFieldOf(req.params.id);
  if (!field) {
    return res.status(400).json({
      error: 'Ce service ne se connecte pas par session enregistrée : il n\'y a rien à déposer.',
    });
  }

  const rows = db
    .get()
    .prepare(
      `SELECT i.user_id, u.username FROM connector_installs i
         JOIN users u ON u.id = i.user_id
        WHERE i.connector_id = ? ORDER BY u.username`
    )
    .all(req.params.id);

  res.json({
    connector: { id: req.params.id, name: registry.manifest(req.params.id).name },
    field: { key: field.key, label: field.label, accept: field.accept || 'application/json,.json' },
    // Jamais le contenu d'une session : sa date, son échéance, son état. C'est
    // exactement ce que voit l'utilisateur sur sa propre fiche.
    accounts: rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      session: registry.configSummary(row.user_id, req.params.id)?.sessions?.[field.key] || null,
    })),
  });
});

/**
 * Dépose une connexion enregistrée pour un compte donné.
 *
 * Le contenu passe par le MÊME contrôle que celui de l'utilisateur
 * (`registry.saveConfig`) : JSON bien formé, cookies présents, au moins un
 * encore valable — et il est chiffré au repos de la même façon. Un refus
 * remonte en 400 avec sa raison.
 */
adminRouter.put(
  '/:id/sessions/:userId',
  asyncHandler(async (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
    if (refuseSiAnnonce(req, res, 'connecté')) return;

    const field = sessionFieldOf(req.params.id);
    if (!field) {
      return res.status(400).json({
        error: 'Ce service ne se connecte pas par session enregistrée : il n\'y a rien à déposer.',
      });
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || !registry.getInstall(userId, req.params.id)) {
      return res.status(404).json({ error: 'Ce compte n\'a pas installé ce service.' });
    }

    const contenu = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
    if (!contenu) return res.status(400).json({ error: 'Aucun contenu reçu.' });

    registry.saveConfig(userId, req.params.id, { [field.key]: contenu });
    // Une connexion déposée pour quelqu'un d'autre est un acte d'administration
    // : elle est tracée, avec qui et pour qui — jamais avec son contenu.
    const username = db.get().prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username;
    applog.admin(
      req,
      `Connexion ${registry.manifest(req.params.id).name} déposée à la main pour ${username || userId}.`
    );

    res.json({
      ok: true,
      session: registry.configSummary(userId, req.params.id)?.sessions?.[field.key] || null,
    });
  })
);

// ---------------------------------------------------------------------------
// Diagnostic (Paramètres → Applications → Diagnostic)
//
// ─── Pourquoi ces trois routes sont ICI ──────────────────────────────────────
//
// Elles sont montées sur `adminRouter`, donc derrière `apps.manage`. Un compte
// ordinaire ne les atteint pas, ne voit pas l'onglet, et ne sait même pas qu'il
// existe des diagnostics — c'est la contrainte explicite du lot 14, §4.
//
// Ce que ces archives contiennent est décrit dans server/diagnostics.js : du
// HTML dont les mots de passe sont masqués, une capture d'écran, la liste des
// liens et un contexte qui ne porte que les NOMS des cookies. Rien de tout ça
// n'est un secret — c'est ce qui les rend transmissibles sans relecture.
// ---------------------------------------------------------------------------

/** Les diagnostics enregistrés pour un connecteur, du plus récent au plus ancien. */
adminRouter.get('/:id/diagnostics', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });

  res.json({
    connector: { id: req.params.id, name: registry.manifest(req.params.id).name },
    diagnostics: diagnostics.lister(req.params.id),
    limits: { maxParConnecteur: diagnostics.MAX_PAR_CONNECTEUR, maxJours: diagnostics.MAX_JOURS },
    // Dit une fois, plutôt que répété sur chaque ligne à l'écran.
    fichiers: diagnostics.FICHIERS,
  });
});

/**
 * L'archive `.zip` d'un diagnostic.
 *
 * Assemblée en mémoire et envoyée directement : quatre fichiers de quelques
 * centaines de kilo-octets ne justifient pas un fichier temporaire à nettoyer.
 */
adminRouter.get(
  '/:id/diagnostics/:diagId/archive',
  asyncHandler(async (req, res) => {
    const dossier = diagnostics.chemin(req.params.id, req.params.diagId);
    if (!dossier) return res.status(404).json({ error: 'Diagnostic introuvable.' });

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.type('application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="diagnostic-${req.params.id}-${req.params.diagId}.zip"`
    );

    archive.on('error', () => res.destroy());
    archive.pipe(res);

    for (const nom of diagnostics.FICHIERS) {
      const fichier = require('node:path').join(dossier, nom);
      if (fs.existsSync(fichier)) archive.file(fichier, { name: nom });
    }
    archive.append(
      [
        'Diagnostic crabe',
        '',
        `Service    : ${registry.has(req.params.id) ? registry.manifest(req.params.id).name : req.params.id}`,
        `Enregistré : ${diagnostics.instantDe(req.params.diagId) || '(inconnu)'}`,
        '',
        'contexte.txt  URL finale, étape atteinte, erreur interne, NOMS des cookies',
        'page.html     la page au moment de l\'échec, mots de passe et jetons masqués',
        'liens.txt     tous les liens de la page, un par ligne',
        'page.png      capture d\'écran pleine page',
        '',
        'Cette archive ne contient AUCUN mot de passe, AUCUNE valeur de cookie et',
        'AUCUN jeton : elle peut être transmise telle quelle.',
        '',
      ].join('\n'),
      { name: 'LISEZ-MOI.txt' }
    );

    await archive.finalize();
    applog.admin(req, `Diagnostic ${req.params.id}/${req.params.diagId} téléchargé.`);
  })
);

/** Efface tous les diagnostics d'un connecteur. */
adminRouter.delete('/:id/diagnostics', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  const efface = diagnostics.effacerTout(req.params.id);
  if (efface) applog.admin(req, `${efface} diagnostic(s) de ${req.params.id} effacé(s).`);
  res.json({ ok: true, removed: efface });
});

/**
 * Refuse une action d'administration sur un service seulement ANNONCÉ.
 *
 * Même raison que côté utilisateur : il n'y a pas de code derrière. Tester,
 * lancer ou déposer une connexion pour un service annoncé n'échouerait pas
 * proprement — `registry.get()` rendrait un module `null`, et le message
 * porterait sur une variable plutôt que sur ce qui s'est passé.
 *
 * @returns {boolean} vrai si la réponse a déjà été envoyée
 */
function refuseSiAnnonce(req, res, geste) {
  if (!registry.isPlanned(req.params.id)) return false;
  res.status(409).json({
    ok: false,
    error:
      `« ${registry.manifest(req.params.id).name} » est un service annoncé : il n'a pas encore `
      + `de connecteur, il ne peut donc pas être ${geste}.`,
  });
  return true;
}

/**
 * Test administrateur, avant mise à disposition dans le Store.
 * Sans identifiants fournis, le test se fait avec la configuration d'un
 * utilisateur qui a déjà configuré le connecteur ; sinon, il vérifie
 * seulement que le connecteur se charge et répond.
 */
adminRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    if (!registry.has(req.params.id)) {
      return res.status(404).json({ error: 'Connecteur inconnu.' });
    }
    if (refuseSiAnnonce(req, res, 'testé')) return;

    const draft = req.body?.config;
    if (draft && Object.keys(draft).length) {
      return res.json(await registry.test(req.params.id, draft, { userId: req.user.id }));
    }

    const sample = db
      .get()
      .prepare(
        `SELECT user_id FROM connector_installs
          WHERE connector_id = ? AND config_encrypted IS NOT NULL LIMIT 1`
      )
      .get(req.params.id);

    if (!sample) {
      return res.json({
        ok: false,
        message:
          'Aucune configuration disponible pour ce connecteur : fournissez des ' +
          'identifiants de test, ou attendez qu\'un utilisateur le configure.',
      });
    }

    res.json(await registry.testForUser(sample.user_id, req.params.id));
  })
);

adminRouter.put('/:id/category', (req, res) => {
  const { CATEGORIES } = require('../connectors/manifest-schema');
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  if (!CATEGORIES[req.body?.category]) {
    return res.status(400).json({ error: 'Catégorie inconnue.' });
  }
  db.get()
    .prepare(
      "UPDATE connector_catalog SET category = ?, updated_at = datetime('now') WHERE connector_id = ?"
    )
    .run(req.body.category, req.params.id);
  res.json({ ok: true, category: req.body.category, label: CATEGORIES[req.body.category] });
});

adminRouter.put('/:id/maintenance', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  db.get()
    .prepare(
      "UPDATE connector_catalog SET maintenance = ?, updated_at = datetime('now') WHERE connector_id = ?"
    )
    .run(req.body?.maintenance ? 1 : 0, req.params.id);
  res.json({ ok: true, maintenance: !!req.body?.maintenance });
});

/** Restreint l'accès à une liste d'utilisateurs, ou l'ouvre à tous. */
adminRouter.put('/:id/access', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });

  const value = req.body?.allowedUsers;
  let stored;
  if (value === 'all' || value === undefined || value === null) {
    stored = '"all"';
  } else if (Array.isArray(value)) {
    const ids = value.map(Number).filter(Number.isInteger);
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
    stored = ids.length >= total ? '"all"' : JSON.stringify(ids);
  } else {
    return res.status(400).json({ error: 'Format d\'accès invalide.' });
  }

  db.get()
    .prepare(
      "UPDATE connector_catalog SET allowed_users = ?, updated_at = datetime('now') WHERE connector_id = ?"
    )
    .run(stored, req.params.id);

  res.json({ ok: true, allowedUsers: JSON.parse(stored) });
});

/**
 * Approuve une candidature : le connecteur devient visible dans le Store.
 *
 * `published_at` marque la mise à disposition EXPLICITE, par opposition aux
 * connecteurs livrés « disponibles » par défaut avec crabe, que personne n'a
 * choisis. C'est cette distinction que lit le filtre « masquer les
 * applications non actives ».
 */
adminRouter.post('/:id/approve', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  db.get()
    .prepare(
      `UPDATE connector_catalog
          SET status = 'available', published_at = datetime('now'), updated_at = datetime('now')
        WHERE connector_id = ?`
    )
    .run(req.params.id);
  res.json({ ok: true, status: 'available' });
});

/**
 * Rejette une candidature : le connecteur reste sur le disque mais n'est
 * proposé à personne, et les installations existantes sont retirées.
 */
adminRouter.post('/:id/reject', (req, res) => {
  if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
  db.transaction(() => {
    db.get()
      .prepare(
        `UPDATE connector_catalog
            SET status = 'pending', maintenance = 1, published_at = NULL,
                updated_at = datetime('now')
          WHERE connector_id = ?`
      )
      .run(req.params.id);
    db.get().prepare('DELETE FROM connector_installs WHERE connector_id = ?').run(req.params.id);
    schedules.removeForConnector(req.params.id);
  })();
  scheduler.reload();
  res.json({ ok: true, status: 'pending' });
});

/** Déclenche une récupération pour tous les utilisateurs d'un connecteur. */
adminRouter.post(
  '/:id/run-all',
  asyncHandler(async (req, res) => {
    if (!registry.has(req.params.id)) return res.status(404).json({ error: 'Connecteur inconnu.' });
    if (refuseSiAnnonce(req, res, 'exécuté')) return;
    const results = await scheduler.runForAllUsers(req.params.id, 'manual');
    applog.admin(
      req,
      `Récupération lancée à la main pour ${registry.manifest(req.params.id).name} — ` +
        `${results.filter((r) => r.ok).length}/${results.length} compte(s) en succès.`
    );
    res.json({
      ok: true,
      runs: results.length,
      succeeded: results.filter((r) => r.ok).length,
      results,
    });
  })
);

// ===========================================================================
// Automatisation (page « Automatisation » des paramètres)
//
// Routeur séparé : la planification a sa propre permission, elle ne doit pas
// exiger en plus celle de gestion des applications.
//
// Depuis le lot 3, une planification porte sur un COUPLE (utilisateur,
// connecteur) : son identifiant est « <userId>:<connectorId> ».
// ===========================================================================

const scheduleRouter = express.Router();
scheduleRouter.use(requirePermission('schedules.manage'));

/**
 * Segment d'URL vide : `PUT /api/admin/schedules//`.
 *
 * Express fait tomber cette forme sur la route d'action groupée `PUT /`, qui
 * répondait « Aucune planification sélectionnée » — message trompeur pour ce
 * qui est en réalité une URL malformée. Le lot 3 en a émis en rafale depuis
 * l'écran Automatisation (identifiants reconstruits depuis le DOM, corrigé
 * dans web/admin.js:scheduleTarget).
 *
 * Ici : réponse immédiate, explicite et bon marché — aucune requête en base,
 * et une seule ligne de journal par minute même si le client s'entête. Se
 * faire marteler ne doit ni remplir le journal, ni coûter de l'I/O.
 */
let lastEmptySegmentAt = 0;
scheduleRouter.use((req, res, next) => {
  // `req.path` ne sert à rien ici : Express a déjà absorbé la barre oblique en
  // trop en retirant le préfixe de montage, et vaut « / ». Seule l'URL
  // d'origine porte encore la trace du segment vide.
  if (!req.originalUrl.split('?')[0].includes('//')) return next();

  const now = Date.now();
  if (now - lastEmptySegmentAt > 60_000) {
    lastEmptySegmentAt = now;
    applog.warn(
      'scheduler',
      `Requête ${req.method} ${req.originalUrl} ignorée : identifiant de compte ou de connecteur vide.`
    );
  }
  res.status(400).json({
    error: 'Identifiants de planification manquants (compte et connecteur attendus).',
  });
});

/** « 3:free » → { userId: 3, connectorId: 'free' }, ou null si inexploitable. */
function parseTarget(value) {
  if (value && typeof value === 'object') {
    const userId = Number(value.userId);
    return Number.isInteger(userId) && value.connectorId
      ? { userId, connectorId: String(value.connectorId) }
      : null;
  }
  const text = String(value || '');
  const separator = text.indexOf(':');
  if (separator <= 0) return null;
  const userId = Number(text.slice(0, separator));
  const connectorId = text.slice(separator + 1);
  return Number.isInteger(userId) && connectorId ? { userId, connectorId } : null;
}

/** Cibles valides d'une action groupée : couples réellement installés. */
function readTargets(body) {
  const raw = Array.isArray(body?.targets) ? body.targets : [];
  const seen = new Set();
  const targets = [];
  for (const value of raw) {
    const target = parseTarget(value);
    if (!target) continue;
    const key = `${target.userId}:${target.connectorId}`;
    if (seen.has(key)) continue;
    if (!registry.has(target.connectorId)) continue;
    if (!registry.getInstall(target.userId, target.connectorId)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

scheduleRouter.get('/', (req, res) => {
  res.json({
    schedules: scheduler.listSchedules(),
    disabled: require('../config').config.schedulerDisabled,
    timezone: require('../settings').timezone(),
    activeTasks: scheduler.activeTasks,
    frequencies: schedules.FREQUENCIES.map((id) => ({
      id,
      label: schedules.FREQUENCY_LABELS[id],
    })),
    weekdays: schedules.WEEKDAY_LABELS.map((label, id) => ({ id, label })),
  });
});

scheduleRouter.put(
  '/:userId/:connectorId',
  asyncHandler(async (req, res) => {
    // `Number('')` vaut 0, qui est bien un entier : l'identifiant vide serait
    // passé sans ce contrôle de forme explicite.
    const raw = String(req.params.userId || '').trim();
    const userId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Compte invalide.' });
    }
    if (!String(req.params.connectorId || '').trim()) {
      return res.status(400).json({ error: 'Connecteur manquant.' });
    }
    if (!registry.has(req.params.connectorId)) {
      return res.status(404).json({ error: 'Connecteur inconnu.' });
    }

    const schedule = scheduler.saveSchedule(userId, req.params.connectorId, req.body || {});
    applog.admin(
      req,
      `Planification de ${schedule.name} pour ${schedule.username} : ${schedule.rhythm}.`
    );
    res.json({ ok: true, schedule });
  })
);

/**
 * Actions groupées sur une sélection : activer, désactiver, changer la
 * fréquence, le jour ou l'heure — sur plusieurs couples d'un coup.
 */
scheduleRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const targets = readTargets(req.body);
    if (!targets.length) return res.status(400).json({ error: 'Aucune planification sélectionnée.' });

    const patch = {};
    for (const key of ['frequency', 'timeOfDay', 'dayOfWeek', 'dayOfMonth']) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (req.body?.lastDayOfMonth !== undefined) patch.lastDayOfMonth = !!req.body.lastDayOfMonth;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Aucune modification fournie.' });
    }

    // Les champs non fournis gardent leur valeur : une action groupée
    // « désactiver » ne doit pas réécrire les fréquences au passage.
    const updated = targets.map((t) => scheduler.saveSchedule(t.userId, t.connectorId, patch));

    applog.admin(
      req,
      `Action groupée sur ${targets.length} planification(s) : ${Object.keys(patch).join(', ')}.`
    );
    res.json({ ok: true, schedules: updated });
  })
);

/** « Lancer maintenant » sur une sélection de couples. */
scheduleRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const targets = readTargets(req.body);
    if (!targets.length) return res.status(400).json({ error: 'Aucune planification sélectionnée.' });

    const results = [];
    for (const { userId, connectorId } of targets) {
      try {
        const run = await scheduler.runForUser(userId, connectorId, 'manual');
        results.push({ userId, connectorId, ...run });
      } catch (err) {
        // Verrou déjà pris : ce n'est pas une erreur d'exécution, on le dit.
        results.push({
          userId,
          connectorId,
          ok: false,
          count: 0,
          message: err.message,
          skipped: !!err.alreadyRunning,
        });
      }
    }

    applog.admin(req, `Lancement manuel groupé de ${targets.length} planification(s).`);
    res.json({
      ok: true,
      results,
      runs: results.length,
      succeeded: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
    });
  })
);

module.exports = { router, adminRouter, scheduleRouter };
