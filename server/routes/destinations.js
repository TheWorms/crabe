'use strict';

/**
 * Destinations de stockage — administration uniquement.
 *
 * La configuration est globale : elle n'apparaît jamais dans le profil d'un
 * utilisateur, qui ne voit que sa consommation.
 */

const express = require('express');
const destinations = require('../destinations');
const destinationSync = require('../destinations/sync');
const rclone = require('../destinations/rclone');
const autorisation = require('../destinations/autorisation');
const remoteBrowser = require('../remote-browser');
const { STREAM_PATH } = require('./remote-login');
const applog = require('../applog');
const { requirePermission, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(requirePermission('storage.manage'));

/**
 * UNE seule liste pour le bouton « Ajouter un cloud » (lot 28).
 *
 * ─── Ce qu'il y avait avant, et pourquoi c'était à refaire ───────────────────
 *
 * Deux listes, et deux sources : les quatre fournisseurs habillés de
 * `presets.js` d'abord, puis un bouton « Autre stockage » qui menait à la liste
 * complète des types du binaire rclone. pCloud figurait donc DEUX fois — une
 * fois nommé « pCloud », une fois nommé « pcloud », à deux endroits différents.
 * Personne ne peut deviner qu'il s'agit du même service, ni lequel choisir.
 *
 * Désormais : les vedettes en tête, avec leur nom propre et leur couleur, puis
 * tous les autres types que ce rclone-ci sait gérer, par ordre alphabétique. Le
 * type qu'une vedette remplace entièrement n'est pas répété (`couvreLeType`).
 *
 * ─── Ce qui n'a pas changé : dire AVANT ce qui ne marchera pas ───────────────
 *
 * Un fournisseur vedette dont le type manque au binaire installé reste montré,
 * grisé, avec la phrase qui dit quoi faire. Le retirer laisserait croire que
 * crabe ne sait pas parler à ce service, ce qui est faux. Les types venus
 * d'rclone, eux, sont disponibles par construction — c'est lui qui les nomme.
 */
async function fournisseursProposables() {
  const dispo = await destinations.backends.typesDisponibles();
  const connus = new Set(dispo.types.map((t) => t.name));
  const couverts = destinations.presets.typesCouverts();

  const vedettes = destinations.presets.liste().map((p) => {
    const mesurable = dispo.ok && p.backend !== null;
    const disponible = !mesurable || connus.has(p.backend);
    return {
      // `id` distingue la carte, `provider` + `type` disent quoi créer. Pour une
      // vedette les deux se confondent : c'est le fournisseur qui impose son
      // type, l'utilisateur n'a rien à choisir de plus.
      id: p.id,
      provider: p.id,
      type: null,
      vedette: true,
      label: p.label,
      resume: p.resume || '',
      letter: p.letter,
      color: p.color,
      icone: p.icone || null,
      site: p.site || '',
      backend: p.backend,
      disponible,
      indisponibleParce: disponible
        ? null
        : destinations.backends.messageTypeAbsent(p.label, p.backend),
    };
  });

  const autres = dispo.types
    .filter((t) => !couverts.has(t.name))
    .map((t) => {
      const { titre, detail } = libelleDuType(t);
      return {
        // Préfixé, parce qu'un type rclone peut porter le nom d'un preset
        // (`pcloud`) : sans le préfixe, deux cartes partageraient un identifiant.
        id: `type:${t.name}`,
        provider: 'autre',
        type: t.name,
        vedette: false,
        label: titre,
        resume: detail,
        // Pas de fournisseur nommé, donc pas de logo à récupérer : la pastille
        // porte l'initiale du service sur le gris neutre des destinations
        // « autres ».
        letter: titre.slice(0, 1).toUpperCase(),
        color: '#63666e',
        icone: null,
        site: '',
        backend: t.name,
        disponible: true,
        indisponibleParce: null,
      };
    })
    // Trié sur ce qui est AFFICHÉ, pas sur le nom technique : quelqu'un qui
    // cherche « Google Drive » le cherche à la lettre G, pas à la lettre D de
    // `drive`. Même comparateur que les autres listes de l'interface.
    .sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base', numeric: true }));

  return [...vedettes, ...autres];
}

/**
 * Le nom lisible d'un type rclone, et son complément.
 *
 * rclone décrit ses types en une phrase, parfois d'un mot (« Dropbox »),
 * parfois d'un paragraphe entier — celle de `s3` énumère cinquante services
 * compatibles. La carte affiche donc le DÉBUT, jusqu'à la première virgule ou
 * au premier « including », et renvoie le reste sur la ligne grise du dessous.
 *
 * Quand la description tient en un mot, cette ligne grise porte à la place le
 * nom technique — mais seulement s'il apporte quelque chose : « dropbox » sous
 * « Dropbox » n'apprend rien à personne, tandis que « drive » sous « Google
 * Drive » est ce qu'on retrouvera dans la documentation d'rclone.
 */
function libelleDuType(type) {
  const description = String(type.description || '').trim();
  const nom = String(type.name || '');
  if (!description) return { titre: nom, detail: '' };

  const coupure = description.search(/,| including /i);
  const titre = coupure > 0 ? description.slice(0, coupure).trim() : description;
  if (titre !== description) return { titre, detail: description };
  return { titre, detail: titre.toLowerCase() === nom.toLowerCase() ? '' : nom };
}

/** Synthèse globale + configuration de chaque destination. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const usage = destinations.usageByDestination();
    const total = usage.reduce((sum, u) => sum + u.bytes, 0);
    const global = destinations.globalUsage();

    res.json({
      // Les fournisseurs proposés par le bouton « Ajouter un cloud ». Ils
      // partent du serveur et non de l'écran : c'est le serveur qui sait
      // lesquels ce rclone-ci sait réellement gérer (voir `disponibles`).
      providers: await fournisseursProposables(),
      destinations: (await destinations.listPublicComplet()).map((d) => ({
        ...d,
        usage: usage.find((u) => u.id === d.id) || { bytes: 0, files: 0, users: 0 },
        // Ce que cette destination n'a pas encore reçu, tous comptes confondus :
        // c'est le chiffre qui donne son sens au bouton « Synchroniser ».
        pending: d.id === 'local' ? 0 : destinationSync.pendingCount(d.id),
      })),
      summary: {
        // Somme des copies : c'est bien la place occupée sur l'ensemble des
        // destinations, une facture copiée deux fois pesant deux fois.
        totalBytes: total,
        destinationCount: usage.filter((u) => u.enabled).length,
        breakdown: usage,
        // Totaux dédoublonnés, comptés sur les factures elles-mêmes.
        files: global.files,
        users: global.users,
        uniqueBytes: global.bytes,
      },
      rcloneAvailable: await rclone.isAvailable(),
    });
  })
);

/**
 * Les types de stockage que le `rclone` installé sait gérer.
 *
 * Sert le sélecteur de type d'une destination créée sans fournisseur nommé : la
 * liste vient du binaire lui-même, elle n'est écrite nulle part dans crabe, et
 * elle suit donc automatiquement une mise à jour d'rclone. Avec `?type=<nom>`,
 * la réponse porte en plus les champs de ce type — leur libellé, leur aide, ce
 * qui est obligatoire et ce qui est un secret.
 *
 * ⚠ Les types qu'un fournisseur vedette remplace en sont retirés, comme dans la
 * liste d'ajout (lot 28) : proposer « pcloud » ici renverrait à une destination
 * sans nom propre ni logo, alors que la carte pCloud fait exactement la même
 * chose en mieux. Un `?type=pcloud` reste servi, lui : une destination qui
 * porte déjà ce type doit continuer d'afficher son formulaire.
 */
router.get(
  '/backends',
  asyncHandler(async (req, res) => {
    const liste = await destinations.backends.typesDisponibles();
    const couverts = destinations.presets.typesCouverts();
    const demande = String(req.query.type || '').trim();
    res.json({
      ...liste,
      types: liste.types.filter((t) => !couverts.has(t.name)),
      type: demande || null,
      // ⚠ Les champs « avancés » sortent d'ici comme les autres depuis le lot
      // 29 : les jeter rendait `mailbox_password` (Proton Drive) et les jetons
      // d'autorisation (pCloud, Dropbox, Google Drive) inatteignables, donc ces
      // destinations impossibles à configurer. L'écran les range dans le repli
      // « Réglages avancés » — il faut encore qu'ils lui parviennent.
      //
      // `habiller` rend les libellés français quand crabe en a écrit pour ce
      // type : le même formulaire doit se lire pareil qu'on l'atteigne par la
      // carte du fournisseur ou par la liste complète des types.
      champs: demande
        ? destinations.presets.habiller(
          demande,
          (await destinations.backends.champsDuType(demande)) || []
        )
        : [],
    });
  })
);

/**
 * Ajoute un cloud — une ligne vide, éteinte, qui attend son formulaire.
 *
 * Créer d'abord et configurer ensuite, plutôt que tout demander d'un coup :
 * c'est la création qui donne son identifiant à la destination, et c'est cet
 * identifiant qui permet de demander à rclone les champs de son type. Vouloir
 * les deux dans la même requête obligerait à deviner les champs avant de
 * savoir de quoi on parle.
 *
 * ─── Le type arrive avec le choix, désormais (lot 28) ───────────────────────
 *
 * La liste d'ajout ne propose plus « Autre stockage » mais chaque type sous son
 * nom : le clic transporte donc `provider: 'autre'` ET le type retenu. Il est
 * vérifié ici contre ce que le binaire annonce — un type inventé donnerait une
 * destination qu'aucun formulaire ne saurait remplir.
 *
 * Le NOM, lui, ne vient plus du formulaire : l'écran de choix le demandait
 * avant même de savoir chez qui, ce qui n'avait pas de sens (lot 28). Il vaut
 * par défaut le nom du fournisseur ou du service choisi, et se change dans la
 * carte, sur le champ « Nom de cet espace » qui a toujours été là.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const provider = String(req.body?.provider || '');
    const preset = destinations.presets.of(provider);
    // ⚠ Un fournisseur vedette IMPOSE son type : celui qui arriverait dans la
    // requête est ignoré, jamais appliqué. Sans cette ligne, une carte « MEGA »,
    // logo et couleur compris, pourrait parler à Dropbox.
    const type = preset && preset.backend === null ? String(req.body?.type || '').trim() : '';
    let nomParDefaut = req.body?.displayName;

    if (type) {
      const proposables = await fournisseursProposables();
      const carte = proposables.find((f) => f.provider === provider && f.type === type);
      if (!carte) {
        return res.status(400).json({
          error: 'Ce type de stockage ne fait pas partie de ceux que ce serveur sait utiliser.',
        });
      }
      if (!nomParDefaut) nomParDefaut = carte.label;
    }

    const cree = destinations.createCloud({
      provider,
      displayName: nomParDefaut,
      type,
    });
    applog.admin(req, `Espace de stockage « ${cree.displayName} » ajouté.`);
    res.json({ ok: true, destination: await destinations.publicConfigComplet(cree.id) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!destinations.driverFor(req.params.id)) {
      return res.status(404).json({ error: 'Destination inconnue.' });
    }

    // ⚠ Les mots de passe passent par `rclone obscure` AVANT d'être rangés :
    // rclone refuse un mot de passe écrit en clair dans sa configuration. Le
    // faire ici, et pas au moment de bâtir le bloc, évite d'avoir à relancer un
    // processus à chaque dépôt de document — et évite surtout de demander à
    // l'utilisateur de lancer une commande dans un terminal (voir rclone.js).
    const corps = { ...(req.body || {}) };

    // La liste des champs est demandée UNE fois, et sert deux fois : pour
    // savoir quoi obscurcir ici, et pour savoir quoi fusionner dans
    // `saveConfig`. Les faire calculer chacun de leur côté, c'était accepter
    // qu'ils divergent — et un champ vu comme secret ici mais pas là-bas
    // effacerait un mot de passe à chaque enregistrement.
    //
    // Le type en cours de saisie est passé : l'utilisateur qui vient de
    // choisir « dropbox » enregistre avant que ce type ne soit en base, et
    // sans lui on résoudrait les champs de l'ancien type.
    const champs = await destinations.champsDe(req.params.id, corps.type);

    // Le contrôle de forme AVANT l'obscurcissement (lot 33) : une fois passée
    // par `rclone obscure`, une valeur ne ressemble plus à rien — un code à
    // six chiffres rangé comme clé de validation ne se refuserait jamais.
    corps.valeurs = destinations.validerSaisie(champs, corps.valeurs);

    const aObscurcir = champs.filter((c) => c.obscurcir);
    if (aObscurcir.length && corps.valeurs && typeof corps.valeurs === 'object') {
      corps.valeurs = { ...corps.valeurs };
      for (const champ of aObscurcir) {
        const saisi = corps.valeurs[champ.key];
        // Vide = « garde celui d'avant », et `saveConfig` s'en charge : ne pas
        // l'obscurcir ici, sinon on rangerait la forme obscurcie de la chaîne
        // vide par-dessus un mot de passe qui marchait.
        if (typeof saisi !== 'string' || !saisi.trim()) continue;
        corps.valeurs[champ.key] = await rclone.obscure(saisi);
      }
    }

    const saved = destinations.saveConfig(req.params.id, corps, champs);
    applog.admin(req, `Destination « ${saved.name} » enregistrée.`);
    const complet = await destinations.publicConfigComplet(req.params.id);
    res.json({
      ok: true,
      destination: complet,
      // Ce qui condamne les prochains dépôts est dit AU MOMENT d'enregistrer,
      // pas découvert dans un journal à la prochaine exécution (lot 33).
      avertissements: complet?.avertissements || [],
    });
  })
);

/**
 * Supprime un cloud. Le stockage local est refusé — c'est le stockage de référence.
 *
 * Les documents déjà copiés là-bas ne sont PAS effacés : crabe n'a aucune
 * raison de vider l'espace de quelqu'un d'autre, et le dire est plus honnête
 * que de le faire. Ce qui part, ce sont les identifiants.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const supprime = destinations.deleteCloud(req.params.id);
    if (!supprime) return res.status(404).json({ error: 'Destination inconnue.' });
    applog.admin(req, `Espace de stockage « ${supprime.name} » supprimé.`);
    // Se retrouver sans aucune destination arrête les récupérations : c'est le
    // genre de conséquence qui doit être écrite au moment où elle survient, pas
    // découverte le lendemain dans un journal.
    if (!supprime.restant) {
      applog.warn(
        'destinations',
        'Plus aucun espace de stockage actif : les récupérations sont suspendues '
          + 'tant qu\'il n\'y a nulle part où déposer les documents.',
        { userId: req.user?.id, username: req.user?.username }
      );
    }
    res.json({ ok: true, restant: supprime.restant });
  })
);

/**
 * « Repartir de zéro » : oublie la session et toutes les valeurs conservées
 * d'une destination — sans supprimer la destination elle-même ni son
 * historique de dépôts (lot 57).
 *
 * Le geste qui manquait pendant l'incident du 25/08/2026 : quand une session
 * conservée prime sur les saisies, rien à l'écran ne permettait de s'en
 * débarrasser sans supprimer la destination entière. La ligne, le nom, le
 * type et l'historique restent ; seuls les identifiants et la session partent.
 */
router.post(
  '/:id/reinitialiser',
  asyncHandler(async (req, res) => {
    const remis = destinations.repartirDeZero(req.params.id);
    if (!remis) return res.status(404).json({ error: 'Destination inconnue.' });
    applog.admin(
      req,
      `Espace de stockage « ${remis.displayName || req.params.id} » remis à zéro : `
        + 'session et identifiants oubliés, la destination et son historique restent.'
    );
    res.json({ ok: true, destination: await destinations.publicConfigComplet(req.params.id) });
  })
);

/**
 * Remet en service l'espace de stockage de crabe.
 *
 * Le pendant de sa suppression — et il n'existe que pour lui : un cloud
 * supprimé se recrée, ses identifiants ayant été effacés, tandis que le stockage local
 * n'a jamais perdu son chemin et retrouve donc sa place d'un seul geste.
 */
router.post(
  '/local/restore',
  asyncHandler(async (req, res) => {
    const remis = destinations.restoreLocal();
    if (!remis) return res.status(404).json({ error: 'Destination inconnue.' });
    applog.admin(req, 'Espace de stockage de crabe remis en service.');
    res.json({ ok: true, destination: remis });
  })
);

router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    if (!destinations.driverFor(req.params.id)) {
      return res.status(404).json({ error: 'Destination inconnue.' });
    }
    res.json(await destinations.test(req.params.id, req.user.id));
  })
);

