'use strict';

/**
 * Profondeur d'historique — quel passé un connecteur va rechercher.
 *
 * ─── Le problème, tel qu'Amazon le pose ──────────────────────────────────────
 *
 * Le compte de test expose **quinze années** de commandes, de 2012 à 2026. Un
 * rattrapage complet demande environ deux minutes par année de douze commandes,
 * soit une demi-heure de sollicitation du site — et Amazon limite les accès
 * après des parcours rapprochés (voir le connecteur, §« ménager le site »).
 *
 * Ce rattrapage a du sens **une fois**. Le répéter à chaque exécution
 * planifiée, c'est-à-dire tous les jours, n'en a aucun : les commandes de 2014
 * ne changent plus.
 *
 * ─── Pourquoi c'est générique et pas dans le connecteur ──────────────────────
 *
 * Amazon n'est pas un cas particulier. Tout portail qui expose un historique
 * profond pose la même question — les impôts, une banque, un opérateur. La
 * réponse est la même partout, et l'utilisateur doit la retrouver au même
 * endroit avec les mêmes mots. Un connecteur déclare simplement un champ de
 * type `history` dans son manifeste ; le socle fait le reste.
 *
 * ─── Les quatre choix ────────────────────────────────────────────────────────
 *
 *   Toutes les années disponibles      premier passage, long
 *   Les [ 2 ▾ ] dernières années
 *   Année en cours seulement
 *   Depuis la dernière récupération    recommandé
 *
 * ─── « Depuis la dernière récupération », en détail ──────────────────────────
 *
 * C'est le défaut, et c'est le seul mode qui se comporte différemment selon
 * l'état du compte :
 *
 *   - **jamais rien récupéré** → toutes les années disponibles. C'est le
 *     premier passage : il faut bien aller chercher le passé une fois, et
 *     personne ne devrait avoir à le demander explicitement ;
 *   - **une récupération a déjà eu lieu** → l'année en cours seulement…
 *   - **…plus l'année précédente entre janvier et mars.** Une facture de
 *     décembre est souvent émise en janvier, et un rattrapage qui s'arrête au
 *     1er janvier la manquerait pour toujours. Trois mois de recouvrement
 *     coûtent une année de plus à parcourir, trois fois par an.
 *
 * Toutes les fonctions de ce fichier sont **pures** : c'est ce qui rend la
 * règle vérifiable sans navigateur, sans réseau et sans horloge réelle.
 */

/** Les quatre modes, dans l'ordre où ils s'affichent. */
const MODES = ['tout', 'dernieres', 'courante', 'depuis'];

/** Le défaut : incrémental, avec rattrapage complet au premier passage. */
const DEFAUT = 'depuis';

/** Valeur proposée par défaut pour « les N dernières années ». */
const ANNEES_DEFAUT = 2;

/** Bornes du sélecteur de « N dernières années ». */
const ANNEES_MIN = 1;
const ANNEES_MAX = 15;

/** Mois (1 à 12) jusqu'auquel l'année précédente reste parcourue. */
const MOIS_RECOUVREMENT = 3;

/**
 * ─── Le plafond de conservation (lot 24) ─────────────────────────────────────
 *
 * Deux réglages de crabe parlaient du passé sans jamais se parler :
 *
 *   - ici, par connecteur : « Historique à récupérer » → va chercher loin ;
 *   - dans l'administration : « Conservation des documents » → efface ce qui
 *     dépasse 3 mois, 6 mois, 1 an ou 2 ans.
 *
 * Le 12/08/2026, avec « Conservation : 1 an », crabe a téléchargé 65 factures
 * OVH et 53 SoYouStart remontant à 2020 — plusieurs minutes d'appels et 118
 * PDF déposés sur le stockage local — puis l'entretien de 02:15 en a effacé 149 la nuit
 * suivante, fichiers compris. Au matin il restait 2 factures OVH sur 67, et
 * l'utilisateur a constaté, à juste titre, que « crabe ne récupère pas toutes
 * mes factures ».
 *
 * Aucun des deux réglages n'était en tort tout seul. C'est leur rencontre qui
 * l'était, et elle se réglait en silence, du mauvais côté : au prix fort
 * (télécharger) pour un résultat nul (effacer).
 *
 * **La conservation devient donc un PLAFOND sur ce que crabe va chercher.**
 * Elle ne restreint jamais un compte qui garde tout (`plafondMois` à 0), et
 * elle ne s'invente rien : la borne est exactement celle que le nettoyage
 * appliquera, `maintenant - N mois`.
 *
 * ⚠ Ce module reste PUR : il ne lit pas la base. La valeur lui arrive par
 * `ctx.conservationMois`, posé une seule fois dans `registry.makeContext()`.
 * C'est ce qui permet de vérifier la règle sans base ni horloge réelle.
 */

