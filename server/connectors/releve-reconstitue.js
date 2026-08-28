'use strict';

/**
 * Le relevé reconstitué — un document que crabe produit LUI-MÊME.
 *
 * ─── À quoi ça sert, et pourquoi c'est délicat ───────────────────────────────
 *
 * Certains services ne délivrent aucune facture. Une place de crypto-monnaies,
 * un compte de paiement : ils tiennent un historique d'opérations, ils
 * n'émettent pas de document comptable. Il n'y a donc rien à télécharger, et
 * un connecteur qui s'arrêterait là laisserait l'utilisateur sans trace.
 *
 * crabe peut mettre cet historique en forme. Mais un document fabriqué à
 * partir de données brutes N'EST PAS une facture, et le faire passer pour
 * telle serait grave : quelqu'un le rangerait avec ses justificatifs, le
 * présenterait un jour à un tiers, et découvrirait trop tard que le
 * fournisseur ne l'a jamais émis.
 *
 * D'où les deux règles de ce module, qui ne sont pas négociables et ne sont
 * pas configurables :
 *
 *   1. **le bandeau d'avertissement apparaît en tête de CHAQUE page** — pas
 *      seulement de la première. Une page imprimée seule, une page transmise
 *      seule, doit se présenter elle-même. C'est aussi pour cela que le
 *      bandeau est écrit en toutes lettres et non abrégé : il est fait pour
 *      être lu par quelqu'un qui n'a pas le reste du document sous les yeux ;
 *   2. **rien n'imite un document officiel** — aucun logo du fournisseur,
 *      aucune mise en page de facture, aucun total calculé, aucune conversion
 *      de devise. Le tableau recopie ce que le service a communiqué, dans
 *      l'ordre où il l'a communiqué.
 *
 * ─── Pourquoi le PDF est écrit ici, et pas rendu par un navigateur ───────────
 *
 * La voie évidente était `page.pdf()` de Playwright sur une page HTML
 * construite localement : Playwright est déjà là, aucune dépendance à
 * ajouter. Elle a été essayée sur le conteneur, le 12/08/2026, et écartée
 * pour une raison précise et vérifiable.
 *
 * Chromium n'écrit pas le texte en clair dans le PDF : il embarque une
 * découpe de police et remplace chaque caractère par son NUMÉRO DE GLYPHE.
 * Le mot « Relevé » sort en `<00350048004F0048005900AB> Tj`. Le bandeau reste
 * lisible à l'écran, mais il est introuvable dans le fichier — y compris
 * après décompression de tous les flux (essai fait : 8 flux décompressés, 0
 * occurrence). Or ce lot exige une vérification LITTÉRALE du bandeau dans le
 * PDF produit. La faire par cette voie demanderait de relire les tables de
 * correspondance de la police embarquée, c'est-à-dire d'écrire un lecteur de
 * PDF — ou d'ajouter une dépendance, ce que le lot interdit.
 *
 * Le PDF est donc écrit directement, en reprenant la technique déjà présente
 * dans `connectors/scraping.js` (`fakePdf`). Trois conséquences, toutes
 * bonnes ici :
 *
 *   - le texte est stocké en clair, donc le bandeau est vérifiable octet par
 *     octet — c'est la preuve que le lot demande, et personne n'a à croire le
 *     module sur parole ;
 *   - aucun navigateur n'est nécessaire : le module tourne dans la suite de
 *     tests (où le scraping est coupé) et sur un déploiement sans Chromium ;
 *   - les flux ne sont pas compressés. Un document dont tout l'intérêt est
 *     d'être vérifiable n'a rien à gagner à être illisible : `strings` suffit
 *     à le contrôler.
 *
 * Les polices sont les polices de base du format PDF (Helvetica, Courier),
 * qu'aucun lecteur n'a besoin de télécharger. Le tableau est en Courier : une
 * chasse fixe aligne les colonnes exactement, sans avoir à mesurer quoi que ce
 * soit, et donne au document l'allure d'un relevé brut — ce qu'il est.
 */

/** Page A4, en points typographiques (1/72 de pouce). */
const PAGE_LARGEUR = 595;
const PAGE_HAUTEUR = 842;
const MARGE = 40;
const LARGEUR_UTILE = PAGE_LARGEUR - 2 * MARGE;

