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

# --- Dependances (couche mise en cache par Docker) ---
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# --- Code du panel ---
COPY . .

# --- Dossiers de donnees (recreees au demarrage si besoin) ---
RUN mkdir -p data servers data/uploads data/pids

ENV NODE_ENV=production \
    PANEL_TUNNEL=0

# Render route le trafic vers le port $PORT (10000 par defaut).
EXPOSE 10000

# Redemarrage automatique gere par Render (plan gratuit inclus).
CMD ["node", "server.js"]
