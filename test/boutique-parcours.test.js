'use strict';

/**
 * Le parcours COMPLET d'une boutique, joué contre un vrai navigateur.
 *
 * ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * Les lots 11 et 12 ont livré neuf boutiques dont la suite de tests était au
 * vert et dont **aucune ne rapportait de facture en production**. Les tests
 * unitaires vérifiaient des expressions régulières ; ils ne pouvaient rien dire
 * de la chaîne réelle — connexion, bandeau, relevé des liens, téléchargement.
 *
 * Ce fichier-ci monte donc une **fausse boutique PrestaShop** sur la boucle
 * locale et y envoie le connecteur avec un Chromium réel. Rien n'est simulé
 * côté connecteur : c'est le code de production qui se connecte, ferme le
 * bandeau, relève les liens et télécharge les PDF.
 *
 * ─── Ce que la fausse boutique reproduit, et pourquoi ────────────────────────
 *
 *   - **un bandeau de cookies qui recouvre le formulaire**, dans ses deux
 *     moments d'apparition : au chargement, et — le cas de Propolia — à la
 *     première frappe dans le formulaire, donc APRÈS le passage préventif ;
 *   - **des liens parasites dont le TEXTE dit « Facture »** : widget d'avis
 *     clients et article de blog. Ce sont eux qui doivent être écartés, et le
 *     tri ne peut donc pas porter sur le libellé ;
 *   - **un PDF servi en `application/octet-stream`** — le cas d'Apiculture.net,
 *     qui serait perdu si on se fiait à l'en-tête ;
 *   - **une page de commandes qui renvoie à l'authentification** sans cookie,
 *     pour que « la connexion a réussi » ne puisse pas être confondu avec « les
 *     commandes sont atteignables ».
 *
 * ─── Si ce fichier est ignoré ────────────────────────────────────────────────
 *
 * Playwright est une dépendance FACULTATIVE, et son Chromium pèse 500 Mo. Sur
 * une machine qui ne les a pas, les tests de ce fichier sont sautés — avec une
 * ligne qui le dit. Ils ne sont jamais silencieusement absents.
 */

require('./helpers');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const prestashop = require('../server/connectors/available/prestashop/connector');
const cookieBanner = require('../server/connectors/obstructions');

// ---------------------------------------------------------------------------
// Playwright est-il utilisable ici ?
// ---------------------------------------------------------------------------

/** @returns {object|null} le module, ou null si la dépendance manque */
function playwrightOuNull() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

const PLAYWRIGHT = playwrightOuNull();
const SANS_NAVIGATEUR = {
  skip: PLAYWRIGHT
    ? false
    : 'Playwright n\'est pas installé sur cette machine : le parcours complet '
      + 'n\'est pas joué. Installez-le avec « npm install playwright && npx playwright '
      + 'install chromium » pour couvrir cette chaîne.',
};

// ---------------------------------------------------------------------------
// La fausse boutique
// ---------------------------------------------------------------------------

const IDENTIFIANTS = { email: 'camille@exemple.fr', motDePasse: 'Mot2Passe!Correct' };

/** Un PDF minimal mais authentique : la signature est ce qui compte. */
function pdfFactice(numero) {
  return Buffer.from(
    `%PDF-1.4\n% facture de la commande ${numero}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`,
    'latin1'
  );
}

/**
 * Quatre formes d'obstruction, pour quatre issues distinctes.
 *
 * `didomi` se ferme par son identifiant, `maison` par son libellé, `inconnue`
 * n'offre aucun bouton d'acceptation — elle ne cède qu'au contournement forcé,
 * la cinquième étape — et `tenace` se remet en place dès qu'on la retire :
 * c'est la seule qui doit produire un message honnête plutôt qu'une accusation
 * de mot de passe.
 */
const BOUTONS_REGIE = {
  didomi: '<button id="didomi-notice-agree-button">Accepter &amp; Fermer</button>',
  maison: '<button class="cookies-oui">TOUT ACCEPTER</button>',
  inconnue: '<button class="cookies-non">Gérer mes choix</button>',
  tenace: '<button class="cookies-non">Gérer mes choix</button>',
};

