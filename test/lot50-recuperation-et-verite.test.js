'use strict';

/**
 * Lot 50 — Boulanger récupère, Vistaprint sait où regarder, Darty dit la
 * vérité.
 *
 * Trois choses sont protégées ici :
 *
 *   1. `clic-document` : le document qu'un clic déclenche se lit quelle que
 *      soit la voie (téléchargement, nouvel onglet, réponse PDF de la page) —
 *      c'est le piège du `<bl-button>` de Boulanger, élément personnalisé dont
 *      rien ne dit ce que le clic fait ;
 *   2. Boulanger : la récupération s'ancre sur le NUMÉRO DE COMMANDE lu sur la
 *      page (idempotence, lot 46 — jamais une empreinte du PDF), une facture
 *      « disponible à la délivrance » n'est PAS une panne et la récupération
 *      continue, une commande déjà déposée n'est même pas cliquée ;
 *   3. le message du renvoi vers l'authentification ne MENT plus : profil
 *      présent mais site qui éconduit (le cas Darty du 23/08/2026, session
 *      capturée à 09:40:23 et refoulée à 09:41:16) n'est plus confondu avec
 *      « connexion expirée ou jamais ouverte » — on ne dit plus « cliquez Se
 *      connecter » à quelqu'un qui vient de le faire.
 *
 * Toutes les valeurs (numéros de commande, dates, adresses) sont INVENTÉES :
 * elles ont la forme du réel sans en être (§0ter).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const clicDocument = require('../server/connectors/clic-document');
const profilMarchand = require('../server/connectors/profil-marchand');
const boulanger = require('../server/connectors/available/boulanger/connector');
const vistaprint = require('../server/connectors/available/vistaprint/connector');
const darty = require('../server/connectors/available/darty/connector');

// ---------------------------------------------------------------------------
// Fabriques : page, contexte, documents
// ---------------------------------------------------------------------------

const PDF_FACTICE = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');

/** Un fichier PDF (ou non) posé dans un dossier jetable, pour `download.path()`. */
function fichierTemporaire(contenu) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lot50-'));
  const chemin = path.join(dossier, 'document.bin');
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

/**
 * Une page simulée pour `clic-document` et pour le connecteur Boulanger.
 *
 * `evaluate` est discriminé sur la FORME de l'argument — exactement les
 * signatures que le code réel envoie : `photographier` ({motif, selecteur}),
 * `chercherMarqueursMesures` ({sel, motif}), `lireCommandes`
 * ({selOrder, motifNumero, …}), `cliquerBoutonFacture` ({selOrder, cible}).
 */
function pageSimulee(vue, { surClic = null, surClicBoite = null } = {}) {
  const gestionnaires = {};
  const page = {
    clics: [],
    clicsBoite: [],
    url: () => vue.url,
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: (ev, cb) => {
      const liste = gestionnaires[ev] || [];
      const i = liste.indexOf(cb);
      if (i >= 0) liste.splice(i, 1);
    },
    emettre: (ev, arg) => { for (const cb of [...(gestionnaires[ev] || [])]) cb(arg); },
    waitForTimeout: async () => { await new Promise((r) => { setImmediate(r); }); },
    waitForLoadState: async () => {},
    locator: (selecteur) => ({
      count: async () =>
        ((vue.selecteursPresents || []).some((s) => selecteur.includes(s)) ? 1 : 0),
    }),
    evaluate: async (fn, arg) => {
      if (typeof arg === 'string' && arg === boulanger.SELECTEUR_BOITE_FACTURES) {
        return (vue.boite || []).length > 0;
      }
      if (arg && typeof arg === 'object') {
        if ('selOrder' in arg && 'cible' in arg) {
          const commande = (vue.commandes || [])[arg.cible];
          if (!commande || !commande.boutonFacture) return false;
          page.clics.push(arg.cible);
          if (surClic) surClic(arg.cible);
          return true;
        }
        if ('selBoite' in arg && 'cible' in arg) {
          if (!(vue.boite || [])[arg.cible]) return false;
          page.clicsBoite.push(arg.cible);
          if (surClicBoite) surClicBoite(arg.cible);
          return true;
        }
        if ('selBoite' in arg && 'motifReference' in arg) return vue.boite || [];
        if ('selOrder' in arg && 'motifNumero' in arg) return vue.commandes || [];
        if ('sel' in arg && 'motif' in arg) {
          return (vue.selecteursPresents || []).some((s) => String(arg.sel || '').includes(s));
        }
      }
      return vue;
    },
  };
  return page;
}

