'use strict';

/**
 * Connecteur PrestaShop Addons — les fonctions pures.
 *
 * Ce que ces tests protègent avant tout : `pdfNormalise()`. Le service de
 * facturation d'Addons sert les factures avec un BOM UTF-8 devant l'en-tête
 * %PDF- (mesuré le 12/08/2026, commande 1709434). Un contrôle strict des cinq
 * premiers octets prenait ce PDF valide pour du HTML, concluait « session
 * expirée » à tort et stoppait toute la récupération à la PREMIÈRE facture —
 * alors que la session, elle, était parfaitement vivante (l'historique
 * venait de se charger). La tolérance est chirurgicale : le BOM, rien
 * d'autre — un HTML de connexion doit toujours être rejeté, c'est lui le
 * vrai signal d'une session tombée.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');

const addons = require('../server/connectors/available/addons-prestashop/connector');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('pdfNormalise accepte un PDF nu et le rend tel quel', () => {
  const brut = Buffer.from('%PDF-1.7\ncontenu', 'latin1');
  const pdf = addons.pdfNormalise(brut);
  assert.ok(pdf);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(pdf.length, brut.length);
});

test('pdfNormalise retire le BOM UTF-8 du service de facturation', () => {
  const brut = Buffer.concat([BOM, Buffer.from('%PDF-1.7\ncontenu', 'latin1')]);
  const pdf = addons.pdfNormalise(brut);
  assert.ok(pdf, 'le PDF de la commande 1709434 doit passer, BOM compris');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'l\'en-tête doit être en tête');
  assert.equal(pdf.length, brut.length - BOM.length);
});

test('pdfNormalise rejette le HTML — le vrai signal de session tombée', () => {
  assert.equal(addons.pdfNormalise(Buffer.from('<!DOCTYPE html><html>…', 'latin1')), null);
  assert.equal(
    addons.pdfNormalise(Buffer.concat([BOM, Buffer.from('<!DOCTYPE html>', 'latin1')])),
    null,
    'un BOM devant du HTML reste du HTML'
  );
});

test('pdfNormalise rejette ce qui n\'est pas un tampon, sans lever', () => {
  assert.equal(addons.pdfNormalise(null), null);
  assert.equal(addons.pdfNormalise('%PDF-1.4'), null);
  assert.equal(addons.pdfNormalise(Buffer.alloc(0)), null);
});

test('dateDeLigne lit la date française du tableau, et l\'ISO en secours', () => {
  assert.equal(addons.dateDeLigne('Commande n°1709434 du 25/06/2025 — 59,99 €'), '2025-06-25');
  assert.equal(addons.dateDeLigne('order 1709434 on 2025-06-25'), '2025-06-25');
  assert.equal(addons.dateDeLigne('rien à lire ici'), null);
});

test('nomFichier préfixe l\'année quand la date est connue', () => {
  assert.equal(addons.nomFichier('1709434', '2025-06-25'), '2025_commande_1709434.pdf');
  assert.equal(addons.nomFichier('1709434', null), 'commande_1709434.pdf');
  assert.equal(addons.nomFichier('17/09?4', '2025-06-25'), '2025_commande_17_09_4.pdf');
});

test('pagesDepuisLibelles dédoublonne et trie les pages de la pagination puik', () => {
  assert.deepEqual(
    addons.pagesDepuisLibelles(['Go to page 2', 'Go to page 1', 'Go to page 2', 'Suivant']),
    [1, 2]
  );
  assert.deepEqual(addons.pagesDepuisLibelles([]), []);
});

test('estPageAuthentification reconnaît authv2 et /login, pas l\'historique', () => {
  assert.equal(addons.estPageAuthentification('https://authv2.prestashop.com/fr/?truc'), true);
  assert.equal(addons.estPageAuthentification('https://addons.prestashop.com/fr/login?back=x'), true);
  assert.equal(
    addons.estPageAuthentification('https://addons.prestashop.com/fr/historique-des-commandes'),
    false
  );
});
