# Figma Agent — Project Context for AI Assistants

You are being handed this file so you can understand the project immediately:
what it is, how far it is, what the rules are, and what comes next. Read this
before touching anything.

## What this project is

**Figma Agent** is a local, rate-limit-free pipeline that extracts design data
from the Figma desktop app and serves it to AI coding agents — as JSON design
trees today, and (the current goal, "v3") as a **drop-in local replacement for
the official Figma REST API** (`api.figma.com`).

```
Figma desktop app
  └── plugin (code.js sandbox ↔ ui.html iframe via postMessage)
        │  HTTP polling (pull mode) + manual buttons (push mode)
        ▼
  bridge (express, Node + tsx)
        │  - REST-parity /v1 routes (planned, v3)
        │  - agent command queue (built)
        │  - permanent disk store: frames/<id>.json (built)
        ▼
  agents: plain HTTP/curl, disk reads, or optional MCP tools (built)
```

Why it exists: the Figma REST API is rate-limited (429s on file-content
endpoints in practice on the free tier), needs a personal access token, and
cannot export SVG or per-range text styles. A plugin running inside the live
document has none of those limits and strictly more access.

Long-term goal: open-source it (MIT) as a standalone repo + Figma Community
plugin. Competitors: Figma's official Dev Mode MCP server and Framelink's
figma-context-mcp (both REST-based, therefore rate-limited). Our
differentiation: plugin-based (no token, no rate limits), pull-mode (agent
queues commands, plugin executes), permanent disk persistence, and REST-shape
compatibility so existing tooling works unchanged.

## Current status (what works, verified end-to-end)

- **Live production instance** — plugin folder `Agent Plugin/`, bridge on
  **port 3001**, running from a *separate legacy copy* inside a private webapp
  repo. Another AI session actively reads design data through it. **Do not
  touch it.** (See operating rules.)
- **This repo** (`figma-bridge/`, git `e7034c0`, typecheck clean) — the
  canonical home. Contains the bridge server, the plugin source (dev copy),
  and docs.
- **Plugin extractor v2** — fully working:
  - Full design trees: id/name/type/x/y/width/height, children
  - Fills/strokes as hex + opacity + gradient stops
  - **Per-range text styles** via `getStyledTextSegments` (real fonts,
    weights, sizes, colors when styles vary inside one text node)
  - Effects incl. shadows and blurs
  - Rotation, `absoluteRenderBounds`, dash patterns, per-side strokes,
    per-corner radii + smoothing, blend modes, clipping
  - Auto-layout: mode, itemSpacing, paddings, alignment, sizing modes, wrap,
    per-child `layoutAlign`/`layoutGrow`
  - **Real SVG markup** for vector/icon nodes via `exportAsync`
  - Component info (incl. cross-page instance resolution via
    `getMainComponentAsync`)
- **Bridge (built)**:
  - Push mode: plugin buttons "Send Selected Frame(s)" / "Send Page Index"
  - Pull mode: agent queues a command (`page-index` | `frame {id}` |
    `selection`), the open plugin polls for it (~1.5s), executes, returns;
    20s command timeout
  - Every received frame persists permanently to `frames/<id>.json`;
    re-sending the same id refreshes the snapshot
  - Read endpoints: `/api/frames`, `/api/frames/<id>`, `/api/latest`,
    `/api/page-index`, `/api/health`
  - Optional MCP tools (stdio): `list_figma_frames`, `get_figma_frame`,
    `get_latest_figma_frame`, `request_from_figma`
- `BRIDGE_PORT` env override exists so dev testing can run on **port 3002**
  without touching a shared 3001 instance.

## Operating rules (critical)

1. **Port 3001 and the `Agent Plugin/` folder are production.** Another AI
   session may be mid-extraction at any moment. Never kill, restart, or edit
   them without explicit human permission.
2. All development and testing happens on **port 3002**
   (`npm run start:dev`) with the **dev plugin** (see v3 phase A).
3. Plugin source edits happen **only** in `figma-bridge/plugin/`. They reach
   the live/dev plugin folder exclusively via `npm run publish` (human-approved
   sync + build), after which a human reopens the plugin in Figma.
4. Human runs the bridge in their own terminal; AI sessions ask, never manage,
   shared processes.

## Repo layout

```
Programming/Figma/
├── Agent Plugin/       # LIVE plugin (port 3001 flow) — do not edit
├── Figma Agent/        # DEV plugin (to be created by human via Figma
│                       #   wizard; wired to port 3002) — see phase A
└── figma-bridge/       # this repo
    ├── bridge-server.ts   # express + command queue + MCP + frames store
    ├── plugin/            # canonical plugin source: code.ts, ui.html
    ├── frames/            # received design trees (gitignored)
    ├── docs/
    │   ├── agent_coding_instructions.md    # how agents use the bridge
    │   └── human_setup_connection_guide.md # setup + publish workflow
    └── agent.md          # this file
```

Commands (inside `figma-bridge/`): `npm start` (3001) ·
`npm run start:dev` (3002) · `npm run check` (typecheck) ·
`npm run publish` (sync plugin → dev plugin folder + build).