/**
 * La borne basse imposée par la conservation, ou `null` s'il n'y en a pas.
 *
 * @param {number|null|undefined} plafondMois 0 ou absent = « tout garder »
 * @param {Date} maintenant
 * @returns {Date|null}
 */
function bornePlafond(plafondMois, maintenant) {
  const mois = Number(plafondMois);
  if (!Number.isFinite(mois) || mois <= 0) return null;
  const borne = new Date(maintenant.getTime());
  borne.setUTCMonth(borne.getUTCMonth() - mois);
  return borne;
}

/** Libellés de l'interface, tenus ici pour que serveur et écran s'accordent. */
const LIBELLES = {
  tout: { label: 'Toutes les années disponibles', note: 'premier passage, long' },
  dernieres: { label: 'Les {n} dernières années', note: '' },
  courante: { label: 'Année en cours seulement', note: '' },
  depuis: { label: 'Depuis la dernière récupération', note: 'recommandé' },
};

/**
 * Lit une valeur enregistrée.
 *
 * La configuration ne porte qu'une chaîne — `tout`, `dernieres:3`, `courante`,
 * `depuis` — parce que c'est ce que sait stocker un champ de connecteur, et
 * parce qu'une chaîne se relit à l'œil dans un journal. Tout ce qui n'est pas
 * reconnu retombe sur le défaut : une configuration abîmée ne doit pas faire
 * échouer une récupération, elle doit la rendre prudente.
 *
 * @param {string|null|undefined} valeur
 * @returns {{mode: string, annees: number}}
 */
function parse(valeur) {
  const texte = String(valeur ?? '').trim().toLowerCase();
  const [mode, brut] = texte.split(':');

  if (!MODES.includes(mode)) return { mode: DEFAUT, annees: ANNEES_DEFAUT };

  if (mode !== 'dernieres') return { mode, annees: ANNEES_DEFAUT };

  const n = Number.parseInt(brut, 10);
  return {
    mode,
    annees: Number.isFinite(n) ? Math.min(ANNEES_MAX, Math.max(ANNEES_MIN, n)) : ANNEES_DEFAUT,
  };
}

/** L'inverse de `parse()` : la forme enregistrée en configuration. */
function format(choix) {
  const { mode, annees } = parse(typeof choix === 'string' ? choix : formatBrut(choix));
  return mode === 'dernieres' ? `dernieres:${annees}` : mode;
}

/** `{ mode, annees }` → la chaîne que `parse()` sait relire. */
function formatBrut(choix) {
  const mode = String(choix?.mode || '');
  return mode === 'dernieres' ? `dernieres:${choix?.annees}` : mode;
}

/**
 * Les années à parcourir, de la plus récente à la plus ancienne.
 *
 * @param {object} options
 * @param {string} options.valeur          la configuration enregistrée
 * @param {Array<number|string>} options.disponibles  les années exposées par le site
 * @param {Date|number} [options.maintenant]          l'instant de référence
 * @param {boolean} [options.dejaRecupere]  une récupération a-t-elle déjà abouti ?
 * @returns {{annees: number[], mode: string, raison: string}}
 */
