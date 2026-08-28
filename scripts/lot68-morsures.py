# -*- coding: utf-8 -*-
"""
Lot 68 — protocole de MORSURE.

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

REMOTE = 'server/remote-browser.js'
PREUVE = 'server/connectors/preuve-connexion.js'
SCHEMA = 'server/connectors/manifest-schema.js'
MANIFESTE_ANTHROPIC = 'server/connectors/available/anthropic/manifest.json'
MANIFESTE_INFOMANIAK = 'server/connectors/available/infomaniak/manifest.json'

T_RENVOI = 'test/lot68-preuve-par-renvoi.test.js'

MORSURES = [
    {
        'nom': 'la voie du renvoi mesure disparait (l\'etat d\'avant le lot 68)',
        'fichier': REMOTE,
        'vieux': "      if (session.renvoiAnonyme === 'connexion'\n"
                 "        && (statut === null || statut < 400)\n"
                 "        && preuve.memeSite(page.url(), session.verifyUrl)) {",
        'neuf': "      if (false && session.renvoiAnonyme === 'connexion'\n"
                "        && (statut === null || statut < 400)\n"
                "        && preuve.memeSite(page.url(), session.verifyUrl)) {",
        'tests': [T_RENVOI],
        'attendus': [
            'renvoi mesuré : la session ré-ancrée en fragment est CONFIRMÉE — le cas Anthropic du 28/08',
            'tenue déclarée ET renvoi mesuré : le ré-ancrage ne passe plus pour « éconduit »',
        ],
    },
    {
        'nom': 'la garde memeSite disparait : toute redirection sortante vaudrait preuve',
        'fichier': REMOTE,
        'vieux': "        && preuve.memeSite(page.url(), session.verifyUrl)) {",
        'neuf': "        && true) {",
        'tests': [T_RENVOI],
        'attendus': ['renvoi mesuré : un départ vers un AUTRE site ne prouve rien'],
    },
    {
        'nom': 'la garde de statut disparait : un 401 a corps non vide vaudrait preuve',
        'fichier': REMOTE,
        'vieux': "      if (session.renvoiAnonyme === 'connexion'\n"
                 "        && (statut === null || statut < 400)\n",
        'neuf': "      if (session.renvoiAnonyme === 'connexion'\n",
        'tests': [T_RENVOI],
        'attendus': [
            'renvoi mesuré : un 401 qui répond une page ne conclut rien — le statut mesuré des anonymes SoundCloud',
        ],
    },
    {
        'nom': 'le refus de tenue ne cede plus au renvoi mesure',
        'fichier': REMOTE,
        'vieux': "          if (session.renvoiAnonyme !== 'connexion') {",
        'neuf': "          if (true) {",
        'tests': [T_RENVOI],
        'attendus': ['tenue déclarée ET renvoi mesuré : le ré-ancrage ne passe plus pour « éconduit »'],
    },
    {
        'nom': 'la tenue stricte disparait : OUIGO enregistrerait des cookies anonymes',
        'fichier': REMOTE,
        'vieux': "          if (session.renvoiAnonyme !== 'connexion') {",
        'neuf': "          if (false) {",
        'tests': [T_RENVOI],
        'attendus': ['tenue déclarée SANS renvoi mesuré : la redirection reste un refus — le cas OUIGO inchangé'],
    },
    {
        'nom': 'ecarter les fragments des DEUX cotes : Electro Depot accepterait tout le compte',
        'fichier': PREUVE,
        'vieux': "  if (controle.includes('#')) return finale.startsWith(controle);\n"
                 "  return sansFragment(finale).startsWith(controle);",
        'neuf': "  return sansFragment(finale).startsWith(sansFragment(controle));",
        'tests': [T_RENVOI],
        'attendus': ['adresse de contrôle À fragment (Electro Dépôt) : la comparaison reste entière'],
    },
    {
        'nom': 'memeSite par « contient » : deezer.com.exemple.net passerait pour Deezer',
        'fichier': PREUVE,
        'vieux': "  return hoteA === hoteB || hoteA.endsWith(`.${hoteB}`) || hoteB.endsWith(`.${hoteA}`);",
        'neuf': "  return hoteA.includes(hoteB) || hoteB.includes(hoteA);",
        'tests': [T_RENVOI],
        'attendus': ['memeSite : le sous-domaine du service oui, un autre site non'],
    },
    {
        'nom': 'le message honnete disparait : la preuve manquante redevient « finissez de vous connecter »',
        'fichier': REMOTE,
        'vieux': "        if (essai.code === 'sans-preuve') {",
        'neuf': "        if (false && essai.code === 'sans-preuve') {",
        'tests': [T_RENVOI],
        'attendus': [
            'preuve manquante : le message ne dit NI « expiré » NI seulement « finissez de vous connecter »',
        ],
    },
    {
        'nom': 'le verdict sans-preuve redevient un refus indistinct',
        'fichier': REMOTE,
        'vieux': "      return {\n"
                 "        verdict: 'refusee',\n"
                 "        code: 'sans-preuve',\n"
                 "        raison: preuve.ligneNonConfirmee(session.connectorName, resultat),\n"
                 "      };",
        'neuf': "      return {\n"
                "        verdict: 'refusee',\n"
                "        code: 'refus',\n"
                "        raison: preuve.ligneNonConfirmee(session.connectorName, resultat),\n"
                "      };",
        'tests': [T_RENVOI],
        'attendus': [
            'renvoi mesuré : un départ vers un AUTRE site ne prouve rien',
            'renvoi mesuré : un 401 qui répond une page ne conclut rien — le statut mesuré des anonymes SoundCloud',
            'preuve manquante : le message ne dit NI « expiré » NI seulement « finissez de vous connecter »',
        ],
    },
    {
        'nom': 'le schema accepte une valeur non mesuree',
        'fichier': SCHEMA,
        'vieux': "    if (remote.renvoiAnonyme !== 'connexion') {",
        'neuf': "    if (false) {",
        'tests': [T_RENVOI],
        'attendus': ['schéma : renvoiAnonyme n\'accepte que la valeur mesurée « connexion »'],
    },
    {
        'nom': 'le schema accepte renvoiAnonyme sans adresse de controle',
        'fichier': SCHEMA,
        'vieux': "    } else if (!(typeof remote.verifyUrl === 'string' && remote.verifyUrl.trim())) {\n"
                 "      push('remoteLogin.renvoiAnonyme sans remoteLogin.verifyUrl : aucune adresse dont mesurer le renvoi');",
        'neuf': "    } else if (false) {\n"
                "      push('remoteLogin.renvoiAnonyme sans remoteLogin.verifyUrl : aucune adresse dont mesurer le renvoi');",
        'tests': [T_RENVOI],
        'attendus': ['schéma : renvoiAnonyme sans verifyUrl est refusé — aucune adresse dont mesurer le renvoi'],
    },
    {
        'nom': 'la garde du chemin d\'accueil disparait',
        'fichier': SCHEMA,
        'vieux': "      if (controle.pathname === '/' && !controle.search && !controle.hash) {",
        'neuf': "      if (false) {",
        'tests': [T_RENVOI],
        'attendus': ['schéma : un chemin d\'accueil n\'est pas une page réservée'],
    },
    {
        'nom': 'la liste blanche oublie renvoiAnonyme (le piege « persistent » du 12/08)',
        'fichier': SCHEMA,
        'vieux': "    renvoiAnonyme: remote.renvoiAnonyme === 'connexion' ? 'connexion' : '',",
        'neuf': "    renvoiAnonyme: '',",
        'tests': [T_RENVOI],
        'attendus': ['schéma : la liste blanche recopie renvoiAnonyme — sans elle, la clé disparaîtrait en silence'],
    },
    {
        'nom': 'Anthropic reperd sa declaration mesuree',
        'fichier': MANIFESTE_ANTHROPIC,
        'vieux': ',\n    "renvoiAnonyme": "connexion"\n  },',
        'neuf': '\n  },',
        'tests': [T_RENVOI],
        'attendus': ['manifestes réels : les six connecteurs au renvoi mesuré le déclarent'],
    },
    {
        'nom': 'l\'ecran oauth2/authorize redevient une page ordinaire (le defaut impots)',
        'fichier': PREUVE,
        'vieux': '|\\/second-factor|\\/oauth2?\\/authorize/i;',
        'neuf': '|\\/second-factor/i;',
        'tests': [T_RENVOI],
        'attendus': [
            'un oauth2/authorize final est un écran d\'authentification — le renvoi mesuré des impôts',
        ],
    },
    {
        'nom': 'infomaniak retourne a la racine comme adresse de controle',
        'fichier': MANIFESTE_INFOMANIAK,
        'vieux': '"verifyUrl": "https://manager.infomaniak.com/v3",',
        'neuf': '"verifyUrl": "https://manager.infomaniak.com/",',
        'tests': [T_RENVOI],
        'attendus': ['infomaniak : l\'adresse de contrôle n\'est plus la racine'],
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
            sys.exit('RESTAURATION RATEE pour %s — arret immediat' % chemin)

        manquants = [a for a in morsure['attendus'] if a not in tombes]
        if manquants:
            muettes.append((morsure['nom'], manquants, tombes))
            print('MUETTE  %s' % morsure['nom'])
            for m in manquants:
                print('        attendu sans effet : %s' % m)
            print('        tombes : %s' % (tombes or '(aucun)'))
        else:
            print('MORD    %s (%d test(s) tombe(s))' % (morsure['nom'], len(tombes)))

    print()
    if muettes:
        print('%d/%d morsures MUETTES — le lot ne prouve pas ses tests.' % (len(muettes), total))
        sys.exit(1)
    print('%d/%d morsures mordantes, fichiers restaures (md5 identiques).' % (total, total))


if __name__ == '__main__':
    main()
