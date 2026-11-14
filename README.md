# RAFAP - REST API Figma Agent Plugin

RAFAP is a Figma plugin and a local bridge server. It reads the open Figma file and serves it over REST and MCP on `http://127.0.0.1:3002`.

AI agent installing this for a user? Read `AGENTS_INSTALL.md`. It covers the full procedure, including the steps only a human can do in Figma.

## What it does

### Local REST API

The bridge serves the open document through the same REST endpoints as `api.figma.com`: `/v1/files/:key`, `/v1/files/:key/nodes`, images, and more. Existing REST clients work after you swap the base URL.

### MCP tools

The bridge speaks MCP, so coding agents such as OpenCode or Claude Code get tools:

- `prepare_build`. Say "build this" with frames selected in Figma. The agent receives a build kit: the whole tree outline, all text content, and a CSS flexbox translation of the auto layout. Fixed sizes become px, hug becomes fit-content, fill becomes flex-grow. Rotation and gaps are included. The agent builds layout from this instead of guessing from bounding boxes.
- `get_nodes`, `get_images`, `get_metadata`. Targeted detail: fills, effects, radii, fonts, and PNG, JPG, SVG, or PDF exports.
- `search_nodes`, `get_outline`, `get_flex_layout`. Search and inspect the design without pulling paint JSON.

### Multiple Figma windows

Every open window's selection is available. If the selections span two files, the agent gets labeled options and asks which one to build instead of guessing.

### Vision renaming

The Rename Selected button sends a render of the selection to a vision model and replaces default names such as `Frame 336` with meaningful ones. One undo step reverts it. Deliberately named nodes are not touched.

## Setup

Requirements: Node.js 20 or newer and the Figma desktop app. The plugin reload helper runs on macOS.

```bash
git clone https://github.com/YonCZ/RAFAP.git
cd RAFAP
bash scripts/setup.sh
```

The script installs dependencies, typechecks, builds the plugin, and prints the next steps. To run the steps yourself:

```bash
npm install
npm run check          # typecheck bridge + plugin
npm run build:plugin   # bundle the plugin to plugin/code.js
npm start              # bridge on http://127.0.0.1:3002
```

Then:

1. In Figma, open Plugins, then Development, then Import plugin from manifest, and select `plugin/manifest.json`.
2. Open the plugin and keep its panel open. The panel is the bridge's connection to Figma.
3. Check the connection:

```bash
curl http://127.0.0.1:3002/api/page-index   # find your file's local key
curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
```

4. To use RAFAP from your AI tooling, register the MCP server below.

### MCP registration

Any MCP client works:

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["tsx", "bridge-server.ts"] } } }
```

With OpenCode, one command registers it for every project:

```sh
opencode mcp add figma --global -- <path-to-repo>/node_modules/.bin/tsx <path-to-repo>/bridge-server.ts
```

Install the bundled skill so agents follow the build contract:

```sh
ln -s <path-to-repo>/skills/figma-build ~/.config/opencode/skills/figma-build
```

### Vision renaming, optional

The Rename Selected button needs any OpenAI-compatible model that can read images:

```sh
export VISION_BASE_URL="https://api.example.com/v1"
export VISION_MODEL="qwen-vl-…"   # any image-capable model
export VISION_API_KEY="…"          # stays on your machine, never logged
```

With nothing set, the button falls back to the first suitable provider in the user's own OpenCode config.

## How it's built

The plugin long-polls the bridge on `127.0.0.1:3002`. REST clients and MCP agents call the same bridge.

- `plugin/`. A self-contained Figma plugin. It walks the live document and serializes it into REST-shaped JSON. It follows about 40 emission rules measured against real `api.figma.com` payloads. Each panel carries a window id, so the bridge can tell Figma windows apart and remember a window while Figma throttles it.
- `bridge-server.ts`. One Node process with two jobs: an HTTP server for the REST surface and an MCP server on stdio for agents. It caches extractions in a content-addressed store, forwards commands to the plugin, and merges selections from every open window. A second process is safe. It runs in follower mode, serves from the shared store, delegates live commands to the port owner, and takes over if the owner exits.
- `skills/figma-build/`. The agent build discipline. The agent calls `prepare_build` first, pulls targeted detail next, then builds. Layout comes from the flex digest, never from bounding boxes.

Data flow for a build: you select frames and say "build this". The agent calls `prepare_build`. The bridge sends selection commands to every open Figma window, merges the answers, and returns the outline plus flex layout. The agent pulls detail with `get_nodes` and `get_images`, then builds in your stack.

RAFAP matches the Figma REST API at 98.9% byte and 99.2% semantic parity on real files, measured with `tools/golden-diff.ts`. Line heights are reconstructed exactly for known font families. `POST /api/dev/probe-fonts` handles unknown families. Details are in `report.md` and `docs/rest-parity-deviations.md`.

RAFAP is token-free. The optional `FIGMA_TOKEN` exists only for byte-exact remote-library style IDs.

## Troubleshooting

- "plugin did not respond in time": a backgrounded Figma window throttles the plugin iframe. Keep Figma visible during pulls.
- "plugin not connected": open the Figma Agent panel. It reconnects within seconds.
- Port 3002 busy: another bridge owns it, often one spawned by OpenCode. Followers serve from the shared store. Prefer one owner. `opencode service restart` cleans up OpenCode spawns. Kill an orphaned bridge holding the port with `lsof -ti :3002 -sTCP:LISTEN`.
- Changed plugin code? Run `npm run build:plugin`, then `npm run plugin:reload`. The helper runs on macOS and reloads the frontmost window. Reload other windows from the Plugins menu.

## Development

```bash
npm run check           # tsc for bridge + plugin, CI runs this on every push
npm test                # vitest unit tests
npm run build:plugin    # bundle the plugin
npm run plugin:reload   # reopen the plugin in Figma, macOS
npx tsx tools/golden-diff.ts --mode scorecard   # parity scorecard after touching mapping code
```

MIT licensed. See `LICENSE`.