/**
 * La page de connexion.
 *
 * ─── Deux moments d'apparition, et pourquoi ils sont tous les deux nécessaires
 *
 *   - `chargement` — le bandeau est là dès l'arrivée sur la page. C'est le cas
 *     simple, celui que la fermeture préventive couvre ;
 *   - `apres-saisie` — le bandeau n'apparaît qu'à la PREMIÈRE FRAPPE dans le
 *     formulaire, donc APRÈS le passage préventif. C'est le cas de Propolia,
 *     et c'est celui qui manquait : jusqu'au lot 13, le clic partait dans le
 *     vide pendant quarante-cinq secondes puis crabe accusait le mot de passe.
 *
 * Le second est déclenché par un ÉVÉNEMENT et non par un minuteur : un
 * `setTimeout` ferait dépendre le test de la vitesse de la machine, et un test
 * qui passe une fois sur deux ne prouve rien.
 *
 * @param {{regie: string, moment: string, erreur?: string}} options
 */
function pageConnexion({ regie, moment, erreur = '' }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Boutique — Connexion</title>
<style>
  #didomi-host{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);
               display:flex;align-items:center;justify-content:center;}
  #didomi-popup{background:#fff;padding:24px;border-radius:8px;}
  form{margin:80px auto;width:320px;}
  input,button{display:block;width:100%;margin:8px 0;padding:10px;font-size:15px;}
</style></head>
<body>
  <h1>Mon compte</h1>
  ${erreur ? `<div class="alert-danger">${erreur}</div>` : ''}
  <form method="POST" action="/fr/connexion">
    <input type="email" id="email" name="email" placeholder="Adresse e-mail">
    <input type="password" id="passwd" name="password" placeholder="Mot de passe">
    <button type="submit" id="submit-login" name="submitLogin">Se connecter</button>
  </form>
<script>
  function poserLeBandeau() {
    if (document.getElementById('didomi-host')) return;
    var hote = document.createElement('div');
    hote.id = 'didomi-host';
    hote.className = 'didomi-host';
    hote.innerHTML = '<div id="didomi-popup" class="didomi-popup-backdrop didomi-notice-popup">'
      + '<p>Nous utilisons des cookies.</p>'
      + ${JSON.stringify(BOUTONS_REGIE)}[${JSON.stringify(regie)}]
      + '</div>';
    document.body.appendChild(hote);
    var bouton = hote.querySelector('button');
    // La régie « inconnue » n'offre AUCUN bouton qui ferme : son seul bouton
    // ouvre un second écran. C'est le cas qu'on ne sait pas traiter, et qu'il
    // faut savoir dire.
    if (bouton && !bouton.classList.contains('cookies-non')) {
      bouton.addEventListener('click', function () { hote.remove(); });
    }
  }

  if (${JSON.stringify(moment)} === 'chargement') {
    poserLeBandeau();
  } else {
    // La régie s'éveille à la première interaction — après le passage
    // préventif du connecteur, et avant son clic. Déterministe.
    document.getElementById('email').addEventListener('input', poserLeBandeau, { once: true });
  }

  // La régie « tenace » se remet en place dès qu'on la retire du DOM. C'est
  // ce que font certaines régies, et c'est la seule façon de rendre le
  // contournement forcé inopérant — donc la seule façon de continuer à
  // couvrir le chemin « aucune étape n'a abouti ».
  if (${JSON.stringify(regie)} === 'tenace') {
    new MutationObserver(function () {
      if (!document.getElementById('didomi-host')) poserLeBandeau();
    }).observe(document.body, { childList: true });
  }
