# Agent install guide

This file is for AI agents installing RAFAP on a user's machine. Humans
should read `README.md` instead. Follow this top to bottom.

## What you are installing

RAFAP is a Figma plugin plus a bridge server. The bridge serves the
user's open Figma file as a local REST API on port 3002 and doubles as
an MCP server with agent tools such as `prepare_build`. Full overview in
`README.md`.

## Before you start

Check all of these. Stop and tell the user what is missing:

1. Node.js 20 or newer: `node --version`
2. The Figma desktop app is installed and running. The web version does
   not support plugins.
3. macOS if you plan to use `npm run plugin:reload`. Manual reload works
   everywhere.

## Install and run

```bash
git clone https://github.com/YonCZ/RAFAP.git
cd RAFAP
npm install
npm run check          # must pass before you continue
npm run build:plugin
npm start              # bridge on http://127.0.0.1:3002, leave it running
```

`bash scripts/setup.sh` runs all install steps in one command and prints
the remaining human steps.

If port 3002 is already taken, a second bridge process is safe. It runs
in follower mode, serves from the shared store, and delegates live
commands to the port owner. Do not kill processes on port 3002 without
asking the user first. Their session tooling may have spawned the owner.

## Steps the human must do in Figma

You cannot do these. Ask the user to do them, then wait:

1. Open Figma, then Plugins, then Development, then Import plugin from
   manifest, and select `plugin/manifest.json` inside the cloned repo.
2. Open a file, then run the plugin from Plugins, Development, Figma
   Agent.
3. Keep the plugin panel open. The panel is the bridge's connection to
   Figma. Closing it disconnects the bridge.
4. Keep the Figma window visible and in the foreground. A backgrounded
   Figma window throttles the plugin iframe and pulls time out.

## Verify

Run these after the user finishes the Figma steps:

```bash
curl http://127.0.0.1:3002/api/health        # expect "pluginConnected": true
curl http://127.0.0.1:3002/api/page-index    # lists the open file's local key
curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
```

If `pluginConnected` is false, the panel is closed or Figma throttled
it. Ask the user to reopen the panel and keep Figma visible, then retry
after ten seconds.

## Register the MCP server

For OpenCode, one global registration covers every project:

```sh
opencode mcp add figma --global -- <path-to-repo>/node_modules/.bin/tsx <path-to-repo>/bridge-server.ts
opencode mcp list   # expect: figma connected
```

For any other MCP client:

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["tsx", "bridge-server.ts"] } } }
```

Adjust the paths to the cloned repo location. The MCP server speaks
stdio. It does not need its own port. The HTTP bridge on 3002 is a
separate face of the same process.

## Install the build skill

The repo ships a skill that teaches agents the build contract. For
OpenCode users:

```sh
ln -s <path-to-repo>/skills/figma-build ~/.config/opencode/skills/figma-build
```

## Vision renaming, optional

The Rename Selected button needs a vision model. The user sets:

```sh
export VISION_BASE_URL="https://api.example.com/v1"
export VISION_MODEL="any-image-capable-model"
export VISION_API_KEY="the-users-key"
```

With nothing set, the button falls back to the first suitable provider
in the user's own OpenCode config. Never print, copy, or commit the
user's API key. If you need to check whether vision is configured, check
that `VISION_BASE_URL` exists, never the key's value.

## Report back

Tell the user:

1. The bridge is running and the plugin is connected.
2. How to test it: select frames in Figma, open the plugin panel, then
   tell any registered agent "build this".
3. The Rename Selected button works only if a vision model is
   configured.
4. If the bridge process stops, `npm start` in the repo brings it back.
   The plugin panel reconnects on its own within seconds.
