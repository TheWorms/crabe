'use strict';

/**
 * Lot 108 bis — ce que partagent l'essai du Profil en pleine largeur et le
 * relevé des empreintes fait AVANT le changement (sur le tag
 * `avant-profil-largeur-108b`) : le banc, la liste des écrans comparés, et une
 * empreinte qui attend la fin du chargement.
 *
 * Aucune donnée réelle : le banc du lot 108 (comptes nommés par leur rôle,
 * demandes inventées), la titulaire ayant sept connecteurs installés.
 */

const helpers = require('./helpers');
const { poserLeBanc, SECTIONS_ADMIN, SECTIONS_PROFIL, empreinteDeLaZone } = require('./lot108-commun');

/**
 * Les sept connecteurs que la titulaire voit installés (`free` vient du banc du
 * lot 108) : de quoi remplir trois colonnes. Des services testés, ni « en
 * attente » (un compte sans droit ne les voit pas) ni « non faisables ».
 */
const CONNECTEURS_DU_BANC = ['free', 'amazon', 'free-mobile', 'impots', 'ouigo', 'bunny-net', 'kubii'];

/** L'horloge du navigateur, figée. */
const HORLOGE = new Date('2026-10-01T10:00:00Z');

/** Le banc du lot 108, la titulaire portée à sept connecteurs installés. */
async function poserLeBancLargeur() {
  const banc = await poserLeBanc();
  const db = helpers.db.get();
  const schedules = require('../server/schedules');
  for (const id of CONNECTEURS_DU_BANC.slice(1)) {
    db.prepare("INSERT INTO connector_installs (user_id, connector_id, status) VALUES (?, ?, 'installed')").run(banc.titulaire.id, id);
    schedules.ensureForInstall(banc.titulaire.id, id);
  }
  // La pire tête de carte d'un connecteur installé : le mot le plus long d'un
  // nom (« Impots.gouv.fr », 96 px) et la plus longue pastille d'état d'une
  // ligne (« Connexion refusée », 118 px) — une récupération terminée en échec,
  // cause rangée (lot 91), à date fixe.
  db.prepare(`INSERT INTO run_logs (connector_id, user_id, started_at, finished_at, success, trigger, message, cause)
              VALUES ('impots', ?, '2026-09-30 07:00:00', '2026-09-30 07:01:00', 0, 'cron', 'Échec inventé du banc.', 'connexion-refusee')`)
    .run(banc.titulaire.id);
  // Les deux demandes du banc naissent dans la même seconde : leur ordre à
  // l'écran (Administration › Support) tirait au sort. Une heure d'écart, fixe.
  db.prepare("UPDATE tickets SET created_at = '2026-09-30 08:00:00', updated_at = '2026-09-30 08:00:00' WHERE subject = 'Essai de banc'").run();
  db.prepare("UPDATE tickets SET created_at = '2026-09-30 09:00:00', updated_at = '2026-09-30 09:00:00' WHERE subject = 'Essai de banc (gérante)'").run();
  return banc;
}

/**
 * Les écrans dont le rendu ne doit pas bouger (R2). `compte` : qui les ouvre ;
 * `largeur` : la fenêtre ; `zone` : ce qu'on mesure. Le Profil à 1280 px y est
 * aussi, entier : à cette largeur la borne de 820 px ne mordait pas (colonne de
 * 648 px), et la grille des connecteurs garde sa colonne unique. À 800 px
 * (sous 1024, le lot responsive est à part), le Profil entier ne bouge pas.
 */
const ECRANS_R2 = [
  { nom: 'store', compte: 'gerante', largeur: 1280, zone: '#view-store', ouvrir: "showView('store')" },
  ...SECTIONS_ADMIN.map((s) => ({
    nom: `admin-${s}`, compte: 'gerante', largeur: 1280, zone: `#apage-${s}`,
    ouvrir: `showView('admin'); showAdminPage('${s}', document.querySelector('[data-apage="${s}"]'))`,
  })),
  ...SECTIONS_PROFIL.map((s) => ({
    nom: `profil-${s}`, compte: 'titulaire', largeur: 1280, zone: '#view-profil',
    ouvrir: `showView('profil'); showProfilPage('${s}', document.querySelector('[data-ppage="${s}"]'))`,
  })),
  ...SECTIONS_PROFIL.map((s) => ({
    nom: `profil-${s}-800`, compte: 'titulaire', largeur: 800, zone: '#view-profil',
    ouvrir: `showView('profil'); showProfilPage('${s}', document.querySelector('[data-ppage="${s}"]'))`,
  })),
];

/**
 * L'empreinte d'un écran (celle du lot 108 : HTML et mise en page), prise
 * quand elle ne bouge plus — deux mesures identiques à 400 ms d'écart : un
 * écran relevé avant la fin de ses lectures (logos, espace des destinations)
 * donnait une autre empreinte d'une passe à l'autre. Avant la mesure, ce qui
 * dépend du poste et non du code est neutralisé dans la page : le répertoire
 * temporaire de l'essai (texte, `title`, valeur d'un champ), l'heure réelle du
 * serveur, les durées de marche du processus et de l'hôte, les versions et le
 * nom du poste (Système), les tailles mesurées sur le disque.
 */
async function empreinteStable(page, zone) {
  const neutraliser = () => page.evaluate((sel) => {
    const racine = document.querySelector(sel);
    // Les commentaires du gabarit ne sont pas rendus : celui qui décrit la
    // colonne du Profil change avec ce lot, la page affichée non.
    const commentaires = document.createTreeWalker(racine, NodeFilter.SHOW_COMMENT);
    const aRetirer = [];
    while (commentaires.nextNode()) aRetirer.push(commentaires.currentNode);
    for (const c of aRetirer) c.remove();
    const marcheur = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
    while (marcheur.nextNode()) {
      const n = marcheur.currentNode;
      const v = n.nodeValue
        .replace(/crabe-test-[A-Za-z0-9]+/g, 'crabe-test-X')
        .replace(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/g, 'JJ/MM/AAAA HH:MM')
        .replace(/\b\d+(?:[.,]\d+)? ?[KMGT]?o\b/g, 'N o')
        .replace(/v\d+(?:\.\d+)+ sur [^\s·]+/g, 'vN sur le poste')
        .replace(/\bv\d+(?:\.\d+)+/g, 'vN')
        .replace(/\b\d+ (j|h|min|s)\b/g, 'N $1');
      if (v !== n.nodeValue) n.nodeValue = v;
    }
    for (const el of racine.querySelectorAll('[title], input[value]')) {
      for (const a of ['title', 'value']) {
        const v = el.getAttribute(a);
        if (v && /crabe-test-/.test(v)) el.setAttribute(a, v.replace(/crabe-test-[A-Za-z0-9]+/g, 'crabe-test-X'));
      }
      if (el.tagName === 'INPUT' && /crabe-test-/.test(el.value)) el.value = el.value.replace(/crabe-test-[A-Za-z0-9]+/g, 'crabe-test-X');
    }
  }, zone);
  let avant = null;
  for (let essai = 0; essai < 15; essai++) {
    await neutraliser();
    const e = await empreinteDeLaZone(page, zone);
    if (avant && avant.html === e.html && avant.miseEnPage === e.miseEnPage) return e;
    avant = e;
    await page.waitForTimeout(400);
  }
  throw new Error(`${zone} : l'empreinte ne se stabilise pas`);
}

module.exports = { CONNECTEURS_DU_BANC, ECRANS_R2, HORLOGE, poserLeBancLargeur, empreinteStable };
