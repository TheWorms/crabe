'use strict';

/**
 * Lot 105 — Battle.net réparé d'après l'essai réel du 12/10/2026 : les liens
 * de la page 2 portent une requête (R1) ; le détail est lu avant d'être
 * dessiné (R2).
 *
 * Au VRAI Chromium, sur des pages RECONSTITUÉES (test/lot104-faux-sites.js) :
 * treize achats sur deux pages (dix, puis trois — la forme du compte réel),
 * liens de la page 2 porteurs d'une requête INVENTÉE (sa vraie forme n'est
 * pas mesurée), cartes de détail d'abord PROVISOIRES (titre déjà là, corps en
 * attente, voile levé) puis réelles, et la valeur du statut portant la même
 * classe que celle du numéro. Ils prouvent la lecture de cette forme, pas le
 * vrai site.
 *
 * ⚠ Valeurs inventées : commandes « ZZ9… », factures « 99… », montants à
 * 0,00 €, requête `?page=2&region=zz`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bnet = require('../server/connectors/available/battle-net/connector');
const faux = require('./lot104-faux-sites');
const outils = require('./lot104-outils');

const ID = 'battle-net';
const REQUETE = '?page=2&region=zz';

/** Treize achats inventés : dix sur la page 1, trois sur la page 2. */
function compteTreize(extra = {}) {
  const base = faux.compteBnet();
  const achats = [...base.achats, {
    commande: 'ZZ900000013', facture: '9900000013', date: '2 mars 2025', gratuit: false,
  }];
  return faux.compteBnet({
    achats,
    requetePage2: REQUETE,
    detailProvisoireMs: 600,
    ordreDetail: 'statut-avant',
    ...extra,
  });
}

const ANCRES = compteTreize().achats.map((a) => `${ID}-facture-${a.facture}`);

const passer = (etat, options) => outils.passer(ID, bnet, etat, options);

/** Seul « Suivant » est cliqué ; rien d'interdit. */
function seulementSuivant(journal, etat) {
  outils.rienDInterdit(journal, etat);
  for (const g of journal.gestes) assert.equal(g.texte, 'Suivant', `un geste hors de « Suivant » : ${JSON.stringify(g)}`);
  assert.deepEqual(journal.choix, []);
}

// ---------------------------------------------------------------------------
// R1 — le lien à requête
// ---------------------------------------------------------------------------

