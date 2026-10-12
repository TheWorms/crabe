'use strict';

/**
 * Lot 79 — Auto-Doc et Coyote : les annonces deviennent connecteurs.
 *
 * Les parcours réels n'ont jamais été exercés (aucune session au moment du
 * lot) : ces tests prouvent ce qui EST prouvable hors session —
 *
 *   1. les fonctions pures (ancres, dates du menu, adresse de détail, renvoi
 *      d'anonyme d'Auto-Doc mesuré vers la racine) ;
 *   2. les extractions DANS la page, jouées sur un DOM factice — dont LA
 *      GARDE QUI COMPTE : chez Coyote, un bouton « Payer » n'est JAMAIS
 *      cliqué, même quand il est le seul déclencheur de la ligne ;
 *   3. les manifestes : pending, site corrigé (auto-doc.fr, pas le domaine
 *      mort autodoc.fr), preuve de session déclarée comme mesurée.
 *
 * ⚠ Toutes les valeurs (numéros, jetons, dates) sont INVENTÉES (§1bis).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const autodoc = require('../server/connectors/available/autodoc/connector');
const coyote = require('../server/connectors/available/coyote/connector');

// ---------------------------------------------------------------------------
// Un DOM factice minuscule — juste ce que les extractions consomment
// ---------------------------------------------------------------------------

class Noeud {
  constructor(tag, { texte = '', attrs = {}, enfants = [], visible = true } = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = attrs;
    this.children = enfants;
    this.parentElement = null;
    this.offsetWidth = visible ? 10 : 0;
    this.offsetHeight = visible ? 10 : 0;
    this.clics = 0;
    this.propreTexte = texte;
    for (const enfant of enfants) enfant.parentElement = this;
  }

  get innerText() {
    return [this.propreTexte, ...this.children.map((c) => c.innerText)]
      .filter(Boolean).join('\n');
  }

  getAttribute(nom) { return this.attrs[nom] ?? null; }
  click() { this.clics += 1; }
  scrollIntoView() { /* rien : le factice n'a pas d'écran */ }

  * descendants() {
    for (const enfant of this.children) {
      yield enfant;
      yield* enfant.descendants();
    }
  }

  correspond(selecteur) {
    const s = selecteur.trim();
    if (s === '*') return true;
    if (s === '[role="button"]') return this.attrs.role === 'button';
    const href = /^a\[href\*="(.+)"\]$/.exec(s);
    if (href) return this.tagName === 'A' && String(this.attrs.href || '').includes(href[1]);
    return this.tagName === s.toUpperCase();
  }

  querySelectorAll(selecteurs) {
    const liste = selecteurs.split(',').map((x) => x.trim());
    return [...this.descendants()].filter((el) => liste.some((s) => el.correspond(s)));
  }

  closest(selecteurs) {
    const liste = selecteurs.split(',').map((x) => x.trim());
    for (let el = this; el; el = el.parentElement) {
      if (liste.some((s) => el.correspond(s))) return el;
    }
    return null;
  }
}

/** Joue `fn` (une extraction de page) avec `racine` pour document. */
function dansLaPage(racine, fn, argument) {
  global.document = {
    body: racine,
    querySelectorAll: (sel) => racine.querySelectorAll(sel),
  };
  try {
    return fn(argument);
  } finally {
    delete global.document;
  }
}

// ---------------------------------------------------------------------------
// 1. Auto-Doc — fonctions pures
// ---------------------------------------------------------------------------

test('Auto-Doc : le renvoi d\'anonyme mesuré est LA RACINE du site, pas un /login', () => {
  assert.equal(autodoc.estPageAuthentification('https://www.auto-doc.fr/'), true);
  assert.equal(autodoc.estPageAuthentification('https://auto-doc.fr/'), true);
  assert.equal(autodoc.estPageAuthentification('https://www.auto-doc.fr/profile/orders'), false);
  assert.equal(autodoc.estPageAuthentification('https://www.auto-doc.fr/login'), true,
    'le motif générique reste pour un éventuel vrai /login');
  assert.equal(autodoc.estPageAuthentification('https://www.exemple.test/'), false,
    'la racine d\'un AUTRE site ne prouve rien');
});

test('Auto-Doc : l\'adresse de détail vient du numéro, encodée', () => {
  assert.equal(autodoc.adresseDetail('123456'), 'https://www.auto-doc.fr/profile/order/123456');
  assert.equal(autodoc.adresseDetail('A B'), 'https://www.auto-doc.fr/profile/order/A%20B');
});

test('Auto-Doc : une entrée du menu rend son rang et sa date « AAAA.MM.JJ »', () => {
  assert.deepEqual(
    autodoc.analyserEntreeMenu('Facture n° 1 · émise le 2026.05.12', 0),
    { rang: 1, issuedOn: '2026-05-12' }
  );
  assert.deepEqual(
    autodoc.analyserEntreeMenu('Facture n° 2 · émise le 2026.07.03', 0),
    { rang: 2, issuedOn: '2026-07-03' },
    'le rang vient du libellé, pas de la position'
  );
  const sansRang = autodoc.analyserEntreeMenu('émise le 2026.01.15', 2);
  assert.equal(sansRang.rang, 3, 'sans libellé de rang, la position sert de repli');
  assert.equal(autodoc.analyserEntreeMenu('Facture n° 1', 0).issuedOn, null,
    'sans date lisible, rien n\'est inventé');
});

