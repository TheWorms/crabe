'use strict';

/**
 * Réponses d'API servant de fixtures aux tests de rendu du front.
 *
 * Leur forme doit rester celle des vraies routes : `test/admin-routes.test.js`
 * la compare aux réponses d'un serveur réel, sinon un écran pourrait « passer »
 * ici tout en cassant en production.
 */

const FIXTURES = {
  '/system/settings': {
    settings: {
      timezone: 'Europe/Paris',
      timeFormat: '24',
      dateFormat: 'DD/MM/YYYY',
      gravatarEnabled: false,
    },
    timeFormats: [{ id: '24', label: '24 h' }],
    dateFormats: [{ id: 'DD/MM/YYYY', label: 'JJ/MM/AAAA' }],
    timezones: ['Europe/Paris'],
    gravatarNotice: 'Activer Gravatar envoie une empreinte à un service tiers.',
  },

  '/system/security': {
    twoFactorMode: 'disabled',
    twoFactorModes: [
      { id: 'disabled', label: 'Désactivée', help: 'Personne ne peut l\'activer.' },
      { id: 'allowed', label: 'Autorisée', help: 'Chacun décide.' },
      { id: 'required', label: 'Exigée', help: 'Invitation à la connexion.' },
    ],
    passwordComplexity: 'medium',
    passwordLevels: [
      { id: 'low', label: 'Faible' },
      { id: 'medium', label: 'Moyenne' },
    ],
    logRetentionDays: 365,
    retentionOptions: [{ days: 365, label: '1 an' }],
    // Lot 12 — la profondeur de DOCUMENTS conservée, à ne pas confondre avec
    // celle des journaux ci-dessus. `floor` non nul = le nettoyage ne
    // s'applique qu'aux documents à venir, ceux d'avant sont protégés.
    documentRetention: {
      months: 12,
      label: '1 an',
      options: [
        { months: 3, label: '3 mois' },
        { months: 6, label: '6 mois' },
        { months: 12, label: '1 an' },
        { months: 24, label: '2 ans' },
        { months: 0, label: 'Tout garder' },
      ],
      floor: '2026-08-11T09:00:00.000Z',
      beyond: 143,
      due: 0,
    },
    gravatarEnabled: false,
    gravatarNotice: 'Empreinte envoyée à gravatar.com.',
    smtp: { host: '', port: null, user: '', from: '', fromName: '', secure: 'starttls', configured: false, ready: false },
  },

  '/system/smtp': {
    smtp: {
      host: 'smtp.exemple.fr',
      port: 587,
      user: 'crabe',
      from: 'crabe@exemple.fr',
      fromName: 'crabe',
      secure: 'starttls',
      configured: true,
      ready: true,
    },
    secureModes: [
      { id: 'none', label: 'Aucun', help: 'Connexion en clair.' },
      { id: 'starttls', label: 'STARTTLS', help: 'Passage en TLS après connexion.' },
      { id: 'tls', label: 'TLS', help: 'TLS dès la connexion.' },
    ],
    templates: [
      {
        key: 'email-change-confirm',
        label: 'Confirmation de changement d\'adresse',
        description: 'Envoyé à la nouvelle adresse.',
        variables: [
          { name: 'utilisateur', help: 'Identifiant', sample: 'camille' },
          { name: 'lien', help: 'Lien de confirmation', sample: 'http://crabe.local/x' },
        ],
        subject: 'crabe — confirmez votre adresse',
        body: 'Bonjour {{utilisateur}},\n{{lien}}\n',
        customized: false,
        defaults: { subject: 'crabe — confirmez votre adresse', body: 'Bonjour {{utilisateur}},\n{{lien}}\n' },
      },
      {
        key: 'connector-failure',
        label: 'Échec de synchronisation',
        description: 'Envoyé après un échec de récupération.',
        variables: [{ name: 'connecteur', help: 'Nom du connecteur', sample: 'Free Internet' }],
        subject: 'crabe — échec : {{connecteur}}',
        body: '{{connecteur}} a échoué.',
        customized: true,
        defaults: { subject: 'crabe — échec : {{connecteur}}', body: '{{connecteur}} a échoué.' },
      },
    ],
  },

  '/admin/destinations': {
    // ⚠ Lot 25 — cette fixture décrit un modèle qui a changé de nature. Il n'y
    // a plus six destinations déclarées dans le code : il y a le stockage local, et les
    // clouds que l'utilisateur a créés, avec un identifiant tiré au sort et le
    // nom qu'il leur a donné. Deux espaces chez le même fournisseur sont deux
    // lignes — c'est le cas ici, et c'était impossible avant.
    // ⚠ Lot 28 — UNE seule liste, dans l'ordre où elle s'affiche : les quatre
    // vedettes habillées, puis les types que le rclone du serveur sait gérer,
    // par ordre alphabétique du nom affiché. Il y avait ici une carte « Autre
    // stockage » qui menait à une SECONDE liste, laquelle reproposait pCloud
    // sous son nom technique — le doublon que ce lot supprime. Un fournisseur
    // vedette ne figure donc jamais dans la seconde partie.
    providers: [
      { id: 'kdrive', provider: 'kdrive', type: null, vedette: true, label: 'kDrive',
        resume: 'Le stockage d\'Infomaniak, hébergé en Suisse.',
        letter: 'k', color: '#0098ff', icone: null, site: 'www.infomaniak.com',
        backend: 'webdav', disponible: true, indisponibleParce: null },
      { id: 'mega', provider: 'mega', type: null, vedette: true, label: 'MEGA',
        resume: 'Stockage néo-zélandais, 20 Go offerts.',
        letter: 'M', color: '#d9272e', icone: null, site: 'mega.io',
        backend: 'mega', disponible: false,
        indisponibleParce: 'Le logiciel rclone installé sur ce serveur ne sait pas parler à MEGA.' },
      { id: 'pcloud', provider: 'pcloud', type: null, vedette: true, label: 'pCloud',
        resume: 'Stockage en ligne suisse, avec offre à vie.',
        letter: 'p', color: '#1f8fd6', icone: null, site: 'www.pcloud.com',
        backend: 'pcloud', disponible: true, indisponibleParce: null },
      { id: 'proton', provider: 'proton', type: null, vedette: true, label: 'Proton Drive',
        resume: 'Le stockage chiffré de Proton.',
        letter: 'P', color: '#6c5ce7', icone: null, site: 'proton.me',
        backend: 'protondrive', disponible: false,
        indisponibleParce: 'Le logiciel rclone installé sur ce serveur ne sait pas parler à Proton Drive.' },
      { id: 'type:s3', provider: 'autre', type: 's3', vedette: false,
        label: 'Amazon S3 Compliant Storage Providers',
        resume: 'Amazon S3 Compliant Storage Providers including AWS, Ceph, Cloudflare',
        letter: 'A', color: '#63666e', icone: null, site: '',
        backend: 's3', disponible: true, indisponibleParce: null },
      { id: 'type:dropbox', provider: 'autre', type: 'dropbox', vedette: false, label: 'Dropbox',
        resume: '', letter: 'D', color: '#63666e', icone: null, site: '',
        backend: 'dropbox', disponible: true, indisponibleParce: null },
      { id: 'type:webdav', provider: 'autre', type: 'webdav', vedette: false, label: 'WebDAV',
        resume: 'webdav', letter: 'W', color: '#63666e', icone: null, site: '',
        backend: 'webdav', disponible: true, indisponibleParce: null },
    ],
    destinations: [
      {
        id: 'local',
        name: 'Stockage local',
        displayName: 'Stockage local',
        letter: 'S',
        color: '#5a6b52',
        logo: '/stockage-local.svg',
        logoInterne: true,
        required: true,
        enabled: true,
        path: '/mnt/local',
        protocol: 'nfs',
        configured: true,
        state: 'ok',
        mounted: true,
        usage: { bytes: 2048, files: 12, users: 2 },
        // Lot 10 : ce que la destination n'a pas encore reçu. Le stockage local est la
        // SOURCE des copies : rien n'est jamais en attente pour elle.
        pending: 0,
      },
      {
        // Un fournisseur dont le formulaire est écrit dans crabe (kDrive) :
        // les champs descendent avec la destination, avec leurs aides.
        id: 'cloud-1a2b3c4d',
        name: 'kDrive maison',
        displayName: 'kDrive maison',
        provider: 'kdrive',
        providerLabel: 'kDrive',
        letter: 'k',
        color: '#0098ff',
        logo: null,
        logoInterne: false,
        required: false,
        enabled: true,
        remoteName: 'crabe',
        basePath: 'crabe',
        configured: true,
        backend: 'webdav',
        typeLibre: false,
        type: 'webdav',
        champs: [
          { key: 'kdriveId', label: 'Numéro de votre kDrive', type: 'text', required: true, help: 'Lu dans l\'adresse de votre kDrive.' },
          { key: 'user', label: 'Adresse e-mail de votre compte Infomaniak', type: 'text', required: true, help: '' },
          { key: 'pass', label: 'Mot de passe d\'application', type: 'password', required: true, help: 'Ce n\'est PAS le mot de passe de votre compte.' },
        ],
        valeurs: { kdriveId: '123456', user: 'moi@exemple.fr' },
        createdAt: '2026-08-12 09:00:00',
        updatedAt: '2026-08-13 10:00:00',
        usage: { bytes: 1024, files: 6, users: 1 },
        pending: 6,
      },
      {
        // Le MÊME fournisseur, une seconde fois, pas encore rempli : c'est
        // exactement ce que le lot 25 rend possible.
        id: 'cloud-9f8e7d6c',
        name: 'pCloud boulot',
        displayName: 'pCloud boulot',
        provider: 'pcloud',
        providerLabel: 'pCloud',
        letter: 'p',
        color: '#1f8fd6',
        logo: '/api/connectors/logos/destination-cloud-9f8e7d6c.png?v=1',
        logoInterne: false,
        required: false,
        enabled: false,
        remoteName: 'crabe',
        basePath: 'crabe',
        configured: false,
        backend: 'pcloud',
        typeLibre: false,
        type: 'pcloud',
        // Aucun formulaire écrit dans crabe : les champs viennent d'rclone.
        champs: [
          { key: 'username', label: 'username', type: 'text', required: false, help: 'Your pcloud username.', avance: false },
          { key: 'password', label: 'password', type: 'password', required: false, help: 'Your pcloud password.', avance: false },
        ],
        valeurs: { username: '' },
        createdAt: '2026-08-13 11:00:00',
        updatedAt: '2026-08-13 11:00:00',
        usage: { bytes: 0, files: 0, users: 0 },
        pending: 12,
      },
      {
        // Le choix libre : aucun type retenu, donc aucun champ tant que
        // l'utilisateur n'a pas dit chez qui il va.
        id: 'cloud-5e4d3c2b',
        name: 'Mon serveur',
        displayName: 'Mon serveur',
        provider: 'autre',
        providerLabel: 'Autre stockage',
        letter: '+',
        color: '#63666e',
        logo: '/stockage-autre.svg',
        logoInterne: true,
        required: false,
        enabled: false,
        remoteName: 'crabe',
        basePath: 'crabe',
        configured: false,
        backend: null,
        typeLibre: true,
        type: '',
        champs: [],
        valeurs: {},
        createdAt: '2026-08-13 12:00:00',
        updatedAt: '2026-08-13 12:00:00',
        usage: { bytes: 0, files: 0, users: 0 },
        pending: 0,
      },
    ],
    summary: {
      totalBytes: 3072,
      destinationCount: 2,
      breakdown: [
        { id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52', bytes: 2048, files: 12, users: 2, enabled: true },
        { id: 'cloud-1a2b3c4d', name: 'kDrive maison', letter: 'k', color: '#0098ff', bytes: 1024, files: 6, users: 1, enabled: true },
        { id: 'cloud-9f8e7d6c', name: 'pCloud boulot', letter: 'p', color: '#1f8fd6', bytes: 0, files: 0, users: 0, enabled: false },
      ],
      files: 12,
      users: 2,
      uniqueBytes: 2048,
    },
    rcloneAvailable: false,
  },

  // Lot 24 — les types de stockage que le rclone du serveur sait utiliser.
  // Écrit ici tel que la route les rend : une liste triée, et l'aveu quand
  // rclone n'a pas répondu.
  '/admin/destinations/backends': {
    ok: true,
    erreur: null,
    types: [
      { name: 'dropbox', description: 'Dropbox' },
      { name: 's3', description: 'Amazon S3 Compliant Storage Providers' },
      { name: 'webdav', description: 'WebDAV' },
    ],
    type: null,
    champs: [],
  },

  '/admin/connectors': {
    connectors: [
      {
        id: 'free',
        name: 'Free Internet',
        color: '#c8102e',
        letters: 'FR',
        implementation: 'scraping',
        site: 'https://free.fr',
        category: 'telecom',
        catalogStatus: 'available',
        publishedAt: null,
        active: true,
        maintenance: false,
        allowedUsers: 'all',
        installCount: 3,
        // Lot 8 : une phrase pour l'utilisateur, le reste dans une note
        // réservée à cet écran — le serveur ne l'envoie nulle part ailleurs.
        description: 'Récupère automatiquement vos factures Freebox.',
        technicalNote:
          'Scraping de l\'espace abonné (identifiant + mot de passe, sans code SMS). '
          + 'Parcours validé contre un compte réel le 30/07/2026.',
      },
      {
        id: 'ovh',
        name: 'OVH',
        color: '#00a0af',
        letters: 'OV',
        implementation: 'api',
        site: '',
        category: 'hebergement',
        catalogStatus: 'pending',
        publishedAt: null,
        // Ni installée, ni mise à disposition : c'est ce que masque le filtre.
        active: false,
        maintenance: true,
        allowedUsers: [1, 2],
        installCount: 0,
        description: 'Récupère automatiquement vos factures OVHcloud.',
        technicalNote: '',
      },
      // Lot 11 — un service ANNONCÉ, tel que le catalogue d'administration le
      // reçoit : pas d'implémentation, aucune installation possible, et un
      // seul geste offert — décider à qui la fiche est montrée.
      {
        id: 'spotify',
        name: 'Spotify',
        color: '#6a3d9a',
        letters: 'SP',
        implementation: 'stub',
        planned: true,
        site: 'www.spotify.com',
        category: 'divertissement',
        catalogStatus: 'available',
        publishedAt: null,
        active: false,
        maintenance: false,
        allowedUsers: 'all',
        installCount: 0,
        description: 'Récupère automatiquement vos factures d\'abonnement Spotify.',
        technicalNote: '',
      },
    ],
    users: [{ id: 1, username: 'camille', role: 'admin' }],
    categories: [
      { id: 'telecom', label: 'Télécom' },
      { id: 'hebergement', label: 'Hébergement' },
      { id: 'divertissement', label: 'Divertissement' },
    ],
    pendingCount: 1,
    plannedCount: 1,
    activeCount: 1,
  },

  // Lot 9 — Applications → Dépannage. Le dépôt d'une connexion enregistrée a
  // quitté la fiche de l'utilisateur : c'est un outil d'administrateur, pour
  // les cas où le navigateur distant ne peut pas s'ouvrir.
  '/admin/connectors/free/sessions': {
    connector: { id: 'free', name: 'Free Internet' },
    field: { key: 'session', label: 'Connexion à Free', accept: 'application/json,.json' },
    accounts: [
      {
        userId: 1,
        username: 'camille',
        session: {
          savedAt: '2026-08-09T21:40:00.000Z',
          expiresAt: '2027-02-05T21:40:00.000Z',
          cookieCount: 7,
          expired: false,
        },
      },
      { userId: 2, username: 'nadia', session: null },
    ],
  },

  // Lot 8 — Applications → Logos. Trois états qui doivent tous se rendre :
  // un logo récupéré, un logo envoyé à la main (que rien n'écrase), et un
  // connecteur qui n'en a pas et garde sa pastille à initiales.
  '/admin/connectors/logos': {
    connectors: [
      {
        id: 'free', kind: 'connector', name: 'Free Internet', color: '#c8102e', letters: 'FR',
        site: 'free.fr', logo: '/api/connectors/logos/free.png?v=1754812800000',
        source: 'fetched', origin: 'https://free.fr/apple-touch-icon.png',
        bytes: 12_840, width: 180, height: 180, fetchedAt: '2026-08-10T08:00:00.000Z',
      },
      {
        id: 'free-mobile', kind: 'connector', name: 'Free Mobile', color: '#c8102e', letters: 'FM',
        site: 'mobile.free.fr', logo: '/api/connectors/logos/free-mobile.svg?v=1754816400000',
        source: 'manual', origin: null,
        bytes: 2_104, width: 96, height: 96, fetchedAt: '2026-08-10T09:00:00.000Z',
      },
      {
        id: 'ovh', kind: 'connector', name: 'OVH', color: '#00a0af', letters: 'OV',
        site: '', logo: null, source: null, origin: null,
        bytes: 0, width: null, height: null, fetchedAt: null,
      },
      // Lot 9 — les destinations de stockage sont des sujets de logo comme les
      // autres, sur le même écran. Le stockage local n'a pas de site : son icône est
      // interne, et rien n'est jamais récupéré pour elle.
      {
        id: 'destination-local', kind: 'destination', name: 'Stockage local',
        color: '#5a6b52', letters: 'S', site: '',
        logo: '/stockage-local.svg', logoInterne: true, source: 'internal', origin: null,
        bytes: 0, width: null, height: null, fetchedAt: null,
      },
      {
        id: 'destination-proton', kind: 'destination', name: 'Proton Drive',
        color: '#6c5ce7', letters: 'P', site: 'proton.me',
        logo: '/api/connectors/logos/destination-proton.png?v=1754820000000',
        logoInterne: false, source: 'fetched',
        origin: 'https://proton.me/apple-touch-icon.png',
        bytes: 9_320, width: 180, height: 180, fetchedAt: '2026-08-10T10:00:00.000Z',
      },
      {
        id: 'destination-pcloud', kind: 'destination', name: 'pCloud',
        color: '#1f8fd6', letters: 'p', site: 'www.pcloud.com',
        logo: null, logoInterne: false, source: null, origin: null,
        bytes: 0, width: null, height: null, fetchedAt: null,
      },
    ],
    limits: { maxBytes: 512_000, minSide: 16, maxSide: 2048, timeoutMs: 6000 },
  },

  '/users/me/preferences': {
    preferences: {
      'apps.hideInactive': false,
      // Lot 12 : les comptes REPLIÉS de « Mes documents », et le filtre du
      // gestionnaire de logos. Tous deux mémorisés par compte, pas par
      // navigateur — voir server/preferences.js.
      'documents.collapsed': [],
      'logos.filter': 'tous',
      // Lot 18 : « Mes documents » a sa bascule cartes / liste comme les
      // Applications, et le bloc Statistiques choisit ses graphiques.
      'view.documents': 'cards',
      // Lot 20 : chaque bloc de l'accueil a SA pagination et SA bascule
      // cartes / liste, sous ses propres clés. `home.pageSize` a disparu — sa
      // valeur a été recopiée sur les deux (migration 24).
      'view.home-sync': 'cards',
      'view.home-documents': 'cards',
      'home.sync.pageSize': 10,
      'home.documents.pageSize': 10,
      'home.stats.charts': ['mois', 'connecteurs'],
      'home.stats.type.mois': 'barres',
      'home.stats.type.connecteurs': 'barres',
    },
  },

  // Une planification par couple (compte, connecteur) réellement installé.
  '/admin/schedules': {
    disabled: false,
    activeTasks: 1,
    timezone: 'Europe/Paris',
    frequencies: [
      { id: 'daily', label: 'quotidien' },
      { id: 'weekly', label: 'hebdomadaire' },
      { id: 'monthly', label: 'mensuel' },
      { id: 'disabled', label: 'désactivé' },
    ],
    weekdays: [
      { id: 0, label: 'dimanche' }, { id: 1, label: 'lundi' }, { id: 2, label: 'mardi' },
      { id: 3, label: 'mercredi' }, { id: 4, label: 'jeudi' }, { id: 5, label: 'vendredi' },
      { id: 6, label: 'samedi' },
    ],
    schedules: [
      {
        id: '1:free',
        userId: 1,
        username: 'camille',
        userActive: true,
        configured: true,
        installStatus: 'installed',
        connectorId: 'free',
        name: 'Free Internet',
        color: '#c8102e',
        letters: 'FR',
        frequency: 'monthly',
        timeOfDay: '03:00',
        dayOfWeek: 1,
        dayOfMonth: 5,
        lastDayOfMonth: false,
        enabled: true,
        maintenance: false,
        cron: '0 3 5 * *',
        rhythm: 'mensuel, jour 5 à 03:00',
        running: false,
        lastRunAt: '2026-07-29T03:00:00.000Z',
        lastError: 'Identifiants refusés',
        nextRunAt: '2026-08-05T01:00:00.000Z',
        lastRun: { success: false, at: '2026-07-29T03:00:00.000Z', message: 'Identifiants refusés' },
      },
    ],
  },

  // Accueil : tout le tableau de bord en un appel.
  '/home': {
    user: { id: 1, username: 'camille', initials: 'CA', avatarColor: null, gravatarUrl: null },
    today: '2026-08-09T09:00:00.000Z',
    widgets: [
      { id: 'connecteurs', title: 'Mes connecteurs', icon: 'grid', span: 12, defaultSpan: 12, enabled: true },
      { id: 'stats', title: 'Statistiques', icon: 'chart', span: 12, defaultSpan: 12, enabled: true },
      { id: 'sync', title: 'Synchronisation', icon: 'sync', span: 6, defaultSpan: 6, enabled: true },
      { id: 'errors', title: 'Suivi actions', icon: 'alert', span: 6, defaultSpan: 6, enabled: true },
      { id: 'documents', title: 'Derniers documents', icon: 'doc', span: 12, defaultSpan: 12, enabled: true },
      { id: 'destinations', title: 'État des destinations', icon: 'cloud', span: 12, defaultSpan: 12, enabled: true },
    ],
    spans: [
      { value: 12, label: '1', title: 'Ligne entière' },
      { value: 6, label: '½', title: 'Une demi-ligne' },
      { value: 4, label: '⅓', title: 'Un tiers' },
      { value: 3, label: '¼', title: 'Un quart' },
    ],
    access: { adminAllowed: true, personalLock: false, canCustomize: true },
    // Lot 18 — les tailles de page proposées ET les graphiques disponibles
    // viennent du serveur : c'est lui qui refuse le reste, et un menu qui
    // proposerait autre chose serait un piège à clic.
    pageSizes: [10, 15, 20, 25, 30, 50],
    // Lot 20 : une pagination et une présentation PAR BLOC.
    syncPageSize: 10,
    documentsPageSize: 10,
    syncView: 'cards',
    documentsView: 'cards',
    statsCharts: ['mois', 'connecteurs'],
    statsChartsCatalog: [
      { id: 'mois', title: 'Factures par mois' },
      { id: 'connecteurs', title: 'Répartition par service' },
      { id: 'stockage', title: 'Espace occupé par service' },
      { id: 'connecteurs-temps', title: 'Services connectés au fil du temps' },
      { id: 'executions', title: 'Récupérations réussies et échouées' },
    ],
    statsChartTypes: { mois: 'barres', connecteurs: 'barres' },
    statsTypeCatalog: { mois: ['barres', 'courbe'], connecteurs: ['barres', 'anneau'] },
    statsTypeLabels: { barres: 'Barres', courbe: 'Courbe', anneau: 'Anneau' },
    connectors: [
      {
        id: 'free', name: 'Free Internet', color: '#c8102e', letters: 'FR',
        status: 'installed', alert: false,
        health: {
          code: 'ready', title: 'Connecté', detail: '', tone: 'green',
          action: { id: 'sync', label: 'Récupérer maintenant' },
          canSync: true, canReconfigure: true, connected: true, followedLabel: null,
        },
      },
    ],
    stats: {
      invoicesThisMonth: 1,
      invoicesTotal: 6,
      bytes: 608174,
      activeConnectors: 1,
      lastSuccessAt: '2026-08-09T07:02:00.000Z',
      // Lot 20 — les trois séries ajoutées. Elles n'existent que parce que la
      // donnée existe : `size_bytes` sur chaque facture, `installed_at` sur
      // chaque installation, `success` sur chaque exécution. Le candidat
      // « montant total par mois » a été écarté — aucune colonne de montant.
      stockageParConnecteur: [
        { id: 'free', name: 'Free Internet', color: '#c8102e', bytes: 608174, count: 6 },
      ],
      connecteursDansLeTemps: [
        { periode: '2026-07', count: 1 },
        { periode: '2026-08', count: 1 },
      ],
      executionsParMois: [
        { periode: '2026-07', ok: 3, ko: 1 },
        { periode: '2026-08', ok: 2, ko: 0 },
      ],
    },
    sync: [
      {
        id: 'free', name: 'Free Internet', color: '#c8102e', letters: 'FR',
        lastRunAt: '2026-08-09T07:02:00.000Z', running: false,
        health: {
          code: 'ready', title: 'Connecté', detail: '', tone: 'green',
          action: { id: 'sync', label: 'Récupérer maintenant' },
          canSync: true, canReconfigure: true, connected: true, followedLabel: null,
        },
      },
    ],
    // ─── Le bloc « Suivi actions » (lot 25) : ses TROIS natures ───────────
    //
    // Les trois sont peuplées ici, et c'est délibéré : c'est la seule façon de
    // vérifier que les trois couleurs sont rendues, et surtout que le VERT
    // existe. Jusqu'au lot 24 ce bloc n'affichait que du rouge.
    errors: [
      {
        connectorId: 'anthropic',
        name: 'Claude',
        color: '#d97757',
        letters: 'CL',
        logo: null,
        at: '2026-08-13T10:55:18.000Z',
        message: 'Claude a présenté sa vérification de sécurité au lieu de votre page de facturation.',
        health: {
          code: 'blocked', title: 'Bloqué', tone: 'red',
          detail: 'Claude a présenté sa vérification de sécurité au lieu de votre page de facturation.',
          action: { id: 'reconnect', label: 'Se reconnecter' },
          canSync: false, canReconfigure: true, connected: false, followedLabel: null,
        },
      },
    ],
    // Lot 7 : les connecteurs qui attendent un geste sans avoir jamais tourné.
    // Ils n'ont aucune exécution en échec — donc n'apparaissaient nulle part.
    pendingActions: [
      {
        connectorId: 'paypal',
        name: 'PayPal',
        color: '#003087',
        letters: 'PP',
        logo: null,
        health: {
          code: 'unconfigured', title: 'À configurer', tone: 'amber',
          detail: 'Ce service attend vos identifiants.',
          action: { id: 'configure', label: 'Configurer' },
          canSync: false, canReconfigure: true, connected: false, followedLabel: null,
        },
      },
    ],
    // ⚠ Lot 25 — LE CAS QUI COMPTE : une récupération qui rapporte ZÉRO
    // document est un SUCCÈS, pas un avertissement. « Aucune nouvelle
    // facture » veut dire que crabe est allé voir, qu'il a été reçu, et qu'il
    // n'y avait rien de neuf. C'est l'information qui rassure, et elle
    // n'apparaissait nulle part avant ce lot.
    successes: [
      {
        connectorId: 'hetzner',
        name: 'Hetzner',
        color: '#d50c2d',
        letters: 'HZ',
        logo: null,
        at: '2026-08-13T10:54:31.000Z',
        count: 12,
        message: '12 nouveau(x) document(s) récupéré(s).',
      },
      {
        connectorId: 'ovh',
        name: 'OVHcloud',
        color: '#123f6d',
        letters: 'OV',
        logo: null,
        at: '2026-08-13T10:51:49.000Z',
        count: 0,
        message: 'Aucune nouvelle facture — vous êtes à jour.',
      },
    ],
    documents: [
      {
        id: 6,
        connectorId: 'free',
        connectorName: 'Free Internet',
        color: '#c8102e',
        letters: 'FR',
        filename: '2026-07_1487193649.pdf',
        period: '2026-07',
        reference: '1487193649',
        sizeBytes: 101683,
        fetchedAt: '2026-08-09T07:02:00.000Z',
        destinations: [
          {
            id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
      logo: '/stockage-local.svg', logoInterne: true,
            logo: '/stockage-local.svg', logoInterne: true,
        logo: '/stockage-local.svg', logoInterne: true,
            state: 'ok', at: '2026-08-09T07:02:00.000Z', message: null,
            tooltip: 'Stockage local — copié le 2026-08-09 07:02',
          },
        ],
        hasError: false,
      },
    ],
    documentsLimit: 10,
    destinations: [
      {
        id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
      logo: '/stockage-local.svg', logoInterne: true,
        logo: '/stockage-local.svg', logoInterne: true,
        usedBytes: 608174, files: 6,
        // Lot 10 : les documents de CE compte, et ce qui reste à copier. La
        // destination principale ne porte pas de bouton « Synchroniser » —
        // elle est la source des copies, pas leur cible.
        yourFiles: 6, pending: 0, canSync: false,
        space: { known: true, totalBytes: 590558003200, freeBytes: 549755813888, usedBytes: 40802189312 },
        lastTestAt: '2026-08-09T06:00:00.000Z', lastTestOk: true,
      },
    ],
    copyFailures: [],
    hiddenDestinations: [
      { id: 'proton', name: 'Proton Drive' },
      { id: 'pcloud', name: 'pCloud' },
    ],
    hiddenDestinationsNote:
      "Proton Drive et pCloud ne sont pas activés par l'administrateur.",
  },

  '/admin/logs/runs': {
    logs: [
      {
        connectorName: 'Free Internet',
        color: '#c8102e',
        letters: 'FR',
        username: 'camille',
        started_at: '2026-07-29T03:00:00.000Z',
        trigger: 'planifié',
        invoice_count: 2,
        success: false,
        message: 'Un message très long '.repeat(12),
      },
    ],
    filters: [{ id: 'free', name: 'Free Internet' }],
    retentionDays: 365,
  },

  '/admin/logs/app': {
    logs: [
      {
        level: 'error',
        at: '2026-07-29T03:00:00.000Z',
        source: 'destinations',
        message: 'Écriture refusée dans /mnt/local',
        username: 'camille',
      },
    ],
    levels: [{ id: 'error', label: 'Erreur' }],
    counts: { all: 1, error: 1 },
    retentionDays: 365,
  },

  '/admin/logs/storage': {
    logs: [
      {
        destName: 'Stockage local',
        at: '2026-07-29T03:00:00.000Z',
        username: 'camille',
        success: true,
        message: 'facture.pdf déposée',
      },
    ],
    filters: [{ id: 'local', name: 'Stockage local' }],
    retentionDays: 365,
  },

  '/admin/logs/connections': {
    logs: [
      {
        username: 'camille',
        date: '2026-07-29T08:00:00.000Z',
        os: 'Linux',
        browser: 'Firefox',
        ip: '10.0.0.10',
        success: true,
      },
    ],
    users: [{ username: 'camille' }],
    retentionOptions: [{ days: 365, label: '1 an' }],
    retentionDays: 365,
  },

  '/tickets': {
    counts: { unread: 1, 'en-cours': 0, repondu: 1, ferme: 0, all: 2 },
    tickets: [
      {
        id: 1,
        subject: 'Erreur OVH',
        status: 'recu',
        unread: true,
        replyCount: 0,
        username: 'camille',
        createdAt: '2026-07-29T08:00:00.000Z',
        hiddenByUser: false,
      },
    ],
  },

  '/system/rclone': { available: false, version: null, binary: 'rclone' },

  '/system': {
    version: '1.0.0',
    node: 'v24.0.0',
    env: 'production',
    uptimeSeconds: 3600,
    hostUptimeSeconds: 86400,
    hostname: 'crabe',
    stats: {
      usersActive: 2,
      usersTotal: 3,
      connectorsAvailable: 13,
      connectorsInstalled: 4,
      invoicesTotal: 128,
      storageBytes: 4096,
      reliability30d: 96.5,
    },
    runtime: {
      dataDir: '/opt/crabe/data',
      dbFile: '/opt/crabe/data/crabe.db',
      dbSizeBytes: 262144,
      diskFreeBytes: 8589934592,
      timezone: 'Europe/Paris',
      systemTimezone: 'UTC',
      serverTime: '2026-07-30T10:00:00.000Z',
      cookieSecure: false,
      trustProxy: 1,
    },
    local: {
      path: '/mnt/local',
      protocol: 'nfs',
      exists: true,
      mounted: true,
      writable: true,
      state: 'ok',
    },
    playwright: { available: false },
    schemaVersion: 9,
    smtpConfigured: true,
    scheduler: { disabled: false, activeTasks: 2, lastCronAt: null, lastMaintenanceAt: null },
    connectorLoadErrors: [],
  },

  '/tickets/1': {
    ticket: {
      id: 1,
      subject: 'Erreur OVH',
      status: 'recu',
      username: 'camille',
      createdAt: '2026-07-29T08:00:00.000Z',
      readAt: null,
      hiddenByUser: false,
      messages: [
        {
          author: 'user',
          username: 'camille',
          body: 'La synchronisation OVH échoue.',
          createdAt: '2026-07-29T08:00:00.000Z',
        },
      ],
    },
  },

  '/users': {
    users: [
      {
        id: 1,
        username: 'camille',
        email: 'camille@test.local',
        role: 'admin',
        roleId: 1,
        roleName: 'Administrateur',
        status: 'active',
        lastLoginAt: '2026-07-29T08:00:00.000Z',
        invoiceCount: 12,
        connectorCount: 3,
        twoFactor: { enabled: false },
        home: { adminAllowed: true, personalLock: false, canCustomize: true },
        avatarColor: null,
        gravatarUrl: null,
        deletionPending: false,
      },
      {
        id: 2,
        username: 'partante',
        email: 'partante@test.local',
        role: 'user',
        roleId: 2,
        roleName: 'Utilisateur',
        status: 'active',
        lastLoginAt: null,
        invoiceCount: 0,
        connectorCount: 0,
        twoFactor: { enabled: false },
        // Accueil verrouillé par l'administrateur : la pastille et l'entrée de
        // menu correspondantes doivent apparaître.
        home: { adminAllowed: false, personalLock: false, canCustomize: false },
        avatarColor: null,
        gravatarUrl: null,
        deletionPending: false,
      },
    ],
  },
  '/users/deletion/requests': {
    requests: [
      {
        userId: 2, username: 'partante', requestedAt: '2026-07-28T08:00:00.000Z',
        wantsExport: true, exportSent: false, revoked: false, scheduledDeleteAt: null,
      },
    ],
  },
  '/admin/roles': {
    roles: [{ id: 1, slug: 'admin', name: 'Administrateur', builtin: 1, permissions: [], users: 1 }],
    permissions: [{ id: 'users.manage', label: 'Gérer les comptes', group: 'Comptes' }],
    users: [],
    note: 'Les permissions sont appliquées côté serveur.',
  },
  // --- Écrans utilisateur (accueil, store, profil) --------------------------

  '/connectors': {
    // Depuis le lot 11, `/api/connectors` sert aussi l'ordre des catégories et
    // le compte affiché en tête du Store : le front ne tient plus de liste en
    // dur, et le compte ne peut pas diverger de ce que la grille montre.
    categories: [
      { id: 'energie', label: 'Énergie' },
      { id: 'telecom', label: 'Mobile & Internet' },
      { id: 'hebergement', label: 'Cloud & hébergement' },
      { id: 'public', label: 'Services publics' },
      { id: 'shopping', label: 'Shopping' },
      { id: 'ia', label: 'IA & outils créatifs' },
      { id: 'divertissement', label: 'Divertissement' },
      { id: 'voyage', label: 'Voyage & mobilité' },
      { id: 'sante', label: 'Santé & assurance' },
      { id: 'banque', label: 'Banque & paiement' },
      { id: 'crypto', label: 'Crypto-monnaies' },
      { id: 'administratif', label: 'Administratif & éducation' },
      { id: 'domicile', label: 'Domicile' },
      { id: 'divers', label: 'Divers' },
    ],
    counts: { available: 3, planned: 2 },
    connectors: [
      {
        id: 'free', name: 'Free Internet', color: '#c8102e', letters: 'FR',
        category: 'telecom', categoryLabel: 'Mobile & Internet', site: 'free.fr',
        description: 'Factures de votre abonnement Freebox.',
        status: 'installed', installed: true, maintenance: false,
        lastRunAt: '2026-08-09T07:02:00.000Z',
        installedAt: '2026-07-30T10:00:00.000Z',
        invoiceCount: 6, lastInvoiceAt: '2026-08-09T07:02:00.000Z',
        // Lot 7 : l'état ET l'action qui le résout, calculés côté serveur
        // (server/connectors/health.js) et partagés par la fiche, l'accueil et
        // l'écran d'erreur.
        health: {
          code: 'ready', title: 'Connecté', detail: '', tone: 'green',
          action: { id: 'sync', label: 'Récupérer maintenant' },
          canSync: true, canReconfigure: true, connected: true, followedLabel: null,
        },
        // Forme réelle d'un manifeste depuis le lot 4 : clé du vocabulaire
        // commun, portée, et description propre au connecteur.
        permissions: [
          {
            key: 'factures',
            scope: 'read-write',
            description: 'Télécharge les factures PDF de votre abonnement Freebox.',
          },
        ],
        fields: [
          // Lot 15 : le champ d'identification déclare CE QUE le site demande, et
          // le serveur en déduit libellé, aide et type de champ HTML — la forme
          // servie par `/api/connectors` porte les deux (identification.js).
          {
            key: 'login', identification: 'identifiant', label: 'Identifiant',
            type: 'text', inputType: 'text', placeholder: 'fbx...', required: true,
            help: 'Celui avec lequel vous vous connectez sur Free Internet.',
          },
          { key: 'password', label: 'Mot de passe', type: 'password', required: true },
        ],
      },
      {
        id: 'edf', name: 'EDF', color: '#0e6bb8', letters: 'ED',
        category: 'energie', categoryLabel: 'Énergie', site: 'edf.fr',
        description: 'Factures d\'électricité.',
        status: 'available', installed: false, maintenance: false,
        lastRunAt: null, installedAt: null,
        invoiceCount: 0, lastInvoiceAt: null,
        health: {
          code: 'available', title: 'Non connecté', detail: 'EDF n\'est pas encore configuré.',
          tone: 'gray', action: { id: 'configure', label: 'Configurer' },
          canSync: false, canReconfigure: false, connected: false, followedLabel: null,
        },
        permissions: [],
        fields: [
          {
            key: 'email', identification: 'email', label: 'Adresse électronique',
            type: 'email', inputType: 'email', required: true,
            help: 'Celle avec laquelle vous vous connectez sur EDF.',
          },
        ],
      },
      // Lot 5 : un connecteur à session capturée ET à découverte. La forme est
      // celle de registry.listForUser() — voir test/admin-routes.test.js, qui
      // compare ces fixtures aux réponses d'un serveur réel.
      {
        id: 'free-mobile', name: 'Free Mobile', color: '#c8102e', letters: 'FM',
        category: 'telecom', categoryLabel: 'Mobile & Internet', site: 'mobile.free.fr',
        description: 'Récupère automatiquement vos factures Free Mobile, toutes vos lignes comprises.',
        status: 'installed', installed: true, maintenance: false,
        lastRunAt: '2026-08-09T07:02:00.000Z',
        installedAt: '2026-08-09T06:00:00.000Z',
        invoiceCount: 30, lastInvoiceAt: '2026-08-09T07:02:00.000Z',
        health: {
          code: 'ready', title: 'Connecté', detail: '', tone: 'green',
          action: { id: 'sync', label: 'Récupérer maintenant' },
          canSync: true, canReconfigure: true, connected: true,
          followedLabel: '1 ligne suivie',
        },
        discovery: true,
        // Lot 6 : le connecteur sait ouvrir sa session par navigateur distant.
        remoteLogin: {
          url: 'https://mobile.free.fr/account/v2/login',
          marker: 'Mes factures',
          hint: 'Cochez « Se souvenir de cet appareil » quand Free vous le propose : c\'est '
            + 'cette case, et elle seule, qui fait durer la session six mois.',
        },
        permissions: [],
        fields: [
          {
            key: 'session', label: 'Session Free Mobile', type: 'session',
            required: true, accept: 'application/json,.json',
            help: 'Le bouton « Se connecter à Free Mobile » ouvre une fenêtre de navigateur '
              + 'dans crabe ; le repli par fichier reste possible.',
          },
          {
            key: 'lignes', label: 'Lignes à récupérer', type: 'multiselect',
            source: 'discover', required: false, unit: 'ligne', unitFeminine: true,
            notice: 'Les lignes résiliées ne recevront plus de nouvelle facture, et Free ne '
              + 'conserve que les 12 dernières. Les récupérer maintenant est le seul moyen de '
              + 'les sauvegarder.',
            help: 'La liste est établie après connexion.',
          },
        ],
        configSummary: {
          sessions: {
            session: {
              savedAt: '2026-08-09T21:40:00.000Z',
              expiresAt: '2027-02-05T21:40:00.000Z',
              cookieCount: 7,
              expired: false,
            },
          },
          discoveries: {
            lignes: {
              updatedAt: '2026-08-09T21:41:00.000Z',
              selection: ['0628000000'],
              items: [
                { id: '0628000000', label: 'Camille Dupont', badge: 'principale', detail: '12 factures', preselected: true },
                { id: '0749000000', label: 'Camille Dupont', badge: 'secondaire', detail: '12 factures', preselected: false },
                { id: '0743000000', label: 'Camille Dupont', badge: 'secondaire', detail: '3 factures', preselected: false },
                { id: '0782518125', label: 'Samuel Huck', badge: 'secondaire', detail: '3 factures', preselected: false },
              ],
            },
          },
        },
      },
      // Lot 11 — deux services ANNONCÉS. Forme réelle de registry.listForUser()
      // pour une entrée de planned/ : pas de champs, pas de permissions, un
      // `health` dont l'action vaut null, et une pastille déduite du nom.
      {
        id: 'spotify', name: 'Spotify', color: '#6a3d9a', letters: 'SP',
        category: 'divertissement', categoryLabel: 'Divertissement', site: 'www.spotify.com',
        description: 'Récupère automatiquement vos factures d\'abonnement Spotify.',
        caveat: '',
        planned: true, status: 'planned', installed: false, maintenance: false,
        lastRunAt: null, installedAt: null,
        invoiceCount: 0, lastInvoiceAt: null,
        health: {
          code: 'planned', title: 'Bientôt disponible',
          detail: 'Spotify est annoncé : sa connexion arrivera dans une prochaine version de crabe.',
          tone: 'gray', action: null,
          canSync: false, canReconfigure: false, connected: false, followedLabel: null,
        },
        permissions: [], fields: [],
      },
      // Celui-ci porte une réserve : c'est elle qui s'affiche sur la tuile, à
      // la place de la description, et non une infobulle que personne n'ouvre.
      {
        id: 'credit-agricole', name: 'Crédit Agricole', color: '#7a5c1e', letters: 'CA',
        category: 'banque', categoryLabel: 'Banque & paiement', site: 'www.credit-agricole.fr',
        description: 'Récupère automatiquement vos relevés de compte Crédit Agricole.',
        caveat: 'La connexion à votre banque demande une validation depuis son application mobile. '
          + 'Ce service est à l\'étude, sa disponibilité n\'est pas garantie.',
        planned: true, status: 'planned', installed: false, maintenance: false,
        lastRunAt: null, installedAt: null,
        invoiceCount: 0, lastInvoiceAt: null,
        health: {
          code: 'planned', title: 'Bientôt disponible',
          detail: 'Crédit Agricole est annoncé : sa connexion arrivera dans une prochaine version de crabe.',
          tone: 'gray', action: null,
          canSync: false, canReconfigure: false, connected: false, followedLabel: null,
        },
        permissions: [], fields: [],
      },
    ],
  },

  // Lot 6 — ce que le serveur répond quand tout est en place. Le cas contraire
  // (paquets manquants) est vérifié par test/render.test.js, qui remplace cette
  // réponse à la volée : c'est LUI qui doit griser le bouton avec l'explication.
  '/connectors/remote-login/capabilities': {
    available: true,
    busy: false,
    reason: null,
    missing: [],
    memory: { totalMb: 4096, freeMb: 2900, enough: true },
  },

  // La session de connexion telle que le serveur la rend au client : de quoi
  // brancher l'écran (chemin du relais, jeton, mot de passe VNC) et afficher le
  // temps qui reste. Ni identifiant de processus, ni port, ni chemin de socket.
  '/connectors/free-mobile/remote-login': {
    sessionId: 'session-de-test',
    connectorId: 'free-mobile',
    connectorName: 'Free Mobile',
    state: 'running',
    message: 'Connectez-vous dans la fenêtre ci-dessous.',
    detail: '',
    error: null,
    hint: 'Cochez « Se souvenir de cet appareil ».',
    token: 'jeton-de-test',
    vncPassword: 'mdp-vnc-de-test',
    screen: { width: 1280, height: 800 },
    remainingMs: 596_000,
    startedAt: '2026-08-10T09:00:00.000Z',
    result: null,
    done: false,
    streamPath: '/api/connectors/remote-login/stream',
  },

  // Lot 12 — la saisie du champ « Coller un texte », frappée par le SERVEUR
  // dans la fenêtre distante. La réponse ne renvoie rien du texte, pas même sa
  // longueur : c'est un mot de passe, et il ne ressort jamais.
  '/connectors/free-mobile/remote-login/type': { ok: true },

  '/connectors/free-mobile/discover': {
    field: {
      key: 'lignes',
      label: 'Lignes à récupérer',
      unit: 'ligne',
      unitFeminine: true,
      help: 'La liste est établie après connexion, en dépliant le menu « Mes lignes ».',
      notice: 'Les lignes résiliées ne recevront plus de nouvelle facture, et Free ne conserve '
        + 'que les 12 dernières. Les récupérer maintenant est le seul moyen de les sauvegarder.',
    },
    selection: ['0628000000'],
    added: [],
    missing: [],
    // Lot 9 : le rang vient de l'ORDRE de découverte, et de rien d'autre. La
    // première ligne est principale, toutes les suivantes sont secondaires —
    // il n'y a plus ni « résiliée », ni « inconnu », ni ligne sans badge.
    items: [
      { id: '0628000000', label: 'Camille Dupont', badge: 'principale', detail: '12 factures', preselected: true },
      { id: '0749000000', label: 'Camille Dupont', badge: 'secondaire', detail: '12 factures', preselected: false },
      { id: '0743000000', label: 'Camille Dupont', badge: 'secondaire', detail: '3 factures', preselected: false },
      { id: '0782518125', label: 'Samuel Huck', badge: 'secondaire', detail: '3 factures', preselected: false },
    ],
  },

  // Lot 7 — « Mes documents ». Forme de GET /api/documents : les espaces
  // proposés, l'arborescence connecteur → compte → documents, et les valeurs
  // offertes aux filtres.
  '/documents': {
    destinations: [
      {
        id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
      logo: '/stockage-local.svg', logoInterne: true,
        logo: '/stockage-local.svg', logoInterne: true,
        primary: true, available: true, reason: null,
      },
    ],
    destination: {
      id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
      logo: '/stockage-local.svg', logoInterne: true,
      primary: true, available: true, reason: null,
    },
    available: true,
    reason: null,
    tree: [
      {
        connectorId: 'free', connectorName: 'Free Internet', color: '#c8102e', letters: 'FR',
        count: 2,
        accounts: [
          {
            accountId: 'fbx11111111',
            label: 'fbx11111111',
            documents: [
              {
                id: 6, connectorId: 'free', connectorName: 'Free Internet',
                color: '#c8102e', letters: 'FR', accountId: 'fbx11111111',
                filename: '202507_free.pdf', period: '2026-07', reference: 'FR-2507',
                sizeBytes: 101_362, fetchedAt: '2026-08-09T07:02:00.000Z',
                copiedAt: '2026-08-09T07:02:10.000Z', missing: false,
              },
              {
                id: 5, connectorId: 'free', connectorName: 'Free Internet',
                color: '#c8102e', letters: 'FR', accountId: 'fbx11111111',
                filename: '202506_free.pdf', period: '2026-06', reference: 'FR-2506',
                sizeBytes: 99_128, fetchedAt: '2026-07-09T07:02:00.000Z',
                copiedAt: null, missing: true,
              },
            ],
          },
        ],
      },
    ],
    filters: {
      connectors: [{ id: 'free', name: 'Free Internet' }],
      periods: ['2026-07', '2026-06'],
    },
    total: 2,
    shown: 2,
  },

  '/connectors/me/storage': {
    bytes: 608174, files: 6, filesThisMonth: 1, lastFetchAt: '2026-08-09T07:02:00.000Z',
    destinations: [
      {
        id: 'local', name: 'Stockage local', letter: 'S', color: '#5a6b52',
      logo: '/stockage-local.svg', logoInterne: true,
        logo: '/stockage-local.svg', logoInterne: true,
        bytes: 608174, files: 6,
        space: {
          known: true, totalBytes: 590558003200, freeBytes: 501814235136,
          usedBytes: 88743768064, measuredAt: '2026-08-09T07:02:00.000Z',
        },
      },
    ],
  },

  '/connectors/free/permissions': {
    connector: { id: 'free', name: 'Free Internet', color: '#c8102e', letters: 'FR' },
    permissions: [
      {
        key: 'factures',
        name: 'Factures',
        icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>',
        scope: 'read-write',
        scopeLabel: 'Lecture et écriture',
        description:
          'Télécharge les factures PDF de votre abonnement Freebox depuis l\'espace abonné Free, et les dépose sur vos destinations de stockage.',
        generic: false,
      },
      {
        key: 'identifiants',
        name: 'Identifiants du connecteur',
        icon: '<rect x="3" y="11" width="18" height="10" rx="2"/>',
        scope: 'read',
        scopeLabel: 'Lecture seule',
        description:
          'Votre identifiant et votre mot de passe Free, chiffrés au repos, utilisés uniquement pour ouvrir une session sur le portail abonné.',
        generic: false,
      },
      {
        key: 'informations-compte',
        name: 'Informations de compte',
        icon: '<circle cx="12" cy="8" r="4"/>',
        scope: 'read',
        scopeLabel: 'Lecture seule',
        description:
          'Votre identifiant d\'abonné (fbx…), lu sur l\'espace abonné : il sert de nom de dossier de destination pour vos factures Free.',
        generic: false,
      },
    ],
    note:
      'Droit d\'accès limité — crabe se connecte au fournisseur avec vos seuls identifiants, '
      + 'stockés chiffrés sur cette installation.',
  },

  '/tickets/mine': {
    tickets: [
      {
        id: 1, subject: 'Erreur OVH', status: 'recu', statusLabel: 'Reçue',
        displayLabel: 'Reçue', unread: false, createdAt: '2026-07-29T08:00:00.000Z',
        messages: [
          { author: 'user', username: 'camille', body: 'La synchronisation OVH échoue.',
            createdAt: '2026-07-29T08:00:00.000Z' },
        ],
      },
    ],
  },

  '/users/me/deletion': { request: null, retentionDays: 30 },

  '/auth/me': {
    user: { username: 'camille', permissions: ['security.manage'] },
    settings: { timezone: 'Europe/Paris', timeFormat: '24', dateFormat: 'DD/MM/YYYY', gravatarEnabled: false },
  },
};

module.exports = { FIXTURES };
