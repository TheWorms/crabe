'use strict';

/**
 * Ce que le `rclone` installé sait réellement faire.
 *
 * ─── Pourquoi cette question mérite du code ──────────────────────────────────
 *
 * On croit savoir qu'rclone gère « à peu près tout ». C'est faux d'une
 * installation à l'autre, et ça se mesure. Sur le conteneur de production,
 * le 13/08/2026 :
 *
 *     rclone v1.60.1-DEV (paquet Debian 13) → **46** types de stockage
 *     mega        : ABSENT
 *     protondrive : ABSENT
 *     webdav      : présent
 *     pcloud      : présent
 *
 * Autrement dit, la destination Proton Drive que crabe propose depuis le lot 9
 * ne peut pas fonctionner sur ce serveur-là, et personne ne s'en était aperçu
 * parce qu'elle n'a jamais été activée. Sans ce module, un utilisateur qui
 * l'activerait recevrait de rclone un « didn't find section in config file »
 * ou un « unknown backend » — un message qui ne dit ni ce qui manque, ni quoi
 * faire.
 *
 * ─── Ce que la mise à jour du lot 28 a changé, et ce qu'elle n'a pas changé ───
 *
 * Le même conteneur, le 13/08/2026 au soir, avec le binaire officiel installé
 * à côté du paquet Debian (`/usr/local/bin/rclone`, `CRABE_RCLONE_BIN` pointé
 * dessus) :
 *
 *     rclone v1.75.0 (binaire officiel) → **69** types de stockage
 *     mega        : PRÉSENT
 *     protondrive : PRÉSENT
 *
 * Deux absences, deux causes distinctes, et elles valent d'être connues :
 * `protondrive` n'existe qu'à partir d'rclone 1.64, il était donc simplement
 * trop récent pour un binaire de 2022 ; `mega`, lui, existe depuis 2017 et
 * manquait pour une tout autre raison — Debian retire ce pilote de son paquet
 * (le `+dfsg` de son numéro de version le dit). Aucune montée de version du
 * paquet Debian ne l'aurait donc ramené : il fallait le binaire officiel.
 *
 * Ce module, lui, n'a pas bougé d'une ligne pour autant : il MESURE au lieu de
 * savoir, et c'est exactement pourquoi la mise à jour n'a demandé aucun
 * changement de code côté liste des types.
 *
 * ─── Ce que le module rend, et d'où ça vient ─────────────────────────────────
 *
 * `rclone config providers` rend du **JSON** : la liste complète des types,
 * chacun avec ses options, leur aide, et le fait qu'elles soient obligatoires,
 * secrètes ou « avancées ». C'est la source de vérité, elle vient du binaire
 * lui-même, et elle est toujours à jour — c'est exactement ce qu'il fallait
 * pour construire un formulaire sans deviner (voir `generique.js`).
 *
 * Le résultat est mis en cache : la liste ne change qu'à la mise à jour du
 * binaire, et l'appel coûte une exécution de processus qu'on ne va pas payer à
 * chaque affichage d'écran.
 */

const rclone = require('./rclone');

/** Durée de vie du cache. Une mise à jour d'rclone se voit au bout d'une heure. */
const CACHE_MS = 60 * 60 * 1000;

let cache = null;

/**
 * Le drapeau `Hide` d'rclone qui dit « cette option n'a rien à faire dans un
 * FICHIER de configuration ».
 *
 * `Hide` est un jeu de bits : 1 = à cacher de la ligne de commande, 2 = à
 * cacher du fichier de configuration, 3 = les deux. Seul le bit 2 nous
 * concerne : crabe écrit un fichier de configuration, et rien d'autre.
 */
const MASQUE_FICHIER_CONF = 2;

