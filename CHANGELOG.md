# Journal des versions

Chaque version publiée de crabe, la plus récente en haut.

Pour mettre à jour votre crabe : [docs/MISE-A-JOUR.md](docs/MISE-A-JOUR.md) (English: [docs/UPDATING.md](docs/UPDATING.md)).

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
