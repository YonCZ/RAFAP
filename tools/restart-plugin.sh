#!/usr/bin/env bash
# Restart the Figma Agent dev plugin in the Figma desktop app.
#
# Two cases:
#  - plugin closed  → a single menu click runs it.
#  - plugin open   → Figma will not re-run an already-open plugin, so we
#    close it first: run (menu click), dismiss (Escape), run again. This is
#    only needed to RELOAD newly published plugin code.
#
# Requires Accessibility permission for the terminal running this script
# (System Settings → Privacy & Security → Accessibility).
#
# Usage: tools/restart-plugin.sh [bridge-port] [force]   (default port 3002)
#   force — reload the plugin even if it is already connected (after
#           `npm run publish`).
set -euo pipefail

PORT="${1:-3002}"
MODE="${2:-}"
MENU_CLICK='tell application "System Events" to tell process "Figma"
  click menu item "Figma Agent" of menu "Development" of menu item "Development" of menu "Plugins" of menu bar 1
end tell'

connected() {
  curl -s -m 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
    | grep -q '"pluginConnected":true'
}

wait_connected() { # $1 = label, $2 = tries
  for i in $(seq 1 "$2"); do
    sleep 1
    if connected; then echo "$1 — plugin polling (after ${i}s)"; return 0; fi
  done
  return 1
}

# Nothing to do when the plugin is already polling (unless reloading).
if [ "$MODE" != "force" ] && connected; then
  echo "plugin already connected"
  exit 0
fi

# Case 1: plugin closed — a single menu click runs it.
osascript -e 'tell application "Figma" to activate' -e 'delay 0.3' \
  -e "$MENU_CLICK" >/dev/null
if wait_connected "ran plugin" 15; then exit 0; fi

# Case 2: plugin open with stale code — close it, then run it again.
osascript -e 'tell application "Figma" to activate' -e 'delay 0.3' \
  -e "$MENU_CLICK" -e 'delay 0.5' -e 'tell application "System Events" to key code 53' -e 'delay 0.7' \
  -e "$MENU_CLICK" >/dev/null

# Wait for the plugin's UI to start long-polling the bridge (up to 30s).
# pluginConnected is only true while the plugin's poll loop is alive — this
# is the real check. (The old POST-based check passed even with the plugin
# closed: queueing a command always returns 200 immediately.)
if wait_connected "reloaded plugin" 30; then exit 0; fi

echo "plugin did not connect within 30s — check Figma manually" >&2
exit 1
