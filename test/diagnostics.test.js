'use strict';

/**
 * §4 du lot 14 — le diagnostic, et surtout ce qu'il ne contient PAS.
 *
 * « Il vaut mieux livrer ça seul et correct que sept correctifs supposés. »
 * Le contrôle qui compte le plus ici n'est donc pas qu'on écrive quatre
 * fichiers : c'est qu'aucun mot de passe, aucune valeur de cookie et aucun
 * jeton n'y entre jamais. Une archive qu'il faudrait relire ligne à ligne
 * avant de la transmettre ne serait pas transmise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Le dossier de diagnostic est lu dans la configuration au moment de l'appel :
// on le détourne AVANT de charger le module.
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), 'crabe-diag-'));
process.env.CRABE_DIAGNOSTICS_DIR = RACINE;

const diagnostics = require('../server/diagnostics');

test.after(() => fs.rmSync(RACINE, { recursive: true, force: true }));

/** Une fausse page Playwright : du HTML, des liens, une URL. */
function pageSimulee({ html = '<html></html>', liens = [], url = 'https://boutique.fr/x' } = {}) {
  return {
    url: () => url,
    content: async () => html,
    evaluate: async () => liens,
    screenshot: async ({ path: fichier }) => fs.writeFileSync(fichier, 'PNG-simulé'),
    context: () => contexteSimule(),
  };
}

function contexteSimule(cookies = []) {
  return { cookies: async () => cookies };
}

// ---------------------------------------------------------------------------
// Le masquage — le contrôle le plus important du fichier
// ---------------------------------------------------------------------------

test('un champ de mot de passe perd sa valeur, jamais sa présence', () => {
  const masque = diagnostics.masquer(
    '<form><input type="password" name="passwd" value="Tr0ub4dor&3"></form>'
  );

  assert.doesNotMatch(masque, /Tr0ub4dor/, 'le mot de passe ne doit plus être là');
  assert.match(masque, /type="password"/, 'la structure du formulaire reste lisible');
  assert.match(masque, /value="\[masqué\]"/);
});

test('les jetons cachés sont masqués, quel que soit leur nom', () => {
  const masque = diagnostics.masquer(
    '<input type="hidden" name="token" value="7f3a91cc">'
    + '<input type="hidden" name="_csrf_token" value="deadbeef">'
    + '<input type="hidden" id="authenticity_nonce" value="cafe1234">'
    // Un champ anodin, lui, reste intact : c'est souvent lui qui explique tout.
    + '<input type="hidden" name="back" value="history">'
  );

  assert.doesNotMatch(masque, /7f3a91cc|deadbeef|cafe1234/);
  assert.match(masque, /value="history"/, 'un champ sans secret garde sa valeur');
});

test('un secret posé dans un JSON en ligne est masqué aussi', () => {
  const masque = diagnostics.masquer(
    '<script>var cfg = {"api_key":"sk-abc123","csrf_token":"zz99","shop":"fantazia"};</script>'
  );

  assert.doesNotMatch(masque, /sk-abc123|zz99/);
  assert.match(masque, /"shop":"fantazia"/, 'le reste de la configuration reste lisible');
});

test('un `document.cookie` posé en ligne ne fuit pas', () => {
  const masque = diagnostics.masquer(
    '<script>document.cookie = "PHPSESSID=abcdef123456; path=/";</script>'
  );
  assert.doesNotMatch(masque, /abcdef123456/);
});

test('seuls les NOMS des cookies sortent, jamais leurs valeurs', () => {
  const noms = diagnostics.nomsDeCookies([
    { name: 'PHPSESSID', value: 'abcdef123456', domain: 'boutique.fr' },
    { name: 'PrestaShop-1a2b', value: 'secret-de-session' },
    { name: '', value: 'anonyme' },
  ]);

  assert.deepEqual(noms, ['PHPSESSID', 'PrestaShop-1a2b']);
  assert.doesNotMatch(noms.join(' '), /abcdef|secret/);
});

// ---------------------------------------------------------------------------
// L'enregistrement
// ---------------------------------------------------------------------------

