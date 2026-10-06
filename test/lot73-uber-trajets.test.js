'use strict';

/**
 * Lot 73 (remesuré au 73-bis) — Uber : le parcours des TRAJETS.
 *
 * La session Uber enregistrée a été remesurée le 09/09/2026 : riders.uber.com/
 * trips rend chaque trajet en CARTE, dont l'identifiant se lit sur le lien
 * d'aide `?jobId=<uuid>` (un seul trajet a un lien direct `/trips/<uuid>` — le
 * piège qui avait fait compter « 1 trajet »). La liste est PAGINÉE : un bouton
 * « Plus » charge la page suivante en remplaçant le DOM ; on déroule tout en
 * cumulant les jobId (27 trajets distincts mesurés). Le détail porte la date et
 * un bouton « Télécharger » qui sert un vrai PDF. Uber Eats renvoie vers
 * auth.uber.com (session non couverte) ; Location n'a aucune liste sur ce
 * compte. Ces tests figent : l'ancre d'idempotence sur l'uuid du trajet (jamais
 * l'empreinte du PDF), le déroulé COMPLET de la pagination, le dépôt d'un reçu
 * par trajet, le second passage à zéro, le journal « N courses vues, N reçus »,
 * et le journal honnête d'Uber Eats et de Location.
 *
 * ⚠ Aucune donnée réelle : uuids, dates et octets sont INVENTÉS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const profilMarchand = require('../server/connectors/profil-marchand');
const clicDocument = require('../server/connectors/clic-document');
const uber = require('../server/connectors/available/uber/connector');

// ---------------------------------------------------------------------------
// Unités pures
// ---------------------------------------------------------------------------

test('remoteIdTrajet ancre sur l\'uuid du trajet, jamais sur l\'empreinte du PDF', () => {
  assert.equal(uber.remoteIdTrajet('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    'uber-trajet-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('lireTrajets déroule la pagination « Plus » et cumule les jobId dédoublonnés', async () => {
  // Trois pages qui REMPLACENT le DOM (comme la vraie liste), avec un jobId en
  // commun entre deux pages : le déroulé complet doit tout voir, sans doublon.
  const page = fakePage({ pages: [['u1', 'u2'], ['u2', 'u3'], ['u4']] });
  assert.deepEqual(await uber.lireTrajets(page), ['u1', 'u2', 'u3', 'u4']);
});

test('lireTrajets s\'arrête quand « Plus » disparaît (une seule page)', async () => {
  const page = fakePage({ pages: [['u1', 'u2']] });
  assert.deepEqual(await uber.lireTrajets(page), ['u1', 'u2']);
});

// ---------------------------------------------------------------------------
// Parcours complet, avec profil et clic simulés
// ---------------------------------------------------------------------------

/**
 * Une page qui modélise la liste PAGINÉE des trajets. `pages` est une suite
 * d'écrans (chacun une liste de jobId), qui se REMPLACENT à chaque « Plus »,
 * comme la vraie page. `trips` reste un raccourci pour un écran unique.
 */
