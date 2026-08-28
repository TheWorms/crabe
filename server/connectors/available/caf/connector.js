'use strict';

/**
 * Connecteur CAF.
 *
 * Récupère les attestations de paiement et de quotient familial.
 * Portail : https://wwwd.caf.fr/wps/portal/caffr/authentification
 *
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "caf",
  "providerName": "CAF",
  "loginUrl": "https://wwwd.caf.fr/wps/portal/caffr/authentification",
  "invoicesUrl": "https://wwwd.caf.fr/wps/portal/caffr/aidesetdemarches/mesdemarches/attestations",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 2,
  "selectors": {
    "cookieAccept": "#onetrust-accept-btn-handler",
    "username": "input[name=\"matricule\"]",
    "password": "input[name=\"codeConfidentiel\"]",
    "submit": "button[type=\"submit\"]",
    "loginError": ".erreur, .message-erreur",
    "invoiceRow": ".attestation-item, table tbody tr",
    "invoiceDate": ".date, td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"], a[download]"
  }
});
