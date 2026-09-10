'use strict';

/**
 * Les deux conventions de nommage des documents déposés (lot 56).
 *
 * ─── D'où vient ce module ────────────────────────────────────────────────────
 *
 * Le lot 55 a mesuré la dette : les connecteurs n'ont jamais nommé leurs
 * fichiers pareil, et une large part des documents déposés en production
 * portait une forme d'avant la convention moderne. Il a écrit une dérivation pure — (connecteur,
 * nom actuel) → verdict — qui vivait dans `scripts/`, à l'usage d'un script
 * manuel. Le lot 56 tranche autrement : le nom des fichiers est un RÉGLAGE de
 * l'application, par compte, et l'harmonisation se lance depuis l'écran. La
 * dérivation monte donc ici, étendue aux deux conventions, et devient la seule
 * source de vérité : le dépôt d'un document neuf et le renommage d'un document
 * existant appliquent exactement les mêmes règles — deux chemins qui
 * divergeraient produiraient des dossiers mélangés sans que personne n'ait
 * rien demandé.
 *
 * ─── Les deux conventions ────────────────────────────────────────────────────
 *
 *   - `avec-service` : `<service>_<période>_<référence>.pdf` — la forme que
 *     `documents-de-page.nomFichier()` produit depuis le 12/08/2026. Le nom se
 *     suffit à lui-même hors de son dossier.
 *   - `sans-service` : `<période>_<référence>.pdf` — le service n'est plus
 *     répété, puisque le dossier le porte déjà
 *     (`…/<Service>/<compte>/<année>/`). Nom plus court ; un fichier sorti de
 *     son dossier ne dit plus d'où il vient.
 *
 * ─── Ce qui ne change JAMAIS, quelle que soit la convention ──────────────────
 *
 *   - eDocPerso : le coffre nomme ses documents, le chemin de dépôt porte déjà
 *     le connecteur (choix documenté dans le connecteur) ;
 *   - un nom SANS période connue garde son service (`spotify_0d7e0b67.pdf`) :
 *     retirer le service d'un nom réduit à une référence opaque laisserait un
 *     fichier qui ne dit plus rien du tout, même dans son dossier trié ;
 *   - la référence n'est jamais reconstruite : le nom cible se dérive du nom
 *     ACTUEL — on ajoute ou retire le service, on recolle une période
 *     compacte, rien d'autre. Jamais de dérivation depuis `remote_id` : c'est
 *     la clé de déduplication face au portail, sa forme n'a pas à ressembler
 *     au nom du fichier.
 *
 * Ce module est PUR : aucune lecture de base, aucun accès disque — c'est ce
 * qui le rend prouvable par les tests, et ce qui rend tout plan de renommage
 * reproductible : deux exécutions sur les mêmes lignes rendent le même plan.
 */

