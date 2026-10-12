'use strict';

/**
 * Lot 108 bis — le Profil en pleine largeur.
 *
 * R1, au vrai Chromium, à 1920, 1700 et 1280 px, dans chacune des huit
 * sections : la colonne des cartes va de la navigation (gouttière de 28 px) à
 * la carte « Sécurité du compte », sans bande vide ; cette carte (300 px) a son
 * bord droit sur la marge de la page — celle de la barre du haut ; chaque
 * carte de la section a la largeur de la colonne, ses paragraphes 640 px au
 * plus (longueur de ligne), et rien d'autre n'y est bridé (une borne en pixels
 * plus étroite que sa place — la demande de support, 700 px, l'était). La
 * grille des connecteurs
 * installés (sept au banc) compte au moins trois colonnes à 1920 px, une à
 * 1280 (deux n'y tiennent pas : cartes de 300 px) ; à chaque largeur, la tête
 * de chaque carte tient — le nom ne passe pas sous l'état, même pour la pire
 * du banc (« Impots.gouv.fr », « Connexion refusée ») ; la vue « Liste »
 * occupe toute sa carte. Titre, navigation et marges sont ceux de
 * l'Administration. Puis de 1280 à 1920 px, de 4 en 4 : la tête tient à chaque
 * largeur (elle demande 374 px, mesuré ; la carte en a 380 au moins) et la
 * carte de sécurité reste sur la marge. Avant le lot, à 1920 px, la colonne était bornée à
 * 820 px : la carte de sécurité finissait à 1 424 px, la marge est à 1 892.
 *
 * R2 : le rendu des autres écrans ne bouge pas — le Store, les onze sections
 * de l'Administration (1280 px, deux thèmes), le Profil entier à 1280 px (la
 * borne n'y mordait pas) et à 800 px (sous 1024 px, le lot responsive est à
 * part). Empreintes (HTML et
 * mise en page, celles du lot 108) relevées AVANT le lot, sur l'arbre du tag
 * `avant-profil-largeur-108b` (`1e2bc8f`), deux relevés identiques.
 * L'accueil, « Mes documents », les notifications et le Suivi sont verrouillés
 * par `lot108-autres-pages`.
 *
 * Aucune donnée réelle : le banc du lot 108, comptes nommés par leur rôle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./helpers');
const { AVEC_NAVIGATEUR, ouvrirCrabe, fermerNavigateur } = require('./lot106-commun');
const { SECTIONS_PROFIL } = require('./lot108-commun');
const { CONNECTEURS_DU_BANC, ECRANS_R2, HORLOGE, poserLeBancLargeur, empreinteStable } = require('./lot108b-commun');

/** Relevées sur `1e2bc8f` (tag `avant-profil-largeur-108b`), deux passes identiques. */
const AVANT = {
  'store-sombre': { html: '23b72678628de24f6b998161d62c8bf997b2c349f81de41b1d4b9e48a5515c2d', miseEnPage: '34b99924062cafc14576f280d387a97a16c7b7e13d526369e521ef17197c9dd0' },
  'admin-users-sombre': { html: 'e6a5bbbb3a4a854ea81fc664b9a5df2b677b5ae895cc284c4fc7f92e8a9608e6', miseEnPage: 'c70bcdf1c878721bf1e5daa56c7e7675ef40767a3209b0e06b34381be04a25d6' },
  'admin-apps-sombre': { html: 'c8212632bf4ea3a22421ed04117c73c52e6fae5c824892a757afadf016c643fe', miseEnPage: '9a389f3889f4471c26507ddb8c499708af079092dbce843177f9bf1a73f9c94e' },
  'admin-roles-sombre': { html: '88a94051d94cae6d04fc3be56e8d4d1aba3d58e2b6f5f99115d7f7d81e9f54ca', miseEnPage: '564cb5142be6bc3f001951c2f84928bd7cd779a7f5e1034e56e7b767aeaadc82' },
  'admin-cron-sombre': { html: 'd541a3bc72f09c1b000e8341600ffedcabba665969d030bac72d30dca328750e', miseEnPage: 'c3b314e202e15d18f819e259a96511d20053cea207c9a90466976548c3478e5b' },
  'admin-storage-sombre': { html: '39afb8c4ac48219fc0a5a2b19fb8573e1a74ec77c257ff0b96b6665c43755c17', miseEnPage: 'c70d86c5d1191128a3dca9f30f7ef61dd2a8f34f714ad708f109d9ff33cc8973' },
  'admin-optimisation-sombre': { html: '4373c39bc0c8b9c8fc95e941aba05176d377ce2e57843d7214ea6bc3b87fec29', miseEnPage: '23872dd55d7927ae8b5fc9be20eaafe36092eb99cd96c91366253db6b0f1f0b4' },
  'admin-securite-sombre': { html: 'f1611bdaa90fded094aaceb2a6e2102c0be6ba1572bf7ee8b49d6ab99ca24d0c', miseEnPage: 'a4866794926a6747eb5e9b99cd422616b58c0849a6f8c8744085f9e0b0827efd' },
  'admin-smtp-sombre': { html: '12b53528ab32eaf136493c87fbf3af04bc8e05c7e2c95f71e8ade232ccb7462f', miseEnPage: '0c5a79122bd36a04c0200759a20c9469b8712dc729db9518606b60603f44cead' },
  'admin-logs-sombre': { html: '5aa1f24a2e29e6dfc7c2405d91f51188b4aa13a7ddf0c06548c132a9f3be751c', miseEnPage: 'c2d694cb153c9749092fd3e7c303213786beff0208d43ec40d6deed18d49dcb9' },
  'admin-support-sombre': { html: '790c0bfa4bee8eeb64fff458799159b431633ec11dd954ef5e9dd5c843c73464', miseEnPage: 'd6f34eb59888564572b4efb1f157e0afb046e5521c776aba000b414c2cc3bcc6' },
  'admin-systeme-sombre': { html: '79d417e1d4ce9575388fd80452be5f578e5b866647b16eaa16b890dac376bba8', miseEnPage: '5d5ec952e321527b8a75829db68ec72663d5f79ed2c7539fae68f3e0e240e027' },
  'profil-general-sombre': { html: 'ed6c98e8b797b1d51764a368883538979cfc936297eaf562cb839aa0a6bba635', miseEnPage: 'd7802d4bba4c027cb6a8ca60df9341c1199ee1f66c13840b2d516bd9b386b7c7' },
  'profil-interface-sombre': { html: '365468525139b824eb74fffb1f8fca058efb7a47341505b4221d3bb2d4b94816', miseEnPage: '3d4ee3eb27733c5b096c5afaed489ee50185552d991fba6350c1ce26954c97b0' },
  'profil-stockage-sombre': { html: 'f7b4713335517c6052cb3211885b083727af0b6e12e5b5fc5992755e05c99ddf', miseEnPage: '5cb056aac7fb9479256cf784de5f43fe4c835f04a4eb741d9814f6b355fe7bd0' },
  'profil-fichiers-sombre': { html: 'e764fce202c2d224d21915203ef30ad05e637b6a21ad922a7172e2812a4c6149', miseEnPage: '52c48f2c042d736b3f30ebc7b9b004912e82cc29c5b1b6396112733dc32dc98a' },
  'profil-connecteurs-sombre': { html: 'c319f1fb1632cc77396c56c5f8b70c2b1e0aab7302cddcb8a39689a00d0eaa2f', miseEnPage: 'f2f86794aabaf76c791ce2379b4a1bc0291ba98cec6b4b0de8e2ed8346ab57b8' },
  'profil-permissions-sombre': { html: '61f9ba2960f7747f31e9b95c1b93d85919b782a2fd1b0a8de7e5ed07406e1f97', miseEnPage: '32e729c765ae5298248a3bb9a4940e632988561a10e2ca8639855f4abe94236e' },
  'profil-compte-sombre': { html: '6ea1c30be764e163fb7fa53f927ae60d5d22bfee518fbb9b4caabee1b0c212e3', miseEnPage: '46e48136967b3f36f9b0db7c0ebd5ee1aea72d31a8b1169b82421a6f689e6379' },
  'profil-contact-sombre': { html: 'e6020237ca651a56dc4661383c8e728b50c88c2d4fca1fe500293f7de2cae813', miseEnPage: 'b58e4c29d12fe19e58c725148361a2eacb6882da456282ff12892d7f83baa174' },
  'profil-general-800-sombre': { html: 'ed6c98e8b797b1d51764a368883538979cfc936297eaf562cb839aa0a6bba635', miseEnPage: '610eb3342b5122d81e15e86b5332995c53cb57c48cec9bc659b3e436fdaa8f56' },
  'profil-interface-800-sombre': { html: '365468525139b824eb74fffb1f8fca058efb7a47341505b4221d3bb2d4b94816', miseEnPage: '23448938f5fbc5996390877f8c4866e348e61cfc2647a739559a8914b7bb10b7' },
  'profil-stockage-800-sombre': { html: 'f7b4713335517c6052cb3211885b083727af0b6e12e5b5fc5992755e05c99ddf', miseEnPage: '82bf7425b0f1f074b336aa0eaca67770e71ea9a9c5d4f81c1b16c5b200625650' },
  'profil-fichiers-800-sombre': { html: 'e764fce202c2d224d21915203ef30ad05e637b6a21ad922a7172e2812a4c6149', miseEnPage: '846500755c09777ce1757b2367b86584c5c5b7fd2d1cbb0a2aedef9bbce29ae3' },
  'profil-connecteurs-800-sombre': { html: 'c319f1fb1632cc77396c56c5f8b70c2b1e0aab7302cddcb8a39689a00d0eaa2f', miseEnPage: '035e580731e32827644968f92ba906dc29bfaedace100955fdf6236319dc7366' },
  'profil-permissions-800-sombre': { html: '61f9ba2960f7747f31e9b95c1b93d85919b782a2fd1b0a8de7e5ed07406e1f97', miseEnPage: '28bdaf59b3bb27bcfe6f07016e7434ed7f43cca9e6c70360ef7add1ce5e1757d' },
  'profil-compte-800-sombre': { html: '6ea1c30be764e163fb7fa53f927ae60d5d22bfee518fbb9b4caabee1b0c212e3', miseEnPage: 'e2a16d5c57839e2e1ae0b31cd86004e782e0f846f22360abdd8117ad7595c370' },
  'profil-contact-800-sombre': { html: 'e6020237ca651a56dc4661383c8e728b50c88c2d4fca1fe500293f7de2cae813', miseEnPage: 'fa88374b1cdab4be36c5c274acb1a1a5fc0169b638c7fb6ee8f1b6d8c8f827e9' },
  'store-clair': { html: '23b72678628de24f6b998161d62c8bf997b2c349f81de41b1d4b9e48a5515c2d', miseEnPage: '75950fa4113980cdd24f4c45702309610d30040dcf11d856c9d2377431e3a9c2' },
  'admin-users-clair': { html: 'e6a5bbbb3a4a854ea81fc664b9a5df2b677b5ae895cc284c4fc7f92e8a9608e6', miseEnPage: 'b5f61fed2a8171347b6d5f51c25872c9580974a79e2b1fe774510a2cdd28cc6b' },
  'admin-apps-clair': { html: 'c8212632bf4ea3a22421ed04117c73c52e6fae5c824892a757afadf016c643fe', miseEnPage: 'e1a7c2ee013c73ef339a4821792d5b8aa375f6d910ad821a3741f905db7ddade' },
  'admin-roles-clair': { html: '88a94051d94cae6d04fc3be56e8d4d1aba3d58e2b6f5f99115d7f7d81e9f54ca', miseEnPage: '4a4949875108750ee521f28763d1c2d7c90e32d16326b7df34d174bb42ef2f68' },
  'admin-cron-clair': { html: 'd541a3bc72f09c1b000e8341600ffedcabba665969d030bac72d30dca328750e', miseEnPage: 'bd4bcbd8b160ff928192d78d61c2c3c6aa948f94f736df162155780903f99351' },
  'admin-storage-clair': { html: '39afb8c4ac48219fc0a5a2b19fb8573e1a74ec77c257ff0b96b6665c43755c17', miseEnPage: 'bdac33adf145a4250696b101767036de9d93b1a4fa1c4cca42793c0664cb7eba' },
  'admin-optimisation-clair': { html: '4373c39bc0c8b9c8fc95e941aba05176d377ce2e57843d7214ea6bc3b87fec29', miseEnPage: '2f2f5403a49ef63efdaec7917381d1847c2aeea3b0cfcb72a33cce73f5bfd926' },
  'admin-securite-clair': { html: 'f1611bdaa90fded094aaceb2a6e2102c0be6ba1572bf7ee8b49d6ab99ca24d0c', miseEnPage: '61dc3d88ebdb27eb6928f627f75937701c73413d185530c5e9aae35a2040fd77' },
  'admin-smtp-clair': { html: '12b53528ab32eaf136493c87fbf3af04bc8e05c7e2c95f71e8ade232ccb7462f', miseEnPage: 'b6d57503b8e8fd4dc4f005fd5ce9ae56bc9a13034d77022bad50c7339e2189b5' },
  'admin-logs-clair': { html: '5aa1f24a2e29e6dfc7c2405d91f51188b4aa13a7ddf0c06548c132a9f3be751c', miseEnPage: '4f6f6d946a257ed67debaf47936f33533f634cf5f1bba48b4fc4d61c07b30d13' },
  'admin-support-clair': { html: '790c0bfa4bee8eeb64fff458799159b431633ec11dd954ef5e9dd5c843c73464', miseEnPage: 'bd0ea117fd4178767fd1fa0e13fdd1a7d9366e158dd0b368c26f9b3be1d47881' },
  'admin-systeme-clair': { html: '79d417e1d4ce9575388fd80452be5f578e5b866647b16eaa16b890dac376bba8', miseEnPage: '427c174cc44dc4c666010197037d6047d4fffd1390034c3cbde388d9502e4c4b' },
  'profil-general-clair': { html: 'ed6c98e8b797b1d51764a368883538979cfc936297eaf562cb839aa0a6bba635', miseEnPage: 'd63f079e5f16a7163981ba765b285dd25094f26c3b0432ecf0431ca878befa88' },
  'profil-interface-clair': { html: '365468525139b824eb74fffb1f8fca058efb7a47341505b4221d3bb2d4b94816', miseEnPage: '2b1a7812a42262b3d9419c7a12206d63fbaf4e9ef820ccbdef3b9014ddecd78c' },
  'profil-stockage-clair': { html: 'f7b4713335517c6052cb3211885b083727af0b6e12e5b5fc5992755e05c99ddf', miseEnPage: 'ded2577bef97f7cc6159aad6103216de3771087777c618dae629a0009ae977d6' },
  'profil-fichiers-clair': { html: 'e764fce202c2d224d21915203ef30ad05e637b6a21ad922a7172e2812a4c6149', miseEnPage: '82e98f72d6d879033facb2c619105eccef91d96cdc03dc6b443dd9ce796a1ce0' },
  'profil-connecteurs-clair': { html: 'c319f1fb1632cc77396c56c5f8b70c2b1e0aab7302cddcb8a39689a00d0eaa2f', miseEnPage: 'c1fcd7ce8ae92555a3a5192a9364522db8140ca868311bf0cc183927e97c4753' },
  'profil-permissions-clair': { html: '61f9ba2960f7747f31e9b95c1b93d85919b782a2fd1b0a8de7e5ed07406e1f97', miseEnPage: '4ba5b0321ce196d82991e1f41be85517f538d7cf93bc695861b5d57455358251' },
  'profil-compte-clair': { html: '6ea1c30be764e163fb7fa53f927ae60d5d22bfee518fbb9b4caabee1b0c212e3', miseEnPage: 'ffc943f1187d74dcc12a6648701fb3831ad7d8fbd2a49c0e4e4c5cb7848e321c' },
  'profil-contact-clair': { html: 'e6020237ca651a56dc4661383c8e728b50c88c2d4fca1fe500293f7de2cae813', miseEnPage: '2195358d5fc490f9998168127679bd626b2929eda90df03a8614e1c77e1626ec' },
  'profil-general-800-clair': { html: 'ed6c98e8b797b1d51764a368883538979cfc936297eaf562cb839aa0a6bba635', miseEnPage: 'bc53726c2991f695fc5a6e17f3a07e92699b398aea346c3c5098b198fb41ee8b' },
  'profil-interface-800-clair': { html: '365468525139b824eb74fffb1f8fca058efb7a47341505b4221d3bb2d4b94816', miseEnPage: 'a68667f5e1412cb4d20aba1097c4e569794a9c70509ebe6cbbb0c0cabed309d2' },
  'profil-stockage-800-clair': { html: 'f7b4713335517c6052cb3211885b083727af0b6e12e5b5fc5992755e05c99ddf', miseEnPage: '10a282ef7f57c5631dad1ce89df229300318119b5e19978898462e7639cab6a4' },
  'profil-fichiers-800-clair': { html: 'e764fce202c2d224d21915203ef30ad05e637b6a21ad922a7172e2812a4c6149', miseEnPage: 'ea49ebabe7f49c1976cadcbb6d4cb54717daa968a9829595cf06e2f5aa15561e' },
  'profil-connecteurs-800-clair': { html: 'c319f1fb1632cc77396c56c5f8b70c2b1e0aab7302cddcb8a39689a00d0eaa2f', miseEnPage: '82dae8d4479e3f8c91502f1afdf7e5cba1332c699ed239b3dea437a42a64b459' },
  'profil-permissions-800-clair': { html: '61f9ba2960f7747f31e9b95c1b93d85919b782a2fd1b0a8de7e5ed07406e1f97', miseEnPage: '6abeeda8e716a9b7649ebf6f9e4764d888a2bda905cd41a49f11841556bebf72' },
  'profil-compte-800-clair': { html: '6ea1c30be764e163fb7fa53f927ae60d5d22bfee518fbb9b4caabee1b0c212e3', miseEnPage: 'cbbf7c99f91835f5a1a322fa12d1cb5422495b8268c6263a1ebfb9e06836461d' },
  'profil-contact-800-clair': { html: 'e6020237ca651a56dc4661383c8e728b50c88c2d4fca1fe500293f7de2cae813', miseEnPage: '861b1a78051a5a326d619213f3501db5deffbc2b5341464c203df6b089fe3c9b' },
};