/** Hauteur du cadre d'avertissement, identique sur toutes les pages. */
const BANDEAU_HAUTEUR = 46;
/** Retrait du texte à l'intérieur du cadre. */
const BANDEAU_RETRAIT = 10;

/** Corps du tableau : Courier, dont chaque caractère fait 0,6 cadratin. */
const TABLE_CORPS = 8;
const COURIER_CHASSE = 0.6;
const TABLE_INTERLIGNE = 11;
/** Deux espaces entre deux colonnes : moins, et les valeurs se touchent. */
const COLONNE_ECART = 2;
/** Une colonne ne descend jamais sous cette largeur, même serrée. */
const COLONNE_MIN = 6;

/** Zone réservée au pied de page, sous laquelle rien n'est écrit. */
const PIED_HAUTEUR = 26;
const PIED_CORPS = 7;

/**
 * Les caractères que Windows-1252 place entre 0x80 et 0x9F, là où Latin-1 n'a
 * rien. Sans cette table, le tiret cadratin d'un bandeau écrit en français
 * ressortirait comme un caractère de contrôle — c'est-à-dire, à l'écran, comme
 * un carré vide au milieu de la phrase la plus importante du document.
 */
const WINDOWS_1252 = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86],
  ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
  ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95],
  ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
  ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

/**
 * Un texte quelconque ramené à l'encodage des polices du document.
 *
 * Rend une chaîne dont chaque caractère tient sur un octet : c'est ce qui
 * permet, plus loin, de traiter longueur de chaîne et longueur en octets comme
 * la même chose — dont dépendent la table des positions et la taille déclarée
 * de chaque flux. Un caractère hors du jeu (un idéogramme, un emoji) devient
 * « ? » : le perdre est préférable à un document illisible, et il ne peut
 * venir que d'un libellé de service exotique, jamais d'un montant ou d'une date.
 */
function versWinAnsi(texte) {
  let sortie = '';
  for (const caractere of String(texte ?? '')) {
    const special = WINDOWS_1252.get(caractere);
    if (special !== undefined) sortie += String.fromCharCode(special);
    else if (caractere.codePointAt(0) <= 0xff) sortie += caractere;
    else sortie += '?';
  }
  return sortie;
}

/**
 * Une chaîne prête à être posée entre parenthèses dans un flux PDF.
 *
 * Les trois caractères échappés sont ceux qui refermeraient la chaîne ou
 * mangeraient le suivant. Un identifiant d'opération contenant une parenthèse
 * casserait sinon le document entier, et l'erreur ne se verrait qu'à
 * l'ouverture du fichier.
 */
function echapper(texte) {
  return versWinAnsi(texte).replace(/([\\()])/g, '\\$1');
}

/**
 * La phrase d'avertissement, en toutes lettres.
 *
 * Elle est écrite d'un seul tenant, sur une seule ligne du document, et c'est
 * délibéré : coupée en deux, elle n'apparaîtrait plus telle quelle dans le
 * fichier, et la vérification qui la cherche octet par octet ne prouverait
 * plus rien. C'est aussi ce qui garantit qu'elle se lit d'une traite.
 *
 * L'apostrophe est l'apostrophe simple, pas la courbe : c'est la seule
 * concession typographique du document, et elle rend la phrase entièrement
 * repérable même par un outil qui ne connaîtrait aucun encodage.
 */
function bandeau(service) {
  return `Relevé reconstitué par crabe à partir de l'historique d'opérations `
    + `— ceci n'est pas un document émis par ${service}.`;
}

/** Le titre du cadre, plus court et plus gros : ce qu'on voit avant de lire. */
const BANDEAU_TITRE = 'RELEVÉ RECONSTITUÉ — DOCUMENT PRODUIT PAR CRABE';

/**
 * Une valeur d'opération, telle que le service l'a communiquée.
 *
 * Aucune mise en forme : pas de séparateur de milliers ajouté, pas de date
 * reformatée, pas de booléen traduit. Ce module met en page, il n'interprète
 * pas — un montant recopié autrement que reçu ferait mentir le document sur
 * ce que le service a dit.
 */
