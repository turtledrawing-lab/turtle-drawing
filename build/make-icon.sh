#!/usr/bin/env bash
# Generate build/icon.icns from build/icon.svg using only macOS built-in tools.
# Requires: rsvg-convert (brew install librsvg)  OR  sips+qlmanage fallback.
set -euo pipefail
cd "$(dirname "$0")"

SRC="icon.svg"
OUT_DIR="icon.iconset"
rm -rf "$OUT_DIR" icon.icns
mkdir -p "$OUT_DIR"

# Render a given size from the SVG
render() {
  local size=$1 name=$2
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$SRC" -o "$OUT_DIR/$name"
  else
    # Fallback: render once at 1024 via qlmanage, then resize with sips.
    if [ ! -f _tmp_1024.png ]; then
      qlmanage -t -s 1024 -o . "$SRC" >/dev/null 2>&1 || true
      if [ -f "icon.svg.png" ]; then mv "icon.svg.png" _tmp_1024.png; fi
    fi
    sips -z "$size" "$size" _tmp_1024.png --out "$OUT_DIR/$name" >/dev/null
  fi
}

# Apple-required sizes (standard + @2x retina)
render 16    icon_16x16.png
render 32    icon_16x16@2x.png
render 32    icon_32x32.png
render 64    icon_32x32@2x.png
render 128   icon_128x128.png
render 256   icon_128x128@2x.png
render 256   icon_256x256.png
render 512   icon_256x256@2x.png
render 512   icon_512x512.png
render 1024  icon_512x512@2x.png

iconutil -c icns "$OUT_DIR" -o icon.icns
rm -rf "$OUT_DIR" _tmp_1024.png
echo "✔ build/icon.icns generated"
