#!/bin/sh
# ============================================================================
#  Execute PENDANT LE BUILD Docker (machine puissante de Render, pas l'instance
#  gratuite a 0,1 CPU) :
#    1) clone chaque depot liste dans bots.txt   ->  bots/<nom>/
#    2) lance "npm install" dans chaque dossier de bots/
#  Un echec sur un bot n'arrete JAMAIS le build (les autres bots restent OK).
# ============================================================================
cd "$(dirname "$0")/.." || exit 0
mkdir -p bots

if [ -f bots.txt ]; then
  while read -r name url branch rest; do
    case "$name" in ''|\#*) continue ;; esac
    [ -z "$url" ] && { echo "[build-bots] ligne ignoree (URL manquante) : $name"; continue; }
    # ${GITHUB_TOKEN} dans l'URL = jeton fourni par la variable Render (depot prive)
    url=$(printf '%s' "$url" | sed "s|\${GITHUB_TOKEN}|${GITHUB_TOKEN:-}|")
    echo "[build-bots] clone de $name"
    rm -rf "bots/$name"
    if [ -n "$branch" ]; then
      git clone --depth 1 -b "$branch" "$url" "bots/$name" || { echo "[build-bots] ECHEC clone $name"; continue; }
    else
      git clone --depth 1 "$url" "bots/$name" || { echo "[build-bots] ECHEC clone $name"; continue; }
    fi
    rm -rf "bots/$name/.git"
  done < bots.txt
fi

for d in bots/*/; do
  [ -f "${d}package.json" ] || continue
  echo "[build-bots] npm install dans $d"
  (
    cd "$d" || exit 0
    npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
      || npm install --omit=dev --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
      || echo "[build-bots] ECHEC npm install dans $d"
  )
done
echo "[build-bots] termine."
exit 0
