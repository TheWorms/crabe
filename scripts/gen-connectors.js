#!/usr/bin/env node
'use strict';

/**
 * Génère les manifests et les modules des connecteurs de scraping.
 *
 * Script utilitaire de dépôt : les fichiers produits sous
 * server/connectors/available/ sont du vrai code source, committé et destiné
 * à être édité à la main dès qu'un connecteur est réellement validé.
 * Relancer ce script écrase ces fichiers.
 *
 * Le connecteur OVH n'est PAS généré : il a une implémentation d'API réelle,
 * écrite à la main.
 *
 * Usage : node scripts/gen-connectors.js
 */

const fs = require('node:fs');
const path = require('node:path');

const AVAILABLE = path.join(__dirname, '..', 'server', 'connectors', 'available');

const PASSWORD = { label: 'Mot de passe', type: 'password' };

const CONNECTORS = [
  {
    id: 'free',
    name: 'Free Internet',
    category: 'telecom',
    color: '#c8102e',
    letters: 'F',
    site: 'subscribe.free.fr',
    description: "Récupère les factures de l'abonnement Freebox depuis l'espace abonné Free.",
    fields: [
      { key: 'username', label: 'Identifiant Free', type: 'text', help: 'Numéro de ligne ou identifiant de connexion.' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://subscribe.free.fr/login/',
    invoicesUrl: 'https://subscribe.free.fr/login/mesfactures.pl',
    selectors: {
      username: 'input[name="login"]',
      password: 'input[name="pass"]',
      submit: 'input[type="submit"]',
      loginError: '.error, .msg_erreur',
      invoiceRow: 'table.facture tr, .liste-factures tr',
      invoiceDate: 'td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"]',
    },
  },
  {
    id: 'edf',
    name: 'EDF',
    category: 'energie',
    color: '#0e6bb8',
    letters: 'EDF',
    site: 'particulier.edf.fr',
    description: "Récupère les factures d'électricité depuis l'espace client EDF.",
    fields: [
      { key: 'username', label: 'Adresse e-mail', type: 'email' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://particulier.edf.fr/fr/accueil/espace-client/connexion.html',
    invoicesUrl: 'https://particulier.edf.fr/fr/accueil/espace-client/factures.html',
    note: "L'espace client EDF impose une vérification par e-mail à la première connexion.",
    selectors: {
      cookieAccept: '#footer_tc_privacy_button_2, button[title*="Accepter"]',
      username: 'input#email',
      password: 'input#password2-password-field',
      submit: 'button[type="submit"]',
      loginError: '.error-message, .alert-danger',
      loginSuccess: '.espace-client, [data-testid="dashboard"]',
      invoiceRow: '.facture-item, .list-invoices li',
      invoiceDate: '.date, time',
      invoiceLink: 'a[href*="pdf"], a[download]',
    },
  },
  {
    id: 'engie',
    name: 'Engie',
    category: 'energie',
    color: '#00a0af',
    letters: 'EN',
    site: 'particuliers.engie.fr',
    description: 'Récupère les factures de gaz et électricité Engie.',
    fields: [
      { key: 'username', label: 'Adresse e-mail', type: 'email' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://particuliers.engie.fr/connexion.html',
    invoicesUrl: 'https://particuliers.engie.fr/factures-paiements/mes-factures.html',
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
      loginError: '.form-error, .error-msg',
      loginSuccess: '.dashboard, .espace-client',
      invoiceRow: '.invoice-row, table tbody tr',
      invoiceDate: 'td:nth-child(1), .invoice-date',
      invoiceLink: 'a[href*="pdf"], a[download]',
    },
  },
  {
    id: 'sfr',
    name: 'SFR',
    category: 'telecom',
    color: '#d3001e',
    letters: 'SFR',
    site: 'espace-client.sfr.fr',
    description: "Récupère les factures mobile et box depuis l'espace client SFR.",
    fields: [
      { key: 'username', label: 'Identifiant ou numéro de ligne', type: 'text' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://www.sfr.fr/cas/login',
    invoicesUrl: 'https://espace-client.sfr.fr/facture-mobile/consultation',
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input#username',
      password: 'input#password',
      submit: 'button#btn-submit, input[type="submit"]',
      loginError: '.error, .form-error',
      loginSuccess: '.sfr-header, #page',
      invoiceRow: '.sr-container-content-facture .sr-row, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"], a[href*="facture"]',
    },
  },
  {
    id: 'orange',
    name: 'Orange',
    category: 'telecom',
    color: '#ff7900',
    letters: 'O',
    site: 'espace-client.orange.fr',
    description: 'Récupère les factures Orange (mobile, Livebox, Sosh).',
    fields: [
      { key: 'username', label: 'Adresse e-mail ou numéro', type: 'text' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://login.orange.fr/',
    invoicesUrl: 'https://espace-client.orange.fr/factures-paiement',
    note: 'Orange déclenche fréquemment une validation par SMS.',
    selectors: {
      cookieAccept: '#didomi-notice-agree-button',
      username: 'input#login',
      password: 'input#password',
      submit: 'button[type="submit"]',
      loginError: '.error, [role="alert"]',
      loginSuccess: '.oecs__header, #main',
      invoiceRow: '.billing-item, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"], a[download]',
    },
  },
  {
    id: 'bouygues',
    name: 'Bouygues Telecom',
    category: 'telecom',
    color: '#0f2a5f',
    letters: 'BT',
    site: 'www.bouyguestelecom.fr',
    description: 'Récupère les factures mobile et Bbox de Bouygues Telecom.',
    fields: [
      { key: 'username', label: 'Adresse e-mail ou numéro', type: 'text' },
      { key: 'password', ...PASSWORD },
    ],
    loginUrl: 'https://www.bouyguestelecom.fr/mon-compte/connexion',
    invoicesUrl: 'https://www.bouyguestelecom.fr/mon-compte/mes-factures',
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
      loginError: '.error-message, .alert',
      loginSuccess: '.mon-compte, header',
      invoiceRow: '.facture-item, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"], a[download]',
    },
  },
  {
    id: 'scaleway',
    name: 'Scaleway',
    category: 'hebergement',
    color: '#4f0599',
    letters: 'SC',
    site: 'console.scaleway.com',
    description:
      "Récupère les factures Scaleway. Une API Billing officielle existe : c'est le meilleur candidat à une implémentation réelle après OVH.",
    fields: [
      { key: 'accessKey', label: 'Access Key', type: 'password', help: 'Clé API générée dans la console Scaleway.' },
      { key: 'secretKey', label: 'Secret Key', type: 'password' },
      { key: 'organizationId', label: 'Organization ID', type: 'text', required: false },
    ],
    credentialKeys: ['accessKey', 'secretKey'],
    usernameField: 'accessKey',
    passwordField: 'secretKey',
    loginUrl: 'https://console.scaleway.com/login',
    invoicesUrl: 'https://console.scaleway.com/billing/invoices',
    note: 'Une API officielle existe (GET /billing/v2beta1/invoices, en-tête X-Auth-Token) : la privilégier au scraping.',
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
      invoiceRow: 'table tbody tr',
      invoiceDate: 'td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"]',
    },
  },
  {
    id: 'impots',
    name: 'Impots.gouv.fr',
    category: 'public',
    color: '#000091',
    letters: 'IG',
    site: 'www.impots.gouv.fr',
    description: "Récupère les avis d'imposition et documents fiscaux.",
    fields: [
      { key: 'fiscalNumber', label: 'Numéro fiscal', type: 'text', help: '13 chiffres, figure en haut de votre dernier avis.' },
      { key: 'password', ...PASSWORD },
    ],
    credentialKeys: ['fiscalNumber', 'password'],
    usernameField: 'fiscalNumber',
    loginUrl: 'https://cfspart.impots.gouv.fr/',
    invoicesUrl: 'https://cfspart.impots.gouv.fr/enp/ensu/documents.do',
    monthsBack: 2,
    selectors: {
      username: 'input#identifiant',
      password: 'input#password',
      submit: 'input[type="submit"], button[type="submit"]',
      loginError: '.erreur, #erreur',
      invoiceRow: '.documents li, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"]',
    },
  },
  {
    id: 'caf',
    name: 'CAF',
    category: 'public',
    color: '#0b3d91',
    letters: 'CAF',
    site: 'www.caf.fr',
    description: 'Récupère les attestations de paiement et de quotient familial.',
    fields: [
      { key: 'username', label: 'Numéro allocataire', type: 'text' },
      { key: 'password', ...PASSWORD, label: 'Code confidentiel' },
    ],
    loginUrl: 'https://wwwd.caf.fr/wps/portal/caffr/authentification',
    invoicesUrl: 'https://wwwd.caf.fr/wps/portal/caffr/aidesetdemarches/mesdemarches/attestations',
    monthsBack: 2,
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input[name="matricule"]',
      password: 'input[name="codeConfidentiel"]',
      submit: 'button[type="submit"]',
      loginError: '.erreur, .message-erreur',
      invoiceRow: '.attestation-item, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"], a[download]',
    },
  },
  {
    id: 'ameli',
    name: 'Ameli',
    category: 'public',
    color: '#3b7dd8',
    letters: 'A',
    site: 'www.ameli.fr',
    description: 'Récupère les relevés de remboursement et attestations de droits.',
    fields: [
      { key: 'username', label: 'Numéro de sécurité sociale', type: 'text' },
      { key: 'password', ...PASSWORD, label: 'Code personnel' },
    ],
    loginUrl: 'https://assure.ameli.fr/PortailAS/appmanager/PortailAS/assure',
    invoicesUrl: 'https://assure.ameli.fr/PortailAS/appmanager/PortailAS/assure?_paiements',
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input#connexioncompte_2nir_ass',
      password: 'input#connexioncompte_2connexion_mot_de_passe',
      submit: 'button#connexioncompte_2atZoneNum',
      loginError: '.zone-alerte, .erreur',
      invoiceRow: '.paiement-ligne, table tbody tr',
      invoiceDate: '.date, td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"]',
    },
  },
  {
    id: 'amazon',
    name: 'Amazon',
    category: 'shopping',
    color: '#232f3e',
    letters: 'AZ',
    site: 'www.amazon.fr',
    description: 'Récupère les factures de commandes Amazon.fr.',
    fields: [
      { key: 'email', label: 'E-mail', type: 'email' },
      { key: 'password', ...PASSWORD },
    ],
    credentialKeys: ['email', 'password'],
    usernameField: 'email',
    loginUrl: 'https://www.amazon.fr/ap/signin',
    invoicesUrl: 'https://www.amazon.fr/gp/css/order-history',
    note: 'Amazon impose un captcha et une OTP par e-mail sur les connexions automatisées.',
    monthsBack: 4,
    selectors: {
      username: 'input#ap_email',
      password: 'input#ap_password',
      submit: 'input#signInSubmit',
      loginError: '#auth-error-message-box',
      loginSuccess: '#nav-link-accountList',
      invoiceRow: '.order-card, .a-box-group',
      invoiceDate: '.order-date-invoice-item, .a-color-secondary',
      invoiceLink: 'a[href*="invoice"]',
    },
  },
  {
    id: 'vinted',
    name: 'Vinted',
    category: 'shopping',
    color: '#09b1ba',
    letters: 'V',
    site: 'www.vinted.fr',
    description:
      "Candidature de connecteur — doit être testée par un administrateur avant d'apparaître dans le Store.",
    fields: [
      { key: 'email', label: 'E-mail', type: 'email' },
      { key: 'password', ...PASSWORD },
    ],
    credentialKeys: ['email', 'password'],
    usernameField: 'email',
    loginUrl: 'https://www.vinted.fr/member/general/login',
    invoicesUrl: 'https://www.vinted.fr/member/billing',
    initialStatus: 'pending',
    monthsBack: 1,
    selectors: {
      cookieAccept: '#onetrust-accept-btn-handler',
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
      invoiceRow: 'table tbody tr',
      invoiceDate: 'td:nth-child(1)',
      invoiceLink: 'a[href*="pdf"]',
    },
  },
];

function buildManifest(c) {
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    color: c.color,
    letters: c.letters,
    site: c.site,
    implementation: 'scraping',
    description: c.description,
    ...(c.initialStatus ? { initialStatus: c.initialStatus } : {}),
    fields: c.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required !== false,
      ...(f.help ? { help: f.help } : {}),
    })),
    permissions: [
      { name: 'Factures', scope: 'Lecture et écriture' },
      { name: 'Identifiants du connecteur', scope: 'Lecture seule — stockés chiffrés' },
    ],
  };
}

