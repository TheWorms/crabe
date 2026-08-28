'use strict';

/**
 * Ce que le site demande pour vous reconnaître : une adresse, ou un identifiant.
 *
 * ─── Le défaut que ce vocabulaire corrige ────────────────────────────────────
 *
 * La fiche de L'Atelier du Portable réclamait une « Adresse électronique ». Le
 * site, lui, demande un IDENTIFIANT — et la valeur réellement enregistrée
 * (« prenom.nom ») n'est pas une adresse. Le libellé était écrit à la main dans
 * le manifeste, le formulaire l'affichait tel quel, et rien ne pouvait le
 * démentir : un connecteur pouvait réclamer une adresse là où le site n'en veut
 * pas, sans que personne ne s'en aperçoive avant la première connexion ratée.
 *
 * Le formulaire, de son côté, ramenait TOUT champ d'adresse à un `type="text"`
 * — un contournement sans motif écrit, qui effaçait la seule distinction que le
 * navigateur pouvait encore faire (clavier d'adresse sur téléphone).
 *
 * ─── Ce que le manifeste déclare désormais ───────────────────────────────────
 *
 * Le champ d'identification déclare sa NATURE, pas son libellé :
 *
 * ```json
 * { "key": "email", "identification": "identifiant", "type": "text" }
 * ```
 *
 * Libellé, texte d'aide et type de champ HTML en découlent — ici, une fois, pour
 * tous les connecteurs. Un manifeste n'a plus à les écrire, donc ne peut plus
 * les écrire faux.
 *
 * ─── Ce qu'un site garde le droit de nommer lui-même ─────────────────────────
 *
 * « Numéro fiscal », « Numéro allocataire », « Identifiant ou numéro de ligne »
 * ne sont pas des synonymes à unifier : ce sont des faits du site, et son
 * formulaire les écrit ainsi. Un champ peut donc garder son `label` et son
 * `help` propres — la nature reste déclarée, parce que c'est elle qui fixe le
 * type de champ HTML et qui dit, à qui lit le manifeste, si ce service
 * s'authentifie par adresse électronique ou non.
 *
 * La clé de configuration (`key`) ne suit PAS la nature : elle nomme un
 * emplacement en base, déjà rempli chez les utilisateurs. L'Atelier du Portable
 * garde donc `"key": "email"` avec une nature `identifiant` — renommer la clé
 * aurait fait disparaître la valeur enregistrée de la fiche.
 */

/**
 * Les natures connues, et ce que chacune impose au formulaire.
 *
 * `aide` prend le nom du service : « Celle avec laquelle vous vous connectez sur
 * Kubii. » est exactement ce que les sept boutiques PrestaShop écrivaient à la
 * main, une phrase par manifeste.
 *
 * Le pronom porte la distinction que le libellé annonce — « Celle » pour une
 * adresse, « Celui » pour un identifiant : c'est le français qui refuse de
 * mélanger les deux, et ça ne coûte rien de le laisser faire.
 */
const NATURES = {
  email: {
    label: 'Adresse électronique',
    inputType: 'email',
    aide: (nom) => `Celle avec laquelle vous vous connectez sur ${nom}.`,
  },
  identifiant: {
    label: 'Identifiant',
    inputType: 'text',
    aide: (nom) => `Celui avec lequel vous vous connectez sur ${nom}.`,
  },
};

/** Les natures déclarables, pour les messages d'erreur du schéma. */
const KEYS = Object.keys(NATURES);

/** Le nom écrit dans l'aide quand le manifeste n'en donne pas. */
const SERVICE_PAR_DEFAUT = 'ce site';

/** @returns {boolean} vrai si `nature` est déclarable dans un manifeste. */
function has(nature) {
  return typeof nature === 'string' && Object.prototype.hasOwnProperty.call(NATURES, nature);
}

/** @returns {{label: string, inputType: string, aide: Function}|null} */
function nature(field) {
  const declaree = field?.identification;
  return has(declaree) ? NATURES[declaree] : null;
}

/** Vrai si ce champ est CELUI par lequel le site reconnaît son visiteur. */
function estIdentification(field) {
  return field?.identification !== undefined;
}

/**
 * Libellé et aide déduits de la nature déclarée.
 *
 * Renvoie un objet vide pour un champ qui ne déclare rien : le mot de passe,
 * l'adresse d'une boutique, la profondeur d'historique gardent leurs textes.
 *
 * @param {object} field champ du manifeste
 * @param {string} [nomDuService] pour écrire l'aide dans la langue de l'utilisateur
 * @returns {{label?: string, help?: string}}
 */
function defauts(field, nomDuService = '') {
  const trouvee = nature(field);
  if (!trouvee) return {};

  const nom = String(nomDuService || '').trim() || SERVICE_PAR_DEFAUT;
  return { label: trouvee.label, help: trouvee.aide(nom) };
}

/**
 * Le type de champ HTML : celui de la nature déclarée, sinon celui du champ.
 *
 * C'est ce que le formulaire pose dans `<input type="…">`. Il ne décide plus
 * rien de lui-même — c'est tout l'objet de ce module.
 *
 * @param {object} field
 * @returns {string}
 */
function inputType(field) {
  return nature(field)?.inputType || field?.type;
}

module.exports = {
  NATURES,
  KEYS,
  SERVICE_PAR_DEFAUT,
  has,
  nature,
  estIdentification,
  defauts,
  inputType,
};