function fakePage({ pages = null, trips = [], detailTexte = 'Trajet du 14 août 2025', eatsVersAuth = true }) {
  const ecrans = pages || [trips];
  let cur = 0;
  let url = uber.TRAJETS_URL;
  return {
    url: () => url,
    goto: async (u) => {
      if (String(u).startsWith('https://www.ubereats.com')) {
        url = eatsVersAuth ? 'https://auth.uber.com/v2/?next_url=x' : String(u);
      } else {
        url = String(u);
      }
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      // jobIdsVisibles : le sélecteur des liens d'aide → les jobId de l'écran courant.
      if (typeof arg === 'string' && arg.includes('help-with-a-trip')) return ecrans[cur] || [];
      // cliquerPlus : le motif du bouton « Plus » → avance d'un écran, ou false.
      if (typeof arg === 'string' && /plus|more/i.test(arg)) {
        if (cur < ecrans.length - 1) { cur++; return true; }
        return false;
      }
      // lecture du texte de détail (aucun argument).
      if (arg === undefined) return detailTexte;
      return null;
    },
    locator: () => ({ count: async () => 0, first: () => ({ count: async () => 0 }) }),
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

/**
 * Joue `fetchInvoices` en simulant le profil, le jugement de liste, la
 * navigation de détail et le téléchargement. Rend le nombre de clics de
 * téléchargement pour prouver l'idempotence (un trajet connu n'est pas recliqué).
 */
async function fetchSimule(page, config, ctx, { reperes = 1 } = {}) {
  const orig = {
    surLeProfil: profilMarchand.surLeProfil,
    jugerLaListe: profilMarchand.jugerLaListe,
    atteindreLaPage: profilMarchand.atteindreLaPage,
    documentDuClic: clicDocument.documentDuClic,
  };
  let clics = 0;
  profilMarchand.surLeProfil = async (options, fn) => fn(page, {});
  profilMarchand.jugerLaListe = async () => ({
    vue: { url: page.url(), reperes, libelles: [] },
    etat: { servie: true, reperes, raison: 'l\'adresse des trajets a tenu' },
  });
  profilMarchand.atteindreLaPage = async (p, { urlDepart }) => { await p.goto(urlDepart); };
  clicDocument.documentDuClic = async () => {
    clics++;
    return { ok: true, buffer: Buffer.from('%PDF-1.4 faux reçu'), voie: 'téléchargement' };
  };
  try {
    const resultat = await uber.fetchInvoices(config, ctx);
    return { resultat, clics };
  } finally {
    Object.assign(profilMarchand, {
      surLeProfil: orig.surLeProfil,
      jugerLaListe: orig.jugerLaListe,
      atteindreLaPage: orig.atteindreLaPage,
    });
    clicDocument.documentDuClic = orig.documentDuClic;
  }
}

test('trajets : un reçu par trajet, ancré sur l\'uuid, la preuve de liste déposée', async () => {
  const { ctx, journal, preuves } = contexteEnregistreur();
  const page = fakePage({ trips: ['u1', 'u2'] });
  const { resultat, clics } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets'] }, ctx, { reperes: 2 });

  assert.equal(resultat.invoices.length, 2);
  assert.deepEqual(resultat.invoices.map((i) => i.remoteId), ['uber-trajet-u1', 'uber-trajet-u2']);
  assert.ok(resultat.invoices.every((i) => Buffer.isBuffer(i.buffer) && i.buffer.length > 0));
  assert.ok(resultat.invoices.every((i) => i.issuedOn === '2025-08-14'), 'issued_on lu sur le détail');
  assert.equal(clics, 2, 'un téléchargement par trajet');
  assert.equal(preuves.length, 1);
  assert.equal(preuves[0].liste, uber.TRAJETS_URL);
  assert.match(journal.join('\n'), /2 course\(s\) vue\(s\), 2 reçu\(s\) récupéré/);
});

test('trajets : la liste PAGINÉE est déroulée en entier, un reçu par trajet de toutes les pages', async () => {
  const { ctx, journal } = contexteEnregistreur();
  const page = fakePage({ pages: [['u1', 'u2'], ['u3', 'u4'], ['u5']] });
  const { resultat, clics } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets'] }, ctx, { reperes: 5 });

  assert.deepEqual(resultat.invoices.map((i) => i.remoteId),
    ['uber-trajet-u1', 'uber-trajet-u2', 'uber-trajet-u3', 'uber-trajet-u4', 'uber-trajet-u5']);
  assert.equal(clics, 5, 'un téléchargement par trajet, toutes pages confondues');
  assert.match(journal.join('\n'), /5 course\(s\) vue\(s\), 5 reçu\(s\) récupéré/);
});

test('trajets : idempotence — un trajet déjà déposé n\'est ni rouvert ni recliqué', async () => {
  const { ctx, journal } = contexteEnregistreur({ knownRemoteIds: ['uber-trajet-u1'] });
  const page = fakePage({ trips: ['u1', 'u2'] });
  const { resultat, clics } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets'] }, ctx, { reperes: 2 });

  assert.deepEqual(resultat.invoices.map((i) => i.remoteId), ['uber-trajet-u2']);
  assert.equal(clics, 1, 'seul le trajet inconnu est cliqué');
  assert.match(journal.join('\n'), /1 trajet\(s\) déjà déposé/);
});

test('trajets : tous connus — second passage à zéro ligne, aucun clic', async () => {
  const { ctx } = contexteEnregistreur({ knownRemoteIds: ['uber-trajet-u1', 'uber-trajet-u2'] });
  const page = fakePage({ trips: ['u1', 'u2'] });
  const { resultat, clics } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets'] }, ctx, { reperes: 2 });

  assert.deepEqual(resultat.invoices, []);
  assert.equal(clics, 0, 'rien n\'est retéléchargé au second passage');
});

test('Uber Eats : renvoyé vers la connexion Uber, journalisé « ne couvre pas Uber Eats » — jamais une panne', async () => {
  const { ctx, journal } = contexteEnregistreur();
  const page = fakePage({ trips: ['u1'], eatsVersAuth: true });
  const { resultat } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets', 'eats'] }, ctx);

  // Trajets récupéré, Eats journalisé sans faire échouer la récupération.
  assert.equal(resultat.invoices.length, 1);
  assert.match(journal.join('\n'), /Uber Eats renvoie vers la connexion Uber/);
  assert.match(journal.join('\n'), /ne couvre pas Uber Eats/);
});

test('Location : aucune liste relevée, journalisé, aucune adresse inventée', async () => {
  const { ctx, journal } = contexteEnregistreur();
  const page = fakePage({ trips: ['u1'] });
  const { resultat } = await fetchSimule(page, { [uber.CHAMP_SERVICES]: ['trajets', 'location'] }, ctx);

  assert.equal(resultat.invoices.length, 1);
  const lignes = journal.join('\n');
  assert.match(lignes, /Location — aucune liste de locations/);
  assert.match(lignes, /aucune adresse de liste n'est inventée/);
});
