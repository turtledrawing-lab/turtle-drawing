#!/usr/bin/env bash
# One-time setup (on the dedicated server Mac) of the health watchdog LaunchAgent
# kr.tdw.skpwatchdog — runs watchdog.sh every 5 min to recover a HUNG server or
# tunnel (KeepAlive only covers crashes). Self-determines the repo + $HOME paths.
#
#   bash tools/skp-server/setup-watchdog.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WD="$REPO/tools/skp-server/watchdog.sh"
PLIST="$HOME/Library/LaunchAgents/kr.tdw.skpwatchdog.plist"
LABEL="kr.tdw.skpwatchdog"

[ -f "$WD" ] || { echo "❌ watchdog.sh not found at $WD" >&2; exit 1; }
chmod +x "$WD" "$REPO/tools/skp-server/update.sh" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WD}</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/skp-watchdog.out.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/skp-watchdog.err.log</string>
</dict>
</plist>
PLIST

# Re-bootstrap (modern launchctl; ignore "already loaded" on first run).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✅ ${LABEL} installed (every 300s). Logs: ~/Library/Logs/skp-watchdog.log"
echo "   status: launchctl list | grep tdw"
