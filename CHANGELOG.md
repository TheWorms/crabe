# Journal des versions

Chaque version publiée de crabe, la plus récente en haut.

Pour mettre à jour votre crabe : [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) (English: [docs/UPDATING.md](docs/UPDATING.md)).

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
