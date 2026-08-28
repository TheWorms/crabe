'use strict';

/**
 * Connecteur Engie.
 *
 * Récupère les factures de gaz et électricité Engie.
 * Portail : https://particuliers.engie.fr/connexion.html
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "engie",
  "providerName": "Engie",
  "loginUrl": "https://particuliers.engie.fr/connexion.html",
  "invoicesUrl": "https://particuliers.engie.fr/factures-paiements/mes-factures.html",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "selectors": {
    "cookieAccept": "#onetrust-accept-btn-handler",
    "username": "input[name=\"email\"]",
    "password": "input[name=\"password\"]",
    "submit": "button[type=\"submit\"]",
    "loginError": ".form-error, .error-msg",
    "loginSuccess": ".dashboard, .espace-client",
    "invoiceRow": ".invoice-row, table tbody tr",
    "invoiceDate": "td:nth-child(1), .invoice-date",
    "invoiceLink": "a[href*=\"pdf\"], a[download]"
  }
});
