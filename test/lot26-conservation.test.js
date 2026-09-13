'use strict';

/**
 * La conservation efface l'historique — lot 26.
 *
 * ─── Ce qui a été mesuré sur l'installation réelle, le 13/08/2026 ────────────
 *
 * Réglage « Conservation : 1 an », posé le 11/08 à 01:12 avec la promesse
 * affichée à l'écran : « appliquée aux seuls documents à venir, les précédents
 * sont conservés ». Deux nuits plus tard, le journal d'application :
 *
 *     Conservation « 1 an » : 149 document(s) supprimé(s).
 *
 * Et 43 autres étaient sur la liste de la nuit suivante — PrestaShop Addons
 * depuis 2016, Proxmox depuis 2016, Bitstamp depuis 2021. Côté récupération,
 * Hetzner ne remontait plus qu'à août 2025 quand le fournisseur propose depuis
 * 2019 ; Infomaniak, OVHcloud et SoYouStart étaient coupés à la même date.
 *
 * ─── Les trois défauts, et ce que chacun coûtait ─────────────────────────────
 *
 * 1. **Le plancher se défaisait à la première re-synchronisation.** Il protégeait
 *    ce qui avait été RÉCUPÉRÉ avant le changement — or une facture de 2016
 *    re-téléchargée aujourd'hui redevenait « un document à venir », donc
 *    supprimable. La promesse s'annulait service par service, en silence.
 *
 * 2. **Deux écritures de date, une comparaison de chaînes.** `fetched_at` vaut
 *    « 2026-08-11 13:48:51 », le plancher « 2026-08-11T01:12:42.040Z ».
 *    L'espace passe avant le « T » : tout document récupéré le jour même du
 *    changement était jugé antérieur au plancher, au hasard de la ponctuation.
 *
 * 3. **Le plafond de récupération n'était posé que sur 2 des 9 chemins.**
 *    `scraping.js` et `ovh-api` le passaient ; amazon, atelier-du-portable,
 *    bitstamp, bunny-net, free, impôts, paypal et prestashop l'ignoraient. Même
 *    réglage, deux comportements — l'un se privait de documents qu'il aurait
 *    gardés, l'autre les téléchargeait pour les faire effacer la nuit.
 *
 * ─── Le contrat que ce fichier protège ───────────────────────────────────────
 *
 * **crabe ne refuse d'aller chercher un document que s'il est certain de
 * l'effacer ensuite.** Une seule règle pour les deux gestes, et un balayage de
 * TOUS les connecteurs plutôt qu'une correction par connecteur : c'est la
 * troisième fois qu'un défaut de ce genre se répare un service à la fois.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');
const retention = require('../server/retention');
const registry = require('../server/connectors/registry');
const destinations = require('../server/destinations');
const db = require('../server/db/db');

test.before(() => helpers.setup());
test.after(() => helpers.teardown());

/** Remet « tout garder » et vide l'index : la base est partagée par le fichier. */
function neutre() {
  db.get()
    .prepare(
      `UPDATE security_policy
          SET document_retention_months = 0, document_retention_floor = NULL WHERE id = 1`
    )
    .run();
  db.get().prepare('DELETE FROM invoices').run();
}

/** Dépose une facture : la ligne d'index ET le fichier sur le stockage local. */
function deposer(user, { filename, issuedOn, fetchedAt = null, connector = 'free' }) {
  const racine = destinations.publicConfig('local')?.path || process.env.CRABE_LOCAL_PATH;
  const fichier = path.join(
    racine, user.username, 'Free Internet', 'compte', String(issuedOn).slice(0, 4), filename
  );
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, '%PDF-1.4\nfacture de test\n');

  db.get()
    .prepare(
      `INSERT INTO invoices (user_id, connector_id, filename, remote_id, account_id,
                             size_bytes, issued_on, fetched_at, destinations)
       VALUES (?, ?, ?, ?, 'compte', ?, ?, COALESCE(?, datetime('now')), ?)`
    )
    .run(
      user.id, connector, filename, filename, fs.statSync(fichier).size, issuedOn, fetchedAt,
      JSON.stringify({ local: { state: 'ok', ok: true, path: fichier } })
    );
  return fichier;
}

