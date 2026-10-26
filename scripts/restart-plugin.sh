#!/usr/bin/env bash
# Reopen the RAFAP dev plugin in Figma — the "reload dance".
#
# Use after `npm run publish` (or a plugin rebuild + manual copy) to make
# Figma run the new plugin code without re-importing the manifest. Requires:
#   • Figma desktop running, with the file you work on open
#   • macOS with System Events (Accessibility) permission granted to the
#     terminal that runs this script
#
# Why the dance: Figma caches the running plugin code until you close and
# reopen it. Escapes close any open menu/editor state first, then the
# Development menu reopens the plugin fresh.
set -euo pipefail

osascript <<'OSA'
tell application "Figma" to activate
delay 1.5
tell application "System Events"
  tell process "Figma"
    set frontmost to true
    delay 0.4
    key code 53 -- Esc (×3: close menus/editors without deselecting)
    delay 0.4
    key code 53
    delay 0.4
    key code 53
    delay 0.4
    click menu item "Figma Agent" of menu "Development" of menu item "Development" of menu "Plugins" of menu bar 1
  end tell
end tell
OSA

echo "Plugin reopened — it reconnects to the bridge within a few seconds."
echo "Verify: curl -s http://127.0.0.1:3002/api/health   # pluginConnected: true"
