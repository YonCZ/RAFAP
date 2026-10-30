# RAFAP — Rest API Figma Agent Plugin

A local **drop-in replacement for the Figma REST API** (`GET /v1/files/:key`,
`GET /v1/files/:key/nodes`): a Figma plugin + loopback bridge server that
serves your open Figma file through an API-shaped surface with **no rate
limits, no tokens, and no cloud round-trips**. Point any Figma REST client at
`http://127.0.0.1:3002/v1` and it just works.

Built for AI agents and local tooling that keep hitting Figma's API rate
limits while iterating on design data.

## How it works

```
Figma desktop app ── plugin (long-poll) ──> bridge server (127.0.0.1:3002)
                                                │
REST clients / agents ── GET /v1/files/... ──────┘
```

1. The **plugin** (`plugin/`) walks the live document and serializes it into
   REST-shaped JSON, applying ~40 emission rules measured against real
   `api.figma.com` payloads (see `docs/rest-parity-deviations.md`).
2. The **bridge** (`bridge-server.ts`) exposes the `/v1` surface, caches
   extractions in a content-addressed store (`store/`), and forwards agent
   commands to the plugin.
3. `GET /v1/files/:key/nodes?ids=248:563` auto-pulls the frame live if the
   plugin is connected; otherwise the cached copy is served.

## Quick start

One command (installs, typechecks, builds the plugin, prints the rest):

```bash
bash scripts/setup.sh
```

Or step by step:

```bash
npm install
npm run check          # typecheck bridge + plugin
npm run build:plugin   # bundle the plugin to plugin/code.js
npm start              # bridge on http://127.0.0.1:3002
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and
select `plugin/manifest.json`. Open the plugin (keep its panel open —
it is the bridge's connection to Figma), and:

```bash
curl http://127.0.0.1:3002/api/page-index   # find your file's local key
curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
```

To use it from your AI tooling, register it with OpenCode (see
[MCP server](#mcp-server) — every session then gets `prepare_build`,
`get_outline`, `get_flex_layout`, …).

## Troubleshooting

- **"plugin did not respond in time"** — a backgrounded or minimized Figma
  window throttles the plugin iframe. Keep Figma visible on the current
  Space during pulls (this is Figma's throttling, not the bridge's).
- **"plugin not connected"** — open the **Figma Agent** panel in Figma;
  it reconnects on its own within seconds of the bridge starting.
- **Port 3002 is busy** — another bridge owns it (e.g. one spawned by
  OpenCode). A second process is harmless: it runs in *follower mode*,
  serving from the shared store and delegating live commands to the owner.
  Run only one if you can (`opencode service restart` cleans up OpenCode's
  spawns).
- **Old bridge survives a service restart** — an OpenCode-spawned bridge can
  be orphaned (reparented to launchd) and keep holding port 3002 with the
  *old* code: new commands like `rename` then fail with "invalid command"
  even after a restart. Find it with `lsof -ti :3002 -sTCP:LISTEN`, `kill`
  it — a fresh follower takes the port within 30s and the plugin reconnects
  on its own.
- **"node X not found in this file"** — the plugin operates on the file
  that is *open* in Figma. Open the file the node belongs to.
- **"vision model returned no JSON"** — the model's reply was truncated or
  empty. Batches are chunked (≤ 40 layers per vision call), each chunk
  retried once, and truncated replies are salvaged for their complete
  entries, so this should be rare. If it persists, check
  `store/logs/vision-rename.jsonl` — every vision call is logged there
  (model, chunk sizes, HTTP status, reply excerpts, durations; the API
  key is never logged).
- After changing plugin code: `npm run build:plugin`, then
  `npm run plugin:reload` to reopen it in Figma without re-importing
  (macOS, needs Accessibility permission for your terminal).

## API surface

| Endpoint | Parity |
|---|---|
| `GET /v1/files/:key` | Full document tree, `components`, `componentSets`, `styles` |
| `GET /v1/files/:key/nodes?ids=a,b` | Per-node subtrees, live auto-pull |
| `GET /v1/files/:key/components`, `/styles` | Best-effort from stored frames |
| `GET /v1/files/:key/images/:ref` | Image bytes by ref |
| `GET /v1/me` | Local identity stub |

Also: `?fresh=1` to force re-extraction (extension), and `_figmaAgent.svgBase64`
on shape nodes — inline SVG exports, which the real REST API cannot do at all.

## MCP server

The same bridge process doubles as an MCP server on stdio — spawn it with an
MCP client and the design is directly tool-accessible, no HTTP needed:

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["tsx", "bridge-server.ts"] } } }
```

