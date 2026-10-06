'use strict';

/**
 * Le dossier d'un compte sur les stockages, au NOM du compte (lot 98).
 *
 * ─── D'où ça vient ───────────────────────────────────────────────────────────
 *
 * Le dossier d'un compte est, depuis le lot 10, son identifiant chez le
 * fournisseur (`paths.relativeParts`) : « fbx… » chez Free, un numéro de ligne
 * chez Free Mobile — ce que l'utilisateur reconnaît. Chez Gandi, l'identifiant
 * d'une organisation est un UUID : le 06/10/2026, l'utilisateur a ouvert
 * `…/Gandi/` sur le stockage local et y a trouvé trois dossiers aux noms illisibles. Le lot 96 n'avait
 * changé que l'affichage de « Mes documents » ; il veut le NOM de
 * l'organisation, sur tous les stockages.
 *
 * ─── Qui est concerné ────────────────────────────────────────────────────────
 *
 * Un connecteur qui sait dire le nom de ses comptes, en exportant
 * `nomDuCompte(element)` : le nom d'un élément de sa découverte, ou '' s'il
 * n'en a pas. Gandi seul le fait (il connaît son propre « Organisation sans
 * nom »). Pour tous les autres, `pourLePassage` rend `null`, le planificateur
 * ne change rien, et leur chemin de dépôt reste le même à l'octet.
 *
 * L'identifiant reste ce qu'il est partout ailleurs : `invoices.account_id`,
 * l'ancre, la clé de « Mes documents ». Seul le dossier change.
 *
 * ─── La règle, dans l'ordre (`dossiersDesComptes`, la seule qui décide) ──────
 *
 *   1. **Le dossier déjà employé** : un compte dont les documents sont déjà
 *      rangés dans un dossier à son nom le garde, même si son nom a changé
 *      depuis chez le fournisseur. Changer de dossier à chaque changement de
 *      nom éparpillerait ses documents en deux endroits — et un document
 *      redéposé laisserait derrière lui son double dans l'ancien dossier, sans
 *      que personne le sache. Le changement se dit au journal ; ranger dans le
 *      nouveau nom reste un geste (le script du lot 98, relancé).
 *      Le dossier à son IDENTIFIANT n'est pas un choix : c'est l'ancienne
 *      règle, que le nom remplace — il ne retient jamais un compte.
 *   2. **Son nom**, rendu sûr pour tous les stockages (`nomDeDossier`).
 *      Deux comptes du même nom (à la casse près : un stockage peut ne pas la
 *      distinguer) prennent le suffixe de « Mes documents » (lot 96) :
 *      « Nom (…5678) », les quatre derniers caractères de l'identifiant.
 *   3. **Son identifiant**, comme avant : sans nom (vide, absent de la
 *      découverte, vidé par l'assainissement, ou qui contient l'identifiant
 *      lui-même — lot 97), ou quand le dossier que le nom donnerait est déjà
 *      celui d'un autre compte. La raison se dit au journal, sous sa forme.
 *
 * Un dossier n'appartient jamais qu'à un seul compte : aucun dépôt ne peut
 * mêler les documents de deux organisations.
 *
 * Pure, sauf `faitsDuConnecteur` et `pourLePassage`, qui lisent la base.
 */

const paths = require('./destinations/paths');
const accountIds = require('./connectors/account-id');

/**
 * La longueur d'un nom de dossier, en octets UTF-8, avant le suffixe d'un
 * homonyme. Large pour un nom d'organisation (le connecteur Gandi en lit 120
 * caractères au plus), et loin des 255 octets qu'un nom de fichier ne dépasse
 * sur aucun stockage, suffixe compris.
 */
const NOM_OCTETS_MAX = 100;

/** Caractères de contrôle C1 et séparateurs de ligne Unicode : jamais dans un nom. */
const CONTROLES_UNICODE = /[\u0080-\u009f\u2028\u2029]/g;

