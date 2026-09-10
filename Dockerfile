# syntax=docker/dockerfile:1

# crabe — image auto-suffisante : Node LTS, Chromium piloté (Playwright),
# l'écran en mémoire (Xvfb), le navigateur distant (x11vnc + websockify +
# noVNC) et rclone pour les destinations cloud.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc websockify novnc \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# L'application tourne sans privilège. Le HOME réel de ce compte est sous le
# volume de données (voir ENV plus bas) : Chromium exige un HOME inscriptible.
RUN useradd --system --create-home --home-dir /home/crabe --shell /usr/sbin/nologin crabe

WORKDIR /app

# Les navigateurs Playwright s'installent à un emplacement partagé, lisible
# par l'utilisateur applicatif — pas dans le HOME de root qui fait le build.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

# rclone officiel, version epinglee. Celui de Debian (1.60.1-DEV) est trop
# vieux pour Proton Drive (backend protondrive, rclone >= 1.64) et il est
# construit SANS le backend MEGA (dependance absente de l'archive Debian).
# Le binaire officiel embarque tous les backends ; /usr/local/bin passe avant
# /usr/bin dans le PATH, et la ligne apt ne l'installe plus.
# La variable ne s'appelle PAS « RCLONE_ quelque chose » : rclone lit toute
# variable d'environnement RCLONE_* comme un drapeau, et --version est
# booleen — le controle final du build s'etranglait sur notre propre ARG.
ARG VERSION_RCLONE=1.68.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://downloads.rclone.org/v${VERSION_RCLONE}/rclone-v${VERSION_RCLONE}-linux-${ARCH}.zip" -o /tmp/rclone.zip \
    && unzip -j /tmp/rclone.zip "*/rclone" -d /usr/local/bin \
    && chmod 755 /usr/local/bin/rclone \
    && rm /tmp/rclone.zip \
    && rm -rf /var/lib/apt/lists/* \
    && rclone version

COPY server/ server/
COPY web/ web/
COPY tools/ tools/
COPY VERSION LICENSE ./
COPY docker/entrypoint.sh /usr/local/bin/crabe-entrypoint
RUN chmod +x /usr/local/bin/crabe-entrypoint

# Tout ce qui doit survivre vit sous /data : base, secrets chiffrés, documents,
# profils de navigateur — et le HOME du navigateur lui-même.
ENV NODE_ENV=production \
    CRABE_DATA_DIR=/data \
    CRABE_LOCAL_PATH=/data/documents \
    HOME=/data/navigateur \
    CRABE_HOST=0.0.0.0 \
    CRABE_PORT=3000

EXPOSE 3000
VOLUME /data

# La route de santé publique de l'application (server/index.js, /api/sante).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/sante').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# L'entrypoint prépare /data, génère la phrase secrète au premier démarrage
# si elle manque, puis abandonne root avant de lancer l'application.
ENTRYPOINT ["crabe-entrypoint"]
CMD ["node", "server/index.js"]