test('Auto-Doc : l\'ancre désigne la commande — le rang seulement au-delà de la première', () => {
  assert.equal(autodoc.remoteIdFacture('123 456', 1), 'autodoc-commande-123456');
  assert.equal(autodoc.remoteIdFacture('123456', 2), 'autodoc-commande-123456-facture-2');
});

test('Auto-Doc : la liste ne livre que les numéros — jamais le texte des cartes (§1bis)', () => {
  const page = new Noeud('body', {
    texte: 'Numéro de commande : 111222 Livraison : 12 rue Inventée 75000 Exemple '
      + 'Total : 89,90 € Numéro de commande : 333444 Moyen de paiement : carte',
    enfants: [new Noeud('a', { texte: 'Page suivante' })],
  });
  const releve = dansLaPage(page, autodoc.EXTRAIRE_NUMEROS);
  assert.deepEqual(releve.numeros, ['111222', '333444']);
  assert.equal(releve.formesPagination, 1, 'la pagination est COMPTÉE, jamais cliquée');
  const sortie = JSON.stringify(releve);
  assert.equal(/rue|€|paiement|carte/i.test(sortie), false,
    'adresse, montant et moyen de paiement ne sortent pas de la page');
});

test('Auto-Doc : le menu livre le href pour le clic, mais le jeton ne fuit pas dans le texte', () => {
  const jeton = 'eyJhbGciOiJIUzI1NiJ9.jetonInventeTresLong.signatureInventee';
  const lien = new Noeud('a', {
    texte: 'Facture n° 1',
    attrs: { href: `/print-invoice/${jeton}` },
  });
  const page = new Noeud('body', {
    enfants: [new Noeud('li', { texte: 'émise le 2026.05.12', enfants: [lien] })],
  });
  const entrees = dansLaPage(page, autodoc.EXTRAIRE_MENU);
  assert.equal(entrees.length, 1);
  assert.ok(entrees[0].href.includes(jeton), 'le href sert au clic dans la page');
  assert.equal(entrees[0].texte.includes(jeton), false, 'le texte relevé ne porte pas le jeton');
  assert.match(entrees[0].texte, /Facture n° 1/);
  assert.match(entrees[0].texte, /émise le 2026\.05\.12/);
});

// ---------------------------------------------------------------------------
// 2. Coyote — la garde de règlement, mordue sur DOM factice
// ---------------------------------------------------------------------------

test('Coyote : ancre et date de ligne', () => {
  assert.equal(coyote.remoteIdFacture('F 2026/001'), 'coyote-facture-F-2026-001');
  assert.equal(coyote.dateFacture('12/05/2026'), '2026-05-12');
  assert.equal(coyote.dateFacture('3 février 2026'), '2026-02-03');
  assert.equal(coyote.dateFacture('n\'importe quoi'), null);
});

test('Coyote : la garde reconnaît tous les libellés de règlement relevés', () => {
  for (const libelle of ['Payer', 'payer ma facture', 'Régler', 'Règlement', 'Paiement en ligne', 'Pay now', 'Carte bancaire', 'Prélèvement']) {
    assert.ok(coyote.MOTIF_REGLEMENT.test(libelle), `« ${libelle} » doit être refusé`);
  }
  assert.equal(coyote.MOTIF_REGLEMENT.test('Télécharger'), false);
});

/** La ligne de facture type : numéro, date, montant, Télécharger ET Payer. */
function ligneFacture({ numero, avecTelecharger = true, avecPayer = true }) {
  const enfants = [new Noeud('span', { texte: `N° de facture : ${numero}` })];
  enfants.push(new Noeud('span', { texte: '12/05/2026' }));
  enfants.push(new Noeud('span', { texte: '39,90 €' }));
  if (avecPayer) enfants.push(new Noeud('button', { texte: 'Payer' }));
  if (avecTelecharger) enfants.push(new Noeud('button', { texte: 'Télécharger' }));
  return new Noeud('div', { enfants });
}

test('Coyote : « Télécharger » est cliqué, « Payer » JAMAIS — même côte à côte', () => {
  const ligne = ligneFacture({ numero: 'F-0001' });
  const page = new Noeud('body', { enfants: [ligne] });
  const clique = dansLaPage(page, coyote.CLIQUER_TELECHARGER, {
    numero: 'F-0001',
    motifReglement: coyote.MOTIF_REGLEMENT.source,
  });
  assert.equal(clique, true);
  const boutons = ligne.querySelectorAll('button');
  const payer = boutons.find((b) => b.propreTexte === 'Payer');
  const telecharger = boutons.find((b) => b.propreTexte === 'Télécharger');
  assert.equal(telecharger.clics, 1);
  assert.equal(payer.clics, 0, 'le bouton « Payer » ne se touche jamais');
});