/** La gouttière entre la navigation, la colonne et la carte de sécurité (dès 1024 px). */
const GOUTTIERE = 28;

let client;

test.before(async () => {
  ({ client } = await poserLeBancLargeur());
});

test.after(async () => {
  await fermerNavigateur();
  await client?.close();
  helpers.teardown();
});

/** La géométrie de la section ouverte, et la marge de droite de la page (le bord du contenu de `.content`). */
function geometrie(page, vue) {
  return page.evaluate((v) => {
    const PARAGRAPHES = '.carte-sous-titre, .block-sub, .profil-desc, .danger-zone-desc';
    const boite = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { gauche: Math.round(r.left), droite: Math.round(r.right), largeur: Math.round(r.width) };
    };
    const contenu = document.querySelector('.content');
    const marge = Math.round(contenu.getBoundingClientRect().right - parseFloat(getComputedStyle(contenu).paddingRight));
    const barre = document.querySelector('.topbar');
    const margeBarre = Math.round(barre.getBoundingClientRect().right - parseFloat(getComputedStyle(barre).paddingRight));
    const actif = document.querySelector(`#view-${v} .settings-page.active`);
    return {
      marge,
      margeBarre,
      titre: boite(document.querySelector(`#view-${v} .page-title`)),
      nav: boite(document.querySelector(`#view-${v} .settings-sidebar`)),
      colonne: boite(document.querySelector(`#view-${v} .settings-content`)),
      aside: boite(document.querySelector(`#view-${v} .profil-aside`)),
      cartes: [...actif.querySelectorAll('.carte')].filter((c) => c.offsetParent && !c.parentElement.closest('.carte'))
        .map((c) => Math.round(c.getBoundingClientRect().width)),
      // Le paragraphe le plus large de la section (sous-titres, aides, zone de suppression).
      paragraphe: Math.max(0, ...[...actif.querySelectorAll(PARAGRAPHES)]
        .filter((p) => p.offsetParent).map((p) => Math.round(p.getBoundingClientRect().width))),
      // Tout autre élément borné en pixels là où la borne mord (sa place est plus large qu'elle).
      bornes: [...actif.querySelectorAll('*')].filter((el) => el.offsetParent && !el.matches(PARAGRAPHES)).filter((el) => {
        const mw = getComputedStyle(el).maxWidth;
        return /^[\d.]+px$/.test(mw) && parseFloat(mw) < el.parentElement.clientWidth - 1;
      }).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} (${getComputedStyle(el).maxWidth})`),
      defilement: document.documentElement.scrollWidth,
    };
  }, vue);
}

/** Colonnes de connecteurs attendues : au moins trois à 1920 px, une à 1280 ; entre les deux, la largeur décide. */
const COLONNES = {
  1920: (n) => assert.ok(n >= 3, `1920 px : ${n} colonnes de connecteurs, au moins trois`),
  1700: () => {},
  1280: (n) => assert.equal(n, 1, '1280 px : une colonne de connecteurs (deux n\'y tiennent pas)'),
};

for (const largeur of [1920, 1700, 1280]) {
  test(`R1 — ${largeur} px : chaque section du Profil prend toute la largeur, « Sécurité du compte » sur la marge de la page`, AVEC_NAVIGATEUR, async (t) => {
    const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur, hauteur: 1000, chemin: '/profil/general' });
    t.after(fermer);
    let reference = null;
    for (const nom of SECTIONS_PROFIL) {
      await page.goto(`${client.base}/profil/${nom}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((id) => document.querySelector('#view-profil .settings-page.active')?.id === id, `ppage-${nom}`);
      await page.waitForTimeout(500);
      const g = await geometrie(page, 'profil');
      reference ??= g;
      assert.equal(g.marge, g.margeBarre, 'la marge de la page est celle de la barre du haut');
      assert.equal(g.aside.droite, g.marge, `${nom} : le bord droit de « Sécurité du compte » (${g.aside.droite}) est sur la marge de la page (${g.marge})`);
      assert.equal(g.aside.largeur, 300, `${nom} : « Sécurité du compte » garde sa largeur`);
      assert.equal(g.colonne.gauche, g.nav.droite + GOUTTIERE, `${nom} : la colonne part de la navigation`);
      assert.equal(g.colonne.droite, g.aside.gauche - GOUTTIERE, `${nom} : aucune bande vide entre la colonne et « Sécurité du compte »`);
      assert.ok(g.cartes.length >= 1, `${nom} : au moins une carte`);
      for (const w of g.cartes) assert.equal(w, g.colonne.largeur, `${nom} : une carte de ${w} px dans une colonne de ${g.colonne.largeur} px`);
      assert.deepEqual([g.titre, g.nav, g.colonne], [reference.titre, reference.nav, reference.colonne], `${nom} : titre, navigation et colonne ne bougent pas d'une section à l'autre`);
      assert.equal(g.defilement, largeur, `${nom} : rien ne déborde`);
      assert.ok(g.paragraphe <= 640, `${nom} : un paragraphe de ${g.paragraphe} px — la ligne reste lisible (640 px au plus) dans sa carte`);
      assert.deepEqual(g.bornes, [], `${nom} : rien n'est bridé dans les cartes, hors la longueur de ligne des paragraphes`);
    }

    // Connecteurs installés : la grille, puis la liste.
    await page.goto(`${client.base}/profil/connecteurs`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#profil-conn-list .card-grid > .app-card').length === n, CONNECTEURS_DU_BANC.length);
    const grille = await page.$eval('#profil-conn-list .card-grid', (el) => ({
      colonnes: getComputedStyle(el).gridTemplateColumns.split(' ').length,
      lignes: new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
      droite: Math.round(el.getBoundingClientRect().right),
      carte: Math.round(el.closest('.carte').getBoundingClientRect().right),
    }));
    COLONNES[largeur](grille.colonnes);
    assert.equal(grille.lignes, Math.ceil(CONNECTEURS_DU_BANC.length / grille.colonnes), 'les cartes remplissent les colonnes');
    assert.equal(grille.droite, grille.carte - 17, 'la grille va jusqu\'au bord intérieur de sa carte (16 px de marge, 1 px de bord)');
    // La tête de chaque carte tient : le nom reste dans sa colonne, avant l'état.
    const tetes = await page.$$eval('#profil-conn-list .app-card', (cartes) => cartes.map((c) => {
      const nom = c.querySelector('.app-card-name');
      const etat = c.querySelector('.app-card-head .badge-pill, .app-card-head .cause-pill');
      return {
        nom: nom.textContent,
        etat: etat.textContent,
        deborde: nom.scrollWidth - nom.clientWidth,
        chevauche: Math.ceil(nom.getBoundingClientRect().left + nom.scrollWidth - etat.getBoundingClientRect().left),
      };
    }));
    assert.ok(tetes.some((x) => x.nom === 'Impots.gouv.fr' && x.etat === 'Connexion refusée'), 'la pire tête du banc est à l\'écran');
    for (const x of tetes) {
      assert.ok(x.deborde <= 0 && x.chevauche <= 0, `${largeur} px : « ${x.nom} » tient avant « ${x.etat} » (débord ${x.deborde}, chevauchement ${x.chevauche})`);
    }
    await page.evaluate(() => setProfilConnView('list'));
    await page.waitForFunction(() => document.querySelectorAll('#profil-conn-list .installed-row').length > 0);
    const liste = await page.$$eval('#profil-conn-list .installed-row', (rangs) => rangs.map((r) => ({
      droite: Math.round(r.getBoundingClientRect().right),
      carte: Math.round(r.closest('.carte').getBoundingClientRect().right),
    })));
    assert.equal(liste.length, CONNECTEURS_DU_BANC.length);
    for (const r of liste) assert.equal(r.droite, r.carte - 17, 'une ligne de la vue « Liste » occupe toute sa carte');
    // La vue choisie est mémorisée par compte : on remet les cartes.
    await page.evaluate(() => setProfilConnView('cards'));
    await page.waitForFunction(() => !!document.querySelector('#profil-conn-list .card-grid'));

    // L'Administration, à la même largeur : mêmes titre, navigation, départ de colonne et marge de droite.
    const admin = await ouvrirCrabe(client, 'gerante', { largeur, hauteur: 1000, chemin: '/administration/users' });
    t.after(admin.fermer);
    await admin.page.waitForFunction(() => document.querySelector('#view-admin .settings-page.active')?.id === 'apage-users');
    const a = await geometrie(admin.page, 'admin');
    assert.deepEqual([a.titre.gauche, a.nav, a.colonne.gauche], [reference.titre.gauche, reference.nav, reference.colonne.gauche], 'le Profil est aligné sur l\'Administration');
    assert.equal(a.colonne.droite, reference.aside.droite, 'même bord droit que l\'Administration');
    assert.deepEqual(erreursJs, []);
    assert.deepEqual(admin.erreursJs, []);
  });
}