| Tool | Maps to | Note |
|---|---|---|
| `prepare_build` | selection / frames | **The build kit — call first.** One response: whole-tree outline (structure + all text) + flexbox translation of the auto-layout (layout intent). Defaults to the current Figma selection |
| `get_nodes` | `GET /v1/files/:key/nodes` | By id; unstored ids are live-pulled from the plugin |
| `get_images` | `GET /v1/images/:key` | PNG/JPG/SVG/PDF — SVG and PDF supersede REST here; URLs are served by the bridge and never expire |
| `get_metadata` | file-level maps | `components`, `componentSets`, `styles` — the design tokens |
| `get_selection` | selection command | The differentiator: "grab what I selected" |
| `search_nodes` | — | Name/text/type search over the stored design — REST has no equivalent |
| `get_outline` | — | Compact whole-tree digest: one line per node (id/name/type/size, child count, auto-layout, **all text content**), no paint JSON, no depth pruning |
| `get_flex_layout` | — | Paste-ready CSS flexbox translation of the auto-layout — the layout **intent** (fixed → px, hug → fit-content, fill → flex-grow/align-self:stretch, gaps, padding, alignment). Build layout from this, not from bounding boxes |
| `list_figma_frames` | — | What is stored (id, name, file key, when) |

Nine tools, one ritual: **`prepare_build` → targeted detail → build**.
The agent-facing surface is deliberately small — the context burners the
REST surface allowed (`get_file`, full-tree pulls) are HTTP-only now.
Returns stay REST-shaped, so SDK code against the Figma REST API keeps
working over HTTP.

**With OpenCode** (V2), one command registers the bridge for every project:

```sh
opencode mcp add figma --global -- <path-to-repo>/node_modules/.bin/tsx <path-to-repo>/bridge-server.ts
opencode mcp list   # → ✓ figma connected
```

The OpenCode service then spawns the bridge automatically and its tools
appear as `figma.prepare_build`, `figma.search_nodes`, … The plugin keeps
talking to port 3002, so the OpenCode-spawned bridge should be the only
one running (`npm run start:dev` would race it — see below).

**Multiple bridge processes are safe.** If a second process finds port 3002
taken (e.g. an MCP status check spawns one while a session's instance
holds it), it runs in *follower mode*: REST/MCP serve from the shared
store, and live plugin commands are delegated to the port owner over
localhost HTTP (`POST /api/agent/run`). Followers retry the port every 30s
and take over if the owner exits — no manual babysitting.

**Skill: `figma-build`.** The repo ships an OpenCode skill
(`skills/figma-build/SKILL.md`) that teaches agents the build contract:
`prepare_build` first (structure + text + layout intent in one call), then
targeted detail, then build — never layout from bounding-box pixels.
Install it globally:

```sh
ln -s <path-to-repo>/skills/figma-build ~/.config/opencode/skills/figma-build
```

Any agent that can call the `figma` MCP tools (OpenCode, Claude Code, …)
benefits; the skill just encodes the workflow discipline.

## Vision renaming — the **Rename Selected** button

Frame names are the cheapest context signal an agent gets from a design —
"Frame 336" carries no intent. The renamer fixes lazy default names with a
vision LLM: it renders the selection, sends the PNG plus each layer's
type/size/text content, proposes names, and applies them immediately.
The whole batch is one Figma undo step (⌘Z reverts it), and the stored
design is patched so the digest tools reflect the new names instantly.
Only default names (`Frame \d+`, `Group 5`, …) are ever touched;
deliberately-named nodes are untouchable.

