#!/usr/bin/env bash
# Turtle Drawing — ONE-SHOT release for BOTH channels:
#   macOS  : build → notarize → staple → install to /Applications → GitHub release
#   Web    : automatic — Cloudflare Pages is connected to the GitHub repo and
#            builds/deploys on every push to main (build: bash build/web.sh →
#            dist-web → https://turtle-drawing.pages.dev). The `git push` step
#            below IS the web deploy; no wrangler needed.
#
# Usage:
#   APPLE_ID="you@example.com" \
#   APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
#   APPLE_TEAM_ID="XXXXXXXXXX" \
#   bash build/release-all.sh [<new-version>]        # or: npm run release:all
#
#   <new-version>  optional, e.g. 1.0.0-beta.6 — bumps package.json + commits
#                  "v<version>" first. Omit to re-ship the current version.
#
# One-time setup: gh auth login (GitHub CLI, for the release upload).
# Apple credentials are read from the environment ONLY and are never written
# anywhere (same policy as release.sh).
#
# Web-only update? Just commit + push — Cloudflare rebuilds automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── Preflight ──────────────────────────────────────────────"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Uncommitted changes in the working tree — commit (or stash) first," >&2
  echo "   so the release is reproducible from a known commit." >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "❌ GitHub CLI (gh) not found — brew install gh && gh auth login" >&2; exit 1; }
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

echo "── Push source (main) — this also triggers the web deploy ──"
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

echo ""
echo "✅ $VERSION shipped on both channels:"
echo "   • /Applications/Turtle Drawing.app  (installed)"
echo "   • https://github.com/turtledrawing-lab/turtle-drawing/releases/tag/$TAG"
echo "   • https://turtle-drawing.pages.dev  (Cloudflare builds from the push — check the"
echo "     Deployments tab if it hasn't switched over yet; open tabs get an update toast)"