function valeurBrute(valeur) {
  if (valeur === null || valeur === undefined) return '';
  if (typeof valeur === 'object') return JSON.stringify(valeur);
  return String(valeur);
}

/**
 * Combien de caractères tiennent sur une ligne du tableau.
 * En Courier, c'est une division exacte : aucune police à mesurer.
 */
function budgetCaracteres(corps = TABLE_CORPS) {
  return Math.floor(LARGEUR_UTILE / (COURIER_CHASSE * corps));
}

/**
 * La largeur de chaque colonne, en caractères.
 *
 * On part du contenu réel — titre compris —, puis on rétrécit les plus larges
 * tant que la ligne déborde. Le rabotage s'arrête à `COLONNE_MIN` : au-delà,
 * une colonne ne montrerait plus rien d'utile, et il vaut mieux que la valeur
 * passe à la ligne (voir `couper`) que de la réduire à trois lettres.
 */
function largeursColonnes(colonnes, operations) {
  const largeurs = colonnes.map((colonne) => {
    let large = String(colonne.titre ?? colonne.cle).length;
    for (const operation of operations) {
      const valeur = valeurBrute(operation[colonne.cle]);
      if (valeur.length > large) large = valeur.length;
    }
    return large;
  });

  const budget = budgetCaracteres() - COLONNE_ECART * (colonnes.length - 1);
  let total = largeurs.reduce((somme, valeur) => somme + valeur, 0);

  while (total > budget) {
    let indice = -1;
    let maximum = COLONNE_MIN;
    largeurs.forEach((largeur, i) => {
      if (largeur > maximum) { maximum = largeur; indice = i; }
    });
    // Toutes les colonnes sont au plancher : on ne rabote plus, les valeurs
    // trop longues passeront à la ligne. Sans cette sortie, la boucle
    // tournerait sans fin sur un tableau à vingt colonnes.
    if (indice < 0) break;
    largeurs[indice] -= 1;
    total -= 1;
  }

  return largeurs;
}

/**
 * Une valeur découpée pour tenir dans sa colonne, sans rien perdre.
 *
 * La coupe cherche d'abord une espace : couper « 2026-08-12T14:03:00Z » au
 * milieu d'un horodatage est illisible, mais couper un libellé entre deux mots
 * se lit encore. À défaut d'espace, la coupe est nette — mieux vaut une valeur
 * sur deux lignes qu'une valeur tronquée, dans un document dont l'unique
 * raison d'être est de dire exactement ce que le service a répondu.
 */
function couper(valeur, largeur) {
  const morceaux = [];
  let reste = valeur;
  while (reste.length > largeur) {
    const fenetre = reste.slice(0, largeur + 1);
    const espace = fenetre.lastIndexOf(' ');
    const coupe = espace > largeur / 2 ? espace : largeur;
    morceaux.push(reste.slice(0, coupe).trimEnd());
    reste = reste.slice(coupe).trimStart();
    if (!reste) break;
  }
  if (reste) morceaux.push(reste);
  return morceaux.length ? morceaux : [''];
}

/** Une cellule complétée à la largeur de sa colonne. */
function caler(texte, largeur) {
  return texte.length >= largeur ? texte.slice(0, largeur) : texte + ' '.repeat(largeur - texte.length);
}

/**
 * Une opération rendue en lignes de texte à chasse fixe.
 * Une opération dont une valeur déborde occupe plusieurs lignes ; elle reste
 * une seule opération, et ne sera jamais coupée par un saut de page.
 */
function lignesOperation(operation, colonnes, largeurs) {
  const cellules = colonnes.map((colonne, i) => couper(valeurBrute(operation[colonne.cle]), largeurs[i]));
  const hauteur = Math.max(...cellules.map((c) => c.length));
  const lignes = [];
  for (let rang = 0; rang < hauteur; rang++) {
    lignes.push(
      cellules.map((cellule, i) => caler(cellule[rang] || '', largeurs[i])).join(' '.repeat(COLONNE_ECART))
    );
  }
  return lignes;
}

/** L'en-tête du tableau, répété en tête de chaque page. */
function ligneEntete(colonnes, largeurs) {
  return colonnes
    .map((colonne, i) => caler(String(colonne.titre ?? colonne.cle), largeurs[i]))
    .join(' '.repeat(COLONNE_ECART));
}

