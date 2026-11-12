# Journal des versions

Chaque version publiée de crabe, la plus récente en haut.

Pour mettre à jour votre crabe : [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) (English: [docs/UPDATING.md](docs/UPDATING.md)).

---

## 1.0.2 — BlaBlaCar, Galaxus, Les Thés de la Pagode et PayByPhone sont fonctionnels (12/11/2026)

### Connecteurs
- **Quatre connecteurs passent « fonctionnels »** : BlaBlaCar (un reçu reconstitué par trajet), Galaxus (factures et confirmations de commande), Les Thés de la Pagode (les factures de vos commandes) et PayByPhone (vos relevés de stationnement). Ils ont tourné sur un compte réel : BlaBlaCar, Galaxus et Les Thés de la Pagode y ont rangé leurs documents ; PayByPhone s'y connecte et lit à chaque passage.
- La fiche des Thés de la Pagode ne dit plus « Pas encore essayé sur un vrai compte ».
- La page des connecteurs (`docs/CONNECTEURS.md`) suit : 54 fonctionnels, 2 en cours (Recraft, TotalEnergies), classement du 12 novembre 2026.

### Pour les mainteneurs
- `scripts/lot97-page-connecteurs.js` : les quatre quittent `EN_COURS` pour `FONCTIONNELS`, la date du classement change. Leurs notes techniques disent ce qui a été mesuré. Le statut du catalogue (`connector_catalog`) n'est pas touché : sur un crabe déjà installé, un connecteur se rend disponible par « Approuver », dans Administration › Applications. Pas de migration.

---

## 1.0.1 — votre nom n'entre plus dans l'archive, même quand le site l'affiche (12/11/2026)

### Proposer un service
- **crabe retire de lui-même le nom que le site affiche près du compte.** Mesuré sur le premier relevé réel : une boutique écrivait le prénom et le nom du compte dans le lien « Voir mon compte » de son en-tête, et dans le bouton de son menu de déconnexion. Le texte d'un lien est gardé — il dit le chemin —, et le nom l'était avec lui quand le champ facultatif « votre nom » restait vide. Désormais, dans la zone du compte (un lien, un bouton, une infobulle dont la classe, l'identifiant, l'étiquette ou le chemin parlent de compte, d'utilisateur, de connexion, ou ceux de leurs trois parents les plus proches), un libellé n'a que des mots ordinaires — « Mon profil », « Se déconnecter », « Retour à votre compte » ; un mot qui n'en est pas un est celui du compte. Il devient « … », et il est retiré de toute l'archive : les autres copies, le titre des pages, le parcours, les clics, les noms de fichiers. Le LISEZ-MOI dit combien de mots ont été retirés ainsi, jamais lesquels.
- Sur les quatre pages de ce relevé, seul le nom a été retiré : le menu des catégories, les liens de la liste des commandes, « Mon profil » et « Se déconnecter » restent lisibles.
- Ce que la règle ne voit pas. Un nom écrit hors de la zone du compte — un titre « Les commandes de Camille », un lien ordinaire — n'est retiré que s'il a été donné dans le champ « votre nom » : l'aide du champ le dit. Les mots détectés ne sont écrits nulle part, ni dans l'archive, ni au journal ; huit au plus par relevé.

### Pour les mainteneurs
- `server/releve-site.js` : `SIGNAUX_COMPTE` (des mots entiers, seuls ou accolés à leur voisin — « connecteurs » ou « compteur » n'en sont pas, « client » seul non plus), `MOTS_DE_COMPTE`, `motsDuCompte`, la zone suivie dans `nettoyerHtml` (l'élément et ses trois ancêtres), deux passes dans `nettoyerInstantane` (le nom cherché sur toute la page, puis retiré partout), `etat.motsDuSite` à côté des mots donnés (`motsDe`), et le clic sur le lien du compte (`clicDuCompte`). Pas de migration.

---

## 1.0.0 — il vous manque un service ? Relevez son site (12/11/2026)

### Proposer un service
- **Un service qui manque se propose depuis crabe.** Dans Administration › Applications, l'onglet « Proposer un service », à droite de « Diagnostic » : vous tapez l'adresse du site, crabe ouvre sa fenêtre — celle des connexions — et vous y faites ce que vous faites d'habitude : vous connecter, aller à vos factures, en ouvrir une. crabe relève le chemin et en tire une archive, qu'il envoie pour vous à la fin — ou que vous téléchargez. Elle suffit pour écrire le connecteur : plus de console de navigateur, plus de relevé collé page par page.
- **Un parcours guidé.** À côté de l'écran du site, quatre étapes se cochent d'elles-mêmes à mesure que crabe les voit : la page de connexion, la connexion, la liste des factures, une facture ouverte. L'étape en cours dit quoi faire. Ce sont des repères, pas des barrières : « Terminer le relevé » répond à tout moment, et l'archive dit alors ce qui lui manque — « Incomplet : aucune facture ouverte ». « Relever cette page maintenant » sert quand une liste met du temps à se charger, ou change sans changer d'adresse.
- **Ce que l'archive contient.** Chaque page, réduite à son squelette : ses balises, et le texte de ses liens, boutons, titres et étiquettes. Les champs des formulaires, par leur nom et leur type. La suite des redirections, et le nom des cookies posés. Chaque clic, par l'élément cliqué. La forme des réponses du site — leurs clés, pas leurs valeurs. Et pour chaque document, la voie par laquelle il arrive — un téléchargement, la réponse à un appel de la page, un nouvel onglet —, le clic qui l'a déclenché, s'il est un PDF, son nombre de pages et son poids.
- **Ce qu'elle ne contient jamais.** Ce que vous tapez : aucun champ n'est lu, aucun envoi de formulaire. La valeur d'un cookie. Une adresse complète : les identifiants des chemins sont masqués, les paramètres réduits à leur nom. Le texte de la page hors liens, boutons, titres et étiquettes — et dans ceux-là, ni courriel, ni chiffre ; une infobulle ou un nom de fichier suivent la même règle, un commentaire de la page n'y entre pas. Une valeur renvoyée par le site : la clé d'une réponse elle-même perd ses chiffres, et disparaît si elle ressemble à une valeur. Un document : crabe l'oublie sitôt compté.
- **Votre nom, si le site l'écrit dans un lien ou un titre**, crabe ne peut pas le deviner : un champ facultatif permet de le lui donner avant le relevé, et il le retire de l'archive, noms de fichiers compris. Il n'est ni enregistré, ni journalisé ; il est retiré sous toutes ses formes (capitales, avec ou sans accent), mais pas du nom du site, qui reste tel quel. Tout dans l'archive est du texte, que vous pouvez ouvrir avant d'envoyer ; une page de l'archive ouverte dans un navigateur ne charge ni n'exécute rien.
- **Envoyer, ou télécharger.** À la fin du relevé, deux gestes. « Envoyer » fait partir de crabe une demande d'ajout d'un connecteur, archive jointe : elle dit le site, ce que le relevé contient, votre nom de compte et votre adresse de courriel — pour qu'on vous réponde —, et le message que vous y ajoutez si vous le souhaitez (les documents voulus, un code reçu à la connexion). Rien d'autre ne part, et rien ne part sans ce clic. La fenêtre le rappelle avant l'envoi : aucune donnée personnelle n'est enregistrée ni transférée dans le zip. Une fois la demande partie, la fenêtre se referme et crabe vous le confirme. « Télécharger » vous donne l'archive, sans rien envoyer. L'envoi passe par le serveur de courriel réglé dans Administration › SMTP : sans lui, « Envoyer » le dit et reste éteint. Un relevé part trois fois au plus ; sa ligne dit quand il est parti.
- **Vos relevés** restent sous « Proposer un service » : les vingt derniers, trente jours, marqués complets ou incomplets, chacun à envoyer, à télécharger, à recommencer ou à supprimer. Chaque compte ne voit que les siens, et ils partent avec lui ; l'entretien de chaque nuit efface ceux de plus de trente jours, même si personne ne rouvre la page.
- Ce qu'il faut savoir. Le volet occupe toute la largeur de la page. L'onglet est réservé aux comptes qui gèrent les applications. Un serveur crabe n'a qu'une fenêtre : un seul relevé à la fois, et pas pendant qu'une connexion est ouverte — le bouton le dit, avec la raison. La fenêtre se ferme après dix minutes sans geste, trente au plus ; fermée ainsi, ou par « Fermer / Abandonner » (qui demande confirmation dès qu'une page est relevée), elle ne garde rien. Un relevé resté ouvert — l'onglet fermé par mégarde — se reprend depuis la page dans les cinq minutes ; passé ce délai, la fenêtre se ferme et rien n'est gardé. Sur un serveur sans la fenêtre de crabe, le relevé ne s'ouvre pas, et la page dit ce qui manque.
- Ce que le relevé ne voit pas. Un site bâti en composants fermés ne montre ni ses champs ni ses liens à crabe : ses étapes ne se cochent pas, mais le parcours, les clics et les documents sont relevés quand même. Une facture que le site affiche en page, sans fichier, n'est pas un document : l'archive est dite incomplète, et la page affichée y est. Un site qui refuse la fenêtre de crabe — une vérification anti-robot qui tourne en rond — ne se relève pas : dites-le dans le message de la demande.

