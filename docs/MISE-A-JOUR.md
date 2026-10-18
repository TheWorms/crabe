# Comment mettre à jour crabe

*English: [UPDATING.md](UPDATING.md)*

Cette page explique comment passer votre crabe à une nouvelle version, quand il
est installé avec Docker (le fichier `docker-compose.yml` fourni avec crabe).
Comptez cinq minutes.

crabe ne se met jamais à jour tout seul : c'est vous qui décidez quand.

---

## Avant de commencer

Ouvrez un terminal dans le dossier de votre crabe : celui qui contient le
fichier `docker-compose.yml` et le dossier `data`. Par exemple :

```bash
cd crabe
```

Toutes les commandes de cette page se tapent depuis ce dossier.

## 1. Mettre vos données de côté

Tout ce que crabe garde est dans le dossier `data` : votre compte, vos
identifiants chiffrés, vos documents, vos réglages. Faites-en une copie avant
de mettre à jour :

```bash
docker compose stop
sudo cp -a data "data-avant-mise-a-jour-$(date +%Y-%m-%d)"
```

- `docker compose stop` arrête crabe pendant la copie, pour qu'elle soit
  complète. Il redémarre à l'étape 2.
- `sudo` est nécessaire : les fichiers de `data` appartiennent à l'utilisateur
  de crabe. Votre mot de passe peut vous être demandé.
- La copie porte la date du jour, par exemple `data-avant-mise-a-jour-2026-10-13`.

Sous Windows : après `docker compose stop`, copiez le dossier `data` avec
l'explorateur de fichiers.

## 2. Mettre à jour

```bash
docker compose pull
docker compose up -d
```

- `docker compose pull` télécharge la nouvelle version.
- `docker compose up -d` redémarre crabe avec elle.

Vos données ne bougent pas. Si la nouvelle version doit modifier sa base, elle
le fait toute seule au démarrage. Attendez une minute que crabe redémarre.

## 3. Vérifier la version

Dans crabe, ouvrez **Administration › Système**. La ligne **Version de crabe**
affiche la version installée.

## 4. Recharger la page

Votre navigateur peut garder l'ancienne mise en page pendant une heure.
Rechargez la page de crabe en forçant :

- **Ctrl+Maj+R** sous Windows et Linux ;
- **Cmd+Maj+R** sur Mac.

## 5. Revenir à la version d'avant, si besoin

Si la nouvelle version ne vous convient pas, vous pouvez revenir à la
précédente.

1. Arrêtez crabe :

   ```bash
   docker compose down
   ```

2. Ouvrez `docker-compose.yml` avec un éditeur de texte. Trouvez la ligne qui
   commence par `image:` : elle se termine par `:latest`. Remplacez `latest`
   par le numéro de la version précédente, par exemple `0.1.7`. Enregistrez.

3. Remettez les données mises de côté à l'étape 1 (remplacez la date par celle
   de votre copie) :

   ```bash
   sudo mv data data-version-ecartee
   sudo cp -a data-avant-mise-a-jour-2026-10-13 data
   ```

4. Redémarrez crabe :

   ```bash
   docker compose pull
   docker compose up -d
   ```

Les documents récupérés après votre copie ne sont pas dans les données remises :
ils restent dans `data-version-ecartee`.

Pour revenir plus tard aux nouvelles versions, remettez `latest` à la place du
numéro, puis reprenez cette page depuis l'étape 1.

## 6. Voir ce qui a changé

Les nouveautés de chaque version sont dans le journal des versions :
[CHANGELOG.md](../CHANGELOG.md).

---

## Être prévenu des nouvelles versions

crabe peut vous dire qu'une nouvelle version existe : un bandeau en haut de la
page, et la fenêtre **Vérifier les mises à jour** dans
**Administration › Système**. Elles mènent à cette page.

Il faut pour cela la ligne `CRABE_UPDATE_REPO`, sous `environment:`, dans
`docker-compose.yml` : elle y est déjà dans le fichier fourni. crabe consulte
alors les versions publiées une fois par jour au plus, et n'envoie rien. Sans
cette ligne, ou si elle est vide, crabe ne demande rien à personne.
