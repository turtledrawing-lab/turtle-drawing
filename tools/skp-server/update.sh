#!/usr/bin/env bash
# Deploy the latest conversion-server code to the dedicated server Mac.
#
# The server actually runs server.py/convert.py from the gitignored runtime-macos/
# (see serve-macos.sh — it cds there and sets PYTHONPATH=$PWD), so a plain
# `git pull` ISN'T enough: the pulled tools/skp-server/*.py must be copied in.
# This pulls, syncs, restarts the agent, and verifies /health.
#
#   bash tools/skp-server/update.sh        (or: npm run skp:update)
set -euo pipefail
cd "$(dirname "$0")/../.."                 # repo root
SRC="tools/skp-server"; RT="$SRC/runtime-macos"

echo "▶ git pull…"
git pull --ff-only

if [ -d "$RT" ] && [ -f "$RT/sketchup.so" ]; then
  cp -f "$SRC/server.py" "$SRC/convert.py" "$RT/"
  echo "▶ synced server.py + convert.py → runtime-macos/"
else
  echo "⚠ runtime-macos/ (SketchUp SDK) not found here — this isn't the server Mac. Skipping sync/restart."
  exit 0
fi

echo "▶ restart kr.tdw.skpserver…"
launchctl kickstart -k "gui/$(id -u)/kr.tdw.skpserver" || echo "  (kickstart failed — agent bootstrapped? launchctl list | grep tdw)"
sleep 6
if curl -fsS --max-time 15 http://localhost:8787/health >/dev/null 2>&1; then
  echo "  ✅ local /health OK"
else
  echo "  ❌ not healthy yet — tail ~/Library/Logs/skp-server.log"
fi