// ---------------------------------------------------------------------------
// Écriture du PDF
// ---------------------------------------------------------------------------

/**
 * Une chaîne de texte pour les MÉTADONNÉES du document (titre, producteur).
 *
 * ⚠ Ce n'est pas le même encodage que le contenu des pages, et les confondre
 * fait un dégât discret : le contenu suit l'encodage déclaré par la police
 * (WinAnsi, posé plus bas), alors qu'une chaîne de métadonnée suit
 * « PDFDocEncoding », qui range tout autre chose entre 0x80 et 0x9F. Écrit
 * comme le reste, le tiret cadratin du titre ressortait en « Š » dans la barre
 * du lecteur — constaté, puis corrigé ici.
 *
 * La parade est celle du format : dès qu'un caractère sort de l'ASCII, la
 * chaîne s'écrit en hexadécimal, en UTF-16 gros-boutien précédé de sa marque
 * d'ordre. Aucun échappement n'est alors nécessaire.
 */
function chaineTexte(valeur) {
  const texteClair = String(valeur);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(texteClair)) return `(${texteClair.replace(/([\\()])/g, '\\$1')})`;
  const octets = ['FEFF'];
  for (const caractere of texteClair) {
    const point = caractere.codePointAt(0);
    if (point > 0xffff) {
      // Hors du plan de base : deux demi-codets, comme le veut UTF-16.
      const reste = point - 0x10000;
      octets.push((0xd800 + (reste >> 10)).toString(16).padStart(4, '0'));
      octets.push((0xdc00 + (reste & 0x3ff)).toString(16).padStart(4, '0'));
    } else {
      octets.push(point.toString(16).padStart(4, '0'));
    }
  }
  return `<${octets.join('').toUpperCase()}>`;
}

/** Un bloc de texte : `BT /police corps Tf x y Td (texte) Tj ET`. */
function texte(police, corps, x, y, contenu) {
  return `BT /${police} ${corps} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${echapper(contenu)}) Tj ET`;
}

/** Un rectangle rempli d'un gris clair et bordé de noir. */
function cadre(x, y, largeur, hauteur) {
  return [
    `q 0.93 0.93 0.93 rg ${x} ${y} ${largeur} ${hauteur} re f Q`,
    `q 0 0 0 RG 0.8 w ${x} ${y} ${largeur} ${hauteur} re S Q`,
  ].join('\n');
}

/** Un filet horizontal de séparation. */
function filet(y) {
  return `q 0.6 0.6 0.6 RG 0.5 w ${MARGE} ${y.toFixed(2)} m ${PAGE_LARGEUR - MARGE} ${y.toFixed(2)} l S Q`;
}

/**
 * Le cadre d'avertissement, dessiné en tête de page.
 *
 * La taille de la phrase est calculée pour qu'elle tienne sur UNE ligne quelle
 * que soit la longueur du nom du service : en chasse fixe, la largeur d'une
 * ligne est un produit, pas une estimation. Elle est bornée à 8 points — au
 * delà elle ne grandirait plus, en dessous de 5,5 elle deviendrait illisible
 * et il vaut mieux qu'elle déborde visiblement que de la laisser disparaître.
 */
function dessinerBandeau(service) {
  const y = PAGE_HAUTEUR - MARGE - BANDEAU_HAUTEUR;
  const phrase = bandeau(service);
  const disponible = LARGEUR_UTILE - 2 * BANDEAU_RETRAIT;
  const corps = Math.max(5.5, Math.min(8, Math.floor((disponible / (COURIER_CHASSE * phrase.length)) * 10) / 10));

  return [
    cadre(MARGE, y, LARGEUR_UTILE, BANDEAU_HAUTEUR),
    texte('FHB', 11, MARGE + BANDEAU_RETRAIT, y + BANDEAU_HAUTEUR - 17, BANDEAU_TITRE),
    texte('FCB', corps, MARGE + BANDEAU_RETRAIT, y + BANDEAU_HAUTEUR - 33, phrase),
  ].join('\n');
}