### Pour les mainteneurs
- `server/releve-site.js` : l'enregistreur (branché sur le contexte du navigateur avant la première page, par l'option `avantNavigation` de la fenêtre), le masquage, les quatre étapes, le rangement (`<données>/releves/u<compte>/`, fichiers en 0600, `CRABE_RELEVES_DIR` pour le déplacer). `server/routes/releves.js` : `/api/releves`, derrière la permission « Gérer les applications » (`apps.manage`) ; `POST /api/releves/<id>/envoyer` envoie la demande par `server/mailer.js`, qui accepte désormais une pièce jointe et une adresse de réponse. L'adresse où part la demande n'est écrite ni à l'écran, ni dans l'archive, ni au journal.
- Le masquage qui fait foi est celui du serveur : la page relevée est celle d'un tiers, et ce qu'elle rend est une donnée. Chaque copie de page est reconstruite balise par balise — une liste fermée d'attributs, les textes réécrits et échappés —, jamais nettoyée par retraits : rien de ce que la page a écrit n'y est recopié tel quel. Toute entrée est coupée avant d'être lue : un texte fabriqué pour ralentir le masquage ne ralentit rien.
- Tout est borné : soixante pages et douze mégaoctets de copies par relevé, trois cents appels, soixante documents ; chaque attente (une page figée, une réponse qui ne finit pas, un téléchargement) a son délai. L'archive est écrite avant que la fenêtre se ferme : un disque qui refuse laisse la fenêtre ouverte, et rien d'écrit à moitié.
- La fenêtre de connexion reçoit quatre options, sans effet pour les services ni pour les stockages : `avantNavigation`, `recadrage` (pendant un relevé, seuls les écrans à mot de passe sont recadrés), `doublons` (un onglet de même chemin n'est pas refermé) et `sursisDetachementMs` (cinq minutes pour reprendre un relevé, une minute partout ailleurs). Pas de migration.

---

## 0.2.29 — sur l'accueil, on choisit combien de lignes on lit (11/11/2026)

### Accueil
- **« Suivi d'actions » et « Mes connecteurs » montrent 5, 10, 15, 20 ou 50 lignes, au choix.** Le réglage est dans « Personnaliser l'accueil », sous la ligne de chacun des deux blocs, comme la taille de page de « Synchronisation » et de « Derniers documents ». Le bloc change tout de suite. Chaque bloc a son réglage, chaque compte le sien, et il vous suit d'un appareil à l'autre.
- **Sans rien régler** : dix lignes dans « Suivi d'actions », cinquante vignettes dans « Mes connecteurs ».
- **Ce qui n'est pas montré est compté.** « Suivi d'actions » montre d'abord ce qui demande un geste — les échecs, puis les services à configurer —, ensuite les réussites, des plus récentes aux plus anciennes. Sous la liste, une phrase dit le reste, par nature : « Et 3 autres services : 1 à configurer, 2 à jour. » Le bilan en tête du bloc compte toujours tout. « Mes connecteurs » fait de même — « Et 7 autres connecteurs, dont 2 à vérifier. » —, et la vignette « Ajouter » reste là.
- **Une copie restée en échec se voit toujours**, en plus des lignes choisies : elle ne sera pas reprise toute seule.
- **Un accueil figé garde ce réglage** : « Figer mon accueil » protège la disposition des blocs, pas ce qu'on y lit.
- Ce qui change sans rien régler. Jusqu'ici, « Suivi d'actions » montrait tout ce qui demande un geste, puis six réussites ; il montre maintenant dix lignes en tout. Avec plus de quatre services qui demandent un geste, il y a donc moins de réussites à l'écran qu'avant, et au-delà de dix, des services en défaut que la liste ne montre plus : la phrase les nomme, le bilan les compte, « 15 lignes », « 20 lignes » ou « 50 lignes » les ramènent.
- Ce que le réglage ne fait pas. Les deux blocs ne se feuillettent pas : ils montrent le début de leur liste, cinquante lignes au plus. Au-delà, la phrase compte le reste ; la page « Suivi d'actions » — le titre du bloc y mène — et Profil › Connecteurs installés montrent tout. Quand l'administrateur a retiré la personnalisation de l'accueil à un compte, le panneau ne s'ouvre pas, et ce réglage avec lui : le choix déjà fait continue de s'appliquer.

### Pour les mainteneurs
- Deux préférences par compte, `home.suivi.lignes` (10) et `home.connecteurs.lignes` (50), dans une liste fermée (`LIGNES_BLOC`) distincte des tailles de page. `PUT /api/users/me/preferences` refuse une valeur hors liste et dit lesquelles sont permises. Pas de migration.
- `GET /api/home` rend jusqu'à cinquante réussites (`successes`) — un service en pause n'y prend la place d'aucune —, et `suiviLignes`, `connecteursLignes`, `lignesCatalog`. Le bloc se redessine avec ce qu'il a déjà reçu : un choix n'appelle que l'enregistrement de la préférence. Le réglage est un menu du panneau (`reglageBlocBorne`, à côté de `reglageBlocListe`) : un refus ramène le bloc et le menu à la valeur d'avant.

---

## 0.2.28 — les statistiques de l'accueil arrivent en mouvement (11/11/2026)

### Accueil
- **Les statistiques s'animent à l'ouverture de l'accueil.** Les compteurs montent jusqu'à leur valeur — les documents du mois, le total, le poids, les connecteurs actifs —, les cadres se posent l'un après l'autre, les barres poussent, les courbes se tracent de gauche à droite, l'anneau se ferme part après part pendant que son total monte. Le tout dure une seconde.
- **Une fois par ouverture.** L'accueil se redessine à chaque rafraîchissement — la fin d'une récupération, une pause, un graphique coché ou décoché : rien ne se rejoue alors, les chiffres changent sur place. Revenir sur l'accueil depuis un autre écran, c'est l'ouvrir ; cliquer sur le logo ou sur « Accueil » quand on y est déjà, aussi.
- **Ce qui ne bouge pas** : un chiffre à zéro, « jamais », la date de la dernière récupération réussie. Et rien ne s'anime si votre système demande moins de mouvement, ni quand l'accueil s'ouvre dans un onglet à l'arrière-plan : les chiffres sont là d'emblée.
- L'entrée terminée, le bloc est au caractère près celui d'avant : rien ne reste dans la page. Pendant la seconde qu'elle dure, en revanche, un lecteur d'écran ou une recherche dans la page peuvent tomber sur un chiffre encore en chemin.

### Pour les mainteneurs
- Pas de migration, rien côté serveur : `web/app.js` et `web/style.css` seulement.
- L'entrée se pose sur le rendu et s'en retire (`animerStatistiques`, la classe `stats-entree`) : les fonctions qui écrivent les statistiques et leurs graphiques ne changent pas.

---

## 0.2.27 — la mémoire en une ligne, et crabe montre qu'il travaille (11/11/2026)

### Administration › Système
- **La mémoire tient en une ligne**, dans « Infrastructure », sous « Disque restant » : la pastille (« suffisante », « trop peu pour une fenêtre de connexion », « trop peu pour une récupération »), ce qu'il reste à crabe, et un bouton « Configurer » — comme l'heure du serveur. La carte de la 0.2.26, sous les deux colonnes, n'existe plus.
- **« Configurer » ouvre une fenêtre.** En haut, une jauge : ce qu'il reste à crabe, et les deux réserves posées dessus à leur place. Dessous, les mesures — la machine, le plafond du service, crabe lui-même, ce qui tourne — et les trois réglages de la 0.2.26, inchangés.
- **La jauge suit la saisie** : avant d'enregistrer, elle montre ce que crabe ferait de la mémoire qui reste avec les réserves tapées. « Valeurs par défaut » remplit les champs avec celles de crabe sans rien enregistrer ; « Enregistrer » applique et ferme. « Actualiser » relit la mesure sans toucher à ce qui est tapé. Échap ferme la fenêtre.
- Sans la permission « Configurer la sécurité », le bouton s'appelle « Détails » : la fenêtre montre les réserves, sans les champs.

### crabe montre qu'il travaille
- **Le logo agite les pinces**, dans l'en-tête, tant qu'une opération tourne — une récupération, une synchronisation, un renommage, une optimisation. Au repos, il ne bouge pas. Quand la file attend que la mémoire revienne, il reste immobile et un point bleu suit le nom. Si votre système demande moins de mouvement, rien ne s'anime : un point ambre se pose sur le logo.
- **L'onglet du navigateur le dit aussi**, pour qui est parti faire autre chose. Son titre commence par un signe qui tourne et dit ce qui se passe — « ◐ 1 récupération en cours — Crabe » —, son icône porte une pastille : ambre quand crabe travaille, bleue quand la file attend la mémoire. À la fin, le titre et l'icône de l'écran reviennent.
- **La file dit pourquoi elle attend** : « en attente de mémoire » dans le bandeau, « elle attend que la mémoire revienne » sur la carte du service — là où crabe écrivait « elle démarre dans un instant » pendant une attente qui peut durer trois minutes.
- Ce que le témoin ne fait pas. Il suit vos opérations, comme le bandeau — pas celles des autres comptes. Un onglet laissé en arrière-plan pendant une opération la suit jusqu'au bout, plus lentement (une lecture toutes les quinze secondes, parfois une par minute quand le navigateur ralentit l'onglet) ; un onglet laissé en arrière-plan au repos ne voit pas partir une récupération planifiée avant qu'on y revienne. Un navigateur n'anime pas l'icône d'un onglet, d'où la pastille ; certains ne la changent pas toujours.

