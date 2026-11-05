#!/bin/sh
cd "$(dirname "$0")/.." || exit 0
mkdir -p bots

for z in bots/*.zip; do
  [ -f "$z" ] || continue
  name=$(basename "$z" .zip | tr ' ' '-')
  echo "[build-bots] decompression de $z -> bots/$name"
  rm -rf "bots/$name"
  python3 - "$z" "bots/$name" <<'PY' || echo "[build-bots] ECHEC decompression $z"
import sys, os, shutil, zipfile, tempfile
src, dst = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp()
with zipfile.ZipFile(src) as zf:
    for n in zf.namelist():
        if n.startswith('__MACOSX') or '..' in n.split('/'):
            continue
        zf.extract(n, tmp)
items = [i for i in os.listdir(tmp) if i != '__MACOSX']
root = tmp
if len(items) == 1 and os.path.isdir(os.path.join(tmp, items[0])):
    root = os.path.join(tmp, items[0])
shutil.move(root, dst)
PY
  rm -f "$z"
done

if [ -f bots.txt ]; then
  while read -r name url branch rest; do
    case "$name" in ''|\#*) continue ;; esac
    [ -z "$url" ] && continue
    url=$(printf '%s' "$url" | sed "s|\${GITHUB_TOKEN}|${GITHUB_TOKEN:-}|")
    rm -rf "bots/$name"
    if [ -n "$branch" ]; then
      git clone --depth 1 -b "$branch" "$url" "bots/$name" || continue
    else
      git clone --depth 1 "$url" "bots/$name" || continue
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
