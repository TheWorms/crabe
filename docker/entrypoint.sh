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
# premier démarrage si absente, elle est DITE une seule fois dans les journaux :
# c'est le seul moment où l'utilisateur peut la noter sans ouvrir le volume.
if [ -z "${CRABE_MASTER_PASSPHRASE:-}" ]; then
  FICHIER_PHRASE="$DATA_DIR/phrase-secrete"
  if [ ! -s "$FICHIER_PHRASE" ]; then
    genere > "$FICHIER_PHRASE"
    chmod 600 "$FICHIER_PHRASE"
    echo "crabe : ─────────────────────────────────────────────────────────────"
    echo "crabe : Phrase secrète générée au premier démarrage et écrite dans le"
    echo "crabe : volume de données : $FICHIER_PHRASE"
    echo "crabe : Elle chiffre tous les identifiants enregistrés. SANS ELLE, ILS"
    echo "crabe : SONT IRRÉCUPÉRABLES : sauvegardez ce fichier avec vos données."
    echo "crabe : La voici, une seule fois :"
    echo "crabe :     $(cat "$FICHIER_PHRASE")"
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
