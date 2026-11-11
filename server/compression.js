'use strict';

/**
 * La compression des réponses, faite par crabe lui-même (0.2.24).
 *
 * Derrière un mandataire qui compresse (Caddy et son `encode`), l'interface
 * voyageait déjà quatre fois plus légère. Mais toutes les installations n'en
 * ont pas : servi en direct sur son port, crabe envoyait ses 490 Ko de
 * `app.js` tels quels. Il compresse désormais ce qui s'y prête, avec le seul
 * `zlib` de Node :
 *
 *   - les fichiers de l'interface (scripts, feuille de style, pages, dessins
 *     vectoriels) — compressés une fois, au démarrage, gardés en mémoire,
 *     refaits si le fichier change. Personne n'attend une compression : tant
 *     qu'elle n'est pas prête, le fichier part en clair ;
 *   - les réponses de l'API et les pages, au moment de les envoyer.
 *
 * Ce qui n'y passe pas, exprès : les PDF, les archives et tout ce qui se
 * télécharge (déjà compressés, ou attendus octet pour octet), les images, la
 * fenêtre de connexion (la fenêtre visible et sa WebSocket) et les réponses écrites au fil
 * de l'eau — seules celles qui partent par `res.send` ou `res.json` sont vues.
 *
 * Un mandataire placé devant ne recompresse pas : une réponse qui porte déjà
 * `Content-Encoding` traverse telle quelle. Un client qui n'annonce ni `br`
 * ni `gzip` reçoit la réponse en clair, comme avant.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** En dessous, l'en-tête pèse plus que le gain. */
const SEUIL = 1024;

/** Les fichiers de l'interface qui se compressent (les images le sont déjà). */
const FICHIER_COMPRESSIBLE = /^\/[\w.-]+\.(?:js|css|html|svg)$/;

/** Les types de réponse qui se compressent. */
const TYPE_COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)\b|image\/svg\+xml)/i;

const optionsBrotli = (qualite, taille) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: qualite,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: taille,
  },
});

/**
 * L'encodage à employer pour ce client : `br` s'il l'accepte, sinon `gzip`,
 * sinon rien. Un encodage refusé (`;q=0`) n'est pas employé.
 *
 * @param {string|undefined} accepte l'en-tête `Accept-Encoding`
 * @returns {'br'|'gzip'|null}
 */
function encodagePour(accepte) {
  const admis = new Set();
  for (const morceau of String(accepte || '').toLowerCase().split(',')) {
    const [nom, ...parametres] = morceau.trim().split(';').map((s) => s.trim());
    const q = parametres.find((p) => p.startsWith('q='));
    if (nom && !(q && Number(q.slice(2)) === 0)) admis.add(nom);
  }
  if (admis.has('br')) return 'br';
  if (admis.has('gzip')) return 'gzip';
  return null;
}

/**
 * Sert compressés les fichiers de l'interface. À monter juste AVANT le
 * `express.static` du même dossier, qui garde tout le reste : les images, un
 * client sans compression, une demande partielle (`Range`), un fichier absent.
 *
 * Chaque fichier est compressé une fois par encodage et gardé en mémoire tant
 * que sa taille et sa date ne bougent pas. Une demande n'attend jamais : si la
 * version compressée n'est pas prête (première demande sans préparation,
 * fichier qui vient de changer), elle se prépare à côté et le fichier part en
 * clair cette fois-là. `preparer()` fait tout le dossier d'avance — crabe
 * l'appelle une fois qu'il écoute.
 *
 * @param {string} dossier
 * @param {{cache?: (req: import('express').Request) => string}} [options]
 *   `cache` : la valeur de `Cache-Control`, la même que celle du service en clair
 * @returns {import('express').RequestHandler & {preparer: () => Promise<number>}}
 */