router.get('/:id/logs', (req, res) => {
  if (!destinations.driverFor(req.params.id)) {
    return res.status(404).json({ error: 'Destination inconnue.' });
  }
  res.json({ logs: destinations.recentLogs(req.params.id, Number(req.query.limit) || 20) });
});

/**
 * Synchronisation forcée, TOUS COMPTES CONFONDUS.
 *
 * La version de l'accueil ne traite que les documents de celui qui clique ;
 * celle-ci rattrape l'installation entière, et demande donc la permission de
 * gérer le stockage. Rien n'est retéléchargé chez les fournisseurs : les PDF
 * sont relus depuis le stockage local.
 *
 * `sync` sans identifiant traite toutes les destinations secondaires activées.
 */
router.get('/sync/state', (req, res) => res.json(destinationSync.progress()));

router.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const cibles = destinations.activeDestinations().filter((id) => id !== 'local');
    const lance = destinationSync.start({
      destinationIds: cibles,
      actor: { userId: req.user.id, username: req.user.username },
    });
    applog.admin(req, `Synchronisation forcée de toutes les destinations (${cibles.join(', ')}).`);
    res.json(lance);
  })
);

router.post(
  '/:id/sync',
  asyncHandler(async (req, res) => {
    if (!destinations.driverFor(req.params.id)) {
      return res.status(404).json({ error: 'Destination inconnue.' });
    }
    const lance = destinationSync.start({
      destinationIds: [req.params.id],
      actor: { userId: req.user.id, username: req.user.username },
    });
    applog.admin(req, `Synchronisation forcée de ${req.params.id}.`);
    res.json(lance);
  })
);