/** Une moitié de caractère (paire de substitution orpheline) : retirée. */
const SUBSTITUTION_ORPHELINE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Le nom d'un compte rendu sûr pour un dossier, sur tous les stockages :
 * forme Unicode composée (NFC) ; puis `paths.safeSegment`, la règle de
 * tous les segments de crabe — `/`, `\`, `:` et les signes qu'un partage
 * réseau refuse deviennent `_`, les caractères de contrôle des espaces,
 * espaces réduits et retirés aux bords, aucun point en tête, aucun point ni
 * espace final ; enfin borné à `NOM_OCTETS_MAX` octets, coupé entre deux
 * caractères, et renettoyé (une coupe peut retomber sur un point ou une
 * espace). Les accents restent. Rend '' quand il ne reste rien. Pure.
 *
 * @param {string} nom
 * @returns {string}
 */
function nomDeDossier(nom) {
  const brut = String(nom ?? '')
    .replace(SUBSTITUTION_ORPHELINE, '')
    .normalize('NFC')
    .replace(CONTROLES_UNICODE, ' ');
  let propre = paths.safeSegment(brut, '');
  if (Buffer.byteLength(propre) > NOM_OCTETS_MAX) {
    let coupe = '';
    for (const caractere of propre) {
      if (Buffer.byteLength(coupe + caractere) > NOM_OCTETS_MAX) break;
      coupe += caractere;
    }
    propre = paths.safeSegment(coupe, '');
  }
  return propre;
}

/** La clé de comparaison de deux dossiers : un stockage peut ignorer la casse. */
function cleDeDossier(dossier) {
  return String(dossier ?? '').normalize('NFC').toLowerCase();
}

/** Le dossier à l'identifiant : ce que `paths.relativeParts` en fait depuis toujours. */
function dossierIdentifiant(cle) {
  return paths.safeSegment(cle, accountIds.DEFAULT_ACCOUNT_ID);
}

/**
 * La fin d'identifiant qui distingue des homonymes : celle de « Mes
 * documents » (lot 96, `documents.finsDistinctives`) — quatre caractères,
 * pris seulement si chaque identifiant en compte au moins huit et s'ils
 * distinguent tout le groupe. `null` sinon.
 */
function finsDistinctives(identifiants) {
  return require('./documents').finsDistinctives(identifiants);
}

/**
 * Les dossiers des comptes d'un connecteur qui nomme ses comptes — LA fonction
 * qui en décide (voir l'en-tête). Pure.
 *
 * @param {{comptes?: Array<{cle: string, nom?: string}>,
 *          employes?: Map<string, Map<string, number>>}} faits
 *   `comptes` : les comptes connus (découverte, puis ceux de la base), le nom
 *   brut ('' sans nom) ; `employes` : pour chaque compte, les dossiers où ses
 *   documents sont rangés aujourd'hui, avec leur nombre de copies.
 * @returns {Map<string, {dossier: string, regle: 'deja-employe'|'nom'|'homonyme'|'identifiant',
 *   raison?: string, nomChange?: boolean}>}
 */
function dossiersDesComptes({ comptes = [], employes = new Map() } = {}) {
  // Un compte une seule fois, dans l'ordre reçu ; le premier nom non vide gagne.
  const parCle = new Map();
  for (const c of comptes) {
    const cle = accountIds.normalize(c?.cle);
    if (!cle) continue;
    const nom = String(c?.nom ?? '');
    if (!parCle.has(cle)) parCle.set(cle, { cle, nom });
    else if (!parCle.get(cle).nom.trim() && nom.trim()) parCle.get(cle).nom = nom;
  }
  for (const cle of employes.keys()) {
    const propre = accountIds.normalize(cle);
    if (propre && !parCle.has(propre)) parCle.set(propre, { cle: propre, nom: '' });
  }
  const tous = [...parCle.values()];

  // Le nom de chaque compte, rendu sûr — ou la raison de son absence.
  for (const c of tous) {
    c.identifiant = dossierIdentifiant(c.cle);
    if (!c.nom.trim()) {
      c.sansNom = 'aucun nom connu';
    } else {
      c.propre = nomDeDossier(c.nom);
      if (!c.propre) c.sansNom = 'nom vide une fois rendu sûr';
      // Lot 97 : un « nom » qui contient l'identifiant n'en est pas un.
      else if (c.cle.length >= 4 && c.propre.includes(c.cle)) c.sansNom = 'nom qui contient l\'identifiant';
    }
  }

  // Qui range où, aujourd'hui (dossier → comptes), à la casse près.
  const occupants = new Map();
  for (const [cle, dossiers] of employes) {
    const propre = accountIds.normalize(cle);
    for (const dossier of dossiers.keys()) {
      const k = cleDeDossier(dossier);
      if (!occupants.has(k)) occupants.set(k, new Set());
      occupants.get(k).add(propre);
    }
  }

  // Le dossier que le nom donnerait — les homonymes reconnus parmi TOUS les
  // comptes nommés, à la casse près, avec le suffixe de « Mes documents ».
  const groupes = new Map();
  for (const c of tous.filter((x) => !x.sansNom)) {
    const k = cleDeDossier(c.propre);
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push(c);
  }
  for (const groupe of groupes.values()) {
    if (groupe.length === 1) {
      groupe[0].voulu = groupe[0].propre;
      groupe[0].regle = 'nom';
      continue;
    }
    const fins = finsDistinctives(groupe.map((c) => c.cle));
    for (const [i, c] of groupe.entries()) {
      if (fins) {
        c.voulu = `${c.propre} (…${fins[i]})`;
        c.regle = 'homonyme';
      } else {
        c.sansNom = 'homonymes que la fin de leur identifiant ne distingue pas';
      }
    }
  }

  const decisions = new Map();
  const reserves = new Map(); // clé de dossier → compte qui le tient

  // 1. Le dossier déjà employé, autre que l'identifiant, et à ce seul compte —
  //    un segment sûr (lu dans un chemin enregistré, il l'est toujours ; la
  //    garde rend la fonction totale).
  for (const c of tous) {
    const dossiers = [...(employes.get(c.cle) || new Map()).entries()]
      .filter(([d]) => d && paths.safeSegment(d, '') === d)
      .filter(([d]) => cleDeDossier(d) !== cleDeDossier(c.identifiant))
      .filter(([d]) => occupants.get(cleDeDossier(d))?.size === 1)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (!dossiers.length) continue;
    const [dossier] = dossiers[0];
    decisions.set(c.cle, {
      dossier,
      regle: 'deja-employe',
      // Ce que le nom donnerait aujourd'hui n'est plus ce dossier : le nom (ou
      // celui d'un homonyme) a changé depuis. Gardé, et dit au journal.
      nomChange: !c.voulu || cleDeDossier(c.voulu) !== cleDeDossier(dossier),
    });
    reserves.set(cleDeDossier(dossier), c.cle);
  }

  // 2. Le nom.
  const suffixe = (c) => {
    const fins = finsDistinctives([c.cle]);
    return fins ? `${c.propre} (…${fins[0]})` : null;
  };
  // Ce qui est pris : les dossiers réservés, ceux où un autre compte range,
  // l'identifiant de chaque autre compte.
  const prisPar = (k, cle) => {
    const tenu = reserves.get(k);
    if (tenu && tenu !== cle) return true;
    const ici = occupants.get(k);
    if (ici && [...ici].some((autre) => autre !== cle)) return true;
    return tous.some((autre) => autre.cle !== cle && cleDeDossier(autre.identifiant) === k);
  };
  const demandes = new Map(); // clé de dossier → comptes qui le veulent
  for (const c of tous) {
    if (decisions.has(c.cle) || c.sansNom) continue;
    let voulu = c.voulu;
    if (prisPar(cleDeDossier(voulu), c.cle) && c.regle === 'nom') {
      const autre = suffixe(c);
      if (autre && !prisPar(cleDeDossier(autre), c.cle)) {
        voulu = autre;
        c.regle = 'homonyme';
      }
    }
    if (prisPar(cleDeDossier(voulu), c.cle)) {
      c.sansNom = 'le dossier de ce nom est déjà celui d\'un autre compte';
      continue;
    }
    c.voulu = voulu;
    const k = cleDeDossier(voulu);
    if (!demandes.has(k)) demandes.set(k, []);
    demandes.get(k).push(c);
  }
  for (const voulants of demandes.values()) {
    for (const c of voulants) {
      if (voulants.length > 1) {
        c.sansNom = 'le dossier de ce nom est déjà celui d\'un autre compte';
        continue;
      }
      decisions.set(c.cle, { dossier: c.voulu, regle: c.regle });
    }
  }

  // 3. L'identifiant, comme avant.
  for (const c of tous) {
    if (decisions.has(c.cle)) continue;
    decisions.set(c.cle, { dossier: c.identifiant, regle: 'identifiant', raison: c.sansNom || 'aucun nom connu' });
  }
  return decisions;
}

/**
 * Le dossier de compte d'un chemin ENREGISTRÉ (`invoices.destinations[…].path`) :
 * le segment qui suit `<utilisateur>/<Nom du connecteur>`, le dernier couple
 * trouvé. Le stockage local (chemin absolu) et les clouds (`remote:<base>/…`)
 * ont la même suite. `null` si le chemin n'a pas cette forme. Pure.
 *
 * @returns {{dossier: string, index: number, segments: string[], prefixe: string}|null}
 */
function dossierDuChemin(chemin, { username, connectorName }) {
  const texte = String(chemin ?? '');
  const deuxPoints = texte.startsWith('/') ? -1 : texte.indexOf(':');
  const prefixe = deuxPoints >= 0 ? texte.slice(0, deuxPoints + 1) : '';
  const segments = texte.slice(prefixe.length).split('/');
  const u = paths.safeSegment(username, 'inconnu');
  const n = paths.safeSegment(connectorName, 'connecteur');
  for (let i = segments.length - 3; i >= 1; i--) {
    if (segments[i - 1] === u && segments[i] === n && segments[i + 1]) {
      return { dossier: segments[i + 1], index: i + 1, segments, prefixe };
    }
  }
  return null;
}

/** Le même chemin, son dossier de compte remplacé. Pure. */
function cheminDansLeDossier(chemin, dossier, contexte) {
  const lu = dossierDuChemin(chemin, contexte);
  if (!lu) return null;
  const segments = [...lu.segments];
  segments[lu.index] = dossier;
  return `${lu.prefixe}${segments.join('/')}`;
}

/** Le connecteur sait-il nommer ses comptes ? Sa fonction, ou `null`. */
function nommeur(connectorId) {
  const registry = require('./connectors/registry');
  if (!registry.has(connectorId)) return null;
  const fn = registry.get(connectorId)?.module?.nomDuCompte;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Les faits dont `dossiersDesComptes` a besoin, lus en base : les comptes de
 * la découverte (dans son ordre, avec leur nom), puis ceux qui n'ont que des
 * documents ; et les dossiers où chaque compte range aujourd'hui.
 *
 * @returns {{comptes: Array<{cle: string, nom: string}>, employes: Map<string, Map<string, number>>,
 *   lignes: Array<object>}}
 */
function faitsDuConnecteur(userId, connectorId, { username, connectorName, nomDuCompte }) {
  const db = require('./db/db');
  const registry = require('./connectors/registry');
  const discovery = require('./connectors/discovery');
  const invoices = require('./invoices');

  const champ = registry.has(connectorId) ? registry.discoveryField(connectorId) : null;
  const stocke = champ ? discovery.read(userId, connectorId, champ.key) : null;
  const comptes = (stocke?.items || []).map((item) => ({
    cle: item.id,
    nom: String(nomDuCompte(item) ?? ''),
  }));

  const lignes = db.get()
    .prepare('SELECT id, account_id, filename, size_bytes, destinations FROM invoices WHERE user_id = ? AND connector_id = ? ORDER BY id')
    .all(userId, connectorId);
  const employes = new Map();
  for (const l of lignes) {
    const cle = accountIds.normalize(l.account_id);
    if (!cle) continue;
    if (!employes.has(cle)) employes.set(cle, new Map());
    for (const entree of Object.values(invoices.parseDestinations(l.destinations))) {
      if (!entree?.ok || !entree.path) continue;
      const lu = dossierDuChemin(entree.path, { username, connectorName });
      if (!lu) continue;
      const m = employes.get(cle);
      m.set(lu.dossier, (m.get(lu.dossier) || 0) + 1);
    }
  }
  return { comptes, employes, lignes };
}

/**
 * Le dossier de chaque dépôt d'un passage — `null` pour un connecteur qui ne
 * nomme pas ses comptes (tous sauf Gandi) : le planificateur garde alors
 * l'identifiant, sans rien appeler d'autre.
 *
 * Décidé une fois, au moment des dépôts : la découverte vient d'être
 * rafraîchie par ce passage même. Rend `dossier(cle)` et `bilan()`, la phrase
 * du journal — des nombres et des formes, jamais un nom ni un identifiant.
 */
function pourLePassage(userId, connectorId, { username, connectorName }) {
  const nomDuCompte = nommeur(connectorId);
  if (!nomDuCompte) return null;
  const faits = faitsDuConnecteur(userId, connectorId, { username, connectorName, nomDuCompte });
  const decisions = dossiersDesComptes(faits);
  const servis = new Map(); // compte → { decision, documents }

  const registry = require('./connectors/registry');
  const champ = registry.discoveryField(connectorId);
  const unite = champ?.unit || 'compte';

  return {
    dossier(cle) {
      const propre = accountIds.normalize(cle) || accountIds.DEFAULT_ACCOUNT_ID;
      const decision = decisions.get(propre)
        || { dossier: dossierIdentifiant(propre), regle: 'identifiant', raison: 'absent de la découverte' };
      const servi = servis.get(propre) || { decision, documents: 0 };
      servi.documents++;
      servis.set(propre, servi);
      return decision;
    },
    bilan() {
      if (!servis.size) return null;
      const groupes = new Map();
      for (const { decision, documents } of servis.values()) {
        const libelle = decision.regle === 'identifiant'
          ? `à l'identifiant, comme avant (${decision.raison})`
          : decision.regle === 'deja-employe'
            ? (decision.nomChange
              ? 'dans le dossier déjà employé, gardé — le nom ne le donnerait plus : rien n\'est dispersé'
              : 'dans le dossier déjà employé, au nom')
            : decision.regle === 'homonyme'
              ? 'au nom suivi de la fin de l\'identifiant (homonymes)'
              : 'au nom';
        const g = groupes.get(libelle) || { comptes: 0, documents: 0 };
        g.comptes++;
        g.documents += documents;
        groupes.set(libelle, g);
      }
      const morceaux = [...groupes.entries()].map(([libelle, g]) =>
        `${libelle} — ${g.comptes} ${unite}${g.comptes > 1 ? 's' : ''}, ${g.documents} document(s)`);
      return `dossiers de dépôt : ${morceaux.join(' ; ')}.`;
    },
  };
}

module.exports = {
  NOM_OCTETS_MAX,
  nomDeDossier,
  cleDeDossier,
  dossierIdentifiant,
  dossiersDesComptes,
  dossierDuChemin,
  cheminDansLeDossier,
  nommeur,
  faitsDuConnecteur,
  pourLePassage,
};