/** Le pied de page : ce que porte une page détachée du reste. */
function dessinerPied(service, compte, numero, total) {
  const gauche = `Relevé reconstitué par crabe — ${service}${compte ? ` — compte ${compte}` : ''}`;
  const droite = `page ${numero} sur ${total}`;
  const xDroite = PAGE_LARGEUR - MARGE - COURIER_CHASSE * PIED_CORPS * droite.length;
  return [
    filet(MARGE + PIED_HAUTEUR - 6),
    texte('FC', PIED_CORPS, MARGE, MARGE + 6, gauche),
    texte('FC', PIED_CORPS, xDroite, MARGE + 6, droite),
  ].join('\n');
}

/** Le bloc d'identité, en première page seulement. */
function dessinerIdentite(entete, depart) {
  const morceaux = [];
  let y = depart;
  for (const ligne of entete) {
    morceaux.push(texte('FH', 9, MARGE, y, ligne));
    y -= 13;
  }
  return { contenu: morceaux.join('\n'), bas: y };
}

/**
 * Assemble le fichier PDF à partir des flux de pages.
 *
 * Les positions écrites dans la table de références sont des positions en
 * OCTETS depuis le début du fichier. Tout le document étant en Windows-1252,
 * un caractère vaut un octet et la longueur d'une chaîne est sa taille — c'est
 * exactement ce que garantit `versWinAnsi`, et la raison pour laquelle tout y
 * passe avant d'arriver ici.
 */
