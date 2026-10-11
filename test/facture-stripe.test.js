'use strict';

/**
 * Le jeton Stripe ne doit jamais servir d'identifiant ni de nom — lot 32.
 *
 * ─── La panne mesurée que ces tests verrouillent ─────────────────────────────
 *
 * Production du 14/08/2026 : les 11 factures Anthropic étaient rangées sous des
 * noms de 137 caractères portant le jeton d'accès Stripe EN ENTIER — l'URL du
 * PDF se reconstruit depuis lui, sans session, et ces noms partent sur le stockage local
 * puis sur toute destination ajoutée ensuite. Et les run_logs des 13–14/08 ont
 * montré, cinq fois sur la même facture, que ce jeton CHANGE à chaque
 * chargement de la page (horodatage + signature finale) : comme `remote_id`,
 * il aurait fait re-télécharger tout l'historique à chaque passage.
 *
 * Ces tests prouvent trois choses, hors réseau :
 *   1. l'empreinte tirée du jeton est STABLE quand le jeton change, et ne
 *      révèle rien de lui ;
 *   2. le lecteur de pages (documents-de-page) emploie cette empreinte pour
 *      les liens Stripe, et le nom de fichier partagé refuse toute référence
 *      de plus de 40 caractères — pour TOUS les connecteurs qui l'utilisent ;
 *   3. le numéro de facture et la date d'émission se lisent dans le PDF
 *      téléchargé, tables ToUnicode comprises (les PDF Stripe n'écrivent pas
 *      leur texte en clair).
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const stripe = require('../server/connectors/facture-stripe');
const lecteur = require('../server/connectors/documents-de-page');

// ---------------------------------------------------------------------------
// Jetons d'essai — la structure mesurée en production, avec un faux secret
// ---------------------------------------------------------------------------

/** Fabrique un jeton `live_…` comme Stripe : base64(compte,secret,horodatage) + 0200 + signature. */
function jeton({ compte = 'acct_1FauxCompte000', secret = '_SecretDeDemonstration32Caract', horodatage = '177174114', signature = 'UqcpOnfu' } = {}) {
  return `live_${Buffer.from(`${compte},${secret},${horodatage}`).toString('base64').replace(/=+$/, '')}0200${signature}`;
}

const PAGE = (j) => `https://invoice.stripe.com/i/acct_1FauxCompte000/${j}?s=ap`;

// ---------------------------------------------------------------------------
// 1. L'empreinte : stable, courte, muette
// ---------------------------------------------------------------------------

test('deux chargements de la même facture donnent la même empreinte', () => {
  // Ce que la production a mesuré : même secret, horodatage et signature
  // différents à chaque rendu de la page.
  const chargement1 = jeton({ horodatage: '177174114', signature: 'UqcpOnfu' });
  const chargement2 = jeton({ horodatage: '177248588', signature: 'xzp8HUnm' });
  assert.notEqual(chargement1, chargement2);

  const e1 = stripe.referenceStable(PAGE(chargement1));
  const e2 = stripe.referenceStable(PAGE(chargement2));
  assert.equal(e1, e2);
  assert.match(e1, /^[0-9a-f]{12}$/);
});

test('deux factures différentes ne partagent jamais leur empreinte', () => {
  const a = stripe.referenceStable(PAGE(jeton({ secret: '_SecretFactureAvril0000000000' })));
  const b = stripe.referenceStable(PAGE(jeton({ secret: '_SecretFactureJuillet00000000' })));
  assert.notEqual(a, b);
});

test('l\'empreinte ne contient rien du jeton ni du secret', () => {
  const j = jeton();
  const empreinte = stripe.empreinteDuJeton(j);
  // Aucun fragment de 6 caractères de l'empreinte n'apparaît dans le jeton :
  // elle ne « cite » pas ce qu'elle recouvre, elle le hache.
  for (let i = 0; i + 6 <= empreinte.length; i++) {
    assert.ok(!j.includes(empreinte.slice(i, i + 6)), `fragment ${empreinte.slice(i, i + 6)} présent dans le jeton`);
  }
});

test('une adresse qui n\'est pas une facture Stripe ne produit pas d\'empreinte', () => {
  assert.equal(stripe.referenceStable('https://exemple.fr/facture.pdf'), null);
  assert.equal(stripe.referenceStable('https://pay.stripe.com/invoice/acct_x/live_y/pdf'), null);
  // Un jeton sans la structure « compte,secret » mesurée : on ne fabrique pas
  // d'identifiant sur une supposition.
  assert.equal(stripe.empreinteDuJeton('live_YWNjdF8xTUV4'), null);
});

