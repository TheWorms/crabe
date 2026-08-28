'use strict';

/**
 * Connecteur Ameli.
 *
 * Récupère les relevés de remboursement et attestations de droits.
 * Portail : https://assure.ameli.fr/PortailAS/appmanager/PortailAS/assure
 *
 * ─── Ce que la MESURE du 18/08/2026 a établi (anonyme, en production) ──────────────
 *
 * Le formulaire n'est pas sur la page d'arrivée. Le chemin mesuré :
 *
 *   1. un écran de consentement MAISON (pas OneTrust — l'ancien sélecteur
 *      `#onetrust-accept-btn-handler` ne mordait sur rien) : `#idWAaccepter` ;
 *   2. une page d'accueil avec un lien « Connectez-vous »
 *      (`a#id_r_cnx_btn_code` — le même id sert aussi à « Créez votre
 *      compte », d'où le `:has-text`) ;
 *   3. le formulaire, servi par ameliconnect.ameli.fr : numéro de sécurité
 *      sociale dans `input#userfield`, mot de passe dans `input#passwordfield`,
 *      envoi par `input[type="image"][name="submit"]`.
 *
 * Aucun dispositif anti-robot détecté (pas de captcha, pas de script de garde
 * tiers). Les anciens sélecteurs (`connexioncompte_2nir_ass`…) dataient d'une
 * version du portail qui n'existe plus : ils ne mordaient sur rien, d'où le
 * « Timeout 45000ms » brut des 17-18/08.
 *
 * ─── LE VERDICT, mesuré en connexion réelle le 18/08/2026 ────────────────────
 *
 * Les identifiants corrigés SONT acceptés (`POST /oauth2/authorize` → 200),
 * puis la page présente `#BoutonGenerationOTP` : un code à usage unique est
 * exigé — un code que crabe ne peut pas recevoir à la place de l'utilisateur.
 * `otpMarker` + `obstacleOtp` portent ce verdict à l'écran, au lieu de
 * laisser l'échec arriver plus loin avec un message qui accuse la liste des
 * documents.
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector({
  "id": "ameli",
  "providerName": "Ameli",
  "loginUrl": "https://assure.ameli.fr/PortailAS/appmanager/PortailAS/assure",
  "invoicesUrl": "https://assure.ameli.fr/PortailAS/appmanager/PortailAS/assure?_paiements",
  "usernameField": "username",
  "passwordField": "password",
  "credentialKeys": [
    "username",
    "password"
  ],
  "monthsBack": 3,
  "obstacleOtp":
    "Ameli a bien reconnu vos identifiants, mais demande ensuite un code à usage "
    + "unique que crabe ne peut pas recevoir à votre place. La récupération automatique "
    + "n'est pas possible aujourd'hui ; vos relevés restent disponibles sur ameli.fr.",
  "selectors": {
    "preambule": [
      "#idWAaccepter",
      "a#id_r_cnx_btn_code:has-text(\"Connectez-vous\")"
    ],
    "username": "input#userfield",
    "password": "input#passwordfield",
    "submit": "input[type=\"image\"][name=\"submit\"]",
    "otpMarker": "#BoutonGenerationOTP",
    "loginError": ".zone-alerte, .erreur, [role=\"alert\"]",
    "invoiceRow": ".paiement-ligne, table tbody tr",
    "invoiceDate": ".date, td:nth-child(1)",
    "invoiceLink": "a[href*=\"pdf\"]"
  }
});