function fichiers(dossier, { cache = () => 'public, max-age=0' } = {}) {
  /** @type {Map<string, {empreinte: string, octets: Buffer|null, corps: Promise<Buffer>}>} */
  const memoire = new Map();

  const compresse = (nom, encodage, etat) => {
    const cle = `${nom}\n${encodage}`;
    const empreinte = `${etat.size.toString(16)}-${Math.floor(etat.mtimeMs).toString(16)}`;
    const garde = memoire.get(cle);
    if (garde && garde.empreinte === empreinte) return garde;
    const corps = fs.promises.readFile(path.join(dossier, nom)).then((brut) => (
      // Qualité 9 : à 7 % du maximum, pour quinze fois moins de temps — la
      // première page ne doit attendre personne, même sur une petite machine.
      encodage === 'br' ? brotli(brut, optionsBrotli(9, brut.length)) : gzip(brut, { level: 9 })
    ));
    const entree = { empreinte, octets: null, corps };
    memoire.set(cle, entree);
    corps.then((octets) => { entree.octets = octets; }, () => memoire.delete(cle));
    return entree;
  };

  const servir = async (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !FICHIER_COMPRESSIBLE.test(req.path)) {
      return next();
    }
    // La réponse dépend de ce que le client accepte : un cache partagé doit le savoir.
    res.vary('Accept-Encoding');
    const encodage = encodagePour(req.headers['accept-encoding']);
    if (!encodage || req.headers.range) return next();
    try {
      const nom = req.path.slice(1);
      const etat = await fs.promises.stat(path.join(dossier, nom));
      if (!etat.isFile() || etat.size < SEUIL) return next();
      const { empreinte, octets } = compresse(nom, encodage, etat);
      if (!octets) return next(); // pas encore prête : en clair cette fois-ci
      res.type(path.extname(nom));
      res.setHeader('Content-Encoding', encodage);
      res.setHeader('Cache-Control', cache(req));
      res.setHeader('Last-Modified', etat.mtime.toUTCString());
      res.setHeader('ETag', `W/"${empreinte}-${encodage}"`);
      if (req.fresh) return res.status(304).end();
      res.setHeader('Content-Length', octets.length);
      return res.end(req.method === 'HEAD' ? undefined : octets);
    } catch {
      // Fichier absent ou illisible : le service en clair répondra ce qu'il doit.
      return next();
    }
  };

  /**
   * Compresse d'avance tout le dossier, un fichier après l'autre (le démarrage
   * ne doit pas accaparer la machine).
   * @returns {Promise<number>} le nombre de fichiers préparés
   */
  servir.preparer = async () => {
    let prepares = 0;
    for (const nom of await fs.promises.readdir(dossier)) {
      if (!FICHIER_COMPRESSIBLE.test(`/${nom}`)) continue;
      const etat = await fs.promises.stat(path.join(dossier, nom));
      if (!etat.isFile() || etat.size < SEUIL) continue;
      for (const encodage of ['br', 'gzip']) await compresse(nom, encodage, etat).corps;
      prepares += 1;
    }
    return prepares;
  };

  return servir;
}

/**
 * Compresse les réponses envoyées par `res.send` et `res.json` : l'API et les
 * pages. Le reste (`res.download`, `res.sendFile`, un flux, la WebSocket) ne
 * passe pas par là et part tel quel.
 *
 * @param {{seuil?: number}} [options]
 * @returns {import('express').RequestHandler}
 */
function reponses({ seuil = SEUIL } = {}) {
  return (req, res, next) => {
    const envoyer = res.send;
    res.send = function envoyerCompresse(corps) {
      // Un objet repart par `res.json`, qui rappelle `send` avec son texte.
      if (typeof corps !== 'string' && !Buffer.isBuffer(corps)) return envoyer.call(this, corps);
      try {
        if (typeof corps === 'string' && !this.get('Content-Type')) this.type('html');
        const type = String(this.get('Content-Type') || '');
        const taille = Buffer.byteLength(corps);
        const compressible = taille >= seuil
          && TYPE_COMPRESSIBLE.test(type)
          && this.statusCode !== 204 && this.statusCode !== 304
          && !this.get('Content-Encoding')
          && !this.get('Content-Disposition')
          && !/no-transform/i.test(String(this.get('Cache-Control') || ''));
        if (!compressible) return envoyer.call(this, corps);
        this.vary('Accept-Encoding');
        const encodage = encodagePour(req.headers['accept-encoding']);
        if (!encodage) return envoyer.call(this, corps);
        // Qualité 4 : aussi serré que gzip, en une à deux millisecondes pour
        // une réponse ordinaire — la réponse n'attend pas sa compression.
        const brut = Buffer.isBuffer(corps) ? corps : Buffer.from(corps, 'utf8');
        const octets = encodage === 'br'
          ? zlib.brotliCompressSync(brut, optionsBrotli(4, taille))
          : zlib.gzipSync(brut, { level: 6 });
        this.setHeader('Content-Encoding', encodage);
        return envoyer.call(this, octets);
      } catch {
        // La compression ne doit jamais coûter une réponse.
        this.removeHeader('Content-Encoding');
        return envoyer.call(this, corps);
      }
    };
    next();
  };
}

module.exports = { SEUIL, encodagePour, fichiers, reponses };
