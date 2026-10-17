# ============================================================================
#  EMMANUEL PANEL - Image Docker pour Render (offre GRATUITE, SANS carte bancaire)
# ----------------------------------------------------------------------------
#  Render construit cette image automatiquement a chaque deploiement.
#  Le panel ecoute sur la variable PORT fournie par Render (10000 par defaut).
#  Le tunnel Cloudflare interne est DESACTIVE (PANEL_TUNNEL=0) : Render fournit
#  deja une URL HTTPS publique permanente.
# ============================================================================
FROM node:20-bookworm-slim

WORKDIR /app

# --- Outils systeme requis par les bots WhatsApp/Telegram ---
# * git + ca-certificates : INDISPENSABLES. Beaucoup de bots (Baileys, etc.)
#   declarent des dependances "github:..." / "git+https://...". Sans git,
#   npm echoue avec "spawn git ENOENT" et les dependances ne s'installent pas.
# * python3 / make / g++ : compilation des modules natifs (sharp, canvas, sqlite3...).
# * ffmpeg / imagemagick / webp : stickers, conversion audio/video, images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl \
      python3 make g++ \
      ffmpeg imagemagick webp \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --system --add url."https://github.com/".insteadOf "git@github.com:" \
 && git config --system --add url."https://github.com/".insteadOf "git://github.com/"

# --- Dependances (couche mise en cache par Docker) ---
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# --- Code du panel ---
COPY . .

# --- Dossiers de donnees (recreees au demarrage si besoin) ---
RUN mkdir -p data servers data/uploads data/pids data/home data/npm-cache

ENV NODE_ENV=production \
    PANEL_TUNNEL=0 \
    HOME=/app/data/home \
    npm_config_cache=/app/data/npm-cache \
    GIT_TERMINAL_PROMPT=0

# Render route le trafic vers le port $PORT (10000 par defaut).
EXPOSE 10000

# Redemarrage automatique gere par Render (plan gratuit inclus).
CMD ["node", "server.js"]