// ---------------------------------------------------------------------------
// 2. Le lecteur de pages et le nom de fichier — transverse
// ---------------------------------------------------------------------------

test('un lien de facture Stripe reçoit l\'empreinte comme identifiant, jamais le jeton', () => {
  const releve = (j) => lecteur.documentsDepuisLiens(
    [{ href: PAGE(j), texte: 'Télécharger', ligne: 'Facture 9 avril 2026 45,00 €' }],
    { prefixe: 'anthropic-' }
  );

  const passage1 = releve(jeton({ horodatage: '177174114', signature: 'UqcpOnfu' }));
  const passage2 = releve(jeton({ horodatage: '177248588', signature: 'xzp8HUnm' }));

  // Identifiant stable d'un passage à l'autre : c'est lui qui empêche crabe de
  // re-télécharger tout l'historique à chaque exécution.
  assert.equal(passage1[0].remoteId, passage2[0].remoteId);
  assert.match(passage1[0].remoteId, /^anthropic-[0-9a-f]{12}$/);
  assert.equal(passage1[0].issuedOn, '2026-04-09');
});

test('le nom de fichier partagé refuse toute référence de plus de 40 caractères', () => {
  const long = `anthropic-${jeton()}`;
  const nom = lecteur.nomFichier('anthropic', { issuedOn: '2026-04-09', remoteId: long });

  assert.ok(nom.length <= 40, `nom trop long (${nom.length}) : ${nom}`);
  // Aucune fenêtre de 20 caractères du jeton ne survit dans le nom : ni le
  // jeton entier, ni un tronçon qui garderait une partie du secret.
  const j = jeton();
  for (let i = 0; i + 20 <= j.length; i += 5) {
    assert.ok(!nom.includes(j.slice(i, i + 20)), `tronçon du jeton dans le nom : ${nom}`);
  }
  // Et le nom reste daté : le dossier se trie toujours tout seul.
  assert.match(nom, /^anthropic_2026-04_[0-9a-f]{12}\.pdf$/);
});

test('une référence légitime traverse intacte, préfixe du connecteur déduit', () => {
  assert.equal(
    lecteur.nomFichier('anthropic', { issuedOn: '2026-04-08', remoteId: 'anthropic-CJV04PWS-0002' }),
    'anthropic_2026-04_CJV04PWS-0002.pdf'
  );
  // La plus longue référence légitime relevée (28 caractères, préfixe compris)
  // passe sans être hachée.
  assert.equal(
    lecteur.nomFichier('mistral', { issuedOn: null, remoteId: 'mistral-MSTRL-API-781711-001' }),
    'mistral_MSTRL-API-781711-001.pdf'
  );
});

test('aucun connecteur ne laisse passer un jeton dans un nom de fichier', () => {
  // Transverse : tout connecteur du catalogue qui expose `nomFichier` est
  // appelé avec un document portant le jeton en guise d'identifiant distant.
  // Ceux qui nomment autrement (année + libellé…) produisent un nom qui
  // n'emploie pas l'identifiant : l'assertion est alors trivialement vraie —
  // c'est voulu, ils ne peuvent pas fuir ce qu'ils n'utilisent pas.
  const j = jeton();
  const doc = { issuedOn: '2026-04-09', remoteId: `service-${j}`, url: PAGE(j), amount: '45,00 €' };
  const racine = path.join(__dirname, '..', 'server', 'connectors', 'available');
  let verifies = 0;

  for (const dossier of fs.readdirSync(racine)) {
    const fichier = path.join(racine, dossier, 'connector.js');
    if (!fs.existsSync(fichier)) continue;
    const mod = require(fichier);
    if (typeof mod.nomFichier !== 'function') continue;

    let nom;
    try {
      nom = mod.nomFichier(doc);
    } catch {
      continue; // signature incompatible : ce connecteur ne nomme pas par document
    }
    if (typeof nom !== 'string') continue;

    verifies++;
    for (let i = 0; i + 20 <= j.length; i += 5) {
      assert.ok(
        !nom.includes(j.slice(i, i + 20)),
        `${dossier} : un tronçon du jeton survit dans « ${nom} »`
      );
    }
  }

  // Les quatre connecteurs qui nomment via le module partagé, au minimum :
  // anthropic, mistral, hetzner, proxmox. Si ce compte tombe, le test ne
  // vérifie plus rien — il doit casser plutôt que se taire.
  assert.ok(verifies >= 4, `${verifies} connecteur(s) vérifié(s) seulement`);
});

// ---------------------------------------------------------------------------
// 3. Le PDF : numéro de facture et date d'émission
// ---------------------------------------------------------------------------