/** Le même nettoyage que `documents-de-page.nomFichier()` applique au service. */
function propre(valeur) {
  return String(valeur ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Le catalogue des conventions, tel que l'écran « Fichiers » le présente.
 *
 * Les exemples sont INVENTÉS, à la forme du réel sans en être : l'écran doit
 * faire comprendre le choix sans documentation, pas montrer un vrai document.
 */
const CONVENTIONS = [
  {
    id: 'avec-service',
    titre: 'Avec le nom du service',
    exemple: 'operateur-exemple_2026-05_100042.pdf',
    description:
      'Chaque fichier commence par le nom du service, puis la période, puis la '
      + 'référence du document. Un fichier copié hors de son dossier reste '
      + 'reconnaissable tout seul.',
  },
  {
    id: 'sans-service',
    titre: 'Sans le nom du service',
    exemple: '2026-05_100042.pdf',
    description:
      'La période puis la référence, sans répéter le service : le dossier qui '
      + 'contient le fichier porte déjà son nom. Les noms sont plus courts, mais '
      + 'un fichier sorti de son dossier ne dit plus de quel service il vient.',
  },
];

const CONVENTION_IDS = CONVENTIONS.map((c) => c.id);

/** La convention en vigueur avant que ce réglage existe : celle du code. */
const CONVENTION_PAR_DEFAUT = 'avec-service';

/** Connecteurs dont le nommage est un choix documenté, jamais une dette. */
const EXCLUS = new Set(['edocperso']);

/** Connecteurs à relevés reconstitués : la paire de bornes est la période. */
const RELEVES = new Set(['paypal', 'bitstamp']);

/** Documents de voyage : la nature du document fait partie du nom. */
const NATURES_VOYAGE = new Set(['billet', 'justificatif-voyage']);

/** La paire de bornes d'un relevé reconstitué : `<du>_<au>` en dates ISO. */
const BORNES = '\\d{4}-\\d{2}-\\d{2}_\\d{4}-\\d{2}-\\d{2}';

/**
 * Le verdict pour une ligne : que devient ce nom, sous cette convention ?
 *
 * @param {string} connectorId identifiant du connecteur (colonne `connector_id`)
 * @param {string} filename    nom actuel (colonne `filename`)
 * @param {string} [convention] `avec-service` (défaut) ou `sans-service`
 * @returns {{action: 'exclu'|'conforme'|'renommer'|'douteux', motif: string,
 *            cible?: string}}
 *   `cible` n'existe que pour `renommer`. `douteux` ne PROPOSE rien : un cas
 *   qui ne se laisse pas dériver se liste, et l'utilisateur tranche — jamais
 *   une supposition.
 */
function deriverNomCible(connectorId, filename, convention = CONVENTION_PAR_DEFAUT) {
  const service = propre(connectorId);
  const nom = String(filename ?? '');
  const sansService = convention === 'sans-service';

  if (EXCLUS.has(connectorId)) {
    return { action: 'exclu', motif: 'eDocPerso : le coffre nomme, choix documenté du connecteur' };
  }

  if (RELEVES.has(connectorId)) {
    const avecPrefixe = new RegExp(`^${service}_releve-reconstitue_${BORNES}\\.pdf$`).test(nom);
    const sansPrefixe = new RegExp(`^releve-reconstitue_${BORNES}\\.pdf$`).test(nom);
    if (sansService ? sansPrefixe : avecPrefixe) {
      return { action: 'conforme', motif: 'relevé reconstitué : la paire de bornes est la période' };
    }
    if (sansService && avecPrefixe) {
      return {
        action: 'renommer',
        motif: 'relevé reconstitué : le service se retire, le dossier le porte',
        cible: nom.slice(service.length + 1),
      };
    }
    if (!sansService && sansPrefixe) {
      return {
        action: 'renommer',
        motif: 'relevé reconstitué : le service s\'ajoute',
        cible: `${service}_${nom}`,
      };
    }
    return { action: 'douteux', motif: 'relevé attendu, forme inconnue' };
  }

  // Documents de voyage : la nature (`billet_…`, `justificatif-voyage_…`) fait
  // partie du nom ; seule la présence du service suit la convention.
  const voyageAvec = new RegExp(`^${service}_([a-z-]+)_`).exec(nom);
  if (voyageAvec && NATURES_VOYAGE.has(voyageAvec[1])) {
    if (!sansService) {
      return { action: 'conforme', motif: `document de voyage : la nature « ${voyageAvec[1]} » fait partie du nom` };
    }
    return {
      action: 'renommer',
      motif: `document de voyage : le service se retire, la nature « ${voyageAvec[1]} » reste`,
      cible: nom.slice(service.length + 1),
    };
  }
  const voyageSans = /^([a-z-]+)_/.exec(nom);
  if (voyageSans && NATURES_VOYAGE.has(voyageSans[1])) {
    if (sansService) {
      return { action: 'conforme', motif: `document de voyage : la nature « ${voyageSans[1]} » fait partie du nom` };
    }
    return {
      action: 'renommer',
      motif: `document de voyage : le service s'ajoute devant la nature « ${voyageSans[1]} »`,
      cible: `${service}_${nom}`,
    };
  }

  // Le service est là, une période le suit. Deux choses peuvent bouger : le
  // service répété dans la référence (« service_2025-09_service-… », noms
  // d'avant le dédoublonnage du 14/08/2026), et le service lui-même si la
  // convention ne le veut plus.
  const moderne = new RegExp(`^${service}_(\\d{4}(?:-\\d{2})?)_(.+)\\.pdf$`).exec(nom);
  if (moderne) {
    let reference = moderne[2];
    let repete = false;
    if (reference.startsWith(`${service}-`) && reference.length > service.length + 1) {
      reference = reference.slice(service.length + 1);
      repete = true;
    }
    if (sansService) {
      return {
        action: 'renommer',
        motif: repete
          ? 'le service se retire du nom et de la référence, le dossier le porte'
          : 'le service se retire, le dossier le porte',
        cible: `${moderne[1]}_${reference}.pdf`,
      };
    }
    if (repete) {
      return {
        action: 'renommer',
        motif: 'service répété dans la référence (préfixe doublé)',
        cible: `${service}_${moderne[1]}_${reference}.pdf`,
      };
    }
    return { action: 'conforme', motif: 'déjà à la forme moderne' };
  }

  // Service présent SANS période : la période est inconnue depuis le dépôt
  // (« spotify_0d7e0b67.pdf »). On ne fabrique pas une date que personne n'a
  // mesurée — et on garde le service DANS LES DEUX CONVENTIONS : le retirer
  // laisserait une référence opaque seule, un nom qui ne dit plus rien.
  if (new RegExp(`^${service}_[^_]+\\.pdf$`).test(nom)) {
    return {
      action: 'conforme',
      motif: sansService
        ? 'sans période connue, le service reste : une référence seule ne dirait plus rien'
        : 'forme moderne sans période (période inconnue au dépôt)',
    };
  }

  // Période en tête, service absent.
  //   `2026-08_1494758523.pdf`, `2026_Avis_d_impot….pdf`, `202507_ref.pdf`
  const periodeEnTete = /^((?:19|20)\d{2})(?:-(\d{2}))?_(.+)\.pdf$/.exec(nom);
  if (periodeEnTete) {
    const periode = periodeEnTete[2] ? `${periodeEnTete[1]}-${periodeEnTete[2]}` : periodeEnTete[1];
    if (sansService) {
      return { action: 'conforme', motif: 'période en tête, sans le service : la forme voulue' };
    }
    return {
      action: 'renommer',
      motif: 'période en tête sans le service',
      cible: `${service}_${periode}_${periodeEnTete[3]}.pdf`,
    };
  }
  const periodeCompacte = /^((?:19|20)\d{2})(\d{2})_(.+)\.pdf$/.exec(nom);
  if (periodeCompacte) {
    const periode = `${periodeCompacte[1]}-${periodeCompacte[2]}`;
    return {
      action: 'renommer',
      motif: 'période compacte en tête : recollée en AAAA-MM',
      cible: sansService
        ? `${periode}_${periodeCompacte[3]}.pdf`
        : `${service}_${periode}_${periodeCompacte[3]}.pdf`,
    };
  }

  return { action: 'douteux', motif: 'aucune règle ne reconnaît cette forme' };
}

/**
 * Le nom sous lequel un document se DÉPOSE, selon la convention du compte.
 *
 * C'est le point de passage commun de tous les connecteurs (appelé par le
 * socle, `scheduler.js`, seul endroit qui voit à la fois le nom produit et le
 * compte) : ceux qui fabriquent encore leur nom à l'ancienne — période en
 * tête sans le service, période compacte — sont ramenés à la convention du
 * compte ICI, à chaque dépôt. La dette du lot 55 ne peut donc plus se
 * recréer, quel que soit le connecteur, y compris ceux qui restent à écrire.
 *
 * Un nom qu'aucune règle ne reconnaît (`douteux`) est déposé TEL QUEL : on ne
 * renomme jamais sur une supposition, un dépôt encore moins.
 *
 * @param {string} connectorId
 * @param {string} filename le nom produit par le connecteur
 * @param {string} [convention]
 * @returns {string}
 */
function nomDeDepot(connectorId, filename, convention = CONVENTION_PAR_DEFAUT) {
  const verdict = deriverNomCible(connectorId, filename, convention);
  return verdict.action === 'renommer' ? verdict.cible : String(filename ?? '');
}

module.exports = {
  CONVENTIONS,
  CONVENTION_IDS,
  CONVENTION_PAR_DEFAUT,
  deriverNomCible,
  nomDeDepot,
  propre,
};