function buildModule(c) {
  const credentialKeys =
    c.credentialKeys || c.fields.filter((f) => f.required !== false).map((f) => f.key);

  const recipe = {
    id: c.id,
    providerName: c.name,
    loginUrl: c.loginUrl,
    invoicesUrl: c.invoicesUrl,
    usernameField: c.usernameField || 'username',
    passwordField: c.passwordField || 'password',
    credentialKeys,
    monthsBack: c.monthsBack || 3,
    selectors: c.selectors,
  };

  return `'use strict';

/**
 * Connecteur ${c.name}.
 *
 * ${c.description}
 * Portail : ${c.loginUrl}
 *${c.note ? `\n * Obstacle connu : ${c.note}\n *` : ''}
 * TODO: scraping réel non validé. Les sélecteurs ci-dessous sont plausibles
 * mais n'ont été testés contre aucun compte réel. Sans Playwright installé,
 * ce connecteur fonctionne en mode simulé (voir server/connectors/scraping.js).
 */

const { makeScrapingConnector } = require('../../scraping');

module.exports = makeScrapingConnector(${JSON.stringify(recipe, null, 2).replace(/\n/g, '\n')});
`;
}

let written = 0;
for (const c of CONNECTORS) {
  const dir = path.join(AVAILABLE, c.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(buildManifest(c), null, 2)}\n`
  );
  fs.writeFileSync(path.join(dir, 'connector.js'), buildModule(c));
  written++;
}

console.log(`${written} connecteurs de scraping générés dans ${AVAILABLE}`);
