# How to update crabe

*Français : [MISE-A-JOUR.md](MISE-A-JOUR.md)*

This page explains how to move your crabe to a new version when it is
installed with Docker (the `docker-compose.yml` file that comes with crabe).
It takes about five minutes.

crabe never updates itself: you decide when.

---

## Before you start

Open a terminal in your crabe folder: the one that contains the
`docker-compose.yml` file and the `data` folder. For example:

```bash
cd crabe
```

Run every command on this page from that folder.

## 1. Set your data aside

Everything crabe keeps is in the `data` folder: your account, your encrypted
credentials, your documents, your settings. Make a copy of it before you
update:

```bash
docker compose stop
sudo cp -a data "data-before-update-$(date +%Y-%m-%d)"
```

- `docker compose stop` stops crabe during the copy, so that the copy is
  complete. It starts again in step 2.
- `sudo` is needed: the files in `data` belong to crabe's own user. You may be
  asked for your password.
- The copy carries today's date, for example `data-before-update-2026-10-13`.

Two exceptions. If you wrote the secret passphrase (`CRABE_MASTER_PASSPHRASE`)
in `docker-compose.yml` or in a `.env` file, set that file aside too: without
it, your saved credentials can no longer be read. And if your documents are on
another disk mounted into the container, they are not in `data`: back them up
separately.

crabe also makes its own copy of the database, just before updating it
(`data/crabe.db.avant-migration-…`). It does not replace yours, which covers
the whole folder.

On Windows: after `docker compose stop`, copy the `data` folder with the file
explorer.

## 2. Update

```bash
docker compose pull
docker compose up -d
```

- `docker compose pull` downloads the new version.
- `docker compose up -d` restarts crabe with it.

Your data stays where it is. If the new version needs to change its database,
it does so by itself when it starts. Give crabe a minute to restart.

## 3. Check the version

In crabe, open **Administration › Système**. The **Version de crabe** line
shows the installed version.

## 4. Reload the page

Your browser may keep the old layout for up to an hour. Force a reload of the
crabe page:

- **Ctrl+Shift+R** on Windows and Linux;
- **Cmd+Shift+R** on Mac.

## 5. Go back to the previous version, if needed

If the new version does not suit you, you can go back to the previous one.

1. Stop crabe:

   ```bash
   docker compose down
   ```

2. Open `docker-compose.yml` in a text editor. Find the line that starts with
   `image:`: it ends with `:latest`. Replace `latest` with the number of the
   previous version, for example `0.1.7`. Save.

3. Put back the data you set aside in step 1 (replace the date with the one of
   your copy):

   ```bash
   sudo mv data data-set-aside-version
   sudo cp -a data-before-update-2026-10-13 data
   ```

4. Start crabe again:

   ```bash
   docker compose pull
   docker compose up -d
   ```

Documents fetched after your copy are not in the data you put back: they stay
in `data-set-aside-version`.

If you skip step 3, crabe refuses to start: its log (`docker compose logs`)
says « Démarrage refusé : Cette base a été mise à jour par une version plus
récente de crabe » (the database was updated by a newer version). Nothing was
written: put back the data from step 1, then start again.

To return to new versions later, put `latest` back in place of the number,
then follow this page again from step 1.

## 6. See what changed

What is new in each version is in the changelog (in French):
[CHANGELOG.md](../CHANGELOG.md).

---

## If you keep your old `docker-compose.yml`

Updating does not touch your `docker-compose.yml` file. Since version 0.2.0,
the one that comes with crabe has two more lines. Add them to yours with a text
editor, under the `shm_size:` line:

```yaml
    init: true
    # mem_limit: 3g
```

- `init: true` puts a real process 1 in the container: it passes the stop
  signal on to crabe and cleans up the processes that browsers leave behind.
- `mem_limit` caps the memory of the container. It is optional: the line stays
  commented out, the right value depends on your machine.

Under `ports:`, also replace `"3000:3000"` with `"0.0.0.0:3000:3000"`: the port
is then only open over IPv4. Over IPv6, Docker passes connections on under its
own address, and crabe could not tell where they come from.

Then restart crabe with `docker compose up -d`.

Also since version 0.2.0, crabe only accepts devices on a private network by
default (home, office, Tailscale). If you open it from another address, it
shows « Accès refusé depuis cette adresse » (access denied from this address).
To allow it, add the `CRABE_ALLOWED_CIDRS` variable under `environment:`: it
is explained in the `.env.example` file.

---

## Being told about new versions

crabe can tell you that a new version exists: a banner at the top of the page,
and the **Vérifier les mises à jour** window in **Administration › Système**.
Both lead to this page.

This needs the `CRABE_UPDATE_REPO` line, under `environment:`, in
`docker-compose.yml`: it is already there in the file that comes with crabe.
crabe then looks at the published versions at most once a day, and sends
nothing. Without that line, or if it is empty, crabe asks nobody anything.