test('R1 — un lien `/transactions/<commande>/<facture>` porteur d\'une requête est accepté ; crabe suit le CHEMIN SEUL ; les noms des paramètres, jamais leurs valeurs', () => {
  const lu = bnet.adresseDuDetail(`/transactions/ZZ900000011/9900000011${REQUETE}`);
  assert.deepEqual(lu, {
    adresse: 'https://account.battle.net/transactions/ZZ900000011/9900000011',
    commande: 'ZZ900000011',
    facture: '9900000011',
    parametres: ['page', 'region'],
  });
  assert.doesNotMatch(lu.adresse, /[?#]/, 'l\'adresse suivie n\'a pas de requête');
  // Un nom de paramètre qui ressemble à une valeur ne se dit pas.
  assert.deepEqual(bnet.adresseDuDetail('/transactions/ZZ900000011/9900000011?ZZ9000=1&a%20b=2&tri=asc').parametres, ['tri', '…']);
  // Le chemin d'une autre forme reste écarté, requête ou non.
  for (const refus of [`/transactions/ZZ900000011${REQUETE}`, `/transactions/ZZ900000011/9900000011/cadeau${REQUETE}`,
    `/transactions/ZZ900000011/9900000011${REQUETE}#haut`, `/transactions/ZZ900000011/abc${REQUETE}`,
    `https://shop.battle.net/transactions/ZZ900000011/9900000011${REQUETE}`]) {
    assert.ok(bnet.adresseDuDetail(refus).refus, `écartée : ${refus}`);
  }
  // Les mots refusés se cherchent dans ce qui serait suivi : un chemin refusé l'est toujours.
  assert.match(bnet.adresseDuDetail(`/transactions/ZZ900000011/logout${REQUETE}`).refus, /mot refusé « logout »/);
});

test('R1 — `achatsDeLaPage` : les achats à requête comptés, les noms des paramètres réunis, une ligne d\'autre forme écartée et dite', () => {
  const lu = bnet.achatsDeLaPage([
    { date: '1 mars 2025', liens: [`/transactions/ZZ900000011/9900000011${REQUETE}`], texteLien: 'ZZ900000011' },
    { date: '2 mars 2025', liens: ['/transactions/ZZ900000012/9900000012?page=2'], texteLien: 'ZZ900000012' },
    { date: '3 mars 2025', liens: ['/transactions/ZZ900000014?page=2'], texteLien: 'ZZ900000014' },
  ]);
  assert.deepEqual(lu.achats.map((a) => a.adresse), ['https://account.battle.net/transactions/ZZ900000011/9900000011',
    'https://account.battle.net/transactions/ZZ900000012/9900000012']);
  assert.deepEqual(lu.achats.map((a) => a.requete), [true, true]);
  assert.deepEqual(lu.parametres, ['page', 'region']);
  assert.deepEqual(lu.ecartees, [{ rang: 2, raison: 'adresse porteuse d\'une requête, d\'une autre forme que commande et facture' }]);
});

// ---------------------------------------------------------------------------
// R2 — le détail : dessiné d'abord, lu à côté du libellé, comparé sans espaces
// ---------------------------------------------------------------------------

test('R2 — `jugerDetail` : on attend tant que la carte est provisoire, sans libellé ou sans valeur ; espaces et espaces insécables retirés ; un écart sur carte dessinée est `ecart`, une autre commande `autre`', () => {
  const achat = { commande: 'ZZ900000001', facture: '9900000001' };
  const vue = (x) => ({
    url: 'https://account.battle.net/transactions/ZZ900000001/9900000001', h1: 'Détails de la commande', motDePasse: false,
    chargement: false, cartes: 1, titreCarte: ' Commande #ZZ900000001 ', libelle: true, valeur: '9900000001', provisoire: false, ...x,
  });
  assert.equal(bnet.jugerDetail(vue({ provisoire: true }), achat).verdict, 'attente', 'carte provisoire');
  assert.equal(bnet.jugerDetail(vue({ provisoire: true, valeur: '' }), achat).verdict, 'attente');
  assert.equal(bnet.jugerDetail(vue({ libelle: false, valeur: '' }), achat).verdict, 'attente', 'libellé absent');
  assert.equal(bnet.jugerDetail(vue({ valeur: '   ' }), achat).verdict, 'attente', 'valeur vide');
  assert.equal(bnet.jugerDetail(vue({ titreCarte: '' }), achat).verdict, 'attente', 'titre absent');
  assert.equal(bnet.jugerDetail(vue({}), achat).verdict, 'detail');
  assert.equal(bnet.jugerDetail(vue({ valeur: ' 99 0000 0001 ' }), achat).verdict, 'detail', 'espaces et insécable retirés');
  assert.equal(bnet.jugerDetail(vue({ valeur: '9900 000001' }), achat).verdict, 'detail', 'espace fine insécable retirée');
  assert.equal(bnet.jugerDetail(vue({ valeur: 'Terminé' }), achat).verdict, 'ecart', 'la valeur du statut lue à la place : un écart, pas une conclusion');
  assert.equal(bnet.jugerDetail(vue({ valeur: '9800000001' }), achat).verdict, 'ecart');
  assert.equal(bnet.jugerDetail(vue({ titreCarte: 'Commande #ZZ900000002' }), achat).verdict, 'autre', 'une autre commande conclut tout de suite');
  assert.equal(bnet.jugerDetail(vue({ url: 'https://account.battle.net/login/fr/' }), achat).verdict, 'connexion');
});

test('R2 — la forme de ce qui a été lu : longueur, chiffres, libellé, carte provisoire — jamais la valeur', () => {
  assert.equal(bnet.formeDuNumero({ libelle: true, valeur: ' 9800000001 ', provisoire: false }),
    'libellé « Numéro de facture » trouvé, valeur lue : 10 caractère(s), chiffres seulement, carte provisoire partie');
  assert.equal(bnet.formeDuNumero({ libelle: true, valeur: 'Terminé', provisoire: false }),
    'libellé « Numéro de facture » trouvé, valeur lue : 7 caractère(s), pas seulement des chiffres, carte provisoire partie');
  assert.equal(bnet.formeDuNumero({ libelle: false, valeur: '', provisoire: true }),
    'libellé « Numéro de facture » absent, valeur lue : 0 caractère(s), carte provisoire encore là');
  assert.equal(bnet.formeDuNumero(null), 'libellé « Numéro de facture » absent, valeur lue : 0 caractère(s), carte provisoire partie');
  assert.doesNotMatch(bnet.formeDuNumero({ libelle: true, valeur: '9800000001' }), /98/);
  assert.equal(bnet.DELAI_DETAIL_MS, 45_000, 'la borne : celle d\'une navigation');
  assert.equal(bnet.STABLE_ECART_MS, 2_000);
});

test('R2 — le fichier se LIT : le numéro à côté de son libellé, jamais par la classe partagée ; aucun nouveau geste', () => {
  const code = outils.codeSansCommentaires(require.resolve('../server/connectors/available/battle-net/connector'));
  assert.doesNotMatch(code, /blz-text-capitalize-first/, 'la classe partagée n\'est jamais lue');
  const { corps } = outils.corpsDe(code, 'const LIRE_LE_DETAIL = () => {');
  assert.match(corps, /n\(d\.textContent\) === 'Numéro de facture'/);
  assert.match(corps, /etiquette \? etiquette\.nextElementSibling : null/);
  assert.equal((code.match(/\.click\s*\(/g) || []).length, 1, 'toujours un seul clic : « Suivant »');
  assert.deepEqual(Object.keys(bnet.GESTES), ['suivant']);
  assert.equal((code.match(/\.goto\s*\(/g) || []).length, 1, 'toujours une seule navigation');
});

// ---------------------------------------------------------------------------
// D1 — treize achats, deux pages, cartes provisoires, classe partagée
// ---------------------------------------------------------------------------

test('D1 — page 1 normale, page 2 à liens avec requête, cartes provisoires puis réelles, classe partagée : TREIZE PDF ; chaque détail suivi sans sa requête', faux.SANS_NAVIGATEUR, async () => {
  const etat = compteTreize();
  const { resultat, erreur, journal, lignes, ouverts } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementSuivant(journal, etat);
  assert.equal(journal.gestes.length, 1, 'un seul clic « Suivant »');
  assert.deepEqual(resultat.invoices.map((f) => f.remoteId), ANCRES, 'treize documents, l\'ancre de chacun');
  for (const f of resultat.invoices) {
    assert.equal(f.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(f.buffer.length > 1000);
  }
  assert.deepEqual(etat.compteurs.details, compteTreize().achats.map((a) => a.facture), 'chaque détail ouvert une fois');
  assert.deepEqual(etat.compteurs.requetesDetail, Array(13).fill(''), 'aucune requête n\'est suivie : le chemin seul');
  assert.equal(resultat.couverture.complete, true);
  assert.equal(resultat.precision, '— Battle.net : 13 achats lus sur 2 pages de l\'historique. Battle.net ne fournit pas de facture : '
    + 'crabe enregistre en PDF la page de détail de chaque achat.');
  const texte = lignes.join('\n');
  const dites = lignes.filter((l) => /porteur\(s\) d'une requête/.test(l));
  assert.deepEqual(dites, ['battle-net : page 2 — 3 lien(s) de détail porteur(s) d\'une requête, paramètre(s) : page, region ; '
    + 'la requête est retirée, seul le chemin est suivi.'], 'une fois par page, les NOMS');
  assert.doesNotMatch(texte, /region=|page=|=zz|\bzz\b/, 'jamais une valeur de paramètre');
  assert.doesNotMatch(texte, /ligne \d+ écartée/, 'aucune ligne écartée');
  assert.equal(ouverts, 0);
  outils.journalSansDonnee(lignes);
});

test('D1 — la structure mesurée (numéro avant statut) : treize PDF aussi', faux.SANS_NAVIGATEUR, async () => {
  const etat = compteTreize({ ordreDetail: 'mesure' });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementSuivant(journal, etat);
  assert.equal(resultat.invoices.length, 13);
});

test('D1 — une ligne d\'une autre forme sur la page 2 (commande seule, ou un chemin de plus) : écartée et dite ; les treize achats sont pris', faux.SANS_NAVIGATEUR, async () => {
  const etat = compteTreize({
    autresLiensPage2: [
      { href: `/transactions/ZZ900000014${REQUETE}`, texte: 'ZZ900000014' },
      { href: `/transactions/ZZ900000015/9900000015/cadeau${REQUETE}`, texte: 'ZZ900000015' },
    ],
  });
  const { resultat, erreur, journal, lignes } = await passer(etat);
  assert.equal(erreur, null, `${erreur?.message}\n${lignes.join('\n')}`);
  seulementSuivant(journal, etat);
  assert.equal(resultat.invoices.length, 13);
  assert.deepEqual(lignes.filter((l) => /ligne \d+ écartée/.test(l)), [
    'battle-net : page 2, ligne 4 écartée — adresse porteuse d\'une requête, d\'une autre forme que commande et facture.',
    'battle-net : page 2, ligne 5 écartée — adresse porteuse d\'une requête, d\'une autre forme que commande et facture.',
  ]);
  assert.match(resultat.precision, /2 lignes ont été écartées : leur lien de détail ne se lisait pas de façon sûre\./);
  assert.equal(etat.compteurs.details.length, 13, 'aucune ligne écartée n\'est ouverte');
  outils.journalSansDonnee(lignes);
});

test('D1 — un vrai écart sur une carte DESSINÉE : pas de PDF, et le journal dit la forme lue, jamais la valeur', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ factureDecalee: true, detailProvisoireMs: 300, achats: faux.compteBnet().achats.slice(0, 2) });
  const { resultat, erreur, lignes } = await passer(etat);
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 0);
  const refus = lignes.filter((l) => /pas enregistré/.test(l));
  assert.deepEqual(refus, [1, 2].map((n) => `battle-net : achat ${n} sur 2 — pas enregistré : le numéro de facture affiché n'est pas `
    + 'celui de l\'adresse (libellé « Numéro de facture » trouvé, valeur lue : 10 caractère(s), chiffres seulement, carte provisoire partie).'));
  assert.match(resultat.precision, /2 pages de détail ne ressemblaient pas à celle de leur achat/);
  outils.journalSansDonnee(lignes);
});

test('D1 — une carte qui reste provisoire : la borne tombe, le journal dit où elle en était', faux.SANS_NAVIGATEUR, async () => {
  const etat = faux.compteBnet({ toujoursProvisoire: true, achats: faux.compteBnet().achats.slice(0, 1) });
  const { resultat, erreur, lignes } = await passer(etat, { ouverture: { delaiDetailMs: 2_500 } });
  assert.equal(erreur, null, erreur?.message);
  assert.equal(resultat.invoices.length, 0);
  assert.deepEqual(lignes.filter((l) => /pas enregistré/.test(l)), ['battle-net : achat 1 sur 1 — pas enregistré : la carte est encore '
    + 'provisoire après 3 s (libellé « Numéro de facture » trouvé, valeur lue : 0 caractère(s), carte provisoire encore là).']);
  outils.journalSansDonnee(lignes);
});
