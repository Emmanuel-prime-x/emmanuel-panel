#!/usr/bin/env bash
# ============================================================
#  EMMANUEL PANEL - script de gestion du service (supervisord)
#  Le panel tourne EN ARRIERE-PLAN, gere par supervisord.
#  Usage : ./manage.sh {start|stop|restart|status|logs|url|health}
# ============================================================
set -euo pipefail

SERVICE="emmanuel-panel"
PORT="${PANEL_PORT:-3000}"
OUT_LOG="/workspace/panel/data/panel.out.log"
ERR_LOG="/workspace/panel/data/panel.err.log"

cmd="${1:-status}"

case "$cmd" in
  start)
    supervisorctl start "$SERVICE"
    ;;
  stop)
    supervisorctl stop "$SERVICE"
    ;;
  restart)
    supervisorctl restart "$SERVICE"
    ;;
  status)
    supervisorctl status "$SERVICE" || true
    echo -n "Port $PORT : "
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "en ecoute"
    else
      echo "libre (le panel n'ecoute pas)"
    fi
    ;;
  logs)
    tail -n 120 -f "$OUT_LOG" "$ERR_LOG"
    ;;
  url)
    curl -sS "http://localhost:$PORT/api/me" \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('publicUrl') or '(tunnel indisponible)')"
    ;;
  health)
    curl -sS "http://localhost:$PORT/api/health" | python3 -m json.tool
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|url|health}"
    exit 1
    ;;
esac
