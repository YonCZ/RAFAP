#!/usr/bin/env bash
# Restart the Figma Agent dev plugin in the Figma desktop app.
#
# Figma will not re-run an already-open plugin from the menu, so we must
# close it first: focus it (menu click), dismiss it (Escape), then run it
# again (menu click). Requires Accessibility permission for the terminal
# running this script (System Settings → Privacy & Security → Accessibility).
#
# Usage: tools/restart-plugin.sh [bridge-port]   (default 3002)
set -euo pipefail

PORT="${1:-3002}"
MENU_CLICK='tell application "System Events" to tell process "Figma"
  click menu item "Figma Agent" of menu "Development" of menu item "Development" of menu "Plugins" of menu bar 1
end tell'

osascript -e 'tell application "Figma" to activate' -e 'delay 0.3' \
  -e "$MENU_CLICK" -e 'delay 0.5' -e 'tell application "System Events" to key code 53' -e 'delay 0.7' \
  -e "$MENU_CLICK" >/dev/null

# Wait for the plugin to boot and answer a command again (up to 30s)
for i in $(seq 1 30); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 25 \
    -X POST "http://127.0.0.1:${PORT}/api/agent/commands" \
    -H "Content-Type: application/json" -d '{"type":"page-index"}') || true
  [ "$code" = "200" ] && { echo "plugin restarted and answering (after ${i}s)"; exit 0; }
done
echo "plugin did not answer within 30s — check Figma manually" >&2
exit 1
