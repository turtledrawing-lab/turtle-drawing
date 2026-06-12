#!/usr/bin/env bash
# Turtle Drawing — ONE-SHOT release for BOTH channels:
#   macOS  : build → notarize → staple → install to /Applications → GitHub release
#   Web    : build dist-web/ → deploy to Cloudflare Pages
#
# Usage:
#   APPLE_ID="you@example.com" \
#   APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
#   APPLE_TEAM_ID="XXXXXXXXXX" \
#   bash build/release-all.sh [<new-version>]        # or: npm run release:all
#
#   <new-version>  optional, e.g. 1.0.0-beta.5 — bumps package.json + commits
#                  "v<version>" first. Omit to re-ship the current version.
#
# One-time setup (each prints clear instructions if missing):
#   npx wrangler login        # Cloudflare account for Pages deploys
#   gh auth login             # GitHub CLI for the release upload
#
# Web project name defaults to "turtle-drawing" (→ turtle-drawing.pages.dev);
# override with TD_PAGES_PROJECT=<name> if your Pages project is named
# differently. Apple credentials are read from the environment ONLY and are
# never written anywhere (same policy as release.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${TD_PAGES_PROJECT:-turtle-drawing}"

echo "── Preflight ──────────────────────────────────────────────"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Uncommitted changes in the working tree — commit (or stash) first," >&2
  echo "   so the release is reproducible from a known commit." >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "❌ GitHub CLI (gh) not found — brew install gh && gh auth login" >&2; exit 1; }
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "❌ Cloudflare not authenticated — run once:  npx wrangler login" >&2
  exit 1
fi
: "${APPLE_ID:?set APPLE_ID (Apple ID email — needed to notarize the DMGs)}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?set APPLE_APP_SPECIFIC_PASSWORD}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

if [ "${1:-}" != "" ]; then
  echo "── Version bump → $1 ──────────────────────────────────────"
  npm version "$1" --no-git-tag-version
  git add package.json
  git add package-lock.json 2>/dev/null || true
  git commit -m "v$1"
fi
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
DMG_ARM="dist/Turtle Drawing-${VERSION}-arm64.dmg"
DMG_X64="dist/Turtle Drawing-${VERSION}-x64.dmg"

echo "── Push source (main) ─────────────────────────────────────"
git push origin main

echo "── macOS: build + notarize + install (release.sh) ─────────"
bash build/release.sh --install

echo "── GitHub release $TAG ────────────────────────────────────"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "⚠ Release $TAG already exists — skipping creation (assets unchanged)."
else
  gh release create "$TAG" "$DMG_ARM" "$DMG_X64" \
    --title "Turtle Drawing $VERSION" \
    --generate-notes
fi

echo "── Web: build + deploy to Cloudflare Pages ($PROJECT) ─────"
bash build/web.sh
npx wrangler pages deploy dist-web --project-name="$PROJECT"

echo ""
echo "✅ $VERSION shipped on both channels:"
echo "   • /Applications/Turtle Drawing.app  (installed)"
echo "   • https://github.com/turtledrawing-lab/turtle-drawing/releases/tag/$TAG"
echo "   • https://${PROJECT}.pages.dev  (live web — open tabs get the update toast)"