function anneesBrutes({ valeur, disponibles, maintenant = Date.now(), dejaRecupere = false }) {
  const { mode, annees: combien } = parse(valeur);

  // Décroissantes, dédoublonnées : l'ordre du site n'est pas un contrat, et le
  // sélecteur d'Amazon apparaît parfois en double.
  const offertes = [...new Set(
    (Array.isArray(disponibles) ? disponibles : [])
      .map((a) => Number.parseInt(a, 10))
      .filter((a) => Number.isFinite(a))
  )].sort((a, b) => b - a);

  if (!offertes.length) return { annees: [], mode, raison: 'aucune année exposée par le site' };

  const date = maintenant instanceof Date ? maintenant : new Date(maintenant);
  const anneeCourante = date.getFullYear();
  const mois = date.getMonth() + 1;

  if (mode === 'tout') {
    return { annees: offertes, mode, raison: `les ${offertes.length} années disponibles` };
  }

  if (mode === 'dernieres') {
    const retenues = offertes.slice(0, combien);
    return { annees: retenues, mode, raison: `les ${retenues.length} dernières années` };
  }

  if (mode === 'courante') {
    const retenues = offertes.filter((a) => a === anneeCourante);
    return {
      annees: retenues,
      mode,
      // Une année en cours absente du site est une information, pas un échec.
      raison: retenues.length ? `l'année ${anneeCourante}` : `${anneeCourante} n'est pas proposée`,
    };
  }

  // « depuis » — le défaut.
  if (!dejaRecupere) {
    return {
      annees: offertes,
      mode,
      raison: `premier passage : les ${offertes.length} années disponibles`,
    };
  }

  const voulues = [anneeCourante];
  if (mois <= MOIS_RECOUVREMENT) voulues.push(anneeCourante - 1);
  const retenues = offertes.filter((a) => voulues.includes(a));

  return {
    annees: retenues,
    mode,
    raison:
      mois <= MOIS_RECOUVREMENT
        ? `${anneeCourante}, et ${anneeCourante - 1} pour ne pas manquer les factures de décembre`
        : `l'année ${anneeCourante}`,
  };
}

/**
 * Les années réellement parcourues — plafond de conservation compris.
 *
 * Même partage qu'entre `fenetreBrute()` et `fenetreDeDates()` : d'un côté ce
 * que le réglage du connecteur demande, de l'autre ce que crabe va vraiment
 * parcourir une fois la conservation prise en compte.
 *
 * ⚠ L'année de la borne est GARDÉE, jamais retirée. Avec une conservation d'un
 * an, en août 2026, la borne tombe en août 2025 : l'année 2025 est à moitié
 * dans la fenêtre, et la retirer perdrait les factures de septembre à décembre
 * 2025, qui, elles, seront conservées. On coupe donc à l'année, pas au mois —
 * quitte à parcourir un peu plus que nécessaire, ce qui ne coûte qu'un peu de
 * temps là où l'inverse coûterait des documents.
 *
 * @param {object} options mêmes clés que `anneesBrutes`, plus `plafondMois`
 * @returns {{annees: number[], mode: string, raison: string, plafonne: boolean}}
 */
function anneesAParcourir({ plafondMois = 0, ...options }) {
  const brut = anneesBrutes(options);
  const mois = Number(plafondMois) > 0 ? Number(plafondMois) : 0;
  const maintenant = options.maintenant instanceof Date
    ? options.maintenant
    : new Date(options.maintenant ?? Date.now());
  const borne = bornePlafond(mois, maintenant);
  if (!borne) return { ...brut, plafonne: false, plafondMois: mois };

  const anneePlancher = borne.getUTCFullYear();
  const retenues = brut.annees.filter((a) => a >= anneePlancher);
  if (retenues.length === brut.annees.length) {
    return { ...brut, plafonne: false, plafondMois: mois };
  }

  return {
    ...brut,
    annees: retenues,
    plafonne: true,
    plafondMois: mois,
    raison:
      `${brut.raison}, ramené à ${libellePlafond(mois)} (depuis ${anneePlancher}) par votre `
      + 'réglage de conservation — crabe ne va pas chercher des documents que le nettoyage '
      + 'effacerait',
  };
}

