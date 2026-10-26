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
npm run build:plugin   # bundle the plugin to dist/plugin/
npm start              # bridge on http://127.0.0.1:3002
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and
select `dist/plugin/manifest.json`. Open the plugin (keep its panel open —
it is the bridge's connection to Figma), and:

```bash
curl http://127.0.0.1:3002/api/page-index   # find your file's local key
curl "http://127.0.0.1:3002/v1/files/local-<key>?fresh=1"
```

To use it from your AI tooling, register it with OpenCode (see
[MCP server](#mcp-server) — every session then gets `get_file`,
`search_nodes`, `get_selection`, …).

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
- **"node X not found in this file"** — the plugin operates on the file
  that is *open* in Figma. Open the file the node belongs to.
- After changing plugin code: `npm run publish`, then
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
| `get_file` | `GET /v1/files/:key` | Whole document tree; `fileKey` optional (defaults to the most recently pulled file), `ids`/`depth` supported |
| `get_nodes` | `GET /v1/files/:key/nodes` | By id; unstored ids are live-pulled from the plugin |
| `get_images` | `GET /v1/images/:key` | PNG/JPG/SVG/PDF — SVG and PDF supersede REST here; URLs are served by the bridge and never expire |
| `get_metadata` | file-level maps | `components`, `componentSets`, `styles` — the design tokens |
| `get_selection` | selection command | The differentiator: "grab what I selected" |
| `search_nodes` | — | Name/text/type search over the stored design — REST has no equivalent |
| `request_from_figma` | command queue | Fresh pulls on demand (`page-index`, `frame`, `selection`, `export`) |

The older agent-shaped tools (`list_figma_frames`, `get_figma_frame`,
`get_latest_figma_frame`) remain for compatibility. Returns are REST-shaped,
so prompts and SDKs written against the Figma REST API work unchanged.

**With OpenCode** (V2), one command registers the bridge for every project:

```sh
opencode mcp add figma --global -- <path-to-repo>/node_modules/.bin/tsx <path-to-repo>/bridge-server.ts
opencode mcp list   # → ✓ figma connected
```

The OpenCode service then spawns the bridge automatically and its tools
appear as `figma.get_file`, `figma.search_nodes`, … The plugin keeps
talking to port 3002, so the OpenCode-spawned bridge should be the only
one running (`npm run start:dev` would race it — see below).

**Multiple bridge processes are safe.** If a second process finds port 3002
taken (e.g. an MCP status check spawns one while a session's instance
holds it), it runs in *follower mode*: REST/MCP serve from the shared
store, and live plugin commands are delegated to the port owner over
localhost HTTP (`POST /api/agent/run`). Followers retry the port every 30s
and take over if the owner exits — no manual babysitting.

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
npm run publish  # sync build to a dev plugin folder
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
