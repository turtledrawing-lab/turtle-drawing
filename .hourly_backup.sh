#!/bin/bash
# Hourly backup of turtle drawing project.
# Creates a timestamped copy at ~/turtle drawing.backups/YYYY-MM-DD_HH-MM/
# Keeps only the most recent 48 backups (≈ 2 days).
SRC="/Users/sooyonghwang/turtle drawing"
DST_ROOT="/Users/sooyonghwang/turtle drawing.backups"
TS="$(date +%Y-%m-%d_%H-%M)"
DST="$DST_ROOT/$TS"
mkdir -p "$DST_ROOT"
# rsync excludes node_modules, build outputs, the backups dir itself, .git pack files
rsync -a \
  --exclude 'node_modules/' \
  --exclude '.backups/' \
  --exclude '*.log' \
  --exclude 'Turtle Drawing-darwin-*' \
  "$SRC/" "$DST/"
# Prune: keep only the latest 48 entries (sorted by name = chronological)
cd "$DST_ROOT" || exit 0
COUNT=$(ls -1d 2*-*-*_* 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt 48 ]; then
  REMOVE=$((COUNT - 48))
  ls -1d 2*-*-*_* 2>/dev/null | sort | head -n "$REMOVE" | while read -r d; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
  done
fi
echo "[backup] $TS done → $DST" >> "$DST_ROOT/.backup.log"