/** Un contexte simulé : il sait juste annoncer un nouvel onglet. */
function contexteSimule() {
  const gestionnaires = {};
  return {
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: (ev, cb) => {
      const liste = gestionnaires[ev] || [];
      const i = liste.indexOf(cb);
      if (i >= 0) liste.splice(i, 1);
    },
    emettre: (ev, arg) => { for (const cb of [...(gestionnaires[ev] || [])]) cb(arg); },
  };
}

/** Une réponse réseau simulée. */
function reponseSimulee({ type = 'application/pdf', corps = PDF_FACTICE } = {}) {
  return {
    headerValue: async () => type,
    body: async () => corps,
    url: () => 'https://exemple.test/document.pdf',
  };
}

/** Un onglet simulé, tel que `lireDocumentDeLOnglet` le consomme. */
function ongletSimule() {
  const gestionnaires = {};
  return {
    ferme: false,
    on: (ev, cb) => { (gestionnaires[ev] = gestionnaires[ev] || []).push(cb); },
    off: () => {},
    emettre: (ev, arg) => { for (const cb of [...(gestionnaires[ev] || [])]) cb(arg); },
    waitForLoadState: async () => {},
    url: () => 'https://exemple.test/document.pdf',
    close: async function fermer() { this.ferme = true; },
  };
}

/** Remplace l'ouverture du profil par la page simulée, le temps d'un appel. */
async function surProfilSimule(page, corps) {
  const original = profilMarchand.surLeProfil;
  profilMarchand.surLeProfil = async (options, fn) => fn(page, contexteSimule());
  try {
    return await corps();
  } finally {
    profilMarchand.surLeProfil = original;
  }
}

// ---------------------------------------------------------------------------
// 1. clic-document : les trois voies, et le renoncement qui se dit
// ---------------------------------------------------------------------------

test('clic-document : un événement « download » sert le PDF — voie téléchargement direct', async () => {
  const page = pageSimulee({});
  const contexte = contexteSimule();
  const chemin = fichierTemporaire(PDF_FACTICE);
  const resultat = await clicDocument.documentDuClic(page, contexte, async () => {
    page.emettre('download', { path: async () => chemin, failure: async () => null });
    return true;
  });
  assert.equal(resultat.ok, true);
  assert.equal(resultat.voie, 'téléchargement direct');
  assert.deepEqual(resultat.buffer, PDF_FACTICE);
});

