#!/usr/bin/env bash
# ============================================================
#  EMMANUEL PANEL - demarrage robuste
#  Installe les dependances si besoin puis lance le serveur.
#  Utilise par supervisord (voir /etc/supervisor/conf.d/emmanuel-panel.conf).
# ============================================================
set -e
cd "$(dirname "$0")"

export PANEL_PORT="${PANEL_PORT:-3000}"
export NODE_ENV="${NODE_ENV:-production}"

# Installe les dependances si necessaire (premier lancement ou node_modules absent).
if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "[PANEL] Installation des dependances..."
  npm install --no-audit --no-fund || true
fi

echo "[PANEL] Demarrage sur le port $PANEL_PORT..."
exec node server.js
