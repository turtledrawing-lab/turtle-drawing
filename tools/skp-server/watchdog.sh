#!/usr/bin/env bash
# Health watchdog for the .skp conversion server (run on the dedicated server Mac
# by the kr.tdw.skpwatchdog LaunchAgent, every 5 min).
#
# launchd KeepAlive already restarts a CRASHED process — but NOT a HUNG one (the
# SketchUp binding can wedge on a bad model and stop answering while the process
# is still "alive"). This pings /health and kickstarts the right agent when
# unresponsive:
#   • localhost:8787 down/hung      → restart kr.tdw.skpserver
#   • localhost OK but tunnel down  → restart kr.tdw.cloudflared (Cloudflare 1033)
#
# Manual run:  bash tools/skp-server/watchdog.sh   (or: npm run skp:watchdog)
set -uo pipefail
UID_="$(id -u)"
LOG="$HOME/Library/Logs/skp-watchdog.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }

local_ok() { curl -fsS --max-time 12 http://localhost:8787/health >/dev/null 2>&1; }
tunnel_ok() { curl -fsS --max-time 20 https://convert.tdw.kr/health >/dev/null 2>&1; }

if ! local_ok; then
  log "local :8787 UNHEALTHY → kickstart kr.tdw.skpserver"
  launchctl kickstart -k "gui/$UID_/kr.tdw.skpserver" 2>>"$LOG" || log "  (kickstart skpserver failed — is the agent bootstrapped?)"
  sleep 10
  local_ok && log "  local recovered" || log "  local STILL down after restart"
elif ! tunnel_ok; then
  # Local server answers but the public hostname doesn't → the tunnel is the problem.
  log "tunnel convert.tdw.kr UNHEALTHY (local OK) → kickstart kr.tdw.cloudflared"
  launchctl kickstart -k "gui/$UID_/kr.tdw.cloudflared" 2>>"$LOG" || log "  (kickstart cloudflared failed)"
  sleep 8
  tunnel_ok && log "  tunnel recovered" || log "  tunnel STILL down after restart"
fi
exit 0
