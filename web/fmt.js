'use strict';

/**
 * Formatage — point d'entrée UNIQUE de tout l'affichage de dates, d'heures,
 * de tailles et d'avatars.
 *
 * Les réglages viennent du serveur (Paramètres → Système : fuseau horaire,
 * format d'heure, format de date) et sont posés une fois au démarrage par
 * `fmt.configure()`. Aucun écran ne doit reformater une date à la main : c'est
 * la seule façon de garantir que les logs, les exécutions, les tickets, les
 * factures et les statistiques affichent tous la même chose.
 *
 * Rappel du problème d'origine : le conteneur tournait en Etc/UTC alors que
 * crabe.env déclarait TZ=Europe/Paris. Le fuseau d'affichage est désormais un
 * réglage explicite, appliqué ici.
 */

const fmt = (() => {
  const settings = {
    timezone: 'Europe/Paris',
    timeFormat: '24',
    dateFormat: 'DD/MM/YYYY',
    gravatarEnabled: false,
  };

  /** Applique les réglages reçus du serveur. */
  function configure(next = {}) {
    if (next.timezone) settings.timezone = next.timezone;
    if (next.timeFormat) settings.timeFormat = next.timeFormat;
    if (next.dateFormat) settings.dateFormat = next.dateFormat;
    settings.gravatarEnabled = !!next.gravatarEnabled;
    return settings;
  }

  /**
   * SQLite stocke « YYYY-MM-DD HH:MM:SS » en UTC, sans suffixe : on le rend
   * explicite avant parsing, sinon le navigateur l'interpréterait en heure
   * locale et décalerait tout.
   */
  function parse(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const text = String(value).trim();
    const iso = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)
      ? `${text.replace(' ', 'T')}${/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? '' : 'Z'}`
      : text;

    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** Composantes de la date dans le fuseau configuré. */
  function zoned(date) {
    const parts = {};
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;
    return parts;
  }

  /** Date seule, dans le format choisi par l'administrateur. */
  function date(value, fallback = '—') {
    const parsed = parse(value);
    if (!parsed) return fallback;
    const p = zoned(parsed);
    if (settings.dateFormat === 'YYYY-MM-DD') return `${p.year}-${p.month}-${p.day}`;
    if (settings.dateFormat === 'MM/DD/YYYY') return `${p.month}/${p.day}/${p.year}`;
    return `${p.day}/${p.month}/${p.year}`;
  }

  /** Heure seule, en 24 h ou 12 h AM/PM. */
  function time(value, fallback = '—') {
    const parsed = parse(value);
    if (!parsed) return fallback;
    if (settings.timeFormat === '12') {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(parsed);
    }
    const p = zoned(parsed);
    return `${p.hour}:${p.minute}`;
  }

  function dateTime(value, fallback = '—') {
    const parsed = parse(value);
    if (!parsed) return fallback;
    return `${date(parsed)} ${time(parsed)}`;
  }

  /** Date exacte pour une infobulle (title=""). */
  function exact(value) {
    const parsed = parse(value);
    if (!parsed) return '';
    return `${dateTime(parsed)} (${settings.timezone})`;
  }

  /** « il y a 3 h », « hier », « il y a 2 mois »… */
  function relative(value, fallback = 'jamais') {
    const parsed = parse(value);
    if (!parsed) return fallback;

    const diff = Date.now() - parsed.getTime();
    const future = diff < 0;
    const abs = Math.abs(diff);

    const minutes = Math.floor(abs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    let text;
    if (minutes < 1) text = "à l'instant";
    else if (minutes < 60) text = `${minutes} min`;
    else if (hours < 24) text = `${hours} h`;
    else if (days === 1) text = future ? 'demain' : 'hier';
    else if (days < 30) text = `${days} j`;
    else if (months < 12) text = `${months} mois`;
    else text = `${years} an${years > 1 ? 's' : ''}`;

    if (text === "à l'instant" || text === 'hier' || text === 'demain') return text;
    return future ? `dans ${text}` : `il y a ${text}`;
  }

  /** Durée en secondes → « 3 j 4 h », pour les uptimes. */
  function duration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days} j ${hours} h`;
    if (hours) return `${hours} h ${minutes} min`;
    return `${minutes} min`;
  }

  function bytes(value) {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} o`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} Ko`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
    if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} Go`;
    return `${(n / 1024 ** 4).toFixed(2)} To`;
  }

  function number(value) {
    return Number(value || 0).toLocaleString('fr-FR');
  }

  return {
    settings,
    configure,
    parse,
    date,
    time,
    dateTime,
    exact,
    relative,
    duration,
    bytes,
    number,
  };
})();

/** Échappe le HTML : tout ce qui vient de la base passe par ici. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Avatar d'un compte : Gravatar si l'administrateur l'a autorisé ET que
 * l'adresse a une image, sinon les initiales colorées.
 *
 * Le repli est câblé sur `onerror` : si la requête échoue, expire ou renvoie
 * 404 (aucun avatar pour cette adresse), l'image se retire et les initiales
 * apparaissent. Le rendu de la page n'attend jamais Gravatar.
 */