test('un échec produit les quatre fichiers, et aucun secret dedans', async () => {
  const page = pageSimulee({
    url: 'https://propolia.com/fr/connexion?back=history',
    html: '<html><body><form>'
      + '<input type="email" name="email" value="camille@example.fr">'
      + '<input type="password" name="passwd" value="MonMotDePasse!42">'
      + '<input type="hidden" name="token" value="7f3a91cc">'
      + '</form></body></html>',
    liens: ['https://propolia.com/fr/historique-commandes', 'https://propolia.com/fr/contact'],
  });
  page.context = () =>
    contexteSimule([
      { name: 'PHPSESSID', value: 'ultra-secret' },
      { name: 'didomi_token', value: 'aussi-secret' },
    ]);

  const resultat = await diagnostics.enregistrer({
    connectorId: 'propolia',
    page,
    context: page.context(),
    etape: 'connexion non confirmée',
    erreur: 'aucun marqueur de compte',
  });

  assert.equal(resultat.ok, true);
  for (const attendu of diagnostics.FICHIERS) {
    assert.ok(resultat.fichiers.includes(attendu), `${attendu} doit avoir été écrit`);
  }

  const lu = (nom) => fs.readFileSync(path.join(resultat.dossier, nom), 'utf8');

  // contexte.txt : l'URL, l'étape, l'erreur, les NOMS des cookies.
  const contexte = lu('contexte.txt');
  assert.match(contexte, /propolia\.com\/fr\/connexion/);
  assert.match(contexte, /connexion non confirmée/);
  assert.match(contexte, /aucun marqueur de compte/);
  assert.match(contexte, /PHPSESSID/);
  assert.doesNotMatch(contexte, /ultra-secret|aussi-secret/);

  // page.html : masqué.
  const html = lu('page.html');
  assert.doesNotMatch(html, /MonMotDePasse|7f3a91cc/);
  assert.match(html, /camille@example\.fr/, 'l\'identifiant reste : ce n\'est pas un secret, et il diagnostique');

  // liens.txt : un lien par ligne.
  assert.deepEqual(lu('liens.txt').trim().split('\n'), [
    'https://propolia.com/fr/historique-commandes',
    'https://propolia.com/fr/contact',
  ]);
});

test('un identifiant de connecteur douteux n\'écrit rien', async () => {
  for (const id of ['../etc', 'Propolia/../..', '', null, 'a'.repeat(80)]) {
    const resultat = await diagnostics.enregistrer({ connectorId: id, etape: 'x' });
    assert.equal(resultat.ok, false, String(id));
    assert.equal(resultat.dossier, null);
  }
});

test('une page morte ne fait pas échouer le diagnostic — le contexte suffit', async () => {
  const morte = {
    url: () => {
      throw new Error('page closed');
    },
    content: async () => {
      throw new Error('page closed');
    },
    evaluate: async () => {
      throw new Error('page closed');
    },
    screenshot: async () => {
      throw new Error('page closed');
    },
  };

  const resultat = await diagnostics.enregistrer({
    connectorId: 'coco-papaya',
    page: morte,
    etape: 'connexion',
    erreur: 'navigateur fermé',
  });

  assert.equal(resultat.ok, true, 'un diagnostic partiel vaut mieux qu\'aucun');
  assert.deepEqual(resultat.fichiers, ['contexte.txt']);
  assert.match(
    fs.readFileSync(path.join(resultat.dossier, 'contexte.txt'), 'utf8'),
    /URL finale   : \(inconnue\)/
  );
});

// ---------------------------------------------------------------------------
// Lecture et purge
// ---------------------------------------------------------------------------

test('les diagnostics se listent du plus récent au plus ancien', async () => {
  for (let i = 0; i < 3; i++) {
    await diagnostics.enregistrer({ connectorId: 'kubii', page: pageSimulee(), etape: `essai ${i}` });
    // Les dossiers sont horodatés à la milliseconde : sans cette pause, deux
    // écritures d'affilée pourraient partager un nom.
    await new Promise((r) => setTimeout(r, 3));
  }

  const liste = diagnostics.lister('kubii');
  assert.equal(liste.length, 3);
  assert.ok(liste[0].id > liste[1].id, 'le plus récent d\'abord');
  assert.ok(liste[0].at, 'l\'horodatage doit se relire');
  assert.ok(liste[0].octets > 0);
});

test('la purge ne garde que 20 diagnostics par connecteur', async () => {
  const base = new Date('2026-08-11T03:00:00.000Z').getTime();
  for (let i = 0; i < 25; i++) {
    const nom = diagnostics.horodatage(new Date(base + i * 1000));
    const dossier = path.join(RACINE, 'aagaard', nom);
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, 'contexte.txt'), 'x');
  }

  assert.equal(diagnostics.lister('aagaard').length, 25);
  const efface = diagnostics.purger('aagaard', { maintenant: base + 60_000 });

  assert.equal(efface, 5);
  assert.equal(diagnostics.lister('aagaard').length, diagnostics.MAX_PAR_CONNECTEUR);
});

test('la purge efface ce qui dépasse trente jours, même en petit nombre', () => {
  const vieux = new Date('2026-06-01T03:00:00.000Z');
  const dossier = path.join(RACINE, 'ile-aux-epices', diagnostics.horodatage(vieux));
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'contexte.txt'), 'x');

  const efface = diagnostics.purger('ile-aux-epices', {
    maintenant: new Date('2026-08-11T03:00:00.000Z').getTime(),
  });

  assert.equal(efface, 1);
  assert.equal(diagnostics.lister('ile-aux-epices').length, 0);
});

test('le chemin d\'un diagnostic est reconstruit, jamais repris de la requête', () => {
  assert.equal(diagnostics.chemin('kubii', '../../etc/passwd'), null);
  assert.equal(diagnostics.chemin('../etc', '2026-08-11T03-07-16-482Z'), null);
  assert.equal(diagnostics.chemin('kubii', 'nimporte-quoi'), null);

  const existant = diagnostics.lister('kubii')[0];
  assert.ok(diagnostics.chemin('kubii', existant.id), 'un identifiant réel doit répondre');
});
