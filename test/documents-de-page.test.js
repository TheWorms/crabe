'use strict';

/**
 * Le lecteur de page partagé par les connecteurs du lot 20.
 *
 * ─── Ce que ces tests prouvent, et ce qu'ils ne prouvent PAS ─────────────────
 *
 * Ils prouvent que, **à partir d'une page donnée**, le module reconnaît les
 * bons liens, lit les bonnes dates et fabrique les bons noms de fichier. C'est
 * la seule chose vérifiable hors réseau, et c'est justement la partie où une
 * erreur serait silencieuse : un lien d'aide pris pour une facture dépose une
 * page web dans les documents de quelqu'un, et un identifiant instable fait
 * retélécharger tout l'historique à chaque passage.
 *
 * Ils ne prouvent RIEN sur la forme réelle des pages de Mistral, d'Invoice
 * Ninja, d'Envato, d'Anthropic ou de Hetzner : personne ne les a vues derrière
 * une session. Les pages d'exemple ci-dessous sont des reconstitutions
 * plausibles, écrites pour exercer le lecteur — pas des relevés du terrain. Le
 * jour où quelqu'un voit la vraie page, c'est ce fichier qu'il faudra corriger
 * en premier.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const lecteur = require('../server/connectors/documents-de-page');

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('dateDepuisTexte lit les quatre écritures que ces consoles emploient', () => {
  assert.equal(lecteur.dateDepuisTexte('Émise le 2026-07-12'), '2026-07-12');
  assert.equal(lecteur.dateDepuisTexte('Facture du 12/07/2026'), '2026-07-12');
  assert.equal(lecteur.dateDepuisTexte('12 juillet 2026 — 24,00 €'), '2026-07-12');
  assert.equal(lecteur.dateDepuisTexte('July 12, 2026'), '2026-07-12');
  assert.equal(lecteur.dateDepuisTexte('12 Jul 2026'), '2026-07-12');
  assert.equal(lecteur.dateDepuisTexte('Jul 12, 2026'), '2026-07-12');
});

test('un jour d\'un chiffre est complété, pas laissé tel quel', () => {
  // « 2026-7-5 » dans un nom de fichier trierait après « 2026-12-01 ».
  assert.equal(lecteur.dateDepuisTexte('5 mars 2026'), '2026-03-05');
  assert.equal(lecteur.dateDepuisTexte('1er avril 2026'), '2026-04-01');
  assert.equal(lecteur.dateDepuisTexte('3/4/2026'), '2026-04-03');
});

test('la lecture jour-d\'abord est la règle, y compris quand elle est discutable', () => {
  // 07/12/2026 vaut « 12 juillet », JAMAIS « 7 décembre » — voir le commentaire
  // du module. Ce test existe pour que la règle ne change pas par accident.
  assert.equal(lecteur.dateDepuisTexte('07/12/2026'), '2026-12-07');
  assert.equal(lecteur.dateDepuisTexte('12/07/2026'), '2026-07-12');
});

test('un mois sans jour est rangé au premier du mois, pas ignoré', () => {
  assert.equal(lecteur.dateDepuisTexte('Période : juillet 2026'), '2026-07-01');
  assert.equal(lecteur.dateDepuisTexte('Usage 2026-07'), '2026-07-01');
});

test('un texte sans date rend null, sans lever', () => {
  assert.equal(lecteur.dateDepuisTexte('Télécharger'), null);
  assert.equal(lecteur.dateDepuisTexte(''), null);
  assert.equal(lecteur.dateDepuisTexte(null), null);
  assert.equal(lecteur.dateDepuisTexte(undefined), null);
});

// ---------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------

test('montantDepuisTexte recopie le montant tel qu\'il est écrit', () => {
  assert.equal(lecteur.montantDepuisTexte('Total 24,00 €'), '24,00 €');
  // Symbole ET code de devise sont conservés quand le site écrit les deux :
  // recopier, c'est recopier — pas choisir lequel des deux mérite de rester.
  assert.equal(lecteur.montantDepuisTexte('$12.50 USD'), '$12.50 USD');
  assert.equal(lecteur.montantDepuisTexte('1 234,56 EUR'), '1 234,56 EUR');
  assert.equal(lecteur.montantDepuisTexte('aucun montant ici'), null);
});

// ---------------------------------------------------------------------------
// Reconnaissance d'un lien
// ---------------------------------------------------------------------------

test('un lien vers un PDF est un document, quel que soit son libellé', () => {
  assert.equal(
    lecteur.estLienDeDocument({ href: 'https://x.test/files/9f2a.pdf', texte: '⬇' }),
    true
  );
});

test('un mot de document dans l\'adresse suffit, même sans extension', () => {
  assert.equal(
    lecteur.estLienDeDocument({ href: 'https://x.test/billing/invoice/7712', texte: 'Voir' }),
    true
  );
});

test('« Paramètres de facturation » n\'est PAS une facture', () => {
  // Le défaut que ce filtre prévient : déposer une page de réglages dans les
  // documents de quelqu'un, avec une date et un nom qui font illusion.
  assert.equal(
    lecteur.estLienDeDocument({
      href: 'https://x.test/settings/billing',
      texte: 'Paramètres de facturation',
    }),
    false
  );
  assert.equal(
    lecteur.estLienDeDocument({
      href: 'https://x.test/help/invoices',
      texte: 'Comment lire ma facture',
    }),
    false
  );
});

test('un lien non-HTTP ou vide n\'est jamais un document', () => {
  assert.equal(lecteur.estLienDeDocument({ href: 'javascript:void(0)', texte: 'Facture' }), false);
  assert.equal(lecteur.estLienDeDocument({ href: 'mailto:a@b.test', texte: 'Facture' }), false);
  assert.equal(lecteur.estLienDeDocument({}), false);
});

// ---------------------------------------------------------------------------
// Identifiant distant
// ---------------------------------------------------------------------------

test('la référence vient de l\'adresse, pas du rang dans la page', () => {
  // C'est LE point qui décide de l'idempotence : une facture de plus en tête de
  // liste décale tous les rangs, et un identifiant fondé sur le rang ferait
  // retélécharger l'historique entier sous de nouveaux noms.
  assert.equal(lecteur.referenceDepuisLien('https://x.test/invoices/INV-0042.pdf'), 'INV-0042');
  assert.equal(lecteur.referenceDepuisLien('https://x.test/billing/pdf?invoice=7712'), '7712');
  assert.equal(lecteur.referenceDepuisLien('https://x.test/download/a1b2c3d4'), 'a1b2c3d4');
});

test('les mots de plomberie ne servent jamais de référence', () => {
  // « /invoices/download » donnerait « download » pour TOUTES les factures :
  // une seule survivrait au dédoublonnage, les autres disparaîtraient.
  assert.notEqual(lecteur.referenceDepuisLien('https://x.test/invoices/download'), 'download');
  assert.equal(lecteur.referenceDepuisLien('https://x.test/'), null);
});

// ---------------------------------------------------------------------------
// Une page d'exemple, de bout en bout
// ---------------------------------------------------------------------------

/**
 * Ce que le connecteur relève dans une page : chaque lien, son texte, et le
 * texte de la ligne qui le porte. Reconstitution plausible d'un tableau de
 * facturation — pas un relevé du terrain (voir l'en-tête de ce fichier).
 */
