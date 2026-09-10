'use strict';

/**
 * Connecteur Bouygues Telecom.
 *
 * Récupère les factures mobile et Bbox de Bouygues Telecom.
 * Portail : https://www.bouyguestelecom.fr/mon-compte/connexion
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "bouygues",
  "providerName": "Bouygues Telecom",
  "loginUrl": "https://www.bouyguestelecom.fr/mon-compte/connexion",
  "invoicesUrl": "https://www.bouyguestelecom.fr/mon-compte/mes-factures",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "selectors": {
    "cookieAccept": "#onetrust-accept-btn-handler",
    "username": "input[name=\"username\"]",
    "password": "input[name=\"password\"]",
    "submit": "button[type=\"submit\"]",
    "loginError": ".error-message, .alert",
    "loginSuccess": ".mon-compte, header",
    "invoiceRow": ".facture-item, table tbody tr",
    "invoiceDate": ".date, td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"], a[download]"
  }
});