/** Une date ISO située il y a `mois` mois. */
function ilYA(mois) {
  const d = new Date();
  d.setMonth(d.getMonth() - mois);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. Le balayage de TOUS les connecteurs
// ---------------------------------------------------------------------------

/**
 * Chaque appel à la profondeur d'historique, dans tout `server/connectors/`.
 *
 * Lu dans le CODE SOURCE, volontairement. On pourrait exécuter chaque
 * connecteur et regarder ce qu'il demande, mais il faudrait un navigateur, un
 * compte et un site vivant pour chacun. La question posée ici est plus simple
 * et se répond sans rien de tout ça : ce paramètre est-il passé, oui ou non ?
 *
 * Un fichier ajouté demain entre dans le balayage sans que personne n'ait à
 * inscrire son nom quelque part — c'est tout l'intérêt.
 */
function appelsDHistorique() {
  const racine = path.join(__dirname, '..', 'server', 'connectors');
  const appels = [];

  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) { parcourir(chemin); continue; }
      if (!entree.name.endsWith('.js')) continue;
      // `history.js` définit ces fonctions ; il ne s'appelle pas lui-même.
      if (chemin === path.join(racine, 'history.js')) continue;

      const source = fs.readFileSync(chemin, 'utf8');
      for (const fonction of ['anneesAParcourir', 'fenetreDeDates']) {
        let depuis = 0;
        for (;;) {
          const debut = source.indexOf(`${fonction}({`, depuis);
          if (debut === -1) break;
          // L'appel s'arrête à sa parenthèse fermante : on compte les
          // accolades pour ne pas confondre avec un objet imbriqué.
          let profondeur = 0;
          let fin = debut;
          for (let i = source.indexOf('{', debut); i < source.length; i++) {
            if (source[i] === '{') profondeur++;
            else if (source[i] === '}') { profondeur--; if (!profondeur) { fin = i; break; } }
          }
          appels.push({
            fichier: path.relative(racine, chemin),
            fonction,
            corps: source.slice(debut, fin + 1),
          });
          depuis = fin + 1;
        }
      }
    }
  };

  parcourir(racine);
  return appels;
}

test('tous les connecteurs passent le plafond de conservation, sans exception', () => {
  const appels = appelsDHistorique();

  // Sans ce garde-fou, un balayage qui ne trouverait plus rien passerait pour
  // un succès — exactement le genre de test qui rassure sans rien vérifier.
  assert.ok(
    appels.length >= 9,
    `attendu au moins neuf appels à la profondeur d'historique, trouvé ${appels.length}`
  );

  const oublis = appels
    .filter((a) => !a.corps.includes('plafondMois'))
    .map((a) => `${a.fichier} → ${a.fonction}()`);

  assert.deepEqual(
    oublis,
    [],
    'ces connecteurs décident de leur profondeur sans regarder la conservation : ils '
      + 'téléchargeront des documents que l\'entretien de la nuit effacera, ou se priveront '
      + 'de documents que crabe aurait gardés. Le paramètre s\'écrit '
      + '`plafondMois: ctx?.conservationMois || 0`'
  );
});

// ---------------------------------------------------------------------------
// 2. Le plafond de récupération suit la MÊME règle que le nettoyage
// ---------------------------------------------------------------------------

test('sans conservation, aucun plafond : crabe va chercher tout ce qui existe', () => {
  neutre();
  assert.equal(retention.fetchCapMonths(), 0);
});

test('un plancher posé ⇒ aucun plafond : le nettoyage n\'effacera pas l\'ancien', () => {
  neutre();
  // Le geste ordinaire : on choisit « 1 an », l'existant est protégé.
  retention.setMonths(12);
  assert.ok(retention.policy().floor, 'le plancher doit être posé');
  assert.equal(
    retention.fetchCapMonths(),
    0,
    'refuser d\'aller chercher un document que le nettoyage épargnera, c\'est perdre '
      + 'des factures pour rien — Hetzner s\'arrêtait ainsi à 2025 pour un historique de 2019'
  );
});

test('conservation appliquée à l\'existant ⇒ le plafond vaut la profondeur', () => {
  neutre();
  // Le geste explicite, confirmé par l'administrateur : le plancher tombe.
  retention.setMonths(12, { applyNow: true });
  assert.equal(retention.policy().floor, null);
  assert.equal(
    retention.fetchCapMonths(),
    12,
    'là, le nettoyage effacera vraiment l\'ancien : ne pas le télécharger est le bon choix'
  );
});

