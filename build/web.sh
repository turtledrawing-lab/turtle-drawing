#!/usr/bin/env bash
# Turtle Drawing — static WEB build into dist-web/.
#
# The renderer is already browser-ready: every Electron IPC call site is
# guarded with `if (window.electronX) ... else <web fallback>`, all asset
# paths are relative, and the in-HTML #menubar (hidden under Electron by
# preload.js) reappears automatically in a browser. So the "build" is just:
#   1. copy turtle_drawing.html → dist-web/index.html with a version stamp
#      (<meta name="td-version">) and per-deploy cache-busting (?v=<sha>)
#      on the local <script>/<link> tags,
#   2. copy ad/ and vendor/ as-is,
#   3. emit a _headers file (Cloudflare Pages / Netlify cache hints).
# Electron files (main.js, preload.js, splash.html, node_modules) are simply
# never copied. electron-builder keeps consuming the same source tree.
#
# Usage:  bash build/web.sh        (or: npm run build:web)
# Test:   cd dist-web && python3 -m http.server 8080
#         open http://localhost:8080/?dev=1&selftest=1
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
OUT="dist-web"

rm -rf "$OUT"
mkdir -p "$OUT"

TD_VER="$VERSION" TD_SHA="$SHA" node -e '
const fs = require("fs");
let s = fs.readFileSync("turtle_drawing.html", "utf8");
const stamp = process.env.TD_VER + "+" + process.env.TD_SHA;
// Version stamp — surfaced in bug reports / error logs.
s = s.replace("</title>", "</title>\n<meta name=\"td-version\" content=\"" + stamp + "\">"
  + "\n<link rel=\"manifest\" href=\"manifest.webmanifest\">"
  + "\n<meta name=\"theme-color\" content=\"#f6f6f6\">");
// Cache-bust the boot scripts/styles per deploy (runtime-fetched assets like
// rhino3dm.wasm / entourage SVGs / typefaces rely on the SW runtime cache).
s = s.replace(/(src|href)="((?:ad|vendor)\/[^"?]+)"/g,
  (m, attr, p) => attr + "=\"" + p + "?v=" + process.env.TD_SHA + "\"");
fs.writeFileSync("dist-web/index.html", s);

// Service worker: stamp the deploy sha and the PRECACHE list — the core boot
// payload exactly as the page will request it (script/link URLs incl. ?v=)
// plus the woff2 UI fonts referenced from CSS (no ?v). Heavy on-demand assets
// (entourage SVGs, rhino3dm.wasm, typefaces, NanumGothic) runtime-cache.
const urls = ["./"];
const re = /(?:src|href)="((?:ad|vendor)\/[^"]+)"/g;
const html = fs.readFileSync("dist-web/index.html", "utf8");
let m;
while ((m = re.exec(html))) urls.push(m[1]);
for (const f of fs.readdirSync("vendor/fonts")) {
  if (f.endsWith(".woff2")) urls.push("vendor/fonts/" + f);
}
let sw = fs.readFileSync("web/sw.js", "utf8");
// split/join: the placeholders also appear in the header comment — a plain
// .replace() only hits the first occurrence and leaves the real one intact.
sw = sw.split("__TD_SHA__").join(process.env.TD_SHA);
sw = sw.split("__TD_PRECACHE__").join(JSON.stringify([...new Set(urls)], null, 0));
fs.writeFileSync("dist-web/sw.js", sw);
'

cp -R ad "$OUT/ad"
cp -R vendor "$OUT/vendor"
cp web/manifest.webmanifest "$OUT/manifest.webmanifest"
cp web/desktop-picker.html "$OUT/desktop-picker.html"
cp i18n-menu.json "$OUT/i18n-menu.json"
cp -R web/icons "$OUT/icons"

# Cache policy for Cloudflare Pages / Netlify (other hosts ignore this file).
# HTML revalidates every load; assets cache for a day (safe without content
# hashing — a deploy propagates within 24h, ?v= covers the boot-critical tags).
cat > "$OUT/_headers" <<'EOF'
/index.html
  Cache-Control: no-cache
/ad/*
  Cache-Control: public, max-age=86400
/vendor/*
  Cache-Control: public, max-age=86400
EOF

SIZE="$(du -sh "$OUT" | cut -f1)"
echo "✔ Web build at $OUT/  (td-version ${VERSION}+${SHA}, ${SIZE})"
echo "  Local test:  cd $OUT && python3 -m http.server 8080"
echo "  Self-test:   http://localhost:8080/?dev=1&selftest=1"