</script>
</body></html>`;
}

/** Les trois commandes de la fausse boutique, telles qu'elles s'affichent. */
const COMMANDES = [
  { numero: '4021', reference: 'ABCDEFGHI', date: '11/07/2026', montant: '25,50 €' },
  { numero: '3980', reference: 'JKLMNOPQR', date: '03/06/2026', montant: '1 249,00 €' },
  { numero: '3712', reference: 'STUVWXYZA', date: '19/12/2025', montant: '8,90 €' },
];

/** L'adresse d'une facture, dans l'un ou l'autre des deux schémas validés. */
function lienFacture(schema, numero) {
  return schema === 'module'
    ? `/modules/eggsodoo/pdf-invoice.php?id_order=${numero}`
    : `/index.php?controller=pdf-invoice&amp;id_order=${numero}`;
}

/**
 * La page des commandes.
 *
 * Une boutique n'emploie qu'UN schéma — six sur sept le standard, Apiculture.net
 * le sien. La page est donc générée dans un seul schéma à la fois, comme dans la
 * réalité, et les deux sont joués tour à tour.
 *
 * S'y ajoutent trois liens **parasites** dont le texte dit « Facture » sans en
 * être une : c'est le piège que le tri sur l'URL doit éviter, et il est ici avec
 * les mêmes mots que sur les vraies boutiques.
 */
function pageCommandes(schema) {
  const lignes = COMMANDES.map(
    (c) => `    <tr class="order">
      <td>${c.reference}</td><td>${c.date}</td><td>${c.montant}</td>
      <td><a href="${lienFacture(schema, c.numero)}">Facture</a></td>
    </tr>`
  ).join('\n');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Historique de commandes</title></head>
<body>
  <!--
    L'en-tête d'un compte OUVERT, tel que le sert un vrai PrestaShop : c'est le
    lien de déconnexion qui prouve la connexion (lot 14, §1.2a). Sans lui, la
    fausse boutique était plus permissive que les vraies — elle acceptait une
    « connexion » qu'aucun marqueur ne confirmait, exactement le trou par
    lequel Propolia, Kubii et L'Île aux Épices passaient en production.
  -->
  <header id="header">
    <a href="/index.php?controller=my-account">Mon compte</a>
    <a href="/index.php?mylogout=">Déconnexion</a>
  </header>

  <h1>Historique de mes commandes</h1>

  <table><tbody>
${lignes}
  </tbody></table>

  <!-- Les parasites. Leur LIBELLÉ parle de facture ; leur adresse, non. -->
  <aside class="avis-clients">
    <a href="https://avis.exemple.fr/widget?boutique=demo">Voir les avis · Facture rapide</a>
    <a href="/blog/comment-lire-sa-facture">Comment lire sa facture ?</a>
    <a href="/contact?sujet=facture">Une question sur votre facture ?</a>
  </aside>
</body></html>`;
}

/**
 * Monte la fausse boutique et renvoie de quoi la joindre et l'observer.
 *
 * `agents` retient l'agent utilisateur de chaque requête reçue : c'est la
 * preuve de bout en bout du §6, et elle ne peut pas être obtenue autrement
 * qu'en regardant ce qui arrive vraiment côté serveur.
 */