### Corrigé
- **Le bandeau « en attente »** : depuis la file d'attente des récupérations, son point se posait au-dessus de sa phrase et le bandeau s'étirait sur toute la largeur.
- **Sur téléphone, le bouton d'une fenêtre faisait 160 px de haut** — « Enregistrer » dans « Date et heure », par exemple. Il retrouve sa hauteur.

### Pour les mainteneurs
- Pas de migration.
- `GET /api/operations` : une opération en attente porte `memoire` — vrai quand la file attend la mémoire. `scheduler.attenteDeMemoire()`.
- Deux icônes d'onglet, `web/favicon-travail.png` et `web/favicon-attente.png`, servies avec le reste de l'interface.

---

## 0.2.26 — la mémoire se lit et se règle dans l'administration (11/11/2026)

### Administration › Système
- **Une carte « Mémoire »**, sous « Logiciel » et « Infrastructure ». À gauche, la mémoire à l'instant : ce qu'il reste à crabe — la mesure même que lisent la fenêtre de connexion et la file des récupérations —, avec une pastille qui dit ce qu'elles en feraient maintenant (« suffisante », « trop peu pour une fenêtre de connexion », « trop peu pour une récupération ») ; la mémoire de la machine ; le plafond du service quand il y en a un, ce qu'il occupe et le cache repris à la demande ; ce que pèse crabe lui-même ; et ce qui tourne en ce moment — la récupération en cours (son service n'est nommé que si elle est à vous), celles qui attendent leur tour, une fenêtre de connexion ouverte. « Actualiser » relit la mesure, dont l'heure est affichée à côté.
- **Trois réglages**, à droite, là où le code portait des valeurs fixes — justes pour 4 Go de mémoire, et pour cette taille seulement :
  - la réserve pour ouvrir une fenêtre de connexion (1 200 Mo par défaut) : en dessous, « Se connecter » est refusé, et le refus cite désormais la réserve réglée ;
  - la réserve avant une récupération (600 Mo par défaut) : en dessous, la file attend que la mémoire revienne avant de lancer la suivante ;
  - l'attente la plus longue (180 secondes par défaut) : passé ce délai, la récupération part quand même ; à 0, la file n'attend jamais.
- Les réglages s'appliquent aussitôt, sans redémarrage, et chaque changement s'écrit au journal d'administration. « Valeurs par défaut » rend celles de crabe.
- crabe refuse une valeur hors bornes, et une réserve plus grande que la mémoire dont il dispose : elle ne serait jamais atteinte — la fenêtre ne s'ouvrirait plus, la file attendrait à chaque départ.
- La carte se lit avec n'importe quelle permission d'administration ; les réglages demandent « Configurer la sécurité ».

### Pour les mainteneurs
- Migration 76 : trois colonnes dans `app_settings` (`memoire_fenetre_mo`, `memoire_recuperation_mo`, `memoire_attente_s`). Vides, elles valent les valeurs par défaut : rien ne change pour une installation qui ne règle rien. crabe copie la base avant de l'appliquer, comme à chaque migration.
- `GET` et `PUT /api/system/memoire` ; `server/memoire.js`.

---

## 0.2.25 — Recraft rétabli, et des explications qui se rangent (11/11/2026)

### Corrigé
- **Recraft : « Le portail de facturation s'est ouvert mais ne s'est pas affiché »**, une seconde après son ouverture — et non au bout des trente secondes annoncées. Le portail de facturation (Stripe) affiche désormais son lien de retour avant la liste des factures ; crabe prenait ce lien pour le signe que la page était prête, la lisait trop tôt et n'y trouvait rien. Il attend maintenant l'historique lui-même — son intertitre ou une première ligne de facture, trente secondes au plus —, puis les lignes. Une facture affichée sous un intertitre que crabe ne connaît pas est lue quand même.
- Si l'historique ne s'affiche vraiment pas, le message dit le délai réellement attendu, et le journal garde les repères de la page : un rapport suffit alors à corriger.

### Fenêtre de connexion
- **« Ne plus afficher »** : le bandeau d'explication (« Connectez-vous comme sur le site : la fenêtre se fermera d'elle-même… ») se range d'un clic et ne revient plus — ni à la reconnexion suivante, ni pour un autre service, ni sur un autre poste : le choix est gardé sur votre compte. À chaque reconnexion, il prenait jusqu'à trois lignes au-dessus de l'écran du site, davantage sur un téléphone.
- Une pastille « ? », en haut de la fenêtre, le remontre le temps d'une connexion : l'indice propre à un service que vous connectez pour la première fois reste à un clic.
- Sur un écran étroit, le bouton passe sous le texte au lieu de lui prendre de la largeur.

---

## 0.2.24 — crabe compresse lui-même ses réponses (11/11/2026)

### Plus rapide
- **L'interface voyage trois à quatre fois plus légère, même sans mandataire devant crabe.** Jusqu'ici, seule une installation placée derrière un mandataire qui compresse (Caddy et son `encode`, nginx et son `gzip`) en profitait ; servi en direct sur son port, crabe envoyait ses fichiers tels quels. Il compresse désormais lui-même les scripts, la feuille de style et les pages — environ 1 Mo au premier affichage, ramené à 250 Ko — ainsi que les réponses de l'API. Sur un réseau lent (Wi-Fi faible, accès à distance par VPN), la première ouverture et les longues listes s'en ressentent.
- Chaque fichier de l'interface est compressé une seule fois, au démarrage, puis gardé en mémoire ; il est refait s'il change. Personne n'attend une compression : tant qu'elle n'est pas prête, le fichier part en clair.

### Ce qui ne change pas
- Les PDF, les archives et tout ce qui se télécharge partent tels quels, comme les images et la fenêtre de connexion.
- Derrière un mandataire qui compresse déjà, rien à régler : il laisse passer ce que crabe a compressé.
- Un client qui ne demande pas de compression reçoit les réponses en clair, comme avant.
- Aucune dépendance nouvelle, aucun réglage : la compression est celle de Node.

---

## 0.2.23 — le bilan de stabilité et de rapidité, suite (11/11/2026)

### Plus stable
- **Une récupération planifiée attend que la mémoire revienne avant d'ouvrir son navigateur.** Jusqu'ici, seule la fenêtre de connexion regardait la mémoire : une récupération partait par-dessus une fenêtre ouverte et une visite d'entretien, et c'est le plafond de mémoire du service qui tranchait, en fermant un navigateur au hasard. L'attente dure trois minutes au plus ; passé ce délai, la récupération part quand même, et le journal le dit. Elle reste en file pendant l'attente : un arrêt de crabe ne la perd pas.
- **Le profil de navigateur d'une récupération longue reste réservé jusqu'au bout.** Une récupération peut durer quarante-cinq minutes, sa réservation du profil tombait au bout de quinze : une fenêtre de connexion, ou une visite d'entretien, pouvait ouvrir le même profil pendant qu'elle travaillait encore. La réservation tient désormais tant que la récupération tourne.
- **L'état de santé répond sans attendre le réseau** : la première vérification de mise à jour de la journée pouvait le retenir dix secondes, assez pour que le contrôle de santé du conteneur compte crabe en panne.

