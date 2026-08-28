#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lot 66 — les morsures.

Chaque changement de ce lot est retiré ou inversé UN À UN, à correspondance
exacte, et le test qui doit s'en apercevoir est rejoué. Un test qui passe encore
alors que le code a été défait ne protège rien — et c'est exactement le piège de
ce lot : un service d'envoi impeccable que personne n'appelle passe tous les
tests unitaires du monde sans rien envoyer.

Le fichier est restauré à l'identique après chaque morsure, et l'empreinte md5
est comparée à celle d'avant. Aucune sauvegarde n'est laissée derrière.
"""

import hashlib
import io
import subprocess
import sys

MORSURES = [
    # (libellé, fichier, avant, après, motif attendu dans l'échec)
    (
        "personne n'appelle plus la série depuis le planificateur",
        "server/scheduler.js",
        "    if (trigger === 'manual') {\n      notifications.signalerRecuperationManuelle(",
        "    if (false) {\n      notifications.signalerRecuperationManuelle(",
        "planificateur alimente lui",
    ),
    (
        "un essai alimente la série comme une vraie récupération",
        "server/scheduler.js",
        "    if (trigger === 'manual') {\n      notifications.signalerRecuperationManuelle(",
        "    if (trigger !== 'cron') {\n      notifications.signalerRecuperationManuelle(",
        "planificateur alimente lui",
    ),
    (
        "la série se clôt sans regarder si quelque chose tourne",
        "server/notifications.js",
        "    if (occupe) return void armerBalayee(userId);",
        "    if (false) return void armerBalayee(userId);",
        "tourne encore",
    ),
    (
        "un service lancé seul redevient notifiable",
        "server/notifications.js",
        "  if (lignes.length < SEUIL_BALAYEE) {",
        "  if (lignes.length < 1) {",
        "lancé seul ne notifie rien",
    ),
    (
        "la série détaille aussi les réussites",
        "server/notifications.js",
        "    items: echecs.map((e) => ({ id: e.connectorId, nom: e.nom, message: e.message })),\n    courriel: () =>\n      emailTemplates.render('job-finished', {",
        "    items: lignes.map((e) => ({ id: e.connectorId, nom: e.nom, message: e.message })),\n    courriel: () =>\n      emailTemplates.render('job-finished', {",
        "donne UN message",
    ),
    (
        "un chantier de quatre secondes est notifié comme les autres",
        "server/notifications.js",
        "  if (Number.isFinite(bilan.dureeMs) && bilan.dureeMs < DUREE_CHANTIER_NOTIFIABLE_MS) {",
        "  if (false) {",
        "chantier long se dit",
    ),
    (
        "le canal éteint redevient une sortie muette",
        "server/notifications.js",
        "  if (!reglage(userId).email) {\n    applog.info(",
        "  if (!reglage(userId).email) {\n    if (0) applog.info(",
        "POURQUOI rien n",
    ),
    (
        "le SMTP absent redevient une sortie muette",
        "server/notifications.js",
        "    if (!mailer.isConfigured()) {\n      applog.warn(",
        "    if (!mailer.isConfigured()) {\n      if (0) applog.warn(",
        "SMTP configur",
    ),
    (
        "l'adresse absente redevient une sortie muette",
        "server/notifications.js",
        "    if (!row?.email) {\n      applog.warn(",
        "    if (!row?.email) {\n      if (0) applog.warn(",
        "aucune adresse sur le compte",
    ),
    (
        "un refus du SMTP est de nouveau avalé",
        "server/notifications.js",
        "      applog.error('notifications', `« ${titre} » : l'envoi par e-mail a échoué — ${sent.message}`, qui);",
        "      // morsure : l'échec repart en silence",
        "SMTP refuse",
    ),
    (
        "l'arrêt du serveur oublie la série en cours",
        "server/notifications.js",
        "  const ids = new Set([...enAttente.keys(), ...balayees.keys()]);",
        "  const ids = new Set([...enAttente.keys()]);",
        "oublie ni les",
    ),
    (
        "le modèle de chantier disparaît",
        "server/email-templates.js",
        "    key: 'job-finished',",
        "    key: 'job-finished-absent',",
        "existe et se remplit",
    ),
    (
        "l'écran conclut au refus sans regarder l'adresse (bug d'origine)",
        "web/app.js",
        "  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'non-securise';\n  if (Notification.permission === 'granted') return 'accordee';",
        "  if (Notification.permission === 'granted') return 'accordee';",
        "adresse en http",
    ),
    (
        "l'autorisation est redemandée au chargement",
        "web/app.js",
        "function renderNotificationsReglage() {\n  const zone = $('profil-notifications');",
        "function renderNotificationsReglage() {\n  if (typeof Notification !== 'undefined') Notification.requestPermission();\n  const zone = $('profil-notifications');",
        "JAMAIS demand",
    ),
    (
        "l'interrupteur redemande l'autorisation même là où c'est impossible",
        "web/app.js",
        "  if (canal === 'navigateur' && valeur && etatPermissionNavigateur() === 'a-demander') {",
        "  if (canal === 'navigateur' && valeur && typeof Notification !== 'undefined') {",
        "ne demande rien au navigateur",
    ),
    (
        "le verdict disparaît de l'écran",
        "web/app.js",
        "  if (!c.emailPossible && !c.navigateurPossible) {",
        "  if (false) {",
        "AUCUNE notification",
    ),
    (
        "le verdict ne regarde plus si le SMTP existe",
        "web/app.js",
        "    emailPossible: emailVoulu && !!state.smtpConfigured && !!state.me?.email,",
        "    emailPossible: emailVoulu,",
        "SMTP absent : le verdict",
    ),
    (
        "l'écran promet de nouveau une question qui ne viendra jamais",
        "web/app.js",
        "  if (c.permission === 'non-securise') {\n    return `${commun}<br>",
        "  if (c.permission === 'non-securise') {\n    return `${commun} Votre navigateur vous demandera l'autorisation la première fois.<br>",
        "adresse en http",
    ),
]

FICHIER_TEST = "test/lot66-notifications.test.js"


def md5(chemin):
    return hashlib.md5(io.open(chemin, "rb").read()).hexdigest()


def joue(motif):
    """Rejoue le seul test visé. Rend (a_echoue, sortie)."""
    r = subprocess.run(
        ["node", "--test", "--test-name-pattern", motif, FICHIER_TEST],
        capture_output=True,
        text=True,
    )
    # Un motif qui ne sélectionne AUCUN test rendrait 0 et ferait passer une
    # morsure pour mordante. Le signe est net : quand rien n'est sélectionné,
    # node rend le FICHIER comme unique résultat au lieu des noms de tests.
    joues = 0
    for ligne in r.stdout.splitlines():
        for prefixe in ("ok ", "not ok "):
            if ligne.startswith(prefixe) and " - " in ligne:
                if ligne.split(" - ", 1)[1].strip() != FICHIER_TEST:
                    joues += 1
                break
    return (r.returncode != 0, joues, r.stdout + r.stderr)


def main():
    empreintes = {f: md5(f) for f in {m[1] for m in MORSURES}}
    echecs_protocole = []

    for libelle, fichier, avant, apres, motif in MORSURES:
        source = io.open(fichier, encoding="utf-8").read()
        if source.count(avant) != 1:
            print("!! ANCRE %s : %d occurrence(s) dans %s" % (libelle, source.count(avant), fichier))
            echecs_protocole.append(libelle)
            continue

        io.open(fichier, "w", encoding="utf-8").write(source.replace(avant, apres))
        mord, joues, sortie = joue(motif)
        io.open(fichier, "w", encoding="utf-8").write(source)

        rendu = md5(fichier)
        propre = rendu == empreintes[fichier]
        etat = "MORD" if (mord and joues) else "!! NE MORD PAS"
        if not joues:
            etat = "!! MOTIF VIDE"
        print("%-16s %-58s (%s, %d test(s), md5 %s)"
              % (etat, libelle, fichier, joues, "identique" if propre else "DIVERGENT"))
        if not mord or not joues:
            echecs_protocole.append(libelle)
            print(sortie[-800:])
        if not propre:
            echecs_protocole.append(libelle + " (restauration)")

    print("\n%d morsures, %d probleme(s)" % (len(MORSURES), len(echecs_protocole)))
    return 1 if echecs_protocole else 0


if __name__ == "__main__":
    sys.exit(main())
