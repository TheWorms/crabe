'use strict';

/**
 * Connecteur Scaleway.
 *
 * Récupère les factures Scaleway. Une API Billing officielle existe : c'est le meilleur candidat à une implémentation réelle après OVH.
 * Portail : https://console.scaleway.com/login
 *
 * Obstacle connu : Une API officielle existe (GET /billing/v2beta1/invoices, en-tête X-Auth-Token) : la privilégier au scraping.
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "scaleway",
  "providerName": "Scaleway",
  "loginUrl": "https://console.scaleway.com/login",
  "invoicesUrl": "https://console.scaleway.com/billing/invoices",
  "usernameField": "accessKey",
  "passwordField": "secretKey",
  "credentialKeys": [
    "accessKey",
    "secretKey"
  ],
  "monthsBack": 3,
  "selectors": {
    "username": "input[name=\"email\"]",
    "password": "input[name=\"password\"]",
    "submit": "button[type=\"submit\"]",
    "invoiceRow": "table tbody tr",
    "invoiceDate": "td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"]"
  }
});