/**
 * La même règle, mais en FENÊTRE DE DATES — pour les services à API.
 *
 * ─── Pourquoi `anneesAParcourir()` ne suffisait pas ──────────────────────────
 *
 * Ce module est né du scraping (lot 9, Amazon) : un portail affiche un
 * sélecteur d'années, on lui demande celles qu'on veut, on parcourt. D'où une
 * fonction qui prend `disponibles` — la liste des années que le site propose —
 * et rend un sous-ensemble.
 *
 * Une API de facturation ne travaille pas comme ça. OVHcloud attend
 * `date.from` / `date.to` sur `/me/bill`, et **ce qui n'est pas dans la fenêtre
 * n'est jamais listé** : il n'y a pas de « liste des années disponibles » à
 * consulter d'abord, et demander la liste complète pour la filtrer ensuite
 * reviendrait à ne pas se servir de la fenêtre.
 *
 * Le lot 17 a montré ce que ça coûte : 67 factures OVH depuis 2021, dont 12
 * mois seulement remontaient, sans qu'aucun réglage n'y change quoi que ce
 * soit. Le connecteur était antérieur au champ `history` et n'avait jamais été
 * mis à niveau.
 *
 * ─── Ce que la fonction rend ─────────────────────────────────────────────────
 *
 * `from` vaut **`null` pour « aucune borne basse »**, et c'est un cas normal,
 * pas une erreur : « toutes les années disponibles » et le premier passage de
 * « depuis la dernière récupération » veulent précisément tout l'historique.
 * L'appelant traduit ce `null` par « je n'envoie pas `date.from` » — chez OVH,
 * `/me/bill` sans borne rend bien la totalité.
 *
 * Les bornes sont alignées sur des ANNÉES CIVILES, exactement comme
 * `anneesAParcourir()` : « les 2 dernières années » en juin 2026, ce sont 2025
 * et 2026 en entier, pas les 24 mois glissants. Les deux fonctions doivent
 * décrire le même passé, sinon le même réglage ne voudrait pas dire la même
 * chose selon que le service est scrapé ou appelé en API.
 *
 * @param {object} options
 * @param {string} options.valeur              la configuration enregistrée
 * @param {Date|number} [options.maintenant]   l'instant de référence
 * @param {boolean} [options.dejaRecupere]     une récupération a-t-elle abouti ?
 * @returns {{from: Date|null, to: Date, mode: string, raison: string}}
 */
function fenetreBrute({ valeur, maintenant = Date.now(), dejaRecupere = false } = {}) {
  const { mode, annees: combien } = parse(valeur);

  const to = maintenant instanceof Date ? new Date(maintenant) : new Date(maintenant);
  const anneeCourante = to.getFullYear();
  const mois = to.getMonth() + 1;

  /** Le 1er janvier d'une année, à minuit UTC. */
  const premierJanvier = (annee) => new Date(Date.UTC(annee, 0, 1, 0, 0, 0, 0));

  if (mode === 'tout') {
    return { from: null, to, mode, raison: 'tout l\'historique disponible' };
  }

  if (mode === 'dernieres') {
    const depuisAnnee = anneeCourante - combien + 1;
    return {
      from: premierJanvier(depuisAnnee),
      to,
      mode,
      raison: `les ${combien} dernières années (depuis janvier ${depuisAnnee})`,
    };
  }

  if (mode === 'courante') {
    return {
      from: premierJanvier(anneeCourante),
      to,
      mode,
      raison: `l'année ${anneeCourante}`,
    };
  }

  // « depuis » — le défaut.
  if (!dejaRecupere) {
    return { from: null, to, mode, raison: 'premier passage : tout l\'historique disponible' };
  }

  // Le recouvrement de janvier à mars : une facture de décembre émise en
  // janvier serait perdue pour toujours par une fenêtre qui s'arrête au 1er.
  const depuisAnnee = mois <= MOIS_RECOUVREMENT ? anneeCourante - 1 : anneeCourante;
  return {
    from: premierJanvier(depuisAnnee),
    to,
    mode,
    raison:
      mois <= MOIS_RECOUVREMENT
        ? `${anneeCourante}, et ${anneeCourante - 1} pour ne pas manquer les factures de décembre`
        : `l'année ${anneeCourante}`,
  };
}