const PAGE_EXEMPLE = [
  {
    href: 'https://console.test/settings/billing',
    texte: 'Paramètres de facturation',
    ligne: 'Paramètres de facturation Modifier',
  },
  {
    href: 'https://console.test/invoices/INV-2026-07.pdf',
    texte: 'PDF',
    ligne: 'Facture INV-2026-07 12 juillet 2026 Payée 24,00 € PDF',
  },
  {
    href: 'https://console.test/invoices/INV-2026-06.pdf',
    texte: 'PDF',
    ligne: 'Facture INV-2026-06 12 juin 2026 Payée 24,00 € PDF',
  },
  {
    href: 'https://console.test/help/billing-faq',
    texte: 'Questions fréquentes sur la facturation',
    ligne: 'Questions fréquentes sur la facturation',
  },
  {
    // Deux liens vers le MÊME document : l'icône et le libellé de la ligne.
    href: 'https://console.test/invoices/INV-2026-07.pdf',
    texte: 'Télécharger',
    ligne: 'Facture INV-2026-07 12 juillet 2026 Payée 24,00 € PDF',
  },
];

test('la page d\'exemple rend deux documents, et seulement les deux bons', () => {
  const documents = lecteur.documentsDepuisLiens(PAGE_EXEMPLE, { prefixe: 'exemple-' });

  assert.equal(documents.length, 2, 'ni les réglages, ni la FAQ, ni le doublon');
  assert.deepEqual(
    documents.map((d) => d.remoteId),
    ['exemple-INV-2026-07', 'exemple-INV-2026-06']
  );
  assert.deepEqual(
    documents.map((d) => d.issuedOn),
    ['2026-07-12', '2026-06-12'],
    'la date vient de la LIGNE, pas du texte du lien qui ne dit que « PDF »'
  );
  assert.equal(documents[0].amount, '24,00 €');
});

