# RAFAP - REST API Figma Agent Plugin

Open-source Figma REST API and MCP server for AI agents. RAFAP reads the
file you have open in Figma and serves it on your machine. Figma's
official Dev Mode MCP server needs a paid seat. RAFAP gets your design
data into your agents from any seat, free included. No tokens, no rate
limits, no cloud round-trips. Point REST clients and AI agents at
`http://127.0.0.1:3002`.

AI agent installing this for a user? Read `AGENTS_INSTALL.md` before you
start. It contains the full procedure, including the steps only a human
can do in Figma.

## What it does

**1. Replaces the Figma REST API on localhost.** RAFAP is a Figma plugin
plus a small bridge server. The plugin reads your open document and the
bridge serves it through the same REST surface as `api.figma.com`:
`/v1/files/:key`, `/v1/files/:key/nodes`, images, and more. Existing REST
clients work when you swap the base URL.

**2. Gives AI agents direct design access.** The bridge also speaks MCP,
so coding agents like OpenCode or Claude Code get tools:

- `prepare_build`. Say "build this" with frames selected in Figma. The
  agent receives a build kit: the whole tree outline, all text content,
  and a CSS flexbox translation of the auto layout. Fixed sizes become
  px, hug becomes fit-content, fill becomes flex-grow. Rotation and gaps
  are included. The agent builds layout from this instead of guessing
  from bounding boxes.
- `get_nodes`, `get_images`, `get_metadata`. Targeted detail: fills,
  effects, radii, fonts, and PNG, JPG, SVG, or PDF exports.
- `search_nodes`, `get_outline`, `get_flex_layout`. Search and inspect the
  design without pulling paint JSON.

**3. Handles multiple Figma windows.** Every open window's selection is
heard. When your selections span two different files, the agent gets
labeled options and asks which one to build instead of guessing.

**4. One-click AI renaming.** The Rename Selected button in the plugin
panel sends a render of your selection to a vision model and replaces
lazy default names such as `Frame 336` with meaningful ones. One undo
step reverts it. Deliberately named nodes are never touched.

## Setup

Requirements: Node.js 20 or newer and the Figma desktop app. The plugin
reload helper runs on macOS.

```bash
git clone https://github.com/YonCZ/RAFAP.git
cd RAFAP
bash scripts/setup.sh
```

The script installs dependencies, typechecks, builds the plugin, and
prints the next steps. To run the steps yourself:

```bash
npm install
npm run check          # typecheck bridge + plugin
npm run build:plugin   # bundle the plugin to plugin/code.js
npm start              # bridge on http://127.0.0.1:3002
```

Then:

1. In Figma, open Plugins, then Development, then Import plugin from
   manifest, and select `plugin/manifest.json`.
2. Open the plugin and keep its panel open. The panel is the bridge's
   connection to Figma.
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

The Rename Selected button needs any OpenAI-compatible model that can
read images:

```sh
export VISION_BASE_URL="https://api.example.com/v1"
export VISION_MODEL="qwen-vl-…"   # any image-capable model
export VISION_API_KEY="…"          # stays on your machine, never logged
```

With nothing set, the button falls back to the first suitable provider
in the user's own OpenCode config.

## How it's built

```
Figma desktop app ── plugin, long-poll ──> bridge server, 127.0.0.1:3002
                                                │
        REST clients and MCP agents ───────────┘
```

Three parts in one repo:

- `plugin/`. A self-contained Figma plugin. It walks the live document
  and serializes it into REST-shaped JSON, following about 40 emission
  rules measured against real `api.figma.com` payloads. Each panel
  carries a window id, so the bridge can tell Figma windows apart and
  remember a window even while Figma throttles it in the background.
- `bridge-server.ts`. One Node process with two jobs: an HTTP server for
  the REST surface and an MCP server on stdio for agents. It caches
  extractions in a content-addressed store, forwards commands to the
  plugin, and merges selections from every open window. A second process
  is safe: it runs in follower mode, serves from the shared store,
  delegates live commands to the port owner, and takes over if the
  owner exits.
- `skills/figma-build/`. The agent build discipline. The agent calls
  `prepare_build` first, pulls targeted detail next, then builds. Layout
  comes from the flex digest, never from bounding boxes.

Data flow for a build: you select frames and say "build this". The agent
calls `prepare_build`. The bridge sends selection commands to every open
Figma window, merges the answers, and returns the outline plus flex
layout. The agent pulls detail with `get_nodes` and `get_images`, then
builds in your stack.

Fidelity: RAFAP matches the Figma REST API at 98.9% byte and 99.2%
semantic parity on real files, measured with the harness in
`tools/golden-diff.ts`. Line heights are reconstructed bit-exactly for
known font families. One command closes unknown families:
`POST /api/dev/probe-fonts`. Full details live in `report.md` and
`docs/rest-parity-deviations.md`.

RAFAP is token-free. The optional `FIGMA_TOKEN` exists only for
byte-exact remote-library style ids.

## Troubleshooting

- "plugin did not respond in time": a backgrounded Figma window throttles
  the plugin iframe. Keep Figma visible during pulls.
- "plugin not connected": open the Figma Agent panel. It reconnects
  within seconds.
- Port 3002 busy: another bridge owns it, often one spawned by OpenCode.
  That is fine. Followers serve from the shared store. Prefer exactly
  one owner. `opencode service restart` cleans up OpenCode spawns. Kill
  an orphaned bridge holding the port with
  `lsof -ti :3002 -sTCP:LISTEN`.
- Changed plugin code? Run `npm run build:plugin`, then
  `npm run plugin:reload`. The helper runs on macOS and reloads the
  frontmost window. Reload other windows from the Plugins menu.

## Development

```bash
npm run check           # tsc for bridge + plugin, CI runs this on every push
npm test                # vitest unit tests
npm run build:plugin    # bundle the plugin
npm run plugin:reload   # reopen the plugin in Figma, macOS
npx tsx tools/golden-diff.ts --mode scorecard   # parity scorecard after touching mapping code
```

MIT licensed. See `LICENSE`.
