#!/usr/bin/env bash
# Run the .skp → .glb conversion server on macOS, using the local SketchUp SDK
# runtime in ./runtime-macos/ (sketchup.so + SketchUpAPI.framework — proprietary,
# gitignored). The web app (tdw.kr or http://localhost) POSTs a .skp here and
# renders the returned INSTANCED glb (shared geometry, full depth).
#
#   bash tools/skp-server/serve-macos.sh                 # port 8787, CORS *
#   bash tools/skp-server/serve-macos.sh --port 9000 --origin https://tdw.kr
#   npm run skp:serve
#
# Then in the web app:
#   • http://localhost:…  → the .skp menu auto-enables (endpoint defaults to
#     http://localhost:8787/convert).
#   • https://tdw.kr      → visit once with  tdw.kr/?skp=http://localhost:8787/convert
#     to enable the menu (Chrome treats http://localhost as a secure origin, so
#     the https→localhost upload is allowed; use Chrome).
#
# Python must match a binding built for it (here: python@3.10). Override with
# TD_SKP_PYTHON=/path/to/python3.x.
set -euo pipefail
cd "$(dirname "$0")/runtime-macos"
PY="${TD_SKP_PYTHON:-/opt/homebrew/opt/python@3.10/bin/python3.10}"
if [ ! -f sketchup.so ]; then
  echo "❌ runtime-macos/sketchup.so missing — the SketchUp SDK runtime is not installed here." >&2
  echo "   (It is proprietary + gitignored; place the macOS binding in tools/skp-server/runtime-macos/.)" >&2
  exit 1
fi
echo "▶ .skp conversion server — http://localhost:8787  (Ctrl-C to stop)"
exec env PYTHONPATH="$PWD" "$PY" server.py "$@"