// ---------------------------------------------------------------------------
// L'autorisation menée par crabe (lot 34)
//
// Le pendant, pour les destinations, de la « connexion par navigateur » des
// connecteurs : crabe lance `rclone authorize` sur son serveur, ouvre l'URL
// d'autorisation dans sa fenêtre visible, et range le jeton — chiffré — quand
// la commande le rend. Le jeton ne passe par AUCUNE de ces routes : elles ne
// transportent que la vue publique de la fenêtre (état, message, flux noVNC).
// ---------------------------------------------------------------------------

/** Ouvre l'autorisation : rclone + fenêtre visible. */
router.post(
  '/:id/autorisation',
  asyncHandler(async (req, res) => {
    const destId = req.params.id;
    const fiche = destinations.pourAutorisation(destId);
    if (!fiche) return res.status(404).json({ error: 'Destination inconnue.' });
    if (fiche.dechiffrementEchoue) {
      // Autoriser par-dessus une configuration illisible finirait par écraser
      // ce qu'elle contient : on refuse, et on dit pourquoi (piège du lot 29).
      return res.status(503).json({
        error: 'La configuration enregistrée de cette destination est illisible '
          + '(phrase secrète du serveur absente ou changée). Corrigez d\'abord cela : '
          + 'autoriser maintenant écraserait ce qui est enregistré.',
      });
    }

    const vue = await autorisation.demarrer({
      userId: req.user.id,
      destId,
      type: fiche.type,
      nom: fiche.nom,
      valeurs: fiche.valeurs,
      // Le jeton va de la sortie d'rclone à la configuration chiffrée par ce
      // seul chemin. `indiceRegion` : le `hostname` vu passer dans la
      // redirection pCloud, sans lequel un compte européen ne répond pas.
      enregistrer: (jeton, indiceRegion) => {
        destinations.enregistrerJeton(destId, jeton, fiche.type === 'pcloud' ? indiceRegion : null);
      },
      // Le dossier de crabe, créé sur la destination sitôt le jeton rangé
      // (lot 35). La configuration est RELUE ici, après l'écriture : le mkdir
      // se joue donc sur le bloc exact des copies, jeton neuf et région
      // compris — jamais sur un bloc d'avant l'autorisation.
      creerDossier: () => destinations.creerDossierDeBase(destId),
    });

    applog.admin(req, `Autorisation de « ${fiche.nom} » ouverte dans la fenêtre de crabe.`);
    res.json({ ...vue, streamPath: STREAM_PATH });
  })
);