/**
 * Un PDF « à la Stripe » : texte en chaînes hexadécimales de numéros de
 * glyphes, correspondance dans une table ToUnicode. C'est la structure des 11
 * PDF réels du stockage local (relevée le 14/08/2026), tiret du numéro compris — il
 * y sort en U+0000, glyphe sans correspondance dans le sous-ensemble.
 */
function pdfFactice(texte, { tiretMuet = true } = {}) {
  const caracteres = [...new Set(texte)];
  const codeDe = new Map(caracteres.map((c, i) => [c, i + 1]));

  const bfchar = caracteres
    .map((c) => {
      const code = codeDe.get(c).toString(16).padStart(4, '0');
      // Le tiret « muet » reproduit les PDF réels : sa cible est U+0000.
      const cible = tiretMuet && c === '-' ? '0000' : c.charCodeAt(0).toString(16).padStart(4, '0');
      return `<${code}> <${cible}>`;
    })
    .join('\n');
  const cmap = zlib.deflateSync(Buffer.from(
    `/CIDInit /ProcSet findresource begin\nbeginbfchar\n${bfchar}\nendbfchar\nend`
  ));

  const contenu = zlib.deflateSync(Buffer.from(
    `BT /F1 9 Tf ${[...texte]
      .map((c) => `<${codeDe.get(c).toString(16).padStart(4, '0')}> Tj`)
      .join(' ')} ET`
  ));

  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + cmap.length + ' >>\nstream\n'),
    cmap,
    Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Length ' + contenu.length + ' >>\nstream\n'),
    contenu,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
}

test('le numéro et la date d\'émission se lisent dans le PDF, tiret muet compris', () => {
  const releve = stripe.analyserPdf(pdfFactice(
    'Page 1 of 1 Invoice Invoice number CJV04PWS-0013 Date of issue August 13, 2026 Date due August 13, 2026'
  ));
  assert.equal(releve.numero, 'CJV04PWS-0013');
  assert.equal(releve.dateEmission, '2026-08-13');
});

test('un PDF servi en français se lit aussi', () => {
  const releve = stripe.analyserPdf(pdfFactice(
    'Facture Numéro de facture CJV04PWS-0006 Date d\'émission 9 mai 2026',
    { tiretMuet: false }
  ));
  assert.equal(releve.numero, 'CJV04PWS-0006');
  assert.equal(releve.dateEmission, '2026-05-09');
});

test('un PDF au texte décomposé (é = e + accent) se date quand même', () => {
  // Le cas réel du 19/08/2026 : la facture Lago de Mistral livre son texte en
  // forme décomposée, et « Date d'émission 12 févr. 2026 » échappait à
  // `[ée]mission` — analyserPdf rendait null là où le PDF disait la date.
  const releve = stripe.analyserPdf(pdfFactice(
    'Date d\'émission 12 févr. 2026 Délai de paiement 0 jours'.normalize('NFD'),
    { tiretMuet: false }
  ));
  assert.equal(releve.dateEmission, '2026-02-12');
});

test('mistral : le PDF est le repli de date quand la ligne de la page n\'en porte pas', () => {
  const mistral = require('../server/connectors/available/mistral/connector');
  const pdfDate = pdfFactice('Date d\'émission 12 févr. 2026', { tiretMuet: false });
  const lago = 'https://api.eu.getlago.com/rails/active_storage/blobs/redirect/jeton/MSTRL-API-781711-001.pdf';

  // Ligne sans date (le rangement « inconnu » du 13/08/2026) : le PDF parle.
  const repli = mistral.releveDuPdf({ url: lago, issuedOn: null }, pdfDate);
  assert.equal(repli.dateEmission, '2026-02-12');

  // Ligne datée : la page fait foi, le PDF n'est pas consulté.
  const page = mistral.releveDuPdf({ url: lago, issuedOn: '2026-03-01' }, pdfDate);
  assert.deepEqual(page, { numero: null, dateEmission: null });

  // Une page de facture Stripe se lit toujours dans le PDF, datée ou non.
  const stripePage = mistral.releveDuPdf(
    { url: 'https://invoice.stripe.com/i/acct_1/jeton', issuedOn: '2026-03-01' },
    pdfDate
  );
  assert.equal(stripePage.dateEmission, '2026-02-12');
});

test('un PDF sans table ToUnicode rend des nuls, jamais une erreur', () => {
  const scraping = require('../server/connectors/scraping');
  const releve = stripe.analyserPdf(scraping.fakePdf(['Invoice number FAUX-0001']));
  assert.deepEqual(releve, { numero: null, dateEmission: null });
  assert.deepEqual(stripe.analyserPdf(Buffer.from('pas un pdf')), { numero: null, dateEmission: null });
});
