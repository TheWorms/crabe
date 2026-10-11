'use strict';

/**
 * Connecteur Vinted.
 *
 * Candidature de connecteur — doit être testée par un administrateur avant d'apparaître dans le Store.
 * Portail : https://www.vinted.fr/member/general/login
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "vinted",
  "providerName": "Vinted",
  "loginUrl": "https://www.vinted.fr/member/general/login",
  "invoicesUrl": "https://www.vinted.fr/member/billing",
  "usernameField": "email",
  "passwordField": "password",
  "credentialKeys": [
    "email",
    "password"
  ],
  "monthsBack": 1,
  "selectors": {
    "cookieAccept": "#onetrust-accept-btn-handler",
    "username": "input[name=\"username\"]",
    "password": "input[name=\"password\"]",
    "submit": "button[type=\"submit\"]",
    "invoiceRow": "table tbody tr",
    "invoiceDate": "td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"]"
  }
});
