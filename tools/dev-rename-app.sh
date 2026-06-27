#!/usr/bin/env bash
# Dev-only: rename the bundled Electron.app to "Turtle Drawing.app" so the macOS
# menu bar / Dock / About panel show the real product name while running
# `npm start` (electron .). The dev launcher detects dev via process.defaultApp
# (NOT app.isPackaged), so the rename is safe — see main.js ~L702.
#
# Re-run this after any `npm install` or electron reinstall, which resets the
# bundle back to "Electron.app". Idempotent.
set -euo pipefail

DIST="$(cd "$(dirname "$0")/.." && pwd)/node_modules/electron/dist"
SRC="$DIST/Electron.app"
DST="$DIST/Turtle Drawing.app"
NAME="Turtle Drawing"

if [ -d "$DST" ] && [ -x "$DST/Contents/MacOS/$NAME" ]; then
  echo "[dev-rename] already '$NAME.app' — nothing to do"
else
  if [ ! -d "$SRC" ]; then
    echo "[dev-rename] ERROR: $SRC not found. Run: node node_modules/electron/install.js" >&2
    exit 1
  fi
  echo "[dev-rename] renaming executable + bundle, patching Info.plist…"
  mv "$SRC/Contents/MacOS/Electron" "$SRC/Contents/MacOS/$NAME"
  PL="$SRC/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$PL"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$PL"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $NAME" "$PL"
  mv "$SRC" "$DST"
fi

echo "[dev-rename] re-signing (ad-hoc)…"
codesign --force --deep --sign - "$DST" 2>/dev/null
codesign --verify --strict "$DST" && echo "[dev-rename] signature OK"

printf '%s' "Turtle Drawing.app/Contents/MacOS/$NAME" > "$DIST/../path.txt"
echo "[dev-rename] path.txt -> $(cat "$DIST/../path.txt")"
echo "[dev-rename] done."