function avatarHtml(user, { size = 40, className = '' } = {}) {
  const initials = esc(user?.initials || (user?.username || '··').slice(0, 2).toUpperCase());
  const background = user?.avatarColor ? `background:${esc(user.avatarColor)};` : '';
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size / 2.6)}px;${background}`;

  const image = user?.gravatarUrl
    ? `<img src="${esc(user.gravatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
             onload="this.parentNode.classList.add('has-image')"
             onerror="this.remove()">`
    : '';

  return `<span class="avatar ${esc(className)}" style="${style}"><span class="avatar-initials">${initials}</span>${image}</span>`;
}

/**
 * Le logo réel d'un service, posé par-dessus sa pastille à initiales.
 *
 * ─── Pourquoi une image PAR-DESSUS, et pas à la place ────────────────────────
 *
 * La pastille reste TOUJOURS dans le document ; l'image la recouvre quand elle
 * existe. Si le fichier manque, se corrompt ou ne se décode pas, `onerror`
 * retire l'image et les initiales réapparaissent, sans qu'aucun écran ait à
 * savoir que ça s'est produit. C'est le même repli que `avatarHtml`, et il
 * tient la promesse qui compte : **l'interface n'affiche jamais d'image
 * cassée.**
 *
 * Faire l'inverse — choisir entre les deux au rendu — obligerait à connaître
 * l'état du fichier au moment de composer le HTML, ce que le serveur ne peut
 * pas garantir et ce que le client ne peut pas deviner.
 *
 * L'adresse est TOUJOURS locale (`/api/connectors/logos/…`) : une fois
 * récupéré, un logo ne fait plus sortir crabe du réseau. Sans cette règle,
 * ouvrir l'accueil annoncerait à treize fournisseurs qu'on est là.
 *
 * ─── Récupéré, ou interne ────────────────────────────────────────────────────
 *
 * Un logo RÉCUPÉRÉ chez un fournisseur est dessiné pour du blanc : il se pose
 * sur un fond blanc, avec une marge. Une icône INTERNE — celle du stockage local, qui
 * n'a pas de site — est un tracé monochrome qui doit prendre la couleur de la
 * destination : elle se pose à même la pastille, sans fond. Le drapeau vient du
 * serveur (voir destinations/catalogue.js) ; la différence est purement
 * visuelle, et tout le reste est identique.
 *
 * @param {{logo?: string|null, logoInterne?: boolean}} connector
 * @returns {string} le fragment `<img>`, ou une chaîne vide
 */
function logoHtml(connector) {
  const src = connector?.logo;
  if (!src) return '';
  const classe = connector.logoInterne ? 'logo-img interne' : 'logo-img';
  return `<img class="${classe}" src="${esc(src)}" alt="" loading="lazy"
               onerror="this.remove()">`;
}

/**
 * Pose le logo et la couleur sur une pastille existante du document.
 *
 * Les modales portent leur pastille dans app.html : elles la remplissaient par
 * `textContent`, ce qui ne peut pas accueillir d'image. Un seul point de
 * passage évite d'en oublier une.
 */
function applyLogo(element, connector) {
  if (!element || !connector) return;
  element.style.background = connector.color;
  element.innerHTML = `${esc(connector.letters || '')}${logoHtml(connector)}`;
}

/**
 * L'ordre alphabétique des services, côté écran (lot 24).
 *
 * Le jumeau exact de `server/connectors/tri.js`, et il faut que les deux
 * restent d'accord : le serveur trie ce qu'il envoie, l'écran retrie ce qu'il
 * filtre, et deux règles différentes donneraient deux ordres différents sur le
 * même écran selon qu'on a tapé une recherche ou non.
 *
 *   - `sensitivity: 'base'` : « École » et « ecole » se rangent au même endroit ;
 *   - `numeric: true` : « Free 2 » avant « Free 10 » ;
 *   - langue française : É se range avec E, au lieu de partir après Z comme le
 *     ferait une comparaison brute de chaînes (`'École' < 'Edf'` est faux).
 *
 * Ne s'applique JAMAIS à ce qui est chronologique — journaux, historiques,
 * derniers documents.
 */
const TRI_OPTIONS = { sensitivity: 'base', numeric: true };

function comparerNoms(a, b) {
  const gauche = String(a ?? '').trim();
  const droite = String(b ?? '').trim();
  if (!gauche) return droite ? 1 : 0;
  if (!droite) return -1;
  return gauche.localeCompare(droite, 'fr', TRI_OPTIONS);
}

/** Trie une COPIE de la liste par nom affiché. */
function trierParNom(items, nomDe = (item) => item?.name) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => comparerNoms(nomDe(a), nomDe(b)));
}
