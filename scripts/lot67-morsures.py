# -*- coding: utf-8 -*-
"""
Lot 67 — protocole de MORSURE.

Un test qui passe ne prouve rien tant qu'on n'a pas vu ce qui le fait tomber.
Pour chaque correctif du lot, ce script :

  1. sauvegarde le fichier et note son md5 ;
  2. y REMET le défaut, par correspondance exacte ;
  3. lance le(s) fichier(s) de test concerné(s) et relève les « not ok » ;
  4. restaure le fichier et VÉRIFIE que le md5 est identique ;
  5. compare les tests tombés à ceux qu'on attendait.

⚠ Leçon du lot 66 : on ne se sert PAS de `--test-name-pattern`. Neuf motifs
n'y sélectionnaient aucun test à cause des accents, et faisaient passer des
morsures pour mordantes. On lance le fichier entier et on lit la sortie TAP.
"""

import hashlib
import io
import os
import re
import subprocess
import sys

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCHEDULER = 'server/scheduler.js'
ETEINDRE = 'server/connectors/eteindre-navigateur.js'
PAYBYPHONE = 'server/connectors/available/paybyphone/connector.js'
MANIFESTE_FREE = 'server/connectors/available/free-mobile/manifest.json'

T_LIMITE = 'test/lot67-limite-execution.test.js'
T_MARQUEURS = 'test/lot67-marqueurs.test.js'
T_VERDICT = 'test/lot48-verdict.test.js'

MORSURES = [
    {
        'nom': 'le socle n\'a plus de limite du tout (l\'etat d\'avant le lot 67)',
        'fichier': SCHEDULER,
        'vieux': 'const fetched = await avecLimiteDeDuree(\n'
                 '      registry.fetchInvoicesDetailed(connectorId, connectorConfig, {',
        'neuf': 'const fetched = await (async (p) => p)(\n'
                '      registry.fetchInvoicesDetailed(connectorId, connectorConfig, {',
        'tests': [T_LIMITE],
        'attendus': [
            'une exécution qui dépasse la limite est ARRÊTÉE, et sa ligne run_logs est REFERMÉE',
            'la promesse abandonnée ne revient pas réécrire une ligne déjà refermée',
            "l'abandon appelle VRAIMENT l'extinction, avec le profil du couple",
            'un abandon planifié est NOTIFIABLE comme n\'importe quel échec',
        ],
    },
    {
        'nom': 'la limite descend a 10 minutes (elle casserait du travail reel)',
        'fichier': SCHEDULER,
        'vieux': 'const LIMITE_EXECUTION_MS = 45 * 60 * 1000;',
        'neuf': 'const LIMITE_EXECUTION_MS = 10 * 60 * 1000;',
        'tests': [T_LIMITE],
        'attendus': [
            'la limite par défaut est de 45 minutes, et laisse passer la plus longue exécution mesurée',
        ],
    },
    {
        'nom': 'une valeur d\'environnement illisible desarme la limite',
        'fichier': SCHEDULER,
        'vieux': 'return Number.isFinite(demande) && demande > 0 ? demande : LIMITE_EXECUTION_MS;',
        'neuf': 'return Number.isFinite(demande) ? demande : LIMITE_EXECUTION_MS;',
        'tests': [T_LIMITE],
        'attendus': [
            'la limite par défaut est de 45 minutes, et laisse passer la plus longue exécution mesurée',
        ],
    },
    {
        'nom': 'l\'abandon n\'eteint plus le navigateur',
        'fichier': SCHEDULER,
        'vieux': '    if (err.dureeDepassee) {\n'
                 '      // Ce couple-ci tient encore son verrou',
        'neuf': '    if (false && err.dureeDepassee) {\n'
                '      // Ce couple-ci tient encore son verrou',
        'tests': [T_LIMITE],
        'attendus': ["l'abandon appelle VRAIMENT l'extinction, avec le profil du couple"],
    },
    {
        'nom': 'l\'extinction eteint aussi sur une erreur ORDINAIRE',
        'fichier': SCHEDULER,
        'vieux': '    if (err.dureeDepassee) {\n'
                 '      // Ce couple-ci tient encore son verrou',
        'neuf': '    if (true || err.dureeDepassee) {\n'
                '      // Ce couple-ci tient encore son verrou',
        'tests': [T_LIMITE],
        'attendus': ["une erreur ORDINAIRE n'éteint rien : le connecteur ferme déjà son navigateur"],
    },
    {
        'nom': 'la ligne fantome n\'est plus refermee au demarrage',
        'fichier': SCHEDULER,
        'vieux': "        WHERE finished_at IS NULL`",
        'neuf': "        WHERE finished_at IS NULL AND 1 = 0`",
        'tests': [T_LIMITE],
        'attendus': ['une ligne restée ouverte par un arrêt brutal est refermée au démarrage'],
    },
    {
        'nom': 'le navigateur DISTANT (meme profil, autre parent) est tue lui aussi',
        'fichier': ETEINDRE,
        'vieux': '    if (ppid !== moi) continue;',
        'neuf': '    if (ppid === -1) continue;',
        'tests': [T_LIMITE],
        'attendus': [
            'seul le navigateur de PREMIER RANG est reconnu — jamais un moteur de rendu',
            "le navigateur DISTANT, sur le même profil, n'est jamais éteint",
        ],
    },
    {
        'nom': 'un profil jetable est tue meme quand une autre execution tourne',
        'fichier': ETEINDRE,
        'vieux': '    } else if (seul && MOTIF_PROFIL_JETABLE.test(nav.profil)) {',
        'neuf': '    } else if (MOTIF_PROFIL_JETABLE.test(nav.profil)) {',
        'tests': [T_LIMITE],
        'attendus': ["un profil JETABLE n'est pas touché quand une autre exécution tourne"],
    },
    {
        'nom': 'plus de second rideau : SIGTERM ignore reste ignore',
        'fichier': ETEINDRE,
        'vieux': "          runtime.kill(t.pid, 'SIGKILL');",
        'neuf': '          void t.pid;',
        'tests': [T_LIMITE],
        'attendus': ['un navigateur qui ignore SIGTERM reçoit SIGKILL'],
    },
    {
        'nom': 'PayByPhone revise ses champs caches (le defaut des 71 minutes)',
        'fichier': PAYBYPHONE,
        'vieux': "const SELECTEUR_CHAMPS_DATE = [\n"
                 "  'input[type=\"date\"]:visible',\n"
                 "  'input[id*=\"ate\" i]:visible',\n"
                 "  'input[name*=\"ate\" i]:visible',\n"
                 "].join(', ');",
        'neuf': "const SELECTEUR_CHAMPS_DATE = [\n"
                "  'input[type=\"date\"]',\n"
                "  'input[id*=\"ate\" i]',\n"
                "  'input[name*=\"ate\" i]',\n"
                "].join(', ');",
        'tests': [T_MARQUEURS],
        'attendus': ['PayByPhone : chaque branche du sélecteur de dates exige :visible'],
    },
    {
        'nom': 'Free Mobile reperd son verifyUrlTient',
        'fichier': MANIFESTE_FREE,
        'vieux': '    "verifyUrlTient": true,\n',
        'neuf': '',
        'tests': [T_MARQUEURS, T_VERDICT],
        'attendus': [
            'Free Mobile : le manifeste déclare verifyUrlTient, et une adresse dont juger la tenue',
        ],
    },
]