### Plus rapide
- **« Mes documents » sur le stockage local ne pose plus une question au stockage par document** (jusqu'à trois, en réalité) : chaque dossier est lu une fois par affichage. Sur un partage réseau, c'était plusieurs secondes pendant lesquelles crabe ne répondait à personne.
- **La page s'ouvre en moins d'allers-retours** : les préférences, les services, le carnet et l'état de la fenêtre de connexion se demandent ensemble, et non l'un après l'autre.

---

## 0.2.22 — le bilan de stabilité et de rapidité (11/11/2026)

### Plus rapide
- **L'accueil et le suivi s'affichent environ deux fois plus vite sur un compte chargé** (mesuré sur 45 services et 5 000 documents : l'accueil de 545 à 280 ms, le suivi de 270 à 130 ms, la liste des services de 100 à 40 ms). Le logo de chaque destination était relu en base pour chaque document, et le catalogue des services recalculé jusqu'à six fois par écran.
- **Les fichiers de l'interface se gardent dans le navigateur** tant qu'ils n'ont pas changé (un an sous leur empreinte, au lieu d'une heure), et sortent sans lecture de session ni de compte.
- **La session n'est plus réécrite en base à chaque requête** : son échéance avance par pas de cinq minutes. Un onglet ouvert écrivait dans la base toutes les quelques secondes.
- **Un onglet caché n'interroge plus crabe** ; il reprend dès qu'il redevient visible.
- Un index sur les exécutions pour « la dernière de chaque service », la question que l'interface pose toutes les quatre secondes pendant une récupération.

### Plus stable
- **Une récupération abandonnée après sa durée maximale ne ferme plus le navigateur de la fenêtre de connexion** ni celui d'une visite d'entretien, quand l'un des deux était ouvert au même moment.
- **À l'arrêt de crabe, la file des récupérations n'avance plus** : celles qui attendaient restent en file et reprennent au démarrage suivant, au lieu d'être lancées puis perdues.
- **Un verrou de profil n'est rendu que par celui qui le tient** : une récupération très longue ne libère plus, en finissant, le verrou qu'une autre avait repris entre-temps.
- **Une fenêtre de connexion fermée pendant sa mise en route** ne laisse plus son navigateur ouvert ; un navigateur dont l'ouverture échoue à mi-chemin est refermé.
- **Une visite d'entretien qui ne rend jamais la main** n'arrête plus toutes les visites suivantes : passé dix minutes, le tour continue sans elle.
- Les tâches planifiées remplacées sont retirées pour de bon à chaque changement de planification (elles s'accumulaient en mémoire).
- La base met ses statistiques à jour et replie son journal d'écriture chaque nuit et à l'arrêt ; ce journal ne dépasse plus 64 Mo sur le disque.

### Interface
- **Si crabe ne répond pas à l'ouverture** (redémarrage, réseau coupé), la page le dit et propose de réessayer, au lieu de se recharger en boucle.
- Une coupure de réseau s'annonce en français (« crabe ne répond pas… ») et non par le message brut du navigateur ; une coupure d'un instant ne ferme plus la fenêtre de connexion.
- La fenêtre de connexion et la synchronisation des destinations n'envoient plus qu'une demande à la fois sur un réseau lent.

---

## 0.2.21 — la fenêtre de connexion n'est plus refusée sur une mémoire mal comptée (10/11/2026)

### Corrigé
- **« Se connecter » / « Se reconnecter » refusait d'ouvrir la fenêtre (« Mémoire insuffisante ») pendant les récupérations**, alors que la mémoire était là : le cache des fichiers (documents, copies vers les stockages, base), que le système rend dès qu'on en a besoin, comptait comme occupé. Mesuré pendant une série de récupérations planifiées : 803 Mo annoncés, 1 511 Mo réellement disponibles. Seule la mémoire qui ne se libère pas compte désormais, sous le plafond du service (`MemoryHigh` / `MemoryMax`, ou la limite du conteneur Docker).

### Amélioré
- **Le refus faute de mémoire dit ce qui occupe crabe** : la récupération en cours et depuis quand, combien attendent leur tour, ou une visite d'entretien des sessions — sans nommer les services d'un autre compte. Sans rien en cours, il le dit aussi.

---

## 0.2.20 — l'autorisation des espaces de stockage rétablie (10/11/2026)

### Corrigé
- **« Se connecter » / « Renouveler l'autorisation » d'un espace de stockage (pCloud, Dropbox, Google Drive…) échouait depuis la 0.2.0** sur « La fenêtre de connexion n'a pas pu s'ouvrir » : la fenêtre, qui refuse les adresses de la machine depuis cette version, refusait aussi le serveur de retour qu'rclone ouvre pour l'autorisation. Elle le laisse désormais passer, lui seul (`127.0.0.1` et `localhost`, au port qu'rclone a donné), et pour cette seule fenêtre ; les fenêtres de connexion des services ne changent pas.
- **Un jeton collé dans la case « Jeton d'accès » d'une carte remplie avec un bloc de configuration rclone était ignoré** : les dépôts continuaient avec l'ancien. Il remplace désormais celui du bloc, et l'état de l'autorisation affiché sur la carte est celui du jeton réellement utilisé.
- **Les refus de l'autorisation s'affichent** (application pCloud incomplète ou refusée, rclone sans réponse…) au lieu de la phrase générique, et l'indicateur d'attente s'arrête quand la tentative a échoué.

---

## 0.2.19 — les connexions par la fenêtre dans les journaux (02/11/2026)

### Journaux
- **Chaque connexion par la fenêtre « Se connecter » a sa ligne dans Administration › Logs › Connecteurs** : « Connexion enregistrée » ou « Connexion non enregistrée » (fermée sans enregistrer, après le délai, en erreur), sa raison, le nombre de vérifications restées sans preuve. Les filtres « Succès » et « Échecs » s'y appliquent.
- **Un « Rapport » pour une connexion qui n'a pas abouti**, comme pour une récupération : la tentative, ses tentatives précédentes et tout ce que la fenêtre a écrit, anonymisé — jamais ce que vous avez tapé.
- **La fiche d'un service dit sa dernière connexion par la fenêtre quand elle n'a pas abouti**, avec son rapport à télécharger.

### Corrigé
- **La fenêtre de connexion pouvait rester ouverte** alors que la connexion était terminée : « Enregistrer » répondait « La fenêtre de connexion n'est plus ouverte » et seul « Annuler » la fermait. Elle relit désormais l'état et se ferme. La fin d'une connexion ne se joue plus qu'une fois (la question sur les identifiants pouvait revenir deux fois).

### Interne
- Migration 75 (additive) : la table des connexions par la fenêtre.

---

## 0.2.18 — les reçus BlaBlaCar (02/11/2026)

### Corrigé (essai réel de la 0.2.17)
- **BlaBlaCar : aucun reçu n'était créé.** Chaque ligne de la page « Paiements & remboursements » commence par une phrase d'accessibilité qui contient elle aussi « Payé le … » ; crabe s'y accrochait et ne reconnaissait aucune ligne. Il lit maintenant l'opération, la date du trajet, l'itinéraire et le montant, chacun sur sa ligne — un reçu reconstitué par trajet, comme prévu.
- **BlaBlaCar : « Aucune nouvelle facture » alors que rien n'avait été lu.** Des opérations affichées et aucune reconnue font désormais échouer la récupération, en le disant.

---

## 0.2.17 — Galaxus et BlaBlaCar se connectent, Recraft lit son portail (02/11/2026)

### Corrigé (premier essai réel de la 0.2.16)
- **Galaxus et BlaBlaCar : la connexion ne s'enregistrait jamais.** La fenêtre vérifiait la session en la rejouant dans un navigateur automatisé, que ces deux sites refusent (Galaxus coupe la connexion, BlaBlaCar sert une page vide). La preuve se lit désormais dans la fenêtre elle-même, sur des repères de leurs pages : la liste des commandes Galaxus, les lignes de paiement BlaBlaCar.
- **Recraft : « Aucune nouvelle facture » alors que rien n'avait été lu.** Le portail de facturation était relevé avant de s'être affiché. crabe attend maintenant que l'historique des factures s'affiche, et, s'il ne s'affiche pas, échoue en le disant.

---

## 0.2.16 — Recraft, Galaxus, BlaBlaCar (02/11/2026)

### Nouveaux services (en cours d'essai)
- **Recraft** : vos factures d'abonnement. Vous ouvrez la connexion une fois dans la fenêtre (Recraft y demande une vérification anti-robot) ; crabe ouvre ensuite votre page d'abonnement, puis le portail de facturation Stripe, et télécharge chaque facture en PDF.
- **Galaxus** : les documents de vos commandes — factures et confirmations de commande. Galaxus refuse les navigateurs automatisés : la connexion est gardée dans un profil de navigateur, comme pour Boulanger.
- **BlaBlaCar** : BlaBlaCar ne fournit pas de reçu ; crabe en reconstitue un **par trajet**, à partir de vos paiements et remboursements, une fois le trajet passé de 7 jours. Connexion gardée dans un profil de navigateur (BlaBlaCar demande une vérification anti-robot).

Les trois ont été écrits sur des pages relevées sur un vrai compte ; leur première récupération réelle reste à faire.

---

## 0.2.15 — un autre compte sur le même site (01/11/2026)

### Services
- **Plusieurs comptes sur le même site.** « Ajouter un autre compte » (Options avancées de la fiche d'un service installé) crée un second compte du service — par exemple un Amazon personnel et un Amazon professionnel —, avec sa propre connexion, ses propres identifiants, ses propres récupérations et sa propre planification. Il s'affiche « Amazon (2) », ou sous le nom que vous lui donnez (« Amazon — Pro »). Ses documents vont dans le dossier du service, « Amazon », sous leur propre dossier de compte. Jusqu'à neuf comptes par service.

### Interne
- Migration 74 (additive) : le nom d'un autre compte.

---

## 0.2.14 — la reconnexion automatique (01/11/2026)

### Connexions
- **Une session expirée se rouvre seule.** Quand une récupération (ou la visite d'entretien) trouve la session d'un service expirée, crabe ouvre la page de connexion du site, y écrit l'identifiant et le mot de passe du service — ceux de sa fiche, ou de l'entrée du carnet qu'elle suit —, vérifie la session comme la fenêtre « Se connecter », puis reprend la récupération. Un essai par service et par 24 h. Devant un captcha, une vérification anti-robot ou un code reçu, il s'arrête et n'essaie plus avant une connexion faite à la main ; le message de la session expirée dit alors pourquoi. Active par défaut, désactivable en tout et service par service (Administration › Automatisation › Reconnexion automatique).
- **Tous les services connectés par la fenêtre ont maintenant un identifiant et un mot de passe facultatifs** (Options avancées de leur fiche). Jusqu'ici, un seul en avait : pour les autres, le remplissage automatique de la fenêtre (0.2.11), « Enregistrer ces identifiants » (0.2.12) et le carnet (0.2.13) n'avaient rien à utiliser.

### Corrigé
- **La visite d'entretien n'enregistrait jamais la session prolongée** (0.2.8) : le navigateur se fermait avant que la session soit lue, et chaque visite d'une session vivante finissait en « visite interrompue ».

### Interne
- Migration 73 (additive) : la table des essais de reconnexion et ses deux interrupteurs.

---

## 0.2.13 — le carnet d'identifiants (01/11/2026)

### Identifiants
- **Un carnet d'identifiants, dans Profil › Identifiants.** Une adresse et un mot de passe, sous un nom (« Perso », « Boulot ») ; la fiche d'un service s'y relie par son choix « Identifiants ». Une entrée reliée à plusieurs services se change une fois, dans le carnet, et tous la suivent — récupérations, fenêtre de connexion, remplissage automatique.
- Rien n'entre dans le carnet d'office : les fiches existantes gardent leurs identifiants tant que vous ne les reliez pas. Une entrée encore reliée à un service ne se supprime pas. « Enregistrer ces identifiants » depuis la fenêtre range dans la fiche du service, qui ne suit alors plus d'entrée.
- Chaque entrée est chiffrée (XChaCha20-Poly1305, sous une clé dérivée de la phrase secrète par Argon2id) et liée à son compte : recopiée ailleurs dans la base, elle ne se déchiffre pas. Un mot de passe n'est jamais réaffiché.

### Fichiers
- **Les reçus reconstitués ne bloquent plus le renommage.** Leur forme (`<service>_recu-reconstitue_<commande>.pdf`) n'était reconnue par aucune règle : sous « Sans le nom du service », ils restaient « douteux » et le renommage refusait de démarrer. Ils perdent maintenant le nom du service comme les autres documents (`recu-reconstitue_<commande>.pdf`), et les prochains se déposent ainsi.
- **« Renommer quand même ».** S'il reste des documents au nom non reconnu (et aucune collision), ce bouton renomme les autres et les laisse sous leur nom actuel ; il n'est plus nécessaire de les traiter d'abord.

### Interne
- Migration 72 (additive) : la table du carnet et le lien d'une fiche.

---

## 0.2.12 — enregistrer depuis la fenêtre ce qu'on y a tapé (01/11/2026)

### Fenêtre de connexion
- **« Enregistrer ces identifiants pour la prochaine fois ? »** Quand vous vous connectez en tapant votre adresse et votre mot de passe dans la fenêtre « Se connecter », crabe vous le propose une fois la connexion confirmée, si ce ne sont pas déjà ceux de la fiche du service. Oui : ils sont rangés, chiffrés, dans la fiche, et la prochaine connexion les remplit toute seule. Non : ils sont oubliés aussitôt. Ils ne sont jamais réaffichés ni écrits dans un journal, et ne restent en mémoire que le temps de la fenêtre.

---

## 0.2.11 — les identifiants enregistrés remplis tout seuls (01/11/2026)

### Fenêtre de connexion
- **Le formulaire du site se remplit tout seul.** Quand un identifiant et un mot de passe sont enregistrés dans la fiche du service, la fenêtre « Se connecter » les écrit d'elle-même dans le formulaire du site, sans clic sur « Saisir mes identifiants ». Une connexion en deux pages est remplie aux deux : l'adresse sur la première, le mot de passe sur la seconde. Un champ déjà rempli n'est jamais réécrit, et rien n'est envoyé : la case de vérification du site, un code reçu et la validation restent à vous. La fenêtre dit ce qu'elle a rempli.
- « Saisir mes identifiants » n'efface plus le champ de l'identifiant quand aucun identifiant n'est enregistré.

### Interface
- **Nouveau logo** : le crabe, dans l'en-tête, sur la page de connexion et dans l'onglet du navigateur.

---

## 0.2.10 — coller par le clic droit dans la fenêtre de connexion (01/11/2026)

### Fenêtre de connexion
- **Clic droit › Coller et Ctrl+V marchent dans la fenêtre.** Un texte collé dans le champ « Coller un texte » est saisi dans le site comme avant, et il est désormais aussi dans le presse-papiers de la fenêtre : on peut le recoller dans un autre champ par le clic droit ou le clavier. crabe essayait de le faire passer par l'affichage à distance (la fenêtre visible) ; mesuré, le texte n'arrivait jamais au navigateur. C'est maintenant le navigateur de la fenêtre qui l'écrit dans son propre presse-papiers.
- Quand crabe est ouvert en HTTPS, ce que vous avez copié sur votre poste passe dans la fenêtre dès que la souris y entre (le navigateur demande l'autorisation une fois) : clic droit › Coller et Ctrl+V y collent directement, sans passer par le champ.

---

## 0.2.9 — la ligne de commande attend son tour (01/11/2026)

### Ligne de commande
- **`crabe recuperer` attend son tour.** crabe ne fait tourner qu'une récupération à la fois ; quand d'autres passaient avant, la commande répondait « La récupération n'a pas démarré en 30 s » alors que la récupération attendait dans la file, et partait plus tard sans être suivie. La commande dit maintenant sa place (« 2 récupération(s) avant celle-ci »), attend, puis suit la récupération comme avant.

---

## 0.2.8 — des connexions entretenues chaque jour (01/11/2026)

### Connexions
- **Une visite d'entretien chaque jour.** Pour chaque service connecté par la fenêtre « Se connecter », crabe ouvre une fois par jour sa page de compte avec la connexion enregistrée, sans rien télécharger. Si le site prolonge la connexion à l'usage, crabe garde la connexion prolongée : elle ne meurt plus faute d'avoir servi entre deux récupérations mensuelles. Chaque service a son heure, tirée entre 9 h et 21 h ; les visites passent une à une, jamais pendant une récupération ni quand la fenêtre de connexion du service est ouverte.
- Une connexion que la visite trouve expirée n'est plus visitée avant une nouvelle connexion ; aucune notification n'est envoyée, l'avertissement vient de la récupération, comme avant. Après deux vérifications de sécurité de suite, un service n'est plus visité pendant une semaine.
- Ne sont pas visités : impots.gouv.fr (un rejeu y a déjà coûté la connexion), Alma (sa connexion vit aussi dans l'onglet), TotalEnergies (sa garde réseau), et les services sans page de compte connue. Un site qui coupe sa connexion au bout de quelques heures (Darty, Bricomarché, Coyote) n'est pas sauvé par une visite par jour.
- **Administration › Automatisation › Entretien des sessions** : l'heure de chaque service, sa dernière visite, ce que le site annonce de sa connexion (le nombre de cookies, ceux de session, la plus lointaine expiration — jamais une valeur), pourquoi un service n'est pas visité ; un interrupteur général et un par service. Active par défaut.

### Interne
- Migration 71 (additive) : la table des visites, l'interrupteur général et celui de chaque service.

---

## 0.2.7 — échéanciers TotalEnergies, Private Sport Shop plus patient (01/11/2026)

### Connecteurs
- **TotalEnergies récupère aussi vos échéanciers** (« Échéancier d'activation », « Avenant d'échéancier »). Pour un compte mensualisé, ce sont eux qui font office de factures : la facture de régularisation ne vient qu'une fois l'an. Un échéancier encore « en cours », sans document à télécharger, est compté sans être tenu pour manqué.
- **Private Sport Shop ne se trompe plus sur un jeton expiré.** Quand le jeton d'accès du site a expiré, sa page des commandes renvoyait vers l'accueil, et crabe concluait au bout de 45 secondes que la page avait changé. Il reconnaît maintenant l'accueil en quelques secondes, attend que le site ait renouvelé le jeton, et rouvre la page des commandes, deux fois au plus.
- **Le refus d'accès de Cloudflare est reconnu** (« Attention Required! », vu sur Le Petit Vapoteur). crabe disait que la page des commandes « ne ressemblait plus » à celle qu'il connaît ; il dit maintenant que le site a présenté sa vérification de sécurité, et qu'il faut rouvrir la connexion depuis la fiche du service. Vaut pour toutes les boutiques qui partagent cette lecture.

### Installation
- crabe demande désormais **Node.js 22 ou plus récent** (Node 20 n'est plus maintenu). L'image Docker n'est pas concernée : elle embarque son propre Node.

---

## 0.2.6 — un rapport qui suffit à refaire une lecture (26/10/2026)

### Signaler un problème
- **Le journal de chaque récupération dit ce que crabe a fait, page par page** : l'ouverture du navigateur, chaque page (son chemin, son titre, son code HTTP, son temps de chargement), les éléments que crabe y a cherchés et combien il en a trouvé, les appels de la page à son serveur (une liste chargée après coup s'y voit), ses cadres et les erreurs de sa console.
- **Quand une lecture échoue, le rapport commence par ce qui a manqué** : l'étape, l'erreur exacte, ce que crabe cherchait et ce qu'il a trouvé à la place (« `table.orders` absente ; 3 `div.order-card` »), et ce que montrait la page.
- **Le rapport devient une archive** quand la page a pu être relevée : avec le texte, la structure de la page (où chaque texte est remplacé par sa longueur, et les valeurs et adresses sont vidées) et une capture où chaque texte et chaque image sont effacés. La mise en page se voit, rien de vous ne s'y lit.
- **Une récupération détaillée, en ligne de commande** : `node bin/crabe.js recuperer <service> --detail` (avec Docker : `docker compose exec crabe node bin/crabe.js recuperer <service> --detail`) capture chaque étape, même quand tout réussit, suit le journal à l'écran et enregistre le rapport.

---

## 0.2.5 — des rapports qui permettent de corriger un connecteur (26/10/2026)

### Signaler un problème
- **Le rapport d'un échec dit ce que montrait la page.** Quand un service change ses pages ou affiche autre chose que prévu, le rapport disait seulement qu'un élément attendu n'était jamais apparu. Il dit désormais lequel, les pages parcourues jusque-là, et ce que montrait la page à l'arrêt : son titre, ses intertitres, les messages qu'elle affiche, ce qui y est visible, et les obstacles reconnus (captcha, vérification anti-robot, bandeau de cookies, formulaire de connexion, demande de code). De quoi corriger un connecteur sans avoir de compte sur le service.
- Rien de personnel n'y entre : ni la valeur d'un champ, ni le contenu de la page, ni capture d'écran. Les adresses sont réduites au site et au chemin, les nombres sont masqués, et les salutations (qui portent un nom) comme les textes qui contiennent une adresse e-mail sont écartés. Relisez quand même le rapport avant de l'envoyer.
- Ces lignes apparaissent aussi dans le déroulé du **Détail** d'une récupération, mises en avant comme le détail technique de l'échec.

---

## 0.2.4 — vos factures Claude à leur numéro (26/10/2026)

### Connecteurs
- **Les factures d'Anthropic (abonnement Claude) portent leur numéro.** La page de facturation de Claude mène désormais directement au PDF de chaque facture, et crabe ne reconnaissait pas cette forme : ces factures étaient rangées sous un nom illisible (`anthropic_2026-08_3fa2….pdf`), et l'accueil affichait une référence de plus de cent caractères. Elles sont maintenant rangées sous leur numéro (`anthropic_2026-05_ABCD1234-0006.pdf`), datées par la date d'émission écrite dans le document.
- **Les factures déjà rangées sont renommées**, au prochain passage d'Anthropic, partout où elles sont déposées : crabe relit leur numéro dans le PDF et ne change que la fin du nom, dans le même dossier. Avec les précautions du renommage des documents : une sauvegarde de la base d'abord, jamais un fichier écrasé, jamais pendant un autre renommage ou une synchronisation (il attend alors le passage suivant). Si le nom voulu est déjà pris, le document garde le sien, et le journal dit pourquoi.
- La base ne garde plus le lien d'accès de ces factures : seule une référence courte, qui ne permet pas de le retrouver. Rien n'est retéléchargé.

### Interface
- **Le détail d'une récupération est fermé par défaut** : ses quatre volets s'ouvrent dans **Administration › Logs › Réglages**. Quand le déroulé, le rapport et les récupérations précédentes sont fermés, le bouton **Détail** n'apparaît plus dans Logs › Connecteurs, ni « Voir ce qui s'est passé » sur la fiche d'un service.
- **L'accueil affiche le numéro de la facture** quand la référence du fournisseur n'est qu'un identifiant technique.
- Dans **Administration › Logs › Connecteurs**, le statut d'une récupération, **Détail** et **Rapport** tiennent sur une seule ligne.
- Une version redéployée sous le même numéro se voit aussi dès la première ouverture : l'adresse des fichiers de l'écran porte désormais leur empreinte.

---

## 0.2.3 — des connexions qui tiennent plus longtemps (26/10/2026)

### Connecteurs
- **Onze services gardent ce que le site prolonge** : Airbnb, Amazon, Anthropic, Deezer, Free Mobile, Hetzner, Infomaniak, Mistral, Qobuz, SoundCloud et Spotify. Ils rejouaient votre connexion dans un navigateur neuf puis le refermaient, en perdant ce que le site venait de rafraîchir : la connexion enregistrée vieillissait d'un passage à l'autre. Après chaque récupération réussie, crabe garde désormais l'état le plus récent, comme le faisaient déjà dix autres services. Une récupération qui échoue ne remplace jamais une bonne connexion.
- La connexion renouvelée ne garde que les cookies des domaines du service, comme une connexion enregistrée.

### Voir ce qui s'est passé, sans ligne de commande
- **Le détail d'une récupération, à l'écran.** Dans **Administration › Logs › Connecteurs**, le bouton **Détail** d'une récupération ouvre son déroulé de bout en bout : chaque ligne dans l'ordre, l'endroit précis d'un échec mis en avant, ses récupérations précédentes, et son rapport à copier ou télécharger pour un signalement.
- **Depuis la fiche d'un service en erreur**, « Voir ce qui s'est passé » ouvre la même chose : chaque compte y voit ses propres récupérations, même sans accès aux journaux.
- Ces quatre volets (le déroulé, le rapport, l'accès depuis la fiche, les récupérations précédentes) s'activent ou se désactivent dans **Administration › Logs › Réglages**.

### Interface
- La fenêtre de connexion ne promet plus une connexion « valable environ un an » : c'est le site qui décide, parfois trente minutes, parfois quelques heures. Elle dit le geste qui la fait durer : cocher « Se souvenir de cet appareil » ou « Rester connecté » quand le site le propose.

---

## 0.2.2 — l'écran suit les mises à jour (26/10/2026)

### Interface
- **L'écran se met à jour avec crabe.** Après une mise à jour, le navigateur pouvait garder l'ancien écran jusqu'à une heure, ou jusqu'à un rechargement forcé. Les pages demandent désormais leurs fichiers à une adresse qui porte la version de crabe : une version neuve se voit dès la première ouverture.

### Signaler un problème
- **Le bouton « Rapport » apparaît aussi sur une réussite partielle** : une récupération qui a ramené des documents mais n'en a pas obtenu d'autres. C'est là qu'une facture manque sans que la ligne soit rouge.
- **Un document refusé dit d'où il venait**, dans le journal et donc dans le rapport : le site et le chemin, sans identifiants ni paramètres.
- La fenêtre de connexion ne parle plus de « réseau local » pour un domaine que votre filtre DNS bloque (une réponse 0.0.0.0) : elle dit que c'est sans doute ce filtre.

---

## 0.2.1 — les factures de l'abonnement Claude (26/10/2026)

### Connecteurs
- **Anthropic (abonnement Claude) récupère vos factures.** crabe prenait un lien de la page de facturation de Claude pour une facture, et ce premier échec arrêtait tout. Il n'ouvre plus que les liens qui mènent à une facture, et une facture qui ne descend pas n'empêche plus les suivantes : l'écran dit combien n'ont pas été obtenues, le prochain passage les réessaie. Si la page de Claude change encore, le rapport d'échec dit quels liens ont été vus et ce qui est arrivé à la place d'une facture.

---

## 0.2.0 — plus sûr par défaut (26/10/2026)

### Sécurité
- **crabe ne répond plus qu'à votre réseau local, par défaut.** Sans réglage, seuls les appareils d'un réseau privé l'ouvrent : la machine elle-même, le réseau de la maison ou du bureau, Tailscale. Toute autre adresse voit une page « Accès refusé depuis cette adresse » qui dit quoi faire. Jusqu'ici, sans réglage, toutes les adresses passaient. **Si vous ouvrez crabe depuis une adresse publique**, posez la variable `CRABE_ALLOWED_CIDRS` avant de mettre à jour : elle est expliquée dans le fichier `.env.example`, et `*` ouvre crabe à toutes les adresses.
- **La phrase secrète n'apparaît plus dans le journal** au premier démarrage : elle est écrite dans `data/phrase-secrete`, et le journal dit comment la lire (`sudo cat data/phrase-secrete`). Vous pouvez partager vos journaux pour demander de l'aide sans la dévoiler. Une installation existante garde sa phrase.
- **Chaque connexion ouvre une session neuve** : un identifiant de session connu avant la connexion ne vaut plus rien après.
- **La fenêtre de connexion d'un service** lit l'adresse de votre appareil comme le reste de crabe : derrière un reverse proxy, une adresse inventée ne la trompe plus.
- **La couleur de l'avatar** n'accepte plus que des couleurs au format `#rrggbb`, celles que propose le profil.
- **L'export de vos données** range chaque document sous un nom nettoyé : aucun nom ne peut sortir du dossier de l'archive.
- **Bibliothèques à jour** : les alertes de sécurité connues sont corrigées, dont celles de l'envoi de courriel (nodemailer 10).
- **La fenêtre de connexion d'un service ne sert plus qu'à se connecter** : elle n'ouvre plus les fichiers du serveur ni les adresses de votre réseau local, ne peut plus envoyer un fichier du serveur vers un site, et ne connaît plus la phrase secrète.
- **Changer votre mot de passe déconnecte vos autres appareils.** Un mot de passe réinitialisé par l'administrateur aussi.
- **Un code de double authentification ne sert qu'une fois.**
- **Un gestionnaire des rôles qui n'est pas administrateur** ne peut plus se donner le rôle Administrateur, ni le retirer à un administrateur.
- **Les noms de vos documents** ne s'affichent plus aux autres comptes pendant une synchronisation.

### Fiabilité
- **crabe vérifie sa clé au démarrage.** Avec une autre phrase secrète, ou un fichier `master.salt` qui n'est pas le sien, il refuse de démarrer sans rien écrire, et son journal dit quoi faire. Jusqu'ici, il démarrait, puis rien ne marchait, et ce que vous ressaisissiez entre-temps devenait illisible à son tour.
- **Une copie de la base avant chaque mise à jour** : `data/crabe.db.avant-migration-…`, les trois plus récentes sont gardées. Revenir à une version plus ancienne sans remettre la base d'avant est refusé, avec la marche à suivre.
- **Les récupérations planifiées ne se perdent plus** : un retard de quelques minutes est accepté, un passage manqué part quand même, et une échéance passée pendant que crabe était arrêté est rattrapée à son redémarrage.
- **Un espace de stockage qui ne répond plus** n'est plus réessayé document par document : ses dépôts sont reportés un quart d'heure, et « Synchroniser » les rattrape.
- **Un partage réseau non monté** (SMB, NFS) ne reçoit plus vos documents à son insu : crabe refuse d'y écrire, et le dit.
- **La suppression d'un compte** dont les fichiers n'ont pas pu être effacés partout est gardée et retentée, au lieu d'être tenue pour faite.
- crabe s'arrête moins souvent d'un coup (un export sur un disque plein, un outil manquant) ; quand il s'arrête, la cause est dans son journal.

### Signaler un problème
- **Un rapport à envoyer quand une récupération échoue.** Dans **Administration › Logs › Connecteurs**, chaque échec a un bouton **Rapport** : un fichier texte avec la version de crabe et de ses outils, et tout le déroulé de la récupération, jusqu'à l'endroit du code où elle s'est arrêtée. crabe en retire les noms de compte, les adresses e-mail, les adresses IP, les jetons et le détail des adresses web. Relisez-le, puis joignez-le à votre signalement.
- **Chaque ligne du journal d'une récupération porte son numéro**, à l'écran comme dans le journal du service ou `docker logs` (`[n° 123]`) : une récupération se suit d'un bout à l'autre, et elle dit quand elle commence, avec quelle version, et comment elle finit.

### Docker
- Le `docker-compose.yml` fourni ajoute `init: true` (l'arrêt transmis à crabe, les processus laissés par les navigateurs récoltés), explique un plafond de mémoire facultatif, et n'ouvre plus le port qu'en IPv4 : en IPv6, Docker cachait l'adresse réelle des appareils, et la règle du réseau local ne pouvait pas s'appliquer. Si vous gardez votre ancien fichier, la page [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) dit quoi y changer.

---

## 0.1.9 — des échecs mieux expliqués (18/10/2026)

### Fiabilité
- **Site hors ligne** : quand un site est injoignable, crabe le dit en gris au lieu d'annoncer une session expirée. Rien à faire de votre côté : le prochain essai a lieu à la prochaine récupération planifiée, dont la date est indiquée.
- **Un site hors ligne se voit à son icône** : grisée sur l'accueil, dans le Profil et dans la fiche du service, avec la date de la dernière récupération réussie. Elle reprend sa couleur dès que le site répond de nouveau.
- **La fenêtre de connexion laisse plus de temps** et dit ce qu'il faut afficher pour que crabe confirme votre connexion. Quand elle refuse d'enregistrer, elle en donne la raison.
- **Une récupération bloquée est arrêtée au bout de 45 minutes**, comme prévu, et les suivantes reprennent.

### Connecteurs
- **Nouveau, en cours d'essai : Les Thés de la Pagode.** crabe récupère les factures de vos commandes ; vous vous connectez vous-même, dans la fenêtre que crabe ouvre. Pas encore essayé sur un vrai compte.
- **Alma et Battle.net** rejoignent les connecteurs qui fonctionnent.
- **Boulanger** : la fenêtre s'ouvre sur la page de connexion actuelle du site et vous amène à la liste de vos commandes.
- **TotalEnergies** : la récupération suit le même chemin que les autres boutiques protégées par une vérification de sécurité. Toujours à l'essai ; dites-nous ce qui se passe. Rouvrez la connexion une fois après la mise à jour.
- **AutoDoc** : la connexion se vérifie dans la fenêtre de connexion elle-même. Quand vos commandes s'y affichent, « Enregistrer » enregistre. Si l'enregistrement vous était refusé alors que vos commandes étaient à l'écran, rouvrez la connexion une fois après la mise à jour.
- **Les Thés de la Pagode et L'Île aux Épices** ont leur icône dans la [liste des connecteurs](docs/CONNECTEURS.md).

---

## 0.1.8 — mettre à jour plus simplement (13/10/2026)

### Mettre à jour
- Nouvelle page « Comment mettre à jour crabe », en français et en anglais : [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md).
- Quand une nouvelle version existe, la fenêtre « Vérifier les mises à jour » et la bannière de nouvelle version mènent directement à cette page et aux nouveautés.
- Ce journal des versions, complété à chaque version.

### Connecteurs
- **Nouveau, en cours d'essai : TotalEnergies** (électricité et gaz). crabe récupère les factures de votre espace client ; les échéanciers ne sont pas pris.
- **Vous vous connectez vous-même**, dans la fenêtre que crabe ouvre. Ensuite, crabe lit la liste de vos factures et les télécharge, sans rien cliquer ni modifier sur votre compte.
- **Pas encore essayé sur un vrai compte** : s'il ne récupère rien, le message dit ce qui a bloqué ; signalez-le pour que la lecture soit corrigée.
- Dans le catalogue, il arrive marqué « Pas encore testé » : l'administrateur de votre crabe le rend disponible dans **Administration › Applications**, bouton **Approuver**.

### Interface
- Mes documents : l'explorateur n'affiche plus le bouton « Copier le chemin ».
- Le README utilise les noms actuels des écrans.

---

## 0.1.7 — une interface repensée (13/10/2026)

### Interface
- Nouveau menu sous l'avatar : Mon profil, Administration, Déconnexion.
- Profil et Administration s'ouvrent en pleine page, avec une adresse par section.
- « Mes documents » peut maintenant s'afficher en explorateur de dossiers. On passe de l'un à l'autre dans Profil › Interface, et l'affichage de base reste disponible.
- Nouvelle page « Suivi d'actions ».
- La fiche d'un connecteur a été refaite.
- Administration › Système › « Vérifier les mises à jour » ouvre une fenêtre qui dit si une version plus récente existe, avec le lien pour la voir.
- Le Store est plus lisible sur téléphone.

### Connecteurs
- Nouveaux : Battle.net, Alma, Private Sport Shop.
- L'Eau d'Île-de-France et Private Sport Shop passent dans les connecteurs fonctionnels.
- 18 services qu'il n'est pas possible de récupérer aujourd'hui (certaines banques, fournisseurs d'énergie et opérateurs) ne sont plus proposés dans le logiciel. Leur liste reste consultable dans `docs/CONNECTEURS.md`.

### Confidentialité
- Le journal de la fenêtre de connexion n'enregistre plus l'adresse complète des pages visitées.

### À savoir
- Les captures d'écran du README montrent encore l'interface précédente. Elles seront mises à jour dans une prochaine version.
- Après la mise à jour, rechargez la page avec Ctrl+Maj+R : le navigateur peut garder l'ancienne mise en page pendant une heure.

---

## 0.1.6 — l'Eau d'Île-de-France en cours d'essai (11/10/2026)

- **Nouveau, en cours d'essai : l'Eau d'Île-de-France.** crabe récupère les factures d'eau listées dans « Historique de mes factures » de votre espace client.
- **Vous vous connectez vous-même**, dans une fenêtre que crabe ouvre. Ensuite, crabe prend les factures une à une, par leur icône de téléchargement, et rien d'autre : il ne touche ni au paiement, ni à vos coordonnées, ni au reste de la page.
- **Seules les factures du contrat affiché** sont prises. Si vous avez plusieurs contrats, dites-le.
- **Pas encore essayé sur un vrai compte** : le connecteur est dans le groupe « En cours » de la page des connecteurs. S'il ne récupère rien, le message dit ce qui a bloqué ; signalez-le pour que la lecture soit corrigée.
- Dans le catalogue, il arrive marqué « Pas encore testé » : l'administrateur de votre crabe le rend disponible dans **Paramètres › Applications**, bouton **Approuver**.
- La liste complète, et où en est chacun : [docs/CONNECTEURS.md](docs/CONNECTEURS.md).

---

## 0.1.5 — trois boutiques de plus (11/10/2026)

- **Nouveau : Alfaliquid, Le Petit Vapoteur et e-liquide-fr.** crabe récupère les factures de vos commandes dans ces trois boutiques en ligne.
- **Vous vous connectez vous-même**, dans une fenêtre que crabe ouvre, comme sur le site ; ensuite, crabe lit vos commandes et prend les factures sans rien cliquer.
- **Le Petit Vapoteur**, jusqu'ici seulement annoncé, est désormais pris en charge : la boutique est protégée contre les robots, c'est donc vous qui vous connectez, dans la fenêtre.
- **e-liquide-fr** : chaque facture, qui est une page du site, est enregistrée en PDF telle que la boutique l'affiche.
- **Essayées sur un vrai compte** : les trois ont déjà rangé de vraies factures et rejoignent les services qui fonctionnent. La fiche de Gandi ne dit plus qu'il n'a jamais été essayé.
- **Dans le catalogue**, elles arrivent marquées « Pas encore testé » : l'administrateur de votre crabe les rend disponibles à tous dans **Paramètres › Applications**, bouton **Approuver**.
- **Toujours à l'essai** : Bouygues Telecom, Engie, Orange, PayByPhone, Qobuz, Scaleway, SFR et Vinted sont écrits, mais n'ont encore jamais récupéré de document sur un vrai compte. Si vous utilisez l'un d'eux, dites ce qui se passe.
- La liste complète, et où en est chacun : [docs/CONNECTEURS.md](docs/CONNECTEURS.md).

---

## 0.1.4 (06/10/2026)

- **Nouveau : Gandi.** Les factures de chacune de vos organisations — toutes, ou celles que vous choisissez. Chaque organisation a son dossier, à son nom, sur tous vos espaces de stockage.
- **Réparés ou étendus** : Impots.gouv.fr se connecte et lit à nouveau vos documents ; Bricomarché récupère le ticket de caisse de vos achats en magasin ; Decathlon télécharge vos factures quand le site les propose.
- **Une récupération à la fois** : les demandes attendent leur tour, et l'accueil dit combien passent avant la vôtre.
- **La couleur dit la cause d'un échec** : orange, la session a expiré et il suffit de vous reconnecter ; rouge, la connexion a été refusée ou autre chose a échoué.
- **Mes documents se trie** par date de récupération, date du document, service, nom ou taille, dans les deux sens.
- **Moins d'identifiants à l'écran** : dans Mes documents et sur la carte d'un service, vous voyez le nom du compte, plus son numéro ni son adresse e-mail.
- **pCloud** se connecte avec votre propre application pCloud (le README explique comment l'obtenir), et un espace de stockage qui refuse les dépôts le dit sur sa carte.
- **Des messages plus clairs** : deux documents du même nom ne s'écrasent plus, un document refusé dit dans le journal ce qu'il était, et les statistiques de l'accueil comptent juste.
- **Mises à jour** : si vous avez activé la vérification, crabe voit enfin les nouvelles versions publiées.
- La liste des connecteurs, et où en est chacun : la page `docs/CONNECTEURS.md` du dépôt. L'Eau d'Île-de-France rejoint les services annoncés.

---

## Versions antérieures

Notes rédigées après coup, d'après l'historique du projet.

### 0.1.3 — corrections de sécurité (13/09/2026)

- **Corrections de sécurité**, et rien d'autre.

### 0.1.2 — la mise en pause, et de nouveaux connecteurs (10/09/2026)

- **Mettre un service en pause** : un interrupteur sur sa carte l'arrête sans le désinstaller. Sa connexion au site et les documents déjà rangés restent ; rallumé, il rattrape ce qu'il a manqué.
- **Nouveaux** : AutoDoc, Coyote, Uber (les reçus de vos trajets) et Atma Kitchenware (un reçu reconstitué pour chaque commande). SEPIG, Atlantic'eau et Mint Énergie arrivent en ébauche, faute de compte pour les essayer. SEPIG et Mint Énergie ont été retirés depuis : voir `docs/CONNECTEURS.md`.
- **Étendus** : Ameli récupère vos relevés mensuels et votre attestation de droits, en vous connectant vous-même dans la fenêtre ; Airbnb parcourt tous vos séjours pour en prendre les reçus ; Bricomarché lit votre historique d'achats et reconstitue un reçu quand une commande n'a pas de facture. La CAF repasse en « bientôt disponible ».
- **Des récupérations plus sûres** : un document se prend dans l'onglet où le site l'ouvre ; une récupération qui n'a rien obtenu ne s'affiche plus « Succès » ; trois échecs de même cause l'arrêtent au lieu de s'acharner.
- **Les notifications** ont leur écran et leur cloche, avec un aperçu des dernières non lues.
- **Stockage** : la carte kDrive dit d'avance quelles offres n'ouvrent pas WebDAV, et un espace WebDAV sans adresse est refusé à l'enregistrement.
- **À l'écran** : le bandeau des opérations rejoint l'en-tête, et l'accueil montre ses blocs pendant qu'il charge.
- Il n'y a pas eu de version 0.1.1.

### 0.1.0 — première version publique (28/08/2026)

- Première version publique de crabe.
