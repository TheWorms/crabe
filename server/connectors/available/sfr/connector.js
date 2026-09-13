'use strict';

/**
 * Connecteur SFR.
 *
 * Récupère les factures mobile et box depuis l'espace client SFR.
 * Portail : https://www.sfr.fr/cas/login
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "sfr",
  "providerName": "SFR",
  "loginUrl": "https://www.sfr.fr/cas/login",
  "invoicesUrl": "https://espace-client.sfr.fr/facture-mobile/consultation",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "selectors": {
    "cookieAccept": "#onetrust-accept-btn-handler",
    "username": "input#username",
    "password": "input#password",
    "submit": "button#btn-submit, input[type=\"submit\"]",
    "loginError": ".error, .form-error",
    "loginSuccess": ".sfr-header, #page",
    "invoiceRow": ".sr-container-content-facture .sr-row, table tbody tr",
    "invoiceDate": ".date, td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"], a[href*=\"facture\"]"
  }
});