async function ouvrirBoutique({
  regie = 'didomi',
  moment = 'apres-saisie',
  schema = 'standard',
  motDePasseAttendu = IDENTIFIANTS.motDePasse,
} = {}) {
  const agents = [];
  const vues = [];

  const serveur = http.createServer((req, res) => {
    agents.push(String(req.headers['user-agent'] || ''));
    vues.push(`${req.method} ${req.url}`);

    const url = new URL(req.url, 'http://127.0.0.1');
    const connecte = /(^|;\s*)boutique_session=ouverte(;|$)/.test(req.headers.cookie || '');

    // --- connexion ---------------------------------------------------------
    if (url.pathname === '/fr/connexion' && req.method === 'POST') {
      let corps = '';
      req.on('data', (c) => { corps += c; });
      req.on('end', () => {
        const recu = new URLSearchParams(corps);
        const bon = recu.get('email') === IDENTIFIANTS.email
          && recu.get('password') === motDePasseAttendu;

        if (!bon) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(pageConnexion({
            regie, moment, erreur: 'Échec d\'authentification',
          }));
        }
        res.writeHead(302, {
          'set-cookie': 'boutique_session=ouverte; Path=/',
          location: '/fr/historique-commandes',
        });
        res.end();
      });
      return;
    }

    if (url.pathname === '/fr/connexion') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageConnexion({ regie, moment }));
    }

    // --- commandes ---------------------------------------------------------
    if (url.pathname === '/fr/historique-commandes') {
      // Sans session, la boutique renvoie à l'authentification : c'est le cas
      // que §5.a demande de distinguer d'une connexion réussie.
      if (!connecte) {
        res.writeHead(302, { location: '/fr/connexion' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageCommandes(schema));
    }

    // --- factures ----------------------------------------------------------
    const numero = url.searchParams.get('id_order');
    const estFacture = url.pathname === '/index.php'
      ? url.searchParams.get('controller') === 'pdf-invoice'
      : /\/modules\/[^/]+\/pdf-invoice\.php$/.test(url.pathname);

    if (estFacture && numero) {
      if (!connecte) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('interdit');
      }
      // La commande 3712 est celle d'Apiculture.net : PDF parfaitement valide,
      // servi sous un type qui ne l'annonce pas.
      res.writeHead(200, {
        'content-type': numero === '3712' ? 'application/octet-stream' : 'application/pdf',
      });
      return res.end(pdfFactice(numero));
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('rien ici');
  });

  await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = serveur.address().port;
  const racine = `http://127.0.0.1:${port}`;

  return {
    racine,
    agents,
    vues,
    manifest: {
      id: 'boutique-de-test',
      name: 'Boutique de test',
      urls: {
        login: `${racine}/fr/connexion`,
        orders: `${racine}/fr/historique-commandes`,
      },
    },
    fermer: () => new Promise((resolve) => serveur.close(resolve)),
  };
}

