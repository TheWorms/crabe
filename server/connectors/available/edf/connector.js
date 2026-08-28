'use strict';

/**
 * Connecteur EDF.
 *
 * Récupère les factures d'électricité depuis l'espace client EDF.
 * Portail : https://particulier.edf.fr/fr/accueil/espace-client/connexion.html
 * (redirige vers https://espace-client.edf.fr/sso/XUI/ — mesuré le 18/08/2026).
 *
 * ─── Ce que la MESURE du 18/08/2026 a établi (anonyme, en production) ──────────────
 *
 * La connexion se fait en DEUX ÉTAPES : l'e-mail seul (`input#email`, bouton
 * `#username-next-button` « Suivant »), puis l'écran du mot de passe. C'est ce
 * qui manquait aux échecs des 17-18/08 : le moteur remplissait le mot de passe
 * sur l'écran de l'e-mail, qui ne l'a jamais porté.
 *
 * ─── LE VERDICT, mesuré au réseau le 18/08/2026 ─────────────────────────────
 *
 * Le clic « Suivant » envoie d'abord une sonde chiffrée (POST vers un chemin
 * brouillé du domaine, réponse 201 — la signature d'un dispositif anti-robot),
 * puis `POST /sso/json/authenticate` répond **503** et la page affiche
 * « Adresse e-mail inconnue » — POUR LA VRAIE ADRESSE DU COMPTE COMME POUR UNE
 * ADRESSE BIDON, à l'identique. EDF refuse le navigateur automatisé et le
 * déguise en « adresse inconnue ». `obstacleEcranSuivant` porte ce verdict :
 * l'écran ne doit ni accuser le compte, ni suggérer de ressaisir quoi que ce
 * soit. Le sélecteur du mot de passe (écran 2, jamais atteint) suit la
 * convention de nommage mesurée sur l'écran 1 (`username2-*` → `password2-*`).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "edf",
  "providerName": "EDF",
  "loginUrl": "https://particulier.edf.fr/fr/accueil/espace-client/connexion.html",
  "invoicesUrl": "https://particulier.edf.fr/fr/accueil/espace-client/factures.html",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "obstacleEcranSuivant":
    "EDF a refusé la connexion automatisée : son site est gardé par un dispositif "
    + "anti-robot (mesuré le 18/08/2026 — même une adresse e-mail valide y est déclarée "
    + "« inconnue »). Ce n'est pas un problème avec votre compte, et ressaisir vos "
    + "identifiants n'y changera rien. crabe ne peut pas récupérer vos factures EDF "
    + "aujourd'hui ; elles restent disponibles sur particulier.edf.fr.",
  "selectors": {
    "cookieAccept": "#footer_tc_privacy_button_2, button[title*=\"Accepter\"]",
    "username": "input#email",
    "usernameNext": "#username-next-button",
    "password": "input#password2-password-field",
    "submit": "button[type=\"submit\"]",
    "loginError": ".error-message, .alert-danger",
    "loginSuccess": ".espace-client, [data-testid=\"dashboard\"]",
    "invoiceRow": ".facture-item, .list-invoices li",
    "invoiceDate": ".date, time",
    "invoiceLink": "a[href*=\"pdf\"], a[download]"
  }
});
