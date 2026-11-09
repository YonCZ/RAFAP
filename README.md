# RAFAP — Figma Agent Plugin & Bridge

Your open Figma file, served to local AI agents and tools — **no tokens,
no rate limits, no cloud round-trips**. Point anything at
`http://127.0.0.1:3002` and it just works.

## What it does

**1. Replaces the Figma REST API on localhost.** RAFAP is a Figma plugin
plus a small bridge server. The plugin reads your *open* document and the
bridge serves it through the same REST surface as `api.figma.com`
(`/v1/files/:key`, `/v1/files/:key/nodes`, images, …). Existing Figma REST
clients work unchanged — just swap the base URL.

**2. Gives AI agents direct design access.** The same bridge is an MCP
server, so coding agents (OpenCode, Claude Code, …) get tools like:

- `prepare_build` — say "build this" with frames selected in Figma, and
  the agent receives one **build kit**: the whole tree outline, all text
  content, and a CSS flexbox translation of the auto-layout (the layout
  *intent* — fixed → px, hug → fit-content, fill → flex-grow, including
  rotation and gaps). Not bounding boxes; the design's own structure.
- `get_nodes` / `get_images` / `get_metadata` — targeted detail: fills,
  effects, radii, fonts, PNG/JPG/SVG/PDF exports.
- `search_nodes` / `get_outline` / `get_flex_layout` — dig through the
  design without pulling paint JSON.

**3. Survives real workflows.** Multiple Figma windows open? Every window's
selection is heard — when your selections span two different files, the
agent is handed labeled options and *asks* which one to build instead of
guessing. A `figma-build` skill (included) teaches agents the build
contract and a mechanical CSS verification step, so translations match the
digest instead of approximating it.

**4. One-click AI renaming.** A **Rename Selected** button in the plugin
panel sends a render of your selection to a vision model and replaces lazy
default names (`Frame 336`, `Group 5`) with meaningful ones. One undo step
reverts it; deliberately-named nodes are never touched.

## Setup

Requirements: Node.js, the Figma desktop app (macOS for the reload helper).

```bash
git clone https://github.com/YonCZ/RAFAP.git
cd RAFAP
bash scripts/setup.sh     # installs, typechecks, builds, prints next steps
```

Or manually:

```bash
npm install
npm run check          # typecheck bridge + plugin
npm run build:plugin   # bundle the plugin to plugin/code.js
npm start              # bridge on http://127.0.0.1:3002
```

Then:

1. In Figma: **Plugins → Development → Import plugin from manifest…** and
   select `plugin/manifest.json`. Open the plugin — keep its panel open;
   it is the bridge's connection to Figma.
2. Check the connection:

   ```bash
   curl http://127.0.0.1:3002/api/page-index   # find your file's local key
   curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
   ```

3. To use it from your AI tooling, register the MCP server (below).

### MCP registration (agents)

Any MCP client works:

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["tsx", "bridge-server.ts"] } } }
```

With OpenCode, one command registers it everywhere:

```sh
opencode mcp add figma --global -- <path-to-repo>/node_modules/.bin/tsx <path-to-repo>/bridge-server.ts
```

And install the bundled skill so agents follow the build contract:

```sh
ln -s <path-to-repo>/skills/figma-build ~/.config/opencode/skills/figma-build
```

### Vision renaming (optional)

The Rename Selected button needs any OpenAI-compatible image-capable model:

```sh
export VISION_BASE_URL="https://api.example.com/v1"
export VISION_MODEL="qwen-vl-…"   # any image-capable model
export VISION_API_KEY="…"          # stays server-side, never logged
```

With nothing set, it falls back to the first suitable provider in your
OpenCode config.

## How it's built

```
Figma desktop app ── plugin (long-poll) ──> bridge server (127.0.0.1:3002)
                                                │
        REST clients / MCP agents ──────────────┘
```

Three parts, one repo:

- **`plugin/`** — a self-contained Figma plugin. It walks the live
  document and serializes it into REST-shaped JSON (~40 emission rules,
  measured against real `api.figma.com` payloads). Each panel carries a
  window id so the bridge can tell Figma windows apart and remember them
  even while a backgrounded window is throttled.
- **`bridge-server.ts`** — one Node process, two hats: an HTTP server for
  the REST surface, and an MCP server on stdio for agents. It caches
  extractions in a content-addressed store (`store/`), forwards commands
  to the plugin (selection, live pulls, renames), and merges selections
  from every open window. Multiple processes are safe: a second one runs
  in *follower mode*, serving from the shared store and delegating live
  commands to the port owner, taking over automatically if it exits.
- **`skills/figma-build/`** — the agent-facing build discipline:
  `prepare_build` first, targeted detail next, then build — layout from
  the flex digest, never from bounding boxes.

Data flow for a build: you select frames and say "build this" → the agent
calls `prepare_build` → the bridge fans selection commands out to every
open Figma window, merges the answers, and returns outline + flex layout
→ the agent pulls targeted detail with `get_nodes` / `get_images` → it
builds in your stack.

Fidelity: verified against real files at **98.9% byte / 99.2% semantic
parity** with the Figma REST API (details in `report.md` and
`docs/rest-parity-deviations.md`). Line-height metrics are reconstructed
bit-exactly for known font families; a one-command probe closes unknown
ones (`POST /api/dev/probe-fonts`). RAFAP is token-free — the optional
`FIGMA_TOKEN` exists only for byte-exact remote-library style ids.

## Troubleshooting

- **"plugin did not respond in time"** — a backgrounded Figma window
  throttles the plugin iframe. Keep Figma visible during pulls.
- **"plugin not connected"** — open the Figma Agent panel; it reconnects
  within seconds.
- **Port 3002 busy** — another bridge owns it (often one spawned by
  OpenCode). That's fine: followers serve from the shared store. Prefer
  exactly one owner (`opencode service restart` cleans up OpenCode's
  spawns). An orphaned bridge holding the port with old code can be
  killed via `lsof -ti :3002 -sTCP:LISTEN`.
- **Changed plugin code?** — `npm run build:plugin` then
  `npm run plugin:reload` (macOS, reloads the frontmost window; reload
  other windows manually from the Plugins menu).

## Development

```bash
npm run check           # tsc for bridge + plugin (CI runs this on every push)
npm test                # vitest unit tests
npm run build:plugin    # bundle the plugin
npm run plugin:reload   # reopen the plugin in Figma (macOS)
npx tsx tools/golden-diff.ts --mode scorecard   # parity scorecard after touching mapping code
```

`agent.md` is the spec of record. MIT licensed — see `LICENSE`.
