'use strict';

/**
 * Les destinations de stockage, telles qu'elles se NOMMENT et s'affichent.
 *
 * ─── Ce qui a changé au lot 25 ───────────────────────────────────────────────
 *
 * Jusqu'au lot 24, ce fichier ÉTAIT la liste des destinations : six entrées en
 * dur, et livrer un fournisseur de plus demandait un lot de plus. Depuis le
 * lot 25, les destinations cloud sont des lignes de `destinations_config` que
 * l'utilisateur crée — ce fichier ne décide plus de ce qui existe, il dit
 * seulement comment CE QUI EXISTE s'affiche : le nom donné par l'utilisateur,
 * la couleur et la lettre de son fournisseur (voir `presets.js`).
 *
 * Il répond aussi pour les identifiants FANTÔMES : une facture copiée en 2026
 * vers un cloud supprimé depuis garde sa pastille — le nom du fournisseur si
 * l'identifiant est de l'ancien modèle (`proton`, `pcloud`…), un repli neutre
 * sinon. Une pastille qui disparaît ferait croire que la copie n'a jamais eu
 * lieu.
 *
 * ─── le stockage local n'a pas de site, et c'est structurel ───────────────────────────
 *
 * Le stockage local de crabe, c'est un chemin sur le disque ou un
 * montage réseau. Il n'y a personne à interroger, et aucune requête ne doit
 * partir pour son icône. Il porte donc une **icône interne**, livrée dans le
 * dépôt (`web/stockage-local.svg`), qui n'est ni récupérée ni récupérable — la
 * cascade de `connectors/logos.js` refuse d'elle-même un sujet sans site.
 */

const logos = require('../connectors/logos');
const presets = require('./presets');

/** L'icône interne du stockage local : un fichier du dépôt, jamais une requête. */
const ICONE_LOCAL = '/stockage-local.svg';

const LOCAL = {
  id: 'local',
  name: 'Stockage local',
  letter: 'S',
  color: '#5a6b52',
  site: '',
  icone: ICONE_LOCAL,
};

/**
 * Les lignes de `destinations_config`, mises en cache.
 *
 * `style()` est appelée dans des boucles — une pastille par destination et par
 * facture — et une requête SQL par pastille se paierait sur chaque écran. Le
 * cache est invalidé par `oublier()`, que `destinations/index.js` appelle
 * après toute écriture : crabe est un unique processus Node, personne d'autre
 * n'écrit cette table.
 */
let cacheInstances = null;

function instancesParId() {
  if (cacheInstances) return cacheInstances;
  // ⚠ Les lignes SUPPRIMÉES sont lues elles aussi. Supprimer un cloud efface
  // ses identifiants et le retire de tous les écrans, mais la pastille des
  // factures qui y sont parties doit continuer de porter son nom : une
  // pastille qui deviendrait « cloud-3f8a » le jour de la suppression ferait
  // douter d'une copie qui a bel et bien eu lieu. C'est `list()` qui écarte
  // les supprimées, pas cette lecture.
  const rows = require('../db/db')
    .get()
    .prepare('SELECT dest_id, display_name, provider, deleted_at FROM destinations_config')
    .all();
  cacheInstances = new Map(rows.map((r) => [r.dest_id, r]));
  return cacheInstances;
}

/** Vide le cache — après chaque écriture dans `destinations_config`. */
function oublier() {
  cacheInstances = null;
}

/** L'habillage d'un preset, ou du neutre « autre » à défaut. */
function habillage(providerId) {
  return presets.of(providerId) || presets.of('autre');
}

/**
 * Identité d'une destination : instance en base, identifiant hérité de
 * l'ancien modèle, ou repli neutre — dans cet ordre, et sans jamais lever.
 */
function style(destId) {
  const id = String(destId || '');
  if (id === 'local') return LOCAL;

  const instance = instancesParId().get(id);
  if (instance) {
    const habit = habillage(instance.provider);
    return {
      id,
      name: instance.display_name || habit.label,
      letter: habit.letter,
      color: habit.color,
      site: habit.site || '',
      icone: habit.icone || null,
      provider: habit.id,
    };
  }

  // Identifiant de l'ancien modèle sans ligne en base : une copie d'époque
  // vers une destination depuis retirée. Le fournisseur reste nommable.
  const herite = presets.HERITAGE[id] && presets.of(presets.HERITAGE[id]);
  if (herite) {
    return {
      id,
      name: herite.label,
      letter: herite.letter,
      color: herite.color,
      site: herite.site || '',
      icone: herite.icone || null,
      provider: herite.id,
    };
  }

  return {
    id: id || '?',
    name: id || 'destination',
    letter: (id || '?').slice(0, 1).toUpperCase(),
    color: '#63666e',
    site: '',
    icone: null,
    provider: null,
  };
}

/**
 * L'adresse du logo d'une destination, et sa nature.
 *
 * Un logo RÉCUPÉRÉ est une image du fournisseur, dessinée pour du blanc : elle
 * se pose sur un fond blanc. Une icône INTERNE est un tracé monochrome qui
 * prend la couleur de la destination : elle se pose à même la pastille. Les
 * deux ne s'affichent donc pas de la même façon, d'où le drapeau.
 *
 * @returns {{logo: string|null, logoInterne: boolean}}
 */
function logoOf(destId) {
  const enregistre = logos.publicUrl(logos.idDeDestination(destId));
  if (enregistre) return { logo: enregistre, logoInterne: false };
  const interne = style(destId).icone;
  return { logo: interne || null, logoInterne: !!interne };
}

/** Identité complète, prête à être envoyée à un écran. */
function brand(destId) {
  const base = style(destId);
  return {
    id: base.id,
    name: base.name,
    letter: base.letter,
    color: base.color,
    site: base.site,
    provider: base.provider ?? null,
    ...logoOf(destId),
  };
}

/**
 * Les destinations existantes, le stockage local en tête puis les clouds par nom.
 * C'est la liste que l'écran des logos parcourt : un cloud sans site
 * (« autre ») est refusé plus loin par la cascade, comme le stockage local.
 */
function list() {
  const clouds = [...instancesParId().values()]
    .filter((r) => r.dest_id !== 'local' && !r.deleted_at)
    .map((r) => brand(r.dest_id))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
  return [brand('local'), ...clouds];
}

module.exports = {
  ICONE_LOCAL,
  style,
  logoOf,
  brand,
  list,
  oublier,
};