test('le contexte des connecteurs est branché sur ce plafond, pas sur la profondeur brute', () => {
  // `makeContext()` est interne au registre — c'est voulu, rien d'autre n'a à
  // fabriquer un contexte de connecteur. Ce qui se vérifie de l'extérieur, et
  // qui est exactement ce qui s'était trompé, c'est le branchement lui-même :
  // le registre lisait `policy().months`, la profondeur brute, au lieu du
  // plafond qui tient compte du plancher.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'connectors', 'registry.js'),
    'utf8'
  );
  assert.ok(
    source.includes('fetchCapMonths()'),
    'le registre doit alimenter `conservationMois` avec le plafond de récupération'
  );
  assert.ok(
    !/retention'\)\.policy\(\)\.months/.test(source),
    'la profondeur brute ne doit plus servir de plafond : c\'est elle qui coupait Hetzner à 2025'
  );
});

// ---------------------------------------------------------------------------
// 3. Le plancher ne se défait plus à la re-synchronisation
// ---------------------------------------------------------------------------

test('une vieille facture re-téléchargée reste protégée', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'resynchro' });

  // Une facture de dix ans, déjà en place quand le réglage change.
  deposer(user, { filename: 'ancienne.pdf', issuedOn: ilYA(120) });
  retention.setMonths(12);
  assert.equal(retention.expired().length, 0, 'l\'existant est protégé, c\'est la promesse');

  // Le service est re-synchronisé : la même facture revient, avec une date de
  // récupération d'aujourd'hui. C'est ce geste ordinaire qui effaçait 149
  // documents — le document redevenait « arrivé après le changement ».
  db.get().prepare("UPDATE invoices SET fetched_at = datetime('now')").run();

  assert.equal(
    retention.expired().length,
    0,
    'une facture ne cesse pas d\'être « un précédent » parce qu\'on l\'a retéléchargée'
  );
  assert.equal(retention.purge().deleted, 0);
});

test('le plancher ne dépend plus de la ponctuation des dates', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'ponctuation' });
  deposer(user, { filename: 'meme-jour.pdf', issuedOn: ilYA(120) });

  retention.setMonths(12);
  const plancher = retention.policy().floor;
  assert.ok(plancher.includes('T'), 'le plancher est bien enregistré au format ISO');

  // La comparaison brute « 2026-08-11 13:48:51 » >= « 2026-08-11T01:12:42Z »
  // rendait FAUX, l'espace passant avant le « T ». La protection dépendait donc
  // de l'heure à laquelle on avait cliqué.
  const memeJour = `${plancher.slice(0, 10)} 23:59:59`;
  db.get().prepare('UPDATE invoices SET fetched_at = ?').run(memeJour);

  assert.equal(retention.expired().length, 0);
  assert.equal(retention.purge().deleted, 0);
});

test('ce qui vieillit APRÈS le changement finit bien par partir', async () => {
  neutre();
  const user = await helpers.createUser({ username: 'vieillissement' });

  // Sans ce test, protéger l'ancien reviendrait à ne plus rien nettoyer du
  // tout, et la conservation ne servirait plus à rien.
  //
  // Le temps ne se truque pas ici : on prend un plancher posé il y a six mois
  // — ce que `expired()` accepte en paramètre — et un document de treize mois.
  // Au moment du réglage, ce document en avait sept : il était DANS la fenêtre
  // d'un an, il n'a jamais été « un précédent ». Il a vieilli depuis, et il
  // part.
  deposer(user, { filename: 'a-vieilli.pdf', issuedOn: ilYA(13) });
  retention.setMonths(12);

  const plancherAncien = new Date();
  plancherAncien.setMonth(plancherAncien.getMonth() - 6);

  assert.equal(
    retention.expired({ floor: plancherAncien.toISOString() }).length,
    1,
    'un document entré dans crabe avant d\'être ancien doit finir par sortir'
  );

  // Et la contrepartie, avec le même plancher : un document déjà hors fenêtre
  // ce jour-là reste protégé pour de bon.
  db.get().prepare('UPDATE invoices SET issued_on = ?').run(ilYA(30));
  assert.equal(
    retention.expired({ floor: plancherAncien.toISOString() }).length,
    0,
    'ce document était déjà hors fenêtre au moment du réglage : il est protégé'
  );
});