/**
 * Une option d'rclone, traduite en champ de formulaire crabe.
 *
 * Quatre traductions comptent :
 *
 *   - `IsPassword` → `type: 'password'`, pour que la valeur ne se réaffiche
 *     jamais et ne parte pas au navigateur ;
 *   - `Examples` → une liste déroulante quand rclone dit lui-même quelles sont
 *     les valeurs attendues. C'est ce qui évite de faire taper « nextcloud »
 *     à la lettre près ;
 *   - `Help`, multi-ligne chez rclone, gardé tel quel : `.field-help` est en
 *     `white-space: pre-line`, la structure survit à l'affichage ;
 *   - `Hide` → `masque`, le seul motif légitime de ne PAS proposer un champ.
 *     rclone s'en sert pour ses valeurs de travail — les quatre
 *     `client_access_token` de Proton Drive, par exemple, qu'il écrit lui-même
 *     après une connexion réussie et qu'il annote « internal use only ». Les
 *     demander à quelqu'un serait lui demander de deviner le résultat d'une
 *     opération qui n'a pas encore eu lieu.
 */
function champDepuisOption(option) {
  const exemples = Array.isArray(option?.Examples) ? option.Examples : [];
  return {
    key: String(option?.Name || ''),
    label: String(option?.Name || ''),
    type: option?.IsPassword ? 'password' : 'text',
    required: !!option?.Required,
    avance: !!option?.Advanced,
    masque: !!(Number(option?.Hide || 0) & MASQUE_FICHIER_CONF),
    help: String(option?.Help || '').trim(),
    defaut: option?.DefaultStr === undefined ? '' : String(option.DefaultStr ?? ''),
    // `Exclusive` veut dire « une de ces valeurs, et pas une autre » : c'est le
    // seul cas où la liste peut remplacer le champ libre sans rien interdire.
    options: exemples.map((e) => ({
      value: String(e?.Value ?? ''),
      label: String(e?.Value ?? '') + (e?.Help ? ` — ${String(e.Help).split('\n')[0]}` : ''),
    })),
    listeStricte: !!option?.Exclusive,
  };
}

/** Interroge le binaire. Ne lève jamais : une absence est une information. */
async function charger() {
  try {
    const { stdout } = await rclone.run(['config', 'providers'], { timeout: 20_000 });
    const brut = JSON.parse(stdout);
    if (!Array.isArray(brut)) throw new Error('forme inattendue');
    return {
      ok: true,
      erreur: null,
      types: brut.map((b) => ({
        name: String(b?.Name || ''),
        description: String(b?.Description || ''),
        champs: (Array.isArray(b?.Options) ? b.Options : []).map(champDepuisOption),
      })).filter((t) => t.name),
    };
  } catch (err) {
    return { ok: false, erreur: err.message || String(err), types: [] };
  }
}

