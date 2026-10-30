#!/usr/bin/env bash
# RAFAP one-command setup: install, typecheck, build the Figma plugin, and
# print exactly what to do next. Safe to re-run (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

say "Checking Node…"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>= 20). Install it from https://nodejs.org first." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node >= 20 required, found $(node --version)." >&2
  exit 1
fi
ok "Node $(node --version)"

say "Installing dependencies…"
npm install --no-fund --no-audit
ok "Dependencies installed"

say "Typechecking (bridge + plugin)…"
npm run check --silent
ok "Types clean"

say "Building the Figma plugin…"
npm run build:plugin --silent
ok "Plugin built → plugin/code.js"

cat <<EOF

$(printf '\033[1mNext steps\033[0m')

1. Run the bridge (leave it running):
       npm start                     # http://127.0.0.1:3002

2. In the Figma desktop app, import the plugin once:
       Plugins → Development → Import plugin from manifest…
       → $ROOT/plugin/manifest.json

3. Open the plugin in your file:
       Plugins → Development → Figma Agent
   Keep its panel open — it is the bridge's connection to Figma.

4. Pull your file and check it:
       curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
       # find the key: curl http://127.0.0.1:3002/api/page-index

5. (Optional) Register it with OpenCode as an MCP server:
       opencode mcp add figma --global -- \\
         $ROOT/node_modules/.bin/tsx $ROOT/bridge-server.ts

Troubleshooting: see the README ("Troubleshooting") — the two classics are
a backgrounded Figma window throttling the plugin, and a second bridge
process (harmless: it follows the port owner).
EOF