test('Coyote : une ligne SANS « Télécharger » ne clique rien du tout — surtout pas « Payer »', () => {
  const ligne = ligneFacture({ numero: 'F-0002', avecTelecharger: false });
  const page = new Noeud('body', { enfants: [ligne] });
  const clique = dansLaPage(page, coyote.CLIQUER_TELECHARGER, {
    numero: 'F-0002',
    motifReglement: coyote.MOTIF_REGLEMENT.source,
  });
  assert.equal(clique, false);
  const payer = ligne.querySelectorAll('button').find((b) => b.propreTexte === 'Payer');
  assert.equal(payer.clics, 0);
});

test('Coyote : un « Télécharger et payer » inventé par le site serait refusé aussi', () => {
  const piege = new Noeud('button', { texte: 'Télécharger et payer' });
  const ligne = new Noeud('div', {
    enfants: [new Noeud('span', { texte: 'N° de facture : F-0003' }), piege],
  });
  const page = new Noeud('body', { enfants: [ligne] });
  const clique = dansLaPage(page, coyote.CLIQUER_TELECHARGER, {
    numero: 'F-0003',
    motifReglement: coyote.MOTIF_REGLEMENT.source,
  });
  assert.equal(clique, false);
  assert.equal(piege.clics, 0);
});

test('Coyote : le dépliage vise le TITRE de section, et les lignes ne livrent ni montant ni avertissement', () => {
  const titreAttente = new Noeud('h2', { texte: 'Mes factures en attente de paiement' });
  const payerEnTete = new Noeud('button', { texte: 'Payer' });
  const titreAutres = new Noeud('h2', { texte: 'Mes autres factures' });
  const page = new Noeud('body', {
    enfants: [
      new Noeud('section', { enfants: [titreAttente, payerEnTete, ligneFacture({ numero: 'F-0004' })] }),
      new Noeud('section', { enfants: [titreAutres] }),
    ],
  });

  const depliees = dansLaPage(page, coyote.DEPLIER_SECTIONS, {
    motifSection: coyote.MOTIF_SECTION.source,
    motifReglement: coyote.MOTIF_REGLEMENT.source,
  });
  assert.equal(depliees, 2, 'les deux titres sont cliqués');
  assert.equal(titreAttente.clics, 1);
  assert.equal(titreAutres.clics, 1);
  assert.equal(payerEnTete.clics, 0, 'le « Payer » en tête de section ne se touche jamais');

  const lignes = dansLaPage(page, coyote.EXTRAIRE_LIGNES);
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].numero, 'F-0004');
  assert.equal(lignes[0].dateTexte, '12/05/2026');
  assert.equal(/€|payer/i.test(JSON.stringify(lignes)), false,
    'ni montant ni libellé de paiement ne sortent de la page (§1bis)');
});

test('Coyote : un titre de section qui porterait AUSSI « Payer » resterait replié', () => {
  const piege = new Noeud('h2', { texte: 'Mes factures en attente de paiement — Payer' });
  const page = new Noeud('body', { enfants: [new Noeud('section', { enfants: [piege] })] });
  const depliees = dansLaPage(page, coyote.DEPLIER_SECTIONS, {
    motifSection: coyote.MOTIF_SECTION.source,
    motifReglement: coyote.MOTIF_REGLEMENT.source,
  });
  assert.equal(depliees, 0);
  assert.equal(piege.clics, 0, 'mieux vaut une section repliée qu\'un règlement');
});

// ---------------------------------------------------------------------------
// 3. Les manifestes — le statut, le site, la preuve
// ---------------------------------------------------------------------------

function manifeste(id) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'server', 'connectors', 'available', id, 'manifest.json'), 'utf8'
  ));
}

test('les deux manifestes : pending (jamais exercés), session par la fenêtre, preuve mesurée', () => {
  const a = manifeste('autodoc');
  assert.equal(a.initialStatus, 'pending');
  assert.equal(a.site, 'www.auto-doc.fr', 'le domaine mort autodoc.fr est corrigé');
  assert.equal(a.remoteLogin.verifyUrl, 'https://www.auto-doc.fr/profile/orders');
  assert.equal(a.remoteLogin.verifyUrlTient, true);
  assert.equal(a.remoteLogin.renvoiAnonyme, undefined,
    'le renvoi mesuré vise l\'accueil, pas un formulaire : « connexion » serait faux');
  assert.equal(a.remoteLogin.persistent, true);

  const c = manifeste('coyote');
  assert.equal(c.initialStatus, 'pending');
  assert.equal(c.remoteLogin.verifyUrl, 'https://www.moncoyote.com/fr/users/account/my-invoices');
  assert.equal(c.remoteLogin.verifyUrlTient, true);
  assert.equal(c.remoteLogin.renvoiAnonyme, 'connexion', 'mesuré : renvoi vers /fr/users/auth');
  assert.equal(c.remoteLogin.persistent, true);
});

test('les annonces planned/ ont disparu — un service ne vit qu\'à un seul endroit', () => {
  for (const id of ['autodoc', 'coyote']) {
    assert.equal(
      fs.existsSync(path.resolve(__dirname, '..', 'server', 'connectors', 'planned', id)),
      false,
      `planned/${id} devrait avoir disparu`
    );
  }
});