test('clic-document : un téléchargement qui échoue rend son grief, jamais un faux document', async () => {
  const page = pageSimulee({});
  const resultat = await clicDocument.documentDuClic(page, contexteSimule(), async () => {
    page.emettre('download', {
      path: async () => null,
      failure: async () => 'interrompu par le site',
    });
    return true;
  });
  assert.equal(resultat.ok, false);
  assert.match(resultat.grief, /n'a pas abouti/);
  assert.match(resultat.grief, /interrompu par le site/);
});

test('clic-document : un fichier téléchargé qui n\'est pas un PDF est refusé et mesuré', async () => {
  const page = pageSimulee({});
  const chemin = fichierTemporaire(Buffer.from('<html>une page d\'erreur</html>'));
  const resultat = await clicDocument.documentDuClic(page, contexteSimule(), async () => {
    page.emettre('download', { path: async () => chemin, failure: async () => null });
    return true;
  });
  assert.equal(resultat.ok, false);
  assert.match(resultat.grief, /pas un PDF/);
  assert.match(resultat.grief, /\d+ octets/, 'le grief mesure ce qui a été reçu');
});

test('clic-document : un nouvel onglet qui sert un PDF — voie onglet, refermé derrière soi', async () => {
  const page = pageSimulee({});
  const contexte = contexteSimule();
  const onglet = ongletSimule();
  const resultat = await clicDocument.documentDuClic(page, contexte, async () => {
    contexte.emettre('page', onglet);
    onglet.emettre('response', reponseSimulee());
    return true;
  });
  assert.equal(resultat.ok, true);
  assert.equal(resultat.voie, 'nouvel onglet');
  assert.deepEqual(resultat.buffer, PDF_FACTICE);
  assert.equal(onglet.ferme, true, 'la pile d\'onglets n\'appartient pas à la suite (lot 40)');
});

test('clic-document : une réponse PDF sur la page elle-même — voie réponse de page', async () => {
  const page = pageSimulee({});
  const resultat = await clicDocument.documentDuClic(page, contexteSimule(), async () => {
    page.emettre('response', reponseSimulee());
    return true;
  });
  assert.equal(resultat.ok, true);
  assert.equal(resultat.voie, 'réponse PDF de la page');
});

test('clic-document : les réponses qui ne sont pas des PDF sont ignorées, pas prises pour le document', async () => {
  const page = pageSimulee({});
  const resultat = await clicDocument.documentDuClic(page, contexteSimule(), async () => {
    page.emettre('response', reponseSimulee({ type: 'text/html', corps: Buffer.from('<html>') }));
    return true;
  }, { delaiMs: 60 });
  assert.equal(resultat.ok, false);
  assert.match(resultat.grief, /ni téléchargement, ni nouvel onglet, ni réponse PDF/);
});

test('clic-document : un clic sans effet renonce en le disant, dans le délai', async () => {
  const page = pageSimulee({});
  const resultat = await clicDocument.documentDuClic(
    page, contexteSimule(), async () => true, { delaiMs: 60 }
  );
  assert.equal(resultat.ok, false);
  assert.match(resultat.grief, /ni téléchargement, ni nouvel onglet, ni réponse PDF/);
});

test('clic-document : l\'« autre issue » rend la main sans épuiser le délai — la boîte de choix de Boulanger', async () => {
  // Mesuré le 23/08/2026 : le clic ouvre une boîte de choix au lieu de servir
  // un document. Sans `autreIssue`, le connecteur attendait 30 s devant une
  // boîte déjà ouverte avant de renoncer à tort.
  const page = pageSimulee({});
  const debut = Date.now();
  const resultat = await clicDocument.documentDuClic(
    page, contexteSimule(), async () => true,
    { autreIssue: async () => true, delaiMs: 30_000 }
  );
  assert.equal(resultat.ok, false);
  assert.equal(resultat.autreIssue, true);
  assert.ok(Date.now() - debut < 5_000, 'la main est rendue tout de suite, pas au bout du délai');
});

test('clic-document : un déclencheur disparu se dit comme tel, sans attendre', async () => {
  const resultat = await clicDocument.documentDuClic(
    pageSimulee({}), contexteSimule(), async () => false
  );
  assert.equal(resultat.ok, false);
  assert.match(resultat.grief, /déclencheur n'était plus dans la page/);
});

// ---------------------------------------------------------------------------
// 2. Boulanger récupère — ancré sur le numéro de commande lu sur la page
// ---------------------------------------------------------------------------

/** Trois commandes INVENTÉES, à la forme du réel : une facture disponible,
 *  une « à la délivrance », une déjà déposée. */
function vueBoulanger() {
  return {
    url: boulanger.URL_COMMANDES,
    boutonSeConnecter: false,
    reperes: 3,
    libelles: [],
    selecteursPresents: ['.order'],
    commandes: [
      {
        numero: 'F240001234',
        texte: 'N° F240001234 Commande du 12 juillet 2026 Livrée',
        boutonFacture: true,
        factureAVenir: false,
      },
      {
        numero: 'F240005678',
        texte: 'N° F240005678 Commande du 20 août 2026 — Votre facture sera '
          + 'disponible à la délivrance de votre commande',
        boutonFacture: false,
        factureAVenir: true,
      },
      {
        numero: 'F240009999',
        texte: 'N° F240009999 Commande du 3 août 2026 Livrée',
        boutonFacture: true,
        factureAVenir: false,
      },
    ],
  };
}

function contexteEnregistreur(extra = {}) {
  const journal = [];
  const preuves = [];
  return {
    ctx: {
      userId: 1,
      log: (m) => journal.push(String(m)),
      preuveDeListe: (info) => preuves.push(info),
      ...extra,
    },
    journal,
    preuves,
  };
}

test('Boulanger récupère : le remote_id est le numéro de commande, la date vient de la page', async () => {
  const { ctx, journal, preuves } = contexteEnregistreur({
    knownRemoteIds: ['boulanger-F240009999'],
  });
  const page = pageSimulee(vueBoulanger(), {
    surClic: () => {
      page.emettre('download', {
        path: async () => fichierTemporaire(PDF_FACTICE),
        failure: async () => null,
      });
    },
  });
  const resultat = await surProfilSimule(page, () => boulanger.fetchInvoices({}, ctx));

  assert.equal(preuves.length, 1, 'la preuve de liste reste obligatoire (lot 31)');
  assert.equal(preuves[0].elements, 3);

  assert.equal(resultat.invoices.length, 1,
    'une facture disponible, une à venir, une déjà déposée : UNE seule descend');
  const facture = resultat.invoices[0];
  assert.equal(facture.remoteId, 'boulanger-F240001234',
    'l\'ancre est le numéro lu sur la page, jamais une empreinte du PDF (lot 46)');
  assert.equal(facture.issuedOn, '2026-07-12', 'la date de commande lue sur la page');
  assert.equal(facture.filename, 'boulanger_2026-07_F240001234.pdf');
  assert.deepEqual(facture.buffer, PDF_FACTICE);

  assert.deepEqual(page.clics, [0],
    'la commande déjà déposée n\'est pas cliquée, celle sans facture non plus');

  const lignes = journal.join('\n');
  assert.match(lignes, /disponible à la délivrance de votre commande/,
    'la facture pas encore émise se dit dans les mots du site');
  assert.match(lignes, /Ce n'est\s+pas une panne/,
    'et se dit comme un fait, jamais comme une panne');
  assert.match(lignes, /voie mesurée/,
    'la voie que le clic a prise est MESURÉE et journalisée, pas supposée');
  assert.match(lignes, /1 facture\(s\) récupérée\(s\) sur 3 commande\(s\)/);
});

test('Boulanger, second passage : rien ne redescend, rien n\'est même cliqué — l\'idempotence par le numéro', async () => {
  const { ctx, preuves } = contexteEnregistreur({
    knownRemoteIds: ['boulanger-F240001234', 'boulanger-F240005678', 'boulanger-F240009999'],
  });
  const page = pageSimulee(vueBoulanger());
  const resultat = await surProfilSimule(page, () => boulanger.fetchInvoices({}, ctx));
  assert.equal(resultat.invoices.length, 0);
  assert.deepEqual(page.clics, [], 'le site regénérerait le document pour rien');
  assert.equal(preuves.length, 1, 'le zéro-document reste prouvé par la liste');
});

test('Boulanger : une facture illisible ne casse pas les autres — le grief au journal, la suite continue', async () => {
  const vue = vueBoulanger();
  const { ctx, journal } = contexteEnregistreur();
  let clics = 0;
  const page = pageSimulee(vue, {
    surClic: () => {
      clics += 1;
      // Le premier clic ne déclenche RIEN (le grief du délai) ; le second
      // sert son PDF.
      if (clics === 2) {
        page.emettre('download', {
          path: async () => fichierTemporaire(PDF_FACTICE),
          failure: async () => null,
        });
      }
    },
  });
  // Le délai court n'est pas une option du connecteur : on l'abaisse ici pour
  // que le premier clic renonce vite.
  const original = clicDocument.documentDuClic;
  clicDocument.documentDuClic = (page_, ctx_, clic) =>
    original(page_, ctx_, clic, { delaiMs: 60 });
  try {
    const resultat = await surProfilSimule(page, () => boulanger.fetchInvoices({}, ctx));
    assert.equal(resultat.invoices.length, 1, 'la seconde commande à facture est servie');
    assert.equal(resultat.invoices[0].remoteId, 'boulanger-F240009999');
  } finally {
    clicDocument.documentDuClic = original;
  }
  assert.match(journal.join('\n'), /n'a pas été lue .*On continue avec les suivantes/,
    'l\'échec d\'une commande est un grief journalisé, pas un arrêt');
});

test('Boulanger : une commande à PLUSIEURS factures — la boîte de choix, chaque entrée ancrée sur son couple', async () => {
  // Mesuré le 23/08/2026 : sur certaines commandes, le bouton ouvre une
  // <section class="popin--container"> listant les factures (« Facture N°… »),
  // chacune sur son propre bl-button.
  const vue = {
    url: boulanger.URL_COMMANDES,
    boutonSeConnecter: false,
    reperes: 1,
    libelles: [],
    selecteursPresents: ['.order'],
    commandes: [{
      numero: 'F001AB23456',
      texte: 'N° F001AB23456 Commande du 5 juin 2026 Livrée',
      boutonFacture: true,
      factureAVenir: false,
    }],
    boite: [{ rang: 0, reference: '101' }, { rang: 1, reference: '102' }],
  };
  const { ctx, journal } = contexteEnregistreur();
  const page = pageSimulee(vue, {
    // Le clic de la commande n'émet RIEN : c'est la boîte qui s'ouvre.
    surClicBoite: () => {
      page.emettre('download', {
        path: async () => fichierTemporaire(PDF_FACTICE),
        failure: async () => null,
      });
    },
  });
  const resultat = await surProfilSimule(page, () => boulanger.fetchInvoices({}, ctx));
  assert.deepEqual(resultat.invoices.map((i) => i.remoteId),
    ['boulanger-F001AB23456-101', 'boulanger-F001AB23456-102'],
    'chaque facture est ancrée sur le couple (commande, référence de facture)');
  assert.equal(resultat.invoices[0].filename, 'boulanger_2026-06_F001AB23456-101.pdf');
  assert.deepEqual(page.clics, [0]);
  assert.deepEqual(page.clicsBoite, [0, 1]);
  assert.match(journal.join('\n'), /boîte de\s+choix \(mesuré\) : 2 facture\(s\) listée\(s\)/);
});

test('Boulanger, boîte de choix au second passage : les entrées connues ne sont pas recliquées', async () => {
  const vue = {
    url: boulanger.URL_COMMANDES,
    boutonSeConnecter: false,
    reperes: 1,
    libelles: [],
    selecteursPresents: ['.order'],
    commandes: [{
      numero: 'F001AB23456',
      texte: 'N° F001AB23456 Commande du 5 juin 2026 Livrée',
      boutonFacture: true,
      factureAVenir: false,
    }],
    boite: [{ rang: 0, reference: '101' }, { rang: 1, reference: '102' }],
  };
  const { ctx } = contexteEnregistreur({
    knownRemoteIds: ['boulanger-F001AB23456-101', 'boulanger-F001AB23456-102'],
  });
  const page = pageSimulee(vue);
  const resultat = await surProfilSimule(page, () => boulanger.fetchInvoices({}, ctx));
  assert.equal(resultat.invoices.length, 0);
  assert.deepEqual(page.clics, [0],
    'ouvrir la boîte est le seul moyen d\'énumérer : ce clic-là reste nécessaire');
  assert.deepEqual(page.clicsBoite, [], 'aucune facture connue n\'est retéléchargée');
});

test('Boulanger : le remote_id et le motif du numéro tiennent la forme relevée', () => {
  assert.equal(boulanger.remoteIdPour('f240001234'), 'boulanger-F240001234',
    'la casse est normalisée : F minuscule et majuscule sont la même commande');
  assert.match('N° F240001234', boulanger.MOTIF_REPERE);
  assert.ok(boulanger.MOTIF_NUMERO.test('F240001234'));
  assert.ok(boulanger.MOTIF_NUMERO.test('F001AB23456'),
    'mesuré le 23/08/2026 : certains numéros portent deux lettres au milieu '
    + '(formes F###ML#####, F###CX#####) — le motif chiffres-seuls en perdait deux sur cinq');
  assert.equal(boulanger.MOTIF_NUMERO.test('F12'), false,
    'trois chiffres ne font pas un numéro de commande');
  assert.match('Télécharger la facture de la commande numéro F240001234',
    boulanger.MOTIF_BOUTON_FACTURE);
  assert.match('Votre facture sera disponible à la délivrance de votre commande',
    boulanger.MOTIF_FACTURE_A_VENIR);
});

// ---------------------------------------------------------------------------
// 3. Le message du renvoi ne ment plus (Darty, et tout profil marchand)
// ---------------------------------------------------------------------------

test('un renvoi qui persiste, PROFIL PRÉSENT, ne dit plus « jamais ouverte » — et ne renvoie pas l\'utilisateur en boucle', async () => {
  // atteindreLaPage n'est appelée qu'une fois le profil vérifié par
  // surLeProfil : le renvoi y est toujours un renvoi MALGRÉ session.
  const page = pageSimulee({ url: 'https://exemple.test/login' });
  page.goto = async () => {};
  page.evaluate = async () => false; // ni mur, ni bandeau
  await assert.rejects(
    () => profilMarchand.atteindreLaPage(page, {
      id: 'exemple',
      nom: 'Exemple',
      log: () => {},
      urlDepart: 'https://exemple.test/my-account',
    }),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.doesNotMatch(err.message, /jamais été ouverte/,
        'le 23/08/2026, ce texte s\'affichait à quelqu\'un qui venait de se connecter');
      assert.match(err.message, /bien enregistrée/,
        'le message reconnaît le geste que l\'utilisateur a fait');
      assert.match(err.message, /venez de l'ouvrir, inutile de recommencer/,
        'et il coupe la boucle « reconnectez-vous » → « reconnectez-vous »');
      assert.match(err.precision, /redirection vers https:\/\/exemple\.test\/login/);
      return true;
    }
  );
});

test('profil ABSENT : l\'ancien message reste le bon — la connexion n\'a réellement jamais été ouverte', async () => {
  await assert.rejects(
    () => profilMarchand.surLeProfil(
      { id: 'lot50-jamais-connecte', nom: 'Exemple', ctx: { userId: 424242 }, urlDepart: 'https://x' },
      async () => {}
    ),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /a expiré ou n'a jamais été ouverte/);
      assert.match(err.message, /Se connecter/);
      return true;
    }
  );
});