test('le préfixe évite qu\'une source en masque une autre', () => {
  const a = lecteur.documentsDepuisLiens(PAGE_EXEMPLE, { prefixe: 'mistral-' })[0];
  const b = lecteur.documentsDepuisLiens(PAGE_EXEMPLE, { prefixe: 'hetzner-' })[0];
  assert.notEqual(a.remoteId, b.remoteId);
});

test('une page sans aucun lien rend une liste vide, pas une erreur', () => {
  assert.deepEqual(lecteur.documentsDepuisLiens([]), []);
  assert.deepEqual(lecteur.documentsDepuisLiens(null), []);
});

// ---------------------------------------------------------------------------
// Noms de fichier
// ---------------------------------------------------------------------------

test('le nom de fichier commence par la période : un dossier se trie tout seul', () => {
  // Depuis le lot 32, le préfixe de connecteur porté par l'identifiant distant
  // n'est plus répété : le service ouvre déjà le nom, « mistral_mistral-… »
  // était une redite.
  assert.equal(
    lecteur.nomFichier('mistral', { issuedOn: '2026-07-12', remoteId: 'mistral-INV-0042' }),
    'mistral_2026-07_INV-0042.pdf'
  );
});

test('un document sans date garde un nom lisible et unique', () => {
  assert.equal(
    lecteur.nomFichier('hetzner', { issuedOn: null, remoteId: 'hetzner-R0001234' }),
    'hetzner_R0001234.pdf'
  );
});

test('un nom de fichier ne porte ni accent, ni espace, ni barre oblique', () => {
  const nom = lecteur.nomFichier('Envato Market', {
    issuedOn: '2026-07-12',
    remoteId: 'reçu/août 2026',
  });
  assert.match(nom, /^[A-Za-z0-9_-]+\.pdf$/, nom);
});

