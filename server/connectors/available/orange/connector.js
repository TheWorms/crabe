'use strict';

/**
 * Connecteur Orange.
 *
 * Récupère les factures Orange (mobile, Livebox, Sosh).
 * Portail : https://login.orange.fr/
 *
 * Obstacle connu : Orange déclenche fréquemment une validation par SMS.
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "orange",
  "providerName": "Orange",
  "loginUrl": "https://login.orange.fr/",
  "invoicesUrl": "https://espace-client.orange.fr/factures-paiement",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "selectors": {
    "cookieAccept": "#didomi-notice-agree-button",
    "username": "input#login",
    "password": "input#password",
    "submit": "button[type=\"submit\"]",
    "loginError": ".error, [role=\"alert\"]",
    "loginSuccess": ".oecs__header, #main",
    "invoiceRow": ".billing-item, table tbody tr",
    "invoiceDate": ".date, td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"], a[download]"
  }
});