test('Darty renvoyé vers l\'authentification : le connecteur produit le message honnête', async () => {
  const page = pageSimulee({
    url: 'https://www.darty.com/authentification/login?goto=x',
    boutonSeConnecter: false,
    reperes: 0,
    libelles: [],
    fausseMaintenance: false,
  });
  // Le contrôle de fausse maintenance de Darty passe une CHAÎNE (le motif) :
  // la page simulée de ce fichier ne le reconnaît pas d'elle-même.
  const evaluate = page.evaluate;
  page.evaluate = async (fn, arg) =>
    (arg === darty.MOTIF_FAUSSE_MAINTENANCE.source ? false : evaluate(fn, arg));
  await assert.rejects(
    () => surProfilSimule(page, () => darty.fetchInvoices({}, { userId: 1, log: () => {} })),
    (err) => {
      assert.equal(err.sessionExpired, true);
      assert.doesNotMatch(err.message, /jamais été ouverte/);
      assert.match(err.message, /bien enregistrée/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Vistaprint regarde la bonne page, et compte sur le repère relevé
// ---------------------------------------------------------------------------

test('Vistaprint vise /oh/ — plus /mon-compte, qui ne contient aucune commande', () => {
  assert.equal(vistaprint.URL_COMMANDES, 'https://www.vistaprint.fr/oh/');
  assert.ok(vistaprint.CHEMIN_LISTE.test('https://www.vistaprint.fr/oh/'));
  assert.ok(vistaprint.CHEMIN_LISTE.test('https://www.vistaprint.fr/oh?page=2'));
  assert.equal(vistaprint.CHEMIN_LISTE.test('https://www.vistaprint.fr/mon-compte'), false,
    'c\'était l\'erreur des lots 47-49 : 0 repère sur une session valide');
  assert.equal(vistaprint.CHEMIN_LISTE.test('https://www.vistaprint.fr/ohlala'), false,
    'le chemin est /oh, pas tout ce qui commence par oh');
});

test('Vistaprint compte sur le lien de détail relevé, et sa preuve vit dans la page', () => {
  assert.equal(vistaprint.SELECTEUR_REPERE, 'a[href*="/od?orderId="]',
    'le repère le plus sûr : chaque ligne porte son lien, l\'identifiant est dans l\'adresse');
  assert.deepEqual(vistaprint.MARQUEURS_MESURES, [
    { selecteur: '[data-testid="order-history-application"]' },
    { selecteur: 'a[href*="/od?orderId="]' },
  ], 'les marqueurs relevés sur le vrai compte — absents de la page anonyme (sondé le 23/08/2026)');
});

test('Vistaprint sur /oh/ : le comptage tient, la preuve est déposée — le parcours vit au lot 51', async () => {
  const { ctx, journal, preuves } = contexteEnregistreur();
  const page = pageSimulee({
    url: vistaprint.URL_COMMANDES,
    boutonSeConnecter: false,
    reperes: 4,
    libelles: [],
    selecteursPresents: ['order-history-application'],
  });
  // Le parcours des documents est écrit depuis le lot 51 (tests dans
  // lot51-vistaprint-recupere.test.js) : ici, seule la lecture de la liste est
  // simulée — aucun lien de détail, donc aucun document, et ça se DIT.
  const evaluate = page.evaluate;
  page.evaluate = async (fn, arg) =>
    (arg === vistaprint.SELECTEUR_REPERE ? [] : evaluate(fn, arg));
  const resultat = await surProfilSimule(page, () => vistaprint.fetchInvoices({}, ctx));
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].elements, 4, 'le connecteur comptait 0 sur /mon-compte — il compte ici');
  assert.deepEqual(resultat.invoices, []);
  assert.equal(resultat.aucunDocument, undefined,
    'le parcours est écrit : un zéro-document n\'est plus l\'aveu d\'une ébauche');
  assert.match(journal.join('\n'), /0 commande\(s\) lue\(s\) sur l'historique/);
});
