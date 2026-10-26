#!/bin/sh
# Entrypoint du conteneur crabe.
#
# Trois responsabilités, rien d'autre :
#   1. préparer le volume de données (/data) ;
#   2. garantir les deux secrets de service — fournis par l'environnement,
#      sinon lus dans le volume, sinon générés UNE fois et écrits dedans ;
#   3. abandonner root avant de lancer l'application.
#
# Le compte administrateur, lui, n'est PAS l'affaire de l'entrypoint : quand la
# base est vide, l'application sert un écran de création du premier compte
# (web/login.html, routes /api/auth/premier-compte) qui se referme dès qu'un
# utilisateur existe. CRABE_ADMIN_PASSWORD reste honoré par l'application
# (server/index.js, bootstrapAdmin) pour les installations automatisées : posé
# dans l'environnement, il crée le compte au démarrage et l'écran ne s'affiche
# jamais.
set -eu

DATA_DIR="${CRABE_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" "${CRABE_LOCAL_PATH:-$DATA_DIR/documents}" "${HOME:-$DATA_DIR/navigateur}"

genere() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
}

# La phrase secrète chiffre tous les identifiants enregistrés. Générée au
# premier démarrage si absente, elle est écrite dans le volume (droits 600) et
# n'est JAMAIS affichée : un journal se colle vite dans une demande d'aide
# publique (lot 112). Le journal dit seulement où la lire.
if [ -z "${CRABE_MASTER_PASSPHRASE:-}" ]; then
  FICHIER_PHRASE="$DATA_DIR/phrase-secrete"
  if [ ! -s "$FICHIER_PHRASE" ]; then
    # Bilan du 25/10/2026 : une base ou un sel déjà là, sans phrase, ce n'est
    # pas un premier démarrage — une restauration incomplète, ou une phrase
    # retirée du compose. En fabriquer une neuve rendait tous les identifiants
    # enregistrés illisibles, en silence. Refus, sans rien écrire.
    if [ -e "$DATA_DIR/crabe.db" ] || [ -e "$DATA_DIR/master.salt" ]; then
      echo "crabe : Démarrage refusé : ce dossier de données a déjà une base, mais"
      echo "crabe : aucune phrase secrète (ni CRABE_MASTER_PASSPHRASE, ni le fichier"
      echo "crabe : data/phrase-secrete). Une phrase neuve rendrait illisibles tous"
      echo "crabe : les identifiants enregistrés. Remettez le fichier"
      echo "crabe : data/phrase-secrete de votre sauvegarde, ou la variable"
      echo "crabe : CRABE_MASTER_PASSPHRASE d'origine, puis redémarrez."
      exit 78
    fi
    genere > "$FICHIER_PHRASE"
    chmod 600 "$FICHIER_PHRASE"
    echo "crabe : ─────────────────────────────────────────────────────────────"
    echo "crabe : Phrase secrète générée au premier démarrage et écrite dans le"
    echo "crabe : volume de données ($FICHIER_PHRASE dans le conteneur)."
    echo "crabe : Elle chiffre tous les identifiants enregistrés. SANS ELLE, ILS"
    echo "crabe : SONT IRRÉCUPÉRABLES : notez-la en lieu sûr et sauvegardez ce"
    echo "crabe : fichier avec vos données. Elle n'est jamais affichée ici."
    echo "crabe : Pour la lire, depuis le dossier de docker-compose.yml :"
    echo "crabe :     sudo cat data/phrase-secrete"
    echo "crabe : ─────────────────────────────────────────────────────────────"
  fi
  CRABE_MASTER_PASSPHRASE="$(cat "$FICHIER_PHRASE")"
  export CRABE_MASTER_PASSPHRASE
fi

# Le secret des cookies de session : même logique, sans cérémonie — le perdre
# ne coûte qu'une reconnexion.
if [ -z "${CRABE_SESSION_SECRET:-}" ]; then
  FICHIER_SESSION="$DATA_DIR/secret-session"
  if [ ! -s "$FICHIER_SESSION" ]; then
    genere > "$FICHIER_SESSION"
    chmod 600 "$FICHIER_SESSION"
  fi
  CRABE_SESSION_SECRET="$(cat "$FICHIER_SESSION")"
  export CRABE_SESSION_SECRET
fi

# Le volume appartient à l'utilisateur applicatif, puis root est abandonné.
# Le chown intégral ne court qu'une fois : dès que la racine a le bon
# propriétaire, on n'y retouche plus (des années de documents, ça se respecte).
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u crabe)" ]; then
    chown -R crabe:crabe "$DATA_DIR"
  fi
  exec setpriv --reuid crabe --regid crabe --init-groups "$@"
fi

exec "$@"