No agent involvement needed: select frames in Figma, click **Rename
Selected** in the plugin panel (`POST /api/rename/selected`). Vision stays
server-side in exactly this one place — the MCP surface is vision-free.

The vision endpoint is any OpenAI-compatible chat-completions API:

```sh
export VISION_BASE_URL="https://api.example.com/v1"
export VISION_MODEL="qwen-vl-…"      # any image-capable model
export VISION_API_KEY="…"            # stays server-side, never logged
```

With no env vars set, the bridge falls back to the first provider in
`~/.config/opencode/opencode.json` that has a `baseURL` + `apiKey`
(preferring Gemma, then Qwen — Gemma won an empirical naming shoot-out
on the reference endpoint: fastest ~5s, cleanest JSON, most accurate and
differentiated names). Set `VISION_MODEL` to override. Tiny frames are
auto-rendered at a higher scale — some vision endpoints reject images
below ~512px.


## Font metrics (line heights)

REST computes intrinsic `lineHeightPx` from real font metrics server-side —
data the plugin API cannot see. RAFAP reconstructs it: a per-family
multiplier table (fitted on a corpus, verified ≤1 ulp of REST's float32
pipeline) is applied at persist time, and unknown families are solved
exactly by a runtime probe. Acceptance on never-seen fonts: **bit-exact
float32 parity** with REST's `lineHeightPx` (e.g. Space Grotesk —
150/150 text nodes identical, bit for bit).

To close a family the table doesn't know (any font used in the open file):

```bash
curl -X POST http://127.0.0.1:3002/api/dev/probe-fonts
```

This asks the open plugin to measure the file's fonts with a scratch text
node (one undo step, document stays clean; keep the Figma window visible —
a backgrounded window throttles the plugin). The bridge snaps the
measurements to the family's exact rational multiplier — when provable, the
rewriter then emits REST's `float32(size × float32(m))` bit-for-bit. Runs
are human-triggered, never automatic.

Unprobed families degrade to the plugin's best-effort estimate — see
"Degradation modes" in `docs/rest-parity-deviations.md`.

## Tokens

RAFAP is **token-free by default**: pulling, parity, and every endpoint
work with zero credentials. An optional token (`FIGMA_TOKEN` or
`~/.figma-token`) exists for one thing only: upgrading remote library style
ids to byte-exact library node ids (one cached, 429-safe REST call per
file). The token-free alternative was probed and is impossible — current
Figma reports local styles with empty id markers — so this trade-off is a
final decision, not a TODO (details in `docs/rest-parity-deviations.md`,
"Token stance").

## Fidelity

Verified against a real 2,361-node / 32-frame file via a golden-diff harness
(`tools/golden-diff.ts`): **98.9% byte / 99.2% semantic parity** at the
normalizer's 4-decimal rounding; document tree structure matches exactly
(same ids, same order, same shapes). Re-verified on a **never-seen community
file** (3,593 nodes, different fonts, remote styles): 95.4% byte / 96.5%
semantic with **no new deviation classes** — the residue is the same known
plugin-API limits. See `report.md` and `docs/rest-parity-deviations.md`.

## Security

- Bridge binds **loopback only** (`127.0.0.1`); no external interface.
- `networkAccess.allowedDomains` pins the plugin to the bridge origin.
- No secrets in the repo; the Figma REST token (if you use one for golden
  tests) lives in `~/.figma-token`, never committed.

## Development

```bash
npm run check    # tsc for bridge + plugin (CI runs this on every push)
npm test         # vitest unit tests (mapping rules, metrics, harness)
npm run build:plugin    # bundle the plugin to plugin/code.js
npm run plugin:reload  # reopen the plugin in Figma (macOS reload dance)
```

The **regression gate** is two-layered: CI (`check` + tests, on every push)
and the local **golden-diff scorecard** — its fixtures are real-design REST
snapshots that stay on the machine that measured them (gitignored by
design, cached, no API calls), so after touching mapping or normalization
code run:

```bash
npx tsx tools/golden-diff.ts --mode scorecard
```

and compare against the fidelity numbers above before pushing.

`agent.md` is the spec of record. MIT licensed — see `LICENSE`.