/** La liste, depuis le cache si elle est fraîche. */
async function lire({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.valeur;
  const valeur = await charger();
  cache = { at: Date.now(), valeur };
  return valeur;
}

/** Vide le cache — appelé par les tests, et après une mise à jour d'rclone. */
function oublier() {
  cache = null;
}

/**
 * Les types de stockage utilisables, triés par nom.
 *
 * Sont écartés les types qui ne désignent pas un stockage mais une
 * transformation d'un autre remote — les proposer dans une liste de
 * destinations n'aurait aucun sens pour qui la lit. `archive`, apparu avec
 * rclone 1.75, rejoint cette famille : il ouvre une archive posée ailleurs, en
 * lecture seule. Rien ne peut y être déposé.
 *
 * ⚠ `tardigrade` n'est pas de cette famille : c'est l'ANCIEN nom de `storj`,
 * gardé par rclone pour ne pas casser les configurations existantes. Les deux
 * portent le même libellé au mot près (« Storj Decentralized Cloud Storage ») :
 * les laisser tous les deux, c'est afficher deux fois le même service dans une
 * liste qu'on vient justement de fusionner pour supprimer un doublon (lot 28).
 */
const PAS_DES_STOCKAGES = new Set(['alias', 'crypt', 'cache', 'chunker', 'combine', 'compress',
  'hasher', 'union', 'memory', 'archive', 'tardigrade']);

async function typesDisponibles() {
  const { ok, types, erreur } = await lire();
  return {
    ok,
    erreur,
    types: types
      .filter((t) => !PAS_DES_STOCKAGES.has(t.name))
      .map((t) => ({ name: t.name, description: t.description }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
  };
}

/**
 * Les champs d'un type donné, ou `null` si ce type est inconnu d'ici.
 *
 * ─── Ce qui est retiré ici, et ce qui ne l'est PLUS (lot 29) ─────────────────
 *
 * Les champs **masqués** par rclone sont écartés : ce sont ses valeurs de
 * travail, qu'il écrit lui-même et que personne ne peut saisir.
 *
 * Les champs **avancés**, eux, sortent d'ici comme les autres — et c'est le
 * correctif du lot 29. crabe les jetait, au motif qu'ils sont nombreux et
 * rarement utiles. Sur les 968 options des 69 types de ce serveur, **688
 * étaient avancées** : sept champs sur dix inatteignables.
 *
 * Ce n'était pas un détail de confort. Un compte Proton Drive en mode « deux
 * mots de passe » se configure avec `mailbox_password`, qu'rclone range parmi
 * les options avancées : la destination était donc **impossible à configurer**,
 * et l'écran ne montrait rien qui l'explique — juste un test qui échoue sur
 * « this account requires a mailbox password », un champ qui n'existait nulle
 * part. Le même trou attendait pCloud, Dropbox ou Google Drive avec leur jeton
 * d'autorisation, également « avancé ».
 *
 * Ils sont désormais rendus, dans le repli « Réglages avancés » de la carte :
 * hors du chemin de celui qui n'en a pas besoin, atteignables par celui qui ne
 * peut pas s'en passer.
 */
async function champsDuType(nom) {
  const champs = lireTypes(await lire(), nom);
  return champs && champs.filter((c) => !c.masque);
}

/** Les champs bruts d'un type, masqués compris — pour les tests de couverture. */
function lireTypes(catalogue, nom) {
  return catalogue.types.find((t) => t.name === String(nom || ''))?.champs || null;
}

/** Les champs d'un type, exactement comme rclone les déclare. */
async function champsBrutsDuType(nom) {
  return lireTypes(await lire(), nom);
}

/**
 * Ce `rclone`-ci connaît-il ce type de stockage ?
 *
 * @returns {Promise<{connu: boolean, mesurable: boolean, erreur: string|null}>}
 *   `mesurable: false` quand le binaire n'a pas pu être interrogé du tout — on
 *   ne conclut alors PAS que le type manque, on dit qu'on ne sait pas.
 */
async function estDisponible(nom) {
  const { ok, types, erreur } = await lire();
  if (!ok) return { connu: false, mesurable: false, erreur };
  return { connu: types.some((t) => t.name === String(nom || '')), mesurable: true, erreur: null };
}

/**
 * Le message à montrer quand un type manque.
 *
 * Écrit pour quelqu'un qui découvre crabe : il dit ce qui manque, où, et le
 * seul geste qui répare — sans jargon d'empaquetage ni numéro de version
 * inventé.
 */
function messageTypeAbsent(nomDestination, type) {
  return (
    `Le logiciel rclone installé sur ce serveur ne sait pas parler à ${nomDestination}. `
    + `Ce n'est pas un problème de compte ni de mot de passe : le type de stockage « ${type} » `
    + 'ne fait pas partie de ceux que cette version de rclone gère. Il faut installer une '
    + 'version plus récente de rclone sur le serveur, puis retester cette destination.'
  );
}

module.exports = {
  CACHE_MS,
  MASQUE_FICHIER_CONF,
  PAS_DES_STOCKAGES,
  champDepuisOption,
  lire,
  oublier,
  typesDisponibles,
  champsDuType,
  champsBrutsDuType,
  estDisponible,
  messageTypeAbsent,
};
