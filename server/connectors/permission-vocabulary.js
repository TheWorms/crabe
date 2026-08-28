'use strict';

/**
 * Vocabulaire commun des permissions de connecteurs.
 *
 * Avant le lot 4, chaque connecteur déclarait les deux mêmes libellés
 * génériques — « Factures », « Identifiants du connecteur » — identiques pour
 * les treize. L'utilisateur ne savait donc pas à quoi il consentait.
 *
 * Ce module fixe un vocabulaire fermé : six données possibles, chacune avec
 * son icône, son libellé et une description PAR DÉFAUT. Cette description par
 * défaut n'est qu'un filet de sécurité d'affichage — un manifeste doit en
 * fournir une **spécifique**, et la validation le refuse sinon (voir
 * manifest-schema.js et la section « Permissions » du README).
 *
 * Les icônes sont des tracés SVG (attribut `d` / éléments), pas des fichiers :
 * le front les injecte dans un `<svg viewBox="0 0 24 24">` commun, sans
 * requête supplémentaire ni dépendance à une police d'icônes.
 */

/** Portées possibles. Rien d'autre n'est accepté par la validation. */
const SCOPES = {
  read: 'Lecture seule',
  'read-write': 'Lecture et écriture',
};

/**
 * @typedef {{key: string, name: string, icon: string, defaultDescription: string}} Permission
 * @type {Record<string, Permission>}
 */
const VOCABULARY = {
  factures: {
    key: 'factures',
    name: 'Factures',
    icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
    defaultDescription:
      'Les documents de facturation récupérés chez ce fournisseur, puis déposés sur vos destinations de stockage.',
  },
  identifiants: {
    key: 'identifiants',
    name: 'Identifiants du connecteur',
    icon: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
    defaultDescription:
      'Les identifiants de connexion que vous avez saisis, chiffrés au repos et utilisés uniquement pour ouvrir une session chez le fournisseur.',
  },
  fichiers: {
    key: 'fichiers',
    name: 'Fichiers',
    icon: '<path d="M3 7a2 2 0 012-2h4l2 3h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    defaultDescription:
      'Les fichiers écrits sur vos destinations de stockage : arborescence, noms de fichiers et contenus.',
  },
  'informations-compte': {
    key: 'informations-compte',
    name: 'Informations de compte',
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1"/>',
    defaultDescription:
      'Les informations qui identifient votre abonnement chez le fournisseur : numéro de client, référence de contrat.',
  },
  'operations-bancaires': {
    key: 'operations-bancaires',
    name: 'Opérations bancaires',
    icon: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M6 15h4"/>',
    defaultDescription:
      'Les montants, dates et libellés des paiements liés à cet abonnement, tels que '
      + 'le fournisseur les publie.',
  },
  'documents-contractuels': {
    key: 'documents-contractuels',
    name: 'Documents contractuels',
    icon: '<path d="M15 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V7z"/><path d="M15 3v4h4"/><path d="M9 15l2 2 4-4"/>',
    defaultDescription:
      'Les pièces contractuelles mises à disposition par le fournisseur : contrat, conditions, avenants, attestations.',
  },
};

const KEYS = Object.keys(VOCABULARY);
const SCOPE_IDS = Object.keys(SCOPES);

/**
 * Bandeau affiché en tête de la liste des permissions.
 *
 * Volontairement différent du texte de Twake (« vos données ne quittent pas
 * votre appareil ») : dans crabe, les factures SORTENT bel et bien vers les
 * destinations configurées par l'administrateur. Le dire est le minimum.
 */
const NOTICE =
  'Droit d\'accès limité — crabe se connecte au fournisseur avec vos seuls identifiants, '
  + 'stockés chiffrés sur cette installation. Aucune donnée n\'est envoyée à un service tiers : '
  + 'vos factures sont déposées uniquement sur les destinations de stockage configurées par '
  + 'l\'administrateur de cette instance.';

/** @param {string} key */
function has(key) {
  return Object.prototype.hasOwnProperty.call(VOCABULARY, key);
}

/**
 * Vue affichable d'une permission déclarée par un manifeste : le vocabulaire
 * commun fournit l'icône et le libellé, le manifeste la description concrète.
 *
 * @param {{key: string, scope: string, description?: string}} declared
 */
function describe(declared) {
  const base = VOCABULARY[declared.key];
  if (!base) return null;
  return {
    key: base.key,
    name: base.name,
    icon: base.icon,
    scope: declared.scope,
    scopeLabel: SCOPES[declared.scope] || declared.scope,
    description: (declared.description || '').trim() || base.defaultDescription,
    // Vrai quand le manifeste n'a rien dit de spécifique : ne devrait jamais
    // arriver, la validation le refuse. Affiché tel quel si ça arrivait quand
    // même, plutôt que de mentir sur la précision de l'information.
    generic: !(declared.description || '').trim(),
  };
}

/** Liste affichable des permissions d'un manifeste, dans l'ordre déclaré. */
function describeAll(permissions) {
  return (permissions || []).map(describe).filter(Boolean);
}

module.exports = { VOCABULARY, KEYS, SCOPES, SCOPE_IDS, NOTICE, has, describe, describeAll };
