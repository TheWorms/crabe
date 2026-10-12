'use strict';

/**
 * Lot 94 — le faux Gandi du lot 93, servi à l'adresse MESURÉE de sa liste.
 *
 * ─── Ce qui a été mesuré ─────────────────────────────────────────────────────
 *
 * Au journal de production du 06/10/2026 (00:22 UTC, deux passages de la
 * découverte qui suit la connexion), le navigateur de crabe a suivi cette
 * chaîne, identifiants masqués par « … » :
 *
 *   `/billing` → `/billing/api/v5/login` → `id.gandi.net/fr/authorize` →
 *   `/billing/api/v5/login` → `/billing` → `/billing/…` →
 *   `/billing/…/organizations` (200)
 *
 * La liste des organisations n'est donc PAS servie à `/billing`, comme le
 * prompt du lot 93 l'avait écrit : `/billing` renvoie vers l'organisation
 * personnelle, qui renvoie vers sa liste `/organizations`. Le banc du lot 93
 * servait la liste à `/billing`, d'où un connecteur qui passait ses essais et
 * tombait sur le vrai site.
 *
 * ─── Ce qui est inventé ──────────────────────────────────────────────────────
 *
 * Que l'étape intermédiaire soit l'organisation PERSONNELLE (probable, non
 * mesuré) ; le contenu de la page `/organizations`, repris tel quel de la
 * page du lot 93 (même structure que le code source enregistré par l'utilisateur, le
 * 06/10) avec un lien « Organisations » vers elle-même, puisque la page
 * enregistrée en portait vers `/billing/…/organizations`. Les deux adresses
 * « inattendue » et « inconnue » sont inventées pour éprouver le jugement de
 * la page (R2).
 *
 * ─── La mécanique ────────────────────────────────────────────────────────────
 *
 * Le faux Gandi du lot 93 (`siteGandi`) reste la vérité de la session : il est
 * interrogé à chaque fois, et s'il renvoie vers la connexion, ce renvoi est
 * rendu tel quel. Seules les adresses de la liste sont prises ici. Aucune
 * réponse n'est une redirection HTTP (leçon du lot 92) : chaque étape se fait
 * par la page (`renvoi`).
 */

const faux93 = require('./lot93-faux-sites');

/**
 * Le faux Gandi, avec la liste à l'adresse mesurée. `etat.liste` :
 *
 *   - `organizations` (défaut) : la chaîne mesurée du 06/10 ;
 *   - `billing` : la liste servie directement à `/billing`, comme au lot 93 ;
 *   - `inattendue` : la chaîne mène à `/billing/<perso>/choisir`, une adresse
 *     que crabe ne connaît pas, mais dont la page EST la liste ;
 *   - `inconnue` : la chaîne mène à `/billing/<perso>/accueil`, une vraie page
 *     inconnue — qui porte pourtant un lien vers une organisation (piège).
 *
 * `etat.compteurs.liste` compte les pages de liste servies.
 */
function siteGandiMesure(etat) {
  const interieur = faux93.siteGandi(etat);
  const perso = () => (etat.organisations.find((o) => o.moi) || etat.organisations[0]).id;
  const forme = () => etat.liste || 'organizations';
  return async (url, requete) => {
    if (url.host !== faux93.GANDI_ADMIN || requete.method() !== 'GET') return interieur(url, requete);
    const chemin = url.pathname.replace(/\/+$/, '') || '/';
    const m = /^\/billing\/([^/]+)(?:\/(organizations|choisir|accueil))?$/.exec(chemin);
    const visee = chemin === '/billing' ? 'racine' : (m && m[1] !== 'api' ? (m[2] || 'organisation') : null);
    if (!visee || forme() === 'billing') return interieur(url, requete);

    // La session : celle du banc du lot 93. Morte, il renvoie vers la connexion.
    const r = await interieur(url, requete);
    if (typeof r.html === 'string' && r.html.includes('/billing/api/v5/login')) return r;
    etat.compteurs.liste = etat.compteurs.liste || 0;

    const fin = { organizations: 'organizations', inattendue: 'choisir', inconnue: 'accueil' }[forme()];
    if (visee === 'racine') return { html: faux93.renvoi(`/billing/${perso()}`) };
    if (visee === 'organisation') return { html: faux93.renvoi(`/billing/${m[1]}/${fin}`) };
    if (visee !== fin) return { statut: 404, html: faux93.gabarit('Introuvable', '<h1>Introuvable</h1>') };

    if (visee === 'accueil') {
      return {
        html: faux93.gabarit('Tableau de bord - Gandi.net', `<header class="topbar"><a href="https://admin.gandi.net/dashboard">Gandi</a></header>
          <main><h1>Bienvenue</h1><p>Votre espace évolue.</p>
          <nav aria-label="Raccourcis"><a href="/billing/${m[1]}/overview">Vue générale</a></nav></main>`),
      };
    }
    // La page de la liste : celle du banc du lot 93, servie à cette adresse,
    // avec le lien « Organisations » vers elle-même.
    const liste = await interieur(new URL('/billing', url), requete);
    etat.compteurs.liste++;
    return {
      ...liste,
      html: String(liste.html).replace('<h1>Facturation</h1>',
        `<nav aria-label="Fil d'Ariane"><a href="/billing/${m[1]}/${fin}">Organisations</a></nav><h1>Facturation</h1>`),
    };
  };
}

module.exports = {
  ...faux93,
  siteGandiMesure,
};
