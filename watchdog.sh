#!/usr/bin/env bash
# ============================================================
#  EMMANUEL PANEL - Watchdog auto-reparant
#  Tourne en permanence (supervisord). Garantit :
#   1. qu'il n'existe QU'UNE seule instance du panel (pas de doublon
#      qui se disputerait le port 3000) ;
#   2. que le panel tourne (relance si arrete/plante) ;
#   3. que le fichier de tracking de la plateforme ne contient jamais
#      d'entree [program:3000_*] (source des doublons).
# ============================================================
TRACKED="/etc/supervisor/conf.d/_superninja_startup.conf"
SERVICE="emmanuel-panel"
LOG="/workspace/panel/data/watchdog.log"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

strip_tracked() {
  # Retire les sections [program:3000_*] du fichier de tracking.
  if [ -f "$TRACKED" ] && grep -q '^\[program:3000_' "$TRACKED" 2>/dev/null; then
    python3 - "$TRACKED" <<'PY'
import re, sys
p = sys.argv[1]
try:
    c = open(p).read()
except Exception:
    sys.exit(0)
parts = re.split(r'(?=\[program:)', c)
kept = [s for s in parts if not s.strip().startswith('[program:3000_')]
open(p, 'w').write(''.join(kept).strip() + '\n')
PY
    log "doublon 3000_* detecte -> suppression + reload supervisord"
    supervisorctl reread >/dev/null 2>&1
    supervisorctl update >/dev/null 2>&1
    supervisorctl stop 3000_node >/dev/null 2>&1
  fi
}

ensure_running() {
  if ! supervisorctl status "$SERVICE" 2>/dev/null | grep -q "RUNNING"; then
    log "panel non RUNNING -> demarrage"
    supervisorctl start "$SERVICE" >/dev/null 2>&1
  fi
}

log "watchdog demarre"
while true; do
  strip_tracked
  ensure_running
  sleep 20
done