function assembler(flux, titre) {
  const objets = [];
  const nombrePages = flux.length;

  // 1 : catalogue · 2 : arbre des pages · 3-6 : polices · 7 : informations
  const premierePage = 8;
  const idsPages = flux.map((_, i) => premierePage + i * 2);

  objets[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objets[2] = `<< /Type /Pages /Kids [${idsPages.map((id) => `${id} 0 R`).join(' ')}] /Count ${nombrePages} >>`;
  objets[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objets[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objets[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objets[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  // Le titre du document est ce qu'affiche la barre d'un lecteur de PDF : il
  // dit déjà ce qu'est le fichier, avant même que la page ne s'affiche.
  objets[7] = `<< /Title ${chaineTexte(titre)} /Producer (crabe) /Creator (crabe) >>`;

  flux.forEach((contenu, i) => {
    const idPage = idsPages[i];
    objets[idPage] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_LARGEUR} ${PAGE_HAUTEUR}] `
      + '/Resources << /Font << /FH 3 0 R /FHB 4 0 R /FC 5 0 R /FCB 6 0 R >> >> '
      + `/Contents ${idPage + 1} 0 R >>`;
    const corps = versWinAnsi(contenu);
    objets[idPage + 1] = `<< /Length ${corps.length} >>\nstream\n${corps}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const positions = [];
  for (let i = 1; i < objets.length; i++) {
    positions[i] = pdf.length;
    pdf += `${i} 0 obj\n${objets[i]}\nendobj\n`;
  }

  const positionTable = pdf.length;
  pdf += `xref\n0 ${objets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objets.length; i++) {
    pdf += `${String(positions[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objets.length} /Root 1 0 R /Info 7 0 R >>\n`;
  pdf += `startxref\n${positionTable}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** Une date lisible, ou un tiret quand elle manque. */
function jour(valeur) {
  if (!valeur) return '—';
  if (valeur instanceof Date) return valeur.toISOString().slice(0, 10);
  return String(valeur);
}

/**
 * Construit le relevé.
 *
 * @param {object} options
 * @param {string} options.service      nom du fournisseur, tel qu'il s'affiche
 * @param {string} [options.compte]     identifiant du compte chez ce fournisseur
 * @param {{du?: string|Date, au?: string|Date}} [options.periode] période couverte
 * @param {Date} [options.genereLe]     date de génération — passée par les tests
 *   pour que deux exécutions rendent le même document
 * @param {Array<{cle: string, titre?: string}>} options.colonnes  colonnes du
 *   tableau, dans l'ordre d'affichage
 * @param {object[]} options.operations les opérations, telles que le service
 *   les a rendues
 * @param {string[]} [options.mentions] lignes de contexte ajoutées au bloc
 *   d'identité (origine des données, route interrogée…)
 * @returns {Buffer} le PDF
 */
function construire({
  service,
  compte = null,
  periode = {},
  genereLe = new Date(),
  colonnes,
  operations = [],
  mentions = [],
}) {
  if (!service) throw new Error('Un relevé reconstitué doit nommer le service dont il vient.');
  if (!Array.isArray(colonnes) || !colonnes.length) {
    throw new Error('Un relevé reconstitué doit décrire les colonnes de son tableau.');
  }

  const largeurs = largeursColonnes(colonnes, operations);
  const entete = ligneEntete(colonnes, largeurs);

  const identite = [
    `Service : ${service}`,
    `Compte : ${compte || '(non communiqué par le service)'}`,
    `Période couverte : du ${jour(periode.du)} au ${jour(periode.au)}`,
    `Document généré le : ${genereLe.toISOString().slice(0, 10)} à ${genereLe.toISOString().slice(11, 16)} (UTC)`,
    `Opérations reprises : ${operations.length}`,
    ...mentions,
    'Les valeurs sont recopiées telles que le service les a communiquées : crabe',
    "n'additionne rien, ne convertit aucune devise et ne reformate aucune date.",
  ];

  // ── Répartition en pages ────────────────────────────────────────────────
  // Une opération ne se coupe jamais en deux pages : ses lignes partent
  // ensemble. Une facture retrouvée à cheval, avec la moitié de sa référence
  // en bas d'une page et l'autre en haut de la suivante, ne serait pas
  // opposable à grand-chose.
  const hautDuTableau = (premiere) => {
    const sousBandeau = PAGE_HAUTEUR - MARGE - BANDEAU_HAUTEUR - 22;
    if (!premiere) return sousBandeau;
    return dessinerIdentite(identite, sousBandeau).bas - 8;
  };
  const bas = MARGE + PIED_HAUTEUR;

  const pages = [];
  let courante = [];
  let premiere = true;
  let y = hautDuTableau(true) - TABLE_INTERLIGNE * 2; // en-tête du tableau + filet

  for (const operation of operations) {
    const lignes = lignesOperation(operation, colonnes, largeurs);
    if (y - lignes.length * TABLE_INTERLIGNE < bas && courante.length) {
      pages.push({ premiere, lignes: courante });
      premiere = false;
      courante = [];
      y = hautDuTableau(false) - TABLE_INTERLIGNE * 2;
    }
    courante.push(...lignes);
    y -= lignes.length * TABLE_INTERLIGNE;
  }
  // Une page est écrite même sans aucune opération : un relevé vide reste un
  // document daté qui dit « rien sur cette période », et c'est une réponse.
  pages.push({ premiere, lignes: courante });

  // ── Rendu ───────────────────────────────────────────────────────────────
  const flux = pages.map((page, index) => {
    const morceaux = [dessinerBandeau(service)];
    let curseur = PAGE_HAUTEUR - MARGE - BANDEAU_HAUTEUR - 22;

    if (page.premiere) {
      const bloc = dessinerIdentite(identite, curseur);
      morceaux.push(bloc.contenu);
      curseur = bloc.bas - 8;
    }

    morceaux.push(texte('FCB', TABLE_CORPS, MARGE, curseur, entete));
    morceaux.push(filet(curseur - 4));
    curseur -= TABLE_INTERLIGNE * 2;

    for (const ligne of page.lignes) {
      morceaux.push(texte('FC', TABLE_CORPS, MARGE, curseur, ligne));
      curseur -= TABLE_INTERLIGNE;
    }

    if (!page.lignes.length) {
      morceaux.push(texte('FH', 9, MARGE, curseur, 'Aucune opération sur la période couverte.'));
    }

    morceaux.push(dessinerPied(service, compte, index + 1, pages.length));
    return morceaux.join('\n');
  });

  return assembler(flux, `Relevé reconstitué — ${service}`);
}

/**
 * Le nom de fichier d'un relevé, sous la forme des autres documents de crabe.
 *
 * Le mot « releve-reconstitue » y figure : le document se reconnaît dans une
 * liste de fichiers, avant même d'être ouvert. Et les bornes manquantes
 * deviennent « debut » ou « fin » plutôt que le tiret cadratin du document —
 * un nom de fichier se retape à la main, il n'a rien à faire avec de la
 * ponctuation typographique.
 */
function nomFichier({ service, du, au }) {
  const propre = (valeur) => String(valeur).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const borne = (valeur, defaut) => (valeur ? propre(jour(valeur)) : defaut);
  return `${propre(service)}_releve-reconstitue_${borne(du, 'debut')}_${borne(au, 'fin')}.pdf`;
}

/**
 * Répartit des opérations en relevés MENSUELS, et n'en garde que les mois
 * RÉVOLUS.
 *
 * ─── Le problème que ça résout ───────────────────────────────────────────────
 *
 * Un relevé reconstitué n'est pas une facture : rien, chez le fournisseur, ne
 * dit où il commence ni où il finit. Il faut donc que crabe choisisse une
 * découpe, et qu'il s'y tienne — sans quoi deux exécutions du même connecteur
 * produisent deux documents qui se recouvrent, portant les mêmes opérations
 * sous deux noms différents.
 *
 * La découpe retenue est le MOIS CIVIL. C'est celle des factures d'abonnement
 * que crabe range par ailleurs, elle est prévisible, et elle donne un
 * identifiant naturellement stable : « 2026-07 » désignera toujours le même
 * mois.
 *
 * ⚠ Le mois EN COURS est écarté, et c'est la décision importante. Un relevé de
 * juillet produit le 12 juillet serait incomplet ; comme son identifiant serait
 * déjà connu, il ne serait jamais regénéré, et les opérations du 13 au 31
 * juillet n'apparaîtraient dans AUCUN document — définitivement. Attendre la
 * fin du mois coûte quelques semaines de latence ; ne pas l'attendre coûte des
 * opérations perdues sans que personne ne le voie.
 *
 * Les bornes sont calculées en UTC, comme les fenêtres d'historique
 * (connectors/history.js) : un mois qui change de valeur selon le fuseau du
 * serveur produirait des relevés différents sur deux installations.
 *
 * @param {object[]} operations
 * @param {(operation: object) => string|null|undefined} dateDe la date ISO
 *   (`AAAA-MM-JJ…`) d'une opération ; une opération sans date est écartée, elle
 *   ne peut être rangée dans aucun mois
 * @param {Date|number} [maintenant] instant de référence
 * @returns {Array<{mois: string, du: string, au: string, operations: object[]}>}
 *   du plus ancien au plus récent
 */
function parMoisRevolus(operations, dateDe, maintenant = new Date()) {
  const reference = maintenant instanceof Date ? maintenant : new Date(maintenant);
  const moisCourant = `${reference.getUTCFullYear()}-${String(reference.getUTCMonth() + 1).padStart(2, '0')}`;

  const groupes = new Map();
  for (const operation of Array.isArray(operations) ? operations : []) {
    const iso = String(dateDe(operation) ?? '');
    const mois = /^(\d{4}-\d{2})/.exec(iso)?.[1];
    // Sans date, l'opération n'appartient à aucun mois. La ranger « au hasard »
    // la ferait apparaître dans un relevé qui prétend couvrir une période
    // qu'elle ne concerne pas : on la laisse dehors, et l'appelant le dit.
    if (!mois) continue;
    // `>=` et non `===` : une opération datée du futur (horloge du fournisseur
    // en avance, ordre programmé) appartient à un mois qui n'est pas révolu.
    if (mois >= moisCourant) continue;
    if (!groupes.has(mois)) groupes.set(mois, []);
    groupes.get(mois).push(operation);
  }

  return [...groupes.keys()].sort().map((mois) => {
    const [annee, numero] = mois.split('-').map(Number);
    // Le 0e jour du mois suivant EST le dernier jour de ce mois-ci : pas de
    // table de longueurs à tenir, et février bissextile tombe juste tout seul.
    const dernier = new Date(Date.UTC(annee, numero, 0)).getUTCDate();
    return {
      mois,
      du: `${mois}-01`,
      au: `${mois}-${String(dernier).padStart(2, '0')}`,
      operations: groupes.get(mois),
    };
  });
}

module.exports = {
  construire,
  bandeau,
  nomFichier,
  parMoisRevolus,
  versWinAnsi,
  // Exportés pour les tests : ce sont les décisions de mise en page qu'on veut
  // pouvoir vérifier sans ouvrir un lecteur de PDF.
  largeursColonnes,
  lignesOperation,
  couper,
  budgetCaracteres,
  BANDEAU_TITRE,
};