def lire(chemin):
    return io.open(os.path.join(RACINE, chemin), encoding='utf-8').read()


def ecrire(chemin, contenu):
    io.open(os.path.join(RACINE, chemin), 'w', encoding='utf-8').write(contenu)


def md5(texte):
    return hashlib.md5(texte.encode('utf-8')).hexdigest()


def echecs(fichiers_de_test):
    """Les noms des tests tombés, lus dans la sortie TAP."""
    tombes = []
    for fichier in fichiers_de_test:
        proc = subprocess.run(
            ['node', '--test', fichier],
            cwd=RACINE, capture_output=True, text=True,
        )
        for ligne in proc.stdout.splitlines():
            m = re.match(r'^not ok \d+ - (.*)$', ligne.strip())
            if m:
                tombes.append(m.group(1).strip())
    return tombes


def main():
    total = 0
    muettes = []
    for morsure in MORSURES:
        total += 1
        chemin = morsure['fichier']
        origine = lire(chemin)
        empreinte = md5(origine)

        if origine.count(morsure['vieux']) != 1:
            sys.exit('ANCRE introuvable ou ambigue pour « %s » dans %s (%d occurrence(s))'
                     % (morsure['nom'], chemin, origine.count(morsure['vieux'])))

        ecrire(chemin, origine.replace(morsure['vieux'], morsure['neuf']))
        try:
            tombes = echecs(morsure['tests'])
        finally:
            ecrire(chemin, origine)

        if md5(lire(chemin)) != empreinte:
            sys.exit('RESTAURATION RATEE sur %s' % chemin)

        manquants = [a for a in morsure['attendus'] if a not in tombes]
        print('')
        print('── %s' % morsure['nom'])
        print('   fichier   : %s (md5 restaure %s)' % (chemin, empreinte[:12]))
        print('   tombes    : %d' % len(tombes))
        for t in tombes:
            print('        - %s' % t)
        if manquants:
            muettes.append((morsure['nom'], manquants))
            print('   >>> MUETTE : ces tests auraient du tomber :')
            for m in manquants:
                print('        ! %s' % m)
        else:
            print('   >>> MORDANTE')

    print('')
    print('=' * 72)
    print('%d morsure(s), %d mordante(s), %d muette(s)' % (total, total - len(muettes), len(muettes)))
    if muettes:
        for nom, manquants in muettes:
            print('  MUETTE : %s — %s' % (nom, ' / '.join(manquants)))
        sys.exit(1)
    print('TOUTES MORDANTES')


if __name__ == '__main__':
    main()