test('deux documents du même mois ne produisent jamais le même nom', () => {
  const a = lecteur.nomFichier('paypal', { issuedOn: '2026-07-01', remoteId: 'a1' });
  const b = lecteur.nomFichier('paypal', { issuedOn: '2026-07-28', remoteId: 'b2' });
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// La route de téléchargement Stripe — lot 31, tâche 8
// ---------------------------------------------------------------------------
//
// Mesuré au curl le 14/08/2026 sur la facture réelle qui échouait :
//
//   GET invoice.stripe.com/i/acct_…/live_…      → 200, text/html, 745 octets
//   GET invoice.stripe.com/i/acct_…/live_…/pdf  → 200, text/html, 745 octets
//   GET pay.stripe.com/invoice/acct_…/live_…/pdf → 200, application/octet-stream,
//                                                  34 837 octets, « %PDF-1.4 »
//
// 745 octets, c'est la coquille JavaScript qui PEINT la facture — c'est elle
// que crabe déposait en croyant tenir un PDF. La page qui montre et la route
// qui sert ne sont pas au même endroit (même famille que Proxmox au lot 20).

test('un lien de page Stripe est traduit vers la route qui sert le PDF', () => {
  assert.equal(
    lecteur.urlDeTelechargement(
      'https://invoice.stripe.com/i/acct_1MExQ9BjIQrRQnux/live_YWNjdF8xTUV4?s=ap'
    ),
    'https://pay.stripe.com/invoice/acct_1MExQ9BjIQrRQnux/live_YWNjdF8xTUV4/pdf'
  );
});

test('toute adresse qui n\'est pas une page de facture Stripe ressort inchangée', () => {
  for (const url of [
    'https://console.anthropic.com/factures/12.pdf',
    'https://pay.stripe.com/invoice/acct_x/live_y/pdf', // déjà la bonne route
    'https://exemple.fr/invoice.stripe.com/i/acct_x/y', // le motif n'est pas en tête
    '',
  ]) {
    assert.equal(lecteur.urlDeTelechargement(url), url);
  }
});

test('l\'identifiant journalisé est tronqué : jamais le jeton entier', () => {
  const jeton = 'anthropic-live_YWNjdF8xTUV4UTlCaklRclJRbnV4LF9WNENqVU00';
  const court = lecteur.idPourJournal(jeton);
  assert.equal(court, `anthropic-live_YWNjd… (${jeton.length} car.)`);
  assert.equal(court.includes('UTlCaklRclJRbnV4'), false, 'le corps du jeton ne doit pas passer');

  // Un identifiant court reste entier : « FR78321943 » se reconnaît d'un œil.
  assert.equal(lecteur.idPourJournal('FR78321943'), 'FR78321943');
  assert.equal(lecteur.idPourJournal(null), '');
});

// Le BRANCHEMENT, pas seulement la fonction (leçon du lot 29 : un test qui
// vérifie le bon HTML sans vérifier qu'il est branché laisse tout débrancher).
// On rejoue telecharger() des deux consoles Stripe avec un faux contexte, et
// on jure de l'adresse réellement demandée et du message réellement levé.
for (const console_ of ['anthropic', 'mistral']) {
  test(`${console_} : telecharger() demande la route PDF et tronque l'identifiant`, async () => {
    const mod = require(`../server/connectors/available/${console_}/connector`);
    const demandees = [];
    const contexte = {
      request: {
        get: async (url) => {
          demandees.push(url);
          return {
            status: () => 200,
            ok: () => true,
            body: async () => Buffer.from('<!doctype html>coquille de 745 octets'),
          };
        },
      },
    };
    const document = {
      url: 'https://invoice.stripe.com/i/acct_1MExQ9BjIQrRQnux/live_YWNjdF8xTUV4UTlCaklRclJRbnV4',
      remoteId: `${console_}-live_YWNjdF8xTUV4UTlCaklRclJRbnV4LF9WNENqVU00`,
    };

    await assert.rejects(
      () => mod.telecharger(contexte, document),
      (err) => {
        assert.match(err.message, /n'est pas un PDF/);
        assert.equal(
          err.message.includes(document.remoteId),
          false,
          'le message porte encore l\'identifiant entier'
        );
        return true;
      }
    );

    assert.deepEqual(
      demandees,
      ['https://pay.stripe.com/invoice/acct_1MExQ9BjIQrRQnux/live_YWNjdF8xTUV4UTlCaklRclJRbnV4/pdf'],
      'le téléchargement doit viser la route qui SERT le PDF, pas la page qui le montre'
    );

    // Et quand la route sert bien un PDF, il arrive entier.
    contexte.request.get = async () => ({
      status: () => 200,
      ok: () => true,
      body: async () => Buffer.from('%PDF-1.4 contenu'),
    });
    const buffer = await mod.telecharger(contexte, document);
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  });
}