test('R1 — de 1280 à 1920 px, de 4 en 4 : la tête de chaque carte de connecteur tient, la carte de sécurité reste sur la marge', AVEC_NAVIGATEUR, async (t) => {
  const { page, erreursJs, fermer } = await ouvrirCrabe(client, 'titulaire', { largeur: 1280, hauteur: 1000, chemin: '/profil/connecteurs' });
  t.after(fermer);
  await page.waitForFunction((n) => document.querySelectorAll('#profil-conn-list .card-grid > .app-card').length === n, CONNECTEURS_DU_BANC.length);
  const fautes = [];
  let colonnes = new Set();
  for (let largeur = 1280; largeur <= 1920; largeur += 4) {
    await page.setViewportSize({ width: largeur, height: 1000 });
    const m = await page.evaluate(() => {
      const contenu = document.querySelector('.content');
      const marge = Math.round(contenu.getBoundingClientRect().right - parseFloat(getComputedStyle(contenu).paddingRight));
      const pire = Math.max(...[...document.querySelectorAll('#profil-conn-list .app-card-name')].map((n) => n.scrollWidth - n.clientWidth));
      return {
        pire,
        colonnes: getComputedStyle(document.querySelector('#profil-conn-list .card-grid')).gridTemplateColumns.split(' ').length,
        ecart: marge - Math.round(document.querySelector('#view-profil .profil-aside').getBoundingClientRect().right),
      };
    });
    colonnes.add(m.colonnes);
    if (m.pire > 0 || m.ecart !== 0) fautes.push(`${largeur} px : nom débordant de ${m.pire} px, carte de sécurité à ${m.ecart} px de la marge`);
  }
  assert.deepEqual(fautes, []);
  colonnes = [...colonnes].sort();
  assert.deepEqual(colonnes, [1, 2, 3], 'une, deux puis trois colonnes selon la largeur');
  assert.deepEqual(erreursJs, []);
});

for (const clair of [false, true]) {
  test(`R2 — thème ${clair ? 'clair' : 'sombre'} : le Store, l'Administration, le Profil à 1280 et 800 px ont le rendu d'avant le lot`, AVEC_NAVIGATEUR, async (t) => {
    const pages = {};
    for (const e of ECRANS_R2) {
      const cle = `${e.compte}-${e.largeur}`;
      if (!pages[cle]) {
        pages[cle] = await ouvrirCrabe(client, e.compte, { largeur: e.largeur, hauteur: 900, clair });
        t.after(pages[cle].fermer);
        await pages[cle].page.clock.setFixedTime(HORLOGE);
      }
      const { page } = pages[cle];
      await page.evaluate((code) => (0, eval)(code), e.ouvrir);
      await page.waitForTimeout(500);
      await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
      const nom = `${e.nom}-${clair ? 'clair' : 'sombre'}`;
      assert.deepEqual(await empreinteStable(page, e.zone), AVANT[nom], nom);
    }
    for (const p of Object.values(pages)) assert.deepEqual(p.erreursJs, []);
  });
}