## The v3 plan (approved, not yet built)

Goal: output mirrors `GET /v1/files/:file_key` so closely that anything built
for the Figma REST API (SDK clients, agents, prompts) consumes it unchanged —
while remaining a **superset** (SVG inline, pull mode, no rate limits).

**Phase A — wiring the dev instance.** Human creates a new plugin in Figma
Desktop (Plugins → Development → New Plugin…), names it **"Figma Agent"**,
saves it into `Programming/Figma/`. Then: copy repo `plugin/` source in, patch
manifest (`networkAccess` → `http://localhost:3002` + reasoning), point
`ui.html`'s `BRIDGE` constant at 3002, build. Old `Agent Plugin`/3001 stays
frozen as legacy.

**Phase B — extractor v3: REST parity.** Output mirrors the REST file
response:

- Envelope: `{ name, schemaVersion, document: { id "0:0", type DOCUMENT,
  children: [ { id, type CANVAS, name <page>, children: [frames…] } ] },
  components, componentSets, styles }`
- Colors as `{r, g, b}` floats 0–1 with `opacity` inside the paint (not hex)
- `"figma::mixed"` sentinel string for mixed values (REST's exact convention)
- `absoluteBoundingBox`; `rectangleCornerRadii: [TL,TR,BR,BL]`; `strokeWeight`
  as `[top,right,bottom,left]` when per-side
- Effects array incl. `LAYER_BLUR` / `BACKGROUND_BLUR`
- Full auto-layout set (REST names), `constraints`, `visible`, `opacity`,
  `blendMode`, `clipsContent`, `dashPattern`, `componentId` on instances
- TEXT nodes the REST way: `characters` + `style {}` +
  `characterStyleOverrides []` + `styleOverrideTable {}`, run-length encoded
  from `getStyledTextSegments`
- Our extensions (e.g. inline `svg`) stay in clearly-namespaced extra fields

Serialization rules (the anti-missing-fields contract):
1. Invariant core on every node: `id`, `name`, `type`,
   `absoluteBoundingBox`, `visible`, `children`
2. Optional props omitted exactly when REST omits them
3. `"figma::mixed"` sentinels instead of dropped data
4. Unknown node types pass through with core + children (never collapsed)
5. Golden diff as enforcement (see phase D)

**Phase C — bridge v3: REST-compatible routes.**

- `GET /v1/files/:key` and `GET /v1/files/:key/nodes?ids=…` — served from the
  disk store (stitched into the REST envelope); `?fresh=1` forces a re-pull
- Use the **real file key** (plugin API exposes `figma.fileKey`) for cache keys
  and routes
- `GET /v1/me` (trivial, helps client init); later `/v1/files/:key/images`
  mapped to plugin `exportAsync` (serve local PNG/SVG URLs)
- Large documents: per-frame command fallback instead of one giant postMessage
- Transport stays **long-polling** (server holds `next-command` up to ~10s) —
  deliberately not WebSockets/SSE: polling is self-healing when the plugin
  window closes/reopens, and command latency tolerance is seconds

**Phase D — golden-diff verification.** Pull the same frame via
api.figma.com and via the plugin, deep-compare normalized trees, iterate
until identical. A human REST token exists for a handful of test calls; free-
tier rate limits may or may not be exhausted — if 429, do a docs-first pass
and retry when the window resets.

**Phase E — repo polish for open source.** Rename branding to Figma Agent,
MIT `LICENSE`, README rewrite for the public repo + Figma Community listing.

## Deliberate design decisions (do not relitigate without cause)

- **Writes are deferred.** The official REST API is read-only for file
  content, so writes are an *extension*, not parity. When added (v4+):
  explicit pull commands (`create-node`, `set-fill`, `set-text`), one command
  = one Figma undo step, and a plugin-UI toggle "Allow write commands",
  default OFF (human-gated).
- **Authentication**: accept any `Authorization: Bearer …` header and ignore
  it (SDK clients send one; rejecting breaks drop-in compatibility).
  Security = bind express to `127.0.0.1` explicitly (fix needed — currently
  binds all interfaces), validate `Host: localhost` (blocks DNS rebinding),
  and an optional `--secret <path>` shared-secret file. No remote access by
  construction.
- **No CDN/no cloud** — fully local, no tokens for our own usage.

## Known gaps / honest status

- REST-parity output: designed, **not implemented** (extractor v2 output uses
  its own JSON conventions — hex colors, `segments` for text, etc.)
- `/v1/...` routes: not implemented
- Golden diff: not run (token status uncertain)
- Dev plugin "Figma Agent": not yet created (waiting on human)
- express bind address: still all interfaces — fix in phase C
- The frames in the legacy webapp copy's `frames/` dir belong to that session;
  this repo's `frames/` starts empty

## How you can help

Pick a phase (B and C are the meat), read `plugin/code.ts` and
`bridge-server.ts` first, follow the operating rules, and propose changes as
concrete diffs or file rewrites. Verify with `npm run check`. Never run
anything on port 3001.
