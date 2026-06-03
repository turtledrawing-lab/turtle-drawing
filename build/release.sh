#!/usr/bin/env bash
# Turtle Drawing — one-shot macOS release: build → notarize → staple → (install).
#
# WHY THIS EXISTS: electron-builder's built-in notarization fails in this
# project ("Error: HTTP … not valid JSON"), so we build with notarize DISABLED
# and notarize the DMGs ourselves with notarytool. The committed build/icon.icns
# is used as-is (make-icon.sh no-ops when build/icon.svg is absent).
#
# Apple credentials are read ONLY from the environment and are never written to
# any file. Provide them inline when invoking:
#
#   APPLE_ID="you@example.com" \
#   APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
#   APPLE_TEAM_ID="XXXXXXXXXX" \
#   bash build/release.sh [--install] [--no-notarize]
#
# Flags:
#   --install      after notarizing, replace /Applications/Turtle Drawing.app
#                  with the arm64 build (this Mac is Apple Silicon / arm64).
#   --no-notarize  build only; skip notarize + staple (quick local check,
#                  needs no Apple credentials).
#
# After this finishes, publish manually (kept manual to avoid accidental
# publishes — the command is printed at the end):
#   gh release create vX.Y.Z "<arm64 dmg>" "<x64 dmg>" --title "..." --notes "..."
set -euo pipefail
cd "$(dirname "$0")/.."

DO_INSTALL=0
DO_NOTARIZE=1
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --no-notarize) DO_NOTARIZE=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
APP="Turtle Drawing"
DMG_ARM="dist/${APP}-${VERSION}-arm64.dmg"
DMG_X64="dist/${APP}-${VERSION}-x64.dmg"

echo "▶ Building ${APP} ${VERSION} (electron-builder's notarize step disabled)…"
# Builds arm64 + x64 DMGs (and zips, per package.json). We notarize the DMGs.
npx electron-builder --mac -c.mac.notarize=false

for f in "$DMG_ARM" "$DMG_X64"; do
  [ -f "$f" ] || { echo "❌ expected DMG missing: $f" >&2; exit 1; }
done
echo "✔ Built: $DMG_ARM, $DMG_X64"

if [ "$DO_NOTARIZE" = "1" ]; then
  : "${APPLE_ID:?set APPLE_ID (Apple ID email)}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?set APPLE_APP_SPECIFIC_PASSWORD (app-specific password)}"
  : "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (10-char team id)}"
  for f in "$DMG_ARM" "$DMG_X64"; do
    echo "▶ Notarizing $f …"
    xcrun notarytool submit "$f" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    echo "▶ Stapling $f …"
    xcrun stapler staple "$f"
    xcrun stapler validate "$f"
  done
  echo "✔ Notarized + stapled both DMGs"
else
  echo "⏭  Skipped notarize/staple (--no-notarize); DMGs are NOT distributable."
fi

if [ "$DO_INSTALL" = "1" ]; then
  echo "▶ Installing arm64 build to /Applications …"
  MP="$(mktemp -d /tmp/td-mount.XXXXXX)"
  hdiutil attach "$DMG_ARM" -nobrowse -noautoopen -mountpoint "$MP"
  rm -rf "/Applications/${APP}.app"
  ditto "$MP/${APP}.app" "/Applications/${APP}.app"
  hdiutil detach "$MP" -quiet 2>/dev/null || hdiutil detach "$MP" || true
  rmdir "$MP" 2>/dev/null || true
  echo "✔ Installed /Applications/${APP}.app (${VERSION})"
fi

echo ""
echo "🎉 Release ${VERSION} ready in dist/"
echo "   Publish (manual): gh release create v${VERSION} \\"
echo "     \"$DMG_ARM\" \"$DMG_X64\" \\"
echo "     --title \"${APP} ${VERSION}\" --notes \"…\""