/** L'état de la fenêtre d'autorisation — le client l'interroge en boucle. */
router.get(
  '/:id/autorisation',
  asyncHandler(async (req, res) => {
    const vue = remoteBrowser.manager().status(req.user.id, autorisation.idFenetre(req.params.id));
    if (!vue) return res.status(404).json({ error: 'Aucune autorisation en cours.' });
    res.json({ ...vue, streamPath: STREAM_PATH });
  })
);

/** Un jeton de flux neuf, pour rebrancher un écran tombé. */
router.post(
  '/:id/autorisation/ticket',
  asyncHandler(async (req, res) => {
    const vue = remoteBrowser
      .manager()
      .status(req.user.id, autorisation.idFenetre(req.params.id), { withTicket: true });
    if (!vue) return res.status(404).json({ error: 'Aucune autorisation en cours.' });
    if (!vue.token) return res.status(409).json({ error: 'Cette autorisation est terminée.', ...vue });
    res.json({ ...vue, streamPath: STREAM_PATH });
  })
);

/**
 * Saisit un texte dans le champ actif de la fenêtre — le mot de passe du
 * fournisseur, dans la quasi-totalité des cas. Même règle que pour les
 * connecteurs : le corps de cette requête n'entre dans AUCUN journal.
 */
router.post(
  '/:id/autorisation/type',
  asyncHandler(async (req, res) => {
    const resultat = await remoteBrowser
      .manager()
      .typeText(req.user.id, autorisation.idFenetre(req.params.id), req.body?.text);
    if (!resultat.ok) return res.status(409).json({ error: resultat.error });
    res.json({ ok: true });
  })
);

/** Abandon : la fenêtre s'éteint, rclone est tué, rien n'est enregistré. */
router.delete(
  '/:id/autorisation',
  asyncHandler(async (req, res) => {
    const vue = await remoteBrowser.manager().stop(req.user.id, autorisation.idFenetre(req.params.id));
    if (!vue) return res.status(404).json({ error: 'Aucune autorisation en cours.' });
    applog.admin(req, `Autorisation de ${req.params.id} abandonnée.`);
    res.json(vue);
  })
);

module.exports = { router };