/** Un `ctx` de connecteur qui retient ses lignes de journal. */
function journal() {
  const lignes = [];
  return {
    lignes,
    ctx: (manifest) => ({ manifest, log: (m) => lignes.push(String(m)) }),
    contient: (motif) => lignes.some((l) => motif.test(l)),
    texte: () => lignes.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// §5 — la chaîne complète, de la connexion au PDF
// ---------------------------------------------------------------------------

test(
  'le parcours complet aboutit : bandeau fermé, liens triés, PDF téléchargés',
  SANS_NAVIGATEUR,
  async () => {
    const boutique = await ouvrirBoutique();
    const j = journal();

    try {
      const resultat = await prestashop.fetchInvoices(
        { ...IDENTIFIANTS, historique: 'tout' },
        j.ctx(boutique.manifest)
      );

      // --- b. les liens de facture sont trouvés ----------------------------
      assert.equal(
        resultat.invoices.length,
        3,
        `3 factures attendues, ${resultat.invoices.length} obtenues.\n${j.texte()}`
      );

      // --- c. les faux positifs sont écartés -------------------------------
      // Les trois parasites parlent tous de « facture » dans leur libellé.
      // Aucun ne doit avoir été téléchargé, ni même tenté.
      assert.ok(
        !boutique.vues.some((v) => /\/blog\/|\/contact|avis\.exemple\.fr/.test(v)),
        `un lien parasite a été suivi :\n${boutique.vues.join('\n')}`
      );

      const numeros = resultat.invoices.map((i) => i.remoteId).sort();
      assert.deepEqual(numeros, ['commande-3712', 'commande-3980', 'commande-4021']);

      // --- d. le téléchargement aboutit, et le contenu fait foi ------------
      for (const facture of resultat.invoices) {
        assert.equal(
          facture.buffer.subarray(0, 5).toString('latin1'),
          '%PDF-',
          `${facture.remoteId} : le contenu doit commencer par %PDF-`
        );
      }

      // La commande servie en « application/octet-stream » (le cas
      // d'Apiculture.net) est bien passée : se fier à l'en-tête l'aurait perdue.
      assert.ok(numeros.includes('commande-3712'), 'le PDF en octet-stream doit passer');

      // Dates, montants et noms de fichier lus AUTOUR du lien, sans déborder
      // sur la commande voisine.
      const juillet = resultat.invoices.find((i) => i.remoteId === 'commande-4021');
      assert.equal(juillet.issuedOn, '2026-07-11');
      assert.equal(juillet.amount, '25,50 EUR');
      // Le nom porte la RÉFÉRENCE lisible, pas l'`id_order` de l'URL (§3.2d).
      assert.equal(juillet.filename, '2026-07_ABCDEFGHI.pdf');

      // Le montant à quatre chiffres est lu en entier — le séparateur de
      // milliers avait déjà coûté une facture de « 2026 euros » au lot 12.
      const juin = resultat.invoices.find((i) => i.remoteId === 'commande-3980');
      assert.equal(juin.amount, '1249,00 EUR');
      assert.equal(juin.issuedOn, '2026-06-03');

      // --- a. chaque étape est journalisée ---------------------------------
      assert.ok(
        j.contient(/connexion confirmée/i),
        `« connexion confirmée » attendu — et la preuve avec :\n${j.texte()}`
      );
      assert.ok(j.contient(/page des commandes atteinte/i), j.texte());
      assert.ok(
        j.contient(/3 commande\(s\) détectée\(s\), 3 lien\(s\) de facture reconnu\(s\)/),
        `commandes ET liens doivent être comptés séparément :\n${j.texte()}`
      );
      assert.ok(
        j.contient(/3 document\(s\) téléchargé\(s\) sur 3 lien/),
        `le nombre de documents téléchargés doit être dit :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

test(
  'le schéma module d\'Apiculture.net rapporte lui aussi ses trois factures',
  SANS_NAVIGATEUR,
  async () => {
    // Une boutique n'emploie qu'un schéma. Celui-ci — `modules/<module>/
    // pdf-invoice.php` — n'est utilisé que par Apiculture.net, et c'est
    // précisément pour ça qu'il est le plus facile à casser sans s'en
    // apercevoir : il n'a qu'une boutique pour le signaler.
    const boutique = await ouvrirBoutique({ schema: 'module', moment: 'chargement' });
    const j = journal();

    try {
      const resultat = await prestashop.fetchInvoices(
        { ...IDENTIFIANTS, historique: 'tout' },
        j.ctx(boutique.manifest)
      );

      assert.equal(resultat.invoices.length, 3, j.texte());
      assert.ok(j.contient(/schéma « module »/), j.texte());
      for (const facture of resultat.invoices) {
        assert.equal(facture.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
      }
    } finally {
      await boutique.fermer();
    }
  }
);

// ---------------------------------------------------------------------------
// §1 — le bandeau de cookies, dans ses trois issues
// ---------------------------------------------------------------------------

test(
  'un bandeau posé après le chargement est fermé, et la connexion aboutit',
  SANS_NAVIGATEUR,
  async () => {
    // 250 ms : le bandeau n'existe PAS quand le connecteur regarde la page la
    // première fois. C'est le cas de Propolia, et celui qu'aucune fermeture
    // préventive seule ne peut couvrir.
    const boutique = await ouvrirBoutique({ regie: 'didomi', moment: 'apres-saisie' });
    const j = journal();

    try {
      const resultat = await prestashop.test(
        { ...IDENTIFIANTS },
        j.ctx(boutique.manifest)
      );
      assert.equal(resultat.ok, true, j.texte());
      assert.equal(resultat.invoiceCount, 3, j.texte());
      assert.ok(
        j.contient(/obstruction levée à l'étape/i),
        `la levée de l'obstruction doit être tracée, avec son étape :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

test(
  'un bandeau sans identifiant connu est fermé par son libellé',
  SANS_NAVIGATEUR,
  async () => {
    // « TOUT ACCEPTER », en capitales et sans identifiant reconnaissable : ce
    // sont les régies maison, majoritaires sur les petites boutiques.
    const boutique = await ouvrirBoutique({ regie: 'maison', moment: 'chargement' });
    const j = journal();

    try {
      const resultat = await prestashop.test({ ...IDENTIFIANTS }, j.ctx(boutique.manifest));
      assert.equal(resultat.ok, true, j.texte());
      assert.ok(
        j.contient(/obstruction levée à l'étape « libellé d'acceptation »/i),
        `l'étape qui a réussi doit être nommée :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

/**
 * §5.2, cinquième étape — le contournement forcé.
 *
 * Une fenêtre sans bouton d'acceptation ni croix : ni les régies connues, ni
 * les libellés, ni les boutons de fermeture, ni Échap n'en viennent à bout. Le
 * lot 13 s'arrêtait là et refusait la connexion. Le lot 14 retire l'élément du
 * DOM — et le DIT, mot pour mot, parce que c'est fragile.
 */
test(
  'une fenêtre sans bouton cède au contournement forcé, qui est journalisé',
  SANS_NAVIGATEUR,
  async () => {
    const boutique = await ouvrirBoutique({ regie: 'inconnue', moment: 'apres-saisie' });
    const j = journal();

    try {
      const resultat = await prestashop.test({ ...IDENTIFIANTS }, j.ctx(boutique.manifest));

      assert.equal(resultat.ok, true, `la connexion doit aboutir :\n${j.texte()}`);
      assert.ok(
        j.contient(/contournement forcé/),
        `le contournement doit être dit MOT POUR MOT — c'est ce qu'on cherchera `
          + `dans le journal pour repérer les connecteurs fragiles :\n${j.texte()}`
      );
      // Et l'obstacle reste décrit, pour pouvoir lui donner un vrai motif.
      assert.ok(j.contient(/didomi-host/), j.texte());
    } finally {
      await boutique.fermer();
    }
  }
);

test(
  'un bandeau impossible à fermer ne fait PAS accuser le mot de passe',
  SANS_NAVIGATEUR,
  async () => {
    // Une régie qu'on ne sait pas fermer, et qui se remet en place dès qu'on
    // la retire : les cinq étapes échouent. C'est le cas où le lot 12
    // affichait « Vérifiez votre adresse électronique et votre mot de passe »
    // — un mensonge, sur des identifiants parfaitement corrects.
    const boutique = await ouvrirBoutique({ regie: 'tenace', moment: 'apres-saisie' });
    const j = journal();

    try {
      await assert.rejects(
        () => prestashop.test({ ...IDENTIFIANTS }, j.ctx(boutique.manifest)),
        (err) => {
          assert.match(err.message, /Une fenêtre du site empêche la connexion/i, err.message);
          assert.match(err.message, /signalez-le/i, err.message);
          assert.doesNotMatch(
            err.message,
            /mot de passe|adresse électronique/i,
            `le message ne doit PAS accuser les identifiants : « ${err.message} »`
          );
          // §2.3 — on ne nomme pas la régie qu'on n'a pas reconnue. L'obstacle
          // d'Aagaard n'est pas un bandeau de cookies, c'en est une preuve.
          assert.doesNotMatch(err.message, /cookie/i, err.message);
          return true;
        }
      );

      // Le diagnostic doit rester exploitable : l'identifiant et les classes
      // de l'obstacle, pour lui donner son motif sans se connecter soi-même.
      assert.ok(
        j.contient(/didomi-host|recouvre/i),
        `l'obstacle doit être décrit au journal :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

test(
  'un mot de passe réellement faux dit qu\'il est faux, et rien d\'autre',
  SANS_NAVIGATEUR,
  async () => {
    const boutique = await ouvrirBoutique({
      regie: 'didomi',
      moment: 'chargement',
      motDePasseAttendu: 'un-autre-mot-de-passe',
    });
    const j = journal();

    try {
      await assert.rejects(
        () => prestashop.test({ ...IDENTIFIANTS }, j.ctx(boutique.manifest)),
        (err) => {
          assert.match(err.message, /Adresse électronique ou mot de passe incorrect/i);
          assert.equal(err.sessionExpired, true);
          return true;
        }
      );

      // Le texte d'alerte de la boutique va au journal, pas devant
      // l'utilisateur — et la ligne de preuve avec, URL finale comprise.
      assert.ok(j.contient(/connexion NON confirmée/), j.texte());
      assert.ok(
        j.contient(/message de la boutique « Échec d'authentification »/),
        `le message RÉEL de la boutique est ce qui autorise à parler de mot de passe :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

// ---------------------------------------------------------------------------
// §6 — l'agent utilisateur, vu du serveur
// ---------------------------------------------------------------------------

test(
  'la boutique ne voit jamais « HeadlessChrome » arriver',
  SANS_NAVIGATEUR,
  async () => {
    const boutique = await ouvrirBoutique({ regie: 'didomi', moment: 'chargement' });
    const j = journal();

    try {
      await prestashop.fetchInvoices({ ...IDENTIFIANTS }, j.ctx(boutique.manifest));

      assert.ok(boutique.agents.length >= 4, 'la boutique doit avoir reçu des requêtes');
      for (const agent of boutique.agents) {
        assert.doesNotMatch(agent, /HeadlessChrome/i, `agent trahi : ${agent}`);
        assert.match(agent, /Chrome\/\d+/, `agent invraisemblable : ${agent}`);
      }

      // Le téléchargement passe par `context.request` : il doit porter le même
      // agent que la navigation, sinon la session change d'identité en cours
      // de route — exactement ce qu'un pare-feu applicatif relève.
      const uniques = new Set(boutique.agents);
      assert.equal(uniques.size, 1, `un seul agent attendu, vu : ${[...uniques].join(' | ')}`);
    } finally {
      await boutique.fermer();
    }
  }
);

// ---------------------------------------------------------------------------
// §5.a — « connecté » ne veut pas dire « les commandes sont atteignables »
// ---------------------------------------------------------------------------

test(
  'une page de commandes qui renvoie à l\'authentification est vue comme telle',
  SANS_NAVIGATEUR,
  async () => {
    const boutique = await ouvrirBoutique({ regie: 'didomi', moment: 'chargement' });
    const j = journal();

    // Le manifeste pointe vers une page de commandes que la boutique ne sert
    // qu'aux sessions ouvertes — et le connecteur y arrive AVEC sa session…
    // sauf qu'on la lui fait perdre en visant une autre origine. La forme la
    // plus simple de ce cas : une adresse de commandes qui redirige toujours.
    const manifestTrompeur = {
      ...boutique.manifest,
      urls: {
        login: boutique.manifest.urls.login,
        // Ce chemin n'existe pas : la fausse boutique renvoie un 404, mais
        // l'important est ailleurs — on vérifie ici la détection du renvoi.
        orders: `${boutique.racine}/fr/connexion?back=history`,
      },
    };

    try {
      await assert.rejects(
        () => prestashop.test({ ...IDENTIFIANTS }, j.ctx(manifestTrompeur)),
        (err) => {
          // §2.1, quatrième ligne : la connexion a été CONFIRMÉE, puis perdue.
          // Ce n'est donc pas un mot de passe faux — et c'est très exactement
          // le message que Propolia recevait à tort.
          assert.match(err.message, /La connexion à ce service a été interrompue/i);
          assert.doesNotMatch(
            err.message,
            /mot de passe/i,
            `une session perdue après une connexion prouvée n'accuse pas les identifiants : `
              + `« ${err.message} »`
          );
          return true;
        }
      );
      assert.ok(
        j.contient(/ne montre plus de compte connecté/i),
        `la perte de session doit être dite au journal :\n${j.texte()}`
      );
      assert.ok(
        j.contient(/connexion confirmée/i),
        `la connexion, elle, avait bien été prouvée :\n${j.texte()}`
      );
    } finally {
      await boutique.fermer();
    }
  }
);

// ---------------------------------------------------------------------------
// Le module de bandeau, isolé
// ---------------------------------------------------------------------------

test(
  'le module de bandeau trouve un bouton logé dans un cadre',
  SANS_NAVIGATEUR,
  async () => {
    // Plusieurs régies affichent leur bandeau dans une <iframe> : chercher
    // uniquement dans la page principale ne les voit pas.
    const { chromium } = PLAYWRIGHT;
    const navigateur = await chromium.launch({ headless: true });
    const lignes = [];

    try {
      const page = await navigateur.newPage();
      await page.setContent(`
        <button id="cible" style="position:relative;z-index:1;">Se connecter</button>
        <div id="voile" style="position:fixed;inset:0;z-index:99;background:#000a;"></div>
        <iframe style="position:fixed;bottom:0;left:0;width:300px;height:120px;z-index:100;"
                srcdoc="&lt;button id='onetrust-accept-btn-handler'&gt;Tout accepter&lt;/button&gt;">
        </iframe>
        <script>
          // Le bouton du cadre retire le voile de la page mère : c'est ce que
          // fait une régie, et c'est ce qui doit être observé après le clic.
          addEventListener('message', () => {});
        </script>`);

      // Le cadre communique par un clic : on branche le retrait du voile sur
      // l'événement, comme le ferait le script de la régie.
      await page.evaluate(() => {
        const cadre = document.querySelector('iframe');
        cadre.contentDocument.querySelector('button').addEventListener('click', () => {
          parent.document.getElementById('voile').remove();
        });
      });

      const avant = await cookieBanner.obstacleDevant(page, '#cible');
      assert.ok(avant, 'le voile doit être détecté avant la fermeture');
      assert.equal(avant.id, 'voile');

      const resultat = await cookieBanner.fermer(page, {
        cible: '#cible',
        log: (m) => lignes.push(m),
        prefixe: 'test',
      });

      assert.equal(resultat.ferme, true, lignes.join('\n'));
      assert.equal(resultat.regie, 'OneTrust');
      assert.equal(resultat.obstacle, null, 'plus rien ne doit recouvrir la cible');
    } finally {
      await navigateur.close();
    }
  }
);

test(
  'un bandeau qui résiste est décrit par son identifiant et ses classes',
  SANS_NAVIGATEUR,
  async () => {
    const { chromium } = PLAYWRIGHT;
    const navigateur = await chromium.launch({ headless: true });
    const lignes = [];

    try {
      const page = await navigateur.newPage();
      // ⚠ Ce voile-ci se REMET EN PLACE quand on le retire : c'est ce qui le
      // rend réellement irréductible depuis le lot 14. Sans ça, la cinquième
      // étape — le contournement forcé — le retirerait du DOM et le test ne
      // couvrirait plus le chemin « toutes les étapes ont échoué ».
      // Des régies font exactement ça, et c'est pour ça que le contournement
      // forcé est journalisé comme fragile plutôt que comme une réussite.
      await page.setContent(`
        <button id="cible">Se connecter</button>
        <div id="cmp-maison" class="cmp-voile cmp-bloquant"
             style="position:fixed;inset:0;z-index:99;background:#000a;">
          <button class="cmp-regler">Gérer mes préférences</button>
        </div>
        <script>
          var modele = document.getElementById('cmp-maison').cloneNode(true);
          new MutationObserver(function () {
            if (!document.getElementById('cmp-maison')) {
              document.body.appendChild(modele.cloneNode(true));
            }
          }).observe(document.body, { childList: true });
        </script>`);

      const resultat = await cookieBanner.fermer(page, {
        cible: '#cible',
        log: (m) => lignes.push(m),
        prefixe: 'boutique',
      });

      assert.equal(resultat.ferme, false);
      assert.ok(resultat.obstacle, 'l\'obstacle doit être rapporté');
      assert.equal(resultat.obstacle.id, 'cmp-maison');
      assert.match(resultat.obstacle.classes, /cmp-voile/);
      // Deux passages, pas plus : on ne s'acharne pas.
      assert.equal(resultat.tentatives, 2);

      const trace = lignes.join('\n');
      assert.match(trace, /cmp-maison/, `l'identifiant doit être au journal :\n${trace}`);
      assert.match(trace, /cmp-voile/, `les classes doivent être au journal :\n${trace}`);
      assert.match(trace, /obstructions\.js/, 'le journal doit dire où ajouter la régie');
    } finally {
      await navigateur.close();
    }
  }
);