/**
 * La fenêtre de dates réellement demandée au service — plafond compris.
 *
 * `fenetreBrute()` dit ce que le RÉGLAGE DU CONNECTEUR demande ; cette
 * fonction-ci dit ce que crabe va effectivement chercher, une fois la
 * conservation prise en compte. La distinction compte : c'est elle qui permet
 * d'annoncer « votre réglage demandait tout l'historique, la conservation le
 * ramène à un an » au lieu de rogner la fenêtre sans le dire.
 *
 * Trois cas, et un seul modifie quoi que ce soit :
 *
 *   - pas de plafond (« Tout garder ») → la fenêtre du connecteur, intacte ;
 *   - fenêtre déjà plus courte que le plafond → intacte aussi, le plafond
 *     n'est pas un plancher : il ne fait jamais chercher PLUS loin ;
 *   - fenêtre plus longue → ramenée à la borne du nettoyage, `plafonne: true`.
 *
 * @param {object} options
 * @param {string} options.valeur              la configuration enregistrée
 * @param {Date|number} [options.maintenant]   l'instant de référence
 * @param {boolean} [options.dejaRecupere]     une récupération a-t-elle abouti ?
 * @param {number} [options.plafondMois]       conservation, 0 = tout garder
 * @returns {{from: Date|null, to: Date, mode: string, raison: string,
 *   plafonne: boolean, plafondMois: number}}
 */
function fenetreDeDates({ valeur, maintenant = Date.now(), dejaRecupere = false,
  plafondMois = 0 } = {}) {
  const brute = fenetreBrute({ valeur, maintenant, dejaRecupere });
  const mois = Number(plafondMois) > 0 ? Number(plafondMois) : 0;
  const borne = bornePlafond(mois, brute.to);

  // `from === null` veut dire « aucune borne », c'est-à-dire la fenêtre la plus
  // large qui soit : elle dépasse forcément le plafond. Ne pas traiter ce cas
  // laisserait passer exactement celui qui a coûté 118 téléchargements.
  if (!borne || (brute.from && brute.from >= borne)) {
    return { ...brute, plafonne: false, plafondMois: mois };
  }

  return {
    ...brute,
    from: borne,
    plafonne: true,
    plafondMois: mois,
    raison:
      `${brute.raison}, ramené à ${libellePlafond(mois)} par votre réglage de conservation `
      + '— crabe ne va pas chercher des documents que le nettoyage effacerait',
  };
}

/** « 1 an », « 6 mois »… tel qu'on l'écrit dans une phrase. */
function libellePlafond(mois) {
  if (mois === 12) return '1 an';
  if (mois === 24) return '2 ans';
  return `${mois} mois`;
}

/**
 * Le champ tel que l'interface doit le rendre : les quatre choix, leur note, et
 * les valeurs proposées au sélecteur « N dernières années ».
 *
 * Écrit ici plutôt que dans le front pour une raison simple : les mots de ce
 * réglage engagent le comportement du serveur. Les tenir à deux endroits, c'est
 * les voir diverger.
 */
function choix() {
  return MODES.map((mode) => ({
    mode,
    label: LIBELLES[mode].label,
    note: LIBELLES[mode].note,
  }));
}

module.exports = {
  MODES,
  DEFAUT,
  ANNEES_DEFAUT,
  ANNEES_MIN,
  ANNEES_MAX,
  MOIS_RECOUVREMENT,
  LIBELLES,
  parse,
  format,
  anneesAParcourir,
  fenetreDeDates,
  choix,
  // Le plafond de conservation (lot 24), et les deux fonctions « avant
  // plafond » — exportées pour que les tests puissent montrer l'écart entre ce
  // que le réglage demande et ce que crabe va effectivement chercher.
  bornePlafond,
  libellePlafond,
  anneesBrutes,
  fenetreBrute,
};
